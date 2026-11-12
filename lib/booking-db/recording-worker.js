// lib/booking-db/recording-worker.js — Stage E7.4b (OFFLINE / INJECTED MOCK). Bounded single-step worker that records a
// Stripe-collected payment of a payment_captured booking in Hostaway as ONE offline charge (bookkeeping only).
//
// INTERNAL LIBRARY ONLY: no route, cron, frontend, SDK client, network adapter, environment read or default provider function. Every
// provider call goes through an INJECTED executor; with none the gate refuses and nothing is claimed, read or sent.
// Contract: claude/e74b-recording-worker-contract.md revision 2 (accepted at 6f5f704) + root implementation addendum A–E.
//
// Trust: labels (accountRef / clientSnapshotId) are TRUST, never credential or account authentication; provider shapes are
// DOC-DERIVED / LIVE-UNVERIFIED; the database attests claim / completion facts, not local brands, the request body, response
// classification or the honesty of worker-stamped times. paymentMethod is explicit configuration with NO default.
// Never here: notification / refund / cancel / void, resend, new key, attempt > 1, OFFLINE_CHARGE_FAILED, admin release /
// resolution, link maintenance, inbox draining, the generic outbox dispatcher, or ANY action on protected reservations.
//
// OUTER STOP SAFETY (optional `signal` / `deadlineAt`; mirrors the reviewed cleanup-worker bounded-call / transaction-admission pattern):
//   * a stop (outer abort signal / session deadline) observable before the step starts → nothing (no query, no claim, no call);
//   * the stop state is re-checked after EVERY awaited proof / lease / evidence / claim boundary and immediately before the send;
//   * every provider call is a WORKER-LOCAL bounded call (per-call timeout ∧ remaining step budget ∧ remaining deadline ∧ the outer signal) whose
//     reply is INADMISSIBLE once a stop is observed (WorkerStop): a started call is then an unknown outcome, the late reply in-memory only;
//   * a durably completed recording is RETAINED on a stop; its SUCCESS event (OFFLINE_CHARGE_RECORDED) is admission-gated before entry and inside
//     the transaction BEFORE and AFTER its own awaited checks (RepoError STOPPED → rollback) and is finalised by a later session from fresh facts;
//   * never a resend. With both options omitted the accepted behaviour is unchanged (the step budget keeps its original enforcement points).
import { applyEvent, loadIntent, RepoError } from "./repo.js";
import {
  claimNextOperation, completeOperation, completeRecordingWithEvidence, recordProviderEvidence, recordRecordingAssessment, recoverExpiredOperations,
  requestRead, openRecordingPreflightHold, openRecordingVisibilityHold
} from "./operations.js";
import { _internal as RW, ProviderCallTimeout } from "./reservation-worker.js";   // RW.releaseWork only; provider calls use the local bounded()
import { PROTECTED_HOSTAWAY_RESERVATION_IDS, isProtectedReservationId } from "../checkout/compensation-proof.js";
import { RECOVERY_EVENT_ID } from "../checkout/recovery-plan.js";
import {
  OFFLINE_CHARGE_OP, OFFLINE_CHARGE_PROOF_VERSION, LIST_LIMIT, SNAPSHOT_MAX_AGE_MS, configRefusal, intentRefusal, assessIdentitySnapshot,
  assessChargeList, qualifyPreflight, buildOfflineChargeRequest, validateOfflineChargeRequest, assessCreateReply, assessConfirmingRead,
  freshnessRefusal, preflightListObservation
} from "../checkout/offline-charge-proof.js";

export const RECORDING_WORKER_VERSION = "e74b-recording-worker-v1";
export const OPS = Object.freeze({ RECORD: OFFLINE_CHARGE_OP, ID_READ: "hostaway.retrieve_reservation", LIST_READ: "hostaway.list_offline_charges" });
export const RECORDING_WORKER_OP_TYPES = Object.freeze([OPS.RECORD, OPS.ID_READ, OPS.LIST_READ]);
export const RECORDING_EXECUTOR_KEYS = Object.freeze(["retrieveReservation", "listOfflineCharges", "createOfflineCharge"]);
export const WORK_STATE = "payment_captured";
export const RECORDING_DEFAULT_TIMEOUTS = Object.freeze({ readCallMs: 10000, writeCallMs: 20000, stepBudgetMs: 60000, lateWindowMs: 30000 });
export const RECORDING_LIMITS = Object.freeze({
  workLeaseMs: 120 * 1000, opLeaseMs: 90 * 1000, readLeaseMs: 60 * 1000, sendMarginMs: 15 * 1000, waitMs: 30 * 1000, readRowsMax: 6,
  maxClockSkewMs: 2000, maxSkewRoundTripMs: 1000, timingWaitMs: 100, recoveryBatch: 10, maintenanceBatch: 20, exhaustionCount: 3
});
/** W-6: the ONLY codes that lead to a fenced ESCALATE (permanent DB facts / the R2-B budget). PROTECTED is a local refusal (addendum A). */
export const ESCALATE_ALLOWLIST = Object.freeze(["CAPTURED_NOT_EXACT_TOTAL", "AMOUNT_NOT_EXACT", "CURRENCY_MISMATCH", "STAY_INVALID", "REF_INVALID",
  "RESERVATION_ID_INVALID", "RECORDED_PAYMENT_TIME_AMBIGUOUS", "RECORDING_PAYLOAD_SHAPE", "PAYLOAD_RESERVATION_MISMATCH", "PAYLOAD_AMOUNT_MISMATCH",
  "PREFLIGHT_READ_BUDGET_EXHAUSTED"]);
const CONFLICT_OUTCOME = Object.freeze({ PRIOR_RECORDING_MARKER_PRESENT: "conflict_marker", MARKER_LOOKALIKE_CONFLICT: "conflict_lookalike",
  SAME_AMOUNT_PAID_UNMARKED_CONFLICT: "conflict_same_amount" });
const PREFLIGHT_REASONS = ["PREFLIGHT_CONFLICT_MARKER", "PREFLIGHT_CONFLICT_LOOKALIKE", "PREFLIGHT_CONFLICT_SAME_AMOUNT", "PREFLIGHT_EXHAUSTED"];
const LABEL_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const WORKER_RE = /^[A-Za-z0-9._:-]{1,80}$/;
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const ms = (d) => (d == null ? null : new Date(d).getTime());
const result = (status, extra = {}) => Object.freeze({ status, ...extra });
const NONE_LATE = Object.freeze({ kind: "none" });
const sanitize = (code) => (typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code) ? code : "RECORDING_WORKER_CODE_INVALID");
const sleep = (t) => new Promise((r) => setTimeout(r, t));

function resolveTimeouts(t) {
  const out = {};
  for (const [k, d] of Object.entries(RECORDING_DEFAULT_TIMEOUTS)) {
    const v = t !== null && typeof t === "object" ? t[k] : undefined;
    out[k] = Number.isFinite(v) && v > 0 ? Math.min(v, d) : d;
  }
  return Object.freeze(out);
}

// ---------------------------------------------------------------------------------------------
// gate (pure). The returned basis is a deep-frozen COPY (plain objects / arrays only; no Map) of the approved configuration, the
// executor function references and the labels: later mutation of the caller's objects cannot change what this step sends.

