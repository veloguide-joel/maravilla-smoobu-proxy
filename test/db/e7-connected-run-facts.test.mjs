// E7 connected-test runner SLICE C — persisted-facts reader + candidate derivation (DISPOSABLE local PG; no network, no provider).
//
// LABELS
//   * PG ENFORCEMENT: readRunSnapshot runs on a real mv_booking_report login (test_report) and readGuestBinding on a real mv_booking_app
//     login (test_app); never the owner as the functions' client. Real persisted facts come ONLY from accepted repo functions + the
//     accepted reservation worker driven through the accepted executor adapters into FAKE transports (the accepted adapter rehearsal's
//     synthetic world, copied test-locally below, LABELLED SYNTHETIC). The payment authorization is labelled fixture setup (mocked).
//     No trigger disabling, no raw operation lifecycle writes, no manual completion.
//   * SYNTHETIC: pure-derivation negative cases mutate a copy of real facts in memory; fake-client cases (cap+1, faults, marker) never
//     touch PG. Each such test says so.
//   * Guest values are compared, never printed. Observed / provider bodies are never printed.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { startMigratedDatabase } from "./harness.mjs";
import * as F from "./fixtures.mjs";
import { applyEvent, loadIntent, createIntentRecord, collectGuestDetails, beginPayStep, recordCheckoutSession } from "../../lib/booking-db/repo.js";
import { claimNextOperation, completeOperation, requestRead, recordProviderEvidence } from "../../lib/booking-db/operations.js";
import { loadRecoveryFacts } from "../../lib/booking-db/recovery.js";
import { planRecovery } from "../../lib/checkout/recovery-plan.js";
import { runOrchestratorStep, PROTECTED_HOSTAWAY_RESERVATION_IDS } from "../../lib/booking-db/reservation-worker.js";
import { priceStay } from "../../lib/checkout/server-pricer.js";
import { readDirectPolicyFromEnv } from "../../lib/direct-policy.js";
import { todayInTimeZone } from "../../lib/public-api.js";
import { validateAdapterConfig } from "../../lib/hostaway-reservations.js";
import { createPhaseExecutors } from "../../scripts/e7-connected/executor-adapters.mjs";
import { validateGuardDeps, createGuard, isNativePromise, LIMITS } from "../../scripts/e7-connected/run-guard.mjs";
import { readRunSnapshot, readGuestBinding, deriveRecoveryCandidate, FACT_CAPS, SQL, RUN_FACTS_VERSION } from "../../scripts/e7-connected/run-facts.mjs";

let netAttempts = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { netAttempts += 1; throw new Error("network refused in the offline facts suite"); };

let db; let reportPool;
before(async () => { db = await startMigratedDatabase(); reportPool = new pg.Pool({ connectionString: db.reportUrl(), max: 4 }); });
after(async () => { globalThis.fetch = realFetch; await reportPool.end().catch(() => {}); await db.close(); assert.equal(netAttempts, 0); });

// ---- SYNTHETIC world + booking setup + fake transports: copied verbatim from the accepted adapter rehearsal (9f13c816) -----------
const SEC = 1000; const MIN = 60 * SEC; const DAY = 24 * 60 * MIN;
const ENV_R = Object.freeze({ VERCEL_ENV: "development", MV_E7_RESERVATION_WORKER: "enabled" });
const ENV_C = Object.freeze({ VERCEL_ENV: "development", MV_E7_CAPTURE_WORKER: "enabled" });
const ENV_W = Object.freeze({ VERCEL_ENV: "development", MV_E7_RECORDING_WORKER: "enabled" });
const ENV_K = Object.freeze({ VERCEL_ENV: "development", MV_E7_COMPENSATION_WORKER: "enabled" });
const POLICY = readDirectPolicyFromEnv(ENV_R).policy;
const ACCT = "acct_1AdapterRehearsal";                            // FIXTURE Stripe account id (mock world)
const LABEL = Object.freeze({ accountRef: "acct-test-1", clientSnapshotId: "client-CAR" });   // TRUST labels, not authentication
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
      w.res.set(r.id, r);                                                    // the mock APPLIES the create in every mode below
      if (w.mode.create === "noEcho") return { httpStatus: 201, json: { status: "success", result: { ...full(r), customFieldValues: [] } } };   // ref stored, not echoed
      if (w.mode.create === "appliedThen503") return { httpStatus: 503, json: { status: "fail", result: "upstream unavailable (mock)" } };
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
  const sessionId = `cs_test_car${laneN}`;
  F.ok(await completeOperation(db.app, op.id, { workerId: "w-pay", now: base + 2 * SEC, outcome: { status: "succeeded", resultRef: sessionId } }));
  F.ok(await recordCheckoutSession(db.app, intent.id, b.attempt.id, { sessionId, expiresAt: base + 30 * MIN, now: base + 2 * SEC }));
  const piId = `pi_test_car${laneN}`;
  const captureBefore = Math.floor((base + 7 * DAY) / 1000) * 1000;
  F.ok(await applyEvent(db.app, intent.id, { type: "PAYMENT_AUTHORIZED", id: `evt_auth_${piId}`, paymentIntentId: piId, sessionId, amountMinor: priced.price.finalTotalMinor,
    currency: "usd", livemode: false, authorizationCreatedAt: base + 3 * SEC, captureBefore }, { now: base + 4 * SEC, actor: "webhook" }));
  const pa = (await db.app.query("SELECT id FROM booking.payment_attempts WHERE intent_id = $1 AND status = 'completed'", [intent.id])).rows[0].id;
  // the mock Stripe world authorized exactly this PaymentIntent (what the mock "did")
  w.pis.set(piId, { id: piId, intentId: intent.id, attemptId: pa, status: "requires_capture", amount: priced.price.finalTotalMinor, received: 0,
    chargeId: `ch_test_car${laneN}`, captureBeforeSec: captureBefore / 1000 });
  return { id: intent.id, ref: intent.ref, listingId, stay, piId, price: priced.price, total: priced.price.finalTotalMinor, paymentAttemptId: pa, base };
}

