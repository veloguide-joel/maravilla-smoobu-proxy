// Stage E5a — pure Stripe TEST-mode helpers: gate, Checkout Session create executor, error classes, authorization binding.
// Offline: fake injected Stripe client objects only. No network, no SDK client, no keys (fake key-shaped strings are
// assembled at runtime and are not real credentials).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  stripeTestGate, buildCheckoutSessionParams, createCheckoutSessionExecutor, classifyStripeWriteError, validateCreatedSession,
  bindAuthorization, sessionObservation, paymentIntentObservation, STRIPE_MIN_SESSION_MS
} from "../lib/checkout/stripe-test-mode.js";
import { ENV_OK, authFixture, INTENT, ATTEMPT, NOW, fake } from "./e5a-fixtures.mjs";

const op = (p = {}) => ({ id: "99999999-2222-4333-8444-555555555555", op_type: "stripe.create_checkout_session", intent_id: INTENT,
  payload: { providerIdempotencyKey: `cs:${INTENT}:1`, amountMinor: 320000, currency: "MXN", expiresAt: new Date(NOW + 30 * 60000).toISOString(), paymentAttemptId: ATTEMPT, ...p } });

test("gate: production is refused whatever else is set; nothing but explicit preview/development TEST configuration passes", () => {
  assert.deepEqual(stripeTestGate({ ...ENV_OK, VERCEL_ENV: "production" }), { ok: false, code: "PRODUCTION_REFUSED" });
  for (const env of [undefined, null, {}, { ...ENV_OK, VERCEL_ENV: undefined }, { ...ENV_OK, VERCEL_ENV: "Preview" }, { ...ENV_OK, VERCEL_ENV: "staging" }]) {
    assert.equal(stripeTestGate(env).ok, false);
  }
  const miss = [
    ["MV_STRIPE_TEST_WEBHOOK", "NOT_ENABLED", ["true", "1", "ENABLED", ""]],
    ["STRIPE_TEST_SECRET_KEY", "TEST_KEY_REQUIRED", [fake("sk", "live", "F".repeat(24)), fake("pk", "test", "F".repeat(24)), "sk_test_", ""]],
    ["STRIPE_TEST_WEBHOOK_SECRET", "WEBHOOK_SECRET_REQUIRED", ["whsec_", "secret", ""]],
    ["STRIPE_TEST_ACCOUNT_ID", "ACCOUNT_ID_REQUIRED", ["acct_", "acc_123456789", ""]],
    ["BOOKING_DATABASE_URL", "DATABASE_URL_REQUIRED", [""]],
    ["BOOKING_DATABASE_CA_PEM", "DATABASE_CA_REQUIRED", [""]]
  ];
  for (const [k, code, bad] of miss) {
    assert.deepEqual(stripeTestGate({ ...ENV_OK, [k]: undefined }), { ok: false, code }, k);
    for (const v of bad) assert.deepEqual(stripeTestGate({ ...ENV_OK, [k]: v }), { ok: false, code }, `${k}=${v.slice(0, 8)}`);
  }
  // the legacy production name is never consulted
  assert.equal(stripeTestGate({ ...ENV_OK, STRIPE_TEST_SECRET_KEY: undefined, STRIPE_SECRET_KEY: ENV_OK.STRIPE_TEST_SECRET_KEY }).ok, false);
  for (const ve of ["preview", "development"]) assert.equal(stripeTestGate({ ...ENV_OK, VERCEL_ENV: ve }).ok, true);
  const g = stripeTestGate(ENV_OK);
  assert.equal(g.config.accountId, "acct_TESTACCOUNT01");
  assert.ok(Object.isFrozen(g) && Object.isFrozen(g.config));
});

