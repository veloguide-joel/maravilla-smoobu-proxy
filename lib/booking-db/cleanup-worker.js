// lib/booking-db/cleanup-worker.js — E7 captured-TEST CLEANUP worker (OFFLINE; 0019 + 0020). Bounded single-step worker for ONE pinned intent in
// test_cleanup_pending: FIRST the Hostaway host-cancel leg, THEN the ONE bound FULL Stripe refund leg. Contract: claude/e7-capture-test-cleanup-contract.md
// rev4 (§2 state machine, §4 proof, §5 uncertainty, §6 fences, §7 interface). Pure proofs: ../checkout/test-cleanup-proof.js.
//
// INTERNAL LIBRARY ONLY: no route, cron, queue consumer, hosted workflow, frontend, SDK client, network adapter or default provider function. Not
// imported by any api/ route or by an existing worker. Every provider call goes through an INJECTED executor (exactly TEST_CLEANUP_EXECUTOR_KEYS).
// Never executed here: capture, void, create, offline-charge recording, notifications. DISABLED BY DEFAULT (two explicit env flags + dev/preview).
//
// Rules (ROOT GO, contract rev4):
//   * ONE pinned intent (intentId is REQUIRED; no sweeping), listing EXACTLY 606998 / USD, TEST database instance + TEST intent, protected reservation
//     ids refused everywhere, the persisted state must be test_cleanup_pending (the capture / recording / compensation workers never claim it).
//   * ORDER: the cancel leg is worked while open; the refund leg only after settlement.reservationCancelled is TRUE (the pure eligibility refuses
//     otherwise). At most ONE cancel PUT and ONE refund POST in TOTAL per intent ACROSS SESSIONS: the DB (0019 one_refund_ever, test_cleanup_cancel_bound,
//     claim fences) + the pure pre-claim checks (row pending / attempts 0 / never dispatched) + the in-step counter; an uncertain send is NEVER resent.
//   * Before any claim / send: fresh verified TEST account read, fresh v3 PaymentIntent proof (captured on the capture row's charge, exact amount /
//     currency, TEST mode, NOT refunded, no dispute — raw aggregates checked too), exact reservation / ref identity proof for the cancel. Immediately
//     before the send every CURRENT fact is re-read (op + work leases with whole-call room, version, state, open leg, payment attempt, capture row,
//     evidence ids / times, stop signal / deadline / step budget), clock read AFTER those reads, no await between the decision and the call start.
//   * A provider reply is NEVER proof: a confirming READ persisted as immutable API evidence comes first (cancel: the reservation cancelled with full
//     identity; refund: the bound Refund GET + the matching typed v3 captured-and-fully-refunded PaymentIntent read), then the row completes and the
//     fenced event is applied — its transaction re-checking version, state, open leg, operation state and the exact evidence linkage; the DB guard
//     (0019 booking.test_refund_settled_for) re-verifies the refund leg itself.
//   * Lost / timed-out / 5xx / malformed / pending → row outcome_unknown + the legal *_OUTCOME_UNKNOWN event → READS ONLY (≥ dispatch + 2 min),
//     bounded. Refund reconciliation obeys rev4 §5: the Refund LIST (has_more refused outright; exactly ONE candidate; metadata mv_refund_op +
//     mv_refund_key + charge / amount / currency binding; conservative integer-second time filter) only DISCOVERS an id; the exact GET decides; the row
//     is settled ONLY by the explicit evidence-bound 0020 function booking.settle_test_refund_from_evidence (never by the accepted generic settlement
//     function, which 0020 makes refuse refund rows explicitly, and never by a direct UPDATE). Zero / several / unbound / truncated → REFUND_FAILED
//     (owner case). Late provider replies are late evidence only.
//   * Explicit stop checks (abort signal, deadline, step budget) before and immediately after EVERY awaited provider / proof / claim boundary
//     (ROOT review 5880626183 F1): every provider call runs through a WORKER-LOCAL bounded call that combines the outer abort signal, the remaining
//     step budget and the session deadline, and a reply that arrives after a stop is INADMISSIBLE (never confirmation, success or claim release).
//     After a possibly sent write only the uncertainty bookkeeping (row unknown + the legal *_OUTCOME_UNKNOWN) happens; no further provider request.
//     Observed facts are reported (result.facts). RECONCILED_RESERVATION_STILL_ACTIVE in this state is an owner case by E3 (F3): never a second cancel.
//   * ONE persisted read-budget admission (SUM of attempts since the intent entered test_cleanup_pending, per read kind) for NEW reads and for REUSED
//     pending / retried rows alike, across sessions (ROOT 5880626183 F2); at the ceiling: no claim, bounded owner escalation.
//   * The RAW PaymentIntent refund / dispute safeguards and the strictly-future-arrival rule gate the INITIAL cancellation too (F3 / residual): a
//     disputed or partly refunded charge, a missing flag, or a past arrival means ZERO PUT and ZERO POST. Read-only settlement of this worker's own
//     uncertain cancel and the refund leg are not arrival-gated. Equal-timestamp observations fail closed (reads later; no fabricated time).
import { applyEvent, loadIntent, RepoError } from "./repo.js";
import { claimNextOperation, completeOperation, recordProviderEvidence, recoverExpiredOperations, requestRead, settleOperationFromEvidence } from "./operations.js";
import { assertEnvironment } from "./pool.js";
import { _internal as RW, ProviderCallTimeout, isProtectedReservationId } from "./reservation-worker.js";
import { TEST_CLEANUP_LISTINGS } from "./test-cleanup.js";
import { reservationIdentity } from "../checkout/recovery-plan.js";
import { paymentIntentProofObservationV3 } from "../checkout/capture-proof.js";
import { localDateInZone } from "../checkout/compensation-proof.js";
import {
  OPS, FRESH_AFTER_DISPATCH_MS, PROOF_MAX_AGE_MS, REFUND_METADATA_KEYS, refundObservation, refundObjectUsable, singleCaptureProof, piCapturedFullyRefundedProofV3,
  refundReadProof, refundDiscovery, cleanupCancelEligibility, buildCleanupCancelRequest, validateCancelRequest, arrivalStrictlyFuture, rawPiPreSendRefusal,
  refundSendEligibility, buildRefundRequest, validateRefundRequest
} from "../checkout/test-cleanup-proof.js";
import { STATES as S } from "../checkout/intent-state.js";
import { validateAdapterConfig, unwrapEnvelope, normalizeReservation, lookupByRef } from "../hostaway-reservations.js";

export const TEST_CLEANUP_WORKER_VERSION = "e7-test-cleanup-worker-v1";
export { OPS };
export const WRITE_OP_TYPES = Object.freeze([OPS.CANCEL, OPS.REFUND]);
export const READ_OP_TYPES = Object.freeze([OPS.PI_READ, OPS.RES_READ, OPS.LOOKUP, OPS.REFUND_READ]);
export const CLEANUP_OP_TYPES = Object.freeze([...WRITE_OP_TYPES, ...READ_OP_TYPES]);
export const TEST_CLEANUP_EXECUTOR_KEYS = Object.freeze(["retrieveAccount", "retrievePaymentIntent", "retrieveReservation", "lookupPage", "cancelReservation",
  "createRefund", "retrieveRefund", "listRefunds"]);
export const WORK_STATES = Object.freeze([S.TEST_CLEANUP_PENDING]);
export const TEST_CLEANUP_WORKER_TIMEOUTS = Object.freeze({ readCallMs: 10000, writeCallMs: 20000, stepBudgetMs: 45000 });
/** contract §7 budgets (per intent, since it entered test_cleanup_pending): PI reads ≤ 8, refund reads ≤ 8, Hostaway reads ≤ 12; cancel 1, refund 1 */
export const TEST_CLEANUP_WORKER_LIMITS = Object.freeze({ workLeaseMs: 60 * 1000, sendMarginMs: 15 * 1000, waitMs: 30 * 1000, maxReads: Object.freeze({
  [OPS.PI_READ]: 8, [OPS.REFUND_READ]: 8, [OPS.RES_READ]: 12, [OPS.LOOKUP]: 12 }), listLimit: 100, maintenanceBatch: 20 });
export const REFUND_LIST_LIMIT = TEST_CLEANUP_WORKER_LIMITS.listLimit;
export const STOP_CODES = Object.freeze(["SIGNAL", "DEADLINE", "STEP_BUDGET"]);
const ACCT_RE = /^acct_[A-Za-z0-9]{1,64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const result = (status, extra = {}) => Object.freeze({ status, ...extra });
const ms = (d) => (d == null ? null : new Date(d).getTime());
const sanitize = (code) => (/^[A-Z0-9_]{1,64}$/.test(code) ? code : "TEST_CLEANUP_OPERATOR_REQUIRED");
const codeOf = (s) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9_]/g, "_").slice(0, 40);
class Escalate extends Error { constructor(code) { super(code); this.code = code; } }
/** a stop (outer signal / session deadline / step budget) observed at a provider-call boundary: the awaited reply is inadmissible */
class WorkerStop extends Error { constructor(code) { super(`STOP_${code}`); this.code = code; } }

function resolveTimeouts(t) {
  const out = {};
  for (const [k, d] of Object.entries(TEST_CLEANUP_WORKER_TIMEOUTS)) {
    const v = t !== null && typeof t === "object" ? t[k] : undefined;
    out[k] = Number.isFinite(v) && v > 0 ? Math.min(v, d) : d;
  }
  return Object.freeze(out);
}

// ---------------------------------------------------------------------------------------------
// gate (pure; nothing touched before it passes) — DISABLED BY DEFAULT

