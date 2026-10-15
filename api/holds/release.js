import { pool } from "../_db.js";

// POST /api/holds/release
// Body: { id } (admin UI) or { holdId } (same convention as /api/holds/confirm)
// Releases a hold manually. Only rows in status 'hold' are affected; confirmed,
// paid or booked intents are never touched. Sets status = 'released' so a manual
// release is distinguishable from a cron 'expired'. The conflict check in
// lib/holds.js already ignores anything that is not an active hold or a
// confirmed/paid/booked intent, so released dates become available again.
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

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      res.status(400).json({ ok: false, error: "INVALID_JSON" });
      return;
    }
  }
  body = body || {};

  const holdId = body.id ?? body.holdId;
  if (!holdId || typeof holdId !== "string" || !holdId.trim()) {
    res.status(400).json({ ok: false, error: "MISSING_FIELDS", missing: ["id"] });
    return;
  }

  try {
    const result = await pool.query(
      `UPDATE booking_intents
          SET status = 'released',
              hold_expires_at = NULL,
              updated_at = now()
        WHERE id = $1 AND status = 'hold'
        RETURNING id, status, unit_id, check_in, check_out, updated_at`,
      [holdId.trim()]
    );

    if (result.rows.length > 0) {
      res.status(200).json({ ok: true, released: result.rows[0] });
      return;
    }

    // Nothing updated: distinguish "not found" from "not in a releasable state".
    const check = await pool.query(
      `SELECT id, status FROM booking_intents WHERE id = $1`,
      [holdId.trim()]
    );
    if (check.rows.length === 0) {
      res.status(404).json({ ok: false, error: "HOLD_NOT_FOUND" });
      return;
    }
    res.status(409).json({
      ok: false,
      error: "HOLD_NOT_RELEASABLE",
      message: `Hold is '${check.rows[0].status}', only 'hold' can be released`,
      status: check.rows[0].status
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: "RELEASE_FAILED",
      detail: err?.message || "Unknown error"
    });
  }
}
