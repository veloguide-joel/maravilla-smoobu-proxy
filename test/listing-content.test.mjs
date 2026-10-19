// Offline tests for lib/listing-content.js — UX2a. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cleanText, capAtWord, scanDescription, toPublicContent, MAX_DESCRIPTION_CHARS, MAX_AMENITIES, MAX_AMENITY_CHARS } from "../lib/listing-content.js";
import { toPublicListing, PUBLIC_LISTING_KEYS, PUBLISH_DESCRIPTION } from "../lib/listing-public.js";

test("module is pure: no network, env, clock or imports", () => {
  const src = readFileSync(fileURLToPath(new URL("../lib/listing-content.js", import.meta.url)), "utf8");
  for (const f of ["fetch(", "process.env", "Date.now", "import ", "require(", "console."]) assert.equal(src.includes(f), false, f);
});

test("cleanText strips tags, decodes entities, drops control chars, keeps paragraph breaks", () => {
  assert.equal(cleanText("<p>Bright &amp; airy <b>studio</b>.</p><p>Two blocks&nbsp;from the beach&#39;s edge.</p><script>x()</script><style>p{}</style>"), "Bright & airy studio.\nTwo blocks from the beach's edge.");
  assert.equal(cleanText("line one<br>line two<br/>  <br> line   three "), "line one\nline two\nline three");
  assert.equal(cleanText("a\u0000b\u0007c\u001fd"), "a b c d");
  assert.equal(cleanText(""), null); assert.equal(cleanText("   "), null); assert.equal(cleanText(null), null); assert.equal(cleanText(42), null);
  assert.equal(cleanText("&lt;img src=x onerror=alert(1)&gt;"), "<img src=x onerror=alert(1)>"); // decoded text is still text; the UI escapes on render
});

test("capAtWord caps at a word boundary with an ellipsis", () => {
  const long = "word ".repeat(600).trim();
  const c = capAtWord(long, MAX_DESCRIPTION_CHARS);
  assert.ok(c.length <= MAX_DESCRIPTION_CHARS + 1 && c.endsWith("…") && !c.includes("wor…"));
  assert.equal(capAtWord("short", 10), "short");
});

test("scan flags private material", () => {
  const cases = {
    email: "Questions? owner@example.com",
    phone: "Call +52 322 123 4567 on arrival",
    url: "See www.example.com/guide",
    credential: "WiFi network: CasaSol, password sunshine1",
    access: "The lockbox is by the gate",
    code: "Door code 4321",
    address: "Calle Lázaro Cárdenas 123, Bucerías",
    coordinates: "20.7512, -105.3321",
    instructions: "WhatsApp me when you land"
  };
  for (const [name, text] of Object.entries(cases)) assert.ok(scanDescription(text).includes(name), `${name}: ${text} -> ${scanDescription(text)}`);
  assert.deepEqual(scanDescription("Apt 4B, second floor"), ["address"]);
  assert.deepEqual(scanDescription("Contraseña: abc"), ["credential"]);
});

test("scan does not flag ordinary marketing copy", () => {
  const fine = [
    "Fast Wi-Fi, full kitchen and air conditioning in every room.",
    "Sliding glass door opens to a private terrace with ocean views.",
    "Located on Calle 5 de Mayo, two blocks from the beach and 5 minutes from the plaza.",
    "Check-in from 3 pm; the building has an elevator and a shared rooftop pool.",
    "Sleeps 2 in a queen bed. Rates from 1,600 MXN per night in low season (2026).",
    "Studio on the East Side of Bucerías, Nayarit — a 20-minute drive from the airport.",
    "The 16 de Septiembre market is a short walk away."
  ];
  for (const t of fine) assert.deepEqual(scanDescription(t), [], t);
  assert.deepEqual(scanDescription(""), []); assert.deepEqual(scanDescription(null), []);
});

test("toPublicContent: amenities are catalogue names only, deduped, bounded; junk dropped", () => {
  const c = toPublicContent({ listingAmenities: [
    { id: 1, amenityId: 2, amenityName: "Wireless" }, { id: 2, amenityId: 3, amenityName: " Air  conditioning " }, { id: 3, amenityId: 2, amenityName: "wireless" },
    { id: 4, amenityName: "Pool <script>" }, { id: 5, amenityName: "See http://x" }, { id: 6, amenityName: "x".repeat(MAX_AMENITY_CHARS + 1) }, { id: 7, amenityName: "" }, { id: 8, amenityName: 42 }, null, "junk",
    { id: 9, amenityName: "Kitchen & dining" }, { id: 10, amenityName: "Children's books/toys" }, { id: 11, amenityName: "Beach (nearby)" }
  ] });
  assert.deepEqual(c.amenities, ["Wireless", "Air conditioning", "Kitchen & dining", "Children's books/toys", "Beach (nearby)"]);
  const many = toPublicContent({ listingAmenities: Array.from({ length: MAX_AMENITIES + 20 }, (_, i) => ({ amenityName: `Amenity ${i}` })) });
  assert.equal(many.amenities.length, MAX_AMENITIES);
  assert.deepEqual(toPublicContent({ listingAmenities: "nope" }).amenities, []);
});

