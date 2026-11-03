// lib/checkout/compensation-proof.js — Stage E7.4a-0 (offline, PURE). Proof / request foundation for the cancel/void worker.
// Contract: claude/e7-compensation-worker-contract.md (§3.1, §3.2, §3.3, §6, §11). No DB, network, SDK, clock reads or E3 change.
//
// What this module can decide: the SHAPE and the bindings of the facts it is given — a capture-history class, a strict
// canceled / still-authorized PaymentIntent proof, a fully identified active reservation, a strictly future local arrival
// date, and exact void / cancel requests bound to frozen proof snapshots (module-private brands; pre-claim builders only).
//
// What it CANNOT prove (the worker's responsibilities, with fresh DB reads under its fences):
//   * that `captureRows` is the COMPLETE capture history of the intent, and that the rows / intent are current;
//   * that evidence came from an executed, account-verified provider READ persisted as immutable evidence (provenance),
//     and that the configured time zone is trusted configuration;
//   * leases, claims, versions at send time, atomic freshness, and the absence of another actor — every check here is a
//     snapshot; the worker must re-check CURRENT rows immediately before any send and inside every event transaction.
// Validators check shape / identity only: they are NOT send authorization.
import { piIdentityOk, reservationIdentity, FRESH_AFTER_DISPATCH_MS } from "./recovery-plan.js";
import { stillAuthorizedV3Refusal, CAPTURE_PROOF_VERSION } from "./capture-proof.js";
import { captureKey, voidKey, STATES as S } from "./intent-state.js";

export const COMPENSATION_PROOF_VERSION = "compensation-proof-v1";
export const OPS = Object.freeze({ CAPTURE: "stripe.capture_payment_intent", VOID: "stripe.void_payment_intent", CANCEL: "hostaway.cancel_reservation",
  PI_READ: "stripe.retrieve_payment_intent", RES_READ: "hostaway.retrieve_reservation", LOOKUP: "hostaway.lookup_reservation" });
/** Fixed historical Hostaway reservation ids (duplicated on purpose: no booking-db import; asserted equal in tests). */
export const PROTECTED_HOSTAWAY_RESERVATION_IDS = Object.freeze(["70636076", "71045356", "71072615", "71081885"]);
export const isProtectedReservationId = (v) => v != null && PROTECTED_HOSTAWAY_RESERVATION_IDS.includes(String(v));
export const ACTIVE_RESERVATION_STATUS = "new";              // the verified pilot status; everything else fails closed
export const PROOF_MAX_AGE_MS = 5 * 60 * 1000;
export const CANCEL_BODY = Object.freeze({ cancelledBy: "host" });
export const VOID_PURPOSE = "INITIAL_VOID_SEND_ONLY";
export const CANCEL_PURPOSE = "INITIAL_CANCEL_SEND_ONLY";
export const HISTORY_CLASSES = Object.freeze(["Z", "P", "D", "M"]);

const CHARGE_ID_RE = /^(ch|py)_[A-Za-z0-9_]{1,200}$/;
const PI_ID_RE = /^pi_[A-Za-z0-9_]{1,200}$/;
const RID_RE = /^[1-9]\d{0,15}$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const IANA_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*(\/[A-Za-z0-9_+-]+){0,2}$/;
const CAPTURE_ROW_STATES = Object.freeze(["pending", "in_flight", "succeeded", "failed_definite", "outcome_unknown", "escalated", "superseded"]);
const DISPATCHED_STATES = Object.freeze(["in_flight", "succeeded", "failed_definite", "outcome_unknown", "escalated"]);
const CAPTURE_PAYLOAD_KEYS = JSON.stringify(["amountMinor", "attempt", "paymentIntentId", "providerIdempotencyKey"]);
const VOID_PAYLOAD_KEYS = JSON.stringify(["attempt", "paymentIntentId", "providerIdempotencyKey"]);
const CANCEL_PAYLOAD_KEYS = JSON.stringify(["attempt", "cancelledBy", "reservationId"]);

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isPosInt = (v) => Number.isSafeInteger(v) && v > 0;
const isNonNegInt = (v) => Number.isSafeInteger(v) && v >= 0;
const isTime = (v) => Number.isSafeInteger(v) && v > 0;
const keysOf = (o) => JSON.stringify(Object.keys(o).sort());
const refuse = (code) => Object.freeze({ ok: false, code });
const ISSUED = new WeakSet();
const sameSnapshot = (a, b) => isObj(a) && isObj(b) && Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((k) => Object.is(a[k], b[k]));

