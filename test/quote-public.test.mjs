// Offline tests for lib/quote-public.js — Stage F3. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validatePriceDetails, publicReasons, decisionFor, PUBLIC_QUOTE_KEYS, QUOTE_NOTE } from "../lib/quote-public.js";

// Real Stage D payload shapes (2026-10-17 live): base component type "accommodation", name "baseRate";
// discounts negative; undocumented units/displayInRent present; originalTotalPrice always 0.
const comp = (over = {}) => ({ id: 1, type: "accommodation", name: "baseRate", title: "Base rate", alias: null, quantity: 1, value: 2200, total: 6600,
  isIncludedInTotalPrice: 1, isMandatory: 1, isQuantitySelectable: 0, isOverriddenByUser: 0, isDeleted: 0, listingFeeSettingId: 777, units: 3, displayInRent: 1, ...over });
const payload = (components, totalPrice) => ({ status: "success", result: { totalPrice, originalTotalPrice: 0, selectedComponentsAmount: 0, components, extraComponents: [], selectedComponents: [] } });

test("module is pure", () => {
  const src = readFileSync(fileURLToPath(new URL("../lib/quote-public.js", import.meta.url)), "utf8");
  for (const f of ["fetch(", "process.env", "Date.now", "import ", "require(", "USD", "exchange"]) assert.equal(src.includes(f), false, f);
});

test("Stage D control: 3 nights x 2200 -> total 6600, one Accommodation line", () => {
  const r = validatePriceDetails(payload([comp()], 6600));
  assert.deepEqual(r, { ok: true, total: 6600, breakdown: [{ type: "accommodation", label: "Accommodation", total: 6600 }], componentCount: 1, excludedCount: 0 });
});

test("Stage D weekly case (603566, 7 nights): 11200 - 1120 = 10080; discount label", () => {
  const r = validatePriceDetails(payload([comp({ value: 1600, total: 11200 }), comp({ id: 2, type: "discount", name: "weeklyDiscount", title: "Weekly discount", value: -1120, total: -1120, listingFeeSettingId: null })], 10080));
  assert.equal(r.ok, true);
  assert.equal(r.total, 10080);
  assert.deepEqual(r.breakdown.map((b) => [b.type, b.label, b.total]), [["accommodation", "Accommodation", 11200], ["discount", "Weekly discount", -1120]]);
});

test("Stage D monthly case (603564, 30 nights): 66000 - 13200 = 52800", () => {
  const r = validatePriceDetails(payload([comp({ total: 66000 }), comp({ id: 2, type: "discount", name: "monthlyDiscount", total: -13200 })], 52800));
  assert.equal(r.ok, true);
  assert.equal(r.total, 52800);
  assert.equal(r.breakdown[1].label, "Monthly discount");
});

test("breakdown carries only type/label/total — no ids, flags, units or internal names", () => {
  const r = validatePriceDetails(payload([comp()], 6600));
  assert.deepEqual(Object.keys(r.breakdown[0]), ["type", "label", "total"]);
  const text = JSON.stringify(r);
  for (const leak of ["listingFeeSettingId", "777", "units", "displayInRent", "isMandatory", "baseRate", "alias"]) assert.equal(text.includes(leak), false, leak);
});

test("sum mismatch is refused, never adjusted", () => {
  assert.deepEqual(validatePriceDetails(payload([comp({ total: 6600 })], 6000)), { ok: false, error: "SUM_MISMATCH" });
  assert.deepEqual(validatePriceDetails(payload([comp({ total: 6600 })], 6600.01)), { ok: false, error: "SUM_MISMATCH" });
  assert.equal(validatePriceDetails(payload([comp({ total: 6600 })], 6600.004)).ok, true); // sub-cent noise tolerated
});

test("optional (not included) components are excluded from the total check and the breakdown", () => {
  const r = validatePriceDetails(payload([comp(), comp({ id: 9, type: "fee", name: "lateCheckout", total: 500, isIncludedInTotalPrice: 0, isMandatory: 0 })], 6600));
  assert.equal(r.ok, true);
  assert.equal(r.excludedCount, 1);
  assert.equal(r.breakdown.length, 1);
});

