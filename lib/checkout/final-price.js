// lib/checkout/final-price.js — Stage E3 (owner-authorized 2026-10-21).
//
// Authoritative FINAL price for a future direct-booking checkout.
//
// PURE: no I/O, no environment, no clock, no logging, no network, no database.
// Not imported by any route. The caller (a future E6/E7 server pipeline)
// supplies:
//   - the validated stay request (see validateCheckoutRequest),
//   - the result of lib/bookability.js evaluateStay() on a FRESH calendar,
//   - a FRESH Hostaway priceDetails payload,
//   - the LISTING currency (from Hostaway listing data, never from a browser),
//   - the frozen Book Direct policy built server-side (lib/direct-policy.js).
//
// Rules:
//   - The browser may only send listingId, from, to, guests. Any price, amount,
//     currency, discount or rate field is refused outright.
//   - Discount math is delegated to lib/direct-pricing.js in "checkout" mode,
//     which refuses unknown components and unresolved tax policy.
//   - This module adds checkout-only gates: bookability must be true and match
//     the request; currency must be explicitly supported; sub-centavo amounts,
//     ambiguous discounts, deleted/overridden components and out-of-range
//     totals all fail closed.
//   - No tax policy is assumed. Any tax component is refused unless the
//     policy explicitly says taxes are computed on the STANDARD base (then they
//     pass through unchanged). "discounted_base" would require recomputing tax,
//     which is not implemented and is therefore refused.
//   - The Hostaway figure is a "standard price" from the property management
//     system. It is never described as an Airbnb (or any channel's) price.

import { createHash } from "node:crypto";
import { computeDirectPricing, LOS_DISCOUNT_NAMES } from "../direct-pricing.js";
import { parseISODate, nightsBetween } from "../bookability.js";

export const FINAL_PRICE_VERSION = "final-price-v1";
export const QUOTE_BASIS = "hostaway.priceDetails";

// Currency table. Amounts are integer minor units; exponent 2 only (MXN/USD).
// minChargeMinor follows Stripe's documented minimum charge amounts; maxChargeMinor
// is Stripe's 8-digit amount limit. allowed-by-default is MXN only (owner decision D3).
export const CURRENCIES = Object.freeze({
  MXN: Object.freeze({ exponent: 2, minChargeMinor: 1000, maxChargeMinor: 99999999 }),
  USD: Object.freeze({ exponent: 2, minChargeMinor: 50, maxChargeMinor: 99999999 })
});
export const DEFAULT_ALLOWED_CURRENCIES = Object.freeze(["MXN"]);

export const REQUEST_FIELDS = Object.freeze(["listingId", "from", "to", "guests"]);
// Fields a browser must never be able to influence. Presence alone is a refusal.
export const FORBIDDEN_REQUEST_FIELDS = Object.freeze([
  "amount", "amountMinor", "price", "total", "totalPrice", "finalTotal", "finalTotalMinor", "subtotal",
  "currency", "discount", "discountMinor", "rate", "rateBps", "policy", "policyVersion", "tax", "taxes", "fees", "breakdown", "lines"
]);
export const MAX_GUESTS = 50;
export const MAX_NIGHTS = 90;

const LINE_LABELS = Object.freeze({
  baseRate: "Accommodation",
  weeklyDiscount: "Weekly discount",
  monthlyDiscount: "Monthly discount",
  lengthOfStayDiscount: "Length-of-stay discount"
});

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const included = (c) => c.isIncludedInTotalPrice === 1 || c.isIncludedInTotalPrice === true;
const truthyFlag = (v) => v === 1 || v === true;

const fail = (error, extra = {}) => Object.freeze({ ok: false, error, ...extra });

/** True when n (major units, finite) is representable in whole minor units of a 2-decimal currency. */
export function isWholeMinor(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return false;
  const scaled = n * 100;
  return Math.abs(scaled - Math.round(scaled)) < 1e-6;
}

/**
 * validateCheckoutRequest(body) -> { ok:true, request:{listingId,from,to,guests,nights} } | { ok:false, error, field? }
 * Strict allowlist. Price-like fields are refused, never ignored.
 */
