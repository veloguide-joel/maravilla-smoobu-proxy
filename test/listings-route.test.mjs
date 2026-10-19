// Route-level tests for GET /api/booking/listings (Stage F1 harness, committed and updated for UX2a).
// Fakes global fetch; no network. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { PUBLIC_LISTING_KEYS, PUBLISH_DESCRIPTION } from "../lib/listing-public.js";

const DEV_ORIGIN = "https://maravilla-booking-ui-git-dev-joel-goralskis-projects.vercel.app";
const ORIGINAL_15 = ["bathrooms", "bedrooms", "city", "currency", "id", "images", "img", "maxNights", "minNights", "name", "sleeps", "slug", "source", "summary", "tagline"];
const UX2A_5 = ["amenities", "beds", "checkInFrom", "checkOutBy", "description"];

// Private/malicious material salted into every raw listing; none of it may reach the public body.
const PRIVATE_DESCRIPTION = "<p>Lovely studio.</p><script>alert(1)</script> Door code 4321, lockbox by the gate. WiFi password: secret-pass. WhatsApp +52 322 123 4567, owner@example.com, Calle Morelos 12, 20.7512, -105.3321";
const CLEAN_DESCRIPTION = "<p>Bright studio two blocks from the beach.</p><p>Fast Wi-Fi and a shared rooftop.</p>";
let descriptionFixture = PRIVATE_DESCRIPTION;
let amenitiesFixture = null;
const rawListing = (id, name) => ({
  id, name, externalListingName: name, internalListingName: `INTERNAL-${id}`, personCapacity: 2, bedroomsNumber: 1, bedsNumber: 1, bathroomsNumber: 1, city: "Bucerías",
  currencyCode: "MXN", price: 2200, minNights: 1, maxNights: 365, checkInTimeStart: 15, checkOutTime: 11, description: descriptionFixture,
  listingImages: [{ url: `https://hostaway-platform.s3.us-west-2.amazonaws.com/${id}.jpg`, sortOrder: 1, caption: "" }],
  thumbnailUrl: `https://a0.muscache.com/${id}-t.jpg`,
  listingAmenities: amenitiesFixture || [{ id: 1, amenityId: 2, amenityName: "Wireless" }, { id: 2, amenityId: 3, amenityName: "Air conditioning" }],
  houseRules: "No parties. Key under the mat.", cancellationPolicy: "flexible", cancellationPolicyId: 879507,
  address: "Calle 5 de Mayo 12", street: "Calle 5 de Mayo 12", zipcode: "63732", lat: 20.75, lng: -105.33,
  contactEmail: "owner@example.com", contactPhone1: "+52 1 322 000 0000", wifiUsername: "casa-wifi", wifiPassword: "secret-pass", doorSecurityCode: "4321",
  airbnbListingUrl: "https://airbnb.com/rooms/1", propertyLicenseNumber: "LIC-1", cleaningFee: 0, guestNightlyTax: 0, listingBedTypes: []
});

let scenario = "ok";
let calls = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  calls.push({ url: u, hasAuth: !!(init.headers && init.headers.Authorization), signal: !!init.signal });
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (u.endsWith("/accessTokens")) return json(200, { token_type: "Bearer", expires_in: 3600, access_token: "fake-token-not-a-secret" });
  const m = u.match(/\/listings\/(\d+)\?/); const id = m ? Number(m[1]) : null;
  if (scenario === "ok") return json(200, { status: "success", result: rawListing(id, id === 603564 ? "Hacienda 5 De Mayo" : "East Side Studio") });
  if (scenario === "one-500") return id === 603566 ? json(500, { status: "fail" }) : json(200, { status: "success", result: rawListing(id, "Hacienda 5 De Mayo") });
  if (scenario === "all-500") return json(500, { status: "fail" });
  if (scenario === "bad-shape") return json(200, { status: "success", result: [1, 2, 3] });
  if (scenario === "id-mismatch") return json(200, { status: "success", result: rawListing(999, "Other") });
  if (scenario === "not-json") return new Response("<html>oops</html>", { status: 200 });
  if (scenario === "timeout") { await new Promise((_, rej) => { if (init.signal) init.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "TimeoutError" }))); }); }
  throw new Error("unknown scenario " + scenario);
};
process.env.HOSTAWAY_ACCOUNT_ID = "fake-account";
process.env.HOSTAWAY_CLIENT_SECRET = "fake-secret";
delete process.env.HOSTAWAY_DIAG_KEY;

