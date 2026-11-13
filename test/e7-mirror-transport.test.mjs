// E7 recorded TEST cleanup — ISOLATED mirror executors / transports (lib/booking-db/mirror-transport.js) with a FAKE fetch. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildHostawayMirrorExecutors, buildStripeMirrorExecutors, combineMirrorExecutors, MirrorTransportError } from "../lib/booking-db/mirror-transport.js";
import { MIRROR_EXECUTOR_KEYS, mirrorWorkerGate } from "../lib/booking-db/mirror-worker.js";
import { validateAdapterConfig } from "../lib/hostaway-reservations.js";

const fakeFetch = (log, reply = { status: 200, body: JSON.stringify({ status: "success", result: [] }) }) => async (url, init) => {
  log.push({ url, method: init.method, auth: init.headers.Authorization, ct: init.headers["Content-Type"], body: init.body });
  if (typeof reply === "function") return reply(url, init);
  return { status: reply.status, text: async () => reply.body };
};
const TOKEN = "tok_test_1234567890";
import { mirrorTitle } from "../lib/checkout/mirror-proof.js";
const INTENT = "11111111-2222-4333-8444-555555555555";
const BIND = Object.freeze({ intentId: INTENT, reservationId: "20001", offlineChargeId: "520001", amountMinor: 576000, currency: "USD" });

test("Hostaway transport: GET reads with the exact query; the ONE POST carries the field-exact JSON body; replies reduced to { httpStatus, json }; the bearer is read at call time and never echoed", async () => {
  const log = [];
  const h = buildHostawayMirrorExecutors({ fetchImpl: fakeFetch(log), baseUrl: "https://api.hostaway.test", bearer: () => TOKEN, binding: BIND });
  const r1 = await h.listOfflineCharges({ method: "GET", path: "/v1/guestPayments/charges", query: { reservationId: "20001", limit: 500 } }, {});
  assert.deepEqual(r1, { httpStatus: 200, json: { status: "success", result: [] } });
  assert.equal(log[0].url, "https://api.hostaway.test/v1/guestPayments/charges?reservationId=20001&limit=500"); assert.equal(log[0].method, "GET"); assert.equal(log[0].body, undefined);
  assert.equal(log[0].auth, `Bearer ${TOKEN}`); assert.equal(JSON.stringify(r1).includes(TOKEN), false);
  const body = { title: mirrorTitle(INTENT), amount: 5760, isIncludeInPriceBreakdown: 0 };
  const r2 = await h.refundOfflineCharge({ method: "POST", path: "/v1/guestPayments/charges/20001/520001/refund", query: {}, body }, {});
  assert.equal(r2.httpStatus, 200); assert.equal(log[1].method, "POST"); assert.equal(log[1].body, JSON.stringify(body)); assert.equal(log[1].ct, "application/json");
  assert.deepEqual(h.counts(), { gets: 1, posts: 1 });
  await assert.rejects(h.retrieveReservation({ method: "POST", path: "/v1/reservations/20001", query: {} }), /REQUEST_METHOD_INVALID/);
  await assert.rejects(h.retrieveReservation({ method: "GET", path: "/v2/x", query: {} }), /REQUEST_TARGET_FORBIDDEN/);
  await assert.rejects(h.retrieveReservation({ method: "GET", path: "/v1/reservations/20001", query: { "bad key": 1 } }), /REQUEST_TARGET_FORBIDDEN/);
});

test("wire limit: the POST counter moves BEFORE the transport; a second POST from the same instance never reaches fetch (MIRROR_WIRE_LIMIT); maxPosts 0 forbids any POST", async () => {
  const log = []; let inFlightCount = null;
  const h = buildHostawayMirrorExecutors({ fetchImpl: async (url, init) => { inFlightCount = h.counts().posts; log.push(init.method); return { status: 200, text: async () => "{}" }; }, baseUrl: "https://api.hostaway.test", bearer: () => TOKEN, binding: BIND });
  const req = { method: "POST", path: "/v1/guestPayments/charges/20001/520001/refund", query: {}, body: { title: mirrorTitle(INTENT), amount: 5760, isIncludeInPriceBreakdown: 0 } };
  await h.refundOfflineCharge(req, {});
  assert.equal(inFlightCount, 1, "counted before the call");
  await assert.rejects(h.refundOfflineCharge(req, {}), /MIRROR_WIRE_LIMIT/);
  assert.deepEqual([log.length, h.counts().posts], [1, 1]);
  const none = buildHostawayMirrorExecutors({ fetchImpl: fakeFetch([]), baseUrl: "https://api.hostaway.test", bearer: () => TOKEN, binding: BIND, maxPosts: 0 });
  await assert.rejects(none.refundOfflineCharge(req, {}), /MIRROR_WIRE_LIMIT/);
  assert.throws(() => buildHostawayMirrorExecutors({ fetchImpl: fakeFetch([]), baseUrl: "https://api.hostaway.test", bearer: () => TOKEN, binding: BIND, maxPosts: 2 }), /MAX_POSTS_INVALID/);
});

