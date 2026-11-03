// lib/booking-db/compensation-worker.js — Stage E7.4a (offline). Bounded single-step CLEANUP worker: Stripe void (release of a
// held authorization; never a refund) and Hostaway host-cancel for intents in reservation_failed (void) and capture_failed
// (void + cancel legs). Contract: claude/e7-compensation-worker-contract.md (§3–§6, §12). Pure proofs: ../checkout/compensation-proof.js.
//
// INTERNAL LIBRARY ONLY: no route, cron, frontend, SDK client, network adapter or default provider function. Every provider
// call goes through an INJECTED executor (exactly CLEANUP_EXECUTOR_KEYS). Never executed here: capture, refund, create,
// offline-charge recording, notifications. Capture rows are never claimed, completed or settled by this worker.
//
// Rules (root E7.4a brief):
//   * EVERY initial void / cancel rests on fresh, executed, account-verified v3 PaymentIntent evidence proving zero money
//     received: void = strict still-authorized (Z/P history only); cancel = still-authorized (Z/P) or strict canceled (Z/P/D).
//     A captured PaymentIntent (or partial / unknown / unproven) -> fenced owner case, never a write. Strict canceled evidence
//     settles the authorization leg WITHOUT a void (RECONCILED_AUTHORIZATION_GONE, id cw4-authgone:{intent}:{evidence}).
//   * Cancel additionally needs the current reservation identity incl. the booking ref (by id; by ref when not echoed), status
//     "new", not a protected id, and a STRICTLY future arrival in the listing's explicit trusted IANA time zone.
//   * Eligibility + request from the accepted pure foundation BEFORE the claim; the exact row is claimed; immediately before
//     the send every CURRENT fact is re-read (op + work leases with whole-call room, version, state, open leg, payment attempt,
//     capture history fingerprint, immutable evidence ids / times and freshness, arrival with the fresh clock, the request vs
//     the CURRENT rows), clock read AFTER those reads, no await between the decision and the call start.
//   * A provider reply never completes a leg: a confirming READ persisted as immutable evidence (void: strict canceled proof;
//     cancel: status cancelled with the full identity) comes first; only then the row is completed (I4) and the fenced event
//     applied, its transaction re-checking version, state, open leg, operation state and the exact evidence linkage.
//   * Unknown -> outcome_unknown + the legal *_OUTCOME_UNKNOWN event -> reads only. RECONCILED_STILL_AUTHORIZED and
//     RECONCILED_RESERVATION_STILL_ACTIVE are INTERCEPTED into fenced durable owner cases: no resend (same or new key), no
//     new attempt row, ever. Late provider replies are late evidence only.
//   * Pending rows of a leg that is already settled (e.g. a never-sent void after the authorization proved gone) are never
//     claimed by this worker (it only works an OPEN leg); every other claim path is fenced too: claimNextOperation's
//     VOID_FENCE / CANCEL_FENCE and, for any direct UPDATE, migration 0009 (pending -> in_flight guard).
import { applyEvent, loadIntent, RepoError } from "./repo.js";
import { claimNextOperation, completeOperation, recordProviderEvidence, recoverExpiredOperations, requestRead } from "./operations.js";
import { assertEnvironment } from "./pool.js";
import { findMissedOutcomes, loadRecoveryFacts, requestRecoveryRead, findOrphanReads, reissueOrphanRead, applyRecoveryPlan } from "./recovery.js";
import { _internal as RW, ProviderCallTimeout } from "./reservation-worker.js";
import { planRecovery, reservationIdentity, FRESH_AFTER_DISPATCH_MS, RECOVERY_EVENT_ID } from "../checkout/recovery-plan.js";
import { paymentIntentProofObservationV3 } from "../checkout/capture-proof.js";
import {
  captureHistoryClass, piCanceledProofV3, voidSendEligibility, buildVoidRequest, validateVoidRequest, cancelSendEligibility,
  buildCancelRequest, validateCancelRequest, arrivalStrictlyFuture, localDateInZone, isProtectedReservationId, PROOF_MAX_AGE_MS
} from "../checkout/compensation-proof.js";
import { STATES as S } from "../checkout/intent-state.js";
import { validateAdapterConfig, unwrapEnvelope, normalizeReservation, lookupByRef } from "../hostaway-reservations.js";

export const COMPENSATION_WORKER_VERSION = "e7-compensation-worker-v1";
export const OPS = Object.freeze({ VOID: "stripe.void_payment_intent", CANCEL: "hostaway.cancel_reservation", CAPTURE: "stripe.capture_payment_intent",
  PI_READ: "stripe.retrieve_payment_intent", RES_READ: "hostaway.retrieve_reservation", LOOKUP: "hostaway.lookup_reservation" });
export const WRITE_OP_TYPES = Object.freeze([OPS.VOID, OPS.CANCEL]);
export const READ_OP_TYPES = Object.freeze([OPS.PI_READ, OPS.RES_READ, OPS.LOOKUP]);
export const CLEANUP_OP_TYPES = Object.freeze([...WRITE_OP_TYPES, ...READ_OP_TYPES]);
export const CLEANUP_EXECUTOR_KEYS = Object.freeze(["retrieveAccount", "retrievePaymentIntent", "cancelPaymentIntent", "retrieveReservation", "lookupPage", "cancelReservation"]);
export const WORK_STATES = Object.freeze([S.RESERVATION_FAILED, S.CAPTURE_FAILED]);
export const CLEANUP_DEFAULT_TIMEOUTS = Object.freeze({ readCallMs: 10000, writeCallMs: 20000, stepBudgetMs: 45000 });
export const CLEANUP_LIMITS = Object.freeze({ workLeaseMs: 60 * 1000, sendMarginMs: 15 * 1000, waitMs: 30 * 1000, maxReadsPerType: 6, recoveryBatch: 10,
  maintenanceBatch: 20 });
const ACCT_RE = /^acct_[A-Za-z0-9]{1,64}$/;
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const result = (status, extra = {}) => Object.freeze({ status, ...extra });
const ms = (d) => (d == null ? null : new Date(d).getTime());
const sanitize = (code) => (/^[A-Z0-9_]{1,64}$/.test(code) ? code : "CLEANUP_WORKER_OPERATOR_REQUIRED");
class Escalate extends Error { constructor(code) { super(code); this.code = code; } }

function resolveTimeouts(t) {
  const out = {};
  for (const [k, d] of Object.entries(CLEANUP_DEFAULT_TIMEOUTS)) {
    const v = t !== null && typeof t === "object" ? t[k] : undefined;
    out[k] = Number.isFinite(v) && v > 0 ? Math.min(v, d) : d;
  }
  return Object.freeze(out);
}

