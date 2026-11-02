// lib/checkout/stripe-test-mode.js — Stage E5a (offline implementation; Stripe TEST mode only).
//
// PURE helpers for the first Stripe slice: the runtime gate, the Checkout Session create executor (injected client),
// conservative classification of create errors, and the binding of a verified Stripe authorization to one intent.
//
// This module never imports the Stripe SDK, never reads the process environment, never touches a database and never logs.
// The Stripe client is always injected by the caller. Nothing here captures, voids, refunds or contacts Hostaway.
//
// Safety rules (E0 architecture A', E3 header, root E5a brief 2026-11-02):
//   - TEST mode only: the gate refuses production and anything without explicit test-mode configuration, BEFORE the
//     caller loads the SDK, opens a pool or reads a request body.
//   - The amount and currency come only from the persisted outbox row (the intent's confirmed price), never a browser.
//   - capture_method is "manual": funds are authorized, never captured here (no capture before a verified reservation).
//   - A create is attempted once per row. Only a catalogued, definite Stripe refusal is "failed_definite"; timeouts,
//     5xx, 429, idempotency conflicts, unknown errors and unexpected replies are "outcome_unknown" (reconciled, never
//     retried automatically).
//   - A "completed"/"paid" Checkout flag is NOT proof of an authorization. Only a server read of the PaymentIntent in
//     requires_capture, bound to this intent/attempt/session, with amount_capturable, currency, livemode=false and
//     Stripe's own authorization time and capture deadline (Charge.payment_method_details.card.capture_before), is.

export const E5A_VERSION = "e5a-stripe-test-v1";
export const CHECKOUT_CREATE_OP = "stripe.create_checkout_session";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY_RE = /^(sk|rk)_test_[A-Za-z0-9]{8,200}$/;
const WHSEC_RE = /^whsec_[A-Za-z0-9+/=]{8,200}$/;
const ACCT_RE = /^acct_[A-Za-z0-9]{6,64}$/;
const SESSION_RE = /^cs_test_[A-Za-z0-9]{1,250}$/;
const PI_RE = /^pi_[A-Za-z0-9]{1,250}$/;
const CH_RE = /^(ch|py)_[A-Za-z0-9]{1,250}$/;
const IDEM_RE = /^cs:[0-9a-f-]{36}:[1-9][0-9]{0,5}$/;

export const STRIPE_MIN_SESSION_MS = 30 * 60 * 1000;          // Stripe: expires_at must be 30 min .. 24 h after creation
export const SESSION_EXPIRY_MARGIN_MS = 2 * 60 * 1000;         // our request lands safely above Stripe's minimum
export const MAX_SESSION_MS = 24 * 60 * 60 * 1000;
export const MAX_AMOUNT_MINOR = 99_999_999;                    // Stripe 8-digit maximum (E3 final-price limit)

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isStr = (v, max = 500) => typeof v === "string" && v.length > 0 && v.length <= max;

/**
 * Runtime gate. Called FIRST by every entry point, with the environment object passed in (never read here).
 * Returns { ok:false, code } without detail, or { ok:true, config } with the values the caller needs.
 */
export function stripeTestGate(env) {
  const e = isObj(env) ? env : {};
  if (e.VERCEL_ENV === "production") return { ok: false, code: "PRODUCTION_REFUSED" };
  if (e.VERCEL_ENV !== "preview" && e.VERCEL_ENV !== "development") return { ok: false, code: "ENVIRONMENT_NOT_ALLOWED" };
  if (e.MV_STRIPE_TEST_WEBHOOK !== "enabled") return { ok: false, code: "NOT_ENABLED" };
  if (!KEY_RE.test(e.STRIPE_TEST_SECRET_KEY || "")) return { ok: false, code: "TEST_KEY_REQUIRED" };
  if (!WHSEC_RE.test(e.STRIPE_TEST_WEBHOOK_SECRET || "")) return { ok: false, code: "WEBHOOK_SECRET_REQUIRED" };
  if (!ACCT_RE.test(e.STRIPE_TEST_ACCOUNT_ID || "")) return { ok: false, code: "ACCOUNT_ID_REQUIRED" };
  if (!isStr(e.BOOKING_DATABASE_URL, 4096)) return { ok: false, code: "DATABASE_URL_REQUIRED" };
  if (!isStr(e.BOOKING_DATABASE_CA_PEM, 65536)) return { ok: false, code: "DATABASE_CA_REQUIRED" };
  return Object.freeze({
    ok: true,
    config: Object.freeze({
      secretKey: e.STRIPE_TEST_SECRET_KEY, webhookSecret: e.STRIPE_TEST_WEBHOOK_SECRET, accountId: e.STRIPE_TEST_ACCOUNT_ID,
      databaseUrl: e.BOOKING_DATABASE_URL, databaseCaPem: e.BOOKING_DATABASE_CA_PEM,
      returnUrl: typeof e.MV_CHECKOUT_RETURN_URL === "string" ? e.MV_CHECKOUT_RETURN_URL : null
    })
  });
}

