/*
 * HISTORICAL / INACTIVE — REFERENCE ONLY. NOT PRODUCTION-VERIFIED.
 *
 * This is the Stripe Checkout handler that lived inside api/[...path].js
 * (the catch-all router) as the branch `if (root === "stripe" && pathSegments[1] === "checkout")`.
 *
 * It was never reachable in any deployment: Vercel resolved /api/stripe/*
 * against the api/stripe/ directory and returned a platform 404 before the
 * root catch-all was consulted (verified against production 2026-10-15).
 *
 * Preserved here verbatim when the catch-all was removed (housekeeping item 2,
 * owner-approved 2026-10-15) so the hold -> quote -> Stripe Checkout Session
 * flow is not lost from the working tree. This file is deliberately placed
 * under lib/ and NOT under api/, so it creates no route and runs nothing.
 *
 * Known issues, left untouched on purpose:
 *   - getQuote() depends on the Smoobu API, which is cancelled (401).
 *   - createHold() is called with a `status: "pending_payment"` argument that
 *     lib/holds.js does not accept; the hold would be created as 'hold'.
 *   - No authentication; writes a booking_intents row before quoting.
 *
 * Do not import this file. Do not activate, refactor or repair it as part of
 * housekeeping. If a Stripe checkout route is wanted later, design it as its
 * own reviewed step and use this only as reference.
 *
 * Original imports in api/[...path].js were:
 *   import { pool } from "./_db.js";
 *   import { createHold } from "../lib/holds.js";
 *   import { getQuote } from "../lib/quote.js";
 *   import Stripe from "stripe";
 */

/* eslint-disable */
// The handler referenced this helper from the same file:
function setCorsHeaders(res, methods = "GET,POST,OPTIONS") {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", methods);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

// Original body of the branch, verbatim (lines 124-226 of api/[...path].js at commit 70612f1).
// `req`, `res`, `root` and `pathSegments` were in scope from the surrounding default export.
async function __historical_stripe_checkout_branch(req, res, root, pathSegments) {
  if (root === "stripe" && pathSegments[1] === "checkout") {
    // --- Stripe Checkout Handler ---
    setCorsHeaders(res, "POST,OPTIONS");
    if (req.method === "OPTIONS") {
      res.status(200).end();
      return;
    }
    if (req.method !== "POST") {
      res.status(405).json({ ok: false, error: "METHOD_NOT_ALLOWED" });
      return;
    }
    // Env checks
    const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
    const SUCCESS_URL = process.env.SUCCESS_URL;
    const CANCEL_URL = process.env.CANCEL_URL;
    if (!STRIPE_SECRET_KEY || !SUCCESS_URL || !CANCEL_URL) {
      res.status(500).json({ ok: false, error: "MISSING_ENV_VARS" });
      return;
    }
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
        res.status(400).json({ ok: false, error: "INVALID_JSON" });
        return;
      }
    }
    const { propertyId, unitId, from, to, guests, customerEmail, customerName } = body;
    if (!unitId || !from || !to || !customerEmail) {
      res.status(400).json({ ok: false, error: "MISSING_FIELDS" });
      return;
    }
    // 1. Create Hold (pending_payment)
    const holdResult = await createHold({ propertyId, unitId, from, to, guests, customerEmail, customerName, status: "pending_payment" });
    if (!holdResult.ok) {
      res.status(400).json({ ok: false, error: holdResult.error, ...(holdResult.missing ? { missing: holdResult.missing } : {}) });
      return;
    }
    const hold = holdResult.hold;
    // 2. Get Quote
    const quoteResult = await getQuote({ apartmentId: unitId, from, to, guests });
    if (!quoteResult.ok) {
      res.status(400).json({ ok: false, error: quoteResult.error });
      return;
    }
    const amount = Math.round(quoteResult.total * 100); // cents
    const currency = quoteResult.currency || "MXN";
    // 3. Create Stripe Session
    const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2022-11-15" });
    let session;
    try {
      session = await stripe.checkout.sessions.create({
        mode: "payment",
        customer_email: customerEmail,
        line_items: [
          {
            price_data: {
              currency,
              product_data: {
                name: `Booking: ${unitId} ${from} to ${to}`
              },
              unit_amount: amount
            },
            quantity: 1
          }
        ],
        success_url: `${SUCCESS_URL}?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: CANCEL_URL,
        metadata: {
          holdId: hold.id,
          unitId,
          propertyId: propertyId || "",
          from,
          to,
          guests: String(guests || 2),
          customerEmail,
        }
      });
    } catch (err) {
      console.log("[stripe] session error", err.message);
      res.status(500).json({ ok: false, error: "STRIPE_SESSION_FAILED", detail: err.message });
      return;
    }
    // 4. Update hold with sessionId and status
    try {
      await pool.query(
        "UPDATE booking_intents SET stripe_session_id = $1, status = 'awaiting_payment' WHERE id = $2",
        [session.id, hold.id]
      );
    } catch (err) {
      console.log("[stripe] hold update error", err.message);
      // Don't fail the flow, but log
    }
    // 5. Respond
    res.status(200).json({ ok: true, checkoutUrl: session.url, sessionId: session.id, holdId: hold.id });
    return;
  }
}
