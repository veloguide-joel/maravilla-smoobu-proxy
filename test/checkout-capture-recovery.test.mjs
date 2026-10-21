// Stage E3.2 — failed-capture recovery in the E3 state machine (pure; no I/O).
// Definite vs ambiguous capture failure, explicit recovery legs (cancel reservation + settle authorization),
// reconcile-before-retry for ambiguous capture/void/cancel, and the paid-booking accounting rule.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createIntent, transition, STATES as S, DEFAULT_CONFIG, captureKey, voidKey, isConfirmedPaid } from "../lib/checkout/intent-state.js";

const T0 = Date.UTC(2026, 9, 21, 15, 0, 0);
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const PRICE = { listingId: 603566, from: "2026-12-20", to: "2026-12-24", guests: 2, nights: 4, currency: "MXN",
  standardTotalMinor: 640000, eligibleMinor: 640000, discountMinor: 64000, finalTotalMinor: 576000,
  policyVersion: "direct-v1", rateBps: 1000, lines: [], charge: { currency: "mxn", amountMinor: 576000, quantity: 1 }, quoteHash: "a".repeat(64) };
const AUTH = { type: "PAYMENT_AUTHORIZED", paymentIntentId: "pi_1", sessionId: "cs_1", amountMinor: 576000, currency: "mxn", livemode: false,
  authorizationCreatedAt: T0 + 4 * MIN, captureBefore: T0 + 4 * MIN + 7 * DAY };
const RES = { reservationId: 9001, listingId: 603566, from: "2026-12-20", to: "2026-12-24", totalMinor: 576000, currency: "MXN" };

function drive(intent, steps) {
  let cur = intent;
  for (const [ev, m] of steps) {
    const r = transition(cur, ev, { now: T0 + m * MIN });
    assert.equal(r.ok, true, `${ev.type} from ${cur.status}: ${r.error}`);
    cur = r.intent;
  }
  return cur;
}
const reserved = () => drive(createIntent({ id: "int_1", ref: "MV-7K3Q9P", listingId: 603566, from: "2026-12-20", to: "2026-12-24", guests: 2, now: T0 }), [
  [{ type: "PRICE_CONFIRMED", price: PRICE }, 0], [{ type: "DETAILS_COLLECTED" }, 1], [{ type: "CHECKOUT_PREPARED", sessionId: "cs_1" }, 2],
  [AUTH, 5], [{ type: "RESERVATION_STARTED", workerId: "w", recheck: { bookable: true, priceSame: true } }, 6],
  [{ type: "RESERVATION_DISPATCHED", workerId: "w" }, 6], [{ type: "RESERVATION_SUCCEEDED", reservation: RES }, 7]]);
const types = (r) => r.effects.map((e) => e.type);
const at = (i, ev, m) => transition(i, ev, { now: T0 + m * MIN });

test("definite capture refusal: explicit recovery legs, attempt-1 keys unchanged", () => {
  const i = reserved();
  assert.equal(i.counters.captureAttempts, 1);
  const r = at(i, { type: "CAPTURE_FAILED", definite: true, code: "card_declined" }, 8);
  assert.equal(r.intent.status, S.CAPTURE_FAILED);
  assert.deepEqual(types(r), ["hostaway.cancel_reservation", "stripe.void_payment_intent", "alert.owner"]);
  assert.deepEqual(r.intent.settlement, { reservationCancelled: false, authorizationSettled: false });
  assert.equal(r.effects[1].idempotencyKey, voidKey("int_1", "pi_1"));
  assert.equal(r.effects[1].idempotencyKey, "void:int_1:pi_1");
  assert.equal(captureKey("int_1", "pi_1"), "cap:int_1:pi_1");
  assert.equal(isConfirmedPaid(r.intent), false);
});

test("ambiguous capture is never treated as a failure: only an authoritative read moves it", () => {
  const u = at(reserved(), { type: "CAPTURE_OUTCOME_UNKNOWN", code: "TIMEOUT" }, 8);
  assert.equal(u.intent.status, S.CAPTURE_UNKNOWN);
  assert.deepEqual(types(u), ["stripe.retrieve_payment_intent"], "no cancel, no void, no capture before reconciliation");
  assert.equal(at(u.intent, { type: "CAPTURE_FAILED", definite: true }, 9).error, "ILLEGAL_TRANSITION");
  assert.equal(at(u.intent, { type: "RESERVATION_CANCELLED" }, 9).error, "ILLEGAL_TRANSITION");
  // read: captured -> paid booking
  assert.equal(at(u.intent, { type: "RECONCILED_CAPTURE_SUCCEEDED", amountMinor: 576000, currency: "MXN" }, 9).intent.status, S.PAYMENT_CAPTURED);
  // read: still authorized -> exactly one new capture, with its own key
  const again = at(u.intent, { type: "RECONCILED_STILL_AUTHORIZED" }, 9);
  assert.deepEqual([again.intent.status, types(again)], [S.RESERVATION_CONFIRMED, ["stripe.capture_payment_intent"]]);
  assert.equal(again.effects[0].idempotencyKey, captureKey("int_1", "pi_1", 2));
  assert.notEqual(again.effects[0].idempotencyKey, captureKey("int_1", "pi_1"));
  // read: authorization gone -> recovery with the authorization leg already settled (no void)
  const gone = at(u.intent, { type: "RECONCILED_AUTHORIZATION_GONE" }, 9);
  assert.deepEqual(types(gone), ["hostaway.cancel_reservation", "alert.owner"]);
  assert.deepEqual(gone.intent.settlement, { reservationCancelled: false, authorizationSettled: true });
});