export function recordingWorkerGate({ env, listings, executors, clock } = {}) {
  if (!isObj(env)) return { ok: false, code: "ENV_REQUIRED" };
  if (env.VERCEL_ENV === "production") return { ok: false, code: "PRODUCTION_REFUSED" };
  if (env.VERCEL_ENV !== "development" && env.VERCEL_ENV !== "preview") return { ok: false, code: "ENVIRONMENT_NOT_ALLOWED" };
  if (env.MV_E7_RECORDING_WORKER !== "enabled") return { ok: false, code: "NOT_ENABLED" };
  if (!(listings instanceof Map) || listings.size === 0) return { ok: false, code: "LISTINGS_REQUIRED" };
  if (!isObj(executors)) return { ok: false, code: "NO_EXECUTORS" };
  for (const k of Object.keys(executors)) if (k !== "label" && !RECORDING_EXECUTOR_KEYS.includes(k)) return { ok: false, code: "EXECUTOR_NOT_ALLOWED" };
  for (const k of RECORDING_EXECUTOR_KEYS) if (typeof executors[k] !== "function") return { ok: false, code: "NO_EXECUTORS" };
  const lab = executors.label;
  if (!isObj(lab) || JSON.stringify(Object.keys(lab).sort()) !== '["accountRef","clientSnapshotId"]' || typeof lab.accountRef !== "string"
      || typeof lab.clientSnapshotId !== "string" || !LABEL_RE.test(lab.accountRef) || !LABEL_RE.test(lab.clientSnapshotId)) return { ok: false, code: "LABEL_INVALID" };
  const cfgs = {};
  for (const [id, cfg] of listings) {
    if (!isObj(cfg)) return { ok: false, code: "CONFIG_REQUIRED" };
    const copy = { ...cfg };
    const c = configRefusal(copy);
    if (c) return { ok: false, code: c };                                   // PAYMENT_METHOD_UNSET / _NOT_APPROVED / CURRENCY_NOT_APPROVED ...
    if (copy.listingId !== id) return { ok: false, code: "LISTING_KEY_MISMATCH" };
    if (copy.accountRef !== lab.accountRef) return { ok: false, code: "LABEL_ACCOUNT_MISMATCH" };
    cfgs[String(id)] = Object.freeze(copy);
  }
  if (typeof clock !== "function" || !Number.isFinite(clock())) return { ok: false, code: "CLOCK_REQUIRED" };
  const exec = Object.freeze({ retrieveReservation: executors.retrieveReservation, listOfflineCharges: executors.listOfflineCharges,
    createOfflineCharge: executors.createOfflineCharge });
  const basis = Object.freeze({ cfgs: Object.freeze(cfgs), listingIds: Object.freeze(Object.keys(cfgs).map(Number)), exec,
    label: Object.freeze({ accountRef: lab.accountRef, clientSnapshotId: lab.clientSnapshotId }) });
  return { ok: true, basis };
}

// ---------------------------------------------------------------------------------------------
// facts (fresh DB reads; nothing cached across steps)

const recordingRows = async (q, intentId) => (await q.query(
  `SELECT o.*, booking_attempt.n AS attempt_no FROM booking.external_operations o
     CROSS JOIN LATERAL (SELECT CASE WHEN o.idempotency_key ~ '^och:[0-9a-f-]{36}:[1-9][0-9]{0,8}$' THEN split_part(o.idempotency_key, ':', 3)::int END AS n) booking_attempt
    WHERE o.intent_id = $1 AND o.op_type = $2
    ORDER BY booking_attempt.n DESC NULLS LAST, o.created_at DESC, o.id DESC`, [intentId, OPS.RECORD])).rows;
const activeHold = async (q, opId) => (await q.query("SELECT id, reason FROM booking.recording_holds WHERE operation_id = $1 AND released_at IS NULL", [opId])).rows[0] || null;
const epochOf = async (q, opId) => Number((await q.query(
  `SELECT count(*) AS n FROM booking.recording_holds WHERE operation_id = $1 AND released_at IS NOT NULL AND reason = ANY($2)`, [opId, PREFLIGHT_REASONS])).rows[0].n);

/** W-3: the DB-stamped entry into payment_captured (unique), else null. NOT Stripe's capture instant (TRUST). */
async function recordedPaymentAt(q, intentId) {
  const r = await q.query(`SELECT recorded_at FROM booking.intent_transitions WHERE intent_id = $1 AND to_state = 'payment_captured'
                             AND from_state IS DISTINCT FROM 'payment_captured'`, [intentId]);
  return r.rowCount === 1 ? ms(r.rows[0].recorded_at) : null;
}
/** The pure-module intent facts from a fresh DB read. -> { facts, intent, code? } */
async function loadFacts(ctx, intentId) {
  const i = await loadIntent(ctx.pool, intentId);
  if (!i) return { code: "INTENT_NOT_FOUND" };
  const at = await recordedPaymentAt(ctx.pool, intentId);
  const facts = Object.freeze({ capturedMinor: i.payment ? i.payment.capturedMinor : null, currency: i.price ? i.price.currency : null,
    finalTotalMinor: i.price ? i.price.finalTotalMinor : null, from: i.from, intentId: i.id, listingId: i.listingId, recordedPaymentAt: at, ref: i.ref,
    reservationId: i.reservation ? String(i.reservation.reservationId) : null, status: i.status, to: i.to, version: i.version });
  return { facts, intent: i, code: at === null && i.status === WORK_STATE ? "RECORDED_PAYMENT_TIME_AMBIGUOUS" : null };
}
const pureOp = (r) => Object.freeze({ attempts: r.attempts, dispatchedAt: ms(r.dispatched_at), id: r.id, idempotencyKey: r.idempotency_key,
  opType: r.op_type, payload: r.payload, state: r.state });

// ---------------------------------------------------------------------------------------------
// outer stop checks (abort signal / session deadline): never a new claim, send or success event after one fires

/** a stop observed at a provider-call boundary: the awaited reply is inadmissible */
export class WorkerStop extends Error { constructor(code) { super(`WORKER_STOP_${code}`); this.name = "WorkerStop"; this.code = code; } }
function stopCode(ctx) {
  if (ctx.signal !== null && ctx.signal.aborted === true) return "SIGNAL";
  if (ctx.deadlineAt !== null && ctx.clock() >= ctx.deadlineAt) return "DEADLINE";
  return null;
}
function noteStop(ctx, code, where) {
  if (!ctx.stop) { ctx.stop = Object.freeze({ code, where }); ctx.actions.push(`STOP:${code}:${where}`); }
  return ctx.stop;
}
/** a stop already noted, or one observable now → non-null (the caller does nothing more on this path) */
function stopped(ctx, where) {
  if (ctx.stop) return ctx.stop;
  const c = stopCode(ctx);
  return c ? noteStop(ctx, c, where) : null;
}
/**
 * WORKER-LOCAL bounded provider call: starts ONE call now (no await before it) bounded by min(per-call timeout, remaining step budget, remaining
 * deadline) AND the outer abort signal; re-checks the stop state when the reply settles — a reply after a stop is INADMISSIBLE (WorkerStop).
 * Without signal / deadline this is exactly the accepted reservation-worker startBounded (ProviderCallTimeout on the per-call / step budget).
 * -> { promise (result | provider error | ProviderCallTimeout | WorkerStop), raw (the executor's own promise; late bookkeeping only) }
 */
function bounded(ctx, kind, fn) {
  const pre = stopCode(ctx);
  if (pre) return { promise: Promise.reject(new WorkerStop(pre)), raw: null };
  const budgets = [ctx.timeouts[kind], ctx.stepEndsAt - ctx.mono()];
  if (ctx.deadlineAt !== null) budgets.push(ctx.deadlineAt - ctx.clock());
  const ms = Math.min(...budgets);
  if (!(ms > 0)) return { promise: Promise.reject(ctx.deadlineAt !== null && !(ctx.deadlineAt - ctx.clock() > 0) ? new WorkerStop("DEADLINE") : new ProviderCallTimeout()), raw: null };
  const ac = new AbortController();
  let raw;
  try { raw = Promise.resolve(fn(ac.signal)); } catch (e) { raw = Promise.reject(e); }
  raw.catch(() => {});                                                   // observed below / by observeLate; never an unhandled rejection
  const promise = new Promise((resolve, reject) => {
    let done = false; let timer = null;
    const onAbort = () => finish(() => { ac.abort(); reject(new WorkerStop("SIGNAL")); });
    const finish = (f) => { if (done) return; done = true; if (timer) clearTimeout(timer); if (ctx.signal && typeof ctx.signal.removeEventListener === "function") ctx.signal.removeEventListener("abort", onAbort); f(); };
    raw.then((v) => finish(() => { const sc = stopCode(ctx); if (sc) reject(new WorkerStop(sc)); else resolve(v); }),
      (e) => finish(() => { const sc = stopCode(ctx); reject(sc ? new WorkerStop(sc) : e); }));
    timer = setTimeout(() => finish(() => { ac.abort(); const sc = stopCode(ctx); reject(sc ? new WorkerStop(sc) : new ProviderCallTimeout()); }), ms);
    if (ctx.signal) { if (ctx.signal.aborted) onAbort(); else if (typeof ctx.signal.addEventListener === "function") ctx.signal.addEventListener("abort", onAbort, { once: true }); }
  });
  promise.catch(() => {});
  return { promise, raw };
}

