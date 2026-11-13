// E7 captured-TEST cleanup — the ISOLATED executor phase (scripts/e7-connected/test-cleanup-executors.mjs) + the Stripe TEST cleanup transport
// (scripts/e7-connected/test-cleanup-transports.mjs) over the REUSED accepted Hostaway transport. OFFLINE unit tests: no PG, no network, no provider.
// LABELS: every `exchange` is an INJECTED FAKE recording invocations (credentials redacted); every credential is SYNTHETIC. The accepted
// executor-adapters.mjs / http-transports.mjs are asserted UNCHANGED in behaviour (no refund key / op anywhere).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createTestCleanupExecutors, PHASE_KEYS, BINDING_KEYS, ExecutorRefusal, ExecutorTransportFailure, REFUND_LIST_LIMIT, TEST_CLEANUP_LISTING_ID, DIRECT_CHANNEL_ID, LOOKUP_PAGE_LIMIT }
  from "../scripts/e7-connected/test-cleanup-executors.mjs";
import { createE7StripeTestCleanupSend, E7TransportError, STRIPE_OPS, ERROR_CODES as CLEANUP_ERROR_CODES } from "../scripts/e7-connected/test-cleanup-transports.mjs";
import { createE7HostawaySend, createE7StripeTestSend, ERROR_CODES } from "../scripts/e7-connected/http-transports.mjs";
import { createPhaseExecutors, PHASES, PHASE_KEYS as ACCEPTED_PHASE_KEYS, DIRECT_CHANNEL_ID as A_CHANNEL, LOOKUP_PAGE_LIMIT as A_LIMIT } from "../scripts/e7-connected/executor-adapters.mjs";
import { TEST_CLEANUP_EXECUTOR_KEYS, TEST_CLEANUP_WORKER_LIMITS } from "../lib/booking-db/cleanup-worker.js";
import { TEST_CLEANUP_LISTINGS } from "../lib/booking-db/test-cleanup.js";
import { refundKey } from "../lib/checkout/intent-state.js";
import { PROTECTED_HOSTAWAY_RESERVATION_IDS } from "../lib/checkout/compensation-proof.js";

let netAttempts = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { netAttempts += 1; throw new Error("network refused (offline cleanup executor suite)"); };
after(() => { globalThis.fetch = realFetch; assert.equal(netAttempts, 0, "no network attempt"); });

// ---- SYNTHETIC fixtures ---------------------------------------------------------------------------------------------------------
const HTOKEN = "synthetic-hostaway-token"; const SKEY = "sk_test_Fake1"; const VERSION = "2099-01-01.synthetic";
const ACCT = "acct_1SyntheticCleanup"; const PI = "pi_test_syntheticCleanup1"; const CH = "ch_test_syntheticCleanup1"; const RE = "re_test_syntheticCleanup1";
const INTENT = "00000000-0000-4000-8000-0000000000c9"; const OPID = "00000000-0000-4000-8000-0000000000d1"; const KEY = refundKey(INTENT, 1);
const L = TEST_CLEANUP_LISTING_ID; const RID = "6100009"; const REF = "MV-CLNUP001"; const IN = "2027-06-04"; const OUT = "2027-06-06"; const AMT = 576000;
const enc = (v) => new TextEncoder().encode(typeof v === "string" ? v : JSON.stringify(v));
const sig = () => new AbortController().signal;
const ok = (obj, status = 200) => ({ status, contentType: "application/json", bytes: enc(obj) });
const B = Object.freeze({ listingId: L, arrivalDate: IN, departureDate: OUT, ref: REF, reservationId: RID, accountId: ACCT, paymentIntentId: PI, chargeId: CH, amountMinor: AMT, refundIdempotencyKey: KEY, refundOpId: OPID });
const ACCOUNT = Object.freeze({ id: ACCT, object: "account", country: "US" });
const PIOBJ = (o = {}) => ({ id: PI, object: "payment_intent", livemode: false, status: "succeeded", amount: AMT, ...o });
const REFUND = (o = {}) => ({ id: RE, object: "refund", payment_intent: PI, charge: CH, amount: AMT, currency: "usd", status: "succeeded", created: 1800000000, metadata: { mv_refund_op: OPID, mv_refund_key: KEY }, ...o });
const LISTR = (data = [REFUND()], has_more = false) => ({ object: "list", url: "/v1/refunds", has_more, data });

