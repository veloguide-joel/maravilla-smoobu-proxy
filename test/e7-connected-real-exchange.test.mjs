// E7 connected-test runner SLICE X — the real exchange (OFFLINE unit tests; no network, DNS, socket, TLS, certificate, loopback, provider,
// PG or install). LABELS: every exchange in this file runs over an INJECTED FAKE primitive (EventEmitter doubles modelled on the
// documented Node http.request event orders). These tests prove the module's option / validation / event-state logic ONLY — not real
// TLS, DNS, socket or native Node event ordering. The real default primitive is replaced by COUNTING GUARDS before the module loads (so
// even an accidental default call cannot reach node:https); the guards must count zero. All credentials are SYNTHETIC.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, getEventListeners } from "node:events";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";

// ---- guards installed BEFORE the module under test is loaded --------------------------------------------------------------------
const GUARD = { request: 0, Agent: 0 };
const realRequest = https.request; const RealAgent = https.Agent;
function guardRequest() { GUARD.request += 1; throw new Error("real https.request refused in the offline Slice X suite"); }
function GuardAgent() { GUARD.Agent += 1; throw new Error("real https.Agent refused in the offline Slice X suite"); }
https.request = guardRequest; https.Agent = GuardAgent; syncBuiltinESMExports();
const X = await import("../scripts/e7-connected/real-exchange.mjs");
https.request = realRequest; https.Agent = RealAgent; syncBuiltinESMExports();
const { createE7RealExchange, E7ExchangeError, NODE_HTTPS_PRIMITIVE, AGENT_OPTIONS, MAX_BYTES_CAP, EXCHANGE_ERROR_CODES } = X;
const { createE7HostawaySend, createE7StripeTestSend, E7TransportError } = await import("../scripts/e7-connected/http-transports.mjs");
const { offlineChargeTitle } = await import("../lib/checkout/offline-charge-proof.js");
const { PROTECTED_HOSTAWAY_RESERVATION_IDS } = await import("../lib/checkout/compensation-proof.js");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let netAttempts = 0; const realFetch = globalThis.fetch;
globalThis.fetch = async () => { netAttempts += 1; throw new Error("network refused (offline Slice X suite)"); };
let unhandled = 0; const onU = () => { unhandled += 1; }; process.on("unhandledRejection", onU);
let uncaught = 0; const onX = () => { uncaught += 1; }; process.on("uncaughtException", onX);
after(() => {
  globalThis.fetch = realFetch; process.off("unhandledRejection", onU); process.off("uncaughtException", onX);
  assert.deepEqual([netAttempts, GUARD.request, GUARD.Agent, unhandled, uncaught], [0, 0, 0, 0, 0], "no network, no real primitive, no unhandled rejection / uncaught error");
});

// ---- SYNTHETIC values ----------------------------------------------------------------------------------------------------------------
const HTOKEN = "synthetic-hostaway-token"; const SKEY = "sk_test_Fake1"; const VERSION = "2099-01-01.synthetic";
const ACCT = "acct_1SyntheticAdapter"; const PI = "pi_test_syntheticAdapter1"; const RID = "6100001"; const L = 891001;
const IN = "2026-12-04"; const OUT = "2026-12-06"; const INTENT = "00000000-0000-4000-8000-0000000000b1";
const tick = () => new Promise((r) => setImmediate(r));
const sig = () => new AbortController().signal;
const HREQ = (o = {}) => ({ method: "GET", url: `https://api.hostaway.com/v1/reservations/${RID}`, headers: { Accept: "application/json", Authorization: `Bearer ${HTOKEN}`, "Cache-control": "no-cache" },
  body: null, signal: sig(), maxBytes: 1024, ...o });
const HPOST = (o = {}) => HREQ({ method: "POST", url: "https://api.hostaway.com/v1/reservations", headers: { Accept: "application/json", Authorization: `Bearer ${HTOKEN}`, "Cache-control": "no-cache",
  "Content-Type": "application/json" }, body: '{"a":"é"}', ...o });
const SREQ = (o = {}) => ({ method: "POST", url: `https://api.stripe.com/v1/payment_intents/${PI}/capture`, headers: { Authorization: `Bearer ${SKEY}`, "Stripe-Version": VERSION,
  "Content-Type": "application/x-www-form-urlencoded", "Idempotency-Key": `cap:${INTENT}:${PI}` }, body: "amount_to_capture=50000&final_capture=true&expand%5B%5D=latest_charge", signal: sig(), maxBytes: 1024, ...o });

// ---- FAKE primitive (TEST-ONLY) -----------------------------------------------------------------------------------------------------
class FakeRes extends EventEmitter {
  constructor(req, statusCode, rawHeaders) { super(); this.req = req; this.statusCode = statusCode; this.rawHeaders = rawHeaders; this.complete = false; this.destroyCalls = 0; this.closed = false; }
  destroy() { this.destroyCalls += 1; if (this._d) return; this._d = true; process.nextTick(() => { if (!this.closed) { this.closed = true; this.emit("close"); } this.req._closeOnce(); }); }
}
class FakeReq extends EventEmitter {
  constructor(fx, options) { super(); this.fx = fx; this.options = options; this.endCalls = 0; this.endArgs = null; this.destroyCalls = 0; this.res = null; this.closed = false; this.removeAllCalls = 0; }
  end(...a) { this.endCalls += 1; this.endArgs = a; if (this.fx.onEnd) this.fx.onEnd(this); }
  removeAllListeners(...a) { this.removeAllCalls += 1; return super.removeAllListeners(...a); }
  _closeOnce() { if (!this.closed) { this.closed = true; this.emit("close"); } }
  /** documented orders: before a response → error(ECONNRESET), close; after a response → res aborted, req close, res error, res close */
  destroy() {
    this.destroyCalls += 1; if (this._d) return; this._d = true;
    const go = () => {
      const res = this.res;
      if (res === null) { this.emit("error", Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })); this._closeOnce(); return; }
      if (!res.closed) { res.emit("aborted"); this._closeOnce(); res.emit("error", Object.assign(new Error("aborted"), { code: "ECONNRESET" })); res.closed = true; res.emit("close"); }
      else this._closeOnce();
    };
    if (this.fx.syncDestroy) go(); else process.nextTick(go);
  }
}
function fakePrimitive(cfg = {}) {
  const fx = { agents: [], reqs: [], ...cfg };
  class FakeAgent { constructor(opts) { if (fx.agentCtor) fx.agentCtor(); this.opts = opts; this.destroyCalls = 0; fx.agents.push(this); } destroy() { this.destroyCalls += 1; } }
  fx.Agent = fx.AgentOverride ?? FakeAgent;
  fx.request = (options) => { if (fx.requestHook) { const r = fx.requestHook(options); if (r !== undefined) return r; } const r = new FakeReq(fx, options); fx.reqs.push(r); return r; };
  fx.primitive = { request: fx.request, Agent: fx.Agent };
  fx.ex = (provider = "hostaway") => { const c = createE7RealExchange({ provider, primitive: fx.primitive }); assert.equal(c.ok, true); return c.exchange; };
  return fx;
}
const respond = (req, status, raw = ["Content-Type", "application/json"]) => { const res = new FakeRes(req, status, raw); req.res = res; req.emit("response", res); return res; };
const finish = (res) => { res.complete = true; res.emit("end"); res.req._closeOnce(); if (!res.closed) { res.closed = true; res.emit("close"); } };
const codeOf = async (p) => { try { await p; return "RESOLVED"; } catch (e) { assert.ok(e instanceof E7ExchangeError, String(e)); assert.equal(e.message, "E7_EXCHANGE_ERROR"); return e.code; } };
async function state(p) { let s = "pending"; p.then(() => { s = "fulfilled"; }, () => { s = "rejected"; }); await tick(); return s; }
const enc = (s) => new TextEncoder().encode(s);
const ours = (em) => ["error", "close", "response", "data", "end", "aborted"].reduce((n, ev) => n + em.listenerCount(ev), 0);