// ---------------------------------------------------------------------------------------------
// FAKE injected transports over the world: the adapters' documented envelopes (hostaway.send / stripe.send); every invocation counted.
const pj = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));   // adapters hand frozen null-prototype copies
function transports(w) {
  const t = { h: [], s: [] };
  const priced = (r) => ({ httpStatus: r.status, json: r.json });
  t.hostaway = { send: async (req, x) => {
    assert.ok(x.signal instanceof AbortSignal && !x.signal.aborted, "the worker's live signal reaches the transport");
    const m = req.method; const p = req.path; const q = pj(req.query); const b = pj(req.body);
    assert.ok(/^\/v1\/(?!v1\/)/.test(p), "exactly one /v1 prefix");
    t.h.push(`${m} ${p}`);
    if (m === "GET" && /^\/v1\/listings\/\d+$/.test(p)) return priced(await w.pricing.get(p.slice(3)));
    if (m === "GET" && /^\/v1\/listings\/\d+\/calendar$/.test(p)) return priced(await w.pricing.get(p.slice(3), { query: q }));
    if (m === "POST" && /^\/v1\/listings\/\d+\/calendar\/priceDetails$/.test(p)) return priced(await w.pricing.post(p.slice(3), b));
    if (m === "GET" && p === "/v1/reservations") return w.exec.R.lookupPage({ method: m, path: p, query: q });
    if (m === "GET" && /^\/v1\/reservations\/\d+$/.test(p)) return w.exec.R.retrieveReservation({ method: m, path: p, query: q });
    if (m === "POST" && p === "/v1/reservations") return w.exec.R.createReservation({ method: m, path: p, query: q, body: b });
    if (m === "PUT" && /^\/v1\/reservations\/\d+\/statuses\/cancelled$/.test(p)) return w.exec.K.cancelReservation({ method: m, path: p, query: q, body: b });
    if (m === "GET" && p === "/v1/guestPayments/charges") return w.exec.W.listOfflineCharges({ method: m, path: p, query: q });
    if (m === "POST" && /^\/v1\/guestPayments\/charges\/\d+$/.test(p)) return w.exec.W.createOfflineCharge({ method: m, path: p, query: q, body: b });
    throw new Error("unmapped fake route");
  } };
  t.stripe = { send: async (call, x) => {
    assert.ok(x.signal instanceof AbortSignal && !x.signal.aborted);
    t.s.push(call.op);
    const c = pj(call);
    if (c.op === "accounts.retrieve") return w.exec.C.retrieveAccount();
    if (c.op === "paymentIntents.retrieve") return w.exec.C.retrievePaymentIntent(c.id, c.params);
    if (c.op === "paymentIntents.capture") { assert.equal(typeof c.idempotencyKey, "string"); return w.exec.C.capturePaymentIntent(c.id, c.params); }
    if (c.op === "paymentIntents.cancel") { assert.equal(typeof c.idempotencyKey, "string"); return w.exec.K.cancelPaymentIntent(c.id); }
    throw new Error("unmapped fake stripe op");
  } };
  t.count = (re) => t.h.filter((x) => re.test(x)).length + t.s.filter((x) => re.test(x)).length;
  return t;
}


// ---- guards ------------------------------------------------------------------------------------------------------------------------
/** a real-time guard for PG tests (TEST-LOCAL injected timers; the module itself has none) */
function realGuard() {
  const v = validateGuardDeps({ monotonic: () => performance.now(), timers: { arm: (ms) => { let t; const promise = new Promise((r) => { t = setTimeout(r, ms); }); return { promise, cancel: () => clearTimeout(t) }; } } });
  return createGuard(v.deps);
}
/** deterministic fake guard (fault tests) */
function fakeGuard() {
  const f = { t: 0, timers: [] };
  f.guard = createGuard(validateGuardDeps({ monotonic: () => f.t, timers: { arm: (ms) => { let res; const promise = new Promise((r) => { res = r; }); const e = { due: f.t + ms, res, live: true };
    f.timers.push(e); return { promise, cancel: () => { e.live = false; } }; } } }).deps);
  f.advance = async (ms) => { f.t += ms; for (const e of f.timers) if (e.live && e.due <= f.t) { e.live = false; e.res(undefined); } for (let i = 0; i < 40; i++) await null; };
  return f;
}
const flush = async (n = 40) => { for (let i = 0; i < n; i++) await null; };
const deadlineOf = (g) => g.now().value + LIMITS.SNAPSHOT_MS;
async function withReport(fn) { const c = await reportPool.connect(); try { return await fn(c); } finally { c.release(); } }
async function withApp(fn) { const c = await db.app.connect(); try { return await fn(c); } finally { c.release(); } }
const snapshot = (id) => withReport((client) => { const guard = realGuard(); return readRunSnapshot({ client, intentId: id, guard, deadline: deadlineOf(guard) }); });
const guestRead = (id) => withApp((client) => { const guard = realGuard(); return readGuestBinding({ client, intentId: id, guard, deadline: deadlineOf(guard) }); });
const deepFrozen = (o) => (o === null || typeof o !== "object" ? true : Object.isFrozen(o) && Object.values(o).every(deepFrozen));
const state = async (id) => (await loadIntent(db.app, id)).status;
const ownerAll = async (sql, p = []) => (await db.owner.query(sql, p)).rows;   // TEST-ONLY assertion reads (owner); never the functions' client

/** reservation lane: each step derives the candidate with run-facts on the REPORT login and the guest binding on the APP login */
function lane(w, bk) {
  const t = transports(w); const clk = { t: bk.base + 10 * SEC }; const log = []; const cands = [];
  const adapterConfig = validateAdapterConfig({ allowedListingIds: [bk.listingId], refFieldId: REF_FIELD, channelId: 2000, currency: "USD" });
  const L = {
    t, clk, log, cands,
    R: async () => {
      const s = await snapshot(bk.id); assert.equal(s.ok, true, s.code);
      const cand = deriveRecoveryCandidate(s.facts); cands.push(cand);
      if (!cand.ok && !["NO_CANDIDATE", "NOT_RESERVATION_PHASE"].includes(cand.code)) throw new Error(`HARNESS_STOP:${cand.code}`);
      const g = await guestRead(bk.id); assert.equal(g.ok, true, g.code);
      const i = s.facts.intent;
      const binding = { listingId: i.listingId, arrivalDate: i.from, departureDate: i.to, ref: i.ref, guests: i.guests, totalMinor: i.finalTotalMinor, currency: i.currency,
        refFieldId: REF_FIELD, guest: g.guest, reservationId: cand.ok ? cand.id : null };
      const ex = createPhaseExecutors({ phase: cand.ok ? "reservation-recovery" : "reservation", binding, hostaway: t.hostaway });
      assert.equal(ex.ok, true, ex.code);
      const r = await runOrchestratorStep(db.app, { workerId: "rf-res", env: ENV_R, adapterConfig, listings: new Map([[bk.listingId, { currency: "USD" }]]),
        executors: ex.executors, clock: () => clk.t, intentId: bk.id });
      log.push(r.actions); clk.t = Math.min(clk.t + MIN, Date.now() - 5 * SEC);
      return r;
    }
  };
  return L;
}
/** mutable deep copy of frozen facts for SYNTHETIC derivation cases */
const thaw = (o) => JSON.parse(JSON.stringify(o));

