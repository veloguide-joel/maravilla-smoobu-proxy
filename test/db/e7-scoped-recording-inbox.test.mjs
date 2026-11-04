// Stage E7 — 0015 SCOPED recording conflict-inbox (contract: claude/e7-scoped-recording-inbox-contract.md revision 2, accepted at 99a78fcf).
// DISPOSABLE local PostgreSQL clusters only; repository code runs as the runtime login (test_app ∈ mv_booking_app), report reads as test_report,
// owner decisions as test_admin; the schema owner (postgres) only for snapshots, probes and explicitly labelled TEST SETUP.
// Every provider observation is SYNTHETIC (DOC-DERIVED / LIVE-UNVERIFIED); no provider, notification or network call exists here. Scope is a selection
// boundary, NOT tenant authentication (labels / `by` are TRUST). The protected ids 70636076 / 71045356 / 71072615 / 71081885 appear only as fixture
// references and get ZERO action through the scoped API. The legacy GLOBAL processor (D5 residual) is called ONLY in the isolated clusters `iso`
// (concurrency) and `p14` / `p15` (parity), which hold no protected-reference item.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { startMigratedDatabase, startPostgres } from "./harness.mjs";
import * as F from "./fixtures.mjs";
import { applyEvent, loadIntent, createIntentRecord, collectGuestDetails, beginPayStep, recordCheckoutSession, recordHostawayCreateResult } from "../../lib/booking-db/repo.js";
import { claimNextOperation, completeOperation, requestRead, recordProviderEvidence, completeRecordingWithEvidence } from "../../lib/booking-db/operations.js";
import { adminResolveRecordingHold } from "../../db/lib/admin.js";
import { migrateDown, migrateUp } from "../../db/lib/migrate.js";
import { runOrchestratorStep, PROTECTED_HOSTAWAY_RESERVATION_IDS } from "../../lib/booking-db/reservation-worker.js";
import { runCaptureStep } from "../../lib/booking-db/capture-worker.js";
import { runRecordingStep } from "../../lib/booking-db/recording-worker.js";
import { runCleanupStep } from "../../lib/booking-db/compensation-worker.js";
import { priceStay } from "../../lib/checkout/server-pricer.js";
import { readDirectPolicyFromEnv } from "../../lib/direct-policy.js";
import { todayInTimeZone } from "../../lib/public-api.js";
import { validateAdapterConfig } from "../../lib/hostaway-reservations.js";
import { processScopedRecordingInbox, listScopedRecordingInbox, scopedRecordingInboxSummary } from "../../lib/booking-db/recording-inbox.js";

let db;
before(async () => { db = await startMigratedDatabase(); });
after(async () => { await db.close(); });

// ---------------------------------------------------------------------------------------------
// accepted-worker chain helpers: copied test-locally from test/db/e7-offline-lifecycle.test.mjs (lines 42–221; listing base 872000)
const SEC = 1000; const MIN = 60 * SEC; const DAY = 24 * 60 * MIN;
const ENV_R = Object.freeze({ VERCEL_ENV: "development", MV_E7_RESERVATION_WORKER: "enabled" });
const ENV_C = Object.freeze({ VERCEL_ENV: "development", MV_E7_CAPTURE_WORKER: "enabled" });
const ENV_W = Object.freeze({ VERCEL_ENV: "development", MV_E7_RECORDING_WORKER: "enabled" });
const ENV_K = Object.freeze({ VERCEL_ENV: "development", MV_E7_COMPENSATION_WORKER: "enabled" });
const POLICY = readDirectPolicyFromEnv(ENV_R).policy;
const ACCT = "acct_1LifecycleRehearsal";                         // FIXTURE Stripe account id (mock world)
const LABEL = Object.freeze({ accountRef: "acct-test-1", clientSnapshotId: "client-LC" });   // TRUST labels, not authentication
const REF_FIELD = 777009;
const TZ = "America/Mazatlan";
const PROTECTED = [...PROTECTED_HOSTAWAY_RESERVATION_IDS];
const WRITE_KEYS = ["createReservation", "capturePaymentIntent", "createOfflineCharge", "cancelPaymentIntent", "cancelReservation"];
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const httpError = (statusCode) => Object.assign(new Error(`provider ${statusCode} (mock)`), { statusCode });

// ---------------------------------------------------------------------------------------------
// ONE coherent synthetic provider world per booking: Hostaway (pricing, reservations, offline charges) + Stripe (one PaymentIntent).
// Deterministic ids: each world owns a disjoint block (no random buckets).
let block = 5100000;
function world({ nightly = 250 } = {}) {
  block += 1000;
  const w = { nightly, calls: [], paths: [], writes: Object.fromEntries(WRITE_KEYS.map((k) => [k, 0])), res: new Map(), pis: new Map(), charges: [],
    nextRes: block, nextCharge: block * 10, mode: { create: "ok", capture: "ok", record: "ok", void: "ok" } };
  const days = (from, to) => { const out = []; for (let d = from; d <= to; d = addDays(d, 1)) out.push({ date: d, status: "available", isAvailable: 1, minimumStay: 1, maximumStay: 90, closedOnArrival: 0, closedOnDeparture: 0 }); return out; };
  const full = (r) => ({ id: r.id, listingMapId: r.listingMapId, channelId: 2000, arrivalDate: r.arrivalDate, departureDate: r.departureDate, totalPrice: r.totalPrice,
    currency: r.currency, status: r.status, customFieldValues: [{ customFieldId: REF_FIELD, value: r.ref }] });
  const ridOf = (path) => Number(/\/reservations\/(\d+)/.exec(path)[1]);
  w.piObj = (p) => {
    const cap = p.status === "succeeded";
    return { object: "payment_intent", id: p.id, livemode: false, status: p.status, capture_method: "manual", amount: p.amount,
      amount_received: cap ? p.received : 0, amount_capturable: p.status === "requires_capture" ? p.amount : 0, currency: "usd",
      metadata: { mv_intent_id: p.intentId, mv_payment_attempt_id: p.attemptId },
      latest_charge: { object: "charge", id: p.chargeId, payment_intent: p.id, status: "succeeded", paid: true, captured: cap, amount: p.amount,
        amount_captured: cap ? p.received : 0, amount_refunded: 0, currency: "usd", livemode: false, payment_method_details: { card: { capture_before: p.captureBeforeSec } } } };
  };
  const doCapture = (p, amount) => { p.status = "succeeded"; p.received = amount; };
  w.pricing = {
    get: async (path, opts = {}) => {
      w.calls.push(`pricing GET ${path}`);
      const m = /^\/listings\/(\d+)(\/calendar)?$/.exec(path); const id = Number(m[1]);
      if (!m[2]) return { status: 200, json: { result: { id, currencyCode: "USD", personCapacity: 4, minNights: 1, maxNights: 90 } } };
      return { status: 200, json: { result: days(opts.query.startDate, opts.query.endDate) } };
    },
    post: async (path, body) => {
      w.calls.push(`pricing POST ${path}`);
      const nights = Math.round((Date.parse(body.endingDate) - Date.parse(body.startingDate)) / DAY);
      const comps = [{ id: 1, type: "accommodation", name: "baseRate", title: "Base rate", quantity: 1, value: w.nightly, total: w.nightly * nights, isIncludedInTotalPrice: 1,
        isMandatory: 1, isOverriddenByUser: 0, isDeleted: 0, units: nights }];
      return { status: 200, json: { status: "success", result: { totalPrice: comps[0].total, components: comps } } };
    }
  };
  const hostaway = {
    lookupPage: async (req) => {
      w.calls.push("lookupPage"); w.paths.push(`lookup ${req.query.listingId}`);
      if (req.query.afterId) return { httpStatus: 200, json: { status: "success", result: [] } };
      const items = [...w.res.values()].filter((r) => r.listingMapId === req.query.listingId && r.arrivalDate === req.query.arrivalStartDate).map(full);
      return { httpStatus: 200, json: { status: "success", result: items } };
    },
    retrieveReservation: async (req) => {
      w.calls.push("retrieveReservation"); w.paths.push(req.path);
      const r = w.res.get(ridOf(req.path));
      return r ? { httpStatus: 200, json: { status: "success", result: full(r) } } : { httpStatus: 404, json: { status: "fail" } };
    },
    createReservation: async (req) => {
      w.calls.push("createReservation"); w.writes.createReservation += 1; w.paths.push(`create ${req.body.listingMapId}`);
      assert.deepEqual(req.query, {}, "never forceOverbooking");
      const r = { id: w.nextRes++, listingMapId: req.body.listingMapId, arrivalDate: req.body.arrivalDate, departureDate: req.body.departureDate,
        totalPrice: req.body.totalPrice, currency: req.body.currency, status: "new", ref: req.body.customFieldValues[0].value };
      w.res.set(r.id, r);
      return { httpStatus: 201, json: { status: "success", result: full(r) } };
    },
    cancelReservation: async (req) => {
      w.calls.push("cancelReservation"); w.writes.cancelReservation += 1; w.paths.push(req.path);
      const r = w.res.get(ridOf(req.path)); r.status = "cancelled";
      return { httpStatus: 200, json: { status: "success", result: full(r) } };
    },
    listOfflineCharges: async (req) => {
      w.calls.push("listOfflineCharges"); w.paths.push(`${req.path}?${req.query.reservationId}`);
      const rows = w.charges.filter((c) => String(c.reservationId) === String(req.query.reservationId)).map((c) => ({ ...c }));
      return { httpStatus: 200, json: { status: "success", result: rows, count: rows.length, offset: null } };
    },
    createOfflineCharge: async (req) => {
      w.calls.push("createOfflineCharge"); w.writes.createOfflineCharge += 1; w.paths.push(req.path);
      const rid = Number(/^\/v1\/guestPayments\/charges\/(\d+)$/.exec(req.path)[1]);
      const ch = { id: w.nextCharge++, listingMapId: w.res.get(rid).listingMapId, reservationId: rid, type: "charge", title: req.body.title, currency: "USD",
        paymentMethod: req.body.paymentMethod, amount: req.body.amount, status: "paid", paymentProvider: "offline" };
      w.charges.push(ch);                                                     // the mock APPLIES the write in every mode below
      if (w.mode.record === "appliedThen503") return { httpStatus: 503, json: { status: "fail", result: "upstream unavailable (mock)" } };
      return { httpStatus: 201, json: { status: "success", result: { ...ch } } };
    }
  };
  const stripe = {
    retrieveAccount: async () => { w.calls.push("retrieveAccount"); return { object: "account", id: ACCT }; },
    retrievePaymentIntent: async (id, params) => { w.calls.push("retrievePaymentIntent"); assert.deepEqual(params, { expand: ["latest_charge"] }); return w.piObj(w.pis.get(id)); },
    capturePaymentIntent: async (id, params) => {
      w.calls.push("capturePaymentIntent"); w.writes.capturePaymentIntent += 1;
      const p = w.pis.get(id);
      switch (w.mode.capture) {
        case "ok": doCapture(p, params.amount_to_capture); return w.piObj(p);
        case "500Captured": doCapture(p, params.amount_to_capture); throw httpError(500);    // APPLIED, reply lost / failed
        case "replyOnly": return { ...w.piObj(p), status: "succeeded" };                      // positive-looking reply, NOTHING applied
        default: throw new Error(w.mode.capture);
      }
    },
    cancelPaymentIntent: async (id) => { w.calls.push("cancelPaymentIntent"); w.writes.cancelPaymentIntent += 1; const p = w.pis.get(id); p.status = "canceled"; return w.piObj(p); }
  };
  w.exec = {
    R: { pricing: w.pricing, lookupPage: hostaway.lookupPage, retrieveReservation: hostaway.retrieveReservation, createReservation: hostaway.createReservation },
    C: { retrieveAccount: stripe.retrieveAccount, retrievePaymentIntent: stripe.retrievePaymentIntent, capturePaymentIntent: stripe.capturePaymentIntent,
      retrieveReservation: hostaway.retrieveReservation, lookupPage: hostaway.lookupPage },
    W: { label: LABEL, retrieveReservation: hostaway.retrieveReservation, listOfflineCharges: hostaway.listOfflineCharges, createOfflineCharge: hostaway.createOfflineCharge },
    K: { retrieveAccount: stripe.retrieveAccount, retrievePaymentIntent: stripe.retrievePaymentIntent, cancelPaymentIntent: stripe.cancelPaymentIntent,
      retrieveReservation: hostaway.retrieveReservation, lookupPage: hostaway.lookupPage, cancelReservation: hostaway.cancelReservation }
  };
  w.count = (k) => w.calls.filter((c) => c === k).length;
  return w;
}

