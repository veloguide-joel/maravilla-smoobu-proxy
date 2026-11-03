// Stage E7.3a — pure capture-proof foundation: v3 observation, strict initial-send eligibility, exact capture request.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createIntent, transition, captureKey } from "../lib/checkout/intent-state.js";
import { paymentIntentProofObservation, piCapturedProof, piGoneProof, piStillAuthorizedProof } from "../lib/checkout/recovery-plan.js";
import {
  paymentIntentProofObservationV3, initialCaptureSendEligibility, buildCaptureRequest, validateCaptureRequest, stillAuthorizedV3Refusal,
  secondsToMsOrNull, CAPTURE_PROOF_VERSION, ELIGIBILITY_PURPOSE
} from "../lib/checkout/capture-proof.js";

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
const CAPTURE_BEFORE = at(4) + 7 * 24 * 60 * MIN;
const step = (i, e, m) => { const r = transition(i, e, { now: at(m) }); assert.equal(r.ok, true, `${e.type}: ${r.error}`); return r.intent; };
function confirmed() {
  let i = createIntent({ id: "int-1", ref: "MV-ABC123", listingId: 603566, from: "2026-12-20", to: "2026-12-24", guests: 2, now: at(0) });
  i = step(i, { type: "PRICE_CONFIRMED", price: PRICE }, 0);
  i = step(i, { type: "DETAILS_COLLECTED" }, 1);
  i = step(i, { type: "CHECKOUT_PREPARED", sessionId: "cs_test_1" }, 2);
  i = step(i, { type: "PAYMENT_AUTHORIZED", paymentIntentId: PI, sessionId: "cs_test_1", amountMinor: 90000, currency: "usd", livemode: false,
    authorizationCreatedAt: at(4), captureBefore: CAPTURE_BEFORE }, 5);
  i = step(i, { type: "RESERVATION_STARTED", workerId: "w1", recheck: { bookable: true, priceSame: true } }, 6);
  i = step(i, { type: "RESERVATION_DISPATCHED", workerId: "w1" }, 6);
  return step(i, { type: "RESERVATION_SUCCEEDED", reservation: RES }, 7);
}
const rawPI = (over = {}, chOver = {}, cardOver = {}) => ({
  id: PI, object: "payment_intent", livemode: false, capture_method: "manual", status: "requires_capture", amount: 90000, amount_received: 0,
  amount_capturable: 90000, currency: "usd", metadata: { mv_intent_id: "int-1", mv_payment_attempt_id: ATT },
  latest_charge: { object: "charge", id: "ch_1", payment_intent: PI, status: "succeeded", paid: true, captured: false, amount: 90000, amount_captured: 0,
    amount_refunded: 0, currency: "usd", livemode: false, billing_details: { email: "guest@example.test" },
    payment_method_details: { card: { capture_before: CAPTURE_BEFORE / 1000, last4: "4242", ...cardOver } }, ...chOver },
  ...over
});
const evOf = (observed, over = {}) => ({ id: "ev-1", kind: "payment_intent", readOpType: "stripe.retrieve_payment_intent", requestRef: PI, externalRef: PI,
  status: observed.status, observed, ...over });
const v3 = (over, chOver, cardOver) => paymentIntentProofObservationV3(rawPI(over, chOver, cardOver), { accountVerified: true });
const OP = () => ({ id: "op-cap-1", opType: "stripe.capture_payment_intent", state: "pending", dispatchedAt: null,
  payload: { paymentIntentId: PI, amountMinor: 90000, attempt: 1, providerIdempotencyKey: captureKey("int-1", PI, 1) } });
const elig = (extra = {}) => initialCaptureSendEligibility({ evidence: evOf(v3()), intent: confirmed(), paymentAttemptId: ATT, captureOp: OP(),
  captureHistory: [OP()], ...extra });