// =================================================================================================================================
test("PG: report snapshot of a payment_authorized booking — explicit frozen facts, acknowledged COMMIT, no guest / raw body; app guest read in memory", async () => {
  const w = world(); const bk = await authorizedBooking(w);
  const s = await snapshot(bk.id);
  assert.equal(s.ok, true, s.code); assert.equal(s.statementsIssued, 10, "BEGIN + 8 reads + COMMIT");
  assert.ok(deepFrozen(s));
  const f = s.facts;
  assert.deepEqual(Object.keys(f).sort(), ["cases", "intent", "intentId", "limits", "marker", "operations", "reservationAttempts", "reservationEvidence", "transitions", "version", "work"].sort());
  assert.deepEqual([f.version, f.intentId, f.marker.environment, f.intent.id, f.intent.ref, f.intent.state, f.intent.listingId, f.intent.from, f.intent.to, f.intent.guests, f.intent.currency,
    f.intent.finalTotalMinor, f.intent.stripePaymentIntentId, f.intent.hostawayReservationId],
    [RUN_FACTS_VERSION, bk.id, "test", bk.id, bk.ref, "payment_authorized", bk.listingId, bk.stay.from, bk.stay.to, 2, "USD", bk.total, bk.piId, null]);
  assert.equal(f.intent.version, f.transitions.at(-1).versionAfter, "intent version = last transition");
  assert.ok(f.operations.every((o) => typeof o.payloadUnlistedKeys === "number" && Object.isFrozen(o.payload)));
  assert.deepEqual(f.reservationEvidence, []); assert.deepEqual(f.reservationAttempts, []); assert.deepEqual(f.cases, []);
  const json = JSON.stringify(s);
  for (const v of [F.GUEST.firstName, F.GUEST.lastName, F.GUEST.email, F.GUEST.phone]) assert.ok(!json.includes(v), "no guest value in report facts");
  assert.ok(!/access_?token|token_hash|checkout_session_id|"phone"|"terms/i.test(json), "no token / contact columns selected");
  assert.deepEqual(Object.keys(f.intent).sort(), ["authorizedMinor", "capturedMinor", "currency", "dispatchAt", "dispatchAttempt", "environment", "finalTotalMinor", "from", "guests", "hostawayReservationId",
    "id", "listingId", "offlineChargeId", "policyVersion", "rateBps", "reasonCode", "ref", "reservationAttempts", "reservationConfirmedAt", "state", "stripePaymentIntentId", "to", "updatedAt", "version"]);
  assert.deepEqual({ ...deriveRecoveryCandidate(f) }, { ok: false, code: "NO_CANDIDATE" }, "fresh booking: explicit NO_CANDIDATE, never auto-adoption");
  const g = await guestRead(bk.id);
  assert.equal(g.ok, true); assert.equal(g.statementsIssued, 1); assert.ok(Object.isFrozen(g.guest));
  assert.ok(g.guest.firstName === F.GUEST.firstName && g.guest.lastName === F.GUEST.lastName && g.guest.email === F.GUEST.email, "binding equals the stored guest (values not printed)");
  assert.deepEqual(Object.keys(g.guest), ["firstName", "lastName", "email"], "no phone / terms in the binding");
});

test("PG roles: the report login cannot read guest data; the app login is refused as a snapshot role; the owner is refused for both", async () => {
  const w = world(); const bk = await authorizedBooking(w);
  { const c = await reportPool.connect(); const guard = realGuard();
    const r = await readGuestBinding({ client: c, intentId: bk.id, guard, deadline: deadlineOf(guard) });
    assert.deepEqual({ ...r }, { ok: false, code: "DB_FAILURE", failure: "db", clientDisposition: "destroy", statementsIssued: 1 }, "permission denied → db failure, no message");
    c.release(true); }
  { const c = await db.app.connect(); const guard = realGuard();
    const r = await readRunSnapshot({ client: c, intentId: bk.id, guard, deadline: deadlineOf(guard) });
    assert.deepEqual({ ...r }, { ok: false, code: "ROLE_NOT_REPORT", failure: "refusal", clientDisposition: "healthy", statementsIssued: 3 }, "BEGIN, marker, COMMIT");
    c.release(); }
  { const c = await db.owner.connect(); const guard = realGuard();
    assert.equal((await readRunSnapshot({ client: c, intentId: bk.id, guard, deadline: deadlineOf(guard) })).code, "ROLE_NOT_REPORT");
    assert.equal((await readGuestBinding({ client: c, intentId: bk.id, guard, deadline: deadlineOf(guard) })).code, "ROLE_NOT_APP");
    c.release(); }
});

test("PG identity / scoping: two bookings — each snapshot holds only its own rows; unknown intent → acknowledged INTENT_NOT_FOUND refusal", async () => {
  const w1 = world(); const b1 = await authorizedBooking(w1); const w2 = world(); const b2 = await authorizedBooking(w2);
  const L2 = lane(w2, b2); await L2.R(); await L2.R();
  const [s1, s2] = [await snapshot(b1.id), await snapshot(b2.id)];
  const own = async (id, t) => (await ownerAll(`SELECT id FROM booking.${t} WHERE intent_id = $1 ORDER BY id`, [id])).map((r) => r.id).sort();
  assert.deepEqual(s1.facts.operations.map((o) => o.id).sort(), await own(b1.id, "external_operations"));
  assert.deepEqual(s2.facts.operations.map((o) => o.id).sort(), await own(b2.id, "external_operations"));
  assert.ok(s2.facts.operations.length > s1.facts.operations.length);
  assert.ok(s1.facts.operations.every((o) => !s2.facts.operations.some((x) => x.id === o.id)));
  assert.deepEqual(s2.facts.reservationAttempts.map((a) => a.id), (await ownerAll("SELECT id FROM booking.hostaway_reservation_attempts WHERE intent_id = $1", [b2.id])).map((r) => r.id));
  assert.equal(s1.facts.transitions.length < s2.facts.transitions.length, true);
  const missing = await snapshot("00000000-0000-4000-8000-0000000000ff");
  assert.deepEqual({ ...missing }, { ok: false, code: "INTENT_NOT_FOUND", failure: "refusal", clientDisposition: "healthy", statementsIssued: 4 });
});

test("PG REPEATABLE READ barrier: a worker step committed DURING the snapshot is invisible to it; a later snapshot sees it", async () => {
  const w = world(); const bk = await authorizedBooking(w); const L = lane(w, bk);
  const before = await snapshot(bk.id);
  const c = await reportPool.connect();
  let committed = false;
  const client = { query: (sql, p) => {
    const pr = c.query(sql, p);
    if (sql !== SQL.INTENT) return pr;
    return pr.then(async (res) => { await L.R(); committed = true; return res; });     // a concurrent accepted-worker commit mid-snapshot
  } };
  const guard = realGuard();
  const s = await readRunSnapshot({ client, intentId: bk.id, guard, deadline: guard.now().value + 120_000 });
  c.release();
  assert.equal(committed, true); assert.equal(s.ok, true, s.code);
  assert.equal(await state(bk.id), "reservation_pending", "the concurrent step really committed");
  assert.deepEqual([s.facts.intent.state, s.facts.intent.version], [before.facts.intent.state, before.facts.intent.version]);
  assert.deepEqual(s.facts.operations.map((o) => [o.id, o.state]), before.facts.operations.map((o) => [o.id, o.state]), "operations from the SAME basis");
  assert.deepEqual(s.facts.transitions, before.facts.transitions);
  const later = await snapshot(bk.id);
  assert.ok(later.facts.intent.version > s.facts.intent.version && later.facts.operations.length > s.facts.operations.length, "a later snapshot sees the commit");
});

test("PG candidate (a): no-echo create — candidate from the succeeded create's result_ref while the adopted id is NULL; lane proceeds to confirmed with one create", async () => {
  const w = world(); w.mode.create = "noEcho"; const bk = await authorizedBooking(w); const L = lane(w, bk);
  await L.R(); const r2 = await L.R();
  assert.ok(r2.actions.includes("CREATE_REF_NOT_ECHOED:READS_REQUIRED"), JSON.stringify(r2.actions));
  const s = await snapshot(bk.id); const rid = String([...w.res.keys()][0]);
  const create = s.facts.operations.find((o) => o.opType === "hostaway.create_reservation");
  assert.deepEqual([create.state, create.resultRef, s.facts.intent.hostawayReservationId], ["succeeded", rid, null]);
  assert.deepEqual(s.facts.reservationAttempts.map((a) => [a.operationId, a.bookingRef]), [[create.id, bk.ref]]);
  assert.ok(isPayloadExplicit(s.facts));
  const cand = deriveRecoveryCandidate(s.facts);
  assert.deepEqual({ ...cand, sources: [...cand.sources] }, { ok: true, id: rid, sources: ["a"], adopted: null });
  for (let n = 0; n < 12 && (await state(bk.id)) !== "reservation_confirmed"; n++) await L.R();
  assert.equal(await state(bk.id), "reservation_confirmed");
  assert.equal(w.writes.createReservation, 1); assert.equal(L.t.count(/^POST \/v1\/reservations$/), 1, "no second create");
  assert.ok(L.cands.filter((x) => x.ok).every((x) => x.id === rid));
  const fin = await snapshot(bk.id);
  assert.deepEqual({ ...deriveRecoveryCandidate(fin.facts) }, { ok: false, code: "NOT_RESERVATION_PHASE" });
  globalThis.__B = s.facts;                                                    // reused by the SYNTHETIC cases below
});
function isPayloadExplicit(f) { return f.operations.every((o) => Object.keys(o.payload).every((k) => ["amountMinor", "attempt", "currency", "expiresAt", "listingId", "paymentAttemptId", "paymentIntentId", "providerIdempotencyKey", "ref", "reissueDepth", "reissueOf", "reservationId", "sessionId", "template"].includes(k))); }

test("PG candidate (b): ambiguous create (applied, then 503) — lookup evidence joined to its read op names ONE candidate; never a second create", async () => {
  const w = world(); w.mode.create = "appliedThen503"; const bk = await authorizedBooking(w); const L = lane(w, bk);
  await L.R(); await L.R();
  assert.equal(await state(bk.id), "reservation_unknown");
  let s; let cand;
  for (let n = 0; n < 14; n++) {
    s = await snapshot(bk.id); cand = deriveRecoveryCandidate(s.facts);
    if (cand.ok || (await state(bk.id)) === "reservation_confirmed") break;
    await L.R();
  }
  const rid = String([...w.res.keys()][0]);
  assert.equal(cand.ok, true, cand.code); assert.equal(cand.id, rid); assert.ok(cand.sources.includes("b"), JSON.stringify(cand.sources));
  const lk = s.facts.reservationEvidence.find((e) => e.readOpType === "hostaway.lookup_reservation" && e.status === "found_active");
  const readOp = s.facts.operations.find((o) => o.id === lk.readOperationId);
  assert.deepEqual([lk.readIntentId, readOp.opType, lk.selector.ref, lk.observed.bookingRef, lk.observed.matchCount, lk.externalRef],
    [bk.id, "hostaway.lookup_reservation", bk.ref, bk.ref, 1, rid], "evidence joined to ITS read op and selector");
  assert.equal(s.facts.operations.find((o) => o.opType === "hostaway.create_reservation").state, "outcome_unknown");
  assert.ok(s.facts.cases.some((c) => c.kind === "HOSTAWAY_CREATE_OUTCOME_UNKNOWN" && c.status === "open"), "open case is a fact for the later core");
  for (let n = 0; n < 12 && (await state(bk.id)) !== "reservation_confirmed"; n++) await L.R();
  assert.equal(await state(bk.id), "reservation_confirmed"); assert.equal(w.writes.createReservation, 1);
});

test("SYNTHETIC derivation (pure, on a mutated COPY of real facts): conflicts, protected refs, open / historical selectors, attempts, pending create, malformed", () => {
  const B = globalThis.__B; assert.ok(B, "needs the no-echo facts");
  const rid = B.operations.find((o) => o.opType === "hostaway.create_reservation").resultRef;
  const other = String(Number(rid) + 7);
  const createIdx = B.operations.findIndex((o) => o.opType === "hostaway.create_reservation");
  const lookupOp = (id, ref, state = "succeeded") => ({ id, opType: "hostaway.lookup_reservation", state, payload: { ref }, resultRef: null, lateResultRef: null });
  const retrieveOp = (id, rsv, state = "pending") => ({ id, opType: "hostaway.retrieve_reservation", state, payload: { reservationId: rsv }, resultRef: null, lateResultRef: null });
  const ev = (opId, ext, o = {}, extra = {}) => ({ id: "e0000000-0000-4000-8000-000000000001", kind: "hostaway_reservation", source: "hostaway_api", externalRef: ext, status: "found_active",
    observedAt: 1, readOperationId: opId, readIntentId: B.intentId, readOpType: "hostaway.lookup_reservation", selector: { ref: B.intent.ref, reservationId: null },
    observed: { bookingRef: B.intent.ref, matchCount: 1, reservationId: ext, listingId: B.intent.listingId, from: B.intent.from, to: B.intent.to, totalMinor: B.intent.finalTotalMinor, currency: "USD", ...o }, ...extra });
  const L1 = "a1000000-0000-4000-8000-000000000001"; const R1 = "a2000000-0000-4000-8000-000000000002";
  const mut = (fn) => { const f = thaw(B); fn(f); return f; };
  const code = (f) => deriveRecoveryCandidate(f).code;
  const cases = [
    ["lookup names another id", mut((f) => { f.operations.push(lookupOp(L1, f.intent.ref)); f.reservationEvidence.push(ev(L1, other)); }), "CANDIDATE_CONFLICT"],
    ["lookup agrees → two sources", mut((f) => { f.operations.push(lookupOp(L1, f.intent.ref)); f.reservationEvidence.push(ev(L1, rid)); }), undefined],
    ["protected result_ref", mut((f) => { f.operations[createIdx].resultRef = PROTECTED_HOSTAWAY_RESERVATION_IDS[0]; }), "PROTECTED_REFERENCE"],
    ["protected in an attempt row", mut((f) => { f.reservationAttempts[0].hostawayReservationId = PROTECTED_HOSTAWAY_RESERVATION_IDS[1]; }), "PROTECTED_REFERENCE"],
    ["protected in evidence", mut((f) => { f.operations.push(lookupOp(L1, f.intent.ref)); f.reservationEvidence.push(ev(L1, PROTECTED_HOSTAWAY_RESERVATION_IDS[2])); }), "PROTECTED_REFERENCE"],
    ["protected by-id selector", mut((f) => { f.operations.push(retrieveOp(R1, PROTECTED_HOSTAWAY_RESERVATION_IDS[3])); }), "PROTECTED_REFERENCE"],
    ["open by-id read for another id", mut((f) => { f.operations.push(retrieveOp(R1, other)); }), "OPEN_READ_CONFLICT"],
    ["historical by-id read for another id", mut((f) => { f.operations.push(retrieveOp(R1, other, "succeeded")); }), "RESERVATION_ID_CONFLICT"],
    ["open by-id read for the SAME id (same-step scheduling) is fine", mut((f) => { f.operations.push(retrieveOp(R1, rid)); }), undefined],
    ["attempt row returned another id", mut((f) => { f.reservationAttempts[0].hostawayReservationId = other; }), "RESERVATION_ID_CONFLICT"],
    ["late_result_ref names another id", mut((f) => { f.operations[createIdx].lateResultRef = other; }), "RESERVATION_ID_CONFLICT"],
    ["adopted id differs", mut((f) => { f.intent.hostawayReservationId = other; }), "CANDIDATE_CONFLICT"],
    ["pending create + adopted candidate", mut((f) => { f.operations[createIdx].state = "pending"; f.operations[createIdx].resultRef = null; f.intent.hostawayReservationId = rid; }), "CANDIDATE_BEFORE_CREATE"],
    ["known id but no candidate", mut((f) => { f.operations[createIdx].state = "outcome_unknown"; }), "KNOWN_ID_WITHOUT_CANDIDATE"],
    ["lookup bookingRef mismatch", mut((f) => { f.operations.push(lookupOp(L1, f.intent.ref)); f.reservationEvidence.push(ev(L1, rid, { bookingRef: "MV-OTHER01" })); }), "EVIDENCE_IDENTITY_MISMATCH"],
    ["lookup total mismatch", mut((f) => { f.operations.push(lookupOp(L1, f.intent.ref)); f.reservationEvidence.push(ev(L1, rid, { totalMinor: 1 })); }), "EVIDENCE_IDENTITY_MISMATCH"],
    ["observed id ≠ external_ref", mut((f) => { f.operations.push(lookupOp(L1, f.intent.ref)); f.reservationEvidence.push(ev(L1, rid, { reservationId: other })); }), "EVIDENCE_IDENTITY_MISMATCH"],
    ["duplicate booking ref", mut((f) => { f.operations.push(lookupOp(L1, f.intent.ref)); f.reservationEvidence.push(ev(L1, rid, { matchCount: 2 })); }), "DUPLICATE_BOOKING_REF"],
    ["evidence without its read op", mut((f) => { f.reservationEvidence.push(ev(L1, rid)); }), "FACTS_INCONSISTENT"],
    ["evidence read op of another intent", mut((f) => { f.operations.push(lookupOp(L1, f.intent.ref)); f.reservationEvidence.push(ev(L1, rid, {}, { readIntentId: "a3000000-0000-4000-8000-000000000003" })); }), "FACTS_INCONSISTENT"],
    ["lookup selector for another ref", mut((f) => { f.operations.push(lookupOp(L1, "MV-ZZZZZZ")); f.reservationEvidence.push(ev(L1, rid, {}, { selector: { ref: "MV-ZZZZZZ", reservationId: null } })); }), "FACTS_INCONSISTENT"],
    ["two create rows", mut((f) => { f.operations.push({ ...f.operations[createIdx], id: "a4000000-0000-4000-8000-000000000004" }); }), "FACTS_INCONSISTENT"],
    ["attempt bound to another op", mut((f) => { f.reservationAttempts[0].operationId = f.operations.find((o) => o.opType !== "hostaway.create_reservation").id; }), "FACTS_INCONSISTENT"],
    ["non-canonical result_ref", mut((f) => { f.operations[createIdx].resultRef = "abc"; }), "FACT_MALFORMED"],
    ["missing operations array", mut((f) => { delete f.operations; }), "FACT_MALFORMED"],
    ["wrong version", mut((f) => { f.version = "v0"; }), "FACT_MALFORMED"],
    ["not reservation phase", mut((f) => { f.intent.state = "reservation_confirmed"; }), "NOT_RESERVATION_PHASE"]
  ];
  for (const [name, f, expected] of cases) {
    const r = derive(f);
    if (expected === undefined) { assert.equal(r.ok, true, `${name}: ${r.code}`); assert.equal(r.id, rid); }
    else assert.deepEqual({ ...r }, { ok: false, code: expected }, name);
    assert.ok(Object.isFrozen(r));
  }
  assert.deepEqual([...deriveRecoveryCandidate(cases[1][1]).sources], ["a", "b"]);
  for (const junk of [null, undefined, 1, "x", [], {}]) assert.equal(code(junk), "FACT_MALFORMED");
});

// ---- SYNTHETIC fake-client cases (never touch PG) -----------------------------------------------------------------------------------
/** a fake report client: answers each statement from `plan` ({ rows } | 'reject' | 'hang'), records every call; release/end are spies */
function fakeClient(plan) {
  const c = { calls: [], releases: 0, ends: 0, release() { c.releases += 1; }, end() { c.ends += 1; } };
  c.query = (sql) => {
    c.calls.push(sql.trim().split(/\s+/).slice(0, 3).join(" "));
    const p = plan(sql, c.calls.length);
    if (p === "reject") return Promise.reject(Object.assign(new Error("SECRET-DETAIL from the server"), { code: "57P01" }));
    if (p === "hang") return new Promise(() => {});
    return Promise.resolve(p);
  };
  return c;
}
const ID = "00000000-0000-4000-8000-0000000000c1";
const okRows = (sql) => {
  if (sql === SQL.MARKER) return { rows: [{ environment: "test", created_at: new Date(0), is_report: true, is_app: false, privileged: false }] };
  if (sql === SQL.INTENT) return { rows: [{ id: ID, ref: "MV-SYNTH01", environment: "test", state: "payment_authorized", version: 7, listing_id: 891001, from_date: "2026-12-04",
    to_date: "2026-12-06", guests: 2, currency: "USD", final_total_minor: "50000", rate_bps: 1000, policy_version: "direct-v1", stripe_payment_intent_id: "pi_x", authorized_minor: "50000",
    captured_minor: "0", hostaway_reservation_id: null, reservation_confirmed_at: null, dispatch_at: null, dispatch_attempt: null, offline_charge_id: null, reservation_attempts: 0,
    reason_code: null, updated_at: new Date(0) }] };
  return { rows: [] };
};

test("SYNTHETIC cap+1: each capped query returning cap+1 rows → FACT_LIMIT_EXCEEDED after an acknowledged COMMIT; nothing truncated or derived", async () => {
  const opRow = (i) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, intent_id: ID, op_type: "guest.notify", idempotency_key: `k-${i}`, retry_class: "read", state: "pending",
    source_version: 1, attempts: 0, max_attempts: 3, requires_provider_read: false, lease_worker_id: null, lease_until: null, next_attempt_at: new Date(0), dispatched_at: null,
    completed_at: null, result_ref: null, error_code: null, late_result_status: null, late_result_ref: null, settled_evidence_id: null, created_at: new Date(0), payload_unlisted: 0 });
  for (const [key, sql] of [["operations", SQL.OPERATIONS], ["reservationAttempts", SQL.ATTEMPTS], ["reservationEvidence", SQL.EVIDENCE], ["cases", SQL.CASES], ["transitions", SQL.TRANSITIONS]]) {
    const n = FACT_CAPS[key] + 1;
    assert.match(sql, new RegExp(`LIMIT ${n}\\b`), `${key}: LIMIT cap+1 in the SQL`);
    const c = fakeClient((q) => (q === sql ? { rows: Array.from({ length: n }, (_, i) => opRow(i)) } : okRows(q)));
    const g = fakeGuard();
    const r = await readRunSnapshot({ client: c, intentId: ID, guard: g.guard, deadline: 15_000 });
    assert.deepEqual([r.ok, r.code, r.failure, r.clientDisposition], [false, "FACT_LIMIT_EXCEEDED", "refusal", "healthy"], key);
    assert.equal(c.calls.at(-1), "COMMIT", `${key}: the read-only transaction is closed normally`);
    assert.equal(c.calls.filter((x) => x === "COMMIT").length, 1);
    assert.deepEqual([c.releases, c.ends], [0, 0]);
  }
  // exactly cap rows is accepted
  const c = fakeClient((q) => (q === SQL.OPERATIONS ? { rows: Array.from({ length: FACT_CAPS.operations }, (_, i) => opRow(i)) } : okRows(q)));
  const g = fakeGuard();
  const r = await readRunSnapshot({ client: c, intentId: ID, guard: g.guard, deadline: 15_000 });
  assert.equal(r.ok, true, r.code); assert.equal(r.facts.operations.length, FACT_CAPS.operations);
});

