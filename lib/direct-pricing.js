// lib/direct-pricing.js — Book Direct discount, step D1 (owner-authorized 2026-10-18).
//
// PURE: no I/O, no env, no clock, no logging. The caller supplies the raw
// Hostaway priceDetails payload, the LISTING currency and a frozen policy
// object built server-side (see lib/direct-policy.js). Nothing here can be
// influenced by a browser: the public routes whitelist their query params and
// the rate lives in the policy only.
//
// Business rules (owner decisions 2026-10-18 15:02):
//   - discount = policy.rateBps (default 1000 = 10 %) of the ELIGIBLE base
//   - eligible base = accommodation AFTER Hostaway's own weekly/monthly
//     (length-of-stay) discounts; never below 0
//   - fees and taxes are never discounted; they pass through unchanged
//   - all arithmetic in integer minor units (centavos), half-up rounding
//   - result carries policyVersion + rateBps + the listing currency
//   - unknown components (incl. non-LOS discounts such as coupons) or an
//     unresolved tax policy: estimate mode degrades to "standard price only",
//     checkout mode REFUSES (no authoritative amount is ever produced)
//
// Standard price = Hostaway totalPrice, revalidated with the existing
// validatePriceDetails contract (sum of included components == total, signs,
// finiteness). This module never reshapes or trusts a pre-classified list.

import { validatePriceDetails } from "./quote-public.js";

export const DIRECT_POLICY_VERSION = "direct-v1";
export const DEFAULT_RATE_BPS = 1000;
export const MAX_RATE_BPS = 5000;

export const DEFAULT_DIRECT_POLICY = Object.freeze({
  version: DIRECT_POLICY_VERSION,
  rateBps: DEFAULT_RATE_BPS,
  base: "accommodation_after_los",
  stackWithLosDiscount: true,
  discountFees: false,
  discountTaxes: false,
  taxOnDiscountedBase: "unresolved" // "unresolved" | "standard_base" | "discounted_base"
});

// --- classification allowlists (type AND name are case-sensitive, trimmed) ---
export const ACCOMMODATION_TYPES = Object.freeze(["accommodation", "price"]); // live: "accommodation"; docs' older name: "price"
export const LOS_DISCOUNT_NAMES = Object.freeze(["weeklyDiscount", "monthlyDiscount", "lengthOfStayDiscount"]);
export const FEE_TYPES = Object.freeze(["fee"]);
export const TAX_TYPES = Object.freeze(["tax"]);

export const MODES = Object.freeze(["estimate", "checkout"]);
const TAX_POLICIES = Object.freeze(["unresolved", "standard_base", "discounted_base"]);

const isInt = (v) => Number.isInteger(v);
const isFiniteNum = (v) => typeof v === "number" && Number.isFinite(v);
const str = (v) => (typeof v === "string" ? v.trim() : "");

/** Convert a major-unit float to integer minor units (centavos), half-up away from zero for .5. */
export function toMinor(amount) {
  if (!isFiniteNum(amount)) return null;
  const scaled = amount * 100;
  return scaled < 0 ? -Math.round(-scaled) : Math.round(scaled);
}

/** Integer half-up: minor * rateBps / 10000 without floating point. */
export function discountMinorFor(eligibleMinor, rateBps) {
  if (!isInt(eligibleMinor) || eligibleMinor < 0 || !isInt(rateBps) || rateBps < 0) return null;
  return Math.floor((eligibleMinor * rateBps + 5000) / 10000);
}

/**
 * classifyComponent(c) -> "accommodation" | "losDiscount" | "otherDiscount" | "fee" | "tax" | "unknown"
 * Explicit allowlists only. Anything not listed is "unknown" and therefore never discounted.
 */
export function classifyComponent(c) {
  if (!c || typeof c !== "object") return "unknown";
  const type = str(c.type);
  const name = str(c.name);
  if (ACCOMMODATION_TYPES.includes(type)) return "accommodation";
  if (type === "discount") return LOS_DISCOUNT_NAMES.includes(name) ? "losDiscount" : "otherDiscount";
  if (FEE_TYPES.includes(type)) return "fee";
  if (TAX_TYPES.includes(type)) return "tax";
  return "unknown";
}

/** validatePolicy(policy) -> { ok:true } | { ok:false, error:"INVALID_POLICY", detail } */
export function validatePolicy(policy) {
  if (!policy || typeof policy !== "object") return { ok: false, error: "INVALID_POLICY", detail: "missing" };
  if (policy.version !== DIRECT_POLICY_VERSION) return { ok: false, error: "INVALID_POLICY", detail: "version" };
  if (!isInt(policy.rateBps) || policy.rateBps < 0 || policy.rateBps > MAX_RATE_BPS) return { ok: false, error: "INVALID_POLICY", detail: "rateBps" };
  if (policy.base !== "accommodation_after_los") return { ok: false, error: "INVALID_POLICY", detail: "base" };
  if (policy.stackWithLosDiscount !== true) return { ok: false, error: "INVALID_POLICY", detail: "stackWithLosDiscount" };
  if (policy.discountFees !== false || policy.discountTaxes !== false) return { ok: false, error: "INVALID_POLICY", detail: "fees/taxes" };
  if (!TAX_POLICIES.includes(policy.taxOnDiscountedBase)) return { ok: false, error: "INVALID_POLICY", detail: "taxOnDiscountedBase" };
  return { ok: true };
}

