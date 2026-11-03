// lib/booking-db/capture-worker.js — Stage E7.3b (offline). Bounded single-step CAPTURE-PHASE worker.
//
// INTERNAL LIBRARY ONLY: no route, cron, frontend, SDK client, network adapter or default provider function. Every provider
// call goes through an INJECTED executor; with none injected nothing is claimed or sent. Contract:
// claude/e7-capture-worker-contract.md (§11 supersedes the earlier automatic-retry proposal).
//
// Scope: reservation_confirmed -> payment_captured, and capture_unknown -> reconciled outcome or a durable owner case.
// Provider calls (injected; exactly these keys): retrieveAccount, retrievePaymentIntent (latest_charge expanded),
// capturePaymentIntent (ONE initial full capture per intent), retrieveReservation and lookupPage (Hostaway READS only).
// Never executed here: void, cancel, refund, offline-charge recording, notifications, reservation create; capture_failed is
// out of scope. Claims are restricted to CAPTURE_WORKER_OP_TYPES; maintenance / recovery / orphan / work claims are scoped in
// SQL (before every LIMIT) to the configured listings, the capture-phase states / op types and an optional intent.
//
// Rules (root E7.3b brief):
//   * ONLY the initial capture: attempt 1, the single capture row of the intent, pending and never dispatched, the completed
//     payment attempt bound to the PaymentIntent. Proofs come only from executed READ rows persisted as immutable evidence:
//     fresh (<= PRE_SEND_FRESH_MS, after the reservation confirmation, never in the future) v3 PaymentIntent evidence taken
//     after an exact test-account check, and a fresh Hostaway reservation read with the full identity INCLUDING the booking
//     ref (by id; by ref as fallback when the ref is not echoed). Protected historical reservation ids are refused.
//   * The request is built with the accepted E7.3a pre-claim eligibility + builder BEFORE the claim; the exact row is then
//     claimed (0007 fence) and IMMEDIATELY before the send every current fact is re-read and re-checked with a clock read
//     AFTER those reads; no await between that decision and the start of the bounded call.
//   * A capture reply is never enough: a positive-looking reply leads to ONE confirming expanded PaymentIntent READ; only
//     that persisted evidence with the full accepted captured proof completes the row and applies CAPTURE_SUCCEEDED (amount /
//     currency from the proof), fenced in-transaction. Everything else -> outcome_unknown + CAPTURE_OUTCOME_UNKNOWN.
//   * Late callbacks are late evidence only. capture_unknown is reconciled by reads >= dispatch + 2 min through the accepted
//     planner, except that RECONCILED_STILL_AUTHORIZED is INTERCEPTED: an unresolved original capture that still looks
//     authorized becomes a durable owner case — never a new capture row, new key or same-key resend.
import { applyEvent, loadIntent, RepoError } from "./repo.js";
import { claimNextOperation, completeOperation, recordProviderEvidence, recoverExpiredOperations, requestRead } from "./operations.js";
import { assertEnvironment } from "./pool.js";
import {
  findMissedOutcomes, loadRecoveryFacts, requestRecoveryRead, findOrphanReads, reissueOrphanRead, applyRecoveryPlan
} from "./recovery.js";
import { _internal as RW, isProtectedReservationId, ProviderCallTimeout, PROTECTED_HOSTAWAY_RESERVATION_IDS } from "./reservation-worker.js";
import { planRecovery, piCapturedProof, reservationIdentity, FRESH_AFTER_DISPATCH_MS, RECOVERY_EVENT_ID } from "../checkout/recovery-plan.js";
import { paymentIntentProofObservationV3, initialCaptureSendEligibility, buildCaptureRequest, validateCaptureRequest } from "../checkout/capture-proof.js";
import { STATES as S } from "../checkout/intent-state.js";
import { validateAdapterConfig, unwrapEnvelope, normalizeReservation, lookupByRef } from "../hostaway-reservations.js";

export const CAPTURE_WORKER_VERSION = "e7-capture-worker-v1";
export const OPS = Object.freeze({ CAPTURE: "stripe.capture_payment_intent", PI_READ: "stripe.retrieve_payment_intent",
  RES_READ: "hostaway.retrieve_reservation", LOOKUP: "hostaway.lookup_reservation" });
export const CAPTURE_WORKER_OP_TYPES = Object.freeze(Object.values(OPS));
export const READ_OP_TYPES = Object.freeze([OPS.PI_READ, OPS.RES_READ, OPS.LOOKUP]);
export const CAPTURE_EXECUTOR_KEYS = Object.freeze(["retrieveAccount", "retrievePaymentIntent", "capturePaymentIntent", "retrieveReservation", "lookupPage"]);
export const WORK_STATES = Object.freeze([S.RESERVATION_CONFIRMED, S.CAPTURE_UNKNOWN]);
// The only reservation status accepted as "active" for a capture precondition: "new" (= ACCEPTED_CREATE_STATUSES, the verified
// pilot status). "modified" and every other documented status fail closed (owner case) until separately reviewed.
export const ACTIVE_RESERVATION_STATUSES = Object.freeze(["new"]);
export const CAPTURE_DEFAULT_TIMEOUTS = Object.freeze({ readCallMs: 10000, captureCallMs: 20000, stepBudgetMs: 45000 });
export const CAPTURE_LIMITS = Object.freeze({
  workLeaseMs: 60 * 1000, sendMarginMs: 15 * 1000, waitMs: 30 * 1000, preSendFreshMs: 5 * 60 * 1000,
  maxPreCaptureReadsPerType: 6, recoveryBatch: 10, maintenanceBatch: 20
});
const ACCT_RE = /^acct_[A-Za-z0-9]{1,64}$/;
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const result = (status, extra = {}) => Object.freeze({ status, ...extra });
const ms = (d) => (d == null ? Number.NaN : new Date(d).getTime());

function resolveTimeouts(t) {
  const out = {};
  for (const [k, d] of Object.entries(CAPTURE_DEFAULT_TIMEOUTS)) {
    const v = t !== null && typeof t === "object" ? t[k] : undefined;
    out[k] = Number.isFinite(v) && v > 0 ? Math.min(v, d) : d;
  }
  return Object.freeze(out);
}

// ---------------------------------------------------------------------------------------------
// gate (pure; nothing touched before it passes)

