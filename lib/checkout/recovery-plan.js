// lib/checkout/recovery-plan.js — Stage E7.1 (offline). PURE, state-aware missed-outcome recovery planner.
//
// No I/O, no clock, no database, no provider. Not imported by any route.
//
// planRecovery(facts) looks at ONE completed provider-write operation (create / capture / void / cancel / offline charge),
// the intent's CURRENT persisted state, and verified provider evidence, and returns exactly one of:
//   { kind: "event", event, settle? }      a LEGAL E3 event (checked with transition() before it is returned) with a
//                                          deterministic id; `settle` = evidence id to settle an outcome_unknown row with
//                                          first (booking.settle_operation_from_evidence decides the row state itself)
//   { kind: "needs_fresh_read", read }     no usable fresh evidence: queue this provider READ (bounded, deduplicated by
//                                          the caller); nothing is inferred meanwhile
//   { kind: "operator", code }             cannot be resolved from facts; an owner must look (no event is invented)
//   { kind: "none", code }                 nothing to do (the intent no longer awaits this operation, or a stale attempt)
//
// Contract (E7 contract + errata E0–E7):
//   * Facts only from persisted rows and FRESH API evidence (observed >= dispatch + FRESH_AFTER_DISPATCH_MS). A requested
//     booking_ref, an attempts row or a worker's memory is never provider proof. Observed values are copied as recorded;
//     missing values are never filled in.
//   * Reservation identity = a by-id read (found_active; same id; listing, dates, total AND currency equal to the intent)
//     PLUS a by-ref lookup (bookingRef = intent.ref, matchCount exactly 1, same reservation id).
//   * A captured outcome needs full PaymentIntent + latest-Charge proof (errata E6). Any difference -> ESCALATE.
//   * A capture row completed while the intent is still reservation_confirmed -> CAPTURE_OUTCOME_UNKNOWN first (sends
//     nothing); RECONCILED_* is never planned in reservation_confirmed.
//   * Only the CURRENT capture attempt is acted on; an older attempt's row yields { kind: "none", code: "STALE_ATTEMPT" }.
//   * Already-claimed writes are never re-queued or re-created: the planner has no "retry" outcome at all.
import { transition, STATES as S } from "./intent-state.js";

export const RECOVERY_PLAN_VERSION = "recovery-plan-v1";
/** Evidence must be observed at least this long after the write was handed to a sender (same rule as the database). */
export const FRESH_AFTER_DISPATCH_MS = 2 * 60 * 1000;

export const OP = Object.freeze({
  CREATE: "hostaway.create_reservation",
  CAPTURE: "stripe.capture_payment_intent",
  VOID: "stripe.void_payment_intent",
  CANCEL: "hostaway.cancel_reservation",
  OFFLINE_CHARGE: "hostaway.record_offline_charge"
});
export const WRITE_OP_TYPES = Object.freeze(Object.values(OP));
const READ = Object.freeze({ PI: "stripe.retrieve_payment_intent", RES_BY_ID: "hostaway.retrieve_reservation", RES_BY_REF: "hostaway.lookup_reservation" });

/**
 * Deterministic event ids. "Handled" for an operation means op-outcome:{opId} is applied (its final E3 consequence),
 * or the intent no longer awaits it (see the AWAITING definition in the database recovery module). op-unknown:{opId} is the same id
 * reportUnknownOutcome() uses, so the two paths de-duplicate each other. An inconclusive read is bound to its evidence.
 */
export const RECOVERY_EVENT_ID = Object.freeze({
  outcome: (opId) => `op-outcome:${opId}`,
  unknown: (opId) => `op-unknown:${opId}`,
  inconclusive: (opId, evidenceId) => `op-inconclusive:${opId}:${evidenceId}`
});

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v) => (v == null ? null : String(v));
const int = (v) => (Number.isSafeInteger(v) ? v : null);
const pick = (o, k) => (isObj(o) && o[k] !== undefined ? o[k] : null);

