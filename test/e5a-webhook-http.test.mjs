// Stage E5a — TEST-only webhook HTTP wrapper: gate before anything, bounded raw body, Stripe's own signature check,
// lazy pool/client, code-only responses and logs. Offline: Stripe's local signing helper only (no network, no keys).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable, PassThrough } from "node:stream";
import http from "node:http";
import Stripe from "stripe";
import { createStripeTestWebhookHandler, MAX_BODY_BYTES, readBoundedBody } from "../lib/checkout/stripe-webhook-http.js";
import { ENV_OK } from "./e5a-fixtures.mjs";

const SECRET = ENV_OK.STRIPE_TEST_WEBHOOK_SECRET;

function req({ method = "POST", body = "", headers = {}, chunks } = {}) {
  const r = Readable.from(chunks || [Buffer.from(body)]);
  r.method = method;
  r.headers = { "content-type": "application/json", ...headers };
  return r;
}
const untouchableReq = (method = "POST") => ({ method, headers: new Proxy({}, { get() { throw new Error("headers read"); } }),
  on() { throw new Error("body read"); } });
function res() {
  const h = {};
  return { statusCode: 0, headers: h, body: null, setHeader(k, v) { h[k.toLowerCase()] = v; }, end(b) { this.body = b ? JSON.parse(b) : null; } };
}
const evt = (o = {}) => JSON.stringify({ id: "evt_H1", object: "event", type: "checkout.session.completed", livemode: false, created: 1793652000,
  api_version: "2026-01-28.clover", data: { object: { id: "cs_test_h1", object: "checkout.session", metadata: {} } }, ...o });
const signed = (payload, opts = {}) => Stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET, ...opts });

function harness(over = {}) {
  const calls = { loadStripe: 0, createPool: 0, createStripe: 0, process: 0, assertEnvironment: 0, logs: [] };
  const deps = {
    loadStripe: async () => { calls.loadStripe++; return Stripe; },
    loadPoolLib: async () => ({ assertEnvironment: async (_p, want) => { calls.assertEnvironment++; assert.equal(want, "test"); if (over.liveDb) throw new Error("ENVIRONMENT_MISMATCH"); } }),
    createPool: () => { calls.createPool++; if (over.poolThrows) throw new Error("no db"); return { fake: "pool" }; },
    createStripe: () => { calls.createStripe++; return { fake: "stripe" }; },
    loadProcessor: async () => async (pool, event, d) => { calls.process++; calls.lastEvent = event; calls.lastDeps = d; return over.result || { http: 200, code: "APPLIED" }; },
    now: () => 1793652000000,
    log: (c) => calls.logs.push(c),
    ...(over.deps || {})
  };
  return { calls, h: createStripeTestWebhookHandler({ env: over.env || ENV_OK, deps }) };
}

test("gate first: production, missing flag or non-test config -> 404 before the SDK, pool, headers or body are touched", async () => {
  for (const env of [{ ...ENV_OK, VERCEL_ENV: "production" }, { ...ENV_OK, MV_STRIPE_TEST_WEBHOOK: undefined }, {},
    { ...ENV_OK, STRIPE_TEST_SECRET_KEY: ["sk", "live", "F".repeat(24)].join("_") }]) {
    const { calls, h } = harness({ env });
    const r = res();
    await h(untouchableReq(), r);
    assert.equal(r.statusCode, 404); assert.deepEqual(r.body, { code: "NOT_FOUND" });
    assert.deepEqual([calls.loadStripe, calls.createPool, calls.createStripe, calls.process, calls.logs.length], [0, 0, 0, 0, 0]);
  }
});

test("the deployed route file is inert without the explicit test configuration (this process has none)", async () => {
  assert.equal(process.env.MV_STRIPE_TEST_WEBHOOK, undefined);
  const route = (await import("../api/checkout/stripe-webhook.js")).default;
  const r = res();
  await route(untouchableReq(), r);
  assert.equal(r.statusCode, 404);
});

test("method, signature header and size bounds are refused before verification; oversized streams are cut off", async () => {
  const { calls, h } = harness();
  let r = res(); await h(req({ method: "GET" }), r); assert.equal(r.statusCode, 405); assert.equal(r.headers.allow, "POST");
  r = res(); await h(req({ body: evt() }), r); assert.equal(r.statusCode, 400); assert.equal(r.body.code, "SIGNATURE_MISSING");
  r = res(); await h(req({ body: evt(), headers: { "stripe-signature": "x".repeat(3000) } }), r); assert.equal(r.body.code, "SIGNATURE_MISSING");
  r = res(); await h(req({ body: evt(), headers: { "stripe-signature": "t=1,v1=a", "content-length": String(MAX_BODY_BYTES + 1) } }), r);
  assert.equal(r.statusCode, 413);
  r = res(); await h(req({ body: evt(), headers: { "stripe-signature": "t=1,v1=a", "content-length": "abc" } }), r); assert.equal(r.statusCode, 413);
  const big = Array.from({ length: 5 }, () => Buffer.alloc(40 * 1024, 0x20));
  r = res(); await h(req({ chunks: big, headers: { "stripe-signature": "t=1,v1=a" } }), r); assert.equal(r.statusCode, 413); assert.equal(r.body.code, "BODY_TOO_LARGE");
  assert.equal(calls.process, 0); assert.equal(calls.createPool, 0);
  await assert.rejects(readBoundedBody(req({ chunks: [Buffer.alloc(11)] }), 10), /BODY_TOO_LARGE/);
  assert.equal((await readBoundedBody(req({ chunks: [Buffer.from("ab"), Buffer.from("cd")] }), 10)).toString(), "abcd");
});

