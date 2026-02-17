import { pool } from "./_db.js";
import { createHold } from "../lib/holds.js";
import { getQuote } from "../lib/quote.js";
import Stripe from "stripe";

// --- Utility: CORS Handling ---
function setCorsHeaders(res, methods = "GET,POST,OPTIONS") {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", methods);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

// --- Utility: Path Parsing ---
function getPathSegments(req) {
  // Remove /api/ prefix and split
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname.replace(/^\/api\//, "");
  return path.split("/").filter(Boolean);
}

// --- Health Handler ---
function handleHealth(req, res) {
  setCorsHeaders(res, "GET,OPTIONS");
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }
  res.status(200).json({ ok: true, ts: new Date().toISOString() });
}

// --- Holds Router ---
async function handleHolds(req, res, pathSegments) {
  setCorsHeaders(res);
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }
  // Support both ?action= and /holds/active etc
  const url = new URL(req.url, `http://${req.headers.host}`);
  const action = url.searchParams.get("action") || pathSegments[1];
  switch (action) {
    case "active":
      await handleHoldsActive(req, res);
      break;
    case "create":
      await handleHoldsCreate(req, res);
      break;
    case "release":
      await handleHoldsRelease(req, res);
      break;
    case "confirm":
      await handleHoldsConfirm(req, res);
      break;
    case "dbcheck":
      await handleHoldsDbcheck(req, res);
      break;
    case "ping":
      handleHoldsPing(req, res);
      break;
    case "test-insert":
      await handleHoldsTestInsert(req, res);
      break;
    default:
      // Default: /api/holds or unknown action
      if (!action && req.method === "GET") {
        await handleHoldsActive(req, res);
      } else {
        res.status(400).json({ ok: false, error: "UNKNOWN_ACTION", action });
      }
      break;
  }
}

// --- Smoobu Router ---
async function handleSmoobu(req, res, pathSegments) {
  setCorsHeaders(res);
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }
  const sub = pathSegments[1];
  switch (sub) {
    case "apartments":
      await handleSmoobuApartments(req, res);
      break;
    case "availability":
      await handleSmoobuAvailability(req, res);
      break;
    case "me":
      await handleSmoobuMe(req, res);
      break;
    case "quote":
      await handleSmoobuQuote(req, res);
      break;
    case "test":
      await handleSmoobuTest(req, res);
      break;
    default:
      res.status(404).json({ ok: false, error: "UNKNOWN_SMOOBU_ROUTE", route: sub });
      break;
  }
}

// --- Internal Holds Handlers ---
async function handleHoldsActive(req, res) { /* ...existing code... */ }
async function handleHoldsCreate(req, res) { /* ...existing code... */ }
async function handleHoldsRelease(req, res) { /* ...existing code... */ }
async function handleHoldsConfirm(req, res) { /* ...existing code... */ }
async function handleHoldsDbcheck(req, res) { /* ...existing code... */ }
function handleHoldsPing(req, res) { /* ...existing code... */ }
async function handleHoldsTestInsert(req, res) { /* ...existing code... */ }

// --- Internal Smoobu Handlers ---
async function handleSmoobuApartments(req, res) { /* ...existing code... */ }
async function handleSmoobuAvailability(req, res) { /* ...existing code... */ }
async function handleSmoobuMe(req, res) { /* ...existing code... */ }
async function handleSmoobuQuote(req, res) { /* ...existing code... */ }
async function handleSmoobuTest(req, res) { /* ...existing code... */ }

// --- Main Handler ---
export default async function handler(req, res) {
  const pathSegments = getPathSegments(req);
  const root = pathSegments[0];
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
  // --- Existing router ---
  switch (root) {
    case "health":
      handleHealth(req, res);
      break;
    case "holds":
      await handleHolds(req, res, pathSegments);
      break;
    case "smoobu":
      await handleSmoobu(req, res, pathSegments);
      break;
    default:
      console.log("[router] unmatched pathSegments:", pathSegments);
      res.status(404).json({ ok: false, error: "UNKNOWN_API_ROUTE", route: root });
      break;
  }
}
