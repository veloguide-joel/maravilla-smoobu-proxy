// lib/quote-public.js — Stage F3 (owner-authorized 2026-10-17).
//
// Pure helpers for the public quote route. No I/O, no env, no clock.
//
//  - validatePriceDetails(): turns a raw Hostaway priceDetails payload (Stage D
//    contract) into a sanitized breakdown, or refuses it. Every amount must be
//    a finite number; the authoritative totalPrice must be >= 0; included
//    component totals must add up to totalPrice (never adjusted — a mismatch
//    is a refusal); non-discount components must be >= 0 and discounts <= 0.
//  - publicReasons(): whitelists the detail fields of F0 reasons so nothing
//    about upstream data structure reaches the browser.
//  - decisionFor(): "unavailable" (a rule failed) vs "unconfirmed" (the
//    calendar could not be trusted) so the UI can word it correctly.
//
// Currency is deliberately NOT read from the pricing payload (it has none):
// the route passes the listing's currencyCode and the breakdown is labelled
// with it. No conversion, ever.

export const QUOTE_NOTE = "Quote only. Prices are calculated by the property management system; no inventory is held until a reservation is confirmed.";

const COMPONENT_LABELS = Object.freeze({
  baseRate: "Accommodation",
  weeklyDiscount: "Weekly discount",
  monthlyDiscount: "Monthly discount",
  cleaningFee: "Cleaning fee",
  lengthOfStayDiscount: "Length-of-stay discount"
});

const isFiniteNum = (v) => typeof v === "number" && Number.isFinite(v);
const round2 = (n) => Math.round(n * 100) / 100;
const included = (c) => c.isIncludedInTotalPrice === 1 || c.isIncludedInTotalPrice === true;

function labelFor(c) {
  if (typeof c.name === "string" && COMPONENT_LABELS[c.name]) return COMPONENT_LABELS[c.name];
  if (typeof c.title === "string" && c.title.trim()) return c.title.trim().slice(0, 60);
  if (typeof c.name === "string" && c.name.trim()) {
    // camelCase -> words
    return c.name.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (s) => s.toUpperCase()).slice(0, 60);
  }
  return typeof c.type === "string" ? c.type : "Item";
}

/**
 * validatePriceDetails(json) ->
 *   { ok:true, total, breakdown:[{type,label,total}], componentCount, excludedCount }
 *   | { ok:false, error }
 */
export function validatePriceDetails(json) {
  if (!json || typeof json !== "object") return { ok: false, error: "NOT_AN_OBJECT" };
  if (json.status !== "success") return { ok: false, error: "UPSTREAM_REJECTED" };
  const result = json.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) return { ok: false, error: "UNEXPECTED_SHAPE" };
  if (!Array.isArray(result.components) || result.components.length === 0) return { ok: false, error: "NO_COMPONENTS" };

  const total = result.totalPrice;
  if (!isFiniteNum(total) || total < 0) return { ok: false, error: "INVALID_TOTAL" };

  const breakdown = [];
  let sumIncluded = 0;
  let excludedCount = 0;
  for (const c of result.components) {
    if (!c || typeof c !== "object") return { ok: false, error: "INVALID_COMPONENT" };
    if (!isFiniteNum(c.total)) return { ok: false, error: "INVALID_COMPONENT_TOTAL" };
    const type = typeof c.type === "string" ? c.type : "unknown";
    if (type === "discount" ? c.total > 0 : c.total < 0) return { ok: false, error: "INVALID_COMPONENT_SIGN" };
    if (!included(c)) { excludedCount += 1; continue; } // optional extras are not part of the quoted total
    sumIncluded += c.total;
    breakdown.push({ type, label: labelFor(c), total: round2(c.total) });
  }
  if (breakdown.length === 0) return { ok: false, error: "NO_INCLUDED_COMPONENTS" };
  if (Math.abs(round2(sumIncluded) - round2(total)) > 0.005) return { ok: false, error: "SUM_MISMATCH" };

  return { ok: true, total: round2(total), breakdown, componentCount: result.components.length, excludedCount };
}

// Detail fields an F0 reason may carry to the browser. Everything else is dropped.
const PUBLIC_REASON_DETAIL = Object.freeze(["maxGuests", "required", "allowed", "earliestArrival", "firstUnavailableNight", "unavailableCount", "date", "maxNights"]);
const CALENDAR_TRUST_CODES = new Set(["CALENDAR_STALE", "CALENDAR_INCONSISTENT", "CALENDAR_INCOMPLETE", "LISTING_DATA_INCOMPLETE", "INVALID_INPUT"]);

export function publicReasons(reasons) {
  if (!Array.isArray(reasons)) return [];
  return reasons.map((r) => {
    const out = { code: String(r.code), message: typeof r.message === "string" ? r.message : "" };
    for (const k of PUBLIC_REASON_DETAIL) if (r[k] !== undefined) out[k] = r[k];
    return out;
  });
}

/** "unconfirmed" when any reason means "we could not trust the data"; otherwise "unavailable". */
export function decisionFor(reasons) {
  return Array.isArray(reasons) && reasons.some((r) => CALENDAR_TRUST_CODES.has(r.code)) ? "unconfirmed" : "unavailable";
}

export const PUBLIC_QUOTE_KEYS = Object.freeze([
  "ok", "available", "decision", "listingId", "from", "to", "nights", "guests", "currency",
  "total", "nightlyAverage", "breakdown", "reasons", "checkedAt", "quoteBasis", "note"
]);