test("a refusal on a retry, or 'unexpected state', may hide an earlier success: reconcile, never cancel", () => {
  const u = at(reserved(), { type: "CAPTURE_OUTCOME_UNKNOWN" }, 8);
  const retry = at(u.intent, { type: "RECONCILED_STILL_AUTHORIZED" }, 9);
  const refused = at(retry.intent, { type: "CAPTURE_FAILED", definite: true, code: "card_declined" }, 10);
  assert.deepEqual([refused.intent.status, types(refused)], [S.CAPTURE_UNKNOWN, ["stripe.retrieve_payment_intent"]]);
  const odd = at(reserved(), { type: "CAPTURE_FAILED", definite: true, code: "payment_intent_unexpected_state" }, 8);
  assert.deepEqual([odd.intent.status, types(odd)], [S.CAPTURE_UNKNOWN, ["stripe.retrieve_payment_intent"]]);
});

test("capture retries are bounded", () => {
  let i = at(reserved(), { type: "CAPTURE_OUTCOME_UNKNOWN" }, 8).intent;
  for (let n = 2; n <= DEFAULT_CONFIG.maxCaptureAttempts; n++) {
    i = at(i, { type: "RECONCILED_STILL_AUTHORIZED" }, 8 + n).intent;
    i = at(i, { type: "CAPTURE_OUTCOME_UNKNOWN" }, 8 + n).intent;
  }
  const r = at(i, { type: "RECONCILED_STILL_AUTHORIZED" }, 30);
  assert.deepEqual([r.intent.status, r.intent.reasonCode], [S.RECONCILIATION_REQUIRED, "CAPTURE_RETRIES_EXHAUSTED"]);
});

test("cancellation pending / void pending: dates protected until BOTH legs settle, in either order", () => {
  const f = at(reserved(), { type: "CAPTURE_FAILED", definite: true, code: "card_declined" }, 8).intent;
  const cancelFirst = drive(f, [[{ type: "RESERVATION_CANCELLED" }, 9]]);
  assert.deepEqual([cancelFirst.status, cancelFirst.settlement], [S.CAPTURE_FAILED, { reservationCancelled: true, authorizationSettled: false }]);
  assert.equal(drive(cancelFirst, [[{ type: "VOID_SUCCEEDED" }, 10]]).status, S.CANCELLED);
  const voidFirst = drive(f, [[{ type: "VOID_SUCCEEDED" }, 9]]);
  assert.deepEqual([voidFirst.status, voidFirst.settlement], [S.CAPTURE_FAILED, { reservationCancelled: false, authorizationSettled: true }]);
  const done = at(voidFirst, { type: "RESERVATION_CANCELLED" }, 10);
  assert.deepEqual([done.intent.status, types(done)], [S.CANCELLED, ["guest.notify"]]);
  // repeated settle reports are harmless no-ops
  const dup = at(voidFirst, { type: "VOID_SUCCEEDED" }, 10);
  assert.equal(dup.duplicate, true);
  // a verified-gone authorization settles that leg as well as a void
  assert.equal(drive(f, [[{ type: "RECONCILED_AUTHORIZATION_GONE" }, 9], [{ type: "RESERVATION_CANCELLED" }, 10]]).status, S.CANCELLED);
});

test("ambiguous void: read first; still authorized -> one new void with its own key; refused void -> read, not re-sent", () => {
  const f = at(reserved(), { type: "CAPTURE_FAILED", definite: true, code: "card_declined" }, 8).intent;
  const u = at(f, { type: "VOID_OUTCOME_UNKNOWN" }, 9);
  assert.deepEqual([u.intent.status, types(u)], [S.CAPTURE_FAILED, ["stripe.retrieve_payment_intent"]]);
  const still = at(u.intent, { type: "RECONCILED_STILL_AUTHORIZED" }, 10);
  assert.deepEqual(types(still), ["stripe.void_payment_intent"]);
  assert.equal(still.effects[0].idempotencyKey, voidKey("int_1", "pi_1", 2));
  const refused = at(f, { type: "VOID_FAILED" }, 9);
  assert.deepEqual(types(refused), ["stripe.retrieve_payment_intent"], "no blind re-void");
  // money captured after all (read during cancellation): owner review, never automatic refund/cancel
  const captured = at(u.intent, { type: "RECONCILED_CAPTURE_SUCCEEDED", amountMinor: 576000, currency: "MXN" }, 10);
  assert.deepEqual([captured.intent.status, captured.intent.reasonCode], [S.RECONCILIATION_REQUIRED, "CAPTURED_DURING_CANCELLATION"]);
  // void attempts are bounded
  let i = f;
  for (let n = 1; n < DEFAULT_CONFIG.maxVoidAttempts; n++) i = at(i, { type: "RECONCILED_STILL_AUTHORIZED" }, 10 + n).intent;
  assert.equal(at(i, { type: "RECONCILED_STILL_AUTHORIZED" }, 30).intent.reasonCode, "VOID_EXHAUSTED");
});

