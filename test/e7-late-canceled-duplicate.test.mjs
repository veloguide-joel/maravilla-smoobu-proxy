// E7 late canceled duplicate — the pure server-read binding (lib/checkout/stripe-test-mode.js bindCanceledDuplicate).
// Offline: fake Stripe-shaped objects only (test/e5a-fixtures.mjs). The DATABASE half is covered in
// test/db/e7-checkout-test-release.test.mjs. bindAuthorization's own outcomes are re-checked unchanged here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bindAuthorization, bindCanceledDuplicate, dbAmount } from "../lib/checkout/stripe-test-mode.js";
import { authFixture, INTENT, ATTEMPT } from "./e5a-fixtures.mjs";

const CANCELED = { pi: { status: "canceled", amount_capturable: 0, amount_received: 0 }, charge: { amount: 320000, currency: "mxn" } };
const fx = (o = {}) => {
  const f = authFixture({ session: o.session, top: o.top, charge: { ...CANCELED.charge, ...(o.charge || {}) }, pi: { ...CANCELED.pi, ...(o.pi || {}) } });
  if (o.attempt) Object.assign(f.attempt, o.attempt);
  if (o.mutate) o.mutate(f);
  return f;
};

test("canceled duplicate binding: exact canceled authorization -> frozen binding; bindAuthorization itself still answers AUTHORIZATION_CANCELED", () => {
  assert.deepEqual(bindAuthorization(fx()), { ok: false, code: "AUTHORIZATION_CANCELED" });
  const r = bindCanceledDuplicate(fx());
  assert.equal(r.ok, true);
  assert.deepEqual(r.binding, { eventId: "evt_T1", intentId: INTENT, attemptId: ATTEMPT, sessionId: "cs_test_a1B2c3", paymentIntentId: "pi_T1", chargeId: "ch_T1",
    amountMinor: 320000, currency: "MXN" });
  assert.ok(Object.isFrozen(r.binding));
  // amount_refunded is NOT consulted (notification acknowledgement only, never a release proof): 0 and the full amount both bind
  assert.equal(bindCanceledDuplicate(fx({ charge: { amount_refunded: 320000 } })).ok, true);
  assert.equal(bindCanceledDuplicate(fx({ charge: { amount_refunded: 0 } })).ok, true);
  // an expanded session.payment_intent object binds like its id (same reading as bindAuthorization)
  assert.equal(bindCanceledDuplicate(fx({ session: { payment_intent: { id: "pi_T1" } } })).ok, true);
});

test("canceled duplicate binding: only bindAuthorization's AUTHORIZATION_CANCELED outcome is eligible", () => {
  // active authorization (E3 duplicate path), other statuses, and every identity refusal that precedes the status check
  for (const o of [{ pi: { status: "requires_capture", amount_capturable: 320000 } }, { pi: { status: "succeeded" } }, { pi: { status: "processing" } },
    { top: { accountVerified: false } }, { top: { attempt: null } }, { session: { id: "cs_test_other" } }, { session: { livemode: true } },
    { session: { status: "open" } }, { session: { metadata: { mv_intent_id: INTENT, mv_payment_attempt_id: "aaaaaaaa-bbbb-4ccc-8ddd-000000000000" } } },
    { session: { client_reference_id: ATTEMPT } }, { session: { mode: "setup" } }, { session: { payment_intent: null } }, { pi: { id: "pi_OTHER" } },
    { pi: { livemode: true } }, { pi: { capture_method: "automatic" } }, { pi: { metadata: { mv_intent_id: INTENT } } }]) {
    assert.deepEqual(bindCanceledDuplicate(fx(o)), { ok: false, code: "NOT_A_CANCELED_AUTHORIZATION" }, JSON.stringify(o));
  }
  for (const bad of [undefined, null, 7, "x", []]) assert.deepEqual(bindCanceledDuplicate(bad), { ok: false, code: "NOT_A_CANCELED_AUTHORIZATION" });
});