// ---------------------------------------------------------------------------------------------
// fenced events (applyEvent inside the intent transaction; RepoError -> acknowledged refusal; anything else propagates)

async function fencedEvent(ctx, intentId, event, actor, check) {
  // SUCCESS-event admission (OFFLINE_CHARGE_RECORDED): refused before entry and inside the transaction BEFORE and AFTER its own awaited checks; a stop
  // observed during the transaction's proof vetoes the event (rollback, nothing mutated). Bookkeeping events (ESCALATE) are not gated.
  const success = event.type === "OFFLINE_CHARGE_RECORDED";
  const gate = (at) => { if (!success) return; const st = stopped(ctx, at); if (st) throw new RepoError("STOPPED"); };
  try {
    gate(`before_${event.type}`);
    return await applyEvent(ctx.pool, intentId, event, { now: ctx.clock(), actor, ...(actor === "worker" ? { workerId: ctx.workerId } : {}),
      inTx: async (c, info) => {
        gate(`in_tx_${event.type}`);
        if (actor === "worker") {
          const w = (await c.query("SELECT work_worker_id, work_lease_until FROM booking.intent_work WHERE intent_id = $1 FOR SHARE", [intentId])).rows[0];
          if (!w || w.work_worker_id !== ctx.workerId || !(ms(w.work_lease_until) >= ctx.clock())) throw new RepoError("WORK_LEASE_LOST");
        }
        const b = info.before;
        if (b.status !== WORK_STATE || !ctx.basis.listingIds.includes(b.listingId) || (ctx.scopeIntentId && b.id !== ctx.scopeIntentId)
            || !b.reservation || isProtectedReservationId(b.reservation.reservationId)) throw new RepoError("STALE_OUT_OF_SCOPE");
        await check(c, info);
        gate(`in_tx_after_checks_${event.type}`);           // a stop that arrived during the awaited proof queries vetoes the event (rollback)
      } });
  } catch (e) {
    if (e instanceof RepoError && /^[A-Z_]+$/.test(e.code)) return { ok: false, error: e.code };
    throw e;
  }
}
/** W-6: escalation only for an allowlisted permanent fact, fenced on the planned version, scope and this worker's lease. */
async function escalate(ctx, planned, code) {
  if (!ESCALATE_ALLOWLIST.includes(code)) { ctx.actions.push(`STOP:${sanitize(code)}`); return { delayMs: RECORDING_LIMITS.waitMs }; }
  const r = await fencedEvent(ctx, planned.id, { type: "ESCALATE", id: `rw-escalate:${planned.id}:${code}:v${planned.version}`, code: `RECORDING_${code}` },
    "worker", async (_c, { before }) => { if (before.version !== planned.version) throw new RepoError("STALE_OUT_OF_SCOPE"); });
  ctx.actions.push(r.ok ? `ESCALATE:RECORDING_${code}` : `ESCALATE!${r.error}`);
  return { delayMs: RECORDING_LIMITS.waitMs };
}
/** S14 / recovery: OFFLINE_CHARGE_RECORDED for the latest recording, succeeded + LINKED + same result, no active hold. */
async function finalise(ctx, intentId, opId, chargeId, actor) {
  if (actor === "worker" && ctx.hooks.beforeEvent) await ctx.hooks.beforeEvent(opId);
  const r = await fencedEvent(ctx, intentId, { type: "OFFLINE_CHARGE_RECORDED", id: RECOVERY_EVENT_ID.outcome(opId), chargeId }, actor, async (c) => {
    const o = (await c.query("SELECT state, result_ref, settled_evidence_id FROM booking.external_operations WHERE id = $1 FOR SHARE", [opId])).rows[0];
    if (!o || o.state !== "succeeded" || o.result_ref !== chargeId || o.settled_evidence_id === null) throw new RepoError("STALE_RECORDING_EVENT");
    if ((await c.query("SELECT 1 FROM booking.recording_holds WHERE operation_id = $1 AND released_at IS NULL", [opId])).rowCount) throw new RepoError("RECORDING_HOLD_ACTIVE");
  });
  ctx.actions.push(!r.ok ? `RECORDED!${r.error}` : r.duplicate ? "RECORDED:DUPLICATE" : `RECORDED->${r.intent.status}`);
  return { delayMs: 0 };
}

// ---------------------------------------------------------------------------------------------
// maintenance / recovery / work selection: scoped in THIS worker's SQL (listings, state, optional intent, protected EXCLUDED) before any
// LIMIT and before any mutation; the accepted helpers are then invoked per selected allowed intent (addendum A).

const SCOPE_SQL = `i.state = '${WORK_STATE}' AND i.listing_id = ANY($1::int[]) AND ($2::uuid IS NULL OR i.id = $2)
  AND (i.hostaway_reservation_id IS NULL OR NOT (i.hostaway_reservation_id = ANY($3::text[])))`;
const scopeArgs = (ctx) => [ctx.basis.listingIds, ctx.scopeIntentId, [...PROTECTED_HOSTAWAY_RESERVATION_IDS]];

async function maintenance(ctx) {
  const ids = (await ctx.pool.query(
    `SELECT DISTINCT i.id FROM booking.intents i JOIN booking.external_operations o ON o.intent_id = i.id
      WHERE ${SCOPE_SQL} AND o.state = 'in_flight' AND o.lease_until < $4 AND o.op_type = ANY($5::text[])
      ORDER BY i.id LIMIT $6`, [...scopeArgs(ctx), new Date(ctx.clock()), [...RECORDING_WORKER_OP_TYPES], RECORDING_LIMITS.maintenanceBatch])).rows.map((r) => r.id);
  for (const id of ids) {
    const out = await recoverExpiredOperations(ctx.pool, { now: ctx.clock(), limit: RECORDING_LIMITS.maintenanceBatch, opTypes: [...RECORDING_WORKER_OP_TYPES],
      intentId: id, listingIds: [...ctx.basis.listingIds], intentStates: [WORK_STATE] });
    for (const o of out) ctx.actions.push(`MAINTENANCE:${o.opType}:${o.state}`);
  }
}
/** W-7: only OFFLINE_CHARGE_RECORDED for a succeeded + linked latest recording with no active hold. */
async function recoveryPass(ctx) {
  const rows = (await ctx.pool.query(
    `SELECT i.id AS intent_id, l.id AS op_id, l.result_ref FROM booking.intents i
       CROSS JOIN LATERAL (SELECT o.* FROM booking.external_operations o WHERE o.intent_id = i.id AND o.op_type = $4
                            ORDER BY CASE WHEN o.idempotency_key ~ '^och:[0-9a-f-]{36}:[1-9][0-9]{0,8}$' THEN split_part(o.idempotency_key, ':', 3)::int END DESC NULLS LAST,
                                     o.created_at DESC, o.id DESC LIMIT 1) l
      WHERE ${SCOPE_SQL} AND l.state = 'succeeded' AND l.settled_evidence_id IS NOT NULL AND l.result_ref IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM booking.recording_holds h WHERE h.operation_id = l.id AND h.released_at IS NULL)
      ORDER BY i.id LIMIT $5`, [...scopeArgs(ctx), OPS.RECORD, RECORDING_LIMITS.recoveryBatch])).rows;
  for (const r of rows) await finalise(ctx, r.intent_id, r.op_id, r.result_ref, "reconciler");
}
async function claimWork(ctx) {
  const r = await ctx.pool.query(
    `WITH c AS (
       SELECT w.intent_id FROM booking.intent_work w JOIN booking.intents i ON i.id = w.intent_id
        WHERE ${SCOPE_SQL} AND w.next_action_at <= $4 AND (w.work_lease_until IS NULL OR w.work_lease_until < $4)
        ORDER BY w.next_action_at, w.intent_id FOR UPDATE OF w SKIP LOCKED LIMIT 1)
     UPDATE booking.intent_work w SET work_worker_id = $5, work_lease_until = $6 FROM c WHERE w.intent_id = c.intent_id RETURNING w.intent_id`,
    [...scopeArgs(ctx), new Date(ctx.clock()), ctx.workerId, new Date(ctx.clock() + RECORDING_LIMITS.workLeaseMs)]);
  return r.rows[0]?.intent_id ?? null;
}

// ---------------------------------------------------------------------------------------------
// provider calls (bounded; injected; never inside a DB transaction)