// ---------------------------------------------------------------------------------------------
// gate (pure; nothing touched before it passes)

export function compensationWorkerGate({ env, adapterConfig, listings, executors, clock, stripeAccountId } = {}) {
  const e = isObj(env) ? env : null;
  if (!e) return { ok: false, code: "ENV_REQUIRED" };
  if (e.VERCEL_ENV === "production") return { ok: false, code: "PRODUCTION_REFUSED" };
  if (e.VERCEL_ENV !== "development" && e.VERCEL_ENV !== "preview") return { ok: false, code: "ENVIRONMENT_NOT_ALLOWED" };
  if (e.MV_E7_COMPENSATION_WORKER !== "enabled") return { ok: false, code: "NOT_ENABLED" };
  if (typeof stripeAccountId !== "string" || !ACCT_RE.test(stripeAccountId)) return { ok: false, code: "STRIPE_ACCOUNT_REQUIRED" };
  let cfg;
  try { cfg = validateAdapterConfig(adapterConfig); } catch { return { ok: false, code: "ADAPTER_CONFIG_INVALID" }; }
  if (typeof clock !== "function" || !Number.isFinite(clock())) return { ok: false, code: "CLOCK_REQUIRED" };
  if (!(listings instanceof Map) || listings.size === 0) return { ok: false, code: "LISTINGS_REQUIRED" };
  for (const [id, lc] of listings) {
    if (!cfg.allowedListingIds.includes(id) || !isObj(lc) || lc.currency !== cfg.currency) return { ok: false, code: "LISTING_NOT_ALLOWLISTED" };
    if (localDateInZone(clock(), lc.timeZone) === null) return { ok: false, code: "LISTING_TIME_ZONE_INVALID" };   // explicit IANA zone; no fallback
  }
  if (!isObj(executors)) return { ok: false, code: "NO_EXECUTORS" };
  for (const k of Object.keys(executors)) if (!CLEANUP_EXECUTOR_KEYS.includes(k)) return { ok: false, code: "EXECUTOR_NOT_ALLOWED" };
  for (const k of CLEANUP_EXECUTOR_KEYS) if (typeof executors[k] !== "function") return { ok: false, code: "NO_EXECUTORS" };
  return { ok: true, cfg };
}

// ---------------------------------------------------------------------------------------------
// fenced events / owner cases

/** In-transaction scope fence: still the PLANNED version + state, a cleanup state, a configured listing (and the scoped intent). */
function scopeFence(ctx, planned) {
  return (before) => {
    if (before.version !== planned.version || before.status !== planned.status || !WORK_STATES.includes(before.status)
      || !ctx.listings.has(before.listingId) || (ctx.scopeIntentId && before.id !== ctx.scopeIntentId)) throw new RepoError("STALE_OUT_OF_SCOPE");
  };
}
const legOpen = (i, leg) => (leg === "authorization"
  ? (i.status === S.RESERVATION_FAILED ? !(isObj(i.settlement) && i.settlement.authorizationSettled === true)
    : i.status === S.CAPTURE_FAILED && isObj(i.settlement) && i.settlement.authorizationSettled === false)
  : i.status === S.CAPTURE_FAILED && isObj(i.settlement) && i.settlement.reservationCancelled === false);

/** applyEvent fenced on this worker's work lease AND caller checks (run inside the event transaction, intent row locked). */
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
async function escalate(ctx, intent, code) {
  const c = sanitize(code);
  const fence = scopeFence(ctx, intent);
  const r = await applyChecked(ctx, intent.id, { type: "ESCALATE", id: `cw4-escalate:${intent.id}:${c}:v${intent.version}`, code: c },
    async (_c, { before }) => fence(before));
  ctx.actions.push(r.ok ? `ESCALATE:${c}` : `ESCALATE!${r.error}`);
  return { delayMs: 0 };
}
/** Recovery-pass owner case: fenced on the facts' version / state / scope and the operation state the plan came from. */
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
  ctx.actions.push(!r.ok ? `RECOVERY:ESCALATE!${r.error}` : r.duplicate ? "RECOVERY:ESCALATE:DUPLICATE_EVENT_ID" : `RECOVERY:ESCALATE:${safe}`);
  return r;
}

// ---------------------------------------------------------------------------------------------
// rows / facts

const asOp = (r) => ({ id: r.id, opType: r.op_type, state: r.state, attempts: r.attempts, dispatchedAt: ms(r.dispatched_at), payload: r.payload });
const opRow = async (q, opId) => (await q.query("SELECT * FROM booking.external_operations WHERE id = $1", [opId])).rows[0] || null;
const rowsOf = async (q, intentId, opType) => (await q.query(
  "SELECT * FROM booking.external_operations WHERE intent_id = $1 AND op_type = $2 ORDER BY created_at, id", [intentId, opType])).rows;
async function boundPaymentAttempt(q, intent) {
  if (!intent.payment || !intent.payment.paymentIntentId) return null;
  const r = await q.query("SELECT id FROM booking.payment_attempts WHERE intent_id = $1 AND payment_intent_id = $2 AND status = 'completed'",
    [intent.id, intent.payment.paymentIntentId]);
  return r.rowCount === 1 ? r.rows[0].id : null;
}
/** When the intent entered its CURRENT state (the first transition into it from another state). */
async function stateEnteredAt(q, intent) {
  const r = await q.query(`SELECT min(at) AS t FROM booking.intent_transitions WHERE intent_id = $1 AND to_state = $2 AND from_state IS DISTINCT FROM to_state`,
    [intent.id, intent.status]);
  return ms(r.rows[0].t);
}
async function evidenceById(q, intentId, id) {
  const r = await q.query(
    `SELECT e.id, e.kind, e.external_ref, e.status, e.observed, e.observed_at, r.op_type AS read_op_type, r.id AS read_op_id,
            coalesce(r.payload ->> 'paymentIntentId', r.payload ->> 'reservationId', r.payload ->> 'ref') AS request_ref
       FROM booking.provider_evidence e JOIN booking.external_operations r ON r.id = e.read_operation_id
      WHERE e.id = $1 AND e.intent_id = $2 AND e.source IN ('stripe_api', 'hostaway_api')`, [id, intentId]);
  const e = r.rows[0];
  return e ? { id: e.id, kind: e.kind, readOpType: e.read_op_type, requestRef: e.request_ref, externalRef: e.external_ref, status: e.status,
    observed: e.observed, observedAt: ms(e.observed_at), readOpId: e.read_op_id } : null;
}

// ---------------------------------------------------------------------------------------------
// executed READS (bounded; results persisted as immutable API evidence)

