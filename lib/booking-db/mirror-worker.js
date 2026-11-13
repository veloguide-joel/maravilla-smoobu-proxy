// lib/booking-db/mirror-worker.js — E7 recorded TEST cleanup: the Hostaway offline-refund MIRROR worker (OFFLINE; 0021 foundation; ROOT GO 5884739645).
// Bounded single-step worker for ONE pinned intent in test_cleanup_pending whose cancel + Stripe full-refund legs are BOTH proven, whose recording is
// succeeded + linked, whose notification is audited-suppressed, and whose ONE mirror op (ochr:<intent>:1) is pristine. Pure proofs: ../checkout/mirror-proof.js.
//
// INTERNAL LIBRARY ONLY: no route, cron, queue consumer, hosted runner / workflow, frontend, SDK client or default provider function. Every provider call
// goes through an INJECTED executor (exactly MIRROR_EXECUTOR_KEYS). Never executed here: capture, void, create, cancel, Stripe refund, recording,
// notification. DISABLED BY DEFAULT (two explicit env flags + dev/preview). It reuses the reviewed 0021 request / SQL completion / event APIs and does
// not rebuild or widen the cleanup / recording phases (the cancel and Stripe refund legs belong to cleanup-worker.js, which it never calls).
//
// Rules:
//   * ONE pinned intent (intentId REQUIRED; no sweeping), listing EXACTLY 606998 / USD, TEST database + TEST intent, protected reservation ids refused.
//   * Fresh proofs immediately pre-claim and re-read pre-send: verified TEST Stripe account + v3 PaymentIntent read (captured on the capture row's charge,
//     FULLY refunded); the bound reservation read showing `cancelled`; a complete fresh charge LIST with the original unchanged and ZERO mirror / linked /
//     same-amount refund rows (any untyped refund link → HOLD); the DATABASE's own legs predicate (booking.recorded_cleanup_legs_unsettled) NULL; version /
//     state / settlement / claim held / work + op leases with whole-call room; stop signal / deadline / step budget. The 0021 claim fence and the dedicated
//     completion re-check the legs again inside the database; the DB is the authority, the worker only fails earlier.
//   * Exactly ONE POST /v1/guestPayments/charges/{reservationId}/{offlineChargeId}/refund, body { title: 'maraVilla refund mvochr1-<intent>', amount: the full
//     POSITIVE recorded amount, isIncludeInPriceBreakdown: 0 }; the send counter is incremented BEFORE the transport call; no other provider write.
//   * The reply is NOT proof (admitted as a candidate only if result.id === refundInfo.chargeId and refundedChargeId === the original). The authoritative
//     confirming LIST is persisted as the 0021 typed observation and the row succeeds ONLY through booking.complete_offline_refund_with_evidence; then the
//     fenced OFFLINE_CHARGE_REFUND_RECORDED binds the exact refund row id (the repo re-reads the row; the DB ledger fence re-checks it).
//   * Lost / timed-out / non-200 / malformed / contradicted send → the row outcome_unknown and NOTHING else in this step; a later session reconciles READ-ONLY
//     (one fresh LIST) into an explicit owner case (ESCALATE with the evidence) — never a resend, never a new key, never a row re-opened.
//   * PR72 / cleanup stop discipline: worker-local bounded calls (per-call timeout, step budget, session deadline, outer signal), stop re-checks after every
//     await and in event admission (before entry, in the transaction, after its own proof queries); a stopped reply is inadmissible; no completion / terminal
//     after an observed stop; a row durably completed before a stop is preserved and its event honestly deferred to the next session.
//   * No raw provider error / credential output: codes only.
import { applyEvent, loadIntent, RepoError } from "./repo.js";
import { claimNextOperation, completeOperation, recordProviderEvidence, recoverExpiredOperations, requestRead, completeOfflineRefundWithEvidence } from "./operations.js";
import { assertEnvironment } from "./pool.js";
import { _internal as RW, ProviderCallTimeout, isProtectedReservationId } from "./reservation-worker.js";
import { TEST_CLEANUP_LISTINGS } from "./test-cleanup.js";
import { paymentIntentProofObservationV3 } from "../checkout/capture-proof.js";
import { OPS as CLEANUP_OPS, singleCaptureProof, piCapturedFullyRefundedProofV3 } from "../checkout/test-cleanup-proof.js";
import { configRefusal } from "../checkout/offline-charge-proof.js";
import { MIRROR_OP, PROOF_MAX_AGE_MS, MIRROR_LIST_LIMIT, mirrorIntentRefusal, mirrorOpRefusal, assessMirrorList, mirrorDiscovery, buildMirrorRequest,
  validateMirrorRequest, assessMirrorReply, mirrorConfirmingObservation, mirrorCountObservation } from "../checkout/mirror-proof.js";
import { STATES as S } from "../checkout/intent-state.js";
import { validateAdapterConfig, unwrapEnvelope, normalizeReservation } from "../hostaway-reservations.js";

export const MIRROR_WORKER_VERSION = "e7-mirror-worker-v1";
export const OPS = Object.freeze({ MIRROR: MIRROR_OP, PI_READ: CLEANUP_OPS.PI_READ, RES_READ: CLEANUP_OPS.RES_READ, LIST_READ: "hostaway.list_offline_charges", CAPTURE: CLEANUP_OPS.CAPTURE,
  REFUND: CLEANUP_OPS.REFUND });
export const WRITE_OP_TYPES = Object.freeze([OPS.MIRROR]);
export const READ_OP_TYPES = Object.freeze([OPS.PI_READ, OPS.RES_READ, OPS.LIST_READ]);
export const MIRROR_OP_TYPES = Object.freeze([...WRITE_OP_TYPES, ...READ_OP_TYPES]);
export const MIRROR_EXECUTOR_KEYS = Object.freeze(["retrieveAccount", "retrievePaymentIntent", "retrieveReservation", "listOfflineCharges", "refundOfflineCharge"]);
export const WORK_STATES = Object.freeze([S.TEST_CLEANUP_PENDING]);
export const MIRROR_WORKER_TIMEOUTS = Object.freeze({ readCallMs: 10000, writeCallMs: 20000, stepBudgetMs: 45000 });
/** budgets per intent since it entered test_cleanup_pending (reads of THIS worker share the cleanup worker's kinds; the LIST budget is its own) */
export const MIRROR_WORKER_LIMITS = Object.freeze({ workLeaseMs: 60 * 1000, sendMarginMs: 15 * 1000, waitMs: 30 * 1000,
  maxReads: Object.freeze({ [OPS.PI_READ]: 8, [OPS.RES_READ]: 12, [OPS.LIST_READ]: 12 }), maintenanceBatch: 20 });
