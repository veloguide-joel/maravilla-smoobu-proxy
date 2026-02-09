import { pool } from "../_db.js";

export default async function handler(req, res) {
  const adminToken = process.env.ADMIN_TOKEN;
  if (!adminToken) {
    res.status(500).json({ ok: false, error: "ADMIN_TOKEN_NOT_SET" });
    return;
  }

  const providedToken = req.headers["x-admin-token"];
  if (!providedToken || providedToken !== adminToken) {
    res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "METHOD_NOT_ALLOWED" });
    return;
  }

  const body = req.body || {};
  const holdId = body.holdId;

  if (!holdId) {
    res.status(400).json({ ok: false, error: "MISSING_HOLD_ID" });
    return;
  }

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (typeof holdId !== "string" || !uuidRegex.test(holdId)) {
    res.status(400).json({ ok: false, error: "INVALID_HOLD_ID" });
    return;
  }

  try {
    const existingResult = await pool.query(
      "SELECT * FROM booking_intents WHERE id = $1",
      [holdId]
    );

    const existing = existingResult.rows[0];
    if (!existing) {
      res.status(404).json({ ok: false, error: "NOT_FOUND" });
      return;
    }

    if (existing.status === "confirmed" || existing.status === "booked") {
      res.status(200).json({ ok: true, alreadyConfirmed: true, hold: existing });
      return;
    }

    if (existing.status === "hold" && existing.hold_expires_at && existing.hold_expires_at <= new Date()) {
      res.status(410).json({ ok: false, error: "HOLD_EXPIRED" });
      return;
    }

    const columnResult = await pool.query(
      "SELECT 1 FROM information_schema.columns " +
        "WHERE table_name = 'booking_intents' AND column_name = 'hold_expires_at' " +
        "LIMIT 1"
    );

    const setHoldExpires = columnResult.rows.length > 0;
    const updateSql = setHoldExpires
      ? "UPDATE booking_intents SET status = 'confirmed', hold_expires_at = NULL WHERE id = $1 RETURNING *"
      : "UPDATE booking_intents SET status = 'confirmed' WHERE id = $1 RETURNING *";

    const updatedResult = await pool.query(updateSql, [holdId]);

    res.status(200).json({ ok: true, confirmed: true, hold: updatedResult.rows[0] });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: "DB_UPDATE_FAILED",
      detail: err?.message || String(err),
      table: "booking_intents"
    });
  }
}
