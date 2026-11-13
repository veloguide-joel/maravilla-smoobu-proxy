// E7 Slice 5 — hosted RECORDED-TEST cleanup runner (scripts/e7-hosted-recorded-cleanup.mjs). OFFLINE, no network (the https / fetch primitives are poisoned and
// counted), no credential, no DB connection string. The FAKE world stands in for the DB + providers; the REAL accepted transports (test-cleanup-transports /
// http-transports), the REAL accepted isolated executors, the REAL accepted pure proofs (capture-proof / recovery-plan / test-cleanup-proof /
// compensation-proof / mirror-proof / offline-charge-proof) and — whenever the pinned tooling's dependency is present — the REAL accepted BOUND mirror
// transport (lib/booking-db/mirror-transport.js) run against the runner's fences. The fake request / cleanup worker / mirror worker mutate the world the
// way the accepted modules do (their REAL counterparts run in the opt-in PG integration below). Tooling = ../tooling (the pinned merged e7-test commit) or
// E7_TOOLING_DIR.
//   * DEPENDENCY-FREE PREFLIGHT: the accepted mirror-transport.js imports mirror-worker.js → operations.js → repo.js → pool.js → `pg`, which the hosted
//     preflight never installs. When that import fails with EXACTLY ERR_MODULE_NOT_FOUND for `pg`, the fake-world tests use a TEST STAND-IN of the bound
//     transport's call surface (same exact fetch call; labelled; preflight only) so the runner's own fences are still exercised end to end; the REAL bound
//     transport runs whenever it loads (local full runs, the PG integration). Reported to ROOT as a tooling contract conflict (see the PR).
//   * OPT-IN INTEGRATION (E7_HRT_DB_TESTS=1 + PG_BIN): the REAL merged requestRecordedTestCleanup + runTestCleanupStep + runMirrorStep / repo / operations /
//     0019–0021 + the REAL bound mirror transport on a disposable PostgreSQL with FAKE exchanges.
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
const E = await import("../scripts/e7-hosted-recorded-cleanup.mjs");
const RESRUN = await import("../scripts/e7-hosted-reservation.mjs");
const CAPRUN = await import("../scripts/e7-hosted-capture.mjs");
const TCRUN = await import("../scripts/e7-hosted-test-cleanup.mjs");
const RCRUN = await import("../scripts/e7-hosted-recording.mjs");
const [TT, T, EX, HR, C1, CP, RP, TP, CO, IS, MP, OP, LK] = await Promise.all([tool("scripts/e7-connected/test-cleanup-transports.mjs"), tool("scripts/e7-connected/http-transports.mjs"),
  tool("scripts/e7-connected/test-cleanup-executors.mjs"), tool("lib/hostaway-reservations.js"), tool("scripts/e7-connected/probe-env-preflight.mjs"), tool("lib/checkout/capture-proof.js"),
  tool("lib/checkout/recovery-plan.js"), tool("lib/checkout/test-cleanup-proof.js"), tool("lib/checkout/compensation-proof.js"), tool("lib/checkout/intent-state.js"),
  tool("lib/checkout/mirror-proof.js"), tool("lib/checkout/offline-charge-proof.js"), tool("scripts/e7-connected/run-lock-precheck.mjs")]);
// `pg`-dependent accepted modules: loaded when the tooling's dependency is present (local / real-PG runs); null ONLY on ERR_MODULE_NOT_FOUND for `pg` (the dependency-free preflight)
const pgOnly = (p) => tool(p).catch((e) => (e && e.code === "ERR_MODULE_NOT_FOUND" && /'pg'/.test(String(e.message)) ? null : Promise.reject(e)));
const [TR, MT, MW] = await Promise.all([pgOnly("lib/booking-db/test-cleanup-recorded.js"), pgOnly("lib/booking-db/mirror-transport.js"), pgOnly("lib/booking-db/mirror-worker.js")]);
const EXPECTATION_KEYS = Object.freeze(["approvalRef", "attemptId", "authorizedMinor", "capturedMinor", "currency", "expectedVersion", "finalTotalMinor", "from", "guests", "intentId", "listingId",
  "offlineChargeId", "paymentIntentId", "planHash", "reservationId", "sessionId", "stripeChargeId", "to"]);
if (TR) assert.deepEqual([...TR.TEST_CLEANUP_RECORDED_EXPECTATION_KEYS], [...EXPECTATION_KEYS], "the local key copy equals the accepted TEST_CLEANUP_RECORDED_EXPECTATION_KEYS");
const MIRROR_KEYS = Object.freeze(["retrieveAccount", "retrievePaymentIntent", "retrieveReservation", "listOfflineCharges", "refundOfflineCharge"]);
if (MW) assert.deepEqual([...MW.MIRROR_EXECUTOR_KEYS], [...MIRROR_KEYS], "the local key copy equals the accepted MIRROR_EXECUTOR_KEYS");
after(() => { assert.deepEqual(GUARD, { request: 0, Agent: 0, fetch: 0 }, "no real network primitive was touched"); });

const C = E.CONSTANTS;
const IID = "11111111-2222-4333-8444-555555555555"; const PI = "pi_FAKEhostedRtc0001"; const VER = 9; const REF = "MV-FAKE0001"; const ACCT = C.accountId;
const AMT = 14000; const FROM = "2026-11-25"; const TO = "2026-11-26"; const NB = "2026-11-12T00:00:00.000Z"; const CREATED = Date.UTC(2026, 10, 12, 15, 0, 0);
const ATTEMPT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"; const RID = "71999901"; const CH = "ch_FAKEhostedRtc0001"; const OCH = "520001"; const CS = "cs_test_FAKEhostedRtc0001"; const RE = "re_FAKEhostedRtc0001";
const REFUND_OP = "99999999-8888-4777-8666-555555555555"; const KEY = `ref:${IID}:1`; const RKEY = `och:${IID}:1`; const MKEY = `ochr:${IID}:1`; const RUN = "run-0001-1";
const MID = "520777";                                                                                      // the provider id of the mirror refund row
const enc = (o) => new TextEncoder().encode(JSON.stringify(o));
const planInput = (over = {}) => ({ approvalRef: "SYNTHETIC-hosted-rtc", intentId: IID, expectedVersion: VER, notBefore: NB, paymentIntentId: PI, reservationId: RID, chargeId: CH, offlineChargeId: OCH,
  capturedMinor: AMT, from: FROM, to: TO, guests: 1, attemptId: ATTEMPT, sessionId: CS, runnerDigest: "0".repeat(64), ...over });
const built = (over = {}) => E.buildPlan(C, planInput(over));
const op = (op_type, over = {}) => ({ id: `op-${op_type}`, op_type, state: "succeeded", attempts: 1, idempotency_key: null, dispatched: true, leased: false, late_result_status: null, result_ref: null, settled_evidence: false,
  payload_rid: null, payload_pi: null, payload_charge: null, payload_och: null, payload_currency: null, payload_attempt: null, payload_amount: null, payload_key: null, payload_keys: 0, ...over });
const REFUND_BODY = `payment_intent=${PI}&amount=${AMT}&metadata%5Bmv_refund_op%5D=${REFUND_OP}&metadata%5Bmv_refund_key%5D=${encodeURIComponent(KEY)}`;
const MIRROR_BODY = JSON.stringify({ title: MP.mirrorTitle(IID), amount: 140, isIncludeInPriceBreakdown: 0 });
const SCHEMA_FLAGS = ["f0020", "settled_for", "pi_ok", "ledgered", "cancel_bound", "refund_fence", "retirement_fence", "pending_state", "f0021_proof", "f0021_legs", "f0021_complete", "f0021_settled_for",
  "f0021_suppress", "f0021_end_ok", "mirrored_column", "suppressions_table"];

// ---------------------------------------------------------------------------------------------------------------------------------
// fake world: DB rows + providers; the fake request / workers mutate it the way the accepted request / cleanup worker / mirror worker would
const CAP = "stripe.capture_payment_intent"; const REC = "hostaway.record_offline_charge"; const CAN = "hostaway.cancel_reservation"; const RFD = "stripe.refund_payment_intent";
const MIR = "hostaway.refund_offline_charge"; const NOT = "guest.notify";
function world(o = {}) {
  const w = { status: o.status ?? "confirmed", version: VER, ops: [], hx: [{ state: "succeeded", rid: RID }], claimReleased: false, calls: [], cleanupCalls: 0, mirrorCalls: 0, requestCalls: 0, res: RID, echoRef: o.echoRef ?? true,
    lease: null, dispatch: { at: CREATED, attempt: 1 }, createdAt: o.createdAt ?? CREATED, piRefunded: 0, disputed: false, resStatus: "new", lockRows: 1, captureAttempts: 1, cancelAttempts: 0, voidAttempts: 0, offlineChargeAttempts: 0,
    refunds: [], ledger: [{ entry: "authorization_accepted", amt: String(AMT), currency: "USD", provider_ref: PI }, { entry: "capture_succeeded", amt: String(AMT), currency: "USD", provider_ref: PI },
      { entry: "offline_charge_recorded", amt: String(AMT), currency: "USD", provider_ref: OCH }],
    evidence: [{ kind: "payment_intent", external_ref: PI, status: "succeeded" }, { kind: "hostaway_reservation", external_ref: RID, status: "new" }, { kind: "hostaway_offline_charges", external_ref: RID, status: "listed" }],
    notify: { renders: 0, latches: 0, suppressions: 0 }, reasonCode: null, settlement: { reservationCancelled: false, authorizationSettled: false, recordingMirrored: false }, workLeased: false, holds: 0, endOk: null,
    schema: Object.fromEntries(SCHEMA_FLAGS.map((k) => [k, true])), refundObjs: new Map(),
    charges: [{ id: Number(OCH), reservationId: Number(RID), listingMapId: 606998, type: "charge", title: OP.offlineChargeTitle(IID), amount: 140, currency: "USD", status: "paid", paymentProvider: "offline", paymentMethod: "credit_card" }] };
  w.ops.push(op("stripe.create_checkout_session", { result_ref: CS }), op("stripe.retrieve_checkout_session"), op("stripe.retrieve_payment_intent"));
  w.ops.push(op("hostaway.create_reservation", { result_ref: RID }));
  w.ops.push(op(CAP, { result_ref: CH, payload_pi: PI, payload_attempt: 1, payload_amount: AMT, payload_key: `cap:${IID}:${PI}` }));
  w.ops.push(op("hostaway.list_offline_charges"), op("hostaway.list_offline_charges", { id: "op-list-2" }));
  w.ops.push(op(REC, { idempotency_key: RKEY, result_ref: OCH, settled_evidence: true, payload_rid: RID, payload_amount: AMT, payload_keys: 2 }));
  w.ops.push(op(NOT, { state: "pending", attempts: 0, dispatched: false }));
  return w;
}
const rowOf = (w, t) => w.ops.find((x) => x.op_type === t);
const intentOf = (w) => ({ id: IID, status: w.status, version: w.version, listingId: 606998, from: FROM, to: TO, guests: 1, ref: REF, createdAt: w.createdAt,
  price: { currency: "USD", finalTotalMinor: AMT, rateBps: 1000 }, payment: { paymentIntentId: PI, livemode: false, capturedMinor: AMT, amountMinor: AMT, currency: "USD", captureBefore: CREATED + 7 * 86400000 },
  reservation: w.res ? { reservationId: w.res, confirmedAt: CREATED } : null, counters: { captureAttempts: w.captureAttempts, voidAttempts: w.voidAttempts, cancelAttempts: w.cancelAttempts, offlineChargeAttempts: w.offlineChargeAttempts, reservationAttempts: 1 },
  checkout: { sessionId: CS, attempt: 1 }, lease: w.lease, dispatch: w.dispatch, reasonCode: w.reasonCode, settlement: w.settlement, offlineChargeId: w.offlineChargeId === undefined ? OCH : w.offlineChargeId });
