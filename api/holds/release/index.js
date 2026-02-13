import { pool } from "../../_db.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
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
