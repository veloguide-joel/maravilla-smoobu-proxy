// Offline tests for lib/checkout/final-price.js — Stage E3. Run: npm test
// No network, credentials, Stripe, Hostaway writes or database.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateCheckoutRequest, computeFinalPrice, compareFinalPrice, quoteHashFor, isWholeMinor,
  FORBIDDEN_REQUEST_FIELDS, CURRENCIES
} from "../lib/checkout/final-price.js";
import { evaluateStay, addDays } from "../lib/bookability.js";
import { DEFAULT_DIRECT_POLICY } from "../lib/direct-pricing.js";

// ---------- fixtures (shapes from live Stage D/F3 payloads, MXN pilots) ----------
const comp = (over = {}) => ({ id: 1, type: "accommodation", name: "baseRate", title: "Base rate", quantity: 1, value: 1600, total: 6400,
  isIncludedInTotalPrice: 1, isMandatory: 1, isOverriddenByUser: 0, isDeleted: 0, units: 4, ...over });
const payload = (components, totalPrice) => ({ status: "success", result: { totalPrice, originalTotalPrice: 0, components } });
const P = DEFAULT_DIRECT_POLICY; // direct-v1, 1000 bps, taxOnDiscountedBase "unresolved"

const TODAY = "2026-10-21";
const NOW = Date.UTC(2026, 9, 21, 15, 0, 0);
const LISTING = { id: 603566, personCapacity: 2, minNights: 1, maxNights: 90 };
function days(from, to, over = {}) { // covers from..to inclusive
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push({ date: d, status: "available", isAvailable: 1, minimumStay: 1, maximumStay: 90, closedOnArrival: 0, closedOnDeparture: 0, ...(over[d] || {}) });
  return out;
}
const REQ = Object.freeze({ listingId: 603566, from: "2026-12-20", to: "2026-12-24", guests: 2 });
const bookability = (req = REQ, over = {}) => evaluateStay({ listingId: req.listingId, listing: LISTING, days: days(req.from, req.to, over.days), from: req.from, to: req.to,
  guests: req.guests, today: TODAY, now: NOW, calendarFetchedAt: over.fetchedAt ?? NOW - 1000 });
const PD_4N = payload([comp()], 6400);
const run = (over = {}) => computeFinalPrice({ request: REQ, bookability: bookability(), priceDetails: PD_4N, currency: "MXN", policy: P, ...over });

// ---------- request validation (browser input) ----------
test("valid request is normalised", () => {
  const r = validateCheckoutRequest({ listingId: "603566", from: "2026-12-20", to: "2026-12-24", guests: 2 });
  assert.equal(r.ok, true);
  assert.deepEqual({ ...r.request }, { listingId: 603566, from: "2026-12-20", to: "2026-12-24", guests: 2, nights: 4 });
});

test("browser-submitted price fields are refused, never ignored", () => {
  for (const f of FORBIDDEN_REQUEST_FIELDS) {
    const r = validateCheckoutRequest({ ...REQ, [f]: 1 });
    assert.equal(r.ok, false, f);
    assert.equal(r.error, "CLIENT_PRICE_FIELD_REJECTED", f);
    assert.equal(r.field, f);
  }
});

test("unknown fields and malformed input are refused", () => {
  assert.equal(validateCheckoutRequest({ ...REQ, coupon: "X" }).error, "UNKNOWN_FIELD");
  assert.equal(validateCheckoutRequest(null).error, "INVALID_REQUEST");
  assert.equal(validateCheckoutRequest([REQ]).error, "INVALID_REQUEST");
  assert.equal(validateCheckoutRequest({ ...REQ, listingId: 0 }).error, "INVALID_LISTING");
  assert.equal(validateCheckoutRequest({ ...REQ, listingId: "06" }).error, "INVALID_LISTING");
  assert.equal(validateCheckoutRequest({ ...REQ, listingId: 1.5 }).error, "INVALID_LISTING");
});