function fakePool(w, o = {}) {
  const tag = (sql) => /\/\*e7hrt:(\w+)\*\//.exec(sql)?.[1];
  const p = { reads: 0, async query(sql) {
    this.reads += 1;
    if (o.dbFailAt && this.reads === o.dbFailAt) throw new Error("db down");
    switch (tag(sql)) {
      case "instance": return { rows: [{ environment: o.env ?? "test" }] };
      case "attempts": return { rows: [{ id: ATTEMPT, status: "completed", checkout_session_id: CS, payment_intent_id: PI, livemode: false }] };
      case "hostaway": return { rows: w.hx.map((x) => ({ ...x })) };
      case "ops": return { rows: w.ops.map((x) => ({ ...x })) };
      case "holds": return { rows: [{ n: w.holds }] };
      case "cases": return { rows: [{ n: o.cases ?? 0 }] };
      case "claims": return { rows: [{ listing_id: 606998, released: w.claimReleased }] };
      case "work": return { rows: [{ leased: w.workLeased }] };
      case "refunds": return { rows: w.refunds.map((x) => ({ ...x })) };
      case "ledger": return { rows: w.ledger.map((x) => ({ ...x })) };
      case "evidence": return { rows: w.evidence.map((x) => ({ ...x })) };
      case "notify": return { rows: [{ ...w.notify }] };
      case "settlement": return { rows: [{ environment: o.intentEnv ?? "test", reason_code: w.reasonCode, cancelled: w.settlement ? w.settlement.reservationCancelled : null, settled: w.settlement ? w.settlement.authorizationSettled : null,
        mirrored: w.settlement ? w.settlement.recordingMirrored : null, och: w.offlineChargeId === undefined ? OCH : w.offlineChargeId, cap: String(AMT) }] };
      case "schema": return { rows: [{ ...w.schema }] };
      case "endok": return { rows: [{ ok: w.endOk ?? (w.status === "cancelled") }] };
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
        const lost = (typeof o.lockLostAt === "number" && (w.cleanupCalls + w.mirrorCalls) >= o.lockLostAt) || (typeof o.lockLostAtProof === "number" && cl.proofs >= o.lockLostAtProof);
        return { rows: [{ n: lost ? 0 : w.lockRows, pid: cl.pid }] };
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
/** the provider's mirror refund row (documented facts: a separate `refund` row, negative amount, typed refundInfo { id, chargeId: <own id>, refundedChargeId: <original> }) */
const mirrorRow = (over = {}) => ({ id: Number(MID), reservationId: Number(RID), listingMapId: 606998, type: "refund", title: MP.mirrorTitle(IID), amount: -140, currency: "USD", status: "succeeded", paymentProvider: "offline",
  paymentMethod: "credit_card", refundInfo: { id: 9000001, chargeId: Number(MID), refundedChargeId: Number(OCH) }, ...over });
const LIST_PATH = `/v1/guestPayments/charges?limit=500&reservationIds=${RID}`; const MIRROR_PATH = `/v1/guestPayments/charges/${RID}/${OCH}/refund`;
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
    if (o.finalPiMutate && w.status === "cancelled") return reply(200, o.finalPiMutate(base));             // a PI read after the workers finished = the runner's final readback
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
    if (req.method === "POST") {
      assert.equal(p, MIRROR_PATH); assert.equal(req.body, MIRROR_BODY); assert.deepEqual(Object.keys(req.headers).sort(), ["Accept", "Authorization", "Cache-control", "Content-Type"]);
      assert.equal(req.headers["Content-Type"], "application/json"); assert.ok(req.signal instanceof AbortSignal); assert.equal(req.maxBytes, 1024 * 1024);
      w.mirrorRequests = (w.mirrorRequests ?? 0) + 1;
      const row = mirrorRow(o.mirrorRowOver ?? {});
      if (o.mirrorLost) { if (o.mirrorLandedAnyway) w.charges.push(row); return Promise.reject(new Error("socket reset")); }
      w.charges.push(row);
      return reply(200, { status: "success", result: { id: row.id, refundInfo: { ...row.refundInfo }, status: "succeeded", paymentProvider: "offline" } });
    }
    if (req.method === "GET" && p === LIST_PATH) {
      const n = (w.listReads = (w.listReads ?? 0) + 1);
      let rows = w.charges.map((x) => JSON.parse(JSON.stringify(x)));
      if (o.preListMutate && n === 1) rows = o.preListMutate(rows);                                       // the FIRST list read = the runner's pre-request proof read
      if (o.finalListMutate && w.status === "cancelled") rows = o.finalListMutate(rows);                 // a list read after the workers finished = the runner's final readback
      return reply(200, { status: "success", result: rows, count: rows.length, limit: 500 });
    }
    if (req.method === "GET" && p.startsWith("/v1/reservations?")) {
      w.lookupPages = (w.lookupPages ?? 0) + 1;
      const page = new URL(req.url).searchParams.has("afterId") ? [] : [resObj({ ...w, echoRef: true })];
      return reply(200, { status: "success", result: page });
    }
    if (req.method === "GET" && /^\/v1\/reservations\/\d+$/.test(p)) { const n = (w.resReads = (w.resReads ?? 0) + 1); let obj = resObj(w, p.split("/").pop());
      if (o.preResMutate && n === 1) obj = o.preResMutate(obj);
      if (o.finalResMutate && w.status === "cancelled") obj = o.finalResMutate(obj);
      return reply(200, { status: "success", result: obj }); }
    return reply(404, { status: "fail" });
  };
  return { stripe, hostaway };
}
/** the fake request: the accepted requestRecordedTestCleanup's visible effect (ONE E3 event: test_cleanup_pending, version +1, settlement { f, f, f }, the notification SUPPRESSED
 *  with its audit row, ONE pristine cancel + ONE pristine bound refund row, ONE 'requested' record; the recording stays succeeded + linked; ZERO mirror rows yet) */
function fakeRequest(w, o = {}) {
  return async (pool, intentId, { now, env, operator }) => {
    w.requestCalls += 1;
    assert.equal(intentId, IID); assert.ok(Number.isFinite(now)); assert.deepEqual(env, { VERCEL_ENV: "development", MV_E7_TEST_CLEANUP: "enabled" });
    assert.deepEqual(Object.keys(operator).sort(), [...EXPECTATION_KEYS]);
    assert.deepEqual([operator.intentId, operator.paymentIntentId, operator.stripeChargeId, operator.offlineChargeId, operator.capturedMinor, operator.reservationId, operator.sessionId, operator.attemptId, operator.expectedVersion],
      [IID, PI, CH, OCH, AMT, RID, CS, ATTEMPT, VER]);
    if (o.requestThrow) { if (o.requestAppliedAnyway) apply(); throw new Error("connection terminated unexpectedly"); }
    if (o.requestRefuse) return { ok: false, error: o.requestRefuse };
    apply();
    return { ok: true, intent: intentOf(w) };
    function apply() {
      w.status = "test_cleanup_pending"; w.version += 1; w.reasonCode = "TEST_CLEANUP_REQUESTED"; w.settlement = { reservationCancelled: false, authorizationSettled: false, recordingMirrored: false };
      if (!o.keepNotify) { Object.assign(rowOf(w, NOT), { state: "superseded" }); w.notify.suppressions = 1; }
      if (o.retireRecording) Object.assign(rowOf(w, REC), { state: "superseded" });
      w.ops.push(op(CAN, { id: "op-cancel", state: "pending", attempts: 0, dispatched: false, payload_rid: RID }));
      w.ops.push(op(RFD, { id: o.refundOpId ?? REFUND_OP, state: "pending", attempts: 0, dispatched: false, payload_pi: PI, payload_charge: CH, payload_currency: "USD", payload_attempt: 1, payload_amount: AMT, payload_key: o.refundKey ?? KEY }));
      w.refunds.push({ seq: 1, idempotency_key: KEY, state: "requested", hostaway_state: "not_applicable", amt: String(AMT), currency: "USD", stripe_refund_id: null });
      if (o.prematureMirror) w.ops.push(mirrorOp());
      if (o.extraOp) w.ops.push(op("stripe.void_payment_intent", { state: "pending", attempts: 0, dispatched: false }));
    }
  };
}
const mirrorOp = (over = {}) => op(MIR, { id: "op-mirror", state: "pending", attempts: 0, dispatched: false, idempotency_key: MKEY, payload_rid: RID, payload_och: OCH, payload_amount: AMT, payload_currency: "USD", payload_keys: 4, ...over });
/** the fake cleanup worker: drives the REAL test-cleanup executors (→ real TT / T → the runner fence → fake exchange) the way the accepted worker's two happy steps do; on a RECORDED
 *  intent the refund success keeps test_cleanup_pending with settlement { t, t, f } and queues the ONE pristine mirror row (the reducer's visible effect) */
function fakeCleanupWorker(w, o = {}) {
  return async (pool, { executors, intentId, env, listings, stripeAccountId, signal, deadlineAt, workerId }) => {
    w.cleanupCalls += 1;
    assert.equal(intentId, IID); assert.deepEqual(env, { VERCEL_ENV: "development", MV_E7_TEST_CLEANUP: "enabled", MV_E7_TEST_CLEANUP_WORKER: "enabled" }); assert.equal(stripeAccountId, ACCT);
    assert.deepEqual([...listings.keys()], [606998]); assert.deepEqual(Object.keys(executors).sort(), [...EX.PHASE_KEYS].sort());
    assert.ok(signal instanceof AbortSignal && Number.isFinite(deadlineAt) && /^e7-hosted-rtc:/.test(workerId));
    assert.ok(!(w.settlement && w.settlement.reservationCancelled && w.settlement.authorizationSettled), "the cleanup worker is never invoked once both legs are proven");
    const sig = AbortSignal.timeout(5000); const actions = []; const cancel = rowOf(w, CAN); const refund = rowOf(w, RFD);
    const out = (extra = {}) => { w.signalAbortedAtEnd = signal.aborted; return { status: "worked", intentId: IID, actions, calls: [], sends: 0, cancelSends: 0, refundSends: 0, stop: null, facts: null, delayMs: o.delayMs ?? 30000, late: Promise.resolve([]), ...extra }; };
    try {
      if (o.foreignRead) await executors.retrieveReservation({ method: "GET", path: `/v1/reservations/${C.protectedReservationIds[0]}`, query: {} }, { signal: sig });
      if (o.wait) { actions.push("WAIT:FAKE"); return out(); }
      if (w.settlement && !w.settlement.reservationCancelled) {
        if (o.legsWithoutSends) { w.settlement = { reservationCancelled: true, authorizationSettled: true, recordingMirrored: false }; w.version += 2; w.resStatus = "cancelled"; w.ops.push(mirrorOp()); actions.push("FAKE:LEGS_WITHOUT_SENDS"); return out(); }
        const rr = await executors.retrieveReservation({ method: "GET", path: `/v1/reservations/${RID}`, query: {} }, { signal: sig });
        if (rr.httpStatus !== 200) { actions.push(`STOP:AUTH_${rr.httpStatus}`); return out({ delayMs: 0 }); }
        await executors.retrieveAccount({ signal: sig });
        await executors.retrievePaymentIntent(PI, { expand: ["latest_charge"] }, { signal: sig });
        Object.assign(cancel, { state: "in_flight", attempts: 1, dispatched: true });                             // the accepted worker claims the row BEFORE the send
        let reply = null;
        try { reply = await executors.cancelReservation({ method: "PUT", path: `/v1/reservations/${RID}/statuses/cancelled`, query: {}, body: { cancelledBy: "host" } }, { signal: sig }); }
        catch (e) { actions.push(`SEND_FAILED:${e && e.code ? e.code : "TRANSPORT"}`); }
        if (!reply || reply.httpStatus !== 200) { cancel.state = "outcome_unknown"; actions.push("CANCEL_OUTCOME_UNKNOWN"); return out({ delayMs: 0 }); }
        const cr = await executors.retrieveReservation({ method: "GET", path: `/v1/reservations/${RID}`, query: {} }, { signal: sig });   // the confirming read
        if (cr.json.result.status !== "cancelled") { actions.push("WAIT:CANCEL_NOT_CONFIRMED"); return out(); }
        Object.assign(cancel, { state: "succeeded", result_ref: RID }); w.settlement = { reservationCancelled: true, authorizationSettled: false, recordingMirrored: false }; w.version += 1; w.cancelAttempts = 1;
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
      w.version += 1; w.settlement = { reservationCancelled: true, authorizationSettled: true, recordingMirrored: false };
      if (!o.noMirrorRow) w.ops.push(mirrorOp(o.mirrorRowOver ?? {}));                                             // the reducer queues the ONE mirror row once BOTH legs are proven
      actions.push("REFUND_SUCCEEDED->test_cleanup_pending");
      return out();
    } catch (e) {
      actions.push(`STOP:EXECUTOR_${/stopped/.test(String(e && e.message)) ? "STOPPED" : "FAILED"}`);
      if (cancel && cancel.state === "in_flight") cancel.state = "outcome_unknown";
      if (refund && refund.state === "in_flight") refund.state = "outcome_unknown";
      return out({ delayMs: 0 });
    }
  };
}
/** the fake mirror worker: drives the runner's composed mirror executors (accepted executors for the reads, the bound transport for the ONE POST) the way the accepted
 *  runMirrorStep's happy step does: account → PI → cancelled reservation → LIST → claim → ONE POST → confirming LIST → completion (row succeeded + linked, ledger, evidence) → terminal */
function fakeMirrorWorker(w, o = {}) {
  return async (pool, { executors, intentId, env, adapterConfig, recordingConfig, clientSnapshotId, listings, stripeAccountId, signal, deadlineAt, workerId }) => {
    w.mirrorCalls += 1;
    assert.equal(intentId, IID); assert.deepEqual(env, { VERCEL_ENV: "development", MV_E7_TEST_CLEANUP: "enabled", MV_E7_MIRROR_WORKER: "enabled" }); assert.equal(stripeAccountId, ACCT);
    assert.deepEqual([...listings.keys()], [606998]); assert.deepEqual(Object.keys(executors).sort(), [...MIRROR_KEYS].sort()); assert.ok(adapterConfig && adapterConfig.allowedListingIds);
    assert.deepEqual(recordingConfig, { accountRef: "hostaway-e7-test", channelId: 2000, currency: "USD", listingId: 606998, paymentMethod: "credit_card", refFieldId: C.refFieldId }); assert.equal(clientSnapshotId, RUN);
    assert.ok(signal instanceof AbortSignal && Number.isFinite(deadlineAt) && /^e7-hosted-rtc:/.test(workerId));
    assert.ok(w.settlement && w.settlement.reservationCancelled && w.settlement.authorizationSettled && !w.settlement.recordingMirrored, "the mirror worker is invoked ONLY once both legs are proven");
    const sig = AbortSignal.timeout(5000); const actions = []; const mirror = rowOf(w, MIR);
    const out = (extra = {}) => { w.signalAbortedAtEnd = signal.aborted; return { status: "worked", intentId: IID, actions, calls: [], sends: 0, mirrorSends: 0, stop: null, facts: null, delayMs: o.mirrorDelayMs ?? 30000, late: null, ...extra }; };
    const listReq = { method: "GET", path: "/v1/guestPayments/charges", query: { reservationId: RID, limit: 500 } };
    const postReq = { method: "POST", path: o.mirrorPath ?? MIRROR_PATH, query: o.mirrorQuery ?? {}, body: { title: o.mirrorTitle ?? MP.mirrorTitle(IID), amount: o.mirrorAmount ?? 140, isIncludeInPriceBreakdown: o.mirrorFlag ?? 0, ...(o.mirrorExtraBody ?? {}) } };
    try {
      if (o.mirrorWait) { actions.push("WAIT:FAKE"); return out(); }
      await executors.retrieveAccount({ signal: sig });
      await executors.retrievePaymentIntent(PI, { expand: ["latest_charge"] }, { signal: sig });
      if (o.afterMirrorPiRead) await o.afterMirrorPiRead();
      const rr = await executors.retrieveReservation({ method: "GET", path: `/v1/reservations/${RID}`, query: {} }, { signal: sig });
      if (rr.json.result.status !== "cancelled") { actions.push("ESCALATE:RESERVATION_NOT_CANCELLED"); w.status = "reconciliation_required"; w.version += 1; return out({ delayMs: 0 }); }
      if (o.foreignList) { try { await executors.listOfflineCharges({ method: "GET", path: "/v1/guestPayments/charges", query: { reservationId: C.protectedReservationIds[0], limit: 500 } }, { signal: sig }); } catch { actions.push("FOREIGN_LIST_REFUSED"); } }
      await executors.listOfflineCharges(listReq, { signal: sig });
      Object.assign(mirror, { state: "in_flight", attempts: 1, dispatched: true });                                  // the accepted worker claims the row BEFORE the send
      let reply = null;
      try { reply = await executors.refundOfflineCharge(postReq, { signal: sig }); }
      catch (e) { actions.push(`SEND_FAILED:${e && e.code ? e.code : "TRANSPORT"}`); }
      if (o.twiceMirror) { try { await executors.refundOfflineCharge(postReq, { signal: sig }); } catch { actions.push("SECOND_MIRROR_REFUSED"); } }
      if (!reply || reply.httpStatus !== 200) { mirror.state = "outcome_unknown"; actions.push("MIRROR_OUTCOME_UNKNOWN"); return out({ delayMs: 0 }); }
      const mid = String(reply.json.result.id);
      await executors.listOfflineCharges(listReq, { signal: sig });                                                  // the confirming LIST
      Object.assign(mirror, { state: o.mirrorRowStateAfter ?? "succeeded", result_ref: mid, settled_evidence: o.mirrorUnlinked ? false : true });
      w.ledger.push({ entry: "offline_charge_refund_recorded", amt: String(AMT), currency: "USD", provider_ref: mid }); w.evidence.push({ kind: "hostaway_offline_charges", external_ref: RID, status: "listed" });
      if (o.afterMirrorComplete) await o.afterMirrorComplete();
      if (o.deferEvent) { actions.push("MIRROR_COMPLETED", "COMPLETED:EVENT_DEFERRED"); return out({ delayMs: 0 }); }
      w.status = "cancelled"; w.version += 1; w.settlement = { reservationCancelled: true, authorizationSettled: true, recordingMirrored: true }; w.claimReleased = !o.keepClaim; w.endOk = o.endOk ?? true;
      actions.push("MIRROR_COMPLETED", "OFFLINE_CHARGE_REFUND_RECORDED->cancelled");
      return out({ delayMs: 0 });
    } catch (e) {
      actions.push(`STOP:EXECUTOR_${/stopped/.test(String(e && e.message)) ? "STOPPED" : "FAILED"}`);
      if (mirror && mirror.state === "in_flight") mirror.state = "outcome_unknown";
      return out({ delayMs: 0 });
    }
  };
}
/** TEST STAND-IN of the accepted bound mirror transport's call surface (used ONLY when lib/booking-db/mirror-transport.js cannot load without `pg`, i.e. the dependency-free preflight):
 *  the same exact bound-target fence → the same fetch call (url, { method, headers: { Authorization, Accept, Content-Type }, body, signal }) → { httpStatus, json }. */
function standInBoundTransport({ fetchImpl, baseUrl, bearer, binding }) {
  const title = `maraVilla refund mvochr1-${binding.intentId}`; const amount = Number(`${Math.floor(binding.amountMinor / 100)}.${String(binding.amountMinor % 100).padStart(2, "0")}`);
  const path = `/v1/guestPayments/charges/${binding.reservationId}/${binding.offlineChargeId}/refund`;
  let posts = 0; const err = (code) => Object.assign(new Error(code), { code });
  return Object.freeze({ binding: Object.freeze({ ...binding }), counts: () => Object.freeze({ gets: 0, posts }),
    retrieveReservation: async () => { throw err("REQUEST_TARGET_FORBIDDEN"); }, listOfflineCharges: async () => { throw err("REQUEST_TARGET_FORBIDDEN"); },
    refundOfflineCharge: async (req, { signal } = {}) => {
      if (!req || Object.keys(req).sort().join(",") !== "body,method,path,query") throw err("REQUEST_SHAPE_INVALID");
      if (req.method !== "POST") throw err("REQUEST_METHOD_INVALID");
      if (req.path !== path || !req.query || Object.keys(req.query).length !== 0) throw err("REQUEST_TARGET_FORBIDDEN");
      if (!req.body || Object.keys(req.body).sort().join(",") !== "amount,isIncludeInPriceBreakdown,title" || req.body.title !== title || req.body.amount !== amount || req.body.isIncludeInPriceBreakdown !== 0) throw err("REQUEST_BODY_FORBIDDEN");
      if (signal && signal.aborted) throw err("ABORTED");
      if (posts >= 1) throw err("MIRROR_WIRE_LIMIT");
      posts += 1;
      let res; try { res = await fetchImpl(`${baseUrl}${path}`, { method: "POST", headers: { Authorization: `Bearer ${bearer()}`, Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ title, amount, isIncludeInPriceBreakdown: 0 }), signal }); }
      catch { throw err(signal && signal.aborted ? "ABORTED" : "TRANSPORT_FAILED"); }
      let json = null; try { const t = await res.text(); json = t ? JSON.parse(t) : null; } catch { json = null; }
      return Object.freeze({ httpStatus: Number(res.status), json });
    } });
}
const boundTransport = MT ? MT.buildHostawayMirrorExecutors : standInBoundTransport;
const toolingFor = (w, o = {}) => ({ runTestCleanupStep: o.worker ?? fakeCleanupWorker(w, o), runMirrorStep: o.mirrorWorker ?? fakeMirrorWorker(w, o), requestRecordedTestCleanup: o.request ?? fakeRequest(w, o),
  loadIntent: async () => intentOf(w), createTestCleanupExecutors: EX.createTestCleanupExecutors, buildHostawayMirrorExecutors: o.boundTransport ?? boundTransport, createStripeSend: TT.createE7StripeTestCleanupSend,
  createHostawaySend: T.createE7HostawaySend, validateAdapterConfig: HR.validateAdapterConfig, unwrapEnvelope: HR.unwrapEnvelope, normalizeReservation: HR.normalizeReservation,
  activeReservationProof: CO.activeReservationProof, paymentIntentProofObservationV3: CP.paymentIntentProofObservationV3, piIdentityOk: RP.piIdentityOk, rawPiPreSendRefusal: TP.rawPiPreSendRefusal,
  refundObservation: TP.refundObservation, arrivalStrictlyFuture: CO.arrivalStrictlyFuture, refundKey: IS.refundKey, publicStatus: IS.publicStatus, mirrorTitle: MP.mirrorTitle, classifyTitle: OP.classifyTitle,
  classifyMirrorTitle: MP.classifyMirrorTitle, providerIdToCanonical: OP.providerIdToCanonical, amountToMinor: HR.amountToMinor, LOCK_KEY: LK.LOCK_KEY, LOCK_PRECHECK_SQL: LK.LOCK_PRECHECK_SQL });
function core(w, o = {}) {
  const pool = o.pool ?? fakePool(w, o); w.pool = pool;
  const x = exchanges(w, o);
  const b = o.built ?? built();
  return E.runRecordedCleanupCore({ plan: b.plan, planHash: o.planHash ?? b.planHash, runId: o.runId ?? RUN, pool, lockClientFactory: () => pool.lock(), tooling: { ...toolingFor(w, o), ...(o.toolingOver ?? {}) },
    exchanges: o.wrapExchanges ? o.wrapExchanges(x) : x, credentials: { stripe: () => "sk_test_Fake1", hostaway: () => "synthetic-hostaway-token" }, sleep: async () => {}, runSignal: o.signal, monotonic: o.monotonic,
    clock: () => (o.clockBase ?? Date.UTC(2026, 10, 12, 16, 0, 0)) + (w.tick = (w.tick ?? 0) + 1000) });
}
const posts = (w) => w.calls.filter((x) => /^(S:POST|H:POST|H:PUT|H:DELETE|S:DELETE)/.test(x));
const CANCEL_URL = `H:PUT /v1/reservations/${RID}/statuses/cancelled`; const REFUND_URL = "S:POST /v1/refunds"; const MIRROR_URL = `H:POST ${MIRROR_PATH}`;
const HAPPY_POSTS = [CANCEL_URL, REFUND_URL, MIRROR_URL];

// ---------------------------------------------------------------------------------------------------------------------------------
test("A1 happy path (FAKE DB / request / workers, REAL transports + executors + proofs + bound mirror transport when loadable): account + strict unrefunded PI proof + active reservation (ref echoed) + complete LIST, lock proven before the request and before EVERY step, ONE request, exactly ONE cancel PUT then ONE refund POST then ONE mirror POST (exact URLs / bodies / headers), readbacks, cancelled / not_completed_refunded, lock released, counted teardown", async () => {
  const w = world();
  const r = await core(w);
  assert.equal(r.outcome, "RECORDED_CLEANUP_COMPLETED", JSON.stringify(r));
  assert.deepEqual(posts(w), HAPPY_POSTS, "cancel → refund → mirror, nothing else");
  assert.deepEqual([r.requestInvocations, r.requestOutcome, r.steps, r.cleanupSteps, r.mirrorSteps, r.cancelInvocations, r.cancelOutcome, r.refundInvocations, r.refundOutcome, r.mirrorInvocations, r.mirrorOutcome, r.mirrorTransportPosts],
    [1, "REPLIED", 3, 2, 1, 1, "REPLIED", 1, "REPLIED", 1, "REPLIED", 1]);
  assert.deepEqual([r.finalState, r.publicStatus, r.reservationId, r.capturedMinor, r.chargeId, r.offlineChargeId, r.refundId, r.mirrorRefundId, r.clientSnapshotId, r.lock, w.unlocked, w.lockReleased],
    ["cancelled", "not_completed_refunded", RID, AMT, CH, OCH, RE, MID, RUN, "released", 1, "pooled"]);
  assert.deepEqual(r.proofs, ["PROVIDER_BEFORE_REQUEST", "BEFORE_REQUEST", "BEFORE_WORKER", "BEFORE_STEP_2", "BEFORE_STEP_3", "BEFORE_READBACK", "READBACK"]);
  assert.deepEqual(r.legs, { reservationCancelled: true, authorizationSettled: true, recordingMirrored: true }); assert.deepEqual([r.recordingLinked, r.notifySuppressed, r.claimHeld, r.endOk], [true, true, false, true]);
  assert.deepEqual(r.writes, { request: 1, cancel: 1, refund: 1, mirror: 1, capture: 0, create: 0, record: 0, notify: 0, void: 0 });
  assert.deepEqual(r.postcheck, { cancelOps: 1, refundOps: 1, mirrorOps: 1, refundRecord: "succeeded", refundId: RE, mirrorRefundId: MID, offlineChargeId: OCH, capturedMinor: AMT, recordingLinked: true, notifySuppressed: true,
    claimReleased: true, openCases: 0, legs: { reservationCancelled: true, authorizationSettled: true, recordingMirrored: true }, endOk: true, publicStatus: "not_completed_refunded" });
  assert.ok(r.actions.includes("C:RESERVATION_CANCELLED->test_cleanup_pending") && r.actions.includes("C:REFUND_SUCCEEDED->test_cleanup_pending") && r.actions.includes("M:OFFLINE_CHARGE_REFUND_RECORDED->cancelled"), JSON.stringify(r.actions));
  assert.ok(w.calls.filter((x) => x === `H:GET ${LIST_PATH}`).length >= 4, "runner pre-request LIST + worker pre-send LIST + worker confirming LIST + runner readback LIST");
  assert.equal(JSON.stringify(r).includes("synthetic-hostaway-token"), false); assert.equal(JSON.stringify(r).includes("sk_test_Fake1"), false);
  assert.ok(r.dbTeardownQueries > 0 && r.dbTeardownQueries <= C.budgets.dbTeardownReserve && r.dbQueries <= C.budgets.dbQueries, `teardown ${r.dbTeardownQueries} / total ${r.dbQueries}`);
  assert.equal(w.cleanupCalls, 2); assert.equal(w.mirrorCalls, 1); assert.equal(w.requestCalls, 1);
});

test("A2 strict provider proofs gate the request: partly refunded / wrong account / PI identity / cancelled reservation / ref NOT echoed / 401 / LIST (linked refund, untyped link, mirror-marker lookalike, same-amount refund, original changed / missing / duplicate, foreign row, incomplete page) → PROVIDER_PROOF_FAILED with ZERO request, ZERO worker, ZERO writes", async () => {
  const cases = [
    [{ prePiMutate: (pi) => ({ ...pi, latest_charge: { ...pi.latest_charge, amount_refunded: 1 } }) }, "CHARGE_ALREADY_REFUNDED"],
    [{ otherAccount: true }, "READ_FAILED"],                                                                     // the accepted Stripe transport refuses the account mismatch itself
    [{ prePiMutate: (pi) => ({ ...pi, metadata: { ...pi.metadata, mv_intent_id: "22222222-2222-4333-8444-555555555555" } }) }, "PAYMENT_INTENT_IDENTITY"],
    [{ preResMutate: (o) => ({ ...o, status: "cancelled" }) }, "RESERVATION_BY_ID_RESERVATION_NOT_ACTIVE"],
    [{ echoRef: false }, "REF_NOT_ECHOED"],
    [{ preResMutate: (o) => ({ ...o, totalPrice: 150 }) }, "RESERVATION_BY_ID_RESERVATION_IDENTITY"],
    [{ hostawayStatus: 401 }, "RESERVATION_READ_401"],
    [{ preListMutate: (rows) => [...rows, mirrorRow({ title: "some other refund" })] }, "LIST_MIRROR_ALREADY_LINKED"],
    [{ preListMutate: (rows) => [...rows, mirrorRow({ title: "other", refundInfo: undefined })] }, "LIST_MIRROR_DISCOVERY_AMBIGUOUS"],
    [{ preListMutate: (rows) => [...rows, { ...rows[0], id: 520009, title: MP.mirrorTitle(IID).replace("mvochr1", "mvochr1​"), amount: 1 }] }, "LIST_MIRROR_MARKER_PRESENT"],
    [{ preListMutate: (rows) => [...rows, mirrorRow({ title: "other", refundInfo: { id: 1, chargeId: 520010, refundedChargeId: 520011 }, id: 520010 })] }, "LIST_MIRROR_AMOUNT_PRESENT"],
    [{ preListMutate: (rows) => [{ ...rows[0], amount: 141 }] }, "LIST_ORIGINAL_CHANGED"],
    [{ preListMutate: () => [] }, "LIST_ORIGINAL_MISSING"],
    [{ preListMutate: (rows) => [rows[0], { ...rows[0], id: 520012 }] }, "LIST_ORIGINAL_DUPLICATE"],
    [{ preListMutate: (rows) => [rows[0], { ...rows[0], id: 520013, title: "x", reservationId: 71999902 }] }, "LIST_LIST_FOREIGN_RESERVATION_ROW"],
    [{ preListMutate: (rows) => [{ ...rows[0], id: 520014, title: "x" }, rows[0]] }, null]
  ];
  for (const [o, code] of cases) {
    const w = world({ echoRef: o.echoRef ?? true }); const r = await core(w, o);
    if (code === null) { assert.equal(r.outcome, "RECORDED_CLEANUP_COMPLETED", "control: an unrelated extra paid row is not a refusal"); continue; }
    assert.deepEqual([r.outcome, r.code], ["PROVIDER_PROOF_FAILED", code], JSON.stringify(r));
    assert.deepEqual([w.requestCalls, w.cleanupCalls, w.mirrorCalls, posts(w).length, r.requestInvocations, r.steps], [0, 0, 0, 0, 0, 0], code);
    assert.deepEqual(r.writes, { request: 0, cancel: 0, refund: 0, mirror: 0, capture: 0, create: 0, record: 0, notify: 0, void: 0 });
  }
});

test("A3 start refusals (read-only, ZERO provider calls, ZERO lock, ZERO request): state / version / pins (PI, reservation, Stripe charge, original offline charge, amount, stay, session, attempt) / historic / protected / open case / forbidden op / recording not linked or retired / notification rendered, latched, suppressed, missing / cancel, refund or mirror row present / refund present / lease / work lease / claim / settlement / hold / non-TEST / schema prerequisite (0019 / 0020 / 0021) missing", async () => {
  const cases = [
    [(w) => { w.status = "payment_captured"; }, {}, "START_STATE_NOT_ELIGIBLE", "STATE_NOT_CONFIRMED"],
    [(w) => { w.status = "test_cleanup_pending"; }, {}, "START_STATE_NOT_ELIGIBLE", "STATE_NOT_CONFIRMED"],
    [(w) => { w.version = VER + 1; }, {}, "START_STATE_NOT_ELIGIBLE", "VERSION_NOT_PINNED"],
    [(w) => { w.createdAt = Date.parse(NB) - 1; }, {}, "START_STATE_NOT_ELIGIBLE", "HISTORIC_INTENT"],
    [() => {}, { built: built({ paymentIntentId: "pi_FAKEother00000001" }) }, "SCOPE_REFUSED", "PAYMENT_INTENT_NOT_PINNED"],
    [() => {}, { built: built({ reservationId: "71999902" }) }, "SCOPE_REFUSED", "RESERVATION_NOT_PINNED"],
    [() => {}, { built: built({ chargeId: "ch_FAKEother00000001" }) }, "SCOPE_REFUSED", "CAPTURE_ROW_NOT_BOUND"],
    [() => {}, { built: built({ offlineChargeId: "520002" }) }, "SCOPE_REFUSED", "OFFLINE_CHARGE_NOT_PINNED"],
    [(w) => { w.offlineChargeId = null; }, {}, "SCOPE_REFUSED", "OFFLINE_CHARGE_NOT_PINNED"],
    [() => {}, { built: built({ capturedMinor: AMT + 1 }) }, "SCOPE_REFUSED", "AMOUNT_NOT_PINNED"],
    [() => {}, { built: built({ from: "2026-11-24" }) }, "SCOPE_REFUSED", "STAY_NOT_PINNED"],
    [() => {}, { built: built({ sessionId: "cs_test_FAKEother0001" }) }, "SCOPE_REFUSED", "SESSION_NOT_PINNED"],
    [() => {}, { built: built({ attemptId: "aaaaaaaa-bbbb-4ccc-8ddd-000000000000" }) }, "SCOPE_REFUSED", "PAYMENT_ATTEMPT_NOT_BOUND"],
    [(w) => { w.res = C.protectedReservationIds[0]; w.hx[0].rid = C.protectedReservationIds[0]; }, {}, "SCOPE_REFUSED", "RESERVATION_NOT_PINNED"],
    [() => {}, { cases: 1 }, "SCOPE_REFUSED", "OPEN_CASE"],
    [(w) => { w.ops.push(op("stripe.void_payment_intent")); }, {}, "SCOPE_REFUSED", "FORBIDDEN_OP_PRESENT"],
    [(w) => { rowOf(w, REC).settled_evidence = false; }, {}, "START_STATE_NOT_ELIGIBLE", "RECORDING_NOT_PROVEN_LINKED"],
    [(w) => { rowOf(w, REC).state = "superseded"; }, {}, "START_STATE_NOT_ELIGIBLE", "RECORDING_NOT_PROVEN_LINKED"],
    [(w) => { rowOf(w, REC).result_ref = "520099"; }, {}, "START_STATE_NOT_ELIGIBLE", "RECORDING_NOT_PROVEN_LINKED"],
    [(w) => { rowOf(w, REC).idempotency_key = `och:${IID}:2`; }, {}, "SCOPE_REFUSED", "RECORDING_ROW_NOT_BOUND"],
    [(w) => { w.notify.renders = 1; }, {}, "START_STATE_NOT_ELIGIBLE", "NOTIFY_NOT_PRISTINE"],
    [(w) => { w.notify.latches = 1; }, {}, "START_STATE_NOT_ELIGIBLE", "NOTIFY_NOT_PRISTINE"],
    [(w) => { w.notify.suppressions = 1; }, {}, "START_STATE_NOT_ELIGIBLE", "NOTIFY_NOT_PRISTINE"],
    [(w) => { rowOf(w, NOT).attempts = 1; rowOf(w, NOT).dispatched = true; }, {}, "START_STATE_NOT_ELIGIBLE", "NOTIFY_NOT_PRISTINE"],
    [(w) => { rowOf(w, NOT).state = "superseded"; }, {}, "START_STATE_NOT_ELIGIBLE", "NOTIFY_NOT_PRISTINE"],
    [(w) => { w.ops = w.ops.filter((x) => x.op_type !== NOT); }, {}, "START_STATE_NOT_ELIGIBLE", "NOTIFY_NOT_SINGLE"],
    [(w) => { w.ops.push(op(CAN, { state: "pending", attempts: 0, dispatched: false })); }, {}, "SCOPE_REFUSED", "UNEXPECTED_OP"],
    [(w) => { w.ops.push(mirrorOp()); }, {}, "SCOPE_REFUSED", "UNEXPECTED_OP"],
    [(w) => { w.refunds.push({ seq: 1, idempotency_key: KEY, state: "requested", hostaway_state: "not_applicable", amt: String(AMT), currency: "USD", stripe_refund_id: null }); }, {}, "SCOPE_REFUSED", "REFUND_PRESENT"],
    [(w) => { w.lease = { workerId: "x" }; }, {}, "START_STATE_NOT_ELIGIBLE", "RESERVATION_LEASE_HELD"],
    [(w) => { w.workLeased = true; }, {}, "START_STATE_NOT_ELIGIBLE", "WORK_LEASE_HELD"],
    [(w) => { w.claimReleased = true; }, {}, "SCOPE_REFUSED", "CLAIM_NOT_HELD"],
    [(w) => { w.settlement = { reservationCancelled: true, authorizationSettled: false, recordingMirrored: false }; }, {}, "START_STATE_NOT_ELIGIBLE", "SETTLEMENT_PRESENT"],
    [(w) => { w.holds = 1; }, {}, "START_STATE_NOT_ELIGIBLE", "RECORDING_HOLD_PRESENT"],
    [(w) => { w.offlineChargeAttempts = 1; }, {}, "START_STATE_NOT_ELIGIBLE", "HISTORY_NOT_RECORDED"],                       // a FAILED recording attempt in the history (the accepted request refuses it too)
    [(w) => { w.ledger = w.ledger.filter((l) => l.entry !== "offline_charge_recorded"); }, {}, "SCOPE_REFUSED", "RECORDING_NOT_LEDGERED"],
    [(w) => { w.evidence = w.evidence.filter((x) => x.kind !== "hostaway_offline_charges"); }, {}, "SCOPE_REFUSED", "RECORDING_EVIDENCE_MISSING"],
    [() => {}, { env: "production" }, "SCOPE_REFUSED", "DATABASE_NOT_TEST"],
    [(w) => { w.schema.f0021_proof = false; }, {}, "SCHEMA_PREREQUISITE_MISSING", "SCHEMA_PREREQUISITE_MISSING"],
    [(w) => { w.schema.mirrored_column = false; }, {}, "SCHEMA_PREREQUISITE_MISSING", "SCHEMA_PREREQUISITE_MISSING"],
    [(w) => { w.schema.f0020 = false; }, {}, "SCHEMA_PREREQUISITE_MISSING", "SCHEMA_PREREQUISITE_MISSING"]
  ];
  for (const [mutate, o, outcome, code] of cases) {
    const w = world(); mutate(w);
    const r = await core(w, o);
    assert.deepEqual([r.outcome, r.code], [outcome, code], JSON.stringify(r));
    assert.deepEqual([w.calls.length, w.requestCalls, w.cleanupCalls, w.mirrorCalls, r.lock, r.requestInvocations, r.steps], [0, 0, 0, 0, "not_acquired", 0, 0], code);
    assert.equal(r.startState, w.status);
  }
});

test("A4 real lock semantics: held elsewhere → LOCK_NOT_ACQUIRED, zero provider calls, zero request; lost at the pre-request proof → LOCK_LOST with ZERO request; lost before step 2 → after the cancel, ZERO refund; lost before step 3 → after the refund, ZERO mirror POST; backend hop refused; observed session error mid-step vetoes the mirror", async () => {
  { const w = world(); const r = await core(w, { lockHeldElsewhere: true });
    assert.deepEqual([r.outcome, r.code, w.calls.length, w.requestCalls, r.lock], ["LOCK_NOT_ACQUIRED", "RUN_LOCK_PRESENT", 0, 0, "not_acquired"]); }
  { const w = world(); const r = await core(w, { lockLostAtProof: 2 });                                            // proof 1 = acquisition, proof 2 = BEFORE_REQUEST
    assert.deepEqual([r.outcome, r.code, w.requestCalls, posts(w).length, r.proofs, w.lockReleased], ["LOCK_LOST", "LOCK_NOT_HELD", 0, 0, ["PROVIDER_BEFORE_REQUEST"], "pooled"], JSON.stringify(r)); }
  { const w = world(); const r = await core(w, { lockLostAt: 1 });
    assert.deepEqual([r.outcome, r.code, w.requestCalls, posts(w), r.cancelInvocations, r.refundInvocations, r.mirrorInvocations, r.finalState], ["LOCK_LOST", "LOCK_NOT_HELD", 1, [CANCEL_URL], 1, 0, 0, "test_cleanup_pending"], JSON.stringify(r)); }
  { const w = world(); const r = await core(w, { lockLostAt: 2 });
    assert.deepEqual([r.outcome, r.code, posts(w), r.refundInvocations, r.mirrorInvocations, w.mirrorCalls, r.finalState], ["LOCK_LOST", "LOCK_NOT_HELD", [CANCEL_URL, REFUND_URL], 1, 0, 0, "test_cleanup_pending"], JSON.stringify(r));
    assert.deepEqual(r.legs, { reservationCancelled: true, authorizationSettled: true, recordingMirrored: false }); assert.deepEqual(r.mirrorOps, ["pending"]); }
  { const w = world(); const r = await core(w, { hopAtProof: 2 });
    assert.deepEqual([r.outcome, r.code, w.requestCalls, posts(w).length], ["LOCK_LOST", "BACKEND_HOP", 0, 0], JSON.stringify(r)); }
  { const w = world(); const r = await core(w, { afterMirrorPiRead: async () => { w.lockClient.errorFn(new Error("connection terminated")); } });
    assert.deepEqual([r.outcome, r.code, r.lockSession, r.lock, posts(w), r.mirrorInvocations, w.lockReleased], ["LOCK_LOST", "STOP_LOCK_SESSION_ERROR", "error_observed", "session_error_connection_destroyed", [CANCEL_URL, REFUND_URL], 0, "destroyed"], JSON.stringify(r));
    assert.ok(r.actions.some((a) => /^M:STOP:EXECUTOR_STOPPED/.test(a)), JSON.stringify(r.actions)); assert.equal(w.signalAbortedAtEnd, true, "the worker's own signal was aborted synchronously"); }
});

test("A5 v1 uncertainty: lost cancel reply → WRITE_OUTCOME_UNKNOWN / LOST_CANCEL_REPLY (ONE PUT, zero refund / mirror); lost refund reply → LOST_REFUND_REPLY (ONE POST, zero mirror); lost MIRROR reply → LOST_MIRROR_REPLY with exactly ONE mirror POST, NO confirming read / completion, facts reported; a SECOND SESSION refuses read-only with ZERO sends; a second mirror POST in the same step never leaves the process", async () => {
  { const w = world(); const r = await core(w, { cancelLost: true });
    assert.deepEqual([r.outcome, r.code, r.cancelInvocations, r.cancelOutcome, r.refundInvocations, r.mirrorInvocations, posts(w), r.factsObserved, r.cancelOps], ["WRITE_OUTCOME_UNKNOWN", "LOST_CANCEL_REPLY", 1, "UNKNOWN", 0, 0, [CANCEL_URL], true, ["outcome_unknown"]], JSON.stringify(r));
    const w2 = { ...w, calls: [] }; const r2 = await core(w2); assert.deepEqual([r2.outcome, r2.code, w2.calls.length, r2.requestInvocations], ["START_STATE_NOT_ELIGIBLE", "STATE_NOT_CONFIRMED", 0, 0]); }
  { const w = world(); const r = await core(w, { refundLost: true });
    assert.deepEqual([r.outcome, r.code, r.refundInvocations, r.refundOutcome, r.mirrorInvocations, posts(w), r.refundOps, r.mirrorOps], ["WRITE_OUTCOME_UNKNOWN", "LOST_REFUND_REPLY", 1, "UNKNOWN", 0, [CANCEL_URL, REFUND_URL], ["outcome_unknown"], []], JSON.stringify(r)); }
  for (const landed of [false, true]) {
    const w = world(); const r = await core(w, { mirrorLost: true, mirrorLandedAnyway: landed });
    assert.deepEqual([r.outcome, r.code, r.mirrorInvocations, r.mirrorOutcome, r.mirrorTransportPosts, posts(w), w.mirrorRequests, r.mirrorOps, r.finalState, r.claimHeld], ["WRITE_OUTCOME_UNKNOWN", "LOST_MIRROR_REPLY", 1, "UNKNOWN", 1, HAPPY_POSTS, 1, ["outcome_unknown"], "test_cleanup_pending", true], JSON.stringify(r));
    assert.equal(w.calls.filter((x) => x === `H:GET ${LIST_PATH}`).length, 2, "runner pre-request LIST + worker pre-send LIST; NO confirming read after the lost reply");
    assert.ok(r.actions.includes("M:MIRROR_OUTCOME_UNKNOWN") && !r.actions.includes("M:MIRROR_COMPLETED"), JSON.stringify(r.actions));
    const w2 = { ...w, calls: [] }; const r2 = await core(w2); assert.deepEqual([r2.outcome, w2.calls.length, w2.mirrorRequests], ["START_STATE_NOT_ELIGIBLE", 0, 1], "a second session: read-only refusal, zero resend");
  }
  { const w = world(); const r = await core(w, { twiceMirror: true });
    assert.deepEqual([r.outcome, posts(w), r.mirrorInvocations, w.mirrorRequests, r.refusedAtTransport], ["RECORDED_CLEANUP_COMPLETED", HAPPY_POSTS, 1, 1, 1], JSON.stringify(r));
    assert.ok(r.actions.includes("M:SECOND_MIRROR_REFUSED"), JSON.stringify(r.actions)); }
});

test("A6 target-only fence: a mirror POST with another amount / title / breakdown flag / extra body field / other path / non-empty query, a mirror before the cancel + refund were exchanged (ORDER), a foreign reservation read, a foreign LIST, a Hostaway POST to the recording path, a Stripe capture / void / cancel op, a wrong refund amount / key / metadata — none leaves the process", async () => {
  for (const [o, tag] of [[{ mirrorAmount: 141 }, "amount"], [{ mirrorTitle: MP.mirrorTitle("22222222-2222-4333-8444-555555555555") }, "title"], [{ mirrorFlag: 1 }, "flag"], [{ mirrorExtraBody: { note: "x" } }, "extra"],
    [{ mirrorPath: `/v1/guestPayments/charges/${RID}/520002/refund` }, "path"], [{ mirrorQuery: { force: 1 } }, "query"]]) {
    const w = world(); const r = await core(w, o);
    assert.deepEqual([r.outcome, r.code, posts(w), r.mirrorInvocations, w.mirrorRequests ?? 0, r.mirrorTransportPosts], ["WRITE_OUTCOME_UNKNOWN", "WORKER_SETTLED_UNKNOWN", [CANCEL_URL, REFUND_URL], o.mirrorPath ? 0 : 1, 0, o.mirrorPath ? null : 0], `${tag}: ${JSON.stringify(r)}`);
    assert.ok(r.actions.some((a) => /^M:SEND_FAILED:/.test(a)), tag); assert.equal(r.mirrorOutcome, o.mirrorPath ? "NONE" : "NOT_SENT", tag);
  }
  { const w = world(); const r = await core(w, { legsWithoutSends: true });                                    // the DB says both legs are proven but THIS session exchanged no cancel / refund: ORDER fence
    assert.deepEqual([r.outcome, r.code, posts(w).length, r.mirrorInvocations, w.mirrorRequests ?? 0, r.refusedAtTransport], ["WRITE_OUTCOME_UNKNOWN", "WORKER_SETTLED_UNKNOWN", 0, 0, 0, 1], JSON.stringify(r)); }
  { const w = world(); const r = await core(w, { foreignRead: true });
    assert.deepEqual([posts(w).length, w.calls.filter((x) => x.includes(C.protectedReservationIds[0])).length], [0, 0], JSON.stringify(r)); assert.notEqual(r.outcome, "RECORDED_CLEANUP_COMPLETED"); }
  { const w = world(); const r = await core(w, { foreignList: true });
    assert.deepEqual([r.outcome, w.calls.filter((x) => x.includes(C.protectedReservationIds[0])).length, r.refusedAtTransport], ["RECORDED_CLEANUP_COMPLETED", 0, 1], JSON.stringify(r)); assert.ok(r.actions.includes("M:FOREIGN_LIST_REFUSED")); }
  // a request the accepted transports / executors would never build: the fence refuses it in-process (direct probes against the composed executors are covered by the worker fakes above);
  // the Stripe gate refuses any non-read op and the Hostaway gate any other write
  { const w = world(); let gateRefused = 0;
    const r = await core(w, { wrapExchanges: (x) => ({ stripe: x.stripe, hostaway: async (req) => { if (req.method === "POST" && req.url.endsWith(`/v1/guestPayments/charges/${RID}`)) { gateRefused += 1; throw new Error("must not reach"); } return x.hostaway(req); } }) });
    assert.deepEqual([r.outcome, gateRefused, posts(w)], ["RECORDED_CLEANUP_COMPLETED", 0, HAPPY_POSTS]); }
  for (const o of [{ wrongAmount: AMT + 1 }, { wrongKey: `ref:${IID}:2` }, { wrongOp: "11111111-1111-4111-8111-111111111111" }]) {
    const w = world(); const r = await core(w, o);
    assert.deepEqual([r.outcome, posts(w), w.refundRequests ?? 0, r.mirrorInvocations], ["WRITE_OUTCOME_UNKNOWN", [CANCEL_URL], 0, 0], JSON.stringify(o));
  }
});

test("A7 stop latch: aborted before start → no lock, no provider call, no request; aborted as the mirror worker's PI read resolves → no mirror POST, STOP_ABORTED; deadline between steps → DEADLINE after the refund with ZERO mirror; a worker that only waits → STEP_BUDGET_EXHAUSTED at 24 with ZERO writes; a mirror worker that completes but defers its event under a stop → the session stops without success", async () => {
  { const ac = new AbortController(); ac.abort(); const w = world(); const r = await core(w, { signal: ac.signal });
    assert.deepEqual([r.outcome, r.code, w.calls.length, w.requestCalls, r.lock], ["ABORTED", "STOP_ABORTED", 0, 0, "not_acquired"], JSON.stringify(r)); }
  { const ac = new AbortController(); const w = world(); const r = await core(w, { signal: ac.signal, afterMirrorPiRead: async () => ac.abort() });
    assert.deepEqual([r.outcome, r.code, posts(w), r.mirrorInvocations, w.mirrorRequests ?? 0, r.finalState, r.mirrorOps], ["ABORTED", "STOP_ABORTED", [CANCEL_URL, REFUND_URL], 0, 0, "test_cleanup_pending", ["pending"]], JSON.stringify(r));
    assert.equal(w.signalAbortedAtEnd, true); }
  { const w = world(); let m = 0; const r = await core(w, { monotonic: () => (w.refundRequests ? 20 * 60 * 1000 + 1 : (m += 1)) });
    assert.deepEqual([r.outcome, r.code, posts(w), r.mirrorInvocations], ["DEADLINE", "STOP_DEADLINE", [CANCEL_URL, REFUND_URL], 0], JSON.stringify(r)); }
  { const w = world(); const r = await core(w, { wait: true });
    assert.deepEqual([r.outcome, r.code, r.steps, r.cleanupSteps, posts(w).length, w.cleanupCalls], ["STEP_BUDGET_EXHAUSTED", "STEPS", 24, 24, 0, 24], JSON.stringify(r)); }
  { const w = world(); const r = await core(w, { mirrorWait: true });
    assert.deepEqual([r.outcome, r.code, r.steps, r.cleanupSteps, r.mirrorSteps, posts(w), r.mirrorOps], ["STEP_BUDGET_EXHAUSTED", "STEPS", 24, 2, 22, [CANCEL_URL, REFUND_URL], ["pending"]], JSON.stringify(r)); }
  { const ac = new AbortController(); const w = world(); const r = await core(w, { signal: ac.signal, deferEvent: true, afterMirrorComplete: async () => ac.abort() });
    assert.deepEqual([r.outcome, r.code, posts(w), r.mirrorInvocations, r.mirrorOps, r.finalState, r.claimHeld], ["ABORTED", "STOP_ABORTED", HAPPY_POSTS, 1, ["succeeded"], "test_cleanup_pending", true], JSON.stringify(r));
    assert.ok(r.actions.includes("M:COMPLETED:EVENT_DEFERRED"), JSON.stringify(r.actions)); }
});

test("A8 DB failure during the start read → DB_ERROR, nothing sent, no lock, no request", async () => {
  const w = world(); const r = await core(w, { dbFailAt: 3 });
  assert.deepEqual([r.outcome, r.code, w.calls.length, w.requestCalls, r.lock], ["DB_ERROR", "START_READ_FAILED", 0, 0, "not_acquired"]);
});

test("A9 the ONE request: refused → REQUEST_REFUSED with the accepted code, ZERO worker, ZERO writes; a throw → REQUEST_OUTCOME_UNKNOWN / REQUEST_THREW, facts observed, NEVER repeated, ZERO worker; a lineage that is not exactly ONE suppressed notification + ONE pristine cancel + ONE bound refund + the recording still linked + ZERO mirror rows → LINEAGE_MISMATCH, ZERO worker", async () => {
  { const w = world(); const r = await core(w, { requestRefuse: "TEST_CLEANUP_NOTIFY_NOT_PRISTINE" });
    assert.deepEqual([r.outcome, r.code, w.requestCalls, w.cleanupCalls, posts(w).length, r.finalState], ["REQUEST_REFUSED", "TEST_CLEANUP_NOTIFY_NOT_PRISTINE", 1, 0, 0, "confirmed"], JSON.stringify(r)); }
  for (const applied of [false, true]) {
    const w = world(); const r = await core(w, { requestThrow: true, requestAppliedAnyway: applied });
    assert.deepEqual([r.outcome, r.code, r.requestInvocations, r.requestOutcome, w.requestCalls, w.cleanupCalls, posts(w).length, r.factsObserved, r.finalState], ["REQUEST_OUTCOME_UNKNOWN", "REQUEST_THREW", 1, "UNKNOWN", 1, 0, 0, true, applied ? "test_cleanup_pending" : "confirmed"], JSON.stringify(r));
  }
  for (const [o, code] of [[{ keepNotify: true }, "NOTIFY_NOT_SUPPRESSED"], [{ retireRecording: true }, "RECORDING_NOT_PROVEN_LINKED"], [{ prematureMirror: true }, "MIRROR_ROW_PREMATURE"], [{ extraOp: true }, "FORBIDDEN_OP_PRESENT"],
    [{ refundKey: `ref:${IID}:2` }, "REFUND_ROW_NOT_BOUND"], [{ refundOpId: "not-a-uuid" }, "REFUND_ROW_NOT_BOUND"]]) {
    const w = world(); const r = await core(w, o);
    assert.deepEqual([r.outcome, r.code, w.cleanupCalls, w.mirrorCalls, posts(w).length], ["LINEAGE_MISMATCH", code, 0, 0, 0], JSON.stringify(r));
  }
});

test("A10 postcheck + readbacks + residual agreement: a mirror worker that claims cancelled with an unlinked mirror row / a held claim / endOk false → POSTCHECK_MISMATCH; a reservation readback with another ref / a LIST readback without the linked row, with another id, with a partial amount or a lookalike → POSTCHECK_MISMATCH; a contradiction seen ONLY by the teardown residual read → NOT_CONFIRMED / RESIDUAL_<code>; unlock false → NOT_CONFIRMED / UNLOCK_NOT_PROVEN; escalation → CLEANUP_ESCALATED; missing / premature mirror row → CLEANUP_UNKNOWN_STATE / LINEAGE_MISMATCH", async () => {
  for (const [o, code] of [[{ mirrorUnlinked: true }, "MIRROR_OP_NOT_SINGLE_SUCCEEDED"], [{ keepClaim: true }, "CLAIM_NOT_RELEASED"], [{ endOk: false }, "END_PREDICATE_NOT_PROVEN"], [{ mirrorRowStateAfter: "pending" }, "MIRROR_OP_NOT_SINGLE_SUCCEEDED"],
    [{ finalResMutate: (o2) => ({ ...o2, customFieldValues: [{ customFieldId: C.refFieldId, value: "MV-OTHER0001" }] }) }, "RESERVATION_REF"],
    [{ finalResMutate: (o2) => ({ ...o2, totalPrice: 150 }) }, "RESERVATION_TOTAL"],
    [{ finalListMutate: (rows) => rows.filter((x) => x.type !== "refund") }, "READBACK_LINKED_ROW_MISSING"],
    [{ finalListMutate: (rows) => rows.map((x) => (x.type === "refund" ? { ...x, id: 520778, refundInfo: { ...x.refundInfo, chargeId: 520778 } } : x)) }, "READBACK_LINKED_ROW_NOT_THE_RESULT"],
    [{ finalListMutate: (rows) => rows.map((x) => (x.type === "refund" ? { ...x, amount: -20 } : x)) }, "READBACK_MIRROR_ROW_AMOUNT"],
    [{ finalListMutate: (rows) => [...rows, { ...rows[0], id: 520779, title: MP.mirrorTitle(IID).toUpperCase(), amount: 1 }] }, "READBACK_MIRROR_TITLE_NOT_UNIQUE_EXACT"],
    [{ finalListMutate: (rows) => [...rows, mirrorRow({ id: 520780, title: "other", refundInfo: { id: 1, chargeId: 520780, refundedChargeId: Number(OCH) } })] }, "READBACK_LINKED_ROW_DUPLICATE"],
    [{ finalListMutate: (rows) => rows.map((x) => (x.type === "charge" ? { ...x, amount: 141 } : x)) }, "READBACK_ORIGINAL_CHANGED"],
    [{ finalPiMutate: (pi) => ({ ...pi, latest_charge: { ...pi.latest_charge, amount_refunded: 1 } }) }, "PI_READBACK_CHARGE_NOT_FULLY_REFUNDED"]]) {
    const w = world(); const r = await core(w, o);
    assert.deepEqual([r.outcome, r.code, posts(w)], ["POSTCHECK_MISMATCH", code, HAPPY_POSTS], JSON.stringify(r)); assert.equal(r.postcheck, null);
  }
  { const w = world(); let teardownReads = 0;
    const pool = fakePool(w); const q = pool.query.bind(pool);
    pool.query = async (sql) => { const res = await q(sql); if (/e7hrt:claims/.test(sql) && w.status === "cancelled") { teardownReads += 1; if (teardownReads >= 3) res.rows[0].released = false; } return res; };   // post-success claims reads: step readback, postcheck, then the teardown residual read
    const r = await core(w, { pool });
    assert.deepEqual([r.outcome, r.code, r.postcheck], ["NOT_CONFIRMED", "RESIDUAL_CLAIM_NOT_RELEASED", null], JSON.stringify(r)); assert.equal(r.claimHeld, true, "the residual facts are reported"); }
  { const w = world(); const r = await core(w, { unlockFalse: true });
    assert.deepEqual([r.outcome, r.code, r.lock, w.lockReleased], ["NOT_CONFIRMED", "UNLOCK_NOT_PROVEN", "unlock_failed_connection_destroyed", "destroyed"]); }
  { const w = world(); const r = await core(w, { escalateAfterCancel: true });
    assert.deepEqual([r.outcome, r.code, posts(w), r.finalState], ["CLEANUP_ESCALATED", "OWNER_CASE", [CANCEL_URL], "reconciliation_required"]); }
  { const w = world(); const r = await core(w, { finalResMutate: (o2) => o2, mirrorWorker: async () => { throw new Error("never"); }, worker: fakeCleanupWorker(w, { noMirrorRow: true }) });
    assert.deepEqual([r.outcome, r.code, posts(w), w.mirrorCalls], ["CLEANUP_UNKNOWN_STATE", "MIRROR_ROW_MISSING", [CANCEL_URL, REFUND_URL], 0], JSON.stringify(r)); }
  { const w = world(); const r = await core(w, { mirrorRowOver: { payload_och: "520002" } });
    assert.deepEqual([r.outcome, r.code, posts(w), w.mirrorCalls], ["LINEAGE_MISMATCH", "MIRROR_ROW_NOT_BOUND", [CANCEL_URL, REFUND_URL], 0], JSON.stringify(r)); }
});

test("C1 code ceiling: Slice 5 recorded cleanup execution CLOSED (executeEnabled false) AND the Slice 1–4 runners still CLOSED on THEIR tooling pins; this runner pins the MERGED e7-test e41b654a; the plan pins pi / reservation / Stripe charge / original offline charge / captured amount / stay / attempt / session and the accepted keys / titles / amount; ZERO capture / void / record / notify / create; the derived expectation is EXACTLY the accepted 18 keys", () => {
  assert.equal(C.executeEnabled, false); for (const R of [RESRUN, CAPRUN, TCRUN, RCRUN]) assert.equal(R.CONSTANTS.executeEnabled, false);
  assert.equal(C.toolingCommit, "e41b654a667cb0ba8775b5bd0040c28a3d14fda0"); assert.equal(C.toolingStatus, "MERGED");
  assert.equal(TCRUN.CONSTANTS.toolingCommit, "9d86bfa1e60779b3794de88bbae151670e8fe515", "the reviewed Slice 3 pin is untouched"); assert.equal(RCRUN.CONSTANTS.toolingCommit, "5a094b16c1f84690a738a98ab89140caa69c1e1f", "the reviewed Slice 4 pin is untouched");
  assert.equal(CAPRUN.CONSTANTS.toolingCommit, "40779e34e8c65ac5c4494bc5a18cd4223ef723fa", "the reviewed Slice 1 / 2 pins are untouched");
  const { plan, planHash } = built();
  assert.deepEqual(plan.writes, { requestMax: 1, cancelMax: 1, refundMax: 1, mirrorMax: 1, capture: 0, hostawayCreate: 0, record: 0, notify: 0, void: 0, account: 0, keys: 0 });
  assert.equal(plan.refundIdempotencyKey, IS.refundKey(IID, 1)); assert.equal(plan.mirrorTitle, MP.mirrorTitle(IID)); assert.equal(plan.recordingTitle, OP.offlineChargeTitle(IID)); assert.equal(plan.amount, OP.exactAmount(AMT));
  assert.equal(E.mirrorTitle(IID), MP.mirrorTitle(IID)); assert.equal(E.offlineChargeTitle(IID), OP.offlineChargeTitle(IID)); assert.equal(E.exactAmount(123456), OP.exactAmount(123456));
  assert.deepEqual([plan.paymentIntentId, plan.reservationId, plan.chargeId, plan.offlineChargeId, plan.capturedMinor, plan.from, plan.to, plan.guests, plan.attemptId, plan.sessionId, plan.paymentMethod, plan.accountRef],
    [PI, RID, CH, OCH, AMT, FROM, TO, 1, ATTEMPT, CS, "credit_card", "hostaway-e7-test"]);
  assert.deepEqual([plan.paymentMethod, plan.accountRef], [RCRUN.CONSTANTS.paymentMethod, RCRUN.CONSTANTS.accountRef], "the TEST recording config equals Slice 4's");
  assert.equal(OP.LIST_LIMIT, 500); assert.equal(MP.MIRROR_LIST_LIMIT, 500); assert.equal(MP.MIRROR_INCLUDE_IN_PRICE_BREAKDOWN, 0);
  const ex = E.operatorExpectation(plan, planHash);
  assert.deepEqual(Object.keys(ex).sort(), [...EXPECTATION_KEYS]); assert.equal(ex.planHash, planHash);
  assert.deepEqual([ex.authorizedMinor, ex.finalTotalMinor, ex.capturedMinor, ex.listingId, ex.currency, ex.stripeChargeId, ex.offlineChargeId], [AMT, AMT, AMT, 606998, "USD", CH, OCH]);
  for (const bad of [{ reservationId: "" }, { reservationId: C.protectedReservationIds[0] }, { paymentIntentId: "ch_x" }, { chargeId: "pi_FAKEhostedRtc0001" }, { offlineChargeId: "ch_x" }, { offlineChargeId: RID }, { offlineChargeId: "0520001" },
    { capturedMinor: 0 }, { capturedMinor: 1.5 }, { notBefore: "2026-11-12" }, { expectedVersion: 0 }, { intentId: "not-a-uuid" }, { from: "2026-11-26" }, { to: "2026-02-30" }, { guests: 0 }, { guests: 51 },
    { attemptId: "x" }, { sessionId: "cs_live_FAKEhostedRtc0001" }, { approvalRef: "" }]) assert.throws(() => E.buildPlan(C, planInput(bad)), /e7-hosted-recorded-cleanup/, JSON.stringify(bad));
  const ph = (over) => built(over).planHash;
  for (const over of [{ capturedMinor: AMT + 1 }, { paymentIntentId: "pi_FAKEother00000001" }, { expectedVersion: VER + 1 }, { chargeId: "ch_FAKEother00000001" }, { offlineChargeId: "520002" }, { reservationId: "71999902" }, { from: "2026-11-24" },
    { attemptId: "aaaaaaaa-bbbb-4ccc-8ddd-000000000000" }, { sessionId: "cs_test_FAKEother0001" }]) assert.notEqual(ph({}), ph(over), JSON.stringify(over));
  assert.deepEqual([C.budgets.steps, C.budgets.cancel, C.budgets.refund, C.budgets.mirror, C.budgets.runMs], [24, 1, 1, 1, 20 * 60 * 1000]);
  assert.ok(C.budgets.dbTeardownReserve > 0 && C.budgets.dbTeardownReserve < C.budgets.dbQueries);
  assert.ok(!C.closure.includes("scripts/e7-connected/executor-adapters.mjs"), "the refund-free accepted executor phases are NOT part of this runner");
  assert.deepEqual(E.TOOLING_KEYS.filter((k) => !TCRUN.TOOLING_KEYS.includes(k)), ["runMirrorStep", "requestRecordedTestCleanup", "buildHostawayMirrorExecutors", "mirrorTitle", "classifyTitle", "classifyMirrorTitle", "providerIdToCanonical", "amountToMinor"]);
  assert.ok(!E.TOOLING_KEYS.includes("requestTestCleanup"), "the pristine request is never composed here");
});

test("C2 closure: the INDEPENDENTLY scanned transitive relative imports of the runner's tooling roots == CONSTANTS.closure (= the Slice 3 closure + test-cleanup-recorded + mirror-worker + mirror-transport + mirror-proof + offline-charge-proof); framed digest == the pin; no R1 / reconcile / stager / recording-worker / notification / compensation-worker / test-abort / capture-worker / executor-adapters file", async () => {
  const roots = ["lib/booking-db/cleanup-worker.js", "lib/booking-db/mirror-worker.js", "lib/booking-db/test-cleanup-recorded.js", "lib/booking-db/repo.js", "scripts/e7-connected/test-cleanup-executors.mjs", "lib/booking-db/mirror-transport.js",
    "scripts/e7-connected/test-cleanup-transports.mjs", "scripts/e7-connected/http-transports.mjs", "scripts/e7-connected/real-exchange.mjs", "lib/booking-db/pool.js", "lib/hostaway-reservations.js", "lib/checkout/capture-proof.js",
    "lib/checkout/recovery-plan.js", "lib/checkout/test-cleanup-proof.js", "lib/checkout/compensation-proof.js", "lib/checkout/intent-state.js", "lib/checkout/mirror-proof.js", "lib/checkout/offline-charge-proof.js",
    "scripts/e7-connected/run-lock-precheck.mjs", "scripts/e7-connected/probe-env-preflight.mjs"];
  const src = readFileSync(join(ROOT, "scripts/e7-hosted-recorded-cleanup.mjs"), "utf8");
  for (const f of roots) assert.ok(src.includes(f), `runner imports ${f}`);
  const seen = new Set(); const st = [...roots];
  while (st.length) { const f = st.pop(); if (seen.has(f)) continue; seen.add(f);
    for (const m of readFileSync(join(TOOLING, f), "utf8").matchAll(/(?:import|export)\s[^"'`;]*?from\s*["'](\.[^"']+)["']|import\(\s*["'](\.[^"']+)["']\s*\)/g)) st.push(normalize(join(dirname(f), m[1] || m[2]))); }
  assert.deepEqual([...C.closure], ["package.json", "package-lock.json", ...[...seen].sort()].sort());
  const expected = new Set([...TCRUN.CONSTANTS.closure, "lib/booking-db/test-cleanup-recorded.js", "lib/booking-db/mirror-worker.js", "lib/booking-db/mirror-transport.js", "lib/checkout/mirror-proof.js", "lib/checkout/offline-charge-proof.js"]);
  assert.deepEqual([...C.closure], [...expected].sort());
  assert.equal(await RESRUN.framedDigest(TOOLING, C.closure, E.CLOSURE_DIGEST_PREFIX), C.closureDigest);
  for (const f of C.closure) assert.doesNotMatch(f, /run-core|run-plan|run-r1|reconcile|stage-run|recording-worker|notification-worker|compensation-worker|test-abort|capture-worker|executor-adapters/);
});

// ---------------------------------------------------------------------------------------------------------------------------------
const PROC = { versions: { node: C.nodeVersion }, platform: "linux", execArgv: [], getuid: () => 1000, once() {}, off() {} };
const okChild = async () => ({ status: 0, signal: null, stdout: "# tests 3\n# pass 3\n# fail 0\n", truncated: false, spawnFailed: false });
const realEnv = (over = {}) => ({ E7_TOOLING_DIR: TOOLING, E7_APPROVAL_REF: "label-1", E7_INTENT_ID: IID, E7_EXPECTED_VERSION: String(VER), E7_NOT_BEFORE: NB, E7_PAYMENT_INTENT_ID: PI, E7_RESERVATION_ID: RID,
  E7_CHARGE_ID: CH, E7_OFFLINE_CHARGE_ID: OCH, E7_CAPTURED_MINOR: String(AMT), E7_STAY_FROM: FROM, E7_STAY_TO: TO, E7_GUESTS: "1", E7_ATTEMPT_ID: ATTEMPT, E7_SESSION_ID: CS, E7_RUN_ID: "12345678901-1", ...over });

test("H1 hosted: preflight (no secrets) passes on the pinned closure; any secret outside execute is refused; partial / invalid inputs (incl. the original offline charge id) refused; the runner digest covers the imported Slice 1 runner", async () => {
  let x = await E.runHosted({ mode: "preflight", env: { E7_TOOLING_DIR: TOOLING }, proc: PROC, wrapperDir: ROOT, deps: { spawnChild: okChild } });
  assert.deepEqual([x.exitCode, x.result.code, x.result.planKind, x.result.closureDigest, x.result.executeEnabled, x.result.schema], [0, "PREFLIGHT_OK_SYNTHETIC_ONLY", "SYNTHETIC", C.closureDigest, false, "e7-hosted-recorded-cleanup-hosted-v1"], JSON.stringify(x.result));
  assert.equal(x.result.runnerDigest, await RESRUN.framedDigest(ROOT, C.runnerFiles, E.RUNNER_DIGEST_PREFIX)); assert.ok(C.runnerFiles.includes("scripts/e7-hosted-reservation.mjs"));
  x = await E.runHosted({ mode: "preflight", env: realEnv(), proc: PROC, wrapperDir: ROOT, deps: { spawnChild: okChild } });
  assert.deepEqual([x.exitCode, x.result.code, x.result.planKind], [0, "PREFLIGHT_OK_REAL_PLAN", "REAL"], JSON.stringify(x.result));
  assert.equal(x.result.planHash, E.buildPlan(C, planInput({ approvalRef: "label-1", runnerDigest: x.result.runnerDigest })).planHash);
  for (const [env, code] of [[{ E7_TOOLING_DIR: TOOLING, E7_STRIPE_TEST_KEY: "sk_test_x" }, "HRT_SECRET_SCOPE_VIOLATION"], [{ E7_TOOLING_DIR: TOOLING, E7_DEV_BOOKING_DATABASE_URL: "postgresql://x" }, "HRT_SECRET_SCOPE_VIOLATION"],
    [realEnv({ E7_CAPTURED_MINOR: "" }), "HRT_INPUT_INCOMPLETE"], [realEnv({ E7_OFFLINE_CHARGE_ID: "" }), "HRT_INPUT_INCOMPLETE"],
    [realEnv({ E7_INTENT_ID: "bad" }), "HRT_INPUT_INVALID"], [realEnv({ E7_PAYMENT_INTENT_ID: "ch_x" }), "HRT_INPUT_INVALID"], [realEnv({ E7_RESERVATION_ID: C.protectedReservationIds[0] }), "HRT_INPUT_INVALID"],
    [realEnv({ E7_OFFLINE_CHARGE_ID: "ch_x" }), "HRT_INPUT_INVALID"], [realEnv({ E7_OFFLINE_CHARGE_ID: RID }), "HRT_INPUT_INVALID"], [realEnv({ E7_CAPTURED_MINOR: "0" }), "HRT_INPUT_INVALID"],
    [realEnv({ E7_NOT_BEFORE: "yesterday" }), "HRT_INPUT_INVALID"], [realEnv({ E7_APPROVAL_REF: C.synthetic.approvalRef }), "HRT_INPUT_INVALID"], [realEnv({ E7_CHARGE_ID: "re_x" }), "HRT_INPUT_INVALID"],
    [realEnv({ E7_STAY_FROM: "2026-11-26" }), "HRT_INPUT_INVALID"], [realEnv({ E7_GUESTS: "0" }), "HRT_INPUT_INVALID"], [realEnv({ E7_SESSION_ID: "cs_live_FAKEhostedRtc0001" }), "HRT_INPUT_INVALID"]]) {
    const y = await E.runHosted({ mode: "preflight", env, proc: PROC, wrapperDir: ROOT, deps: { spawnChild: okChild } });
    assert.deepEqual([y.exitCode, y.result.code], [1, code], code);
  }
  const bad = await E.runHosted({ mode: "preflight", env: { E7_TOOLING_DIR: TOOLING }, proc: PROC, wrapperDir: ROOT, deps: { spawnChild: async () => ({ status: 1, signal: null, stdout: "# tests 3\n# pass 2\n# fail 1\n", truncated: false, spawnFailed: false }) } });
  assert.equal(bad.result.code, "HRT_TESTS_FAILED");
});

test("H2 hosted: verify / execute are CLOSED in this revision (HRT_EXECUTE_CLOSED) before any pin, ref or import check; an opened constants seam still refuses off main / wrong digests / a missing run id / secrets missing / wrong DB target, wipes secrets, and wires TWO pools (6543 max 3 worker, 5432 max 1 lock) with the run id", async () => {
  const x = await E.runHosted({ mode: "verify", env: { ...realEnv(), E7_EXPECTED_PLAN_HASH: "0".repeat(64), E7_EXPECTED_CLOSURE_DIGEST: C.closureDigest, E7_EXPECTED_RUNNER_DIGEST: "0".repeat(64), GITHUB_REF: "refs/heads/main" }, proc: PROC, wrapperDir: ROOT, deps: {} });
  assert.deepEqual([x.exitCode, x.result.code, x.result.closureDigest], [1, "HRT_EXECUTE_CLOSED", null]);
  const y = await E.runHosted({ mode: "execute", env: { ...realEnv(), E7_STRIPE_TEST_KEY: "sk_test_x", E7_HOSTAWAY_TOKEN: "t", E7_DEV_BOOKING_DATABASE_URL: "postgresql://x" }, proc: PROC, wrapperDir: ROOT, deps: { importTooling: async () => { throw new Error("never"); } } });
  assert.deepEqual([y.exitCode, y.result.code], [1, "HRT_EXECUTE_CLOSED"]);
  const opened = { ...C, executeEnabled: true };
  const pf = await E.runHosted({ mode: "preflight", env: realEnv(), proc: PROC, wrapperDir: ROOT, deps: { spawnChild: okChild } });
  const d = pf.result;
  const base = { ...realEnv(), E7_EXPECTED_PLAN_HASH: d.planHash, E7_EXPECTED_CLOSURE_DIGEST: d.closureDigest, E7_EXPECTED_RUNNER_DIGEST: d.runnerDigest, GITHUB_REF: "refs/heads/main" };
  let v = await E.runHosted({ mode: "verify", env: { ...base }, proc: PROC, wrapperDir: ROOT, deps: { constants: opened } });
  assert.deepEqual([v.exitCode, v.result.code, v.result.runId], [0, "VERIFY_OK", "12345678901-1"], JSON.stringify(v.result));
  for (const [env, code] of [[{ ...base, GITHUB_REF: "refs/heads/feature" }, "HRT_REF_NOT_MAIN"], [{ ...base, E7_EXPECTED_CLOSURE_DIGEST: "1".repeat(64) }, "HRT_SOURCE_MISMATCH"],
    [{ ...base, E7_EXPECTED_RUNNER_DIGEST: "1".repeat(64) }, "HRT_RUNNER_MISMATCH"], [{ ...base, E7_EXPECTED_PLAN_HASH: "1".repeat(64) }, "HRT_PLAN_HASH_MISMATCH"], [{ ...base, E7_EXPECTED_PLAN_HASH: "" }, "HRT_INPUT_INCOMPLETE"],
    [{ ...base, E7_RUN_ID: "" }, "HRT_INPUT_INVALID"], [{ ...base, E7_RUN_ID: "bad id!" }, "HRT_INPUT_INVALID"]]) {
    v = await E.runHosted({ mode: "verify", env, proc: PROC, wrapperDir: ROOT, deps: { constants: opened } }); assert.deepEqual([v.exitCode, v.result.code], [1, code], code);
  }
  v = await E.runHosted({ mode: "execute", env: { ...base }, proc: PROC, wrapperDir: ROOT, deps: { constants: opened, importTooling: async () => { throw new Error("never"); } } });
  assert.deepEqual([v.exitCode, v.result.code], [1, "HRT_CREDENTIALS_MISSING"]);
  const envBad = { ...base, E7_STRIPE_TEST_KEY: "sk_test_x", E7_HOSTAWAY_TOKEN: "t", E7_DEV_BOOKING_DATABASE_URL: "postgresql://u@h:1/x" };
  v = await E.runHosted({ mode: "execute", env: envBad, proc: PROC, wrapperDir: ROOT, deps: { constants: opened, readPgVersion: async () => C.pgVersion } });
  assert.deepEqual([v.exitCode, v.result.code, "E7_STRIPE_TEST_KEY" in envBad, "E7_DEV_BOOKING_DATABASE_URL" in envBad], [1, "HRT_DB_TARGET_INVALID", false, false], "secrets wiped from the env object");
  assert.equal(JSON.stringify(v.result).includes("sk_test_x"), false);
  const good = `postgresql://mv_booking_app_dev.${C.dbProjectRef}:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres`;
  const pools = []; let coreArgs = null;
  const fakeTooling = async () => ({ X: { createE7RealExchange: () => ({ ok: true, exchange: async () => ({}) }) },
    createBookingPool: (o) => { const u = new URL(o.connectionString); pools.push({ port: u.port, max: o.max, ended: false }); const me = pools.at(-1); return { connect: async () => ({ query: async () => ({ rows: [] }), release() {}, on() {} }), query: async () => ({ rows: [] }), end: async () => { me.ended = true; } }; },
    tooling: {} });
  const z = await E.runHosted({ mode: "execute", env: { ...base, E7_STRIPE_TEST_KEY: "sk_test_x", E7_HOSTAWAY_TOKEN: "t", E7_DEV_BOOKING_DATABASE_URL: good, E7_CA_FILE: "ca" }, proc: PROC, wrapperDir: ROOT,
    deps: { constants: opened, readPgVersion: async () => C.pgVersion, readCa: async () => Buffer.from("CA"), caSha256: (await import("node:crypto")).createHash("sha256").update("CA").digest("hex"), importTooling: fakeTooling,
      runCore: async (a) => { coreArgs = a; return { outcome: "SCOPE_REFUSED", code: "FAKE" }; } } });
  assert.deepEqual([z.exitCode, z.result.code, z.result.lockEndpoint, z.result.runId, pools.map((p) => [p.port, p.max, p.ended])], [1, "EXECUTE_DONE", "session:5432", "12345678901-1", [["6543", 3, true], ["5432", 1, true]]], JSON.stringify(z.result));
  assert.equal(typeof coreArgs.lockClientFactory, "function"); assert.deepEqual([coreArgs.plan.paymentIntentId, coreArgs.plan.capturedMinor, coreArgs.plan.chargeId, coreArgs.plan.offlineChargeId, coreArgs.planHash, coreArgs.runId], [PI, AMT, CH, OCH, d.planHash, "12345678901-1"]);
  assert.equal(JSON.stringify(z.result).includes("sk_test_x"), false);
});

test("H3 hosted: a drifted tooling byte (in the mirror worker) is refused before any import (closure digest)", async () => {
  const d = mkdtempSync(join(tmpdir(), "e7-hrt-drift-"));
  try {
    for (const f of C.closure) { mkdirSync(dirname(join(d, f)), { recursive: true }); cpSync(join(TOOLING, f), join(d, f)); }
    writeFileSync(join(d, "lib/booking-db/mirror-worker.js"), `${readFileSync(join(TOOLING, "lib/booking-db/mirror-worker.js"), "utf8")}\n// drift\n`);
    const x = await E.runHosted({ mode: "preflight", env: { E7_TOOLING_DIR: d }, proc: PROC, wrapperDir: ROOT, deps: { spawnChild: okChild, importEnv: async () => C1 } });
    assert.deepEqual([x.exitCode, x.result.code], [1, "HRT_SOURCE_MISMATCH"]);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("S1 static: the runner imports node built-ins and ONLY the reviewed Slice 1 runner; no capture / void / create / record / notify call text; executor-adapters never imported; inert import; the workflow checks out e41b654a, keeps the reviewer gate, scopes secrets to the execute step and carries every input + the run id", () => {
  const src = readFileSync(join(ROOT, "scripts/e7-hosted-recorded-cleanup.mjs"), "utf8");
  for (const m of src.matchAll(/^import .* from "([^"]+)";$/gm)) assert.ok(m[1].startsWith("node:") || m[1] === "./e7-hosted-reservation.mjs", m[1]);
  for (const bad of ["capturePaymentIntent(", "paymentIntents.capture", "cancelPaymentIntent(", "paymentIntents.cancel", "createOfflineCharge(", "sendMessage(", "createReservation(", "executor-adapters.mjs\"", "createPhaseExecutors", "requestTestCleanup("])
    assert.equal(src.includes(bad), false, bad);
  assert.equal(process.listenerCount("SIGINT"), 0);
  const yml = readFileSync(join(ROOT, ".github/workflows/e7-hosted-recorded-cleanup.yml"), "utf8");
  assert.ok(yml.includes("ref: e41b654a667cb0ba8775b5bd0040c28a3d14fda0") && !yml.includes("9d86bfa1") && !yml.includes("5a094b16") && !yml.includes("40779e34"), "the workflow checks out the pinned tooling commit");
  assert.ok(yml.includes("environment: e7-readonly-probe") && yml.includes("permissions:\n  contents: read") && yml.includes("github.ref == 'refs/heads/main'") && yml.includes("name: e7-hosted-recorded-cleanup"));
  assert.equal((yml.match(/secrets\./g) || []).length, 3, "secrets appear in the execute step only");
  for (const k of Object.values(E.INPUT_ENV)) assert.equal((yml.match(new RegExp(`${k}:`, "g")) || []).length, 3, k);
  assert.equal((yml.match(/E7_RUN_ID:/g) || []).length, 2, "the run id reaches verify + execute");
  assert.ok(yml.includes("e7-hosted-recorded-cleanup.mjs preflight") && yml.includes("e7-hosted-recorded-cleanup.mjs verify") && yml.includes("e7-hosted-recorded-cleanup.mjs execute"));
  assert.equal(yml.includes("npm ci --ignore-scripts --omit=dev --no-audit --no-fund"), true);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// OPT-IN INTEGRATION (E7_HRT_DB_TESTS=1; tooling with its pinned pg; PG_BIN): the REAL merged requestRecordedTestCleanup + runTestCleanupStep + runMirrorStep, repo, operations,
// 0019–0021, the isolated transports / executors and the REAL bound mirror transport on a disposable PostgreSQL (tooling test/db/harness.mjs). FAKE exchanges ONLY (mock replies
// are not provider proof); fixtures through the accepted APIs. Real-time clock (the 0021 completion judges proof freshness by the DATABASE clock); the test harness only makes
// the next worker step DUE (scheduling) where the hosted runner would wait the workers' 30 s. The hosted preflight child never sets E7_HRT_DB_TESTS.
if (process.env.E7_HRT_DB_TESTS === "1") {
  assert.ok(MT && TR && MW, "the integration needs the pg-dependent accepted modules");
  const [{ startMigratedDatabase }, F, R, O, W, pgMod] = await Promise.all([tool("test/db/harness.mjs"), tool("test/db/fixtures.mjs"), tool("lib/booking-db/repo.js"), tool("lib/booking-db/operations.js"),
    tool("lib/booking-db/cleanup-worker.js"), import(pathToFileURL(join(TOOLING, "node_modules/pg/lib/index.js")).href)]);
  const pg = pgMod.default ?? pgMod;
  const db = await startMigratedDatabase();
  after(async () => { await db.close(); });
  const LIST = 606998; const MINUTE = 60000; const PG_AMT = 576000;
  let stayK = 0;
  const realTooling = { ...toolingFor(world()), runTestCleanupStep: W.runTestCleanupStep, runMirrorStep: MW.runMirrorStep, requestRecordedTestCleanup: TR.requestRecordedTestCleanup, loadIntent: R.loadIntent, buildHostawayMirrorExecutors: MT.buildHostawayMirrorExecutors };
  /** a RECORDED (confirmed) TEST booking on 606998 / USD through the accepted fixtures: captured, then the recording claimed / proven / completed / confirmed (ONE pristine guest.notify queued) */
  async function recordedIntent() {
    stayK += 1;
    const stay = { listingId: LIST, currency: "USD", from: F.addDays("2027-06-01", 3 * stayK), to: F.addDays("2027-06-01", 3 * stayK + 2) };
    const rr = await F.reserved(db.app, stay);
    const stripeChargeId = `ch_test_${rr.id.replace(/-/g, "").slice(0, 16)}`;
    const cop = await F.claimOp(db.app, rr.id, CAP, F.at(8));
    F.ok(await O.completeOperation(db.app, cop.id, { workerId: "w1", now: F.at(8), outcome: { status: "succeeded", resultRef: stripeChargeId } }), "capture op");
    F.ok(await R.applyEvent(db.app, rr.id, { type: "CAPTURE_SUCCEEDED", id: `evt_cap_${rr.piId}`, amountMinor: PG_AMT, currency: "usd" }, { now: F.at(8), actor: "webhook" }), "capture");
    const offlineChargeId = String(F.nextReservationId() + 500000);
    const { op: rop, t } = await F.claimRecording(db.app, { ...rr }, Date.now(), "w1", { accountRef: C.accountRef, config: { refFieldId: C.refFieldId } });   // the Slice 4 TEST recording labels
    const { version } = (await db.app.query("SELECT version FROM booking.intents WHERE id = $1", [rr.id])).rows[0];
    const ev = await F.chargeListEvidence(db.app, { id: rr.id, reservationId: rr.reservationId }, F.recordingObserved({ id: rr.id, reservationId: rr.reservationId, listingId: LIST }, offlineChargeId, { currency: "USD", executorAccountRef: C.accountRef }), t + 1);
    F.ok(await O.completeRecordingWithEvidence(db.app, rop.id, { workerId: "w1", evidenceId: ev, resultRef: offlineChargeId, expectedVersion: version }), "recording");
    await db.app.query("UPDATE booking.intent_work SET work_worker_id = NULL, work_lease_until = NULL WHERE intent_id = $1", [rr.id]);
    F.ok(await R.applyEvent(db.app, rr.id, { type: "OFFLINE_CHARGE_RECORDED", chargeId: offlineChargeId }, { now: t + 2, actor: "worker" }), "confirmed");
    const i = await R.loadIntent(db.app, rr.id);
    assert.equal(i.status, "confirmed");
    const pa = (await db.app.query("SELECT id::text AS id FROM booking.payment_attempts WHERE intent_id = $1 AND status = 'completed'", [rr.id])).rows[0].id;
    return { id: rr.id, piId: rr.piId, attemptId: pa, sessionId: rr.sessionId, chargeId: stripeChargeId, offlineChargeId, stay, ref: i.ref, intent: i, total: i.price.finalTotalMinor, rid: String(rr.reservationId) };
  }
  let mirrorSeq = 900000;
  function pgWorld(a, o = {}) {
    const w = { calls: [], refunded: 0, resStatus: "new", cancelRequests: 0, refundRequests: 0, mirrorRequests: 0, refundId: `re_test_${a.id.replace(/-/g, "").slice(0, 16)}`, refundOpId: null, refundCreated: null,
      charges: [{ id: Number(a.offlineChargeId), reservationId: Number(a.rid), listingMapId: LIST, type: "charge", title: OP.offlineChargeTitle(a.id), amount: a.total / 100, currency: "USD", status: "paid", paymentProvider: "offline", paymentMethod: "credit_card" }] };
    const reply = (status, x) => Promise.resolve({ status, contentType: "application/json", bytes: enc(x) });
    const pi = () => ({ object: "payment_intent", id: a.piId, livemode: false, status: "succeeded", capture_method: "manual", amount: a.total, amount_received: a.total, amount_capturable: 0, currency: "usd",
      metadata: { mv_intent_id: a.id, mv_payment_attempt_id: a.attemptId },
      latest_charge: { object: "charge", id: a.chargeId, payment_intent: a.piId, status: "succeeded", paid: true, captured: true, amount: a.total, amount_captured: a.total, amount_refunded: w.refunded,
        refunded: w.refunded >= a.total, disputed: false, currency: "usd", livemode: false, payment_method_details: { card: { capture_before: a.intent.payment.captureBefore / 1000 } } } });
    const refund = () => ({ object: "refund", id: w.refundId, payment_intent: a.piId, charge: a.chargeId, amount: a.total, currency: "usd", status: "succeeded", created: w.refundCreated, reason: null, failure_reason: null,
      metadata: { mv_refund_op: w.refundOpId, mv_refund_key: `ref:${a.id}:1` } });
    const full = () => ({ id: Number(a.rid), listingMapId: LIST, channelId: 2000, arrivalDate: a.stay.from, departureDate: a.stay.to, totalPrice: a.total / 100, currency: "USD", status: w.resStatus,
      customFieldValues: [{ customFieldId: C.refFieldId, value: a.ref }] });
    w.stripe = (req) => {
      const p = req.url.replace("https://api.stripe.com", ""); w.calls.push(`S ${req.method} ${p}`);
      if (p === "/v1/account") return reply(200, { object: "account", id: ACCT });
      if (req.method === "POST") {
        assert.equal(p, "/v1/refunds"); assert.equal(req.headers["Idempotency-Key"], `ref:${a.id}:1`);
        const m = /^payment_intent=([^&]+)&amount=(\d+)&metadata%5Bmv_refund_op%5D=([^&]+)&metadata%5Bmv_refund_key%5D=([^&]+)$/.exec(req.body);
        assert.ok(m, req.body); assert.deepEqual([m[1], Number(m[2]), decodeURIComponent(m[4])], [a.piId, a.total, `ref:${a.id}:1`]);
        w.refundOpId = m[3]; w.refundRequests += 1; w.refundCreated = Math.floor(Date.now() / 1000);
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
      if (req.method === "POST") {
        assert.equal(p, `/v1/guestPayments/charges/${a.rid}/${a.offlineChargeId}/refund`); assert.equal(req.body, JSON.stringify({ title: MP.mirrorTitle(a.id), amount: a.total / 100, isIncludeInPriceBreakdown: 0 }));
        assert.deepEqual(Object.keys(req.headers).sort(), ["Accept", "Authorization", "Cache-control", "Content-Type"]); w.mirrorRequests += 1;
        mirrorSeq += 1;
        const row = { id: mirrorSeq, reservationId: Number(a.rid), listingMapId: LIST, type: "refund", title: MP.mirrorTitle(a.id), amount: -a.total / 100, currency: "USD", status: "succeeded", paymentProvider: "offline", paymentMethod: "credit_card",
          refundInfo: { id: mirrorSeq + 1000000, chargeId: mirrorSeq, refundedChargeId: Number(a.offlineChargeId) } };
        if (o.mirrorLost) { if (o.mirrorLandedAnyway) w.charges.push(row); return Promise.reject(new Error("socket reset")); }
        w.charges.push(row);
        return reply(200, { status: "success", result: { id: row.id, refundInfo: { ...row.refundInfo }, status: "succeeded", paymentProvider: "offline" } });
      }
      if (req.method === "GET" && p === `/v1/guestPayments/charges?limit=500&reservationIds=${a.rid}`) {
        let rows = w.charges.map((x) => JSON.parse(JSON.stringify(x)));
        if (o.listMutate) rows = o.listMutate(rows);
        return reply(200, { status: "success", result: rows, count: rows.length, limit: 500 });
      }
      if (req.method === "GET" && p.startsWith("/v1/reservations?")) return reply(200, { status: "success", result: new URL(req.url).searchParams.has("afterId") ? [] : [full()] });
      const m = /^\/v1\/reservations\/(\d+)$/.exec(p);
      if (req.method === "GET" && m) return m[1] === a.rid ? reply(200, { status: "success", result: full() }) : reply(404, { status: "fail" });
      return reply(404, { status: "fail" });
    };
    return w;
  }
  const pgPlan = (a, over = {}) => E.buildPlan(C, { approvalRef: "SYNTHETIC-hrt-pg", intentId: a.id, expectedVersion: a.intent.version, notBefore: new Date(F.at(0) - MINUTE).toISOString(), paymentIntentId: a.piId,
    reservationId: a.rid, chargeId: a.chargeId, offlineChargeId: a.offlineChargeId, capturedMinor: a.total, from: a.stay.from, to: a.stay.to, guests: a.intent.guests, attemptId: a.attemptId, sessionId: a.sessionId, runnerDigest: "0".repeat(64), ...over });
  /** test-harness SCHEDULING ONLY: where the hosted runner would wait the worker's delay in real time, make the pinned intent due now (the workers' own leases / proofs are untouched) */
  const dueNow = (id) => async () => { await new Promise((res) => setTimeout(res, 5)); await db.owner.query("UPDATE booking.intent_work SET next_action_at = now() WHERE intent_id = $1", [id]); };
  const pgRun = (a, w, extra = {}, over = {}) => {
    const b = pgPlan(a, over);
    return E.runRecordedCleanupCore({ plan: b.plan, planHash: b.planHash, runId: `hrt-pg-${stayK}`, pool: db.app, tooling: realTooling, exchanges: { stripe: w.stripe, hostaway: w.hostaway },
      credentials: { stripe: () => "sk_test_Fake1", hostaway: () => "synthetic-hostaway-token" }, clock: () => Date.now(), sleep: dueNow(a.id), ...extra });
  };
  const snap = async (id) => ({ st: (await db.app.query("SELECT state, version, reason_code, settlement_reservation_cancelled AS c, settlement_authorization_settled AS a, settlement_recording_mirrored AS m, offline_charge_id::text AS och FROM booking.intents WHERE id = $1", [id])).rows[0],
    ops: (await db.app.query("SELECT op_type, state, attempts, (dispatched_at IS NOT NULL) AS d, result_ref, (settled_evidence_id IS NOT NULL) AS linked FROM booking.external_operations WHERE intent_id = $1 ORDER BY op_type, created_at", [id])).rows,
    claim: (await db.app.query("SELECT (released_at IS NOT NULL) AS released FROM booking.inventory_claims WHERE intent_id = $1", [id])).rows,
    refunds: (await db.app.query("SELECT seq, state, stripe_refund_id, amount_minor::text AS amt FROM booking.payment_refunds WHERE intent_id = $1 ORDER BY seq", [id])).rows,
    ledger: (await db.app.query("SELECT entry, provider_ref FROM booking.payment_ledger WHERE intent_id = $1 ORDER BY id", [id])).rows,
    suppressions: Number((await db.app.query("SELECT count(*)::int AS n FROM booking.notification_suppressions WHERE intent_id = $1", [id])).rows[0].n),
    cases: Number((await db.app.query("SELECT count(*)::int AS n FROM booking.reconciliation_cases WHERE intent_id = $1 AND status = 'open'", [id])).rows[0].n),
    endOk: (await db.app.query("SELECT booking.recorded_state_cleanup_ok($1) AS ok", [id])).rows[0].ok,
    locks: Number((await db.app.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'")).rows[0].n) });

  test("I1 PG integration (REAL recorded request + REAL cleanup worker + REAL mirror worker + repo + 0019/0020/0021 + isolated transports / executors + REAL bound mirror transport; FAKE exchanges): ONE request, ONE cancel PUT then ONE refund POST then ONE mirror POST (exact bodies), cancelled / not_completed_refunded, three legs, refund + mirror records / ledger / evidence, recording linked, notification suppressed, claim released, end predicate, lock released; a SECOND admission refuses read-only with zero sends; budgets measured", async () => {
    const a = await recordedIntent(); const w = pgWorld(a);
    const r = await pgRun(a, w);
    assert.equal(r.outcome, "RECORDED_CLEANUP_COMPLETED", JSON.stringify(r));
    assert.deepEqual([r.requestInvocations, r.cancelInvocations, r.cancelOutcome, r.refundInvocations, r.refundOutcome, r.mirrorInvocations, r.mirrorOutcome, r.mirrorTransportPosts, r.capturedMinor, r.reservationId, r.chargeId, r.offlineChargeId, r.refundId, r.publicStatus, r.lock, w.cancelRequests, w.refundRequests, w.mirrorRequests],
      [1, 1, "REPLIED", 1, "REPLIED", 1, "REPLIED", 1, a.total, a.rid, a.chargeId, a.offlineChargeId, w.refundId, "not_completed_refunded", "released", 1, 1, 1]);
    assert.deepEqual(w.calls.filter((x) => /^(S POST|H POST|H PUT|H DELETE)/.test(x)), [`H PUT /v1/reservations/${a.rid}/statuses/cancelled`, "S POST /v1/refunds", `H POST /v1/guestPayments/charges/${a.rid}/${a.offlineChargeId}/refund`]);
    const s = await snap(a.id);
    assert.deepEqual([s.st.state, s.st.reason_code, s.st.c, s.st.a, s.st.m, s.st.och, s.claim[0].released, s.cases, s.suppressions, s.endOk, s.locks], ["cancelled", "TEST_CLEANUP_REQUESTED", true, true, true, a.offlineChargeId, true, 0, 1, true, 0]);
    assert.deepEqual(s.ops.filter((x) => x.op_type === CAN).map((x) => [x.state, x.attempts, x.d, x.result_ref]), [["succeeded", 1, true, a.rid]]);
    assert.deepEqual(s.ops.filter((x) => x.op_type === RFD).map((x) => [x.state, x.attempts, x.d, x.result_ref]), [["succeeded", 1, true, w.refundId]]);
    assert.deepEqual(s.ops.filter((x) => x.op_type === MIR).map((x) => [x.state, x.attempts, x.d, x.result_ref, x.linked]), [["succeeded", 1, true, String(mirrorSeq), true]]);
    assert.deepEqual(s.ops.filter((x) => x.op_type === REC).map((x) => [x.state, x.attempts, x.linked, x.result_ref]), [["succeeded", 1, true, a.offlineChargeId]], "the recording stays the linked book entry (never retired)");
    assert.deepEqual(s.ops.filter((x) => x.op_type === NOT).map((x) => [x.state, x.attempts, x.d]), [["superseded", 0, false]], "the ONE notification suppressed, never dispatched");
    assert.deepEqual(s.refunds, [{ seq: 1, state: "succeeded", stripe_refund_id: w.refundId, amt: String(a.total) }]);
    assert.deepEqual(s.ledger.map((l) => l.entry), ["authorization_accepted", "capture_succeeded", "offline_charge_recorded", "refund_succeeded", "offline_charge_refund_recorded"]);
    assert.equal(s.ledger.at(-1).provider_ref, String(mirrorSeq));
    for (const t of ["alert.owner", "stripe.void_payment_intent"]) assert.equal(s.ops.filter((x) => x.op_type === t).length, 0, t);
    const i = await R.loadIntent(db.app, a.id); assert.deepEqual([i.payment.capturedMinor, i.payment.paymentIntentId, String(i.reservation.reservationId), IS.publicStatus(i)], [a.total, a.piId, a.rid, "not_completed_refunded"]);
    console.log(`# I1: steps=${r.steps} (cleanup ${r.cleanupSteps} / mirror ${r.mirrorSteps}) dbQueries=${r.dbQueries} teardown=${r.dbTeardownQueries} exchanges=${r.exchanges} hostawayReads=${r.hostawayReads} lookups=${r.lookupPages} lists=${r.chargeLists} account=${r.accountReads} pi=${r.piReads} refundReads=${r.refundReads} refundLists=${r.refundLists}`);
    assert.ok(r.dbQueries > 0 && r.dbQueries <= C.budgets.dbQueries && r.dbTeardownQueries <= C.budgets.dbTeardownReserve && r.exchanges <= C.budgets.exchanges);
    // second admission (a later session) on the cleaned intent: refused before the lock, zero sends
    const a2 = { ...a, intent: i }; const w2 = pgWorld(a2); const r2 = await pgRun(a2, w2);
    assert.deepEqual([r2.outcome, r2.code, w2.calls.length, r2.requestInvocations, r2.steps, r2.lock], ["START_STATE_NOT_ELIGIBLE", "STATE_NOT_CONFIRMED", 0, 0, 0, "not_acquired"], JSON.stringify(r2));
  });

  test("I2 PG integration: pre-request LIST ambiguity (an untyped refund row at the provider) → PROVIDER_PROOF_FAILED, DB unchanged, ZERO request; lost cancel reply → WRITE_OUTCOME_UNKNOWN (ONE PUT, zero refund / mirror); lost MIRROR reply → WRITE_OUTCOME_UNKNOWN / LOST_MIRROR_REPLY with ONE mirror POST, the accepted mirror worker settles the row unknown, a SECOND SESSION refuses read-only with ZERO resend; 401 → no write", async () => {
    { const a = await recordedIntent(); const before = await snap(a.id); const w = pgWorld(a, { listMutate: (rows) => [...rows, { id: 777001, reservationId: Number(a.rid), listingMapId: LIST, type: "refund", title: "legacy refund", amount: -1, currency: "USD", status: "succeeded", paymentProvider: "offline", paymentMethod: "credit_card" }] });
      const r = await pgRun(a, w);
      assert.deepEqual([r.outcome, r.code, r.requestInvocations, w.cancelRequests, w.mirrorRequests], ["PROVIDER_PROOF_FAILED", "LIST_MIRROR_DISCOVERY_AMBIGUOUS", 0, 0, 0], JSON.stringify(r)); assert.deepEqual(await snap(a.id), before); }
    { const a = await recordedIntent(); const w = pgWorld(a, { cancelLost: true }); const r = await pgRun(a, w);
      assert.deepEqual([r.outcome, r.code, r.cancelInvocations, r.cancelOutcome, r.refundInvocations, r.mirrorInvocations, w.cancelRequests, w.refundRequests, w.mirrorRequests], ["WRITE_OUTCOME_UNKNOWN", "LOST_CANCEL_REPLY", 1, "UNKNOWN", 0, 0, 1, 0, 0], JSON.stringify(r));
      const s = await snap(a.id); assert.deepEqual([s.st.state, s.suppressions, s.locks], ["test_cleanup_pending", 1, 0]);
      assert.deepEqual(s.ops.filter((x) => x.op_type === CAN).map((x) => [x.state, x.attempts, x.d]), [["outcome_unknown", 1, true]]);
      const a2 = { ...a, intent: await R.loadIntent(db.app, a.id) }; const w2 = pgWorld(a2); const r2 = await pgRun(a2, w2);
      assert.deepEqual([r2.outcome, r2.code, w2.calls.length, w2.cancelRequests], ["START_STATE_NOT_ELIGIBLE", "STATE_NOT_CONFIRMED", 0, 0]); }
    for (const landed of [false, true]) {
      const a = await recordedIntent(); const w = pgWorld(a, { mirrorLost: true, mirrorLandedAnyway: landed }); const r = await pgRun(a, w);
      assert.deepEqual([r.outcome, r.code, r.cancelInvocations, r.refundInvocations, r.mirrorInvocations, r.mirrorOutcome, r.mirrorTransportPosts, w.mirrorRequests], ["WRITE_OUTCOME_UNKNOWN", "LOST_MIRROR_REPLY", 1, 1, 1, "UNKNOWN", 1, 1], `landed=${landed}: ${JSON.stringify(r)}`);
      const s = await snap(a.id); assert.deepEqual([s.st.state, s.st.c, s.st.a, s.st.m, s.claim[0].released, s.locks], ["test_cleanup_pending", true, true, false, false, 0]);
      assert.deepEqual(s.ops.filter((x) => x.op_type === MIR).map((x) => [x.state, x.attempts, x.d]), [["outcome_unknown", 1, true]], "the accepted mirror worker settles the row unknown; never a second POST");
      assert.ok(r.actions.some((x) => /^M:MIRROR_UNKNOWN:/.test(x)), JSON.stringify(r.actions));
      const a2 = { ...a, intent: await R.loadIntent(db.app, a.id) }; const w2 = pgWorld(a2); const r2 = await pgRun(a2, w2);
      assert.deepEqual([r2.outcome, w2.calls.length, w2.mirrorRequests], ["START_STATE_NOT_ELIGIBLE", 0, 0], "a later session: read-only refusal, zero resend");
    }
    { const a = await recordedIntent(); const w = pgWorld(a, { hostawayStatus: 401 }); const r = await pgRun(a, w);
      assert.deepEqual([r.outcome, r.code, r.requestInvocations, w.cancelRequests, (await snap(a.id)).locks], ["PROVIDER_PROOF_FAILED", "RESERVATION_READ_401", 0, 0, 0], JSON.stringify(r)); }
  });

  test("I3 PG integration: real lock conflict (another session holds LOCK_KEY) → LOCK_NOT_ACQUIRED, zero provider calls, zero DB writes; historic / stale version / wrong amount / PI / reservation / charge / original charge / session pins refuse read-only; the 0019–0021 schema prerequisite is READ (all flags true; never applied); deadline at the final read → never success, facts observed", async () => {
    { const a = await recordedIntent(); const before = await snap(a.id);
      const holder = new pg.Client({ connectionString: db.reportUrl() }); await holder.connect();
      try { await holder.query("SELECT pg_advisory_lock(pg_catalog.hashtext($1), 0)", [LK.LOCK_KEY]);
        const w = pgWorld(a); const r = await pgRun(a, w);
        assert.deepEqual([r.outcome, r.code, w.calls.length, r.requestInvocations, r.lock], ["LOCK_NOT_ACQUIRED", "RUN_LOCK_PRESENT", 0, 0, "not_acquired"]);
        const after1 = await snap(a.id); assert.deepEqual({ ...after1, locks: 0 }, { ...before, locks: 0 });
      } finally { await holder.end(); } }
    const a = await recordedIntent();
    const sch = (await db.app.query(E.QUERIES.schema)).rows[0]; assert.deepEqual(Object.keys(sch).sort(), [...SCHEMA_FLAGS].sort()); assert.deepEqual(Object.values(sch), Object.values(sch).map(() => true), JSON.stringify(sch));
    for (const [over, outcome, code] of [[{ notBefore: new Date(F.at(0) + MINUTE).toISOString() }, "START_STATE_NOT_ELIGIBLE", "HISTORIC_INTENT"], [{ expectedVersion: a.intent.version + 1 }, "START_STATE_NOT_ELIGIBLE", "VERSION_NOT_PINNED"],
      [{ capturedMinor: a.total + 1 }, "SCOPE_REFUSED", "AMOUNT_NOT_PINNED"], [{ paymentIntentId: "pi_HRTother00000001" }, "SCOPE_REFUSED", "PAYMENT_INTENT_NOT_PINNED"], [{ reservationId: String(Number(a.rid) + 1) }, "SCOPE_REFUSED", "RESERVATION_NOT_PINNED"],
      [{ chargeId: "ch_test_other000000000" }, "SCOPE_REFUSED", "CAPTURE_ROW_NOT_BOUND"], [{ offlineChargeId: String(Number(a.offlineChargeId) + 1) }, "SCOPE_REFUSED", "OFFLINE_CHARGE_NOT_PINNED"],
      [{ sessionId: "cs_test_other0000000" }, "SCOPE_REFUSED", "SESSION_NOT_PINNED"], [{ attemptId: "00000000-0000-4000-8000-00000000abcd" }, "SCOPE_REFUSED", "PAYMENT_ATTEMPT_NOT_BOUND"]]) {
      const w = pgWorld(a); const r = await pgRun(a, w, {}, over);
      assert.deepEqual([r.outcome, r.code, w.calls.length, r.requestInvocations, r.steps], [outcome, code, 0, 0, 0], code);
    }
    { let reads = 0; const w = pgWorld(a); const q = db.app.query.bind(db.app);
      const pool = { query: async (sql, params) => { const res = await q(sql, params); if (/e7hrt:claims/.test(String(sql))) { const st = (await q("SELECT state FROM booking.intents WHERE id = $1", [a.id])).rows[0].state; if (st === "cancelled") reads += 1; } return res; }, connect: () => db.app.connect() };
      let m = 0; const monotonic = () => (reads > 0 ? 30 * 60 * 1000 : (m += 1, 0));
      const r = await pgRun(a, w, { pool, monotonic });
      assert.deepEqual([r.outcome, r.factsObserved, r.finalState, r.cancelInvocations, r.refundInvocations, r.mirrorInvocations], ["DEADLINE", true, "cancelled", 1, 1, 1], JSON.stringify(r));
      assert.equal((await snap(a.id)).locks, 0); }
  });

  test("I4 PG integration (stop discipline through the REAL workers): a lock-session error on the REAL dedicated lock client (a) as the mirror worker completes (afterComplete): its signal is already aborted, the terminal event is DEFERRED (row succeeded + linked, intent pending, claim HELD), runner LOCK_LOST, no resend; (b) in flight after the mirror send: the row settles unknown, zero resend; (c) control: an error AFTER the committed terminal reports the committed effects truthfully", async () => {
    const withLock = () => { const h = { lc: null }; h.factory = async () => { h.lc = await db.app.connect(); return h.lc; }; return h; };
    { const a = await recordedIntent(); const w = pgWorld(a); const L = withLock(); let signalAborted = null; let emitted = 0;
      const tooling = { ...realTooling, runMirrorStep: (pool, opts) => MW.runMirrorStep(pool, { ...opts, hooks: { afterComplete: async () => { emitted += 1; L.lc.emit("error", new Error("ROOT_SYNTHETIC_LOCK_ERROR")); signalAborted = opts.signal.aborted; } } }) };
      const r = await pgRun(a, w, { lockClientFactory: L.factory, tooling });
      const s = await snap(a.id);
      assert.deepEqual([emitted, signalAborted, r.outcome, r.code, r.lockSession, r.lock, r.mirrorInvocations, r.mirrorOutcome, w.mirrorRequests], [1, true, "LOCK_LOST", "STOP_LOCK_SESSION_ERROR", "error_observed", "session_error_connection_destroyed", 1, "REPLIED", 1], JSON.stringify(r));
      assert.ok(r.actions.includes("M:COMPLETED:EVENT_DEFERRED"), JSON.stringify(r.actions));
      assert.deepEqual([s.st.state, s.st.c, s.st.a, s.st.m, s.claim[0].released, s.locks], ["test_cleanup_pending", true, true, false, false, 0], JSON.stringify(s.st));
      assert.deepEqual(s.ops.filter((x) => x.op_type === MIR).map((x) => [x.state, x.attempts, x.linked]), [["succeeded", 1, true]], "the durable succeeded mirror row is preserved, never rewritten");
      assert.equal(JSON.stringify(r).includes("ROOT_SYNTHETIC"), false, "no raw error text");
      const a2 = { ...a, intent: await R.loadIntent(db.app, a.id) }; const w2 = pgWorld(a2); const r2 = await pgRun(a2, w2);
      assert.deepEqual([r2.outcome, w2.calls.length, w2.mirrorRequests], ["START_STATE_NOT_ELIGIBLE", 0, 0]); }
    { const a = await recordedIntent(); const w = pgWorld(a); const L = withLock(); let signalAborted = null;
      const tooling = { ...realTooling, runMirrorStep: (pool, opts) => MW.runMirrorStep(pool, { ...opts, hooks: { afterSend: async () => { if (signalAborted === null) { L.lc.emit("error", new Error("ROOT_SYNTHETIC_LOCK_ERROR")); signalAborted = opts.signal.aborted; } } } }) };
      const r = await pgRun(a, w, { lockClientFactory: L.factory, tooling });
      const s = await snap(a.id);
      assert.deepEqual([signalAborted, r.outcome, r.mirrorInvocations, w.mirrorRequests, s.st.state, s.claim[0].released, s.locks], [true, "LOCK_LOST", 1, 1, "test_cleanup_pending", false, 0], JSON.stringify(r));
      assert.deepEqual(s.ops.filter((x) => x.op_type === MIR).map((x) => [x.state, x.attempts]), [["outcome_unknown", 1]], "in-flight stop: the accepted mirror worker settles the row unknown; never a second POST"); }
    { const a = await recordedIntent(); const w = pgWorld(a); const L = withLock(); let steps = 0;
      const tooling = { ...realTooling, runMirrorStep: async (pool, opts) => { const out = await MW.runMirrorStep(pool, opts); steps += 1; L.lc.emit("error", new Error("ROOT_SYNTHETIC_LOCK_ERROR")); return out; } };
      const r = await pgRun(a, w, { lockClientFactory: L.factory, tooling });
      const s = await snap(a.id);
      assert.deepEqual([steps, r.outcome, r.code, r.finalState, r.claimHeld, r.mirrorOps, s.st.state, s.claim[0].released, s.locks], [1, "LOCK_LOST", "STOP_LOCK_SESSION_ERROR", "cancelled", false, ["succeeded"], "cancelled", true, 0], JSON.stringify(r));
      assert.equal(r.postcheck, null, "never success after a latched session error; the committed effects are reported, not rolled back"); }
  });
}
