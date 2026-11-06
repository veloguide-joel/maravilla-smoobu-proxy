// test/e7-checkout-test-cleanup.test.mjs — OFFLINE tests of scripts/e7-checkout-test-cleanup.mjs. Node built-ins (+ the tooling's own pg in the
// opt-in DB section). LABELS
//   * REAL: the runner; from the ACCEPTED checkout lineage at 6d703acd (E7_TOOLING_DIR, default ../../tooling = workflow layout): T, the
//     executor adapters, intent-state keys, validateAdapterConfig, C1, and — in the DB section only — the compensation worker, repo, intent API,
//     webhook and a disposable local PostgreSQL 17 (tooling test/db/harness.mjs). Real framed digests over the real checkouts.
//   * FAKE: every Stripe reply (an in-process fake `exchange` under the real T), the default section's DB (a tagged-query fake) and worker.
//     SYNTHETIC TEST keys (`sk_test_Fake1`, short on purpose). Nothing here is connectivity evidence; no real credential, provider or network.
//   * The DB section runs ONLY with E7_CLEANUP_DB_TESTS=1 (the hosted preflight child never sets it: no dependency, no database there).
//   * node:https request / Agent and fetch are guarded and must count ZERO at the end.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { readFileSync, mkdtempSync, cpSync, writeFileSync, rmSync, realpathSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, normalize } from "node:path";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

const GUARD = { request: 0, Agent: 0, fetch: 0 };
const realReq = https.request; const RealAgent = https.Agent; const realFetch = globalThis.fetch;
https.request = function g() { GUARD.request += 1; throw new Error("refused"); };
https.Agent = function g() { GUARD.Agent += 1; throw new Error("refused"); };
syncBuiltinESMExports();
globalThis.fetch = async () => { GUARD.fetch += 1; throw new Error("refused"); };
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOOLING = realpathSync(process.env.E7_TOOLING_DIR || join(ROOT, "..", "tooling"));
const tool = (p) => import(pathToFileURL(join(TOOLING, p)).href);
const E = await import("../scripts/e7-checkout-test-cleanup.mjs");
const T = await tool("scripts/e7-connected/http-transports.mjs");
const EA = await tool("scripts/e7-connected/executor-adapters.mjs");
const IS = await tool("lib/checkout/intent-state.js");
const HR = await tool("lib/hostaway-reservations.js");
const C1 = await tool("scripts/e7-connected/probe-env-preflight.mjs");
https.request = realReq; https.Agent = RealAgent; syncBuiltinESMExports();
const TMP = [];
after(() => { for (const d of TMP) rmSync(d, { recursive: true, force: true }); globalThis.fetch = realFetch; assert.deepEqual([GUARD.request, GUARD.Agent, GUARD.fetch], [0, 0, 0]); });

const C = E.CONSTANTS;
const KEY = "sk_test_Fake1"; const ACCT = C.accountId; const CANARY = "CANARYrawText";
const IID = "3f1d2c4b-5a69-4e7d-8f01-23456789abcd"; const PI = "pi_FakeReleased01"; const SESSION = "cs_test_FakeSession01"; const ATT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const built = E.buildPlan(C, { approvalRef: "synthetic-label-1", intentId: IID, paymentIntentId: PI, runnerDigest: "0".repeat(64) });
const enc = (o) => new TextEncoder().encode(typeof o === "string" ? o : JSON.stringify(o));
const VOID_KEY = IS.voidKey(IID, PI);
const FORBIDDEN = [KEY, "sk_test_", CANARY, "Bearer", "client_secret", "guest", "4242", "billing", "api.stripe.com", "postgres", "password"];

// ---- fake DB (tagged queries) + fake worker (drives the REAL executors / T / gate) -------------------------------------------------------
function fakeState(o = {}) {
  const s = {
    environment: "test",
    intent: { id: IID, ref: "MV-ABC123", listingId: 606998, from: "2027-09-05", to: "2027-09-08", guests: 2, status: "reservation_failed", version: 9,
      price: { currency: "USD", finalTotalMinor: 33750 }, checkout: { sessionId: SESSION, attempt: 1 },
      payment: { paymentIntentId: PI, amountMinor: 33750, currency: "USD", livemode: false, capturedMinor: 0 }, reservation: null, lease: null, dispatch: null,
      counters: { reservationAttempts: 0, voidAttempts: 0, reconcileAttempts: 0, offlineChargeAttempts: 0, checkoutAttempts: 1, captureAttempts: 0, cancelAttempts: 0 },
      reasonCode: "TEST_RELEASE_REQUESTED" },
    transitions: [
      { version_after: 7, from_state: "payment_pending", to_state: "payment_authorized", event_type: "PAYMENT_AUTHORIZED", event_id: "evt_Fake1", reason_code: null },
      { version_after: 8, from_state: "payment_authorized", to_state: "reservation_failed", event_type: "TEST_RELEASE_REQUESTED", event_id: IS.testReleaseEventId(IID, PI), reason_code: "TEST_RELEASE_REQUESTED" }],
    attempts: [{ status: "completed", checkout_session_id: SESSION, payment_intent_id: PI, livemode: false, amount_minor: "33750", currency: "USD" }],
    hostaway: 0, cases: 0, ledger: [{ entry: "authorization_accepted" }],
    ops: [{ op_type: "stripe.create_checkout_session", state: "succeeded", idempotency_key: "x1", attempts: 1, dispatched: true },
      { op_type: "stripe.retrieve_payment_intent", state: "succeeded", idempotency_key: "x2", attempts: 1, dispatched: true },
      { op_type: "stripe.void_payment_intent", state: "pending", idempotency_key: `void:${IID}:v8`, provider_key: VOID_KEY, payload_pi: PI, attempts: 0, dispatched: false }],
    claims: [{ listing_id: 606998, released: false }]
  };
  if (o.mutate) o.mutate(s);
  return s;
}
function fakePool(s, { failOn = null } = {}) {
  const queries = [];
  return { queries, query: async (sql, args) => {
    const tag = /\/\*e7c:([a-z]+)\*\//.exec(sql)?.[1]; queries.push(tag);
    assert.ok(/^\/\*e7c:[a-z]+\*\/ SELECT /.test(sql), "read-only SELECT only"); assert.ok(!/\b(INSERT|UPDATE|DELETE|FOR UPDATE)\b/.test(sql));
    if (failOn === tag) throw new Error(CANARY);
    if (tag !== "instance") assert.deepEqual(args, [IID]);
    const rows = { instance: [{ environment: s.environment }], transitions: s.transitions, attempts: s.attempts, hostaway: [{ n: s.hostaway }], ops: s.ops, cases: [{ n: s.cases }],
      claims: s.claims, ledger: s.ledger }[tag];
    return { rows: JSON.parse(JSON.stringify(rows)) };
  } };
}
const piObj = (st, over = {}) => ({ object: "payment_intent", id: PI, livemode: false, status: st, capture_method: "manual", amount: 33750, amount_received: 0,
  amount_capturable: st === "canceled" ? 0 : 33750, currency: "usd", client_secret: `${PI}_secret_${CANARY}`,
  latest_charge: { object: "charge", id: "ch_Fake1", livemode: false, payment_intent: PI, captured: false, amount: 33750, amount_captured: 0, amount_refunded: 0,
    billing_details: { email: "guest@example.invalid" } }, ...over });
function fakeStripe(script = {}) {
  const calls = []; let pi = piObj("requires_capture");
  const reply = (status, o) => Promise.resolve({ status, contentType: "application/json", bytes: enc(o) });
  const h = { account: () => reply(200, { object: "account", id: ACCT }), pi: () => reply(200, pi),
    cancel: () => { pi = piObj("canceled"); return reply(200, pi); }, ...script };
  const exchange = (req) => {
    const op = req.method === "GET" && req.url === "https://api.stripe.com/v1/account" ? "account"
      : req.method === "GET" && req.url === `https://api.stripe.com/v1/payment_intents/${PI}?expand%5B%5D=latest_charge` ? "pi"
      : req.method === "POST" && req.url === `https://api.stripe.com/v1/payment_intents/${PI}/cancel` ? "cancel" : "UNEXPECTED";
    calls.push({ op, version: req.headers["Stripe-Version"], idem: req.headers["Idempotency-Key"] ?? null, auth: req.headers.Authorization === `Bearer ${KEY}` });
    return op === "UNEXPECTED" ? Promise.reject(new Error("unexpected")) : h[op](req);
  };
  return { exchange, calls, setPi: (p) => { pi = p; } };
}
/** a fake worker step that drives the REAL executors exactly like the accepted worker's authorization leg (account, PI, void, confirm) */
function fakeWorker(s, script = {}) {
  let n = 0; const seen = [];
  const sig = () => AbortSignal.timeout(2000);
  const runCleanupStep = async (pool, o) => {
    n += 1; seen.push({ intentId: o.intentId, env: o.env, stripeAccountId: o.stripeAccountId, keys: Object.keys(o.executors).sort() });
    if (script.step) return script.step(n, o, s);
    await o.executors.retrieveAccount({ signal: sig() });
    await o.executors.retrievePaymentIntent(PI, { expand: ["latest_charge"] }, { signal: sig() });
    await o.executors.cancelPaymentIntent(PI, {}, { idempotencyKey: VOID_KEY, signal: sig() });
    await o.executors.retrievePaymentIntent(PI, { expand: ["latest_charge"] }, { signal: sig() });
    released(s);
    return { status: "worked", intentId: IID, actions: ["VOID_CLAIMED", "READ:stripe.retrieve_payment_intent", "VOID_SUCCEEDED->authorization_released"], sends: 1, delayMs: 0 };
  };
  return { runCleanupStep, count: () => n, seen };
}
function released(s) {
  s.intent.status = "authorization_released"; s.ops.find((o) => o.op_type === "stripe.void_payment_intent").state = "succeeded";
  s.claims[0].released = true; s.transitions.push({ version_after: 9, from_state: "reservation_failed", to_state: "authorization_released", event_type: "VOID_SUCCEEDED", event_id: "void-ok", reason_code: null });
}
const fakeTooling = (s, w) => ({ runCleanupStep: w.runCleanupStep, loadIntent: async (_p, id) => { if (id !== IID) throw new Error("nf"); return JSON.parse(JSON.stringify(s.intent)); },
  voidKey: IS.voidKey, testReleaseEventId: IS.testReleaseEventId, createPhaseExecutors: EA.createPhaseExecutors, createStripeSend: T.createE7StripeTestSend,
  validateAdapterConfig: HR.validateAdapterConfig });