// ---------------------------------------------------------------------------------------------
// dates in an explicit IANA time zone (no UTC / server fallback)

export function isRealDate(s) {
  const m = typeof s === "string" ? DATE_RE.exec(s) : null;
  if (!m) return false;
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3]);
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

/** Local calendar date (YYYY-MM-DD) of epoch ms `now` in IANA `timeZone`; null for an absent / invalid zone or time. */
export function localDateInZone(now, timeZone) {
  // an IANA zone NAME (e.g. America/Mazatlan); numeric offsets ("+07:00", which Intl may accept) are not zones and are refused
  if (!isTime(now) || typeof timeZone !== "string" || timeZone.length > 64 || !IANA_NAME_RE.test(timeZone)) return null;
  let parts;
  try {
    parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", calendar: "gregory", numberingSystem: "latn" })
      .formatToParts(new Date(now));
  } catch { return null; }
  const get = (t) => (parts.find((p) => p.type === t) || {}).value;
  const s = `${get("year")}-${get("month")}-${get("day")}`;
  return isRealDate(s) ? s : null;
}

/** -> { ok:true, localDate } when `arrival` is STRICTLY after the local date of `now` in `timeZone`; else { ok:false, code }. */
export function arrivalStrictlyFuture(arrival, timeZone, now) {
  if (!isRealDate(arrival)) return refuse("ARRIVAL_DATE_INVALID");
  const localDate = localDateInZone(now, timeZone);
  if (localDate === null) return refuse("TIME_ZONE_OR_CLOCK_INVALID");
  if (!(arrival > localDate)) return refuse("ARRIVAL_NOT_IN_FUTURE");
  return Object.freeze({ ok: true, localDate });
}

// ---------------------------------------------------------------------------------------------
// capture history classifier (contract §3.1)

/**
 * captureHistoryClass({ intent, captureRows })
 *   captureRows: EVERY capture row of the intent as { id, opType, state, attempts, dispatchedAt (ms|null), payload } — the
 *   worker must supply the complete history from the database (this function cannot prove completeness).
 * -> frozen { ok:true, cls: "Z"|"P"|"D"|"M", latestDispatchedAt, fingerprint } | { ok:false, code }   (any refusal = owner case)
 * Z and P are returned ONLY on explicit valid facts; malformed rows / counters, a wrong PaymentIntent / amount / key, and
 * inconsistent dispatch / attempt shapes refuse. M (several rows or attempts) is a valid class that consumers refuse.
 */
