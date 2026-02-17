import { pool } from "../_db.js";
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2022-11-15" });

function parseDateInput(input) {
  if (!input) return null;
  // Accept YYYY-MM-DD as UTC midnight
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    return new Date(input + "T00:00:00.000Z");
  }
  // Accept ISO or other formats
  const d = new Date(input);
  return isNaN(d) ? null : d;
}

export default async function handler(req, res) {
  const requestId = req.headers["x-request-id"] || undefined;
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "METHOD_NOT_ALLOWED" });
    return;
  }
  let body = req.body || {};
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  // Normalize input
  const unitId = body.unitId ?? body.propertyId;
  const from = body.from ?? body.checkin;
  const to = body.to ?? body.checkout;
  const guests = body.guests;
  const customerEmail = body.customerEmail || null;
  const customerName = body.customerName || null;
  const holdId = body.holdId;

  // Validate required fields
  const errors = [];
  if (!unitId) errors.push("unitId/propertyId required");
  if (!from) errors.push("from/checkin required");
  if (!to) errors.push("to/checkout required");
  if (!guests) errors.push("guests required");
  const parsedFrom = parseDateInput(from);
  const parsedTo = parseDateInput(to);
  if (!parsedFrom) errors.push("Invalid from/checkin date");
  if (!parsedTo) errors.push("Invalid to/checkout date");
  if (parsedFrom && parsedTo && parsedFrom >= parsedTo) errors.push("from/checkin must be before to/checkout");
  if (errors.length) {
    res.status(400).json({ ok: false, error: "INVALID_INPUT", details: errors });
    return;
  }

  try {
    // Insert hold
    const insertResult = await pool.query(
      `INSERT INTO booking_intents
        (property_id, unit_id, check_in, check_out, guests, customer_email, customer_name, status, hold_expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'hold', now() + interval '10 minutes')
       RETURNING *`,
      [unitId, unitId, parsedFrom, parsedTo, guests, customerEmail, customerName]
    );
    const inserted = insertResult.rows[0];
    if (!inserted) throw new Error("INSERT_FAILED");

    // Stripe Checkout
    const currency = "mxn"; // Change if project uses another currency
    const BOOKING_UI_BASE_URL = process.env.BOOKING_UI_BASE_URL || "http://127.0.0.1:5500";
    const successUrl = `${BOOKING_UI_BASE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = `${BOOKING_UI_BASE_URL}/cancel.html`;
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      success_url: successUrl,
      cancel_url: cancelUrl,
      client_reference_id: inserted.id,
      metadata: {
        holdId: inserted.id,
        propertyId: body.propertyId || null,
        unitId: body.unitId || null,
        from: from || null,
        to: to || null,
        guests: guests || null
      },
      line_items: [
        {
          price_data: {
            currency,
            product_data: { name: "Reservation Deposit" },
            unit_amount: 1000, // 1000 cents = 10.00 MXN
          },
          quantity: 1,
        },
      ],
    });
    console.log("[instant-checkout] created session", {
      id: session.id,
      client_reference_id: session.client_reference_id,
      metadata: session.metadata
    });

    res.status(200).json({
      ok: true,
      holdId: inserted.id,
      expiresAt: inserted.hold_expires_at,
      checkoutUrl: session.url,
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: "INSTANT_CHECKOUT_FAILED",
      requestId,
      message: err?.message,
      stack: process.env.NODE_ENV === "development" ? err?.stack : undefined,
    });
  }
}
