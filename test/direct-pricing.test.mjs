// Offline tests for lib/direct-pricing.js + lib/direct-policy.js — Book Direct D1. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  computeDirectPricing, classifyComponent, validatePolicy, toMinor, discountMinorFor,
  DEFAULT_DIRECT_POLICY, DIRECT_POLICY_VERSION
} from "../lib/direct-pricing.js";
import { readDirectPolicyFromEnv } from "../lib/direct-policy.js";

// Real Stage D / F3 payload shapes (live 2026-10-17/18): base component type "accommodation", name "baseRate";
// discounts negative; undocumented units/displayInRent present; originalTotalPrice always 0.
const comp = (over = {}) => ({ id: 1, type: "accommodation", name: "baseRate", title: "Base rate", alias: null, quantity: 1, value: 2200, total: 6600,
  isIncludedInTotalPrice: 1, isMandatory: 1, isQuantitySelectable: 0, isOverriddenByUser: 0, isDeleted: 0, listingFeeSettingId: 777, units: 3, displayInRent: 1, ...over });
const payload = (components, totalPrice) => ({ status: "success", result: { totalPrice, originalTotalPrice: 0, selectedComponentsAmount: 0, components, extraComponents: [], selectedComponents: [] } });
const P = DEFAULT_DIRECT_POLICY;
const run = (pd, mode = "estimate", over = {}) => computeDirectPricing({ priceDetails: pd, currency: "MXN", policy: P, mode, ...over });

// Live pilot quotes (MXN)
const PILOT = {
  n3_603564: payload([comp()], 6600),
  n3_603566: payload([comp({ value: 1600, total: 4800 })], 4800),
  n1_603566: payload([comp({ value: 1600, total: 1600, units: 1 })], 1600),
  weekly_603566: payload([comp({ value: 1600, total: 11200, units: 7 }), comp({ id: 2, type: "discount", name: "weeklyDiscount", title: "Weekly discount", value: -1120, total: -1120, listingFeeSettingId: null })], 10080),
  monthly_603564: payload([comp({ total: 66000, units: 30 }), comp({ id: 2, type: "discount", name: "monthlyDiscount", title: "Monthly discount", value: -13200, total: -13200, listingFeeSettingId: null })], 52800),
  monthly_603566: payload([comp({ value: 1600, total: 48000, units: 30 }), comp({ id: 2, type: "discount", name: "monthlyDiscount", title: "Monthly discount", value: -9600, total: -9600, listingFeeSettingId: null })], 38400)
};

const expectQuote = (r, { standard, eligible, discount, direct }) => {
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.estimateAvailable, true);
  assert.deepEqual([r.standardMinor, r.eligibleMinor, r.discountMinor, r.directTotalMinor], [standard, eligible, discount, direct]);
  assert.equal(r.currency, "MXN");
  assert.equal(r.policyVersion, DIRECT_POLICY_VERSION);
  assert.equal(r.rateBps, 1000);
  assert.equal(r.taxPresent, false);
  assert.deepEqual(r.unknownComponents, []);
};

