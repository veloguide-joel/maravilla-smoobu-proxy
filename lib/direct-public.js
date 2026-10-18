// lib/direct-public.js — Book Direct D2: public shaping of the ESTIMATED direct-booking
// saving for /api/booking/quote (owner-authorized 2026-10-18).
//
// Pure (env is injected by the route). Called only after the Hostaway quote
// has passed validatePriceDetails and the bookability gate, so it can never
// change the availability decision and never causes an upstream call.
//
// Output is an explicit whitelist. Amounts are MAJOR units (centavos / 100)
// because that is what the rest of the public quote uses; the server did the
// arithmetic in integer minor units (lib/direct-pricing.js). Nothing here is
// client-controllable: rate comes from the server policy, currency from the
// listing.
//
// status "estimated"            -> standardTotal, eligibleAccommodation, discount,
//                                  estimatedTotal, policyVersion, rateBps present
// status "estimate_unavailable" -> only { estimate, status, reason, currency, note }
//   reasons: POLICY_UNMAPPED (unknown/coupon component), TAX_POLICY_UNRESOLVED,
//            CONFIG (DIRECT_DISCOUNT_BPS present but invalid — never a silent 10 %),
//            CALC (defensive: module refused or totals disagree)

import { computeDirectPricing, toMinor } from "./direct-pricing.js";
import { readDirectPolicyFromEnv } from "./direct-policy.js";

export const DIRECT_ESTIMATE_NOTE = "Estimated direct-booking total. Final price confirmed at checkout.";
export const DIRECT_PUBLIC_KEYS = Object.freeze([
  "estimate", "status", "reason", "currency", "standardTotal", "eligibleAccommodation", "discount", "estimatedTotal", "policyVersion", "rateBps", "note"
]);
const PUBLIC_REASONS = new Set(["POLICY_UNMAPPED", "TAX_POLICY_UNRESOLVED", "CONFIG", "CALC"]);

const major = (minor) => minor / 100;

function unavailable(reason, currency) {
  return { estimate: true, status: "estimate_unavailable", reason: PUBLIC_REASONS.has(reason) ? reason : "CALC", currency, note: DIRECT_ESTIMATE_NOTE };
}

/**
 * buildDirectEstimate({ priceDetails, currency, standardTotal, env }) -> public `direct` object (never throws for data).
 *   priceDetails  raw Hostaway payload already accepted by validatePriceDetails
 *   currency      listing currencyCode (already validated by the route)
 *   standardTotal the route's validated `total` (major units) — must agree with the module's standard
 *   env           server environment object (the route passes its own); never read globally here
 */
export function buildDirectEstimate({ priceDetails, currency, standardTotal, env } = {}) {
  const pol = readDirectPolicyFromEnv(env);
  if (!pol.ok) return unavailable("CONFIG", currency);

  let r;
  try {
    r = computeDirectPricing({ priceDetails, currency, policy: pol.policy, mode: "estimate" });
  } catch {
    return unavailable("CALC", currency);
  }
  if (!r.ok) return unavailable("CALC", currency);
  if (r.estimateAvailable !== true) return unavailable(r.reason, currency);
  if (r.standardMinor !== toMinor(standardTotal)) return unavailable("CALC", currency); // route total and module total must agree

  return {
    estimate: true,
    status: "estimated",
    currency: r.currency,
    standardTotal: major(r.standardMinor),
    eligibleAccommodation: major(r.eligibleMinor),
    discount: major(r.discountMinor),
    estimatedTotal: major(r.directTotalMinor),
    policyVersion: r.policyVersion,
    rateBps: r.rateBps,
    note: DIRECT_ESTIMATE_NOTE
  };
}
