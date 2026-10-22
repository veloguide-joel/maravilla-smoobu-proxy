// lib/e4-readonly-checks.js — Stage E4 (feature branch feature/e4-readonly-route only; never merged).
//
// Pure sanitizers and readiness evaluation for the read-only checks of test listing 606998.
// COPIED VERBATIM from the reviewed owner-private CLI in scripts/ (commit 8987e8f):
// constants, helpers, unwrap/tri, summarizeCustomFields, summarizeListing, summarizeCalendar,
// summarizePriceDetails (+ KNOWN_COMPONENT_NAMES) and evaluate. test/e4-check-route.test.mjs
// proves behaviour parity with the CLI on the same inputs. The CLI stays in scripts/
// (excluded from deployment by .vercelignore) and is NOT imported by any deployed code.
// No I/O, no env, no network.

import { validatePriceDetails } from "./quote-public.js";
import { normalizeCalendar } from "./calendar-public.js";
import { amountToMinor, isRealDate } from "./hostaway-reservations.js";

export { isRealDate };

export const TEST_LISTING_ID = 606998;
export const FORBIDDEN_PILOT_LISTING_IDS = Object.freeze([603564, 603566]);
export const EXPECTED_FIELD = Object.freeze({
  id: 105433, name: "maraVilla booking ref", objectType: "reservation", type: "text", varName: "reservation_maravilla_booking_ref"
});
// Known baselines for 606998 (dashboard-verified 2026-10-22; USD 50 cleaning fee owner-confirmed as intentional).
export const EXPECTED_LISTING = Object.freeze({
  name: "maraVilla TEST - DO NOT BOOK", currency: "USD", nightlyPriceMinor: 10000, ownerConfirmedCleaningFeeMinor: 5000
});
export const SCOPE_STATEMENT = "Read-only API evidence only. A passed check or a successful price calculation never authorizes a booking or any write and does not establish full isolation: channels, automations, auto-payments and booking-website status are verified separately in the dashboard.";
export const MAX_NIGHTS = 31;
export const MAX_GUESTS = 16;
const CUSTOM_FIELDS_LIMIT = 100;

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isPosInt = (v) => Number.isSafeInteger(v) && v > 0;
const enumOrNull = (v, allowed) => (allowed.includes(v) ? v : null);
const intOrNull = (v, min, max) => (Number.isSafeInteger(v) && v >= min && v <= max ? v : null);
const boolish = (v) => (v === 1 || v === true ? true : v === 0 || v === false ? false : null);

const unwrap = (json) => (isPlainObject(json) && json.status === "success" && Object.prototype.hasOwnProperty.call(json, "result") ? json.result : undefined);

// Tri-state constraint result: "pass" | "fail" | "unknown". Unknown never counts as pass.
export const tri = (v) => (v === true ? "pass" : v === false ? "fail" : "unknown");

export function summarizeCustomFields(json) {
  const result = unwrap(json);
  if (!Array.isArray(result)) return { ok: false, code: "UNEXPECTED_SHAPE" };
  if (result.length >= CUSTOM_FIELDS_LIMIT) return { ok: false, code: "LIST_POSSIBLY_TRUNCATED" };
  const valid = result.filter(isPlainObject);
  const byId = valid.filter((f) => f.id === EXPECTED_FIELD.id);
  const sameName = valid.filter((f) => f.name === EXPECTED_FIELD.name);
  const f = byId.length === 1 ? byId[0] : null;
  const isPublic = f ? boolish(f.isPublic) : null;
  // `ok` = the list was read and parsed. Whether the field meets its constraints is in `checks`.
  return {
    ok: true, code: "FIELDS_READ", fieldsReturned: valid.length, sameNameCount: sameName.length, matchesForId: byId.length,
    objectType: f ? enumOrNull(f.objectType, ["reservation", "listing", "task"]) : null,
    type: f ? enumOrNull(f.type, ["text", "textarea", "number", "dropdown"]) : null,
    isPublic,
    checks: {
      fieldFoundOnce: tri(byId.length === 1),
      nameExact: f ? tri(f.name === EXPECTED_FIELD.name) : "unknown",
      objectTypeReservation: f ? tri(f.objectType === EXPECTED_FIELD.objectType) : "unknown",
      typeText: f ? tri(f.type === EXPECTED_FIELD.type) : "unknown",
      private: f ? tri(isPublic === null ? null : !isPublic) : "unknown",
      uniqueName: tri(sameName.length === 1)
    },
    // Compared, never copied: the provider's varName text is not echoed.
    comparisons: { varNameMatchesExpected: f ? (typeof f.varName === "string" ? tri(f.varName === EXPECTED_FIELD.varName) : "unknown") : "unknown" }
  };
}

