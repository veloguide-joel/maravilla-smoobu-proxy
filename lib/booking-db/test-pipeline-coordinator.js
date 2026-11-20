// lib/booking-db/test-pipeline-coordinator.js — E7 C83. TEST-ONLY coordinator for ONE explicitly bound intent:
// payment_authorized → (reservation worker) → reservation_confirmed → (capture worker) → payment_captured → (recording worker) → confirmed.
//
// INTERNAL LIBRARY ONLY: no route, cron, workflow, trigger, SDK client or default provider function. Every provider call goes
// through the INJECTED executors of the three ACCEPTED workers, which this module only calls and never re-implements:
//   runOrchestratorStep (E7.2 reservation), runCaptureStep (E7.3b capture), runRecordingStep (E7.4b recording).
// No payment / reservation / recording logic lives here: the coordinator decides WHICH accepted step may run next for the bound
// intent, refuses anything it cannot prove safe from durable rows, and reports. It never sleeps, never loops blindly, never
// drains a queue and never runs refund / void / cancel / cleanup / notification / inbox work.
//
// Contract (one call = one bounded invocation, at most `maxSteps` accepted worker steps):
//   * gate: VERCEL_ENV development | preview (production REFUSED), MV_E7_TEST_PIPELINE_COORDINATOR=enabled, database marker 'test'
//     (C139: exactly one marker row; every phase config fixed to 606998 / USD incl. the adapter allowlists; intent row environment 'test'
//     and price currency USD — all before any worker step)
//     (the workers keep their own MV_E7_*_WORKER gates). Fixed TEST listing only (TEST_LISTING_ID 606998); explicit binding
//     { intentId, ref } equal to the persisted intent; payment livemode exactly false; no protected historical reservation id.
//   * per step, BEFORE any worker call, from durable rows only:
//       - an open reconciliation case → STOP OPEN_CASE;
//       - intent_work leased by anyone → STOP WORK_LEASED (never stolen); next_action_at in the future → PENDING (no call);
//       - the phase's write row must be continuable: reservation — no create row, or exactly one that is pending and never
//         dispatched, or one that already SUCCEEDED (then the accepted worker only READS — the C77 S1-A → S1-B contract);
//         capture — exactly one capture row, pending, attempts 0, never dispatched; recording — exactly one och:<intent>:1 row,
//         pending, attempts 0, never dispatched. Anything else → STOP (never a second write, never a repair).
//       - ambiguous states (reservation_unknown, capture_unknown) and every state outside the pipeline → STOP; confirmed → DONE.
//   * write budget per bound admission: <= 1 Hostaway create, <= 1 Stripe capture, <= 1 Hostaway offline-charge record. Enforced
//     durably by the pre-step row checks above (a write is only ever reachable while its row was never dispatched) and, as
//     defence in depth, by an in-invocation guard on the three injected write executors (a second call throws BEFORE the provider).
//   * after a step: the step's late-result promise is awaited (bounded by the worker), then the intent is re-read. A worker
//     refusal, a worker STOP / LEASE_LOST action, a recording stop, any write beyond the budget → STOP. A thrown error (DB,
//     COMMIT or transport uncertainty) → STOP STEP_THREW with NO further query (readback is left to a later, read-only step).
//   * deadline: a step starts only while Date.now() + that worker's step budget fits before `deadlineAt`; otherwise PENDING.
//     `signal` (AbortSignal-like) aborted → STOP ABORTED before the next step; it is also handed to the recording worker.
//   * C86 (ROOT #128 review 5912316868):
//     F1 STORED REFUND VETO (ported verbatim in semantics from the main C16 hosted recording wrapper): ANY stored provider_evidence row
//        of kind payment_intent for EXACTLY the intent's PaymentIntent (any source, any age, regardless of newer zero rows) with a
//        positive safe-integer amountRefundedMinor or refunded === true → STOP PAYMENT_REFUND_OBSERVED; a present-but-malformed field →
//        STOP PAYMENT_REFUND_EVIDENCE_INVALID; absent fields are UNKNOWN (no proof either way). Checked before every capture / recording
//        step AND re-read immediately before the actual record (and capture) provider call, so an observation stored between
//        admission and send refuses that send. The veto is NOT fresh affirmative Stripe proof.
//     F2 `writes` = ATTEMPTED provider write invocations, counted by the pre-provider guard and reported on EVERY exit (including a
//        thrown DB / COMMIT fault after a provider reply). Zero therefore always means "never handed to the provider".
//     F3 every actual create / capture / record invocation is re-guarded at the moment of the call: abort signal, elapsed deadline,
//        write budget and (record / capture) the refund veto. A tripped guard throws BEFORE the provider and before the counter;
//        the worker's own conservative handling (unknown / case) applies, and the coordinator STOPs — never a next financial stage.
// Outcomes: CONFIRMED (durably confirmed) | PENDING (safe to call again at/after nextActionAt — only the demonstrated
// continuations above) | STOP (owner / ROOT review; the code says why). Results are frozen; no PII, codes and ids only.
import { loadIntent } from "./repo.js";
import { runOrchestratorStep, PROTECTED_HOSTAWAY_RESERVATION_IDS, DEFAULT_TIMEOUTS as RES_TIMEOUTS } from "./reservation-worker.js";
import { runCaptureStep, CAPTURE_DEFAULT_TIMEOUTS } from "./capture-worker.js";
import { runRecordingStep, RECORDING_DEFAULT_TIMEOUTS } from "./recording-worker.js";
import { STATES as S } from "../checkout/intent-state.js";

