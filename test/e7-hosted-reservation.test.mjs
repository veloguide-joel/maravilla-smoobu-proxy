// E7 Slice 1 hosted TEST reservation runner — LABELS
//   * REAL: the runner; from the PINNED tooling (E7_TOOLING_DIR, default ../../tooling = workflow layout): the transports T, the executor
//     adapters EA, the accepted v3 PI proof CP, env preflight C1, validateAdapterConfig HR, LOCK_KEY / LOCK_PRECHECK_SQL.
//   * FAKE (unit tests): the DB (tagged SELECT fake), the worker (drives the REAL executors → REAL T → the runner fence → fake exchange),
//     the provider exchanges, credentials. No network primitive is touched (guarded).
//   * OPT-IN INTEGRATION (E7_HRS_DB_TESTS=1 + PG_BIN): the REAL merged runOrchestratorStep / repo / operations on a DISPOSABLE PostgreSQL
//     (tooling test/db/harness.mjs + fixtures.mjs), FAKE exchanges only. The hosted preflight child never sets E7_HRS_DB_TESTS.
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
const E = await import("../scripts/e7-hosted-reservation.mjs");
const [T, EA, HR, C1, CP, LK] = await Promise.all([tool("scripts/e7-connected/http-transports.mjs"), tool("scripts/e7-connected/executor-adapters.mjs"),
  tool("lib/hostaway-reservations.js"), tool("scripts/e7-connected/probe-env-preflight.mjs"), tool("lib/checkout/capture-proof.js"), tool("scripts/e7-connected/run-lock-precheck.mjs")]);
after(() => { assert.deepEqual(GUARD, { request: 0, Agent: 0, fetch: 0 }, "no real network primitive was touched"); });

const C = E.CONSTANTS;
const IID = "11111111-2222-4333-8444-555555555555"; const PI = "pi_FAKEhostedRes001"; const VER = 4; const REF = "MV-FAKE0001"; const ACCT = C.accountId;
const AMT = 14000; const FROM = "2026-11-25"; const TO = "2026-11-26"; const NB = "2026-11-12T00:00:00.000Z"; const CREATED = Date.UTC(2026, 10, 12, 15, 0, 0);
const CAPTURE_BEFORE = Date.UTC(2026, 10, 19, 15, 0, 0); const ATTEMPT = "a1"; const RID = "71999901";
const enc = (o) => new TextEncoder().encode(JSON.stringify(o));
const plan = (over = {}) => E.buildPlan(C, { approvalRef: "SYNTHETIC-hosted-res", intentId: IID, expectedVersion: VER, notBefore: NB, admission: "authorized", reservationId: "",
  runnerDigest: "0".repeat(64), ...over }).plan;

// ---------------------------------------------------------------------------------------------------------------------------------
// fake world: DB rows + providers; the fake worker mutates it the way the accepted worker would
function world(o = {}) {
  const w = { status: o.status ?? "payment_authorized", version: VER, ops: [], hx: [], claimReleased: false, calls: [], workerCalls: 0, res: null, echoRef: o.echoRef ?? true,
    lease: null, dispatch: null, createdAt: o.createdAt ?? CREATED, piStatus: "requires_capture", lockRows: 1 };
  w.ops.push({ op_type: "stripe.create_checkout_session", state: "succeeded", attempts: 1, dispatched: true, result_ref: "cs_test_FAKE01", late_result_ref: null, payload_rid: null });
  w.ops.push({ op_type: "stripe.retrieve_checkout_session", state: "succeeded", attempts: 1, dispatched: true, result_ref: null, late_result_ref: null, payload_rid: null });
  w.ops.push({ op_type: "stripe.retrieve_payment_intent", state: "succeeded", attempts: 1, dispatched: true, result_ref: null, late_result_ref: null, payload_rid: null });
  if (o.pending) { w.status = "reservation_pending"; w.ops.push({ op_type: "hostaway.create_reservation", state: o.createState ?? "succeeded", attempts: 1, dispatched: true, result_ref: o.createRef ?? RID, late_result_ref: null, payload_rid: null }); w.hx = [{ state: "dispatched", rid: null }]; }
  return w;
}
const intentOf = (w) => ({ id: IID, status: w.status, version: w.version, listingId: 606998, from: FROM, to: TO, guests: 1, ref: REF, createdAt: w.createdAt,
  price: { currency: "USD", finalTotalMinor: AMT, rateBps: 1000 }, payment: { paymentIntentId: PI, livemode: false, capturedMinor: 0, amountMinor: AMT, currency: "USD", captureBefore: CAPTURE_BEFORE },
  reservation: w.res ? { reservationId: w.res } : null, checkout: { sessionId: "cs_test_FAKE01" }, lease: w.lease, dispatch: w.dispatch });
function fakePool(w, o = {}) {
  const tag = (sql) => /\/\*e7hrs:(\w+)\*\//.exec(sql)?.[1];
  const p = { reads: 0, lockClients: [], async query(sql) {
    this.reads += 1;
    if (o.dbFailAt && this.reads === o.dbFailAt) throw new Error("db down");
    switch (tag(sql)) {
      case "instance": return { rows: [{ environment: o.env ?? "test" }] };
      case "attempts": return { rows: [{ id: ATTEMPT, status: "completed", checkout_session_id: "cs_test_FAKE01", payment_intent_id: PI, livemode: false }] };
      case "hostaway": return { rows: w.hx.map((x) => ({ ...x })) };
      case "ops": return { rows: w.ops.map((x) => ({ ...x })) };
      case "cases": return { rows: [{ n: o.cases ?? 0 }] };
      case "claims": return { rows: [{ listing_id: 606998, released: w.claimReleased }] };
      case "guest": return { rows: [{ first_name: "Zan", last_name: "Quin", email: "zq@example.test", is_app: true, is_report: false, privileged: false }] };
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
        const own = `${LK.LOCK_PRECHECK_SQL} AND l.pid = pg_catalog.pg_backend_pid()`;
        assert.ok(sql === `SELECT (${own}) AS n, pg_catalog.pg_backend_pid() AS pid` || sql === own, "own-lock proof statement (pid-stable form, or the pre-F4 form)"); assert.deepEqual(params, [LK.LOCK_KEY]);
        cl.proofs += 1;
        if (o.hopAtProof && cl.proofs >= o.hopAtProof) cl.pid += 1;                                 // F4 simulation: a transaction-pooler backend hop
        if (o.onProofResolve) o.onProofResolve(cl.proofs);                                           // F1 reproduction hook (runs as the proof resolves)
        return { rows: [{ n: typeof o.lockLostAt === "number" && w.workerCalls >= o.lockLostAt ? 0 : w.lockRows, pid: cl.pid }] };
      }
      if (tag(sql) === "identity") return { rows: [{ db: o.lockDb ?? "fake", environment: "test" }] };
      throw new Error(`unexpected lock SQL ${sql.slice(0, 40)}`);
    }, release(destroy) { w.lockReleased = destroy === true ? "destroyed" : "pooled"; }, on(ev, fn) { if (ev === "error") cl.errorFn = fn; } };
    w.lockClient = cl; return cl; };
  return p;
}
const piObj = (w) => ({ object: "payment_intent", id: PI, livemode: false, status: w.piStatus, capture_method: "manual", amount: AMT, amount_received: 0,
  amount_capturable: w.piStatus === "requires_capture" ? AMT : 0, currency: "usd", metadata: { mv_intent_id: IID, mv_payment_attempt_id: ATTEMPT },
  latest_charge: { object: "charge", id: "ch_FAKEhosted01", payment_intent: PI, status: "succeeded", paid: true, captured: false, amount: AMT, amount_captured: 0,
    amount_refunded: 0, currency: "usd", livemode: false, payment_method_details: { card: { capture_before: CAPTURE_BEFORE / 1000 } } } });
const resObj = (w, id = w.res ?? RID) => ({ id: Number(id), listingMapId: 606998, channelId: 2000, arrivalDate: FROM, departureDate: TO, totalPrice: 140, currency: "USD", status: "new",
  customFieldValues: w.echoRef ? [{ customFieldId: C.refFieldId, value: REF }] : [] });
function exchanges(w, o = {}) {
  const reply = (status, obj) => Promise.resolve({ status, contentType: "application/json", bytes: enc(obj) });
  const stripe = (req) => { w.calls.push(`S:${req.method} ${req.url.replace("https://api.stripe.com", "")}`); if (req.url.endsWith("/v1/account")) return reply(200, { object: "account", id: ACCT }); return reply(200, piObj(w)); };
  const hostaway = (req) => {
    const p = req.url.replace("https://api.hostaway.com", ""); w.calls.push(`H:${req.method} ${p}`);
    if (o.hostawayStatus) return reply(o.hostawayStatus, { status: "fail", message: "unauthorized" });
    if (req.method === "GET" && /^\/v1\/listings\/\d+$/.test(p)) return reply(200, { result: { id: 606998, currencyCode: "USD", personCapacity: 4, minNights: 1, maxNights: 90 } });
    if (req.method === "GET" && /\/calendar\?/.test(p)) return reply(200, { result: [{ date: FROM, status: "available", isAvailable: 1, minimumStay: 1, maximumStay: 90, closedOnArrival: 0, closedOnDeparture: 0 }] });
    if (req.method === "POST" && /priceDetails$/.test(p)) return reply(200, { status: "success", result: { totalPrice: 140, components: [{ id: 1, type: "accommodation", name: "baseRate", title: "Base rate", quantity: 1, value: 140, total: 140, isIncludedInTotalPrice: 1, isMandatory: 1, isOverriddenByUser: 0, isDeleted: 0, units: 1 }] } });
    if (req.method === "GET" && p.startsWith("/v1/reservations?")) return reply(200, { status: "success", result: w.res && !new URL(req.url).searchParams.has("afterId") ? [resObj(w)] : [] });
    if (req.method === "POST" && p === "/v1/reservations") { if (o.createLost) return Promise.reject(new Error("socket reset")); w.res = RID; return reply(201, { status: "success", result: resObj(w) }); }
    if (req.method === "GET" && /^\/v1\/reservations\/\d+$/.test(p)) return reply(200, { status: "success", result: resObj(w, p.split("/").pop()) });
    return reply(404, { status: "fail" });
  };
  return { stripe, hostaway };
}
/** the fake worker: drives the REAL reservation executors (→ real T → the runner fence → fake exchange) the way the accepted worker would:
 *  step A (payment_authorized): lookup by ref, pricing recheck, ONE create → reservation_pending (create op succeeded, result_ref);
 *  step B (reservation_pending): the confirming by-id read on the bound id → reservation_confirmed (+ a pristine capture row) */
