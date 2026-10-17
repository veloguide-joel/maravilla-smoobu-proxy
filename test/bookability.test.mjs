// Offline tests for lib/bookability.js — Stage F0.
// Run: node --test test/
// No network, no env, no database. Fixtures reproduce the shapes verified live
// in Stage B (listing limits), Stage C (calendar, incl. the Nov 10–12 manual
// block of 2026-10-16) and Stage D (the Nov 10 single-night block of 2026-10-17).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { evaluateStay, occupiedNights, nightIsOpen, REASON, DEFAULT_POLICY } from "../lib/bookability.js";

// ---------- fixtures (real Stage B values) ----------
const LISTINGS = {
  603564: { id: 603564, personCapacity: 2, minNights: 1, maxNights: 365 },
  603566: { id: 603566, personCapacity: 2, minNights: 1, maxNights: 365 }
};
const PILOT = [603564, 603566];
const TODAY = "2026-10-17";
const NOW = Date.UTC(2026, 9, 17, 13, 30, 0);  // fixed clock for the tests
const FRESH = NOW - 5000;                      // calendar fetched 5 s ago

// One calendar day object per night, as Hostaway returns it (Stage C, reservations[] stripped).
function day(date, overrides = {}) {
  return {
    date, status: "available", isAvailable: 1, price: 2200,
    minimumStay: 1, maximumStay: 0, closedOnArrival: null, closedOnDeparture: null,
    ...overrides
  };
}
function range(from, to, mut = () => ({})) {          // from..to INCLUSIVE
  const out = [];
  for (let d = from; d <= to; d = addDay(d)) out.push(day(d, mut(d)));
  return out;
}
function addDay(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}
const blocked = { status: "blocked", isAvailable: 0 };

// Stage C live block: nights Nov 10, 11, 12 blocked on 603564 (range Nov 10 -> Nov 13).
const NOV_BLOCK_3 = range("2026-11-01", "2026-11-30", (d) => (["2026-11-10", "2026-11-11", "2026-11-12"].includes(d) ? blocked : {}));
// Stage D live block: night Nov 10 only.
const NOV_BLOCK_1 = range("2026-11-01", "2026-11-30", (d) => (d === "2026-11-10" ? blocked : {}));
const OPEN_NOV = range("2026-11-01", "2026-11-30");

function run(over = {}) {
  return evaluateStay({
    listingId: 603564, allowedListingIds: PILOT, listing: LISTINGS[603564],
    days: OPEN_NOV, from: "2026-11-16", to: "2026-11-19", guests: 2,
    today: TODAY, now: NOW, calendarFetchedAt: FRESH, ...over
  });
}
const codes = (r) => r.reasons.map((x) => x.code);
const expectOnly = (r, ...expected) => {
  assert.equal(r.bookable, false, `expected not bookable, got ${JSON.stringify(r.reasons)}`);
  assert.deepEqual(codes(r), expected, `reasons ${JSON.stringify(codes(r))} != ${JSON.stringify(expected)}`);
};
const expectOk = (r) => assert.equal(r.bookable, true, `expected bookable, got ${JSON.stringify(r.reasons)}`);

// ---------- 0. purity of the module itself ----------
test("module is pure: no network, env, clock, db or imports", () => {
  const src = readFileSync(fileURLToPath(new URL("../lib/bookability.js", import.meta.url)), "utf8");
  for (const forbidden of ["fetch(", "process.env", "Date.now", "import ", "require(", "pg", "supabase", "stripe"]) {
    assert.equal(src.includes(forbidden), false, `source must not contain "${forbidden}"`);
  }
});

// ---------- happy paths ----------
test("open 3-night stay on 603564 is bookable (Stage D control: Nov 16 -> 19)", () => {
  const r = run();
  expectOk(r);
  assert.deepEqual(r.checks.occupiedNights, ["2026-11-16", "2026-11-17", "2026-11-18"]);
  assert.equal(r.checks.departureDay, "2026-11-19");
  assert.equal(r.stay.nights, 3);
});
test("1-night stay on 603566 with 2 guests is bookable", () => {
  expectOk(run({ listingId: 603566, listing: LISTINGS[603566], from: "2026-11-20", to: "2026-11-21" }));
});
test("listingId as numeric string is accepted", () => {
  expectOk(run({ listingId: "603564" }));
});

