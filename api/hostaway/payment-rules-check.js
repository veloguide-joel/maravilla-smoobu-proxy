// GET /api/hostaway/payment-rules-check — E4 payment isolation: ONE read-only provider call.
//
// FEATURE-PREVIEW ONLY (branch feature/e4-payment-isolation-readonly; never merged to DEV/main):
//  1. Runtime gate FIRST: unless VERCEL_ENV === "preview" AND VERCEL_GIT_COMMIT_REF ===
//     "feature/e4-payment-isolation-readonly", answer 404 before any other check (fail-closed when either variable is
//     missing). Vercel SSO deployment protection also applies.
//  2. GET only. Any query string or request body is rejected (400) — there are no inputs.
//  3. Existing constant-time HOSTAWAY_DIAG_KEY auth (lib/diag-auth.js; 503 when unset, 401 otherwise).
//  4. Exactly one provider request: GET /v1/guestPayments/autoPayment via the existing server-side client, 15 s
//     timeout, retryOnAuth: false (no 401/403 re-mint retry); the client never retries network/429. Any thrown error
//     stops with UNRESOLVED.
//  5. Output: lib/payment-rules-check.js fixed codes, HTTP status, returned and declared counts, fixed flags. Never
//     tokens, secrets, env values, raw bodies, titles, descriptions, account ids or provider strings. No CORS headers;
//     Cache-Control: no-store; no logging.
// Note: the earlier api/hostaway/e4-check.js is gated to feature/e4-readonly-route and answers 404 on this branch's
// preview by design; it is not broadened.

import { getHostawayEnvStatus, hostawayGet } from "../../lib/hostaway.js";
import { requireDiagKey } from "../../lib/diag-auth.js";
import { PAYMENT_RULES_PATH, summarizeAutoPaymentRules, summarizeThrown } from "../../lib/payment-rules-check.js";

export const PAYMENT_CHECK_BRANCH = "feature/e4-payment-isolation-readonly";
export const PAYMENT_CHECK_VERSION = "e4-payment-rules-v1";
const UPSTREAM_TIMEOUT_MS = 15000;

/** True only on a Vercel preview deployment of exactly this branch. Missing variables => false. */
export function paymentCheckGateOpen(env = process.env) {
  return env.VERCEL_ENV === "preview" && env.VERCEL_GIT_COMMIT_REF === PAYMENT_CHECK_BRANCH;
}

/** True when the request carries any query string or any body. */
export function hasInputs(req) {
  const q = req.query;
  if (q && typeof q === "object" && Object.keys(q).length > 0) return true;
  if (typeof req.url === "string" && req.url.includes("?")) return true;
  const h = req.headers || {};
  if (h["transfer-encoding"] !== undefined) return true;
  if (h["content-length"] !== undefined && String(h["content-length"]) !== "0") return true;
  const b = req.body;
  if (b === undefined || b === null || b === "") return false;
  if (typeof b === "object" && !Buffer.isBuffer(b) && Object.keys(b).length === 0) return false;
  if (Buffer.isBuffer(b) && b.length === 0) return false;
  return true;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!paymentCheckGateOpen()) { res.status(404).json({ ok: false, error: "NOT_FOUND" }); return; }
  if (req.method !== "GET") { res.setHeader("Allow", "GET"); res.status(405).json({ ok: false, error: "METHOD_NOT_ALLOWED" }); return; }
  if (hasInputs(req)) { res.status(400).json({ ok: false, error: "NO_INPUTS_ACCEPTED" }); return; }
  if (!requireDiagKey(req, res)) return;
  if (!getHostawayEnvStatus().ok) { res.status(503).json({ ok: false, error: "UPSTREAM_NOT_CONFIGURED" }); return; }

  const startedAt = new Date().toISOString();
  let summary;
  try {
    const resp = await hostawayGet(PAYMENT_RULES_PATH, { timeoutMs: UPSTREAM_TIMEOUT_MS, retryOnAuth: false });
    summary = summarizeAutoPaymentRules(resp.status, resp.json);
  } catch (err) {
    summary = summarizeThrown(err);
  }
  res.status(200).json({
    ok: true, tool: "e4-payment-rules-check", version: PAYMENT_CHECK_VERSION, mode: "preview-readonly",
    startedAt, finishedAt: new Date().toISOString(), ...summary,
    writes: "none (token mint is authentication only)"
  });
}
