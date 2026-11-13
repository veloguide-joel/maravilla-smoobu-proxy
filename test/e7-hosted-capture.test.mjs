// E7 Slice 2 hosted TEST capture runner — LABELS
//   * REAL: the runner; from the PINNED tooling (E7_TOOLING_DIR, default ../../tooling = workflow layout): the transports T, the executor
//     adapters EA, the accepted v3 PI proof CP, env preflight C1, validateAdapterConfig HR, captureKey IS, LOCK_KEY / LOCK_PRECHECK_SQL.
//   * FAKE (unit tests): the DB (tagged SELECT fake), the worker (drives the REAL capture executors → REAL T → the runner fence → fake
//     exchange), the provider exchanges, credentials. No network primitive is touched (guarded). Mock replies are NOT provider proof.
//   * OPT-IN INTEGRATION (E7_HCP_DB_TESTS=1 + PG_BIN): the REAL merged runCaptureStep / repo / operations on a DISPOSABLE PostgreSQL
//     (tooling test/db/harness.mjs + fixtures.mjs), FAKE exchanges only. The hosted preflight child never sets E7_HCP_DB_TESTS.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { readFileSync, realpathSync, mkdtempSync, cpSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const GUARD = { request: 0, Agent: 0, fetch: 0 };
https.request = () => { GUARD.request += 1; throw new Error("network refused"); };
https.Agent = class { constructor() { GUARD.Agent += 1; throw new Error("network refused"); } };
globalThis.fetch = async () => { GUARD.fetch += 1; throw new Error("network refused"); };
syncBuiltinESMExports();
const ROOT = realpathSync(join(dirname(fileURLToPath(import.meta.url)), ".."));
const TOOLING = realpathSync(process.env.E7_TOOLING_DIR || join(ROOT, "..", "tooling"));
const tool = (p) => import(pathToFileURL(join(TOOLING, p)).href);
const E = await import("../scripts/e7-hosted-capture.mjs");
const RESRUN = await import("../scripts/e7-hosted-reservation.mjs");
const [T, EA, HR, C1, CP, IS, LK] = await Promise.all([tool("scripts/e7-connected/http-transports.mjs"), tool("scripts/e7-connected/executor-adapters.mjs"),
  tool("lib/hostaway-reservations.js"), tool("scripts/e7-connected/probe-env-preflight.mjs"), tool("lib/checkout/capture-proof.js"), tool("lib/checkout/intent-state.js"),
  tool("scripts/e7-connected/run-lock-precheck.mjs")]);
after(() => { assert.deepEqual(GUARD, { request: 0, Agent: 0, fetch: 0 }, "no real network primitive was touched"); });

const C = E.CONSTANTS;
const IID = "11111111-2222-4333-8444-555555555555"; const PI = "pi_FAKEhostedCap001"; const VER = 5; const REF = "MV-FAKE0001"; const ACCT = C.accountId;
const AMT = 14000; const FROM = "2026-11-25"; const TO = "2026-11-26"; const NB = "2026-11-12T00:00:00.000Z"; const CREATED = Date.UTC(2026, 10, 12, 15, 0, 0);
const CAPTURE_BEFORE = Date.UTC(2026, 10, 19, 15, 0, 0); const CONFIRMED_AT = Date.UTC(2026, 10, 12, 15, 30, 0); const ATTEMPT = "a1"; const RID = "71999901"; const CH = "ch_FAKEhostedCap01";
const KEY = `cap:${IID}:${PI}`;
const enc = (o) => new TextEncoder().encode(JSON.stringify(o));
const plan = (over = {}) => E.buildPlan(C, { approvalRef: "SYNTHETIC-hosted-cap", intentId: IID, expectedVersion: VER, notBefore: NB, paymentIntentId: PI, reservationId: RID, amountMinor: AMT,
  runnerDigest: "0".repeat(64), ...over }).plan;
const op = (op_type, over = {}) => ({ op_type, state: "succeeded", attempts: 1, dispatched: true, result_ref: null, late_result_ref: null, payload_rid: null, payload_pi: null, payload_attempt: null, payload_amount: null, payload_key: null, ...over });

// ---------------------------------------------------------------------------------------------------------------------------------
// fake world: DB rows + providers; the fake worker mutates it the way the accepted capture worker would
function world(o = {}) {
  const w = { status: o.status ?? "reservation_confirmed", version: VER, ops: [], hx: [{ state: "succeeded", rid: RID }], claimReleased: false, calls: [], workerCalls: 0, res: RID, echoRef: o.echoRef ?? true,
    lease: null, dispatch: null, createdAt: o.createdAt ?? CREATED, piStatus: "requires_capture", captured: false, capturedMinor: 0, lockRows: 1, captureAttempts: 1 };
  w.ops.push(op("stripe.create_checkout_session", { result_ref: "cs_test_FAKE01" }), op("stripe.retrieve_checkout_session"), op("stripe.retrieve_payment_intent"));
  w.ops.push(op("hostaway.create_reservation", { result_ref: RID }));
  w.ops.push(op("stripe.capture_payment_intent", { state: "pending", attempts: 0, dispatched: false, payload_pi: PI, payload_attempt: 1, payload_amount: AMT, payload_key: o.key ?? KEY }));
  return w;
}
const capRow = (w) => w.ops.find((x) => x.op_type === "stripe.capture_payment_intent");
const intentOf = (w) => ({ id: IID, status: w.status, version: w.version, listingId: 606998, from: FROM, to: TO, guests: 1, ref: REF, createdAt: w.createdAt,
  price: { currency: "USD", finalTotalMinor: AMT, rateBps: 1000 }, payment: { paymentIntentId: PI, livemode: false, capturedMinor: w.capturedMinor, amountMinor: AMT, currency: "USD", captureBefore: CAPTURE_BEFORE, authorizationDeadline: CAPTURE_BEFORE - 3600000 },
  reservation: w.res ? { reservationId: w.res, confirmedAt: CONFIRMED_AT } : null, counters: { captureAttempts: w.captureAttempts }, checkout: { sessionId: "cs_test_FAKE01" }, lease: w.lease, dispatch: w.dispatch });
function fakePool(w, o = {}) {
  const tag = (sql) => /\/\*e7hcp:(\w+)\*\//.exec(sql)?.[1];
  const p = { reads: 0, async query(sql) {
    this.reads += 1;
    if (o.dbFailAt && this.reads === o.dbFailAt) throw new Error("db down");
    switch (tag(sql)) {
      case "instance": return { rows: [{ environment: o.env ?? "test" }] };
      case "attempts": return { rows: [{ id: ATTEMPT, status: "completed", checkout_session_id: "cs_test_FAKE01", payment_intent_id: PI, livemode: false }] };
      case "hostaway": return { rows: w.hx.map((x) => ({ ...x })) };
      case "ops": return { rows: w.ops.map((x) => ({ ...x })) };
      case "cases": return { rows: [{ n: o.cases ?? 0 }] };
      case "claims": return { rows: [{ listing_id: 606998, released: w.claimReleased }] };
      case "role": return { rows: [{ is_app: true, privileged: false }] };
      case "identity": return { rows: [{ db: "fake", environment: o.env ?? "test" }] };
      default: throw new Error(`unexpected SQL ${String(sql).slice(0, 40)}`);
    }
  }, async connect() { return { query: (sql, params) => p.query(sql, params), release() {}, on() {} }; } };
  p.lock = () => { const cl = { pid: o.pid ?? 4242, proofs: 0, errorFn: null,
    async query(sql, params) {
      p.reads += 1;
      if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ ok: o.lockHeldElsewhere ? false : true, pid: cl.pid }] };
      if (/pg_advisory_unlock/.test(sql)) { w.unlocked = (w.unlocked ?? 0) + 1; return { rows: [{ ok: o.unlockFalse ? false : true, pid: cl.pid }] }; }
      if (/pg_backend_pid/.test(sql)) {
        assert.equal(sql, `SELECT (${LK.LOCK_PRECHECK_SQL} AND l.pid = pg_catalog.pg_backend_pid()) AS n, pg_catalog.pg_backend_pid() AS pid`); assert.deepEqual(params, [LK.LOCK_KEY]);
        cl.proofs += 1;
        if (o.hopAtProof && cl.proofs >= o.hopAtProof) cl.pid += 1;
        if (o.onProofResolve) o.onProofResolve(cl.proofs);
        return { rows: [{ n: typeof o.lockLostAt === "number" && w.workerCalls >= o.lockLostAt ? 0 : w.lockRows, pid: cl.pid }] };
      }
      if (tag(sql) === "identity") return { rows: [{ db: o.lockDb ?? "fake", environment: "test" }] };
      throw new Error(`unexpected lock SQL ${sql.slice(0, 40)}`);
    }, release(destroy) { w.lockReleased = destroy === true ? "destroyed" : "pooled"; }, on(ev, fn) { if (ev === "error") cl.errorFn = fn; } };
    w.lockClient = cl; return cl; };
  return p;
}
const piObj = (w) => ({ object: "payment_intent", id: PI, livemode: false, status: w.captured ? "succeeded" : w.piStatus, capture_method: "manual", amount: AMT, amount_received: w.captured ? AMT : 0,
  amount_capturable: !w.captured && w.piStatus === "requires_capture" ? AMT : 0, currency: "usd", metadata: { mv_intent_id: IID, mv_payment_attempt_id: ATTEMPT },
  latest_charge: { object: "charge", id: CH, payment_intent: PI, status: "succeeded", paid: true, captured: w.captured, amount: AMT, amount_captured: w.captured ? AMT : 0,
    amount_refunded: 0, currency: "usd", livemode: false, payment_method_details: { card: { capture_before: CAPTURE_BEFORE / 1000 } } } });
