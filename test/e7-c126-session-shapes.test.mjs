// C126 — mode-aware Checkout Session create / reply shapes (pure). TEST output is byte-for-byte the E5a output; the LIVE
// shape is built and validated offline only. The executor never sends in LIVE, and the runtime mode gate still refuses LIVE.
// Offline: fake injected client objects only. No network, no SDK client, no keys.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildCheckoutSessionParams, validateCreatedSession, createCheckoutSessionExecutor, stripeTestGate, checkoutModeGate
} from "../lib/checkout/stripe-test-mode.js";

const INTENT = "11111111-2222-4333-8444-555555555555";
const ATTEMPT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const NOW = Date.UTC(2026, 10, 2, 20, 0, 0);
const RETURN_URL = "https://preview.example.invalid/booking/status";
const op = (p = {}) => ({ id: "99999999-2222-4333-8444-555555555555", op_type: "stripe.create_checkout_session", intent_id: INTENT,
  payload: { providerIdempotencyKey: `cs:${INTENT}:1`, amountMinor: 14000, currency: "USD", expiresAt: new Date(NOW + 30 * 60000).toISOString(), paymentAttemptId: ATTEMPT, ...p } });

// Captured from untouched e7-test d4d68cdf (pre-C126) with this exact input.
const GOLDEN_TEST = '{"ok":true,"params":{"mode":"payment","payment_method_types":["card"],"line_items":[{"quantity":1,"price_data":{"currency":"usd","unit_amount":14000,"product_data":{"name":"maraVilla direct booking (TEST)"}}}],"payment_intent_data":{"capture_method":"manual","metadata":{"mv_intent_id":"11111111-2222-4333-8444-555555555555","mv_payment_attempt_id":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee","mv_stage":"e5a-test"}},"metadata":{"mv_intent_id":"11111111-2222-4333-8444-555555555555","mv_payment_attempt_id":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee","mv_stage":"e5a-test"},"client_reference_id":"11111111-2222-4333-8444-555555555555","expires_at":1793651520,"success_url":"https://preview.example.invalid/booking/status?checkout=complete","cancel_url":"https://preview.example.invalid/booking/status?checkout=cancelled"},"idempotencyKey":"cs:11111111-2222-4333-8444-555555555555:1","expiresAtSec":1793651520}';

const reply = (mode, b, extra = {}) => {
  const id = mode === "live" ? "cs_live_a1B2c3" : "cs_test_a1B2c3";
  return { object: "checkout.session", id, livemode: mode === "live", mode: "payment", status: "open", amount_total: 14000, currency: "usd",
    client_reference_id: INTENT, metadata: { ...b.params.metadata }, expires_at: b.expiresAtSec, url: `https://checkout.stripe.com/c/pay/${id}`, ...extra };
};

test("C1 TEST builder output is byte-for-byte the pre-C126 output (default and explicit mode)", () => {
  assert.equal(JSON.stringify(buildCheckoutSessionParams(op(), { nowMs: NOW, returnUrl: RETURN_URL })), GOLDEN_TEST);
  assert.equal(JSON.stringify(buildCheckoutSessionParams(op(), { nowMs: NOW, returnUrl: RETURN_URL, mode: "test" })), GOLDEN_TEST);
});

test("C2 LIVE builder: same contract, LIVE product label and stage only; all other fields identical to TEST", () => {
  const t = buildCheckoutSessionParams(op(), { nowMs: NOW, returnUrl: RETURN_URL });
  const l = buildCheckoutSessionParams(op(), { nowMs: NOW, returnUrl: RETURN_URL, mode: "live" });
  assert.equal(l.ok, true);
  assert.equal(l.params.line_items[0].price_data.product_data.name, "maraVilla direct booking");
  assert.equal(l.params.metadata.mv_stage, "c126-live");
  assert.equal(l.params.payment_intent_data.metadata.mv_stage, "c126-live");
  assert.equal(l.params.payment_intent_data.capture_method, "manual");
  const strip = (b) => JSON.parse(JSON.stringify(b).replaceAll("maraVilla direct booking (TEST)", "N").replaceAll("maraVilla direct booking", "N")
    .replaceAll("e5a-test", "S").replaceAll("c126-live", "S"));
  assert.deepEqual(strip(l), strip(t));
  // existing row validation is unchanged in LIVE
  assert.deepEqual(buildCheckoutSessionParams(op({ amountMinor: -1 }), { nowMs: NOW, returnUrl: RETURN_URL, mode: "live" }), { ok: false, code: "AMOUNT_INVALID" });
});

test("C2b LIVE builder is USD-only; TEST currency behaviour unchanged", () => {
  assert.equal(buildCheckoutSessionParams(op({ currency: "USD" }), { nowMs: NOW, returnUrl: RETURN_URL, mode: "live" }).ok, true);
  for (const c of ["MXN", "CAD"]) {
    assert.deepEqual(buildCheckoutSessionParams(op({ currency: c }), { nowMs: NOW, returnUrl: RETURN_URL, mode: "live" }), { ok: false, code: "LIVE_CURRENCY_NOT_ALLOWED" }, c);
    assert.equal(buildCheckoutSessionParams(op({ currency: c }), { nowMs: NOW, returnUrl: RETURN_URL }).ok, true, `TEST ${c}`);
  }
  // the generic syntax check still runs first in both modes
  for (const m of ["test", "live"]) assert.deepEqual(buildCheckoutSessionParams(op({ currency: "usd" }), { nowMs: NOW, returnUrl: RETURN_URL, mode: m }), { ok: false, code: "CURRENCY_INVALID" }, m);
});

