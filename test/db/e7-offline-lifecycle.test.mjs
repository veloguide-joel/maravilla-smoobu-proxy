// Stage E7 — OFFLINE LIFECYCLE REHEARSAL (tests only). The four accepted workers — reservation (E7.2), capture (E7.3b), recording
// (E7.4b) and compensation (E7.4a) — hand off on the SAME disposable-PostgreSQL booking through coherent INJECTED MOCK provider worlds.
// Report: claude/e7-offline-lifecycle-rehearsal.md.
//
// TRUST / SHAPE LABELS
//   * Every Hostaway / Stripe object below is a SYNTHETIC, DOC-DERIVED, LIVE-UNVERIFIED mock built in this file; nothing reaches a provider,
//     no SDK / client / adapter / credential / environment secret is used. A mock only reports facts that the same mock world actually did
//     (the reservation it created, the capture it applied, the charge it stored).
//   * 'acct-test-1' / 'client-LC' are TRUST labels (never authentication); the Stripe account id is a FIXTURE string; 'credit_card' and
//     'other' are FIXTURE paymentMethod values (no owner choice / default is implied). USD only.
//   * The chain starts from a fresh payment_authorized booking built with the reviewed repo functions (create / price / guest details / pay
//     step / mocked authorization, exactly as the E7.2 suite does). No F.reserved / F.captured / F.confirmed, no manufactured success
//     event, evidence, assessment or claim audit: every later fact is written by the accepted workers.
//   * Clocks: the reservation / capture / compensation workers take an injected clock that starts 20 minutes BEFORE the real time and is
//     only advanced (never past the real time), so every fact they stamp precedes the DB clock; the recording worker uses the real clock
//     (its W-5 skew check). Labelled TEST SETUP 'due()' only makes an intent's work row due / free between bounded recording steps in this
//     disposable cluster; max_attempts, backoff, fences and triggers are never changed or bypassed.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startMigratedDatabase } from "./harness.mjs";
import * as F from "./fixtures.mjs";
import { applyEvent, loadIntent, createIntentRecord, collectGuestDetails, beginPayStep, recordCheckoutSession } from "../../lib/booking-db/repo.js";
import { claimNextOperation, completeOperation } from "../../lib/booking-db/operations.js";
import { runOrchestratorStep, PROTECTED_HOSTAWAY_RESERVATION_IDS } from "../../lib/booking-db/reservation-worker.js";
import { runCaptureStep } from "../../lib/booking-db/capture-worker.js";
import { runRecordingStep } from "../../lib/booking-db/recording-worker.js";
import { runCleanupStep } from "../../lib/booking-db/compensation-worker.js";
import { priceStay } from "../../lib/checkout/server-pricer.js";
import { readDirectPolicyFromEnv } from "../../lib/direct-policy.js";
import { todayInTimeZone } from "../../lib/public-api.js";
import { validateAdapterConfig } from "../../lib/hostaway-reservations.js";

// no provider network: any fetch from this process during the suite is counted (and refused)
let netAttempts = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { netAttempts += 1; throw new Error("network refused in the offline rehearsal"); };

