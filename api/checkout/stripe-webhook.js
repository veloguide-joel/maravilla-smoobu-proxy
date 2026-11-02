// api/checkout/stripe-webhook.js — Stage E5a. Stripe TEST-mode signed webhook (preview/development only).
//
// Refuses with 404 unless VERCEL_ENV is preview/development AND MV_STRIPE_TEST_WEBHOOK=enabled AND test-mode Stripe
// settings and a booking database are configured. In production it is always 404, before anything else runs.
// It makes no Stripe write (reads only: account, Checkout Session, PaymentIntent) and no Hostaway call.
//
// PACKAGING (2026-11-02): the runtime closure lives under lib/ (lib/checkout, lib/booking-db); /db stays excluded from
// upload. test/packaging-closure.test.mjs checks the closure with an APPROXIMATE static tracer. Vercel's own bundling,
// module loading and raw-body handling for this file are UNVERIFIED (HOLD, no deployment); no deployed behaviour is
// claimed until the reviewed platform validation gate.
import { createStripeTestWebhookHandler } from "../../lib/checkout/stripe-webhook-http.js";

export default createStripeTestWebhookHandler({ env: process.env });
