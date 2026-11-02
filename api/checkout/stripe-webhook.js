// api/checkout/stripe-webhook.js — Stage E5a. Stripe TEST-mode signed webhook (preview/development only).
//
// Refuses with 404 unless VERCEL_ENV is preview/development AND MV_STRIPE_TEST_WEBHOOK=enabled AND test-mode Stripe
// settings and a booking database are configured. In production it is always 404, before anything else runs.
// It makes no Stripe write (reads only: account, Checkout Session, PaymentIntent) and no Hostaway call.
//
// PACKAGING GAP (not validated): .vercelignore excludes /db, which this route needs at runtime. Until a reviewed
// packaging decision exists, an enabled deployment answers 503 NOT_READY; nothing is exposed by this file.
import { createStripeTestWebhookHandler } from "../../lib/checkout/stripe-webhook-http.js";

export default createStripeTestWebhookHandler({ env: process.env });
