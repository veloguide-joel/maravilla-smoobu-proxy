// E7 connected-test runner SLICE T — one-shot HTTP transports (OFFLINE unit tests; no PG, no network, no provider, no install).
// LABELS: every `exchange` is an INJECTED FAKE that records invocations (credentials redacted in the record); every credential is SYNTHETIC
// (never a real token / key). Global fetch is guarded (0 attempts). The accepted adapters are used unchanged as the compatibility baseline.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createE7HostawaySend, createE7StripeTestSend, E7TransportError, ERROR_CODES, CHARGE_LIST_LIMIT, HOSTAWAY_MAX_BYTES, STRIPE_MAX_BYTES }
  from "../scripts/e7-connected/http-transports.mjs";
import { createPhaseExecutors, ExecutorTransportFailure } from "../scripts/e7-connected/executor-adapters.mjs";
import { offlineChargeTitle, exactAmount, formatScheduledDate, LIST_LIMIT } from "../lib/checkout/offline-charge-proof.js";
import { PROTECTED_HOSTAWAY_RESERVATION_IDS } from "../lib/checkout/compensation-proof.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let netAttempts = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { netAttempts += 1; throw new Error("network refused (offline transport suite)"); };
after(() => { globalThis.fetch = realFetch; assert.equal(netAttempts, 0, "no network attempt"); });

// ---- SYNTHETIC fixtures ---------------------------------------------------------------------------------------------------------
const HTOKEN = "synthetic-hostaway-token";                 // SYNTHETIC
const SKEY = "sk_test_Fake1";                              // SYNTHETIC test-prefix key (short: never a real key shape)
const VERSION = "2099-01-01.synthetic";                    // explicit SYNTHETIC Stripe-Version pin (the real one is B4, CLOSED)
const ACCT = "acct_1SyntheticAdapter"; const PI = "pi_test_syntheticAdapter1";
const L = 891001; const RID = "6100001"; const REF = "MV-ADPT0001"; const IN = "2026-12-04"; const OUT = "2026-12-06";
const INTENT = "00000000-0000-4000-8000-0000000000b1";
const GUEST = Object.freeze({ firstName: "Synthia", lastName: "Fixture", email: "guest.adapter@mv-test.invalid" });
const enc = (v) => new TextEncoder().encode(typeof v === "string" ? v : JSON.stringify(v));
const sig = () => new AbortController().signal;
const ok = (obj, status = 200) => ({ status, contentType: "application/json", bytes: enc(obj) });

/** INJECTED FAKE exchange: records each invocation (Authorization redacted), replies via `reply(req, n)` */
function fakeExchange(reply = () => ok({ status: "success", result: [] })) {
  const log = [];
  const exchange = async (req) => {
    log.push({ method: req.method, url: req.url, headers: { ...req.headers, Authorization: req.headers.Authorization ? "<redacted>" : undefined },
      body: req.body, maxBytes: req.maxBytes, signalIsGenuine: req.signal instanceof AbortSignal, auth: req.headers.Authorization });
    return reply(req, log.length);
  };
  return { exchange, log };
}
const hostaway = (reply, extra = {}) => { const f = fakeExchange(reply); let calls = 0; const r = createE7HostawaySend({ exchange: f.exchange, credential: () => { calls += 1; return HTOKEN; }, ...extra });
  assert.equal(r.ok, true, r.code); return { send: r.transport.send, log: f.log, creds: () => calls }; };
const stripe = (reply, extra = {}) => { const f = fakeExchange(reply); let calls = 0; const r = createE7StripeTestSend({ exchange: f.exchange, credential: () => { calls += 1; return SKEY; }, accountId: ACCT, apiVersion: VERSION, ...extra });
  assert.equal(r.ok, true, r.code); return { send: r.transport.send, log: f.log, creds: () => calls }; };
const codeOf = async (p) => { try { await p; return "RESOLVED"; } catch (e) { assert.ok(e instanceof E7TransportError, String(e)); assert.equal(e.message, "E7_TRANSPORT_ERROR"); return e.code; } };
const ACCOUNT = Object.freeze({ id: ACCT, object: "account", country: "US", charges_enabled: true });   // NO livemode: the real Account object has none
const PIOBJ = (o = {}) => ({ id: PI, object: "payment_intent", livemode: false, status: "requires_capture", amount: 50000, ...o });
const H = {
  lookup: (extra = {}) => ({ method: "GET", path: "/v1/reservations", query: { listingId: L, channelId: 2000, arrivalStartDate: IN, arrivalEndDate: IN, limit: 100, includeResources: 1, ...extra } }),
  byId: (id = RID) => ({ method: "GET", path: `/v1/reservations/${id}`, query: {} }),
  listing: () => ({ method: "GET", path: `/v1/listings/${L}`, query: {} }),
  calendar: () => ({ method: "GET", path: `/v1/listings/${L}/calendar`, query: { startDate: IN, endDate: OUT } }),
  price: () => ({ method: "POST", path: `/v1/listings/${L}/calendar/priceDetails`, query: {}, body: { startingDate: IN, endingDate: OUT, numberOfGuests: 2, version: 2 } }),
  create: (b = {}) => ({ method: "POST", path: "/v1/reservations", query: {}, body: { channelId: 2000, listingMapId: L, arrivalDate: IN, departureDate: OUT, numberOfGuests: 2, totalPrice: 500,
    currency: "USD", guestFirstName: GUEST.firstName, guestLastName: GUEST.lastName, guestName: `${GUEST.firstName} ${GUEST.lastName}`, guestEmail: GUEST.email,
    customFieldValues: [{ customFieldId: 777016, value: REF }], ...b } }),
  cancel: (id = RID) => ({ method: "PUT", path: `/v1/reservations/${id}/statuses/cancelled`, query: {}, body: { cancelledBy: "host" } }),
  charges: (q = { reservationId: RID, limit: 500 }) => ({ method: "GET", path: "/v1/guestPayments/charges", query: q }),
  charge: (id = RID) => ({ method: "POST", path: `/v1/guestPayments/charges/${id}`, query: {}, body: { title: offlineChargeTitle(INTENT), amount: 500, paymentMethod: "credit_card",
    scheduledDate: "2026-12-04 10:00:00", status: "paid" } })
};