export const STOP_CODES = Object.freeze(["SIGNAL", "DEADLINE", "STEP_BUDGET"]);
const ACCT_RE = /^acct_[A-Za-z0-9]{1,64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const result = (status, extra = {}) => Object.freeze({ status, ...extra });
const ms = (d) => (d == null ? null : new Date(d).getTime());
const sanitize = (code) => (/^[A-Z0-9_]{1,64}$/.test(code) ? code : "MIRROR_OPERATOR_REQUIRED");
const codeOf = (s) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9_]/g, "_").slice(0, 40);
class Escalate extends Error { constructor(code) { super(code); this.code = code; } }
class WorkerStop extends Error { constructor(code) { super(`STOP_${code}`); this.code = code; } }

function resolveTimeouts(t) {
  const out = {};
  for (const [k, d] of Object.entries(MIRROR_WORKER_TIMEOUTS)) { const v = isObj(t) ? t[k] : undefined; out[k] = Number.isFinite(v) && v > 0 ? Math.min(v, d) : d; }
  return Object.freeze(out);
}

// ---------------------------------------------------------------------------------------------
// gate (pure; nothing touched before it passes) — DISABLED BY DEFAULT

export function mirrorWorkerGate({ env, adapterConfig, recordingConfig, listings, executors, clock, stripeAccountId, intentId } = {}) {
  const e = isObj(env) ? env : null;
  if (!e) return { ok: false, code: "ENV_REQUIRED" };
  if (e.VERCEL_ENV === "production") return { ok: false, code: "PRODUCTION_REFUSED" };
  if (e.VERCEL_ENV !== "development" && e.VERCEL_ENV !== "preview") return { ok: false, code: "ENVIRONMENT_NOT_ALLOWED" };
  if (e.MV_E7_TEST_CLEANUP !== "enabled" || e.MV_E7_MIRROR_WORKER !== "enabled") return { ok: false, code: "NOT_ENABLED" };
  if (typeof intentId !== "string" || !UUID_RE.test(intentId)) return { ok: false, code: "INTENT_ID_REQUIRED" };
  if (typeof stripeAccountId !== "string" || !ACCT_RE.test(stripeAccountId)) return { ok: false, code: "STRIPE_ACCOUNT_REQUIRED" };
  let cfg;
  try { cfg = validateAdapterConfig(adapterConfig); } catch { return { ok: false, code: "ADAPTER_CONFIG_INVALID" }; }
  const rc = configRefusal(recordingConfig);
  if (rc) return { ok: false, code: `RECORDING_CONFIG_${rc}` };
  if (typeof clock !== "function" || !Number.isFinite(clock())) return { ok: false, code: "CLOCK_REQUIRED" };
  const allowed = TEST_CLEANUP_LISTINGS[0];
  if (TEST_CLEANUP_LISTINGS.length !== 1 || JSON.stringify(cfg.allowedListingIds) !== JSON.stringify([allowed.listingId]) || cfg.currency !== allowed.currency
      || recordingConfig.listingId !== allowed.listingId || recordingConfig.currency !== allowed.currency) return { ok: false, code: "LISTING_NOT_ALLOWED" };
  if (!(listings instanceof Map) || listings.size !== 1) return { ok: false, code: "LISTINGS_REQUIRED" };
  const lc = listings.get(allowed.listingId);
  if (!isObj(lc) || lc.currency !== allowed.currency) return { ok: false, code: "LISTING_NOT_ALLOWED" };
  if (!isObj(executors)) return { ok: false, code: "NO_EXECUTORS" };
  for (const k of Object.keys(executors)) if (!MIRROR_EXECUTOR_KEYS.includes(k)) return { ok: false, code: "EXECUTOR_NOT_ALLOWED" };
  for (const k of MIRROR_EXECUTOR_KEYS) if (typeof executors[k] !== "function") return { ok: false, code: "NO_EXECUTORS" };
  return { ok: true, cfg };
}

// ---------------------------------------------------------------------------------------------
// stop checks + worker-local bounded call (PR72 / cleanup discipline)

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
function stopped(ctx, where) {
  if (ctx.stop) return { delayMs: 0, stopped: true };
  const c = stopCode(ctx);
  return c ? noteStop(ctx, c, where) : null;
}
function bounded(ctx, kind, fn) {
  const pre = stopCode(ctx);
  if (pre) return { promise: Promise.reject(new WorkerStop(pre)), raw: null };
  const budgets = [ctx.timeouts[kind], ctx.stepEndsAt - ctx.mono()];
  if (ctx.deadlineAt !== null) budgets.push(ctx.deadlineAt - ctx.clock());
  const lim = Math.min(...budgets);
  if (!(lim > 0)) return { promise: Promise.reject(new WorkerStop(stopCode(ctx) || "STEP_BUDGET")), raw: null };
  const ac = new AbortController();
  let raw;
  try { raw = Promise.resolve(fn(ac.signal)); } catch (e) { raw = Promise.reject(e); }
  raw.catch(() => {});
  const promise = new Promise((resolve, reject) => {
    let done = false; let timer = null;
    const onAbort = () => finish(() => { ac.abort(); reject(new WorkerStop("SIGNAL")); });
    const finish = (f) => { if (done) return; done = true; if (timer) clearTimeout(timer); if (ctx.signal) ctx.signal.removeEventListener("abort", onAbort); f(); };
    raw.then((v) => finish(() => { const sc = stopCode(ctx); if (sc) reject(new WorkerStop(sc)); else resolve(v); }),
      (e) => finish(() => { const sc = stopCode(ctx); reject(sc ? new WorkerStop(sc) : e); }));
    timer = setTimeout(() => finish(() => { ac.abort(); const sc = stopCode(ctx); reject(sc ? new WorkerStop(sc) : new ProviderCallTimeout()); }), lim);
    if (ctx.signal) { if (ctx.signal.aborted) onAbort(); else ctx.signal.addEventListener("abort", onAbort, { once: true }); }
  });
  promise.catch(() => {});
  return { promise, raw };
}

// ---------------------------------------------------------------------------------------------
// fenced events / owner cases