export const COORDINATOR_VERSION = "e7-test-pipeline-coordinator-v1";
export const TEST_LISTING_ID = 606998;                                   // the ORIGINAL Hostaway TEST listing; real listings are never in scope
// C139: the fixed TEST currency. The coordinator's scope is exactly ONE listing / ONE currency: every phase's listing config, the
// reservation / capture adapter configs (allowlist exactly [606998], currency USD), the recording config's listing, and the persisted intent
// (environment 'test', price currency USD) must all agree BEFORE any worker step; any mismatch is REFUSED with no worker or provider call.
export const TEST_CURRENCY = "USD";
export const MAX_STEPS_LIMIT = 8;
export const DEFAULT_MAX_STEPS = 6;
export const WRITE_BUDGET = Object.freeze({ create: 1, capture: 1, record: 1 });
export const WRITE_EXECUTORS = Object.freeze({ reservation: "createReservation", capture: "capturePaymentIntent", recording: "createOfflineCharge" });
export const OP = Object.freeze({ create: "hostaway.create_reservation", capture: "stripe.capture_payment_intent", record: "hostaway.record_offline_charge" });
/** wall-clock reserve a step needs before `deadlineAt` (the workers' own default step budgets; recording adds its late window) */
export const STEP_RESERVE_MS = Object.freeze({
  reservation: RES_TIMEOUTS.stepBudgetMs, capture: CAPTURE_DEFAULT_TIMEOUTS.stepBudgetMs,
  recording: RECORDING_DEFAULT_TIMEOUTS.stepBudgetMs + RECORDING_DEFAULT_TIMEOUTS.lateWindowMs
});
const PHASE_OF = Object.freeze({
  [S.PAYMENT_AUTHORIZED]: "reservation", [S.RESERVATION_PENDING]: "reservation",
  [S.RESERVATION_CONFIRMED]: "capture", [S.PAYMENT_CAPTURED]: "recording"
});
const STOP_STATES = Object.freeze({ [S.RESERVATION_UNKNOWN]: "RESERVATION_UNKNOWN", [S.CAPTURE_UNKNOWN]: "CAPTURE_UNKNOWN" });
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WORKER_ID_RE = /^[A-Za-z0-9._:-]{1,60}$/;
const CODE_RE = /^[A-Z0-9_:!>.-]{1,80}$/;
const PROTECTED = new Set(PROTECTED_HOSTAWAY_RESERVATION_IDS);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const freeze = (o) => Object.freeze(o);
const ms = (v) => (v == null ? null : new Date(v).getTime());