/** -> { response } | { transport: 'TIMEOUT' | 'THROW' | 'SHAPE' | 'STOPPED' }. A response is any object with an integer httpStatus and an own json key.
 *  STOPPED: a stop (signal / deadline) observed before the call started or before its reply settled — the reply is inadmissible. */
async function callRead(ctx, key, request) {
  ctx.calls.push(`${key}`);
  let resp;
  try { resp = await bounded(ctx, "readCallMs", (signal) => ctx.basis.exec[key](request, { signal })).promise; }
  catch (e) {
    if (e instanceof WorkerStop) { noteStop(ctx, e.code, `read_${key}`); return { transport: "STOPPED" }; }
    return { transport: e instanceof ProviderCallTimeout ? "TIMEOUT" : "THROW" };
  }
  if (!isObj(resp) || !Number.isSafeInteger(resp.httpStatus) || !Object.prototype.hasOwnProperty.call(resp, "json")) return { transport: "SHAPE" };
  return { response: resp };
}
const ID_REQUEST = (rid) => Object.freeze({ method: "GET", path: `/v1/reservations/${rid}`, query: Object.freeze({}) });
const LIST_REQUEST = (rid) => Object.freeze({ method: "GET", path: "/v1/guestPayments/charges", query: Object.freeze({ reservationId: rid, limit: LIST_LIMIT }) });

/** Clock must be strictly past a DB instant (full precision compared IN SQL); bounded wait, never a manufactured timestamp. */
async function clockPast(ctx, sqlInstant, args) {
  const end = ctx.mono() + RECORDING_LIMITS.timingWaitMs;
  for (;;) {
    const ok = (await ctx.pool.query(`SELECT $1::timestamptz > (${sqlInstant}) AS ok`, [new Date(ctx.clock()), ...args])).rows[0].ok;
    if (ok !== false) return true;                                         // NULL (no floor) or past
    if (ctx.mono() > end) return false;
    await sleep(2);
  }
}

// ---------------------------------------------------------------------------------------------
// R2: read lifecycle — one reused same-selector candidate above the floor F, next_attempt_at / max_attempts obeyed, escalated rows cited
// once while DB-fresh, a bounded number of NEW rows per (intent, type, epoch, version).

/** F = max(recording created_at, the current version's DB-stamped transition, the DB-stamped release that opened the current epoch); full precision. */
const floorSql = (op, intent) => `greatest(
    (SELECT created_at FROM booking.external_operations WHERE id = ${op}::uuid),
    (SELECT t.recorded_at FROM booking.intent_transitions t JOIN booking.intents i ON i.id = t.intent_id AND t.version_after = i.version WHERE t.intent_id = ${intent}::uuid),
    coalesce((SELECT max(d.recorded_at) FROM booking.recording_holds h JOIN booking.recording_hold_decisions d ON d.id = h.release_decision_id
               WHERE h.operation_id = ${op}::uuid AND d.decision = 'release_for_initial_send'), '-infinity'::timestamptz))`;

/** Rows of type t above F (full DB precision), with candidacy facts. */
async function readRows(ctx, opId, intentId, rid, t) {
  return (await ctx.pool.query(
    `WITH f AS (SELECT ${floorSql("$1", "$2")} AS floor)
     SELECT r.id, r.state, r.attempts, r.max_attempts, r.next_attempt_at, r.created_at,
            (r.state = 'escalated' AND r.updated_at >= clock_timestamp() - interval '2 minutes' AND r.updated_at <= clock_timestamp()) AS fresh_escalated,
            EXISTS (SELECT 1 FROM booking.provider_evidence e WHERE e.read_operation_id = r.id) AS has_evidence,
            EXISTS (SELECT 1 FROM booking.recording_assessments a WHERE a.identity_read_op = r.id OR a.list_read_op = r.id) AS cited
       FROM booking.external_operations r, f
      WHERE r.intent_id = $2 AND r.op_type = $3 AND r.retry_class = 'read' AND r.payload = jsonb_build_object('reservationId', $4::text)
        AND r.created_at > f.floor
      ORDER BY r.created_at, r.id`, [opId, intentId, t, rid])).rows;
}

/** -> { kind:'cite', readId } | { kind:'claimed', op } | { kind:'wait', delayMs, code } | { kind:'stop', code } | { kind:'budget' } */
async function selectRead(ctx, opId, intentId, rid, t) {
  const rows = await readRows(ctx, opId, intentId, rid, t);
  // R-C2: a known-ambiguous history (more than one open candidate) stops FIRST — before any exhausted row is cited or anything is claimed / created
  const open = rows.filter((r) => r.state === "pending" || r.state === "in_flight");
  if (open.length > 1) return { kind: "stop", code: "READ_ROWS_AMBIGUOUS" };
  const esc = rows.filter((r) => r.fresh_escalated && !r.cited && !r.has_evidence);
  if (esc.length) return { kind: "cite", readId: esc[esc.length - 1].id };
  if (open.length === 1) {
    const o = open[0];
    if (o.state === "in_flight") return { kind: "wait", delayMs: RECORDING_LIMITS.waitMs, code: "READ_IN_FLIGHT" };
    const due = ms(o.next_attempt_at);
    if (due > ctx.clock()) return { kind: "wait", delayMs: due - ctx.clock(), code: "READ_NOT_DUE" };
    const op = await claimNextOperation(ctx.pool, { workerId: ctx.workerId, now: ctx.clock(), opId: o.id, opTypes: [t], leaseMs: RECORDING_LIMITS.readLeaseMs });
    return op ? { kind: "claimed", op } : { kind: "wait", delayMs: RECORDING_LIMITS.waitMs, code: "READ_NOT_CLAIMED" };
  }
  if (rows.length >= RECORDING_LIMITS.readRowsMax) return { kind: "budget" };
  if (!(await clockPast(ctx, floorSql("$2", "$3"), [opId, intentId]))) {
    return { kind: "wait", delayMs: RECORDING_LIMITS.waitMs, code: "TIMING_FLOOR" };
  }
  const id = await requestRead(ctx.pool, intentId, t, rid, { now: ctx.clock() });
  const op = await claimNextOperation(ctx.pool, { workerId: ctx.workerId, now: ctx.clock(), opId: id, opTypes: [t], leaseMs: RECORDING_LIMITS.readLeaseMs });
  return op ? { kind: "claimed", op } : { kind: "wait", delayMs: RECORDING_LIMITS.waitMs, code: "READ_NOT_CLAIMED" };
}

/**
 * One read phase. -> { kind:'positive' | 'complete', readId, evidenceId, branded } | { kind:'refused', readId, code } |
 *   { kind:'escalated', readId } | { kind:'wait', delayMs, code } | { kind:'stop', code } | { kind:'budget' } | { kind:'stopped' } (outer stop noted)
 */