const READ_FIELD = { [OPS.PI_READ]: "paymentIntentId", [OPS.RES_READ]: "reservationId", [OPS.LOOKUP]: "ref" };
async function claimRead(ctx, intent, opType, selector) {
  const field = READ_FIELD[opType];
  let open = (await ctx.pool.query(
    `SELECT id, state FROM booking.external_operations WHERE intent_id = $1 AND op_type = $2 AND retry_class = 'read'
        AND state IN ('pending', 'in_flight') AND payload ->> $3 = $4 ORDER BY created_at LIMIT 1`, [intent.id, opType, field, selector])).rows[0];
  // bounded: every EXECUTION attempt of this read type since the intent entered its cleanup state counts
  const used = Number((await ctx.pool.query(
    `SELECT coalesce(sum(attempts), 0) AS n FROM booking.external_operations WHERE intent_id = $1 AND op_type = $2 AND retry_class = 'read' AND created_at >= $3`,
    [intent.id, opType, new Date(ctx.enteredAt)])).rows[0].n);
  if (used >= CLEANUP_LIMITS.maxReadsPerType) throw new Escalate("CLEANUP_READS_EXHAUSTED");
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

async function verifyAccount(ctx) {
  if (ctx.accountVerified) return true;
  let a;
  try { a = await RW.startBounded(ctx, "readCallMs", (signal) => ctx.executors.retrieveAccount({ signal })).promise; } catch { return false; }
  ctx.calls.push("account");
  if (!isObj(a) || a.object !== "account" || a.id !== ctx.stripeAccountId) throw new Escalate("STRIPE_ACCOUNT_MISMATCH");
  ctx.accountVerified = true;
  return true;
}

/** One executed PaymentIntent read (latest_charge expanded) -> v3 evidence row. -> { ok, ev } | { ok:false, code } */
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
  if (ctx.hooks.afterPiRead) await ctx.hooks.afterPiRead();
  if (!isObj(obj) || obj.object !== "payment_intent" || obj.id !== pi || typeof obj.status !== "string") {
    await finishRead(ctx, op, "outcome_unknown", "PI_READ_UNUSABLE"); return { ok: false, code: "PI_READ_UNUSABLE" };
  }
  const done = await finishRead(ctx, op, "succeeded");
  if (!done.ok) return { ok: false, code: "LEASE_LOST" };
  const rec = await recordProviderEvidence(ctx.pool, { readOpId: op.id, kind: "payment_intent", externalRef: pi, status: obj.status,
    observed: paymentIntentProofObservationV3(obj, { accountVerified: ctx.accountVerified === true }) });
  if (!rec.ok) return { ok: false, code: "EVIDENCE_NOT_RECORDED" };
  return { ok: true, ev: await evidenceById(ctx.pool, intent.id, rec.id) };
}

/** One executed Hostaway by-id read -> evidence row (found_active / cancelled / not_found). */
async function readReservationById(ctx, intent, { reuseClaimed = null } = {}) {
  const rid = String(intent.reservation.reservationId);
  const op = reuseClaimed || await claimRead(ctx, intent, OPS.RES_READ, rid);
  if (!op) return { ok: false, code: "RESERVATION_READ_NOT_CLAIMED" };
  const req = Object.freeze({ method: "GET", path: `/reservations/${rid}`, query: {} });
  let resp;
  try { resp = await RW.startBounded(ctx, "readCallMs", (signal) => ctx.executors.retrieveReservation(req, { signal })).promise; } catch { resp = null; }
  ctx.calls.push(`res_read:${rid}`);
  if (ctx.hooks.afterResRead) await ctx.hooks.afterResRead();
  let ev;
  if (isObj(resp) && resp.httpStatus === 404) ev = { externalRef: rid, status: "not_found", observed: {} };
  else {
    const env = isObj(resp) && resp.httpStatus === 200 ? unwrapEnvelope(resp.json) : { ok: false };
    const n = env.ok ? normalizeReservation(env.result, ctx.cfg) : { ok: false };
    if (!n.ok) { await finishRead(ctx, op, "outcome_unknown", "RESERVATION_READ_UNUSABLE"); return { ok: false, code: "RESERVATION_READ_UNUSABLE" }; }
    if (String(n.reservation.reservationId) !== rid) { await finishRead(ctx, op, "succeeded"); throw new Escalate("RESERVATION_READ_CONTRADICTS_REQUEST"); }
    const r = n.reservation;
    ev = { externalRef: rid, status: r.status === "cancelled" ? "cancelled" : "found_active", observed: RW.observedReservation(r) };
  }
  const d = await finishRead(ctx, op, "succeeded");
  if (!d.ok) return { ok: false, code: "LEASE_LOST" };
  const rec = await recordProviderEvidence(ctx.pool, { readOpId: op.id, kind: "hostaway_reservation", ...ev });
  if (!rec.ok) return { ok: false, code: "EVIDENCE_NOT_RECORDED" };
  return { ok: true, ev: await evidenceById(ctx.pool, intent.id, rec.id) };
}

/** One executed Hostaway by-ref lookup -> evidence row (fallback when the by-id read does not echo the booking ref). */
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
        observed: { bookingRef: intent.ref, matchCount: 1, ...RW.observedReservation(r) } }
      : { externalRef: intent.ref, status: "not_found", observed: { bookingRef: intent.ref, matchCount: 0 } };
    const rec = await recordProviderEvidence(ctx.pool, { readOpId: op.id, kind: "hostaway_reservation", ...ev });
    if (!rec.ok) return { ok: false, code: "EVIDENCE_NOT_RECORDED" };
    return { ok: true, ev: await evidenceById(ctx.pool, intent.id, rec.id) };
  }
  if (lk.outcome === "conflict") { await finishRead(ctx, op, "succeeded"); throw new Escalate(lk.code === "DUPLICATE_REF" ? "DUPLICATE_BOOKING_REF" : "LOOKUP_CONTRADICTS_STAY"); }
  await finishRead(ctx, op, "outcome_unknown", "LOOKUP_INCONCLUSIVE");
  return { ok: false, code: "LOOKUP_INCONCLUSIVE" };
}

// ---------------------------------------------------------------------------------------------
// shared pieces of the two legs

const wait = (ctx, code) => { ctx.actions.push(`WAIT:${code}`); return { delayMs: CLEANUP_LIMITS.waitMs, waiting: true }; };
const isCapturedEv = (ev) => ev && (ev.status === "succeeded" || (isObj(ev.observed) && ev.observed.status === "succeeded"));