test("v3 observation: copies the accepted v2 values plus charge.paid and charge.captureBefore; nothing else, no customer data", () => {
  const raw = rawPI();
  const o = paymentIntentProofObservationV3(raw, { accountVerified: true });
  const two = paymentIntentProofObservation(raw, { accountVerified: true });
  assert.equal(o.proofVersion, CAPTURE_PROOF_VERSION);
  const { proofVersion: _a, latestCharge: lc3, ...rest3 } = o; const { proofVersion: _b, latestCharge: lc2, ...rest2 } = two;
  assert.deepEqual(rest3, rest2, "v2 top-level values unchanged");
  assert.deepEqual(lc3, { ...lc2, paid: true, captureBefore: CAPTURE_BEFORE });
  assert.ok(!JSON.stringify(o).includes("guest@example.test") && !JSON.stringify(o).includes("4242"));
  // unexpanded / missing charge: v2 shape + the two fields null (never coerced or invented)
  assert.deepEqual(paymentIntentProofObservationV3(rawPI({ latest_charge: "ch_1" }), { accountVerified: true }).latestCharge,
    { ...paymentIntentProofObservation(rawPI({ latest_charge: "ch_1" }), {}).latestCharge, paid: null, captureBefore: null });
  assert.equal(paymentIntentProofObservationV3(rawPI({ latest_charge: null }), { accountVerified: true }).latestCharge, null);
  assert.equal(paymentIntentProofObservationV3({}, {}).accountVerified, false);
  // mistyped values stay null
  const odd = paymentIntentProofObservationV3(rawPI({}, { paid: "true", payment_method_details: { card: { capture_before: "1800000000" } } }), { accountVerified: true });
  assert.deepEqual([odd.latestCharge.paid, odd.latestCharge.captureBefore], [null, null]);
  assert.equal(paymentIntentProofObservationV3(rawPI({}, { payment_method_details: null }), {}).latestCharge.captureBefore, null);
  assert.equal(paymentIntentProofObservationV3(rawPI({}, { payment_method_details: { card: null } }), {}).latestCharge.captureBefore, null);
});

test("safe timestamp conversion", () => {
  assert.equal(secondsToMsOrNull(1_800_000_000), 1_800_000_000_000);
  for (const bad of [0, -1, 1.5, "1800000000", null, undefined, NaN, Infinity, Number.MAX_SAFE_INTEGER, 2 ** 53, 9_007_199_254_741]) {
    assert.equal(secondsToMsOrNull(bad), null, String(bad));
  }
  assert.equal(secondsToMsOrNull(9_007_199_254_740), 9_007_199_254_740_000);
});

test("initial-send eligibility: the copied valid observation passes, and only for the initial send of attempt 1", () => {
  const e = elig();
  assert.equal(e.ok, true, e.code);
  assert.deepEqual([e.purpose, e.opId, e.paymentIntentId, e.attempt, e.evidenceId], [ELIGIBILITY_PURPOSE, "op-cap-1", PI, 1, "ev-1"]);
  assert.ok(Object.isFrozen(e));
});

test("every bound PaymentIntent / Charge field individually missing, malformed or mismatched is refused", () => {
  const cases = [
    // [pi overrides, charge overrides, card overrides]
    [{ id: "pi_test_other" }], [{ object: "setup_intent" }], [{ object: undefined }], [{ livemode: true }], [{ livemode: undefined }],
    [{ capture_method: "automatic" }], [{ capture_method: undefined }], [{ status: "succeeded" }], [{ status: "processing" }], [{ status: "canceled" }],
    [{ amount: 89999 }], [{ amount: "90000" }], [{ amount: undefined }], [{ amount_received: 1 }], [{ amount_received: undefined }],
    [{ amount_capturable: 89999 }], [{ amount_capturable: undefined }], [{ currency: "mxn" }], [{ currency: undefined }],
    [{ metadata: { mv_intent_id: "int-2", mv_payment_attempt_id: ATT } }], [{ metadata: { mv_intent_id: "int-1", mv_payment_attempt_id: "other" } }],
    [{ metadata: undefined }],
    [{}, { object: "refund" }], [{}, { object: undefined }], [{}, { id: null }], [{}, { id: "x_1" }], [{}, { id: "" }], [{}, { payment_intent: "pi_test_other" }],
    [{}, { payment_intent: null }], [{}, { status: "pending" }], [{}, { status: undefined }], [{}, { paid: false }], [{}, { paid: "true" }], [{}, { paid: undefined }],
    [{}, { captured: true }], [{}, { captured: undefined }], [{}, { captured: "false" }], [{}, { amount: 89999 }], [{}, { amount: undefined }],
    [{}, { amount_captured: 1 }], [{}, { amount_captured: undefined }], [{}, { amount_refunded: 1 }], [{}, { amount_refunded: undefined }],
    [{}, { currency: "mxn" }], [{}, { currency: undefined }], [{}, { livemode: true }], [{}, { livemode: undefined }],
    [{}, {}, { capture_before: CAPTURE_BEFORE / 1000 + 1 }], [{}, {}, { capture_before: undefined }], [{}, {}, { capture_before: "x" }],
    [{}, {}, { capture_before: 2 ** 53 }], [{}, { payment_method_details: undefined }],
    [{ latest_charge: "ch_1" }], [{ latest_charge: null }], [{ latest_charge: undefined }]
  ];
  for (const [o, c, k] of cases) {
    const r = initialCaptureSendEligibility({ evidence: evOf(v3(o, c, k)), intent: confirmed(), paymentAttemptId: ATT, captureOp: OP(), captureHistory: [OP()] });
    assert.equal(r.ok, false, JSON.stringify([o, c, k]));
    assert.match(r.code, /^[A-Z_]+$/);
  }
});