// =================================================================================================================================
test("T1. factory options: exact keys / bounds; hostile shapes refused code-only without running any getter", () => {
  let getterRuns = 0;
  const ex = async () => ok({}); const cr = () => HTOKEN;
  const bad = [undefined, null, {}, { exchange: ex }, { exchange: ex, credential: cr, extra: 1 }, { exchange: "x", credential: cr }, { exchange: new Proxy(ex, {}), credential: cr },
    new Proxy({ exchange: ex, credential: cr }, {}), Object.defineProperty({ credential: cr }, "exchange", { enumerable: true, get() { getterRuns += 1; return ex; } }),
    { exchange: ex, credential: cr, maxBytes: 0 }, { exchange: ex, credential: cr, maxBytes: HOSTAWAY_MAX_BYTES + 1 }, { exchange: ex, credential: cr, maxBytes: 1.5 }, { exchange: ex, credential: cr, maxBytes: "1" }];
  for (const o of bad) assert.deepEqual({ ...createE7HostawaySend(o) }, { ok: false, code: "OPTIONS_INVALID" });
  const sbase = { exchange: ex, credential: () => SKEY, accountId: ACCT, apiVersion: VERSION };
  for (const o of [{ ...sbase, accountId: "acct_x/y" }, { ...sbase, accountId: undefined }, { ...sbase, apiVersion: "latest" }, { ...sbase, apiVersion: "2026-10-28 .x" },
    { ...sbase, maxBytes: STRIPE_MAX_BYTES + 1 }, { ...sbase, paymentIntentId: PI }]) assert.deepEqual({ ...createE7StripeTestSend(o) }, { ok: false, code: "OPTIONS_INVALID" });
  assert.equal(getterRuns, 0);
  const h = createE7HostawaySend({ exchange: ex, credential: cr });
  assert.ok(Object.isFrozen(h) && Object.isFrozen(h.transport) && Object.keys(h.transport).join() === "send", "the transport is exactly { send }");
  assert.deepEqual([...ERROR_CODES].includes("ACCOUNT_MISMATCH"), true);
});

test("T2. Hostaway H1–H9 exact HTTP mapping; H8 INTERNAL { reservationId, limit } → WIRE reservationIds=<id>&limit=500; statuses passed through", async () => {
  const t = hostaway((req) => ok({ status: "success", result: { echo: req.method } }));
  const cases = [
    [H.lookup(), "GET", `https://api.hostaway.com/v1/reservations?arrivalEndDate=${IN}&arrivalStartDate=${IN}&channelId=2000&includeResources=1&limit=100&listingId=${L}`, null],
    [H.lookup({ afterId: 42 }), "GET", `https://api.hostaway.com/v1/reservations?afterId=42&arrivalEndDate=${IN}&arrivalStartDate=${IN}&channelId=2000&includeResources=1&limit=100&listingId=${L}`, null],
    [H.byId(), "GET", `https://api.hostaway.com/v1/reservations/${RID}`, null],
    [H.listing(), "GET", `https://api.hostaway.com/v1/listings/${L}`, null],
    [H.calendar(), "GET", `https://api.hostaway.com/v1/listings/${L}/calendar?endDate=${OUT}&startDate=${IN}`, null],
    [H.price(), "POST", `https://api.hostaway.com/v1/listings/${L}/calendar/priceDetails`, JSON.stringify(H.price().body)],
    [H.create(), "POST", "https://api.hostaway.com/v1/reservations", JSON.stringify(H.create().body)],
    [H.cancel(), "PUT", `https://api.hostaway.com/v1/reservations/${RID}/statuses/cancelled`, '{"cancelledBy":"host"}'],
    [H.charges(), "GET", `https://api.hostaway.com/v1/guestPayments/charges?limit=500&reservationIds=${RID}`, null],
    [H.charges({ reservationId: Number(RID), limit: 500 }), "GET", `https://api.hostaway.com/v1/guestPayments/charges?limit=500&reservationIds=${RID}`, null],
    [H.charge(), "POST", `https://api.hostaway.com/v1/guestPayments/charges/${RID}`, JSON.stringify(H.charge().body)]
  ];
  for (const [req, method, url, body] of cases) {
    const r = await t.send(req, { signal: sig() });
    const rec = t.log.at(-1);
    assert.deepEqual([rec.method, rec.url, rec.body], [method, url, body], url);
    const hdr = Object.keys(rec.headers).filter((k) => rec.headers[k] !== undefined).sort();
    assert.deepEqual(hdr, body === null ? ["Accept", "Authorization", "Cache-control"] : ["Accept", "Authorization", "Cache-control", "Content-Type"]);
    assert.equal(rec.auth, `Bearer ${HTOKEN}`, "Bearer scheme (G-AUTH for guest-payment endpoints stays a live gate)");
    assert.deepEqual([rec.headers.Accept, rec.headers["Cache-control"], rec.maxBytes, rec.signalIsGenuine], ["application/json", "no-cache", HOSTAWAY_MAX_BYTES, true]);
    assert.deepEqual([r.httpStatus, r.json.result.echo], [200, method]);
    assert.ok(Object.isFrozen(r) && Object.isFrozen(r.json) && Object.isFrozen(r.json.result), "deep-frozen reply");
  }
  assert.equal(t.log.length, cases.length, "exactly one exchange per send");
  assert.equal(t.creds(), cases.length, "credential called once per permitted send");
  assert.ok(!t.log.some((x) => x.url.includes("reservationId=")), "the singular internal selector never reaches the wire");
  for (const st of [201, 401, 403, 404, 429, 503]) {
    const u = hostaway(() => ok({ status: "fail" }, st));
    const r = await u.send(H.byId(), { signal: sig() });
    assert.deepEqual([r.httpStatus, r.json.status, u.log.length], [st, "fail", 1], `status ${st} passed through; no re-mint / retry`);
  }
  for (const [label, bytes] of [["empty", new Uint8Array(0)], ["not JSON", enc("<html>")], ["bad UTF-8", new Uint8Array([0x7b, 0xff, 0x7d])], ["deep", enc("[".repeat(40) + "]".repeat(40))]]) {
    const u = hostaway(() => ({ status: 502, contentType: "text/html", bytes }));
    assert.deepEqual({ ...(await u.send(H.byId(), { signal: sig() })) }, { httpStatus: 502, json: null }, label);
  }
});