export class CoordinatorBudgetError extends Error {
  constructor(key) { super(`COORDINATOR_WRITE_BUDGET_${key}`); this.name = "CoordinatorBudgetError"; this.code = "COORDINATOR_WRITE_BUDGET"; }
}
/** A pre-provider write guard tripped (abort / deadline / refund veto): thrown INSIDE the worker's executor call, never sent. */
export class CoordinatorGuardError extends Error {
  constructor(code) { super(`COORDINATOR_GUARD_${code}`); this.name = "CoordinatorGuardError"; this.code = code; }
}

// ---------------------------------------------------------------------------------------------
// F1: stored refund-observation veto — same semantics as main scripts/e7-hosted-recording.mjs refundObservationRefusal (C16).
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
/** refundObservationRefusal(evidenceRows, paymentIntentId) → null | "PAYMENT_REFUND_OBSERVED" | "PAYMENT_REFUND_EVIDENCE_INVALID" (pure) */
export function refundObservationRefusal(evidence, paymentIntentId) {
  let invalid = false;
  for (const x of Array.isArray(evidence) ? evidence : []) {
    if (!x || x.kind !== "payment_intent" || x.external_ref !== paymentIntentId) continue;
    const o = x.observed;
    if (!isObj(o)) continue;
    if (hasOwn(o, "amountRefundedMinor")) {
      const a = o.amountRefundedMinor;
      if (typeof a !== "number" || !Number.isSafeInteger(a) || a < 0) invalid = true;
      else if (a > 0) return "PAYMENT_REFUND_OBSERVED";
    }
    if (hasOwn(o, "refunded")) {
      const r = o.refunded;
      if (typeof r !== "boolean") invalid = true;
      else if (r === true) return "PAYMENT_REFUND_OBSERVED";
    }
  }
  return invalid ? "PAYMENT_REFUND_EVIDENCE_INVALID" : null;
}
async function refundVeto(pool, intentId, paymentIntentId) {
  if (typeof paymentIntentId !== "string" || !paymentIntentId) return "PAYMENT_INTENT_UNBOUND";
  const rows = (await pool.query(
    "SELECT kind, external_ref, observed FROM booking.provider_evidence WHERE intent_id = $1 AND kind = 'payment_intent' AND external_ref = $2",
    [intentId, paymentIntentId])).rows;
  return refundObservationRefusal(rows, paymentIntentId);
}

/** Static gate (no I/O). */
export function coordinatorGate(opts = {}) {
  const { env, binding, phases, clock, workerId } = opts;
  if (!isObj(env)) return { ok: false, code: "ENV_REQUIRED" };
  if (env.VERCEL_ENV === "production") return { ok: false, code: "PRODUCTION_REFUSED" };
  if (env.VERCEL_ENV !== "development" && env.VERCEL_ENV !== "preview") return { ok: false, code: "ENVIRONMENT_NOT_ALLOWED" };
  if (env.MV_E7_TEST_PIPELINE_COORDINATOR !== "enabled") return { ok: false, code: "NOT_ENABLED" };
  if (typeof workerId !== "string" || !WORKER_ID_RE.test(workerId)) return { ok: false, code: "WORKER_ID_INVALID" };
  if (!isObj(binding) || typeof binding.intentId !== "string" || !UUID_RE.test(binding.intentId)) return { ok: false, code: "BINDING_INTENT_INVALID" };
  if (typeof binding.ref !== "string" || !/^MV-[A-Z0-9]{4,16}$/.test(binding.ref)) return { ok: false, code: "BINDING_REF_INVALID" };
  if (typeof clock !== "function" || !Number.isFinite(clock())) return { ok: false, code: "CLOCK_REQUIRED" };
  if (opts.recordingClock !== undefined && (typeof opts.recordingClock !== "function" || !Number.isFinite(opts.recordingClock()))) return { ok: false, code: "CLOCK_REQUIRED" };
  if (!isObj(phases)) return { ok: false, code: "PHASES_REQUIRED" };
  for (const p of ["reservation", "capture", "recording"]) {
    const ph = phases[p];
    if (!isObj(ph) || !(ph.listings instanceof Map) || ph.listings.size !== 1 || !ph.listings.has(TEST_LISTING_ID)) return { ok: false, code: "LISTING_NOT_TEST_FIXED" };
    // C139: listing config currency (and the recording config's own listing id) fixed to the TEST scope
    const lc = ph.listings.get(TEST_LISTING_ID);
    if (!isObj(lc) || lc.currency !== TEST_CURRENCY) return { ok: false, code: "CURRENCY_NOT_TEST_FIXED" };
    if (p === "recording" && lc.listingId !== TEST_LISTING_ID) return { ok: false, code: "LISTING_NOT_TEST_FIXED" };
    if (p !== "recording") {
      const ac = ph.adapterConfig;
      if (!isObj(ac) || !Array.isArray(ac.allowedListingIds) || ac.allowedListingIds.length !== 1 || ac.allowedListingIds[0] !== TEST_LISTING_ID
          || ac.currency !== TEST_CURRENCY) return { ok: false, code: "ADAPTER_CONFIG_NOT_TEST_FIXED" };
    }
    if (!isObj(ph.executors) || typeof ph.executors[WRITE_EXECUTORS[p]] !== "function") return { ok: false, code: "EXECUTORS_REQUIRED" };
  }
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > MAX_STEPS_LIMIT) return { ok: false, code: "MAX_STEPS_INVALID" };
  if (opts.deadlineAt !== undefined && opts.deadlineAt !== null && !Number.isFinite(opts.deadlineAt)) return { ok: false, code: "DEADLINE_INVALID" };
  if (opts.signal != null && (typeof opts.signal !== "object" || typeof opts.signal.aborted !== "boolean")) return { ok: false, code: "SIGNAL_INVALID" };
  return { ok: true, maxSteps };
}

