// scripts/e7-connected/reconcile-core-r1.mjs — E7 N2 reconcile-only runner core (R-B, Step A; OFFLINE; ROOT-approved 2026-11-11).
// Target shape V1 ONLY: a STOPPED native R1 run left the intent `reservation_pending` with dispatch set, exactly ONE `hostaway.create_reservation`
// operation `succeeded` whose result_ref is the bound decimal reservation id, and the reservation attempt `dispatched`.
// What it does (and nothing else):
//   1. validates its plan; opens its OWN creation-only journal (kind e7-reconcile-r1; existing → refuse);
//   2. validates the STOPPED native run READ-ONLY from disk (accepted R1 binding at a clock inside the package's validity + readJournalForRecoveryR1
//      with the run's trusted head): AT_ESCROW_HEAD / MATCH_TIP / terminal chain whose evidence facts show it ended INSIDE the reservation phase
//      (no reservation end, no BLOCKED attestation, no abort, no open step), no permission — never a caller boolean;
//   3. takes the native run advisory lock (LOCK_KEY) on a report session for the whole session (native-run and R-B-vs-R-B exclusion ONLY —
//      hosted runner A does NOT take this lock; against it R-B relies on DB state / version / lease fences and its final check);
//   4. read-only DB preflight of the exact V1 shape (version, history, ops, attempt, claim, leases, protected ids, freshness / grace, auth margin)
//      and an exclusion baseline over every other intent / operation;
//   5. a PRECHECK: fresh by-ref lookup (exactly one match) + by-id GET of the bound id through STRICT GET-only executors (not persisted);
//   6. at most `maxSteps` scoped steps of the ACCEPTED reservation worker (runOrchestratorStep) with the same strict executors — the worker's
//      own accepted recovery decides (RESERVATION_SUCCEEDED only on its fresh by-ref + by-id proof); the first non-200 / unreadable reply STOPS;
//   7. a FINAL paired readback (by-ref exactly one + by-id), completed AFTER the DB reconciliation, plus a DB re-read (state / version / last
//      event / attempt / bound id / ops / claim / leases / exclusion / lock). SUCCESS only if everything still matches.
// Never: create, pricing, cancel, void, capture, record, notify, claim release, history edit, evidence insert, resume of any spent package.
// Provider GETs are separate observations — not an atomic snapshot and no guarantee about later provider changes. A DB `reservation_confirmed`
// alone is NEVER reported as safe to clean: any later cleanup needs its OWN plan and fresh proofs. NOT part of any reviewed closure.
import { loadIntent } from "../../lib/booking-db/repo.js";
import { runOrchestratorStep, PROTECTED_HOSTAWAY_RESERVATION_IDS, LIMITS as WORKER_LIMITS } from "../../lib/booking-db/reservation-worker.js";
import { FRESH_AFTER_DISPATCH_MS, WRITE_OP_TYPES } from "../../lib/checkout/recovery-plan.js";
import { RECOVERY_DEFAULT_GRACE_MS } from "../../lib/booking-db/recovery.js";
import { lookupByRef, normalizeReservation, unwrapEnvelope, REF_RE, DIRECT_CHANNEL_ID } from "../../lib/hostaway-reservations.js";
import { LOCK_KEY } from "./run-core.mjs";
import { bindRunPackageR1Journal } from "./run-journal-memory-v2.mjs";
import { readJournalForRecoveryR1 } from "./run-journal-file-v2.mjs";
import { createReconcileExecutorsR1 } from "./reconcile-executors-r1.mjs";
import { openReconcileJournalR1, RUN_ID_RE } from "./reconcile-journal-r1.mjs";

export const RECONCILE_CORE_R1_VERSION = "e7-reconcile-core-r1";
const freeze = Object.freeze;
/** Normal path (measured in the tests; see RB1): the accepted recovery requests the by-id read and reschedules (worker waitMs 30 s), the read
 *  executes, then the accepted recovery applies RESERVATION_SUCCEEDED. Bounded maximum: 5 steps, each wait ≤ 60 s business, session ≤ 240 s. GETs: precheck ≤ 1 + 1 lookup page (normal 2 pages incl. the terminal empty page) + 1 by-id; same for the final;
 *  worker ≤ 2 per step. Hard caps below; a session deadline on the monotonic clock covers every awaited call. */
