// P2a: LIVE is reachable ONLY through the full C125 contract plus the explicit activation value. Offline; no network, DB or provider.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkoutModeGate, stripeTestGate, LIVE_ACTIVATION_ENV, LIVE_ACTIVATION_VALUE, MAX_LIVE_LISTINGS } from "../lib/checkout/stripe-test-mode.js";
import { intentApiGate } from "../lib/checkout/intent-api-http.js";

const K = (p, n = 24) => p + "A".repeat(n);          // syntactically valid placeholders only: never real credentials
const LIVE = Object.freeze({
  MV_CHECKOUT_MODE: "live", VERCEL_ENV: "production", STRIPE_LIVE_SECRET_KEY: K("rk_live_"), STRIPE_LIVE_WEBHOOK_SECRET: K("whsec_"),
  STRIPE_LIVE_ACCOUNT_ID: K("acct_", 16), MV_CHECKOUT_ALLOWED_ORIGIN: "https://micasadirect.com", MV_CHECKOUT_RETURN_URL: "https://micasadirect.com/booking/return",
  MV_CHECKOUT_LIVE_LISTINGS: "111111:USD,222222:USD", MV_CHECKOUT_TERMS_VERSION: "terms-2026-12",
  BOOKING_DATABASE_URL: "postgres-url-placeholder", BOOKING_DATABASE_CA_PEM: "ca-placeholder", MV_RATE_LIMIT_SALT: "s".repeat(40) });
const ON = Object.freeze({ ...LIVE, [LIVE_ACTIVATION_ENV]: LIVE_ACTIVATION_VALUE });

test("A1 a complete LIVE contract WITHOUT the activation value is refused exactly as before (LIVE_NOT_ACTIVATED); near-miss values too", () => {
  assert.deepEqual(checkoutModeGate(LIVE), { ok: false, code: "LIVE_NOT_ACTIVATED" });
  for (const v of ["", "yes", "true", "enabled", "LIVE-PAYMENTS-APPROVED", " live-payments-approved", 1, true]) {
    assert.deepEqual(checkoutModeGate({ ...LIVE, [LIVE_ACTIVATION_ENV]: v }), { ok: false, code: "LIVE_NOT_ACTIVATED" }, String(v));
    assert.deepEqual(stripeTestGate({ ...LIVE, [LIVE_ACTIVATION_ENV]: v }), { ok: false, code: "LIVE_NOT_ACTIVATED" }, String(v));
  }
});

test("A2 activation never bypasses the contract: every contract refusal still wins with the activation value present", () => {
  const cases = [[{ VERCEL_ENV: "preview" }, "LIVE_REQUIRES_PRODUCTION"], [{ STRIPE_TEST_SECRET_KEY: K("sk_test_") }, "KEY_MODE_MISMATCH"],
    [{ MV_CHECKOUT_TEST_LISTINGS: "606998:USD" }, "MODE_MIXED_CONFIG"], [{ MV_CHECKOUT_TEST_API: "enabled" }, "MODE_MIXED_CONFIG"],
    [{ STRIPE_LIVE_SECRET_KEY: K("sk_live_") }, "LIVE_KEY_MUST_BE_RESTRICTED"], [{ STRIPE_LIVE_SECRET_KEY: K("rk_test_") }, "KEY_MODE_MISMATCH"],
    [{ MV_CHECKOUT_LIVE_LISTINGS: "606998:USD" }, "LIVE_LISTING_NOT_APPROVED"], [{ MV_CHECKOUT_LIVE_LISTINGS: "111111:MXN" }, "LIVE_LISTINGS_INVALID"],
    [{ MV_CHECKOUT_RETURN_URL: "https://evil.example/return" }, "RETURN_URL_NOT_ON_ORIGIN"], [{ MV_CHECKOUT_TERMS_VERSION: "test-terms-2026-11" }, "LIVE_TERMS_IS_TEST"]];
  for (const [over, code] of cases) assert.deepEqual(stripeTestGate({ ...ON, ...over }), { ok: false, code }, code);
});

test("A3 activated: the gate returns the LIVE config (live key / secret / account, mode 'live', the approved listings); never a TEST value", () => {
  const g = stripeTestGate(ON);
  assert.equal(g.ok, true);
  assert.deepEqual([g.config.mode, g.config.secretKey, g.config.webhookSecret, g.config.accountId, g.config.returnUrl],
    ["live", ON.STRIPE_LIVE_SECRET_KEY, ON.STRIPE_LIVE_WEBHOOK_SECRET, ON.STRIPE_LIVE_ACCOUNT_ID, ON.MV_CHECKOUT_RETURN_URL]);
  assert.deepEqual([...g.config.liveListings.keys()], [111111, 222222]);
  assert.ok(Object.isFrozen(g) && Object.isFrozen(g.config));
  for (const miss of ["BOOKING_DATABASE_URL", "BOOKING_DATABASE_CA_PEM"]) { const e = { ...ON }; delete e[miss]; assert.equal(stripeTestGate(e).ok, false, miss); }
});

test("A4 the intent API gate in LIVE: listings = the approved LIVE listings (USD), mode 'live', TEST release off; salt still required", () => {
  const g = intentApiGate(ON);
  assert.equal(g.ok, true);
  assert.deepEqual([g.config.mode, g.config.allowedOrigin, g.config.termsVersion, g.config.testRelease, g.config.addressSource],
    ["live", "https://micasadirect.com", "terms-2026-12", false, "none"]);
  assert.deepEqual([...g.config.listings.entries()].map(([id, c]) => [id, c.currency]), [[111111, "USD"], [222222, "USD"]]);
  assert.equal("liveListings" in g.config, false);
  const e = { ...ON }; delete e.MV_RATE_LIMIT_SALT;
  assert.deepEqual(intentApiGate(e), { ok: false, code: "RATE_LIMIT_SALT_REQUIRED" });
  assert.deepEqual(intentApiGate(LIVE), { ok: false, code: "LIVE_NOT_ACTIVATED" });
});

test("A5 the catalog size: up to 60 approved listings; 61 refused; a TEST deployment that can see ANY live setting is still refused", () => {
  const list = (n) => Array.from({ length: n }, (_, i) => `${200000 + i}:USD`).join(",");
  assert.equal(MAX_LIVE_LISTINGS, 60);
  assert.equal(stripeTestGate({ ...ON, MV_CHECKOUT_LIVE_LISTINGS: list(28) }).config.liveListings.size, 28);
  assert.equal(stripeTestGate({ ...ON, MV_CHECKOUT_LIVE_LISTINGS: list(60) }).ok, true);
  assert.deepEqual(stripeTestGate({ ...ON, MV_CHECKOUT_LIVE_LISTINGS: list(61) }), { ok: false, code: "LIVE_LISTINGS_INVALID" });
  assert.deepEqual(checkoutModeGate({ STRIPE_LIVE_SECRET_KEY: K("rk_live_") }), { ok: false, code: "KEY_MODE_MISMATCH" });
  assert.deepEqual(checkoutModeGate({ MV_CHECKOUT_LIVE_LISTINGS: "111111:USD" }), { ok: false, code: "MODE_MIXED_CONFIG" });
});