function fakeExchange(reply = () => ok({ status: "success", result: {} })) {
  const log = [];
  const exchange = async (req) => {
    log.push({ method: req.method, url: req.url, headers: { ...req.headers, Authorization: req.headers.Authorization ? "<redacted>" : undefined }, body: req.body, auth: req.headers.Authorization,
      signalIsGenuine: req.signal instanceof AbortSignal });
    return reply(req, log.length);
  };
  return { exchange, log };
}
const stripeT = (reply, extra = {}) => { const f = fakeExchange(reply); let calls = 0;
  const r = createE7StripeTestCleanupSend({ exchange: f.exchange, credential: () => { calls += 1; return SKEY; }, accountId: ACCT, apiVersion: VERSION, ...extra });
  assert.equal(r.ok, true, r.code); return { send: r.transport.send, log: f.log, creds: () => calls }; };
const hostawayT = (reply) => { const f = fakeExchange(reply); const r = createE7HostawaySend({ exchange: f.exchange, credential: () => HTOKEN }); assert.equal(r.ok, true); return { send: r.transport.send, log: f.log }; };
const codeOf = async (p) => { try { await p; return "RESOLVED"; } catch (e) { assert.ok(e instanceof E7TransportError, String(e)); return e.code; } };
const codeOfAccepted = async (p) => { try { await p; return "RESOLVED"; } catch (e) { assert.equal(e.name, "E7TransportError", String(e)); return e.code; } };   // the accepted module's own class
const refusalOf = async (p) => { try { await p; return "RESOLVED"; } catch (e) { if (e instanceof ExecutorRefusal) return `REFUSED:${e.code}`; if (e instanceof ExecutorTransportFailure) return `TRANSPORT:${e.code}`; throw e; } };
/** executors over recording fake transports (internal envelopes recorded) */
function make(binding = B) {
  const hs = []; const ss = [];
  const r = createTestCleanupExecutors({ binding, hostaway: { send: async (req, o) => { hs.push({ req, signalIsGenuine: o.signal instanceof AbortSignal }); return { httpStatus: 200, json: { status: "success", result: { id: Number(RID), status: "cancelled" } } }; } },
    stripe: { send: async (call, o) => { ss.push({ call, signalIsGenuine: o.signal instanceof AbortSignal }); return call.op === "refunds.list" ? LISTR() : call.op.startsWith("refunds") ? REFUND() : call.op === "accounts.retrieve" ? ACCOUNT : PIOBJ(); } } });
  assert.equal(r.ok, true, r.code);
  return { ex: r.executors, hs, ss };
}

// =================================================================================================================================
test("X1. factory: EXACT key set = the cleanup worker's gate; exact binding keys; listing 606998 only; protected id / live-shaped values refused; transports mandatory", () => {
  const { ex } = make();
  assert.deepEqual(Object.keys(ex).sort(), [...TEST_CLEANUP_EXECUTOR_KEYS].sort());
  assert.deepEqual([...PHASE_KEYS].sort(), [...TEST_CLEANUP_EXECUTOR_KEYS].sort());
  assert.ok(Object.isFrozen(ex));
  assert.deepEqual(BINDING_KEYS, [...BINDING_KEYS].sort());
  assert.deepEqual([TEST_CLEANUP_LISTING_ID, TEST_CLEANUP_LISTINGS[0].listingId, REFUND_LIST_LIMIT, TEST_CLEANUP_WORKER_LIMITS.listLimit, DIRECT_CHANNEL_ID, A_CHANNEL, LOOKUP_PAGE_LIMIT, A_LIMIT],
    [606998, 606998, 100, 100, 2000, 2000, 100, 100], "constants equal the accepted / worker values");
  const bad = [[{ ...B, listingId: 603566 }, "pilot listing"], [{ ...B, listingId: 890001 }, "other listing"], [{ ...B, reservationId: PROTECTED_HOSTAWAY_RESERVATION_IDS[0] }, "protected"],
    [{ ...B, reservationId: null }, "unbound reservation"], [{ ...B, refundIdempotencyKey: refundKey(INTENT, 2) }, "attempt 2 key"], [{ ...B, refundIdempotencyKey: `rf:${INTENT}:1` }, "old key family"],
    [{ ...B, refundOpId: "op-1" }, "op id not uuid"], [{ ...B, chargeId: PI }, "charge id"], [{ ...B, amountMinor: 0 }, "amount"], [{ ...B, amountMinor: 1.5 }, "amount fraction"],
    [{ ...B, accountId: "sk_test_x" }, "account"], [{ ...B, voidIdempotencyKey: "void:x" }, "extra key"], [(({ chargeId, ...rest }) => rest)(B), "missing key"], [{ ...B, arrivalDate: OUT, departureDate: IN }, "dates"]];
  for (const [b, label] of bad) assert.equal(createTestCleanupExecutors({ binding: b, hostaway: { send() {} }, stripe: { send() {} } }).code, "BINDING_INVALID", label);
  assert.equal(createTestCleanupExecutors({ binding: B, hostaway: { send() {} } }).code, "OPTIONS_INVALID");
  assert.equal(createTestCleanupExecutors({ binding: B, hostaway: {}, stripe: { send() {} } }).code, "TRANSPORT_INVALID");
  assert.equal(createTestCleanupExecutors({ binding: B, hostaway: { send() {} }, stripe: { send: 1 } }).code, "TRANSPORT_INVALID");
  assert.equal(createTestCleanupExecutors(null).code, "OPTIONS_INVALID");
  // the ACCEPTED adapters are untouched: no phase exposes a refund key, no `test-cleanup` phase exists there
  assert.deepEqual(PHASES, ["reservation", "reservation-recovery", "capture", "cleanup", "recording"]);
  for (const ph of PHASES) for (const k of ["createRefund", "retrieveRefund", "listRefunds"]) assert.ok(!ACCEPTED_PHASE_KEYS[ph].includes(k), `${ph} ${k}`);
  assert.equal(createPhaseExecutors({ phase: "test-cleanup", binding: B, hostaway: { send() {} }, stripe: { send() {} } }).code, "PHASE_INVALID");
});