export function summarizeListing(json) {
  const l = unwrap(json);
  if (!isPlainObject(l)) return { ok: false, code: "UNEXPECTED_SHAPE" };
  if (l.id !== TEST_LISTING_ID) return { ok: false, code: "LISTING_ID_MISMATCH" };
  const name = typeof l.name === "string" ? l.name : null;
  const nameStatus = name === EXPECTED_LISTING.name ? "EXACT" : name === `${EXPECTED_LISTING.name}.` ? "TRAILING_PERIOD" : name === null ? "MISSING" : "OTHER";
  const money = (v) => (typeof v === "number" ? amountToMinor(v) : null);
  // Documented: specialStatus is "archived" or null. Absent or anything else is UNKNOWN, not "not archived".
  const archived = l.specialStatus === "archived" ? true : l.specialStatus === null ? false : null;
  const currencyCode = typeof l.currencyCode === "string" && /^[A-Z]{3}$/.test(l.currencyCode) ? l.currencyCode : null;
  const isBookingEngineActive = boolish(l.isBookingEngineActive);
  const priceMinor = money(l.price);
  const cleaningFeeMinor = money(l.cleaningFee);
  return {
    ok: true, code: "LISTING_READ", listingId: l.id, nameStatus, archived, currencyCode, priceMinor, cleaningFeeMinor,
    minNights: intOrNull(l.minNights, 0, 3650), maxNights: intOrNull(l.maxNights, 0, 100000), personCapacity: intOrNull(l.personCapacity, 0, 100),
    checkInTimeStart: intOrNull(l.checkInTimeStart, 0, 23), checkInTimeEnd: intOrNull(l.checkInTimeEnd, 0, 23), checkOutTime: intOrNull(l.checkOutTime, 0, 23),
    instantBookable: boolish(l.instantBookable), isBookingEngineActive,
    checks: {
      nameExpected: name === null ? "unknown" : tri(nameStatus === "EXACT" || nameStatus === "TRAILING_PERIOD"),   // trailing period accepted
      currencyUSD: currencyCode === null ? "unknown" : tri(currencyCode === EXPECTED_LISTING.currency),
      notArchived: tri(archived === null ? null : !archived),
      bookingEngineInactive: tri(isBookingEngineActive === null ? null : !isBookingEngineActive)
    },
    // Observed values compared with known baselines. Reported only; never a reason to change a price.
    comparisons: {
      nightlyPriceMatchesTestValue: priceMinor === null ? "unknown" : tri(priceMinor === EXPECTED_LISTING.nightlyPriceMinor),
      cleaningFeeMatchesOwnerBaseline: cleaningFeeMinor === null ? "unknown" : tri(cleaningFeeMinor === EXPECTED_LISTING.ownerConfirmedCleaningFeeMinor)
    }
  };
}

const DAY_KEYS = ["date", "status", "isAvailable", "minimumStay", "maximumStay", "closedOnArrival", "closedOnDeparture", "price"];
export function summarizeCalendar(json, plan) {
  const raw = Array.isArray(json) ? json : unwrap(json);
  if (!Array.isArray(raw)) return { ok: false, code: "UNEXPECTED_SHAPE" };
  const days = raw.filter(isPlainObject).map((d) => Object.fromEntries(DAY_KEYS.map((k) => [k, Object.prototype.hasOwnProperty.call(d, k) ? d[k] : null])));
  const n = normalizeCalendar({ rawDays: days, from: plan.from, to: plan.to });
  if (!n.ok) return { ok: false, code: typeof n.error === "string" && /^[A-Z_]{1,40}$/.test(n.error) ? n.error : "CALENDAR_INVALID" };
  const prices = days.filter((d) => d.date >= plan.from && d.date < plan.to).map((d) => (typeof d.price === "number" ? amountToMinor(d.price) : null));
  const known = prices.filter((p) => p !== null);
  return {
    ok: true, code: "CALENDAR_READ", checks: { coverageComplete: tri(n.public.coverage.complete) },
    daysRequested: n.public.coverage.daysRequested, daysReturned: n.public.coverage.daysReturned, complete: n.public.coverage.complete,
    unavailableNights: n.public.unavailableNights,
    unavailable: n.public.unavailable.map((r) => ({ arrival: r.arrival, departure: r.departure, nights: r.nights })),
    kinds: { ...n.internal.kinds },
    nightlyPriceMinor: known.length ? { min: Math.min(...known), max: Math.max(...known), nightsWithPrice: known.length, nightsWithoutPrice: prices.length - known.length } : null
  };
}

