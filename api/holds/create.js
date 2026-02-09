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
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "METHOD_NOT_ALLOWED" });
    return;
  }

  const body = req.body || {};
  const missing = [];

  if (!body.propertyId) {
    missing.push("propertyId");
  }
  if (!body.unitId) {
    missing.push("unitId");
  }
  if (!body.from) {
    missing.push("from");
  }
  if (!body.to) {
    missing.push("to");
  }

  if (missing.length > 0) {
    res.status(400).json({ ok: false, error: "MISSING_FIELDS", missing });
    return;
  }

  const fromDate = parseDate(body.from);
  const toDate = parseDate(body.to);
  if (!fromDate || !toDate) {
    res.status(400).json({ ok: false, error: "INVALID_DATES" });
    return;
  }

  if (toDate <= fromDate) {
    res.status(400).json({ ok: false, error: "INVALID_DATES" });
    return;
  }

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

    const result = await pool.query(
      "INSERT INTO booking_intents " +
        "(property_id, unit_id, check_in, check_out, guests, customer_email, customer_name, status, hold_expires_at) " +
        "VALUES ($1,$2,$3,$4,$5,$6,$7,'hold', now() + interval '24 hours') " +
        "RETURNING id, created_at, property_id, unit_id, check_in, check_out, guests, customer_email, customer_name, status, hold_expires_at",
      [
        body.propertyId,
        body.unitId,
        body.from,
        body.to,
        Number.isInteger(body.guests) ? body.guests : null,
        body.customerEmail || null,
        body.customerName || null
      ]
    );

    res.status(200).json({ ok: true, inserted: result.rows[0] || null });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: "DB_INSERT_FAILED",
      detail: err?.message || String(err)
    });
  }
}
