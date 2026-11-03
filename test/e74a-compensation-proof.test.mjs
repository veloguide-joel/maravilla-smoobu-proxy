// Stage E7.4a-0 — pure compensation proof / request foundation (no DB, network, SDK). Each guard broken individually.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createIntent, transition, captureKey, voidKey } from "../lib/checkout/intent-state.js";
import { paymentIntentProofObservationV3 } from "../lib/checkout/capture-proof.js";
import * as C from "../lib/checkout/compensation-proof.js";
import { PROTECTED_HOSTAWAY_RESERVATION_IDS as WORKER_PROTECTED } from "../lib/booking-db/reservation-worker.js";
import { fileURLToPath } from "node:url";
import { importClosure } from "./helpers/import-closure.mjs";

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

// =============================================================================================
test("protected ids: exact fixed list, equal to the worker's export (no booking-db import in the pure runtime closure)", () => {
  assert.deepEqual([...C.PROTECTED_HOSTAWAY_RESERVATION_IDS], ["70636076", "71045356", "71072615", "71081885"]);
  assert.deepEqual([...C.PROTECTED_HOSTAWAY_RESERVATION_IDS].sort(), [...WORKER_PROTECTED].sort());
  for (const id of C.PROTECTED_HOSTAWAY_RESERVATION_IDS) { assert.equal(C.isProtectedReservationId(id), true); assert.equal(C.isProtectedReservationId(Number(id)), true); }
  assert.equal(C.isProtectedReservationId("7001"), false);
  assert.ok(Object.isFrozen(C.PROTECTED_HOSTAWAY_RESERVATION_IDS));
  // the pure module's static runtime closure: only accepted pure checkout modules (approximate static tracer)
  const c = importClosure(fileURLToPath(new URL("..", import.meta.url)), "lib/checkout/compensation-proof.js");
  assert.deepEqual([...c.files.keys()].sort(), ["lib/checkout/capture-proof.js", "lib/checkout/compensation-proof.js", "lib/checkout/intent-state.js", "lib/checkout/recovery-plan.js"]);
  assert.deepEqual(c.nonLiteralDynamic, []);
});

test("capture history classifier: Z / P / D / M only on explicit valid facts; malformed / inconsistent shapes refuse", () => {
  const cf1 = captureFailed1(); const cf0 = captureFailed0(); const rf = reservationFailed();
  assert.equal(cf0.counters.captureAttempts, 0); assert.equal(cf0.status, "capture_failed"); assert.equal(rf.counters.captureAttempts, 0);
  const cls = (intent, rows) => C.captureHistoryClass({ intent, captureRows: rows });
  assert.equal(cls(rf, []).cls, "Z");
  assert.equal(cls(cf0, []).cls, "Z");
  assert.equal(cls(cf1, [capRow()]).cls, "P");
  for (const st of ["in_flight", "succeeded", "failed_definite", "outcome_unknown", "escalated"]) {
    const r = cls(cf1, [SENT(st)]); assert.equal(r.cls, "D", st); assert.equal(r.latestDispatchedAt, at(8));
  }
  assert.equal(cls(cf1, [SENT(), capRow({ id: "op-cap-2" }, { attempt: 2, providerIdempotencyKey: captureKey("int-1", PI, 2) })]).code, "CAPTURE_ROW_ATTEMPT", "attempt above counter");
  assert.equal(cls({ ...cf1, counters: { ...cf1.counters, captureAttempts: 2 } }, [SENT(), capRow({ id: "op-cap-2" }, { attempt: 2, providerIdempotencyKey: captureKey("int-1", PI, 2) })]).cls, "M");
  assert.equal(cls({ ...cf1, counters: { ...cf1.counters, captureAttempts: 2 } }, [SENT()]).cls, "M");
  const bad = [
    [cf1, [], "CAPTURE_HISTORY_INCONSISTENT"],                                    // counter 1, no row
    [cf0, [capRow()], "CAPTURE_HISTORY_INCONSISTENT"],                            // counter 0, a row
    [cf1, [capRow({ attempts: 1 })], "CAPTURE_ROW_DISPATCH_INCONSISTENT"],          // attempts without dispatch time
    [cf1, [capRow({ dispatchedAt: at(8) })], "CAPTURE_ROW_DISPATCH_INCONSISTENT"],  // dispatch time without attempts
    [cf1, [capRow({ attempts: 1, dispatchedAt: at(8) })], "CAPTURE_ROW_DISPATCH_INCONSISTENT"],   // pending but sent
    [cf1, [capRow({ state: "outcome_unknown" })], "CAPTURE_ROW_DISPATCH_INCONSISTENT"],          // unknown never sent
    [cf1, [capRow({ state: "escalated" })], "CAPTURE_HISTORY_NOT_CLASSIFIABLE"],
    [cf1, [capRow({ state: "superseded" })], "CAPTURE_HISTORY_NOT_CLASSIFIABLE"],
    [cf1, [capRow({ state: "weird" })], "CAPTURE_ROW_INVALID"],
    [cf1, [capRow({ attempts: -1 })], "CAPTURE_ROW_INVALID"], [cf1, [capRow({ attempts: 1.5 })], "CAPTURE_ROW_INVALID"],
    [cf1, [capRow({ dispatchedAt: "x" })], "CAPTURE_ROW_INVALID"], [cf1, [capRow({ id: "" })], "CAPTURE_ROW_INVALID"],
    [cf1, [capRow({ opType: "stripe.void_payment_intent" })], "CAPTURE_ROW_INVALID"], [cf1, [null], "CAPTURE_ROW_INVALID"],
    [cf1, [capRow(), capRow()], "CAPTURE_ROW_INVALID"],                                           // duplicate id
    [cf1, [capRow({}, { paymentIntentId: "pi_test_other" })], "CAPTURE_ROW_PAYMENT_INTENT"],
    [cf1, [capRow({}, { amountMinor: 1 })], "CAPTURE_ROW_AMOUNT"],
    [cf1, [capRow({}, { providerIdempotencyKey: "cap:x" })], "CAPTURE_ROW_KEY"],
    [cf1, [capRow({}, { attempt: 0 })], "CAPTURE_ROW_ATTEMPT"],
    [cf1, [{ ...capRow(), payload: { ...capRow().payload, extra: 1 } }], "CAPTURE_ROW_PAYLOAD_SHAPE"],
    [cf1, "rows", "CAPTURE_HISTORY_REQUIRED"],
    [{ ...cf1, counters: { ...cf1.counters, captureAttempts: -1 } }, [], "CAPTURE_COUNTER_INVALID"],
    [{ ...cf1, counters: { ...cf1.counters, captureAttempts: "1" } }, [capRow()], "CAPTURE_COUNTER_INVALID"],
    [{ ...cf1, payment: { ...cf1.payment, paymentIntentId: "nope" } }, [capRow()], "INTENT_PAYMENT_INTENT_INVALID"],
    [null, [], "INTENT_INVALID"]
  ];
  for (const [i, rows, code] of bad) assert.equal(cls(i, rows).code, code, `${code} ${JSON.stringify(rows).slice(0, 80)}`);
  assert.ok(Object.isFrozen(cls(cf1, [capRow()])));
});

