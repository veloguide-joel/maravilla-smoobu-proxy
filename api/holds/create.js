import { pool } from "../_db.js";

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

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "METHOD_NOT_ALLOWED" });
    return;
  }


  const body = req.body || {};
  // Support legacy + UI payload formats
  const unitId = body.unitId ?? body.propertyId;
  const from = body.from ?? body.checkin;
  const to = body.to ?? body.checkout;

  // Helper: parse date input supporting YYYY-MM-DD and ISO
  function parseDateInput(s) {
    if (typeof s !== "string") return new Date(NaN);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      return new Date(s + "T00:00:00.000Z");
    }
    return new Date(s);
  }
  const missing = [];
  if (!unitId) missing.push("unitId");
  if (!from) missing.push("from");
  if (!to) missing.push("to");
  if (missing.length > 0) {
    res.status(400).json({ ok: false, error: "MISSING_FIELDS", missing });
    return;
  }

  if (body.expiresInDays !== undefined && !Number.isInteger(body.expiresInDays)) {
    res.status(400).json({ ok: false, error: "INVALID_EXPIRES_IN_DAYS" });
    return;
  }

  const expiresInDays = body.expiresInDays ?? 1;
  if (expiresInDays < 1) {
    res.status(400).json({ ok: false, error: "INVALID_EXPIRES_IN_DAYS" });
    return;
  }

  const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString();
  const fromDate = parseDateInput(from);
  const toDate = parseDateInput(to);
  if (isNaN(fromDate) || isNaN(toDate)) {
    res.status(400).json({ ok: false, error: "INVALID_DATES" });
    return;
  }
  if (toDate <= fromDate) {
    res.status(400).json({ ok: false, error: "INVALID_DATES" });
    return;
  }

  // Prevent FUNCTION_INVOCATION_FAILED from hiding the root cause
  const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    const conflictResult = await pool.query(
      "SELECT id FROM booking_intents " +
        "WHERE unit_id = $1 " +
        "AND (" +
        "(status = 'hold' AND hold_expires_at > now()) " +
        "OR status IN ('confirmed','paid','booked')" +
        ") " +
        "AND $2::date < check_out AND $3::date > check_in " +
        "LIMIT 1",
      [body.unitId, body.from, body.to]
    );
    if (conflictResult.rows.length > 0) {
      res.status(409).json({
        ok: false,
        error: "DATE_CONFLICT",
        conflict: true,
        message: "Dates not available"
      });
      return;
    }
    const guests = Number.isInteger(body.guests) && body.guests >= 1 ? body.guests : 1;
    // Always insert property_id and unit_id using normalized unitId
    const result = await pool.query(
      "INSERT INTO booking_intents " +
        "(property_id, unit_id, check_in, check_out, guests, customer_email, customer_name, status, hold_expires_at) " +
        "VALUES ($1,$2,$3,$4,$5,$6,$7,'hold',$8) " +
        "RETURNING id, created_at, property_id, unit_id, check_in, check_out, guests, customer_email, customer_name, status, hold_expires_at",
      [
        unitId, // property_id (never null)
        unitId, // unit_id (always normalized)
        from,
        to,
        guests,
        body.customerEmail || null,
        body.customerName || null,
        expiresAt
      ]
    );
    res.status(200).json({
      ok: true,
      inserted: result.rows[0] || null,
      expiresInDays,
      expiresAt
    });
  } catch (err) {
    // Structured error logging for debugging
    const logPayload = {
      requestId,
      route: "POST /api/holds/create",
      message: err?.message,
      stack: err?.stack,
      code: err?.code,
      upstreamStatus: err?.response?.status,
      upstreamData: err?.response?.data
    };
    console.error("[holds/create] error", logPayload);
    const isLocal = process.env.NODE_ENV !== 'production' || process.env.VERCEL_ENV === 'development' || !process.env.VERCEL;
    const response = { ok: false, requestId, error: "Internal Server Error" };
    if (isLocal) {
      response.debug = {
        message: err?.message,
        stack: err?.stack,
        code: err?.code,
        upstreamStatus: err?.response?.status,
        upstreamData: err?.response?.data
      };
    }
    res.status(500).json(response);
  }
}
