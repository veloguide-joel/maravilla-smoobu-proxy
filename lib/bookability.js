// lib/bookability.js — Stage F0 (owner-authorized 2026-10-17).
//
// Pure, synchronous bookability evaluation for a requested stay. Decides
// whether a stay MAY be offered, independently of Hostaway's priceDetails
// endpoint (which, as verified live on 2026-10-17, prices blocked nights,
// over-capacity and past stays without objection).
//
// Contract:
//   - No I/O: no fetch, no database, no environment variables, no clock.
//     The caller supplies `today` and `now`; this module never reads the clock.
//   - Inputs are never mutated (arrays are copied before sorting).
//   - Fails CLOSED: anything missing, malformed, duplicated, inconsistent or
//     stale yields bookable:false with an explicit reason. There is no code
//     path that returns bookable:true by default.
//   - Reasons are safe for UI messaging: they never expose block kinds
//     (booking vs manual), notes, reservations or any other private data.
//
// Input shapes (taken from the Stage B listing contract and the Stage C
// calendar contract; one calendar day object per NIGHT):
//   listing: { id, personCapacity, minNights, maxNights }
//   days:    [{ date:"YYYY-MM-DD", status, isAvailable, minimumStay, maximumStay,
//               closedOnArrival, closedOnDeparture }]
//            MUST cover from .. to INCLUSIVE: nights from..to-1 are occupied;
//            the `to` day is needed only for its closedOnDeparture flag.
//
// Semantics: arrival-inclusive / departure-exclusive. A stay from F to T
// occupies the nights F, F+1, ..., T-1 and never the night T.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86400000;

export const DEFAULT_POLICY = Object.freeze({
  minLeadDays: 1,          // booking-test.html: sameDayCheckin=false -> earliest arrival is tomorrow
  maxStayNights: 90,       // matches Stage C/D caps
  maxCalendarAgeMs: 120000 // calendar older than 2 minutes is treated as stale
});

export const REASON = Object.freeze({
  INVALID_INPUT: "INVALID_INPUT",
  LISTING_NOT_ALLOWED: "LISTING_NOT_ALLOWED",
  LISTING_DATA_INCOMPLETE: "LISTING_DATA_INCOMPLETE",
  INVALID_GUESTS: "INVALID_GUESTS",
  CAPACITY_EXCEEDED: "CAPACITY_EXCEEDED",
  INVALID_DATES: "INVALID_DATES",
  TOO_SOON: "TOO_SOON",
  STAY_TOO_SHORT: "STAY_TOO_SHORT",
  STAY_TOO_LONG: "STAY_TOO_LONG",
  CALENDAR_STALE: "CALENDAR_STALE",
  CALENDAR_INCONSISTENT: "CALENDAR_INCONSISTENT",
  CALENDAR_INCOMPLETE: "CALENDAR_INCOMPLETE",
  NIGHT_UNAVAILABLE: "NIGHT_UNAVAILABLE",
  MIN_STAY: "MIN_STAY",
  MAX_STAY: "MAX_STAY",
  CLOSED_ON_ARRIVAL: "CLOSED_ON_ARRIVAL",
  CLOSED_ON_DEPARTURE: "CLOSED_ON_DEPARTURE"
});