test("T3. Hostaway containment: non-allowlisted method / path / query / body / selector / protected id / hostile value → REQUEST_NOT_ALLOWED, ZERO exchanges and credential calls", async () => {
  const t = hostaway();
  const P = PROTECTED_HOSTAWAY_RESERVATION_IDS[0];
  const with_ = (r, k, v) => ({ ...r, [k]: v });
  const bad = [
    ["DELETE", with_(H.byId(), "method", "DELETE")], ["PATCH create", with_(H.create(), "method", "PATCH")],
    ["fragment", with_(H.byId(), "path", `/v1/reservations/${RID}#x`)], ["embedded query", with_(H.byId(), "path", `/v1/reservations/${RID}?forceOverbooking=1`)],
    ["escape", with_(H.byId(), "path", "/v1/reservations/%36100001")], ["dot segment", with_(H.byId(), "path", `/v1/reservations/../reservations/${RID}`)],
    ["double slash", with_(H.byId(), "path", `/v1//reservations/${RID}`)], ["host", with_(H.byId(), "path", "https://evil.example/v1/reservations/1")],
    ["scheme-relative", with_(H.byId(), "path", "//evil.example/v1/reservations/1")], ["port", with_(H.byId(), "path", ":8443/v1/reservations/1")],
    ["no /v1", with_(H.byId(), "path", `/reservations/${RID}`)], ["trailing slash", with_(H.byId(), "path", `/v1/reservations/${RID}/`)],
    ["create query forceOverbooking", with_(H.create(), "query", { forceOverbooking: 1 })], ["lookup extra key", H.lookup({ provider: "x" })],
    ["lookup channel", H.lookup({ channelId: 2002 })], ["lookup limit", H.lookup({ limit: 101 })], ["lookup string id", H.lookup({ listingId: String(L) })],
    ["H8 plural injected", H.charges({ reservationIds: RID, limit: 500 })], ["H8 both selectors", H.charges({ reservationId: RID, reservationIds: RID, limit: 500 })],
    ["H8 array", H.charges({ reservationId: [RID], limit: 500 })], ["H8 comma list", H.charges({ reservationId: `${RID},6100002`, limit: 500 })],
    ["H8 extra filter", H.charges({ reservationId: RID, limit: 500, statuses: "paid" })], ["H8 limit", H.charges({ reservationId: RID, limit: 100 })],
    ["protected by id", H.byId(P)], ["protected cancel", H.cancel(P)], ["protected charge", H.charge(P)], ["protected list", H.charges({ reservationId: P, limit: 500 })],
    ["cancel by guest", with_(H.cancel(), "body", { cancelledBy: "guest" })], ["create extra body", with_(H.create(), "body", { ...H.create().body, forceOverbooking: true })],
    ["charge description", with_(H.charge(), "body", { ...H.charge().body, description: "x" })], ["charge status", with_(H.charge(), "body", { ...H.charge().body, status: "pending" })],
    ["GET with body", { ...H.byId(), body: {} }], ["POST without body", { method: "POST", path: "/v1/reservations", query: {} }],
    ["headers field", { ...H.byId(), headers: { Host: "evil" } }], ["toJSON body", with_(H.price(), "body", { ...H.price().body, toJSON: () => ({}) })],
    ["__proto__ key", JSON.parse(`{"method":"GET","path":"/v1/reservations/${RID}","query":{},"__proto__":{"x":1}}`)],
    ["accessor request", Object.defineProperty({ method: "GET", query: {} }, "path", { enumerable: true, get() { throw new Error("getter ran"); } })],
    ["proxy request", new Proxy(H.byId(), {})], ["array", [H.byId()]], ["null", null]
  ];
  for (const [label, req] of bad) assert.equal(await codeOf(t.send(req, { signal: sig() })), "REQUEST_NOT_ALLOWED", label);
  assert.deepEqual([t.log.length, t.creds()], [0, 0], "zero exchanges, zero credential calls");
});

test("T4. signal + credential order: genuine native signal required; final recheck immediately before the exchange; no send after an observed abort", async () => {
  const t = hostaway();
  const aborted = new AbortController(); aborted.abort();
  const shadowed = new AbortController(); shadowed.abort(); Object.defineProperty(shadowed.signal, "aborted", { value: false });
  const rp = Proxy.revocable(sig(), {}); rp.revoke();
  let getterRuns = 0;
  for (const [label, opts, code] of [
    ["missing", undefined, "OPTIONS_INVALID"], ["no signal", {}, "OPTIONS_INVALID"], ["extra key", { signal: sig(), timeoutMs: 1 }, "OPTIONS_INVALID"],
    ["aborted", { signal: aborted.signal }, "ABORTED"], ["own aborted:false shadow on an aborted genuine signal", { signal: shadowed.signal }, "ABORTED"],
    ["prototype fake", { signal: Object.create(AbortSignal.prototype) }, "OPTIONS_INVALID"], ["proxy", { signal: new Proxy(sig(), {}) }, "OPTIONS_INVALID"],
    ["revoked proxy", { signal: rp.proxy }, "OPTIONS_INVALID"], ["plain fake", { signal: { aborted: false } }, "OPTIONS_INVALID"],
    ["hostile getter that would abort", Object.defineProperty({}, "signal", { enumerable: true, get() { getterRuns += 1; aborted.abort(); return sig(); } }), "OPTIONS_INVALID"]
  ]) assert.equal(await codeOf(t.send(H.byId(), opts)), code, label);
  assert.deepEqual([t.log.length, t.creds(), getterRuns], [0, 0, 0]);
  // the credential callback aborts the run signal → the final native recheck refuses BEFORE the exchange
  const f = fakeExchange(); const ac = new AbortController(); let cc = 0;
  const u = createE7HostawaySend({ exchange: f.exchange, credential: () => { cc += 1; ac.abort(); return HTOKEN; } }).transport;
  assert.equal(await codeOf(u.send(H.byId(), { signal: ac.signal })), "ABORTED");
  assert.deepEqual([f.log.length, cc], [0, 1], "credential called once, exchange never");
  // ordinary valid control
  assert.equal((await t.send(H.byId(), { signal: sig() })).httpStatus, 200);
});

