// lib/calendar-public.js — Stage F2 (owner-authorized 2026-10-17).
//
// Pure projection of Hostaway calendar day objects (Stage C contract: one
// object per NIGHT) into the public-safe shape the booking UI consumes.
// No I/O, no env, no clock, no mutation of inputs.
//
// Internally every night is classified (open | closed | booking | pending |
// manual | unknown) exactly as the Stage C diagnostic does; publicly only
// "unavailable" ranges are exposed — the kind never leaves the server.
//
// Fail-closed rules:
//  - a night that is not explicitly status "available" AND isAvailable 1 is
//    unavailable (reserved, pending, blocked, hardBlock, m*, conflicted,
//    unseen strings, undefined, or contradictory flags);
//  - a requested night MISSING from upstream is reported as unavailable AND
//    coverage.complete=false (never silently open);
//  - duplicate or malformed day objects are an integrity failure (ok:false)
//    so the route can answer 502 instead of a possibly wrong calendar.
//
// Semantics: arrival-inclusive / departure-exclusive. A range
// { arrival: A, departure: D } covers nights A .. D-1; D is the first night
// that is open again (or the day after the window ends).

import { parseISODate, addDays, nightIsOpen } from "./bookability.js";

// Same dictionary as api/hostaway/calendar.js (Stage C). Internal only.
export const STATUS_KIND = Object.freeze({
  available: "open",
  reserved: "booking",
  pending: "pending",
  blocked: "manual",
  hardBlock: "manual",
  mblocked: "manual",
  mreserved: "booking",
  conflicted: "manual"
});

const flag = (v) => v === 1 || v === true;
const posOrNull = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);

/** Internal classification of one night (never sent to clients). */
export function classifyNight(day) {
  if (!day || typeof day !== "object") return "unknown";
  const kind = STATUS_KIND[day.status];
  if (kind === undefined) return "unknown";                  // unseen status -> never open
  if (kind === "open") return flag(day.isAvailable) ? "open" : "closed"; // host-closed
  if (flag(day.isAvailable)) return "unknown";               // non-available status but flag says 1: contradictory
  return kind;
}

/** All dates from..to inclusive. */
export function datesInclusive(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/**
 * normalizeCalendar({ rawDays, from, to }) ->
 *   { ok:true, public:{...}, internal:{...} } | { ok:false, error, problems[] }
 *
 * `from`/`to` are the inclusive window of day records requested from Hostaway.
 * The public block treats every day in the window as a night; the UI's
 * check-out day handling (departure-exclusive) is unchanged from today.
 */
export function normalizeCalendar({ rawDays, from, to }) {
  const f = parseISODate(from);
  const t = parseISODate(to);
  if (!f || !t || t < f) return { ok: false, error: "INVALID_WINDOW", problems: ["from/to invalid"] };
  if (!Array.isArray(rawDays)) return { ok: false, error: "NOT_AN_ARRAY", problems: ["rawDays is not an array"] };

  // Integrity: every entry must be an object with a strict, unique date.
  const byDate = new Map();
  const problems = [];
  rawDays.forEach((d, i) => {
    if (!d || typeof d !== "object" || Array.isArray(d)) { problems.push(`entry ${i} not an object`); return; }
    const date = parseISODate(d.date);
    if (!date) { problems.push(`entry ${i} invalid date`); return; }
    if (byDate.has(date)) { problems.push(`duplicate ${date}`); return; }
    byDate.set(date, d);
  });
  if (problems.length) return { ok: false, error: "CALENDAR_INCONSISTENT", problems: problems.slice(0, 5) };

  const window = datesInclusive(f, t);
  const kinds = { open: 0, closed: 0, booking: 0, pending: 0, manual: 0, unknown: 0, missing: 0 };
  const nights = window.map((date) => {
    const day = byDate.get(date);
    if (!day) { kinds.missing += 1; return { date, kind: "missing", open: false, day: null }; }
    const kind = classifyNight(day);
    kinds[kind] += 1;
    // nightIsOpen is the F0 definition; classifyNight agrees by construction, assert anyway.
    const open = kind === "open" && nightIsOpen(day);
    return { date, kind, open, day };
  });

  // Unavailable ranges (merged across kinds; kind stays internal).
  const unavailable = [];
  let cur = null;
  for (const n of nights) {
    if (n.open) { if (cur) { unavailable.push(cur); cur = null; } continue; }
    if (cur && addDays(cur.last, 1) === n.date) { cur.last = n.date; cur.nights += 1; }
    else { if (cur) unavailable.push(cur); cur = { arrival: n.date, last: n.date, nights: 1 }; }
  }
  if (cur) unavailable.push(cur);

  const restrictions = {
    closedOnArrival: nights.filter((n) => n.day && flag(n.day.closedOnArrival)).map((n) => n.date),
    closedOnDeparture: nights.filter((n) => n.day && flag(n.day.closedOnDeparture)).map((n) => n.date),
    minimumStay: nights.filter((n) => n.day && posOrNull(n.day.minimumStay) > 1).map((n) => ({ date: n.date, nights: Number(n.day.minimumStay) })),
    maximumStay: nights.filter((n) => n.day && posOrNull(n.day.maximumStay)).map((n) => ({ date: n.date, nights: Number(n.day.maximumStay) }))
  };

  const unavailableNights = nights.filter((n) => !n.open).length;
  return {
    ok: true,
    public: {
      from: f,
      to: t,
      coverage: {
        daysRequested: window.length,
        daysReturned: window.length - kinds.missing,
        complete: kinds.missing === 0            // false => missing days are reported as unavailable
      },
      unavailable: unavailable.map((r) => ({ arrival: r.arrival, departure: addDays(r.last, 1), nights: r.nights })),
      unavailableNights,
      restrictions
    },
    internal: { kinds, extraDaysOutsideWindow: rawDays.length - (window.length - kinds.missing) }
  };
}

export const PUBLIC_CALENDAR_KEYS = Object.freeze(["ok", "listingId", "checkedAt", "from", "to", "coverage", "unavailable", "unavailableNights", "restrictions"]);