// =================================================================================================================================
test("X1. options + inertness: exact keys; default primitive is node:https request / Agent (captured, never called); import / construction / refusals make zero primitive calls", async () => {
  assert.equal(NODE_HTTPS_PRIMITIVE.request, guardRequest, "the module bound node:https request at load (guard proves identity)");
  assert.equal(NODE_HTTPS_PRIMITIVE.Agent, GuardAgent);
  for (const o of [undefined, null, {}, { provider: "github" }, { provider: "hostaway", extra: 1 }, { provider: "hostaway", primitive: {} }, { provider: "hostaway", primitive: { request() {} } },
    { provider: "stripe", primitive: { request: () => {}, Agent: new Proxy(function A() {}, {}) } }, new Proxy({ provider: "hostaway" }, {}),
    Object.defineProperty({}, "provider", { enumerable: true, get() { throw new Error("getter ran"); } })]) assert.deepEqual({ ...createE7RealExchange(o) }, { ok: false, code: "EXCHANGE_OPTIONS_INVALID" });
  const d = createE7RealExchange({ provider: "hostaway" });
  assert.ok(d.ok && Object.isFrozen(d) && typeof d.exchange === "function");
  assert.equal(await codeOf(d.exchange(HREQ({ url: "https://evil.example/v1/x" }))), "EXCHANGE_INPUT_INVALID");
  const ac = new AbortController(); ac.abort();
  assert.equal(await codeOf(d.exchange(HREQ({ signal: ac.signal }))), "EXCHANGE_ABORTED");
  assert.deepEqual([GUARD.request, GUARD.Agent], [0, 0], "default primitive never invoked");
  assert.deepEqual({ ...AGENT_OPTIONS }, { keepAlive: false, maxSockets: 1, maxCachedSessions: 0 });
  assert.equal(EXCHANGE_ERROR_CODES.length, 10);
});

test("X2. exact request options per provider / method; own non-keep-alive Agent; end() once with the exact body bytes; Content-Length only with a body", async () => {
  for (const [provider, r, method, path, bodyStr] of [["hostaway", HREQ(), "GET", `/v1/reservations/${RID}`, null], ["hostaway", HPOST(), "POST", "/v1/reservations", '{"a":"é"}'],
    ["hostaway", HREQ({ method: "PUT", url: `https://api.hostaway.com/v1/reservations/${RID}/statuses/cancelled`, headers: HPOST().headers, body: '{"cancelledBy":"host"}' }), "PUT", `/v1/reservations/${RID}/statuses/cancelled`, '{"cancelledBy":"host"}'],
    ["stripe", SREQ(), "POST", `/v1/payment_intents/${PI}/capture`, SREQ().body],
    ["stripe", { ...SREQ(), method: "GET", url: `https://api.stripe.com/v1/payment_intents/${PI}?expand%5B%5D=latest_charge`, headers: { Authorization: `Bearer ${SKEY}`, "Stripe-Version": VERSION }, body: null }, "GET", `/v1/payment_intents/${PI}?expand%5B%5D=latest_charge`, null],
    ["stripe", { ...SREQ(), url: `https://api.stripe.com/v1/payment_intents/${PI}/cancel`, body: "" }, "POST", `/v1/payment_intents/${PI}/cancel`, ""]]) {
    const fx = fakePrimitive();
    const p = fx.ex(provider)(r);
    assert.deepEqual([fx.agents.length, fx.reqs.length], [1, 1]);
    const req = fx.reqs[0]; const o = req.options;
    const host = provider === "hostaway" ? "api.hostaway.com" : "api.stripe.com";
    assert.ok(Object.isFrozen(o) && Object.isFrozen(o.headers));
    assert.deepEqual(Object.keys(o).sort(), ["agent", "headers", "hostname", "insecureHTTPParser", "joinDuplicateHeaders", "maxHeaderSize", "method", "path", "port", "protocol", "rejectUnauthorized", "servername", "setHost"]);
    assert.deepEqual([o.protocol, o.hostname, o.servername, o.port, o.method, o.path, o.rejectUnauthorized, o.setHost, o.insecureHTTPParser, o.maxHeaderSize, o.joinDuplicateHeaders, o.agent],
      ["https:", host, host, 443, method, path, true, true, false, 16384, false, fx.agents[0]]);
    assert.deepEqual(fx.agents[0].opts, AGENT_OPTIONS);
    const want = { ...r.headers }; if (bodyStr !== null) want["Content-Length"] = String(enc(bodyStr).length);
    assert.deepEqual({ ...o.headers }, want);
    assert.equal(req.endCalls, 1);
    if (bodyStr === null) assert.deepEqual(req.endArgs, []);
    else { assert.ok(req.endArgs[0] instanceof Uint8Array); assert.equal(new TextDecoder().decode(req.endArgs[0]), bodyStr); }
    finish(respond(req, 200, []));
    assert.equal((await p).status, 200);
  }
});