test("invalid dates are refused", () => {
  assert.equal(validateCheckoutRequest({ ...REQ, from: "2026-02-30" }).error, "INVALID_DATES");
  assert.equal(validateCheckoutRequest({ ...REQ, to: "2026-12-20" }).error, "INVALID_DATES"); // zero nights
  assert.equal(validateCheckoutRequest({ ...REQ, to: "2026-12-19" }).error, "INVALID_DATES"); // reversed
  assert.equal(validateCheckoutRequest({ ...REQ, from: "20/12/2026" }).error, "INVALID_DATES");
  assert.equal(validateCheckoutRequest({ ...REQ, from: "2026-11-01", to: "2027-01-31" }).error, "STAY_TOO_LONG");
});

test("invalid guest counts are refused", () => {
  for (const g of [0, -1, 1.5, "2", null, 51]) assert.equal(validateCheckoutRequest({ ...REQ, guests: g }).error, "INVALID_GUESTS", String(g));
});

// ---------- authoritative price ----------
test("4-night pilot quote: 6,400 → 5,760 MXN with an explicit breakdown", () => {
  const r = run();
  assert.equal(r.ok, true, JSON.stringify(r));
  const p = r.price;
  assert.deepEqual([p.standardTotalMinor, p.eligibleMinor, p.discountMinor, p.finalTotalMinor], [640000, 640000, 64000, 576000]);
  assert.equal(p.currency, "MXN");
  assert.equal(p.policyVersion, "direct-v1");
  assert.equal(p.rateBps, 1000);
  assert.deepEqual(p.lines.map((l) => [l.kind, l.label, l.amountMinor]), [
    ["accommodation", "Accommodation", 640000],
    ["direct_discount", "Book Direct discount (10%)", -64000]
  ]);
  assert.equal(p.lines.reduce((s, l) => s + l.amountMinor, 0), p.finalTotalMinor);
  assert.deepEqual({ ...p.charge }, { currency: "mxn", amountMinor: 576000, quantity: 1, description: "Stay · 2026-12-20 to 2026-12-24 · 4 nights · 2 guests" });
  assert.match(p.quoteHash, /^[0-9a-f]{64}$/);
  assert.ok(Object.isFrozen(p) && Object.isFrozen(p.lines) && Object.isFrozen(p.lines[0]));
});

test("weekly and monthly length-of-stay discounts stack before the 10 %", () => {
  const weeklyReq = { listingId: 603566, from: "2026-12-01", to: "2026-12-08", guests: 2 };
  const pd = payload([comp({ total: 11200, units: 7 }), comp({ id: 2, type: "discount", name: "weeklyDiscount", total: -1120 })], 10080);
  const r = computeFinalPrice({ request: weeklyReq, bookability: bookability(weeklyReq), priceDetails: pd, currency: "MXN", policy: P });
  assert.equal(r.ok, true);
  assert.deepEqual([r.price.standardTotalMinor, r.price.discountMinor, r.price.finalTotalMinor], [1008000, 100800, 907200]);
  assert.deepEqual(r.price.lines.map((l) => l.kind), ["accommodation", "los_discount", "direct_discount"]);
});

test("fees pass through undiscounted and appear as their own line", () => {
  const pd = payload([comp(), comp({ id: 3, type: "fee", name: "cleaningFee", total: 500 })], 6900);
  const r = run({ priceDetails: pd });
  assert.equal(r.ok, true);
  assert.deepEqual([r.price.standardTotalMinor, r.price.eligibleMinor, r.price.discountMinor, r.price.finalTotalMinor], [690000, 640000, 64000, 626000]);
  assert.deepEqual(r.price.lines.find((l) => l.kind === "fee"), { kind: "fee", code: "cleaningFee", label: "Cleaning Fee", amountMinor: 50000 });
});

test("optional (not included) components are not charged", () => {
  const pd = payload([comp(), comp({ id: 4, type: "fee", name: "petFee", total: 300, isIncludedInTotalPrice: 0 })], 6400);
  const r = run({ priceDetails: pd });
  assert.equal(r.ok, true);
  assert.equal(r.price.finalTotalMinor, 576000);
  assert.ok(!r.price.lines.some((l) => l.code === "petFee"));
});

test("never labelled or described as an Airbnb or channel price", () => {
  const s = JSON.stringify(run().price).toLowerCase();
  for (const w of ["airbnb", "vrbo", "booking.com"]) assert.ok(!s.includes(w), w);
});

