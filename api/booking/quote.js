// GET /api/booking/quote?id=<pilot>&from=YYYY-MM-DD&to=YYYY-MM-DD&guests=N
// Stage F3 public, read-only, bookability-validated quote (owner-authorized
// 2026-10-17).
//
// Core principle: a Hostaway price does not establish that a stay can be
// booked (Stage D proved priceDetails prices blocked nights, over-capacity
// and past stays). Order of operations, each step a hard gate:
//   1. request validation (format + the 90-night API limit)      -> 400/404
//   2. listing constraints from Hostaway (capacity, min/max, currency)
//   3. fresh calendar from..to INCLUSIVE (check-out day for departure rules)
//   4. lib/bookability.js evaluateStay()                          -> 200 available:false, NO quote
//   5. only if bookable: POST priceDetails {startingDate, endingDate,
//      numberOfGuests, version:2}; payload validated by lib/quote-public.js
//   6. 200 available:true with the sanitized breakdown in the LISTING currency
// Upstream failures at any step -> 502 with no availability claim.
//
// Nothing price- or rule-related is client-controlled: the client sends only
// id, dates and guests. Currency comes from the listing, never from the
// request or the pricing payload. No conversion. No caching (no-store).
// CORS: shared allowlist (lib/public-api.js).

import { getHostawayEnvStatus, hostawayGet, hostawayPost } from "../../lib/hostaway.js";
import { PUBLIC_LISTING_IDS } from "../../lib/listing-public.js";
import { fetchCalendarDays } from "../../lib/hostaway-calendar.js";
import { evaluateStay, parseISODate, nightsBetween, DEFAULT_POLICY } from "../../lib/bookability.js";
import { validatePriceDetails, publicReasons, decisionFor, PUBLIC_QUOTE_KEYS, QUOTE_NOTE } from "../../lib/quote-public.js";
import { applyPublicCors, withDeadline, todayInTimeZone } from "../../lib/public-api.js";

const MAX_NIGHTS = DEFAULT_POLICY.maxStayNights; // 90 — API search limit, independent of the listing's 365
const MAX_GUESTS = 10;                           // request sanity only; real capacity comes from the listing
const UPSTREAM_TIMEOUT_MS = 8000;
const OVERALL_DEADLINE_MS = 25000;               // token + listing + calendar + price

function q(v) { return Array.isArray(v) ? v[0] : v; }
function fail(res, status, error, extra) { res.status(status).json({ ok: false, error, ...(extra || {}) }); }

async function fetchListingConstraints(id) {
  const { status, json } = await hostawayGet(`/listings/${id}`, { timeoutMs: UPSTREAM_TIMEOUT_MS });
  if (status < 200 || status >= 300 || !json) return { ok: false, error: "UPSTREAM_STATUS", upstreamStatus: status };
  const raw = json.result && typeof json.result === "object" && !Array.isArray(json.result) ? json.result : null;
  if (!raw || Number(raw.id) !== id) return { ok: false, error: "UNEXPECTED_SHAPE" };
  const currency = typeof raw.currencyCode === "string" && /^[A-Z]{3}$/.test(raw.currencyCode) ? raw.currencyCode : null;
  if (!currency) return { ok: false, error: "NO_CURRENCY" }; // never label money without the listing's currency
  return {
    ok: true,
    currency,
    listing: { id, personCapacity: raw.personCapacity, minNights: raw.minNights, maxNights: raw.maxNights }
  };
}

