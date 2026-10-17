// lib/hostaway-calendar.js — Stage F2. The ONE place that reads a Hostaway
// calendar for the public booking routes. Shared by F2 (public calendar) and,
// later, F3 (quote): F3 passes `days` + `fetchedAt` straight into
// lib/bookability.js (which needs from..to INCLUSIVE, i.e. the check-out day).
//
//  - Never sends includeResources (reservations[] stays empty upstream, docs).
//  - Strips `reservations` and `note` before anything else can see them.
//  - Validates the wrapper shape; returns { ok:false, error } on anything odd.
//  - Timeout per request; 401/403 re-mint handled by lib/hostaway.js.

import { hostawayGet } from "./hostaway.js";

export const CALENDAR_TIMEOUT_MS = 8000;

// Only these keys survive. Everything else (note, reservations, unit counters, ids) is dropped.
const DAY_KEYS = ["date", "status", "isAvailable", "minimumStay", "maximumStay", "closedOnArrival", "closedOnDeparture"];

export function sanitizeDay(d) {
  if (!d || typeof d !== "object" || Array.isArray(d)) return null;
  const out = {};
  for (const k of DAY_KEYS) out[k] = Object.prototype.hasOwnProperty.call(d, k) ? d[k] : null;
  return out;
}

/**
 * fetchCalendarDays({ listingId, from, to }) ->
 *   { ok:true, days:[sanitized day objects], fetchedAt:number }
 *   | { ok:false, error:"UPSTREAM_STATUS"|"UNEXPECTED_SHAPE"|"EMPTY", upstreamStatus? }
 * Throws only on transport/auth errors from lib/hostaway.js (caller maps to 502).
 */
export async function fetchCalendarDays({ listingId, from, to, timeoutMs = CALENDAR_TIMEOUT_MS }) {
  const { status, json } = await hostawayGet(`/listings/${listingId}/calendar`, {
    query: { startDate: from, endDate: to }, // no includeResources, ever
    timeoutMs
  });
  const fetchedAt = Date.now();
  if (status < 200 || status >= 300 || !json) return { ok: false, error: "UPSTREAM_STATUS", upstreamStatus: status };
  const raw = Array.isArray(json) ? json : Array.isArray(json.result) ? json.result : null;
  if (!raw) return { ok: false, error: "UNEXPECTED_SHAPE", upstreamStatus: status };
  if (raw.length === 0) return { ok: false, error: "EMPTY", upstreamStatus: status };
  const days = raw.map(sanitizeDay).filter(Boolean);
  return { ok: true, days, fetchedAt };
}