export function captureHistoryClass({ intent, captureRows } = {}) {
  if (!isObj(intent) || !isObj(intent.counters) || !isObj(intent.payment) || !isObj(intent.price)) return refuse("INTENT_INVALID");
  const n = intent.counters.captureAttempts;
  if (!isNonNegInt(n)) return refuse("CAPTURE_COUNTER_INVALID");
  const pi = intent.payment.paymentIntentId;
  if (typeof pi !== "string" || !PI_ID_RE.test(pi)) return refuse("INTENT_PAYMENT_INTENT_INVALID");
  if (!Array.isArray(captureRows)) return refuse("CAPTURE_HISTORY_REQUIRED");
  const ids = new Set();
  for (const r of captureRows) {
    if (!isObj(r) || r.opType !== OPS.CAPTURE || typeof r.id !== "string" || r.id === "" || ids.has(r.id)) return refuse("CAPTURE_ROW_INVALID");
    ids.add(r.id);
    if (!CAPTURE_ROW_STATES.includes(r.state) || !isNonNegInt(r.attempts)) return refuse("CAPTURE_ROW_INVALID");
    if (!(r.dispatchedAt === null || isTime(r.dispatchedAt))) return refuse("CAPTURE_ROW_INVALID");
    const p = r.payload;
    if (!isObj(p) || keysOf(p) !== CAPTURE_PAYLOAD_KEYS) return refuse("CAPTURE_ROW_PAYLOAD_SHAPE");
    if (p.paymentIntentId !== pi) return refuse("CAPTURE_ROW_PAYMENT_INTENT");
    if (!isPosInt(p.attempt) || p.attempt > Math.max(n, 1)) return refuse("CAPTURE_ROW_ATTEMPT");
    if (p.amountMinor !== intent.price.finalTotalMinor) return refuse("CAPTURE_ROW_AMOUNT");
    if (p.providerIdempotencyKey !== captureKey(intent.id, pi, p.attempt)) return refuse("CAPTURE_ROW_KEY");
    // dispatch / attempt consistency (0004 guard + claimNextOperation): never sent <=> attempts 0 <=> no dispatch time
    const sent = r.attempts > 0;
    if (sent !== (r.dispatchedAt !== null)) return refuse("CAPTURE_ROW_DISPATCH_INCONSISTENT");
    if (r.state === "pending" && sent) return refuse("CAPTURE_ROW_DISPATCH_INCONSISTENT");        // reconcile_first never returns to pending
    if (DISPATCHED_STATES.includes(r.state) && r.state !== "escalated" && !sent) return refuse("CAPTURE_ROW_DISPATCH_INCONSISTENT");
    if (r.state === "superseded" && sent) return refuse("CAPTURE_ROW_DISPATCH_INCONSISTENT");
  }
  const fingerprint = captureRows.map((r) => `${r.id}|${r.state}|${r.attempts}|${r.dispatchedAt}|${r.payload.attempt}`).sort().join(";");
  const latestDispatchedAt = captureRows.reduce((m, r) => (r.dispatchedAt !== null && (m === null || r.dispatchedAt > m) ? r.dispatchedAt : m), null);
  const out = (cls) => Object.freeze({ ok: true, cls, latestDispatchedAt, fingerprint });
  if (captureRows.length > 1 || n > 1) return out("M");
  if (captureRows.length === 0) return n === 0 ? out("Z") : refuse("CAPTURE_HISTORY_INCONSISTENT");
  const r = captureRows[0];
  if (n !== 1 || r.payload.attempt !== 1) return refuse("CAPTURE_HISTORY_INCONSISTENT");
  if (r.state === "pending" && r.attempts === 0 && r.dispatchedAt === null) return out("P");
  if (r.attempts > 0 && r.dispatchedAt !== null) return out("D");
  return refuse("CAPTURE_HISTORY_NOT_CLASSIFIABLE");        // e.g. never-sent but escalated / superseded: owner case
}

// ---------------------------------------------------------------------------------------------
// PaymentIntent proofs

/** Common freshness: observed at or after notBefore (and dispatch + 2 min when a capture was sent), not future, <= 5 min old. */
function freshnessRefusal(ev, { now, notBefore, latestCaptureDispatchedAt }) {
  if (!isTime(now) || !isTime(notBefore)) return "FRESHNESS_INPUT_INVALID";
  if (!isTime(ev.observedAt)) return "EVIDENCE_TIME_MISSING";
  if (ev.observedAt > now) return "EVIDENCE_IN_FUTURE";
  if (now - ev.observedAt > PROOF_MAX_AGE_MS) return "EVIDENCE_STALE";
  if (ev.observedAt < notBefore) return "EVIDENCE_BEFORE_STATE";
  if (latestCaptureDispatchedAt != null) {
    if (!isTime(latestCaptureDispatchedAt)) return "FRESHNESS_INPUT_INVALID";
    if (ev.observedAt < latestCaptureDispatchedAt + FRESH_AFTER_DISPATCH_MS) return "EVIDENCE_TOO_SOON_AFTER_DISPATCH";
  }
  return null;
}
const piEvidenceShape = (ev) => isObj(ev) && typeof ev.id === "string" && ev.id !== "" && ev.kind === "payment_intent" && ev.readOpType === OPS.PI_READ && isObj(ev.observed);

/**
 * Strict canceled proof (contract §3.1). It does NOT require the authorization to be active or the capture deadline to be
 * ahead: a canceled PaymentIntent cannot be captured afterwards. -> null when proven, else a refusal code.
 * Conservative: every charge binding must be present; a missing fact refuses (never assumed).
 */