test("canceled proof v3: positive control; every identity / money / charge / freshness binding broken individually; never requires an active authorization", () => {
  const i = captureFailed1();
  const opts = { now: NOW, notBefore: NOT_BEFORE, latestCaptureDispatchedAt: NOW - 10 * MIN };
  assert.equal(C.piCanceledProofV3(piEv(canceledRaw()), i, ATT, opts), null);
  // capture deadline long passed: still a valid proof (no authorization-active condition)
  assert.equal(C.piCanceledProofV3(piEv(canceledRaw()), { ...i, payment: { ...i.payment, authorizationDeadline: 1, captureBefore: 2 } }, ATT, opts), null);
  const cases = [
    [piEv(canceledRaw(), { kind: "hostaway_reservation" }), "PI_EVIDENCE_SHAPE"], [piEv(canceledRaw(), { readOpType: "hostaway.retrieve_reservation" }), "PI_EVIDENCE_SHAPE"],
    [piEv(canceledRaw(), { id: "" }), "PI_EVIDENCE_SHAPE"],
    [{ ...piEv(canceledRaw()), observed: { ...piEv(canceledRaw()).observed, proofVersion: "pi-proof-v2" } }, "V3_OBSERVATION_REQUIRED"],
    [piEv(canceledRaw({ livemode: true })), "PAYMENT_INTENT_IDENTITY"],
    [piEv(canceledRaw({ metadata: { mv_intent_id: "int-2", mv_payment_attempt_id: ATT } })), "PAYMENT_INTENT_IDENTITY"],
    [piEv(canceledRaw({ metadata: { mv_intent_id: "int-1", mv_payment_attempt_id: "x" } })), "PAYMENT_INTENT_IDENTITY"],
    [piEv(canceledRaw({ capture_method: "automatic" })), "PAYMENT_INTENT_IDENTITY"], [piEv(canceledRaw({ amount: 1 })), "PAYMENT_INTENT_IDENTITY"],
    [piEv(canceledRaw({ currency: "mxn" })), "PAYMENT_INTENT_IDENTITY"], [piEv(canceledRaw({ id: "pi_test_other" })), "PAYMENT_INTENT_IDENTITY"],
    [piEv(canceledRaw(), { requestRef: "pi_test_other" }), "PAYMENT_INTENT_IDENTITY"], [piEv(canceledRaw(), { externalRef: "pi_test_other" }), "PAYMENT_INTENT_IDENTITY"],
    [piEv(rawPI({ status: "requires_payment_method", amount_capturable: 0 })), "NOT_CANCELED"],
    [piEv(rawPI()), "NOT_CANCELED"], [piEv(rawPI({ status: "succeeded", amount_received: 90000, amount_capturable: 0 })), "NOT_CANCELED"],
    [piEv(canceledRaw(), { status: "requires_capture" }), "PAYMENT_INTENT_IDENTITY"],
    [piEv(canceledRaw({ amount_received: 5 })), "AMOUNT_RECEIVED_NOT_ZERO"], [piEv(canceledRaw({ amount_capturable: 90000 })), "AMOUNT_CAPTURABLE_NOT_ZERO"],
    [piEv(canceledRaw({ latest_charge: "ch_1" })), "CHARGE_NOT_EXPANDED"], [piEv(canceledRaw({ latest_charge: null })), "CHARGE_NOT_EXPANDED"],
    [piEv(canceledRaw({}, { id: "x_1" })), "CHARGE_NOT_EXPANDED"], [piEv(canceledRaw({}, { object: "refund" })), "CHARGE_NOT_EXPANDED"],
    [piEv(canceledRaw({}, { payment_intent: "pi_test_other" })), "CHARGE_NOT_BOUND"], [piEv(canceledRaw({}, { livemode: true })), "CHARGE_NOT_TEST_MODE"],
    [piEv(canceledRaw({}, { captured: true })), "CHARGE_CAPTURED"], [piEv(canceledRaw({}, { captured: undefined })), "CHARGE_CAPTURED"],
    [piEv(canceledRaw({}, { amount_captured: 1 })), "CHARGE_AMOUNT_CAPTURED"], [piEv(canceledRaw({}, { amount_refunded: 90000 })), "CHARGE_AMOUNT_REFUNDED"],
    [piEv(canceledRaw({}, { amount_refunded: undefined })), "CHARGE_AMOUNT_REFUNDED"],
    [piEv(canceledRaw({}, { amount: 1 })), "CHARGE_AMOUNT"], [piEv(canceledRaw({}, { currency: undefined })), "CHARGE_CURRENCY"],
    [piEv(canceledRaw(), { observedAt: undefined }), "EVIDENCE_TIME_MISSING"], [piEv(canceledRaw(), { observedAt: NOW + 1 }), "EVIDENCE_IN_FUTURE"],
    [piEv(canceledRaw(), { observedAt: NOW - 5 * MIN - 1 }), "EVIDENCE_STALE"], [piEv(canceledRaw(), { observedAt: NOT_BEFORE - 1 }), "EVIDENCE_STALE"]
  ];
  for (const [ev, code] of cases) assert.equal(C.piCanceledProofV3(ev, i, ATT, opts), code, code);
  assert.equal(C.piCanceledProofV3(piEv(canceledRaw()), i, "other-attempt", opts), "PAYMENT_INTENT_IDENTITY");
  // dispatch + 2 min and state-entry bounds
  assert.equal(C.piCanceledProofV3(piEv(canceledRaw()), i, ATT, { ...opts, latestCaptureDispatchedAt: NOW - 2 * MIN }), "EVIDENCE_TOO_SOON_AFTER_DISPATCH");
  assert.equal(C.piCanceledProofV3(piEv(canceledRaw(), { observedAt: NOW - 3 * MIN }), i, ATT, { ...opts, latestCaptureDispatchedAt: NOW - 5 * MIN }), null);
  assert.equal(C.piCanceledProofV3(piEv(canceledRaw()), i, ATT, { ...opts, notBefore: NOW - 30 * 1000 }), "EVIDENCE_BEFORE_STATE");
  assert.equal(C.piCanceledProofV3(piEv(canceledRaw()), i, ATT, { ...opts, now: undefined }), "FRESHNESS_INPUT_INVALID");
  assert.equal(C.piCanceledProofV3(piEv(canceledRaw()), i, ATT, { ...opts, latestCaptureDispatchedAt: "x" }), "FRESHNESS_INPUT_INVALID");
});

