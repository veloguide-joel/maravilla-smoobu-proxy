// P1 (owner decision 2026-11-20): 16% IVA + 5% state lodging tax added to every checkout total. Offline: no network, DB or provider.
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeFinalPrice, compareFinalPrice, quoteHashFor, FINAL_PRICE_VERSION, FINAL_PRICE_VERSION_TAX } from "../lib/checkout/final-price.js";
import { TAX_POLICIES, TAX_POLICY_ENV, readTaxPolicyFromEnv, computeTax, taxMinorFor, taxPolicyOfPrice } from "../lib/checkout/tax-policy.js";
import { evaluateStay, addDays } from "../lib/bookability.js";
import { DEFAULT_DIRECT_POLICY } from "../lib/direct-pricing.js";

const MX = TAX_POLICIES["mx-iva16-ish5-v1"];
const comp = (over = {}) => ({ id: 1, type: "accommodation", name: "baseRate", title: "Base rate", quantity: 1, value: 100, total: 100,
  isIncludedInTotalPrice: 1, isMandatory: 1, isOverriddenByUser: 0, isDeleted: 0, units: 1, ...over });
const payload = (components, totalPrice) => ({ status: "success", result: { totalPrice, originalTotalPrice: 0, components } });
const TODAY = "2026-11-20"; const NOW = Date.UTC(2026, 10, 20, 18, 0, 0);
const REQ = Object.freeze({ listingId: 606998, from: "2026-12-22", to: "2026-12-23", guests: 1 });
function days(from, to) { const out = []; for (let d = from; d <= to; d = addDays(d, 1)) out.push({ date: d, status: "available", isAvailable: 1, minimumStay: 1, maximumStay: 90, closedOnArrival: 0, closedOnDeparture: 0 }); return out; }
const bookability = () => evaluateStay({ listingId: REQ.listingId, listing: { id: REQ.listingId, personCapacity: 2, minNights: 1, maxNights: 90 }, days: days(REQ.from, REQ.to),
  from: REQ.from, to: REQ.to, guests: REQ.guests, today: TODAY, now: NOW, calendarFetchedAt: NOW - 1000 });
// the TEST listing's real shape: 100.00 accommodation + 50.00 cleaning fee, USD
const PD = payload([comp(), comp({ id: 2, type: "fee", name: "cleaningFee", title: "Cleaning fee", value: 50, total: 50 })], 150);
const run = (over = {}) => computeFinalPrice({ request: REQ, bookability: bookability(), priceDetails: PD, currency: "USD", policy: DEFAULT_DIRECT_POLICY, allowedCurrencies: ["USD"], ...over });

test("T1 policy selection: missing = none (pre-P1 behaviour); the named policy = 16% + 5%; an unknown value FAILS CLOSED", () => {
  assert.deepEqual(readTaxPolicyFromEnv({}), { ok: true, taxPolicy: null, source: "none" });
  assert.deepEqual(readTaxPolicyFromEnv({ [TAX_POLICY_ENV]: "  " }), { ok: true, taxPolicy: null, source: "none" });
  const r = readTaxPolicyFromEnv({ [TAX_POLICY_ENV]: "mx-iva16-ish5-v1" });
  assert.equal(r.ok, true); assert.equal(r.taxPolicy, MX);
  assert.deepEqual(MX.components.map((c) => [c.code, c.rateBps]), [["IVA", 1600], ["ISH", 500]]);
  for (const bad of ["mx", "21", "none", 21, "MX-IVA16-ISH5-V1", "constructor", "__proto__"]) assert.deepEqual(readTaxPolicyFromEnv({ [TAX_POLICY_ENV]: bad }), { ok: false, error: "TAX_POLICY_CONFIG" }, String(bad));
  assert.ok(Object.isFrozen(MX) && Object.isFrozen(MX.components) && Object.isFrozen(MX.components[0]));
});

test("T2 arithmetic: each component rounded half-up on the pre-tax total; the owner's Airbnb example ($290 -> $60.90) reproduces", () => {
  assert.deepEqual(computeTax(MX, 29000), { ok: true, taxMinor: 6090, components: [
    { code: "IVA", label: "IVA (16%)", rateBps: 1600, amountMinor: 4640 }, { code: "ISH", label: "State lodging tax (5%)", rateBps: 500, amountMinor: 1450 }] });
  assert.equal(taxMinorFor(3, 1600), 0); assert.equal(taxMinorFor(4, 1600), 1);          // 0.48 -> 0 ; 0.64 -> 1
  assert.equal(taxMinorFor(10, 500), 1);                                                    // exactly 0.5 -> up
  assert.equal(computeTax(MX, 33).taxMinor, 5 + 2);                                         // 5.28 -> 5 ; 1.65 -> 2
  for (const bad of [0, -1, 1.5, NaN, "100", null]) assert.equal(computeTax(MX, bad).ok, false, String(bad));
  for (const bad of [null, {}, { ...MX }, { version: "mx-iva16-ish5-v1" }]) assert.deepEqual(computeTax(bad, 100), { ok: false, error: "TAX_POLICY_INVALID" });
});

