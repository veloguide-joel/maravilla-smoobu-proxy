// Stage E7 guest notification — STAGE 1 DB fence (migration 0016 + narrow operations.js changes).
// Contract: claude/e7-guest-notification-contract.md revision 3 (accepted OFFLINE design at 6e3fca5f, root addenda A–C).
// DISPOSABLE local PostgreSQL clusters only. Repository code runs as the runtime login test_app (∈ mv_booking_app), owner decisions as
// test_admin; the schema owner (postgres) only for catalog snapshots, lock observation and explicitly labelled TEST SETUP.
//
// TRUST / SHAPE LABELS
//   * Every provider object is a SYNTHETIC, DOC-DERIVED, LIVE-UNVERIFIED mock built in this file (the accepted lifecycle-rehearsal world,
//     copied test-locally). Nothing reaches a provider. No renderer, notification worker, executor, adapter or send exists in Stage 1:
//     the "content hash" below is ONE synthetic constant (TRUST field), never a rendered message.
//   * Guest rows use synthetic `.invalid` addresses (a test-address restriction, not transport authentication). No guest contact value or
//     message content is ever logged by this file. USD only.
//   * Positive chains are built ONLY with the accepted workers / repo functions (no guard bypass). TEST SETUP with triggers disabled
//     (fixtures.ownerManagedHistory) is used ONLY to isolate the partial unique index and to plant legacy rows for the upgrade gate.
//   * Protected ids 70636076 / 71045356 / 71072615 / 71081885 appear only as fixture references; the 0016 functions must give them
//     zero NEW notification writes. The GENERIC exported recoverExpiredOperations is never called on a protected row here (U2 residual).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import pg from "pg";
import { startMigratedDatabase, startPostgres } from "./harness.mjs";
import * as F from "./fixtures.mjs";
import { applyEvent, loadIntent, createIntentRecord, collectGuestDetails, beginPayStep, recordCheckoutSession, recordHostawayCreateResult, recordHostawayLookup, purgeGuestData } from "../../lib/booking-db/repo.js";
import { claimNextOperation, completeOperation, recoverExpiredOperations, requestRead, recordProviderEvidence } from "../../lib/booking-db/operations.js";
import { runOrchestratorStep } from "../../lib/booking-db/reservation-worker.js";
import { runCaptureStep } from "../../lib/booking-db/capture-worker.js";
import { runRecordingStep } from "../../lib/booking-db/recording-worker.js";
import { runCleanupStep } from "../../lib/booking-db/compensation-worker.js";
import { priceStay } from "../../lib/checkout/server-pricer.js";
import { readDirectPolicyFromEnv } from "../../lib/direct-policy.js";
import { todayInTimeZone } from "../../lib/public-api.js";
import { validateAdapterConfig } from "../../lib/hostaway-reservations.js";
import { migrateDown, migrateUp, migrationStatus, loadMigrations } from "../../db/lib/migrate.js";

let netAttempts = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { netAttempts += 1; throw new Error("network refused (offline Stage 1 suite)"); };

let db;
before(async () => { db = await startMigratedDatabase(); });
after(async () => { globalThis.fetch = realFetch; await db.close(); });

const SEC = 1000; const MIN = 60 * SEC; const DAY = 24 * 60 * MIN;
const ENV_R = Object.freeze({ VERCEL_ENV: "development", MV_E7_RESERVATION_WORKER: "enabled" });
const ENV_C = Object.freeze({ VERCEL_ENV: "development", MV_E7_CAPTURE_WORKER: "enabled" });
const ENV_W = Object.freeze({ VERCEL_ENV: "development", MV_E7_RECORDING_WORKER: "enabled" });
const ENV_K = Object.freeze({ VERCEL_ENV: "development", MV_E7_COMPENSATION_WORKER: "enabled" });
const POLICY = readDirectPolicyFromEnv(ENV_R).policy;
const ACCT = "acct_1GuestNotifyFence";
const LABEL = Object.freeze({ accountRef: "acct-test-1", clientSnapshotId: "client-GN" });
const REF_FIELD = 777016;
const TZ = "America/Mazatlan";
const PROTECTED = ["70636076", "71045356", "71072615", "71081885"];
const SYN = createHash("sha256").update("gn-stage1-synthetic-content-hash").digest("hex");   // TRUST field: synthetic constant, no message
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------
// accepted-worker chain helpers: copied test-locally from test/db/e7-offline-lifecycle.test.mjs (world / authorizedBooking / lane), with
// a synthetic .invalid guest.
let block = 6100000;
function world({ nightly = 250 } = {}) {
  block += 1000;
  const w = { nightly, calls: [], paths: [], writes: { createReservation: 0, capturePaymentIntent: 0, createOfflineCharge: 0, cancelPaymentIntent: 0, cancelReservation: 0 },
    res: new Map(), pis: new Map(), charges: [], nextRes: block, nextCharge: block * 10 };
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
  w.pricing = {
    get: async (path, opts = {}) => {
      const m = /^\/listings\/(\d+)(\/calendar)?$/.exec(path); const id = Number(m[1]);
      if (!m[2]) return { status: 200, json: { result: { id, currencyCode: "USD", personCapacity: 4, minNights: 1, maxNights: 90 } } };
      return { status: 200, json: { result: days(opts.query.startDate, opts.query.endDate) } };
    },
    post: async (path, body) => {
      const nights = Math.round((Date.parse(body.endingDate) - Date.parse(body.startingDate)) / DAY);
      const comps = [{ id: 1, type: "accommodation", name: "baseRate", title: "Base rate", quantity: 1, value: w.nightly, total: w.nightly * nights, isIncludedInTotalPrice: 1,
        isMandatory: 1, isOverriddenByUser: 0, isDeleted: 0, units: nights }];
      return { status: 200, json: { status: "success", result: { totalPrice: comps[0].total, components: comps } } };
    }
  };
  const hostaway = {
    lookupPage: async (req) => {
      if (req.query.afterId) return { httpStatus: 200, json: { status: "success", result: [] } };
      const items = [...w.res.values()].filter((r) => r.listingMapId === req.query.listingId && r.arrivalDate === req.query.arrivalStartDate).map(full);
      return { httpStatus: 200, json: { status: "success", result: items } };
    },
    retrieveReservation: async (req) => {
      const r = w.res.get(ridOf(req.path));
      return r ? { httpStatus: 200, json: { status: "success", result: full(r) } } : { httpStatus: 404, json: { status: "fail" } };
    },
    createReservation: async (req) => {
      w.writes.createReservation += 1;
      const r = { id: w.nextRes++, listingMapId: req.body.listingMapId, arrivalDate: req.body.arrivalDate, departureDate: req.body.departureDate,
        totalPrice: req.body.totalPrice, currency: req.body.currency, status: "new", ref: req.body.customFieldValues[0].value };
      w.res.set(r.id, r);
      return { httpStatus: 201, json: { status: "success", result: full(r) } };
    },
    cancelReservation: async (req) => {
      w.writes.cancelReservation += 1;
      const r = w.res.get(ridOf(req.path)); r.status = "cancelled";
      return { httpStatus: 200, json: { status: "success", result: full(r) } };
    },
    listOfflineCharges: async (req) => {
      const rows = w.charges.filter((c) => String(c.reservationId) === String(req.query.reservationId)).map((c) => ({ ...c }));
      return { httpStatus: 200, json: { status: "success", result: rows, count: rows.length, offset: null } };
    },
    createOfflineCharge: async (req) => {
      w.writes.createOfflineCharge += 1;
      const rid = Number(/^\/v1\/guestPayments\/charges\/(\d+)$/.exec(req.path)[1]);
      const ch = { id: w.nextCharge++, listingMapId: w.res.get(rid).listingMapId, reservationId: rid, type: "charge", title: req.body.title, currency: "USD",
        paymentMethod: req.body.paymentMethod, amount: req.body.amount, status: "paid", paymentProvider: "offline" };
      w.charges.push(ch);
      return { httpStatus: 201, json: { status: "success", result: { ...ch } } };
    }
  };
  const stripe = {
    retrieveAccount: async () => ({ object: "account", id: ACCT }),
    retrievePaymentIntent: async (id) => w.piObj(w.pis.get(id)),
    capturePaymentIntent: async (id, params) => { w.writes.capturePaymentIntent += 1; const p = w.pis.get(id); p.status = "succeeded"; p.received = params.amount_to_capture; return w.piObj(p); },
    cancelPaymentIntent: async (id) => { w.writes.cancelPaymentIntent += 1; const p = w.pis.get(id); p.status = "canceled"; return w.piObj(p); }
  };
  w.exec = {
    R: { pricing: w.pricing, lookupPage: hostaway.lookupPage, retrieveReservation: hostaway.retrieveReservation, createReservation: hostaway.createReservation },
    C: { retrieveAccount: stripe.retrieveAccount, retrievePaymentIntent: stripe.retrievePaymentIntent, capturePaymentIntent: stripe.capturePaymentIntent,
      retrieveReservation: hostaway.retrieveReservation, lookupPage: hostaway.lookupPage },
    W: { label: LABEL, retrieveReservation: hostaway.retrieveReservation, listOfflineCharges: hostaway.listOfflineCharges, createOfflineCharge: hostaway.createOfflineCharge },
    K: { retrieveAccount: stripe.retrieveAccount, retrievePaymentIntent: stripe.retrievePaymentIntent, cancelPaymentIntent: stripe.cancelPaymentIntent,
      retrieveReservation: hostaway.retrieveReservation, lookupPage: hostaway.lookupPage, cancelReservation: hostaway.cancelReservation }
  };
  return w;
}

let laneN = 0;
async function authorizedBooking(w, { guestDomain = "mv-test.invalid", listingId: fixedListing = null } = {}) {
  laneN += 1;
  const listingId = fixedListing ?? 891000 + laneN;
  const stay = { from: addDays("2026-12-01", 3 * laneN), to: addDays("2026-12-01", 3 * laneN + 2), guests: 2 };
  const base = Date.now() - 20 * MIN;
  const priced = await priceStay({ request: { listingId, ...stay }, listingConfig: { currency: "USD" }, client: w.pricing, policy: POLICY,
    today: todayInTimeZone(undefined, new Date(base)), now: base });
  assert.ok(priced.ok, priced.error);
  const intent = await createIntentRecord(db.app, { ref: F.nextRef(), accessTokenHash: F.tokenHash(), environment: "test", now: base, listingId, ...stay });
  F.ok(await applyEvent(db.app, intent.id, { type: "PRICE_CONFIRMED", price: priced.price }, { now: base, actor: "guest" }));
  const guest = { firstName: "Synthia", lastName: "Fixture", email: `guest.n${laneN}@${guestDomain}` };   // SYNTHETIC; never logged
  F.ok(await collectGuestDetails(db.app, intent.id, guest, { now: base + SEC, termsVersion: "terms-2026-10" }));
  const b = F.ok(await beginPayStep(db.app, intent.id, { now: base + 2 * SEC }));
  const op = await claimNextOperation(db.app, { workerId: "w-pay", now: base + 2 * SEC, intentId: intent.id, opTypes: ["stripe.create_checkout_session"] });
  const sessionId = `cs_test_gn${laneN}`;
  F.ok(await completeOperation(db.app, op.id, { workerId: "w-pay", now: base + 2 * SEC, outcome: { status: "succeeded", resultRef: sessionId } }));
  F.ok(await recordCheckoutSession(db.app, intent.id, b.attempt.id, { sessionId, expiresAt: base + 30 * MIN, now: base + 2 * SEC }));
  const piId = `pi_test_gn${laneN}`;
  const captureBefore = Math.floor((base + 7 * DAY) / 1000) * 1000;
  F.ok(await applyEvent(db.app, intent.id, { type: "PAYMENT_AUTHORIZED", id: `evt_auth_${piId}`, paymentIntentId: piId, sessionId, amountMinor: priced.price.finalTotalMinor,
    currency: "usd", livemode: false, authorizationCreatedAt: base + 3 * SEC, captureBefore }, { now: base + 4 * SEC, actor: "webhook" }));
  const pa = (await db.app.query("SELECT id FROM booking.payment_attempts WHERE intent_id = $1 AND status = 'completed'", [intent.id])).rows[0].id;
  w.pis.set(piId, { id: piId, intentId: intent.id, attemptId: pa, status: "requires_capture", amount: priced.price.finalTotalMinor, received: 0,
    chargeId: `ch_test_gn${laneN}`, captureBeforeSec: captureBefore / 1000 });
  return { id: intent.id, ref: intent.ref, listingId, stay, piId, total: priced.price.finalTotalMinor, base };
}

function lane(w, bk) {
  const clk = { t: bk.base + 10 * SEC };
  const adapterConfig = validateAdapterConfig({ allowedListingIds: [bk.listingId], refFieldId: REF_FIELD, channelId: 2000, currency: "USD" });
  const recCfg = { accountRef: LABEL.accountRef, channelId: 2000, currency: "USD", listingId: bk.listingId, paymentMethod: "credit_card", refFieldId: REF_FIELD };
  const L = {
    clk,
    R: () => runOrchestratorStep(db.app, { workerId: "gn-res", env: ENV_R, adapterConfig, listings: new Map([[bk.listingId, { currency: "USD" }]]),
      executors: w.exec.R, clock: () => clk.t, intentId: bk.id }),
    C: () => runCaptureStep(db.app, { workerId: "gn-cap", env: ENV_C, adapterConfig, listings: new Map([[bk.listingId, { currency: "USD" }]]),
      executors: w.exec.C, clock: () => clk.t, stripeAccountId: ACCT, intentId: bk.id }),
    W: () => runRecordingStep(db.app, { workerId: "gn-rec", env: ENV_W, listings: new Map([[bk.listingId, recCfg]]), executors: w.exec.W, clock: Date.now, intentId: bk.id }),
    K: () => runCleanupStep(db.app, { workerId: "gn-cln", env: ENV_K, adapterConfig, listings: new Map([[bk.listingId, { currency: "USD", timeZone: TZ }]]),
      executors: w.exec.K, clock: () => clk.t, stripeAccountId: ACCT, intentId: bk.id }),
    until: async (k, pred, { max = 10, adv = MIN } = {}) => {
      for (let n = 0; n < max; n++) {
        if (pred(await state(bk.id))) return;
        const r = await L[k]();
        if (r && r.late) await Promise.race([r.late, sleep(200)]);
        clk.t = Math.min(clk.t + adv, Date.now() - 5 * SEC);
      }
      assert.fail(`${k}: not reached (${await state(bk.id)})`);
    }
  };
  return L;
}