// Guest-facing wording. Deliberately generic; never mentions why a night is closed.
const MESSAGE = Object.freeze({
  INVALID_INPUT: "The request could not be evaluated.",
  LISTING_NOT_ALLOWED: "This property is not available for online booking.",
  LISTING_DATA_INCOMPLETE: "Property details are temporarily unavailable.",
  INVALID_GUESTS: "Please choose a valid number of guests.",
  CAPACITY_EXCEEDED: "This property sleeps fewer guests than selected.",
  INVALID_DATES: "Please choose valid check-in and check-out dates.",
  TOO_SOON: "The selected check-in date is too soon.",
  STAY_TOO_SHORT: "The stay must be at least one night.",
  STAY_TOO_LONG: "The stay is longer than can be booked online.",
  CALENDAR_STALE: "Availability could not be confirmed. Please try again.",
  CALENDAR_INCONSISTENT: "Availability could not be confirmed. Please try again.",
  CALENDAR_INCOMPLETE: "Availability could not be confirmed. Please try again.",
  NIGHT_UNAVAILABLE: "One or more selected nights are not available.",
  MIN_STAY: "A longer minimum stay applies to these dates.",
  MAX_STAY: "A shorter maximum stay applies to these dates.",
  CLOSED_ON_ARRIVAL: "Check-in is not possible on the selected date.",
  CLOSED_ON_DEPARTURE: "Check-out is not possible on the selected date."
});

// ---------- small pure helpers ----------

export function parseISODate(value) {
  if (typeof value !== "string" || !DATE_RE.test(value)) return null;
  const [y, m, d] = value.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return value;
}

export function addDays(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function nightsBetween(fromIso, toIso) {
  const p = (s) => { const [y, m, d] = s.split("-").map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((p(toIso) - p(fromIso)) / MS_PER_DAY);
}

/** The nights a stay occupies: from .. to-1 (departure-exclusive). */
export function occupiedNights(fromIso, toIso) {
  const out = [];
  for (let d = fromIso; d < toIso; d = addDays(d, 1)) out.push(d);
  return out;
}

const isPosInt = (v) => Number.isInteger(v) && v > 0;
const flag = (v) => v === 1 || v === true; // Hostaway uses 0/1; accept booleans too
const posOrNull = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);

function reason(code, detail) {
  const r = { code, message: MESSAGE[code] };
  if (detail && typeof detail === "object") Object.assign(r, detail);
  return r;
}

/**
 * Index calendar days by date. Returns { byDate, problems[] }.
 * Problems: malformed date, duplicate date, non-object entries. All fatal (fail closed).
 */
function indexDays(days) {
  const byDate = new Map();
  const problems = [];
  if (!Array.isArray(days)) return { byDate, problems: ["days is not an array"] };
  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    if (!d || typeof d !== "object" || Array.isArray(d)) { problems.push(`entry ${i} is not an object`); continue; }
    const date = parseISODate(d.date);
    if (!date) { problems.push(`entry ${i} has an invalid date`); continue; }
    if (byDate.has(date)) { problems.push(`duplicate day ${date}`); continue; }
    byDate.set(date, d);
  }
  return { byDate, problems };
}

/** A night is open only when status says available AND the flag agrees. Anything else is closed. */
export function nightIsOpen(day) {
  if (!day || typeof day !== "object") return false;
  return day.status === "available" && flag(day.isAvailable);
}

/** status/isAvailable disagree -> the data is inconsistent; treated as closed and reported. */
function nightIsInconsistent(day) {
  if (!day || typeof day !== "object") return false;
  const saysAvailable = day.status === "available";
  const flagAvailable = flag(day.isAvailable);
  // "available" with isAvailable 0 is a documented host-closed state (not inconsistent).
  // A non-available status with isAvailable 1 is contradictory.
  return !saysAvailable && flagAvailable;
}

// ---------- main entry point ----------

/**
 * evaluateStay(input) -> { bookable, reasons[], stay, checks }
 *
 * input = {
 *   listingId,                 // requested id (number or numeric string)
 *   allowedListingIds,         // optional iterable of allowed ids (pilot allowlist)
 *   listing,                   // { id, personCapacity, minNights, maxNights }
 *   days,                      // calendar day objects covering from..to inclusive
 *   from, to,                  // "YYYY-MM-DD"
 *   guests,                    // integer
 *   today,                     // "YYYY-MM-DD" in the property's timezone (caller decides)
 *   now,                       // epoch ms, used only for the staleness check
 *   calendarFetchedAt,         // epoch ms when `days` was retrieved
 *   policy                     // optional overrides of DEFAULT_POLICY
 * }
 *
 * Every failing rule is reported (not just the first) so the UI can explain.
 * `bookable` is true only when reasons is empty.
 */
