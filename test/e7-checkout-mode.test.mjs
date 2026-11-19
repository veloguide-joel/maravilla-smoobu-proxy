// C125 — explicit TEST / LIVE checkout mode gate (lib/checkout/stripe-test-mode.js checkoutModeGate) and its placement as the FIRST check of
// stripeTestGate(), which the intent API and both webhook entry points call before anything else. Pure: no SDK, pool or network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkoutModeGate, parseCheckoutMode, parseLiveListings, returnUrlOnOrigin, validateLiveContract, NEVER_LIVE_LISTING_IDS, stripeTestGate } from "../lib/checkout/stripe-test-mode.js";
import { intentApiGate } from "../lib/checkout/intent-api-http.js";
import { ENV_OK } from "./e5a-fixtures.mjs";

const TEST_API = Object.freeze({ ...ENV_OK, MV_CHECKOUT_TEST_API: "enabled", MV_CHECKOUT_ALLOWED_ORIGIN: "https://preview.example.invalid",
  MV_CHECKOUT_TEST_LISTINGS: "603566:MXN,606998:USD", MV_RATE_LIMIT_SALT: "s".repeat(40), MV_CHECKOUT_TERMS_VERSION: "terms-2026-11" });
const LIVE_KEY = "rk_live_" + "A1b2C3d4".repeat(3);          // synthetic shapes only; never a real credential
const LIVE = Object.freeze({
  MV_CHECKOUT_MODE: "live", VERCEL_ENV: "production",
  STRIPE_LIVE_SECRET_KEY: LIVE_KEY, STRIPE_LIVE_WEBHOOK_SECRET: "whsec_" + "Z9y8X7w6".repeat(3), STRIPE_LIVE_ACCOUNT_ID: "acct_LiveExample01",
  MV_CHECKOUT_ALLOWED_ORIGIN: "https://book.example.invalid", MV_CHECKOUT_RETURN_URL: "https://book.example.invalid/checkout/return",
  MV_CHECKOUT_LIVE_LISTINGS: "111111:USD,222222:USD", MV_CHECKOUT_TERMS_VERSION: "terms-2027-01",
  BOOKING_DATABASE_URL: "postgres://x", BOOKING_DATABASE_CA_PEM: "-----BEGIN CERTIFICATE-----x"
});
const SECRETS = [LIVE.STRIPE_LIVE_SECRET_KEY, LIVE.STRIPE_LIVE_WEBHOOK_SECRET, ENV_OK.STRIPE_TEST_SECRET_KEY, ENV_OK.STRIPE_TEST_WEBHOOK_SECRET].filter(Boolean);
const noSecret = (r) => { const s = JSON.stringify(r); for (const v of SECRETS) assert.ok(!s.includes(v), "no secret value is ever returned"); };

test("M1 mode parsing: unset / empty → test (existing deployments), 'test' / 'live' explicit, anything else MODE_INVALID", () => {
  for (const v of [undefined, null, ""]) assert.equal(parseCheckoutMode(v), "test");
  assert.equal(parseCheckoutMode("test"), "test"); assert.equal(parseCheckoutMode("live"), "live");
  for (const v of ["TEST", "Live", "production", "true", " live", "live ", 1]) {
    assert.equal(parseCheckoutMode(v), null);
    assert.deepEqual(checkoutModeGate({ ...ENV_OK, MV_CHECKOUT_MODE: v }), { ok: false, code: "MODE_INVALID" });
  }
});

test("T1 TEST unchanged: stripeTestGate and intentApiGate return the SAME config with the mode unset or 'test'", () => {
  const base = stripeTestGate(ENV_OK);
  assert.equal(base.ok, true);
  assert.deepEqual(stripeTestGate({ ...ENV_OK, MV_CHECKOUT_MODE: "test" }), base);
  const api = intentApiGate(TEST_API);
  assert.equal(api.ok, true);
  assert.deepEqual(intentApiGate({ ...TEST_API, MV_CHECKOUT_MODE: "test" }), api);
  assert.deepEqual(checkoutModeGate(ENV_OK), { ok: true, mode: "test" });
  // existing TEST refusals keep their codes
  assert.deepEqual(stripeTestGate({ ...ENV_OK, VERCEL_ENV: "production" }), { ok: false, code: "PRODUCTION_REFUSED" });
});