export function captureWorkerGate({ env, adapterConfig, listings, executors, clock, stripeAccountId } = {}) {
  const e = isObj(env) ? env : null;
  if (!e) return { ok: false, code: "ENV_REQUIRED" };
  if (e.VERCEL_ENV === "production") return { ok: false, code: "PRODUCTION_REFUSED" };
  if (e.VERCEL_ENV !== "development" && e.VERCEL_ENV !== "preview") return { ok: false, code: "ENVIRONMENT_NOT_ALLOWED" };
  if (e.MV_E7_CAPTURE_WORKER !== "enabled") return { ok: false, code: "NOT_ENABLED" };
  if (typeof stripeAccountId !== "string" || !ACCT_RE.test(stripeAccountId)) return { ok: false, code: "STRIPE_ACCOUNT_REQUIRED" };
  let cfg;
  try { cfg = validateAdapterConfig(adapterConfig); } catch { return { ok: false, code: "ADAPTER_CONFIG_INVALID" }; }
  if (!(listings instanceof Map) || listings.size === 0) return { ok: false, code: "LISTINGS_REQUIRED" };
  for (const [id, lc] of listings) {
    if (!cfg.allowedListingIds.includes(id) || !isObj(lc) || lc.currency !== cfg.currency) return { ok: false, code: "LISTING_NOT_ALLOWLISTED" };
  }
  if (!isObj(executors)) return { ok: false, code: "NO_EXECUTORS" };
  for (const k of Object.keys(executors)) if (!CAPTURE_EXECUTOR_KEYS.includes(k)) return { ok: false, code: "EXECUTOR_NOT_ALLOWED" };
  for (const k of CAPTURE_EXECUTOR_KEYS) if (typeof executors[k] !== "function") return { ok: false, code: "NO_EXECUTORS" };
  if (typeof clock !== "function" || !Number.isFinite(clock())) return { ok: false, code: "CLOCK_REQUIRED" };
  return { ok: true, cfg };
}

// ---------------------------------------------------------------------------------------------
// small helpers

class Escalate extends Error { constructor(code) { super(code); this.code = code; } }
const sanitize = (code) => (/^[A-Z0-9_]{1,64}$/.test(code) ? code : "CAPTURE_WORKER_OPERATOR_REQUIRED");

/** applyEvent fenced on this worker's work lease AND caller-supplied in-transaction checks (intent row locked first). */
async function applyChecked(ctx, intentId, event, check = null) {
  try {
    return await applyEvent(ctx.pool, intentId, event, {
      now: ctx.clock(), actor: "worker", workerId: ctx.workerId,
      inTx: async (c, info) => {
        const w = (await c.query("SELECT work_worker_id, work_lease_until FROM booking.intent_work WHERE intent_id = $1 FOR SHARE", [intentId])).rows[0];
        if (!w || w.work_worker_id !== ctx.workerId || !(ms(w.work_lease_until) >= ctx.clock())) throw new RepoError("WORK_LEASE_LOST");
        if (check) await check(c, info);
      }
    });
  } catch (e) {
    if (e instanceof RepoError && /^[A-Z_]+$/.test(e.code)) return { ok: false, error: e.code };
    throw e;
  }
}
/** In-transaction scope fence: the intent is still exactly the PLANNED version and state, in a capture-phase state, on a
 *  configured listing (and the scoped intent, if any). Anything else = another actor moved it: STALE_OUT_OF_SCOPE. */
function scopeFence(ctx, planned) {
  return (before) => {
    if (before.version !== planned.version || before.status !== planned.status || !WORK_STATES.includes(before.status)
      || !ctx.listings.has(before.listingId) || (ctx.scopeIntentId && before.id !== ctx.scopeIntentId)) throw new RepoError("STALE_OUT_OF_SCOPE");
  };
}
/** ESCALATE fenced on the work lease AND the planned version/state/scope: never escalates a state another actor reached. */
async function escalate(ctx, intent, code) {
  const c = sanitize(code);
  const fence = scopeFence(ctx, intent);
  const r = await applyChecked(ctx, intent.id, { type: "ESCALATE", id: `cw-escalate:${intent.id}:${c}:v${intent.version}`, code: c },
    async (_c, { before }) => fence(before));
  ctx.actions.push(r.ok ? `ESCALATE:${c}` : `ESCALATE!${r.error}`);
  return { delayMs: 0 };
}
/** Recovery-pass operator escalation (same event id as the shared escalateOperatorPlan), fenced in-transaction on the facts'
 *  intent version/state/scope and the operation still being in the state the plan was derived from. */
async function escalateRecovery(ctx, facts, code) {
  const safe = /^[A-Z0-9_:]{1,64}$/.test(code) ? code.replace(/:/g, "_") : "RECOVERY_OPERATOR_REQUIRED";
  const fence = scopeFence(ctx, facts.intent);
  if (ctx.hooks.beforeRecoveryEscalate) await ctx.hooks.beforeRecoveryEscalate(facts, safe);
  let r;
  try {
    r = await applyEvent(ctx.pool, facts.intent.id, { type: "ESCALATE", id: RECOVERY_EVENT_ID.outcome(facts.op.id), code: safe }, {
      now: ctx.clock(), actor: "reconciler",
      inTx: async (c, { before }) => {
        fence(before);
        const o = (await c.query("SELECT state FROM booking.external_operations WHERE id = $1 FOR SHARE", [facts.op.id])).rows[0];
        if (!o || o.state !== facts.op.state) throw new RepoError("STALE_OUT_OF_SCOPE");
      }
    });
  } catch (e) {
    if (!(e instanceof RepoError && e.code === "STALE_OUT_OF_SCOPE")) throw e;
    r = { ok: false, error: "STALE_OUT_OF_SCOPE" };
  }
  // r.duplicate: the deterministic op-outcome id was already applied (by another actor's outcome) — no effect, no fence ran
  ctx.actions.push(!r.ok ? `RECOVERY:ESCALATE!${r.error}` : r.duplicate ? `RECOVERY:ESCALATE:DUPLICATE_EVENT_ID` : `RECOVERY:ESCALATE:${safe}`);
  return r;
}

const opRow = async (q, opId) => (await q.query("SELECT * FROM booking.external_operations WHERE id = $1", [opId])).rows[0] || null;
const captureRows = async (q, intentId) => (await q.query(
  "SELECT * FROM booking.external_operations WHERE intent_id = $1 AND op_type = $2 ORDER BY created_at, id", [intentId, OPS.CAPTURE])).rows;
const asCaptureOp = (r) => ({ id: r.id, opType: r.op_type, state: r.state, dispatchedAt: r.dispatched_at == null ? null : ms(r.dispatched_at), payload: r.payload });

/** The single completed payment attempt bound to the PaymentIntent (from the database), else null. */
async function boundPaymentAttempt(q, intent) {
  const r = await q.query("SELECT id FROM booking.payment_attempts WHERE intent_id = $1 AND payment_intent_id = $2 AND status = 'completed'",
    [intent.id, intent.payment.paymentIntentId]);
  return r.rowCount === 1 ? r.rows[0].id : null;
}