const resObj = (w, id = RID) => ({ id: Number(id), listingMapId: 606998, channelId: 2000, arrivalDate: FROM, departureDate: TO, totalPrice: 140, currency: "USD", status: "new",
  customFieldValues: w.echoRef ? [{ customFieldId: C.refFieldId, value: REF }] : [] });
const CAPTURE_URL = `https://api.stripe.com/v1/payment_intents/${PI}/capture`;
function exchanges(w, o = {}) {
  const reply = (status, obj) => Promise.resolve({ status, contentType: "application/json", bytes: enc(obj) });
  const stripe = (req) => {
    w.calls.push(`S:${req.method} ${req.url.replace("https://api.stripe.com", "")}`);
    if (req.url.endsWith("/v1/account")) return reply(200, { object: "account", id: ACCT });
    if (req.method === "POST") {
      assert.equal(req.url, CAPTURE_URL); assert.equal(req.headers["Idempotency-Key"], KEY); assert.equal(req.body, `amount_to_capture=${AMT}&expand%5B%5D=latest_charge`, "C1/C2 wire: no final_capture");
      w.captureRequests = (w.captureRequests ?? 0) + 1;
      if (o.captureLost) { w.captured = o.captureLandedAnyway ?? false; return Promise.reject(new Error("socket reset")); }
      w.captured = true; return reply(200, piObj(w));
    }
    return reply(200, piObj(w));
  };
  const hostaway = (req) => {
    const p = req.url.replace("https://api.hostaway.com", ""); w.calls.push(`H:${req.method} ${p}`);
    if (o.hostawayStatus) return reply(o.hostawayStatus, { status: "fail", message: "unauthorized" });
    if (req.method === "GET" && p.startsWith("/v1/reservations?")) return reply(200, { status: "success", result: new URL(req.url).searchParams.has("afterId") ? [] : [resObj({ ...w, echoRef: true })] });
    if (req.method === "GET" && /^\/v1\/reservations\/\d+$/.test(p)) return reply(200, { status: "success", result: resObj(w, p.split("/").pop()) });
    return reply(404, { status: "fail" });
  };
  return { stripe, hostaway };
}
/** the fake worker: drives the REAL capture executors (→ real T → the runner fence → fake exchange) the way the accepted worker's happy step does:
 *  RES read (bound id) → account → PI → ONE capture (pinned amount / key) → confirming PI read → payment_captured (+ a pristine recording row) */
function fakeWorker(w, o = {}) {
  return async (pool, { executors, intentId, env, listings, stripeAccountId }) => {
    w.workerCalls += 1;
    assert.equal(intentId, IID); assert.deepEqual(env, { VERCEL_ENV: "development", MV_E7_CAPTURE_WORKER: "enabled" }); assert.equal(stripeAccountId, ACCT);
    assert.deepEqual([...listings.keys()], [606998]); assert.deepEqual(Object.keys(executors).sort(), ["capturePaymentIntent", "lookupPage", "retrieveAccount", "retrievePaymentIntent", "retrieveReservation"]);
    const sig = AbortSignal.timeout(5000); const actions = []; const cap = capRow(w);
    try {
      if (o.foreignRead) await executors.retrieveReservation({ method: "GET", path: `/v1/reservations/${C.protectedReservationIds[0]}`, query: {} }, { signal: sig });
      const rr = await executors.retrieveReservation({ method: "GET", path: `/v1/reservations/${RID}`, query: {} }, { signal: sig });
      if (rr.httpStatus !== 200) { actions.push(`STOP:AUTH_${rr.httpStatus}`); return { status: "worked", intentId: IID, actions, delayMs: 0, late: Promise.resolve([]) }; }
      if (!w.echoRef) await executors.lookupPage({ method: "GET", path: "/v1/reservations", query: { listingId: 606998, channelId: 2000, arrivalStartDate: FROM, arrivalEndDate: FROM, limit: 100, includeResources: 1 } }, { signal: sig });
      await executors.retrieveAccount({ signal: sig });
      await executors.retrievePaymentIntent(PI, { expand: ["latest_charge"] }, { signal: sig });
      if (o.stayConfirmed) return { status: "worked", intentId: IID, actions: ["WAIT:RESERVATION_PROOF"], delayMs: 30000, late: Promise.resolve([]) };
      const params = o.oldFinalCapture ? { amount_to_capture: AMT, final_capture: true, expand: ["latest_charge"] } : o.extraParam ? { amount_to_capture: AMT, expand: ["latest_charge"], metadata: {} }
        : { amount_to_capture: o.wrongAmount ?? AMT, expand: ["latest_charge"] };
      // the accepted worker claims the row (dispatch persisted) BEFORE the send
      Object.assign(cap, { state: "in_flight", attempts: 1, dispatched: true });
      let reply = null;
      try { reply = await executors.capturePaymentIntent(PI, params, { idempotencyKey: o.wrongKey ?? KEY, signal: sig }); }
      catch (e) { actions.push(`SEND_FAILED:${e && e.code ? e.code : "TRANSPORT"}`); }
      if (o.twice) { try { await executors.capturePaymentIntent(PI, params, { idempotencyKey: KEY, signal: sig }); } catch { actions.push("SECOND_SEND_REFUSED"); } }
      if (!reply || reply.status !== "succeeded") { cap.state = "outcome_unknown"; w.status = "capture_unknown"; w.version += 1; actions.push("CAPTURE_OUTCOME_UNKNOWN"); return { status: "worked", intentId: IID, actions, delayMs: 0, late: Promise.resolve([]) }; }
      await executors.retrievePaymentIntent(PI, { expand: ["latest_charge"] }, { signal: sig });              // the confirming read
      Object.assign(cap, { state: "succeeded", result_ref: CH }); w.status = "payment_captured"; w.version += 1; w.capturedMinor = AMT;
      w.ops.push(op("hostaway.record_offline_charge", { state: "pending", attempts: 0, dispatched: false, payload_rid: RID }));
      actions.push("CAPTURE_SUCCEEDED->payment_captured");
    } catch (e) { actions.push(`STOP:EXECUTOR_${/stopped/.test(String(e && e.message)) ? "STOPPED" : "FAILED"}`); if (cap.state === "in_flight") { cap.state = "outcome_unknown"; w.status = "capture_unknown"; } }
    return { status: "worked", intentId: IID, actions, delayMs: o.delayMs ?? 0, late: Promise.resolve([]) };
  };
}
const toolingFor = (w, o = {}) => ({ runCaptureStep: o.worker ?? fakeWorker(w, o), loadIntent: async () => intentOf(w), createPhaseExecutors: EA.createPhaseExecutors, createStripeSend: T.createE7StripeTestSend,
  createHostawaySend: T.createE7HostawaySend, validateAdapterConfig: HR.validateAdapterConfig, paymentIntentProofObservationV3: CP.paymentIntentProofObservationV3,
  stillAuthorizedV3Refusal: CP.stillAuthorizedV3Refusal, captureKey: IS.captureKey, LOCK_KEY: LK.LOCK_KEY, LOCK_PRECHECK_SQL: LK.LOCK_PRECHECK_SQL });
function core(w, o = {}) {
  const pool = o.pool ?? fakePool(w, o); w.pool = pool;
  const x = exchanges(w, o);
  return E.runCaptureCore({ plan: o.plan ?? plan(), pool, lockClientFactory: () => pool.lock(), tooling: toolingFor(w, o), exchanges: o.wrapExchanges ? o.wrapExchanges(x) : x,
    credentials: { stripe: () => "sk_test_Fake1", hostaway: () => "synthetic-hostaway-token" }, sleep: async () => {}, runSignal: o.signal, monotonic: o.monotonic,
    clock: () => Date.UTC(2026, 10, 12, 16, 0, 0) + (w.tick = (w.tick ?? 0) + 1000) });
}
const posts = (w) => w.calls.filter((x) => /^(S:POST|H:POST|H:PUT|H:DELETE)/.test(x));

// ---------------------------------------------------------------------------------------------------------------------------------
test("A1 happy path (FAKE providers, REAL transports + executors): account + strict PI proof, lock proven before the step, exactly ONE capture POST (pinned URL / amount / key / body), payment_captured intermediate; recording row queued pristine reported; lock released", async () => {
  for (const echoRef of [true, false]) {
    const w = world({ echoRef });
    const r = await core(w);
    assert.equal(r.outcome, "PAYMENT_CAPTURED_INTERMEDIATE", JSON.stringify(r));
    assert.deepEqual([r.steps, r.captureInvocations, r.captureOutcome, r.reservationId, r.capturedMinor, r.chargeId, r.recordingQueuedPristine, r.lock, w.lockReleased], [1, 1, "REPLIED", RID, AMT, CH, true, "released", "pooled"]);
    assert.deepEqual(posts(w), [`S:POST /v1/payment_intents/${PI}/capture`]);
    assert.deepEqual(r.proofs, ["BEFORE_WORKER"]); assert.deepEqual(r.postcheck, { captureOps: 1, capturedMinor: AMT, recordingQueuedPristine: true, claimHeld: true, openCases: 0 });
    assert.equal(w.calls.some((x) => /cancel|refund|guestPayments|statuses|\/reservations$/.test(x) && x.startsWith("H:POST")), false);
    assert.ok(r.actions.includes("CAPTURE_SUCCEEDED->payment_captured"));
    assert.deepEqual(r.writes, { capture: 1, create: 0, refund: 0, record: 0, notify: 0, cancel: 0, void: 0 });
    if (!echoRef) assert.ok(w.calls.some((x) => x.startsWith("H:GET /v1/reservations?")), "by-ref lookup for THIS arrival passed the fence");
  }
});