function scopeFence(ctx, planned) {
  return (before) => {
    if (before.version !== planned.version || before.status !== planned.status || !WORK_STATES.includes(before.status) || before.id !== ctx.intentId
      || !ctx.listings.has(before.listingId)) throw new RepoError("STALE_OUT_OF_SCOPE");
  };
}
const mirrorOpen = (i) => mirrorIntentRefusal(i) === null;
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
        gate(`in_tx_after_checks_${where}`);
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
  const r = await applyChecked(ctx, intent.id, { type: "ESCALATE", id: `mw-escalate:${intent.id}:${c}:v${intent.version}`, code: c }, async (_c, { before }) => fence(before));
  ctx.actions.push(r.ok ? `ESCALATE:${c}` : `ESCALATE!${r.error}`);
  return { delayMs: 0 };
}
const wait = (ctx, code) => { ctx.actions.push(`WAIT:${code}`); return { delayMs: MIRROR_WORKER_LIMITS.waitMs, waiting: true }; };

// ---------------------------------------------------------------------------------------------
// rows / facts

const asOp = (r) => ({ id: r.id, opType: r.op_type, state: r.state, attempts: r.attempts, dispatchedAt: ms(r.dispatched_at), idempotencyKey: r.idempotency_key, payload: r.payload, resultRef: r.result_ref });
const opRow = async (q, opId) => (await q.query("SELECT * FROM booking.external_operations WHERE id = $1", [opId])).rows[0] || null;
const rowsOf = async (q, intentId, opType) => (await q.query("SELECT * FROM booking.external_operations WHERE intent_id = $1 AND op_type = $2 ORDER BY created_at, id", [intentId, opType])).rows;
async function boundPaymentAttempt(q, intent) {
  if (!intent.payment || !intent.payment.paymentIntentId) return null;
  const r = await q.query("SELECT id, livemode FROM booking.payment_attempts WHERE intent_id = $1 AND payment_intent_id = $2 AND status = 'completed'", [intent.id, intent.payment.paymentIntentId]);
  return r.rowCount === 1 && r.rows[0].livemode === false ? r.rows[0].id : null;
}
async function stateEnteredAt(q, intent) {
  const r = await q.query("SELECT min(at) AS t FROM booking.intent_transitions WHERE intent_id = $1 AND to_state = $2 AND from_state IS DISTINCT FROM to_state", [intent.id, intent.status]);
  return ms(r.rows[0].t);
}
async function evidenceById(q, intentId, id) {
  const r = await q.query(`SELECT e.id, e.kind, e.external_ref, e.status, e.observed, e.observed_at, r.op_type AS read_op_type, r.id AS read_op_id,
            coalesce(r.payload ->> 'paymentIntentId', r.payload ->> 'reservationId') AS request_ref
       FROM booking.provider_evidence e JOIN booking.external_operations r ON r.id = e.read_operation_id WHERE e.id = $1 AND e.intent_id = $2 AND e.source IN ('stripe_api', 'hostaway_api')`, [id, intentId]);
  const e = r.rows[0];
  return e ? { id: e.id, kind: e.kind, readOpType: e.read_op_type, requestRef: e.request_ref, externalRef: e.external_ref, status: e.status, observed: e.observed, observedAt: ms(e.observed_at), readOpId: e.read_op_id } : null;
}
/** the DATABASE's own view of the two other legs (0021 booking.recorded_cleanup_legs_unsettled; NULL = settled by the latest persisted facts) */
const legsUnsettled = async (q, intentId) => (await q.query("SELECT booking.recorded_cleanup_legs_unsettled($1) AS r", [intentId])).rows[0].r;
const claimHeld = async (q, intentId) => (await q.query("SELECT count(*)::int AS n FROM booking.inventory_claims WHERE intent_id = $1 AND released_at IS NULL", [intentId])).rows[0].n === 1;
/** read-only snapshot of the facts a stopped / finished step reports (never inferred) */
async function observedFacts(pool, intentId) {
  const i = (await pool.query("SELECT state, version, settlement_reservation_cancelled AS c, settlement_authorization_settled AS a, settlement_recording_mirrored AS m, offline_charge_id, reason_code FROM booking.intents WHERE id = $1", [intentId])).rows[0];
  const m = (await pool.query("SELECT state, attempts, result_ref, settled_evidence_id FROM booking.external_operations WHERE intent_id = $1 AND op_type = $2", [intentId, OPS.MIRROR])).rows;
  const led = (await pool.query("SELECT provider_ref FROM booking.payment_ledger WHERE intent_id = $1 AND entry = 'offline_charge_refund_recorded'", [intentId])).rows;
  const nt = (await pool.query("SELECT state, attempts FROM booking.external_operations WHERE intent_id = $1 AND op_type = 'guest.notify'", [intentId])).rows;
  return Object.freeze({ intentState: i ? i.state : null, version: i ? i.version : null, reasonCode: i ? i.reason_code : null, offlineChargeId: i ? i.offline_charge_id : null,
    settlement: i ? { reservationCancelled: i.c, authorizationSettled: i.a, recordingMirrored: i.m } : null, claimHeld: await claimHeld(pool, intentId),
    mirror: m.map((o) => ({ state: o.state, attempts: o.attempts, resultRef: o.result_ref, linked: o.settled_evidence_id !== null })),
    mirrorLedgerRefs: led.map((l) => l.provider_ref), notify: nt.map((o) => ({ state: o.state, attempts: o.attempts })) });
}

// ---------------------------------------------------------------------------------------------
// executed READS (bounded per kind since the intent entered test_cleanup_pending; persisted as immutable API evidence)