async function run(o = {}) {
  const s = o.state ?? fakeState(o);
  const w = o.worker ?? fakeWorker(s, o.workerScript);
  const f = o.stripe ?? fakeStripe(o.stripeScript);
  const pool = o.pool ?? fakePool(s, o.poolOpts);
  let slept = 0;
  const res = await E.runCleanupCore({ plan: o.plan ?? built.plan, pool, tooling: o.tooling ?? fakeTooling(s, w), exchange: f.exchange, credential: o.credential ?? (() => KEY),
    clock: () => Date.UTC(2026, 10, 10), sleep: async (ms) => { slept += ms; }, runSignal: o.runSignal, monotonic: o.monotonic });
  const str = JSON.stringify(res);
  for (const bad of FORBIDDEN) assert.ok(!str.includes(bad), `no ${bad} in result`);
  assert.equal(res.exchanges, f.calls.filter((x) => x.op !== "UNEXPECTED").length + 0, "every exchange counted at the boundary");
  assert.ok(f.calls.filter((x) => x.op === "cancel").length <= 1, "never a second cancel on the wire");
  assert.ok(f.calls.every((x) => x.op !== "UNEXPECTED" && x.version === "2026-01-28.clover" && x.auth));
  assert.deepEqual(res.writes, { capture: 0, refund: 0, create: 0, hostaway: 0, notify: 0 });
  return { res, s, w, f, pool, slept, ops: f.calls.map((x) => x.op) };
}

test("F1. released TEST intent: account + PI read, ONE void (worker key), confirm read → RELEASED; claim released; Hostaway never; whitelisted output", async () => {
  const { res, ops, f, w } = await run();
  assert.deepEqual(ops, ["account", "pi", "cancel", "pi"]);
  assert.deepEqual(f.calls.find((x) => x.op === "cancel").idem, VOID_KEY);
  assert.deepEqual([res.outcome, res.code, res.startState, res.finalState, res.steps, res.cancelInvocations, res.cancelOutcome, res.accountReads, res.piReads, res.hostawayCalls,
    res.voidOpState, res.claimReleased, res.refusedAtTransport], ["RELEASED", "POSTCHECK", "reservation_failed", "authorization_released", 1, 1, "REPLIED", 1, 2, 0, "succeeded", true, 0]);
  assert.deepEqual(w.seen[0], { intentId: IID, env: { VERCEL_ENV: "development", MV_E7_COMPENSATION_WORKER: "enabled" }, stripeAccountId: ACCT,
    keys: ["cancelPaymentIntent", "cancelReservation", "lookupPage", "retrieveAccount", "retrievePaymentIntent", "retrieveReservation"] });
  assert.deepEqual(res.actions, ["VOID_CLAIMED", "READ:stripe.retrieve_payment_intent", "VOID_SUCCEEDED->authorization_released"]);
  assert.ok(Object.isFrozen(res));
});

test("F2. a terminal (already released) intent: ALREADY_RELEASED with ZERO worker steps and ZERO exchanges; a terminal mismatch is refused", async () => {
  const s = fakeState(); released(s);
  const a = await run({ state: s });
  assert.deepEqual([a.res.outcome, a.res.steps, a.res.exchanges, a.w.count()], ["ALREADY_RELEASED", 0, 0, 0]);
  const s2 = fakeState(); released(s2); s2.claims[0].released = false;
  const b = await run({ state: s2 });
  assert.deepEqual([b.res.outcome, b.res.code, b.res.exchanges, b.w.count()], ["START_STATE_NOT_ELIGIBLE", "TERMINAL_INCONSISTENT", 0, 0]);
});

test("F3. wrong scope / binding / lineage / marker: refused BEFORE any provider call (zero exchanges, zero worker steps)", async () => {
  const cases = [
    [(s) => { s.environment = "live"; }, "DB_NOT_TEST"],
    [(s) => { s.intent.listingId = 606999; }, "LISTING_SCOPE"], [(s) => { s.intent.price.currency = "MXN"; }, "LISTING_SCOPE"],
    [(s) => { s.intent.payment.paymentIntentId = "pi_OtherFake001"; }, "PAYMENT_INTENT_SCOPE"], [(s) => { s.intent.payment = null; }, "PAYMENT_INTENT_SCOPE"],
    [(s) => { s.intent.payment.livemode = true; }, "PAYMENT_NOT_CLEAN_TEST"], [(s) => { s.intent.payment.capturedMinor = 1; }, "PAYMENT_NOT_CLEAN_TEST"],
    [(s) => { s.intent.reservation = { reservationId: "70636076" }; }, "HOSTAWAY_RESERVATION_OR_DISPATCH"], [(s) => { s.intent.dispatch = { at: 1, attempt: 1 }; }, "HOSTAWAY_RESERVATION_OR_DISPATCH"],
    [(s) => { s.intent.counters.captureAttempts = 1; }, "COUNTERS_NOT_RELEASE"], [(s) => { s.intent.counters.reservationAttempts = 1; }, "COUNTERS_NOT_RELEASE"],
    [(s) => { s.intent.checkout = null; }, "SESSION_UNBOUND"],
    [(s) => { s.transitions.pop(); s.transitions.push({ version_after: 8, from_state: "payment_authorized", to_state: "reservation_failed", event_type: "RESERVATION_FAILED", event_id: "x", reason_code: "HOSTAWAY_REFUSED" }); }, "LINEAGE_NOT_RELEASE"],
    [(s) => { s.transitions[1].event_id = "test-release:other"; }, "LINEAGE_NOT_RELEASE"], [(s) => { s.transitions[1].reason_code = "OTHER"; }, "LINEAGE_NOT_RELEASE"],
    [(s) => { s.transitions.push({ version_after: 9, from_state: "reservation_failed", to_state: "reservation_failed", event_type: "CAPTURE_FAILED", event_id: "y", reason_code: null }); }, "LINEAGE_NOT_RELEASE"],
    [(s) => { s.transitions.unshift({ version_after: 5, from_state: "x", to_state: "payment_authorized", event_type: "PAYMENT_AUTHORIZED", event_id: "z", reason_code: null }); }, "LINEAGE_NOT_RELEASE"],
    [(s) => { s.intent.status = "capture_failed"; }, "LINEAGE_NOT_RELEASE"], [(s) => { s.intent.status = "reconciliation_required"; }, "LINEAGE_NOT_RELEASE"],
    [(s) => { s.attempts[0].payment_intent_id = "pi_OtherFake001"; }, "ATTEMPT_NOT_BOUND"], [(s) => { s.attempts[0].checkout_session_id = "cs_test_Other1"; }, "ATTEMPT_NOT_BOUND"],
    [(s) => { s.attempts[0].livemode = true; }, "ATTEMPT_NOT_BOUND"], [(s) => { s.attempts[0].amount_minor = "33751"; }, "ATTEMPT_NOT_BOUND"],
    [(s) => { s.attempts.push({ status: "expired", payment_intent_id: "pi_OtherFake001" }); }, "ATTEMPT_NOT_BOUND"],
    [(s) => { s.hostaway = 1; }, "HOSTAWAY_ATTEMPT_PRESENT"], [(s) => { s.cases = 1; }, "RECONCILIATION_PRESENT"],
    [(s) => { s.ledger.push({ entry: "capture_succeeded" }); }, "LEDGER_NOT_RELEASE"],
    [(s) => { s.ops.push({ op_type: "hostaway.create_reservation", state: "pending", idempotency_key: "h", attempts: 0, dispatched: false }); }, "OPERATION_NOT_RELEASE"],
    [(s) => { s.ops.push({ op_type: "alert.owner", state: "pending", idempotency_key: "a", attempts: 0, dispatched: false }); }, "OPERATION_NOT_RELEASE"],
    [(s) => { s.ops.push({ op_type: "stripe.capture_payment_intent", state: "pending", idempotency_key: "c", attempts: 0, dispatched: false }); }, "OPERATION_NOT_RELEASE"],
    [(s) => { s.ops[2].idempotency_key = "void:other"; }, "VOID_ROW_UNEXPECTED"], [(s) => { s.ops[2].provider_key = "void:other"; }, "VOID_ROW_UNEXPECTED"],
    [(s) => { s.ops[2].payload_pi = "pi_OtherFake001"; }, "VOID_ROW_UNEXPECTED"], [(s) => { s.ops[2].idempotency_key = `void:${IID}:v9`; }, "VOID_ROW_UNEXPECTED"],
    [(s) => { s.claims[0].listing_id = 606999; }, "CLAIM_UNEXPECTED"], [(s) => { s.claims = []; }, "CLAIM_UNEXPECTED"]
  ];
  for (const [mutate, code] of cases) {
    const { res, w } = await run({ mutate });
    assert.deepEqual([res.outcome, res.code, res.exchanges, w.count()], ["SCOPE_REFUSED", code, 0, 0], code);
  }
  // an intent that is not found under the plan's id (e.g. a foreign id) and a DB read error
  const s = fakeState(); const nf = await run({ state: s, tooling: { ...fakeTooling(s, fakeWorker(s)), loadIntent: async () => null } });
  assert.deepEqual([nf.res.outcome, nf.res.code, nf.res.exchanges], ["SCOPE_REFUSED", "INTENT_NOT_FOUND", 0], "acknowledged absence (null) only");
  const er = await run({ poolOpts: { failOn: "ops" } });
  assert.deepEqual([er.res.outcome, er.res.code, er.res.exchanges], ["DB_ERROR", "PRECHECK_QUERY_FAILED", 0]);
  // a void row that already left (dispatched / unknown / attempted) is NEVER re-sent by this runner
  for (const m of [(st) => { st.ops[2].state = "outcome_unknown"; st.ops[2].dispatched = true; st.ops[2].attempts = 1; }, (st) => { st.ops[2].attempts = 1; }, (st) => { st.ops[2].state = "in_flight"; }]) {
    const x = await run({ mutate: m });
    assert.deepEqual([x.res.outcome, x.res.code, x.res.exchanges, x.w.count()], ["START_STATE_NOT_ELIGIBLE", "START_STATE_NOT_ELIGIBLE", 0, 0]);
  }
  // the synthetic preflight id never qualifies the core
  const syn = E.buildPlan(C, { approvalRef: "x-label", intentId: C.synthetic.intentId, paymentIntentId: PI, runnerDigest: "0".repeat(64) });
  assert.equal((await run({ plan: syn.plan })).res.outcome, "CORE_INVALID");
});

