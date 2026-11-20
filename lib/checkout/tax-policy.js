// lib/checkout/tax-policy.js — P1 (owner decision 2026-11-20): Mexican lodging taxes added to every checkout total.
//
// Owner rule: 16% IVA + 5% state lodging tax (ISH, Nayarit) = 21%, applied to the WHOLE pre-tax total (accommodation and fees, after the
// Book Direct discount), for every stay regardless of length. Shown to the guest as ONE "Taxes" line; the two components are kept in the
// price object for the confirmation and for bookkeeping.
//
// The ONLY place the tax policy is selected. Takes an env object (the route / runner passes the server environment), like
// lib/direct-policy.js. MISSING MV_CHECKOUT_TAX_POLICY = no tax policy (the pre-P1 behaviour, final-price-v1); a PRESENT but unknown value
// is a configuration error and fails closed: it is never silently replaced.
export const TAX_POLICY_ENV = "MV_CHECKOUT_TAX_POLICY";

const deepFreeze = (o) => { Object.values(o).forEach((v) => { if (v && typeof v === "object") deepFreeze(v); }); return Object.freeze(o); };

export const TAX_POLICIES = deepFreeze({
  "mx-iva16-ish5-v1": {
    version: "mx-iva16-ish5-v1",
    base: "pre_tax_total",
    label: "Taxes",
    components: [{ code: "IVA", label: "IVA (16%)", rateBps: 1600 }, { code: "ISH", label: "State lodging tax (5%)", rateBps: 500 }]
  }
});

/** readTaxPolicyFromEnv(env) -> { ok:true, taxPolicy: null | policy, source:"none"|"env" } | { ok:false, error:"TAX_POLICY_CONFIG" } */
export function readTaxPolicyFromEnv(env) {
  const raw = env && typeof env === "object" ? env[TAX_POLICY_ENV] : undefined;
  if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) return { ok: true, taxPolicy: null, source: "none" };
  if (typeof raw !== "string" || !Object.hasOwn(TAX_POLICIES, raw.trim())) return { ok: false, error: "TAX_POLICY_CONFIG" };
  return { ok: true, taxPolicy: TAX_POLICIES[raw.trim()], source: "env" };
}

/** half-up integer tax on a non-negative integer minor amount */
export const taxMinorFor = (baseMinor, rateBps) => Math.floor((baseMinor * rateBps + 5000) / 10000);

/**
 * computeTax(taxPolicy, preTaxMinor) -> { ok:true, taxMinor, components:[{code,label,rateBps,amountMinor}] } | { ok:false, error }
 * Each component is rounded on its own (as it is remitted); the guest line is their sum.
 */
export function computeTax(taxPolicy, preTaxMinor) {
  if (!taxPolicy || typeof taxPolicy !== "object" || TAX_POLICIES[taxPolicy.version] !== taxPolicy) return { ok: false, error: "TAX_POLICY_INVALID" };
  if (!Number.isSafeInteger(preTaxMinor) || preTaxMinor <= 0) return { ok: false, error: "TAX_BASE_INVALID" };
  const components = taxPolicy.components.map((c) => Object.freeze({ code: c.code, label: c.label, rateBps: c.rateBps, amountMinor: taxMinorFor(preTaxMinor, c.rateBps) }));
  return { ok: true, taxMinor: components.reduce((s, c) => s + c.amountMinor, 0), components: Object.freeze(components) };
}

/**
 * taxPolicyOfPrice(price) -> null (a pre-P1 price: no tax) | the policy the price was quoted under | false (unknown version: refuse).
 * A re-check always uses the policy the guest was QUOTED under, never whatever the environment says today.
 */
export function taxPolicyOfPrice(price) {
  const v = price && typeof price === "object" ? price.taxPolicyVersion : undefined;
  if (v === undefined || v === null) return null;
  return typeof v === "string" && Object.hasOwn(TAX_POLICIES, v) ? TAX_POLICIES[v] : false;
}
