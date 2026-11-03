// lib/checkout/intent-api-core.js — Stage E6 (offline; Stripe TEST mode only). The four intent API operations.
//
// Loaded LAZILY by lib/checkout/intent-api-http.js only after its gate, origin, method, body and bearer checks passed.
// Every response body here is code-and-status only: no guest data, no token (except the one-time token in the create
// reply), no provider identifiers. Prices are server-owned (fresh Hostaway reads -> final-price), never browser input.
// The only provider WRITE reachable is the E5a TEST Checkout Session create (startTestCheckout: test-DB, test-account and
// manual-capture guards, one create per attempt, no retry on uncertainty). No capture, void, refund or Hostaway write.
import { randomBytes } from "node:crypto";
import { createIntentRecord, applyEvent, collectGuestDetails, loadIntent } from "../booking-db/repo.js";
import { findAttemptBySession } from "../booking-db/webhooks.js";
import { startTestCheckout } from "./stripe-test-webhook.js";
import { validateCheckoutRequest } from "./final-price.js";
import { publicStatus } from "./intent-state.js";
import { readDirectPolicyFromEnv } from "../direct-policy.js";
import { todayInTimeZone } from "../public-api.js";
import { priceStay } from "./server-pricer.js";
import { isTestSessionId } from "./stripe-test-mode.js";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const reply = (http, body) => ({ http, body });
const REF_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export const newToken = () => randomBytes(32).toString("base64url");                   // 256-bit, returned once
export function newRef() {
  const b = randomBytes(8);
  return `MV-${[...b].map((x) => REF_ALPHABET[x % REF_ALPHABET.length]).join("")}`;
}

/** Public price summary: server-made labels and integer minor units only. */
export function priceSummary(price) {
  if (!price) return null;
  return { currency: price.currency, totalMinor: price.finalTotalMinor,
    lines: (price.lines || []).map((l) => ({ label: String(l.label), amountMinor: l.amountMinor })) };
}
const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

/** POST /api/checkout/intents */
export async function createCheckoutIntent(ctx, body) {
  const v = validateCheckoutRequest(body);
  if (!v.ok) return reply(400, { code: v.error });
  const req = v.request;
  const listingConfig = ctx.config.listings.get(req.listingId);
  if (!listingConfig) return reply(404, { code: "LISTING_NOT_AVAILABLE" });
  if (!(await ctx.limitCreate())) return reply(429, { code: "RATE_LIMITED" });
  const pol = readDirectPolicyFromEnv(ctx.env);
  if (!pol.ok) return reply(503, { code: "PRICING_NOT_CONFIGURED" });
  const priced = await priceStay({ request: req, listingConfig, client: await ctx.hostaway(), policy: pol.policy,
    today: todayInTimeZone(undefined, new Date(ctx.now)), now: ctx.now });
  if (!priced.ok) {
    if (priced.error === "NOT_BOOKABLE") return reply(409, { code: "NOT_AVAILABLE" });
    if (priced.error === "CURRENCY_NOT_CONFIGURED") return reply(503, { code: "LISTING_NOT_CONFIGURED" });
    return reply(502, { code: priced.error === "PRICE_REFUSED" ? "PRICE_REFUSED" : "PRICE_UNAVAILABLE" });
  }
  const token = newToken();
  let intent = null;
  for (let i = 0; i < 2 && !intent; i++) {
    try {
      intent = await createIntentRecord(ctx.pool, { ref: newRef(), accessTokenHash: ctx.hashToken(token), listingId: req.listingId, from: req.from,
        to: req.to, guests: req.guests, environment: "test", now: ctx.now });
    } catch (e) { if (e.code !== "23505" || i === 1) throw e; }            // a (vanishingly rare) ref collision: once more
  }
  const r = await applyEvent(ctx.pool, intent.id, { type: "PRICE_CONFIRMED", id: `price:${intent.id}`, price: priced.price }, { now: ctx.now, actor: "guest" });
  if (!r.ok) return reply(503, { code: "INTENT_NOT_PRICED" });
  return reply(201, { token, status: publicStatus(r.intent), quoteExpiresAt: iso(r.intent.quoteExpiresAt), price: priceSummary(r.intent.price) });
}

/** GET /api/checkout/intents (Bearer) */
export async function intentStatus(ctx, intentId) {
  const intent = await loadIntent(ctx.pool, intentId);
  return reply(200, { status: publicStatus(intent), quoteExpiresAt: iso(intent.quoteExpiresAt), price: priceSummary(intent.price) });
}