const state = async (id) => (await loadIntent(db.app, id)).status;
const one = async (sql, p = []) => (await db.owner.query(sql, p)).rows[0];
const all = async (sql, p = []) => (await db.owner.query(sql, p)).rows;
const num = async (sql, p = []) => Number((await db.owner.query(sql, p)).rows[0].n);
const notifyOf = async (intentId) => one("SELECT * FROM booking.external_operations WHERE intent_id = $1 AND op_type = 'guest.notify'", [intentId]);
const app1 = async (sql, p = []) => (await db.app.query(sql, p)).rows[0];

/** confirmed via R → C → W (accepted workers). */
async function confirmedBooking(opts) {
  const w = world(); const bk = await authorizedBooking(w, opts); const L = lane(w, bk);
  await L.until("R", (s) => s === "reservation_confirmed");
  await L.until("C", (s) => s === "payment_captured");
  await L.W();
  assert.equal(await state(bk.id), "confirmed");
  return { ...bk, w, L, op: await notifyOf(bk.id) };
}
/** authorization_released via a definite pre-capture failure (price changed) → void (accepted workers). */
async function releasedBooking(opts) {
  const w = world(); const bk = await authorizedBooking(w, opts); const L = lane(w, bk);
  w.nightly += 25;
  await L.R();
  assert.equal(await state(bk.id), "reservation_failed");
  await L.until("K", (s) => s === "authorization_released");
  return { ...bk, w, L, op: await notifyOf(bk.id) };
}
/** cancelled from capture_failed (definite, capture never dispatched — "P" history) → void + host-cancel (accepted workers). */
async function cancelledBooking(opts) {
  const w = world(); const bk = await authorizedBooking(w, opts); const L = lane(w, bk);
  await L.until("R", (s) => s === "reservation_confirmed");
  F.ok(await applyEvent(db.app, bk.id, { type: "CAPTURE_FAILED", definite: true, code: "CARD_DECLINED" }, { now: L.clk.t, actor: "worker" }));
  assert.equal(await state(bk.id), "capture_failed");
  await L.until("K", (s) => s === "cancelled");
  return { ...bk, w, L, op: await notifyOf(bk.id) };
}

// 0016 API calls as the runtime role
const work = (worker, bk) => app1("SELECT booking.claim_notification_work($1, $2, $3) AS r", [worker, [bk.listingId], bk.id]).then((x) => x.r);
/** R-C1 observation contract: an explicit READ ONLY REPEATABLE READ transaction → ONE observation SELECT → COMMIT. Any query / COMMIT
 *  error propagates unchanged (the caller stops: no invocation, no follow-up mutation, no retry). */
async function observe(sql, params) {
  const c = await db.app.connect();
  try {
    await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const r = (await c.query(sql, params)).rows[0].r;
    await c.query("COMMIT");
    return r;
  } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
}
const snapshot = (op) => observe("SELECT booking.guest_notification_snapshot($1) AS r", [op]);
const claim = (op, worker, s, { content = SYN } = {}) => app1("SELECT booking.claim_guest_notification($1, $2, 'gn-v1', $3, $4, $5) AS r",
  [op, worker, content, s.factsHash, s.recipientHash]).then((x) => x.r);
const presend = (op, worker) => observe("SELECT booking.guest_notification_presend($1, $2) AS r", [op, worker]);
const workIn = (worker, listingIds, intentId = null) => app1("SELECT booking.claim_notification_work($1, $2, $3) AS r", [worker, listingIds, intentId]).then((x) => x.r);
const complete = (op, worker, kind, ref, code) => app1("SELECT booking.complete_guest_notification($1, $2, $3, $4, $5) AS r", [op, worker, kind, ref, code]).then((x) => x.r);
const release = (intentId, worker) => app1("SELECT booking.release_notification_work($1, $2) AS r", [intentId, worker]).then((x) => x.r);
const recover = (listingIds, intentId, limit = 10) => app1("SELECT booking.recover_expired_notifications($1, $2, $3) AS r", [listingIds, intentId, limit]).then((x) => x.r);
const refusal = (op) => one("SELECT booking.guest_notification_refusal($1) AS r", [op]).then((x) => x.r);
const klass = (op) => one("SELECT booking.guest_notification_class($1) AS r", [op]).then((x) => x.r);
const summary = (listingIds) => app1("SELECT booking.guest_notification_summary($1) AS r", [listingIds]).then((x) => x.r);
/** acquire work + snapshot + claim (all as the runtime role) */
async function acquireAndClaim(bk, worker) {
  const wk = await work(worker, bk);
  assert.equal(wk.status, "acquired", JSON.stringify(wk));
  const s = await snapshot(bk.op.id);
  return { wk, s, c: await claim(bk.op.id, worker, s) };
}
/** owner-side digests: notification rows / audit unchanged */
const digest = async (bk) => (await one(`SELECT md5(coalesce((SELECT row_to_json(o)::text FROM booking.external_operations o WHERE o.id = $1), '')
   || coalesce((SELECT row_to_json(r)::text FROM booking.notification_renders r WHERE r.operation_id = $1), '')
   || coalesce((SELECT row_to_json(l)::text FROM booking.notification_latches l WHERE l.operation_id = $1), '')
   || coalesce((SELECT string_agg(row_to_json(c)::text, '|' ORDER BY c.id) FROM booking.reconciliation_cases c WHERE c.intent_id = $2), '')
   || coalesce((SELECT row_to_json(w)::text FROM booking.intent_work w WHERE w.intent_id = $2), '')) AS d`, [bk.op.id, bk.id])).d;
/** run fn() expecting a Postgres error; returns it */
async function pgErr(fn) { try { await fn(); } catch (e) { return e; } assert.fail("expected a database error"); }
/** dashboard (owner-attested) evidence through the admin login */
const dashboard = (intentId, kind, ref, status, observed, observedAtMs) => db.reconciler.query(
  "SELECT booking.admin_record_evidence($1, $2, $3, $4, $5, $6, 'owner', 'gn-fixture-check') AS id", [intentId, kind, String(ref), status, observed, new Date(observedAtMs)])
  .then((r) => r.rows[0].id);
/** API evidence through an executed read (accepted repo path) */
async function apiEvidence(intentId, kind, ref, status, observed, nowMs) {
  const opType = { payment_intent: "stripe.retrieve_payment_intent", hostaway_reservation: "hostaway.retrieve_reservation" }[kind];
  await requestRead(db.app, intentId, opType, String(ref), { now: nowMs });
  const op = await claimNextOperation(db.app, { workerId: "gn-read", now: nowMs, intentId, opTypes: [opType] });
  F.ok(await completeOperation(db.app, op.id, { workerId: "gn-read", now: nowMs, outcome: { status: "succeeded", resultRef: String(ref) } }));
  return F.ok(await recordProviderEvidence(db.app, { readOpId: op.id, kind, externalRef: String(ref), status, observed, providerRequestId: `req_${op.id.slice(0, 8)}` })).id;
}
/** wait until some backend running `like` is blocked on a lock */
async function waitBlocked(like, { ms = 8000 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const n = await num("SELECT count(*) AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE $1", [`%${like}%`]);
    if (n > 0) return true;
    await sleep(25);
  }
  return false;
}
const client = async (url) => { const c = new pg.Client({ connectionString: url }); await c.connect(); return c; };


// ---------------------------------------------------------------------------------------------
// R-C1 / R-C2 red-green controls. Narrow SQL TEST PROBES only (disposable cluster, schema owner):
//   * OLD_* = the exact 01c6f036 function bodies, installed under a DIFFERENT name (gn_probe_*_01c6) for a red control, then dropped;
//   * injectBarrier() re-creates a REAL 0016 function with one advisory barrier statement added, and restore() re-installs the exact
//     original definition and checks md5(pg_get_functiondef) is identical (CREATE OR REPLACE keeps owner / ACL / security).
const BARRIER_KEY = 774411;
const BARRIER_SQL = `PERFORM pg_advisory_lock_shared(${BARRIER_KEY}); PERFORM pg_advisory_unlock_shared(${BARRIER_KEY});   -- TEST PROBE barrier`;
const OLD_SNAPSHOT = String.raw`CREATE FUNCTION booking.guest_notification_snapshot(p_op uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
DECLARE o booking.external_operations%ROWTYPE; cls text; f jsonb; g booking.intent_guests%ROWTYPE;
BEGIN
  IF p_op IS NULL THEN RAISE EXCEPTION 'NOTIFY_ARGUMENT_INVALID: op' USING ERRCODE = 'invalid_parameter_value'; END IF;
  cls := booking.guest_notification_class(p_op);
  IF cls = 'PROTECTED' OR cls = 'NOT_NOTIFY' THEN RETURN jsonb_build_object('class', cls); END IF;
  SELECT * INTO o FROM booking.external_operations WHERE id = p_op;
  IF cls <> 'ELIGIBLE' THEN RETURN jsonb_build_object('class', cls); END IF;
  f := booking.guest_notification_facts(p_op);
  SELECT * INTO g FROM booking.intent_guests WHERE intent_id = o.intent_id;
  RETURN jsonb_build_object('class', cls, 'code', booking.guest_notification_refusal(p_op), 'template', o.payload ->> 'template', 'facts', f,
    'factsHash', booking.gn_hash_facts(f), 'recipientHash', booking.guest_notification_recipient_hash(o.intent_id),
    'email', g.email, 'firstName', g.first_name);
END $$;`;
const OLD_PRESEND = String.raw`CREATE FUNCTION booking.guest_notification_presend(p_op uuid, p_worker text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
DECLARE o booking.external_operations%ROWTYPE; rd booking.notification_renders%ROWTYPE; i booking.intents%ROWTYPE; w booking.intent_work%ROWTYPE;
        r text; v_t timestamptz;
BEGIN
  PERFORM booking.gn_check_worker(p_worker);
  IF p_op IS NULL THEN RAISE EXCEPTION 'NOTIFY_ARGUMENT_INVALID: op' USING ERRCODE = 'invalid_parameter_value'; END IF;
  SELECT * INTO o FROM booking.external_operations WHERE id = p_op;
  IF o.id IS NULL OR o.op_type <> 'guest.notify' THEN RETURN jsonb_build_object('ok', false, 'code', 'NOT_NOTIFY'); END IF;
  IF booking.guest_notification_protected(o.intent_id) THEN RETURN jsonb_build_object('ok', false, 'code', 'PROTECTED'); END IF;
  v_t := clock_timestamp();
  SELECT * INTO rd FROM booking.notification_renders WHERE operation_id = p_op;
  SELECT * INTO i FROM booking.intents WHERE id = o.intent_id;
  SELECT * INTO w FROM booking.intent_work WHERE intent_id = o.intent_id;
  IF o.state <> 'in_flight' OR o.attempts <> 1 OR rd.operation_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'NOT_IN_FLIGHT'); END IF;
  IF o.lease_worker_id IS DISTINCT FROM p_worker OR rd.worker IS DISTINCT FROM p_worker OR o.lease_until < v_t
     OR w.work_worker_id IS DISTINCT FROM p_worker OR w.work_lease_until IS NULL OR w.work_lease_until < v_t THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LEASE_NOT_HELD');
  END IF;
  IF i.version IS DISTINCT FROM rd.intent_version THEN RETURN jsonb_build_object('ok', false, 'code', 'VERSION_DRIFT'); END IF;
  r := booking.guest_notification_refusal(p_op);
  IF r IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'code', r); END IF;
  IF booking.gn_hash_facts(booking.guest_notification_facts(p_op)) IS DISTINCT FROM rd.facts_hash THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FACTS_CHANGED');
  END IF;
  IF booking.guest_notification_recipient_hash(o.intent_id) IS DISTINCT FROM rd.recipient_hash THEN
    RETURN jsonb_build_object('ok', false, 'code', 'RECIPIENT_CHANGED');
  END IF;
  RETURN jsonb_build_object('ok', true, 'code', NULL, 'dbNow', v_t, 'opLeaseUntil', o.lease_until, 'workLeaseUntil', w.work_lease_until,
    'contentHash', rd.content_hash, 'templateVersion', rd.template_version, 'messageRef', rd.message_ref);
END $$;`;
const OLD_WORK = String.raw`CREATE FUNCTION booking.claim_notification_work(p_worker text, p_listing_ids integer[], p_intent uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
DECLARE c record; skip uuid[] := ARRAY[]::uuid[]; k integer; w uuid; v_t timestamptz;
BEGIN
  PERFORM booking.gn_check_worker(p_worker);
  PERFORM booking.gn_check_scope(p_listing_ids);
  FOR k IN 1..10 LOOP
    SELECT o.id, o.intent_id INTO c FROM booking.external_operations o JOIN booking.intents i ON i.id = o.intent_id
     WHERE o.op_type = 'guest.notify' AND o.state = 'pending' AND i.listing_id = ANY (p_listing_ids) AND (p_intent IS NULL OR i.id = p_intent)
       AND NOT (o.id = ANY (skip)) AND booking.guest_notification_class(o.id) = 'ELIGIBLE'
     ORDER BY o.created_at, o.id LIMIT 1;
    IF c.id IS NULL THEN RETURN jsonb_build_object('status', 'idle'); END IF;
    skip := skip || c.id;
    IF NOT booking.gn_lock_bundle(c.intent_id, true) THEN CONTINUE; END IF;
    SELECT intent_id INTO w FROM booking.intent_work WHERE intent_id = c.intent_id
       AND (work_lease_until IS NULL OR work_lease_until < clock_timestamp()) FOR UPDATE SKIP LOCKED;
    IF w IS NULL THEN CONTINUE; END IF;
    PERFORM booking.gn_facts_advisory(c.intent_id);
    -- fresh READ COMMITTED statements after the locks
    IF booking.guest_notification_class(c.id) <> 'ELIGIBLE' THEN CONTINUE; END IF;
    v_t := clock_timestamp();
    IF EXISTS (SELECT 1 FROM booking.intent_work WHERE intent_id = c.intent_id AND work_lease_until >= v_t) THEN CONTINUE; END IF;
    UPDATE booking.intent_work SET work_worker_id = p_worker, work_lease_until = v_t + interval '120 seconds' WHERE intent_id = c.intent_id;
    RETURN jsonb_build_object('status', 'acquired', 'opId', c.id, 'intentId', c.intent_id, 'workLeaseUntil', v_t + interval '120 seconds');
  END LOOP;
  RETURN jsonb_build_object('status', 'idle');
END $$;`;
function probeSql(body, realName, probeName, after = null) {
  let sql = body.replace(`CREATE FUNCTION booking.${realName}(`, `CREATE OR REPLACE FUNCTION booking.${probeName}(`);
  assert.ok(sql.includes(probeName), "probe renamed");
  if (after) { assert.equal(sql.split(after).length, 2, `probe anchor once: ${after}`); sql = sql.replace(after, `${after}\n  ${BARRIER_SQL}`); }
  return sql;
}
async function injectBarrier(sig, after) {
  const def = (await one("SELECT pg_get_functiondef($1::regprocedure) AS d", [sig])).d;
  const md5 = (await one("SELECT md5(pg_get_functiondef($1::regprocedure)) AS m", [sig])).m;
  assert.equal(def.split(after).length, 2, `barrier anchor once in ${sig}`);
  await db.owner.query(def.replace(after, `${after}\n  ${BARRIER_SQL}`));
  return async () => {
    await db.owner.query(def);
    assert.equal((await one("SELECT md5(pg_get_functiondef($1::regprocedure)) AS m", [sig])).m, md5, `${sig} restored byte-identically`);
  };
}
/** the test holds the barrier exclusively; injected statements wait on it until release() */
async function barrier() {
  const B = await client(db.adminUrl);
  await B.query("SELECT pg_advisory_lock($1)", [BARRIER_KEY]);
  return { release: async () => { await B.query("SELECT pg_advisory_unlock($1)", [BARRIER_KEY]); await B.end(); } };
}
const hashOf = (email, first) => createHash("sha256").update(`gn-v1-recipient\n${email}\n${first}`, "utf8").digest("hex");

