// D3a: browser caching of /api/booking/listings must never produce a copy without CORS headers.
// Offline: fake global fetch, direct handler calls. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";

const DEV = "https://maravilla-booking-ui-git-dev-joel-goralskis-projects.vercel.app";
const raw = (id) => ({ id, name: "N", externalListingName: "N", personCapacity: 2, bedroomsNumber: 1, bathroomsNumber: 1, city: "Bucerías", currencyCode: "MXN", price: 2200, minNights: 1, maxNights: 365, description: "d", listingImages: [], thumbnailUrl: "" });
globalThis.fetch = async (url) => {
  const u = String(url), j = (b) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
  if (u.endsWith("/accessTokens")) return j({ token_type: "Bearer", expires_in: 3600, access_token: "fake-token" });
  const m = u.match(/\/listings\/(\d+)\?/);
  return j({ status: "success", result: raw(Number(m[1])) });
};
process.env.HOSTAWAY_ACCOUNT_ID = "fake"; process.env.HOSTAWAY_CLIENT_SECRET = "fake"; delete process.env.BOOKING_UI_ORIGINS;
const { default: handler } = await import("../api/booking/listings.js");

const mk = () => { const r = { headers: {}, statusCode: null }; r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; return r; }; r.end = () => r; return r; };
const call = async (headers = {}, method = "GET") => { const res = mk(); await handler({ method, headers, query: {} }, res); return res; };

test("no Origin (direct visit / curl): 200 but no-store; Vary: Origin; no ACAO", async () => {
  const r = await call();
  assert.equal(r.statusCode, 200);
  assert.equal(r.headers["cache-control"], "no-store");
  assert.equal(r.headers.vary, "Origin");
  assert.equal("access-control-allow-origin" in r.headers, false);
});

test("allowed origins: browser-cacheable AND carry matching ACAO + Vary: Origin (miss and hit paths)", async () => {
  for (const o of [DEV, "http://localhost:5500", "http://127.0.0.1:5500"]) {
    for (let i = 0; i < 2; i++) { // first may be a miss, second is a memory-cache hit
      const r = await call({ origin: o });
      assert.equal(r.headers["cache-control"], "private, max-age=300", o);
      assert.equal(r.headers["access-control-allow-origin"], o);
      assert.equal(r.headers.vary, "Origin");
    }
  }
});

test("unlisted origin: no ACAO, no-store, never wildcard (also on the memory-cache hit path)", async () => {
  for (const o of ["https://evil.example", "https://maravilla-booking-ui-git-dev-joel-goralskis-projects.vercel.app.evil.example", "null", "http://localhost:5501"]) {
    const r = await call({ origin: o });
    assert.equal(r.headers["cache-control"], "no-store", o);
    assert.equal("access-control-allow-origin" in r.headers, false, o);
    assert.equal(r.headers.vary, "Origin");
  }
});

test("any response with a browser cache lifetime has ACAO equal to the request origin", async () => {
  for (const h of [{}, { origin: DEV }, { origin: "https://evil.example" }, { origin: "http://localhost:5500" }]) {
    const r = await call(h);
    if (/max-age/.test(r.headers["cache-control"] || "")) assert.equal(r.headers["access-control-allow-origin"], h.origin);
    assert.notEqual(r.headers["access-control-allow-origin"], "*");
  }
});

test("preflight and non-GET behaviour unchanged", async () => {
  let r = await call({ origin: DEV }, "OPTIONS");
  assert.deepEqual([r.statusCode, r.headers["access-control-allow-origin"]], [204, DEV]);
  r = await call({ origin: "https://evil.example" }, "OPTIONS");
  assert.equal(r.statusCode, 403);
  r = await call({}, "POST");
  assert.deepEqual([r.statusCode, r.headers["cache-control"], r.headers.allow], [405, "no-store", "GET, OPTIONS"]);
});