// ---------- 1. listing id + capacity ----------
test("non-pilot listing id is refused before anything else", () => {
  expectOnly(run({ listingId: 999999, listing: { id: 999999, personCapacity: 2, minNights: 1, maxNights: 365 } }), REASON.LISTING_NOT_ALLOWED);
});
test("listing object for a different id fails closed", () => {
  expectOnly(run({ listing: LISTINGS[603566] }), REASON.LISTING_DATA_INCOMPLETE);
});
test("missing personCapacity fails closed", () => {
  expectOnly(run({ listing: { id: 603564, minNights: 1, maxNights: 365 } }), REASON.LISTING_DATA_INCOMPLETE);
});
test("3 guests on a 2-person listing -> CAPACITY_EXCEEDED with maxGuests (both pilots)", () => {
  for (const id of PILOT) {
    const r = run({ listingId: id, listing: LISTINGS[id], guests: 3 });
    expectOnly(r, REASON.CAPACITY_EXCEEDED);
    assert.equal(r.reasons[0].maxGuests, 2);
  }
});
test("guests 0, negative, fractional or string -> INVALID_GUESTS", () => {
  for (const g of [0, -1, 1.5, "2", null, undefined]) expectOnly(run({ guests: g }), REASON.INVALID_GUESTS);
});

// ---------- 2. dates ----------
test("non-strict or impossible dates -> INVALID_DATES", () => {
  for (const from of ["2026-11-1", "11/16/2026", "2026-02-30", "2026-13-01", 20261116, ""]) {
    const r = run({ from });
    assert.equal(r.bookable, false);
    assert.ok(codes(r).includes(REASON.INVALID_DATES), `from=${from}`);
  }
});
test("departure equal to or before arrival -> STAY_TOO_SHORT", () => {
  expectOnly(run({ from: "2026-11-16", to: "2026-11-16" }), REASON.STAY_TOO_SHORT);
  expectOnly(run({ from: "2026-11-16", to: "2026-11-15" }), REASON.STAY_TOO_SHORT);
});
test("arrival today -> TOO_SOON; arrival tomorrow -> ok (minLeadDays 1)", () => {
  const todayDays = range("2026-10-17", "2026-10-20");
  const r = run({ days: todayDays, from: "2026-10-17", to: "2026-10-19" });
  expectOnly(r, REASON.TOO_SOON);
  assert.equal(r.reasons[0].earliestArrival, "2026-10-18");
  expectOk(run({ days: todayDays, from: "2026-10-18", to: "2026-10-20" }));
});
test("past arrival -> TOO_SOON (never evaluated as available)", () => {
  expectOnly(run({ days: range("2026-10-01", "2026-10-05"), from: "2026-10-01", to: "2026-10-03" }), REASON.TOO_SOON);
});
test("91 nights -> STAY_TOO_LONG; 90 nights allowed by policy", () => {
  const long = range("2026-11-01", "2027-02-15");
  expectOnly(run({ days: long, from: "2026-11-01", to: "2027-01-31" }), REASON.STAY_TOO_LONG); // 91
  expectOk(run({ days: long, from: "2026-11-01", to: "2027-01-30" }));                         // 90
});
test("missing today -> INVALID_INPUT (module never reads the clock)", () => {
  const r = run({ today: undefined });
  assert.ok(codes(r).includes(REASON.INVALID_INPUT));
  assert.equal(r.bookable, false);
});

