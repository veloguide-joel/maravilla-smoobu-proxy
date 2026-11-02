// api/checkout/stripe-webhook.js — Stage E5a. Stripe TEST-mode signed webhook (preview/development only).
//
// Refuses with 404 unless VERCEL_ENV is preview/development AND MV_STRIPE_TEST_WEBHOOK=enabled AND test-mode Stripe
// settings and a booking database are configured. In production it is always 404, before anything else runs.
// It makes no Stripe write (reads only: account, Checkout Session, PaymentIntent) and no Hostaway call.
//
// PACKAGING GAP (UNVERIFIED; HOLD, no deployment): .vercelignore excludes /db, which this route loads at runtime, and
// Vercel's bundling, module loading and raw-body handling for this file have never been exercised. An enabled
// deployment might fail to build, fail to load, or answer 503; no specific deployed behaviour is claimed.
import { createStripeTestWebhookHandler } from "../../lib/checkout/stripe-webhook-http.js";

export default createStripeTestWebhookHandler({ env: process.env });