test("create params: manual capture, amount/currency only from the outbox row, bound metadata, safe expiry, no guest data", () => {
  const b = buildCheckoutSessionParams(op(), { nowMs: NOW, returnUrl: ENV_OK.MV_CHECKOUT_RETURN_URL });
  assert.equal(b.ok, true);
  assert.equal(b.idempotencyKey, `cs:${INTENT}:1`);
  const p = b.params;
  assert.equal(p.mode, "payment");
  assert.deepEqual(p.payment_method_types, ["card"]);
  assert.equal(p.payment_intent_data.capture_method, "manual");
  assert.deepEqual(p.line_items, [{ quantity: 1, price_data: { currency: "mxn", unit_amount: 320000, product_data: { name: "maraVilla direct booking (TEST)" } } }]);
  assert.deepEqual(p.metadata, { mv_intent_id: INTENT, mv_payment_attempt_id: ATTEMPT, mv_stage: "e5a-test" });
  assert.deepEqual(p.payment_intent_data.metadata, p.metadata);
  assert.equal(p.client_reference_id, INTENT);
  // Stripe's 30-minute minimum is respected even though the planned expiry was fixed slightly earlier
  assert.ok(p.expires_at * 1000 >= NOW + STRIPE_MIN_SESSION_MS + 60000);
  assert.ok(p.expires_at * 1000 <= NOW + 24 * 3600 * 1000);
  const later = buildCheckoutSessionParams(op({ expiresAt: new Date(NOW + 3 * 3600 * 1000).toISOString() }), { nowMs: NOW, returnUrl: ENV_OK.MV_CHECKOUT_RETURN_URL });
  assert.equal(later.params.expires_at, Math.ceil((NOW + 3 * 3600 * 1000) / 1000));
  assert.equal(p.success_url, "https://preview.example.invalid/booking/status?checkout=complete");
  const keys = JSON.stringify(p);
  assert.doesNotMatch(keys, /customer|email|phone|name"\s*:\s*"(?!maraVilla)|address|automatic/);
  for (const [o, code] of [
    [op({ amountMinor: 0 }), "AMOUNT_INVALID"], [op({ amountMinor: 1.5 }), "AMOUNT_INVALID"], [op({ amountMinor: 100000000 }), "AMOUNT_INVALID"],
    [op({ amountMinor: "320000" }), "AMOUNT_INVALID"], [op({ currency: "mxn" }), "CURRENCY_INVALID"], [op({ currency: "MXNN" }), "CURRENCY_INVALID"],
    [op({ paymentAttemptId: "x" }), "ATTEMPT_INVALID"], [op({ providerIdempotencyKey: `cs:${ATTEMPT}:1` }), "IDEMPOTENCY_KEY_INVALID"],
    [op({ providerIdempotencyKey: "anything" }), "IDEMPOTENCY_KEY_INVALID"], [op({ expiresAt: "soon" }), "EXPIRY_INVALID"],
    [op({ expiresAt: new Date(NOW + 25 * 3600 * 1000).toISOString() }), "EXPIRY_INVALID"],
    [{ ...op(), op_type: "stripe.capture_payment_intent" }, "NOT_A_CHECKOUT_CREATE"], [{ ...op(), payload: null }, "PAYLOAD_INVALID"]
  ]) assert.deepEqual(buildCheckoutSessionParams(o, { nowMs: NOW, returnUrl: ENV_OK.MV_CHECKOUT_RETURN_URL }), { ok: false, code }, code);
  for (const u of [null, "http://preview.example.invalid/x", "https://u:p@preview.example.invalid/x", "https://preview.example.invalid/x?a=1", "https://preview.example.invalid/x#h", "not a url"]) {
    assert.deepEqual(buildCheckoutSessionParams(op(), { nowMs: NOW, returnUrl: u }), { ok: false, code: "RETURN_URL_INVALID" }, String(u));
  }
});