test("X2. Stripe keys: exact internal envelopes — account; PI retrieve expand latest_charge; refunds.create with EXACTLY payment_intent / amount / both metadata / bound key; refunds.retrieve re_ only; refunds.list bound PI limit 100", async () => {
  const { ex, ss } = make();
  await ex.retrieveAccount({ signal: sig() });
  await ex.retrievePaymentIntent(PI, { expand: ["latest_charge"] }, { signal: sig() });
  await ex.createRefund(PI, { amount: AMT, metadata: { mv_refund_op: OPID, mv_refund_key: KEY } }, { idempotencyKey: KEY, signal: sig() });
  await ex.retrieveRefund(RE, { signal: sig() });
  await ex.listRefunds(PI, { limit: 100 }, { signal: sig() });
  assert.deepEqual(JSON.parse(JSON.stringify(ss.map((x) => x.call))), [{ op: "accounts.retrieve" }, { op: "paymentIntents.retrieve", id: PI, params: { expand: ["latest_charge"] } },
    { op: "refunds.create", params: { payment_intent: PI, amount: AMT, metadata: { mv_refund_op: OPID, mv_refund_key: KEY } }, idempotencyKey: KEY },
    { op: "refunds.retrieve", id: RE }, { op: "refunds.list", params: { payment_intent: PI, limit: 100 } }]);
  assert.ok(ss.every((x) => x.signalIsGenuine && Object.isFrozen(x.call)));
  const before = ss.length;
  const refusals = [
    ["other PI", () => ex.createRefund("pi_test_other", { amount: AMT, metadata: { mv_refund_op: OPID, mv_refund_key: KEY } }, { idempotencyKey: KEY, signal: sig() }), "PAYMENT_INTENT_SCOPE"],
    ["partial", () => ex.createRefund(PI, { amount: AMT - 1, metadata: { mv_refund_op: OPID, mv_refund_key: KEY } }, { idempotencyKey: KEY, signal: sig() }), "PARAMS"],
    ["reason param", () => ex.createRefund(PI, { amount: AMT, metadata: { mv_refund_op: OPID, mv_refund_key: KEY }, reason: "requested_by_customer" }, { idempotencyKey: KEY, signal: sig() }), "PARAMS"],
    ["charge param", () => ex.createRefund(PI, { amount: AMT, metadata: { mv_refund_op: OPID, mv_refund_key: KEY }, charge: CH }, { idempotencyKey: KEY, signal: sig() }), "PARAMS"],
    ["metadata missing key", () => ex.createRefund(PI, { amount: AMT, metadata: { mv_refund_op: OPID } }, { idempotencyKey: KEY, signal: sig() }), "METADATA_SCOPE"],
    ["metadata other op", () => ex.createRefund(PI, { amount: AMT, metadata: { mv_refund_op: INTENT, mv_refund_key: KEY } }, { idempotencyKey: KEY, signal: sig() }), "METADATA_SCOPE"],
    ["metadata extra", () => ex.createRefund(PI, { amount: AMT, metadata: { mv_refund_op: OPID, mv_refund_key: KEY, note: "x" } }, { idempotencyKey: KEY, signal: sig() }), "METADATA_SCOPE"],
    ["other key", () => ex.createRefund(PI, { amount: AMT, metadata: { mv_refund_op: OPID, mv_refund_key: KEY } }, { idempotencyKey: refundKey(INTENT, 2), signal: sig() }), "IDEMPOTENCY_KEY"],
    ["no key", () => ex.createRefund(PI, { amount: AMT, metadata: { mv_refund_op: OPID, mv_refund_key: KEY } }, { signal: sig() }), "IDEMPOTENCY_KEY"],
    ["getter metadata", () => ex.createRefund(PI, { amount: AMT, metadata: Object.defineProperty({}, "mv_refund_op", { get() { throw new Error("getter ran"); }, enumerable: true }) }, { idempotencyKey: KEY, signal: sig() }), "ARGUMENT_INVALID"],
    ["refund id shape", () => ex.retrieveRefund("ch_x", { signal: sig() }), "REFUND_ID_INVALID"], ["refund id injection", () => ex.retrieveRefund(`${RE}/../charges`, { signal: sig() }), "REFUND_ID_INVALID"],
    ["list other PI", () => ex.listRefunds("pi_test_other", { limit: 100 }, { signal: sig() }), "PAYMENT_INTENT_SCOPE"], ["list limit", () => ex.listRefunds(PI, { limit: 10 }, { signal: sig() }), "PARAMS"],
    ["list paging", () => ex.listRefunds(PI, { limit: 100, starting_after: RE }, { signal: sig() }), "PARAMS"],
    ["PI no expand", () => ex.retrievePaymentIntent(PI, {}, { signal: sig() }), "PARAMS"], ["PI other", () => ex.retrievePaymentIntent("pi_other", { expand: ["latest_charge"] }, { signal: sig() }), "PAYMENT_INTENT_SCOPE"],
    ["aborted", () => { const ac = new AbortController(); ac.abort(); return ex.createRefund(PI, { amount: AMT, metadata: { mv_refund_op: OPID, mv_refund_key: KEY } }, { idempotencyKey: KEY, signal: ac.signal }); }, "ABORTED"],
    ["fake signal", () => ex.retrieveAccount({ signal: { aborted: false } }), "SIGNAL_REQUIRED"], ["extra option", () => ex.retrieveRefund(RE, { signal: sig(), expand: ["charge"] }), "OPTIONS_INVALID"]];
  for (const [label, fn, code] of refusals) assert.equal(await refusalOf(fn()), `REFUSED:${code}`, label);
  assert.equal(ss.length, before, "every refusal: ZERO transport calls");
});