/** Persisted API evidence of one read type and request selector (latest first), with its read row. */
async function evidenceRows(q, intentId, readOpType, requestRef) {
  const r = await q.query(
    `SELECT e.id, e.kind, e.external_ref, e.status, e.observed, e.observed_at, r.op_type AS read_op_type,
            coalesce(r.payload ->> 'paymentIntentId', r.payload ->> 'reservationId', r.payload ->> 'ref') AS request_ref, r.id AS read_op_id
       FROM booking.provider_evidence e JOIN booking.external_operations r ON r.id = e.read_operation_id
      WHERE e.intent_id = $1 AND e.source IN ('stripe_api', 'hostaway_api') AND r.op_type = $2
        AND coalesce(r.payload ->> 'paymentIntentId', r.payload ->> 'reservationId', r.payload ->> 'ref') = $3
      ORDER BY e.observed_at DESC, e.id DESC LIMIT 5`, [intentId, readOpType, requestRef]);
  return r.rows.map((e) => ({ id: e.id, kind: e.kind, readOpType: e.read_op_type, requestRef: e.request_ref, externalRef: e.external_ref,
    status: e.status, observed: e.observed, observedAt: ms(e.observed_at), readOpId: e.read_op_id }));
}
/** Fresh = observed after the reservation confirmation, not in the future, and no older than preSendFreshMs. */
const isFresh = (ev, intent, now) => Number.isFinite(ev.observedAt) && ev.observedAt >= intent.reservation.confirmedAt && ev.observedAt <= now
  && now - ev.observedAt <= CAPTURE_LIMITS.preSendFreshMs;

// ---------------------------------------------------------------------------------------------
// executed READS (bounded; results persisted as immutable API evidence)

const observedReservation = RW.observedReservation;

/** Queue (or reuse an open) read of this type + selector, claim exactly it, and return the claimed row (or null). */
async function claimRead(ctx, intent, opType, selector) {
  const field = opType === OPS.PI_READ ? "paymentIntentId" : opType === OPS.RES_READ ? "reservationId" : "ref";
  let open = (await ctx.pool.query(
    `SELECT id, state FROM booking.external_operations WHERE intent_id = $1 AND op_type = $2 AND retry_class = 'read'
        AND state IN ('pending', 'in_flight') AND payload ->> $3 = $4 ORDER BY created_at LIMIT 1`, [intent.id, opType, field, selector])).rows[0];
  // bounded: every EXECUTION attempt of this read type since the reservation confirmation counts (retried rows included)
  const used = Number((await ctx.pool.query(
    `SELECT coalesce(sum(attempts), 0) AS n FROM booking.external_operations WHERE intent_id = $1 AND op_type = $2 AND retry_class = 'read' AND created_at >= $3`,
    [intent.id, opType, new Date(intent.reservation.confirmedAt)])).rows[0].n);
  if (used >= CAPTURE_LIMITS.maxPreCaptureReadsPerType) throw new Escalate("PRE_CAPTURE_READS_EXHAUSTED");
  if (!open) {
    await requestRead(ctx.pool, intent.id, opType, selector, { now: ctx.clock() });
    open = (await ctx.pool.query(
      `SELECT id, state FROM booking.external_operations WHERE intent_id = $1 AND op_type = $2 AND retry_class = 'read'
          AND state = 'pending' AND payload ->> $3 = $4 ORDER BY created_at LIMIT 1`, [intent.id, opType, field, selector])).rows[0];
  }
  if (!open || open.state !== "pending") return null;
  return claimNextOperation(ctx.pool, { workerId: ctx.workerId, now: ctx.clock(), opId: open.id, opTypes: [opType] });
}
const finishRead = (ctx, op, status, errorCode) => completeOperation(ctx.pool, op.id, { workerId: ctx.workerId, now: ctx.clock(),
  outcome: { status, ...(errorCode ? { errorCode } : {}) } });

/** Exact test-account check (once per step); a failure is a durable refusal, never a guess. */
async function verifyAccount(ctx) {
  if (ctx.accountVerified) return true;
  let a;
  try { a = await RW.startBounded(ctx, "readCallMs", (signal) => ctx.executors.retrieveAccount({ signal })).promise; } catch { return false; }
  ctx.calls.push("account");
  if (!isObj(a) || a.object !== "account" || a.id !== ctx.stripeAccountId) throw new Escalate("STRIPE_ACCOUNT_MISMATCH");
  ctx.accountVerified = true;
  return true;
}

/** One executed PaymentIntent read (latest_charge expanded) -> v3 evidence. -> { ok, evidenceId } | { ok:false, code } */
async function readPaymentIntent(ctx, intent, { reuseClaimed = null } = {}) {
  const pi = intent.payment.paymentIntentId;
  const op = reuseClaimed || await claimRead(ctx, intent, OPS.PI_READ, pi);
  if (!op) return { ok: false, code: "PI_READ_NOT_CLAIMED" };
  let acct;
  try { acct = await verifyAccount(ctx); } catch (e) { await finishRead(ctx, op, "outcome_unknown", "ACCOUNT_NOT_VERIFIED"); throw e; }
  if (!acct) { await finishRead(ctx, op, "outcome_unknown", "ACCOUNT_READ_FAILED"); return { ok: false, code: "ACCOUNT_READ_FAILED" }; }
  let obj;
  try { obj = await RW.startBounded(ctx, "readCallMs", (signal) => ctx.executors.retrievePaymentIntent(pi, { expand: ["latest_charge"] }, { signal })).promise; }
  catch { await finishRead(ctx, op, "outcome_unknown", "PI_READ_FAILED"); return { ok: false, code: "PI_READ_FAILED" }; }
  ctx.calls.push(`pi_read:${pi}`);
  if (!isObj(obj) || obj.object !== "payment_intent" || obj.id !== pi || typeof obj.status !== "string") {
    await finishRead(ctx, op, "outcome_unknown", "PI_READ_UNUSABLE"); return { ok: false, code: "PI_READ_UNUSABLE" };
  }
  const done = await finishRead(ctx, op, "succeeded");
  if (!done.ok) return { ok: false, code: "LEASE_LOST" };
  const rec = await recordProviderEvidence(ctx.pool, { readOpId: op.id, kind: "payment_intent", externalRef: pi, status: obj.status,
    observed: paymentIntentProofObservationV3(obj, { accountVerified: ctx.accountVerified === true }) });
  return rec.ok ? { ok: true, evidenceId: rec.id } : { ok: false, code: "EVIDENCE_NOT_RECORDED" };
}