/**
 * Build the persisted observation of a Stripe PaymentIntent read (ids, amounts, statuses only; no customer data).
 * `pi` is the API object with latest_charge EXPANDED; `accountVerified` is the caller's result of checking the
 * Stripe account the key belongs to. Every value is COPIED from the provider object; a missing or mistyped value stays
 * null (an unexpanded latest_charge keeps only its id). Nothing is invented or defaulted.
 */
export function paymentIntentProofObservation(pi, { accountVerified } = {}) {
  const lc = isObj(pi) ? pi.latest_charge : null;
  const ch = isObj(lc) ? lc : null;
  const md = isObj(pi) && isObj(pi.metadata) ? pi.metadata : {};
  const upper = (v) => (typeof v === "string" ? v.toUpperCase() : null);
  const bool = (v) => (typeof v === "boolean" ? v : null);
  return {
    proofVersion: "pi-proof-v2",
    object: str(pick(pi, "object")),
    paymentIntentId: str(pick(pi, "id")),
    accountVerified: accountVerified === true,
    livemode: bool(pick(pi, "livemode")),
    metadataIntentId: str(md.mv_intent_id),
    metadataAttemptId: str(md.mv_payment_attempt_id),
    captureMethod: str(pick(pi, "capture_method")),
    status: str(pick(pi, "status")),
    amountMinor: int(pick(pi, "amount")),
    amountReceivedMinor: int(pick(pi, "amount_received")),
    amountCapturableMinor: int(pick(pi, "amount_capturable")),
    currency: upper(pick(pi, "currency")),
    latestCharge: ch ? {
      object: str(ch.object),
      id: str(ch.id),
      paymentIntent: str(typeof ch.payment_intent === "string" ? ch.payment_intent : pick(ch.payment_intent, "id")),
      status: str(ch.status),
      captured: bool(ch.captured),
      amountMinor: int(ch.amount),
      amountCapturedMinor: int(ch.amount_captured),
      amountRefundedMinor: int(ch.amount_refunded),
      currency: upper(ch.currency),
      livemode: bool(ch.livemode)
    } : (typeof lc === "string" ? { object: null, id: lc, paymentIntent: null, status: null, captured: null, amountMinor: null,
      amountCapturedMinor: null, amountRefundedMinor: null, currency: null, livemode: null } : null)
  };
}

// ---------------------------------------------------------------------------------------------
// proofs (pure predicates over persisted evidence)

const CHARGE_ID_RE = /^(ch|py)_[A-Za-z0-9_]{1,200}$/;

/** Same PaymentIntent object, verified account, test mode, bound to this intent + payment attempt, manual capture, exact price. */
export function piIdentityOk(ev, intent, paymentAttemptId) {
  const o = ev && ev.observed;
  const pay = intent.payment; const price = intent.price;
  return !!(isObj(o) && pay && price && typeof paymentAttemptId === "string" && paymentAttemptId !== "" &&
    ev.kind === "payment_intent" && ev.requestRef === pay.paymentIntentId && ev.externalRef === pay.paymentIntentId &&
    o.object === "payment_intent" && o.paymentIntentId === pay.paymentIntentId &&
    o.status === ev.status && o.accountVerified === true && o.livemode === false &&
    o.metadataIntentId === intent.id && o.metadataAttemptId === paymentAttemptId && o.captureMethod === "manual" &&
    o.amountMinor === price.finalTotalMinor && o.currency === price.currency);
}
/** Errata E6: full captured proof (PaymentIntent + its latest Charge, every binding from copied provider fields). */
export function piCapturedProof(ev, intent, paymentAttemptId) {
  if (!piIdentityOk(ev, intent, paymentAttemptId)) return false;
  const o = ev.observed; const c = o.latestCharge; const total = intent.price.finalTotalMinor;
  return o.status === "succeeded" && o.amountReceivedMinor === total && isObj(c) &&
    c.object === "charge" && typeof c.id === "string" && CHARGE_ID_RE.test(c.id) && c.paymentIntent === intent.payment.paymentIntentId &&
    c.status === "succeeded" && c.captured === true && c.amountMinor === total && c.amountCapturedMinor === total &&
    c.amountRefundedMinor === 0 && c.currency === intent.price.currency && c.livemode === false;
}
export function piStillAuthorizedProof(ev, intent, paymentAttemptId) {
  if (!piIdentityOk(ev, intent, paymentAttemptId)) return false;
  const o = ev.observed;
  return o.status === "requires_capture" && o.amountReceivedMinor === 0 && o.amountCapturableMinor === intent.price.finalTotalMinor;
}
export function piGoneProof(ev, intent, paymentAttemptId) {
  if (!piIdentityOk(ev, intent, paymentAttemptId)) return false;
  return ev.observed.status === "canceled" && ev.observed.amountReceivedMinor === 0;
}