test("failures are codes only: a thrown fetch → TRANSPORT_FAILED (no raw error), an aborted signal → ABORTED, unparsable body → json null with the status, a short bearer refused before any call", async () => {
  const h = buildHostawayMirrorExecutors({ fetchImpl: async () => { throw new Error("ECONNRESET secret-host details"); }, baseUrl: "https://api.hostaway.test", bearer: () => TOKEN, binding: BIND });
  await assert.rejects(h.listOfflineCharges({ method: "GET", path: "/v1/guestPayments/charges", query: { reservationId: "20001", limit: 500 } }), (e) => e instanceof MirrorTransportError && e.code === "TRANSPORT_FAILED" && !e.message.includes("secret"));
  const ac = new AbortController(); ac.abort();
  const h2 = buildHostawayMirrorExecutors({ fetchImpl: async () => { throw new Error("aborted"); }, baseUrl: "https://api.hostaway.test", bearer: () => TOKEN, binding: BIND });
  await assert.rejects(h2.listOfflineCharges({ method: "GET", path: "/v1/guestPayments/charges", query: { reservationId: "20001", limit: 500 } }, { signal: ac.signal }), /ABORTED/);
  const h3 = buildHostawayMirrorExecutors({ fetchImpl: fakeFetch([], { status: 502, body: "<html>bad gateway</html>" }), baseUrl: "https://api.hostaway.test", bearer: () => TOKEN, binding: BIND });
  assert.deepEqual(await h3.listOfflineCharges({ method: "GET", path: "/v1/guestPayments/charges", query: { reservationId: "20001", limit: 500 } }), { httpStatus: 502, json: null });
  const log = [];
  const h4 = buildHostawayMirrorExecutors({ fetchImpl: fakeFetch(log), baseUrl: "https://api.hostaway.test", bearer: () => "short", binding: BIND });
  await assert.rejects(h4.listOfflineCharges({ method: "GET", path: "/v1/guestPayments/charges", query: { reservationId: "20001", limit: 500 } }), /BEARER_INVALID/); assert.equal(log.length, 0);
  assert.throws(() => buildHostawayMirrorExecutors({ fetchImpl: fakeFetch([]), baseUrl: "http://api.hostaway.test", bearer: () => TOKEN, binding: BIND }), /BASE_URL_INVALID/);
});

test("combination: exactly MIRROR_EXECUTOR_KEYS (Stripe reads + Hostaway executors); a missing executor refuses; the combined set passes the worker gate", () => {
  const stripe = buildStripeMirrorExecutors({ client: { retrieveAccount: async () => ({ object: "account", id: "acct_1X" }), retrievePaymentIntent: async () => ({}) } });
  const h = buildHostawayMirrorExecutors({ fetchImpl: fakeFetch([]), baseUrl: "https://api.hostaway.test", bearer: () => TOKEN, binding: BIND });
  const ex = combineMirrorExecutors(stripe, h);
  assert.deepEqual(Object.keys(ex).sort(), [...MIRROR_EXECUTOR_KEYS].sort());
  assert.throws(() => combineMirrorExecutors(stripe, { listOfflineCharges: h.listOfflineCharges }), /EXECUTOR_MISSING_retrieveReservation/);
  assert.throws(() => buildStripeMirrorExecutors({ client: { retrieveAccount: async () => ({}) } }), /STRIPE_CLIENT_INVALID/);
  const g = mirrorWorkerGate({ env: { VERCEL_ENV: "development", MV_E7_TEST_CLEANUP: "enabled", MV_E7_MIRROR_WORKER: "enabled" }, adapterConfig: validateAdapterConfig({ allowedListingIds: [606998], refFieldId: 777004, channelId: 2000, currency: "USD" }),
    recordingConfig: { accountRef: "acct-test-1", channelId: 2000, currency: "USD", listingId: 606998, paymentMethod: "credit_card", refFieldId: 777004 }, listings: new Map([[606998, { currency: "USD", timeZone: "America/Mazatlan" }]]),
    executors: ex, clock: () => Date.now(), stripeAccountId: "acct_1X", intentId: "11111111-2222-4333-8444-555555555555" });
  assert.equal(g.ok, true, JSON.stringify(g));
});