/** One executed Hostaway by-id read -> evidence. */
async function readReservationById(ctx, intent, rid) {
  const op = await claimRead(ctx, intent, OPS.RES_READ, rid);
  if (!op) return { ok: false, code: "RESERVATION_READ_NOT_CLAIMED" };
  const req = Object.freeze({ method: "GET", path: `/reservations/${rid}`, query: {} });
  let resp;
  try { resp = await RW.startBounded(ctx, "readCallMs", (signal) => ctx.executors.retrieveReservation(req, { signal })).promise; }
  catch { resp = null; }
  ctx.calls.push(`res_read:${rid}`);
  if (isObj(resp) && resp.httpStatus === 404) {
    const d = await finishRead(ctx, op, "succeeded");
    if (!d.ok) return { ok: false, code: "LEASE_LOST" };
    await recordProviderEvidence(ctx.pool, { readOpId: op.id, kind: "hostaway_reservation", externalRef: rid, status: "not_found", observed: {} });
    return { ok: true };
  }
  const env = isObj(resp) && resp.httpStatus === 200 ? unwrapEnvelope(resp.json) : { ok: false };
  const n = env.ok ? normalizeReservation(env.result, ctx.cfg) : { ok: false };
  if (!n.ok) { await finishRead(ctx, op, "outcome_unknown", "RESERVATION_READ_UNUSABLE"); return { ok: false, code: "RESERVATION_READ_UNUSABLE" }; }
  if (String(n.reservation.reservationId) !== rid) { await finishRead(ctx, op, "succeeded"); throw new Escalate("RESERVATION_READ_CONTRADICTS_REQUEST"); }
  const d = await finishRead(ctx, op, "succeeded");
  if (!d.ok) return { ok: false, code: "LEASE_LOST" };
  const r = n.reservation;
  const rec = await recordProviderEvidence(ctx.pool, { readOpId: op.id, kind: "hostaway_reservation", externalRef: rid,
    status: r.status === "cancelled" ? "cancelled" : "found_active", observed: observedReservation(r) });
  return rec.ok ? { ok: true } : { ok: false, code: "EVIDENCE_NOT_RECORDED" };
}

/** One executed Hostaway by-ref lookup -> evidence (fallback when the by-id read does not echo the booking ref). */
async function readReservationByRef(ctx, intent) {
  const op = await claimRead(ctx, intent, OPS.LOOKUP, intent.ref);
  if (!op) return { ok: false, code: "LOOKUP_NOT_CLAIMED" };
  let lk;
  try {
    lk = await lookupByRef({ ref: intent.ref, listingId: intent.listingId, arrivalDate: intent.from, departureDate: intent.to }, ctx.cfg,
      (req) => RW.startBounded(ctx, "readCallMs", (signal) => ctx.executors.lookupPage(req, { signal })).promise);
  } catch { lk = { outcome: "error" }; }
  ctx.calls.push(`lookup:${intent.ref}`);
  if (lk.outcome === "found" || lk.outcome === "not_found") {
    const d = await finishRead(ctx, op, "succeeded");
    if (!d.ok) return { ok: false, code: "LEASE_LOST" };
    const r = lk.reservation;
    const ev = lk.outcome === "found"
      ? { externalRef: String(r.reservationId), status: r.status === "cancelled" ? "cancelled" : "found_active",
        observed: { bookingRef: intent.ref, matchCount: 1, ...observedReservation(r) } }
      : { externalRef: intent.ref, status: "not_found", observed: { bookingRef: intent.ref, matchCount: 0 } };
    const rec = await recordProviderEvidence(ctx.pool, { readOpId: op.id, kind: "hostaway_reservation", ...ev });
    return rec.ok ? { ok: true } : { ok: false, code: "EVIDENCE_NOT_RECORDED" };
  }
  if (lk.outcome === "conflict") { await finishRead(ctx, op, "succeeded"); throw new Escalate(lk.code === "DUPLICATE_REF" ? "DUPLICATE_BOOKING_REF" : "LOOKUP_CONTRADICTS_STAY"); }
  await finishRead(ctx, op, "outcome_unknown", "LOOKUP_INCONCLUSIVE");
  return { ok: false, code: "LOOKUP_INCONCLUSIVE" };
}

// ---------------------------------------------------------------------------------------------
// reservation proof (fresh, full identity incl. ref; protected ids refused)

const activeById = (ev, intent, rid) => ev.kind === "hostaway_reservation" && ev.status === "found_active" && reservationIdentity(ev, intent, rid) === "ok"
  && isObj(ev.observed) && ACTIVE_RESERVATION_STATUSES.includes(ev.observed.status);
function contradiction(ev, intent, rid) {
  if (ev.kind !== "hostaway_reservation") return true;
  if (ev.status === "cancelled" || ev.status === "not_found") return true;
  if (reservationIdentity(ev, intent, rid) === "mismatch") return true;
  if (isObj(ev.observed) && ev.observed.bookingRef != null && ev.observed.bookingRef !== intent.ref) return true;
  return isObj(ev.observed) && typeof ev.observed.status === "string" && !ACTIVE_RESERVATION_STATUSES.includes(ev.observed.status);
}

/** -> { ok:true, evidenceIds } | { ok:false, read: "by_id" | "by_ref" } (a fresh read is needed) ; throws Escalate on contradiction */
async function reservationProof(ctx, intent, now) {
  const rid = String(intent.reservation.reservationId);
  const byId = (await evidenceRows(ctx.pool, intent.id, OPS.RES_READ, rid)).find((e) => isFresh(e, intent, now));
  if (!byId) return { ok: false, read: "by_id" };
  if (contradiction(byId, intent, rid)) throw new Escalate("RESERVATION_PROOF_CONTRADICTION");
  if (!activeById(byId, intent, rid)) throw new Escalate("RESERVATION_PROOF_INCOMPLETE");
  if (isProtectedReservationId(byId.externalRef) || isProtectedReservationId(byId.observed.reservationId)) throw new Escalate("PROTECTED_RESERVATION_ID");
  if (byId.observed.bookingRef === intent.ref) return { ok: true, evidenceIds: [byId.id] };
  // the by-id read did not echo the ref: a fresh by-ref lookup must return exactly this reservation with the full identity
  const lk = (await evidenceRows(ctx.pool, intent.id, OPS.LOOKUP, intent.ref)).find((e) => isFresh(e, intent, now));
  if (!lk) return { ok: false, read: "by_ref" };
  const o = lk.observed || {};
  if (lk.status !== "found_active" || o.bookingRef !== intent.ref || o.matchCount !== 1) throw new Escalate("RESERVATION_REF_NOT_PROVEN");
  if (reservationIdentity(lk, intent, rid) !== "ok" || !ACTIVE_RESERVATION_STATUSES.includes(o.status)) throw new Escalate("RESERVATION_REF_NOT_PROVEN");
  if (isProtectedReservationId(lk.externalRef) || isProtectedReservationId(o.reservationId)) throw new Escalate("PROTECTED_RESERVATION_ID");
  return { ok: true, evidenceIds: [byId.id, lk.id] };
}

