// E7 captured-TEST cleanup — PURE proof / request foundation (lib/checkout/test-cleanup-proof.js). OFFLINE UNIT: no DB, network, SDK, clock.
// SYNTHETIC: every id / observation below is fixture data shaped like the accepted v3 observation; it is NOT provider proof.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as P from "../lib/checkout/test-cleanup-proof.js";
import { refundKey, captureKey, STATES } from "../lib/checkout/intent-state.js";
import { PROTECTED_HOSTAWAY_RESERVATION_IDS } from "../lib/checkout/compensation-proof.js";

const INTENT = "11111111-2222-4333-8444-555555555555"; const PI = "pi_test_cleanup0001"; const CH = "ch_test_cleanup0001"; const RE = "re_test_cleanup0001"; const PA = "pa-1";
const OP = "22222222-2222-4333-8444-555555555555"; const RID = "606998001"; const AMT = 576000;
const T0 = 1_800_000_000_000; const NOW = T0 + 60_000;
const intent = (o = {}) => ({ id: INTENT, version: 7, status: STATES.TEST_CLEANUP_PENDING, listingId: 606998, from: "2027-06-04", to: "2027-06-06", ref: "MV-SYNTH01", guests: 2, reasonCode: "TEST_CLEANUP_REQUESTED",
  price: { finalTotalMinor: AMT, currency: "USD" }, payment: { paymentIntentId: PI, amountMinor: AMT, currency: "usd", capturedMinor: AMT, livemode: false, captureBefore: T0 + 86400000 },
  counters: { captureAttempts: 1, cancelAttempts: 1, voidAttempts: 0, offlineChargeAttempts: 0 }, reservation: { reservationId: RID }, settlement: { reservationCancelled: true, authorizationSettled: false }, ...o });
const capRow = (o = {}) => ({ id: "cap-1", opType: P.OPS.CAPTURE, state: "succeeded", attempts: 1, dispatchedAt: T0 - 3600_000, resultRef: CH,
  payload: { paymentIntentId: PI, amountMinor: AMT, attempt: 1, providerIdempotencyKey: captureKey(INTENT, PI, 1) }, ...o });
const refundRow = (o = {}) => ({ id: OP, opType: P.OPS.REFUND, state: "pending", attempts: 0, dispatchedAt: null, resultRef: null,
  payload: { paymentIntentId: PI, chargeId: CH, amountMinor: AMT, currency: "USD", attempt: 1, providerIdempotencyKey: refundKey(INTENT, 1) }, ...o });
const cancelRow = (o = {}) => ({ id: "cancel-1", opType: P.OPS.CANCEL, state: "pending", attempts: 0, dispatchedAt: null, resultRef: null, payload: { reservationId: RID, cancelledBy: "host", attempt: 1 }, ...o });
const piObs = (o = {}, c = {}) => ({ proofVersion: "pi-proof-v3", object: "payment_intent", paymentIntentId: PI, accountVerified: true, livemode: false, metadataIntentId: INTENT, metadataAttemptId: PA,
  captureMethod: "manual", status: "succeeded", amountMinor: AMT, amountReceivedMinor: AMT, amountCapturableMinor: 0, currency: "USD",
  latestCharge: { object: "charge", id: CH, paymentIntent: PI, status: "succeeded", captured: true, amountMinor: AMT, amountCapturedMinor: AMT, amountRefundedMinor: 0, currency: "USD", livemode: false, paid: true, captureBefore: null, ...c }, ...o });
const piEv = (o = {}, c = {}, at = NOW - 1000) => ({ id: "ev-pi", kind: "payment_intent", readOpType: P.OPS.PI_READ, requestRef: PI, externalRef: PI, status: o.status ?? "succeeded", observed: piObs(o, c), observedAt: at });
const rawPi = (o = {}, c = {}) => ({ object: "payment_intent", id: PI, livemode: false, status: "succeeded", amount: AMT, amount_received: AMT, currency: "usd",
  latest_charge: { object: "charge", id: CH, payment_intent: PI, status: "succeeded", paid: true, captured: true, amount: AMT, amount_captured: AMT, amount_refunded: 0, refunded: false, disputed: false, currency: "usd", livemode: false, ...c }, ...o });
const refundObj = (o = {}) => ({ object: "refund", id: RE, payment_intent: PI, charge: CH, amount: AMT, currency: "usd", status: "succeeded", created: Math.floor(NOW / 1000), reason: null, failure_reason: null,
  metadata: { mv_refund_op: OP, mv_refund_key: refundKey(INTENT, 1) }, ...o });
