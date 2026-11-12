// lib/checkout/test-cleanup-proof.js — E7 captured-TEST cleanup (OFFLINE, PURE). Proof / request foundation for the TEST cleanup worker
// (lib/booking-db/cleanup-worker.js). Contract: claude/e7-capture-test-cleanup-contract.md rev4 (§4 proof, §5 uncertainty / discovery, §7).
// No DB, network, SDK, clock reads, environment or E3 change. Not imported by any route or by an existing worker.
//
// What this module decides: the SHAPE and the bindings of the facts it is given —
//   * a captured, NOT-yet-refunded TEST PaymentIntent proof (pre-send refusals, §4) on the accepted v3 observation + the RAW provider
//     object's refund / dispute aggregates (the v3 observation does not carry `refunded` / `disputed`);
//   * a captured AND fully refunded TEST PaymentIntent proof (post-send; mirrors booking.test_refund_pi_observation_ok, 0019);
//   * a bound Refund READ proof (the LATEST refund observation decides at the database; this module validates ONE row);
//   * read-only discovery over a Refund LIST reply (§5): has_more refused outright, exactly ONE candidate, metadata + charge / amount /
//     currency binding, conservative integer-second time filter; the discovered id still needs the exact GET;
//   * cleanup-cancel and refund eligibilities bound to frozen snapshots (module-private brands; pre-claim builders only) and exact requests.
// What it CANNOT prove (the worker's responsibilities under its DB fences): completeness / currency of the rows, evidence provenance
// (executed, account-verified reads persisted as immutable evidence), leases / claims / versions at send time, the absence of another actor.
// Validators check shape / identity only: they are NOT send authorization.
import { piIdentityOk, FRESH_AFTER_DISPATCH_MS } from "./recovery-plan.js";
import { CAPTURE_PROOF_VERSION } from "./capture-proof.js";
import { activeReservationProof, validateCancelRequest, isProtectedReservationId, PROOF_MAX_AGE_MS, CANCEL_BODY } from "./compensation-proof.js";
import { captureKey, refundKey, STATES as S } from "./intent-state.js";

export const TEST_CLEANUP_PROOF_VERSION = "test-cleanup-proof-v1";
export const OPS = Object.freeze({ CAPTURE: "stripe.capture_payment_intent", REFUND: "stripe.refund_payment_intent", CANCEL: "hostaway.cancel_reservation",
  PI_READ: "stripe.retrieve_payment_intent", REFUND_READ: "stripe.retrieve_refund", RES_READ: "hostaway.retrieve_reservation", LOOKUP: "hostaway.lookup_reservation" });
export const REFUND_STATUSES = Object.freeze(["pending", "requires_action", "succeeded", "failed", "canceled"]);
export const REFUND_METADATA_KEYS = Object.freeze({ op: "mv_refund_op", key: "mv_refund_key" });
export const CANCEL_PURPOSE = "TEST_CLEANUP_CANCEL_SEND_ONLY";
export const REFUND_PURPOSE = "TEST_CLEANUP_REFUND_SEND_ONLY";
/** §5 time binding: Stripe `created` is an integer SECOND; one full second of slack towards the past (the provider truncates). */
export const DISCOVERY_CREATED_SLACK_S = 1;
export { FRESH_AFTER_DISPATCH_MS, PROOF_MAX_AGE_MS };

const CHARGE_ID_RE = /^(ch|py)_[A-Za-z0-9_]{1,200}$/;
const PI_ID_RE = /^pi_[A-Za-z0-9_]{1,200}$/;
const REFUND_ID_RE = /^re_[A-Za-z0-9_]{1,200}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RID_RE = /^[1-9]\d{0,15}$/;
const REFUND_PAYLOAD_KEYS = JSON.stringify(["amountMinor", "attempt", "chargeId", "currency", "paymentIntentId", "providerIdempotencyKey"]);
const CANCEL_PAYLOAD_KEYS = JSON.stringify(["attempt", "cancelledBy", "reservationId"]);
const CAPTURE_PAYLOAD_KEYS = JSON.stringify(["amountMinor", "attempt", "paymentIntentId", "providerIdempotencyKey"]);

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isPosInt = (v) => Number.isSafeInteger(v) && v > 0;
const isTime = (v) => Number.isSafeInteger(v) && v > 0;
const keysOf = (o) => JSON.stringify(Object.keys(o).sort());
const refuse = (code) => Object.freeze({ ok: false, code });
const str = (v) => (typeof v === "string" ? v : null);
const int = (v) => (Number.isSafeInteger(v) ? v : null);
const upper = (v) => (typeof v === "string" ? v.toUpperCase() : null);
const ISSUED = new WeakSet();
const sameSnapshot = (a, b) => isObj(a) && isObj(b) && Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((k) => Object.is(a[k], b[k]));