test("X3. input refusals → EXCHANGE_INPUT_INVALID with ZERO primitive calls (host / scheme / port / userinfo / fragment / non-canonical / dot / protected / headers / body / bound / signal)", async () => {
  const P = String(PROTECTED_HOSTAWAY_RESERVATION_IDS[0]);
  const rp = Proxy.revocable(sig(), {}); rp.revoke();
  const bad = [
    HREQ({ url: "http://api.hostaway.com/v1/reservations/1" }), HREQ({ url: "https://api.hostaway.com:8443/v1/reservations/1" }), HREQ({ url: "https://u:p@api.hostaway.com/v1/reservations/1" }),
    HREQ({ url: "https://api.hostaway.com/v1/reservations/1#x" }), HREQ({ url: "https://API.hostaway.com/v1/reservations/1" }), HREQ({ url: "https://api.hostaway.com/v1/a/../reservations/1" }),
    HREQ({ url: "https://api.hostaway.com/v1\\reservations/1" }), HREQ({ url: "https://api.hostaway.com/v1/reservations/%31" }), HREQ({ url: "https://api.hostaway.com/v1//reservations" }),
    HREQ({ url: "https://api.stripe.com/v1/account" }), HREQ({ url: `https://api.hostaway.com/v1/reservations/${P}` }), HREQ({ url: `https://api.hostaway.com/v1/guestPayments/charges?limit=500&reservationIds=${P}` }),
    HREQ({ url: "https://api.hostaway.com/reservations/1" }), HREQ({ method: "DELETE" }), HREQ({ method: "get" }),
    HREQ({ headers: { ...HREQ().headers, Host: "evil" } }), HREQ({ headers: { Accept: "application/json", Authorization: `Bearer ${HTOKEN}` } }),
    HREQ({ headers: { ...HREQ().headers, Accept: "a\r\nX: y" } }), HREQ({ headers: { ...HREQ().headers, Authorization: "Basic x" } }), HREQ({ body: "" }),
    HPOST({ body: null }), HPOST({ body: "x".repeat(64 * 1024 + 1) }), HREQ({ maxBytes: 0 }), HREQ({ maxBytes: MAX_BYTES_CAP.hostaway + 1 }), HREQ({ maxBytes: 1.5 }),
    HREQ({ signal: { aborted: false } }), HREQ({ signal: new Proxy(sig(), {}) }), HREQ({ signal: rp.proxy }), HREQ({ signal: Object.create(AbortSignal.prototype) }),
    { ...HREQ(), extra: 1 }, new Proxy(HREQ(), {}), Object.defineProperty({ ...HREQ() }, "url", { enumerable: true, get() { throw new Error("getter ran"); } }), null,
    { ...SREQ(), method: "PUT" }, { ...SREQ(), headers: { Authorization: `Bearer ${SKEY}`, "Stripe-Version": VERSION } }];
  const fx = fakePrimitive();
  for (const [i, r] of bad.entries()) assert.equal(await codeOf((i >= bad.length - 2 ? fx.ex("stripe") : fx.ex("hostaway"))(r)), "EXCHANGE_INPUT_INVALID", `case ${i}`);
  assert.deepEqual([fx.agents.length, fx.reqs.length], [0, 0]);
});

test("X4. statuses: 200 / 201 / 401 / 403 / 404 / 429 / 500 / 503 resolve once with the bytes; 301 / 302 / 307 / 308 resolve with EMPTY bytes, body never consumed, Location unread; one request each, no retry", async () => {
  for (const st of [200, 201, 401, 403, 404, 429, 500, 503]) {
    const fx = fakePrimitive(); const p = fx.ex()(HREQ());
    const res = respond(fx.reqs[0], st); res.emit("data", Buffer.from('{"s":1}')); finish(res);
    const r = await p;
    assert.deepEqual([r.status, new TextDecoder().decode(r.bytes), r.contentType, fx.reqs.length, fx.agents.length], [st, '{"s":1}', "application/json", 1, 1]);
    await tick(); assert.equal(fx.agents[0].destroyCalls, 1, "Agent destroyed once after both closes");
  }
  for (const st of [301, 302, 307, 308]) {
    const fx = fakePrimitive(); const p = fx.ex()(HREQ());
    const res = respond(fx.reqs[0], st, ["Location", "https://evil.example/\r\n" + "x".repeat(5000), "Content-Type", "text/html"]);
    const r = await p;
    assert.deepEqual([r.status, r.bytes.length, r.contentType, res.listenerCount("data")], [st, 0, "text/html", 0], `${st}: body not consumed`);
    res.emit("data", Buffer.from("late body")); await tick(); await tick();
    assert.deepEqual([fx.reqs.length, fx.agents.length, fx.reqs[0].destroyCalls, res.destroyCalls], [1, 1, 1, 1], "no follow-up; destroyed once");
    assert.equal(fx.agents[0].destroyCalls, 1);
  }
  for (const [st, code] of [[199, "EXCHANGE_STATUS_INVALID"], [600, "EXCHANGE_STATUS_INVALID"], [undefined, "EXCHANGE_STATUS_INVALID"], ["200", "EXCHANGE_STATUS_INVALID"]]) {
    const fx = fakePrimitive(); const p = fx.ex()(HREQ()); respond(fx.reqs[0], st);
    assert.equal(await codeOf(p), code, String(st));
  }
  { const fx = fakePrimitive(); const p = fx.ex()(HREQ()); const res = new FakeRes(fx.reqs[0], 200, []); Object.defineProperty(res, "statusCode", { get() { throw new Error("getter ran"); } });
    fx.reqs[0].res = res; fx.reqs[0].emit("response", res); assert.equal(await codeOf(p), "EXCHANGE_STATUS_INVALID", "statusCode accessor never invoked"); }
});