test("T5. credential callback: once per permitted send, fixed code on throw / invalid value, nothing of it in errors", async () => {
  for (const [label, credential] of [["throws", () => { throw new Error(`boom ${HTOKEN}`); }], ["promise", async () => HTOKEN], ["number", () => 7], ["empty", () => ""],
    ["header injection", () => `${HTOKEN}\r\nX-Evil: 1`], ["space", () => "a b"]]) {
    const f = fakeExchange(); let n = 0;
    const t = createE7HostawaySend({ exchange: f.exchange, credential: () => { n += 1; return credential(); } }).transport;
    let err; try { await t.send(H.byId(), { signal: sig() }); } catch (e) { err = e; }
    assert.equal(err.code, "CREDENTIAL_INVALID", label);
    assert.ok(!JSON.stringify({ ...err, m: err.message, s: String(err.stack) }).includes(HTOKEN), `${label}: no token / raw error text retained`);
    assert.deepEqual([f.log.length, n], [0, 1], label);
  }
  for (const [label, key, code] of [["live secret", "sk_live_x", "KEY_NOT_TEST"], ["live restricted", "rk_live_y", "KEY_NOT_TEST"], ["test restricted (prefix not established)", "rk_test_z", "KEY_NOT_TEST"],
    ["publishable", "pk_test_q", "KEY_NOT_TEST"], ["empty", "", "CREDENTIAL_INVALID"], ["object", { k: SKEY }, "CREDENTIAL_INVALID"]]) {
    const f = fakeExchange(() => ok(ACCOUNT));
    const t = createE7StripeTestSend({ exchange: f.exchange, credential: () => key, accountId: ACCT, apiVersion: VERSION }).transport;
    let err; try { await t.send({ op: "accounts.retrieve" }, { signal: sig() }); } catch (e) { err = e; }
    assert.equal(err.code, code, label);
    assert.ok(!String(err.stack).includes(String(key)) || key === "", label);
    assert.equal(f.log.length, 0, `${label}: zero exchanges`);
  }
});

test("T6. exchange: exactly one call, never retried; rejection / sync throw / non-native promise / 3xx / bad envelope / hang / late reply", async () => {
  const run = async (exchange, signal = sig()) => { let n = 0; const t = createE7HostawaySend({ exchange: (r) => { n += 1; return exchange(r); }, credential: () => HTOKEN }).transport;
    const code = await codeOf(t.send(H.cancel(), { signal })); return [code, n]; };
  assert.deepEqual(await run(async () => { throw new Error("x"); }), ["EXCHANGE_FAILED", 1]);
  assert.deepEqual(await run(() => { throw new Error("sync"); }), ["EXCHANGE_FAILED", 1]);
  assert.deepEqual(await run(() => ({ then: (r) => r(ok({})) })), ["EXCHANGE_FAILED", 1], "a thenable is not a native promise");
  assert.deepEqual(await run(() => Object.assign(Promise.resolve(ok({})), { extra: 1 })), ["EXCHANGE_FAILED", 1], "a patched promise is refused");
  assert.deepEqual(await run(() => Object.defineProperty(Promise.resolve(ok({})), "then", { value: (r) => r(ok({})) })), ["EXCHANGE_FAILED", 1], "own then");
  assert.deepEqual(await run(() => Object.defineProperty(Promise.resolve(ok({})), "constructor", { value: function X() {} })), ["EXCHANGE_FAILED", 1], "own constructor (species)");
  assert.deepEqual(await run(() => Object.defineProperty(Promise.resolve(ok({})), Symbol.toStringTag, { value: "x" })), ["EXCHANGE_FAILED", 1], "own well-known symbol");
  class SubP extends Promise {}
  assert.deepEqual(await run(() => SubP.resolve(ok({}))), ["EXCHANGE_FAILED", 1], "Promise subclass");
  for (const st of [301, 302, 307, 308]) assert.deepEqual(await run(async () => ({ status: st, contentType: null, bytes: new Uint8Array(0) })), ["REDIRECT_REFUSED", 1], `${st}: never followed`);
  assert.deepEqual(await run(async () => ({ status: 200, bytes: enc("{}") })), ["REPLY_INVALID", 1], "missing envelope key");
  assert.deepEqual(await run(async () => ({ ...ok({}), extra: 1 })), ["REPLY_INVALID", 1]);
  assert.deepEqual(await run(async () => ({ ...ok({}), status: 700 })), ["REPLY_INVALID", 1]);
  assert.deepEqual(await run(async () => Object.defineProperty({ contentType: null, bytes: enc("{}") }, "status", { enumerable: true, get() { throw new Error("getter"); } })), ["REPLY_INVALID", 1]);
  const ac = new AbortController();
  assert.deepEqual(await run((r) => new Promise((res, rej) => { ac.abort(); rej(new Error("aborted")); }), ac.signal), ["ABORTED_IN_FLIGHT", 1], "abort after start: no retry");
  // a hanging exchange keeps the send pending and is never re-invoked; a late reply produces no follow-up request
  let release; let n = 0;
  const t = createE7HostawaySend({ exchange: () => { n += 1; return new Promise((r) => { release = r; }); }, credential: () => HTOKEN }).transport;
  const p = t.send(H.charge(), { signal: sig() });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(n, 1);
  release(ok({ status: "success" }, 201));
  assert.equal((await p).httpStatus, 201);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(n, 1, "late reply: no follow-up exchange");
});

