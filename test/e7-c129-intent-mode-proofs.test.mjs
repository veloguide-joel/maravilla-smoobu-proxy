// C129 — the intent's OWN recorded payment marker must be TEST before any capture, void or cancel request can be proven or
// built (previously only the provider evidence's livemode was checked; the mirror proof already required it). Pure: plain
// objects, a counting fake sender, no DB, no network, no SDK, no keys. Nothing is captured, voided, refunded or cancelled.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createIntent, transition, captureKey, voidKey } from "../lib/checkout/intent-state.js";
import { paymentIntentProofObservationV3, initialCaptureSendEligibility, buildCaptureRequest, validateCaptureRequest, stillAuthorizedV3Refusal } from "../lib/checkout/capture-proof.js";
import * as C from "../lib/checkout/compensation-proof.js";
import { mirrorIntentRefusal } from "../lib/checkout/mirror-proof.js";
import { checkoutModeGate, stripeTestGate } from "../lib/checkout/stripe-test-mode.js";

const MIN = 60000;
const T0 = Date.UTC(2026, 10, 2, 12, 0, 0);
const at = (m) => T0 + m * MIN;
const ATT = "11111111-2222-4333-8444-555555555555";
const PI = "pi_test_abc";
const PRICE = { version: "final-price-v1", quoteBasis: "x", listingId: 603566, from: "2026-12-20", to: "2026-12-24", guests: 2, nights: 4, currency: "USD",
  standardTotalMinor: 100000, eligibleMinor: 100000, discountMinor: 10000, finalTotalMinor: 90000, policyVersion: "direct-v1", rateBps: 1000,
  lines: [{ kind: "accommodation", code: "baseRate", label: "A", amountMinor: 90000 }], charge: { currency: "usd", amountMinor: 90000, quantity: 1, description: "d" },
  quoteHash: "b".repeat(64) };
const RES = { reservationId: "7001", listingId: 603566, from: "2026-12-20", to: "2026-12-24", totalMinor: 90000, currency: "USD" };
const CB_LONG = at(4) + 7 * 24 * 60 * MIN;
const CB_SHORT = at(4) + 13 * 60 * MIN;          // capture deadline passes before the reservation succeeds
const step = (i, e, m) => { const r = transition(i, e, { now: at(m) }); assert.equal(r.ok, true, `${e.type}: ${r.error}`); return r.intent; };
function authorized(captureBefore = CB_LONG) {
  let i = createIntent({ id: "int-1", ref: "MV-ABC123", listingId: 603566, from: "2026-12-20", to: "2026-12-24", guests: 2, now: at(0) });
  i = step(i, { type: "PRICE_CONFIRMED", price: PRICE }, 0);
  i = step(i, { type: "DETAILS_COLLECTED" }, 1);
  i = step(i, { type: "CHECKOUT_PREPARED", sessionId: "cs_test_1" }, 2);
  i = step(i, { type: "PAYMENT_AUTHORIZED", paymentIntentId: PI, sessionId: "cs_test_1", amountMinor: 90000, currency: "usd", livemode: false,
    authorizationCreatedAt: at(4), captureBefore }, 5);
  i = step(i, { type: "RESERVATION_STARTED", workerId: "w1", recheck: { bookable: true, priceSame: true } }, 6);
  return step(i, { type: "RESERVATION_DISPATCHED", workerId: "w1" }, 6);
}
const reservationFailed = () => step(authorized(), { type: "RESERVATION_FAILED", definite: true, code: "REFUSED" }, 7);
/** capture_failed after a capture row existed (attempt 1): CAPTURE_FAILED definite (row state decided by the test). */
const captureFailed1 = () => step(step(authorized(), { type: "RESERVATION_SUCCEEDED", reservation: RES }, 7), { type: "CAPTURE_FAILED", definite: true, code: "card_declined" }, 8);
/** capture_failed with NO capture ever (capture deadline passed before the reservation succeeded). */
const captureFailed0 = () => step(authorized(CB_SHORT), { type: "RESERVATION_SUCCEEDED", reservation: RES }, 13 * 60 + 10);