test("X5. body: Buffer input / exact Uint8Array output; copy at receipt; slab views; zero-length; exact and over the bound; content-length checks; encodings; duplicate / malformed headers; complete required", async () => {
  { const fx = fakePrimitive(); const p = fx.ex()(HREQ({ maxBytes: 10 }));
    const res = respond(fx.reqs[0], 200, ["content-type", "application/json", "Content-Length", "10"]);
    const slab = Buffer.alloc(1 << 20, 0x41); const view = slab.subarray(100, 104); view.write("abcd");
    const c2 = Buffer.from("efgh"); const c3 = new Uint8Array([0x69, 0x6a]);
    res.emit("data", view); res.emit("data", Buffer.alloc(0)); res.emit("data", c2); c2.write("ZZZZ"); res.emit("data", c3); slab.fill(0x42);
    finish(res); const r = await p;
    assert.equal(Object.getPrototypeOf(r.bytes), Uint8Array.prototype, "output is exactly Uint8Array (not Buffer)");
    assert.deepEqual([new TextDecoder().decode(r.bytes), r.bytes.length, r.bytes.buffer.byteLength], ["abcdefghij", 10, 10], "copied at receipt: later source mutation / slab size irrelevant");
    assert.ok(Object.isFrozen(r)); }
  { const fx = fakePrimitive(); const p = fx.ex()(HREQ({ maxBytes: 10 })); const res = respond(fx.reqs[0], 200);
    res.emit("data", enc("12345")); res.emit("data", enc("678901")); assert.equal(await codeOf(p), "EXCHANGE_BODY_TOO_LARGE");
    assert.deepEqual([res.listenerCount("data") <= 1, fx.reqs[0].destroyCalls, res.destroyCalls], [true, 1, 1]); res.emit("data", enc("x")); res.emit("end"); await tick(); await tick();
    assert.equal(fx.agents[0].destroyCalls, 1); }
  { const fx = fakePrimitive(); const p = fx.ex()(HREQ({ maxBytes: 10 })); const res = respond(fx.reqs[0], 200, ["Content-Length", "11"]);
    assert.equal(await codeOf(p), "EXCHANGE_BODY_TOO_LARGE"); assert.equal(res.listenerCount("data"), 0, "refused before any body work"); }
  for (const [label, raw, code] of [["gzip", ["Content-Encoding", "gzip"], "EXCHANGE_ENCODING_REFUSED"], ["br", ["content-encoding", "br"], "EXCHANGE_ENCODING_REFUSED"],
    ["dup length", ["Content-Length", "2", "content-length", "2"], "EXCHANGE_HEADERS_INVALID"], ["dup type", ["Content-Type", "a", "content-type", "b"], "EXCHANGE_HEADERS_INVALID"],
    ["negative", ["Content-Length", "-1"], "EXCHANGE_HEADERS_INVALID"], ["fraction", ["Content-Length", "1.5"], "EXCHANGE_HEADERS_INVALID"], ["leading zero", ["Content-Length", "01"], "EXCHANGE_HEADERS_INVALID"],
    ["odd raw", ["Content-Type"], "EXCHANGE_HEADERS_INVALID"], ["non-string", ["Content-Type", 5], "EXCHANGE_HEADERS_INVALID"], ["type CRLF", ["Content-Type", "a\r\nb"], "EXCHANGE_HEADERS_INVALID"]]) {
    const fx = fakePrimitive(); const p = fx.ex()(HREQ()); respond(fx.reqs[0], 200, raw); assert.equal(await codeOf(p), code, label);
  }
  { const fx = fakePrimitive(); const p = fx.ex()(HREQ()); const res = respond(fx.reqs[0], 200, ["Content-Encoding", "identity"]); res.emit("data", enc("ok")); finish(res);
    assert.equal(new TextDecoder().decode((await p).bytes), "ok", "identity accepted"); }
  { const fx = fakePrimitive(); const p = fx.ex()(HREQ({ maxBytes: 4 })); const res = respond(fx.reqs[0], 200); res.emit("data", enc("1234")); finish(res);
    assert.equal((await p).bytes.length, 4, "exactly maxBytes accepted"); }
  { const fx = fakePrimitive(); const p = fx.ex()(HREQ()); const res = respond(fx.reqs[0], 200); res.emit("data", enc("ab")); res.emit("end");
    assert.equal(await codeOf(p), "EXCHANGE_PREMATURE_CLOSE", "end without complete:true is never a success (no truncation)"); }
  for (const bad of ["str", [1, 2], new DataView(new ArrayBuffer(2)), new Uint8Array(new SharedArrayBuffer(2))]) {
    const fx = fakePrimitive(); const p = fx.ex()(HREQ()); const res = respond(fx.reqs[0], 200); res.emit("data", bad); assert.equal(await codeOf(p), "EXCHANGE_PREMATURE_CLOSE");
  }
});

test("X6. cancellation at every boundary: before dispatch, during Agent construction, during request(), before end(), after end, after response, mid-body → EXCHANGE_ABORTED; abort listener removed", async () => {
  { const fx = fakePrimitive(); const ac = new AbortController(); ac.abort(); assert.equal(await codeOf(fx.ex()(HREQ({ signal: ac.signal }))), "EXCHANGE_ABORTED"); assert.deepEqual([fx.agents.length, fx.reqs.length], [0, 0]); }
  { const ac = new AbortController(); const fx = fakePrimitive({ agentCtor: () => ac.abort() });
    assert.equal(await codeOf(fx.ex()(HREQ({ signal: ac.signal }))), "EXCHANGE_ABORTED"); assert.deepEqual([fx.agents.length, fx.reqs.length, fx.agents[0].destroyCalls], [1, 0, 1], "aborted during Agent setup: no request, Agent destroyed"); }
  { const ac = new AbortController(); const fx = fakePrimitive(); fx.requestHook = () => { ac.abort(); return undefined; };
    assert.equal(await codeOf(fx.ex()(HREQ({ signal: ac.signal }))), "EXCHANGE_ABORTED"); const req = fx.reqs[0];
    assert.deepEqual([req.endCalls, req.destroyCalls], [0, 1], "aborted during request(): end() never called, request destroyed once");
    await tick(); await tick(); assert.equal(fx.agents[0].destroyCalls, 1); assert.equal(ours(req), 0); }
  { // abort DURING listener attachment (after the request exists, before end()): end() is never called — no bytes after an observed abort
    const ac = new AbortController(); const fx = fakePrimitive();
    fx.requestHook = () => { const r = new FakeReq(fx, {}); fx.reqs.push(r); let n = 0; const on = r.on.bind(r); r.on = (ev, fn) => { n += 1; const out = on(ev, fn); if (n === 2) ac.abort(); return out; }; return r; };
    assert.equal(await codeOf(fx.ex()(HREQ({ signal: ac.signal }))), "EXCHANGE_ABORTED");
    assert.deepEqual([fx.reqs[0].endCalls, fx.reqs[0].destroyCalls], [0, 1]); await tick(); await tick(); assert.equal(fx.agents[0].destroyCalls, 1); }
  for (const stage of ["afterEnd", "afterResponse", "midBody"]) {
    const ac = new AbortController(); const fx = fakePrimitive(); const p = fx.ex()(HREQ({ signal: ac.signal })); const req = fx.reqs[0];
    let res = null; if (stage !== "afterEnd") res = respond(req, 200); if (stage === "midBody") res.emit("data", enc("ab"));
    assert.equal(getEventListeners(ac.signal, "abort").length, 1);
    ac.abort();
    assert.equal(await codeOf(p), "EXCHANGE_ABORTED", stage);
    assert.equal(getEventListeners(ac.signal, "abort").length, 0, "abort listener removed");
    await tick(); await tick();
    assert.deepEqual([req.destroyCalls, res ? res.destroyCalls : 1, fx.agents[0].destroyCalls, ours(req), res ? ours(res) : 0], [1, 1, 1, 0, 0], `${stage}: destroyed once; only our listeners, all removed after close`);
  }
  { const fx = fakePrimitive(); const ac = new AbortController(); const p = fx.ex()(HREQ({ signal: ac.signal })); finish(respond(fx.reqs[0], 200)); await p;
    assert.equal(getEventListeners(ac.signal, "abort").length, 0, "listener removed at success"); ac.abort(); await tick(); assert.equal(fx.reqs[0].destroyCalls, 0, "abort after settlement ignored"); }
  { const fx = fakePrimitive(); const s = sig(); Object.defineProperty(s, "aborted", { value: true }); Object.defineProperty(s, "addEventListener", { value() { throw new Error("shadow ran"); } });
    const p = fx.ex()(HREQ({ signal: s })); finish(respond(fx.reqs[0], 200)); assert.equal((await p).status, 200, "own shadows of aborted / addEventListener never consulted"); }
});