/**
 * Reservation identity of one Hostaway observation against the intent and an expected reservation id.
 * "ok" = every field present and equal; "mismatch" = some present field CONTRADICTS (wins over missing);
 * "incomplete" = nothing contradicts but a field is missing. Fields: reservationId (and the evidence's externalRef),
 * listingId, from, to, totalMinor, currency.
 */
export function reservationIdentity(ev, intent, rid) {
  const o = ev && ev.observed;
  if (!isObj(o) || !intent.price) return "incomplete";
  const checks = [
    [o.reservationId, (v) => str(v) === rid], [ev.externalRef, (v) => str(v) === rid],
    [o.listingId, (v) => v === intent.listingId], [o.from, (v) => v === intent.from], [o.to, (v) => v === intent.to],
    [o.totalMinor, (v) => v === intent.price.finalTotalMinor],
    [o.currency, (v) => typeof v === "string" && v.toUpperCase() === intent.price.currency]
  ];
  let missing = false;
  for (const [v, okFn] of checks) {
    if (v == null || v === "") { missing = true; continue; }
    if (!okFn(v)) return "mismatch";
  }
  return missing ? "incomplete" : "ok";
}
const reservationOf = (ev, rid) => ({ reservationId: rid, listingId: ev.observed.listingId, from: ev.observed.from, to: ev.observed.to,
  totalMinor: ev.observed.totalMinor, currency: ev.observed.currency.toUpperCase() });

// ---------------------------------------------------------------------------------------------

const none = (code) => ({ kind: "none", code });
const operator = (code) => ({ kind: "operator", code });
const freshRead = (opType, ref, code) => ({ kind: "needs_fresh_read", code, read: { opType, ref: String(ref) } });

function isFresh(ev, op) {
  if (ev.observedAt == null || op.dispatchedAt == null) return false;
  const t = Number(ev.observedAt);
  const d = Number(op.dispatchedAt);
  return Number.isFinite(t) && Number.isFinite(d) && t >= d + FRESH_AFTER_DISPATCH_MS;
}
/**
 * Latest fresh API evidence of a read type REQUESTED with this selector (lookup -> intent.ref, by-id -> reservation id,
 * PaymentIntent -> its id). The selector is the read row's own payload, never a value the provider returned.
 */
function latest(evidence, op, readOpType, requestRef) {
  const c = evidence.filter((e) => e.readOpType === readOpType && e.requestRef === requestRef && isFresh(e, op));
  c.sort((a, b) => (Number(b.observedAt) - Number(a.observedAt)) || String(b.id).localeCompare(String(a.id)));
  return c[0] || null;
}

/**
 * planRecovery({ intent, op, evidence, appliedEventIds, paymentAttemptId, now, config })
 *   intent           E3 intent (rowToIntent) as persisted NOW
 *   op               { id, opType, state, dispatchedAt(ms), payload, resultRef, errorCode }
 *   evidence         [{ id, kind, readOpType, requestRef, externalRef, status, observed, observedAt(ms) }] API evidence for
 *                    this intent; requestRef = the read row's own request selector (lookup ref / reservation id / PI id)
 *   appliedEventIds  ids already applied for this intent (Set or array)
 *   paymentAttemptId the completed payment attempt bound to intent.payment.paymentIntentId (or null)
 *   knownReservationIds provider-RETURNED reservation ids already persisted for a create (attempts row, late result);
 *                    any that differs from the proven id is a conflict (escalate). The requested booking_ref is never one.
 */
