// Offline tests for lib/listing-public.js — Stage F1. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { toPublicListing, safeImageUrl, summarize, PUBLIC_LISTING_IDS, PUBLIC_LISTING_KEYS, MAX_PUBLIC_IMAGES } from "../lib/listing-public.js";

// A raw Hostaway listing in the Stage B shape, deliberately salted with the
// kinds of private fields the real object carries (145 top-level keys).
function rawListing(over = {}) {
  return {
    id: 603564,
    name: "Hacienda 5 De Mayo with Ocean and Town Views",
    internalListingName: "Hacienda 5 De Mayo with Ocean and Town Views",
    externalListingName: "Hacienda 5 De Mayo with Ocean and Town Views",
    personCapacity: 2, guestsIncluded: 1, bedroomsNumber: 1, bedsNumber: 1, bathroomsNumber: 1,
    city: "Bucerías", state: "Nayarit", country: "Mexico", countryCode: "MX",
    minNights: 1, maxNights: 365, currencyCode: "MXN", price: 2200,
    description: "Bright one-bedroom hacienda a few blocks from the beach. Ocean and town views from the rooftop, fast Wi-Fi, full kitchen, air conditioning in the bedroom, and a quiet courtyard. Walk to restaurants, the market and the malecón in minutes.",
    listingImages: [
      { id: 2, url: "https://hostaway-platform.s3.us-west-2.amazonaws.com/listing/b.jpg", caption: "", sortOrder: 2, airbnbCaption: "" },
      { id: 1, url: "https://a0.muscache.com/im/pictures/a.jpg?aki_policy=large", caption: "Rooftop", sortOrder: 1 },
      { id: 3, url: "http://insecure.example.com/c.jpg", caption: "insecure", sortOrder: 3 },
      { id: 4, url: "javascript:alert(1)", sortOrder: 4 },
      { id: 5, url: "/relative.jpg", sortOrder: 5 },
      null, "junk"
    ],
    thumbnailUrl: "https://a0.muscache.com/im/pictures/thumb.jpg",
    // --- private / forbidden material that must never leak ---
    address: "Calle 5 de Mayo 12, Bucerías", street: "Calle 5 de Mayo 12", zipcode: "63732", lat: 20.75, lng: -105.33,
    contactName: "Owner Name", contactEmail: "owner@example.com", contactPhone1: "+52 1 322 000 0000",
    doorSecurityCode: "4321", wifiUsername: "casa-wifi", wifiPassword: "secret-pass",
    airbnbListingUrl: "https://airbnb.com/rooms/1", bookingcomPropertyRoomName: "x", vrboPropertyId: "y",
    cleaningFee: 0, guestNightlyTax: 0, propertyLicenseNumber: "LIC-1", invoicingContactEmail: "inv@example.com",
    listingAmenities: [{ id: 1, amenityId: 2, amenityName: "Wireless" }],
    ...over
  };
}
// Substrings that must not appear anywhere in the public JSON (keys or values).
const FORBIDDEN = ["address", "street", "zipcode", "63732", "\"lat\"", "\"lng\"", "20.75", "105.33", "contact", "owner@", "+52", "door", "4321", "wifi", "secret-pass",
  "airbnb.com", "bookingcom", "vrbo", "cleaningFee", "Tax", "License", "LIC-1", "invoic", "price", "2200", "internalListingName", "_schema", "_meta"];

test("module is pure: no network, env, clock or imports", () => {
  const src = readFileSync(fileURLToPath(new URL("../lib/listing-public.js", import.meta.url)), "utf8");
  for (const f of ["fetch(", "process.env", "Date.now", "require("]) assert.equal(src.includes(f), false, f);
  // UX2a: the only import allowed is the pure content module (checked for purity in listing-content.test.mjs)
  const imports = [...src.matchAll(/^import .* from "([^"]+)";/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ["./listing-content.js"]);
});

test("pilot allowlist is exactly the two owner-approved ids", () => {
  assert.deepEqual([...PUBLIC_LISTING_IDS], [603564, 603566]);
  assert.ok(Object.isFrozen(PUBLIC_LISTING_IDS));
});

test("maps a real-shaped listing to the public contract and nothing else", () => {
  const r = toPublicListing(rawListing(), 603564);
  assert.equal(r.ok, true);
  const l = r.listing;
  assert.deepEqual(Object.keys(l).sort(), [...PUBLIC_LISTING_KEYS].sort());
  assert.equal(l.id, 603564);
  assert.equal(l.source, "hostaway");
  assert.equal(l.slug, "hostaway-603564");
  assert.equal(l.name, "Hacienda 5 De Mayo with Ocean and Town Views");
  assert.equal(l.sleeps, 2);
  assert.equal(l.bedrooms, 1);
  assert.equal(l.bathrooms, 1);
  assert.equal(l.city, "Bucerías");
  assert.equal(l.tagline, "1 BR • 1 Bath • Bucerías");
  assert.equal(l.currency, "MXN");
  assert.equal(l.minNights, 1);
  assert.equal(l.maxNights, 365);
  assert.equal(l.summary.length <= 201, true);
  assert.ok(l.summary.endsWith("…"));
  // images: https only, ordered by sortOrder, caption only when present
  assert.deepEqual(l.images, [
    { url: "https://a0.muscache.com/im/pictures/a.jpg?aki_policy=large", caption: "Rooftop" },
    { url: "https://hostaway-platform.s3.us-west-2.amazonaws.com/listing/b.jpg" }
  ]);
  assert.equal(l.img, "https://a0.muscache.com/im/pictures/a.jpg?aki_policy=large");
  const text = JSON.stringify(l);
  for (const f of FORBIDDEN) assert.equal(text.includes(f), false, `leaked "${f}"`);
  assert.equal("price" in l, false);
});