function fakeWorker(w, o = {}) {
  return async (pool, { executors, intentId, env, listings }) => {
    w.workerCalls += 1;
    assert.equal(intentId, IID); assert.deepEqual(env, { VERCEL_ENV: "development", MV_E7_RESERVATION_WORKER: "enabled", DIRECT_DISCOUNT_BPS: "1000" });
    assert.deepEqual([...listings.keys()], [606998]);
    const sig = AbortSignal.timeout(5000); const actions = [];
    try {
      if (w.status === "payment_authorized") {
        if (o.wrongLookup) await executors.lookupPage({ method: "GET", path: "/v1/reservations", query: { listingId: 606998, channelId: 2000, arrivalStartDate: "2026-11-24", arrivalEndDate: "2026-11-24", limit: 100, includeResources: 1 } }, { signal: sig });
        const lk = await executors.lookupPage({ method: "GET", path: "/v1/reservations", query: { listingId: 606998, channelId: 2000, arrivalStartDate: FROM, arrivalEndDate: FROM, limit: 100, includeResources: 1 } }, { signal: sig });
        if (lk.httpStatus !== 200) { actions.push(`STOP:AUTH_${lk.httpStatus}`); return { status: "worked", intentId: IID, actions, delayMs: 0, late: Promise.resolve([]) }; }   // = the accepted worker's 401/403 escalation (no create)
        await executors.pricing.get(`/listings/606998`, { signal: sig });
        await executors.pricing.get(`/listings/606998/calendar`, { query: { startDate: FROM, endDate: TO }, signal: sig });
        await executors.pricing.post(`/listings/606998/calendar/priceDetails`, { startingDate: FROM, endingDate: TO, numberOfGuests: 1, version: 2 }, { signal: sig });
        const body = { listingMapId: 606998, channelId: 2000, arrivalDate: FROM, departureDate: TO, numberOfGuests: 1, totalPrice: 140, currency: "USD", guestName: "Zan Quin", guestFirstName: "Zan", guestLastName: "Quin",
          guestEmail: "zq@example.test", customFieldValues: [{ customFieldId: C.refFieldId, value: REF }] };
        w.status = "reservation_pending"; const op = { op_type: "hostaway.create_reservation", state: "pending", attempts: 1, dispatched: true, result_ref: null, late_result_ref: null, payload_rid: null };
        w.ops.push(op); w.hx = [{ state: "dispatched", rid: null }];
        const cr = await executors.createReservation({ method: "POST", path: "/v1/reservations", query: {}, body }, { signal: sig });
        if (cr.httpStatus === 201) { op.state = "succeeded"; op.result_ref = RID; actions.push("CREATE_201"); }
        if (o.twice) await executors.createReservation({ method: "POST", path: "/v1/reservations", query: {}, body }, { signal: sig });
      } else {
        if (o.foreignRead) await executors.retrieveReservation({ method: "GET", path: `/v1/reservations/${C.protectedReservationIds[0]}`, query: {} }, { signal: sig });
        await executors.retrieveReservation({ method: "GET", path: `/v1/reservations/${RID}`, query: {} }, { signal: sig });
        if (!o.stayPending) { w.status = "reservation_confirmed"; w.version += 1; w.res = RID; w.hx = [{ state: "succeeded", rid: RID }];
          w.ops.push({ op_type: "stripe.capture_payment_intent", state: "pending", attempts: 0, dispatched: false, result_ref: null, late_result_ref: null, payload_rid: null }); actions.push("RESERVATION_SUCCEEDED->reservation_confirmed"); }
      }
    } catch (e) { actions.push(`STOP:EXECUTOR_${/stopped/.test(String(e && e.message)) ? "STOPPED" : "FAILED"}`); if (o.lostIsUnknown) { const op = w.ops.find((x) => x.op_type === "hostaway.create_reservation"); if (op && op.state === "pending") op.state = "outcome_unknown"; } }
    return { status: "worked", intentId: IID, actions, delayMs: o.delayMs ?? 30000, late: Promise.resolve([]) };
  };
}
function core(w, o = {}) {
  const pool = fakePool(w, o); w.pool = pool;
  const tooling = { runOrchestratorStep: o.worker ?? fakeWorker(w, o), loadIntent: async () => intentOf(w), createPhaseExecutors: EA.createPhaseExecutors, createStripeSend: T.createE7StripeTestSend,
    createHostawaySend: T.createE7HostawaySend, validateAdapterConfig: HR.validateAdapterConfig, paymentIntentProofObservationV3: CP.paymentIntentProofObservationV3,
    stillAuthorizedV3Refusal: CP.stillAuthorizedV3Refusal, LOCK_KEY: LK.LOCK_KEY, LOCK_PRECHECK_SQL: LK.LOCK_PRECHECK_SQL };
  const x = exchanges(w, o);
  return E.runReservationCore({ plan: o.plan ?? plan(), pool, lockClientFactory: () => pool.lock(), tooling, exchanges: o.wrapExchanges ? o.wrapExchanges(x) : x,
    credentials: { stripe: () => "sk_test_Fake1", hostaway: () => "synthetic-hostaway-token" }, sleep: async () => {}, runSignal: o.signal, monotonic: o.monotonic,
    clock: () => Date.UTC(2026, 10, 12, 16, 0, 0) + (w.tick = (w.tick ?? 0) + 1000) });
}
const writes = (w) => w.calls.filter((x) => /^(S:POST|H:POST \/v1\/reservations$|H:PUT|H:DELETE)/.test(x));

// ---------------------------------------------------------------------------------------------------------------------------------
test("A1 happy path (FAKE providers, REAL transports + executors): account + strict PI proof, lock proven before every step, exactly ONE create, confirmed intermediate; capture queued pristine reported; lock released", async () => {
  const w = world();
  const r = await core(w);
  assert.equal(r.outcome, "RESERVATION_CONFIRMED_INTERMEDIATE", JSON.stringify(r));
  assert.deepEqual([r.steps, r.createInvocations, r.createOutcome, r.reservationId, r.captureQueuedPristine, r.lock, w.lockReleased], [2, 1, "REPLIED", RID, true, "released", "pooled"]);
  assert.deepEqual(writes(w), ["H:POST /v1/reservations"]);
  assert.deepEqual(r.proofs, ["BEFORE_WORKER"]); assert.equal(r.accountReads, 1); assert.equal(r.piReads, 1);
  assert.equal(w.calls.some((x) => /capture|cancel|refund|guestPayments|statuses/.test(x)), false);
  assert.ok(r.actions.includes("RESERVATION_SUCCEEDED->reservation_confirmed"));
});

test("A2 strict Stripe proof gates the worker: canceled / captured / wrong amount / wrong account → PROVIDER_PROOF_FAILED with ZERO Hostaway calls and ZERO worker steps", async () => {
  for (const [label, mutate, code] of [["canceled", (w) => { w.piStatus = "canceled"; }, "NOT_REQUIRES_CAPTURE"]]) {
    const w = world(); mutate(w);
    const r = await core(w);
    assert.deepEqual([r.outcome, r.code, r.steps, w.workerCalls], ["PROVIDER_PROOF_FAILED", code, 0, 0], label);
    assert.equal(w.calls.filter((x) => x.startsWith("H:")).length, 0, label);
  }
  { const w = world(); const r = await E.runReservationCore({ plan: plan(), pool: fakePool(w), lockClientFactory: () => fakePool(w).lock(), exchanges: { stripe: (req) => Promise.resolve({ status: 200, contentType: "application/json", bytes: enc(req.url.endsWith("/v1/account") ? { object: "account", id: "acct_OTHER0000000001" } : piObj(w)) }), hostaway: exchanges(w).hostaway },
    tooling: { runOrchestratorStep: fakeWorker(w), loadIntent: async () => intentOf(w), createPhaseExecutors: EA.createPhaseExecutors, createStripeSend: T.createE7StripeTestSend, createHostawaySend: T.createE7HostawaySend, validateAdapterConfig: HR.validateAdapterConfig, paymentIntentProofObservationV3: CP.paymentIntentProofObservationV3, stillAuthorizedV3Refusal: CP.stillAuthorizedV3Refusal, LOCK_KEY: LK.LOCK_KEY, LOCK_PRECHECK_SQL: LK.LOCK_PRECHECK_SQL },
    credentials: { stripe: () => "sk_test_Fake1", hostaway: () => "x" }, sleep: async () => {} });
    assert.equal(r.outcome, "PROVIDER_PROOF_FAILED"); assert.ok(["ACCOUNT", "READ_FAILED"].includes(r.code), r.code); assert.equal(w.workerCalls, 0); }
  { const w = world(); const r = await core(w, { hostawayStatus: 401, plan: plan() });   // Stripe proof passes; the worker's first Hostaway read gets 401 → the fake worker stops; the runner never sends a create
    assert.notEqual(r.outcome, "RESERVATION_CONFIRMED_INTERMEDIATE"); assert.equal(writes(w).length, 0); }
});

