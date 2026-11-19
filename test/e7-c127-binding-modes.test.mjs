// C127 — per-mode authorization / canceled-duplicate binding proofs (pure). TEST is exactly the E5a / E7 behaviour (golden
// matrix hash captured from untouched e7-test 86b824d9). LIVE proofs are exercised offline only: the only runtime caller passes
// no mode, and the runtime mode gate still refuses LIVE. Offline: plain objects only; no network, no SDK client, no keys.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import * as m from "../lib/checkout/stripe-test-mode.js";
import { authFixture, INTENT, ATTEMPT } from "./e5a-fixtures.mjs";

const { bindAuthorization, bindCanceledDuplicate, isTestSessionId, isSessionIdForMode, checkoutModeGate, stripeTestGate } = m;


function matrix(m, authFixture) {
  const { bindAuthorization, bindCanceledDuplicate, isTestSessionId } = m;
  const cases = [
    {}, { top: { accountVerified: false } }, { top: { attempt: null } }, { session: { livemode: true } }, { session: { livemode: undefined } },
    { session: { id: "cs_live_a1B2c3" } }, { session: { mode: "setup" } }, { session: { metadata: {} } }, { session: { status: "open" } },
    { session: { payment_intent: null } }, { pi: { id: "pi_X" } }, { pi: { livemode: true } }, { pi: { metadata: {} } },
    { pi: { capture_method: "automatic" } }, { pi: { status: "succeeded" } }, { pi: { status: "processing" } }, { charge: { livemode: true } },
    { charge: { captured: true } }, { charge: { payment_method_details: {} } }, { pi: { amount: 1 } }, { pi: { currency: "usd" } },
    { session: { metadata: { mv_intent_id: "11111111-2222-4333-8444-555555555555", mv_payment_attempt_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", mv_stage: "c126-live" } } },
  ];
  const canceled = (o = {}) => ({ ...o, pi: { status: "canceled", amount_received: 0, amount_capturable: 0, ...(o.pi || {}) } });
  const out = [];
  for (const c of cases) out.push(["auth", c, bindAuthorization(authFixture(c))]);
  for (const c of [{}, { charge: { amount: 320000, currency: "mxn" } }, { pi: { amount_received: 1 } }, { charge: { livemode: true } }, { charge: { captured: true } }, { pi: { currency: "usd" } },
    { session: { id: "cs_live_a1B2c3" } }, { session: { livemode: true } }, { top: { attempt: { id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", intent_id: "11111111-2222-4333-8444-555555555555", checkout_session_id: "cs_test_a1B2c3", amount_minor: "1", currency: "MXN" } } }]) {
    out.push(["dup", c, bindCanceledDuplicate(authFixture(canceled(c)))]);
  }
  out.push(["dup-bad", bindCanceledDuplicate(null)]);
  for (const s of ["cs_test_a1", "cs_live_a1", "", null, "cs_test_", "pi_1"]) out.push(["isTest", s, isTestSessionId(s)]);
  const json = JSON.stringify(out);
  return { json, sha256: createHash("sha256").update(json).digest("hex") };
}

const GOLDEN_TEST_MATRIX_SHA256 = "842ac6606e366a263fcdc444e70e790f21c5161fb0efa3401bcc0ce0b51baa97";

// A LIVE-shaped server read: cs_live_, livemode true everywhere, LIVE stage, USD.
const LIVE_SID = "cs_live_a1B2c3";
const LIVE_MD = { mv_intent_id: INTENT, mv_payment_attempt_id: ATTEMPT, mv_stage: "c126-live" };
const live = (o = {}) => authFixture({
  session: { id: LIVE_SID, livemode: true, metadata: { ...LIVE_MD }, currency: "usd", ...(o.session || {}) },
  pi: { livemode: true, metadata: { ...LIVE_MD }, currency: "usd", ...(o.pi || {}) },
  charge: { livemode: true, ...(o.charge || {}) },
  top: { mode: "live", attempt: { id: ATTEMPT, intent_id: INTENT, checkout_session_id: LIVE_SID, amount_minor: "320000", currency: "USD" }, ...(o.top || {}) }
});
const canceled = (o = {}) => ({ ...o, pi: { status: "canceled", amount_received: 0, amount_capturable: 0, ...(o.pi || {}) },
  charge: { amount: 320000, currency: "usd", ...(o.charge || {}) } });

test("B1 TEST behaviour of bindAuthorization / bindCanceledDuplicate / isTestSessionId is identical (golden matrix)", () => {
  assert.equal(matrix(m, authFixture).sha256, GOLDEN_TEST_MATRIX_SHA256);
  // explicit mode "test" is the same as no mode
  const explicit = (o) => authFixture({ ...o, top: { mode: "test", ...(o.top || {}) } });
  assert.equal(matrix(m, explicit).sha256, GOLDEN_TEST_MATRIX_SHA256);
});

test("B2 invalid mode is refused first", () => {
  for (const mode of ["", "LIVE", "prod", null, 1]) {
    assert.deepEqual(bindAuthorization(authFixture({ top: { mode } })), { ok: false, code: "MODE_INVALID" }, String(mode));
    assert.deepEqual(bindCanceledDuplicate(authFixture({ top: { mode } })), { ok: false, code: "NOT_A_CANCELED_AUTHORIZATION" }, String(mode));
    assert.equal(isSessionIdForMode("cs_test_a1", mode), false);
  }
});

test("B3 LIVE authorization binds only a fully LIVE, LIVE-stage, USD read", () => {
  const ok = bindAuthorization(live());
  assert.equal(ok.ok, true);
  assert.equal(ok.event.livemode, true);
  assert.equal(ok.event.sessionId, LIVE_SID);
  for (const [o, code] of [
    [{ session: { livemode: false } }, "SESSION_NOT_LIVEMODE"], [{ session: { livemode: undefined } }, "SESSION_NOT_LIVEMODE"],
    [{ pi: { livemode: false } }, "PAYMENT_INTENT_NOT_LIVEMODE"], [{ charge: { livemode: false } }, "CHARGE_NOT_LIVEMODE"],
    [{ session: { metadata: { ...LIVE_MD, mv_stage: "e5a-test" } } }, "SESSION_STAGE_MISMATCH"],
    [{ session: { metadata: { mv_intent_id: INTENT, mv_payment_attempt_id: ATTEMPT } } }, "SESSION_STAGE_MISMATCH"],
    [{ pi: { metadata: { ...LIVE_MD, mv_stage: "x" } } }, "PAYMENT_INTENT_STAGE_MISMATCH"],
    [{ pi: { metadata: { mv_intent_id: INTENT, mv_payment_attempt_id: ATTEMPT } } }, "PAYMENT_INTENT_STAGE_MISMATCH"],
    [{ pi: { currency: "mxn" } }, "LIVE_CURRENCY_NOT_ALLOWED"], [{ pi: { currency: "cad" } }, "LIVE_CURRENCY_NOT_ALLOWED"],
    [{ pi: { status: "succeeded" } }, "CAPTURED_BEFORE_RESERVATION"], [{ pi: { capture_method: "automatic" } }, "NOT_MANUAL_CAPTURE"]
  ]) assert.deepEqual(bindAuthorization(live(o)), { ok: false, code }, code);
});

test("B4 cross-mode reads are refused in both directions", () => {
  // a TEST read under LIVE
  assert.deepEqual(bindAuthorization(authFixture({ top: { mode: "live" } })), { ok: false, code: "SESSION_NOT_BOUND" });
  // a TEST read whose attempt was (somehow) bound to a cs_test_ id but claims LIVE flags is still refused under LIVE
  assert.deepEqual(bindAuthorization(authFixture({ session: { livemode: true }, top: { mode: "live" } })), { ok: false, code: "SESSION_NOT_BOUND" });
  // a LIVE read under TEST (default and explicit)
  for (const mode of [undefined, "test"]) {
    assert.deepEqual(bindAuthorization(live({ top: { mode } })), { ok: false, code: "SESSION_LIVEMODE" }, String(mode));
    assert.deepEqual(bindCanceledDuplicate(live(canceled({ top: { mode } }))), { ok: false, code: "NOT_A_CANCELED_AUTHORIZATION" }, String(mode));
  }
  assert.equal(isSessionIdForMode("cs_test_a1", "test"), true);
  assert.equal(isSessionIdForMode("cs_live_a1", "test"), false);
  assert.equal(isSessionIdForMode("cs_live_a1", "live"), true);
  assert.equal(isSessionIdForMode("cs_test_a1", "live"), false);
  for (const s of ["cs_test_a1", "cs_live_a1", "", null]) assert.equal(isSessionIdForMode(s, "test"), isTestSessionId(s));
});

test("B5 LIVE canceled-duplicate binding: same rules as TEST plus LIVE identity, stage and USD", () => {
  const ok = bindCanceledDuplicate(live(canceled()));
  assert.equal(ok.ok, true);
  assert.equal(ok.binding.sessionId, LIVE_SID);
  assert.equal(ok.binding.currency, "USD");
  for (const [o, code] of [
    [{ charge: { livemode: false } }, "CHARGE_NOT_LIVEMODE"], [{ charge: { captured: true } }, "CHARGE_CAPTURED"],
    [{ pi: { amount_received: 1 } }, "PAYMENT_INTENT_NOT_CLEANLY_CANCELED"],
    [{ pi: { currency: "mxn" }, session: { currency: "mxn" } }, "LIVE_CURRENCY_NOT_ALLOWED"],
    [{ session: { metadata: { ...LIVE_MD, mv_stage: "e5a-test" } } }, "NOT_A_CANCELED_AUTHORIZATION"],
    [{ pi: { livemode: false } }, "NOT_A_CANCELED_AUTHORIZATION"]
  ]) assert.deepEqual(bindCanceledDuplicate(live(canceled(o))), { ok: false, code }, code);
});

test("B6 the runtime LIVE gate is still closed and the runtime callers pass no mode (TEST)", () => {
  assert.equal(checkoutModeGate({ MV_CHECKOUT_MODE: "live" }).ok, false);
  assert.equal(stripeTestGate({ MV_CHECKOUT_MODE: "live" }).ok, false);
  const wh = readFileSync(new URL("../lib/checkout/stripe-test-webhook.js", import.meta.url), "utf8");
  const calls = wh.match(/bind(Authorization|CanceledDuplicate)\(\{[^}]*\}\)/g) || [];
  assert.equal(calls.length, 2);
  for (const c of calls) assert.doesNotMatch(c, /mode/);
  assert.doesNotMatch(wh, /isSessionIdForMode/);
  const core = readFileSync(new URL("../lib/checkout/intent-api-core.js", import.meta.url), "utf8");
  assert.doesNotMatch(core, /isSessionIdForMode/);
});