const READ_FIELD = { [OPS.PI_READ]: "paymentIntentId", [OPS.RES_READ]: "reservationId", [OPS.LIST_READ]: "reservationId" };
async function admitRead(ctx, intent, opType) {
  const used = Number((await ctx.pool.query(`SELECT coalesce(sum(attempts), 0) AS n FROM booking.external_operations WHERE intent_id = $1 AND op_type = $2 AND retry_class = 'read' AND created_at >= $3`,
    [intent.id, opType, new Date(ctx.enteredAt)])).rows[0].n);
  if (used >= MIRROR_WORKER_LIMITS.maxReads[opType]) throw new Escalate("MIRROR_READS_EXHAUSTED");
}
async function claimRead(ctx, intent, opType, selector) {
  const field = READ_FIELD[opType];
  let open = (await ctx.pool.query(`SELECT id, state FROM booking.external_operations WHERE intent_id = $1 AND op_type = $2 AND retry_class = 'read' AND state IN ('pending', 'in_flight') AND payload ->> $3 = $4 ORDER BY created_at LIMIT 1`,
    [intent.id, opType, field, selector])).rows[0];
  await admitRead(ctx, intent, opType);
  if (!open) {
    await requestRead(ctx.pool, intent.id, opType, selector, { now: ctx.clock() });
    open = (await ctx.pool.query(`SELECT id, state FROM booking.external_operations WHERE intent_id = $1 AND op_type = $2 AND retry_class = 'read' AND state = 'pending' AND payload ->> $3 = $4 ORDER BY created_at LIMIT 1`,
      [intent.id, opType, field, selector])).rows[0];
  }
  if (!open || open.state !== "pending") return null;
  return claimNextOperation(ctx.pool, { workerId: ctx.workerId, now: ctx.clock(), opId: open.id, opTypes: [opType] });
}
const finishRead = (ctx, op, status, errorCode) => completeOperation(ctx.pool, op.id, { workerId: ctx.workerId, now: ctx.clock(), outcome: { status, ...(errorCode ? { errorCode } : {}) } });
async function stoppedRead(ctx, op, e, where) {
  await finishRead(ctx, op, "outcome_unknown", `STOP_${e.code}`).catch(() => {});
  noteStop(ctx, e.code, where);
  return { ok: false, code: `STOP_${e.code}` };
}
async function observationTie(ctx, intentId, kind, externalRef, evidenceId) {
  const n = (await ctx.pool.query(`SELECT count(*)::int AS n FROM booking.provider_evidence e WHERE e.intent_id = $1 AND e.kind = $2 AND e.external_ref = $3
                                     AND e.observed_at = (SELECT observed_at FROM booking.provider_evidence WHERE id = $4)`, [intentId, kind, externalRef, evidenceId])).rows[0].n;
  return n !== 1;
}
async function verifyAccount(ctx) {
  if (ctx.accountVerified) return true;
  let a;
  try { a = await bounded(ctx, "readCallMs", (signal) => ctx.executors.retrieveAccount({ signal })).promise; } catch (e) { if (e instanceof WorkerStop) throw e; return false; }
  ctx.calls.push("account");
  if (!isObj(a) || a.object !== "account" || a.id !== ctx.stripeAccountId) throw new Escalate("STRIPE_ACCOUNT_MISMATCH");
  ctx.accountVerified = true;
  return true;
}
/** fresh v3 PaymentIntent read (captured on the capture row's charge and FULLY refunded) -> payment_intent evidence */
async function readPaymentIntent(ctx, intent) {
  const pi = intent.payment.paymentIntentId;
  const op = await claimRead(ctx, intent, OPS.PI_READ, pi);
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
  { const sc = stopCode(ctx); if (sc) return stoppedRead(ctx, op, new WorkerStop(sc), "pi_read"); }
  if (!isObj(obj) || obj.object !== "payment_intent" || obj.id !== pi || typeof obj.status !== "string" || obj.livemode !== false) { await finishRead(ctx, op, "outcome_unknown", "PI_READ_UNUSABLE"); return { ok: false, code: "PI_READ_UNUSABLE" }; }
  const done = await finishRead(ctx, op, "succeeded");
  if (!done.ok) return { ok: false, code: "LEASE_LOST" };
  const rec = await recordProviderEvidence(ctx.pool, { readOpId: op.id, kind: "payment_intent", externalRef: pi, status: obj.status, observed: paymentIntentProofObservationV3(obj, { accountVerified: true }) });
  if (!rec.ok) return { ok: false, code: "EVIDENCE_NOT_RECORDED" };
  if (await observationTie(ctx, intent.id, "payment_intent", pi, rec.id)) return { ok: false, code: "PI_OBSERVATION_TIE" };
  const sc = stopCode(ctx);
  if (sc) { noteStop(ctx, sc, "after_pi_read"); return { ok: false, code: `STOP_${sc}` }; }
  return { ok: true, ev: await evidenceById(ctx.pool, intent.id, rec.id), raw: obj };
}
/** fresh Hostaway by-id reservation read -> hostaway_reservation evidence (found_active / cancelled / not_found) */
async function readReservationById(ctx, intent) {
  const rid = String(intent.reservation.reservationId);
  const op = await claimRead(ctx, intent, OPS.RES_READ, rid);
  if (!op) return { ok: false, code: "RESERVATION_READ_NOT_CLAIMED" };
  const req = Object.freeze({ method: "GET", path: `/v1/reservations/${rid}`, query: Object.freeze({}) });
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
  if (await observationTie(ctx, intent.id, "hostaway_reservation", rid, rec.id)) return { ok: false, code: "RESERVATION_OBSERVATION_TIE" };
  const sc = stopCode(ctx);
  if (sc) { noteStop(ctx, sc, "after_reservation_read"); return { ok: false, code: `STOP_${sc}` }; }
  return { ok: true, ev: await evidenceById(ctx.pool, intent.id, rec.id) };
}
/**
 * fresh complete charge LIST -> assessed rows (typed links kept) + the persisted hostaway_offline_charges evidence: `observe(list)` returns the exact
 * observation to persist (count-only pre-send / reconciliation; the full 0021 proof shape for the confirming read) or { code } to refuse (row unknown).
 */