test("ambiguous cancellation: read first; still active -> cancel again (bounded); definite failure -> owner review", () => {
  const f = at(reserved(), { type: "CAPTURE_FAILED", definite: true, code: "card_declined" }, 8).intent;
  const u = at(f, { type: "RESERVATION_CANCEL_OUTCOME_UNKNOWN" }, 9);
  assert.deepEqual([u.intent.status, types(u)], [S.CAPTURE_FAILED, ["hostaway.retrieve_reservation"]]);
  assert.equal(u.effects[0].reservationId, "9001");
  const active = at(u.intent, { type: "RECONCILED_RESERVATION_STILL_ACTIVE" }, 10);
  assert.deepEqual(types(active), ["hostaway.cancel_reservation"]);
  assert.equal(active.effects[0].attempt, 2);
  let i = active.intent;
  for (let n = 3; n <= DEFAULT_CONFIG.maxCancelAttempts; n++) i = at(i, { type: "RECONCILED_RESERVATION_STILL_ACTIVE" }, 10 + n).intent;
  assert.equal(at(i, { type: "RECONCILED_RESERVATION_STILL_ACTIVE" }, 30).intent.reasonCode, "CANCEL_EXHAUSTED");
  assert.equal(at(f, { type: "RESERVATION_CANCEL_FAILED" }, 9).intent.status, S.RECONCILIATION_REQUIRED);
});

test("reservation_failed: ambiguous void is reconciled by a read, and a verified-gone authorization releases", () => {
  const authorized = drive(createIntent({ id: "int_2", ref: "MV-7K3Q9Q", listingId: 603566, from: "2026-12-20", to: "2026-12-24", guests: 2, now: T0 }), [
    [{ type: "PRICE_CONFIRMED", price: PRICE }, 0], [{ type: "DETAILS_COLLECTED" }, 1], [{ type: "CHECKOUT_PREPARED", sessionId: "cs_1" }, 2], [AUTH, 5]]);
  const failed = at(authorized, { type: "RESERVATION_STARTED", workerId: "w", recheck: { bookable: false } }, 6).intent;
  const u = at(failed, { type: "VOID_OUTCOME_UNKNOWN" }, 7);
  assert.deepEqual([u.intent.status, types(u)], [S.RESERVATION_FAILED, ["stripe.retrieve_payment_intent"]]);
  assert.equal(at(u.intent, { type: "RECONCILED_AUTHORIZATION_GONE" }, 8).intent.status, S.AUTHORIZATION_RELEASED);
  const still = at(u.intent, { type: "RECONCILED_STILL_AUTHORIZED" }, 8);
  assert.equal(still.effects[0].idempotencyKey, voidKey("int_2", "pi_1", 2));
});

test("authorization deadline passed with funds still held (read): recovery voids, never assumes the lapse", () => {
  const u = at(reserved(), { type: "CAPTURE_OUTCOME_UNKNOWN" }, 8).intent;
  const late = transition(u, { type: "RECONCILED_STILL_AUTHORIZED" }, { now: AUTH.captureBefore });
  assert.deepEqual([late.intent.status, late.intent.reasonCode], [S.CAPTURE_FAILED, "AUTHORIZATION_EXPIRED"]);
  assert.deepEqual(types(late), ["hostaway.cancel_reservation", "stripe.void_payment_intent", "alert.owner"]);
});

test("paid booking with a failed or ambiguous Hostaway accounting update stays a valid paid booking (never cancelled)", () => {
  const paid = drive(reserved(), [[{ type: "CAPTURE_SUCCEEDED", amountMinor: 576000, currency: "MXN" }, 8]]);
  assert.equal(isConfirmedPaid(paid), true);
  let i = paid;
  for (let n = 1; n < DEFAULT_CONFIG.maxOfflineChargeAttempts; n++) {
    const r = at(i, { type: "OFFLINE_CHARGE_FAILED" }, 9 + n);
    assert.equal(r.intent.status, S.PAYMENT_CAPTURED);
    assert.ok(!types(r).some((t) => t.startsWith("hostaway.cancel") || t.startsWith("stripe.void") || t.startsWith("stripe.capture")));
    i = r.intent;
  }
  const ex = at(i, { type: "OFFLINE_CHARGE_FAILED" }, 30);
  assert.deepEqual([ex.intent.status, ex.intent.reasonCode], [S.RECONCILIATION_REQUIRED, "OFFLINE_CHARGE_UNRECORDED"]);
  assert.ok(!types(ex).some((t) => t.startsWith("hostaway.cancel") || t.startsWith("stripe.void")));
  assert.equal(ex.intent.payment.capturedMinor, 576000, "money stays captured; accounting is reconciled, the stay is not cancelled");
});