test("A3 start refusals (read-only, ZERO provider calls, ZERO lock): wrong state / version / listing / historic / previous dispatch / protected id / open case / forbidden op / non-TEST DB / released claim", async () => {
  const cases = [
    [world({ status: "reservation_confirmed" }), {}, "START_STATE_NOT_ELIGIBLE", "STATE_NOT_PAYMENT_AUTHORIZED"],
    [world(), { plan: plan({ expectedVersion: 3 }) }, "START_STATE_NOT_ELIGIBLE", "VERSION_NOT_PINNED"],
    [world({ createdAt: Date.UTC(2026, 10, 11, 0, 0, 0) }), {}, "START_STATE_NOT_ELIGIBLE", "HISTORIC_INTENT"],
    [(() => { const w = world(); w.ops.push({ op_type: "hostaway.create_reservation", state: "pending", attempts: 0, dispatched: false, result_ref: null, late_result_ref: null, payload_rid: null }); return w; })(), {}, "START_STATE_NOT_ELIGIBLE", "PREVIOUS_DISPATCH_PRESENT"],
    [(() => { const w = world(); w.dispatch = { at: 1, attempt: 1 }; return w; })(), {}, "START_STATE_NOT_ELIGIBLE", "PREVIOUS_DISPATCH_PRESENT"],
    [(() => { const w = world(); w.hx = [{ state: "dispatched", rid: C.protectedReservationIds[1] }]; return w; })(), {}, "SCOPE_REFUSED", "PROTECTED_REFERENCE"],
    [world(), { cases: 1 }, "SCOPE_REFUSED", "OPEN_CASE"],
    [(() => { const w = world(); w.ops.push({ op_type: "stripe.void_payment_intent", state: "pending", attempts: 0, dispatched: false, result_ref: null, late_result_ref: null, payload_rid: null }); return w; })(), {}, "SCOPE_REFUSED", "FORBIDDEN_OP_PRESENT"],
    [world(), { env: "production" }, "SCOPE_REFUSED", "DATABASE_NOT_TEST"],
    [(() => { const w = world(); w.claimReleased = true; return w; })(), {}, "SCOPE_REFUSED", "CLAIM_NOT_HELD"],
    [world({ pending: true, createState: "outcome_unknown" }), { plan: plan({ admission: "pending", reservationId: RID }) }, "START_STATE_NOT_ELIGIBLE", "CREATE_NOT_PROVEN_SUCCEEDED"],
    [world({ pending: true, createRef: "71999902" }), { plan: plan({ admission: "pending", reservationId: RID }) }, "START_STATE_NOT_ELIGIBLE", "CREATE_NOT_PROVEN_SUCCEEDED"],
    [world({ pending: true }), {}, "START_STATE_NOT_ELIGIBLE", "STATE_NOT_PAYMENT_AUTHORIZED"]];
  for (const [w, o, outcome, code] of cases) {
    const r = await core(w, o);
    assert.deepEqual([r.outcome, r.code, w.calls.length, w.workerCalls, r.lock], [outcome, code, 0, 0, "not_acquired"], code);
  }
  { const f = { instance: "test", intent: { ...intentOf(world()), listingId: 603566 }, attempts: [], hostaway: [], ops: [], openCases: 0, claims: [] };
    assert.equal(E.checkStart(f, plan()).code, "LISTING_NOT_SCOPED"); }
});

test("A4 real lock semantics: lock held elsewhere → LOCK_NOT_ACQUIRED with zero provider calls; lock lost before a step → LOCK_LOST, no further step; unlock checked on teardown", async () => {
  { const w = world(); const r = await core(w, { lockHeldElsewhere: true });
    assert.deepEqual([r.outcome, r.code, w.calls.length, w.workerCalls, r.lock], ["LOCK_NOT_ACQUIRED", "RUN_LOCK_PRESENT", 0, 0, "not_acquired"]); }
  { const w = world(); const r = await core(w, { lockLostAt: 1, stayPending: true });
    assert.deepEqual([r.outcome, r.code, w.workerCalls], ["LOCK_LOST", "LOCK_NOT_HELD", 1], JSON.stringify(r)); assert.ok(["released", "unlock_failed_connection_destroyed"].includes(r.lock)); }
});

test("A5 lost create reply → CREATE_OUTCOME_UNKNOWN, exactly ONE POST, no second send (fence refuses), persisted effects reported; a second create attempt in the same run is refused at the boundary", async () => {
  { const w = world(); const r = await core(w, { createLost: true, lostIsUnknown: true });
    assert.deepEqual([r.outcome, r.code, r.createInvocations, r.createOutcome], ["CREATE_OUTCOME_UNKNOWN", "LOST_CREATE_REPLY", 1, "UNKNOWN"], JSON.stringify(r));
    assert.deepEqual(writes(w), ["H:POST /v1/reservations"]); }
  { const w = world(); const r = await core(w, { twice: true });
    assert.deepEqual(writes(w), ["H:POST /v1/reservations"], "the second create never left the process"); assert.ok(r.refusedAtTransport >= 1); }
});

test("A6 target-only fence: a lookup for ANOTHER arrival date, a read of a PROTECTED id, a Stripe write, a create in pending admission never leave the process", async () => {
  { const w = world(); await core(w, { wrongLookup: true }); assert.equal(w.calls.some((x) => x.includes("2026-11-24")), false); }
  { const w = world(); await core(w, { foreignRead: true }); assert.equal(w.calls.some((x) => x.includes(C.protectedReservationIds[0])), false); }
  { const w = world({ pending: true, echoRef: true }); w.res = RID;
    const r = await core(w, { plan: plan({ admission: "pending", reservationId: RID }), worker: async (pool, { executors }) => {
      let refused = 0;
      try { await executors.createReservation({ method: "POST", path: "/v1/reservations", query: {}, body: {} }, { signal: AbortSignal.timeout(1000) }); } catch { refused += 1; }
      assert.equal(refused, 1, "recovery factory never creates");
      await executors.retrieveReservation({ method: "GET", path: `/v1/reservations/${RID}`, query: {} }, { signal: AbortSignal.timeout(1000) });
      w.status = "reservation_confirmed"; w.version += 1; w.hx = [{ state: "succeeded", rid: RID }];
      return { status: "worked", intentId: IID, actions: ["RECONCILED"], delayMs: 0, late: Promise.resolve([]) }; } });
    assert.deepEqual([r.outcome, r.createInvocations, writes(w).length, r.admission], ["RESERVATION_CONFIRMED_INTERMEDIATE", 0, 0, "pending"], JSON.stringify(r)); }
});

test("A7 stop latch: aborted before start → no lock, no provider call; aborted during the worker → no create, STOP_ABORTED with persisted facts; deadline between steps → DEADLINE", async () => {
  { const w = world(); const ac = new AbortController(); ac.abort(); const r = await core(w, { signal: ac.signal });
    assert.deepEqual([r.outcome, r.code, w.calls.length, r.lock], ["ABORTED", "STOP_ABORTED", 0, "not_acquired"]); }
  { const w = world(); const ac = new AbortController(); const x = exchanges(w);
    const r = await E.runReservationCore({ plan: plan(), pool: fakePool(w), lockClientFactory: () => fakePool(w).lock(), exchanges: { stripe: x.stripe, hostaway: (req) => { if (/priceDetails/.test(req.url)) ac.abort(); return x.hostaway(req); } },
      tooling: { runOrchestratorStep: fakeWorker(w), loadIntent: async () => intentOf(w), createPhaseExecutors: EA.createPhaseExecutors, createStripeSend: T.createE7StripeTestSend, createHostawaySend: T.createE7HostawaySend, validateAdapterConfig: HR.validateAdapterConfig, paymentIntentProofObservationV3: CP.paymentIntentProofObservationV3, stillAuthorizedV3Refusal: CP.stillAuthorizedV3Refusal, LOCK_KEY: LK.LOCK_KEY, LOCK_PRECHECK_SQL: LK.LOCK_PRECHECK_SQL },
      credentials: { stripe: () => "sk_test_Fake1", hostaway: () => "x" }, sleep: async () => {}, runSignal: ac.signal });
    assert.deepEqual([r.outcome, r.stopReason, r.createInvocations, writes(w).length], ["ABORTED", "ABORTED", 0, 0], JSON.stringify(r)); }
  { const w = world(); let m = 0; const r = await core(w, { stayPending: true, monotonic: () => { m += 1; return m > 12 ? 10 ** 9 : 0; } });
    assert.equal(r.outcome, "DEADLINE", JSON.stringify(r)); }
});

