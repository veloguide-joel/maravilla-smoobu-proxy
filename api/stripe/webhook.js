import Stripe from "stripe";

console.log("[webhook] module loaded");

export const config = {
  api: {
    bodyParser: false, // Needed for raw body signature verification
  },
};

function buffer(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

import { confirmHoldById } from '../../lib/holds.js';

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }
  const stripeSecret = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripeSecret || !webhookSecret) {
    return res.status(500).json({ ok: false, error: "missing_env", missing: [!stripeSecret && "STRIPE_SECRET_KEY", !webhookSecret && "STRIPE_WEBHOOK_SECRET"].filter(Boolean) });
  }
  const stripe = new Stripe(stripeSecret, { apiVersion: "2022-11-15" });
  let event;
  try {
    const sig = req.headers["stripe-signature"];
    const rawBody = await buffer(req);
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
    console.log("[webhook] received", event.type);
  } catch (err) {
    console.error("[webhook] signature verification failed", err.message);
    return res.status(400).json({ ok: false, error: "invalid_signature" });
  }
  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const holdId = session.metadata && session.metadata.holdId;
      if (!holdId) {
        return res.status(400).json({ ok: false, error: "missing_holdId" });
      }
      console.log(`[webhook] confirming hold ${holdId}`);
      try {
        const confirmResult = await confirmHoldById({
          holdId,
          stripeSessionId: session.id,
          stripePaymentIntentId: session.payment_intent || null
        });
        if (confirmResult.ok) {
          console.log(`[webhook] confirmed hold ${holdId}`);
          return res.status(200).json({ ok: true });
        } else {
          return res.status(500).json({ ok: false, error: 'confirm failed' });
        }
      } catch (err) {
        console.error(`[webhook] error confirming hold ${holdId}:`, err.message);
        return res.status(500).json({ ok: false, error: err.message });
      }
      } else {
        return res.status(500).json({ ok: false, error: confirmResult.error || "confirm_failed" });
      }
    }
    // Optionally handle other event types here
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("[webhook] error", err.message);
    return res.status(500).json({ ok: false, error: err.message || "unknown" });
  }
}
