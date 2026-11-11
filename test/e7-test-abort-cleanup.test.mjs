// test/e7-test-abort-cleanup.test.mjs — OFFLINE tests of scripts/e7-test-abort-cleanup.mjs (runner A). Node built-ins only. LABELS
//   * REAL: the runner; from the PINNED guard tooling (E7_TOOLING_DIR, default ../../tooling = workflow layout): the transports T
//     (createE7StripeTestSend / createE7HostawaySend), the executor adapters (cleanup phase), intent-state keys, validateAdapterConfig,
//     unwrapEnvelope / normalizeReservation, C1; real framed digests over the real checkouts.
//   * FAKE: every provider reply (in-process fake exchanges under the real T), the DB (a tagged-query fake), the operator abort and the
//     cleanup worker (they drive the REAL executors). SYNTHETIC keys / tokens. Nothing here is connectivity evidence.
//   * node:https request / Agent and fetch are guarded and must count ZERO at the end.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { readFileSync, realpathSync, mkdtempSync, cpSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const GUARD = { request: 0, Agent: 0, fetch: 0 };
https.request = function g() { GUARD.request += 1; throw new Error("refused"); };
https.Agent = function g() { GUARD.Agent += 1; throw new Error("refused"); };
syncBuiltinESMExports();
globalThis.fetch = async () => { GUARD.fetch += 1; throw new Error("refused"); };
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOOLING = realpathSync(process.env.E7_TOOLING_DIR || join(ROOT, "..", "tooling"));
const tool = (p) => import(pathToFileURL(join(TOOLING, p)).href);
const E = await import("../scripts/e7-test-abort-cleanup.mjs");
const [T, EA, IS, HR, C1, CP, KP] = await Promise.all([tool("scripts/e7-connected/http-transports.mjs"), tool("scripts/e7-connected/executor-adapters.mjs"),
  tool("lib/checkout/intent-state.js"), tool("lib/hostaway-reservations.js"), tool("scripts/e7-connected/probe-env-preflight.mjs"),
  tool("lib/checkout/capture-proof.js"), tool("lib/checkout/compensation-proof.js")]);
after(() => { assert.deepEqual(GUARD, { request: 0, Agent: 0, fetch: 0 }, "no real network primitive was touched"); });

const C = E.CONSTANTS;
const IID = "11111111-2222-4333-8444-555555555555"; const PI = "pi_FAKEabortCleanup01"; const RID = "71999901"; const VER = 7; const REF = "MV-FAKE0001";
const ACCT = C.accountId; const AMT = 14000; const CAPTURE_BEFORE = Date.UTC(2026, 10, 18, 18, 8, 10); const ATTEMPT = "a1";
const enc = (o) => new TextEncoder().encode(JSON.stringify(o));
const plan = (over = {}) => E.buildPlan(C, { approvalRef: "SYNTHETIC-test-abort-cleanup", intentId: IID, paymentIntentId: PI, reservationId: RID, expectedVersion: VER,
  runnerDigest: "0".repeat(64), ...over }).plan;

// ---------------------------------------------------------------------------------------------------------------------------------
// fake world: DB rows + providers; the abort / worker fakes mutate it the way the accepted code would
function world(o = {}) {
  const w = { status: "reservation_confirmed", version: VER, reason: null, tr: [], ops: [], claimReleased: false, legs: { c: null, a: null }, echoRef: o.echoRef ?? true,
    hx: [{ state: o.hxState ?? "reconciled_found", rid: RID }], pi: "requires_capture", res: "new", calls: [], abortCalls: 0, workerCalls: 0 };
  for (let v = 1; v <= VER; v++) w.tr.push({ version_after: v, from_state: v === 1 ? null : "x", to_state: v === VER ? "reservation_confirmed" : "x", event_type: `E${v}`, event_id: `e${v}`, reason_code: null });
  w.ops.push({ op_type: "stripe.create_checkout_session", state: "succeeded", attempts: 1, dispatched: true, provider_key: null, payload_pi: null });
  w.ops.push({ op_type: "hostaway.create_reservation", state: "succeeded", attempts: 1, dispatched: true, provider_key: null, payload_pi: null });
  w.ops.push({ op_type: "hostaway.lookup_reservation", state: "succeeded", attempts: 1, dispatched: true, provider_key: null, payload_pi: null });
  w.ops.push({ op_type: "stripe.capture_payment_intent", state: "pending", attempts: 0, dispatched: false, provider_key: null, payload_pi: PI });
  return w;
}
const intentOf = (w) => ({ id: IID, status: w.status, version: w.version, reasonCode: w.reason, listingId: 606998, from: "2026-11-25", to: "2026-11-26", guests: 1, ref: REF,
  price: { currency: "USD", finalTotalMinor: AMT }, payment: { paymentIntentId: PI, livemode: false, capturedMinor: 0, amountMinor: AMT, currency: "USD", captureBefore: CAPTURE_BEFORE },
  reservation: { reservationId: Number(RID) }, checkout: { sessionId: "cs_test_FAKE01" } });
function fakePool(w, o = {}) {
  const tag = (sql) => /\/\*e7atc:(\w+)\*\//.exec(sql)?.[1];
  return { reads: 0, async query(sql) {
    this.reads += 1;
    if (o.dbFailAt && this.reads === o.dbFailAt) throw new Error("db down");
    switch (tag(sql)) {
      case "instance": return { rows: [{ environment: o.env ?? "test" }] };
      case "transitions": return { rows: w.tr.map((x) => ({ ...x })) };
      case "attempts": return { rows: [{ id: ATTEMPT, status: "completed", checkout_session_id: "cs_test_FAKE01", payment_intent_id: PI, livemode: false }] };
      case "hostaway": return { rows: w.hx.map((x) => ({ ...x })) };
      case "ops": return { rows: w.ops.map((x) => ({ ...x })) };
      case "cases": return { rows: [{ n: o.cases ?? 0 }] };
      case "claims": return { rows: [{ listing_id: 606998, released: w.claimReleased }] };
      case "legs": return { rows: [{ ...w.legs }] };
      default: throw new Error(`unexpected SQL ${String(sql).slice(0, 40)}`);
    }
  } };
}
function applyAbort(w) {
  w.version += 1; w.status = "capture_failed"; w.reason = "TEST_ABORT_REQUESTED";
  w.tr.push({ version_after: w.version, from_state: "reservation_confirmed", to_state: "capture_failed", event_type: "TEST_ABORT_REQUESTED",
    event_id: IS.testAbortEventId(IID, PI, RID), reason_code: "TEST_ABORT_REQUESTED" });
  w.legs = { c: false, a: false };
  w.ops.push({ op_type: "hostaway.cancel_reservation", state: "pending", attempts: 0, dispatched: false, provider_key: null, payload_pi: null });
  w.ops.push({ op_type: "stripe.void_payment_intent", state: "pending", attempts: 0, dispatched: false, provider_key: IS.voidKey(IID, PI), payload_pi: PI });
  w.ops.push({ op_type: "alert.owner", state: "pending", attempts: 0, dispatched: false, provider_key: null, payload_pi: null });
}
const piObj = (w) => ({ object: "payment_intent", id: PI, livemode: false, status: w.pi, capture_method: "manual", amount: AMT, amount_received: 0,
  amount_capturable: w.pi === "canceled" ? 0 : AMT, currency: "usd", metadata: { mv_intent_id: IID, mv_payment_attempt_id: ATTEMPT },
  latest_charge: { object: "charge", id: "ch_FAKEabort01", payment_intent: PI, status: "succeeded", paid: true, captured: false, amount: AMT, amount_captured: 0,
    amount_refunded: 0, currency: "usd", livemode: false, payment_method_details: { card: { capture_before: CAPTURE_BEFORE / 1000 } } } });
