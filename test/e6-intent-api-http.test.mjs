// Stage E6 — intent API HTTP layer, pure parts (no database, no SDK, no network). Full flows: test/db/e6-intent-api.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { intentApiGate, parseTestListings, tokenHashFromHeader, clientAddress, canonicalAddress, createIntentApiHandler } from "../lib/checkout/intent-api-http.js";
import { ENV_OK } from "./e5a-fixtures.mjs";

const ORIGIN = "https://preview.example.invalid";
const ENV = Object.freeze({ ...ENV_OK, MV_CHECKOUT_TEST_API: "enabled", MV_CHECKOUT_ALLOWED_ORIGIN: ORIGIN, MV_CHECKOUT_TEST_LISTINGS: "603566:MXN,606998:USD",
  MV_RATE_LIMIT_SALT: "s".repeat(40), MV_CHECKOUT_TERMS_VERSION: "terms-2026-11" });

test("gate: E5a TEST gate first (production refused), then every intent-API setting; frozen config", () => {
  assert.deepEqual(intentApiGate({ ...ENV, VERCEL_ENV: "production" }), { ok: false, code: "PRODUCTION_REFUSED" });
  for (const [k, v, code] of [["MV_CHECKOUT_TEST_API", "true", "API_NOT_ENABLED"], ["MV_CHECKOUT_ALLOWED_ORIGIN", "http://a.example", "ALLOWED_ORIGIN_REQUIRED"],
    ["MV_CHECKOUT_ALLOWED_ORIGIN", "https://a.example/", "ALLOWED_ORIGIN_REQUIRED"], ["MV_CHECKOUT_ALLOWED_ORIGIN", "*", "ALLOWED_ORIGIN_REQUIRED"],
    ["MV_CHECKOUT_ALLOWED_ORIGIN", "https://A.example", "ALLOWED_ORIGIN_REQUIRED"], ["MV_CHECKOUT_TEST_LISTINGS", "", "TEST_LISTINGS_REQUIRED"],
    ["MV_RATE_LIMIT_SALT", "x".repeat(31), "RATE_LIMIT_SALT_REQUIRED"], ["MV_CHECKOUT_TERMS_VERSION", "Terms 1", "TERMS_VERSION_REQUIRED"],
    ["MV_CHECKOUT_RETURN_URL", "https://x.example/r?a=1", "RETURN_URL_REQUIRED"]]) {
    assert.deepEqual(intentApiGate({ ...ENV, [k]: v }), { ok: false, code }, `${k}=${v}`);
  }
  const g = intentApiGate(ENV);
  assert.equal(g.ok, true); assert.ok(Object.isFrozen(g.config));
  assert.deepEqual([...g.config.listings].map(([id, c]) => [id, c.currency]), [[603566, "MXN"], [606998, "USD"]]);
});

test("test listing configuration: explicit id:currency pairs (MXN|USD), distinct, 1..10", () => {
  assert.equal(parseTestListings("603566:MXN").get(603566).currency, "MXN");
  for (const bad of [undefined, "", "603566", "603566:EUR", "603566:mxn", "0:MXN", "603566:MXN,603566:USD", "a:MXN", Array.from({ length: 11 }, (_, i) => `${i + 1}:USD`).join(",")]) {
    assert.equal(parseTestListings(bad), null, String(bad));
  }
});

test("bearer tokens: only canonical 43-char base64url (256-bit) values in the Authorization header; hashed with SHA-256", () => {
  const t = Buffer.alloc(32, 5).toString("base64url");
  assert.deepEqual(tokenHashFromHeader(`Bearer ${t}`), createHash("sha256").update(Buffer.alloc(32, 5)).digest());
  const nonCanonical = t.slice(0, 42) + "B";            // decodes to the same bytes but is not the canonical encoding
  for (const h of [undefined, "", t, `bearer ${t}`, `Bearer  ${t}`, `Bearer ${t} `, `Bearer ${t}=`, `Bearer ${nonCanonical}`, `Bearer ${t.slice(1)}`, `Bearer ${"a".repeat(44)}`]) {
    assert.equal(tokenHashFromHeader(h), null, String(h));
  }
});