export function validateCheckoutRequest(body) {
  if (!isPlainObject(body)) return fail("INVALID_REQUEST", { field: "body" });
  for (const key of Object.keys(body)) {
    if (FORBIDDEN_REQUEST_FIELDS.includes(key)) return fail("CLIENT_PRICE_FIELD_REJECTED", { field: key });
    if (!REQUEST_FIELDS.includes(key)) return fail("UNKNOWN_FIELD", { field: key });
  }
  const { listingId, from, to, guests } = body;
  let id = null;
  if (Number.isInteger(listingId) && listingId > 0) id = listingId;
  else if (typeof listingId === "string" && /^[1-9]\d{0,11}$/.test(listingId)) id = Number(listingId);
  if (id === null) return fail("INVALID_LISTING", { field: "listingId" });
  const f = parseISODate(from);
  const t = parseISODate(to);
  if (!f) return fail("INVALID_DATES", { field: "from" });
  if (!t) return fail("INVALID_DATES", { field: "to" });
  const nights = nightsBetween(f, t);
  if (!(nights >= 1)) return fail("INVALID_DATES", { field: "to", detail: "to must be after from" });
  if (nights > MAX_NIGHTS) return fail("STAY_TOO_LONG", { maxNights: MAX_NIGHTS });
  if (!Number.isInteger(guests) || guests < 1 || guests > MAX_GUESTS) return fail("INVALID_GUESTS", { field: "guests" });
  return Object.freeze({ ok: true, request: Object.freeze({ listingId: id, from: f, to: t, guests, nights }) });
}

function stayMatches(request, stay) {
  return !!stay && stay.listingId === request.listingId && stay.from === request.from && stay.to === request.to && stay.guests === request.guests;
}

function humanize(name, type) {
  if (LINE_LABELS[name]) return LINE_LABELS[name];
  if (typeof name === "string" && name) return name.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (s) => s.toUpperCase()).slice(0, 60);
  return type || "Item";
}

const KIND = Object.freeze({ accommodation: "accommodation", losDiscount: "los_discount", fee: "fee", tax: "tax" });