test("second pilot (603566) maps with its own values", () => {
  const r = toPublicListing(rawListing({ id: 603566, externalListingName: "East Side Studio with Rooftop Access & Ocean Views", bedroomsNumber: 0, listingImages: [{ url: "https://hostaway-platform.s3.us-west-2.amazonaws.com/listing/s.jpg", sortOrder: 1 }] }), 603566);
  assert.equal(r.ok, true);
  assert.equal(r.listing.slug, "hostaway-603566");
  assert.equal(r.listing.tagline, "Studio • 1 Bath • Bucerías");
  assert.equal(r.listing.images.length, 1);
});

test("falls back to name when externalListingName is empty; strips HTML and whitespace", () => {
  const r = toPublicListing(rawListing({ externalListingName: "  ", name: "<b>Casa</b>   Azul\n" }), 603564);
  assert.equal(r.listing.name, "Casa Azul");
});

test("missing images: img falls back to thumbnailUrl, then null; images is []", () => {
  const a = toPublicListing(rawListing({ listingImages: [] }), 603564).listing;
  assert.deepEqual(a.images, []);
  assert.equal(a.img, "https://a0.muscache.com/im/pictures/thumb.jpg");
  const b = toPublicListing(rawListing({ listingImages: undefined, thumbnailUrl: "ftp://x/y.jpg" }), 603564).listing;
  assert.deepEqual(b.images, []);
  assert.equal(b.img, null);
});

test("image list is bounded to MAX_PUBLIC_IMAGES", () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ url: `https://img.example/${i}.jpg`, sortOrder: i }));
  assert.equal(toPublicListing(rawListing({ listingImages: many }), 603564).listing.images.length, MAX_PUBLIC_IMAGES);
});

test("safeImageUrl accepts only absolute https", () => {
  assert.equal(safeImageUrl("https://a.b/c.jpg"), "https://a.b/c.jpg");
  for (const bad of ["http://a.b/c.jpg", "javascript:alert(1)", "/x.jpg", "data:image/png;base64,AAA", "", null, 42, "https://" + "a".repeat(2100)]) assert.equal(safeImageUrl(bad), null, String(bad).slice(0, 30));
});

test("incomplete fields are null, never invented", () => {
  const l = toPublicListing(rawListing({ bedroomsNumber: undefined, bathroomsNumber: null, city: "", description: null, currencyCode: "mxn", minNights: 0, maxNights: "365" }), 603564).listing;
  assert.equal(l.bedrooms, null);
  assert.equal(l.bathrooms, null);
  assert.equal(l.city, null);
  assert.equal(l.tagline, null);
  assert.equal(l.summary, null);
  assert.equal(l.currency, null); // lowercase/invalid code is not guessed
  assert.equal(l.minNights, null);
  assert.equal(l.maxNights, null);
});

test("fails closed on missing object, wrong id, missing name or capacity", () => {
  assert.deepEqual(toPublicListing(null, 603564), { ok: false, error: "NOT_AN_OBJECT" });
  assert.deepEqual(toPublicListing([], 603564), { ok: false, error: "NOT_AN_OBJECT" });
  assert.deepEqual(toPublicListing({ name: "x" }, 603564), { ok: false, error: "MISSING_ID" });
  assert.deepEqual(toPublicListing(rawListing({ id: 603566 }), 603564), { ok: false, error: "ID_MISMATCH" });
  assert.deepEqual(toPublicListing(rawListing({ name: "", externalListingName: null }), 603564), { ok: false, error: "MISSING_NAME" });
  assert.deepEqual(toPublicListing(rawListing({ personCapacity: 0 }), 603564), { ok: false, error: "MISSING_CAPACITY" });
});

test("summarize cuts at a word boundary with an ellipsis; short text untouched", () => {
  assert.equal(summarize("Short text."), "Short text.");
  const s = summarize("word ".repeat(100), 50);
  assert.ok(s.length <= 51 && s.endsWith("…") && !s.includes("  "));
  assert.equal(summarize("<p>Hello <i>there</i></p>"), "Hello there");
});

test("input is not mutated", () => {
  const raw = rawListing();
  const before = JSON.stringify(raw);
  toPublicListing(raw, 603564);
  assert.equal(JSON.stringify(raw), before);
});
