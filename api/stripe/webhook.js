
import { confirmHoldById } from "../../lib/holds.js";
import Stripe from "stripe";

export const config = { api: { bodyParser: false } };

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2026-01-28.clover",
});

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ ok: false, error: "METHOD_NOT_ALLOWED" });
    }

    console.log("[stripe-webhook] hit POST");

    const sig = req.headers["stripe-signature"];
    if (!sig) {
      return res.status(400).json({ ok: false, error: "BAD_SIGNATURE" });
    }

    const rawBody = await getRawBody(req);

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        rawBody,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
      console.log("[stripe-webhook] event", event.type);
    } catch (err) {
      return res.status(400).json({ ok: false, error: "BAD_SIGNATURE" });
    }

    if (event.type !== "checkout.session.completed") {
      return res.status(200).json({ ok: true, ignored: true, type: event.type });
    }

    const session = event.data && event.data.object;
    const holdId = session?.metadata?.holdId || null;
    const stripeSessionId = session?.id || null;
    const stripePaymentIntentId = session?.payment_intent || null;

    // Log required session fields
    console.log("[stripe-webhook] checkout.session.completed", {
      id: session?.id,
      payment_intent: session?.payment_intent,
      metadata: session?.metadata,
      client_reference_id: session?.client_reference_id,
      customer_details_email: session?.customer_details?.email,
      customer_email: session?.customer_email
    });

    if (!holdId) {
      return res.status(200).json({ ok: true, ignored: true, reason: "MISSING_HOLD_ID" });
    }

    try {
      const confirmed = await confirmHoldById({ holdId, stripeSessionId, stripePaymentIntentId });
      return res.status(200).json({ ok: true, version: "WEBHOOK_V2_WITH_CONFIRM", type: event.type });
    } catch (err) {
      console.error("[stripe-webhook] confirmHoldById error", err);
      return res.status(200).json({ ok: true, version: "WEBHOOK_V2_WITH_CONFIRM", type: event.type });
    }
  } catch (err) {
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
}