const goodSession = (b, extra = {}) => ({ object: "checkout.session", id: "cs_test_a1B2c3", livemode: false, mode: "payment", status: "open", amount_total: 320000,
  currency: "mxn", client_reference_id: INTENT, metadata: { mv_intent_id: INTENT, mv_payment_attempt_id: ATTEMPT, mv_stage: "e5a-test" },
  expires_at: b.expiresAtSec, url: "https://checkout.stripe.com/c/pay/cs_test_a1B2c3", payment_intent: null, ...extra });

function fakeStripe({ create, retrieve } = {}) {
  const calls = [];
  return { calls, checkout: { sessions: {
    create: async (params, opts) => { calls.push({ fn: "create", params, opts }); return create(params, opts); },
    retrieve: async (id) => { calls.push({ fn: "retrieve", id }); return retrieve(id); } } } };
}

test("executor: one create with the row's idempotency key; exact reply -> succeeded; any reply difference -> outcome_unknown; invalid row -> nothing sent", async () => {
  const b = buildCheckoutSessionParams(op(), { nowMs: NOW, returnUrl: ENV_OK.MV_CHECKOUT_RETURN_URL });
  const st = fakeStripe({ create: async () => goodSession(b) });
  const ex = createCheckoutSessionExecutor({ stripe: st, nowMs: NOW, returnUrl: ENV_OK.MV_CHECKOUT_RETURN_URL });
  const out = await ex(op());
  assert.deepEqual(out, { status: "succeeded", resultRef: "cs_test_a1B2c3", session: { id: "cs_test_a1B2c3", expiresAtMs: b.expiresAtSec * 1000, url: "https://checkout.stripe.com/c/pay/cs_test_a1B2c3" } });
  assert.equal(st.calls.length, 1);
  assert.deepEqual(st.calls[0].opts, { idempotencyKey: `cs:${INTENT}:1` });
  for (const [extra, code] of [
    [{ livemode: true }, "REPLY_LIVEMODE"], [{ id: "cs_live_a1" }, "REPLY_NOT_A_TEST_SESSION"], [{ object: "payment_intent" }, "REPLY_NOT_A_TEST_SESSION"],
    [{ status: "complete" }, "REPLY_STATE"], [{ mode: "setup" }, "REPLY_STATE"], [{ amount_total: 319999 }, "REPLY_AMOUNT"], [{ currency: "usd" }, "REPLY_AMOUNT"],
    [{ client_reference_id: ATTEMPT }, "REPLY_REFERENCE"], [{ metadata: { mv_intent_id: INTENT } }, "REPLY_METADATA"], [{ expires_at: b.expiresAtSec + 1 }, "REPLY_EXPIRY"],
    [{ url: "https://evil.example/x" }, "REPLY_URL"]
  ]) {
    const s2 = fakeStripe({ create: async () => goodSession(b, extra) });
    assert.deepEqual(await createCheckoutSessionExecutor({ stripe: s2, nowMs: NOW, returnUrl: ENV_OK.MV_CHECKOUT_RETURN_URL })(op()), { status: "outcome_unknown", errorCode: code }, code);
  }
  assert.equal(validateCreatedSession(null, op(), b), "REPLY_NOT_AN_OBJECT");
  const s3 = fakeStripe({ create: async () => { throw new Error("must not be called"); } });
  assert.deepEqual(await createCheckoutSessionExecutor({ stripe: s3, nowMs: NOW, returnUrl: ENV_OK.MV_CHECKOUT_RETURN_URL })(op({ amountMinor: -1 })), { status: "failed_definite", errorCode: "NOT_SENT_AMOUNT_INVALID" });
  assert.equal(s3.calls.length, 0);
  const s4 = fakeStripe({ create: async () => { throw Object.assign(new Error("x"), { type: "StripeConnectionError" }); } });
  assert.deepEqual(await createCheckoutSessionExecutor({ stripe: s4, nowMs: NOW, returnUrl: ENV_OK.MV_CHECKOUT_RETURN_URL })(op()), { status: "outcome_unknown", errorCode: "CONNECTION" });
});