let db;
before(async () => { db = await startMigratedDatabase(); });
after(async () => { globalThis.fetch = realFetch; await db.close(); });

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
  const listingId = 871000 + laneN;
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
// DB facts
const state = async (id) => (await loadIntent(db.app, id)).status;
const one = async (sql, p = []) => (await db.owner.query(sql, p)).rows[0];
const all = async (sql, p = []) => (await db.owner.query(sql, p)).rows;
const num = async (sql, p = []) => Number((await db.owner.query(sql, p)).rows[0].n);
const opsOf = (id, t) => all("SELECT * FROM booking.external_operations WHERE intent_id = $1 AND op_type = $2 ORDER BY created_at, id", [id, t]);
const pathOf = async (id) => (await all("SELECT to_state FROM booking.intent_transitions WHERE intent_id = $1 ORDER BY version_after", [id])).map((r) => r.to_state);
const events = (id, t) => num("SELECT count(*) AS n FROM booking.intent_transitions WHERE intent_id = $1 AND event_type = $2", [id, t]);
const notifyRows = (id) => all("SELECT state, dispatched_at, attempts FROM booking.external_operations WHERE intent_id = $1 AND op_type = 'guest.notify'", [id]);
const openCases = (id) => all("SELECT kind FROM booking.reconciliation_cases WHERE intent_id = $1 AND status = 'open' ORDER BY kind", [id]);
const PROVIDER_WRITE_OPS = ["hostaway.create_reservation", "stripe.capture_payment_intent", "hostaway.record_offline_charge", "stripe.void_payment_intent", "hostaway.cancel_reservation"];
/** dispatched (claimed) rows per write type: the DB view of "how many provider writes were handed to a sender" */
const dispatchedWrites = async (id) => Object.fromEntries(await Promise.all(PROVIDER_WRITE_OPS.map(async (t) =>
  [t, await num("SELECT count(*) AS n FROM booking.external_operations WHERE intent_id = $1 AND op_type = $2 AND dispatched_at IS NOT NULL", [id, t])])));
const due = (id) => db.owner.query(   // TEST SETUP (disposable cluster): make the work row due and free between bounded recording steps
  "UPDATE booking.intent_work SET next_action_at = now() - interval '1 second', work_worker_id = NULL, work_lease_until = NULL WHERE intent_id = $1", [id]);

/** Cross-phase nonaction: every worker in `others` is idle for this booking and makes ZERO provider calls. */
async function othersIdle(L, w, others, label) {
  const n0 = w.calls.length;
  for (const k of others) {
    const r = await L[k]();
    assert.equal(r.status, "idle", `${label}: ${k} must be idle (${JSON.stringify(r.actions)})`);
  }
  assert.equal(w.calls.length, n0, `${label}: no provider call by ${others.join("/")}`);
}
const writesOf = (w) => ({ ...w.writes });
const W0 = Object.freeze(Object.fromEntries(WRITE_KEYS.map((k) => [k, 0])));
const noProtected = (w) => assert.ok(w.paths.every((p) => !PROTECTED.some((id) => p.includes(id))) && [...w.res.keys()].every((id) => !PROTECTED.includes(String(id))),
  "no provider call or mock reservation names a protected historical id");