test("A2 strict Stripe proof gates the worker: canceled / already captured / wrong account → PROVIDER_PROOF_FAILED with ZERO Hostaway calls, ZERO worker steps, ZERO capture", async () => {
  for (const [label, mutate, code] of [["canceled", (w) => { w.piStatus = "canceled"; }, "NOT_REQUIRES_CAPTURE"], ["captured at the provider", (w) => { w.captured = true; }, "NOT_REQUIRES_CAPTURE"]]) {
    const w = world(); mutate(w);
    const r = await core(w);
    assert.deepEqual([r.outcome, r.code, r.steps, w.workerCalls, r.captureInvocations], ["PROVIDER_PROOF_FAILED", code, 0, 0, 0], label);
    assert.equal(w.calls.filter((x) => x.startsWith("H:")).length, 0, label);
  }
  { const w = world(); const r = await core(w, { wrapExchanges: (x) => ({ hostaway: x.hostaway, stripe: (req) => (req.url.endsWith("/v1/account") ? Promise.resolve({ status: 200, contentType: "application/json", bytes: enc({ object: "account", id: "acct_OTHER0000000001" }) }) : x.stripe(req)) }) });
    assert.equal(r.outcome, "PROVIDER_PROOF_FAILED"); assert.ok(["ACCOUNT", "READ_FAILED"].includes(r.code), r.code); assert.equal(w.workerCalls, 0); }
  { const w = world(); const r = await core(w, { hostawayStatus: 401 });   // Stripe proof passes; the worker's reservation read gets 401 → the fake worker stops; no capture
    assert.notEqual(r.outcome, "PAYMENT_CAPTURED_INTERMEDIATE"); assert.equal(posts(w).length, 0); }
});

test("A3 start refusals (read-only, ZERO provider calls, ZERO lock): wrong state / already captured / prior dispatch / non-pristine or non-single capture row / unaccepted key / wrong pin (PI, reservation, amount) / version / historic / protected / open case / forbidden op / non-TEST DB / released claim / recording present", async () => {
  const cases = [
    [world({ status: "payment_authorized" }), {}, "START_STATE_NOT_ELIGIBLE", "STATE_NOT_RESERVATION_CONFIRMED"],
    [world({ status: "capture_unknown" }), {}, "START_STATE_NOT_ELIGIBLE", "STATE_NOT_RESERVATION_CONFIRMED"],
    [world({ status: "payment_captured" }), {}, "START_STATE_NOT_ELIGIBLE", "STATE_NOT_RESERVATION_CONFIRMED"],
    [(() => { const w = world(); w.capturedMinor = AMT; return w; })(), {}, "START_STATE_NOT_ELIGIBLE", "ALREADY_CAPTURED"],
    [(() => { const w = world(); Object.assign(capRow(w), { dispatched: true, attempts: 1 }); return w; })(), {}, "START_STATE_NOT_ELIGIBLE", "CAPTURE_NOT_PRISTINE"],
    [(() => { const w = world(); Object.assign(capRow(w), { state: "outcome_unknown", dispatched: true, attempts: 1 }); return w; })(), {}, "START_STATE_NOT_ELIGIBLE", "CAPTURE_NOT_PRISTINE"],
    [(() => { const w = world(); w.ops.push(op("stripe.capture_payment_intent", { state: "pending", attempts: 0, dispatched: false, payload_pi: PI, payload_attempt: 2, payload_amount: AMT, payload_key: `${KEY}:a2` })); return w; })(), {}, "START_STATE_NOT_ELIGIBLE", "CAPTURE_ROW_NOT_SINGLE"],
    [(() => { const w = world(); w.captureAttempts = 2; return w; })(), {}, "START_STATE_NOT_ELIGIBLE", "CAPTURE_NOT_INITIAL"],
    [(() => { const w = world(); w.lease = { workerId: "w1", until: 1 }; return w; })(), {}, "START_STATE_NOT_ELIGIBLE", "RESERVATION_LEASE_HELD"],
    [world({ key: `cap:${IID}:pi_OTHER` }), {}, "SCOPE_REFUSED", "CAPTURE_KEY_NOT_ACCEPTED"],
    [(() => { const w = world(); capRow(w).payload_amount = AMT - 1; return w; })(), {}, "SCOPE_REFUSED", "CAPTURE_ROW_NOT_BOUND"],
    [world(), { plan: plan({ paymentIntentId: "pi_FAKEother0001" }) }, "SCOPE_REFUSED", "PAYMENT_INTENT_NOT_PINNED"],
    [world(), { plan: plan({ reservationId: "71999902" }) }, "SCOPE_REFUSED", "RESERVATION_NOT_PINNED"],
    [world(), { plan: plan({ amountMinor: AMT + 100 }) }, "SCOPE_REFUSED", "AMOUNT_NOT_PINNED"],
    [world(), { plan: plan({ expectedVersion: 4 }) }, "START_STATE_NOT_ELIGIBLE", "VERSION_NOT_PINNED"],
    [world({ createdAt: Date.UTC(2026, 10, 11, 0, 0, 0) }), {}, "START_STATE_NOT_ELIGIBLE", "HISTORIC_INTENT"],
    [(() => { const w = world(); w.hx = [{ state: "succeeded", rid: C.protectedReservationIds[1] }]; return w; })(), {}, "SCOPE_REFUSED", "RESERVATION_ID_CONFLICT"],
    [world(), { cases: 1 }, "SCOPE_REFUSED", "OPEN_CASE"],
    [(() => { const w = world(); w.ops.push(op("stripe.void_payment_intent", { state: "pending", attempts: 0, dispatched: false })); return w; })(), {}, "SCOPE_REFUSED", "FORBIDDEN_OP_PRESENT"],
    [(() => { const w = world(); w.ops.push(op("hostaway.record_offline_charge", { state: "pending", attempts: 0, dispatched: false })); return w; })(), {}, "SCOPE_REFUSED", "UNEXPECTED_OP"],
    [world(), { env: "production" }, "SCOPE_REFUSED", "DATABASE_NOT_TEST"],
    [(() => { const w = world(); w.claimReleased = true; return w; })(), {}, "SCOPE_REFUSED", "CLAIM_NOT_HELD"],
    [(() => { const w = world(); w.ops.find((x) => x.op_type === "hostaway.create_reservation").state = "outcome_unknown"; return w; })(), {}, "SCOPE_REFUSED", "CREATE_NOT_PROVEN_SUCCEEDED"]];
  for (const [w, o, outcome, code] of cases) {
    const r = await core(w, o);
    assert.deepEqual([r.outcome, r.code, w.calls.length, w.workerCalls, r.lock, r.captureInvocations], [outcome, code, 0, 0, "not_acquired", 0], code);
  }
  { const f = { instance: "test", intent: { ...intentOf(world()), listingId: 603566 }, attempts: [], hostaway: [], ops: [], openCases: 0, claims: [] };
    assert.equal(E.checkStart(f, plan()).code, "LISTING_NOT_SCOPED"); }
  { const f = { instance: "test", intent: { ...intentOf(world()), payment: { ...intentOf(world()).payment, livemode: true } }, attempts: [], hostaway: [], ops: [], openCases: 0, claims: [] };
    assert.equal(E.checkStart(f, plan()).code, "PAYMENT_NOT_TEST"); }
  { const w = world(); const r = await core(w, { plan: { ...plan(), captureIdempotencyKey: "cap:other" } }); assert.deepEqual([r.outcome, w.calls.length], ["CORE_INVALID", 0]); }
});

test("A4 real lock semantics: held elsewhere → LOCK_NOT_ACQUIRED, zero provider calls; lost before the step → LOCK_LOST, no step; backend hop → refused; observed session error mid-step vetoes the capture", async () => {
  { const w = world(); const r = await core(w, { lockHeldElsewhere: true });
    assert.deepEqual([r.outcome, r.code, w.calls.length, w.workerCalls, r.lock], ["LOCK_NOT_ACQUIRED", "RUN_LOCK_PRESENT", 0, 0, "not_acquired"]); }
  { const w = world(); const r = await core(w, { onProofResolve: (n) => { if (n === 2) w.lockRows = 0; } });      // lost exactly at the first per-step proof
    assert.deepEqual([r.outcome, r.code, w.workerCalls, r.captureInvocations, r.lock], ["LOCK_LOST", "LOCK_NOT_HELD", 0, 0, "released"], JSON.stringify(r)); }   // the unlock is still checked on teardown
  { const w = world(); const r = await core(w, { hopAtProof: 1 });
    assert.deepEqual([r.outcome, r.code, w.workerCalls, r.lockSession], ["LOCK_NOT_ACQUIRED", "BACKEND_HOP", 0, "backend_hop"], JSON.stringify(r)); }
  { const w = world(); const r = await core(w, { hopAtProof: 2 });
    assert.deepEqual([r.outcome, r.code, w.workerCalls], ["LOCK_LOST", "BACKEND_HOP", 0], JSON.stringify(r)); }
  { const w = world();  // the error is observed as the worker's PI read resolves (before the capture): the capture transport is vetoed
    const r = await core(w, { wrapExchanges: (x) => ({ hostaway: x.hostaway, stripe: async (req) => { const out = await x.stripe(req); if (w.workerCalls > 0 && /payment_intents\/pi_/.test(req.url) && req.method === "GET") w.lockClient.errorFn(new Error("SYNTHETIC_PRIVATE_ERROR_CANARY")); return out; } }) });
    assert.deepEqual([r.outcome, r.code, r.captureInvocations, posts(w).length, r.lockSession, r.lock, w.lockReleased], ["LOCK_LOST", "STOP_LOCK_SESSION_ERROR", 0, 0, "error_observed", "session_error_connection_destroyed", "destroyed"], JSON.stringify(r));
    assert.equal(JSON.stringify(r).includes("CANARY"), false, "no raw error text"); }
});