// ---------------------------------------------------------------------------------------------
// fresh payment_authorized USD booking (reviewed repo functions, the E7.2 suite's own path); the mock Stripe world holds the PaymentIntent
let laneN = 0;
async function authorizedBooking(w) {
  laneN += 1;
  const listingId = 872000 + laneN;
  const stay = { from: addDays("2026-12-01", 7 * laneN), to: addDays("2026-12-01", 7 * laneN + 4), guests: 2 };
  const base = Date.now() - 20 * MIN;                                      // injected-clock origin (see header)
  const priced = await priceStay({ request: { listingId, ...stay }, listingConfig: { currency: "USD" }, client: w.pricing, policy: POLICY,
    today: todayInTimeZone(undefined, new Date(base)), now: base });
  assert.ok(priced.ok, priced.error);
  w.calls.length = 0;                                                       // setup pricing is not a worker call
  const intent = await createIntentRecord(db.app, { ref: F.nextRef(), accessTokenHash: F.tokenHash(), environment: "test", now: base, listingId, ...stay });
  F.ok(await applyEvent(db.app, intent.id, { type: "PRICE_CONFIRMED", price: priced.price }, { now: base, actor: "guest" }));
  F.ok(await collectGuestDetails(db.app, intent.id, F.GUEST, { now: base + SEC, termsVersion: "terms-2026-10" }));
  const b = F.ok(await beginPayStep(db.app, intent.id, { now: base + 2 * SEC }));
  const op = await claimNextOperation(db.app, { workerId: "w-pay", now: base + 2 * SEC, intentId: intent.id, opTypes: ["stripe.create_checkout_session"] });
  const sessionId = `cs_test_lc${laneN}`;
  F.ok(await completeOperation(db.app, op.id, { workerId: "w-pay", now: base + 2 * SEC, outcome: { status: "succeeded", resultRef: sessionId } }));
  F.ok(await recordCheckoutSession(db.app, intent.id, b.attempt.id, { sessionId, expiresAt: base + 30 * MIN, now: base + 2 * SEC }));
  const piId = `pi_test_lc${laneN}`;
  const captureBefore = Math.floor((base + 7 * DAY) / 1000) * 1000;
  F.ok(await applyEvent(db.app, intent.id, { type: "PAYMENT_AUTHORIZED", id: `evt_auth_${piId}`, paymentIntentId: piId, sessionId, amountMinor: priced.price.finalTotalMinor,
    currency: "usd", livemode: false, authorizationCreatedAt: base + 3 * SEC, captureBefore }, { now: base + 4 * SEC, actor: "webhook" }));
  const pa = (await db.app.query("SELECT id FROM booking.payment_attempts WHERE intent_id = $1 AND status = 'completed'", [intent.id])).rows[0].id;
  // the mock Stripe world authorized exactly this PaymentIntent (what the mock "did")
  w.pis.set(piId, { id: piId, intentId: intent.id, attemptId: pa, status: "requires_capture", amount: priced.price.finalTotalMinor, received: 0,
    chargeId: `ch_test_lc${laneN}`, captureBeforeSec: captureBefore / 1000 });
  return { id: intent.id, ref: intent.ref, listingId, stay, piId, price: priced.price, total: priced.price.finalTotalMinor, paymentAttemptId: pa, base };
}

/** The four workers for one booking, each scoped to it, with the world's exact executor keys. */
function lane(w, bk, { method = "credit_card" } = {}) {
  const clk = { t: bk.base + 10 * SEC };
  const adapterConfig = validateAdapterConfig({ allowedListingIds: [bk.listingId], refFieldId: REF_FIELD, channelId: 2000, currency: "USD" });
  const recCfg = { accountRef: LABEL.accountRef, channelId: 2000, currency: "USD", listingId: bk.listingId, paymentMethod: method, refFieldId: REF_FIELD };
  const log = [];
  const rec = (worker, r) => { log.push({ worker, status: r.status, actions: r.actions.filter((a) => !a.startsWith("RECOVERY:REISSUE")) }); return r; };
  const L = {
    clk, log, method, recCfg,
    R: async (o = {}) => rec("reservation", await runOrchestratorStep(db.app, { workerId: "lc-res", env: ENV_R, adapterConfig, listings: new Map([[bk.listingId, { currency: "USD" }]]),
      executors: w.exec.R, clock: () => clk.t, intentId: bk.id, ...o })),
    C: async (o = {}) => rec("capture", await runCaptureStep(db.app, { workerId: "lc-cap", env: ENV_C, adapterConfig, listings: new Map([[bk.listingId, { currency: "USD" }]]),
      executors: w.exec.C, clock: () => clk.t, stripeAccountId: ACCT, intentId: bk.id, ...o })),
    W: async (o = {}) => rec("recording", await runRecordingStep(db.app, { workerId: "lc-rec", env: ENV_W, listings: new Map([[bk.listingId, recCfg]]),
      executors: w.exec.W, clock: Date.now, intentId: bk.id, ...o })),
    K: async (o = {}) => rec("compensation", await runCleanupStep(db.app, { workerId: "lc-cln", env: ENV_K, adapterConfig,
      listings: new Map([[bk.listingId, { currency: "USD", timeZone: TZ }]]), executors: w.exec.K, clock: () => clk.t, stripeAccountId: ACCT, intentId: bk.id, ...o })),
    /** bounded: step `k` (advancing the injected clock by `adv` after each) until the state satisfies `pred`; never past real time */
    until: async (k, pred, { max = 8, adv = MIN } = {}) => {
      for (let n = 0; n < max; n++) {
        if (pred(await state(bk.id))) return n;
        await L[k]();
        clk.t = Math.min(clk.t + adv, Date.now() - 5 * SEC);
      }
      assert.fail(`${k}: not reached after ${max} steps (${await state(bk.id)})`);
    }
  };
  return L;
}

