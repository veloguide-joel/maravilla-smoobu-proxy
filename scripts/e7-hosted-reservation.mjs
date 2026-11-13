// scripts/e7-hosted-reservation.mjs — E7 Slice 1: HOSTED (GitHub Actions) TEST reservation processing for ONE admitted TEST intent:
// payment_authorized → (accepted reservation worker) → reservation_confirmed, on the TEST DEV database, with FAKE-free real transports.
//
// HONEST LABEL: this is MANUAL hosted TEST processing (workflow_dispatch + the existing reviewer gate), NOT automatic customer checkout.
// `reservation_confirmed` is an INTERMEDIATE state: nothing is captured, recorded or notified by this runner; a capture row may be
// QUEUED PRISTINE by the accepted state machine and is reported, never dispatched. Code is NOT consent; executeEnabled is CLOSED here.
//   * Inert on import (`import.meta.main` guard): no env / fs / network / DB / timer until a mode runs.
//   * Reuses the accepted lineage at ONE fixed tooling commit (checked out separately): runOrchestratorStep (E7.2 + PR56), createPhaseExecutors
//     ('reservation' | 'reservation-recovery'), createE7HostawaySend / createE7StripeTestSend / createE7RealExchange, pool, repo.loadIntent,
//     validateAdapterConfig, the accepted v3 PI proof (stillAuthorizedV3Refusal), LOCK_KEY + LOCK_PRECHECK_SQL. Its full transitive closure
//     (+ package.json / lock) is digest-verified BEFORE any tooling import.
//   * Exact pins (plan hash): approval label, intent UUID, expected version, not-before (never a historic intent), admission kind, bound
//     reservation id (pending admission only); fixed listing 606998 / USD / ref field / Stripe TEST account / Stripe-Version / DEV project ref.
//   * Admission: `authorized` = payment_authorized with NO previous create dispatch (no create op row, no Hostaway attempt, no lease /
//     dispatch); `pending` = reservation_pending READ / RECONCILE ONLY for a specifically proven succeeded create whose result_ref is the
//     pinned id (recovery factory: a second create is impossible by construction). dispatched / outcome_unknown / anything else refuses.
//   * Order: read-only start check → P3 session lock (own exact proof; checked before every step; unlock checked on teardown) → DB identity
//     → account + fresh STRICT still-authorized Stripe proof → bounded worker steps behind a target-only transport fence (≤ 1 Hostaway create,
//     GET-only otherwise; zero Stripe writes) → read-only postcheck (output and persisted facts must agree).
//   * STOP on: refusal, 401 / 403, deadline, lock loss, identity mismatch, lost create reply (CREATE_OUTCOME_UNKNOWN; never a second send),
//     budget, cancellation. The first signal stops new steps / transports; persisted effects are reported, never hidden. No retry / rerun.
//   * Never: capture, refund, record, notify, cancel, void, queue draining, historical intents, any action on protected reservation ids.
import process from "node:process";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

export const CONSTANTS = Object.freeze({
  // the MERGED e7-test integration head (PR58–63; tree 004316db) — immutable tooling for this runner
  toolingCommit: "40779e34e8c65ac5c4494bc5a18cd4223ef723fa",
  toolingStatus: "MERGED",
  executeEnabled: true,                                    // Slice 1: execution OPENED for the ONE reviewed owner-present hosted TEST (ROOT prep GO 2026-11-13); revert to false after
  closure: Object.freeze(["package.json", "package-lock.json", "lib/bookability.js", "lib/booking-db/codec.js", "lib/booking-db/config.js",
    "lib/booking-db/operations.js", "lib/booking-db/pool.js", "lib/booking-db/recovery.js", "lib/booking-db/repo.js",
    "lib/booking-db/reservation-worker.js", "lib/checkout/capture-proof.js", "lib/checkout/compensation-proof.js", "lib/checkout/final-price.js",
    "lib/checkout/intent-state.js", "lib/checkout/offline-charge-proof.js", "lib/checkout/recovery-plan.js", "lib/checkout/server-pricer.js",
    "lib/direct-policy.js", "lib/direct-pricing.js", "lib/hostaway-calendar.js", "lib/hostaway-reservations.js", "lib/hostaway.js",
    "lib/public-api.js", "lib/quote-public.js", "scripts/e7-connected/executor-adapters.mjs", "scripts/e7-connected/http-transports.mjs",
    "scripts/e7-connected/probe-env-preflight.mjs", "scripts/e7-connected/real-exchange.mjs", "scripts/e7-connected/run-lock-precheck.mjs"]),
  // framed SHA-256 of `closure` at 40779e34 (test C2 recomputes it from an INDEPENDENT import scan + the pinned tree)
  closureDigest: "0ffc0b9c84fc83ca8de663ea0a88f90b1fa40bfba1a65498e311309b3ac4b631",
  pgVersion: "8.18.0",
  runnerFiles: Object.freeze(["scripts/e7-hosted-reservation.mjs", ".github/workflows/e7-hosted-reservation.yml", "test/e7-hosted-reservation.test.mjs"]),
  accountId: "acct_1TyHE42B9LTneQgw",
  listingId: 606998, currency: "USD", refFieldId: 105433, listingTimeZone: "America/Mexico_City",
  stripeVersion: "2026-01-28.clover",
  protectedReservationIds: Object.freeze(["70636076", "71045356", "71072615", "71081885"]),
  // worker: ≤ 12 steps (PHASE_LIMITS.reservation), 30 s reschedule waits, 15-min phase budget; provider reads bounded per step.
  // dbQueries = EVERY statement on the counted pool (runner reads + worker + lock session). Measured on disposable PG16 with the REAL worker (test I1):
  // 118 (ref echoed, 2 steps) / 248 (ref not echoed, 6 steps); ceiling ≈ 2.4x the larger. Fail-closed past it.
  budgets: Object.freeze({ steps: 12, create: 1, pricingCalls: 36, hostawayReads: 36, lookupPages: 24, accountReads: 2, piReads: 2, exchanges: 120, dbQueries: 600,
    runMs: 15 * 60 * 1000, waitCapMs: 35 * 1000 }),
  dbEnvironment: "test", dbProjectRef: "mxotevtiscernhqilyiu",
  nodeVersion: "22.22.0",
  synthetic: Object.freeze({ approvalRef: "SYNTHETIC-preflight-not-for-execute", intentId: "00000000-0000-4000-8000-000000000000", expectedVersion: 4,
    notBefore: "2026-11-12T00:00:00.000Z", admission: "authorized", reservationId: "" })
});
export const PLAN_SCHEMA = "e7-hosted-reservation-plan-v1";
export const RESULT_SCHEMA = "e7-hosted-reservation-result-v1";
export const ADMISSIONS = Object.freeze(["authorized", "pending"]);
export const OUTCOMES = Object.freeze(["RESERVATION_CONFIRMED_INTERMEDIATE", "SCOPE_REFUSED", "START_STATE_NOT_ELIGIBLE", "LOCK_NOT_ACQUIRED", "LOCK_LOST",
  "DB_IDENTITY_MISMATCH", "PROVIDER_PROOF_FAILED", "WORKER_REFUSED", "RESERVATION_FAILED", "RESERVATION_UNKNOWN", "CREATE_OUTCOME_UNKNOWN", "STEP_BUDGET_EXHAUSTED",
  "BUDGET_EXHAUSTED", "DEADLINE", "ABORTED", "DB_ERROR", "POSTCHECK_MISMATCH", "NOT_CONFIRMED", "CORE_INVALID"]);