function makeRes() {
  const r = { headers: {}, statusCode: null, body: undefined };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.end = () => r;
  return r;
}
let seq = 0;
/** A fresh module instance per call bypasses the route's memory cache. */
async function call({ method = "GET", headers = { origin: DEV_ORIGIN }, scn = "ok", reuse = null } = {}) {
  scenario = scn; calls = [];
  const mod = reuse || (await import(`../api/booking/listings.js?t=${++seq}`));
  const res = makeRes(); await mod.default({ method, headers, query: {} }, res);
  return { res, mod };
}

test("method and CORS gates make no upstream call", async () => {
  let { res } = await call({ method: "POST" });
  assert.equal(res.statusCode, 405); assert.equal(res.headers.allow, "GET, OPTIONS"); assert.equal(res.body.error, "METHOD_NOT_ALLOWED");
  ({ res } = await call({ method: "OPTIONS" })); assert.equal(res.statusCode, 204); assert.equal(res.headers["access-control-allow-origin"], DEV_ORIGIN);
  ({ res } = await call({ method: "OPTIONS", headers: { origin: "https://evil.example" } })); assert.equal(res.statusCode, 403); assert.equal("access-control-allow-origin" in res.headers, false);
  ({ res } = await call({ method: "OPTIONS", headers: {} })); assert.equal(res.statusCode, 403);
  assert.equal(calls.length, 0);
});

test("env guard: 503 without naming variables", async () => {
  delete process.env.HOSTAWAY_CLIENT_SECRET;
  const { res } = await call();
  process.env.HOSTAWAY_CLIENT_SECRET = "fake-secret";
  assert.equal(res.statusCode, 503); assert.equal(res.body.error, "LISTINGS_UNAVAILABLE"); assert.equal(JSON.stringify(res.body).includes("HOSTAWAY"), false);
});

test("happy path: pilot-scoped, exact 20-key allowlist, original 15 fields intact, headers unchanged", async () => {
  const { res } = await call();
  assert.equal(res.statusCode, 200); assert.equal(res.body.ok, true); assert.equal(res.body.listings.length, 2);
  assert.deepEqual(Object.keys(res.body), ["ok", "checkedAt", "listings"]);
  assert.deepEqual([...PUBLIC_LISTING_KEYS].sort(), [...ORIGINAL_15, ...UX2A_5].sort());
  for (const l of res.body.listings) assert.deepEqual(Object.keys(l).sort(), [...ORIGINAL_15, ...UX2A_5].sort());
  const [a, b] = res.body.listings;
  assert.deepEqual(res.body.listings.map((l) => l.id), [603564, 603566]);
  // original 15, value by value (unchanged by UX2a)
  assert.deepEqual({ ...a, images: undefined, summary: undefined, amenities: undefined, beds: undefined, checkInFrom: undefined, checkOutBy: undefined, description: undefined },
    { id: 603564, source: "hostaway", slug: "hostaway-603564", name: "Hacienda 5 De Mayo", sleeps: 2, bedrooms: 1, bathrooms: 1, city: "Bucerías", tagline: "1 BR • 1 Bath • Bucerías",
      img: "https://hostaway-platform.s3.us-west-2.amazonaws.com/603564.jpg", currency: "MXN", minNights: 1, maxNights: 365,
      images: undefined, summary: undefined, amenities: undefined, beds: undefined, checkInFrom: undefined, checkOutBy: undefined, description: undefined });
  assert.deepEqual(a.images, [{ url: "https://hostaway-platform.s3.us-west-2.amazonaws.com/603564.jpg" }]);
  assert.equal(a.summary, null); // the default fixture's description carries private content, so the excerpt fails closed
  assert.equal(b.slug, "hostaway-603566"); assert.equal(b.name, "East Side Studio");
  // UX2a fields
  assert.deepEqual([a.amenities, a.beds, a.checkInFrom, a.checkOutBy], [["Wireless", "Air conditioning"], 1, "15:00", "11:00"]);
  // headers (D3a behaviour unchanged)
  assert.equal(res.headers["access-control-allow-origin"], DEV_ORIGIN); assert.equal(res.headers.vary, "Origin");
  assert.equal(res.headers["cache-control"], "no-store"); assert.equal(res.headers["x-listings-cache"], "miss"); // C2: never browser-cacheable
  // upstream: one token mint + exactly the two pilot listing GETs, nothing else
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.filter((c) => c.hasAuth).map((c) => c.url.match(/\/listings\/(\d+)\?includeResources=1/)?.[1]), ["603564", "603566"]);
});