test("T7. reply bytes: intrinsic typed-array inspection — accessor shadows ignored; subclass / proxy / revoked / shared / detached / oversize refused; sliced view copied", async () => {
  const send = async (bytes, max) => { const t = createE7HostawaySend({ exchange: async () => ({ status: 200, contentType: "application/json", bytes }), credential: () => HTOKEN, ...(max ? { maxBytes: max } : {}) }).transport;
    try { return { r: await t.send(H.byId(), { signal: sig() }) }; } catch (e) { return { code: e.code }; } };
  const good = enc({ status: "success", result: { id: 1 } });
  const shadow = enc({ status: "success", result: { id: 2 } });
  Object.defineProperty(shadow, "byteLength", { get() { throw new Error("shadow getter ran"); } });
  Object.defineProperty(shadow, "buffer", { get() { throw new Error("shadow getter ran"); } });
  Object.defineProperty(shadow, Symbol.iterator, { value() { throw new Error("iterator ran"); } });
  assert.equal((await send(shadow)).r.json.result.id, 2, "own accessor shadows / iterator never consulted");
  class Sub extends Uint8Array {}
  const rp = Proxy.revocable(good, {}); rp.revoke();
  const sab = new Uint8Array(new SharedArrayBuffer(good.length)); sab.set(good);
  const det = new Uint8Array(new ArrayBuffer(good.length)); det.set(good); structuredClone(det.buffer, { transfer: [det.buffer] });
  for (const [label, b, code] of [["subclass", new Sub(good), "REPLY_INVALID"], ["Buffer (subclass)", Buffer.from(good), "REPLY_INVALID"], ["proxy", new Proxy(good, {}), "REPLY_INVALID"],
    ["revoked", rp.proxy, "REPLY_INVALID"], ["shared", sab, "REPLY_INVALID"], ["detached", det, "REPLY_INVALID"], ["array", [...good], "REPLY_INVALID"], ["string", "{}", "REPLY_INVALID"],
    ["DataView", new DataView(good.buffer), "REPLY_INVALID"]]) assert.equal((await send(b)).code, code, label);
  assert.equal((await send(new Uint8Array(17), 16)).code, "BODY_TOO_LARGE");
  assert.equal((await send(enc("1234567890123456"), 16)).r.json, 1234567890123456, "exactly maxBytes accepted");
  const big = new Uint8Array(100); big.set(enc('{"status":"success","result":{"id":3}}'), 40);
  const view = big.subarray(40, 40 + enc('{"status":"success","result":{"id":3}}').length);
  const r = (await send(view)).r;
  assert.equal(r.json.result.id, 3, "only the view's bytes");
  view.fill(0x20);
  assert.equal(r.json.result.id, 3, "caller mutation after return cannot affect the frozen reply");
});

test("T8. Stripe S1–S4 exact mapping, TEST-only key, operation-specific reply checks (Account has NO livemode; PaymentIntent strict)", async () => {
  const t = stripe((req) => (req.url.endsWith("/v1/account") ? ok(ACCOUNT) : ok(PIOBJ())));
  const calls = [
    [{ op: "accounts.retrieve" }, "GET", "https://api.stripe.com/v1/account", null, null],
    [{ op: "paymentIntents.retrieve", id: PI, params: { expand: ["latest_charge"] } }, "GET", `https://api.stripe.com/v1/payment_intents/${PI}?expand%5B%5D=latest_charge`, null, null],
    [{ op: "paymentIntents.capture", id: PI, params: { amount_to_capture: 50000, final_capture: true, expand: ["latest_charge"] }, idempotencyKey: `cap:${INTENT}:${PI}` }, "POST",
      `https://api.stripe.com/v1/payment_intents/${PI}/capture`, "amount_to_capture=50000&final_capture=true&expand%5B%5D=latest_charge", `cap:${INTENT}:${PI}`],
    [{ op: "paymentIntents.cancel", id: PI, params: {}, idempotencyKey: `void:${INTENT}:${PI}` }, "POST", `https://api.stripe.com/v1/payment_intents/${PI}/cancel`, "", `void:${INTENT}:${PI}`]
  ];
  for (const [call, method, url, body, idem] of calls) {
    const r = await t.send(call, { signal: sig() });
    const rec = t.log.at(-1);
    assert.deepEqual([rec.method, rec.url, rec.body, rec.auth, rec.headers["Stripe-Version"], rec.headers["Idempotency-Key"]], [method, url, body, `Bearer ${SKEY}`, VERSION, idem ?? undefined], url);
    assert.equal(rec.headers["Content-Type"], method === "POST" ? "application/x-www-form-urlencoded" : undefined);
    assert.ok(!("Stripe-Account" in rec.headers));
    assert.ok(Object.isFrozen(r));
  }
  assert.equal("livemode" in (await t.send({ op: "accounts.retrieve" }, { signal: sig() })), false, "the Account fixture carries no livemode and is accepted");
  const one = async (reply, call = { op: "paymentIntents.retrieve", id: PI, params: { expand: ["latest_charge"] } }) => { const u = stripe(() => reply); const c = await codeOf(u.send(call, { signal: sig() })); return [c, u.log.length]; };
  assert.deepEqual(await one(ok({ ...ACCOUNT, id: "acct_other" }), { op: "accounts.retrieve" }), ["ACCOUNT_MISMATCH", 1]);
  assert.deepEqual(await one(ok({ ...ACCOUNT, object: "customer" }), { op: "accounts.retrieve" }), ["ACCOUNT_MISMATCH", 1]);
  assert.deepEqual(await one(ok(PIOBJ({ livemode: true }))), ["LIVEMODE_REFUSED", 1]);
  assert.deepEqual(await one(ok((({ livemode, ...x }) => x)(PIOBJ()))), ["LIVEMODE_REFUSED", 1], "a PaymentIntent without livemode:false is refused");
  assert.deepEqual(await one(ok(PIOBJ({ id: "pi_other" }))), ["REPLY_INVALID", 1]);
  assert.deepEqual(await one(ok(PIOBJ({ object: "charge" }))), ["REPLY_INVALID", 1]);
  assert.deepEqual(await one(ok([PIOBJ()])), ["REPLY_INVALID", 1]);
  assert.deepEqual(await one({ status: 200, contentType: "text/plain", bytes: enc("nope") }), ["JSON_INVALID", 1]);
  for (const [st, code] of [[400, "STRIPE_HTTP_4XX"], [402, "STRIPE_HTTP_4XX"], [409, "STRIPE_HTTP_4XX"], [429, "STRIPE_HTTP_4XX"], [500, "STRIPE_HTTP_5XX"], [503, "STRIPE_HTTP_5XX"]]) {
    assert.deepEqual(await one(ok({ error: { type: "api_error", message: "provider text" } }, st)), [code, 1], `${st}: code only, one exchange`);
  }
  const z = stripe(() => ok(PIOBJ()));
  for (const [label, call] of [["unknown op", { op: "refunds.create" }], ["account with id", { op: "accounts.retrieve", id: ACCT }],
    ["retrieve without expand", { op: "paymentIntents.retrieve", id: PI, params: {} }], ["path injection", { op: "paymentIntents.retrieve", id: `${PI}/../../v1/charges`, params: { expand: ["latest_charge"] } }],
    ["capture no key", { op: "paymentIntents.capture", id: PI, params: { amount_to_capture: 1, final_capture: true, expand: ["latest_charge"] } }],
    ["capture partial", { op: "paymentIntents.capture", id: PI, params: { amount_to_capture: 1, final_capture: false, expand: ["latest_charge"] }, idempotencyKey: "k" }],
    ["capture extra param", { op: "paymentIntents.capture", id: PI, params: { amount_to_capture: 1, final_capture: true, expand: ["latest_charge"], metadata: {} }, idempotencyKey: "k" }],
    ["cancel with reason", { op: "paymentIntents.cancel", id: PI, params: { cancellation_reason: "abandoned" }, idempotencyKey: "k" }],
    ["cancel bad key", { op: "paymentIntents.cancel", id: PI, params: {}, idempotencyKey: "k\n" }]]) assert.equal(await codeOf(z.send(call, { signal: sig() })), "REQUEST_NOT_ALLOWED", label);
  assert.deepEqual([z.log.length, z.creds()], [0, 0]);
});

