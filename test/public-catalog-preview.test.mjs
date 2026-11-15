// E7 C85 — preview catalog for the 28 migrated listings (read-only browse / calendar / quote), pilot default kept.
// Fakes global fetch; no network, no credentials. Run: npm test
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { PUBLIC_LISTING_IDS, PUBLIC_LISTING_KEYS } from "../lib/listing-public.js";
import { MIGRATED_PREVIEW_LISTING_IDS, PREVIEW_CATALOG_IDS, NEVER_PUBLIC_LISTING_IDS, resolvePublicCatalog, isPublicCatalogId, LISTINGS_FETCH_CONCURRENCY } from "../lib/public-catalog.js";
import { todayInTimeZone } from "../lib/public-api.js";
import { addDays } from "../lib/bookability.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEV_ORIGIN = "https://maravilla-booking-ui-git-dev-joel-goralskis-projects.vercel.app";
const EXACT_28 = [628346, 628372, 628373, 628374, 628375, 628376, 628377, 628378, 628379, 628380, 628382, 628383, 628384, 628385, 628386,
  628388, 628389, 628390, 628391, 628392, 628393, 628394, 628395, 628396, 628397, 628398, 628399, 628400];
const PRIVATE = ["Calle Privada 7", "20.7502", "-105.3299", "owner@example.com", "+52 322 000 0000", "4321", "secret-pass", "INTERNAL-", "LIC-9"];

const rawListing = (id) => ({
  id, name: `Listing ${id}`, externalListingName: `Listing ${id}`, internalListingName: `INTERNAL-${id}`, personCapacity: 4, bedroomsNumber: 2, bedsNumber: 2,
  bathroomsNumber: 1.5, city: "Bucerías", currencyCode: PUBLIC_LISTING_IDS.includes(id) ? "MXN" : "USD", price: 150, minNights: 3, maxNights: 90,
  checkInTimeStart: 15, checkOutTime: 11, description: "Door code 4321 at Calle Privada 7. WiFi password: secret-pass.",
  listingImages: [{ url: `https://example-cdn.test/${id}.jpg`, sortOrder: 1 }], listingAmenities: [{ id: 1, amenityId: 2, amenityName: "Wireless" }],
  address: "Calle Privada 7", street: "Calle Privada 7", lat: 20.7502, lng: -105.3299, contactEmail: "owner@example.com", contactPhone1: "+52 322 000 0000",
  wifiPassword: "secret-pass", doorSecurityCode: "4321", propertyLicenseNumber: "LIC-9", airbnbListingUrl: "https://airbnb.example/rooms/1"
});
const day = (date, over = {}) => ({ id: 1, date, isAvailable: 1, isProcessed: 1, status: "available", price: 150, minimumStay: 1, maximumStay: 0,
  closedOnArrival: null, closedOnDeparture: null, note: "PRIVATE NOTE", reservations: [], ...over });