const refundEv = (o = {}, at = NOW - 500) => ({ id: "ev-re", kind: "stripe_refund", readOpType: P.OPS.REFUND_READ, requestRef: RE, externalRef: RE, status: o.status ?? "succeeded", observed: { ...P.refundObservation(refundObj()), ...o }, observedAt: at });
const resEv = (o = {}, at = NOW - 800) => ({ id: "ev-res", kind: "hostaway_reservation", readOpType: P.OPS.RES_READ, requestRef: RID, externalRef: RID, status: "found_active",
  observed: { reservationId: RID, listingId: 606998, from: "2027-06-04", to: "2027-06-06", totalMinor: AMT, currency: "USD", status: "new", bookingRef: "MV-SYNTH01", ...o }, observedAt: at });

test("refundObservation copies provider values (expanded or string ids; metadata; integer created); nothing invented; usability needs object / re_ id / known status", () => {
  const o = P.refundObservation(refundObj({ payment_intent: { id: PI, object: "payment_intent" }, charge: { id: CH } }));
  assert.deepEqual(o, { proofVersion: "test-cleanup-proof-v1", object: "refund", refundId: RE, paymentIntentId: PI, chargeId: CH, amountMinor: AMT, currency: "USD", status: "succeeded",
    created: Math.floor(NOW / 1000), reason: null, failureReason: null, metadataRefundOp: OP, metadataRefundKey: refundKey(INTENT, 1) });
  assert.deepEqual(P.refundObservation({ id: 5, amount: "576000", created: 1.5, metadata: null }), { proofVersion: "test-cleanup-proof-v1", object: null, refundId: null, paymentIntentId: null, chargeId: null,
    amountMinor: null, currency: null, status: null, created: null, reason: null, failureReason: null, metadataRefundOp: null, metadataRefundKey: null });
  assert.equal(P.refundObjectUsable(refundObj()), true);
  for (const bad of [null, [], refundObj({ object: "charge" }), refundObj({ id: "ch_x" }), refundObj({ status: "done" }), refundObj({ status: undefined })]) assert.equal(P.refundObjectUsable(bad), false);
  assert.deepEqual(P.REFUND_STATUSES, ["pending", "requires_action", "succeeded", "failed", "canceled"]);
});

test("singleCaptureProof: exactly ONE succeeded attempt-1 capture row with the bound key / amount / PI and a recorded charge id; everything else refuses", () => {
  const ok = P.singleCaptureProof({ intent: intent(), captureRows: [capRow()] });
  assert.deepEqual([ok.ok, ok.chargeId], [true, CH]);
  for (const [label, rows, code] of [["none", [], "CAPTURE_HISTORY_NOT_SINGLE"], ["two", [capRow(), capRow({ id: "cap-2" })], "CAPTURE_HISTORY_NOT_SINGLE"],
    ["pending", [capRow({ state: "pending", attempts: 0, dispatchedAt: null })], "CAPTURE_ROW_NOT_SUCCEEDED"], ["unknown", [capRow({ state: "outcome_unknown" })], "CAPTURE_ROW_NOT_SUCCEEDED"],
    ["no charge", [capRow({ resultRef: PI })], "CAPTURE_CHARGE_NOT_RECORDED"], ["other PI", [capRow({ payload: { ...capRow().payload, paymentIntentId: "pi_other" } })], "CAPTURE_ROW_BINDING"],
    ["partial", [capRow({ payload: { ...capRow().payload, amountMinor: AMT - 1 } })], "CAPTURE_ROW_BINDING"], ["key", [capRow({ payload: { ...capRow().payload, providerIdempotencyKey: "cap:x" } })], "CAPTURE_ROW_BINDING"],
    ["shape", [capRow({ payload: { paymentIntentId: PI } })], "CAPTURE_ROW_PAYLOAD_SHAPE"]]) assert.equal(P.singleCaptureProof({ intent: intent(), captureRows: rows }).code, code, label);
  for (const [label, i, code] of [["not cleanup state", intent({ status: "payment_captured" }), "NOT_TEST_CLEANUP_PENDING"], ["live", intent({ payment: { ...intent().payment, livemode: true } }), "INTENT_NOT_TEST_MODE"],
    ["captured ≠ price", intent({ payment: { ...intent().payment, capturedMinor: AMT - 1 } }), "CAPTURED_AMOUNT_NOT_PRICE"], ["protected", intent({ reservation: { reservationId: PROTECTED_HOSTAWAY_RESERVATION_IDS[0] } }), "PROTECTED_RESERVATION_ID"],
    ["no reservation", intent({ reservation: null }), "NO_RESERVATION"]]) assert.equal(P.singleCaptureProof({ intent: i, captureRows: [capRow()] }).code, code, label);
});