// ---------------------------------------------------------------------------------------------
test("1. complete USD chain, BOTH fixture methods: authorized → [reservation worker] confirmed → [capture worker] captured → [recording worker] confirmed; one write each; one queued guest.notify, never executed", async () => {
  for (const method of ["credit_card", "other"]) {
    const w = world(); const bk = await authorizedBooking(w); const L = lane(w, bk, { method });
    assert.equal(await state(bk.id), "payment_authorized");
    assert.deepEqual((await loadIntent(db.app, bk.id)).price.currency, "USD");
    // recording cannot run before capture; capture / compensation have nothing in payment_authorized
    await othersIdle(L, w, ["C", "W", "K"], `${method}/authorized`);
    // --- reservation phase (accepted E7.2 worker) ---
    const r1 = await L.R();
    assert.ok(r1.actions.includes("RESERVATION_STARTED->reservation_pending"), JSON.stringify(r1.actions));
    const r2 = await L.R();
    assert.deepEqual(r2.actions.filter((a) => !a.startsWith("RECOVERY")), ["RESERVATION_DISPATCHED", "CREATE_CLAIMED", "RESERVATION_SUCCEEDED->reservation_confirmed"]);
    const rid = String([...w.res.keys()][0]);
    const i1 = await loadIntent(db.app, bk.id);
    assert.deepEqual([i1.status, i1.reservation.reservationId, i1.listingId, i1.from, i1.to, i1.ref], ["reservation_confirmed", rid, bk.listingId, bk.stay.from, bk.stay.to, bk.ref]);
    const mockRes = w.res.get(Number(rid));
    assert.deepEqual([mockRes.listingMapId, mockRes.arrivalDate, mockRes.departureDate, mockRes.ref, mockRes.currency, Math.round(mockRes.totalPrice * 100)],
      [bk.listingId, bk.stay.from, bk.stay.to, bk.ref, "USD", bk.total], "the mock reservation carries the exact stay / ref / amount / currency");
    assert.deepEqual((await opsOf(bk.id, "stripe.capture_payment_intent")).map((o) => [o.state, o.dispatched_at]), [["pending", null]], "capture QUEUED by E3, not executed");
    assert.equal((await opsOf(bk.id, "hostaway.record_offline_charge")).length, 0, "no recording row before capture");
    await othersIdle(L, w, ["R", "W", "K"], `${method}/reservation_confirmed`);
    // --- capture phase (accepted E7.3b worker) ---
    const c1 = await L.C();
    assert.ok(c1.actions.includes("CAPTURE_SUCCEEDED->payment_captured"), JSON.stringify(c1.actions));
    const cap = (await opsOf(bk.id, "stripe.capture_payment_intent"))[0];
    assert.deepEqual([cap.state, cap.attempts, cap.result_ref, cap.payload.paymentIntentId, cap.payload.amountMinor], ["succeeded", 1, `ch_test_lc${laneN}`, bk.piId, bk.total]);
    const i2 = await loadIntent(db.app, bk.id);
    assert.deepEqual([i2.status, i2.payment.capturedMinor, i2.payment.paymentIntentId, i2.reservation.reservationId], ["payment_captured", bk.total, bk.piId, rid]);
    assert.deepEqual((await opsOf(bk.id, "hostaway.record_offline_charge")).map((o) => [o.state, o.dispatched_at, o.idempotency_key, o.payload]),
      [["pending", null, `och:${bk.id}:1`, { amountMinor: bk.total, reservationId: rid }]], "ONE initial recording QUEUED by E3 with the captured amount + reservation");
    // capture cannot run in the recording phase; compensation cannot touch a captured booking
    await othersIdle(L, w, ["R", "C", "K"], `${method}/payment_captured`);
    // --- recording phase (accepted E7.4b worker) ---
    const w1 = await L.W();
    assert.deepEqual(w1.actions.filter((a) => /^(ASSESSED|CLAIMED|COMPLETED|RECORDED)/.test(a)), ["ASSESSED:eligible", "CLAIMED", "COMPLETED", "RECORDED->confirmed"], JSON.stringify(w1.actions));
    assert.equal(w1.writes, 1);
    // --- final state + linkage across every handoff ---
    const fin = await one("SELECT state, offline_charge_id, hostaway_reservation_id, listing_id, ref, currency, final_total_minor FROM booking.intents WHERE id = $1", [bk.id]);
    const charge = w.charges[0];
    assert.deepEqual([fin.state, fin.offline_charge_id, fin.hostaway_reservation_id, fin.listing_id, fin.ref, fin.currency, Number(fin.final_total_minor)],
      ["confirmed", String(charge.id), rid, bk.listingId, bk.ref, "USD", bk.total]);
    assert.deepEqual([w.charges.length, String(charge.reservationId), charge.listingMapId, charge.paymentMethod, Math.round(charge.amount * 100), charge.title],
      [1, rid, bk.listingId, method, bk.total, `maraVilla payment mvoch1-${bk.id}`], "the mock charge binds the same reservation / listing / amount / method / marker");
    const och = (await opsOf(bk.id, "hostaway.record_offline_charge"))[0];
    const ev = await one("SELECT * FROM booking.provider_evidence WHERE id = $1", [och.settled_evidence_id]);
    assert.deepEqual([och.state, och.attempts, och.result_ref, ev.kind, ev.observed.reservationId, ev.observed.listingMapId, ev.observed.amountMinor, ev.observed.currency,
      ev.observed.paymentMethod, ev.observed.executorAccountRef, ev.observed.chargeId],
    ["succeeded", 1, String(charge.id), "hostaway_offline_charges", rid, bk.listingId, bk.total, "USD", method, LABEL.accountRef, String(charge.id)]);
    const [a] = await all("SELECT * FROM booking.recording_assessments WHERE operation_id = $1 ORDER BY seq", [och.id]);
    const audit = await one("SELECT * FROM booking.recording_claim_assessments WHERE operation_id = $1", [och.id]);
    assert.deepEqual([a.outcome, a.cfg.paymentMethod, a.cfg.currency, a.cfg.listingId, a.account_ref, a.client_label, audit.assessment_id],
      ["eligible", method, "USD", bk.listingId, LABEL.accountRef, LABEL.clientSnapshotId, a.id], "assessment → claim audit → completion linkage");
    const idEv = await one("SELECT observed FROM booking.provider_evidence WHERE id = $1", [a.identity_evidence]);
    assert.deepEqual([idEv.observed.reservationId, idEv.observed.bookingRef, idEv.observed.listingId, idEv.observed.from, idEv.observed.to, idEv.observed.currency, idEv.observed.totalMinor],
      [rid, bk.ref, bk.listingId, bk.stay.from, bk.stay.to, "USD", bk.total], "the recording identity read re-proves the reservation the reservation worker created");
    assert.deepEqual(await pathOf(bk.id), ["created", "price_confirmed", "details_collected", "payment_pending", "payment_authorized",
      "reservation_pending", "reservation_pending", "reservation_confirmed", "payment_captured", "confirmed"], "exact ledger: setup up to payment_authorized, then workers only");
    assert.deepEqual((await all("SELECT event_type FROM booking.intent_transitions WHERE intent_id = $1 AND version_after > (SELECT min(version_after) FROM booking.intent_transitions WHERE intent_id = $1 AND to_state = 'payment_authorized') ORDER BY version_after", [bk.id])).map((r) => r.event_type),
      ["RESERVATION_STARTED", "RESERVATION_DISPATCHED", "RESERVATION_SUCCEEDED", "CAPTURE_SUCCEEDED", "OFFLINE_CHARGE_RECORDED"], "every post-authorization transition came from a worker");
    for (const t of ["RESERVATION_STARTED", "RESERVATION_DISPATCHED", "RESERVATION_SUCCEEDED", "CAPTURE_SUCCEEDED", "OFFLINE_CHARGE_RECORDED"]) assert.equal(await events(bk.id, t), 1, t);
    for (const t of ["RESERVATION_OUTCOME_UNKNOWN", "CAPTURE_OUTCOME_UNKNOWN", "ESCALATE", "VOID_SUCCEEDED", "RESERVATION_CANCELLED"]) assert.equal(await events(bk.id, t), 0, t);
    assert.deepEqual(writesOf(w), { ...W0, createReservation: 1, capturePaymentIntent: 1, createOfflineCharge: 1 }, "exactly ONE invocation of each non-idempotent write");
    assert.deepEqual(await dispatchedWrites(bk.id), { "hostaway.create_reservation": 1, "stripe.capture_payment_intent": 1, "hostaway.record_offline_charge": 1,
      "stripe.void_payment_intent": 0, "hostaway.cancel_reservation": 0 });
    assert.deepEqual((await notifyRows(bk.id)).map((n) => [n.state, n.dispatched_at, n.attempts]), [["pending", null, 0]], "exactly ONE guest.notify outbox row, never executed");
    const inbox = await all("SELECT attempts, processed_at FROM booking.recording_conflict_inbox WHERE intent_id = $1", [bk.id]);
    assert.ok(inbox.length === 2 && inbox.every((x) => x.attempts === 0 && x.processed_at === null),
      "0011 enqueued one conflict-inbox item per charge-list evidence (preflight + confirming); never drained by any worker here");
    // further steps of EVERY worker: no duplicate effect
    for (let k = 0; k < 2; k++) { await due(bk.id); await othersIdle(L, w, ["R", "C", "W", "K"], `${method}/confirmed#${k}`); }
    assert.deepEqual(writesOf(w), { ...W0, createReservation: 1, capturePaymentIntent: 1, createOfflineCharge: 1 });
    assert.equal((await notifyRows(bk.id)).length, 1);
    assert.deepEqual(await openCases(bk.id), []);
    noProtected(w);
    console.log(`# rehearsal 1 [${method}] ledger: ${(await pathOf(bk.id)).join(" > ")}`);
    console.log(`# rehearsal 1 [${method}] invocations: ${JSON.stringify(L.log.filter((x) => x.status !== "idle").map((x) => `${x.worker}:${x.actions.join("|")}`))}`);
    console.log(`# rehearsal 1 [${method}] provider calls: ${JSON.stringify(w.calls)}`);
  }
});