test("A8 DB failure during the start read → DB_ERROR, nothing sent, no lock", async () => {
  const w = world(); const r = await core(w, { dbFailAt: 2 });
  assert.deepEqual([r.outcome, r.code, w.calls.length, r.lock], ["DB_ERROR", "START_READ_FAILED", 0, "not_acquired"]);
});

test("A9 postcheck agreement: a worker that claims confirmation while the capture row is NOT pristine or the claim released → POSTCHECK_MISMATCH (never a false success)", async () => {
  const w = world(); const r = await core(w, { worker: async () => { w.status = "reservation_confirmed"; w.res = RID; w.ops.push({ op_type: "hostaway.create_reservation", state: "succeeded", attempts: 1, dispatched: true, result_ref: RID, late_result_ref: null, payload_rid: null });
    w.ops.push({ op_type: "stripe.capture_payment_intent", state: "pending", attempts: 1, dispatched: true, result_ref: null, late_result_ref: null, payload_rid: null }); return { status: "worked", intentId: IID, actions: [], delayMs: 0, late: Promise.resolve([]) }; } });
  assert.deepEqual([r.outcome, r.code], ["POSTCHECK_MISMATCH", "CAPTURE_NOT_PRISTINE"]);
});

test("C1 code ceiling: Slice 1 execution CLOSED (executeEnabled false), tooling 40779e34 MERGED; plan pins exact scope and ZERO capture / refund / record / notify / cancel / void", () => {
  assert.equal(C.executeEnabled, false); assert.equal(C.toolingCommit, "40779e34e8c65ac5c4494bc5a18cd4223ef723fa"); assert.equal(C.toolingStatus, "MERGED");
  const p = plan(); assert.deepEqual(p.writes, { hostawayCreateMax: 1, capture: 0, refund: 0, record: 0, notify: 0, cancel: 0, void: 0, account: 0, keys: 0 });
  assert.deepEqual(plan({ admission: "pending", reservationId: RID }).writes.hostawayCreateMax, 0);
  for (const bad of [{ admission: "authorized", reservationId: RID }, { admission: "pending", reservationId: "" }, { admission: "pending", reservationId: C.protectedReservationIds[0] },
    { notBefore: "2026-11-12" }, { notBefore: "2026-11-12T00:00:00+02:00" }, { expectedVersion: 0 }, { intentId: "not-a-uuid" }]) assert.throws(() => E.buildPlan(C, { approvalRef: "x", intentId: IID, expectedVersion: VER, notBefore: NB, admission: "authorized", reservationId: "", runnerDigest: "0".repeat(64), ...bad }), /e7-hosted-reservation/, JSON.stringify(bad));
  const ph = (over) => E.buildPlan(C, { approvalRef: "x", intentId: IID, expectedVersion: VER, notBefore: NB, admission: "authorized", reservationId: "", runnerDigest: "0".repeat(64), ...over }).planHash;
  assert.notEqual(ph({}), ph({ notBefore: "2026-11-13T00:00:00.000Z" })); assert.notEqual(ph({}), ph({ expectedVersion: VER + 1 }));
});