const included = (c) => c.isIncludedInTotalPrice === 1 || c.isIncludedInTotalPrice === true;

/**
 * computeDirectPricing({ priceDetails, currency, policy, mode })
 *
 * Returns (all amounts are integer minor units):
 *   { ok:true, mode, estimate, estimateAvailable, reason?, currency, policyVersion, rateBps,
 *     standardMinor, eligibleMinor, discountMinor, directTotalMinor,
 *     classified:[{bucket,type,name,minor}], taxPresent, unknownComponents:[{type,name,minor}] }
 *   | { ok:false, error, ... }
 *
 * Data problems never throw; programmer errors (bad mode, missing policy object) do.
 */
export function computeDirectPricing({ priceDetails, currency, policy, mode } = {}) {
  if (!MODES.includes(mode)) throw new TypeError(`computeDirectPricing: mode must be one of ${MODES.join("|")}`);
  if (policy === undefined || policy === null) throw new TypeError("computeDirectPricing: policy is required");

  const pv = validatePolicy(policy);
  if (!pv.ok) return { ok: false, error: "INVALID_INPUT", detail: `policy.${pv.detail}` };
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) return { ok: false, error: "INVALID_INPUT", detail: "currency" };

  // 1. The existing authoritative contract decides whether the payload is usable at all.
  const validated = validatePriceDetails(priceDetails);
  if (!validated.ok) return { ok: false, error: validated.error };

  // 2. Classify every INCLUDED component in integer minor units.
  const classified = [];
  const unknownComponents = [];
  let accommodationMinor = 0;
  let losMinor = 0;
  let sumIncludedMinor = 0;
  let taxPresent = false;
  for (const c of priceDetails.result.components) {
    if (!included(c)) continue;
    const minor = toMinor(c.total);
    if (minor === null) return { ok: false, error: "INVALID_COMPONENT_TOTAL" };
    const bucket = classifyComponent(c);
    const entry = { bucket, type: str(c.type), name: str(c.name), minor };
    classified.push(entry);
    sumIncludedMinor += minor;
    if (bucket === "accommodation") accommodationMinor += minor;
    else if (bucket === "losDiscount") losMinor += minor;
    else if (bucket === "tax") taxPresent = true;
    else if (bucket === "otherDiscount" || bucket === "unknown") unknownComponents.push({ type: entry.type, name: entry.name, minor });
  }

  const standardMinor = toMinor(priceDetails.result.totalPrice);
  if (standardMinor === null || standardMinor < 0) return { ok: false, error: "INVALID_TOTAL" };
  if (sumIncludedMinor !== standardMinor) return { ok: false, error: "SUM_MISMATCH" }; // exact, in centavos

  // 3. Policy gates: anything unresolved suppresses estimates and refuses checkout.
  let reason = null;
  if (unknownComponents.length) reason = "POLICY_UNMAPPED";
  else if (taxPresent && policy.taxOnDiscountedBase === "unresolved") reason = "TAX_POLICY_UNRESOLVED";

  const base = {
    mode, estimate: mode === "estimate", currency, policyVersion: policy.version, rateBps: policy.rateBps,
    standardMinor, classified, taxPresent, unknownComponents
  };

  if (reason) {
    if (mode === "checkout") return { ok: false, error: reason, ...base, eligibleMinor: 0, discountMinor: 0, directTotalMinor: null };
    return { ok: true, estimateAvailable: false, reason, ...base, eligibleMinor: 0, discountMinor: 0, directTotalMinor: standardMinor };
  }

  // 4. The discount itself.
  const eligibleMinor = Math.max(0, accommodationMinor + losMinor);
  const discountMinor = discountMinorFor(eligibleMinor, policy.rateBps);
  if (discountMinor === null) return { ok: false, error: "INVARIANT", detail: "discount" };
  const directTotalMinor = standardMinor - discountMinor;

  // 5. Invariants (defensive; the validator's sign rules make these unreachable).
  if (!(discountMinor >= 0 && discountMinor <= eligibleMinor && eligibleMinor <= standardMinor && directTotalMinor === standardMinor - discountMinor && directTotalMinor >= 0)) {
    return { ok: false, error: "INVARIANT", detail: "bounds" };
  }

  return { ok: true, estimateAvailable: true, ...base, eligibleMinor, discountMinor, directTotalMinor };
}
