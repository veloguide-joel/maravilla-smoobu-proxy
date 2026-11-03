// lib/checkout/capture-proof.js — Stage E7.3a (offline). PURE capture-proof foundation for a later capture worker.
//
// No I/O, no database, no network, no SDK, no environment, no clock. Not imported by any route or executor.
//
// Contents
//   paymentIntentProofObservationV3(pi, { accountVerified })   explicit v3 observation = accepted v2 observation + the two
//                                                                fields v2 lacks: latestCharge.paid, latestCharge.captureBefore
//   initialCaptureSendEligibility({ evidence, intent, paymentAttemptId, captureOp, captureHistory })
//                                                                strict still-authorized proof for the INITIAL planned send of
//                                                                capture attempt 1 ONLY (never a retry of an uncertain capture)
//   buildCaptureRequest({ intent, captureOp, eligibility, paymentAttemptId })
//                                                                PRE-CLAIM construction of the exact Stripe capture request (full
//                                                                amount, final_capture, expand latest_charge, per-row idempotency
//                                                                key); re-checks the CURRENT state and the eligibility snapshot
//   validateCaptureRequest(request, { intent, captureOp })       SHAPE / IDENTITY validator only — NOT send authorization
//
// What this pure module can NOT prove (worker responsibilities, see contract §11): that the evidence row is persisted and
// fresh (no trusted timestamp or database proof is available here), that the payment attempt id is the one the database
// binds to this PaymentIntent, and that the row is still claimable / leased / inside the deadline at the moment of the send.
// The worker's DB claim, lease, evidence and deadline fences stay mandatory; nothing here replaces them.
//
// Retry restriction (root, from official Stripe docs; see claude/e7-capture-worker-contract.md §11): a still-authorized
// snapshot after an uncertain capture send does NOT establish that the original request stopped executing, and a fresh
// idempotency key does not deduplicate the original. Therefore nothing here can authorize a capture after an uncertain
// one: eligibility is issued only for attempt 1 with NO other capture row for the intent, and a request can be built only
// from an eligibility object minted here (module-private brand) for that exact operation.
//
// The accepted v2 observation and proofs (lib/checkout/recovery-plan.js) are reused unchanged.
import { paymentIntentProofObservation, piIdentityOk } from "./recovery-plan.js";
import { captureKey, STATES as S } from "./intent-state.js";

export const CAPTURE_PROOF_VERSION = "pi-proof-v3";
export const CAPTURE_OP_TYPE = "stripe.capture_payment_intent";
export const ELIGIBILITY_PURPOSE = "INITIAL_SEND_ONLY";
const CHARGE_ID_RE = /^(ch|py)_[A-Za-z0-9_]{1,200}$/;
const PI_ID_RE = /^pi_[A-Za-z0-9_]{1,200}$/;
const OP_PAYLOAD_KEYS = Object.freeze(["paymentIntentId", "amountMinor", "attempt", "providerIdempotencyKey"].sort());

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isPosInt = (v) => Number.isSafeInteger(v) && v > 0;

/** Stripe epoch seconds -> epoch ms, only for a positive safe integer whose ms value is also safe; else null. */
export function secondsToMsOrNull(sec) {
  if (!Number.isSafeInteger(sec) || sec <= 0) return null;
  const ms = sec * 1000;
  return Number.isSafeInteger(ms) ? ms : null;
}

/**
 * v3 observation: the accepted v2 observation (unchanged values) plus latestCharge.paid (strict boolean copy) and
 * latestCharge.captureBefore (payment_method_details.card.capture_before, seconds -> ms, safe integers only).
 * An unexpanded charge (a string id) or a missing charge keeps v2's shape with the two new fields null.
 */
export function paymentIntentProofObservationV3(pi, { accountVerified } = {}) {
  const v2 = paymentIntentProofObservation(pi, { accountVerified });
  const ch = isObj(pi) && isObj(pi.latest_charge) ? pi.latest_charge : null;
  const card = ch && isObj(ch.payment_method_details) && isObj(ch.payment_method_details.card) ? ch.payment_method_details.card : null;
  return {
    ...v2,
    proofVersion: CAPTURE_PROOF_VERSION,
    latestCharge: v2.latestCharge === null ? null : {
      ...v2.latestCharge,
      paid: ch && typeof ch.paid === "boolean" ? ch.paid : null,
      captureBefore: card ? secondsToMsOrNull(card.capture_before) : null
    }
  };
}

// ---------------------------------------------------------------------------------------------
// initial-send eligibility (strict still-authorized proof + an explicit "initial send only" data gate)

