import { pool } from "../_db.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "METHOD_NOT_ALLOWED" });
    return;
  }

  try {
    const result = await pool.query(
      "INSERT INTO public.booking_intents " +
        "(property_id, unit_id, check_in, check_out, guests, customer_email, customer_name, status, hold_expires_at, currency, amount_total, last_error) " +
        "VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now() + interval '24 hours',$9,$10,$11) " +
        "RETURNING id, created_at, property_id, unit_id, check_in, check_out, status, hold_expires_at",
      [
        "TEST123",
        "UNIT_TEST_A",
        "2026-03-01",
        "2026-03-10",
        2,
        "test@example.com",
        "Test User",
        "hold",
        "USD",
        12345,
        null
      ]
    );

    res.status(200).json({ ok: true, inserted: result.rows[0] || null });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({
      ok: false,
      error: "DB_INSERT_FAILED",
      detail: err?.message || String(err)
    });
  }
}
