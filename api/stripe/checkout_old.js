import { createHold, updateHold } from "../../lib/holds.js";
import { getQuote } from "../../lib/quote.js";

import Stripe from "stripe";
console.log("[checkout] module loaded");

export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== "POST") {
    res.status(405).json({ error: "method_not_allowed", allowed: ["POST"] });
    return;
  }
  try {
    console.log("[checkout] start", { method: req.method, hasBody: !!req.body, bodyKeys: Object.keys(req.body || {}) });
    console.log("[checkout] env", {
      hasStripeSecretKey: !!process.env.STRIPE_SECRET_KEY,
      hasWebhookSecret: !!process.env.STRIPE_WEBHOOK_SECRET,
      hasBookingUiBaseUrl: !!process.env.BOOKING_UI_BASE_URL
    });
    let body = req.body;
    if (!body || typeof body !== "object") {
      try {
        body = JSON.parse(await new Promise((resolve, reject) => {
          let data = "";
          req.on("data", chunk => { data += chunk; });
          req.on("end", () => resolve(data));
          req.on("error", reject);
        }));
      } catch (e) {
        res.status(400).json({ error: "invalid_json" });
        return;
      }
    }
    // Validate required fields
    const requiredFields = ["propertyId", "checkIn", "checkOut", "guestName", "guestEmail", "amount", "currency", "holdId"];
    const missing = requiredFields.filter(f => !(f in body));
    if (missing.length) {
      res.status(400).json({ error: "missing_fields", missing });
      return;
    }
    const { propertyId, checkIn, checkOut, guestName, guestEmail, amount, currency, holdId } = body;
    // Stripe session creation
    console.log("[checkout] creating stripe session");
    const stripeKey = process.env.STRIPE_SECRET_KEY || process.env.STRIPE_SECRET || process.env.STRIPE_API_KEY;
    if (!stripeKey) {
      res.status(500).json({ error: "missing_env", missing: ["STRIPE_SECRET_KEY"] });
      return;
    }
    const stripe = new Stripe(stripeKey, { apiVersion: "2022-11-15" });
    let session;
    try {
      session = await stripe.checkout.sessions.create({
        mode: "payment",
        customer_email: guestEmail,
        line_items: [
          {
            price_data: {
              currency,
              product_data: {
                name: `Booking ${propertyId} ${checkIn} to ${checkOut}`
              },
              unit_amount: amount
            },
            quantity: 1
          }
        ],
        success_url: `${process.env.SUCCESS_URL}?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: process.env.CANCEL_URL,
        metadata: {
          holdId,
          propertyId,
          checkIn,
          checkOut,
          guestName,
          guestEmail,
          amount,
          currency
        }
      });
    } catch (err) {
      console.error("[checkout] error", err);
      res.status(500).json({
        error: "checkout_failed",
        message: err.message || "unknown",
        type: err.type || null,
        code: err.code || null,
        param: err.param || null,
        rawType: err.rawType || null
      });
      return;
    }
    // Respond (do not change shape)
    res.status(200).json({ ok: true, checkoutUrl: session.url, sessionId: session.id, holdId });
  } catch (err) {
    console.error("[checkout] error", err);
    res.status(500).json({
      error: "checkout_failed",
      message: err.message || "unknown",
      type: err.type || null,
      code: err.code || null,
      param: err.param || null,
      rawType: err.rawType || null
    });
  }
}