export function piCanceledProofV3(ev, intent, paymentAttemptId, { now, notBefore, latestCaptureDispatchedAt = null } = {}) {
  if (!piEvidenceShape(ev)) return "PI_EVIDENCE_SHAPE";
  const o = ev.observed;
  if (o.proofVersion !== CAPTURE_PROOF_VERSION) return "V3_OBSERVATION_REQUIRED";
  if (!isObj(intent) || !isObj(intent.price) || !isObj(intent.payment)) return "INTENT_INVALID";
  if (!piIdentityOk(ev, intent, paymentAttemptId)) return "PAYMENT_INTENT_IDENTITY";
  const total = intent.price.finalTotalMinor; const cur = intent.price.currency;
  if (ev.status !== "canceled" || o.status !== "canceled") return "NOT_CANCELED";
  if (o.amountReceivedMinor !== 0) return "AMOUNT_RECEIVED_NOT_ZERO";
  if (o.amountCapturableMinor !== 0) return "AMOUNT_CAPTURABLE_NOT_ZERO";
  const c = o.latestCharge;
  if (!isObj(c) || c.object !== "charge" || typeof c.id !== "string" || !CHARGE_ID_RE.test(c.id)) return "CHARGE_NOT_EXPANDED";
  if (c.paymentIntent !== intent.payment.paymentIntentId) return "CHARGE_NOT_BOUND";
  if (c.livemode !== false) return "CHARGE_NOT_TEST_MODE";
  if (c.captured !== false) return "CHARGE_CAPTURED";
  if (c.amountCapturedMinor !== 0) return "CHARGE_AMOUNT_CAPTURED";
  if (c.amountRefundedMinor !== 0) return "CHARGE_AMOUNT_REFUNDED";       // conservative (see contract residual R-REFUND)
  if (c.amountMinor !== total) return "CHARGE_AMOUNT";
  if (c.currency !== cur) return "CHARGE_CURRENCY";
  return freshnessRefusal(ev, { now, notBefore, latestCaptureDispatchedAt });
}

// ---------------------------------------------------------------------------------------------
// snapshots (every proof-relevant value; recomputed by the builders from CURRENT inputs)

function intentFacts(intent) {
  const st = isObj(intent.settlement) ? intent.settlement : {};
  return {
    intentId: intent.id, intentVersion: intent.version, status: intent.status, listingId: intent.listingId, from: intent.from, to: intent.to, ref: intent.ref,
    captureAttempts: intent.counters.captureAttempts, priceMinor: intent.price.finalTotalMinor, currency: intent.price.currency,
    paymentIntentId: intent.payment.paymentIntentId, authorizedMinor: intent.payment.amountMinor,
    authorizedCurrency: String(intent.payment.currency || "").toUpperCase(), captureBefore: intent.payment.captureBefore,
    reservationId: intent.reservation ? String(intent.reservation.reservationId) : null,
    reservationCancelled: st.reservationCancelled === undefined ? null : st.reservationCancelled,
    authorizationSettled: st.authorizationSettled === undefined ? null : st.authorizationSettled
  };
}
const opFacts = (op) => ({ opId: op.id, opType: op.opType, opState: op.state, opAttempts: op.attempts, opDispatchedAt: op.dispatchedAt, opPayload: JSON.stringify(op.payload) });

function intentBaseRefusal(intent) {
  if (!isObj(intent) || typeof intent.id !== "string" || intent.id === "" || !Number.isSafeInteger(intent.version)) return "INTENT_INVALID";
  if (!isObj(intent.price) || !isObj(intent.payment) || !isObj(intent.counters)) return "INTENT_INVALID";
  if (!isPosInt(intent.price.finalTotalMinor) || typeof intent.price.currency !== "string") return "PRICE_INVALID";
  if (typeof intent.payment.paymentIntentId !== "string" || !PI_ID_RE.test(intent.payment.paymentIntentId)) return "INTENT_PAYMENT_INTENT_INVALID";
  if (intent.payment.amountMinor !== intent.price.finalTotalMinor || String(intent.payment.currency || "").toUpperCase() !== intent.price.currency) return "AUTHORIZED_AMOUNT_NOT_PRICE";
  return null;
}

// ---------------------------------------------------------------------------------------------
// void (contract §3.2)

