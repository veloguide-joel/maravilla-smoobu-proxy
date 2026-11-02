// lib/checkout/stripe-webhook-http.js — Stage E5a (offline implementation; Stripe TEST mode only).
//
// HTTP wrapper for the signed Stripe TEST webhook. Order of checks (each refuses before the next step runs):
//   1. stripeTestGate(env): production, a missing flag or anything not explicitly test-mode -> 404, BEFORE the SDK is
//      loaded, a pool is created, the body is read or anything is logged beyond a code.
//   2. POST only; a Stripe-Signature header of bounded size; Content-Length and the streamed body bounded (MAX_BODY_BYTES).
//   3. Signature verified by Stripe's own code on the RAW bytes (tolerance 300 s), with the webhook secret from the gate.
//   4. Only then: the database pool and the Stripe client (TEST key, no automatic network retries, short timeout).
// Responses carry a code only. Logs carry a code only: never the body, headers, secrets, guest data or ids.
import { randomUUID } from "node:crypto";
import { stripeTestGate } from "./stripe-test-mode.js";

export const MAX_BODY_BYTES = 128 * 1024;
export const SIGNATURE_TOLERANCE_SEC = 300;
const MAX_SIG_HEADER = 2048;

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

/** Read the raw request body, refusing more than `max` bytes. Resolves a Buffer or rejects with code BODY_TOO_LARGE. */
export function readBoundedBody(req, max = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0; let done = false;
    const fail = (code) => { if (done) return; done = true; const e = new Error(code); e.code = code; reject(e); };
    req.on("data", (c) => {
      if (done) return;
      size += c.length;
      if (size > max) { fail("BODY_TOO_LARGE"); if (typeof req.destroy === "function") req.destroy(); return; }
      chunks.push(Buffer.from(c));
    });
    req.on("end", () => { if (!done) { done = true; resolve(Buffer.concat(chunks, size)); } });
    req.on("error", () => fail("BODY_READ_FAILED"));
  });
}

const defaultDeps = Object.freeze({
  loadStripe: async () => (await import("stripe")).default,
  loadProcessor: async () => (await import("./stripe-test-webhook.js")).processVerifiedStripeEvent,
  loadPoolLib: async () => import("../../db/lib/pool.js"),
  now: () => Date.now(),
  log: (code) => console.warn(`[stripe-test-webhook] ${code}`)
});

/** Factory: the route file calls it with process.env; tests inject env and fakes. */
export function createStripeTestWebhookHandler({ env, deps = {} } = {}) {
  const d = { ...defaultDeps, ...deps };
  let ready = null; // { pool, stripe, process, webhooks, accountCache } built once, after the first verified request
  return async function handler(req, res) {
    const gate = stripeTestGate(env);
    if (!gate.ok) return send(res, 404, { code: "NOT_FOUND" });
    if (req.method !== "POST") { res.setHeader("Allow", "POST"); return send(res, 405, { code: "METHOD_NOT_ALLOWED" }); }
    const sig = req.headers["stripe-signature"];
    if (typeof sig !== "string" || sig.length === 0 || sig.length > MAX_SIG_HEADER) return send(res, 400, { code: "SIGNATURE_MISSING" });
    const declared = req.headers["content-length"];
    if (declared !== undefined && !(Number(declared) >= 0 && Number(declared) <= MAX_BODY_BYTES)) return send(res, 413, { code: "BODY_TOO_LARGE" });
    let raw;
    try { raw = await readBoundedBody(req, MAX_BODY_BYTES); } catch (e) {
      return send(res, e.code === "BODY_TOO_LARGE" ? 413 : 400, { code: e.code === "BODY_TOO_LARGE" ? "BODY_TOO_LARGE" : "BODY_READ_FAILED" });
    }
    let Stripe;
    try { Stripe = await d.loadStripe(); } catch { d.log("SDK_UNAVAILABLE"); return send(res, 503, { code: "NOT_READY" }); }
    let event;
    try {
      event = Stripe.webhooks.constructEvent(raw, sig, gate.config.webhookSecret, SIGNATURE_TOLERANCE_SEC);
    } catch {
      d.log("SIGNATURE_INVALID");
      return send(res, 400, { code: "SIGNATURE_INVALID" });
    }
    try {
      if (!ready) {
        const poolLib = await d.loadPoolLib();
        const pool = d.createPool ? d.createPool(gate.config) : poolLib.createBookingPool({ connectionString: gate.config.databaseUrl, caPem: gate.config.databaseCaPem });
        await poolLib.assertEnvironment(pool, "test");            // a live-marked database is refused
        const stripe = d.createStripe ? d.createStripe(gate.config) : new Stripe(gate.config.secretKey, { maxNetworkRetries: 0, timeout: 10000 });
        ready = { pool, stripe, process: await d.loadProcessor(), accountCache: {} };
      }
    } catch {
      ready = null;
      d.log("NOT_READY");
      return send(res, 503, { code: "NOT_READY" });
    }
    let out;
    try {
      out = await ready.process(ready.pool, event, { stripe: ready.stripe, now: d.now(), accountId: gate.config.accountId,
        accountCache: ready.accountCache, workerId: `wh-${randomUUID().slice(0, 8)}` });
    } catch {
      d.log("PROCESSING_FAILED");
      return send(res, 503, { code: "PROCESSING_FAILED" });
    }
    if (out.http !== 200) d.log(out.code);
    return send(res, out.http, { received: out.http === 200, code: out.code });
  };
}