async function readPhase(ctx, p, t) {
  const sel = await selectRead(ctx, p.op.id, p.facts.intentId, p.facts.reservationId, t);
  if (sel.kind === "cite") return { kind: "escalated", readId: sel.readId };
  if (sel.kind !== "claimed") return sel;
  const read = sel.op;
  const isId = t === OPS.ID_READ;
  if (stopped(ctx, `after_read_claim_${isId ? "id" : "list"}`)) return { kind: "stopped" };      // claimed read row left to its lease (recoverExpiredOperations)
  const out = await callRead(ctx, isId ? "retrieveReservation" : "listOfflineCharges", isId ? ID_REQUEST(p.facts.reservationId) : LIST_REQUEST(p.facts.reservationId));
  if (ctx.hooks.afterRead) await ctx.hooks.afterRead(t, read.id);
  if (out.transport) {
    // uncounted until the SAME row escalates (attempts >= max_attempts) through markUnknown
    const u = await completeOperation(ctx.pool, read.id, { workerId: ctx.workerId, now: ctx.clock(), outcome: { status: "outcome_unknown", errorCode: `READ_TRANSPORT_${out.transport}` } });
    ctx.actions.push(`READ:${isId ? "ID" : "LIST"}:TRANSPORT_${out.transport}${u.ok ? `:${u.state}` : `!${u.error}`}`);
    if (out.transport === "STOPPED") return { kind: "stopped" };          // the reply was inadmissible; nothing more in this step
    if (u.ok && u.state === "escalated") return { kind: "escalated", readId: read.id };
    return { kind: "wait", delayMs: RECORDING_LIMITS.waitMs, code: "READ_TRANSPORT" };
  }
  const T = ctx.clock();
  const snap = { accountRef: ctx.basis.label.accountRef, clientSnapshotId: ctx.basis.label.clientSnapshotId, httpStatus: out.response.httpStatus,
    json: out.response.json, observedAt: T };
  const a = isId ? assessIdentitySnapshot({ snapshot: snap, intent: p.facts, config: p.cfg, now: T })
    : assessChargeList({ read: { ...snap, request: { limit: LIST_LIMIT, reservationId: p.facts.reservationId } }, intent: p.facts, config: p.cfg, now: T });
  const done = await completeOperation(ctx.pool, read.id, { workerId: ctx.workerId, now: T, outcome: { status: "succeeded", errorCode: a.ok ? null : sanitize(a.code) } });
  if (!done.ok) { ctx.actions.push(`READ:LEASE!${done.error}`); return { kind: "wait", delayMs: RECORDING_LIMITS.waitMs, code: "READ_LEASE_LOST" }; }
  if (stopped(ctx, `after_read_${isId ? "id" : "list"}`)) return { kind: "stopped" };           // the completed read stays persisted (no evidence, no assessment)
  if (!a.ok) { ctx.actions.push(`READ:${isId ? "ID" : "LIST"}:${a.code}`); return { kind: "refused", readId: read.id, code: a.code }; }
  // evidence ONLY for a positive identity / a complete page; observed_at := the read's completion time T
  const observed = isId ? { ...a.observed, executorAccountRef: a.accountRef, clientSnapshotId: a.clientSnapshotId }
    : preflightListObservation({ list: a, intent: p.facts, config: p.cfg });
  if (observed.ok === false) { ctx.actions.push(`READ:LIST:${observed.code}`); return { kind: "stop", code: observed.code }; }
  const ev = await recordProviderEvidence(ctx.pool, { readOpId: read.id, kind: isId ? "hostaway_reservation" : "hostaway_offline_charges",
    externalRef: p.facts.reservationId, status: isId ? "found_active" : "listed", observed: { ...observed, ...(isId ? {} : { matchingChargeIds: [...observed.matchingChargeIds] }) } });
  if (!ev.ok) { ctx.actions.push(`EVIDENCE!${ev.error}`); return { kind: "stop", code: "EVIDENCE_NOT_RECORDED" }; }
  if (ctx.hooks.afterEvidence) await ctx.hooks.afterEvidence(t, ev.id);
  if (stopped(ctx, `after_evidence_${isId ? "id" : "list"}`)) return { kind: "stopped" };      // evidence persisted; a later session re-reads fresh
  ctx.actions.push(`READ:${isId ? "ID" : "LIST"}:OK`);
  return { kind: isId ? "positive" : "complete", readId: read.id, evidenceId: ev.id, branded: a };
}

/** List-first iff the latest list row above F is open with attempts >= 1, or escalated (cited or not): after a list failure the identity read
 *  runs only once the list responded or escalated, so identity rows are not consumed by list transport failures (contract §4.3). */
async function listFirst(ctx, p) {
  const rows = await readRows(ctx, p.op.id, p.facts.intentId, p.facts.reservationId, OPS.LIST_READ);
  const last = rows[rows.length - 1];
  return !!last && (((last.state === "pending" || last.state === "in_flight") && last.attempts >= 1) || last.state === "escalated");
}

// ---------------------------------------------------------------------------------------------
// assessments

async function persist(ctx, p, outcome, code, { idRead, listRead = null, idEv = null, listEv = null }) {
  const r = await recordRecordingAssessment(ctx.pool, p.op.id, { workerId: ctx.workerId, outcome, code, identityReadId: idRead, listReadId: listRead,
    identityEvidenceId: idEv, listEvidenceId: listEv, expectedVersion: p.facts.version, moduleVersion: OFFLINE_CHARGE_PROOF_VERSION,
    clientLabel: ctx.basis.label.clientSnapshotId, accountRef: p.cfg.accountRef, config: { ...p.cfg } });
  ctx.actions.push(r.ok ? `ASSESSED:${outcome}${code ? `:${code}` : ""}` : `ASSESS!${r.error}`);
  if (r.ok && ctx.hooks.afterAssessment) await ctx.hooks.afterAssessment(r.id, outcome);
  return r;
}
async function latchHold(ctx, p) {
  const n = Number((await ctx.pool.query(
    `SELECT count(*) AS n FROM booking.recording_assessments WHERE operation_id = $1 AND phase = 'preflight' AND epoch = $2
        AND outcome IN ('incomplete', 'identity_refused')`, [p.op.id, p.epoch])).rows[0].n);
  const c = Number((await ctx.pool.query(
    `SELECT count(*) AS n FROM booking.recording_assessments WHERE operation_id = $1 AND phase = 'preflight' AND epoch = $2
        AND outcome IN ('conflict_marker', 'conflict_lookalike', 'conflict_same_amount')`, [p.op.id, p.epoch])).rows[0].n);
  if (c === 0 && n < RECORDING_LIMITS.exhaustionCount) return;
  const h = await openRecordingPreflightHold(ctx.pool, p.op.id, { by: `recording-worker:${ctx.workerId}` });
  ctx.actions.push(h.ok ? "HOLD:PREFLIGHT" : `HOLD!${h.error}`);
}
async function afterPersist(ctx, p, r) {
  if (!r.ok) {
    if (r.error === "ASSESSMENT_EPOCH_CONFLICTED" || r.error === "ASSESSMENT_EPOCH_EXHAUSTED") {
      const h = await openRecordingPreflightHold(ctx.pool, p.op.id, { by: `recording-worker:${ctx.workerId}` });
      ctx.actions.push(h.ok ? "HOLD:PREFLIGHT" : `HOLD!${h.error}`);
    }
    return { delayMs: RECORDING_LIMITS.waitMs };
  }
  await latchHold(ctx, p);
  return { delayMs: 0 };
}
async function catalogued(ctx, outcome, code) {
  return (await ctx.pool.query("SELECT 1 FROM booking.recording_assessment_codes WHERE outcome = $1 AND code = $2", [outcome, code])).rowCount === 1;
}

// ---------------------------------------------------------------------------------------------
// the send path

/** ONE unknown settlement per op per step (§6.3); never recursive. */
async function settleUnknown(ctx, opId, code) {
  if (ctx.settled.has(opId)) return { delayMs: 0 };
  ctx.settled.add(opId);
  const c = sanitize(code);
  const u = await completeOperation(ctx.pool, opId, { workerId: ctx.workerId, now: ctx.clock(), outcome: { status: "outcome_unknown", errorCode: c } });
  ctx.actions.push(u.ok ? `UNKNOWN:${c}` : `UNKNOWN!${u.error}`);
  return { delayMs: 0 };
}

