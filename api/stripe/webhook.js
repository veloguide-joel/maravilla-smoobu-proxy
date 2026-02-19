
import { confirmHoldById } from "../../lib/holds.js";
import { createSmoobuReservationForBookingIntentId } from "../../lib/smoobu.js";
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

    const stripeEventId = event.id;
    if (event.type !== "checkout.session.completed") {
      return res.status(200).json({ ok: true });
    }

    const session = event.data && event.data.object;
    const holdId = session?.metadata?.holdId || null;
    const stripeSessionId = session?.id || null;
    const stripePaymentIntentId = session?.payment_intent || null;

    // Minimal log for completed checkout
    console.log("[stripe-webhook] checkout.session.completed", { holdId, stripeSessionId, stripePaymentIntentId });

    if (!holdId) {
      return res.status(200).json({ ok: true });
    }

    try {
      const confirmed = await confirmHoldById({ holdId, stripeSessionId, stripePaymentIntentId, stripeEventId });
      // Smoobu reservation creation (idempotent, safe for replays)
      try {
        const smoobuResult = await createSmoobuReservationForBookingIntentId({ bookingIntentId: holdId });
        if (!smoobuResult?.ok) {
          console.error("[stripe-webhook] Smoobu reservation failed", {
            bookingIntentId: holdId,
            stripeEventId,
            error: smoobuResult?.error || smoobuResult?.reason || "Unknown"
          });
        }
      } catch (smoobuErr) {
        console.error("[stripe-webhook] Smoobu reservation exception", {
          bookingIntentId: holdId,
          stripeEventId,
          error: smoobuErr?.message || String(smoobuErr)
        });
      }
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error("[stripe-webhook] confirmHoldById error", err?.message || String(err));
      return res.status(200).json({ ok: true });
    }
  } catch (err) {
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
}
