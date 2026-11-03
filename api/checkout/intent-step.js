// api/checkout/intent-step.js — Stage E6 (offline; Stripe TEST mode only). POST {step:"details", ...guest} or
// {step:"pay"} for the intent named by the Bearer token. "pay" may create ONE Stripe TEST Checkout Session (manual
// capture) per payment attempt; a repeat returns the same open session after a fresh read. No capture, void, refund or
// Hostaway write. Same gate as api/checkout/intents.js; production is always 404 before anything else runs.
// PLATFORM (UNVERIFIED; HOLD, no deployment): bundling, module loading, raw-body and client-address handling on Vercel.
import { createIntentApiHandler } from "../../lib/checkout/intent-api-http.js";

export default createIntentApiHandler({ route: "step", env: process.env });