test("time zone: explicit IANA zone, local-date conversion, strictly future arrival; UTC rollover, DST, invalid / missing zone refuse (no fallback)", () => {
  assert.equal(C.localDateInZone(NOW, "America/Mazatlan"), "2026-12-19");
  assert.equal(C.localDateInZone(NOW, "UTC"), "2026-12-20");
  assert.equal(C.localDateInZone(NOW, "Asia/Tokyo"), "2026-12-20");
  assert.deepEqual(C.arrivalStrictlyFuture("2026-12-20", "America/Mazatlan", NOW), { ok: true, localDate: "2026-12-19" });
  assert.equal(C.arrivalStrictlyFuture("2026-12-20", "UTC", NOW).code, "ARRIVAL_NOT_IN_FUTURE", "arrival today (UTC rollover)");
  assert.equal(C.arrivalStrictlyFuture("2026-12-19", "America/Mazatlan", NOW).code, "ARRIVAL_NOT_IN_FUTURE", "arrival today locally");
  assert.equal(C.arrivalStrictlyFuture("2026-12-18", "America/Mazatlan", NOW).code, "ARRIVAL_NOT_IN_FUTURE", "past");
  // DST (America/New_York): 2026-03-08 06:59Z = 01:59 EST, 07:00Z = 03:00 EDT; 2026-11-01 05:30Z = 01:30 EDT/EST -> same local date
  assert.equal(C.localDateInZone(Date.UTC(2026, 2, 8, 6, 59), "America/New_York"), "2026-03-08");
  assert.equal(C.localDateInZone(Date.UTC(2026, 2, 8, 4, 59), "America/New_York"), "2026-03-07");
  assert.equal(C.localDateInZone(Date.UTC(2026, 10, 1, 5, 30), "America/New_York"), "2026-11-01");
  assert.equal(C.localDateInZone(Date.UTC(2026, 10, 1, 3, 59), "America/New_York"), "2026-10-31");
  for (const z of [undefined, null, "", "Mars/Olympus", "+07:00", "-0700", "UTC+7", 7, {}, "America/Mazatlan ", "x".repeat(70)]) {
    assert.equal(C.localDateInZone(NOW, z), null, String(z));
    assert.equal(C.arrivalStrictlyFuture("2026-12-30", z, NOW).code, "TIME_ZONE_OR_CLOCK_INVALID", String(z));
  }
  for (const t of [undefined, NaN, -1, 0, 1.5, "1"]) assert.equal(C.localDateInZone(t, TZ), null);
  for (const d of ["2026-02-30", "2026-13-01", "26-12-20", "", null, 20261220, "2026-12-20T00:00"]) assert.equal(C.arrivalStrictlyFuture(d, TZ, NOW).code, "ARRIVAL_DATE_INVALID", String(d));
});