export function planRecovery(facts) {
  const { intent, op, now } = facts;
  if (!intent || !op || !Number.isFinite(now)) throw new TypeError("planRecovery: intent, op, now required");
  const applied = new Set(facts.appliedEventIds || []);
  const evidence = Array.isArray(facts.evidence) ? facts.evidence.filter((e) => e && typeof e.readOpType === "string") : []; // API reads only
  if (!["succeeded", "failed_definite", "outcome_unknown"].includes(op.state)) return none("OPERATION_NOT_COMPLETED");
  if (op.dispatchedAt == null || !Number.isFinite(Number(op.dispatchedAt))) return operator("OPERATION_NEVER_DISPATCHED");
  if (applied.has(RECOVERY_EVENT_ID.outcome(op.id))) return none("ALREADY_HANDLED");
  const ctx = { ...facts, evidence, applied };
  let plan;
  switch (op.opType) {
    case OP.CREATE: plan = planCreate(ctx); break;
    case OP.CAPTURE: plan = planCapture(ctx); break;
    case OP.VOID: plan = planVoid(ctx); break;
    case OP.CANCEL: plan = planCancel(ctx); break;
    case OP.OFFLINE_CHARGE: plan = planOfflineCharge(ctx); break;
    default: return none("NOT_A_RECOVERABLE_WRITE");
  }
  if (plan.kind !== "event") return plan;
  // final gate: the planned event must be LEGAL in the current state (pure E3) and change something
  if (applied.has(plan.event.id)) return none("ALREADY_HANDLED");
  let r;
  try { r = transition(intent, plan.event, { now, config: { ...(facts.config || {}), lookupAbsenceIsAuthoritative: false } }); }
  catch { return operator("PLANNED_EVENT_REJECTED:INVALID_INTENT"); }
  if (!r.ok) return operator(`PLANNED_EVENT_REJECTED:${r.error}`.slice(0, 64).replace(/[^A-Z0-9_:]/g, "_"));
  if (r.duplicate) return none("ALREADY_HANDLED");
  return { ...plan, intentVersion: intent.version, intentState: intent.status, opId: op.id, planVersion: RECOVERY_PLAN_VERSION };
}

const ev = (type, id, extra = {}) => ({ kind: "event", event: { type, id, ...extra } });