let state;
function resetFetch() {
  state = { calls: [], mints: 0, inFlight: 0, maxInFlight: 0, failIds: new Set(), blocked: new Set(), missingDays: new Set(), slowMs: 0 };
}
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (u.endsWith("/accessTokens")) { state.mints += 1; return json(200, { token_type: "Bearer", expires_in: 3600, access_token: "fake-token-not-a-secret" }); }
  state.calls.push({ url: u, method: init.method || "GET" });
  state.inFlight += 1; state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
  try {
    if (state.slowMs) await new Promise((r) => setTimeout(r, state.slowMs));
    let m = u.match(/\/listings\/(\d+)\/calendar\?(.*)$/);
    if (m) {
      const id = Number(m[1]); const qs = new URLSearchParams(m[2]); const out = [];
      for (let d = qs.get("startDate"); d <= qs.get("endDate"); d = addDays(d, 1)) if (!state.missingDays.has(d)) out.push(day(d, state.blocked.has(d) ? { status: "blocked", isAvailable: 0 } : {}));
      return json(200, { status: "success", result: out, id });
    }
    if (/\/calendar\/priceDetails/.test(u)) return json(200, { status: "success", result: { totalPrice: 450, components: [] } });
    m = u.match(/\/listings\/(\d+)(\?|$)/);
    const id = m ? Number(m[1]) : null;
    if (state.failIds.has(id)) return json(500, { status: "fail" });
    return json(200, { status: "success", result: rawListing(id) });
  } finally { state.inFlight -= 1; }
};
process.env.HOSTAWAY_ACCOUNT_ID = "fake-account";
process.env.HOSTAWAY_CLIENT_SECRET = "fake-secret";
function setCatalog(mode, vercelEnv) {
  if (mode === undefined) delete process.env.MV_PUBLIC_CATALOG; else process.env.MV_PUBLIC_CATALOG = mode;
  if (vercelEnv === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = vercelEnv;
}
beforeEach(() => { resetFetch(); setCatalog(undefined, undefined); });

function makeRes() {
  const r = { headers: {}, statusCode: null, body: undefined };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.end = () => r;
  return r;
}
let seq = 0;
async function route(name, query = {}) {
  const mod = await import(`../api/booking/${name}.js?c85=${++seq}`);
  const res = makeRes(); await mod.default({ method: "GET", headers: { origin: DEV_ORIGIN }, query }, res);
  return res;
}

// ---------------------------------------------------------------------------------------------
test("P1 exact catalog: the 28 migrated ids exactly; never TEST 606998 / 628381 / 628387; pilots unchanged; frozen", () => {
  assert.deepEqual([...MIGRATED_PREVIEW_LISTING_IDS], EXACT_28);
  assert.equal(MIGRATED_PREVIEW_LISTING_IDS.length, 28);
  assert.deepEqual([...PUBLIC_LISTING_IDS], [603564, 603566], "the production / default pilot catalog is unchanged");
  assert.deepEqual([...PREVIEW_CATALOG_IDS], [603564, 603566, ...EXACT_28]);
  for (const id of [606998, 628381, 628387]) { assert.ok(NEVER_PUBLIC_LISTING_IDS.includes(id)); assert.equal(PREVIEW_CATALOG_IDS.includes(id), false, String(id)); }
  for (const a of [MIGRATED_PREVIEW_LISTING_IDS, PREVIEW_CATALOG_IDS, NEVER_PUBLIC_LISTING_IDS]) assert.ok(Object.isFrozen(a));
  assert.equal(new Set(PREVIEW_CATALOG_IDS).size, PREVIEW_CATALOG_IDS.length, "no duplicates");
});

test("P2 mode gate: pilot by default and ALWAYS in production; preview only on preview / development; unknown mode fails closed", () => {
  const r = (env) => resolvePublicCatalog(env);
  assert.deepEqual([r({}).mode, r({}).ids, r({}).reason], ["pilot", PUBLIC_LISTING_IDS, null]);
  assert.deepEqual([r({ MV_PUBLIC_CATALOG: "pilot", VERCEL_ENV: "preview" }).mode], ["pilot"]);
  assert.deepEqual([r({ MV_PUBLIC_CATALOG: "migrated-preview", VERCEL_ENV: "production" }).mode, r({ MV_PUBLIC_CATALOG: "migrated-preview", VERCEL_ENV: "production" }).reason], ["pilot", "PREVIEW_CATALOG_REFUSED_ENV"]);
  assert.equal(r({ MV_PUBLIC_CATALOG: "migrated-preview" }).reason, "PREVIEW_CATALOG_REFUSED_ENV", "no VERCEL_ENV → refused");
  assert.deepEqual([r({ MV_PUBLIC_CATALOG: "all", VERCEL_ENV: "preview" }).mode, r({ MV_PUBLIC_CATALOG: "all", VERCEL_ENV: "preview" }).reason], ["pilot", "CATALOG_MODE_UNKNOWN"]);
  for (const v of ["preview", "development"]) assert.deepEqual(r({ MV_PUBLIC_CATALOG: "migrated-preview", VERCEL_ENV: v }).ids, PREVIEW_CATALOG_IDS);
  const pv = r({ MV_PUBLIC_CATALOG: "migrated-preview", VERCEL_ENV: "preview" });
  assert.equal(isPublicCatalogId(628346, pv), true); assert.equal(isPublicCatalogId(628346, r({})), false);
  for (const id of [606998, 628381, 628387, 999999]) assert.equal(isPublicCatalogId(id, pv), false, String(id));
});

test("P3 listings feed, preview: all 30 in catalog order, sanitized keys only, truthful currency per listing, <= 4 in flight", async () => {
  setCatalog("migrated-preview", "preview");
  const res = await route("listings");
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.listings.map((l) => l.id), [...PREVIEW_CATALOG_IDS]);
  assert.equal(res.body.partial, undefined);
  for (const l of res.body.listings) {
    for (const k of Object.keys(l)) assert.ok(PUBLIC_LISTING_KEYS.includes(k), k);
    assert.equal(l.currency, PUBLIC_LISTING_IDS.includes(l.id) ? "MXN" : "USD", "the listing's own currency, never converted");
    assert.equal(l.description, null, "full description stays unpublished");
  }
  const body = JSON.stringify(res.body);
  for (const p of PRIVATE) assert.equal(body.includes(p), false, `leaked ${p}`);
  assert.ok(state.maxInFlight <= LISTINGS_FETCH_CONCURRENCY, `max in flight ${state.maxInFlight}`);
  assert.equal(state.calls.length, 30, "exactly one GET per catalog listing, no retry");
  assert.equal(res.headers["cache-control"], "no-store");
  assert.equal(res.headers["access-control-allow-origin"], DEV_ORIGIN);
});

