import { pool } from "../_db.js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ ok: false, error: "METHOD_NOT_ALLOWED" });
    return;
  }

  const secret = req.headers["x-cron-secret"];
  if (!secret || secret !== process.env.CRON_SECRET) {
    res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
    return;
  }

  const result = await pool.query(
    `UPDATE booking_intents
     SET status = 'expired',
         updated_at = now()
     WHERE status = 'hold'
       AND hold_expires_at IS NOT NULL
       AND hold_expires_at < now()
     RETURNING id;`
  );

  res.status(200).json({ ok: true, expiredCount: result.rowCount });
}