test("T1 603564 3 nights: 6,600 -> 5,940 MXN", () => {
  expectQuote(run(PILOT.n3_603564), { standard: 660000, eligible: 660000, discount: 66000, direct: 594000 });
});
test("T2 603566 3 nights: 4,800 -> 4,320", () => {
  expectQuote(run(PILOT.n3_603566), { standard: 480000, eligible: 480000, discount: 48000, direct: 432000 });
});
test("T3 603566 1 night: 1,600 -> 1,440", () => {
  expectQuote(run(PILOT.n1_603566), { standard: 160000, eligible: 160000, discount: 16000, direct: 144000 });
});
test("T4 weekly 603566: 11,200 - 1,120 = 10,080 -> 9,072 (10 % of the LOS-reduced base, stacked)", () => {
  const r = run(PILOT.weekly_603566);
  expectQuote(r, { standard: 1008000, eligible: 1008000, discount: 100800, direct: 907200 });
  assert.deepEqual(r.classified.map((c) => c.bucket), ["accommodation", "losDiscount"]);
});
test("T5 monthly 603564: 66,000 - 13,200 = 52,800 -> 47,520", () => {
  expectQuote(run(PILOT.monthly_603564), { standard: 5280000, eligible: 5280000, discount: 528000, direct: 4752000 });
});
test("T6 monthly 603566: 38,400 -> 34,560", () => {
  expectQuote(run(PILOT.monthly_603566), { standard: 3840000, eligible: 3840000, discount: 384000, direct: 3456000 });
});
test("checkout mode on a clean pilot quote returns the same authoritative figures, estimate:false", () => {
  const r = run(PILOT.weekly_603566, "checkout");
  assert.equal(r.ok, true); assert.equal(r.estimate, false); assert.equal(r.mode, "checkout");
  assert.deepEqual([r.standardMinor, r.discountMinor, r.directTotalMinor], [1008000, 100800, 907200]);
});

test("T7 mandatory cleaning fee is part of the standard price but never discounted", () => {
  const pd = payload([comp(), comp({ id: 9, type: "fee", name: "cleaningFee", title: "Cleaning fee", value: 500, total: 500 })], 7100);
  const r = run(pd);
  assert.deepEqual([r.standardMinor, r.eligibleMinor, r.discountMinor, r.directTotalMinor], [710000, 660000, 66000, 644000]);
  assert.deepEqual(r.classified.map((c) => c.bucket), ["accommodation", "fee"]);
  const c = run(pd, "checkout"); assert.equal(c.ok, true); assert.equal(c.directTotalMinor, 644000);
});

test("T8 tax present + policy unresolved: estimate degrades to standard-only, checkout refuses", () => {
  const pd = payload([comp(), comp({ id: 9, type: "tax", name: "vat", title: "VAT / GST", value: 1056, total: 1056 })], 7656);
  const e = run(pd);
  assert.equal(e.ok, true); assert.equal(e.estimateAvailable, false); assert.equal(e.reason, "TAX_POLICY_UNRESOLVED");
  assert.deepEqual([e.standardMinor, e.discountMinor, e.directTotalMinor], [765600, 0, 765600]);
  assert.equal(e.taxPresent, true);
  const c = run(pd, "checkout");
  assert.equal(c.ok, false); assert.equal(c.error, "TAX_POLICY_UNRESOLVED"); assert.equal(c.directTotalMinor, null);
});
test("T8b tax present + policy resolved as standard_base: tax passes through, accommodation discounted", () => {
  const pd = payload([comp(), comp({ id: 9, type: "tax", name: "vat", value: 1056, total: 1056 })], 7656);
  const pol = Object.freeze({ ...P, taxOnDiscountedBase: "standard_base" });
  for (const mode of ["estimate", "checkout"]) {
    const r = computeDirectPricing({ priceDetails: pd, currency: "MXN", policy: pol, mode });
    assert.equal(r.ok, true, mode); assert.equal(r.estimateAvailable, true);
    assert.deepEqual([r.standardMinor, r.eligibleMinor, r.discountMinor, r.directTotalMinor], [765600, 660000, 66000, 699600]);
  }
});