// =============================================================================================
test("positive lifecycle, all 3 templates (accepted-worker USD chains): ELIGIBLE → work → SQL snapshot → claim (render bound) → presend → accepted; one claim ever", async () => {
  for (const [mk, template, st] of [[confirmedBooking, "booking_confirmed", "confirmed"], [releasedBooking, "not_charged_authorization_may_show", "authorization_released"],
    [cancelledBooking, "not_completed_not_charged", "cancelled"]]) {
    const bk = await mk();
    assert.deepEqual([bk.op.state, bk.op.attempts, bk.op.payload.template, bk.op.idempotency_key], ["pending", 0, template, `notify:${bk.id}:${template}`]);
    assert.equal(await state(bk.id), st);
    assert.equal(await klass(bk.op.id), "ELIGIBLE", template);
    assert.equal(await refusal(bk.op.id), null, `${template} qualifies on accepted proofs`);
    const { s, c } = await acquireAndClaim(bk, "gn-w1");
    assert.equal(s.class, "ELIGIBLE"); assert.equal(s.code, null); assert.equal(s.template, template);
    // snapshot hashes are SQL-derived: re-derive them independently here from the SQL facts and the guest row
    const expectFacts = createHash("sha256").update(`gn-v1-facts\n${(await one("SELECT $1::jsonb::text AS t", [JSON.stringify(s.facts)])).t}`, "utf8").digest("hex");
    assert.equal(s.factsHash, expectFacts);
    const g = await one("SELECT email, first_name FROM booking.intent_guests WHERE intent_id = $1", [bk.id]);
    assert.equal(s.recipientHash, createHash("sha256").update(`gn-v1-recipient\n${g.email}\n${g.first_name}`, "utf8").digest("hex"));
    assert.equal(c.status, "claimed", JSON.stringify(c));
    const op1 = await notifyOf(bk.id);
    const rd = await one("SELECT * FROM booking.notification_renders WHERE operation_id = $1", [bk.op.id]);
    assert.deepEqual([op1.state, op1.attempts, op1.lease_worker_id, rd.worker, rd.intent_version, rd.content_hash, rd.facts_hash, rd.recipient_hash, rd.message_ref, rd.template],
      ["in_flight", 1, "gn-w1", "gn-w1", op1.source_version, SYN, s.factsHash, s.recipientHash, `gn1-${bk.op.id}`, template]);
    assert.equal(op1.dispatched_at.getTime(), rd.claimed_at.getTime(), "claim binding: dispatched_at = render claimed_at");
    const ps = await presend(bk.op.id, "gn-w1");
    assert.equal(ps.ok, true, JSON.stringify(ps)); assert.equal(ps.contentHash, SYN); assert.equal(ps.messageRef, `gn1-${bk.op.id}`);
    assert.equal(await complete(bk.op.id, "gn-w1", "accepted", `mock-msg-${laneN}`, null), "succeeded");
    const op2 = await notifyOf(bk.id);
    assert.deepEqual([op2.state, op2.attempts, op2.result_ref, op2.lease_worker_id], ["succeeded", 1, `mock-msg-${laneN}`, null]);
    assert.equal(await release(bk.id, "gn-w1"), "RELEASED");
    // one claim ever: no second acquisition / claim / completion path
    assert.equal((await work("gn-w2", bk)).status, "idle");
    assert.equal((await claim(bk.op.id, "gn-w1", s)).code, "NOT_PENDING");
    assert.equal(await complete(bk.op.id, "gn-w1", "accepted", "mock-again", null), "LEASE_LOST");
    assert.deepEqual(await all("SELECT kind FROM booking.reconciliation_cases WHERE intent_id = $1 AND status = 'open'", [bk.id]), []);
  }
});