// ---------------------------------------------------------------------------------------------
// Checkout Session create (executor for the outbox row queued by beginPayStep)

function validReturnUrl(u) {
  if (!isStr(u, 500)) return false;
  let x; try { x = new URL(u); } catch { return false; }
  return x.protocol === "https:" && !x.username && !x.password && !x.search && !x.hash;
}

/**
 * Build the exact create parameters from the persisted outbox row. Returns { ok:true, params, idempotencyKey, expiresAtSec }
 * or { ok:false, code } (a definite refusal decided BEFORE anything is sent).
 */
export function buildCheckoutSessionParams(op, { nowMs, returnUrl }) {
  if (!isObj(op) || op.op_type !== CHECKOUT_CREATE_OP || !UUID_RE.test(String(op.intent_id))) return { ok: false, code: "NOT_A_CHECKOUT_CREATE" };
  const p = op.payload;
  if (!isObj(p)) return { ok: false, code: "PAYLOAD_INVALID" };
  const amount = p.amountMinor;
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > MAX_AMOUNT_MINOR) return { ok: false, code: "AMOUNT_INVALID" };
  if (typeof p.currency !== "string" || !/^[A-Z]{3}$/.test(p.currency)) return { ok: false, code: "CURRENCY_INVALID" };
  if (!UUID_RE.test(String(p.paymentAttemptId))) return { ok: false, code: "ATTEMPT_INVALID" };
  if (!IDEM_RE.test(String(p.providerIdempotencyKey)) || !p.providerIdempotencyKey.startsWith(`cs:${op.intent_id}:`)) return { ok: false, code: "IDEMPOTENCY_KEY_INVALID" };
  const planned = Date.parse(p.expiresAt);
  if (!Number.isFinite(planned) || !Number.isFinite(nowMs)) return { ok: false, code: "EXPIRY_INVALID" };
  if (!validReturnUrl(returnUrl)) return { ok: false, code: "RETURN_URL_INVALID" };
  // Stripe requires expires_at >= 30 min after creation; the planned value was fixed at the pay step, slightly earlier.
  const expiresAtMs = Math.max(planned, nowMs + STRIPE_MIN_SESSION_MS + SESSION_EXPIRY_MARGIN_MS);
  if (expiresAtMs - nowMs > MAX_SESSION_MS) return { ok: false, code: "EXPIRY_INVALID" };
  const expiresAtSec = Math.ceil(expiresAtMs / 1000);
  const metadata = { mv_intent_id: op.intent_id, mv_payment_attempt_id: p.paymentAttemptId, mv_stage: "e5a-test" };
  const params = {
    mode: "payment",
    payment_method_types: ["card"],
    line_items: [{ quantity: 1, price_data: { currency: p.currency.toLowerCase(), unit_amount: amount, product_data: { name: "maraVilla direct booking (TEST)" } } }],
    payment_intent_data: { capture_method: "manual", metadata: { ...metadata } },
    metadata,
    client_reference_id: op.intent_id,
    expires_at: expiresAtSec,
    success_url: `${returnUrl}?checkout=complete`,
    cancel_url: `${returnUrl}?checkout=cancelled`
  };
  return { ok: true, params, idempotencyKey: p.providerIdempotencyKey, expiresAtSec };
}

/** Definite Stripe refusals: no object was created. Everything else is ambiguous. */
export function classifyStripeWriteError(e) {
  if (!isObj(e) && !(e instanceof Error)) return { status: "outcome_unknown", errorCode: "UNKNOWN_ERROR" };
  const type = String(e.type || "");
  const code = typeof e.code === "string" ? e.code : null;
  const http = Number(e.statusCode);
  if (type === "StripeIdempotencyError" || code === "idempotency_key_in_use" || http === 409) return { status: "outcome_unknown", errorCode: "IDEMPOTENCY_CONFLICT" };
  const definiteTypes = new Set(["StripeInvalidRequestError", "StripeAuthenticationError", "StripePermissionError"]);
  if (definiteTypes.has(type) && [400, 401, 403, 404].includes(http)) {
    return { status: "failed_definite", errorCode: `STRIPE_REFUSED_${http}` };
  }
  if (type === "StripeRateLimitError" || http === 429) return { status: "outcome_unknown", errorCode: "RATE_LIMITED" };
  if (type === "StripeConnectionError") return { status: "outcome_unknown", errorCode: "CONNECTION" };
  if (http >= 500) return { status: "outcome_unknown", errorCode: "STRIPE_5XX" };
  return { status: "outcome_unknown", errorCode: "UNKNOWN_ERROR" };
}

