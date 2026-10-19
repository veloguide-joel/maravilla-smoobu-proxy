// C2 regression: /api/booking/listings is never browser-cacheable, for any origin, on any path.
// (Browser-cache/304 behaviour itself is proven separately in a real browser — see the C2 report.)
// Offline: fake Hostaway via global fetch. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { PUBLIC_LISTING_KEYS } from "../lib/listing-public.js";

const UI_DEV = "https://maravilla-booking-ui-git-dev-joel-goralskis-projects.vercel.app";          // built-in allowlist
const UI_FEATURE = "https://maravilla-booking-ui-git-feature-227ea7-joel-goralskis-projects.vercel.app"; // via BOOKING_UI_ORIGINS (as on Vercel Preview)
const UNAPPROVED = ["https://evil.example", `${UI_DEV}.evil.example`, "null", "http://localhost:5501"];
process.env.BOOKING_UI_ORIGINS = UI_FEATURE;
process.env.HOSTAWAY_ACCOUNT_ID = "fake"; process.env.HOSTAWAY_CLIENT_SECRET = "fake";

let scenario = "ok", upstream = 0;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url), j = (s, b) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
  if (u.endsWith("/accessTokens")) return j(200, { token_type: "Bearer", expires_in: 3600, access_token: "fake-token" });
  upstream += 1;
  const id = Number(u.match(/\/listings\/(\d+)\?/)[1]);
  if (scenario === "all-500") return j(500, { status: "fail" });
  if (scenario === "one-500" && id === 603566) return j(500, { status: "fail" });
  return j(200, { status: "success", result: { id, name: `L${id}`, personCapacity: 2, bedroomsNumber: 1, bathroomsNumber: 1, city: "Bucerías", currencyCode: "MXN", minNights: 1, maxNights: 365, listingImages: [], listingAmenities: [{ amenityName: "Wireless" }] } });
};
const mk = () => { const r = { headers: {}, statusCode: null, body: undefined }; r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; return r; }; r.end = () => r; return r; };
let n = 0;
const fresh = async () => (await import(`../api/booking/listings.js?c2=${++n}`)).default; // new module = empty memory cache
const call = async (handler, { origin, method = "GET" } = {}) => { const res = mk(); await handler({ method, headers: origin ? { origin } : {}, query: {} }, res); return res; };
const expectNoStore = (r, label) => { assert.equal(r.headers["cache-control"], "no-store", `${label}: cache-control`); assert.equal(r.headers.vary, "Origin", `${label}: vary`); assert.notEqual(r.headers["access-control-allow-origin"], "*", `${label}: wildcard`); };

test("both approved UI origins: 200, exact ACAO, Vary: Origin, no-store — on the miss and the hit path", async () => {
  scenario = "ok"; const h = await fresh();
  for (const o of [UI_DEV, UI_FEATURE]) for (let i = 0; i < 2; i++) {
    const r = await call(h, { origin: o });
    assert.equal(r.statusCode, 200); expectNoStore(r, o);
    assert.equal(r.headers["access-control-allow-origin"], o);
  }
});

test("sequential origins in both orders on one warm instance: each response carries its own ACAO and no-store; one upstream build", async () => {
  for (const order of [[UI_DEV, UI_FEATURE, UI_DEV], [UI_FEATURE, UI_DEV, UI_FEATURE]]) {
    scenario = "ok"; upstream = 0; const h = await fresh();
    const rs = []; for (const o of order) rs.push(await call(h, { origin: o }));
    rs.forEach((r, i) => { expectNoStore(r, order[i]); assert.equal(r.headers["access-control-allow-origin"], order[i]); });
    assert.deepEqual(rs.map((r) => r.headers["x-listings-cache"]), ["miss", "hit", "hit"]);
    assert.equal(upstream, 2, "only the first request reaches Hostaway (2 pilot GETs)");
    assert.equal(JSON.stringify(rs[0].body.listings), JSON.stringify(rs[2].body.listings), "same body for every origin");
  }
});

test("repeated requests from the same origin stay no-store and come from the server memory cache", async () => {
  scenario = "ok"; upstream = 0; const h = await fresh();
  const rs = []; for (let i = 0; i < 4; i++) rs.push(await call(h, { origin: UI_FEATURE }));
  rs.forEach((r, i) => expectNoStore(r, `repeat ${i}`));
  assert.deepEqual(rs.map((r) => r.headers["x-listings-cache"]), ["miss", "hit", "hit", "hit"]);
  assert.equal(upstream, 2);
});

test("no Origin header and unapproved origins: 200 public body, no ACAO, no-store, Vary: Origin", async () => {
  scenario = "ok"; const h = await fresh();
  for (const o of [undefined, ...UNAPPROVED]) for (let i = 0; i < 2; i++) {
    const r = await call(h, { origin: o });
    assert.equal(r.statusCode, 200); expectNoStore(r, String(o));
    assert.equal("access-control-allow-origin" in r.headers, false, String(o));
  }
});

test("error and partial paths are no-store too (and keep CORS for approved origins)", async () => {
  scenario = "one-500"; let h = await fresh();
  let r = await call(h, { origin: UI_DEV });
  assert.equal(r.statusCode, 200); assert.equal(r.body.partial, true); expectNoStore(r, "partial"); assert.equal(r.headers["access-control-allow-origin"], UI_DEV);
  scenario = "all-500"; h = await fresh();
  r = await call(h, { origin: UI_FEATURE });
  assert.equal(r.statusCode, 502); expectNoStore(r, "502"); assert.equal(r.headers["access-control-allow-origin"], UI_FEATURE);
  delete process.env.HOSTAWAY_CLIENT_SECRET; h = await fresh();
  r = await call(h, { origin: UI_DEV });
  process.env.HOSTAWAY_CLIENT_SECRET = "fake";
  assert.equal(r.statusCode, 503); expectNoStore(r, "503");
  r = await call(h, { origin: UI_DEV, method: "POST" });
  assert.equal(r.statusCode, 405); expectNoStore(r, "405");
});

test("preflight unchanged: 204 + ACAO for approved origins, 403 without CORS headers otherwise", async () => {
  const h = await fresh();
  for (const o of [UI_DEV, UI_FEATURE]) { const r = await call(h, { origin: o, method: "OPTIONS" }); assert.equal(r.statusCode, 204); assert.equal(r.headers["access-control-allow-origin"], o); assert.equal(r.headers.vary, "Origin"); }
  const bad = await call(h, { origin: "https://evil.example", method: "OPTIONS" }); assert.equal(bad.statusCode, 403); assert.equal("access-control-allow-origin" in bad.headers, false);
});

test("the handler never sets an ETag or answers 304 itself (Vercel's helper does; no-store makes its 304s non-reusable)", async () => {
  scenario = "ok"; const h = await fresh();
  const r = await call(h, { origin: UI_DEV });
  assert.equal("etag" in r.headers, false); assert.notEqual(r.statusCode, 304);
});

test("public-field whitelist unchanged (20 keys) under the new cache policy", async () => {
  scenario = "ok"; const h = await fresh();
  const r = await call(h, { origin: UI_FEATURE });
  for (const l of r.body.listings) assert.deepEqual(Object.keys(l).sort(), [...PUBLIC_LISTING_KEYS].sort());
  assert.equal(PUBLIC_LISTING_KEYS.length, 20);
});

test("source guard: no browser max-age remains in the listings route", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../api/booking/listings.js", import.meta.url), "utf8");
  assert.equal(/max-age|BROWSER_MAX_AGE/.test(src.replace(/^\s*\/\/.*$/gm, "")), false);
});
