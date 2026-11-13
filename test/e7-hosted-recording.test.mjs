// test/e7-hosted-recording.test.mjs — E7 Slice 4 hosted RECORDING runner: FAKE DB / worker with the REAL accepted transports, executor adapters and pure
// proofs from the pinned tooling (dependency-free: nothing here imports `pg`); the hosted wrapper; the closure / runner pins; the workflow. NO network:
// every real network primitive is replaced with a throwing guard before the runner is imported. OPT-IN real-PostgreSQL integration (E7_HRC_DB_TESTS=1)
// drives the REAL accepted recording worker on a disposable cluster with FAKE exchanges only.
// Fixtures are SYNTHETIC: 'hostaway-e7-test' / 'credit_card' are the ROOT-reviewed TEST configuration, not production accounting policy.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { readFileSync, realpathSync, mkdtempSync, cpSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

const GUARD = { request: 0, Agent: 0, fetch: 0 };
https.request = () => { GUARD.request += 1; throw new Error("network refused"); };
https.Agent = class { constructor() { GUARD.Agent += 1; throw new Error("network refused"); } };
globalThis.fetch = async () => { GUARD.fetch += 1; throw new Error("network refused"); };
syncBuiltinESMExports();
const ROOT = realpathSync(join(dirname(fileURLToPath(import.meta.url)), ".."));
const TOOLING = realpathSync(process.env.E7_TOOLING_DIR || join(ROOT, "..", "tooling"));
const tool = (p) => import(pathToFileURL(join(TOOLING, p)).href);
const E = await import("../scripts/e7-hosted-recording.mjs");
const RESRUN = await import("../scripts/e7-hosted-reservation.mjs");
const CAPRUN = await import("../scripts/e7-hosted-capture.mjs");
const TCRUN = await import("../scripts/e7-hosted-test-cleanup.mjs");
// dependency-free tooling modules ONLY (PR70 lesson: the hosted preflight job never installs `pg`; repo.js / pool.js / recording-worker.js are loaded in the opt-in PG section)
const [EX, T, HR, CO, OP, IS, LK, C1] = await Promise.all([tool("scripts/e7-connected/executor-adapters.mjs"), tool("scripts/e7-connected/http-transports.mjs"),
  tool("lib/hostaway-reservations.js"), tool("lib/checkout/compensation-proof.js"), tool("lib/checkout/offline-charge-proof.js"), tool("lib/checkout/intent-state.js"),
  tool("scripts/e7-connected/run-lock-precheck.mjs"), tool("scripts/e7-connected/probe-env-preflight.mjs")]);
after(() => { assert.deepEqual(GUARD, { request: 0, Agent: 0, fetch: 0 }, "no real network primitive was touched"); });

const C = E.CONSTANTS;
const IID = "11111111-2222-4333-8444-555555555555"; const PI = "pi_FAKEhostedRc0001"; const VER = 7; const REF = "MV-FAKE0001";
const AMT = 14000; const FROM = "2026-11-25"; const TO = "2026-11-26"; const NB = "2026-11-12T00:00:00.000Z"; const CREATED = Date.UTC(2026, 10, 12, 15, 0, 0);
const RECORDED_AT = CREATED + 60 * 1000; const SCHEDULED = "2026-11-12 15:01:00";
const ATTEMPT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"; const RID = "71999901"; const CH = "ch_FAKEhostedRc0001"; const CS = "cs_test_FAKEhostedRc0001";
const RUN_ID = "run-20261112-000000001-1"; const KEY = `och:${IID}:1`; const TITLE = `maraVilla payment mvoch1-${IID}`; const CHARGE_ID = "9000001";
const LIST_URL = `/v1/guestPayments/charges?limit=500&reservationIds=${RID}`; const POST_URL = `/v1/guestPayments/charges/${RID}`;
const enc = (o) => new TextEncoder().encode(JSON.stringify(o));
const planInput = (over = {}) => ({ approvalRef: "SYNTHETIC-hosted-rc", intentId: IID, expectedVersion: VER, notBefore: NB, paymentIntentId: PI, reservationId: RID, chargeId: CH, capturedMinor: AMT,
  from: FROM, to: TO, guests: 1, attemptId: ATTEMPT, sessionId: CS, runnerDigest: "0".repeat(64), ...over });
const built = (over = {}) => E.buildPlan(C, planInput(over));
const op = (op_type, over = {}) => ({ id: `op-${op_type}`, op_type, state: "succeeded", attempts: 1, idempotency_key: null, dispatched: true, leased: false, late_result_status: null, result_ref: null, settled_evidence: false,
  payload_rid: null, payload_pi: null, payload_charge: null, payload_attempt: null, payload_amount: null, payload_key: null, payload_keys: 0, ...over });
const CAP = "stripe.capture_payment_intent"; const REC = "hostaway.record_offline_charge"; const NOTIFY = "guest.notify";
const rowOf = (w, t) => w.ops.find((x) => x.op_type === t);

function world(o = {}) {
  const w = { status: o.status ?? "payment_captured", version: VER, ops: [], hx: [{ state: "succeeded", rid: RID }], claimReleased: false, calls: [], workerCalls: 0, res: RID, echoRef: o.echoRef ?? true,
    lease: null, createdAt: o.createdAt ?? CREATED, resStatus: "new", lockRows: 1, captureAttempts: 1, offlineChargeAttempts: 0, holds: 0, offlineChargeId: null, recordedRows: [{ recorded_at: new Date(RECORDED_AT) }],
    charges: [...(o.charges ?? [])], nextChargeId: Number(CHARGE_ID), postRequests: 0, reasonCode: null, workLeased: false,
    ledger: [{ entry: "authorization_accepted", amt: String(AMT), currency: "USD", provider_ref: PI }, { entry: "capture_succeeded", amt: String(AMT), currency: "USD", provider_ref: PI }],
    evidence: [{ kind: "payment_intent", external_ref: PI, status: "succeeded" }, { kind: "hostaway_reservation", external_ref: RID, status: "new" }],
    schema: Object.fromEntries(["complete_fn", "holds", "assessments", "claim_assessments", "confirmed_state"].map((k) => [k, true])) };
  w.ops.push(op("stripe.create_checkout_session", { result_ref: CS }), op("stripe.retrieve_checkout_session"), op("stripe.retrieve_payment_intent"));
  w.ops.push(op("hostaway.create_reservation", { result_ref: RID }));
  w.ops.push(op(CAP, { result_ref: CH, payload_pi: PI, payload_attempt: 1, payload_amount: AMT, payload_key: `cap:${IID}:${PI}` }));
  w.ops.push(op(REC, { state: "pending", attempts: 0, dispatched: false, idempotency_key: KEY, payload_rid: RID, payload_amount: AMT, payload_keys: 2 }));
  return w;
}
const intentOf = (w) => ({ id: IID, status: w.status, version: w.version, listingId: 606998, from: FROM, to: TO, guests: 1, ref: REF, createdAt: w.createdAt,
  price: { currency: "USD", finalTotalMinor: AMT, rateBps: 1000 }, payment: { paymentIntentId: PI, livemode: false, capturedMinor: AMT, amountMinor: AMT, currency: "USD", captureBefore: CREATED + 7 * 86400000 },
  reservation: w.res ? { reservationId: w.res, confirmedAt: CREATED } : null, counters: { captureAttempts: w.captureAttempts, voidAttempts: 0, cancelAttempts: 0, offlineChargeAttempts: w.offlineChargeAttempts, reservationAttempts: 1 },
  checkout: { sessionId: CS, attempt: 1 }, lease: w.lease, dispatch: { at: CREATED, attempt: 1 }, reasonCode: w.reasonCode, offlineChargeId: w.offlineChargeId });
function fakePool(w, o = {}) {
  const tag = (sql) => /\/\*e7hrc:(\w+)\*\//.exec(sql)?.[1];
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
      case "ledger": return { rows: w.ledger.map((x) => ({ ...x })) };
      case "evidence": return { rows: w.evidence.map((x) => ({ ...x })) };
      case "row": return { rows: [{ environment: o.intentEnv ?? "test", reason_code: w.reasonCode, offline_charge_id: w.offlineChargeId, cap: String(AMT) }] };
      case "recorded": return { rows: w.recordedRows.map((x) => ({ ...x })) };
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
        return { rows: [{ n: typeof o.lockLostAt === "number" && cl.proofs >= o.lockLostAt ? 0 : w.lockRows, pid: cl.pid }] };   // proof 1 = acquisition, 2 = BEFORE_WORKER, 3 = BEFORE_READBACK
      }
      if (tag(sql) === "identity") return { rows: [{ db: o.lockDb ?? "fake", environment: "test" }] };
      throw new Error(`unexpected lock SQL ${sql.slice(0, 40)}`);
    }, release(destroy) { w.lockReleased = destroy === true ? "destroyed" : "pooled"; }, on(ev, fn) { if (ev === "error") cl.errorFn = fn; } };
    w.lockClient = cl; return cl; };
  return p;
}
const resObj = (w, id = RID) => ({ id: Number(id), listingMapId: 606998, channelId: 2000, arrivalDate: FROM, departureDate: TO, totalPrice: 140, currency: "USD", status: w.resStatus,
  customFieldValues: w.echoRef ? [{ customFieldId: C.refFieldId, value: REF }] : [] });