const COMPONENT_TYPES = ["price", "tax", "fee", "discount"];
/**
 * Component names that may appear in the report: exactly the names lib/quote-public.js labels explicitly
 * (its COMPONENT_LABELS). Any other provider name is reported as null; only type, index and amount remain.
 */
export const KNOWN_COMPONENT_NAMES = Object.freeze(["baseRate", "weeklyDiscount", "monthlyDiscount", "cleaningFee", "lengthOfStayDiscount"]);
export function summarizePriceDetails(json) {
  const v = validatePriceDetails(json);
  if (!v.ok) return { ok: false, code: typeof v.error === "string" && /^[A-Z_]{1,40}$/.test(v.error) ? `PRICE_${v.error}` : "PRICE_INVALID" };
  const r = unwrap(json);
  const totalMinor = amountToMinor(r.totalPrice);
  if (totalMinor === null) return { ok: false, code: "PRICE_TOTAL_NOT_EXACT" };
  const components = [];
  r.components.forEach((c, index) => {
    const t = typeof c.total === "number" ? (c.total < 0 ? amountToMinor(-c.total) : amountToMinor(c.total)) : null;
    components.push(t === null ? null : {
      index, type: enumOrNull(c.type, COMPONENT_TYPES), name: KNOWN_COMPONENT_NAMES.includes(c.name) ? c.name : null,
      totalMinor: c.total < 0 ? -t : t, included: boolish(c.isIncludedInTotalPrice), mandatory: boolish(c.isMandatory)
    });
  });
  if (components.includes(null)) return { ok: false, code: "PRICE_COMPONENT_NOT_EXACT" };
  const includedSum = components.filter((c) => c.included === true).reduce((s, c) => s + c.totalMinor, 0);
  if (includedSum !== totalMinor) return { ok: false, code: "PRICE_SUM_MISMATCH_MINOR" };
  const cleaning = components.filter((c) => c.name === "cleaningFee");
  const cleaningFeeMinor = cleaning.length === 1 ? cleaning[0].totalMinor : null;
  return {
    ok: true, code: "PRICE_CALCULATED", totalMinor, componentCount: components.length, components,
    unknownComponentNames: components.filter((c) => c.name === null).length,
    cleaningFeeMinor,
    extraComponentsCount: Array.isArray(r.extraComponents) ? r.extraComponents.length : null,
    comparisons: {
      cleaningFeeMatchesOwnerBaseline: cleaningFeeMinor === null ? "unknown" : tri(cleaningFeeMinor === EXPECTED_LISTING.ownerConfirmedCleaningFeeMinor)
    }
  };
}

/**
 * Separates "the API read worked" from "the constraints passed". Verdict: FAILED if any readiness check failed;
 * otherwise UNRESOLVED if any read failed or any check is unknown; PASSED only if every read succeeded and every
 * readiness check passed. Comparisons (observed amounts vs baselines) are reported but never change the verdict.
 */
export function evaluate(report) {
  const reads = {};
  const checks = {};
  const comparisons = {};
  for (const step of ["customFields", "listing", "calendar", "priceDetails"]) {
    const r = report.results[step];
    reads[step] = r && r.ok === true ? "ok" : r ? r.code : "NOT_RUN";
    for (const [k, v] of Object.entries((r && r.checks) || {})) checks[`${step}.${k}`] = v;
    for (const [k, v] of Object.entries((r && r.comparisons) || {})) comparisons[`${step}.${k}`] = v;
  }
  const expected = ["customFields.fieldFoundOnce", "customFields.nameExact", "customFields.objectTypeReservation", "customFields.typeText",
    "customFields.private", "customFields.uniqueName", "listing.nameExpected", "listing.currencyUSD", "listing.notArchived",
    "listing.bookingEngineInactive", "calendar.coverageComplete"];
  for (const k of expected) if (!(k in checks)) checks[k] = "unknown";   // a step that failed leaves its checks unresolved
  const vals = Object.values(checks);
  const readsOk = Object.values(reads).every((x) => x === "ok");
  const verdict = vals.includes("fail") ? "FAILED" : !readsOk || vals.includes("unknown") ? "UNRESOLVED" : "PASSED";
  report.readiness = { verdict, reads, checks };
  report.comparisons = comparisons;
  report.outcome = `READ_ONLY_CHECKS_${verdict}`;
  report.scope = SCOPE_STATEMENT;
  return report;
}