test("void eligibility: positive controls (reservation_failed Z; capture_failed Z and P; after the capture deadline); every guard broken individually", () => {
  const e = C.voidSendEligibility(voidIn());
  assert.equal(e.ok, true, e.code); assert.equal(e.purpose, C.VOID_PURPOSE); assert.ok(Object.isFrozen(e) && Object.isFrozen(e.snapshot));
  const cf1 = captureFailed1(); const cf0 = captureFailed0();
  assert.equal(C.voidSendEligibility(voidIn({ intent: cf1, captureRows: [capRow()] })).ok, true, "P");
  // Z after the capture deadline: the release is still valid (proof must not require the deadline ahead)
  const cbShortSec = CB_SHORT / 1000;
  assert.equal(C.voidSendEligibility(voidIn({ intent: cf0, captureRows: [], evidence: piEv(rawPI({}, { payment_method_details: { card: { capture_before: cbShortSec } } })) })).ok, true, "Z after deadline");
  assert.ok(NOW > cf0.payment.captureBefore && NOW > cf0.payment.authorizationDeadline);
  const cases = [
    [{ captureRows: [SENT()] , intent: cf1 }, "CAPTURE_HISTORY_D_BLOCKS_VOID"],
    [{ captureRows: [SENT("failed_definite")], intent: cf1 }, "CAPTURE_HISTORY_D_BLOCKS_VOID"],
    [{ intent: { ...cf1, counters: { ...cf1.counters, captureAttempts: 2 } }, captureRows: [SENT()] }, "CAPTURE_HISTORY_M_BLOCKS_VOID"],
    [{ captureRows: [capRow()] }, "HISTORY_CAPTURE_HISTORY_INCONSISTENT"],                            // reservation_failed with a capture row
    [{ intent: cf1, captureRows: [] }, "HISTORY_CAPTURE_HISTORY_INCONSISTENT"],
    [{ intent: { ...cf1, settlement: { ...cf1.settlement, authorizationSettled: true } }, captureRows: [capRow()] }, "AUTHORIZATION_LEG_NOT_OPEN"],
    [{ intent: { ...cf1, settlement: undefined }, captureRows: [capRow()] }, "AUTHORIZATION_LEG_NOT_OPEN"],
    [{ intent: { ...reservationFailed(), settlement: { reservationCancelled: false, authorizationSettled: true } } }, "AUTHORIZATION_ALREADY_SETTLED"],
    [{ intent: { ...reservationFailed(), status: "reservation_confirmed" } }, "NOT_A_VOID_STATE"],
    [{ intent: { ...reservationFailed(), status: "capture_unknown" } }, "NOT_A_VOID_STATE"],
    [{ voidOp: voidOp({ state: "in_flight", attempts: 1, dispatchedAt: at(9) }) }, "VOID_OPERATION_ALREADY_CLAIMED_OR_SENT"],
    [{ voidOp: voidOp({ attempts: 1 }) }, "VOID_OPERATION_ALREADY_CLAIMED_OR_SENT"], [{ voidOp: voidOp({ dispatchedAt: at(9) }) }, "VOID_OPERATION_ALREADY_CLAIMED_OR_SENT"],
    [{ voidOp: voidOp({}, { attempt: 2, providerIdempotencyKey: voidKey("int-1", PI, 2) }) }, "VOID_NOT_INITIAL_ATTEMPT"],
    [{ voidOp: voidOp({}, { providerIdempotencyKey: "void:x" }) }, "VOID_IDEMPOTENCY_KEY"], [{ voidOp: voidOp({}, { paymentIntentId: "pi_test_other" }) }, "VOID_PAYMENT_INTENT"],
    [{ voidOp: { ...voidOp(), payload: { ...voidOp().payload, extra: 1 } } }, "VOID_PAYLOAD_SHAPE"], [{ voidOp: voidOp({ opType: "stripe.capture_payment_intent" }) }, "NOT_A_VOID_OPERATION"],
    [{ evidence: piEv(canceledRaw()) }, "NOT_REQUIRES_CAPTURE"],
    [{ evidence: piEv(rawPI({ amount_capturable: 100 })) }, "AMOUNT_CAPTURABLE_NOT_FULL"], [{ evidence: piEv(rawPI({}, { captured: true })) }, "CHARGE_ALREADY_CAPTURED"],
    [{ evidence: piEv(rawPI({}, { paid: false })) }, "CHARGE_NOT_PAID"], [{ evidence: piEv(rawPI({ latest_charge: "ch_1" })) }, "CHARGE_NOT_EXPANDED"],
    [{ evidence: piEv(rawPI({}, { payment_method_details: { card: { capture_before: 5 } } })) }, "CAPTURE_BEFORE_MISMATCH"],
    [{ evidence: piEv(rawPI({ livemode: true })) }, "PAYMENT_INTENT_IDENTITY"], [{ evidence: piEv(rawPI({ currency: "mxn" })) }, "PAYMENT_INTENT_IDENTITY"],
    [{ evidence: piEv(rawPI(), { observedAt: NOW - 6 * MIN }) }, "EVIDENCE_STALE"], [{ evidence: piEv(rawPI(), { observedAt: NOW + 1 }) }, "EVIDENCE_IN_FUTURE"],
    [{ notBefore: NOW }, "EVIDENCE_BEFORE_STATE"], [{ evidence: piEv(rawPI(), { kind: "x" }) }, "PI_EVIDENCE_SHAPE"],
    [{ paymentAttemptId: "other" }, "PAYMENT_INTENT_IDENTITY"],
    [{ intent: { ...reservationFailed(), payment: { ...reservationFailed().payment, amountMinor: 1 } } }, "AUTHORIZED_AMOUNT_NOT_PRICE"]
  ];
  for (const [over, code] of cases) assert.equal(C.voidSendEligibility(voidIn(over)).code, code, code);
});

