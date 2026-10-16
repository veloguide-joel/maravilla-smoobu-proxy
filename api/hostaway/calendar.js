// GET /api/hostaway/calendar?id=<pilotId>&from=YYYY-MM-DD&to=YYYY-MM-DD
// Stage C read-only diagnostic (owner-authorized 2026-10-16).
//
// Upstream: GET /v1/listings/{id}/calendar?startDate&endDate  (Hostaway docs,
// section "Retrieve a calendar"). One "calendar day object" per NIGHT.
//
// Safety:
//  - Same auth gate as Stages A/B. Pilot ids only. Range <= 90 nights.
//  - includeResources is deliberately NOT sent (default 0). Per the docs the
//    per-day `reservations` array is then always empty, so no guest name,
//    email, phone, picture or booking reference can ever reach this function.
//    `reservations` and `note` are stripped from the output regardless.
//  - Read-only. No calendar writes, rates, reservations, DB.
//
// Semantics (docs example: a Jul 15 -> Jul 16 reservation marks only Jul 15
// "reserved"): each day = the night starting that date. Normalized ranges are
// therefore arrival-inclusive / departure-exclusive: departure = last blocked
// night + 1 day. This is exactly how consumer/booking-test.html consumes
// { arrival, departure } (it iterates d = arrival; d < departure).

import { getHostawayEnvStatus, hostawayGet } from "../../lib/hostaway.js";
import { requireDiagKey } from "../../lib/diag-auth.js";

const PILOT_LISTING_IDS = new Set([603564, 603566]);
const MAX_NIGHTS = 90;

// Hostaway "Calendar day statuses" dictionary -> our coarse categories.
const STATUS_KIND = {
  available: "open",
  reserved: "booking",     // blocked by reservation
  pending: "pending",      // has pending reservation
  blocked: "manual",       // manual block
  hardBlock: "manual",     // "reserved for future usage" per docs; treat as manual block
  mblocked: "manual",      // deprecated multi-unit block
  mreserved: "booking",    // deprecated multi-unit reservation
  conflicted: "manual"     // deprecated; never treat as open
};

const DAY_FIELD_WHITELIST = [
  "date", "status", "isAvailable", "minimumStay", "maximumStay",
  "closedOnArrival", "closedOnDeparture", "price"
];

function parseListingId(q) {
  const v = Array.isArray(q) ? q[0] : q;
  if (typeof v !== "string" || !/^\d{1,12}$/.test(v)) return null;
  return Number(v);
}
function parseISODate(q) {
  const v = Array.isArray(q) ? q[0] : q;
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const [y, m, d] = v.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return v;
}
function addDays(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}
function nightsBetween(fromIso, toIso) {
  const a = Date.UTC(...fromIso.split("-").map((x, i) => (i === 1 ? Number(x) - 1 : Number(x))));
  const b = Date.UTC(...toIso.split("-").map((x, i) => (i === 1 ? Number(x) - 1 : Number(x))));
  return Math.round((b - a) / 86400000);
}
function describeType(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return `array(${v.length})`;
  return typeof v;
}
function keyTypes(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const out = {};
  for (const k of Object.keys(obj).sort()) out[k] = describeType(obj[k]);
  return out;
}

/** Classify one upstream day into { kind, reasons[] }. */
function classify(day) {
  const status = typeof day.status === "string" ? day.status : "unknown";
  const kind = STATUS_KIND[status] ?? "unknown";
  const isAvail = day.isAvailable === 1 || day.isAvailable === true;
  // A day can be status "available" yet isAvailable=0 (closed by the host).
  if (kind === "open" && !isAvail) return { kind: "closed", status };
  if (kind === "open") return { kind: "open", status };
  return { kind, status };
}

/**
 * Collapse consecutive nights of the same non-open kind into ranges.
 * arrival = first blocked night; departure = day after the last blocked night.
 */
