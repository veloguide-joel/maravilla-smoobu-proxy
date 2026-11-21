// api/checkout/config.js -- P4-1. GET: { mode, termsVersion } for the same-origin guest checkout page. 404 unless the checkout API
// itself is available. See lib/checkout/checkout-config-http.js.
import { createCheckoutConfigHandler } from "../../lib/checkout/checkout-config-http.js";

export default createCheckoutConfigHandler({ env: process.env });