/**
 * Pre-provider write guard for ONE write executor key (F2 / F3). Checked at the moment of the actual call, in this order: abort signal,
 * elapsed deadline, write budget, then (optional `veto`) a fresh refund-veto re-read. Any trip records `trip.code` and throws BEFORE the
 * provider and BEFORE the counter; otherwise the counter is incremented (an ATTEMPTED write) and the provider is called.
 */
function guardExecutors(executors, key, counter, { signal = null, deadlineAt = null, now = Date.now, trip = { code: null }, veto = null } = {}) {
  const orig = executors[key];
  // synchronous checks; run BEFORE the (async) veto re-read AND again AFTER it (C88), with NO await between the final check,
  // the counter increment and the provider invocation, so neither an abort / deadline nor a concurrent call can slip into the gap
  const syncChecks = () => {
    if (signal && signal.aborted) { trip.code = trip.code ?? "ABORTED_AT_WRITE"; throw new CoordinatorGuardError("ABORTED_AT_WRITE"); }
    if (deadlineAt !== null && now() >= deadlineAt) { trip.code = trip.code ?? "DEADLINE_AT_WRITE"; throw new CoordinatorGuardError("DEADLINE_AT_WRITE"); }
    if (counter[key] >= 1) { trip.code = trip.code ?? "WRITE_BUDGET_GUARD"; throw new CoordinatorBudgetError(key); }
  };
  return { ...executors, [key]: async (...args) => {
    syncChecks();
    if (veto) {
      const v = await veto();
      if (v) { trip.code = trip.code ?? v; throw new CoordinatorGuardError(v); }
      syncChecks();                                                    // C88: re-checked after the await, immediately before the send
    }
    counter[key] += 1;
    return orig(...args);
  } };
}

/** Durable per-intent facts used for the pre-step decision (one short read-only round of statements). */
async function facts(pool, intentId) {
  const ops = (await pool.query(
    `SELECT op_type, state, attempts, dispatched_at, idempotency_key FROM booking.external_operations
      WHERE intent_id = $1 AND op_type = ANY($2) ORDER BY created_at, id`, [intentId, [OP.create, OP.capture, OP.record]])).rows;
  const work = (await pool.query("SELECT next_action_at, work_worker_id, work_lease_until FROM booking.intent_work WHERE intent_id = $1", [intentId])).rows[0] ?? null;
  const cases = Number((await pool.query("SELECT count(*)::int AS n FROM booking.reconciliation_cases WHERE intent_id = $1 AND status = 'open'", [intentId])).rows[0].n);
  const of = (t) => ops.filter((o) => o.op_type === t);
  const dispatched = (t) => of(t).filter((o) => o.dispatched_at != null).length;
  return { create: of(OP.create), capture: of(OP.capture), record: of(OP.record), cases, work,
    dispatched: { create: dispatched(OP.create), capture: dispatched(OP.capture), record: dispatched(OP.record) } };
}