test("create errors: only catalogued definite refusals are failed_definite; timeouts, 5xx, 429, idempotency and unknown are outcome_unknown", () => {
  const e = (type, statusCode, code) => Object.assign(new Error("m"), { type, statusCode, code });
  const rows = [
    [e("StripeInvalidRequestError", 400), "failed_definite"], [e("StripeInvalidRequestError", 404), "failed_definite"],
    [e("StripeAuthenticationError", 401), "failed_definite"], [e("StripePermissionError", 403), "failed_definite"],
    [e("StripeInvalidRequestError", 400, "idempotency_key_in_use"), "outcome_unknown"], [e("StripeIdempotencyError", 400), "outcome_unknown"],
    [e("StripeInvalidRequestError", 409), "outcome_unknown"], [e("StripeRateLimitError", 429), "outcome_unknown"], [e("StripeAPIError", 500), "outcome_unknown"],
    [e("StripeAPIError", 503), "outcome_unknown"], [e("StripeConnectionError"), "outcome_unknown"], [e("StripeInvalidRequestError", 402), "outcome_unknown"],
    [e("StripeCardError", 402), "outcome_unknown"], [e("StripeUnknownError", 400), "outcome_unknown"], [new Error("timeout"), "outcome_unknown"],
    [null, "outcome_unknown"], ["string", "outcome_unknown"]
  ];
  for (const [err, want] of rows) assert.equal(classifyStripeWriteError(err).status, want, JSON.stringify(err && { t: err.type, s: err.statusCode, c: err.code }));
});