async function readChargeList(ctx, intent, observe, where) {
  const rid = String(intent.reservation.reservationId);
  const op = await claimRead(ctx, intent, OPS.LIST_READ, rid);
  if (!op) return { ok: false, code: "LIST_READ_NOT_CLAIMED" };
  const req = Object.freeze({ method: "GET", path: "/v1/guestPayments/charges", query: Object.freeze({ reservationId: rid, limit: MIRROR_LIST_LIMIT }) });
  let resp;
  try { resp = await bounded(ctx, "readCallMs", (signal) => ctx.executors.listOfflineCharges(req, { signal })).promise; }
  catch (e) { if (e instanceof WorkerStop) return stoppedRead(ctx, op, e, where); await finishRead(ctx, op, "outcome_unknown", "LIST_READ_FAILED"); return { ok: false, code: "LIST_READ_FAILED" }; }
  ctx.calls.push(`list:${rid}`);
  if (ctx.hooks.afterListRead) await ctx.hooks.afterListRead(where);
  { const sc = stopCode(ctx); if (sc) return stoppedRead(ctx, op, new WorkerStop(sc), where); }
  const T = ctx.clock();
  const list = assessMirrorList({ read: { accountRef: ctx.recordingConfig.accountRef, clientSnapshotId: ctx.clientSnapshotId, httpStatus: isObj(resp) ? resp.httpStatus : null, json: isObj(resp) ? resp.json : null,
    observedAt: T, request: { limit: MIRROR_LIST_LIMIT, reservationId: rid } }, intent, config: ctx.recordingConfig, now: T });
  if (!list.ok) { await finishRead(ctx, op, "outcome_unknown", codeOf(list.code)); return { ok: false, code: list.code }; }
  // the read itself succeeded: what was seen is ALWAYS persisted (the full 0021 proof shape when the observer accepts it, the accepted count-only shape
  // otherwise); a refused observation fails the mirror decision closed without pretending the provider did not answer
  const obs = observe(list);
  const accepted = !!(obs && obs.observed && !obs.code);
  const observed = accepted ? obs.observed : mirrorCountObservation({ list, intent });
  if (!observed) { await finishRead(ctx, op, "outcome_unknown", "OBSERVATION_REFUSED"); return { ok: false, code: "OBSERVATION_REFUSED", list }; }
  const d = await finishRead(ctx, op, "succeeded");
  if (!d.ok) return { ok: false, code: "LEASE_LOST" };
  const rec = await recordProviderEvidence(ctx.pool, { readOpId: op.id, kind: "hostaway_offline_charges", externalRef: rid, status: "listed", observed });
  if (!rec.ok) return { ok: false, code: `EVIDENCE_NOT_RECORDED_${codeOf(rec.error)}` };
  if (await observationTie(ctx, intent.id, "hostaway_offline_charges", rid, rec.id)) return { ok: false, code: "LIST_OBSERVATION_TIE" };
  const sc = stopCode(ctx);
  if (sc) { noteStop(ctx, sc, `after_${where}`); return { ok: false, code: `STOP_${sc}` }; }
  if (!accepted) return { ok: false, code: obs && obs.code ? obs.code : "OBSERVATION_REFUSED", list, ev: await evidenceById(ctx.pool, intent.id, rec.id) };
  return { ok: true, ev: await evidenceById(ctx.pool, intent.id, rec.id), list, extra: obs };
}

// ---------------------------------------------------------------------------------------------
// uncertainty / reconciliation (READ-ONLY; owner case; never a resend)

async function settleUnknown(ctx, op, code) {
  if (ctx.hooks.beforeSettleUnknown) await ctx.hooks.beforeSettleUnknown(op, code);
  const u = await completeOperation(ctx.pool, op.id, { workerId: ctx.workerId, now: ctx.clock(), outcome: { status: "outcome_unknown", errorCode: sanitize(code) } });
  ctx.actions.push(u.ok ? `MIRROR_UNKNOWN:${sanitize(code)}` : `LEASE_LOST:${u.error}`);
  return { delayMs: 0 };
}
/** the row is outcome_unknown (a send may have applied): ONE fresh LIST (persisted, count-only) decides the OWNER case code; nothing is sent, nothing re-opened */
async function reconcileUnknown(ctx, intent, row) {
  const st = stopped(ctx, "before_unknown_reconcile"); if (st) return st;
  const och = String(intent.offlineChargeId);
  const r = await readChargeList(ctx, intent, (list) => ({ observed: mirrorCountObservation({ list, intent }) }), "unknown_list_read");
  ctx.actions.push(r.ok ? "READ:LIST:UNKNOWN" : `READ!${r.code}`);
  if (!r.ok) return ctx.stop ? { delayMs: 0, stopped: true } : wait(ctx, r.code);
  const refunds = r.list.rows.filter((x) => x.type === "refund");
  const linked = refunds.filter((x) => x.link !== null && x.link.refundedChargeId === och);
  const code = refunds.some((x) => x.link === null) ? "MIRROR_UNKNOWN_AMBIGUOUS" : linked.length === 1 ? "MIRROR_UNKNOWN_LANDED" : linked.length === 0 ? "MIRROR_UNKNOWN_ABSENT" : "MIRROR_UNKNOWN_DUPLICATE";
  const st2 = stopped(ctx, "before_unknown_escalate"); if (st2) return st2;
  ctx.actions.push(`RECONCILED:${code}:${row.id}`);
  return escalate(ctx, intent, code);
}
/** the row is durably succeeded (its event deferred by an earlier stop): the DATABASE predicate decides, then the fenced terminal event */
async function finalizeDeferred(ctx, intent, row) {
  const st = stopped(ctx, "before_deferred_terminal"); if (st) return st;
  const settled = (await ctx.pool.query("SELECT booking.offline_refund_settled_for($1) AS ok", [intent.id])).rows[0].ok;
  if (settled !== true) return escalate(ctx, intent, "MIRROR_SUCCEEDED_UNPROVEN");
  return terminalEvent(ctx, intent, asOp(row), row.result_ref, row.settled_evidence_id);
}
async function terminalEvent(ctx, intent, op, refundId, evidenceId) {
  const fence = scopeFence(ctx, intent);
  const r = await applyChecked(ctx, intent.id, { type: "OFFLINE_CHARGE_REFUND_RECORDED", id: `op-outcome:${op.id}`, offlineChargeId: String(intent.offlineChargeId), offlineRefundId: refundId,
    amountMinor: intent.payment.capturedMinor, currency: intent.price.currency }, async (cx, { before }) => {
    fence(before);
    if (!mirrorOpen(before)) throw new RepoError("STALE_OUT_OF_SCOPE");
    const o = (await cx.query("SELECT state, result_ref, settled_evidence_id FROM booking.external_operations WHERE id = $1 FOR SHARE", [op.id])).rows[0];
    if (!o || o.state !== "succeeded" || o.result_ref !== refundId || o.settled_evidence_id !== evidenceId) throw new RepoError("STALE_OUT_OF_SCOPE");
    const n = (await cx.query(`SELECT 1 FROM booking.provider_evidence e WHERE e.id = $1 AND e.intent_id = $2 AND e.kind = 'hostaway_offline_charges' AND e.status = 'listed' AND e.external_ref = $3`,
      [evidenceId, intent.id, String(intent.reservation.reservationId)])).rowCount;
    if (n !== 1) throw new RepoError("EVIDENCE_LINK_INVALID");
  }, { success: true, where: "OFFLINE_CHARGE_REFUND_RECORDED" });
  ctx.actions.push(r.ok ? `OFFLINE_CHARGE_REFUND_RECORDED->${r.intent.status}` : `OFFLINE_CHARGE_REFUND_RECORDED!${r.error}`);
  return { delayMs: 0 };
}

