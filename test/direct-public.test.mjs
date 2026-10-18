// Offline tests for lib/direct-public.js — Book Direct D2 (public estimate shaping). Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildDirectEstimate, DIRECT_PUBLIC_KEYS, DIRECT_ESTIMATE_NOTE } from "../lib/direct-public.js";
import { PUBLIC_QUOTE_KEYS } from "../lib/quote-public.js";

const comp = (over = {}) => ({ id: 1, type: "accommodation", name: "baseRate", title: "Base rate", quantity: 1, value: 2200, total: 6600,
  isIncludedInTotalPrice: 1, isMandatory: 1, listingFeeSettingId: 777, units: 3, displayInRent: 1, ...over });
const payload = (components, totalPrice) => ({ status: "success", result: { totalPrice, originalTotalPrice: 0, components, extraComponents: [], selectedComponents: [] } });
const build = (pd, total, env = {}, currency = "MXN") => buildDirectEstimate({ priceDetails: pd, currency, standardTotal: total, env });

const PILOTS = [
  ["603564 3n", payload([comp()], 6600), 6600, 6600, 660, 5940],
  ["603566 3n", payload([comp({ value: 1600, total: 4800 })], 4800), 4800, 4800, 480, 4320],
  ["603566 1n", payload([comp({ value: 1600, total: 1600 })], 1600), 1600, 1600, 160, 1440],
  ["603566 weekly", payload([comp({ value: 1600, total: 11200 }), comp({ id: 2, type: "discount", name: "weeklyDiscount", total: -1120, value: -1120 })], 10080), 10080, 10080, 1008, 9072],
  ["603564 monthly", payload([comp({ total: 66000 }), comp({ id: 2, type: "discount", name: "monthlyDiscount", total: -13200, value: -13200 })], 52800), 52800, 52800, 5280, 47520],
  ["603566 monthly", payload([comp({ value: 1600, total: 48000 }), comp({ id: 2, type: "discount", name: "monthlyDiscount", total: -9600, value: -9600 })], 38400), 38400, 38400, 3840, 34560]
];

test("six pilot quotes -> estimated public object with exact figures in major units", () => {
  for (const [label, pd, total, standard, discount, est] of PILOTS) {
    const d = build(pd, total);
    assert.deepEqual(d, { estimate: true, status: "estimated", currency: "MXN", standardTotal: standard, eligibleAccommodation: standard, discount, estimatedTotal: est, policyVersion: "direct-v1", rateBps: 1000, note: DIRECT_ESTIMATE_NOTE }, label);
    assert.equal(d.estimatedTotal, d.standardTotal - d.discount, label);
  }
});

test("public keys are an explicit whitelist; nothing internal leaks", () => {
  const d = build(PILOTS[3][1], 10080);
  for (const k of Object.keys(d)) assert.ok(DIRECT_PUBLIC_KEYS.includes(k), k);
  const text = JSON.stringify(d);
  for (const leak of ["classified", "unknownComponents", "Minor", "taxPresent", "detail", "baseRate", "listingFeeSettingId", "mode", "source"]) assert.equal(text.includes(leak), false, leak);
  assert.ok(PUBLIC_QUOTE_KEYS.includes("direct"));
});

test("fee: standard includes it, eligible excludes it", () => {
  const d = build(payload([comp(), comp({ id: 9, type: "fee", name: "cleaningFee", total: 500, value: 500 })], 7100), 7100);
  assert.deepEqual([d.status, d.standardTotal, d.eligibleAccommodation, d.discount, d.estimatedTotal], ["estimated", 7100, 6600, 660, 6440]);
});

test("unknown component / coupon -> estimate_unavailable POLICY_UNMAPPED, no amounts", () => {
  for (const extra of [comp({ id: 9, type: "adjustment", name: "manual", total: 100, value: 100 }), comp({ id: 9, type: "discount", name: "couponXYZ", total: 100, value: 100 })]) {
    const pd = payload([comp(), { ...extra, total: extra.type === "discount" ? -100 : 100 }], extra.type === "discount" ? 6500 : 6700);
    const d = build(pd, pd.result.totalPrice);
    assert.deepEqual(d, { estimate: true, status: "estimate_unavailable", reason: "POLICY_UNMAPPED", currency: "MXN", note: DIRECT_ESTIMATE_NOTE }, extra.type);
  }
});

test("tax present (policy unresolved) -> estimate_unavailable TAX_POLICY_UNRESOLVED", () => {
  const pd = payload([comp(), comp({ id: 9, type: "tax", name: "vat", total: 1056, value: 1056 })], 7656);
  assert.deepEqual(build(pd, 7656), { estimate: true, status: "estimate_unavailable", reason: "TAX_POLICY_UNRESOLVED", currency: "MXN", note: DIRECT_ESTIMATE_NOTE });
});

test("server configuration: missing env -> 10 %; valid env -> that rate; invalid env -> CONFIG, never a silent 10 %", () => {
  assert.equal(build(PILOTS[0][1], 6600, {}).rateBps, 1000);
  assert.equal(build(PILOTS[0][1], 6600, undefined).rateBps, 1000);
  const d15 = build(PILOTS[0][1], 6600, { DIRECT_DISCOUNT_BPS: "1500" });
  assert.deepEqual([d15.rateBps, d15.discount, d15.estimatedTotal], [1500, 990, 5610]);
  const d0 = build(PILOTS[0][1], 6600, { DIRECT_DISCOUNT_BPS: "0" });
  assert.deepEqual([d0.status, d0.discount, d0.estimatedTotal], ["estimated", 0, 6600]);
  for (const bad of ["abc", "9000", "-5", "10.5", "1e3"]) {
    const d = build(PILOTS[0][1], 6600, { DIRECT_DISCOUNT_BPS: bad });
    assert.deepEqual(d, { estimate: true, status: "estimate_unavailable", reason: "CONFIG", currency: "MXN", note: DIRECT_ESTIMATE_NOTE }, bad);
    assert.equal("rateBps" in d, false);
  }
});

test("defensive: route total disagreeing with the payload, malformed payload, bad currency -> CALC; never throws", () => {
  assert.equal(build(PILOTS[0][1], 6601).reason, "CALC");
  assert.equal(build({ status: "fail", result: "x" }, 6600).reason, "CALC");
  assert.equal(build(payload([comp({ total: 6600 })], 6000), 6000).reason, "CALC"); // sum mismatch
  assert.equal(build(PILOTS[0][1], 6600, {}, "mxn").reason, "CALC");
  assert.equal(buildDirectEstimate().status, "estimate_unavailable");
});

test("purity: env is injected, module never reads the process environment or does I/O", () => {
  const src = readFileSync(fileURLToPath(new URL("../lib/direct-public.js", import.meta.url)), "utf8");
  for (const f of ["process.env", "fetch(", "Date", "console."]) assert.equal(src.includes(f), false, f);
});