test("T9. accepted createPhaseExecutors over these transports (all five gate key sets): same internal envelopes, exact wire, adapter error propagation", async () => {
  const route = (req) => {
    if (req.url.startsWith("https://api.stripe.com")) return ok(req.url.endsWith("/v1/account") ? ACCOUNT : PIOBJ());
    if (req.url.includes("/guestPayments/charges?")) return ok({ status: "success", result: [], count: 0, offset: null });
    return ok({ status: "success", result: {} });
  };
  const h = hostaway(route); const s = stripe(route);
  const B = {
    reservation: { listingId: L, arrivalDate: IN, departureDate: OUT, ref: REF, guests: 2, totalMinor: 50000, currency: "USD", refFieldId: 777016, guest: { ...GUEST }, reservationId: null },
    "reservation-recovery": { listingId: L, arrivalDate: IN, departureDate: OUT, ref: REF, guests: 2, totalMinor: 50000, currency: "USD", refFieldId: 777016, guest: { ...GUEST }, reservationId: RID },
    capture: { listingId: L, arrivalDate: IN, departureDate: OUT, ref: REF, reservationId: RID, accountId: ACCT, paymentIntentId: PI, amountMinor: 50000, captureIdempotencyKey: `cap:${INTENT}:${PI}` },
    cleanup: { listingId: L, arrivalDate: IN, departureDate: OUT, ref: REF, reservationId: RID, accountId: ACCT, paymentIntentId: PI, voidIdempotencyKey: `void:${INTENT}:${PI}` },
    recording: { listingId: L, reservationId: RID, intentId: INTENT, amountMinor: 50000, paymentMethod: "credit_card", accountRef: "acct-test-1", clientSnapshotId: "client-AD" }
  };
  const ex = (phase) => { const r = createPhaseExecutors({ phase, binding: B[phase], hostaway: h.send ? { send: h.send } : null, ...(phase === "capture" || phase === "cleanup" ? { stripe: { send: s.send } } : {}) });
    assert.equal(r.ok, true, r.code); return r.executors; };
  const o = () => ({ signal: sig() });
  const R = ex("reservation");
  assert.equal((await R.pricing.get(`/listings/${L}`, o())).status, 200);
  await R.pricing.get(`/listings/${L}/calendar`, { signal: sig(), query: { startDate: IN, endDate: OUT } });
  await R.pricing.post(`/listings/${L}/calendar/priceDetails`, { startingDate: IN, endingDate: OUT, numberOfGuests: 2, version: 2 }, o());
  await R.lookupPage({ method: "GET", path: "/reservations", query: { listingId: L, channelId: 2000, arrivalStartDate: IN, arrivalEndDate: IN, limit: 100, includeResources: 1 } }, o());
  await R.createReservation({ method: "POST", path: "/reservations", query: {}, body: { ...H.create().body, totalPrice: exactAmount(50000) } }, o());
  const RR = ex("reservation-recovery");
  await RR.retrieveReservation({ method: "GET", path: `/reservations/${RID}`, query: {} }, o());
  const C = ex("capture");
  await C.retrieveAccount(o());
  await C.retrievePaymentIntent(PI, { expand: ["latest_charge"] }, o());
  await C.capturePaymentIntent(PI, { amount_to_capture: 50000, final_capture: true, expand: ["latest_charge"] }, { signal: sig(), idempotencyKey: `cap:${INTENT}:${PI}` });
  const K = ex("cleanup");
  await K.cancelPaymentIntent(PI, {}, { signal: sig(), idempotencyKey: `void:${INTENT}:${PI}` });
  await K.cancelReservation({ method: "PUT", path: `/reservations/${RID}/statuses/cancelled`, query: {}, body: { cancelledBy: "host" } }, o());
  const W = ex("recording");
  await W.retrieveReservation({ method: "GET", path: `/reservations/${RID}`, query: {} }, o());
  const list = await W.listOfflineCharges({ method: "GET", path: "/guestPayments/charges", query: { reservationId: RID, limit: LIST_LIMIT } }, o());
  assert.deepEqual([list.httpStatus, list.json.count], [200, 0], "INTERNAL envelope accepted unchanged by the adapter; reply passed through");
  await W.createOfflineCharge({ method: "POST", path: `/guestPayments/charges/${RID}`, query: {}, body: { title: offlineChargeTitle(INTENT), amount: exactAmount(50000), paymentMethod: "credit_card",
    scheduledDate: formatScheduledDate(Date.UTC(2026, 11, 4, 17)), status: "paid" } }, o());
  assert.deepEqual(h.log.map((x) => `${x.method} ${x.url.replace("https://api.hostaway.com", "")}`), [
    `GET /v1/listings/${L}`, `GET /v1/listings/${L}/calendar?endDate=${OUT}&startDate=${IN}`, `POST /v1/listings/${L}/calendar/priceDetails`,
    `GET /v1/reservations?arrivalEndDate=${IN}&arrivalStartDate=${IN}&channelId=2000&includeResources=1&limit=100&listingId=${L}`, "POST /v1/reservations",
    `GET /v1/reservations/${RID}`, `PUT /v1/reservations/${RID}/statuses/cancelled`, `GET /v1/reservations/${RID}`,
    `GET /v1/guestPayments/charges?limit=500&reservationIds=${RID}`, `POST /v1/guestPayments/charges/${RID}`]);
  assert.deepEqual(s.log.map((x) => `${x.method} ${x.url.replace("https://api.stripe.com", "")} ${x.headers["Idempotency-Key"] ?? "-"}`), [
    "GET /v1/account -", `GET /v1/payment_intents/${PI}?expand%5B%5D=latest_charge -`, `POST /v1/payment_intents/${PI}/capture cap:${INTENT}:${PI}`,
    `POST /v1/payment_intents/${PI}/cancel void:${INTENT}:${PI}`]);
  // adapter error propagation: a transport rejection becomes the adapter's code-only ExecutorTransportFailure; statuses still pass through
  const s5 = stripe(() => ok({ error: {} }, 500));
  const c5 = createPhaseExecutors({ phase: "capture", binding: B.capture, hostaway: { send: h.send }, stripe: { send: s5.send } }).executors;
  await assert.rejects(c5.retrievePaymentIntent(PI, { expand: ["latest_charge"] }, o()), (e) => e instanceof ExecutorTransportFailure && e.code === "TRANSPORT_FAILED");
  const h4 = hostaway(() => ok({ status: "fail" }, 404));
  const w4 = createPhaseExecutors({ phase: "recording", binding: B.recording, hostaway: { send: h4.send } }).executors;
  assert.equal((await w4.retrieveReservation({ method: "GET", path: `/reservations/${RID}`, query: {} }, o())).httpStatus, 404);
  assert.equal(s5.log.length + h4.log.length, 2, "one exchange each, no retry");
});