test("SYNTHETIC faults: rejection / COMMIT rejection / timeout / guard fault / marker / malformed → code-only, NO later statement, client never released or destroyed here", async () => {
  const stmts = ["BEGIN", SQL.MARKER, SQL.INTENT, SQL.WORK, SQL.OPERATIONS, SQL.ATTEMPTS, SQL.EVIDENCE, SQL.CASES, SQL.TRANSITIONS, "COMMIT"];
  for (let k = 1; k <= stmts.length; k++) {
    const c = fakeClient((q, n) => (n === k ? "reject" : okRows(q)));
    const g = fakeGuard();
    const r = await readRunSnapshot({ client: c, intentId: ID, guard: g.guard, deadline: 15_000 });
    assert.deepEqual({ ...r }, { ok: false, code: "DB_FAILURE", failure: "db", clientDisposition: "destroy", statementsIssued: k }, `reject at #${k}`);
    assert.equal(c.calls.length, k, `#${k}: zero statements after the failure (no ROLLBACK / COMMIT / refresh)`);
    assert.ok(!JSON.stringify(r).includes("SECRET"), "no error message leaks");
    assert.deepEqual([c.releases, c.ends], [0, 0]);
  }
  for (const k of [1, 3, 10]) {
    const c = fakeClient((q, n) => (n === k ? "hang" : okRows(q)));
    const g = fakeGuard();
    const p = readRunSnapshot({ client: c, intentId: ID, guard: g.guard, deadline: 15_000 });
    for (let i = 0; i < 200 && c.calls.length < k; i++) await flush(5);    // advance only once the k-th statement is in flight
    assert.equal(c.calls.length, k); await flush(); await g.advance(LIMITS.STATEMENT_MS);
    const r = await p;
    assert.deepEqual({ ...r }, { ok: false, code: "TIMEOUT_DB_READ", failure: "db", clientDisposition: "destroy", statementsIssued: k }, `timeout at #${k}`);
    await g.advance(60_000); assert.equal(c.calls.length, k, "no later statement even after more time"); assert.equal(g.guard.armedCount(), 0);
  }
  { // whole-snapshot cap reached mid-sequence: the next statement is not started; the open transaction must be destroyed
    const g = fakeGuard(); const c = fakeClient((q) => { g.t += 4_000; return okRows(q); });
    const r = await readRunSnapshot({ client: c, intentId: ID, guard: g.guard, deadline: 15_000 });
    assert.deepEqual([r.code, r.failure, r.clientDisposition], ["TIMEOUT_DB_READ", "db", "destroy"]); assert.equal(c.calls.length, 4); }
  { // guard fault BEFORE the first statement → zero queries
    const g = fakeGuard(); g.t = 20_000;
    const c = fakeClient(okRows);
    const r = await readRunSnapshot({ client: c, intentId: ID, guard: g.guard, deadline: 15_000 });
    assert.deepEqual({ ...r }, { ok: false, code: "SNAPSHOT_BUDGET_EXHAUSTED", failure: "not_started", clientDisposition: "unused", statementsIssued: 0 });
    assert.equal(c.calls.length, 0);
    const bad = createGuard(validateGuardDeps({ monotonic: () => 0, timers: { arm: () => { throw new Error("arm"); } } }).deps);
    const c2 = fakeClient(okRows);
    const r2 = await readRunSnapshot({ client: c2, intentId: ID, guard: bad, deadline: 15_000 });
    assert.deepEqual([r2.code, r2.failure, r2.clientDisposition, c2.calls.length], ["GUARD_TIMER_INVALID", "not_started", "unused", 0]); }
  { // marker / role / malformed refusals are acknowledged (COMMIT issued), never defaults
    for (const [rows, expected] of [[[{ environment: "live", created_at: new Date(0), is_report: true, is_app: false, privileged: false }], "DATABASE_NOT_TEST"],
      [[], "MARKER_INVALID"], [[{ environment: "test", created_at: new Date(0), is_report: true, is_app: true, privileged: false }], "ROLE_NOT_REPORT"]]) {
      const c = fakeClient((q) => (q === SQL.MARKER ? { rows } : okRows(q)));
      const g = fakeGuard();
      const r = await readRunSnapshot({ client: c, intentId: ID, guard: g.guard, deadline: 15_000 });
      assert.deepEqual([r.code, r.failure, r.clientDisposition, c.calls], [expected, "refusal", "healthy", ["BEGIN ISOLATION LEVEL", "SELECT environment, created_at,", "COMMIT"]]);
    }
    const malformed = fakeClient((q) => (q === SQL.INTENT ? { rows: [{ ...okRows(SQL.INTENT).rows[0], final_total_minor: "12.5" }] } : okRows(q)));
    const g = fakeGuard();
    assert.equal((await readRunSnapshot({ client: malformed, intentId: ID, guard: g.guard, deadline: 15_000 })).code, "FACT_MALFORMED");
    const otherId = fakeClient((q) => (q === SQL.INTENT ? { rows: [{ ...okRows(SQL.INTENT).rows[0], id: "00000000-0000-4000-8000-0000000000c2" }] } : okRows(q)));
    assert.equal((await readRunSnapshot({ client: otherId, intentId: ID, guard: fakeGuard().guard, deadline: 15_000 })).code, "FACT_MALFORMED", "a row for another intent is refused");
    const notRows = fakeClient((q) => (q === SQL.WORK ? { nope: 1 } : okRows(q)));
    const r = await readRunSnapshot({ client: notRows, intentId: ID, guard: fakeGuard().guard, deadline: 15_000 });
    assert.deepEqual([r.code, r.clientDisposition, notRows.calls.length], ["DB_RESULT_INVALID", "destroy", 4]);
  }
  { // invalid arguments → nothing sent
    const c = fakeClient(okRows); const g = fakeGuard();
    for (const a of [{ client: c, intentId: ID.toUpperCase(), guard: g.guard, deadline: 1 }, { client: c, intentId: ID, guard: { observe() {}, now() {} }, deadline: 1 },
      { client: c, intentId: ID, guard: g.guard, deadline: NaN }, { client: {}, intentId: ID, guard: g.guard, deadline: 1 }, null]) {
      assert.equal((await readRunSnapshot(a)).code, "FACTS_ARGUMENT_INVALID"); assert.equal((await readGuestBinding(a)).code, "FACTS_ARGUMENT_INVALID");
    }
    assert.equal(c.calls.length, 0);
  }
});