test("canceled duplicate binding: canceled-state, money, charge and currency facts are strict (no coercion)", () => {
  const cases = [
    [{ pi: { amount_received: 1 } }, "PAYMENT_INTENT_NOT_CLEANLY_CANCELED"], [{ pi: { amount_capturable: 320000 } }, "PAYMENT_INTENT_NOT_CLEANLY_CANCELED"],
    [{ pi: { amount_received: "0" } }, "PAYMENT_INTENT_NOT_CLEANLY_CANCELED"], [{ pi: { amount_capturable: null } }, "PAYMENT_INTENT_NOT_CLEANLY_CANCELED"],
    [{ pi: { amount: "320000" } }, "PAYMENT_INTENT_AMOUNT_UNREADABLE"], [{ pi: { amount: 320000.5 } }, "PAYMENT_INTENT_AMOUNT_UNREADABLE"],
    [{ pi: { amount: 0 } }, "PAYMENT_INTENT_AMOUNT_UNREADABLE"], [{ pi: { currency: "mx" } }, "PAYMENT_INTENT_AMOUNT_UNREADABLE"],
    [{ pi: { currency: null } }, "PAYMENT_INTENT_AMOUNT_UNREADABLE"],
    [{ pi: { amount: 320001 } }, "SESSION_MONEY_MISMATCH"], [{ session: { amount_total: 320001 } }, "SESSION_MONEY_MISMATCH"],
    [{ session: { amount_total: "320000" } }, "SESSION_MONEY_MISMATCH"], [{ session: { currency: "usd" } }, "SESSION_MONEY_MISMATCH"],
    [{ session: { amount_total: undefined } }, "SESSION_MONEY_MISMATCH"],
    [{ attempt: { amount_minor: "320001" } }, "ATTEMPT_MONEY_MISMATCH"], [{ attempt: { amount_minor: "0320000" } }, "ATTEMPT_MONEY_MISMATCH"],
    [{ attempt: { amount_minor: "3.2e5" } }, "ATTEMPT_MONEY_MISMATCH"], [{ attempt: { currency: "USD" } }, "ATTEMPT_MONEY_MISMATCH"],
    [{ attempt: { currency: null } }, "ATTEMPT_MONEY_MISMATCH"],
    [{ pi: { latest_charge: null } }, "CHARGE_NOT_BOUND"], [{ pi: { latest_charge: "ch_T1" } }, "CHARGE_NOT_BOUND"],
    [{ charge: { object: "refund" } }, "CHARGE_NOT_BOUND"], [{ charge: { id: "re_1" } }, "CHARGE_NOT_BOUND"], [{ charge: { payment_intent: "pi_OTHER" } }, "CHARGE_NOT_BOUND"],
    [{ charge: { livemode: true } }, "CHARGE_LIVEMODE"], [{ charge: { livemode: undefined } }, "CHARGE_LIVEMODE"],
    [{ charge: { captured: true } }, "CHARGE_CAPTURED"], [{ charge: { captured: undefined } }, "CHARGE_CAPTURED"],
    [{ charge: { amount_captured: 1 } }, "CHARGE_CAPTURED"], [{ charge: { amount_captured: "0" } }, "CHARGE_CAPTURED"],
    [{ charge: { amount: 320001 } }, "CHARGE_MONEY_MISMATCH"], [{ charge: { amount: undefined } }, "CHARGE_MONEY_MISMATCH"],
    [{ charge: { currency: "usd" } }, "CHARGE_MONEY_MISMATCH"], [{ charge: { currency: undefined } }, "CHARGE_MONEY_MISMATCH"]
  ];
  for (const [o, code] of cases) assert.deepEqual(bindCanceledDuplicate(fx(o)), { ok: false, code }, JSON.stringify(o));
  // case-normalized currency: provider lowercase vs database uppercase agree; mixed case agrees too
  assert.equal(bindCanceledDuplicate(fx({ session: { currency: "MXN" }, pi: { currency: "Mxn" }, charge: { currency: "mxN" } })).ok, true);
});

test("dbAmount: only positive safe integers or canonical digit strings", () => {
  for (const [v, want] of [[320000, 320000], ["320000", 320000], ["0", null], [0, null], [-1, null], ["-1", null], ["01", null], [" 1", null], ["1e3", null],
    [1.5, null], [null, null], [undefined, null], ["99999999999999999", null], [Number.MAX_SAFE_INTEGER + 1, null]]) assert.equal(dbAmount(v), want, String(v));
});