// ---------------------------------------------------------------------------------------------
// the mirror leg

/** Pre-send: CURRENT op + work leases with whole-call room, intent version / state / settlement / claim, the DB legs predicate, the mirror row held as attempt 1,
 *  every pre-claim evidence id still present and fresh at the fresh clock (read AFTER all reads), stop. -> { refusal } | { intent, op, now } */
async function preSend(ctx, plan) {
  const o = await opRow(ctx.pool, plan.opId);
  const w = (await ctx.pool.query("SELECT work_worker_id, work_lease_until FROM booking.intent_work WHERE intent_id = $1", [plan.intentId])).rows[0];
  const i = await loadIntent(ctx.pool, plan.intentId);
  const pa = i ? await boundPaymentAttempt(ctx.pool, i) : null;
  const legs = await legsUnsettled(ctx.pool, plan.intentId);
  const held = await claimHeld(ctx.pool, plan.intentId);
  const evs = [];
  for (const id of plan.evidenceIds) evs.push(await evidenceById(ctx.pool, plan.intentId, id));
  const now = ctx.clock();
  const need = ctx.timeouts.writeCallMs + MIRROR_WORKER_LIMITS.sendMarginMs;
  if (!o || o.state !== "in_flight" || o.lease_worker_id !== ctx.workerId || o.attempts !== 1) return { refusal: "OPERATION_NOT_HELD" };
  if (!(ms(o.lease_until) - now > need)) return { refusal: "OPERATION_LEASE_TOO_SHORT" };
  if (!w || w.work_worker_id !== ctx.workerId) return { refusal: "WORK_LEASE_NOT_HELD" };
  if (!(ms(w.work_lease_until) - now > need)) return { refusal: "WORK_LEASE_TOO_SHORT" };
  if (!i || i.version !== plan.intentVersion || i.status !== plan.status || !mirrorOpen(i) || String(i.offlineChargeId) !== plan.offlineChargeId) return { refusal: "INTENT_CHANGED" };
  if (!ctx.listings.has(i.listingId) || i.id !== ctx.intentId || !i.reservation || isProtectedReservationId(i.reservation.reservationId)) return { refusal: "OUT_OF_SCOPE_OR_PROTECTED" };
  if (pa !== plan.paymentAttemptId) return { refusal: "PAYMENT_ATTEMPT_CHANGED" };
  if (!held) return { refusal: "CLAIM_NOT_HELD" };
  if (legs !== null) return { refusal: `LEGS_${legs}` };
  if (mirrorOpRefusal(asOp(o), i, { held: true })) return { refusal: "MIRROR_ROW_CHANGED" };
  for (let k = 0; k < evs.length; k++) {
    const e = evs[k];
    if (!e || e.observedAt !== plan.evidenceObservedAts[k]) return { refusal: "EVIDENCE_MISSING" };
    if (!(e.observedAt <= now && now - e.observedAt <= PROOF_MAX_AGE_MS && e.observedAt >= plan.enteredAt)) return { refusal: "EVIDENCE_STALE" };
  }
  const sc = stopCode(ctx);
  if (sc) { noteStop(ctx, sc, "pre_send"); return { refusal: `STOP_${sc}` }; }
  if (!(ctx.stepEndsAt - ctx.mono() > ctx.timeouts.writeCallMs)) return { refusal: "STEP_BUDGET" };
  if (ctx.deadlineAt !== null && !(ctx.deadlineAt - now > ctx.timeouts.writeCallMs)) { noteStop(ctx, "DEADLINE", "pre_send"); return { refusal: "STOP_DEADLINE" }; }
  return { intent: i, op: asOp(o), now };
}