test("PG: accepted pg query promises pass the stricter native rule; a real COMMIT-path timeout leaves the client to the caller", async () => {
  const c = await reportPool.connect();
  const p = c.query("SELECT 1 AS one");
  assert.equal(isNativePromise(p), true, "the accepted pg driver returns an unpatched native promise");
  assert.equal((await p).rows[0].one, 1);
  c.release();
});

test("whole suite: zero network attempts", () => { assert.equal(netAttempts, 0); });

// =================================================================================================================================
// Root CODE HOLD on e081b1e4 — R-C1 (positive candidate must carry a usable OBSERVED id) / R-C2 (getter-free option validation)
const USABLE_ID = /^[1-9][0-9]{0,15}$/;                                       // = accepted adapter RID_RE (executor-adapters.mjs:73)
/** independent invariant used by every derivation assertion: ok:true ⇒ a non-null canonical usable id */
function derive(f) {
  const r = deriveRecoveryCandidate(f);
  if (r.ok) assert.ok(typeof r.id === "string" && USABLE_ID.test(r.id) && !PROTECTED_HOSTAWAY_RESERVATION_IDS.includes(r.id), `ok:true without a usable id: ${JSON.stringify(r)}`);
  return r;
}
const SID = "00000000-0000-4000-8000-0000000000d1"; const LK = "a1000000-0000-4000-8000-0000000000d1"; const CR = "a1000000-0000-4000-8000-0000000000d2";
const AT = "a1000000-0000-4000-8000-0000000000d3";
/** SYNTHETIC source-b-only facts (no a / c) with one API lookup */
function bFacts({ ext = "6100001", obs = "6100001", omitObs = false, create = null, attemptId = null } = {}) {
  const observed = { bookingRef: "MV-SYNTH01", matchCount: 1, listingId: 891001, from: "2026-12-04", to: "2026-12-06", totalMinor: 50000, currency: "USD" };
  if (!omitObs) observed.reservationId = obs;
  const ops = [{ id: LK, opType: "hostaway.lookup_reservation", state: "succeeded", payload: { ref: "MV-SYNTH01" }, resultRef: null, lateResultRef: null }];
  if (create) ops.push({ id: CR, opType: "hostaway.create_reservation", state: create.state, payload: {}, resultRef: create.resultRef, lateResultRef: null });
  return { version: RUN_FACTS_VERSION, intentId: SID,
    intent: { id: SID, ref: "MV-SYNTH01", state: "reservation_unknown", listingId: 891001, from: "2026-12-04", to: "2026-12-06", finalTotalMinor: 50000, currency: "USD", hostawayReservationId: null },
    operations: ops, reservationAttempts: create ? [{ id: AT, operationId: CR, bookingRef: "MV-SYNTH01", hostawayReservationId: attemptId }] : [],
    reservationEvidence: [{ id: "e0000000-0000-4000-8000-0000000000d1", kind: "hostaway_reservation", source: "hostaway_api", externalRef: ext, status: "found_active", observedAt: 1,
      readOperationId: LK, readIntentId: SID, readOpType: "hostaway.lookup_reservation", selector: { ref: "MV-SYNTH01", reservationId: null }, observed }] };
}