export const LIMITS = freeze({ maxSteps: 5, maxGets: 20, lookupMaxPages: 2, callTimeoutMs: 10_000, maxWaitMs: 60_000, sessionBudgetMs: 240_000, minAuthMarginMs: 6 * 3600_000 });
export const OUTCOMES = freeze(["RECONCILED_CONFIRMED", "STOPPED", "REFUSED"]);
const LISTING = freeze({ id: 606998, currency: "USD" });            // the ONLY listing / currency this runner accepts (TEST listing)
const PLAN_KEYS = freeze(["attemptId", "createOpId", "currency", "expectedVersion", "from", "guests", "intentId", "listingId", "nativeExecClock",
  "nativePackageHash", "nativeRunId", "paymentIntentId", "rateBps", "ref", "refFieldId", "reservationId", "runId", "to", "totalMinor"].sort());
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ID_RE = /^[1-9][0-9]{0,15}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PROTECTED = new Set(PROTECTED_HOSTAWAY_RESERVATION_IDS);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const keysEq = (o, ks) => isObj(o) && Object.keys(o).length === ks.length && ks.every((k) => Object.hasOwn(o, k));
const ms = (v) => (v instanceof Date ? v.getTime() : v == null ? null : Date.parse(v));
const READ_OP_TYPES = freeze(["hostaway.lookup_reservation", "hostaway.retrieve_reservation"]);
const NOTIFY_RE = /^(alert\.|guest\.)|notif/;

export function validatePlanR1(p) {
  if (!keysEq(p, PLAN_KEYS)) return "PLAN_SHAPE";
  if (!RUN_ID_RE.test(p.runId) || !RUN_ID_RE.test(p.nativeRunId) || p.runId === p.nativeRunId) return "PLAN_RUN_ID";
  if (!UUID.test(p.intentId) || !UUID.test(p.createOpId) || !UUID.test(p.attemptId)) return "PLAN_IDS";
  if (typeof p.ref !== "string" || !REF_RE.test(p.ref)) return "PLAN_REF";
  if (p.listingId !== LISTING.id || p.currency !== LISTING.currency) return "PLAN_LISTING_NOT_ALLOWED";
  if (typeof p.reservationId !== "string" || !ID_RE.test(p.reservationId)) return "PLAN_RESERVATION_ID";
  if (PROTECTED.has(p.reservationId)) return "PLAN_RESERVATION_PROTECTED";
  if (!DATE_RE.test(p.from) || !DATE_RE.test(p.to) || !(p.to > p.from)) return "PLAN_STAY";
  if (!Number.isSafeInteger(p.totalMinor) || p.totalMinor <= 0 || !Number.isSafeInteger(p.guests) || p.guests < 1) return "PLAN_AMOUNT";
  if (typeof p.paymentIntentId !== "string" || !/^pi_[A-Za-z0-9_]{6,64}$/.test(p.paymentIntentId)) return "PLAN_PI";
  if (!Number.isSafeInteger(p.expectedVersion) || p.expectedVersion < 1) return "PLAN_VERSION";
  if (!Number.isSafeInteger(p.refFieldId) || p.refFieldId < 1 || !Number.isSafeInteger(p.rateBps) || p.rateBps < 0 || p.rateBps > 5000) return "PLAN_CONFIG";
  if (!HEX64.test(p.nativePackageHash) || !Number.isSafeInteger(p.nativeExecClock) || p.nativeExecClock < 1) return "PLAN_NATIVE";
  return null;
}

/**
 * runReconcileR1({ plan, pools: { app, report }, hostawaySend, clock, monotonic?, journalDir, uid?, native: { packageInput, journalDir, headDir,
 *   trustedHead }, hooks? }) → frozen result { outcome, code, ... } — never throws for caller input / provider / DB refusals.
 */