/** An outcome_unknown (or completed-without-event) write: execute the queued read (>= dispatch + 2 min); the recovery pass decides. Never a resend. */
async function readsForUnknown(ctx, intent, row, readOpType) {
  const notBefore = ms(row.dispatched_at) + FRESH_AFTER_DISPATCH_MS;
  if (ctx.clock() < notBefore) return wait(ctx, "EVIDENCE_FRESHNESS");
  const field = READ_FIELD[readOpType];
  const sel = readOpType === OPS.PI_READ ? intent.payment.paymentIntentId : String(intent.reservation.reservationId);
  const pend = (await ctx.pool.query(
    `SELECT id FROM booking.external_operations WHERE intent_id = $1 AND op_type = $2 AND state = 'pending' AND payload ->> $3 = $4
      ORDER BY created_at LIMIT 1`, [intent.id, readOpType, field, sel])).rows[0];
  if (!pend) return wait(ctx, "NO_READ_DUE");
  const op = await claimNextOperation(ctx.pool, { workerId: ctx.workerId, now: ctx.clock(), opId: pend.id, opTypes: [readOpType] });
  if (!op) return wait(ctx, "READ_NOT_CLAIMED");
  const r = readOpType === OPS.PI_READ ? await readPaymentIntent(ctx, intent, { reuseClaimed: op }) : await readReservationById(ctx, intent, { reuseClaimed: op });
  ctx.actions.push(r.ok ? `READ:${readOpType}` : `READ!${r.code}`);
  return { delayMs: 0, waiting: true };
}

/** Pre-send: CURRENT op + work leases with whole-call room, intent version / state / open leg, payment attempt, capture history,
 *  immutable evidence ids + times still fresh at the fresh clock (read AFTER all reads), step budget. -> { refusal } | { intent, op } */
async function preSendCommon(ctx, plan, leg) {
  const o = await opRow(ctx.pool, plan.opId);
  const w = (await ctx.pool.query("SELECT work_worker_id, work_lease_until FROM booking.intent_work WHERE intent_id = $1", [plan.intentId])).rows[0];
  const i = await loadIntent(ctx.pool, plan.intentId);
  const pa = i ? await boundPaymentAttempt(ctx.pool, i) : null;
  const caps = (await rowsOf(ctx.pool, plan.intentId, OPS.CAPTURE)).map(asOp);
  const evs = [];
  for (const id of plan.evidenceIds) evs.push(await evidenceById(ctx.pool, plan.intentId, id));
  const now = ctx.clock();
  const need = ctx.timeouts.writeCallMs + CLEANUP_LIMITS.sendMarginMs;
  if (!o || o.state !== "in_flight" || o.lease_worker_id !== ctx.workerId) return { refusal: "OPERATION_NOT_HELD" };
  if (!(ms(o.lease_until) - now > need)) return { refusal: "OPERATION_LEASE_TOO_SHORT" };
  if (!w || w.work_worker_id !== ctx.workerId) return { refusal: "WORK_LEASE_NOT_HELD" };
  if (!(ms(w.work_lease_until) - now > need)) return { refusal: "WORK_LEASE_TOO_SHORT" };
  if (!i || i.version !== plan.intentVersion || i.status !== plan.status || !legOpen(i, leg)) return { refusal: "INTENT_CHANGED" };
  if (!ctx.listings.has(i.listingId) || (i.reservation && isProtectedReservationId(i.reservation.reservationId))) return { refusal: "OUT_OF_SCOPE_OR_PROTECTED" };
  if (pa !== plan.paymentAttemptId) return { refusal: "PAYMENT_ATTEMPT_CHANGED" };
  const h = captureHistoryClass({ intent: i, captureRows: caps });
  if (!h.ok || h.fingerprint !== plan.historyFingerprint || h.cls !== plan.historyClass) return { refusal: "CAPTURE_HISTORY_CHANGED" };
  for (let k = 0; k < evs.length; k++) {
    const e = evs[k];
    if (!e || e.observedAt !== plan.evidenceObservedAts[k]) return { refusal: "EVIDENCE_MISSING" };
    if (!(e.observedAt <= now && now - e.observedAt <= PROOF_MAX_AGE_MS && e.observedAt >= plan.enteredAt)) return { refusal: "EVIDENCE_STALE" };
  }
  return { intent: i, op: asOp(o), now };
}

async function settleUnknown(ctx, intent, op, leg, code) {
  if (ctx.hooks.beforeSettleUnknown) await ctx.hooks.beforeSettleUnknown(op, code);
  const c = sanitize(code);
  const u = await completeOperation(ctx.pool, op.id, { workerId: ctx.workerId, now: ctx.clock(), outcome: { status: "outcome_unknown", errorCode: c } });
  if (!u.ok) { ctx.actions.push(`LEASE_LOST:${u.error}`); return { delayMs: 0 }; }
  const type = leg === "authorization" ? "VOID_OUTCOME_UNKNOWN" : "RESERVATION_CANCEL_OUTCOME_UNKNOWN";
  const fence = scopeFence(ctx, intent);
  const r = await applyChecked(ctx, intent.id, { type, id: `op-unknown:${op.id}`, code: c }, async (_c, { before }) => {
    fence(before);
    if (!legOpen(before, leg)) throw new RepoError("STALE_OUT_OF_SCOPE");
  });
  ctx.actions.push(r.ok ? `${type}:${c}` : `${type}!${r.error}`);
  return { delayMs: 0 };
}
async function lateResult(ctx, op, late, positive) {
  await completeOperation(ctx.pool, op.id, { workerId: ctx.workerId, now: ctx.clock(),
    outcome: positive(late) ? { status: "succeeded", resultRef: op.payload.paymentIntentId ?? op.payload.reservationId } : { status: "outcome_unknown", errorCode: "LATE_PROVIDER_RESULT" } });
}

// ---------------------------------------------------------------------------------------------
// authorization leg (void, or settled from strict canceled evidence without a void)

async function authorizationGone(ctx, intent, ev, hist) {
  const fence = scopeFence(ctx, intent);
  const r = await applyChecked(ctx, intent.id, { type: "RECONCILED_AUTHORIZATION_GONE", id: `cw4-authgone:${intent.id}:${ev.id}` }, async (c, { before }) => {
    fence(before);
    if (!legOpen(before, "authorization")) throw new RepoError("STALE_OUT_OF_SCOPE");
    const e = (await c.query(`SELECT e.observed_at FROM booking.provider_evidence e JOIN booking.external_operations r ON r.id = e.read_operation_id
                                WHERE e.id = $1 AND e.intent_id = $2 AND e.kind = 'payment_intent' AND e.status = 'canceled' AND r.op_type = $3
                                  AND r.payload ->> 'paymentIntentId' = $4 AND e.external_ref = $4`,
      [ev.id, intent.id, OPS.PI_READ, intent.payment.paymentIntentId])).rows[0];
    if (!e || (hist.latestDispatchedAt !== null && ms(e.observed_at) < hist.latestDispatchedAt + FRESH_AFTER_DISPATCH_MS)) throw new RepoError("EVIDENCE_LINK_INVALID");
  });
  ctx.actions.push(r.ok ? `AUTHORIZATION_GONE->${r.intent.status}` : `AUTHORIZATION_GONE!${r.error}`);
  return { delayMs: 0 };
}