test("T2 TEST fails closed when LIVE credentials / LIVE listings are visible; a live key in the TEST key slot keeps the existing TEST_KEY_REQUIRED", () => {
  for (const [k, v, code] of [["STRIPE_LIVE_SECRET_KEY", LIVE_KEY, "KEY_MODE_MISMATCH"], ["STRIPE_LIVE_WEBHOOK_SECRET", LIVE.STRIPE_LIVE_WEBHOOK_SECRET, "KEY_MODE_MISMATCH"],
    ["STRIPE_LIVE_ACCOUNT_ID", "acct_LiveExample01", "KEY_MODE_MISMATCH"], ["MV_CHECKOUT_LIVE_LISTINGS", "111111:USD", "MODE_MIXED_CONFIG"],
    ["STRIPE_TEST_SECRET_KEY", "sk_live_" + "x".repeat(24), "TEST_KEY_REQUIRED"], ["STRIPE_TEST_SECRET_KEY", "rk_live_" + "x".repeat(24), "TEST_KEY_REQUIRED"]]) {
    for (const mode of [undefined, "test"]) {
      const env = { ...TEST_API, [k]: v, ...(mode ? { MV_CHECKOUT_MODE: mode } : {}) };
      assert.deepEqual(stripeTestGate(env), { ok: false, code }, `${k} (${mode ?? "unset"})`);
      assert.deepEqual(intentApiGate(env), { ok: false, code });
      noSecret(stripeTestGate(env));
    }
  }
});

test("L1 a fully valid LIVE contract is still REFUSED (LIVE_NOT_ACTIVATED) at every checkout entry gate; nothing returns a LIVE config", () => {
  assert.deepEqual(validateLiveContract(LIVE).ok, true);
  assert.deepEqual(checkoutModeGate(LIVE), { ok: false, code: "LIVE_NOT_ACTIVATED" });
  assert.deepEqual(stripeTestGate(LIVE), { ok: false, code: "LIVE_NOT_ACTIVATED" }, "intent API + both webhook entry points call this first");
  assert.deepEqual(intentApiGate({ ...LIVE, MV_RATE_LIMIT_SALT: "s".repeat(40) }), { ok: false, code: "LIVE_NOT_ACTIVATED" });
  noSecret(stripeTestGate(LIVE));
});

test("L2 LIVE environment / mixing / key-mode checks: production only; no TEST flag, TEST listing or TEST credential alongside; restricted rk_live_ key only", () => {
  const cases = [
    [{ VERCEL_ENV: "preview" }, "LIVE_REQUIRES_PRODUCTION"], [{ VERCEL_ENV: undefined }, "LIVE_REQUIRES_PRODUCTION"],
    [{ MV_STRIPE_TEST_WEBHOOK: "enabled" }, "MODE_MIXED_CONFIG"], [{ MV_CHECKOUT_TEST_API: "enabled" }, "MODE_MIXED_CONFIG"],
    [{ MV_CHECKOUT_TEST_RELEASE: "enabled" }, "MODE_MIXED_CONFIG"], [{ MV_CHECKOUT_TEST_LISTINGS: "606998:USD" }, "MODE_MIXED_CONFIG"],
    [{ STRIPE_TEST_SECRET_KEY: ENV_OK.STRIPE_TEST_SECRET_KEY }, "KEY_MODE_MISMATCH"], [{ STRIPE_TEST_ACCOUNT_ID: "acct_test0001" }, "KEY_MODE_MISMATCH"],
    [{ STRIPE_LIVE_SECRET_KEY: undefined }, "LIVE_KEY_REQUIRED"], [{ STRIPE_LIVE_SECRET_KEY: "rk_test_" + "x".repeat(24) }, "KEY_MODE_MISMATCH"],
    [{ STRIPE_LIVE_SECRET_KEY: "sk_test_" + "x".repeat(24) }, "KEY_MODE_MISMATCH"], [{ STRIPE_LIVE_SECRET_KEY: "sk_live_" + "x".repeat(24) }, "LIVE_KEY_MUST_BE_RESTRICTED"],
    [{ STRIPE_LIVE_SECRET_KEY: "pk_live_" + "x".repeat(24) }, "LIVE_KEY_INVALID"], [{ STRIPE_LIVE_SECRET_KEY: "rk_live_short" }, "LIVE_KEY_INVALID"],
    [{ STRIPE_LIVE_WEBHOOK_SECRET: "" }, "LIVE_WEBHOOK_SECRET_REQUIRED"], [{ STRIPE_LIVE_ACCOUNT_ID: "acct_1" }, "LIVE_ACCOUNT_ID_REQUIRED"],
  ];
  for (const [over, code] of cases) {
    const r = checkoutModeGate({ ...LIVE, ...over });
    assert.deepEqual(r, { ok: false, code }, JSON.stringify(Object.keys(over)));
    noSecret(r);
  }
});