// =============================================================================================
// rev2 (ROOT HOLD 5885005598, F3): validated IMMUTABLE per-intent binding at construction; per-executor exact method / path / query / body / money /
// marker fences BEFORE fetch; private monotonic send counter with a read-only snapshot; pre-aborted signals refused before fetch; protected / foreign /
// extra fields refused; concurrent second POST never reaches the wire
const mk = (log, over = {}, reply) => buildHostawayMirrorExecutors({ fetchImpl: fakeFetch(log, reply), baseUrl: "https://api.hostaway.test", bearer: () => TOKEN, binding: BIND, ...over });
const LIST_REQ = Object.freeze({ method: "GET", path: "/v1/guestPayments/charges", query: Object.freeze({ reservationId: "20001", limit: 500 }) });
const RES_REQ = Object.freeze({ method: "GET", path: "/v1/reservations/20001", query: Object.freeze({}) });
const POST_REQ = Object.freeze({ method: "POST", path: "/v1/guestPayments/charges/20001/520001/refund", query: Object.freeze({}), body: Object.freeze({ title: mirrorTitle(INTENT), amount: 5760, isIncludeInPriceBreakdown: 0 }) });

test("F3 binding: construction requires a validated per-intent binding (intent uuid, canonical reservation / offline-charge ids, exact money, USD); protected reservations and the offline charge equal to the reservation are refused; the binding is frozen and exposed read-only", () => {
  assert.throws(() => buildHostawayMirrorExecutors({ fetchImpl: fakeFetch([]), baseUrl: "https://api.hostaway.test", bearer: () => TOKEN }), /BINDING_REQUIRED/);
  for (const [code, over] of [["BINDING_INTENT_INVALID", { intentId: "nope" }], ["BINDING_RESERVATION_INVALID", { reservationId: "020001" }], ["BINDING_RESERVATION_PROTECTED", { reservationId: "70636076" }],
    ["BINDING_OFFLINE_CHARGE_INVALID", { offlineChargeId: "ch_x" }], ["BINDING_OFFLINE_CHARGE_IS_RESERVATION", { offlineChargeId: "20001" }], ["BINDING_AMOUNT_INVALID", { amountMinor: 0 }],
    ["BINDING_AMOUNT_INVALID", { amountMinor: 12.5 }], ["BINDING_CURRENCY_NOT_APPROVED", { currency: "MXN" }], ["BINDING_SHAPE", { extra: 1 }]]) {
    assert.throws(() => mk([], { binding: { ...BIND, ...over } }), new RegExp(code), code);
  }
  const h = mk([]);
  assert.ok(Object.isFrozen(h) && Object.isFrozen(h.binding));
  assert.deepEqual(h.binding, { ...BIND, amount: 5760, title: mirrorTitle(INTENT), listPath: "/v1/guestPayments/charges", reservationPath: "/v1/reservations/20001", refundPath: "/v1/guestPayments/charges/20001/520001/refund" });
});