// ---------- 3/4/5/10. nights, blocks, boundaries ----------
test("occupiedNights is arrival-inclusive / departure-exclusive", () => {
  assert.deepEqual(occupiedNights("2026-11-09", "2026-11-12"), ["2026-11-09", "2026-11-10", "2026-11-11"]);
  assert.deepEqual(occupiedNights("2026-11-09", "2026-11-10"), ["2026-11-09"]);
});
test("Stage D case: Nov 9 -> 12 across the Nov 10 block is NOT bookable (priceDetails quoted it at 6,600)", () => {
  const r = run({ days: NOV_BLOCK_1, from: "2026-11-09", to: "2026-11-12" });
  expectOnly(r, REASON.NIGHT_UNAVAILABLE);
  assert.equal(r.reasons[0].firstUnavailableNight, "2026-11-10");
  assert.equal(r.reasons[0].unavailableCount, 1);
});
test("Stage C block Nov 10-12: checkout ON the first blocked night (Nov 9 -> 10) is bookable", () => {
  expectOk(run({ days: NOV_BLOCK_3, from: "2026-11-09", to: "2026-11-10" }));
});
test("Stage C block: checkout on the second blocked night (Nov 9 -> 11) is NOT bookable", () => {
  expectOnly(run({ days: NOV_BLOCK_3, from: "2026-11-09", to: "2026-11-11" }), REASON.NIGHT_UNAVAILABLE);
});
test("Stage C block: arrival on the block's departure day (Nov 13 -> 15) is bookable", () => {
  expectOk(run({ days: NOV_BLOCK_3, from: "2026-11-13", to: "2026-11-15" }));
});
test("Stage C block: arrival on the last blocked night (Nov 12 -> 14) is NOT bookable", () => {
  expectOnly(run({ days: NOV_BLOCK_3, from: "2026-11-12", to: "2026-11-14" }), REASON.NIGHT_UNAVAILABLE);
});
test("Stage C block: a stay spanning the whole block reports 3 unavailable nights", () => {
  const r = run({ days: NOV_BLOCK_3, from: "2026-11-08", to: "2026-11-15" });
  expectOnly(r, REASON.NIGHT_UNAVAILABLE);
  assert.equal(r.reasons[0].unavailableCount, 3);
  assert.equal(r.reasons[0].firstUnavailableNight, "2026-11-10");
});
test("reasons never expose block kind, notes or reservations", () => {
  const r = run({ days: NOV_BLOCK_3.map((d) => ({ ...d, note: "owner family visit", reservations: [{ guestName: "X" }] })), from: "2026-11-09", to: "2026-11-12" });
  const text = JSON.stringify(r);
  for (const leak of ["manual", "blocked", "note", "owner family", "reservations", "guestName"]) assert.equal(text.includes(leak), false, `leaked "${leak}"`);
});
test("every non-available status is closed: reserved, pending, blocked, hardBlock, mblocked, mreserved, conflicted, unknown, missing", () => {
  for (const status of ["reserved", "pending", "blocked", "hardBlock", "mblocked", "mreserved", "conflicted", "something_new", undefined]) {
    assert.equal(nightIsOpen(day("2026-11-16", { status, isAvailable: 0 })), false, String(status));
    const r = run({ days: OPEN_NOV.map((d) => (d.date === "2026-11-17" ? { ...d, status, isAvailable: 0 } : d)) });
    assert.equal(r.bookable, false, String(status));
    assert.ok(codes(r).includes(REASON.NIGHT_UNAVAILABLE), String(status));
  }
});
test("status available but isAvailable 0 (host-closed) is unavailable, not inconsistent", () => {
  const r = run({ days: OPEN_NOV.map((d) => (d.date === "2026-11-17" ? { ...d, isAvailable: 0 } : d)) });
  expectOnly(r, REASON.NIGHT_UNAVAILABLE);
});
test("isAvailable true/false booleans are accepted like 1/0", () => {
  expectOk(run({ days: OPEN_NOV.map((d) => ({ ...d, isAvailable: true })) }));
  expectOnly(run({ days: OPEN_NOV.map((d) => (d.date === "2026-11-17" ? { ...d, isAvailable: false } : d)) }), REASON.NIGHT_UNAVAILABLE);
});