// ---------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------
// inbox helpers (every evidence row enters through an ORDINARY accepted path: API read -> evidence, or admin dashboard evidence)
const state = async (id) => (await loadIntent(db.app, id)).status;
const INBOX_ENV = Object.freeze({ VERCEL_ENV: "development", MV_E7_RECORDING_INBOX: "enabled" });
const PROT = [...PROTECTED_HOSTAWAY_RESERVATION_IDS];
const OCH = ["hostaway.record_offline_charge"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let dayN = 0;
/** a stay on a CHOSEN listing (several intents may share a listing) */
const stayOn = (listingId) => { dayN += 1; const d = new Date(Date.UTC(2031, 0, 1) + dayN * 6 * DAY).toISOString().slice(0, 10);
  const e = new Date(Date.UTC(2031, 0, 1) + (dayN * 6 + 3) * DAY).toISOString().slice(0, 10); return { listingId, from: d, to: e }; };
let idN = 994000;
const cid = () => String(++idN);
const cnt = (ids) => ({ matchingChargeCount: ids.length, matchingChargeIds: ids.map(String) });
const ver = async (d, id) => (await d.owner.query("SELECT version FROM booking.intents WHERE id = $1", [id])).rows[0].version;
const factsOf = async (d, id) => (await d.owner.query("SELECT state, version, listing_id, hostaway_reservation_id, offline_charge_id FROM booking.intents WHERE id = $1", [id])).rows[0];
async function capturedOn(d, listingId, extra = {}) { const c = await F.captured(d.app, { ...stayOn(listingId), ...extra }); return { ...c, listingId }; }
async function claimedOn(d, listingId) {
  const c = await capturedOn(d, listingId); const t = Date.now();
  await d.app.query("UPDATE booking.intent_work SET work_worker_id = 'w1', work_lease_until = $2 WHERE intent_id = $1", [c.id, new Date(t + 10 * MIN)]);
  const op = await F.claimHealthyRecording(d.app, { workerId: "w1", now: t, intentId: c.id, opTypes: OCH, leaseMs: 10 * MIN });
  assert.ok(op, "attempt 1 claimable");
  return { c, op, t };
}
async function linkedOn(d, listingId) {
  const { c, op, t } = await claimedOn(d, listingId); const id = cid();
  const proof = await F.chargeListEvidence(d.app, c, F.recordingObserved(c, id), t + 5);
  F.ok(await completeRecordingWithEvidence(d.app, op.id, { workerId: "w1", evidenceId: proof, resultRef: id, expectedVersion: await ver(d, c.id) }));
  return { c, op, t, proof, id };
}
/** ORDINARY API path: requestRead (any selector — the read selector is not bound to the intent's reservation) -> claim -> complete -> evidence */
async function apiRef(d, intentId, ref, observed, t = Date.now()) {
  const rid = await requestRead(d.app, intentId, "hostaway.list_offline_charges", String(ref), { now: t });
  assert.ok(await claimNextOperation(d.app, { workerId: "w-read", now: t, opId: rid }));
  F.ok(await completeOperation(d.app, rid, { workerId: "w-read", now: t, outcome: { status: "succeeded" } }));
  return F.ok(await recordProviderEvidence(d.app, { readOpId: rid, kind: "hostaway_offline_charges", externalRef: String(ref), status: "listed", observed })).id;
}
/** ORDINARY dashboard path (admin role) */
const dash = async (d, intentId, ref, observed, at) => (await d.reconciler.query(
  "SELECT booking.admin_record_evidence($1,'hostaway_offline_charges',$2,'listed',$3,$4::timestamptz,'owner','dash-ref') AS id", [intentId, String(ref), observed, at])).rows[0].id;
const scoped = async (d, ids, intentId = null, pool = d.app) => (await pool.query(
  "SELECT booking.process_recording_conflict_inbox_scoped_one('t-scoped', $1::int[], $2::uuid) AS r", [ids, intentId])).rows[0].r;
const legacy = async (d) => (await d.app.query("SELECT booking.process_recording_conflict_inbox_one('t-legacy') AS r")).rows[0].r;
const proc = (d, o) => processScopedRecordingInbox(d.app, { env: INBOX_ENV, by: "t-scoped", ...o });
async function drainScoped(d, listingIds, intentId = null) {
  const all = { processed: [], errors: [], skipped: [] };
  for (let k = 0; k < 40; k++) {
    const o = await proc(d, { listingIds, intentId, maxItems: 25 });
    all.processed.push(...o.processed); all.errors.push(...o.errors); all.skipped.push(...o.skipped);
    if (o.drained || o.stoppedOnRepeatedError || o.skipped.length) return all;
  }
  assert.fail("drainScoped: not drained within bound");
}
const inbox = async (d, ev) => (await d.owner.query("SELECT * FROM booking.recording_conflict_inbox WHERE evidence_id = $1", [ev])).rows[0];
const holdsOf = async (d, intentId) => (await d.owner.query("SELECT * FROM booking.recording_holds WHERE intent_id = $1 ORDER BY created_at, id", [intentId])).rows;
const obsOf = async (d, holdId) => (await d.owner.query("SELECT evidence_id FROM booking.recording_hold_observations WHERE hold_id = $1 ORDER BY recorded_at, id", [holdId])).rows.map((x) => x.evidence_id);
/** byte-level audit snapshot of intents: their rows, ops, evidence, inbox, holds, observations, decisions, cases */
async function audit(d, intentIds) {
  const q = async (sql) => JSON.stringify((await d.owner.query(sql, [intentIds])).rows);
  return [await q("SELECT * FROM booking.intents WHERE id = ANY($1) ORDER BY id"),
    await q("SELECT * FROM booking.external_operations WHERE intent_id = ANY($1) ORDER BY id"),
    await q("SELECT * FROM booking.provider_evidence WHERE intent_id = ANY($1) ORDER BY id"),
    await q("SELECT * FROM booking.recording_conflict_inbox WHERE intent_id = ANY($1) ORDER BY seq"),
    await q("SELECT * FROM booking.recording_holds WHERE intent_id = ANY($1) ORDER BY id"),
    await q("SELECT o.* FROM booking.recording_hold_observations o JOIN booking.recording_holds h ON h.id = o.hold_id WHERE h.intent_id = ANY($1) ORDER BY o.id"),
    await q("SELECT dd.* FROM booking.recording_hold_decisions dd JOIN booking.recording_holds h ON h.id = dd.hold_id WHERE h.intent_id = ANY($1) ORDER BY dd.id"),
    await q("SELECT * FROM booking.reconciliation_cases WHERE intent_id = ANY($1) ORDER BY id")].join("\n");
}
async function waitForLockWaiters(d, n = 1, timeoutMs = 5000) {
  const t0 = Date.now();
  for (;;) {
    const r = await d.owner.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`);
    if (r.rows[0].n >= n) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`no lock waiter observed within ${timeoutMs} ms`);
    await sleep(10);
  }
}
const asApp = async (d) => { const c = new pg.Client({ connectionString: d.appUrl() }); await c.connect(); return c; };
/** PROBE SETUP ONLY (as in e74b-d1-owner-cases T-C7): an impossible active hold on a LINKED recording, written with triggers bypassed, to make an item error */
async function probeHold(d, intentId, opId, reason) {
  const caseId = (await d.owner.query("SELECT gen_random_uuid() AS id")).rows[0].id;
  const holdId = (await d.owner.query("SELECT gen_random_uuid() AS id")).rows[0].id;
  const o = (await d.owner.query("SELECT * FROM booking.external_operations WHERE id = $1", [opId])).rows[0]; const f = await factsOf(d, intentId);
  await F.ownerManagedHistory(d.owner, `WITH k AS (INSERT INTO booking.reconciliation_cases (id, intent_id, kind, status, opened_at, opened_by, evidence)
      VALUES ($1::uuid, $3::uuid, 'OFFLINE_CHARGE_HOLD_' || $5::text, 'open', now(), 'recording-hold:' || $1::uuid::text, '{}'::jsonb) RETURNING id)
    INSERT INTO booking.recording_holds (id, operation_id, intent_id, reason, case_id, op_state_at_hold, op_key_at_hold, intent_state_at_hold,
      intent_version_at_hold, created_at, created_by) SELECT $2::uuid, $4::uuid, $3::uuid, $5::text, k.id, $6::text, $7::text, $8::text, $9::integer, now(), 'probe' FROM k`,
    [caseId, holdId, intentId, opId, reason, o.state, o.idempotency_key, f.state, f.version]);
  return { caseId, holdId };
}
const removeProbeHold = (d, h) => F.ownerManagedHistory(d.owner,
  "WITH x AS (DELETE FROM booking.recording_holds WHERE id = $1 RETURNING case_id) DELETE FROM booking.reconciliation_cases WHERE id IN (SELECT case_id FROM x)", [h.holdId]);
const EXACT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const PAGE_KEYS = ["seq", "evidence_id", "intent_id", "listing_id", "intent_state", "enqueued_at_exact", "db_now_exact", "attempts", "last_attempt_at_exact",
  "last_error_code", "processed_at_exact", "outcome", "hold_id", "hold_reason", "hold_active", "case_id", "case_status", "latest_op_id", "latest_op_state",
  "latest_op_linked", "evidence_source", "evidence_observed_at_exact", "evidence_read_operation_id"];
const page = (d, o) => listScopedRecordingInbox(d.app, { env: INBOX_ENV, status: "all", ...o });
const summary = (d, o) => scopedRecordingInboxSummary(d.app, { env: INBOX_ENV, ...o });

// =============================================================================================
test("T-R1a/b/c/e: a protected reference on EITHER half is excluded before selection / LIMIT / locks (ordinary API evidence on a NULL-reservation intent, dashboard evidence on another binding, an intent bound to a protected id); byte-identical audit; allowed controls served on the FIRST call", { timeout: 240000 }, async () => {
  const L = 873001;
  const a = await F.authorized(db.app, stayOn(L));                                             // (a) payment_authorized: reservation NULL
  assert.equal((await factsOf(db, a.id)).hostaway_reservation_id, null);
  const evA = await apiRef(db, a.id, PROT[0], cnt([]));
  const b = await capturedOn(db, L);                                                             // (b) non-protected reservation, protected dashboard ref
  const evB = await dash(db, b.id, PROT[1], cnt(["1"]), new Date());
  const p = await capturedOn(db, L, { reservationId: Number(PROT[2]) });                         // (c) bound to a protected id (ordinary repo path)
  assert.equal((await factsOf(db, p.id)).hostaway_reservation_id, PROT[2]);
  const evC = await apiRef(db, p.id, PROT[2], cnt([]));
  const protectedEvs = [evA, evB, evC];
  const before = await audit(db, [a.id, b.id, p.id]);
  // allowed controls in the SAME listing, enqueued AFTER (higher seq) the protected items
  const ctl = await linkedOn(db, L);
  const other = await capturedOn(db, L);
  const evO = await apiRef(db, other.id, "555000111", cnt([]));
  const first = await proc(db, { listingIds: [L], maxItems: 1 });
  assert.equal(first.processed.length, 1, JSON.stringify(first));
  assert.ok(!protectedEvs.includes(first.processed[0].evidenceId), "e: protected lowest-seq items never occupy the scoped call");
  const rest = await drainScoped(db, [L]);
  const done = [first.processed[0], ...rest.processed].map((x) => x.evidenceId);
  assert.ok(done.includes(evO) && done.includes(ctl.proof), "controls served");
  assert.ok(protectedEvs.every((e) => !done.includes(e)));
  assert.deepEqual([rest.errors, rest.skipped], [[], []]);
  for (const e of protectedEvs) assert.deepEqual([(await inbox(db, e)).processed_at, (await inbox(db, e)).attempts], [null, 0]);
  assert.equal(await audit(db, [a.id, b.id, p.id]), before, "protected-reference items / intents: byte-identical audit");
  // narrowing to a protected item's intent: nothing (no fallback to the global function)
  assert.equal(await scoped(db, [L], a.id), null);
  assert.equal(await scoped(db, [L], p.id), null);
  // the read-only page and summary apply the SAME predicate
  const pg1 = await page(db, { listingIds: [L], limit: 200 });
  assert.ok(pg1.rows.length > 0 && pg1.rows.every((r) => !protectedEvs.includes(r.evidence_id)));
  assert.equal((await summary(db, { listingIds: [L] })).summary.pendingItems, 0, "protected pending items are not counted");
  assert.equal((await summary(db, { listingIds: [L], intentId: b.id })).summary.pendingItems, 0);
  assert.equal(await audit(db, [a.id, b.id, p.id]), before);
});

test("T-R1d: the LEGAL NULL -> protected reservation binding between selection and lock (applyEvent inTx barrier, OBSERVED lock wait) -> STALE skip with zero mutation, then excluded; NULL -> non-protected control is processed on current facts", { timeout: 240000 }, async () => {
  for (const [rid, expectStale] of [[PROT[3], true], ["8800001", false]]) {
    const L = expectStale ? 873101 : 873102;
    const st = stayOn(L);
    const dsp = await F.dispatched(db.app, st);                                                  // reservation_pending, reservation NULL
    const ev = await apiRef(db, dsp.id, "8800099", cnt([]));                                      // a NON-protected evidence ref on that intent
    const op = await F.claimOp(db.app, dsp.id, "hostaway.create_reservation", F.at(6));
    await recordHostawayCreateResult(db.app, dsp.id, { httpStatus: 201, reservation: F.reservationFor(st, Number(rid)) }, { now: F.at(7) });
    F.ok(await completeOperation(db.app, op.id, { workerId: "w1", now: F.at(7), outcome: { status: "succeeded", resultRef: rid } }));
    const before = await audit(db, [dsp.id]);
    let release; const gate = new Promise((r) => { release = r; }); let entered; const inside = new Promise((r) => { entered = r; });
    const ev3 = applyEvent(db.app, dsp.id, { type: "RESERVATION_SUCCEEDED", reservation: F.reservationFor(st, Number(rid)) },
      { now: F.at(7), actor: "worker", inTx: async () => { entered(); await gate; } });                // intent row UPDATED, not yet committed
    await inside;
    const call = scoped(db, [L], dsp.id);                                                          // selection reads the committed NULL binding
    await waitForLockWaiters(db, 1);                                                                // ... and then WAITS on intent FOR SHARE
    release();
    F.ok(await ev3);
    const r = await call;
    assert.equal((await factsOf(db, dsp.id)).hostaway_reservation_id, rid);
    if (expectStale) {
      assert.deepEqual(r, { evidenceId: ev, intentId: dsp.id, skipped: "STALE_OUT_OF_SCOPE" });
      const after = await audit(db, [dsp.id]);
      const strip = (s) => s.split("\n").filter((_, k) => k !== 0 && k !== 1).join("\n");          // intent + ops legitimately changed by the event itself
      assert.equal(strip(after), strip(before), "zero mutation of evidence / inbox / holds / observations / decisions / cases");
      assert.deepEqual([(await inbox(db, ev)).processed_at, (await inbox(db, ev)).attempts], [null, 0]);
      assert.equal(await scoped(db, [L], dsp.id), null, "now excluded at selection");
      const o = await proc(db, { listingIds: [L] });
      assert.deepEqual([o.status, o.processed.length, o.skipped.length], ["idle", 0, 0]);
    } else {
      assert.deepEqual([r.evidenceId, r.outcome, r.holdId], [ev, "not_latest_linked", null], "non-protected binding: processed on current facts");
    }
  }
});

test("T-S2 + T-S1: an accepted-worker chain booking reaches confirmed; its two happy items are consistent; a LATE contradiction (API + historical dashboard) gives exactly ONE LINKED_CONTRADICTED hold + ONE open case + one observation each — intent / recording state and version unchanged", { timeout: 240000 }, async () => {
  const w = world(); const bk = await authorizedBooking(w); const Ln = lane(w, bk);
  await Ln.R(); await Ln.R(); await Ln.C(); await Ln.W();
  assert.equal(await state(bk.id), "confirmed");
  const items = (await db.owner.query("SELECT evidence_id FROM booking.recording_conflict_inbox WHERE intent_id = $1 ORDER BY seq", [bk.id])).rows.map((x) => x.evidence_id);
  assert.equal(items.length, 2);
  const happy = await proc(db, { listingIds: [bk.listingId] });
  assert.deepEqual(happy.processed.map((x) => [x.evidenceId, x.outcome, x.holdId]), items.map((e) => [e, "consistent", null]));
  assert.equal(happy.drained, true);
  const f0 = await factsOf(db, bk.id);
  const och = (await db.owner.query("SELECT * FROM booking.external_operations WHERE intent_id = $1 AND op_type = $2", [bk.id, OCH[0]])).rows[0];
  const writeOps = async () => JSON.stringify((await db.owner.query("SELECT * FROM booking.external_operations WHERE intent_id = $1 AND retry_class <> 'read' ORDER BY id", [bk.id])).rows);
  const opsBefore = await writeOps();
  const c = { id: bk.id, reservationId: f0.hostaway_reservation_id, listingId: bk.listingId };
  const x1 = await F.chargeListEvidence(db.app, c, cnt(["999999001"]));                             // a different charge id: contradiction
  const x2 = await dash(db, bk.id, f0.hostaway_reservation_id, cnt(["999999002"]), new Date(new Date(och.dispatched_at).getTime() + 1000));   // historical
  const r1 = await scoped(db, [bk.listingId]);
  const r2 = await scoped(db, [bk.listingId]);
  assert.deepEqual([r1.evidenceId, r1.outcome], [x1, "contradiction_opened"]);
  assert.deepEqual([r2.evidenceId, r2.outcome, r2.holdId], [x2, "contradiction_appended", r1.holdId]);
  assert.equal(await scoped(db, [bk.listingId]), null);
  const hs = await holdsOf(db, bk.id);
  assert.deepEqual(hs.map((h) => [h.reason, h.released_at, h.created_by]), [["LINKED_CONTRADICTED", null, "t-scoped"]]);
  assert.deepEqual(await obsOf(db, hs[0].id), [x1, x2]);
  const cs = (await db.owner.query("SELECT kind, status FROM booking.reconciliation_cases WHERE intent_id = $1 AND kind LIKE 'OFFLINE\\_CHARGE\\_HOLD\\_%'", [bk.id])).rows;
  assert.deepEqual(cs, [{ kind: "OFFLINE_CHARGE_HOLD_LINKED_CONTRADICTED", status: "open" }]);
  const f1 = await factsOf(db, bk.id);
  assert.deepEqual([f1.state, f1.version, f1.offline_charge_id], [f0.state, f0.version, f0.offline_charge_id], "visibility only: no transition, no reversal");
  assert.equal(await writeOps(), opsBefore, "every write / outbox row (recording, capture, create, notify) byte-identical");
  const writes = (await db.owner.query("SELECT op_type, state, dispatched_at FROM booking.external_operations WHERE intent_id = $1 AND retry_class <> 'read' ORDER BY op_type", [bk.id])).rows;
  assert.deepEqual(writes.map((x) => x.op_type), ["guest.notify", "hostaway.create_reservation", "hostaway.record_offline_charge", "stripe.capture_payment_intent", "stripe.create_checkout_session"]);
  assert.equal(writes.find((x) => x.op_type === "guest.notify").dispatched_at, null, "notification still only queued");
  assert.equal(och.state, "succeeded");
  assert.equal((await db.owner.query("SELECT state FROM booking.external_operations WHERE id = $1", [och.id])).rows[0].state, "succeeded");
});

test("T-H1: historical evidence inserted LATE is judged by seq; evidence observed at or before the dispatch never contradicts (consistent)", { timeout: 240000 }, async () => {
  const l = await linkedOn(db, 873301);
  await drainScoped(db, [873301]);
  const disp = new Date((await db.owner.query("SELECT dispatched_at FROM booking.external_operations WHERE id = $1", [l.op.id])).rows[0].dispatched_at).getTime();
  const pre = await dash(db, l.c.id, l.c.reservationId, cnt(["999"]), new Date(disp - 1000));
  const at = await dash(db, l.c.id, l.c.reservationId, cnt(["998"]), new Date(disp));
  const late = await dash(db, l.c.id, l.c.reservationId, cnt(["997"]), new Date(disp + 1));
  const out = await drainScoped(db, [873301]);
  assert.deepEqual(out.processed.map((x) => [x.evidenceId, x.outcome]), [[pre, "consistent"], [at, "consistent"], [late, "contradiction_opened"]]);
});

test("T-S3: 110 out-of-scope pending items never starve the scoped listing; optional intent narrows; an intent outside the listings is empty (not an error); out-of-scope rows untouched", { timeout: 240000 }, async () => {
  const Lout = 873402; const Lin = 873401;
  const n = await capturedOn(db, Lout);
  const noise = [];
  for (let k = 0; k < 110; k++) noise.push(await apiRef(db, n.id, `66${k}`, cnt([])));
  const noiseBefore = await audit(db, [n.id]);
  const X = await capturedOn(db, Lin); const Y = await capturedOn(db, Lin);
  const xs = [await apiRef(db, X.id, "1101", cnt([])), await apiRef(db, X.id, "1102", cnt([]))];
  const ys = [await apiRef(db, Y.id, "1201", cnt([])), await apiRef(db, Y.id, "1202", cnt([]))];
  const nx = await proc(db, { listingIds: [Lin], intentId: X.id });
  assert.deepEqual(nx.processed.map((x) => x.evidenceId), xs, "narrowed to X only");
  for (const e of ys) assert.equal((await inbox(db, e)).processed_at, null);
  const outside = await proc(db, { listingIds: [Lin], intentId: n.id });
  assert.deepEqual([outside.status, outside.calls], ["idle", 1]);
  assert.deepEqual((await page(db, { listingIds: [Lin], intentId: n.id })).rows, []);
  assert.equal((await summary(db, { listingIds: [Lin], intentId: n.id })).summary.pendingItems, 0);
  const all = await proc(db, { listingIds: [Lin] });
  assert.deepEqual(all.processed.map((x) => x.evidenceId), ys);
  assert.equal(await audit(db, [n.id]), noiseBefore, "out-of-scope rows byte-identical");
  assert.equal((await summary(db, { listingIds: [Lout] })).summary.pendingItems, 110);
});

test("T-V1: malformed scope / by / status / cursor fail closed in SQL (22023, or 22003 for an int4 overflow at the cast) with ZERO writes on all three functions; no scoped path reaches the global function", { timeout: 240000 }, async () => {
  const marks = async () => (await db.owner.query("SELECT count(*) FILTER (WHERE processed_at IS NOT NULL) AS p, coalesce(sum(attempts), 0) AS a FROM booking.recording_conflict_inbox")).rows[0];
  const pend = await capturedOn(db, 873501); await apiRef(db, pend.id, "1501", cnt([]));
  const m0 = await marks();
  const bad = [null, "{}", "{{1,2}}", "{1,1}", "{0}", "{-3}", "{1,NULL}", `{${Array.from({ length: 51 }, (_, k) => k + 1).join(",")}}`];
  for (const arr of bad) {
    for (const [sql, extra] of [["SELECT booking.process_recording_conflict_inbox_scoped_one('t', $1::int[], NULL)", []],
      ["SELECT * FROM booking.recording_inbox_page($1::int[], NULL, 'all', NULL, NULL)", []], ["SELECT booking.recording_inbox_summary($1::int[], NULL)", []]]) {
      await assert.rejects(db.app.query(sql, [arr, ...extra]), (e) => e.code === "22023" && /INBOX_SCOPE_INVALID/.test(e.message), `${arr} ${sql.slice(0, 40)}`);
    }
  }
  await assert.rejects(db.app.query("SELECT booking.process_recording_conflict_inbox_scoped_one('t', $1::int[], NULL)", ["{2147483648}"]), (e) => e.code === "22003");
  await assert.rejects(db.app.query("SELECT booking.process_recording_conflict_inbox_scoped_one('', ARRAY[873501], NULL)"), (e) => e.code === "22023" && /INBOX_BY_INVALID/.test(e.message));
  await assert.rejects(db.app.query("SELECT booking.process_recording_conflict_inbox_scoped_one(NULL, ARRAY[873501], NULL)"), /INBOX_BY_INVALID/);
  for (const st of [null, "open", "ALL"]) await assert.rejects(db.app.query("SELECT * FROM booking.recording_inbox_page(ARRAY[873501], NULL, $1, NULL, NULL)", [st]), /INBOX_STATUS_INVALID/);
  for (const cur of ["0", "-1"]) await assert.rejects(db.app.query("SELECT * FROM booking.recording_inbox_page(ARRAY[873501], NULL, 'all', $1::bigint, NULL)", [cur]), /INBOX_CURSOR_INVALID/);
  assert.deepEqual(await marks(), m0, "zero writes");
  for (const f of ["process_recording_conflict_inbox_scoped_one", "recording_inbox_page", "recording_inbox_summary", "recording_inbox_process_locked"]) {
    const def = (await db.owner.query("SELECT pg_get_functiondef(oid) AS d FROM pg_proc WHERE proname = $1 AND pronamespace = 'booking'::regnamespace", [f])).rows[0].d;
    assert.doesNotMatch(def, /process_recording_conflict_inbox_one/, `${f}: never the global function`);
  }
  const { readFileSync } = await import("node:fs");
  assert.doesNotMatch(readFileSync(new URL("../../lib/booking-db/recording-inbox.js", import.meta.url), "utf8"), /process_recording_conflict_inbox_one|drainRecordingConflictInbox/);
});

test("T-C1: overlapping and disjoint scoped processors run concurrently — every item processed exactly once, no duplicate effect", { timeout: 240000 }, async () => {
  const L1 = 873601; const L2 = 873602;
  const evs = [];
  for (const L of [L1, L2]) { const c = await capturedOn(db, L); for (let k = 0; k < 6; k++) evs.push(await apiRef(db, c.id, `${L}${k}`, cnt([]))); }
  const outs = await Promise.all([proc(db, { listingIds: [L1], maxItems: 25 }), proc(db, { listingIds: [L1], maxItems: 25 }), proc(db, { listingIds: [L2], maxItems: 25 }),
    proc(db, { listingIds: [L1, L2], maxItems: 25 })]);
  const done = outs.flatMap((o) => o.processed.map((x) => x.evidenceId));
  assert.equal(new Set(done).size, done.length, "no item reported twice");
  assert.deepEqual([...done].sort(), [...evs].sort());
  for (const e of evs) assert.equal((await inbox(db, e)).outcome, "not_latest_linked");
});

test("T-C2: races with completion / link / finalisation / owner paths — the processor WAITS behind a completion and judges current facts; a pre-link contradiction blocks completion; an active hold blocks finalisation; keep_visible keeps the hold and later evidence appends", { timeout: 240000 }, async () => {
  const L = 873701;
  // (1) completion holds op UPDATE + advisory; the scoped item of the same intent waits, then sees the LINKED recording
  const { c, op, t } = await claimedOn(db, L);
  await drainScoped(db, [L]);
  const x = await F.chargeListEvidence(db.app, c, cnt([]));
  const id = cid(); const proof = await F.chargeListEvidence(db.app, c, F.recordingObserved(c, id), t + 5);
  const k = await asApp(db);
  try {
    await k.query("BEGIN");
    await k.query("SELECT booking.complete_recording_with_evidence($1, 'w1', $2, $3, $4)", [op.id, proof, id, await ver(db, c.id)]);
    const call = scoped(db, [L], c.id);
    await waitForLockWaiters(db, 1);
    await k.query("COMMIT");
    const r = await call;
    assert.deepEqual([r.evidenceId, r.outcome], [x, "consistent"], "judged after the wait on the committed link");
  } finally { await k.end(); }
  // (2) a contradiction committed BEFORE completion: completion refuses; the item is not_latest_linked (0010 judged it synchronously)
  const c2 = await claimedOn(db, L);
  await drainScoped(db, [L], c2.c.id);
  const bad = await F.chargeListEvidence(db.app, c2.c, cnt(["777"]));
  const id2 = cid(); const proof2 = await F.chargeListEvidence(db.app, c2.c, F.recordingObserved(c2.c, id2), c2.t + 5);
  const refusal = await completeRecordingWithEvidence(db.app, c2.op.id, { workerId: "w1", evidenceId: proof2, resultRef: id2, expectedVersion: await ver(db, c2.c.id) });
  assert.equal(refusal.ok, false);
  const r2 = await drainScoped(db, [L], c2.c.id);
  assert.deepEqual(r2.processed.map((p) => [p.evidenceId, p.outcome]), [[bad, "not_latest_linked"], [proof2, "not_latest_linked"]]);
  assert.deepEqual(await holdsOf(db, c2.c.id), []);
  // (3) after a link: contradiction -> hold; the hold blocks finalisation; keep_visible keeps it; later evidence appends
  const l3 = await linkedOn(db, L);
  await drainScoped(db, [L], l3.c.id);
  const y = await F.chargeListEvidence(db.app, l3.c, cnt(["778"]));
  const ry = await scoped(db, [L], l3.c.id);
  assert.equal(ry.outcome, "contradiction_opened");
  const fin = await applyEvent(db.app, l3.c.id, { type: "OFFLINE_CHARGE_RECORDED", chargeId: l3.id }, { now: Date.now(), actor: "worker" }).catch((e) => ({ thrown: String(e.message) }));
  assert.match(JSON.stringify(fin), /RECORDING_HOLD_ACTIVE/);
  assert.equal((await factsOf(db, l3.c.id)).state, "payment_captured");
  F.ok(await adminResolveRecordingHold(db.reconciler, { holdId: ry.holdId, decision: "keep_visible", evidenceIds: [], resolver: "owner", justification: "OWNER_REVIEWING", at: F.at(100) }));
  const z = await F.chargeListEvidence(db.app, l3.c, cnt(["779"]));
  const rz = await scoped(db, [L], l3.c.id);
  assert.deepEqual([rz.evidenceId, rz.outcome, rz.holdId], [z, "contradiction_appended", ry.holdId]);
  assert.equal((await holdsOf(db, l3.c.id))[0].released_at, null);
  assert.deepEqual(await obsOf(db, ry.holdId), [y, z]);
});

test("T-C3 (known limit): several scoped calls wrapped in ONE caller transaction with interleaved intents deadlock; the 40P01 inside the item's subtransaction is a RECORDED item error; autocommit calls (the contract) do not deadlock", { timeout: 240000 }, async () => {
  const LA = 873801; const LB = 873802;
  const A = await linkedOn(db, LA); const B = await linkedOn(db, LB);
  await drainScoped(db, [LA, LB]);
  const A1 = await F.chargeListEvidence(db.app, A.c, cnt([A.id])); const B1 = await F.chargeListEvidence(db.app, B.c, cnt([B.id]));
  const B2 = await F.chargeListEvidence(db.app, B.c, cnt([B.id])); const A2 = await F.chargeListEvidence(db.app, A.c, cnt([A.id]));
  const k1 = await asApp(db); const k2 = await asApp(db);
  const call = (k) => scoped(db, [LA, LB], null, k);
  let results;
  try {
    await k1.query("BEGIN"); await k2.query("BEGIN");
    assert.equal((await call(k1)).evidenceId, A1);
    assert.equal((await call(k2)).evidenceId, B1);
    const p1 = call(k1);
    await waitForLockWaiters(db, 1);
    const p2 = call(k2);
    const first = await Promise.race([p1.then((r) => ({ k: 1, r })), p2.then((r) => ({ k: 2, r }))]);
    assert.deepEqual(Object.keys(first.r).sort(), ["attempts", "error", "evidenceId", "intentId"]);
    assert.deepEqual([first.r.error, first.r.attempts], ["40P01", 1]);
    await (first.k === 1 ? k1 : k2).query("COMMIT");
    const other = await (first.k === 1 ? p2 : p1);
    await (first.k === 1 ? k2 : k1).query("COMMIT");
    results = [first.r, other];
  } finally { await k1.end(); await k2.end(); }
  const v = await inbox(db, results[0].evidenceId);
  assert.deepEqual([v.processed_at, v.attempts], [null, 1]);
  assert.match(v.last_error, /^40P01/);
  assert.equal(results[1].outcome, "consistent");
  const out = await Promise.all([drainScoped(db, [LA, LB]), drainScoped(db, [LA, LB])]);
  assert.ok(out.every((o) => o.errors.length === 0), JSON.stringify(out.map((o) => o.errors)));
  assert.equal((await inbox(db, results[0].evidenceId)).outcome, "consistent");
  assert.ok([A2, B2].includes(results[0].evidenceId));
});

test("T-E1: a poison item (PROBE: impossible active hold on a linked recording) is a RECORDED error — SQLSTATE + attempts only, no message — stays queued behind fresh work; a repeated error stops the bounded step; after repair it processes with history kept", { timeout: 240000 }, async () => {
  const L = 873901;
  const l = await linkedOn(db, L);
  await drainScoped(db, [L]);
  const h = await probeHold(db, l.c.id, l.op.id, "SUCCEEDED_UNPROVEN");
  const poison = await F.chargeListEvidence(db.app, l.c, cnt([cid()]));
  const r = await scoped(db, [L]);
  assert.deepEqual(r, { evidenceId: poison, intentId: l.c.id, error: "23514", attempts: 1 }, "no message / last_error / label");
  const q = await inbox(db, poison);
  assert.deepEqual([q.processed_at, q.attempts], [null, 1]);
  assert.match(q.last_error, /^23514: HOLD_STATE_UNEXPECTED/);
  const fresh = await capturedOn(db, L); const fe = await apiRef(db, fresh.id, "1901", cnt([]));
  assert.equal((await scoped(db, [L])).evidenceId, fe, "fresh (attempts 0) first");
  const o = await proc(db, { listingIds: [L], maxItems: 25 });
  assert.deepEqual([o.calls, o.errors.map((e) => [e.evidenceId, e.error, e.attempts]), o.stoppedOnRepeatedError],
    [2, [[poison, "23514", 2], [poison, "23514", 3]], true]);
  assert.ok(o.errors.every((e) => JSON.stringify(Object.keys(e).sort()) === '["attempts","error","evidenceId","intentId"]'));
  const row = (await page(db, { listingIds: [L], status: "pending" })).rows.find((x) => x.evidence_id === poison);
  assert.deepEqual([row.last_error_code, row.attempts, row.processed_at_exact], ["23514", 3, null]);
  assert.ok(!JSON.stringify(row).includes("HOLD_STATE_UNEXPECTED"), "the page never shows message text");
  await removeProbeHold(db, h);
  const rr = await scoped(db, [L]);
  assert.deepEqual([rr.evidenceId, rr.outcome], [poison, "contradiction_opened"]);
  assert.equal((await inbox(db, poison)).attempts, 3, "error history kept on success");
});

test("T-E2: outer failures through a real pg.Pool — an ACKNOWLEDGED server rejection marks nothing; a reply LOST after commit leaves that call's outcome committed but unreported; both re-throw the ORIGINAL error with no follow-up query; a later step finishes without duplicates", { timeout: 240000 }, async () => {
  const L = 874001;
  const c = await capturedOn(db, L);
  const evs = [await apiRef(db, c.id, "2001", cnt([])), await apiRef(db, c.id, "2002", cnt([])), await apiRef(db, c.id, "2003", cnt([]))];
  const wrap = (mode) => {
    const w = { sqls: [], seen: null, totalCount: 0, connect: (...a) => db.app.connect(...a),
      query: async (sql, params) => {
        w.sqls.push(sql);
        const isCall = /process_recording_conflict_inbox_scoped_one/.test(sql);
        const n = w.sqls.filter((s) => /process_recording_conflict_inbox_scoped_one/.test(s)).length;
        if (isCall && mode === "reject" && n === 1) { try { return await db.app.query(sql, [params[0], params[1], "not-a-uuid"]); } catch (e) { w.seen = e; throw e; } }
        const res = await db.app.query(sql, params);
        if (isCall && mode === "lost" && n === 2) { w.seen = Object.assign(new Error("reply lost after COMMIT (TEST)"), { code: "ECONNRESET" }); throw w.seen; }
        return res;
      } };
    return w;
  };
  const p1 = wrap("reject");
  const e1 = await processScopedRecordingInbox(p1, { env: INBOX_ENV, by: "t", listingIds: [L] }).then(() => null, (e) => e);
  assert.equal(e1, p1.seen, "the ORIGINAL pg error object");
  assert.equal(e1.code, "22P02");
  assert.equal(p1.sqls.length, 2, "marker + the rejected call; no follow-up query");
  assert.deepEqual(JSON.parse(JSON.stringify(e1.scopedInboxProgress)), { calls: 1, processed: [], errors: [], skipped: [] });
  assert.ok(!Object.keys(e1).includes("scopedInboxProgress"), "non-enumerable");
  for (const e of evs) assert.deepEqual([(await inbox(db, e)).processed_at, (await inbox(db, e)).attempts], [null, 0], "acknowledged rejection marks nothing");
  const p2 = wrap("lost");
  const e2 = await processScopedRecordingInbox(p2, { env: INBOX_ENV, by: "t", listingIds: [L] }).then(() => null, (e) => e);
  assert.equal(e2, p2.seen);
  assert.deepEqual([e2.code, e2.message], ["ECONNRESET", "reply lost after COMMIT (TEST)"]);
  assert.equal(p2.sqls.length, 3, "marker + 2 calls; no retry");
  assert.equal(e2.scopedInboxProgress.calls, 2);
  assert.deepEqual(e2.scopedInboxProgress.processed.map((x) => x.evidenceId), [evs[0]], "only the ACKNOWLEDGED reply");
  assert.ok((await inbox(db, evs[1])).processed_at, "the lost-reply call DID commit (UNKNOWN to the caller)");
  assert.equal((await inbox(db, evs[2])).processed_at, null);
  // the safe follow-up: read-only inspection; a later independent step processes only what is still pending
  const pend = await page(db, { listingIds: [L], status: "pending" });
  assert.deepEqual(pend.rows.map((x) => x.evidence_id), [evs[2]]);
  const later = await proc(db, { listingIds: [L] });
  assert.deepEqual(later.processed.map((x) => x.evidenceId), [evs[2]]);
  assert.equal((await db.owner.query("SELECT count(*)::int AS n FROM booking.recording_conflict_inbox WHERE intent_id = $1 AND processed_at IS NOT NULL", [c.id])).rows[0].n, 3);
});

test("T-P1: read-only page — scope before LIMIT, exact seq keyset at limits 1/2/3, next only on a full EFFECTIVE (clamped) page, full-µs UTC strings, exact column set, NULL hold / case / latest-recording fields where absent; summary counts items vs DISTINCT holds / cases", { timeout: 240000 }, async () => {
  const L = 874101;
  const a = await F.authorized(db.app, stayOn(L));                                              // no recording, no hold
  const evs = [];
  for (let k = 0; k < 4; k++) evs.push(await apiRef(db, a.id, `410${k}`, cnt([])));
  const full = (await page(db, { listingIds: [L], limit: 200 })).rows;
  assert.deepEqual(full.map((r) => r.evidence_id), evs);
  const r0 = full[0];
  assert.deepEqual(Object.keys(r0), PAGE_KEYS);
  assert.equal(typeof r0.seq, "string");
  for (const k of ["enqueued_at_exact", "db_now_exact", "evidence_observed_at_exact"]) assert.match(r0[k], EXACT, k);
  assert.deepEqual([r0.hold_id, r0.hold_reason, r0.hold_active, r0.case_id, r0.case_status], [null, null, null, null, null], "no hold: all NULL (never true)");
  assert.deepEqual([r0.latest_op_id, r0.latest_op_state, r0.latest_op_linked], [null, null, null], "no recording: NULL");
  assert.deepEqual([r0.attempts, r0.last_error_code, r0.processed_at_exact, r0.outcome, r0.evidence_source, r0.listing_id, r0.intent_state],
    [0, null, null, null, "hostaway_api", L, "payment_authorized"]);
  for (const lim of [1, 2, 3]) {
    const got = []; let after = null; let pages = 0;
    for (;;) {
      const p = await page(db, { listingIds: [L], limit: lim, after });
      pages += 1; got.push(...p.rows.map((r) => r.evidence_id));
      assert.equal(p.next !== null, p.rows.length === lim, `next iff a full page (limit ${lim})`);
      if (!p.next) break;
      assert.equal(typeof p.next.afterSeq, "string");
      after = p.next;
    }
    assert.deepEqual(got, evs, `limit ${lim}`);
    assert.equal(pages, Math.floor(evs.length / lim) + 1);
  }
  const c0 = await page(db, { listingIds: [L], limit: 0 });                                       // clamped to 1
  assert.deepEqual([c0.rows.length, c0.next], [1, { afterSeq: c0.rows[0].seq }]);
  const c9 = await page(db, { listingIds: [L], limit: 999 });                                     // clamped to 200
  assert.deepEqual([c9.rows.length, c9.next], [4, null]);
  // status filter + a hold: one linked intent, two contradictions -> ONE hold, ONE case (distinct units)
  const l = await linkedOn(db, L);
  await drainScoped(db, [L]);
  const x1 = await F.chargeListEvidence(db.app, l.c, cnt(["881"])); const x2 = await F.chargeListEvidence(db.app, l.c, cnt(["882"]));
  await drainScoped(db, [L]);
  const s = (await summary(db, { listingIds: [L] })).summary;
  assert.equal(s.activeLinkedContradictedHolds, 1);
  assert.equal(s.openHoldCases, 1);
  assert.deepEqual([s.processedItemsByOutcome.contradiction_opened, s.processedItemsByOutcome.contradiction_appended, s.pendingItems, s.maxPendingAttempts,
    s.oldestPendingEnqueuedAtExact], [1, 1, 0, null, null]);
  assert.match(s.dbNowExact, EXACT);
  const total = (await db.owner.query("SELECT count(*)::int AS n FROM booking.recording_conflict_inbox WHERE intent_id = ANY($1)", [[a.id, l.c.id]])).rows[0].n;
  assert.equal(Object.values(s.processedItemsByOutcome).reduce((x, y) => x + y, 0), total, "item counts are per item");
  const hp = (await page(db, { listingIds: [L], status: "processed", limit: 200 })).rows.filter((r) => [x1, x2].includes(r.evidence_id));
  assert.ok(hp.every((r) => r.hold_active === true && r.hold_reason === "LINKED_CONTRADICTED" && r.case_status === "open" && r.latest_op_linked === true && r.latest_op_state === "succeeded"));
  assert.deepEqual((await page(db, { listingIds: [L], status: "pending" })).rows, []);
  // empty scope result vs invalid input
  const e = await summary(db, { listingIds: [874199] });
  assert.deepEqual([e.status, e.summary.pendingItems, e.summary.activeLinkedContradictedHolds, e.summary.oldestPendingEnqueuedAtExact], ["ok", 0, 0, null]);
  assert.deepEqual(await summary(db, { listingIds: [] }), { status: "refused", code: "SCOPE_INVALID" });
});

test("T-P1b (caveat): identity values can commit out of seq order — a LOWER seq committed after a page passed it is missed by that cursor and seen by a fresh scan", { timeout: 240000 }, async () => {
  const L = 874201;
  const a = await F.authorized(db.app, stayOn(L));
  const t = Date.now();
  const rid = await requestRead(db.app, a.id, "hostaway.list_offline_charges", "4201", { now: t });
  assert.ok(await claimNextOperation(db.app, { workerId: "w-read", now: t, opId: rid }));
  F.ok(await completeOperation(db.app, rid, { workerId: "w-read", now: t, outcome: { status: "succeeded" } }));
  const k = await asApp(db);
  let low;
  try {
    await k.query("BEGIN");
    low = (await k.query("SELECT booking.record_provider_evidence($1, 'hostaway_offline_charges', '4201', 'listed', $2, NULL) AS id", [rid, cnt([])])).rows[0].id;
    const a2 = await F.authorized(db.app, stayOn(L));                                           // another intent: no shared advisory key with k
    const high = await apiRef(db, a2.id, "4202", cnt([]));
    const p = await page(db, { listingIds: [L] });
    assert.deepEqual(p.rows.map((r) => r.evidence_id), [high]);
    const cursor = { afterSeq: p.rows[0].seq };
    await k.query("COMMIT");
    assert.deepEqual((await page(db, { listingIds: [L], after: cursor })).rows, [], "the cursor passed the lower seq");
    const fresh = (await page(db, { listingIds: [L] })).rows.map((r) => r.evidence_id);
    assert.deepEqual(fresh, [low, high]);
    assert.ok(BigInt((await inbox(db, low)).seq) < BigInt((await inbox(db, high)).seq));
  } finally { await k.end().catch(() => {}); }
});

test("T-G1: grants and roles — scoped processor app/admin; page + summary app/admin/report; private core / protected / predicate functions not executable by any runtime role; legacy ACL unchanged; no write privilege added; SQL protected ids == JS", { timeout: 240000 }, async () => {
  const fns = (await db.owner.query(`SELECT p.proname, p.oid::regprocedure::text AS sig, coalesce(array_to_string(p.proacl, ','), '') AS acl, p.prosecdef, p.provolatile,
      p.proconfig FROM pg_proc p WHERE p.pronamespace = 'booking'::regnamespace AND p.proname IN ('recording_protected_reservation_ids', 'recording_inbox_ref_protected',
      'recording_inbox_process_locked', 'process_recording_conflict_inbox_one', 'process_recording_conflict_inbox_scoped_one', 'recording_inbox_page',
      'recording_inbox_summary') ORDER BY 1`)).rows;
  const by = Object.fromEntries(fns.map((f) => [f.proname, f]));
  const exec = (f, role) => new RegExp(`(^|,)${role}=X/`).test(by[f].acl);
  for (const f of ["recording_protected_reservation_ids", "recording_inbox_ref_protected", "recording_inbox_process_locked"]) {
    for (const role of ["mv_booking_app", "mv_booking_admin", "mv_booking_report", ""]) assert.equal(exec(f, role), false, `${f}: no ${role || "PUBLIC"}`);
  }
  for (const [f, roles] of [["process_recording_conflict_inbox_one", ["mv_booking_app", "mv_booking_admin"]], ["process_recording_conflict_inbox_scoped_one", ["mv_booking_app", "mv_booking_admin"]],
    ["recording_inbox_page", ["mv_booking_app", "mv_booking_admin", "mv_booking_report"]], ["recording_inbox_summary", ["mv_booking_app", "mv_booking_admin", "mv_booking_report"]]]) {
    for (const role of ["mv_booking_app", "mv_booking_admin", "mv_booking_report", ""]) assert.equal(exec(f, role), roles.includes(role), `${f}: ${role || "PUBLIC"}`);
  }
  for (const f of fns) {
    assert.deepEqual(f.proconfig, ["search_path=pg_catalog, booking"], `${f.proname}: fixed search_path`);
    const invoker = ["recording_protected_reservation_ids", "recording_inbox_ref_protected"].includes(f.proname);
    assert.equal(f.prosecdef, !invoker, `${f.proname}: security`);
    assert.equal(f.provolatile, invoker ? "i" : "v", `${f.proname}: volatility`);
  }
  // executions by role
  const rep = new pg.Client({ connectionString: db.reportUrl() }); await rep.connect();
  try {
    await assert.rejects(rep.query("SELECT booking.process_recording_conflict_inbox_scoped_one('t', ARRAY[1], NULL)"), (e) => e.code === "42501");
    await assert.rejects(rep.query("SELECT booking.process_recording_conflict_inbox_one('t')"), (e) => e.code === "42501");
    assert.ok((await rep.query("SELECT booking.recording_inbox_summary(ARRAY[1], NULL) AS s")).rows[0].s);
    await rep.query("SELECT * FROM booking.recording_inbox_page(ARRAY[1], NULL, 'all', NULL, NULL)");
  } finally { await rep.end(); }
  for (const sql of ["SELECT booking.recording_inbox_process_locked(gen_random_uuid(), 't', ARRAY[1], NULL)", "SELECT booking.recording_protected_reservation_ids()",
    "SELECT booking.recording_inbox_ref_protected('1', '2')"]) {
    await assert.rejects(db.app.query(sql), (e) => e.code === "42501", sql);
    await assert.rejects(db.reconciler.query(sql), (e) => e.code === "42501", sql);
  }
  assert.equal((await db.reconciler.query("SELECT booking.process_recording_conflict_inbox_scoped_one('t', ARRAY[1], NULL) AS r")).rows[0].r, null);
  const writes = (await db.owner.query(`SELECT grantee, table_name, privilege_type FROM information_schema.role_table_grants WHERE table_schema = 'booking'
      AND table_name IN ('recording_conflict_inbox', 'recording_holds', 'recording_hold_observations', 'recording_hold_decisions') AND grantee LIKE 'mv_booking_%'
      ORDER BY 1, 2, 3`)).rows;
  assert.ok(writes.every((x) => x.privilege_type === "SELECT"), "no write privilege for any runtime role");
  assert.deepEqual((await db.owner.query("SELECT booking.recording_protected_reservation_ids() AS a")).rows[0].a, PROT, "SQL protected ids == JS PROTECTED_HOSTAWAY_RESERVATION_IDS");
});

test("T-L1: legacy parity — the 0015 legacy wrapper returns the same keys / values / messages and leaves the same rows as the ORIGINAL 0011 body (a fresh-14 equivalent cluster) on the same deterministic fixtures", { timeout: 240000 }, async () => {
  const p15 = await startMigratedDatabase();
  const p14 = await startMigratedDatabase();
  try {
    assert.deepEqual(await migrateDown(p14.owner, { env: "test", to: 14 }), [15], "p14 = 0015 rolled back (equality with a fresh 14 is T-M1)");
    const scenario = async (d) => {
      const A = await linkedOn(d, 875001);
      const B = await claimedOn(d, 875002);
      const x1 = await F.chargeListEvidence(d.app, A.c, cnt(["991"]));
      const x2 = await F.chargeListEvidence(d.app, A.c, cnt(["992"]));
      const C = await linkedOn(d, 875003);
      const ids = [];
      const out = [];
      for (let k = 0; k < 30; k++) {
        if (k === 6) { const h = await probeHold(d, C.c.id, C.op.id, "SUCCEEDED_UNPROVEN"); await F.chargeListEvidence(d.app, C.c, cnt(["993"])); ids.push(h); }
        const r = await legacy(d);
        if (r === null && k >= 6) break;
        out.push(r);
      }
      const rows = (await d.owner.query("SELECT evidence_id, intent_id, attempts, outcome, (hold_id IS NOT NULL) AS h, last_error IS NOT NULL AS err, processed_at IS NOT NULL AS p FROM booking.recording_conflict_inbox ORDER BY seq")).rows;
      const holds = (await d.owner.query("SELECT intent_id, reason, released_at IS NULL AS active, created_by FROM booking.recording_holds ORDER BY created_at, id")).rows;
      const obs = (await d.owner.query("SELECT count(*)::int AS n FROM booking.recording_hold_observations")).rows[0].n;
      const cases = (await d.owner.query("SELECT intent_id, kind, status FROM booking.reconciliation_cases WHERE kind LIKE 'OFFLINE\\_CHARGE\\_HOLD\\_%' ORDER BY opened_at, id")).rows;
      const labels = new Map(); const L = (u) => { if (!labels.has(u)) labels.set(u, `U${labels.size}`); return labels.get(u); };
      const norm = (v) => JSON.parse(JSON.stringify(v).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (u) => L(u)));
      return { out: norm(out), rows: norm(rows), holds: norm(holds), obs, cases: norm(cases), keys: out.filter(Boolean).map((r) => Object.keys(r).sort().join(",")), probe: ids[0] };
    };
    const s14 = await scenario(p14); const s15 = await scenario(p15);
    for (const k of ["out", "rows", "holds", "obs", "cases", "keys"]) assert.deepEqual(s15[k], s14[k], k);
    assert.ok(s14.keys.includes("evidenceId,holdId,outcome") && s14.keys.includes("error,evidenceId,message"), "both legacy result shapes exercised");
    assert.ok(s14.out.some((r) => r && r.error === "23514" && /HOLD_STATE_UNEXPECTED/.test(r.message)), "legacy keeps its message");
    // repair the parity probe in p15 and let the legacy processor finish its own isolated items (no protected-reference item exists in p15)
    await removeProbeHold(p15, s15.probe);
    for (let k = 0; k < 10 && (await legacy(p15)) !== null; k++);
    assert.equal(await legacy(p15), null);
    // scoped vs legacy on the SAME item (isolated cluster p15: no protected-reference item exists here): the scoped call holds the item; the legacy skips it
    const Lc = 875101;
    const c = await capturedOn(p15, Lc);
    const c2 = await capturedOn(p15, Lc);                                                         // a second intent: the scoped call holds c's advisory key
    const e1 = await apiRef(p15, c.id, "5101", cnt([])); const e2 = await apiRef(p15, c2.id, "5102", cnt([]));
    const k = await asApp(p15);
    try {
      await k.query("BEGIN");
      assert.equal((await scoped(p15, [Lc], null, k)).evidenceId, e1);
      const lg = await legacy(p15);
      assert.equal(lg.evidenceId, e2, "legacy SKIPS the item the scoped call holds");
      await k.query("COMMIT");
    } finally { await k.end(); }
    assert.equal(await legacy(p15), null);
    assert.deepEqual([(await inbox(p15, e1)).outcome, (await inbox(p15, e2)).outcome], ["not_latest_linked", "not_latest_linked"]);
  } finally { await p15.close(); await p14.close(); }
});

test("T-M1: 0015 down (UNGATED) restores the legacy body FIRST and drops the new functions; functions / ACL / security / search_path equal a FRESH 14 cluster; ordinary audit written through the scoped API is byte-identical across down / up; prior down gates unchanged", { timeout: 240000 }, async () => {
  const m = await startMigratedDatabase();
  const fresh = await startPostgres();
  const f14 = new pg.Client({ connectionString: fresh.adminUrl });
  await f14.connect();
  try {
    const objs = async (c) => (await c.query(`SELECT p.oid::regprocedure::text || '|' || md5(pg_get_functiondef(p.oid)) || '|' || coalesce(array_to_string(p.proacl, ','), '')
        || '|' || p.prosecdef || '|' || p.provolatile::text || '|' || coalesce(array_to_string(p.proconfig, ','), '') AS o FROM pg_proc p
        WHERE p.pronamespace = 'booking'::regnamespace ORDER BY 1`)).rows.map((r) => r.o);
    const l = await linkedOn(m, 876001);
    await drainScoped(m, [876001]);
    await F.chargeListEvidence(m.app, l.c, cnt(["661"]));
    await drainScoped(m, [876001]);
    await apiRef(m, l.c.id, "6602", cnt([]));                                                      // one item left pending
    const auditAll = async () => [await m.owner.query("SELECT * FROM booking.recording_conflict_inbox ORDER BY seq"),
      await m.owner.query("SELECT * FROM booking.recording_holds ORDER BY id"), await m.owner.query("SELECT * FROM booking.recording_hold_observations ORDER BY id"),
      await m.owner.query("SELECT * FROM booking.recording_hold_decisions ORDER BY id"), await m.owner.query("SELECT * FROM booking.reconciliation_cases ORDER BY id")]
      .map((r) => JSON.stringify(r.rows)).join("\n");
    const a0 = await auditAll(); const at15 = await objs(m.owner);
    assert.ok((await holdsOf(m, l.c.id)).length === 1);
    assert.deepEqual(await migrateDown(m.owner, { env: "test", to: 14 }), [15]);
    await migrateUp(f14, { env: "test", to: 14 });
    assert.deepEqual(await objs(m.owner), await objs(f14), "15 -> 14 == fresh 14 (functiondef md5 / ACL / secdef / volatility / search_path)");
    assert.equal(await auditAll(), a0, "audit byte-identical after down");
    assert.deepEqual(await migrateUp(m.owner, { env: "test" }), [15]);
    assert.deepEqual(await objs(m.owner), at15);
    assert.equal(await auditAll(), a0, "audit byte-identical after up");
    // the PRIOR audit gates are unchanged: each down step is its own transaction, so 15 / 14 / 13 roll back first and 0012's audit gate refuses
    await assert.rejects(migrateDown(m.owner, { env: "test", to: 10 }), /DOWNGRADE_REFUSED_RECORDING_ASSESSMENT_AUDIT/, "the prior audit gate still refuses");
    assert.equal((await m.owner.query("SELECT max(version)::int AS v FROM booking_migrations.applied")).rows[0].v, 12);
    assert.deepEqual(await migrateUp(m.owner, { env: "test" }), [13, 14, 15]);
    assert.equal(await auditAll(), a0, "audit rows unchanged after the refused down + re-up");
    assert.deepEqual(await objs(m.owner), at15);
  } finally { await f14.end(); fresh.stop(); await m.close(); }
});

test("T-P2 (LAST; TEST SETUP: identity sequence moved above 2^53 in this disposable cluster): seq and the cursor round-trip as exact decimal strings", { timeout: 240000 }, async () => {
  await db.owner.query("SELECT setval(pg_get_serial_sequence('booking.recording_conflict_inbox', 'seq'), 9007199254740993)");   // TEST SETUP
  const L = 874301;
  const a = await F.authorized(db.app, stayOn(L));
  const evs = [await apiRef(db, a.id, "4301", cnt([])), await apiRef(db, a.id, "4302", cnt([])), await apiRef(db, a.id, "4303", cnt([]))];
  const p1 = await page(db, { listingIds: [L], limit: 1 });
  assert.deepEqual([p1.rows[0].seq, p1.next], ["9007199254740994", { afterSeq: "9007199254740994" }]);
  const p2 = await page(db, { listingIds: [L], limit: 2, after: p1.next });
  assert.deepEqual(p2.rows.map((r) => [r.seq, r.evidence_id]), [["9007199254740995", evs[1]], ["9007199254740996", evs[2]]]);
  assert.notEqual(String(Number("9007199254740995")), "9007199254740995", "a Number coercion would have lost precision");
  const p3 = await page(db, { listingIds: [L], after: p2.next });
  assert.deepEqual([p3.rows, p3.next], [[], null]);
  const o = await proc(db, { listingIds: [L] });
  assert.deepEqual(o.processed.map((x) => x.evidenceId), evs);
});