test("piCapturedUnrefundedProofV3 / rawPiPreSendRefusal: full capture on exactly the capture row's charge, NO refund, no dispute, TEST mode, fresh; every contradiction refuses", () => {
  const f = { now: NOW, notBefore: T0 };
  assert.equal(P.piCapturedUnrefundedProofV3(piEv(), intent(), PA, CH, f), null);
  const cases = [[piEv({}, { amountRefundedMinor: 1 }), "CHARGE_ALREADY_REFUNDED"], [piEv({}, { id: "ch_other" }), "CHARGE_ID_MISMATCH"], [piEv({}, { captured: false }), "CHARGE_NOT_CAPTURED"],
    [piEv({}, { livemode: true }), "CHARGE_NOT_TEST_MODE"], [piEv({ status: "requires_capture", amountReceivedMinor: 0 }), "PI_NOT_SUCCEEDED"], [piEv({ amountReceivedMinor: AMT - 1 }), "AMOUNT_RECEIVED_NOT_CAPTURED"],
    [piEv({ metadataAttemptId: "pa-9" }), "PAYMENT_INTENT_IDENTITY"], [piEv({ livemode: true }), "PAYMENT_INTENT_IDENTITY"], [piEv({ accountVerified: false }), "PAYMENT_INTENT_IDENTITY"],
    [piEv({ proofVersion: "pi-proof-v2" }), "V3_OBSERVATION_REQUIRED"], [piEv({}, { paid: null }), "CHARGE_NOT_PAID"], [piEv({}, { currency: "MXN" }), "CHARGE_CURRENCY"],
    [piEv({}, {}, NOW - P.PROOF_MAX_AGE_MS - 1), "EVIDENCE_STALE"], [piEv({}, {}, T0 - 1), "EVIDENCE_BEFORE_STATE"], [piEv({}, {}, NOW + 1), "EVIDENCE_IN_FUTURE"],
    [{ ...piEv(), kind: "stripe_refund" }, "PI_EVIDENCE_SHAPE"]];
  for (const [ev, code] of cases) assert.equal(P.piCapturedUnrefundedProofV3(ev, intent(), PA, CH, f), code, code);
  assert.equal(P.piCapturedUnrefundedProofV3(piEv(), intent(), PA, "ch_other", f), "CHARGE_ID_MISMATCH");
  const b = { paymentIntentId: PI, chargeId: CH, amountMinor: AMT, currency: "USD" };
  assert.equal(P.rawPiPreSendRefusal(rawPi(), b), null);
  assert.equal(P.rawPiPreSendRefusal(rawPi({}, { refunds: { object: "list", data: [], has_more: false } }), b), null, "an empty refunds list is fine");
  for (const [pi, code] of [[rawPi({}, { amount_refunded: 1 }), "RAW_CHARGE_AMOUNT_REFUNDED"], [rawPi({}, { refunded: true }), "RAW_CHARGE_REFUNDED"], [rawPi({}, { refunded: undefined }), "RAW_CHARGE_REFUNDED"],
    [rawPi({}, { disputed: true }), "RAW_CHARGE_DISPUTED"], [rawPi({}, { disputed: undefined }), "RAW_CHARGE_DISPUTED"], [rawPi({}, { dispute: "dp_1" }), "RAW_CHARGE_DISPUTE_PRESENT"],
    [rawPi({}, { refunds: { object: "list", data: [{ id: RE }], has_more: false } }), "RAW_CHARGE_REFUNDS_PRESENT"], [rawPi({}, { refunds: { object: "list", data: [], has_more: true } }), "RAW_CHARGE_REFUNDS_PRESENT"],
    [rawPi({ livemode: true }), "RAW_PI_NOT_TEST_MODE"], [rawPi({ amount_received: AMT - 1 }), "RAW_PI_NOT_CAPTURED_FULL"], [rawPi({}, { id: "ch_other" }), "RAW_CHARGE_IDENTITY"], [rawPi({ currency: "mxn" }), "RAW_PI_CURRENCY"],
    [rawPi({}, { captured: false }), "RAW_CHARGE_NOT_CAPTURED"], [rawPi({ id: "pi_other" }), "RAW_PI_IDENTITY"]]) assert.equal(P.rawPiPreSendRefusal(pi, b), code, code);
});