// ---------- taxes: no policy is assumed ----------
test("tax component with unresolved policy: refused", () => {
  const pd = payload([comp(), comp({ id: 5, type: "tax", name: "lodgingTax", total: 192 })], 6592);
  assert.equal(run({ priceDetails: pd }).error, "TAX_POLICY_UNRESOLVED");
});

test("tax on discounted base: refused (recalculation not implemented)", () => {
  const pd = payload([comp(), comp({ id: 5, type: "tax", name: "lodgingTax", total: 192 })], 6592);
  const r = run({ priceDetails: pd, policy: { ...P, taxOnDiscountedBase: "discounted_base" } });
  assert.equal(r.error, "TAX_POLICY_UNSUPPORTED");
});

test("tax on standard base (explicit owner policy): passes through unchanged", () => {
  const pd = payload([comp(), comp({ id: 5, type: "tax", name: "lodgingTax", total: 192 })], 6592);
  const r = run({ priceDetails: pd, policy: { ...P, taxOnDiscountedBase: "standard_base" } });
  assert.equal(r.ok, true);
  assert.equal(r.price.finalTotalMinor, 659200 - 64000);
  assert.ok(r.price.lines.some((l) => l.kind === "tax" && l.amountMinor === 19200));
});

test("ambiguous or unmapped components fail closed", () => {
  assert.equal(run({ priceDetails: payload([comp(), comp({ id: 6, type: "discount", name: "coupon", total: -100 })], 6300) }).error, "POLICY_UNMAPPED");
  assert.equal(run({ priceDetails: payload([comp(), comp({ id: 7, type: "mystery", name: "x", total: 10 })], 6410) }).error, "POLICY_UNMAPPED");
  assert.equal(run({ priceDetails: payload([comp({ isDeleted: 1 })], 6400) }).error, "AMBIGUOUS_COMPONENT");
  assert.equal(run({ priceDetails: payload([comp({ isOverriddenByUser: 1 })], 6400) }).error, "AMBIGUOUS_COMPONENT");
  const twoLos = payload([comp({ total: 11200 }), comp({ id: 2, type: "discount", name: "weeklyDiscount", total: -1120 }), comp({ id: 3, type: "discount", name: "monthlyDiscount", total: -100 })], 9980);
  assert.equal(run({ priceDetails: twoLos }).error, "AMBIGUOUS_COMPONENT");
});

test("missing or malformed Hostaway pricing fails closed", () => {
  assert.equal(run({ priceDetails: null }).error, "PRICE_DETAILS_INVALID");
  assert.equal(run({ priceDetails: { status: "fail", result: { totalPrice: 6400, components: [comp()] } } }).error, "PRICE_DETAILS_INVALID");
  assert.equal(run({ priceDetails: payload([comp()], 6500) }).error, "PRICE_DETAILS_INVALID"); // SUM_MISMATCH
  assert.equal(run({ priceDetails: payload([comp({ total: "6400" })], 6400) }).error, "SUBMINOR_AMOUNT");
  assert.equal(run({ priceDetails: payload([comp({ total: 0 })], 0) }).error, "NO_ACCOMMODATION");
  assert.equal(run({ priceDetails: payload([comp({ type: "fee", name: "cleaningFee", total: 500 })], 500) }).error, "NO_ACCOMMODATION");
});

// ---------- rounding & currency boundaries ----------
test("sub-centavo amounts are refused (no silent rounding of the charged base)", () => {
  assert.equal(isWholeMinor(1234.56), true);
  assert.equal(isWholeMinor(0.1 + 0.2), true); // 30.000000000000004 centavos -> still whole within tolerance
  assert.equal(isWholeMinor(10.005), false);
  assert.equal(run({ priceDetails: payload([comp({ total: 6400.005 })], 6400.005) }).error, "SUBMINOR_AMOUNT");
});

test("discount rounding is integer half-up and deterministic", () => {
  // 1,234.55 MXN -> 123,455 centavos; 10 % = 12,345.5 -> 12,346 (half-up)
  const r = run({ priceDetails: payload([comp({ total: 1234.55 })], 1234.55) });
  assert.equal(r.ok, true);
  assert.deepEqual([r.price.discountMinor, r.price.finalTotalMinor], [12346, 111109]);
  // same inputs -> same hash, byte for byte
  const again = run({ priceDetails: payload([comp({ total: 1234.55 })], 1234.55) });
  assert.equal(again.price.quoteHash, r.price.quoteHash);
});