export default async function handler(req, res) {
  const corsAllowed = applyPublicCors(req, res);
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") { res.status(corsAllowed ? 204 : 403).end(); return; }
  if (req.method !== "GET") { res.setHeader("Allow", "GET, OPTIONS"); fail(res, 405, "METHOD_NOT_ALLOWED"); return; }

  // --- 1. request validation (nothing reaches Hostaway until all pass) ---
  const idRaw = q(req.query?.id);
  if (typeof idRaw !== "string" || !/^\d{1,12}$/.test(idRaw)) { fail(res, 400, "INVALID_LISTING_ID"); return; }
  const id = Number(idRaw);
  if (!PUBLIC_LISTING_IDS.includes(id)) { fail(res, 404, "LISTING_NOT_FOUND"); return; }

  const from = parseISODate(q(req.query?.from));
  const to = parseISODate(q(req.query?.to));
  if (!from || !to) { fail(res, 400, "INVALID_DATE", { expected: "from and to as YYYY-MM-DD" }); return; }
  const nights = nightsBetween(from, to);
  if (nights < 1) { fail(res, 400, "INVALID_DATE_RANGE", { detail: "to must be after from" }); return; }
  if (nights > MAX_NIGHTS) { fail(res, 400, "STAY_TOO_LONG", { maxNights: MAX_NIGHTS }); return; }

  const guestsRaw = q(req.query?.guests);
  if (typeof guestsRaw !== "string" || !/^\d{1,2}$/.test(guestsRaw)) { fail(res, 400, "INVALID_GUESTS", { expected: `integer 1..${MAX_GUESTS}` }); return; }
  const guests = Number(guestsRaw);
  if (guests < 1 || guests > MAX_GUESTS) { fail(res, 400, "INVALID_GUESTS", { expected: `integer 1..${MAX_GUESTS}` }); return; }

  const env = getHostawayEnvStatus();
  if (!env.ok) { console.error("[booking/quote] hostaway env missing", { missing: env.missing }); fail(res, 503, "QUOTE_UNAVAILABLE"); return; }

  const today = todayInTimeZone();
  const base = { listingId: id, from, to, nights, guests };

  try {
    const work = (async () => {
      // Transport/auth/timeout errors thrown by a stage map to that stage's public code.
      const stage = async (label, fn) => {
        try { return await fn(); } catch (err) { return { ok: false, error: err?.code || err?.name || "THROWN", thrown: true, upstreamStatus: err?.upstreamStatus }; }
      };

      // --- 2. listing constraints ---
      const lc = await stage("listing", () => fetchListingConstraints(id));
      if (!lc.ok) { console.error("[booking/quote] listing problem", { id, error: lc.error, upstreamStatus: lc.upstreamStatus ?? null }); return { status: 502, body: { ok: false, error: "LISTING_UNAVAILABLE" } }; }

      // --- 3. fresh calendar, from..to inclusive (check-out day included) ---
      const cal = await stage("calendar", () => fetchCalendarDays({ listingId: id, from, to, timeoutMs: UPSTREAM_TIMEOUT_MS }));
      if (!cal.ok) { console.error("[booking/quote] calendar problem", { id, error: cal.error, upstreamStatus: cal.upstreamStatus ?? null }); return { status: 502, body: { ok: false, error: "AVAILABILITY_UNAVAILABLE" } }; }

      // --- 4. bookability gate ---
      const verdict = evaluateStay({
        listingId: id, allowedListingIds: PUBLIC_LISTING_IDS, listing: lc.listing, days: cal.days,
        from, to, guests, today, now: Date.now(), calendarFetchedAt: cal.fetchedAt
      });
      const checkedAt = new Date(cal.fetchedAt).toISOString();
      if (!verdict.bookable) {
        return {
          status: 200,
          body: { ok: true, available: false, decision: decisionFor(verdict.reasons), ...base, currency: lc.currency, reasons: publicReasons(verdict.reasons), checkedAt }
        };
      }

      // --- 5. authoritative price, only now ---
      const upstreamBody = { startingDate: from, endingDate: to, numberOfGuests: guests, version: 2 };
      const pr = await stage("price", () => hostawayPost(`/listings/${id}/calendar/priceDetails`, upstreamBody, { timeoutMs: UPSTREAM_TIMEOUT_MS }).then((r) => ({ ok: true, ...r })));
      if (!pr.ok || pr.status < 200 || pr.status >= 300 || !pr.json) {
        console.error("[booking/quote] price upstream", { id, error: pr.error ?? null, upstreamStatus: pr.upstreamStatus ?? pr.status ?? null });
        return { status: 502, body: { ok: false, error: "PRICE_UNAVAILABLE" } };
      }
      const price = validatePriceDetails(pr.json);
      if (!price.ok) {
        console.error("[booking/quote] price payload refused", { id, error: price.error });
        return { status: 502, body: { ok: false, error: price.error === "SUM_MISMATCH" ? "PRICE_INCONSISTENT" : "PRICE_UNAVAILABLE" } };
      }

      // --- 6. sanitized quote in the LISTING currency ---
      return {
        status: 200,
        body: {
          ok: true, available: true, decision: "quoted", ...base,
          currency: lc.currency,
          total: price.total,
          nightlyAverage: Math.round((price.total / nights) * 100) / 100,
          breakdown: price.breakdown,
          checkedAt,
          quoteBasis: "hostaway.priceDetails.v2",
          note: QUOTE_NOTE
        }
      };
    })();

    const out = await withDeadline(work, OVERALL_DEADLINE_MS, "quote");
    if (out.status === 200) {
      for (const k of Object.keys(out.body)) if (!PUBLIC_QUOTE_KEYS.includes(k)) { fail(res, 502, "QUOTE_UNAVAILABLE"); return; }
    }
    res.status(out.status).json(out.body);
  } catch (err) {
    console.error("[booking/quote] failed", { id, code: err?.code || err?.name || "UNKNOWN", upstreamStatus: err?.upstreamStatus ?? null });
    fail(res, 502, "QUOTE_UNAVAILABLE");
  }
}