test("C2 closure: the INDEPENDENTLY scanned transitive relative imports of the runner's tooling roots == CONSTANTS.closure; framed digest == the pin; no R1 / reconcile / stager / worker-other file", async () => {
  const roots = ["lib/booking-db/reservation-worker.js", "lib/booking-db/repo.js", "scripts/e7-connected/executor-adapters.mjs", "scripts/e7-connected/http-transports.mjs", "scripts/e7-connected/real-exchange.mjs",
    "lib/booking-db/pool.js", "lib/hostaway-reservations.js", "lib/checkout/capture-proof.js", "scripts/e7-connected/run-lock-precheck.mjs", "scripts/e7-connected/probe-env-preflight.mjs"];
  const src = readFileSync(join(ROOT, "scripts/e7-hosted-reservation.mjs"), "utf8");
  for (const f of roots) assert.ok(src.includes(`"${f}"`) || src.includes(`u("${f}")`), `runner imports ${f}`);
  const seen = new Set(); const st = [...roots];
  while (st.length) { const f = st.pop(); if (seen.has(f)) continue; seen.add(f);
    for (const m of readFileSync(join(TOOLING, f), "utf8").matchAll(/(?:import|export)\s[^"'`;]*?from\s*["'](\.[^"']+)["']|import\(\s*["'](\.[^"']+)["']\s*\)/g)) st.push(normalize(join(dirname(f), m[1] || m[2]))); }
  assert.deepEqual([...C.closure], ["package.json", "package-lock.json", ...[...seen].sort()]);
  assert.equal(await E.framedDigest(TOOLING, C.closure, E.CLOSURE_DIGEST_PREFIX), C.closureDigest);
  for (const f of C.closure) assert.doesNotMatch(f, /run-core|run-plan|run-r1|reconcile|stage-run|capture-worker|recording-worker|notification-worker|compensation-worker|test-abort/);
});

// ---------------------------------------------------------------------------------------------------------------------------------
const PROC = { versions: { node: C.nodeVersion }, platform: "linux", execArgv: [], getuid: () => 1000, once() {}, off() {} };
const okChild = async () => ({ status: 0, signal: null, stdout: "# tests 3\n# pass 3\n# fail 0\n", truncated: false, spawnFailed: false });
const realEnv = (over = {}) => ({ E7_TOOLING_DIR: TOOLING, E7_APPROVAL_REF: "label-1", E7_INTENT_ID: IID, E7_EXPECTED_VERSION: String(VER), E7_NOT_BEFORE: NB, E7_ADMISSION: "authorized", E7_RESERVATION_ID: "", ...over });

test("H1 hosted: preflight (no secrets) passes on the pinned closure; any secret outside execute is refused; partial / invalid inputs refused", async () => {
  let x = await E.runHosted({ mode: "preflight", env: { E7_TOOLING_DIR: TOOLING }, proc: PROC, wrapperDir: ROOT, deps: { spawnChild: okChild } });
  assert.deepEqual([x.exitCode, x.result.code, x.result.planKind, x.result.closureDigest, x.result.executeEnabled], [0, "PREFLIGHT_OK_SYNTHETIC_ONLY", "SYNTHETIC", C.closureDigest, false], JSON.stringify(x.result));
  x = await E.runHosted({ mode: "preflight", env: realEnv(), proc: PROC, wrapperDir: ROOT, deps: { spawnChild: okChild } });
  assert.deepEqual([x.exitCode, x.result.code, x.result.planKind], [0, "PREFLIGHT_OK_REAL_PLAN", "REAL"]);
  assert.equal(x.result.planHash, E.buildPlan(C, { approvalRef: "label-1", intentId: IID, expectedVersion: VER, notBefore: NB, admission: "authorized", reservationId: "", runnerDigest: x.result.runnerDigest }).planHash);
  for (const [env, code] of [[{ E7_TOOLING_DIR: TOOLING, E7_STRIPE_TEST_KEY: "sk_test_x" }, "HRS_SECRET_SCOPE_VIOLATION"], [realEnv({ E7_ADMISSION: "" }), "HRS_INPUT_INCOMPLETE"],
    [realEnv({ E7_INTENT_ID: "bad" }), "HRS_INPUT_INVALID"], [realEnv({ E7_ADMISSION: "pending" }), "HRS_INPUT_INVALID"], [realEnv({ E7_NOT_BEFORE: "yesterday" }), "HRS_INPUT_INVALID"],
    [realEnv({ E7_APPROVAL_REF: C.synthetic.approvalRef }), "HRS_INPUT_INVALID"]]) {
    const y = await E.runHosted({ mode: "preflight", env, proc: PROC, wrapperDir: ROOT, deps: { spawnChild: okChild } });
    assert.deepEqual([y.exitCode, y.result.code], [1, code], code);
  }
  const bad = await E.runHosted({ mode: "preflight", env: { E7_TOOLING_DIR: TOOLING }, proc: PROC, wrapperDir: ROOT, deps: { spawnChild: async () => ({ status: 1, signal: null, stdout: "# tests 3\n# pass 2\n# fail 1\n", truncated: false, spawnFailed: false }) } });
  assert.equal(bad.result.code, "HRS_TESTS_FAILED");
});

test("H2 hosted: verify / execute are CLOSED in this revision (HRS_EXECUTE_CLOSED) before any pin, ref or import check; an opened constants seam still refuses off main / wrong digests / secrets missing", async () => {
  const x = await E.runHosted({ mode: "verify", env: { ...realEnv(), E7_EXPECTED_PLAN_HASH: "0".repeat(64), E7_EXPECTED_CLOSURE_DIGEST: C.closureDigest, E7_EXPECTED_RUNNER_DIGEST: "0".repeat(64), GITHUB_REF: "refs/heads/main" }, proc: PROC, wrapperDir: ROOT, deps: {} });
  assert.deepEqual([x.exitCode, x.result.code, x.result.closureDigest], [1, "HRS_EXECUTE_CLOSED", null]);
  const y = await E.runHosted({ mode: "execute", env: { ...realEnv(), E7_STRIPE_TEST_KEY: "sk_test_x", E7_HOSTAWAY_TOKEN: "t", E7_DEV_BOOKING_DATABASE_URL: "postgresql://x" }, proc: PROC, wrapperDir: ROOT, deps: { importTooling: async () => { throw new Error("never"); } } });
  assert.deepEqual([y.exitCode, y.result.code], [1, "HRS_EXECUTE_CLOSED"]);
  // TEST SEAM: an opened copy of the constants (what a later reviewed change would do) — every other fence still holds
  const opened = { ...C, executeEnabled: true };
  const digests = async () => { const pf = await E.runHosted({ mode: "preflight", env: realEnv(), proc: PROC, wrapperDir: ROOT, deps: { spawnChild: okChild } }); return pf.result; };
  const d = await digests();
  const base = { ...realEnv(), E7_EXPECTED_PLAN_HASH: d.planHash, E7_EXPECTED_CLOSURE_DIGEST: d.closureDigest, E7_EXPECTED_RUNNER_DIGEST: d.runnerDigest, GITHUB_REF: "refs/heads/main" };
  let v = await E.runHosted({ mode: "verify", env: { ...base }, proc: PROC, wrapperDir: ROOT, deps: { constants: opened } });
  assert.deepEqual([v.exitCode, v.result.code], [0, "VERIFY_OK"], JSON.stringify(v.result));
  for (const [env, code] of [[{ ...base, GITHUB_REF: "refs/heads/feature" }, "HRS_REF_NOT_MAIN"], [{ ...base, E7_EXPECTED_CLOSURE_DIGEST: "1".repeat(64) }, "HRS_SOURCE_MISMATCH"],
    [{ ...base, E7_EXPECTED_RUNNER_DIGEST: "1".repeat(64) }, "HRS_RUNNER_MISMATCH"], [{ ...base, E7_EXPECTED_PLAN_HASH: "1".repeat(64) }, "HRS_PLAN_HASH_MISMATCH"], [{ ...base, E7_EXPECTED_PLAN_HASH: "" }, "HRS_INPUT_INCOMPLETE"]]) {
    v = await E.runHosted({ mode: "verify", env, proc: PROC, wrapperDir: ROOT, deps: { constants: opened } }); assert.deepEqual([v.exitCode, v.result.code], [1, code], code);
  }
  v = await E.runHosted({ mode: "execute", env: { ...base }, proc: PROC, wrapperDir: ROOT, deps: { constants: opened, importTooling: async () => { throw new Error("never"); } } });
  assert.deepEqual([v.exitCode, v.result.code], [1, "HRS_CREDENTIALS_MISSING"]);
  v = await E.runHosted({ mode: "execute", env: { ...base, E7_STRIPE_TEST_KEY: "sk_test_x", E7_HOSTAWAY_TOKEN: "t", E7_DEV_BOOKING_DATABASE_URL: "postgresql://u@h:1/x" }, proc: PROC, wrapperDir: ROOT, deps: { constants: opened, readPgVersion: async () => C.pgVersion } });
  assert.deepEqual([v.exitCode, v.result.code], [1, "HRS_DB_TARGET_INVALID"]);
});

test("H3 hosted: a drifted tooling byte is refused before any import (closure digest)", async () => {
  const d = mkdtempSync(join(tmpdir(), "e7-hrs-drift-"));
  try {
    for (const f of C.closure) { mkdirSync(dirname(join(d, f)), { recursive: true }); cpSync(join(TOOLING, f), join(d, f)); }
    writeFileSync(join(d, "lib/booking-db/reservation-worker.js"), `${readFileSync(join(TOOLING, "lib/booking-db/reservation-worker.js"), "utf8")}\n// drift\n`);
    const x = await E.runHosted({ mode: "preflight", env: { E7_TOOLING_DIR: d }, proc: PROC, wrapperDir: ROOT, deps: { spawnChild: okChild, importEnv: async () => C1 } });
    assert.deepEqual([x.exitCode, x.result.code], [1, "HRS_SOURCE_MISMATCH"]);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("S1 static: the runner imports node built-ins only; no capture / refund / record / notify / cancel / void call text; inert import (no listener, no output)", () => {
  const src = readFileSync(join(ROOT, "scripts/e7-hosted-reservation.mjs"), "utf8");
  for (const m of src.matchAll(/^import .* from "([^"]+)";$/gm)) assert.ok(m[1].startsWith("node:"), m[1]);
  for (const bad of ["capturePaymentIntent(", "cancelPaymentIntent(", "cancelReservation(", "createOfflineCharge(", "sendMessage(", "refunds"]) assert.equal(src.includes(bad), false, bad);
  assert.equal(process.listenerCount("SIGINT"), 0);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// ROOT review 5877116684 (PR64 @ 94f45ee3) — exact reproductions (RED on 94f45ee3; GREEN on the fixed head)
test("R1 (F1) abort / deadline exactly as the FIRST per-step lock proof resolves → ZERO admitted steps / worker calls; no provider exchange after the stop", async () => {
  { const w = world(); const ac = new AbortController();
    const r = await core(w, { signal: ac.signal, onProofResolve: (n) => { if (n === 2) ac.abort(); } });        // proof #1 = after acquire; #2 = first per-step proof
    assert.deepEqual([r.outcome, r.steps, w.workerCalls, r.createInvocations], ["ABORTED", 0, 0, 0], JSON.stringify(r));
    assert.equal(w.calls.filter((x) => x.startsWith("H:")).length, 0, "no Hostaway exchange after the stop"); }
  { const w = world(); let late = false;
    const r = await core(w, { monotonic: () => (late ? 10 ** 9 : 0), onProofResolve: (n) => { if (n === 2) late = true; } });
    assert.deepEqual([r.outcome, r.steps, w.workerCalls], ["DEADLINE", 0, 0], JSON.stringify(r)); }
});

test("R2 (F2) a lock-session error observed while the priceDetails exchange resolves (before the create) VETOES every later transport: ZERO creates, outcome LOCK_LOST / STOP_LOCK_SESSION_ERROR, lockSession error_observed, connection destroyed", async () => {
  const w = world();
  const r = await core(w, { wrapExchanges: (x) => ({ stripe: x.stripe, hostaway: async (req) => { const out = await x.hostaway(req); if (/priceDetails/.test(req.url)) w.lockClient.errorFn(new Error("SYNTHETIC_PRIVATE_ERROR_CANARY")); return out; } }) });
  assert.deepEqual([r.outcome, r.code, r.createInvocations, r.lockSession, r.lock, w.lockReleased], ["LOCK_LOST", "STOP_LOCK_SESSION_ERROR", 0, "error_observed", "session_error_connection_destroyed", "destroyed"], JSON.stringify(r));
  assert.deepEqual(writes(w), [], "no create after the observed session error"); assert.equal(JSON.stringify(r).includes("CANARY"), false, "no raw error text");
});

test("R3 (F3) never success past the deadline or without a proven unlock: (a) monotonic 900001 during the final claims read → DEADLINE with the OBSERVED facts (reservation_confirmed, id, pristine capture) reported; (b) pg_advisory_unlock false → NOT_CONFIRMED / UNLOCK_NOT_PROVEN, lock unlock_failed_connection_destroyed, facts kept", async () => {
  { const w = world(); let reads = 0;
    const pool = fakePool(w); const q = pool.query.bind(pool);
    pool.query = async (sql, params) => { const res = await q(sql, params); if (/e7hrs:claims/.test(sql) && w.status === "reservation_confirmed") reads += 1; return res; };
    let m = 0; const monotonic = () => (reads > 0 ? 900001 : (m += 1, 0));
    const tooling = { runOrchestratorStep: fakeWorker(w), loadIntent: async () => intentOf(w), createPhaseExecutors: EA.createPhaseExecutors, createStripeSend: T.createE7StripeTestSend, createHostawaySend: T.createE7HostawaySend,
      validateAdapterConfig: HR.validateAdapterConfig, paymentIntentProofObservationV3: CP.paymentIntentProofObservationV3, stillAuthorizedV3Refusal: CP.stillAuthorizedV3Refusal, LOCK_KEY: LK.LOCK_KEY, LOCK_PRECHECK_SQL: LK.LOCK_PRECHECK_SQL };
    const r = await E.runReservationCore({ plan: plan(), pool, lockClientFactory: () => pool.lock(), tooling, exchanges: exchanges(w), credentials: { stripe: () => "sk_test_Fake1", hostaway: () => "x" }, sleep: async () => {}, monotonic,
      clock: () => Date.UTC(2026, 10, 12, 16, 0, 0) + (w.tick = (w.tick ?? 0) + 1000) });
    assert.deepEqual([r.outcome, r.factsObserved, r.finalState, r.reservationId, r.captureQueuedPristine, r.createInvocations], ["DEADLINE", true, "reservation_confirmed", RID, true, 1], JSON.stringify(r)); }
  { const w = world(); const r = await core(w, { unlockFalse: true });
    assert.deepEqual([r.outcome, r.code, r.lock, w.lockReleased, r.finalState, r.reservationId, r.captureQueuedPristine], ["NOT_CONFIRMED", "UNLOCK_NOT_PROVEN", "unlock_failed_connection_destroyed", "destroyed", "reservation_confirmed", RID, true], JSON.stringify(r)); }
  { const w = world(); const r = await core(w, { lockLostAt: 1, stayPending: true });                     // a stop after effects still reports observed facts
    assert.deepEqual([r.outcome, r.factsObserved, r.finalState, r.createOps], ["LOCK_LOST", true, "reservation_pending", ["succeeded"]], JSON.stringify(r)); }
});

test("R4 (F4) lock topology: sessionLockUrl derives ONLY the same scoped pooler target over session port 5432 (worker pool stays 6543); a backend hop between acquire and proof is refused (BACKEND_HOP) with ZERO worker steps; hosted execute wires TWO pools (6543 max 3 worker, 5432 max 1 lock)", async () => {
  const good = `postgresql://mv_booking_app_dev.${C.dbProjectRef}:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres`;
  assert.equal(E.sessionLockUrl(good), `postgresql://mv_booking_app_dev.${C.dbProjectRef}:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres`);
  for (const bad of [good.replace("6543", "5432"), good.replace("postgres", "other"), good.replace("pooler.supabase.com", "example.com"), good.replace("mv_booking_app_dev", "postgres"), `${good}?sslmode=require`]) assert.equal(E.sessionLockUrl(bad), null, bad);
  { const w = world(); const r = await core(w, { hopAtProof: 1 });
    assert.deepEqual([r.outcome, r.code, w.workerCalls, r.lockSession], ["LOCK_NOT_ACQUIRED", "BACKEND_HOP", 0, "backend_hop"], JSON.stringify(r)); assert.equal(w.calls.filter((x) => x.startsWith("H:")).length, 0); }
  { const w = world(); const r = await core(w, { hopAtProof: 2 });
    assert.deepEqual([r.outcome, r.code, w.workerCalls], ["LOCK_LOST", "BACKEND_HOP", 0], JSON.stringify(r)); }
  // hosted wiring (opened-constants seam; fake tooling import; no network): two pools, the lock pool on 5432 with max 1, both ended
  const opened = { ...C, executeEnabled: true };
  const pf = await E.runHosted({ mode: "preflight", env: realEnv(), proc: PROC, wrapperDir: ROOT, deps: { spawnChild: okChild } });
  const pools = []; let coreArgs = null;
  const fakeTooling = async () => ({ X: { createE7RealExchange: () => ({ ok: true, exchange: async () => ({}) }) },
    createBookingPool: (o) => { const u = new URL(o.connectionString); pools.push({ port: u.port, max: o.max, ended: false }); const me = pools.at(-1); return { connect: async () => ({ query: async () => ({ rows: [] }), release() {}, on() {} }), query: async () => ({ rows: [] }), end: async () => { me.ended = true; } }; },
    tooling: {} });
  const x = await E.runHosted({ mode: "execute", env: { ...realEnv(), E7_EXPECTED_PLAN_HASH: pf.result.planHash, E7_EXPECTED_CLOSURE_DIGEST: pf.result.closureDigest, E7_EXPECTED_RUNNER_DIGEST: pf.result.runnerDigest, GITHUB_REF: "refs/heads/main",
    E7_STRIPE_TEST_KEY: "sk_test_x", E7_HOSTAWAY_TOKEN: "t", E7_DEV_BOOKING_DATABASE_URL: good, E7_CA_FILE: "ca" }, proc: PROC, wrapperDir: ROOT,
    deps: { constants: opened, readPgVersion: async () => C.pgVersion, readCa: async () => Buffer.from("CA"), caSha256: (await import("node:crypto")).createHash("sha256").update("CA").digest("hex"), importTooling: fakeTooling,
      runCore: async (a) => { coreArgs = a; return { outcome: "SCOPE_REFUSED", code: "FAKE" }; } } });
  assert.deepEqual([x.result.code, x.result.lockEndpoint, pools.map((p) => [p.port, p.max, p.ended])], ["EXECUTE_DONE", "session:5432", [["6543", 3, true], ["5432", 1, true]]], JSON.stringify(x.result));
  assert.equal(typeof coreArgs.lockClientFactory, "function");
});

test("R5 (F5) success is PROVISIONAL until the teardown residual read agrees: a contradiction observed ONLY by the residual read (after a clean postcheck) → NOT_CONFIRMED / RESIDUAL_<code>, observed facts kept, no stale postcheck; an unavailable residual read → RESIDUAL_READ_UNAVAILABLE", async () => {
  const run = async (mutate) => {
    const w = world(); const pool = fakePool(w); const q = pool.query.bind(pool); let n = 0;
    pool.query = async (sql, params) => { if (/e7hrs:instance/.test(sql) && w.status === "reservation_confirmed" && ++n === 2) mutate(w); if (w.residualThrow) throw new Error("SYNTHETIC_RESIDUAL_READ_FAILURE"); return q(sql, params); };
    const tooling = { runOrchestratorStep: fakeWorker(w), loadIntent: async () => intentOf(w), createPhaseExecutors: EA.createPhaseExecutors, createStripeSend: T.createE7StripeTestSend, createHostawaySend: T.createE7HostawaySend,
      validateAdapterConfig: HR.validateAdapterConfig, paymentIntentProofObservationV3: CP.paymentIntentProofObservationV3, stillAuthorizedV3Refusal: CP.stillAuthorizedV3Refusal, LOCK_KEY: LK.LOCK_KEY, LOCK_PRECHECK_SQL: LK.LOCK_PRECHECK_SQL };
    const r = await E.runReservationCore({ plan: plan(), pool, lockClientFactory: () => pool.lock(), tooling, exchanges: exchanges(w), credentials: { stripe: () => "sk_test_Fake1", hostaway: () => "x" }, sleep: async () => {},
      clock: () => Date.UTC(2026, 10, 12, 16, 0, 0) + (w.tick = (w.tick ?? 0) + 1000) });
    assert.equal(n, 2, "the residual read happened"); return [r, w];
  };
  { const [r] = await run((w) => { const cap = w.ops.find((o) => o.op_type === "stripe.capture_payment_intent"); Object.assign(cap, { state: "dispatched", attempts: 1, dispatched: true }); });
    assert.deepEqual([r.outcome, r.code, r.postcheck, r.captureQueuedPristine, r.finalState, r.reservationId, r.lock], ["NOT_CONFIRMED", "RESIDUAL_CAPTURE_NOT_PRISTINE", null, false, "reservation_confirmed", RID, "released"], JSON.stringify(r)); }
  { const [r] = await run((w) => { w.claimReleased = true; });
    assert.deepEqual([r.outcome, r.code, r.postcheck, r.finalState], ["NOT_CONFIRMED", "RESIDUAL_CLAIM_NOT_HELD", null, "reservation_confirmed"], JSON.stringify(r)); }
  { const [r] = await run((w) => { w.status = "capture_failed"; });
    assert.deepEqual([r.outcome, r.code, r.postcheck, r.finalState, r.factsObserved], ["NOT_CONFIRMED", "RESIDUAL_STATE_NOT_CONFIRMED", null, "capture_failed", true], JSON.stringify(r)); }
  { const [r] = await run((w) => { w.residualThrow = true; });                                                                  // unavailable residual read
    assert.deepEqual([r.outcome, r.code, r.postcheck], ["NOT_CONFIRMED", "RESIDUAL_READ_UNAVAILABLE", null], JSON.stringify(r)); }
  { const w = world(); const r = await core(w); assert.deepEqual([r.outcome, r.postcheck?.claimHeld], ["RESERVATION_CONFIRMED_INTERMEDIATE", true]); } // agreement → success stands
});

// ---------------------------------------------------------------------------------------------------------------------------------
// OPT-IN INTEGRATION (E7_HRS_DB_TESTS=1; tooling with its pinned pg; PG_BIN): the REAL merged runOrchestratorStep (E7.2 + PR56 lease fix), repo,
// operations, transports and executor adapters on a disposable PostgreSQL (tooling test/db/harness.mjs). FAKE exchanges ONLY; fixtures through
// the accepted APIs (test/db/fixtures.mjs). The hosted preflight child never sets E7_HRS_DB_TESTS (no dependency, no database there).
if (process.env.E7_HRS_DB_TESTS === "1") {
  const [{ startMigratedDatabase }, F, R, O, W, pgMod, SP, DP, PA] = await Promise.all([tool("test/db/harness.mjs"), tool("test/db/fixtures.mjs"), tool("lib/booking-db/repo.js"),
    tool("lib/booking-db/operations.js"), tool("lib/booking-db/reservation-worker.js"), import(pathToFileURL(join(TOOLING, "node_modules/pg/lib/index.js")).href),
    tool("lib/checkout/server-pricer.js"), tool("lib/direct-policy.js"), tool("lib/public-api.js")]);
  const pg = pgMod.default ?? pgMod;
  const db = await startMigratedDatabase();
  after(async () => { await db.close(); });
  const LIST = 606998; const MINUTE = 60000;
  let stayK = 0;
  const realTooling = { runOrchestratorStep: W.runOrchestratorStep, loadIntent: R.loadIntent, createPhaseExecutors: EA.createPhaseExecutors, createStripeSend: T.createE7StripeTestSend,
    createHostawaySend: T.createE7HostawaySend, validateAdapterConfig: HR.validateAdapterConfig, paymentIntentProofObservationV3: CP.paymentIntentProofObservationV3,
    stillAuthorizedV3Refusal: CP.stillAuthorizedV3Refusal, LOCK_KEY: LK.LOCK_KEY, LOCK_PRECHECK_SQL: LK.LOCK_PRECHECK_SQL };
  // LABELLED COPY (adapted) of test/db/e7-run-r1-native-execute.test.mjs `authorizedBooking` + the pricing part of its `world`: a fresh
  // payment_authorized USD intent on 606998 priced by the ACCEPTED server pricer against the SAME fake pricing the worker re-checks
  // (1600.00 / night, 10 % direct discount), through the accepted repo functions. The worker's recheck must find the price unchanged.
  const NIGHTLY = 1600; const POLICY = DP.readDirectPolicyFromEnv({ VERCEL_ENV: "development", MV_E7_RESERVATION_WORKER: "enabled" }).policy;
  const dayRows = (from, to) => { const out = []; for (let d = from; d <= to; d = F.addDays(d, 1)) out.push({ date: d, status: "available", isAvailable: 1, minimumStay: 1, maximumStay: 90, closedOnArrival: 0, closedOnDeparture: 0 }); return out; };
  const pricing = {
    get: async (path, opts = {}) => { const m = /^\/listings\/(\d+)(\/calendar)?$/.exec(path); if (!m[2]) return { status: 200, json: { result: { id: Number(m[1]), currencyCode: "USD", personCapacity: 4, minNights: 1, maxNights: 90 } } };
      return { status: 200, json: { result: dayRows(opts.query.startDate, opts.query.endDate) } }; },
    post: async (path, body) => { const nights = Math.round((Date.parse(body.endingDate) - Date.parse(body.startingDate)) / 86400000);
      return { status: 200, json: { status: "success", result: { totalPrice: NIGHTLY * nights, components: [{ id: 1, type: "accommodation", name: "baseRate", title: "Base rate", quantity: 1, value: NIGHTLY, total: NIGHTLY * nights, isIncludedInTotalPrice: 1, isMandatory: 1, isOverriddenByUser: 0, isDeleted: 0, units: nights }] } } }; }
  };
  async function authorizedIntent() {
    stayK += 1;
    const stay = { listingId: LIST, from: F.addDays("2027-03-01", 5 * stayK), to: F.addDays("2027-03-01", 5 * stayK + 4), guests: 2 };
    const base = F.at(0);
    const priced = await SP.priceStay({ request: { ...stay }, listingConfig: { currency: "USD" }, client: pricing, policy: POLICY, today: PA.todayInTimeZone(undefined, new Date(base)), now: base });
    assert.ok(priced.ok, priced.error);
    const intent = await R.createIntentRecord(db.app, { ref: F.nextRef(), accessTokenHash: F.tokenHash(), environment: "test", now: base, ...stay });
    F.ok(await R.applyEvent(db.app, intent.id, { type: "PRICE_CONFIRMED", price: priced.price }, { now: base, actor: "guest" }));
    F.ok(await R.collectGuestDetails(db.app, intent.id, F.GUEST, { now: base + 1000, termsVersion: "terms-2026-10" }));
    const b = F.ok(await R.beginPayStep(db.app, intent.id, { now: base + 2000 }));
    const op = await O.claimNextOperation(db.app, { workerId: "w-pay", now: base + 2000, intentId: intent.id, opTypes: ["stripe.create_checkout_session"] });
    const sessionId = `cs_test_hrs${String(stayK).padStart(6, "0")}`;
    F.ok(await O.completeOperation(db.app, op.id, { workerId: "w-pay", now: base + 2000, outcome: { status: "succeeded", resultRef: sessionId } }));
    F.ok(await R.recordCheckoutSession(db.app, intent.id, b.attempt.id, { sessionId, expiresAt: base + 30 * MINUTE, now: base + 2000 }));
    const piId = `pi_HRS${String(stayK).padStart(10, "0")}`;
    const captureBefore = Math.floor((base + 7 * 86400000) / 1000) * 1000;
    F.ok(await R.applyEvent(db.app, intent.id, { type: "PAYMENT_AUTHORIZED", id: `evt_auth_${piId}`, paymentIntentId: piId, sessionId, amountMinor: priced.price.finalTotalMinor,
      currency: "usd", livemode: false, authorizationCreatedAt: base + 3000, captureBefore }, { now: base + 4000, actor: "webhook" }));
    const pa = (await db.app.query("SELECT id::text AS id FROM booking.payment_attempts WHERE intent_id = $1 AND status = 'completed'", [intent.id])).rows[0].id;
    const i = await R.loadIntent(db.app, intent.id);
    assert.equal(i.status, "payment_authorized");
    return { id: intent.id, piId, attemptId: pa, stay: { ...stay, currency: "USD" }, ref: i.ref, intent: i, total: i.price.finalTotalMinor };
  }
  /** reservation_pending with ONE succeeded create (result_ref known) and no confirmation yet — the proven handoff shape for `pending` admission */
  async function pendingProven() {
    const a = await authorizedIntent();
    F.ok(await R.applyEvent(db.app, a.id, { type: "RESERVATION_STARTED", workerId: "w1", recheck: { bookable: true, priceSame: true } }, { now: F.at(6), actor: "worker", workerId: "w1" }));
    F.ok(await R.applyEvent(db.app, a.id, { type: "RESERVATION_DISPATCHED", workerId: "w1" }, { now: F.at(6), actor: "worker", workerId: "w1" }));
    const rid = F.nextReservationId() + 72000000;
    const op = await F.claimOp(db.app, a.id, "hostaway.create_reservation", F.at(6));
    await R.recordHostawayCreateResult(db.app, a.id, { httpStatus: 201, reservation: { reservationId: rid, listingId: LIST, from: a.stay.from, to: a.stay.to, totalMinor: a.total, currency: "USD", bookingRef: null } }, { now: F.at(7) });
    F.ok(await O.completeOperation(db.app, op.id, { workerId: "w1", now: F.at(7), outcome: { status: "succeeded", resultRef: rid } }));
    const i = await R.loadIntent(db.app, a.id);
    return { ...a, rid: String(rid), intent: i };
  }
  function pgWorld(a, o = {}) {
    const w = { calls: [], res: new Map(), nextRes: 73000000 + stayK * 10, piStatus: o.piStatus ?? "requires_capture", echoRef: o.echoRef ?? true, createLost: o.createLost ?? false };
    const reply = (status, x) => Promise.resolve({ status, contentType: "application/json", bytes: enc(x) });
    const pi = () => ({ object: "payment_intent", id: a.piId, livemode: false, status: w.piStatus, capture_method: "manual", amount: a.total, amount_received: 0,
      amount_capturable: w.piStatus === "requires_capture" ? a.total : 0, currency: "usd", metadata: { mv_intent_id: a.id, mv_payment_attempt_id: a.attemptId },
      latest_charge: { object: "charge", id: `ch_HRS${a.id.slice(0, 8)}`, payment_intent: a.piId, status: "succeeded", paid: true, captured: false, amount: a.total, amount_captured: 0,
        amount_refunded: 0, currency: "usd", livemode: false, payment_method_details: { card: { capture_before: a.intent.payment.captureBefore / 1000 } } } });
    const full = (r, echo = w.echoRef) => ({ id: r.id, listingMapId: LIST, channelId: 2000, arrivalDate: a.stay.from, departureDate: a.stay.to, totalPrice: a.total / 100, currency: "USD", status: "new",
      customFieldValues: echo ? [{ customFieldId: C.refFieldId, value: a.ref }] : [] });
    if (a.rid) w.res.set(Number(a.rid), { id: Number(a.rid) });
    w.stripe = (req) => { w.calls.push(`S ${req.method} ${req.url.replace("https://api.stripe.com", "")}`); if (req.url.endsWith("/v1/account")) return reply(200, { object: "account", id: ACCT }); return reply(200, pi()); };
    w.hostaway = (req) => {
      const p = req.url.replace("https://api.hostaway.com", ""); w.calls.push(`H ${req.method} ${p}`);
      if (o.hostawayStatus) return reply(o.hostawayStatus, { status: "fail", message: "unauthorized" });
      const u = new URL(req.url);
      if (req.method === "GET" && /^\/v1\/listings\/\d+$/.test(p)) return pricing.get(p.slice(3)).then((x) => reply(x.status, x.json));
      if (req.method === "GET" && /^\/v1\/listings\/\d+\/calendar$/.test(u.pathname)) return pricing.get(u.pathname.slice(3), { query: Object.fromEntries(u.searchParams) }).then((x) => reply(x.status, x.json));
      if (req.method === "POST" && /priceDetails$/.test(p)) return pricing.post(p.slice(3), JSON.parse(req.body)).then((x) => reply(x.status, x.json));
      if (req.method === "GET" && p.startsWith("/v1/reservations?")) { const after = new URL(req.url).searchParams.has("afterId"); return reply(200, { status: "success", result: after ? [] : [...w.res.values()].map((r) => full(r, true)) }); }
      if (req.method === "POST" && p === "/v1/reservations") { const r = { id: w.nextRes++ }; w.res.set(r.id, r); if (w.createLost) return Promise.reject(new Error("socket reset")); return reply(201, { status: "success", result: full(r) }); }
      const m = /^\/v1\/reservations\/(\d+)$/.exec(p);
      if (req.method === "GET" && m) { const r = w.res.get(Number(m[1])); return r ? reply(200, { status: "success", result: full(r) }) : reply(404, { status: "fail" }); }
      return reply(404, { status: "fail" });
    };
    return w;
  }
  const pgRun = (a, w, extra = {}, over = {}) => {
    const clk = { t: F.at(0) + 10 * MINUTE };
    return E.runReservationCore({ plan: E.buildPlan(C, { approvalRef: "SYNTHETIC-hrs-pg", intentId: a.id, expectedVersion: a.intent.version, notBefore: new Date(F.at(0) - MINUTE).toISOString(),
      admission: a.rid ? "pending" : "authorized", reservationId: a.rid ?? "", runnerDigest: "0".repeat(64), ...over }).plan, pool: db.app, tooling: realTooling,
      exchanges: { stripe: w.stripe, hostaway: w.hostaway }, credentials: { stripe: () => "sk_test_Fake1", hostaway: () => "synthetic-hostaway-token" },
      clock: () => (clk.t += 1000), sleep: async (ms) => { clk.t += Math.max(ms, 30 * 1000); }, ...extra });
  };
  const snap = async (id) => ({ st: (await db.app.query("SELECT state, version, hostaway_reservation_id::text AS rid FROM booking.intents WHERE id = $1", [id])).rows[0],
    ops: (await db.app.query("SELECT op_type, state, attempts, (dispatched_at IS NOT NULL) AS d FROM booking.external_operations WHERE intent_id = $1 ORDER BY op_type, created_at", [id])).rows,
    claim: (await db.app.query("SELECT (released_at IS NOT NULL) AS released FROM booking.inventory_claims WHERE intent_id = $1", [id])).rows,
    locks: Number((await db.app.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'")).rows[0].n) });

  test("I1 PG integration (REAL worker + repo + transports + executors; FAKE exchanges): ref echoed and ref NOT echoed → EXACTLY 1 create, reservation_confirmed intermediate, capture queued pristine (never dispatched), claim held, no forbidden op, lock released", async () => {
    for (const echoRef of [true, false]) {
      const a = await authorizedIntent(); const w = pgWorld(a, { echoRef });
      const r = await pgRun(a, w);
      assert.equal(r.outcome, "RESERVATION_CONFIRMED_INTERMEDIATE", `${echoRef ? "echoed" : "not echoed"}: ${JSON.stringify(r)}`);
      assert.deepEqual([r.createInvocations, r.createOutcome, r.captureQueuedPristine, r.lock, r.admission], [1, "REPLIED", true, "released", "authorized"]);
      assert.deepEqual(w.calls.filter((x) => /^(S POST|H POST \/v1\/reservations$|H PUT)/.test(x)), ["H POST /v1/reservations"]);
      const s = await snap(a.id);
      assert.deepEqual([s.st.state, s.st.rid, s.claim[0].released, s.locks], ["reservation_confirmed", r.reservationId, false, 0]);
      assert.deepEqual(s.ops.filter((x) => x.op_type === "stripe.capture_payment_intent").map((x) => [x.state, x.attempts, x.d]), [["pending", 0, false]], "capture queued pristine, never dispatched");
      for (const t of ["guest.notify", "alert.owner", "stripe.void_payment_intent", "hostaway.cancel_reservation", "hostaway.record_offline_charge"]) assert.equal(s.ops.filter((x) => x.op_type === t).length, 0, t);
      console.log(`# I1 ${echoRef ? "echoed" : "not-echoed"}: steps=${r.steps} dbQueries=${r.dbQueries} exchanges=${r.exchanges} pricing=${r.pricingCalls} reads=${r.hostawayReads} lookups=${r.lookupPages}`);
      assert.ok(r.dbQueries > 0 && r.dbQueries <= C.budgets.dbQueries);
    }
  });

  test("I2 PG integration: auth-proof failure (PI canceled) → PROVIDER_PROOF_FAILED before any Hostaway call, DB unchanged; 401 on the first Hostaway read → no create, STOP honest; lost create reply → CREATE_OUTCOME_UNKNOWN with ONE POST and a second authorized admission REFUSED (no second send ever)", async () => {
    { const a = await authorizedIntent(); const before = await snap(a.id); const w = pgWorld(a, { piStatus: "canceled" }); const r = await pgRun(a, w);
      assert.deepEqual([r.outcome, r.code, w.calls.filter((x) => x.startsWith("H")).length], ["PROVIDER_PROOF_FAILED", "NOT_REQUIRES_CAPTURE", 0]); assert.deepEqual(await snap(a.id), before); }
    { const a = await authorizedIntent(); const w = pgWorld(a, { hostawayStatus: 401 }); const r = await pgRun(a, w);
      assert.notEqual(r.outcome, "RESERVATION_CONFIRMED_INTERMEDIATE"); assert.equal(r.createInvocations, 0, JSON.stringify(r)); assert.equal(w.calls.some((x) => /^H POST \/v1\/reservations$/.test(x)), false);
      assert.equal((await snap(a.id)).locks, 0); }
    { const a = await authorizedIntent(); const w = pgWorld(a, { createLost: true }); const r = await pgRun(a, w);
      assert.deepEqual([r.outcome, r.createInvocations, r.createOutcome], ["CREATE_OUTCOME_UNKNOWN", 1, "UNKNOWN"], JSON.stringify(r));
      assert.deepEqual(w.calls.filter((x) => /^H POST \/v1\/reservations$/.test(x)), ["H POST /v1/reservations"]);
      const s = await snap(a.id); assert.ok(["reservation_pending", "reservation_unknown"].includes(s.st.state), s.st.state);
      const a2 = { ...a, intent: await R.loadIntent(db.app, a.id) }; const w2 = pgWorld(a2); const r2 = await pgRun(a2, w2);
      // the accepted worker left the uncertain create as a durable case (reservation_unknown + open reconciliation case): both admissions refuse read-only
      assert.ok(["START_STATE_NOT_ELIGIBLE", "SCOPE_REFUSED"].includes(r2.outcome), `second admission: ${JSON.stringify(r2)}`); assert.deepEqual([r2.createInvocations, w2.calls.length, r2.steps], [0, 0, 0]);
      const w3 = pgWorld(a2); const r3 = await pgRun({ ...a2, rid: String(w.nextRes - 1) }, w3);
      assert.ok(["START_STATE_NOT_ELIGIBLE", "SCOPE_REFUSED"].includes(r3.outcome), `uncertain create is never adopted: ${JSON.stringify(r3)}`); assert.deepEqual([r3.createInvocations, w3.calls.length], [0, 0]); }
  });

  test("I3 PG integration: real lock conflict (another session holds LOCK_KEY) → LOCK_NOT_ACQUIRED, zero provider calls, zero DB writes; historic (not-before) and stale version refuse read-only; pending admission with a PROVEN succeeded create → confirmed with ZERO creates", async () => {
    { const a = await authorizedIntent(); const before = await snap(a.id);
      const holder = new pg.Client({ connectionString: db.reportUrl() }); await holder.connect();
      try { await holder.query("SELECT pg_advisory_lock(pg_catalog.hashtext($1), 0)", [LK.LOCK_KEY]);
        const w = pgWorld(a); const r = await pgRun(a, w);
        assert.deepEqual([r.outcome, r.code, w.calls.length, r.lock], ["LOCK_NOT_ACQUIRED", "RUN_LOCK_PRESENT", 0, "not_acquired"]);
        const after1 = await snap(a.id); assert.deepEqual({ ...after1, locks: 0 }, { ...before, locks: 0 });
      } finally { await holder.end(); } }
    { const a = await authorizedIntent(); const w = pgWorld(a); const r = await pgRun(a, w, {}, { notBefore: new Date(F.at(0) + MINUTE).toISOString() });
      assert.deepEqual([r.outcome, r.code, w.calls.length], ["START_STATE_NOT_ELIGIBLE", "HISTORIC_INTENT", 0]); }
    { const a = await authorizedIntent(); const w = pgWorld(a); const r = await pgRun({ ...a, intent: { ...a.intent, version: a.intent.version + 1 } }, w);
      assert.deepEqual([r.outcome, r.code, w.calls.length], ["START_STATE_NOT_ELIGIBLE", "VERSION_NOT_PINNED", 0]); }
    { const a = await pendingProven(); const w = pgWorld(a, { echoRef: false }); const r = await pgRun(a, w);
      assert.equal(r.outcome, "RESERVATION_CONFIRMED_INTERMEDIATE", JSON.stringify(r));
      assert.deepEqual([r.admission, r.createInvocations, r.reservationId, w.calls.filter((x) => /^H POST \/v1\/reservations$/.test(x)).length], ["pending", 0, a.rid, 0]);
      const s = await snap(a.id); assert.deepEqual([s.st.state, s.st.rid, s.locks], ["reservation_confirmed", a.rid, 0]); }
  });

  test("I4 PG integration: first signal during the worker stops new steps / transports and reports persisted effects; deadline → DEADLINE; both leave no advisory lock", async () => {
    { const a = await authorizedIntent(); const w = pgWorld(a); const ac = new AbortController(); const h = w.hostaway;
      w.hostaway = (req) => { if (/priceDetails/.test(req.url)) ac.abort(); return h(req); };
      const r = await pgRun(a, w, { runSignal: ac.signal });
      assert.deepEqual([r.outcome, r.createInvocations], ["ABORTED", 0], JSON.stringify(r)); assert.equal(w.calls.some((x) => /^H POST \/v1\/reservations$/.test(x)), false);
      const s = await snap(a.id); assert.equal(s.locks, 0); assert.ok(["payment_authorized", "reservation_pending"].includes(s.st.state)); }
    { const a = await authorizedIntent(); const w = pgWorld(a, { echoRef: false }); let m = 0;
      const r = await pgRun(a, w, { monotonic: () => { m += 1; return m > 40 ? 10 ** 9 : 0; } });
      assert.ok(["DEADLINE", "RESERVATION_CONFIRMED_INTERMEDIATE"].includes(r.outcome), JSON.stringify(r)); assert.equal((await snap(a.id)).locks, 0); }
  });
}