test("piCapturedFullyRefundedProofV3 (post-send, mirrors booking.test_refund_pi_observation_ok): amount_refunded = captured; refunded flag may not contradict; observed after the dispatch", () => {
  const f = { now: NOW, notBefore: NOW - 10_000 };
  assert.equal(P.piCapturedFullyRefundedProofV3(piEv({}, { amountRefundedMinor: AMT }), intent(), PA, CH, f), null);
  assert.equal(P.piCapturedFullyRefundedProofV3(piEv({}, { amountRefundedMinor: AMT, refunded: true }), intent(), PA, CH, f), null);
  for (const [ev, code] of [[piEv(), "CHARGE_NOT_FULLY_REFUNDED"], [piEv({}, { amountRefundedMinor: AMT - 1 }), "CHARGE_NOT_FULLY_REFUNDED"], [piEv({}, { amountRefundedMinor: AMT, refunded: false }), "CHARGE_REFUNDED_FLAG"],
    [piEv({}, { amountRefundedMinor: AMT }, NOW - 20_000), "EVIDENCE_BEFORE_DISPATCH"], [piEv({}, { amountRefundedMinor: AMT, id: "ch_other" }), "CHARGE_ID_MISMATCH"],
    [piEv({ amountReceivedMinor: 0 }, { amountRefundedMinor: AMT }), "AMOUNT_RECEIVED_NOT_CAPTURED"]]) assert.equal(P.piCapturedFullyRefundedProofV3(ev, intent(), PA, CH, f), code, code);
});

test("refundReadProof: the API read of exactly OUR refund id, bound to PI / charge / exact amount / currency, status succeeded, observed after the dispatch", () => {
  const b = { intent: intent(), chargeId: CH, refundId: RE, dispatchedAt: NOW - 2000, now: NOW };
  assert.equal(P.refundReadProof(refundEv(), b), null);
  for (const [ev, code] of [[refundEv({ amountMinor: AMT - 1 }), "REFUND_AMOUNT"], [refundEv({ chargeId: "ch_other" }), "REFUND_CHARGE"], [refundEv({ paymentIntentId: "pi_other" }), "REFUND_PAYMENT_INTENT"],
    [refundEv({ currency: "MXN" }), "REFUND_CURRENCY"], [refundEv({ status: "pending" }), "REFUND_STATUS_PENDING"], [refundEv({ status: "failed" }), "REFUND_STATUS_FAILED"],
    [refundEv({ refundId: "re_other" }), "REFUND_ID_MISMATCH"], [{ ...refundEv(), externalRef: "re_other" }, "REFUND_EVIDENCE_NOT_BOUND"], [{ ...refundEv(), kind: "payment_intent" }, "REFUND_EVIDENCE_SHAPE"],
    [refundEv({}, NOW - 3000), "EVIDENCE_BEFORE_DISPATCH"], [refundEv({}, NOW + 1), "EVIDENCE_TIME_INVALID"]]) assert.equal(P.refundReadProof(ev, b), code, code);
  assert.equal(P.refundReadProof(refundEv(), { ...b, refundId: "re_other" }), "REFUND_EVIDENCE_NOT_BOUND", "the read of another id never proves ours");
  assert.equal(P.refundReadProof(refundEv(), { ...b, refundId: "ch_x" }), "REFUND_ID_INVALID");
});

