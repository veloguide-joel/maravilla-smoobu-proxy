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
const LIVE_SESSION_RE = /^cs_live_[A-Za-z0-9]{1,250}$/;
const PI_RE = /^pi_[A-Za-z0-9]{1,250}$/;
const CH_RE = /^(ch|py)_[A-Za-z0-9]{1,250}$/;
const IDEM_RE = /^cs:[0-9a-f-]{36}:[1-9][0-9]{0,5}$/;

export const STRIPE_MIN_SESSION_MS = 30 * 60 * 1000;          // Stripe: expires_at must be 30 min .. 24 h after creation
export const SESSION_EXPIRY_MARGIN_MS = 2 * 60 * 1000;         // our request lands safely above Stripe's minimum
export const MAX_SESSION_MS = 24 * 60 * 60 * 1000;
export const MAX_AMOUNT_MINOR = 99_999_999;                    // Stripe 8-digit maximum (E3 final-price limit)

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isStr = (v, max = 500) => typeof v === "string" && v.length > 0 && v.length <= max;

// ---------------------------------------------------------------------------------------------
// C125: explicit TEST / LIVE checkout mode, fail closed (pure; kept in this import-free module so no runtime closure changes).
//
// MV_CHECKOUT_MODE
//   unset / "" / "test"  TEST (unset = the existing deployments, unchanged). TEST additionally refuses any LIVE credential or LIVE
//                        listing setting being visible to the deployment (KEY_MODE_MISMATCH / MODE_MIXED_CONFIG).
//   "live"               the LIVE contract is VALIDATED in full and then REFUSED with LIVE_NOT_ACTIVATED. The downstream checkout,
//                        webhook, worker and runner code is still TEST-fenced (cs_test_ sessions, livemode === false proofs, the
//                        'test' database marker, TEST-bound runners); each fence is converted in its own reviewed slice. Until then
//                        no LIVE request can reach Stripe, a pool, Hostaway or a database through this gate.
//   anything else        MODE_INVALID.
//
// LIVE contract (names only; values are entered by the owner into blank forms, never by an agent):
//   VERCEL_ENV=production; STRIPE_LIVE_SECRET_KEY = a RESTRICTED live key (rk_live_…; a full sk_live_ key is refused);
//   STRIPE_LIVE_WEBHOOK_SECRET (whsec_…); STRIPE_LIVE_ACCOUNT_ID (acct_…); MV_CHECKOUT_ALLOWED_ORIGIN = one exact https origin;
//   MV_CHECKOUT_RETURN_URL = an https URL on that SAME origin (no credentials, query or fragment); MV_CHECKOUT_LIVE_LISTINGS =
//   1..10 owner-approved "id:USD" entries (USD only; the TEST listing 606998 is never allowed); MV_CHECKOUT_TERMS_VERSION = an
//   approved, non-TEST version; and NO TEST key, TEST listings or TEST enable flag present at the same time.
// No refusal ever returns a configuration or secret value.

export const CHECKOUT_MODES = Object.freeze(["test", "live"]);
/** Listings that may never be sold in LIVE mode (the TEST listing). */
export const NEVER_LIVE_LISTING_IDS = Object.freeze([606998]);