/** Deterministic SHA-256 over the canonical, ordered price fields. */
export function quoteHashFor(price) {
  const canonical = JSON.stringify([
    FINAL_PRICE_VERSION, price.listingId, price.from, price.to, price.guests, price.nights, price.currency,
    price.standardTotalMinor, price.eligibleMinor, price.discountMinor, price.finalTotalMinor,
    price.policyVersion, price.rateBps, price.lines.map((l) => [l.kind, l.code, l.amountMinor])
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * computeFinalPrice({ request, bookability, priceDetails, currency, policy, allowedCurrencies })
 *
 * Returns { ok:true, price } (deeply frozen) or { ok:false, error, ... }.
 * price = {
 *   version, quoteBasis, listingId, from, to, nights, guests, currency,
 *   standardTotalMinor, eligibleMinor, discountMinor, finalTotalMinor, policyVersion, rateBps,
 *   lines:[{ kind, code, label, amountMinor }],     // sums exactly to finalTotalMinor
 *   charge:{ currency (lowercase ISO), amountMinor, quantity:1, description },
 *   quoteHash
 * }
 */
export function computeFinalPrice({ request, bookability, priceDetails, currency, policy, allowedCurrencies = DEFAULT_ALLOWED_CURRENCIES } = {}) {
  // 1. request must be a validated one (re-validated here; never trusted).
  const rv = validateCheckoutRequest(request ? { listingId: request.listingId, from: request.from, to: request.to, guests: request.guests } : null);
  if (!rv.ok) return rv;
  const req = rv.request;

  // 2. currency: listing currency, explicitly allowed, known exponent.
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) return fail("INVALID_CURRENCY");
  if (!Array.isArray(allowedCurrencies) || !allowedCurrencies.includes(currency) || !CURRENCIES[currency]) return fail("UNSUPPORTED_CURRENCY", { currency });
  const cur = CURRENCIES[currency];

  // 3. bookability: a fresh evaluateStay() result for exactly this stay.
  if (!bookability || typeof bookability !== "object" || typeof bookability.bookable !== "boolean") return fail("BOOKABILITY_REQUIRED");
  if (!bookability.bookable) {
    const reasons = Array.isArray(bookability.reasons) ? bookability.reasons.map((r) => r.code) : [];
    return fail("NOT_BOOKABLE", { reasons });
  }
  if (!stayMatches(req, bookability.stay)) return fail("BOOKABILITY_MISMATCH");

  // 4. structural checks the estimate path tolerates but checkout must not.
  const comps = priceDetails && priceDetails.result && Array.isArray(priceDetails.result.components) ? priceDetails.result.components : null;
  if (!comps) return fail("PRICE_DETAILS_INVALID", { detail: "components" });
  if (!isWholeMinor(priceDetails.result.totalPrice)) return fail("SUBMINOR_AMOUNT", { detail: "totalPrice" });
  let losCount = 0;
  for (const c of comps) {
    if (!c || typeof c !== "object") return fail("PRICE_DETAILS_INVALID", { detail: "component" });
    if (!included(c)) continue;
    if (!isWholeMinor(c.total)) return fail("SUBMINOR_AMOUNT", { detail: "component" });
    if (truthyFlag(c.isDeleted)) return fail("AMBIGUOUS_COMPONENT", { detail: "deleted component included in total" });
    if (truthyFlag(c.isOverriddenByUser)) return fail("AMBIGUOUS_COMPONENT", { detail: "manually overridden component" });
    if (c.type === "discount" && LOS_DISCOUNT_NAMES.includes(typeof c.name === "string" ? c.name.trim() : "")) losCount += 1;
  }
  if (losCount > 1) return fail("AMBIGUOUS_COMPONENT", { detail: "more than one length-of-stay discount" });

  // 5. the approved discount math (checkout mode refuses unknown components / unresolved tax).
  const dp = computeDirectPricing({ priceDetails, currency, policy, mode: "checkout" });
  if (!dp.ok) return fail(dp.error === "POLICY_UNMAPPED" || dp.error === "TAX_POLICY_UNRESOLVED" ? dp.error : "PRICE_DETAILS_INVALID", dp.error === "POLICY_UNMAPPED" || dp.error === "TAX_POLICY_UNRESOLVED" ? {} : { detail: dp.error || dp.detail });
  if (dp.taxPresent && policy.taxOnDiscountedBase !== "standard_base") {
    // "discounted_base" would need tax recomputation; not implemented -> refuse.
    return fail("TAX_POLICY_UNSUPPORTED", { taxOnDiscountedBase: policy.taxOnDiscountedBase });
  }

  const accommodationMinor = dp.classified.filter((c) => c.bucket === "accommodation").reduce((s, c) => s + c.minor, 0);
  if (accommodationMinor <= 0 || dp.eligibleMinor <= 0) return fail("NO_ACCOMMODATION");

  // 6. explicit lines; must reconcile exactly with the final total.
  const lines = dp.classified.map((c) => Object.freeze({ kind: KIND[c.bucket], code: c.name || c.type, label: humanize(c.name, c.type), amountMinor: c.minor }));
  if (dp.discountMinor > 0) {
    const pct = (dp.rateBps / 100).toFixed(dp.rateBps % 100 === 0 ? 0 : 2);
    lines.push(Object.freeze({ kind: "direct_discount", code: dp.policyVersion, label: `Book Direct discount (${pct}%)`, amountMinor: -dp.discountMinor }));
  }
  const linesSum = lines.reduce((s, l) => s + l.amountMinor, 0);
  const finalTotalMinor = dp.directTotalMinor;
  if (!Number.isInteger(finalTotalMinor) || linesSum !== finalTotalMinor) return fail("INVARIANT", { detail: "lines" });

  // 7. chargeable bounds.
  if (finalTotalMinor < cur.minChargeMinor) return fail("AMOUNT_BELOW_MINIMUM", { minChargeMinor: cur.minChargeMinor });
  if (finalTotalMinor > cur.maxChargeMinor) return fail("AMOUNT_ABOVE_MAXIMUM", { maxChargeMinor: cur.maxChargeMinor });

  const price = {
    version: FINAL_PRICE_VERSION,
    quoteBasis: QUOTE_BASIS,
    listingId: req.listingId, from: req.from, to: req.to, nights: req.nights, guests: req.guests,
    currency,
    standardTotalMinor: dp.standardMinor,
    eligibleMinor: dp.eligibleMinor,
    discountMinor: dp.discountMinor,
    finalTotalMinor,
    policyVersion: dp.policyVersion,
    rateBps: dp.rateBps,
    lines: Object.freeze(lines)
  };
  price.charge = Object.freeze({
    currency: currency.toLowerCase(),
    amountMinor: finalTotalMinor,
    quantity: 1,
    description: `Stay · ${req.from} to ${req.to} · ${req.nights} night${req.nights === 1 ? "" : "s"} · ${req.guests} guest${req.guests === 1 ? "" : "s"}`
  });
  price.quoteHash = quoteHashFor(price);
  return Object.freeze({ ok: true, price: Object.freeze(price) });
}

/**
 * compareFinalPrice(stored, fresh) -> { same, changes:[field] }
 * Owner rule D4 (recommended): ANY change between confirmation and reservation is a refusal.
 */
export function compareFinalPrice(stored, fresh) {
  const fields = ["listingId", "from", "to", "guests", "currency", "standardTotalMinor", "eligibleMinor", "discountMinor", "finalTotalMinor", "policyVersion", "rateBps", "quoteHash"];
  if (!stored || !fresh) return Object.freeze({ same: false, changes: Object.freeze(["missing"]) });
  const changes = fields.filter((f) => stored[f] !== fresh[f]);
  return Object.freeze({ same: changes.length === 0, changes: Object.freeze(changes) });
}