// ----- rows -----
const capRow = (over = {}, pOver = {}) => ({ id: "op-cap-1", opType: "stripe.capture_payment_intent", state: "pending", attempts: 0, dispatchedAt: null,
  payload: { paymentIntentId: PI, amountMinor: 90000, attempt: 1, providerIdempotencyKey: captureKey("int-1", PI, 1), ...pOver }, ...over });
const SENT = (state = "outcome_unknown", t = at(8)) => capRow({ state, attempts: 1, dispatchedAt: t });
const voidOp = (over = {}, pOver = {}) => ({ id: "op-void-1", opType: "stripe.void_payment_intent", state: "pending", attempts: 0, dispatchedAt: null,
  payload: { paymentIntentId: PI, attempt: 1, providerIdempotencyKey: voidKey("int-1", PI, 1), ...pOver }, ...over });
const cancelOp = (over = {}, pOver = {}) => ({ id: "op-cancel-1", opType: "hostaway.cancel_reservation", state: "pending", attempts: 0, dispatchedAt: null,
  payload: { reservationId: "7001", cancelledBy: "host", attempt: 1, ...pOver }, ...over });

// ----- evidence -----
const NOW = Date.UTC(2026, 11, 20, 5, 0, 0);        // 2026-12-20 05:00Z = 2026-12-19 22:00 in America/Mazatlan
const NOT_BEFORE = NOW - 60 * MIN;
const rawPI = (over = {}, chOver = {}) => ({
  id: PI, object: "payment_intent", livemode: false, capture_method: "manual", status: "requires_capture", amount: 90000, amount_received: 0,
  amount_capturable: 90000, currency: "usd", metadata: { mv_intent_id: "int-1", mv_payment_attempt_id: ATT },
  latest_charge: { object: "charge", id: "ch_1", payment_intent: PI, status: "succeeded", paid: true, captured: false, amount: 90000, amount_captured: 0,
    amount_refunded: 0, currency: "usd", livemode: false, payment_method_details: { card: { capture_before: CB_LONG / 1000 } }, ...chOver },
  ...over });
const SHORT_CB = (over = {}, chOver = {}) => rawPI(over, { payment_method_details: { card: { capture_before: CB_SHORT / 1000 } }, ...chOver });
const canceledRaw = (over = {}, chOver = {}) => rawPI({ status: "canceled", amount_capturable: 0, ...over }, chOver);
const piEv = (raw, over = {}) => { const observed = paymentIntentProofObservationV3(raw, { accountVerified: true });
  return { id: "ev-pi-1", kind: "payment_intent", readOpType: "stripe.retrieve_payment_intent", requestRef: PI, externalRef: PI, status: observed.status,
    observed, observedAt: NOW - MIN, ...over }; };
const resObs = (over = {}) => ({ reservationId: "7001", listingId: 603566, from: "2026-12-20", to: "2026-12-24", totalMinor: 90000, currency: "USD", status: "new",
  bookingRef: "MV-ABC123", ...over });
const byIdEv = (oOver = {}, over = {}) => ({ id: "ev-res-1", kind: "hostaway_reservation", readOpType: "hostaway.retrieve_reservation", requestRef: "7001",
  externalRef: "7001", status: "found_active", observed: resObs(oOver), observedAt: NOW - MIN, ...over });
const byRefEv = (oOver = {}, over = {}) => ({ id: "ev-res-2", kind: "hostaway_reservation", readOpType: "hostaway.lookup_reservation", requestRef: "MV-ABC123",
  externalRef: "7001", status: "found_active", observed: { ...resObs(oOver), matchCount: 1 }, observedAt: NOW - MIN, ...over });
const TZ = "America/Mazatlan";