export function testCleanupWorkerGate({ env, adapterConfig, listings, executors, clock, stripeAccountId, intentId } = {}) {
  const e = isObj(env) ? env : null;
  if (!e) return { ok: false, code: "ENV_REQUIRED" };
  if (e.VERCEL_ENV === "production") return { ok: false, code: "PRODUCTION_REFUSED" };
  if (e.VERCEL_ENV !== "development" && e.VERCEL_ENV !== "preview") return { ok: false, code: "ENVIRONMENT_NOT_ALLOWED" };
  if (e.MV_E7_TEST_CLEANUP !== "enabled" || e.MV_E7_TEST_CLEANUP_WORKER !== "enabled") return { ok: false, code: "NOT_ENABLED" };
  if (typeof intentId !== "string" || !UUID_RE.test(intentId)) return { ok: false, code: "INTENT_ID_REQUIRED" };     // ONE pinned intent, never a sweep
  if (typeof stripeAccountId !== "string" || !ACCT_RE.test(stripeAccountId)) return { ok: false, code: "STRIPE_ACCOUNT_REQUIRED" };
  let cfg;
  try { cfg = validateAdapterConfig(adapterConfig); } catch { return { ok: false, code: "ADAPTER_CONFIG_INVALID" }; }
  if (typeof clock !== "function" || !Number.isFinite(clock())) return { ok: false, code: "CLOCK_REQUIRED" };
  const allowed = TEST_CLEANUP_LISTINGS[0];
  if (TEST_CLEANUP_LISTINGS.length !== 1 || JSON.stringify(cfg.allowedListingIds) !== JSON.stringify([allowed.listingId]) || cfg.currency !== allowed.currency) return { ok: false, code: "LISTING_NOT_ALLOWED" };
  if (!(listings instanceof Map) || listings.size !== 1) return { ok: false, code: "LISTINGS_REQUIRED" };
  const lc = listings.get(allowed.listingId);
  if (!isObj(lc) || lc.currency !== allowed.currency) return { ok: false, code: "LISTING_NOT_ALLOWED" };
  if (localDateInZone(clock(), lc.timeZone) === null) return { ok: false, code: "LISTING_TIME_ZONE_INVALID" };
  if (!isObj(executors)) return { ok: false, code: "NO_EXECUTORS" };
  for (const k of Object.keys(executors)) if (!TEST_CLEANUP_EXECUTOR_KEYS.includes(k)) return { ok: false, code: "EXECUTOR_NOT_ALLOWED" };
  for (const k of TEST_CLEANUP_EXECUTOR_KEYS) if (typeof executors[k] !== "function") return { ok: false, code: "NO_EXECUTORS" };
  return { ok: true, cfg };
}

// ---------------------------------------------------------------------------------------------
// stop checks (signal / deadline / step budget): never a new claim or send after one fires

function stopCode(ctx) {
  if (ctx.signal && ctx.signal.aborted === true) return "SIGNAL";
  if (ctx.deadlineAt !== null && ctx.clock() >= ctx.deadlineAt) return "DEADLINE";
  if (!(ctx.stepEndsAt - ctx.mono() > 0)) return "STEP_BUDGET";
  return null;
}
function noteStop(ctx, code, where) {
  if (!ctx.stop) { ctx.actions.push(`STOP:${code}:${where}`); ctx.stop = { code, where }; }
  return { delayMs: 0, stopped: true };
}
/** a stop already noted at a boundary, or one observable now → the step does nothing more (no claim, no send, no success) */
function stopped(ctx, where) {
  if (ctx.stop) return { delayMs: 0, stopped: true };
  const c = stopCode(ctx);
  return c ? noteStop(ctx, c, where) : null;
}
/**
 * WORKER-LOCAL bounded provider call (F1): starts ONE call now (no await before it) bounded by min(per-call timeout, remaining step budget, remaining
 * session deadline) AND the outer abort signal; re-checks the stop state when the reply settles — a reply after a stop is INADMISSIBLE (WorkerStop).
 * -> { promise (result | provider error | ProviderCallTimeout | WorkerStop), raw (the executor's own promise; late bookkeeping only) }
 */
function bounded(ctx, kind, fn) {
  const pre = stopCode(ctx);
  if (pre) return { promise: Promise.reject(new WorkerStop(pre)), raw: null };
  const budgets = [ctx.timeouts[kind], ctx.stepEndsAt - ctx.mono()];
  if (ctx.deadlineAt !== null) budgets.push(ctx.deadlineAt - ctx.clock());
  const ms = Math.min(...budgets);
  if (!(ms > 0)) return { promise: Promise.reject(new WorkerStop(stopCode(ctx) || "STEP_BUDGET")), raw: null };
  const ac = new AbortController();
  let raw;
  try { raw = Promise.resolve(fn(ac.signal)); } catch (e) { raw = Promise.reject(e); }
  raw.catch(() => {});                                                   // the executor's own promise is observed below; never an unhandled rejection
  const promise = new Promise((resolve, reject) => {
    let done = false; let timer = null;
    const onAbort = () => finish(() => { ac.abort(); reject(new WorkerStop("SIGNAL")); });
    const finish = (f) => { if (done) return; done = true; if (timer) clearTimeout(timer); if (ctx.signal) ctx.signal.removeEventListener("abort", onAbort); f(); };
    raw.then((v) => finish(() => { const sc = stopCode(ctx); if (sc) reject(new WorkerStop(sc)); else resolve(v); }),
      (e) => finish(() => { const sc = stopCode(ctx); reject(sc ? new WorkerStop(sc) : e); }));
    timer = setTimeout(() => finish(() => { ac.abort(); const sc = stopCode(ctx); reject(sc ? new WorkerStop(sc) : new ProviderCallTimeout()); }), ms);
    if (ctx.signal) { if (ctx.signal.aborted) onAbort(); else ctx.signal.addEventListener("abort", onAbort, { once: true }); }
  });
  promise.catch(() => {});
  return { promise, raw };
}

// ---------------------------------------------------------------------------------------------
// fenced events / owner cases

/** In-transaction scope fence: still the PLANNED version + state, the pinned intent, the one allowed listing. */
function scopeFence(ctx, planned) {
  return (before) => {
    if (before.version !== planned.version || before.status !== planned.status || !WORK_STATES.includes(before.status) || before.id !== ctx.intentId
      || !ctx.listings.has(before.listingId)) throw new RepoError("STALE_OUT_OF_SCOPE");
  };
}
const legOpen = (i, leg) => i.status === S.TEST_CLEANUP_PENDING && isObj(i.settlement)
  && (leg === "reservation" ? i.settlement.reservationCancelled === false : i.settlement.authorizationSettled === false && i.settlement.reservationCancelled === true);

/**
 * applyEvent fenced on this worker's work lease AND caller checks (inside the event transaction, intent row locked first).
 * `success: true` (ROOT 5880873025 R1) = a SUCCESS / decision event (RESERVATION_CANCELLED, RECONCILED_RESERVATION_STILL_ACTIVE, REFUND_SUCCEEDED): stop-aware
 * admission — refused before event entry, and inside the transaction BEFORE and AFTER its own awaited work-lease / evidence checks (a stop observed
 * during the transaction's own proof vetoes the event: the transaction rolls back, nothing is mutated). Uncertainty / owner bookkeeping events
 * (*_OUTCOME_UNKNOWN, ESCALATE, REFUND_FAILED, RESERVATION_CANCEL_FAILED) are not gated: minimal teardown must still work after a stop.
 */