test("X3. Hostaway keys (same mapping as the accepted cleanup phase): page lookup bound to listing / arrival; by-id read of the BOUND id only; ONE PUT cancel with the exact body; protected / foreign ids refused", async () => {
  const { ex, hs } = make();
  const lookup = { method: "GET", path: "/v1/reservations", query: { listingId: L, channelId: 2000, arrivalStartDate: IN, arrivalEndDate: IN, limit: 100, includeResources: 1 } };
  await ex.lookupPage(lookup, { signal: sig() });
  await ex.retrieveReservation({ method: "GET", path: `/reservations/${RID}`, query: {} }, { signal: sig() });
  await ex.cancelReservation({ method: "PUT", path: `/v1/reservations/${RID}/statuses/cancelled`, query: {}, body: { cancelledBy: "host" } }, { signal: sig() });
  assert.deepEqual(JSON.parse(JSON.stringify(hs.map((x) => x.req))), [{ method: "GET", path: "/v1/reservations", query: lookup.query }, { method: "GET", path: `/v1/reservations/${RID}`, query: {} },
    { method: "PUT", path: `/v1/reservations/${RID}/statuses/cancelled`, query: {}, body: { cancelledBy: "host" } }]);
  const before = hs.length;
  for (const [label, fn, code] of [
    ["other id read", () => ex.retrieveReservation({ method: "GET", path: "/reservations/6100010", query: {} }, { signal: sig() }), "PATH"],
    ["other id cancel", () => ex.cancelReservation({ method: "PUT", path: "/v1/reservations/6100010/statuses/cancelled", query: {}, body: { cancelledBy: "host" } }, { signal: sig() }), "PATH"],
    ["cancel body", () => ex.cancelReservation({ method: "PUT", path: `/v1/reservations/${RID}/statuses/cancelled`, query: {}, body: { cancelledBy: "guest" } }, { signal: sig() }), "BODY_SCOPE"],
    ["cancel query", () => ex.cancelReservation({ method: "PUT", path: `/v1/reservations/${RID}/statuses/cancelled`, query: { force: 1 }, body: { cancelledBy: "host" } }, { signal: sig() }), "QUERY"],
    ["lookup other listing", () => ex.lookupPage({ ...lookup, query: { ...lookup.query, listingId: 603566 } }, { signal: sig() }), "QUERY_SCOPE"],
    ["lookup other date", () => ex.lookupPage({ ...lookup, query: { ...lookup.query, arrivalStartDate: OUT, arrivalEndDate: OUT } }, { signal: sig() }), "QUERY_SCOPE"],
    ["create", () => ex.createReservation?.({}, { signal: sig() }) ?? Promise.reject(new ExecutorRefusal("NO_SUCH_KEY")), "NO_SUCH_KEY"]]) assert.equal(await refusalOf(fn()), `REFUSED:${code}`, label);
  assert.equal(hs.length, before);
  // a throwing / malformed transport is a code-only transport failure (never the caller's error)
  const t = createTestCleanupExecutors({ binding: B, hostaway: { send: async () => { throw new Error("secret body"); } }, stripe: { send: async () => ({ not: "a refund" }) } }).executors;
  assert.equal(await refusalOf(t.retrieveReservation({ method: "GET", path: `/reservations/${RID}`, query: {} }, { signal: sig() })), "TRANSPORT:TRANSPORT_FAILED");
  const t2 = createTestCleanupExecutors({ binding: B, hostaway: { send: async () => ({ httpStatus: 200 }) }, stripe: { send: async () => REFUND() } }).executors;
  assert.equal(await refusalOf(t2.retrieveReservation({ method: "GET", path: `/reservations/${RID}`, query: {} }, { signal: sig() })), "TRANSPORT:TRANSPORT_REPLY_SHAPE");
});

