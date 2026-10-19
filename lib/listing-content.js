// lib/listing-content.js — UX2a: public property-page content derived from a raw
// Hostaway listing. Pure: no I/O, no env, never mutates the input.
//
// Fields produced (all optional; null/[] when absent or unusable, never guessed):
//   description   full public description: tags stripped, entities decoded, whitespace
//                 collapsed, capped at MAX_DESCRIPTION_CHARS at a word boundary — and ONLY
//                 when scanDescription() finds nothing that looks like private material
//   amenities     Hostaway canonical amenity names (listingAmenities[].amenityName), deduped,
//                 plain text only, each ≤ MAX_AMENITY_CHARS, at most MAX_AMENITIES
//   beds          bedsNumber when a positive integer
//   checkInFrom   "HH:00" from checkInTimeStart (integer hour 0–23)
//   checkOutBy    "HH:00" from checkOutTime (integer hour 0–23) — null today for both pilots
//
// Not produced on purpose: houseRules (none upstream; would need its own audit), cancellation
// policy (channel policy, not maraVilla's — deferred), bed types (empty upstream), anything
// about access, contacts, address or coordinates (never read).

export const MAX_DESCRIPTION_CHARS = 2000;
export const MAX_AMENITIES = 60;
export const MAX_AMENITY_CHARS = 40;

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };
function decodeEntities(t) {
  return t.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k in ENTITIES) return ENTITIES[k];
    if (k.startsWith("#x")) { const c = parseInt(k.slice(2), 16); return c > 31 && c < 0x110000 ? String.fromCodePoint(c) : " "; }
    if (k.startsWith("#")) { const c = parseInt(k.slice(1), 10); return c > 31 && c < 0x110000 ? String.fromCodePoint(c) : " "; }
    return " ";
  });
}
/** Strip tags, decode entities, drop control characters, collapse whitespace (paragraph breaks kept as "\n"). */
export function cleanText(v) {
  if (typeof v !== "string") return null;
  let t = v.replace(/<\s*(script|style)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, " ")   // executable/style blocks removed with their content
    .replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6])\b[^>]*>/gi, "\n")                   // block boundaries become paragraph breaks
    .replace(/<[^>]*>/g, "");                                                            // inline tags vanish without adding spaces
  t = decodeEntities(t);
  t = t.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ");
  t = t.split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
  return t || null;
}
export function capAtWord(t, max) {
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const at = cut.lastIndexOf(" ");
  return `${(at > max * 0.6 ? cut.slice(0, at) : cut).replace(/[\s,;:.–-]+$/, "")}…`;
}

// --- private-content scan: anything matching keeps the description OUT of the public feed ---
const SCAN_RULES = [
  ["email", /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i],
  ["phone", /(?:\+?\d[\d\s().-]{8,}\d)/],                                   // 10+ digit groups incl. +52 / (322) forms
  ["url", /\b(?:https?:\/\/|www\.)\S+/i],
  ["credential", /\b(password|passcode|passwd|pwd|contrase[nñ]a)\b|\b(wi-?fi|wlan|ssid|network)\b[^\n]{0,30}\b(name|pass|key|code|clave)\b|\bpin\b\s*[:#]?\s*\d/i],
  ["access", /\b(lock ?box|keypad|key ?code|access code|door code|gate code|safe code|c[oó]digo de (acceso|entrada|puerta)|combination)\b/i],
  ["code", /\b(code|c[oó]digo)\b[^\n]{0,20}\b\d{3,8}\b/i],
  ["address", /\b(calle|avenida|av\.|carretera|privada|blvd\.?|boulevard|street|unit|apt\.?|apartment|#)\s*[^\n]{0,30}?\b\d{1,5}[a-z]?\b(?!\s+de\s)/i], // house numbers (4, 12B); "5 de Mayo"-style street names are not numbers
  ["coordinates", /\b-?\d{1,2}\.\d{4,},?\s*-?\d{1,3}\.\d{4,}\b/],
  ["instructions", /\b(check-?in instructions|directions:|whatsapp|call (me|us)|text (me|us)|message (me|us) (at|on))\b/i]
];
/** Returns the names of every rule that fired (empty array = nothing private detected). */
export function scanDescription(text) {
  if (typeof text !== "string" || !text) return [];
  return SCAN_RULES.filter(([, re]) => re.test(text)).map(([name]) => name);
}

const hour = (v) => (Number.isInteger(v) && v >= 0 && v <= 23 ? `${String(v).padStart(2, "0")}:00` : null);
const PLAIN = /^[\p{L}\p{N}\s'’().,&+/-]+$/u; // amenity labels are catalogue words; anything else is dropped

/** Public content for one raw listing. `description` is null when the scan fires (the flags are returned for diagnostics). */
export function toPublicContent(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { description: null, descriptionFlags: [], amenities: [], beds: null, checkInFrom: null, checkOutBy: null };
  const cleaned = cleanText(raw.description);
  const descriptionFlags = scanDescription(cleaned);
  const description = cleaned && !descriptionFlags.length ? capAtWord(cleaned, MAX_DESCRIPTION_CHARS) : null;
  const seen = new Set();
  const amenities = (Array.isArray(raw.listingAmenities) ? raw.listingAmenities : [])
    .map((a) => (a && typeof a === "object" && typeof a.amenityName === "string" ? a.amenityName.replace(/\s+/g, " ").trim() : null))
    .filter((n) => n && n.length <= MAX_AMENITY_CHARS && PLAIN.test(n) && !/<|>|http/i.test(n))
    .filter((n) => { const k = n.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, MAX_AMENITIES);
  const beds = Number.isInteger(raw.bedsNumber) && raw.bedsNumber > 0 ? raw.bedsNumber : null;
  return { description, descriptionFlags, amenities, beds, checkInFrom: hour(raw.checkInTimeStart), checkOutBy: hour(raw.checkOutTime) };
}