const deepMerge = (a, b) => { const o = { ...a }; for (const [k, v] of Object.entries(b)) o[k] = v && typeof v === "object" && !Array.isArray(v) && a[k] && typeof a[k] === "object" ? deepMerge(a[k], v) : v; for (const [k, v] of Object.entries(b)) if (v === undefined) delete o[k]; return o; };
const resObj = (w, over = {}) => ({ id: Number(RID), listingMapId: 606998, channelId: 2000, arrivalDate: "2026-11-25", departureDate: "2026-11-26", totalPrice: 140,
  currency: "USD", status: w.res, customFieldValues: w.echoRef ? [{ customFieldId: C.refFieldId, value: REF }] : [], ...over });
function exchanges(w, o = {}) {
  const reply = (status, obj) => Promise.resolve({ status, contentType: "application/json", bytes: enc(obj) });
  const stripe = (req) => {
    w.calls.push(`S:${req.method} ${req.url.replace("https://api.stripe.com", "")}`);
    if (req.url.endsWith("/v1/account")) return reply(200, { object: "account", id: ACCT });
    if (req.method === "POST" && req.url.endsWith("/cancel")) {
      if (o.stripeCancel === "lost") return Promise.reject(new Error("socket reset"));
      w.pi = "canceled"; return reply(200, piObj(w));
    }
    if (o.piOverride) return reply(200, deepMerge(piObj(w), o.piOverride));
    return reply(200, piObj(w));
  };
  const hostaway = (req) => {
    w.calls.push(`H:${req.method} ${req.url.replace("https://api.hostaway.com", "")}`);
    if (o.hostawayStatus) return reply(o.hostawayStatus, { status: "fail", message: "unauthorized" });
    if (req.method === "GET" && req.url.includes("/v1/reservations?")) {
      w.lookups = (w.lookups ?? 0) + 1;
      if (o.lookup === "none" || new URL(req.url).searchParams.has("afterId")) return reply(200, { status: "success", result: [] });
      return reply(200, { status: "success", result: [{ ...resObj(w), customFieldValues: [{ customFieldId: C.refFieldId, value: REF }] }] });
    }
    if (req.method === "PUT") { if (o.hostawayCancel === "lost") return Promise.reject(new Error("socket reset")); w.res = "cancelled"; return reply(200, { status: "success", result: resObj(w) }); }
    return reply(200, { status: "success", result: resObj(w, o.resOverride) });
  };
  return { stripe, hostaway };
}
/** the fake worker: drives the REAL cleanup executors (→ real T → the runner fence → fake exchange) the way the accepted worker would */
function fakeWorker(w, o = {}) {
  return async (pool, { executors, intentId }) => {
    w.workerCalls += 1;
    assert.equal(intentId, IID);
    const sig = AbortSignal.timeout(5000);
    const actions = [];
    try {
      if (o.wrongLookup) await executors.lookupPage({ method: "GET", path: "/v1/reservations", query: { listingId: 606998, channelId: 2000, arrivalStartDate: "2026-11-24",
        arrivalEndDate: "2026-11-24", limit: 100, includeResources: 1 } }, { signal: sig });
      if (o.capture) await executors.cancelPaymentIntent("pi_OTHERpi000001", {}, { idempotencyKey: IS.voidKey(IID, PI), signal: sig });
      await executors.retrieveReservation({ method: "GET", path: `/v1/reservations/${RID}`, query: {} }, { signal: sig });
      const hc = await executors.cancelReservation({ method: "PUT", path: `/v1/reservations/${RID}/statuses/cancelled`, query: {}, body: { cancelledBy: "host" } }, { signal: sig });
      if (hc.httpStatus === 200) { const op = w.ops.find((x) => x.op_type === "hostaway.cancel_reservation"); op.state = "succeeded"; op.attempts = 1; op.dispatched = true; w.legs.c = true; actions.push("CANCEL_SUCCEEDED"); }
      if (o.twice) await executors.cancelReservation({ method: "PUT", path: `/v1/reservations/${RID}/statuses/cancelled`, query: {}, body: { cancelledBy: "host" } }, { signal: sig });
      await executors.retrieveAccount({ signal: sig }).catch(() => {});
      await executors.cancelPaymentIntent(PI, {}, { idempotencyKey: IS.voidKey(IID, PI), signal: sig });
      const v = w.ops.find((x) => x.op_type === "stripe.void_payment_intent"); v.state = "succeeded"; v.attempts = 1; v.dispatched = true; w.legs.a = true; actions.push("VOID_SUCCEEDED");
      if (w.legs.c && w.legs.a) { w.status = "cancelled"; w.claimReleased = true; w.version += 1; }
    } catch { actions.push("ESCALATE:EXECUTOR_FAILED"); }
    return { status: "worked", actions, delayMs: 0 };
  };
}
function fakeAbort(w, o = {}) {
  return async (pool, e, { env }) => {
    w.abortCalls += 1;
    assert.deepEqual(env, { VERCEL_ENV: "development", MV_E7_TEST_ABORT: "enabled" });
    assert.equal(e.intentId, IID); assert.equal(e.reservationId, RID); assert.equal(e.expectedVersion, VER); assert.equal(e.paymentIntentId, PI);
    if (o.abort === "throw") throw new Error("lost reply");
    if (o.abort === "unknown") { applyAbort(w); return { outcome: "REQUEST_OUTCOME_UNKNOWN", code: null, invocations: 1 }; }
    if (o.abort === "refused") return { outcome: "REFUSED", code: "TEST_ABORT_RESERVATION_HISTORY", invocations: 1 };
    applyAbort(w); if (o.badLineage) w.tr[w.tr.length - 1].event_id = "test-abort:other";
    return { outcome: "REQUESTED", code: null, invocations: 1 };
  };
}
function core(w, o = {}) {
  const tooling = { executeOperatorAbort: fakeAbort(w, o), buildAbortExpectation: (f) => Object.freeze({ ...f, planHash: "f".repeat(64) }),
    runCleanupStep: fakeWorker(w, o), loadIntent: async () => intentOf(w), voidKey: IS.voidKey, testAbortEventId: IS.testAbortEventId,
    createPhaseExecutors: EA.createPhaseExecutors, createStripeSend: T.createE7StripeTestSend, createHostawaySend: T.createE7HostawaySend,
    validateAdapterConfig: HR.validateAdapterConfig, unwrapEnvelope: HR.unwrapEnvelope, normalizeReservation: HR.normalizeReservation, lookupByRef: HR.lookupByRef,
    paymentIntentProofObservationV3: CP.paymentIntentProofObservationV3, stillAuthorizedV3Refusal: CP.stillAuthorizedV3Refusal, piCanceledProofV3: KP.piCanceledProofV3 };
  return E.runAbortCleanupCore({ plan: o.plan ?? plan(), pool: fakePool(w, o), tooling, exchanges: exchanges(w, o),
    credentials: { stripe: () => "sk_test_Fake1", hostaway: () => "synthetic-hostaway-token" }, sleep: async () => {}, runSignal: o.signal, monotonic: o.monotonic,
    clock: () => Date.UTC(2026, 10, 11, 21, 0, 0) + (w.tick = (w.tick ?? 0) + 1000) });
}
const writes = (w) => w.calls.filter((x) => /^(S:POST|H:PUT)/.test(x));