test("client address policy: default 'none' trusts no header; 'x-real-ip' trusts only one canonical IP literal; XFF never read", () => {
  const req = (h) => ({ headers: h, socket: { remoteAddress: "127.0.0.1" } });
  for (const src of [undefined, "none"]) {
    for (const h of [{ "x-forwarded-for": "arbitrary-bucket-name" }, { "x-real-ip": "192.0.2.1" }, { "x-forwarded-for": "192.0.2.1" }, {}]) {
      assert.deepEqual(clientAddress(req(h), src), { trusted: false }, JSON.stringify(h));
    }
  }
  assert.deepEqual(clientAddress(req({ "x-real-ip": "192.0.2.1", "x-forwarded-for": "198.51.100.1" }), "x-real-ip"), { trusted: true, address: "192.0.2.1" });
  assert.deepEqual(clientAddress(req({ "x-forwarded-for": "198.51.100.1" }), "x-real-ip"), { trusted: false });
  assert.deepEqual(clientAddress(req({ "x-real-ip": "arbitrary-bucket-name" }), "x-real-ip"), { trusted: false });
  assert.deepEqual(clientAddress(req({ "x-real-ip": ["192.0.2.1"] }), "x-real-ip"), { trusted: false });
  assert.deepEqual(clientAddress(req({}), "anything-else"), { trusted: false });
  const table = [["192.0.2.1", "192.0.2.1"], ["2001:DB8::1", "2001:db8::1"], ["2001:db8:0:0:0:0:0:1", "2001:db8::1"], ["2001:0db8::0001", "2001:db8::1"],
    ["::ffff:192.0.2.1", "192.0.2.1"], ["::FFFF:c000:0201", "192.0.2.1"], ["::1", "::1"],
    ["01.2.3.4", null], ["1.2.3.4, 5.6.7.8", null], ["1.2.3.4:80", null], ["fe80::1%eth0", null], ["[::1]", null], [" 1.2.3.4", null], ["1.2.3.4 ", null],
    ["", null], ["256.1.1.1", null], ["1.2.3", null], ["x".repeat(46), null], [null, null], [12, null]];
  for (const [i, o] of table) assert.equal(canonicalAddress(i), o, String(i));
  assert.deepEqual(intentApiGate({ ...ENV, MV_CLIENT_ADDRESS_SOURCE: "x-forwarded-for" }), { ok: false, code: "CLIENT_ADDRESS_SOURCE_INVALID" });
  assert.equal(intentApiGate(ENV).config.addressSource, "none");
  assert.equal(intentApiGate({ ...ENV, MV_CLIENT_ADDRESS_SOURCE: "x-real-ip" }).config.addressSource, "x-real-ip");
});

function spyDeps() {
  const spies = { pool: 0, core: 0, access: 0, sdk: 0, hostaway: 0 };
  return { spies, deps: { createPool: () => { spies.pool++; throw new Error("no"); }, loadCore: async () => { spies.core++; }, loadAccess: async () => { spies.access++; },
    loadStripe: async () => { spies.sdk++; }, loadHostaway: async () => { spies.hostaway++; }, log: () => {} } };
}
const call = (h, { method = "POST", url = "/x", headers = {}, body = "" } = {}) => {
  const req = Readable.from(body ? [Buffer.from(body)] : []); req.method = method; req.url = url; req.headers = headers;
  const res = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { this.body = b ? JSON.parse(b) : null; } };
  return h(req, res).then(() => res);
};

