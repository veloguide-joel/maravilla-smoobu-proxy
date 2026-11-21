// lib/checkout/checkout-config-http.js -- P4-1: GET /api/checkout/config for the same-origin guest checkout page (public/checkout.html).
//
// Returns the two NON-SECRET facts the static page cannot know by itself: the run mode ("test" | "live") and the terms version the
// server will require with the guest details. Nothing else. 404 whenever the intent API itself is not available (the same gate), so
// this route never reveals more than the checkout routes already do. No CORS headers: only the same-origin page reads it.
import { intentApiGate } from "./intent-api-http.js";

export function createCheckoutConfigHandler({ env }) {
  return function handler(req, res) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("X-Content-Type-Options", "nosniff");
    let gate; try { gate = intentApiGate(env); } catch { gate = { ok: false }; }
    if (!gate || gate.ok !== true) { res.statusCode = 404; res.end(JSON.stringify({ code: "NOT_FOUND" })); return; }
    if (req.method !== "GET") { res.statusCode = 405; res.setHeader("Allow", "GET"); res.end(JSON.stringify({ code: "METHOD_NOT_ALLOWED" })); return; }
    res.statusCode = 200;
    res.end(JSON.stringify({ mode: gate.config.mode === "live" ? "live" : "test", termsVersion: gate.config.termsVersion }));
  };
}