// ---------- 6. min / max stay ----------
test("arrival night minimumStay 3 with a 2-night request -> MIN_STAY required 3; 3 nights ok", () => {
  const days = OPEN_NOV.map((d) => (d.date === "2026-11-16" ? { ...d, minimumStay: 3 } : d));
  const r = run({ days, from: "2026-11-16", to: "2026-11-18" });
  expectOnly(r, REASON.MIN_STAY);
  assert.equal(r.reasons[0].required, 3);
  expectOk(run({ days, from: "2026-11-16", to: "2026-11-19" }));
});
test("listing minNights 2 with a 1-night request -> MIN_STAY", () => {
  expectOnly(run({ listing: { ...LISTINGS[603564], minNights: 2 }, from: "2026-11-16", to: "2026-11-17" }), REASON.MIN_STAY);
});
test("arrival night maximumStay 2 with a 3-night request -> MAX_STAY allowed 2", () => {
  const days = OPEN_NOV.map((d) => (d.date === "2026-11-16" ? { ...d, maximumStay: 2 } : d));
  const r = run({ days });
  expectOnly(r, REASON.MAX_STAY);
  assert.equal(r.reasons[0].allowed, 2);
});
test("listing maxNights 2 with a 3-night request -> MAX_STAY", () => {
  expectOnly(run({ listing: { ...LISTINGS[603564], maxNights: 2 } }), REASON.MAX_STAY);
});
test("minimumStay on a non-arrival night does not apply", () => {
  expectOk(run({ days: OPEN_NOV.map((d) => (d.date === "2026-11-17" ? { ...d, minimumStay: 7 } : d)) }));
});

// ---------- 7/8. arrival / departure closures ----------
test("closedOnArrival on the check-in date -> CLOSED_ON_ARRIVAL; on other dates ignored", () => {
  expectOnly(run({ days: OPEN_NOV.map((d) => (d.date === "2026-11-16" ? { ...d, closedOnArrival: 1 } : d)) }), REASON.CLOSED_ON_ARRIVAL);
  expectOk(run({ days: OPEN_NOV.map((d) => (d.date !== "2026-11-16" ? { ...d, closedOnArrival: 1 } : d)) }));
});
test("closedOnDeparture on the check-out date -> CLOSED_ON_DEPARTURE; on occupied nights ignored", () => {
  expectOnly(run({ days: OPEN_NOV.map((d) => (d.date === "2026-11-19" ? { ...d, closedOnDeparture: 1 } : d)) }), REASON.CLOSED_ON_DEPARTURE);
  expectOk(run({ days: OPEN_NOV.map((d) => (d.date !== "2026-11-19" ? { ...d, closedOnDeparture: 1 } : d)) }));
});
test("the check-out day itself may be blocked (only its closedOnDeparture flag matters)", () => {
  expectOk(run({ days: OPEN_NOV.map((d) => (d.date === "2026-11-19" ? { ...d, ...blocked } : d)) }));
});
test("check-out day missing from the calendar -> CALENDAR_INCOMPLETE (fail closed)", () => {
  const r = run({ days: OPEN_NOV.filter((d) => d.date !== "2026-11-19") });
  expectOnly(r, REASON.CALENDAR_INCOMPLETE);
  assert.equal(r.reasons[0].missingDepartureDay, "2026-11-19");
});

