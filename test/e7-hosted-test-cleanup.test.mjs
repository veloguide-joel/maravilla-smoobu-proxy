// E7 Slice 3 hosted captured-TEST cleanup runner — LABELS
//   * REAL: the runner; from the PINNED tooling (E7_TOOLING_DIR, default ../../tooling = workflow layout): the ISOLATED test-cleanup transports TT
//     (Stripe) + the accepted Hostaway transport T, the ISOLATED test-cleanup executors EX, the accepted proofs (CP / RP / TP / CO), the accepted
//     request's expectation binding TC, env preflight C1, validateAdapterConfig HR, refundKey / publicStatus IS, LOCK_KEY / LOCK_PRECHECK_SQL.
//   * FAKE (unit tests): the DB (tagged SELECT fake), the request + the worker (they mutate the fake world the way the accepted request / worker
//     would; the fake worker drives the REAL executors → REAL transports → the runner fence → fake exchange), the provider exchanges, credentials.
//     No network primitive is touched (guarded). Mock replies are NOT provider proof.
//   * OPT-IN INTEGRATION (E7_HTC_DB_TESTS=1 + PG_BIN): the REAL merged requestTestCleanup + runTestCleanupStep / repo / operations / 0019 + 0020
//     on a DISPOSABLE PostgreSQL (tooling test/db/harness.mjs + fixtures.mjs), FAKE exchanges only. The hosted preflight child never sets it.
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
const E = await import("../scripts/e7-hosted-test-cleanup.mjs");
const RESRUN = await import("../scripts/e7-hosted-reservation.mjs");
const CAPRUN = await import("../scripts/e7-hosted-capture.mjs");
const [TT, T, EX, HR, C1, CP, RP, TP, CO, IS, LK] = await Promise.all([tool("scripts/e7-connected/test-cleanup-transports.mjs"), tool("scripts/e7-connected/http-transports.mjs"),
  tool("scripts/e7-connected/test-cleanup-executors.mjs"), tool("lib/hostaway-reservations.js"), tool("scripts/e7-connected/probe-env-preflight.mjs"), tool("lib/checkout/capture-proof.js"),
  tool("lib/checkout/recovery-plan.js"), tool("lib/checkout/test-cleanup-proof.js"), tool("lib/checkout/compensation-proof.js"), tool("lib/checkout/intent-state.js"),
  tool("scripts/e7-connected/run-lock-precheck.mjs")]);
// The accepted request module (lib/booking-db/test-cleanup.js) transitively imports `pg` (repo.js → pool.js), which the hosted PREFLIGHT job never
// installs (no dependency install before secrets, by design). It is loaded when the tooling's dependency is present (local / real-PG runs) and the
// expectation binding is then cross-checked against the ACCEPTED function; in the dependency-free preflight the exact 17-key list below (a copy of
// TEST_CLEANUP_EXPECTATION_KEYS, asserted equal whenever the module loads) is the check. Hosted run 43302881832 (HTC_TESTS_FAILED, tests 1 / pass 0) was this load failure.
const EXPECTATION_KEYS = Object.freeze(["approvalRef", "attemptId", "authorizedMinor", "capturedMinor", "chargeId", "currency", "expectedVersion", "finalTotalMinor", "from", "guests", "intentId",
  "listingId", "paymentIntentId", "planHash", "reservationId", "sessionId", "to"]);
const TC = await tool("lib/booking-db/test-cleanup.js").catch((e) => (e && e.code === "ERR_MODULE_NOT_FOUND" ? null : Promise.reject(e)));
if (TC) assert.deepEqual([...TC.TEST_CLEANUP_EXPECTATION_KEYS], [...EXPECTATION_KEYS], "the local key copy equals the accepted TEST_CLEANUP_EXPECTATION_KEYS");
const bindsAccepted = (ex) => (TC ? TC.bindCleanupExpectation(ex) !== null : Object.keys(ex).length === 17);
after(() => { assert.deepEqual(GUARD, { request: 0, Agent: 0, fetch: 0 }, "no real network primitive was touched"); });

const C = E.CONSTANTS;
const IID = "11111111-2222-4333-8444-555555555555"; const PI = "pi_FAKEhostedTc0001"; const VER = 7; const REF = "MV-FAKE0001"; const ACCT = C.accountId;
const AMT = 14000; const FROM = "2026-11-25"; const TO = "2026-11-26"; const NB = "2026-11-12T00:00:00.000Z"; const CREATED = Date.UTC(2026, 10, 12, 15, 0, 0);
const ATTEMPT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"; const RID = "71999901"; const CH = "ch_FAKEhostedTc0001"; const CS = "cs_test_FAKEhostedTc0001"; const RE = "re_FAKEhostedTc0001";
const REFUND_OP = "99999999-8888-4777-8666-555555555555"; const KEY = `ref:${IID}:1`;
const enc = (o) => new TextEncoder().encode(JSON.stringify(o));
const planInput = (over = {}) => ({ approvalRef: "SYNTHETIC-hosted-tc", intentId: IID, expectedVersion: VER, notBefore: NB, paymentIntentId: PI, reservationId: RID, chargeId: CH, capturedMinor: AMT,
  from: FROM, to: TO, guests: 1, attemptId: ATTEMPT, sessionId: CS, runnerDigest: "0".repeat(64), ...over });
const built = (over = {}) => E.buildPlan(C, planInput(over));
const op = (op_type, over = {}) => ({ id: `op-${op_type}`, op_type, state: "succeeded", attempts: 1, dispatched: true, leased: false, late_result_status: null, result_ref: null, payload_rid: null, payload_pi: null,
  payload_charge: null, payload_currency: null, payload_attempt: null, payload_amount: null, payload_key: null, ...over });
const REFUND_BODY = `payment_intent=${PI}&amount=${AMT}&metadata%5Bmv_refund_op%5D=${REFUND_OP}&metadata%5Bmv_refund_key%5D=${encodeURIComponent(KEY)}`;

// ---------------------------------------------------------------------------------------------------------------------------------
// fake world: DB rows + providers; the fake request / worker mutate it the way the accepted request / cleanup worker would
function world(o = {}) {
  const w = { status: o.status ?? "payment_captured", version: VER, ops: [], hx: [{ state: "succeeded", rid: RID }], claimReleased: false, calls: [], workerCalls: 0, requestCalls: 0, res: RID, echoRef: o.echoRef ?? true,
    lease: null, dispatch: { at: CREATED, attempt: 1 }, createdAt: o.createdAt ?? CREATED, piRefunded: 0, disputed: false, resStatus: "new", lockRows: 1, captureAttempts: 1, cancelAttempts: 0, voidAttempts: 0,
    refunds: [], ledger: [{ entry: "authorization_accepted", amt: String(AMT), currency: "USD", provider_ref: PI }, { entry: "capture_succeeded", amt: String(AMT), currency: "USD", provider_ref: PI }],
    evidence: [{ kind: "payment_intent", external_ref: PI, status: "succeeded" }, { kind: "hostaway_reservation", external_ref: RID, status: "new" }],
    reasonCode: null, settlement: null, workLeased: false, schema: Object.fromEntries(["f0020", "settled_for", "pi_ok", "ledgered", "cancel_bound", "refund_fence", "retirement_fence", "pending_state"].map((k) => [k, true])),
    refundObjs: new Map() };
  w.ops.push(op("stripe.create_checkout_session", { result_ref: CS }), op("stripe.retrieve_checkout_session"), op("stripe.retrieve_payment_intent"));
  w.ops.push(op("hostaway.create_reservation", { result_ref: RID }));
  w.ops.push(op(CAP, { result_ref: CH, payload_pi: PI, payload_attempt: 1, payload_amount: AMT, payload_key: `cap:${IID}:${PI}` }));
  w.ops.push(op(REC, { state: "pending", attempts: 0, dispatched: false, payload_rid: RID }));
  return w;
}
const CAP = "stripe.capture_payment_intent"; const REC = "hostaway.record_offline_charge"; const CAN = "hostaway.cancel_reservation"; const RFD = "stripe.refund_payment_intent";
const rowOf = (w, t) => w.ops.find((x) => x.op_type === t);
const intentOf = (w) => ({ id: IID, status: w.status, version: w.version, listingId: 606998, from: FROM, to: TO, guests: 1, ref: REF, createdAt: w.createdAt,
  price: { currency: "USD", finalTotalMinor: AMT, rateBps: 1000 }, payment: { paymentIntentId: PI, livemode: false, capturedMinor: AMT, amountMinor: AMT, currency: "USD", captureBefore: CREATED + 7 * 86400000 },
  reservation: w.res ? { reservationId: w.res, confirmedAt: CREATED } : null, counters: { captureAttempts: w.captureAttempts, voidAttempts: w.voidAttempts, cancelAttempts: w.cancelAttempts, offlineChargeAttempts: 0, reservationAttempts: 1 },
  checkout: { sessionId: CS, attempt: 1 }, lease: w.lease, dispatch: w.dispatch, reasonCode: w.reasonCode, settlement: w.settlement, offlineChargeId: null });
