// scripts/e7-hosted-recording.mjs — E7 Slice 4: HOSTED (GitHub Actions) OFFLINE-CHARGE RECORDING for ONE admitted TEST intent:
// payment_captured → (the ACCEPTED recording worker, runRecordingStep at the immutable tooling commit: GET identity + GET charge list preflight,
// AT MOST ONE offline-charge POST proven by a confirming LIST read, completion with evidence, OFFLINE_CHARGE_RECORDED) → confirmed, on the TEST
// DEV database, with FAKE-free real transports. Bookkeeping only: Hostaway offline charges move no money.
//
// HONEST LABEL: MANUAL hosted TEST recording (workflow_dispatch + the existing reviewer gate), NOT automatic customer checkout. Code is NOT
// consent: executeEnabled is CLOSED again (the reviewed C29 CLOSE patch, merged by ROOT once the ONE gated hosted TEST recording attempt has ENDED or
// STOPPED — the patch itself asserts nothing about whether or how that attempt ran; verify / execute refuse HRC_EXECUTE_CLOSED). ROOT review 5900228555
// accepted the C27/C28 PROPOSAL only; execution authority was a separate owner decision (D-a / D-b / D-c) plus the environment gate. D4's original conditions (ROOT 5883328669:
// recorded-state cleanup contract implemented — 0021 / mirror worker / Slice 5 runner, all CLOSED; migration issuance hold resolved — shared DEV
// exactly 0001..0021) are MET. The owner policy decisions D-a / D-b / D-c (manual, policy-assessed refund disposition; no automated exit from a
// recorded TEST state; a recorded TEST intent — confirmed + ONE queued PRISTINE guest.notify + succeeded recording + two unprocessed
// recording_conflict_inbox rows — cannot enter the Slice 3 pristine cleanup admission) remain the owner's and are NOT taken by this flag. Slice 1 / 2 / 3 stay CLOSED
// and pinned to THEIR tooling; this runner pins the LATER immutable MERGED e7-test tooling 4ed7a636 (C24 repin: PR72 outer signal / deadline stop safety + C1 capture no-final_capture + C21-F1 list null-provider admission; 0021 / mirror additions are present in the closure but unused by this runner).
//   * Inert on import (`import.meta.main` guard): no env / fs / network / DB / timer until a mode runs.
//   * LABELLED SPECIALISATION of the reviewed Slice 3 runner (scripts/e7-hosted-test-cleanup.mjs): hosted boot / pinning / session lock (5432) /
//     counted pool / stop latch / fence / step / postcheck / teardown sections are LABELLED COPIES specialised to the recording phase (pure helpers
//     imported from ./e7-hosted-reservation.mjs). The worker (runRecordingStep) and the pure proof module are the ACCEPTED modules, never copied or
//     rebuilt; the executors are the ACCEPTED recording phase of executor-adapters.mjs over the accepted Hostaway transport (H2 / H8 / H9).
//   * NO Stripe: no Stripe transport, credential, read or write of any kind in this runner (the recording phase is Hostaway-only).
//   * Exact pins (plan hash): approval label, intent UUID, expected version, not-before (never a historic intent), the bound PaymentIntent id (admission
//     only), the bound Hostaway reservation id, the bound charge id, the EXACT captured amount, the stay, the completed payment attempt id and the
//     Checkout Session id; FIXED TEST recording config paymentMethod "credit_card" / accountRef "hostaway-e7-test" (labels are TRUST, never
//     authentication); fixed listing 606998 / USD / ref field / DEV project ref. The pins are RE-READ from the database and cross-checked first.
//     clientSnapshotId = the immutable hosted run id (E7_RUN_ID; stable within the session, outside the plan hash, reported in the result).
//   * Admission (read-only, before the lock): payment_captured at the pinned version, ONE succeeded capture row (attempt 1, the pinned charge / amount /
//     accepted key), ONE recording row PRISTINE (och:<intent>:1, pending / attempts 0 / never dispatched / unleased, payload bound to the pinned
//     reservation + amount, no result), ZERO recording holds / open cases, ZERO notification / void / cancel / refund rows, no offline-charge ledger or
//     evidence, intent.offlineChargeId null, counters capture 1 / offlineCharge 0, the claim held, no leases, TEST livemode, recordedPaymentAt UNIQUE
//     (the worker's own transition query), and the READ-ONLY schema prerequisite (the reviewed 0010–0017 recording objects) — never migrated.
//   * Order: start check → P3 session lock on a DEDICATED 5432 session (pid-stable proof before every step) → DB identity / role → the bound ACTIVE
//     reservation read (accepted activeReservationProof over runner-read observations; the booking ref MUST be echoed — the accepted worker requires it,
//     so a non-echoed ref refuses here: REF_NOT_ECHOED) + ONE preflight charge LIST read assessed with the ACCEPTED
//     assessChargeList / preflightListObservation (must be complete with ZERO marker / lookalike / same-amount rows) → bounded worker steps behind a
//     target-only transport fence → read-only postcheck + fresh LIST readback (accepted normalized marker classifier + complete-list rules: exactly ONE
//     exact-marked charge = the recorded id with the pinned fields, zero lookalikes / duplicates / foreign / malformed rows) → counted residual re-validation.
//   * Fence (counted BEFORE the transport, every other exchange refused in-process): Hostaway GET /v1/reservations/<bound>, GET
//     /v1/guestPayments/charges?limit=500&reservationIds=<bound>, and AT MOST ONE POST /v1/guestPayments/charges/<bound> whose JSON body is EXACTLY
//     { title: "maraVilla payment mvoch1-<intent>", amount: <captured as decimal>, paymentMethod: "credit_card", status: "paid", scheduledDate: <UTC of the
//     DB-stamped recordedPaymentAt read at admission> } (field-exact; the accepted executor adapter checks it too).
//   * Stops: the runner-owned AbortController is passed to the accepted worker as its `signal` and aborted synchronously by the lock-session error
//     listener and every latched stop (run abort / deadline); `deadlineAt` = the run's wall deadline. v1 STOP on: refusal, deadline, lock loss / backend
//     hop / session error, a possibly-sent write without an admissible reply (WRITE_OUTCOME_UNKNOWN: persisted facts reported; never a resend), a hold
//     (RECORDING_HELD: owner review), escalation, budget, cancellation.
//   * Never: capture, void, cancel, refund, resend, attempt > 1, notification SEND (the ONE queued guest.notify row is left PRISTINE and verified so),
//     queue draining, historical intents, protected reservation ids, Stripe.
import process from "node:process";
import { readFile, realpath } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { CONSTANTS as RES, canonical, framedDigest, childEnv, spawnNode, dbTargetOk, sessionLockUrl, SESSION_LOCK_PORT, OFFICIAL_CA_SHA256 } from "./e7-hosted-reservation.mjs";

export const CONSTANTS = Object.freeze({
  toolingCommit: "4ed7a636fee57981262b9c02574190d225b8a1fc",    // e7-test: #99 merged (C21-F1) on top of #84 (C1 capture) / #81 / #78 / #76 / #75 / PR72; immutable (C24 repin from 5a094b16)
  toolingStatus: "MERGED",
  executeEnabled: false,                                          // Slice 4: CLOSED again by the reviewed C29 CLOSE patch (after the ONE gated TEST recording attempt ENDED or STOPPED); verify / execute refuse HRC_EXECUTE_CLOSED
  // the INDEPENDENTLY scanned transitive relative imports of the runner's tooling roots at 4ed7a636 (test C2 recomputes this from the pinned tree; SAME 30-path set as at 5a094b16, 8 members changed bytes):
  // = the Slice 1 closure + lib/booking-db/recording-worker.js (executor-adapters + offline-charge-proof are already in the Slice 1 closure)
  closure: Object.freeze(["lib/bookability.js", "lib/booking-db/codec.js", "lib/booking-db/config.js", "lib/booking-db/operations.js", "lib/booking-db/pool.js",
    "lib/booking-db/recording-worker.js", "lib/booking-db/recovery.js", "lib/booking-db/repo.js", "lib/booking-db/reservation-worker.js", "lib/checkout/capture-proof.js",
    "lib/checkout/compensation-proof.js", "lib/checkout/final-price.js", "lib/checkout/intent-state.js", "lib/checkout/offline-charge-proof.js", "lib/checkout/recovery-plan.js",
    "lib/checkout/server-pricer.js", "lib/direct-policy.js", "lib/direct-pricing.js", "lib/hostaway-calendar.js", "lib/hostaway-reservations.js", "lib/hostaway.js",
    "lib/public-api.js", "lib/quote-public.js", "package-lock.json", "package.json", "scripts/e7-connected/executor-adapters.mjs", "scripts/e7-connected/http-transports.mjs",
    "scripts/e7-connected/probe-env-preflight.mjs", "scripts/e7-connected/real-exchange.mjs", "scripts/e7-connected/run-lock-precheck.mjs"]),
  closureDigest: "b02f0a76ae2347badc55ef2daaf27640f7ef80c01d7e69d1e9bdc7d8d38c4109",
  pgVersion: "8.18.0",                                            // package-lock.json at 4ed7a636 (unchanged from 5a094b16) (checked against node_modules/pg before execute)
  runnerFiles: Object.freeze(["scripts/e7-hosted-recording.mjs", "scripts/e7-hosted-reservation.mjs", ".github/workflows/e7-hosted-recording.yml", "test/e7-hosted-recording.test.mjs"]),
  accountId: RES.accountId, listingId: RES.listingId, currency: RES.currency, refFieldId: RES.refFieldId, listingTimeZone: RES.listingTimeZone, protectedReservationIds: RES.protectedReservationIds,
  // TEST recording configuration (ROOT design review): explicit, no owner decision, no production accounting-policy claim; labels are labels only
  paymentMethod: "credit_card", accountRef: "hostaway-e7-test",
  // worker: the happy recording is ONE step (identity read, list read, assessment, claim, ONE POST, confirming list read, completion, event). dbQueries =
  // EVERY statement on the counted pool (runner reads + worker + lock session + teardown residual read + unlock). MEASURED on disposable PG16 with the REAL
  // worker (test I1, ref echoed): 147 statements TOTAL (body 132 + teardown 15 = residual read 14 + unlock 1), 7 exchanges (Hostaway identity reads 2 = runner
  // proof + worker; charge lists 4 = runner proof + worker preflight + worker confirming + runner readback; 1 POST), 1 step. Ceilings ≈ 3–4.5x the measured
  // values (the worker's own per-kind read admission stays authoritative). Fail-closed past them.
  // dbQueries = the TOTAL statement ceiling of a session, EVERY statement included (runner reads + worker + lock session + the teardown residual read + the
  // unlock). dbTeardownReserve statements of that total are reserved for the teardown (residual read ≈ 14 statements + 1 unlock, measured): the body may
  // use at most dbQueries − dbTeardownReserve; the teardown may use what is left of the total and nothing more (an unavailable residual read = NOT_CONFIRMED).
  budgets: Object.freeze({ steps: 6, record: 1, hostawayReads: 9, chargeLists: 12, exchanges: 24, dbQueries: 600, dbTeardownReserve: 40, runMs: 10 * 60 * 1000, waitCapMs: 35 * 1000 }),
  dbEnvironment: RES.dbEnvironment, dbProjectRef: RES.dbProjectRef, nodeVersion: RES.nodeVersion,
  synthetic: Object.freeze({ approvalRef: "SYNTHETIC-recording-preflight-not-for-execute", intentId: "00000000-0000-4000-8000-000000000000", expectedVersion: 8,
    notBefore: "2026-11-12T00:00:00.000Z", paymentIntentId: "pi_SYNTHETIC00000000000000", reservationId: "1", chargeId: "ch_SYNTHETIC00000000000000", capturedMinor: 1,
    from: "2027-01-01", to: "2027-01-02", guests: 1, attemptId: "00000000-0000-4000-8000-000000000001", sessionId: "cs_test_SYNTHETIC0000000000" })
});
export const PLAN_SCHEMA = "e7-hosted-recording-plan-v1";
export const RESULT_SCHEMA = "e7-hosted-recording-result-v1";
export const OUTCOMES = Object.freeze(["RECORDING_CONFIRMED", "SCOPE_REFUSED", "START_STATE_NOT_ELIGIBLE", "SCHEMA_PREREQUISITE_MISSING", "LOCK_NOT_ACQUIRED", "LOCK_LOST",
  "DB_IDENTITY_MISMATCH", "PROVIDER_PROOF_FAILED", "WORKER_REFUSED", "WRITE_OUTCOME_UNKNOWN", "RECORDING_HELD", "RECORDING_ESCALATED", "RECORDING_UNKNOWN_STATE",
  "STEP_BUDGET_EXHAUSTED", "BUDGET_EXHAUSTED", "DEADLINE", "ABORTED", "DB_ERROR", "POSTCHECK_MISMATCH", "NOT_CONFIRMED", "CORE_INVALID"]);