test("P4 listings feed, default + production-with-flag: pilots only; no migrated id is ever requested", async () => {
  for (const [mode, env] of [[undefined, undefined], ["migrated-preview", "production"], ["something", "preview"]]) {
    resetFetch(); setCatalog(mode, env);
    const res = await route("listings");
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.listings.map((l) => l.id), [603564, 603566]);
    assert.ok(state.calls.every((c) => !EXACT_28.some((id) => c.url.includes(`/${id}`))), `${mode}/${env}`);
  }
});

test("P5 partial failure: failing listings are omitted (ids not disclosed), partial:true, never cached; all failing → 502", async () => {
  setCatalog("migrated-preview", "preview");
  state.failIds = new Set([628346, 628399]);
  const res = await route("listings");
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.partial, true);
  assert.equal(res.body.listings.length, 28);
  assert.equal(JSON.stringify(res.body).includes("628399"), false);
  assert.equal(res.headers["x-listings-cache"], "miss");
  resetFetch(); state.failIds = new Set(PREVIEW_CATALOG_IDS);
  const bad = await route("listings");
  assert.deepEqual([bad.statusCode, bad.body], [502, { ok: false, error: "LISTINGS_UNAVAILABLE" }]);
});

test("P6 deadline: no request starts after the cutoff; unstarted listings count as missing (partial), never a whole-feed failure", async () => {
  const { buildBody } = await import(`../api/booking/listings.js?c85=${++seq}`);
  let t = 0; const started = [];
  const fetchOne = async (id) => { started.push(id); t += 1000; return { ok: true, id, listing: { id } }; };   // each fetch "takes" 1 s of the fake clock
  const r = await buildBody(PREVIEW_CATALOG_IDS, { concurrency: 1, startCutoffMs: 5000, fetchOne, now: () => t });
  assert.equal(r.status, 200);
  assert.equal(r.body.partial, true);
  assert.deepEqual(started, PREVIEW_CATALOG_IDS.slice(0, 6), "requests start only while within the cutoff");
  assert.equal(r.body.listings.length, 6);
  // concurrency bound
  let live = 0, peak = 0;
  const slow = async (id) => { live += 1; peak = Math.max(peak, live); await new Promise((x) => setTimeout(x, 5)); live -= 1; return { ok: true, id, listing: { id } }; };
  const r2 = await buildBody(PREVIEW_CATALOG_IDS, { fetchOne: slow });
  assert.equal(r2.body.listings.length, 30); assert.ok(peak <= LISTINGS_FETCH_CONCURRENCY && peak > 1, String(peak));
});