async function mirrorLeg(ctx, intent, pa) {
  const rows = await rowsOf(ctx.pool, intent.id, OPS.MIRROR);
  if (rows.length !== 1) return escalate(ctx, intent, rows.length === 0 ? "MIRROR_ROW_MISSING" : "MIRROR_HISTORY_MULTIPLE");
  const row = rows[0];
  if (row.state === "outcome_unknown") return reconcileUnknown(ctx, intent, row);
  if (row.state === "succeeded") return finalizeDeferred(ctx, intent, row);
  if (row.state === "failed_definite") return escalate(ctx, intent, `MIRROR_FAILED_${codeOf(row.error_code || "REFUSED")}`);
  if (row.state !== "pending") return wait(ctx, `MIRROR_${row.state.toUpperCase()}`);                 // in_flight elsewhere / escalated: maintenance or owner
  const pre0 = mirrorOpRefusal(asOp(row), intent);
  if (pre0) return escalate(ctx, intent, `MIRROR_ROW_${pre0}`);                                        // e.g. attempts > 0 on a recovered lease: never a second attempt
  let st = stopped(ctx, "before_mirror_reads"); if (st) return st;
  // the recording that is being mirrored: the ONE succeeded, linked row for exactly the pinned original
  const recs = await rowsOf(ctx.pool, intent.id, "hostaway.record_offline_charge");
  if (recs.length !== 1 || recs[0].state !== "succeeded" || recs[0].settled_evidence_id === null || String(recs[0].result_ref) !== String(intent.offlineChargeId)) return escalate(ctx, intent, "RECORDING_NOT_PROVEN");
  const nt = await rowsOf(ctx.pool, intent.id, "guest.notify");
  if (nt.length !== 1 || nt[0].state !== "superseded" || nt[0].attempts !== 0) return escalate(ctx, intent, "NOTIFICATION_NOT_SUPPRESSED");
  if (!(await claimHeld(ctx.pool, intent.id))) return escalate(ctx, intent, "CLAIM_NOT_HELD");
  const legs0 = await legsUnsettled(ctx.pool, intent.id);
  if (legs0 !== null) return wait(ctx, `LEGS_${legs0}`);                                              // a later contradiction: the DB says the legs are not settled now
  const caps = (await rowsOf(ctx.pool, intent.id, OPS.CAPTURE)).map(asOp);
  const cap = singleCaptureProof({ intent, captureRows: caps });
  if (!cap.ok) return escalate(ctx, intent, `CAPTURE_${cap.code}`);
  // fresh Stripe proof: verified TEST account + the PaymentIntent captured on that charge and FULLY refunded
  const pr = await readPaymentIntent(ctx, intent);
  if (!pr.ok) return ctx.stop ? { delayMs: 0, stopped: true } : wait(ctx, pr.code);
  st = stopped(ctx, "after_pi_read"); if (st) return st;
  const pp = piCapturedFullyRefundedProofV3(pr.ev, intent, pa, cap.chargeId, { now: ctx.clock(), notBefore: ctx.enteredAt });
  if (pp) return escalate(ctx, intent, `STRIPE_NOT_FULLY_REFUNDED_${pp}`);
  // fresh reservation proof: cancelled
  const br = await readReservationById(ctx, intent);
  if (!br.ok) return ctx.stop ? { delayMs: 0, stopped: true } : wait(ctx, br.code);
  st = stopped(ctx, "after_reservation_read"); if (st) return st;
  if (br.ev.status !== "cancelled") return escalate(ctx, intent, br.ev.status === "not_found" ? "RESERVATION_NOT_FOUND" : "RESERVATION_NOT_CANCELLED");
  // fresh complete LIST: the original unchanged, no mirror / linked / same-amount refund, no untyped link (HOLD)
  let disc = null;
  const lr = await readChargeList(ctx, intent, (list) => { disc = mirrorDiscovery({ list, intent }); return disc.ok ? { observed: mirrorCountObservation({ list, intent }) } : disc; }, "presend_list_read");
  if (!lr.ok) {
    if (ctx.stop) return { delayMs: 0, stopped: true };
    if (disc && !disc.ok) { ctx.actions.push(`HOLD:${disc.code}`); return disc.hold ? escalate(ctx, intent, `MIRROR_HOLD_${disc.code}`) : wait(ctx, disc.code); }
    return wait(ctx, lr.code);
  }
  st = stopped(ctx, "after_list_read"); if (st) return st;
  const legs1 = await legsUnsettled(ctx.pool, intent.id);
  if (legs1 !== null) return wait(ctx, `LEGS_${legs1}`);
  const built = buildMirrorRequest({ intent, mirrorOp: asOp(row) });
  if (!built.ok) return escalate(ctx, intent, `MIRROR_REQUEST_${built.code}`);
  const plan = Object.freeze({ intentId: intent.id, intentVersion: intent.version, status: intent.status, opId: row.id, paymentAttemptId: pa, offlineChargeId: String(intent.offlineChargeId),
    enteredAt: ctx.enteredAt, request: built.request, evidenceIds: [pr.ev.id, br.ev.id, lr.ev.id], evidenceObservedAts: [pr.ev.observedAt, br.ev.observedAt, lr.ev.observedAt] });
  if (ctx.hooks.beforeClaim) await ctx.hooks.beforeClaim(plan);
  st = stopped(ctx, "before_mirror_claim"); if (st) return st;
  let op;
  try { op = await claimNextOperation(ctx.pool, { workerId: ctx.workerId, now: ctx.clock(), opId: row.id, opTypes: [OPS.MIRROR] }); }
  catch (e) { const m = /^MIRROR_CLAIM_FENCED: ?([A-Z_]*)/.exec(e && e.message || ""); if (e && e.code === "23514" && m) { ctx.actions.push(`CLAIM_FENCED:${m[1] || "REFUSED"}`); return wait(ctx, `CLAIM_FENCED_${m[1] || "REFUSED"}`); } throw e; }
  if (!op) return wait(ctx, "MIRROR_NOT_CLAIMED");
  ctx.actions.push("MIRROR_CLAIMED");
  if (ctx.hooks.afterClaim) await ctx.hooks.afterClaim(op, plan);
  const pre = await preSend(ctx, plan);
  if (pre.refusal) { ctx.actions.push(`SEND_ABORTED:${pre.refusal}`); return settleUnknown(ctx, op, `SEND_ABORTED_${pre.refusal}`); }
  if (!validateMirrorRequest(plan.request, { intent: pre.intent, mirrorOp: pre.op }).ok) { ctx.actions.push("SEND_ABORTED:REQUEST_INVALID"); return settleUnknown(ctx, op, "SEND_ABORTED_REQUEST_INVALID"); }
  // no await between the decision above and the start of the call; the counter moves BEFORE the transport
  const req = plan.request;
  const call = bounded(ctx, "writeCallMs", (signal) => ctx.executors.refundOfflineCharge(req, { signal }));
  ctx.calls.push(`mirror_post:${plan.offlineChargeId}`); ctx.sends += 1; ctx.mirrorSends += 1;
  let reply; let timedOut = false; let failed = false; let stopAfter = null;
  try { reply = await call.promise; } catch (e) { if (e instanceof WorkerStop) stopAfter = e.code; timedOut = e instanceof ProviderCallTimeout; failed = true; }
  if (ctx.hooks.afterSend) await ctx.hooks.afterSend(op);
  const stopNow = stopAfter || stopCode(ctx);
  if (stopNow) { noteStop(ctx, stopNow, "after_mirror_send"); return settleUnknown(ctx, op, `STOP_${stopNow}_AFTER_SEND`); }     // the POST MAY have applied: unknown, nothing more
  if (timedOut) return settleUnknown(ctx, op, "MIRROR_TIMEOUT");
  if (failed) return settleUnknown(ctx, op, "MIRROR_CALL_FAILED");
  const rep = assessMirrorReply({ reply, request: req, intent: pre.intent });
  if (!rep.ok) { ctx.actions.push(`REPLY!${rep.code}`); return settleUnknown(ctx, op, `MIRROR_${rep.code}`); }
  ctx.actions.push("REPLY:CANDIDATE");
  // the reply is NOT proof: the confirming LIST (typed link, exact negative amount, unique marker, original unchanged) is persisted as the 0021 proof
  let conf = null;
  const cr = await readChargeList(ctx, intent, (list) => { conf = mirrorConfirmingObservation({ list, intent, refundId: rep.refundId }); return conf; }, "confirm_list_read");
  if (!cr.ok) return settleUnknown(ctx, op, ctx.stop ? `STOP_${ctx.stop.code}_AFTER_SEND` : `CONFIRM_${codeOf(cr.code)}`);
  if (ctx.hooks.afterConfirmEvidence) await ctx.hooks.afterConfirmEvidence(op, cr.ev);
  { const sc = stopCode(ctx); if (sc) { noteStop(ctx, sc, "before_mirror_completion"); return settleUnknown(ctx, op, `STOP_${sc}_AFTER_SEND`); } }
  const c = await completeOfflineRefundWithEvidence(ctx.pool, op.id, { workerId: ctx.workerId, evidenceId: cr.ev.id, resultRef: rep.refundId, expectedVersion: pre.intent.version });
  if (!c.ok) { ctx.actions.push(`COMPLETE!${codeOf(c.error)}`); return settleUnknown(ctx, op, `COMPLETE_${codeOf(c.error)}`); }
  ctx.actions.push("MIRROR_COMPLETED");
  if (ctx.hooks.afterComplete) await ctx.hooks.afterComplete(op);
  // the row is now DURABLY succeeded (never rewritten); a stop here leaves the leg open — the next session finalizes read-only, never a second POST
  { const sc = stopCode(ctx); if (sc) { noteStop(ctx, sc, "after_mirror_complete"); ctx.actions.push("COMPLETED:EVENT_DEFERRED"); return { delayMs: 0, stopped: true }; } }
  return terminalEvent(ctx, intent, asOp(op), rep.refundId, cr.ev.id);
}