// ---------------------------------------------------------------------------------------------
// reservation_confirmed: the single initial capture

async function handleReservationConfirmed(ctx, intent) {
  const rows = await captureRows(ctx.pool, intent.id);
  const current = rows.find((r) => r.payload && r.payload.attempt === intent.counters.captureAttempts);
  if (!current) return escalate(ctx, intent, "CAPTURE_ROW_MISSING");
  if (current.state !== "pending") { ctx.actions.push(`WAIT:CAPTURE_${current.state.toUpperCase()}`); return { delayMs: CAPTURE_LIMITS.waitMs }; }  // recovery handles it
  if (intent.counters.captureAttempts !== 1 || rows.length !== 1) return escalate(ctx, intent, "CAPTURE_NOT_INITIAL");
  if (!intent.reservation || isProtectedReservationId(intent.reservation.reservationId)) return escalate(ctx, intent, "PROTECTED_RESERVATION_ID");
  const need = ctx.timeouts.captureCallMs + CAPTURE_LIMITS.sendMarginMs;
  if (!(intent.payment.authorizationDeadline - ctx.clock() > need)) return escalate(ctx, intent, "AUTHORIZATION_DEADLINE_PASSED");
  const paymentAttemptId = await boundPaymentAttempt(ctx.pool, intent);
  if (!paymentAttemptId) return escalate(ctx, intent, "PAYMENT_ATTEMPT_NOT_BOUND");
  try {
    // 1. fresh reservation proof (executed reads only)
    let rp = await reservationProof(ctx, intent, ctx.clock());
    for (let k = 0; !rp.ok && k < 2; k++) {
      const x = rp.read === "by_id" ? await readReservationById(ctx, intent, String(intent.reservation.reservationId)) : await readReservationByRef(ctx, intent);
      if (!x.ok) { ctx.actions.push(`WAIT:${x.code}`); return { delayMs: CAPTURE_LIMITS.waitMs }; }
      rp = await reservationProof(ctx, intent, ctx.clock());
    }
    if (!rp.ok) { ctx.actions.push("WAIT:RESERVATION_PROOF"); return { delayMs: CAPTURE_LIMITS.waitMs }; }
    // 2. fresh v3 PaymentIntent evidence after the exact test-account check (always read in THIS step)
    const pr = await readPaymentIntent(ctx, intent);
    if (!pr.ok) { ctx.actions.push(`WAIT:${pr.code}`); return { delayMs: CAPTURE_LIMITS.waitMs }; }
    const piEv = (await evidenceRows(ctx.pool, intent.id, OPS.PI_READ, intent.payment.paymentIntentId)).find((e) => e.id === pr.evidenceId);
    if (!piEv || !isFresh(piEv, intent, ctx.clock())) { ctx.actions.push("WAIT:PI_EVIDENCE_NOT_FRESH"); return { delayMs: CAPTURE_LIMITS.waitMs }; }
    // 3. accepted pre-claim eligibility + builder on CURRENT inputs
    const fresh = await loadIntent(ctx.pool, intent.id);
    const histNow = (await captureRows(ctx.pool, intent.id)).map(asCaptureOp);
    const opNow = histNow.find((o) => o.id === current.id);
    const eligibility = initialCaptureSendEligibility({ evidence: piEv, intent: fresh, paymentAttemptId, captureOp: opNow, captureHistory: histNow });
    if (!eligibility.ok) return escalate(ctx, intent, `PRE_CAPTURE_${eligibility.code}`);   // fenced on the version planned at entry
    const built = buildCaptureRequest({ intent: fresh, captureOp: opNow, eligibility, paymentAttemptId });
    if (!built.ok) return escalate(ctx, intent, `PRE_CAPTURE_${built.code}`);
    // what was PROVEN (bound to the eligibility snapshot); re-compared against CURRENT rows immediately before the send
    const plan0 = Object.freeze({ paymentAttemptId, evidenceIds: Object.freeze([...rp.evidenceIds, piEv.id]), eligibility, request: built.request,
      reservation: Object.freeze({ reservationId: String(fresh.reservation.reservationId), listingId: fresh.listingId, from: fresh.from, to: fresh.to }) });
    if (ctx.hooks.beforeClaim) await ctx.hooks.beforeClaim();
    if (!(fresh.payment.authorizationDeadline - ctx.clock() > need)) return escalate(ctx, intent, "AUTHORIZATION_DEADLINE_PASSED");
    // 4. claim exactly this row (0007 fence: reservation_confirmed + current attempt); from here it is possibly sent
    const op = await claimNextOperation(ctx.pool, { workerId: ctx.workerId, now: ctx.clock(), opId: current.id, opTypes: [OPS.CAPTURE] });
    if (!op) { ctx.actions.push("WAIT:CAPTURE_NOT_CLAIMED"); return { delayMs: CAPTURE_LIMITS.waitMs }; }
    ctx.actions.push("CAPTURE_CLAIMED");
    if (ctx.hooks.afterClaim) await ctx.hooks.afterClaim(op, plan0);
    return sendCapture(ctx, fresh, op, plan0);
  } catch (e) {
    if (e instanceof Escalate) return escalate(ctx, intent, e.code);   // never re-planned on a reloaded (possibly moved) intent
    throw e;
  }
}

/**
 * Immediately before the send: re-read the CURRENT op, work lease, intent, payment attempt and evidence; read the clock AFTER
 * those reads; require room for the WHOLE bounded call (+ margin) on the op lease, the work lease and the deadline, and the
 * step budget; compare every proof-relevant CURRENT value with the eligibility snapshot and the proven reservation binding, and
 * validate the fixed request against the CURRENT intent + CURRENT row (E7.3a validator; the row is used as it is, in flight).
 * -> null (send) | refusal code
 * DB invariants that already forbid some of these changes (0001 booking.intents guard): price / currency / quote immutable after
 * PRICE_CONFIRMED, stay + listing immutable, accepted PaymentIntent and Hostaway reservation id never replaced. The worker
 * re-checks them anyway from the fresh rows (defence in depth; no exploit observed).
 */
