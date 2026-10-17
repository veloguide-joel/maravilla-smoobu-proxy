// Offline tests for lib/calendar-public.js and lib/hostaway-calendar.js (sanitizeDay) — Stage F2. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { normalizeCalendar, classifyNight, datesInclusive, PUBLIC_CALENDAR_KEYS } from "../lib/calendar-public.js";
import { sanitizeDay } from "../lib/hostaway-calendar.js";
import { evaluateStay } from "../lib/bookability.js";

// Stage C day shape incl. the private fields the live API carries.
function day(date, over = {}) {
  return {
    id: 1, date, isAvailable: 1, isProcessed: 1, status: "available", price: 2200, minimumStay: 1, maximumStay: 0,
    closedOnArrival: null, closedOnDeparture: null, note: null, countAvailableUnits: 1, availableUnitsToSell: 1,
    countPendingUnits: 0, countBlockedUnits: 0, countBlockingReservations: null, countReservedUnits: null, desiredUnitsToSell: null, reservations: [],
    ...over
  };
}
const addDay = (iso, n = 1) => { const [y, m, d] = iso.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const range = (from, to, mut = () => ({})) => { const out = []; for (let d = from; d <= to; d = addDay(d)) out.push(day(d, mut(d))); return out; };
const BLOCKED = { status: "blocked", isAvailable: 0 };
// Stage C live block (2026-10-16): nights Nov 10, 11, 12 manual on 603564.
const NOV_C = range("2026-11-08", "2026-11-15", (d) => (["2026-11-10", "2026-11-11", "2026-11-12"].includes(d) ? BLOCKED : {}));
const pub = (rawDays, from, to) => normalizeCalendar({ rawDays, from, to });

test("modules are pure: no network/env/clock in calendar-public; hostaway-calendar imports only lib/hostaway", () => {
  const cp = readFileSync(fileURLToPath(new URL("../lib/calendar-public.js", import.meta.url)), "utf8");
  for (const f of ["fetch(", "process.env", "Date.now", "require("]) assert.equal(cp.includes(f), false, f);
  assert.match(cp, /from "\.\/bookability\.js"/);
  const hc = readFileSync(fileURLToPath(new URL("../lib/hostaway-calendar.js", import.meta.url)), "utf8");
  assert.equal(hc.includes("includeResources"), true); // documented as never sent
  assert.equal(/query:\s*\{\s*startDate:\s*from,\s*endDate:\s*to\s*\}/.test(hc), true, "query must be exactly startDate/endDate");
});

test("Stage C block reproduces exactly: one range Nov 10 -> Nov 13, 3 nights, departure-exclusive", () => {
  const r = pub(NOV_C, "2026-11-08", "2026-11-15");
  assert.equal(r.ok, true);
  assert.deepEqual(r.public.unavailable, [{ arrival: "2026-11-10", departure: "2026-11-13", nights: 3 }]);
  assert.equal(r.public.unavailableNights, 3);
  assert.deepEqual(r.public.coverage, { daysRequested: 8, daysReturned: 8, complete: true });
  assert.deepEqual(r.internal.kinds, { open: 5, closed: 0, booking: 0, pending: 0, manual: 3, unknown: 0, missing: 0 });
});

test("Stage D single-night block: Nov 10 -> Nov 11, 1 night", () => {
  const days = range("2026-11-08", "2026-11-13", (d) => (d === "2026-11-10" ? BLOCKED : {}));
  assert.deepEqual(pub(days, "2026-11-08", "2026-11-13").public.unavailable, [{ arrival: "2026-11-10", departure: "2026-11-11", nights: 1 }]);
});

test("fully open window -> no ranges, complete coverage", () => {
  const r = pub(range("2026-11-01", "2026-11-30"), "2026-11-01", "2026-11-30");
  assert.deepEqual(r.public.unavailable, []);
  assert.equal(r.public.unavailableNights, 0);
  assert.equal(r.public.coverage.complete, true);
});

test("adjacent nights of different kinds merge into one public range (kind stays internal)", () => {
  const days = range("2026-11-01", "2026-11-08", (d) => d === "2026-11-03" ? { status: "reserved", isAvailable: 0 } : d === "2026-11-04" ? BLOCKED : d === "2026-11-05" ? { status: "pending", isAvailable: 0 } : {});
  const r = pub(days, "2026-11-01", "2026-11-08");
  assert.deepEqual(r.public.unavailable, [{ arrival: "2026-11-03", departure: "2026-11-06", nights: 3 }]);
  assert.deepEqual(r.internal.kinds, { open: 5, closed: 0, booking: 1, pending: 1, manual: 1, unknown: 0, missing: 0 });
  assert.equal(JSON.stringify(r.public).includes("kind"), false);
});

test("range at the end of the window: departure = day after window end", () => {
  const days = range("2026-11-01", "2026-11-05", (d) => (d >= "2026-11-04" ? BLOCKED : {}));
  assert.deepEqual(pub(days, "2026-11-01", "2026-11-05").public.unavailable, [{ arrival: "2026-11-04", departure: "2026-11-06", nights: 2 }]);
});

test("classifyNight: every non-open case is closed; contradictions and unknown statuses are 'unknown'", () => {
  assert.equal(classifyNight(day("x")), "open");
  assert.equal(classifyNight(day("x", { isAvailable: 0 })), "closed");
  assert.equal(classifyNight(day("x", { status: "reserved", isAvailable: 0 })), "booking");
  assert.equal(classifyNight(day("x", { status: "mreserved", isAvailable: 0 })), "booking");
  assert.equal(classifyNight(day("x", { status: "pending", isAvailable: 0 })), "pending");
  for (const s of ["blocked", "hardBlock", "mblocked", "conflicted"]) assert.equal(classifyNight(day("x", { status: s, isAvailable: 0 })), "manual", s);
  assert.equal(classifyNight(day("x", { status: "reserved", isAvailable: 1 })), "unknown");   // contradictory
  assert.equal(classifyNight(day("x", { status: "brand_new_status", isAvailable: 1 })), "unknown");
  assert.equal(classifyNight(day("x", { status: undefined })), "unknown");
  assert.equal(classifyNight(null), "unknown");
});

test("unknown / contradictory statuses are unavailable in the public output (fail closed)", () => {
  const days = range("2026-11-01", "2026-11-05", (d) => d === "2026-11-02" ? { status: "weird" } : d === "2026-11-04" ? { status: "reserved", isAvailable: 1 } : {});
  const r = pub(days, "2026-11-01", "2026-11-05");
  assert.deepEqual(r.public.unavailable.map((x) => x.arrival), ["2026-11-02", "2026-11-04"]);
  assert.equal(r.internal.kinds.unknown, 2);
});

test("missing days inside the window are reported unavailable and coverage.complete=false", () => {
  const days = range("2026-11-01", "2026-11-10").filter((d) => !["2026-11-05", "2026-11-06"].includes(d.date));
  const r = pub(days, "2026-11-01", "2026-11-10");
  assert.equal(r.ok, true);
  assert.deepEqual(r.public.coverage, { daysRequested: 10, daysReturned: 8, complete: false });
  assert.deepEqual(r.public.unavailable, [{ arrival: "2026-11-05", departure: "2026-11-07", nights: 2 }]);
  assert.equal(r.internal.kinds.missing, 2);
});

test("upstream returning days only outside the window -> every night unavailable, complete=false", () => {
  const r = pub(range("2026-12-01", "2026-12-05"), "2026-11-01", "2026-11-03");
  assert.equal(r.public.coverage.complete, false);
  assert.equal(r.public.unavailableNights, 3);
  assert.equal(r.internal.extraDaysOutsideWindow, 5);
});

test("duplicate or malformed day objects are an integrity failure (route answers 502)", () => {
  assert.equal(pub([...range("2026-11-01", "2026-11-03"), day("2026-11-02")], "2026-11-01", "2026-11-03").error, "CALENDAR_INCONSISTENT");
  assert.equal(pub([...range("2026-11-01", "2026-11-03"), { status: "available", isAvailable: 1 }], "2026-11-01", "2026-11-03").error, "CALENDAR_INCONSISTENT");
  assert.equal(pub([...range("2026-11-01", "2026-11-03"), null], "2026-11-01", "2026-11-03").error, "CALENDAR_INCONSISTENT");
  assert.equal(pub("nope", "2026-11-01", "2026-11-03").error, "NOT_AN_ARRAY");
  assert.equal(pub([], "2026-11-03", "2026-11-01").error, "INVALID_WINDOW");
});

test("restrictions: closed-on-arrival/departure dates and min/max stay (>1 / >0) are listed per date", () => {
  const days = range("2026-11-01", "2026-11-06", (d) => d === "2026-11-02" ? { closedOnArrival: 1, minimumStay: 3 } : d === "2026-11-04" ? { closedOnDeparture: true, maximumStay: 7 } : {});
  const r = pub(days, "2026-11-01", "2026-11-06").public.restrictions;
  assert.deepEqual(r, {
    closedOnArrival: ["2026-11-02"], closedOnDeparture: ["2026-11-04"],
    minimumStay: [{ date: "2026-11-02", nights: 3 }], maximumStay: [{ date: "2026-11-04", nights: 7 }]
  });
});

test("public shape never contains kind, price, note, reservations or counters", () => {
  const salted = NOV_C.map((d) => ({ ...d, note: "owner family visit", reservations: [{ guestName: "Jane Doe", guestEmail: "jane@example.com", reservationId: 987 }] }));
  const r = pub(salted, "2026-11-08", "2026-11-15");
  const text = JSON.stringify(r.public);
  for (const leak of ["kind", "manual", "blocked", "price", "2200", "note", "owner family", "reservation", "Jane", "jane@", "987", "count", "Units", "isProcessed", "status"]) assert.equal(text.includes(leak), false, leak);
  assert.deepEqual(Object.keys(r.public), ["from", "to", "coverage", "unavailable", "unavailableNights", "restrictions"]);
  for (const k of Object.keys(r.public)) assert.ok(PUBLIC_CALENDAR_KEYS.includes(k), k);
});

test("sanitizeDay keeps only the 7 F0-relevant keys and drops note/reservations", () => {
  const s = sanitizeDay(day("2026-11-10", { note: "secret", reservations: [{ guestName: "x" }] }));
  assert.deepEqual(Object.keys(s), ["date", "status", "isAvailable", "minimumStay", "maximumStay", "closedOnArrival", "closedOnDeparture"]);
  assert.equal(JSON.stringify(s).includes("secret"), false);
  assert.equal(sanitizeDay(null), null);
  assert.equal(sanitizeDay([1]), null);
});

test("sanitized days are exactly what lib/bookability.js needs, including the check-out day", () => {
  const days = NOV_C.map(sanitizeDay); // Nov 8..15 inclusive
  const listing = { id: 603564, personCapacity: 2, minNights: 1, maxNights: 365 };
  const base = { listingId: 603564, allowedListingIds: [603564, 603566], listing, days, guests: 2, today: "2026-10-17", now: 1000, calendarFetchedAt: 900 };
  assert.equal(evaluateStay({ ...base, from: "2026-11-08", to: "2026-11-10" }).bookable, true);   // checkout on first blocked night
  const bad = evaluateStay({ ...base, from: "2026-11-09", to: "2026-11-12" });
  assert.equal(bad.bookable, false);
  assert.equal(bad.reasons[0].code, "NIGHT_UNAVAILABLE");
  assert.equal(evaluateStay({ ...base, from: "2026-11-13", to: "2026-11-15" }).bookable, true);   // arrival on block's departure day
});

test("datesInclusive and inputs are not mutated", () => {
  assert.deepEqual(datesInclusive("2026-11-29", "2026-12-01"), ["2026-11-29", "2026-11-30", "2026-12-01"]);
  const days = Object.freeze(NOV_C.map((d) => Object.freeze({ ...d })));
  const before = JSON.stringify(days);
  pub(days, "2026-11-08", "2026-11-15");
  assert.equal(JSON.stringify(days), before);
});