test("void builder: pre-claim only, unissued / stale / changed-snapshot refused (incl. CURRENT op unknown, history, leg changed); exact empty-params request", () => {
  const base = voidIn({ intent: captureFailed1(), captureRows: [capRow()] });
  const e = C.voidSendEligibility(base);
  const b = (over = {}) => C.buildVoidRequest({ intent: base.intent, voidOp: base.voidOp, captureRows: base.captureRows, eligibility: e, paymentAttemptId: ATT,
    now: NOW, notBefore: NOT_BEFORE, ...over });
  const ok = b();
  assert.equal(ok.ok, true, ok.code);
  assert.deepEqual(ok.request, { paymentIntentId: PI, params: {}, options: { idempotencyKey: voidKey("int-1", PI, 1) } });
  assert.ok(Object.isFrozen(ok.request) && Object.isFrozen(ok.request.params));
  assert.equal(b({ eligibility: { ...e } }).code, "ELIGIBILITY_REQUIRED", "a copy is not issued");
  assert.equal(b({ eligibility: C.cancelSendEligibility(cancelIn()) }).code, "ELIGIBILITY_REQUIRED", "a cancel eligibility is not a void eligibility");
  assert.equal(b({ extra: 1 }).code, "UNEXPECTED_INPUT");
  assert.equal(b({ voidOp: voidOp({ state: "outcome_unknown", attempts: 1, dispatchedAt: at(9) }) }).code, "VOID_OPERATION_ALREADY_CLAIMED_OR_SENT", "CURRENT op became unknown");
  assert.equal(b({ voidOp: voidOp({ state: "in_flight", attempts: 1, dispatchedAt: at(9) }) }).code, "VOID_OPERATION_ALREADY_CLAIMED_OR_SENT", "no pretend-pending after claim");
  assert.equal(b({ voidOp: voidOp({ id: "op-void-2" }) }).code, "ELIGIBILITY_STALE");
  assert.equal(b({ captureRows: [SENT()] }).code, "CAPTURE_HISTORY_D_BLOCKS_VOID", "history changed");
  assert.equal(b({ intent: { ...base.intent, version: base.intent.version + 1 } }).code, "ELIGIBILITY_STALE");
  assert.equal(b({ intent: { ...base.intent, settlement: { ...base.intent.settlement, reservationCancelled: true } } }).code, "ELIGIBILITY_SNAPSHOT_CHANGED", "other leg changed");
  assert.equal(b({ intent: { ...base.intent, settlement: { ...base.intent.settlement, authorizationSettled: true } } }).code, "AUTHORIZATION_LEG_NOT_OPEN");
  assert.equal(b({ intent: { ...base.intent, payment: { ...base.intent.payment, captureBefore: 1 } } }).code, "ELIGIBILITY_SNAPSHOT_CHANGED");
  assert.equal(b({ paymentAttemptId: "other" }).code, "ELIGIBILITY_SNAPSHOT_CHANGED");
  // validator: shape / identity only
  const v = (req) => C.validateVoidRequest(req, { intent: base.intent, voidOp: base.voidOp });
  assert.equal(v(ok.request).ok, true);
  assert.equal(v({ ...ok.request, params: { cancellation_reason: "abandoned" } }).code, "PARAMS_NOT_EMPTY");
  assert.equal(v({ ...ok.request, params: { amount_to_capture: 1 } }).code, "PARAMS_NOT_EMPTY", "no capture / partial path");
  assert.equal(v({ ...ok.request, refund: true }).code, "REQUEST_SHAPE", "no refund path");
  assert.equal(v({ ...ok.request, options: { idempotencyKey: "x" } }).code, "IDEMPOTENCY_KEY");
  assert.equal(v({ ...ok.request, options: { idempotencyKey: ok.request.options.idempotencyKey, stripeAccount: "acct_x" } }).code, "OPTIONS_SHAPE");
  assert.equal(v({ ...ok.request, paymentIntentId: "pi_test_other" }).code, "REQUEST_PAYMENT_INTENT");
});