// ---- Hostaway create ----
/** Provider-returned reservation ids already persisted for this create (op.resultRef, attempts row). Never the requested ref. */
function knownIds(op, facts) {
  return [op.resultRef, ...(Array.isArray(facts.knownReservationIds) ? facts.knownReservationIds : [])]
    .filter((v) => v != null && String(v) !== "").map(String);
}
function planCreate(ctx) {
  const { intent, op, evidence, applied } = ctx;
  const st = intent.status;
  if (st !== S.RESERVATION_PENDING && st !== S.RESERVATION_UNKNOWN) return none("NOT_AWAITING");
  if (st === S.RESERVATION_PENDING && !intent.dispatch) return none("NOT_DISPATCHED");
  if (st === S.RESERVATION_PENDING) {
    if (op.state === "outcome_unknown") return ev("RESERVATION_OUTCOME_UNKNOWN", RECOVERY_EVENT_ID.unknown(op.id), { code: "RECOVERED_OUTCOME_UNKNOWN" });
    if (op.state === "failed_definite") return ev("RESERVATION_FAILED", RECOVERY_EVENT_ID.outcome(op.id), { definite: true, code: op.errorCode || "RESERVATION_REFUSED" });
  }
  const escalate = (code) => ev("ESCALATE", RECOVERY_EVENT_ID.outcome(op.id), { code });
  const lookupRead = { opType: READ.RES_BY_REF, ref: intent.ref };
  // not proven: pending -> outcome unknown (E3 then looks up by ref); unknown -> bounded inconclusive bound to the evidence
  const notProven = (evRow, read) => (st === S.RESERVATION_PENDING
    ? ev("RESERVATION_OUTCOME_UNKNOWN", RECOVERY_EVENT_ID.unknown(op.id), { code: "RESERVATION_NOT_PROVEN" })
    : inconclusive(op, evRow, applied, "reservation", read));
  // succeeded (pending) or any state (unknown): only fresh by-ref + by-id proof establishes the reservation
  const lk = latest(evidence, op, READ.RES_BY_REF, intent.ref);
  if (!lk) return freshRead(lookupRead.opType, lookupRead.ref, "LOOKUP_NEEDED");
  const lo = isObj(lk.observed) ? lk.observed : {};
  if (lk.kind !== "hostaway_reservation" || lk.status !== "found_active") return notProven(lk, lookupRead);
  if (lo.bookingRef !== intent.ref) return escalate("RESERVATION_IDENTITY_MISMATCH");     // the database already refuses this
  if (Number.isInteger(lo.matchCount) && lo.matchCount > 1) return escalate("DUPLICATE_BOOKING_REF");
  if (lo.matchCount !== 1) return notProven(lk, lookupRead);
  const rid = str(lo.reservationId);
  if (!rid) return notProven(lk, lookupRead);
  const lkId = reservationIdentity(lk, intent, rid);
  if (lkId === "mismatch") return escalate("RESERVATION_IDENTITY_MISMATCH");
  if (knownIds(op, ctx).some((k) => k !== rid)) return escalate("RESERVATION_ID_CONFLICT");
  if (lkId === "incomplete") return notProven(lk, lookupRead);
  const byIdRead = { opType: READ.RES_BY_ID, ref: rid };
  const byId = latest(evidence, op, READ.RES_BY_ID, rid);
  if (!byId) return freshRead(byIdRead.opType, byIdRead.ref, "RESERVATION_READ_NEEDED");
  if (byId.kind !== "hostaway_reservation") return notProven(byId, byIdRead);
  const idState = reservationIdentity(byId, intent, rid);
  if (idState === "mismatch") return escalate("RESERVATION_IDENTITY_MISMATCH");
  if (idState === "incomplete" || byId.status !== "found_active") return notProven(byId, byIdRead);
  return ev(st === S.RESERVATION_PENDING ? "RESERVATION_SUCCEEDED" : "RECONCILED_RESERVATION_FOUND", RECOVERY_EVENT_ID.outcome(op.id),
    { reservation: reservationOf(byId, rid) });
}

/** Bounded inconclusive, bound to one evidence row; once used, a NEW read with the ORIGINAL request selector is needed. */
function inconclusive(op, evRow, applied, subject, read) {
  const id = RECOVERY_EVENT_ID.inconclusive(op.id, evRow.id);
  if (applied.has(id)) return freshRead(read.opType, read.ref, "NEWER_READ_NEEDED");
  return ev("RECONCILIATION_INCONCLUSIVE", id, { subject });
}