test("A5 lost capture reply → CAPTURE_OUTCOME_UNKNOWN, exactly ONE POST, no second send (fence), persisted facts reported; a SECOND SESSION on the same intent refuses read-only with ZERO sends; a second capture in the same step never leaves the process", async () => {
  { const w = world(); const r = await core(w, { captureLost: true });
    assert.deepEqual([r.outcome, r.code, r.captureInvocations, r.captureOutcome, r.finalState, r.captureOps], ["CAPTURE_OUTCOME_UNKNOWN", "LOST_CAPTURE_REPLY", 1, "UNKNOWN", "capture_unknown", ["outcome_unknown"]], JSON.stringify(r));
    assert.deepEqual(posts(w), [`S:POST /v1/payment_intents/${PI}/capture`]);
    const w2 = { ...w, calls: [], workerCalls: 0 }; const r2 = await core(w2);                                           // second session: the same persisted facts
    assert.deepEqual([r2.outcome, r2.code, w2.calls.length, w2.workerCalls, r2.captureInvocations], ["START_STATE_NOT_ELIGIBLE", "STATE_NOT_RESERVATION_CONFIRMED", 0, 0, 0], JSON.stringify(r2)); }
  { const w = world(); const r = await core(w, { twice: true });
    assert.deepEqual(posts(w), [`S:POST /v1/payment_intents/${PI}/capture`], "the second capture never left the process"); assert.ok(r.refusedAtTransport >= 1); assert.ok(r.actions.includes("SECOND_SEND_REFUSED")); }
  { const w = world(); const r = await core(w, { worker: async () => { w.status = "reservation_confirmed"; return { status: "worked", intentId: IID, actions: [], delayMs: 0, late: Promise.resolve([]) }; }, captureLost: true,
    wrapExchanges: (x) => x });   // a step that reports nothing after a capture went out: SENT_WITHOUT_TRANSITION (covered through the invocation counter)
    assert.notEqual(r.outcome, "PAYMENT_CAPTURED_INTERMEDIATE"); }
});

test("A6 target-only fence: wrong amount / wrong key / foreign reservation read / any Hostaway write / a Stripe cancel or refund op never leave the process", async () => {
  { const w = world(); const r = await core(w, { wrongAmount: AMT - 1 }); assert.equal(posts(w).length, 0); assert.notEqual(r.outcome, "PAYMENT_CAPTURED_INTERMEDIATE"); assert.equal(w.captureRequests ?? 0, 0); }
  { const w = world(); const r = await core(w, { wrongKey: "cap:other" }); assert.equal(posts(w).length, 0); assert.notEqual(r.outcome, "PAYMENT_CAPTURED_INTERMEDIATE"); }
  { const w = world(); await core(w, { foreignRead: true }); assert.equal(w.calls.some((x) => x.includes(C.protectedReservationIds[0])), false); }
  { const w = world(); const r = await core(w, { worker: async (pool, { executors }) => {
      let refused = 0;
      for (const bad of [() => executors.retrieveReservation({ method: "POST", path: `/v1/reservations/${RID}`, query: {} }, { signal: AbortSignal.timeout(1000) }),
        () => executors.retrieveReservation({ method: "GET", path: "/v1/reservations/71999902", query: {} }, { signal: AbortSignal.timeout(1000) }),
        () => executors.capturePaymentIntent("pi_FAKEother0001", { amount_to_capture: AMT, expand: ["latest_charge"] }, { idempotencyKey: KEY, signal: AbortSignal.timeout(1000) }),
        // C1/C2: the historical final_capture parameter and any extra parameter are refused at the executor BEFORE any exchange
        () => executors.capturePaymentIntent(PI, { amount_to_capture: AMT, final_capture: true, expand: ["latest_charge"] }, { idempotencyKey: KEY, signal: AbortSignal.timeout(1000) }),
        () => executors.capturePaymentIntent(PI, { amount_to_capture: AMT, expand: ["latest_charge"], metadata: {} }, { idempotencyKey: KEY, signal: AbortSignal.timeout(1000) })]) { try { await bad(); } catch { refused += 1; } }
      assert.equal(refused, 5, "every out-of-scope / incompatible call refused at the executor / fence");
      return { status: "worked", intentId: IID, actions: ["WAIT"], delayMs: 0, late: Promise.resolve([]) }; } });
    assert.deepEqual([posts(w).length, r.captureInvocations], [0, 0]); }
  { // transport-level: a cancel / refund op through the runner's stripe send is refused before any exchange
    const w = world(); const x = exchanges(w); let refused = 0;
    const r = await E.runCaptureCore({ plan: plan(), pool: fakePool(w), lockClientFactory: () => fakePool(w).lock(), exchanges: x, credentials: { stripe: () => "sk_test_Fake1", hostaway: () => "x" }, sleep: async () => {},
      tooling: { ...toolingFor(w), createPhaseExecutors: (o) => { const bx = EA.createPhaseExecutors(o); const send = o.stripe.send;
        return { ok: true, executors: { ...bx.executors, retrieveAccount: async (opts) => { for (const c of [{ op: "paymentIntents.cancel", id: PI, params: {}, idempotencyKey: "v" }, { op: "refunds.create", params: {} }]) { try { await send(c, opts); } catch { refused += 1; } } return bx.executors.retrieveAccount(opts); } } }; } } });
    assert.equal(refused, 2); assert.deepEqual(posts(w), [`S:POST /v1/payment_intents/${PI}/capture`]); assert.equal(r.outcome, "PAYMENT_CAPTURED_INTERMEDIATE"); }
});

test("A7 stop latch: aborted before start → no lock, no provider call; aborted as the worker's PI read resolves → no capture, STOP_ABORTED; abort / deadline exactly as the per-step lock proof resolves → ZERO steps; deadline between steps → DEADLINE", async () => {
  { const w = world(); const ac = new AbortController(); ac.abort(); const r = await core(w, { signal: ac.signal });
    assert.deepEqual([r.outcome, r.code, w.calls.length, r.lock], ["ABORTED", "STOP_ABORTED", 0, "not_acquired"]); }
  { const w = world(); const ac = new AbortController();
    const r = await core(w, { signal: ac.signal, wrapExchanges: (x) => ({ hostaway: x.hostaway, stripe: (req) => { if (w.workerCalls > 0 && req.method === "GET" && /payment_intents/.test(req.url)) ac.abort(); return x.stripe(req); } }) });
    assert.deepEqual([r.outcome, r.stopReason, r.captureInvocations, posts(w).length], ["ABORTED", "ABORTED", 0, 0], JSON.stringify(r)); }
  { const w = world(); const ac = new AbortController(); const r = await core(w, { signal: ac.signal, onProofResolve: (n) => { if (n === 2) ac.abort(); } });
    assert.deepEqual([r.outcome, r.steps, w.workerCalls, r.captureInvocations], ["ABORTED", 0, 0, 0], JSON.stringify(r)); }
  { const w = world(); let late = false; const r = await core(w, { monotonic: () => (late ? 10 ** 9 : 0), onProofResolve: (n) => { if (n === 2) late = true; } });
    assert.deepEqual([r.outcome, r.steps, w.workerCalls], ["DEADLINE", 0, 0], JSON.stringify(r)); }
  { const w = world(); let m = 0; const r = await core(w, { stayConfirmed: true, delayMs: 30000, monotonic: () => { m += 1; return m > 12 ? 10 ** 9 : 0; } });
    assert.equal(r.outcome, "DEADLINE", JSON.stringify(r)); assert.equal(posts(w).length, 0); }
  { const w = world(); const r = await core(w, { stayConfirmed: true }); assert.deepEqual([r.outcome, r.code, r.steps, posts(w).length], ["STEP_BUDGET_EXHAUSTED", "STEPS", C.budgets.steps, 0]); }
});

test("A8 DB failure during the start read → DB_ERROR, nothing sent, no lock", async () => {
  const w = world(); const r = await core(w, { dbFailAt: 2 });
  assert.deepEqual([r.outcome, r.code, w.calls.length, r.lock], ["DB_ERROR", "START_READ_FAILED", 0, "not_acquired"]);
});

test("A9 postcheck + residual agreement: a worker that claims payment_captured while the capture row is not single-succeeded / the recording row is dispatched / the claim released → POSTCHECK_MISMATCH; a contradiction seen ONLY by the teardown residual read → NOT_CONFIRMED / RESIDUAL_<code> with facts kept; unlock false → NOT_CONFIRMED / UNLOCK_NOT_PROVEN", async () => {
  const claim = (mutate) => async () => { const w0 = mutate(); w0.status = "payment_captured"; w0.capturedMinor = AMT; return { status: "worked", intentId: IID, actions: [], delayMs: 0, late: Promise.resolve([]) }; };
  { const w = world(); const r = await core(w, { worker: claim(() => w) }); assert.deepEqual([r.outcome, r.code], ["POSTCHECK_MISMATCH", "CAPTURE_OP_NOT_SINGLE_SUCCEEDED"]); }
  { const w = world(); const r = await core(w, { worker: claim(() => { Object.assign(capRow(w), { state: "succeeded", attempts: 1, dispatched: true, result_ref: CH }); w.ops.push(op("hostaway.record_offline_charge", { state: "dispatched", attempts: 1, dispatched: true })); return w; }) });
    assert.deepEqual([r.outcome, r.code], ["POSTCHECK_MISMATCH", "RECORDING_NOT_PRISTINE"]); }
  { const w = world(); const r = await core(w, { worker: claim(() => { Object.assign(capRow(w), { state: "succeeded", attempts: 1, dispatched: true, result_ref: CH }); w.ops.push(op("hostaway.record_offline_charge", { state: "pending", attempts: 0, dispatched: false })); w.claimReleased = true; return w; }) });
    assert.deepEqual([r.outcome, r.code], ["POSTCHECK_MISMATCH", "CLAIM_NOT_HELD"]); }
  const residual = async (mutate) => {
    const w = world(); const pool = fakePool(w); const q = pool.query.bind(pool); let n = 0;
    pool.query = async (sql, params) => { if (/e7hcp:instance/.test(sql) && w.status === "payment_captured" && ++n === 2) mutate(w); if (w.residualThrow) throw new Error("SYNTHETIC"); return q(sql, params); };
    const r = await core(w, { pool }); assert.equal(n, 2, "the residual read happened"); return r;
  };
  { const r = await residual((w) => { const rec = w.ops.find((x) => x.op_type === "hostaway.record_offline_charge"); Object.assign(rec, { state: "dispatched", attempts: 1, dispatched: true }); });
    assert.deepEqual([r.outcome, r.code, r.postcheck, r.recordingQueuedPristine, r.finalState, r.capturedMinor, r.chargeId, r.lock], ["NOT_CONFIRMED", "RESIDUAL_RECORDING_NOT_PRISTINE", null, false, "payment_captured", AMT, CH, "released"], JSON.stringify(r)); }
  { const r = await residual((w) => { w.claimReleased = true; }); assert.deepEqual([r.outcome, r.code, r.postcheck], ["NOT_CONFIRMED", "RESIDUAL_CLAIM_NOT_HELD", null]); }
  { const r = await residual((w) => { w.status = "confirmed"; }); assert.deepEqual([r.outcome, r.code, r.finalState, r.factsObserved], ["NOT_CONFIRMED", "RESIDUAL_STATE_NOT_CAPTURED", "confirmed", true]); }
  { const r = await residual((w) => { w.residualThrow = true; }); assert.deepEqual([r.outcome, r.code, r.postcheck], ["NOT_CONFIRMED", "RESIDUAL_READ_UNAVAILABLE", null]); }
  { const w = world(); const r = await core(w, { unlockFalse: true });
    assert.deepEqual([r.outcome, r.code, r.lock, w.lockReleased, r.finalState, r.chargeId, r.recordingQueuedPristine], ["NOT_CONFIRMED", "UNLOCK_NOT_PROVEN", "unlock_failed_connection_destroyed", "destroyed", "payment_captured", CH, true], JSON.stringify(r)); }
});