test("X4. Stripe TEST cleanup transport: exact wire for the five operations (refund POST form body + Idempotency-Key = ref:<intent>:1); everything else REQUEST_NOT_ALLOWED with ZERO exchanges; TEST key only", async () => {
  const t = stripeT((req) => ok(req.url.endsWith("/v1/account") ? ACCOUNT : req.url.includes("/v1/refunds?") ? LISTR() : req.url.includes("/v1/refunds") ? REFUND() : PIOBJ()));
  const calls = [
    [{ op: "accounts.retrieve" }, "GET", "https://api.stripe.com/v1/account", null, undefined],
    [{ op: "paymentIntents.retrieve", id: PI, params: { expand: ["latest_charge"] } }, "GET", `https://api.stripe.com/v1/payment_intents/${PI}?expand%5B%5D=latest_charge`, null, undefined],
    [{ op: "refunds.create", params: { payment_intent: PI, amount: AMT, metadata: { mv_refund_op: OPID, mv_refund_key: KEY } }, idempotencyKey: KEY }, "POST", "https://api.stripe.com/v1/refunds",
      `payment_intent=${PI}&amount=${AMT}&metadata%5Bmv_refund_op%5D=${OPID}&metadata%5Bmv_refund_key%5D=${encodeURIComponent(KEY)}`, KEY],
    [{ op: "refunds.retrieve", id: RE }, "GET", `https://api.stripe.com/v1/refunds/${RE}`, null, undefined],
    [{ op: "refunds.list", params: { payment_intent: PI, limit: 100 } }, "GET", `https://api.stripe.com/v1/refunds?payment_intent=${PI}&limit=100`, null, undefined]
  ];
  for (const [call, method, url, body, idem] of calls) {
    const r = await t.send(call, { signal: sig() });
    const rec = t.log.at(-1);
    assert.deepEqual([rec.method, rec.url, rec.body, rec.auth, rec.headers["Stripe-Version"], rec.headers["Idempotency-Key"], rec.signalIsGenuine], [method, url, body, `Bearer ${SKEY}`, VERSION, idem, true], url);
    assert.equal(rec.headers["Content-Type"], method === "POST" ? "application/x-www-form-urlencoded" : undefined);
    assert.ok(Object.isFrozen(r));
  }
  assert.equal(t.log.length, 5); assert.equal(t.creds(), 5);
  assert.equal(decodeURIComponent(t.log[2].body), `payment_intent=${PI}&amount=${AMT}&metadata[mv_refund_op]=${OPID}&metadata[mv_refund_key]=${KEY}`, "the contract §7 body, decoded");
  const z = stripeT(() => ok(REFUND()));
  for (const [label, call] of [
    ["capture", { op: "paymentIntents.capture", id: PI, params: { amount_to_capture: AMT, expand: ["latest_charge"] }, idempotencyKey: KEY }],
    ["void", { op: "paymentIntents.cancel", id: PI, params: {}, idempotencyKey: KEY }], ["charge refund", { op: "refunds.create", params: { charge: CH, amount: AMT, metadata: { mv_refund_op: OPID, mv_refund_key: KEY } }, idempotencyKey: KEY }],
    ["partial key family", { op: "refunds.create", params: { payment_intent: PI, amount: AMT, metadata: { mv_refund_op: OPID, mv_refund_key: `rf:${INTENT}:1` } }, idempotencyKey: `rf:${INTENT}:1` }],
    ["key ≠ metadata key", { op: "refunds.create", params: { payment_intent: PI, amount: AMT, metadata: { mv_refund_op: OPID, mv_refund_key: refundKey(INTENT, 1) } }, idempotencyKey: refundKey(OPID, 1) }],
    ["attempt 2 key", { op: "refunds.create", params: { payment_intent: PI, amount: AMT, metadata: { mv_refund_op: OPID, mv_refund_key: refundKey(INTENT, 2) } }, idempotencyKey: refundKey(INTENT, 2) }],
    ["no metadata", { op: "refunds.create", params: { payment_intent: PI, amount: AMT }, idempotencyKey: KEY }], ["no key", { op: "refunds.create", params: { payment_intent: PI, amount: AMT, metadata: { mv_refund_op: OPID, mv_refund_key: KEY } } }],
    ["reason", { op: "refunds.create", params: { payment_intent: PI, amount: AMT, metadata: { mv_refund_op: OPID, mv_refund_key: KEY }, reason: "duplicate" }, idempotencyKey: KEY }],
    ["amount 0", { op: "refunds.create", params: { payment_intent: PI, amount: 0, metadata: { mv_refund_op: OPID, mv_refund_key: KEY } }, idempotencyKey: KEY }],
    ["metadata op injection", { op: "refunds.create", params: { payment_intent: PI, amount: AMT, metadata: { mv_refund_op: "x&y=z", mv_refund_key: KEY } }, idempotencyKey: KEY }],
    ["retrieve not re_", { op: "refunds.retrieve", id: CH }], ["retrieve path injection", { op: "refunds.retrieve", id: `${RE}/../charges` }],
    ["list other limit", { op: "refunds.list", params: { payment_intent: PI, limit: 10 } }], ["list paging", { op: "refunds.list", params: { payment_intent: PI, limit: 100, starting_after: RE } }],
    ["list by charge", { op: "refunds.list", params: { charge: CH, limit: 100 } }], ["account with id", { op: "accounts.retrieve", id: ACCT }], ["PI no expand", { op: "paymentIntents.retrieve", id: PI, params: {} }],
    ["unknown", { op: "charges.retrieve", id: CH }]]) assert.equal(await codeOf(z.send(call, { signal: sig() })), "REQUEST_NOT_ALLOWED", label);
  assert.deepEqual([z.log.length, z.creds()], [0, 0], "ZERO exchanges / credential calls for refused requests");
  for (const [k, code] of [["sk_live_abc", "KEY_NOT_TEST"], ["rk_test_abc", "KEY_NOT_TEST"], ["", "CREDENTIAL_INVALID"]]) {
    const u = stripeT(() => ok(REFUND()), { credential: () => k });
    assert.deepEqual([await codeOf(u.send({ op: "refunds.retrieve", id: RE }, { signal: sig() })), u.log.length], [code, 0], k);
  }
  assert.deepEqual(STRIPE_OPS, ["accounts.retrieve", "paymentIntents.retrieve", "refunds.create", "refunds.retrieve", "refunds.list"]);
  assert.deepEqual(CLEANUP_ERROR_CODES, ERROR_CODES, "same code vocabulary as the accepted transport");
});