// ---------------------------------------------------------------------------------------------
// observations (values COPIED from the provider object; nothing invented or defaulted)

/**
 * refundObservation(refund, { opId? }) — the persisted observation of a Stripe Refund read / discovery (ids, money, status, metadata; no
 * customer data). A missing or mistyped value stays null (the database then refuses the evidence: refundId / paymentIntentId / chargeId /
 * amountMinor / currency are mandatory there). `created` is copied as the provider's integer second.
 */
export function refundObservation(refund) {
  const r = isObj(refund) ? refund : {};
  const idOf = (v) => (typeof v === "string" ? v : isObj(v) && typeof v.id === "string" ? v.id : null);
  const md = isObj(r.metadata) ? r.metadata : {};
  return {
    proofVersion: TEST_CLEANUP_PROOF_VERSION,
    object: str(r.object),
    refundId: str(r.id),
    paymentIntentId: idOf(r.payment_intent),
    chargeId: idOf(r.charge),
    amountMinor: int(r.amount),
    currency: upper(r.currency),
    status: str(r.status),
    created: int(r.created),
    reason: str(r.reason),
    failureReason: str(r.failure_reason),
    metadataRefundOp: str(md[REFUND_METADATA_KEYS.op]),
    metadataRefundKey: str(md[REFUND_METADATA_KEYS.key])
  };
}
/** the Refund object has NO livemode field: TEST-ness comes from the instance / intent / attempt / PI evidence and the sk_test_ key scope */
export const refundObjectUsable = (o) => isObj(o) && o.object === "refund" && typeof o.id === "string" && REFUND_ID_RE.test(o.id) && typeof o.status === "string"
  && REFUND_STATUSES.includes(o.status);

// ---------------------------------------------------------------------------------------------
// freshness

function freshnessRefusal(observedAt, { now, notBefore }) {
  if (!isTime(now) || !isTime(notBefore)) return "FRESHNESS_INPUT_INVALID";
  if (!isTime(observedAt)) return "EVIDENCE_TIME_MISSING";
  if (observedAt > now) return "EVIDENCE_IN_FUTURE";
  if (now - observedAt > PROOF_MAX_AGE_MS) return "EVIDENCE_STALE";
  if (observedAt < notBefore) return "EVIDENCE_BEFORE_STATE";
  return null;
}
const piEvidenceShape = (ev) => isObj(ev) && typeof ev.id === "string" && ev.id !== "" && ev.kind === "payment_intent" && ev.readOpType === OPS.PI_READ && isObj(ev.observed);

function intentBaseRefusal(intent) {
  if (!isObj(intent) || typeof intent.id !== "string" || !UUID_RE.test(intent.id) || !Number.isSafeInteger(intent.version)) return "INTENT_INVALID";
  if (!isObj(intent.price) || !isObj(intent.payment) || !isObj(intent.counters) || !isObj(intent.settlement)) return "INTENT_INVALID";
  const p = intent.payment;
  if (!isPosInt(intent.price.finalTotalMinor) || typeof intent.price.currency !== "string") return "PRICE_INVALID";
  if (typeof p.paymentIntentId !== "string" || !PI_ID_RE.test(p.paymentIntentId)) return "INTENT_PAYMENT_INTENT_INVALID";
  if (p.livemode !== false) return "INTENT_NOT_TEST_MODE";
  if (!isPosInt(p.capturedMinor) || p.capturedMinor !== intent.price.finalTotalMinor) return "CAPTURED_AMOUNT_NOT_PRICE";
  if (p.amountMinor !== intent.price.finalTotalMinor || String(p.currency || "").toUpperCase() !== intent.price.currency) return "AUTHORIZED_AMOUNT_NOT_PRICE";
  if (intent.status !== S.TEST_CLEANUP_PENDING) return "NOT_TEST_CLEANUP_PENDING";
  if (!isObj(intent.reservation) || !RID_RE.test(String(intent.reservation.reservationId))) return "NO_RESERVATION";
  if (isProtectedReservationId(intent.reservation.reservationId)) return "PROTECTED_RESERVATION_ID";
  return null;
}

// ---------------------------------------------------------------------------------------------
// the ONE capture row (history must be exactly this; anything else is an owner case)