test("reservation proof + cancel eligibility: positive controls (P, Z, D with canceled proof, ref by lookup); every guard broken individually", () => {
  const e = C.cancelSendEligibility(cancelIn());
  assert.equal(e.ok, true, e.code); assert.deepEqual([...e.reservationEvidenceIds], ["ev-res-1"]); assert.equal(e.snapshot.localDate, "2026-12-19");
  assert.equal(C.cancelSendEligibility(cancelIn({ intent: captureFailed0(), captureRows: [], piEvidence: piEv(SHORT_CB()) })).ok, true, "Z");
  const d = C.cancelSendEligibility(cancelIn({ captureRows: [SENT("outcome_unknown", NOW - 10 * MIN)], piEvidence: piEv(canceledRaw()) }));
  assert.equal(d.ok, true, d.code); assert.deepEqual({ ...d.piEvidence }, { id: "ev-pi-1", observedAt: NOW - MIN, proof: "canceled" });
  const lk = C.cancelSendEligibility(cancelIn({ byId: byIdEv({ bookingRef: undefined }), byRef: byRefEv() }));
  assert.equal(lk.ok, true, lk.code); assert.deepEqual([...lk.reservationEvidenceIds], ["ev-res-1", "ev-res-2"]);
  const cases = [
    [{ captureRows: [SENT()] }, "CANCELED_PROOF_NOT_CANCELED"],                         // D: still-authorized is never enough
    [{ captureRows: [SENT("failed_definite", NOW - 10 * MIN)] }, "CANCELED_PROOF_NOT_CANCELED"],      // no error-label route
    [{ captureRows: [SENT("outcome_unknown", NOW - 2 * MIN)], piEvidence: piEv(canceledRaw()) }, "CANCELED_PROOF_EVIDENCE_TOO_SOON_AFTER_DISPATCH"],
    [{ piEvidence: piEv(rawPI({ status: "requires_payment_method", amount_capturable: 0 })) }, "PI_PROOF_NOT_REQUIRES_CAPTURE"],
    [{ intent: { ...captureFailed1(), counters: { ...captureFailed1().counters, captureAttempts: 2 } }, captureRows: [SENT()] }, "CAPTURE_HISTORY_M_BLOCKS_CANCEL"],
    [{ captureRows: [capRow({ attempts: 1 })] }, "HISTORY_CAPTURE_ROW_DISPATCH_INCONSISTENT"],
    [{ intent: reservationFailed(), captureRows: [] }, "NOT_CAPTURE_FAILED"],
    [{ intent: { ...captureFailed1(), settlement: { reservationCancelled: true, authorizationSettled: false } } }, "RESERVATION_LEG_NOT_OPEN"],
    [{ cancelOp: cancelOp({ state: "in_flight", attempts: 1, dispatchedAt: at(9) }) }, "CANCEL_OPERATION_ALREADY_CLAIMED_OR_SENT"],
    [{ cancelOp: cancelOp({}, { attempt: 2 }) }, "CANCEL_NOT_INITIAL_ATTEMPT"], [{ cancelOp: cancelOp({}, { cancelledBy: "guest" }) }, "CANCEL_NOT_HOST"],
    [{ cancelOp: cancelOp({}, { reservationId: "7002" }) }, "CANCEL_RESERVATION"], [{ cancelOp: { ...cancelOp(), payload: { ...cancelOp().payload, x: 1 } } }, "CANCEL_PAYLOAD_SHAPE"],
    [{ timeZone: undefined }, "TIME_ZONE_OR_CLOCK_INVALID"], [{ timeZone: "UTC" }, "ARRIVAL_NOT_IN_FUTURE"], [{ timeZone: "Mars/Olympus" }, "TIME_ZONE_OR_CLOCK_INVALID"],
    [{ byId: byIdEv({ status: "modified" }) }, "BY_ID_RESERVATION_STATUS_NOT_NEW"], [{ byId: byIdEv({}, { status: "cancelled" }) }, "BY_ID_RESERVATION_NOT_ACTIVE"],
    [{ byId: byIdEv({ listingId: 1 }) }, "BY_ID_RESERVATION_IDENTITY"], [{ byId: byIdEv({ from: "2026-12-21" }) }, "BY_ID_RESERVATION_IDENTITY"],
    [{ byId: byIdEv({ to: "2026-12-25" }) }, "BY_ID_RESERVATION_IDENTITY"], [{ byId: byIdEv({ totalMinor: 1 }) }, "BY_ID_RESERVATION_IDENTITY"],
    [{ byId: byIdEv({ currency: "MXN" }) }, "BY_ID_RESERVATION_IDENTITY"], [{ byId: byIdEv({ currency: undefined }) }, "BY_ID_RESERVATION_IDENTITY"],
    [{ byId: byIdEv({}, { externalRef: "7002" }) }, "BY_ID_RESERVATION_ID_MISMATCH"], [{ byId: byIdEv({}, { requestRef: "7002" }) }, "BY_ID_RESERVATION_EVIDENCE_SHAPE"],
    [{ byId: byIdEv({}, { readOpType: "hostaway.lookup_reservation" }) }, "BY_ID_RESERVATION_EVIDENCE_SHAPE"], [{ byId: byIdEv({}, { observedAt: NOW - 6 * MIN }) }, "BY_ID_EVIDENCE_STALE"],
    [{ byId: byIdEv({ bookingRef: "MV-OTHER1" }) }, "BOOKING_REF_MISMATCH"], [{ byId: byIdEv({ bookingRef: undefined }) }, "BY_REF_RESERVATION_EVIDENCE_SHAPE"],
    [{ byRef: byRefEv() }, "UNEXPECTED_LOOKUP_EVIDENCE"],
    [{ byId: byIdEv({ bookingRef: undefined }), byRef: byRefEv({}, { observed: { ...resObs(), matchCount: 2 } }) }, "BY_REF_NOT_UNIQUE_MATCH"],
    [{ byId: byIdEv({ bookingRef: undefined }), byRef: byRefEv({ status: "modified" }) }, "BY_REF_RESERVATION_STATUS_NOT_NEW"],
    [{ byId: byIdEv({ bookingRef: undefined }), byRef: byRefEv({}, { requestRef: "MV-OTHER1" }) }, "BY_REF_RESERVATION_EVIDENCE_SHAPE"],
    [{ byId: byIdEv({ bookingRef: undefined }), byRef: byRefEv({ bookingRef: "MV-OTHER1" }) }, "BY_REF_NOT_UNIQUE_MATCH"]
  ];
  for (const [over, code] of cases) assert.equal(C.cancelSendEligibility(cancelIn(over)).code, code, code);
});

test("protected reservation ids are refused at every cancel path", () => {
  for (const pid of C.PROTECTED_HOSTAWAY_RESERVATION_IDS) {
    const i = captureFailed1();
    const pi = { ...i, reservation: { ...i.reservation, reservationId: pid } };
    assert.equal(C.cancelSendEligibility(cancelIn({ intent: pi, cancelOp: cancelOp({}, { reservationId: pid }) })).code, "PROTECTED_OR_NO_RESERVATION", pid);
    assert.equal(C.activeReservationProof({ intent: pi, byId: byIdEv({ reservationId: pid }, { externalRef: pid, requestRef: pid }), now: NOW, notBefore: NOT_BEFORE }).code, "PROTECTED_RESERVATION_ID");
    // a protected id appearing only in the evidence is refused too
    assert.equal(C.activeReservationProof({ intent: i, byId: byIdEv({ reservationId: pid }), now: NOW, notBefore: NOT_BEFORE }).code, "BY_ID_RESERVATION_ID_MISMATCH");
    assert.equal(C.validateCancelRequest({ method: "PUT", path: `/v1/reservations/${pid}/statuses/cancelled`, query: {}, body: { cancelledBy: "host" } },
      { intent: pi, cancelOp: cancelOp({}, { reservationId: pid }) }).code, "RESERVATION_ID_INVALID_OR_PROTECTED");
  }
});