test("X5. Stripe TEST cleanup transport replies: Refund objects need object / re_ id / documented status (NO livemode exists); retrieve id must echo; create PI must echo; list shape bounded; PI livemode strict; 4xx / 5xx code-only, one exchange", async () => {
  const one = async (reply, call) => { const u = stripeT(() => reply); const c = await codeOf(u.send(call, { signal: sig() })); return [c, u.log.length]; };
  const GET = { op: "refunds.retrieve", id: RE }; const CREATE = { op: "refunds.create", params: { payment_intent: PI, amount: AMT, metadata: { mv_refund_op: OPID, mv_refund_key: KEY } }, idempotencyKey: KEY };
  const LIST = { op: "refunds.list", params: { payment_intent: PI, limit: 100 } };
  assert.deepEqual(await one(ok(REFUND()), GET), ["RESOLVED", 1]);
  assert.deepEqual(await one(ok(REFUND({ status: "pending" })), CREATE), ["RESOLVED", 1], "a pending reply is a valid Refund object (the worker treats it as unknown)");
  assert.deepEqual(await one(ok(REFUND({ payment_intent: { id: PI, object: "payment_intent" } })), CREATE), ["RESOLVED", 1], "expanded PI echo accepted");
  assert.deepEqual(await one(ok(REFUND({ id: "re_other" })), GET), ["REPLY_INVALID", 1]);
  assert.deepEqual(await one(ok(REFUND({ object: "charge" })), GET), ["REPLY_INVALID", 1]);
  assert.deepEqual(await one(ok(REFUND({ status: "done" })), GET), ["REPLY_INVALID", 1]);
  assert.deepEqual(await one(ok(REFUND({ payment_intent: "pi_other" })), CREATE), ["REPLY_INVALID", 1]);
  assert.deepEqual(await one(ok(LISTR([REFUND(), REFUND({ id: "re_2" })])), LIST), ["RESOLVED", 1]);
  assert.deepEqual(await one(ok(LISTR([], true)), LIST), ["RESOLVED", 1], "has_more is passed through for the pure discovery to refuse");
  assert.deepEqual(await one(ok({ object: "list", data: [{ object: "charge", id: CH }], has_more: false }), LIST), ["REPLY_INVALID", 1]);
  assert.deepEqual(await one(ok({ object: "list", data: [REFUND()] }), LIST), ["REPLY_INVALID", 1]);
  assert.deepEqual(await one(ok([REFUND()]), LIST), ["REPLY_INVALID", 1]);
  assert.deepEqual(await one(ok(PIOBJ({ livemode: true })), { op: "paymentIntents.retrieve", id: PI, params: { expand: ["latest_charge"] } }), ["LIVEMODE_REFUSED", 1]);
  assert.deepEqual(await one(ok({ ...ACCOUNT, id: "acct_other" }), { op: "accounts.retrieve" }), ["ACCOUNT_MISMATCH", 1]);
  for (const [st, code] of [[400, "STRIPE_HTTP_4XX"], [402, "STRIPE_HTTP_4XX"], [409, "STRIPE_HTTP_4XX"], [429, "STRIPE_HTTP_4XX"], [500, "STRIPE_HTTP_5XX"]]) {
    assert.deepEqual(await one(ok({ error: { type: "invalid_request_error", code: "charge_already_refunded", message: "provider text" } }, st), CREATE), [code, 1], `${st}: code only, one exchange, no retry`);
  }
  assert.deepEqual(await one({ status: 302, contentType: null, bytes: enc("") }, GET), ["REDIRECT_REFUSED", 1]);
  assert.deepEqual(await one({ status: 200, contentType: "text/plain", bytes: enc("nope") }, GET), ["JSON_INVALID", 1]);
  // abort after the exchange started → ABORTED_IN_FLIGHT, one exchange, no follow-up
  const ac = new AbortController();
  const u = stripeT(() => { ac.abort(); return ok(REFUND()); });
  assert.deepEqual([await codeOf(u.send(CREATE, { signal: ac.signal })), u.log.length], ["ABORTED_IN_FLIGHT", 1]);
});