async function preSendCapture(ctx, intentId, opId, plan) {
  const o = await opRow(ctx.pool, opId);
  const w = (await ctx.pool.query("SELECT work_worker_id, work_lease_until FROM booking.intent_work WHERE intent_id = $1", [intentId])).rows[0];
  const i = await loadIntent(ctx.pool, intentId);
  const pa = i ? await boundPaymentAttempt(ctx.pool, i) : null;
  const ev = (await ctx.pool.query("SELECT id, observed_at FROM booking.provider_evidence WHERE id = ANY($1) AND intent_id = $2", [plan.evidenceIds, intentId])).rows;
  const now = ctx.clock();
  const need = ctx.timeouts.captureCallMs + CAPTURE_LIMITS.sendMarginMs;
  if (!o || o.state !== "in_flight" || o.lease_worker_id !== ctx.workerId) return "OPERATION_NOT_HELD";
  if (!(ms(o.lease_until) - now > need)) return "OPERATION_LEASE_TOO_SHORT";
  if (!w || w.work_worker_id !== ctx.workerId) return "WORK_LEASE_NOT_HELD";
  if (!(ms(w.work_lease_until) - now > need)) return "WORK_LEASE_TOO_SHORT";
  if (!i || i.status !== S.RESERVATION_CONFIRMED || i.counters.captureAttempts !== 1 || i.version !== plan.eligibility.intentVersion) return "INTENT_CHANGED";
  if (!i.reservation || isProtectedReservationId(i.reservation.reservationId)) return "PROTECTED_RESERVATION_ID";
  if (i.payment.paymentIntentId !== o.payload.paymentIntentId || o.payload.attempt !== 1) return "INTENT_CHANGED";
  if (pa !== plan.paymentAttemptId) return "PAYMENT_ATTEMPT_CHANGED";
  if (ev.length !== plan.evidenceIds.length) return "EVIDENCE_MISSING";
  for (const e of ev) {
    const t = ms(e.observed_at);
    if (!(t >= i.reservation.confirmedAt && t <= now && now - t <= CAPTURE_LIMITS.preSendFreshMs)) return "EVIDENCE_STALE";
  }
  if (!(i.payment.authorizationDeadline - now > need)) return "DEADLINE";
  // proof-relevant values: CURRENT intent + row against the snapshot the eligibility was minted on (not dispatch/op state,
  // which the claim itself legitimately changed)
  const snap = plan.eligibility.snapshot; const p = o.payload;
  const cur = { intentId: i.id, intentVersion: i.version, status: i.status, captureAttempts: i.counters.captureAttempts, opId: o.id,
    paymentIntentId: p.paymentIntentId, attempt: p.attempt, opAmountMinor: p.amountMinor, idempotencyKey: p.providerIdempotencyKey,
    priceMinor: i.price.finalTotalMinor, currency: i.price.currency, authorizedMinor: i.payment.amountMinor,
    authorizedCurrency: String(i.payment.currency || "").toUpperCase(), intentPaymentIntentId: i.payment.paymentIntentId,
    captureBefore: i.payment.captureBefore, authorizationDeadline: i.payment.authorizationDeadline, paymentAttemptId: pa };
  for (const k of Object.keys(cur)) if (!Object.is(cur[k], snap[k])) return "PROOF_SNAPSHOT_CHANGED";
  const r = plan.reservation;
  if (String(i.reservation.reservationId) !== r.reservationId || i.listingId !== r.listingId || i.from !== r.from || i.to !== r.to) return "RESERVATION_BINDING_CHANGED";
  if (!validateCaptureRequest(plan.request, { intent: i, captureOp: asCaptureOp(o) }).ok) return "REQUEST_INVALID_FOR_CURRENT";
  if (!(ctx.stepEndsAt - ctx.mono() > ctx.timeouts.captureCallMs)) return "STEP_BUDGET";
  return null;
}

async function sendCapture(ctx, intent, op, plan) {
  const request = plan.request;
  const refused = await preSendCapture(ctx, intent.id, op.id, plan);
  if (refused) { ctx.actions.push(`SEND_ABORTED:${refused}`); return settleUnknown(ctx, intent.id, op, `SEND_ABORTED_${refused}`); }
  // no await between the decision above (fresh rows, fresh clock, request validated against CURRENT rows) and the call start
  const call = RW.startBounded(ctx, "captureCallMs", (signal) => ctx.executors.capturePaymentIntent(request.paymentIntentId,
    { ...request.params, expand: [...request.params.expand] }, { idempotencyKey: request.options.idempotencyKey, signal }));
  ctx.calls.push(`capture:${request.paymentIntentId}`);
  ctx.sends += 1;
  let reply; let timedOut = false; let failed = false;
  try { reply = await call.promise; } catch (e) { timedOut = e instanceof ProviderCallTimeout; failed = true; }
  if (ctx.hooks.afterSend) await ctx.hooks.afterSend(op);
  if (timedOut) {
    const settled = settleUnknown(ctx, intent.id, op, "CAPTURE_TIMEOUT");
    // a late reply is recorded only AFTER the unknown settlement committed, and only as late evidence (never an event)
    if (call.raw) ctx.late.push(Promise.all([call.raw.catch(() => null), settled]).then(([late]) => lateCaptureResult(ctx, op, late)).catch(() => {}));
    return settled;
  }
  const positive = !failed && isObj(reply) && reply.object === "payment_intent" && reply.id === request.paymentIntentId && reply.status === "succeeded";
  if (!positive) return settleUnknown(ctx, intent.id, op, failed ? "CAPTURE_CALL_FAILED" : "CAPTURE_REPLY_NOT_SUCCESS");
  // a reply is never enough: ONE confirming expanded PaymentIntent read, persisted as immutable evidence
  let cr;
  try { cr = await readPaymentIntent(ctx, intent); } catch { cr = { ok: false, code: "CONFIRM_READ_REFUSED" }; }
  if (!cr.ok) return settleUnknown(ctx, intent.id, op, "CONFIRM_READ_FAILED");
  if (ctx.hooks.afterConfirmEvidence) await ctx.hooks.afterConfirmEvidence(op);
  const ev = (await evidenceRows(ctx.pool, intent.id, OPS.PI_READ, intent.payment.paymentIntentId)).find((e) => e.id === cr.evidenceId);
  if (!ev || !piCapturedProof(ev, intent, plan.paymentAttemptId)) return settleUnknown(ctx, intent.id, op, "CONFIRM_READ_NOT_CAPTURED");
  const chargeId = ev.observed.latestCharge.id;
  const c = await completeOperation(ctx.pool, op.id, { workerId: ctx.workerId, now: ctx.clock(), outcome: { status: "succeeded", resultRef: chargeId } });
  if (!c.ok) { ctx.actions.push(`LEASE_LOST:${c.error}`); return { delayMs: 0 }; }
  if (ctx.hooks.afterComplete) await ctx.hooks.afterComplete(op);
  // the verified money is the truth even if the authorization deadline elapsed meanwhile (the deadline only blocks NEW sends)
  const r = await applyChecked(ctx, intent.id, { type: "CAPTURE_SUCCEEDED", id: `op-outcome:${op.id}`, amountMinor: ev.observed.amountReceivedMinor,
    currency: ev.observed.currency }, async (cx, { before }) => {
    if (before.version !== intent.version || before.status !== S.RESERVATION_CONFIRMED || before.counters.captureAttempts !== 1) throw new RepoError("STALE_CAPTURE_EVENT");
    if (!before.payment || before.payment.paymentIntentId !== op.payload.paymentIntentId) throw new RepoError("STALE_CAPTURE_EVENT");
    if (!before.reservation || before.reservation.reservationId !== intent.reservation.reservationId || isProtectedReservationId(before.reservation.reservationId)) {
      throw new RepoError("STALE_CAPTURE_EVENT");
    }
    const o = (await cx.query("SELECT state, result_ref FROM booking.external_operations WHERE id = $1 FOR SHARE", [op.id])).rows[0];
    if (!o || o.state !== "succeeded" || o.result_ref !== chargeId) throw new RepoError("STALE_CAPTURE_EVENT");
    const e = (await cx.query(`SELECT 1 FROM booking.provider_evidence e JOIN booking.external_operations r ON r.id = e.read_operation_id
                                 WHERE e.id = $1 AND e.intent_id = $2 AND r.op_type = $3 AND r.payload ->> 'paymentIntentId' = $4 AND e.observed_at >= $5`,
      [ev.id, intent.id, OPS.PI_READ, op.payload.paymentIntentId, op.dispatched_at])).rowCount;
    if (e !== 1) throw new RepoError("STALE_CAPTURE_EVENT");
  });
  // r.duplicate: E3 already holds this exact captured money (e.g. a webhook won the race) — a no-op, never a second effect
  ctx.actions.push(!r.ok ? `CAPTURE_SUCCEEDED!${r.error}` : r.duplicate ? "CAPTURE_SUCCEEDED:DUPLICATE" : `CAPTURE_SUCCEEDED->${r.intent.status}`);
  return { delayMs: 0 };
}