test("T10. source pins: imports, no default network / env / timers / fs / SDK, no pinned identifiers; constants equal accepted values", () => {
  const src = readFileSync(join(ROOT, "scripts/e7-connected/http-transports.mjs"), "utf8");
  const imports = [...src.matchAll(/^import\s.*?from\s+"([^"]+)";$/gm)].map((m) => m[1]).sort();
  assert.deepEqual(imports, ["../../lib/checkout/compensation-proof.js", "node:util"]);
  const code = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const re of [/\bfetch\s*\(/, /node:(https?|net|tls|fs|child_process|timers|dns)/, /undici|from\s+["']stripe["']/, /process\./, /setTimeout|setInterval|setImmediate/,
    /console\./, /hostaway-reservations|createHostawayTransport|allowRequest:|connectedTestAdapterConfig/, /\bretry\b/i]) assert.doesNotMatch(code, re, String(re));
  assert.equal(CHARGE_LIST_LIMIT, LIST_LIMIT);
  assert.equal(netAttempts, 0);
});

// ---- root CODE HOLD on b4150809: R-TC1 / R-TC2 / R-TC3 (each FAILS on exact b4150809; see contract §11.1) -------------------------
const PI_CALL = { op: "paymentIntents.retrieve", id: PI, params: { expand: ["latest_charge"] } };

test("T11 (R-TC1). abort AFTER the exchange started: fulfilled OR rejected settlement → ABORTED_IN_FLIGHT, one exchange, no follow-up; controls succeed", async () => {
  for (const provider of ["hostaway", "stripe"]) {
    const reply = provider === "hostaway" ? ok({ status: "success", result: {} }) : ok(PIOBJ());
    const call = provider === "hostaway" ? H.cancel() : PI_CALL;
    const mk = (exchange) => { let n = 0; const ex = (r) => { n += 1; return exchange(r); };
      const t = provider === "hostaway" ? createE7HostawaySend({ exchange: ex, credential: () => HTOKEN }).transport
        : createE7StripeTestSend({ exchange: ex, credential: () => SKEY, accountId: ACCT, apiVersion: VERSION }).transport;
      return { t, n: () => n }; };
    { const ac = new AbortController(); const u = mk(() => { ac.abort(); return Promise.resolve(reply); });
      assert.deepEqual([await codeOf(u.t.send(call, { signal: ac.signal })), u.n()], ["ABORTED_IN_FLIGHT", 1], `${provider}: fulfil after abort`); }
    { const ac = new AbortController(); const u = mk(() => new Promise((res) => { queueMicrotask(() => { ac.abort(); res(reply); }); }));
      assert.deepEqual([await codeOf(u.t.send(call, { signal: ac.signal })), u.n()], ["ABORTED_IN_FLIGHT", 1], `${provider}: abort while pending, then fulfil`); }
    { const ac = new AbortController(); const u = mk(() => { ac.abort(); return Promise.reject(new Error("synthetic")); });
      assert.deepEqual([await codeOf(u.t.send(call, { signal: ac.signal })), u.n()], ["ABORTED_IN_FLIGHT", 1], `${provider}: reject after abort`); }
    { const u = mk(() => Promise.resolve(reply)); const r = await u.t.send(call, { signal: sig() });
      assert.equal(u.n(), 1); assert.ok(provider === "hostaway" ? r.httpStatus === 200 : r.object === "payment_intent", `${provider}: ordinary success control`); }
    { const u = mk(() => Promise.reject(new Error("synthetic")));
      assert.deepEqual([await codeOf(u.t.send(call, { signal: sig() })), u.n()], ["EXCHANGE_FAILED", 1], `${provider}: ordinary rejection control`); }
  }
});

test("T12 (R-TC2). Promise[@@species] / inherited constructor getters armed by the exchange: ZERO getter runs, code-only refusal; genuine controls pass", async () => {
  const targets = [["Promise[@@species]", Promise, Symbol.species], ["Promise.prototype.constructor", Promise.prototype, "constructor"]];
  for (const provider of ["hostaway", "stripe"]) {
    for (const [label, target, key] of targets) {
      const orig = Object.getOwnPropertyDescriptor(target, key);
      let runs = 0; let n = 0;
      const exchange = () => { n += 1; const p = Promise.resolve(provider === "hostaway" ? ok({}) : ok(PIOBJ()));
        Object.defineProperty(target, key, { configurable: true, get() { runs += 1; return orig.value ?? Promise; } }); return p; };
      const t = provider === "hostaway" ? createE7HostawaySend({ exchange, credential: () => HTOKEN }).transport
        : createE7StripeTestSend({ exchange, credential: () => SKEY, accountId: ACCT, apiVersion: VERSION }).transport;
      let p, during;
      try { p = t.send(provider === "hostaway" ? H.byId() : PI_CALL, { signal: sig() }); during = runs; }
      finally { Object.defineProperty(target, key, orig); }                  // restored BEFORE this test's own await (an await reads constructor)
      assert.deepEqual(Object.getOwnPropertyDescriptor(target, key), orig, "descriptor restored");
      assert.equal(await codeOf(p), "EXCHANGE_FAILED", `${provider} ${label}`);
      assert.deepEqual([during, runs, n], [0, 0, 1], `${provider} ${label}: the module ran no getter; one exchange, no retry`);
    }
    // genuine control under node:test (async_hooks symbol DATA props present), after restoration
    const g = provider === "hostaway" ? hostaway() : stripe(() => ok(PIOBJ()));
    const r = await g.send(provider === "hostaway" ? H.byId() : PI_CALL, { signal: sig() });
    assert.ok(provider === "hostaway" ? r.httpStatus === 200 : r.id === PI);
  }
  // send itself returns a promise made by the captured native constructor, with no own properties beyond async_hooks symbols
  const sp = hostaway().send(H.byId(), { signal: sig() });
  assert.ok(sp instanceof Promise && Object.getPrototypeOf(sp) === Promise.prototype && Object.keys(sp).length === 0);
  await sp;
  // original rejection identity is never leaked
  const boom = new Error("synthetic exchange failure detail");
  let err; try { await createE7HostawaySend({ exchange: () => Promise.reject(boom), credential: () => HTOKEN }).transport.send(H.byId(), { signal: sig() }); } catch (e) { err = e; }
  assert.ok(err instanceof E7TransportError && err !== boom && err.cause === undefined && !String(err.stack).includes("synthetic exchange failure detail"));
});

test("T13 (R-TC3). credential returning a REJECTED native promise: CREDENTIAL_INVALID, one call, zero exchanges, ZERO unhandled rejections; async credential refused at construction", async () => {
  let unhandled = 0; const onU = () => { unhandled += 1; };
  process.on("unhandledRejection", onU);
  try {
    for (const make of [() => createE7HostawaySend, () => createE7StripeTestSend]) {
      const factory = make(); let c = 0; let x = 0;
      const base = { exchange: () => { x += 1; return Promise.resolve(ok(ACCOUNT)); }, credential: () => { c += 1; return Promise.reject(new Error("synthetic rejected credential")); } };
      const t = factory(factory === createE7StripeTestSend ? { ...base, accountId: ACCT, apiVersion: VERSION } : base).transport;
      let err; try { await t.send(factory === createE7StripeTestSend ? { op: "accounts.retrieve" } : H.byId(), { signal: sig() }); } catch (e) { err = e; }
      assert.equal(err.code, "CREDENTIAL_INVALID");
      assert.ok(!String(err.stack).includes("synthetic rejected credential") && err.cause === undefined, "no original error retained");
      assert.deepEqual([c, x], [1, 0]);
      // a caller THENABLE is never assimilated: its then is not called
      let thenRuns = 0; const thenable = { then() { thenRuns += 1; } };
      const t2 = factory(factory === createE7StripeTestSend ? { ...base, credential: () => thenable, accountId: ACCT, apiVersion: VERSION } : { ...base, credential: () => thenable }).transport;
      assert.equal(await codeOf(t2.send(factory === createE7StripeTestSend ? { op: "accounts.retrieve" } : H.byId(), { signal: sig() })), "CREDENTIAL_INVALID");
      assert.equal(thenRuns, 0);
      assert.deepEqual({ ...factory({ ...base, credential: async () => HTOKEN, ...(factory === createE7StripeTestSend ? { accountId: ACCT, apiVersion: VERSION } : {}) }) }, { ok: false, code: "OPTIONS_INVALID" });
    }
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(unhandled, 0, "in-process: zero unhandled rejections");
  } finally { process.off("unhandledRejection", onU); }
  // process-level isolation: a bounded child process (test-file only; the runtime module imports no child_process)
  const { spawnSync } = await import("node:child_process");
  const mod = join(ROOT, "scripts/e7-connected/http-transports.mjs");
  const script = `import { createE7HostawaySend } from ${JSON.stringify("file://" + mod)};
let u = 0; process.on("unhandledRejection", () => { u += 1; });
const t = createE7HostawaySend({ exchange: () => Promise.resolve({ status: 200, contentType: null, bytes: new Uint8Array(0) }), credential: () => Promise.reject(new Error("synthetic")) }).transport;
let code; try { await t.send({ method: "GET", path: "/v1/reservations/6100001", query: {} }, { signal: new AbortController().signal }); } catch (e) { code = e.code; }
await new Promise((r) => setTimeout(r, 50));
process.stdout.write(JSON.stringify({ code, u }));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 10_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { code: "CREDENTIAL_INVALID", u: 0 }, "child process: zero unhandled rejections");
});
