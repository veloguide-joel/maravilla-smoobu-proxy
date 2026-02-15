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
    // Atomic state transition: only update if id, status, and hold_expires_at are valid
    const columnResult = await pool.query(
      "SELECT 1 FROM information_schema.columns " +
        "WHERE table_name = 'booking_intents' AND column_name = 'hold_expires_at' " +
        "LIMIT 1"
    );

    const setHoldExpires = columnResult.rows.length > 0;
    // Compose atomic update SQL
    let updateSql, updateParams;
    if (setHoldExpires) {
      updateSql =
        "UPDATE booking_intents " +
        "SET status = 'confirmed', hold_expires_at = NULL " +
        "WHERE id = $1 AND status = 'hold' AND (hold_expires_at IS NULL OR hold_expires_at > now()) " +
        "RETURNING *";
      updateParams = [holdId];
    } else {
      updateSql =
        "UPDATE booking_intents " +
        "SET status = 'confirmed' " +
        "WHERE id = $1 AND status = 'hold' " +
        "RETURNING *";
      updateParams = [holdId];
    }

    const updatedResult = await pool.query(updateSql, updateParams);
    const updated = updatedResult.rows[0];
    if (!updated) {
      res.status(409).json({ ok: false, error: "HOLD_NOT_CONFIRMABLE" });
      return;
    }

    res.status(200).json({ ok: true, confirmed: true, hold: updated });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: "DB_UPDATE_FAILED",
      detail: err?.message || String(err),
      table: "booking_intents"
    });
  }
}