/** captureRows: EVERY capture row of the intent as { id, opType, state, attempts, dispatchedAt, payload, resultRef }. -> { ok, chargeId, dispatchedAt } | refusal */
export function singleCaptureProof({ intent, captureRows } = {}) {
  const base = intentBaseRefusal(intent);
  if (base) return refuse(base);
  if (!Array.isArray(captureRows)) return refuse("CAPTURE_HISTORY_REQUIRED");
  if (captureRows.length !== 1 || intent.counters.captureAttempts !== 1) return refuse("CAPTURE_HISTORY_NOT_SINGLE");
  const r = captureRows[0];
  if (!isObj(r) || r.opType !== OPS.CAPTURE || typeof r.id !== "string" || r.id === "") return refuse("CAPTURE_ROW_INVALID");
  const p = r.payload;
  if (!isObj(p) || keysOf(p) !== CAPTURE_PAYLOAD_KEYS) return refuse("CAPTURE_ROW_PAYLOAD_SHAPE");
  const pi = intent.payment.paymentIntentId;
  if (p.paymentIntentId !== pi || p.attempt !== 1 || p.amountMinor !== intent.payment.capturedMinor || p.providerIdempotencyKey !== captureKey(intent.id, pi, 1)) return refuse("CAPTURE_ROW_BINDING");
  if (r.state !== "succeeded" || r.attempts !== 1 || !isTime(r.dispatchedAt)) return refuse("CAPTURE_ROW_NOT_SUCCEEDED");
  if (typeof r.resultRef !== "string" || !CHARGE_ID_RE.test(r.resultRef)) return refuse("CAPTURE_CHARGE_NOT_RECORDED");
  return Object.freeze({ ok: true, chargeId: r.resultRef, dispatchedAt: r.dispatchedAt, fingerprint: `${r.id}|${r.state}|${r.attempts}|${r.dispatchedAt}|${r.resultRef}` });
}

// ---------------------------------------------------------------------------------------------
// PaymentIntent proofs (v3 observation; charge binding by the capture row's charge id)

function capturedChargeRefusal(o, intent, chargeId) {
  const total = intent.payment.capturedMinor; const cur = intent.price.currency;
  if (o.status !== "succeeded") return "PI_NOT_SUCCEEDED";
  if (o.amountMinor !== total) return "PI_AMOUNT";
  if (o.amountReceivedMinor !== total) return "AMOUNT_RECEIVED_NOT_CAPTURED";
  if (o.amountCapturableMinor !== 0) return "AMOUNT_CAPTURABLE_NOT_ZERO";
  if (o.currency !== cur) return "PI_CURRENCY";
  const c = o.latestCharge;
  if (!isObj(c) || c.object !== "charge" || typeof c.id !== "string" || !CHARGE_ID_RE.test(c.id)) return "CHARGE_NOT_EXPANDED";
  if (c.id !== chargeId) return "CHARGE_ID_MISMATCH";
  if (c.paymentIntent !== intent.payment.paymentIntentId) return "CHARGE_NOT_BOUND";
  if (c.livemode !== false) return "CHARGE_NOT_TEST_MODE";
  if (c.status !== "succeeded") return "CHARGE_STATUS";
  if (c.paid !== true) return "CHARGE_NOT_PAID";
  if (c.captured !== true) return "CHARGE_NOT_CAPTURED";
  if (c.amountMinor !== total) return "CHARGE_AMOUNT";
  if (c.amountCapturedMinor !== total) return "CHARGE_AMOUNT_CAPTURED";
  if (c.currency !== cur) return "CHARGE_CURRENCY";
  return null;
}
/**
 * Captured and NOT refunded (pre-send, §4 pre-send refusals): v3 evidence of the bound PI showing the full capture on exactly the capture
 * row's charge, amount_refunded 0. -> null | refusal code. The RAW object's aggregates are checked separately (rawPiPreSendRefusal).
 */
export function piCapturedUnrefundedProofV3(ev, intent, paymentAttemptId, chargeId, { now, notBefore } = {}) {
  if (!piEvidenceShape(ev)) return "PI_EVIDENCE_SHAPE";
  const o = ev.observed;
  if (o.proofVersion !== CAPTURE_PROOF_VERSION) return "V3_OBSERVATION_REQUIRED";
  if (intentBaseRefusal(intent)) return "INTENT_INVALID";
  if (!piIdentityOk(ev, intent, paymentAttemptId)) return "PAYMENT_INTENT_IDENTITY";
  const c = capturedChargeRefusal(o, intent, chargeId);
  if (c) return c;
  if (o.latestCharge.amountRefundedMinor !== 0) return "CHARGE_ALREADY_REFUNDED";
  return freshnessRefusal(ev.observedAt, { now, notBefore });
}
/**
 * Captured AND fully refunded (post-send; the JS mirror of booking.test_refund_pi_observation_ok): same identity, charge amount_refunded =
 * captured, `refunded` not contradicting when present. -> null | refusal code. Aggregates are CONSISTENCY checks only, never identification.
 */