test("F4. cancel uncertainty: network error / 5xx / timeout / applied-then-error / reload failure → CANCEL_OUTCOME_UNKNOWN, ONE cancel on the wire, STOP (no second step)", async () => {
  const hang = (req) => new Promise((_, rej) => { req.signal.addEventListener("abort", () => rej(new Error("aborted")), { once: true }); });
  for (const cancel of [() => Promise.reject(new Error(CANARY)), () => Promise.resolve({ status: 500, contentType: "application/json", bytes: enc({ error: CANARY }) }), hang]) {
    const s = fakeState();
    const w = fakeWorker(s, { step: async (n, o) => {
      await o.executors.retrieveAccount({ signal: AbortSignal.timeout(2000) });
      await o.executors.retrievePaymentIntent(PI, { expand: ["latest_charge"] }, { signal: AbortSignal.timeout(2000) });
      const c2 = new AbortController(); setTimeout(() => c2.abort(), 30);
      try { await o.executors.cancelPaymentIntent(PI, {}, { idempotencyKey: VOID_KEY, signal: c2.signal }); } catch { s.ops[2].state = "outcome_unknown"; s.ops[2].dispatched = true; }
      return { status: "worked", intentId: IID, actions: ["VOID_CLAIMED", "VOID:UNKNOWN"], sends: 1, delayMs: 30000 };
    } });
    const { res, ops } = await run({ state: s, worker: w, stripeScript: { cancel } });
    assert.deepEqual([res.outcome, res.cancelInvocations, res.cancelOutcome, res.steps, ops.filter((x) => x === "cancel").length, w.count()], ["CANCEL_OUTCOME_UNKNOWN", 1, "UNKNOWN", 1, 1, 1]);
  }
  // the worker throws AFTER the void was applied at Stripe (e.g. the DB COMMIT failed): never success, never a second void
  const s = fakeState();
  const w = fakeWorker(s, { step: async (n, o) => { await o.executors.retrieveAccount({ signal: AbortSignal.timeout(2000) }); await o.executors.cancelPaymentIntent(PI, {}, { idempotencyKey: VOID_KEY, signal: AbortSignal.timeout(2000) }); throw new Error(CANARY); } });
  const a = await run({ state: s, worker: w });
  assert.deepEqual([a.res.outcome, a.res.code, a.res.cancelInvocations, a.res.cancelOutcome, w.count()], ["CANCEL_OUTCOME_UNKNOWN", "WORKER_THREW", 1, "REPLIED", 1]);
  const s2 = fakeState(); let loads = 0;
  const w2 = fakeWorker(s2);
  const t2 = { ...fakeTooling(s2, w2), loadIntent: async () => { loads += 1; if (loads > 1) throw new Error(CANARY); return JSON.parse(JSON.stringify(s2.intent)); } };
  const b = await run({ state: s2, worker: w2, tooling: t2 });
  assert.deepEqual([b.res.outcome, b.res.code, b.res.cancelInvocations], ["CANCEL_OUTCOME_UNKNOWN", "RELOAD_FAILED", 1]);
});

test("F5. a worker that tries a SECOND cancel (same run) is refused at the boundary (never reaches the wire); a cancel aborted before sending is CANCEL_NOT_SENT", async () => {
  const s = fakeState();
  const w = fakeWorker(s, { step: async (n, o) => {
    if (n === 1) { await o.executors.cancelPaymentIntent(PI, {}, { idempotencyKey: VOID_KEY, signal: AbortSignal.timeout(2000) }); return { status: "worked", actions: ["WAIT:FRESHNESS"], delayMs: 1000 }; }
    try { await o.executors.cancelPaymentIntent(PI, {}, { idempotencyKey: VOID_KEY, signal: AbortSignal.timeout(2000) }); } catch { /* refused */ }
    return { status: "worked", actions: ["VOID:RETRY"], delayMs: 0 };
  } });
  const { res, ops } = await run({ state: s, worker: w });
  assert.deepEqual([res.outcome, res.cancelInvocations, ops.filter((x) => x === "cancel").length, res.refusedAtTransport, w.count()], ["SECOND_CANCEL_REFUSED", 1, 1, 1, 2]);
  const s2 = fakeState();
  const w2 = fakeWorker(s2, { step: async (n, o) => { try { await o.executors.cancelPaymentIntent(PI, {}, { idempotencyKey: VOID_KEY, signal: AbortSignal.abort() }); } catch { /* aborted pre-send */ }
    return { status: "worked", actions: ["SEND_ABORTED_X"], delayMs: 0 }; } });
  const b = await run({ state: s2, worker: w2 });
  // the accepted adapter refuses an already-aborted signal before the transport: nothing reaches the boundary; the worker's SEND_ABORTED stops the run
  assert.deepEqual([b.res.outcome, b.res.cancelOutcome, b.res.cancelInvocations, b.ops.length], ["ESCALATED", "NONE", 0, 0]);
  // a cancel that passes the adapter but is refused by T before any exchange (here: T refuses a non-TEST key) is CANCEL_NOT_SENT, then STOP
  const s3 = fakeState();
  const w3 = fakeWorker(s3, { step: async (n, o) => { try { await o.executors.cancelPaymentIntent(PI, {}, { idempotencyKey: VOID_KEY, signal: AbortSignal.timeout(2000) }); } catch { /* refused pre-send */ }
    return { status: "worked", actions: ["VOID:NOT_SENT"], delayMs: 0 }; } });
  const c = await run({ state: s3, worker: w3, credential: () => "sk_live_Fake1" });
  assert.deepEqual([c.res.outcome, c.res.cancelOutcome, c.res.cancelInvocations, c.ops.length, w3.count()], ["CANCEL_NOT_SENT", "NOT_SENT", 1, 0, 1]);
});

test("F6. strict canceled proof refusal (worker escalates) → ESCALATED, claim held; worker refusal → WORKER_REFUSED; state moved → NOT_RELEASED", async () => {
  const s = fakeState();
  const w = fakeWorker(s, { step: async (n, o) => { await o.executors.cancelPaymentIntent(PI, {}, { idempotencyKey: VOID_KEY, signal: AbortSignal.timeout(2000) });
    s.intent.status = "reconciliation_required"; return { status: "worked", actions: ["ESCALATE:VOID_PROOF_NOT_STRICT"], delayMs: 0 }; } });
  const a = await run({ state: s, worker: w });
  assert.deepEqual([a.res.outcome, a.res.finalState, a.res.claimReleased, a.res.cancelInvocations], ["ESCALATED", "reconciliation_required", null, 1]);
  assert.equal(s.claims[0].released, false);
  const s2 = fakeState();
  const b = await run({ state: s2, worker: fakeWorker(s2, { step: async () => ({ status: "refused", code: "DATABASE_NOT_TEST", actions: [] }) }) });
  assert.deepEqual([b.res.outcome, b.res.code, b.res.exchanges], ["WORKER_REFUSED", "DATABASE_NOT_TEST", 0]);
  const s3 = fakeState();
  const c = await run({ state: s3, worker: fakeWorker(s3, { step: async () => { s3.intent.status = "capture_failed"; return { status: "worked", actions: ["X"], delayMs: 0 }; } }) });
  assert.deepEqual([c.res.outcome, c.res.code], ["NOT_RELEASED", "STATE_MOVED"]);
});

test("F7. budgets / deadline / abort: <= 8 steps, <= 8 PI reads, <= 4 account reads (extra refused at the boundary), run deadline, operator abort", async () => {
  const s = fakeState();
  const w = fakeWorker(s, { step: async (n, o) => {
    for (let i = 0; i < 3; i++) { try { await o.executors.retrievePaymentIntent(PI, { expand: ["latest_charge"] }, { signal: AbortSignal.timeout(2000) }); } catch { /* refused */ } }
    try { await o.executors.retrieveAccount({ signal: AbortSignal.timeout(2000) }); } catch { /* refused */ }
    return { status: "worked", actions: ["WAIT:NOTHING_DUE"], delayMs: 30000 };
  } });
  const { res, slept } = await run({ state: s, worker: w });
  assert.deepEqual([res.outcome, res.code, res.steps, res.piReads, res.accountReads, res.exchanges, w.count()], ["BUDGET_EXHAUSTED", "STEPS", 8, 8, 4, 12, 8]);
  assert.equal(res.refusedAtTransport, 8 * 4 - 12);
  assert.equal(slept, 7 * 30000, "waits are bounded by the worker delay (cap 35 s); never after the last step");
  let t = 0; const s2 = fakeState();
  const d = await run({ state: s2, monotonic: () => t, worker: fakeWorker(s2, { step: async () => { t += C.budgets.runMs; return { status: "worked", actions: ["WAIT:X"], delayMs: 1000 }; } }) });
  assert.deepEqual([d.res.outcome, d.res.steps], ["DEADLINE", 1]);
  const ac = new AbortController(); ac.abort();
  const e = await run({ runSignal: ac.signal });
  assert.deepEqual([e.res.outcome, e.res.exchanges, e.w.count()], ["ABORTED", 0, 0]);
});