const LIVE_KEY_RE = /^rk_live_[A-Za-z0-9]{8,200}$/;
const ANY_TEST_KEY_RE = /^(sk|rk|pk)_test_/;
const MODE_ORIGIN_RE = /^https:\/\/[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+(:\d{1,5})?$/;
const LIVE_LISTING_RE = /^([1-9]\d{0,11}):USD$/;
const MODE_TERMS_RE = /^[a-z0-9][a-z0-9.-]{0,39}$/;
const TEST_ENABLE_FLAGS = Object.freeze(["MV_STRIPE_TEST_WEBHOOK", "MV_CHECKOUT_TEST_API", "MV_CHECKOUT_TEST_RELEASE"]);
const LIVE_NAMES = Object.freeze(["STRIPE_LIVE_SECRET_KEY", "STRIPE_LIVE_WEBHOOK_SECRET", "STRIPE_LIVE_ACCOUNT_ID", "MV_CHECKOUT_LIVE_LISTINGS"]);

const present = (v) => v !== undefined && v !== null && v !== "";
const refuse = (code) => Object.freeze({ ok: false, code });

/** "" / unset → "test" (legacy default); "test" / "live" as given; anything else → null. */
export function parseCheckoutMode(raw) {
  if (raw === undefined || raw === null || raw === "") return "test";
  return CHECKOUT_MODES.includes(raw) ? raw : null;
}

/** Parse "123:USD,456:USD" → Map(id → {currency}) for 1..10 distinct approved LIVE listings, or a refusal code. */
export function parseLiveListings(raw) {
  if (typeof raw !== "string" || !raw || raw.length > 400) return { ok: false, code: "LIVE_LISTINGS_REQUIRED" };
  const m = new Map();
  for (const part of raw.split(",")) {
    const x = LIVE_LISTING_RE.exec(part.trim());
    if (!x) return { ok: false, code: "LIVE_LISTINGS_INVALID" };
    const id = Number(x[1]);
    if (NEVER_LIVE_LISTING_IDS.includes(id)) return { ok: false, code: "LIVE_LISTING_NOT_APPROVED" };
    if (m.has(id)) return { ok: false, code: "LIVE_LISTINGS_INVALID" };
    m.set(id, Object.freeze({ currency: "USD" }));
  }
  if (m.size < 1 || m.size > 10) return { ok: false, code: "LIVE_LISTINGS_INVALID" };
  return { ok: true, listings: m };
}

/** An https URL with no credentials / query / fragment, on exactly `origin`. */
export function returnUrlOnOrigin(u, origin) {
  if (typeof u !== "string" || !u || u.length > 500 || typeof origin !== "string") return false;
  let x; try { x = new URL(u); } catch { return false; }
  return x.protocol === "https:" && !x.username && !x.password && !x.search && !x.hash && x.origin === origin;
}

/**
 * Full LIVE contract validation (never activates anything). → { ok:true, listings } | refusal. Order: environment, mode mixing,
 * credentials, origin / return URL, listings, terms. No value is ever echoed.
 */
export function validateLiveContract(e) {
  if (e.VERCEL_ENV !== "production") return refuse("LIVE_REQUIRES_PRODUCTION");
  for (const f of TEST_ENABLE_FLAGS) if (present(e[f])) return refuse("MODE_MIXED_CONFIG");
  if (present(e.MV_CHECKOUT_TEST_LISTINGS)) return refuse("MODE_MIXED_CONFIG");
  if (present(e.STRIPE_TEST_SECRET_KEY) || present(e.STRIPE_TEST_WEBHOOK_SECRET) || present(e.STRIPE_TEST_ACCOUNT_ID)) return refuse("KEY_MODE_MISMATCH");
  const key = e.STRIPE_LIVE_SECRET_KEY;
  if (typeof key !== "string" || !key) return refuse("LIVE_KEY_REQUIRED");
  if (ANY_TEST_KEY_RE.test(key)) return refuse("KEY_MODE_MISMATCH");
  if (!LIVE_KEY_RE.test(key)) return refuse(/^sk_live_/.test(key) ? "LIVE_KEY_MUST_BE_RESTRICTED" : "LIVE_KEY_INVALID");
  if (!WHSEC_RE.test(e.STRIPE_LIVE_WEBHOOK_SECRET || "")) return refuse("LIVE_WEBHOOK_SECRET_REQUIRED");
  if (!ACCT_RE.test(e.STRIPE_LIVE_ACCOUNT_ID || "")) return refuse("LIVE_ACCOUNT_ID_REQUIRED");
  const origin = e.MV_CHECKOUT_ALLOWED_ORIGIN;
  if (typeof origin !== "string" || !MODE_ORIGIN_RE.test(origin)) return refuse("ALLOWED_ORIGIN_REQUIRED");
  if (!returnUrlOnOrigin(e.MV_CHECKOUT_RETURN_URL, origin)) return refuse("RETURN_URL_NOT_ON_ORIGIN");
  const l = parseLiveListings(e.MV_CHECKOUT_LIVE_LISTINGS);
  if (!l.ok) return refuse(l.code);
  const terms = e.MV_CHECKOUT_TERMS_VERSION;
  if (typeof terms !== "string" || !MODE_TERMS_RE.test(terms)) return refuse("TERMS_VERSION_REQUIRED");
  if (/test/i.test(terms)) return refuse("LIVE_TERMS_IS_TEST");
  return { ok: true, listings: l.listings };
}

/**
 * The mode gate, run FIRST inside stripeTestGate(), which the intent API gate (intentApiGate) and the webhook HTTP wrapper
 * (createStripeTestWebhookHandler) call first. The internal processor (processVerifiedStripeEvent) does not call it; it keeps
 * its own event.livemode === false guard. → { ok:true, mode:"test" } | refusal.
 * LIVE never returns ok in this slice: a valid LIVE contract is refused with LIVE_NOT_ACTIVATED.
 */
export function checkoutModeGate(env) {
  const e = isObj(env) ? env : {};
  const mode = parseCheckoutMode(e.MV_CHECKOUT_MODE);
  if (mode === null) return refuse("MODE_INVALID");
  if (mode === "test") {
    for (const n of LIVE_NAMES) if (present(e[n])) return refuse(n === "MV_CHECKOUT_LIVE_LISTINGS" ? "MODE_MIXED_CONFIG" : "KEY_MODE_MISMATCH");
    return Object.freeze({ ok: true, mode: "test" });
  }
  const v = validateLiveContract(e);
  if (!v.ok) return v;
  return refuse("LIVE_NOT_ACTIVATED");
}

/**
 * Runtime gate. Called FIRST by the intent API gate (intentApiGate) and the webhook HTTP wrapper
 * (createStripeTestWebhookHandler), with the environment object passed in (never read here). The internal processor
 * (processVerifiedStripeEvent) does not call it; it is reached only after the wrapper's gate and signature verification
 * and keeps its own event.livemode === false guard.
 * Returns { ok:false, code } without detail, or { ok:true, config } with the values the caller needs.
 */
export function stripeTestGate(env) {
  const e = isObj(env) ? env : {};
  // C125: the explicit TEST / LIVE mode gate runs first (checkoutModeGate, defined above in this file). TEST passes through unchanged; a LIVE
  // credential or LIVE listing visible to a TEST deployment, an invalid mode, or any LIVE configuration is refused here.
  const mode = checkoutModeGate(e);
  if (!mode.ok) return { ok: false, code: mode.code };
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

// C126: the Checkout Session create / reply shape per checkout mode. TEST is exactly the E5a shape (byte-for-byte). The LIVE
// shape exists so the pure builder and reply validator can be reviewed and tested now; the executor still refuses LIVE
// before any client call (NOT_SENT_LIVE_NOT_ACTIVATED), and checkoutModeGate() still refuses LIVE at runtime.
const SESSION_SHAPES = Object.freeze({
  test: Object.freeze({ sessionRe: SESSION_RE, livemode: false, productName: "maraVilla direct booking (TEST)", stage: "e5a-test",
    wrongSessionCode: "REPLY_NOT_A_TEST_SESSION", wrongLivemodeCode: "REPLY_LIVEMODE", requireStage: false }),
  live: Object.freeze({ sessionRe: LIVE_SESSION_RE, livemode: true, productName: "maraVilla direct booking", stage: "c126-live",
    wrongSessionCode: "REPLY_NOT_A_LIVE_SESSION", wrongLivemodeCode: "REPLY_NOT_LIVEMODE", requireStage: true })
});
const sessionShape = (mode) => (mode === "test" || mode === "live" ? SESSION_SHAPES[mode] : null);

/**
 * Build the exact create parameters from the persisted outbox row. mode defaults to "test" (unchanged E5a output);
 * any value other than "test" / "live" is refused with MODE_INVALID before anything else. Returns { ok:true, params, idempotencyKey, expiresAtSec }
 * or { ok:false, code } (a definite refusal decided BEFORE anything is sent).
 */
export function buildCheckoutSessionParams(op, { nowMs, returnUrl, mode = "test" }) {
  const shape = sessionShape(mode);
  if (!shape) return { ok: false, code: "MODE_INVALID" };
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
  const metadata = { mv_intent_id: op.intent_id, mv_payment_attempt_id: p.paymentAttemptId, mv_stage: shape.stage };
  const params = {
    mode: "payment",
    payment_method_types: ["card"],
    line_items: [{ quantity: 1, price_data: { currency: p.currency.toLowerCase(), unit_amount: amount, product_data: { name: shape.productName } } }],
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

/**
 * Check the create reply describes exactly the session we asked for, in the expected mode (default "test": unchanged E5a
 * codes). A reply of the other mode is refused: a TEST reply never satisfies LIVE and a LIVE reply never satisfies TEST.
 */
export function validateCreatedSession(s, op, built, { mode = "test" } = {}) {
  const shape = sessionShape(mode);
  if (!shape) return "REPLY_MODE_INVALID";
  const p = op.payload;
  if (!isObj(s)) return "REPLY_NOT_AN_OBJECT";
  if (s.object !== "checkout.session" || !shape.sessionRe.test(s.id || "")) return shape.wrongSessionCode;
  if (s.livemode !== shape.livemode) return shape.wrongLivemodeCode;
  if (s.mode !== "payment" || s.status !== "open") return "REPLY_STATE";
  if (s.amount_total !== p.amountMinor || String(s.currency || "").toUpperCase() !== p.currency) return "REPLY_AMOUNT";
  if (s.client_reference_id !== op.intent_id) return "REPLY_REFERENCE";
  if (!isObj(s.metadata) || s.metadata.mv_intent_id !== op.intent_id || s.metadata.mv_payment_attempt_id !== p.paymentAttemptId) return "REPLY_METADATA";
  // LIVE only: the reply must carry the LIVE stage tag the builder set (TEST adds no new requirement).
  if (shape.requireStage && s.metadata.mv_stage !== shape.stage) return "REPLY_STAGE";
  if (s.expires_at !== built.expiresAtSec) return "REPLY_EXPIRY";
  if (typeof s.url !== "string" || !/^https:\/\/checkout\.stripe\.com\//.test(s.url)) return "REPLY_URL";
  return null;
}

/**
 * Executor for one claimed stripe.create_checkout_session row. Never throws; returns an outbox outcome:
 *   { status:'succeeded', resultRef, session:{ id, expiresAtMs, url } } | { status:'failed_definite'|'outcome_unknown', errorCode }
 */
export function createCheckoutSessionExecutor({ stripe, nowMs, returnUrl, mode = "test" }) {
  return async function execute(op) {
    // C126: only TEST may send. LIVE stays closed here too (independently of checkoutModeGate); nothing is sent.
    if (mode !== "test") return { status: "failed_definite", errorCode: mode === "live" ? "NOT_SENT_LIVE_NOT_ACTIVATED" : "NOT_SENT_MODE_INVALID" };
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

// ---------------------------------------------------------------------------------------------
// E7: late completed webhook for an authorization that was ALREADY accepted and then canceled (void). Additive; the
// outcomes of bindAuthorization above are unchanged. This is a NOTIFICATION acknowledgement only: it never proves a
// release, so the charge's amount_refunded is deliberately not consulted here (R-REFUND stays open for the release proofs).

const CUR_RE = /^[A-Za-z]{3}$/;
const AMOUNT_TEXT_RE = /^[1-9][0-9]{0,15}$/;
/** provider currency: a 3-letter string, upper-cased for comparison; anything else -> null (no coercion of other types) */
const providerCurrency = (v) => (typeof v === "string" && CUR_RE.test(v) ? v.toUpperCase() : null);
/** provider amount: a positive safe integer of type number; anything else -> null */
const providerAmount = (v) => (Number.isSafeInteger(v) && v > 0 ? v : null);
/** database bigint (node-pg returns text) or integer -> positive safe integer, else null */
export const dbAmount = (v) => (Number.isSafeInteger(v) && v > 0 ? v
  : typeof v === "string" && AMOUNT_TEXT_RE.test(v) && Number.isSafeInteger(Number(v)) ? Number(v) : null);

/**
 * bindCanceledDuplicate({ stripeEventId, session, pi, attempt, accountVerified })
 *   -> { ok:true, binding } | { ok:false, code }
 * Only for an input on which the EXISTING bindAuthorization returns exactly AUTHORIZATION_CANCELED (every identity it checks
 * before the status check passed). The identities are re-asserted here explicitly (not inferred from that ordering), then:
 * the PaymentIntent is canceled with nothing received or capturable; its expanded latest charge is bound, TEST, never
 * captured; and integer amounts / currencies agree across session, attempt, PaymentIntent and charge. The binding is
 * NOT sufficient on its own: the caller must re-check it against the DATABASE intent under lock (acknowledgeCanceledDuplicate).
 */
export function bindCanceledDuplicate(input) {
  const b = bindAuthorization(isObj(input) ? input : {});
  if (b.ok || b.code !== "AUTHORIZATION_CANCELED") return { ok: false, code: "NOT_A_CANCELED_AUTHORIZATION" };
  const { stripeEventId, session, pi, attempt, accountVerified } = input;
  // re-asserted identities (the same facts bindAuthorization checks before its status check)
  if (accountVerified !== true) return { ok: false, code: "ACCOUNT_NOT_VERIFIED" };
  if (!isObj(attempt) || !UUID_RE.test(String(attempt.intent_id)) || !UUID_RE.test(String(attempt.id))) return { ok: false, code: "ATTEMPT_UNKNOWN" };
  if (!isObj(session) || session.object !== "checkout.session" || !SESSION_RE.test(String(session.id)) || session.id !== attempt.checkout_session_id
      || session.livemode !== false || session.mode !== "payment" || session.status !== "complete" || session.client_reference_id !== attempt.intent_id
      || !isObj(session.metadata) || session.metadata.mv_intent_id !== attempt.intent_id || session.metadata.mv_payment_attempt_id !== attempt.id) {
    return { ok: false, code: "SESSION_NOT_BOUND" };
  }
  const sessionPi = typeof session.payment_intent === "string" ? session.payment_intent : isObj(session.payment_intent) ? session.payment_intent.id : null;
  if (!isObj(pi) || pi.object !== "payment_intent" || typeof pi.id !== "string" || !PI_RE.test(pi.id) || sessionPi !== pi.id
      || pi.livemode !== false || pi.capture_method !== "manual"
      || !isObj(pi.metadata) || pi.metadata.mv_intent_id !== attempt.intent_id || pi.metadata.mv_payment_attempt_id !== attempt.id) {
    return { ok: false, code: "PAYMENT_INTENT_NOT_BOUND" };
  }
  // canceled, with nothing received and nothing left capturable (strict integers; no coercion)
  if (pi.status !== "canceled" || pi.amount_received !== 0 || pi.amount_capturable !== 0) return { ok: false, code: "PAYMENT_INTENT_NOT_CLEANLY_CANCELED" };
  // money: one integer amount and one currency across session, attempt and PaymentIntent
  const amount = providerAmount(pi.amount); const currency = providerCurrency(pi.currency);
  if (amount === null || currency === null) return { ok: false, code: "PAYMENT_INTENT_AMOUNT_UNREADABLE" };
  if (providerAmount(session.amount_total) !== amount || providerCurrency(session.currency) !== currency) return { ok: false, code: "SESSION_MONEY_MISMATCH" };
  if (dbAmount(attempt.amount_minor) !== amount || typeof attempt.currency !== "string" || attempt.currency.toUpperCase() !== currency) {
    return { ok: false, code: "ATTEMPT_MONEY_MISMATCH" };
  }
  // the expanded latest charge: present, bound, TEST, never captured, same money. amount_refunded is NOT consulted (see above)
  const ch = pi.latest_charge;
  if (!isObj(ch) || ch.object !== "charge" || typeof ch.id !== "string" || !CH_RE.test(ch.id) || ch.payment_intent !== pi.id) return { ok: false, code: "CHARGE_NOT_BOUND" };
  if (ch.livemode !== false) return { ok: false, code: "CHARGE_LIVEMODE" };
  if (ch.captured !== false || ch.amount_captured !== 0) return { ok: false, code: "CHARGE_CAPTURED" };
  if (providerAmount(ch.amount) !== amount || providerCurrency(ch.currency) !== currency) return { ok: false, code: "CHARGE_MONEY_MISMATCH" };
  return {
    ok: true,
    binding: Object.freeze({ eventId: stripeEventId, intentId: attempt.intent_id, attemptId: attempt.id, sessionId: session.id,
      paymentIntentId: pi.id, chargeId: ch.id, amountMinor: amount, currency })
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
