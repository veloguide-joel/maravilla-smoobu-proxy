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

test("Hostaway transport: GET reads with the exact query; the ONE POST carries the field-exact JSON body; replies reduced to { httpStatus, json }; the bearer is read at call time and never echoed", async () => {
  const log = [];
  const h = buildHostawayMirrorExecutors({ fetchImpl: fakeFetch(log), baseUrl: "https://api.hostaway.test", bearer: () => TOKEN });
  const r1 = await h.listOfflineCharges({ method: "GET", path: "/v1/guestPayments/charges", query: { reservationId: "20001", limit: 500 } }, {});
  assert.deepEqual(r1, { httpStatus: 200, json: { status: "success", result: [] } });
  assert.equal(log[0].url, "https://api.hostaway.test/v1/guestPayments/charges?reservationId=20001&limit=500"); assert.equal(log[0].method, "GET"); assert.equal(log[0].body, undefined);
  assert.equal(log[0].auth, `Bearer ${TOKEN}`); assert.equal(JSON.stringify(r1).includes(TOKEN), false);
  const body = { title: "maraVilla refund mvochr1-11111111-2222-4333-8444-555555555555", amount: 5760, isIncludeInPriceBreakdown: 0 };
  const r2 = await h.refundOfflineCharge({ method: "POST", path: "/v1/guestPayments/charges/20001/520001/refund", query: {}, body }, {});
  assert.equal(r2.httpStatus, 200); assert.equal(log[1].method, "POST"); assert.equal(log[1].body, JSON.stringify(body)); assert.equal(log[1].ct, "application/json");
  assert.deepEqual(h.counts, { gets: 1, posts: 1 });
  await assert.rejects(h.retrieveReservation({ method: "POST", path: "/v1/reservations/20001", query: {} }), /REQUEST_METHOD_INVALID/);
  await assert.rejects(h.retrieveReservation({ method: "GET", path: "/v2/x", query: {} }), /REQUEST_PATH_INVALID/);
  await assert.rejects(h.retrieveReservation({ method: "GET", path: "/v1/reservations/20001", query: { "bad key": 1 } }), /REQUEST_QUERY_INVALID/);
});

test("wire limit: the POST counter moves BEFORE the transport; a second POST from the same instance never reaches fetch (MIRROR_WIRE_LIMIT); maxPosts 0 forbids any POST", async () => {
  const log = []; let inFlightCount = null;
  const h = buildHostawayMirrorExecutors({ fetchImpl: async (url, init) => { inFlightCount = h.counts.posts; log.push(init.method); return { status: 200, text: async () => "{}" }; }, baseUrl: "https://api.hostaway.test", bearer: () => TOKEN });
  const req = { method: "POST", path: "/v1/guestPayments/charges/1/2/refund", query: {}, body: { title: "t", amount: 1, isIncludeInPriceBreakdown: 0 } };
  await h.refundOfflineCharge(req, {});
  assert.equal(inFlightCount, 1, "counted before the call");
  await assert.rejects(h.refundOfflineCharge(req, {}), /MIRROR_WIRE_LIMIT/);
  assert.deepEqual([log.length, h.counts.posts], [1, 1]);
  const none = buildHostawayMirrorExecutors({ fetchImpl: fakeFetch([]), baseUrl: "https://api.hostaway.test", bearer: () => TOKEN, maxPosts: 0 });
  await assert.rejects(none.refundOfflineCharge(req, {}), /MIRROR_WIRE_LIMIT/);
  assert.throws(() => buildHostawayMirrorExecutors({ fetchImpl: fakeFetch([]), baseUrl: "https://api.hostaway.test", bearer: () => TOKEN, maxPosts: 2 }), /MAX_POSTS_INVALID/);
});

test("failures are codes only: a thrown fetch → TRANSPORT_FAILED (no raw error), an aborted signal → ABORTED, unparsable body → json null with the status, a short bearer refused before any call", async () => {
  const h = buildHostawayMirrorExecutors({ fetchImpl: async () => { throw new Error("ECONNRESET secret-host details"); }, baseUrl: "https://api.hostaway.test", bearer: () => TOKEN });
  await assert.rejects(h.listOfflineCharges({ method: "GET", path: "/v1/guestPayments/charges", query: {} }), (e) => e instanceof MirrorTransportError && e.code === "TRANSPORT_FAILED" && !e.message.includes("secret"));
  const ac = new AbortController(); ac.abort();
  const h2 = buildHostawayMirrorExecutors({ fetchImpl: async () => { throw new Error("aborted"); }, baseUrl: "https://api.hostaway.test", bearer: () => TOKEN });
  await assert.rejects(h2.listOfflineCharges({ method: "GET", path: "/v1/guestPayments/charges", query: {} }, { signal: ac.signal }), /ABORTED/);
  const h3 = buildHostawayMirrorExecutors({ fetchImpl: fakeFetch([], { status: 502, body: "<html>bad gateway</html>" }), baseUrl: "https://api.hostaway.test", bearer: () => TOKEN });
  assert.deepEqual(await h3.listOfflineCharges({ method: "GET", path: "/v1/guestPayments/charges", query: {} }), { httpStatus: 502, json: null });
  const log = [];
  const h4 = buildHostawayMirrorExecutors({ fetchImpl: fakeFetch(log), baseUrl: "https://api.hostaway.test", bearer: () => "short" });
  await assert.rejects(h4.listOfflineCharges({ method: "GET", path: "/v1/guestPayments/charges", query: {} }), /BEARER_INVALID/); assert.equal(log.length, 0);
  assert.throws(() => buildHostawayMirrorExecutors({ fetchImpl: fakeFetch([]), baseUrl: "http://api.hostaway.test", bearer: () => TOKEN }), /BASE_URL_INVALID/);
});

test("combination: exactly MIRROR_EXECUTOR_KEYS (Stripe reads + Hostaway executors); a missing executor refuses; the combined set passes the worker gate", () => {
  const stripe = buildStripeMirrorExecutors({ client: { retrieveAccount: async () => ({ object: "account", id: "acct_1X" }), retrievePaymentIntent: async () => ({}) } });
  const h = buildHostawayMirrorExecutors({ fetchImpl: fakeFetch([]), baseUrl: "https://api.hostaway.test", bearer: () => TOKEN });
  const ex = combineMirrorExecutors(stripe, h);
  assert.deepEqual(Object.keys(ex).sort(), [...MIRROR_EXECUTOR_KEYS].sort());
  assert.throws(() => combineMirrorExecutors(stripe, { listOfflineCharges: h.listOfflineCharges }), /EXECUTOR_MISSING_retrieveReservation/);
  assert.throws(() => buildStripeMirrorExecutors({ client: { retrieveAccount: async () => ({}) } }), /STRIPE_CLIENT_INVALID/);
  const g = mirrorWorkerGate({ env: { VERCEL_ENV: "development", MV_E7_TEST_CLEANUP: "enabled", MV_E7_MIRROR_WORKER: "enabled" }, adapterConfig: validateAdapterConfig({ allowedListingIds: [606998], refFieldId: 777004, channelId: 2000, currency: "USD" }),
    recordingConfig: { accountRef: "acct-test-1", channelId: 2000, currency: "USD", listingId: 606998, paymentMethod: "credit_card", refFieldId: 777004 }, listings: new Map([[606998, { currency: "USD", timeZone: "America/Mazatlan" }]]),
    executors: ex, clock: () => Date.now(), stripeAccountId: "acct_1X", intentId: "11111111-2222-4333-8444-555555555555" });
  assert.equal(g.ok, true, JSON.stringify(g));
});