const ISSUED = new WeakSet();       // module-private brand: only objects returned here can feed buildCaptureRequest
const refuse = (code) => Object.freeze({ ok: false, code });

/**
 * Strict still-authorized proof on a v3 observation (evidence row shape as used by the E7.1 planner:
 * { kind, requestRef, externalRef, status, observed }). Returns null when every bound field holds, else a refusal code.
 */
export function stillAuthorizedV3Refusal(ev, intent, paymentAttemptId) {
  const o = ev && ev.observed;
  if (!isObj(o) || o.proofVersion !== CAPTURE_PROOF_VERSION) return "V3_OBSERVATION_REQUIRED";
  if (!intent || !isObj(intent.price) || !isObj(intent.payment)) return "INTENT_NOT_AUTHORIZED";
  if (!PI_ID_RE.test(String(intent.payment.paymentIntentId || ""))) return "INTENT_PAYMENT_INTENT_INVALID";
  // identity: accepted v2 predicate (account verified, PI object/id, request selector + externalRef, livemode false,
  // metadata intent + payment attempt, manual capture, amount = price, exact currency, status echoed)
  if (!piIdentityOk(ev, intent, paymentAttemptId)) return "PAYMENT_INTENT_IDENTITY";
  const total = intent.price.finalTotalMinor; const cur = intent.price.currency;
  if (!isPosInt(total)) return "PRICE_INVALID";
  if (intent.payment.amountMinor !== total || String(intent.payment.currency || "").toUpperCase() !== cur) return "AUTHORIZED_AMOUNT_NOT_PRICE";
  if (o.status !== "requires_capture") return "NOT_REQUIRES_CAPTURE";
  if (o.amountReceivedMinor !== 0) return "AMOUNT_RECEIVED_NOT_ZERO";
  if (o.amountCapturableMinor !== total) return "AMOUNT_CAPTURABLE_NOT_FULL";
  const c = o.latestCharge;
  if (!isObj(c)) return "CHARGE_NOT_EXPANDED";
  if (c.object !== "charge" || typeof c.id !== "string" || !CHARGE_ID_RE.test(c.id)) return "CHARGE_NOT_EXPANDED";
  if (c.paymentIntent !== intent.payment.paymentIntentId) return "CHARGE_NOT_BOUND";
  if (c.livemode !== false) return "CHARGE_NOT_TEST_MODE";
  if (c.status !== "succeeded") return "CHARGE_STATUS";
  if (c.paid !== true) return "CHARGE_NOT_PAID";
  if (c.captured !== false) return "CHARGE_ALREADY_CAPTURED";
  if (c.amountMinor !== total) return "CHARGE_AMOUNT";
  if (c.amountCapturedMinor !== 0) return "CHARGE_AMOUNT_CAPTURED";
  if (c.amountRefundedMinor !== 0) return "CHARGE_REFUNDED";
  if (c.currency !== cur) return "CHARGE_CURRENCY";
  if (!Number.isSafeInteger(c.captureBefore) || c.captureBefore !== intent.payment.captureBefore) return "CAPTURE_BEFORE_MISMATCH";
  return null;
}

/** The operation row must be exactly the E3-emitted capture row of the intent's CURRENT (first) attempt. */
function captureOpRefusal(op, intent) {
  if (!isObj(op) || op.opType !== CAPTURE_OP_TYPE) return "NOT_A_CAPTURE_OPERATION";
  if (typeof op.id !== "string" || op.id === "") return "OPERATION_ID_INVALID";
  const p = op.payload;
  if (!isObj(p) || JSON.stringify(Object.keys(p).sort()) !== JSON.stringify(OP_PAYLOAD_KEYS)) return "OPERATION_PAYLOAD_SHAPE";
  if (p.paymentIntentId !== intent.payment.paymentIntentId) return "OPERATION_PAYMENT_INTENT";
  if (p.attempt !== intent.counters.captureAttempts) return "OPERATION_NOT_CURRENT_ATTEMPT";
  if (p.amountMinor !== intent.price.finalTotalMinor) return "OPERATION_AMOUNT";
  if (p.providerIdempotencyKey !== captureKey(intent.id, p.paymentIntentId, p.attempt)) return "OPERATION_IDEMPOTENCY_KEY";
  return null;
}

