// lib/direct-policy.js — builds the Book Direct policy from server configuration (D1).
//
// The ONLY place the discount rate is read. Takes an env object as an
// argument (the route layer passes the server environment) so it stays
// testable and the pure pricing module never touches the environment.
//
// Owner rule (2026-10-18): a MISSING DIRECT_DISCOUNT_BPS defaults to 1000;
// a PRESENT but invalid/out-of-range value is a configuration error and
// fails closed — it is never silently replaced by the default.

import { DEFAULT_DIRECT_POLICY, DEFAULT_RATE_BPS, MAX_RATE_BPS } from "./direct-pricing.js";

export const DIRECT_RATE_ENV = "DIRECT_DISCOUNT_BPS";

/**
 * readDirectPolicyFromEnv(env) ->
 *   { ok:true, policy, source:"default"|"env" } | { ok:false, error:"DIRECT_POLICY_CONFIG", detail }
 */
export function readDirectPolicyFromEnv(env) {
  const raw = env && typeof env === "object" ? env[DIRECT_RATE_ENV] : undefined;
  if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) {
    return { ok: true, policy: Object.freeze({ ...DEFAULT_DIRECT_POLICY, rateBps: DEFAULT_RATE_BPS }), source: "default" };
  }
  if (typeof raw !== "string" || !/^\d{1,5}$/.test(raw.trim())) {
    return { ok: false, error: "DIRECT_POLICY_CONFIG", detail: `${DIRECT_RATE_ENV} must be an integer number of basis points` };
  }
  const rateBps = Number(raw.trim());
  if (rateBps > MAX_RATE_BPS) {
    return { ok: false, error: "DIRECT_POLICY_CONFIG", detail: `${DIRECT_RATE_ENV} out of range (0..${MAX_RATE_BPS})` };
  }
  return { ok: true, policy: Object.freeze({ ...DEFAULT_DIRECT_POLICY, rateBps }), source: "env" };
}
