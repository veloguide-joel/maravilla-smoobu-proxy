
import { pool } from "../api/_db.js";

export async function confirmHoldById({ holdId, stripeSessionId, stripePaymentIntentId, stripeEventId }) {
  if (!holdId || typeof holdId !== "string" || !holdId.trim()) {
    throw new Error("Invalid holdId");
  }
  // Treat dummy values as null
  let sessionId = stripeSessionId;
  if (!sessionId || sessionId === "cs_test_dummy" || sessionId.startsWith("cs_test_dummy")) {
    sessionId = null;
  }
  let paymentIntentId = stripePaymentIntentId;
  if (!paymentIntentId || paymentIntentId === "pi_test_dummy" || paymentIntentId.startsWith("pi_test_dummy")) {
    paymentIntentId = null;
  }
  const result = await pool.query(
    `UPDATE booking_intents
      SET status = 'confirmed',
          stripe_session_id = $2,
          stripe_payment_intent_id = $3,
          stripe_event_id = $4,
          hold_expires_at = NULL,
          updated_at = now()
     WHERE id = $1 AND status = 'hold'
     RETURNING id, status, stripe_session_id, stripe_payment_intent_id, stripe_event_id, updated_at`,
    [holdId, sessionId, paymentIntentId, stripeEventId]
  );
  if (result.rows.length === 0) {
    // No row updated, check what exists
    const check = await pool.query(
      `SELECT id, status, stripe_session_id, stripe_payment_intent_id, updated_at FROM booking_intents WHERE id = $1`,
      [holdId]
    );
    if (check.rows.length === 0) {
      throw new Error("Hold not found");
    }
    const row = check.rows[0];
    if (row.status === 'confirmed') {
      return row;
    }
    throw new Error(`Hold not confirmable: ${row.status}`);
  }
  return result.rows[0];
}


export async function createHold({ propertyId, unitId, from, to, guests, customerEmail, customerName }) {
  const missing = [];
  if (!propertyId) missing.push("propertyId");
  if (!unitId) missing.push("unitId");
  if (!from) missing.push("from");
  if (!to) missing.push("to");
  if (!customerEmail) missing.push("customerEmail");
  if (missing.length > 0) {
    return { ok: false, error: "MISSING_FIELDS", missing };
  }
  // Validate dates
  const fromDate = new Date(from);
  const toDate = new Date(to);
  if (isNaN(fromDate) || isNaN(toDate) || toDate <= fromDate) {
    return { ok: false, error: "INVALID_DATES" };
  }
  guests = Number.isInteger(guests) && guests > 0 ? guests : 2;
  try {
    // Conflict check
    const conflictResult = await pool.query(
      `SELECT id FROM booking_intents
        WHERE unit_id = $1
          AND ((status = 'hold' AND hold_expires_at > now())
               OR status IN ('confirmed','paid','booked'))
          AND $2::date < check_out
          AND $3::date > check_in
        LIMIT 1`,
      [unitId, from, to]
    );
    if (conflictResult.rows.length > 0) {
      return { ok: false, error: "DATE_CONFLICT", conflict: true, message: "Dates not available" };
    }
    // Insert hold
    const result = await pool.query(
      `INSERT INTO booking_intents
        (property_id, unit_id, check_in, check_out, guests, customer_email, customer_name, status, hold_expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'hold', now() + interval '24 hours')
       RETURNING *`,
      [propertyId, unitId, from, to, guests, customerEmail, customerName || null]
    );
    return { ok: true, hold: result.rows[0] };
  } catch (err) {
    return { ok: false, error: "DB_INSERT_FAILED", detail: err?.message || String(err) };
  }
}