test("T3 the TEST listing with taxes: $100 + $50 cleaning - $10 direct = $140.00 pre-tax; taxes $29.40; total $169.40; ONE guest tax line; lines reconcile", () => {
  const r = run({ taxPolicy: MX });
  assert.equal(r.ok, true);
  const p = r.price;
  assert.deepEqual([p.version, p.standardTotalMinor, p.discountMinor, p.preTaxTotalMinor, p.taxMinor, p.finalTotalMinor, p.taxPolicyVersion],
    [FINAL_PRICE_VERSION_TAX, 15000, 1000, 14000, 2940, 16940, "mx-iva16-ish5-v1"]);
  assert.deepEqual(p.taxComponents.map((c) => [c.code, c.amountMinor]), [["IVA", 2240], ["ISH", 700]]);
  assert.deepEqual(p.lines.filter((l) => l.kind === "tax").map((l) => ({ ...l })), [{ kind: "tax", code: "mx-iva16-ish5-v1", label: "Taxes", amountMinor: 2940 }]);
  assert.equal(p.lines.reduce((s, l) => s + l.amountMinor, 0), p.finalTotalMinor);
  assert.equal(p.standardTotalMinor - p.discountMinor + p.taxMinor, p.finalTotalMinor);    // the 0029 invariant
  assert.equal(p.charge.amountMinor, 16940);                                                // what Stripe is asked to authorize
  assert.equal(p.quoteHash, quoteHashFor(p)); assert.match(p.quoteHash, /^[0-9a-f]{64}$/);
  assert.ok(Object.isFrozen(p) && Object.isFrozen(p.lines) && Object.isFrozen(p.taxComponents));
});

test("T4 no tax policy = the pre-P1 price, byte for byte (v1, $140.00, no tax fields, same hash)", () => {
  const a = run(); const b = run({ taxPolicy: null });
  assert.equal(a.ok, true);
  assert.deepEqual([a.price.version, a.price.finalTotalMinor], [FINAL_PRICE_VERSION, 14000]);
  for (const k of ["taxMinor", "preTaxTotalMinor", "taxPolicyVersion", "taxComponents"]) assert.equal(k in a.price, false, k);
  assert.equal(a.price.lines.some((l) => l.kind === "tax"), false);
  assert.equal(a.price.quoteHash, b.price.quoteHash);
});

test("T5 a taxed and an untaxed quote are NEVER 'the same price'; a Hostaway tax line is still refused; a forged policy object is refused", () => {
  const taxed = run({ taxPolicy: MX }).price; const plain = run().price;
  const cmp = compareFinalPrice(plain, taxed);
  assert.equal(cmp.same, false);
  for (const f of ["version", "taxMinor", "taxPolicyVersion", "finalTotalMinor", "quoteHash"]) assert.ok(cmp.changes.includes(f), f);
  assert.equal(compareFinalPrice(taxed, run({ taxPolicy: MX }).price).same, true);
  assert.notEqual(taxed.quoteHash, plain.quoteHash);
  const withHostawayTax = payload([comp(), comp({ id: 3, type: "tax", name: "vat", total: 16 })], 116);
  assert.equal(run({ priceDetails: withHostawayTax, taxPolicy: MX }).error, "TAX_POLICY_UNRESOLVED");
  assert.equal(run({ taxPolicy: { ...MX, components: [{ code: "IVA", label: "x", rateBps: 1 }] } }).error, "TAX_POLICY_INVALID");
});

test("T6 a re-check uses the policy the guest was QUOTED under: untaxed -> null; known -> that policy; unknown version -> false (refused)", () => {
  assert.equal(taxPolicyOfPrice(run().price), null);
  assert.equal(taxPolicyOfPrice(run({ taxPolicy: MX }).price), MX);
  assert.equal(taxPolicyOfPrice({ taxPolicyVersion: "mx-other" }), false);
  assert.equal(taxPolicyOfPrice({ taxPolicyVersion: "constructor" }), false);
  assert.equal(run({ taxPolicy: false }).error, "TAX_POLICY_INVALID");
});