async function authorizationLeg(ctx, intent, pa) {
  const voids = await rowsOf(ctx.pool, intent.id, OPS.VOID);
  if (voids.length !== 1) return escalate(ctx, intent, voids.length === 0 ? "VOID_ROW_MISSING" : "VOID_HISTORY_MULTIPLE");
  const row = voids[0];
  // unknown, or completed with its event lost (crash): reads only; the recovery pass decides (never a resend)
  if (row.state === "outcome_unknown" || row.state === "succeeded") return readsForUnknown(ctx, intent, row, OPS.PI_READ);
  if (row.state !== "pending") return wait(ctx, `VOID_${row.state.toUpperCase()}`);       // recovery pass handles it
  const caps = (await rowsOf(ctx.pool, intent.id, OPS.CAPTURE)).map(asOp);
  const hist = captureHistoryClass({ intent, captureRows: caps });
  if (!hist.ok) return escalate(ctx, intent, `HISTORY_${hist.code}`);
  if (hist.cls === "M") return escalate(ctx, intent, "CAPTURE_HISTORY_MULTIPLE");
  const pr = await readPaymentIntent(ctx, intent);
  if (!pr.ok) return wait(ctx, pr.code);
  const ev = pr.ev;
  if (isCapturedEv(ev)) return escalate(ctx, intent, "CAPTURED_WHILE_VOIDING");                 // never void / refund captured money
  const now = ctx.clock();
  if (piCanceledProofV3(ev, intent, pa, { now, notBefore: ctx.enteredAt, latestCaptureDispatchedAt: hist.latestDispatchedAt }) === null) {
    return authorizationGone(ctx, intent, ev, hist);                                           // no void: the authorization is gone
  }
  if (hist.cls === "D") return escalate(ctx, intent, "CAPTURE_SENT_BLOCKS_VOID");               // B5: never void while a sent capture is unresolved
  const elig = voidSendEligibility({ evidence: ev, intent, paymentAttemptId: pa, voidOp: asOp(row), captureRows: caps, now, notBefore: ctx.enteredAt });
  if (!elig.ok) return escalate(ctx, intent, `VOID_PROOF_${elig.code}`);
  const built = buildVoidRequest({ intent, voidOp: asOp(row), captureRows: caps, eligibility: elig, paymentAttemptId: pa, now: ctx.clock(), notBefore: ctx.enteredAt });
  if (!built.ok) return escalate(ctx, intent, `VOID_REQUEST_${built.code}`);
  const plan = Object.freeze({ intentId: intent.id, intentVersion: intent.version, status: intent.status, opId: row.id, paymentAttemptId: pa,
    historyClass: hist.cls, historyFingerprint: hist.fingerprint, evidenceIds: [ev.id], evidenceObservedAts: [ev.observedAt], enteredAt: ctx.enteredAt,
    request: built.request, latestCaptureDispatchedAt: hist.latestDispatchedAt });
  if (ctx.hooks.beforeClaim) await ctx.hooks.beforeClaim(plan);
  const op = await claimNextOperation(ctx.pool, { workerId: ctx.workerId, now: ctx.clock(), opId: row.id, opTypes: [OPS.VOID] });
  if (!op) return wait(ctx, "VOID_NOT_CLAIMED");
  ctx.actions.push("VOID_CLAIMED");
  if (ctx.hooks.afterClaim) await ctx.hooks.afterClaim(op, plan);
  const pre = await preSendCommon(ctx, plan, "authorization");
  if (pre.refusal) { ctx.actions.push(`SEND_ABORTED:${pre.refusal}`); return settleUnknown(ctx, intent, op, "authorization", `SEND_ABORTED_${pre.refusal}`); }
  if (!validateVoidRequest(plan.request, { intent: pre.intent, voidOp: pre.op }).ok) { ctx.actions.push("SEND_ABORTED:REQUEST_INVALID"); return settleUnknown(ctx, intent, op, "authorization", "SEND_ABORTED_REQUEST_INVALID"); }
  if (!(ctx.stepEndsAt - ctx.mono() > ctx.timeouts.writeCallMs)) { ctx.actions.push("SEND_ABORTED:STEP_BUDGET"); return settleUnknown(ctx, intent, op, "authorization", "SEND_ABORTED_STEP_BUDGET"); }
  // no await between the decision above and the start of the call
  const req = plan.request;
  const call = RW.startBounded(ctx, "writeCallMs", (signal) => ctx.executors.cancelPaymentIntent(req.paymentIntentId, {}, { idempotencyKey: req.options.idempotencyKey, signal }));
  ctx.calls.push(`void:${req.paymentIntentId}`); ctx.sends += 1;
  let reply; let timedOut = false; let failed = false;
  try { reply = await call.promise; } catch (e) { timedOut = e instanceof ProviderCallTimeout; failed = true; }
  if (ctx.hooks.afterSend) await ctx.hooks.afterSend(op);
  const positive = (x) => isObj(x) && x.object === "payment_intent" && x.id === req.paymentIntentId && x.status === "canceled";
  if (timedOut) {
    const settled = settleUnknown(ctx, intent, op, "authorization", "VOID_TIMEOUT");
    if (call.raw) ctx.late.push(Promise.all([call.raw.catch(() => null), settled]).then(([late]) => lateResult(ctx, op, late, positive)).catch(() => {}));
    return settled;
  }
  if (failed || !positive(reply)) return settleUnknown(ctx, intent, op, "authorization", failed ? "VOID_CALL_FAILED" : "VOID_REPLY_NOT_CANCELED");
  // a reply is never enough: ONE confirming PaymentIntent read with the STRICT canceled proof, before the row completes (I4)
  let cr;
  try { cr = await readPaymentIntent(ctx, intent); } catch { cr = { ok: false }; }
  if (!cr.ok) return settleUnknown(ctx, intent, op, "authorization", "CONFIRM_READ_FAILED");
  if (ctx.hooks.afterConfirmEvidence) await ctx.hooks.afterConfirmEvidence(op);
  const dispatchedAt = ms(op.dispatched_at);
  if (piCanceledProofV3(cr.ev, intent, pa, { now: ctx.clock(), notBefore: dispatchedAt, latestCaptureDispatchedAt: hist.latestDispatchedAt }) !== null) {
    return settleUnknown(ctx, intent, op, "authorization", "CONFIRM_READ_NOT_CANCELED");
  }
  const c = await completeOperation(ctx.pool, op.id, { workerId: ctx.workerId, now: ctx.clock(), outcome: { status: "succeeded", resultRef: req.paymentIntentId } });
  if (!c.ok) { ctx.actions.push(`LEASE_LOST:${c.error}`); return { delayMs: 0 }; }
  if (ctx.hooks.afterComplete) await ctx.hooks.afterComplete(op);
  const fence = scopeFence(ctx, intent);
  const r = await applyChecked(ctx, intent.id, { type: "VOID_SUCCEEDED", id: `op-outcome:${op.id}` }, async (cx, { before }) => {
    fence(before);
    if (!legOpen(before, "authorization")) throw new RepoError("STALE_OUT_OF_SCOPE");
    const o = (await cx.query("SELECT state FROM booking.external_operations WHERE id = $1 FOR SHARE", [op.id])).rows[0];
    if (!o || o.state !== "succeeded") throw new RepoError("STALE_OUT_OF_SCOPE");
    const e = (await cx.query(`SELECT 1 FROM booking.provider_evidence e JOIN booking.external_operations r ON r.id = e.read_operation_id
                                 WHERE e.id = $1 AND e.intent_id = $2 AND e.kind = 'payment_intent' AND e.status = 'canceled' AND r.op_type = $3
                                   AND r.payload ->> 'paymentIntentId' = $4 AND e.observed_at >= $5`,
      [cr.ev.id, intent.id, OPS.PI_READ, req.paymentIntentId, op.dispatched_at])).rowCount;
    if (e !== 1) throw new RepoError("EVIDENCE_LINK_INVALID");
  });
  ctx.actions.push(r.ok ? `VOID_SUCCEEDED->${r.intent.status}` : `VOID_SUCCEEDED!${r.error}`);
  return { delayMs: 0 };
}