const voidIn = (over = {}) => ({ evidence: piEv(rawPI()), intent: reservationFailed(), paymentAttemptId: ATT, voidOp: voidOp(), captureRows: [], now: NOW, notBefore: NOT_BEFORE, ...over });
const cancelIn = (over = {}) => ({ intent: captureFailed1(), paymentAttemptId: ATT, cancelOp: cancelOp(), captureRows: [capRow()], byId: byIdEv(), byRef: null,
  piEvidence: piEv(rawPI()), timeZone: TZ, now: NOW, notBefore: NOT_BEFORE, ...over });
const confirmed = () => step(authorized(), { type: "RESERVATION_SUCCEEDED", reservation: RES }, 7);
const capOp = () => ({ id: "op-cap-1", opType: "stripe.capture_payment_intent", state: "pending", dispatchedAt: null,
  payload: { paymentIntentId: PI, amountMinor: 90000, attempt: 1, providerIdempotencyKey: captureKey("int-1", PI, 1) } });
const capEv = () => piEv(rawPI());
const markLive = (i, v = true) => ({ ...i, payment: { ...i.payment, livemode: v } });
const NOT_TEST = [true, undefined, null, "false", 0];

// a counting fake provider: a request is "sent" only if the pure builder returned one
function fakeSender() { let sent = 0; return { send: (built) => { if (built && built.ok === true) sent += 1; return built; }, get sent() { return sent; } }; }

test("P1 capture: a TEST intent still proves and builds exactly as before; a non-TEST intent marker refuses at every layer, nothing sent", () => {
  const i = confirmed();
  assert.equal(i.payment.livemode, false);
  const e = initialCaptureSendEligibility({ evidence: capEv(), intent: i, paymentAttemptId: ATT, captureOp: capOp(), captureHistory: [capOp()] });
  assert.equal(e.ok, true);
  const built = buildCaptureRequest({ intent: i, captureOp: capOp(), eligibility: e, paymentAttemptId: ATT });
  assert.equal(built.ok, true);
  assert.equal(JSON.stringify(built.request), JSON.stringify({ paymentIntentId: PI, params: { amount_to_capture: 90000, expand: ["latest_charge"] },
    options: { idempotencyKey: captureKey("int-1", PI, 1) } }));
  const s = fakeSender();
  for (const v of NOT_TEST) {
    const li = markLive(i, v);
    assert.equal(stillAuthorizedV3Refusal(capEv(), li, ATT), "INTENT_NOT_TEST_MODE", String(v));
    assert.deepEqual(initialCaptureSendEligibility({ evidence: capEv(), intent: li, paymentAttemptId: ATT, captureOp: capOp(), captureHistory: [capOp()] }),
      { ok: false, code: "INTENT_NOT_TEST_MODE" }, String(v));
    // an eligibility minted while the intent was TEST cannot build once the marker is not TEST
    assert.deepEqual(s.send(buildCaptureRequest({ intent: li, captureOp: capOp(), eligibility: e, paymentAttemptId: ATT })), { ok: false, code: "INTENT_NOT_TEST_MODE" });
    assert.deepEqual(validateCaptureRequest(built.request, { intent: li, captureOp: capOp() }), { ok: false, code: "INTENT_NOT_TEST_MODE" });
  }
  assert.equal(s.sent, 0);
  // existing ordering unchanged: LIVE evidence on a TEST intent still reports the identity refusal
  assert.equal(stillAuthorizedV3Refusal(piEv(rawPI({ livemode: true })), i, ATT), "PAYMENT_INTENT_IDENTITY");
});

