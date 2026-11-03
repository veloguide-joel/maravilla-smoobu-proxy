// Stage E6 — intent API HTTP layer, pure parts (no database, no SDK, no network). Full flows: test/db/e6-intent-api.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { intentApiGate, parseTestListings, tokenHashFromHeader, clientAddress, createIntentApiHandler } from "../lib/checkout/intent-api-http.js";
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

test("client address for rate limiting: first X-Forwarded-For entry, else X-Real-IP, else socket (platform behaviour UNVERIFIED)", () => {
  assert.equal(clientAddress({ headers: { "x-forwarded-for": "203.0.113.5, 10.0.0.1" } }), "203.0.113.5");
  assert.equal(clientAddress({ headers: { "x-real-ip": "203.0.113.6" } }), "203.0.113.6");
  assert.equal(clientAddress({ headers: {}, socket: { remoteAddress: "127.0.0.1" } }), "127.0.0.1");
  assert.equal(clientAddress({ headers: {} }), "unknown");
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