/** The proof-relevant values an eligibility is bound to (recomputed by the builder from its CURRENT inputs). */
function proofSnapshot(intent, captureOp, paymentAttemptId) {
  return Object.freeze({
    intentId: intent.id, intentVersion: intent.version, status: intent.status, captureAttempts: intent.counters.captureAttempts,
    opId: captureOp.id, opState: captureOp.state, dispatchedAt: captureOp.dispatchedAt ?? null,
    paymentIntentId: captureOp.payload.paymentIntentId, attempt: captureOp.payload.attempt, opAmountMinor: captureOp.payload.amountMinor,
    idempotencyKey: captureOp.payload.providerIdempotencyKey,
    priceMinor: intent.price.finalTotalMinor, currency: intent.price.currency, authorizedMinor: intent.payment.amountMinor,
    authorizedCurrency: String(intent.payment.currency || "").toUpperCase(), intentPaymentIntentId: intent.payment.paymentIntentId,
    captureBefore: intent.payment.captureBefore, authorizationDeadline: intent.payment.authorizationDeadline, paymentAttemptId
  });
}
const sameSnapshot = (a, b) => Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((k) => Object.is(a[k], b[k]));

/** Pre-claim state gate shared by eligibility and the builder: current state, first attempt, row pending and never sent. */
function preClaimRefusal(intent, captureOp) {
  if (!intent || intent.status !== S.RESERVATION_CONFIRMED) return "NOT_RESERVATION_CONFIRMED";
  if (!isObj(intent.counters) || intent.counters.captureAttempts !== 1) return "NOT_INITIAL_ATTEMPT";
  if (!isObj(intent.payment) || !isObj(intent.price)) return "INTENT_NOT_AUTHORIZED";
  const opRef = captureOpRefusal(captureOp, intent);
  if (opRef) return opRef;
  if (captureOp.state !== "pending" || captureOp.dispatchedAt != null) return "OPERATION_ALREADY_CLAIMED_OR_SENT";
  return null;
}

/**
 * initialCaptureSendEligibility({ evidence, intent, paymentAttemptId, captureOp, captureHistory })
 *   evidence        the fresh PI read evidence row (v3 observation)
 *   intent          E3 intent as persisted now
 *   paymentAttemptId the completed payment attempt bound to the PaymentIntent
 *   captureOp       { id, opType, state, dispatchedAt, payload } — the row to be sent (pending, never dispatched)
 *   captureHistory  EVERY capture row of this intent (any state), including captureOp
 * -> frozen { ok:true, purpose:"INITIAL_SEND_ONLY", opId, paymentIntentId, attempt:1, evidenceId, snapshot } | { ok:false, code }
 * evidenceId must be a non-empty string: it NAMES the evidence row the caller says it read; this module cannot prove the
 * row is persisted or fresh (the worker must). A missing id is refused rather than reported as null.
 *
 * EXPLICIT DATA GATE: eligibility exists only for the FIRST capture attempt with no other capture row at all. It is not,
 * and cannot be turned into, permission to retry after an uncertain capture (that needs separately reviewed definitive
 * evidence that the original request is no longer executing; see contract §11).
 */
export function initialCaptureSendEligibility({ evidence, intent, paymentAttemptId, captureOp, captureHistory } = {}) {
  if (!Array.isArray(captureHistory)) return refuse("CAPTURE_HISTORY_REQUIRED");
  const pre = preClaimRefusal(intent, captureOp);
  if (pre) return refuse(pre);
  if (captureHistory.length !== 1 || !isObj(captureHistory[0]) || captureHistory[0].id !== captureOp.id) return refuse("NOT_INITIAL_SEND_CAPTURE_HISTORY");
  if (!isObj(evidence) || typeof evidence.id !== "string" || evidence.id === "") return refuse("EVIDENCE_ID_REQUIRED");
  const proof = stillAuthorizedV3Refusal(evidence, intent, paymentAttemptId);
  if (proof) return refuse(proof);
  const e = Object.freeze({ ok: true, purpose: ELIGIBILITY_PURPOSE, opId: captureOp.id, paymentIntentId: intent.payment.paymentIntentId, attempt: 1,
    evidenceId: evidence.id, intentId: intent.id, intentVersion: intent.version, snapshot: proofSnapshot(intent, captureOp, paymentAttemptId) });
  ISSUED.add(e);
  return e;
}

// ---------------------------------------------------------------------------------------------
// capture request (exact; no caller parameters)

const REQUEST_KEYS = Object.freeze(["paymentIntentId", "params", "options"].sort());
const PARAM_KEYS = Object.freeze(["amount_to_capture", "expand", "final_capture"].sort());
const OPTION_KEYS = Object.freeze(["idempotencyKey"]);