test("X6. the test-cleanup executors over the REAL transport modules (accepted Hostaway send + the cleanup Stripe send): exact wire, adapter refusals before any exchange", async () => {
  const route = (req) => {
    if (req.url.startsWith("https://api.stripe.com")) return ok(req.url.endsWith("/v1/account") ? ACCOUNT : req.url.includes("/v1/refunds?") ? LISTR() : req.url.includes("/v1/refunds") ? REFUND() : PIOBJ());
    return ok({ status: "success", result: { id: Number(RID), status: "cancelled" } });
  };
  const h = hostawayT(route); const s = stripeT(route);
  const r = createTestCleanupExecutors({ binding: B, hostaway: { send: h.send }, stripe: { send: s.send } });
  assert.equal(r.ok, true, r.code);
  const ex = r.executors;
  await ex.retrieveAccount({ signal: sig() });
  await ex.retrievePaymentIntent(PI, { expand: ["latest_charge"] }, { signal: sig() });
  await ex.retrieveReservation({ method: "GET", path: `/reservations/${RID}`, query: {} }, { signal: sig() });
  await ex.cancelReservation({ method: "PUT", path: `/v1/reservations/${RID}/statuses/cancelled`, query: {}, body: { cancelledBy: "host" } }, { signal: sig() });
  const created = await ex.createRefund(PI, { amount: AMT, metadata: { mv_refund_op: OPID, mv_refund_key: KEY } }, { idempotencyKey: KEY, signal: sig() });
  await ex.retrieveRefund(created.id, { signal: sig() });
  await ex.listRefunds(PI, { limit: 100 }, { signal: sig() });
  assert.deepEqual(h.log.map((x) => [x.method, x.url, x.body]), [["GET", `https://api.hostaway.com/v1/reservations/${RID}`, null], ["PUT", `https://api.hostaway.com/v1/reservations/${RID}/statuses/cancelled`, JSON.stringify({ cancelledBy: "host" })]]);
  assert.deepEqual(s.log.map((x) => [x.method, x.url, x.headers["Idempotency-Key"]]), [["GET", "https://api.stripe.com/v1/account", undefined], ["GET", `https://api.stripe.com/v1/payment_intents/${PI}?expand%5B%5D=latest_charge`, undefined],
    ["POST", "https://api.stripe.com/v1/refunds", KEY], ["GET", `https://api.stripe.com/v1/refunds/${RE}`, undefined], ["GET", `https://api.stripe.com/v1/refunds?payment_intent=${PI}&limit=100`, undefined]]);
  // the ACCEPTED Stripe transport still refuses every refund operation (behaviour pin; the module is byte-identical)
  const accepted = createE7StripeTestSend({ exchange: async () => ok(REFUND()), credential: () => SKEY, accountId: ACCT, apiVersion: VERSION }).transport;
  for (const call of [{ op: "refunds.create", params: { payment_intent: PI, amount: AMT, metadata: { mv_refund_op: OPID, mv_refund_key: KEY } }, idempotencyKey: KEY }, { op: "refunds.retrieve", id: RE }, { op: "refunds.list", params: { payment_intent: PI, limit: 100 } }]) {
    assert.equal(await codeOfAccepted(accepted.send(call, { signal: sig() })), "REQUEST_NOT_ALLOWED", call.op);
  }
  // the cleanup transport cannot capture or void: an executor-level attempt has no key; a direct call is REQUEST_NOT_ALLOWED
  assert.equal(await codeOf(s.send({ op: "paymentIntents.cancel", id: PI, params: {}, idempotencyKey: KEY }, { signal: sig() })), "REQUEST_NOT_ALLOWED");
  assert.equal(s.log.length, 5);
});