test("currency must be the listing currency, explicitly allowed and known", () => {
  assert.equal(run({ currency: "mxn" }).error, "INVALID_CURRENCY");
  assert.equal(run({ currency: "MX" }).error, "INVALID_CURRENCY");
  assert.equal(run({ currency: undefined }).error, "INVALID_CURRENCY");
  assert.equal(run({ currency: "USD" }).error, "UNSUPPORTED_CURRENCY");                 // not allowed by default (D3)
  assert.equal(run({ currency: "JPY", allowedCurrencies: ["JPY"] }).error, "UNSUPPORTED_CURRENCY"); // unknown exponent
  const usd = run({ currency: "USD", allowedCurrencies: ["MXN", "USD"] });
  assert.equal(usd.ok, true);
  assert.equal(usd.price.charge.currency, "usd");
});

test("charge amount bounds (minimum / maximum)", () => {
  const tiny = run({ priceDetails: payload([comp({ total: 10 })], 10) }); // 10 MXN - 1 = 9 MXN < 10 MXN minimum
  assert.equal(tiny.error, "AMOUNT_BELOW_MINIMUM");
  const exactlyMin = run({ priceDetails: payload([comp({ total: 11.12 })], 11.12) }); // 1112 - 111 = 1001
  assert.equal(exactlyMin.ok, true);
  const huge = run({ priceDetails: payload([comp({ total: 2000000 })], 2000000) });
  assert.equal(huge.error, "AMOUNT_ABOVE_MAXIMUM");
  assert.equal(CURRENCIES.MXN.minChargeMinor, 1000);
});

// ---------- availability gates ----------
test("listing no longer available: refused with reasons", () => {
  const unavailable = bookability(REQ, { days: { "2026-12-22": { status: "booked", isAvailable: 0 } } });
  const r = run({ bookability: unavailable });
  assert.equal(r.error, "NOT_BOOKABLE");
  assert.deepEqual(r.reasons, ["NIGHT_UNAVAILABLE"]);
});

test("guest count exceeds capacity: refused", () => {
  const req = { ...REQ, guests: 3 };
  const r = computeFinalPrice({ request: req, bookability: bookability(req), priceDetails: PD_4N, currency: "MXN", policy: P });
  assert.equal(r.error, "NOT_BOOKABLE");
  assert.deepEqual(r.reasons, ["CAPACITY_EXCEEDED"]);
});

test("stale calendar or missing/mismatched bookability: refused", () => {
  assert.equal(run({ bookability: bookability(REQ, { fetchedAt: NOW - 10 * 60 * 1000 }) }).error, "NOT_BOOKABLE");
  assert.equal(run({ bookability: undefined }).error, "BOOKABILITY_REQUIRED");
  assert.equal(run({ bookability: { bookable: true, reasons: [], stay: null } }).error, "BOOKABILITY_MISMATCH");
  const other = { ...REQ, to: "2026-12-23" };
  assert.equal(run({ bookability: bookability(other) }).error, "BOOKABILITY_MISMATCH");
});

// ---------- price change between quote and checkout ----------
test("price change between initial quote and checkout is detected", () => {
  const first = run().price;
  const fresh = run({ priceDetails: payload([comp({ total: 6600 })], 6600) }).price;
  const cmp = compareFinalPrice(first, fresh);
  assert.equal(cmp.same, false);
  assert.ok(cmp.changes.includes("finalTotalMinor") && cmp.changes.includes("quoteHash"));
  assert.equal(compareFinalPrice(first, run().price).same, true);
  assert.equal(compareFinalPrice(first, null).same, false);
  // a different policy rate is also a change
  assert.equal(compareFinalPrice(first, run({ policy: { ...P, rateBps: 500 } }).price).same, false);
});

test("quote hash covers every charged field", () => {
  const p = run().price;
  const tampered = { ...p, finalTotalMinor: p.finalTotalMinor - 1 };
  assert.notEqual(quoteHashFor(tampered), p.quoteHash);
});
