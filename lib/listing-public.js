// lib/listing-public.js — Stage F1 (owner-authorized 2026-10-17).
//
// Pure mapping from a raw Hostaway listing object (GET /v1/listings/{id}
// ?includeResources=1, Stage B contract) to the PUBLIC listing shape served
// to the booking UI. No I/O, no env, no mutation of the input.
//
// Whitelist by construction: only the fields named here can ever appear in
// the public payload. Address, coordinates, contacts, codes, OTA/account
// fields, fees/taxes, notes, raw objects and schema metadata are never read.
//
// No prices: the listing's base `price` is not a quote and would mislead; the
// public quote route (F3) is the only source of amounts. Currency is exposed
// so the UI can label amounts correctly when they arrive.

import { toPublicContent, scanDescription } from "./listing-content.js";

export const PUBLIC_LISTING_IDS = Object.freeze([603564, 603566]);

// UX2a: the full description is published ONLY after a human has audited the live text
// (authenticated diagnostic /api/hostaway/listing shows the exact candidate and scan verdict).
// Until then it is omitted (null) regardless of the automated scan. Flip deliberately, per decision log.
export const PUBLISH_DESCRIPTION = false;

export const MAX_PUBLIC_IMAGES = 12;
export const SUMMARY_CHARS = 200;

const isPosInt = (v) => Number.isInteger(v) && v > 0;
const nonNegInt = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
const cleanText = (v, max) => {
  if (typeof v !== "string") return null;
  const t = v.replace(/<\s*(script|style)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, " ") // UX2a follow-up: drop script/style bodies, not just the tags
    .replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim(); // strip tags, collapse whitespace
  if (!t) return null;
  return max && t.length > max ? t.slice(0, max) : t;
};

/** Only absolute https URLs pass; anything else is dropped (never guessed). */
export function safeImageUrl(v) {
  if (typeof v !== "string" || v.length > 2048) return null;
  try {
    const u = new URL(v);
    if (u.protocol !== "https:" || !u.hostname) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** Cut at a word boundary and add an ellipsis when truncated. */
export function summarize(text, max = SUMMARY_CHARS) {
  const t = cleanText(text);
  if (!t) return null;
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const atWord = cut.lastIndexOf(" ") > max * 0.6 ? cut.slice(0, cut.lastIndexOf(" ")) : cut;
  return `${atWord.replace(/[\s,;:.–-]+$/, "")}…`;
}

/**
 * toPublicListing(raw, expectedId) -> { ok:true, listing } | { ok:false, error }
 * Fails (never guesses) when the object is missing, is for another id, or
 * lacks a usable name or capacity.
 */
export function toPublicListing(raw, expectedId) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "NOT_AN_OBJECT" };
  const id = Number(raw.id);
  if (!isPosInt(id)) return { ok: false, error: "MISSING_ID" };
  if (expectedId != null && id !== Number(expectedId)) return { ok: false, error: "ID_MISMATCH" };

  const name = cleanText(raw.externalListingName, 140) || cleanText(raw.name, 140);
  if (!name) return { ok: false, error: "MISSING_NAME" };

  const sleeps = isPosInt(raw.personCapacity) ? raw.personCapacity : null;
  if (sleeps === null) return { ok: false, error: "MISSING_CAPACITY" };

  const bedrooms = nonNegInt(raw.bedroomsNumber);
  // Hostaway may report half baths (1.5). Only an actual number counts; null/""/undefined stay null.
  const bathrooms = typeof raw.bathroomsNumber === "number" && Number.isFinite(raw.bathroomsNumber) && raw.bathroomsNumber >= 0 ? raw.bathroomsNumber : null;
  const city = cleanText(raw.city, 80);

  // Images: ordered by sortOrder, https only, bounded. Caption only if a short string.
  const rawImages = Array.isArray(raw.listingImages) ? raw.listingImages : [];
  const images = rawImages
    .filter((i) => i && typeof i === "object")
    .map((i) => ({ url: safeImageUrl(i.url), caption: cleanText(i.caption, 120), sortOrder: Number.isFinite(Number(i.sortOrder)) ? Number(i.sortOrder) : Number.MAX_SAFE_INTEGER }))
    .filter((i) => i.url)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .slice(0, MAX_PUBLIC_IMAGES)
    .map(({ url, caption }) => (caption ? { url, caption } : { url }));
  const img = images[0]?.url ?? safeImageUrl(raw.thumbnailUrl) ?? null;

  const taglineParts = [];
  if (bedrooms !== null) taglineParts.push(bedrooms === 0 ? "Studio" : `${bedrooms} BR`);
  if (bathrooms !== null) taglineParts.push(`${bathrooms} Bath`);
  if (city) taglineParts.push(city);
  const tagline = taglineParts.length ? taglineParts.join(" • ") : null;

  const currency = typeof raw.currencyCode === "string" && /^[A-Z]{3}$/.test(raw.currencyCode) ? raw.currencyCode : null;
  const content = toPublicContent(raw); // UX2a property-page content (sanitized, scanned)

  return {
    ok: true,
    listing: {
      id,
      source: "hostaway",
      slug: `hostaway-${id}`,
      name,
      sleeps,
      bedrooms,
      bathrooms,
      city,
      tagline,
      // UX2a follow-up: the summary is an excerpt of the same unreviewed description, so it gets the same
      // private-content scan on exactly the text that would be published; any hit -> null (fail closed).
      summary: (() => { const s = summarize(raw.description); return s && scanDescription(s).length ? null : s; })(),
      img,
      images,
      currency,
      minNights: isPosInt(raw.minNights) ? raw.minNights : null,
      maxNights: isPosInt(raw.maxNights) ? raw.maxNights : null,
      // UX2a additions (existing keys above unchanged)
      description: PUBLISH_DESCRIPTION ? content.description : null,
      amenities: content.amenities,
      beds: content.beds,
      checkInFrom: content.checkInFrom,
      checkOutBy: content.checkOutBy
    }
  };
}

/** Keys that may appear on a public listing; used by tests and as a final guard in the route. */
export const PUBLIC_LISTING_KEYS = Object.freeze([
  "id", "source", "slug", "name", "sleeps", "bedrooms", "bathrooms", "city", "tagline",
  "summary", "img", "images", "currency", "minNights", "maxNights",
  "description", "amenities", "beds", "checkInFrom", "checkOutBy" // UX2a
]);
