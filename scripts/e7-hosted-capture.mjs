// scripts/e7-hosted-capture.mjs — E7 Slice 2: HOSTED (GitHub Actions) TEST CAPTURE for ONE admitted TEST intent:
// reservation_confirmed → (the ACCEPTED capture worker, runCaptureStep at the immutable tooling commit) → payment_captured, on the TEST DEV
// database, with FAKE-free real transports.
//
// HONEST LABEL: MANUAL hosted TEST processing (workflow_dispatch + the existing reviewer gate), NOT automatic customer checkout.
// `payment_captured` is an INTERMEDIATE state: nothing is recorded (Hostaway offline charge) or notified by this runner; the recording row the
// accepted state machine queues is reported PRISTINE and never dispatched. publicStatus is NOT changed here (alignment issue retained for
// customer acceptance). Code is NOT consent: executeEnabled is CLOSED here, and the reservation runner's execution stays CLOSED too.
//   * Inert on import (`import.meta.main` guard): no env / fs / network / DB / timer until a mode runs.
//   * Smallest delta over the reviewed Slice 1 runner: the hosted boot / pinning / session-lock (5432) / stop / teardown patterns are REUSED
//     (pure helpers imported from ./e7-hosted-reservation.mjs; the lock / fence / step / teardown sections are LABELLED COPIES of its reviewed
//     sections, specialised to the capture phase). The worker is the accepted lib/booking-db/capture-worker.js, never copied or rebuilt.
//   * Exact pins (plan hash): approval label, intent UUID, expected version, not-before (never a historic intent), the bound PaymentIntent id,
//     the bound Hostaway reservation id, the amount; fixed listing 606998 / USD / ref field / Stripe TEST account / Stripe-Version / DEV project ref.
//     The pins are RE-READ from the database and cross-checked before anything else (CORE_INVALID / SCOPE_REFUSED on any mismatch).
//   * Admission (read-only, before the lock): reservation_confirmed, ONE succeeded create bound to the pinned reservation id, exactly ONE
//     capture row that is PRISTINE (pending / attempts 0 / never dispatched) with attempt 1, the pinned PI / amount and the ACCEPTED idempotency
//     key (captureKey), capturedMinor 0, no capture_unknown / dispatch / lease, the claim held, no open case, no forbidden op, TEST livemode.
//   * Order: start check → P3 session lock on a DEDICATED 5432 session (pid-stable proof before every step) → DB identity → account + fresh
//     STRICT still-authorized Stripe proof → bounded worker steps behind a target-only transport fence (Hostaway GET ONLY: the bound reservation
//     id and THIS arrival's lookup; Stripe GET account / GET PI, and AT MOST ONE capture POST for the bound PI with the pinned amount + key) →
//     read-only postcheck → residual read re-validated at teardown (success stays provisional until it agrees).
//   * STOP on: refusal, deadline, lock loss / backend hop / session error, identity mismatch, lost capture reply (CAPTURE_OUTCOME_UNKNOWN; the
//     accepted worker never resends and the fence refuses a second POST), budget, cancellation. Persisted effects are reported, never hidden.
//   * Never: void, refund, cancel, record, notify, reservation create, queue draining, historical intents, protected reservation ids.
import process from "node:process";
import { readFile, realpath } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { CONSTANTS as RES, canonical, framedDigest, childEnv, spawnNode, dbTargetOk, sessionLockUrl, SESSION_LOCK_PORT, OFFICIAL_CA_SHA256 } from "./e7-hosted-reservation.mjs";

export const CONSTANTS = Object.freeze({
  toolingCommit: RES.toolingCommit,                        // 40779e34 — the SAME immutable MERGED tooling as Slice 1
  toolingStatus: RES.toolingStatus,
  executeEnabled: true,                                    // Slice 2: capture execution OPENED for the ONE reviewed owner-present hosted TEST (ROOT prep GO 2026-11-13); revert to false after
  // Slice 1 closure + the accepted capture worker (test C2 recomputes this from an INDEPENDENT import scan of the pinned tree)
  closure: Object.freeze([...RES.closure, "lib/booking-db/capture-worker.js"].sort()),
  closureDigest: "7321924fa0e841e0adc0779d73f00fc876a9d0246259847673c92859997c7ba0",
  pgVersion: RES.pgVersion,
  runnerFiles: Object.freeze(["scripts/e7-hosted-capture.mjs", "scripts/e7-hosted-reservation.mjs", ".github/workflows/e7-hosted-capture.yml", "test/e7-hosted-capture.test.mjs"]),
  accountId: RES.accountId, listingId: RES.listingId, currency: RES.currency, refFieldId: RES.refFieldId, listingTimeZone: RES.listingTimeZone,
  stripeVersion: RES.stripeVersion, protectedReservationIds: RES.protectedReservationIds,
  // worker: the happy initial capture is ONE step (RES read → account → PI → capture → confirming PI read); waits are honoured (capped).
  // dbQueries = EVERY statement on the counted pool (runner reads + worker + lock session). Measured on disposable PG16 with the REAL worker (test I1):
  // 114 (ref echoed) / 130 (ref not echoed: + by-ref lookup), 7 / 9 exchanges, 1 step; ceiling ≈ 3x the larger. Fail-closed past it.
  budgets: Object.freeze({ steps: 6, capture: 1, hostawayReads: 12, lookupPages: 12, accountReads: 4, piReads: 8, exchanges: 48, dbQueries: 400,
    runMs: 10 * 60 * 1000, waitCapMs: 35 * 1000 }),
  dbEnvironment: RES.dbEnvironment, dbProjectRef: RES.dbProjectRef, nodeVersion: RES.nodeVersion,
  synthetic: Object.freeze({ approvalRef: "SYNTHETIC-capture-preflight-not-for-execute", intentId: "00000000-0000-4000-8000-000000000000", expectedVersion: 6,
    notBefore: "2026-11-12T00:00:00.000Z", paymentIntentId: "pi_SYNTHETIC00000000000000", reservationId: "1", amountMinor: 1 })
});
export const PLAN_SCHEMA = "e7-hosted-capture-plan-v1";
export const RESULT_SCHEMA = "e7-hosted-capture-result-v1";
export const OUTCOMES = Object.freeze(["PAYMENT_CAPTURED_INTERMEDIATE", "SCOPE_REFUSED", "START_STATE_NOT_ELIGIBLE", "LOCK_NOT_ACQUIRED", "LOCK_LOST",
  "DB_IDENTITY_MISMATCH", "PROVIDER_PROOF_FAILED", "WORKER_REFUSED", "CAPTURE_OUTCOME_UNKNOWN", "CAPTURE_FAILED", "CAPTURE_UNKNOWN_STATE", "STEP_BUDGET_EXHAUSTED",
  "BUDGET_EXHAUSTED", "DEADLINE", "ABORTED", "DB_ERROR", "POSTCHECK_MISMATCH", "NOT_CONFIRMED", "CORE_INVALID"]);