test("C3 invalid mode is refused first, by builder and validator", () => {
  for (const m of ["", "LIVE", "Test", "prod", null, 1]) {
    assert.deepEqual(buildCheckoutSessionParams(op(), { nowMs: NOW, returnUrl: RETURN_URL, mode: m }), { ok: false, code: "MODE_INVALID" }, String(m));
    assert.equal(validateCreatedSession({}, op(), {}, { mode: m }), "REPLY_MODE_INVALID", String(m));
  }
});

test("C4 reply validation per mode; a reply of the other mode is refused (mismatch)", () => {
  const bt = buildCheckoutSessionParams(op(), { nowMs: NOW, returnUrl: RETURN_URL });
  const bl = buildCheckoutSessionParams(op(), { nowMs: NOW, returnUrl: RETURN_URL, mode: "live" });
  assert.equal(validateCreatedSession(reply("test", bt), op(), bt), null);
  assert.equal(validateCreatedSession(reply("test", bt), op(), bt, { mode: "test" }), null);
  assert.equal(validateCreatedSession(reply("live", bl), op(), bl, { mode: "live" }), null);
  // TEST codes unchanged
  assert.equal(validateCreatedSession(reply("live", bt), op(), bt), "REPLY_NOT_A_TEST_SESSION");
  assert.equal(validateCreatedSession(reply("test", bt, { livemode: true }), op(), bt), "REPLY_LIVEMODE");
  // LIVE refuses TEST-shaped replies
  assert.equal(validateCreatedSession(reply("test", bl), op(), bl, { mode: "live" }), "REPLY_NOT_A_LIVE_SESSION");
  assert.equal(validateCreatedSession(reply("live", bl, { livemode: false }), op(), bl, { mode: "live" }), "REPLY_NOT_LIVEMODE");
  assert.equal(validateCreatedSession(reply("live", bl, { livemode: undefined }), op(), bl, { mode: "live" }), "REPLY_NOT_LIVEMODE");
  // LIVE only: mv_stage must be the LIVE stage the builder set
  const md = bl.params.metadata;
  assert.equal(validateCreatedSession(reply("live", bl, { metadata: { ...md, mv_stage: "e5a-test" } }), op(), bl, { mode: "live" }), "REPLY_STAGE");
  assert.equal(validateCreatedSession(reply("live", bl, { metadata: { ...md, mv_stage: "c126-LIVE" } }), op(), bl, { mode: "live" }), "REPLY_STAGE");
  const { mv_stage: _drop, ...noStage } = md;
  assert.equal(validateCreatedSession(reply("live", bl, { metadata: noStage }), op(), bl, { mode: "live" }), "REPLY_STAGE");
  // TEST adds no stage requirement: a TEST reply with missing or other mv_stage still passes, as before C126
  const tmd = bt.params.metadata;
  const { mv_stage: _t, ...tNoStage } = tmd;
  assert.equal(validateCreatedSession(reply("test", bt, { metadata: tNoStage }), op(), bt), null);
  assert.equal(validateCreatedSession(reply("test", bt, { metadata: { ...tmd, mv_stage: "other" } }), op(), bt), null);
  // the remaining checks still apply in LIVE
  assert.equal(validateCreatedSession(reply("live", bl, { amount_total: 13999 }), op(), bl, { mode: "live" }), "REPLY_AMOUNT");
  assert.equal(validateCreatedSession(reply("live", bl, { url: "https://evil.example/x" }), op(), bl, { mode: "live" }), "REPLY_URL");
});

test("C5 executor: TEST sends once as before; LIVE and invalid modes never touch the client", async () => {
  const calls = [];
  const bt = buildCheckoutSessionParams(op(), { nowMs: NOW, returnUrl: RETURN_URL });
  const stripe = { checkout: { sessions: { create: async (params, opts) => { calls.push({ params, opts }); return reply("test", bt); } } } };
  const ok = await createCheckoutSessionExecutor({ stripe, nowMs: NOW, returnUrl: RETURN_URL })(op());
  assert.equal(ok.status, "succeeded");
  assert.equal(calls.length, 1);
  assert.equal(JSON.stringify(calls[0].params), JSON.stringify(JSON.parse(GOLDEN_TEST).params));
  const never = { checkout: { sessions: { create: async () => { throw new Error("must not be called"); } } } };
  assert.deepEqual(await createCheckoutSessionExecutor({ stripe: never, nowMs: NOW, returnUrl: RETURN_URL, mode: "live" })(op()),
    { status: "failed_definite", errorCode: "NOT_SENT_LIVE_NOT_ACTIVATED" });
  for (const m of ["", "LIVE", "prod"]) {
    assert.deepEqual(await createCheckoutSessionExecutor({ stripe: never, nowMs: NOW, returnUrl: RETURN_URL, mode: m })(op()),
      { status: "failed_definite", errorCode: "NOT_SENT_MODE_INVALID" });
  }
});

test("C6 the runtime LIVE gate is still closed, and the only executor caller passes no mode (TEST)", () => {
  assert.equal(checkoutModeGate({ MV_CHECKOUT_MODE: "live" }).ok, false);
  assert.equal(stripeTestGate({ MV_CHECKOUT_MODE: "live" }).ok, false);
  const src = readFileSync(new URL("../lib/checkout/stripe-test-mode.js", import.meta.url), "utf8");
  assert.match(src, /refuse\("LIVE_NOT_ACTIVATED"\)/);
  const wh = readFileSync(new URL("../lib/checkout/stripe-test-webhook.js", import.meta.url), "utf8");
  const callers = wh.match(/createCheckoutSessionExecutor\(\{[^}]*\}\)/g) || [];
  assert.equal(callers.length, 1);
  assert.doesNotMatch(callers[0], /mode/);
});