test("F8. Hostaway executors fail BEFORE any transport (adapter refusal or the refusing send); reaching the send stops the run (SCOPE_REFUSED)", async () => {
  const s = fakeState();
  const w = fakeWorker(s, { step: async (n, o) => {
    for (const k of ["lookupPage", "retrieveReservation", "cancelReservation"]) { try { await o.executors[k]({ method: "GET", path: "/v1/reservations", query: {} }, { signal: AbortSignal.timeout(1000) }); } catch { /* */ } }
    return { status: "refused", code: "STOP_HERE", actions: [] }; } });
  const a = await run({ state: s, worker: w });
  assert.deepEqual([a.res.hostawayCalls, a.ops.length, a.res.outcome], [0, 0, "WORKER_REFUSED"], "the accepted adapter refuses an unbound / malformed Hostaway request before its send");
  // even if an executor DID reach the injected Hostaway send, it throws before any transport and the run stops
  const s2 = fakeState(); const w2 = fakeWorker(s2, { step: async (n, o) => { try { await o.executors.lookupPage(); } catch { /* */ } return { status: "worked", actions: ["X"], delayMs: 0 }; } });
  const t2 = { ...fakeTooling(s2, w2), createPhaseExecutors: (opts) => { const real = EA.createPhaseExecutors(opts);
    return { ok: true, executors: { ...real.executors, lookupPage: async () => opts.hostaway.send({ method: "GET", path: "/v1/reservations" }, {}) } }; } };
  const b = await run({ state: s2, worker: w2, tooling: t2 });
  assert.deepEqual([b.res.outcome, b.res.code, b.res.hostawayCalls, b.ops.length], ["SCOPE_REFUSED", "HOSTAWAY_EXECUTOR_REACHED", 1, 0]);
});

test("F9. plan: fixed ceiling; hash stable and sensitive to label / intent / PaymentIntent / runner; malformed inputs refused", () => {
  const p = E.buildPlan(C, { approvalRef: "synthetic-label-1", intentId: IID, paymentIntentId: PI, runnerDigest: "0".repeat(64) });
  assert.equal(p.planHash, built.planHash);
  for (const o of [{ approvalRef: "l2" }, { intentId: "3f1d2c4b-5a69-4e7d-8f01-23456789abce" }, { paymentIntentId: "pi_FakeReleased02" }, { runnerDigest: "1".repeat(64) }]) {
    assert.notEqual(E.buildPlan(C, { approvalRef: "synthetic-label-1", intentId: IID, paymentIntentId: PI, runnerDigest: "0".repeat(64), ...o }).planHash, p.planHash);
  }
  assert.deepEqual([p.plan.budgets.cancel, p.plan.budgets.steps, p.plan.writes.stripeCancelMax, p.plan.listingId, p.plan.accountId, p.plan.stripeVersion, p.plan.dbEnvironment],
    [1, 8, 1, 606998, ACCT, "2026-01-28.clover", "test"]);
  for (const bad of [{ intentId: "not-a-uuid" }, { intentId: IID.toUpperCase() }, { paymentIntentId: "ch_x" }, { approvalRef: "has space" }]) {
    assert.throws(() => E.buildPlan(C, { approvalRef: "x-label", intentId: IID, paymentIntentId: PI, runnerDigest: "0".repeat(64), ...bad }), { code: "CLN_INPUT_INVALID" });
  }
  for (const over of [{ listingId: 603566 }, { accountId: "acct_OtherFake1" }, { stripeVersion: "2026-08-26.dahlia" }, { budgets: { ...C.budgets, cancel: 2 } }, { dbEnvironment: "live" }]) {
    assert.throws(() => E.buildPlan({ ...C, ...over }, { approvalRef: "x-label", intentId: IID, paymentIntentId: PI, runnerDigest: "0".repeat(64) }), { code: "CLN_INPUT_INVALID" });
  }
});

// ---- R-C1: the stop latch (operator abort / admission deadline) at every executor / send / exchange boundary ---------------------------
const ok200 = (o) => Promise.resolve({ status: 200, contentType: "application/json", bytes: enc(o) });
const ACCOUNT_OK = { object: "account", id: ACCT };
const piReq = piObj("requires_capture");
/** a step like the accepted worker's: it catches executor failures itself and returns a WAIT (so the runner, not the worker, must stop) */
const catchingWorker = (s, calls) => fakeWorker(s, { step: async (n, o) => {
  const sg = () => ({ signal: AbortSignal.timeout(2000) });
  try { await o.executors.retrieveAccount(sg()); calls.push("account"); await o.executors.retrievePaymentIntent(PI, { expand: ["latest_charge"] }, sg()); calls.push("pi");
    await o.executors.cancelPaymentIntent(PI, {}, { idempotencyKey: VOID_KEY, ...sg() }); calls.push("cancel");
    await o.executors.retrievePaymentIntent(PI, { expand: ["latest_charge"] }, sg()); calls.push("pi2"); released(s);
    return { status: "worked", actions: ["VOID_SUCCEEDED->authorization_released"], delayMs: 0 };
  } catch { calls.push("refused"); return { status: "worked", actions: ["WAIT:EXECUTOR_FAILED"], delayMs: 30000 }; } } });

test("R1. stop BEFORE the first provider call: an abort observed during the precheck stops the next query; zero exchanges", async () => {
  const ac = new AbortController(); const s = fakeState(); const pool = fakePool(s);
  const q0 = pool.query; let n = 0; pool.query = async (...a) => { n += 1; if (n === 2) ac.abort(); return q0(...a); };
  const { res, ops, w } = await run({ state: s, pool, runSignal: ac.signal });
  assert.deepEqual([res.outcome, res.code, res.stopReason, ops.length, w.count(), n], ["ABORTED", "STOP_ABORTED", "ABORTED", 0, 0, 2], "no query after the stop is observed");
});

test("R2. abort / deadline observed in the ACCOUNT reply: no PI read, no cancel; the run stops (no reload, no sleep, no second step)", async () => {
  for (const kind of ["abort", "deadline"]) {
    const ac = new AbortController(); let t = 0; const s = fakeState(); const calls = [];
    const w = catchingWorker(s, calls); const pool = fakePool(s);
    const out = await run({ state: s, worker: w, pool, runSignal: ac.signal, monotonic: () => t,
      stripeScript: { account: () => { if (kind === "abort") ac.abort(); else t = C.budgets.runMs + 1; return ok200(ACCOUNT_OK); } } });
    const want = kind === "abort" ? "ABORTED" : "DEADLINE";
    assert.deepEqual([out.res.outcome, out.res.stopReason, out.ops, out.res.cancelInvocations, out.res.cancelOutcome, w.count(), out.slept], [want, want, ["account"], 0, "NONE", 1, 0], kind);
    // abort: the run signal is composed into the in-flight account call, so T discards that reply too (the step's FIRST call fails);
    // deadline (injected monotonic, not wall time): the account reply is accepted, the NEXT executor call is refused by the latch
    assert.deepEqual(calls, kind === "abort" ? ["refused"] : ["account", "refused"]);
    assert.deepEqual([pool.queries.filter((x) => x === "ops").length, pool.queries.filter((x) => x === "claims").length], [1, 1], "only the precheck's own reads; no post-step query");
  }
});

test("R3. abort / deadline observed in the PI reply (after PI, before cancel): ZERO cancel invocations, never on the wire", async () => {
  for (const kind of ["abort", "deadline"]) {
    const ac = new AbortController(); let t = 0; const s = fakeState(); const calls = [];
    const out = await run({ state: s, worker: catchingWorker(s, calls), runSignal: ac.signal, monotonic: () => t,
      stripeScript: { pi: () => { if (kind === "abort") ac.abort(); else t = C.budgets.runMs + 1; return ok200(piReq); } } });
    assert.deepEqual([out.res.outcome, out.ops, out.res.cancelInvocations, out.res.cancelOutcome, out.slept], [kind === "abort" ? "ABORTED" : "DEADLINE", ["account", "pi"], 0, "NONE", 0], kind);
  }
});

test("R4. abort while the cancel request is being validated (after the accepted adapter passed it, before the runner's send): refused before the exchange, not uncertainty", async () => {
  const ac = new AbortController(); const s = fakeState();
  const w = fakeWorker(s, { step: async (n, o) => {
    await o.executors.retrieveAccount({ signal: AbortSignal.timeout(2000) });
    await o.executors.retrievePaymentIntent(PI, { expand: ["latest_charge"] }, { signal: AbortSignal.timeout(2000) });
    try { await o.executors.cancelPaymentIntent(PI, {}, { idempotencyKey: VOID_KEY, signal: AbortSignal.timeout(2000) }); } catch { /* refused */ }
    return { status: "worked", actions: ["WAIT:X"], delayMs: 30000 }; } });
  // the abort lands exactly between the adapter's request validation and the runner's stripe send
  const tl = { ...fakeTooling(s, w), createPhaseExecutors: (opts) => EA.createPhaseExecutors({ ...opts,
    stripe: { send: (call, x) => { if (call.op === "paymentIntents.cancel") ac.abort(); return opts.stripe.send(call, x); } } }) };
  const out = await run({ state: s, worker: w, tooling: tl, runSignal: ac.signal });
  assert.deepEqual([out.res.outcome, out.ops, out.res.cancelOutcome, out.slept, w.count()], ["ABORTED", ["account", "pi"], "NONE", 0, 1]);
  assert.ok(out.res.cancelInvocations === 0, "a refusal before the cancel exchange is not a cancellation attempt");
});

