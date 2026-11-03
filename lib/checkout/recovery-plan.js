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
 * Stripe account the key belongs to. Missing fields stay null: nothing is invented.
 */
export function paymentIntentProofObservation(pi, { accountVerified } = {}) {
  const ch = isObj(pi) && isObj(pi.latest_charge) ? pi.latest_charge : null;
  const md = isObj(pi) && isObj(pi.metadata) ? pi.metadata : {};
  return {
    proofVersion: "pi-proof-v1",
    paymentIntentId: str(pick(pi, "id")),
    accountVerified: accountVerified === true,
    livemode: typeof pick(pi, "livemode") === "boolean" ? pi.livemode : null,
    metadataIntentId: str(md.mv_intent_id),
    metadataAttemptId: str(md.mv_payment_attempt_id),
    captureMethod: str(pick(pi, "capture_method")),
    status: str(pick(pi, "status")),
    amountMinor: int(pick(pi, "amount")),
    amountReceivedMinor: int(pick(pi, "amount_received")),
    amountCapturableMinor: int(pick(pi, "amount_capturable")),
    currency: typeof pick(pi, "currency") === "string" ? pi.currency.toUpperCase() : null,
    latestCharge: ch ? {
      id: str(ch.id),
      paymentIntent: str(typeof ch.payment_intent === "string" ? ch.payment_intent : pick(ch.payment_intent, "id")),
      captured: typeof ch.captured === "boolean" ? ch.captured : null,
      amountCapturedMinor: int(ch.amount_captured),
      amountRefundedMinor: int(ch.amount_refunded),
      livemode: typeof ch.livemode === "boolean" ? ch.livemode : null
    } : null
  };
}

// ---------------------------------------------------------------------------------------------
// proofs (pure predicates over persisted evidence)

