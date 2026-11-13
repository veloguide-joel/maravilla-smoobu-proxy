// scripts/e7-hosted-test-cleanup.mjs — E7 Slice 3: HOSTED (GitHub Actions) captured-TEST CLEANUP for ONE admitted TEST intent:
// payment_captured → (ONE accepted requestTestCleanup, lib/booking-db/test-cleanup.js) → test_cleanup_pending → (the ACCEPTED cleanup worker,
// runTestCleanupStep at the immutable tooling commit: ONE host-cancel PUT, then ONE bound FULL refund POST, each proven by a confirming READ) →
// cancelled / not_completed_refunded, on the TEST DEV database, with FAKE-free real transports.
//
// HONEST LABEL: MANUAL hosted TEST cleanup (workflow_dispatch + the existing reviewer gate), NOT automatic customer checkout and NOT a customer
// refund path. Code is NOT consent: executeEnabled is CLOSED here (verify / execute refuse HTC_EXECUTE_CLOSED); the Slice 1 / Slice 2 runners stay
// CLOSED and pinned to THEIR tooling; this runner pins the LATER immutable MERGED e7-test tooling 9d86bfa1 (0019 + 0020 + the cleanup worker).
//   * Inert on import (`import.meta.main` guard): no env / fs / network / DB / timer until a mode runs.
//   * LABELLED SPECIALISATION of the reviewed Slice 2 runner (scripts/e7-hosted-capture.mjs): the hosted boot / pinning / session-lock (5432) /
//     counted pool / stop latch / fence / step / postcheck / teardown sections are LABELLED COPIES specialised to the cleanup phase (pure helpers
//     imported from ./e7-hosted-reservation.mjs). The request (requestTestCleanup) and the worker (runTestCleanupStep) are the ACCEPTED modules,
//     never copied or rebuilt; the executors / transports are the ISOLATED accepted test-cleanup modules (never executor-adapters' refund-free phases).
//   * Exact pins (plan hash): approval label, intent UUID, expected version, not-before (never a historic intent), the bound PaymentIntent id, the
//     bound Hostaway reservation id, the bound charge id, the EXACT captured amount, the stay (from / to / guests), the completed payment attempt id
//     and the Checkout Session id (the accepted 17-key operator expectation is DERIVED from the plan + its hash, never read from the DB); fixed
//     listing 606998 / USD / ref field / Stripe TEST account / Stripe-Version / DEV project ref; the accepted refund key ref:<intent>:1.
//     The pins are RE-READ from the database and cross-checked before anything else (CORE_INVALID / SCOPE_REFUSED on any mismatch).
//   * Admission (read-only, before the lock): payment_captured at the pinned version, ONE succeeded capture row (attempt 1, the pinned charge /
//     amount / accepted key), ONE recording row PRISTINE (pending / attempts 0 / never dispatched), capturedMinor = price = pin, ZERO notification /
//     void / cancel / refund rows, ZERO payment_refunds, the capture ledgered once, no refund / void / offline-charge ledger or evidence, no
//     reservation lease / work lease / open case, the claim held, TEST livemode, and the READ-ONLY schema prerequisite: the reviewed 0019 + 0020
//     functions present and test_cleanup_pending accepted — NEVER auto-migrated (SCHEMA_PREREQUISITE_MISSING refuses before any write).
//   * Order: start check → P3 session lock on a DEDICATED 5432 session (pid-stable proof before every step) → DB identity / role → account + fresh
//     STRICT captured-and-UNREFUNDED Stripe proof (identity + raw aggregates) + the bound ACTIVE future-arrival reservation read → ONE
//     requestTestCleanup → exact lineage check (test_cleanup_pending, version +1, ONE pristine cancel + ONE pristine bound refund row, the recording
//     retired, ONE 'requested' refund record, claim held) → bounded worker steps behind a target-only transport fence → read-only postcheck +
//     fresh bound Refund GET + fully-refunded PI readback + cancelled reservation readback → residual read re-validated at teardown.
//   * Fence (counted BEFORE the transport, every other write refused in-process): Stripe GET account / GET the bound PI / GET refunds/{re_} /
//     GET refunds?payment_intent=<bound>&limit=100, and AT MOST ONE POST /v1/refunds with the EXACT body (bound PI, exact amount, both discovery
//     metadata fields) and the accepted Idempotency-Key; Hostaway GET the bound reservation id / THIS arrival's lookup page, and AT MOST ONE
//     PUT …/reservations/<bound>/statuses/cancelled with the accepted body.
//   * v1 STOP on: refusal, deadline, lock loss / backend hop / session error, identity mismatch, request throw (REQUEST_OUTCOME_UNKNOWN: never
//     repeated blindly), a possibly-sent write without an admissible reply (WRITE_OUTCOME_UNKNOWN: the session stops, the persisted facts are
//     reported; a future resume needs its OWN pinned admission / review — no second mode here), escalation, budget, cancellation.
//   * Never: capture, void, create, offline-charge recording, notification, queue draining, historical intents, protected reservation ids.
//   * rev2 (ROOT review 5881490593): F1 complete state-independent v3 PI proofs at BOTH runner boundaries (runner-local LABELLED adapter mirroring the
//     accepted capturedChargeRefusal + accepted piIdentityOk + raw safeguards, unrefunded before / fully refunded after); F2 the accepted
//     activeReservationProof over runner-read (non-persisted, labelled) observations incl. total / channel / ref, missing ref → ONE bounded
//     accepted lookupByRef proving exactly this reservation; F3 a runner-owned AbortController in EVERY composed worker / transport signal,
//     aborted synchronously by the lock-session error listener and by every latched stop.
import process from "node:process";
import { readFile, realpath } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { CONSTANTS as RES, canonical, framedDigest, childEnv, spawnNode, dbTargetOk, sessionLockUrl, SESSION_LOCK_PORT, OFFICIAL_CA_SHA256 } from "./e7-hosted-reservation.mjs";

export const CONSTANTS = Object.freeze({
  toolingCommit: "9d86bfa1e60779b3794de88bbae151670e8fe515",    // e7-test: PR67 (0019 foundation) + PR68 (cleanup worker / 0020) MERGED; immutable
  toolingStatus: "MERGED",
  executeEnabled: true,                                           // Slice 3: cleanup execution OPENED for the ONE reviewed owner-present hosted TEST (ROOT prep GO 2026-11-13); revert to false after
  // the INDEPENDENTLY scanned transitive relative imports of the runner's tooling roots at 9d86bfa1 (test C2 recomputes this from the pinned tree):
  // = Slice 1 closure − executor-adapters.mjs − offline-charge-proof.js + the cleanup worker / request / proof / isolated executors + transports
  closure: Object.freeze(["lib/bookability.js", "lib/booking-db/cleanup-worker.js", "lib/booking-db/codec.js", "lib/booking-db/config.js", "lib/booking-db/operations.js",
    "lib/booking-db/pool.js", "lib/booking-db/recovery.js", "lib/booking-db/repo.js", "lib/booking-db/reservation-worker.js", "lib/booking-db/test-cleanup.js",
    "lib/checkout/capture-proof.js", "lib/checkout/compensation-proof.js", "lib/checkout/final-price.js", "lib/checkout/intent-state.js", "lib/checkout/recovery-plan.js",
    "lib/checkout/server-pricer.js", "lib/checkout/test-cleanup-proof.js", "lib/direct-policy.js", "lib/direct-pricing.js", "lib/hostaway-calendar.js",
    "lib/hostaway-reservations.js", "lib/hostaway.js", "lib/public-api.js", "lib/quote-public.js", "package-lock.json", "package.json",
    "scripts/e7-connected/http-transports.mjs", "scripts/e7-connected/probe-env-preflight.mjs", "scripts/e7-connected/real-exchange.mjs",
    "scripts/e7-connected/run-lock-precheck.mjs", "scripts/e7-connected/test-cleanup-executors.mjs", "scripts/e7-connected/test-cleanup-transports.mjs"]),
  closureDigest: "f84b4157d88c4d4a3756c61040daa30e19323d7ba17b75a7764b0b22b3740ee7",
  pgVersion: "8.18.0",                                            // package-lock.json at 9d86bfa1 (checked against node_modules/pg before execute)
  runnerFiles: Object.freeze(["scripts/e7-hosted-test-cleanup.mjs", "scripts/e7-hosted-reservation.mjs", ".github/workflows/e7-hosted-test-cleanup.yml", "test/e7-hosted-test-cleanup.test.mjs"]),
  accountId: RES.accountId, listingId: RES.listingId, currency: RES.currency, refFieldId: RES.refFieldId, listingTimeZone: RES.listingTimeZone,
  stripeVersion: RES.stripeVersion, protectedReservationIds: RES.protectedReservationIds,
  // worker: the happy cleanup is TWO steps (cancel leg: RES read → account → PI → ONE PUT → confirming RES read; refund leg: account → PI → ONE POST →
  // Refund GET → confirming PI read) with a 30 s wait between them; waits are honoured (capped). dbQueries = EVERY statement on the counted pool
  // (runner reads + the ONE request + worker + lock session). Measured on disposable PG16 with the REAL request + worker (test I1):
  // 286 (ref echoed) / 318 (ref not echoed: + by-ref lookup pages) statements, 16 / 22 exchanges (Hostaway reads 4, lookup pages 0 / 6 incl. the runner's
  // own F2 pre-request lookup, account 3, PI 5, refund reads 2, lists 0), 2 steps; ceilings ≈ 3x the larger measured value (the worker's own per-kind
  // read admission stays authoritative). Fail-closed past them.
  budgets: Object.freeze({ steps: 16, cancel: 1, refund: 1, hostawayReads: 12, lookupPages: 18, accountReads: 9, piReads: 15, refundReads: 8, refundLists: 4,
    exchanges: 66, dbQueries: 960, runMs: 15 * 60 * 1000, waitCapMs: 35 * 1000 }),
  dbEnvironment: RES.dbEnvironment, dbProjectRef: RES.dbProjectRef, nodeVersion: RES.nodeVersion,
  synthetic: Object.freeze({ approvalRef: "SYNTHETIC-test-cleanup-preflight-not-for-execute", intentId: "00000000-0000-4000-8000-000000000000", expectedVersion: 8,
    notBefore: "2026-11-12T00:00:00.000Z", paymentIntentId: "pi_SYNTHETIC00000000000000", reservationId: "1", chargeId: "ch_SYNTHETIC00000000000000", capturedMinor: 1,
    from: "2027-01-01", to: "2027-01-02", guests: 1, attemptId: "00000000-0000-4000-8000-000000000001", sessionId: "cs_test_SYNTHETIC0000000000" })
});
export const PLAN_SCHEMA = "e7-hosted-test-cleanup-plan-v1";
export const RESULT_SCHEMA = "e7-hosted-test-cleanup-result-v1";
export const OUTCOMES = Object.freeze(["TEST_CLEANUP_COMPLETED", "SCOPE_REFUSED", "START_STATE_NOT_ELIGIBLE", "SCHEMA_PREREQUISITE_MISSING", "LOCK_NOT_ACQUIRED", "LOCK_LOST",
  "DB_IDENTITY_MISMATCH", "PROVIDER_PROOF_FAILED", "REQUEST_REFUSED", "REQUEST_OUTCOME_UNKNOWN", "LINEAGE_MISMATCH", "WORKER_REFUSED", "WRITE_OUTCOME_UNKNOWN",
  "CLEANUP_ESCALATED", "CLEANUP_UNKNOWN_STATE", "STEP_BUDGET_EXHAUSTED", "BUDGET_EXHAUSTED", "DEADLINE", "ABORTED", "DB_ERROR", "POSTCHECK_MISMATCH", "NOT_CONFIRMED", "CORE_INVALID"]);