// ---------------------------------------------------------------------------------------------------------------------------------
test("A1 happy path (FAKE providers, REAL transports + executors): ONE abort, proofs before abort / before cleanup / after, exactly one Hostaway cancel + one Stripe void, full postcheck", async () => {
  const w = world();
  const r = await core(w);
  assert.equal(r.outcome, "CLEANED", JSON.stringify(r));
  assert.deepEqual([w.abortCalls, r.abortInvocations, r.hostawayCancelInvocations, r.stripeCancelInvocations], [1, 1, 1, 1]);
  assert.deepEqual(writes(w), [`H:PUT /v1/reservations/${RID}/statuses/cancelled`, `S:POST /v1/payment_intents/${PI}/cancel`]);
  assert.deepEqual(r.proofs, ["BEFORE_ABORT", "BEFORE_CLEANUP", "AFTER_CLEANUP"]);
  assert.equal(r.postcheck.ok, true); assert.equal(r.providerReadback, "OK");
  assert.deepEqual(r.writes, { capture: 0, refund: 0, create: 0, record: 0, notify: 0 });
  assert.equal(w.calls.some((x) => /capture|refund|charges|POST \/v1\/reservations$/.test(x)), false);
});

test("A2 fresh proofs gate the abort (ACCEPTED v3 PI proof): missing / non-integer / positive fields, metadata, charge binding / refund / capture / paid / capture_before, reservation, unprovable missing ref, Hostaway 401/403 → PROVIDER_PROOF_FAILED, ZERO abort, ZERO writes", async () => {
  for (const [label, o] of [["pi captured", { piOverride: { status: "succeeded", amount_received: AMT } }], ["pi amount", { piOverride: { amount: AMT + 1 } }],
    ["pi amount_received missing", { piOverride: { amount_received: undefined } }], ["pi amount_received non-integer", { piOverride: { amount_received: "0" } }],
    ["pi amount_received positive", { piOverride: { amount_received: 1 } }], ["pi amount_capturable short", { piOverride: { amount_capturable: AMT - 1 } }],
    ["pi metadata intent", { piOverride: { metadata: { mv_intent_id: "99999999-2222-4333-8444-555555555555" } } }], ["pi metadata attempt", { piOverride: { metadata: { mv_payment_attempt_id: "other" } } }],
    ["pi metadata missing", { piOverride: { metadata: undefined } }], ["pi automatic capture", { piOverride: { capture_method: "automatic" } }],
    ["charge unexpanded", { piOverride: { latest_charge: "ch_FAKEabort01" } }], ["charge other PI", { piOverride: { latest_charge: { payment_intent: "pi_OTHERpi000001" } } }],
    ["charge refunded", { piOverride: { latest_charge: { amount_refunded: 1 } } }], ["charge captured", { piOverride: { latest_charge: { captured: true } } }],
    ["charge not paid", { piOverride: { latest_charge: { paid: false } } }], ["charge capture_before mismatch", { piOverride: { latest_charge: { payment_method_details: { card: { capture_before: CAPTURE_BEFORE / 1000 + 1 } } } } }],
    ["charge livemode", { piOverride: { latest_charge: { livemode: true } } }],
    ["missing ref, lookup finds nothing (unsupported → refused BEFORE abort)", { echoRef: false, lookup: "none" }],
    ["reservation status modified (not the accepted active status)", { resOverride: { status: "modified" } }],
    ["reservation cancelled", { resOverride: { status: "cancelled" } }], ["reservation stay", { resOverride: { departureDate: "2026-11-27" } }],
    ["reservation total", { resOverride: { totalPrice: 141 } }], ["foreign ref", { resOverride: { customFieldValues: [{ customFieldId: C.refFieldId, value: "MV-OTHER01" }] } }],
    ["hostaway auth 401 (fail closed)", { hostawayStatus: 401 }], ["hostaway auth 403 (fail closed)", { hostawayStatus: 403 }]]) {
    const w = world(o);
    const r = await core(w, o);
    assert.equal(r.outcome, "PROVIDER_PROOF_FAILED", label); assert.match(r.code, /^BEFORE_ABORT:/, label);
    assert.deepEqual([w.abortCalls, w.workerCalls, writes(w).length], [0, 0, 0], label);
  }
});