test("X7. setup failures: Agent throws / bad shape; request() throws / bad handle; listener attach throws; end() throws → EXCHANGE_SETUP_FAILED; every acquired resource destroyed at most once", async () => {
  { const fx = fakePrimitive({ agentCtor: () => { throw new Error("agent boom"); } }); assert.equal(await codeOf(fx.ex()(HREQ())), "EXCHANGE_SETUP_FAILED"); assert.equal(fx.reqs.length, 0); }
  { const fx = fakePrimitive({ AgentOverride: function Bad() { return { nope: 1 }; } }); assert.equal(await codeOf(fx.ex()(HREQ())), "EXCHANGE_SETUP_FAILED"); assert.equal(fx.reqs.length, 0); }
  { const fx = fakePrimitive(); fx.requestHook = () => { throw new Error("request boom"); }; assert.equal(await codeOf(fx.ex()(HREQ())), "EXCHANGE_SETUP_FAILED"); assert.equal(fx.agents[0].destroyCalls, 1, "no ClientRequest: Agent destroyed immediately"); }
  { const fx = fakePrimitive(); fx.requestHook = () => ({ on() {}, end() {} }); assert.equal(await codeOf(fx.ex()(HREQ())), "EXCHANGE_SETUP_FAILED"); assert.equal(fx.agents[0].destroyCalls, 1); }
  { const fx = fakePrimitive(); fx.requestHook = () => { const r = new FakeReq(fx, {}); fx.reqs.push(r); r.on = () => { throw new Error("on boom"); }; return r; };
    assert.equal(await codeOf(fx.ex()(HREQ())), "EXCHANGE_SETUP_FAILED"); assert.deepEqual([fx.agents[0].destroyCalls, fx.reqs[0].destroyCalls, fx.reqs[0].endCalls], [1, 0, 0], "no error observer: request not destroyed, Agent destroyed"); }
  { const fx = fakePrimitive(); fx.requestHook = () => { const r = new FakeReq(fx, {}); fx.reqs.push(r); let n = 0; const on = r.on.bind(r); r.on = (ev, fn) => { n += 1; if (n === 3) throw new Error("third on"); return on(ev, fn); }; return r; };
    assert.equal(await codeOf(fx.ex()(HREQ())), "EXCHANGE_SETUP_FAILED"); const req = fx.reqs[0]; assert.deepEqual([req.destroyCalls, req.endCalls], [1, 0]); await tick(); await tick(); assert.equal(fx.agents[0].destroyCalls, 1); }
  { const fx = fakePrimitive(); fx.requestHook = () => { const r = new FakeReq(fx, {}); fx.reqs.push(r); r.end = () => { throw new Error("end boom"); }; return r; };
    assert.equal(await codeOf(fx.ex()(HREQ())), "EXCHANGE_SETUP_FAILED"); assert.equal(fx.reqs[0].destroyCalls, 1); await tick(); await tick(); assert.equal(fx.agents[0].destroyCalls, 1); }
  { const fx = fakePrimitive({ syncDestroy: true }); const ac = new AbortController(); const p = fx.ex()(HREQ({ signal: ac.signal })); const res = respond(fx.reqs[0], 200); ac.abort();
    assert.equal(await codeOf(p), "EXCHANGE_ABORTED"); assert.deepEqual([fx.reqs[0].destroyCalls, res.destroyCalls], [1, 1], "synchronous reentrant destroy events: single settlement and cleanup"); await tick(); assert.equal(fx.agents[0].destroyCalls, 1); }
});

test("X8. races and late events: error/close orders, premature closes, events after settlement ignored; one settlement; only OUR listeners removed; Agent destroyed after BOTH closes", async () => {
  { const fx = fakePrimitive(); const p = fx.ex()(HREQ()); const req = fx.reqs[0]; const foreign = () => {}; req.on("error", foreign);
    req.emit("error", new Error("ECONNREFUSED secret-url")); req._closeOnce(); assert.equal(await codeOf(p), "EXCHANGE_NETWORK_ERROR");
    assert.deepEqual([req.listenerCount("error"), req.removeAllCalls, fx.agents[0].destroyCalls], [1, 0, 1], "foreign listener kept; never removeAllListeners"); }
  { const fx = fakePrimitive(); const p = fx.ex()(HREQ()); fx.reqs[0]._closeOnce(); assert.equal(await codeOf(p), "EXCHANGE_PREMATURE_CLOSE"); }
  { const fx = fakePrimitive(); const p = fx.ex()(HREQ()); const res = respond(fx.reqs[0], 200); res.emit("data", enc("x")); res.emit("aborted"); assert.equal(await codeOf(p), "EXCHANGE_PREMATURE_CLOSE"); }
  { const fx = fakePrimitive(); const p = fx.ex()(HREQ()); const res = respond(fx.reqs[0], 200); res.closed = true; res.emit("close"); assert.equal(await codeOf(p), "EXCHANGE_PREMATURE_CLOSE"); }
  { // request closes while the body is still active: NOT a success; the Agent waits for the response close
    const fx = fakePrimitive(); const p = fx.ex()(HREQ()); const req = fx.reqs[0]; const res = respond(req, 200); res.emit("data", enc("par"));
    req._closeOnce(); assert.equal(await state(p), "pending", "no settlement on req close while the body is active");
    assert.equal(fx.agents[0].destroyCalls, 0, "Agent kept while the response is open");
    assert.ok(res.listenerCount("error") >= 1, "response error sink kept after req close");
    res.emit("data", enc("tial")); res.complete = true; res.emit("end"); res.closed = true; res.emit("close");
    assert.equal(new TextDecoder().decode((await p).bytes), "partial"); assert.equal(fx.agents[0].destroyCalls, 1); }
  { // late events after a success are ignored; a late error after close does not throw
    const fx = fakePrimitive(); const p = fx.ex()(HREQ()); const res = respond(fx.reqs[0], 200); res.emit("data", enc("ok")); finish(res); const r = await p;
    res.emit("data", enc("late")); res.emit("end"); fx.reqs[0].emit("response", new FakeRes(fx.reqs[0], 500, []));
    assert.deepEqual([new TextDecoder().decode(r.bytes), fx.reqs.length, fx.agents.length, fx.agents[0].destroyCalls], ["ok", 1, 1, 1]); }
  { // a response arriving AFTER an abort but BEFORE the request's close is never processed: protected, not read, destroyed once
    // [FIRST-RUN FIX, labelled: the first version emitted the late response after the request had closed (no module listener left) and
    //  asserted a tautology; it now emits synchronously after abort(), while the module's 'response' listener is still attached.]
    const fx = fakePrimitive(); const ac = new AbortController(); const p = fx.ex()(HREQ({ signal: ac.signal })); const req = fx.reqs[0];
    ac.abort();
    const res = new FakeRes(req, 200, ["Content-Length", "2"]); req.res = res; req.emit("response", res);
    assert.equal(await codeOf(p), "EXCHANGE_ABORTED");
    assert.deepEqual([res.listenerCount("data"), res.destroyCalls, res.listenerCount("error") >= 1 || res.closed], [0, 1, true], "late response: no body listener, destroyed once, protected until close");
    await tick(); await tick();
    assert.deepEqual([ours(res), ours(req), fx.agents[0].destroyCalls], [0, 0, 1]); }
  await tick(); await tick();
  assert.deepEqual([unhandled, uncaught], [0, 0]);
});