test("refundDiscovery (§5): has_more refused outright; exactly ONE refund that binds by metadata + charge + amount + currency; `created` only excludes (floor(dispatch)-1 … ceil(now)); pending returned for bounded reads", () => {
  const dispatchedAt = NOW - 30_000;
  const list = (data, has_more = false) => ({ object: "list", data, has_more });
  const args = (l) => ({ list: l, intent: intent(), chargeId: CH, opId: OP, dispatchedAt, now: NOW });
  assert.deepEqual(P.refundDiscovery(args(list([refundObj()]))), { ok: true, refundId: RE, status: "succeeded" });
  assert.deepEqual(P.refundDiscovery(args(list([refundObj({ status: "pending" })]))), { ok: true, refundId: RE, status: "pending" });
  assert.deepEqual(P.refundDiscovery(args(list([refundObj({ created: Math.floor(dispatchedAt / 1000) - 1 })]))), { ok: true, refundId: RE, status: "succeeded" }, "one second of slack towards the past");
  for (const [label, l, code] of [["truncated", list([refundObj()], true), "REFUND_LIST_TRUNCATED"], ["none", list([]), "REFUND_NOT_FOUND"], ["two", list([refundObj(), refundObj({ id: "re_2" })]), "REFUND_AMBIGUOUS"],
    ["other op", list([refundObj({ metadata: { mv_refund_op: "33333333-2222-4333-8444-555555555555", mv_refund_key: refundKey(INTENT, 1) } })]), "REFUND_AMBIGUOUS"],
    ["other key", list([refundObj({ metadata: { mv_refund_op: OP, mv_refund_key: refundKey(INTENT, 2) } })]), "REFUND_AMBIGUOUS"], ["no metadata", list([refundObj({ metadata: {} })]), "REFUND_AMBIGUOUS"],
    ["partial", list([refundObj({ amount: AMT - 1 })]), "REFUND_AMBIGUOUS"], ["other charge", list([refundObj({ charge: "ch_other" })]), "REFUND_AMBIGUOUS"], ["other currency", list([refundObj({ currency: "mxn" })]), "REFUND_AMBIGUOUS"],
    ["created too early", list([refundObj({ created: Math.floor(dispatchedAt / 1000) - 2 })]), "REFUND_AMBIGUOUS"], ["created in the future", list([refundObj({ created: Math.ceil(NOW / 1000) + 1 })]), "REFUND_AMBIGUOUS"],
    ["created missing", list([refundObj({ created: undefined })]), "REFUND_AMBIGUOUS"], ["not a refund", list([{ object: "charge", id: CH }]), "REFUND_LIST_UNUSABLE"],
    ["not a list", { object: "refund" }, "REFUND_LIST_UNUSABLE"], ["has_more missing", { object: "list", data: [refundObj()] }, "REFUND_LIST_UNUSABLE"]]) assert.equal(P.refundDiscovery(args(l)).code, code, label);
  assert.equal(P.refundDiscovery({ ...args(list([refundObj()])), opId: "not-a-uuid" }).code, "DISCOVERY_INPUT_INVALID");
  assert.equal(P.DISCOVERY_CREATED_SLACK_S, 1);
});