async function settleUnknown(ctx, intentId, op, code) {
  if (ctx.hooks.beforeSettleUnknown) await ctx.hooks.beforeSettleUnknown(op, code);
  const c = sanitize(code);
  const u = await completeOperation(ctx.pool, op.id, { workerId: ctx.workerId, now: ctx.clock(), outcome: { status: "outcome_unknown", errorCode: c } });
  if (!u.ok) { ctx.actions.push(`LEASE_LOST:${u.error}`); return { delayMs: 0 }; }
  const r = await applyChecked(ctx, intentId, { type: "CAPTURE_OUTCOME_UNKNOWN", id: `op-unknown:${op.id}`, code: c }, async (_c, { before }) => {
    if (before.status !== S.RESERVATION_CONFIRMED || !ctx.listings.has(before.listingId)) throw new RepoError("STALE_OUT_OF_SCOPE");
  });
  ctx.actions.push(r.ok ? `CAPTURE_OUTCOME_UNKNOWN:${c}` : `CAPTURE_OUTCOME_UNKNOWN!${r.error}`);
  return { delayMs: 0 };
}

/** A capture reply that arrived after its timeout: late evidence on the (already unknown) row only; never an event. */
async function lateCaptureResult(ctx, op, late) {
  const ok = isObj(late) && late.object === "payment_intent" && late.status === "succeeded";
  const chargeId = ok && isObj(late.latest_charge) && typeof late.latest_charge.id === "string" ? late.latest_charge.id : null;
  await completeOperation(ctx.pool, op.id, { workerId: ctx.workerId, now: ctx.clock(),
    outcome: ok ? { status: "succeeded", resultRef: chargeId } : { status: "outcome_unknown", errorCode: "LATE_CAPTURE_RESULT" } });
}

// ---------------------------------------------------------------------------------------------
// capture_unknown: fresh PI reads (>= dispatch + 2 min); the planner (recovery pass) decides

async function handleCaptureUnknown(ctx, intent) {
  const rows = await captureRows(ctx.pool, intent.id);
  const current = rows.find((r) => r.payload && r.payload.attempt === intent.counters.captureAttempts);
  if (!current) return escalate(ctx, intent, "CAPTURE_ROW_MISSING");
  if (isProtectedReservationId(intent.reservation && intent.reservation.reservationId)) return escalate(ctx, intent, "PROTECTED_RESERVATION_ID");
  const notBefore = current.dispatched_at ? ms(current.dispatched_at) + FRESH_AFTER_DISPATCH_MS : 0;
  const now = ctx.clock();
  if (now < notBefore) { ctx.actions.push("WAIT:EVIDENCE_FRESHNESS"); return { delayMs: notBefore - now }; }
  const pend = (await ctx.pool.query(
    `SELECT id FROM booking.external_operations WHERE intent_id = $1 AND op_type = $2 AND state = 'pending' AND payload ->> 'paymentIntentId' = $3
      ORDER BY created_at LIMIT 1`, [intent.id, OPS.PI_READ, intent.payment.paymentIntentId])).rows[0];
  if (!pend) { ctx.actions.push("WAIT:NO_READ_DUE"); return { delayMs: CAPTURE_LIMITS.waitMs }; }
  const op = await claimNextOperation(ctx.pool, { workerId: ctx.workerId, now, opId: pend.id, opTypes: [OPS.PI_READ] });
  if (!op) { ctx.actions.push("WAIT:READ_NOT_CLAIMED"); return { delayMs: CAPTURE_LIMITS.waitMs }; }
  try {
    const r = await readPaymentIntent(ctx, intent, { reuseClaimed: op });
    ctx.actions.push(r.ok ? "READ:PI" : `READ:PI!${r.code}`);
  } catch (e) {
    if (e instanceof Escalate) return escalate(ctx, intent, e.code);
    throw e;
  }
  return { delayMs: 0 };
}

// ---------------------------------------------------------------------------------------------
// recovery pass (accepted E7.1 planner) — capture rows only; RECONCILED_STILL_AUTHORIZED is intercepted