test("malformed pricing payloads are refused with explicit errors", () => {
  assert.equal(validatePriceDetails(null).error, "NOT_AN_OBJECT");
  assert.equal(validatePriceDetails({ status: "fail", result: "Something went wrong" }).error, "UPSTREAM_REJECTED");
  assert.equal(validatePriceDetails({ status: "success", result: [1] }).error, "UNEXPECTED_SHAPE");
  assert.equal(validatePriceDetails({ status: "success", result: { totalPrice: 10 } }).error, "NO_COMPONENTS");
  assert.equal(validatePriceDetails(payload([comp()], "6600")).error, "INVALID_TOTAL");
  assert.equal(validatePriceDetails(payload([comp()], NaN)).error, "INVALID_TOTAL");
  assert.equal(validatePriceDetails(payload([comp()], -1)).error, "INVALID_TOTAL");
  assert.equal(validatePriceDetails(payload([comp({ total: "6600" })], 6600)).error, "INVALID_COMPONENT_TOTAL");
  assert.equal(validatePriceDetails(payload([comp({ total: Infinity })], 6600)).error, "INVALID_COMPONENT_TOTAL");
  assert.equal(validatePriceDetails(payload([null], 0)).error, "INVALID_COMPONENT");
  assert.equal(validatePriceDetails(payload([comp({ total: -5 })], -5)).error, "INVALID_TOTAL");
  assert.equal(validatePriceDetails(payload([comp({ total: 6700 }), comp({ id: 2, type: "fee", name: "x", total: -100 })], 6600)).error, "INVALID_COMPONENT_SIGN");
  assert.equal(validatePriceDetails(payload([comp({ total: 6000 }), comp({ id: 2, type: "discount", name: "weeklyDiscount", total: 600 })], 6600)).error, "INVALID_COMPONENT_SIGN");
  assert.equal(validatePriceDetails(payload([comp({ isIncludedInTotalPrice: 0 })], 0)).error, "NO_INCLUDED_COMPONENTS");
});

test("zero total with a zero component is valid (free stay would still be a price, not a permission)", () => {
  assert.equal(validatePriceDetails(payload([comp({ total: 0, value: 0 })], 0)).ok, true);
});

test("labels: known names mapped, unknown names humanised, title fallback, bounded", () => {
  const r = validatePriceDetails(payload([comp({ name: "cleaningFee", type: "fee", total: 300 }), comp({ id: 2, name: "someNewThing", title: "", total: 100 }), comp({ id: 3, name: "", title: "Resort Fee", total: 50 }), comp({ id: 4, total: 6150 })], 6600));
  assert.deepEqual(r.breakdown.map((b) => b.label), ["Cleaning fee", "Some New Thing", "Resort Fee", "Accommodation"]);
});

test("publicReasons whitelists detail fields; decisionFor separates unconfirmed from unavailable", () => {
  const reasons = [
    { code: "NIGHT_UNAVAILABLE", message: "One or more selected nights are not available.", firstUnavailableNight: "2026-11-10", unavailableCount: 1 },
    { code: "CALENDAR_INCOMPLETE", message: "x", missingNights: ["2026-11-11"], missingCount: 1, missingDepartureDay: "2026-11-12" },
    { code: "CAPACITY_EXCEEDED", message: "y", maxGuests: 2, field: "guests", problems: ["internal"] }
  ];
  const pub = publicReasons(reasons);
  assert.deepEqual(pub, [
    { code: "NIGHT_UNAVAILABLE", message: "One or more selected nights are not available.", firstUnavailableNight: "2026-11-10", unavailableCount: 1 },
    { code: "CALENDAR_INCOMPLETE", message: "x" },
    { code: "CAPACITY_EXCEEDED", message: "y", maxGuests: 2 }
  ]);
  assert.equal(decisionFor(reasons), "unconfirmed");
  assert.equal(decisionFor([reasons[0], reasons[2]]), "unavailable");
  assert.equal(decisionFor([{ code: "CALENDAR_STALE" }]), "unconfirmed");
  assert.deepEqual(publicReasons(undefined), []);
});

test("public key list and note are explicit about quote vs reservation", () => {
  assert.ok(PUBLIC_QUOTE_KEYS.includes("currency") && PUBLIC_QUOTE_KEYS.includes("note") && !PUBLIC_QUOTE_KEYS.includes("_meta"));
  assert.match(QUOTE_NOTE, /no inventory is held/i);
});