test("cleanupCancelEligibility / buildCleanupCancelRequest: open reservation leg, attempt-1 pending row, fresh active identity, fresh captured-unrefunded PI; exact PUT; snapshot + brand + freshness carried", () => {
  const i = intent({ settlement: { reservationCancelled: false, authorizationSettled: false } });
  const TZ = "America/Mazatlan";
  const base = { intent: i, paymentAttemptId: PA, cancelOp: cancelRow(), captureRows: [capRow()], byId: resEv(), piEvidence: piEv(), rawPi: rawPi(), timeZone: TZ, now: NOW, notBefore: T0 };
  const e = P.cleanupCancelEligibility(base);
  assert.equal(e.ok, true, e.code); assert.equal(e.purpose, P.CANCEL_PURPOSE); assert.ok(Object.isFrozen(e));
  assert.deepEqual([e.snapshot.timeZone, e.snapshot.localDate], [TZ, "2027-01-15"]);
  const b = P.buildCleanupCancelRequest({ intent: i, cancelOp: cancelRow(), captureRows: [capRow()], eligibility: e, paymentAttemptId: PA, timeZone: TZ, now: NOW, notBefore: T0 });
  assert.deepEqual(b, { ok: true, request: { method: "PUT", path: `/v1/reservations/${RID}/statuses/cancelled`, query: {}, body: { cancelledBy: "host" } } });
  assert.equal(P.validateCancelRequest(b.request, { intent: i, cancelOp: cancelRow() }).ok, true);
  for (const [label, over, code] of [["leg settled", { intent: intent() }, "RESERVATION_LEG_NOT_OPEN"], ["attempt 2 row", { cancelOp: cancelRow({ payload: { reservationId: RID, cancelledBy: "host", attempt: 2 } }) }, "CANCEL_NOT_INITIAL_ATTEMPT"],
    ["claimed row", { cancelOp: cancelRow({ state: "in_flight", attempts: 1, dispatchedAt: NOW }) }, "CANCEL_OPERATION_ALREADY_CLAIMED_OR_SENT"], ["other reservation", { cancelOp: cancelRow({ payload: { reservationId: "1", cancelledBy: "host", attempt: 1 } }) }, "CANCEL_RESERVATION"],
    ["refunded PI", { piEvidence: piEv({}, { amountRefundedMinor: AMT }) }, "PI_PROOF_CHARGE_ALREADY_REFUNDED"], ["uncaptured PI", { piEvidence: piEv({ status: "requires_capture", amountReceivedMinor: 0 }) }, "PI_PROOF_PI_NOT_SUCCEEDED"],
    ["reservation cancelled", { byId: { ...resEv({ status: "cancelled" }), status: "cancelled" } }, "BY_ID_RESERVATION_NOT_ACTIVE"], ["identity", { byId: resEv({ totalMinor: 1 }) }, "BY_ID_RESERVATION_IDENTITY"],
    ["protected", { intent: intent({ settlement: i.settlement, reservation: { reservationId: PROTECTED_HOSTAWAY_RESERVATION_IDS[1] } }), cancelOp: cancelRow({ payload: { reservationId: PROTECTED_HOSTAWAY_RESERVATION_IDS[1], cancelledBy: "host", attempt: 1 } }) }, "PROTECTED_RESERVATION_ID"],
    ["no attempt", { paymentAttemptId: "" }, "PAYMENT_ATTEMPT_REQUIRED"], ["two captures", { captureRows: [capRow(), capRow({ id: "cap-2" })] }, "CAPTURE_CAPTURE_HISTORY_NOT_SINGLE"],
    // F3 (ROOT 5880626183): the raw refund / dispute safeguards gate the CANCEL too
    ["raw disputed", { rawPi: rawPi({}, { disputed: true }) }, "CANCEL_PRECONDITION_RAW_CHARGE_DISPUTED"], ["raw refunds list", { rawPi: rawPi({}, { refunds: { object: "list", has_more: false, data: [{ id: "re_external999" }] } }) }, "CANCEL_PRECONDITION_RAW_CHARGE_REFUNDS_PRESENT"],
    ["raw partial refund", { rawPi: rawPi({}, { amount_refunded: 1 }) }, "CANCEL_PRECONDITION_RAW_CHARGE_AMOUNT_REFUNDED"], ["raw refunded flag missing", { rawPi: rawPi({}, { refunded: undefined }) }, "CANCEL_PRECONDITION_RAW_CHARGE_REFUNDED"],
    ["raw disputed flag missing", { rawPi: rawPi({}, { disputed: undefined }) }, "CANCEL_PRECONDITION_RAW_CHARGE_DISPUTED"], ["raw missing", { rawPi: null }, "CANCEL_PRECONDITION_RAW_PI_IDENTITY"],
    // residual (ROOT 5880626183): the INITIAL cancellation needs a strictly future arrival in the listing zone
    ["arrival today", { intent: { ...i, from: "2027-01-15", to: "2027-01-17" }, byId: resEv({ from: "2027-01-15", to: "2027-01-17" }) }, "ARRIVAL_NOT_IN_FUTURE"],
    ["arrival past", { intent: { ...i, from: "2026-12-01", to: "2026-12-03" }, byId: resEv({ from: "2026-12-01", to: "2026-12-03" }) }, "ARRIVAL_NOT_IN_FUTURE"],
    ["zone invalid", { timeZone: "+07:00" }, "TIME_ZONE_OR_CLOCK_INVALID"], ["zone missing", { timeZone: undefined }, "TIME_ZONE_OR_CLOCK_INVALID"]]) {
    assert.equal(P.cleanupCancelEligibility({ ...base, ...over }).code, code, label);
  }
  // the local date is part of the snapshot: a day boundary between eligibility and build refuses (re-check at the fresh clock)
  assert.equal(P.buildCleanupCancelRequest({ intent: i, cancelOp: cancelRow(), captureRows: [capRow()], eligibility: e, paymentAttemptId: PA, timeZone: TZ, now: NOW + 86400_000 * 200, notBefore: T0 }).code, "CARRIED_EVIDENCE_STALE");
  assert.equal(P.buildCleanupCancelRequest({ intent: i, cancelOp: cancelRow(), captureRows: [capRow()], eligibility: e, paymentAttemptId: PA, timeZone: "America/New_York", now: NOW, notBefore: T0 }).code, "ELIGIBILITY_SNAPSHOT_CHANGED");
  // the builder: brand required; stale version / snapshot / carried freshness refuse
  assert.equal(P.buildCleanupCancelRequest({ intent: i, cancelOp: cancelRow(), captureRows: [capRow()], eligibility: { ...e }, paymentAttemptId: PA, timeZone: TZ, now: NOW, notBefore: T0 }).code, "ELIGIBILITY_REQUIRED");
  assert.equal(P.buildCleanupCancelRequest({ intent: { ...i, version: 8 }, cancelOp: cancelRow(), captureRows: [capRow()], eligibility: e, paymentAttemptId: PA, timeZone: TZ, now: NOW, notBefore: T0 }).code, "ELIGIBILITY_STALE");
  assert.equal(P.buildCleanupCancelRequest({ intent: i, cancelOp: cancelRow(), captureRows: [capRow()], eligibility: e, paymentAttemptId: PA, timeZone: TZ, now: NOW + P.PROOF_MAX_AGE_MS + 1, notBefore: T0 }).code, "CARRIED_EVIDENCE_STALE");
  assert.equal(P.buildCleanupCancelRequest({ intent: i, cancelOp: cancelRow(), captureRows: [capRow()], eligibility: e, paymentAttemptId: "pa-2", timeZone: TZ, now: NOW, notBefore: T0 }).code, "ELIGIBILITY_SNAPSHOT_CHANGED");
  assert.equal(P.buildCleanupCancelRequest({ intent: i, cancelOp: cancelRow(), captureRows: [capRow()], eligibility: e, paymentAttemptId: PA, timeZone: TZ, now: NOW, notBefore: T0 + 1 }).code, "STATE_ENTRY_CHANGED");
  assert.equal(P.buildCleanupCancelRequest({ intent: i, cancelOp: cancelRow(), captureRows: [capRow()], eligibility: e, paymentAttemptId: PA, now: NOW, notBefore: T0 }).code, "UNEXPECTED_INPUT");
  // a by-id read without the echoed ref needs the by-ref lookup with matchCount 1
  const noRef = resEv({ bookingRef: undefined }); delete noRef.observed.bookingRef;
  assert.equal(P.cleanupCancelEligibility({ ...base, byId: noRef }).code, "BY_REF_RESERVATION_EVIDENCE_SHAPE");
  const byRef = { ...resEv({ matchCount: 1 }), readOpType: P.OPS.LOOKUP, requestRef: "MV-SYNTH01" };
  assert.equal(P.cleanupCancelEligibility({ ...base, byId: noRef, byRef }).ok, true);
});