/** S9: fresh rows, clock read AFTER them. -> null (send) | refusal code. */
async function finalCheck(ctx, p, op, plan) {
  const o = (await ctx.pool.query("SELECT * FROM booking.external_operations WHERE id = $1", [op.id])).rows[0];
  const latest = (await recordingRows(ctx.pool, p.facts.intentId))[0];
  const hold = await activeHold(ctx.pool, op.id);
  const audit = (await ctx.pool.query("SELECT * FROM booking.recording_claim_assessments WHERE operation_id = $1", [op.id])).rows[0];
  const a = (await ctx.pool.query("SELECT * FROM booking.recording_assessments WHERE id = $1", [plan.assessmentId])).rows[0];
  const epoch = await epochOf(ctx.pool, op.id);
  const w = (await ctx.pool.query("SELECT work_worker_id, work_lease_until FROM booking.intent_work WHERE intent_id = $1", [p.facts.intentId])).rows[0];
  const lf = await loadFacts(ctx, p.facts.intentId);
  const now = ctx.clock();
  const room = ctx.timeouts.writeCallMs + ctx.timeouts.readCallMs + RECORDING_LIMITS.sendMarginMs;
  const rec = plan.eligibility.recording;
  // 1. recording identity, field by field (proof recordingIdentity) + live row state
  if (!o || rec.opId !== o.id || rec.opType !== o.op_type || rec.idempotencyKey !== o.idempotency_key || !isObj(o.payload)
      || JSON.stringify(Object.keys(o.payload).sort()) !== '["amountMinor","reservationId"]' || rec.payloadReservationId !== o.payload.reservationId
      || rec.payloadAmountMinor !== o.payload.amountMinor) return "RECORDING_IDENTITY_CHANGED";
  if (o.state !== "in_flight" || o.lease_worker_id !== ctx.workerId || o.attempts !== 1 || o.dispatched_at === null) return "OPERATION_NOT_HELD";
  if (!(ms(o.lease_until) - now > room)) return "OPERATION_LEASE_TOO_SHORT";
  if (!latest || latest.id !== o.id) return "NOT_LATEST";
  if (hold) return "HOLD_ACTIVE";
  // 2. claim audit binds THIS step's assessment
  if (!audit || audit.assessment_id !== plan.assessmentId || audit.worker !== ctx.workerId || audit.epoch !== epoch) return "CLAIM_ASSESSMENT_BINDING";
  // 3. the assessment A
  if (!a || a.operation_id !== o.id || a.phase !== "preflight" || a.outcome !== "eligible" || a.worker !== ctx.workerId || a.epoch !== epoch
      || JSON.stringify(sortKeys(a.cfg)) !== JSON.stringify(sortKeys(p.cfg)) || a.account_ref !== ctx.basis.label.accountRef || a.account_ref !== p.cfg.accountRef
      || a.client_label !== plan.eligibility.clientSnapshotId || a.intent_version !== plan.eligibility.context.version
      || a.module_version !== OFFLINE_CHARGE_PROOF_VERSION || a.identity_read_op !== plan.idRead || a.list_read_op !== plan.listRead
      || a.identity_evidence !== plan.idEv || a.list_evidence !== plan.listEv) return "ASSESSMENT_BINDING";
  // 4. intent facts == the eligibility context; scope
  const f = lf.facts;
  if (!f || lf.code) return "INTENT_CHANGED";
  const ctxNow = plan.eligibility.context;
  if (f.status !== WORK_STATE || f.version !== ctxNow.version || f.intentId !== ctxNow.intentId || f.ref !== ctxNow.ref || f.listingId !== ctxNow.listingId
      || f.from !== ctxNow.from || f.to !== ctxNow.to || f.finalTotalMinor !== ctxNow.finalTotalMinor || f.capturedMinor !== ctxNow.capturedMinor
      || f.currency !== ctxNow.currency || f.reservationId !== ctxNow.reservationId || f.recordedPaymentAt !== ctxNow.recordedPaymentAt) return "INTENT_CHANGED";
  if (lf.intent.counters.offlineChargeAttempts !== 0) return "INTENT_CHANGED";
  if (!ctx.basis.cfgs[String(f.listingId)] || ctx.basis.cfgs[String(f.listingId)] !== p.cfg) return "OUT_OF_SCOPE";
  if (isProtectedReservationId(f.reservationId)) return "PROTECTED_RESERVATION_ID";
  // 5. work lease
  if (!w || w.work_worker_id !== ctx.workerId || !(ms(w.work_lease_until) - now > room)) return "WORK_LEASE";
  // 6. carried freshness
  if (freshnessRefusal(plan.eligibility.identityObservedAt, now) || freshnessRefusal(plan.eligibility.listObservedAt, now)) return "PREFLIGHT_STALE";
  // 7. request
  if (plan.request !== plan.eligibility.request || !validateOfflineChargeRequest(plan.request, { intent: f, config: p.cfg }).ok) return "REQUEST_INVALID";
  // 8. budget
  if (!(ctx.stepEndsAt - ctx.mono() > ctx.timeouts.writeCallMs)) return "STEP_BUDGET";
  return null;
}
const sortKeys = (o) => (isObj(o) ? Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]])) : o);

async function sendAndConfirm(ctx, p, op, plan) {
  if (ctx.hooks.beforeFinalCheck) await ctx.hooks.beforeFinalCheck(op);
  const refused = await finalCheck(ctx, p, op, plan);
  if (refused) { ctx.actions.push(`SEND_ABORTED:${refused}`); return settleUnknown(ctx, op.id, `SEND_ABORTED_${refused}`); }
  // outer stop observed after the claim / during the final check: the claimed row is "possibly sent" for every other actor → §6.1 unknown settlement, no send
  const st = stopped(ctx, "before_send");
  if (st) { ctx.actions.push(`SEND_ABORTED:STOP_${st.code}`); return settleUnknown(ctx, op.id, `SEND_ABORTED_STOP_${st.code}`); }
  // no await between the decision above and the call start
  const call = bounded(ctx, "writeCallMs", (signal) => ctx.basis.exec.createOfflineCharge(plan.request, { signal }));
  ctx.writes += 1;
  ctx.calls.push("createOfflineCharge");
  let reply; let timedOut = false; let failed = false; let stop = null;
  try { reply = await call.promise; } catch (e) { failed = true; timedOut = e instanceof ProviderCallTimeout; stop = e instanceof WorkerStop ? e.code : null; }
  if (timedOut || stop) ctx.late = observeLate(ctx, call.raw);           // a started call whose reply was not admitted: late bookkeeping in memory only
  if (stop) noteStop(ctx, stop, "write");
  if (ctx.hooks.afterWrite) await ctx.hooks.afterWrite(op);
  if (failed) return settleUnknown(ctx, op.id, stop ? `WRITE_STOPPED_${stop}` : timedOut ? "WRITE_TIMEOUT" : "WRITE_CALL_FAILED");
  // ROOT 5883086133 F1: from here every awaited DB / proof / evidence boundary re-admits the stop state. A stop newly observed after the
  // admitted reply means THIS session may not assess, prove or complete the sent write: the row stays an uncertain lineage (outcome_unknown
  // + case; already-persisted read rows / evidence are kept as truth), no resend, no success event, no notification. Nothing committed
  // BEFORE the stop is rewritten.
  const admit = (where) => { const st = stopped(ctx, where); return st ? settleUnknown(ctx, op.id, `CONFIRM_STOPPED_${st.code}`) : null; };
  const f1 = (await loadFacts(ctx, p.facts.intentId)).facts;
  const h1 = admit("after_reply_facts"); if (h1) return h1;
  const cand = assessCreateReply({ reply, request: plan.request, eligibility: plan.eligibility, intent: f1, config: p.cfg });
  if (!cand.ok) return settleUnknown(ctx, op.id, `REPLY_${cand.code}`);
  // ONE confirming read: a NEW list row requested and claimed after the recording claim
  const o = (await ctx.pool.query("SELECT dispatched_at FROM booking.external_operations WHERE id = $1", [op.id])).rows[0];
  const dispatchedAt = ms(o.dispatched_at);
  for (const end = ctx.mono() + RECORDING_LIMITS.timingWaitMs; ctx.clock() <= dispatchedAt && ctx.mono() < end;) await sleep(2);
  const rid = await requestRead(ctx.pool, p.facts.intentId, OPS.LIST_READ, p.facts.reservationId, { now: ctx.clock() });
  const read = await claimNextOperation(ctx.pool, { workerId: ctx.workerId, now: ctx.clock(), opId: rid, opTypes: [OPS.LIST_READ], leaseMs: RECORDING_LIMITS.readLeaseMs });
  if (!read) return settleUnknown(ctx, op.id, "CONFIRM_READ_NOT_CLAIMED");
  const h2 = admit("after_confirm_read_claim"); if (h2) return h2;                       // the claimed read row is left to its lease
  const out = await callRead(ctx, "listOfflineCharges", LIST_REQUEST(p.facts.reservationId));
  if (out.transport) {
    await completeOperation(ctx.pool, read.id, { workerId: ctx.workerId, now: ctx.clock(), outcome: { status: "outcome_unknown", errorCode: `READ_TRANSPORT_${out.transport}` } });
    return settleUnknown(ctx, op.id, `CONFIRM_TRANSPORT_${out.transport}`);
  }
  const T = ctx.clock();
  const f2 = (await loadFacts(ctx, p.facts.intentId)).facts;
  const h3 = admit("after_confirm_facts"); if (h3) return h3;
  const list = assessChargeList({ read: { accountRef: ctx.basis.label.accountRef, clientSnapshotId: ctx.basis.label.clientSnapshotId, httpStatus: out.response.httpStatus,
    json: out.response.json, observedAt: T, request: { limit: LIST_LIMIT, reservationId: p.facts.reservationId } }, intent: f2, config: p.cfg, now: T });
  const conf = list.ok ? assessConfirmingRead({ candidate: cand, eligibility: plan.eligibility, list, intent: f2, config: p.cfg, dispatchedAt, now: T }) : list;
  const done = await completeOperation(ctx.pool, read.id, { workerId: ctx.workerId, now: T, outcome: { status: "succeeded", errorCode: conf.ok ? null : sanitize(conf.code) } });
  if (!done.ok || !conf.ok) return settleUnknown(ctx, op.id, conf.ok ? "CONFIRM_READ_LEASE_LOST" : `CONFIRM_${conf.code}`.replace(/^CONFIRM_CONFIRM_/, "CONFIRM_"));
  const h4 = admit("after_confirm_read_complete"); if (h4) return h4;                    // the succeeded read row stays (truth), unlinked
  const ev = await recordProviderEvidence(ctx.pool, { readOpId: read.id, kind: "hostaway_offline_charges", externalRef: p.facts.reservationId, status: "listed",
    observed: { ...conf.observed, matchingChargeIds: [...conf.observed.matchingChargeIds] } });
  if (!ev.ok) return settleUnknown(ctx, op.id, "CONFIRM_EVIDENCE_NOT_RECORDED");
  if (ctx.hooks.afterConfirmEvidence) await ctx.hooks.afterConfirmEvidence(op, ev.id);
  // LAST admission before the completion: completeRecordingWithEvidence is ONE SQL statement (booking.complete_recording_with_evidence, atomic in
  // the database, no JS-side awaited checks inside) — a stop cannot be observed mid-statement; whatever it commits is truth and is kept.
  const h5 = admit("before_complete"); if (h5) return h5;                                // persisted evidence stays; the row is an uncertain lineage
  const c = await completeRecordingWithEvidence(ctx.pool, op.id, { workerId: ctx.workerId, evidenceId: ev.id, resultRef: conf.chargeId, expectedVersion: f2.version });
  if (!c.ok) {
    ctx.actions.push(`COMPLETE!${c.error}`);
    if (["RECORDING_LEASE_LOST", "RECORDING_WORK_LEASE_LOST", "RECORDING_STATE"].includes(c.error)) return { delayMs: 0 };
    return settleUnknown(ctx, op.id, `COMPLETE_${c.error}`);
  }
  ctx.actions.push("COMPLETED");
  if (ctx.hooks.afterComplete) await ctx.hooks.afterComplete(op);
  // the completion is durable truth (proven write); a stop here defers ONLY the success event to a later session (recoveryPass / routing), never a resend
  if (stopped(ctx, "after_complete")) { ctx.actions.push("RECORDING_ROW_SUCCEEDED_EVENT_DEFERRED"); return { delayMs: 0 }; }
  return finalise(ctx, p.facts.intentId, op.id, conf.chargeId, "worker");
}

