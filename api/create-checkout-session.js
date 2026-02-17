import Stripe from "stripe";

console.log("[create-checkout-session] module loaded");

export default async function handler(req, res) {
  console.log("[create-checkout-session] handler called");
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed", allowed: ["POST"] });
  }
  try {
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
        return res.status(400).json({ error: "invalid_json" });
      }
    }
    // Validate required fields
    const requiredFields = ["propertyId", "checkIn", "checkOut", "guestName", "guestEmail", "amount", "currency", "holdId"];
    const missing = requiredFields.filter(f => !(f in body));
    if (missing.length) {
      return res.status(400).json({ error: "missing_fields", missing });
    }
    const { propertyId, checkIn, checkOut, guestName, guestEmail, amount, currency, holdId } = body;
    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (!stripeKey) {
      return res.status(500).json({ error: "missing_stripe_key" });
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
      console.error("[create-checkout-session] error", err);
      return res.status(500).json({
        error: "checkout_failed",
        message: err.message || "unknown",
        type: err.type || null,
        code: err.code || null,
        param: err.param || null,
        rawType: err.rawType || null
      });
    }
    // Respond (do not change shape)
    return res.status(200).json({ ok: true, checkoutUrl: session.url, sessionId: session.id, holdId });
  } catch (err) {
    console.error("[create-checkout-session] error", err);
    return res.status(500).json({
      error: "checkout_failed",
      message: err.message || "unknown",
      type: err.type || null,
      code: err.code || null,
      param: err.param || null,
      rawType: err.rawType || null
    });
  }
}