function toRanges(days) {
  const ranges = [];
  let cur = null;
  for (const d of days) {
    if (d.kind === "open") {
      if (cur) { ranges.push(cur); cur = null; }
      continue;
    }
    if (cur && cur.kind === d.kind && addDays(cur.lastNight, 1) === d.date) {
      cur.lastNight = d.date;
      cur.nights += 1;
    } else {
      if (cur) ranges.push(cur);
      cur = { kind: d.kind, arrival: d.date, lastNight: d.date, nights: 1 };
    }
  }
  if (cur) ranges.push(cur);
  return ranges.map((r) => ({ kind: r.kind, arrival: r.arrival, departure: addDays(r.lastNight, 1), nights: r.nights }));
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.status(405).json({ ok: false, error: "METHOD_NOT_ALLOWED" });
    return;
  }
  if (!requireDiagKey(req, res)) return;

  const id = parseListingId(req.query?.id);
  if (id === null) { res.status(400).json({ ok: false, error: "INVALID_LISTING_ID" }); return; }
  if (!PILOT_LISTING_IDS.has(id)) { res.status(404).json({ ok: false, error: "LISTING_NOT_IN_PILOT" }); return; }

  const from = parseISODate(req.query?.from);
  const to = parseISODate(req.query?.to);
  if (!from || !to) { res.status(400).json({ ok: false, error: "INVALID_DATE", expected: "from=YYYY-MM-DD&to=YYYY-MM-DD" }); return; }
  const span = nightsBetween(from, to);
  if (span < 0) { res.status(400).json({ ok: false, error: "DATE_RANGE_INVERTED" }); return; }
  // from..to inclusive = span + 1 nights; cap that at MAX_NIGHTS.
  if (span + 1 > MAX_NIGHTS) { res.status(400).json({ ok: false, error: "DATE_RANGE_TOO_LONG", maxNights: MAX_NIGHTS }); return; }

  const env = getHostawayEnvStatus();
  if (!env.ok) { res.status(500).json({ ok: false, error: "HOSTAWAY_ENV_MISSING", missing: env.missing }); return; }

  try {
    // NOTE: no includeResources -> reservations[] is empty upstream (docs).
    const { status, json, tokenSource, retried } = await hostawayGet(`/listings/${id}/calendar`, {
      query: { startDate: from, endDate: to }
    });

    if (status < 200 || status >= 300 || !json) {
      res.status(502).json({ ok: false, error: "HOSTAWAY_UPSTREAM_FAILED", upstream: { status } });
      return;
    }
    const rawDays = Array.isArray(json) ? json : Array.isArray(json.result) ? json.result : null;
    if (!rawDays) {
      res.status(502).json({ ok: false, error: "HOSTAWAY_UPSTREAM_UNEXPECTED_SHAPE", upstream: { status }, _schema: { wrapperKeys: keyTypes(json) } });
      return;
    }

    // Sanitize + classify. Explicitly drop `reservations`, `note`, ids.
    const days = rawDays
      .filter((d) => d && typeof d.date === "string")
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
      .map((d) => {
        const out = {};
        for (const f of DAY_FIELD_WHITELIST) out[f] = Object.prototype.hasOwnProperty.call(d, f) ? d[f] : null;
        const c = classify(d);
        out.kind = c.kind;
        return out;
      });

    const statusCounts = {};
    const kindCounts = {};
    for (const d of days) {
      statusCounts[d.status ?? "null"] = (statusCounts[d.status ?? "null"] || 0) + 1;
      kindCounts[d.kind] = (kindCounts[d.kind] || 0) + 1;
    }

    const ranges = toRanges(days);
    const restrictions = {
      closedOnArrival: days.filter((d) => d.closedOnArrival === 1 || d.closedOnArrival === true).map((d) => d.date),
      closedOnDeparture: days.filter((d) => d.closedOnDeparture === 1 || d.closedOnDeparture === true).map((d) => d.date),
      minimumStayGt1: days.filter((d) => Number(d.minimumStay) > 1).map((d) => ({ date: d.date, minimumStay: d.minimumStay }))
    };

    const firstRaw = rawDays[0] || null;
    const upstreamReservationsSeen = rawDays.some((d) => Array.isArray(d?.reservations) && d.reservations.length > 0);
    const upstreamNotesSeen = rawDays.some((d) => typeof d?.note === "string" && d.note.length > 0);

    res.status(200).json({
      ok: true,
      listingId: id,
      range: { from, to, nightsRequested: span + 1, nightsReturned: days.length },
      summary: { byStatus: statusCounts, byKind: kindCounts },
      // Modal-compatible: arrival inclusive, departure exclusive. `kind` keeps
      // booking vs pending vs manual vs closed distinct.
      blockedRanges: ranges,
      restrictions,
      days,
      _schema: {
        wrapperKeys: Array.isArray(json) ? "(bare array)" : keyTypes(json),
        dayKeys: keyTypes(firstRaw),
        upstreamReservationsArrayNonEmpty: upstreamReservationsSeen, // expected false (no includeResources)
        upstreamNotesPresent: upstreamNotesSeen,                       // stripped either way
        statusDictionary: Object.keys(STATUS_KIND)
      },
      _meta: { upstreamStatus: status, tokenSource, retriedAfterAuthError: retried }
    });
  } catch (err) {
    const code = err?.code || "HOSTAWAY_REQUEST_FAILED";
    const httpStatus = code === "HOSTAWAY_ENV_MISSING" ? 500 : 502;
    const payload = { ok: false, error: code };
    if (err?.upstreamStatus) payload.upstream = { status: err.upstreamStatus };
    if (err?.missing) payload.missing = err.missing;
    console.error("[hostaway/calendar] failed", { code, upstreamStatus: err?.upstreamStatus ?? null });
    res.status(httpStatus).json(payload);
  }
}
