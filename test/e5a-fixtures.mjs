// Stage E5a — shared offline fixtures (fake key-shaped strings assembled at runtime; not credentials).
export const fake = (...p) => p.join("_");
export const INTENT = "11111111-2222-4333-8444-555555555555";
export const ATTEMPT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
export const NOW = Date.UTC(2026, 10, 2, 20, 0, 0);
export const ENV_OK = Object.freeze({
  VERCEL_ENV: "preview", MV_STRIPE_TEST_WEBHOOK: "enabled",
  STRIPE_TEST_SECRET_KEY: fake("sk", "test", "F".repeat(24)), STRIPE_TEST_WEBHOOK_SECRET: fake("whsec", "W".repeat(32)),
  STRIPE_TEST_ACCOUNT_ID: "acct_TESTACCOUNT01", BOOKING_DATABASE_URL: "postgres://db.example.invalid/booking",
  BOOKING_DATABASE_CA_PEM: "-----BEGIN CERTIFICATE-----x", MV_CHECKOUT_RETURN_URL: "https://preview.example.invalid/booking/status"
});

export const authFixture = (o = {}) => {
  const attempt = { id: ATTEMPT, intent_id: INTENT, checkout_session_id: "cs_test_a1B2c3", amount_minor: "320000", currency: "MXN" };
  const md = { mv_intent_id: INTENT, mv_payment_attempt_id: ATTEMPT, mv_stage: "e5a-test" };
  const session = { object: "checkout.session", id: "cs_test_a1B2c3", livemode: false, mode: "payment", status: "complete", payment_status: "unpaid",
    client_reference_id: INTENT, metadata: { ...md }, payment_intent: "pi_T1", amount_total: 320000, currency: "mxn",
    customer_details: { email: "guest@example.invalid", name: "Guest Person" }, ...(o.session || {}) };
  const charge = { object: "charge", id: "ch_T1", livemode: false, payment_intent: "pi_T1", captured: false, amount_captured: 0, amount_refunded: 0,
    status: "succeeded", paid: true, created: Math.floor(NOW / 1000) - 60,
    payment_method_details: { card: { capture_before: Math.floor(NOW / 1000) + 7 * 86400, last4: "4242" } },
    billing_details: { email: "guest@example.invalid" }, ...(o.charge || {}) };
  const pi = { object: "payment_intent", id: "pi_T1", livemode: false, status: "requires_capture", capture_method: "manual", amount: 320000,
    amount_capturable: 320000, currency: "mxn", metadata: { ...md }, latest_charge: charge, ...(o.pi || {}) };
  return { stripeEventId: "evt_T1", session, pi, attempt, accountVerified: true, ...(o.top || {}) };
};