test("P7 cache scope: a body cached for one catalog mode is never served for another", async () => {
  setCatalog("migrated-preview", "preview");
  const mod = await import(`../api/booking/listings.js?c85=${++seq}`);
  let res = makeRes(); await mod.default({ method: "GET", headers: { origin: DEV_ORIGIN }, query: {} }, res);
  assert.equal(res.body.listings.length, 30);
  setCatalog(undefined, undefined);
  res = makeRes(); await mod.default({ method: "GET", headers: { origin: DEV_ORIGIN }, query: {} }, res);
  assert.deepEqual([res.headers["x-listings-cache"], res.body.listings.length], ["miss", 2]);
});

test("P8 calendar + quote gate: migrated ids only in preview; TEST / non-existent / foreign ids 404 in every mode; unknown days stay unavailable", async () => {
  const from = addDays(todayInTimeZone(), 30); const to = addDays(from, 5);
  setCatalog(undefined, undefined);
  assert.equal((await route("calendar", { id: "628346", from, to })).statusCode, 404, "pilot mode: migrated id not served");
  setCatalog("migrated-preview", "preview");
  for (const id of ["606998", "628381", "628387", "123456"]) assert.equal((await route("calendar", { id, from, to })).statusCode, 404, id);
  state.missingDays = new Set([addDays(from, 2)]);
  const cal = await route("calendar", { id: "628346", from, to });
  assert.equal(cal.statusCode, 200, JSON.stringify(cal.body));
  assert.equal(cal.body.coverage.complete, false, "a missing day is reported, never assumed available");
  assert.equal(JSON.stringify(cal.body).includes("PRIVATE NOTE"), false);
  // quote: blocked night → available:false and NO price request
  resetFetch(); state.blocked = new Set([addDays(from, 1)]);
  const q = await route("quote", { id: "628346", from, to, guests: "2" });
  assert.equal(q.statusCode, 200, JSON.stringify(q.body));
  assert.equal(q.body.available, false);
  assert.equal(q.body.currency, "USD");
  assert.equal(state.calls.filter((c) => /priceDetails/.test(c.url)).length, 0);
  setCatalog(undefined, undefined);
  assert.equal((await route("quote", { id: "628346", from, to, guests: "2" })).statusCode, 404);
});

test("P9 single-flight token: concurrent cold requests mint ONE token; a 401 re-mints once and retries once", async () => {
  const hw = await import(`../lib/hostaway.js?c85=${++seq}`);
  await Promise.all(Array.from({ length: 6 }, (_, i) => hw.hostawayGet(`/listings/${EXACT_28[i]}`)));
  assert.equal(state.mints, 1, "one mint for six concurrent cold requests");
  const orig = globalThis.fetch; let first = true;
  globalThis.fetch = async (url, init) => (String(url).endsWith("/accessTokens") || !first ? orig(url, init) : ((first = false), new Response("{}", { status: 401 })));
  try {
    const r = await hw.hostawayGet(`/listings/${EXACT_28[0]}`);
    assert.deepEqual([r.status, r.retried, state.mints], [200, true, 2]);
  } finally { globalThis.fetch = orig; }
});

test("P10 no-booking boundary: checkout code never reads the public catalog; the public routes create nothing", () => {
  const files = (d) => readdirSync(join(ROOT, d)).filter((f) => f.endsWith(".js")).map((f) => join(d, f));
  for (const f of [...files("lib/checkout"), ...files("api/checkout"), ...files("lib/booking-db")]) {
    const src = readFileSync(join(ROOT, f), "utf8");
    assert.equal(/public-catalog|listing-public|PUBLIC_LISTING_IDS|MV_PUBLIC_CATALOG/.test(src), false, f);
  }
  for (const r of ["listings", "calendar", "quote"]) {
    const src = readFileSync(join(ROOT, `api/booking/${r}.js`), "utf8");
    assert.equal(/booking-db|checkout\/|stripe|createReservation|hostawayPost\(`\/reservations/.test(src), false, r);
    assert.equal(/req\.query\?\.(ids|catalog|mode)|req\.query\.(ids|catalog|mode)/.test(src), false, `${r}: no client-supplied catalog`);
  }
});