function voidOpRefusal(op, intent) {
  if (!isObj(op) || op.opType !== OPS.VOID || typeof op.id !== "string" || op.id === "") return "NOT_A_VOID_OPERATION";
  const p = op.payload;
  if (!isObj(p) || keysOf(p) !== VOID_PAYLOAD_KEYS) return "VOID_PAYLOAD_SHAPE";
  if (p.paymentIntentId !== intent.payment.paymentIntentId) return "VOID_PAYMENT_INTENT";
  if (p.attempt !== 1) return "VOID_NOT_INITIAL_ATTEMPT";
  if (p.providerIdempotencyKey !== voidKey(intent.id, p.paymentIntentId, 1)) return "VOID_IDEMPOTENCY_KEY";
  return null;
}
function voidPreClaimRefusal({ intent, voidOp, captureRows }) {
  const base = intentBaseRefusal(intent);
  if (base) return { code: base };
  if (intent.status === S.RESERVATION_FAILED) {
    if (intent.settlement != null && intent.settlement.authorizationSettled === true) return { code: "AUTHORIZATION_ALREADY_SETTLED" };
  } else if (intent.status === S.CAPTURE_FAILED) {
    if (!isObj(intent.settlement) || intent.settlement.authorizationSettled !== false) return { code: "AUTHORIZATION_LEG_NOT_OPEN" };
  } else return { code: "NOT_A_VOID_STATE" };
  const opRef = voidOpRefusal(voidOp, intent);
  if (opRef) return { code: opRef };
  if (voidOp.state !== "pending" || voidOp.attempts !== 0 || voidOp.dispatchedAt !== null) return { code: "VOID_OPERATION_ALREADY_CLAIMED_OR_SENT" };
  const h = captureHistoryClass({ intent, captureRows });
  if (!h.ok) return { code: `HISTORY_${h.code}` };
  if (h.cls !== "Z" && h.cls !== "P") return { code: `CAPTURE_HISTORY_${h.cls}_BLOCKS_VOID` };     // D needs canceled proof = no void at all
  return { history: h };
}
function voidSnapshot(intent, voidOp, history, paymentAttemptId) {
  return Object.freeze({ ...intentFacts(intent), ...opFacts(voidOp), historyClass: history.cls, historyFingerprint: history.fingerprint, paymentAttemptId });
}

/**
 * voidSendEligibility({ evidence, intent, paymentAttemptId, voidOp, captureRows, now, notBefore })
 *   evidence: the fresh still-authorized PI evidence row (v3). The capture DEADLINE is deliberately not required to be
 *   ahead: releasing an authorization stays valid after it, if the fresh full proof shows requires_capture and the history
 *   class proves no capture could have been sent (Z / P).
 * -> frozen branded { ok:true, purpose, opId, paymentIntentId, evidenceId, evidenceObservedAt, intentVersion, snapshot } | { ok:false, code }
 */
export function voidSendEligibility({ evidence, intent, paymentAttemptId, voidOp, captureRows, now, notBefore } = {}) {
  const pre = voidPreClaimRefusal({ intent, voidOp, captureRows });
  if (pre.code) return refuse(pre.code);
  if (!piEvidenceShape(evidence)) return refuse("PI_EVIDENCE_SHAPE");
  const proof = stillAuthorizedV3Refusal(evidence, intent, paymentAttemptId);
  if (proof) return refuse(proof);
  const fresh = freshnessRefusal(evidence, { now, notBefore, latestCaptureDispatchedAt: pre.history.latestDispatchedAt });
  if (fresh) return refuse(fresh);
  const e = Object.freeze({ ok: true, purpose: VOID_PURPOSE, opId: voidOp.id, paymentIntentId: intent.payment.paymentIntentId, evidenceId: evidence.id,
    evidenceObservedAt: evidence.observedAt, intentId: intent.id, intentVersion: intent.version, snapshot: voidSnapshot(intent, voidOp, pre.history, paymentAttemptId) });
  ISSUED.add(e);
  return e;
}