test("L3 LIVE origin / return URL: one exact https origin; the return URL must be https on that SAME origin with no credentials / query / fragment", () => {
  for (const [over, code] of [[{ MV_CHECKOUT_ALLOWED_ORIGIN: "http://book.example.invalid" }, "ALLOWED_ORIGIN_REQUIRED"],
    [{ MV_CHECKOUT_ALLOWED_ORIGIN: "https://book.example.invalid/" }, "ALLOWED_ORIGIN_REQUIRED"], [{ MV_CHECKOUT_ALLOWED_ORIGIN: "*" }, "ALLOWED_ORIGIN_REQUIRED"],
    [{ MV_CHECKOUT_RETURN_URL: "https://other.example.invalid/checkout/return" }, "RETURN_URL_NOT_ON_ORIGIN"],
    [{ MV_CHECKOUT_RETURN_URL: "http://book.example.invalid/checkout/return" }, "RETURN_URL_NOT_ON_ORIGIN"],
    [{ MV_CHECKOUT_RETURN_URL: "https://book.example.invalid/r?x=1" }, "RETURN_URL_NOT_ON_ORIGIN"],
    [{ MV_CHECKOUT_RETURN_URL: "https://book.example.invalid/r#f" }, "RETURN_URL_NOT_ON_ORIGIN"],
    [{ MV_CHECKOUT_RETURN_URL: "https://u:p@book.example.invalid/r" }, "RETURN_URL_NOT_ON_ORIGIN"],
    [{ MV_CHECKOUT_RETURN_URL: "https://book.example.invalid.evil.example/r" }, "RETURN_URL_NOT_ON_ORIGIN"],
    [{ MV_CHECKOUT_RETURN_URL: undefined }, "RETURN_URL_NOT_ON_ORIGIN"]]) {
    assert.deepEqual(checkoutModeGate({ ...LIVE, ...over }), { ok: false, code }, JSON.stringify(over));
  }
  assert.equal(returnUrlOnOrigin("https://book.example.invalid/a/b", "https://book.example.invalid"), true);
});

test("L4 LIVE listings: 1..10 owner-approved id:USD entries; the TEST listing 606998, other currencies, duplicates and junk are refused", () => {
  assert.equal(parseLiveListings("111111:USD").ok, true);
  assert.deepEqual(NEVER_LIVE_LISTING_IDS, [606998]);
  for (const [raw, code] of [[undefined, "LIVE_LISTINGS_REQUIRED"], ["", "LIVE_LISTINGS_REQUIRED"], ["606998:USD", "LIVE_LISTING_NOT_APPROVED"],
    ["111111:USD,606998:USD", "LIVE_LISTING_NOT_APPROVED"], ["111111:MXN", "LIVE_LISTINGS_INVALID"], ["111111", "LIVE_LISTINGS_INVALID"],
    ["111111:USD,111111:USD", "LIVE_LISTINGS_INVALID"], ["0:USD", "LIVE_LISTINGS_INVALID"],
    [Array.from({ length: 11 }, (_, i) => `${100000 + i}:USD`).join(","), "LIVE_LISTINGS_INVALID"]]) {
    assert.deepEqual(checkoutModeGate({ ...LIVE, MV_CHECKOUT_LIVE_LISTINGS: raw }), { ok: false, code }, String(raw));
  }
});

test("L5 LIVE terms: an approved, non-TEST terms version is required", () => {
  for (const [v, code] of [[undefined, "TERMS_VERSION_REQUIRED"], ["Terms 1", "TERMS_VERSION_REQUIRED"], ["test-terms-2026-11", "LIVE_TERMS_IS_TEST"],
    ["terms-test-1", "LIVE_TERMS_IS_TEST"]]) assert.deepEqual(checkoutModeGate({ ...LIVE, MV_CHECKOUT_TERMS_VERSION: v }), { ok: false, code }, String(v));
});

test("S1 static boundary: stripe-test-mode.js stays import-free (no SDK, no process.env, no I/O) and stripeTestGate runs the mode gate before any other check", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../lib/checkout/stripe-test-mode.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /^\s*import\s/m, "no imports at all");
  assert.doesNotMatch(src, /process\.env|require\(|fetch\(|console\./);
  const body = src.slice(src.indexOf("export function stripeTestGate"));
  assert.ok(body.indexOf("checkoutModeGate(e)") > 0 && body.indexOf("checkoutModeGate(e)") < body.indexOf("PRODUCTION_REFUSED"), "mode gate first");
});