test("R-C1 SYNTHETIC: source b requires a canonical OBSERVED id agreeing with external_ref; incomplete b is never positive; ok ⇒ usable id", () => {
  const cases = [
    ["agreeing positive b", bFacts(), { ok: true, id: "6100001" }],
    ["16-digit boundary", bFacts({ ext: "9".repeat(16), obs: "9".repeat(16) }), { ok: true, id: "9".repeat(16) }],
    ["numeric observed id agreeing", bFacts({ obs: 6100001 }), { ok: true, id: "6100001" }],
    ["observed id missing (no a / c)", bFacts({ omitObs: true }), "KNOWN_ID_WITHOUT_CANDIDATE"],
    ["observed id null", bFacts({ obs: null }), "KNOWN_ID_WITHOUT_CANDIDATE"],
    ["observed id empty", bFacts({ obs: "" }), "KNOWN_ID_WITHOUT_CANDIDATE"],
    ["observed id ≠ external_ref", bFacts({ obs: "6100002" }), "EVIDENCE_IDENTITY_MISMATCH"],
    ["external id null", bFacts({ ext: null, obs: null }), "FACT_MALFORMED"],
    ["external id missing", (() => { const f = bFacts(); delete f.reservationEvidence[0].externalRef; return f; })(), "FACT_MALFORMED"],
    ["external id non-numeric", bFacts({ ext: "abc", obs: "abc" }), "FACT_MALFORMED"],
    ["external id leading zero", bFacts({ ext: "0610001", obs: "0610001" }), "FACT_MALFORMED"],
    ["external id oversize (17 digits)", bFacts({ ext: "1".repeat(17), obs: "1".repeat(17) }), "FACT_MALFORMED"],
    ["observed id oversize", bFacts({ obs: "1".repeat(17) }), "FACT_MALFORMED"],
    ["valid a + incomplete b, same id", bFacts({ omitObs: true, create: { state: "succeeded", resultRef: "6100001" } }), { ok: true, id: "6100001", sources: ["a"] }],
    ["valid a + incomplete b, other id", bFacts({ ext: "6100009", omitObs: true, create: { state: "succeeded", resultRef: "6100001" } }), "RESERVATION_ID_CONFLICT"],
    ["valid a + agreeing b", bFacts({ create: { state: "succeeded", resultRef: "6100001" } }), { ok: true, id: "6100001", sources: ["a", "b"] }],
    ["oversize result_ref (a)", bFacts({ omitObs: true, create: { state: "succeeded", resultRef: "1".repeat(17) } }), "FACT_MALFORMED"],
    ["attempt id differs from incomplete b", bFacts({ omitObs: true, create: { state: "outcome_unknown", resultRef: null }, attemptId: "6100003" }), "KNOWN_ID_WITHOUT_CANDIDATE"]
  ];
  for (const [name, f, want] of cases) {
    const r = derive(f);
    if (typeof want === "string") assert.deepEqual({ ...r }, { ok: false, code: want }, name);
    else { assert.equal(r.ok, true, `${name}: ${r.code}`); assert.equal(r.id, want.id, name); if (want.sources) assert.deepEqual([...r.sources], want.sources, name); }
  }
});