// ---------------------------------------------------------------------------------------------
// reservation leg (Hostaway host-cancel)

async function reservationLeg(ctx, intent, pa) {
  const cancels = await rowsOf(ctx.pool, intent.id, OPS.CANCEL);
  if (cancels.length !== 1) return escalate(ctx, intent, cancels.length === 0 ? "CANCEL_ROW_MISSING" : "CANCEL_HISTORY_MULTIPLE");
  const row = cancels[0];
  if (row.state === "outcome_unknown" || row.state === "succeeded") return readsForUnknown(ctx, intent, row, OPS.RES_READ);
  if (row.state !== "pending") return wait(ctx, `CANCEL_${row.state.toUpperCase()}`);
  const caps = (await rowsOf(ctx.pool, intent.id, OPS.CAPTURE)).map(asOp);
  const hist = captureHistoryClass({ intent, captureRows: caps });
  if (!hist.ok) return escalate(ctx, intent, `HISTORY_${hist.code}`);
  if (hist.cls === "M") return escalate(ctx, intent, "CAPTURE_HISTORY_MULTIPLE");
  const tz = ctx.listings.get(intent.listingId).timeZone;
  const arr0 = arrivalStrictlyFuture(intent.from, tz, ctx.clock());
  if (!arr0.ok) return escalate(ctx, intent, arr0.code);
  // current reservation identity (by id; by ref when the ref is not echoed)
  const br = await readReservationById(ctx, intent);
  if (!br.ok) return wait(ctx, br.code);
  if (br.ev.status === "cancelled") return escalate(ctx, intent, "RESERVATION_ALREADY_CANCELLED_EXTERNALLY");
  if (br.ev.status !== "found_active") return escalate(ctx, intent, "RESERVATION_NOT_FOUND");
  let byRef = null;
  if (br.ev.observed.bookingRef !== intent.ref) {
    if (br.ev.observed.bookingRef != null) return escalate(ctx, intent, "BOOKING_REF_MISMATCH");
    const lk = await readReservationByRef(ctx, intent);
    if (!lk.ok) return wait(ctx, lk.code);
    byRef = lk.ev;
  }
  // fresh PaymentIntent proof of zero money received (Z/P still-authorized or canceled; D canceled only)
  const pr = await readPaymentIntent(ctx, intent);
  if (!pr.ok) return wait(ctx, pr.code);
  if (isCapturedEv(pr.ev)) return escalate(ctx, intent, "CAPTURED_DURING_CANCELLATION");
  const elig = cancelSendEligibility({ intent, paymentAttemptId: pa, cancelOp: asOp(row), captureRows: caps, byId: br.ev, byRef, piEvidence: pr.ev,
    timeZone: tz, now: ctx.clock(), notBefore: ctx.enteredAt });
  if (!elig.ok) return escalate(ctx, intent, `CANCEL_PROOF_${elig.code}`);
  const built = buildCancelRequest({ intent, cancelOp: asOp(row), captureRows: caps, eligibility: elig, paymentAttemptId: pa, timeZone: tz,
    now: ctx.clock(), notBefore: ctx.enteredAt });
  if (!built.ok) return escalate(ctx, intent, `CANCEL_REQUEST_${built.code}`);
  const plan = Object.freeze({ intentId: intent.id, intentVersion: intent.version, status: intent.status, opId: row.id, paymentAttemptId: pa,
    historyClass: hist.cls, historyFingerprint: hist.fingerprint, enteredAt: ctx.enteredAt, request: built.request, timeZone: tz, localDate: elig.snapshot.localDate,
    evidenceIds: [...elig.reservationEvidenceIds, elig.piEvidence.id], evidenceObservedAts: [...elig.reservationObservedAts, elig.piEvidence.observedAt] });
  if (ctx.hooks.beforeClaim) await ctx.hooks.beforeClaim(plan);
  const op = await claimNextOperation(ctx.pool, { workerId: ctx.workerId, now: ctx.clock(), opId: row.id, opTypes: [OPS.CANCEL] });
  if (!op) return wait(ctx, "CANCEL_NOT_CLAIMED");
  ctx.actions.push("CANCEL_CLAIMED");
  if (ctx.hooks.afterClaim) await ctx.hooks.afterClaim(op, plan);
  const pre = await preSendCommon(ctx, plan, "reservation");
  if (pre.refusal) { ctx.actions.push(`SEND_ABORTED:${pre.refusal}`); return settleUnknown(ctx, intent, op, "reservation", `SEND_ABORTED_${pre.refusal}`); }
  const arr = arrivalStrictlyFuture(pre.intent.from, tz, pre.now);
  if (!arr.ok || arr.localDate !== plan.localDate) { ctx.actions.push("SEND_ABORTED:ARRIVAL"); return settleUnknown(ctx, intent, op, "reservation", "SEND_ABORTED_ARRIVAL"); }
  if (!validateCancelRequest(plan.request, { intent: pre.intent, cancelOp: pre.op }).ok) { ctx.actions.push("SEND_ABORTED:REQUEST_INVALID"); return settleUnknown(ctx, intent, op, "reservation", "SEND_ABORTED_REQUEST_INVALID"); }
  if (!(ctx.stepEndsAt - ctx.mono() > ctx.timeouts.writeCallMs)) { ctx.actions.push("SEND_ABORTED:STEP_BUDGET"); return settleUnknown(ctx, intent, op, "reservation", "SEND_ABORTED_STEP_BUDGET"); }
  const req = plan.request;
  const rid = String(intent.reservation.reservationId);
  const call = RW.startBounded(ctx, "writeCallMs", (signal) => ctx.executors.cancelReservation(req, { signal }));
  ctx.calls.push(`cancel:${rid}`); ctx.sends += 1;
  let reply; let timedOut = false; let failed = false;
  try { reply = await call.promise; } catch (e) { timedOut = e instanceof ProviderCallTimeout; failed = true; }
  if (ctx.hooks.afterSend) await ctx.hooks.afterSend(op);
  const positive = (x) => {
    const env = isObj(x) && x.httpStatus === 200 ? unwrapEnvelope(x.json) : { ok: false };
    const n = env.ok ? normalizeReservation(env.result, ctx.cfg) : { ok: false };
    return n.ok && String(n.reservation.reservationId) === rid && n.reservation.status === "cancelled";
  };
  if (timedOut) {
    const settled = settleUnknown(ctx, intent, op, "reservation", "CANCEL_TIMEOUT");
    if (call.raw) ctx.late.push(Promise.all([call.raw.catch(() => null), settled]).then(([late]) => lateResult(ctx, op, late, positive)).catch(() => {}));
    return settled;
  }
  if (failed || !positive(reply)) return settleUnknown(ctx, intent, op, "reservation", failed ? "CANCEL_CALL_FAILED" : "CANCEL_REPLY_NOT_CANCELLED");
  // a reply is never enough: a confirming by-id read (+ ref lookup when not echoed) showing THIS reservation cancelled
  let cr; let ce = null;
  try { cr = await readReservationById(ctx, intent); } catch { cr = { ok: false }; }
  if (!cr.ok) return settleUnknown(ctx, intent, op, "reservation", "CONFIRM_READ_FAILED");
  const evIds = [cr.ev.id];
  const confirmOk = (e) => e && e.status === "cancelled" && e.externalRef === rid && reservationIdentity(e, intent, rid) === "ok" && e.observed.status === "cancelled";
  if (!confirmOk(cr.ev)) return settleUnknown(ctx, intent, op, "reservation", "CONFIRM_READ_NOT_CANCELLED");
  if (cr.ev.observed.bookingRef !== intent.ref) {
    if (cr.ev.observed.bookingRef != null) return settleUnknown(ctx, intent, op, "reservation", "CONFIRM_REF_MISMATCH");
    try { ce = await readReservationByRef(ctx, intent); } catch { ce = { ok: false }; }
    if (!ce.ok || !confirmOk(ce.ev) || ce.ev.observed.matchCount !== 1) return settleUnknown(ctx, intent, op, "reservation", "CONFIRM_LOOKUP_NOT_CANCELLED");
    evIds.push(ce.ev.id);
  }
  if (ctx.hooks.afterConfirmEvidence) await ctx.hooks.afterConfirmEvidence(op);
  const c = await completeOperation(ctx.pool, op.id, { workerId: ctx.workerId, now: ctx.clock(), outcome: { status: "succeeded", resultRef: rid } });
  if (!c.ok) { ctx.actions.push(`LEASE_LOST:${c.error}`); return { delayMs: 0 }; }
  if (ctx.hooks.afterComplete) await ctx.hooks.afterComplete(op);
  const fence = scopeFence(ctx, intent);
  const r = await applyChecked(ctx, intent.id, { type: "RESERVATION_CANCELLED", id: `op-outcome:${op.id}` }, async (cx, { before }) => {
    fence(before);
    if (!legOpen(before, "reservation")) throw new RepoError("STALE_OUT_OF_SCOPE");
    const o = (await cx.query("SELECT state FROM booking.external_operations WHERE id = $1 FOR SHARE", [op.id])).rows[0];
    if (!o || o.state !== "succeeded") throw new RepoError("STALE_OUT_OF_SCOPE");
    const n = (await cx.query(`SELECT count(*) AS n FROM booking.provider_evidence e WHERE e.id = ANY($1) AND e.intent_id = $2 AND e.kind = 'hostaway_reservation'
                                 AND e.status = 'cancelled' AND e.external_ref = $3 AND e.observed_at >= $4`, [evIds, intent.id, rid, op.dispatched_at])).rows[0].n;
    if (Number(n) !== evIds.length) throw new RepoError("EVIDENCE_LINK_INVALID");
  });
  ctx.actions.push(r.ok ? `RESERVATION_CANCELLED->${r.intent.status}` : `RESERVATION_CANCELLED!${r.error}`);
  return { delayMs: 0 };
}