/** Same PaymentIntent, verified account, test mode, bound to this intent + payment attempt, manual capture, exact price. */
export function piIdentityOk(ev, intent, paymentAttemptId) {
  const o = ev && ev.observed;
  const pay = intent.payment; const price = intent.price;
  return !!(isObj(o) && pay && price && typeof paymentAttemptId === "string" && paymentAttemptId !== "" &&
    ev.kind === "payment_intent" && ev.externalRef === pay.paymentIntentId && o.paymentIntentId === pay.paymentIntentId &&
    o.status === ev.status && o.accountVerified === true && o.livemode === false &&
    o.metadataIntentId === intent.id && o.metadataAttemptId === paymentAttemptId && o.captureMethod === "manual" &&
    o.amountMinor === price.finalTotalMinor && o.currency === price.currency);
}
/** Errata E6: full captured proof (PaymentIntent + latest Charge). */
export function piCapturedProof(ev, intent, paymentAttemptId) {
  if (!piIdentityOk(ev, intent, paymentAttemptId)) return false;
  const o = ev.observed; const c = o.latestCharge; const total = intent.price.finalTotalMinor;
  return o.status === "succeeded" && o.amountReceivedMinor === total && isObj(c) && c.paymentIntent === intent.payment.paymentIntentId &&
    c.captured === true && c.amountCapturedMinor === total && c.amountRefundedMinor === 0 && c.livemode === false;
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

/** By-id read: found_active, same id, listing/dates/total/currency equal to the intent. Returns the reservation or null. */
export function reservationFromById(ev, intent, rid) {
  const o = ev && ev.observed;
  if (!isObj(o) || ev.kind !== "hostaway_reservation" || ev.readOpType !== READ.RES_BY_ID || ev.status !== "found_active") return null;
  if (ev.externalRef !== rid || str(o.reservationId) !== rid) return null;
  if (!intent.price || o.listingId !== intent.listingId || o.from !== intent.from || o.to !== intent.to) return null;
  if (o.totalMinor !== intent.price.finalTotalMinor || typeof o.currency !== "string" || o.currency.toUpperCase() !== intent.price.currency) return null;
  return { reservationId: rid, listingId: o.listingId, from: o.from, to: o.to, totalMinor: o.totalMinor, currency: o.currency.toUpperCase() };
}
/** By-ref lookup: our booking_ref, exactly one match, returns its reservation id (provider-observed) or null. */
export function lookupMatch(ev, intent) {
  const o = ev && ev.observed;
  if (!isObj(o) || ev.kind !== "hostaway_reservation" || ev.readOpType !== READ.RES_BY_REF || ev.status !== "found_active") return null;
  if (o.bookingRef !== intent.ref || o.matchCount !== 1) return null;
  const rid = str(o.reservationId);
  return rid && rid === ev.externalRef ? rid : null;
}

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
/** Latest fresh API evidence of a read type (+ optional ref); ties broken by id for determinism. */
function latest(evidence, op, readOpType, externalRef = null) {
  const c = evidence.filter((e) => e.readOpType === readOpType && (externalRef == null || e.externalRef === externalRef) && isFresh(e, op));
  c.sort((a, b) => (Number(b.observedAt) - Number(a.observedAt)) || String(b.id).localeCompare(String(a.id)));
  return c[0] || null;
}

/**
 * planRecovery({ intent, op, evidence, appliedEventIds, paymentAttemptId, now, config })
 *   intent           E3 intent (rowToIntent) as persisted NOW
 *   op               { id, opType, state, dispatchedAt(ms), payload, resultRef, errorCode }
 *   evidence         [{ id, kind, readOpType, externalRef, status, observed, observedAt(ms) }] API evidence for this intent
 *   appliedEventIds  ids already applied for this intent (Set or array)
 *   paymentAttemptId the completed payment attempt bound to intent.payment.paymentIntentId (or null)
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
function planCreate({ intent, op, evidence, applied }) {
  const st = intent.status;
  if (st !== S.RESERVATION_PENDING && st !== S.RESERVATION_UNKNOWN) return none("NOT_AWAITING");
  if (st === S.RESERVATION_PENDING && !intent.dispatch) return none("NOT_DISPATCHED");
  if (st === S.RESERVATION_PENDING) {
    if (op.state === "outcome_unknown") return ev("RESERVATION_OUTCOME_UNKNOWN", RECOVERY_EVENT_ID.unknown(op.id), { code: "RECOVERED_OUTCOME_UNKNOWN" });
    if (op.state === "failed_definite") return ev("RESERVATION_FAILED", RECOVERY_EVENT_ID.outcome(op.id), { definite: true, code: op.errorCode || "RESERVATION_REFUSED" });
  }
  // succeeded (pending) or any state (unknown): only fresh by-ref + by-id proof establishes the reservation
  const lk = latest(evidence, op, READ.RES_BY_REF);
  if (!lk) return freshRead(READ.RES_BY_REF, intent.ref, "LOOKUP_NEEDED");
  const rid = lookupMatch(lk, intent);
  const notProven = () => (st === S.RESERVATION_PENDING
    ? ev("RESERVATION_OUTCOME_UNKNOWN", RECOVERY_EVENT_ID.unknown(op.id), { code: "RESERVATION_NOT_PROVEN" })
    : inconclusive(op, lk, applied, "reservation"));
  if (!rid) {
    if (isObj(lk.observed) && lk.observed.bookingRef === intent.ref && Number.isInteger(lk.observed.matchCount) && lk.observed.matchCount > 1) {
      return ev("ESCALATE", RECOVERY_EVENT_ID.outcome(op.id), { code: "DUPLICATE_BOOKING_REF" });
    }
    return notProven();
  }
  const byId = latest(evidence, op, READ.RES_BY_ID, rid);
  if (!byId) return freshRead(READ.RES_BY_ID, rid, "RESERVATION_READ_NEEDED");
  const res = reservationFromById(byId, intent, rid);
  if (!res) {
    if (byId.status === "found_active") return ev("ESCALATE", RECOVERY_EVENT_ID.outcome(op.id), { code: "RESERVATION_IDENTITY_MISMATCH" });
    return notProven();
  }
  return ev(st === S.RESERVATION_PENDING ? "RESERVATION_SUCCEEDED" : "RECONCILED_RESERVATION_FOUND", RECOVERY_EVENT_ID.outcome(op.id), { reservation: res });
}

function inconclusive(op, evRow, applied, subject) {
  const id = RECOVERY_EVENT_ID.inconclusive(op.id, evRow.id);
  if (applied.has(id)) return freshRead(evRow.readOpType, evRow.externalRef, "NEWER_READ_NEEDED");
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
  return inconclusive(op, pi, applied, "payment");
}

// ---- Stripe void ----
function planVoid({ intent, op, evidence, applied, paymentAttemptId }) {
  const st = intent.status;
  if (st !== S.RESERVATION_FAILED && !(st === S.CAPTURE_FAILED && intent.settlement && intent.settlement.authorizationSettled !== true)) return none("NOT_AWAITING");
  if (!intent.payment || op.payload.paymentIntentId !== intent.payment.paymentIntentId) return operator("VOID_PAYMENT_INTENT_MISMATCH");
  const id = RECOVERY_EVENT_ID.outcome(op.id);
  if (op.state === "failed_definite") return ev("VOID_FAILED", id, { code: op.errorCode || "VOID_REFUSED" });
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
  return inconclusive(op, pi, applied, "payment");
}

// ---- Hostaway cancel ----
function planCancel({ intent, op, evidence, applied }) {
  if (!(intent.status === S.CAPTURE_FAILED && intent.settlement && intent.settlement.reservationCancelled !== true)) return none("NOT_AWAITING");
  const rid = intent.reservation && str(intent.reservation.reservationId);
  if (!rid || str(op.payload.reservationId) !== rid) return operator("CANCEL_RESERVATION_MISMATCH");
  const id = RECOVERY_EVENT_ID.outcome(op.id);
  if (op.state === "failed_definite") return ev("RESERVATION_CANCEL_FAILED", id, { code: op.errorCode || "CANCEL_REFUSED" });
  const r = latest(evidence, op, READ.RES_BY_ID, rid);
  if (!r) {
    if (op.state === "outcome_unknown" && !applied.has(RECOVERY_EVENT_ID.unknown(op.id))) return ev("RESERVATION_CANCEL_OUTCOME_UNKNOWN", RECOVERY_EVENT_ID.unknown(op.id));
    return freshRead(READ.RES_BY_ID, rid, "RESERVATION_READ_NEEDED");
  }
  const settle = op.state === "outcome_unknown" ? r.id : undefined;
  if (r.status === "cancelled") return { ...ev("RESERVATION_CANCELLED", id), settle };
  if (r.status === "found_active") {
    if (op.state === "succeeded") return ev("ESCALATE", id, { code: "CANCEL_EVIDENCE_CONTRADICTS_OPERATION" });
    return { ...ev("RECONCILED_RESERVATION_STILL_ACTIVE", id), settle };
  }
  return inconclusive(op, r, applied, "reservation");
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