test("P2 void: TEST unchanged; a non-TEST intent marker refuses eligibility, build and validation; nothing sent", () => {
  const base = voidIn();
  const e = C.voidSendEligibility(base);
  assert.equal(e.ok, true);
  const args = (intent) => ({ intent, voidOp: base.voidOp, captureRows: base.captureRows, eligibility: e, paymentAttemptId: ATT, now: NOW, notBefore: NOT_BEFORE });
  const built = C.buildVoidRequest(args(base.intent));
  assert.equal(built.ok, true);
  const s = fakeSender();
  for (const v of NOT_TEST) {
    const li = markLive(base.intent, v);
    assert.deepEqual(C.voidSendEligibility({ ...base, intent: li }), { ok: false, code: "INTENT_NOT_TEST_MODE" }, String(v));
    assert.deepEqual(s.send(C.buildVoidRequest(args(li))), { ok: false, code: "INTENT_NOT_TEST_MODE" }, String(v));
    assert.deepEqual(C.validateVoidRequest(built.request, { intent: li, voidOp: base.voidOp }), { ok: false, code: "INTENT_NOT_TEST_MODE" });
  }
  assert.equal(s.sent, 0);
});

test("P3 canceled proof + Hostaway cancel: TEST unchanged; a non-TEST intent marker refuses proof, eligibility, build and validation", () => {
  const base = cancelIn();
  const e = C.cancelSendEligibility(base);
  assert.equal(e.ok, true);
  const args = (intent) => ({ intent, cancelOp: base.cancelOp, captureRows: base.captureRows, eligibility: e, paymentAttemptId: ATT, timeZone: TZ, now: NOW, notBefore: NOT_BEFORE });
  const built = C.buildCancelRequest(args(base.intent));
  assert.equal(built.ok, true);
  const opts = { now: NOW, notBefore: NOT_BEFORE };
  assert.equal(C.piCanceledProofV3(piEv(canceledRaw()), reservationFailed(), ATT, opts), null);
  const s = fakeSender();
  for (const v of NOT_TEST) {
    assert.equal(C.piCanceledProofV3(piEv(canceledRaw()), markLive(reservationFailed(), v), ATT, opts), "INTENT_NOT_TEST_MODE", String(v));
    const li = markLive(base.intent, v);
    const el = C.cancelSendEligibility({ ...base, intent: li });
    assert.equal(el.ok, false);
    assert.match(el.code, /INTENT_NOT_TEST_MODE$/, String(v));
    assert.deepEqual(s.send(C.buildCancelRequest(args(li))), { ok: false, code: "INTENT_NOT_TEST_MODE" }, String(v));
    assert.deepEqual(C.validateCancelRequest(built.request, { intent: li, cancelOp: base.cancelOp }), { ok: false, code: "INTENT_NOT_TEST_MODE" });
  }
  assert.deepEqual(C.validateCancelRequest(built.request, { intent: { ...base.intent, payment: null }, cancelOp: base.cancelOp }), { ok: false, code: "INTENT_NOT_TEST_MODE" });
  assert.equal(s.sent, 0);
});

test("P4 consistency: capture, void, cancel and the existing mirror proof all name the same refusal for a non-TEST intent", () => {
  assert.equal(stillAuthorizedV3Refusal(capEv(), markLive(confirmed()), ATT), "INTENT_NOT_TEST_MODE");
  assert.equal(C.piCanceledProofV3(piEv(canceledRaw()), markLive(reservationFailed()), ATT, { now: NOW, notBefore: NOT_BEFORE }), "INTENT_NOT_TEST_MODE");
  // mirror already enforced this before C129 (shown with a minimal mirror-ready shape)
  const mi = { id: "11111111-2222-4333-8444-555555555555", version: 3, status: "test_cleanup_pending", price: { finalTotalMinor: 90000, currency: "USD" },
    payment: { capturedMinor: 90000, livemode: true }, settlement: { reservationCancelled: true, authorizationSettled: true, recordingMirrored: false },
    reservation: { reservationId: "7001" }, offlineChargeId: "88001" };
  assert.equal(mirrorIntentRefusal(mi), "INTENT_NOT_TEST_MODE");
});

test("P5 LIVE stays closed: the runtime mode gate still refuses LIVE first", () => {
  assert.equal(checkoutModeGate({ MV_CHECKOUT_MODE: "live" }).ok, false);
  assert.equal(stripeTestGate({ MV_CHECKOUT_MODE: "live" }).ok, false);
});