test("account / request-selector / evidence / payment-attempt bindings", () => {
  const good = v3();
  const bad = [
    [{ evidence: evOf(paymentIntentProofObservationV3(rawPI(), { accountVerified: false })) }, "PAYMENT_INTENT_IDENTITY"],
    [{ evidence: evOf(good, { requestRef: "pi_test_other" }) }, "PAYMENT_INTENT_IDENTITY"],
    [{ evidence: evOf(good, { externalRef: "pi_test_other" }) }, "PAYMENT_INTENT_IDENTITY"],
    [{ evidence: evOf(good, { kind: "checkout_session" }) }, "PAYMENT_INTENT_IDENTITY"],
    [{ evidence: evOf(good, { status: "succeeded" }) }, "PAYMENT_INTENT_IDENTITY"],
    [{ paymentAttemptId: "other-attempt" }, "PAYMENT_INTENT_IDENTITY"],
    [{ paymentAttemptId: null }, "PAYMENT_INTENT_IDENTITY"],
    [{ evidence: null }, "EVIDENCE_ID_REQUIRED"]
  ];
  for (const [over, code] of bad) assert.equal(elig(over).code, code, JSON.stringify(Object.keys(over)));
  // the stored capture deadline, not a recomputed one, is the reference
  const i = confirmed();
  const shifted = { ...i, payment: { ...i.payment, captureBefore: i.payment.captureBefore - 1000 } };
  assert.equal(elig({ intent: shifted }).code, "CAPTURE_BEFORE_MISMATCH");
  // the authorized amount on the intent must equal the price
  assert.equal(elig({ intent: { ...i, payment: { ...i.payment, amountMinor: 1 } } }).code, "AUTHORIZED_AMOUNT_NOT_PRICE");
});

test("v2-only evidence is refused for a new initial-send proof; accepted v2 captured / gone / still-authorized proofs are unchanged", () => {
  const two = paymentIntentProofObservation(rawPI(), { accountVerified: true });
  assert.equal(elig({ evidence: evOf(two) }).code, "V3_OBSERVATION_REQUIRED");
  assert.equal(elig({ evidence: evOf({ ...v3(), proofVersion: "pi-proof-v2" }) }).code, "V3_OBSERVATION_REQUIRED");
  const i = confirmed();
  // accepted v2 still-authorized proof keeps its accepted behaviour on v2 evidence
  assert.equal(piStillAuthorizedProof(evOf(two), i, ATT), true);
  const capturedRaw = rawPI({ status: "succeeded", amount_received: 90000, amount_capturable: 0 }, { captured: true, amount_captured: 90000 });
  assert.equal(piCapturedProof(evOf(paymentIntentProofObservation(capturedRaw, { accountVerified: true })), i, ATT), true);
  assert.equal(piCapturedProof(evOf(paymentIntentProofObservationV3(capturedRaw, { accountVerified: true })), i, ATT), true, "v3 is a superset for v2 proofs");
  const goneRaw = rawPI({ status: "canceled", amount_capturable: 0 });
  assert.equal(piGoneProof(evOf(paymentIntentProofObservation(goneRaw, { accountVerified: true })), i, ATT), true);
  // a captured or canceled PI is never initial-send eligible
  assert.equal(elig({ evidence: evOf(paymentIntentProofObservationV3(capturedRaw, { accountVerified: true })) }).ok, false);
  assert.equal(elig({ evidence: evOf(paymentIntentProofObservationV3(goneRaw, { accountVerified: true })) }).ok, false);
  assert.equal(stillAuthorizedV3Refusal(evOf(v3()), i, ATT), null);
});