export function evaluateStay(input) {
  const reasons = [];
  if (!input || typeof input !== "object") {
    return finish([reason(REASON.INVALID_INPUT, { field: "input" })], null, null);
  }
  const policy = Object.freeze({ ...DEFAULT_POLICY, ...(input.policy || {}) });

  // --- 1. listing id + allowlist + listing data ---
  const listingId = toListingId(input.listingId);
  if (listingId === null) reasons.push(reason(REASON.INVALID_INPUT, { field: "listingId" }));
  if (listingId !== null && input.allowedListingIds != null) {
    const allowed = new Set(Array.from(input.allowedListingIds, (v) => toListingId(v)).filter((v) => v !== null));
    if (!allowed.has(listingId)) reasons.push(reason(REASON.LISTING_NOT_ALLOWED));
  }
  const listing = input.listing && typeof input.listing === "object" ? input.listing : null;
  let capacity = null, listingMin = null, listingMax = null;
  if (!listing) {
    reasons.push(reason(REASON.LISTING_DATA_INCOMPLETE, { field: "listing" }));
  } else {
    if (listingId !== null && listing.id != null && toListingId(listing.id) !== listingId) {
      reasons.push(reason(REASON.LISTING_DATA_INCOMPLETE, { field: "listing.id", detail: "listing does not match requested id" }));
    }
    capacity = isPosInt(listing.personCapacity) ? listing.personCapacity : null;
    if (capacity === null) reasons.push(reason(REASON.LISTING_DATA_INCOMPLETE, { field: "listing.personCapacity" }));
    listingMin = posOrNull(listing.minNights);  // null -> no listing-level minimum beyond 1
    listingMax = posOrNull(listing.maxNights);  // null -> no listing-level maximum
  }

  // --- guests ---
  const guests = isPosInt(input.guests) ? input.guests : null;
  if (guests === null) reasons.push(reason(REASON.INVALID_GUESTS));
  else if (capacity !== null && guests > capacity) reasons.push(reason(REASON.CAPACITY_EXCEEDED, { maxGuests: capacity }));

  // --- 2. dates ---
  const from = parseISODate(input.from);
  const to = parseISODate(input.to);
  const today = parseISODate(input.today);
  if (!from || !to) reasons.push(reason(REASON.INVALID_DATES, { field: !from ? "from" : "to" }));
  if (!today) reasons.push(reason(REASON.INVALID_INPUT, { field: "today" }));

  let nights = null;
  if (from && to) {
    nights = nightsBetween(from, to);
    if (nights < 1) reasons.push(reason(REASON.STAY_TOO_SHORT));
    else if (nights > policy.maxStayNights) reasons.push(reason(REASON.STAY_TOO_LONG, { maxNights: policy.maxStayNights }));
  }
  if (from && today) {
    const earliest = addDays(today, policy.minLeadDays);
    if (from < earliest) reasons.push(reason(REASON.TOO_SOON, { earliestArrival: earliest }));
  }

  // Date problems make the calendar checks meaningless; stop here (still fail closed).
  if (!from || !to || nights === null || nights < 1 || nights > policy.maxStayNights) {
    return finish(reasons, { listingId, from, to, nights, guests }, null);
  }

  // --- 9. staleness: the caller must say when the calendar was fetched ---
  const now = Number.isFinite(input.now) ? input.now : null;
  const fetchedAt = Number.isFinite(input.calendarFetchedAt) ? input.calendarFetchedAt : null;
  if (now === null || fetchedAt === null) {
    reasons.push(reason(REASON.CALENDAR_STALE, { detail: "calendar age unknown" }));
  } else if (fetchedAt > now + 1000 || now - fetchedAt > policy.maxCalendarAgeMs) {
    reasons.push(reason(REASON.CALENDAR_STALE, { ageMs: now - fetchedAt, maxAgeMs: policy.maxCalendarAgeMs }));
  }

  // --- 9. structural calendar integrity ---
  const { byDate, problems } = indexDays(input.days);
  if (problems.length) reasons.push(reason(REASON.CALENDAR_INCONSISTENT, { problems: problems.slice(0, 5) }));

  // --- 3/4/5. every occupied night present and explicitly open ---
  const nightsList = occupiedNights(from, to);
  const missingNights = [];
  const closedNights = [];
  const inconsistentNights = [];
  for (const n of nightsList) {
    const day = byDate.get(n);
    if (!day) { missingNights.push(n); continue; }
    if (nightIsInconsistent(day)) inconsistentNights.push(n);
    if (!nightIsOpen(day)) closedNights.push(n);
  }
  if (missingNights.length) reasons.push(reason(REASON.CALENDAR_INCOMPLETE, { missingNights: missingNights.slice(0, 5), missingCount: missingNights.length }));
  if (inconsistentNights.length) reasons.push(reason(REASON.CALENDAR_INCONSISTENT, { nights: inconsistentNights.slice(0, 5) }));
  if (closedNights.length) reasons.push(reason(REASON.NIGHT_UNAVAILABLE, { firstUnavailableNight: closedNights[0], unavailableCount: closedNights.length }));

  // --- 6. min / max stay: listing limits AND the arrival night's calendar limits ---
  const arrivalDay = byDate.get(from) || null;
  const dayMin = arrivalDay ? posOrNull(arrivalDay.minimumStay) : null;
  const dayMax = arrivalDay ? posOrNull(arrivalDay.maximumStay) : null;
  const requiredMin = Math.max(1, listingMin ?? 1, dayMin ?? 1);
  const allowedMax = [listingMax, dayMax].filter((v) => v !== null).reduce((a, b) => Math.min(a, b), Infinity);
  if (nights < requiredMin) reasons.push(reason(REASON.MIN_STAY, { required: requiredMin, requested: nights }));
  if (allowedMax !== Infinity && nights > allowedMax) reasons.push(reason(REASON.MAX_STAY, { allowed: allowedMax, requested: nights }));

  // --- 7. closed on arrival (check-in date) ---
  if (arrivalDay && flag(arrivalDay.closedOnArrival)) reasons.push(reason(REASON.CLOSED_ON_ARRIVAL, { date: from }));

  // --- 8. closed on departure (check-out date). The `to` day is not occupied,
  //        but its flag is required: if the caller did not supply it, fail closed.
  const departureDay = byDate.get(to) || null;
  if (!departureDay) reasons.push(reason(REASON.CALENDAR_INCOMPLETE, { missingDepartureDay: to }));
  else if (flag(departureDay.closedOnDeparture)) reasons.push(reason(REASON.CLOSED_ON_DEPARTURE, { date: to }));

  const checks = {
    occupiedNights: nightsList,
    departureDay: to,
    requiredMinNights: requiredMin,
    allowedMaxNights: allowedMax === Infinity ? null : allowedMax,
    capacity,
    calendarAgeMs: now !== null && fetchedAt !== null ? now - fetchedAt : null
  };
  return finish(reasons, { listingId, from, to, nights, guests }, checks);
}

function toListingId(v) {
  if (typeof v === "number" && Number.isInteger(v) && v > 0) return v;
  if (typeof v === "string" && /^\d{1,12}$/.test(v)) return Number(v);
  return null;
}

function finish(reasons, stay, checks) {
  return Object.freeze({
    bookable: reasons.length === 0,
    reasons: Object.freeze(reasons.map((r) => Object.freeze(r))),
    stay: stay ? Object.freeze({ ...stay }) : null,
    checks: checks ? Object.freeze(checks) : null
  });
}