test("X9. code-only errors: no URL / token / key / body / provider text / raw error in any error", async () => {
  const fx = fakePrimitive(); const p = fx.ex("stripe")(SREQ()); fx.reqs[0].emit("error", new Error(`boom ${SKEY} ${PI}`)); fx.reqs[0]._closeOnce();
  let err; try { await p; } catch (e) { err = e; }
  const dump = JSON.stringify({ ...err, m: err.message, s: String(err), st: String(err.stack), c: err.cause });
  for (const s of [SKEY, PI, "api.stripe.com", "amount_to_capture", "boom", INTENT]) assert.ok(!dump.includes(s), s);
  assert.ok(Object.isFrozen(err) && err.cause === undefined);
});

// ---- accepted T over the real exchange with a FAKE primitive that routes to a tiny synthetic world ----------------------------------
function routedPrimitive(route) {
  const fx = fakePrimitive();
  fx.onEnd = (req) => setImmediate(() => {
    const o = req.options; const body = req.endArgs.length ? new TextDecoder().decode(req.endArgs[0]) : null;
    fx.log = fx.log ?? []; fx.log.push({ host: o.hostname, method: o.method, path: o.path, headerNames: Object.keys(o.headers).sort().join(","), auth: o.headers.Authorization === undefined ? null : "<redacted>", body });
    const r = route(o, body); if (r === "hold") return;
    const res = respond(req, r.status, ["Content-Type", "application/json"]);
    const b = Buffer.from(JSON.stringify(r.json)); res.emit("data", b.subarray(0, 3)); res.emit("data", b.subarray(3)); finish(res);
  });
  return fx;
}
test("X10. accepted T transports over the real exchange (FAKE primitive): H1–H9 / S1–S4 exact options, Account without livemode, plural H8, abort → ABORTED_IN_FLIGHT, 3xx → REDIRECT_REFUSED, Stripe 5xx; one request per send", async () => {
  const ACCOUNT = { id: ACCT, object: "account", country: "US" };
  const PIOBJ = { id: PI, object: "payment_intent", livemode: false, status: "requires_capture" };
  const hfx = routedPrimitive(() => ({ status: 200, json: { status: "success", result: [] } }));
  const sfx = routedPrimitive((o) => ({ status: 200, json: o.path === "/v1/account" ? ACCOUNT : PIOBJ }));
  const h = createE7HostawaySend({ exchange: createE7RealExchange({ provider: "hostaway", primitive: hfx.primitive }).exchange, credential: () => HTOKEN }).transport;
  const s = createE7StripeTestSend({ exchange: createE7RealExchange({ provider: "stripe", primitive: sfx.primitive }).exchange, credential: () => SKEY, accountId: ACCT, apiVersion: VERSION }).transport;
  const o = () => ({ signal: sig() });
  const calls = [
    { method: "GET", path: "/v1/reservations", query: { listingId: L, channelId: 2000, arrivalStartDate: IN, arrivalEndDate: IN, limit: 100, includeResources: 1 } },
    { method: "GET", path: `/v1/reservations/${RID}`, query: {} }, { method: "GET", path: `/v1/listings/${L}`, query: {} },
    { method: "GET", path: `/v1/listings/${L}/calendar`, query: { startDate: IN, endDate: OUT } },
    { method: "POST", path: `/v1/listings/${L}/calendar/priceDetails`, query: {}, body: { startingDate: IN, endingDate: OUT, numberOfGuests: 2, version: 2 } },
    { method: "POST", path: "/v1/reservations", query: {}, body: { channelId: 2000, listingMapId: L, arrivalDate: IN, departureDate: OUT, numberOfGuests: 2, totalPrice: 500, currency: "USD",
      guestFirstName: "Synthia", guestLastName: "Fixture", guestName: "Synthia Fixture", guestEmail: "guest.adapter@mv-test.invalid", customFieldValues: [{ customFieldId: 777016, value: "MV-ADPT0001" }] } },
    { method: "PUT", path: `/v1/reservations/${RID}/statuses/cancelled`, query: {}, body: { cancelledBy: "host" } },
    { method: "GET", path: "/v1/guestPayments/charges", query: { reservationId: RID, limit: 500 } },
    { method: "POST", path: `/v1/guestPayments/charges/${RID}`, query: {}, body: { title: offlineChargeTitle(INTENT), amount: 500, paymentMethod: "credit_card", scheduledDate: "2026-12-04 10:00:00", status: "paid" } }];
  for (const c of calls) assert.equal((await h.send(c, o())).httpStatus, 200);
  assert.deepEqual(hfx.log.map((e) => `${e.method} ${e.path}`), [
    `GET /v1/reservations?arrivalEndDate=${IN}&arrivalStartDate=${IN}&channelId=2000&includeResources=1&limit=100&listingId=${L}`, `GET /v1/reservations/${RID}`, `GET /v1/listings/${L}`,
    `GET /v1/listings/${L}/calendar?endDate=${OUT}&startDate=${IN}`, `POST /v1/listings/${L}/calendar/priceDetails`, "POST /v1/reservations", `PUT /v1/reservations/${RID}/statuses/cancelled`,
    `GET /v1/guestPayments/charges?limit=500&reservationIds=${RID}`, `POST /v1/guestPayments/charges/${RID}`]);
  assert.ok(hfx.log.every((e) => e.host === "api.hostaway.com") && hfx.reqs.length === calls.length && hfx.agents.length === calls.length);
  const acct = await s.send({ op: "accounts.retrieve" }, o());
  assert.equal("livemode" in acct, false, "the true Account shape (no livemode) is accepted end to end");
  await s.send({ op: "paymentIntents.retrieve", id: PI, params: { expand: ["latest_charge"] } }, o());
  await s.send({ op: "paymentIntents.capture", id: PI, params: { amount_to_capture: 50000, final_capture: true, expand: ["latest_charge"] }, idempotencyKey: `cap:${INTENT}:${PI}` }, o());
  await s.send({ op: "paymentIntents.cancel", id: PI, params: {}, idempotencyKey: `void:${INTENT}:${PI}` }, o());
  assert.deepEqual(sfx.log.map((e) => `${e.method} ${e.path} [${e.headerNames}] ${e.body ?? "-"}`), [
    "GET /v1/account [Authorization,Stripe-Version] -", `GET /v1/payment_intents/${PI}?expand%5B%5D=latest_charge [Authorization,Stripe-Version] -`,
    `POST /v1/payment_intents/${PI}/capture [Authorization,Content-Length,Content-Type,Idempotency-Key,Stripe-Version] amount_to_capture=50000&final_capture=true&expand%5B%5D=latest_charge`,
    `POST /v1/payment_intents/${PI}/cancel [Authorization,Content-Length,Content-Type,Idempotency-Key,Stripe-Version] `]);
  assert.ok(sfx.reqs.every((r) => r.options.rejectUnauthorized === true && r.options.agent.opts.keepAlive === false));
  // held reply + genuine abort → the exchange rejects; T sees the aborted genuine signal → ABORTED_IN_FLIGHT; one request, no retry
  const held = routedPrimitive(() => "hold");
  const ht = createE7HostawaySend({ exchange: createE7RealExchange({ provider: "hostaway", primitive: held.primitive }).exchange, credential: () => HTOKEN }).transport;
  const ac = new AbortController(); const pr = ht.send(calls[8], { signal: ac.signal }); await tick(); await tick(); ac.abort();
  await assert.rejects(pr, (e) => e instanceof E7TransportError && e.code === "ABORTED_IN_FLIGHT"); await tick(); await tick();
  assert.deepEqual([held.reqs.length, held.reqs[0].destroyCalls, held.agents[0].destroyCalls], [1, 1, 1]);
  // 3xx → REDIRECT_REFUSED (never followed); Stripe 500 → STRIPE_HTTP_5XX; Hostaway 401 passed through; one request each
  const r3 = routedPrimitive(() => ({ status: 302, json: {} }));
  const t3 = createE7HostawaySend({ exchange: createE7RealExchange({ provider: "hostaway", primitive: r3.primitive }).exchange, credential: () => HTOKEN }).transport;
  await assert.rejects(t3.send(calls[1], o()), (e) => e.code === "REDIRECT_REFUSED"); assert.equal(r3.reqs.length, 1);
  const s5 = routedPrimitive(() => ({ status: 500, json: { error: { message: "provider text" } } }));
  const t5 = createE7StripeTestSend({ exchange: createE7RealExchange({ provider: "stripe", primitive: s5.primitive }).exchange, credential: () => SKEY, accountId: ACCT, apiVersion: VERSION }).transport;
  await assert.rejects(t5.send({ op: "accounts.retrieve" }, o()), (e) => e.code === "STRIPE_HTTP_5XX"); assert.equal(s5.reqs.length, 1);
  const h4 = routedPrimitive(() => ({ status: 401, json: { status: "fail" } }));
  const t4 = createE7HostawaySend({ exchange: createE7RealExchange({ provider: "hostaway", primitive: h4.primitive }).exchange, credential: () => HTOKEN }).transport;
  assert.equal((await t4.send(calls[1], o())).httpStatus, 401); assert.equal(h4.reqs.length, 1, "401: no re-mint / retry");
  assert.ok(![...hfx.log, ...sfx.log].some((e) => JSON.stringify(e).includes(HTOKEN) || JSON.stringify(e).includes(SKEY)), "test log keeps no credential");
});