// ---- Stripe capture ----
function planCapture({ intent, op, evidence, applied, paymentAttemptId, now }) {
  const st = intent.status;
  if (st !== S.RESERVATION_CONFIRMED && st !== S.CAPTURE_UNKNOWN) return none("NOT_AWAITING");
  if (!op.payload || String(op.payload.attempt) !== String(intent.counters.captureAttempts)) return none("STALE_ATTEMPT");
  if (!intent.payment || op.payload.paymentIntentId !== intent.payment.paymentIntentId) return operator("CAPTURE_PAYMENT_INTENT_MISMATCH");
  if (st === S.RESERVATION_CONFIRMED) {
    // errata E3: never RECONCILED_* here; tell E3 the outcome is unknown (sends nothing; E3 schedules the PI read)
    return ev("CAPTURE_OUTCOME_UNKNOWN", RECOVERY_EVENT_ID.unknown(op.id), { code: `RECOVERED_${op.state.toUpperCase()}` });
  }
  const piRead = { opType: READ.PI, ref: intent.payment.paymentIntentId };
  const pi = latest(evidence, op, READ.PI, intent.payment.paymentIntentId);
  if (!pi) return freshRead(READ.PI, intent.payment.paymentIntentId, "PAYMENT_INTENT_READ_NEEDED");
  const settle = op.state === "outcome_unknown" ? pi.id : undefined;
  const id = RECOVERY_EVENT_ID.outcome(op.id);
  if (pi.status === "succeeded") {
    if (!piCapturedProof(pi, intent, paymentAttemptId)) return ev("ESCALATE", id, { code: "CAPTURE_PROOF_MISMATCH" });
    if (op.state === "failed_definite") return ev("ESCALATE", id, { code: "CAPTURE_EVIDENCE_CONTRADICTS_OPERATION" });
    return { ...ev("RECONCILED_CAPTURE_SUCCEEDED", id, { amountMinor: pi.observed.amountReceivedMinor, currency: pi.observed.currency }), settle };
  }
  if (pi.status === "requires_capture") {
    if (!piStillAuthorizedProof(pi, intent, paymentAttemptId)) return ev("ESCALATE", id, { code: "CAPTURE_PROOF_MISMATCH" });
    if (op.state === "succeeded") return ev("ESCALATE", id, { code: "CAPTURE_EVIDENCE_CONTRADICTS_OPERATION" });
    // E7 errata: the stricter internal deadline; E3 itself only checks Stripe's captureBefore
    if (!(now < intent.payment.authorizationDeadline)) return ev("ESCALATE", id, { code: "AUTHORIZATION_DEADLINE_PASSED" });
    return { ...ev("RECONCILED_STILL_AUTHORIZED", id), settle };
  }
  if (pi.status === "canceled") {
    if (!piGoneProof(pi, intent, paymentAttemptId)) return ev("ESCALATE", id, { code: "CAPTURE_PROOF_MISMATCH" });
    if (op.state === "succeeded") return ev("ESCALATE", id, { code: "CAPTURE_EVIDENCE_CONTRADICTS_OPERATION" });
    return { ...ev("RECONCILED_AUTHORIZATION_GONE", id), settle };
  }
  return inconclusive(op, pi, applied, "payment", piRead);
}

// ---- Stripe void ----
function planVoid({ intent, op, evidence, applied, paymentAttemptId }) {
  const st = intent.status;
  if (st !== S.RESERVATION_FAILED && !(st === S.CAPTURE_FAILED && intent.settlement && intent.settlement.authorizationSettled !== true)) return none("NOT_AWAITING");
  if (!intent.payment || op.payload.paymentIntentId !== intent.payment.paymentIntentId) return operator("VOID_PAYMENT_INTENT_MISMATCH");
  const id = RECOVERY_EVENT_ID.outcome(op.id);
  if (op.state === "failed_definite") return ev("VOID_FAILED", id, { code: op.errorCode || "VOID_REFUSED" });
  const piRead = { opType: READ.PI, ref: intent.payment.paymentIntentId };
  const pi = latest(evidence, op, READ.PI, intent.payment.paymentIntentId);
  if (!pi) {
    if (op.state === "outcome_unknown" && !applied.has(RECOVERY_EVENT_ID.unknown(op.id))) return ev("VOID_OUTCOME_UNKNOWN", RECOVERY_EVENT_ID.unknown(op.id));
    return freshRead(READ.PI, intent.payment.paymentIntentId, "PAYMENT_INTENT_READ_NEEDED");
  }
  const settle = op.state === "outcome_unknown" ? pi.id : undefined;
  if (!piIdentityOk(pi, intent, paymentAttemptId)) return ev("ESCALATE", id, { code: "VOID_PROOF_MISMATCH" });
  if (pi.status === "canceled" && piGoneProof(pi, intent, paymentAttemptId)) return { ...ev("VOID_SUCCEEDED", id), settle };
  if (pi.status === "requires_capture" && piStillAuthorizedProof(pi, intent, paymentAttemptId)) {
    if (op.state === "succeeded") return ev("ESCALATE", id, { code: "VOID_EVIDENCE_CONTRADICTS_OPERATION" });
    return { ...ev("RECONCILED_STILL_AUTHORIZED", id), settle };
  }
  if (pi.status === "succeeded") {
    // money was captured: never refund/cancel automatically (E3 escalates CAPTURED_DURING_CANCELLATION in capture_failed)
    if (st === S.CAPTURE_FAILED && piCapturedProof(pi, intent, paymentAttemptId)) {
      return { ...ev("RECONCILED_CAPTURE_SUCCEEDED", id, { amountMinor: pi.observed.amountReceivedMinor, currency: pi.observed.currency }), settle };
    }
    return { ...ev("ESCALATE", id, { code: "CAPTURED_WHILE_VOIDING" }), settle };
  }
  if (["canceled", "requires_capture"].includes(pi.status)) return ev("ESCALATE", id, { code: "VOID_PROOF_MISMATCH" });
  return inconclusive(op, pi, applied, "payment", piRead);
}