test("C1 code ceiling: Slice 2 capture execution CLOSED (executeEnabled false) AND the Slice 1 reservation runner CLOSED; Slice 2 pins the MERGED e7-test C1 fix 59178b04 (DISTINCT from Slice 1's immutable 40779e34); plan pins pi / reservation / amount / accepted key and ZERO refund / record / notify / cancel / void / create", () => {
  assert.equal(C.executeEnabled, false); assert.equal(RESRUN.CONSTANTS.executeEnabled, false);
  assert.equal(C.toolingCommit, "59178b0468469b6570beab861bbc8e48b3a887d1"); assert.equal(C.toolingStatus, "MERGED");
  assert.equal(RESRUN.CONSTANTS.toolingCommit, "40779e34e8c65ac5c4494bc5a18cd4223ef723fa", "Slice 1 keeps its own immutable pin"); assert.notEqual(C.toolingCommit, RESRUN.CONSTANTS.toolingCommit, "C2: distinct pins");
  const p = plan(); assert.deepEqual(p.writes, { captureMax: 1, hostawayCreate: 0, refund: 0, record: 0, notify: 0, cancel: 0, void: 0, account: 0, keys: 0 });
  assert.equal(p.captureIdempotencyKey, IS.captureKey(IID, PI, 1)); assert.deepEqual([p.paymentIntentId, p.reservationId, p.amountMinor], [PI, RID, AMT]);
  for (const bad of [{ reservationId: "" }, { reservationId: C.protectedReservationIds[0] }, { paymentIntentId: "ch_x" }, { amountMinor: 0 }, { amountMinor: 1.5 }, { notBefore: "2026-11-12" },
    { notBefore: "2026-11-12T00:00:00+02:00" }, { expectedVersion: 0 }, { intentId: "not-a-uuid" }]) assert.throws(() => E.buildPlan(C, { approvalRef: "x", intentId: IID, expectedVersion: VER, notBefore: NB, paymentIntentId: PI, reservationId: RID, amountMinor: AMT, runnerDigest: "0".repeat(64), ...bad }), /e7-hosted-capture/, JSON.stringify(bad));
  const ph = (over) => E.buildPlan(C, { approvalRef: "x", intentId: IID, expectedVersion: VER, notBefore: NB, paymentIntentId: PI, reservationId: RID, amountMinor: AMT, runnerDigest: "0".repeat(64), ...over }).planHash;
  assert.notEqual(ph({}), ph({ amountMinor: AMT + 1 })); assert.notEqual(ph({}), ph({ paymentIntentId: "pi_FAKEother0001" })); assert.notEqual(ph({}), ph({ expectedVersion: VER + 1 }));
});