// ---------------------------------------------------------------------------------------------

async function handleIntent(ctx, intent) {
  ctx.enteredAt = await stateEnteredAt(ctx.pool, intent);
  if (!Number.isFinite(ctx.enteredAt)) return escalate(ctx, intent, "STATE_ENTRY_UNKNOWN");
  if (intent.reservation && isProtectedReservationId(intent.reservation.reservationId)) return escalate(ctx, intent, "PROTECTED_RESERVATION_ID");
  const pa = await boundPaymentAttempt(ctx.pool, intent);
  if (!pa) return escalate(ctx, intent, "PAYMENT_ATTEMPT_NOT_BOUND");
  try {
    let r = null;
    if (legOpen(intent, "authorization")) {
      r = await authorizationLeg(ctx, intent, pa);
      if (!r.waiting) return r;                    // one provider write (or decision) per step
    }
    if (legOpen(intent, "reservation")) return await reservationLeg(ctx, intent, pa);
    return r || wait(ctx, "NOTHING_DUE");
  } catch (e) {
    if (e instanceof Escalate) return escalate(ctx, intent, e.code);     // never re-planned on a reloaded (possibly moved) intent
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------
// recovery pass (accepted planner) — void / cancel rows only; still-authorized / still-active are intercepted

async function recoveryPass(ctx) {
  const scope = { intentId: ctx.scopeIntentId, listingIds: ctx.listingIds };
  const missed = (await findMissedOutcomes(ctx.pool, { now: ctx.clock(), limit: CLEANUP_LIMITS.recoveryBatch, opTypes: [...WRITE_OP_TYPES], ...scope })).rows;
  for (const m of missed) {
    const facts = await loadRecoveryFacts(ctx.pool, m.opId);
    if (!facts || !WORK_STATES.includes(facts.intent.status)) continue;
    if (facts.intent.reservation && isProtectedReservationId(facts.intent.reservation.reservationId)) { await escalateRecovery(ctx, facts, "PROTECTED_RESERVATION_ID"); continue; }
    const plan = planRecovery({ ...facts, now: ctx.clock() });
    if (plan.kind === "event" && plan.event.type === "RECONCILED_STILL_AUTHORIZED") { await escalateRecovery(ctx, facts, "VOID_UNRESOLVED_STILL_AUTHORIZED"); continue; }
    if (plan.kind === "event" && plan.event.type === "RECONCILED_RESERVATION_STILL_ACTIVE") { await escalateRecovery(ctx, facts, "CANCEL_UNRESOLVED_STILL_ACTIVE"); continue; }
    if (plan.kind === "event" && plan.event.type === "VOID_SUCCEEDED") {
      // the planner accepts piGoneProof; this worker records a released authorization only on the STRICT canceled proof
      // (terminal fact: age-independent, observed after the void dispatch and >= latest capture dispatch + 2 min)
      const caps = (await rowsOf(ctx.pool, facts.intent.id, OPS.CAPTURE)).map(asOp);
      const hist = captureHistoryClass({ intent: facts.intent, captureRows: caps });
      const cited = plan.settle ? facts.evidence.find((e) => e.id === plan.settle)
        : facts.evidence.find((e) => e.readOpType === OPS.PI_READ && e.requestRef === facts.intent.payment.paymentIntentId);
      const ok = hist.ok && hist.cls !== "M" && cited && piCanceledProofV3(cited, facts.intent, facts.paymentAttemptId,
        { now: cited.observedAt, notBefore: facts.op.dispatchedAt, latestCaptureDispatchedAt: hist.latestDispatchedAt }) === null;
      if (!ok) { await escalateRecovery(ctx, facts, "VOID_PROOF_NOT_STRICT"); continue; }
    }
    if (plan.kind === "event") {
      const r = await applyRecoveryPlan(ctx.pool, plan, { now: ctx.clock() });
      ctx.actions.push(`RECOVERY:${plan.event.type}${r.ok ? "" : `!${r.error}`}`);
    } else if (plan.kind === "needs_fresh_read") {
      if (![OPS.PI_READ, OPS.RES_READ].includes(plan.read.opType)) continue;
      const r = await requestRecoveryRead(ctx.pool, m.opId, plan.read, { now: ctx.clock() });
      if (!r.ok && r.error === "RECOVERY_READS_EXHAUSTED") await escalateRecovery(ctx, facts, "RECOVERY_READS_EXHAUSTED");
      else ctx.actions.push(`RECOVERY:READ:${plan.read.opType}`);
    } else if (plan.kind === "operator") {
      await escalateRecovery(ctx, facts, plan.code);
    }
  }
  const orphans = await findOrphanReads(ctx.pool, { now: ctx.clock(), limit: CLEANUP_LIMITS.recoveryBatch, opTypes: [...READ_OP_TYPES], intentStates: [...WORK_STATES], ...scope });
  for (const o of orphans) {
    const r = await reissueOrphanRead(ctx.pool, o.readOpId, { now: ctx.clock() });
    ctx.actions.push(`RECOVERY:REISSUE${r.ok ? "" : `!${r.error}`}`);
  }
}

// ---------------------------------------------------------------------------------------------

/**
 * runCleanupStep(pool, { workerId, env, adapterConfig, listings: Map<listingId, {currency, timeZone}>, executors, clock,
 *                        stripeAccountId, intentId?, timeouts?, monotonic?, hooks? })
 *   -> { status: "refused" | "idle" | "worked", code?, intentId?, actions, calls, sends, delayMs?, late }
 */
export async function runCleanupStep(pool, opts = {}) {
  const { workerId, env, adapterConfig, listings, executors, clock, stripeAccountId, intentId: scopeIntentId = null, timeouts, hooks = {} } = opts;
  const g = compensationWorkerGate({ env, adapterConfig, listings, executors, clock, stripeAccountId });
  const none = { actions: [], calls: [], sends: 0 };
  if (!g.ok) return result("refused", { code: g.code, ...none });
  if (typeof workerId !== "string" || !/^[A-Za-z0-9._:-]{1,80}$/.test(workerId)) return result("refused", { code: "WORKER_ID_INVALID", ...none });
  try { await assertEnvironment(pool, "test"); } catch { return result("refused", { code: "DATABASE_NOT_TEST", ...none }); }
  const t = resolveTimeouts(timeouts);
  const mono = typeof opts.monotonic === "function" ? opts.monotonic : () => performance.now();
  const ctx = { pool, workerId, cfg: g.cfg, listings, listingIds: [...listings.keys()], executors, clock, hooks, scopeIntentId, stripeAccountId, timeouts: t,
    mono, stepEndsAt: mono() + t.stepBudgetMs, late: [], actions: [], calls: [], sends: 0, accountVerified: false, enteredAt: null };
  const late = () => Promise.allSettled(ctx.late);
  await recoveryPass(ctx);
  const intentId = await RW.claimWork(pool, { workerId, now: clock(), leaseMs: CLEANUP_LIMITS.workLeaseMs, states: [...WORK_STATES], intentId: scopeIntentId, listingIds: ctx.listingIds });
  if (!intentId) return result("idle", { actions: ctx.actions, calls: ctx.calls, sends: ctx.sends, late: late() });
  let delayMs = CLEANUP_LIMITS.waitMs;
  try {
    if (hooks.beforeMaintenance) await hooks.beforeMaintenance(intentId);
    await recoverExpiredOperations(pool, { now: clock(), limit: CLEANUP_LIMITS.maintenanceBatch, opTypes: [...CLEANUP_OP_TYPES], intentId, listingIds: ctx.listingIds,
      intentStates: [...WORK_STATES] });
    const intent = await loadIntent(pool, intentId);
    if (WORK_STATES.includes(intent.status)) ({ delayMs } = await handleIntent(ctx, intent));
  } finally {
    await RW.releaseWork(ctx, intentId, delayMs);
  }
  return result("worked", { intentId, actions: ctx.actions, calls: ctx.calls, sends: ctx.sends, delayMs, late: late() });
}

export const _internal = Object.freeze({ resolveTimeouts, preSendCommon, legOpen });