test("eligibility can NEVER serve as permission to retry an uncertain capture (explicit data gate)", () => {
  const i = confirmed();
  // any other capture row for the intent (an earlier uncertain / settled attempt) blocks eligibility
  for (const st of ["outcome_unknown", "escalated", "in_flight", "failed_definite", "succeeded", "superseded"]) {
    const earlier = { ...OP(), id: "op-cap-0", state: st };
    assert.equal(elig({ captureHistory: [earlier, OP()] }).code, "NOT_INITIAL_SEND_CAPTURE_HISTORY", st);
  }
  // attempt 2 (what E3 emits after RECONCILED_STILL_AUTHORIZED) is never eligible, even with a perfect v3 observation
  const i2 = { ...i, counters: { ...i.counters, captureAttempts: 2 } };
  const op2 = { ...OP(), id: "op-cap-2", payload: { ...OP().payload, attempt: 2, providerIdempotencyKey: captureKey("int-1", PI, 2) } };
  assert.equal(initialCaptureSendEligibility({ evidence: evOf(v3()), intent: i2, paymentAttemptId: ATT, captureOp: op2, captureHistory: [op2] }).code, "NOT_INITIAL_ATTEMPT");
  // the row itself must never have been claimed or sent
  assert.equal(elig({ captureOp: { ...OP(), state: "in_flight" }, captureHistory: [{ ...OP(), state: "in_flight" }] }).code, "OPERATION_ALREADY_CLAIMED_OR_SENT");
  assert.equal(elig({ captureOp: { ...OP(), dispatchedAt: at(9) } }).code, "OPERATION_ALREADY_CLAIMED_OR_SENT");
  assert.equal(elig({ captureOp: { ...OP(), state: "outcome_unknown" } }).code, "OPERATION_ALREADY_CLAIMED_OR_SENT");
  // missing history is refused (never assumed empty)
  assert.equal(elig({ captureHistory: undefined }).code, "CAPTURE_HISTORY_REQUIRED");
  // only reservation_confirmed
  for (const st of ["capture_unknown", "capture_failed", "payment_captured", "reconciliation_required"]) {
    assert.equal(elig({ intent: { ...i, status: st } }).code, "NOT_RESERVATION_CONFIRMED", st);
  }
  // a forged eligibility object (same fields, not minted here) cannot build a request
  const e = elig();
  assert.equal(buildCaptureRequest({ intent: i, captureOp: OP(), eligibility: { ...e }, paymentAttemptId: ATT }).code, "ELIGIBILITY_REQUIRED");
  assert.equal(elig({ evidence: { ...evOf(v3()), id: undefined } }).code, "EVIDENCE_ID_REQUIRED", "no evidence id -> never reported as persisted evidence");
  assert.equal(elig({ evidence: { ...evOf(v3()), id: "" } }).code, "EVIDENCE_ID_REQUIRED");
});

test("capture request: exact full amount, final_capture true, expand latest_charge, the row's own key; nothing else", () => {
  const i = confirmed();
  const e = elig();
  const pending = OP();
  const r = buildCaptureRequest({ intent: i, captureOp: pending, eligibility: e, paymentAttemptId: ATT });
  assert.equal(r.ok, true, r.code);
  assert.deepEqual(JSON.parse(JSON.stringify(r.request)), { paymentIntentId: PI, params: { amount_to_capture: 90000, final_capture: true, expand: ["latest_charge"] },
    options: { idempotencyKey: `cap:int-1:${PI}` } });
  assert.ok(Object.isFrozen(r.request) && Object.isFrozen(r.request.params) && Object.isFrozen(r.request.params.expand));
  assert.equal(validateCaptureRequest(r.request, { intent: i, captureOp: pending }).ok, true);
  // caller parameters are not accepted at all
  assert.equal(buildCaptureRequest({ intent: i, captureOp: pending, eligibility: e, paymentAttemptId: ATT, params: { amount_to_capture: 1 } }).code, "UNEXPECTED_INPUT");
  assert.equal(buildCaptureRequest({ intent: i, captureOp: pending, eligibility: e }).code, "UNEXPECTED_INPUT");
  assert.equal(buildCaptureRequest({ intent: i, captureOp: pending }).code, "UNEXPECTED_INPUT");
  assert.equal(buildCaptureRequest().code, "UNEXPECTED_INPUT");
});