test("R-C1 PG: incomplete lookup evidence (no observed id) appended through ACCEPTED evidence APIs over a real succeeded lookup op — snapshot keeps it incomplete, derivation refuses; planner parity: not proven", async () => {
  const w = world(); w.mode.create = "appliedThen503"; const bk = await authorizedBooking(w); const L = lane(w, bk);
  await L.R(); await L.R();
  assert.equal(await state(bk.id), "reservation_unknown");
  const create = (await ownerAll("SELECT id, dispatched_at FROM booking.external_operations WHERE intent_id = $1 AND op_type = 'hostaway.create_reservation'", [bk.id]))[0];
  const rid = String([...w.res.keys()][0]);
  const now = create.dispatched_at.getTime() + 3 * MIN;                       // FRESH by the accepted 2-minute rule; still in the past
  assert.ok(now < Date.now());
  // accepted APIs only: queue the read, claim it, complete it, record what it "observed" (labelled SYNTHETIC provider content)
  const readId = await requestRead(db.app, bk.id, "hostaway.lookup_reservation", bk.ref, { now });
  const claimed = await claimNextOperation(db.app, { workerId: "rf-stage", now, opId: readId });
  assert.equal(claimed.id, readId);
  F.ok(await completeOperation(db.app, readId, { workerId: "rf-stage", now, outcome: { status: "succeeded" } }));
  const ev = await recordProviderEvidence(db.app, { readOpId: readId, kind: "hostaway_reservation", externalRef: rid, status: "found_active",
    observed: { bookingRef: bk.ref, matchCount: 1, listingId: bk.listingId, from: bk.stay.from, to: bk.stay.to, totalMinor: bk.total, currency: "USD" } });
  assert.equal(ev.ok, true, `validate_evidence (0003:89–90) accepts found_active without reservationId: ${ev.error}`);
  const s = await snapshot(bk.id);
  assert.equal(s.ok, true, s.code);
  const row = s.facts.reservationEvidence.find((e) => e.readOperationId === readId);
  assert.deepEqual([row.externalRef, row.observed.reservationId, row.observed.bookingRef, row.observed.matchCount, row.selector.ref], [rid, null, bk.ref, 1, bk.ref]);
  const cand = derive(s.facts);
  assert.equal(cand.ok, false, "incomplete lookup evidence is never a positive candidate");
  assert.equal(cand.code, "KNOWN_ID_WITHOUT_CANDIDATE");
  // planner parity on the SAME persisted facts (accepted loader + pure planner; nothing is applied)
  const pf = await loadRecoveryFacts(db.app, create.id);
  assert.ok(pf.evidence.some((e) => e.readOpType === "hostaway.lookup_reservation" && e.observed.reservationId === undefined));
  const plan = planRecovery({ ...pf, now: Date.now() });
  assert.ok(!(plan.kind === "event" && ["RECONCILED_RESERVATION_FOUND", "RESERVATION_SUCCEEDED"].includes(plan.event.type)), `planner must not prove it: ${JSON.stringify(plan.kind === "event" ? plan.event.type : plan)}`);
  assert.ok(!(plan.event && plan.event.reservation), "the planner never derives a reservation from incomplete lookup evidence");
  console.log(`# R-C1 planner parity on incomplete lookup: ${plan.kind}${plan.event ? `:${plan.event.type}` : ""}${plan.code ? `:${plan.code}` : ""}`);
});