export function piCapturedFullyRefundedProofV3(ev, intent, paymentAttemptId, chargeId, { now, notBefore } = {}) {
  if (!piEvidenceShape(ev)) return "PI_EVIDENCE_SHAPE";
  const o = ev.observed;
  if (o.proofVersion !== CAPTURE_PROOF_VERSION) return "V3_OBSERVATION_REQUIRED";
  if (intentBaseRefusal(intent)) return "INTENT_INVALID";
  if (!piIdentityOk(ev, intent, paymentAttemptId)) return "PAYMENT_INTENT_IDENTITY";
  const c = capturedChargeRefusal(o, intent, chargeId);
  if (c) return c;
  if (o.latestCharge.amountRefundedMinor !== intent.payment.capturedMinor) return "CHARGE_NOT_FULLY_REFUNDED";
  if ("refunded" in o.latestCharge && o.latestCharge.refunded !== true) return "CHARGE_REFUNDED_FLAG";
  if (!isTime(now) || !isTime(notBefore)) return "FRESHNESS_INPUT_INVALID";
  if (!isTime(ev.observedAt) || ev.observedAt > now) return "EVIDENCE_TIME_INVALID";
  if (ev.observedAt < notBefore) return "EVIDENCE_BEFORE_DISPATCH";
  return null;
}
/**
 * RAW provider PaymentIntent object (latest_charge expanded) pre-send checks the v3 observation cannot express (§4 pre-send refusals):
 * no refund on the charge yet (refunds list empty when present, amount_refunded 0, refunded false), no dispute, TEST mode, expected id / charge.
 * -> null | refusal code. Missing booleans refuse (never assumed).
 */