const pristine = (o) => o.state === "pending" && Number(o.attempts) === 0 && o.dispatched_at == null;

/** Which write rows make the phase continuable without a second provider write. null = continuable, else a STOP code. */
function continuable(phase, intent, f) {
  if (phase === "reservation") {
    if (intent.status === S.PAYMENT_AUTHORIZED) return f.create.length === 0 ? null : "CREATE_ALREADY_RECORDED";
    if (f.create.length === 0) return null;
    if (f.create.length !== 1) return "CREATE_NOT_SINGLE";
    const c = f.create[0];
    if (pristine(c)) return null;                                    // queued, never handed to a sender: the ONE create may run
    if (c.state === "succeeded" && c.dispatched_at != null) return null;   // reply recorded (ref not echoed): reads only, never a resend
    return `CREATE_NOT_CONTINUABLE_${String(c.state).toUpperCase()}`;
  }
  if (phase === "capture") {
    if (f.capture.length !== 1) return "CAPTURE_NOT_SINGLE";
    return pristine(f.capture[0]) ? null : "CAPTURE_NOT_PRISTINE";
  }
  if (f.record.length !== 1) return "RECORDING_NOT_SINGLE";
  const r = f.record[0];
  return pristine(r) && r.idempotency_key === `och:${intent.id}:1` ? null : "RECORDING_NOT_PRISTINE";
}

function summarize(intent, f) {
  return freeze({
    state: intent ? intent.status : null, version: intent ? intent.version : null,
    reservationId: intent && intent.reservation ? String(intent.reservation.reservationId) : null,
    ops: f ? freeze({ create: f.create.map((o) => o.state), capture: f.capture.map((o) => o.state), record: f.record.map((o) => o.state) }) : null,
    dispatched: f ? freeze({ ...f.dispatched }) : null,
    nextActionAt: f && f.work ? ms(f.work.next_action_at) : null, openCases: f ? f.cases : null
  });
}

const safeCode = (v, fallback) => (typeof v === "string" && CODE_RE.test(v) ? v : fallback);

/**
 * runTestPipelineCoordinator(pool, { workerId, env, binding: { intentId, ref }, phases: { reservation: { adapterConfig, listings, executors },
 *   capture: { adapterConfig, listings, executors, stripeAccountId }, recording: { listings, executors } }, clock, recordingClock?,
 *   maxSteps?, deadlineAt?, signal?, hooks? })
 *   -> frozen { version, outcome: "CONFIRMED" | "PENDING" | "STOP" | "REFUSED", code, intentId, steps, writes, readback, nextActionAt }
 * hooks.afterStep(step) (tests / operator logging only) runs after each accepted step's readback; a throw from it is a STOP.
 */