test("R5. abort with the cancel ALREADY exchanged: the outcome is UNKNOWN (never resent, no confirm read, never success), whether the abort lands with the reply or while it hangs", async () => {
  const ac = new AbortController(); const s = fakeState(); const calls = [];
  const a = await run({ state: s, worker: catchingWorker(s, calls), runSignal: ac.signal,
    stripeScript: { cancel: () => { ac.abort(); return ok200(piObj("canceled")); } } });
  // the abort is composed into the in-flight cancel, so T does not accept the racing reply: the outcome stays UNKNOWN (truthful, never re-sent)
  assert.deepEqual([a.res.outcome, a.res.code, a.ops, a.res.cancelInvocations, a.res.cancelOutcome, a.slept], ["CANCEL_OUTCOME_UNKNOWN", "STOP_ABORTED", ["account", "pi", "cancel"], 1, "UNKNOWN", 0]);
  assert.notEqual(a.res.outcome, "RELEASED", "a stop never becomes success");
  const ac2 = new AbortController(); const s2 = fakeState();
  const hang = (req) => { setTimeout(() => ac2.abort(), 5); return new Promise((_, rej) => req.signal.addEventListener("abort", () => rej(new Error("aborted")), { once: true })); };
  const w2 = fakeWorker(s2, { step: async (n, o) => {
    await o.executors.retrieveAccount({ signal: AbortSignal.timeout(2000) });
    try { await o.executors.cancelPaymentIntent(PI, {}, { idempotencyKey: VOID_KEY, signal: AbortSignal.timeout(60000) }); } catch { /* aborted in flight */ }
    return { status: "worked", actions: ["VOID:UNKNOWN"], delayMs: 0 }; } });
  const t0 = Date.now();
  const b = await run({ state: s2, worker: w2, runSignal: ac2.signal, stripeScript: { cancel: hang } });
  assert.ok(Date.now() - t0 < 5000, "the composed run signal reaches the in-flight request (the worker's own 60 s signal is still honoured too)");
  assert.deepEqual([b.res.outcome, b.res.cancelInvocations, b.res.cancelOutcome, b.ops.filter((x) => x === "cancel").length], ["CANCEL_OUTCOME_UNKNOWN", 1, "UNKNOWN", 1]);
});

test("R6. an injected worker that returns success AFTER a stop is NOT reported as RELEASED; no reload / post-check query", async () => {
  const ac = new AbortController(); const s = fakeState(); const pool = fakePool(s);
  const w = fakeWorker(s, { step: async (n, o) => { await o.executors.retrieveAccount({ signal: AbortSignal.timeout(2000) }); ac.abort(); released(s);
    return { status: "worked", actions: ["VOID_SUCCEEDED->authorization_released"], delayMs: 0 }; } });
  const loads = []; const tl = { ...fakeTooling(s, w), loadIntent: async (...a) => { loads.push(1); return fakeTooling(s, w).loadIntent(...a); } };
  const out = await run({ state: s, worker: w, pool, tooling: tl, runSignal: ac.signal });
  assert.deepEqual([out.res.outcome, out.res.finalState, loads.length], ["ABORTED", null, 1], "only the precheck load; no post-step reload");
});

test("R7. DB failure vs absence: a THROWING loadIntent is DB_ERROR (code only, no later query / provider call); null stays INTENT_NOT_FOUND", async () => {
  const s = fakeState(); const pool = fakePool(s);
  const t1 = { ...fakeTooling(s, fakeWorker(s)), loadIntent: async () => { throw new Error(`${CANARY} connection reset`); } };
  const a = await run({ state: s, pool, tooling: t1 });
  assert.deepEqual([a.res.outcome, a.res.code, a.res.exchanges, pool.queries], ["DB_ERROR", "PRECHECK_QUERY_FAILED", 0, ["instance"]]);
  const s2 = fakeState(); const pool2 = fakePool(s2);
  const b = await run({ state: s2, pool: pool2, tooling: { ...fakeTooling(s2, fakeWorker(s2)), loadIntent: async () => null } });
  assert.deepEqual([b.res.outcome, b.res.code, b.res.exchanges, pool2.queries], ["SCOPE_REFUSED", "INTENT_NOT_FOUND", 0, ["instance"]]);
});

// ---- hosted wiring --------------------------------------------------------------------------------------------------------------------
const PROC = { versions: { node: "22.22.0" }, platform: "linux", execArgv: [], getuid: () => 1001 };
const tapOk = async () => ({ status: 0, signal: null, stdout: "TAP version 13\n# tests 9\n# pass 9\n# fail 0\n", truncated: false, spawnFailed: false });
const DB_URL = `postgresql://mv_booking_app_dev.${C.dbProjectRef}:Fake1@aws-0-us-east-1.pooler.supabase.com:6543/postgres`;
const CA_BYTES = Buffer.from("fake-ca"); const caSha = createHash("sha256").update(CA_BYTES).digest("hex");
async function hosted(mode, env, deps = {}) {
  const res = await E.runHosted({ mode, env: { E7_TOOLING_DIR: TOOLING, ...env }, proc: PROC, wrapperDir: ROOT,
    deps: { spawnChild: tapOk, importEnv: async () => C1, ...deps } });
  const s = JSON.stringify(res) + E.summaryMarkdown(res.result);
  for (const bad of [...FORBIDDEN, "Fake1@"]) assert.ok(!s.includes(bad), `no ${bad} in hosted output`);
  return res;
}
const REAL = { E7_APPROVAL_REF: "synthetic-label-1", E7_INTENT_ID: IID, E7_PAYMENT_INTENT_ID: PI };

test("H1. preflight: no secret / DB URL / Hostaway allowed; closure + runner digests; synthetic vs real plan; inputs complete or refused; fake child only", async () => {
  const s = await hosted("preflight", {});
  assert.deepEqual([s.exitCode, s.result.code, s.result.closureDigest, s.result.planKind, s.result.envCode, s.result.core], [0, "PREFLIGHT_OK_SYNTHETIC_ONLY", C.closureDigest, "SYNTHETIC", "ENV_OK", null]);
  const r = await hosted("preflight", REAL);
  assert.deepEqual([r.result.code, r.result.planKind], ["PREFLIGHT_OK_REAL_PLAN", "REAL"]);
  assert.equal(r.result.planHash, E.buildPlan(C, { approvalRef: "synthetic-label-1", intentId: IID, paymentIntentId: PI, runnerDigest: r.result.runnerDigest }).planHash);
  let childEnv = null; let childArgs = null;
  await hosted("preflight", REAL, { spawnChild: async (a, o) => { childEnv = o.env; childArgs = a; return tapOk(); } });
  assert.deepEqual(Object.keys(childEnv).filter((k) => k.startsWith("E7_")), ["E7_TOOLING_DIR"]);
  assert.ok(!("E7_CLEANUP_DB_TESTS" in childEnv));
  assert.deepEqual(childArgs, ["--test", "--test-reporter=tap", "test/e7-checkout-test-cleanup.test.mjs"]);
  for (const env of [{ E7_STRIPE_TEST_KEY: KEY }, { E7_DEV_BOOKING_DATABASE_URL: DB_URL }, { E7_HOSTAWAY_TOKEN: "x" }]) assert.equal((await hosted("preflight", env)).result.code, "CLN_SECRET_SCOPE_VIOLATION");
  assert.equal((await hosted("preflight", { E7_APPROVAL_REF: "l1" })).result.code, "CLN_INPUT_INCOMPLETE");
  assert.equal((await hosted("preflight", { ...REAL, E7_INTENT_ID: "nope" })).result.code, "CLN_INPUT_INVALID");
  assert.equal((await hosted("preflight", { ...REAL, E7_INTENT_ID: C.synthetic.intentId })).result.code, "CLN_INPUT_INVALID");
  assert.equal((await hosted("preflight", {}, { spawnChild: async () => ({ ...(await tapOk()), stdout: "# tests 9\n# pass 8\n# fail 1\n", status: 1 }) })).result.code, "CLN_TESTS_FAILED");
});

test("H2. the accepted closure is verified BEFORE any tooling import; the closure list is the scanned transitive import closure; digest constant", async () => {
  // scan relative imports from every entry the runner imports
  const seen = new Set(); const bare = new Set();
  const visit = (rel) => { if (seen.has(rel)) return; seen.add(rel); const src = readFileSync(join(TOOLING, rel), "utf8");
    for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']|(?:^|\n)\s*import\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)) {
      const sp = m[1] || m[2] || m[3]; if (sp.startsWith(".")) visit(normalize(join(dirname(rel), sp))); else bare.add(sp); } };
  for (const e of ["lib/booking-db/compensation-worker.js", "lib/booking-db/pool.js", "lib/booking-db/repo.js", "lib/checkout/intent-state.js", "scripts/e7-connected/executor-adapters.mjs",
    "scripts/e7-connected/http-transports.mjs", "scripts/e7-connected/real-exchange.mjs", "scripts/e7-connected/probe-env-preflight.mjs", "lib/hostaway-reservations.js"]) visit(e);
  assert.deepEqual([...C.closure].sort(), ["package.json", "package-lock.json", ...seen].sort());
  assert.deepEqual([...bare].filter((b) => !b.startsWith("node:")), ["pg"], "the only non-builtin dependency is pg");
  assert.equal(await E.framedDigest(TOOLING, C.closure, E.CLOSURE_DIGEST_PREFIX), C.closureDigest);
  assert.equal(JSON.parse(readFileSync(join(TOOLING, "package-lock.json"), "utf8")).packages["node_modules/pg"].version, C.pgVersion);
  const d = realpathSync(mkdtempSync(join(tmpdir(), "e7cln-tool-"))); TMP.push(d);
  for (const rel of C.closure) { const dst = join(d, rel); cpSync(join(TOOLING, rel), dst); }
  assert.equal(await E.framedDigest(d, C.closure, E.CLOSURE_DIGEST_PREFIX), C.closureDigest, "faithful copy");
  writeFileSync(join(d, "lib/booking-db/compensation-worker.js"), readFileSync(join(TOOLING, "lib/booking-db/compensation-worker.js"), "utf8") + "\n// tamper\n");
  let imported = 0;
  const r = await E.runHosted({ mode: "preflight", env: { E7_TOOLING_DIR: d }, proc: PROC, wrapperDir: ROOT, deps: { spawnChild: tapOk, importEnv: async () => { imported += 1; return C1; } } });
  assert.deepEqual([r.result.code, imported], ["CLN_SOURCE_MISMATCH", 0]);
  writeFileSync(join(d, "lib/booking-db/compensation-worker.js"), readFileSync(join(TOOLING, "lib/booking-db/compensation-worker.js")));
  writeFileSync(join(d, "package-lock.json"), readFileSync(join(TOOLING, "package-lock.json"), "utf8").replace('"version": "8.18.0"', '"version": "8.18.1"'));
  assert.equal((await E.runHosted({ mode: "preflight", env: { E7_TOOLING_DIR: d }, proc: PROC, wrapperDir: ROOT, deps: { spawnChild: tapOk, importEnv: async () => C1 } })).result.code, "CLN_SOURCE_MISMATCH", "the lockfile is part of the closure");
});

