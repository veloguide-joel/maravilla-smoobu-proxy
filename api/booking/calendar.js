// GET /api/booking/calendar?id=<pilot>[&from=YYYY-MM-DD][&to=YYYY-MM-DD]
// Stage F2 public, read-only calendar (owner-authorized 2026-10-17).
//
// Window: from..to INCLUSIVE day records. Default from = today (property time
// zone), to = from + 90 days (91 records: a 90-night stay plus its check-out
// day). Max span 90 days; from may be at most 1 day in the past (time zones).
//
// Output (lib/calendar-public.js): unavailable ranges (arrival-inclusive,
// departure-exclusive), arrival/departure closures, min/max-stay dates,
// coverage. No kind, no price, no reservations, no notes, no diagnostics.
// Missing days inside the window are reported as unavailable with
// coverage.complete=false; integrity problems or upstream failures -> 502,
// never an empty "all available" calendar.
//
// Caching: none (Cache-Control: no-store). Freshness beats the small saving:
// the UI fetches once per modal open, Hostaway allows 200 req/10 s, and a
// stale calendar is exactly the failure this stage exists to prevent.
// CORS: same allowlist as /api/booking/listings (lib/public-api.js).

import { getHostawayEnvStatus } from "../../lib/hostaway.js";
import { PUBLIC_LISTING_IDS } from "../../lib/listing-public.js";
import { fetchCalendarDays } from "../../lib/hostaway-calendar.js";
import { normalizeCalendar, PUBLIC_CALENDAR_KEYS } from "../../lib/calendar-public.js";
import { applyPublicCors, withDeadline, todayInTimeZone } from "../../lib/public-api.js";
import { parseISODate, addDays, nightsBetween } from "../../lib/bookability.js";

const MAX_SPAN_DAYS = 90;        // to - from
const OVERALL_DEADLINE_MS = 20000;

function q(v) { return Array.isArray(v) ? v[0] : v; }

export default async function handler(req, res) {
  const corsAllowed = applyPublicCors(req, res);
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") { res.status(corsAllowed ? 204 : 403).end(); return; }
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, OPTIONS");
    res.status(405).json({ ok: false, error: "METHOD_NOT_ALLOWED" });
    return;
  }

  // --- validation (nothing reaches Hostaway until all pass) ---
  const idRaw = q(req.query?.id);
  if (typeof idRaw !== "string" || !/^\d{1,12}$/.test(idRaw)) { res.status(400).json({ ok: false, error: "INVALID_LISTING_ID" }); return; }
  const id = Number(idRaw);
  if (!PUBLIC_LISTING_IDS.includes(id)) { res.status(404).json({ ok: false, error: "LISTING_NOT_FOUND" }); return; }

  const today = todayInTimeZone();
  const fromRaw = q(req.query?.from);
  const toRaw = q(req.query?.to);
  const from = fromRaw === undefined || fromRaw === "" ? today : parseISODate(fromRaw);
  const to = toRaw === undefined || toRaw === "" ? (from ? addDays(from, MAX_SPAN_DAYS) : null) : parseISODate(toRaw);
  if (!from || !to) { res.status(400).json({ ok: false, error: "INVALID_DATE", expected: "YYYY-MM-DD" }); return; }
  const span = nightsBetween(from, to);
  if (span < 0) { res.status(400).json({ ok: false, error: "DATE_RANGE_INVERTED" }); return; }
  if (span > MAX_SPAN_DAYS) { res.status(400).json({ ok: false, error: "DATE_RANGE_TOO_LONG", maxDays: MAX_SPAN_DAYS }); return; }
  if (from < addDays(today, -1)) { res.status(400).json({ ok: false, error: "DATE_IN_PAST" }); return; }

  const env = getHostawayEnvStatus();
  if (!env.ok) {
    console.error("[booking/calendar] hostaway env missing", { missing: env.missing });
    res.status(503).json({ ok: false, error: "CALENDAR_UNAVAILABLE" });
    return;
  }

  try {
    const fetched = await withDeadline(fetchCalendarDays({ listingId: id, from, to }), OVERALL_DEADLINE_MS, "calendar");
    if (!fetched.ok) {
      console.error("[booking/calendar] upstream problem", { id, error: fetched.error, upstreamStatus: fetched.upstreamStatus ?? null });
      res.status(502).json({ ok: false, error: "CALENDAR_UNAVAILABLE" });
      return;
    }
    const norm = normalizeCalendar({ rawDays: fetched.days, from, to });
    if (!norm.ok) {
      console.error("[booking/calendar] integrity problem", { id, error: norm.error, problems: norm.problems });
      res.status(502).json({ ok: false, error: "CALENDAR_UNAVAILABLE" });
      return;
    }
    if (!norm.public.coverage.complete) {
      console.warn("[booking/calendar] incomplete coverage", { id, from, to, missing: norm.internal.kinds.missing });
    }
    const body = { ok: true, listingId: id, checkedAt: new Date(fetched.fetchedAt).toISOString(), ...norm.public };
    for (const k of Object.keys(body)) {
      if (!PUBLIC_CALENDAR_KEYS.includes(k)) { res.status(502).json({ ok: false, error: "CALENDAR_UNAVAILABLE" }); return; }
    }
    res.status(200).json(body);
  } catch (err) {
    console.error("[booking/calendar] failed", { id, code: err?.code || err?.name || "UNKNOWN", upstreamStatus: err?.upstreamStatus ?? null });
    res.status(502).json({ ok: false, error: "CALENDAR_UNAVAILABLE" });
  }
}