// ---- Hostaway cancel ----
function planCancel({ intent, op, evidence, applied }) {
  if (!(intent.status === S.CAPTURE_FAILED && intent.settlement && intent.settlement.reservationCancelled !== true)) return none("NOT_AWAITING");
  const rid = intent.reservation && str(intent.reservation.reservationId);
  if (!rid || str(op.payload.reservationId) !== rid) return operator("CANCEL_RESERVATION_MISMATCH");
  const id = RECOVERY_EVENT_ID.outcome(op.id);
  if (op.state === "failed_definite") return ev("RESERVATION_CANCEL_FAILED", id, { code: op.errorCode || "CANCEL_REFUSED" });
  const read = { opType: READ.RES_BY_ID, ref: rid };
  const r = latest(evidence, op, READ.RES_BY_ID, rid);
  if (!r) {
    if (op.state === "outcome_unknown" && !applied.has(RECOVERY_EVENT_ID.unknown(op.id))) return ev("RESERVATION_CANCEL_OUTCOME_UNKNOWN", RECOVERY_EVENT_ID.unknown(op.id));
    return freshRead(read.opType, read.ref, "RESERVATION_READ_NEEDED");
  }
  // a cancellation (or "still active") is accepted only for the SAME, fully identified reservation
  const idState = r.kind === "hostaway_reservation" ? reservationIdentity(r, intent, rid) : "mismatch";
  if (idState === "mismatch") return ev("ESCALATE", id, { code: "CANCEL_IDENTITY_MISMATCH" });
  if (idState === "incomplete") return inconclusive(op, r, applied, "reservation", read);
  const settle = op.state === "outcome_unknown" ? r.id : undefined;
  if (r.status === "cancelled") return { ...ev("RESERVATION_CANCELLED", id), settle };
  if (r.status === "found_active") {
    if (op.state === "succeeded") return ev("ESCALATE", id, { code: "CANCEL_EVIDENCE_CONTRADICTS_OPERATION" });
    return { ...ev("RECONCILED_RESERVATION_STILL_ACTIVE", id), settle };
  }
  return inconclusive(op, r, applied, "reservation", read);
}

// ---- Hostaway offline-charge recording ----
function planOfflineCharge({ intent, op }) {
  if (intent.status !== S.PAYMENT_CAPTURED) return none("NOT_AWAITING");
  const id = RECOVERY_EVENT_ID.outcome(op.id);
  if (op.state === "succeeded") {
    if (op.resultRef == null || String(op.resultRef) === "") return operator("OFFLINE_CHARGE_ID_MISSING");
    return ev("OFFLINE_CHARGE_RECORDED", id, { chargeId: String(op.resultRef) });
  }
  if (op.state === "failed_definite") return ev("OFFLINE_CHARGE_FAILED", id, { code: op.errorCode || "OFFLINE_CHARGE_REFUSED" });
  return operator("OFFLINE_CHARGE_OUTCOME_UNKNOWN"); // non-idempotent: an owner case is already open; never re-recorded
}