export async function runTestPipelineCoordinator(pool, opts = {}) {
  const g = coordinatorGate(opts);
  const steps = [];
  // F2: ATTEMPTED provider writes, incremented by the pre-provider guard only; read on EVERY exit (no query needed)
  const counter = { createReservation: 0, capturePaymentIntent: 0, createOfflineCharge: 0 };
  const writes = () => ({ create: counter.createReservation, capture: counter.capturePaymentIntent, record: counter.createOfflineCharge });
  const out = (outcome, code, extra = {}) => freeze({ version: COORDINATOR_VERSION, outcome, code, intentId: opts.binding?.intentId ?? null,
    steps: freeze(steps.map(freeze)), writes: freeze(writes()), readback: extra.readback ?? null, nextActionAt: extra.nextActionAt ?? null });
  if (!g.ok) return out("REFUSED", g.code);
  const { workerId, env, binding, phases, clock, signal = null, deadlineAt = null, hooks = {} } = opts;
  const recordingClock = opts.recordingClock ?? clock;
  const now = typeof opts.now === "function" ? opts.now : Date.now;          // wall clock for the deadline (injectable for tests)
  const intentId = binding.intentId;
  const trip = { code: null };
  let piId = null;                                                            // the bound PaymentIntent (set after the intent is loaded)
  const vetoFor = () => refundVeto(pool, intentId, piId);
  const gopts = { signal, deadlineAt, now, trip };
  const ex = {
    reservation: guardExecutors(phases.reservation.executors, WRITE_EXECUTORS.reservation, counter, gopts),
    capture: guardExecutors(phases.capture.executors, WRITE_EXECUTORS.capture, counter, { ...gopts, veto: vetoFor }),
    recording: guardExecutors(phases.recording.executors, WRITE_EXECUTORS.recording, counter, { ...gopts, veto: vetoFor })
  };
  let intent = null; let f = null;
  try {
    const markers = (await pool.query("SELECT environment FROM booking.instance")).rows;
    if (markers.length !== 1 || markers[0].environment !== "test") return out("REFUSED", "DATABASE_NOT_TEST");     // C139: exactly one row
    try { intent = await loadIntent(pool, intentId); } catch { return out("REFUSED", "INTENT_NOT_FOUND"); }
    if (intent.listingId !== TEST_LISTING_ID) return out("REFUSED", "LISTING_NOT_TEST_FIXED");
    // C139: the persisted intent row is TEST and priced in the TEST currency (before any worker step)
    const ienv = (await pool.query("SELECT environment FROM booking.intents WHERE id = $1", [intentId])).rows[0];
    if (!ienv || ienv.environment !== "test") return out("REFUSED", "INTENT_ENVIRONMENT_NOT_TEST");
    if (!intent.price || intent.price.currency !== TEST_CURRENCY) return out("REFUSED", "CURRENCY_NOT_TEST_FIXED");
    if (intent.ref !== binding.ref) return out("REFUSED", "BINDING_REF_MISMATCH");
    if (!intent.payment || intent.payment.livemode !== false) return out("REFUSED", "PAYMENT_NOT_TEST_MODE");
    if (intent.reservation && PROTECTED.has(String(intent.reservation.reservationId))) return out("REFUSED", "PROTECTED_RESERVATION_ID");
    piId = intent.payment.paymentIntentId;
    for (let n = 0; n < g.maxSteps; n++) {
      f = await facts(pool, intentId);
      const readback = summarize(intent, f);
      if (intent.status === S.CONFIRMED) return out("CONFIRMED", "CONFIRMED", { readback });
      if (STOP_STATES[intent.status]) return out("STOP", STOP_STATES[intent.status], { readback });
      const phase = PHASE_OF[intent.status];
      if (!phase) return out("STOP", `UNSUPPORTED_STATE_${String(intent.status).toUpperCase()}`, { readback });
      if (f.cases > 0) return out("STOP", "OPEN_CASE", { readback });
      if (intent.reservation && PROTECTED.has(String(intent.reservation.reservationId))) return out("STOP", "PROTECTED_RESERVATION_ID", { readback });
      const bad = continuable(phase, intent, f);
      if (bad) return out("STOP", bad, { readback });
      if (phase === "capture" || phase === "recording") {                     // F1: stored refund veto before the worker / lock / provider
        const v = await refundVeto(pool, intentId, piId);
        if (v) return out("STOP", v, { readback });
      }
      const tBiz = phase === "recording" ? recordingClock() : clock();       // the worker's own business clock for lease / due checks
      if (f.work && f.work.work_lease_until != null && ms(f.work.work_lease_until) > tBiz) return out("STOP", "WORK_LEASED", { readback });
      if (!f.work || f.work.next_action_at == null) return out("STOP", "WORK_NOT_SCHEDULED", { readback });
      if (ms(f.work.next_action_at) > tBiz) return out("PENDING", "NOT_DUE", { readback, nextActionAt: ms(f.work.next_action_at) });
      if (signal && signal.aborted) return out("STOP", "ABORTED", { readback });
      if (deadlineAt !== null && now() + STEP_RESERVE_MS[phase] > deadlineAt) return out("PENDING", "DEADLINE_RESERVE", { readback, nextActionAt: ms(f.work.next_action_at) });
      // --- ONE accepted worker step, scoped to this intent ---
      const before = { ...counter }; const stateBefore = intent.status;
      let r;
      if (phase === "reservation") {
        r = await runOrchestratorStep(pool, { workerId: `${workerId}:res`, env, adapterConfig: phases.reservation.adapterConfig, listings: phases.reservation.listings,
          executors: ex.reservation, clock, intentId });
      } else if (phase === "capture") {
        r = await runCaptureStep(pool, { workerId: `${workerId}:cap`, env, adapterConfig: phases.capture.adapterConfig, listings: phases.capture.listings,
          executors: ex.capture, clock, stripeAccountId: phases.capture.stripeAccountId, intentId });
      } else {
        r = await runRecordingStep(pool, { workerId: `${workerId}:rec`, env, listings: phases.recording.listings, executors: ex.recording, clock: recordingClock,
          intentId, signal, deadlineAt });
      }
      await r.late;                                                      // late provider results settle before anything else is decided
      intent = await loadIntent(pool, intentId);
      const workerStop = r.status === "refused" ? `WORKER_REFUSED_${safeCode(r.code, "UNKNOWN")}`
        : r.stop ? `WORKER_STOP_${safeCode(r.stop.code, "UNKNOWN")}`
          : (r.actions || []).map((a) => /^(STOP:|LEASE_LOST:)/.exec(a) ? a : null).find(Boolean) ?? null;
      const step = { phase, status: r.status, stateBefore, stateAfter: intent.status,
        writes: { create: counter.createReservation - before.createReservation, capture: counter.capturePaymentIntent - before.capturePaymentIntent,
          record: counter.createOfflineCharge - before.createOfflineCharge },
        actions: (r.actions || []).filter((a) => typeof a === "string" && !a.startsWith("RECOVERY:REISSUE")).map((a) => safeCode(a.replace(/[^A-Za-z0-9_:!>.-]/g, "_"), "ACTION")) };
      steps.push(step);
      if (hooks.afterStep) await hooks.afterStep(freeze({ ...step }));
      const w = writes();
      if (w.create > WRITE_BUDGET.create || w.capture > WRITE_BUDGET.capture || w.record > WRITE_BUDGET.record) {
        return out("STOP", "WRITE_BUDGET_EXCEEDED", { readback: summarize(intent, await facts(pool, intentId)) });
      }
      // F3: a guard tripped inside the worker's write call → STOP (the worker's durable unknown / case handling stands; no next stage)
      if (trip.code) return out("STOP", trip.code, { readback: summarize(intent, await facts(pool, intentId)) });
      if (workerStop) return out("STOP", safeCode(String(workerStop).replace(/[^A-Za-z0-9_:!>.-]/g, "_"), "WORKER_STOP"), { readback: summarize(intent, await facts(pool, intentId)) });
      if (r.status === "idle" && intent.status === stateBefore) {
        const f2 = await facts(pool, intentId);
        return out("PENDING", "WORKER_IDLE", { readback: summarize(intent, f2), nextActionAt: f2.work ? ms(f2.work.next_action_at) : null });
      }
    }
    f = await facts(pool, intentId);
    if (intent.status === S.CONFIRMED) return out("CONFIRMED", "CONFIRMED", { readback: summarize(intent, f) });
    return out("PENDING", "MAX_STEPS", { readback: summarize(intent, f), nextActionAt: f.work ? ms(f.work.next_action_at) : null });
  } catch (e) {
    // DB / COMMIT / transport / hook uncertainty: STOP with NO further query; a later read-only step establishes the facts
    return out("STOP", trip.code ? trip.code : e instanceof CoordinatorBudgetError ? "WRITE_BUDGET_GUARD" : `STEP_THREW_${safeCode(e && e.code, "ERROR")}`);
  }
}

export const _internal = freeze({ continuable, facts, guardExecutors, summarize, refundVeto, PHASE_OF, STOP_STATES });