export const HOSTED_CODES = Object.freeze(["HTC_USAGE", "HTC_SECRET_SCOPE_VIOLATION", "HTC_INPUT_INVALID", "HTC_INPUT_INCOMPLETE", "HTC_REF_NOT_MAIN",
  "HTC_EXECUTE_CLOSED", "HTC_LAYOUT_INVALID", "HTC_SOURCE_UNREADABLE", "HTC_SOURCE_MISMATCH", "HTC_RUNNER_MISMATCH", "HTC_PLAN_HASH_MISMATCH",
  "HTC_DEPENDENCY_MISMATCH", "HTC_ENV_REFUSED", "HTC_TESTS_FAILED", "HTC_CHILD_FAILED", "HTC_IMPORT_FAILED", "HTC_CREDENTIALS_MISSING",
  "HTC_DB_TARGET_INVALID", "HTC_CA_INVALID", "HTC_INTERNAL", "PREFLIGHT_OK_REAL_PLAN", "PREFLIGHT_OK_SYNTHETIC_ONLY", "VERIFY_OK", "EXECUTE_DONE"]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;            // = the accepted request's UUID rule (attempt ids are v4 or DB-generated)
const INTENT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RID_RE = /^[1-9][0-9]{0,11}$/;                                                           // = the accepted request's RES_RE
const PI_RE = /^pi_[A-Za-z0-9_]{8,250}$/;
const CHARGE_RE = /^(ch|py)_[A-Za-z0-9_]{8,200}$/;
const SESSION_RE = /^cs_test_[A-Za-z0-9]{8,96}$/;
const REFUND_RE = /^re_[A-Za-z0-9_]{1,200}$/;
const APPROVAL_RE = /^[A-Za-z0-9._:-]{1,80}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HEX64 = /^[0-9a-f]{64}$/; const HEX40 = /^[0-9a-f]{40}$/;
const CODE_RE = /^[A-Za-z0-9_:>!.-]{1,80}$/;
const STRIPE = "https://api.stripe.com"; const HOSTAWAY = "https://api.hostaway.com";
const CANCEL_BODY_WIRE = JSON.stringify({ cancelledBy: "host" });                                 // = the accepted CANCEL_BODY (compensation-proof.js) as the transport serialises it
const TEST_CLEANUP_REASON = "TEST_CLEANUP_REQUESTED";
const freeze = Object.freeze;
class Refusal extends Error { constructor(code) { super("e7-hosted-test-cleanup"); this.code = code; } }
const refuse = (code) => { throw new Refusal(code); };
const sha = (s) => createHash("sha256").update(s).digest("hex");
function deepFreeze(v) { if (v && typeof v === "object") { for (const k of Object.keys(v)) deepFreeze(v[k]); freeze(v); } return v; }
const isVersion = (v) => Number.isSafeInteger(v) && v >= 1 && v <= 1000000;
const isAmount = (v) => Number.isSafeInteger(v) && v >= 1 && v <= 99999999;
const isGuests = (v) => Number.isSafeInteger(v) && v >= 1 && v <= 50;
const isoMs = (s) => (typeof s === "string" && ISO_RE.test(s) && Number.isFinite(Date.parse(s)) && new Date(Date.parse(s)).toISOString() === (s.length === 20 ? `${s.slice(0, 19)}.000Z` : s) ? Date.parse(s) : null);
const realDate = (s) => typeof s === "string" && DATE_RE.test(s) && Number.isFinite(Date.parse(`${s}T00:00:00Z`)) && new Date(Date.parse(`${s}T00:00:00Z`)).toISOString().slice(0, 10) === s;
const enc = (v) => encodeURIComponent(String(v));

// =================================================================================================================================
// plan (pure)
export const PLAN_INPUT_KEYS = freeze(["approvalRef", "intentId", "expectedVersion", "notBefore", "paymentIntentId", "reservationId", "chargeId", "capturedMinor", "from", "to", "guests", "attemptId", "sessionId"]);
/** buildPlan(c, { ...PLAN_INPUT_KEYS, runnerDigest }) → frozen { plan, planHash } */
export function buildPlan(c, { approvalRef, intentId, expectedVersion, notBefore, paymentIntentId, reservationId, chargeId, capturedMinor, from, to, guests, attemptId, sessionId, runnerDigest }) {
  if (typeof approvalRef !== "string" || !APPROVAL_RE.test(approvalRef)) refuse("HTC_INPUT_INVALID");
  if (typeof intentId !== "string" || !INTENT_RE.test(intentId) || !isVersion(expectedVersion)) refuse("HTC_INPUT_INVALID");
  if (isoMs(notBefore) === null) refuse("HTC_INPUT_INVALID");
  if (typeof paymentIntentId !== "string" || !PI_RE.test(paymentIntentId)) refuse("HTC_INPUT_INVALID");
  if (typeof reservationId !== "string" || !RID_RE.test(reservationId) || c.protectedReservationIds.includes(reservationId)) refuse("HTC_INPUT_INVALID");
  if (typeof chargeId !== "string" || !CHARGE_RE.test(chargeId) || !isAmount(capturedMinor)) refuse("HTC_INPUT_INVALID");
  if (!realDate(from) || !realDate(to) || !(from < to) || !isGuests(guests)) refuse("HTC_INPUT_INVALID");
  if (typeof attemptId !== "string" || !UUID_RE.test(attemptId) || typeof sessionId !== "string" || !SESSION_RE.test(sessionId)) refuse("HTC_INPUT_INVALID");
  if (typeof runnerDigest !== "string" || !HEX64.test(runnerDigest)) refuse("HTC_INPUT_INVALID");
  if (c.accountId !== "acct_1TyHE42B9LTneQgw" || c.listingId !== 606998 || c.currency !== "USD" || c.stripeVersion !== "2026-01-28.clover" || c.dbEnvironment !== "test"
      || c.budgets.cancel !== 1 || c.budgets.refund !== 1 || c.budgets.steps !== 16 || c.budgets.runMs !== 15 * 60 * 1000) refuse("HTC_INPUT_INVALID");      // code ceiling
  const plan = { schema: PLAN_SCHEMA, toolingCommit: c.toolingCommit, toolingStatus: c.toolingStatus, closureDigest: c.closureDigest, runnerDigest,
    pgVersion: c.pgVersion, stripeVersion: c.stripeVersion, accountId: c.accountId, listingId: c.listingId, currency: c.currency, refFieldId: c.refFieldId,
    listingTimeZone: c.listingTimeZone, dbEnvironment: c.dbEnvironment, dbProjectRef: c.dbProjectRef,
    intentId, expectedVersion, notBefore, paymentIntentId, reservationId, chargeId, capturedMinor, from, to, guests, attemptId, sessionId,
    refundIdempotencyKey: `ref:${intentId}:1`,                                                           // = the accepted refundKey(intentId, 1); cross-checked against tooling + the row
    approvalRef, budgets: { ...c.budgets },
    operations: ["db.request_test_cleanup<=1", "db.cleanup_worker_steps<=16", "hostaway.get_reservation(reservationId)", "hostaway.lookup_by_ref(606998,arrival)",
      "hostaway.cancel_reservation(reservationId,host)<=1", "stripe.accounts.retrieve", "stripe.paymentIntents.retrieve(pi)", "stripe.refunds.create(pi,capturedMinor,key)<=1",
      "stripe.refunds.retrieve(re)", "stripe.refunds.list(pi,100)"],
    writes: { requestMax: 1, cancelMax: 1, refundMax: 1, capture: 0, hostawayCreate: 0, record: 0, notify: 0, void: 0, account: 0, keys: 0 } };
  return freeze({ plan: deepFreeze(plan), planHash: sha(canonical(plan)) });
}
/** the accepted 17-key operator expectation, DERIVED from the plan (+ its hash); never read from the database */
export function operatorExpectation(plan, planHash) {
  return freeze({ approvalRef: plan.approvalRef, attemptId: plan.attemptId, authorizedMinor: plan.capturedMinor, capturedMinor: plan.capturedMinor, chargeId: plan.chargeId,
    currency: plan.currency, expectedVersion: plan.expectedVersion, finalTotalMinor: plan.capturedMinor, from: plan.from, guests: plan.guests, intentId: plan.intentId,
    listingId: plan.listingId, paymentIntentId: plan.paymentIntentId, planHash, reservationId: plan.reservationId, sessionId: plan.sessionId, to: plan.to });
}

// =================================================================================================================================
// DB reads (read-only SELECTs through the runtime login; no transaction held across a provider call)
const Q = freeze({
  instance: "/*e7htc:instance*/ SELECT environment FROM booking.instance",
  attempts: "/*e7htc:attempts*/ SELECT id::text AS id, status, checkout_session_id, payment_intent_id, livemode FROM booking.payment_attempts WHERE intent_id = $1 ORDER BY attempt",
  hostaway: "/*e7htc:hostaway*/ SELECT state, hostaway_reservation_id::text AS rid FROM booking.hostaway_reservation_attempts WHERE intent_id = $1",
  ops: `/*e7htc:ops*/ SELECT id::text AS id, op_type, state, attempts, (dispatched_at IS NOT NULL) AS dispatched, (lease_worker_id IS NOT NULL OR lease_until IS NOT NULL) AS leased,
      late_result_status, result_ref, payload ->> 'reservationId' AS payload_rid, payload ->> 'paymentIntentId' AS payload_pi, payload ->> 'chargeId' AS payload_charge,
      payload ->> 'currency' AS payload_currency, (payload ->> 'attempt')::int AS payload_attempt, (payload ->> 'amountMinor')::int AS payload_amount,
      payload ->> 'providerIdempotencyKey' AS payload_key FROM booking.external_operations WHERE intent_id = $1 ORDER BY created_at, id`,
  cases: "/*e7htc:cases*/ SELECT count(*)::int AS n FROM booking.reconciliation_cases WHERE intent_id = $1 AND status = 'open'",
  claims: "/*e7htc:claims*/ SELECT listing_id, (released_at IS NOT NULL) AS released FROM booking.inventory_claims WHERE intent_id = $1",
  work: "/*e7htc:work*/ SELECT (work_worker_id IS NOT NULL OR work_lease_until IS NOT NULL) AS leased FROM booking.intent_work WHERE intent_id = $1",
  refunds: "/*e7htc:refunds*/ SELECT seq, idempotency_key, state, hostaway_state, amount_minor::text AS amt, currency, stripe_refund_id FROM booking.payment_refunds WHERE intent_id = $1 ORDER BY seq",
  ledger: "/*e7htc:ledger*/ SELECT entry, amount_minor::text AS amt, currency, provider_ref FROM booking.payment_ledger WHERE intent_id = $1 ORDER BY id",
  evidence: "/*e7htc:evidence*/ SELECT kind, external_ref, status FROM booking.provider_evidence WHERE intent_id = $1",
  settlement: `/*e7htc:settlement*/ SELECT environment, reason_code, settlement_reservation_cancelled AS cancelled, settlement_authorization_settled AS settled, captured_minor::text AS cap
      FROM booking.intents WHERE id = $1`,
  // READ-ONLY schema prerequisite: the reviewed 0019 + 0020 objects (never applied here; their absence refuses before any write)
  schema: `/*e7htc:schema*/ SELECT to_regprocedure('booking.settle_test_refund_from_evidence(uuid,uuid)') IS NOT NULL AS f0020,
      to_regproc('booking.test_refund_settled_for') IS NOT NULL AS settled_for, to_regproc('booking.test_refund_pi_observation_ok') IS NOT NULL AS pi_ok,
      to_regproc('booking.test_refund_ledgered') IS NOT NULL AS ledgered, to_regproc('booking.test_cleanup_cancel_bound') IS NOT NULL AS cancel_bound,
      to_regproc('booking.refund_claim_fence') IS NOT NULL AS refund_fence, to_regproc('booking.recording_retirement_fence') IS NOT NULL AS retirement_fence,
      booking.is_intent_state('test_cleanup_pending') AS pending_state`,
  role: `/*e7htc:role*/ SELECT pg_has_role(current_user, 'mv_booking_app', 'MEMBER') AS is_app, (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) AS privileged`,
  identity: "/*e7htc:identity*/ SELECT current_database() AS db, (SELECT environment FROM booking.instance) AS environment"
});
export const QUERIES = Q;
const CAPTURE = "stripe.capture_payment_intent"; const RECORD = "hostaway.record_offline_charge"; const CREATE = "hostaway.create_reservation";
const CANCEL = "hostaway.cancel_reservation"; const REFUND = "stripe.refund_payment_intent";
const READS = freeze(["stripe.retrieve_checkout_session", "stripe.retrieve_payment_intent", "hostaway.lookup_reservation", "hostaway.retrieve_reservation", "stripe.retrieve_refund"]);
const BEFORE_OPS = freeze(["stripe.create_checkout_session", CREATE, CAPTURE, RECORD, ...READS]);
const AFTER_OPS = freeze([...BEFORE_OPS, CANCEL, REFUND]);
const FORBIDDEN_OPS = freeze(["stripe.void_payment_intent", "guest.notify", "alert.owner", "stripe.refund", "stripe.create_refund"]);
const pristine = (o) => o && o.state === "pending" && o.attempts === 0 && o.dispatched === false && o.leased === false && o.late_result_status === null;
const SCHEMA_FLAGS = freeze(["f0020", "settled_for", "pi_ok", "ledgered", "cancel_bound", "refund_fence", "retirement_fence", "pending_state"]);

async function readFacts(q, plan, tooling, raw) {
  const inst = await q(Q.instance, []);
  const intent = await tooling.loadIntent(raw, plan.intentId);                                       // accepted repo read over the counted pool
  const attempts = await q(Q.attempts, [plan.intentId]);
  const hostaway = await q(Q.hostaway, [plan.intentId]);
  const ops = await q(Q.ops, [plan.intentId]);
  const cases = await q(Q.cases, [plan.intentId]);
  const claims = await q(Q.claims, [plan.intentId]);
  const work = await q(Q.work, [plan.intentId]);
  const refunds = await q(Q.refunds, [plan.intentId]);
  const ledger = await q(Q.ledger, [plan.intentId]);
  const evidence = await q(Q.evidence, [plan.intentId]);
  const settlement = await q(Q.settlement, [plan.intentId]);
  const schema = await q(Q.schema, []);
  return freeze({ instance: inst[0]?.environment ?? null, intent, attempts, hostaway, ops, openCases: cases[0]?.n ?? null, claims, workLeased: work.length === 1 ? work[0].leased : null,
    refunds, ledger, evidence, row: settlement[0] ?? null, schema: schema[0] ?? null });
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
  if (f.claims.length !== 1 || f.claims[0].listing_id !== c.listingId) return "CLAIM_NOT_SCOPED";
  if (f.openCases !== 0) return "OPEN_CASE";
  const capLed = f.ledger.filter((l) => l.entry === "capture_succeeded");
  if (capLed.length !== 1 || capLed[0].amt !== String(plan.capturedMinor) || capLed[0].currency !== c.currency || capLed[0].provider_ref !== plan.paymentIntentId) return "LEDGER_MISMATCH";
  if (f.ledger.some((l) => ["refund_failed", "authorization_voided", "offline_charge_recorded"].includes(l.entry))) return "LEDGER_MISMATCH";
  for (const x of f.evidence) {
    if (x.kind === "payment_intent" && x.external_ref !== plan.paymentIntentId) return "EVIDENCE_CONFLICT";
    if (x.kind === "hostaway_reservation" && x.external_ref !== plan.reservationId && !(x.status === "not_found" && x.external_ref === i.ref)) return "EVIDENCE_CONFLICT";
    if (x.kind === "hostaway_offline_charges") return "EVIDENCE_CONFLICT";
  }
  return null;
}
const schemaOk = (s) => !!s && SCHEMA_FLAGS.every((k) => s[k] === true);
/** checkStart(f, plan, c, tooling?) → { ok, intent, attemptId } | { ok:false, code } — read-only admission (the accepted request's in-tx guards stay authoritative) */
export function checkStart(f, plan, c = CONSTANTS, tooling = null) {
  const no = (code) => freeze({ ok: false, code });
  const common = checkCommon(f, plan, c);
  if (common) return no(common);
  const i = f.intent;
  if (i.status !== "payment_captured") return no("STATE_NOT_PAYMENT_CAPTURED");
  if (i.version !== plan.expectedVersion) return no("VERSION_NOT_PINNED");
  if (i.reasonCode) return no("REASON_CODE_PRESENT");
  if (i.lease) return no("RESERVATION_LEASE_HELD");
  if (f.workLeased !== false) return no("WORK_LEASE_HELD");
  const k = i.counters || {};
  if (k.captureAttempts !== 1 || (k.voidAttempts ?? 0) !== 0 || (k.cancelAttempts ?? 0) !== 0 || (k.offlineChargeAttempts ?? 0) !== 0) return no("HISTORY_NOT_INITIAL");
  for (const o of f.ops) if (!BEFORE_OPS.includes(o.op_type)) return no("UNEXPECTED_OP");
  for (const o of f.ops) if (READS.includes(o.op_type) && ["in_flight", "outcome_unknown"].includes(o.state)) return no("READ_HISTORY_UNSETTLED");
  const recs = f.ops.filter((o) => o.op_type === RECORD);
  if (recs.length !== 1 || !pristine(recs[0]) || recs[0].result_ref !== null) return no("RECORDING_NOT_PRISTINE");
  if (f.refunds.length !== 0) return no("REFUND_PRESENT");
  if (f.ledger.some((l) => l.entry === "refund_succeeded")) return no("LEDGER_MISMATCH");
  if (f.evidence.some((x) => x.kind === "stripe_refund" || (x.kind === "hostaway_reservation" && x.status === "cancelled"))) return no("EVIDENCE_CONFLICT");
  if (f.claims[0].released !== false) return no("CLAIM_NOT_HELD");
  if (f.row.cancelled === true || f.row.settled === true) return no("SETTLEMENT_PRESENT");
  if (tooling && typeof tooling.refundKey === "function" && tooling.refundKey(i.id, 1) !== plan.refundIdempotencyKey) return no("REFUND_KEY_NOT_ACCEPTED");
  if (!schemaOk(f.schema)) return no("SCHEMA_PREREQUISITE_MISSING");
  return freeze({ ok: true, intent: i, attemptId: f.attempts[0].id });
}
/** checkLineage(f, plan, c) → { ok, refundOpId } | { ok:false, code } — the EXACT persisted lineage ONE accepted request leaves (nothing else is admitted to the worker) */
export function checkLineage(f, plan, c = CONSTANTS) {
  const no = (code) => freeze({ ok: false, code });
  const common = checkCommon(f, plan, c);
  if (common) return no(common);
  const i = f.intent;
  if (i.status !== "test_cleanup_pending") return no("STATE_NOT_TEST_CLEANUP_PENDING");
  if (i.version !== plan.expectedVersion + 1) return no("VERSION_NOT_NEXT");
  if (i.reasonCode !== TEST_CLEANUP_REASON || f.row.reason_code !== TEST_CLEANUP_REASON) return no("REASON_NOT_TEST_CLEANUP");
  if (f.row.cancelled !== false || f.row.settled !== false) return no("SETTLEMENT_NOT_OPEN");
  if (i.lease || f.workLeased !== false) return no("LEASE_HELD");
  for (const o of f.ops) if (!AFTER_OPS.includes(o.op_type)) return no("UNEXPECTED_OP");
  const recs = f.ops.filter((o) => o.op_type === RECORD);
  if (recs.length !== 1 || recs[0].state !== "superseded" || recs[0].attempts !== 0 || recs[0].dispatched !== false || recs[0].leased !== false || recs[0].result_ref !== null) return no("RECORDING_NOT_RETIRED");
  const cancels = f.ops.filter((o) => o.op_type === CANCEL);
  if (cancels.length !== 1 || !pristine(cancels[0]) || cancels[0].payload_rid !== plan.reservationId) return no("CANCEL_ROW_NOT_PRISTINE");
  const refunds = f.ops.filter((o) => o.op_type === REFUND);
  if (refunds.length !== 1 || !pristine(refunds[0])) return no("REFUND_ROW_NOT_PRISTINE");
  const rf = refunds[0];
  if (rf.payload_pi !== plan.paymentIntentId || rf.payload_charge !== plan.chargeId || rf.payload_amount !== plan.capturedMinor || rf.payload_currency !== c.currency || rf.payload_attempt !== 1
      || rf.payload_key !== plan.refundIdempotencyKey || !UUID_RE.test(String(rf.id))) return no("REFUND_ROW_NOT_BOUND");
  if (f.refunds.length !== 1 || f.refunds[0].seq !== 1 || f.refunds[0].idempotency_key !== plan.refundIdempotencyKey || f.refunds[0].state !== "requested" || f.refunds[0].hostaway_state !== "not_applicable"
      || f.refunds[0].amt !== String(plan.capturedMinor) || f.refunds[0].currency !== c.currency || f.refunds[0].stripe_refund_id !== null) return no("REFUND_RECORD_NOT_REQUESTED");
  if (f.ledger.some((l) => l.entry === "refund_succeeded")) return no("LEDGER_MISMATCH");
  if (f.claims[0].released !== false) return no("CLAIM_NOT_HELD");
  return freeze({ ok: true, refundOpId: String(rf.id) });
}
/** checkEnd(f, plan, c, tooling?) → null | code — the persisted facts a completed cleanup must show (anything else = POSTCHECK_MISMATCH / RESIDUAL_*) */
export function checkEnd(f, plan, c = CONSTANTS, tooling = null) {
  const common = checkCommon(f, plan, c);
  if (common) return common;
  const i = f.intent;
  if (i.status !== "cancelled") return "STATE_NOT_CANCELLED";
  if (i.reasonCode !== TEST_CLEANUP_REASON || f.row.reason_code !== TEST_CLEANUP_REASON) return "REASON_NOT_TEST_CLEANUP";
  if (tooling && typeof tooling.publicStatus === "function" && tooling.publicStatus(i) !== "not_completed_refunded") return "PUBLIC_STATUS_NOT_REFUNDED";
  if (f.row.cancelled !== true || f.row.settled !== true) return "LEGS_NOT_SETTLED";
  for (const o of f.ops) if (!AFTER_OPS.includes(o.op_type)) return "UNEXPECTED_OP";
  const recs = f.ops.filter((o) => o.op_type === RECORD);
  if (recs.length !== 1 || recs[0].state !== "superseded" || recs[0].attempts !== 0 || recs[0].dispatched !== false || recs[0].result_ref !== null) return "RECORDING_NOT_RETIRED";
  const cancels = f.ops.filter((o) => o.op_type === CANCEL);
  if (cancels.length !== 1 || cancels[0].state !== "succeeded" || cancels[0].attempts !== 1 || cancels[0].dispatched !== true || cancels[0].leased !== false
      || String(cancels[0].result_ref ?? "") !== plan.reservationId) return "CANCEL_OP_NOT_SINGLE_SUCCEEDED";
  const refunds = f.ops.filter((o) => o.op_type === REFUND);
  if (refunds.length !== 1 || refunds[0].state !== "succeeded" || refunds[0].attempts !== 1 || refunds[0].dispatched !== true || refunds[0].leased !== false
      || !REFUND_RE.test(String(refunds[0].result_ref ?? ""))) return "REFUND_OP_NOT_SINGLE_SUCCEEDED";
  if (refunds[0].payload_pi !== plan.paymentIntentId || refunds[0].payload_charge !== plan.chargeId || refunds[0].payload_amount !== plan.capturedMinor || refunds[0].payload_key !== plan.refundIdempotencyKey) return "REFUND_ROW_NOT_BOUND";
  const re = String(refunds[0].result_ref);
  if (f.refunds.length !== 1 || f.refunds[0].seq !== 1 || f.refunds[0].idempotency_key !== plan.refundIdempotencyKey || f.refunds[0].state !== "succeeded" || f.refunds[0].hostaway_state !== "not_applicable"
      || f.refunds[0].amt !== String(plan.capturedMinor) || f.refunds[0].currency !== c.currency || f.refunds[0].stripe_refund_id !== re) return "REFUND_RECORD_NOT_SUCCEEDED";
  const rl = f.ledger.filter((l) => l.entry === "refund_succeeded");
  if (rl.length !== 1 || rl[0].amt !== String(plan.capturedMinor) || rl[0].currency !== c.currency) return "REFUND_NOT_LEDGERED";
  if (!f.evidence.some((x) => x.kind === "stripe_refund" && x.status === "succeeded" && x.external_ref === re)) return "REFUND_EVIDENCE_MISSING";
  if (f.claims[0].released !== true) return "CLAIM_NOT_RELEASED";
  return null;
}

// =================================================================================================================================
/**
 * runTestCleanupCore({ plan, planHash, pool, lockClientFactory, tooling, exchanges, credentials, clock, monotonic, sleep, runSignal }) → frozen result.
 *  tooling = { runTestCleanupStep, requestTestCleanup, loadIntent, createTestCleanupExecutors, createStripeSend (= createE7StripeTestCleanupSend),
 *              createHostawaySend, validateAdapterConfig, unwrapEnvelope, normalizeReservation, paymentIntentProofObservationV3, piIdentityOk,
 *              rawPiPreSendRefusal, refundObservation, arrivalStrictlyFuture, refundKey, publicStatus, LOCK_KEY, LOCK_PRECHECK_SQL }
 *  lockClientFactory() → a dedicated checked-out client (query / release / on) for the session lock (pool.connect by default).
 */
export const TOOLING_KEYS = freeze(["runTestCleanupStep", "requestTestCleanup", "loadIntent", "createTestCleanupExecutors", "createStripeSend", "createHostawaySend", "validateAdapterConfig",
  "unwrapEnvelope", "normalizeReservation", "lookupByRef", "activeReservationProof", "paymentIntentProofObservationV3", "piIdentityOk", "rawPiPreSendRefusal", "refundObservation",
  "arrivalStrictlyFuture", "refundKey", "publicStatus"]);
const RES_READ_OP = "hostaway.retrieve_reservation"; const LOOKUP_OP = "hostaway.lookup_reservation";   // = the accepted OPS.RES_READ / OPS.LOOKUP read op types (asserted by the tests)

// =================================================================================================================================
// F1 — runner-local, STATE-INDEPENDENT PaymentIntent proof adapter. LABELLED MIRROR of the accepted test-cleanup-proof.js capturedChargeRefusal
// (which is module-private and whose callers require the intent to ALREADY be test_cleanup_pending, so they cannot judge the runner's
// payment_captured / cancelled boundaries). Identity comes from the ACCEPTED piIdentityOk (account verified, PI object / id, request selector,
// livemode false, metadata intent + attempt, manual capture, authorized amount / currency). Every field below is a copied provider field.
/** piCapturedV3Refusal(ev, { intent, attemptId, chargeId, capturedMinor, currency, phase: "unrefunded" | "fully_refunded" }, piIdentityOk) → null | code */
export function piCapturedV3Refusal(ev, { intent, attemptId, chargeId, capturedMinor, currency, phase }, piIdentityOk) {
  const o = ev && ev.observed;
  if (!o || typeof o !== "object" || o.proofVersion !== "pi-proof-v3") return "V3_OBSERVATION_REQUIRED";
  if (piIdentityOk(ev, intent, attemptId) !== true) return "PAYMENT_INTENT_IDENTITY";
  if (o.status !== "succeeded") return "PI_NOT_SUCCEEDED";
  if (o.amountMinor !== capturedMinor) return "PI_AMOUNT";
  if (o.amountReceivedMinor !== capturedMinor) return "AMOUNT_RECEIVED_NOT_CAPTURED";
  if (o.amountCapturableMinor !== 0) return "AMOUNT_CAPTURABLE_NOT_ZERO";
  if (o.currency !== currency) return "PI_CURRENCY";
  const c = o.latestCharge;
  if (!c || typeof c !== "object" || c.object !== "charge" || typeof c.id !== "string" || !CHARGE_RE.test(c.id)) return "CHARGE_NOT_EXPANDED";
  if (c.id !== chargeId) return "CHARGE_ID_MISMATCH";
  if (c.paymentIntent !== intent.payment.paymentIntentId) return "CHARGE_NOT_BOUND";
  if (c.livemode !== false) return "CHARGE_NOT_TEST_MODE";
  if (c.status !== "succeeded") return "CHARGE_STATUS";
  if (c.paid !== true) return "CHARGE_NOT_PAID";
  if (c.captured !== true) return "CHARGE_NOT_CAPTURED";
  if (c.amountMinor !== capturedMinor) return "CHARGE_AMOUNT";
  if (c.amountCapturedMinor !== capturedMinor) return "CHARGE_AMOUNT_CAPTURED";
  if (c.currency !== currency) return "CHARGE_CURRENCY";
  if (phase === "unrefunded") { if (c.amountRefundedMinor !== 0) return "CHARGE_ALREADY_REFUNDED"; }
  else if (phase === "fully_refunded") { if (c.amountRefundedMinor !== capturedMinor) return "CHARGE_NOT_FULLY_REFUNDED"; }
  else return "PHASE_INVALID";
  return null;
}
/** rawPiFullyRefundedRefusal(pi, bound) → null | code — LABELLED MIRROR of the accepted rawPiPreSendRefusal with the refund expectations inverted (post-refund readback) */
export function rawPiFullyRefundedRefusal(pi, { paymentIntentId, chargeId, amountMinor, currency } = {}) {
  const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  if (!isObj(pi) || pi.object !== "payment_intent" || pi.id !== paymentIntentId) return "RAW_PI_IDENTITY";
  if (pi.livemode !== false) return "RAW_PI_NOT_TEST_MODE";
  if (pi.status !== "succeeded" || pi.amount_received !== amountMinor || pi.amount !== amountMinor) return "RAW_PI_NOT_CAPTURED_FULL";
  if (String(pi.currency || "").toUpperCase() !== currency) return "RAW_PI_CURRENCY";
  const c = pi.latest_charge;
  if (!isObj(c) || c.object !== "charge" || c.id !== chargeId) return "RAW_CHARGE_IDENTITY";
  if (c.livemode !== false) return "RAW_CHARGE_NOT_TEST_MODE";
  if (c.captured !== true || c.paid !== true || c.status !== "succeeded") return "RAW_CHARGE_NOT_CAPTURED";
  if (c.amount !== amountMinor || c.amount_captured !== amountMinor) return "RAW_CHARGE_AMOUNT";
  if (c.amount_refunded !== amountMinor) return "RAW_CHARGE_NOT_FULLY_REFUNDED";
  if (c.refunded !== true) return "RAW_CHARGE_REFUNDED_FLAG";
  if (c.disputed !== false) return "RAW_CHARGE_DISPUTED";
  if (c.dispute !== undefined && c.dispute !== null) return "RAW_CHARGE_DISPUTE_PRESENT";
  return null;
}
// F2 — runner-read reservation observation (LABELLED COPY of the accepted reservation-worker observedReservation, NOT persisted as evidence)
const observedReservation = (r) => ({ reservationId: String(r.reservationId), listingId: r.listingId, from: r.from, to: r.to, totalMinor: r.totalMinor, currency: r.currency, status: r.status,
  ...(r.bookingRef ? { bookingRef: r.bookingRef } : {}) });
const runnerResEvidence = (id, readOpType, requestRef, r, observedAt, extra = {}) => freeze({ id, kind: "hostaway_reservation", readOpType, requestRef, externalRef: String(r.reservationId),
  status: r.status === "cancelled" ? "cancelled" : "found_active", observed: { ...extra, ...observedReservation(r) }, observedAt });
export async function runTestCleanupCore(input) {
  const c = CONSTANTS; const B = c.budgets;
  const r = { schema: RESULT_SCHEMA, outcome: null, code: null, startState: null, finalState: null, finalVersion: null, publicStatus: null, reservationId: null, capturedMinor: null, chargeId: null, refundId: null,
    requestInvocations: 0, requestOutcome: "NONE", steps: 0, actions: [], exchanges: 0, hostawayReads: 0, lookupPages: 0, accountReads: 0, piReads: 0, refundReads: 0, refundLists: 0,
    dbQueries: 0, dbBudgetRefused: 0, cancelInvocations: 0, cancelOutcome: "NONE", refundInvocations: 0, refundOutcome: "NONE", refusedAtTransport: 0, refusedByStop: 0,
    lock: "not_acquired", lockSession: null, lockBackendPid: null, proofs: [], postcheck: null, cancelOps: null, refundOps: null, refundRecord: null, recordingRetired: null, claimHeld: null,
    legs: null, factsObserved: false, stopReason: null, workerSignalAborted: null, stripeVersion: c.stripeVersion,
    writes: { request: 0, cancel: 0, refund: 0, capture: 0, create: 0, record: 0, notify: 0, void: 0 } };
  const DONE = Symbol("done");
  const done = (outcome, code = null) => { r.outcome = outcome; r.code = code; return DONE; };
  const snapshot = () => freeze(JSON.parse(JSON.stringify(r)));
  let stopReason = null; let runSignalRef = null; let monoRef = null; let endsAtRef = Infinity;
  let lockClient = null; let lockAcquired = false; let lockErrored = false; let lockPid = null; let finalFactsRef = null;
  // F3: the runner-OWNED stop signal — part of EVERY composed worker / transport signal; aborted synchronously by the lock-session error listener
  // and by every latched stop, so an already-running accepted worker observes it at its own admission / success-event checks
  const stopAc = new AbortController();
  // LABELLED COPY (Slice 2 / Slice 1) — the GLOBAL stop latch (run abort, fixed wall deadline, observed lock-session error)
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
  /** a possibly-sent write (or request) without an admissible reply dominates every later exit (never hidden behind a stop code) */
  const uncertain = () => (r.requestOutcome === "UNKNOWN" ? "REQUEST_OUTCOME_UNKNOWN" : r.cancelOutcome === "UNKNOWN" || r.refundOutcome === "UNKNOWN" ? "WRITE_OUTCOME_UNKNOWN" : null);
  const stopOutcome = () => done(uncertain() ?? (stopReason === "LOCK_SESSION_ERROR" ? "LOCK_LOST" : stopReason), `STOP_${stopReason}`);
  /** best available OBSERVED facts: recorded on every exit that has them; `factsObserved` distinguishes unobserved from absent */
  const observe = (f) => {
    if (!f || !f.intent) return;
    r.factsObserved = true; r.finalState = f.intent.status; r.finalVersion = f.intent.version;
    r.publicStatus = input && input.tooling && typeof input.tooling.publicStatus === "function" ? String(input.tooling.publicStatus(f.intent)) : null;
    r.reservationId = f.intent.reservation && f.intent.reservation.reservationId !== null && f.intent.reservation.reservationId !== undefined ? String(f.intent.reservation.reservationId) : null;
    r.capturedMinor = f.intent.payment ? f.intent.payment.capturedMinor ?? null : null;
    const caps = f.ops.filter((o) => o.op_type === CAPTURE);
    r.chargeId = caps.length === 1 && caps[0].state === "succeeded" && CHARGE_RE.test(String(caps[0].result_ref ?? "")) ? String(caps[0].result_ref) : null;
    r.cancelOps = f.ops.filter((o) => o.op_type === CANCEL).map((o) => o.state);
    r.refundOps = f.ops.filter((o) => o.op_type === REFUND).map((o) => o.state);
    r.refundRecord = f.refunds.length === 0 ? null : f.refunds.map((x) => x.state);
    r.refundId = f.refunds.length === 1 && REFUND_RE.test(String(f.refunds[0].stripe_refund_id ?? "")) ? String(f.refunds[0].stripe_refund_id) : null;
    const recs = f.ops.filter((o) => o.op_type === RECORD);
    r.recordingRetired = recs.length === 0 ? null : recs.length === 1 && recs[0].state === "superseded" && recs[0].attempts === 0 && recs[0].dispatched === false;
    r.claimHeld = f.claims.length === 1 ? f.claims[0].released === false : null;
    r.legs = f.row ? { reservationCancelled: f.row.cancelled, authorizationSettled: f.row.settled } : null;
  };
  const body = async () => {
    const { plan, planHash, pool, tooling, exchanges, credentials } = input ?? {};
    if (!plan || plan.schema !== PLAN_SCHEMA || plan.accountId !== c.accountId || plan.listingId !== c.listingId || plan.stripeVersion !== c.stripeVersion || plan.currency !== c.currency
        || !INTENT_RE.test(String(plan.intentId)) || !isVersion(plan.expectedVersion) || isoMs(plan.notBefore) === null || !PI_RE.test(String(plan.paymentIntentId))
        || !RID_RE.test(String(plan.reservationId)) || c.protectedReservationIds.includes(String(plan.reservationId)) || !CHARGE_RE.test(String(plan.chargeId)) || !isAmount(plan.capturedMinor)
        || !realDate(plan.from) || !realDate(plan.to) || !(plan.from < plan.to) || !isGuests(plan.guests) || !UUID_RE.test(String(plan.attemptId)) || !SESSION_RE.test(String(plan.sessionId))
        || plan.refundIdempotencyKey !== `ref:${plan.intentId}:1` || plan.intentId === c.synthetic.intentId || typeof planHash !== "string" || sha(canonical(plan)) !== planHash
        || !pool || typeof pool.query !== "function" || !tooling || !exchanges || typeof exchanges.stripe !== "function" || typeof exchanges.hostaway !== "function"
        || !credentials || typeof credentials.stripe !== "function" || typeof credentials.hostaway !== "function") return done("CORE_INVALID");
    for (const k of TOOLING_KEYS) if (typeof tooling[k] !== "function") return done("CORE_INVALID", "TOOLING_INVALID");
    if (typeof tooling.LOCK_KEY !== "string" || typeof tooling.LOCK_PRECHECK_SQL !== "string") return done("CORE_INVALID", "TOOLING_INVALID");
    const clock = input.clock ?? (() => Date.now());
    const mono = input.monotonic ?? (() => performance.now());
    const runSignal = input.runSignal ?? null;
    const endsAt = mono() + B.runMs;
    runSignalRef = runSignal; monoRef = mono; endsAtRef = endsAt;
    const sleep = input.sleep ?? ((ms) => new Promise((res) => { const t = setTimeout(res, ms); runSignal?.addEventListener?.("abort", () => { clearTimeout(t); res(); }, { once: true }); }));
    const lockClientFactory = input.lockClientFactory ?? (() => pool.connect());

    // ---- (1) LABELLED COPY: counted pool — EVERY statement (runner reads + request + worker, connected clients included) is counted once here ----
    const count = () => { if (r.dbQueries >= B.dbQueries) { r.dbBudgetRefused += 1; throw new Refusal("DB_BUDGET"); } r.dbQueries += 1; };
    const countedPool = {
      query: (...a) => { count(); return pool.query(...a); },
      connect: async () => { const cl = await pool.connect(); const q = cl.query.bind(cl);
        return { query: (...a) => { count(); return q(...a); }, release: (...a) => cl.release(...a), on: (...a) => (typeof cl.on === "function" ? cl.on(...a) : undefined),
          removeListener: (...a) => (typeof cl.removeListener === "function" ? cl.removeListener(...a) : undefined) }; }
    };
    const q = async (sql, params) => { guard(); const res = await countedPool.query(sql, params); return res.rows; };
    const read = () => readFacts(q, plan, tooling, { query: (sql, params) => { guard(); return countedPool.query(sql, params); } });

    // ---- (2) read-only start check: the pins are RE-READ and cross-checked; the schema prerequisite is READ, never applied -----------------------
    let f;
    try { f = await read(); } catch (e) { return e instanceof Stopped ? stopOutcome() : done("DB_ERROR", "START_READ_FAILED"); }
    r.startState = f.intent ? f.intent.status : null;
    const st = checkStart(f, plan, c, tooling);
    if (!st.ok) return done(st.code === "SCHEMA_PREREQUISITE_MISSING" ? "SCHEMA_PREREQUISITE_MISSING"
      : ["STATE_NOT_PAYMENT_CAPTURED", "VERSION_NOT_PINNED", "HISTORIC_INTENT", "RESERVATION_LEASE_HELD", "WORK_LEASE_HELD", "RECORDING_NOT_PRISTINE", "HISTORY_NOT_INITIAL",
        "REASON_CODE_PRESENT", "SETTLEMENT_PRESENT", "READ_HISTORY_UNSETTLED"].includes(st.code) ? "START_STATE_NOT_ELIGIBLE" : "SCOPE_REFUSED", st.code);
    const intent0 = st.intent; const PI = plan.paymentIntentId; const RID = plan.reservationId;

    // ---- (3) LABELLED COPY (Slice 1 §3, F4): the P3 session lock on a DEDICATED client; pid-stable proof --------------------------------------
    try { lockClient = await lockClientFactory(); } catch { return done("DB_ERROR", "LOCK_CONNECT_FAILED"); }
    const onLockErr = () => { lockErrored = true; r.lockSession = "error_observed"; stopAc.abort(); stopped(); };   // F3: synchronous abort of every composed signal
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
    const lockLost = (e) => (e instanceof Stopped ? stopOutcome() : done("DB_ERROR", "LOCK_PROOF_FAILED"));
    const proveLock = async (tag) => {
      try { if (!(await ownLock())) { r.lock = "lost"; return done(uncertain() ?? "LOCK_LOST", lockErrored ? "LOCK_SESSION_ERROR" : r.lockSession === "backend_hop" ? "BACKEND_HOP" : "LOCK_NOT_HELD"); } }
      catch (e) { return lockLost(e); }
      if (stopped()) return stopOutcome();                                                           // after the awaited proof
      r.proofs.push(tag);
      return null;
    };

    // ---- (4) LABELLED COPY: DB identity on the lock session AND the pool (same database, TEST instance); app role --------------------------
    try {
      const a = await lockQuery(Q.identity, []); const b = await q(Q.identity, []);
      if (a.rows.length !== 1 || b.length !== 1 || a.rows[0].db !== b[0].db || a.rows[0].environment !== c.dbEnvironment || b[0].environment !== c.dbEnvironment) return done("DB_IDENTITY_MISMATCH", "POOLS_MISMATCH");
      const role = await q(Q.role, []);
      if (role.length !== 1 || role[0].privileged !== false || role[0].is_app !== true) return done("SCOPE_REFUSED", "ROLE_NOT_APP");
    } catch (e) { return e instanceof Stopped ? stopOutcome() : done("DB_ERROR", "IDENTITY_READ_FAILED"); }

    // ---- (5) the target-only transport fence (cleanup phase): exact URL / method / headers / body; counters BEFORE the exchange ------------------
    const urls = { account: `${STRIPE}/v1/account`, pi: `${STRIPE}/v1/payment_intents/${PI}?expand%5B%5D=latest_charge`, refundPost: `${STRIPE}/v1/refunds`,
      refundList: `${STRIPE}/v1/refunds?payment_intent=${enc(PI)}&limit=100`, reservation: `${HOSTAWAY}/v1/reservations/${RID}`, cancel: `${HOSTAWAY}/v1/reservations/${RID}/statuses/cancelled` };
    const fence = { refundOpId: null, refundBody: null, cancelOpen: false, cancelExchanged: false, refundOpen: false, refundExchanged: false };
    const hkeys = (h) => Object.keys(h).sort().join(",");
    const isRefundGetUrl = (url) => { const m = /^https:\/\/api\.stripe\.com\/v1\/refunds\/(re_[A-Za-z0-9_]{1,200})$/.exec(url); return !!m && REFUND_RE.test(m[1]); };
    const stripeGate = (req) => {
      if (stopped()) { r.refusedByStop += 1; return Promise.reject(new Error("stopped")); }
      if (!req || !req.headers || req.headers["Stripe-Version"] !== c.stripeVersion || r.exchanges >= B.exchanges) { r.refusedAtTransport += 1; return Promise.reject(new Error("gate")); }
      const isGet = req.method === "GET" && req.body === null && hkeys(req.headers) === "Authorization,Stripe-Version";
      const isRefund = req.method === "POST" && req.url === urls.refundPost && hkeys(req.headers) === "Authorization,Content-Type,Idempotency-Key,Stripe-Version"
        && req.headers["Idempotency-Key"] === plan.refundIdempotencyKey && req.headers["Content-Type"] === "application/x-www-form-urlencoded" && fence.refundBody !== null && req.body === fence.refundBody;
      if (isGet && req.url === urls.account && r.accountReads < B.accountReads) r.accountReads += 1;
      else if (isGet && req.url === urls.pi && r.piReads < B.piReads) r.piReads += 1;
      else if (isGet && isRefundGetUrl(req.url) && r.refundReads < B.refundReads) r.refundReads += 1;
      else if (isGet && req.url === urls.refundList && r.refundLists < B.refundLists) r.refundLists += 1;
      else if (isRefund && fence.refundOpen && !fence.refundExchanged) fence.refundExchanged = true;           // the ONE refund: exact URL / method / headers / body / key
      else { r.refusedAtTransport += 1; return Promise.reject(new Error("gate")); }                           // no other Stripe write, ever (no capture / void / cancel)
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
      return g("listingId") === String(c.listingId) && g("channelId") === "2000" && g("arrivalStartDate") === plan.from && g("arrivalEndDate") === plan.from
        && g("limit") === "100" && g("includeResources") === "1" && (!u.searchParams.has("afterId") || RID_RE.test(g("afterId")));
    };
    const hostawayGate = (req) => {
      if (stopped()) { r.refusedByStop += 1; return Promise.reject(new Error("stopped")); }
      if (!req || !req.headers || r.exchanges >= B.exchanges) { r.refusedAtTransport += 1; return Promise.reject(new Error("gate")); }
      const plainGet = req.method === "GET" && req.body === null && hkeys(req.headers) === "Accept,Authorization,Cache-control";
      const isCancel = req.method === "PUT" && req.url === urls.cancel && hkeys(req.headers) === "Accept,Authorization,Cache-control,Content-Type"
        && req.headers["Content-Type"] === "application/json" && req.body === CANCEL_BODY_WIRE;
      if (plainGet && req.url === urls.reservation && r.hostawayReads < B.hostawayReads) r.hostawayReads += 1;        // ONLY the pinned reservation id
      else if (plainGet && isLookupUrl(req.url) && r.lookupPages < B.lookupPages) r.lookupPages += 1;
      else if (isCancel && fence.cancelOpen && !fence.cancelExchanged) fence.cancelExchanged = true;                  // the ONE cancel: exact URL / method / headers / body
      else { r.refusedAtTransport += 1; return Promise.reject(new Error("gate")); }                                   // no other Hostaway write, ever (no create / charge / message)
      r.exchanges += 1;
      return exchanges.hostaway(req);
    };
    const ts = tooling.createStripeSend({ exchange: stripeGate, credential: credentials.stripe, accountId: c.accountId, apiVersion: c.stripeVersion });
    const th = tooling.createHostawaySend({ exchange: hostawayGate, credential: credentials.hostaway });
    if (!ts || ts.ok !== true || !th || th.ok !== true) return done("CORE_INVALID", "TRANSPORT_INVALID");
    const composed = (sig) => {
      const parts = [stopAc.signal];                                                                  // F3: the runner-owned stop first
      if (sig instanceof AbortSignal) parts.push(sig);
      if (runSignal instanceof AbortSignal) parts.push(runSignal);
      parts.push(AbortSignal.timeout(Math.max(1, Math.floor(endsAt - mono()))));
      return AbortSignal.any(parts);
    };
    const adapterConfig = tooling.validateAdapterConfig({ allowedListingIds: [c.listingId], refFieldId: c.refFieldId, channelId: 2000, currency: c.currency });

    // ---- (6) account + fresh STRICT captured-and-UNREFUNDED Stripe proof + the bound ACTIVE future-arrival reservation (reads only) BEFORE the request --
    try {
      guard();
      const acct = await ts.transport.send({ op: "accounts.retrieve" }, { signal: composed(null) });
      if (!acct || acct.object !== "account" || acct.id !== c.accountId) return done("PROVIDER_PROOF_FAILED", "ACCOUNT");
      guard();
      const pi = await ts.transport.send({ op: "paymentIntents.retrieve", id: PI, params: { expand: ["latest_charge"] } }, { signal: composed(null) });
      const observed = tooling.paymentIntentProofObservationV3(pi, { accountVerified: true });
      const ev = { id: "runner-readback", kind: "payment_intent", readOpType: "stripe.retrieve_payment_intent", requestRef: PI, externalRef: PI, status: observed.status, observed, observedAt: clock() };
      // F1: COMPLETE state-independent v3 proof (accepted identity + mirrored charge checks, UNREFUNDED) + the accepted raw safeguards (refund list / dispute)
      const bound = { intent: intent0, attemptId: st.attemptId, chargeId: plan.chargeId, capturedMinor: plan.capturedMinor, currency: c.currency };
      const v3 = piCapturedV3Refusal(ev, { ...bound, phase: "unrefunded" }, tooling.piIdentityOk);
      if (v3) return done("PROVIDER_PROOF_FAILED", v3);
      const raw = tooling.rawPiPreSendRefusal(pi, { paymentIntentId: PI, chargeId: plan.chargeId, amountMinor: plan.capturedMinor, currency: c.currency });
      if (raw) return done("PROVIDER_PROOF_FAILED", CODE_RE.test(String(raw)) ? String(raw) : "PI_PROOF");
      guard();
      // F2: the ACCEPTED activeReservationProof over runner-read observations (never persisted): status "new", id / listing / stay / total / currency, the
      // booking ref echoed equal, or (ref absent) ONE bounded accepted lookupByRef proving exactly this reservation; a contradicting non-null ref refuses.
      const rr = await th.transport.send({ method: "GET", path: `/v1/reservations/${RID}`, query: {} }, { signal: composed(null) });
      if (!rr || rr.httpStatus !== 200) return done("PROVIDER_PROOF_FAILED", `RESERVATION_READ_${Number.isSafeInteger(rr && rr.httpStatus) ? rr.httpStatus : "FAILED"}`);
      const env = tooling.unwrapEnvelope(rr.json);
      if (!env || env.ok !== true) return done("PROVIDER_PROOF_FAILED", "RESERVATION_ENVELOPE");
      const nr = tooling.normalizeReservation(env.result, adapterConfig);
      if (!nr || nr.ok !== true) return done("PROVIDER_PROOF_FAILED", "RESERVATION_MALFORMED");
      if (nr.reservation.channelId !== 2000) return done("PROVIDER_PROOF_FAILED", "RESERVATION_CHANNEL_NOT_DIRECT");
      const byId = runnerResEvidence("runner-res-by-id", RES_READ_OP, RID, nr.reservation, clock());
      let byRef = null;
      if (byId.observed.bookingRef === undefined) {                                                   // ref not echoed: ONE bounded by-ref lookup for THIS arrival (fenced pages)
        guard();
        let lk; try { lk = await tooling.lookupByRef({ ref: intent0.ref, listingId: c.listingId, arrivalDate: plan.from, departureDate: plan.to }, adapterConfig,
          (req) => th.transport.send({ method: req.method, path: `/v1${req.path}`, query: req.query }, { signal: composed(null) })); } catch { lk = null; }   // = the executor's path mapping; pages fenced to THIS arrival
        if (!lk || lk.outcome !== "found" || !lk.reservation) return done("PROVIDER_PROOF_FAILED", lk && lk.outcome === "conflict" ? `LOOKUP_${String(lk.code)}` : lk && lk.outcome === "not_found" ? "LOOKUP_NOT_FOUND" : "LOOKUP_FAILED");
        if (lk.reservation.channelId !== 2000) return done("PROVIDER_PROOF_FAILED", "RESERVATION_CHANNEL_NOT_DIRECT");
        byRef = runnerResEvidence("runner-res-by-ref", LOOKUP_OP, intent0.ref, lk.reservation, clock(), { bookingRef: intent0.ref, matchCount: 1 });
      }
      const ap = tooling.activeReservationProof({ intent: intent0, byId, byRef, now: clock(), notBefore: isoMs(plan.notBefore) });
      if (!ap || ap.ok !== true) return done("PROVIDER_PROOF_FAILED", ap && CODE_RE.test(String(ap.code)) ? `RESERVATION_${String(ap.code)}` : "RESERVATION_PROOF");
      const arr = tooling.arrivalStrictlyFuture(plan.from, c.listingTimeZone, clock());
      if (!arr || arr.ok !== true) return done("PROVIDER_PROOF_FAILED", "ARRIVAL_NOT_IN_FUTURE");
      r.proofs.push("PROVIDER_BEFORE_REQUEST");
    } catch (e) { if (e instanceof Stopped || stopped()) return stopOutcome(); return done("PROVIDER_PROOF_FAILED", "READ_FAILED"); }

    // ---- (7) ONE accepted request (the ONLY admission write of this runner): lock proven immediately before; a throw is NEVER repeated ---------
    { const p = await proveLock("BEFORE_REQUEST"); if (p) return p; }
    if (stopped()) return stopOutcome();
    const requestEnv = { VERCEL_ENV: "development", MV_E7_TEST_CLEANUP: "enabled" };
    const operator = operatorExpectation(plan, planHash);
    let rq;
    try {
      r.requestInvocations += 1; r.writes.request += 1; r.requestOutcome = "SENT";
      rq = await tooling.requestTestCleanup(countedPool, plan.intentId, { now: clock(), env: requestEnv, operator });
      r.requestOutcome = rq && typeof rq === "object" ? "REPLIED" : "UNKNOWN";
    } catch (e) {
      r.requestOutcome = "UNKNOWN";                                                                  // the transaction may or may not have committed: read, report, STOP
      try { finalFactsRef = await read(); observe(finalFactsRef); } catch { /* reported below */ }
      return done("REQUEST_OUTCOME_UNKNOWN", e instanceof Refusal && e.code === "DB_BUDGET" ? "DB_QUERY_CEILING" : "REQUEST_THREW");
    }
    if (!rq || rq.ok !== true) { try { f = await read(); observe(f); } catch { /* reported below */ } return done("REQUEST_REFUSED", rq && CODE_RE.test(String(rq.error)) ? String(rq.error) : "REQUEST_REFUSED"); }
    if (stopped()) return stopOutcome();
    try { f = await read(); } catch (e) { return e instanceof Stopped ? stopOutcome() : done("DB_ERROR", "LINEAGE_READ_FAILED"); }
    observe(f);
    const lin = checkLineage(f, plan, c);
    if (!lin.ok) return done("LINEAGE_MISMATCH", lin.code);
    fence.refundOpId = lin.refundOpId;
    fence.refundBody = `payment_intent=${enc(PI)}&amount=${plan.capturedMinor}&metadata%5Bmv_refund_op%5D=${enc(fence.refundOpId)}&metadata%5Bmv_refund_key%5D=${enc(plan.refundIdempotencyKey)}`;

    // ---- (8) the ISOLATED accepted test-cleanup executors over the fence; every write counted and fenced BEFORE the transport ----------------
    const hostawaySend = async (req, opts) => {
      if (stopped()) { r.refusedByStop += 1; throw new Error("stopped"); }
      const o = { ...(opts && typeof opts === "object" ? opts : {}), signal: composed(opts && opts.signal) };
      if (req && req.method === "PUT") {
        if (req.path !== `/v1/reservations/${RID}/statuses/cancelled` && req.path !== `/reservations/${RID}/statuses/cancelled`) { r.refusedAtTransport += 1; throw new Error("path refused"); }   // the ONE cancel path, nothing else
        if (r.cancelInvocations >= B.cancel || stopped()) { r.refusedAtTransport += 1; throw new Error("cancel budget"); }                 // counter fence BEFORE the transport
        r.cancelInvocations += 1; r.writes.cancel += 1; fence.cancelOpen = true;
        try {
          const out = await th.transport.send(req, o);
          r.cancelOutcome = out && typeof out === "object" && Number.isSafeInteger(out.httpStatus) ? "REPLIED" : "UNKNOWN";
          return out;
        } catch (e) { r.cancelOutcome = fence.cancelExchanged ? "UNKNOWN" : "NOT_SENT"; throw e; }
        finally { fence.cancelOpen = false; }
      }
      if (!req || req.method !== "GET") { r.refusedAtTransport += 1; throw new Error("method refused"); }                                   // GET or the ONE PUT, nothing else
      return th.transport.send(req, o);
    };
    const stripeSend = async (call, opts) => {
      if (stopped()) { r.refusedByStop += 1; throw new Error("stopped"); }
      const o = { ...(opts && typeof opts === "object" ? opts : {}), signal: composed(opts && opts.signal) };
      if (call && call.op === "refunds.create") {
        if (r.refundInvocations >= B.refund || stopped()) { r.refusedAtTransport += 1; throw new Error("refund budget"); }                 // counter fence BEFORE the transport
        r.refundInvocations += 1; r.writes.refund += 1; fence.refundOpen = true;
        try {
          const out = await ts.transport.send(call, o);
          r.refundOutcome = out && typeof out === "object" ? "REPLIED" : "UNKNOWN";
          return out;
        } catch (e) { r.refundOutcome = fence.refundExchanged ? "UNKNOWN" : "NOT_SENT"; throw e; }
        finally { fence.refundOpen = false; }
      }
      if (!call || !["accounts.retrieve", "paymentIntents.retrieve", "refunds.retrieve", "refunds.list"].includes(call.op)) { r.refusedAtTransport += 1; throw new Error("op refused"); }
      return ts.transport.send(call, o);
    };
    const bx = tooling.createTestCleanupExecutors({ binding: { accountId: c.accountId, amountMinor: plan.capturedMinor, arrivalDate: plan.from, chargeId: plan.chargeId, departureDate: plan.to,
      listingId: c.listingId, paymentIntentId: PI, ref: intent0.ref, refundIdempotencyKey: plan.refundIdempotencyKey, refundOpId: fence.refundOpId, reservationId: RID },
      hostaway: { send: hostawaySend }, stripe: { send: stripeSend } });
    if (!bx || bx.ok !== true) return done("SCOPE_REFUSED", "EXECUTOR_BINDING_REFUSED");
    const executors = {};
    for (const k of Object.keys(bx.executors)) { const fn = bx.executors[k]; executors[k] = async (...args) => { if (stopped()) { r.refusedByStop += 1; throw new Error("stopped"); } return Reflect.apply(fn, undefined, args); }; }
    freeze(executors);
    const listings = new Map([[c.listingId, { currency: c.currency, timeZone: c.listingTimeZone }]]);
    const workerEnv = { VERCEL_ENV: "development", MV_E7_TEST_CLEANUP: "enabled", MV_E7_TEST_CLEANUP_WORKER: "enabled" };

    // ---- (9) LABELLED COPY (Slice 2 §8): bounded worker steps; lock proven before EVERY step; stop after the awaited proof and before the worker ----
    let finalFacts = null;
    for (let step = 1; step <= B.steps; step++) {
      if (stopped()) return stopOutcome();
      { const p = await proveLock(step === 1 ? "BEFORE_WORKER" : `BEFORE_STEP_${step}`); if (p) return p; }
      let w;
      if (stopped()) return stopOutcome();                                                            // immediately BEFORE the worker is admitted
      const stepSignal = composed(null);
      try {
        r.steps += 1;
        w = await tooling.runTestCleanupStep(countedPool, { workerId: `e7-hosted-tc:${plan.approvalRef}`, env: workerEnv, adapterConfig, listings, executors, clock, stripeAccountId: c.accountId,
          intentId: plan.intentId, signal: stepSignal, deadlineAt: clock() + Math.max(0, Math.floor(endsAt - mono())), monotonic: mono });
      } catch (e) {
        if (e instanceof Refusal && e.code === "DB_BUDGET") return done(uncertain() ?? "BUDGET_EXHAUSTED", "DB_QUERY_CEILING");
        if (stopped()) return stopOutcome();
        return done(uncertain() ?? "DB_ERROR", "WORKER_THREW");
      }
      for (const a of (w && Array.isArray(w.actions) ? w.actions : [])) if (r.actions.length < 200 && CODE_RE.test(String(a))) r.actions.push(String(a));
      if (w && w.late) await Promise.race([Promise.resolve(w.late).catch(() => {}), sleep(1000)]);                 // dropped late replies are never success
      if (!w || w.status === "refused") return done(uncertain() ?? "WORKER_REFUSED", w && CODE_RE.test(String(w.code)) ? String(w.code) : "WORKER_REFUSED");
      if (uncertain()) { try { finalFacts = await read(); observe(finalFacts); } catch { /* reported below */ } return done("WRITE_OUTCOME_UNKNOWN", r.cancelOutcome === "UNKNOWN" ? "LOST_CANCEL_REPLY" : "LOST_REFUND_REPLY"); }
      if (stopped()) return stopOutcome();
      try { f = await read(); } catch (e) { return e instanceof Stopped ? stopOutcome() : done("DB_ERROR", "STEP_READBACK_FAILED"); }
      observe(f);
      if (stopped()) return stopOutcome();
      const stNow = f.intent ? f.intent.status : null;
      const unknownRow = [...r.cancelOps, ...r.refundOps].some((s) => s === "outcome_unknown");
      if (unknownRow) { finalFacts = f; return done("WRITE_OUTCOME_UNKNOWN", "WORKER_SETTLED_UNKNOWN"); }          // v1: the session stops; a resume needs its OWN pinned admission
      if (stNow === "cancelled") { finalFacts = f; break; }
      if (stNow === "reconciliation_required") { finalFacts = f; return done("CLEANUP_ESCALATED", "OWNER_CASE"); }
      if (stNow !== "test_cleanup_pending") { finalFacts = f; return done("CLEANUP_UNKNOWN_STATE", `STATE_${String(stNow).toUpperCase()}`); }
      if (r.cancelOps.some((s) => s === "in_flight") || r.refundOps.some((s) => s === "in_flight")) { finalFacts = f; return done("WRITE_OUTCOME_UNKNOWN", "WRITE_ROW_IN_FLIGHT"); }
      if (r.cancelInvocations > 0 && r.cancelOps.every((s) => s === "pending")) { finalFacts = f; return done("WRITE_OUTCOME_UNKNOWN", "CANCEL_SENT_WITHOUT_SETTLEMENT"); }
      if (r.refundInvocations > 0 && r.refundOps.every((s) => s === "pending")) { finalFacts = f; return done("WRITE_OUTCOME_UNKNOWN", "REFUND_SENT_WITHOUT_SETTLEMENT"); }
      if (step === B.steps) { finalFacts = f; return done("STEP_BUDGET_EXHAUSTED", "STEPS"); }
      const delay = w.status === "worked" && Number.isSafeInteger(w.delayMs) ? Math.min(Math.max(w.delayMs, 0), B.waitCapMs) : Math.min(5000, B.waitCapMs);
      const left = endsAt - mono();
      if (left <= delay) { r.stopReason = "DEADLINE"; stopReason = "DEADLINE"; stopAc.abort(); return stopOutcome(); }
      await sleep(delay);
    }

    // ---- (10) read-only postcheck: output and persisted facts must agree; then fresh bound provider readbacks (reads only) ---------------------
    observe(finalFacts);
    const pe = checkEnd(finalFacts, plan, c, tooling);
    if (pe) return done("POSTCHECK_MISMATCH", pe);
    const re = String(finalFacts.refunds[0].stripe_refund_id);
    { const p = await proveLock("BEFORE_READBACK"); if (p) return p; }
    try {
      guard();
      const rf = await ts.transport.send({ op: "refunds.retrieve", id: re }, { signal: composed(null) });
      const ro = tooling.refundObservation(rf);
      const rfPi = typeof rf.payment_intent === "string" ? rf.payment_intent : rf.payment_intent && rf.payment_intent.id;
      if (ro.refundId !== re || rfPi !== PI || ro.chargeId !== plan.chargeId || ro.amountMinor !== plan.capturedMinor || ro.currency !== c.currency || ro.status !== "succeeded"
          || ro.metadataRefundOp !== fence.refundOpId || ro.metadataRefundKey !== plan.refundIdempotencyKey) return done("POSTCHECK_MISMATCH", "REFUND_READBACK");
      guard();
      const pi = await ts.transport.send({ op: "paymentIntents.retrieve", id: PI, params: { expand: ["latest_charge"] } }, { signal: composed(null) });
      // F1: the SAME complete v3 proof at the final boundary (accepted identity + mirrored charge checks, FULLY REFUNDED) + mirrored raw safeguards
      const observed = tooling.paymentIntentProofObservationV3(pi, { accountVerified: true });
      const ev = { id: "runner-final-readback", kind: "payment_intent", readOpType: "stripe.retrieve_payment_intent", requestRef: PI, externalRef: PI, status: observed.status, observed, observedAt: clock() };
      const v3 = piCapturedV3Refusal(ev, { intent: finalFacts.intent, attemptId: finalFacts.attempts[0].id, chargeId: plan.chargeId, capturedMinor: plan.capturedMinor, currency: c.currency, phase: "fully_refunded" }, tooling.piIdentityOk);
      if (v3) return done("POSTCHECK_MISMATCH", `PI_READBACK_${v3}`);
      const raw = rawPiFullyRefundedRefusal(pi, { paymentIntentId: PI, chargeId: plan.chargeId, amountMinor: plan.capturedMinor, currency: c.currency });
      if (raw) return done("POSTCHECK_MISMATCH", `PI_READBACK_${raw}`);
      guard();
      const rr = await th.transport.send({ method: "GET", path: `/v1/reservations/${RID}`, query: {} }, { signal: composed(null) });
      const env = rr && rr.httpStatus === 200 ? tooling.unwrapEnvelope(rr.json) : null;
      const nr = env && env.ok === true ? tooling.normalizeReservation(env.result, adapterConfig) : null;
      if (!nr || nr.ok !== true || String(nr.reservation.reservationId) !== RID || nr.reservation.listingId !== c.listingId || nr.reservation.from !== plan.from || nr.reservation.to !== plan.to
          || String(nr.reservation.status || "").toLowerCase() !== "cancelled") return done("POSTCHECK_MISMATCH", "RESERVATION_NOT_CANCELLED_AT_PROVIDER");
      r.proofs.push("READBACK");
    } catch (e) { if (e instanceof Stopped || stopped()) return stopOutcome(); return done("POSTCHECK_MISMATCH", "READBACK_FAILED"); }
    r.postcheck = { cancelOps: 1, refundOps: 1, refundRecord: "succeeded", refundId: re, capturedMinor: finalFacts.intent.payment.capturedMinor, recordingRetired: true, claimReleased: true, openCases: 0,
      legs: { reservationCancelled: true, authorizationSettled: true }, publicStatus: "not_completed_refunded" };
    if (stopped()) return stopOutcome();
    return done("TEST_CLEANUP_COMPLETED");
  };
  // LABELLED COPY (Slice 2 / Slice 1 finally, F3/F5): bounded residual read, provisional success re-validated, checked unlock on the dedicated session
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
    if ((r.steps > 0 || r.requestInvocations > 0) && input && input.pool && input.tooling) {
      const raw = { query: (sql, params) => input.pool.query(sql, params) };
      const b = await bounded(readFacts(async (sql, params) => (await input.pool.query(sql, params)).rows, input.plan, input.tooling, raw));
      if (b.done && !b.threw) observe(b.value);
      if (r.outcome === "TEST_CLEANUP_COMPLETED") {
        const re = b.done && !b.threw ? checkEnd(b.value, input.plan, CONSTANTS, input.tooling) : "RESIDUAL_READ_UNAVAILABLE";
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
      if (lockAcquired && !released && r.outcome === "TEST_CLEANUP_COMPLETED") { r.outcome = "NOT_CONFIRMED"; r.code = lockErrored ? "LOCK_SESSION_ERROR_AT_TEARDOWN" : "UNLOCK_NOT_PROVEN"; }
    }
    if (r.outcome === "TEST_CLEANUP_COMPLETED" && stopped()) { r.outcome = "NOT_CONFIRMED"; r.code = `STOP_${stopReason}_AT_TEARDOWN`; }
  }
  return snapshot();
}

// =================================================================================================================================
// hosted wrapper (GitHub Actions): preflight (no secrets) / verify / execute (CLOSED until executeEnabled is reviewed true)
// LABELLED COPY of the reviewed Slice 2 runHosted, specialised: cleanup inputs, cleanup closure / runner files, HTC_ codes, two pools (6543 / 5432).
export const CLOSURE_DIGEST_PREFIX = "e7-hosted-test-cleanup-closure-v1\n";
export const RUNNER_DIGEST_PREFIX = "e7-hosted-test-cleanup-runner-v1\n";
const TEST_FILE = "test/e7-hosted-test-cleanup.test.mjs";
const SECRET_KEYS = Object.freeze(["E7_STRIPE_TEST_KEY", "E7_HOSTAWAY_TOKEN", "E7_DEV_BOOKING_DATABASE_URL"]);
export const INPUT_ENV = freeze({ approvalRef: "E7_APPROVAL_REF", intentId: "E7_INTENT_ID", expectedVersion: "E7_EXPECTED_VERSION", notBefore: "E7_NOT_BEFORE", paymentIntentId: "E7_PAYMENT_INTENT_ID",
  reservationId: "E7_RESERVATION_ID", chargeId: "E7_CHARGE_ID", capturedMinor: "E7_CAPTURED_MINOR", from: "E7_STAY_FROM", to: "E7_STAY_TO", guests: "E7_GUESTS", attemptId: "E7_ATTEMPT_ID", sessionId: "E7_SESSION_ID" });

/** runHosted({ mode, env, proc, wrapperDir, deps }) → { exitCode, result }. Never throws. deps = TEST SEAMS. */
export async function runHosted({ mode = "preflight", env, proc, wrapperDir, deps = {} }) {
  const c = deps.constants ?? CONSTANTS;
  const spawnChild = deps.spawnChild ?? spawnNode;
  const importEnv = deps.importEnv ?? ((dir) => import(pathToFileURL(`${dir}/scripts/e7-connected/probe-env-preflight.mjs`).href));
  const importTooling = deps.importTooling ?? defaultImportTooling;
  const runCore = deps.runCore ?? runTestCleanupCore;
  const readPgVersion = deps.readPgVersion ?? (async (dir) => JSON.parse(await readFile(`${dir}/node_modules/pg/package.json`, "utf8")).version);
  const readCa = deps.readCa ?? ((p) => readFile(p));
  const r = { schema: "e7-hosted-test-cleanup-hosted-v1", mode: null, code: null, workflowSha: null, toolingCommit: c.toolingCommit, toolingStatus: c.toolingStatus,
    executeEnabled: c.executeEnabled, closureDigest: null, runnerDigest: null, planKind: null, planHash: null, envCode: null, tests: null, lockEndpoint: null, core: null };
  let pool = null; let lockPool = null;
  try {
    if (!["preflight", "verify", "execute"].includes(mode)) refuse("HTC_USAGE");
    r.mode = mode;
    r.workflowSha = HEX40.test(env.E7_WORKFLOW_SHA ?? "") ? env.E7_WORKFLOW_SHA : null;
    const has = (k) => typeof env[k] === "string" && env[k].length > 0;
    if (mode !== "execute" && SECRET_KEYS.some(has)) refuse("HTC_SECRET_SCOPE_VIOLATION");
    const inp = {}; for (const k of PLAN_INPUT_KEYS) inp[k] = env[INPUT_ENV[k]] ?? "";
    const expPlan = env.E7_EXPECTED_PLAN_HASH ?? ""; const expClo = env.E7_EXPECTED_CLOSURE_DIGEST ?? ""; const expRun = env.E7_EXPECTED_RUNNER_DIGEST ?? "";
    const vals = PLAN_INPUT_KEYS.map((k) => inp[k]); const anyReal = vals.some((v) => v !== "");
    if (anyReal && vals.some((v) => v === "")) refuse("HTC_INPUT_INCOMPLETE");
    if (anyReal && (!APPROVAL_RE.test(inp.approvalRef) || !INTENT_RE.test(inp.intentId) || !/^[1-9][0-9]{0,6}$/.test(inp.expectedVersion) || isoMs(inp.notBefore) === null || !PI_RE.test(inp.paymentIntentId)
        || !RID_RE.test(inp.reservationId) || !CHARGE_RE.test(inp.chargeId) || !/^[1-9][0-9]{0,7}$/.test(inp.capturedMinor) || !realDate(inp.from) || !realDate(inp.to) || !/^[1-9][0-9]?$/.test(inp.guests)
        || !UUID_RE.test(inp.attemptId) || !SESSION_RE.test(inp.sessionId))) refuse("HTC_INPUT_INVALID");
    if (inp.approvalRef === c.synthetic.approvalRef || inp.intentId === c.synthetic.intentId) refuse("HTC_INPUT_INVALID");
    if (mode !== "preflight") {
      if (c.executeEnabled !== true || c.toolingStatus !== "MERGED" || !HEX64.test(String(c.closureDigest))) refuse("HTC_EXECUTE_CLOSED");   // Slice 3: CLOSED
      if (!anyReal || !HEX64.test(expPlan) || !HEX64.test(expClo) || !HEX64.test(expRun)) refuse("HTC_INPUT_INCOMPLETE");
      if (env.GITHUB_REF !== "refs/heads/main") refuse("HTC_REF_NOT_MAIN");
      if (expClo !== c.closureDigest) refuse("HTC_SOURCE_MISMATCH");
    }
    const tooling = await realpath(env.E7_TOOLING_DIR ?? "").catch(() => refuse("HTC_LAYOUT_INVALID"));
    const wdir = await realpath(wrapperDir).catch(() => refuse("HTC_LAYOUT_INVALID"));
    if (tooling === wdir || tooling.startsWith(`${wdir}/`) || wdir.startsWith(`${tooling}/`)) refuse("HTC_LAYOUT_INVALID");
    r.closureDigest = await framedDigest(tooling, c.closure, CLOSURE_DIGEST_PREFIX).catch(() => refuse("HTC_SOURCE_UNREADABLE"));
    if (r.closureDigest !== c.closureDigest) refuse("HTC_SOURCE_MISMATCH");
    r.runnerDigest = await framedDigest(wdir, c.runnerFiles, RUNNER_DIGEST_PREFIX).catch(() => refuse("HTC_SOURCE_UNREADABLE"));
    if (mode !== "preflight" && r.runnerDigest !== expRun) refuse("HTC_RUNNER_MISMATCH");
    r.planKind = anyReal ? "REAL" : "SYNTHETIC";
    const s = c.synthetic;
    const built = buildPlan(c, anyReal ? { ...inp, expectedVersion: Number(inp.expectedVersion), capturedMinor: Number(inp.capturedMinor), guests: Number(inp.guests), runnerDigest: r.runnerDigest }
      : { ...s, runnerDigest: r.runnerDigest });
    r.planHash = built.planHash;
    if (mode !== "preflight" && built.planHash !== expPlan) refuse("HTC_PLAN_HASH_MISMATCH");
    let C1; try { C1 = await importEnv(tooling); } catch { refuse("HTC_IMPORT_FAILED"); }
    const present = Object.fromEntries(C1.PRESENT_KEYS.map((k) => [k, Object.hasOwn(env, k)]));
    let uid = null; try { if (typeof proc.getuid === "function") { const u = proc.getuid(); if (Number.isSafeInteger(u) && u >= 0) uid = u; } } catch { uid = null; }
    const ev = C1.evaluateProbeEnvironment({ schema: C1.ENV_SNAPSHOT_SCHEMA, nodeVersion: String(proc.versions.node), platform: proc.platform,
      execArgvCount: proc.execArgv.length, uidAvailable: uid !== null, present });
    r.envCode = typeof ev.code === "string" && C1.ENV_CODES.includes(ev.code) ? ev.code : "REDACTED";
    if (ev.ok !== true || proc.versions.node !== c.nodeVersion) refuse("HTC_ENV_REFUSED");
    if (mode === "preflight") {
      const o = await spawnChild(["--test", "--test-reporter=tap", TEST_FILE], { cwd: wdir, env: childEnv(env, tooling) });
      if (!o || o.spawnFailed || (o.signal !== null && o.signal !== undefined) || !Number.isSafeInteger(o.status) || o.truncated) refuse("HTC_CHILD_FAILED");
      const num = (re) => { const m = re.exec(o.stdout); return m ? Number(m[1]) : null; };
      r.tests = { status: o.status, tests: num(/^# tests (\d+)$/m), pass: num(/^# pass (\d+)$/m), fail: num(/^# fail (\d+)$/m), connectivityEvidence: false };
      if (o.status !== 0 || !(r.tests.tests > 0) || r.tests.pass !== r.tests.tests || r.tests.fail !== 0) refuse("HTC_TESTS_FAILED");
      r.code = anyReal ? "PREFLIGHT_OK_REAL_PLAN" : "PREFLIGHT_OK_SYNTHETIC_ONLY"; return { exitCode: 0, result: r };
    }
    if (mode === "verify") { r.code = "VERIFY_OK"; return { exitCode: 0, result: r }; }
    if (!SECRET_KEYS.every(has)) refuse("HTC_CREDENTIALS_MISSING");
    let pgv; try { pgv = await readPgVersion(tooling); } catch { pgv = null; }
    if (pgv !== c.pgVersion) refuse("HTC_DEPENDENCY_MISMATCH");
    let skey = env.E7_STRIPE_TEST_KEY; delete env.E7_STRIPE_TEST_KEY;
    let htok = env.E7_HOSTAWAY_TOKEN; delete env.E7_HOSTAWAY_TOKEN;
    let dbUrl = env.E7_DEV_BOOKING_DATABASE_URL; delete env.E7_DEV_BOOKING_DATABASE_URL;
    const wipe = () => { skey = null; htok = null; dbUrl = null; };
    if (!dbTargetOk(dbUrl, c)) { wipe(); refuse("HTC_DB_TARGET_INVALID"); }
    let caPem = null;
    try { const b = await readCa(env.E7_CA_FILE ?? ""); if (sha(b) === (deps.caSha256 ?? OFFICIAL_CA_SHA256) && b.length < 16384) caPem = b.toString("utf8"); } catch { caPem = null; }
    if (caPem === null) { wipe(); refuse("HTC_CA_INVALID"); }
    let mods; try { mods = await importTooling(tooling); } catch { wipe(); refuse("HTC_IMPORT_FAILED"); }
    const xs = mods.X.createE7RealExchange({ provider: "stripe" }); const xh = mods.X.createE7RealExchange({ provider: "hostaway" });
    if (!xs || xs.ok !== true || !xh || xh.ok !== true) { wipe(); refuse("HTC_IMPORT_FAILED"); }
    let lockUrl = sessionLockUrl(dbUrl, c);
    if (lockUrl === null) { wipe(); refuse("HTC_DB_TARGET_INVALID"); }
    try {
      pool = mods.createBookingPool({ connectionString: dbUrl, caPem, max: 3 });                      // worker pool: transaction pooler (6543)
      lockPool = mods.createBookingPool({ connectionString: lockUrl, caPem, max: 1 });                // dedicated SESSION lock connection (5432)
    } catch { wipe(); refuse("HTC_DB_TARGET_INVALID"); } finally { dbUrl = null; lockUrl = null; }
    r.lockEndpoint = `session:${SESSION_LOCK_PORT}`;
    const ac = new AbortController(); const onSig = () => ac.abort(); proc.once?.("SIGINT", onSig); proc.once?.("SIGTERM", onSig);
    try {
      r.core = await runCore({ plan: built.plan, planHash: built.planHash, pool, lockClientFactory: () => lockPool.connect(), tooling: mods.tooling, exchanges: { stripe: xs.exchange, hostaway: xh.exchange },
        credentials: { stripe: () => skey, hostaway: () => htok }, runSignal: ac.signal });
    } finally { wipe(); proc.off?.("SIGINT", onSig); proc.off?.("SIGTERM", onSig); }
    r.code = "EXECUTE_DONE";
    return { exitCode: r.core && r.core.outcome === "TEST_CLEANUP_COMPLETED" ? 0 : 1, result: r };
  } catch (e) {
    r.code = e instanceof Refusal && HOSTED_CODES.includes(e.code) ? e.code : "HTC_INTERNAL";
    return { exitCode: 1, result: r };
  } finally {
    if (lockPool) await lockPool.end().catch(() => {});
    if (pool) await pool.end().catch(() => {});
  }
}
async function defaultImportTooling(dir) {
  const u = (p) => pathToFileURL(`${dir}/${p}`).href;
  const [W, TC, R, EX, TT, T, X, P, HR, CP, RP, TP, CO, IS, LK] = await Promise.all([import(u("lib/booking-db/cleanup-worker.js")), import(u("lib/booking-db/test-cleanup.js")),
    import(u("lib/booking-db/repo.js")), import(u("scripts/e7-connected/test-cleanup-executors.mjs")), import(u("scripts/e7-connected/test-cleanup-transports.mjs")),
    import(u("scripts/e7-connected/http-transports.mjs")), import(u("scripts/e7-connected/real-exchange.mjs")), import(u("lib/booking-db/pool.js")), import(u("lib/hostaway-reservations.js")),
    import(u("lib/checkout/capture-proof.js")), import(u("lib/checkout/recovery-plan.js")), import(u("lib/checkout/test-cleanup-proof.js")), import(u("lib/checkout/compensation-proof.js")),
    import(u("lib/checkout/intent-state.js")), import(u("scripts/e7-connected/run-lock-precheck.mjs"))]);
  return { X, createBookingPool: P.createBookingPool,
    tooling: { runTestCleanupStep: W.runTestCleanupStep, requestTestCleanup: TC.requestTestCleanup, loadIntent: R.loadIntent, createTestCleanupExecutors: EX.createTestCleanupExecutors,
      createStripeSend: TT.createE7StripeTestCleanupSend, createHostawaySend: T.createE7HostawaySend, validateAdapterConfig: HR.validateAdapterConfig, unwrapEnvelope: HR.unwrapEnvelope,
      normalizeReservation: HR.normalizeReservation, lookupByRef: HR.lookupByRef, activeReservationProof: CO.activeReservationProof, paymentIntentProofObservationV3: CP.paymentIntentProofObservationV3,
      piIdentityOk: RP.piIdentityOk, rawPiPreSendRefusal: TP.rawPiPreSendRefusal, refundObservation: TP.refundObservation, arrivalStrictlyFuture: CO.arrivalStrictlyFuture, refundKey: IS.refundKey,
      publicStatus: IS.publicStatus, LOCK_KEY: LK.LOCK_KEY, LOCK_PRECHECK_SQL: LK.LOCK_PRECHECK_SQL } };
}
export function summaryMarkdown(r) {
  const core = r.core ? ` core=${r.core.outcome}${r.core.code ? `/${r.core.code}` : ""} request=${r.core.requestInvocations}/${r.core.requestOutcome} steps=${r.core.steps} cancel=${r.core.cancelInvocations}/${r.core.cancelOutcome} refund=${r.core.refundInvocations}/${r.core.refundOutcome} lock=${r.core.lock} publicStatus=${r.core.publicStatus}` : "";
  return `e7-hosted-test-cleanup ${r.mode} ${r.code} executeEnabled=${r.executeEnabled} lock=${r.lockEndpoint ?? "-"} plan=${r.planKind ?? "-"}:${r.planHash ?? "-"} closure=${r.closureDigest ?? "-"} runner=${r.runnerDigest ?? "-"}${core}\n`;
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