/** R4 / addendum D: a late reply is observed IN MEMORY only, within a finite window; no DB call, no event; bounded fields. */
function observeLate(ctx, raw) {
  if (!raw) return Promise.resolve(NONE_LATE);
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; resolve(NONE_LATE); } }, ctx.timeouts.lateWindowMs);
    // not unref()ed: the window is finite (lateWindowMs) and must resolve even in an otherwise idle process; cleared on settle
    raw.then((v) => { if (!settled) { settled = true; clearTimeout(timer);
      resolve(Object.freeze({ kind: "late_reply", settled: "fulfilled", httpStatus: isObj(v) && Number.isSafeInteger(v.httpStatus) ? v.httpStatus : null })); } },
    () => { if (!settled) { settled = true; clearTimeout(timer); resolve(Object.freeze({ kind: "late_reply", settled: "rejected", httpStatus: null })); } });
  });
}

// ---------------------------------------------------------------------------------------------
// one intent

async function handleIntent(ctx, intentId) {
  const lf = await loadFacts(ctx, intentId);
  if (!lf.facts || lf.facts.status !== WORK_STATE) { ctx.actions.push("STOP:OUT_OF_SCOPE"); return { delayMs: RECORDING_LIMITS.waitMs }; }
  const facts = lf.facts;
  if (isProtectedReservationId(facts.reservationId)) { ctx.actions.push("STOP:PROTECTED_RESERVATION_ID"); return { delayMs: RECORDING_LIMITS.waitMs }; }
  const cfg = ctx.basis.cfgs[String(facts.listingId)];
  if (!cfg) { ctx.actions.push("STOP:LISTING_NOT_CONFIGURED"); return { delayMs: RECORDING_LIMITS.waitMs }; }
  const recs = await recordingRows(ctx.pool, intentId);
  const latest = recs[0];
  if (!latest) { ctx.actions.push("STOP:NO_RECORDING"); return { delayMs: RECORDING_LIMITS.waitMs }; }
  const hold = await activeHold(ctx.pool, latest.id);
  // routing (contract §5.2)
  if (latest.state === "succeeded") {
    if (latest.settled_evidence_id === null) {
      if (hold) { ctx.actions.push("STOP:HOLD_ACTIVE"); return { delayMs: RECORDING_LIMITS.waitMs }; }
      const h = await openRecordingVisibilityHold(ctx.pool, latest.id, { reason: "SUCCEEDED_UNPROVEN", by: `recording-worker:${ctx.workerId}` });
      ctx.actions.push(h.ok ? "HOLD:SUCCEEDED_UNPROVEN" : `HOLD!${h.error}`);
      return { delayMs: RECORDING_LIMITS.waitMs };
    }
    if (hold) { ctx.actions.push("STOP:HOLD_ACTIVE"); return { delayMs: RECORDING_LIMITS.waitMs }; }
    return finalise(ctx, intentId, latest.id, latest.result_ref, "worker");
  }
  if (latest.state === "pending" && latest.attempt_no !== 1) {
    if (hold) { ctx.actions.push("STOP:HOLD_ACTIVE"); return { delayMs: RECORDING_LIMITS.waitMs }; }
    const h = await openRecordingVisibilityHold(ctx.pool, latest.id, { reason: "ATTEMPT_GT1", by: `recording-worker:${ctx.workerId}` });
    ctx.actions.push(h.ok ? "HOLD:ATTEMPT_GT1" : `HOLD!${h.error}`);
    return { delayMs: RECORDING_LIMITS.waitMs };
  }
  if (latest.state !== "pending") { ctx.actions.push(`STOP:RECORDING_${latest.state.toUpperCase()}`); return { delayMs: RECORDING_LIMITS.waitMs }; }
  if (hold) { ctx.actions.push("STOP:HOLD_ACTIVE"); return { delayMs: RECORDING_LIMITS.waitMs }; }
  // permanent facts (W-6 allowlist) vs local refusals
  if (lf.code) return escalate(ctx, lf.intent, lf.code);
  const fr = intentRefusal(facts, cfg);
  if (fr) return escalate(ctx, lf.intent, fr);
  if (lf.intent.counters.offlineChargeAttempts !== 0) { ctx.actions.push("STOP:NOT_INITIAL"); return { delayMs: RECORDING_LIMITS.waitMs }; }
  const p = { op: latest, facts, cfg, epoch: await epochOf(ctx.pool, latest.id), intent: lf.intent };
  return preflightAndSend(ctx, p);
}