test("no private or internal data leaks (keys or values)", async () => {
  const { res } = await call();
  const text = JSON.stringify(res.body);
  const FORBIDDEN = ["address", "street", "zipcode", "63732", "Calle", "Morelos", "\"lat\"", "\"lng\"", "20.75", "105.33", "20.7512", "contact", "owner@", "+52", "322",
    "wifi", "WiFi", "secret", "4321", "lockbox", "WhatsApp", "password", "<script", "alert(", "houseRules", "No parties", "Key under", "cancellation", "flexible", "879507",
    "airbnb", "muscache", "LIC-1", "License", "INTERNAL-", "internalListingName", "price", "2200", "cleaningFee", "Tax", "fake-token", "_schema", "_meta", "upstream", "publicCandidate", "flags"];
  for (const f of FORBIDDEN) assert.equal(text.includes(f), false, `leaked: ${f}`);
});

test("description stays null for every source text (owner decision: not published until human-approved)", async () => {
  assert.equal(PUBLISH_DESCRIPTION, false);
  for (const d of [PRIVATE_DESCRIPTION, CLEAN_DESCRIPTION, "<img src=x onerror=alert(1)>", "x".repeat(10000), "", null, 42]) {
    descriptionFixture = d;
    const { res } = await call();
    for (const l of res.body.listings) {
      assert.equal(l.description, null, `description published for fixture ${String(d).slice(0, 30)}`);
      assert.ok(l.summary === null || (typeof l.summary === "string" && l.summary.length <= 201), "summary stays the bounded F1 excerpt");
    }
  }
  descriptionFixture = PRIVATE_DESCRIPTION;
});

test("summary (F1 excerpt of the same description) fails closed on private content; live pilot summaries unchanged", async () => {
  descriptionFixture = PRIVATE_DESCRIPTION;
  let { res } = await call();
  for (const l of res.body.listings) assert.equal(l.summary, null);
  const LIVE = [
    "Enjoy stunning bay views from this designer-created retreat at Hacienda 5 de Mayo. This west-facing, second-floor apartment features a full kitchen, dedicated workspace and private front balcony for…",
    "Welcome to Hacienda 5 de Mayo on Bucerías’ Upper East Side. This south-facing, second-floor studio offers a full kitchen and a spacious layout to work, sleep and unwind. Enjoy an elevator, shared…"
  ];
  for (const live of LIVE) {
    descriptionFixture = live.replace(/…$/, ` ${"z".repeat(60)} tail`); // a word long enough to cross the 200-char cut, as in the real text
    ({ res } = await call());
    assert.equal(res.body.listings[0].summary, live, "live-shaped summary must be byte-identical to today's output");
  }
  descriptionFixture = "<p>Nice place.</p><script>steal()</script><style>p{}</style>";
  ({ res } = await call());
  assert.equal(res.body.listings[0].summary, "Nice place.");
  descriptionFixture = PRIVATE_DESCRIPTION;
});

test("amenities from hostile upstream data stay sanitized and bounded through the route", async () => {
  amenitiesFixture = [
    ...Array.from({ length: 100 }, (_, i) => ({ amenityName: `Amenity ${i}` })),
    { amenityName: "<img src=x onerror=alert(1)>" }, { amenityName: "See http://evil.example" }, { amenityName: "y".repeat(500) }, { amenityName: { nested: true } }, null
  ];
  const { res } = await call();
  amenitiesFixture = null;
  for (const l of res.body.listings) {
    assert.equal(l.amenities.length, 60);
    assert.ok(l.amenities.every((n) => typeof n === "string" && n.length <= 40 && !/[<>]|http/i.test(n)));
  }
});

test("memory cache and non-allowlisted origin behaviour unchanged", async () => {
  const first = await call();
  const { res } = await call({ reuse: first.mod });
  assert.equal(res.headers["x-listings-cache"], "hit"); assert.equal(calls.length, 0);
  const other = await call({ reuse: first.mod, headers: { origin: "https://evil.example" } });
  assert.equal(other.res.statusCode, 200); assert.equal("access-control-allow-origin" in other.res.headers, false); assert.equal(other.res.headers["cache-control"], "no-store");
  const none = await call({ reuse: first.mod, headers: {} });
  assert.equal(none.res.headers["cache-control"], "no-store");
});

test("failure modes fail closed (unchanged)", async () => {
  let { res } = await call({ scn: "one-500" });
  assert.equal(res.statusCode, 200); assert.equal(res.body.partial, true); assert.deepEqual(res.body.listings.map((l) => l.id), [603564]); assert.equal(JSON.stringify(res.body).includes("603566"), false);
  for (const scn of ["all-500", "bad-shape", "id-mismatch", "not-json"]) {
    ({ res } = await call({ scn }));
    assert.equal(res.statusCode, 502, scn); assert.equal(res.body.error, "LISTINGS_UNAVAILABLE"); assert.equal(res.headers["cache-control"], "no-store"); assert.equal("upstream" in res.body, false);
  }
});