async function recoveryPass(ctx) {
  const scope = { intentId: ctx.scopeIntentId, listingIds: ctx.listingIds };
  const missed = (await findMissedOutcomes(ctx.pool, { now: ctx.clock(), limit: CAPTURE_LIMITS.recoveryBatch, opTypes: [OPS.CAPTURE], ...scope })).rows;
  for (const m of missed) {
    const facts = await loadRecoveryFacts(ctx.pool, m.opId);
    if (!facts || !WORK_STATES.includes(facts.intent.status)) continue;                 // capture_failed etc.: out of this worker's scope
    const plan = planRecovery({ ...facts, now: ctx.clock() });
    if (isProtectedReservationId(facts.intent.reservation && facts.intent.reservation.reservationId)) {
      await escalateRecovery(ctx, facts, "PROTECTED_RESERVATION_ID"); continue;
    }
    if (plan.kind === "event" && plan.event.type === "RECONCILED_STILL_AUTHORIZED") {
      // contract §11: an unresolved original capture that still looks authorized is an OWNER decision — never a new row/key.
      // Intercepted BEFORE any settlement or new-write event; fenced so it never escalates a state another actor reached.
      await escalateRecovery(ctx, facts, "CAPTURE_STILL_AUTHORIZED_UNRESOLVED"); continue;
    }
    if (plan.kind === "event") {
      const r = await applyRecoveryPlan(ctx.pool, plan, { now: ctx.clock() });
      ctx.actions.push(`RECOVERY:${plan.event.type}${r.ok ? "" : `!${r.error}`}`);
    } else if (plan.kind === "needs_fresh_read") {
      if (plan.read.opType !== OPS.PI_READ) continue;
      const r = await requestRecoveryRead(ctx.pool, m.opId, plan.read, { now: ctx.clock() });
      if (!r.ok && r.error === "RECOVERY_READS_EXHAUSTED") {
        await escalateRecovery(ctx, facts, "RECOVERY_READS_EXHAUSTED");
      } else ctx.actions.push("RECOVERY:READ:PI");
    } else if (plan.kind === "operator") {
      await escalateRecovery(ctx, facts, plan.code);
    }
  }
  const orphans = await findOrphanReads(ctx.pool, { now: ctx.clock(), limit: CAPTURE_LIMITS.recoveryBatch, opTypes: [...READ_OP_TYPES],
    intentStates: [...WORK_STATES], ...scope });
  for (const o of orphans) {
    const r = await reissueOrphanRead(ctx.pool, o.readOpId, { now: ctx.clock() });
    ctx.actions.push(`RECOVERY:REISSUE${r.ok ? "" : `!${r.error}`}`);
    if (!r.ok && r.error === "REISSUE_DEPTH_EXHAUSTED") {
      let e;
      try {
        e = await applyEvent(ctx.pool, o.intentId, { type: "ESCALATE", id: `cw-reissue-exhausted:${o.readOpId}`, code: "READ_REISSUE_EXHAUSTED" }, {
          now: ctx.clock(), actor: "reconciler",
          inTx: async (_c, { before }) => {
            if (!WORK_STATES.includes(before.status) || !ctx.listings.has(before.listingId) || (ctx.scopeIntentId && before.id !== ctx.scopeIntentId)) {
              throw new RepoError("OUT_OF_SCOPE");
            }
          }
        });
      } catch (err) {
        if (!(err instanceof RepoError && err.code === "OUT_OF_SCOPE")) throw err;
        e = { ok: false, error: "OUT_OF_SCOPE" };
      }
      ctx.actions.push(e.ok ? "RECOVERY:ESCALATE:READ_REISSUE_EXHAUSTED" : `RECOVERY:ESCALATE!${e.error}`);
    }
  }
}

// ---------------------------------------------------------------------------------------------

/**
 * runCaptureStep(pool, { workerId, env, adapterConfig, listings, executors, clock, stripeAccountId, intentId?, timeouts?, monotonic?, hooks? })
 *   -> { status: "refused" | "idle" | "worked", code?, intentId?, actions, calls, sends, delayMs?, late }
 * One bounded step: gate -> test-database check -> scoped maintenance + recovery -> at most ONE intent -> reschedule.
 */
export async function runCaptureStep(pool, opts = {}) {
  const { workerId, env, adapterConfig, listings, executors, clock, stripeAccountId, intentId: scopeIntentId = null, timeouts, hooks = {} } = opts;
  const g = captureWorkerGate({ env, adapterConfig, listings, executors, clock, stripeAccountId });
  const none = { actions: [], calls: [], sends: 0 };
  if (!g.ok) return result("refused", { code: g.code, ...none });
  if (typeof workerId !== "string" || !/^[A-Za-z0-9._:-]{1,80}$/.test(workerId)) return result("refused", { code: "WORKER_ID_INVALID", ...none });
  try { await assertEnvironment(pool, "test"); } catch { return result("refused", { code: "DATABASE_NOT_TEST", ...none }); }
  const t = resolveTimeouts(timeouts);
  const mono = typeof opts.monotonic === "function" ? opts.monotonic : () => performance.now();
  const listingIds = [...listings.keys()];
  const ctx = { pool, workerId, cfg: g.cfg, listings, listingIds, executors, clock, hooks, scopeIntentId, stripeAccountId, timeouts: t,
    mono, stepEndsAt: mono() + t.stepBudgetMs, late: [], actions: [], calls: [], sends: 0, accountVerified: false };
  const late = () => Promise.allSettled(ctx.late);
  await recoveryPass(ctx);
  const intentId = await RW.claimWork(pool, { workerId, now: clock(), leaseMs: CAPTURE_LIMITS.workLeaseMs, states: [...WORK_STATES], intentId: scopeIntentId, listingIds });
  if (!intentId) return result("idle", { actions: ctx.actions, calls: ctx.calls, sends: ctx.sends, late: late() });
  let delayMs = CAPTURE_LIMITS.waitMs;
  try {
    // expired leases: only this worker's op types on the intent it now owns (an intent in a capture-phase state on a
    // configured listing), so rows of out-of-scope intents are never touched
    if (hooks.beforeMaintenance) await hooks.beforeMaintenance(intentId);
    // phase-guarded in the maintenance transaction itself (intent locked first; state re-checked there), not a snapshot
    await recoverExpiredOperations(pool, { now: clock(), limit: CAPTURE_LIMITS.maintenanceBatch, opTypes: [...CAPTURE_WORKER_OP_TYPES], intentId, listingIds,
      intentStates: [...WORK_STATES] });
    const intent = await loadIntent(pool, intentId);
    if (intent.status === S.RESERVATION_CONFIRMED) ({ delayMs } = await handleReservationConfirmed(ctx, intent));
    else if (intent.status === S.CAPTURE_UNKNOWN) ({ delayMs } = await handleCaptureUnknown(ctx, intent));
  } finally {
    await RW.releaseWork(ctx, intentId, delayMs);
  }
  return result("worked", { intentId, actions: ctx.actions, calls: ctx.calls, sends: ctx.sends, delayMs, late: late() });
}

export { PROTECTED_HOSTAWAY_RESERVATION_IDS };
export const _internal = Object.freeze({ resolveTimeouts, preSendCapture });