export const HOSTED_CODES = Object.freeze(["HRS_USAGE", "HRS_SECRET_SCOPE_VIOLATION", "HRS_INPUT_INVALID", "HRS_INPUT_INCOMPLETE", "HRS_REF_NOT_MAIN",
  "HRS_EXECUTE_CLOSED", "HRS_LAYOUT_INVALID", "HRS_SOURCE_UNREADABLE", "HRS_SOURCE_MISMATCH", "HRS_RUNNER_MISMATCH", "HRS_PLAN_HASH_MISMATCH",
  "HRS_DEPENDENCY_MISMATCH", "HRS_ENV_REFUSED", "HRS_TESTS_FAILED", "HRS_CHILD_FAILED", "HRS_IMPORT_FAILED", "HRS_CREDENTIALS_MISSING",
  "HRS_DB_TARGET_INVALID", "HRS_CA_INVALID", "HRS_INTERNAL", "PREFLIGHT_OK_REAL_PLAN", "PREFLIGHT_OK_SYNTHETIC_ONLY", "VERIFY_OK", "EXECUTE_DONE"]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RID_RE = /^[1-9][0-9]{0,15}$/;
const APPROVAL_RE = /^[A-Za-z0-9._:-]{1,80}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const HEX64 = /^[0-9a-f]{64}$/; const HEX40 = /^[0-9a-f]{40}$/;
const CODE_RE = /^[A-Za-z0-9_:>!.-]{1,80}$/;
const STRIPE = "https://api.stripe.com"; const HOSTAWAY = "https://api.hostaway.com";
const MAX_FILE = 1048576; const MAX_TOTAL = 6291456;
const freeze = Object.freeze;
class Refusal extends Error { constructor(code) { super("e7-hosted-reservation"); this.code = code; } }
const refuse = (code) => { throw new Refusal(code); };
const sha = (s) => createHash("sha256").update(s).digest("hex");
function deepFreeze(v) { if (v && typeof v === "object") { for (const k of Object.keys(v)) deepFreeze(v[k]); freeze(v); } return v; }
export function canonical(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
}
const isVersion = (v) => Number.isSafeInteger(v) && v >= 1 && v <= 1000000;
const isoMs = (s) => (typeof s === "string" && ISO_RE.test(s) && Number.isFinite(Date.parse(s)) && new Date(Date.parse(s)).toISOString() === (s.length === 20 ? `${s.slice(0, 19)}.000Z` : s) ? Date.parse(s) : null);

// =================================================================================================================================
// plan (pure)
/** buildPlan(c, { approvalRef, intentId, expectedVersion, notBefore, admission, reservationId, runnerDigest }) → frozen { plan, planHash } */
export function buildPlan(c, { approvalRef, intentId, expectedVersion, notBefore, admission, reservationId, runnerDigest }) {
  if (typeof approvalRef !== "string" || !APPROVAL_RE.test(approvalRef)) refuse("HRS_INPUT_INVALID");
  if (typeof intentId !== "string" || !UUID_RE.test(intentId) || !isVersion(expectedVersion)) refuse("HRS_INPUT_INVALID");
  if (isoMs(notBefore) === null) refuse("HRS_INPUT_INVALID");
  if (!ADMISSIONS.includes(admission)) refuse("HRS_INPUT_INVALID");
  if (admission === "authorized" && reservationId !== "") refuse("HRS_INPUT_INVALID");
  if (admission === "pending" && (typeof reservationId !== "string" || !RID_RE.test(reservationId) || c.protectedReservationIds.includes(reservationId))) refuse("HRS_INPUT_INVALID");
  if (typeof runnerDigest !== "string" || !HEX64.test(runnerDigest)) refuse("HRS_INPUT_INVALID");
  if (c.accountId !== "acct_1TyHE42B9LTneQgw" || c.listingId !== 606998 || c.currency !== "USD" || c.stripeVersion !== "2026-01-28.clover" || c.dbEnvironment !== "test"
      || c.budgets.create !== 1 || c.budgets.steps !== 12) refuse("HRS_INPUT_INVALID");                                                       // code ceiling
  const plan = { schema: PLAN_SCHEMA, toolingCommit: c.toolingCommit, toolingStatus: c.toolingStatus, closureDigest: c.closureDigest, runnerDigest,
    pgVersion: c.pgVersion, stripeVersion: c.stripeVersion, accountId: c.accountId, listingId: c.listingId, currency: c.currency, refFieldId: c.refFieldId,
    dbEnvironment: c.dbEnvironment, dbProjectRef: c.dbProjectRef, intentId, expectedVersion, notBefore, admission, reservationId: admission === "pending" ? reservationId : null,
    approvalRef, budgets: { ...c.budgets },
    operations: ["db.reservation_worker_steps<=12", "hostaway.get_listing(606998)", "hostaway.get_calendar(606998,stay)", "hostaway.post_price_details(606998,stay)",
      "hostaway.lookup_by_ref(606998,arrival)", "hostaway.get_reservation(id)", admission === "authorized" ? "hostaway.create_reservation<=1" : "hostaway.create_reservation=0",
      "stripe.accounts.retrieve", "stripe.paymentIntents.retrieve(pi)"],
    writes: { hostawayCreateMax: admission === "authorized" ? 1 : 0, capture: 0, refund: 0, record: 0, notify: 0, cancel: 0, void: 0, account: 0, keys: 0 } };
  return freeze({ plan: deepFreeze(plan), planHash: sha(canonical(plan)) });
}

// =================================================================================================================================
// DB reads (read-only SELECTs through the runtime login; no transaction held across a provider call)
const Q = freeze({
  instance: "/*e7hrs:instance*/ SELECT environment FROM booking.instance",
  attempts: "/*e7hrs:attempts*/ SELECT id::text AS id, status, checkout_session_id, payment_intent_id, livemode FROM booking.payment_attempts WHERE intent_id = $1 ORDER BY attempt",
  hostaway: "/*e7hrs:hostaway*/ SELECT state, hostaway_reservation_id::text AS rid FROM booking.hostaway_reservation_attempts WHERE intent_id = $1",
  ops: "/*e7hrs:ops*/ SELECT op_type, state, attempts, (dispatched_at IS NOT NULL) AS dispatched, result_ref, late_result_ref, payload ->> 'reservationId' AS payload_rid FROM booking.external_operations WHERE intent_id = $1 ORDER BY created_at, id",
  cases: "/*e7hrs:cases*/ SELECT count(*)::int AS n FROM booking.reconciliation_cases WHERE intent_id = $1 AND status = 'open'",
  claims: "/*e7hrs:claims*/ SELECT listing_id, (released_at IS NOT NULL) AS released FROM booking.inventory_claims WHERE intent_id = $1",
  // LABELLED COPY of scripts/e7-connected/run-facts.mjs SQL.GUEST (role marker + guest row; app role required)
  guest: `/*e7hrs:guest*/ SELECT g.first_name, g.last_name, g.email,
      pg_has_role(current_user, 'mv_booking_app', 'MEMBER') AS is_app,
      pg_has_role(current_user, 'mv_booking_report', 'MEMBER') AS is_report,
      (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) AS privileged
    FROM (SELECT 1) one LEFT JOIN booking.intent_guests g ON g.intent_id = $1`,
  identity: "/*e7hrs:identity*/ SELECT current_database() AS db, (SELECT environment FROM booking.instance) AS environment"
});
export const QUERIES = Q;
const AUTH_OPS = freeze(["stripe.create_checkout_session", "stripe.retrieve_checkout_session", "stripe.retrieve_payment_intent"]);
const PENDING_OPS = freeze([...AUTH_OPS, "hostaway.create_reservation", "hostaway.lookup_reservation", "hostaway.retrieve_reservation"]);
const AFTER_OPS = freeze([...PENDING_OPS, "stripe.capture_payment_intent"]);
const FORBIDDEN_OPS = freeze(["stripe.void_payment_intent", "hostaway.cancel_reservation", "hostaway.record_offline_charge", "guest.notify", "alert.owner", "stripe.refund"]);
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
/** checkStart(f, plan, c) → { ok, intent, attemptId } | { ok:false, code } — read-only admission (the worker's in-tx guards stay authoritative) */
export function checkStart(f, plan, c = CONSTANTS) {
  const no = (code) => freeze({ ok: false, code });
  if (f.instance !== c.dbEnvironment) return no("DATABASE_NOT_TEST");
  const i = f.intent;
  if (!i) return no("INTENT_NOT_FOUND");
  if (i.listingId !== c.listingId) return no("LISTING_NOT_SCOPED");
  if (!i.price || i.price.currency !== c.currency || !Number.isSafeInteger(i.price.finalTotalMinor) || i.price.finalTotalMinor <= 0) return no("PRICE_NOT_SCOPED");
  if (!Number.isSafeInteger(i.createdAt) || i.createdAt < isoMs(plan.notBefore)) return no("HISTORIC_INTENT");
  if (i.version !== plan.expectedVersion) return no("VERSION_NOT_PINNED");
  if (!i.payment || typeof i.payment.paymentIntentId !== "string" || i.payment.livemode !== false) return no("PAYMENT_NOT_TEST_AUTHORIZED");
  if (i.payment.amountMinor !== i.price.finalTotalMinor || String(i.payment.currency || "").toUpperCase() !== c.currency) return no("AUTHORIZED_AMOUNT_NOT_PRICE");
  if (i.payment.capturedMinor !== 0) return no("ALREADY_CAPTURED");
  if (f.openCases !== 0) return no("OPEN_CASE");
  const att = f.attempts;
  if (att.length !== 1 || att[0].status !== "completed" || att[0].livemode !== false || att[0].payment_intent_id !== i.payment.paymentIntentId) return no("PAYMENT_ATTEMPT_NOT_SINGLE_COMPLETED");
  if (f.claims.length !== 1 || f.claims[0].listing_id !== c.listingId || f.claims[0].released !== false) return no("CLAIM_NOT_HELD");
  for (const o of f.ops) if (FORBIDDEN_OPS.includes(o.op_type)) return no("FORBIDDEN_OP_PRESENT");
  for (const o of f.ops) if (o.op_type === "stripe.capture_payment_intent" && !pristine(o)) return no("CAPTURE_NOT_PRISTINE");
  if (i.reservation && i.reservation.reservationId !== null && i.reservation.reservationId !== undefined && c.protectedReservationIds.includes(String(i.reservation.reservationId))) return no("PROTECTED_REFERENCE");
  for (const h of f.hostaway) if (h.rid !== null && c.protectedReservationIds.includes(String(h.rid))) return no("PROTECTED_REFERENCE");
  const creates = f.ops.filter((o) => o.op_type === "hostaway.create_reservation");
  if (plan.admission === "authorized") {
    if (i.status !== "payment_authorized") return no("STATE_NOT_PAYMENT_AUTHORIZED");
    if (creates.length !== 0 || f.hostaway.length !== 0 || i.lease || i.dispatch) return no("PREVIOUS_DISPATCH_PRESENT");       // admission must PROVE no previous dispatch
    for (const o of f.ops) if (!AUTH_OPS.includes(o.op_type) || o.state !== "succeeded") return no("UNEXPECTED_OP");
  } else {
    if (i.status !== "reservation_pending") return no("STATE_NOT_RESERVATION_PENDING");
    if (creates.length !== 1 || creates[0].state !== "succeeded" || creates[0].dispatched !== true || String(creates[0].result_ref ?? "") !== plan.reservationId) return no("CREATE_NOT_PROVEN_SUCCEEDED");
    for (const o of f.ops) if (!PENDING_OPS.includes(o.op_type)) return no("UNEXPECTED_OP");
    for (const h of f.hostaway) if (h.rid !== null && String(h.rid) !== plan.reservationId) return no("RESERVATION_ID_CONFLICT");
  }
  return freeze({ ok: true, intent: i, attemptId: att[0].id });
}
/**
 * candidateOf(f, plan, c) → { ok:true, id:string|null } | { ok:false, code } — the CONSERVATIVE per-step binding id (mirrors the accepted
 * run-facts derivation over this runner's own app-role facts): the adopted id, else the ONE succeeded create's result_ref; any other known id
 * (late result, attempt row, retrieve selector) must agree; a known id without a candidate, a conflict or a protected id STOPS. A null id keeps
 * the creation factory (which never retrieves by id); a non-null id binds the recovery factory (which never creates).
 */
export function candidateOf(f, plan, c = CONSTANTS) {
  const no = (code) => freeze({ ok: false, code });
  const i = f.intent; const known = new Set(); const cands = new Set();
  const seen = (v) => { if (v !== null && v !== undefined && c.protectedReservationIds.includes(String(v))) throw new Refusal("PROTECTED_REFERENCE"); return v === null || v === undefined ? null : String(v); };
  try {
    const adopted = i && i.reservation ? seen(i.reservation.reservationId) : null;
    if (adopted) { cands.add(adopted); known.add(adopted); }
    const creates = f.ops.filter((o) => o.op_type === "hostaway.create_reservation");
    if (creates.length > 1) return no("FACTS_INCONSISTENT");
    for (const o of f.ops) { seen(o.result_ref); seen(o.late_result_ref); seen(o.payload_rid); }
    for (const o of creates) { const rr = seen(o.result_ref); const lr = seen(o.late_result_ref); if (rr) { known.add(rr); if (o.state === "succeeded") cands.add(rr); } if (lr) known.add(lr); }
    for (const h of f.hostaway) { const hid = seen(h.rid); if (hid) known.add(hid); }
    for (const o of f.ops) if (o.op_type === "hostaway.retrieve_reservation") { const sid = seen(o.payload_rid); if (!sid) return no("FACTS_INCONSISTENT"); known.add(sid); }
  } catch (e) { return no(e instanceof Refusal ? e.code : "FACT_MALFORMED"); }
  if (cands.size > 1) return no("CANDIDATE_CONFLICT");
  const id = cands.size === 1 ? [...cands][0] : null;
  if (id === null && known.size > 0) return no("KNOWN_ID_WITHOUT_CANDIDATE");
  for (const k of known) if (k !== id) return no("RESERVATION_ID_CONFLICT");
  if (plan.admission === "pending" && id !== plan.reservationId) return no("RESERVATION_ID_CONFLICT");
  return freeze({ ok: true, id });
}
/** checkEnd(f, plan, c) → null | code — the persisted facts a confirmed outcome must show (anything else = POSTCHECK_MISMATCH) */
export function checkEnd(f, plan, c = CONSTANTS) {
  const i = f.intent;
  if (!i || i.status !== "reservation_confirmed") return "STATE_NOT_CONFIRMED";
  if (!i.reservation || !RID_RE.test(String(i.reservation.reservationId)) || c.protectedReservationIds.includes(String(i.reservation.reservationId))) return "RESERVATION_ID_INVALID";
  if (plan.admission === "pending" && String(i.reservation.reservationId) !== plan.reservationId) return "RESERVATION_ID_CONFLICT";
  if (i.payment.capturedMinor !== 0) return "CAPTURED";
  const creates = f.ops.filter((o) => o.op_type === "hostaway.create_reservation");
  if (creates.length !== 1 || creates[0].state !== "succeeded") return "CREATE_OP_NOT_SINGLE_SUCCEEDED";
  for (const o of f.ops) if (!AFTER_OPS.includes(o.op_type)) return "UNEXPECTED_OP";
  const caps = f.ops.filter((o) => o.op_type === "stripe.capture_payment_intent");
  if (caps.length > 1 || (caps.length === 1 && !pristine(caps[0]))) return "CAPTURE_NOT_PRISTINE";
  if (f.claims.length !== 1 || f.claims[0].released !== false) return "CLAIM_NOT_HELD";
  if (f.openCases !== 0) return "OPEN_CASE";
  return null;
}

// =================================================================================================================================
/**
 * runReservationCore({ plan, pool, lockClientFactory, tooling, exchanges, credentials, clock, monotonic, sleep, runSignal }) → frozen result.
 *  tooling = { runOrchestratorStep, loadIntent, createPhaseExecutors, createStripeSend, createHostawaySend, validateAdapterConfig,
 *              paymentIntentProofObservationV3, stillAuthorizedV3Refusal, LOCK_KEY, LOCK_PRECHECK_SQL }
 *  lockClientFactory() → a dedicated checked-out client (query / release / on) for the session lock (pool.connect by default).
 */
export async function runReservationCore(input) {
  const c = CONSTANTS; const B = c.budgets;
  const r = { schema: RESULT_SCHEMA, outcome: null, code: null, admission: null, startState: null, finalState: null, finalVersion: null, reservationId: null, steps: 0, actions: [],
    exchanges: 0, pricingCalls: 0, hostawayReads: 0, lookupPages: 0, accountReads: 0, piReads: 0, dbQueries: 0, dbBudgetRefused: 0, createInvocations: 0, createOutcome: "NONE",
    refusedAtTransport: 0, refusedByStop: 0, lock: "not_acquired", lockSession: null, lockBackendPid: null, proofs: [], postcheck: null, captureQueuedPristine: null, createOps: null,
    factsObserved: false, stopReason: null,
    stripeVersion: c.stripeVersion, writes: { create: 0, capture: 0, refund: 0, record: 0, notify: 0, cancel: 0, void: 0 } };
  const DONE = Symbol("done");
  const done = (outcome, code = null) => { r.outcome = outcome; r.code = code; return DONE; };
  const snapshot = () => freeze(JSON.parse(JSON.stringify(r)));
  let stopReason = null; let runSignalRef = null; let monoRef = null; let endsAtRef = Infinity;
  let lockClient = null; let lockAcquired = false; let lockErrored = false; let lockPid = null;
  /** the GLOBAL stop latch: run abort, the fixed wall deadline, or an observed lock-session error (F2) — checked by every gate / transport */
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
  const uncertain = () => (r.createOutcome === "UNKNOWN" ? "CREATE_OUTCOME_UNKNOWN" : null);
  const stopOutcome = () => done(uncertain() ?? (stopReason === "LOCK_SESSION_ERROR" ? "LOCK_LOST" : stopReason), `STOP_${stopReason}`);
  /** best available OBSERVED facts (F3): recorded on every exit that has them; `factsObserved` distinguishes unobserved from absent */
  const observe = (f) => {
    if (!f || !f.intent) return;
    r.factsObserved = true; r.finalState = f.intent.status; r.finalVersion = f.intent.version;
    r.reservationId = f.intent.reservation && f.intent.reservation.reservationId !== null && f.intent.reservation.reservationId !== undefined ? String(f.intent.reservation.reservationId) : null;
    const caps = f.ops.filter((o) => o.op_type === "stripe.capture_payment_intent");
    r.captureQueuedPristine = caps.length === 0 ? null : caps.length === 1 && pristine(caps[0]);
    r.createOps = f.ops.filter((o) => o.op_type === "hostaway.create_reservation").map((o) => o.state);
  };
  const body = async () => {
    const { plan, pool, tooling, exchanges, credentials } = input ?? {};
    if (!plan || plan.schema !== PLAN_SCHEMA || plan.accountId !== c.accountId || plan.listingId !== c.listingId || plan.stripeVersion !== c.stripeVersion
        || !UUID_RE.test(String(plan.intentId)) || !isVersion(plan.expectedVersion) || isoMs(plan.notBefore) === null || !ADMISSIONS.includes(plan.admission)
        || (plan.admission === "pending" && (!RID_RE.test(String(plan.reservationId)) || c.protectedReservationIds.includes(String(plan.reservationId))))
        || (plan.admission === "authorized" && plan.reservationId !== null) || plan.intentId === c.synthetic.intentId
        || !pool || typeof pool.query !== "function" || !tooling || !exchanges || typeof exchanges.stripe !== "function" || typeof exchanges.hostaway !== "function"
        || !credentials || typeof credentials.stripe !== "function" || typeof credentials.hostaway !== "function") return done("CORE_INVALID");
    for (const k of ["runOrchestratorStep", "loadIntent", "createPhaseExecutors", "createStripeSend", "createHostawaySend", "validateAdapterConfig",
      "paymentIntentProofObservationV3", "stillAuthorizedV3Refusal"]) if (typeof tooling[k] !== "function") return done("CORE_INVALID", "TOOLING_INVALID");
    if (typeof tooling.LOCK_KEY !== "string" || typeof tooling.LOCK_PRECHECK_SQL !== "string") return done("CORE_INVALID", "TOOLING_INVALID");
    r.admission = plan.admission;
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

    // ---- (2) read-only start check ----------------------------------------------------------------------------------------------------------
    let f;
    try { f = await read(); } catch (e) { return e instanceof Stopped ? stopOutcome() : done("DB_ERROR", "START_READ_FAILED"); }
    r.startState = f.intent ? f.intent.status : null;
    const st = checkStart(f, plan, c);
    if (!st.ok) return done(["STATE_NOT_PAYMENT_AUTHORIZED", "STATE_NOT_RESERVATION_PENDING", "VERSION_NOT_PINNED", "HISTORIC_INTENT", "PREVIOUS_DISPATCH_PRESENT",
      "CREATE_NOT_PROVEN_SUCCEEDED"].includes(st.code) ? "START_STATE_NOT_ELIGIBLE" : "SCOPE_REFUSED", st.code);
    const intent0 = st.intent; const PI = intent0.payment.paymentIntentId;

    // ---- (3) the P3 session lock on a DEDICATED client: exact own proof (database, two-int4 classid, objid 0, objsubid 2, granted, own pid) ----
    try { lockClient = await lockClientFactory(); } catch { return done("DB_ERROR", "LOCK_CONNECT_FAILED"); }
    const onLockErr = () => { lockErrored = true; r.lockSession = "error_observed"; };
    if (typeof lockClient.on === "function") lockClient.on("error", onLockErr);
    const OWN_LOCK_SQL = `${tooling.LOCK_PRECHECK_SQL} AND l.pid = pg_catalog.pg_backend_pid()`;
    const lockQuery = async (sql, params) => { guard(); count(); return lockClient.query(sql, params); };
    // F4: the lock session must be ONE Postgres backend for the whole run. The acquire statement returns the backend pid; every later proof
    // re-reads it in the SAME statement as the lock predicate — a different pid (a transaction-pooler backend hop) is a lost / unproven lock.
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

    // ---- (4) DB identity on the lock session AND the pool (same database, TEST instance) ----------------------------------------------------
    try {
      const a = await lockQuery(Q.identity, []); const b = await q(Q.identity, []);
      if (a.rows.length !== 1 || b.length !== 1 || a.rows[0].db !== b[0].db || a.rows[0].environment !== c.dbEnvironment || b[0].environment !== c.dbEnvironment) return done("DB_IDENTITY_MISMATCH", "POOLS_MISMATCH");
    } catch (e) { return e instanceof Stopped ? stopOutcome() : done("DB_ERROR", "IDENTITY_READ_FAILED"); }

    // ---- (5) the target-only transport fence ----------------------------------------------------------------------------------------------
    const urls = { account: `${STRIPE}/v1/account`, pi: `${STRIPE}/v1/payment_intents/${PI}?expand%5B%5D=latest_charge`,
      listing: `${HOSTAWAY}/v1/listings/${c.listingId}`,
      price: `${HOSTAWAY}/v1/listings/${c.listingId}/calendar/priceDetails`, create: `${HOSTAWAY}/v1/reservations` };
    const fence = { createOpen: false, createExchanged: false, secondSend: false };
    const hkeys = (h) => Object.keys(h).sort().join(",");
    const stripeGate = (req) => {
      if (stopped()) { r.refusedByStop += 1; return Promise.reject(new Error("stopped")); }
      if (!req || !req.headers || req.headers["Stripe-Version"] !== c.stripeVersion || r.exchanges >= B.exchanges) { r.refusedAtTransport += 1; return Promise.reject(new Error("gate")); }
      const isGet = req.method === "GET" && req.body === null && hkeys(req.headers) === "Authorization,Stripe-Version";
      if (isGet && req.url === urls.account && r.accountReads < B.accountReads) r.accountReads += 1;
      else if (isGet && req.url === urls.pi && r.piReads < B.piReads) r.piReads += 1;
      else { r.refusedAtTransport += 1; return Promise.reject(new Error("gate")); }                       // ZERO Stripe writes, ever
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
    const isCalendarUrl = (url) => {
      let u; try { u = new URL(url); } catch { return false; }
      if (u.origin !== HOSTAWAY || u.pathname !== `/v1/listings/${c.listingId}/calendar` || u.hash !== "") return false;
      const keys = [...u.searchParams.keys()].sort().join(",");
      return keys === "endDate,startDate" && u.searchParams.get("startDate") === intent0.from && u.searchParams.get("endDate") === intent0.to;
    };
    let boundId = null;                                                                                   // the CURRENT step's bound reservation id
    const isReservationUrl = (url) => {
      const m = /^https:\/\/api\.hostaway\.com\/v1\/reservations\/([1-9][0-9]{0,15})$/.exec(url);
      if (!m || c.protectedReservationIds.includes(m[1])) return false;
      return boundId !== null && m[1] === boundId;                                                   // ONLY the bound id (never adopted from a reply)
    };
    const hostawayGate = (req) => {
      if (stopped()) { r.refusedByStop += 1; return Promise.reject(new Error("stopped")); }
      if (!req || !req.headers || r.exchanges >= B.exchanges) { r.refusedAtTransport += 1; return Promise.reject(new Error("gate")); }
      const plainGet = req.method === "GET" && req.body === null && hkeys(req.headers) === "Accept,Authorization,Cache-control";
      const postHdr = hkeys(req.headers) === "Accept,Authorization,Cache-control,Content-Type";
      const isPrice = req.method === "POST" && req.url === urls.price && postHdr && typeof req.body === "string" && !req.body.includes("forceOverbooking");
      const isCreate = req.method === "POST" && req.url === urls.create && postHdr && typeof req.body === "string" && !req.body.includes("forceOverbooking");
      if (plainGet && (req.url === urls.listing || isCalendarUrl(req.url)) && r.pricingCalls < B.pricingCalls) r.pricingCalls += 1;
      else if (isPrice && r.pricingCalls < B.pricingCalls) r.pricingCalls += 1;
      else if (plainGet && isReservationUrl(req.url) && r.hostawayReads < B.hostawayReads) r.hostawayReads += 1;
      else if (plainGet && isLookupUrl(req.url) && r.lookupPages < B.lookupPages) r.lookupPages += 1;
      else if (isCreate && fence.createOpen && plan.admission === "authorized") fence.createExchanged = true;
      else { r.refusedAtTransport += 1; return Promise.reject(new Error("gate")); }
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
      // the ACCEPTED v3 proof over a runner-readback evidence shape (= the merged cleanup runner's piProof, phase "before")
      const observed = tooling.paymentIntentProofObservationV3(pi, { accountVerified: true });
      const ev = { id: "runner-readback", kind: "payment_intent", readOpType: "stripe.retrieve_payment_intent", requestRef: PI, externalRef: PI, status: observed.status, observed, observedAt: clock() };
      const code = tooling.stillAuthorizedV3Refusal(ev, intent0, st.attemptId);
      if (code) return done("PROVIDER_PROOF_FAILED", CODE_RE.test(String(code)) ? String(code) : "PI_PROOF");
      r.proofs.push("BEFORE_WORKER");
    } catch (e) { if (e instanceof Stopped || stopped()) return stopOutcome(); return done("PROVIDER_PROOF_FAILED", "READ_FAILED"); }

    // ---- (7) guest binding (app role) + the accepted executors over the fence --------------------------------------------------------------
    let guest;
    try {
      const g = await q(Q.guest, [plan.intentId]);
      if (g.length !== 1 || g[0].privileged !== false || g[0].is_app !== true) return done("SCOPE_REFUSED", "ROLE_NOT_APP");
      if (typeof g[0].email !== "string" || typeof g[0].first_name !== "string" || typeof g[0].last_name !== "string") return done("SCOPE_REFUSED", "GUEST_NOT_FOUND");
      guest = { email: g[0].email, firstName: g[0].first_name, lastName: g[0].last_name };
    } catch (e) { return e instanceof Stopped ? stopOutcome() : done("DB_ERROR", "GUEST_READ_FAILED"); }
    const hostawaySend = async (req, opts) => {
      if (stopped()) { r.refusedByStop += 1; throw new Error("stopped"); }
      const o = { ...(opts && typeof opts === "object" ? opts : {}), signal: composed(opts && opts.signal) };
      if (req && req.method === "POST" && req.path === "/v1/reservations") {
        if (plan.admission !== "authorized" || r.createInvocations >= B.create) { r.refusedAtTransport += 1; fence.secondSend = true; throw new Error("create budget"); }
        r.createInvocations += 1; r.writes.create += 1; fence.createOpen = true;
        try {
          const out = await th.transport.send(req, o);
          r.createOutcome = out && Number.isSafeInteger(out.httpStatus) ? "REPLIED" : "UNKNOWN";
          return out;
        } catch (e) { r.createOutcome = fence.createExchanged ? "UNKNOWN" : "NOT_SENT"; throw e; }
        finally { fence.createOpen = false; }
      }
      if (!req || !(req.method === "GET" || (req.method === "POST" && /\/calendar\/priceDetails$/.test(String(req.path))))) { r.refusedAtTransport += 1; throw new Error("method refused"); }
      return th.transport.send(req, o);
    };
    const buildExecutors = (id) => {
      const bx = tooling.createPhaseExecutors({ phase: id === null ? "reservation" : "reservation-recovery", binding: { listingId: c.listingId, arrivalDate: intent0.from, departureDate: intent0.to,
        ref: intent0.ref, guests: intent0.guests, totalMinor: intent0.price.finalTotalMinor, currency: c.currency, refFieldId: c.refFieldId, guest, reservationId: id }, hostaway: { send: hostawaySend } });
      if (!bx || bx.ok !== true) return null;
      const executors = {};
      for (const k of Object.keys(bx.executors)) {
        const fn = bx.executors[k];
        executors[k] = k === "pricing"
          ? freeze({ get: async (...a) => { if (stopped()) { r.refusedByStop += 1; throw new Error("stopped"); } return fn.get(...a); },
            post: async (...a) => { if (stopped()) { r.refusedByStop += 1; throw new Error("stopped"); } return fn.post(...a); } })
          : async (...args) => { if (stopped()) { r.refusedByStop += 1; throw new Error("stopped"); } return Reflect.apply(fn, undefined, args); };
      }
      return freeze(executors);
    };
    const rate = intent0.price && Number.isSafeInteger(intent0.price.rateBps) ? intent0.price.rateBps : null;
    if (rate === null) return done("SCOPE_REFUSED", "PRICE_RATE_MISSING");
    const listings = new Map([[c.listingId, { currency: c.currency, timeZone: c.listingTimeZone }]]);
    const env = { VERCEL_ENV: "development", MV_E7_RESERVATION_WORKER: "enabled", DIRECT_DISCOUNT_BPS: String(rate) };
    const adapterConfig = tooling.validateAdapterConfig({ allowedListingIds: [c.listingId], refFieldId: c.refFieldId, channelId: 2000, currency: c.currency });

    // ---- (8) bounded worker steps: lock proven before EVERY step; stop between steps; waits honoured (capped) -------------------------------
    let finalFacts = null;
    for (let step = 1; step <= B.steps; step++) {
      if (stopped()) return stopOutcome();
      try { if (!(await ownLock())) { r.lock = "lost"; return done("LOCK_LOST", lockErrored ? "LOCK_SESSION_ERROR" : r.lockSession === "backend_hop" ? "BACKEND_HOP" : "LOCK_NOT_HELD"); } }
      catch (e) { return e instanceof Stopped ? stopOutcome() : done("DB_ERROR", "LOCK_PROOF_FAILED"); }
      if (stopped()) return stopOutcome();                                                            // F1: admission re-check AFTER the awaited proof
      const cand = candidateOf(f, plan, c);
      if (!cand.ok) return done("SCOPE_REFUSED", cand.code);
      boundId = cand.id;
      const executors = buildExecutors(cand.id);
      if (!executors) return done("SCOPE_REFUSED", "EXECUTOR_BINDING_REFUSED");
      let w;
      if (stopped()) return stopOutcome();                                                            // F1: immediately BEFORE the worker is admitted
      try {
        r.steps += 1;
        w = await tooling.runOrchestratorStep(countedPool, { workerId: `e7-hosted-res:${plan.approvalRef}`, env, adapterConfig, listings, executors, clock, intentId: plan.intentId });
      } catch (e) {
        if (e instanceof Refusal && e.code === "DB_BUDGET") return done(uncertain() ?? "BUDGET_EXHAUSTED", "DB_QUERY_CEILING");
        if (stopped()) return stopOutcome();
        return done(uncertain() ?? "DB_ERROR", "WORKER_THREW");
      }
      for (const a of (w && Array.isArray(w.actions) ? w.actions : [])) if (r.actions.length < 200 && CODE_RE.test(String(a))) r.actions.push(String(a));
      if (w && w.late) await Promise.race([Promise.resolve(w.late).catch(() => {}), sleep(1000)]);
      if (!w || w.status === "refused") return done(uncertain() ?? "WORKER_REFUSED", w && CODE_RE.test(String(w.code)) ? String(w.code) : "WORKER_REFUSED");
      if (r.createOutcome === "UNKNOWN") { try { finalFacts = await read(); } catch { /* reported below */ } return done("CREATE_OUTCOME_UNKNOWN", "LOST_CREATE_REPLY"); }
      if (stopped()) return stopOutcome();
      try { f = await read(); } catch (e) { return e instanceof Stopped ? stopOutcome() : done("DB_ERROR", "STEP_READBACK_FAILED"); }
      observe(f);
      if (stopped()) return stopOutcome();                                                            // F3: the readback may have crossed the deadline
      const stNow = f.intent ? f.intent.status : null;
      if (stNow === "reservation_confirmed") { finalFacts = f; break; }
      if (stNow === "reservation_failed") { finalFacts = f; return done("RESERVATION_FAILED", "WORKER_FAILED_RESERVATION"); }       // cleanup is a SEPARATE reviewed step
      if (stNow !== "payment_authorized" && stNow !== "reservation_pending") { finalFacts = f; return done("RESERVATION_UNKNOWN", `STATE_${String(stNow).toUpperCase()}`); }
      if (step === B.steps) { finalFacts = f; return done("STEP_BUDGET_EXHAUSTED", "STEPS"); }
      const delay = w.status === "worked" && Number.isSafeInteger(w.delayMs) ? Math.min(Math.max(w.delayMs, 0), B.waitCapMs) : Math.min(5000, B.waitCapMs);
      const left = endsAt - mono();
      if (left <= delay) { r.stopReason = "DEADLINE"; stopReason = "DEADLINE"; return stopOutcome(); }
      await sleep(delay);
    }

    // ---- (9) read-only postcheck: output and persisted facts must agree ------------------------------------------------------------------
    observe(finalFacts);
    const pe = checkEnd(finalFacts, plan, c);
    if (pe) return done("POSTCHECK_MISMATCH", pe);
    r.postcheck = { createOps: finalFacts.ops.filter((o) => o.op_type === "hostaway.create_reservation").length, claimHeld: true, openCases: 0, capturedMinor: 0 };
    if (stopped()) return stopOutcome();                                                              // F3: never success past the deadline / after a session error
    return done("RESERVATION_CONFIRMED_INTERMEDIATE");
  };
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
    // (a) F3 residual facts: after any admitted step / send, ONE bounded read-only readback reports the best available observed facts
    if ((r.steps > 0 || r.createInvocations > 0) && input && input.pool && input.tooling) {
      const raw = { query: (sql, params) => input.pool.query(sql, params) };
      const b = await bounded(readFacts(async (sql, params) => (await input.pool.query(sql, params)).rows, input.plan, input.tooling, raw));
      if (b.done && !b.threw) observe(b.value);
      // F5: success is PROVISIONAL until this residual read is validated — a contradiction (ineligible state, non-pristine capture, released
      //     claim, open case, id conflict) or an unavailable read downgrades to a fixed non-success code; the OBSERVED facts stay, the earlier
      //     postcheck (which would claim the opposite) is dropped. Read-only: nothing is repaired.
      if (r.outcome === "RESERVATION_CONFIRMED_INTERMEDIATE") {
        const re = b.done && !b.threw ? checkEnd(b.value, input.plan, c) : "RESIDUAL_READ_UNAVAILABLE";
        if (re) { r.outcome = "NOT_CONFIRMED"; r.code = re === "RESIDUAL_READ_UNAVAILABLE" ? re : `RESIDUAL_${re}`; r.postcheck = null; }
      }
    }
    // (b) teardown: checked, bounded unlock on the dedicated session; a failed / errored / timed-out unlock destroys the connection (the server
    //     drops session locks) AND vetoes a clean success (F3b) — the observed facts above stay in the result
    if (lockClient) {
      let released = false;
      if (lockAcquired && !lockErrored) {
        const u = await bounded(lockClient.query("SELECT pg_advisory_unlock(pg_catalog.hashtext($1), 0) AS ok, pg_catalog.pg_backend_pid() AS pid", [input?.tooling?.LOCK_KEY ?? ""]));
        released = u.done && !u.threw && u.value && u.value.rows && u.value.rows.length === 1 && u.value.rows[0].ok === true && String(u.value.rows[0].pid) === lockPid && !lockErrored;
      }
      if (lockAcquired) r.lock = released ? "released" : (lockErrored ? "session_error_connection_destroyed" : "unlock_failed_connection_destroyed");
      try { lockClient.release(released ? undefined : true); } catch { /* contained */ }
      if (lockAcquired && !released && r.outcome === "RESERVATION_CONFIRMED_INTERMEDIATE") { r.outcome = "NOT_CONFIRMED"; r.code = lockErrored ? "LOCK_SESSION_ERROR_AT_TEARDOWN" : "UNLOCK_NOT_PROVEN"; }
    }
    if (r.outcome === "RESERVATION_CONFIRMED_INTERMEDIATE" && stopped()) { r.outcome = "NOT_CONFIRMED"; r.code = `STOP_${stopReason}_AT_TEARDOWN`; }
  }
  return snapshot();
}

// =================================================================================================================================
// hosted wrapper (GitHub Actions): preflight (no secrets) / verify / execute (CLOSED until executeEnabled is reviewed true)
export async function framedDigest(dir, files, prefix) {
  const h = createHash("sha256"); h.update(prefix); let total = 0;
  for (const rel of files) {
    const p = `${dir}/${rel}`; const st = await lstat(p);
    if (!st.isFile() || st.size < 1 || st.size > MAX_FILE) refuse("HRS_SOURCE_UNREADABLE");
    const b = await readFile(p); if (b.length !== st.size) refuse("HRS_SOURCE_UNREADABLE");
    total += b.length; if (total > MAX_TOTAL) refuse("HRS_SOURCE_UNREADABLE");
    h.update(rel); h.update(Buffer.from([0])); h.update(String(b.length)); h.update(Buffer.from([0])); h.update(b); h.update(Buffer.from([0]));
  }
  return h.digest("hex");
}
export const CLOSURE_DIGEST_PREFIX = "e7-hosted-reservation-closure-v1\n";
export const RUNNER_DIGEST_PREFIX = "e7-hosted-reservation-runner-v1\n";
export const CHILD_ENV_ALLOWLIST = Object.freeze(["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "TZ"]);
export function childEnv(env, toolingDir) {
  const out = {};
  for (const k of CHILD_ENV_ALLOWLIST) if (Object.hasOwn(env, k) && typeof env[k] === "string" && env[k].length <= 4096 && !env[k].includes("\0")) out[k] = env[k];
  out.E7_TOOLING_DIR = toolingDir;
  return out;
}
export function spawnNode(args, { cwd, env }) {
  return new Promise((resolve) => {
    let out = ""; let outBytes = 0; let truncated = false; let child;
    try { child = spawn(process.execPath, args, { cwd, env, shell: false, stdio: ["ignore", "pipe", "ignore"] }); } catch { resolve({ status: null, signal: null, stdout: "", truncated: false, spawnFailed: true }); return; }
    child.stdout.on("data", (d) => { outBytes += d.length; if (outBytes <= 262144) out += d.toString("utf8"); else truncated = true; });
    child.on("error", () => resolve({ status: null, signal: null, stdout: "", truncated, spawnFailed: true }));
    child.on("close", (status, signal) => resolve({ status, signal, stdout: out, truncated, spawnFailed: false }));
  });
}
const TEST_FILE = "test/e7-hosted-reservation.test.mjs";
export function dbTargetOk(url, c = CONSTANTS) {
  let u; try { u = new URL(url); } catch { return false; }
  return (u.protocol === "postgresql:" || u.protocol === "postgres:") && u.hostname === "aws-0-us-east-1.pooler.supabase.com" && u.port === "6543"
    && decodeURIComponent(u.username) === `mv_booking_app_dev.${c.dbProjectRef}` && u.pathname === "/postgres" && u.search === "" && u.hash === "";
}
/** F4: the dedicated SESSION-lock connection string = the SAME scoped Supabase pooler host / role / database as the worker pool, over the
 *  pooler's SESSION port 5432 (official Supabase docs: 6543 = transaction mode, 5432 = session mode). The worker pool stays on 6543. A session
 *  advisory lock needs ONE backend for the whole run, which transaction mode does not give. Pinned derivation; any other target refuses. */
export const SESSION_LOCK_PORT = "5432";
export function sessionLockUrl(url, c = CONSTANTS) {
  if (!dbTargetOk(url, c)) return null;
  const u = new URL(url); u.port = SESSION_LOCK_PORT;
  return u.href;
}
export const OFFICIAL_CA_SHA256 = "700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7";
const SECRET_KEYS = Object.freeze(["E7_STRIPE_TEST_KEY", "E7_HOSTAWAY_TOKEN", "E7_DEV_BOOKING_DATABASE_URL"]);

/** runHosted({ mode, env, proc, wrapperDir, deps }) → { exitCode, result }. Never throws. deps = TEST SEAMS. */
export async function runHosted({ mode = "preflight", env, proc, wrapperDir, deps = {} }) {
  const c = deps.constants ?? CONSTANTS;
  const spawnChild = deps.spawnChild ?? spawnNode;
  const importEnv = deps.importEnv ?? ((dir) => import(pathToFileURL(`${dir}/scripts/e7-connected/probe-env-preflight.mjs`).href));
  const importTooling = deps.importTooling ?? defaultImportTooling;
  const runCore = deps.runCore ?? runReservationCore;
  const readPgVersion = deps.readPgVersion ?? (async (dir) => JSON.parse(await readFile(`${dir}/node_modules/pg/package.json`, "utf8")).version);
  const readCa = deps.readCa ?? ((p) => readFile(p));
  const r = { schema: "e7-hosted-reservation-hosted-v1", mode: null, code: null, workflowSha: null, toolingCommit: c.toolingCommit, toolingStatus: c.toolingStatus,
    executeEnabled: c.executeEnabled, closureDigest: null, runnerDigest: null, planKind: null, planHash: null, envCode: null, tests: null, lockEndpoint: null, core: null };
  let pool = null; let lockPool = null;
  try {
    if (!["preflight", "verify", "execute"].includes(mode)) refuse("HRS_USAGE");
    r.mode = mode;
    r.workflowSha = HEX40.test(env.E7_WORKFLOW_SHA ?? "") ? env.E7_WORKFLOW_SHA : null;
    const has = (k) => typeof env[k] === "string" && env[k].length > 0;
    if (mode !== "execute" && SECRET_KEYS.some(has)) refuse("HRS_SECRET_SCOPE_VIOLATION");
    const ref = env.E7_APPROVAL_REF ?? ""; const iid = env.E7_INTENT_ID ?? ""; const ver = env.E7_EXPECTED_VERSION ?? ""; const nb = env.E7_NOT_BEFORE ?? "";
    const adm = env.E7_ADMISSION ?? ""; const rid = env.E7_RESERVATION_ID ?? "";
    const expPlan = env.E7_EXPECTED_PLAN_HASH ?? ""; const expClo = env.E7_EXPECTED_CLOSURE_DIGEST ?? ""; const expRun = env.E7_EXPECTED_RUNNER_DIGEST ?? "";
    const vals = [ref, iid, ver, nb, adm]; const anyReal = vals.some((v) => v !== "");
    if (anyReal && vals.some((v) => v === "")) refuse("HRS_INPUT_INCOMPLETE");
    if (anyReal && (!APPROVAL_RE.test(ref) || !UUID_RE.test(iid) || !/^[1-9][0-9]{0,6}$/.test(ver) || isoMs(nb) === null || !ADMISSIONS.includes(adm)
        || (adm === "pending" && !RID_RE.test(rid)) || (adm === "authorized" && rid !== ""))) refuse("HRS_INPUT_INVALID");
    if (ref === c.synthetic.approvalRef || iid === c.synthetic.intentId) refuse("HRS_INPUT_INVALID");
    if (mode !== "preflight") {
      if (c.executeEnabled !== true || c.toolingStatus !== "MERGED" || !HEX64.test(String(c.closureDigest))) refuse("HRS_EXECUTE_CLOSED");   // Slice 1: CLOSED
      if (!anyReal || !HEX64.test(expPlan) || !HEX64.test(expClo) || !HEX64.test(expRun)) refuse("HRS_INPUT_INCOMPLETE");
      if (env.GITHUB_REF !== "refs/heads/main") refuse("HRS_REF_NOT_MAIN");
      if (expClo !== c.closureDigest) refuse("HRS_SOURCE_MISMATCH");
    }
    const tooling = await realpath(env.E7_TOOLING_DIR ?? "").catch(() => refuse("HRS_LAYOUT_INVALID"));
    const wdir = await realpath(wrapperDir).catch(() => refuse("HRS_LAYOUT_INVALID"));
    if (tooling === wdir || tooling.startsWith(`${wdir}/`) || wdir.startsWith(`${tooling}/`)) refuse("HRS_LAYOUT_INVALID");
    r.closureDigest = await framedDigest(tooling, c.closure, CLOSURE_DIGEST_PREFIX).catch((e) => refuse(e instanceof Refusal ? e.code : "HRS_SOURCE_UNREADABLE"));
    if (r.closureDigest !== c.closureDigest) refuse("HRS_SOURCE_MISMATCH");
    r.runnerDigest = await framedDigest(wdir, c.runnerFiles, RUNNER_DIGEST_PREFIX).catch((e) => refuse(e instanceof Refusal ? e.code : "HRS_SOURCE_UNREADABLE"));
    if (mode !== "preflight" && r.runnerDigest !== expRun) refuse("HRS_RUNNER_MISMATCH");
    r.planKind = anyReal ? "REAL" : "SYNTHETIC";
    const s = c.synthetic;
    const built = buildPlan(c, anyReal ? { approvalRef: ref, intentId: iid, expectedVersion: Number(ver), notBefore: nb, admission: adm, reservationId: rid, runnerDigest: r.runnerDigest }
      : { approvalRef: s.approvalRef, intentId: s.intentId, expectedVersion: s.expectedVersion, notBefore: s.notBefore, admission: s.admission, reservationId: s.reservationId, runnerDigest: r.runnerDigest });
    r.planHash = built.planHash;
    if (mode !== "preflight" && built.planHash !== expPlan) refuse("HRS_PLAN_HASH_MISMATCH");
    let C1; try { C1 = await importEnv(tooling); } catch { refuse("HRS_IMPORT_FAILED"); }
    const present = Object.fromEntries(C1.PRESENT_KEYS.map((k) => [k, Object.hasOwn(env, k)]));
    let uid = null; try { if (typeof proc.getuid === "function") { const u = proc.getuid(); if (Number.isSafeInteger(u) && u >= 0) uid = u; } } catch { uid = null; }
    const ev = C1.evaluateProbeEnvironment({ schema: C1.ENV_SNAPSHOT_SCHEMA, nodeVersion: String(proc.versions.node), platform: proc.platform,
      execArgvCount: proc.execArgv.length, uidAvailable: uid !== null, present });
    r.envCode = typeof ev.code === "string" && C1.ENV_CODES.includes(ev.code) ? ev.code : "REDACTED";
    if (ev.ok !== true || proc.versions.node !== c.nodeVersion) refuse("HRS_ENV_REFUSED");
    if (mode === "preflight") {
      const o = await spawnChild(["--test", "--test-reporter=tap", TEST_FILE], { cwd: wdir, env: childEnv(env, tooling) });
      if (!o || o.spawnFailed || (o.signal !== null && o.signal !== undefined) || !Number.isSafeInteger(o.status) || o.truncated) refuse("HRS_CHILD_FAILED");
      const num = (re) => { const m = re.exec(o.stdout); return m ? Number(m[1]) : null; };
      r.tests = { status: o.status, tests: num(/^# tests (\d+)$/m), pass: num(/^# pass (\d+)$/m), fail: num(/^# fail (\d+)$/m), connectivityEvidence: false };
      if (o.status !== 0 || !(r.tests.tests > 0) || r.tests.pass !== r.tests.tests || r.tests.fail !== 0) refuse("HRS_TESTS_FAILED");
      r.code = anyReal ? "PREFLIGHT_OK_REAL_PLAN" : "PREFLIGHT_OK_SYNTHETIC_ONLY"; return { exitCode: 0, result: r };
    }
    if (mode === "verify") { r.code = "VERIFY_OK"; return { exitCode: 0, result: r }; }
    if (!SECRET_KEYS.every(has)) refuse("HRS_CREDENTIALS_MISSING");
    let pgv; try { pgv = await readPgVersion(tooling); } catch { pgv = null; }
    if (pgv !== c.pgVersion) refuse("HRS_DEPENDENCY_MISMATCH");
    let skey = env.E7_STRIPE_TEST_KEY; delete env.E7_STRIPE_TEST_KEY;
    let htok = env.E7_HOSTAWAY_TOKEN; delete env.E7_HOSTAWAY_TOKEN;
    let dbUrl = env.E7_DEV_BOOKING_DATABASE_URL; delete env.E7_DEV_BOOKING_DATABASE_URL;
    const wipe = () => { skey = null; htok = null; dbUrl = null; };
    if (!dbTargetOk(dbUrl, c)) { wipe(); refuse("HRS_DB_TARGET_INVALID"); }
    let caPem = null;
    try { const b = await readCa(env.E7_CA_FILE ?? ""); if (sha(b) === (deps.caSha256 ?? OFFICIAL_CA_SHA256) && b.length < 16384) caPem = b.toString("utf8"); } catch { caPem = null; }
    if (caPem === null) { wipe(); refuse("HRS_CA_INVALID"); }
    let mods; try { mods = await importTooling(tooling); } catch { wipe(); refuse("HRS_IMPORT_FAILED"); }
    const xs = mods.X.createE7RealExchange({ provider: "stripe" }); const xh = mods.X.createE7RealExchange({ provider: "hostaway" });
    if (!xs || xs.ok !== true || !xh || xh.ok !== true) { wipe(); refuse("HRS_IMPORT_FAILED"); }
    let lockUrl = sessionLockUrl(dbUrl, c);
    if (lockUrl === null) { wipe(); refuse("HRS_DB_TARGET_INVALID"); }
    try {
      pool = mods.createBookingPool({ connectionString: dbUrl, caPem, max: 3 });                      // worker pool: transaction pooler (6543)
      lockPool = mods.createBookingPool({ connectionString: lockUrl, caPem, max: 1 });                // dedicated SESSION lock connection (5432)
    } catch { wipe(); refuse("HRS_DB_TARGET_INVALID"); } finally { dbUrl = null; lockUrl = null; }
    r.lockEndpoint = `session:${SESSION_LOCK_PORT}`;
    const ac = new AbortController(); const onSig = () => ac.abort(); proc.once?.("SIGINT", onSig); proc.once?.("SIGTERM", onSig);
    try {
      r.core = await runCore({ plan: built.plan, pool, lockClientFactory: () => lockPool.connect(), tooling: mods.tooling, exchanges: { stripe: xs.exchange, hostaway: xh.exchange },
        credentials: { stripe: () => skey, hostaway: () => htok }, runSignal: ac.signal });
    } finally { wipe(); proc.off?.("SIGINT", onSig); proc.off?.("SIGTERM", onSig); }
    r.code = "EXECUTE_DONE";
    return { exitCode: r.core && r.core.outcome === "RESERVATION_CONFIRMED_INTERMEDIATE" ? 0 : 1, result: r };
  } catch (e) {
    r.code = e instanceof Refusal && HOSTED_CODES.includes(e.code) ? e.code : "HRS_INTERNAL";
    return { exitCode: 1, result: r };
  } finally {
    if (lockPool) await lockPool.end().catch(() => {});
    if (pool) await pool.end().catch(() => {});
  }
}
async function defaultImportTooling(dir) {
  const u = (p) => pathToFileURL(`${dir}/${p}`).href;
  const [W, R, EA, T, X, P, HR, CP, LK] = await Promise.all([import(u("lib/booking-db/reservation-worker.js")), import(u("lib/booking-db/repo.js")),
    import(u("scripts/e7-connected/executor-adapters.mjs")), import(u("scripts/e7-connected/http-transports.mjs")), import(u("scripts/e7-connected/real-exchange.mjs")),
    import(u("lib/booking-db/pool.js")), import(u("lib/hostaway-reservations.js")), import(u("lib/checkout/capture-proof.js")), import(u("scripts/e7-connected/run-lock-precheck.mjs"))]);
  return { X, createBookingPool: P.createBookingPool,
    tooling: { runOrchestratorStep: W.runOrchestratorStep, loadIntent: R.loadIntent, createPhaseExecutors: EA.createPhaseExecutors, createStripeSend: T.createE7StripeTestSend,
      createHostawaySend: T.createE7HostawaySend, validateAdapterConfig: HR.validateAdapterConfig, paymentIntentProofObservationV3: CP.paymentIntentProofObservationV3,
      stillAuthorizedV3Refusal: CP.stillAuthorizedV3Refusal, LOCK_KEY: LK.LOCK_KEY, LOCK_PRECHECK_SQL: LK.LOCK_PRECHECK_SQL } };
}
export function summaryMarkdown(r) {
  const core = r.core ? ` core=${r.core.outcome}${r.core.code ? `/${r.core.code}` : ""} steps=${r.core.steps} create=${r.core.createInvocations}/${r.core.createOutcome} lock=${r.core.lock} captureQueuedPristine=${r.core.captureQueuedPristine}` : "";
  return `e7-hosted-reservation ${r.mode} ${r.code} executeEnabled=${r.executeEnabled} lock=${r.lockEndpoint ?? "-"} plan=${r.planKind ?? "-"}:${r.planHash ?? "-"} closure=${r.closureDigest ?? "-"} runner=${r.runnerDigest ?? "-"}${core}\n`;
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
