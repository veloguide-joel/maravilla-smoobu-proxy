import { pool } from "../_db.js";

// Helper: Parse and validate date in YYYY-MM-DD format
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

// Action: Get active holds
async function handleActive(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.status(405).json({ ok: false, error: "METHOD_NOT_ALLOWED" });
    return;
  }

  try {
    const result = await pool.query(
      "SELECT * FROM booking_intents " +
        "WHERE status IN ('hold','confirmed') " +
        "AND (hold_expires_at IS NULL OR hold_expires_at > NOW()) " +
        "ORDER BY created_at DESC"
    );

    res.status(200).json({ ok: true, holds: result.rows });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: "ACTIVE_HOLDS_FAILED",
      detail: err?.message || "Unknown error"
    });
  }
}

// Action: Create a new hold
async function handleCreate(req, res) {
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

  if (body.expiresInDays !== undefined && !Number.isInteger(body.expiresInDays)) {
    res.status(400).json({ ok: false, error: "INVALID_EXPIRES_IN_DAYS" });
    return;
  }

  const expiresInDays = body.expiresInDays ?? 1;
  if (expiresInDays < 1) {
    res.status(400).json({ ok: false, error: "INVALID_EXPIRES_IN_DAYS" });
    return;
  }

  const expiresAt = new Date(
    Date.now() + expiresInDays * 24 * 60 * 60 * 1000
  ).toISOString();

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

    const guests = Number.isInteger(body.guests) && body.guests >= 1 ? body.guests : 1;

    const result = await pool.query(
      "INSERT INTO booking_intents " +
        "(property_id, unit_id, check_in, check_out, guests, customer_email, customer_name, status, hold_expires_at) " +
        "VALUES ($1,$2,$3,$4,$5,$6,$7,'hold',$8) " +
        "RETURNING id, created_at, property_id, unit_id, check_in, check_out, guests, customer_email, customer_name, status, hold_expires_at",
      [
        body.propertyId,
        body.unitId,
        body.from,
        body.to,
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
    res.status(500).json({
      ok: false,
      error: "DB_INSERT_FAILED",
      detail: err?.message || String(err)
    });
  }
}

// Action: Release a hold
async function handleRelease(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "METHOD_NOT_ALLOWED" });
    return;
  }

  const body = req.body || {};

  if (!body.id) {
    res.status(400).json({ ok: false, error: "MISSING_FIELDS", missing: ["id"] });
    return;
  }

  try {
    const result = await pool.query(
      "UPDATE booking_intents " +
        "SET status = 'cancelled', hold_expires_at = NULL, updated_at = NOW() " +
        "WHERE id = $1 " +
        "RETURNING id, created_at, updated_at, property_id, unit_id, check_in, check_out, guests, customer_email, customer_name, status, hold_expires_at",
      [body.id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ ok: false, error: "NOT_FOUND" });
      return;
    }

    res.status(200).json({
      ok: true,
      released: result.rows[0]
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: "DB_UPDATE_FAILED",
      detail: err?.message || String(err)
    });
  }
}

// Main handler
export default async function handler(req, res) {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  // Handle preflight
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  // Get action from query parameter
  const url = new URL(req.url, `http://${req.headers.host}`);
  const action = url.searchParams.get("action");

  if (!action) {
    res.status(400).json({ ok: false, error: "MISSING_ACTION" });
    return;
  }

  // Route to appropriate handler
  switch (action) {
    case "active":
      await handleActive(req, res);
      break;
    case "create":
      await handleCreate(req, res);
      break;
    case "release":
      await handleRelease(req, res);
      break;
    default:
      res.status(400).json({ ok: false, error: "UNKNOWN_ACTION", action });
      break;
  }
}