test("A3 start refusals (read-only): already-applied abort (never re-requested blind), wrong version, protected id, open case, non-TEST DB, unexpected op, attempt state → ZERO provider calls, ZERO abort", async () => {
  const cases = [
    ["already applied", (w) => { applyAbort(w); }, "START_STATE_NOT_ELIGIBLE"],
    ["version moved", (w) => { w.version += 1; w.tr.push({ version_after: w.version, from_state: "x", to_state: "reservation_confirmed", event_type: "X", event_id: "x", reason_code: null }); }, "START_STATE_NOT_ELIGIBLE"],
    ["open case", null, "SCOPE_REFUSED", { cases: 1 }],
    ["db not test", null, "SCOPE_REFUSED", { env: "production" }],
    ["unexpected op type", (w) => { w.ops.push({ op_type: "hostaway.record_offline_charge", state: "pending", attempts: 0, dispatched: false }); }, "SCOPE_REFUSED"],
    ["capture dispatched", (w) => { w.ops.find((x) => x.op_type === "stripe.capture_payment_intent").dispatched = true; }, "SCOPE_REFUSED"],
    ["attempt escalated", (w) => { w.hx[0].state = "escalated"; }, "SCOPE_REFUSED"]
  ];
  for (const [label, mut, want, o = {}] of cases) {
    const w = world(); if (mut) mut(w);
    const r = await core(w, o);
    assert.equal(r.outcome, want, label);
    assert.deepEqual([w.abortCalls, w.calls.length], [0, 0], label);
  }
  assert.throws(() => plan({ reservationId: "70636076" }), /e7-test-abort-cleanup/, "protected id refused at plan");
  assert.throws(() => plan({ expectedVersion: 0 }));
});

test("A4 abort uncertainty / refusal STOPS: thrown or UNKNOWN → ABORT_OUTCOME_UNKNOWN (no retry, no worker, no send); REFUSED → ABORT_REFUSED; bad lineage → ABORT_POSTCHECK_MISMATCH", async () => {
  for (const [abort, want, extra] of [["throw", "ABORT_OUTCOME_UNKNOWN"], ["unknown", "ABORT_OUTCOME_UNKNOWN"], ["refused", "ABORT_REFUSED"], [null, "ABORT_POSTCHECK_MISMATCH", { badLineage: true }]]) {
    const w = world();
    const r = await core(w, { abort, ...extra });
    assert.equal(r.outcome, want, String(abort));
    assert.deepEqual([w.abortCalls, w.workerCalls, writes(w).length], [1, 0, 0], String(abort));
  }
});

test("A5 ambiguous sends STOP fail-closed: lost Hostaway cancel → HOSTAWAY_CANCEL_OUTCOME_UNKNOWN (no void sent); lost Stripe cancel → VOID_OUTCOME_UNKNOWN; second cancel refused at the boundary", async () => {
  let w = world(); let r = await core(w, { hostawayCancel: "lost" });
  assert.equal(r.outcome, "HOSTAWAY_CANCEL_OUTCOME_UNKNOWN"); assert.deepEqual(writes(w), [`H:PUT /v1/reservations/${RID}/statuses/cancelled`]);
  w = world(); r = await core(w, { stripeCancel: "lost" });
  assert.equal(r.outcome, "VOID_OUTCOME_UNKNOWN"); assert.equal(r.stripeCancelInvocations, 1); assert.equal(w.workerCalls, 1);
  w = world(); r = await core(w, { twice: true });
  assert.equal(r.outcome, "SECOND_SEND_REFUSED"); assert.equal(writes(w).filter((x) => x.startsWith("H:PUT")).length, 1);
});

test("A6 target-only fence: a lookup page for ANOTHER arrival date or a cancel of ANOTHER PaymentIntent never leaves the process", async () => {
  let w = world(); let r = await core(w, { wrongLookup: true });
  assert.equal(r.outcome, "ESCALATED"); assert.equal(w.calls.some((x) => x.includes("arrivalStartDate=2026-11-24")), false, "refused by the executor binding or the fence, never exchanged"); assert.equal(writes(w).length, 0);
  w = world(); r = await core(w, { capture: true });
  assert.equal(r.outcome, "ESCALATED"); assert.equal(writes(w).length, 0);
});

test("A7 stop latch: operator abort before start / admission deadline → no abort, no send", async () => {
  const ac = new AbortController(); ac.abort();
  let w = world(); let r = await core(w, { signal: ac.signal });
  assert.equal(r.outcome, "ABORTED"); assert.deepEqual([w.abortCalls, w.calls.length], [0, 0]);
  let t = 0; w = world(); r = await core(w, { monotonic: () => (t += 60_000) });
  assert.equal(r.outcome, "DEADLINE"); assert.equal(writes(w).length, 0);
});

test("A8 DB failure during precheck → DB_ERROR, nothing sent", async () => {
  const w = world(); const r = await core(w, { dbFailAt: 2 });
  assert.equal(r.outcome, "DB_ERROR"); assert.deepEqual([w.abortCalls, w.calls.length], [0, 0]);
});

// ---------------------------------------------------------------------------------------------------------------------------------
test("C1 code ceiling + closed execute: merged tooling bf44bf0d, executeEnabled false; plan carries exact pins and zero capture/refund/create/record/notify", () => {
  assert.equal(C.executeEnabled, false); assert.equal(C.toolingStatus, "MERGED"); assert.equal(C.toolingCommit, "bf44bf0da9b0f7b3fdf8dfbcfdb7136b36ad05df");
  const wf = readFileSync(join(ROOT, ".github/workflows/e7-test-abort-cleanup.yml"), "utf8");
  assert.deepEqual([...wf.matchAll(/^\s+ref: ([0-9a-f]{40})$/gm)].map((m) => m[1]), [C.toolingCommit, C.toolingCommit], "both jobs check out the pinned tooling");
  assert.equal((wf.match(/secrets\./g) || []).length, 3, "secrets appear only in the execute step");
  const p = plan();
  assert.deepEqual([p.intentId, p.paymentIntentId, p.reservationId, p.expectedVersion, p.approvalRef], [IID, PI, RID, VER, "SYNTHETIC-test-abort-cleanup"]);
  assert.deepEqual(p.writes, { abortEvent: 1, hostawayCancelMax: 1, stripeCancelMax: 1, capture: 0, refund: 0, create: 0, record: 0, notify: 0, account: 0, keys: 0 });
  assert.notEqual(E.buildPlan(C, { approvalRef: "a", intentId: IID, paymentIntentId: PI, reservationId: RID, expectedVersion: VER, runnerDigest: "0".repeat(64) }).planHash,
    E.buildPlan(C, { approvalRef: "a", intentId: IID, paymentIntentId: PI, reservationId: RID, expectedVersion: VER + 1, runnerDigest: "0".repeat(64) }).planHash);
});