/** PRE-CLAIM only; every proof-relevant CURRENT value must equal the eligibility snapshot. -> { ok, request } | { ok:false, code } */
export function buildVoidRequest(input = {}) {
  if (!isObj(input) || keysOf(input) !== JSON.stringify(["captureRows", "eligibility", "intent", "paymentAttemptId", "voidOp"])) return refuse("UNEXPECTED_INPUT");
  const { intent, voidOp, captureRows, eligibility, paymentAttemptId } = input;
  if (!ISSUED.has(eligibility) || eligibility.ok !== true || eligibility.purpose !== VOID_PURPOSE) return refuse("ELIGIBILITY_REQUIRED");
  const pre = voidPreClaimRefusal({ intent, voidOp, captureRows });
  if (pre.code) return refuse(pre.code);
  if (eligibility.intentId !== intent.id || eligibility.intentVersion !== intent.version || eligibility.opId !== voidOp.id) return refuse("ELIGIBILITY_STALE");
  if (!sameSnapshot(eligibility.snapshot, voidSnapshot(intent, voidOp, pre.history, paymentAttemptId))) return refuse("ELIGIBILITY_SNAPSHOT_CHANGED");
  const request = Object.freeze({ paymentIntentId: intent.payment.paymentIntentId, params: Object.freeze({}),
    options: Object.freeze({ idempotencyKey: voidOp.payload.providerIdempotencyKey }) });
  const v = validateVoidRequest(request, { intent, voidOp });
  return v.ok ? Object.freeze({ ok: true, request }) : v;
}

/** SHAPE / IDENTITY only (not send authorization): exact keys, same PI, empty params, the row's own key. */
export function validateVoidRequest(request, { intent, voidOp } = {}) {
  if (!isObj(request) || keysOf(request) !== JSON.stringify(["options", "params", "paymentIntentId"])) return refuse("REQUEST_SHAPE");
  if (intentBaseRefusal(intent)) return refuse("INTENT_INVALID");
  const opRef = voidOpRefusal(voidOp, intent);
  if (opRef) return refuse(opRef);
  if (!isObj(request.params) || Object.keys(request.params).length !== 0) return refuse("PARAMS_NOT_EMPTY");
  if (!isObj(request.options) || keysOf(request.options) !== JSON.stringify(["idempotencyKey"])) return refuse("OPTIONS_SHAPE");
  if (request.paymentIntentId !== intent.payment.paymentIntentId || request.paymentIntentId !== voidOp.payload.paymentIntentId) return refuse("REQUEST_PAYMENT_INTENT");
  if (request.options.idempotencyKey !== voidOp.payload.providerIdempotencyKey) return refuse("IDEMPOTENCY_KEY");
  return Object.freeze({ ok: true });
}

// ---------------------------------------------------------------------------------------------
// reservation proof + Hostaway cancel (contract §3.3)

const resEvidenceShape = (ev) => isObj(ev) && typeof ev.id === "string" && ev.id !== "" && ev.kind === "hostaway_reservation" && isObj(ev.observed);

/**
 * Fully identified ACTIVE reservation from bound evidence: a by-id read (selector = externalRef = the intent's reservation id)
 * with every identity field equal and status "new"; the booking ref echoed equal, or (absent) a by-ref lookup of exactly this
 * reservation with matchCount 1. Protected ids refused. Never from a caller-provided status. -> { ok, evidenceIds, observedAts } | refusal
 */
export function activeReservationProof({ intent, byId, byRef = null, now, notBefore } = {}) {
  if (!isObj(intent) || !isObj(intent.reservation)) return refuse("NO_RESERVATION");
  const rid = String(intent.reservation.reservationId);
  if (!RID_RE.test(rid)) return refuse("RESERVATION_ID_INVALID");
  if (isProtectedReservationId(rid)) return refuse("PROTECTED_RESERVATION_ID");
  const one = (ev, readOpType, selector) => {
    if (!resEvidenceShape(ev) || ev.readOpType !== readOpType || ev.requestRef !== selector) return "RESERVATION_EVIDENCE_SHAPE";
    if (ev.status !== "found_active") return "RESERVATION_NOT_ACTIVE";
    if (ev.externalRef !== rid || isProtectedReservationId(ev.externalRef) || isProtectedReservationId(ev.observed.reservationId)) return "RESERVATION_ID_MISMATCH";
    if (reservationIdentity(ev, intent, rid) !== "ok") return "RESERVATION_IDENTITY";
    if (ev.observed.status !== ACTIVE_RESERVATION_STATUS) return "RESERVATION_STATUS_NOT_NEW";
    return freshnessRefusal(ev, { now, notBefore, latestCaptureDispatchedAt: null });
  };
  const a = one(byId, OPS.RES_READ, rid);
  if (a) return refuse(`BY_ID_${a}`);
  if (byId.observed.bookingRef === intent.ref) {
    if (byRef !== null) return refuse("UNEXPECTED_LOOKUP_EVIDENCE");
    return Object.freeze({ ok: true, evidenceIds: Object.freeze([byId.id]), observedAts: Object.freeze([byId.observedAt]) });
  }
  if (byId.observed.bookingRef != null) return refuse("BOOKING_REF_MISMATCH");
  const b = one(byRef, OPS.LOOKUP, intent.ref);
  if (b) return refuse(`BY_REF_${b}`);
  if (byRef.observed.bookingRef !== intent.ref || byRef.observed.matchCount !== 1) return refuse("BY_REF_NOT_UNIQUE_MATCH");
  return Object.freeze({ ok: true, evidenceIds: Object.freeze([byId.id, byRef.id]), observedAts: Object.freeze([byId.observedAt, byRef.observedAt]) });
}