test("refusals before any dependency: gate 404, origin 403, query 400, method 405, content type 415, JSON 400, token 401", async () => {
  const { spies, deps } = spyDeps();
  const off = createIntentApiHandler({ route: "intents", env: { ...ENV, VERCEL_ENV: "production" }, deps });
  assert.equal((await call(off, { headers: { origin: ORIGIN } })).statusCode, 404);
  const h = createIntentApiHandler({ route: "intents", env: ENV, deps });
  const s = createIntentApiHandler({ route: "step", env: ENV, deps });
  const j = { origin: ORIGIN, "content-type": "application/json" };
  const cases = [
    [h, { headers: { origin: "https://evil.example" } }, 403], [h, { headers: {} }, 403],
    [h, { method: "GET", url: "/x?token=abc", headers: { origin: ORIGIN } }, 400], [h, { method: "DELETE", headers: { origin: ORIGIN } }, 405],
    [h, { headers: { origin: ORIGIN, "content-type": "text/plain" }, body: "{}" }, 415], [h, { headers: j, body: "[]" }, 400], [h, { headers: j, body: "nope" }, 400],
    [h, { method: "GET", headers: { origin: ORIGIN } }, 401], [s, { headers: j, body: '{"step":"pay"}' }, 401], [s, { headers: j, body: '{"step":"x"}' }, 400],
    [h, { headers: { ...j, "content-length": "9000" }, body: "{}" }, 413]
  ];
  for (const [hd, req, st] of cases) assert.equal((await call(hd, req)).statusCode, st, JSON.stringify(req));
  assert.deepEqual(spies, { pool: 0, core: 0, access: 0, sdk: 0, hostaway: 0 });
  // a pool that cannot be created -> 503, still no core/SDK/Hostaway
  const r = await call(h, { headers: j, body: '{"listingId":603566,"from":"2027-03-10","to":"2027-03-12","guests":2}' });
  assert.deepEqual([r.statusCode, r.body], [503, { code: "NOT_READY" }]);
  assert.deepEqual({ ...spies, pool: 0 }, { pool: 0, core: 0, access: 0, sdk: 0, hostaway: 0 });
});

// ---------- E7 checkout TEST release step + pinned Checkout SDK version ----------
test("TEST release step: absent unless MV_CHECKOUT_TEST_RELEASE=enabled (same 400 UNKNOWN_STEP), exact {step} body, bearer still required; refusals touch no dependency", async () => {
  assert.equal(intentApiGate(ENV).config.testRelease, false);
  assert.equal(intentApiGate({ ...ENV, MV_CHECKOUT_TEST_RELEASE: "true" }).config.testRelease, false);
  assert.equal(intentApiGate({ ...ENV, MV_CHECKOUT_TEST_RELEASE: "enabled" }).config.testRelease, true);
  assert.deepEqual(intentApiGate({ ...ENV, MV_CHECKOUT_TEST_RELEASE: "enabled", VERCEL_ENV: "production" }), { ok: false, code: "PRODUCTION_REFUSED" });
  const { spies, deps } = spyDeps();
  const j = { origin: ORIGIN, "content-type": "application/json" };
  const tok = { authorization: `Bearer ${Buffer.alloc(32, 7).toString("base64url")}` };
  const off = createIntentApiHandler({ route: "step", env: ENV, deps });
  const on = createIntentApiHandler({ route: "step", env: { ...ENV, MV_CHECKOUT_TEST_RELEASE: "enabled" }, deps });
  const prod = createIntentApiHandler({ route: "step", env: { ...ENV, MV_CHECKOUT_TEST_RELEASE: "enabled", VERCEL_ENV: "production" }, deps });
  const cases = [
    [off, { headers: { ...j, ...tok }, body: '{"step":"release"}' }, 400, "UNKNOWN_STEP"],
    [on, { headers: j, body: '{"step":"release"}' }, 401, "UNAUTHORIZED"],
    [on, { headers: { ...j, ...tok }, body: '{"step":"release","paymentIntentId":"pi_x"}' }, 400, "UNKNOWN_FIELD"],
    [on, { headers: { ...j, ...tok }, body: '{"step":"release","amountMinor":1}' }, 400, "UNKNOWN_FIELD"],
    [prod, { headers: { ...j, ...tok }, body: '{"step":"release"}' }, 404, "NOT_FOUND"],
    [on, { headers: { origin: "https://evil.example", "content-type": "application/json", ...tok }, body: '{"step":"release"}' }, 403, "ORIGIN_NOT_ALLOWED"]
  ];
  for (const [hd, req, st, code] of cases) { const r = await call(hd, req); assert.deepEqual([r.statusCode, r.body.code], [st, code], JSON.stringify(req)); }
  assert.deepEqual(spies, { pool: 0, core: 0, access: 0, sdk: 0, hostaway: 0 });
});