/** Check the create reply describes exactly the session we asked for. */
export function validateCreatedSession(s, op, built) {
  const p = op.payload;
  if (!isObj(s)) return "REPLY_NOT_AN_OBJECT";
  if (s.object !== "checkout.session" || !SESSION_RE.test(s.id || "")) return "REPLY_NOT_A_TEST_SESSION";
  if (s.livemode !== false) return "REPLY_LIVEMODE";
  if (s.mode !== "payment" || s.status !== "open") return "REPLY_STATE";
  if (s.amount_total !== p.amountMinor || String(s.currency || "").toUpperCase() !== p.currency) return "REPLY_AMOUNT";
  if (s.client_reference_id !== op.intent_id) return "REPLY_REFERENCE";
  if (!isObj(s.metadata) || s.metadata.mv_intent_id !== op.intent_id || s.metadata.mv_payment_attempt_id !== p.paymentAttemptId) return "REPLY_METADATA";
  if (s.expires_at !== built.expiresAtSec) return "REPLY_EXPIRY";
  if (typeof s.url !== "string" || !/^https:\/\/checkout\.stripe\.com\//.test(s.url)) return "REPLY_URL";
  return null;
}

/**
 * Executor for one claimed stripe.create_checkout_session row. Never throws; returns an outbox outcome:
 *   { status:'succeeded', resultRef, session:{ id, expiresAtMs, url } } | { status:'failed_definite'|'outcome_unknown', errorCode }
 */
export function createCheckoutSessionExecutor({ stripe, nowMs, returnUrl }) {
  return async function execute(op) {
    const built = buildCheckoutSessionParams(op, { nowMs, returnUrl });
    if (!built.ok) return { status: "failed_definite", errorCode: `NOT_SENT_${built.code}` };   // nothing left the server
    let s;
    try {
      s = await stripe.checkout.sessions.create(built.params, { idempotencyKey: built.idempotencyKey });
    } catch (e) {
      return classifyStripeWriteError(e);
    }
    const bad = validateCreatedSession(s, op, built);
    // A reply that does not match may still mean a session exists: never "definite", never retried.
    if (bad) return { status: "outcome_unknown", errorCode: bad };
    return { status: "succeeded", resultRef: s.id, session: { id: s.id, expiresAtMs: s.expires_at * 1000, url: s.url } };
  };
}

// ---------------------------------------------------------------------------------------------
// Authorization binding (from SERVER reads of the session and PaymentIntent; never from the webhook payload alone)

/**
 * bindAuthorization → { ok:true, event } (an E3 PAYMENT_AUTHORIZED event) or { ok:false, code } (unresolved: nothing applied).
 * Identity (account/mode/session/intent/attempt/PaymentIntent/charge) must bind exactly. Amount/currency differences
 * with a solid identity are passed to E3, which escalates them (void effect + reconciliation case) by design.
 */
export function bindAuthorization({ stripeEventId, session, pi, attempt, accountVerified }) {
  if (accountVerified !== true) return { ok: false, code: "ACCOUNT_NOT_VERIFIED" };
  if (!isObj(attempt) || !UUID_RE.test(String(attempt.intent_id)) || !UUID_RE.test(String(attempt.id))) return { ok: false, code: "ATTEMPT_UNKNOWN" };
  if (!isObj(session) || session.object !== "checkout.session" || session.id !== attempt.checkout_session_id) return { ok: false, code: "SESSION_NOT_BOUND" };
  if (session.livemode !== false) return { ok: false, code: "SESSION_LIVEMODE" };
  if (session.mode !== "payment" || session.client_reference_id !== attempt.intent_id) return { ok: false, code: "SESSION_NOT_BOUND" };
  if (!isObj(session.metadata) || session.metadata.mv_intent_id !== attempt.intent_id || session.metadata.mv_payment_attempt_id !== attempt.id) return { ok: false, code: "SESSION_METADATA_MISMATCH" };
  if (session.status !== "complete") return { ok: false, code: "SESSION_NOT_COMPLETE" };
  const sessionPi = typeof session.payment_intent === "string" ? session.payment_intent : isObj(session.payment_intent) ? session.payment_intent.id : null;
  if (!PI_RE.test(sessionPi || "")) return { ok: false, code: "SESSION_WITHOUT_PAYMENT_INTENT" };
  if (!isObj(pi) || pi.object !== "payment_intent" || pi.id !== sessionPi) return { ok: false, code: "PAYMENT_INTENT_NOT_BOUND" };
  if (pi.livemode !== false) return { ok: false, code: "PAYMENT_INTENT_LIVEMODE" };
  if (!isObj(pi.metadata) || pi.metadata.mv_intent_id !== attempt.intent_id || pi.metadata.mv_payment_attempt_id !== attempt.id) return { ok: false, code: "PAYMENT_INTENT_METADATA_MISMATCH" };
  if (pi.capture_method !== "manual") return { ok: false, code: "NOT_MANUAL_CAPTURE" };
  if (pi.status === "succeeded") return { ok: false, code: "CAPTURED_BEFORE_RESERVATION" };
  if (pi.status === "canceled") return { ok: false, code: "AUTHORIZATION_CANCELED" };
  if (pi.status !== "requires_capture") return { ok: false, code: "NOT_AUTHORIZED_YET" };
  const ch = pi.latest_charge;
  if (!isObj(ch) || ch.object !== "charge" || !CH_RE.test(ch.id || "") || ch.payment_intent !== pi.id) return { ok: false, code: "CHARGE_NOT_BOUND" };
  if (ch.livemode !== false) return { ok: false, code: "CHARGE_LIVEMODE" };
  if (ch.captured !== false || ch.amount_captured !== 0 || ch.amount_refunded !== 0 || ch.status !== "succeeded" || ch.paid !== true) return { ok: false, code: "CHARGE_NOT_UNCAPTURED_AUTHORIZATION" };
  const cb = isObj(ch.payment_method_details) && isObj(ch.payment_method_details.card) ? ch.payment_method_details.card.capture_before : undefined;
  if (!Number.isSafeInteger(cb) || !Number.isSafeInteger(ch.created)) return { ok: false, code: "AUTHORIZATION_DEADLINE_UNKNOWN" };
  if (!Number.isSafeInteger(pi.amount_capturable) || !Number.isSafeInteger(pi.amount) || typeof pi.currency !== "string") return { ok: false, code: "PAYMENT_INTENT_AMOUNT_UNREADABLE" };
  // A partial authorization is not something this slice may accept or settle on its own: left unresolved.
  if (pi.amount !== pi.amount_capturable) return { ok: false, code: "PARTIAL_AUTHORIZATION" };
  // E3 compares amountMinor/currency with the confirmed price and escalates any difference (void effect + case).
  return {
    ok: true,
    event: {
      type: "PAYMENT_AUTHORIZED", id: stripeEventId, paymentIntentId: pi.id, sessionId: session.id,
      amountMinor: pi.amount_capturable, currency: pi.currency, livemode: pi.livemode,
      authorizationCreatedAt: ch.created * 1000, captureBefore: cb * 1000
    }
  };
}

/** Minimal, PII-free observation recorded as provider evidence (no names, emails, addresses, card data). */
export function sessionObservation(s) {
  return { paymentIntentId: typeof s.payment_intent === "string" ? s.payment_intent : isObj(s.payment_intent) ? s.payment_intent.id ?? null : null,
    amountTotal: Number.isSafeInteger(s.amount_total) ? s.amount_total : null, currency: typeof s.currency === "string" ? s.currency.slice(0, 3) : null,
    livemode: s.livemode === true, expiresAt: Number.isSafeInteger(s.expires_at) ? s.expires_at : null };
}
export function paymentIntentObservation(pi) {
  const ch = isObj(pi.latest_charge) ? pi.latest_charge : null;
  const card = ch && isObj(ch.payment_method_details) && isObj(ch.payment_method_details.card) ? ch.payment_method_details.card : null;
  return { amount: Number.isSafeInteger(pi.amount) ? pi.amount : null, amountCapturable: Number.isSafeInteger(pi.amount_capturable) ? pi.amount_capturable : null,
    currency: typeof pi.currency === "string" ? pi.currency.slice(0, 3) : null, captureMethod: typeof pi.capture_method === "string" ? pi.capture_method.slice(0, 40) : null,
    livemode: pi.livemode === true, chargeCaptured: ch ? ch.captured === true : null,
    chargeCreated: ch && Number.isSafeInteger(ch.created) ? ch.created : null, captureBefore: card && Number.isSafeInteger(card.capture_before) ? card.capture_before : null };
}

export const isTestSessionId = (s) => SESSION_RE.test(String(s || ""));
export const isPaymentIntentId = (s) => PI_RE.test(String(s || ""));
export const isUuid = (s) => UUID_RE.test(String(s || ""));
