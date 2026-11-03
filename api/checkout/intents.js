// api/checkout/intents.js — Stage E6 (offline; Stripe TEST mode only). POST: create a server-priced intent (returns a
// one-time 256-bit bearer token). GET: public status of the intent named by the Bearer token.
// 404 unless VERCEL_ENV is preview/development AND every E5a TEST setting AND MV_CHECKOUT_TEST_API=enabled AND the
// intent-API settings are present; production is always 404 before anything else runs. See lib/checkout/intent-api-http.js.
// PLATFORM (UNVERIFIED; HOLD, no deployment): bundling, module loading, raw-body and client-address handling on Vercel.
import { createIntentApiHandler } from "../../lib/checkout/intent-api-http.js";

export default createIntentApiHandler({ route: "intents", env: process.env });