test("Stripe signature on the RAW body: valid -> processed once with the parsed event; tampered, wrong secret, stale or replayed-old -> 400, no pool", async () => {
  const body = evt();
  const { calls, h } = harness();
  let r = res(); await h(req({ body, headers: { "stripe-signature": signed(body) } }), r);
  assert.equal(r.statusCode, 200); assert.deepEqual(r.body, { received: true, code: "APPLIED" });
  assert.equal(calls.process, 1); assert.equal(calls.lastEvent.id, "evt_H1");
  assert.equal(calls.lastDeps.accountId, "acct_TESTACCOUNT01"); assert.deepEqual(calls.lastDeps.stripe, { fake: "stripe" });
  assert.equal(calls.assertEnvironment, 1);
  const bad = [
    [body.replace("evt_H1", "evt_H2"), signed(body)],                                   // body changed after signing
    [body + " ", signed(body)],                                                         // even whitespace
    [body, Stripe.webhooks.generateTestHeaderString({ payload: body, secret: ["whsec", "O".repeat(32)].join("_") })],
    [body, signed(body, { timestamp: Math.floor(Date.now() / 1000) - 301 })],             // outside the 300 s tolerance
    [body, "t=1,v1=" + "0".repeat(64)], [body, "garbage"]
  ];
  const { calls: c2, h: h2 } = harness();
  for (const [b, sig] of bad) {
    r = res(); await h2(req({ body: b, headers: { "stripe-signature": sig } }), r);
    assert.equal(r.statusCode, 400); assert.equal(r.body.code, "SIGNATURE_INVALID");
  }
  assert.equal(c2.process, 0); assert.equal(c2.createPool, 0); assert.equal(c2.createStripe, 0);
  assert.ok(c2.logs.every((l) => l === "SIGNATURE_INVALID"));
});

test("pool/client built once, after the first verified request; a live-marked or unreachable database -> 503 NOT_READY (Stripe redelivers)", async () => {
  const body = evt();
  const { calls, h } = harness();
  for (let i = 0; i < 3; i++) { const r = res(); await h(req({ body, headers: { "stripe-signature": signed(body) } }), r); assert.equal(r.statusCode, 200); }
  assert.deepEqual([calls.createPool, calls.createStripe, calls.assertEnvironment, calls.process], [1, 1, 1, 3]);
  for (const over of [{ liveDb: true }, { poolThrows: true }]) {
    const x = harness(over);
    const r = res(); await x.h(req({ body, headers: { "stripe-signature": signed(body) } }), r);
    assert.equal(r.statusCode, 503); assert.deepEqual(r.body, { code: "NOT_READY" }); assert.equal(x.calls.process, 0);
  }
  const y = harness({ deps: { loadPoolLib: async () => { throw Object.assign(new Error("Cannot find module '../../db/lib/pool.js'"), { code: "ERR_MODULE_NOT_FOUND" }); } } });
  const r = res(); await y.h(req({ body, headers: { "stripe-signature": signed(body) } }), r);
  assert.equal(r.statusCode, 503);                                                        // the packaging gap fails closed
});

test("responses and logs carry codes only (no body, ids, secrets or guest data)", async () => {
  const body = evt({ data: { object: { id: "cs_test_h1", object: "checkout.session", customer_details: { email: "guest@example.invalid" } } } });
  const { calls, h } = harness({ result: { http: 503, code: "SESSION_NOT_YET_RECORDED" } });
  const r = res(); await h(req({ body, headers: { "stripe-signature": signed(body) } }), r);
  assert.equal(r.statusCode, 503); assert.deepEqual(r.body, { received: false, code: "SESSION_NOT_YET_RECORDED" });
  const all = JSON.stringify([r.body, calls.logs]);
  assert.doesNotMatch(all, /guest|example|cs_test|evt_|whsec|sk_test|acct_/);
  assert.equal(r.headers["cache-control"], "no-store");
  const thrower = harness({ deps: { loadProcessor: async () => async () => { throw new Error("guest@example.invalid boom"); } } });
  const r2 = res(); await thrower.h(req({ body, headers: { "stripe-signature": signed(body) } }), r2);
  assert.equal(r2.statusCode, 503); assert.deepEqual(r2.body, { code: "PROCESSING_FAILED" }); assert.deepEqual(thrower.calls.logs, ["PROCESSING_FAILED"]);
});

const listenerCount = (r) => ["data", "end", "error", "aborted", "close"].reduce((n, e) => n + r.listenerCount(e), 0);