test("binding: only an exact server-read authorization becomes PAYMENT_AUTHORIZED, with Stripe's own time and capture deadline", () => {
  const r = bindAuthorization(authFixture());
  assert.equal(r.ok, true);
  assert.deepEqual(r.event, { type: "PAYMENT_AUTHORIZED", id: "evt_T1", paymentIntentId: "pi_T1", sessionId: "cs_test_a1B2c3", amountMinor: 320000,
    currency: "mxn", livemode: false, authorizationCreatedAt: (Math.floor(NOW / 1000) - 60) * 1000, captureBefore: (Math.floor(NOW / 1000) + 7 * 86400) * 1000 });
  // payment_status / "paid" flags are not consulted: a 'paid' session with an unauthorized PaymentIntent is refused
  assert.equal(bindAuthorization(authFixture({ session: { payment_status: "paid" }, pi: { status: "requires_payment_method" } })).code, "NOT_AUTHORIZED_YET");
  const md2 = { mv_intent_id: INTENT, mv_payment_attempt_id: "aaaaaaaa-bbbb-4ccc-8ddd-000000000000" };
  const cases = [
    [{ top: { accountVerified: false } }, "ACCOUNT_NOT_VERIFIED"],
    [{ top: { attempt: null } }, "ATTEMPT_UNKNOWN"],
    [{ session: { id: "cs_test_other" } }, "SESSION_NOT_BOUND"], [{ session: { object: "x" } }, "SESSION_NOT_BOUND"],
    [{ session: { livemode: true } }, "SESSION_LIVEMODE"], [{ session: { client_reference_id: ATTEMPT } }, "SESSION_NOT_BOUND"],
    [{ session: { mode: "subscription" } }, "SESSION_NOT_BOUND"], [{ session: { metadata: md2 } }, "SESSION_METADATA_MISMATCH"],
    [{ session: { metadata: undefined } }, "SESSION_METADATA_MISMATCH"], [{ session: { status: "open" } }, "SESSION_NOT_COMPLETE"],
    [{ session: { status: "expired" } }, "SESSION_NOT_COMPLETE"], [{ session: { payment_intent: null } }, "SESSION_WITHOUT_PAYMENT_INTENT"],
    [{ pi: { id: "pi_OTHER" } }, "PAYMENT_INTENT_NOT_BOUND"], [{ pi: { object: "charge" } }, "PAYMENT_INTENT_NOT_BOUND"],
    [{ pi: { livemode: true } }, "PAYMENT_INTENT_LIVEMODE"], [{ pi: { metadata: md2 } }, "PAYMENT_INTENT_METADATA_MISMATCH"],
    [{ pi: { capture_method: "automatic" } }, "NOT_MANUAL_CAPTURE"], [{ pi: { capture_method: "automatic_async" } }, "NOT_MANUAL_CAPTURE"],
    [{ pi: { status: "succeeded" } }, "CAPTURED_BEFORE_RESERVATION"], [{ pi: { status: "canceled" } }, "AUTHORIZATION_CANCELED"],
    [{ pi: { status: "processing" } }, "NOT_AUTHORIZED_YET"], [{ pi: { status: "requires_action" } }, "NOT_AUTHORIZED_YET"],
    [{ pi: { latest_charge: "ch_T1" } }, "CHARGE_NOT_BOUND"], [{ charge: { payment_intent: "pi_OTHER" } }, "CHARGE_NOT_BOUND"],
    [{ charge: { livemode: true } }, "CHARGE_LIVEMODE"], [{ charge: { captured: true } }, "CHARGE_NOT_UNCAPTURED_AUTHORIZATION"],
    [{ charge: { amount_captured: 1 } }, "CHARGE_NOT_UNCAPTURED_AUTHORIZATION"], [{ charge: { amount_refunded: 5 } }, "CHARGE_NOT_UNCAPTURED_AUTHORIZATION"],
    [{ charge: { status: "pending" } }, "CHARGE_NOT_UNCAPTURED_AUTHORIZATION"], [{ charge: { paid: false } }, "CHARGE_NOT_UNCAPTURED_AUTHORIZATION"],
    [{ charge: { payment_method_details: { card: {} } } }, "AUTHORIZATION_DEADLINE_UNKNOWN"], [{ charge: { payment_method_details: null } }, "AUTHORIZATION_DEADLINE_UNKNOWN"],
    [{ charge: { created: "x" } }, "AUTHORIZATION_DEADLINE_UNKNOWN"], [{ pi: { amount_capturable: 100000 } }, "PARTIAL_AUTHORIZATION"],
    [{ pi: { amount: null, amount_capturable: null } }, "PAYMENT_INTENT_AMOUNT_UNREADABLE"]
  ];
  for (const [o, code] of cases) {
    const x = authFixture(o);
    if (o.charge) x.pi.latest_charge = { ...authFixture().pi.latest_charge, ...o.charge };
    const out = bindAuthorization(x);
    assert.equal(out.ok, false, code); assert.equal(out.code, code, `${code}: got ${out.code}`);
  }
  // identity exact but money different: passed to E3 (which escalates with a void effect and a case)
  const m = bindAuthorization(authFixture({ pi: { amount: 300000, amount_capturable: 300000 } }));
  assert.equal(m.ok, true); assert.equal(m.event.amountMinor, 300000);
  assert.equal(bindAuthorization(authFixture({ pi: { currency: "usd" } })).event.currency, "usd");
});

test("evidence observations carry no guest or card data", () => {
  const f = authFixture();
  const o = JSON.stringify([sessionObservation(f.session), paymentIntentObservation(f.pi)]);
  assert.doesNotMatch(o, /guest|example\.invalid|Guest Person|4242|email|name/i);
  assert.deepEqual(paymentIntentObservation(f.pi), { amount: 320000, amountCapturable: 320000, currency: "mxn", captureMethod: "manual", livemode: false,
    chargeCaptured: false, chargeCreated: Math.floor(NOW / 1000) - 60, captureBefore: Math.floor(NOW / 1000) + 7 * 86400 });
  assert.deepEqual(sessionObservation(f.session), { paymentIntentId: "pi_T1", amountTotal: 320000, currency: "mxn", livemode: false, expiresAt: null });
});
