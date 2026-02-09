import { pool } from "../_db.js";

export default async function handler(req, res) {
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

  try {
    const existingResult = await pool.query(
      "SELECT * FROM holds WHERE id = $1",
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

    const updatedResult = await pool.query(
      "UPDATE holds " +
        "SET status = 'confirmed', confirmed_at = now(), hold_expires_at = NULL " +
        "WHERE id = $1 " +
        "RETURNING *",
      [holdId]
    );

    res.status(200).json({ ok: true, confirmed: true, hold: updatedResult.rows[0] });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: "DB_UPDATE_FAILED",
      detail: err?.message || String(err)
    });
  }
}