export function rawPiPreSendRefusal(pi, { paymentIntentId, chargeId, amountMinor, currency } = {}) {
  if (!isObj(pi) || pi.object !== "payment_intent" || pi.id !== paymentIntentId) return "RAW_PI_IDENTITY";
  if (pi.livemode !== false) return "RAW_PI_NOT_TEST_MODE";
  if (pi.status !== "succeeded" || pi.amount_received !== amountMinor || pi.amount !== amountMinor) return "RAW_PI_NOT_CAPTURED_FULL";
  if (upper(pi.currency) !== currency) return "RAW_PI_CURRENCY";
  const c = pi.latest_charge;
  if (!isObj(c) || c.object !== "charge" || c.id !== chargeId) return "RAW_CHARGE_IDENTITY";
  if (c.livemode !== false) return "RAW_CHARGE_NOT_TEST_MODE";
  if (c.captured !== true || c.paid !== true || c.status !== "succeeded") return "RAW_CHARGE_NOT_CAPTURED";
  if (c.amount !== amountMinor || c.amount_captured !== amountMinor) return "RAW_CHARGE_AMOUNT";
  if (c.amount_refunded !== 0) return "RAW_CHARGE_AMOUNT_REFUNDED";
  if (c.refunded !== false) return "RAW_CHARGE_REFUNDED";
  if (c.disputed !== false) return "RAW_CHARGE_DISPUTED";
  if (c.dispute !== undefined && c.dispute !== null) return "RAW_CHARGE_DISPUTE_PRESENT";
  if (c.refunds !== undefined && c.refunds !== null) {
    const l = c.refunds;
    if (!isObj(l) || l.object !== "list" || !Array.isArray(l.data) || l.data.length !== 0 || l.has_more !== false) return "RAW_CHARGE_REFUNDS_PRESENT";
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Refund READ proof (one persisted stripe_refund evidence row, bound to the refund row)

const refundEvidenceShape = (ev) => isObj(ev) && typeof ev.id === "string" && ev.id !== "" && ev.kind === "stripe_refund" && ev.readOpType === OPS.REFUND_READ && isObj(ev.observed);
/**
 * refundReadProof(ev, { intent, chargeId, refundId, dispatchedAt, now }) -> null | refusal code
 *   the evidence must be the API read of exactly `refundId` (request selector = externalRef = observed.refundId), observed AFTER the refund
 *   dispatch and not in the future, with strictly typed exact identity / money fields and status `succeeded`.
 */
export function refundReadProof(ev, { intent, chargeId, refundId, dispatchedAt, now } = {}) {
  if (!refundEvidenceShape(ev)) return "REFUND_EVIDENCE_SHAPE";
  if (intentBaseRefusal(intent)) return "INTENT_INVALID";
  if (typeof refundId !== "string" || !REFUND_ID_RE.test(refundId)) return "REFUND_ID_INVALID";
  if (ev.requestRef !== refundId || ev.externalRef !== refundId) return "REFUND_EVIDENCE_NOT_BOUND";
  const o = ev.observed;
  if (o.refundId !== refundId) return "REFUND_ID_MISMATCH";
  if (o.paymentIntentId !== intent.payment.paymentIntentId) return "REFUND_PAYMENT_INTENT";
  if (o.chargeId !== chargeId) return "REFUND_CHARGE";
  if (o.amountMinor !== intent.payment.capturedMinor) return "REFUND_AMOUNT";
  if (o.currency !== intent.price.currency) return "REFUND_CURRENCY";
  if (ev.status !== "succeeded" || o.status !== "succeeded") return `REFUND_STATUS_${String(o.status ?? ev.status).toUpperCase().replace(/[^A-Z_]/g, "_")}`;
  if (!isTime(now) || !isTime(dispatchedAt)) return "FRESHNESS_INPUT_INVALID";
  if (!isTime(ev.observedAt) || ev.observedAt > now) return "EVIDENCE_TIME_INVALID";
  if (ev.observedAt < dispatchedAt) return "EVIDENCE_BEFORE_DISPATCH";
  return null;
}

// ---------------------------------------------------------------------------------------------
// discovery (§5): a Refund LIST reply for the PaymentIntent, read-only; identity from metadata + charge + amount + currency; `created` only EXCLUDES

/**
 * refundDiscovery({ list, intent, chargeId, opId, dispatchedAt, now })
 *   list: the RAW Stripe list reply of GET /v1/refunds?payment_intent={pi}&limit=100
 * -> { ok:true, refundId, status } when EXACTLY ONE refund exists for the PI and it is uniquely attributable to the pinned operation;
 *    { ok:false, code: REFUND_LIST_UNUSABLE | REFUND_LIST_TRUNCATED | REFUND_NOT_FOUND | REFUND_AMBIGUOUS } otherwise (every refusal = owner STOP,
 *    never a resend). A `pending` candidate is returned ok with its status: the caller keeps reading, bounded.
 */
export function refundDiscovery({ list, intent, chargeId, opId, dispatchedAt, now } = {}) {
  if (intentBaseRefusal(intent) || typeof chargeId !== "string" || !CHARGE_ID_RE.test(chargeId) || typeof opId !== "string" || !UUID_RE.test(opId)
      || !isTime(dispatchedAt) || !isTime(now)) return refuse("DISCOVERY_INPUT_INVALID");
  if (!isObj(list) || list.object !== "list" || !Array.isArray(list.data) || typeof list.has_more !== "boolean") return refuse("REFUND_LIST_UNUSABLE");
  if (list.has_more === true) return refuse("REFUND_LIST_TRUNCATED");          // discovery never pages
  if (list.data.length === 0) return refuse("REFUND_NOT_FOUND");
  if (list.data.length !== 1) return refuse("REFUND_AMBIGUOUS");
  const r = list.data[0];
  if (!refundObjectUsable(r)) return refuse("REFUND_LIST_UNUSABLE");
  const o = refundObservation(r);
  const key = refundKey(intent.id, 1);
  const lo = Math.floor(dispatchedAt / 1000) - DISCOVERY_CREATED_SLACK_S; const hi = Math.ceil(now / 1000);
  if (o.paymentIntentId !== intent.payment.paymentIntentId || o.chargeId !== chargeId || o.amountMinor !== intent.payment.capturedMinor
      || o.currency !== intent.price.currency || o.metadataRefundOp !== opId || o.metadataRefundKey !== key) return refuse("REFUND_AMBIGUOUS");
  if (o.created === null || o.created < lo || o.created > hi) return refuse("REFUND_AMBIGUOUS");   // the time filter can only EXCLUDE
  return Object.freeze({ ok: true, refundId: o.refundId, status: o.status });
}

// ---------------------------------------------------------------------------------------------
// snapshots

function intentFacts(intent) {
  const st = intent.settlement;
  return { intentId: intent.id, intentVersion: intent.version, status: intent.status, listingId: intent.listingId, from: intent.from, to: intent.to, ref: intent.ref,
    captureAttempts: intent.counters.captureAttempts, cancelAttempts: intent.counters.cancelAttempts, priceMinor: intent.price.finalTotalMinor, currency: intent.price.currency,
    paymentIntentId: intent.payment.paymentIntentId, capturedMinor: intent.payment.capturedMinor, livemode: intent.payment.livemode,
    reservationId: String(intent.reservation.reservationId), reservationCancelled: st.reservationCancelled, authorizationSettled: st.authorizationSettled, reasonCode: intent.reasonCode };
}
const opFacts = (op) => ({ opId: op.id, opType: op.opType, opState: op.state, opAttempts: op.attempts, opDispatchedAt: op.dispatchedAt, opPayload: JSON.stringify(op.payload) });

// ---------------------------------------------------------------------------------------------
// reservation leg: the ONE host-cancel (attempt 1) while test_cleanup_pending

function cancelOpRefusal(op, intent) {
  if (!isObj(op) || op.opType !== OPS.CANCEL || typeof op.id !== "string" || op.id === "") return "NOT_A_CANCEL_OPERATION";
  const p = op.payload;
  if (!isObj(p) || keysOf(p) !== CANCEL_PAYLOAD_KEYS) return "CANCEL_PAYLOAD_SHAPE";
  if (p.reservationId !== String(intent.reservation.reservationId)) return "CANCEL_RESERVATION";
  if (p.cancelledBy !== CANCEL_BODY.cancelledBy) return "CANCEL_NOT_HOST";
  if (p.attempt !== 1) return "CANCEL_NOT_INITIAL_ATTEMPT";
  return null;
}
function cancelPreClaimRefusal({ intent, cancelOp, captureRows }) {
  const base = intentBaseRefusal(intent);
  if (base) return { code: base };
  if (intent.settlement.reservationCancelled !== false) return { code: "RESERVATION_LEG_NOT_OPEN" };
  if (intent.counters.cancelAttempts !== 1) return { code: "CANCEL_ATTEMPTS_NOT_ONE" };
  const opRef = cancelOpRefusal(cancelOp, intent);
  if (opRef) return { code: opRef };
  if (cancelOp.state !== "pending" || cancelOp.attempts !== 0 || cancelOp.dispatchedAt !== null) return { code: "CANCEL_OPERATION_ALREADY_CLAIMED_OR_SENT" };
  const cap = singleCaptureProof({ intent, captureRows });
  if (!cap.ok) return { code: `CAPTURE_${cap.code}` };
  return { capture: cap };
}
const cancelSnapshot = (intent, cancelOp, cap, paymentAttemptId) => Object.freeze({ ...intentFacts(intent), ...opFacts(cancelOp), chargeId: cap.chargeId, captureFingerprint: cap.fingerprint, paymentAttemptId });

/**
 * cleanupCancelEligibility({ intent, paymentAttemptId, cancelOp, captureRows, byId, byRef?, piEvidence, now, notBefore })
 *   the reservation leg of a TEST cleanup: fresh fully identified ACTIVE reservation (by id; by ref when not echoed), fresh v3 proof that the
 *   bound PaymentIntent is captured on the capture row's charge and NOT refunded (money is settled by the refund leg, never by a cancel).
 * -> frozen branded eligibility | { ok:false, code }
 */
export function cleanupCancelEligibility({ intent, paymentAttemptId, cancelOp, captureRows, byId, byRef = null, piEvidence, now, notBefore } = {}) {
  if (typeof paymentAttemptId !== "string" || paymentAttemptId === "") return refuse("PAYMENT_ATTEMPT_REQUIRED");
  const pre = cancelPreClaimRefusal({ intent, cancelOp, captureRows });
  if (pre.code) return refuse(pre.code);
  const pi = piCapturedUnrefundedProofV3(piEvidence, intent, paymentAttemptId, pre.capture.chargeId, { now, notBefore });
  if (pi) return refuse(`PI_PROOF_${pi}`);
  const res = activeReservationProof({ intent, byId, byRef, now, notBefore });
  if (!res.ok) return res;
  const e = Object.freeze({ ok: true, purpose: CANCEL_PURPOSE, opId: cancelOp.id, reservationId: String(intent.reservation.reservationId),
    reservationEvidenceIds: res.evidenceIds, reservationObservedAts: res.observedAts, piEvidence: Object.freeze({ id: piEvidence.id, observedAt: piEvidence.observedAt }),
    notBefore, intentId: intent.id, intentVersion: intent.version, snapshot: cancelSnapshot(intent, cancelOp, pre.capture, paymentAttemptId) });
  ISSUED.add(e);
  return e;
}
/** PRE-CLAIM only: CURRENT inputs must equal the snapshot; carried evidence still fresh at `now`. -> { ok, request } | { ok:false, code } */
export function buildCleanupCancelRequest(input = {}) {
  if (!isObj(input) || keysOf(input) !== JSON.stringify(["cancelOp", "captureRows", "eligibility", "intent", "notBefore", "now", "paymentAttemptId"])) return refuse("UNEXPECTED_INPUT");
  const { intent, cancelOp, captureRows, eligibility, paymentAttemptId, now, notBefore } = input;
  if (!ISSUED.has(eligibility) || eligibility.ok !== true || eligibility.purpose !== CANCEL_PURPOSE) return refuse("ELIGIBILITY_REQUIRED");
  if (notBefore !== eligibility.notBefore) return refuse("STATE_ENTRY_CHANGED");
  for (const t of [...eligibility.reservationObservedAts, eligibility.piEvidence.observedAt]) { const f = freshnessRefusal(t, { now, notBefore }); if (f) return refuse(`CARRIED_${f}`); }
  const pre = cancelPreClaimRefusal({ intent, cancelOp, captureRows });
  if (pre.code) return refuse(pre.code);
  if (eligibility.intentId !== intent.id || eligibility.intentVersion !== intent.version || eligibility.opId !== cancelOp.id) return refuse("ELIGIBILITY_STALE");
  if (!sameSnapshot(eligibility.snapshot, cancelSnapshot(intent, cancelOp, pre.capture, paymentAttemptId))) return refuse("ELIGIBILITY_SNAPSHOT_CHANGED");
  const rid = String(intent.reservation.reservationId);
  const request = Object.freeze({ method: "PUT", path: `/v1/reservations/${rid}/statuses/cancelled`, query: Object.freeze({}), body: Object.freeze({ ...CANCEL_BODY }) });
  const v = validateCancelRequest(request, { intent, cancelOp });
  return v.ok ? Object.freeze({ ok: true, request }) : v;
}
export { validateCancelRequest };

// ---------------------------------------------------------------------------------------------
// money leg: the ONE bound FULL refund (attempt 1, key ref:<intent>:1) — only AFTER the reservation leg is settled (§7 order)

function refundOpRefusal(op, intent, chargeId) {
  if (!isObj(op) || op.opType !== OPS.REFUND || typeof op.id !== "string" || !UUID_RE.test(op.id)) return "NOT_A_REFUND_OPERATION";
  const p = op.payload;
  if (!isObj(p) || keysOf(p) !== REFUND_PAYLOAD_KEYS) return "REFUND_PAYLOAD_SHAPE";
  if (p.paymentIntentId !== intent.payment.paymentIntentId) return "REFUND_PAYMENT_INTENT";
  if (p.chargeId !== chargeId) return "REFUND_CHARGE";
  if (p.amountMinor !== intent.payment.capturedMinor) return "REFUND_AMOUNT";
  if (p.currency !== intent.price.currency) return "REFUND_CURRENCY";
  if (p.attempt !== 1) return "REFUND_NOT_INITIAL_ATTEMPT";
  if (p.providerIdempotencyKey !== refundKey(intent.id, 1)) return "REFUND_IDEMPOTENCY_KEY";
  return null;
}
function refundPreClaimRefusal({ intent, refundOp, captureRows }) {
  const base = intentBaseRefusal(intent);
  if (base) return { code: base };
  if (intent.settlement.reservationCancelled !== true) return { code: "CANCEL_LEG_NOT_SETTLED" };      // order: cancel first
  if (intent.settlement.authorizationSettled !== false) return { code: "REFUND_LEG_NOT_OPEN" };
  const cap = singleCaptureProof({ intent, captureRows });
  if (!cap.ok) return { code: `CAPTURE_${cap.code}` };
  const opRef = refundOpRefusal(refundOp, intent, cap.chargeId);
  if (opRef) return { code: opRef };
  if (refundOp.state !== "pending" || refundOp.attempts !== 0 || refundOp.dispatchedAt !== null) return { code: "REFUND_OPERATION_ALREADY_CLAIMED_OR_SENT" };
  return { capture: cap };
}
const refundSnapshot = (intent, refundOp, cap, paymentAttemptId) => Object.freeze({ ...intentFacts(intent), ...opFacts(refundOp), chargeId: cap.chargeId, captureFingerprint: cap.fingerprint, paymentAttemptId });

/**
 * refundSendEligibility({ intent, paymentAttemptId, refundOp, captureRows, piEvidence, rawPi, now, notBefore })
 *   fresh v3 evidence (and the RAW object it was built from) proving: captured on exactly the capture row's charge, exact amount / currency,
 *   TEST mode, NO refund yet, no dispute; reservation leg already settled. -> frozen branded eligibility | { ok:false, code }
 */
export function refundSendEligibility({ intent, paymentAttemptId, refundOp, captureRows, piEvidence, rawPi, now, notBefore } = {}) {
  if (typeof paymentAttemptId !== "string" || paymentAttemptId === "") return refuse("PAYMENT_ATTEMPT_REQUIRED");
  const pre = refundPreClaimRefusal({ intent, refundOp, captureRows });
  if (pre.code) return refuse(pre.code);
  const pi = piCapturedUnrefundedProofV3(piEvidence, intent, paymentAttemptId, pre.capture.chargeId, { now, notBefore });
  if (pi) return refuse(`PI_PROOF_${pi}`);
  const raw = rawPiPreSendRefusal(rawPi, { paymentIntentId: intent.payment.paymentIntentId, chargeId: pre.capture.chargeId, amountMinor: intent.payment.capturedMinor, currency: intent.price.currency });
  if (raw) return refuse(`REFUND_PRECONDITION_${raw}`);
  const e = Object.freeze({ ok: true, purpose: REFUND_PURPOSE, opId: refundOp.id, paymentIntentId: intent.payment.paymentIntentId, chargeId: pre.capture.chargeId,
    amountMinor: intent.payment.capturedMinor, currency: intent.price.currency, idempotencyKey: refundOp.payload.providerIdempotencyKey,
    piEvidence: Object.freeze({ id: piEvidence.id, observedAt: piEvidence.observedAt }), notBefore, intentId: intent.id, intentVersion: intent.version,
    snapshot: refundSnapshot(intent, refundOp, pre.capture, paymentAttemptId) });
  ISSUED.add(e);
  return e;
}
/**
 * PRE-CLAIM only. request = { paymentIntentId, params: { amount, metadata: { mv_refund_op: <row id>, mv_refund_key: ref:<intent>:1 } }, options: { idempotencyKey } }
 * (contract §7: the POST carries both metadata fields so §5 discovery can attribute the refund; the Idempotency-Key IS the payment_refunds key).
 * No partial amount, no reason, no other parameter is buildable.
 */
export function buildRefundRequest(input = {}) {
  if (!isObj(input) || keysOf(input) !== JSON.stringify(["captureRows", "eligibility", "intent", "notBefore", "now", "paymentAttemptId", "refundOp"])) return refuse("UNEXPECTED_INPUT");
  const { intent, refundOp, captureRows, eligibility, paymentAttemptId, now, notBefore } = input;
  if (!ISSUED.has(eligibility) || eligibility.ok !== true || eligibility.purpose !== REFUND_PURPOSE) return refuse("ELIGIBILITY_REQUIRED");
  if (notBefore !== eligibility.notBefore) return refuse("STATE_ENTRY_CHANGED");
  const stale = freshnessRefusal(eligibility.piEvidence.observedAt, { now, notBefore });
  if (stale) return refuse(`CARRIED_${stale}`);
  const pre = refundPreClaimRefusal({ intent, refundOp, captureRows });
  if (pre.code) return refuse(pre.code);
  if (eligibility.intentId !== intent.id || eligibility.intentVersion !== intent.version || eligibility.opId !== refundOp.id) return refuse("ELIGIBILITY_STALE");
  if (!sameSnapshot(eligibility.snapshot, refundSnapshot(intent, refundOp, pre.capture, paymentAttemptId))) return refuse("ELIGIBILITY_SNAPSHOT_CHANGED");
  const request = Object.freeze({
    paymentIntentId: intent.payment.paymentIntentId,
    params: Object.freeze({ amount: intent.payment.capturedMinor, metadata: Object.freeze({ [REFUND_METADATA_KEYS.op]: refundOp.id, [REFUND_METADATA_KEYS.key]: refundOp.payload.providerIdempotencyKey }) }),
    options: Object.freeze({ idempotencyKey: refundOp.payload.providerIdempotencyKey })
  });
  const v = validateRefundRequest(request, { intent, refundOp, chargeId: pre.capture.chargeId });
  return v.ok ? Object.freeze({ ok: true, request }) : v;
}
/** SHAPE / IDENTITY only (not send authorization): exact keys, the intent's PI, the FULL captured amount, both metadata fields, the row's own key. */
export function validateRefundRequest(request, { intent, refundOp, chargeId } = {}) {
  if (!isObj(request) || keysOf(request) !== JSON.stringify(["options", "params", "paymentIntentId"])) return refuse("REQUEST_SHAPE");
  if (intentBaseRefusal(intent)) return refuse("INTENT_INVALID");
  const opRef = refundOpRefusal(refundOp, intent, chargeId);
  if (opRef) return refuse(opRef);
  const { params, options } = request;
  if (!isObj(params) || keysOf(params) !== JSON.stringify(["amount", "metadata"])) return refuse("PARAMS_SHAPE");
  if (!isPosInt(params.amount) || params.amount !== intent.payment.capturedMinor || params.amount !== refundOp.payload.amountMinor) return refuse("PARTIAL_OR_WRONG_AMOUNT");
  const md = params.metadata;
  if (!isObj(md) || keysOf(md) !== JSON.stringify([REFUND_METADATA_KEYS.key, REFUND_METADATA_KEYS.op].sort())) return refuse("METADATA_SHAPE");
  if (md[REFUND_METADATA_KEYS.op] !== refundOp.id || md[REFUND_METADATA_KEYS.key] !== refundOp.payload.providerIdempotencyKey) return refuse("METADATA_BINDING");
  if (!isObj(options) || keysOf(options) !== JSON.stringify(["idempotencyKey"])) return refuse("OPTIONS_SHAPE");
  if (request.paymentIntentId !== intent.payment.paymentIntentId || request.paymentIntentId !== refundOp.payload.paymentIntentId) return refuse("REQUEST_PAYMENT_INTENT");
  if (options.idempotencyKey !== refundOp.payload.providerIdempotencyKey || options.idempotencyKey !== refundKey(intent.id, 1)) return refuse("IDEMPOTENCY_KEY");
  return Object.freeze({ ok: true });
}