export const HOSTED_CODES = Object.freeze(["HRC_USAGE", "HRC_SECRET_SCOPE_VIOLATION", "HRC_INPUT_INVALID", "HRC_INPUT_INCOMPLETE", "HRC_REF_NOT_MAIN",
  "HRC_EXECUTE_CLOSED", "HRC_LAYOUT_INVALID", "HRC_SOURCE_UNREADABLE", "HRC_SOURCE_MISMATCH", "HRC_RUNNER_MISMATCH", "HRC_PLAN_HASH_MISMATCH",
  "HRC_DEPENDENCY_MISMATCH", "HRC_ENV_REFUSED", "HRC_TESTS_FAILED", "HRC_CHILD_FAILED", "HRC_IMPORT_FAILED", "HRC_CREDENTIALS_MISSING",
  "HRC_DB_TARGET_INVALID", "HRC_CA_INVALID", "HRC_INTERNAL", "PREFLIGHT_OK_REAL_PLAN", "PREFLIGHT_OK_SYNTHETIC_ONLY", "VERIFY_OK", "EXECUTE_DONE"]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INTENT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RID_RE = /^[1-9][0-9]{0,11}$/;
const PI_RE = /^pi_[A-Za-z0-9_]{8,250}$/;
const CHARGE_RE = /^(ch|py)_[A-Za-z0-9_]{8,200}$/;
const SESSION_RE = /^cs_test_[A-Za-z0-9]{8,96}$/;
const APPROVAL_RE = /^[A-Za-z0-9._:-]{1,80}$/;
const RUN_ID_RE = /^[A-Za-z0-9._:-]{8,64}$/;                                                     // ⊂ the accepted LABEL_RE (offline-charge-proof.js); the immutable hosted run id
const CANON_ID_RE = /^[1-9][0-9]{0,15}$/;                                                        // = the accepted canonical Hostaway charge id form
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SCHEDULED_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const HEX64 = /^[0-9a-f]{64}$/; const HEX40 = /^[0-9a-f]{40}$/;
const CODE_RE = /^[A-Za-z0-9_:>!.-]{1,80}$/;
const HOSTAWAY = "https://api.hostaway.com";
const LIST_LIMIT = 500;                                                                          // = the accepted LIST_LIMIT (asserted by the tests)
const freeze = Object.freeze;
class Refusal extends Error { constructor(code) { super("e7-hosted-recording"); this.code = code; } }
const refuse = (code) => { throw new Refusal(code); };
const sha = (s) => createHash("sha256").update(s).digest("hex");
function deepFreeze(v) { if (v && typeof v === "object") { for (const k of Object.keys(v)) deepFreeze(v[k]); freeze(v); } return v; }
const isVersion = (v) => Number.isSafeInteger(v) && v >= 1 && v <= 1000000;
const isAmount = (v) => Number.isSafeInteger(v) && v >= 1 && v <= 99999999;
const isGuests = (v) => Number.isSafeInteger(v) && v >= 1 && v <= 50;
const isoMs = (s) => (typeof s === "string" && ISO_RE.test(s) && Number.isFinite(Date.parse(s)) && new Date(Date.parse(s)).toISOString() === (s.length === 20 ? `${s.slice(0, 19)}.000Z` : s) ? Date.parse(s) : null);
const realDate = (s) => typeof s === "string" && DATE_RE.test(s) && Number.isFinite(Date.parse(`${s}T00:00:00Z`)) && new Date(Date.parse(`${s}T00:00:00Z`)).toISOString().slice(0, 10) === s;
const ms = (v) => (v === null || v === undefined ? null : new Date(v).getTime());
/** LABELLED COPY of the accepted offlineChargeTitle / exactAmount wire forms (cross-checked against the tooling's own functions by the tests) */
export const offlineChargeTitle = (intentId) => `maraVilla payment mvoch1-${intentId}`;
export const exactAmount = (minor) => { if (!isAmount(minor)) return null; const n = Number(`${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, "0")}`); return Number.isFinite(n) ? n : null; };
export const scheduledDateOf = (epochMs) => { if (!Number.isSafeInteger(epochMs) || epochMs <= 0) return null; const iso = new Date(epochMs).toISOString(); const s = `${iso.slice(0, 10)} ${iso.slice(11, 19)}`; return SCHEDULED_RE.test(s) ? s : null; };

// =================================================================================================================================
// plan (pure)
export const PLAN_INPUT_KEYS = freeze(["approvalRef", "intentId", "expectedVersion", "notBefore", "paymentIntentId", "reservationId", "chargeId", "capturedMinor", "from", "to", "guests", "attemptId", "sessionId"]);
/** buildPlan(c, { ...PLAN_INPUT_KEYS, runnerDigest }) → frozen { plan, planHash } */
export function buildPlan(c, { approvalRef, intentId, expectedVersion, notBefore, paymentIntentId, reservationId, chargeId, capturedMinor, from, to, guests, attemptId, sessionId, runnerDigest }) {
  if (typeof approvalRef !== "string" || !APPROVAL_RE.test(approvalRef)) refuse("HRC_INPUT_INVALID");
  if (typeof intentId !== "string" || !INTENT_RE.test(intentId) || !isVersion(expectedVersion)) refuse("HRC_INPUT_INVALID");
  if (isoMs(notBefore) === null) refuse("HRC_INPUT_INVALID");
  if (typeof paymentIntentId !== "string" || !PI_RE.test(paymentIntentId)) refuse("HRC_INPUT_INVALID");
  if (typeof reservationId !== "string" || !RID_RE.test(reservationId) || c.protectedReservationIds.includes(reservationId)) refuse("HRC_INPUT_INVALID");
  if (typeof chargeId !== "string" || !CHARGE_RE.test(chargeId) || !isAmount(capturedMinor) || exactAmount(capturedMinor) === null) refuse("HRC_INPUT_INVALID");
  if (!realDate(from) || !realDate(to) || !(from < to) || !isGuests(guests)) refuse("HRC_INPUT_INVALID");
  if (typeof attemptId !== "string" || !UUID_RE.test(attemptId) || typeof sessionId !== "string" || !SESSION_RE.test(sessionId)) refuse("HRC_INPUT_INVALID");
  if (typeof runnerDigest !== "string" || !HEX64.test(runnerDigest)) refuse("HRC_INPUT_INVALID");
  if (c.accountId !== "acct_1TyHE42B9LTneQgw" || c.listingId !== 606998 || c.currency !== "USD" || c.dbEnvironment !== "test" || c.paymentMethod !== "credit_card"
      || c.accountRef !== "hostaway-e7-test" || c.budgets.record !== 1 || c.budgets.steps !== 6 || c.budgets.runMs !== 10 * 60 * 1000
      || !(c.budgets.dbTeardownReserve > 0 && c.budgets.dbTeardownReserve < c.budgets.dbQueries)) refuse("HRC_INPUT_INVALID");   // code ceiling
  const plan = { schema: PLAN_SCHEMA, toolingCommit: c.toolingCommit, toolingStatus: c.toolingStatus, closureDigest: c.closureDigest, runnerDigest,
    pgVersion: c.pgVersion, listingId: c.listingId, currency: c.currency, refFieldId: c.refFieldId, listingTimeZone: c.listingTimeZone, dbEnvironment: c.dbEnvironment, dbProjectRef: c.dbProjectRef,
    intentId, expectedVersion, notBefore, paymentIntentId, reservationId, chargeId, capturedMinor, from, to, guests, attemptId, sessionId,
    paymentMethod: c.paymentMethod, accountRef: c.accountRef, recordingIdempotencyKey: `och:${intentId}:1`,           // = the accepted initial recording key; cross-checked against the row
    title: offlineChargeTitle(intentId), amount: exactAmount(capturedMinor),
    approvalRef, budgets: { ...c.budgets },
    operations: ["db.recording_worker_steps<=6", "hostaway.get_reservation(reservationId)", "hostaway.list_offline_charges(reservationId,500)", "hostaway.create_offline_charge(reservationId,title,amount,credit_card,paid,scheduledDate)<=1"],
    writes: { recordMax: 1, capture: 0, hostawayCreate: 0, cancel: 0, refund: 0, notify: 0, void: 0, account: 0, keys: 0, stripe: 0 } };
  return freeze({ plan: deepFreeze(plan), planHash: sha(canonical(plan)) });
}

// =================================================================================================================================
// DB reads (read-only SELECTs through the runtime login; no transaction held across a provider call)
const Q = freeze({
  instance: "/*e7hrc:instance*/ SELECT environment FROM booking.instance",
  attempts: "/*e7hrc:attempts*/ SELECT id::text AS id, status, checkout_session_id, payment_intent_id, livemode FROM booking.payment_attempts WHERE intent_id = $1 ORDER BY attempt",
  hostaway: "/*e7hrc:hostaway*/ SELECT state, hostaway_reservation_id::text AS rid FROM booking.hostaway_reservation_attempts WHERE intent_id = $1",
  ops: `/*e7hrc:ops*/ SELECT id::text AS id, op_type, state, attempts, idempotency_key, (dispatched_at IS NOT NULL) AS dispatched, (lease_worker_id IS NOT NULL OR lease_until IS NOT NULL) AS leased,
      late_result_status, result_ref, (settled_evidence_id IS NOT NULL) AS settled_evidence, payload ->> 'reservationId' AS payload_rid, payload ->> 'paymentIntentId' AS payload_pi,
      payload ->> 'chargeId' AS payload_charge, (payload ->> 'attempt')::int AS payload_attempt, (payload ->> 'amountMinor')::int AS payload_amount, payload ->> 'providerIdempotencyKey' AS payload_key,
      (SELECT count(*)::int FROM jsonb_object_keys(CASE WHEN jsonb_typeof(payload) = 'object' THEN payload ELSE '{}'::jsonb END)) AS payload_keys
      FROM booking.external_operations WHERE intent_id = $1 ORDER BY created_at, id`,
  holds: `/*e7hrc:holds*/ SELECT count(*)::int AS n FROM booking.recording_holds h JOIN booking.external_operations o ON o.id = h.operation_id WHERE o.intent_id = $1 AND h.released_at IS NULL`,
  cases: "/*e7hrc:cases*/ SELECT count(*)::int AS n FROM booking.reconciliation_cases WHERE intent_id = $1 AND status = 'open'",
  claims: "/*e7hrc:claims*/ SELECT listing_id, (released_at IS NOT NULL) AS released FROM booking.inventory_claims WHERE intent_id = $1",
  work: "/*e7hrc:work*/ SELECT (work_worker_id IS NOT NULL OR work_lease_until IS NOT NULL) AS leased FROM booking.intent_work WHERE intent_id = $1",
  ledger: "/*e7hrc:ledger*/ SELECT entry, amount_minor::text AS amt, currency, provider_ref FROM booking.payment_ledger WHERE intent_id = $1 ORDER BY id",
  evidence: "/*e7hrc:evidence*/ SELECT kind, external_ref, status, source, observed, observed_at FROM booking.provider_evidence WHERE intent_id = $1",   // C16: observed JSON + provenance for the stored refund-observation veto (read-only)
  row: "/*e7hrc:row*/ SELECT environment, reason_code, offline_charge_id, captured_minor::text AS cap FROM booking.intents WHERE id = $1",
  // = the accepted worker's recordedPaymentAt query (W-3): the DB-stamped UNIQUE entry into payment_captured
  recorded: `/*e7hrc:recorded*/ SELECT recorded_at FROM booking.intent_transitions WHERE intent_id = $1 AND to_state = 'payment_captured' AND from_state IS DISTINCT FROM 'payment_captured'`,
  // READ-ONLY schema prerequisite: the reviewed 0010–0017 recording objects (never applied here)
  schema: `/*e7hrc:schema*/ SELECT to_regprocedure('booking.complete_recording_with_evidence(uuid,text,uuid,text,integer)') IS NOT NULL AS complete_fn,
      to_regclass('booking.recording_holds') IS NOT NULL AS holds, to_regclass('booking.recording_assessments') IS NOT NULL AS assessments,
      to_regclass('booking.recording_claim_assessments') IS NOT NULL AS claim_assessments, booking.is_intent_state('confirmed') AS confirmed_state`,
  role: `/*e7hrc:role*/ SELECT pg_has_role(current_user, 'mv_booking_app', 'MEMBER') AS is_app, (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) AS privileged`,
  identity: "/*e7hrc:identity*/ SELECT current_database() AS db, (SELECT environment FROM booking.instance) AS environment"
});
export const QUERIES = Q;
const CAPTURE = "stripe.capture_payment_intent"; const RECORD = "hostaway.record_offline_charge"; const CREATE = "hostaway.create_reservation"; const NOTIFY = "guest.notify";
const ID_READ = "hostaway.retrieve_reservation"; const LIST_READ = "hostaway.list_offline_charges";
const READS = freeze(["stripe.retrieve_checkout_session", "stripe.retrieve_payment_intent", "hostaway.lookup_reservation", ID_READ, LIST_READ]);
const BEFORE_OPS = freeze(["stripe.create_checkout_session", CREATE, CAPTURE, RECORD, ...READS]);
const AFTER_OPS = freeze([...BEFORE_OPS, NOTIFY]);
const FORBIDDEN_OPS = freeze(["stripe.void_payment_intent", "hostaway.cancel_reservation", "stripe.refund_payment_intent", "alert.owner", "stripe.refund", "stripe.create_refund"]);
const pristine = (o) => o && o.state === "pending" && o.attempts === 0 && o.dispatched === false && o.leased === false && o.late_result_status === null;
const SCHEMA_FLAGS = freeze(["complete_fn", "holds", "assessments", "claim_assessments", "confirmed_state"]);

async function readFacts(q, plan, tooling, raw) {
  const inst = await q(Q.instance, []);
  const intent = await tooling.loadIntent(raw, plan.intentId);                                       // accepted repo read over the counted pool
  const attempts = await q(Q.attempts, [plan.intentId]);
  const hostaway = await q(Q.hostaway, [plan.intentId]);
  const ops = await q(Q.ops, [plan.intentId]);
  const holds = await q(Q.holds, [plan.intentId]);
  const cases = await q(Q.cases, [plan.intentId]);
  const claims = await q(Q.claims, [plan.intentId]);
  const work = await q(Q.work, [plan.intentId]);
  const ledger = await q(Q.ledger, [plan.intentId]);
  const evidence = await q(Q.evidence, [plan.intentId]);
  const row = await q(Q.row, [plan.intentId]);
  const recorded = await q(Q.recorded, [plan.intentId]);
  const schema = await q(Q.schema, []);
  return freeze({ instance: inst[0]?.environment ?? null, intent, attempts, hostaway, ops, openHolds: holds[0]?.n ?? null, openCases: cases[0]?.n ?? null, claims,
    workLeased: work.length === 1 ? work[0].leased : null, ledger, evidence, row: row[0] ?? null, recordedPaymentAt: recorded.length === 1 ? ms(recorded[0].recorded_at) : null,
    recordedCount: recorded.length, schema: schema[0] ?? null });
}
/** the facts every exit shares (scope, protection, binding to the PINNED pi / reservation / charge / amount / stay / attempt / session) → null | code */
function checkCommon(f, plan, c) {
  if (f.instance !== c.dbEnvironment) return "DATABASE_NOT_TEST";
  const i = f.intent;
  if (!i) return "INTENT_NOT_FOUND";
  if (!f.row || f.row.environment !== c.dbEnvironment) return "INTENT_NOT_TEST";
  if (i.listingId !== c.listingId) return "LISTING_NOT_SCOPED";
  if (!i.price || i.price.currency !== c.currency || !Number.isSafeInteger(i.price.finalTotalMinor) || i.price.finalTotalMinor <= 0) return "PRICE_NOT_SCOPED";
  if (!Number.isSafeInteger(i.createdAt) || i.createdAt < isoMs(plan.notBefore)) return "HISTORIC_INTENT";
  if (!i.payment || i.payment.livemode !== false || typeof i.payment.paymentIntentId !== "string") return "PAYMENT_NOT_TEST";
  if (i.payment.paymentIntentId !== plan.paymentIntentId) return "PAYMENT_INTENT_NOT_PINNED";
  if (i.payment.amountMinor !== i.price.finalTotalMinor || String(i.payment.currency || "").toUpperCase() !== c.currency) return "AUTHORIZED_AMOUNT_NOT_PRICE";
  if (i.price.finalTotalMinor !== plan.capturedMinor) return "AMOUNT_NOT_PINNED";
  if (i.payment.capturedMinor !== plan.capturedMinor || String(f.row.cap) !== String(plan.capturedMinor)) return "CAPTURED_AMOUNT_NOT_PINNED";
  if (i.from !== plan.from || i.to !== plan.to || i.guests !== plan.guests) return "STAY_NOT_PINNED";
  if (!i.checkout || i.checkout.sessionId !== plan.sessionId) return "SESSION_NOT_PINNED";
  if (!i.reservation || String(i.reservation.reservationId) !== plan.reservationId) return "RESERVATION_NOT_PINNED";
  if (c.protectedReservationIds.includes(String(i.reservation.reservationId))) return "PROTECTED_REFERENCE";
  if (f.hostaway.length !== 1 || String(f.hostaway[0].rid) !== plan.reservationId || !["succeeded", "reconciled_found"].includes(f.hostaway[0].state)) return "RESERVATION_ID_CONFLICT";
  for (const o of f.ops) { if (FORBIDDEN_OPS.includes(o.op_type)) return "FORBIDDEN_OP_PRESENT"; if (o.op_type === CREATE && String(o.result_ref ?? "") !== plan.reservationId) return "RESERVATION_ID_CONFLICT"; }
  const creates = f.ops.filter((o) => o.op_type === CREATE);
  if (creates.length !== 1 || creates[0].state !== "succeeded" || creates[0].dispatched !== true) return "CREATE_NOT_PROVEN_SUCCEEDED";
  const att = f.attempts;
  if (att.length !== 1 || att[0].id !== plan.attemptId || att[0].status !== "completed" || att[0].livemode !== false || att[0].payment_intent_id !== plan.paymentIntentId
      || att[0].checkout_session_id !== plan.sessionId) return "PAYMENT_ATTEMPT_NOT_BOUND";
  const caps = f.ops.filter((o) => o.op_type === CAPTURE);
  if (caps.length !== 1 || caps[0].state !== "succeeded" || caps[0].dispatched !== true || caps[0].attempts !== 1 || caps[0].late_result_status !== null) return "CAPTURE_NOT_PROVEN";
  if (String(caps[0].result_ref ?? "") !== plan.chargeId || caps[0].payload_pi !== plan.paymentIntentId || caps[0].payload_attempt !== 1 || caps[0].payload_amount !== plan.capturedMinor
      || caps[0].payload_key !== `cap:${plan.intentId}:${plan.paymentIntentId}`) return "CAPTURE_ROW_NOT_BOUND";
  const recs = f.ops.filter((o) => o.op_type === RECORD);
  if (recs.length !== 1 || recs[0].idempotency_key !== plan.recordingIdempotencyKey || recs[0].payload_rid !== plan.reservationId || recs[0].payload_amount !== plan.capturedMinor
      || recs[0].payload_keys !== 2) return "RECORDING_ROW_NOT_BOUND";
  if (f.claims.length !== 1 || f.claims[0].listing_id !== c.listingId) return "CLAIM_NOT_SCOPED";
  if (f.openCases !== 0) return "OPEN_CASE";
  const capLed = f.ledger.filter((l) => l.entry === "capture_succeeded");
  if (capLed.length !== 1 || capLed[0].amt !== String(plan.capturedMinor) || capLed[0].currency !== c.currency || capLed[0].provider_ref !== plan.paymentIntentId) return "LEDGER_MISMATCH";
  if (f.ledger.some((l) => ["refund_failed", "refund_succeeded", "authorization_voided"].includes(l.entry))) return "LEDGER_MISMATCH";
  for (const x of f.evidence) {
    if (x.kind === "payment_intent" && x.external_ref !== plan.paymentIntentId) return "EVIDENCE_CONFLICT";
    if (x.kind === "hostaway_reservation" && x.external_ref !== plan.reservationId && !(x.status === "not_found" && x.external_ref === i.ref)) return "EVIDENCE_CONFLICT";
    if (x.kind === "hostaway_offline_charges" && x.external_ref !== plan.reservationId) return "EVIDENCE_CONFLICT";
    if (x.kind === "stripe_refund") return "EVIDENCE_CONFLICT";
  }
  if (f.recordedCount !== 1 || f.recordedPaymentAt === null || scheduledDateOf(f.recordedPaymentAt) === null) return "RECORDED_PAYMENT_TIME_AMBIGUOUS";
  return null;
}
const schemaOk = (s) => !!s && SCHEMA_FLAGS.every((k) => s[k] === true);
// ---------------------------------------------------------------------------------------------
// C16 (ROOT #93 / 1a1d07e0): START VETO on STORED refund observations — defense-in-depth in this CLOSED wrapper only.
// ANY stored booking.provider_evidence row of kind payment_intent whose external_ref is EXACTLY the plan PI (any source, any age, regardless
// of newer zero-refund rows) whose observed JSON carries amountRefundedMinor as a POSITIVE safe integer OR refunded === true refuses
// PAYMENT_REFUND_OBSERVED. A row where either field is PRESENT but malformed (null / string / negative / non-finite / non-integer amount;
// non-boolean refunded) refuses PAYMENT_REFUND_EVIDENCE_INVALID — never coerced. Rows without these fields are UNKNOWN and change nothing:
// this veto supplies NO affirmative proof, widens no admission, adds no provider read, and is NOT a latest-only gate. A positive observation
// wins over a malformed one when both exist (either refuses).
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isPlainObj = (o) => o !== null && typeof o === "object" && !Array.isArray(o);
export const REFUND_OBSERVATION_FIELDS = freeze(["amountRefundedMinor", "refunded"]);
/** refundObservationRefusal(evidence, paymentIntentId) → null | "PAYMENT_REFUND_OBSERVED" | "PAYMENT_REFUND_EVIDENCE_INVALID" (pure; rows = the wrapper's evidence read) */
export function refundObservationRefusal(evidence, paymentIntentId) {
  let invalid = false;
  for (const x of Array.isArray(evidence) ? evidence : []) {
    if (!x || x.kind !== "payment_intent" || x.external_ref !== paymentIntentId) continue;      // only the plan PI; foreign PIs are EVIDENCE_CONFLICT elsewhere
    const o = x.observed;
    if (!isPlainObj(o)) continue;                                                               // no observed object → nothing known here
    if (hasOwn(o, "amountRefundedMinor")) {
      const a = o.amountRefundedMinor;
      if (typeof a !== "number" || !Number.isSafeInteger(a) || a < 0) invalid = true;           // null / string / negative / non-finite / non-integer
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
/** checkStart(f, plan, c) → { ok, intent, recordingOpId, scheduledDate } | { ok:false, code } — read-only admission (the accepted worker's own gates stay authoritative) */
export function checkStart(f, plan, c = CONSTANTS) {
  const no = (code) => freeze({ ok: false, code });
  const common = checkCommon(f, plan, c);
  if (common) return no(common);
  const i = f.intent;
  if (i.status !== "payment_captured") return no("STATE_NOT_PAYMENT_CAPTURED");
  if (i.version !== plan.expectedVersion) return no("VERSION_NOT_PINNED");
  if (i.reasonCode || f.row.reason_code) return no("REASON_CODE_PRESENT");
  if (i.lease) return no("RESERVATION_LEASE_HELD");
  if (f.workLeased !== false) return no("WORK_LEASE_HELD");
  const k = i.counters || {};
  if (k.captureAttempts !== 1 || (k.voidAttempts ?? 0) !== 0 || (k.cancelAttempts ?? 0) !== 0 || (k.offlineChargeAttempts ?? 0) !== 0) return no("HISTORY_NOT_INITIAL");
  if (f.row.offline_charge_id !== null || (i.offlineChargeId !== null && i.offlineChargeId !== undefined)) return no("OFFLINE_CHARGE_ALREADY_LINKED");
  for (const o of f.ops) if (!BEFORE_OPS.includes(o.op_type)) return no("UNEXPECTED_OP");
  for (const o of f.ops) if (READS.includes(o.op_type) && ["in_flight", "outcome_unknown"].includes(o.state)) return no("READ_HISTORY_UNSETTLED");
  const recs = f.ops.filter((o) => o.op_type === RECORD);
  if (recs.length !== 1 || !pristine(recs[0]) || recs[0].result_ref !== null || recs[0].settled_evidence !== false) return no("RECORDING_NOT_PRISTINE");
  if (f.openHolds !== 0) return no("RECORDING_HOLD_PRESENT");
  if (f.ledger.some((l) => l.entry === "offline_charge_recorded")) return no("LEDGER_MISMATCH");
  if (f.evidence.some((x) => x.kind === "hostaway_offline_charges" || (x.kind === "hostaway_reservation" && x.status === "cancelled"))) return no("EVIDENCE_CONFLICT");
  if (f.claims[0].released !== false) return no("CLAIM_NOT_HELD");
  const refundVeto = refundObservationRefusal(f.evidence, plan.paymentIntentId);                     // C16: stored refund observation → refuse (any source / age)
  if (refundVeto) return no(refundVeto);
  if (!schemaOk(f.schema)) return no("SCHEMA_PREREQUISITE_MISSING");
  return freeze({ ok: true, intent: i, recordingOpId: String(recs[0].id), scheduledDate: scheduledDateOf(f.recordedPaymentAt) });
}
/** checkEnd(f, plan, c, tooling?) → null | code — the persisted facts a completed recording must show (anything else = POSTCHECK_MISMATCH / RESIDUAL_*) */
export function checkEnd(f, plan, c = CONSTANTS, tooling = null) {
  const common = checkCommon(f, plan, c);
  if (common) return common;
  const i = f.intent;
  if (i.status !== "confirmed") return "STATE_NOT_CONFIRMED";
  if (i.version !== plan.expectedVersion + 1) return "VERSION_NOT_NEXT";
  if (i.reasonCode || f.row.reason_code) return "REASON_CODE_PRESENT";
  if (tooling && typeof tooling.publicStatus === "function" && tooling.publicStatus(i) !== "confirmed") return "PUBLIC_STATUS_NOT_CONFIRMED";
  for (const o of f.ops) if (!AFTER_OPS.includes(o.op_type)) return "UNEXPECTED_OP";
  const recs = f.ops.filter((o) => o.op_type === RECORD);
  if (recs.length !== 1 || recs[0].state !== "succeeded" || recs[0].attempts !== 1 || recs[0].dispatched !== true || recs[0].leased !== false || recs[0].late_result_status !== null
      || recs[0].settled_evidence !== true || !CANON_ID_RE.test(String(recs[0].result_ref ?? ""))) return "RECORDING_OP_NOT_SINGLE_SUCCEEDED";
  const chargeId = String(recs[0].result_ref);
  if (String(f.row.offline_charge_id ?? "") !== chargeId || String(i.offlineChargeId ?? "") !== chargeId) return "OFFLINE_CHARGE_NOT_LINKED";
  if (f.openHolds !== 0) return "RECORDING_HOLD_PRESENT";
  const notifies = f.ops.filter((o) => o.op_type === NOTIFY);
  if (notifies.length !== 1 || !pristine(notifies[0])) return "NOTIFY_NOT_SINGLE_PRISTINE";                 // queued ONCE, never dispatched by anything (P1: no send)
  const rl = f.ledger.filter((l) => l.entry === "offline_charge_recorded");
  if (rl.length !== 1 || rl[0].amt !== String(plan.capturedMinor) || rl[0].currency !== c.currency) return "RECORDING_NOT_LEDGERED";
  if (!f.evidence.some((x) => x.kind === "hostaway_offline_charges" && x.status === "listed" && x.external_ref === plan.reservationId)) return "RECORDING_EVIDENCE_MISSING";
  if (f.claims[0].released !== false) return "CLAIM_NOT_HELD";                                               // confirmed keeps the inventory claim (accepted state machine)
  return null;
}

// =================================================================================================================================
/**
 * runRecordingCore({ plan, planHash, runId, pool, lockClientFactory, tooling, exchanges, credentials, clock, monotonic, sleep, runSignal }) → frozen result.
 *  tooling = { runRecordingStep, loadIntent, createPhaseExecutors, createHostawaySend, validateAdapterConfig, unwrapEnvelope, normalizeReservation,
 *              activeReservationProof, assessChargeList, preflightListObservation, classifyTitle, providerIdToCanonical, amountToMinor, publicStatus, LOCK_KEY, LOCK_PRECHECK_SQL }
 *  lockClientFactory() → a dedicated checked-out client (query / release / on) for the session lock (pool.connect by default).
 */
export const TOOLING_KEYS = freeze(["runRecordingStep", "loadIntent", "createPhaseExecutors", "createHostawaySend", "validateAdapterConfig", "unwrapEnvelope", "normalizeReservation",
  "activeReservationProof", "assessChargeList", "preflightListObservation", "classifyTitle", "providerIdToCanonical", "amountToMinor", "publicStatus"]);
const CHARGE_TYPES = freeze(["charge", "preAuth", "refund"]);                                        // = the accepted CHARGE_TYPES (offline-charge-proof.js; asserted by the tests)
const ROW_STRING_FIELDS = freeze(["type", "title", "currency", "status", "paymentProvider", "paymentMethod"]);   // = the accepted ROW_STRING_FIELDS
const ROW_NULLABLE_STRING_FIELDS = freeze(["paymentProvider"]);   // = the accepted ROW_NULLABLE_STRING_FIELDS (C21-F1 at 4ed7a636): an EXPLICIT own null is a lawful UNRELATED-row value; the recorded row itself must still be "offline"
/**
 * FINAL (post-confirmation) charge-list readback (ROOT 5883758657 F1). The accepted assessChargeList assesses PAID-state facts only and the intent is now
 * confirmed, so — without fabricating intent state — the readback composes the ACCEPTED primitives: unwrapEnvelope, providerIdToCanonical, amountToMinor and
 * the NORMALIZED marker classifier classifyTitle (NFKC / case / invisible-character folding), plus a LABELLED COPY of assessChargeList's completeness rules
 * (count, row shape, foreign rows, duplicates, exact money). → null | code. Exactly ONE "exact" row, which is the recorded id with the pinned fields; ZERO
 * suspicious rows; no duplicate / foreign / malformed row anywhere on the page.
 */
export function finalListReadbackRefusal(lr, { tooling, intentId, reservationId, listingId, recordedId, title, amountMinor, currency, paymentMethod }) {
  if (!lr || lr.httpStatus !== 200) return "LIST_HTTP_STATUS";
  const env = tooling.unwrapEnvelope(lr.json);
  if (!env || env.ok !== true) return "LIST_ENVELOPE";
  const rows = env.result;
  if (!Array.isArray(rows)) return "LIST_RESULT_NOT_ARRAY";
  const count = lr.json.count;
  if (!Number.isSafeInteger(count) || count < 0 || count > LIST_LIMIT) return "LIST_COUNT_INVALID";
  if (rows.length !== count) return "LIST_COUNT_LENGTH_MISMATCH";
  const seen = new Set(); let exact = null; let exactCount = 0;
  for (let i = 0; i < rows.length; i++) {
    if (!Object.prototype.hasOwnProperty.call(rows, i) || rows[i] === null || typeof rows[i] !== "object" || Array.isArray(rows[i])) return "LIST_ROW_MALFORMED";
    const row = rows[i];
    const id = tooling.providerIdToCanonical(row.id);
    if (id === null) return "LIST_ROW_ID_INVALID";
    if (seen.has(id)) return "LIST_DUPLICATE_ID";
    seen.add(id);
    if (tooling.providerIdToCanonical(row.reservationId) !== reservationId) return "LIST_FOREIGN_RESERVATION_ROW";
    if (row.listingMapId !== listingId) return "LIST_FOREIGN_LISTING_ROW";
    for (const k of ROW_STRING_FIELDS) {
      if (typeof row[k] === "string") continue;
      if (row[k] === null && Object.prototype.hasOwnProperty.call(row, k) && ROW_NULLABLE_STRING_FIELDS.includes(k)) continue;   // = accepted assessChargeList (C21-F1)
      return `LIST_ROW_${k.toUpperCase()}_INVALID`;
    }
    if (!CHARGE_TYPES.includes(row.type)) return "LIST_ROW_TYPE_UNKNOWN";
    if (typeof row.amount !== "number" || !Number.isFinite(row.amount)) return "LIST_ROW_AMOUNT_INVALID";
    if (row.type === "refund" ? !(row.amount <= 0 && tooling.amountToMinor(-row.amount) !== null) : tooling.amountToMinor(row.amount) === null) return "LIST_ROW_AMOUNT_NOT_EXACT";
    const t = tooling.classifyTitle(row.title, intentId);                                            // the ACCEPTED normalized classifier (zero-width / case / NFKC folds)
    if (t === "suspicious") return "LOOKALIKE_CHARGE_PRESENT";
    if (t === "exact") { exactCount += 1; exact = { ...row, canonicalId: id }; }
  }
  if (exactCount !== 1) return exactCount === 0 ? "RECORDED_CHARGE_NOT_LISTED" : "DUPLICATE_MARKED_CHARGES";
  if (exact.canonicalId !== recordedId) return "RECORDED_ID_MISMATCH";
  if (exact.type !== "charge" || exact.status !== "paid" || exact.paymentProvider !== "offline" || exact.paymentMethod !== paymentMethod || exact.currency !== currency
      || exact.title !== title || tooling.amountToMinor(exact.amount) !== amountMinor) return "RECORDED_CHARGE_FIELDS";
  return null;
}
const RES_READ_OP = ID_READ;
// runner-read reservation observation (LABELLED COPY of the accepted reservation-worker observedReservation, NOT persisted as evidence) — Slice 3 F2
const observedReservation = (r) => ({ reservationId: String(r.reservationId), listingId: r.listingId, from: r.from, to: r.to, totalMinor: r.totalMinor, currency: r.currency, status: r.status,
  ...(r.bookingRef ? { bookingRef: r.bookingRef } : {}) });
const runnerResEvidence = (id, readOpType, requestRef, r, observedAt, extra = {}) => freeze({ id, kind: "hostaway_reservation", readOpType, requestRef, externalRef: String(r.reservationId),
  status: r.status === "cancelled" ? "cancelled" : "found_active", observed: { ...extra, ...observedReservation(r) }, observedAt });
/** the pure-module intent facts (LABELLED COPY of the accepted worker's loadFacts shape; recordedPaymentAt from the runner's identical query) */
const factsOf = (i, recordedPaymentAt) => freeze({ capturedMinor: i.payment ? i.payment.capturedMinor : null, currency: i.price ? i.price.currency : null,
  finalTotalMinor: i.price ? i.price.finalTotalMinor : null, from: i.from, intentId: i.id, listingId: i.listingId, recordedPaymentAt, ref: i.ref,
  reservationId: i.reservation ? String(i.reservation.reservationId) : null, status: i.status, to: i.to, version: i.version });
export async function runRecordingCore(input) {
  const c = CONSTANTS; const B = c.budgets;
  const r = { schema: RESULT_SCHEMA, outcome: null, code: null, startState: null, finalState: null, finalVersion: null, publicStatus: null, reservationId: null, capturedMinor: null, offlineChargeId: null,
    clientSnapshotId: null, steps: 0, actions: [], exchanges: 0, hostawayReads: 0, chargeLists: 0, dbQueries: 0, dbTeardownQueries: 0, dbBudgetRefused: 0, recordInvocations: 0, recordOutcome: "NONE",
    refusedAtTransport: 0, refusedByStop: 0, lock: "not_acquired", lockSession: null, lockBackendPid: null, proofs: [], postcheck: null, recordingOps: null, notifyOps: null, holds: null,
    claimHeld: null, factsObserved: false, stopReason: null, workerStop: null, writes: { record: 0, capture: 0, create: 0, cancel: 0, refund: 0, notify: 0, void: 0, stripe: 0 } };
  const DONE = Symbol("done");
  const done = (outcome, code = null) => { r.outcome = outcome; r.code = code; return DONE; };
  const snapshot = () => freeze(JSON.parse(JSON.stringify(r)));
  let stopReason = null; let runSignalRef = null; let monoRef = null; let endsAtRef = Infinity;
  let lockClient = null; let lockAcquired = false; let lockErrored = false; let lockPid = null; let deadlineTimer = null;
  // the runner-OWNED stop signal (Slice 3 F3) — passed to the accepted worker as ITS `signal` and part of EVERY composed transport signal; aborted
  // synchronously by the lock-session error listener and by every latched stop (PR72: the worker admits it at every awaited boundary)
  const stopAc = new AbortController();
  const stopped = () => {
    if (stopReason === null) {
      if (runSignalRef && runSignalRef.aborted) stopReason = "ABORTED";
      else if (lockErrored) stopReason = "LOCK_SESSION_ERROR";
      else if (monoRef && monoRef() >= endsAtRef) stopReason = "DEADLINE";
      if (stopReason !== null) { r.stopReason = stopReason; stopAc.abort(); }
    }
    return stopReason;
  };
  class Stopped extends Error { constructor() { super("stopped"); } }
  const guard = () => { if (stopped()) throw new Stopped(); };
  /** a failed runner DB read: a latched stop → the stop outcome; the counted ceiling → BUDGET_EXHAUSTED (honest, F2); anything else → DB_ERROR/<site> */
  const dbFail = (e, site) => (e instanceof Stopped ? stopOutcome() : e instanceof Refusal && e.code === "DB_BUDGET" ? done(uncertain() ?? "BUDGET_EXHAUSTED", "DB_QUERY_CEILING") : done(uncertain() ?? "DB_ERROR", site));
  /** a possibly-sent write without an admissible reply dominates every later exit (never hidden behind a stop code) */
  const uncertain = () => (r.recordOutcome === "UNKNOWN" ? "WRITE_OUTCOME_UNKNOWN" : null);
  const stopOutcome = () => done(uncertain() ?? (stopReason === "LOCK_SESSION_ERROR" ? "LOCK_LOST" : stopReason), `STOP_${stopReason}`);
  const observe = (f) => {
    if (!f || !f.intent) return;
    r.factsObserved = true; r.finalState = f.intent.status; r.finalVersion = f.intent.version;
    r.publicStatus = input && input.tooling && typeof input.tooling.publicStatus === "function" ? String(input.tooling.publicStatus(f.intent)) : null;
    r.reservationId = f.intent.reservation && f.intent.reservation.reservationId !== null && f.intent.reservation.reservationId !== undefined ? String(f.intent.reservation.reservationId) : null;
    r.capturedMinor = f.intent.payment ? f.intent.payment.capturedMinor ?? null : null;
    r.offlineChargeId = f.row && f.row.offline_charge_id !== null && f.row.offline_charge_id !== undefined ? String(f.row.offline_charge_id) : null;
    r.recordingOps = f.ops.filter((o) => o.op_type === RECORD).map((o) => o.state);
    r.notifyOps = f.ops.filter((o) => o.op_type === NOTIFY).map((o) => (pristine(o) ? "pristine" : o.state));
    r.holds = f.openHolds;
    r.claimHeld = f.claims.length === 1 ? f.claims[0].released === false : null;
  };
  // ---- (1) LABELLED COPY + F2 (ROOT 5883758657): ONE counted pool for EVERY statement of the session — runner reads, worker, lock session, the teardown
  // residual read and the unlock. `limit` is the body ceiling (total − reserve) until the teardown, then the TOTAL; refused statements never execute.
  const pool0 = input && input.pool && typeof input.pool.query === "function" ? input.pool : null;
  let limit = B.dbQueries - B.dbTeardownReserve;
  const count = () => { if (r.dbQueries >= limit) { r.dbBudgetRefused += 1; throw new Refusal("DB_BUDGET"); } r.dbQueries += 1; };
  const countedPool = pool0 ? {
    query: (...a) => { count(); return pool0.query(...a); },
    connect: async () => { const cl = await pool0.connect(); const q = cl.query.bind(cl);
      return { query: (...a) => { count(); return q(...a); }, release: (...a) => cl.release(...a), on: (...a) => (typeof cl.on === "function" ? cl.on(...a) : undefined),
        removeListener: (...a) => (typeof cl.removeListener === "function" ? cl.removeListener(...a) : undefined) }; }
  } : null;
  const body = async () => {
    const { plan, planHash, runId, pool, tooling, exchanges, credentials } = input ?? {};
    if (!plan || plan.schema !== PLAN_SCHEMA || plan.listingId !== c.listingId || plan.currency !== c.currency || plan.paymentMethod !== c.paymentMethod || plan.accountRef !== c.accountRef
        || !INTENT_RE.test(String(plan.intentId)) || !isVersion(plan.expectedVersion) || isoMs(plan.notBefore) === null || !PI_RE.test(String(plan.paymentIntentId))
        || !RID_RE.test(String(plan.reservationId)) || c.protectedReservationIds.includes(String(plan.reservationId)) || !CHARGE_RE.test(String(plan.chargeId)) || !isAmount(plan.capturedMinor)
        || plan.amount !== exactAmount(plan.capturedMinor) || plan.title !== offlineChargeTitle(plan.intentId) || !realDate(plan.from) || !realDate(plan.to) || !(plan.from < plan.to)
        || !isGuests(plan.guests) || !UUID_RE.test(String(plan.attemptId)) || !SESSION_RE.test(String(plan.sessionId)) || plan.recordingIdempotencyKey !== `och:${plan.intentId}:1`
        || plan.intentId === c.synthetic.intentId || typeof planHash !== "string" || sha(canonical(plan)) !== planHash || typeof runId !== "string" || !RUN_ID_RE.test(runId)
        || !pool || typeof pool.query !== "function" || !tooling || !exchanges || typeof exchanges.hostaway !== "function" || "stripe" in exchanges
        || !credentials || typeof credentials.hostaway !== "function" || "stripe" in credentials) return done("CORE_INVALID");
    for (const k of TOOLING_KEYS) if (typeof tooling[k] !== "function") return done("CORE_INVALID", "TOOLING_INVALID");
    if (typeof tooling.LOCK_KEY !== "string" || typeof tooling.LOCK_PRECHECK_SQL !== "string") return done("CORE_INVALID", "TOOLING_INVALID");
    r.clientSnapshotId = runId;
    const clock = input.clock ?? (() => Date.now());
    const mono = input.monotonic ?? (() => performance.now());
    const runSignal = input.runSignal ?? null;
    const endsAt = mono() + B.runMs;
    runSignalRef = runSignal; monoRef = mono; endsAtRef = endsAt;
    const sleep = input.sleep ?? ((t) => new Promise((res) => { const h = setTimeout(res, t); runSignal?.addEventListener?.("abort", () => { clearTimeout(h); res(); }, { once: true }); }));
    const lockClientFactory = input.lockClientFactory ?? (() => pool.connect());
    // SYNCHRONOUS latching (ROOT 5883328669): the run abort and the wall deadline abort the runner-owned signal the moment they happen (not at the next gate),
    // so the accepted worker's bounded calls / admission checks and every fenced transport observe them immediately; lock loss latches in onLockErr below
    if (runSignal && typeof runSignal.addEventListener === "function") { if (runSignal.aborted) stopped(); else runSignal.addEventListener("abort", () => { stopped(); }, { once: true }); }
    deadlineTimer = setTimeout(() => { stopped(); }, Math.max(1, Math.floor(endsAt - mono())));

    const q = async (sql, params) => { guard(); const res = await countedPool.query(sql, params); return res.rows; };
    const read = () => readFacts(q, plan, tooling, { query: (sql, params) => { guard(); return countedPool.query(sql, params); } });

    // ---- (2) read-only start check: the pins are RE-READ and cross-checked; the schema prerequisite is READ, never applied -------------------------
    let f;
    try { f = await read(); } catch (e) { return dbFail(e, "START_READ_FAILED"); }
    r.startState = f.intent ? f.intent.status : null;
    const st = checkStart(f, plan, c);
    if (!st.ok) return done(st.code === "SCHEMA_PREREQUISITE_MISSING" ? "SCHEMA_PREREQUISITE_MISSING"
      : ["STATE_NOT_PAYMENT_CAPTURED", "VERSION_NOT_PINNED", "HISTORIC_INTENT", "RESERVATION_LEASE_HELD", "WORK_LEASE_HELD", "RECORDING_NOT_PRISTINE", "HISTORY_NOT_INITIAL",
        "REASON_CODE_PRESENT", "READ_HISTORY_UNSETTLED", "RECORDING_HOLD_PRESENT", "OFFLINE_CHARGE_ALREADY_LINKED", "RECORDED_PAYMENT_TIME_AMBIGUOUS"].includes(st.code) ? "START_STATE_NOT_ELIGIBLE" : "SCOPE_REFUSED", st.code);
    const intent0 = st.intent; const RID = plan.reservationId; const scheduledDate = st.scheduledDate;
    const facts0 = factsOf(intent0, f.recordedPaymentAt);

    // ---- (3) LABELLED COPY (Slice 1 §3, F4): the P3 session lock on a DEDICATED client; pid-stable proof ------------------------------------------
    try { lockClient = await lockClientFactory(); } catch { return done("DB_ERROR", "LOCK_CONNECT_FAILED"); }
    const onLockErr = () => { lockErrored = true; r.lockSession = "error_observed"; stopAc.abort(); stopped(); };   // synchronous abort of the worker's / transports' signal
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
    } catch (e) { return dbFail(e, "LOCK_QUERY_FAILED"); }
    const lockLost = (e) => (dbFail(e, "LOCK_PROOF_FAILED"));
    const proveLock = async (tag) => {
      try { if (!(await ownLock())) { r.lock = "lost"; return done(uncertain() ?? "LOCK_LOST", lockErrored ? "LOCK_SESSION_ERROR" : r.lockSession === "backend_hop" ? "BACKEND_HOP" : "LOCK_NOT_HELD"); } }
      catch (e) { return lockLost(e); }
      if (stopped()) return stopOutcome();                                                           // after the awaited proof
      r.proofs.push(tag);
      return null;
    };

    // ---- (4) LABELLED COPY: DB identity on the lock session AND the pool (same database, TEST instance); app role ----------------------------
    try {
      const a = await lockQuery(Q.identity, []); const b = await q(Q.identity, []);
      if (a.rows.length !== 1 || b.length !== 1 || a.rows[0].db !== b[0].db || a.rows[0].environment !== c.dbEnvironment || b[0].environment !== c.dbEnvironment) return done("DB_IDENTITY_MISMATCH", "POOLS_MISMATCH");
      const role = await q(Q.role, []);
      if (role.length !== 1 || role[0].privileged !== false || role[0].is_app !== true) return done("SCOPE_REFUSED", "ROLE_NOT_APP");
    } catch (e) { return dbFail(e, "IDENTITY_READ_FAILED"); }

    // ---- (5) the target-only transport fence (recording phase, Hostaway ONLY): exact URL / method / headers / body; counters BEFORE the exchange ---
    const urls = { reservation: `${HOSTAWAY}/v1/reservations/${RID}`, list: `${HOSTAWAY}/v1/guestPayments/charges?limit=${LIST_LIMIT}&reservationIds=${RID}`, post: `${HOSTAWAY}/v1/guestPayments/charges/${RID}` };
    const fence = { recordOpen: false, recordExchanged: false };
    const hkeys = (h) => Object.keys(h).sort().join(",");
    /** the ONE admissible POST body, FIELD-EXACT: parsed JSON with exactly the five accepted keys and the pinned values (scheduledDate from the admission read) */
    const exactBody = (body) => {
      if (typeof body !== "string" || body.length > 2048) return false;
      let x; try { x = JSON.parse(body); } catch { return false; }
      if (!x || typeof x !== "object" || Array.isArray(x) || Object.keys(x).sort().join(",") !== "amount,paymentMethod,scheduledDate,status,title") return false;
      return x.title === plan.title && x.amount === plan.amount && x.paymentMethod === c.paymentMethod && x.status === "paid" && x.scheduledDate === scheduledDate;
    };
    const hostawayGate = (req) => {
      if (stopped()) { r.refusedByStop += 1; return Promise.reject(new Error("stopped")); }
      if (!req || !req.headers || r.exchanges >= B.exchanges) { r.refusedAtTransport += 1; return Promise.reject(new Error("gate")); }
      const plainGet = req.method === "GET" && req.body === null && hkeys(req.headers) === "Accept,Authorization,Cache-control";
      const isPost = req.method === "POST" && req.url === urls.post && hkeys(req.headers) === "Accept,Authorization,Cache-control,Content-Type"
        && req.headers["Content-Type"] === "application/json" && exactBody(req.body);
      if (plainGet && req.url === urls.reservation && r.hostawayReads < B.hostawayReads) r.hostawayReads += 1;        // ONLY the pinned reservation id
      else if (plainGet && req.url === urls.list && r.chargeLists < B.chargeLists) r.chargeLists += 1;                // ONLY the pinned reservation's charge list (H8 wire)
      else if (isPost && fence.recordOpen && !fence.recordExchanged) fence.recordExchanged = true;                    // the ONE record: exact URL / method / headers / body
      else { r.refusedAtTransport += 1; return Promise.reject(new Error("gate")); }                                   // no other Hostaway exchange, ever (no create / cancel / refund / message)
      r.exchanges += 1;
      return exchanges.hostaway(req);
    };
    const th = tooling.createHostawaySend({ exchange: hostawayGate, credential: credentials.hostaway });
    if (!th || th.ok !== true) return done("CORE_INVALID", "TRANSPORT_INVALID");
    const composed = (sig) => {
      const parts = [stopAc.signal];                                                                  // the runner-owned stop first
      if (sig instanceof AbortSignal) parts.push(sig);
      if (runSignal instanceof AbortSignal) parts.push(runSignal);
      parts.push(AbortSignal.timeout(Math.max(1, Math.floor(endsAt - mono()))));
      return AbortSignal.any(parts);
    };
    const adapterConfig = tooling.validateAdapterConfig({ allowedListingIds: [c.listingId], refFieldId: c.refFieldId, channelId: 2000, currency: c.currency });
    const cfg = freeze({ accountRef: c.accountRef, channelId: 2000, currency: c.currency, listingId: c.listingId, paymentMethod: c.paymentMethod, refFieldId: c.refFieldId });

    // ---- (6) the bound ACTIVE reservation + ONE preflight charge LIST (reads only, runner-read, never persisted) BEFORE the worker --------------------
    try {
      guard();
      const rr = await th.transport.send({ method: "GET", path: `/v1/reservations/${RID}`, query: {} }, { signal: composed(null) });
      if (!rr || rr.httpStatus !== 200) return done("PROVIDER_PROOF_FAILED", `RESERVATION_READ_${Number.isSafeInteger(rr && rr.httpStatus) ? rr.httpStatus : "FAILED"}`);
      const env = tooling.unwrapEnvelope(rr.json);
      if (!env || env.ok !== true) return done("PROVIDER_PROOF_FAILED", "RESERVATION_ENVELOPE");
      const nr = tooling.normalizeReservation(env.result, adapterConfig);
      if (!nr || nr.ok !== true) return done("PROVIDER_PROOF_FAILED", "RESERVATION_MALFORMED");
      if (nr.reservation.channelId !== 2000) return done("PROVIDER_PROOF_FAILED", "RESERVATION_CHANNEL_NOT_DIRECT");
      const byId = runnerResEvidence("runner-res-by-id", RES_READ_OP, RID, nr.reservation, clock());
      // the ACCEPTED recording worker requires the booking ref ECHOED on the reservation (assessIdentitySnapshot → IDENTITY_REF_MISMATCH otherwise; it has no
      // by-ref lookup): a reservation without the echoed ref is refused HERE, before any worker read / hold (measured on disposable PG: 3 refused reads → HOLD)
      if (byId.observed.bookingRef === undefined) return done("PROVIDER_PROOF_FAILED", "REF_NOT_ECHOED");
      const ap = tooling.activeReservationProof({ intent: intent0, byId, byRef: null, now: clock(), notBefore: isoMs(plan.notBefore) });
      if (!ap || ap.ok !== true) return done("PROVIDER_PROOF_FAILED", ap && CODE_RE.test(String(ap.code)) ? `RESERVATION_${String(ap.code)}` : "RESERVATION_PROOF");
      guard();
      // ONE preflight charge list assessed with the ACCEPTED pure module: complete page, ZERO marker / lookalike / same-amount rows (the worker re-reads its own)
      const lr = await th.transport.send({ method: "GET", path: "/v1/guestPayments/charges", query: { limit: LIST_LIMIT, reservationId: RID } }, { signal: composed(null) });
      if (!lr || !Number.isSafeInteger(lr.httpStatus)) return done("PROVIDER_PROOF_FAILED", "LIST_READ_FAILED");
      const T = clock();
      const list = tooling.assessChargeList({ read: { accountRef: c.accountRef, clientSnapshotId: runId, httpStatus: lr.httpStatus, json: lr.json, observedAt: T, request: { limit: LIST_LIMIT, reservationId: RID } },
        intent: facts0, config: cfg, now: T });
      if (!list || list.ok !== true) return done("PROVIDER_PROOF_FAILED", list && CODE_RE.test(String(list.code)) ? String(list.code) : "LIST_ASSESSMENT");
      const obs = tooling.preflightListObservation({ list, intent: facts0, config: cfg });
      if (!obs || obs.ok === false) return done("PROVIDER_PROOF_FAILED", obs && CODE_RE.test(String(obs.code)) ? String(obs.code) : "LIST_OBSERVATION");
      if (obs.matchingChargeCount !== 0 || obs.lookalikeCount !== 0 || obs.sameAmountPaidCount !== 0) return done("PROVIDER_PROOF_FAILED", obs.matchingChargeCount !== 0 ? "PRIOR_MARKED_CHARGE_PRESENT" : obs.lookalikeCount !== 0 ? "LOOKALIKE_CHARGE_PRESENT" : "SAME_AMOUNT_CHARGE_PRESENT");
      r.proofs.push("PROVIDER_BEFORE_WORKER");
    } catch (e) { if (e instanceof Stopped || stopped()) return stopOutcome(); return done("PROVIDER_PROOF_FAILED", "READ_FAILED"); }

    // ---- (7) the ACCEPTED recording executors over the fence; the ONE write counted and fenced BEFORE the transport -----------------------------------
    const hostawaySend = async (req, opts) => {
      if (stopped()) { r.refusedByStop += 1; throw new Error("stopped"); }
      const o = { ...(opts && typeof opts === "object" ? opts : {}), signal: composed(opts && opts.signal) };
      if (req && req.method === "POST") {
        if (req.path !== `/v1/guestPayments/charges/${RID}`) { r.refusedAtTransport += 1; throw new Error("path refused"); }        // the ONE record path, nothing else
        if (r.recordInvocations >= B.record || stopped()) { r.refusedAtTransport += 1; throw new Error("record budget"); }           // counter fence BEFORE the transport
        r.recordInvocations += 1; r.writes.record += 1; fence.recordOpen = true;
        try {
          const out = await th.transport.send(req, o);
          r.recordOutcome = out && typeof out === "object" && Number.isSafeInteger(out.httpStatus) ? "REPLIED" : "UNKNOWN";
          return out;
        } catch (e) { r.recordOutcome = fence.recordExchanged ? "UNKNOWN" : "NOT_SENT"; throw e; }
        finally { fence.recordOpen = false; }
      }
      if (!req || req.method !== "GET") { r.refusedAtTransport += 1; throw new Error("method refused"); }                               // GET or the ONE POST, nothing else
      return th.transport.send(req, o);
    };
    const bx = tooling.createPhaseExecutors({ phase: "recording", binding: { listingId: c.listingId, reservationId: RID, intentId: plan.intentId, amountMinor: plan.capturedMinor,
      paymentMethod: c.paymentMethod, accountRef: c.accountRef, clientSnapshotId: runId }, hostaway: { send: hostawaySend } });
    if (!bx || bx.ok !== true) return done("SCOPE_REFUSED", "EXECUTOR_BINDING_REFUSED");
    const executors = { label: bx.executors.label };
    for (const k of ["retrieveReservation", "listOfflineCharges", "createOfflineCharge"]) { const fn = bx.executors[k]; executors[k] = async (...args) => { if (stopped()) { r.refusedByStop += 1; throw new Error("stopped"); } return Reflect.apply(fn, undefined, args); }; }
    freeze(executors);
    const listings = new Map([[c.listingId, { ...cfg }]]);
    const workerEnv = { VERCEL_ENV: "development", MV_E7_RECORDING_WORKER: "enabled" };

    // ---- (8) LABELLED COPY (Slice 3 §9): bounded worker steps; lock proven before EVERY step; stop after the awaited proof and before the worker ------
    let finalFacts = null;
    for (let step = 1; step <= B.steps; step++) {
      if (stopped()) return stopOutcome();
      { const p = await proveLock(step === 1 ? "BEFORE_WORKER" : `BEFORE_STEP_${step}`); if (p) return p; }
      let w;
      if (stopped()) return stopOutcome();                                                            // immediately BEFORE the worker is admitted
      try {
        r.steps += 1;
        w = await tooling.runRecordingStep(countedPool, { workerId: `e7-hosted-rc:${plan.approvalRef}`, env: workerEnv, listings, executors, clock, intentId: plan.intentId,
          signal: stopAc.signal, deadlineAt: clock() + Math.max(0, Math.floor(endsAt - mono())), monotonic: mono });
      } catch (e) {
        if (e instanceof Refusal && e.code === "DB_BUDGET") return done(uncertain() ?? "BUDGET_EXHAUSTED", "DB_QUERY_CEILING");
        if (stopped()) return stopOutcome();
        return done(uncertain() ?? "DB_ERROR", "WORKER_THREW");
      }
      for (const a of (w && Array.isArray(w.actions) ? w.actions : [])) if (r.actions.length < 200 && CODE_RE.test(String(a))) r.actions.push(String(a));
      if (w && w.stop && typeof w.stop === "object" && CODE_RE.test(String(w.stop.code)) && CODE_RE.test(String(w.stop.where))) r.workerStop = { code: String(w.stop.code), where: String(w.stop.where) };
      if (w && w.late) await Promise.race([Promise.resolve(w.late).catch(() => {}), sleep(1000)]);                 // dropped late replies are never success
      if (!w || w.status === "refused") return done(uncertain() ?? "WORKER_REFUSED", w && CODE_RE.test(String(w.code)) ? String(w.code) : "WORKER_REFUSED");
      if (uncertain()) { try { finalFacts = await read(); observe(finalFacts); } catch { /* reported below */ } return done("WRITE_OUTCOME_UNKNOWN", "LOST_RECORD_REPLY"); }
      if (stopped()) return stopOutcome();
      try { f = await read(); } catch (e) { return dbFail(e, "STEP_READBACK_FAILED"); }
      observe(f);
      if (stopped()) return stopOutcome();
      const stNow = f.intent ? f.intent.status : null;
      if (r.recordingOps.some((s) => s === "outcome_unknown")) { finalFacts = f; return done("WRITE_OUTCOME_UNKNOWN", "WORKER_SETTLED_UNKNOWN"); }   // v1: the session stops; never a resend
      if (stNow === "confirmed") { finalFacts = f; break; }
      if (stNow === "reconciliation_required") { finalFacts = f; return done("RECORDING_ESCALATED", "OWNER_CASE"); }
      if (stNow !== "payment_captured") { finalFacts = f; return done("RECORDING_UNKNOWN_STATE", `STATE_${String(stNow).toUpperCase()}`); }
      if (f.openHolds !== 0) { finalFacts = f; return done("RECORDING_HELD", "HOLD_OPEN"); }                                                       // owner review; no resend
      if (r.recordingOps.some((s) => s === "in_flight")) { finalFacts = f; return done("WRITE_OUTCOME_UNKNOWN", "WRITE_ROW_IN_FLIGHT"); }
      if (r.recordInvocations > 0 && !r.recordingOps.some((s) => s === "succeeded")) { finalFacts = f; return done("WRITE_OUTCOME_UNKNOWN", "RECORD_SENT_WITHOUT_SETTLEMENT"); }
      if (r.recordingOps.some((s) => s === "succeeded") && stNow === "payment_captured" && step === B.steps) { finalFacts = f; return done("STEP_BUDGET_EXHAUSTED", "SUCCEEDED_EVENT_PENDING"); }
      if (step === B.steps) { finalFacts = f; return done("STEP_BUDGET_EXHAUSTED", "STEPS"); }
      const delay = w.status === "worked" && Number.isSafeInteger(w.delayMs) ? Math.min(Math.max(w.delayMs, 0), B.waitCapMs) : Math.min(5000, B.waitCapMs);
      const left = endsAt - mono();
      if (left <= delay) { r.stopReason = "DEADLINE"; stopReason = "DEADLINE"; stopAc.abort(); return stopOutcome(); }
      await sleep(delay);
    }

    // ---- (9) read-only postcheck: output and persisted facts must agree; then a fresh LIST readback (reads only): exactly ONE marked charge = the id ----
    observe(finalFacts);
    const pe = checkEnd(finalFacts, plan, c, tooling);
    if (pe) return done("POSTCHECK_MISMATCH", pe);
    const recordedId = String(finalFacts.ops.find((o) => o.op_type === RECORD).result_ref);
    { const p = await proveLock("BEFORE_READBACK"); if (p) return p; }
    try {
      guard();
      const lr = await th.transport.send({ method: "GET", path: "/v1/guestPayments/charges", query: { limit: LIST_LIMIT, reservationId: RID } }, { signal: composed(null) });
      // F1: the accepted complete-list / normalized-marker rules over the fresh page; exactly the recorded id with the pinned fields, zero lookalikes
      const fr = finalListReadbackRefusal(lr, { tooling, intentId: plan.intentId, reservationId: RID, listingId: c.listingId, recordedId, title: plan.title, amountMinor: plan.capturedMinor,
        currency: c.currency, paymentMethod: c.paymentMethod });
      if (fr) return done("POSTCHECK_MISMATCH", `READBACK_${fr}`);
      r.proofs.push("READBACK");
    } catch (e) { if (e instanceof Stopped || stopped()) return stopOutcome(); return done("POSTCHECK_MISMATCH", "READBACK_FAILED"); }
    r.postcheck = { recordingOps: 1, offlineChargeId: recordedId, capturedMinor: finalFacts.intent.payment.capturedMinor, notifyQueuedPristine: 1, holds: 0, claimHeld: true, openCases: 0, publicStatus: "confirmed" };
    if (stopped()) return stopOutcome();
    return done("RECORDING_CONFIRMED");
  };
  // LABELLED COPY (Slice 3 finally): bounded residual read, provisional success re-validated, checked unlock on the dedicated session
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
    // F2: the teardown spends ONLY the reserve (what is left of the TOTAL); every residual statement and the unlock are counted; past the ceiling nothing is issued
    limit = B.dbQueries;
    const teardownStart = r.dbQueries;
    if (r.steps > 0 && countedPool && input.tooling) {
      const raw = { query: (sql, params) => countedPool.query(sql, params) };
      const b = await bounded(readFacts(async (sql, params) => (await countedPool.query(sql, params)).rows, input.plan, input.tooling, raw));
      if (b.done && !b.threw) observe(b.value);
      if (r.outcome === "RECORDING_CONFIRMED") {
        const re = b.done && !b.threw ? checkEnd(b.value, input.plan, CONSTANTS, input.tooling) : "RESIDUAL_READ_UNAVAILABLE";
        if (re) { r.outcome = "NOT_CONFIRMED"; r.code = re === "RESIDUAL_READ_UNAVAILABLE" ? re : `RESIDUAL_${re}`; r.postcheck = null; }
      }
    }
    if (lockClient) {
      let released = false;
      if (lockAcquired && !lockErrored) {
        const unlock = () => { count(); return lockClient.query("SELECT pg_advisory_unlock(pg_catalog.hashtext($1), 0) AS ok, pg_catalog.pg_backend_pid() AS pid", [input?.tooling?.LOCK_KEY ?? ""]); };
        const u = await bounded(Promise.resolve().then(unlock));
        released = u.done && !u.threw && u.value && u.value.rows && u.value.rows.length === 1 && u.value.rows[0].ok === true && String(u.value.rows[0].pid) === lockPid && !lockErrored;
      }
      if (lockAcquired) r.lock = released ? "released" : (lockErrored ? "session_error_connection_destroyed" : "unlock_failed_connection_destroyed");
      try { lockClient.release(released ? undefined : true); } catch { /* contained */ }
      if (lockAcquired && !released && r.outcome === "RECORDING_CONFIRMED") { r.outcome = "NOT_CONFIRMED"; r.code = lockErrored ? "LOCK_SESSION_ERROR_AT_TEARDOWN" : "UNLOCK_NOT_PROVEN"; }
    }
    if (r.outcome === "RECORDING_CONFIRMED" && stopped()) { r.outcome = "NOT_CONFIRMED"; r.code = `STOP_${stopReason}_AT_TEARDOWN`; }
    r.dbTeardownQueries = r.dbQueries - teardownStart;
    if (deadlineTimer) clearTimeout(deadlineTimer);
  }
  return snapshot();
}

// =================================================================================================================================
// hosted wrapper (GitHub Actions): preflight (no secrets) / verify / execute (CLOSED: HRC_EXECUTE_CLOSED whenever executeEnabled is false; reopened only by a reviewed flag PR after an owner decision)
// LABELLED COPY of the reviewed Slice 3 runHosted, specialised: recording closure / runner files, HRC_ codes, Hostaway-only secrets, two pools (6543 / 5432).
export const CLOSURE_DIGEST_PREFIX = "e7-hosted-recording-closure-v1\n";
export const RUNNER_DIGEST_PREFIX = "e7-hosted-recording-runner-v1\n";
const TEST_FILE = "test/e7-hosted-recording.test.mjs";
const SECRET_KEYS = Object.freeze(["E7_HOSTAWAY_TOKEN", "E7_DEV_BOOKING_DATABASE_URL"]);
const FOREIGN_SECRET_KEYS = Object.freeze(["E7_STRIPE_TEST_KEY"]);                                   // never admitted in ANY mode of this runner (no Stripe)
export const INPUT_ENV = freeze({ approvalRef: "E7_APPROVAL_REF", intentId: "E7_INTENT_ID", expectedVersion: "E7_EXPECTED_VERSION", notBefore: "E7_NOT_BEFORE", paymentIntentId: "E7_PAYMENT_INTENT_ID",
  reservationId: "E7_RESERVATION_ID", chargeId: "E7_CHARGE_ID", capturedMinor: "E7_CAPTURED_MINOR", from: "E7_STAY_FROM", to: "E7_STAY_TO", guests: "E7_GUESTS", attemptId: "E7_ATTEMPT_ID", sessionId: "E7_SESSION_ID" });
export const RUN_ID_ENV = "E7_RUN_ID";

/** runHosted({ mode, env, proc, wrapperDir, deps }) → { exitCode, result }. Never throws. deps = TEST SEAMS. */
export async function runHosted({ mode = "preflight", env, proc, wrapperDir, deps = {} }) {
  const c = deps.constants ?? CONSTANTS;
  const spawnChild = deps.spawnChild ?? spawnNode;
  const importEnv = deps.importEnv ?? ((dir) => import(pathToFileURL(`${dir}/scripts/e7-connected/probe-env-preflight.mjs`).href));
  const importTooling = deps.importTooling ?? defaultImportTooling;
  const runCore = deps.runCore ?? runRecordingCore;
  const readPgVersion = deps.readPgVersion ?? (async (dir) => JSON.parse(await readFile(`${dir}/node_modules/pg/package.json`, "utf8")).version);
  const readCa = deps.readCa ?? ((p) => readFile(p));
  const r = { schema: "e7-hosted-recording-hosted-v1", mode: null, code: null, workflowSha: null, toolingCommit: c.toolingCommit, toolingStatus: c.toolingStatus,
    executeEnabled: c.executeEnabled, closureDigest: null, runnerDigest: null, planKind: null, planHash: null, runId: null, envCode: null, tests: null, lockEndpoint: null, core: null };
  let pool = null; let lockPool = null;
  try {
    if (!["preflight", "verify", "execute"].includes(mode)) refuse("HRC_USAGE");
    r.mode = mode;
    r.workflowSha = HEX40.test(env.E7_WORKFLOW_SHA ?? "") ? env.E7_WORKFLOW_SHA : null;
    const has = (k) => typeof env[k] === "string" && env[k].length > 0;
    if (FOREIGN_SECRET_KEYS.some(has)) refuse("HRC_SECRET_SCOPE_VIOLATION");
    if (mode !== "execute" && SECRET_KEYS.some(has)) refuse("HRC_SECRET_SCOPE_VIOLATION");
    const inp = {}; for (const k of PLAN_INPUT_KEYS) inp[k] = env[INPUT_ENV[k]] ?? "";
    const expPlan = env.E7_EXPECTED_PLAN_HASH ?? ""; const expClo = env.E7_EXPECTED_CLOSURE_DIGEST ?? ""; const expRun = env.E7_EXPECTED_RUNNER_DIGEST ?? "";
    const vals = PLAN_INPUT_KEYS.map((k) => inp[k]); const anyReal = vals.some((v) => v !== "");
    if (anyReal && vals.some((v) => v === "")) refuse("HRC_INPUT_INCOMPLETE");
    if (anyReal && (!APPROVAL_RE.test(inp.approvalRef) || !INTENT_RE.test(inp.intentId) || !/^[1-9][0-9]{0,6}$/.test(inp.expectedVersion) || isoMs(inp.notBefore) === null || !PI_RE.test(inp.paymentIntentId)
        || !RID_RE.test(inp.reservationId) || !CHARGE_RE.test(inp.chargeId) || !/^[1-9][0-9]{0,7}$/.test(inp.capturedMinor) || !realDate(inp.from) || !realDate(inp.to) || !/^[1-9][0-9]?$/.test(inp.guests)
        || !UUID_RE.test(inp.attemptId) || !SESSION_RE.test(inp.sessionId))) refuse("HRC_INPUT_INVALID");
    if (inp.approvalRef === c.synthetic.approvalRef || inp.intentId === c.synthetic.intentId) refuse("HRC_INPUT_INVALID");
    const runId = env[RUN_ID_ENV] ?? "";
    if (mode !== "preflight") {
      if (c.executeEnabled !== true || c.toolingStatus !== "MERGED" || !HEX64.test(String(c.closureDigest))) refuse("HRC_EXECUTE_CLOSED");   // Slice 4: refuses whenever the flag is false; the flag alone is never consent (gate + owner decision + fresh proofs)
      if (!anyReal || !HEX64.test(expPlan) || !HEX64.test(expClo) || !HEX64.test(expRun)) refuse("HRC_INPUT_INCOMPLETE");
      if (!RUN_ID_RE.test(runId)) refuse("HRC_INPUT_INVALID");
      if (env.GITHUB_REF !== "refs/heads/main") refuse("HRC_REF_NOT_MAIN");
      if (expClo !== c.closureDigest) refuse("HRC_SOURCE_MISMATCH");
    }
    const tooling = await realpath(env.E7_TOOLING_DIR ?? "").catch(() => refuse("HRC_LAYOUT_INVALID"));
    const wdir = await realpath(wrapperDir).catch(() => refuse("HRC_LAYOUT_INVALID"));
    if (tooling === wdir || tooling.startsWith(`${wdir}/`) || wdir.startsWith(`${tooling}/`)) refuse("HRC_LAYOUT_INVALID");
    r.closureDigest = await framedDigest(tooling, c.closure, CLOSURE_DIGEST_PREFIX).catch(() => refuse("HRC_SOURCE_UNREADABLE"));
    if (r.closureDigest !== c.closureDigest) refuse("HRC_SOURCE_MISMATCH");
    r.runnerDigest = await framedDigest(wdir, c.runnerFiles, RUNNER_DIGEST_PREFIX).catch(() => refuse("HRC_SOURCE_UNREADABLE"));
    if (mode !== "preflight" && r.runnerDigest !== expRun) refuse("HRC_RUNNER_MISMATCH");
    r.planKind = anyReal ? "REAL" : "SYNTHETIC";
    const s = c.synthetic;
    const built = buildPlan(c, anyReal ? { ...inp, expectedVersion: Number(inp.expectedVersion), capturedMinor: Number(inp.capturedMinor), guests: Number(inp.guests), runnerDigest: r.runnerDigest }
      : { ...s, runnerDigest: r.runnerDigest });
    r.planHash = built.planHash;
    if (mode !== "preflight" && built.planHash !== expPlan) refuse("HRC_PLAN_HASH_MISMATCH");
    let C1; try { C1 = await importEnv(tooling); } catch { refuse("HRC_IMPORT_FAILED"); }
    const present = Object.fromEntries(C1.PRESENT_KEYS.map((k) => [k, Object.hasOwn(env, k)]));
    let uid = null; try { if (typeof proc.getuid === "function") { const u = proc.getuid(); if (Number.isSafeInteger(u) && u >= 0) uid = u; } } catch { uid = null; }
    const ev = C1.evaluateProbeEnvironment({ schema: C1.ENV_SNAPSHOT_SCHEMA, nodeVersion: String(proc.versions.node), platform: proc.platform,
      execArgvCount: proc.execArgv.length, uidAvailable: uid !== null, present });
    r.envCode = typeof ev.code === "string" && C1.ENV_CODES.includes(ev.code) ? ev.code : "REDACTED";
    if (ev.ok !== true || proc.versions.node !== c.nodeVersion) refuse("HRC_ENV_REFUSED");
    if (mode === "preflight") {
      const o = await spawnChild(["--test", "--test-reporter=tap", TEST_FILE], { cwd: wdir, env: childEnv(env, tooling) });
      if (!o || o.spawnFailed || (o.signal !== null && o.signal !== undefined) || !Number.isSafeInteger(o.status) || o.truncated) refuse("HRC_CHILD_FAILED");
      const num = (re) => { const m = re.exec(o.stdout); return m ? Number(m[1]) : null; };
      r.tests = { status: o.status, tests: num(/^# tests (\d+)$/m), pass: num(/^# pass (\d+)$/m), fail: num(/^# fail (\d+)$/m), connectivityEvidence: false };
      if (o.status !== 0 || !(r.tests.tests > 0) || r.tests.pass !== r.tests.tests || r.tests.fail !== 0) refuse("HRC_TESTS_FAILED");
      r.code = anyReal ? "PREFLIGHT_OK_REAL_PLAN" : "PREFLIGHT_OK_SYNTHETIC_ONLY"; return { exitCode: 0, result: r };
    }
    if (mode === "verify") { r.code = "VERIFY_OK"; return { exitCode: 0, result: r }; }
    r.runId = runId;
    if (!SECRET_KEYS.every(has)) refuse("HRC_CREDENTIALS_MISSING");
    let pgv; try { pgv = await readPgVersion(tooling); } catch { pgv = null; }
    if (pgv !== c.pgVersion) refuse("HRC_DEPENDENCY_MISMATCH");
    let htok = env.E7_HOSTAWAY_TOKEN; delete env.E7_HOSTAWAY_TOKEN;
    let dbUrl = env.E7_DEV_BOOKING_DATABASE_URL; delete env.E7_DEV_BOOKING_DATABASE_URL;
    const wipe = () => { htok = null; dbUrl = null; };
    if (!dbTargetOk(dbUrl, c)) { wipe(); refuse("HRC_DB_TARGET_INVALID"); }
    let caPem = null;
    try { const b = await readCa(env.E7_CA_FILE ?? ""); if (sha(b) === (deps.caSha256 ?? OFFICIAL_CA_SHA256) && b.length < 16384) caPem = b.toString("utf8"); } catch { caPem = null; }
    if (caPem === null) { wipe(); refuse("HRC_CA_INVALID"); }
    let mods; try { mods = await importTooling(tooling); } catch { wipe(); refuse("HRC_IMPORT_FAILED"); }
    const xh = mods.X.createE7RealExchange({ provider: "hostaway" });
    if (!xh || xh.ok !== true) { wipe(); refuse("HRC_IMPORT_FAILED"); }
    let lockUrl = sessionLockUrl(dbUrl, c);
    if (lockUrl === null) { wipe(); refuse("HRC_DB_TARGET_INVALID"); }
    try {
      pool = mods.createBookingPool({ connectionString: dbUrl, caPem, max: 3 });                      // worker pool: transaction pooler (6543)
      lockPool = mods.createBookingPool({ connectionString: lockUrl, caPem, max: 1 });                // dedicated SESSION lock connection (5432)
    } catch { wipe(); refuse("HRC_DB_TARGET_INVALID"); } finally { dbUrl = null; lockUrl = null; }
    r.lockEndpoint = `session:${SESSION_LOCK_PORT}`;
    const ac = new AbortController(); const onSig = () => ac.abort(); proc.once?.("SIGINT", onSig); proc.once?.("SIGTERM", onSig);
    try {
      r.core = await runCore({ plan: built.plan, planHash: built.planHash, runId, pool, lockClientFactory: () => lockPool.connect(), tooling: mods.tooling, exchanges: { hostaway: xh.exchange },
        credentials: { hostaway: () => htok }, runSignal: ac.signal });
    } finally { wipe(); proc.off?.("SIGINT", onSig); proc.off?.("SIGTERM", onSig); }
    r.code = "EXECUTE_DONE";
    return { exitCode: r.core && r.core.outcome === "RECORDING_CONFIRMED" ? 0 : 1, result: r };
  } catch (e) {
    r.code = e instanceof Refusal && HOSTED_CODES.includes(e.code) ? e.code : "HRC_INTERNAL";
    return { exitCode: 1, result: r };
  } finally {
    if (lockPool) await lockPool.end().catch(() => {});
    if (pool) await pool.end().catch(() => {});
  }
}
async function defaultImportTooling(dir) {
  const u = (p) => pathToFileURL(`${dir}/${p}`).href;
  const [W, R, EX, T, X, P, HR, CO, OP, IS, LK] = await Promise.all([import(u("lib/booking-db/recording-worker.js")), import(u("lib/booking-db/repo.js")),
    import(u("scripts/e7-connected/executor-adapters.mjs")), import(u("scripts/e7-connected/http-transports.mjs")), import(u("scripts/e7-connected/real-exchange.mjs")),
    import(u("lib/booking-db/pool.js")), import(u("lib/hostaway-reservations.js")), import(u("lib/checkout/compensation-proof.js")), import(u("lib/checkout/offline-charge-proof.js")),
    import(u("lib/checkout/intent-state.js")), import(u("scripts/e7-connected/run-lock-precheck.mjs"))]);
  return { X, createBookingPool: P.createBookingPool,
    tooling: { runRecordingStep: W.runRecordingStep, loadIntent: R.loadIntent, createPhaseExecutors: EX.createPhaseExecutors, createHostawaySend: T.createE7HostawaySend,
      validateAdapterConfig: HR.validateAdapterConfig, unwrapEnvelope: HR.unwrapEnvelope, normalizeReservation: HR.normalizeReservation,
      activeReservationProof: CO.activeReservationProof, assessChargeList: OP.assessChargeList, preflightListObservation: OP.preflightListObservation, classifyTitle: OP.classifyTitle,
      providerIdToCanonical: OP.providerIdToCanonical, amountToMinor: HR.amountToMinor, publicStatus: IS.publicStatus,
      LOCK_KEY: LK.LOCK_KEY, LOCK_PRECHECK_SQL: LK.LOCK_PRECHECK_SQL } };
}
export function summaryMarkdown(r) {
  const core = r.core ? ` core=${r.core.outcome}${r.core.code ? `/${r.core.code}` : ""} steps=${r.core.steps} record=${r.core.recordInvocations}/${r.core.recordOutcome} lock=${r.core.lock} publicStatus=${r.core.publicStatus} offlineChargeId=${r.core.offlineChargeId ?? "-"}` : "";
  return `e7-hosted-recording ${r.mode} ${r.code} executeEnabled=${r.executeEnabled} lock=${r.lockEndpoint ?? "-"} plan=${r.planKind ?? "-"}:${r.planHash ?? "-"} runId=${r.runId ?? "-"} closure=${r.closureDigest ?? "-"} runner=${r.runnerDigest ?? "-"}${core}\n`;
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