test("capture request builder refuses stale / wrong attempt / PI / key / amount / other operation", () => {
  const i = confirmed();
  const e = elig();
  const op = OP();
  const b = (over) => buildCaptureRequest({ intent: i, captureOp: op, eligibility: e, paymentAttemptId: ATT, ...over });
  assert.equal(b({ intent: { ...i, version: i.version + 1 } }).code, "ELIGIBILITY_STALE");
  assert.equal(b({ intent: { ...i, id: "int-2" } }).code, "OPERATION_IDEMPOTENCY_KEY", "the row's key binds the intent id (checked first)");
  assert.equal(b({ captureOp: { ...op, id: "op-cap-x" } }).code, "ELIGIBILITY_NOT_FOR_THIS_OPERATION");
  assert.equal(b({ captureOp: { ...op, opType: "stripe.void_payment_intent" } }).code, "NOT_A_CAPTURE_OPERATION");
  assert.equal(b({ captureOp: { ...op, payload: { ...op.payload, paymentIntentId: "pi_test_other" } } }).code, "OPERATION_PAYMENT_INTENT");
  assert.equal(b({ captureOp: { ...op, payload: { ...op.payload, attempt: 2 } } }).code, "OPERATION_NOT_CURRENT_ATTEMPT");
  assert.equal(b({ captureOp: { ...op, payload: { ...op.payload, amountMinor: 1 } } }).code, "OPERATION_AMOUNT");
  assert.equal(b({ captureOp: { ...op, payload: { ...op.payload, providerIdempotencyKey: "cap:other" } } }).code, "OPERATION_IDEMPOTENCY_KEY");
  assert.equal(b({ captureOp: { ...op, payload: { ...op.payload, extra: 1 } } }).code, "OPERATION_PAYLOAD_SHAPE");
  assert.equal(b({ captureOp: { ...op, payload: undefined } }).code, "OPERATION_PAYLOAD_SHAPE");
  assert.equal(b({ intent: { ...i, price: { ...i.price, finalTotalMinor: 1 } } }).code, "OPERATION_AMOUNT");
  assert.equal(b({ paymentAttemptId: "other-attempt" }).code, "ELIGIBILITY_SNAPSHOT_CHANGED");
});

test("validateCaptureRequest refuses partial / multicapture / extra parameters / wrong key or PI", () => {
  const i = confirmed();
  const op = OP();
  const good = buildCaptureRequest({ intent: i, captureOp: op, eligibility: elig(), paymentAttemptId: ATT }).request;
  const plain = JSON.parse(JSON.stringify(good));
  const v = (req) => validateCaptureRequest(req, { intent: i, captureOp: op }).code;
  assert.equal(v({ ...plain, params: { ...plain.params, amount_to_capture: 89999 } }), "PARTIAL_OR_WRONG_AMOUNT");
  assert.equal(v({ ...plain, params: { ...plain.params, amount_to_capture: 90000.5 } }), "PARTIAL_OR_WRONG_AMOUNT");
  assert.equal(v({ ...plain, params: { ...plain.params, final_capture: false } }), "MULTICAPTURE_REFUSED");
  assert.equal(v({ ...plain, params: { ...plain.params, final_capture: "true" } }), "MULTICAPTURE_REFUSED");
  assert.equal(v({ ...plain, params: { ...plain.params, metadata: { x: 1 } } }), "PARAMS_SHAPE");
  assert.equal(v({ ...plain, params: { ...plain.params, application_fee_amount: 1 } }), "PARAMS_SHAPE");
  assert.equal(v({ ...plain, params: { amount_to_capture: 90000, final_capture: true } }), "PARAMS_SHAPE");
  assert.equal(v({ ...plain, params: { ...plain.params, expand: [] } }), "EXPAND_REQUIRED");
  assert.equal(v({ ...plain, params: { ...plain.params, expand: ["latest_charge", "customer"] } }), "EXPAND_REQUIRED");
  assert.equal(v({ ...plain, options: { idempotencyKey: "cap:other" } }), "IDEMPOTENCY_KEY");
  assert.equal(v({ ...plain, options: { idempotencyKey: plain.options.idempotencyKey, stripeAccount: "acct_x" } }), "OPTIONS_SHAPE");
  assert.equal(v({ ...plain, paymentIntentId: "pi_test_other" }), "REQUEST_PAYMENT_INTENT");
  assert.equal(v({ ...plain, extra: 1 }), "REQUEST_SHAPE");
  assert.equal(v(null), "REQUEST_SHAPE");
  assert.equal(validateCaptureRequest(plain, { intent: i, captureOp: op }).ok, true);
});