test("addendum A — caller authority as the ACTUAL runtime role: raw claim / raw success refused even with a valid render; dedicated APIs work; generic helpers refuse", async () => {
  const bk = await confirmedBooking();
  const raw = (sql, p) => pgErr(() => db.app.query(sql, p));
  // raw pending -> in_flight (the app role HAS table UPDATE privilege, 0002:24–28): refused by the INVOKER fence
  let e = await raw("UPDATE booking.external_operations SET state = 'in_flight', attempts = 1, dispatched_at = now(), lease_worker_id = 'x', lease_until = now() + interval '1 minute' WHERE id = $1", [bk.op.id]);
  assert.equal(e.code, "42501"); assert.match(e.message, /^NOTIFY_CLAIM_AUTHORITY/);
  // the token table is unreadable / unwritable for the app role
  e = await raw("INSERT INTO booking.notification_write_authority VALUES (pg_current_xact_id(), $1, 'claim')", [bk.op.id]);
  assert.equal(e.code, "42501");
  e = await raw("SELECT 1 FROM booking.notification_write_authority", []);
  assert.equal(e.code, "42501");
  // no direct write on the audit tables
  e = await raw("INSERT INTO booking.notification_renders (operation_id) VALUES ($1)", [bk.op.id]);
  assert.equal(e.code, "42501");
  // generic claim never selects a notify row (opId given or not)
  assert.equal(await claimNextOperation(db.app, { workerId: "g", now: Date.now(), opId: bk.op.id }), null);
  assert.equal(await claimNextOperation(db.app, { workerId: "g", now: Date.now(), opTypes: ["guest.notify"] }), null);
  // the owner session without a token is refused too (the token, not is_privileged alone, is the API binding)
  e = await pgErr(() => db.owner.query("UPDATE booking.external_operations SET state = 'in_flight', attempts = 1, dispatched_at = now(), lease_worker_id = 'x', lease_until = now() + interval '1 minute' WHERE id = $1", [bk.op.id]));
  assert.match(e.message, /^NOTIFY_CLAIM_AUTHORITY: no claim token/);
  // dedicated claim works for the legitimate lease holder
  const { c } = await acquireAndClaim(bk, "gn-a1");
  assert.equal(c.status, "claimed");
  // raw in_flight -> succeeded with a VALID render present: refused
  e = await raw("UPDATE booking.external_operations SET state = 'succeeded', result_ref = 'mock-raw', completed_at = now(), lease_worker_id = NULL, lease_until = NULL WHERE id = $1", [bk.op.id]);
  assert.equal(e.code, "42501"); assert.match(e.message, /^NOTIFY_COMPLETE_AUTHORITY/);
  // generic success helper refuses; generic completion with failed_definite is refused by the fence (raw DB error, not mapped)
  assert.deepEqual(await completeOperation(db.app, bk.op.id, { workerId: "gn-a1", now: Date.now(), outcome: { status: "succeeded", resultRef: "mock-x" } }),
    { ok: false, error: "NOTIFY_SUCCESS_REQUIRES_DEDICATED_COMPLETION" });
  e = await pgErr(() => completeOperation(db.app, bk.op.id, { workerId: "gn-a1", now: Date.now(), outcome: { status: "failed_definite", errorCode: "X" } }));
  assert.match(e.message, /^NOTIFY_TRANSITION_REFUSED/);
  // same-state lease extension / attempts reset by the app role: refused
  e = await raw("UPDATE booking.external_operations SET lease_until = lease_until + interval '1 hour' WHERE id = $1", [bk.op.id]);
  assert.match(e.message, /^NOTIFY_OP_FROZEN/);
  e = await raw("UPDATE booking.external_operations SET state = 'pending', attempts = 1, lease_worker_id = NULL, lease_until = NULL WHERE id = $1", [bk.op.id]);
  assert.match(e.message, /^NOTIFY_TRANSITION_REFUSED/);
  e = await raw("UPDATE booking.external_operations SET source_version = source_version + 1 WHERE id = $1", [bk.op.id]);
  assert.match(e.message, /^NOTIFY_OP_FROZEN: source_version/);
  // wrong-worker completion: no write
  const d0 = await digest(bk);
  assert.equal(await complete(bk.op.id, "gn-other", "accepted", "mock-z", null), "LEASE_LOST");
  assert.equal(await digest(bk), d0);
  // shape refusals raise 22023 (never a latch)
  e = await pgErr(() => complete(bk.op.id, "gn-a1", "accepted", "not-a-mock-id", null)); assert.equal(e.code, "22023");
  e = await pgErr(() => complete(bk.op.id, "gn-a1", "unknown", null, "FREE_TEXT")); assert.equal(e.code, "22023");
  e = await pgErr(() => claim(bk.op.id, "bad worker!", { factsHash: SYN, recipientHash: SYN })); assert.equal(e.code, "22023");
  assert.equal(await digest(bk), d0);
  assert.equal(await complete(bk.op.id, "gn-a1", "accepted", "mock-ok-a", null), "succeeded");
  // outcome_unknown / succeeded rows are final for everyone in v1 (owner included)
  e = await pgErr(() => db.owner.query("UPDATE booking.external_operations SET state = 'pending' WHERE id = $1", [bk.op.id]));
  assert.match(e.message, /not allowed|^NOTIFY_TRANSITION_REFUSED/);
  // security / ACL boundary report (catalog)
  const fns = await all(`SELECT p.proname, p.prosecdef, p.proacl::text AS acl FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                          WHERE n.nspname = 'booking' AND (p.proname LIKE 'gn\\_%' OR p.proname LIKE '%notification%' OR p.proname LIKE 'notify\\_%') ORDER BY 1`);
  for (const f of fns) {
    assert.ok(f.acl !== null && !/(^|[{,])=X\//.test(f.acl), `${f.proname}: explicit ACL, no PUBLIC execute`);
    assert.ok(!(f.acl ?? "").includes("mv_booking_report"), `${f.proname}: report has nothing`);
  }
  const byName = Object.fromEntries(fns.map((f) => [f.proname, f]));
  assert.equal(byName.notify_op_fence.prosecdef, false, "fence is SECURITY INVOKER");
  assert.equal(byName.notify_claim_binding.prosecdef, false);
  assert.equal(byName.notification_evidence_lock.prosecdef, false);
  for (const n of ["claim_guest_notification", "complete_guest_notification", "claim_notification_work", "release_notification_work", "recover_expired_notifications",
    "guest_notification_presend", "guest_notification_snapshot", "latch_guest_notification", "list_guest_notifications", "guest_notification_summary"]) {
    assert.equal(byName[n].prosecdef, true, `${n} is SECURITY DEFINER`);
    assert.match(byName[n].acl, /mv_booking_app=X/, `${n}: app execute`);
  }
  console.log(`# 0016 function security map: ${JSON.stringify(fns.map((f) => [f.proname, f.prosecdef ? "DEFINER" : "INVOKER", f.acl]))}`);
});

test("R7 — one notify row per intent: E3 insertion + real replay, same-key direct INSERT, stale direct replay refused, unique index under concurrency (index isolated)", async () => {
  const bk = await confirmedBooking();
  assert.equal(await num("SELECT count(*) AS n FROM booking.external_operations WHERE intent_id = $1 AND op_type = 'guest.notify'", [bk.id]), 1);
  // real E3 replay of the producing event: applyEvent returns before any INSERT (duplicate)
  const ev = await one("SELECT event_id, event_type FROM booking.intent_transitions WHERE intent_id = $1 AND to_state = 'confirmed'", [bk.id]);
  const rep = await applyEvent(db.app, bk.id, { type: ev.event_type, id: ev.event_id, chargeId: (await one("SELECT offline_charge_id FROM booking.intents WHERE id = $1", [bk.id])).offline_charge_id },
    { now: Date.now(), actor: "worker" });
  assert.equal(rep.ok, true); assert.equal(rep.duplicate, true);
  // a same-key, canonical direct INSERT: the BEFORE fence passes, the arbiter absorbs it (DO NOTHING), no error
  const ins = (key, tpl, sv) => db.app.query(`INSERT INTO booking.external_operations (id, intent_id, op_type, idempotency_key, retry_class, state, payload, source_version,
      max_attempts, next_attempt_at, created_at, updated_at) VALUES (gen_random_uuid(), $1, 'guest.notify', $2, 'idempotent', 'pending', $3, $4, 5, now(), now(), now())
      ON CONFLICT (idempotency_key) DO NOTHING`, [bk.id, key, { template: tpl }, sv]);
  const v = (await one("SELECT version FROM booking.intents WHERE id = $1", [bk.id])).version;
  assert.equal((await ins(`notify:${bk.id}:booking_confirmed`, "booking_confirmed", v)).rowCount, 0);
  // stale same-key direct replay: the BEFORE fence runs before the arbiter and refuses (documented, not relaxed)
  let e = await pgErr(() => ins(`notify:${bk.id}:booking_confirmed`, "booking_confirmed", v - 1));
  assert.match(e.message, /^NOTIFY_INSERT_REFUSED: source version/);
  // a different template for this state is refused by the fence (state binding) before the index is reached
  e = await pgErr(() => ins(`notify:${bk.id}:not_completed_not_charged`, "not_completed_not_charged", v));
  assert.match(e.message, /^NOTIFY_INSERT_REFUSED/);
  e = await pgErr(() => ins(`notify:${bk.id}:booking_confirmed:x`, "booking_confirmed", v));
  assert.match(e.message, /^NOTIFY_INSERT_REFUSED: key/);
  // UNIQUE INDEX ISOLATED (TEST SETUP: owner sessions with triggers disabled, so ONLY the index decides): different-template rows
  const insRaw = (c, tpl, intentId) => c.query(`INSERT INTO booking.external_operations (id, intent_id, op_type, idempotency_key, retry_class, state, payload, source_version,
      max_attempts, next_attempt_at, created_at, updated_at) VALUES (gen_random_uuid(), $1, 'guest.notify', $2, 'idempotent', 'pending', $3, 0, 5, now(), now(), now())`,
  [intentId, `notify:${intentId}:${tpl}`, { template: tpl }]);
  e = await pgErr(() => F.ownerManagedHistory(db.owner, `INSERT INTO booking.external_operations (id, intent_id, op_type, idempotency_key, retry_class, state, payload, source_version,
      max_attempts, next_attempt_at, created_at, updated_at) VALUES (gen_random_uuid(), $1, 'guest.notify', $2, 'idempotent', 'pending', '{"template":"not_completed_not_charged"}', 0, 5, now(), now(), now())`,
  [bk.id, `notify:${bk.id}:not_completed_not_charged`]));
  assert.equal(e.code, "23505"); assert.equal(e.constraint, "external_operations_one_guest_notify");
  // concurrency on a SECOND intent with no notify row yet (an authorized intent): A inserts, B (different template) blocks; A commits → B 23505
  const w2 = world(); const b2 = await authorizedBooking(w2);
  for (const commitFirst of [true, false]) {
    const A = await client(db.adminUrl); const B = await client(db.adminUrl);
    try {
      for (const c of [A, B]) { await c.query("BEGIN"); await c.query("SET LOCAL session_replication_role = replica"); }
      await insRaw(A, "booking_confirmed", b2.id);
      const bp = insRaw(B, "not_charged_authorization_may_show", b2.id).then(() => "ok", (x) => x);
      assert.ok(await waitBlocked("INSERT INTO booking.external_operations"), "B waits on A's uncommitted index entry");
      if (commitFirst) {
        await A.query("COMMIT");
        const r = await bp; assert.equal(r.code, "23505"); assert.equal(r.constraint, "external_operations_one_guest_notify");
        await B.query("ROLLBACK");
        assert.equal(await num("SELECT count(*) AS n FROM booking.external_operations WHERE intent_id = $1 AND op_type = 'guest.notify'", [b2.id]), 1, "only A's committed TEST SETUP row");
        await F.ownerManagedHistory(db.owner, "DELETE FROM booking.external_operations WHERE intent_id = $1 AND op_type = 'guest.notify'", [b2.id]);   // TEST SETUP cleanup
      } else {
        await A.query("ROLLBACK");
        assert.equal(await bp, "ok", "A aborted → B proceeds");
        await B.query("ROLLBACK");
      }
    } finally { await A.end(); await B.end(); }
  }
  assert.equal(await num("SELECT count(*) AS n FROM booking.external_operations WHERE intent_id = $1 AND op_type = 'guest.notify'", [b2.id]), 0, "both aborted: none");
});

test("R9 — predicates: exact codes on legitimately added facts; fail-closed observed fields; id tie-break; scope / waiting never latch", async () => {
  const codeAfter = async (mk, add) => { const bk = await mk(); assert.equal(await refusal(bk.op.id), null); await add(bk); return { bk, code: await refusal(bk.op.id) }; };
  const far = (bk) => bk.base;                                                     // an observed_at older than every chain fact
  // C4: any open case (app role can open one)
  let r = await codeAfter(confirmedBooking, (bk) => db.app.query("INSERT INTO booking.reconciliation_cases (id, intent_id, kind, status, opened_at, opened_by) VALUES (gen_random_uuid(), $1, 'SOME_OWNER_CASE', 'open', now(), 'test')", [bk.id]));
  assert.equal(r.code, "OPEN_CASE");
  // C5: a refund row (any state)
  r = await codeAfter(confirmedBooking, (bk) => db.app.query(`INSERT INTO booking.payment_refunds (id, intent_id, seq, idempotency_key, amount_minor, currency, reason_code, requested_by, state, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, 1, $2, 100, 'USD', 'GUEST_REQUEST', 'admin', 'requested', now(), now())`, [bk.id, `ref:${bk.id}:1`]));
  assert.equal(r.code, "REFUND_PRESENT");
  // C7: a foreign PaymentIntent reference (API read of another PI)
  r = await codeAfter(confirmedBooking, (bk) => apiEvidence(bk.id, "payment_intent", "pi_test_foreign1", "canceled", {}, Date.now() - MIN));
  assert.equal(r.code, "FOREIGN_PAYMENT_INTENT");
  // K3: latest PI evidence owner-attested only → UNPROVEN; refund fields → CONTRADICTS / MALFORMED (older dashboard rows keep the API row latest)
  r = await codeAfter(confirmedBooking, (bk) => dashboard(bk.id, "payment_intent", bk.piId, "succeeded", { amountReceivedMinor: bk.total }, Date.now()));
  assert.equal(r.code, "PI_EVIDENCE_UNPROVEN");
  r = await codeAfter(confirmedBooking, (bk) => dashboard(bk.id, "payment_intent", bk.piId, "succeeded", { proofVersion: "pi-proof-v3", amountReceivedMinor: bk.total, currency: "USD" }, Date.now()));
  assert.equal(r.code, "PI_EVIDENCE_UNPROVEN", "owner attestation never qualifies a confirmation, whatever fields it carries");
  r = await codeAfter(confirmedBooking, (bk) => dashboard(bk.id, "payment_intent", bk.piId, "succeeded", { latestCharge: { refunded: true } }, far(bk)));
  assert.equal(r.code, "PI_EVIDENCE_CONTRADICTS");
  for (const bad of [{ latestCharge: { amountRefundedMinor: "0" } }, { latestCharge: { amountRefundedMinor: -1 } }, { latestCharge: { amountRefundedMinor: 1.5 } },
    { latestCharge: { amountRefundedMinor: 1e20 } }, { latestCharge: "not-an-object" }, { latestCharge: { refunded: "false" } }]) {
    r = await codeAfter(confirmedBooking, (bk) => dashboard(bk.id, "payment_intent", bk.piId, "succeeded", bad, far(bk)));
    assert.equal(r.code, "EVIDENCE_MALFORMED", JSON.stringify(bad));
  }
  // explicitly-optional ABSENT (JSON null) refund fields still qualify
  r = await codeAfter(confirmedBooking, (bk) => dashboard(bk.id, "payment_intent", bk.piId, "succeeded", { latestCharge: { amountRefundedMinor: null, refunded: null } }, far(bk)));
  assert.equal(r.code, null);
  // K5: a later cancelled reservation fact
  r = await codeAfter(confirmedBooking, async (bk) => dashboard(bk.id, "hostaway_reservation", (await loadIntent(db.app, bk.id)).reservation.reservationId, "cancelled", {}, Date.now()));
  assert.equal(r.code, "RESERVATION_CONTRADICTED");
  // A2: a succeeded / money-received PI fact on a "not charged" intent; malformed amount
  r = await codeAfter(releasedBooking, (bk) => dashboard(bk.id, "payment_intent", bk.piId, "succeeded", {}, far(bk)));
  assert.equal(r.code, "RELEASE_NOT_PROVEN");
  r = await codeAfter(releasedBooking, (bk) => dashboard(bk.id, "payment_intent", bk.piId, "canceled", { amountReceivedMinor: 5 }, far(bk)));
  assert.equal(r.code, "RELEASE_NOT_PROVEN");
  r = await codeAfter(releasedBooking, (bk) => dashboard(bk.id, "payment_intent", bk.piId, "canceled", { amountReceivedMinor: "x" }, far(bk)));
  assert.equal(r.code, "EVIDENCE_MALFORMED");
  // A2 latest-is-canceled + vacuous capture-dispatch floor: a still-authorized fact AFTER the canceled one → not proven
  r = await codeAfter(releasedBooking, (bk) => dashboard(bk.id, "payment_intent", bk.piId, "requires_capture", {}, Date.now()));
  assert.equal(r.code, "RELEASE_NOT_PROVEN");
  // X3: a later found_active reservation fact on a cancelled intent
  r = await codeAfter(cancelledBooking, async (bk) => { const i = await loadIntent(db.app, bk.id);
    return dashboard(bk.id, "hostaway_reservation", i.reservation.reservationId, "found_active", { listingId: bk.listingId, from: bk.stay.from, to: bk.stay.to, totalMinor: bk.total }, Date.now()); });
  assert.equal(r.code, "CANCEL_NOT_PROVEN");
  // C7 narrowed: the confirmed chain's Hostaway offline_charge_recorded ledger row (a charge id) never trips FOREIGN_PAYMENT_INTENT (positive chains above)
  // tie-break: two owner rows with IDENTICAL observed_at + created_at (one transaction) → the larger id is "latest", deterministically
  {
    const bk = await releasedBooking();
    const at = new Date(Date.now());
    const c = await db.reconciler.connect();
    try {
      await c.query("BEGIN");
      const ids = [];
      for (const st of ["canceled", "requires_capture"]) ids.push((await c.query("SELECT booking.admin_record_evidence($1, 'payment_intent', $2, $3, '{}', $4, 'owner', 'gn-tie') AS id", [bk.id, bk.piId, st, at])).rows[0].id);
      await c.query("COMMIT");
      const latest = (await one("SELECT booking.gn_latest_evidence($1, 'payment_intent', $2) AS id", [bk.id, bk.piId])).id;
      const want = [...ids].sort().pop();
      assert.equal(latest, want, "uuid tie-breaker");
      const st = (await one("SELECT status FROM booking.provider_evidence WHERE id = $1", [want])).status;
      assert.equal(await refusal(bk.op.id), st === "canceled" ? null : "RELEASE_NOT_PROVEN", "the refusal follows the same deterministic row");
    } finally { c.release(); }
  }
  // scope + waiting: never a latch, no write
  {
    const bk = await confirmedBooking({ guestDomain: "example.test" });
    assert.equal(await klass(bk.op.id), "OUT_OF_V1_SCOPE");
    assert.equal((await work("gn-s", bk)).status, "idle", "out-of-scope rows are not candidates");
    assert.equal(await refusal(bk.op.id), "RECIPIENT_OUT_OF_V1_SCOPE");
    const bk2 = await confirmedBooking();
    assert.equal((await work("gn-s2", bk2)).status, "acquired");             // a LIVE work lease, then the row becomes WAITING
    const s2 = await snapshot(bk2.op.id);
    await db.app.query(`INSERT INTO booking.stripe_webhook_events (event_id, event_type, livemode, stripe_created_at, intent_id, received_at, status)
                        VALUES ('evt_gn_wait_' || $2, 'charge.updated', false, now(), $1, now(), 'received')`, [bk2.id, laneN]);
    assert.equal(await klass(bk2.op.id), "WAITING");
    assert.equal((await work("gn-s", bk2)).status, "idle");
    assert.deepEqual(await claim(bk2.op.id, "gn-s2", s2), { status: "waiting", code: "WEBHOOK_UNPROCESSED" }, "a direct claim with the lease: waiting, never a latch");
    await db.app.query("UPDATE booking.stripe_webhook_events SET status = 'processed', processed_at = now() WHERE intent_id = $1", [bk2.id]);
    assert.equal(await klass(bk2.op.id), "ELIGIBLE", "WAITING clears once the event row is processed");
    assert.equal(await num("SELECT count(*) AS n FROM booking.notification_latches WHERE operation_id = ANY($1)", [[bk.op.id, bk2.op.id]]), 0);
  }
});

test("latch: a non-qualifying ELIGIBLE row is latched ONCE at the claim (SQL code), then excluded before LIMIT; SNAPSHOT_STALE never latches; RENDER_FAILED latch", async () => {
  const bk = await confirmedBooking();
  const wk = await work("gn-l1", bk); assert.equal(wk.status, "acquired");
  const s = await snapshot(bk.op.id);
  // a non-version fact change between snapshot and claim (owner evidence) → SNAPSHOT_STALE, no write, retryable
  await apiEvidence(bk.id, "payment_intent", bk.piId, "succeeded", { proofVersion: "pi-proof-v3", amountReceivedMinor: bk.total, currency: "USD", latestCharge: { amountRefundedMinor: 0 } }, Date.now());
  assert.equal(await refusal(bk.op.id), null, "the newer accepted PI evidence still qualifies");
  const st = await claim(bk.op.id, "gn-l1", s);
  assert.deepEqual(st, { status: "not_claimable", code: "SNAPSHOT_STALE" });
  assert.equal(await klass(bk.op.id), "ELIGIBLE");
  // a disqualifying fact → the retry latches with the SQL code
  await db.app.query("INSERT INTO booking.reconciliation_cases (id, intent_id, kind, status, opened_at, opened_by) VALUES (gen_random_uuid(), $1, 'SOME_OWNER_CASE', 'open', now(), 'test')", [bk.id]);
  const s2 = await snapshot(bk.op.id);
  assert.deepEqual(await claim(bk.op.id, "gn-l1", s2), { status: "latched", code: "OPEN_CASE" });
  assert.equal(await klass(bk.op.id), "LATCHED");
  const d0 = await digest(bk);
  assert.deepEqual(await claim(bk.op.id, "gn-l1", s2), { status: "not_claimable", code: "LATCHED" });
  assert.equal((await work("gn-l2", bk)).status, "idle");
  assert.equal(await digest(bk), d0, "latched: no further write");
  // lease / shape refusals do not latch
  const bk2 = await confirmedBooking();
  const s3 = await snapshot(bk2.op.id);
  assert.deepEqual(await claim(bk2.op.id, "gn-nolease", s3), { status: "not_claimable", code: "WORK_LEASE" });
  assert.equal(await klass(bk2.op.id), "ELIGIBLE");
  assert.equal((await work("gn-l3", bk2)).status, "acquired");
  assert.equal((await app1("SELECT booking.latch_guest_notification($1, 'gn-other', 'RENDER_FAILED') AS r", [bk2.op.id])).r, "WORK_LEASE");
  assert.equal((await pgErr(() => app1("SELECT booking.latch_guest_notification($1, 'gn-l3', 'OPEN_CASE') AS r", [bk2.op.id]))).code, "22023");
  assert.equal((await app1("SELECT booking.latch_guest_notification($1, 'gn-l3', 'RENDER_FAILED') AS r", [bk2.op.id])).r, "LATCHED");
  assert.equal((await one("SELECT code FROM booking.notification_latches WHERE operation_id = $1", [bk2.op.id])).code, "RENDER_FAILED");
  // append-only audit, even for the owner
  for (const sql of ["UPDATE booking.notification_latches SET code = 'X' WHERE operation_id = $1", "DELETE FROM booking.notification_latches WHERE operation_id = $1"]) {
    assert.ok(await pgErr(() => db.owner.query(sql, [bk2.op.id])));
  }
  assert.ok(await pgErr(() => db.owner.query("TRUNCATE booking.notification_latches")));
  assert.ok(await pgErr(() => db.owner.query("TRUNCATE booking.notification_renders")));
});

test("addendum B — observed lock waits, both commit orders: evidence (3 kinds, API + dashboard) vs claim / work / completion; guest purge vs claim; transition vs work acquisition", async () => {
  // (1) evidence insert holding the U1 advisory → the claim WAITS, then sees the committed evidence; reverse: a held claim makes the evidence trigger wait
  for (const kind of ["payment_intent", "hostaway_reservation", "hostaway_offline_charges"]) {
    for (const evidenceFirst of [true, false]) {
      const bk = await confirmedBooking();
      const i = await loadIntent(db.app, bk.id);
      const ref = kind === "payment_intent" ? bk.piId : i.reservation.reservationId;
      const observed = kind === "hostaway_offline_charges" ? { matchingChargeCount: 0, matchingChargeIds: [] } : {};
      const status = { payment_intent: "succeeded", hostaway_reservation: "found_active", hostaway_offline_charges: "listed" }[kind];
      const obs = kind === "hostaway_reservation" ? { listingId: bk.listingId, from: bk.stay.from, to: bk.stay.to, totalMinor: bk.total } : observed;
      assert.equal((await work("gn-b1", bk)).status, "acquired");
      const s = await snapshot(bk.op.id);
      const E = await client(db.adminUrl2()); const C = await client(db.appUrl());
      try {
        if (evidenceFirst) {
          await E.query("BEGIN");
          await E.query("SELECT booking.admin_record_evidence($1, $2, $3, $4, $5, $6, 'owner', 'gn-lock') AS id", [bk.id, kind, String(ref), status, obs, new Date(bk.base)]);
          const cp = C.query("SELECT booking.claim_guest_notification($1, 'gn-b1', 'gn-v1', $2, $3, $4) AS r", [bk.op.id, SYN, s.factsHash, s.recipientHash]);
          assert.ok(await waitBlocked("claim_guest_notification"), `${kind}: the claim waits on the evidence writer's advisory`);
          await E.query("COMMIT");
          const r = (await cp).rows[0].r;
          // the claim saw the committed evidence: facts changed (new evidence id) or still claimable — never decided on the pre-commit view
          assert.equal(r.status, "claimed", `${kind}: decided after the evidence commit (older observed_at: still qualifies) ${JSON.stringify(r)}`);
          assert.ok(await num("SELECT count(*) AS n FROM booking.provider_evidence WHERE intent_id = $1 AND reference = 'gn-lock'", [bk.id]) === 1);
        } else {
          await C.query("BEGIN");
          const r = (await C.query("SELECT booking.claim_guest_notification($1, 'gn-b1', 'gn-v1', $2, $3, $4) AS r", [bk.op.id, SYN, s.factsHash, s.recipientHash])).rows[0].r;
          assert.equal(r.status, "claimed");
          const ep = E.query("SELECT booking.admin_record_evidence($1, $2, $3, $4, $5, $6, 'owner', 'gn-lock') AS id", [bk.id, kind, String(ref), status, obs, new Date(bk.base)]);
          assert.ok(await waitBlocked("admin_record_evidence"), `${kind}: the evidence trigger waits on the held claim`);
          await C.query("COMMIT");
          assert.ok((await ep).rows[0].id);
          assert.equal((await notifyOf(bk.id)).state, "in_flight");
        }
      } finally { await E.end(); await C.end(); }
    }
  }
  // (2) API evidence path (record_provider_evidence) also waits on a held notification decision (completion here)
  {
    const bk = await confirmedBooking();
    const { c } = await acquireAndClaim(bk, "gn-b2"); assert.equal(c.status, "claimed");
    await requestRead(db.app, bk.id, "stripe.retrieve_payment_intent", bk.piId, { now: Date.now() });
    const rop = await claimNextOperation(db.app, { workerId: "gn-read", now: Date.now(), intentId: bk.id, opTypes: ["stripe.retrieve_payment_intent"] });
    F.ok(await completeOperation(db.app, rop.id, { workerId: "gn-read", now: Date.now(), outcome: { status: "succeeded", resultRef: bk.piId } }));
    const C = await client(db.appUrl()); const E = await client(db.appUrl());
    try {
      await C.query("BEGIN");
      assert.equal((await C.query("SELECT booking.complete_guest_notification($1, 'gn-b2', 'accepted', 'mock-b2', NULL) AS r", [bk.op.id])).rows[0].r, "succeeded");
      const ep = E.query("SELECT booking.record_provider_evidence($1, 'payment_intent', $2, 'succeeded', '{}', NULL) AS id", [rop.id, bk.piId]);
      assert.ok(await waitBlocked("record_provider_evidence"), "API evidence waits on the held completion");
      await C.query("COMMIT");
      assert.ok((await ep).rows[0].id);
    } finally { await C.end(); await E.end(); }
  }
  // (3) guest purge vs a held claim: the DELETE waits on the claim's KEY SHARE (authorization_released intent, aged — TEST SETUP ageIntent)
  {
    const bk = await releasedBooking();
    await F.ageIntent(db.owner, bk.id, 400);
    assert.equal((await work("gn-b3", bk)).status, "acquired");
    const s = await snapshot(bk.op.id);
    const C = await client(db.appUrl());
    try {
      await C.query("BEGIN");
      assert.equal((await C.query("SELECT booking.claim_guest_notification($1, 'gn-b3', 'gn-v1', $2, $3, $4) AS r", [bk.op.id, SYN, s.factsHash, s.recipientHash])).rows[0].r.status, "claimed");
      const pp = purgeGuestData(db.app, { retention: { failedAttemptDays: 30, postCheckoutDays: 30 } });
      assert.ok(await waitBlocked("purge_guest_data"), "purge waits on the claim's guest-row KEY SHARE");
      await C.query("COMMIT");
      assert.ok((await pp) >= 1);
    } finally { await C.end(); }
    // after the purge: pre-send refuses (recipient gone) → no invocation possible; the step would settle unknown(PRESEND_ABORTED_NOT_INVOKED)
    const ps = await presend(bk.op.id, "gn-b3");
    assert.equal(ps.ok, false); assert.equal(ps.code, "RECIPIENT_MISSING");
    assert.equal(await complete(bk.op.id, "gn-b3", "unknown", null, "PRESEND_ABORTED_NOT_INVOKED"), "outcome_unknown");
    assert.deepEqual((await all("SELECT kind, opened_by FROM booking.reconciliation_cases WHERE intent_id = $1 AND status = 'open'", [bk.id])).map((x) => [x.kind, x.opened_by]),
      [["NOTIFICATION_OUTCOME_UNKNOWN", `op:${bk.op.id}`]]);
  }
  // (4) a legal E3 transition holding the intent row during work acquisition → SKIP LOCKED skips (idle); after commit the drifted row is latched once
  {
    const bk = await releasedBooking();
    let release1; const gate = new Promise((r) => { release1 = r; });
    let entered; const inTx = new Promise((r) => { entered = r; });
    const tp = applyEvent(db.app, bk.id, { type: "PAYMENT_AUTHORIZED", id: "evt_gn_late_auth", paymentIntentId: "pi_test_gn_late", sessionId: "cs_test_gn_late", amountMinor: bk.total,
      currency: "usd", livemode: false, authorizationCreatedAt: Date.now(), captureBefore: Date.now() + DAY }, { now: Date.now(), actor: "webhook",
      hooks: { beforeCommit: async () => { entered(); await gate; } } });
    await inTx;
    assert.equal((await work("gn-b4", bk)).status, "idle", "the locked intent is skipped, nothing written");
    release1(); const tr = await tp; assert.equal(tr.ok, true);
    assert.equal(await state(bk.id), "reconciliation_required");
    assert.equal((await work("gn-b4", bk)).status, "acquired");
    const s = await snapshot(bk.op.id);
    const r = await claim(bk.op.id, "gn-b4", s);
    assert.equal(r.status, "latched"); assert.ok(["FOREIGN_PAYMENT_INTENT", "VERSION_DRIFT", "OPEN_CASE"].includes(r.code), r.code);
  }
});

test("addendum B — work acquisition / release wait on a held evidence insert; PROTECTED evidence committed during acquisition → no lease written", async () => {
  const holdEvidence = async (bk, kind, ref, status, observed) => {
    const E = await client(db.adminUrl2());
    await E.query("BEGIN");
    await E.query("SELECT booking.admin_record_evidence($1, $2, $3, $4, $5, $6, 'owner', 'gn-hold') AS id", [bk.id, kind, String(ref), status, observed, new Date(bk.base)]);
    return E;
  };
  // (a) benign evidence held → acquisition waits, then acquires after the commit
  const a = await confirmedBooking();
  let E = await holdEvidence(a, "payment_intent", a.piId, "succeeded", {});
  let wp = work("gn-q1", a);
  assert.ok(await waitBlocked("claim_notification_work"), "work acquisition waits on the U1 advisory");
  await E.query("COMMIT"); await E.end();
  assert.equal((await wp).status, "acquired");
  // release waits too
  E = await holdEvidence(a, "payment_intent", a.piId, "succeeded", {});
  const rp = release(a.id, "gn-q1");
  assert.ok(await waitBlocked("release_notification_work"), "release waits on the U1 advisory");
  await E.query("COMMIT"); await E.end();
  assert.equal(await rp, "RELEASED");
  // (b) PROTECTED reservation evidence committed while acquisition waits → the post-lock fresh re-check skips; nothing written
  const b = await releasedBooking();
  const d0 = await digest(b);
  E = await holdEvidence(b, "hostaway_reservation", PROTECTED[3], "not_found", {});
  wp = work("gn-q2", b);
  assert.ok(await waitBlocked("claim_notification_work"));
  await E.query("COMMIT"); await E.end();
  assert.equal((await wp).status, "idle", "protected became visible at the locked decision → skip");
  assert.equal(await digest(b), d0, "no work lease, no latch, no render");
  assert.equal(await klass(b.op.id), "PROTECTED");
  // a direct claim / latch on the protected row: protected result, still no write
  assert.deepEqual(await claim(b.op.id, "gn-q2", { factsHash: SYN, recipientHash: SYN }), { status: "protected" });
  assert.equal((await app1("SELECT booking.latch_guest_notification($1, 'gn-q2', 'RENDER_FAILED') AS r", [b.op.id])).r, "PROTECTED");
  assert.equal(await digest(b), d0);
});

test("R-C1 — snapshot: READ ONLY REPEATABLE READ required; purge / reinsert barrier DURING the observation: RED on the 01c6 body (A email + B hash), GREEN now (one row); a stale observation is SNAPSHOT_STALE", async () => {
  const bk0 = await confirmedBooking();
  for (const begin of [null, "BEGIN ISOLATION LEVEL REPEATABLE READ", "BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY", "BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY"]) {
    for (const sql of ["SELECT booking.guest_notification_snapshot($1) AS r", "SELECT booking.guest_notification_presend($1, 'gn-x') AS r"]) {
      const c = await db.app.connect();
      try {
        if (begin) await c.query(begin);
        const e = await pgErr(() => c.query(sql, [bk0.op.id]));
        assert.equal(e.code, "25000", `${begin}: ${sql}`); assert.match(e.message, /^NOTIFY_SNAPSHOT_CONTEXT/);
      } finally { await c.query("ROLLBACK").catch(() => {}); c.release(); }
    }
  }
  const retention = { retention: { failedAttemptDays: 30, postCheckoutDays: 30 } };
  const purgeReinsert = async (bk, email) => {
    await purgeGuestData(db.app, retention);
    assert.equal(await num("SELECT count(*) AS n FROM booking.intent_guests WHERE intent_id = $1", [bk.id]), 0, "guest A purged");
    await db.app.query(`INSERT INTO booking.intent_guests (intent_id, first_name, last_name, email, terms_version, terms_accepted_at, created_at)
                        VALUES ($1, 'Bea', 'Fixture', $2, 'terms-2026-10', now(), now())`, [bk.id, email]);           // synthetic guest B
  };
  // RED control: the 01c6 snapshot body (probe), barrier between its guest-row read and its SECOND, independent hash read
  const r1 = await releasedBooking(); await F.ageIntent(db.owner, r1.id, 400);
  const a1 = await one("SELECT email, first_name FROM booking.intent_guests WHERE intent_id = $1", [r1.id]);
  await db.owner.query(probeSql(OLD_SNAPSHOT, "guest_notification_snapshot", "gn_probe_snapshot_01c6", "SELECT * INTO g FROM booking.intent_guests WHERE intent_id = o.intent_id;"));
  let red; const emailB1 = `guest.reinsert1.n${laneN}@mv-test.invalid`;
  try {
    const B = await barrier();
    const pr = db.owner.query("SELECT booking.gn_probe_snapshot_01c6($1) AS r", [r1.op.id]);
    assert.ok(await waitBlocked("gn_probe_snapshot_01c6"));
    await purgeReinsert(r1, emailB1);
    await B.release();
    red = (await pr).rows[0].r;
  } finally { await db.owner.query("DROP FUNCTION IF EXISTS booking.gn_probe_snapshot_01c6(uuid)"); }
  assert.equal(red.email, a1.email, "RED: the returned email is guest A's");
  assert.equal(red.recipientHash, hashOf(emailB1, "Bea"), "RED (01c6): recipient hash of guest B");
  assert.notEqual(red.recipientHash, hashOf(red.email, red.firstName), "RED (01c6): A email / B hash returned together");
  // GREEN: the real function, same barrier (right after its context check), observation inside READ ONLY REPEATABLE READ
  const r2 = await releasedBooking(); await F.ageIntent(db.owner, r2.id, 400);
  assert.equal((await work("gn-rc1", r2)).status, "acquired");
  const a2 = await one("SELECT email, first_name FROM booking.intent_guests WHERE intent_id = $1", [r2.id]);
  const emailB2 = `guest.reinsert2.n${laneN}@mv-test.invalid`;
  const restore = await injectBarrier("booking.guest_notification_snapshot(uuid)", "PERFORM booking.gn_require_observation_context();");
  let green;
  try {
    const B = await barrier();
    const gp = snapshot(r2.op.id);
    assert.ok(await waitBlocked("guest_notification_snapshot"));
    await purgeReinsert(r2, emailB2);
    await B.release();
    green = await gp;
  } finally { await restore(); }
  assert.equal(green.email, a2.email, "GREEN: the whole observation is guest A (one snapshot)");
  assert.equal(green.recipientHash, hashOf(green.email, green.firstName), "GREEN: the hash is of exactly the returned row");
  const d0 = await digest(r2);
  assert.deepEqual(await claim(r2.op.id, "gn-rc1", green), { status: "not_claimable", code: "SNAPSHOT_STALE" }, "a stale recipient observation never becomes a claim");
  assert.equal(await digest(r2), d0);
  // non-racing positive control (the reinsert committed BEFORE the observation): consistent guest B, claimable
  const fresh = await snapshot(r2.op.id);
  assert.equal(fresh.recipientHash, hashOf(emailB2, "Bea"));
  assert.equal((await claim(r2.op.id, "gn-rc1", fresh)).status, "claimed");
});

test("R-C1 — pre-send: drift committed BEFORE the observation refuses; DURING it is the bounded-snapshot race; dbNow is taken at the END (RED on the 01c6 early clock)", async () => {
  const lateAuth = (bk) => applyEvent(db.app, bk.id, { type: "PAYMENT_AUTHORIZED", id: `evt_gn_late_${bk.id}`, paymentIntentId: `pi_test_late_${bk.id.slice(0, 8)}`,
    sessionId: "cs_test_gn_late", amountMinor: bk.total, currency: "usd", livemode: false, authorizationCreatedAt: Date.now(), captureBefore: Date.now() + DAY },
  { now: Date.now(), actor: "webhook" });
  const cases = [
    ["protection", confirmedBooking, (bk) => dashboard(bk.id, "hostaway_reservation", PROTECTED[3], "not_found", {}, Date.now()), "PROTECTED"],
    ["evidence", confirmedBooking, (bk) => apiEvidence(bk.id, "payment_intent", bk.piId, "succeeded", { proofVersion: "pi-proof-v3", amountReceivedMinor: bk.total, currency: "USD" }, Date.now()), "FACTS_CHANGED"],
    ["state", releasedBooking, (bk) => lateAuth(bk), "VERSION_DRIFT"],
    ["work lease", confirmedBooking, (bk) => release(bk.id, "gn-pd"), "LEASE_NOT_HELD"]];
  const restore = await injectBarrier("booking.guest_notification_presend(uuid,text)", "PERFORM booking.gn_require_observation_context();");
  try {
    for (const [kind, mk, drift, codeBefore] of cases) {
      // order 1: drift commits BEFORE the observation → refused (barrier not held: the injected statement passes immediately)
      const x = await mk(); assert.equal((await acquireAndClaim(x, "gn-pd")).c.status, "claimed");
      await drift(x);
      assert.equal((await presend(x.op.id, "gn-pd")).code, codeBefore, `${kind}: before`);
      // order 2: drift commits WHILE the observation is in progress → the observation is one snapshot (no mixed rows)
      const y = await mk(); assert.equal((await acquireAndClaim(y, "gn-pd")).c.status, "claimed");
      const B = await barrier();
      const pp = presend(y.op.id, "gn-pd");
      assert.ok(await waitBlocked("guest_notification_presend"));
      await drift(y);
      await B.release();
      const r = await pp;
      assert.equal(r.ok, true, `${kind}: during — bounded snapshot, the documented later race (${JSON.stringify(r)})`);
      if (kind === "protection") {
        const d = await digest(y);
        assert.equal(await complete(y.op.id, "gn-pd", "accepted", "mock-pd", null), "PROTECTED", "the next locked decision sees the protection: no write");
        assert.equal(await digest(y), d);
      }
    }
    // delayed check: dbNow is captured at the END of the checks (GREEN) …
    const z = await confirmedBooking(); assert.equal((await acquireAndClaim(z, "gn-pd")).c.status, "claimed");
    const B = await barrier();
    const zp = presend(z.op.id, "gn-pd");
    assert.ok(await waitBlocked("guest_notification_presend"));
    await sleep(1500); const tRel = Date.now(); await B.release();
    const rz = await zp;
    assert.equal(rz.ok, true); assert.ok(Date.parse(rz.dbNow) >= tRel - 100, "GREEN: dbNow after the delay (margin never overstated)");
  } finally { await restore(); }
  // … RED on the 01c6 body: dbNow taken BEFORE the delayed checks → an overstated margin
  const q = await confirmedBooking(); assert.equal((await acquireAndClaim(q, "gn-pd")).c.status, "claimed");
  await db.owner.query(probeSql(OLD_PRESEND, "guest_notification_presend", "gn_probe_presend_01c6", "v_t := clock_timestamp();"));
  try {
    const B = await barrier();
    const qp = db.owner.query("SELECT booking.gn_probe_presend_01c6($1, 'gn-pd') AS r", [q.op.id]);
    assert.ok(await waitBlocked("gn_probe_presend_01c6"));
    await sleep(1500); const tRel = Date.now(); await B.release();
    const rq = (await qp).rows[0].r;
    assert.equal(rq.ok, true); assert.ok(Date.parse(rq.dbNow) < tRel - 1000, "RED (01c6): dbNow before the delayed checks");
  } finally { await db.owner.query("DROP FUNCTION IF EXISTS booking.gn_probe_presend_01c6(uuid, text)"); }
});

test("R-C2 — work selection: 100 older rows with LIVE work leases + older waiting / latched / protected rows + 11 older NOT-YET-DUE rows never hide a free row (RED on the 01c6 selection)", async () => {
  const LST = 899500; const scope = [LST];
  const rows = [];
  for (let k = 0; k < 115; k++) rows.push(await releasedBooking({ listingId: LST }));
  // the 100 OLDEST rows: live work leases held by another worker (each call takes the oldest available row)
  for (let k = 0; k < 100; k++) {
    const r = await workIn("gn-holder", scope);
    assert.equal(r.opId, rows[k].op.id, `lease ${k}: oldest available first`);
  }
  const [wait, prot, latch] = rows.slice(100, 103); const futures = rows.slice(103, 114); const future = futures[0]; const free = rows[114];
  await db.app.query(`INSERT INTO booking.stripe_webhook_events (event_id, event_type, livemode, stripe_created_at, intent_id, received_at, status)
                      VALUES ($1, 'charge.updated', false, now(), $2, now(), 'received')`, [`evt_gn_rc2_${laneN}`, wait.id]);
  await dashboard(prot.id, "hostaway_reservation", PROTECTED[0], "not_found", {}, Date.now());
  assert.equal((await workIn("gn-latcher", scope, latch.id)).status, "acquired");
  await db.app.query("INSERT INTO booking.reconciliation_cases (id, intent_id, kind, status, opened_at, opened_by) VALUES (gen_random_uuid(), $1, 'SOME_OWNER_CASE', 'open', now(), 'test')", [latch.id]);
  assert.equal((await claim(latch.op.id, "gn-latcher", await snapshot(latch.op.id))).status, "latched");
  // TEST SETUP: 11 older rows not yet due (more than the 10 skips a call may spend)
  await F.ownerManagedHistory(db.owner, "UPDATE booking.external_operations SET next_attempt_at = now() + interval '1 day' WHERE id = ANY($1)", [futures.map((x) => x.op.id)]);
  assert.deepEqual(await Promise.all([wait, prot, latch].map((x) => klass(x.op.id))), ["WAITING", "PROTECTED", "LATCHED"]);
  const digests0 = await Promise.all(rows.slice(0, 114).map((x) => digest(x)));
  // RED control: the 01c6 selection (probe) returns idle — its 10 skips are spent on leased rows
  await db.owner.query(probeSql(OLD_WORK, "claim_notification_work", "gn_probe_work_01c6"));
  try { assert.deepEqual((await one("SELECT booking.gn_probe_work_01c6('gn-red', $1, NULL) AS r", [scope])).r, { status: "idle" }, "RED (01c6): free work hidden"); }
  finally { await db.owner.query("DROP FUNCTION IF EXISTS booking.gn_probe_work_01c6(text, integer[], uuid)"); }
  // GREEN: the free row is found
  const g = await workIn("gn-free", scope);
  assert.deepEqual([g.status, g.opId], ["acquired", free.op.id]);
  assert.deepEqual(await Promise.all(rows.slice(0, 114).map((x) => digest(x))), digests0, "leased / waiting / protected / latched / not-yet-due rows byte-unchanged");
  // optional intent narrowing
  assert.equal(await release(free.id, "gn-free"), "RELEASED");
  assert.equal((await workIn("gn-free", scope, rows[0].id)).status, "idle", "a leased row is not taken even when named");
  assert.equal((await workIn("gn-free", scope, future.id)).status, "idle", "a not-yet-due row is not taken");
  assert.equal((await workIn("gn-free", scope, free.id)).opId, free.op.id);
  assert.equal((await workIn("gn-free", [LST + 1])).status, "idle", "another scope sees nothing");
});

test("R8 — protection appearing AFTER a claim: no new notification write or invocation; audit unchanged; never re-claimed; summary counts only", async () => {
  const listing = [];
  // (a) after claim, before pre-send: owner dashboard reservation evidence with a protected ref
  const a = await confirmedBooking(); listing.push(a.listingId);
  assert.equal((await acquireAndClaim(a, "gn-p1")).c.status, "claimed");
  await dashboard(a.id, "hostaway_reservation", PROTECTED[0], "not_found", {}, Date.now());
  const da = await digest(a);
  assert.deepEqual(await presend(a.op.id, "gn-p1"), { ok: false, code: "PROTECTED" });
  assert.equal(await complete(a.op.id, "gn-p1", "unknown", null, "PRESEND_ABORTED_NOT_INVOKED"), "PROTECTED");
  assert.equal(await complete(a.op.id, "gn-p1", "accepted", "mock-p1", null), "PROTECTED");
  assert.equal(await release(a.id, "gn-p1"), "PROTECTED");
  assert.equal(await digest(a), da, "render / op / cases / work lease byte-identical");
  // (b) after "invocation", before completion: API read evidence whose read selector is a protected ref
  const b = await releasedBooking(); listing.push(b.listingId);
  assert.equal((await acquireAndClaim(b, "gn-p2")).c.status, "claimed");
  assert.equal((await presend(b.op.id, "gn-p2")).ok, true);
  await apiEvidence(b.id, "hostaway_reservation", PROTECTED[1], "not_found", {}, Date.now());
  const db0 = await digest(b);
  assert.equal(await complete(b.op.id, "gn-p2", "accepted", "mock-p2", null), "PROTECTED");
  assert.equal(await digest(b), db0);
  // protected rows are excluded from work / page; summary shows counts only
  for (const x of [a, b]) {
    assert.equal(await klass(x.op.id), "PROTECTED");
    assert.equal((await work("gn-p3", x)).status, "idle");
  }
  const page = (await db.app.query("SELECT * FROM booking.list_guest_notifications($1, NULL, 100)", [listing])).rows;
  assert.equal(page.length, 0, "protected rows are never returned");
  const sm = await summary(listing);
  assert.equal(sm.protectedClaimed, 2); assert.equal(sm.inFlight, 0);
  assert.ok(!JSON.stringify(sm).includes(a.op.id) && !JSON.stringify(sm).includes(a.id), "no ids in the summary");
  global.__gnProtected = { a, b, da, db0 };
});

test("expiry batch (one real 61 s wait; no lease manipulation): scoped maintenance → unknown + case; protected expired rows excluded before LIMIT; LEASE_LOST completion; generic markUnknown branch", async () => {
  const { a, b } = global.__gnProtected;
  // normal claimed rows: m1 (scoped maintenance), m2 (late completion), g1 (GENERIC recoverExpiredOperations; non-protected only — U2 residual pin)
  const m1 = await confirmedBooking(); const m2 = await releasedBooking(); const g1 = await cancelledBooking(); const m3 = await confirmedBooking();
  const p1 = await confirmedBooking(); const p2 = await confirmedBooking();
  for (const [x, wkr] of [[m1, "gn-e1"], [m2, "gn-e2"], [g1, "gn-e3"], [m3, "gn-e4"], [p1, "gn-e5"], [p2, "gn-e6"]]) assert.equal((await acquireAndClaim(x, wkr)).c.status, "claimed");
  const tClaims = Date.now();
  const dA = await digest(a); const dB = await digest(b);
  // R-C1 lease boundary: a pre-send check DELAYED across the op-lease expiry. RED (01c6 body, probe): ok:true with a dbNow before the
  // expiry although it returns after it. GREEN (real, barrier injected): LEASE_NOT_HELD (leases re-validated at the END of the checks).
  await sleep(Math.max(0, tClaims + 50 * SEC - Date.now()));
  await db.owner.query(probeSql(OLD_PRESEND, "guest_notification_presend", "gn_probe_presend_01c6", "v_t := clock_timestamp();"));
  const restoreP = await injectBarrier("booking.guest_notification_presend(uuid,text)", "PERFORM booking.gn_require_observation_context();");
  try {
    const B = await barrier();
    const pRed = db.owner.query("SELECT booking.gn_probe_presend_01c6($1, 'gn-e5') AS r", [p1.op.id]);
    const pGreen = presend(p2.op.id, "gn-e6");
    assert.ok(await waitBlocked("gn_probe_presend_01c6")); assert.ok(await waitBlocked("guest_notification_presend"));
    const lu1 = (await notifyOf(p1.id)).lease_until.getTime(); const lu2 = (await notifyOf(p2.id)).lease_until.getTime();
    await sleep(Math.max(0, Math.max(lu1, lu2) + 1500 - Date.now()));
    await B.release();
    const red = (await pRed).rows[0].r; const tRed = Date.now();
    const green = await pGreen;
    assert.equal(red.ok, true); assert.ok(Date.parse(red.dbNow) < lu1 && tRed > lu1, "RED (01c6): ok:true reported for a lease that expired before it returned");
    assert.deepEqual(green, { ok: false, code: "LEASE_NOT_HELD" }, "GREEN: lease re-validated at the end of the checks");
  } finally { await restoreP(); await db.owner.query("DROP FUNCTION IF EXISTS booking.gn_probe_presend_01c6(uuid, text)"); }
  await sleep(Math.max(0, tClaims + 61 * SEC - Date.now()));
  assert.equal((await presend(m2.op.id, "gn-e2")).code, "LEASE_NOT_HELD");
  assert.equal(await complete(m2.op.id, "gn-e2", "accepted", "mock-late", null), "LEASE_LOST");
  // protected noise is excluded BEFORE LIMIT: limit 1 over [a, b protected + m1] still processes m1; maintenance waits on a held evidence insert
  const lst = [a.listingId, b.listingId, m1.listingId];
  const E = await client(db.adminUrl2());
  await E.query("BEGIN");
  await E.query("SELECT booking.admin_record_evidence($1, 'payment_intent', $2, 'succeeded', '{}', $3, 'owner', 'gn-hold') AS id", [m1.id, m1.piId, new Date(m1.base)]);
  const rp = recover(lst, null, 1);
  assert.ok(await waitBlocked("recover_expired_notifications"), "scoped maintenance waits on the U1 advisory");
  await E.query("COMMIT"); await E.end();
  const r1 = await rp;
  assert.deepEqual(r1, { processed: 1, skippedLocked: 0, skippedProtected: 0 });
  assert.deepEqual([(await notifyOf(m1.id)).state, (await notifyOf(m1.id)).error_code], ["outcome_unknown", "LEASE_EXPIRED"]);
  assert.equal(await num("SELECT count(*) AS n FROM booking.reconciliation_cases WHERE intent_id = $1 AND kind = 'NOTIFICATION_OUTCOME_UNKNOWN' AND status = 'open' AND opened_by = $2", [m1.id, `op:${m1.op.id}`]), 1);
  assert.deepEqual(await recover(lst, null, 10), { processed: 0, skippedLocked: 0, skippedProtected: 0 });
  assert.equal(await digest(a), dA); assert.equal(await digest(b), dB, "protected expired rows: no write");
  // m3: protection committed WHILE maintenance waits (candidate chosen before; the post-lock fresh re-check sees it) → no write
  const E3 = await client(db.adminUrl2());
  await E3.query("BEGIN");
  await E3.query("SELECT booking.admin_record_evidence($1, 'hostaway_reservation', $2, 'not_found', '{}', $3, 'owner', 'gn-hold') AS id", [m3.id, PROTECTED[2], new Date(m3.base)]);
  const d3 = await digest(m3);
  const rp3 = recover([m3.listingId], m3.id, 5);
  assert.ok(await waitBlocked("recover_expired_notifications"));
  await E3.query("COMMIT"); await E3.end();
  assert.deepEqual(await rp3, { processed: 0, skippedLocked: 0, skippedProtected: 1 });
  assert.equal(await digest(m3), d3, "protected after the candidate read: no write");
  // m2 by scoped maintenance too
  assert.equal((await recover([m2.listingId], m2.id, 5)).processed, 1);
  // GENERIC helper on a NON-protected expired notify row: the D1 = A markUnknown branch → outcome_unknown + case, never pending
  const out = await recoverExpiredOperations(db.app, { now: Date.now(), opTypes: ["guest.notify"], intentId: g1.id });
  assert.deepEqual(out.map((x) => x.state), ["outcome_unknown"]);
  const gop = await notifyOf(g1.id);
  assert.deepEqual([gop.state, gop.attempts, gop.requires_provider_read], ["outcome_unknown", 1, false]);
  assert.equal(await num("SELECT count(*) AS n FROM booking.reconciliation_cases WHERE intent_id = $1 AND kind = 'NOTIFICATION_OUTCOME_UNKNOWN' AND status = 'open'", [g1.id]), 1);
  // unknown is durable: no existing owner path settles it
  const e1 = await pgErr(() => db.reconciler.query("SELECT booking.admin_resolve_operation($1, 'succeeded', ARRAY[]::uuid[], NULL, 'owner', 'X', now())", [gop.id]));
  assert.match(e1.message, /NOT_SUPPORTED|INSUFFICIENT|EVIDENCE/);
  const cs = await one("SELECT id FROM booking.reconciliation_cases WHERE intent_id = $1 AND kind = 'NOTIFICATION_OUTCOME_UNKNOWN'", [g1.id]);
  const e2 = await pgErr(() => db.reconciler.query("SELECT booking.admin_close_case($1, ARRAY[]::uuid[], 'owner', 'X', now())", [cs.id]));
  assert.match(e2.message, /OPERATION_CASE_USE_ADMIN_RESOLVE_OPERATION/);
  const e3 = await pgErr(() => db.owner.query("UPDATE booking.external_operations SET state = 'pending', lease_worker_id = NULL, lease_until = NULL WHERE id = $1", [gop.id]));
  assert.match(e3.message, /^NOTIFY_TRANSITION_REFUSED/, "outcome_unknown -> pending refused even for the owner session");
  // never re-claimed by anyone
  for (const x of [m1, m2, g1]) { assert.equal((await work("gn-e9", x)).status, "idle"); assert.equal(await claimNextOperation(db.app, { workerId: "g", now: Date.now(), opId: x.op.id }), null); }
});

test("page + summary: precision-safe immutable-lookup cursor (equal created_at), invalid / out-of-scope cursor, scope validation, report role has nothing", async () => {
  // two released bookings whose producing transition used the SAME injected clock value → equal created_at
  const w1 = world(); const b1 = await authorizedBooking(w1); const L1 = lane(w1, b1);
  const w2 = world(); const b2 = await authorizedBooking(w2); const L2 = lane(w2, b2);
  w1.nightly += 25; w2.nightly += 25; await L1.R(); await L2.R();
  const t = Math.min(L1.clk.t, L2.clk.t) + 2 * MIN; L1.clk.t = t; L2.clk.t = t;
  await L1.K(); await L2.K();
  assert.equal(await state(b1.id), "authorization_released"); assert.equal(await state(b2.id), "authorization_released");
  const ops = await all("SELECT id, created_at FROM booking.external_operations WHERE op_type = 'guest.notify' AND intent_id = ANY($1) ORDER BY created_at, id", [[b1.id, b2.id]]);
  assert.equal(ops[0].created_at.getTime(), ops[1].created_at.getTime(), "equal created_at (fixture)");
  const scope = [b1.listingId, b2.listingId];
  const p1 = (await db.app.query("SELECT * FROM booking.list_guest_notifications($1, NULL, 1)", [scope])).rows;
  assert.deepEqual(p1.map((x) => x.op_id), [ops[0].id]);
  const p2 = (await db.app.query("SELECT * FROM booking.list_guest_notifications($1, $2, 1)", [scope, p1[0].op_id])).rows;
  assert.deepEqual(p2.map((x) => x.op_id), [ops[1].id], "no duplicate, no gap on equal created_at");
  assert.equal((await db.app.query("SELECT * FROM booking.list_guest_notifications($1, $2, 1)", [scope, p2[0].op_id])).rows.length, 0);
  assert.deepEqual(Object.keys(p1[0]).sort(), ["class", "code", "created_at", "intent_id", "op_id", "state", "template"], "no hashes, no guest data");
  for (const [args, why] of [[[scope, "00000000-0000-4000-8000-000000000000", 1], "unknown cursor"], [[[b1.listingId], (await notifyOf(b2.id)).id, 1], "out-of-scope cursor (an op of b2 under b1's scope)"],
    [[[], null, 1], "empty scope"], [[[b1.listingId, b1.listingId], null, 1], "duplicate scope"], [[scope, null, 0], "limit"], [[scope, null, 101], "limit"]]) {
    const e = await pgErr(() => db.app.query("SELECT * FROM booking.list_guest_notifications($1, $2, $3)", args));
    assert.equal(e.code, "22023", why);
  }
  const sm = await summary(scope);
  assert.equal(sm.eligible, 2);
  assert.deepEqual((await db.reconciler.query("SELECT booking.guest_notification_summary($1) AS r", [scope])).rows[0].r, sm, "admin reads the same counts");
  const rep = new pg.Client({ connectionString: db.reportUrl() }); await rep.connect();
  try {
    for (const sql of ["SELECT booking.guest_notification_summary(ARRAY[1])", "SELECT * FROM booking.list_guest_notifications(ARRAY[1], NULL, 1)",
      "SELECT 1 FROM booking.notification_renders", "SELECT 1 FROM booking.notification_latches", "SELECT booking.claim_notification_work('r', ARRAY[1], NULL)"]) {
      const e = await pgErr(() => rep.query(sql)); assert.equal(e.code, "42501", sql);
    }
  } finally { await rep.end(); }
});

test("attempt-row changes serialise with notification decisions (bundle attempt SHARE), both commit orders; a late protected create id is unreachable for notify-bearing intents", async () => {
  // accepted paths record the create result BEFORE any terminal state, and recordHostawayCreateResult only touches responded_at IS NULL rows
  // (repo.js:617–627): a notify-bearing intent's attempt reference cannot change later. The lock bundle still serialises every attempt-row writer.
  const bk = await confirmedBooking();
  const att = await one("SELECT responded_at, hostaway_reservation_id FROM booking.hostaway_reservation_attempts WHERE intent_id = $1", [bk.id]);
  assert.ok(att.responded_at !== null && att.hostaway_reservation_id !== null, "create result recorded before confirmation");
  assert.deepEqual(await recordHostawayCreateResult(db.app, bk.id, { httpStatus: 201, reservation: { reservationId: PROTECTED[2], listingId: bk.listingId, from: bk.stay.from,
    to: bk.stay.to, totalMinor: bk.total } }, { now: Date.now() }), { recorded: false }, "a late create result cannot rewrite the reference");
  assert.equal(await klass(bk.op.id), "ELIGIBLE");
  assert.equal((await work("gn-r1", bk)).status, "acquired");
  const s = await snapshot(bk.op.id);
  // order 1: a held claim → an attempt-row writer (accepted recordHostawayLookup) waits on the attempt SHARE lock
  const C = await client(db.appUrl());
  try {
    await C.query("BEGIN");
    assert.equal((await C.query("SELECT booking.claim_guest_notification($1, 'gn-r1', 'gn-v1', $2, $3, $4) AS r", [bk.op.id, SYN, s.factsHash, s.recipientHash])).rows[0].r.status, "claimed");
    const up = recordHostawayLookup(db.app, bk.id, { result: "found" }, { now: Date.now() });
    assert.ok(await waitBlocked("hostaway_reservation_attempts"), "the attempt UPDATE waits on the claim's bundle lock");
    await C.query("COMMIT");
    await up;
  } finally { await C.end(); }
  // order 2: a held attempt-row write → completion waits, then decides on the committed row
  const A = await client(db.appUrl());
  try {
    await A.query("BEGIN");
    await A.query("UPDATE booking.hostaway_reservation_attempts SET lookup_count = lookup_count + 1, updated_at = now() WHERE intent_id = $1", [bk.id]);
    const cp = complete(bk.op.id, "gn-r1", "accepted", "mock-r1", null);
    assert.ok(await waitBlocked("complete_guest_notification"), "completion waits on the held attempt-row write");
    await A.query("COMMIT");
    assert.equal(await cp, "succeeded");
  } finally { await A.end(); }
});

test("whole suite: no provider network attempt; protected ids only in fixture references", async () => {
  assert.equal(netAttempts, 0);
  assert.equal(await num("SELECT count(*) AS n FROM booking.notification_renders r JOIN booking.intents i ON i.id = r.intent_id WHERE i.hostaway_reservation_id = ANY($1)", [PROTECTED]), 0);
  // the transaction-scoped write tokens never outlive their transaction (success, refusal and error paths all ran above)
  assert.equal(await num("SELECT count(*) AS n FROM booking.notification_write_authority"), 0);
  assert.equal(await num("SELECT count(*) AS n FROM pg_proc WHERE proname LIKE 'gn\\_probe\\_%'"), 0, "no test probe left behind");
});

// =============================================================================================
// migration up / down (separate disposable clusters)
// C39 (test-only): the chain no longer ends at 0016. Expectations are DERIVED from the migration files in this tree (accepted C26 exact-boundary
// pattern) and re-checked against the bookkeeping table at every boundary — never "whatever came back". Boundary 15 (below 0016) and boundary 16
// (0016 applied, everything later rolled back) are each built FORWARD in their own fresh disposable cluster and compared with the rolled-back
// catalog, so a down from the top is proven equal to a forward build rather than to its own renamed catalog. Every original 0016 safety case is kept.
const MIGRATION_VERSIONS = loadMigrations().map((m) => m.version); const TOP = MIGRATION_VERSIONS.at(-1);
assert.deepEqual(MIGRATION_VERSIONS, Array.from({ length: TOP }, (_, i) => i + 1), "contiguous migration chain 1..TOP");
assert.ok(TOP >= 16, "0016 is part of the chain");
const range = (from, to) => (from <= to ? Array.from({ length: to - from + 1 }, (_, i) => from + i) : Array.from({ length: from - to + 1 }, (_, i) => from - i));
const history = async (c) => { const st = await migrationStatus(c, { env: "test" }); return [st.applied, st.pending]; };
/** original fence catalog: function bodies + ACLs, triggers, indexes, relations (ACL / RLS), policies — unchanged comparison surface */
const fenceCatalog = async (c) => (await c.query(`
    SELECT 'f:' || p.oid::regprocedure::text || ':' || md5(pg_get_functiondef(p.oid)) || ':' || coalesce(p.proacl::text, '') AS k FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'booking'
    UNION ALL SELECT 't:' || c.relname || ':' || t.tgname || ':' || md5(pg_get_triggerdef(t.oid)) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'booking' AND NOT t.tgisinternal
    UNION ALL SELECT 'i:' || indexname || ':' || md5(indexdef) FROM pg_indexes WHERE schemaname = 'booking'
    UNION ALL SELECT 'r:' || c.relname || ':' || c.relkind::text || ':' || coalesce(c.relacl::text, '') || ':' || c.relrowsecurity::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'booking'
    UNION ALL SELECT 'p:' || tablename || ':' || policyname || ':' || md5(coalesce(qual, '') || coalesce(with_check, '') || roles::text) FROM pg_policies WHERE schemaname = 'booking'
    ORDER BY 1`)).rows.map((r) => r.k);
/** C26 full schema shape (bodies / ACLs / security / volatility / search_path / triggers / columns / grants / policies / constraints / indexes / RLS) */
const schemaObjects = async (c) => (await c.query(`
      SELECT 'fn|' || p.oid::regprocedure::text || '|' || md5(pg_get_functiondef(p.oid)) || '|' || coalesce(array_to_string(p.proacl, ','), '') || '|' ||
             p.prosecdef::text || '|' || p.provolatile::text || '|' || coalesce(array_to_string(p.proconfig, ','), '') AS o FROM pg_proc p WHERE p.pronamespace = 'booking'::regnamespace
      UNION ALL SELECT 'trg|' || tgrelid::regclass::text || '|' || tgname || '|' || pg_get_triggerdef(oid) FROM pg_trigger WHERE NOT tgisinternal AND tgrelid::regclass::text LIKE 'booking.%'
      UNION ALL SELECT 'col|' || table_name || '|' || column_name || '|' || data_type || '|' || is_nullable FROM information_schema.columns WHERE table_schema = 'booking'
      UNION ALL SELECT 'tbl|' || grantee || '|' || table_name || '|' || privilege_type FROM information_schema.role_table_grants WHERE table_schema = 'booking'
      UNION ALL SELECT 'pol|' || tablename || '|' || policyname || '|' || array_to_string(roles, ',') || '|' || cmd FROM pg_policies WHERE schemaname = 'booking'
      UNION ALL SELECT 'con|' || conrelid::regclass::text || '|' || conname || '|' || pg_get_constraintdef(oid) FROM pg_constraint WHERE connamespace = 'booking'::regnamespace
      UNION ALL SELECT 'idx|' || indexrelid::regclass::text || '|' || pg_get_indexdef(indexrelid) FROM pg_index WHERE indrelid::regclass::text LIKE 'booking.%'
      UNION ALL SELECT 'rls|' || relname || '|' || relrowsecurity::text FROM pg_class WHERE relnamespace = 'booking'::regnamespace AND relkind = 'r'
      ORDER BY 1`)).rows.map((r) => r.o);
/** a dedicated disposable cluster migrated UP to exactly N (the boundary built forward, never by rolling back) */
async function freshAt(n) {
  const d = await startPostgres(); const c = new pg.Client({ connectionString: d.adminUrl }); await c.connect();
  try {
    assert.deepEqual(await migrateUp(c, { env: "test", to: n }), range(1, n), `fresh cluster migrated up to ${n}`);
    assert.deepEqual(await history(c), [range(1, n), range(n + 1, TOP)], `fresh history at ${n}`);
  } catch (e) { await c.end(); d.stop(); throw e; }
  return { c, close: async () => { await c.end(); d.stop(); } };
}
/** exact rollback from the current top to boundary N: descending list TOP..N+1 + exact history */
async function downToBoundary(c, n) {
  assert.deepEqual(await migrateDown(c, { env: "test", to: n }), range(TOP, n + 1), `every migration above ${n} rolls back (exact list)`);
  assert.deepEqual(await history(c), [range(1, n), range(n + 1, TOP)], `history at boundary ${n}`);
}
/** exact re-up from boundary N: ascending list N+1..TOP + full history */
async function upFromBoundary(c, n) {
  assert.deepEqual(await migrateUp(c, { env: "test" }), range(n + 1, TOP), `re-up from ${n} applies exactly the rest of the chain`);
  assert.deepEqual(await history(c), [range(1, TOP), []], "history at top");
}

test("0016 up precondition (legacy duplicate / attempted / in_flight / non-canonical rows), audit-preserving refused down, exact fresh-0015 down, identical re-up, JS compatibility", async () => {
  const m = await startMigratedDatabase();
  const admin = new pg.Client({ connectionString: m.adminUrl }); await admin.connect();
  let fresh15c = null, fresh16c = null;
  try {
    assert.deepEqual(await history(admin), [range(1, TOP), []], "migrated cluster starts at the top of the chain");
    const atTop = await fenceCatalog(admin), atTopShape = await schemaObjects(admin);
    // (a) exact down to boundary 15 == a SEPARATE fresh cluster migrated UP to 15 (every later migration, 0016 included, is mechanical with no data)
    fresh15c = await freshAt(15);
    await downToBoundary(admin, 15);
    const fresh15 = await fenceCatalog(admin);
    assert.ok(fresh15.length < atTop.length);
    assert.deepEqual(fresh15, await fenceCatalog(fresh15c.c), "down to 15 == forward-built 15 (functions / ACL / triggers / indexes / relations / policies)");
    assert.deepEqual(await schemaObjects(admin), await schemaObjects(fresh15c.c), "down to 15 == forward-built 15 (full schema shape)");
    // (b) exact re-up reproduces the TOP schema; exact down again reproduces 15
    await upFromBoundary(admin, 15);
    assert.deepEqual(await fenceCatalog(admin), atTop, "identical re-up");
    assert.deepEqual(await schemaObjects(admin), atTopShape, "identical re-up (full shape)");
    await downToBoundary(admin, 15);
    assert.deepEqual(await fenceCatalog(admin), fresh15, "allowed down: exact fresh-0015 definitions / ACL / triggers / indexes / policies");
    // (c) boundary 16 built forward in its own fresh cluster — the reference for everything "at 0016" below (NOT the TOP snapshot)
    fresh16c = await freshAt(16);
    const at16 = await fenceCatalog(fresh16c.c);
    // legacy rows on 0015 (TEST SETUP, triggers bypassed for planting only); each refuses the 0016 up, rows unchanged, nothing applied
    const appPool = m.app;
    const newIntent = async () => (await createIntentRecord(appPool, { ref: F.nextRef(), accessTokenHash: F.tokenHash(), environment: "test", now: Date.now(), listingId: 999001,
      from: "2027-01-10", to: "2027-01-12", guests: 2 })).id;
    // ids are generated uuids (no user input): inlined to keep one statement per TEST SETUP write
    const ins = (id, tpl, { key = `notify:${id}:${tpl}`, attempts = 0 } = {}) => `INSERT INTO booking.external_operations (id, intent_id, op_type, idempotency_key, retry_class,
       state, payload, source_version, max_attempts, attempts, next_attempt_at, created_at, updated_at) VALUES (gen_random_uuid(), '${id}', 'guest.notify', '${key}', 'idempotent',
       'pending', '{"template":"${tpl}"}', 0, 5, ${attempts}, now(), now(), now())`;
    const cases = [
      ["duplicate", (id) => [ins(id, "booking_confirmed"), ins(id, "not_completed_not_charged")], "NOTIFY_UPGRADE_DUPLICATE"],
      ["attempted", (id) => [ins(id, "booking_confirmed", { attempts: 1 })], "NOTIFY_UPGRADE_PRECONDITION"],
      ["in_flight", (id) => [ins(id, "booking_confirmed"), `UPDATE booking.external_operations SET state = 'in_flight', attempts = 1, dispatched_at = now(), lease_worker_id = 'old',
          lease_until = now() WHERE intent_id = '${id}' AND op_type = 'guest.notify'`], "NOTIFY_UPGRADE_PRECONDITION"],
      ["non-canonical key", (id) => [ins(id, "booking_confirmed", { key: `notify-legacy:${id}` })], "NOTIFY_UPGRADE_PRECONDITION"]];
    for (const [label, rows, code] of cases) {
      const id = await newIntent();
      for (const sql of rows(id)) await F.ownerManagedHistory(m.owner, sql);   // TEST SETUP: legacy rows planted with triggers bypassed
      const before = (await admin.query("SELECT md5(string_agg(row_to_json(o)::text, '|' ORDER BY o.id)) AS d FROM booking.external_operations o WHERE intent_id = $1", [id])).rows[0].d;
      const e = await pgErr(() => migrateUp(admin, { env: "test" }));
      assert.match(e.message, new RegExp(`^${code}`), label);
      assert.equal((await admin.query("SELECT md5(string_agg(row_to_json(o)::text, '|' ORDER BY o.id)) AS d FROM booking.external_operations o WHERE intent_id = $1", [id])).rows[0].d, before, `${label}: rows unchanged`);
      assert.deepEqual(await fenceCatalog(admin), fresh15, `${label}: nothing of 0016 left behind`);
      assert.deepEqual(await history(admin), [range(1, 15), range(16, TOP)], `${label}: 0016 refused first, nothing later applied`);
      await F.ownerManagedHistory(m.owner, `DELETE FROM booking.external_operations WHERE intent_id = '${id}' AND op_type = 'guest.notify'`);   // TEST SETUP cleanup
    }
    // JS compatibility after an allowed SQL down: the generic claim still never selects a pending notify row
    const okId = await newIntent();
    await F.ownerManagedHistory(m.owner, ins(okId, "booking_confirmed"));
    const nop = (await admin.query("SELECT id FROM booking.external_operations WHERE intent_id = $1 AND op_type = 'guest.notify'", [okId])).rows[0].id;
    assert.equal(await claimNextOperation(appPool, { workerId: "compat", now: Date.now() + DAY, opId: nop }), null, "JS NOTIFY_FENCE survives the SQL down");
    // up over a canonical pending legacy row succeeds (exactly 16..TOP, full history, TOP schema reproduced)
    await upFromBoundary(admin, 15);
    assert.deepEqual(await fenceCatalog(admin), atTop, "up over a canonical legacy row reproduces the TOP schema");
    // a render makes the 0016 down refuse and keeps the audit byte-equal. Each migration rolls back in its own transaction, so the later
    // migrations (TOP..17) come down first and 0016 refuses: the cluster must then stand EXACTLY at boundary 16 — compared with the
    // forward-built 16, not with the TOP snapshot.
    await F.ownerManagedHistory(m.owner, `INSERT INTO booking.notification_renders (operation_id, intent_id, template, template_version, intent_version, facts, facts_hash, recipient_hash,
       content_hash, message_ref, worker, claimed_at) VALUES ($1, (SELECT intent_id FROM booking.external_operations WHERE id = $1), 'booking_confirmed', 'gn-v1', 0, '{}', $2, $2, $2, 'gn1-' || $1::text, 'w', now())`, [nop, SYN]);
    const audit0 = (await admin.query("SELECT md5(string_agg(row_to_json(r)::text, '|')) AS d FROM booking.notification_renders r")).rows[0].d;
    const e = await pgErr(() => migrateDown(admin, { env: "test", to: 15 }));
    assert.match(e.message, /^MIGRATION_0016_DOWN_REFUSED/);
    assert.equal((await admin.query("SELECT md5(string_agg(row_to_json(r)::text, '|')) AS d FROM booking.notification_renders r")).rows[0].d, audit0, "refused down preserves the audit");
    assert.deepEqual(await history(admin), [range(1, 16), range(17, TOP)], "later migrations rolled back, 0016 refused and still applied");
    assert.deepEqual(await fenceCatalog(admin), at16, "refused 0016 down leaves exactly the forward-built 0016 catalog");
    assert.deepEqual(await schemaObjects(admin), await schemaObjects(fresh16c.c), "refused 0016 down leaves exactly the forward-built 0016 schema (full shape)");
    // and the chain re-ups from 16 to the exact TOP schema again
    await upFromBoundary(admin, 16);
    assert.deepEqual(await fenceCatalog(admin), atTop);
    assert.deepEqual(await schemaObjects(admin), atTopShape);
  } finally {
    if (fresh16c) await fresh16c.close();
    if (fresh15c) await fresh15c.close();
    await admin.end(); await m.close();
  }
});
