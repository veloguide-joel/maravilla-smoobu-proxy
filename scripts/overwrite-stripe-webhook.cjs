const fs = require("fs");
const path = require("path");

const webhookContent = `const Stripe = require("stripe");

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

async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ ok: false, error: "METHOD_NOT_ALLOWED" });
    }

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
    } catch (err) {
      return res.status(400).json({ ok: false, error: "BAD_SIGNATURE" });
    }

    if (event.type !== "checkout.session.completed") {
      return res.status(200).json({ ok: true, ignored: true, type: event.type });
    }

    const session = event.data && event.data.object;
    const sessionId = session && session.id ? session.id : null;
    const paymentIntentId =
      session && session.payment_intent ? session.payment_intent : null;

    return res.status(200).json({
      ok: true,
      received: true,
      sessionId,
      paymentIntentId,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
}

module.exports = handler;
module.exports.config = { api: { bodyParser: false } };
`;

const outPath = path.join(process.cwd(), "api", "stripe", "webhook.js");
fs.writeFileSync(outPath, webhookContent, "utf8");

const bytes = fs.statSync(outPath).size;
console.log("WROTE api/stripe/webhook.js");
console.log("BYTES:", bytes);