/**
 * buildCaptureRequest({ intent, captureOp, eligibility, paymentAttemptId }) -> frozen { ok:true, request } | { ok:false, code }
 * PRE-CLAIM construction only: the CURRENT intent must still be reservation_confirmed at attempt 1 and the CURRENT row
 * pending and never dispatched, and every proof-relevant value (intent version/state, PI, op id/state/attempt/amount/key,
 * price, currency, authorized amount, capture deadline data, payment attempt) must equal the eligibility's snapshot.
 * A cached eligibility therefore cannot build a request for a row that became uncertain (even before an event bumped the
 * intent version), nor for changed money / key / binding values. It is not send authorization: the worker's fresh DB
 * claim, lease, evidence and deadline checks remain mandatory between this and any send.
 *   request = { paymentIntentId, params: { amount_to_capture, final_capture: true, expand: ["latest_charge"] },
 *               options: { idempotencyKey } }
 * Only the stored price, the operation's PaymentIntent / attempt / idempotency key and an eligibility minted by
 * initialCaptureSendEligibility() for this exact operation and intent version are used. Partial capture, multicapture
 * (final_capture false), metadata and any other caller parameter are impossible by construction (no such inputs).
 */
export function buildCaptureRequest(input = {}) {
  if (!isObj(input) || JSON.stringify(Object.keys(input).sort()) !== JSON.stringify(["captureOp", "eligibility", "intent", "paymentAttemptId"])) return refuse("UNEXPECTED_INPUT");
  const { intent, captureOp, eligibility, paymentAttemptId } = input;
  if (!ISSUED.has(eligibility) || eligibility.ok !== true || eligibility.purpose !== ELIGIBILITY_PURPOSE) return refuse("ELIGIBILITY_REQUIRED");
  const pre = preClaimRefusal(intent, captureOp);
  if (pre) return refuse(pre);
  if (eligibility.intentId !== intent.id || eligibility.intentVersion !== intent.version) return refuse("ELIGIBILITY_STALE");
  if (eligibility.opId !== captureOp.id || eligibility.paymentIntentId !== captureOp.payload.paymentIntentId || captureOp.payload.attempt !== 1) {
    return refuse("ELIGIBILITY_NOT_FOR_THIS_OPERATION");
  }
  if (!sameSnapshot(eligibility.snapshot, proofSnapshot(intent, captureOp, paymentAttemptId))) return refuse("ELIGIBILITY_SNAPSHOT_CHANGED");
  const request = Object.freeze({
    paymentIntentId: captureOp.payload.paymentIntentId,
    params: Object.freeze({ amount_to_capture: intent.price.finalTotalMinor, final_capture: true, expand: Object.freeze(["latest_charge"]) }),
    options: Object.freeze({ idempotencyKey: captureOp.payload.providerIdempotencyKey })
  });
  const v = validateCaptureRequest(request, { intent, captureOp });
  return v.ok ? Object.freeze({ ok: true, request }) : v;
}

/**
 * SHAPE / IDENTITY validator of a capture request object against the intent and its capture row (exact keys, PI, full
 * amount, final_capture, expand, the row's own key). It is NOT send authorization and does not check state, claim,
 * leases, evidence freshness or deadlines: the worker's DB fences remain mandatory.
 */
export function validateCaptureRequest(request, { intent, captureOp } = {}) {
  if (!isObj(request) || JSON.stringify(Object.keys(request).sort()) !== JSON.stringify(REQUEST_KEYS)) return refuse("REQUEST_SHAPE");
  if (!intent || !isObj(intent.price) || !isObj(intent.payment) || !isObj(intent.counters)) return refuse("INTENT_NOT_AUTHORIZED");
  const opRef = captureOpRefusal(captureOp, intent);
  if (opRef) return refuse(opRef);
  const { params, options } = request;
  if (!isObj(params) || JSON.stringify(Object.keys(params).sort()) !== JSON.stringify(PARAM_KEYS)) return refuse("PARAMS_SHAPE");
  if (!isObj(options) || JSON.stringify(Object.keys(options)) !== JSON.stringify(OPTION_KEYS)) return refuse("OPTIONS_SHAPE");
  if (request.paymentIntentId !== captureOp.payload.paymentIntentId || request.paymentIntentId !== intent.payment.paymentIntentId) return refuse("REQUEST_PAYMENT_INTENT");
  if (!isPosInt(params.amount_to_capture) || params.amount_to_capture !== intent.price.finalTotalMinor || params.amount_to_capture !== intent.payment.amountMinor) {
    return refuse("PARTIAL_OR_WRONG_AMOUNT");
  }
  if (params.final_capture !== true) return refuse("MULTICAPTURE_REFUSED");
  if (!Array.isArray(params.expand) || params.expand.length !== 1 || params.expand[0] !== "latest_charge") return refuse("EXPAND_REQUIRED");
  if (options.idempotencyKey !== captureOp.payload.providerIdempotencyKey) return refuse("IDEMPOTENCY_KEY");
  return Object.freeze({ ok: true });
}