test("F3 per-executor fences BEFORE fetch: any method / path / query / body deviation from the bound targets is refused with ZERO fetch and the send counter unchanged — foreign reservation, other charge, extra query key, changed limit, extra / missing body field, other amount, other title (marker), other breakdown flag, non-empty POST query", async () => {
  const log = []; const h = mk(log);
  const bad = async (fn, req, code) => { await assert.rejects(fn(req, {}), (e) => e instanceof MirrorTransportError && e.code === code, `${code} ${JSON.stringify(req)}`); };
  await bad(h.retrieveReservation, { ...RES_REQ, path: "/v1/reservations/20002" }, "REQUEST_TARGET_FORBIDDEN");
  await bad(h.retrieveReservation, { ...RES_REQ, query: { expand: "x" } }, "REQUEST_TARGET_FORBIDDEN");
  await bad(h.retrieveReservation, { ...RES_REQ, method: "POST" }, "REQUEST_METHOD_INVALID");
  await bad(h.listOfflineCharges, { ...LIST_REQ, query: { reservationId: "20002", limit: 500 } }, "REQUEST_TARGET_FORBIDDEN");
  await bad(h.listOfflineCharges, { ...LIST_REQ, query: { reservationId: "20001", limit: 400 } }, "REQUEST_TARGET_FORBIDDEN");
  await bad(h.listOfflineCharges, { ...LIST_REQ, query: { reservationId: "20001", limit: 500, page: 2 } }, "REQUEST_TARGET_FORBIDDEN");
  await bad(h.listOfflineCharges, { ...LIST_REQ, path: "/v1/guestPayments/charges/20001/520001/refund" }, "REQUEST_TARGET_FORBIDDEN");
  await bad(h.refundOfflineCharge, { ...POST_REQ, path: "/v1/guestPayments/charges/20002/520001/refund" }, "REQUEST_TARGET_FORBIDDEN");
  await bad(h.refundOfflineCharge, { ...POST_REQ, path: "/v1/guestPayments/charges/20001/520002/refund" }, "REQUEST_TARGET_FORBIDDEN");
  await bad(h.refundOfflineCharge, { ...POST_REQ, query: { force: 1 } }, "REQUEST_TARGET_FORBIDDEN");
  await bad(h.refundOfflineCharge, { ...POST_REQ, body: { ...POST_REQ.body, amount: 5761 } }, "REQUEST_BODY_FORBIDDEN");
  await bad(h.refundOfflineCharge, { ...POST_REQ, body: { ...POST_REQ.body, amount: -5760 } }, "REQUEST_BODY_FORBIDDEN");
  await bad(h.refundOfflineCharge, { ...POST_REQ, body: { ...POST_REQ.body, title: mirrorTitle("22222222-2222-4333-8444-555555555555") } }, "REQUEST_BODY_FORBIDDEN");
  await bad(h.refundOfflineCharge, { ...POST_REQ, body: { ...POST_REQ.body, isIncludeInPriceBreakdown: 1 } }, "REQUEST_BODY_FORBIDDEN");
  await bad(h.refundOfflineCharge, { ...POST_REQ, body: { ...POST_REQ.body, note: "x" } }, "REQUEST_BODY_FORBIDDEN");
  await bad(h.refundOfflineCharge, { ...POST_REQ, body: { title: POST_REQ.body.title, amount: 5760 } }, "REQUEST_BODY_FORBIDDEN");
  await bad(h.refundOfflineCharge, { ...POST_REQ, method: "GET" }, "REQUEST_METHOD_INVALID");
  await bad(h.refundOfflineCharge, { ...POST_REQ, extra: 1 }, "REQUEST_SHAPE_INVALID");
  assert.deepEqual([log.length, h.counts()], [0, { gets: 0, posts: 0 }]);
  // the exact bound requests pass, once
  await h.retrieveReservation(RES_REQ, {}); await h.listOfflineCharges(LIST_REQ, {}); await h.refundOfflineCharge(POST_REQ, {});
  assert.deepEqual([log.map((l) => l.method), h.counts()], [["GET", "GET", "POST"], { gets: 2, posts: 1 }]);
  assert.equal(log[2].body, JSON.stringify(POST_REQ.body));
});

test("F3 private monotonic counter: counts() is a frozen read-only snapshot (mutating it or the executor object never re-opens the wire); a concurrent second POST and a later POST both hit MIRROR_WIRE_LIMIT with exactly ONE fetch; a pre-aborted signal is refused BEFORE fetch (zero fetch, counter unchanged)", async () => {
  const log = []; let release; const gate = new Promise((r) => { release = r; });
  const h = buildHostawayMirrorExecutors({ fetchImpl: async (url, init) => { log.push(init.method); await gate; return { status: 200, text: async () => "{}" }; }, baseUrl: "https://api.hostaway.test", bearer: () => TOKEN, binding: BIND });
  const both = Promise.allSettled([h.refundOfflineCharge(POST_REQ, {}), h.refundOfflineCharge(POST_REQ, {})]);
  await new Promise((r) => setTimeout(r, 5)); release();
  const r = await both;
  assert.deepEqual(r.map((x) => x.status), ["fulfilled", "rejected"]); assert.equal(r[1].reason.code, "MIRROR_WIRE_LIMIT"); assert.deepEqual(log, ["POST"]);
  const snap = h.counts(); assert.ok(Object.isFrozen(snap)); assert.deepEqual(snap, { gets: 0, posts: 1 });
  assert.throws(() => { snap.posts = 0; }); assert.throws(() => { h.counts = () => ({ gets: 0, posts: 0 }); }); assert.deepEqual(h.counts(), { gets: 0, posts: 1 });
  await assert.rejects(h.refundOfflineCharge(POST_REQ, {}), /MIRROR_WIRE_LIMIT/); assert.deepEqual(log, ["POST"]);
  const log2 = []; const h2 = mk(log2); const ac = new AbortController(); ac.abort();
  await assert.rejects(h2.refundOfflineCharge(POST_REQ, { signal: ac.signal }), /ABORTED/);
  await assert.rejects(h2.listOfflineCharges(LIST_REQ, { signal: ac.signal }), /ABORTED/);
  assert.deepEqual([log2.length, h2.counts()], [0, { gets: 0, posts: 0 }]);
  await h2.refundOfflineCharge(POST_REQ, {}); assert.deepEqual([log2.length, h2.counts().posts], [1, 1]);
});