test("2. capture completed but its E3 event interrupted (accepted afterComplete hook fault): a fresh step recovers on persisted facts — no recapture; recording only after payment_captured", async () => {
  const w = world(); const bk = await authorizedBooking(w); const L = lane(w, bk);
  await L.R(); await L.R();
  assert.equal(await state(bk.id), "reservation_confirmed");
  const boom = new Error("capture hook fault after completion (TEST)");
  await assert.rejects(L.C({ hooks: { afterComplete: async () => { throw boom; } } }), (e) => e === boom);
  const cap = (await opsOf(bk.id, "stripe.capture_payment_intent"))[0];
  assert.deepEqual([cap.state, await state(bk.id), w.writes.capturePaymentIntent, w.pis.get(bk.piId).status], ["succeeded", "reservation_confirmed", 1, "succeeded"],
    "money captured + row completed, the CAPTURE_SUCCEEDED event never applied");
  // recording can NOT run on persisted 'captured money' while E3 is not payment_captured; compensation neither
  await othersIdle(L, w, ["W", "K"], "capture event interrupted");
  assert.equal((await opsOf(bk.id, "hostaway.record_offline_charge")).length, 0);
  const n = await L.until("C", (s) => s === "payment_captured");
  assert.equal(w.writes.capturePaymentIntent, 1, "no recapture");
  assert.deepEqual([await events(bk.id, "CAPTURE_SUCCEEDED"), await events(bk.id, "CAPTURE_OUTCOME_UNKNOWN"), await events(bk.id, "RECONCILED_CAPTURE_SUCCEEDED")], [0, 1, 1],
    "accepted planner: unknown recorded first, then a fresh (>= dispatch + 2 min) read reconciles");
  // recording only now
  const w1 = await L.W();
  assert.ok(w1.actions.includes("RECORDED->confirmed"), JSON.stringify(w1.actions));
  assert.deepEqual(writesOf(w), { ...W0, createReservation: 1, capturePaymentIntent: 1, createOfflineCharge: 1 });
  assert.equal((await notifyRows(bk.id)).length, 1);
  noProtected(w);
  console.log(`# rehearsal 2 capture steps to recover: ${n}; ledger: ${(await pathOf(bk.id)).join(" > ")}`);
});