/** a SYNTHETIC, DOC-DERIVED charge row (LIVE-UNVERIFIED shape) */
const chargeRow = (over = {}) => ({ id: Number(CHARGE_ID), listingMapId: 606998, reservationId: Number(RID), type: "charge", title: TITLE, currency: "USD", paymentMethod: "credit_card", amount: 140, status: "paid", paymentProvider: "offline", ...over });
function exchanges(w, o = {}) {
  const reply = (status, obj) => Promise.resolve({ status, contentType: "application/json", bytes: enc(obj) });
  const hostaway = (req) => {
    const p = req.url.replace("https://api.hostaway.com", ""); w.calls.push(`H:${req.method} ${p}`);
    if (o.hostawayStatus) return reply(o.hostawayStatus, { status: "fail", message: "unauthorized" });
    if (req.method === "POST") {
      assert.equal(p, POST_URL); assert.equal(req.headers["Content-Type"], "application/json");
      const body = JSON.parse(req.body);
      assert.deepEqual(body, { title: TITLE, amount: 140, paymentMethod: "credit_card", status: "paid", scheduledDate: SCHEDULED });
      w.postRequests += 1;
      const ch = chargeRow({ id: w.nextChargeId++ });
      if (o.postLost) { if (o.postLandedAnyway) w.charges.push(ch); return Promise.reject(new Error("socket reset")); }
      w.charges.push(ch); return reply(o.postStatus ?? 201, { status: "success", result: { ...ch } });
    }
    if (req.method === "GET" && p.startsWith("/v1/guestPayments/charges?")) {
      assert.equal(p, LIST_URL); w.listReads = (w.listReads ?? 0) + 1;
      if (o.listMutate) { const m = o.listMutate(w.listReads, w); if (m) return reply(m.status ?? 200, m.json); }
      return reply(200, { status: "success", result: w.charges.map((x) => ({ ...x })), count: w.charges.length, limit: 500, offset: null });
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
  return { hostaway };
}
/** the fake worker: drives the REAL accepted recording executors (→ real transport → the runner fence → fake exchange) the way the accepted worker's happy step does:
 *  identity read → list read → assessment / claim → ONE POST → confirming list read → completion with evidence → OFFLINE_CHARGE_RECORDED → confirmed (+ ONE queued guest.notify) */
function fakeWorker(w, o = {}) {
  return async (pool, { executors, intentId, env, listings, signal, deadlineAt, workerId, clock }) => {
    w.workerCalls += 1;
    assert.equal(intentId, IID); assert.deepEqual(env, { VERCEL_ENV: "development", MV_E7_RECORDING_WORKER: "enabled" });
    assert.deepEqual([...listings.keys()], [606998]); assert.deepEqual(listings.get(606998), { accountRef: "hostaway-e7-test", channelId: 2000, currency: "USD", listingId: 606998, paymentMethod: "credit_card", refFieldId: C.refFieldId });
    assert.deepEqual(Object.keys(executors).sort(), [...EX.PHASE_KEYS.recording].sort()); assert.deepEqual(executors.label, { accountRef: "hostaway-e7-test", clientSnapshotId: RUN_ID });
    assert.ok(signal instanceof AbortSignal && Number.isFinite(deadlineAt) && deadlineAt > clock() && /^e7-hosted-rc:/.test(workerId));
    const sig = AbortSignal.timeout(5000); const actions = []; const rec = rowOf(w, REC);
    const out = (extra = {}) => { w.signalAbortedAtEnd = signal.aborted; return { status: "worked", intentId: IID, actions, calls: [], writes: 0, delayMs: o.delayMs ?? 0, workReleased: true, stop: null, late: Promise.resolve({ kind: "none" }), ...extra }; };
    // routing (the accepted worker §5.2): a succeeded + linked row only ever gets its success event — never a second send
    if (rec.state === "succeeded" && w.status === "payment_captured") {
      if (o.deferEvent) { actions.push("STOP:SIGNAL:before_OFFLINE_CHARGE_RECORDED", "RECORDED!STOPPED"); return out({ stop: { code: "SIGNAL", where: "before_OFFLINE_CHARGE_RECORDED" } }); }
      w.status = "confirmed"; w.version += 1; w.offlineChargeId = rec.result_ref; w.ledger.push({ entry: "offline_charge_recorded", amt: String(AMT), currency: "USD", provider_ref: rec.result_ref });
      w.ops.push(op(NOTIFY, { id: "op-notify", state: "pending", attempts: 0, dispatched: false })); actions.push("RECORDED->confirmed"); return out();
    }
    try {
      if (o.foreignRead) await executors.retrieveReservation({ method: "GET", path: `/v1/reservations/${C.protectedReservationIds[0]}`, query: {} }, { signal: sig });
      if (o.wait) { actions.push("WAIT:FAKE"); return out({ delayMs: 30000 }); }
      const rr = await executors.retrieveReservation({ method: "GET", path: `/v1/reservations/${RID}`, query: {} }, { signal: sig });
      if (rr.httpStatus !== 200) { actions.push(`STOP:AUTH_${rr.httpStatus}`); return out(); }
      await executors.listOfflineCharges({ method: "GET", path: "/v1/guestPayments/charges", query: { limit: 500, reservationId: RID } }, { signal: sig });
      if (o.hold) { w.holds = 1; actions.push("HOLD:PREFLIGHT"); return out({ delayMs: 30000 }); }
      if (o.escalate) { w.status = "reconciliation_required"; w.version += 1; actions.push("ESCALATE:RECORDING_AMOUNT_NOT_EXACT"); return out({ delayMs: 30000 }); }
      actions.push("ASSESSED:eligible");
      Object.assign(rec, { state: "in_flight", attempts: 1, dispatched: true, leased: true }); w.offlineChargeAttempts = 1; actions.push("CLAIMED");   // the accepted worker claims the row BEFORE the send
      const body = { title: o.wrongTitle ?? TITLE, amount: o.wrongAmount ?? 140, paymentMethod: o.wrongMethod ?? "credit_card", status: "paid", scheduledDate: o.wrongDate ?? SCHEDULED };
      let reply = null;
      try { reply = await executors.createOfflineCharge({ method: "POST", path: POST_URL, query: {}, body }, { signal: sig }); }
      catch (e) { actions.push(`SEND_FAILED:${e && e.code ? e.code : "TRANSPORT"}`); }
      if (o.twice) { try { await executors.createOfflineCharge({ method: "POST", path: POST_URL, query: {}, body }, { signal: sig }); } catch { actions.push("SECOND_POST_REFUSED"); } }
      if (!reply || ![200, 201].includes(reply.httpStatus)) { Object.assign(rec, { state: "outcome_unknown", leased: false }); actions.push("UNKNOWN:WRITE_CALL_FAILED"); return out({ writes: 1 }); }
      const lr = await executors.listOfflineCharges({ method: "GET", path: "/v1/guestPayments/charges", query: { limit: 500, reservationId: RID } }, { signal: sig });   // the confirming read
      const marked = lr.json.result.filter((x) => x.title === TITLE);
      if (marked.length !== 1) { Object.assign(rec, { state: "outcome_unknown", leased: false }); actions.push("UNKNOWN:CONFIRM_NOT_EXACTLY_ONE"); return out({ writes: 1 }); }
      const id = String(marked[0].id);
      Object.assign(rec, { state: o.recRowStateAfter ?? "succeeded", result_ref: id, settled_evidence: !o.noEvidenceLink, leased: false }); actions.push("COMPLETED");
      w.evidence.push({ kind: "hostaway_offline_charges", external_ref: RID, status: "listed" });
      if (o.deferEvent) { actions.push("COMPLETED:EVENT_DEFERRED"); return out({ writes: 1, stop: { code: "SIGNAL", where: "after_complete" } }); }
      w.status = "confirmed"; w.version += 1; w.offlineChargeId = id;
      w.ledger.push({ entry: "offline_charge_recorded", amt: String(AMT), currency: "USD", provider_ref: id });
      if (!o.noNotify) w.ops.push(op(NOTIFY, { id: "op-notify", state: o.notifyState ?? "pending", attempts: 0, dispatched: false }));
      if (o.releaseClaim) w.claimReleased = true;
      actions.push("RECORDED->confirmed");
      return out({ writes: 1 });
    } catch (e) {
      actions.push(`STOP:EXECUTOR_${/stopped/.test(String(e && e.message)) ? "STOPPED" : "FAILED"}`);
      if (rec && rec.state === "in_flight") Object.assign(rec, { state: "outcome_unknown", leased: false });
      return out();
    }
  };
}
const toolingFor = (w, o = {}) => ({ runRecordingStep: o.worker ?? fakeWorker(w, o), loadIntent: async () => intentOf(w), createPhaseExecutors: EX.createPhaseExecutors, createHostawaySend: T.createE7HostawaySend,
  validateAdapterConfig: HR.validateAdapterConfig, unwrapEnvelope: HR.unwrapEnvelope, normalizeReservation: HR.normalizeReservation, activeReservationProof: CO.activeReservationProof,
  assessChargeList: OP.assessChargeList, preflightListObservation: OP.preflightListObservation, classifyTitle: OP.classifyTitle, providerIdToCanonical: OP.providerIdToCanonical, amountToMinor: HR.amountToMinor,
  publicStatus: IS.publicStatus, LOCK_KEY: LK.LOCK_KEY, LOCK_PRECHECK_SQL: LK.LOCK_PRECHECK_SQL });
function core(w, o = {}) {
  const pool = o.pool ?? fakePool(w, o); w.pool = pool;
  const x = exchanges(w, o);
  const b = o.built ?? built();
  return E.runRecordingCore({ plan: b.plan, planHash: o.planHash ?? b.planHash, runId: o.runId ?? RUN_ID, pool, lockClientFactory: () => pool.lock(), tooling: { ...toolingFor(w, o), ...(o.toolingOver ?? {}) },
    exchanges: o.wrapExchanges ? o.wrapExchanges(x) : x, credentials: { hostaway: () => "synthetic-hostaway-token" }, sleep: async () => {}, runSignal: o.signal, monotonic: o.monotonic,
    clock: () => (o.clockBase ?? Date.UTC(2026, 10, 12, 16, 0, 0)) + (w.tick = (w.tick ?? 0) + 1000) });
}
const posts = (w) => w.calls.filter((x) => /^H:(POST|PUT|DELETE)/.test(x));

// ---------------------------------------------------------------------------------------------------------------------------------
test("A1 happy path (FAKE DB / worker, REAL transport + executor adapters + pure proofs): active reservation (ref ECHOED) + ONE empty preflight list, lock proven before EVERY step, exactly ONE offline-charge POST (exact URL / body), confirmed, ONE queued PRISTINE guest.notify, lock released; a NON-echoed ref is refused BEFORE the worker (the accepted worker requires it)", async () => {
  { const w = world({ echoRef: false }); const r = await core(w);
    assert.deepEqual([r.outcome, r.code, w.workerCalls, posts(w).length, w.calls.some((x) => x.startsWith("H:GET /v1/reservations?"))], ["PROVIDER_PROOF_FAILED", "REF_NOT_ECHOED", 0, 0, false], "no by-ref lookup exists in this runner"); }
  for (const echoRef of [true]) {
    const w = world({ echoRef });
    const r = await core(w);
    assert.equal(r.outcome, "RECORDING_CONFIRMED", JSON.stringify(r));
    assert.deepEqual([r.steps, r.recordInvocations, r.recordOutcome, r.reservationId, r.capturedMinor, r.offlineChargeId, r.clientSnapshotId, r.lock, w.lockReleased, r.publicStatus, r.finalVersion],
      [1, 1, "REPLIED", RID, AMT, CHARGE_ID, RUN_ID, "released", "pooled", "confirmed", VER + 1]);
    assert.deepEqual(posts(w), [`H:POST ${POST_URL}`], "exactly ONE write; nothing else");
    assert.deepEqual(r.proofs, ["PROVIDER_BEFORE_WORKER", "BEFORE_WORKER", "BEFORE_READBACK", "READBACK"]);
    assert.deepEqual(r.postcheck, { recordingOps: 1, offlineChargeId: CHARGE_ID, capturedMinor: AMT, notifyQueuedPristine: 1, holds: 0, claimHeld: true, openCases: 0, publicStatus: "confirmed" });
    assert.deepEqual(r.writes, { record: 1, capture: 0, create: 0, cancel: 0, refund: 0, notify: 0, void: 0, stripe: 0 });
    assert.deepEqual([r.recordingOps, r.notifyOps, r.holds, r.claimHeld], [["succeeded"], ["pristine"], 0, true]);
    assert.ok(r.actions.includes("RECORDED->confirmed") && r.actions.includes("CLAIMED"));
    assert.equal(w.calls.filter((x) => x === `H:GET ${LIST_URL}`).length, 4, "runner preflight list + the worker's preflight + confirming list + the runner's readback");
    assert.equal(w.calls.filter((x) => x === `H:GET /v1/reservations/${RID}`).length, 2, "runner identity read + the worker's identity read");
    assert.equal(w.calls.some((x) => /^S:/.test(x) || /stripe/.test(x)), false, "no Stripe exchange exists in this runner");
    assert.equal(JSON.stringify(r).includes("synthetic-hostaway-token"), false);
  }
});

test("A2 provider proofs gate the worker: cancelled / wrong-channel / foreign-ref / past-created reservation, a PRIOR marked charge, a lookalike, a same-amount paid charge, a count mismatch, 401 → PROVIDER_PROOF_FAILED with ZERO worker calls and ZERO writes", async () => {
  const cases = [
    [{ preResMutate: (o) => ({ ...o, status: "cancelled" }) }, /^RESERVATION_/],
    [{ preResMutate: (o) => ({ ...o, channelId: 2005 }) }, /CHANNEL_NOT_DIRECT/],
    [{ preResMutate: (o) => ({ ...o, customFieldValues: [{ customFieldId: C.refFieldId, value: "MV-OTHER001" }] }) }, /BOOKING_REF_MISMATCH/],
    [{ charges: [chargeRow({ id: 8800001 })] }, /^PRIOR_MARKED_CHARGE_PRESENT$/],
    [{ charges: [chargeRow({ id: 8800002, title: `maraVilla payment mvoch1-${IID} (dup)`, amount: 1 })] }, /^LOOKALIKE_CHARGE_PRESENT$/],
    [{ charges: [chargeRow({ id: 8800003, title: "Accommodation payment" })] }, /^SAME_AMOUNT_CHARGE_PRESENT$/],
    [{ listMutate: () => ({ json: { status: "success", result: [], count: 3 } }) }, /^LIST_COUNT_LENGTH_MISMATCH$/],
    [{ hostawayStatus: 401 }, /^RESERVATION_READ_401$/],
  ];
  for (const [o, re] of cases) {
    const w = world(o); const r = await core(w, o);
    assert.equal(r.outcome, "PROVIDER_PROOF_FAILED", JSON.stringify([o, r.code])); assert.match(String(r.code), re, JSON.stringify(o));
    assert.deepEqual([w.workerCalls, r.recordInvocations, posts(w).length, r.steps, r.lock], [0, 0, 0, 0, "released"], JSON.stringify(o));
  }
});

test("A3 start refusals (read-only, ZERO provider calls, ZERO lock, ZERO worker): state / version / pins / historic / protected / open case / forbidden op / recording not pristine or unbound / hold / already linked / notify present / lease / work lease / claim / non-TEST / ambiguous recorded time / schema prerequisite missing", async () => {
  const cases = [
    [(w) => { w.status = "confirmed"; }, {}, "START_STATE_NOT_ELIGIBLE", "STATE_NOT_PAYMENT_CAPTURED"],
    [(w) => { w.version = VER + 1; }, {}, "START_STATE_NOT_ELIGIBLE", "VERSION_NOT_PINNED"],
    [() => {}, { built: built({ paymentIntentId: "pi_OTHER000000001" }) }, "SCOPE_REFUSED", "PAYMENT_INTENT_NOT_PINNED"],
    [() => {}, { built: built({ reservationId: "71999902" }) }, "SCOPE_REFUSED", "RESERVATION_NOT_PINNED"],
    [() => {}, { built: built({ chargeId: "ch_OTHER0000000001" }) }, "SCOPE_REFUSED", "CAPTURE_ROW_NOT_BOUND"],
    [() => {}, { built: built({ capturedMinor: AMT + 100 }) }, "SCOPE_REFUSED", "AMOUNT_NOT_PINNED"],
    [() => {}, { built: built({ from: "2026-11-24" }) }, "SCOPE_REFUSED", "STAY_NOT_PINNED"],
    [() => {}, { built: built({ sessionId: "cs_test_OTHER00000001" }) }, "SCOPE_REFUSED", "SESSION_NOT_PINNED"],
    [() => {}, { built: built({ attemptId: "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee" }) }, "SCOPE_REFUSED", "PAYMENT_ATTEMPT_NOT_BOUND"],
    [(w) => { w.createdAt = Date.parse(NB) - 1; }, {}, "START_STATE_NOT_ELIGIBLE", "HISTORIC_INTENT"],
    [(w) => { w.res = C.protectedReservationIds[0]; }, {}, "SCOPE_REFUSED", "RESERVATION_NOT_PINNED"],
    [() => {}, { cases: 1 }, "SCOPE_REFUSED", "OPEN_CASE"],
    [(w) => { w.ops.push(op("stripe.void_payment_intent", { state: "pending", attempts: 0, dispatched: false })); }, {}, "SCOPE_REFUSED", "FORBIDDEN_OP_PRESENT"],
    [(w) => { w.ops.push(op("hostaway.cancel_reservation", { state: "pending", attempts: 0, dispatched: false })); }, {}, "SCOPE_REFUSED", "FORBIDDEN_OP_PRESENT"],
    [(w) => { Object.assign(rowOf(w, REC), { attempts: 1, dispatched: true }); }, {}, "START_STATE_NOT_ELIGIBLE", "RECORDING_NOT_PRISTINE"],
    [(w) => { Object.assign(rowOf(w, REC), { state: "succeeded", result_ref: CHARGE_ID }); }, {}, "START_STATE_NOT_ELIGIBLE", "RECORDING_NOT_PRISTINE"],
    [(w) => { Object.assign(rowOf(w, REC), { payload_amount: AMT + 1 }); }, {}, "SCOPE_REFUSED", "RECORDING_ROW_NOT_BOUND"],
    [(w) => { Object.assign(rowOf(w, REC), { idempotency_key: `och:${IID}:2` }); }, {}, "SCOPE_REFUSED", "RECORDING_ROW_NOT_BOUND"],
    [(w) => { w.holds = 1; }, {}, "START_STATE_NOT_ELIGIBLE", "RECORDING_HOLD_PRESENT"],
    [(w) => { w.offlineChargeId = CHARGE_ID; }, {}, "START_STATE_NOT_ELIGIBLE", "OFFLINE_CHARGE_ALREADY_LINKED"],
    [(w) => { w.ops.push(op(NOTIFY, { state: "pending", attempts: 0, dispatched: false })); }, {}, "SCOPE_REFUSED", "UNEXPECTED_OP"],
    [(w) => { w.ledger.push({ entry: "offline_charge_recorded", amt: String(AMT), currency: "USD", provider_ref: "1" }); }, {}, "SCOPE_REFUSED", "LEDGER_MISMATCH"],
    [(w) => { w.lease = { workerId: "x" }; }, {}, "START_STATE_NOT_ELIGIBLE", "RESERVATION_LEASE_HELD"],
    [(w) => { w.workLeased = true; }, {}, "START_STATE_NOT_ELIGIBLE", "WORK_LEASE_HELD"],
    [(w) => { w.claimReleased = true; }, {}, "SCOPE_REFUSED", "CLAIM_NOT_HELD"],
    [(w) => { w.offlineChargeAttempts = 1; }, {}, "START_STATE_NOT_ELIGIBLE", "HISTORY_NOT_INITIAL"],
    [() => {}, { env: "production" }, "SCOPE_REFUSED", "DATABASE_NOT_TEST"],
    [() => {}, { intentEnv: "production" }, "SCOPE_REFUSED", "INTENT_NOT_TEST"],
    [(w) => { w.recordedRows = []; }, {}, "START_STATE_NOT_ELIGIBLE", "RECORDED_PAYMENT_TIME_AMBIGUOUS"],
    [(w) => { w.recordedRows.push({ recorded_at: new Date(RECORDED_AT + 5000) }); }, {}, "START_STATE_NOT_ELIGIBLE", "RECORDED_PAYMENT_TIME_AMBIGUOUS"],
    [(w) => { w.schema.complete_fn = false; }, {}, "SCHEMA_PREREQUISITE_MISSING", "SCHEMA_PREREQUISITE_MISSING"],
  ];
  for (const [mut, o, outcome, code] of cases) {
    const w = world(); mut(w);
    const r = await core(w, o);
    assert.deepEqual([r.outcome, r.code, w.calls.length, r.lock, w.workerCalls, r.recordInvocations], [outcome, code, 0, "not_acquired", 0, 0], `${code}: ${JSON.stringify(r)}`);
  }
});

test("A4 real lock semantics: held elsewhere → LOCK_NOT_ACQUIRED with zero provider calls; lost at the pre-worker proof → LOCK_LOST with ZERO worker; backend hop refused; an observed session error mid-step aborts the worker's OWN signal synchronously and vetoes the write", async () => {
  { const w = world(); const r = await core(w, { lockHeldElsewhere: true });
    assert.deepEqual([r.outcome, r.code, w.calls.length, w.workerCalls], ["LOCK_NOT_ACQUIRED", "RUN_LOCK_PRESENT", 0, 0]); }
  { const w = world(); const r = await core(w, { lockLostAt: 2 });
    assert.deepEqual([r.outcome, r.code, w.workerCalls, r.recordInvocations], ["LOCK_LOST", "LOCK_NOT_HELD", 0, 0]); }
  { const w = world(); const r = await core(w, { lockLostAt: 3 });
    assert.deepEqual([r.outcome, r.code, w.workerCalls, r.recordInvocations, posts(w).length, r.finalState, r.postcheck], ["LOCK_LOST", "LOCK_NOT_HELD", 1, 1, 1, "confirmed", null], "lost before the readback: the ONE write is reported, never claimed CONFIRMED"); }
  { const w = world(); const r = await core(w, { hopAtProof: 1 });
    assert.deepEqual([r.outcome, r.code, w.workerCalls], ["LOCK_NOT_ACQUIRED", "BACKEND_HOP", 0]); }
  { const w = world();
    const r = await core(w, { wrapExchanges: (x) => ({ hostaway: (req) => { if (/guestPayments\/charges\?/.test(req.url) && w.workerCalls === 1 && !w.errored) { w.errored = true; w.lockClient.errorFn(new Error("connection terminated")); } return x.hostaway(req); } }) });
    assert.equal(r.outcome, "LOCK_LOST", JSON.stringify(r)); assert.equal(r.code, "STOP_LOCK_SESSION_ERROR");
    assert.deepEqual([r.recordInvocations, posts(w).length, w.signalAbortedAtEnd, r.lock], [0, 0, true, "session_error_connection_destroyed"]);
    assert.ok(r.actions.some((a) => /^STOP:EXECUTOR_(STOPPED|FAILED)$/.test(a)), `the composed signal / stop latch cut the worker off: ${JSON.stringify(r.actions)}`); }
});

test("A5 v1 uncertainty: a lost POST reply → WRITE_OUTCOME_UNKNOWN / LOST_RECORD_REPLY, exactly ONE POST, NO further step, facts reported; a SECOND SESSION on the same intent refuses read-only with ZERO sends; a second POST in the same step never leaves the process", async () => {
  { const w = world(); const r = await core(w, { postLost: true, postLandedAnyway: true });
    assert.deepEqual([r.outcome, r.code, r.recordInvocations, r.recordOutcome, posts(w).length, r.steps, r.factsObserved, r.recordingOps, r.finalState], ["WRITE_OUTCOME_UNKNOWN", "LOST_RECORD_REPLY", 1, "UNKNOWN", 1, 1, true, ["outcome_unknown"], "payment_captured"]);
    const w2 = { ...w, calls: [], workerCalls: 0 }; const r2 = await core(w2, { postLost: true });
    assert.equal(r2.outcome, "START_STATE_NOT_ELIGIBLE"); assert.ok(["HISTORY_NOT_INITIAL", "RECORDING_NOT_PRISTINE"].includes(r2.code), r2.code);
    assert.deepEqual([w2.calls.length, posts(w2).length, w2.workerCalls], [0, 0, 0], "a second session never resends"); }
  { const w = world(); const r = await core(w, { twice: true });
    assert.equal(r.outcome, "RECORDING_CONFIRMED", JSON.stringify(r)); assert.ok(r.actions.includes("SECOND_POST_REFUSED"));
    assert.deepEqual([posts(w).length, r.recordInvocations, r.refusedAtTransport], [1, 1, 1]); }
});

test("A6 target-only fence: wrong amount / title / method / scheduledDate bodies, a foreign reservation read, a cancel PUT, a Stripe-style call — none leaves the process; executors are field-exact BEFORE the fence", async () => {
  for (const o of [{ wrongAmount: 141 }, { wrongTitle: "maraVilla payment mvoch1-00000000-0000-4000-8000-000000000009" }, { wrongMethod: "other" }, { wrongDate: "2026-11-12 15:02:00" }]) {
    const w = world(); const r = await core(w, o);
    assert.equal(posts(w).length, 0, JSON.stringify(o));
    assert.ok(r.actions.some((a) => a.startsWith("SEND_FAILED:")), JSON.stringify([o, r.actions]));
    assert.ok(["WRITE_OUTCOME_UNKNOWN"].includes(r.outcome) && r.recordOutcome !== "REPLIED", JSON.stringify([o, r.outcome, r.recordOutcome]));
  }
  { const w = world(); const r = await core(w, { foreignRead: true });
    assert.equal(w.calls.filter((x) => x.includes(C.protectedReservationIds[0])).length, 0); assert.notEqual(r.outcome, "RECORDING_CONFIRMED"); }
  { const w = world();
    const worker = async (pool, { executors }) => { w.workerCalls += 1; const actions = [];
      try { await executors.createOfflineCharge({ method: "PUT", path: `/v1/reservations/${RID}/statuses/cancelled`, query: {}, body: { cancelledBy: "host" } }, {}); } catch { actions.push("PUT_REFUSED"); }
      return { status: "worked", intentId: IID, actions, calls: [], writes: 0, delayMs: 0, workReleased: true, stop: null, late: Promise.resolve({ kind: "none" }) }; };
    const r = await core(w, { worker });
    assert.ok(r.actions.includes("PUT_REFUSED")); assert.equal(posts(w).length, 0); }
  assert.equal(typeof E.runRecordingCore, "function");
  { const w = world(); const r = await core(w, { toolingOver: {} , wrapExchanges: (x) => ({ hostaway: x.hostaway, stripe: () => { throw new Error("never"); } }) });
    assert.deepEqual([r.outcome, w.calls.length], ["CORE_INVALID", 0], "a Stripe exchange wired into this runner is refused as CORE_INVALID before any read"); }
});

test("A7 stop latch: aborted before start → no lock, no provider call, no worker; aborted as the runner's list proof resolves → STOP_ABORTED with ZERO worker; abort / deadline as the pre-worker lock proof resolves → ZERO steps; a worker that only waits → STEP_BUDGET_EXHAUSTED at 6 with ZERO writes; the worker receives the runner-owned signal and a finite deadline", async () => {
  { const ac = new AbortController(); ac.abort(); const w = world(); const r = await core(w, { signal: ac.signal });
    assert.deepEqual([r.outcome, r.code, w.calls.length, r.lock, w.workerCalls], ["ABORTED", "STOP_ABORTED", 0, "not_acquired", 0]); }
  { const ac = new AbortController(); const w = world();
    const r = await core(w, { signal: ac.signal, wrapExchanges: (x) => ({ hostaway: async (req) => { const out = await x.hostaway(req); if (/guestPayments/.test(req.url)) ac.abort(); return out; } }) });
    assert.deepEqual([r.outcome, r.code, w.workerCalls, r.recordInvocations, r.lock], ["ABORTED", "STOP_ABORTED", 0, 0, "released"]); }
  { const ac = new AbortController(); const w = world(); const r = await core(w, { signal: ac.signal, onProofResolve: (n) => { if (n === 2) ac.abort(); } });
    assert.deepEqual([r.outcome, r.code, r.steps, w.workerCalls], ["ABORTED", "STOP_ABORTED", 0, 0]); }
  { let m = 0; const w = world(); const r = await core(w, { monotonic: () => m, onProofResolve: (n) => { if (n === 2) m = C.budgets.runMs + 1; } });
    assert.deepEqual([r.outcome, r.code, r.steps], ["DEADLINE", "STOP_DEADLINE", 0]); }
  { const w = world(); const r = await core(w, { wait: true });
    assert.deepEqual([r.outcome, r.code, r.steps, r.recordInvocations, posts(w).length], ["STEP_BUDGET_EXHAUSTED", "STEPS", 6, 0, 0]); }
});

test("A8 DB failure during the start read → DB_ERROR, nothing sent, no lock, no worker", async () => {
  const w = world(); const r = await core(w, { dbFailAt: 3 });
  assert.deepEqual([r.outcome, r.code, w.calls.length, r.lock, w.workerCalls], ["DB_ERROR", "START_READ_FAILED", 0, "not_acquired", 0]);
});

test("A9 worker outcomes: a hold → RECORDING_HELD (owner review, zero writes); an escalation → RECORDING_ESCALATED; the worker's own unknown settlement → WRITE_OUTCOME_UNKNOWN / WORKER_SETTLED_UNKNOWN; a deferred success event (worker stop after the durable completion) → STEP_BUDGET_EXHAUSTED / SUCCEEDED_EVENT_PENDING with ONE write and NO resend; a refused worker → WORKER_REFUSED", async () => {
  { const w = world(); const r = await core(w, { hold: true }); assert.deepEqual([r.outcome, r.code, r.recordInvocations, r.holds], ["RECORDING_HELD", "HOLD_OPEN", 0, 1]); }
  { const w = world(); const r = await core(w, { escalate: true }); assert.deepEqual([r.outcome, r.code, r.recordInvocations], ["RECORDING_ESCALATED", "OWNER_CASE", 0]); }
  { const w = world(); const r = await core(w, { postStatus: 500 }); assert.deepEqual([r.outcome, r.code, r.recordInvocations, r.recordingOps], ["WRITE_OUTCOME_UNKNOWN", "WORKER_SETTLED_UNKNOWN", 1, ["outcome_unknown"]]); }
  { const w = world(); const r = await core(w, { deferEvent: true });
    assert.deepEqual([r.outcome, r.code, r.steps, r.recordInvocations, posts(w).length, r.recordingOps, r.finalState, r.workerStop], ["STEP_BUDGET_EXHAUSTED", "SUCCEEDED_EVENT_PENDING", 6, 1, 1, ["succeeded"], "payment_captured", { code: "SIGNAL", where: "before_OFFLINE_CHARGE_RECORDED" }]); }
  { const w = world(); const r = await core(w, { worker: async () => ({ status: "refused", code: "DATABASE_NOT_TEST", actions: [], calls: [], writes: 0, workReleased: false, stop: null, late: Promise.resolve({ kind: "none" }) }) });
    assert.deepEqual([r.outcome, r.code], ["WORKER_REFUSED", "DATABASE_NOT_TEST"]); }
});

test("A10 postcheck + readback + residual agreement: a non-pristine notify row / a released claim / a missing evidence link → POSTCHECK_MISMATCH; a readback that disagrees (zero / two marked rows, foreign fields) → POSTCHECK_MISMATCH; a contradiction seen ONLY by the teardown residual read → NOT_CONFIRMED / RESIDUAL_<code>; unlock false → NOT_CONFIRMED / UNLOCK_NOT_PROVEN", async () => {
  { const w = world(); const r = await core(w, { notifyState: "succeeded" }); assert.deepEqual([r.outcome, r.code], ["POSTCHECK_MISMATCH", "NOTIFY_NOT_SINGLE_PRISTINE"]); }
  { const w = world(); const r = await core(w, { noNotify: true }); assert.deepEqual([r.outcome, r.code], ["POSTCHECK_MISMATCH", "NOTIFY_NOT_SINGLE_PRISTINE"]); }
  { const w = world(); const r = await core(w, { releaseClaim: true }); assert.deepEqual([r.outcome, r.code], ["POSTCHECK_MISMATCH", "CLAIM_NOT_HELD"]); }
  { const w = world(); const r = await core(w, { noEvidenceLink: true }); assert.deepEqual([r.outcome, r.code], ["POSTCHECK_MISMATCH", "RECORDING_OP_NOT_SINGLE_SUCCEEDED"]); }
  { const w = world(); const r = await core(w, { listMutate: (n, ww) => (n === 4 ? { json: { status: "success", result: [], count: 0 } } : null) }); assert.deepEqual([r.outcome, r.code], ["POSTCHECK_MISMATCH", "READBACK_RECORDED_CHARGE_NOT_LISTED"]); }
  { const w = world(); const r = await core(w, { listMutate: (n, ww) => (n === 4 ? { json: { status: "success", result: [...ww.charges, chargeRow({ id: 9000777 })], count: ww.charges.length + 1 } } : null) }); assert.deepEqual([r.outcome, r.code], ["POSTCHECK_MISMATCH", "READBACK_DUPLICATE_MARKED_CHARGES"]); }
  { const w = world(); const r = await core(w, { listMutate: (n, ww) => (n === 4 ? { json: { status: "success", result: ww.charges.map((x) => ({ ...x, paymentMethod: "cash" })), count: ww.charges.length } } : null) }); assert.deepEqual([r.outcome, r.code], ["POSTCHECK_MISMATCH", "READBACK_RECORDED_CHARGE_FIELDS"]); }
  { const w = world(); const pool = fakePool(w); const q = pool.query.bind(pool); let reads = 0;
    pool.query = async (sql) => { const out = await q(sql); if (/e7hrc:claims/.test(sql) && ++reads === 3) return { rows: [{ listing_id: 606998, released: true }] }; return out; };   // the 3rd claims read = the teardown residual read
    const r = await core(w, { pool }); assert.deepEqual([r.outcome, r.code, r.postcheck], ["NOT_CONFIRMED", "RESIDUAL_CLAIM_NOT_HELD", null]); }
  { const w = world(); const r = await core(w, { unlockFalse: true }); assert.deepEqual([r.outcome, r.code, r.lock, w.lockReleased], ["NOT_CONFIRMED", "UNLOCK_NOT_PROVEN", "unlock_failed_connection_destroyed", "destroyed"]); }
});

test("F1 (ROOT 5883758657) final readback uses the ACCEPTED normalized marker classifier + complete-list rules: at the FOURTH list call a valid recorded row PLUS a zero-width / case / NFKC / spaced lookalike, a duplicate id, a foreign-reservation row, a malformed row, a wrong canonical id, a count mismatch, a fail envelope → POSTCHECK_MISMATCH / READBACK_<code> with postcheck null; the unchanged valid page (plus an unrelated charge) stays RECORDING_CONFIRMED", async () => {
  const at4 = (rows) => (n, ww) => (n === 4 ? { json: { status: "success", result: rows(ww), count: rows(ww).length } } : null);
  const cases = [
    [at4((ww) => [...ww.charges, chargeRow({ id: 9000777, title: `maraVilla payment mv\u200boch1-${IID}`, amount: 1 })]), "READBACK_LOOKALIKE_CHARGE_PRESENT", "zero-width (ROOT repro)"],
    [at4((ww) => [...ww.charges, chargeRow({ id: 9000778, title: `MARAVILLA PAYMENT MVOCH1-${IID.toUpperCase()}`, amount: 1 })]), "READBACK_LOOKALIKE_CHARGE_PRESENT", "case"],
    [at4((ww) => [...ww.charges, chargeRow({ id: 9000779, title: `maraVilla payment ｍｖｏｃｈ１-${IID}`, amount: 1 })]), "READBACK_LOOKALIKE_CHARGE_PRESENT", "NFKC fullwidth"],
    [at4((ww) => [...ww.charges, chargeRow({ id: 9000780, title: `other mvoch1 - ${IID}`, amount: 1 })]), "READBACK_LOOKALIKE_CHARGE_PRESENT", "spaced marker"],
    [at4((ww) => [...ww.charges, chargeRow({ id: 9000781, title: `ref ${IID.replace(/-/g, "")}`, amount: 1 })]), "READBACK_LOOKALIKE_CHARGE_PRESENT", "dashless intent id"],
    [at4((ww) => [...ww.charges, { ...ww.charges[0] }]), "READBACK_LIST_DUPLICATE_ID", "duplicate id"],
    [at4((ww) => [...ww.charges, chargeRow({ id: 9000782, reservationId: 71999902, title: "Accommodation payment", amount: 5 })]), "READBACK_LIST_FOREIGN_RESERVATION_ROW", "foreign reservation"],
    [at4((ww) => [...ww.charges, chargeRow({ id: 9000783, listingMapId: 606999, title: "Accommodation payment", amount: 5 })]), "READBACK_LIST_FOREIGN_LISTING_ROW", "foreign listing"],
    [at4((ww) => [...ww.charges, { id: 9000784, listingMapId: 606998, reservationId: 71999901, type: "charge", title: "x", currency: "USD", paymentMethod: "cash", amount: "5", status: "paid", paymentProvider: "offline" }]), "READBACK_LIST_ROW_AMOUNT_INVALID", "malformed amount"],
    [at4((ww) => [...ww.charges, chargeRow({ id: 9000785, type: "fee", title: "x", amount: 5 })]), "READBACK_LIST_ROW_TYPE_UNKNOWN", "unknown type"],
    [at4((ww) => ww.charges.map((x) => ({ ...x, id: 9000786 }))), "READBACK_RECORDED_ID_MISMATCH", "other canonical id"],
    [(n, ww) => (n === 4 ? { json: { status: "success", result: ww.charges, count: ww.charges.length + 1 } } : null), "READBACK_LIST_COUNT_LENGTH_MISMATCH", "count mismatch"],
    [(n) => (n === 4 ? { json: { status: "fail", message: "nope" } } : null), "READBACK_LIST_ENVELOPE", "fail envelope"],
    [(n) => (n === 4 ? { status: 500, json: { status: "fail" } } : null), "READBACK_LIST_HTTP_STATUS", "500"],
  ];
  for (const [listMutate, code, label] of cases) {
    const w = world(); const r = await core(w, { listMutate });
    assert.deepEqual([r.outcome, r.code, r.postcheck, r.recordInvocations, posts(w).length], ["POSTCHECK_MISMATCH", code, null, 1, 1], `${label}: ${JSON.stringify([r.outcome, r.code])}`);
  }
  { const w = world(); const r = await core(w, { listMutate: at4((ww) => [...ww.charges, chargeRow({ id: 9000790, title: "Cleaning fee", amount: 25 })]) });
    assert.equal(r.outcome, "RECORDING_CONFIRMED", `an unrelated, non-lookalike row does not refuse: ${JSON.stringify([r.outcome, r.code])}`); }
  assert.equal(OP.classifyTitle(`maraVilla payment mv\u200boch1-${IID}`, IID), "suspicious", "the accepted classifier folds the zero-width character");
  assert.equal(E.finalListReadbackRefusal({ httpStatus: 200, json: { status: "success", result: [chargeRow()], count: 1 } }, { tooling: toolingFor(world()), intentId: IID, reservationId: RID, listingId: 606998, recordedId: CHARGE_ID, title: TITLE, amountMinor: AMT, currency: "USD", paymentMethod: "credit_card" }), null);
  const src = readFileSync(join(TOOLING, "lib/checkout/offline-charge-proof.js"), "utf8");
  assert.match(src, /const ROW_STRING_FIELDS = \["type", "title", "currency", "status", "paymentProvider", "paymentMethod"\];/); assert.match(src, /const CHARGE_TYPES = Object\.freeze\(\["charge", "preAuth", "refund"\]\);/);
});

test("F2 (ROOT 5883758657) honest statement accounting: reported dbQueries == EVERY physical statement (pool + lock session + residual read + unlock) on the happy path; a worker that exhausts the body budget is refused at total − reserve, the teardown spends only the reserve, physical == reported, nothing past the TOTAL ceiling, and an unavailable residual read never supports success", async () => {
  { const w = world(); const r = await core(w);
    assert.equal(r.outcome, "RECORDING_CONFIRMED");
    assert.equal(r.dbQueries, w.pool.reads, `reported ${r.dbQueries} vs physical ${w.pool.reads}`);
    assert.ok(r.dbTeardownQueries >= 2 && r.dbTeardownQueries <= C.budgets.dbTeardownReserve, `teardown ${r.dbTeardownQueries} within the reserve`);
    assert.equal(r.dbBudgetRefused, 0); }
  { const w = world(); const B = C.budgets;
    const worker = async (pool) => { w.workerCalls += 1; const actions = []; let refused = 0;
      for (let i = 0; i < 2 * B.dbQueries; i++) { try { await pool.query("/*e7hrc:instance*/ SELECT environment FROM booking.instance"); } catch { refused += 1; break; } }   // a synthetic worker burning the pool
      actions.push(`BURNED:${refused}`); return { status: "worked", intentId: IID, actions, calls: [], writes: 0, delayMs: 0, workReleased: true, stop: null, late: Promise.resolve({ kind: "none" }) }; };
    const r = await core(w, { worker });
    assert.ok(r.actions.includes("BURNED:1"), JSON.stringify(r.actions));
    assert.deepEqual([r.outcome, r.code, r.dbBudgetRefused >= 1, r.recordInvocations], ["BUDGET_EXHAUSTED", "DB_QUERY_CEILING", true, 0]);
    assert.equal(r.dbQueries, w.pool.reads, `reported ${r.dbQueries} vs physical ${w.pool.reads}`);
    assert.ok(w.pool.reads <= B.dbQueries, `physical ${w.pool.reads} never exceeds the TOTAL ceiling ${B.dbQueries}`);
    assert.ok(r.dbTeardownQueries <= B.dbTeardownReserve && r.dbTeardownQueries > 0, `teardown ${r.dbTeardownQueries} within the reserve (the residual read ran on the reserve)`);
    assert.equal(r.lock, "released", "the unlock fits in the reserve"); }
  { const w = world(); const pool = fakePool(w); const q = pool.query.bind(pool); let claims = 0;
    pool.query = async (sql) => { if (/e7hrc:claims/.test(sql) && ++claims === 3) { pool.reads += 1; throw new Error("residual read failed"); } return q(sql); };   // the statement was issued and failed
    const r = await core(w, { pool });
    assert.deepEqual([r.outcome, r.code, r.postcheck], ["NOT_CONFIRMED", "RESIDUAL_READ_UNAVAILABLE", null], "an unavailable residual read never supports success");
    assert.equal(r.dbQueries, pool.reads, "counted even when the residual read fails"); }
});

test("C1 code ceiling: Slice 4 recording execution CLOSED (executeEnabled false; D4 blocker), Slice 3 CLOSED (HELD), Slices 1 / 2 OPEN on THEIR tooling for the ONE reviewed C3 TEST capture validation; this runner pins the MERGED e7-test 5a094b16; the plan pins pi / reservation / charge / captured amount / stay / attempt / session, the accepted recording key, credit_card / hostaway-e7-test, title / amount wire forms = the accepted module's; ZERO stripe / capture / void / cancel / refund / notify / create", () => {
  assert.equal(C.executeEnabled, false); assert.equal(RESRUN.CONSTANTS.executeEnabled, true); assert.equal(CAPRUN.CONSTANTS.executeEnabled, true); assert.equal(TCRUN.CONSTANTS.executeEnabled, false);
  assert.equal(C.toolingCommit, "5a094b16c1f84690a738a98ab89140caa69c1e1f"); assert.equal(C.toolingStatus, "MERGED");
  // C2: Slice 2 is repinned to the merged C1 fix (59178b04); Slice 1 (40779e34) and Slice 3 (9d86bfa1) keep their own immutable pins
  assert.equal(RESRUN.CONSTANTS.toolingCommit, "40779e34e8c65ac5c4494bc5a18cd4223ef723fa");
  assert.equal(CAPRUN.CONSTANTS.toolingCommit, "59178b0468469b6570beab861bbc8e48b3a887d1");
  assert.equal(TCRUN.CONSTANTS.toolingCommit, "9d86bfa1e60779b3794de88bbae151670e8fe515");
  assert.deepEqual([C.paymentMethod, C.accountRef, C.budgets.record, C.budgets.steps], ["credit_card", "hostaway-e7-test", 1, 6]);
  const { plan, planHash } = built();
  assert.deepEqual([plan.paymentIntentId, plan.reservationId, plan.chargeId, plan.capturedMinor, plan.from, plan.to, plan.guests, plan.attemptId, plan.sessionId, plan.recordingIdempotencyKey, plan.paymentMethod, plan.accountRef],
    [PI, RID, CH, AMT, FROM, TO, 1, ATTEMPT, CS, KEY, "credit_card", "hostaway-e7-test"]);
  assert.deepEqual([plan.title, plan.amount], [OP.offlineChargeTitle(IID), OP.exactAmount(AMT)], "wire forms equal the accepted module's");
  assert.equal(E.scheduledDateOf(RECORDED_AT), OP.formatScheduledDate(RECORDED_AT)); assert.equal(E.scheduledDateOf(RECORDED_AT), SCHEDULED);
  assert.equal(E.exactAmount(12345), OP.exactAmount(12345)); assert.equal(E.exactAmount(100), OP.exactAmount(100));
  assert.deepEqual(plan.writes, { recordMax: 1, capture: 0, hostawayCreate: 0, cancel: 0, refund: 0, notify: 0, void: 0, account: 0, keys: 0, stripe: 0 });
  assert.ok(plan.operations.every((x) => !/stripe|cancel|refund|notify|create_reservation/.test(x)));
  assert.equal(planHash, RESRUN.canonical ? E.buildPlan(C, planInput()).planHash : planHash);
  assert.notEqual(built({ approvalRef: "other" }).planHash, planHash); assert.notEqual(built({ capturedMinor: AMT + 1 }).planHash, planHash);
  for (const bad of [{ reservationId: C.protectedReservationIds[0] }, { capturedMinor: 0 }, { from: TO }, { sessionId: "cs_live_abcdefgh" }, { runnerDigest: "x" }]) assert.throws(() => built(bad), (e) => e.code === "HRC_INPUT_INVALID");
  assert.throws(() => E.buildPlan({ ...C, paymentMethod: "other" }, planInput()), (e) => e.code === "HRC_INPUT_INVALID", "the TEST method is a ceiling, not a knob");
  assert.ok(E.OUTCOMES.includes("RECORDING_CONFIRMED") && E.HOSTED_CODES.includes("HRC_EXECUTE_CLOSED"));
});

test("C2 closure: the INDEPENDENTLY scanned transitive relative imports of the runner's tooling roots == CONSTANTS.closure (= the Slice 1 closure + recording-worker.js); framed digest == the pin; no cleanup / test-cleanup / R1 / reconcile / stager / notification / compensation-worker / test-abort / capture-worker file", async () => {
  const roots = ["lib/booking-db/recording-worker.js", "lib/booking-db/repo.js", "scripts/e7-connected/executor-adapters.mjs", "scripts/e7-connected/http-transports.mjs", "scripts/e7-connected/real-exchange.mjs",
    "lib/booking-db/pool.js", "lib/hostaway-reservations.js", "lib/checkout/compensation-proof.js", "lib/checkout/offline-charge-proof.js", "lib/checkout/intent-state.js", "scripts/e7-connected/run-lock-precheck.mjs",
    "scripts/e7-connected/probe-env-preflight.mjs"];
  const src = readFileSync(join(ROOT, "scripts/e7-hosted-recording.mjs"), "utf8");
  for (const f of roots) assert.ok(src.includes(f), `runner imports ${f}`);
  const seen = new Set(); const st = [...roots];
  while (st.length) { const f = st.pop(); if (seen.has(f)) continue; seen.add(f);
    for (const m of readFileSync(join(TOOLING, f), "utf8").matchAll(/(?:import|export)\s[^"'`;]*?from\s*["'](\.[^"']+)["']|import\(\s*["'](\.[^"']+)["']\s*\)/g)) st.push(normalize(join(dirname(f), m[1] || m[2]))); }
  assert.deepEqual([...C.closure], ["package.json", "package-lock.json", ...[...seen].sort()].sort());
  assert.deepEqual([...C.closure], [...new Set([...RESRUN.CONSTANTS.closure, "lib/booking-db/recording-worker.js"])].sort());
  assert.equal(await RESRUN.framedDigest(TOOLING, C.closure, E.CLOSURE_DIGEST_PREFIX), C.closureDigest);
  for (const f of C.closure) assert.doesNotMatch(f, /run-core|run-plan|run-r1|reconcile|stage-run|cleanup-worker|test-cleanup|notification-worker|compensation-worker|test-abort|capture-worker/);
  assert.equal(OP.LIST_LIMIT, 500, "the runner's LIST_LIMIT copy equals the accepted constant");
  assert.deepEqual([...EX.PHASE_KEYS.recording].sort(), ["createOfflineCharge", "label", "listOfflineCharges", "retrieveReservation"]);
});

// ---------------------------------------------------------------------------------------------------------------------------------
const PROC = { versions: { node: C.nodeVersion }, platform: "linux", execArgv: [], getuid: () => 1000, once() {}, off() {} };
const okChild = async () => ({ status: 0, signal: null, stdout: "# tests 3\n# pass 3\n# fail 0\n", truncated: false, spawnFailed: false });
const realEnv = (over = {}) => ({ E7_TOOLING_DIR: TOOLING, E7_APPROVAL_REF: "label-1", E7_INTENT_ID: IID, E7_EXPECTED_VERSION: String(VER), E7_NOT_BEFORE: NB, E7_PAYMENT_INTENT_ID: PI, E7_RESERVATION_ID: RID,
  E7_CHARGE_ID: CH, E7_CAPTURED_MINOR: String(AMT), E7_STAY_FROM: FROM, E7_STAY_TO: TO, E7_GUESTS: "1", E7_ATTEMPT_ID: ATTEMPT, E7_SESSION_ID: CS, E7_RUN_ID: RUN_ID, ...over });
const envOf = (over = {}) => ({ ...Object.fromEntries(C1.PRESENT_KEYS.map((k) => [k, undefined])), E7_TOOLING_DIR: TOOLING, ...over });
const pick = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

test("H1 hosted: preflight (no secrets) passes on the pinned closure; the Stripe secret is refused in EVERY mode; any secret outside execute is refused; partial / invalid inputs refused; the runner digest covers the imported Slice 1 runner + workflow + test", async () => {
  const run = (env, deps = {}) => E.runHosted({ mode: "preflight", env: pick(env), proc: PROC, wrapperDir: ROOT, deps: { spawnChild: okChild, ...deps } });
  const a = await run(envOf());
  assert.equal(a.result.code, "PREFLIGHT_OK_SYNTHETIC_ONLY", JSON.stringify(a.result)); assert.equal(a.exitCode, 0);
  assert.deepEqual([a.result.closureDigest, a.result.planKind, a.result.executeEnabled, a.result.toolingCommit, a.result.tests.pass], [C.closureDigest, "SYNTHETIC", false, C.toolingCommit, 3]);
  assert.equal(a.result.runnerDigest, await RESRUN.framedDigest(ROOT, C.runnerFiles, E.RUNNER_DIGEST_PREFIX));
  const b = await run(envOf(realEnv()));
  assert.deepEqual([b.result.code, b.result.planKind, b.result.planHash], ["PREFLIGHT_OK_REAL_PLAN", "REAL", E.buildPlan(C, { ...planInput({ approvalRef: "label-1" }), runnerDigest: a.result.runnerDigest }).planHash]);
  assert.equal((await run(envOf({ E7_STRIPE_TEST_KEY: "sk_test_x" }))).result.code, "HRC_SECRET_SCOPE_VIOLATION");
  assert.equal((await E.runHosted({ mode: "execute", env: pick(envOf({ E7_STRIPE_TEST_KEY: "sk_test_x", E7_HOSTAWAY_TOKEN: "t", E7_DEV_BOOKING_DATABASE_URL: "postgresql://x" })), proc: PROC, wrapperDir: ROOT, deps: {} })).result.code, "HRC_SECRET_SCOPE_VIOLATION", "Stripe never admitted, even in execute");
  assert.equal((await run(envOf({ E7_HOSTAWAY_TOKEN: "t" }))).result.code, "HRC_SECRET_SCOPE_VIOLATION");
  assert.equal((await run(envOf({ E7_DEV_BOOKING_DATABASE_URL: "postgresql://x" }))).result.code, "HRC_SECRET_SCOPE_VIOLATION");
  assert.equal((await run(envOf({ E7_INTENT_ID: IID }))).result.code, "HRC_INPUT_INCOMPLETE");
  assert.equal((await run(envOf(realEnv({ E7_CAPTURED_MINOR: "0" })))).result.code, "HRC_INPUT_INVALID");
  assert.equal((await run(envOf(realEnv({ E7_RESERVATION_ID: C.protectedReservationIds[1] })))).result.code, "HRC_INPUT_INVALID");
  assert.equal((await run(envOf(realEnv({ E7_INTENT_ID: C.synthetic.intentId })))).result.code, "HRC_INPUT_INVALID");
  assert.equal((await run(envOf(), { spawnChild: async () => ({ status: 1, signal: null, stdout: "# tests 3\n# pass 2\n# fail 1\n", truncated: false, spawnFailed: false }) })).result.code, "HRC_TESTS_FAILED");
  assert.equal((await E.runHosted({ mode: "nope", env: {}, proc: PROC, wrapperDir: ROOT })).result.code, "HRC_USAGE");
});

test("H2 hosted: verify / execute are CLOSED in this revision (HRC_EXECUTE_CLOSED) before any pin, ref or import check; an opened constants seam still refuses off main / wrong digests / missing run id / secrets missing / wrong DB target, wipes secrets, and wires TWO pools (6543 max 3 worker, 5432 max 1 lock) with a Hostaway-only exchange", async () => {
  const pre = await E.runHosted({ mode: "preflight", env: pick(envOf()), proc: PROC, wrapperDir: ROOT, deps: { spawnChild: okChild } });
  const plan = E.buildPlan(C, { ...planInput({ approvalRef: "label-1" }), runnerDigest: pre.result.runnerDigest });
  const full = (over = {}) => pick(envOf(realEnv({ E7_EXPECTED_PLAN_HASH: plan.planHash, E7_EXPECTED_CLOSURE_DIGEST: C.closureDigest, E7_EXPECTED_RUNNER_DIGEST: pre.result.runnerDigest, GITHUB_REF: "refs/heads/main", ...over })));
  for (const mode of ["verify", "execute"]) {
    const r = await E.runHosted({ mode, env: full({ E7_TOOLING_DIR: "/nonexistent", GITHUB_REF: "refs/heads/other" }), proc: PROC, wrapperDir: ROOT, deps: { importEnv: () => { throw new Error("never"); } } });
    assert.deepEqual([r.result.code, r.exitCode, r.result.closureDigest], ["HRC_EXECUTE_CLOSED", 1, null], mode);
  }
  const opened = { ...C, executeEnabled: true };
  const deps = { constants: opened, spawnChild: okChild };
  assert.equal((await E.runHosted({ mode: "verify", env: full(), proc: PROC, wrapperDir: ROOT, deps })).result.code, "VERIFY_OK");
  assert.equal((await E.runHosted({ mode: "verify", env: full({ GITHUB_REF: "refs/heads/feature" }), proc: PROC, wrapperDir: ROOT, deps })).result.code, "HRC_REF_NOT_MAIN");
  assert.equal((await E.runHosted({ mode: "verify", env: full({ E7_EXPECTED_CLOSURE_DIGEST: "0".repeat(64) }), proc: PROC, wrapperDir: ROOT, deps })).result.code, "HRC_SOURCE_MISMATCH");
  assert.equal((await E.runHosted({ mode: "verify", env: full({ E7_EXPECTED_RUNNER_DIGEST: "0".repeat(64) }), proc: PROC, wrapperDir: ROOT, deps })).result.code, "HRC_RUNNER_MISMATCH");
  assert.equal((await E.runHosted({ mode: "verify", env: full({ E7_EXPECTED_PLAN_HASH: "0".repeat(64) }), proc: PROC, wrapperDir: ROOT, deps })).result.code, "HRC_PLAN_HASH_MISMATCH");
  assert.equal((await E.runHosted({ mode: "verify", env: full({ E7_RUN_ID: "" }), proc: PROC, wrapperDir: ROOT, deps })).result.code, "HRC_INPUT_INVALID", "the immutable run id is mandatory outside preflight");
  assert.equal((await E.runHosted({ mode: "execute", env: full(), proc: PROC, wrapperDir: ROOT, deps })).result.code, "HRC_CREDENTIALS_MISSING");
  const secrets = { E7_HOSTAWAY_TOKEN: "synthetic-hostaway-token", E7_DEV_BOOKING_DATABASE_URL: `postgresql://mv_booking_app_dev.${C.dbProjectRef}@aws-0-us-east-1.pooler.supabase.com:6543/postgres` };
  assert.equal((await E.runHosted({ mode: "execute", env: full({ ...secrets, E7_DEV_BOOKING_DATABASE_URL: "postgresql://x@other-host:6543/postgres" }), proc: PROC, wrapperDir: ROOT, deps: { ...deps, readPgVersion: async () => C.pgVersion } })).result.code, "HRC_DB_TARGET_INVALID");
  assert.equal((await E.runHosted({ mode: "execute", env: full(secrets), proc: PROC, wrapperDir: ROOT, deps: { ...deps, readPgVersion: async () => "8.0.0" } })).result.code, "HRC_DEPENDENCY_MISMATCH");
  const pools = []; const seenCore = [];
  const env = full(secrets);
  const r = await E.runHosted({ mode: "execute", env, proc: PROC, wrapperDir: ROOT, deps: { ...deps, readPgVersion: async () => C.pgVersion, readCa: async () => Buffer.from("ca"), caSha256: createHash("sha256").update("ca").digest("hex"),
    importTooling: async () => ({ X: { createE7RealExchange: ({ provider }) => { assert.equal(provider, "hostaway"); return { ok: true, exchange: () => { throw new Error("never"); } }; } },
      createBookingPool: (o) => { pools.push({ port: new URL(o.connectionString).port, max: o.max }); return { connect: async () => ({}), end: async () => {} }; }, tooling: toolingFor(world()) }),
    runCore: async (input) => { seenCore.push({ keys: Object.keys(input.exchanges), creds: Object.keys(input.credentials), runId: input.runId, token: input.credentials.hostaway() }); return { outcome: "RECORDING_CONFIRMED" }; } } });
  assert.deepEqual([r.result.code, r.exitCode, r.result.lockEndpoint, r.result.runId], ["EXECUTE_DONE", 0, "session:5432", RUN_ID]);
  assert.deepEqual(pools, [{ port: "6543", max: 3 }, { port: "5432", max: 1 }]);
  assert.deepEqual(seenCore, [{ keys: ["hostaway"], creds: ["hostaway"], runId: RUN_ID, token: "synthetic-hostaway-token" }]);
  assert.equal(env.E7_HOSTAWAY_TOKEN, undefined); assert.equal(env.E7_DEV_BOOKING_DATABASE_URL, undefined);
  assert.equal(JSON.stringify(r.result).includes("synthetic-hostaway-token"), false);
});

test("H3 hosted: a drifted tooling byte (in the recording worker) is refused before any import (closure digest); a tooling tree WITHOUT node_modules still passes the dependency-free preflight import set", async () => {
  const dir = mkdtempSync(join(tmpdir(), "e7hrc-"));
  try {
    for (const f of C.closure) { mkdirSync(dirname(join(dir, f)), { recursive: true }); cpSync(join(TOOLING, f), join(dir, f)); }
    const ok = await E.runHosted({ mode: "preflight", env: pick(envOf({ E7_TOOLING_DIR: dir })), proc: PROC, wrapperDir: ROOT, deps: { spawnChild: okChild } });
    assert.equal(ok.result.code, "PREFLIGHT_OK_SYNTHETIC_ONLY", JSON.stringify(ok.result));
    writeFileSync(join(dir, "lib/booking-db/recording-worker.js"), `${readFileSync(join(dir, "lib/booking-db/recording-worker.js"), "utf8")}\n// drift\n`);
    const r = await E.runHosted({ mode: "preflight", env: pick(envOf({ E7_TOOLING_DIR: dir })), proc: PROC, wrapperDir: ROOT, deps: { spawnChild: okChild, importEnv: () => { throw new Error("must not import"); } } });
    assert.equal(r.result.code, "HRC_SOURCE_MISMATCH");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("S1 static: the runner imports node built-ins and ONLY the reviewed Slice 1 runner; no Stripe / capture / void / cancel / refund / notify-send call text; test-cleanup modules never imported; inert import; the worker is called with the runner-owned signal + deadline", () => {
  const src = readFileSync(join(ROOT, "scripts/e7-hosted-recording.mjs"), "utf8");
  const code = src.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");                       // comments may NAME the forbidden things; code may not call them
  const imports = [...src.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ["node:process", "node:fs/promises", "node:url", "node:crypto", "./e7-hosted-reservation.mjs"]);
  assert.doesNotMatch(code, /createE7Stripe|api\.stripe\.com|refunds\.create|paymentIntents\.capture|cancelReservation|statuses\/cancelled|test-cleanup|cleanup-worker|dispatchNotification|sendNotification|requestTestCleanup/);
  assert.match(src, /signal: stopAc\.signal, deadlineAt: clock\(\) \+/);
  assert.match(src, /import\.meta\.main === true/);
  assert.ok(src.indexOf("process.env") > src.indexOf("import.meta.main === true"), "process.env only after the main guard");
});

test("W1 workflow: manual dispatch only; preflight default without secrets; execute on main + environment gate; tooling checkout pinned to 5a094b16 (both jobs); Hostaway + DB secrets ONLY in the execute step (no Stripe secret anywhere); E7_RUN_ID = github.run_id-run_attempt in verify + execute; every input env passed to all three runner invocations", () => {
  const yml = readFileSync(join(ROOT, ".github/workflows/e7-hosted-recording.yml"), "utf8");
  assert.match(yml, /^on:\n  workflow_dispatch:/m); assert.doesNotMatch(yml, /\n  (push|pull_request|schedule):/);
  assert.equal((yml.match(/ref: 5a094b16c1f84690a738a98ab89140caa69c1e1f/g) || []).length, 2);
  assert.match(yml, /if: inputs\.mode == 'execute' && github\.ref == 'refs\/heads\/main'/); assert.match(yml, /environment: e7-readonly-probe/);
  assert.equal((yml.match(/secrets\./g) || []).length, 2, "two secrets, execute step only"); assert.doesNotMatch(yml, /STRIPE/);
  assert.equal((yml.match(/E7_RUN_ID: \$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/g) || []).length, 2);
  for (const k of Object.values(E.INPUT_ENV)) assert.equal((yml.match(new RegExp(`${k}:`, "g")) || []).length, 3, k);
  assert.match(yml, /node wrapper\/scripts\/e7-hosted-recording\.mjs preflight/); assert.match(yml, /e7-hosted-recording\.mjs verify/); assert.match(yml, /e7-hosted-recording\.mjs execute/);
  assert.match(yml, /npm ci --ignore-scripts --omit=dev --no-audit --no-fund/);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// OPT-IN INTEGRATION (E7_HRC_DB_TESTS=1; tooling with its pinned pg; PG_BIN): the REAL merged runRecordingStep (PR72 outer signal / deadline), repo, operations,
// 0010–0017 recording objects, the accepted executor adapters + transport on a disposable PostgreSQL (tooling test/db/harness.mjs). FAKE exchanges ONLY (mock replies
// are not provider proof); fixtures through the accepted APIs. The hosted preflight child never sets E7_HRC_DB_TESTS.
if (process.env.E7_HRC_DB_TESTS === "1") {
  const [{ startMigratedDatabase }, F, R, O, W] = await Promise.all([tool("test/db/harness.mjs"), tool("test/db/fixtures.mjs"), tool("lib/booking-db/repo.js"), tool("lib/booking-db/operations.js"), tool("lib/booking-db/recording-worker.js")]);
  const db = await startMigratedDatabase();
  after(async () => { await db.close(); });
  const LIST = 606998; const MINUTE = 60000; const PG_AMT = 576000;
  let stayK = 0;
  const realTooling = { ...toolingFor(world()), runRecordingStep: W.runRecordingStep, loadIntent: R.loadIntent };
  /** a CAPTURED TEST payment on 606998 / USD through the accepted fixtures */
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
    const rec = (await db.app.query("SELECT recorded_at FROM booking.intent_transitions WHERE intent_id = $1 AND to_state = 'payment_captured'", [rr.id])).rows;
    assert.equal(rec.length, 1);
    return { id: rr.id, piId: rr.piId, attemptId: pa, sessionId: rr.sessionId, chargeId, stay, ref: i.ref, intent: i, total: i.price.finalTotalMinor, rid: String(rr.reservationId), recordedAt: new Date(rec[0].recorded_at).getTime() };
  }
  function pgWorld(a, clk, o = {}) {
    const w = { calls: [], charges: [], nextId: 7700001, postRequests: 0, echoRef: o.echoRef ?? true, resStatus: "new", listReads: 0 };
    const reply = (status, x) => Promise.resolve({ status, contentType: "application/json", bytes: enc(x) });
    const full = (echo = w.echoRef) => ({ id: Number(a.rid), listingMapId: LIST, channelId: 2000, arrivalDate: a.stay.from, departureDate: a.stay.to, totalPrice: a.total / 100, currency: "USD", status: w.resStatus,
      customFieldValues: echo ? [{ customFieldId: C.refFieldId, value: a.ref }] : [] });
    w.hostaway = (req) => {
      const p = req.url.replace("https://api.hostaway.com", ""); w.calls.push(`H ${req.method} ${p}`);
      if (req.method === "POST") {
        assert.equal(p, `/v1/guestPayments/charges/${a.rid}`);
        const body = JSON.parse(req.body);
        assert.deepEqual(body, { title: `maraVilla payment mvoch1-${a.id}`, amount: a.total / 100, paymentMethod: "credit_card", status: "paid", scheduledDate: OP.formatScheduledDate(a.recordedAt) });
        w.postRequests += 1;
        const ch = { id: w.nextId++, listingMapId: LIST, reservationId: Number(a.rid), type: "charge", title: body.title, currency: "USD", paymentMethod: "credit_card", amount: body.amount, status: "paid", paymentProvider: "offline" };
        if (o.postLost) { if (o.postLandedAnyway) w.charges.push(ch); if (o.onPost) o.onPost(); return Promise.reject(new Error("socket reset")); }
        w.charges.push(ch); if (o.onPost) o.onPost(); return reply(201, { status: "success", result: { ...ch } });
      }
      if (req.method === "GET" && p.startsWith("/v1/guestPayments/charges?")) {
        assert.equal(p, `/v1/guestPayments/charges?limit=500&reservationIds=${a.rid}`); w.listReads += 1;
        if (o.onList) o.onList(w.listReads, w);
        return reply(200, { status: "success", result: w.charges.map((x) => ({ ...x })), count: w.charges.length, limit: 500, offset: null });
      }
      if (req.method === "GET" && p.startsWith("/v1/reservations?")) return reply(200, { status: "success", result: new URL(req.url).searchParams.has("afterId") ? [] : [full(true)] });
      const m = /^\/v1\/reservations\/(\d+)$/.exec(p);
      if (req.method === "GET" && m) return m[1] === a.rid ? reply(200, { status: "success", result: full() }) : reply(404, { status: "fail" });
      return reply(404, { status: "fail" });
    };
    return w;
  }
  const pgPlan = (a, over = {}) => E.buildPlan(C, { approvalRef: "SYNTHETIC-hrc-pg", intentId: a.id, expectedVersion: a.intent.version, notBefore: new Date(F.at(0) - MINUTE).toISOString(), paymentIntentId: a.piId,
    reservationId: a.rid, chargeId: a.chargeId, capturedMinor: a.total, from: a.stay.from, to: a.stay.to, guests: a.intent.guests, attemptId: a.attemptId, sessionId: a.sessionId, runnerDigest: "0".repeat(64), ...over });
  const pgRun = (a, clk, w, extra = {}, over = {}) => {
    const b = pgPlan(a, over);
    return E.runRecordingCore({ plan: b.plan, planHash: b.planHash, runId: RUN_ID, pool: extra.pool ?? db.app, tooling: realTooling, exchanges: { hostaway: w.hostaway },
      credentials: { hostaway: () => "synthetic-hostaway-token" }, clock: clk.read, sleep: async () => {}, ...extra });
  };
  /** the REAL clock (the accepted worker checks skew against the database clock and the DB refuses a completion stamped in its future, so no artificial
   *  monotonic increments — the e74b suite uses Date.now too); `jump(ms)` moves it forward once (deadline tests) */
  const newClock = () => { const c = { skew: 0 }; c.read = () => Date.now() + c.skew; c.jump = (ms) => { c.skew += ms; }; return c; };
  const snap = async (id) => ({ st: (await db.app.query("SELECT state, version, offline_charge_id FROM booking.intents WHERE id = $1", [id])).rows[0],
    ops: (await db.app.query("SELECT op_type, state, attempts, (dispatched_at IS NOT NULL) AS d, result_ref FROM booking.external_operations WHERE intent_id = $1 ORDER BY op_type, created_at", [id])).rows,
    claim: (await db.app.query("SELECT (released_at IS NOT NULL) AS released FROM booking.inventory_claims WHERE intent_id = $1", [id])).rows,
    ledger: (await db.app.query("SELECT entry FROM booking.payment_ledger WHERE intent_id = $1 ORDER BY id", [id])).rows.map((x) => x.entry),
    cases: Number((await db.app.query("SELECT count(*)::int AS n FROM booking.reconciliation_cases WHERE intent_id = $1 AND status = 'open'", [id])).rows[0].n),
    notifies: (await db.app.query("SELECT state, attempts, (dispatched_at IS NOT NULL) AS d FROM booking.external_operations WHERE intent_id = $1 AND op_type = 'guest.notify'", [id])).rows,
    locks: Number((await db.app.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'")).rows[0].n) });

  test("I1 PG integration (REAL recording worker + repo + 0010–0017 + accepted adapters / transport; FAKE exchanges): ref echoed → ONE POST (exact body), confirmed, offline_charge_id linked, ledger + evidence, ONE pristine guest.notify, claim held, lock released; a SECOND admission refuses read-only with zero sends; budgets measured; ref NOT echoed → refused BEFORE the worker (zero worker reads, zero holds)", async () => {
    { const a = await capturedIntent(); const clk = newClock(); const w = pgWorld(a, clk, { echoRef: false });
      const r = await pgRun(a, clk, w);
      assert.deepEqual([r.outcome, r.code, r.steps, w.postRequests, (await snap(a.id)).ops.filter((x) => x.op_type === REC).map((x) => x.state), r.holds], ["PROVIDER_PROOF_FAILED", "REF_NOT_ECHOED", 0, 0, ["pending"], null]); }
    for (const echoRef of [true]) {
      const a = await capturedIntent(); const clk = newClock(); const w = pgWorld(a, clk, { echoRef });
      const r = await pgRun(a, clk, w);
      assert.equal(r.outcome, "RECORDING_CONFIRMED", JSON.stringify(r));
      console.log(`# I1 ${echoRef ? "echoed" : "not-echoed"}: steps=${r.steps} dbQueries=${r.dbQueries} (teardown ${r.dbTeardownQueries}) exchanges=${r.exchanges} hostawayReads=${r.hostawayReads} chargeLists=${r.chargeLists}`);
      assert.ok(r.dbTeardownQueries > 0 && r.dbTeardownQueries <= C.budgets.dbTeardownReserve, "the real teardown fits the reserve");
      assert.ok(r.dbQueries < C.budgets.dbQueries / 2 && r.exchanges < C.budgets.exchanges / 2 && r.hostawayReads < C.budgets.hostawayReads && r.chargeLists < C.budgets.chargeLists, "measured well inside the ceilings");
      const s = await snap(a.id);
      assert.deepEqual([s.st.state, s.st.version, String(s.st.offline_charge_id), w.postRequests, w.charges.length, s.claim, s.cases, s.locks], ["confirmed", a.intent.version + 1, String(7700001), 1, 1, [{ released: false }], 0, 0]);
      assert.deepEqual(s.ops.filter((x) => x.op_type === REC).map((x) => [x.state, x.attempts, x.d, x.result_ref]), [["succeeded", 1, true, "7700001"]]);
      assert.deepEqual(s.notifies, [{ state: "pending", attempts: 0, d: false }], "ONE queued, never dispatched");
      assert.deepEqual(s.ledger.filter((e) => e === "offline_charge_recorded"), ["offline_charge_recorded"]);
      assert.deepEqual([r.recordInvocations, r.writes.record, r.notifyOps, r.postcheck.offlineChargeId], [1, 1, ["pristine"], "7700001"]);
      const r2 = await pgRun(a, clk, pgWorld(a, clk, { echoRef }), {}, { expectedVersion: a.intent.version + 1 });
      assert.deepEqual([r2.outcome, r2.code, r2.steps, r2.recordInvocations], ["START_STATE_NOT_ELIGIBLE", "STATE_NOT_PAYMENT_CAPTURED", 0, 0], "a second admission never resends");
      assert.equal(w.postRequests, 1);
    }
  });

  test("I2 PG integration: a LOST POST reply that landed at the provider → WRITE_OUTCOME_UNKNOWN, the row outcome_unknown + ONE open case, intent still payment_captured, NO notify, exactly ONE charge at the provider; a second session refuses read-only (RECORDING_NOT_PRISTINE) with zero sends", async () => {
    const a = await capturedIntent(); const clk = newClock(); const w = pgWorld(a, clk, { postLost: true, postLandedAnyway: true });
    const r = await pgRun(a, clk, w);
    assert.deepEqual([r.outcome, r.code, r.recordInvocations, r.recordOutcome, w.postRequests], ["WRITE_OUTCOME_UNKNOWN", "LOST_RECORD_REPLY", 1, "UNKNOWN", 1], JSON.stringify(r));
    const s = await snap(a.id);
    assert.deepEqual([s.st.state, s.st.offline_charge_id, s.ops.filter((x) => x.op_type === REC).map((x) => x.state), s.cases, s.notifies.length, w.charges.length, s.locks], ["payment_captured", null, ["outcome_unknown"], 1, 0, 1, 0]);
    const r2 = await pgRun(a, clk, pgWorld(a, clk, { postLost: true }));
    assert.deepEqual([r2.outcome, r2.code, r2.steps], ["SCOPE_REFUSED", "OPEN_CASE", 0]);
    assert.equal(w.postRequests, 1, "never a resend");
  });

  test("I3 PG integration: runner stops reach the REAL worker through its own signal / deadline — (a) run abort DURING the worker's preflight list proof → zero writes, the worker's STOP action, row pending; (b) deadline reached during the confirming read after the POST → the reply is inadmissible: outcome_unknown, ONE charge, no completion / notify; (c) a stop observed by the worker after the DURABLE completion → the row stays succeeded with the success event deferred, NO notify, and the runner reports it honestly (this runner never re-admits a non-pristine row)", async () => {
    { const a = await capturedIntent(); const clk = newClock(); const ac = new AbortController();
      const w = pgWorld(a, clk, { onList: (n) => { if (n === 2) ac.abort(); } });                 // list read #1 = the runner's proof; #2 = the worker's preflight list
      const r = await pgRun(a, clk, w, { runSignal: ac.signal });
      assert.deepEqual([r.outcome, r.code, r.recordInvocations, w.postRequests], ["ABORTED", "STOP_ABORTED", 0, 0], JSON.stringify(r));
      assert.ok(r.actions.some((x) => x.startsWith("STOP:SIGNAL:")) && r.actions.includes("READ:LIST:TRANSPORT_STOPPED:pending"), JSON.stringify([r.actions, r.workerStop]));
      const s = await snap(a.id); assert.deepEqual([s.st.state, s.ops.filter((x) => x.op_type === REC).map((x) => x.state), s.notifies.length, s.locks], ["payment_captured", ["pending"], 0, 0]); }
    { const a = await capturedIntent(); const clk = newClock(); let monoCalls = 0;
      const w = pgWorld(a, clk, { onList: (n) => { if (n === 3) clk.jump(45 * 1000); } });   // list read #3 = the worker's confirming read after the POST: the worker's own deadlineAt (30 s left) passes; leases (90 s / 120 s) still valid
      const r = await pgRun(a, clk, w, { monotonic: () => performance.now() + (monoCalls++ === 0 ? 0 : C.budgets.runMs - 30 * 1000) });   // the run's wall deadline = 30 s after the first (endsAt) read
      assert.deepEqual([r.outcome, r.code, r.recordInvocations, w.postRequests, w.charges.length, r.workerStop?.code], ["WRITE_OUTCOME_UNKNOWN", "WORKER_SETTLED_UNKNOWN", 1, 1, 1, "DEADLINE"], JSON.stringify(r));
      assert.ok(r.actions.some((x) => /^UNKNOWN:CONFIRM_(TRANSPORT_STOPPED|STOPPED_DEADLINE)$/.test(x)) && r.actions.includes("STOP:DEADLINE:read_listOfflineCharges"), JSON.stringify(r.actions));
      const s = await snap(a.id); assert.deepEqual([s.st.state, s.st.offline_charge_id, s.ops.filter((x) => x.op_type === REC).map((x) => x.state), s.notifies.length, s.locks], ["payment_captured", null, ["outcome_unknown"], 0, 0]); }
    { const a = await capturedIntent(); const clk = newClock(); const ac = new AbortController();
      const q = db.app.query.bind(db.app);
      const pool = { query: async (...x) => { const out = await q(...x); if (typeof x[0] === "string" && /SELECT booking\.complete_recording_with_evidence\(/.test(x[0])) ac.abort(); return out; }, connect: (...x) => db.app.connect(...x) };   // aborts on the worker's ONE completion statement (not the runner's to_regprocedure schema read)
      const w = pgWorld(a, clk);
      const r = await pgRun(a, clk, w, { runSignal: ac.signal, pool });
      assert.deepEqual([r.outcome, r.code, r.recordInvocations, w.postRequests], ["ABORTED", "STOP_ABORTED", 1, 1], JSON.stringify(r));
      assert.ok(r.actions.includes("COMPLETED") && (r.actions.includes("COMPLETED:EVENT_DEFERRED") || r.actions.includes("RECORDED!STOPPED")), JSON.stringify(r.actions));
      const s = await snap(a.id);
      assert.deepEqual([s.st.state, s.st.offline_charge_id, s.ops.filter((x) => x.op_type === REC).map((x) => [x.state, x.result_ref]), s.notifies.length, s.locks], ["payment_captured", null, [["succeeded", "7700001"]], 0, 0]);
      const r2 = await pgRun(a, clk, pgWorld(a, clk));
      assert.deepEqual([r2.outcome, r2.code, r2.steps, w.postRequests], ["START_STATE_NOT_ELIGIBLE", "RECORDING_NOT_PRISTINE", 0, 1], "the deferred lineage needs its OWN reviewed admission; never a resend here"); }
  });

  test("I4 PG integration: prior / historic refusals on real rows — a prior marked charge at the provider → PROVIDER_PROOF_FAILED before the worker; a recording hold → START refusal; held lock elsewhere → LOCK_NOT_ACQUIRED with zero exchanges", async () => {
    { const a = await capturedIntent(); const clk = newClock(); const w = pgWorld(a, clk);
      w.charges.push({ id: 7799999, listingMapId: LIST, reservationId: Number(a.rid), type: "charge", title: `maraVilla payment mvoch1-${a.id}`, currency: "USD", paymentMethod: "credit_card", amount: a.total / 100, status: "paid", paymentProvider: "offline" });
      const r = await pgRun(a, clk, w); assert.deepEqual([r.outcome, r.code, r.steps, w.postRequests], ["PROVIDER_PROOF_FAILED", "PRIOR_MARKED_CHARGE_PRESENT", 0, 0]); }
    { const a = await capturedIntent(); const clk = newClock();
      const look = { id: 7788888, listingMapId: LIST, reservationId: Number(a.rid), type: "charge", title: `maraVilla payment mvoch1-${a.id} (dup)`, currency: "USD", paymentMethod: "credit_card", amount: 1, status: "paid", paymentProvider: "offline" };
      const w = pgWorld(a, clk, { onList: (n, ww) => { if (n === 2) ww.charges.push(look); } });          // a lookalike appears between the runner's proof read and the worker's own read
      const r = await pgRun(a, clk, w);
      assert.deepEqual([r.outcome, r.code, r.recordInvocations, w.postRequests, r.holds], ["RECORDING_HELD", "HOLD_OPEN", 0, 0, 1], JSON.stringify(r));
      assert.ok(r.actions.includes("HOLD:PREFLIGHT"), JSON.stringify(r.actions));
      const r2 = await pgRun(a, clk, pgWorld(a, clk));
      assert.deepEqual([r2.outcome, r2.code, r2.steps], ["SCOPE_REFUSED", "OPEN_CASE", 0], "a held recording (its hold opens an owner case) is refused read-only by the next session"); }
    { const a = await capturedIntent(); const clk = newClock(); const w = pgWorld(a, clk);
      const holder = await db.app.connect();
      try { await holder.query("SELECT pg_advisory_lock(pg_catalog.hashtext($1), 0)", [LK.LOCK_KEY]);
        const r = await pgRun(a, clk, w); assert.deepEqual([r.outcome, r.code, w.calls.length, r.steps], ["LOCK_NOT_ACQUIRED", "RUN_LOCK_PRESENT", 0, 0]);
      } finally { await holder.query("SELECT pg_advisory_unlock(pg_catalog.hashtext($1), 0)", [LK.LOCK_KEY]); holder.release(); } }
  });
}