export async function runReconcileR1(opts = {}) {
  const { plan, pools, hostawaySend, clock, journalDir, uid, native, hooks = {} } = opts;
  const mono = typeof opts.monotonic === "function" ? opts.monotonic : () => performance.now();
  const sleep = typeof opts.sleep === "function" ? opts.sleep : (ms) => new Promise((res) => setTimeout(res, ms));
  const t0 = mono();
  const R = { outcome: null, code: null, runId: isObj(plan) ? plan.runId : null, intentId: isObj(plan) ? plan.intentId : null, steps: [], gets: 0,
    getLog: [], violations: [], precheck: null, final: null, dbState: null, dbEvidence: null, exclusionAfter: "not_attempted", lockHeld: false,
    liveEffects: null, queuedEffects: null, cleanup: "NOT_HANDED_OFF", journalHead: null };
  const done = async (outcome, code, J) => {
    R.outcome = outcome; R.code = code;
    if (J) { await J.append(outcome === "RECONCILED_CONFIRMED" ? "ENDED" : outcome, clock(), { code }); R.journalHead = J.head(); await J.close(); }
    return freeze(structuredClone(R));
  };
  // ---- 1. plan + own journal -------------------------------------------------------------------------------------------------------
  const pe = isObj(plan) ? validatePlanR1(plan) : "PLAN_SHAPE";
  if (pe) return done("REFUSED", pe, null);
  if (!isObj(pools) || !pools.app || !pools.report || typeof hostawaySend !== "function" || typeof clock !== "function") return done("REFUSED", "OPTIONS_INVALID", null);
  const jo = await openReconcileJournalR1({ dir: journalDir, runId: plan.runId, uid });
  if (!jo.ok) return done("REFUSED", jo.code, null);
  const J = jo.journal;
  const jr = await J.append("RUN_STARTED", clock(), { version: RECONCILE_CORE_R1_VERSION, plan });
  if (!jr.ok) return done("REFUSED", jr.code, J);
  const overBudget = () => mono() - t0 > LIMITS.sessionBudgetMs;
  // ---- 2. the stopped native run, read-only, from disk ------------------------------------------------------------------------------
  if (!isObj(native)) return done("REFUSED", "NATIVE_EVIDENCE_MISSING", J);
  const nb = bindRunPackageR1Journal(native.packageInput, plan.nativeExecClock);
  if (!nb.ok) return done("REFUSED", "NATIVE_BINDING_INVALID", J);
  const B = nb.binding;
  if (B.identity.runId !== plan.nativeRunId || B.manifest.intentId !== plan.intentId || B.r1.packageHash !== plan.nativePackageHash
      || B.r1.paymentIntentId !== plan.paymentIntentId) return done("REFUSED", "NATIVE_BINDING_MISMATCH", J);
  let rc;
  try { rc = await readJournalForRecoveryR1({ journalDir: native.journalDir, headDir: native.headDir, binding: B, trustedHead: native.trustedHead ?? null }); }
  catch { rc = { ok: false }; }
  if (!nativeStoppedInReservationPhase(rc)) return done("REFUSED", "NATIVE_RUN_NOT_PROVEN_STOPPED", J);
  const fx = rc.chain.facts;
  await J.append("NATIVE_VALIDATED", clock(), { relation: rc.relation, suppliedHead: rc.suppliedHead, chain: rc.chain.status, facts: fx });
  // ---- 3. native-run lock (session-level, report pool) ------------------------------------------------------------------------------
  let lockClient = null;
  try { lockClient = await pools.report.connect(); } catch { return done("REFUSED", "DB_CONNECT_FAILED", J); }
  const unlock = async () => {
    if (!lockClient) return;
    try { if (R.lockHeld) await lockClient.query("SELECT pg_advisory_unlock(hashtext($1), 0)", [LOCK_KEY]); } catch { /* reported by lockHeld */ }
    lockClient.release(); lockClient = null; R.lockHeld = false;
  };
  const finish = async (outcome, code) => { await unlock(); return done(outcome, code, J); };
  try {
    const lr = await lockClient.query("SELECT pg_try_advisory_lock(hashtext($1), 0) AS ok", [LOCK_KEY]);
    if (lr.rows[0]?.ok !== true) return finish("REFUSED", "RUN_LOCK_HELD");
    R.lockHeld = true;
  } catch { return finish("REFUSED", "DB_FAILURE"); }
  const lockStillHeld = async () => {
    try { return Number((await lockClient.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND granted AND pid = pg_backend_pid()")).rows[0].n) >= 1; }
    catch { return false; }
  };
  if (hooks.afterLock) await hooks.afterLock();
  // ---- 4. read-only DB preflight + exclusion baseline --------------------------------------------------------------------------------
  const q = (sql, p = []) => lockClient.query(sql, p).then((r) => r.rows);
  const facts = async () => {
    const intent = await loadIntent(lockClient, plan.intentId);
    const ops = await q(`SELECT id::text AS id, op_type, state, attempts, result_ref, dispatched_at, completed_at, lease_until, lease_worker_id
      FROM booking.external_operations WHERE intent_id = $1 ORDER BY created_at, id`, [plan.intentId]);
    const att = await q("SELECT id::text AS id, operation_id::text AS operation_id, state, hostaway_reservation_id FROM booking.hostaway_reservation_attempts WHERE intent_id = $1", [plan.intentId]);
    const last = (await q("SELECT version_after, event_type, event_id FROM booking.intent_transitions WHERE intent_id = $1 ORDER BY version_after DESC LIMIT 1", [plan.intentId]))[0] ?? null;
    const claims = Number((await q("SELECT count(*)::int AS n FROM booking.inventory_claims WHERE intent_id = $1 AND released_at IS NULL", [plan.intentId]))[0].n);
    const work = (await q("SELECT work_worker_id, work_lease_until FROM booking.intent_work WHERE intent_id = $1", [plan.intentId]))[0] ?? null;
    const evid = await q(`SELECT e.status, e.external_ref, e.observed_at, o.op_type FROM booking.provider_evidence e JOIN booking.external_operations o ON o.id = e.read_operation_id
      WHERE o.intent_id = $1 AND e.kind = 'hostaway_reservation' ORDER BY e.observed_at`, [plan.intentId]);
    return { intent, ops, att, last, claims, work, evid };
  };
  const exclusion = async () => (await q(`SELECT
      (SELECT md5(coalesce(string_agg(id::text || ':' || state || ':' || version || ':' || updated_at::text, ',' ORDER BY id), '')) FROM booking.intents WHERE id <> $1) AS i,
      (SELECT md5(coalesce(string_agg(id::text || ':' || state || ':' || attempts || ':' || coalesce(completed_at::text, '-'), ',' ORDER BY id), '')) FROM booking.external_operations WHERE intent_id <> $1) AS o`,
    [plan.intentId]))[0];
  let F0; let ex0;
  try { F0 = await facts(); ex0 = await exclusion(); } catch { return finish("REFUSED", "DB_FAILURE"); }
  const now0 = clock();
  const pf = preflight(F0, plan, now0);
  if (pf) { R.dbState = F0.intent ? F0.intent.status : null; return finish("REFUSED", pf); }
  await J.append("PREFLIGHT_OK", now0, { version: F0.intent.version, createOpId: plan.createOpId, attempt: F0.att[0].state });
  // ---- 5. PRECHECK (fresh, not persisted) ---------------------------------------------------------------------------------------------
  const ex = createReconcileExecutorsR1({ binding: { listingId: plan.listingId, arrivalDate: plan.from, reservationId: plan.reservationId }, send: hostawaySend, maxGets: LIMITS.maxGets });
  if (!ex.ok) return finish("REFUSED", ex.code);
  const obs = () => { R.gets = ex.observe.gets; R.getLog = ex.observe.log; R.violations = ex.observe.violations; };
  const cfg = { allowedListingIds: [plan.listingId], refFieldId: plan.refFieldId, channelId: DIRECT_CHANNEL_ID, currency: plan.currency };
  const pre = await pairedRead(ex, cfg, plan, clock); obs();
  R.precheck = pre;
  await J.append("PRECHECK", clock(), pre);
  if (!pre.ok) return finish("STOPPED", ex.observe.stop ? ex.observe.stop.code : pre.code);
  const sessionFloor = Math.max(pre.lookupObservedAt, pre.byIdObservedAt);
  if (hooks.afterPrecheck) await hooks.afterPrecheck();
  // ---- 6. accepted worker steps (scoped, strict executors) ---------------------------------------------------------------------------
  const env = { VERCEL_ENV: "development", MV_E7_RESERVATION_WORKER: "enabled", DIRECT_DISCOUNT_BPS: String(plan.rateBps) };
  const workerId = `e7rb:${plan.runId}`.slice(0, 80);
  let state = F0.intent.status;
  let waitUntil = null;
  for (let i = 1; i <= LIMITS.maxSteps && state !== "reservation_confirmed"; i++) {
    // honour the ACCEPTED worker's own schedule (delayMs / next_action_at) on the business clock — never skip time, never busy-loop
    while (waitUntil !== null && clock() < waitUntil) { if (overBudget()) return finish("STOPPED", "SESSION_BUDGET_EXHAUSTED"); await sleep(200); }
    if (overBudget()) return finish("STOPPED", "SESSION_BUDGET_EXHAUSTED");
    if (!(await lockStillHeld())) return finish("STOPPED", "LOCK_LOST");
    let r;
    try {
      r = await runOrchestratorStep(pools.app, { workerId, env, adapterConfig: cfg, listings: new Map([[plan.listingId, { currency: plan.currency }]]),
        executors: ex.executors, clock, intentId: plan.intentId });
    } catch { obs(); R.dbState = await stateOf(lockClient, plan.intentId); return finish("STOPPED", "WORKER_FAILED"); }
    obs();
    const s2 = await stateOf(lockClient, plan.intentId);
    R.steps.push({ step: i, status: r.status, actions: r.actions, sends: r.sends, state: s2 });
    await J.append("STEP", clock(), { step: i, status: r.status, actions: r.actions, sends: r.sends, state: s2, gets: ex.observe.gets });
    if (r.sends !== 0) { R.dbState = s2; return finish("STOPPED", "WORKER_SENT_WRITE"); }            // unreachable by construction; recorded if ever
    if (ex.observe.stop) { R.dbState = s2; return finish("STOPPED", ex.observe.stop.code); }
    if (r.status === "refused") { R.dbState = s2; return finish("STOPPED", `WORKER_REFUSED_${r.code}`); }
    state = s2;
    if (state !== "reservation_confirmed" && state !== "reservation_pending") { R.dbState = state; return finish("STOPPED", "STATE_CHANGED"); }
    const wait = r.status === "idle" ? WORKER_LIMITS.waitMs : Number.isSafeInteger(r.delayMs) && r.delayMs > 0 ? r.delayMs : 0;
    if (wait > LIMITS.maxWaitMs) { R.dbState = state; return finish("STOPPED", "WAIT_TOO_LONG"); }
    waitUntil = wait > 0 ? clock() + wait : null;
  }
  if (state !== "reservation_confirmed") { R.dbState = state; return finish("STOPPED", "STEP_BUDGET_EXHAUSTED"); }
  if (hooks.afterReconciled) await hooks.afterReconciled();
  // ---- 7. FINAL paired readback (after the DB reconciliation) + DB re-read --------------------------------------------------------------
  if (overBudget()) { R.dbState = state; return finish("STOPPED", "SESSION_BUDGET_EXHAUSTED"); }
  const fin = await pairedRead(ex, cfg, plan, clock); obs();
  R.final = fin;
  await J.append("FINAL_READ", clock(), fin);
  let F1; let ex1;
  try { F1 = await facts(); ex1 = await exclusion(); } catch { R.dbState = state; return finish("STOPPED", "FINAL_DB_READ_FAILED"); }
  R.dbState = F1.intent ? F1.intent.status : null;
  R.exclusionAfter = ex1.i === ex0.i && ex1.o === ex0.o ? "equal" : "changed";
  R.dbEvidence = freeze({ byRefSessionFresh: F1.evid.some((e) => e.op_type === "hostaway.lookup_reservation" && e.status === "found_active" && ms(e.observed_at) >= sessionFloor),
    byIdSessionFresh: F1.evid.some((e) => e.op_type === "hostaway.retrieve_reservation" && e.status === "found_active" && ms(e.observed_at) >= sessionFloor) });
  R.liveEffects = freeze({ hostawayReservation: fin.ok ? "active_at_final_readback" : "unverified", stripeAuthorization: "held_per_db_not_observed",
    claim: F1.claims === 1 ? "held" : `unexpected_${F1.claims}` });
  R.queuedEffects = F1.ops.filter((o) => o.op_type !== "hostaway.create_reservation" && WRITE_OP_TYPES.includes(o.op_type))
    .map((o) => ({ opType: o.op_type, state: o.state, attempts: o.attempts, dispatched: !!o.dispatched_at }));
  if (!fin.ok) return finish("STOPPED", `FINAL_${ex.observe.stop ? ex.observe.stop.code : fin.code}`);
  if (!(fin.lookupObservedAt > sessionFloor && fin.byIdObservedAt > sessionFloor)) return finish("STOPPED", "FINAL_NOT_AFTER_SESSION_FLOOR");
  const fc = finalCheck(F1, plan);
  if (fc) return finish("STOPPED", fc);
  if (R.exclusionAfter !== "equal") return finish("STOPPED", "EXCLUSION_CHANGED");
  if (!(await lockStillHeld())) return finish("STOPPED", "LOCK_LOST");
  R.cleanup = "REQUIRES_OWN_PLAN_AND_FRESH_PROOFS";                                   // never "safe to clean"
  return finish("RECONCILED_CONFIRMED", null);
}

/** PURE: the accepted reader's result (readJournalForRecoveryR1) proves a terminated native run that ended INSIDE the reservation phase: chain ENDED
 *  at the escrow head matching the trusted tip, no permission, and evidence facts with no reservation-phase end, no BLOCKED attestation, no abort
 *  started / accepted, no open step (an ENDED_RELEASED or any later-phase run fails). Facts are evidence, never permission. */
export function nativeStoppedInReservationPhase(rc) {
  if (!isObj(rc) || rc.ok !== true || rc.relation !== "AT_ESCROW_HEAD" || rc.suppliedHead !== "MATCH_TIP" || !isObj(rc.chain) || rc.chain.status !== "ENDED") return false;
  if (!isObj(rc.permission) || !Object.values(rc.permission).every((x) => x === false)) return false;
  const fx = rc.chain.facts;
  return isObj(fx) && fx.ended === true && fx.openStep === false && fx.reservationEnd === null && fx.blockedAttested === false && fx.abortStarted === false && fx.abortAccepted === false;
}

async function stateOf(c, id) { try { return (await c.query("SELECT state FROM booking.intents WHERE id = $1", [id])).rows[0]?.state ?? null; } catch { return null; } }

/** V1 shape, exactly; null = OK, else a refusal code (zero writes) */
function preflight(F, p, now) {
  const i = F.intent;
  if (!i) return "INTENT_NOT_FOUND";
  if (i.status !== "reservation_pending") return "STATE_NOT_V1";
  if (i.version !== p.expectedVersion) return "VERSION_MOVED";
  if (i.ref !== p.ref || i.listingId !== p.listingId || i.from !== p.from || i.to !== p.to || i.guests !== p.guests) return "INTENT_IDENTITY_MISMATCH";
  if (!i.price || i.price.finalTotalMinor !== p.totalMinor || i.price.currency !== p.currency) return "INTENT_AMOUNT_MISMATCH";
  if (!i.payment || i.payment.paymentIntentId !== p.paymentIntentId) return "PAYMENT_INTENT_MISMATCH";
  if (!i.dispatch) return "NOT_DISPATCHED";
  if (i.reservation) return "RESERVATION_ALREADY_BOUND";
  if (i.lease && !(i.lease.until < now)) return "E3_LEASE_LIVE";
  if (!F.last || F.last.event_type !== "RESERVATION_DISPATCHED" || F.last.version_after !== p.expectedVersion) return "HISTORY_NOT_V1";
  const creates = F.ops.filter((o) => o.op_type === "hostaway.create_reservation");
  if (creates.length !== 1) return "CREATE_COUNT";
  const c = creates[0];
  if (c.id !== p.createOpId) return "CREATE_OP_MISMATCH";
  if (c.state !== "succeeded") return c.state === "outcome_unknown" || c.state === "in_flight" || c.state === "pending" ? "CREATE_OUTCOME_AMBIGUOUS" : "CREATE_NOT_SUCCEEDED";
  if (c.result_ref !== p.reservationId) return "CREATE_RESULT_REF_MISMATCH";
  if (PROTECTED.has(String(c.result_ref))) return "RESERVATION_PROTECTED";
  if (!(ms(c.dispatched_at) + FRESH_AFTER_DISPATCH_MS <= now) || !(ms(c.completed_at) + RECOVERY_DEFAULT_GRACE_MS <= now)) return "TOO_EARLY";
  if (F.att.length !== 1) return "ATTEMPT_COUNT";
  const a = F.att[0];
  if (a.id !== p.attemptId || a.operation_id !== p.createOpId) return "ATTEMPT_MISMATCH";
  if (a.state !== "dispatched") return "ATTEMPT_NOT_DISPATCHED";
  if (a.hostaway_reservation_id !== p.reservationId) return "ATTEMPT_ID_MISMATCH";
  for (const o of F.ops) {
    if (o.op_type === "hostaway.create_reservation") continue;
    if (WRITE_OP_TYPES.includes(o.op_type)) return "WRITE_OP_PRESENT";
    if (READ_OP_TYPES.includes(o.op_type)) { if (o.lease_until && ms(o.lease_until) > now) return "READ_IN_FLIGHT"; continue; }
    if (NOTIFY_RE.test(o.op_type)) { if (o.state !== "pending" || o.attempts !== 0 || o.dispatched_at) return "NOTIFY_NOT_PRISTINE"; continue; }
    if (o.op_type === "stripe.create_checkout_session" && o.state === "succeeded") continue;
    return "OPERATION_HISTORY_UNEXPECTED";
  }
  if (F.evid.some((e) => PROTECTED.has(String(e.external_ref)))) return "RESERVATION_PROTECTED";
  if (F.claims !== 1) return "CLAIM_NOT_HELD";
  if (F.work && F.work.work_lease_until && ms(F.work.work_lease_until) > now) return "WORK_LEASE_LIVE";
  const auth = Math.min(i.payment.captureBefore ?? Infinity, i.payment.authorizationDeadline ?? Infinity);
  if (!(auth - now > LIMITS.minAuthMarginMs)) return "AUTHORIZATION_MARGIN";
  return null;
}

/** after the reconciliation: exactly ONE new transition (RESERVATION_SUCCEEDED for the create op), bound id, attempt succeeded, nothing else */
function finalCheck(F, p) {
  const i = F.intent;
  if (!i || i.status !== "reservation_confirmed") return "FINAL_STATE_CHANGED";
  if (i.version !== p.expectedVersion + 1) return "FINAL_VERSION_MOVED";
  if (!F.last || F.last.event_type !== "RESERVATION_SUCCEEDED" || F.last.event_id !== `op-outcome:${p.createOpId}`) return "FINAL_HISTORY_UNEXPECTED";
  if (!i.reservation || String(i.reservation.reservationId) !== p.reservationId) return "FINAL_BOUND_ID_MISMATCH";
  if (F.att.length !== 1 || F.att[0].state !== "succeeded" || F.att[0].hostaway_reservation_id !== p.reservationId) return "FINAL_ATTEMPT_NOT_SUCCEEDED";
  const creates = F.ops.filter((o) => o.op_type === "hostaway.create_reservation");
  if (creates.length !== 1 || creates[0].id !== p.createOpId) return "FINAL_CREATE_COUNT";
  // RESERVATION_SUCCEEDED's accepted effect (afterReservation, before captureBefore) queues exactly ONE capture op: allowed only PRISTINE
  // (pending, 0 attempts, never dispatched) and REPORTED as a queued live risk; any other write op, or a touched capture, stops
  const writes = F.ops.filter((o) => o.op_type !== "hostaway.create_reservation" && WRITE_OP_TYPES.includes(o.op_type));
  if (writes.length > 1 || writes.some((o) => o.op_type !== "stripe.capture_payment_intent" || o.state !== "pending" || o.attempts !== 0 || o.dispatched_at)) return "FINAL_WRITE_OP_PRESENT";
  if (F.ops.some((o) => NOTIFY_RE.test(o.op_type) && (o.state !== "pending" || o.attempts !== 0 || o.dispatched_at))) return "FINAL_NOTIFY_NOT_PRISTINE";
  if (F.claims !== 1) return "FINAL_CLAIM_NOT_HELD";
  return null;
}

/** ONE by-ref lookup (exactly one match) + ONE by-id GET of the bound id; both must show the bound identity, active. Observation times are the
 *  business clock read AFTER each reply completed. Not persisted; not an atomic snapshot. */
async function pairedRead(ex, cfg, p, clock) {
  const timeout = () => AbortSignal.timeout(LIMITS.callTimeoutMs);
  let lk;
  try {
    lk = await lookupByRef({ ref: p.ref, listingId: p.listingId, arrivalDate: p.from, departureDate: p.to }, cfg,
      (req) => ex.executors.lookupPage(req, { signal: timeout() }), { maxPages: LIMITS.lookupMaxPages });
  } catch { return freeze({ ok: false, code: "LOOKUP_FAILED" }); }
  const lookupObservedAt = clock();
  if (lk.outcome === "conflict") return freeze({ ok: false, code: lk.code === "DUPLICATE_REF" ? "DUPLICATE_REF" : "LOOKUP_MATCH_CONTRADICTS", lookupObservedAt });
  if (lk.outcome !== "found") return freeze({ ok: false, code: `LOOKUP_${String(lk.outcome).toUpperCase()}`, lookupObservedAt });
  const id = identityProblem(lk.reservation, p, true);
  if (id) return freeze({ ok: false, code: `LOOKUP_${id}`, lookupObservedAt });
  let resp;
  try { resp = await ex.executors.retrieveReservation({ method: "GET", path: `/reservations/${p.reservationId}`, query: {} }, { signal: timeout() }); }
  catch { return freeze({ ok: false, code: "BY_ID_FAILED", lookupObservedAt }); }
  const byIdObservedAt = clock();
  if (!isObj(resp) || resp.httpStatus !== 200) return freeze({ ok: false, code: resp && resp.httpStatus === 404 ? "BY_ID_NOT_FOUND" : "BY_ID_NOT_OK", lookupObservedAt, byIdObservedAt });
  const env = unwrapEnvelope(resp.json);
  const n = env.ok ? normalizeReservation(env.result, cfg) : { ok: false };
  if (!n.ok) return freeze({ ok: false, code: "BY_ID_UNREADABLE", lookupObservedAt, byIdObservedAt });
  const id2 = identityProblem(n.reservation, p, false);
  if (id2) return freeze({ ok: false, code: `BY_ID_${id2}`, lookupObservedAt, byIdObservedAt });
  return freeze({ ok: true, code: null, lookupObservedAt, byIdObservedAt, reservationId: p.reservationId, status: n.reservation.status });
}
function identityProblem(r, p, byRef) {
  if (String(r.reservationId) !== p.reservationId) return "OTHER_ID";
  if (r.listingId !== p.listingId || r.from !== p.from || r.to !== p.to || r.totalMinor !== p.totalMinor || r.currency !== p.currency || r.channelId !== DIRECT_CHANNEL_ID) return "IDENTITY_MISMATCH";
  if (byRef ? r.bookingRef !== p.ref : (r.bookingRef !== null && r.bookingRef !== p.ref)) return "REF_MISMATCH";
  if (r.status === "cancelled") return "CANCELLED";
  if (!["new", "modified"].includes(r.status)) return "STATUS_NOT_ACTIVE";
  return null;
}