test("3. recording completed + LINKED but OFFLINE_CHARGE_RECORDED interrupted: the next fresh step's recovery applies it exactly once; no second recording; one queued notify", async () => {
  const w = world(); const bk = await authorizedBooking(w); const L = lane(w, bk);
  await L.R(); await L.R(); await L.C();
  assert.equal(await state(bk.id), "payment_captured");
  const boom = new Error("recording hook fault after completion (TEST)");
  await assert.rejects(L.W({ hooks: { afterComplete: async () => { throw boom; } } }), (e) => e === boom);
  const och = (await opsOf(bk.id, "hostaway.record_offline_charge"))[0];
  assert.deepEqual([och.state, och.settled_evidence_id !== null, await state(bk.id), (await notifyRows(bk.id)).length], ["succeeded", true, "payment_captured", 0]);
  await othersIdle(L, w, ["R", "C", "K"], "recording event interrupted");
  const w2 = await L.W();
  assert.ok(w2.actions.includes("RECORDED->confirmed"), JSON.stringify(w2.actions));
  for (let k = 0; k < 2; k++) { await due(bk.id); assert.equal((await L.W()).status, "idle"); }
  assert.equal(await events(bk.id, "OFFLINE_CHARGE_RECORDED"), 1);
  assert.deepEqual(writesOf(w), { ...W0, createReservation: 1, capturePaymentIntent: 1, createOfflineCharge: 1 });
  assert.equal(w.charges.length, 1);
  assert.deepEqual((await notifyRows(bk.id)).map((x) => [x.state, x.dispatched_at]), [["pending", null]]);
  noProtected(w);
});