test("T9 unknown component type: estimate degraded POLICY_UNMAPPED, checkout refused", () => {
  const pd = payload([comp(), comp({ id: 9, type: "adjustment", name: "manualAdjustment", value: 100, total: 100 })], 6700);
  const e = run(pd);
  assert.equal(e.ok, true); assert.equal(e.estimateAvailable, false); assert.equal(e.reason, "POLICY_UNMAPPED");
  assert.deepEqual(e.unknownComponents, [{ type: "adjustment", name: "manualAdjustment", minor: 10000 }]);
  assert.equal(e.discountMinor, 0); assert.equal(e.directTotalMinor, 670000);
  const c = run(pd, "checkout"); assert.equal(c.ok, false); assert.equal(c.error, "POLICY_UNMAPPED");
});
test("T10 non-LOS discount (coupon) is never stacked silently", () => {
  const pd = payload([comp(), comp({ id: 9, type: "discount", name: "couponXYZ", title: "Coupon", value: -500, total: -500 })], 6100);
  const e = run(pd);
  assert.equal(e.estimateAvailable, false); assert.equal(e.reason, "POLICY_UNMAPPED");
  assert.equal(e.classified[1].bucket, "otherDiscount");
  assert.equal(run(pd, "checkout").ok, false);
});
test("T11 optional (not included) extra is ignored entirely", () => {
  const pd = payload([comp(), comp({ id: 9, type: "fee", name: "lateCheckout", total: 500, isIncludedInTotalPrice: 0, isMandatory: 0 })], 6600);
  const r = run(pd);
  assert.deepEqual([r.standardMinor, r.discountMinor, r.directTotalMinor], [660000, 66000, 594000]);
  assert.equal(r.classified.length, 1);
});
test("T12 centavo rounding: 1,234.56 base -> discount 123.46 (half-up from 123.456)", () => {
  const r = run(payload([comp({ total: 1234.56 })], 1234.56));
  assert.deepEqual([r.standardMinor, r.eligibleMinor, r.discountMinor, r.directTotalMinor], [123456, 123456, 12346, 111110]);
});
test("T13 rounding boundary: 5 centavos at 10 % -> 0.5 -> 1 centavo; 4 centavos -> 0", () => {
  assert.equal(discountMinorFor(5, 1000), 1);
  assert.equal(discountMinorFor(4, 1000), 0);
  assert.equal(discountMinorFor(15, 1000), 2);
  assert.equal(discountMinorFor(0, 1000), 0);
  assert.equal(discountMinorFor(660000, 0), 0);
  assert.equal(toMinor(0.005), 1); assert.equal(toMinor(-0.005), -1); assert.equal(toMinor(10.004), 1000); assert.equal(toMinor(NaN), null);
});
test("T14 LOS discount larger than the base (negative total) is refused by the validator", () => {
  const pd = payload([comp({ total: 1000 }), comp({ id: 2, type: "discount", name: "weeklyDiscount", total: -1500 })], -500);
  assert.deepEqual(run(pd), { ok: false, error: "INVALID_TOTAL" });
});
test("T15 fee-only quote: eligible 0, discount 0, estimate still available", () => {
  const pd = payload([comp({ type: "fee", name: "cleaningFee", total: 500, value: 500 })], 500);
  const r = run(pd);
  assert.equal(r.ok, true); assert.equal(r.estimateAvailable, true);
  assert.deepEqual([r.eligibleMinor, r.discountMinor, r.directTotalMinor], [0, 0, 50000]);
  assert.equal(run(pd, "checkout").ok, true);
});
test("T16 sum mismatch is refused, never adjusted", () => {
  assert.deepEqual(run(payload([comp({ total: 6600 })], 6000)), { ok: false, error: "SUM_MISMATCH" });
});
test("T17 malformed payloads are refused with the validator's codes", () => {
  assert.equal(run(null).error, "NOT_AN_OBJECT");
  assert.equal(run({ status: "fail", result: "Something went wrong" }).error, "UPSTREAM_REJECTED");
  assert.equal(run({ status: "success", result: { totalPrice: 10 } }).error, "NO_COMPONENTS");
  assert.equal(run(payload([comp()], "6600")).error, "INVALID_TOTAL");
  assert.equal(run(payload([comp({ total: "6600" })], 6600)).error, "INVALID_COMPONENT_TOTAL");
  assert.equal(run(payload([null], 0)).error, "INVALID_COMPONENT");
  assert.equal(run(payload([comp(), comp({ id: 2, type: "fee", name: "x", total: -100 })], 6500)).error, "INVALID_COMPONENT_SIGN");
});
test("T18 currency must be an ISO-4217 code taken from the listing", () => {
  for (const currency of ["mxn", "US", "", undefined, null, 484]) {
    const r = computeDirectPricing({ priceDetails: PILOT.n3_603564, currency, policy: P, mode: "estimate" });
    assert.equal(r.ok, false, String(currency)); assert.equal(r.error, "INVALID_INPUT");
  }
  assert.equal(run(PILOT.n3_603564, "estimate", { currency: "USD" }).currency, "USD"); // echoed, never derived
});
test("T19 rate bounds: 0 -> no discount; 2500 -> 25 %; out-of-range/non-integer -> INVALID_INPUT", () => {
  const at = (rateBps) => computeDirectPricing({ priceDetails: PILOT.n3_603564, currency: "MXN", policy: Object.freeze({ ...P, rateBps }), mode: "estimate" });
  assert.deepEqual([at(0).discountMinor, at(0).directTotalMinor], [0, 660000]);
  assert.deepEqual([at(2500).discountMinor, at(2500).directTotalMinor, at(2500).rateBps], [165000, 495000, 2500]);
  for (const bad of [5001, -1, 10.5, "1000", null, undefined, NaN]) { const r = at(bad); assert.equal(r.ok, false, String(bad)); assert.equal(r.error, "INVALID_INPUT"); }
});
test("T20 policy tampering (base, stacking, fees/taxes flags, tax enum, version) is refused", () => {
  for (const over of [{ base: "total" }, { stackWithLosDiscount: false }, { discountFees: true }, { discountTaxes: true }, { taxOnDiscountedBase: "maybe" }, { version: "direct-v0" }]) {
    assert.equal(validatePolicy({ ...P, ...over }).ok, false, JSON.stringify(over));
    assert.equal(run(PILOT.n3_603564, "estimate", { policy: { ...P, ...over } }).error, "INVALID_INPUT");
  }
  assert.equal(validatePolicy(P).ok, true);
});
test("T21 purity: no I/O, env, clock or logging in the pricing module", () => {
  const src = readFileSync(fileURLToPath(new URL("../lib/direct-pricing.js", import.meta.url)), "utf8");
  for (const f of ["fetch(", "process.env", "Date", "console.", "require(", "node:fs", "node:http"]) assert.equal(src.includes(f), false, f);
  assert.match(src, /^import \{ validatePriceDetails \} from "\.\/quote-public\.js";$/m); // the only import
  assert.equal((src.match(/^import /gm) || []).length, 1);
});
test("T22 programmer errors throw: bad mode, missing policy", () => {
  assert.throws(() => computeDirectPricing({ priceDetails: PILOT.n3_603564, currency: "MXN", policy: P, mode: "final" }), TypeError);
  assert.throws(() => computeDirectPricing({ priceDetails: PILOT.n3_603564, currency: "MXN", mode: "estimate" }), TypeError);
  assert.throws(() => computeDirectPricing(), TypeError);
});
test("T23 invariant fuzz: 500 random valid payloads keep 0 <= discount <= eligible <= standard and direct = standard - discount", () => {
  let seed = 20261018; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let i = 0; i < 500; i += 1) {
    const base = Math.round(rnd() * 10000000) / 100;             // 0..100,000.00
    const los = rnd() < 0.5 ? -Math.round(rnd() * base * 20) / 100 : 0; // up to 20 % off
    const fee = rnd() < 0.5 ? Math.round(rnd() * 100000) / 100 : 0;
    const comps = [comp({ total: base })];
    if (los) comps.push(comp({ id: 2, type: "discount", name: rnd() < 0.5 ? "weeklyDiscount" : "monthlyDiscount", total: los }));
    if (fee) comps.push(comp({ id: 3, type: "fee", name: "cleaningFee", total: fee }));
    const total = Math.round((base + los + fee) * 100) / 100;
    const rateBps = Math.floor(rnd() * 5001);
    const r = computeDirectPricing({ priceDetails: payload(comps, total), currency: "MXN", policy: Object.freeze({ ...P, rateBps }), mode: rnd() < 0.5 ? "estimate" : "checkout" });
    assert.equal(r.ok, true, JSON.stringify({ base, los, fee, total, rateBps, r }));
    assert.ok(r.discountMinor >= 0 && r.discountMinor <= r.eligibleMinor && r.eligibleMinor <= r.standardMinor, "bounds");
    assert.equal(r.directTotalMinor, r.standardMinor - r.discountMinor);
    assert.equal(r.eligibleMinor, Math.max(0, toMinor(base) + toMinor(los)));
    assert.equal(r.discountMinor, Math.floor((r.eligibleMinor * rateBps + 5000) / 10000));
  }
});
test("T24 policy from env: missing -> default 1000; valid -> used; present-but-invalid -> configuration error (fail closed)", () => {
  assert.deepEqual(readDirectPolicyFromEnv({}), { ok: true, policy: { ...P, rateBps: 1000 }, source: "default" });
  assert.equal(readDirectPolicyFromEnv(undefined).policy.rateBps, 1000);
  assert.equal(readDirectPolicyFromEnv({ DIRECT_DISCOUNT_BPS: "" }).source, "default");
  assert.deepEqual(readDirectPolicyFromEnv({ DIRECT_DISCOUNT_BPS: "1500" }), { ok: true, policy: { ...P, rateBps: 1500 }, source: "env" });
  assert.equal(readDirectPolicyFromEnv({ DIRECT_DISCOUNT_BPS: " 0 " }).policy.rateBps, 0);
  for (const bad of ["abc", "9000", "-5", "10.5", "1e3", "1000bps", 1000]) {
    const r = readDirectPolicyFromEnv({ DIRECT_DISCOUNT_BPS: bad });
    assert.equal(r.ok, false, String(bad)); assert.equal(r.error, "DIRECT_POLICY_CONFIG"); assert.equal(r.policy, undefined);
  }
  assert.ok(Object.isFrozen(readDirectPolicyFromEnv({}).policy));
  const src = readFileSync(fileURLToPath(new URL("../lib/direct-policy.js", import.meta.url)), "utf8");
  assert.equal(src.includes("process.env"), false); // env is injected, never read globally
});
test("classification allowlist is explicit and case-sensitive", () => {
  assert.equal(classifyComponent({ type: "accommodation", name: "baseRate" }), "accommodation");
  assert.equal(classifyComponent({ type: "price", name: "baseRate" }), "accommodation");
  assert.equal(classifyComponent({ type: "discount", name: "weeklyDiscount" }), "losDiscount");
  assert.equal(classifyComponent({ type: "discount", name: "monthlyDiscount" }), "losDiscount");
  assert.equal(classifyComponent({ type: "discount", name: "lengthOfStayDiscount" }), "losDiscount");
  assert.equal(classifyComponent({ type: "discount", name: "WeeklyDiscount" }), "otherDiscount");
  assert.equal(classifyComponent({ type: "discount", name: "couponXYZ" }), "otherDiscount");
  assert.equal(classifyComponent({ type: "fee", name: "cleaningFee" }), "fee");
  assert.equal(classifyComponent({ type: "tax", name: "vat" }), "tax");
  assert.equal(classifyComponent({ type: "Accommodation", name: "baseRate" }), "unknown");
  assert.equal(classifyComponent({ type: "adjustment" }), "unknown");
  assert.equal(classifyComponent({}), "unknown");
  assert.equal(classifyComponent(null), "unknown");
  assert.equal(classifyComponent({ type: " fee ", name: "" }), "fee"); // trimmed
});