test("cancel builder: pre-claim only, stale cached eligibility refused (CURRENT op unknown, history / leg / date changed); exact PUT host-cancel request", () => {
  const base = cancelIn();
  const e = C.cancelSendEligibility(base);
  const b = (over = {}) => C.buildCancelRequest({ intent: base.intent, cancelOp: base.cancelOp, captureRows: base.captureRows, eligibility: e, paymentAttemptId: ATT,
    timeZone: TZ, now: NOW, notBefore: NOT_BEFORE, ...over });
  const ok = b();
  assert.equal(ok.ok, true, ok.code);
  assert.deepEqual(ok.request, { method: "PUT", path: "/v1/reservations/7001/statuses/cancelled", query: {}, body: { cancelledBy: "host" } });
  assert.equal(b({ eligibility: { ...e } }).code, "ELIGIBILITY_REQUIRED");
  assert.equal(b({ eligibility: C.voidSendEligibility(voidIn({ intent: captureFailed1(), captureRows: [capRow()] })) }).code, "ELIGIBILITY_REQUIRED");
  assert.equal(b({ cancelOp: cancelOp({ state: "outcome_unknown", attempts: 1, dispatchedAt: at(9) }) }).code, "CANCEL_OPERATION_ALREADY_CLAIMED_OR_SENT");
  assert.equal(b({ captureRows: [SENT()] }).code, "ELIGIBILITY_SNAPSHOT_CHANGED", "history changed P -> D");
  assert.equal(b({ intent: { ...base.intent, settlement: { ...base.intent.settlement, authorizationSettled: true } } }).code, "ELIGIBILITY_SNAPSHOT_CHANGED");
  assert.equal(b({ intent: { ...base.intent, version: base.intent.version + 1 } }).code, "ELIGIBILITY_STALE");
  assert.equal(b({ now: NOW + 3 * 3600e3 }).code, "CARRIED_EVIDENCE_STALE", "hours later: carried evidence stale first");
  // local midnight crossings WITHIN the 5-minute window (America/Mazatlan = UTC-7 in December)
  const nearMidnight = (localDay, minutesBefore) => Date.UTC(2026, 11, localDay + 1, 7, 0) - minutesBefore * MIN;   // local 00:00 of localDay+1
  for (const [t0, code] of [[nearMidnight(18, 2), "ELIGIBILITY_SNAPSHOT_CHANGED"], [nearMidnight(19, 2), "ARRIVAL_NOT_IN_FUTURE"]]) {
    const bi = cancelIn({ now: t0, notBefore: t0 - 60 * MIN, byId: byIdEv({}, { observedAt: t0 - MIN }), piEvidence: piEv(rawPI(), { observedAt: t0 - MIN }) });
    const be = C.cancelSendEligibility(bi);
    assert.equal(be.ok, true, be.code);
    const r = C.buildCancelRequest({ intent: bi.intent, cancelOp: bi.cancelOp, captureRows: bi.captureRows, eligibility: be, paymentAttemptId: ATT, timeZone: TZ,
      now: t0 + 3 * MIN, notBefore: t0 - 60 * MIN });
    assert.equal(r.code, code, "local date changed / arrival reached");
  }
  assert.equal(b({ timeZone: "America/Chihuahua" }).code, "ELIGIBILITY_SNAPSHOT_CHANGED", "zone changed");
  assert.equal(b({ extra: 1 }).code, "UNEXPECTED_INPUT");
  const v = (req) => C.validateCancelRequest(req, { intent: base.intent, cancelOp: base.cancelOp });
  assert.equal(v(ok.request).ok, true);
  assert.equal(v({ ...ok.request, method: "DELETE" }).code, "METHOD");
  assert.equal(v({ ...ok.request, path: "/v1/reservations/7001" }).code, "PATH");
  assert.equal(v({ ...ok.request, query: { forceOverbooking: 1 } }).code, "QUERY_NOT_EMPTY");
  assert.equal(v({ ...ok.request, body: { cancelledBy: "guest" } }).code, "BODY");
  assert.equal(v({ ...ok.request, body: { cancelledBy: "host", refund: true } }).code, "BODY", "no refund path");
  assert.equal(v({ ...ok.request, headers: {} }).code, "REQUEST_SHAPE");
});

// ---------------------------------------------------------------------------------------------
// root HOLD on ddbf685: PI proof on EVERY cancel; builders re-check carried freshness at the CURRENT time