test("H3. verify / execute: main only, all bindings explicit; execute needs both secrets, the DEV runtime target, the pinned CA and the pinned pg; secrets leave env", async () => {
  const rd = await E.framedDigest(ROOT, C.runnerFiles, E.RUNNER_DIGEST_PREFIX);
  const ph = E.buildPlan(C, { approvalRef: "synthetic-label-1", intentId: IID, paymentIntentId: PI, runnerDigest: rd }).planHash;
  const B = { ...REAL, E7_EXPECTED_PLAN_HASH: ph, E7_EXPECTED_CLOSURE_DIGEST: C.closureDigest, E7_EXPECTED_RUNNER_DIGEST: rd, GITHUB_REF: "refs/heads/main" };
  assert.equal((await hosted("verify", B)).result.code, "VERIFY_OK");
  for (const [o, code] of [[{ GITHUB_REF: "refs/heads/feature/x" }, "CLN_REF_NOT_MAIN"], [{ E7_EXPECTED_RUNNER_DIGEST: "a".repeat(64) }, "CLN_RUNNER_MISMATCH"],
    [{ E7_EXPECTED_PLAN_HASH: "b".repeat(64) }, "CLN_PLAN_HASH_MISMATCH"], [{ E7_EXPECTED_CLOSURE_DIGEST: "c".repeat(64) }, "CLN_SOURCE_MISMATCH"],
    [{ E7_EXPECTED_PLAN_HASH: "" }, "CLN_INPUT_INCOMPLETE"], [{ E7_INTENT_ID: "" }, "CLN_INPUT_INCOMPLETE"], [{ E7_STRIPE_TEST_KEY: KEY }, "CLN_SECRET_SCOPE_VIOLATION"],
    [{ E7_INTENT_ID: "3f1d2c4b-5a69-4e7d-8f01-23456789abce" }, "CLN_PLAN_HASH_MISMATCH"]]) {
    assert.equal((await hosted("verify", { ...B, ...o })).result.code, code, code);
  }
  const ex = (env, deps = {}) => hosted("execute", { ...B, ...env }, { readPgVersion: async () => "8.18.0", readCa: async () => CA_BYTES, constants: { ...C }, ...deps });
  assert.equal((await ex({ E7_STRIPE_TEST_KEY: KEY })).result.code, "CLN_CREDENTIALS_MISSING");
  assert.equal((await ex({ E7_DEV_BOOKING_DATABASE_URL: DB_URL })).result.code, "CLN_CREDENTIALS_MISSING");
  const both = { E7_STRIPE_TEST_KEY: KEY, E7_DEV_BOOKING_DATABASE_URL: DB_URL, E7_CA_FILE: "/x/prod-ca-2021.crt" };
  assert.equal((await ex(both, { readPgVersion: async () => "8.18.1" })).result.code, "CLN_DEPENDENCY_MISMATCH");
  for (const u of [DB_URL.replace("mv_booking_app_dev.", "postgres."), DB_URL.replace("6543", "5432"), DB_URL.replace("pooler.supabase.com", "pooler.example.com"),
    DB_URL + "?sslmode=disable", DB_URL.replace(C.dbProjectRef, "cjfxrspwlsottmgpxkzu")]) {
    assert.equal((await ex({ ...both, E7_DEV_BOOKING_DATABASE_URL: u })).result.code, "CLN_DB_TARGET_INVALID", u.slice(0, 40));
  }
  assert.equal((await ex(both)).result.code, "CLN_CA_INVALID", "a CA whose SHA-256 is not the pinned official one is refused");
  // the pinned CA hash = scripts/db-smoke.mjs OFFICIAL_CA_SHA256 (accepted) — asserted against the tooling source, not retyped
  assert.match(readFileSync(join(TOOLING, "scripts/db-smoke.mjs"), "utf8"), new RegExp(`OFFICIAL_CA_SHA256 = "${E.OFFICIAL_CA_SHA256}"`));
  // execute with the CA pin satisfied (fake CA bytes + matching test-only hash override), fake pool, fake core: exactly the bound inputs; secrets leave env
  let seen = null; let ended = 0; const env2 = { E7_TOOLING_DIR: TOOLING, ...B, ...both };
  const origHash = E.OFFICIAL_CA_SHA256;
  const r = await E.runHosted({ mode: "execute", env: env2, proc: PROC, wrapperDir: ROOT, deps: { importEnv: async () => C1, readPgVersion: async () => "8.18.0",
    readCa: async () => CA_BYTES, caSha256: caSha,
    importTooling: async () => ({ X: { createE7RealExchange: () => ({ ok: true, exchange: async () => { throw new Error("no"); } }) },
      createBookingPool: (o) => { seen = { url: o.connectionString === DB_URL, ca: o.caPem === "fake-ca", max: o.max }; return { end: async () => { ended += 1; } }; }, tooling: {} }),
    runCore: async (i) => { seen.core = { key: i.credential(), keys: Object.keys(i).sort(), planHash: E.buildPlan(C, i.plan).planHash }; return { outcome: "RELEASED" }; },
    spawnChild: async () => { throw new Error("no child in execute"); } } });
  assert.equal(origHash, E.OFFICIAL_CA_SHA256);
  assert.deepEqual([r.exitCode, r.result.code], [0, "EXECUTE_DONE"]);
  assert.deepEqual(seen, { url: true, ca: true, max: 2, core: { key: KEY, keys: ["credential", "exchange", "plan", "pool", "runSignal", "tooling"], planHash: ph } });
  assert.equal(ended, 1, "the pool is always closed");
  assert.deepEqual(["E7_STRIPE_TEST_KEY" in env2, "E7_DEV_BOOKING_DATABASE_URL" in env2], [false, false]);
});