test("refundSendEligibility / buildRefundRequest / validateRefundRequest: ORDER (cancel settled first), open refund leg, the ONE bound row, fresh unrefunded PI + raw aggregates; exact request (full amount, both metadata fields, key = ref:<intent>:1)", () => {
  const base = { intent: intent(), paymentAttemptId: PA, refundOp: refundRow(), captureRows: [capRow()], piEvidence: piEv(), rawPi: rawPi(), now: NOW, notBefore: T0 };
  const e = P.refundSendEligibility(base);
  assert.equal(e.ok, true, e.code); assert.equal(e.purpose, P.REFUND_PURPOSE);
  assert.deepEqual([e.paymentIntentId, e.chargeId, e.amountMinor, e.currency, e.idempotencyKey], [PI, CH, AMT, "USD", refundKey(INTENT, 1)]);
  const b = P.buildRefundRequest({ intent: intent(), refundOp: refundRow(), captureRows: [capRow()], eligibility: e, paymentAttemptId: PA, now: NOW, notBefore: T0 });
  assert.deepEqual(b, { ok: true, request: { paymentIntentId: PI, params: { amount: AMT, metadata: { mv_refund_op: OP, mv_refund_key: refundKey(INTENT, 1) } }, options: { idempotencyKey: refundKey(INTENT, 1) } } });
  assert.ok(Object.isFrozen(b.request) && Object.isFrozen(b.request.params) && Object.isFrozen(b.request.params.metadata));
  assert.equal(P.validateRefundRequest(b.request, { intent: intent(), refundOp: refundRow(), chargeId: CH }).ok, true);
  for (const [label, over, code] of [["cancel leg still open", { intent: intent({ settlement: { reservationCancelled: false, authorizationSettled: false } }) }, "CANCEL_LEG_NOT_SETTLED"],
    ["refund leg settled", { intent: intent({ settlement: { reservationCancelled: true, authorizationSettled: true } }) }, "REFUND_LEG_NOT_OPEN"],
    ["row claimed", { refundOp: refundRow({ state: "in_flight", attempts: 1, dispatchedAt: NOW }) }, "REFUND_OPERATION_ALREADY_CLAIMED_OR_SENT"], ["row unknown", { refundOp: refundRow({ state: "outcome_unknown", attempts: 1, dispatchedAt: NOW }) }, "REFUND_OPERATION_ALREADY_CLAIMED_OR_SENT"],
    ["partial row", { refundOp: refundRow({ payload: { ...refundRow().payload, amountMinor: AMT - 1 } }) }, "REFUND_AMOUNT"], ["other charge row", { refundOp: refundRow({ payload: { ...refundRow().payload, chargeId: "ch_other" } }) }, "REFUND_CHARGE"],
    ["attempt 2", { refundOp: refundRow({ payload: { ...refundRow().payload, attempt: 2 } }) }, "REFUND_NOT_INITIAL_ATTEMPT"], ["other key", { refundOp: refundRow({ payload: { ...refundRow().payload, providerIdempotencyKey: refundKey(INTENT, 2) } }) }, "REFUND_IDEMPOTENCY_KEY"],
    ["refunded already", { piEvidence: piEv({}, { amountRefundedMinor: AMT }) }, "PI_PROOF_CHARGE_ALREADY_REFUNDED"], ["raw disputed", { rawPi: rawPi({}, { disputed: true }) }, "REFUND_PRECONDITION_RAW_CHARGE_DISPUTED"],
    ["raw refunded", { rawPi: rawPi({}, { amount_refunded: 1 }) }, "REFUND_PRECONDITION_RAW_CHARGE_AMOUNT_REFUNDED"], ["stale PI", { piEvidence: piEv({}, {}, NOW - P.PROOF_MAX_AGE_MS - 1) }, "PI_PROOF_EVIDENCE_STALE"],
    ["other state", { intent: intent({ status: "capture_failed" }) }, "NOT_TEST_CLEANUP_PENDING"], ["no attempt", { paymentAttemptId: null }, "PAYMENT_ATTEMPT_REQUIRED"]]) {
    assert.equal(P.refundSendEligibility({ ...base, ...over }).code, code, label);
  }
  const bad = (req, code) => assert.equal(P.validateRefundRequest(req, { intent: intent(), refundOp: refundRow(), chargeId: CH }).code, code, code);
  bad({ ...b.request, params: { amount: AMT - 1, metadata: b.request.params.metadata } }, "PARTIAL_OR_WRONG_AMOUNT");
  bad({ ...b.request, params: { amount: AMT, metadata: b.request.params.metadata, reason: "requested_by_customer" } }, "PARAMS_SHAPE");
  bad({ ...b.request, params: { amount: AMT, metadata: { mv_refund_op: OP } } }, "METADATA_SHAPE");
  bad({ ...b.request, params: { amount: AMT, metadata: { mv_refund_op: "other", mv_refund_key: refundKey(INTENT, 1) } } }, "METADATA_BINDING");
  bad({ ...b.request, options: { idempotencyKey: "ref:x:1" } }, "IDEMPOTENCY_KEY");
  bad({ ...b.request, paymentIntentId: "pi_other" }, "REQUEST_PAYMENT_INTENT");
  assert.equal(P.buildRefundRequest({ intent: intent(), refundOp: refundRow(), captureRows: [capRow()], eligibility: { ...e }, paymentAttemptId: PA, now: NOW, notBefore: T0 }).code, "ELIGIBILITY_REQUIRED");
  assert.equal(P.buildRefundRequest({ intent: intent({ version: 8 }), refundOp: refundRow(), captureRows: [capRow()], eligibility: e, paymentAttemptId: PA, now: NOW, notBefore: T0 }).code, "ELIGIBILITY_STALE");
  assert.equal(P.buildRefundRequest({ intent: intent(), refundOp: refundRow({ state: "in_flight", attempts: 1, dispatchedAt: NOW }), captureRows: [capRow()], eligibility: e, paymentAttemptId: PA, now: NOW, notBefore: T0 }).code, "REFUND_OPERATION_ALREADY_CLAIMED_OR_SENT");
  assert.equal(P.buildRefundRequest({ intent: intent(), refundOp: refundRow(), captureRows: [capRow()], eligibility: e, paymentAttemptId: PA, now: NOW + P.PROOF_MAX_AGE_MS + 1, notBefore: T0 }).code, "CARRIED_EVIDENCE_STALE");
  assert.equal(P.buildRefundRequest({ intent: intent(), refundOp: refundRow(), captureRows: [capRow()], eligibility: e, paymentAttemptId: PA, now: NOW, notBefore: T0, extra: 1 }).code, "UNEXPECTED_INPUT");
});

test("purity: no I/O / clock / env / SDK / network imports; exact import list; the frozen journal grammar and the accepted workers are not imported", () => {
  const src = readFileSync(new URL("../lib/checkout/test-cleanup-proof.js", import.meta.url), "utf8");
  assert.deepEqual([...src.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]).sort(), ["./capture-proof.js", "./compensation-proof.js", "./intent-state.js", "./recovery-plan.js"]);
  assert.doesNotMatch(src, /\b(fetch|Date\.now|process\.env|setTimeout|setInterval|require\(|node:|from "stripe"|from "pg")/);
  assert.doesNotMatch(src, /from "[^"]*(booking-db|run-journal|e7-connected)/);
});