test("X11. source pins: imports exactly node:https / node:util / compensation-proof; no fetch / undici / http / net / tls / dns / process / timers / console / insecure or proxy option / removeAllListeners / retry", () => {
  const src = readFileSync(join(ROOT, "scripts/e7-connected/real-exchange.mjs"), "utf8");
  assert.deepEqual([...src.matchAll(/^import\s.*?from\s+"([^"]+)";$/gm)].map((m) => m[1]).sort(), ["../../lib/checkout/compensation-proof.js", "node:https", "node:util"]);
  const code = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const re of [/\bfetch\s*\(/, /undici/, /node:(http"|net|tls|dns|fs|child_process|timers)/, /process\./, /setTimeout|setInterval|setImmediate|queueMicrotask/, /console\./,
    /rejectUnauthorized:\s*false/, /createConnection|proxyEnv|NODE_TLS|globalAgent|\blookup\s*:/, /removeAllListeners/, /\bretry\b/i, /\bca\s*:|\bcert\s*:|\bpfx\s*:/]) assert.doesNotMatch(code, re, String(re));
  assert.match(code, /rejectUnauthorized: true/);
});

// ---- root CODE HOLD on e386af38: R-X1 / R-X2 (X12 / X13 FAIL on exact e386af38; see contract §9.1) ---------------------------------
/** plain-EventEmitter doubles (root's probe style): attaching listener #n for event `ev` throws; destroy() emits error then close
 *  (microtask, or synchronously). The RESPONSE double models Node's IncomingMessage rule of emitting 'error' on destroy only when an
 *  'error' listener exists (_http_incoming v22.22.0 :439–446); labelled, not native. */
function attachFaultPrimitive({ reqFail = null, resFail = null, sync = false, abortOnFail = null } = {}) {
  const st = { agents: [], reqs: [] };
  class A { constructor() { this.d = 0; st.agents.push(this); } destroy() { this.d += 1; } }
  const em = (fail, isRes) => {
    const e = new EventEmitter(); e.d = 0; e.closed = false; const on = e.on.bind(e);
    e.on = (ev, fn) => { if (fail && ev === fail) { if (abortOnFail) abortOnFail.abort(); throw new Error("attach refused (fake)"); } return on(ev, fn); };
    const go = () => { if (e.closed) return; if (!isRes || e.listenerCount("error") > 0) e.emit("error", Object.assign(new Error("x"), { code: "ECONNRESET" })); e.closed = true; e.emit("close"); };
    e.destroy = () => { e.d += 1; if (e._d) return; e._d = true; if (sync) go(); else queueMicrotask(go); };
    return e;
  };
  const request = () => {
    const r = em(reqFail, false); r.endCalls = 0; st.reqs.push(r);
    r.end = () => { r.endCalls += 1; queueMicrotask(() => { if (r.closed) return; const res = em(resFail, true); res.statusCode = 200; res.rawHeaders = []; res.complete = false; r.res = res; r.emit("response", res);
      if (!res.closed && res.listenerCount("end") > 0) { res.emit("data", Buffer.from("ok")); res.complete = true; res.emit("end"); res.closed = true; res.emit("close"); r.closed = true; r.emit("close"); } }); };
    return r;
  };
  return { st, primitive: { request, Agent: A } };
}
const allListeners = (e) => (e ? e.eventNames().reduce((n, ev) => n + e.listenerCount(ev), 0) : 0);
const settleAll = async () => { for (let i = 0; i < 6; i++) await tick(); };

test("X12 (R-X1). every request / response listener attachment failing independently (before and after close tracking; async / synchronous destroy; abort variant): one settlement, each owned resource disposed at most once, Agent destroyed, no module listener left", async () => {
  const before = uncaught;
  const cases = [];
  for (const sync of [false, true]) {
    for (const ev of ["close", "response"]) cases.push({ reqFail: ev, sync });
    for (const ev of ["error", "close", "aborted", "data", "end"]) cases.push({ resFail: ev, sync });
  }
  cases.push({ reqFail: "close", abort: true }, { resFail: "close", abort: true }, { resFail: "data", abort: true });
  for (const c of cases) {
    const ac = new AbortController();
    const fx = attachFaultPrimitive({ reqFail: c.reqFail ?? null, resFail: c.resFail ?? null, sync: !!c.sync, abortOnFail: c.abort ? ac : null });
    const label = `${c.reqFail ? `req:${c.reqFail}` : `res:${c.resFail}`}${c.sync ? " sync" : ""}${c.abort ? " +abort" : ""}`;
    const code = await codeOf(createE7RealExchange({ provider: "hostaway", primitive: fx.primitive }).exchange(HREQ({ signal: ac.signal })));
    await settleAll();
    const req = fx.st.reqs[0]; const res = req && req.res;
    assert.equal(code, c.abort ? "EXCHANGE_ABORTED" : "EXCHANGE_SETUP_FAILED", label);
    assert.deepEqual([fx.st.reqs.length, fx.st.agents.length], [1, 1], `${label}: one request, one Agent, no retry`);
    assert.equal(fx.st.agents[0].d, 1, `${label}: Agent destroyed exactly once`);
    assert.ok(req.d <= 1 && (!res || res.d <= 1), `${label}: destroyed at most once`);
    if (c.reqFail === "close") assert.equal(req.endCalls, 0, `${label}: end() never called after a setup failure`);
    if (res) assert.equal(res.d, 1, `${label}: a failed response adoption destroys that response`);
    assert.deepEqual([allListeners(req), allListeners(res)], [0, 0], `${label}: every module listener removed (no immortal listener)`);
    assert.equal(getEventListeners(ac.signal, "abort").length, 0, `${label}: abort listener removed`);
  }
  assert.equal(uncaught, before, "no uncaught error from any ordering");
  // controls: the same doubles with no failure succeed and clean up identically
  for (const sync of [false, true]) {
    const fx = attachFaultPrimitive({ sync });
    const r = await createE7RealExchange({ provider: "hostaway", primitive: fx.primitive }).exchange(HREQ());
    await settleAll();
    assert.deepEqual([r.status, new TextDecoder().decode(r.bytes), fx.st.agents[0].d, allListeners(fx.st.reqs[0]), allListeners(fx.st.reqs[0].res)], [200, "ok", 1, 0, 0]);
  }
  // residual kept honest: the FIRST request error observer cannot attach → request not destroyed (an unobserved 'error' could crash), Agent destroyed
  { const fx = attachFaultPrimitive({ reqFail: "error" }); assert.equal(await codeOf(createE7RealExchange({ provider: "hostaway", primitive: fx.primitive }).exchange(HREQ())), "EXCHANGE_SETUP_FAILED");
    assert.deepEqual([fx.st.reqs[0].d, fx.st.reqs[0].endCalls, fx.st.agents[0].d, allListeners(fx.st.reqs[0])], [0, 0, 1, 0]); }
});

test("X13 (R-X2). protected selectors compared on DECODED query values: fully / partially encoded, leading zeros, lists, repeated keys, malformed encoding refused with ZERO Agent / request; benign encoded values and accepted T wire URLs pass unchanged", async () => {
  const P = String(PROTECTED_HOSTAWAY_RESERVATION_IDS[0]);
  const enc1 = [...P].map((d) => `%3${d}`).join("");
  const base = "https://api.hostaway.com/v1/guestPayments/charges";
  const refused = [`${base}?reservationIds=${enc1}`, `${base}?limit=500&reservationIds=${P.slice(0, 4)}%3${P[4]}${P.slice(5)}`, `${base}?limit=500&reservationIds=0${P}`,
    `${base}?limit=500&reservationIds=6100001%2C${P}`, `${base}?limit=500&reservationIds=6100001,${P}`, `${base}?reservationIds=6100001&reservationIds=6100002`,
    `${base}?limit=500&reservationIds=6100001&limit=500`, `${base}?limit=500&reservationIds=%E0%A4%A`, `${base}?limit=500&reservationIds=%ZZ`, `${base}?limit=500&reservationIds`,
    `${base}?=1`, `${base}?limit=500&reservationIds=1=2`, `https://api.hostaway.com/v1/reservations/0${P}`, `${base}?limit=500&reservationIds=${P}%20`];
  for (const url of refused) {
    const fx = fakePrimitive();
    assert.equal(await codeOf(fx.ex()(HREQ({ url }))), "EXCHANGE_INPUT_INVALID", url);
    assert.deepEqual([fx.agents.length, fx.reqs.length], [0, 0], `${url}: zero Agent / request`);
  }
  for (const [provider, url] of [["hostaway", `${base}?limit=500&reservationIds=6100001`], ["hostaway", `${base}?limit=500&reservationIds=%36100001`],
    ["hostaway", `https://api.hostaway.com/v1/reservations?arrivalEndDate=${IN}&arrivalStartDate=${IN}&channelId=2000&includeResources=1&limit=100&listingId=${L}`],
    ["stripe", `https://api.stripe.com/v1/payment_intents/${PI}?expand%5B%5D=latest_charge`]]) {
    const fx = fakePrimitive();
    const r = provider === "hostaway" ? HREQ({ url }) : { ...SREQ(), method: "GET", url, headers: { Authorization: `Bearer ${SKEY}`, "Stripe-Version": VERSION }, body: null };
    const p = fx.ex(provider)(r); finish(respond(fx.reqs[0], 200, []));
    assert.equal((await p).status, 200, url);
    assert.equal(fx.reqs[0].options.path, url.replace(/^https:\/\/[^/]+/, ""), `${url}: forwarded exactly, no rewrite / normalisation`);
  }
});
