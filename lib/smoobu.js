import { pool } from "../api/_db.js";

export async function createSmoobuReservationForBookingIntentId({ bookingIntentId }) {
  // 1. Fetch booking intent
  const selectResult = await pool.query(
    `SELECT id, status, unit_id, check_in, check_out, smoobu_reservation_id, customer_name, customer_email FROM booking_intents WHERE id = $1`,
    [bookingIntentId]
  );
  const row = selectResult.rows[0];
  if (!row) {
    return { ok: false, skipped: true, reason: "NOT_FOUND" };
  }
  if (row.status !== "confirmed") {
    return { skipped: true, reason: "NOT_CONFIRMED" };
  }
  if (row.smoobu_reservation_id !== null) {
    return { skipped: true, reason: "ALREADY_HAS_SMOOBU_ID" };
  }

  const apiKey = process.env.SMOOBU_API_KEY;
  const channelId = process.env.SMOOBU_CHANNEL_ID;
  if (!apiKey || !channelId) {
    const errMsg = !apiKey ? "SMOOBU_API_KEY missing" : "SMOOBU_CHANNEL_ID missing";
    await pool.query(
      `UPDATE booking_intents SET last_error = $2, updated_at = now() WHERE id = $1`,
      [bookingIntentId, errMsg]
    );
    return { ok: false, error: errMsg };
  }


  // Build firstName/lastName from customer_name
  let firstName = "Guest";
  let lastName = "Guest";
  if (typeof row.customer_name === "string" && row.customer_name.trim().length > 0) {
    const tokens = row.customer_name.trim().split(/\s+/);
    firstName = tokens[0] || "Guest";
    lastName = tokens.length > 1 ? tokens.slice(1).join(" ") : "Guest";
  }

  // Require email
  const email = row.customer_email;
  if (!email || typeof email !== "string" || email.trim().length === 0) {
    const errMsg = "CUSTOMER_EMAIL missing";
    await pool.query(
      `UPDATE booking_intents SET last_error = $2, updated_at = now() WHERE id = $1`,
      [bookingIntentId, errMsg]
    );
    return { ok: false, error: errMsg };
  }

  // Prepare Smoobu reservation payload
  const payload = {
    arrivalDate: row.check_in,
    departureDate: row.check_out,
    apartmentId: Number(row.unit_id),
    channelId: Number(channelId),
    firstName,
    lastName,
    email: email.trim()
  };

  let response;
  try {
    response = await fetch("https://login.smoobu.com/api/reservations", {
      method: "POST",
      headers: {
        "Api-Key": apiKey,
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    const errMsg = `SMOOBU_FETCH_FAILED: ${err?.message || err}`;
    await pool.query(
      `UPDATE booking_intents SET last_error = $2, updated_at = now() WHERE id = $1`,
      [bookingIntentId, errMsg]
    );
    return { ok: false, error: errMsg };
  }

  let json = null;
  let status = response?.status;
  let statusText = response?.statusText;
  try {
    json = await response.json();
  } catch (err) {
    // ignore JSON parse error, will handle below
  }

  if (!response?.ok || !json?.id) {
    const snippet = JSON.stringify(json)?.slice(0, 100);
    const errMsg = `SMOOBU_FAIL: status=${status} ${statusText || ""} resp=${snippet}`;
    await pool.query(
      `UPDATE booking_intents SET last_error = $2, updated_at = now() WHERE id = $1`,
      [bookingIntentId, errMsg]
    );
    return { ok: false, error: errMsg, status, response: snippet };
  }

  // Exactly-once update
  const updateResult = await pool.query(
    `UPDATE booking_intents SET smoobu_reservation_id = $2, last_error = NULL, updated_at = now()
     WHERE id = $1 AND smoobu_reservation_id IS NULL
     RETURNING smoobu_reservation_id`,
    [bookingIntentId, json.id]
  );
  const updated = updateResult.rows[0];
  return { ok: true, smoobuReservationId: updated?.smoobu_reservation_id || json.id };
}