test("Checkout SDK clients pin apiVersion 2026-01-28.clover (= installed stripe default), retries 0, timeout 10 s; the release core imports no worker / provider client", async () => {
  const { readFileSync } = await import("node:fs");
  const { CHECKOUT_STRIPE_API_VERSION } = await import("../lib/checkout/intent-api-http.js");
  const { WEBHOOK_STRIPE_API_VERSION } = await import("../lib/checkout/stripe-webhook-http.js");
  assert.equal(CHECKOUT_STRIPE_API_VERSION, "2026-01-28.clover");
  assert.equal(WEBHOOK_STRIPE_API_VERSION, CHECKOUT_STRIPE_API_VERSION);
  const sdk = readFileSync(new URL("../node_modules/stripe/cjs/apiVersion.js", import.meta.url), "utf8");
  assert.match(sdk, /ApiVersion = '2026-01-28\.clover'/, "installed SDK default unchanged (no package change)");
  const http = readFileSync(new URL("../lib/checkout/intent-api-http.js", import.meta.url), "utf8");
  const wh = readFileSync(new URL("../lib/checkout/stripe-webhook-http.js", import.meta.url), "utf8");
  assert.ok(http.includes("new Stripe(cfg.secretKey, { apiVersion: CHECKOUT_STRIPE_API_VERSION, maxNetworkRetries: 0, timeout: 10000 })"));
  assert.ok(wh.includes("new Stripe(gate.config.secretKey, { apiVersion: WEBHOOK_STRIPE_API_VERSION, maxNetworkRetries: 0, timeout: 10000 })"));
  assert.equal((http.match(/new Stripe\(/g) || []).length, 1); assert.equal((wh.match(/new Stripe\(/g) || []).length, 1);
  // Checkout keeps its card-only shape (unchanged in this slice)
  assert.ok(readFileSync(new URL("../lib/checkout/stripe-test-mode.js", import.meta.url), "utf8").includes('payment_method_types: ["card"],'));
  const core = readFileSync(new URL("../lib/checkout/intent-api-core.js", import.meta.url), "utf8");
  for (const re of [/compensation-worker|reservation-worker|capture-worker|recording-worker|notification-worker/, /paymentIntents\.cancel|cancelPaymentIntent/, /hostaway-reservations/]) {
    assert.doesNotMatch(core, re);
  }
});

// ---------- POST {step:"status"} alias (UNIT MOCKS: fake pool / access / core; browser-header evidence is a separate loopback rehearsal) ----------
function fakeStatusDeps({ allow = true, intentId = "11111111-2222-4333-8444-555555555555" } = {}) {
  const seen = { status: 0, create: 0, pay: 0, details: 0, release: 0, hits: [] };
  const pool = { query: async (sql) => (/booking\.instance/.test(sql) ? { rows: [{ environment: "test" }] } : { rows: [] }) };
  return { seen, deps: {
    createPool: () => pool,
    loadAccess: async () => ({ rateLimitHit: async (_p, bucket) => { seen.hits.push(bucket.split(":")[0]); return allow; }, findIntentIdByTokenHash: async () => intentId }),
    loadCore: async () => ({
      intentStatus: async (_ctx, id) => { seen.status++; return { http: 200, body: { status: "processing", quoteExpiresAt: null, price: null, id } }; },
      createCheckoutIntent: async () => { seen.create++; throw new Error("no"); }, payIntent: async () => { seen.pay++; throw new Error("no"); },
      submitDetails: async () => { seen.details++; throw new Error("no"); }, releaseIntent: async () => { seen.release++; throw new Error("no"); } }),
    loadStripe: async () => { throw new Error("no SDK"); }, loadHostaway: async () => { throw new Error("no Hostaway"); }, log: () => {} } };
}
test("POST {step:'status'}: same projection as GET status through the same core; Origin / bearer / exact-body / gate / rate limits unchanged; no create/pay/details/release", async () => {
  const j = { origin: ORIGIN, "content-type": "application/json" };
  const tok = { authorization: `Bearer ${Buffer.alloc(32, 9).toString("base64url")}` };
  const f = fakeStatusDeps();
  const s = createIntentApiHandler({ route: "step", env: ENV, deps: f.deps });
  const ok = await call(s, { headers: { ...j, ...tok }, body: '{"step":"status"}' });
  assert.deepEqual([ok.statusCode, ok.body.status], [200, "processing"]);
  assert.deepEqual([f.seen.status, f.seen.create, f.seen.pay, f.seen.details, f.seen.release], [1, 0, 0, 0, 0]);
  assert.deepEqual(f.seen.hits, ["unattributed", "tok"], "the same shared + per-token limits as GET status");
  const g = createIntentApiHandler({ route: "intents", env: ENV, deps: f.deps });
  const viaGet = await call(g, { method: "GET", headers: { origin: ORIGIN, ...tok } });
  assert.deepEqual(viaGet.body, ok.body, "identical projection");
  // refusals before any dependency
  const { spies, deps } = spyDeps();
  const s2 = createIntentApiHandler({ route: "step", env: ENV, deps });
  const off = createIntentApiHandler({ route: "step", env: { ...ENV, MV_CHECKOUT_TEST_API: "no" }, deps });
  const cases = [
    [s2, { headers: { "content-type": "application/json", ...tok }, body: '{"step":"status"}' }, 403, "ORIGIN_NOT_ALLOWED"],
    [s2, { headers: { origin: "https://evil.example", "content-type": "application/json", ...tok }, body: '{"step":"status"}' }, 403, "ORIGIN_NOT_ALLOWED"],
    [s2, { headers: j, body: '{"step":"status"}' }, 401, "UNAUTHORIZED"],
    [s2, { headers: { ...j, authorization: "Bearer short" }, body: '{"step":"status"}' }, 401, "UNAUTHORIZED"],
    [s2, { headers: { ...j, ...tok }, body: '{"step":"status","token":"x"}' }, 400, "UNKNOWN_FIELD"],
    [s2, { headers: { ...j, ...tok }, body: '{"step":"status","intentId":"x"}' }, 400, "UNKNOWN_FIELD"],
    [off, { headers: { ...j, ...tok }, body: '{"step":"status"}' }, 404, "NOT_FOUND"]
  ];
  for (const [hd, req, st, code] of cases) { const r = await call(hd, req); assert.deepEqual([r.statusCode, r.body && r.body.code], [st, code], JSON.stringify(req)); }
  assert.deepEqual(spies, { pool: 0, core: 0, access: 0, sdk: 0, hostaway: 0 });
  // GET without Origin is still refused (no relaxation)
  const r = await call(g, { method: "GET", headers: { ...tok } });
  assert.deepEqual([r.statusCode, r.body.code], [403, "ORIGIN_NOT_ALLOWED"]);
  // rate limited -> 429, core not called
  const lim = fakeStatusDeps({ allow: false });
  const rl = await call(createIntentApiHandler({ route: "step", env: ENV, deps: lim.deps }), { headers: { ...j, ...tok }, body: '{"step":"status"}' });
  assert.deepEqual([rl.statusCode, rl.body.code, lim.seen.status], [429, "RATE_LIMITED", 0]);
});