test("body reader settles on abort, premature close, stall and overflow; listeners and timer are always removed", async () => {
  const mk = () => { const r = new PassThrough(); r.method = "POST"; r.headers = {}; return r; };
  let r = mk(); let p = readBoundedBody(r, 100, { deadlineMs: 5000 }); r.write("abc"); r.emit("aborted");
  await assert.rejects(p, (e) => e.code === "BODY_ABORTED"); assert.equal(listenerCount(r), 0);
  r = mk(); p = readBoundedBody(r, 100, { deadlineMs: 5000 }); r.write("abc"); r.destroy();
  await assert.rejects(p, (e) => e.code === "BODY_ABORTED"); assert.equal(listenerCount(r), 0);
  r = mk(); p = readBoundedBody(r, 100, { deadlineMs: 40 }); r.write("abc");                  // never ends
  await assert.rejects(p, (e) => e.code === "BODY_TIMEOUT"); assert.equal(listenerCount(r), 0);
  r = mk(); p = readBoundedBody(r, 10, { deadlineMs: 5000 }); r.write(Buffer.alloc(11));
  await assert.rejects(p, (e) => e.code === "BODY_TOO_LARGE"); assert.equal(listenerCount(r), 0);
  r = mk(); p = readBoundedBody(r, 10, { deadlineMs: 5000 }); r.end("ok");
  assert.equal((await p).toString(), "ok"); assert.equal(listenerCount(r), 0);
  r = mk(); r.on("error", () => {}); p = readBoundedBody(r, 10, { deadlineMs: 5000 }); r.emit("error", new Error("x"));
  await assert.rejects(p, (e) => e.code === "BODY_READ_FAILED");
});

test("stalled or aborted webhook requests: no SDK load, pool or processing", async () => {
  const { calls, h } = harness({ deps: { bodyDeadlineMs: 40 } });
  const stalled = new PassThrough(); stalled.method = "POST"; stalled.headers = { "stripe-signature": "t=1,v1=a" }; stalled.write("{");
  let r = res(); await h(stalled, r);
  assert.equal(r.statusCode, 408); assert.deepEqual(r.body, { code: "BODY_TIMEOUT" });
  const aborted = new PassThrough(); aborted.method = "POST"; aborted.headers = { "stripe-signature": "t=1,v1=a" };
  r = res(); const done = h(aborted, r); aborted.write("{"); aborted.emit("aborted"); await done;
  assert.deepEqual(r.body, { code: "BODY_ABORTED" });
  assert.deepEqual([calls.loadStripe, calls.createPool, calls.createStripe, calls.process], [0, 0, 0, 0]);
});

test("real local HTTP: oversized streamed and declared bodies get a 413 response (no reset); a stalled sender gets 408; a client abort settles the handler", async () => {
  const { calls, h } = harness({ deps: { bodyDeadlineMs: 150 } });
  let settled = 0;
  const server = http.createServer(async (req, rs) => { await h(req, rs); settled++; });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const port = server.address().port;
  const send = (headers, write) => new Promise((ok, bad) => {
    const rq = http.request({ host: "127.0.0.1", port, method: "POST", path: "/", headers: { "stripe-signature": "t=1,v1=a", ...headers } }, (rs) => {
      let b = ""; rs.on("data", (c) => { b += c; }); rs.on("end", () => ok({ status: rs.statusCode, body: JSON.parse(b) }));
    });
    rq.on("error", bad);
    write(rq);
  });
  try {
    // chunked (no Content-Length): 300 KiB in 10 KiB pieces
    const big = await send({ "transfer-encoding": "chunked" }, async (rq) => { for (let i = 0; i < 30; i++) rq.write(Buffer.alloc(10240, 0x20)); rq.end(); });
    assert.deepEqual(big, { status: 413, body: { code: "BODY_TOO_LARGE" } });
    const declared = await send({ "content-length": String(MAX_BODY_BYTES + 1) }, (rq) => { rq.end(Buffer.alloc(MAX_BODY_BYTES + 1, 0x20)); });
    assert.deepEqual(declared, { status: 413, body: { code: "BODY_TOO_LARGE" } });
    const stalled = await send({ "content-length": "100" }, (rq) => { rq.write("{"); });          // never finishes
    assert.deepEqual(stalled, { status: 408, body: { code: "BODY_TIMEOUT" } });
    // client aborts mid-body: the handler must still settle
    const before = settled;
    await new Promise((ok) => {
      const rq = http.request({ host: "127.0.0.1", port, method: "POST", path: "/", headers: { "stripe-signature": "t=1,v1=a", "content-length": "100" } });
      rq.on("error", () => ok()); rq.write("{"); setTimeout(() => { rq.destroy(); ok(); }, 20);
    });
    const t0 = Date.now(); while (settled === before && Date.now() - t0 < 2000) await new Promise((ok) => setTimeout(ok, 10));
    assert.equal(settled, before + 1, "handler settled after client abort");
    assert.deepEqual([calls.loadStripe, calls.createPool, calls.createStripe, calls.process], [0, 0, 0, 0]);
  } finally {
    server.closeAllConnections?.(); await new Promise((ok) => server.close(ok));
  }
});