const DETAILS_KEYS = new Set(["step", "firstName", "lastName", "email", "phone", "termsVersion"]);
/** POST /api/checkout/intent-step {step:"details", ...} (Bearer) */
export async function submitDetails(ctx, intentId, body) {
  for (const k of Object.keys(body)) if (!DETAILS_KEYS.has(k)) return reply(400, { code: "UNKNOWN_FIELD" });
  if (body.termsVersion !== ctx.config.termsVersion) return reply(400, { code: "TERMS_VERSION_MISMATCH" });
  const guest = { firstName: body.firstName, lastName: body.lastName, email: body.email, ...(body.phone != null ? { phone: body.phone } : {}) };
  const r = await collectGuestDetails(ctx.pool, intentId, guest, { now: ctx.now, termsVersion: body.termsVersion });
  if (!r.ok) {
    if (/^GUEST_/.test(r.error || "")) return reply(400, { code: r.error });
    if (r.error === "QUOTE_EXPIRED") return reply(409, { code: "QUOTE_EXPIRED" });
    return reply(409, { code: "NOT_ALLOWED_IN_STATE" });
  }
  return reply(200, { status: publicStatus(r.intent) });
}

const CONFLICT_CODES = new Set(["QUOTE_EXPIRED", "NOT_READY_FOR_PAYMENT", "NOT_FOUND", "CHECKOUT_CREATE_IN_PROGRESS", "CHECKOUT_CREATE_UNRESOLVED",
  "SESSION_NOT_REUSABLE", "SESSION_EXPIRED_NOT_REUSABLE", "DATES_CLAIMED", "RECORDED_SESSION_NOT_BOUND", "RECORDED_SESSION_NOT_OPEN",
  "RECORDED_SESSION_AMOUNT_MISMATCH", "RECORDED_SESSION_EXPIRY_INVALID", "RECORDED_SESSION_ID_INVALID", "CHECKOUT_ALREADY_PREPARED", "ILLEGAL_TRANSITION"]);
const UNAVAILABLE_CODES = new Set(["DATABASE_NOT_TEST", "ACCOUNT_MISMATCH", "ACCOUNT_READ_FAILED", "PRODUCTION_REFUSED", "ENVIRONMENT_NOT_ALLOWED",
  "NOT_ENABLED", "TEST_KEY_REQUIRED", "WEBHOOK_SECRET_REQUIRED", "ACCOUNT_ID_REQUIRED", "DATABASE_URL_REQUIRED", "DATABASE_CA_REQUIRED"]);

/**
 * A reused session is handed out again only after a FRESH server read shows it is the same open, unexpired TEST session
 * bound to this intent and its payment attempt, for exactly the attempt's amount and currency.
 */
export async function reusableSessionUrl(pool, stripe, intentId, sessionId, now) {
  if (!isTestSessionId(sessionId)) return null;
  const a = await findAttemptBySession(pool, sessionId);
  if (!a || a.intent_id !== intentId || a.status !== "open") return null;
  let s;
  try { s = await stripe.checkout.sessions.retrieve(sessionId); } catch { return null; }
  if (!isObj(s) || s.object !== "checkout.session" || s.id !== sessionId || s.livemode !== false || s.mode !== "payment" || s.status !== "open") return null;
  if (s.client_reference_id !== intentId || !isObj(s.metadata) || s.metadata.mv_intent_id !== intentId || s.metadata.mv_payment_attempt_id !== a.id) return null;
  if (s.amount_total !== Number(a.amount_minor) || typeof s.currency !== "string" || s.currency.toUpperCase() !== String(a.currency).trim()) return null;
  if (!Number.isSafeInteger(s.expires_at) || !(s.expires_at * 1000 > now)) return null;
  if (a.session_expires_at && new Date(a.session_expires_at).getTime() !== s.expires_at * 1000) return null;
  if (typeof s.url !== "string" || !/^https:\/\/checkout\.stripe\.com\//.test(s.url)) return null;
  return s.url;
}

/** POST /api/checkout/intent-step {step:"pay"} (Bearer) */
export async function payIntent(ctx, intentId, body) {
  if (Object.keys(body).some((k) => k !== "step")) return reply(400, { code: "UNKNOWN_FIELD" });
  const stripe = await ctx.stripe();
  const r = await startTestCheckout(ctx.pool, intentId, { env: ctx.env, stripe, now: ctx.now, accountCache: ctx.accountCache });
  if (!r.ok) {
    const code = String(r.error || "UNKNOWN");
    if (CONFLICT_CODES.has(code)) return reply(409, { code });
    if (UNAVAILABLE_CODES.has(code)) return reply(503, { code: "PAYMENT_UNAVAILABLE" });
    return reply(502, { code: /^[A-Z0-9_]{1,64}$/.test(code) ? code : "PAYMENT_PROVIDER_ERROR" });
  }
  const intent = await loadIntent(ctx.pool, intentId);
  let url = !r.reused && typeof r.url === "string" ? r.url : null;
  if (!url) url = await reusableSessionUrl(ctx.pool, stripe, intentId, r.sessionId, ctx.now);
  if (!url) return reply(409, { code: "SESSION_NOT_REUSABLE" });
  return reply(200, { status: publicStatus(intent), checkoutUrl: url });
}