test("P1. source pins: inert, built-ins only, Stripe origin only, no capture / refund / create / Hostaway transport / fetch; workflow scope", () => {
  const src = readFileSync(join(ROOT, "scripts/e7-checkout-test-cleanup.mjs"), "utf8");
  const code = src.replace(/^\s*\/\/.*$/gm, "").replace(/\/\/ .*$/gm, "");
  assert.deepEqual([...src.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]), ["node:process", "node:child_process", "node:crypto", "node:fs/promises", "node:url"]);
  for (const re of [/paymentIntents\.(capture|create|update|confirm)/, /\/capture(?![-_a-z])/, /paymentIntents\.refund|\/v1\/refunds|refunds\.create/i, /hostaway\.com/i, /\bfetch\s*\(/, /node:(https?|net|tls|dns)"/,
    /https:\/\/(?!api\.stripe\.com|supabase-downloads)[a-z]/, /\bINSERT\b|\bUPDATE\b|\bDELETE\b|FOR UPDATE/, /guest\.notify"\s*\)/, /process\.env\.(?!GITHUB_STEP_SUMMARY)/]) assert.ok(!re.test(code), String(re));
  assert.ok(/if \(import\.meta\.main === true\)/.test(src));
  for (const sql of Object.values(E.QUERIES)) assert.match(sql, /^\/\*e7c:[a-z]+\*\/ SELECT /);
  const wf = readFileSync(join(ROOT, ".github/workflows/e7-checkout-test-cleanup.yml"), "utf8");
  assert.deepEqual([...wf.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]), ["E7_STRIPE_TEST_KEY", "E7_DEV_BOOKING_DATABASE_URL"]);
  assert.equal((wf.match(/environment: e7-readonly-probe/g) || []).length, 1);
  assert.ok(wf.includes("if: inputs.mode == 'execute' && github.ref == 'refs/heads/main'"));
  assert.equal((wf.match(/ref: 6d703acdcfa205138d1ce4ba65b2ec58fc9493c9/g) || []).length, 2);
  assert.ok(wf.includes("default: preflight") && wf.includes('node-version: "22.22.0"') && wf.includes("permissions:\n  contents: read"));
  assert.equal((wf.match(/persist-credentials: false/g) || []).length, 4);
  assert.equal((wf.match(/npm ci --ignore-scripts --omit=dev --no-audit --no-fund/g) || []).length, 1, "the dependency is installed in execute only, after verify");
  assert.ok(wf.indexOf("verify\n") < wf.indexOf("npm ci") && wf.indexOf("npm ci") < wf.indexOf("execute\n", wf.indexOf("npm ci")));
  for (const u of [...wf.matchAll(/uses: (\S+)/g)].map((m) => m[1])) assert.ok(["actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803", "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38"].includes(u), u);
  assert.ok(!/\bpush:|pull_request|schedule:/.test(wf));
});

// =====================================================================================================================================
// OPT-IN: the REAL accepted worker / repo / executors / T on a disposable PG 17 (E7_CLEANUP_DB_TESTS=1; tooling with its pinned pg installed)
if (process.env.E7_CLEANUP_DB_TESTS === "1") {
  const tooling = { ...(await tool("lib/booking-db/compensation-worker.js")), ...(await tool("lib/booking-db/repo.js")) };
  const { startMigratedDatabase } = await tool("test/db/harness.mjs");
  const { createIntentApiHandler } = await tool("lib/checkout/intent-api-http.js");
  const { processVerifiedStripeEvent } = await tool("lib/checkout/stripe-test-webhook.js");
  const { ENV_OK } = await tool("test/e5a-fixtures.mjs");
  const { addDays } = await tool("lib/bookability.js");
  const { findIntentIdByTokenHash } = await tool("lib/booking-db/intent-access.js");
  const { hashToken } = await tool("lib/checkout/intent-api-http.js");
  const pg = (await import(pathToFileURL(join(TOOLING, "node_modules/pg/lib/index.js")).href)).default;
  const db = await startMigratedDatabase();
  after(async () => { await db.close(); });
  const realTooling = { runCleanupStep: tooling.runCleanupStep, loadIntent: tooling.loadIntent, voidKey: IS.voidKey, testReleaseEventId: IS.testReleaseEventId,
    createPhaseExecutors: EA.createPhaseExecutors, createStripeSend: T.createE7StripeTestSend, validateAdapterConfig: HR.validateAdapterConfig };
  const LISTING = 606998; const ORIGIN = "https://preview.example.invalid"; const NOW0 = Date.UTC(2026, 10, 2, 20, 0, 0); const MIN = 60000; const DAY = 1440 * MIN;
  const ENV = Object.freeze({ ...ENV_OK, STRIPE_TEST_ACCOUNT_ID: ACCT, MV_CHECKOUT_TEST_API: "enabled", MV_CHECKOUT_ALLOWED_ORIGIN: ORIGIN, MV_CHECKOUT_TEST_LISTINGS: `${LISTING}:USD`,
    MV_RATE_LIMIT_SALT: "s".repeat(40), MV_CHECKOUT_TERMS_VERSION: "terms-2026-11", MV_CHECKOUT_TEST_RELEASE: "enabled" });
  const clone = (o) => JSON.parse(JSON.stringify(o)); const sec = (ms) => Math.floor(ms / 1000);
  let seq = 0; let stayN = 0;
  const q = async (sql, p = []) => (await db.app.query(sql, p)).rows;
  /** fake Stripe world behind the intent API / webhook (SDK-shaped) AND behind the runner's REAL T (HTTP-shaped exchange) */
  function world() {
    const w = { sessions: new Map(), pis: new Map(), wire: [] };
    const strip = (s) => { const { _pim, ...r } = s; return clone(r); };
    w.stripe = { accounts: { retrieve: async () => ({ object: "account", id: ACCT }) },
      checkout: { sessions: { create: async (params) => { const id = `cs_test_C${++seq}`; const pd = params.line_items[0].price_data;
        const s = { object: "checkout.session", id, livemode: false, mode: "payment", status: "open", payment_status: "unpaid", amount_total: pd.unit_amount, currency: pd.currency,
          client_reference_id: params.client_reference_id, metadata: { ...params.metadata }, expires_at: params.expires_at, url: `https://checkout.stripe.com/c/pay/${id}`, payment_intent: null,
          customer_details: null, _pim: params.payment_intent_data }; w.sessions.set(id, s); return strip(s); },
      retrieve: async (id) => strip(w.sessions.get(id)) } },
      paymentIntents: { retrieve: async (id) => clone(w.pis.get(id)) } };
    w.hostaway = { get: async (path, opts = {}) => { const m = /^\/listings\/(\d+)(\/calendar)?$/.exec(path);
        if (!m[2]) return { status: 200, json: { result: { id: Number(m[1]), currencyCode: "USD", personCapacity: 4, minNights: 1, maxNights: 90 } } };
        const out = []; for (let d = opts.query.startDate; d <= opts.query.endDate; d = addDays(d, 1)) out.push({ date: d, status: "available", isAvailable: 1, minimumStay: 1, maximumStay: 90, closedOnArrival: 0, closedOnDeparture: 0 });
        return { status: 200, json: { result: out } }; },
      post: async (path, body) => { const nights = Math.round((Date.parse(body.endingDate) - Date.parse(body.startingDate)) / DAY);
        const comps = [{ id: 1, type: "accommodation", name: "baseRate", title: "Base rate", quantity: 1, value: 125, total: 125 * nights, isIncludedInTotalPrice: 1, isMandatory: 1, isOverriddenByUser: 0, isDeleted: 0, units: nights }];
        return { status: 200, json: { status: "success", result: { totalPrice: comps[0].total, components: comps } } }; } };
    w.pay = (sessionId, authAtMs) => { const s = w.sessions.get(sessionId); const piId = `pi_Clean${String(++seq).padStart(6, "0")}`;
      s.status = "complete"; s.payment_intent = piId; s.customer_details = { email: "guest@example.invalid", name: "Guest Person" };
      w.pis.set(piId, { object: "payment_intent", id: piId, livemode: false, status: "requires_capture", capture_method: s._pim.capture_method, amount: s.amount_total, amount_capturable: s.amount_total,
        amount_received: 0, currency: s.currency, metadata: { ...s._pim.metadata }, latest_charge: { object: "charge", id: `ch_C${seq}`, livemode: false, payment_intent: piId, captured: false,
          amount: s.amount_total, amount_captured: 0, amount_refunded: 0, currency: s.currency, status: "succeeded", paid: true, created: sec(authAtMs),
          payment_method_details: { type: "card", card: { capture_before: sec(authAtMs + 7 * DAY), last4: "4242" } } } });
      return piId; };
    w.event = (sessionId, t) => ({ id: `evt_C${++seq}`, object: "event", type: "checkout.session.completed", livemode: false, created: sec(t), api_version: "2026-01-28.clover",
      data: { object: strip(w.sessions.get(sessionId)) } });
    w.exchange = (req) => {   // HTTP side for the runner's real T
      const reply = (o) => Promise.resolve({ status: 200, contentType: "application/json", bytes: enc(o) });
      if (req.method === "GET" && req.url === "https://api.stripe.com/v1/account") { w.wire.push("account"); return reply({ object: "account", id: ACCT }); }
      const m = /^https:\/\/api\.stripe\.com\/v1\/payment_intents\/(pi_[A-Za-z0-9]+)(\/cancel|\?expand%5B%5D=latest_charge)$/.exec(req.url);
      if (m && req.method === "GET" && m[2].startsWith("?")) { w.wire.push("pi"); return reply(clone(w.pis.get(m[1]))); }
      if (m && req.method === "POST" && m[2] === "/cancel") { w.wire.push("cancel"); if (w.onCancel) return w.onCancel(req, m[1]);
        const p = w.pis.get(m[1]); p.status = "canceled"; p.amount_capturable = 0; if (w.refundOnCancel) p.latest_charge.amount_refunded = p.amount; return reply(clone(p)); }
      w.wire.push("UNEXPECTED"); return Promise.reject(new Error("unexpected"));
    };
    return w;
  }
  const call = (handler, { method = "POST", body, token } = {}) => { const raw = body === undefined ? "" : JSON.stringify(body);
    const req = Readable.from(raw ? [Buffer.from(raw)] : []); req.method = method; req.url = "/api/checkout/x";
    req.headers = { origin: ORIGIN, ...(method === "POST" ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) };
    const res = { statusCode: 0, headers: {}, body: null, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { this.body = b ? JSON.parse(b) : null; } };
    return handler(req, res).then(() => res); };
  async function releasedBooking() {
    const w = world(); const clock = { now: NOW0 };
    const deps = { createPool: () => db.app, loadCore: async () => tool("lib/checkout/intent-api-core.js"), loadAccess: async () => tool("lib/booking-db/intent-access.js"),
      createStripe: () => w.stripe, createHostaway: () => w.hostaway, loadStripe: async () => { throw new Error("no SDK"); }, loadHostaway: async () => { throw new Error("no Hostaway"); },
      now: () => clock.now, log: () => {}, onError: (e) => { throw e; } };
    const h = { intents: createIntentApiHandler({ route: "intents", env: ENV, deps }), step: createIntentApiHandler({ route: "step", env: ENV, deps }) };
    const from = addDays("2027-10-01", 4 * stayN++);
    const c = await call(h.intents, { body: { listingId: LISTING, from, to: addDays(from, 3), guests: 2 } });
    assert.equal(c.statusCode, 201, JSON.stringify(c.body));
    const token = c.body.token; const id = await findIntentIdByTokenHash(db.app, hashToken(token));
    clock.now += 1000;
    assert.equal((await call(h.step, { body: { step: "details", firstName: "Zanabria", lastName: "Quintessa", email: "zq.cleanup@example.test", termsVersion: "terms-2026-11" }, token })).statusCode, 200);
    clock.now += 1000;
    assert.equal((await call(h.step, { body: { step: "pay" }, token })).statusCode, 200);
    const sessionId = [...w.sessions.keys()][0];
    clock.now = NOW0 + 4 * MIN;
    const piId = w.pay(sessionId, clock.now - 30000);
    assert.deepEqual(await processVerifiedStripeEvent(db.app, w.event(sessionId, clock.now), { stripe: w.stripe, now: clock.now, accountId: ACCT, accountCache: {} }),
      { http: 200, code: "APPLIED", state: "payment_authorized" });
    clock.now = NOW0 + 6 * MIN;
    assert.equal((await call(h.step, { body: { step: "release" }, token })).statusCode, 202);
    return { w, id, piId };
  }
  const plan = (b) => E.buildPlan(C, { approvalRef: "synthetic-label-db", intentId: b.id, paymentIntentId: b.piId, runnerDigest: "0".repeat(64) }).plan;
  const runReal = (b, o = {}) => E.runCleanupCore({ plan: plan(b), pool: db.app, tooling: realTooling, exchange: o.exchange ?? b.w.exchange, credential: () => KEY,
    clock: () => NOW0 + 8 * MIN, sleep: async () => {}, workerTimeouts: o.workerTimeouts });
  const voidRow = async (id) => (await q("SELECT state, attempts FROM booking.external_operations WHERE intent_id = $1 AND op_type = 'stripe.void_payment_intent'", [id]))[0];
  const claimRow = async (id) => (await q("SELECT released_at FROM booking.inventory_claims WHERE intent_id = $1", [id]))[0];

  test("D1. REAL worker + adapters + T on disposable PG: released intent → ONE void → RELEASED, claim released; repeat run → ALREADY_RELEASED with ZERO sends; other intents untouched", async () => {
    const other = await releasedBooking();
    const b = await releasedBooking();
    const r = await runReal(b);
    assert.equal(r.outcome, "RELEASED", JSON.stringify(r));
    assert.deepEqual([r.cancelInvocations, r.cancelOutcome, r.hostawayCalls, r.refusedAtTransport, r.voidOpState, r.claimReleased], [1, "REPLIED", 0, 0, "succeeded", true]);
    assert.deepEqual(b.w.wire.filter((x) => x === "cancel").length, 1);
    assert.ok(!b.w.wire.includes("UNEXPECTED"));
    assert.equal((await tooling.loadIntent(db.app, b.id)).status, "authorization_released");
    assert.notEqual((await claimRow(b.id)).released_at, null);
    const wireBefore = b.w.wire.length;
    const again = await runReal(b);
    assert.deepEqual([again.outcome, again.exchanges, again.steps, b.w.wire.length], ["ALREADY_RELEASED", 0, 0, wireBefore]);
    assert.deepEqual([(await voidRow(other.id)).state, (await claimRow(other.id)).released_at, other.w.wire.length], ["pending", null, 0], "scoped: the other intent is untouched");
    assert.equal(Number((await q("SELECT count(*) AS n FROM booking.external_operations WHERE intent_id = $1 AND op_type = 'guest.notify' AND dispatched_at IS NOT NULL", [b.id]))[0].n), 0, "no notification dispatched");
  });

  test("D2. strict canceled proof refusal (charge reports amount_refunded = amount): the worker reports VOID_OUTCOME_UNKNOWN → STOP, claim HELD; rerun → refused with zero exchanges", async () => {
    const b = await releasedBooking(); b.w.refundOnCancel = true;
    const r = await runReal(b);
    assert.deepEqual([r.outcome, r.code, r.cancelInvocations, r.steps], ["CANCEL_OUTCOME_UNKNOWN", "WORKER_VOID_OUTCOME_UNKNOWN", 1, 1], JSON.stringify(r));
    assert.equal((await claimRow(b.id)).released_at, null);
    const again = await runReal(b);
    assert.deepEqual([again.exchanges, again.steps], [0, 0]);
    assert.ok(["SCOPE_REFUSED", "START_STATE_NOT_ELIGIBLE"].includes(again.outcome), again.outcome);
  });

  test("D3. cancel transport failure / timeout → CANCEL_OUTCOME_UNKNOWN; rerun is refused (void row no longer pristine) → never a second void", async () => {
    for (const mk of [() => Promise.reject(new Error(CANARY)), (req) => new Promise((_, rej) => { req.signal.addEventListener("abort", () => rej(new Error("aborted")), { once: true }); })]) {
      const b = await releasedBooking(); b.w.onCancel = mk;
      const r = await runReal(b, { workerTimeouts: { readCallMs: 2000, writeCallMs: 300, stepBudgetMs: 45000 } });
      assert.deepEqual([r.outcome, r.cancelInvocations, b.w.wire.filter((x) => x === "cancel").length], ["CANCEL_OUTCOME_UNKNOWN", 1, 1], JSON.stringify(r));
      const again = await runReal(b);
      assert.deepEqual([again.exchanges, again.steps, b.w.wire.filter((x) => x === "cancel").length], [0, 0, 1], JSON.stringify(again));
      assert.ok(["START_STATE_NOT_ELIGIBLE", "SCOPE_REFUSED"].includes(again.outcome), JSON.stringify(again));
      assert.equal((await claimRow(b.id)).released_at, null);
    }
  });

  test("D5. REAL worker: an abort observed in the account reply → ZERO cancel on the wire; the run stops without a success claim", async () => {
    const b = await releasedBooking(); const ac = new AbortController();
    const ex = (req) => { if (req.url === "https://api.stripe.com/v1/account") { const p = b.w.exchange(req); ac.abort(); return p; } return b.w.exchange(req); };
    const r = await E.runCleanupCore({ plan: plan(b), pool: db.app, tooling: realTooling, exchange: ex, credential: () => KEY, clock: () => NOW0 + 8 * MIN, sleep: async () => {}, runSignal: ac.signal });
    assert.deepEqual([r.outcome, r.cancelInvocations, b.w.wire.filter((x) => x === "cancel").length, r.steps], ["ABORTED", 0, 0, 1], JSON.stringify(r));
    assert.equal((await claimRow(b.id)).released_at, null);
    const v = await voidRow(b.id);
    console.log(`# D5 void row after the stop: ${v.state} attempts ${v.attempts}`);
  });

  test("D4. wrong scope on a real row: a foreign PaymentIntent and a foreign intent id are refused with zero exchanges", async () => {
    const b = await releasedBooking();
    const wrongPi = await E.runCleanupCore({ plan: E.buildPlan(C, { approvalRef: "l", intentId: b.id, paymentIntentId: "pi_OtherFake0001", runnerDigest: "0".repeat(64) }).plan,
      pool: db.app, tooling: realTooling, exchange: b.w.exchange, credential: () => KEY, clock: () => NOW0 + 8 * MIN, sleep: async () => {} });
    assert.deepEqual([wrongPi.outcome, wrongPi.code, wrongPi.exchanges], ["SCOPE_REFUSED", "PAYMENT_INTENT_SCOPE", 0]);
    const foreign = await E.runCleanupCore({ plan: E.buildPlan(C, { approvalRef: "l", intentId: "9b1d2c4b-5a69-4e7d-8f01-23456789abcd", paymentIntentId: b.piId, runnerDigest: "0".repeat(64) }).plan,
      pool: db.app, tooling: realTooling, exchange: b.w.exchange, credential: () => KEY, clock: () => NOW0 + 8 * MIN, sleep: async () => {} });
    assert.deepEqual([foreign.outcome, foreign.code, foreign.exchanges], ["SCOPE_REFUSED", "INTENT_NOT_FOUND", 0]);
    assert.equal(b.w.wire.length, 0);
    void pg;
  });
}

test("H9. minimal child environment: only the OS / runtime allowlist + E7_TOOLING_DIR reach the preflight child; credentials, DB URLs, tokens, NODE_* hooks and E7 inputs never do (nor any output)", async () => {
  const CANARIES = { CUSTOM_API_TOKEN: "CANARY_tok_1", DATABASE_URL: "postgresql://u:CANARY_db_2@h/x", GITHUB_TOKEN: "CANARY_gh_3", NODE_PATH: "/CANARY_np_4",
    NODE_LOADER: "CANARY_ld_5", NPM_CONFIG_USERCONFIG: "/CANARY_npm_6", AWS_SECRET_ACCESS_KEY: "CANARY_aws_7", STRIPE_SECRET_KEY: "CANARY_sk_10" };
  const BASICS = { PATH: "/usr/bin:/bin", HOME: "/home/runner", TMPDIR: "/tmp/r", LANG: "C.UTF-8", TZ: "UTC" };
  const unit = E.childEnv({ ...BASICS, ...CANARIES, NODE_OPTIONS: "--import=/CANARY_hook_8.mjs", NODE_EXTRA_CA_CERTS: "/CANARY_ca_9", E7_APPROVAL_REF: "lbl",
    E7_INTENT_ID: IID, E7_PAYMENT_INTENT_ID: PI, E7_EXPECTED_PLAN_HASH: "0".repeat(64), E7_DEV_BOOKING_DATABASE_URL: DB_URL, E7_STRIPE_TEST_KEY: "CANARY_key_11",
    E7_CLEANUP_DB_TESTS: "1", E7_TOOLING_DIR: "/attacker" }, "/tooling");
  assert.deepEqual(unit, { ...BASICS, E7_TOOLING_DIR: "/tooling" });
  assert.deepEqual([...E.CHILD_ENV_ALLOWLIST], ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "TZ"]);
  assert.deepEqual(E.childEnv({ PATH: "a\0b", HOME: "x".repeat(5000), TMP: 7 }, "/t"), { E7_TOOLING_DIR: "/t" }, "malformed values are dropped, not passed");
  let seen = null; let args = null;
  const res = await hosted("preflight", { ...BASICS, ...CANARIES, ...REAL }, { spawnChild: async (a, o) => { args = a; seen = o.env; return tapOk(); } });
  assert.equal(res.result.code, "PREFLIGHT_OK_REAL_PLAN");
  assert.deepEqual(seen, { ...BASICS, E7_TOOLING_DIR: TOOLING });
  assert.deepEqual(args, ["--test", "--test-reporter=tap", "test/e7-checkout-test-cleanup.test.mjs"]);
  const out = JSON.stringify(res.result) + E.summaryMarkdown(res.result) + JSON.stringify(seen);
  for (const v of Object.values(CANARIES)) assert.equal(out.includes(v.replace(/^.*CANARY/, "CANARY")), false, v);
});
