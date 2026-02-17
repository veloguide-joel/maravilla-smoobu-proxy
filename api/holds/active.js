import { pool } from "../_db.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  try {
    if (req.method !== "GET" && req.method !== "POST") {
      res.status(405).json({ ok: false, error: "METHOD_NOT_ALLOWED" });
      return;
    }

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