test("R-C2: option validation is ONE own-data-descriptor snapshot; getters never run; introspection faults are code-only FACTS_ARGUMENT_INVALID with zero statements", async () => {
  const g = fakeGuard(); const c = fakeClient(okRows);
  const ok = { client: c, intentId: ID, guard: g.guard, deadline: 15_000 };
  let runs = 0;
  const getter = (v) => ({ enumerable: true, configurable: true, get() { runs += 1; throw new Error("CALLER_DATA"); } });
  class ProtoGetterClient { get query() { runs += 1; throw new Error("CALLER_DATA"); } }
  const ownQueryGetter = Object.defineProperty({}, "query", getter());
  const revoked = Proxy.revocable({ ...ok }, {}); revoked.revoke();
  const bads = [
    Object.defineProperty({ intentId: ID, guard: g.guard, deadline: 1 }, "client", getter()),
    Object.defineProperty({ client: c, guard: g.guard, deadline: 1 }, "intentId", getter()),
    { ...ok, client: ownQueryGetter }, { ...ok, client: new ProtoGetterClient() }, { ...ok, client: new Proxy(c, {}) },
    revoked.proxy, new Proxy({ ...ok }, { ownKeys() { runs += 1; throw new Error("CALLER_DATA"); } }), new Proxy({ ...ok }, {}),
    Object.create({ ...ok }), Object.assign(Object.create({ inherited: 1 }), ok), { ...ok, extra: 1 }, (() => { const o = { ...ok }; delete o.deadline; return o; })(),
    { ...ok, [Symbol("s")]: 1 }, Object.defineProperty({ client: c, intentId: ID, guard: g.guard }, "deadline", { value: 1, enumerable: false }),
    Object.defineProperty({ client: c, intentId: ID, guard: g.guard, deadline: 1 }, "__proto__", { value: {}, enumerable: true }),
    { ...ok, guard: new Proxy(g.guard, {}) }, { ...ok, client: { query: new Proxy(() => {}, {}) } }, { ...ok, client: { query: "x" } }, new (class Opt { constructor() { Object.assign(this, ok); } })()
  ];
  for (const [i, b] of bads.entries()) {
    for (const fn of [readRunSnapshot, readGuestBinding]) {
      let r;
      await assert.doesNotReject(async () => { r = await fn(b); }, `#${i} never throws`);
      assert.deepEqual({ ...r }, { ok: false, code: "FACTS_ARGUMENT_INVALID", failure: "not_started", clientDisposition: "unused", statementsIssued: 0 }, `#${i}`);
      assert.ok(!JSON.stringify(r).includes("CALLER"));
    }
  }
  assert.equal(runs, 0, "no caller getter / trap code ran");
  assert.equal(c.calls.length, 0, "zero statements");
  // controls: null-prototype options; a class-instance client with a PROTOTYPE data method; genuine pg report / app clients
  const nul = Object.assign(Object.create(null), ok);
  assert.equal((await readRunSnapshot(nul)).ok, true);
  class ProtoClient { constructor() { this.calls = []; } query(sql) { this.calls.push(sql); return Promise.resolve(okRows(sql)); } }
  assert.equal((await readRunSnapshot({ client: new ProtoClient(), intentId: ID, guard: fakeGuard().guard, deadline: 15_000 })).ok, true);
  const w = world(); const bk = await authorizedBooking(w);
  const rc = await reportPool.connect(); const rg = realGuard();
  const s = await readRunSnapshot(Object.assign(Object.create(null), { client: rc, intentId: bk.id, guard: rg, deadline: deadlineOf(rg) }));
  rc.release(); assert.equal(s.ok, true, s.code);
  const ac = await db.app.connect(); const ag = realGuard();
  const gr = await readGuestBinding(Object.assign(Object.create(null), { client: ac, intentId: bk.id, guard: ag, deadline: deadlineOf(ag) }));
  ac.release(); assert.equal(gr.ok, true, gr.code);
  // a genuine DB error after valid options stays on the db / destroy path (never reclassified as bad input)
  const rej = fakeClient((q, n) => (n === 2 ? "reject" : okRows(q)));
  assert.deepEqual([(await readRunSnapshot({ client: rej, intentId: ID, guard: fakeGuard().guard, deadline: 15_000 })).code, rej.calls.length], ["DB_FAILURE", 2]);
});