test("C2 closure: the scanned transitive relative imports of the runner's tooling roots == CONSTANTS.closure; framed digest == the pin", async () => {
  const roots = ["lib/booking-db/compensation-worker.js", "lib/booking-db/repo.js", "lib/checkout/intent-state.js", "scripts/e7-connected/executor-adapters.mjs",
    "scripts/e7-connected/http-transports.mjs", "scripts/e7-connected/real-exchange.mjs", "lib/booking-db/pool.js", "lib/hostaway-reservations.js",
    "scripts/e7-operator/test-abort.mjs", "scripts/e7-connected/probe-env-preflight.mjs"];
  const seen = new Set(); const st = [...roots];
  while (st.length) {
    const f = st.pop(); if (seen.has(f)) continue; seen.add(f);
    for (const m of readFileSync(join(TOOLING, f), "utf8").matchAll(/(?:import|export)\s[^"'`;]*?from\s*["'](\.[^"']+)["']|import\(\s*["'](\.[^"']+)["']\s*\)/g)) st.push(normalize(join(dirname(f), m[1] || m[2])));
  }
  assert.deepEqual(["package.json", "package-lock.json", ...[...seen].sort()], [...C.closure]);
  assert.equal(await E.framedDigest(TOOLING, C.closure, E.CLOSURE_DIGEST_PREFIX), C.closureDigest);
});

const PROC = { versions: { node: "22.22.0" }, platform: "linux", execArgv: [], getuid: () => 1001 };
const okChild = async () => ({ status: 0, signal: null, stdout: "# tests 3\n# pass 3\n# fail 0\n", truncated: false, spawnFailed: false });
const realEnv = (over = {}) => ({ E7_TOOLING_DIR: TOOLING, E7_APPROVAL_REF: "label-1", E7_INTENT_ID: IID, E7_PAYMENT_INTENT_ID: PI, E7_RESERVATION_ID: RID, E7_EXPECTED_VERSION: String(VER), ...over });

test("H1 hosted: preflight (no secrets) passes on the pinned closure; any secret outside execute is refused; partial / invalid inputs refused", async () => {
  let x = await E.runHosted({ mode: "preflight", env: { E7_TOOLING_DIR: TOOLING }, proc: PROC, wrapperDir: ROOT, deps: { spawnChild: okChild } });
  assert.equal(x.result.code, "PREFLIGHT_OK_SYNTHETIC_ONLY", JSON.stringify(x.result));
  x = await E.runHosted({ mode: "preflight", env: realEnv(), proc: PROC, wrapperDir: ROOT, deps: { spawnChild: okChild } });
  assert.equal(x.result.code, "PREFLIGHT_OK_REAL_PLAN");
  for (const k of ["E7_STRIPE_TEST_KEY", "E7_HOSTAWAY_TOKEN", "E7_DEV_BOOKING_DATABASE_URL"]) {
    x = await E.runHosted({ mode: "preflight", env: realEnv({ [k]: "x" }), proc: PROC, wrapperDir: ROOT, deps: { spawnChild: okChild } });
    assert.equal(x.result.code, "ATC_SECRET_SCOPE_VIOLATION", k);
  }
  x = await E.runHosted({ mode: "preflight", env: realEnv({ E7_RESERVATION_ID: "" }), proc: PROC, wrapperDir: ROOT, deps: { spawnChild: okChild } });
  assert.equal(x.result.code, "ATC_INPUT_INCOMPLETE");
  x = await E.runHosted({ mode: "preflight", env: realEnv({ E7_RESERVATION_ID: "70636076" }), proc: PROC, wrapperDir: ROOT, deps: { spawnChild: okChild } });
  assert.equal(x.result.code, "ATC_INPUT_INVALID");
});

test("H2 hosted: verify / execute are CLOSED in code (even with complete inputs and secrets) — no DB pool, no tooling import, no provider exchange", async () => {
  let imported = 0;
  for (const mode of ["verify", "execute"]) {
    const x = await E.runHosted({ mode, env: realEnv({ GITHUB_REF: "refs/heads/main", E7_EXPECTED_PLAN_HASH: "a".repeat(64), E7_EXPECTED_CLOSURE_DIGEST: C.closureDigest,
      E7_EXPECTED_RUNNER_DIGEST: "b".repeat(64), E7_STRIPE_TEST_KEY: "sk_test_x", E7_HOSTAWAY_TOKEN: "t", E7_DEV_BOOKING_DATABASE_URL: "postgres://x" }),
      proc: PROC, wrapperDir: ROOT, deps: { importTooling: async () => { imported += 1; throw new Error("no"); } } });
    assert.equal(x.result.code, mode === "verify" ? "ATC_SECRET_SCOPE_VIOLATION" : "ATC_EXECUTE_CLOSED", mode);
    assert.equal(x.exitCode, 1);
  }
  const x = await E.runHosted({ mode: "verify", env: realEnv({ GITHUB_REF: "refs/heads/main" }), proc: PROC, wrapperDir: ROOT, deps: {} });
  assert.equal(x.result.code, "ATC_EXECUTE_CLOSED");
  assert.equal(imported, 0);
});

test("H3 hosted: a drifted tooling byte is refused before any import (closure digest)", async () => {
  const d = mkdtempSync(join(tmpdir(), "atc-"));
  try {
    for (const f of C.closure) { cpSync(join(TOOLING, f), join(d, f), { recursive: true }); }
    writeFileSync(join(d, "lib/booking-db/test-abort.js"), `${readFileSync(join(TOOLING, "lib/booking-db/test-abort.js"), "utf8")}\n// drift\n`);
    const x = await E.runHosted({ mode: "preflight", env: { E7_TOOLING_DIR: d }, proc: PROC, wrapperDir: ROOT, deps: { spawnChild: okChild, importEnv: async () => C1 } });
    assert.equal(x.result.code, "ATC_SOURCE_MISMATCH");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("S1 static: the runner imports node built-ins only; no capture / refund / create / record / notify call text", () => {
  const src = readFileSync(join(ROOT, "scripts/e7-test-abort-cleanup.mjs"), "utf8");
  const imps = [...src.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
  assert.ok(imps.every((m) => m.startsWith("node:")), imps.join(","));
  assert.equal(/paymentIntents\.capture|refunds|createReservation|createOfflineCharge|guest\.notify\(|sendNotification/.test(src), false);
});

test("A9 legs: only NULL/NULL before the abort; partially settled / true / false pre-abort pairs refused with ZERO provider calls; post-abort must be false/false", async () => {
  for (const legs of [{ c: false, a: false }, { c: true, a: null }, { c: null, a: true }, { c: true, a: true }, { c: false, a: null }]) {
    const w = world(); w.legs = legs;
    const r = await core(w);
    assert.deepEqual([r.outcome, r.code], ["SCOPE_REFUSED", "LEGS_UNEXPECTED"], JSON.stringify(legs));
    assert.deepEqual([w.abortCalls, w.calls.length], [0, 0]);
  }
  const w = world();
  const r = await core(w);
  assert.equal(r.outcome, "CLEANED", "control: NULL/NULL start → cleaned");
});

test("A10 missing ref by id + the accepted by-ref lookup finds exactly this reservation → supported; proofs include the lookup; one cancel + one void", async () => {
  const w = world({ echoRef: false });
  const r = await core(w, { echoRef: false });
  assert.equal(r.outcome, "CLEANED", JSON.stringify(r));
  assert.ok(r.lookupPages >= 2, "lookup pages were read through the fence"); assert.ok(w.lookups >= 2);
  assert.deepEqual([r.hostawayCancelInvocations, r.stripeCancelInvocations], [1, 1]);
});

test("A11 DB budget counts EVERY statement on the one pool (pool.query + connected client .query), and refuses past the ceiling", async () => {
  const w = world(); const base = fakePool(w);
  let clientQ = 0;
  const pool = { query: (...a) => base.query(...a), connect: async () => ({ query: async () => { clientQ += 1; return { rows: [] }; }, release() {} }) };
  const tooling = { executeOperatorAbort: async (p) => { const cl = await p.connect(); await cl.query("BEGIN"); await cl.query("SELECT 1"); await cl.query("COMMIT"); cl.release(); applyAbort(w); return { outcome: "REQUESTED", invocations: 1 }; },
    buildAbortExpectation: (f) => Object.freeze({ ...f, planHash: "f".repeat(64) }), runCleanupStep: async (p) => { for (let i = 0; i < 10000; i++) await p.query("/*e7atc:instance*/"); },
    loadIntent: async (p) => { await p.query("/*e7atc:instance*/"); return intentOf(w); }, voidKey: IS.voidKey, testAbortEventId: IS.testAbortEventId,
    createPhaseExecutors: EA.createPhaseExecutors, createStripeSend: T.createE7StripeTestSend, createHostawaySend: T.createE7HostawaySend,
    validateAdapterConfig: HR.validateAdapterConfig, unwrapEnvelope: HR.unwrapEnvelope, normalizeReservation: HR.normalizeReservation, lookupByRef: HR.lookupByRef,
    paymentIntentProofObservationV3: CP.paymentIntentProofObservationV3, stillAuthorizedV3Refusal: CP.stillAuthorizedV3Refusal, piCanceledProofV3: KP.piCanceledProofV3 };
  const r = await E.runAbortCleanupCore({ plan: plan(), pool, tooling, exchanges: exchanges(w), credentials: { stripe: () => "sk_test_Fake1", hostaway: () => "t" },
    sleep: async () => {}, clock: () => Date.UTC(2026, 10, 11, 21, 0, 0) });
  assert.equal(clientQ, 3, "client statements reached the real client"); 
  assert.equal(r.dbQueries, C.budgets.dbQueries, "counted up to the ceiling (client + pool statements, once each)");
  assert.ok(r.dbBudgetRefused >= 1); assert.notEqual(r.outcome, "CLEANED");
});

// =================================================================================================================================
// OPT-IN INTEGRATION (E7_ATC_DB_TESTS=1; tooling with its pinned pg; PG_BIN): the REAL merged executeOperatorAbort, runCleanupStep, repo,
// transports and executor adapters on a disposable PostgreSQL (tooling test/db/harness.mjs). FAKE exchanges ONLY. The reconciled_found
// lineage (the r02 shape: ref-not-echoed create → lease expiry → RECOVER_INTERRUPTED → by-ref + by-id found_active → RECONCILED) is built
// through the accepted APIs only. The hosted preflight child never sets E7_ATC_DB_TESTS (no dependency, no database there).
if (process.env.E7_ATC_DB_TESTS === "1") {
  const [{ startMigratedDatabase }, F, R, O, W, OA] = await Promise.all([tool("test/db/harness.mjs"), tool("test/db/fixtures.mjs"), tool("lib/booking-db/repo.js"),
    tool("lib/booking-db/operations.js"), tool("lib/booking-db/compensation-worker.js"), tool("scripts/e7-operator/test-abort.mjs")]);
  const db = await startMigratedDatabase();
  after(async () => { await db.close(); });
  const LIST = 606998; const MINUTE = 60000;
  const addD = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
  let stayK = 0;
  const realTooling = { executeOperatorAbort: OA.executeOperatorAbort, buildAbortExpectation: OA.buildAbortExpectation, runCleanupStep: W.runCleanupStep,
    loadIntent: R.loadIntent, voidKey: IS.voidKey, testAbortEventId: IS.testAbortEventId, createPhaseExecutors: EA.createPhaseExecutors,
    createStripeSend: T.createE7StripeTestSend, createHostawaySend: T.createE7HostawaySend, validateAdapterConfig: HR.validateAdapterConfig,
    unwrapEnvelope: HR.unwrapEnvelope, normalizeReservation: HR.normalizeReservation, lookupByRef: HR.lookupByRef,
    paymentIntentProofObservationV3: CP.paymentIntentProofObservationV3, stillAuthorizedV3Refusal: CP.stillAuthorizedV3Refusal, piCanceledProofV3: KP.piCanceledProofV3 };
  const readEv = async (intentId, { opType, ref, at, kind, externalRef, status, observed }) => {
    const opId = await O.requestRead(db.app, intentId, opType, ref, { now: at });
    assert.equal((await O.claimNextOperation(db.app, { workerId: "w-read", now: at, intentId, opId })).id, opId);
    F.ok(await O.completeOperation(db.app, opId, { workerId: "w-read", now: at, outcome: { status: "succeeded" } }));
    F.ok(await O.recordProviderEvidence(db.app, { readOpId: opId, kind, externalRef, status, observed }));
  };
  /** the r02-shaped recovered lineage via the accepted APIs (same construction as the merged guard's D10 fixture) */
  async function reconciled() {
    stayK += 1;
    const stay = { listingId: LIST, currency: "USD", from: addD("2027-03-01", 4 * stayK), to: addD("2027-03-01", 4 * stayK + 1) };
    const p = await F.pending(db.app, stay);
    const piId = `pi_ATCint${String(stayK).padStart(8, "0")}`;
    F.ok(await R.applyEvent(db.app, p.id, F.authEvent(p.sessionId, piId, 5, { currency: "usd" }), { now: F.at(5), actor: "webhook" }));
    F.ok(await R.applyEvent(db.app, p.id, { type: "RESERVATION_STARTED", workerId: "w1", recheck: { bookable: true, priceSame: true } }, { now: F.at(6), actor: "worker", workerId: "w1" }));
    F.ok(await R.applyEvent(db.app, p.id, { type: "RESERVATION_DISPATCHED", workerId: "w1" }, { now: F.at(6), actor: "worker", workerId: "w1" }));
    const rid = F.nextReservationId() + 71000000;
    const ref = (await R.loadIntent(db.app, p.id)).ref;
    const op = await F.claimOp(db.app, p.id, "hostaway.create_reservation", F.at(6));
    await R.recordHostawayCreateResult(db.app, p.id, { httpStatus: 201, reservation: { ...F.reservationFor(stay, rid), bookingRef: null } }, { now: F.at(7) });
    F.ok(await O.completeOperation(db.app, op.id, { workerId: "w1", now: F.at(7), outcome: { status: "succeeded", resultRef: rid } }));
    F.ok(await R.applyEvent(db.app, p.id, { type: "RECOVER_INTERRUPTED", id: `recover:${p.id}:atc` }, { now: F.at(9), actor: "reconciler" }));
    const i0 = await R.loadIntent(db.app, p.id);
    const observed = { reservationId: String(rid), listingId: LIST, from: stay.from, to: stay.to, totalMinor: i0.price.finalTotalMinor, currency: "USD", status: "new" };
    const lk = await O.claimNextOperation(db.app, { workerId: "w-rec", now: F.at(10), intentId: p.id, opTypes: ["hostaway.lookup_reservation"] });
    F.ok(await O.completeOperation(db.app, lk.id, { workerId: "w-rec", now: F.at(10), outcome: { status: "succeeded" } }));
    F.ok(await O.recordProviderEvidence(db.app, { readOpId: lk.id, kind: "hostaway_reservation", externalRef: String(rid), status: "found_active", observed: { ...observed, bookingRef: ref, matchCount: 1 } }));
    await readEv(p.id, { opType: "hostaway.retrieve_reservation", ref: String(rid), at: F.at(10), kind: "hostaway_reservation", externalRef: String(rid), status: "found_active", observed });
    F.ok(await R.applyEvent(db.app, p.id, { type: "RECONCILED_RESERVATION_FOUND", id: `recon:${p.id}:atc`, reservation: F.reservationFor(stay, rid) }, { now: F.at(11), actor: "reconciler" }));
    const i = await R.loadIntent(db.app, p.id);
    assert.equal(i.status, "reservation_confirmed");
    const att = (await db.app.query("SELECT state FROM booking.hostaway_reservation_attempts WHERE intent_id = $1", [p.id])).rows;
    assert.deepEqual(att.map((x) => x.state), ["reconciled_found"]);
    const pa = (await db.app.query("SELECT id::text AS id FROM booking.payment_attempts WHERE intent_id = $1 AND status = 'completed'", [p.id])).rows[0].id;
    return { id: p.id, piId, rid: String(rid), stay, ref, intent: i, attemptId: pa };
  }
  function pgWorld(a, o = {}) {
    const w = { calls: [], pi: "requires_capture", res: "new", refunded: 0 };
    const enc2 = (x) => new TextEncoder().encode(JSON.stringify(x));
    const reply = (status, x) => Promise.resolve({ status, contentType: "application/json", bytes: enc2(x) });
    const pi = () => ({ object: "payment_intent", id: a.piId, livemode: false, status: w.pi, capture_method: "manual", amount: a.intent.payment.amountMinor, amount_received: 0,
      amount_capturable: w.pi === "requires_capture" ? a.intent.payment.amountMinor : 0, currency: "usd", metadata: { mv_intent_id: a.id, mv_payment_attempt_id: a.attemptId },
      latest_charge: { object: "charge", id: `ch_ATC${a.id.slice(0, 8)}`, payment_intent: a.piId, status: "succeeded", paid: true, captured: false,
        amount: a.intent.payment.amountMinor, amount_captured: 0, amount_refunded: w.refunded, currency: "usd", livemode: false,
        payment_method_details: { card: { capture_before: a.intent.payment.captureBefore / 1000 } } } });
    const res = () => ({ id: Number(a.rid), listingMapId: LIST, channelId: 2000, arrivalDate: a.stay.from, departureDate: a.stay.to, totalPrice: a.intent.price.finalTotalMinor / 100,
      currency: "USD", status: w.res, customFieldValues: o.echoRef === false ? [] : [{ customFieldId: C.refFieldId, value: a.ref }] });
    w.stripe = (req) => {
      w.calls.push(`S ${req.method} ${req.url.replace("https://api.stripe.com", "")}`);
      if (req.url.endsWith("/v1/account")) return reply(200, { object: "account", id: ACCT });
      if (req.method === "POST") { if (o.voidLost) return Promise.reject(new Error("reset")); w.pi = "canceled"; return reply(200, pi()); }
      return reply(200, pi());
    };
    w.hostaway = (req) => {
      w.calls.push(`H ${req.method} ${req.url.replace("https://api.hostaway.com", "")}`);
      if (req.method === "PUT") { if (o.cancelLost) return Promise.reject(new Error("reset")); w.res = "cancelled"; return reply(200, { status: "success", result: res() }); }
      if (req.url.includes("/v1/reservations?")) {
        if (new URL(req.url).searchParams.has("afterId") || o.lookupNone) return reply(200, { status: "success", result: [] });
        return reply(200, { status: "success", result: [{ ...res(), customFieldValues: [{ customFieldId: C.refFieldId, value: a.ref }] }] });
      }
      return reply(200, { status: "success", result: res() });
    };
    return w;
  }
  const pgRun = (a, w, extra = {}) => {
    const clk = { t: F.at(20) };
    return E.runAbortCleanupCore({ plan: E.buildPlan(C, { approvalRef: "SYNTHETIC-atc-pg", intentId: a.id, paymentIntentId: a.piId, reservationId: a.rid,
      expectedVersion: a.intent.version, runnerDigest: "0".repeat(64) }).plan, pool: db.app, tooling: realTooling, exchanges: { stripe: w.stripe, hostaway: w.hostaway },
      credentials: { stripe: () => "sk_test_Fake1", hostaway: () => "synthetic-hostaway-token" }, clock: () => (clk.t += 1000), sleep: async (ms) => { clk.t += Math.max(ms, MINUTE); }, ...extra });
  };
  const dbSnap = async (id) => ({ st: (await db.app.query("SELECT state, version, settlement_reservation_cancelled AS c, settlement_authorization_settled AS a FROM booking.intents WHERE id = $1", [id])).rows[0],
    ops: (await db.app.query("SELECT op_type, state, attempts, (dispatched_at IS NOT NULL) AS d FROM booking.external_operations WHERE intent_id = $1 ORDER BY op_type, created_at", [id])).rows,
    claim: (await db.app.query("SELECT (released_at IS NOT NULL) AS released FROM booking.inventory_claims WHERE intent_id = $1", [id])).rows });

  test("I1 PG integration (REAL operator + worker + transports + executors; FAKE exchanges): r02-shaped reconciled_found → EXACTLY 1 abort + 1 cancel + 1 void, strict v3 PI proofs, both legs, claim released, no capture / refund / record / notify", async () => {
    for (const echoRef of [true, false]) {
      const a = await reconciled();
      const pre = await dbSnap(a.id);
      assert.deepEqual([pre.st.c, pre.st.a], [null, null], "actual pre-abort legs are NULL/NULL (ROOT F1)");
      const w = pgWorld(a, { echoRef });
      const r = await pgRun(a, w);
      assert.equal(r.outcome, "CLEANED", `${echoRef ? "ref echoed" : "ref NOT echoed + lookup"}: ${JSON.stringify(r)}`);
      assert.deepEqual([r.abortInvocations, r.hostawayCancelInvocations, r.stripeCancelInvocations], [1, 1, 1]);
      // the accepted worker settles the authorization leg first, then the reservation leg (observed order, real worker)
      assert.deepEqual(w.calls.filter((x) => /^(S POST|H PUT)/.test(x)), [`S POST /v1/payment_intents/${a.piId}/cancel`, `H PUT /v1/reservations/${a.rid}/statuses/cancelled`]);
      const s = await dbSnap(a.id);
      assert.deepEqual([s.st.state, s.st.c, s.st.a, s.claim[0].released], ["cancelled", true, true, true]);
      const cap = s.ops.filter((x) => x.op_type === "stripe.capture_payment_intent");
      assert.deepEqual(cap.map((x) => [x.attempts, x.d]), [[0, false]], "capture never dispatched");
      for (const t of ["guest.notify", "alert.owner", "hostaway.record_offline_charge"]) for (const x of s.ops.filter((y) => y.op_type === t)) assert.deepEqual([x.attempts, x.d], [0, false], t);
      assert.equal(w.calls.some((x) => /capture|refund|guestPayments/.test(x)), false);
      if (!echoRef) assert.ok(r.lookupPages >= 2, "the not-echoed path used the fenced lookup");
      console.log(`# I1 ${echoRef ? "echoed" : "not-echoed"}: dbQueries=${r.dbQueries} exchanges=${r.exchanges} hostawayReads=${r.hostawayReads} lookupPages=${r.lookupPages} piReads=${r.piReads} accountReads=${r.accountReads} steps=${r.steps}`);
      assert.ok(r.dbQueries > 0 && r.dbQueries <= C.budgets.dbQueries);
    }
  });

  test("I2 PG integration: ambiguous sends STOP (lost void → no Hostaway cancel sent; lost Hostaway cancel → stop, ONE PUT) with exactly one send each; unprovable missing ref → refused BEFORE abort (zero DB change)", async () => {
    let a = await reconciled(); let w = pgWorld(a, { cancelLost: true }); let r = await pgRun(a, w);
    assert.equal(r.outcome, "HOSTAWAY_CANCEL_OUTCOME_UNKNOWN", JSON.stringify(r));
    assert.deepEqual(w.calls.filter((x) => /^(S POST|H PUT)/.test(x)), [`S POST /v1/payment_intents/${a.piId}/cancel`, `H PUT /v1/reservations/${a.rid}/statuses/cancelled`]);
    a = await reconciled(); w = pgWorld(a, { voidLost: true }); r = await pgRun(a, w);
    assert.equal(r.outcome, "VOID_OUTCOME_UNKNOWN", JSON.stringify(r)); assert.equal(r.stripeCancelInvocations, 1);
    assert.deepEqual(w.calls.filter((x) => /^(S POST|H PUT)/.test(x)), [`S POST /v1/payment_intents/${a.piId}/cancel`], "no Hostaway cancel after an uncertain void");
    a = await reconciled(); const before = await dbSnap(a.id); w = pgWorld(a, { echoRef: false, lookupNone: true }); r = await pgRun(a, w);
    assert.equal(r.outcome, "PROVIDER_PROOF_FAILED"); assert.match(r.code, /REF_UNPROVABLE/); assert.equal(r.abortInvocations, 0);
    assert.deepEqual(await dbSnap(a.id), before, "zero DB change");
  });

  test("I3 PG integration: a second run after a CLEANED run refuses read-only (abort never re-requested); a run at a stale pinned version refuses", async () => {
    const a = await reconciled(); let w = pgWorld(a); let r = await pgRun(a, w);
    assert.equal(r.outcome, "CLEANED");
    w = pgWorld(a); r = await pgRun(a, w);
    assert.deepEqual([r.outcome, r.abortInvocations, w.calls.length], ["START_STATE_NOT_ELIGIBLE", 0, 0]);
    const b = await reconciled(); const stale = { ...b, intent: { ...b.intent, version: b.intent.version - 1 } };
    w = pgWorld(b); r = await pgRun(stale, w);
    assert.deepEqual([r.outcome, r.code, r.abortInvocations, w.calls.length], ["START_STATE_NOT_ELIGIBLE", "VERSION_NOT_PINNED", 0, 0]);
  });
}