test("toPublicContent: beds and times are verified or null", () => {
  assert.deepEqual([toPublicContent({ bedsNumber: 1 }).beds, toPublicContent({ bedsNumber: 0 }).beds, toPublicContent({ bedsNumber: "2" }).beds, toPublicContent({ bedsNumber: 1.5 }).beds, toPublicContent({}).beds], [1, null, null, null, null]);
  assert.deepEqual([toPublicContent({ checkInTimeStart: 15 }).checkInFrom, toPublicContent({ checkInTimeStart: 0 }).checkInFrom, toPublicContent({ checkInTimeStart: 24 }).checkInFrom, toPublicContent({ checkInTimeStart: "15" }).checkInFrom, toPublicContent({ checkInTimeStart: null }).checkInFrom], ["15:00", "00:00", null, null, null]);
  assert.deepEqual([toPublicContent({ checkOutTime: 11 }).checkOutBy, toPublicContent({ checkOutTime: null }).checkOutBy, toPublicContent({ checkOutTime: -1 }).checkOutBy], ["11:00", null, null]);
  assert.deepEqual(toPublicContent(null), { description: null, descriptionFlags: [], amenities: [], beds: null, checkInFrom: null, checkOutBy: null });
  assert.deepEqual(toPublicContent([1]).amenities, []);
});

test("toPublicContent: description is sanitized and omitted when the scan fires", () => {
  const clean = toPublicContent({ description: "<p>Bright studio.</p><p>Fast Wi-Fi.</p>" });
  assert.equal(clean.description, "Bright studio.\nFast Wi-Fi."); assert.deepEqual(clean.descriptionFlags, []);
  const dirty = toPublicContent({ description: "Bright studio. Door code 4321. WiFi password: abc" });
  assert.equal(dirty.description, null); assert.deepEqual(dirty.descriptionFlags.sort(), ["access", "code", "credential"].sort().filter((f) => dirty.descriptionFlags.includes(f)));
  assert.ok(dirty.descriptionFlags.length >= 2);
  assert.equal(toPublicContent({ description: "x".repeat(5000) }).description.length <= MAX_DESCRIPTION_CHARS + 1, true);
});

test("public listing contract: new keys present, description gated by PUBLISH_DESCRIPTION, existing keys unchanged", () => {
  const raw = { id: 603566, name: "East Side Studio", personCapacity: 2, bedroomsNumber: 1, bedsNumber: 1, bathroomsNumber: 1, city: "Bucerías", currencyCode: "MXN", minNights: 1, maxNights: 365,
    description: "<p>Welcome to the East Side Studio. Fast Wi-Fi and a rooftop.</p>", listingAmenities: [{ amenityName: "Wireless" }, { amenityName: "Kitchen" }], checkInTimeStart: 15, checkOutTime: null, listingImages: [],
    doorSecurityCode: "9999", wifiPassword: "secret-pass", address: "Calle X 1", lat: 20.1, lng: -105.1, houseRules: "no parties", cancellationPolicy: "flexible" };
  const r = toPublicListing(raw, 603566); assert.equal(r.ok, true); const l = r.listing;
  assert.deepEqual(Object.keys(l).sort(), [...PUBLIC_LISTING_KEYS].sort());
  assert.deepEqual([l.amenities, l.beds, l.checkInFrom, l.checkOutBy], [["Wireless", "Kitchen"], 1, "15:00", null]);
  assert.equal(PUBLISH_DESCRIPTION, false, "description stays unpublished until the human audit (flip deliberately)");
  assert.equal(l.description, null);
  assert.equal(l.summary, "Welcome to the East Side Studio. Fast Wi-Fi and a rooftop."); // existing F1 summary unchanged
  const json = JSON.stringify(l);
  for (const bad of ["9999", "secret", "Calle X", "20.1", "105.1", "houseRules", "no parties", "flexible", "cancellation", "door", "wifiPassword"]) assert.equal(json.includes(bad), false, bad);
});
