import cors from "../_cors.js";
import { pool } from "../_db.js";

// Thunder Client example:
// GET http://localhost:3000/api/smoobu/quote?apartmentId=123&arrival=2026-03-01&departure=2026-03-05&adults=2&children=0&currency=MXN

function parseDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }

  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return date;
}

function addDays(date, days) {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function formatDate(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseCount(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return parsed;
}

export default async function handler(req, res) {
  try {
    if (cors(req, res)) {
      return;
    }

    if (req.method !== "GET") {
      res.status(405).json({ ok: false, error: "METHOD_NOT_ALLOWED" });
      return;
    }

    const { apartmentId, arrival, departure } = req.query || {};

    if (!apartmentId || !arrival || !departure) {
      res.status(400).json({ ok: false, error: "MISSING_PARAMS" });
      return;
    }

    const arrivalDate = parseDate(arrival);
    const departureDate = parseDate(departure);
    if (!arrivalDate || !departureDate || departureDate <= arrivalDate) {
      res.status(400).json({ ok: false, error: "INVALID_DATES" });
      return;
    }

    const adults = parseCount(req.query?.adults, 2);
    const children = parseCount(req.query?.children, 0);
    if (adults === null || children === null) {
      res.status(400).json({ ok: false, error: "INVALID_GUESTS" });
      return;
    }

    const currency = typeof req.query?.currency === "string" && req.query.currency.trim()
      ? req.query.currency.trim()
      : "MXN";

    const conflictResult = await pool.query(
      "SELECT " +
        "SUM(CASE WHEN status = 'hold' AND hold_expires_at > now() THEN 1 ELSE 0 END) AS holds, " +
        "SUM(CASE WHEN status IN ('confirmed','paid','booked') THEN 1 ELSE 0 END) AS reservations " +
        "FROM booking_intents " +
        "WHERE unit_id = $1 " +
        "AND (" +
        "(status = 'hold' AND hold_expires_at > now()) " +
        "OR status IN ('confirmed','paid','booked')" +
        ") " +
        "AND $2::date < check_out AND $3::date > check_in",
      [apartmentId, arrival, departure]
    );

    const holds = Number(conflictResult.rows[0]?.holds || 0);
    const reservations = Number(conflictResult.rows[0]?.reservations || 0);

    if (holds > 0 || reservations > 0) {
      res.status(409).json({
        ok: false,
        available: false,
        reason: "DATE_CONFLICT",
        conflicts: { holds, reservations }
      });
      return;
    }

    const apiKey = process.env.SMOOBU_API_KEY;
    if (!apiKey) {
      res.status(500).json({ ok: false, error: "SMOOBU_KEY_MISSING" });
      return;
    }

    const startDate = formatDate(arrivalDate);
    const endDate = formatDate(addDays(departureDate, -1));
    const upstreamUrl = `https://login.smoobu.com/api/rates?start_date=${encodeURIComponent(startDate)}&end_date=${encodeURIComponent(endDate)}&apartments%5B%5D=${encodeURIComponent(String(apartmentId))}`;
    const safeUpstreamUrl = upstreamUrl;

    let response = null;
    try {
      response = await fetch(upstreamUrl, {
        headers: {
          "Api-Key": apiKey,
          "Accept": "application/json"
        }
      });
    } catch (fetchError) {
      res.status(502).json({
        ok: false,
        error: "SMOOBU_UPSTREAM_FAILED",
        upstream: {
          status: null,
          statusText: null
        },
        request: {
          url: safeUpstreamUrl,
          method: "GET"
        }
      });
      return;
    }

    if (!response.ok) {
      res.status(502).json({
        ok: false,
        error: "SMOOBU_UPSTREAM_FAILED",
        upstream: {
          status: Number.isFinite(response.status) ? response.status : null,
          statusText: typeof response.statusText === "string" ? response.statusText : null
        },
        request: {
          url: safeUpstreamUrl,
          method: "GET"
        }
      });
      return;
    }

    const upstreamText = await response.text();
    let upstreamJson = null;
    try {
      upstreamJson = upstreamText ? JSON.parse(upstreamText) : null;
    } catch (parseError) {
      res.status(502).json({ ok: false, error: "SMOOBU_UPSTREAM_INVALID" });
      return;
    }

    const prices =
      (upstreamJson && upstreamJson.data && upstreamJson.data[String(apartmentId)]) ||
      (upstreamJson && upstreamJson.data && upstreamJson.data[apartmentId]) ||
      null;

    if (!prices) {
      res.status(200).json({ ok: true, available: false, source: "smoobu" });
      return;
    }

    const nights = [];
    for (let cursor = arrivalDate; cursor < departureDate; cursor = addDays(cursor, 1)) {
      nights.push(formatDate(cursor));
    }

    const nightly = [];
    for (const night of nights) {
      const entry = prices[night];
      if (!entry || entry.available !== 1 || !Number.isFinite(entry.price)) {
        res.status(200).json({ ok: true, available: false, source: "smoobu" });
        return;
      }
      nightly.push({ date: night, price: Number(entry.price) });
    }

    const subtotal = nightly.reduce((sum, item) => sum + item.price, 0);
    const total = subtotal;

    res.status(200).json({
      ok: true,
      available: true,
      source: "smoobu",
      apartmentId: String(apartmentId),
      arrival: formatDate(arrivalDate),
      departure: formatDate(departureDate),
      nights: nights.length,
      currency,
      quote: {
        subtotal,
        taxes: null,
        fees: null,
        total
      },
      raw: {
        nightly,
        adults,
        children
      }
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: "QUOTE_FAILED",
      detail: err?.message || "Unknown error"
    });
  }
}