export const HOSTED_CODES = Object.freeze(["HCP_USAGE", "HCP_SECRET_SCOPE_VIOLATION", "HCP_INPUT_INVALID", "HCP_INPUT_INCOMPLETE", "HCP_REF_NOT_MAIN",
  "HCP_EXECUTE_CLOSED", "HCP_LAYOUT_INVALID", "HCP_SOURCE_UNREADABLE", "HCP_SOURCE_MISMATCH", "HCP_RUNNER_MISMATCH", "HCP_PLAN_HASH_MISMATCH",
  "HCP_DEPENDENCY_MISMATCH", "HCP_ENV_REFUSED", "HCP_TESTS_FAILED", "HCP_CHILD_FAILED", "HCP_IMPORT_FAILED", "HCP_CREDENTIALS_MISSING",
  "HCP_DB_TARGET_INVALID", "HCP_CA_INVALID", "HCP_INTERNAL", "PREFLIGHT_OK_REAL_PLAN", "PREFLIGHT_OK_SYNTHETIC_ONLY", "VERIFY_OK", "EXECUTE_DONE"]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RID_RE = /^[1-9][0-9]{0,15}$/;
const PI_RE = /^pi_[A-Za-z0-9_]{1,250}$/;
const APPROVAL_RE = /^[A-Za-z0-9._:-]{1,80}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const HEX64 = /^[0-9a-f]{64}$/; const HEX40 = /^[0-9a-f]{40}$/;
const CODE_RE = /^[A-Za-z0-9_:>!.-]{1,80}$/;
const CHARGE_RE = /^(ch|py)_[A-Za-z0-9_]{1,200}$/;
const STRIPE = "https://api.stripe.com"; const HOSTAWAY = "https://api.hostaway.com";
const freeze = Object.freeze;
class Refusal extends Error { constructor(code) { super("e7-hosted-capture"); this.code = code; } }
const refuse = (code) => { throw new Refusal(code); };
const sha = (s) => createHash("sha256").update(s).digest("hex");
function deepFreeze(v) { if (v && typeof v === "object") { for (const k of Object.keys(v)) deepFreeze(v[k]); freeze(v); } return v; }
const isVersion = (v) => Number.isSafeInteger(v) && v >= 1 && v <= 1000000;
const isAmount = (v) => Number.isSafeInteger(v) && v >= 1 && v <= 99999999;
const isoMs = (s) => (typeof s === "string" && ISO_RE.test(s) && Number.isFinite(Date.parse(s)) && new Date(Date.parse(s)).toISOString() === (s.length === 20 ? `${s.slice(0, 19)}.000Z` : s) ? Date.parse(s) : null);

// =================================================================================================================================
// plan (pure)
/** buildPlan(c, { approvalRef, intentId, expectedVersion, notBefore, paymentIntentId, reservationId, amountMinor, runnerDigest }) → frozen { plan, planHash } */
export function buildPlan(c, { approvalRef, intentId, expectedVersion, notBefore, paymentIntentId, reservationId, amountMinor, runnerDigest }) {
  if (typeof approvalRef !== "string" || !APPROVAL_RE.test(approvalRef)) refuse("HCP_INPUT_INVALID");
  if (typeof intentId !== "string" || !UUID_RE.test(intentId) || !isVersion(expectedVersion)) refuse("HCP_INPUT_INVALID");
  if (isoMs(notBefore) === null) refuse("HCP_INPUT_INVALID");
  if (typeof paymentIntentId !== "string" || !PI_RE.test(paymentIntentId)) refuse("HCP_INPUT_INVALID");
  if (typeof reservationId !== "string" || !RID_RE.test(reservationId) || c.protectedReservationIds.includes(reservationId)) refuse("HCP_INPUT_INVALID");
  if (!isAmount(amountMinor)) refuse("HCP_INPUT_INVALID");
  if (typeof runnerDigest !== "string" || !HEX64.test(runnerDigest)) refuse("HCP_INPUT_INVALID");
  if (c.accountId !== "acct_1TyHE42B9LTneQgw" || c.listingId !== 606998 || c.currency !== "USD" || c.stripeVersion !== "2026-01-28.clover" || c.dbEnvironment !== "test"
      || c.budgets.capture !== 1 || c.budgets.steps !== 6) refuse("HCP_INPUT_INVALID");                                                      // code ceiling
  const plan = { schema: PLAN_SCHEMA, toolingCommit: c.toolingCommit, toolingStatus: c.toolingStatus, closureDigest: c.closureDigest, runnerDigest,
    pgVersion: c.pgVersion, stripeVersion: c.stripeVersion, accountId: c.accountId, listingId: c.listingId, currency: c.currency, refFieldId: c.refFieldId,
    dbEnvironment: c.dbEnvironment, dbProjectRef: c.dbProjectRef, intentId, expectedVersion, notBefore, paymentIntentId, reservationId, amountMinor,
    captureIdempotencyKey: `cap:${intentId}:${paymentIntentId}`,                                          // = the accepted captureKey(intentId, pi, 1); cross-checked against tooling + the row
    approvalRef, budgets: { ...c.budgets },
    operations: ["db.capture_worker_steps<=6", "hostaway.get_reservation(reservationId)", "hostaway.lookup_by_ref(606998,arrival)", "stripe.accounts.retrieve",
      "stripe.paymentIntents.retrieve(pi)", "stripe.paymentIntents.capture(pi,amount,key)<=1"],
    writes: { captureMax: 1, hostawayCreate: 0, refund: 0, record: 0, notify: 0, cancel: 0, void: 0, account: 0, keys: 0 } };
  return freeze({ plan: deepFreeze(plan), planHash: sha(canonical(plan)) });
}

// =================================================================================================================================
// DB reads (read-only SELECTs through the runtime login; no transaction held across a provider call)
const Q = freeze({
  instance: "/*e7hcp:instance*/ SELECT environment FROM booking.instance",
  attempts: "/*e7hcp:attempts*/ SELECT id::text AS id, status, checkout_session_id, payment_intent_id, livemode FROM booking.payment_attempts WHERE intent_id = $1 ORDER BY attempt",
  hostaway: "/*e7hcp:hostaway*/ SELECT state, hostaway_reservation_id::text AS rid FROM booking.hostaway_reservation_attempts WHERE intent_id = $1",
  ops: `/*e7hcp:ops*/ SELECT op_type, state, attempts, (dispatched_at IS NOT NULL) AS dispatched, result_ref, late_result_ref, payload ->> 'reservationId' AS payload_rid,
      payload ->> 'paymentIntentId' AS payload_pi, (payload ->> 'attempt')::int AS payload_attempt, (payload ->> 'amountMinor')::int AS payload_amount,
      payload ->> 'providerIdempotencyKey' AS payload_key FROM booking.external_operations WHERE intent_id = $1 ORDER BY created_at, id`,
  cases: "/*e7hcp:cases*/ SELECT count(*)::int AS n FROM booking.reconciliation_cases WHERE intent_id = $1 AND status = 'open'",
  claims: "/*e7hcp:claims*/ SELECT listing_id, (released_at IS NOT NULL) AS released FROM booking.inventory_claims WHERE intent_id = $1",
  role: `/*e7hcp:role*/ SELECT pg_has_role(current_user, 'mv_booking_app', 'MEMBER') AS is_app, (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) AS privileged`,
  identity: "/*e7hcp:identity*/ SELECT current_database() AS db, (SELECT environment FROM booking.instance) AS environment"
});
export const QUERIES = Q;
const BEFORE_OPS = freeze(["stripe.create_checkout_session", "stripe.retrieve_checkout_session", "stripe.retrieve_payment_intent", "hostaway.create_reservation",
  "hostaway.lookup_reservation", "hostaway.retrieve_reservation", "stripe.capture_payment_intent"]);
const AFTER_OPS = freeze([...BEFORE_OPS, "hostaway.record_offline_charge"]);
const FORBIDDEN_OPS = freeze(["stripe.void_payment_intent", "hostaway.cancel_reservation", "guest.notify", "alert.owner", "stripe.refund", "stripe.create_refund"]);
const CAPTURE = "stripe.capture_payment_intent"; const RECORD = "hostaway.record_offline_charge"; const CREATE = "hostaway.create_reservation";
const pristine = (o) => o && o.state === "pending" && o.attempts === 0 && o.dispatched === false;

async function readFacts(q, plan, tooling, raw) {
  const inst = await q(Q.instance, []);
  const intent = await tooling.loadIntent(raw, plan.intentId);                                       // accepted repo read over the counted pool
  const attempts = await q(Q.attempts, [plan.intentId]);
  const hostaway = await q(Q.hostaway, [plan.intentId]);
  const ops = await q(Q.ops, [plan.intentId]);
  const cases = await q(Q.cases, [plan.intentId]);
  const claims = await q(Q.claims, [plan.intentId]);
  return freeze({ instance: inst[0]?.environment ?? null, intent, attempts, hostaway, ops, openCases: cases[0]?.n ?? null, claims });
}
/** the facts every exit shares (scope, protection, binding to the PINNED pi / reservation / amount) → null | code */
function checkCommon(f, plan, c) {
  if (f.instance !== c.dbEnvironment) return "DATABASE_NOT_TEST";
  const i = f.intent;
  if (!i) return "INTENT_NOT_FOUND";
  if (i.listingId !== c.listingId) return "LISTING_NOT_SCOPED";
  if (!i.price || i.price.currency !== c.currency || !Number.isSafeInteger(i.price.finalTotalMinor) || i.price.finalTotalMinor <= 0) return "PRICE_NOT_SCOPED";
  if (!Number.isSafeInteger(i.createdAt) || i.createdAt < isoMs(plan.notBefore)) return "HISTORIC_INTENT";
  if (!i.payment || i.payment.livemode !== false || typeof i.payment.paymentIntentId !== "string") return "PAYMENT_NOT_TEST";
  if (i.payment.paymentIntentId !== plan.paymentIntentId) return "PAYMENT_INTENT_NOT_PINNED";
  if (i.payment.amountMinor !== i.price.finalTotalMinor || String(i.payment.currency || "").toUpperCase() !== c.currency) return "AUTHORIZED_AMOUNT_NOT_PRICE";
  if (i.price.finalTotalMinor !== plan.amountMinor) return "AMOUNT_NOT_PINNED";
  if (!i.reservation || String(i.reservation.reservationId) !== plan.reservationId) return "RESERVATION_NOT_PINNED";
  if (c.protectedReservationIds.includes(String(i.reservation.reservationId))) return "PROTECTED_REFERENCE";
  for (const h of f.hostaway) if (h.rid !== null && (c.protectedReservationIds.includes(String(h.rid)) || String(h.rid) !== plan.reservationId)) return "RESERVATION_ID_CONFLICT";
  for (const o of f.ops) { if (FORBIDDEN_OPS.includes(o.op_type)) return "FORBIDDEN_OP_PRESENT"; if (o.result_ref !== null && CREATE === o.op_type && String(o.result_ref) !== plan.reservationId) return "RESERVATION_ID_CONFLICT"; }
  const creates = f.ops.filter((o) => o.op_type === CREATE);
  if (creates.length !== 1 || creates[0].state !== "succeeded" || creates[0].dispatched !== true || String(creates[0].result_ref ?? "") !== plan.reservationId) return "CREATE_NOT_PROVEN_SUCCEEDED";
  const att = f.attempts;
  if (att.length !== 1 || att[0].status !== "completed" || att[0].livemode !== false || att[0].payment_intent_id !== plan.paymentIntentId) return "PAYMENT_ATTEMPT_NOT_SINGLE_COMPLETED";
  if (f.claims.length !== 1 || f.claims[0].listing_id !== c.listingId || f.claims[0].released !== false) return "CLAIM_NOT_HELD";
  if (f.openCases !== 0) return "OPEN_CASE";
  return null;
}
/** checkStart(f, plan, c, tooling?) → { ok, intent, attemptId, captureKey } | { ok:false, code } — read-only admission (the worker's in-tx guards stay authoritative) */
export function checkStart(f, plan, c = CONSTANTS, tooling = null) {
  const no = (code) => freeze({ ok: false, code });
  const common = checkCommon(f, plan, c);
  if (common) return no(common);
  const i = f.intent;
  if (i.status !== "reservation_confirmed") return no("STATE_NOT_RESERVATION_CONFIRMED");
  if (i.version !== plan.expectedVersion) return no("VERSION_NOT_PINNED");
  if (i.payment.capturedMinor !== 0) return no("ALREADY_CAPTURED");
  if (i.lease) return no("RESERVATION_LEASE_HELD");                                                  // the reservation worker's lease must be gone (intent.dispatch legitimately records the ONE create)
  if (!i.counters || i.counters.captureAttempts !== 1) return no("CAPTURE_NOT_INITIAL");
  for (const o of f.ops) if (!BEFORE_OPS.includes(o.op_type)) return no("UNEXPECTED_OP");
  const caps = f.ops.filter((o) => o.op_type === CAPTURE);
  if (caps.length !== 1) return no("CAPTURE_ROW_NOT_SINGLE");
  const cap = caps[0];
  if (!pristine(cap)) return no("CAPTURE_NOT_PRISTINE");                                           // any prior dispatch / attempt / outcome refuses
  if (cap.payload_pi !== plan.paymentIntentId || cap.payload_attempt !== 1 || cap.payload_amount !== plan.amountMinor) return no("CAPTURE_ROW_NOT_BOUND");
  if (cap.payload_key !== plan.captureIdempotencyKey) return no("CAPTURE_KEY_NOT_ACCEPTED");
  if (tooling && typeof tooling.captureKey === "function" && tooling.captureKey(i.id, plan.paymentIntentId, 1) !== plan.captureIdempotencyKey) return no("CAPTURE_KEY_NOT_ACCEPTED");
  if (f.ops.some((o) => o.op_type === RECORD)) return no("UNEXPECTED_OP");
  return freeze({ ok: true, intent: i, attemptId: f.attempts[0].id, captureKey: cap.payload_key });
}
/** checkEnd(f, plan, c) → null | code — the persisted facts a captured outcome must show (anything else = POSTCHECK_MISMATCH / RESIDUAL_*) */
export function checkEnd(f, plan, c = CONSTANTS) {
  const common = checkCommon(f, plan, c);
  if (common) return common;
  const i = f.intent;
  if (i.status !== "payment_captured") return "STATE_NOT_CAPTURED";
  if (i.payment.capturedMinor !== plan.amountMinor) return "CAPTURED_AMOUNT";
  for (const o of f.ops) if (!AFTER_OPS.includes(o.op_type)) return "UNEXPECTED_OP";
  const caps = f.ops.filter((o) => o.op_type === CAPTURE);
  if (caps.length !== 1 || caps[0].state !== "succeeded" || caps[0].dispatched !== true || caps[0].attempts !== 1 || !CHARGE_RE.test(String(caps[0].result_ref ?? ""))) return "CAPTURE_OP_NOT_SINGLE_SUCCEEDED";
  if (caps[0].payload_pi !== plan.paymentIntentId || caps[0].payload_amount !== plan.amountMinor || caps[0].payload_key !== plan.captureIdempotencyKey) return "CAPTURE_ROW_NOT_BOUND";
  const recs = f.ops.filter((o) => o.op_type === RECORD);
  if (recs.length !== 1 || !pristine(recs[0])) return "RECORDING_NOT_PRISTINE";                     // queued by the accepted state machine, never dispatched here
  return null;
}

// =================================================================================================================================
/**
 * runCaptureCore({ plan, pool, lockClientFactory, tooling, exchanges, credentials, clock, monotonic, sleep, runSignal }) → frozen result.
 *  tooling = { runCaptureStep, loadIntent, createPhaseExecutors, createStripeSend, createHostawaySend, validateAdapterConfig,
 *              paymentIntentProofObservationV3, stillAuthorizedV3Refusal, captureKey, LOCK_KEY, LOCK_PRECHECK_SQL }
 *  lockClientFactory() → a dedicated checked-out client (query / release / on) for the session lock (pool.connect by default).
 */
export async function runCaptureCore(input) {
  const c = CONSTANTS; const B = c.budgets;
  const r = { schema: RESULT_SCHEMA, outcome: null, code: null, startState: null, finalState: null, finalVersion: null, reservationId: null, capturedMinor: null, chargeId: null,
    steps: 0, actions: [], exchanges: 0, hostawayReads: 0, lookupPages: 0, accountReads: 0, piReads: 0, dbQueries: 0, dbBudgetRefused: 0,
    captureInvocations: 0, captureOutcome: "NONE", refusedAtTransport: 0, refusedByStop: 0, lock: "not_acquired", lockSession: null, lockBackendPid: null, proofs: [],
    postcheck: null, captureOps: null, recordingQueuedPristine: null, factsObserved: false, stopReason: null,
    stripeVersion: c.stripeVersion, writes: { capture: 0, create: 0, refund: 0, record: 0, notify: 0, cancel: 0, void: 0 } };
  const DONE = Symbol("done");
  const done = (outcome, code = null) => { r.outcome = outcome; r.code = code; return DONE; };
  const snapshot = () => freeze(JSON.parse(JSON.stringify(r)));
  let stopReason = null; let runSignalRef = null; let monoRef = null; let endsAtRef = Infinity;
  let lockClient = null; let lockAcquired = false; let lockErrored = false; let lockPid = null;
  // LABELLED COPY of e7-hosted-reservation.mjs — the GLOBAL stop latch (run abort, fixed wall deadline, observed lock-session error)
  const stopped = () => {
    if (stopReason === null) {
      if (runSignalRef && runSignalRef.aborted) stopReason = "ABORTED";
      else if (lockErrored) stopReason = "LOCK_SESSION_ERROR";
      else if (monoRef && monoRef() >= endsAtRef) stopReason = "DEADLINE";
      if (stopReason !== null) r.stopReason = stopReason;
    }
    return stopReason;
  };
  class Stopped extends Error { constructor() { super("stopped"); } }
  const guard = () => { if (stopped()) throw new Stopped(); };
  const uncertain = () => (r.captureOutcome === "UNKNOWN" ? "CAPTURE_OUTCOME_UNKNOWN" : null);
  const stopOutcome = () => done(uncertain() ?? (stopReason === "LOCK_SESSION_ERROR" ? "LOCK_LOST" : stopReason), `STOP_${stopReason}`);
  /** best available OBSERVED facts: recorded on every exit that has them; `factsObserved` distinguishes unobserved from absent */
  const observe = (f) => {
    if (!f || !f.intent) return;
    r.factsObserved = true; r.finalState = f.intent.status; r.finalVersion = f.intent.version;
    r.reservationId = f.intent.reservation && f.intent.reservation.reservationId !== null && f.intent.reservation.reservationId !== undefined ? String(f.intent.reservation.reservationId) : null;
    r.capturedMinor = f.intent.payment ? f.intent.payment.capturedMinor ?? null : null;
    const caps = f.ops.filter((o) => o.op_type === CAPTURE);
    r.captureOps = caps.map((o) => o.state);
    r.chargeId = caps.length === 1 && caps[0].state === "succeeded" && CHARGE_RE.test(String(caps[0].result_ref ?? "")) ? String(caps[0].result_ref) : null;
    const recs = f.ops.filter((o) => o.op_type === RECORD);
    r.recordingQueuedPristine = recs.length === 0 ? null : recs.length === 1 && pristine(recs[0]);
  };
  const body = async () => {
    const { plan, pool, tooling, exchanges, credentials } = input ?? {};
    if (!plan || plan.schema !== PLAN_SCHEMA || plan.accountId !== c.accountId || plan.listingId !== c.listingId || plan.stripeVersion !== c.stripeVersion
        || !UUID_RE.test(String(plan.intentId)) || !isVersion(plan.expectedVersion) || isoMs(plan.notBefore) === null || !PI_RE.test(String(plan.paymentIntentId))
        || !RID_RE.test(String(plan.reservationId)) || c.protectedReservationIds.includes(String(plan.reservationId)) || !isAmount(plan.amountMinor)
        || plan.captureIdempotencyKey !== `cap:${plan.intentId}:${plan.paymentIntentId}` || plan.intentId === c.synthetic.intentId
        || !pool || typeof pool.query !== "function" || !tooling || !exchanges || typeof exchanges.stripe !== "function" || typeof exchanges.hostaway !== "function"
        || !credentials || typeof credentials.stripe !== "function" || typeof credentials.hostaway !== "function") return done("CORE_INVALID");
    for (const k of ["runCaptureStep", "loadIntent", "createPhaseExecutors", "createStripeSend", "createHostawaySend", "validateAdapterConfig",
      "paymentIntentProofObservationV3", "stillAuthorizedV3Refusal", "captureKey"]) if (typeof tooling[k] !== "function") return done("CORE_INVALID", "TOOLING_INVALID");
    if (typeof tooling.LOCK_KEY !== "string" || typeof tooling.LOCK_PRECHECK_SQL !== "string") return done("CORE_INVALID", "TOOLING_INVALID");
    const clock = input.clock ?? (() => Date.now());
    const mono = input.monotonic ?? (() => performance.now());
    const runSignal = input.runSignal ?? null;
    const endsAt = mono() + B.runMs;
    runSignalRef = runSignal; monoRef = mono; endsAtRef = endsAt;
    const sleep = input.sleep ?? ((ms) => new Promise((res) => { const t = setTimeout(res, ms); runSignal?.addEventListener?.("abort", () => { clearTimeout(t); res(); }, { once: true }); }));
    const lockClientFactory = input.lockClientFactory ?? (() => pool.connect());

    // ---- (1) counted pool: EVERY statement (runner reads + worker, connected clients included) is counted once at this boundary ------------
    const count = () => { if (r.dbQueries >= B.dbQueries) { r.dbBudgetRefused += 1; throw new Refusal("DB_BUDGET"); } r.dbQueries += 1; };
    const countedPool = {
      query: (...a) => { count(); return pool.query(...a); },
      connect: async () => { const cl = await pool.connect(); const q = cl.query.bind(cl);
        return { query: (...a) => { count(); return q(...a); }, release: (...a) => cl.release(...a), on: (...a) => (typeof cl.on === "function" ? cl.on(...a) : undefined),
          removeListener: (...a) => (typeof cl.removeListener === "function" ? cl.removeListener(...a) : undefined) }; }
    };
    const q = async (sql, params) => { guard(); const res = await countedPool.query(sql, params); return res.rows; };
    const read = () => readFacts(q, plan, tooling, { query: (sql, params) => { guard(); return countedPool.query(sql, params); } });

    // ---- (2) read-only start check: the pins are RE-READ and cross-checked --------------------------------------------------------------------
    let f;
    try { f = await read(); } catch (e) { return e instanceof Stopped ? stopOutcome() : done("DB_ERROR", "START_READ_FAILED"); }
    r.startState = f.intent ? f.intent.status : null;
    const st = checkStart(f, plan, c, tooling);
    if (!st.ok) return done(["STATE_NOT_RESERVATION_CONFIRMED", "VERSION_NOT_PINNED", "HISTORIC_INTENT", "RESERVATION_LEASE_HELD", "CAPTURE_NOT_PRISTINE", "ALREADY_CAPTURED",
      "CAPTURE_NOT_INITIAL", "CAPTURE_ROW_NOT_SINGLE"].includes(st.code) ? "START_STATE_NOT_ELIGIBLE" : "SCOPE_REFUSED", st.code);
    const intent0 = st.intent; const PI = plan.paymentIntentId; const RID = plan.reservationId;

    // ---- (3) LABELLED COPY (Slice 1 §3, F4): the P3 session lock on a DEDICATED client; pid-stable proof --------------------------------------
    try { lockClient = await lockClientFactory(); } catch { return done("DB_ERROR", "LOCK_CONNECT_FAILED"); }
    const onLockErr = () => { lockErrored = true; r.lockSession = "error_observed"; };
    if (typeof lockClient.on === "function") lockClient.on("error", onLockErr);
    const OWN_LOCK_SQL = `${tooling.LOCK_PRECHECK_SQL} AND l.pid = pg_catalog.pg_backend_pid()`;
    const lockQuery = async (sql, params) => { guard(); count(); return lockClient.query(sql, params); };
    const PROOF_SQL = `SELECT (${OWN_LOCK_SQL}) AS n, pg_catalog.pg_backend_pid() AS pid`;
    const ownLock = async () => {
      if (lockErrored) return false;
      const x = await lockQuery(PROOF_SQL, [tooling.LOCK_KEY]);
      if (lockErrored || x.rows.length !== 1 || x.rows[0].n !== 1) return false;
      if (lockPid !== null && String(x.rows[0].pid) !== lockPid) { r.lockSession = "backend_hop"; return false; }
      return true;
    };
    try {
      const got = await lockQuery("SELECT pg_try_advisory_lock(pg_catalog.hashtext($1), 0) AS ok, pg_catalog.pg_backend_pid() AS pid", [tooling.LOCK_KEY]);
      if (!(got.rows.length === 1 && got.rows[0].ok === true)) return done("LOCK_NOT_ACQUIRED", "RUN_LOCK_PRESENT");
      lockAcquired = true; lockPid = String(got.rows[0].pid); r.lockBackendPid = /^[0-9]{1,10}$/.test(lockPid) ? Number(lockPid) : null;
      if (!(await ownLock())) return done("LOCK_NOT_ACQUIRED", r.lockSession === "backend_hop" ? "BACKEND_HOP" : "LOCK_NOT_PROVEN");
      r.lock = "held";
    } catch (e) { return e instanceof Stopped ? stopOutcome() : done("DB_ERROR", "LOCK_QUERY_FAILED"); }

    // ---- (4) DB identity on the lock session AND the pool (same database, TEST instance); app role ----------------------------------------
    try {
      const a = await lockQuery(Q.identity, []); const b = await q(Q.identity, []);
      if (a.rows.length !== 1 || b.length !== 1 || a.rows[0].db !== b[0].db || a.rows[0].environment !== c.dbEnvironment || b[0].environment !== c.dbEnvironment) return done("DB_IDENTITY_MISMATCH", "POOLS_MISMATCH");
      const role = await q(Q.role, []);
      if (role.length !== 1 || role[0].privileged !== false || role[0].is_app !== true) return done("SCOPE_REFUSED", "ROLE_NOT_APP");
    } catch (e) { return e instanceof Stopped ? stopOutcome() : done("DB_ERROR", "IDENTITY_READ_FAILED"); }

    // ---- (5) the target-only transport fence (capture phase) ----------------------------------------------------------------------------------
    const urls = { account: `${STRIPE}/v1/account`, pi: `${STRIPE}/v1/payment_intents/${PI}?expand%5B%5D=latest_charge`, capture: `${STRIPE}/v1/payment_intents/${PI}/capture`,
      reservation: `${HOSTAWAY}/v1/reservations/${RID}` };
    const CAPTURE_BODY = `amount_to_capture=${plan.amountMinor}&final_capture=true&expand%5B%5D=latest_charge`;
    const fence = { captureOpen: false, captureExchanged: false, secondSend: false };
    const hkeys = (h) => Object.keys(h).sort().join(",");
    const stripeGate = (req) => {
      if (stopped()) { r.refusedByStop += 1; return Promise.reject(new Error("stopped")); }
      if (!req || !req.headers || req.headers["Stripe-Version"] !== c.stripeVersion || r.exchanges >= B.exchanges) { r.refusedAtTransport += 1; return Promise.reject(new Error("gate")); }
      const isGet = req.method === "GET" && req.body === null && hkeys(req.headers) === "Authorization,Stripe-Version";
      const isCapture = req.method === "POST" && req.url === urls.capture && hkeys(req.headers) === "Authorization,Content-Type,Idempotency-Key,Stripe-Version"
        && req.headers["Idempotency-Key"] === plan.captureIdempotencyKey && req.headers["Content-Type"] === "application/x-www-form-urlencoded" && req.body === CAPTURE_BODY;
      if (isGet && req.url === urls.account && r.accountReads < B.accountReads) r.accountReads += 1;
      else if (isGet && req.url === urls.pi && r.piReads < B.piReads) r.piReads += 1;
      else if (isCapture && fence.captureOpen && !fence.captureExchanged) fence.captureExchanged = true;        // the ONE capture: exact URL / method / headers / body / key
      else { r.refusedAtTransport += 1; return Promise.reject(new Error("gate")); }                           // no other Stripe write, ever
      r.exchanges += 1;
      return exchanges.stripe(req);
    };
    const isLookupUrl = (url) => {
      let u; try { u = new URL(url); } catch { return false; }
      if (u.origin !== HOSTAWAY || u.pathname !== "/v1/reservations" || u.hash !== "") return false;
      const keys = [...u.searchParams.keys()];
      if (new Set(keys).size !== keys.length) return false;
      const base = ["arrivalEndDate", "arrivalStartDate", "channelId", "includeResources", "limit", "listingId"];
      const sorted = [...keys].sort().join(",");
      if (sorted !== base.join(",") && sorted !== ["afterId", ...base].sort().join(",")) return false;
      const g = (k) => u.searchParams.get(k);
      return g("listingId") === String(c.listingId) && g("channelId") === "2000" && g("arrivalStartDate") === intent0.from && g("arrivalEndDate") === intent0.from
        && g("limit") === "100" && g("includeResources") === "1" && (!u.searchParams.has("afterId") || RID_RE.test(g("afterId")));
    };
    const hostawayGate = (req) => {
      if (stopped()) { r.refusedByStop += 1; return Promise.reject(new Error("stopped")); }
      if (!req || !req.headers || r.exchanges >= B.exchanges) { r.refusedAtTransport += 1; return Promise.reject(new Error("gate")); }
      const plainGet = req.method === "GET" && req.body === null && hkeys(req.headers) === "Accept,Authorization,Cache-control";
      if (plainGet && req.url === urls.reservation && r.hostawayReads < B.hostawayReads) r.hostawayReads += 1;        // ONLY the pinned reservation id
      else if (plainGet && isLookupUrl(req.url) && r.lookupPages < B.lookupPages) r.lookupPages += 1;
      else { r.refusedAtTransport += 1; return Promise.reject(new Error("gate")); }                                   // ZERO Hostaway writes, ever
      r.exchanges += 1;
      return exchanges.hostaway(req);
    };
    const ts = tooling.createStripeSend({ exchange: stripeGate, credential: credentials.stripe, accountId: c.accountId, apiVersion: c.stripeVersion });
    const th = tooling.createHostawaySend({ exchange: hostawayGate, credential: credentials.hostaway });
    if (!ts || ts.ok !== true || !th || th.ok !== true) return done("CORE_INVALID", "TRANSPORT_INVALID");
    const composed = (sig) => {
      const parts = [];
      if (sig instanceof AbortSignal) parts.push(sig);
      if (runSignal instanceof AbortSignal) parts.push(runSignal);
      parts.push(AbortSignal.timeout(Math.max(1, Math.floor(endsAt - mono()))));
      return AbortSignal.any(parts);
    };

    // ---- (6) account + fresh STRICT still-authorized Stripe proof (reads only) BEFORE any worker step ------------------------------------
    try {
      guard();
      const acct = await ts.transport.send({ op: "accounts.retrieve" }, { signal: composed(null) });
      if (!acct || acct.object !== "account" || acct.id !== c.accountId) return done("PROVIDER_PROOF_FAILED", "ACCOUNT");
      guard();
      const pi = await ts.transport.send({ op: "paymentIntents.retrieve", id: PI, params: { expand: ["latest_charge"] } }, { signal: composed(null) });
      const observed = tooling.paymentIntentProofObservationV3(pi, { accountVerified: true });
      const ev = { id: "runner-readback", kind: "payment_intent", readOpType: "stripe.retrieve_payment_intent", requestRef: PI, externalRef: PI, status: observed.status, observed, observedAt: clock() };
      const code = tooling.stillAuthorizedV3Refusal(ev, intent0, st.attemptId);
      if (code) return done("PROVIDER_PROOF_FAILED", CODE_RE.test(String(code)) ? String(code) : "PI_PROOF");
      r.proofs.push("BEFORE_WORKER");
    } catch (e) { if (e instanceof Stopped || stopped()) return stopOutcome(); return done("PROVIDER_PROOF_FAILED", "READ_FAILED"); }

    // ---- (7) the accepted capture executors over the fence; the capture send is counted and fenced BEFORE the transport -------------------
    const hostawaySend = async (req, opts) => {
      if (stopped()) { r.refusedByStop += 1; throw new Error("stopped"); }
      if (!req || req.method !== "GET") { r.refusedAtTransport += 1; throw new Error("method refused"); }                  // Hostaway GET ONLY
      return th.transport.send(req, { ...(opts && typeof opts === "object" ? opts : {}), signal: composed(opts && opts.signal) });
    };
    const stripeSend = async (call, opts) => {
      if (stopped()) { r.refusedByStop += 1; throw new Error("stopped"); }
      const o = { ...(opts && typeof opts === "object" ? opts : {}), signal: composed(opts && opts.signal) };
      if (call && call.op === "paymentIntents.capture") {
        if (r.captureInvocations >= B.capture || stopped()) { r.refusedAtTransport += 1; fence.secondSend = true; throw new Error("capture budget"); }   // counter fence BEFORE the transport
        r.captureInvocations += 1; r.writes.capture += 1; fence.captureOpen = true;
        try {
          const out = await ts.transport.send(call, o);
          r.captureOutcome = out && typeof out === "object" ? "REPLIED" : "UNKNOWN";
          return out;
        } catch (e) { r.captureOutcome = fence.captureExchanged ? "UNKNOWN" : "NOT_SENT"; throw e; }
        finally { fence.captureOpen = false; }
      }
      if (!call || !(call.op === "accounts.retrieve" || call.op === "paymentIntents.retrieve")) { r.refusedAtTransport += 1; throw new Error("op refused"); }
      return ts.transport.send(call, o);
    };
    const bx = tooling.createPhaseExecutors({ phase: "capture", binding: { listingId: c.listingId, arrivalDate: intent0.from, departureDate: intent0.to, ref: intent0.ref,
      reservationId: RID, accountId: c.accountId, paymentIntentId: PI, amountMinor: plan.amountMinor, captureIdempotencyKey: plan.captureIdempotencyKey },
      hostaway: { send: hostawaySend }, stripe: { send: stripeSend } });
    if (!bx || bx.ok !== true) return done("SCOPE_REFUSED", "EXECUTOR_BINDING_REFUSED");
    const executors = {};
    for (const k of Object.keys(bx.executors)) { const fn = bx.executors[k]; executors[k] = async (...args) => { if (stopped()) { r.refusedByStop += 1; throw new Error("stopped"); } return Reflect.apply(fn, undefined, args); }; }
    freeze(executors);
    const listings = new Map([[c.listingId, { currency: c.currency, timeZone: c.listingTimeZone }]]);
    const env = { VERCEL_ENV: "development", MV_E7_CAPTURE_WORKER: "enabled" };
    const adapterConfig = tooling.validateAdapterConfig({ allowedListingIds: [c.listingId], refFieldId: c.refFieldId, channelId: 2000, currency: c.currency });

    // ---- (8) LABELLED COPY (Slice 1 §8, F1/F3): bounded worker steps; lock proven before EVERY step; stop after the awaited proof and before the worker --
    let finalFacts = null;
    for (let step = 1; step <= B.steps; step++) {
      if (stopped()) return stopOutcome();
      try { if (!(await ownLock())) { r.lock = "lost"; return done("LOCK_LOST", lockErrored ? "LOCK_SESSION_ERROR" : r.lockSession === "backend_hop" ? "BACKEND_HOP" : "LOCK_NOT_HELD"); } }
      catch (e) { return e instanceof Stopped ? stopOutcome() : done("DB_ERROR", "LOCK_PROOF_FAILED"); }
      if (stopped()) return stopOutcome();                                                            // after the awaited proof
      let w;
      if (stopped()) return stopOutcome();                                                            // immediately BEFORE the worker is admitted
      try {
        r.steps += 1;
        w = await tooling.runCaptureStep(countedPool, { workerId: `e7-hosted-cap:${plan.approvalRef}`, env, adapterConfig, listings, executors, clock, stripeAccountId: c.accountId, intentId: plan.intentId });
      } catch (e) {
        if (e instanceof Refusal && e.code === "DB_BUDGET") return done(uncertain() ?? "BUDGET_EXHAUSTED", "DB_QUERY_CEILING");
        if (stopped()) return stopOutcome();
        return done(uncertain() ?? "DB_ERROR", "WORKER_THREW");
      }
      for (const a of (w && Array.isArray(w.actions) ? w.actions : [])) if (r.actions.length < 200 && CODE_RE.test(String(a))) r.actions.push(String(a));
      if (w && w.late) await Promise.race([Promise.resolve(w.late).catch(() => {}), sleep(1000)]);
      if (!w || w.status === "refused") return done(uncertain() ?? "WORKER_REFUSED", w && CODE_RE.test(String(w.code)) ? String(w.code) : "WORKER_REFUSED");
      if (r.captureOutcome === "UNKNOWN") { try { finalFacts = await read(); observe(finalFacts); } catch { /* reported below */ } return done("CAPTURE_OUTCOME_UNKNOWN", "LOST_CAPTURE_REPLY"); }
      if (stopped()) return stopOutcome();
      try { f = await read(); } catch (e) { return e instanceof Stopped ? stopOutcome() : done("DB_ERROR", "STEP_READBACK_FAILED"); }
      observe(f);
      if (stopped()) return stopOutcome();
      const stNow = f.intent ? f.intent.status : null;
      if (stNow === "payment_captured") { finalFacts = f; break; }
      if (stNow === "capture_unknown") { finalFacts = f; return done("CAPTURE_OUTCOME_UNKNOWN", "WORKER_SETTLED_UNKNOWN"); }  // reconciliation is the accepted worker's read-only path
      if (stNow === "capture_failed") { finalFacts = f; return done("CAPTURE_FAILED", "WORKER_FAILED_CAPTURE"); }               // cleanup is a SEPARATE reviewed step
      if (stNow !== "reservation_confirmed") { finalFacts = f; return done("CAPTURE_UNKNOWN_STATE", `STATE_${String(stNow).toUpperCase()}`); }
      if (r.captureInvocations > 0) { finalFacts = f; return done("CAPTURE_OUTCOME_UNKNOWN", "SENT_WITHOUT_TRANSITION"); }      // a capture went out but the state did not move: never a second step
      if (step === B.steps) { finalFacts = f; return done("STEP_BUDGET_EXHAUSTED", "STEPS"); }
      const delay = w.status === "worked" && Number.isSafeInteger(w.delayMs) ? Math.min(Math.max(w.delayMs, 0), B.waitCapMs) : Math.min(5000, B.waitCapMs);
      const left = endsAt - mono();
      if (left <= delay) { r.stopReason = "DEADLINE"; stopReason = "DEADLINE"; return stopOutcome(); }
      await sleep(delay);
    }

    // ---- (9) read-only postcheck: output and persisted facts must agree -------------------------------------------------------------------
    observe(finalFacts);
    const pe = checkEnd(finalFacts, plan, c);
    if (pe) return done("POSTCHECK_MISMATCH", pe);
    r.postcheck = { captureOps: 1, capturedMinor: finalFacts.intent.payment.capturedMinor, recordingQueuedPristine: true, claimHeld: true, openCases: 0 };
    if (stopped()) return stopOutcome();
    return done("PAYMENT_CAPTURED_INTERMEDIATE");
  };
  // LABELLED COPY (Slice 1 finally, F3/F5): bounded residual read, provisional success re-validated, checked unlock on the dedicated session
  const TEARDOWN_MS = 5000;
  const bounded = (p) => new Promise((resolve) => { let t = null; const fin = (v) => { clearTimeout(t); resolve(v); };
    t = setTimeout(() => fin({ done: false }), TEARDOWN_MS); Promise.resolve().then(() => p).then((value) => fin({ done: true, value }), () => fin({ done: true, threw: true })); });
  try {
    const out = await body();
    if (out !== DONE) done("DB_ERROR", "INTERNAL");
  } catch (e) {
    if (e instanceof Refusal && e.code === "DB_BUDGET") done(uncertain() ?? "BUDGET_EXHAUSTED", "DB_QUERY_CEILING");
    else done(uncertain() ?? "DB_ERROR", "INTERNAL");
  } finally {
    if ((r.steps > 0 || r.captureInvocations > 0) && input && input.pool && input.tooling) {
      const raw = { query: (sql, params) => input.pool.query(sql, params) };
      const b = await bounded(readFacts(async (sql, params) => (await input.pool.query(sql, params)).rows, input.plan, input.tooling, raw));
      if (b.done && !b.threw) observe(b.value);
      if (r.outcome === "PAYMENT_CAPTURED_INTERMEDIATE") {
        const re = b.done && !b.threw ? checkEnd(b.value, input.plan, CONSTANTS) : "RESIDUAL_READ_UNAVAILABLE";
        if (re) { r.outcome = "NOT_CONFIRMED"; r.code = re === "RESIDUAL_READ_UNAVAILABLE" ? re : `RESIDUAL_${re}`; r.postcheck = null; }
      }
    }
    if (lockClient) {
      let released = false;
      if (lockAcquired && !lockErrored) {
        const u = await bounded(lockClient.query("SELECT pg_advisory_unlock(pg_catalog.hashtext($1), 0) AS ok, pg_catalog.pg_backend_pid() AS pid", [input?.tooling?.LOCK_KEY ?? ""]));
        released = u.done && !u.threw && u.value && u.value.rows && u.value.rows.length === 1 && u.value.rows[0].ok === true && String(u.value.rows[0].pid) === lockPid && !lockErrored;
      }
      if (lockAcquired) r.lock = released ? "released" : (lockErrored ? "session_error_connection_destroyed" : "unlock_failed_connection_destroyed");
      try { lockClient.release(released ? undefined : true); } catch { /* contained */ }
      if (lockAcquired && !released && r.outcome === "PAYMENT_CAPTURED_INTERMEDIATE") { r.outcome = "NOT_CONFIRMED"; r.code = lockErrored ? "LOCK_SESSION_ERROR_AT_TEARDOWN" : "UNLOCK_NOT_PROVEN"; }
    }
    if (r.outcome === "PAYMENT_CAPTURED_INTERMEDIATE" && stopped()) { r.outcome = "NOT_CONFIRMED"; r.code = `STOP_${stopReason}_AT_TEARDOWN`; }
  }
  return snapshot();
}

// =================================================================================================================================
// hosted wrapper (GitHub Actions): preflight (no secrets) / verify / execute (CLOSED until executeEnabled is reviewed true)
// LABELLED COPY of the reviewed Slice 1 runHosted, specialised: capture inputs, capture closure / runner files, HCP_ codes, two pools (6543 / 5432).
export const CLOSURE_DIGEST_PREFIX = "e7-hosted-capture-closure-v1\n";
export const RUNNER_DIGEST_PREFIX = "e7-hosted-capture-runner-v1\n";
const TEST_FILE = "test/e7-hosted-capture.test.mjs";
const SECRET_KEYS = Object.freeze(["E7_STRIPE_TEST_KEY", "E7_HOSTAWAY_TOKEN", "E7_DEV_BOOKING_DATABASE_URL"]);

/** runHosted({ mode, env, proc, wrapperDir, deps }) → { exitCode, result }. Never throws. deps = TEST SEAMS. */
export async function runHosted({ mode = "preflight", env, proc, wrapperDir, deps = {} }) {
  const c = deps.constants ?? CONSTANTS;
  const spawnChild = deps.spawnChild ?? spawnNode;
  const importEnv = deps.importEnv ?? ((dir) => import(pathToFileURL(`${dir}/scripts/e7-connected/probe-env-preflight.mjs`).href));
  const importTooling = deps.importTooling ?? defaultImportTooling;
  const runCore = deps.runCore ?? runCaptureCore;
  const readPgVersion = deps.readPgVersion ?? (async (dir) => JSON.parse(await readFile(`${dir}/node_modules/pg/package.json`, "utf8")).version);
  const readCa = deps.readCa ?? ((p) => readFile(p));
  const r = { schema: "e7-hosted-capture-hosted-v1", mode: null, code: null, workflowSha: null, toolingCommit: c.toolingCommit, toolingStatus: c.toolingStatus,
    executeEnabled: c.executeEnabled, closureDigest: null, runnerDigest: null, planKind: null, planHash: null, envCode: null, tests: null, lockEndpoint: null, core: null };
  let pool = null; let lockPool = null;
  try {
    if (!["preflight", "verify", "execute"].includes(mode)) refuse("HCP_USAGE");
    r.mode = mode;
    r.workflowSha = HEX40.test(env.E7_WORKFLOW_SHA ?? "") ? env.E7_WORKFLOW_SHA : null;
    const has = (k) => typeof env[k] === "string" && env[k].length > 0;
    if (mode !== "execute" && SECRET_KEYS.some(has)) refuse("HCP_SECRET_SCOPE_VIOLATION");
    const ref = env.E7_APPROVAL_REF ?? ""; const iid = env.E7_INTENT_ID ?? ""; const ver = env.E7_EXPECTED_VERSION ?? ""; const nb = env.E7_NOT_BEFORE ?? "";
    const pi = env.E7_PAYMENT_INTENT_ID ?? ""; const rid = env.E7_RESERVATION_ID ?? ""; const amt = env.E7_AMOUNT_MINOR ?? "";
    const expPlan = env.E7_EXPECTED_PLAN_HASH ?? ""; const expClo = env.E7_EXPECTED_CLOSURE_DIGEST ?? ""; const expRun = env.E7_EXPECTED_RUNNER_DIGEST ?? "";
    const vals = [ref, iid, ver, nb, pi, rid, amt]; const anyReal = vals.some((v) => v !== "");
    if (anyReal && vals.some((v) => v === "")) refuse("HCP_INPUT_INCOMPLETE");
    if (anyReal && (!APPROVAL_RE.test(ref) || !UUID_RE.test(iid) || !/^[1-9][0-9]{0,6}$/.test(ver) || isoMs(nb) === null || !PI_RE.test(pi) || !RID_RE.test(rid) || !/^[1-9][0-9]{0,7}$/.test(amt))) refuse("HCP_INPUT_INVALID");
    if (ref === c.synthetic.approvalRef || iid === c.synthetic.intentId) refuse("HCP_INPUT_INVALID");
    if (mode !== "preflight") {
      if (c.executeEnabled !== true || c.toolingStatus !== "MERGED" || !HEX64.test(String(c.closureDigest))) refuse("HCP_EXECUTE_CLOSED");   // Slice 2: CLOSED
      if (!anyReal || !HEX64.test(expPlan) || !HEX64.test(expClo) || !HEX64.test(expRun)) refuse("HCP_INPUT_INCOMPLETE");
      if (env.GITHUB_REF !== "refs/heads/main") refuse("HCP_REF_NOT_MAIN");
      if (expClo !== c.closureDigest) refuse("HCP_SOURCE_MISMATCH");
    }
    const tooling = await realpath(env.E7_TOOLING_DIR ?? "").catch(() => refuse("HCP_LAYOUT_INVALID"));
    const wdir = await realpath(wrapperDir).catch(() => refuse("HCP_LAYOUT_INVALID"));
    if (tooling === wdir || tooling.startsWith(`${wdir}/`) || wdir.startsWith(`${tooling}/`)) refuse("HCP_LAYOUT_INVALID");
    r.closureDigest = await framedDigest(tooling, c.closure, CLOSURE_DIGEST_PREFIX).catch((e) => refuse(e && e.code === "HRS_SOURCE_UNREADABLE" ? "HCP_SOURCE_UNREADABLE" : "HCP_SOURCE_UNREADABLE"));
    if (r.closureDigest !== c.closureDigest) refuse("HCP_SOURCE_MISMATCH");
    r.runnerDigest = await framedDigest(wdir, c.runnerFiles, RUNNER_DIGEST_PREFIX).catch(() => refuse("HCP_SOURCE_UNREADABLE"));
    if (mode !== "preflight" && r.runnerDigest !== expRun) refuse("HCP_RUNNER_MISMATCH");
    r.planKind = anyReal ? "REAL" : "SYNTHETIC";
    const s = c.synthetic;
    const built = buildPlan(c, anyReal ? { approvalRef: ref, intentId: iid, expectedVersion: Number(ver), notBefore: nb, paymentIntentId: pi, reservationId: rid, amountMinor: Number(amt), runnerDigest: r.runnerDigest }
      : { approvalRef: s.approvalRef, intentId: s.intentId, expectedVersion: s.expectedVersion, notBefore: s.notBefore, paymentIntentId: s.paymentIntentId, reservationId: s.reservationId, amountMinor: s.amountMinor, runnerDigest: r.runnerDigest });
    r.planHash = built.planHash;
    if (mode !== "preflight" && built.planHash !== expPlan) refuse("HCP_PLAN_HASH_MISMATCH");
    let C1; try { C1 = await importEnv(tooling); } catch { refuse("HCP_IMPORT_FAILED"); }
    const present = Object.fromEntries(C1.PRESENT_KEYS.map((k) => [k, Object.hasOwn(env, k)]));
    let uid = null; try { if (typeof proc.getuid === "function") { const u = proc.getuid(); if (Number.isSafeInteger(u) && u >= 0) uid = u; } } catch { uid = null; }
    const ev = C1.evaluateProbeEnvironment({ schema: C1.ENV_SNAPSHOT_SCHEMA, nodeVersion: String(proc.versions.node), platform: proc.platform,
      execArgvCount: proc.execArgv.length, uidAvailable: uid !== null, present });
    r.envCode = typeof ev.code === "string" && C1.ENV_CODES.includes(ev.code) ? ev.code : "REDACTED";
    if (ev.ok !== true || proc.versions.node !== c.nodeVersion) refuse("HCP_ENV_REFUSED");
    if (mode === "preflight") {
      const o = await spawnChild(["--test", "--test-reporter=tap", TEST_FILE], { cwd: wdir, env: childEnv(env, tooling) });
      if (!o || o.spawnFailed || (o.signal !== null && o.signal !== undefined) || !Number.isSafeInteger(o.status) || o.truncated) refuse("HCP_CHILD_FAILED");
      const num = (re) => { const m = re.exec(o.stdout); return m ? Number(m[1]) : null; };
      r.tests = { status: o.status, tests: num(/^# tests (\d+)$/m), pass: num(/^# pass (\d+)$/m), fail: num(/^# fail (\d+)$/m), connectivityEvidence: false };
      if (o.status !== 0 || !(r.tests.tests > 0) || r.tests.pass !== r.tests.tests || r.tests.fail !== 0) refuse("HCP_TESTS_FAILED");
      r.code = anyReal ? "PREFLIGHT_OK_REAL_PLAN" : "PREFLIGHT_OK_SYNTHETIC_ONLY"; return { exitCode: 0, result: r };
    }
    if (mode === "verify") { r.code = "VERIFY_OK"; return { exitCode: 0, result: r }; }
    if (!SECRET_KEYS.every(has)) refuse("HCP_CREDENTIALS_MISSING");
    let pgv; try { pgv = await readPgVersion(tooling); } catch { pgv = null; }
    if (pgv !== c.pgVersion) refuse("HCP_DEPENDENCY_MISMATCH");
    let skey = env.E7_STRIPE_TEST_KEY; delete env.E7_STRIPE_TEST_KEY;
    let htok = env.E7_HOSTAWAY_TOKEN; delete env.E7_HOSTAWAY_TOKEN;
    let dbUrl = env.E7_DEV_BOOKING_DATABASE_URL; delete env.E7_DEV_BOOKING_DATABASE_URL;
    const wipe = () => { skey = null; htok = null; dbUrl = null; };
    if (!dbTargetOk(dbUrl, c)) { wipe(); refuse("HCP_DB_TARGET_INVALID"); }
    let caPem = null;
    try { const b = await readCa(env.E7_CA_FILE ?? ""); if (sha(b) === (deps.caSha256 ?? OFFICIAL_CA_SHA256) && b.length < 16384) caPem = b.toString("utf8"); } catch { caPem = null; }
    if (caPem === null) { wipe(); refuse("HCP_CA_INVALID"); }
    let mods; try { mods = await importTooling(tooling); } catch { wipe(); refuse("HCP_IMPORT_FAILED"); }
    const xs = mods.X.createE7RealExchange({ provider: "stripe" }); const xh = mods.X.createE7RealExchange({ provider: "hostaway" });
    if (!xs || xs.ok !== true || !xh || xh.ok !== true) { wipe(); refuse("HCP_IMPORT_FAILED"); }
    let lockUrl = sessionLockUrl(dbUrl, c);
    if (lockUrl === null) { wipe(); refuse("HCP_DB_TARGET_INVALID"); }
    try {
      pool = mods.createBookingPool({ connectionString: dbUrl, caPem, max: 3 });                      // worker pool: transaction pooler (6543)
      lockPool = mods.createBookingPool({ connectionString: lockUrl, caPem, max: 1 });                // dedicated SESSION lock connection (5432)
    } catch { wipe(); refuse("HCP_DB_TARGET_INVALID"); } finally { dbUrl = null; lockUrl = null; }
    r.lockEndpoint = `session:${SESSION_LOCK_PORT}`;
    const ac = new AbortController(); const onSig = () => ac.abort(); proc.once?.("SIGINT", onSig); proc.once?.("SIGTERM", onSig);
    try {
      r.core = await runCore({ plan: built.plan, pool, lockClientFactory: () => lockPool.connect(), tooling: mods.tooling, exchanges: { stripe: xs.exchange, hostaway: xh.exchange },
        credentials: { stripe: () => skey, hostaway: () => htok }, runSignal: ac.signal });
    } finally { wipe(); proc.off?.("SIGINT", onSig); proc.off?.("SIGTERM", onSig); }
    r.code = "EXECUTE_DONE";
    return { exitCode: r.core && r.core.outcome === "PAYMENT_CAPTURED_INTERMEDIATE" ? 0 : 1, result: r };
  } catch (e) {
    r.code = e instanceof Refusal && HOSTED_CODES.includes(e.code) ? e.code : "HCP_INTERNAL";
    return { exitCode: 1, result: r };
  } finally {
    if (lockPool) await lockPool.end().catch(() => {});
    if (pool) await pool.end().catch(() => {});
  }
}
async function defaultImportTooling(dir) {
  const u = (p) => pathToFileURL(`${dir}/${p}`).href;
  const [W, R, EA, T, X, P, HR, CP, IS, LK] = await Promise.all([import(u("lib/booking-db/capture-worker.js")), import(u("lib/booking-db/repo.js")),
    import(u("scripts/e7-connected/executor-adapters.mjs")), import(u("scripts/e7-connected/http-transports.mjs")), import(u("scripts/e7-connected/real-exchange.mjs")),
    import(u("lib/booking-db/pool.js")), import(u("lib/hostaway-reservations.js")), import(u("lib/checkout/capture-proof.js")), import(u("lib/checkout/intent-state.js")),
    import(u("scripts/e7-connected/run-lock-precheck.mjs"))]);
  return { X, createBookingPool: P.createBookingPool,
    tooling: { runCaptureStep: W.runCaptureStep, loadIntent: R.loadIntent, createPhaseExecutors: EA.createPhaseExecutors, createStripeSend: T.createE7StripeTestSend,
      createHostawaySend: T.createE7HostawaySend, validateAdapterConfig: HR.validateAdapterConfig, paymentIntentProofObservationV3: CP.paymentIntentProofObservationV3,
      stillAuthorizedV3Refusal: CP.stillAuthorizedV3Refusal, captureKey: IS.captureKey, LOCK_KEY: LK.LOCK_KEY, LOCK_PRECHECK_SQL: LK.LOCK_PRECHECK_SQL } };
}
export function summaryMarkdown(r) {
  const core = r.core ? ` core=${r.core.outcome}${r.core.code ? `/${r.core.code}` : ""} steps=${r.core.steps} capture=${r.core.captureInvocations}/${r.core.captureOutcome} lock=${r.core.lock} recordingQueuedPristine=${r.core.recordingQueuedPristine}` : "";
  return `e7-hosted-capture ${r.mode} ${r.code} executeEnabled=${r.executeEnabled} lock=${r.lockEndpoint ?? "-"} plan=${r.planKind ?? "-"}:${r.planHash ?? "-"} closure=${r.closureDigest ?? "-"} runner=${r.runnerDigest ?? "-"}${core}\n`;
}

// ---- the ONLY top-level effect -----------------------------------------------------------------------------------------------------
if (import.meta.main === true) {
  const mode = process.argv[2];
  const wrapperDir = fileURLToPath(new URL("../", import.meta.url));
  runHosted({ mode, env: process.env, proc: process, wrapperDir }).then(({ exitCode, result }) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (typeof process.env.GITHUB_STEP_SUMMARY === "string" && process.env.GITHUB_STEP_SUMMARY.length > 0) {
      import("node:fs/promises").then((fs) => fs.appendFile(process.env.GITHUB_STEP_SUMMARY, summaryMarkdown(result))).catch(() => {}).finally(() => process.exit(exitCode));
    } else process.exit(exitCode);
  }).catch(() => process.exit(1));
}