test("cancel requires fresh fully bound PI proof of zero money received in EVERY history (Z/P: still-authorized or canceled; D: canceled only)", () => {
  // Z/P still-authorized positive, also AFTER the capture deadline (no deadline-ahead requirement)
  assert.equal(C.cancelSendEligibility(cancelIn()).piEvidence.proof, "still_authorized");
  const cf0 = captureFailed0();
  const z = C.cancelSendEligibility(cancelIn({ intent: cf0, captureRows: [], piEvidence: piEv(rawPI({}, { payment_method_details: { card: { capture_before: CB_SHORT / 1000 } } })) }));
  assert.equal(z.ok, true, z.code); assert.ok(NOW > cf0.payment.captureBefore);
  // Z/P/D canceled positive
  for (const [intent, rows] of [[cf0, []], [captureFailed1(), [capRow()]], [captureFailed1(), [SENT("outcome_unknown", NOW - 10 * MIN)]]]) {
    const r = C.cancelSendEligibility(cancelIn({ intent, captureRows: rows, piEvidence: piEv(canceledRaw()) }));
    assert.equal(r.ok, true, r.code); assert.equal(r.piEvidence.proof, "canceled");
  }
  // refusals BEFORE issuing (Z and P alike)
  for (const [intent, rows, raw] of [[cf0, [], SHORT_CB], [captureFailed1(), [capRow()], rawPI]]) {
    const cases = [
      [{ piEvidence: undefined }, "PI_EVIDENCE_REQUIRED"], [{ piEvidence: null }, "PI_EVIDENCE_REQUIRED"],
      [{ paymentAttemptId: null }, "PAYMENT_ATTEMPT_REQUIRED"], [{ paymentAttemptId: undefined }, "PAYMENT_ATTEMPT_REQUIRED"], [{ paymentAttemptId: "" }, "PAYMENT_ATTEMPT_REQUIRED"],
      [{ paymentAttemptId: "other-attempt" }, "PI_PROOF_PAYMENT_INTENT_IDENTITY"],
      [{ piEvidence: piEv(raw({ status: "succeeded", amount_received: 90000, amount_capturable: 0 }, { captured: true, amount_captured: 90000 })) }, "PI_CAPTURED_OWNER_CASE"],
      [{ piEvidence: piEv(raw({ status: "processing", amount_capturable: 0 })) }, "PI_PROOF_NOT_REQUIRES_CAPTURE"],
      [{ piEvidence: piEv(raw({ amount_received: 100 })) }, "PI_PROOF_AMOUNT_RECEIVED_NOT_ZERO"],
      [{ piEvidence: piEv(raw({ amount_capturable: 100 })) }, "PI_PROOF_AMOUNT_CAPTURABLE_NOT_FULL"],
      [{ piEvidence: piEv(raw({}, { captured: true })) }, "PI_PROOF_CHARGE_ALREADY_CAPTURED"],
      [{ piEvidence: piEv(raw({ id: "pi_test_other" })) }, "PI_PROOF_PAYMENT_INTENT_IDENTITY"],
      [{ piEvidence: piEv(raw({ currency: "mxn" })) }, "PI_PROOF_PAYMENT_INTENT_IDENTITY"],
      [{ piEvidence: piEv(raw(), { observedAt: NOW - 6 * MIN }) }, "PI_PROOF_EVIDENCE_STALE"],
      [{ piEvidence: piEv(raw(), { observedAt: NOW + 1 }) }, "PI_PROOF_EVIDENCE_IN_FUTURE"],
      [{ piEvidence: piEv(raw(), { kind: "hostaway_reservation" }) }, "PI_EVIDENCE_REQUIRED"]
    ];
      [{ piEvidence: piEv(raw({}, { payment_method_details: { card: { capture_before: 5 } } })) }, "PI_PROOF_CAPTURE_BEFORE_MISMATCH"],
    assert.equal(C.cancelSendEligibility(cancelIn({ intent, captureRows: rows, piEvidence: piEv(raw()) })).ok, true, "positive control for this history");
    for (const [over, code] of cases) assert.equal(C.cancelSendEligibility(cancelIn({ intent, captureRows: rows, piEvidence: piEv(raw()), ...over })).code, code, `${rows.length} ${code}`);
  }
  // void: null / empty payment attempt refused
  for (const pa of [null, undefined, ""]) assert.equal(C.voidSendEligibility(voidIn({ paymentAttemptId: pa })).code, "PAYMENT_ATTEMPT_REQUIRED");
});

test("pre-claim builders re-check every CARRIED observation time at the CURRENT time (5 min boundary, clock before observation, state entry)", () => {
  // cancel: reservation evidence at NOW - 1 min and PI evidence at NOW - 2 min
  const ci = cancelIn({ piEvidence: piEv(rawPI(), { observedAt: NOW - 2 * MIN }) });
  const ce = C.cancelSendEligibility(ci);
  assert.equal(ce.ok, true, ce.code);
  const cb = (now, over = {}) => C.buildCancelRequest({ intent: ci.intent, cancelOp: ci.cancelOp, captureRows: ci.captureRows, eligibility: ce, paymentAttemptId: ATT,
    timeZone: TZ, now, notBefore: NOT_BEFORE, ...over });
  assert.equal(cb(NOW).ok, true, "valid immediately");
  assert.equal(cb(NOW + 3 * MIN).ok, true, "PI evidence exactly 5 min old: still fresh");
  assert.equal(cb(NOW + 3 * MIN + 1).code, "CARRIED_EVIDENCE_STALE", "PI evidence > 5 min");
  assert.equal(cb(NOW + 6 * MIN).code, "CARRIED_EVIDENCE_STALE", "root repro: same local date, 7-minute-old reservation evidence");
  assert.equal(C.localDateInZone(NOW + 6 * MIN, TZ), C.localDateInZone(NOW, TZ));
  assert.equal(cb(NOW - 2 * MIN - 1).code, "CARRIED_EVIDENCE_IN_FUTURE", "clock before an observation");
  assert.equal(cb(NOW, { notBefore: NOT_BEFORE + 1 }).code, "STATE_ENTRY_CHANGED");
  assert.equal(cb(NOW, { notBefore: undefined }).code, "STATE_ENTRY_CHANGED");
  assert.equal(cb(undefined).code, "CARRIED_FRESHNESS_INPUT_INVALID");
  // void
  const vi = voidIn({ evidence: piEv(rawPI(), { observedAt: NOW - MIN }) });
  const ve = C.voidSendEligibility(vi);
  const vb = (now, over = {}) => C.buildVoidRequest({ intent: vi.intent, voidOp: vi.voidOp, captureRows: vi.captureRows, eligibility: ve, paymentAttemptId: ATT,
    now, notBefore: NOT_BEFORE, ...over });
  assert.equal(vb(NOW).ok, true);
  assert.equal(vb(NOW + 4 * MIN).ok, true, "exactly 5 min");
  assert.equal(vb(NOW + 4 * MIN + 1).code, "CARRIED_EVIDENCE_STALE");
  assert.equal(vb(NOW - MIN - 1).code, "CARRIED_EVIDENCE_IN_FUTURE");
  assert.equal(vb(NOW, { notBefore: NOT_BEFORE - 1 }).code, "STATE_ENTRY_CHANGED");
  assert.equal(vb(NaN).code, "CARRIED_FRESHNESS_INPUT_INVALID");
  // carried data is the eligibility's own immutable values (frozen; never rewritten)
  assert.ok(Object.isFrozen(ce.piEvidence) && Object.isFrozen(ce.reservationObservedAts));
});