function fakePool(w, o = {}) {
  const tag = (sql) => /\/\*e7htc:(\w+)\*\//.exec(sql)?.[1];
  const p = { reads: 0, async query(sql) {
    this.reads += 1;
    if (o.dbFailAt && this.reads === o.dbFailAt) throw new Error("db down");
    switch (tag(sql)) {
      case "instance": return { rows: [{ environment: o.env ?? "test" }] };
      case "attempts": return { rows: [{ id: ATTEMPT, status: "completed", checkout_session_id: CS, payment_intent_id: PI, livemode: false }] };
      case "hostaway": return { rows: w.hx.map((x) => ({ ...x })) };
      case "ops": return { rows: w.ops.map((x) => ({ ...x })) };
      case "cases": return { rows: [{ n: o.cases ?? 0 }] };
      case "claims": return { rows: [{ listing_id: 606998, released: w.claimReleased }] };
      case "work": return { rows: [{ leased: w.workLeased }] };
      case "refunds": return { rows: w.refunds.map((x) => ({ ...x })) };
      case "ledger": return { rows: w.ledger.map((x) => ({ ...x })) };
      case "evidence": return { rows: w.evidence.map((x) => ({ ...x })) };
      case "settlement": return { rows: [{ environment: o.intentEnv ?? "test", reason_code: w.reasonCode, cancelled: w.settlement ? w.settlement.reservationCancelled : null, settled: w.settlement ? w.settlement.authorizationSettled : null, cap: String(AMT) }] };
      case "schema": return { rows: [{ ...w.schema }] };
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
const piObj = (w) => ({ object: "payment_intent", id: PI, livemode: false, status: "succeeded", capture_method: "manual", amount: AMT, amount_received: AMT, amount_capturable: 0, currency: "usd",
  metadata: { mv_intent_id: IID, mv_payment_attempt_id: ATTEMPT },
  latest_charge: { object: "charge", id: CH, payment_intent: PI, status: "succeeded", paid: true, captured: true, amount: AMT, amount_captured: AMT, amount_refunded: w.piRefunded, refunded: w.piRefunded >= AMT,
    disputed: w.disputed, currency: "usd", livemode: false, payment_method_details: { card: { capture_before: (CREATED + 7 * 86400000) / 1000 } } } });
const resObj = (w, id = RID) => ({ id: Number(id), listingMapId: 606998, channelId: 2000, arrivalDate: FROM, departureDate: TO, totalPrice: 140, currency: "USD", status: w.resStatus,
  customFieldValues: w.echoRef ? [{ customFieldId: C.refFieldId, value: REF }] : [] });
const refundObj = (w, over = {}) => ({ object: "refund", id: RE, payment_intent: PI, charge: CH, amount: AMT, currency: "usd", status: "succeeded", created: 1800000000, reason: null, failure_reason: null,
  metadata: { mv_refund_op: REFUND_OP, mv_refund_key: KEY }, ...over });
function exchanges(w, o = {}) {
  const reply = (status, obj) => Promise.resolve({ status, contentType: "application/json", bytes: enc(obj) });
  const stripe = (req) => {
    const p = req.url.replace("https://api.stripe.com", ""); w.calls.push(`S:${req.method} ${p}`);
    if (p === "/v1/account") return reply(200, { object: "account", id: o.otherAccount ? "acct_OTHER0000000001" : ACCT });
    if (req.method === "POST") {
      assert.equal(p, "/v1/refunds"); assert.equal(req.headers["Idempotency-Key"], KEY); assert.equal(req.body, REFUND_BODY);
      w.refundRequests = (w.refundRequests ?? 0) + 1;
      if (o.refundLost) { if (o.refundLandedAnyway) w.piRefunded = AMT; return Promise.reject(new Error("socket reset")); }
      w.piRefunded = AMT; return reply(200, refundObj(w));
    }
    if (p.startsWith("/v1/refunds/")) return reply(200, refundObj(w, o.refundGetOver ?? {}));
    if (p.startsWith("/v1/refunds?")) return reply(200, { object: "list", url: "/v1/refunds", has_more: false, data: w.piRefunded ? [refundObj(w)] : [] });
    const base = piObj(w); const n = (w.piReads = (w.piReads ?? 0) + 1);
    if (o.prePiMutate && n === 1) return reply(200, o.prePiMutate(base));                                   // the FIRST PI read = the runner's pre-request proof read
    if (o.finalPiMutate && w.status === "cancelled") return reply(200, o.finalPiMutate(base));             // a PI read after the worker finished = the runner's final readback
    return reply(200, base);
  };
  const hostaway = (req) => {
    const p = req.url.replace("https://api.hostaway.com", ""); w.calls.push(`H:${req.method} ${p}`);
    if (o.hostawayStatus) return reply(o.hostawayStatus, { status: "fail", message: "unauthorized" });
    if (req.method === "PUT") {
      assert.equal(p, `/v1/reservations/${RID}/statuses/cancelled`); assert.equal(req.body, JSON.stringify({ cancelledBy: "host" })); assert.equal(req.headers["Content-Type"], "application/json");
      w.cancelRequests = (w.cancelRequests ?? 0) + 1;
      if (o.cancelLost) { if (o.cancelLandedAnyway) w.resStatus = "cancelled"; return Promise.reject(new Error("socket reset")); }
      w.resStatus = "cancelled"; return reply(200, { status: "success", result: resObj(w) });
    }
    if (req.method === "GET" && p.startsWith("/v1/reservations?")) {
      w.lookupPages = (w.lookupPages ?? 0) + 1;
      const page = new URL(req.url).searchParams.has("afterId") ? [] : (o.lookupResult ? o.lookupResult(w) : [resObj({ ...w, echoRef: true })]);
      return reply(200, { status: "success", result: page });
    }
    if (req.method === "GET" && /^\/v1\/reservations\/\d+$/.test(p)) { const n = (w.resReads = (w.resReads ?? 0) + 1); const obj = resObj(w, p.split("/").pop());
      return reply(200, { status: "success", result: o.preResMutate && n === 1 ? o.preResMutate(obj) : obj }); }
    return reply(404, { status: "fail" });
  };
  return { stripe, hostaway };
}
/** the fake request: the accepted requestTestCleanup's visible effect (ONE E3 event: test_cleanup_pending, version +1, the recording retired, ONE pristine cancel + ONE pristine bound refund row, ONE 'requested' record) */
function fakeRequest(w, o = {}) {
  return async (pool, intentId, { now, env, operator }) => {
    w.requestCalls += 1;
    assert.equal(intentId, IID); assert.ok(Number.isFinite(now)); assert.deepEqual(env, { VERCEL_ENV: "development", MV_E7_TEST_CLEANUP: "enabled" });
    assert.deepEqual(Object.keys(operator).sort(), [...EXPECTATION_KEYS]); assert.ok(bindsAccepted(operator), "the accepted binding accepts the derived expectation");
    assert.deepEqual([operator.intentId, operator.paymentIntentId, operator.chargeId, operator.capturedMinor, operator.reservationId, operator.sessionId, operator.attemptId, operator.expectedVersion], [IID, PI, CH, AMT, RID, CS, ATTEMPT, VER]);
    if (o.requestThrow) { if (o.requestAppliedAnyway) apply(); throw new Error("connection terminated unexpectedly"); }
    if (o.requestRefuse) return { ok: false, error: o.requestRefuse };
    apply();
    return { ok: true, intent: intentOf(w) };
    function apply() {
      w.status = "test_cleanup_pending"; w.version += 1; w.reasonCode = "TEST_CLEANUP_REQUESTED"; w.settlement = { reservationCancelled: false, authorizationSettled: false };
      Object.assign(rowOf(w, REC), { state: "superseded" });
      w.ops.push(op(CAN, { id: "op-cancel", state: "pending", attempts: 0, dispatched: false, payload_rid: RID }));
      w.ops.push(op(RFD, { id: o.refundOpId ?? REFUND_OP, state: "pending", attempts: 0, dispatched: false, payload_pi: PI, payload_charge: CH, payload_currency: "USD", payload_attempt: 1, payload_amount: AMT, payload_key: o.refundKey ?? KEY }));
      w.refunds.push({ seq: 1, idempotency_key: KEY, state: "requested", hostaway_state: "not_applicable", amt: String(AMT), currency: "USD", stripe_refund_id: null });
      if (o.extraOp) w.ops.push(op("stripe.void_payment_intent", { state: "pending", attempts: 0, dispatched: false }));
    }
  };
}
/** the fake worker: drives the REAL test-cleanup executors (→ real TT / T → the runner fence → fake exchange) the way the accepted worker's two happy steps do:
 *  step 1 (cancel leg): RES read (bound id) → account → PI → ONE cancel PUT → confirming RES read → leg cancelled; step 2 (refund leg): account → PI → ONE refund POST → Refund GET → confirming PI read → cancelled */
function fakeWorker(w, o = {}) {
  return async (pool, { executors, intentId, env, listings, stripeAccountId, signal, deadlineAt, workerId }) => {
    w.workerCalls += 1;
    assert.equal(intentId, IID); assert.deepEqual(env, { VERCEL_ENV: "development", MV_E7_TEST_CLEANUP: "enabled", MV_E7_TEST_CLEANUP_WORKER: "enabled" }); assert.equal(stripeAccountId, ACCT);
    assert.deepEqual([...listings.keys()], [606998]); assert.deepEqual(Object.keys(executors).sort(), [...EX.PHASE_KEYS].sort());
    assert.ok(signal instanceof AbortSignal && Number.isFinite(deadlineAt) && /^e7-hosted-tc:/.test(workerId));
    const sig = AbortSignal.timeout(5000); const actions = []; const cancel = rowOf(w, CAN); const refund = rowOf(w, RFD);
    const out = (extra = {}) => { w.signalAbortedAtEnd = signal.aborted; return { status: "worked", intentId: IID, actions, calls: [], sends: 0, cancelSends: 0, refundSends: 0, stop: null, facts: null, delayMs: o.delayMs ?? 30000, late: Promise.resolve([]), ...extra }; };
    try {
      if (o.foreignRead) await executors.retrieveReservation({ method: "GET", path: `/v1/reservations/${C.protectedReservationIds[0]}`, query: {} }, { signal: sig });
      if (o.wait) { actions.push("WAIT:FAKE"); return out(); }
      if (w.settlement && !w.settlement.reservationCancelled) {
        const rr = await executors.retrieveReservation({ method: "GET", path: `/v1/reservations/${RID}`, query: {} }, { signal: sig });
        if (rr.httpStatus !== 200) { actions.push(`STOP:AUTH_${rr.httpStatus}`); return out({ delayMs: 0 }); }
        if (!w.echoRef) await executors.lookupPage({ method: "GET", path: "/v1/reservations", query: { listingId: 606998, channelId: 2000, arrivalStartDate: FROM, arrivalEndDate: FROM, limit: 100, includeResources: 1 } }, { signal: sig });
        await executors.retrieveAccount({ signal: sig });
        await executors.retrievePaymentIntent(PI, { expand: ["latest_charge"] }, { signal: sig });
        Object.assign(cancel, { state: "in_flight", attempts: 1, dispatched: true });                             // the accepted worker claims the row BEFORE the send
        let reply = null;
        try { reply = await executors.cancelReservation({ method: "PUT", path: `/v1/reservations/${RID}/statuses/cancelled`, query: {}, body: { cancelledBy: "host" } }, { signal: sig }); }
        catch (e) { actions.push(`SEND_FAILED:${e && e.code ? e.code : "TRANSPORT"}`); }
        if (o.twice) { try { await executors.cancelReservation({ method: "PUT", path: `/v1/reservations/${RID}/statuses/cancelled`, query: {}, body: { cancelledBy: "host" } }, { signal: sig }); } catch { actions.push("SECOND_CANCEL_REFUSED"); } }
        if (!reply || reply.httpStatus !== 200) { cancel.state = "outcome_unknown"; actions.push("CANCEL_OUTCOME_UNKNOWN"); return out({ delayMs: 0 }); }
        const cr = await executors.retrieveReservation({ method: "GET", path: `/v1/reservations/${RID}`, query: {} }, { signal: sig });   // the confirming read
        if (cr.json.result.status !== "cancelled") { actions.push("WAIT:CANCEL_NOT_CONFIRMED"); return out(); }
        Object.assign(cancel, { state: "succeeded", result_ref: RID }); w.settlement = { reservationCancelled: true, authorizationSettled: false }; w.version += 1; w.cancelAttempts = 1;
        w.evidence.push({ kind: "hostaway_reservation", external_ref: RID, status: "cancelled" });
        actions.push("RESERVATION_CANCELLED->test_cleanup_pending");
        if (o.escalateAfterCancel) { w.status = "reconciliation_required"; w.version += 1; }
        return out();
      }
      await executors.retrieveAccount({ signal: sig });
      await executors.retrievePaymentIntent(PI, { expand: ["latest_charge"] }, { signal: sig });
      const params = { amount: o.wrongAmount ?? AMT, metadata: { mv_refund_op: o.wrongOp ?? refund.id, mv_refund_key: o.wrongMetaKey ?? KEY } };
      Object.assign(refund, { state: "in_flight", attempts: 1, dispatched: true });
      let reply = null;
      try { reply = await executors.createRefund(PI, params, { idempotencyKey: o.wrongKey ?? KEY, signal: sig }); }
      catch (e) { actions.push(`SEND_FAILED:${e && e.code ? e.code : "TRANSPORT"}`); }
      if (o.twiceRefund) { try { await executors.createRefund(PI, params, { idempotencyKey: KEY, signal: sig }); } catch { actions.push("SECOND_REFUND_REFUSED"); } }
      if (!reply || reply.object !== "refund") { refund.state = "outcome_unknown"; actions.push("REFUND_OUTCOME_UNKNOWN"); return out({ delayMs: 0 }); }
      const re = reply.id;
      await executors.retrieveRefund(re, { signal: sig });
      await executors.retrievePaymentIntent(PI, { expand: ["latest_charge"] }, { signal: sig });                     // the confirming PI read
      Object.assign(refund, { state: o.refundRowStateAfter ?? "succeeded", result_ref: re }); w.refunds[0] = { ...w.refunds[0], state: "succeeded", stripe_refund_id: re };
      w.ledger.push({ entry: "refund_succeeded", amt: String(AMT), currency: "USD", provider_ref: re }); w.evidence.push({ kind: "stripe_refund", external_ref: re, status: "succeeded" });
      w.status = "cancelled"; w.version += 1; w.settlement = { reservationCancelled: true, authorizationSettled: true }; w.claimReleased = !o.keepClaim;
      actions.push("REFUND_SUCCEEDED->cancelled");
      return out({ delayMs: 0 });
    } catch (e) {
      actions.push(`STOP:EXECUTOR_${/stopped/.test(String(e && e.message)) ? "STOPPED" : "FAILED"}`);
      if (cancel && cancel.state === "in_flight") cancel.state = "outcome_unknown";
      if (refund && refund.state === "in_flight") refund.state = "outcome_unknown";
      return out({ delayMs: 0 });
    }
  };
}
const toolingFor = (w, o = {}) => ({ runTestCleanupStep: o.worker ?? fakeWorker(w, o), requestTestCleanup: o.request ?? fakeRequest(w, o), loadIntent: async () => intentOf(w),
  createTestCleanupExecutors: EX.createTestCleanupExecutors, createStripeSend: TT.createE7StripeTestCleanupSend, createHostawaySend: T.createE7HostawaySend, validateAdapterConfig: HR.validateAdapterConfig,
  unwrapEnvelope: HR.unwrapEnvelope, normalizeReservation: HR.normalizeReservation, lookupByRef: HR.lookupByRef, activeReservationProof: CO.activeReservationProof, paymentIntentProofObservationV3: CP.paymentIntentProofObservationV3, piIdentityOk: RP.piIdentityOk,
  rawPiPreSendRefusal: TP.rawPiPreSendRefusal, refundObservation: TP.refundObservation, arrivalStrictlyFuture: CO.arrivalStrictlyFuture, refundKey: IS.refundKey, publicStatus: IS.publicStatus,
  LOCK_KEY: LK.LOCK_KEY, LOCK_PRECHECK_SQL: LK.LOCK_PRECHECK_SQL });
function core(w, o = {}) {
  const pool = o.pool ?? fakePool(w, o); w.pool = pool;
  const x = exchanges(w, o);
  const b = o.built ?? built();
  return E.runTestCleanupCore({ plan: b.plan, planHash: o.planHash ?? b.planHash, pool, lockClientFactory: () => pool.lock(), tooling: { ...toolingFor(w, o), ...(o.toolingOver ?? {}) }, exchanges: o.wrapExchanges ? o.wrapExchanges(x) : x,
    credentials: { stripe: () => "sk_test_Fake1", hostaway: () => "synthetic-hostaway-token" }, sleep: async () => {}, runSignal: o.signal, monotonic: o.monotonic,
    clock: () => (o.clockBase ?? Date.UTC(2026, 10, 12, 16, 0, 0)) + (w.tick = (w.tick ?? 0) + 1000) });
}
const posts = (w) => w.calls.filter((x) => /^(S:POST|H:POST|H:PUT|H:DELETE|S:DELETE)/.test(x));
const CANCEL_URL = `H:PUT /v1/reservations/${RID}/statuses/cancelled`; const REFUND_URL = "S:POST /v1/refunds";

// ---------------------------------------------------------------------------------------------------------------------------------
test("A1 happy path (FAKE DB / request / worker, REAL transports + executors + proofs): account + strict unrefunded PI proof + active reservation, lock proven before the request and before EVERY step, ONE request, exactly ONE cancel PUT then ONE refund POST (exact URL / body / key), readbacks, cancelled / not_completed_refunded, lock released", async () => {
  for (const echoRef of [true, false]) {
    const w = world({ echoRef });
    const r = await core(w);
    assert.equal(r.outcome, "TEST_CLEANUP_COMPLETED", JSON.stringify(r));
    assert.deepEqual([r.requestInvocations, r.requestOutcome, r.steps, r.cancelInvocations, r.cancelOutcome, r.refundInvocations, r.refundOutcome, r.reservationId, r.capturedMinor, r.chargeId, r.refundId, r.lock, w.lockReleased, r.publicStatus],
      [1, "REPLIED", 2, 1, "REPLIED", 1, "REPLIED", RID, AMT, CH, RE, "released", "pooled", "not_completed_refunded"]);
    assert.deepEqual(posts(w), [CANCEL_URL, REFUND_URL], "cancel FIRST, then the refund; nothing else");
    assert.deepEqual(r.proofs, ["PROVIDER_BEFORE_REQUEST", "BEFORE_REQUEST", "BEFORE_WORKER", "BEFORE_STEP_2", "BEFORE_READBACK", "READBACK"]);
    assert.deepEqual(r.postcheck, { cancelOps: 1, refundOps: 1, refundRecord: "succeeded", refundId: RE, capturedMinor: AMT, recordingRetired: true, claimReleased: true, openCases: 0,
      legs: { reservationCancelled: true, authorizationSettled: true }, publicStatus: "not_completed_refunded" });
    assert.deepEqual(r.writes, { request: 1, cancel: 1, refund: 1, capture: 0, create: 0, record: 0, notify: 0, void: 0 });
    assert.deepEqual([r.cancelOps, r.refundOps, r.refundRecord, r.recordingRetired, r.claimHeld, r.legs], [["succeeded"], ["succeeded"], ["succeeded"], true, false, { reservationCancelled: true, authorizationSettled: true }]);
    assert.ok(r.actions.includes("RESERVATION_CANCELLED->test_cleanup_pending") && r.actions.includes("REFUND_SUCCEEDED->cancelled"));
    assert.equal(w.calls.some((x) => /capture|void|guestPayments|\/reservations$/.test(x) && /^(S:POST|H:POST)/.test(x)), false);
    assert.ok(w.calls.filter((x) => x === `S:GET /v1/refunds/${RE}`).length >= 2, "the worker's refund read AND the runner's fresh readback passed the fence");
    assert.ok(w.calls.filter((x) => x === `H:GET /v1/reservations/${RID}`).length >= 3, "pre-request read + the worker's reads + the runner's cancelled readback");
    if (!echoRef) assert.ok(w.calls.some((x) => x.startsWith("H:GET /v1/reservations?")), "by-ref lookup for THIS arrival passed the fence");
    assert.equal(JSON.stringify(r).includes("sk_test"), false); assert.equal(JSON.stringify(r).includes("synthetic-hostaway-token"), false);
  }
});

test("A2 strict provider proofs gate the request: partly refunded / disputed charge / wrong account / PI identity / cancelled reservation / past arrival / 401 → PROVIDER_PROOF_FAILED with ZERO request, ZERO worker, ZERO writes", async () => {
  for (const [label, mutate, o, code] of [["refunded", (w) => { w.piRefunded = 1; }, {}, "CHARGE_ALREADY_REFUNDED"], ["disputed", (w) => { w.disputed = true; }, {}, "RAW_CHARGE_DISPUTED"],
    ["other account", () => {}, { otherAccount: true }, null], ["cancelled at the provider", (w) => { w.resStatus = "cancelled"; }, {}, "RESERVATION_BY_ID_RESERVATION_NOT_ACTIVE"],
    ["past arrival", () => {}, { clockBase: Date.UTC(2028, 0, 15) }, "ARRIVAL_NOT_IN_FUTURE"], ["401", () => {}, { hostawayStatus: 401 }, "RESERVATION_READ_401"],
    ["wrong metadata", () => {}, { wrapExchanges: (x) => ({ hostaway: x.hostaway, stripe: (req) => (req.method === "GET" && /payment_intents/.test(req.url)
      ? Promise.resolve({ status: 200, contentType: "application/json", bytes: enc({ ...piObj(world()), metadata: { mv_intent_id: "other" } }) }) : x.stripe(req)) }) }, "PAYMENT_INTENT_IDENTITY"]]) {
    const w = world(); mutate(w);
    const r = await core(w, o);
    assert.equal(r.outcome, "PROVIDER_PROOF_FAILED", `${label}: ${JSON.stringify(r)}`);
    if (code) assert.equal(r.code, code, label); else assert.ok(["ACCOUNT", "READ_FAILED"].includes(r.code), r.code);
    assert.deepEqual([w.requestCalls, w.workerCalls, posts(w).length, r.lock, w.status], [0, 0, 0, "released", "payment_captured"], label);
  }
});

test("A3 start refusals (read-only, ZERO provider calls, ZERO lock, ZERO request): state / version / pins (PI, reservation, charge, amount, stay, session, attempt) / historic / protected / open case / forbidden op / recording not pristine / refund present / lease / work lease / claim / non-TEST / schema prerequisite missing", async () => {
  const cases = [
    [world({ status: "reservation_confirmed" }), {}, "START_STATE_NOT_ELIGIBLE", "STATE_NOT_PAYMENT_CAPTURED"],
    [world({ status: "test_cleanup_pending" }), {}, "START_STATE_NOT_ELIGIBLE", "STATE_NOT_PAYMENT_CAPTURED"],
    [world({ status: "cancelled" }), {}, "START_STATE_NOT_ELIGIBLE", "STATE_NOT_PAYMENT_CAPTURED"],
    [world(), { built: built({ expectedVersion: VER - 1 }) }, "START_STATE_NOT_ELIGIBLE", "VERSION_NOT_PINNED"],
    [world(), { built: built({ paymentIntentId: "pi_FAKEother00000001" }) }, "SCOPE_REFUSED", "PAYMENT_INTENT_NOT_PINNED"],
    [world(), { built: built({ reservationId: "71999902" }) }, "SCOPE_REFUSED", "RESERVATION_NOT_PINNED"],
    [world(), { built: built({ chargeId: "ch_FAKEother00000001" }) }, "SCOPE_REFUSED", "CAPTURE_ROW_NOT_BOUND"],
    [world(), { built: built({ capturedMinor: AMT + 100 }) }, "SCOPE_REFUSED", "AMOUNT_NOT_PINNED"],
    [world(), { built: built({ from: "2026-11-24" }) }, "SCOPE_REFUSED", "STAY_NOT_PINNED"],
    [world(), { built: built({ sessionId: "cs_test_FAKEother0001" }) }, "SCOPE_REFUSED", "SESSION_NOT_PINNED"],
    [world(), { built: built({ attemptId: "aaaaaaaa-bbbb-4ccc-8ddd-000000000000" }) }, "SCOPE_REFUSED", "PAYMENT_ATTEMPT_NOT_BOUND"],
    [world({ createdAt: Date.UTC(2026, 10, 11, 0, 0, 0) }), {}, "START_STATE_NOT_ELIGIBLE", "HISTORIC_INTENT"],
    [(() => { const w = world(); w.hx = [{ state: "succeeded", rid: C.protectedReservationIds[1] }]; return w; })(), {}, "SCOPE_REFUSED", "RESERVATION_ID_CONFLICT"],
    [world(), { cases: 1 }, "SCOPE_REFUSED", "OPEN_CASE"],
    [(() => { const w = world(); w.ops.push(op("stripe.void_payment_intent", { state: "pending", attempts: 0, dispatched: false })); return w; })(), {}, "SCOPE_REFUSED", "FORBIDDEN_OP_PRESENT"],
    [(() => { const w = world(); w.ops.push(op("guest.notify", { state: "pending", attempts: 0, dispatched: false })); return w; })(), {}, "SCOPE_REFUSED", "FORBIDDEN_OP_PRESENT"],
    [(() => { const w = world(); w.ops.push(op(CAN, { state: "pending", attempts: 0, dispatched: false })); return w; })(), {}, "SCOPE_REFUSED", "UNEXPECTED_OP"],
    [(() => { const w = world(); Object.assign(rowOf(w, REC), { dispatched: true, attempts: 1 }); return w; })(), {}, "START_STATE_NOT_ELIGIBLE", "RECORDING_NOT_PRISTINE"],
    [(() => { const w = world(); Object.assign(rowOf(w, REC), { state: "superseded" }); return w; })(), {}, "START_STATE_NOT_ELIGIBLE", "RECORDING_NOT_PRISTINE"],
    [(() => { const w = world(); w.ops = w.ops.filter((x) => x.op_type !== REC); return w; })(), {}, "START_STATE_NOT_ELIGIBLE", "RECORDING_NOT_PRISTINE"],
    [(() => { const w = world(); w.refunds.push({ seq: 1, idempotency_key: KEY, state: "requested", hostaway_state: "not_applicable", amt: String(AMT), currency: "USD", stripe_refund_id: null }); return w; })(), {}, "SCOPE_REFUSED", "REFUND_PRESENT"],
    [(() => { const w = world(); w.ledger.push({ entry: "authorization_voided", amt: String(AMT), currency: "USD", provider_ref: PI }); return w; })(), {}, "SCOPE_REFUSED", "LEDGER_MISMATCH"],
    [(() => { const w = world(); w.ledger[1].amt = String(AMT - 1); return w; })(), {}, "SCOPE_REFUSED", "LEDGER_MISMATCH"],
    [(() => { const w = world(); w.evidence.push({ kind: "stripe_refund", external_ref: RE, status: "succeeded" }); return w; })(), {}, "SCOPE_REFUSED", "EVIDENCE_CONFLICT"],
    [(() => { const w = world(); w.lease = { workerId: "w1", until: 1 }; return w; })(), {}, "START_STATE_NOT_ELIGIBLE", "RESERVATION_LEASE_HELD"],
    [(() => { const w = world(); w.workLeased = true; return w; })(), {}, "START_STATE_NOT_ELIGIBLE", "WORK_LEASE_HELD"],
    [(() => { const w = world(); w.captureAttempts = 2; return w; })(), {}, "START_STATE_NOT_ELIGIBLE", "HISTORY_NOT_INITIAL"],
    [(() => { const w = world(); w.reasonCode = "TEST_CLEANUP_REQUESTED"; return w; })(), {}, "START_STATE_NOT_ELIGIBLE", "REASON_CODE_PRESENT"],
    [world(), { env: "production" }, "SCOPE_REFUSED", "DATABASE_NOT_TEST"],
    [world(), { intentEnv: "production" }, "SCOPE_REFUSED", "INTENT_NOT_TEST"],
    [(() => { const w = world(); w.claimReleased = true; return w; })(), {}, "SCOPE_REFUSED", "CLAIM_NOT_HELD"],
    [(() => { const w = world(); rowOf(w, "hostaway.create_reservation").state = "outcome_unknown"; return w; })(), {}, "SCOPE_REFUSED", "CREATE_NOT_PROVEN_SUCCEEDED"],
    [(() => { const w = world(); rowOf(w, CAP).payload_key = "cap:other"; return w; })(), {}, "SCOPE_REFUSED", "CAPTURE_ROW_NOT_BOUND"],
    [(() => { const w = world(); w.schema.f0020 = false; return w; })(), {}, "SCHEMA_PREREQUISITE_MISSING", "SCHEMA_PREREQUISITE_MISSING"],
    [(() => { const w = world(); w.schema.pending_state = false; return w; })(), {}, "SCHEMA_PREREQUISITE_MISSING", "SCHEMA_PREREQUISITE_MISSING"],
    [(() => { const w = world(); w.schema.retirement_fence = null; return w; })(), {}, "SCHEMA_PREREQUISITE_MISSING", "SCHEMA_PREREQUISITE_MISSING"]];
  for (const [w, o, outcome, code] of cases) {
    const r = await core(w, o);
    assert.deepEqual([r.outcome, r.code, w.calls.length, w.requestCalls, w.workerCalls, r.lock, r.requestInvocations], [outcome, code, 0, 0, 0, "not_acquired", 0], code);
  }
  { const f = { instance: "test", intent: { ...intentOf(world()), listingId: 603566 }, attempts: [], hostaway: [], ops: [], openCases: 0, claims: [], workLeased: false, refunds: [], ledger: [], evidence: [], row: { environment: "test" }, schema: {} };
    assert.equal(E.checkStart(f, built().plan).code, "LISTING_NOT_SCOPED"); }
  { const b = built(); const w = world(); const r = await core(w, { built: b, planHash: "0".repeat(64) }); assert.deepEqual([r.outcome, w.calls.length], ["CORE_INVALID", 0], "the plan hash must be the plan's own"); }
  { const w = world(); const r = await core(w, { built: { plan: { ...built().plan, refundIdempotencyKey: "ref:other:1" }, planHash: "x" } }); assert.deepEqual([r.outcome, w.calls.length], ["CORE_INVALID", 0]); }
});

test("A4 real lock semantics: held elsewhere → LOCK_NOT_ACQUIRED, zero provider calls, zero request; lost at the pre-request proof → LOCK_LOST with ZERO request; lost before step 2 → LOCK_LOST after the cancel, ZERO refund; backend hop refused; observed session error mid-step vetoes the cancel", async () => {
  { const w = world(); const r = await core(w, { lockHeldElsewhere: true });
    assert.deepEqual([r.outcome, r.code, w.calls.length, w.requestCalls, w.workerCalls, r.lock], ["LOCK_NOT_ACQUIRED", "RUN_LOCK_PRESENT", 0, 0, 0, "not_acquired"]); }
  { const w = world(); const r = await core(w, { onProofResolve: (n) => { if (n === 2) w.lockRows = 0; } });      // proofs: #1 acquire, #2 BEFORE_REQUEST
    assert.deepEqual([r.outcome, r.code, w.requestCalls, w.workerCalls, r.requestInvocations, r.lock, w.status], ["LOCK_LOST", "LOCK_NOT_HELD", 0, 0, 0, "released", "payment_captured"], JSON.stringify(r)); }
  { const w = world(); const r = await core(w, { onProofResolve: (n) => { if (n === 4) w.lockRows = 0; } });      // #3 BEFORE_WORKER, #4 BEFORE_STEP_2
    assert.deepEqual([r.outcome, r.code, w.workerCalls, r.cancelInvocations, r.refundInvocations, posts(w), r.finalState], ["LOCK_LOST", "LOCK_NOT_HELD", 1, 1, 0, [CANCEL_URL], "test_cleanup_pending"], JSON.stringify(r)); }
  { const w = world(); const r = await core(w, { hopAtProof: 1 });
    assert.deepEqual([r.outcome, r.code, w.requestCalls, r.lockSession], ["LOCK_NOT_ACQUIRED", "BACKEND_HOP", 0, "backend_hop"], JSON.stringify(r)); }
  { const w = world(); const r = await core(w, { hopAtProof: 2 });
    assert.deepEqual([r.outcome, r.code, w.requestCalls, w.workerCalls], ["LOCK_LOST", "BACKEND_HOP", 0, 0], JSON.stringify(r)); }
  { const w = world();  // the error is observed as the worker's PI read resolves (before the cancel): the cancel transport is vetoed
    const r = await core(w, { wrapExchanges: (x) => ({ hostaway: x.hostaway, stripe: async (req) => { const out = await x.stripe(req); if (w.workerCalls > 0 && /payment_intents\/pi_/.test(req.url) && req.method === "GET") w.lockClient.errorFn(new Error("SYNTHETIC_PRIVATE_ERROR_CANARY")); return out; } }) });
    assert.deepEqual([r.outcome, r.code, r.cancelInvocations, posts(w).length, r.lockSession, r.lock, w.lockReleased, w.signalAbortedAtEnd], ["LOCK_LOST", "STOP_LOCK_SESSION_ERROR", 0, 0, "error_observed", "session_error_connection_destroyed", "destroyed", true], JSON.stringify(r));
    assert.equal(JSON.stringify(r).includes("CANARY"), false, "no raw error text"); }
});

test("F1 (ROOT 5881490593) complete state-independent v3 PI proof BEFORE the request: each single contradictory / missing field of the expanded PI + charge refuses with ZERO request / worker / writes (controls pass)", async () => {
  const mut = (f) => (pi) => { const x = JSON.parse(JSON.stringify(pi)); f(x); return x; };
  const cases = [
    ["charge.payment_intent foreign", mut((x) => { x.latest_charge.payment_intent = "pi_OTHER000000"; }), "CHARGE_NOT_BOUND"],
    ["amount_capturable 1", mut((x) => { x.amount_capturable = 1; }), "AMOUNT_CAPTURABLE_NOT_ZERO"],
    ["amount_received short", mut((x) => { x.amount_received = AMT - 1; }), "AMOUNT_RECEIVED_NOT_CAPTURED"],
    ["pi amount", mut((x) => { x.amount = AMT + 1; }), "PAYMENT_INTENT_IDENTITY"],
    ["pi status", mut((x) => { x.status = "requires_capture"; }), "PI_NOT_SUCCEEDED"],
    ["pi currency", mut((x) => { x.currency = "mxn"; }), "PAYMENT_INTENT_IDENTITY"],
    ["capture_method automatic", mut((x) => { x.capture_method = "automatic"; }), "PAYMENT_INTENT_IDENTITY"],
    ["metadata intent", mut((x) => { x.metadata.mv_intent_id = "other"; }), "PAYMENT_INTENT_IDENTITY"],
    ["metadata attempt", mut((x) => { x.metadata.mv_payment_attempt_id = "other"; }), "PAYMENT_INTENT_IDENTITY"],
    ["pi livemode", mut((x) => { x.livemode = true; }), null],                                                         // the isolated transport refuses LIVEMODE_REFUSED before the proof (READ_FAILED)
    ["charge not expanded", mut((x) => { x.latest_charge = CH; }), "CHARGE_NOT_EXPANDED"],
    ["charge id foreign", mut((x) => { x.latest_charge.id = "ch_OTHER0000000000"; }), "CHARGE_ID_MISMATCH"],
    ["charge object", mut((x) => { x.latest_charge.object = "refund"; }), "CHARGE_NOT_EXPANDED"],
    ["charge livemode", mut((x) => { x.latest_charge.livemode = true; }), "CHARGE_NOT_TEST_MODE"],
    ["charge status", mut((x) => { x.latest_charge.status = "pending"; }), "CHARGE_STATUS"],
    ["charge paid false", mut((x) => { x.latest_charge.paid = false; }), "CHARGE_NOT_PAID"],
    ["charge captured false", mut((x) => { x.latest_charge.captured = false; }), "CHARGE_NOT_CAPTURED"],
    ["charge amount", mut((x) => { x.latest_charge.amount = AMT - 1; }), "CHARGE_AMOUNT"],
    ["charge amount_captured", mut((x) => { x.latest_charge.amount_captured = AMT - 1; }), "CHARGE_AMOUNT_CAPTURED"],
    ["charge currency", mut((x) => { x.latest_charge.currency = "mxn"; }), "CHARGE_CURRENCY"],
    ["charge amount_refunded", mut((x) => { x.latest_charge.amount_refunded = 1; }), "CHARGE_ALREADY_REFUNDED"],
    ["charge refunded flag", mut((x) => { x.latest_charge.refunded = true; }), "RAW_CHARGE_REFUNDED"],
    ["charge disputed", mut((x) => { x.latest_charge.disputed = true; }), "RAW_CHARGE_DISPUTED"],
    ["charge dispute present", mut((x) => { x.latest_charge.dispute = { id: "dp_x" }; }), "RAW_CHARGE_DISPUTE_PRESENT"],
    ["charge refunds list non-empty", mut((x) => { x.latest_charge.refunds = { object: "list", data: [{ id: "re_x" }], has_more: false }; }), "RAW_CHARGE_REFUNDS_PRESENT"],
    ["disputed missing", mut((x) => { delete x.latest_charge.disputed; }), "RAW_CHARGE_DISPUTED"],
    ["refunded missing", mut((x) => { delete x.latest_charge.refunded; }), "RAW_CHARGE_REFUNDED"]];
  for (const [label, prePiMutate, code] of cases) {
    const w = world(); const r = await core(w, { prePiMutate });
    assert.equal(r.outcome, "PROVIDER_PROOF_FAILED", `${label}: ${JSON.stringify(r)}`);
    if (code) assert.equal(r.code, code, label); else assert.equal(r.code, "READ_FAILED", label);
    assert.deepEqual([w.requestCalls, w.workerCalls, posts(w).length, r.requestInvocations, w.status], [0, 0, 0, 0, "payment_captured"], label);
  }
  { const w = world(); const r = await core(w, { prePiMutate: (pi) => pi }); assert.equal(r.outcome, "TEST_CLEANUP_COMPLETED", "control"); }
  // the adapter itself, in isolation: state-independent (payment_captured AND cancelled intents), both phases
  const okPi = piObj({ piRefunded: 0, disputed: false }); const obs = CP.paymentIntentProofObservationV3(okPi, { accountVerified: true });
  const ev = { id: "x", kind: "payment_intent", readOpType: "stripe.retrieve_payment_intent", requestRef: PI, externalRef: PI, status: obs.status, observed: obs, observedAt: 1 };
  for (const status of ["payment_captured", "cancelled", "test_cleanup_pending"]) {
    const intent = { ...intentOf(world()), status };
    assert.equal(E.piCapturedV3Refusal(ev, { intent, attemptId: ATTEMPT, chargeId: CH, capturedMinor: AMT, currency: "USD", phase: "unrefunded" }, RP.piIdentityOk), null, status);
    assert.equal(E.piCapturedV3Refusal(ev, { intent, attemptId: ATTEMPT, chargeId: CH, capturedMinor: AMT, currency: "USD", phase: "fully_refunded" }, RP.piIdentityOk), "CHARGE_NOT_FULLY_REFUNDED", status);
    assert.equal(E.piCapturedV3Refusal(ev, { intent, attemptId: ATTEMPT, chargeId: CH, capturedMinor: AMT, currency: "USD", phase: "other" }, RP.piIdentityOk), "PHASE_INVALID");
    assert.equal(E.piCapturedV3Refusal({ ...ev, observed: { ...obs, proofVersion: "pi-proof-v2" } }, { intent, attemptId: ATTEMPT, chargeId: CH, capturedMinor: AMT, currency: "USD", phase: "unrefunded" }, RP.piIdentityOk), "V3_OBSERVATION_REQUIRED");
  }
  // parity with the ACCEPTED proof where the accepted one CAN judge (a test_cleanup_pending intent): the same verdict on every v3-visible mutant;
  // the RAW-only mutants (refunded flag / dispute / refunds list / missing booleans) are invisible to BOTH v3 proofs and are caught by the raw safeguards
  const pending = { ...intentOf(world()), status: "test_cleanup_pending", settlement: { reservationCancelled: false, authorizationSettled: false } };
  for (const [label, m] of cases) {
    const bad = m(okPi); const o2 = CP.paymentIntentProofObservationV3(bad, { accountVerified: true });
    const e2 = { ...ev, status: o2.status, observed: o2, observedAt: 10 };
    const mine = E.piCapturedV3Refusal(e2, { intent: pending, attemptId: ATTEMPT, chargeId: CH, capturedMinor: AMT, currency: "USD", phase: "unrefunded" }, RP.piIdentityOk);
    const theirs = TP.piCapturedUnrefundedProofV3(e2, pending, ATTEMPT, CH, { now: 20, notBefore: 1 });
    if (mine === null) assert.equal(theirs, null, `${label}: accepted=${theirs}`); else assert.equal(mine, theirs, `${label}: mine=${mine} accepted=${theirs}`);
    if (mine === null) assert.notEqual(TP.rawPiPreSendRefusal(bad, { paymentIntentId: PI, chargeId: CH, amountMinor: AMT, currency: "USD" }), null, `${label}: raw safeguard`);
  }
});

test("F1 (ROOT 5881490593) complete v3 PI proof at the FINAL readback: each single contradictory field (foreign charge PI, paid false, not fully refunded, refunded flag, dispute, amounts, identity) → POSTCHECK_MISMATCH, never TEST_CLEANUP_COMPLETED; persisted facts reported", async () => {
  const mut = (f) => (pi) => { const x = JSON.parse(JSON.stringify(pi)); f(x); return x; };
  const cases = [
    ["charge.payment_intent foreign", mut((x) => { x.latest_charge.payment_intent = "pi_OTHER000000"; }), "PI_READBACK_CHARGE_NOT_BOUND"],
    ["charge paid false", mut((x) => { x.latest_charge.paid = false; }), "PI_READBACK_CHARGE_NOT_PAID"],
    ["both (ROOT mutant)", mut((x) => { x.latest_charge.payment_intent = "pi_OTHER000000"; x.latest_charge.paid = false; }), "PI_READBACK_CHARGE_NOT_BOUND"],
    ["not fully refunded", mut((x) => { x.latest_charge.amount_refunded = AMT - 1; }), "PI_READBACK_CHARGE_NOT_FULLY_REFUNDED"],
    ["refunded flag false", mut((x) => { x.latest_charge.refunded = false; }), "PI_READBACK_RAW_CHARGE_REFUNDED_FLAG"],
    ["disputed", mut((x) => { x.latest_charge.disputed = true; }), "PI_READBACK_RAW_CHARGE_DISPUTED"],
    ["dispute present", mut((x) => { x.latest_charge.dispute = { id: "dp_x" }; }), "PI_READBACK_RAW_CHARGE_DISPUTE_PRESENT"],
    ["charge id foreign", mut((x) => { x.latest_charge.id = "ch_OTHER0000000000"; }), "PI_READBACK_CHARGE_ID_MISMATCH"],
    ["amount_received", mut((x) => { x.amount_received = 0; }), "PI_READBACK_AMOUNT_RECEIVED_NOT_CAPTURED"],
    ["metadata attempt", mut((x) => { x.metadata.mv_payment_attempt_id = "other"; }), "PI_READBACK_PAYMENT_INTENT_IDENTITY"],
    ["charge captured false", mut((x) => { x.latest_charge.captured = false; }), "PI_READBACK_CHARGE_NOT_CAPTURED"],
    ["charge amount", mut((x) => { x.latest_charge.amount = AMT + 1; }), "PI_READBACK_CHARGE_AMOUNT"],
    ["charge not expanded", mut((x) => { x.latest_charge = CH; }), "PI_READBACK_CHARGE_NOT_EXPANDED"]];
  for (const [label, finalPiMutate, code] of cases) {
    const w = world(); const r = await core(w, { finalPiMutate });
    assert.deepEqual([r.outcome, r.code, r.cancelInvocations, r.refundInvocations, r.finalState, r.postcheck], ["POSTCHECK_MISMATCH", code, 1, 1, "cancelled", null], `${label}: ${JSON.stringify(r)}`);
    assert.equal(r.proofs.includes("READBACK"), false, label);
  }
  { const w = world(); const r = await core(w, { finalPiMutate: (pi) => pi }); assert.equal(r.outcome, "TEST_CLEANUP_COMPLETED", "control"); }
});

test("F2 (ROOT 5881490593) fully bound ACTIVE reservation proof BEFORE the request (accepted activeReservationProof over runner-read observations): total / channel / foreign non-null ref / status not new / listing / stay / currency each refuse with ZERO request; missing ref → ONE bounded lookup proving exactly this reservation (duplicate / none / other id / stay mismatch refuse); echoed + no-echo controls pass", async () => {
  const mut = (f) => (obj) => { const x = JSON.parse(JSON.stringify(obj)); f(x); return x; };
  const cases = [
    ["totalPrice 999", mut((x) => { x.totalPrice = 999; }), "RESERVATION_BY_ID_RESERVATION_IDENTITY"],
    ["channelId 123", mut((x) => { x.channelId = 123; }), "RESERVATION_CHANNEL_NOT_DIRECT"],
    ["ref MV-OTHER000", mut((x) => { x.customFieldValues = [{ customFieldId: C.refFieldId, value: "MV-OTHER000" }]; }), "RESERVATION_BOOKING_REF_MISMATCH"],
    ["status modified", mut((x) => { x.status = "modified"; }), "RESERVATION_BY_ID_RESERVATION_STATUS_NOT_NEW"],
    ["status inquiry", mut((x) => { x.status = "inquiry"; }), "RESERVATION_BY_ID_RESERVATION_STATUS_NOT_NEW"],
    ["status cancelled", mut((x) => { x.status = "cancelled"; }), "RESERVATION_BY_ID_RESERVATION_NOT_ACTIVE"],
    ["status unknown string", mut((x) => { x.status = "mystery"; }), "RESERVATION_MALFORMED"],
    ["listing other", mut((x) => { x.listingMapId = 603566; }), "RESERVATION_BY_ID_RESERVATION_IDENTITY"],
    ["arrival other", mut((x) => { x.arrivalDate = "2026-11-24"; }), "RESERVATION_BY_ID_RESERVATION_IDENTITY"],
    ["departure other", mut((x) => { x.departureDate = "2026-11-27"; }), "RESERVATION_BY_ID_RESERVATION_IDENTITY"],
    ["currency MXN", mut((x) => { x.currency = "MXN"; }), "RESERVATION_BY_ID_RESERVATION_IDENTITY"],
    ["id other", mut((x) => { x.id = 71999902; }), "RESERVATION_BY_ID_RESERVATION_ID_MISMATCH"],
    ["id protected", mut((x) => { x.id = Number(C.protectedReservationIds[0]); }), "RESERVATION_BY_ID_RESERVATION_ID_MISMATCH"]];
  for (const [label, preResMutate, code] of cases) {
    const w = world(); const r = await core(w, { preResMutate });
    assert.equal(r.outcome, "PROVIDER_PROOF_FAILED", `${label}: ${JSON.stringify(r)}`); assert.equal(r.code, code, label);
    assert.deepEqual([w.requestCalls, w.workerCalls, posts(w).length, r.requestInvocations, w.status, w.lookupPages ?? 0], [0, 0, 0, 0, "payment_captured", 0], label);
  }
  // missing ref: the lookup decides — exactly one identical match passes; duplicates / none / another id / stay disagreement refuse with ZERO request
  const other = (w) => ({ ...resObj({ ...w, echoRef: true }), id: 71999902 });
  for (const [label, lookupResult, code] of [["duplicate ref", (w) => [resObj({ ...w, echoRef: true }), other(w)], "LOOKUP_DUPLICATE_REF"], ["none", () => [], "LOOKUP_NOT_FOUND"],
    ["other id only", (w) => [other(w)], "RESERVATION_BY_REF_RESERVATION_ID_MISMATCH"], ["departure disagrees", (w) => [{ ...resObj({ ...w, echoRef: true }), departureDate: "2026-11-27" }], "LOOKUP_MATCH_DISAGREES"]]) {
    const w = world({ echoRef: false }); const r = await core(w, { lookupResult });
    assert.equal(r.outcome, "PROVIDER_PROOF_FAILED", `${label}: ${JSON.stringify(r)}`); assert.equal(r.code, code, label);
    assert.deepEqual([w.requestCalls, w.workerCalls, posts(w).length, r.requestInvocations], [0, 0, 0, 0], label);
    assert.ok((w.lookupPages ?? 0) >= 1 && r.lookupPages <= 3, `${label}: bounded lookup pages ${w.lookupPages}`);
  }
  for (const echoRef of [true, false]) { const w = world({ echoRef }); const r = await core(w); assert.equal(r.outcome, "TEST_CLEANUP_COMPLETED", `control echoRef=${echoRef}`); assert.equal((w.lookupPages ?? 0) > 0, !echoRef); }
  // a lookup page that is not THIS arrival never leaves the process (fence) — the accepted lookupByRef always asks for the pinned arrival, so this is the fence test
  { const w = world({ echoRef: false }); const r = await core(w, { toolingOver: { lookupByRef: (spec, cfg, fetchPage) => HR.lookupByRef({ ...spec, arrivalDate: "2026-11-24", departureDate: "2026-11-25" }, cfg, fetchPage) } });
    assert.equal(r.outcome, "PROVIDER_PROOF_FAILED"); assert.equal(w.lookupPages ?? 0, 0, "no foreign-arrival page reached the exchange"); assert.ok(r.refusedAtTransport >= 1); }
});

test("F3 (ROOT 5881490593) the lock-session error aborts the worker's OWN signal synchronously: an error observed while the worker is between awaits leaves signal.aborted TRUE before its next admission; transports refuse; latched deadline / outer abort also abort the composed signal", async () => {
  { const w = world(); let seenAbortedAtEmit = null;   // the fake worker: emit the lock error right after the cancel PUT reply lands (inside the step), then inspect the signal
    const r = await core(w, { worker: async (pool, { executors, signal }) => {
      await executors.retrieveAccount({ signal: AbortSignal.timeout(1000) });
      w.lockClient.errorFn(new Error("SYNTHETIC_PRIVATE_ERROR_CANARY"));
      seenAbortedAtEmit = signal.aborted;                                                                  // synchronous: no await between the emit and this read
      let refused = false; try { await executors.retrievePaymentIntent(PI, { expand: ["latest_charge"] }, { signal: AbortSignal.timeout(1000) }); } catch { refused = true; }
      return { status: "worked", intentId: IID, actions: [refused ? "PI_READ_REFUSED_AFTER_LOCK_ERROR" : "PI_READ_WENT_THROUGH"], delayMs: 0, late: Promise.resolve([]), refused };
    } });
    assert.deepEqual([seenAbortedAtEmit, r.outcome, r.code, r.cancelInvocations, r.refundInvocations, r.lock, w.lockReleased], [true, "LOCK_LOST", "STOP_LOCK_SESSION_ERROR", 0, 0, "session_error_connection_destroyed", "destroyed"], JSON.stringify(r));
    assert.ok(r.actions.includes("PI_READ_REFUSED_AFTER_LOCK_ERROR")); assert.equal(JSON.stringify(r).includes("CANARY"), false); }
  { const w = world(); const ac = new AbortController(); let seen = null;                                   // outer abort → composed signal aborted (semantics kept)
    const r = await core(w, { signal: ac.signal, worker: async (pool, { signal }) => { ac.abort(); seen = signal.aborted; return { status: "worked", intentId: IID, actions: [], delayMs: 0, late: Promise.resolve([]) }; } });
    assert.deepEqual([seen, r.outcome], [true, "ABORTED"]); }
  { const w = world(); let m = 0; let seen = null;                                                         // deadline latched by a stop check → composed signal aborted
    const r = await core(w, { monotonic: () => (m > 0 ? 10 ** 9 : 0), worker: async (pool, { signal }) => { m = 1; const before = signal.aborted; await Promise.resolve(); return { status: "worked", intentId: IID, actions: [`BEFORE:${before}`], delayMs: 0, late: Promise.resolve([]), seen: (seen = signal) }; } });
    assert.equal(r.outcome, "DEADLINE"); assert.equal(seen.aborted, true, "the latched deadline aborted the worker's signal"); }
});

test("A5 v1 uncertainty: lost cancel reply → WRITE_OUTCOME_UNKNOWN / LOST_CANCEL_REPLY, exactly ONE PUT, ZERO refund, NO further step, facts reported; lost refund reply → LOST_REFUND_REPLY with exactly ONE POST; a SECOND SESSION on the same intent refuses read-only with ZERO sends; a second write in the same step never leaves the process", async () => {
  { const w = world(); const r = await core(w, { cancelLost: true });
    assert.deepEqual([r.outcome, r.code, r.steps, r.cancelInvocations, r.cancelOutcome, r.refundInvocations, r.finalState, r.cancelOps, r.factsObserved], ["WRITE_OUTCOME_UNKNOWN", "LOST_CANCEL_REPLY", 1, 1, "UNKNOWN", 0, "test_cleanup_pending", ["outcome_unknown"], true], JSON.stringify(r));
    assert.deepEqual(posts(w), [CANCEL_URL]);
    const w2 = { ...w, calls: [], workerCalls: 0, requestCalls: 0 }; const r2 = await core(w2);                     // second session: the same persisted facts, read-only refusal
    assert.deepEqual([r2.outcome, r2.code, w2.calls.length, w2.requestCalls, w2.workerCalls, r2.cancelInvocations], ["START_STATE_NOT_ELIGIBLE", "STATE_NOT_PAYMENT_CAPTURED", 0, 0, 0, 0], JSON.stringify(r2)); }
  { const w = world(); const r = await core(w, { refundLost: true });
    assert.deepEqual([r.outcome, r.code, r.steps, r.cancelInvocations, r.refundInvocations, r.refundOutcome, r.finalState, r.refundOps], ["WRITE_OUTCOME_UNKNOWN", "LOST_REFUND_REPLY", 2, 1, 1, "UNKNOWN", "test_cleanup_pending", ["outcome_unknown"]], JSON.stringify(r));
    assert.deepEqual(posts(w), [CANCEL_URL, REFUND_URL]);
    const w2 = { ...w, calls: [], workerCalls: 0, requestCalls: 0 }; const r2 = await core(w2);
    assert.deepEqual([r2.outcome, w2.calls.length, w2.workerCalls, r2.refundInvocations], ["START_STATE_NOT_ELIGIBLE", 0, 0, 0]); }
  { const w = world(); const r = await core(w, { twice: true });
    assert.deepEqual(posts(w).filter((x) => x === CANCEL_URL), [CANCEL_URL], "the second cancel never left the process"); assert.ok(r.refusedAtTransport >= 1); assert.ok(r.actions.includes("SECOND_CANCEL_REFUSED")); }
  { const w = world(); const r = await core(w, { twiceRefund: true });
    assert.deepEqual(posts(w).filter((x) => x === REFUND_URL), [REFUND_URL], "the second refund never left the process"); assert.ok(r.actions.includes("SECOND_REFUND_REFUSED")); assert.equal(r.outcome, "TEST_CLEANUP_COMPLETED"); }
  { // a step that reports nothing after a cancel went out (row left pending): CANCEL_SENT_WITHOUT_SETTLEMENT, never a second step
    const w = world(); const r = await core(w, { worker: async (pool, { executors }) => { Object.assign(rowOf(w, CAN), { state: "pending" });
      await executors.cancelReservation({ method: "PUT", path: `/v1/reservations/${RID}/statuses/cancelled`, query: {}, body: { cancelledBy: "host" } }, { signal: AbortSignal.timeout(1000) });
      return { status: "worked", intentId: IID, actions: [], delayMs: 0, late: Promise.resolve([]) }; } });
    assert.deepEqual([r.outcome, r.code, r.steps, posts(w)], ["WRITE_OUTCOME_UNKNOWN", "CANCEL_SENT_WITHOUT_SETTLEMENT", 1, [CANCEL_URL]], JSON.stringify(r)); }
});

test("A6 target-only fence: wrong amount / key / metadata op, a foreign reservation read, a Hostaway POST, a Stripe capture / void / cancel op, a refund before the lineage binds the op id — none leaves the process", async () => {
  { const w = world(); const r = await core(w, { wrongAmount: AMT - 1 }); assert.equal(posts(w).includes(REFUND_URL), false); assert.notEqual(r.outcome, "TEST_CLEANUP_COMPLETED"); assert.equal(w.refundRequests ?? 0, 0); }
  { const w = world(); const r = await core(w, { wrongKey: "ref:other:1" }); assert.equal(posts(w).includes(REFUND_URL), false); assert.notEqual(r.outcome, "TEST_CLEANUP_COMPLETED"); }
  { const w = world(); const r = await core(w, { wrongMetaKey: `ref:${IID}:2` }); assert.equal(posts(w).includes(REFUND_URL), false); assert.notEqual(r.outcome, "TEST_CLEANUP_COMPLETED"); }
  { const w = world(); const r = await core(w, { wrongOp: "00000000-0000-4000-8000-00000000abcd" }); assert.equal(posts(w).includes(REFUND_URL), false); assert.notEqual(r.outcome, "TEST_CLEANUP_COMPLETED"); }
  { const w = world(); await core(w, { foreignRead: true }); assert.equal(w.calls.some((x) => x.includes(C.protectedReservationIds[0])), false); }
  { const w = world(); const r = await core(w, { worker: async (pool, { executors }) => {
      let refused = 0;
      for (const bad of [() => executors.retrieveReservation({ method: "POST", path: `/v1/reservations/${RID}`, query: {} }, { signal: AbortSignal.timeout(1000) }),
        () => executors.retrieveReservation({ method: "GET", path: "/v1/reservations/71999902", query: {} }, { signal: AbortSignal.timeout(1000) }),
        () => executors.cancelReservation({ method: "PUT", path: "/v1/reservations/71999902/statuses/cancelled", query: {}, body: { cancelledBy: "host" } }, { signal: AbortSignal.timeout(1000) }),
        () => executors.cancelReservation({ method: "PUT", path: `/v1/reservations/${RID}/statuses/cancelled`, query: {}, body: { cancelledBy: "guest" } }, { signal: AbortSignal.timeout(1000) }),
        () => executors.createRefund("pi_FAKEother00000001", { amount: AMT, metadata: { mv_refund_op: REFUND_OP, mv_refund_key: KEY } }, { idempotencyKey: KEY, signal: AbortSignal.timeout(1000) }),
        () => executors.retrieveRefund("ch_notARefund0001", { signal: AbortSignal.timeout(1000) }),
        () => executors.listRefunds(PI, { limit: 10 }, { signal: AbortSignal.timeout(1000) })]) { try { await bad(); } catch { refused += 1; } }
      assert.equal(refused, 7, "every out-of-scope call refused at the executor / fence");
      return { status: "worked", intentId: IID, actions: ["WAIT"], delayMs: 0, late: Promise.resolve([]) }; } });
    assert.deepEqual([posts(w).length, r.cancelInvocations, r.refundInvocations], [0, 0, 0]); }
  { // transport-level: capture / void / cancel ops through the runner's stripe send, a POST through the hostaway send: refused before any exchange (the isolated transport builds none of them anyway)
    const w = world(); const x = exchanges(w); let refused = 0;
    const r = await E.runTestCleanupCore({ ...coreArgs(w, x), tooling: { ...toolingFor(w), createTestCleanupExecutors: (o) => { const bx = EX.createTestCleanupExecutors(o); const send = o.stripe.send; const hs = o.hostaway.send;
      let injected = false;
      return { ok: true, executors: { ...bx.executors, retrieveAccount: async (opts) => {
        if (injected) return bx.executors.retrieveAccount(opts); injected = true;
        for (const c of [{ op: "paymentIntents.capture", id: PI, params: {}, idempotencyKey: "v" }, { op: "paymentIntents.cancel", id: PI, params: {}, idempotencyKey: "v" }, { op: "charges.create", params: {} }]) { try { await send(c, opts); } catch { refused += 1; } }
        for (const h of [{ method: "POST", path: "/v1/reservations", query: {}, body: {} }, { method: "DELETE", path: `/v1/reservations/${RID}`, query: {} }, { method: "PUT", path: `/v1/reservations/${RID}`, query: {}, body: { status: "new" } }]) { try { await hs(h, opts); } catch { refused += 1; } }
        return bx.executors.retrieveAccount(opts); } } }; } } });
    assert.equal(refused, 6); assert.deepEqual(posts(w), [CANCEL_URL, REFUND_URL]); assert.equal(r.outcome, "TEST_CLEANUP_COMPLETED", JSON.stringify(r)); }
  { // the runner's OWN wire gate, independent of the executor / transport layers: a transport that is tricked into a drifted body / key / URL is refused at the exchange boundary
    for (const [label, mutate] of [["refund amount", (req) => ({ ...req, body: req.body.replace(`amount=${AMT}`, `amount=${AMT - 1}`) })],
      ["refund key", (req) => ({ ...req, headers: { ...req.headers, "Idempotency-Key": `ref:${IID}:2` } })], ["refund metadata op", (req) => ({ ...req, body: req.body.replace(REFUND_OP, "00000000-0000-4000-8000-00000000abcd") })],
      ["refund url", (req) => ({ ...req, url: "https://api.stripe.com/v1/refunds/re_x" })]]) {
      const w = world(); const r = await core(w, { worker: undefined, request: undefined,
        wrapExchanges: (x) => x, pool: undefined, toolingOver: { createStripeSend: (o) => TT.createE7StripeTestCleanupSend({ ...o, exchange: (req) => o.exchange(req.method === "POST" ? mutate(req) : req) }) } });
      assert.deepEqual([w.refundRequests ?? 0, r.refundInvocations, r.refundOutcome, r.outcome], [0, 1, "NOT_SENT", "WRITE_OUTCOME_UNKNOWN"], `${label}: ${JSON.stringify(r)}`);   // counted BEFORE, refused AT the wire, never exchanged
      assert.ok(r.refusedAtTransport >= 1 && r.actions.includes("REFUND_OUTCOME_UNKNOWN"), label);
    }
    for (const [label, mutate] of [["cancel body", (req) => ({ ...req, body: JSON.stringify({ cancelledBy: "guest" }) })], ["cancel url", (req) => ({ ...req, url: `https://api.hostaway.com/v1/reservations/71999902/statuses/cancelled` })],
      ["cancel header", (req) => ({ ...req, headers: { ...req.headers, "X-Extra": "1" } })]]) {
      const w = world(); const r = await core(w, { toolingOver: { createHostawaySend: (o) => T.createE7HostawaySend({ ...o, exchange: (req) => o.exchange(req.method === "PUT" ? mutate(req) : req) }) } });
      assert.deepEqual([w.cancelRequests ?? 0, r.cancelInvocations, r.cancelOutcome, w.refundRequests ?? 0], [0, 1, "NOT_SENT", 0], `${label}: ${JSON.stringify(r)}`);
      assert.ok(r.refusedAtTransport >= 1, label);
    }
  }
  function coreArgs(w, x) { const b = built(); return { plan: b.plan, planHash: b.planHash, pool: fakePool(w), lockClientFactory: () => fakePool(w).lock(), exchanges: x, credentials: { stripe: () => "sk_test_Fake1", hostaway: () => "x" }, sleep: async () => {},
    clock: () => Date.UTC(2026, 10, 12, 16, 0, 0) + (w.tick = (w.tick ?? 0) + 1000) }; }
});

test("A7 stop latch: aborted before start → no lock, no provider call, no request; aborted as the worker's PI read resolves → no cancel, STOP_ABORTED; abort / deadline exactly as the per-step lock proof resolves → ZERO steps; deadline between steps → DEADLINE; a worker that only waits → STEP_BUDGET_EXHAUSTED at 16 with ZERO writes", async () => {
  { const w = world(); const ac = new AbortController(); ac.abort(); const r = await core(w, { signal: ac.signal });
    assert.deepEqual([r.outcome, r.code, w.calls.length, w.requestCalls, r.lock], ["ABORTED", "STOP_ABORTED", 0, 0, "not_acquired"]); }
  { const w = world(); const ac = new AbortController();
    const r = await core(w, { signal: ac.signal, wrapExchanges: (x) => ({ hostaway: x.hostaway, stripe: (req) => { if (w.workerCalls > 0 && req.method === "GET" && /payment_intents/.test(req.url)) ac.abort(); return x.stripe(req); } }) });
    assert.deepEqual([r.outcome, r.stopReason, r.cancelInvocations, posts(w).length, r.finalState], ["ABORTED", "ABORTED", 0, 0, "test_cleanup_pending"], JSON.stringify(r)); }
  { const w = world(); const ac = new AbortController(); const r = await core(w, { signal: ac.signal, onProofResolve: (n) => { if (n === 3) ac.abort(); } });
    assert.deepEqual([r.outcome, r.steps, w.workerCalls, r.requestInvocations, posts(w).length], ["ABORTED", 0, 0, 1, 0], JSON.stringify(r)); }
  { const w = world(); let late = false; const r = await core(w, { monotonic: () => (late ? 10 ** 9 : 0), onProofResolve: (n) => { if (n === 3) late = true; } });
    assert.deepEqual([r.outcome, r.steps, w.workerCalls, posts(w).length], ["DEADLINE", 0, 0, 0], JSON.stringify(r)); }
  { const w = world(); let m = 0; const r = await core(w, { wait: true, delayMs: 30000, monotonic: () => { m += 1; return m > 14 ? 10 ** 9 : 0; } });
    assert.equal(r.outcome, "DEADLINE", JSON.stringify(r)); assert.equal(posts(w).length, 0); }
  { const w = world(); const r = await core(w, { wait: true }); assert.deepEqual([r.outcome, r.code, r.steps, posts(w).length, r.requestInvocations], ["STEP_BUDGET_EXHAUSTED", "STEPS", C.budgets.steps, 0, 1]); }
  { const w = world(); const ac = new AbortController(); const r = await core(w, { signal: ac.signal, wrapExchanges: (x) => ({ hostaway: x.hostaway, stripe: (req) => { if (req.method === "POST") ac.abort(); return x.stripe(req); } }) });
    assert.notEqual(r.outcome, "TEST_CLEANUP_COMPLETED"); assert.equal(r.refundInvocations, 1); assert.deepEqual(posts(w), [CANCEL_URL, REFUND_URL], "a stop after the ONE send never resends"); }
});

test("A8 DB failure during the start read → DB_ERROR, nothing sent, no lock, no request", async () => {
  const w = world(); const r = await core(w, { dbFailAt: 2 });
  assert.deepEqual([r.outcome, r.code, w.calls.length, w.requestCalls, r.lock], ["DB_ERROR", "START_READ_FAILED", 0, 0, "not_acquired"]);
});

test("A9 the ONE request: refused → REQUEST_REFUSED with the accepted code, ZERO worker, ZERO writes; a throw → REQUEST_OUTCOME_UNKNOWN / REQUEST_THREW, facts observed, NEVER repeated, ZERO worker; a lineage that is not exactly ONE pristine cancel + ONE bound refund → LINEAGE_MISMATCH, ZERO worker", async () => {
  { const w = world(); const r = await core(w, { requestRefuse: "TEST_CLEANUP_STALE" });
    assert.deepEqual([r.outcome, r.code, r.requestInvocations, w.requestCalls, w.workerCalls, posts(w).length, r.lock], ["REQUEST_REFUSED", "TEST_CLEANUP_STALE", 1, 1, 0, 0, "released"], JSON.stringify(r)); }
  for (const applied of [false, true]) {
    const w = world(); const r = await core(w, { requestThrow: true, requestAppliedAnyway: applied });
    assert.deepEqual([r.outcome, r.code, r.requestInvocations, r.requestOutcome, w.requestCalls, w.workerCalls, posts(w).length, r.factsObserved, r.finalState],
      ["REQUEST_OUTCOME_UNKNOWN", "REQUEST_THREW", 1, "UNKNOWN", 1, 0, 0, true, applied ? "test_cleanup_pending" : "payment_captured"], JSON.stringify(r));
  }
  for (const [o, code] of [[{ extraOp: true }, "FORBIDDEN_OP_PRESENT"], [{ refundKey: `ref:${IID}:2` }, "REFUND_ROW_NOT_BOUND"], [{ refundOpId: "not-a-uuid" }, "REFUND_ROW_NOT_BOUND"]]) {
    const w = world(); const r = await core(w, o);
    assert.deepEqual([r.outcome, r.code, w.workerCalls, posts(w).length], ["LINEAGE_MISMATCH", code, 0, 0], JSON.stringify(r));
  }
  { const w = world(); const r = await core(w, { request: async () => { w.status = "test_cleanup_pending"; w.version += 1; return { ok: true }; } });   // the state moved but nothing else: refused before the worker
    assert.deepEqual([r.outcome, w.workerCalls], ["LINEAGE_MISMATCH", 0]); }
});

test("A10 postcheck + readbacks + residual agreement: a worker that claims cancelled with a non-succeeded refund row / a held claim → POSTCHECK_MISMATCH; a refund readback that disagrees → POSTCHECK_MISMATCH / REFUND_READBACK; a contradiction seen ONLY by the teardown residual read → NOT_CONFIRMED / RESIDUAL_<code>; unlock false → NOT_CONFIRMED / UNLOCK_NOT_PROVEN; escalation → CLEANUP_ESCALATED", async () => {
  { const w = world(); const r = await core(w, { refundRowStateAfter: "pending" }); assert.deepEqual([r.outcome, r.code], ["POSTCHECK_MISMATCH", "REFUND_OP_NOT_SINGLE_SUCCEEDED"], JSON.stringify(r)); }
  { const w = world(); const r = await core(w, { keepClaim: true }); assert.deepEqual([r.outcome, r.code], ["POSTCHECK_MISMATCH", "CLAIM_NOT_RELEASED"]); }
  { const w = world(); const r = await core(w, { refundGetOver: { amount: AMT - 1 } }); assert.notEqual(r.outcome, "TEST_CLEANUP_COMPLETED"); assert.ok(["REFUND_READBACK", "READBACK_FAILED"].includes(r.code) || r.outcome !== "TEST_CLEANUP_COMPLETED", JSON.stringify(r)); }
  { const w = world(); const r = await core(w, { wrapExchanges: (x) => ({ stripe: x.stripe, hostaway: (req) => (w.status === "cancelled" && req.method === "GET" ? Promise.resolve({ status: 200, contentType: "application/json", bytes: enc({ status: "success", result: { ...resObj(w), status: "new" } }) }) : x.hostaway(req)) }) });
    assert.deepEqual([r.outcome, r.code], ["POSTCHECK_MISMATCH", "RESERVATION_NOT_CANCELLED_AT_PROVIDER"], JSON.stringify(r)); }
  const residual = async (mutate) => {
    const w = world(); const pool = fakePool(w); const q = pool.query.bind(pool); let n = 0;
    pool.query = async (sql, params) => { if (/e7htc:instance/.test(sql) && w.status === "cancelled" && ++n === 2) mutate(w); if (w.residualThrow) throw new Error("SYNTHETIC"); return q(sql, params); };
    const r = await core(w, { pool }); assert.equal(n, 2, "the residual read happened"); return r;
  };
  { const r = await residual((w) => { w.claimReleased = false; }); assert.deepEqual([r.outcome, r.code, r.postcheck, r.finalState, r.refundId, r.lock], ["NOT_CONFIRMED", "RESIDUAL_CLAIM_NOT_RELEASED", null, "cancelled", RE, "released"], JSON.stringify(r)); }
  { const r = await residual((w) => { w.refunds[0].state = "requested"; }); assert.deepEqual([r.outcome, r.code], ["NOT_CONFIRMED", "RESIDUAL_REFUND_RECORD_NOT_SUCCEEDED"]); }
  { const r = await residual((w) => { w.status = "test_cleanup_pending"; }); assert.deepEqual([r.outcome, r.code, r.finalState, r.factsObserved], ["NOT_CONFIRMED", "RESIDUAL_STATE_NOT_CANCELLED", "test_cleanup_pending", true]); }
  { const r = await residual((w) => { w.residualThrow = true; }); assert.deepEqual([r.outcome, r.code, r.postcheck], ["NOT_CONFIRMED", "RESIDUAL_READ_UNAVAILABLE", null]); }
  { const w = world(); const r = await core(w, { unlockFalse: true });
    assert.deepEqual([r.outcome, r.code, r.lock, w.lockReleased, r.finalState, r.refundId], ["NOT_CONFIRMED", "UNLOCK_NOT_PROVEN", "unlock_failed_connection_destroyed", "destroyed", "cancelled", RE], JSON.stringify(r)); }
  { const w = world(); const r = await core(w, { escalateAfterCancel: true });
    assert.deepEqual([r.outcome, r.code, r.steps, r.cancelInvocations, r.refundInvocations, r.finalState], ["CLEANUP_ESCALATED", "OWNER_CASE", 1, 1, 0, "reconciliation_required"], JSON.stringify(r)); }
});

test("C1 code ceiling: Slice 3 cleanup execution OPEN (executeEnabled true) AND the Slice 1 / Slice 2 runners OPEN on THEIR tooling 40779e34 — ONE reviewed owner-present hosted TEST; this runner pins the MERGED e7-test 9d86bfa1; the plan pins pi / reservation / charge / captured amount / stay / attempt / session and the accepted refund key; ZERO capture / void / record / notify / create; the derived expectation is EXACTLY the accepted 17 keys", () => {
  assert.equal(C.executeEnabled, true); assert.equal(RESRUN.CONSTANTS.executeEnabled, true); assert.equal(CAPRUN.CONSTANTS.executeEnabled, true);
  assert.equal(C.toolingCommit, "9d86bfa1e60779b3794de88bbae151670e8fe515"); assert.equal(C.toolingStatus, "MERGED");
  assert.equal(CAPRUN.CONSTANTS.toolingCommit, "40779e34e8c65ac5c4494bc5a18cd4223ef723fa", "the reviewed Slice 1 / 2 pins are untouched");
  const { plan, planHash } = built();
  assert.deepEqual(plan.writes, { requestMax: 1, cancelMax: 1, refundMax: 1, capture: 0, hostawayCreate: 0, record: 0, notify: 0, void: 0, account: 0, keys: 0 });
  assert.equal(plan.refundIdempotencyKey, IS.refundKey(IID, 1)); assert.deepEqual([plan.paymentIntentId, plan.reservationId, plan.chargeId, plan.capturedMinor, plan.from, plan.to, plan.guests, plan.attemptId, plan.sessionId], [PI, RID, CH, AMT, FROM, TO, 1, ATTEMPT, CS]);
  const ex = E.operatorExpectation(plan, planHash);
  assert.deepEqual(Object.keys(ex).sort(), [...EXPECTATION_KEYS]); if (TC) assert.deepEqual(TC.bindCleanupExpectation(ex), ex); assert.equal(ex.planHash, planHash);
  assert.deepEqual([ex.authorizedMinor, ex.finalTotalMinor, ex.capturedMinor, ex.listingId, ex.currency], [AMT, AMT, AMT, 606998, "USD"]);
  for (const bad of [{ reservationId: "" }, { reservationId: C.protectedReservationIds[0] }, { paymentIntentId: "ch_x" }, { paymentIntentId: "pi_short" }, { chargeId: "pi_FAKEhostedTc0001" }, { capturedMinor: 0 }, { capturedMinor: 1.5 },
    { notBefore: "2026-11-12" }, { notBefore: "2026-11-12T00:00:00+02:00" }, { expectedVersion: 0 }, { intentId: "not-a-uuid" }, { from: "2026-11-26" }, { to: "2026-02-30" }, { guests: 0 }, { guests: 51 },
    { attemptId: "x" }, { sessionId: "cs_live_FAKEhostedTc0001" }, { sessionId: "cs_test_bad-chars!" }, { approvalRef: "" }]) assert.throws(() => E.buildPlan(C, planInput(bad)), /e7-hosted-test-cleanup/, JSON.stringify(bad));
  const ph = (over) => built(over).planHash;
  for (const over of [{ capturedMinor: AMT + 1 }, { paymentIntentId: "pi_FAKEother00000001" }, { expectedVersion: VER + 1 }, { chargeId: "ch_FAKEother00000001" }, { reservationId: "71999902" }, { from: "2026-11-24" }, { attemptId: "aaaaaaaa-bbbb-4ccc-8ddd-000000000000" }, { sessionId: "cs_test_FAKEother0001" }])
    assert.notEqual(ph({}), ph(over), JSON.stringify(over));
  assert.deepEqual([C.budgets.steps, C.budgets.cancel, C.budgets.refund, C.budgets.runMs], [16, 1, 1, 15 * 60 * 1000]);
  assert.ok(!C.closure.includes("scripts/e7-connected/executor-adapters.mjs"), "the refund-free accepted executor phases are NOT part of this runner");
});

test("C2 closure: the INDEPENDENTLY scanned transitive relative imports of the runner's tooling roots == CONSTANTS.closure (= Slice 1 closure − executor-adapters − offline-charge-proof + the cleanup worker / request / proof / isolated executors + transports); framed digest == the pin; no R1 / reconcile / stager / recording / notification / compensation-worker / test-abort / capture-worker file", async () => {
  const roots = ["lib/booking-db/cleanup-worker.js", "lib/booking-db/test-cleanup.js", "lib/booking-db/repo.js", "scripts/e7-connected/test-cleanup-executors.mjs", "scripts/e7-connected/test-cleanup-transports.mjs",
    "scripts/e7-connected/http-transports.mjs", "scripts/e7-connected/real-exchange.mjs", "lib/booking-db/pool.js", "lib/hostaway-reservations.js", "lib/checkout/capture-proof.js", "lib/checkout/recovery-plan.js",
    "lib/checkout/test-cleanup-proof.js", "lib/checkout/compensation-proof.js", "lib/checkout/intent-state.js", "scripts/e7-connected/run-lock-precheck.mjs", "scripts/e7-connected/probe-env-preflight.mjs"];
  const src = readFileSync(join(ROOT, "scripts/e7-hosted-test-cleanup.mjs"), "utf8");
  for (const f of roots) assert.ok(src.includes(f), `runner imports ${f}`);
  const seen = new Set(); const st = [...roots];
  while (st.length) { const f = st.pop(); if (seen.has(f)) continue; seen.add(f);
    for (const m of readFileSync(join(TOOLING, f), "utf8").matchAll(/(?:import|export)\s[^"'`;]*?from\s*["'](\.[^"']+)["']|import\(\s*["'](\.[^"']+)["']\s*\)/g)) st.push(normalize(join(dirname(f), m[1] || m[2]))); }
  assert.deepEqual([...C.closure], ["package.json", "package-lock.json", ...[...seen].sort()].sort());
  const expected = new Set([...RESRUN.CONSTANTS.closure, "lib/booking-db/cleanup-worker.js", "lib/booking-db/test-cleanup.js", "lib/checkout/test-cleanup-proof.js", "scripts/e7-connected/test-cleanup-executors.mjs", "scripts/e7-connected/test-cleanup-transports.mjs"]);
  expected.delete("scripts/e7-connected/executor-adapters.mjs"); expected.delete("lib/checkout/offline-charge-proof.js");
  assert.deepEqual([...C.closure], [...expected].sort());
  assert.equal(await RESRUN.framedDigest(TOOLING, C.closure, E.CLOSURE_DIGEST_PREFIX), C.closureDigest);
  for (const f of C.closure) assert.doesNotMatch(f, /run-core|run-plan|run-r1|reconcile|stage-run|recording-worker|notification-worker|compensation-worker|test-abort|capture-worker|executor-adapters/);
});

// ---------------------------------------------------------------------------------------------------------------------------------
const PROC = { versions: { node: C.nodeVersion }, platform: "linux", execArgv: [], getuid: () => 1000, once() {}, off() {} };
const okChild = async () => ({ status: 0, signal: null, stdout: "# tests 3\n# pass 3\n# fail 0\n", truncated: false, spawnFailed: false });
const realEnv = (over = {}) => ({ E7_TOOLING_DIR: TOOLING, E7_APPROVAL_REF: "label-1", E7_INTENT_ID: IID, E7_EXPECTED_VERSION: String(VER), E7_NOT_BEFORE: NB, E7_PAYMENT_INTENT_ID: PI, E7_RESERVATION_ID: RID,
  E7_CHARGE_ID: CH, E7_CAPTURED_MINOR: String(AMT), E7_STAY_FROM: FROM, E7_STAY_TO: TO, E7_GUESTS: "1", E7_ATTEMPT_ID: ATTEMPT, E7_SESSION_ID: CS, ...over });

test("H1 hosted: preflight (no secrets) passes on the pinned closure; any secret outside execute is refused; partial / invalid inputs refused; the runner digest covers the imported Slice 1 runner", async () => {
  let x = await E.runHosted({ mode: "preflight", env: { E7_TOOLING_DIR: TOOLING }, proc: PROC, wrapperDir: ROOT, deps: { spawnChild: okChild } });
  assert.deepEqual([x.exitCode, x.result.code, x.result.planKind, x.result.closureDigest, x.result.executeEnabled, x.result.schema], [0, "PREFLIGHT_OK_SYNTHETIC_ONLY", "SYNTHETIC", C.closureDigest, true, "e7-hosted-test-cleanup-hosted-v1"], JSON.stringify(x.result));
  assert.equal(x.result.runnerDigest, await RESRUN.framedDigest(ROOT, C.runnerFiles, E.RUNNER_DIGEST_PREFIX)); assert.ok(C.runnerFiles.includes("scripts/e7-hosted-reservation.mjs"));
  x = await E.runHosted({ mode: "preflight", env: realEnv(), proc: PROC, wrapperDir: ROOT, deps: { spawnChild: okChild } });
  assert.deepEqual([x.exitCode, x.result.code, x.result.planKind], [0, "PREFLIGHT_OK_REAL_PLAN", "REAL"], JSON.stringify(x.result));
  assert.equal(x.result.planHash, E.buildPlan(C, planInput({ approvalRef: "label-1", runnerDigest: x.result.runnerDigest })).planHash);
  for (const [env, code] of [[{ E7_TOOLING_DIR: TOOLING, E7_STRIPE_TEST_KEY: "sk_test_x" }, "HTC_SECRET_SCOPE_VIOLATION"], [{ E7_TOOLING_DIR: TOOLING, E7_DEV_BOOKING_DATABASE_URL: "postgresql://x" }, "HTC_SECRET_SCOPE_VIOLATION"],
    [realEnv({ E7_CAPTURED_MINOR: "" }), "HTC_INPUT_INCOMPLETE"], [realEnv({ E7_SESSION_ID: "" }), "HTC_INPUT_INCOMPLETE"],
    [realEnv({ E7_INTENT_ID: "bad" }), "HTC_INPUT_INVALID"], [realEnv({ E7_PAYMENT_INTENT_ID: "ch_x" }), "HTC_INPUT_INVALID"], [realEnv({ E7_RESERVATION_ID: C.protectedReservationIds[0] }), "HTC_INPUT_INVALID"],
    [realEnv({ E7_CAPTURED_MINOR: "0" }), "HTC_INPUT_INVALID"], [realEnv({ E7_NOT_BEFORE: "yesterday" }), "HTC_INPUT_INVALID"], [realEnv({ E7_APPROVAL_REF: C.synthetic.approvalRef }), "HTC_INPUT_INVALID"],
    [realEnv({ E7_CHARGE_ID: "re_x" }), "HTC_INPUT_INVALID"], [realEnv({ E7_STAY_FROM: "2026-11-26" }), "HTC_INPUT_INVALID"], [realEnv({ E7_GUESTS: "0" }), "HTC_INPUT_INVALID"], [realEnv({ E7_SESSION_ID: "cs_live_FAKEhostedTc0001" }), "HTC_INPUT_INVALID"]]) {
    const y = await E.runHosted({ mode: "preflight", env, proc: PROC, wrapperDir: ROOT, deps: { spawnChild: okChild } });
    assert.deepEqual([y.exitCode, y.result.code], [1, code], code);
  }
  const bad = await E.runHosted({ mode: "preflight", env: { E7_TOOLING_DIR: TOOLING }, proc: PROC, wrapperDir: ROOT, deps: { spawnChild: async () => ({ status: 1, signal: null, stdout: "# tests 3\n# pass 2\n# fail 1\n", truncated: false, spawnFailed: false }) } });
  assert.equal(bad.result.code, "HTC_TESTS_FAILED");
});

test("H2 hosted: verify / execute refuse HTC_EXECUTE_CLOSED under a test-local executeEnabled=false config before any pin, ref or import check (the shipped constant is OPEN for the ONE reviewed owner-present TEST); an opened constants seam still refuses off main / wrong digests / secrets missing / wrong DB target, wipes secrets, and wires TWO pools (6543 max 3 worker, 5432 max 1 lock)", async () => {
  const CLOSED = { ...C, executeEnabled: false };   // test-local CLOSED control: the refusal path stays exercised while the shipped constant is OPEN
  const x = await E.runHosted({ mode: "verify", env: { ...realEnv(), E7_EXPECTED_PLAN_HASH: "0".repeat(64), E7_EXPECTED_CLOSURE_DIGEST: C.closureDigest, E7_EXPECTED_RUNNER_DIGEST: "0".repeat(64), GITHUB_REF: "refs/heads/main" }, proc: PROC, wrapperDir: ROOT, deps: { constants: CLOSED } });
  assert.deepEqual([x.exitCode, x.result.code, x.result.closureDigest], [1, "HTC_EXECUTE_CLOSED", null]);
  const y = await E.runHosted({ mode: "execute", env: { ...realEnv(), E7_STRIPE_TEST_KEY: "sk_test_x", E7_HOSTAWAY_TOKEN: "t", E7_DEV_BOOKING_DATABASE_URL: "postgresql://x" }, proc: PROC, wrapperDir: ROOT, deps: { constants: CLOSED, importTooling: async () => { throw new Error("never"); } } });
  assert.deepEqual([y.exitCode, y.result.code], [1, "HTC_EXECUTE_CLOSED"]);
  const opened = { ...C, executeEnabled: true };
  const pf = await E.runHosted({ mode: "preflight", env: realEnv(), proc: PROC, wrapperDir: ROOT, deps: { spawnChild: okChild } });
  const d = pf.result;
  const base = { ...realEnv(), E7_EXPECTED_PLAN_HASH: d.planHash, E7_EXPECTED_CLOSURE_DIGEST: d.closureDigest, E7_EXPECTED_RUNNER_DIGEST: d.runnerDigest, GITHUB_REF: "refs/heads/main" };
  let v = await E.runHosted({ mode: "verify", env: { ...base }, proc: PROC, wrapperDir: ROOT, deps: { constants: opened } });
  assert.deepEqual([v.exitCode, v.result.code], [0, "VERIFY_OK"], JSON.stringify(v.result));
  for (const [env, code] of [[{ ...base, GITHUB_REF: "refs/heads/feature" }, "HTC_REF_NOT_MAIN"], [{ ...base, E7_EXPECTED_CLOSURE_DIGEST: "1".repeat(64) }, "HTC_SOURCE_MISMATCH"],
    [{ ...base, E7_EXPECTED_RUNNER_DIGEST: "1".repeat(64) }, "HTC_RUNNER_MISMATCH"], [{ ...base, E7_EXPECTED_PLAN_HASH: "1".repeat(64) }, "HTC_PLAN_HASH_MISMATCH"], [{ ...base, E7_EXPECTED_PLAN_HASH: "" }, "HTC_INPUT_INCOMPLETE"]]) {
    v = await E.runHosted({ mode: "verify", env, proc: PROC, wrapperDir: ROOT, deps: { constants: opened } }); assert.deepEqual([v.exitCode, v.result.code], [1, code], code);
  }
  v = await E.runHosted({ mode: "execute", env: { ...base }, proc: PROC, wrapperDir: ROOT, deps: { constants: opened, importTooling: async () => { throw new Error("never"); } } });
  assert.deepEqual([v.exitCode, v.result.code], [1, "HTC_CREDENTIALS_MISSING"]);
  const envBad = { ...base, E7_STRIPE_TEST_KEY: "sk_test_x", E7_HOSTAWAY_TOKEN: "t", E7_DEV_BOOKING_DATABASE_URL: "postgresql://u@h:1/x" };
  v = await E.runHosted({ mode: "execute", env: envBad, proc: PROC, wrapperDir: ROOT, deps: { constants: opened, readPgVersion: async () => C.pgVersion } });
  assert.deepEqual([v.exitCode, v.result.code, "E7_STRIPE_TEST_KEY" in envBad, "E7_DEV_BOOKING_DATABASE_URL" in envBad], [1, "HTC_DB_TARGET_INVALID", false, false], "secrets wiped from the env object");
  assert.equal(JSON.stringify(v.result).includes("sk_test_x"), false);
  const good = `postgresql://mv_booking_app_dev.${C.dbProjectRef}:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres`;
  const pools = []; let coreArgs = null;
  const fakeTooling = async () => ({ X: { createE7RealExchange: () => ({ ok: true, exchange: async () => ({}) }) },
    createBookingPool: (o) => { const u = new URL(o.connectionString); pools.push({ port: u.port, max: o.max, ended: false }); const me = pools.at(-1); return { connect: async () => ({ query: async () => ({ rows: [] }), release() {}, on() {} }), query: async () => ({ rows: [] }), end: async () => { me.ended = true; } }; },
    tooling: {} });
  const z = await E.runHosted({ mode: "execute", env: { ...base, E7_STRIPE_TEST_KEY: "sk_test_x", E7_HOSTAWAY_TOKEN: "t", E7_DEV_BOOKING_DATABASE_URL: good, E7_CA_FILE: "ca" }, proc: PROC, wrapperDir: ROOT,
    deps: { constants: opened, readPgVersion: async () => C.pgVersion, readCa: async () => Buffer.from("CA"), caSha256: (await import("node:crypto")).createHash("sha256").update("CA").digest("hex"), importTooling: fakeTooling,
      runCore: async (a) => { coreArgs = a; return { outcome: "SCOPE_REFUSED", code: "FAKE" }; } } });
  assert.deepEqual([z.exitCode, z.result.code, z.result.lockEndpoint, pools.map((p) => [p.port, p.max, p.ended])], [1, "EXECUTE_DONE", "session:5432", [["6543", 3, true], ["5432", 1, true]]], JSON.stringify(z.result));
  assert.equal(typeof coreArgs.lockClientFactory, "function"); assert.deepEqual([coreArgs.plan.paymentIntentId, coreArgs.plan.capturedMinor, coreArgs.plan.chargeId, coreArgs.planHash], [PI, AMT, CH, d.planHash]);
  assert.equal(JSON.stringify(z.result).includes("sk_test_x"), false);
});

test("H3 hosted: a drifted tooling byte (in the cleanup worker) is refused before any import (closure digest)", async () => {
  const d = mkdtempSync(join(tmpdir(), "e7-htc-drift-"));
  try {
    for (const f of C.closure) { mkdirSync(dirname(join(d, f)), { recursive: true }); cpSync(join(TOOLING, f), join(d, f)); }
    writeFileSync(join(d, "lib/booking-db/cleanup-worker.js"), `${readFileSync(join(TOOLING, "lib/booking-db/cleanup-worker.js"), "utf8")}\n// drift\n`);
    const x = await E.runHosted({ mode: "preflight", env: { E7_TOOLING_DIR: d }, proc: PROC, wrapperDir: ROOT, deps: { spawnChild: okChild, importEnv: async () => C1 } });
    assert.deepEqual([x.exitCode, x.result.code], [1, "HTC_SOURCE_MISMATCH"]);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("S1 static: the runner imports node built-ins and ONLY the reviewed Slice 1 runner; no capture / void / create / record / notify call text; executor-adapters never imported; inert import", () => {
  const src = readFileSync(join(ROOT, "scripts/e7-hosted-test-cleanup.mjs"), "utf8");
  for (const m of src.matchAll(/^import .* from "([^"]+)";$/gm)) assert.ok(m[1].startsWith("node:") || m[1] === "./e7-hosted-reservation.mjs", m[1]);
  for (const bad of ["capturePaymentIntent(", "paymentIntents.capture", "cancelPaymentIntent(", "paymentIntents.cancel", "createOfflineCharge(", "sendMessage(", "createReservation(", "executor-adapters.mjs\"", "createPhaseExecutors", "guestPayments"]) assert.equal(src.includes(bad), false, bad);
  assert.equal(process.listenerCount("SIGINT"), 0);
  const yml = readFileSync(join(ROOT, ".github/workflows/e7-hosted-test-cleanup.yml"), "utf8");
  assert.ok(yml.includes("ref: 9d86bfa1e60779b3794de88bbae151670e8fe515") && !yml.includes("40779e34"), "the workflow checks out the pinned tooling commit");
  assert.ok(yml.includes("environment: e7-readonly-probe") && yml.includes("permissions:\n  contents: read") && yml.includes("github.ref == 'refs/heads/main'"));
  assert.equal((yml.match(/secrets\./g) || []).length, 3, "secrets appear in the execute step only");
  for (const k of Object.values(E.INPUT_ENV)) assert.equal((yml.match(new RegExp(`${k}:`, "g")) || []).length, 3, k);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// OPT-IN INTEGRATION (E7_HTC_DB_TESTS=1; tooling with its pinned pg; PG_BIN): the REAL merged requestTestCleanup + runTestCleanupStep, repo, operations,
// 0019 + 0020, the isolated transports / executors on a disposable PostgreSQL (tooling test/db/harness.mjs). FAKE exchanges ONLY (mock replies are not
// provider proof); fixtures through the accepted APIs. The hosted preflight child never sets E7_HTC_DB_TESTS.
if (process.env.E7_HTC_DB_TESTS === "1") {
  const [{ startMigratedDatabase }, F, R, O, W, TCR, pgMod] = await Promise.all([tool("test/db/harness.mjs"), tool("test/db/fixtures.mjs"), tool("lib/booking-db/repo.js"),
    tool("lib/booking-db/operations.js"), tool("lib/booking-db/cleanup-worker.js"), tool("lib/booking-db/test-cleanup.js"), import(pathToFileURL(join(TOOLING, "node_modules/pg/lib/index.js")).href)]);
  const pg = pgMod.default ?? pgMod;
  const db = await startMigratedDatabase();
  after(async () => { await db.close(); });
  const LIST = 606998; const MINUTE = 60000; const PG_AMT = 576000;
  let stayK = 0;
  const realTooling = { ...toolingFor(world()), runTestCleanupStep: W.runTestCleanupStep, requestTestCleanup: TCR.requestTestCleanup, loadIntent: R.loadIntent };
  /** a CAPTURED TEST payment on 606998 / USD through the accepted fixtures (= the PR68 worker test's `cleanupPending` without the request) */
  async function capturedIntent() {
    stayK += 1;
    const stay = { listingId: LIST, currency: "USD", from: F.addDays("2027-06-01", 3 * stayK), to: F.addDays("2027-06-01", 3 * stayK + 2) };
    const rr = await F.reserved(db.app, stay);
    const chargeId = `ch_test_${rr.id.replace(/-/g, "").slice(0, 16)}`;
    const cop = await F.claimOp(db.app, rr.id, CAP, F.at(8));
    F.ok(await O.completeOperation(db.app, cop.id, { workerId: "w1", now: F.at(8), outcome: { status: "succeeded", resultRef: chargeId } }), "capture op");
    F.ok(await R.applyEvent(db.app, rr.id, { type: "CAPTURE_SUCCEEDED", id: `evt_cap_${rr.piId}`, amountMinor: PG_AMT, currency: "usd" }, { now: F.at(8), actor: "webhook" }), "capture");
    const i = await R.loadIntent(db.app, rr.id);
    assert.equal(i.status, "payment_captured");
    const pa = (await db.app.query("SELECT id::text AS id FROM booking.payment_attempts WHERE intent_id = $1 AND status = 'completed'", [rr.id])).rows[0].id;
    return { id: rr.id, piId: rr.piId, attemptId: pa, sessionId: rr.sessionId, chargeId, stay, ref: i.ref, intent: i, total: i.price.finalTotalMinor, rid: String(rr.reservationId) };
  }
  function pgWorld(a, clk, o = {}) {
    const w = { calls: [], refunded: 0, resStatus: "new", echoRef: o.echoRef ?? true, cancelRequests: 0, refundRequests: 0, refundId: `re_test_${a.id.replace(/-/g, "").slice(0, 16)}`, refundOpId: null, refundCreated: null };
    const reply = (status, x) => Promise.resolve({ status, contentType: "application/json", bytes: enc(x) });
    const pi = () => ({ object: "payment_intent", id: a.piId, livemode: false, status: "succeeded", capture_method: "manual", amount: a.total, amount_received: a.total, amount_capturable: 0, currency: "usd",
      metadata: { mv_intent_id: a.id, mv_payment_attempt_id: a.attemptId },
      latest_charge: { object: "charge", id: a.chargeId, payment_intent: a.piId, status: "succeeded", paid: true, captured: true, amount: a.total, amount_captured: a.total, amount_refunded: w.refunded,
        refunded: w.refunded >= a.total, disputed: false, currency: "usd", livemode: false, payment_method_details: { card: { capture_before: a.intent.payment.captureBefore / 1000 } } } });
    const refund = () => ({ object: "refund", id: w.refundId, payment_intent: a.piId, charge: a.chargeId, amount: a.total, currency: "usd", status: "succeeded", created: w.refundCreated, reason: null, failure_reason: null,
      metadata: { mv_refund_op: w.refundOpId, mv_refund_key: `ref:${a.id}:1` } });
    const full = (echo = w.echoRef) => ({ id: Number(a.rid), listingMapId: LIST, channelId: 2000, arrivalDate: a.stay.from, departureDate: a.stay.to, totalPrice: a.total / 100, currency: "USD", status: w.resStatus,
      customFieldValues: echo ? [{ customFieldId: C.refFieldId, value: a.ref }] : [] });
    w.stripe = (req) => {
      const p = req.url.replace("https://api.stripe.com", ""); w.calls.push(`S ${req.method} ${p}`);
      if (p === "/v1/account") return reply(200, { object: "account", id: ACCT });
      if (req.method === "POST") {
        assert.equal(p, "/v1/refunds"); assert.equal(req.headers["Idempotency-Key"], `ref:${a.id}:1`);
        const m = /^payment_intent=([^&]+)&amount=(\d+)&metadata%5Bmv_refund_op%5D=([^&]+)&metadata%5Bmv_refund_key%5D=([^&]+)$/.exec(req.body);
        assert.ok(m, req.body); assert.deepEqual([m[1], Number(m[2]), decodeURIComponent(m[4])], [a.piId, a.total, `ref:${a.id}:1`]);
        w.refundOpId = m[3]; w.refundRequests += 1; w.refundCreated = Math.floor(clk.t / 1000);
        if (o.refundLost) return Promise.reject(new Error("socket reset"));
        w.refunded = a.total; return reply(200, refund());
      }
      if (p.startsWith("/v1/refunds/")) return reply(200, refund());
      if (p.startsWith("/v1/refunds?")) return reply(200, { object: "list", url: "/v1/refunds", has_more: false, data: w.refunded ? [refund()] : [] });
      return reply(200, pi());
    };
    w.hostaway = (req) => {
      const p = req.url.replace("https://api.hostaway.com", ""); w.calls.push(`H ${req.method} ${p}`);
      if (o.hostawayStatus) return reply(o.hostawayStatus, { status: "fail", message: "unauthorized" });
      if (req.method === "PUT") {
        assert.equal(p, `/v1/reservations/${a.rid}/statuses/cancelled`); assert.equal(req.body, JSON.stringify({ cancelledBy: "host" })); w.cancelRequests += 1;
        if (o.cancelLost) return Promise.reject(new Error("socket reset"));
        w.resStatus = "cancelled"; return reply(200, { status: "success", result: full() });
      }
      if (req.method === "GET" && p.startsWith("/v1/reservations?")) return reply(200, { status: "success", result: new URL(req.url).searchParams.has("afterId") ? [] : [full(true)] });
      const m = /^\/v1\/reservations\/(\d+)$/.exec(p);
      if (req.method === "GET" && m) return m[1] === a.rid ? reply(200, { status: "success", result: full() }) : reply(404, { status: "fail" });
      return reply(404, { status: "fail" });
    };
    return w;
  }
  const pgPlan = (a, over = {}) => E.buildPlan(C, { approvalRef: "SYNTHETIC-htc-pg", intentId: a.id, expectedVersion: a.intent.version, notBefore: new Date(F.at(0) - MINUTE).toISOString(), paymentIntentId: a.piId,
    reservationId: a.rid, chargeId: a.chargeId, capturedMinor: a.total, from: a.stay.from, to: a.stay.to, guests: a.intent.guests, attemptId: a.attemptId, sessionId: a.sessionId, runnerDigest: "0".repeat(64), ...over });
  const pgRun = (a, clk, w, extra = {}, over = {}) => {
    const b = pgPlan(a, over);
    return E.runTestCleanupCore({ plan: b.plan, planHash: b.planHash, pool: db.app, tooling: realTooling, exchanges: { stripe: w.stripe, hostaway: w.hostaway },
      credentials: { stripe: () => "sk_test_Fake1", hostaway: () => "synthetic-hostaway-token" }, clock: () => (clk.t += 10), sleep: async (ms) => { clk.t += Math.max(ms, 30 * 1000); }, ...extra });   // a real clock: ms resolution, strictly increasing
  };
  const newClock = () => ({ t: F.at(0) + 10 * MINUTE });
  const snap = async (id) => ({ st: (await db.app.query("SELECT state, version, reason_code, settlement_reservation_cancelled AS c, settlement_authorization_settled AS a, captured_minor::text AS cap FROM booking.intents WHERE id = $1", [id])).rows[0],
    ops: (await db.app.query("SELECT op_type, state, attempts, (dispatched_at IS NOT NULL) AS d, result_ref FROM booking.external_operations WHERE intent_id = $1 ORDER BY op_type, created_at", [id])).rows,
    claim: (await db.app.query("SELECT (released_at IS NOT NULL) AS released FROM booking.inventory_claims WHERE intent_id = $1", [id])).rows,
    refunds: (await db.app.query("SELECT seq, state, stripe_refund_id, amount_minor::text AS amt FROM booking.payment_refunds WHERE intent_id = $1 ORDER BY seq", [id])).rows,
    ledger: (await db.app.query("SELECT entry FROM booking.payment_ledger WHERE intent_id = $1 ORDER BY id", [id])).rows.map((x) => x.entry),
    cases: Number((await db.app.query("SELECT count(*)::int AS n FROM booking.reconciliation_cases WHERE intent_id = $1 AND status = 'open'", [id])).rows[0].n),
    locks: Number((await db.app.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'")).rows[0].n) });

  test("I1 PG integration (REAL request + cleanup worker + repo + 0019/0020 + isolated transports / executors; FAKE exchanges): ref echoed and NOT echoed → ONE request, ONE cancel PUT then ONE refund POST (exact body / key), cancelled / not_completed_refunded, refund record + ledger + evidence, recording retired, claim released, lock released; a SECOND admission refuses read-only with zero sends; budgets measured", async () => {
    for (const echoRef of [true, false]) {
      const a = await capturedIntent(); const clk = newClock(); const w = pgWorld(a, clk, { echoRef });
      const r = await pgRun(a, clk, w);
      assert.equal(r.outcome, "TEST_CLEANUP_COMPLETED", `${echoRef ? "echoed" : "not echoed"}: ${JSON.stringify(r)}`);
      assert.deepEqual([r.requestInvocations, r.cancelInvocations, r.cancelOutcome, r.refundInvocations, r.refundOutcome, r.capturedMinor, r.reservationId, r.chargeId, r.refundId, r.publicStatus, r.lock, w.cancelRequests, w.refundRequests],
        [1, 1, "REPLIED", 1, "REPLIED", a.total, a.rid, a.chargeId, w.refundId, "not_completed_refunded", "released", 1, 1]);
      assert.deepEqual(w.calls.filter((x) => /^(S POST|H POST|H PUT|H DELETE)/.test(x)), [`H PUT /v1/reservations/${a.rid}/statuses/cancelled`, "S POST /v1/refunds"]);
      const s = await snap(a.id);
      assert.deepEqual([s.st.state, s.st.reason_code, s.st.c, s.st.a, s.st.cap, s.claim[0].released, s.cases, s.locks], ["cancelled", "TEST_CLEANUP_REQUESTED", true, true, String(a.total), true, 0, 0]);
      assert.deepEqual(s.ops.filter((x) => x.op_type === CAN).map((x) => [x.state, x.attempts, x.d, x.result_ref]), [["succeeded", 1, true, a.rid]]);
      assert.deepEqual(s.ops.filter((x) => x.op_type === RFD).map((x) => [x.state, x.attempts, x.d, x.result_ref]), [["succeeded", 1, true, w.refundId]]);
      assert.deepEqual(s.ops.filter((x) => x.op_type === REC).map((x) => [x.state, x.attempts, x.d]), [["superseded", 0, false]], "recording retired, never dispatched");
      assert.deepEqual(s.refunds, [{ seq: 1, state: "succeeded", stripe_refund_id: w.refundId, amt: String(a.total) }]);
      assert.deepEqual(s.ledger, ["authorization_accepted", "capture_succeeded", "refund_succeeded"]);
      for (const t of ["guest.notify", "alert.owner", "stripe.void_payment_intent"]) assert.equal(s.ops.filter((x) => x.op_type === t).length, 0, t);
      const i = await R.loadIntent(db.app, a.id); assert.deepEqual([i.payment.capturedMinor, i.payment.paymentIntentId, String(i.reservation.reservationId), IS.publicStatus(i)], [a.total, a.piId, a.rid, "not_completed_refunded"]);
      console.log(`# I1 ${echoRef ? "echoed" : "not-echoed"}: steps=${r.steps} dbQueries=${r.dbQueries} exchanges=${r.exchanges} hostawayReads=${r.hostawayReads} lookups=${r.lookupPages} account=${r.accountReads} pi=${r.piReads} refundReads=${r.refundReads} lists=${r.refundLists}`);
      assert.ok(r.dbQueries > 0 && r.dbQueries <= C.budgets.dbQueries && r.exchanges <= C.budgets.exchanges);
      // second admission (a later session) on the cleaned intent: refused before the lock, zero sends
      const a2 = { ...a, intent: i }; const w2 = pgWorld(a2, clk); const r2 = await pgRun(a2, clk, w2);
      assert.deepEqual([r2.outcome, r2.code, w2.calls.length, r2.requestInvocations, r2.steps, r2.lock], ["START_STATE_NOT_ELIGIBLE", "STATE_NOT_PAYMENT_CAPTURED", 0, 0, 0, "not_acquired"], JSON.stringify(r2));
    }
  });

  test("I2 PG integration: pre-request proof failure (charge partly refunded at the provider) → PROVIDER_PROOF_FAILED, DB unchanged, ZERO request; lost cancel reply → WRITE_OUTCOME_UNKNOWN with ONE PUT and ZERO refund, the accepted worker settles outcome_unknown, a SECOND SESSION refuses read-only; lost refund reply → WRITE_OUTCOME_UNKNOWN with ONE POST, no resend; 401 → no write", async () => {
    { const a = await capturedIntent(); const clk = newClock(); const before = await snap(a.id); const w = pgWorld(a, clk); w.refunded = 1; const r = await pgRun(a, clk, w);
      assert.deepEqual([r.outcome, r.code, r.requestInvocations, w.calls.filter((x) => x.startsWith("H")).length, w.cancelRequests], ["PROVIDER_PROOF_FAILED", "CHARGE_ALREADY_REFUNDED", 0, 0, 0]); assert.deepEqual(await snap(a.id), before); }
    { const a = await capturedIntent(); const clk = newClock(); const w = pgWorld(a, clk, { cancelLost: true }); const r = await pgRun(a, clk, w);
      assert.deepEqual([r.outcome, r.code, r.cancelInvocations, r.cancelOutcome, r.refundInvocations, w.cancelRequests, w.refundRequests], ["WRITE_OUTCOME_UNKNOWN", "LOST_CANCEL_REPLY", 1, "UNKNOWN", 0, 1, 0], JSON.stringify(r));
      const s = await snap(a.id); assert.equal(s.st.state, "test_cleanup_pending", JSON.stringify(s.st));
      assert.deepEqual(s.ops.filter((x) => x.op_type === CAN).map((x) => [x.state, x.attempts, x.d]), [["outcome_unknown", 1, true]]);
      assert.deepEqual([r.finalState, r.cancelOps, s.locks, s.claim[0].released], ["test_cleanup_pending", ["outcome_unknown"], 0, false]);
      const a2 = { ...a, intent: await R.loadIntent(db.app, a.id) }; const w2 = pgWorld(a2, clk); const r2 = await pgRun(a2, clk, w2);
      assert.deepEqual([r2.outcome, r2.code, w2.calls.length, w2.cancelRequests, r2.steps], ["START_STATE_NOT_ELIGIBLE", "STATE_NOT_PAYMENT_CAPTURED", 0, 0, 0], `second session: ${JSON.stringify(r2)}`);
      const w3 = pgWorld(a2, clk); const r3 = await pgRun({ ...a2, intent: { ...a2.intent, version: a.intent.version } }, clk, w3);                       // even with the stale pre-request version pinned
      assert.deepEqual([w3.calls.length, w3.cancelRequests, r3.cancelInvocations, r3.requestInvocations], [0, 0, 0, 0]); }
    { const a = await capturedIntent(); const clk = newClock(); const w = pgWorld(a, clk, { refundLost: true }); const r = await pgRun(a, clk, w);
      assert.deepEqual([r.outcome, r.code, r.cancelInvocations, r.refundInvocations, r.refundOutcome, w.refundRequests], ["WRITE_OUTCOME_UNKNOWN", "LOST_REFUND_REPLY", 1, 1, "UNKNOWN", 1], JSON.stringify(r));
      const s = await snap(a.id); assert.deepEqual([s.st.state, s.st.c, s.locks], ["test_cleanup_pending", true, 0]);
      assert.deepEqual(s.ops.filter((x) => x.op_type === RFD).map((x) => [x.state, x.attempts, x.d]), [["outcome_unknown", 1, true]]);
      const a2 = { ...a, intent: await R.loadIntent(db.app, a.id) }; const w2 = pgWorld(a2, clk); const r2 = await pgRun(a2, clk, w2);
      assert.deepEqual([r2.outcome, w2.calls.length, w2.refundRequests], ["START_STATE_NOT_ELIGIBLE", 0, 0]); }
    { const a = await capturedIntent(); const clk = newClock(); const w = pgWorld(a, clk, { hostawayStatus: 401 }); const r = await pgRun(a, clk, w);
      assert.deepEqual([r.outcome, r.code, r.requestInvocations, w.cancelRequests, (await snap(a.id)).locks], ["PROVIDER_PROOF_FAILED", "RESERVATION_READ_401", 0, 0, 0], JSON.stringify(r)); }
  });

  test("I4 PG integration (ROOT 5881490593 F3): a lock-session error on the REAL dedicated lock client while the REAL worker runs — (a) at afterComplete(refund row): the worker's signal is already aborted, its terminal event is DEFERRED (row succeeded, intent pending, claim HELD), runner LOCK_LOST / STOP_LOCK_SESSION_ERROR, no resend; (b) in-flight after the refund send: the worker settles the row unknown, zero resend; (c) control: an error AFTER the committed terminal step reports the committed effects truthfully (no fake rollback)", async () => {
    const withLock = () => { const h = { lc: null }; h.factory = async () => { h.lc = await db.app.connect(); return h.lc; }; return h; };
    { const a = await capturedIntent(); const clk = newClock(); const w = pgWorld(a, clk); const L = withLock(); let signalAborted = null; let emitted = 0;
      const tooling = { ...realTooling, runTestCleanupStep: (pool, opts) => W.runTestCleanupStep(pool, { ...opts, hooks: { afterComplete: async (op) => { if (op.op_type === RFD) { emitted += 1; L.lc.emit("error", new Error("ROOT_SYNTHETIC_LOCK_ERROR")); signalAborted = opts.signal.aborted; } } } }) };
      const r = await pgRun(a, clk, w, { lockClientFactory: L.factory, tooling });
      const s = await snap(a.id);
      assert.deepEqual([emitted, signalAborted, r.outcome, r.code, r.lockSession, r.lock, r.cancelInvocations, r.refundInvocations, r.refundOutcome, w.refundRequests], [1, true, "LOCK_LOST", "STOP_LOCK_SESSION_ERROR", "error_observed", "session_error_connection_destroyed", 1, 1, "REPLIED", 1], JSON.stringify(r));
      assert.ok(r.actions.includes("REFUND_ROW_SUCCEEDED_EVENT_DEFERRED"), JSON.stringify(r.actions));
      assert.deepEqual([s.st.state, s.st.c, s.st.a, s.claim[0].released, s.locks], ["test_cleanup_pending", true, false, false, 0], JSON.stringify(s.st));
      assert.deepEqual(s.ops.filter((x) => x.op_type === RFD).map((x) => [x.state, x.attempts, x.result_ref]), [["succeeded", 1, w.refundId]], "the durable succeeded refund row is preserved, never rewritten");
      assert.deepEqual([r.finalState, r.refundOps, r.claimHeld, r.factsObserved], ["test_cleanup_pending", ["succeeded"], true, true]);
      assert.equal(JSON.stringify(r).includes("ROOT_SYNTHETIC"), false, "no raw error text");
      const a2 = { ...a, intent: await R.loadIntent(db.app, a.id) }; const w2 = pgWorld(a2, clk); const r2 = await pgRun(a2, clk, w2);   // a later session: read-only refusal, zero sends
      assert.deepEqual([r2.outcome, w2.calls.length, w2.refundRequests, w2.cancelRequests], ["START_STATE_NOT_ELIGIBLE", 0, 0, 0]); }
    { const a = await capturedIntent(); const clk = newClock(); const w = pgWorld(a, clk); const L = withLock(); let signalAborted = null;
      const tooling = { ...realTooling, runTestCleanupStep: (pool, opts) => W.runTestCleanupStep(pool, { ...opts, hooks: { afterSend: async () => { if (w.refundRequests === 1 && signalAborted === null) { L.lc.emit("error", new Error("ROOT_SYNTHETIC_LOCK_ERROR")); signalAborted = opts.signal.aborted; } } } }) };
      const r = await pgRun(a, clk, w, { lockClientFactory: L.factory, tooling });
      const s = await snap(a.id);
      assert.deepEqual([signalAborted, r.outcome, r.refundInvocations, w.refundRequests, s.st.state, s.claim[0].released, s.locks], [true, "LOCK_LOST", 1, 1, "test_cleanup_pending", false, 0], JSON.stringify(r));
      assert.deepEqual(s.ops.filter((x) => x.op_type === RFD).map((x) => [x.state, x.attempts]), [["outcome_unknown", 1]], "in-flight stop: the accepted worker settles the row unknown; never a second POST");
      assert.ok(r.actions.some((x) => /^STOP:SIGNAL/.test(x)), JSON.stringify(r.actions)); }
    { const a = await capturedIntent(); const clk = newClock(); const w = pgWorld(a, clk); const L = withLock(); let steps = 0;
      const tooling = { ...realTooling, runTestCleanupStep: async (pool, opts) => { const out = await W.runTestCleanupStep(pool, opts); steps += 1; if (steps === 2) L.lc.emit("error", new Error("ROOT_SYNTHETIC_LOCK_ERROR")); return out; } };
      const r = await pgRun(a, clk, w, { lockClientFactory: L.factory, tooling });
      const s = await snap(a.id);
      assert.deepEqual([r.outcome, r.code, r.finalState, r.claimHeld, r.refundOps, s.st.state, s.claim[0].released, s.locks], ["LOCK_LOST", "STOP_LOCK_SESSION_ERROR", "cancelled", false, ["succeeded"], "cancelled", true, 0], JSON.stringify(r));
      assert.equal(r.postcheck, null, "never success after a latched session error; the committed effects are reported, not rolled back"); }
  });

  test("I3 PG integration: real lock conflict (another session holds LOCK_KEY) → LOCK_NOT_ACQUIRED, zero provider calls, zero DB writes; historic / stale version / wrong amount / PI / reservation / charge / session pins refuse read-only; deadline at the final read → never success, facts observed; the schema prerequisite is READ (never applied)", async () => {
    { const a = await capturedIntent(); const clk = newClock(); const before = await snap(a.id);
      const holder = new pg.Client({ connectionString: db.reportUrl() }); await holder.connect();
      try { await holder.query("SELECT pg_advisory_lock(pg_catalog.hashtext($1), 0)", [LK.LOCK_KEY]);
        const w = pgWorld(a, clk); const r = await pgRun(a, clk, w);
        assert.deepEqual([r.outcome, r.code, w.calls.length, r.requestInvocations, r.lock], ["LOCK_NOT_ACQUIRED", "RUN_LOCK_PRESENT", 0, 0, "not_acquired"]);
        const after1 = await snap(a.id); assert.deepEqual({ ...after1, locks: 0 }, { ...before, locks: 0 });
      } finally { await holder.end(); } }
    const a = await capturedIntent(); const clk = newClock();
    const sch = (await db.app.query(E.QUERIES.schema)).rows[0]; assert.deepEqual(Object.values(sch), Object.values(sch).map(() => true), JSON.stringify(sch));
    for (const [over, outcome, code] of [[{ notBefore: new Date(F.at(0) + MINUTE).toISOString() }, "START_STATE_NOT_ELIGIBLE", "HISTORIC_INTENT"], [{ expectedVersion: a.intent.version + 1 }, "START_STATE_NOT_ELIGIBLE", "VERSION_NOT_PINNED"],
      [{ capturedMinor: a.total + 1 }, "SCOPE_REFUSED", "AMOUNT_NOT_PINNED"], [{ paymentIntentId: "pi_HTCother00000001" }, "SCOPE_REFUSED", "PAYMENT_INTENT_NOT_PINNED"], [{ reservationId: String(Number(a.rid) + 1) }, "SCOPE_REFUSED", "RESERVATION_NOT_PINNED"],
      [{ chargeId: "ch_test_other000000000" }, "SCOPE_REFUSED", "CAPTURE_ROW_NOT_BOUND"], [{ sessionId: "cs_test_other0000000" }, "SCOPE_REFUSED", "SESSION_NOT_PINNED"], [{ attemptId: "00000000-0000-4000-8000-00000000abcd" }, "SCOPE_REFUSED", "PAYMENT_ATTEMPT_NOT_BOUND"]]) {
      const w = pgWorld(a, clk); const r = await pgRun(a, clk, w, {}, over);
      assert.deepEqual([r.outcome, r.code, w.calls.length, r.requestInvocations, r.steps], [outcome, code, 0, 0, 0], code);
    }
    { let reads = 0; const w = pgWorld(a, clk); const q = db.app.query.bind(db.app);
      const pool = { query: async (sql, params) => { const res = await q(sql, params); if (/e7htc:claims/.test(String(sql))) { const st = (await q("SELECT state FROM booking.intents WHERE id = $1", [a.id])).rows[0].state; if (st === "cancelled") reads += 1; } return res; }, connect: () => db.app.connect() };
      let m = 0; const monotonic = () => (reads > 0 ? 900001 : (m += 1, 0));
      const r = await pgRun(a, clk, w, { pool, monotonic });
      assert.deepEqual([r.outcome, r.factsObserved, r.finalState, r.cancelInvocations, r.refundInvocations], ["DEADLINE", true, "cancelled", 1, 1], JSON.stringify(r));
      assert.equal((await snap(a.id)).locks, 0); }
  });
}