test("4. ambiguous capture: (a) mock APPLIED + failed reply → capture_unknown: no recapture / recording / notification / void while unknown; accepted read recovery; (b) positive-looking reply, NOTHING applied → owner case", async () => {
  // (a)
  { const w = world(); const bk = await authorizedBooking(w); const L = lane(w, bk);
    await L.R(); await L.R();
    w.mode.capture = "500Captured";
    const c1 = await L.C();
    assert.ok(c1.actions.includes("CAPTURE_OUTCOME_UNKNOWN:CAPTURE_CALL_FAILED"), JSON.stringify(c1.actions));
    assert.equal(await state(bk.id), "capture_unknown");
    await othersIdle(L, w, ["R", "W", "K"], "capture_unknown");
    w.mode.capture = "ok";                                                  // even a healthy mock is never called again
    const n = await L.until("C", (s) => s !== "capture_unknown");
    assert.equal(await state(bk.id), "payment_captured", "accepted planner: fresh PaymentIntent evidence proves the applied capture");
    assert.equal(await events(bk.id, "RECONCILED_CAPTURE_SUCCEEDED"), 1);
    assert.deepEqual(writesOf(w), { ...W0, createReservation: 1, capturePaymentIntent: 1 }, "ONE capture invocation; no recording; no void / cancel");
    assert.deepEqual((await opsOf(bk.id, "hostaway.record_offline_charge")).map((o) => [o.state, o.dispatched_at]), [["pending", null]], "recording only QUEUED (not run in this scenario)");
    assert.equal((await notifyRows(bk.id)).length, 0);
    noProtected(w);
    console.log(`# rehearsal 4a capture steps to reconcile: ${n}; ledger: ${(await pathOf(bk.id)).join(" > ")}`); }
  // (b)
  { const w = world(); const bk = await authorizedBooking(w); const L = lane(w, bk);
    await L.R(); await L.R();
    w.mode.capture = "replyOnly";
    const c1 = await L.C();
    assert.ok(c1.actions.includes("CAPTURE_OUTCOME_UNKNOWN:CONFIRM_READ_NOT_CAPTURED"), JSON.stringify(c1.actions));
    await othersIdle(L, w, ["R", "W", "K"], "capture_unknown (b)");
    await L.until("C", (s) => s !== "capture_unknown");
    const i = await loadIntent(db.app, bk.id);
    assert.deepEqual([i.status, i.reasonCode], ["reconciliation_required", "CAPTURE_STILL_AUTHORIZED_UNRESOLVED"], "intercepted into a durable owner case");
    await othersIdle(L, w, ["R", "C", "W", "K"], "owner case");
    assert.deepEqual(writesOf(w), { ...W0, createReservation: 1, capturePaymentIntent: 1 }, "never a recapture / new key, no recording, no void");
    assert.equal((await opsOf(bk.id, "stripe.capture_payment_intent")).length, 1);
    assert.equal((await opsOf(bk.id, "hostaway.record_offline_charge")).length, 0);
    assert.equal((await notifyRows(bk.id)).length, 0);
    noProtected(w); }
});