function cancelOpRefusal(op, intent) {
  if (!isObj(op) || op.opType !== OPS.CANCEL || typeof op.id !== "string" || op.id === "") return "NOT_A_CANCEL_OPERATION";
  const p = op.payload;
  if (!isObj(p) || keysOf(p) !== CANCEL_PAYLOAD_KEYS) return "CANCEL_PAYLOAD_SHAPE";
  if (!intent.reservation || p.reservationId !== String(intent.reservation.reservationId)) return "CANCEL_RESERVATION";
  if (p.cancelledBy !== CANCEL_BODY.cancelledBy) return "CANCEL_NOT_HOST";
  if (p.attempt !== 1) return "CANCEL_NOT_INITIAL_ATTEMPT";
  return null;
}
function cancelPreClaimRefusal({ intent, cancelOp, captureRows, timeZone, now }) {
  const base = intentBaseRefusal(intent);
  if (base) return { code: base };
  if (intent.status !== S.CAPTURE_FAILED) return { code: "NOT_CAPTURE_FAILED" };
  if (!isObj(intent.settlement) || intent.settlement.reservationCancelled !== false) return { code: "RESERVATION_LEG_NOT_OPEN" };
  if (!intent.reservation || isProtectedReservationId(intent.reservation.reservationId)) return { code: "PROTECTED_OR_NO_RESERVATION" };
  const opRef = cancelOpRefusal(cancelOp, intent);
  if (opRef) return { code: opRef };
  if (cancelOp.state !== "pending" || cancelOp.attempts !== 0 || cancelOp.dispatchedAt !== null) return { code: "CANCEL_OPERATION_ALREADY_CLAIMED_OR_SENT" };
  const h = captureHistoryClass({ intent, captureRows });
  if (!h.ok) return { code: `HISTORY_${h.code}` };
  if (h.cls === "M") return { code: "CAPTURE_HISTORY_M_BLOCKS_CANCEL" };
  const arr = arrivalStrictlyFuture(intent.from, timeZone, now);
  if (!arr.ok) return { code: arr.code };
  return { history: h, localDate: arr.localDate };
}
function cancelSnapshot(intent, cancelOp, history, paymentAttemptId, timeZone, localDate) {
  return Object.freeze({ ...intentFacts(intent), ...opFacts(cancelOp), historyClass: history.cls, historyFingerprint: history.fingerprint, paymentAttemptId,
    timeZone, localDate });
}

/**
 * cancelSendEligibility({ intent, paymentAttemptId, cancelOp, captureRows, byId, byRef?, canceledPiEvidence?, timeZone, now, notBefore })
 *   History Z / P: no capture could have been sent. History D: requires canceledPiEvidence passing piCanceledProofV3 (dispatch
 *   + 2 min). History M / malformed: refused. -> frozen branded eligibility (snapshot incl. zone + local date) | { ok:false, code }
 */