// ---------- 9. incomplete / duplicate / inconsistent / stale ----------
test("a missing occupied night -> CALENDAR_INCOMPLETE naming the night", () => {
  const r = run({ days: OPEN_NOV.filter((d) => d.date !== "2026-11-17") });
  expectOnly(r, REASON.CALENDAR_INCOMPLETE);
  assert.deepEqual(r.reasons[0].missingNights, ["2026-11-17"]);
});
test("empty, undefined or non-array calendar -> never bookable", () => {
  for (const days of [[], undefined, null, {}, "2026-11-16"]) {
    const r = run({ days });
    assert.equal(r.bookable, false);
    assert.ok(codes(r).some((c) => c === REASON.CALENDAR_INCOMPLETE || c === REASON.CALENDAR_INCONSISTENT), JSON.stringify(days));
  }
});
test("duplicate day objects -> CALENDAR_INCONSISTENT even when both say available", () => {
  const r = run({ days: [...OPEN_NOV, day("2026-11-17")] });
  assert.equal(r.bookable, false);
  assert.ok(codes(r).includes(REASON.CALENDAR_INCONSISTENT));
});
test("malformed day entries -> CALENDAR_INCONSISTENT", () => {
  for (const bad of [null, 42, { status: "available", isAvailable: 1 }, { date: "11/17/2026", status: "available", isAvailable: 1 }]) {
    const r = run({ days: [...OPEN_NOV, bad] });
    assert.equal(r.bookable, false, JSON.stringify(bad));
    assert.ok(codes(r).includes(REASON.CALENDAR_INCONSISTENT), JSON.stringify(bad));
  }
});
test("status reserved with isAvailable 1 (contradictory) -> inconsistent AND unavailable", () => {
  const r = run({ days: OPEN_NOV.map((d) => (d.date === "2026-11-17" ? { ...d, status: "reserved", isAvailable: 1 } : d)) });
  assert.equal(r.bookable, false);
  assert.ok(codes(r).includes(REASON.CALENDAR_INCONSISTENT));
  assert.ok(codes(r).includes(REASON.NIGHT_UNAVAILABLE));
});
test("stale calendar (older than policy) -> CALENDAR_STALE; fresh passes; unknown age fails closed", () => {
  const r = run({ calendarFetchedAt: NOW - DEFAULT_POLICY.maxCalendarAgeMs - 1 });
  expectOnly(r, REASON.CALENDAR_STALE);
  expectOk(run({ calendarFetchedAt: NOW - DEFAULT_POLICY.maxCalendarAgeMs }));
  expectOnly(run({ calendarFetchedAt: undefined }), REASON.CALENDAR_STALE);
  expectOnly(run({ now: undefined }), REASON.CALENDAR_STALE);
  expectOnly(run({ calendarFetchedAt: NOW + 60000 }), REASON.CALENDAR_STALE); // from the future = clock problem
});
test("policy override: maxCalendarAgeMs 10 s", () => {
  expectOnly(run({ calendarFetchedAt: NOW - 11000, policy: { maxCalendarAgeMs: 10000 } }), REASON.CALENDAR_STALE);
});

// ---------- multiple failures are all reported ----------
test("all failing rules are reported together (capacity + blocked night + closed departure)", () => {
  const days = NOV_BLOCK_1.map((d) => (d.date === "2026-11-12" ? { ...d, closedOnDeparture: 1 } : d));
  const r = run({ days, from: "2026-11-09", to: "2026-11-12", guests: 3 });
  assert.equal(r.bookable, false);
  assert.deepEqual(codes(r), [REASON.CAPACITY_EXCEEDED, REASON.NIGHT_UNAVAILABLE, REASON.CLOSED_ON_DEPARTURE]);
  for (const x of r.reasons) assert.equal(typeof x.message, "string");
});

// ---------- immutability ----------
test("inputs are not mutated and the result is frozen", () => {
  const days = OPEN_NOV.map((d) => Object.freeze({ ...d }));
  const shuffled = Object.freeze([...days].reverse());
  const listing = Object.freeze({ ...LISTINGS[603564] });
  const before = JSON.stringify({ shuffled, listing });
  const r = run({ days: shuffled, listing });
  expectOk(r);
  assert.equal(JSON.stringify({ shuffled, listing }), before);
  assert.ok(Object.isFrozen(r) && Object.isFrozen(r.reasons) && Object.isFrozen(r.stay));
});
test("garbage input never throws and is never bookable", () => {
  for (const bad of [undefined, null, 1, "x", [], {}]) {
    const r = evaluateStay(bad);
    assert.equal(r.bookable, false);
  }
});