test("5. ambiguous recording after an ACTUAL mock invocation (applied, reply 503): durable unknown + case; repeated steps never write again; no confirmation / notification inferred", async () => {
  const w = world(); const bk = await authorizedBooking(w); const L = lane(w, bk);
  await L.R(); await L.R(); await L.C();
  w.mode.record = "appliedThen503";
  const w1 = await L.W();
  assert.ok(w1.actions.includes("UNKNOWN:REPLY_REPLY_HTTP_STATUS"), JSON.stringify(w1.actions));
  const och = (await opsOf(bk.id, "hostaway.record_offline_charge"))[0];
  assert.deepEqual([och.state, och.settled_evidence_id, await state(bk.id)], ["outcome_unknown", null, "payment_captured"]);
  assert.deepEqual((await openCases(bk.id)).map((c) => c.kind), ["OFFLINE_CHARGE_OUTCOME_UNKNOWN"]);
  w.mode.record = "ok";
  for (let k = 0; k < 3; k++) {
    await due(bk.id);
    const r = await L.W();
    assert.ok(r.actions.includes("STOP:RECORDING_OUTCOME_UNKNOWN") && r.writes === 0, JSON.stringify(r.actions));
  }
  await othersIdle(L, w, ["R", "C", "K"], "recording unknown");
  assert.deepEqual(writesOf(w), { ...W0, createReservation: 1, capturePaymentIntent: 1, createOfflineCharge: 1 });
  assert.equal(w.charges.length, 1, "the mock holds the one applied charge; the worker never inferred success from it");
  assert.deepEqual([await state(bk.id), await events(bk.id, "OFFLINE_CHARGE_RECORDED"), (await notifyRows(bk.id)).length], ["payment_captured", 0, 0]);
  noProtected(w);
});

test("6. compensation from a DEFINITE pre-capture failure (fresh recheck: price changed) → reservation_failed → void with fresh + confirming PI proofs → authorization released; no create / capture / recording / notification", async () => {
  const w = world(); const bk = await authorizedBooking(w); const L = lane(w, bk);
  w.nightly += 25;                                                          // the mock listing's price changed after authorization (definite)
  const r1 = await L.R();
  assert.ok(r1.actions.includes("RESERVATION_STARTED->reservation_failed"), JSON.stringify(r1.actions));
  const i0 = await loadIntent(db.app, bk.id);
  assert.deepEqual([i0.status, i0.reasonCode], ["reservation_failed", "PRICE_CHANGED"]);
  assert.deepEqual((await opsOf(bk.id, "stripe.void_payment_intent")).map((o) => [o.state, o.dispatched_at]), [["pending", null]], "void QUEUED by E3");
  await othersIdle(L, w, ["R", "C", "W"], "reservation_failed");
  const k1 = await L.K();
  assert.ok(k1.actions.some((a) => a.startsWith("VOID_SUCCEEDED->")), JSON.stringify(k1.actions));
  const fin = await loadIntent(db.app, bk.id);
  const pis = w.pis.get(bk.piId);
  const voidOp = (await opsOf(bk.id, "stripe.void_payment_intent"))[0];
  assert.deepEqual([voidOp.state, voidOp.attempts, voidOp.payload.paymentIntentId, pis.status], ["succeeded", 1, bk.piId, "canceled"]);
  for (let k = 0; k < 2; k++) await othersIdle(L, w, ["R", "C", "W", "K"], `after void #${k}`);
  assert.deepEqual(writesOf(w), { ...W0, cancelPaymentIntent: 1 }, "exactly ONE void; ZERO create / capture / recording / cancel");
  assert.deepEqual([(await opsOf(bk.id, "hostaway.create_reservation")).length, (await opsOf(bk.id, "stripe.capture_payment_intent")).length,
    (await opsOf(bk.id, "hostaway.record_offline_charge")).length], [0, 0, 0]);
  const nf = await notifyRows(bk.id);
  assert.ok(nf.every((x) => x.state === "pending" && x.dispatched_at === null && x.attempts === 0), "any guest.notify row E3 queued is QUEUED only, never executed");
  assert.equal(w.res.size, 0, "the mock Hostaway world holds no reservation");
  noProtected(w);
  console.log(`# rehearsal 6 final: ${fin.status}; queued guest.notify rows: ${nf.length}; ledger: ${(await pathOf(bk.id)).join(" > ")}`);
});

test("whole suite: no provider network attempt and no protected historical id anywhere in the disposable DB", async () => {
  assert.equal(netAttempts, 0);
  assert.equal(await num("SELECT count(*) AS n FROM booking.intents WHERE hostaway_reservation_id = ANY($1)", [PROTECTED]), 0);
  assert.equal(await num("SELECT count(*) AS n FROM booking.external_operations WHERE payload ->> 'reservationId' = ANY($1)", [PROTECTED]), 0);
});