export function cancelSendEligibility({ intent, paymentAttemptId, cancelOp, captureRows, byId, byRef = null, canceledPiEvidence = null, timeZone, now, notBefore } = {}) {
  const pre = cancelPreClaimRefusal({ intent, cancelOp, captureRows, timeZone, now });
  if (pre.code) return refuse(pre.code);
  let canceled = null;
  if (pre.history.cls === "D") {
    if (canceledPiEvidence === null) return refuse("CAPTURE_SENT_REQUIRES_CANCELED_PROOF");
    const c = piCanceledProofV3(canceledPiEvidence, intent, paymentAttemptId, { now, notBefore, latestCaptureDispatchedAt: pre.history.latestDispatchedAt });
    if (c) return refuse(`CANCELED_PROOF_${c}`);
    canceled = Object.freeze({ id: canceledPiEvidence.id, observedAt: canceledPiEvidence.observedAt });
  } else if (canceledPiEvidence !== null) {
    const c = piCanceledProofV3(canceledPiEvidence, intent, paymentAttemptId, { now, notBefore, latestCaptureDispatchedAt: pre.history.latestDispatchedAt });
    if (c) return refuse(`CANCELED_PROOF_${c}`);         // supplied evidence must never be contradictory / unproven
    canceled = Object.freeze({ id: canceledPiEvidence.id, observedAt: canceledPiEvidence.observedAt });
  }
  const res = activeReservationProof({ intent, byId, byRef, now, notBefore });
  if (!res.ok) return res;
  const e = Object.freeze({ ok: true, purpose: CANCEL_PURPOSE, opId: cancelOp.id, reservationId: String(intent.reservation.reservationId),
    reservationEvidenceIds: res.evidenceIds, reservationObservedAts: res.observedAts, canceledPiEvidence: canceled,
    intentId: intent.id, intentVersion: intent.version, snapshot: cancelSnapshot(intent, cancelOp, pre.history, paymentAttemptId, timeZone, pre.localDate) });
  ISSUED.add(e);
  return e;
}

/** PRE-CLAIM only: CURRENT inputs (incl. the local date at `now`) must equal the snapshot. -> { ok, request } | { ok:false, code } */
export function buildCancelRequest(input = {}) {
  if (!isObj(input) || keysOf(input) !== JSON.stringify(["cancelOp", "captureRows", "eligibility", "intent", "now", "paymentAttemptId", "timeZone"])) return refuse("UNEXPECTED_INPUT");
  const { intent, cancelOp, captureRows, eligibility, paymentAttemptId, timeZone, now } = input;
  if (!ISSUED.has(eligibility) || eligibility.ok !== true || eligibility.purpose !== CANCEL_PURPOSE) return refuse("ELIGIBILITY_REQUIRED");
  const pre = cancelPreClaimRefusal({ intent, cancelOp, captureRows, timeZone, now });
  if (pre.code) return refuse(pre.code);
  if (eligibility.intentId !== intent.id || eligibility.intentVersion !== intent.version || eligibility.opId !== cancelOp.id) return refuse("ELIGIBILITY_STALE");
  if (!sameSnapshot(eligibility.snapshot, cancelSnapshot(intent, cancelOp, pre.history, paymentAttemptId, timeZone, pre.localDate))) return refuse("ELIGIBILITY_SNAPSHOT_CHANGED");
  const rid = String(intent.reservation.reservationId);
  const request = Object.freeze({ method: "PUT", path: `/v1/reservations/${rid}/statuses/cancelled`, query: Object.freeze({}), body: Object.freeze({ ...CANCEL_BODY }) });
  const v = validateCancelRequest(request, { intent, cancelOp });
  return v.ok ? Object.freeze({ ok: true, request }) : v;
}

/** SHAPE / IDENTITY only (not send authorization). */
export function validateCancelRequest(request, { intent, cancelOp } = {}) {
  if (!isObj(request) || keysOf(request) !== JSON.stringify(["body", "method", "path", "query"])) return refuse("REQUEST_SHAPE");
  if (!isObj(intent) || !isObj(intent.reservation)) return refuse("NO_RESERVATION");
  const opRef = cancelOpRefusal(cancelOp, intent);
  if (opRef) return refuse(opRef);
  const rid = String(intent.reservation.reservationId);
  if (!RID_RE.test(rid) || isProtectedReservationId(rid)) return refuse("RESERVATION_ID_INVALID_OR_PROTECTED");
  if (request.method !== "PUT") return refuse("METHOD");
  if (request.path !== `/v1/reservations/${rid}/statuses/cancelled`) return refuse("PATH");
  if (!isObj(request.query) || Object.keys(request.query).length !== 0) return refuse("QUERY_NOT_EMPTY");
  if (!isObj(request.body) || keysOf(request.body) !== JSON.stringify(["cancelledBy"]) || request.body.cancelledBy !== "host") return refuse("BODY");
  return Object.freeze({ ok: true });
}