async function applyChecked(ctx, intentId, event, check = null, { success = false, where = event.type } = {}) {
  const gate = (at) => { if (!success) return; const sc = stopCode(ctx); if (sc || ctx.stop) { noteStop(ctx, sc || ctx.stop.code, at); throw new RepoError("STOPPED"); } };
  try {
    gate(`before_${where}`);
    return await applyEvent(ctx.pool, intentId, event, {
      now: ctx.clock(), actor: "worker", workerId: ctx.workerId,
      inTx: async (c, info) => {
        gate(`in_tx_${where}`);
        const w = (await c.query("SELECT work_worker_id, work_lease_until FROM booking.intent_work WHERE intent_id = $1 FOR SHARE", [intentId])).rows[0];
        if (!w || w.work_worker_id !== ctx.workerId || !(ms(w.work_lease_until) >= ctx.clock())) throw new RepoError("WORK_LEASE_LOST");
        if (check) await check(c, info);
        gate(`in_tx_after_checks_${where}`);                 // a stop that arrived during the awaited proof queries vetoes the event (rollback)
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
  const r = await applyChecked(ctx, intent.id, { type: "ESCALATE", id: `tcw-escalate:${intent.id}:${c}:v${intent.version}`, code: c }, async (_c, { before }) => fence(before));
  ctx.actions.push(r.ok ? `ESCALATE:${c}` : `ESCALATE!${r.error}`);
  return { delayMs: 0 };
}
/** the legal REFUND_FAILED owner case (never a resend); deterministic id per operation */
async function refundFailed(ctx, intent, row, code) {
  const c = sanitize(code);
  const fence = scopeFence(ctx, intent);
  const r = await applyChecked(ctx, intent.id, { type: "REFUND_FAILED", id: `op-outcome:${row.id}`, code: c }, async (cx, { before }) => {
    fence(before);
    if (!legOpen(before, "authorization")) throw new RepoError("STALE_OUT_OF_SCOPE");
    const o = (await cx.query("SELECT state FROM booking.external_operations WHERE id = $1 FOR SHARE", [row.id])).rows[0];
    if (!o || !["outcome_unknown", "failed_definite", "succeeded"].includes(o.state)) throw new RepoError("STALE_OUT_OF_SCOPE");
  });
  ctx.actions.push(r.ok ? `REFUND_FAILED:${c}` : `REFUND_FAILED!${r.error}`);
  return { delayMs: 0 };
}

// ---------------------------------------------------------------------------------------------
// rows / facts

const asOp = (r) => ({ id: r.id, opType: r.op_type, state: r.state, attempts: r.attempts, dispatchedAt: ms(r.dispatched_at), payload: r.payload, resultRef: r.result_ref });
const opRow = async (q, opId) => (await q.query("SELECT * FROM booking.external_operations WHERE id = $1", [opId])).rows[0] || null;
const rowsOf = async (q, intentId, opType) => (await q.query(
  "SELECT * FROM booking.external_operations WHERE intent_id = $1 AND op_type = $2 ORDER BY created_at, id", [intentId, opType])).rows;
async function boundPaymentAttempt(q, intent) {
  if (!intent.payment || !intent.payment.paymentIntentId) return null;
  const r = await q.query("SELECT id, livemode FROM booking.payment_attempts WHERE intent_id = $1 AND payment_intent_id = $2 AND status = 'completed'",
    [intent.id, intent.payment.paymentIntentId]);
  return r.rowCount === 1 && r.rows[0].livemode === false ? r.rows[0].id : null;
}
async function stateEnteredAt(q, intent) {
  const r = await q.query(`SELECT min(at) AS t FROM booking.intent_transitions WHERE intent_id = $1 AND to_state = $2 AND from_state IS DISTINCT FROM to_state`, [intent.id, intent.status]);
  return ms(r.rows[0].t);
}
async function evidenceById(q, intentId, id) {
  const r = await q.query(
    `SELECT e.id, e.kind, e.external_ref, e.status, e.observed, e.observed_at, r.op_type AS read_op_type, r.id AS read_op_id,
            coalesce(r.payload ->> 'paymentIntentId', r.payload ->> 'reservationId', r.payload ->> 'ref', r.payload ->> 'refundId') AS request_ref
       FROM booking.provider_evidence e JOIN booking.external_operations r ON r.id = e.read_operation_id
      WHERE e.id = $1 AND e.intent_id = $2 AND e.source IN ('stripe_api', 'hostaway_api')`, [id, intentId]);
  const e = r.rows[0];
  return e ? { id: e.id, kind: e.kind, readOpType: e.read_op_type, requestRef: e.request_ref, externalRef: e.external_ref, status: e.status,
    observed: e.observed, observedAt: ms(e.observed_at), readOpId: e.read_op_id } : null;
}
/** read-only snapshot of the facts a stopped / finished step reports (never inferred) */
async function observedFacts(pool, intentId) {
  const i = (await pool.query("SELECT state, version, settlement_reservation_cancelled AS c, settlement_authorization_settled AS a, captured_minor::text AS cap, reason_code FROM booking.intents WHERE id = $1", [intentId])).rows[0];
  const ops = (await pool.query("SELECT op_type, state, attempts, result_ref FROM booking.external_operations WHERE intent_id = $1 AND op_type = ANY($2) ORDER BY created_at, id", [intentId, WRITE_OP_TYPES])).rows;
  const rf = (await pool.query("SELECT state, stripe_refund_id FROM booking.payment_refunds WHERE intent_id = $1 AND seq = 1", [intentId])).rows[0] || null;
  const held = (await pool.query("SELECT count(*)::int AS n FROM booking.inventory_claims WHERE intent_id = $1 AND released_at IS NULL", [intentId])).rows[0].n;
  return Object.freeze({ intentState: i ? i.state : null, version: i ? i.version : null, reasonCode: i ? i.reason_code : null, capturedMinor: i ? i.cap : null,
    settlement: i ? { reservationCancelled: i.c, authorizationSettled: i.a } : null, claimHeld: held === 1,
    cancel: ops.filter((o) => o.op_type === OPS.CANCEL).map((o) => ({ state: o.state, attempts: o.attempts, resultRef: o.result_ref })),
    refund: ops.filter((o) => o.op_type === OPS.REFUND).map((o) => ({ state: o.state, attempts: o.attempts, resultRef: o.result_ref })),
    refundRecord: rf ? { state: rf.state, stripeRefundId: rf.stripe_refund_id } : null });
}

// ---------------------------------------------------------------------------------------------
// executed READS (bounded per type since the intent entered test_cleanup_pending; results persisted as immutable API evidence)

const READ_FIELD = { [OPS.PI_READ]: "paymentIntentId", [OPS.RES_READ]: "reservationId", [OPS.LOOKUP]: "ref", [OPS.REFUND_READ]: "refundId" };
/** the ONE persisted read-budget admission (F2): SUM of EXECUTION attempts of this read kind since the intent entered test_cleanup_pending — for a new
 *  row and for a reused pending / retried row alike, across sessions. At the ceiling: Escalate (bounded owner case), never a claim. */
async function admitRead(ctx, intent, opType) {
  const used = Number((await ctx.pool.query(
    `SELECT coalesce(sum(attempts), 0) AS n FROM booking.external_operations WHERE intent_id = $1 AND op_type = $2 AND retry_class = 'read' AND created_at >= $3`,
    [intent.id, opType, new Date(ctx.enteredAt)])).rows[0].n);
  if (used >= TEST_CLEANUP_WORKER_LIMITS.maxReads[opType]) throw new Escalate("CLEANUP_READS_EXHAUSTED");
}
async function claimRead(ctx, intent, opType, selector) {
  const field = READ_FIELD[opType];
  let open = (await ctx.pool.query(
    `SELECT id, state FROM booking.external_operations WHERE intent_id = $1 AND op_type = $2 AND retry_class = 'read'
        AND state IN ('pending', 'in_flight') AND payload ->> $3 = $4 ORDER BY created_at LIMIT 1`, [intent.id, opType, field, selector])).rows[0];
  await admitRead(ctx, intent, opType);
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
  try { a = await bounded(ctx, "readCallMs", (signal) => ctx.executors.retrieveAccount({ signal })).promise; } catch (e) { if (e instanceof WorkerStop) throw e; return false; }
  ctx.calls.push("account");
  if (!isObj(a) || a.object !== "account" || a.id !== ctx.stripeAccountId) throw new Escalate("STRIPE_ACCOUNT_MISMATCH");
  ctx.accountVerified = true;
  return true;
}

/** a stop observed around a read: the read row becomes unknown bookkeeping, the stop is noted, the reply (if any) is never used */
async function stoppedRead(ctx, op, e, where) {
  await finishRead(ctx, op, "outcome_unknown", `STOP_${e.code}`).catch(() => {});
  noteStop(ctx, e.code, where);
  return { ok: false, code: `STOP_${e.code}` };
}
/** equal-timestamp observations of one kind / id fail CLOSED (the 0019 latest/tie rule): the new row is recorded but not used; reads later decide */
async function observationTie(ctx, intentId, kind, externalRef, evidenceId) {
  const n = (await ctx.pool.query(`SELECT count(*)::int AS n FROM booking.provider_evidence e WHERE e.intent_id = $1 AND e.kind = $2 AND e.external_ref = $3
                                     AND e.observed_at = (SELECT observed_at FROM booking.provider_evidence WHERE id = $4)`, [intentId, kind, externalRef, evidenceId])).rows[0].n;
  return n !== 1;
}
/** One executed PaymentIntent read (latest_charge expanded) -> v3 evidence row + the RAW object (for the pre-send aggregate checks). */
async function readPaymentIntent(ctx, intent, { reuseClaimed = null } = {}) {
  const pi = intent.payment.paymentIntentId;
  const op = reuseClaimed || await claimRead(ctx, intent, OPS.PI_READ, pi);
  if (!op) return { ok: false, code: "PI_READ_NOT_CLAIMED" };
  let acct;
  try { acct = await verifyAccount(ctx); }
  catch (e) { if (e instanceof WorkerStop) return stoppedRead(ctx, op, e, "account_read"); await finishRead(ctx, op, "outcome_unknown", "ACCOUNT_NOT_VERIFIED"); throw e; }
  if (!acct) { await finishRead(ctx, op, "outcome_unknown", "ACCOUNT_READ_FAILED"); return { ok: false, code: "ACCOUNT_READ_FAILED" }; }
  let obj;
  try { obj = await bounded(ctx, "readCallMs", (signal) => ctx.executors.retrievePaymentIntent(pi, { expand: ["latest_charge"] }, { signal })).promise; }
  catch (e) { if (e instanceof WorkerStop) return stoppedRead(ctx, op, e, "pi_read"); await finishRead(ctx, op, "outcome_unknown", "PI_READ_FAILED"); return { ok: false, code: "PI_READ_FAILED" }; }
  ctx.calls.push(`pi_read:${pi}`);
  if (ctx.hooks.afterPiRead) await ctx.hooks.afterPiRead();
  { const sc = stopCode(ctx); if (sc) return stoppedRead(ctx, op, new WorkerStop(sc), "pi_read"); }     // R2: a stop after the awaited post-processing → bookkeeping, never authoritative evidence
  if (!isObj(obj) || obj.object !== "payment_intent" || obj.id !== pi || typeof obj.status !== "string" || obj.livemode !== false) {
    await finishRead(ctx, op, "outcome_unknown", "PI_READ_UNUSABLE"); return { ok: false, code: "PI_READ_UNUSABLE" };
  }
  const done = await finishRead(ctx, op, "succeeded");
  if (!done.ok) return { ok: false, code: "LEASE_LOST" };
  const rec = await recordProviderEvidence(ctx.pool, { readOpId: op.id, kind: "payment_intent", externalRef: pi, status: obj.status,
    observed: paymentIntentProofObservationV3(obj, { accountVerified: ctx.accountVerified === true }) });
  if (!rec.ok) return { ok: false, code: "EVIDENCE_NOT_RECORDED" };
  if (await observationTie(ctx, intent.id, "payment_intent", pi, rec.id)) return { ok: false, code: "PI_OBSERVATION_TIE" };
  const sc = stopCode(ctx);
  if (sc) { noteStop(ctx, sc, "after_pi_read"); return { ok: false, code: `STOP_${sc}` }; }
  return { ok: true, ev: await evidenceById(ctx.pool, intent.id, rec.id), raw: obj };
}

/** One executed Refund read (GET /v1/refunds/{id}) -> stripe_refund evidence row. The selector is OUR refund id (reply or discovery), never adopted blindly. */
async function readRefund(ctx, intent, refundId, { reuseClaimed = null } = {}) {
  const op = reuseClaimed || await claimRead(ctx, intent, OPS.REFUND_READ, refundId);
  if (!op) return { ok: false, code: "REFUND_READ_NOT_CLAIMED" };
  let acct;
  try { acct = await verifyAccount(ctx); }
  catch (e) { if (e instanceof WorkerStop) return stoppedRead(ctx, op, e, "account_read"); await finishRead(ctx, op, "outcome_unknown", "ACCOUNT_NOT_VERIFIED"); throw e; }
  if (!acct) { await finishRead(ctx, op, "outcome_unknown", "ACCOUNT_READ_FAILED"); return { ok: false, code: "ACCOUNT_READ_FAILED" }; }
  let obj;
  try { obj = await bounded(ctx, "readCallMs", (signal) => ctx.executors.retrieveRefund(refundId, { signal })).promise; }
  catch (e) { if (e instanceof WorkerStop) return stoppedRead(ctx, op, e, "refund_read"); await finishRead(ctx, op, "outcome_unknown", "REFUND_READ_FAILED"); return { ok: false, code: "REFUND_READ_FAILED" }; }
  ctx.calls.push(`refund_read:${refundId}`);
  if (ctx.hooks.afterRefundRead) await ctx.hooks.afterRefundRead();
  { const sc = stopCode(ctx); if (sc) return stoppedRead(ctx, op, new WorkerStop(sc), "refund_read"); }
  if (!refundObjectUsable(obj) || obj.id !== refundId) { await finishRead(ctx, op, "outcome_unknown", "REFUND_READ_UNUSABLE"); return { ok: false, code: "REFUND_READ_UNUSABLE" }; }
  const done = await finishRead(ctx, op, "succeeded");
  if (!done.ok) return { ok: false, code: "LEASE_LOST" };
  const rec = await recordProviderEvidence(ctx.pool, { readOpId: op.id, kind: "stripe_refund", externalRef: refundId, status: obj.status, observed: refundObservation(obj) });
  if (!rec.ok) return { ok: false, code: `EVIDENCE_NOT_RECORDED_${codeOf(rec.error)}` };
  if (await observationTie(ctx, intent.id, "stripe_refund", refundId, rec.id)) return { ok: false, code: "REFUND_OBSERVATION_TIE" };
  const sc = stopCode(ctx);
  if (sc) { noteStop(ctx, sc, "after_refund_read"); return { ok: false, code: `STOP_${sc}` }; }
  return { ok: true, ev: await evidenceById(ctx.pool, intent.id, rec.id), raw: obj };
}

/** One executed Hostaway by-id read -> evidence row (found_active / cancelled / not_found). */
async function readReservationById(ctx, intent, { reuseClaimed = null } = {}) {
  const rid = String(intent.reservation.reservationId);
  const op = reuseClaimed || await claimRead(ctx, intent, OPS.RES_READ, rid);
  if (!op) return { ok: false, code: "RESERVATION_READ_NOT_CLAIMED" };
  const req = Object.freeze({ method: "GET", path: `/reservations/${rid}`, query: {} });
  let resp;
  try { resp = await bounded(ctx, "readCallMs", (signal) => ctx.executors.retrieveReservation(req, { signal })).promise; }
  catch (e) { if (e instanceof WorkerStop) return stoppedRead(ctx, op, e, "reservation_read"); resp = null; }
  ctx.calls.push(`res_read:${rid}`);
  if (ctx.hooks.afterResRead) await ctx.hooks.afterResRead();
  { const sc = stopCode(ctx); if (sc) return stoppedRead(ctx, op, new WorkerStop(sc), "reservation_read"); }
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
  const sc = stopCode(ctx);
  if (sc) { noteStop(ctx, sc, "after_reservation_read"); return { ok: false, code: `STOP_${sc}` }; }
  return { ok: true, ev: await evidenceById(ctx.pool, intent.id, rec.id) };
}
/** One executed Hostaway by-ref lookup -> evidence row (only when the by-id read does not echo the booking ref). */
async function readReservationByRef(ctx, intent) {
  const op = await claimRead(ctx, intent, OPS.LOOKUP, intent.ref);
  if (!op) return { ok: false, code: "LOOKUP_NOT_CLAIMED" };
  let lk; let stop = null;
  try {
    lk = await lookupByRef({ ref: intent.ref, listingId: intent.listingId, arrivalDate: intent.from, departureDate: intent.to }, ctx.cfg,
      (req) => bounded(ctx, "readCallMs", (signal) => ctx.executors.lookupPage(req, { signal })).promise.catch((e) => { if (e instanceof WorkerStop) stop = e; throw e; }));
  } catch { lk = { outcome: "error" }; }
  if (stop || stopCode(ctx)) return stoppedRead(ctx, op, stop || new WorkerStop(stopCode(ctx)), "lookup");
  ctx.calls.push(`lookup:${intent.ref}`);
  if (ctx.hooks.afterLookup) await ctx.hooks.afterLookup();
  { const sc = stopCode(ctx); if (sc) return stoppedRead(ctx, op, new WorkerStop(sc), "lookup"); }
  if (lk.outcome === "found" || lk.outcome === "not_found") {
    const d = await finishRead(ctx, op, "succeeded");
    if (!d.ok) return { ok: false, code: "LEASE_LOST" };
    const r = lk.reservation;
    const ev = lk.outcome === "found"
      ? { externalRef: String(r.reservationId), status: r.status === "cancelled" ? "cancelled" : "found_active", observed: { bookingRef: intent.ref, matchCount: 1, ...RW.observedReservation(r) } }
      : { externalRef: intent.ref, status: "not_found", observed: { bookingRef: intent.ref, matchCount: 0 } };
    const rec = await recordProviderEvidence(ctx.pool, { readOpId: op.id, kind: "hostaway_reservation", ...ev });
    if (!rec.ok) return { ok: false, code: "EVIDENCE_NOT_RECORDED" };
    return { ok: true, ev: await evidenceById(ctx.pool, intent.id, rec.id) };
  }
  if (lk.outcome === "conflict") { await finishRead(ctx, op, "succeeded"); throw new Escalate(lk.code === "DUPLICATE_REF" ? "DUPLICATE_BOOKING_REF" : "LOOKUP_CONTRADICTS_STAY"); }
  await finishRead(ctx, op, "outcome_unknown", "LOOKUP_INCONCLUSIVE");
  return { ok: false, code: "LOOKUP_INCONCLUSIVE" };
}
/**
 * The read-only Refund LIST discovery (§5): GET /v1/refunds?payment_intent={pi}&limit=100 through the injected executor. There is no accepted
 * operation type / evidence kind for a list reply, so it is NOT persisted: it only DISCOVERS a candidate id, which the persisted exact GET decides.
 * Bounded: executed at most ONCE per step and only right after an executed PI read of this step (so ≤ the PI-read budget across sessions).
 */
async function listRefundsOnce(ctx, intent) {
  if (ctx.listed) return { ok: false, code: "LIST_ALREADY_EXECUTED" };
  ctx.listed = true;
  const pi = intent.payment.paymentIntentId;
  let obj;
  try { obj = await bounded(ctx, "readCallMs", (signal) => ctx.executors.listRefunds(pi, { limit: REFUND_LIST_LIMIT }, { signal })).promise; }
  catch (e) { if (e instanceof WorkerStop) { noteStop(ctx, e.code, "refund_list"); return { ok: false, code: `STOP_${e.code}` }; } return { ok: false, code: "REFUND_LIST_FAILED" }; }
  ctx.calls.push(`refund_list:${pi}`);
  return { ok: true, list: obj };
}

// ---------------------------------------------------------------------------------------------
// shared pieces

const wait = (ctx, code) => { ctx.actions.push(`WAIT:${code}`); return { delayMs: TEST_CLEANUP_WORKER_LIMITS.waitMs, waiting: true }; };

/** Pre-send: CURRENT op + work leases with whole-call room, intent version / state / open leg, payment attempt, the ONE capture row, immutable evidence
 *  ids + times still fresh at the fresh clock (read AFTER all reads), stop signal / deadline / step budget. -> { refusal } | { intent, op, now } */
async function preSendCommon(ctx, plan, leg) {
  const o = await opRow(ctx.pool, plan.opId);
  const w = (await ctx.pool.query("SELECT work_worker_id, work_lease_until FROM booking.intent_work WHERE intent_id = $1", [plan.intentId])).rows[0];
  const i = await loadIntent(ctx.pool, plan.intentId);
  const pa = i ? await boundPaymentAttempt(ctx.pool, i) : null;
  const caps = (await rowsOf(ctx.pool, plan.intentId, OPS.CAPTURE)).map(asOp);
  const evs = [];
  for (const id of plan.evidenceIds) evs.push(await evidenceById(ctx.pool, plan.intentId, id));
  const now = ctx.clock();
  const need = ctx.timeouts.writeCallMs + TEST_CLEANUP_WORKER_LIMITS.sendMarginMs;
  if (!o || o.state !== "in_flight" || o.lease_worker_id !== ctx.workerId || o.attempts !== 1) return { refusal: "OPERATION_NOT_HELD" };
  if (!(ms(o.lease_until) - now > need)) return { refusal: "OPERATION_LEASE_TOO_SHORT" };
  if (!w || w.work_worker_id !== ctx.workerId) return { refusal: "WORK_LEASE_NOT_HELD" };
  if (!(ms(w.work_lease_until) - now > need)) return { refusal: "WORK_LEASE_TOO_SHORT" };
  if (!i || i.version !== plan.intentVersion || i.status !== plan.status || !legOpen(i, leg)) return { refusal: "INTENT_CHANGED" };
  if (!ctx.listings.has(i.listingId) || i.id !== ctx.intentId || !i.reservation || isProtectedReservationId(i.reservation.reservationId)) return { refusal: "OUT_OF_SCOPE_OR_PROTECTED" };
  if (pa !== plan.paymentAttemptId) return { refusal: "PAYMENT_ATTEMPT_CHANGED" };
  const cap = singleCaptureProof({ intent: i, captureRows: caps });
  if (!cap.ok || cap.fingerprint !== plan.captureFingerprint || cap.chargeId !== plan.chargeId) return { refusal: "CAPTURE_HISTORY_CHANGED" };
  for (let k = 0; k < evs.length; k++) {
    const e = evs[k];
    if (!e || e.observedAt !== plan.evidenceObservedAts[k]) return { refusal: "EVIDENCE_MISSING" };
    if (!(e.observedAt <= now && now - e.observedAt <= PROOF_MAX_AGE_MS && e.observedAt >= plan.enteredAt)) return { refusal: "EVIDENCE_STALE" };
  }
  const sc = stopCode(ctx);
  if (sc) { noteStop(ctx, sc, "pre_send"); return { refusal: `STOP_${sc}` }; }
  if (!(ctx.stepEndsAt - ctx.mono() > ctx.timeouts.writeCallMs)) return { refusal: "STEP_BUDGET" };
  if (ctx.deadlineAt !== null && !(ctx.deadlineAt - now > ctx.timeouts.writeCallMs)) { noteStop(ctx, "DEADLINE", "pre_send"); return { refusal: "STOP_DEADLINE" }; }   // whole-call room before the deadline too
  return { intent: i, op: asOp(o), caps, now };
}

async function settleUnknown(ctx, intent, op, leg, code) {
  if (ctx.hooks.beforeSettleUnknown) await ctx.hooks.beforeSettleUnknown(op, code);
  const c = sanitize(code);
  const u = await completeOperation(ctx.pool, op.id, { workerId: ctx.workerId, now: ctx.clock(), outcome: { status: "outcome_unknown", errorCode: c } });
  if (!u.ok) { ctx.actions.push(`LEASE_LOST:${u.error}`); return { delayMs: 0 }; }
  const type = leg === "authorization" ? "REFUND_OUTCOME_UNKNOWN" : "RESERVATION_CANCEL_OUTCOME_UNKNOWN";
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
    outcome: positive(late) ? { status: "succeeded", resultRef: op.op_type === OPS.REFUND ? late.id : op.payload.reservationId } : { status: "outcome_unknown", errorCode: "LATE_PROVIDER_RESULT" } });
}
/** the pending read E3 queued for an unknown outcome (or a bounded new one), executed once it is ≥ dispatch + 2 min */
async function dueRead(ctx, intent, row, readOpType, selector) {
  const notBefore = ms(row.dispatched_at) + FRESH_AFTER_DISPATCH_MS;
  if (ctx.clock() < notBefore) return { wait: "EVIDENCE_FRESHNESS" };
  const field = READ_FIELD[readOpType];
  const pend = (await ctx.pool.query(
    `SELECT id FROM booking.external_operations WHERE intent_id = $1 AND op_type = $2 AND state = 'pending' AND payload ->> $3 = $4 ORDER BY created_at LIMIT 1`,
    [intent.id, readOpType, field, selector])).rows[0];
  let op;
  if (pend) { await admitRead(ctx, intent, readOpType); op = await claimNextOperation(ctx.pool, { workerId: ctx.workerId, now: ctx.clock(), opId: pend.id, opTypes: [readOpType] }); }   // F2: same admission for a reused row
  else op = await claimRead(ctx, intent, readOpType, selector);
  if (!op) return { wait: "READ_NOT_CLAIMED" };
  return { op };
}

// ---------------------------------------------------------------------------------------------
// reservation leg (Hostaway host-cancel, ONE attempt) — worked FIRST

/** cancel row outcome_unknown (or succeeded with its event lost): the queued reservation read decides; never a resend; still-active → E3 owner case */
async function cancelReconcile(ctx, intent, row) {
  const rid = String(intent.reservation.reservationId);
  const d = await dueRead(ctx, intent, row, OPS.RES_READ, rid);
  if (d.wait) return wait(ctx, d.wait);
  const r = await readReservationById(ctx, intent, { reuseClaimed: d.op });
  ctx.actions.push(r.ok ? `READ:${OPS.RES_READ}` : `READ!${r.code}`);
  if (!r.ok) return ctx.stop ? { delayMs: 0, stopped: true } : { delayMs: 0, waiting: true };
  const st0 = stopped(ctx, "before_cancel_settlement"); if (st0) return st0;
  const ev = r.ev;
  const idState = reservationIdentity(ev, intent, rid);
  if (ev.status === "not_found" || idState === "incomplete") return wait(ctx, "RESERVATION_READ_INCONCLUSIVE");
  if (idState === "mismatch") return escalate(ctx, intent, "CANCEL_IDENTITY_MISMATCH");
  let settledTo = null;
  if (row.state === "outcome_unknown") {
    const s = await settleOperationFromEvidence(ctx.pool, row.id, ev.id);       // accepted function: cancel rows are its explicit branch
    if (!s.ok) return s.error === "EVIDENCE_TOO_EARLY" ? wait(ctx, "EVIDENCE_FRESHNESS") : escalate(ctx, intent, `CANCEL_SETTLE_${codeOf(s.error)}`);
    settledTo = s.state;
  } else if (ev.status === "found_active") return escalate(ctx, intent, "CANCEL_EVIDENCE_CONTRADICTS_OPERATION");
  const type = ev.status === "cancelled" ? "RESERVATION_CANCELLED" : "RECONCILED_RESERVATION_STILL_ACTIVE";
  const fence = scopeFence(ctx, intent);
  const res = await applyChecked(ctx, intent.id, { type, id: `op-outcome:${row.id}` }, async (cx, { before }) => {
    fence(before);
    if (!legOpen(before, "reservation")) throw new RepoError("STALE_OUT_OF_SCOPE");
    const o = (await cx.query("SELECT state, settled_evidence_id FROM booking.external_operations WHERE id = $1 FOR SHARE", [row.id])).rows[0];
    if (!o || o.state !== (settledTo ?? row.state) || (settledTo && o.settled_evidence_id !== ev.id)) throw new RepoError("STALE_OUT_OF_SCOPE");
    if (type === "RESERVATION_CANCELLED" && o.state !== "succeeded") throw new RepoError("STALE_OUT_OF_SCOPE");
    const n = (await cx.query(`SELECT 1 FROM booking.provider_evidence e WHERE e.id = $1 AND e.intent_id = $2 AND e.kind = 'hostaway_reservation' AND e.status = $3
                                 AND e.external_ref = $4 AND e.observed_at >= $5`, [ev.id, intent.id, ev.status, rid, row.dispatched_at])).rowCount;
    if (n !== 1) throw new RepoError("EVIDENCE_LINK_INVALID");
  }, { success: true, where: type });
  ctx.actions.push(res.ok ? `${type}->${res.intent.status}` : `${type}!${res.error}`);
  return { delayMs: 0 };
}

async function reservationLeg(ctx, intent, pa) {
  const cancels = await rowsOf(ctx.pool, intent.id, OPS.CANCEL);
  if (cancels.length !== 1) return escalate(ctx, intent, cancels.length === 0 ? "CANCEL_ROW_MISSING" : "CANCEL_HISTORY_MULTIPLE");
  const row = cancels[0];
  if (row.state === "outcome_unknown" || row.state === "succeeded") return cancelReconcile(ctx, intent, row);
  if (row.state === "failed_definite") {
    const fence = scopeFence(ctx, intent);
    const r = await applyChecked(ctx, intent.id, { type: "RESERVATION_CANCEL_FAILED", id: `op-outcome:${row.id}`, code: sanitize(row.error_code || "CANCEL_REFUSED") },
      async (_c, { before }) => { fence(before); if (!legOpen(before, "reservation")) throw new RepoError("STALE_OUT_OF_SCOPE"); });
    ctx.actions.push(r.ok ? `RESERVATION_CANCEL_FAILED->${r.intent.status}` : `RESERVATION_CANCEL_FAILED!${r.error}`);
    return { delayMs: 0 };
  }
  if (row.state !== "pending") return wait(ctx, `CANCEL_${row.state.toUpperCase()}`);       // in_flight elsewhere: maintenance decides
  if (row.attempts !== 0 || row.dispatched_at !== null) return escalate(ctx, intent, "CANCEL_ROW_INCONSISTENT");
  let st = stopped(ctx, "before_cancel_reads"); if (st) return st;
  const caps = (await rowsOf(ctx.pool, intent.id, OPS.CAPTURE)).map(asOp);
  const cap = singleCaptureProof({ intent, captureRows: caps });
  if (!cap.ok) return escalate(ctx, intent, `CAPTURE_${cap.code}`);
  // fresh verified TEST account + captured, NOT refunded PaymentIntent proof (money is the refund leg's; a cancel never settles it)
  const tz = ctx.listings.get(intent.listingId).timeZone;
  const arr0 = arrivalStrictlyFuture(intent.from, tz, ctx.clock());
  if (!arr0.ok) return escalate(ctx, intent, `CANCEL_${arr0.code}`);
  const pr = await readPaymentIntent(ctx, intent);
  if (!pr.ok) return ctx.stop ? { delayMs: 0, stopped: true } : wait(ctx, pr.code);
  st = stopped(ctx, "after_pi_read"); if (st) return st;
  // F3 (ROOT 5880626183): the RAW refund / dispute safeguards gate the CANCEL too — a disputed / partly refunded charge never gets a PUT
  const raw = rawPiPreSendRefusal(pr.raw, { paymentIntentId: intent.payment.paymentIntentId, chargeId: cap.chargeId, amountMinor: intent.payment.capturedMinor, currency: intent.price.currency });
  if (raw) return escalate(ctx, intent, `CANCEL_PRECONDITION_${raw}`);
  // current reservation identity (by id; by ref when the ref is not echoed)
  const br = await readReservationById(ctx, intent);
  if (!br.ok) return ctx.stop ? { delayMs: 0, stopped: true } : wait(ctx, br.code);
  if (br.ev.status === "cancelled") return escalate(ctx, intent, "RESERVATION_ALREADY_CANCELLED_EXTERNALLY");
  if (br.ev.status !== "found_active") return escalate(ctx, intent, "RESERVATION_NOT_FOUND");
  st = stopped(ctx, "after_reservation_read"); if (st) return st;
  let byRef = null;
  if (br.ev.observed.bookingRef !== intent.ref) {
    if (br.ev.observed.bookingRef != null) return escalate(ctx, intent, "BOOKING_REF_MISMATCH");
    const lk = await readReservationByRef(ctx, intent);
    if (!lk.ok) return ctx.stop ? { delayMs: 0, stopped: true } : wait(ctx, lk.code);
    byRef = lk.ev;
    st = stopped(ctx, "after_lookup"); if (st) return st;
  }
  const elig = cleanupCancelEligibility({ intent, paymentAttemptId: pa, cancelOp: asOp(row), captureRows: caps, byId: br.ev, byRef, piEvidence: pr.ev, rawPi: pr.raw, timeZone: tz, now: ctx.clock(), notBefore: ctx.enteredAt });
  if (!elig.ok) return escalate(ctx, intent, elig.code.startsWith("CANCEL_PRECONDITION_") ? elig.code : `CANCEL_PROOF_${elig.code}`);
  const built = buildCleanupCancelRequest({ intent, cancelOp: asOp(row), captureRows: caps, eligibility: elig, paymentAttemptId: pa, timeZone: tz, now: ctx.clock(), notBefore: ctx.enteredAt });
  if (!built.ok) return escalate(ctx, intent, `CANCEL_REQUEST_${built.code}`);
  const plan = Object.freeze({ intentId: intent.id, intentVersion: intent.version, status: intent.status, opId: row.id, paymentAttemptId: pa, chargeId: cap.chargeId,
    captureFingerprint: cap.fingerprint, enteredAt: ctx.enteredAt, request: built.request, timeZone: tz, localDate: elig.snapshot.localDate,
    evidenceIds: [...elig.reservationEvidenceIds, elig.piEvidence.id], evidenceObservedAts: [...elig.reservationObservedAts, elig.piEvidence.observedAt] });
  if (ctx.hooks.beforeClaim) await ctx.hooks.beforeClaim(plan);
  st = stopped(ctx, "before_cancel_claim"); if (st) return st;
  const op = await claimNextOperation(ctx.pool, { workerId: ctx.workerId, now: ctx.clock(), opId: row.id, opTypes: [OPS.CANCEL] });
  if (!op) return wait(ctx, "CANCEL_NOT_CLAIMED");
  ctx.actions.push("CANCEL_CLAIMED");
  if (ctx.hooks.afterClaim) await ctx.hooks.afterClaim(op, plan);
  const pre = await preSendCommon(ctx, plan, "reservation");
  if (pre.refusal) { ctx.actions.push(`SEND_ABORTED:${pre.refusal}`); return settleUnknown(ctx, intent, op, "reservation", `SEND_ABORTED_${pre.refusal}`); }
  // the strictly-future arrival is re-checked at the fresh clock immediately before the send (local date unchanged since the eligibility)
  const arr = arrivalStrictlyFuture(pre.intent.from, plan.timeZone, pre.now);
  if (!arr.ok || arr.localDate !== plan.localDate) { ctx.actions.push("SEND_ABORTED:ARRIVAL"); return settleUnknown(ctx, intent, op, "reservation", "SEND_ABORTED_ARRIVAL"); }
  if (!validateCancelRequest(plan.request, { intent: pre.intent, cancelOp: pre.op }).ok) { ctx.actions.push("SEND_ABORTED:REQUEST_INVALID"); return settleUnknown(ctx, intent, op, "reservation", "SEND_ABORTED_REQUEST_INVALID"); }
  // no await between the decision above and the start of the call
  const req = plan.request;
  const rid = String(intent.reservation.reservationId);
  const call = bounded(ctx, "writeCallMs", (signal) => ctx.executors.cancelReservation(req, { signal }));
  ctx.calls.push(`cancel:${rid}`); ctx.sends += 1; ctx.cancelSends += 1;
  let reply; let timedOut = false; let failed = false; let stopAfter = null;
  try { reply = await call.promise; } catch (e) { if (e instanceof WorkerStop) stopAfter = e.code; timedOut = e instanceof ProviderCallTimeout; failed = true; }
  if (ctx.hooks.afterSend) await ctx.hooks.afterSend(op);
  const positive = (x) => {
    const env = isObj(x) && x.httpStatus === 200 ? unwrapEnvelope(x.json) : { ok: false };
    const n = env.ok ? normalizeReservation(env.result, ctx.cfg) : { ok: false };
    return n.ok && String(n.reservation.reservationId) === rid && n.reservation.status === "cancelled";
  };
  // a stop observed while the PUT was in flight, or right after it: the write MAY have applied → uncertainty bookkeeping only, no further provider call
  const stopNow = stopAfter || stopCode(ctx);
  if (stopNow) {
    noteStop(ctx, stopNow, "after_cancel_send");
    const settled = settleUnknown(ctx, intent, op, "reservation", `STOP_${stopNow}_AFTER_SEND`);
    if (stopAfter && call.raw) ctx.late.push(Promise.all([call.raw.catch(() => null), settled]).then(([late]) => lateResult(ctx, op, late, positive)).catch(() => {}));
    return settled;
  }
  if (timedOut) {
    const settled = settleUnknown(ctx, intent, op, "reservation", "CANCEL_TIMEOUT");
    if (call.raw) ctx.late.push(Promise.all([call.raw.catch(() => null), settled]).then(([late]) => lateResult(ctx, op, late, positive)).catch(() => {}));
    return settled;
  }
  if (failed || !positive(reply)) return settleUnknown(ctx, intent, op, "reservation", failed ? "CANCEL_CALL_FAILED" : "CANCEL_REPLY_NOT_CANCELLED");
  // a reply is never enough: a confirming by-id read (+ ref lookup when not echoed) showing THIS reservation cancelled
  let cr; let ce = null;
  try { cr = await readReservationById(ctx, intent); } catch { cr = { ok: false }; }
  if (!cr.ok) return settleUnknown(ctx, intent, op, "reservation", ctx.stop ? `STOP_${ctx.stop.code}_AFTER_SEND` : "CONFIRM_READ_FAILED");
  const evIds = [cr.ev.id];
  const confirmOk = (e) => e && e.status === "cancelled" && e.externalRef === rid && reservationIdentity(e, intent, rid) === "ok" && e.observed.status === "cancelled";
  if (!confirmOk(cr.ev)) return settleUnknown(ctx, intent, op, "reservation", "CONFIRM_READ_NOT_CANCELLED");
  if (cr.ev.observed.bookingRef !== intent.ref) {
    if (cr.ev.observed.bookingRef != null) return settleUnknown(ctx, intent, op, "reservation", "CONFIRM_REF_MISMATCH");
    try { ce = await readReservationByRef(ctx, intent); } catch { ce = { ok: false }; }
    if (!ce.ok || !confirmOk(ce.ev) || ce.ev.observed.matchCount !== 1) return settleUnknown(ctx, intent, op, "reservation", ctx.stop ? `STOP_${ctx.stop.code}_AFTER_SEND` : "CONFIRM_LOOKUP_NOT_CANCELLED");
    evIds.push(ce.ev.id);
  }
  if (ctx.hooks.afterConfirmEvidence) await ctx.hooks.afterConfirmEvidence(op);
  // no success after a stop: a confirmation that lands late is bookkeeping, never authority
  const stopBefore = stopCode(ctx);
  if (stopBefore) { noteStop(ctx, stopBefore, "before_cancel_success"); return settleUnknown(ctx, intent, op, "reservation", `STOP_${stopBefore}_AFTER_SEND`); }
  const c = await completeOperation(ctx.pool, op.id, { workerId: ctx.workerId, now: ctx.clock(), outcome: { status: "succeeded", resultRef: rid } });
  if (!c.ok) { ctx.actions.push(`LEASE_LOST:${c.error}`); return { delayMs: 0 }; }
  if (ctx.hooks.afterComplete) await ctx.hooks.afterComplete(op);
  // R1: the row is now DURABLY succeeded (never rewritten); a stop here leaves the leg open — the next session proves it read-only, no second PUT
  { const sc = stopCode(ctx); if (sc) { noteStop(ctx, sc, "after_cancel_complete"); ctx.actions.push("CANCEL_ROW_SUCCEEDED_EVENT_DEFERRED"); return { delayMs: 0, stopped: true }; } }
  const fence = scopeFence(ctx, intent);
  const r = await applyChecked(ctx, intent.id, { type: "RESERVATION_CANCELLED", id: `op-outcome:${op.id}` }, async (cx, { before }) => {
    fence(before);
    if (!legOpen(before, "reservation")) throw new RepoError("STALE_OUT_OF_SCOPE");
    const o = (await cx.query("SELECT state FROM booking.external_operations WHERE id = $1 FOR SHARE", [op.id])).rows[0];
    if (!o || o.state !== "succeeded") throw new RepoError("STALE_OUT_OF_SCOPE");
    const n = (await cx.query(`SELECT count(*) AS n FROM booking.provider_evidence e WHERE e.id = ANY($1) AND e.intent_id = $2 AND e.kind = 'hostaway_reservation'
                                 AND e.status = 'cancelled' AND e.external_ref = $3 AND e.observed_at >= $4`, [evIds, intent.id, rid, op.dispatched_at])).rows[0].n;
    if (Number(n) !== evIds.length) throw new RepoError("EVIDENCE_LINK_INVALID");
  }, { success: true, where: "RESERVATION_CANCELLED" });
  ctx.actions.push(r.ok ? `RESERVATION_CANCELLED->${r.intent.status}` : `RESERVATION_CANCELLED!${r.error}`);
  return { delayMs: 0 };
}

// ---------------------------------------------------------------------------------------------
// money leg (the ONE bound FULL refund) — only after the reservation leg is settled

/** explicit evidence-bound settlement of an outcome_unknown REFUND row (0020 booking.settle_test_refund_from_evidence); never the generic function */
export async function settleRefundFromEvidence(pool, opId, evidenceId) {
  try {
    const r = await pool.query("SELECT booking.settle_test_refund_from_evidence($1, $2) AS state", [opId, evidenceId]);
    return { ok: true, state: r.rows[0].state };
  } catch (e) {
    const m = /^([A-Z_]+)/.exec(e.message || "");
    if (e.code === "23514" && m) return { ok: false, error: m[1] };
    throw e;
  }
}

/** after the bound Refund read + PI read: complete / settle the row and apply the verified REFUND_SUCCEEDED (DB guard re-verifies test_refund_settled_for) */
async function refundProven(ctx, intent, pa, row, { refundEv, piEv, chargeId, settledTo = null, completeNow = false }) {
  const refundId = refundEv.externalRef;
  const dispatchedAt = ms(row.dispatched_at);
  const rp = refundReadProof(refundEv, { intent, chargeId, refundId, dispatchedAt, now: ctx.clock() });
  if (rp) return { ok: false, code: `REFUND_READ_${rp}` };
  const pp = piCapturedFullyRefundedProofV3(piEv, intent, pa, chargeId, { now: ctx.clock(), notBefore: dispatchedAt });
  if (pp) return { ok: false, code: `PI_READ_${pp}` };
  const sc = stopCode(ctx);
  if (sc) { noteStop(ctx, sc, "before_refund_success"); return { ok: false, code: `STOP_${sc}` }; }        // no terminal success / claim release after a stop
  if (completeNow) {
    const c = await completeOperation(ctx.pool, row.id, { workerId: ctx.workerId, now: ctx.clock(), outcome: { status: "succeeded", resultRef: refundId } });
    if (!c.ok) { ctx.actions.push(`LEASE_LOST:${c.error}`); return { ok: false, code: "LEASE_LOST", done: true }; }
    if (ctx.hooks.afterComplete) await ctx.hooks.afterComplete(row);
  }
  // R1: re-fenced AFTER the awaited completion / hook — the row (now durably succeeded, never rewritten) stays; the event waits for a later session
  { const sc = stopCode(ctx); if (sc) { noteStop(ctx, sc, "after_refund_complete"); ctx.actions.push("REFUND_ROW_SUCCEEDED_EVENT_DEFERRED"); return { ok: false, code: `STOP_${sc}`, done: true }; } }
  const fence = scopeFence(ctx, intent);
  const r = await applyChecked(ctx, intent.id, { type: "REFUND_SUCCEEDED", id: `op-outcome:${row.id}`, refundId, chargeId, amountMinor: intent.payment.capturedMinor, currency: intent.price.currency },
    async (cx, { before }) => {
      fence(before);
      if (!legOpen(before, "authorization")) throw new RepoError("STALE_OUT_OF_SCOPE");
      const o = (await cx.query("SELECT state, result_ref, settled_evidence_id FROM booking.external_operations WHERE id = $1 FOR SHARE", [row.id])).rows[0];
      if (!o || o.state !== "succeeded" || o.result_ref !== refundId || (settledTo && o.settled_evidence_id !== refundEv.id)) throw new RepoError("STALE_OUT_OF_SCOPE");
      const n = (await cx.query(`SELECT count(*) AS n FROM booking.provider_evidence e WHERE e.intent_id = $1 AND e.source = 'stripe_api' AND e.observed_at >= $4
                                   AND ((e.id = $2 AND e.kind = 'stripe_refund' AND e.external_ref = $5 AND e.status = 'succeeded')
                                     OR (e.id = $3 AND e.kind = 'payment_intent' AND e.external_ref = $6 AND e.status = 'succeeded'))`,
        [intent.id, refundEv.id, piEv.id, row.dispatched_at, refundId, intent.payment.paymentIntentId])).rows[0].n;
      if (Number(n) !== 2) throw new RepoError("EVIDENCE_LINK_INVALID");
    }, { success: true, where: "REFUND_SUCCEEDED" });
  ctx.actions.push(r.ok ? `REFUND_SUCCEEDED->${r.intent.status}` : `REFUND_SUCCEEDED!${r.error}`);
  return { ok: true, done: true };
}

/** refund row outcome_unknown (or succeeded with its event lost): PI read, then discovery (unknown) / the known id (succeeded), then the exact GET decides */
async function refundReconcile(ctx, intent, pa, row, chargeId) {
  const pi = intent.payment.paymentIntentId;
  const d = await dueRead(ctx, intent, row, OPS.PI_READ, pi);
  if (d.wait) return wait(ctx, d.wait);
  const pr = await readPaymentIntent(ctx, intent, { reuseClaimed: d.op });
  ctx.actions.push(pr.ok ? `READ:${OPS.PI_READ}` : `READ!${pr.code}`);
  if (!pr.ok) return ctx.stop ? { delayMs: 0, stopped: true } : { delayMs: 0, waiting: true };
  let st = stopped(ctx, "after_pi_read"); if (st) return st;
  let refundId;
  if (row.state === "succeeded") {
    refundId = row.result_ref;
    if (typeof refundId !== "string" || !/^re_[A-Za-z0-9_]{1,200}$/.test(refundId)) return escalate(ctx, intent, "REFUND_RESULT_REF_INVALID");
  } else {
    const l = await listRefundsOnce(ctx, intent);
    if (!l.ok) return ctx.stop ? { delayMs: 0, stopped: true } : wait(ctx, l.code);
    const disc = refundDiscovery({ list: l.list, intent, chargeId, opId: row.id, dispatchedAt: ms(row.dispatched_at), now: ctx.clock() });
    ctx.actions.push(disc.ok ? `DISCOVERED:${disc.status}` : `DISCOVERY!${disc.code}`);
    if (!disc.ok) return disc.code === "DISCOVERY_INPUT_INVALID" ? escalate(ctx, intent, disc.code) : refundFailed(ctx, intent, row, disc.code);   // owner STOP, never a resend
    refundId = disc.refundId;
  }
  st = stopped(ctx, "before_refund_read"); if (st) return st;
  const rr = await readRefund(ctx, intent, refundId);
  ctx.actions.push(rr.ok ? `READ:${OPS.REFUND_READ}:${rr.ev.status}` : `READ!${rr.code}`);
  if (!rr.ok) return ctx.stop ? { delayMs: 0, stopped: true } : { delayMs: 0, waiting: true };
  st = stopped(ctx, "before_refund_settlement"); if (st) return st;
  const status = rr.ev.status;
  if (status === "pending" || status === "requires_action") return wait(ctx, `REFUND_${status.toUpperCase()}`);   // bounded by the refund-read budget → owner
  let settledTo = null;
  if (row.state === "outcome_unknown") {
    const s = await settleRefundFromEvidence(ctx.pool, row.id, rr.ev.id);
    if (!s.ok) return s.error === "EVIDENCE_TOO_EARLY" ? wait(ctx, "EVIDENCE_FRESHNESS") : escalate(ctx, intent, `REFUND_SETTLE_${codeOf(s.error)}`);
    settledTo = s.state;
    ctx.actions.push(`REFUND_SETTLED:${settledTo}`);
  }
  if (status !== "succeeded") return refundFailed(ctx, intent, row, `REFUND_${status.toUpperCase()}`);
  if (row.state === "succeeded" && row.result_ref !== refundId) return escalate(ctx, intent, "REFUND_RESULT_REF_MISMATCH");
  const p = await refundProven(ctx, intent, pa, row, { refundEv: rr.ev, piEv: pr.ev, chargeId, settledTo });
  if (!p.ok && !p.done) return ctx.stop ? { delayMs: 0, stopped: true } : wait(ctx, p.code);          // e.g. the PI aggregates not yet showing the refund: read again later, bounded
  return { delayMs: 0 };
}

async function refundLeg(ctx, intent, pa) {
  const refunds = await rowsOf(ctx.pool, intent.id, OPS.REFUND);
  if (refunds.length !== 1) return escalate(ctx, intent, refunds.length === 0 ? "REFUND_ROW_MISSING" : "REFUND_HISTORY_MULTIPLE");
  const row = refunds[0];
  const caps = (await rowsOf(ctx.pool, intent.id, OPS.CAPTURE)).map(asOp);
  const cap = singleCaptureProof({ intent, captureRows: caps });
  if (!cap.ok) return escalate(ctx, intent, `CAPTURE_${cap.code}`);
  if (row.state === "outcome_unknown" || row.state === "succeeded") return refundReconcile(ctx, intent, pa, row, cap.chargeId);
  if (row.state === "failed_definite") return refundFailed(ctx, intent, row, `REFUND_${codeOf(row.error_code || "REFUSED")}`);
  if (row.state !== "pending") return wait(ctx, `REFUND_${row.state.toUpperCase()}`);
  if (row.attempts !== 0 || row.dispatched_at !== null) return escalate(ctx, intent, "REFUND_ROW_INCONSISTENT");
  let st = stopped(ctx, "before_refund_reads"); if (st) return st;
  const pr = await readPaymentIntent(ctx, intent);
  if (!pr.ok) return ctx.stop ? { delayMs: 0, stopped: true } : wait(ctx, pr.code);
  st = stopped(ctx, "after_pi_read"); if (st) return st;
  const elig = refundSendEligibility({ intent, paymentAttemptId: pa, refundOp: asOp(row), captureRows: caps, piEvidence: pr.ev, rawPi: pr.raw, now: ctx.clock(), notBefore: ctx.enteredAt });
  if (!elig.ok) return escalate(ctx, intent, elig.code.startsWith("REFUND_PRECONDITION_") ? elig.code : `REFUND_PROOF_${elig.code}`);
  const built = buildRefundRequest({ intent, refundOp: asOp(row), captureRows: caps, eligibility: elig, paymentAttemptId: pa, now: ctx.clock(), notBefore: ctx.enteredAt });
  if (!built.ok) return escalate(ctx, intent, `REFUND_REQUEST_${built.code}`);
  const plan = Object.freeze({ intentId: intent.id, intentVersion: intent.version, status: intent.status, opId: row.id, paymentAttemptId: pa, chargeId: cap.chargeId,
    captureFingerprint: cap.fingerprint, enteredAt: ctx.enteredAt, request: built.request, evidenceIds: [elig.piEvidence.id], evidenceObservedAts: [elig.piEvidence.observedAt] });
  if (ctx.hooks.beforeClaim) await ctx.hooks.beforeClaim(plan);
  st = stopped(ctx, "before_refund_claim"); if (st) return st;
  const op = await claimNextOperation(ctx.pool, { workerId: ctx.workerId, now: ctx.clock(), opId: row.id, opTypes: [OPS.REFUND] });
  if (!op) return wait(ctx, "REFUND_NOT_CLAIMED");
  ctx.actions.push("REFUND_CLAIMED");
  if (ctx.hooks.afterClaim) await ctx.hooks.afterClaim(op, plan);
  const pre = await preSendCommon(ctx, plan, "authorization");
  if (pre.refusal) { ctx.actions.push(`SEND_ABORTED:${pre.refusal}`); return settleUnknown(ctx, intent, op, "authorization", `SEND_ABORTED_${pre.refusal}`); }
  if (!validateRefundRequest(plan.request, { intent: pre.intent, refundOp: pre.op, chargeId: plan.chargeId }).ok) { ctx.actions.push("SEND_ABORTED:REQUEST_INVALID"); return settleUnknown(ctx, intent, op, "authorization", "SEND_ABORTED_REQUEST_INVALID"); }
  // no await between the decision above and the start of the call
  const req = plan.request;
  const call = bounded(ctx, "writeCallMs", (signal) => ctx.executors.createRefund(req.paymentIntentId, req.params, { idempotencyKey: req.options.idempotencyKey, signal }));
  ctx.calls.push(`refund:${req.paymentIntentId}`); ctx.sends += 1; ctx.refundSends += 1;
  let reply; let timedOut = false; let failed = false; let stopAfter = null;
  try { reply = await call.promise; } catch (e) { if (e instanceof WorkerStop) stopAfter = e.code; timedOut = e instanceof ProviderCallTimeout; failed = true; }
  if (ctx.hooks.afterSend) await ctx.hooks.afterSend(op);
  const idOf = (v) => (typeof v === "string" ? v : isObj(v) ? v.id : null);
  const positive = (x) => refundObjectUsable(x) && idOf(x.payment_intent) === req.paymentIntentId && idOf(x.charge) === plan.chargeId && x.amount === req.params.amount
    && String(x.currency || "").toUpperCase() === intent.price.currency && isObj(x.metadata) && x.metadata[REFUND_METADATA_KEYS.op] === op.id
    && x.metadata[REFUND_METADATA_KEYS.key] === req.options.idempotencyKey;
  // a stop observed while the POST was in flight, or right after it (F1b): the refund MAY exist → uncertainty bookkeeping only; no GET, no success, no release
  const stopNow = stopAfter || stopCode(ctx);
  if (stopNow) {
    noteStop(ctx, stopNow, "after_refund_send");
    const settled = settleUnknown(ctx, intent, op, "authorization", `STOP_${stopNow}_AFTER_SEND`);
    if (stopAfter && call.raw) ctx.late.push(Promise.all([call.raw.catch(() => null), settled]).then(([late]) => lateResult(ctx, op, late, (x) => positive(x) && x.status === "succeeded")).catch(() => {}));
    return settled;
  }
  if (timedOut) {
    const settled = settleUnknown(ctx, intent, op, "authorization", "REFUND_TIMEOUT");
    if (call.raw) ctx.late.push(Promise.all([call.raw.catch(() => null), settled]).then(([late]) => lateResult(ctx, op, late, (x) => positive(x) && x.status === "succeeded")).catch(() => {}));
    return settled;
  }
  if (failed || !positive(reply)) return settleUnknown(ctx, intent, op, "authorization", failed ? "REFUND_CALL_FAILED" : "REFUND_REPLY_UNUSABLE");
  // the reply is NOT proof: the bound Refund GET + the matching PI read decide (persisted as immutable API evidence), BEFORE the row completes
  let rr; let cr;
  try { rr = await readRefund(ctx, intent, reply.id); } catch { rr = { ok: false }; }
  if (!rr.ok) return settleUnknown(ctx, intent, op, "authorization", ctx.stop ? `STOP_${ctx.stop.code}_AFTER_SEND` : "CONFIRM_REFUND_READ_FAILED");
  const status = rr.ev.status;
  if (status === "pending" || status === "requires_action") return settleUnknown(ctx, intent, op, "authorization", `REFUND_${status.toUpperCase()}`);   // reads later; never a resend
  if (status !== "succeeded") {
    const c = await completeOperation(ctx.pool, op.id, { workerId: ctx.workerId, now: ctx.clock(), outcome: { status: "failed_definite", resultRef: reply.id, errorCode: `REFUND_${status.toUpperCase()}` } });
    if (!c.ok) { ctx.actions.push(`LEASE_LOST:${c.error}`); return { delayMs: 0 }; }
    return refundFailed(ctx, intent, op, `REFUND_${status.toUpperCase()}`);
  }
  try { cr = await readPaymentIntent(ctx, intent); } catch { cr = { ok: false }; }
  if (!cr.ok) return settleUnknown(ctx, intent, op, "authorization", ctx.stop ? `STOP_${ctx.stop.code}_AFTER_SEND` : "CONFIRM_PI_READ_FAILED");
  // the 0019 guard takes the LATEST PaymentIntent observation and refuses a tie: the confirming read must be observed strictly AFTER the pre-send read
  if (!(cr.ev.observedAt > plan.evidenceObservedAts[0])) return settleUnknown(ctx, intent, op, "authorization", "CONFIRM_PI_READ_NOT_LATER");
  if (ctx.hooks.afterConfirmEvidence) await ctx.hooks.afterConfirmEvidence(op);
  const p = await refundProven(ctx, intent, pa, op, { refundEv: rr.ev, piEv: cr.ev, chargeId: plan.chargeId, completeNow: true });
  if (!p.ok && !p.done) return settleUnknown(ctx, intent, op, "authorization", ctx.stop ? `STOP_${ctx.stop.code}_AFTER_SEND` : `CONFIRM_${p.code}`);
  return { delayMs: 0 };
}

// ---------------------------------------------------------------------------------------------

async function handleIntent(ctx, intent) {
  const row = (await ctx.pool.query("SELECT environment, listing_id, currency FROM booking.intents WHERE id = $1", [intent.id])).rows[0];
  if (!row || row.environment !== "test") { ctx.actions.push("STOP:INTENT_NOT_TEST"); return { delayMs: 0 }; }          // no event, no write
  if (!ctx.listings.has(intent.listingId) || intent.price.currency !== TEST_CLEANUP_LISTINGS[0].currency) { ctx.actions.push("STOP:LISTING_NOT_ALLOWED"); return { delayMs: 0 }; }
  if (!intent.reservation || isProtectedReservationId(intent.reservation.reservationId)) { ctx.actions.push("STOP:PROTECTED_RESERVATION_ID"); return { delayMs: 0 }; }
  ctx.enteredAt = await stateEnteredAt(ctx.pool, intent);
  if (!Number.isFinite(ctx.enteredAt)) return escalate(ctx, intent, "STATE_ENTRY_UNKNOWN");
  const pa = await boundPaymentAttempt(ctx.pool, intent);
  if (!pa) return escalate(ctx, intent, "PAYMENT_ATTEMPT_NOT_BOUND");
  try {
    if (legOpen(intent, "reservation")) return await reservationLeg(ctx, intent, pa);     // ORDER: cancel first; one provider write per step
    if (legOpen(intent, "authorization")) return await refundLeg(ctx, intent, pa);
    return wait(ctx, "NOTHING_DUE");
  } catch (e) {
    if (e instanceof Escalate) return escalate(ctx, intent, e.code);
    throw e;
  }
}

/**
 * runTestCleanupStep(pool, { workerId, env, adapterConfig, listings: Map<606998, {currency:"USD", timeZone}>, executors, clock, stripeAccountId, intentId,
 *                          timeouts?, monotonic?, hooks?, signal?, deadlineAt? })
 *   -> { status: "refused" | "idle" | "worked", code?, intentId, actions, calls, sends, cancelSends, refundSends, stop, facts, delayMs?, late }
 * One bounded step for ONE pinned intent: gate → TEST-database check → scoped maintenance → work claim → the next action of the open leg → release.
 */
export async function runTestCleanupStep(pool, opts = {}) {
  const { workerId, env, adapterConfig, listings, executors, clock, stripeAccountId, intentId, timeouts, hooks = {}, signal = null, deadlineAt = null } = opts;
  const g = testCleanupWorkerGate({ env, adapterConfig, listings, executors, clock, stripeAccountId, intentId });
  const none = { intentId: typeof intentId === "string" ? intentId : null, actions: [], calls: [], sends: 0, cancelSends: 0, refundSends: 0, stop: null, facts: null };
  if (!g.ok) return result("refused", { code: g.code, ...none });
  if (typeof workerId !== "string" || !/^[A-Za-z0-9._:-]{1,80}$/.test(workerId)) return result("refused", { code: "WORKER_ID_INVALID", ...none });
  if (signal !== null && (typeof signal !== "object" || typeof signal.aborted !== "boolean")) return result("refused", { code: "SIGNAL_INVALID", ...none });
  if (deadlineAt !== null && !Number.isFinite(deadlineAt)) return result("refused", { code: "DEADLINE_INVALID", ...none });
  try { await assertEnvironment(pool, "test"); } catch { return result("refused", { code: "DATABASE_NOT_TEST", ...none }); }
  const t = resolveTimeouts(timeouts);
  const mono = typeof opts.monotonic === "function" ? opts.monotonic : () => performance.now();
  const ctx = { pool, workerId, cfg: g.cfg, listings, listingIds: [...listings.keys()], executors, clock, hooks, intentId, stripeAccountId, timeouts: t, mono,
    stepEndsAt: mono() + t.stepBudgetMs, signal, deadlineAt, late: [], actions: [], calls: [], sends: 0, cancelSends: 0, refundSends: 0, accountVerified: false, enteredAt: null,
    listed: false, stop: null };
  const late = () => Promise.allSettled(ctx.late);
  const out = async (status, extra) => result(status, { intentId, actions: ctx.actions, calls: ctx.calls, sends: ctx.sends, cancelSends: ctx.cancelSends, refundSends: ctx.refundSends,
    stop: ctx.stop, facts: await observedFacts(pool, intentId), late: late(), ...extra });
  if (stopped(ctx, "start")) return out("idle", {});
  const claimed = await RW.claimWork(pool, { workerId, now: clock(), leaseMs: TEST_CLEANUP_WORKER_LIMITS.workLeaseMs, states: [...WORK_STATES], intentId, listingIds: ctx.listingIds });
  if (!claimed) return out("idle", {});
  let delayMs = TEST_CLEANUP_WORKER_LIMITS.waitMs;
  try {
    if (hooks.beforeMaintenance) await hooks.beforeMaintenance(intentId);
    await recoverExpiredOperations(pool, { now: clock(), limit: TEST_CLEANUP_WORKER_LIMITS.maintenanceBatch, opTypes: [...CLEANUP_OP_TYPES], intentId, listingIds: ctx.listingIds,
      intentStates: [...WORK_STATES] });
    const intent = await loadIntent(pool, intentId);
    if (intent && WORK_STATES.includes(intent.status)) ({ delayMs } = await handleIntent(ctx, intent));
  } finally {
    await RW.releaseWork(ctx, intentId, delayMs);
  }
  return out("worked", { delayMs });
}

export const _internal = Object.freeze({ resolveTimeouts, preSendCommon, legOpen, stopCode, observedFacts });