async function preflightAndSend(ctx, p) {
  const wait = (r) => { ctx.actions.push(`WAIT:${r.code}`); return { delayMs: Math.max(0, r.delayMs ?? RECORDING_LIMITS.waitMs) }; };
  const budget = () => escalate(ctx, p.intent, "PREFLIGHT_READ_BUDGET_EXHAUSTED");
  const stop = (code) => { ctx.actions.push(`STOP:${sanitize(code)}`); return { delayMs: RECORDING_LIMITS.waitMs }; };
  const halted = () => ({ delayMs: 0 });                                   // outer stop already noted: release the work at once, nothing else
  let id = null; let list = null;
  const order = (await listFirst(ctx, p)) ? [OPS.LIST_READ, OPS.ID_READ] : [OPS.ID_READ, OPS.LIST_READ];
  for (const t of order) {
    const r = await readPhase(ctx, p, t);
    if (r.kind === "stopped") return halted();
    if (r.kind === "wait") return wait(r);
    if (r.kind === "stop") return stop(r.code);
    if (r.kind === "budget") return budget();
    if (t === OPS.ID_READ) {
      id = r;
      if (r.kind === "escalated") return afterPersist(ctx, p, await persist(ctx, p, "identity_refused", "READ_NOT_COMPLETED", { idRead: r.readId }));
      if (r.kind === "refused") {
        if (!(await catalogued(ctx, "identity_refused", r.code))) return stop(r.code);
        return afterPersist(ctx, p, await persist(ctx, p, "identity_refused", r.code, { idRead: r.readId }));
      }
    } else {
      list = r;
      if (r.kind === "refused" && !(await catalogued(ctx, "incomplete", r.code))) return stop(r.code);
    }
  }
  // positive identity + a list outcome
  const base = { idRead: id.readId, idEv: id.evidenceId, listRead: list.readId };
  if (list.kind === "escalated") return afterPersist(ctx, p, await persist(ctx, p, "incomplete", "READ_NOT_COMPLETED", base));
  if (list.kind === "refused") return afterPersist(ctx, p, await persist(ctx, p, "incomplete", list.code, base));
  const q = qualifyPreflight({ identity: id.branded, list: list.branded, intent: p.facts, recordingOp: pureOp(p.op), config: p.cfg, now: ctx.clock() });
  if (!q.ok) {
    const outcome = CONFLICT_OUTCOME[q.code];
    if (!outcome) return stop(q.code);
    return afterPersist(ctx, p, await persist(ctx, p, outcome, q.code, { ...base, listEv: list.evidenceId }));
  }
  const A = await persist(ctx, p, "eligible", null, { ...base, listEv: list.evidenceId });
  if (!A.ok) return afterPersist(ctx, p, A);
  if (stopped(ctx, "after_assessment")) return halted();                  // the eligible assessment stays persisted; the row stays pending (no claim)
  // S7: canonical request PRE-CLAIM, from fresh facts and the still-pending row
  const lf = await loadFacts(ctx, p.facts.intentId);
  const opNow = (await recordingRows(ctx.pool, p.facts.intentId))[0];
  if (!lf.facts || !opNow || opNow.id !== p.op.id) return stop("PRECLAIM_FACTS_CHANGED");
  const built = buildOfflineChargeRequest({ config: p.cfg, eligibility: q, intent: lf.facts, now: ctx.clock(), recordingOp: pureOp(opNow) });
  if (!built.ok) return stop(`PRECLAIM_${built.code}`);
  if (stopped(ctx, "before_claim")) return halted();                      // never a new claim after a stop
  // S8: claim exactly this row (DB fence + audit); from here it is "possibly sent" for every other actor
  const op = await claimNextOperation(ctx.pool, { workerId: ctx.workerId, now: ctx.clock(), opId: p.op.id, opTypes: [OPS.RECORD], leaseMs: RECORDING_LIMITS.opLeaseMs });
  if (!op) return wait({ code: "RECORDING_NOT_CLAIMED" });
  ctx.actions.push("CLAIMED");
  if (ctx.hooks.afterClaim) await ctx.hooks.afterClaim(op);
  const plan = Object.freeze({ assessmentId: A.id, eligibility: q, request: built.request, idRead: id.readId, listRead: list.readId, idEv: id.evidenceId,
    listEv: list.evidenceId });
  return sendAndConfirm(ctx, p, op, plan);
}

// ---------------------------------------------------------------------------------------------

/**
 * runRecordingStep(pool, { workerId, env, listings, executors, clock, intentId?, timeouts?, monotonic?, hooks?, signal?, deadlineAt? })
 *   -> frozen { status: 'refused' | 'idle' | 'worked', code?, intentId?, actions, calls, writes, delayMs?, workReleased, stop, late }
 * signal: an AbortSignal-like ({ aborted: boolean }, optional addEventListener) owned by the caller (runner lock loss, shutdown); deadlineAt: a finite
 * clock() instant after which nothing new is claimed or sent. Omitted → null → the accepted behaviour, unchanged. stop: null | { code, where }.
 * One bounded step. ANY thrown error (an outer DB failure, a hook fault) stops the step: no further query or mutation — not even the
 * work release — and the ORIGINAL error object propagates unchanged (§6.3). Recovery happens on fresh persisted facts in a later step.
 */
export async function runRecordingStep(pool, opts = {}) {
  const { workerId, env, listings, executors, clock, intentId: scopeIntentId = null, timeouts, hooks = {}, signal = null, deadlineAt = null } = opts;
  const g = recordingWorkerGate({ env, listings, executors, clock });
  const none = { actions: [], calls: [], writes: 0, workReleased: false, stop: null, late: Promise.resolve(NONE_LATE) };
  if (!g.ok) return result("refused", { code: g.code, ...none });
  if (typeof workerId !== "string" || !WORKER_RE.test(workerId)) return result("refused", { code: "WORKER_ID_INVALID", ...none });
  if (signal !== null && (typeof signal !== "object" || typeof signal.aborted !== "boolean")) return result("refused", { code: "SIGNAL_INVALID", ...none });
  if (deadlineAt !== null && !Number.isFinite(deadlineAt)) return result("refused", { code: "DEADLINE_INVALID", ...none });
  if (scopeIntentId !== null && (typeof scopeIntentId !== "string" || !/^[0-9a-f-]{36}$/.test(scopeIntentId))) return result("refused", { code: "INTENT_ID_INVALID", ...none });
  // a stop observable before the step starts: NOTHING (no query, no claim, no call)
  const pre = { signal, deadlineAt, clock, stop: null, actions: [] };
  if (stopped(pre, "start")) return result("idle", { ...none, actions: pre.actions, stop: pre.stop });
  // R-C1: an explicit marker SELECT. Only a SUCCESSFULLY read marker that is not 'test' (or an absent marker) is the structured refusal; any
  // thrown query / transport / SQL error propagates as the ORIGINAL object with no follow-up query, provider call, release or mutation.
  const marker = (await pool.query("SELECT environment FROM booking.instance")).rows[0]?.environment;
  if (marker !== "test") return result("refused", { code: "DATABASE_NOT_TEST", ...none });
  // W-5: bounded clock-skew check (the DB's own checks stay authoritative)
  const t0 = clock(); const db = ms((await pool.query("SELECT clock_timestamp() AS t")).rows[0].t); const t1 = clock();
  if (t1 - t0 > RECORDING_LIMITS.maxSkewRoundTripMs) return result("refused", { code: "CLOCK_SKEW_UNCERTAIN", ...none });
  if (!(db >= t0 - RECORDING_LIMITS.maxClockSkewMs && db <= t1 + RECORDING_LIMITS.maxClockSkewMs)) return result("refused", { code: "CLOCK_SKEW", ...none });
  // an explicitly requested protected intent: read-only inspection, refused before any maintenance (addendum A)
  if (scopeIntentId) {
    const r = (await pool.query("SELECT hostaway_reservation_id FROM booking.intents WHERE id = $1", [scopeIntentId])).rows[0];
    if (r && isProtectedReservationId(r.hostaway_reservation_id)) return result("refused", { code: "PROTECTED_RESERVATION_ID", ...none });
  }
  const t = resolveTimeouts(timeouts);
  const mono = typeof opts.monotonic === "function" ? opts.monotonic : () => performance.now();
  const ctx = { pool, workerId, basis: g.basis, clock, hooks, scopeIntentId, timeouts: t, mono, stepEndsAt: mono() + t.stepBudgetMs, signal, deadlineAt, stop: null,
    actions: [], calls: [], writes: 0, settled: new Set(), late: Promise.resolve(NONE_LATE) };
  const idle = () => result("idle", { actions: ctx.actions, calls: ctx.calls, writes: ctx.writes, workReleased: false, stop: ctx.stop, late: ctx.late });
  await maintenance(ctx);
  await recoveryPass(ctx);
  if (stopped(ctx, "before_claim_work")) return idle();  // never a new work claim after a stop
  const intentId = await claimWork(ctx);
  if (!intentId) return idle();
  const r = stopped(ctx, "after_claim_work") ? { delayMs: 0 } : await handleIntent(ctx, intentId);   // a throw propagates unchanged; the work lease then expires on its own
  await RW.releaseWork(ctx, intentId, r.delayMs);
  return result("worked", { intentId, actions: ctx.actions, calls: ctx.calls, writes: ctx.writes, delayMs: r.delayMs, workReleased: true, stop: ctx.stop, late: ctx.late });
}

export const _internal = Object.freeze({ resolveTimeouts, finalCheck, selectRead, observeLate, escalate, stopCode, bounded });