test("purity / containment: no I/O, env, clock, network or SDK in the module", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../lib/checkout/capture-proof.js", import.meta.url), "utf8").replace(/\/\/.*$/gm, "");
  for (const re of [/process\./, /fetch\s*\(/, /Date\.now|new Date\(/, /setTimeout|setInterval/, /require\s*\(/, /from\s+"(?!\.\/(recovery-plan|intent-state)\.js")/, /import\s*\(/, /["']stripe["']/, /booking-db/]) {
    assert.doesNotMatch(src, re, String(re));
  }
});

test("root: a cached eligibility cannot build a request once the row or intent changed (mint first, then mutate)", () => {
  const i = confirmed();
  const e = elig();
  assert.equal(e.ok, true);
  const b = (intent, captureOp, pa = ATT) => buildCaptureRequest({ intent, captureOp, eligibility: e, paymentAttemptId: pa }).code;
  // root's reproduction: the op became outcome_unknown (dispatched) BEFORE the unknown event bumped the intent version
  assert.equal(i.version, e.intentVersion);
  assert.equal(b(i, { ...OP(), state: "outcome_unknown", dispatchedAt: at(8) }), "OPERATION_ALREADY_CLAIMED_OR_SENT");
  // claimed / in flight / dispatched / settled / superseded rows
  for (const [st, d] of [["in_flight", at(8)], ["in_flight", null], ["pending", at(8)], ["succeeded", at(8)], ["failed_definite", at(8)], ["escalated", at(8)], ["superseded", null]]) {
    assert.equal(b(i, { ...OP(), state: st, dispatchedAt: d }), "OPERATION_ALREADY_CLAIMED_OR_SENT", `${st}/${d}`);
  }
  // the intent left reservation_confirmed (terminal / uncertain / later), even with an unchanged version number
  for (const st of ["capture_unknown", "capture_failed", "payment_captured", "confirmed", "reconciliation_required", "cancelled"]) {
    assert.equal(b({ ...i, status: st }, OP()), "NOT_RESERVATION_CONFIRMED", st);
  }
  assert.equal(b({ ...i, counters: { ...i.counters, captureAttempts: 2 } }, OP()), "NOT_INITIAL_ATTEMPT");
  // same version, changed money / key / binding values: refused (by the row checks or the snapshot)
  const sameV = (patch) => ({ ...i, ...patch });
  assert.equal(b(sameV({ price: { ...i.price, finalTotalMinor: 80000 } }), { ...OP(), payload: { ...OP().payload, amountMinor: 80000 } }), "ELIGIBILITY_SNAPSHOT_CHANGED");
  assert.equal(b(sameV({ price: { ...i.price, currency: "MXN" } }), OP()), "ELIGIBILITY_SNAPSHOT_CHANGED");
  assert.equal(b(sameV({ payment: { ...i.payment, amountMinor: 80000 } }), OP()), "ELIGIBILITY_SNAPSHOT_CHANGED");
  assert.equal(b(sameV({ payment: { ...i.payment, currency: "MXN" } }), OP()), "ELIGIBILITY_SNAPSHOT_CHANGED");
  assert.equal(b(sameV({ payment: { ...i.payment, captureBefore: i.payment.captureBefore + 1000 } }), OP()), "ELIGIBILITY_SNAPSHOT_CHANGED");
  assert.equal(b(sameV({ payment: { ...i.payment, authorizationDeadline: i.payment.authorizationDeadline + 1000 } }), OP()), "ELIGIBILITY_SNAPSHOT_CHANGED");
  assert.equal(b(i, OP(), "other-attempt"), "ELIGIBILITY_SNAPSHOT_CHANGED");
  assert.equal(buildCaptureRequest({ intent: i, captureOp: OP(), eligibility: e, paymentAttemptId: undefined }).code, "ELIGIBILITY_SNAPSHOT_CHANGED");
  // a different PaymentIntent on BOTH the intent and the row (consistent with each other) is still refused
  const otherPi = "pi_test_other";
  assert.equal(b(sameV({ payment: { ...i.payment, paymentIntentId: otherPi } }),
    { ...OP(), payload: { ...OP().payload, paymentIntentId: otherPi, providerIdempotencyKey: captureKey("int-1", otherPi, 1) } }), "ELIGIBILITY_NOT_FOR_THIS_OPERATION");
  // the unchanged inputs still build (the eligibility itself is fine)
  assert.equal(buildCaptureRequest({ intent: i, captureOp: OP(), eligibility: e, paymentAttemptId: ATT }).ok, true);
  // the snapshot is frozen and part of the frozen eligibility
  assert.ok(Object.isFrozen(e.snapshot));
  assert.throws(() => { e.snapshot.priceMinor = 1; });
});