// ---------------------------------------------------------------------------------------------

async function handleIntent(ctx, intent) {
  const row = (await ctx.pool.query("SELECT environment FROM booking.intents WHERE id = $1", [intent.id])).rows[0];
  if (!row || row.environment !== "test") { ctx.actions.push("STOP:INTENT_NOT_TEST"); return { delayMs: 0 }; }
  if (!ctx.listings.has(intent.listingId) || intent.price.currency !== TEST_CLEANUP_LISTINGS[0].currency) { ctx.actions.push("STOP:LISTING_NOT_ALLOWED"); return { delayMs: 0 }; }
  if (!intent.reservation || isProtectedReservationId(intent.reservation.reservationId)) { ctx.actions.push("STOP:PROTECTED_RESERVATION_ID"); return { delayMs: 0 }; }
  const mi = mirrorIntentRefusal(intent);
  if (mi) { ctx.actions.push(`WAIT:${mi}`); return { delayMs: MIRROR_WORKER_LIMITS.waitMs, waiting: true }; }      // legs still open / already mirrored: not this worker's step
  ctx.enteredAt = await stateEnteredAt(ctx.pool, intent);
  if (!Number.isFinite(ctx.enteredAt)) return escalate(ctx, intent, "STATE_ENTRY_UNKNOWN");
  const pa = await boundPaymentAttempt(ctx.pool, intent);
  if (!pa) return escalate(ctx, intent, "PAYMENT_ATTEMPT_NOT_BOUND");
  try { return await mirrorLeg(ctx, intent, pa); }
  catch (e) { if (e instanceof Escalate) return escalate(ctx, intent, e.code); throw e; }
}

/**
 * runMirrorStep(pool, { workerId, env, adapterConfig, recordingConfig, clientSnapshotId, listings: Map<606998, {currency:"USD", timeZone}>, executors, clock, stripeAccountId,
 *                       intentId, timeouts?, monotonic?, hooks?, signal?, deadlineAt? })
 *   -> { status: "refused" | "idle" | "worked", code?, intentId, actions, calls, sends, mirrorSends, stop, facts, delayMs? }
 * One bounded step for ONE pinned intent: gate → TEST-database check → scoped maintenance → work claim → the next action of the mirror leg → release.
 */
export async function runMirrorStep(pool, opts = {}) {
  const { workerId, env, adapterConfig, recordingConfig, clientSnapshotId, listings, executors, clock, stripeAccountId, intentId, timeouts, hooks = {}, signal = null, deadlineAt = null } = opts;
  const g = mirrorWorkerGate({ env, adapterConfig, recordingConfig, listings, executors, clock, stripeAccountId, intentId });
  const none = { intentId: typeof intentId === "string" ? intentId : null, actions: [], calls: [], sends: 0, mirrorSends: 0, stop: null, facts: null };
  if (!g.ok) return result("refused", { code: g.code, ...none });
  if (typeof workerId !== "string" || !/^[A-Za-z0-9._:-]{1,80}$/.test(workerId)) return result("refused", { code: "WORKER_ID_INVALID", ...none });
  if (typeof clientSnapshotId !== "string" || !/^[A-Za-z0-9._:-]{1,64}$/.test(clientSnapshotId)) return result("refused", { code: "CLIENT_LABEL_INVALID", ...none });
  if (signal !== null && (typeof signal !== "object" || typeof signal.aborted !== "boolean")) return result("refused", { code: "SIGNAL_INVALID", ...none });
  if (deadlineAt !== null && !Number.isFinite(deadlineAt)) return result("refused", { code: "DEADLINE_INVALID", ...none });
  try { await assertEnvironment(pool, "test"); } catch { return result("refused", { code: "DATABASE_NOT_TEST", ...none }); }
  const t = resolveTimeouts(timeouts);
  const mono = typeof opts.monotonic === "function" ? opts.monotonic : () => performance.now();
  const ctx = { pool, workerId, cfg: g.cfg, recordingConfig, clientSnapshotId, listings, listingIds: [...listings.keys()], executors, clock, hooks, intentId, stripeAccountId, timeouts: t, mono,
    stepEndsAt: mono() + t.stepBudgetMs, signal, deadlineAt, actions: [], calls: [], sends: 0, mirrorSends: 0, accountVerified: false, enteredAt: null, stop: null };
  const out = async (status, extra) => result(status, { intentId, actions: ctx.actions, calls: ctx.calls, sends: ctx.sends, mirrorSends: ctx.mirrorSends, stop: ctx.stop, facts: await observedFacts(pool, intentId), ...extra });
  if (stopped(ctx, "start")) return out("idle", {});
  const claimed = await RW.claimWork(pool, { workerId, now: clock(), leaseMs: MIRROR_WORKER_LIMITS.workLeaseMs, states: [...WORK_STATES], intentId, listingIds: ctx.listingIds });
  if (!claimed) return out("idle", {});
  let delayMs = MIRROR_WORKER_LIMITS.waitMs;
  try {
    if (hooks.beforeMaintenance) await hooks.beforeMaintenance(intentId);
    await recoverExpiredOperations(pool, { now: clock(), limit: MIRROR_WORKER_LIMITS.maintenanceBatch, opTypes: [...MIRROR_OP_TYPES], intentId, listingIds: ctx.listingIds, intentStates: [...WORK_STATES] });
    const intent = await loadIntent(pool, intentId);
    if (intent && WORK_STATES.includes(intent.status)) ({ delayMs } = await handleIntent(ctx, intent));
  } finally {
    await RW.releaseWork(ctx, intentId, delayMs);
  }
  return out("worked", { delayMs });
}

export const _internal = Object.freeze({ resolveTimeouts, preSend, stopCode, observedFacts, bounded });