test("C2 closure: the INDEPENDENTLY scanned transitive relative imports of the runner's tooling roots == CONSTANTS.closure (= Slice 1 closure + the accepted capture worker); framed digest == the pin; no R1 / reconcile / stager / recording / notification / compensation / test-abort file", async () => {
  const roots = ["lib/booking-db/capture-worker.js", "lib/booking-db/repo.js", "scripts/e7-connected/executor-adapters.mjs", "scripts/e7-connected/http-transports.mjs", "scripts/e7-connected/real-exchange.mjs",
    "lib/booking-db/pool.js", "lib/hostaway-reservations.js", "lib/checkout/capture-proof.js", "lib/checkout/intent-state.js", "scripts/e7-connected/run-lock-precheck.mjs", "scripts/e7-connected/probe-env-preflight.mjs"];
  const src = readFileSync(join(ROOT, "scripts/e7-hosted-capture.mjs"), "utf8");
  for (const f of roots) assert.ok(src.includes(f), `runner imports ${f}`);
  const seen = new Set(); const st = [...roots];
  while (st.length) { const f = st.pop(); if (seen.has(f)) continue; seen.add(f);
    for (const m of readFileSync(join(TOOLING, f), "utf8").matchAll(/(?:import|export)\s[^"'`;]*?from\s*["'](\.[^"']+)["']|import\(\s*["'](\.[^"']+)["']\s*\)/g)) st.push(normalize(join(dirname(f), m[1] || m[2]))); }
  assert.deepEqual([...C.closure], ["package.json", "package-lock.json", ...[...seen].sort()].sort());
  assert.deepEqual([...C.closure], [...RESRUN.CONSTANTS.closure, "lib/booking-db/capture-worker.js"].sort());
  assert.equal(await RESRUN.framedDigest(TOOLING, C.closure, E.CLOSURE_DIGEST_PREFIX), C.closureDigest);
  for (const f of C.closure) assert.doesNotMatch(f, /run-core|run-plan|run-r1|reconcile|stage-run|recording-worker|notification-worker|compensation-worker|test-abort/);
});

// ---------------------------------------------------------------------------------------------------------------------------------
const PROC = { versions: { node: C.nodeVersion }, platform: "linux", execArgv: [], getuid: () => 1000, once() {}, off() {} };
const okChild = async () => ({ status: 0, signal: null, stdout: "# tests 3\n# pass 3\n# fail 0\n", truncated: false, spawnFailed: false });
const realEnv = (over = {}) => ({ E7_TOOLING_DIR: TOOLING, E7_APPROVAL_REF: "label-1", E7_INTENT_ID: IID, E7_EXPECTED_VERSION: String(VER), E7_NOT_BEFORE: NB, E7_PAYMENT_INTENT_ID: PI, E7_RESERVATION_ID: RID, E7_AMOUNT_MINOR: String(AMT), ...over });

test("H1 hosted: preflight (no secrets) passes on the pinned closure; any secret outside execute is refused; partial / invalid inputs refused; the runner digest covers the imported Slice 1 runner", async () => {
  let x = await E.runHosted({ mode: "preflight", env: { E7_TOOLING_DIR: TOOLING }, proc: PROC, wrapperDir: ROOT, deps: { spawnChild: okChild } });
  assert.deepEqual([x.exitCode, x.result.code, x.result.planKind, x.result.closureDigest, x.result.executeEnabled, x.result.schema], [0, "PREFLIGHT_OK_SYNTHETIC_ONLY", "SYNTHETIC", C.closureDigest, false, "e7-hosted-capture-hosted-v1"], JSON.stringify(x.result));
  assert.equal(x.result.runnerDigest, await RESRUN.framedDigest(ROOT, C.runnerFiles, E.RUNNER_DIGEST_PREFIX)); assert.ok(C.runnerFiles.includes("scripts/e7-hosted-reservation.mjs"));
  x = await E.runHosted({ mode: "preflight", env: realEnv(), proc: PROC, wrapperDir: ROOT, deps: { spawnChild: okChild } });
  assert.deepEqual([x.exitCode, x.result.code, x.result.planKind], [0, "PREFLIGHT_OK_REAL_PLAN", "REAL"]);
  assert.equal(x.result.planHash, E.buildPlan(C, { approvalRef: "label-1", intentId: IID, expectedVersion: VER, notBefore: NB, paymentIntentId: PI, reservationId: RID, amountMinor: AMT, runnerDigest: x.result.runnerDigest }).planHash);
  for (const [env, code] of [[{ E7_TOOLING_DIR: TOOLING, E7_STRIPE_TEST_KEY: "sk_test_x" }, "HCP_SECRET_SCOPE_VIOLATION"], [realEnv({ E7_AMOUNT_MINOR: "" }), "HCP_INPUT_INCOMPLETE"],
    [realEnv({ E7_INTENT_ID: "bad" }), "HCP_INPUT_INVALID"], [realEnv({ E7_PAYMENT_INTENT_ID: "ch_x" }), "HCP_INPUT_INVALID"], [realEnv({ E7_RESERVATION_ID: C.protectedReservationIds[0] }), "HCP_INPUT_INVALID"],
    [realEnv({ E7_AMOUNT_MINOR: "0" }), "HCP_INPUT_INVALID"], [realEnv({ E7_NOT_BEFORE: "yesterday" }), "HCP_INPUT_INVALID"], [realEnv({ E7_APPROVAL_REF: C.synthetic.approvalRef }), "HCP_INPUT_INVALID"]]) {
    const y = await E.runHosted({ mode: "preflight", env, proc: PROC, wrapperDir: ROOT, deps: { spawnChild: okChild } });
    assert.deepEqual([y.exitCode, y.result.code], [1, code], code);
  }
  const bad = await E.runHosted({ mode: "preflight", env: { E7_TOOLING_DIR: TOOLING }, proc: PROC, wrapperDir: ROOT, deps: { spawnChild: async () => ({ status: 1, signal: null, stdout: "# tests 3\n# pass 2\n# fail 1\n", truncated: false, spawnFailed: false }) } });
  assert.equal(bad.result.code, "HCP_TESTS_FAILED");
});

test("H2 hosted: verify / execute refuse HCP_EXECUTE_CLOSED under a test-local executeEnabled=false config before any pin, ref or import check (the shipped constant is CLOSED again; the test-local control is kept so the refusal path is exercised in either state); an opened constants seam still refuses off main / wrong digests / secrets missing / wrong DB target, and wires TWO pools (6543 max 3 worker, 5432 max 1 lock)", async () => {
  const CLOSED = { ...C, executeEnabled: false };   // test-local CLOSED control: the refusal path stays exercised while the shipped constant is OPEN
  const x = await E.runHosted({ mode: "verify", env: { ...realEnv(), E7_EXPECTED_PLAN_HASH: "0".repeat(64), E7_EXPECTED_CLOSURE_DIGEST: C.closureDigest, E7_EXPECTED_RUNNER_DIGEST: "0".repeat(64), GITHUB_REF: "refs/heads/main" }, proc: PROC, wrapperDir: ROOT, deps: { constants: CLOSED } });
  assert.deepEqual([x.exitCode, x.result.code, x.result.closureDigest], [1, "HCP_EXECUTE_CLOSED", null]);
  const y = await E.runHosted({ mode: "execute", env: { ...realEnv(), E7_STRIPE_TEST_KEY: "sk_test_x", E7_HOSTAWAY_TOKEN: "t", E7_DEV_BOOKING_DATABASE_URL: "postgresql://x" }, proc: PROC, wrapperDir: ROOT, deps: { constants: CLOSED, importTooling: async () => { throw new Error("never"); } } });
  assert.deepEqual([y.exitCode, y.result.code], [1, "HCP_EXECUTE_CLOSED"]);
  const opened = { ...C, executeEnabled: true };
  const pf = await E.runHosted({ mode: "preflight", env: realEnv(), proc: PROC, wrapperDir: ROOT, deps: { spawnChild: okChild } });
  const d = pf.result;
  const base = { ...realEnv(), E7_EXPECTED_PLAN_HASH: d.planHash, E7_EXPECTED_CLOSURE_DIGEST: d.closureDigest, E7_EXPECTED_RUNNER_DIGEST: d.runnerDigest, GITHUB_REF: "refs/heads/main" };
  let v = await E.runHosted({ mode: "verify", env: { ...base }, proc: PROC, wrapperDir: ROOT, deps: { constants: opened } });
  assert.deepEqual([v.exitCode, v.result.code], [0, "VERIFY_OK"], JSON.stringify(v.result));
  for (const [env, code] of [[{ ...base, GITHUB_REF: "refs/heads/feature" }, "HCP_REF_NOT_MAIN"], [{ ...base, E7_EXPECTED_CLOSURE_DIGEST: "1".repeat(64) }, "HCP_SOURCE_MISMATCH"],
    [{ ...base, E7_EXPECTED_RUNNER_DIGEST: "1".repeat(64) }, "HCP_RUNNER_MISMATCH"], [{ ...base, E7_EXPECTED_PLAN_HASH: "1".repeat(64) }, "HCP_PLAN_HASH_MISMATCH"], [{ ...base, E7_EXPECTED_PLAN_HASH: "" }, "HCP_INPUT_INCOMPLETE"]]) {
    v = await E.runHosted({ mode: "verify", env, proc: PROC, wrapperDir: ROOT, deps: { constants: opened } }); assert.deepEqual([v.exitCode, v.result.code], [1, code], code);
  }
  v = await E.runHosted({ mode: "execute", env: { ...base }, proc: PROC, wrapperDir: ROOT, deps: { constants: opened, importTooling: async () => { throw new Error("never"); } } });
  assert.deepEqual([v.exitCode, v.result.code], [1, "HCP_CREDENTIALS_MISSING"]);
  v = await E.runHosted({ mode: "execute", env: { ...base, E7_STRIPE_TEST_KEY: "sk_test_x", E7_HOSTAWAY_TOKEN: "t", E7_DEV_BOOKING_DATABASE_URL: "postgresql://u@h:1/x" }, proc: PROC, wrapperDir: ROOT, deps: { constants: opened, readPgVersion: async () => C.pgVersion } });
  assert.deepEqual([v.exitCode, v.result.code], [1, "HCP_DB_TARGET_INVALID"]);
  const good = `postgresql://mv_booking_app_dev.${C.dbProjectRef}:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres`;
  const pools = []; let coreArgs = null;
  const fakeTooling = async () => ({ X: { createE7RealExchange: () => ({ ok: true, exchange: async () => ({}) }) },
    createBookingPool: (o) => { const u = new URL(o.connectionString); pools.push({ port: u.port, max: o.max, ended: false }); const me = pools.at(-1); return { connect: async () => ({ query: async () => ({ rows: [] }), release() {}, on() {} }), query: async () => ({ rows: [] }), end: async () => { me.ended = true; } }; },
    tooling: {} });
  const z = await E.runHosted({ mode: "execute", env: { ...base, E7_STRIPE_TEST_KEY: "sk_test_x", E7_HOSTAWAY_TOKEN: "t", E7_DEV_BOOKING_DATABASE_URL: good, E7_CA_FILE: "ca" }, proc: PROC, wrapperDir: ROOT,
    deps: { constants: opened, readPgVersion: async () => C.pgVersion, readCa: async () => Buffer.from("CA"), caSha256: (await import("node:crypto")).createHash("sha256").update("CA").digest("hex"), importTooling: fakeTooling,
      runCore: async (a) => { coreArgs = a; return { outcome: "SCOPE_REFUSED", code: "FAKE" }; } } });
  assert.deepEqual([z.exitCode, z.result.code, z.result.lockEndpoint, pools.map((p) => [p.port, p.max, p.ended])], [1, "EXECUTE_DONE", "session:5432", [["6543", 3, true], ["5432", 1, true]]], JSON.stringify(z.result));
  assert.equal(typeof coreArgs.lockClientFactory, "function"); assert.deepEqual([coreArgs.plan.paymentIntentId, coreArgs.plan.amountMinor], [PI, AMT]);
});

test("H3 hosted: a drifted tooling byte (in the capture worker) is refused before any import (closure digest)", async () => {
  const d = mkdtempSync(join(tmpdir(), "e7-hcp-drift-"));
  try {
    for (const f of C.closure) { mkdirSync(dirname(join(d, f)), { recursive: true }); cpSync(join(TOOLING, f), join(d, f)); }
    writeFileSync(join(d, "lib/booking-db/capture-worker.js"), `${readFileSync(join(TOOLING, "lib/booking-db/capture-worker.js"), "utf8")}\n// drift\n`);
    const x = await E.runHosted({ mode: "preflight", env: { E7_TOOLING_DIR: d }, proc: PROC, wrapperDir: ROOT, deps: { spawnChild: okChild, importEnv: async () => C1 } });
    assert.deepEqual([x.exitCode, x.result.code], [1, "HCP_SOURCE_MISMATCH"]);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("S1 static: the runner imports node built-ins and ONLY the reviewed Slice 1 runner; no refund / cancel / void / record / notify call text; inert import", () => {
  const src = readFileSync(join(ROOT, "scripts/e7-hosted-capture.mjs"), "utf8");
  for (const m of src.matchAll(/^import .* from "([^"]+)";$/gm)) assert.ok(m[1].startsWith("node:") || m[1] === "./e7-hosted-reservation.mjs", m[1]);
  for (const bad of ["cancelPaymentIntent(", "cancelReservation(", "createOfflineCharge(", "sendMessage(", "refunds.create", "paymentIntents.cancel", "createReservation("]) assert.equal(src.includes(bad), false, bad);
  assert.equal(process.listenerCount("SIGINT"), 0);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// OPT-IN INTEGRATION (E7_HCP_DB_TESTS=1; tooling with its pinned pg; PG_BIN): the REAL merged runCaptureStep (E7.3b), repo, operations,
// transports and executor adapters on a disposable PostgreSQL (tooling test/db/harness.mjs). FAKE exchanges ONLY (mock replies are not
// provider proof); fixtures through the accepted APIs. The hosted preflight child never sets E7_HCP_DB_TESTS.
if (process.env.E7_HCP_DB_TESTS === "1") {
  const [{ startMigratedDatabase }, F, R, O, W, pgMod, SP, DP, PA] = await Promise.all([tool("test/db/harness.mjs"), tool("test/db/fixtures.mjs"), tool("lib/booking-db/repo.js"),
    tool("lib/booking-db/operations.js"), tool("lib/booking-db/capture-worker.js"), import(pathToFileURL(join(TOOLING, "node_modules/pg/lib/index.js")).href),
    tool("lib/checkout/server-pricer.js"), tool("lib/direct-policy.js"), tool("lib/public-api.js")]);
  const pg = pgMod.default ?? pgMod;
  const db = await startMigratedDatabase();
  after(async () => { await db.close(); });
  const LIST = 606998; const MINUTE = 60000;
  let stayK = 0;
  const realTooling = { runCaptureStep: W.runCaptureStep, loadIntent: R.loadIntent, createPhaseExecutors: EA.createPhaseExecutors, createStripeSend: T.createE7StripeTestSend,
    createHostawaySend: T.createE7HostawaySend, validateAdapterConfig: HR.validateAdapterConfig, paymentIntentProofObservationV3: CP.paymentIntentProofObservationV3,
    stillAuthorizedV3Refusal: CP.stillAuthorizedV3Refusal, captureKey: IS.captureKey, LOCK_KEY: LK.LOCK_KEY, LOCK_PRECHECK_SQL: LK.LOCK_PRECHECK_SQL };
  // LABELLED COPY of test/e7-hosted-reservation.test.mjs `authorizedIntent` (itself an adaptation of the native harness): a fresh payment_authorized
  // USD intent on 606998 priced by the ACCEPTED server pricer, then the accepted create → RESERVATION_SUCCEEDED path (= test/db/e73b `reservedWith`).
  const NIGHTLY = 1600; const POLICY = DP.readDirectPolicyFromEnv({ VERCEL_ENV: "development", MV_E7_RESERVATION_WORKER: "enabled" }).policy;
  const dayRows = (from, to) => { const out = []; for (let d = from; d <= to; d = F.addDays(d, 1)) out.push({ date: d, status: "available", isAvailable: 1, minimumStay: 1, maximumStay: 90, closedOnArrival: 0, closedOnDeparture: 0 }); return out; };
  const pricing = {
    get: async (path, opts = {}) => { const m = /^\/listings\/(\d+)(\/calendar)?$/.exec(path); if (!m[2]) return { status: 200, json: { result: { id: Number(m[1]), currencyCode: "USD", personCapacity: 4, minNights: 1, maxNights: 90 } } };
      return { status: 200, json: { result: dayRows(opts.query.startDate, opts.query.endDate) } }; },
    post: async (path, body) => { const nights = Math.round((Date.parse(body.endingDate) - Date.parse(body.startingDate)) / 86400000);
      return { status: 200, json: { status: "success", result: { totalPrice: NIGHTLY * nights, components: [{ id: 1, type: "accommodation", name: "baseRate", title: "Base rate", quantity: 1, value: NIGHTLY, total: NIGHTLY * nights, isIncludedInTotalPrice: 1, isMandatory: 1, isOverriddenByUser: 0, isDeleted: 0, units: nights }] } } }; }
  };
  async function confirmedIntent() {
    stayK += 1;
    const stay = { listingId: LIST, from: F.addDays("2027-03-01", 5 * stayK), to: F.addDays("2027-03-01", 5 * stayK + 4), guests: 2 };
    const base = F.at(0);
    const priced = await SP.priceStay({ request: { ...stay }, listingConfig: { currency: "USD" }, client: pricing, policy: POLICY, today: PA.todayInTimeZone(undefined, new Date(base)), now: base });
    assert.ok(priced.ok, priced.error);
    const intent = await R.createIntentRecord(db.app, { ref: F.nextRef(), accessTokenHash: F.tokenHash(), environment: "test", now: base, ...stay });
    F.ok(await R.applyEvent(db.app, intent.id, { type: "PRICE_CONFIRMED", price: priced.price }, { now: base, actor: "guest" }));
    F.ok(await R.collectGuestDetails(db.app, intent.id, F.GUEST, { now: base + 1000, termsVersion: "terms-2026-10" }));
    const b = F.ok(await R.beginPayStep(db.app, intent.id, { now: base + 2000 }));
    const pop = await O.claimNextOperation(db.app, { workerId: "w-pay", now: base + 2000, intentId: intent.id, opTypes: ["stripe.create_checkout_session"] });
    const sessionId = `cs_test_hcp${String(stayK).padStart(6, "0")}`;
    F.ok(await O.completeOperation(db.app, pop.id, { workerId: "w-pay", now: base + 2000, outcome: { status: "succeeded", resultRef: sessionId } }));
    F.ok(await R.recordCheckoutSession(db.app, intent.id, b.attempt.id, { sessionId, expiresAt: base + 30 * MINUTE, now: base + 2000 }));
    const piId = `pi_HCP${String(stayK).padStart(10, "0")}`;
    const captureBefore = Math.floor((base + 7 * 86400000) / 1000) * 1000;
    F.ok(await R.applyEvent(db.app, intent.id, { type: "PAYMENT_AUTHORIZED", id: `evt_auth_${piId}`, paymentIntentId: piId, sessionId, amountMinor: priced.price.finalTotalMinor,
      currency: "usd", livemode: false, authorizationCreatedAt: base + 3000, captureBefore }, { now: base + 4000, actor: "webhook" }));
    F.ok(await R.applyEvent(db.app, intent.id, { type: "RESERVATION_STARTED", workerId: "w1", recheck: { bookable: true, priceSame: true } }, { now: F.at(6), actor: "worker", workerId: "w1" }));
    F.ok(await R.applyEvent(db.app, intent.id, { type: "RESERVATION_DISPATCHED", workerId: "w1" }, { now: F.at(6), actor: "worker", workerId: "w1" }));
    const rid = F.nextReservationId() + 74000000;
    const cop = await F.claimOp(db.app, intent.id, "hostaway.create_reservation", F.at(6));
    const i0 = await R.loadIntent(db.app, intent.id);
    const reservation = { reservationId: rid, listingId: LIST, from: stay.from, to: stay.to, totalMinor: i0.price.finalTotalMinor, currency: "USD", bookingRef: null };
    await R.recordHostawayCreateResult(db.app, intent.id, { httpStatus: 201, reservation }, { now: F.at(7) });
    F.ok(await O.completeOperation(db.app, cop.id, { workerId: "w1", now: F.at(7), outcome: { status: "succeeded", resultRef: rid } }));
    F.ok(await R.applyEvent(db.app, intent.id, { type: "RESERVATION_SUCCEEDED", reservation }, { now: F.at(7), actor: "worker" }));
    const pa = (await db.app.query("SELECT id::text AS id FROM booking.payment_attempts WHERE intent_id = $1 AND status = 'completed'", [intent.id])).rows[0].id;
    const i = await R.loadIntent(db.app, intent.id);
    assert.equal(i.status, "reservation_confirmed");
    return { id: intent.id, piId, attemptId: pa, stay: { ...stay, currency: "USD" }, ref: i.ref, intent: i, total: i.price.finalTotalMinor, rid: String(rid) };
  }
  function pgWorld(a, o = {}) {
    const w = { calls: [], piStatus: o.piStatus ?? "requires_capture", captured: false, echoRef: o.echoRef ?? true, captureLost: o.captureLost ?? false, captureRequests: 0 };
    const reply = (status, x) => Promise.resolve({ status, contentType: "application/json", bytes: enc(x) });
    const pi = () => ({ object: "payment_intent", id: a.piId, livemode: false, status: w.captured ? "succeeded" : w.piStatus, capture_method: "manual", amount: a.total, amount_received: w.captured ? a.total : 0,
      amount_capturable: !w.captured && w.piStatus === "requires_capture" ? a.total : 0, currency: "usd", metadata: { mv_intent_id: a.id, mv_payment_attempt_id: a.attemptId },
      latest_charge: { object: "charge", id: `ch_HCP${a.id.slice(0, 8)}`, payment_intent: a.piId, status: "succeeded", paid: true, captured: w.captured, amount: a.total, amount_captured: w.captured ? a.total : 0,
        amount_refunded: 0, currency: "usd", livemode: false, payment_method_details: { card: { capture_before: a.intent.payment.captureBefore / 1000 } } } });
    const full = (echo = w.echoRef) => ({ id: Number(a.rid), listingMapId: LIST, channelId: 2000, arrivalDate: a.stay.from, departureDate: a.stay.to, totalPrice: a.total / 100, currency: "USD", status: "new",
      customFieldValues: echo ? [{ customFieldId: C.refFieldId, value: a.ref }] : [] });
    w.stripe = (req) => {
      w.calls.push(`S ${req.method} ${req.url.replace("https://api.stripe.com", "")}`);
      if (req.url.endsWith("/v1/account")) return reply(200, { object: "account", id: ACCT });
      if (req.method === "POST") {
        assert.equal(req.url, `https://api.stripe.com/v1/payment_intents/${a.piId}/capture`); assert.equal(req.headers["Idempotency-Key"], `cap:${a.id}:${a.piId}`);
        assert.equal(req.body, `amount_to_capture=${a.total}&expand%5B%5D=latest_charge`, "C1/C2 wire: no final_capture");
        w.captureRequests += 1;
        if (w.captureLost) return Promise.reject(new Error("socket reset"));
        w.captured = true; return reply(200, pi());
      }
      return reply(200, pi());
    };
    w.hostaway = (req) => {
      const p = req.url.replace("https://api.hostaway.com", ""); w.calls.push(`H ${req.method} ${p}`);
      if (o.hostawayStatus) return reply(o.hostawayStatus, { status: "fail", message: "unauthorized" });
      if (req.method === "GET" && p.startsWith("/v1/reservations?")) return reply(200, { status: "success", result: new URL(req.url).searchParams.has("afterId") ? [] : [full(true)] });
      const m = /^\/v1\/reservations\/(\d+)$/.exec(p);
      if (req.method === "GET" && m) return m[1] === a.rid ? reply(200, { status: "success", result: full() }) : reply(404, { status: "fail" });
      return reply(404, { status: "fail" });
    };
    return w;
  }
  const pgRun = (a, w, extra = {}, over = {}) => {
    const clk = { t: F.at(0) + 10 * MINUTE };
    return E.runCaptureCore({ plan: E.buildPlan(C, { approvalRef: "SYNTHETIC-hcp-pg", intentId: a.id, expectedVersion: a.intent.version, notBefore: new Date(F.at(0) - MINUTE).toISOString(),
      paymentIntentId: a.piId, reservationId: a.rid, amountMinor: a.total, runnerDigest: "0".repeat(64), ...over }).plan, pool: db.app, tooling: realTooling,
      exchanges: { stripe: w.stripe, hostaway: w.hostaway }, credentials: { stripe: () => "sk_test_Fake1", hostaway: () => "synthetic-hostaway-token" },
      clock: () => (clk.t += 1000), sleep: async (ms) => { clk.t += Math.max(ms, 30 * 1000); }, ...extra });
  };
  const snap = async (id) => ({ st: (await db.app.query("SELECT state, version, hostaway_reservation_id::text AS rid FROM booking.intents WHERE id = $1", [id])).rows[0],
    ops: (await db.app.query("SELECT op_type, state, attempts, (dispatched_at IS NOT NULL) AS d, result_ref FROM booking.external_operations WHERE intent_id = $1 ORDER BY op_type, created_at", [id])).rows,
    claim: (await db.app.query("SELECT (released_at IS NOT NULL) AS released FROM booking.inventory_claims WHERE intent_id = $1", [id])).rows,
    cases: Number((await db.app.query("SELECT count(*)::int AS n FROM booking.reconciliation_cases WHERE intent_id = $1 AND status = 'open'", [id])).rows[0].n),
    locks: Number((await db.app.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'")).rows[0].n) });

  test("I1 PG integration (REAL capture worker + repo + transports + executors; FAKE exchanges): ref echoed and NOT echoed → EXACTLY 1 capture POST (pinned amount / key), payment_captured intermediate with the same PI / amount / reservation, recording row queued pristine (never dispatched), claim held, no Hostaway write, lock released; a SECOND admission refuses read-only with zero sends", async () => {
    for (const echoRef of [true, false]) {
      const a = await confirmedIntent(); const w = pgWorld(a, { echoRef });
      const r = await pgRun(a, w);
      assert.equal(r.outcome, "PAYMENT_CAPTURED_INTERMEDIATE", `${echoRef ? "echoed" : "not echoed"}: ${JSON.stringify(r)}`);
      assert.deepEqual([r.captureInvocations, r.captureOutcome, r.capturedMinor, r.reservationId, r.recordingQueuedPristine, r.lock, w.captureRequests], [1, "REPLIED", a.total, a.rid, true, "released", 1]);
      assert.deepEqual(w.calls.filter((x) => /^(S POST|H POST|H PUT|H DELETE)/.test(x)), [`S POST /v1/payment_intents/${a.piId}/capture`]);
      const s = await snap(a.id);
      assert.deepEqual([s.st.state, s.st.rid, s.claim[0].released, s.cases, s.locks], ["payment_captured", a.rid, false, 0, 0]);
      assert.deepEqual(s.ops.filter((x) => x.op_type === "stripe.capture_payment_intent").map((x) => [x.state, x.attempts, x.d, x.result_ref]), [["succeeded", 1, true, `ch_HCP${a.id.slice(0, 8)}`]]);
      assert.deepEqual(s.ops.filter((x) => x.op_type === "hostaway.record_offline_charge").map((x) => [x.state, x.attempts, x.d]), [["pending", 0, false]], "recording queued pristine, never dispatched");
      for (const t of ["guest.notify", "alert.owner", "stripe.void_payment_intent", "hostaway.cancel_reservation", "stripe.refund"]) assert.equal(s.ops.filter((x) => x.op_type === t).length, 0, t);
      const i = await R.loadIntent(db.app, a.id); assert.deepEqual([i.payment.capturedMinor, i.payment.paymentIntentId, String(i.reservation.reservationId)], [a.total, a.piId, a.rid]);
      console.log(`# I1 ${echoRef ? "echoed" : "not-echoed"}: steps=${r.steps} dbQueries=${r.dbQueries} exchanges=${r.exchanges} reads=${r.hostawayReads} lookups=${r.lookupPages} pi=${r.piReads}`);
      assert.ok(r.dbQueries > 0 && r.dbQueries <= C.budgets.dbQueries);
      // second admission (a later session) on the captured intent: refused before the lock, zero sends
      const a2 = { ...a, intent: i }; const w2 = pgWorld(a2); const r2 = await pgRun(a2, w2);
      assert.deepEqual([r2.outcome, r2.code, w2.calls.length, r2.steps, r2.lock], ["START_STATE_NOT_ELIGIBLE", "STATE_NOT_RESERVATION_CONFIRMED", 0, 0, "not_acquired"], JSON.stringify(r2));
    }
  });

  test("I2 PG integration: auth-proof failure (PI canceled) → PROVIDER_PROOF_FAILED before any Hostaway call, DB unchanged; lost capture reply → CAPTURE_OUTCOME_UNKNOWN with ONE POST, the accepted worker settles capture_unknown, and a SECOND SESSION refuses read-only (no second send ever); 401 on the reservation read → no capture", async () => {
    { const a = await confirmedIntent(); const before = await snap(a.id); const w = pgWorld(a, { piStatus: "canceled" }); const r = await pgRun(a, w);
      assert.deepEqual([r.outcome, r.code, w.calls.filter((x) => x.startsWith("H")).length, w.captureRequests], ["PROVIDER_PROOF_FAILED", "NOT_REQUIRES_CAPTURE", 0, 0]); assert.deepEqual(await snap(a.id), before); }
    { const a = await confirmedIntent(); const w = pgWorld(a, { captureLost: true }); const r = await pgRun(a, w);
      assert.deepEqual([r.outcome, r.captureInvocations, r.captureOutcome, w.captureRequests], ["CAPTURE_OUTCOME_UNKNOWN", 1, "UNKNOWN", 1], JSON.stringify(r));
      const s = await snap(a.id); assert.equal(s.st.state, "capture_unknown", JSON.stringify(s.st));
      assert.deepEqual(s.ops.filter((x) => x.op_type === "stripe.capture_payment_intent").map((x) => [x.state, x.attempts, x.d]), [["outcome_unknown", 1, true]]);
      assert.deepEqual([r.finalState, r.captureOps, s.locks], ["capture_unknown", ["outcome_unknown"], 0]);
      const a2 = { ...a, intent: await R.loadIntent(db.app, a.id) }; const w2 = pgWorld(a2); const r2 = await pgRun(a2, w2);
      assert.deepEqual([r2.outcome, r2.code, w2.calls.length, w2.captureRequests, r2.steps], ["START_STATE_NOT_ELIGIBLE", "STATE_NOT_RESERVATION_CONFIRMED", 0, 0, 0], `second session: ${JSON.stringify(r2)}`);
      const w3 = pgWorld(a2); const r3 = await pgRun({ ...a2, intent: { ...a2.intent, version: a.intent.version } }, w3);                     // even with the stale pre-capture version pinned
      assert.deepEqual([w3.calls.length, w3.captureRequests, r3.captureInvocations], [0, 0, 0]); }
    { const a = await confirmedIntent(); const w = pgWorld(a, { hostawayStatus: 401 }); const r = await pgRun(a, w);
      assert.notEqual(r.outcome, "PAYMENT_CAPTURED_INTERMEDIATE"); assert.equal(w.captureRequests, 0, JSON.stringify(r)); assert.equal((await snap(a.id)).locks, 0); }
  });

  test("I3 PG integration: real lock conflict (another session holds LOCK_KEY) → LOCK_NOT_ACQUIRED, zero provider calls, zero DB writes; historic / stale version / wrong amount / wrong PI / wrong reservation pins refuse read-only; deadline at the final read → never success, facts observed", async () => {
    { const a = await confirmedIntent(); const before = await snap(a.id);
      const holder = new pg.Client({ connectionString: db.reportUrl() }); await holder.connect();
      try { await holder.query("SELECT pg_advisory_lock(pg_catalog.hashtext($1), 0)", [LK.LOCK_KEY]);
        const w = pgWorld(a); const r = await pgRun(a, w);
        assert.deepEqual([r.outcome, r.code, w.calls.length, r.lock], ["LOCK_NOT_ACQUIRED", "RUN_LOCK_PRESENT", 0, "not_acquired"]);
        const after1 = await snap(a.id); assert.deepEqual({ ...after1, locks: 0 }, { ...before, locks: 0 });
      } finally { await holder.end(); } }
    const a = await confirmedIntent();
    for (const [over, outcome, code] of [[{ notBefore: new Date(F.at(0) + MINUTE).toISOString() }, "START_STATE_NOT_ELIGIBLE", "HISTORIC_INTENT"], [{ expectedVersion: a.intent.version + 1 }, "START_STATE_NOT_ELIGIBLE", "VERSION_NOT_PINNED"],
      [{ amountMinor: a.total + 1 }, "SCOPE_REFUSED", "AMOUNT_NOT_PINNED"], [{ paymentIntentId: "pi_HCPother0000001" }, "SCOPE_REFUSED", "PAYMENT_INTENT_NOT_PINNED"], [{ reservationId: String(Number(a.rid) + 1) }, "SCOPE_REFUSED", "RESERVATION_NOT_PINNED"]]) {
      const w = pgWorld(a); const r = await pgRun(a, w, {}, over);
      assert.deepEqual([r.outcome, r.code, w.calls.length, r.steps], [outcome, code, 0, 0], code);
    }
    { let reads = 0; const w = pgWorld(a); const q = db.app.query.bind(db.app);
      const pool = { query: async (sql, params) => { const res = await q(sql, params); if (/e7hcp:claims/.test(String(sql))) { const st = (await q("SELECT state FROM booking.intents WHERE id = $1", [a.id])).rows[0].state; if (st === "payment_captured") reads += 1; } return res; }, connect: () => db.app.connect() };
      let m = 0; const monotonic = () => (reads > 0 ? 900001 : (m += 1, 0));
      const r = await pgRun(a, w, { pool, monotonic });
      assert.deepEqual([r.outcome, r.factsObserved, r.finalState, r.capturedMinor, r.captureInvocations], ["DEADLINE", true, "payment_captured", a.total, 1], JSON.stringify(r));
      assert.equal((await snap(a.id)).locks, 0); }
  });
}