test("X7. source pins: the new modules import no network / env / fs / timers / SDK and never the frozen journal grammar; the accepted adapters / transports are not imported by the executor module", () => {
  const ex = readFileSync(new URL("../scripts/e7-connected/test-cleanup-executors.mjs", import.meta.url), "utf8");
  const tr = readFileSync(new URL("../scripts/e7-connected/test-cleanup-transports.mjs", import.meta.url), "utf8");
  assert.deepEqual([...ex.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]).sort(), ["../../lib/checkout/compensation-proof.js", "../../lib/checkout/test-cleanup-proof.js", "node:util"]);
  assert.deepEqual([...tr.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]).sort(), ["node:util"]);
  for (const src of [ex, tr]) {
    assert.doesNotMatch(src, /\b(fetch\(|node:http|node:https|node:net|undici|process\.env|setTimeout|setInterval|node:fs|require\()/);
    assert.doesNotMatch(src, /from "stripe"|run-journal|executor-adapters\.mjs"|http-transports\.mjs"/);
  }
  assert.ok(!/paymentIntents\.(capture|cancel)|guestPayments|hostaway\.create|record_offline|alert\.owner|guest\.notify/.test(tr), "no capture / void / create / recording / notification op in the cleanup transport");
  assert.ok(!/capturePaymentIntent|cancelPaymentIntent|createReservation|createOfflineCharge/.test(ex), "no capture / void / create / recording key in the cleanup executors");
});
