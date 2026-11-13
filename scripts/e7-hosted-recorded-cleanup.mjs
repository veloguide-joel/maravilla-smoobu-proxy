// scripts/e7-hosted-recorded-cleanup.mjs — E7 Slice 5: HOSTED (GitHub Actions) RECORDED-TEST CLEANUP for ONE admitted RECORDED TEST intent:
// confirmed (captured + ONE succeeded LINKED Hostaway offline-charge recording + ONE pristine queued guest.notify) → (ONE accepted
// requestRecordedTestCleanup, lib/booking-db/test-cleanup-recorded.js: THREE legs open, the notification SUPPRESSED, the recording NOT retired) →
// test_cleanup_pending → (the ACCEPTED cleanup worker, runTestCleanupStep: ONE host-cancel PUT, then ONE bound FULL Stripe refund POST, each proven
// by a confirming READ) → both legs proven → (the ACCEPTED mirror worker, runMirrorStep, ONLY once both legs are proven: fresh account / PI /
// cancelled-reservation / complete LIST proofs, ONE bound Hostaway offline-refund POST, confirming LIST, 0021 completion) → cancelled /
// not_completed_refunded, on the TEST DEV database, with FAKE-free real transports. Bookkeeping at Hostaway moves no money; the Stripe refund does.
//
// HONEST LABEL: MANUAL hosted RECORDED-TEST cleanup (workflow_dispatch + the existing reviewer gate), NOT automatic customer checkout and NOT a
// customer refund path. Code is NOT consent: executeEnabled is CLOSED here (verify / execute refuse HRT_EXECUTE_CLOSED). The Slice 1–4 runners stay
// CLOSED and pinned to THEIR tooling; this runner pins the LATER immutable MERGED e7-test tooling e41b654a (PR75 0021 foundation + PR76 mirror worker).
// DISTINCT from the pristine Slice 3 runner (which admits a payment_captured intent with a PRISTINE recording row; a recorded intent is refused there).
//   * Inert on import (`import.meta.main` guard): no env / fs / network / DB / timer until a mode runs.
//   * LABELLED SPECIALISATION of the reviewed Slice 3 runner (scripts/e7-hosted-test-cleanup.mjs) + the Slice 4 counted-teardown / synchronous
//     stop-latch sections (scripts/e7-hosted-recording.mjs): hosted boot / pinning / session lock (5432) / counted pool / stop latch / fence / step /
//     postcheck / teardown are LABELLED COPIES specialised to the recorded phase (pure helpers imported from ./e7-hosted-reservation.mjs). The request
//     (requestRecordedTestCleanup), BOTH workers (runTestCleanupStep, runMirrorStep) and the pure proof modules are the ACCEPTED modules, never copied
//     or rebuilt; the cleanup executors / transports are the ISOLATED accepted test-cleanup modules; the ONE mirror POST goes through the NEW accepted
//     BOUND mirror transport (lib/booking-db/mirror-transport.js: validated immutable per-intent binding, exact fences, private counter) over the
//     accepted real exchange via a runner-local fetch adapter; the mirror worker's reads use the accepted executors / H2 + H8 transport forms.
//   * Exact pins (plan hash): approval label, intent UUID, expected version, not-before (never a historic intent), the bound PaymentIntent id, the
//     bound Hostaway reservation id, the bound Stripe charge id, the bound ORIGINAL Hostaway offline-charge id, the EXACT captured amount, the stay
//     (from / to / guests), the completed payment attempt id and the Checkout Session id (the accepted 18-key operator expectation is DERIVED from the
//     plan + its hash, never read from the DB); fixed listing 606998 / USD / ref field / Stripe TEST account / Stripe-Version / DEV project ref /
//     TEST recording config (paymentMethod "credit_card", accountRef "hostaway-e7-test"); the accepted keys ref:<intent>:1 / och:<intent>:1 /
//     ochr:<intent>:1; the accepted mirror title "maraVilla refund mvochr1-<intent>" and exact decimal amount. The pins are RE-READ from the
//     database and cross-checked before anything else (CORE_INVALID / SCOPE_REFUSED on any mismatch). clientSnapshotId = the immutable hosted run id.
//   * Admission (read-only, before the lock): confirmed at the pinned version, ONE succeeded capture row (attempt 1, the pinned Stripe charge /
//     amount / accepted key), ONE recording row SUCCEEDED + LINKED (och:<intent>:1, attempt 1, result_ref = the pinned original, bound payload),
//     intents.offline_charge_id = the pinned original, ONE guest.notify row PRISTINE (pending / attempts 0 / never dispatched / unleased / no render /
//     no latch / no suppression), ZERO cancel / refund / mirror / void rows, ZERO payment_refunds, the capture AND the recording ledgered once,
//     no refund / void / mirror ledger or evidence, no reservation lease / work lease / open case / recording hold, the claim held, TEST livemode,
//     and the READ-ONLY schema prerequisite: the reviewed 0019 + 0020 + 0021 objects present — NEVER auto-migrated (SCHEMA_PREREQUISITE_MISSING).
//   * Order: start check → P3 session lock on a DEDICATED 5432 session (pid-stable proof before every step) → DB identity / role → account + fresh
//     STRICT captured-and-UNREFUNDED Stripe proof + the bound ACTIVE future-arrival reservation with the booking ref ECHOED (the accepted mirror
//     worker requires the full identity incl. the ref on the cancelled reservation; a non-echoed ref refuses HERE: REF_NOT_ECHOED) + ONE complete
//     charge LIST (original present and unchanged, ZERO refund / mirror-marker / same-amount / untyped-link rows) → ONE requestRecordedTestCleanup →
//     exact lineage check → bounded cleanup-worker steps (cancel, then refund) → both legs proven → bounded mirror-worker steps → read-only postcheck
//     + fresh bound Refund GET + fully-refunded PI readback + cancelled reservation identity readback + complete LIST readback (original unchanged,
//     exactly ONE typed-linked exact-marked mirror refund row = the persisted result) + residual DB re-validation at teardown (counted reserve).
//   * Fence (counted BEFORE the transport, every other exchange refused in-process): Stripe GET account / GET the bound PI / GET refunds/{re_} /
//     GET refunds?payment_intent=<bound>&limit=100, and AT MOST ONE POST /v1/refunds with the EXACT body and the accepted Idempotency-Key; Hostaway
//     GET the bound reservation id / THIS arrival's lookup page / GET guestPayments/charges?limit=500&reservationIds=<bound> (accepted H8 wire), AT
//     MOST ONE PUT …/reservations/<bound>/statuses/cancelled (accepted body) and AT MOST ONE POST …/guestPayments/charges/<bound>/<original>/refund
//     with the EXACT JSON body { title, amount, isIncludeInPriceBreakdown: 0 } — in that order (cancel → refund → mirror).
//   * Stops: the runner-owned AbortController is passed to BOTH accepted workers as THEIR `signal`, composed into every transport signal and aborted
//     SYNCHRONOUSLY by the lock-session error listener, the run abort and the wall deadline (PR72 / PR76: both workers admit it at every awaited
//     boundary). v1 STOP on: refusal, deadline, lock loss / backend hop / session error, identity mismatch, request throw (REQUEST_OUTCOME_UNKNOWN:
//     never repeated blindly), a possibly-sent write without an admissible reply (WRITE_OUTCOME_UNKNOWN: the session stops, the persisted facts are
//     reported; a future resume needs its OWN pinned admission / review — a second admission on a non-pristine lineage refuses read-only), a mirror
//     HOLD / escalation (owner case), budget, cancellation. Never a resend.
//   * Never: capture, void, create, a second offline-charge recording, notification SEND (the ONE queued row is suppressed by the accepted request
//     and verified so), queue draining, historical intents, protected reservation ids, a migration.
import process from "node:process";
import { readFile, realpath } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { CONSTANTS as RES, canonical, framedDigest, childEnv, spawnNode, dbTargetOk, sessionLockUrl, SESSION_LOCK_PORT, OFFICIAL_CA_SHA256 } from "./e7-hosted-reservation.mjs";

export const CONSTANTS = Object.freeze({
  toolingCommit: "e41b654a667cb0ba8775b5bd0040c28a3d14fda0",    // e7-test: PR75 (0021 recorded-cleanup foundation) + PR76 rev2 (mirror worker / proofs / bound transport) MERGED; immutable
  toolingStatus: "MERGED",
  executeEnabled: false,                                          // Slice 5: recorded cleanup execution default CLOSED (verify / execute refuse HRT_EXECUTE_CLOSED)
  // the INDEPENDENTLY scanned transitive relative imports of the runner's tooling roots at e41b654a (test C2 recomputes this from the pinned tree):
  // = the Slice 3 closure + test-cleanup-recorded.js + mirror-worker.js + mirror-transport.js + mirror-proof.js + offline-charge-proof.js
  closure: Object.freeze(["lib/bookability.js", "lib/booking-db/cleanup-worker.js", "lib/booking-db/codec.js", "lib/booking-db/config.js", "lib/booking-db/mirror-transport.js",
    "lib/booking-db/mirror-worker.js", "lib/booking-db/operations.js", "lib/booking-db/pool.js", "lib/booking-db/recovery.js", "lib/booking-db/repo.js", "lib/booking-db/reservation-worker.js",
    "lib/booking-db/test-cleanup-recorded.js", "lib/booking-db/test-cleanup.js", "lib/checkout/capture-proof.js", "lib/checkout/compensation-proof.js", "lib/checkout/final-price.js",
    "lib/checkout/intent-state.js", "lib/checkout/mirror-proof.js", "lib/checkout/offline-charge-proof.js", "lib/checkout/recovery-plan.js", "lib/checkout/server-pricer.js",
    "lib/checkout/test-cleanup-proof.js", "lib/direct-policy.js", "lib/direct-pricing.js", "lib/hostaway-calendar.js", "lib/hostaway-reservations.js", "lib/hostaway.js", "lib/public-api.js",
    "lib/quote-public.js", "package-lock.json", "package.json", "scripts/e7-connected/http-transports.mjs", "scripts/e7-connected/probe-env-preflight.mjs", "scripts/e7-connected/real-exchange.mjs",
    "scripts/e7-connected/run-lock-precheck.mjs", "scripts/e7-connected/test-cleanup-executors.mjs", "scripts/e7-connected/test-cleanup-transports.mjs"]),
  closureDigest: "85c72bf661a7ad52b690227642c85a6f73d32639352c91d9f06fe02ccf72bee4",
  pgVersion: "8.18.0",                                            // package-lock.json at e41b654a (checked against node_modules/pg before execute)
  runnerFiles: Object.freeze(["scripts/e7-hosted-recorded-cleanup.mjs", "scripts/e7-hosted-reservation.mjs", ".github/workflows/e7-hosted-recorded-cleanup.yml", "test/e7-hosted-recorded-cleanup.test.mjs"]),
  accountId: RES.accountId, listingId: RES.listingId, currency: RES.currency, refFieldId: RES.refFieldId, listingTimeZone: RES.listingTimeZone,
  stripeVersion: RES.stripeVersion, protectedReservationIds: RES.protectedReservationIds,
  // TEST recording configuration (= Slice 4; the mirror worker's recordingConfig): labels are labels only, never authentication
  paymentMethod: "credit_card", accountRef: "hostaway-e7-test",
  // workers: the happy recorded cleanup is THREE worker steps (cleanup worker: cancel leg, refund leg; mirror worker: ONE step) with 30 s waits between
  // them. dbQueries = the TOTAL statement ceiling of a session, EVERY statement included (runner reads + the ONE request + both workers + lock session +
  // the teardown residual read + the unlock); dbTeardownReserve of that total is reserved for the teardown (Slice 4 F2). MEASURED on disposable PG16
  // with the REAL request + REAL workers + REAL bound transport (test I1): 468 statements TOTAL (teardown 17), 24 exchanges (Hostaway reservation reads 5,
  // lookup pages 0, charge lists 4 = runner proof + mirror pre-send + mirror confirming + runner readback, account 4, PI 6, refund reads 2, refund lists 0),
  // 3 steps (cleanup 2 / mirror 1). Ceilings ≈ 3x the measured values (each worker's own per-kind read admission stays authoritative). Fail-closed past them.
  budgets: Object.freeze({ steps: 24, cancel: 1, refund: 1, mirror: 1, hostawayReads: 15, lookupPages: 18, chargeLists: 15, accountReads: 12, piReads: 18, refundReads: 8, refundLists: 4,
    exchanges: 90, dbQueries: 1500, dbTeardownReserve: 60, runMs: 20 * 60 * 1000, waitCapMs: 35 * 1000 }),
  dbEnvironment: RES.dbEnvironment, dbProjectRef: RES.dbProjectRef, nodeVersion: RES.nodeVersion,
  synthetic: Object.freeze({ approvalRef: "SYNTHETIC-recorded-cleanup-preflight-not-for-execute", intentId: "00000000-0000-4000-8000-000000000000", expectedVersion: 10,
    notBefore: "2026-11-12T00:00:00.000Z", paymentIntentId: "pi_SYNTHETIC00000000000000", reservationId: "1", chargeId: "ch_SYNTHETIC00000000000000", offlineChargeId: "2", capturedMinor: 1,
    from: "2027-01-01", to: "2027-01-02", guests: 1, attemptId: "00000000-0000-4000-8000-000000000001", sessionId: "cs_test_SYNTHETIC0000000000" })
});
export const PLAN_SCHEMA = "e7-hosted-recorded-cleanup-plan-v1";
export const RESULT_SCHEMA = "e7-hosted-recorded-cleanup-result-v1";
export const OUTCOMES = Object.freeze(["RECORDED_CLEANUP_COMPLETED", "SCOPE_REFUSED", "START_STATE_NOT_ELIGIBLE", "SCHEMA_PREREQUISITE_MISSING", "LOCK_NOT_ACQUIRED", "LOCK_LOST",
  "DB_IDENTITY_MISMATCH", "PROVIDER_PROOF_FAILED", "REQUEST_REFUSED", "REQUEST_OUTCOME_UNKNOWN", "LINEAGE_MISMATCH", "WORKER_REFUSED", "WRITE_OUTCOME_UNKNOWN",
  "CLEANUP_ESCALATED", "CLEANUP_UNKNOWN_STATE", "STEP_BUDGET_EXHAUSTED", "BUDGET_EXHAUSTED", "DEADLINE", "ABORTED", "DB_ERROR", "POSTCHECK_MISMATCH", "NOT_CONFIRMED", "CORE_INVALID"]);
export const HOSTED_CODES = Object.freeze(["HRT_USAGE", "HRT_SECRET_SCOPE_VIOLATION", "HRT_INPUT_INVALID", "HRT_INPUT_INCOMPLETE", "HRT_REF_NOT_MAIN",
  "HRT_EXECUTE_CLOSED", "HRT_LAYOUT_INVALID", "HRT_SOURCE_UNREADABLE", "HRT_SOURCE_MISMATCH", "HRT_RUNNER_MISMATCH", "HRT_PLAN_HASH_MISMATCH",
  "HRT_DEPENDENCY_MISMATCH", "HRT_ENV_REFUSED", "HRT_TESTS_FAILED", "HRT_CHILD_FAILED", "HRT_IMPORT_FAILED", "HRT_CREDENTIALS_MISSING",
  "HRT_DB_TARGET_INVALID", "HRT_CA_INVALID", "HRT_INTERNAL", "PREFLIGHT_OK_REAL_PLAN", "PREFLIGHT_OK_SYNTHETIC_ONLY", "VERIFY_OK", "EXECUTE_DONE"]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;            // = the accepted request's UUID rule (attempt ids are v4 or DB-generated)
const INTENT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RID_RE = /^[1-9][0-9]{0,11}$/;                                                           // = the accepted request's RES_RE
const OCH_RE = /^[1-9][0-9]{0,15}$/;                                                           // = the accepted request's OCH_RE (canonical Hostaway charge id)
const PI_RE = /^pi_[A-Za-z0-9_]{8,250}$/;
const CHARGE_RE = /^(ch|py)_[A-Za-z0-9_]{8,200}$/;
const SESSION_RE = /^cs_test_[A-Za-z0-9]{8,96}$/;
const REFUND_RE = /^re_[A-Za-z0-9_]{1,200}$/;
const APPROVAL_RE = /^[A-Za-z0-9._:-]{1,80}$/;
const RUN_ID_RE = /^[A-Za-z0-9._:-]{8,64}$/;                                                   // ⊂ the accepted LABEL_RE; the immutable hosted run id (clientSnapshotId)
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HEX64 = /^[0-9a-f]{64}$/; const HEX40 = /^[0-9a-f]{40}$/;
const CODE_RE = /^[A-Za-z0-9_:>!.-]{1,80}$/;
const STRIPE = "https://api.stripe.com"; const HOSTAWAY = "https://api.hostaway.com";
const CANCEL_BODY_WIRE = JSON.stringify({ cancelledBy: "host" });                                 // = the accepted CANCEL_BODY (compensation-proof.js) as the transport serialises it
const TEST_CLEANUP_REASON = "TEST_CLEANUP_REQUESTED";
const LIST_LIMIT = 500;                                                                          // = the accepted LIST_LIMIT / MIRROR_LIST_LIMIT (asserted by the tests)
const freeze = Object.freeze;
class Refusal extends Error { constructor(code) { super("e7-hosted-recorded-cleanup"); this.code = code; } }
const refuse = (code) => { throw new Refusal(code); };
const sha = (s) => createHash("sha256").update(s).digest("hex");
function deepFreeze(v) { if (v && typeof v === "object") { for (const k of Object.keys(v)) deepFreeze(v[k]); freeze(v); } return v; }
const isVersion = (v) => Number.isSafeInteger(v) && v >= 1 && v <= 1000000;
const isAmount = (v) => Number.isSafeInteger(v) && v >= 1 && v <= 99999999;
const isGuests = (v) => Number.isSafeInteger(v) && v >= 1 && v <= 50;
const isoMs = (s) => (typeof s === "string" && ISO_RE.test(s) && Number.isFinite(Date.parse(s)) && new Date(Date.parse(s)).toISOString() === (s.length === 20 ? `${s.slice(0, 19)}.000Z` : s) ? Date.parse(s) : null);
const realDate = (s) => typeof s === "string" && DATE_RE.test(s) && Number.isFinite(Date.parse(`${s}T00:00:00Z`)) && new Date(Date.parse(`${s}T00:00:00Z`)).toISOString().slice(0, 10) === s;
const enc = (v) => encodeURIComponent(String(v));
/** LABELLED COPIES of the accepted wire forms (cross-checked against the tooling's own functions by the tests) */
export const offlineChargeTitle = (intentId) => `maraVilla payment mvoch1-${intentId}`;
export const mirrorTitle = (intentId) => `maraVilla refund mvochr1-${intentId}`;
export const exactAmount = (minor) => { if (!isAmount(minor)) return null; const n = Number(`${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, "0")}`); return Number.isFinite(n) ? n : null; };

// =================================================================================================================================
// plan (pure)
export const PLAN_INPUT_KEYS = freeze(["approvalRef", "intentId", "expectedVersion", "notBefore", "paymentIntentId", "reservationId", "chargeId", "offlineChargeId", "capturedMinor", "from", "to", "guests", "attemptId", "sessionId"]);
/** buildPlan(c, { ...PLAN_INPUT_KEYS, runnerDigest }) → frozen { plan, planHash } */
export function buildPlan(c, { approvalRef, intentId, expectedVersion, notBefore, paymentIntentId, reservationId, chargeId, offlineChargeId, capturedMinor, from, to, guests, attemptId, sessionId, runnerDigest }) {
  if (typeof approvalRef !== "string" || !APPROVAL_RE.test(approvalRef)) refuse("HRT_INPUT_INVALID");
  if (typeof intentId !== "string" || !INTENT_RE.test(intentId) || !isVersion(expectedVersion)) refuse("HRT_INPUT_INVALID");
  if (isoMs(notBefore) === null) refuse("HRT_INPUT_INVALID");
  if (typeof paymentIntentId !== "string" || !PI_RE.test(paymentIntentId)) refuse("HRT_INPUT_INVALID");
  if (typeof reservationId !== "string" || !RID_RE.test(reservationId) || c.protectedReservationIds.includes(reservationId)) refuse("HRT_INPUT_INVALID");
  if (typeof chargeId !== "string" || !CHARGE_RE.test(chargeId) || !isAmount(capturedMinor) || exactAmount(capturedMinor) === null) refuse("HRT_INPUT_INVALID");
  if (typeof offlineChargeId !== "string" || !OCH_RE.test(offlineChargeId) || offlineChargeId === reservationId) refuse("HRT_INPUT_INVALID");   // a Hostaway decimal id; never a Stripe id, never the reservation
  if (!realDate(from) || !realDate(to) || !(from < to) || !isGuests(guests)) refuse("HRT_INPUT_INVALID");
  if (typeof attemptId !== "string" || !UUID_RE.test(attemptId) || typeof sessionId !== "string" || !SESSION_RE.test(sessionId)) refuse("HRT_INPUT_INVALID");
  if (typeof runnerDigest !== "string" || !HEX64.test(runnerDigest)) refuse("HRT_INPUT_INVALID");
  if (c.accountId !== "acct_1TyHE42B9LTneQgw" || c.listingId !== 606998 || c.currency !== "USD" || c.stripeVersion !== "2026-01-28.clover" || c.dbEnvironment !== "test"
      || c.paymentMethod !== "credit_card" || c.accountRef !== "hostaway-e7-test" || c.budgets.cancel !== 1 || c.budgets.refund !== 1 || c.budgets.mirror !== 1 || c.budgets.steps !== 24
      || c.budgets.runMs !== 20 * 60 * 1000 || !(c.budgets.dbTeardownReserve > 0 && c.budgets.dbTeardownReserve < c.budgets.dbQueries)) refuse("HRT_INPUT_INVALID");      // code ceiling
  const plan = { schema: PLAN_SCHEMA, toolingCommit: c.toolingCommit, toolingStatus: c.toolingStatus, closureDigest: c.closureDigest, runnerDigest,
    pgVersion: c.pgVersion, stripeVersion: c.stripeVersion, accountId: c.accountId, listingId: c.listingId, currency: c.currency, refFieldId: c.refFieldId,
    listingTimeZone: c.listingTimeZone, dbEnvironment: c.dbEnvironment, dbProjectRef: c.dbProjectRef, paymentMethod: c.paymentMethod, accountRef: c.accountRef,
    intentId, expectedVersion, notBefore, paymentIntentId, reservationId, chargeId, offlineChargeId, capturedMinor, from, to, guests, attemptId, sessionId,
    refundIdempotencyKey: `ref:${intentId}:1`,                                                           // = the accepted refundKey(intentId, 1); cross-checked against tooling + the row
    recordingIdempotencyKey: `och:${intentId}:1`,                                                        // = the accepted initial recording key; cross-checked against the row
    mirrorIdempotencyKey: `ochr:${intentId}:1`,                                                          // = the accepted single mirror key; cross-checked against the row
    recordingTitle: offlineChargeTitle(intentId), mirrorTitle: mirrorTitle(intentId), amount: exactAmount(capturedMinor),
    approvalRef, budgets: { ...c.budgets },
    operations: ["db.request_recorded_test_cleanup<=1", "db.cleanup_worker_steps+mirror_worker_steps<=24", "hostaway.get_reservation(reservationId)", "hostaway.lookup_by_ref(606998,arrival)",
      "hostaway.list_offline_charges(reservationId,500)", "hostaway.cancel_reservation(reservationId,host)<=1", "hostaway.refund_offline_charge(reservationId,offlineChargeId,title,amount,0)<=1",
      "stripe.accounts.retrieve", "stripe.paymentIntents.retrieve(pi)", "stripe.refunds.create(pi,capturedMinor,key)<=1", "stripe.refunds.retrieve(re)", "stripe.refunds.list(pi,100)"],
    writes: { requestMax: 1, cancelMax: 1, refundMax: 1, mirrorMax: 1, capture: 0, hostawayCreate: 0, record: 0, notify: 0, void: 0, account: 0, keys: 0 } };
  return freeze({ plan: deepFreeze(plan), planHash: sha(canonical(plan)) });
}
/** the accepted 18-key operator expectation (test-cleanup-recorded.js TEST_CLEANUP_RECORDED_EXPECTATION_KEYS), DERIVED from the plan (+ its hash); never read from the database */
export function operatorExpectation(plan, planHash) {
  return freeze({ approvalRef: plan.approvalRef, attemptId: plan.attemptId, authorizedMinor: plan.capturedMinor, capturedMinor: plan.capturedMinor, currency: plan.currency,
    expectedVersion: plan.expectedVersion, finalTotalMinor: plan.capturedMinor, from: plan.from, guests: plan.guests, intentId: plan.intentId, listingId: plan.listingId,
    offlineChargeId: plan.offlineChargeId, paymentIntentId: plan.paymentIntentId, planHash, reservationId: plan.reservationId, sessionId: plan.sessionId, stripeChargeId: plan.chargeId, to: plan.to });
}

// =================================================================================================================================
// DB reads (read-only SELECTs through the runtime login; no transaction held across a provider call)
const Q = freeze({
  instance: "/*e7hrt:instance*/ SELECT environment FROM booking.instance",
  attempts: "/*e7hrt:attempts*/ SELECT id::text AS id, status, checkout_session_id, payment_intent_id, livemode FROM booking.payment_attempts WHERE intent_id = $1 ORDER BY attempt",
  hostaway: "/*e7hrt:hostaway*/ SELECT state, hostaway_reservation_id::text AS rid FROM booking.hostaway_reservation_attempts WHERE intent_id = $1",
  ops: `/*e7hrt:ops*/ SELECT id::text AS id, op_type, state, attempts, idempotency_key, (dispatched_at IS NOT NULL) AS dispatched, (lease_worker_id IS NOT NULL OR lease_until IS NOT NULL) AS leased,
      late_result_status, result_ref, (settled_evidence_id IS NOT NULL) AS settled_evidence, payload ->> 'reservationId' AS payload_rid, payload ->> 'paymentIntentId' AS payload_pi,
      payload ->> 'chargeId' AS payload_charge, payload ->> 'offlineChargeId' AS payload_och, payload ->> 'currency' AS payload_currency, (payload ->> 'attempt')::int AS payload_attempt,
      (payload ->> 'amountMinor')::int AS payload_amount, payload ->> 'providerIdempotencyKey' AS payload_key,
      (SELECT count(*)::int FROM jsonb_object_keys(CASE WHEN jsonb_typeof(payload) = 'object' THEN payload ELSE '{}'::jsonb END)) AS payload_keys
      FROM booking.external_operations WHERE intent_id = $1 ORDER BY created_at, id`,
  holds: `/*e7hrt:holds*/ SELECT count(*)::int AS n FROM booking.recording_holds h JOIN booking.external_operations o ON o.id = h.operation_id WHERE o.intent_id = $1 AND h.released_at IS NULL`,
  cases: "/*e7hrt:cases*/ SELECT count(*)::int AS n FROM booking.reconciliation_cases WHERE intent_id = $1 AND status = 'open'",
  claims: "/*e7hrt:claims*/ SELECT listing_id, (released_at IS NOT NULL) AS released FROM booking.inventory_claims WHERE intent_id = $1",
  work: "/*e7hrt:work*/ SELECT (work_worker_id IS NOT NULL OR work_lease_until IS NOT NULL) AS leased FROM booking.intent_work WHERE intent_id = $1",
  refunds: "/*e7hrt:refunds*/ SELECT seq, idempotency_key, state, hostaway_state, amount_minor::text AS amt, currency, stripe_refund_id FROM booking.payment_refunds WHERE intent_id = $1 ORDER BY seq",
  ledger: "/*e7hrt:ledger*/ SELECT entry, amount_minor::text AS amt, currency, provider_ref FROM booking.payment_ledger WHERE intent_id = $1 ORDER BY id",
  evidence: "/*e7hrt:evidence*/ SELECT kind, external_ref, status FROM booking.provider_evidence WHERE intent_id = $1",
  // the ONE guest.notify row's audit side: renders / latches (0016, read-only) and suppressions (0021, read-only)
  notify: `/*e7hrt:notify*/ SELECT (SELECT count(*)::int FROM booking.notification_renders r JOIN booking.external_operations o ON o.id = r.operation_id WHERE o.intent_id = $1) AS renders,
      (SELECT count(*)::int FROM booking.notification_latches l JOIN booking.external_operations o ON o.id = l.operation_id WHERE o.intent_id = $1) AS latches,
      (SELECT count(*)::int FROM booking.notification_suppressions s WHERE s.intent_id = $1) AS suppressions`,
  settlement: `/*e7hrt:settlement*/ SELECT environment, reason_code, settlement_reservation_cancelled AS cancelled, settlement_authorization_settled AS settled, settlement_recording_mirrored AS mirrored,
      offline_charge_id::text AS och, captured_minor::text AS cap FROM booking.intents WHERE id = $1`,
  // READ-ONLY schema prerequisite: the reviewed 0019 + 0020 + 0021 objects (never applied here; their absence refuses before any write)
  schema: `/*e7hrt:schema*/ SELECT to_regprocedure('booking.settle_test_refund_from_evidence(uuid,uuid)') IS NOT NULL AS f0020,
      to_regproc('booking.test_refund_settled_for') IS NOT NULL AS settled_for, to_regproc('booking.test_refund_pi_observation_ok') IS NOT NULL AS pi_ok,
      to_regproc('booking.test_refund_ledgered') IS NOT NULL AS ledgered, to_regproc('booking.test_cleanup_cancel_bound') IS NOT NULL AS cancel_bound,
      to_regproc('booking.refund_claim_fence') IS NOT NULL AS refund_fence, to_regproc('booking.recording_retirement_fence') IS NOT NULL AS retirement_fence,
      booking.is_intent_state('test_cleanup_pending') AS pending_state,
      to_regprocedure('booking.offline_refund_proof_refusal(uuid,jsonb,text,timestamptz,uuid,text,timestamptz)') IS NOT NULL AS f0021_proof,
      to_regprocedure('booking.recorded_cleanup_legs_unsettled(uuid,boolean)') IS NOT NULL AS f0021_legs,
      to_regprocedure('booking.complete_offline_refund_with_evidence(uuid,text,uuid,text,integer)') IS NOT NULL AS f0021_complete,
      to_regprocedure('booking.offline_refund_settled_for(uuid)') IS NOT NULL AS f0021_settled_for,
      to_regprocedure('booking.suppress_guest_notification(uuid,text)') IS NOT NULL AS f0021_suppress,
      to_regprocedure('booking.recorded_state_cleanup_ok(uuid)') IS NOT NULL AS f0021_end_ok,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'booking' AND table_name = 'intents' AND column_name = 'settlement_recording_mirrored') AS mirrored_column,
      to_regclass('booking.notification_suppressions') IS NOT NULL AS suppressions_table`,
  endOk: "/*e7hrt:endok*/ SELECT booking.recorded_state_cleanup_ok($1) AS ok",         // the accepted 0021 end predicate (READ-ONLY; only queried once the schema prerequisite is proven)
  role: `/*e7hrt:role*/ SELECT pg_has_role(current_user, 'mv_booking_app', 'MEMBER') AS is_app, (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) AS privileged`,
  identity: "/*e7hrt:identity*/ SELECT current_database() AS db, (SELECT environment FROM booking.instance) AS environment"
});
export const QUERIES = Q;
const CAPTURE = "stripe.capture_payment_intent"; const RECORD = "hostaway.record_offline_charge"; const CREATE = "hostaway.create_reservation";
const CANCEL = "hostaway.cancel_reservation"; const REFUND = "stripe.refund_payment_intent"; const MIRROR = "hostaway.refund_offline_charge"; const NOTIFY = "guest.notify";
const LIST_READ = "hostaway.list_offline_charges";
const READS = freeze(["stripe.retrieve_checkout_session", "stripe.retrieve_payment_intent", "hostaway.lookup_reservation", "hostaway.retrieve_reservation", "stripe.retrieve_refund", LIST_READ]);
const BEFORE_OPS = freeze(["stripe.create_checkout_session", CREATE, CAPTURE, RECORD, NOTIFY, ...READS]);
const LINEAGE_OPS = freeze([...BEFORE_OPS, CANCEL, REFUND]);                                      // the mirror row is queued by the reducer ONLY once both legs are proven
const AFTER_OPS = freeze([...LINEAGE_OPS, MIRROR]);
const FORBIDDEN_OPS = freeze(["stripe.void_payment_intent", "alert.owner", "stripe.refund", "stripe.create_refund"]);
const pristine = (o) => o && o.state === "pending" && o.attempts === 0 && o.dispatched === false && o.leased === false && o.late_result_status === null;
const suppressed = (o) => o && o.state === "superseded" && o.attempts === 0 && o.dispatched === false && o.leased === false && o.result_ref === null;
const SCHEMA_FLAGS = freeze(["f0020", "settled_for", "pi_ok", "ledgered", "cancel_bound", "refund_fence", "retirement_fence", "pending_state",
  "f0021_proof", "f0021_legs", "f0021_complete", "f0021_settled_for", "f0021_suppress", "f0021_end_ok", "mirrored_column", "suppressions_table"]);
const schemaOk = (s) => !!s && SCHEMA_FLAGS.every((k) => s[k] === true);

async function readFacts(q, plan, tooling, raw, { withEnd = false } = {}) {
  const inst = await q(Q.instance, []);
  const intent = await tooling.loadIntent(raw, plan.intentId);                                       // accepted repo read over the counted pool
  const attempts = await q(Q.attempts, [plan.intentId]);
  const hostaway = await q(Q.hostaway, [plan.intentId]);
  const ops = await q(Q.ops, [plan.intentId]);
  const holds = await q(Q.holds, [plan.intentId]);
  const cases = await q(Q.cases, [plan.intentId]);
  const claims = await q(Q.claims, [plan.intentId]);
  const work = await q(Q.work, [plan.intentId]);
  const refunds = await q(Q.refunds, [plan.intentId]);
  const ledger = await q(Q.ledger, [plan.intentId]);
  const evidence = await q(Q.evidence, [plan.intentId]);
  const notify = await q(Q.notify, [plan.intentId]);
  const settlement = await q(Q.settlement, [plan.intentId]);
  const schema = await q(Q.schema, []);
  const endOk = withEnd && schemaOk(schema[0]) ? (await q(Q.endOk, [plan.intentId]))[0]?.ok ?? null : null;
  return freeze({ instance: inst[0]?.environment ?? null, intent, attempts, hostaway, ops, openHolds: holds[0]?.n ?? null, openCases: cases[0]?.n ?? null, claims, workLeased: work.length === 1 ? work[0].leased : null,
    refunds, ledger, evidence, notify: notify[0] ?? null, row: settlement[0] ?? null, schema: schema[0] ?? null, endOk });
}
/** the facts every exit shares (scope, protection, binding to the PINNED pi / reservation / Stripe charge / original offline charge / amount / stay / attempt / session) → null | code */
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
  if (String(i.offlineChargeId ?? "") !== plan.offlineChargeId || String(f.row.och ?? "") !== plan.offlineChargeId) return "OFFLINE_CHARGE_NOT_PINNED";
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
  // the ONE recording: SUCCEEDED + LINKED to the pinned original (the proven book entry the mirror reverses; NEVER retired in this phase)
  const recs = f.ops.filter((o) => o.op_type === RECORD);
  if (recs.length !== 1 || recs[0].idempotency_key !== plan.recordingIdempotencyKey || recs[0].payload_rid !== plan.reservationId || recs[0].payload_amount !== plan.capturedMinor || recs[0].payload_keys !== 2) return "RECORDING_ROW_NOT_BOUND";
  if (recs[0].state !== "succeeded" || recs[0].attempts !== 1 || recs[0].dispatched !== true || recs[0].leased !== false || recs[0].late_result_status !== null || recs[0].settled_evidence !== true
      || String(recs[0].result_ref ?? "") !== plan.offlineChargeId) return "RECORDING_NOT_PROVEN_LINKED";
  if (f.openHolds !== 0) return "RECORDING_HOLD_PRESENT";
  if (f.claims.length !== 1 || f.claims[0].listing_id !== c.listingId) return "CLAIM_NOT_SCOPED";
  if (f.openCases !== 0) return "OPEN_CASE";
  const capLed = f.ledger.filter((l) => l.entry === "capture_succeeded");
  if (capLed.length !== 1 || capLed[0].amt !== String(plan.capturedMinor) || capLed[0].currency !== c.currency || capLed[0].provider_ref !== plan.paymentIntentId) return "LEDGER_MISMATCH";
  const recLed = f.ledger.filter((l) => l.entry === "offline_charge_recorded");
  if (recLed.length !== 1 || recLed[0].amt !== String(plan.capturedMinor) || recLed[0].currency !== c.currency) return "RECORDING_NOT_LEDGERED";
  if (f.ledger.some((l) => ["refund_failed", "authorization_voided"].includes(l.entry))) return "LEDGER_MISMATCH";
  for (const x of f.evidence) {
    if (x.kind === "payment_intent" && x.external_ref !== plan.paymentIntentId) return "EVIDENCE_CONFLICT";
    if (x.kind === "hostaway_reservation" && x.external_ref !== plan.reservationId && !(x.status === "not_found" && x.external_ref === i.ref)) return "EVIDENCE_CONFLICT";
    if (x.kind === "hostaway_offline_charges" && x.external_ref !== plan.reservationId) return "EVIDENCE_CONFLICT";
  }
  if (!f.evidence.some((x) => x.kind === "hostaway_offline_charges" && x.status === "listed" && x.external_ref === plan.reservationId)) return "RECORDING_EVIDENCE_MISSING";
  const notes = f.ops.filter((o) => o.op_type === NOTIFY);
  if (notes.length !== 1) return "NOTIFY_NOT_SINGLE";
  if (!f.notify || f.notify.renders !== 0 || f.notify.latches !== 0) return "NOTIFY_NOT_PRISTINE";                 // never rendered / latched by anything
  return null;
}
/** checkStart(f, plan, c, tooling?) → { ok, intent, attemptId } | { ok:false, code } — read-only admission (the accepted request's in-tx guards stay authoritative) */
export function checkStart(f, plan, c = CONSTANTS, tooling = null) {
  const no = (code) => freeze({ ok: false, code });
  const common = checkCommon(f, plan, c);
  if (common) return no(common);
  const i = f.intent;
  if (i.status !== "confirmed") return no("STATE_NOT_CONFIRMED");
  if (i.version !== plan.expectedVersion) return no("VERSION_NOT_PINNED");
  if (i.reasonCode || f.row.reason_code) return no("REASON_CODE_PRESENT");
  if (i.lease) return no("RESERVATION_LEASE_HELD");
  if (f.workLeased !== false) return no("WORK_LEASE_HELD");
  const k = i.counters || {};
  if (k.captureAttempts !== 1 || (k.voidAttempts ?? 0) !== 0 || (k.cancelAttempts ?? 0) !== 0 || (k.offlineChargeAttempts ?? 0) !== 0) return no("HISTORY_NOT_RECORDED");   // = the accepted request: offlineChargeAttempts counts FAILED recording attempts only (a booking recorded on its single attempt has 0)
  for (const o of f.ops) if (!BEFORE_OPS.includes(o.op_type)) return no("UNEXPECTED_OP");
  for (const o of f.ops) if (READS.includes(o.op_type) && ["in_flight", "outcome_unknown"].includes(o.state)) return no("READ_HISTORY_UNSETTLED");
  const notes = f.ops.filter((o) => o.op_type === NOTIFY);
  if (!pristine(notes[0]) || notes[0].result_ref !== null || f.notify.suppressions !== 0) return no("NOTIFY_NOT_PRISTINE");
  if (f.refunds.length !== 0) return no("REFUND_PRESENT");
  if (f.ledger.some((l) => ["refund_succeeded", "offline_charge_refund_recorded"].includes(l.entry))) return no("LEDGER_MISMATCH");
  if (f.evidence.some((x) => x.kind === "stripe_refund" || (x.kind === "hostaway_reservation" && x.status === "cancelled"))) return no("EVIDENCE_CONFLICT");
  if (f.claims[0].released !== false) return no("CLAIM_NOT_HELD");
  if (f.row.cancelled === true || f.row.settled === true || f.row.mirrored === true) return no("SETTLEMENT_PRESENT");
  if (tooling && typeof tooling.refundKey === "function" && tooling.refundKey(i.id, 1) !== plan.refundIdempotencyKey) return no("REFUND_KEY_NOT_ACCEPTED");
  if (tooling && typeof tooling.mirrorTitle === "function" && tooling.mirrorTitle(i.id) !== plan.mirrorTitle) return no("MIRROR_TITLE_NOT_ACCEPTED");
  if (!schemaOk(f.schema)) return no("SCHEMA_PREREQUISITE_MISSING");
  return freeze({ ok: true, intent: i, attemptId: f.attempts[0].id });
}
/** checkLineage(f, plan, c) → { ok, refundOpId } | { ok:false, code } — the EXACT persisted lineage ONE accepted recorded request leaves (nothing else is admitted to the workers) */
export function checkLineage(f, plan, c = CONSTANTS) {
  const no = (code) => freeze({ ok: false, code });
  const common = checkCommon(f, plan, c);
  if (common) return no(common);
  const i = f.intent;
  if (i.status !== "test_cleanup_pending") return no("STATE_NOT_TEST_CLEANUP_PENDING");
  if (i.version !== plan.expectedVersion + 1) return no("VERSION_NOT_NEXT");
  if (i.reasonCode !== TEST_CLEANUP_REASON || f.row.reason_code !== TEST_CLEANUP_REASON) return no("REASON_NOT_TEST_CLEANUP");
  if (f.row.cancelled !== false || f.row.settled !== false || f.row.mirrored !== false) return no("SETTLEMENT_NOT_OPEN");
  if (i.lease || f.workLeased !== false) return no("LEASE_HELD");
  for (const o of f.ops) if (!LINEAGE_OPS.includes(o.op_type)) return no(o.op_type === MIRROR ? "MIRROR_ROW_PREMATURE" : "UNEXPECTED_OP");
  const notes = f.ops.filter((o) => o.op_type === NOTIFY);
  if (!suppressed(notes[0]) || f.notify.suppressions !== 1) return no("NOTIFY_NOT_SUPPRESSED");
  const cancels = f.ops.filter((o) => o.op_type === CANCEL);
  if (cancels.length !== 1 || !pristine(cancels[0]) || cancels[0].payload_rid !== plan.reservationId) return no("CANCEL_ROW_NOT_PRISTINE");
  const refunds = f.ops.filter((o) => o.op_type === REFUND);
  if (refunds.length !== 1 || !pristine(refunds[0])) return no("REFUND_ROW_NOT_PRISTINE");
  const rf = refunds[0];
  if (rf.payload_pi !== plan.paymentIntentId || rf.payload_charge !== plan.chargeId || rf.payload_amount !== plan.capturedMinor || rf.payload_currency !== c.currency || rf.payload_attempt !== 1
      || rf.payload_key !== plan.refundIdempotencyKey || !UUID_RE.test(String(rf.id))) return no("REFUND_ROW_NOT_BOUND");
  if (f.refunds.length !== 1 || f.refunds[0].seq !== 1 || f.refunds[0].idempotency_key !== plan.refundIdempotencyKey || f.refunds[0].state !== "requested" || f.refunds[0].hostaway_state !== "not_applicable"
      || f.refunds[0].amt !== String(plan.capturedMinor) || f.refunds[0].currency !== c.currency || f.refunds[0].stripe_refund_id !== null) return no("REFUND_RECORD_NOT_REQUESTED");
  if (f.ledger.some((l) => ["refund_succeeded", "offline_charge_refund_recorded"].includes(l.entry))) return no("LEDGER_MISMATCH");
  if (f.claims[0].released !== false) return no("CLAIM_NOT_HELD");
  return freeze({ ok: true, refundOpId: String(rf.id) });
}
/** the ONE mirror row as the DB must show it once both legs are proven (pristine before the mirror worker; succeeded + linked at the end) → null | code */
function mirrorRowRefusal(o, plan, c, { done }) {
  if (!o || o.idempotency_key !== plan.mirrorIdempotencyKey || o.payload_keys !== 4 || o.payload_rid !== plan.reservationId || o.payload_och !== plan.offlineChargeId
      || o.payload_amount !== plan.capturedMinor || o.payload_currency !== c.currency) return "MIRROR_ROW_NOT_BOUND";
  if (!done) return pristine(o) && o.result_ref === null && o.settled_evidence === false ? null : "MIRROR_ROW_NOT_PRISTINE";
  if (o.state !== "succeeded" || o.attempts !== 1 || o.dispatched !== true || o.leased !== false || o.late_result_status !== null || o.settled_evidence !== true) return "MIRROR_OP_NOT_SINGLE_SUCCEEDED";
  const ref = String(o.result_ref ?? "");
  if (!OCH_RE.test(ref) || ref === plan.offlineChargeId || ref === plan.reservationId) return "MIRROR_RESULT_NOT_CANONICAL";
  return null;
}
/** checkEnd(f, plan, c, tooling?) → null | code — the persisted facts a completed recorded cleanup must show (anything else = POSTCHECK_MISMATCH / RESIDUAL_*) */
export function checkEnd(f, plan, c = CONSTANTS, tooling = null) {
  const common = checkCommon(f, plan, c);
  if (common) return common;
  const i = f.intent;
  if (i.status !== "cancelled") return "STATE_NOT_CANCELLED";
  if (i.reasonCode !== TEST_CLEANUP_REASON || f.row.reason_code !== TEST_CLEANUP_REASON) return "REASON_NOT_TEST_CLEANUP";
  if (tooling && typeof tooling.publicStatus === "function" && tooling.publicStatus(i) !== "not_completed_refunded") return "PUBLIC_STATUS_NOT_REFUNDED";
  if (f.row.cancelled !== true || f.row.settled !== true || f.row.mirrored !== true) return "LEGS_NOT_SETTLED";
  for (const o of f.ops) if (!AFTER_OPS.includes(o.op_type)) return "UNEXPECTED_OP";
  const notes = f.ops.filter((o) => o.op_type === NOTIFY);
  if (!suppressed(notes[0]) || f.notify.suppressions !== 1) return "NOTIFY_NOT_SUPPRESSED";                        // suppressed ONCE by the accepted request, never dispatched by anything
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
  const mirrors = f.ops.filter((o) => o.op_type === MIRROR);
  if (mirrors.length !== 1) return "MIRROR_OP_NOT_SINGLE_SUCCEEDED";
  const mr = mirrorRowRefusal(mirrors[0], plan, c, { done: true });
  if (mr) return mr;
  const mid = String(mirrors[0].result_ref);
  const ml = f.ledger.filter((l) => l.entry === "offline_charge_refund_recorded");
  if (ml.length !== 1 || ml[0].amt !== String(plan.capturedMinor) || ml[0].currency !== c.currency || String(ml[0].provider_ref ?? "") !== mid) return "MIRROR_NOT_LEDGERED";
  if (f.evidence.filter((x) => x.kind === "hostaway_offline_charges" && x.status === "listed" && x.external_ref === plan.reservationId).length < 2) return "MIRROR_EVIDENCE_MISSING";   // the recording's + the mirror's confirming LIST
  if (f.claims[0].released !== true) return "CLAIM_NOT_RELEASED";
  if (f.endOk !== true) return "END_PREDICATE_NOT_PROVEN";                                                    // the accepted 0021 booking.recorded_state_cleanup_ok
  return null;
}

// =================================================================================================================================
/**
 * runRecordedCleanupCore({ plan, planHash, runId, pool, lockClientFactory, tooling, exchanges, credentials, clock, monotonic, sleep, runSignal }) → frozen result.
 *  tooling = { runTestCleanupStep, runMirrorStep, requestRecordedTestCleanup, loadIntent, createTestCleanupExecutors, buildHostawayMirrorExecutors, createStripeSend
 *              (= createE7StripeTestCleanupSend), createHostawaySend, validateAdapterConfig, unwrapEnvelope, normalizeReservation, activeReservationProof,
 *              paymentIntentProofObservationV3, piIdentityOk, rawPiPreSendRefusal, refundObservation, arrivalStrictlyFuture, refundKey, publicStatus, mirrorTitle,
 *              classifyTitle, classifyMirrorTitle, providerIdToCanonical, amountToMinor, LOCK_KEY, LOCK_PRECHECK_SQL }
 *  lockClientFactory() → a dedicated checked-out client (query / release / on) for the session lock (pool.connect by default).
 */
export const TOOLING_KEYS = freeze(["runTestCleanupStep", "runMirrorStep", "requestRecordedTestCleanup", "loadIntent", "createTestCleanupExecutors", "buildHostawayMirrorExecutors", "createStripeSend",
  "createHostawaySend", "validateAdapterConfig", "unwrapEnvelope", "normalizeReservation", "activeReservationProof", "paymentIntentProofObservationV3", "piIdentityOk", "rawPiPreSendRefusal",
  "refundObservation", "arrivalStrictlyFuture", "refundKey", "publicStatus", "mirrorTitle", "classifyTitle", "classifyMirrorTitle", "providerIdToCanonical", "amountToMinor"]);
const RES_READ_OP = "hostaway.retrieve_reservation";                                              // = the accepted OPS.RES_READ read op type (asserted by the tests)
const MIRROR_EXECUTOR_KEYS = freeze(["retrieveAccount", "retrievePaymentIntent", "retrieveReservation", "listOfflineCharges", "refundOfflineCharge"]);   // = the accepted MIRROR_EXECUTOR_KEYS (asserted)

// F1 (Slice 3 rev2) — runner-local, STATE-INDEPENDENT PaymentIntent proof adapter: LABELLED MIRROR of the accepted test-cleanup-proof.js capturedChargeRefusal
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
// the runner-read reservation observation (LABELLED COPY of the accepted reservation-worker observedReservation, NOT persisted as evidence) — Slice 3 F2
const observedReservation = (r) => ({ reservationId: String(r.reservationId), listingId: r.listingId, from: r.from, to: r.to, totalMinor: r.totalMinor, currency: r.currency, status: r.status,
  ...(r.bookingRef ? { bookingRef: r.bookingRef } : {}) });
const runnerResEvidence = (id, readOpType, requestRef, r, observedAt, extra = {}) => freeze({ id, kind: "hostaway_reservation", readOpType, requestRef, externalRef: String(r.reservationId),
  status: r.status === "cancelled" ? "cancelled" : "found_active", observed: { ...extra, ...observedReservation(r) }, observedAt });
/** the FULL cancelled-reservation identity at the final readback (LABELLED MIRROR of the accepted mirrorReservationEvidenceRefusal field set over the runner-read normalized reservation) → null | code */
export function cancelledReservationReadbackRefusal(nr, { plan, ref, c }) {
  if (!nr || nr.ok !== true || !nr.reservation) return "RESERVATION_MALFORMED";
  const r = nr.reservation;
  if (String(r.reservationId) !== plan.reservationId) return "RESERVATION_ID";
  if (String(r.status || "").toLowerCase() !== "cancelled") return "RESERVATION_NOT_CANCELLED_AT_PROVIDER";
  if (r.listingId !== c.listingId) return "RESERVATION_LISTING";
  if (r.channelId !== 2000) return "RESERVATION_CHANNEL_NOT_DIRECT";
  if (r.from !== plan.from || r.to !== plan.to) return "RESERVATION_STAY";
  if (r.totalMinor !== plan.capturedMinor) return "RESERVATION_TOTAL";
  if (String(r.currency || "").toUpperCase() !== c.currency) return "RESERVATION_CURRENCY";
  if (r.bookingRef !== ref) return "RESERVATION_REF";
  return null;
}
/**
 * Complete charge-LIST assessment at BOTH runner boundaries (before the request: the intent is `confirmed`; after the mirror: `cancelled`). The accepted mirror
 * pure module (assessMirrorList / mirrorDiscovery / mirrorConfirmingObservation) judges a test_cleanup_pending intent with both legs proven, so — WITHOUT
 * fabricating intent state (Slice 4 F1 precedent) — this is a LABELLED COPY of its complete-list / row / original / discovery / confirming rules composed from
 * the ACCEPTED primitives: unwrapEnvelope, providerIdToCanonical, amountToMinor, classifyTitle (recording marker) and classifyMirrorTitle (mirror marker).
 *   phase "before": the original present and unchanged (type charge / paid / offline / the pinned method / exact amount / currency / exact recording title,
 *                   the ONLY exact-marked row, zero recording lookalikes); ZERO refund rows typed-linked to it; ZERO refund rows without a typed link (HOLD:
 *                   absence cannot be proven); ZERO mirror-marked rows (exact or lookalike); ZERO refund rows of the recorded amount.
 *   phase "after":  the original unchanged + EXACTLY ONE refund row typed-linked to it (refundInfo.refundedChargeId = original) which IS `mirrorRefundId`,
 *                   its refundInfo.chargeId = its own id, type refund / status succeeded / paymentProvider offline / amount = −recorded exact / currency /
 *                   the ONLY mirror-marked row with the EXACT mirror title; no untyped link anywhere.
 * → null | code
 */
export function chargeListRefusal(lr, { tooling, intentId, reservationId, listingId, offlineChargeId, amountMinor, currency, paymentMethod, recordingTitle, mirrorTitle: mTitle, phase, mirrorRefundId = null }) {
  if (!lr || lr.httpStatus !== 200) return "LIST_HTTP_STATUS";
  const env = tooling.unwrapEnvelope(lr.json);
  if (!env || env.ok !== true) return "LIST_ENVELOPE";
  const rows = env.result;
  if (!Array.isArray(rows)) return "LIST_RESULT_NOT_ARRAY";
  const count = lr.json.count;
  if (!Number.isSafeInteger(count) || count < 0 || count > LIST_LIMIT) return "LIST_COUNT_INVALID";
  if (rows.length !== count) return "LIST_COUNT_LENGTH_MISMATCH";
  const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  const seen = new Set(); const typed = [];
  for (let i = 0; i < rows.length; i++) {
    if (!Object.prototype.hasOwnProperty.call(rows, i) || !isObj(rows[i])) return "LIST_ROW_MALFORMED";
    const row = rows[i];
    const id = tooling.providerIdToCanonical(row.id);
    if (id === null) return "LIST_ROW_ID_INVALID";
    if (seen.has(id)) return "LIST_DUPLICATE_ID";
    seen.add(id);
    if (tooling.providerIdToCanonical(row.reservationId) !== reservationId) return "LIST_FOREIGN_RESERVATION_ROW";
    if (row.listingMapId !== listingId) return "LIST_FOREIGN_LISTING_ROW";
    for (const k of ["type", "title", "currency", "status", "paymentProvider", "paymentMethod"]) if (typeof row[k] !== "string") return `LIST_ROW_${k.toUpperCase()}_INVALID`;
    if (!["charge", "preAuth", "refund"].includes(row.type)) return "LIST_ROW_TYPE_UNKNOWN";
    if (typeof row.amount !== "number" || !Number.isFinite(row.amount)) return "LIST_ROW_AMOUNT_INVALID";
    let amountMinorRow;
    if (row.type === "refund") { if (!(row.amount <= 0)) return "LIST_ROW_AMOUNT_NOT_EXACT"; const m = tooling.amountToMinor(-row.amount); if (m === null) return "LIST_ROW_AMOUNT_NOT_EXACT"; amountMinorRow = -m; }
    else { const m = tooling.amountToMinor(row.amount); if (m === null) return "LIST_ROW_AMOUNT_NOT_EXACT"; amountMinorRow = m; }
    let link = null;
    if (row.type === "refund") {
      const ri = row.refundInfo;
      if (isObj(ri)) {
        const a = tooling.providerIdToCanonical(ri.id); const b = tooling.providerIdToCanonical(ri.chargeId); const d = tooling.providerIdToCanonical(ri.refundedChargeId);
        link = a !== null && b !== null && d !== null ? { id: a, chargeId: b, refundedChargeId: d } : null;
      }
    } else if (row.refundInfo !== undefined && row.refundInfo !== null && !isObj(row.refundInfo)) return "LIST_ROW_REFUND_INFO_INVALID";
    typed.push({ id, type: row.type, title: row.title, status: row.status, paymentProvider: row.paymentProvider, paymentMethod: row.paymentMethod, currency: row.currency, amountMinor: amountMinorRow, link,
      recordingMark: tooling.classifyTitle(row.title, intentId), mirrorMark: tooling.classifyMirrorTitle(row.title, intentId) });
  }
  // the original: exactly ONE exact recording-marked row, it is the pinned id, unchanged; zero recording lookalikes
  if (typed.some((r) => r.recordingMark === "suspicious")) return "LOOKALIKE_CHARGE_PRESENT";
  const exact = typed.filter((r) => r.recordingMark === "exact");
  if (exact.length !== 1) return exact.length === 0 ? "ORIGINAL_MISSING" : "ORIGINAL_DUPLICATE";
  const o = exact[0];
  if (o.id !== offlineChargeId) return "ORIGINAL_ID_MISMATCH";
  if (o.type !== "charge" || o.status !== "paid" || o.paymentProvider !== "offline" || o.paymentMethod !== paymentMethod || o.currency !== currency || o.title !== recordingTitle || o.amountMinor !== amountMinor) return "ORIGINAL_CHANGED";
  const refunds = typed.filter((r) => r.type === "refund");
  if (refunds.some((r) => r.link === null)) return phase === "before" ? "MIRROR_DISCOVERY_AMBIGUOUS" : "LINK_UNTYPED";
  const linked = refunds.filter((r) => r.link.refundedChargeId === offlineChargeId || r.link.chargeId === offlineChargeId || r.link.id === offlineChargeId);
  const marked = typed.filter((r) => r.mirrorMark !== "none");
  if (phase === "before") {
    if (linked.length !== 0) return "MIRROR_ALREADY_LINKED";
    if (marked.length !== 0) return "MIRROR_MARKER_PRESENT";
    if (refunds.some((r) => r.amountMinor === -amountMinor)) return "MIRROR_AMOUNT_PRESENT";
    return null;
  }
  if (phase !== "after" || !OCH_RE.test(String(mirrorRefundId))) return "PHASE_INVALID";
  const byRefunded = refunds.filter((r) => r.link.refundedChargeId === offlineChargeId);
  if (byRefunded.length !== 1) return byRefunded.length === 0 ? "LINKED_ROW_MISSING" : "LINKED_ROW_DUPLICATE";
  const m = byRefunded[0];
  if (m.id !== mirrorRefundId) return "LINKED_ROW_NOT_THE_RESULT";
  if (m.link.chargeId !== m.id) return "LINK_CHARGE_ID_NOT_ROW";
  if (linked.length !== 1) return "LINKED_ROW_DUPLICATE";
  if (marked.length !== 1 || marked[0].id !== m.id || m.mirrorMark !== "exact" || m.title !== mTitle) return "MIRROR_TITLE_NOT_UNIQUE_EXACT";
  if (m.status !== "succeeded") return "MIRROR_ROW_STATUS";
  if (m.paymentProvider !== "offline") return "MIRROR_ROW_PROVIDER";
  if (m.amountMinor !== -amountMinor) return "MIRROR_ROW_AMOUNT";
  if (m.currency !== currency) return "MIRROR_ROW_CURRENCY";
  return null;
}

export async function runRecordedCleanupCore(input) {
  const c = CONSTANTS; const B = c.budgets;
  const r = { schema: RESULT_SCHEMA, outcome: null, code: null, startState: null, finalState: null, finalVersion: null, publicStatus: null, reservationId: null, capturedMinor: null, chargeId: null, offlineChargeId: null,
    refundId: null, mirrorRefundId: null, clientSnapshotId: null, requestInvocations: 0, requestOutcome: "NONE", steps: 0, cleanupSteps: 0, mirrorSteps: 0, actions: [], exchanges: 0, hostawayReads: 0, lookupPages: 0,
    chargeLists: 0, accountReads: 0, piReads: 0, refundReads: 0, refundLists: 0, dbQueries: 0, dbTeardownQueries: 0, dbBudgetRefused: 0, cancelInvocations: 0, cancelOutcome: "NONE", refundInvocations: 0,
    refundOutcome: "NONE", mirrorInvocations: 0, mirrorOutcome: "NONE", mirrorTransportPosts: null, refusedAtTransport: 0, refusedByStop: 0, lock: "not_acquired", lockSession: null, lockBackendPid: null,
    proofs: [], postcheck: null, cancelOps: null, refundOps: null, mirrorOps: null, refundRecord: null, recordingLinked: null, notifySuppressed: null, claimHeld: null, legs: null, endOk: null,
    factsObserved: false, stopReason: null, workerStop: null, writes: { request: 0, cancel: 0, refund: 0, mirror: 0, capture: 0, create: 0, record: 0, notify: 0, void: 0 } };
  const DONE = Symbol("done");
  const done = (outcome, code = null) => { r.outcome = outcome; r.code = code; return DONE; };
  const snapshot = () => freeze(JSON.parse(JSON.stringify(r)));
  let stopReason = null; let runSignalRef = null; let monoRef = null; let endsAtRef = Infinity;
  let lockClient = null; let lockAcquired = false; let lockErrored = false; let lockPid = null; let deadlineTimer = null;
  // the runner-OWNED stop signal (Slice 3 F3 / Slice 4): passed to BOTH accepted workers as THEIR `signal`, part of EVERY composed transport signal; aborted
  // synchronously by the lock-session error listener, the run abort and the wall deadline (both workers admit it at every awaited boundary)
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
  /** a possibly-sent write (or request) without an admissible reply dominates every later exit (never hidden behind a stop code) */
  const uncertain = () => (r.requestOutcome === "UNKNOWN" ? "REQUEST_OUTCOME_UNKNOWN" : r.cancelOutcome === "UNKNOWN" || r.refundOutcome === "UNKNOWN" || r.mirrorOutcome === "UNKNOWN" ? "WRITE_OUTCOME_UNKNOWN" : null);
  const stopOutcome = () => done(uncertain() ?? (stopReason === "LOCK_SESSION_ERROR" ? "LOCK_LOST" : stopReason), `STOP_${stopReason}`);
  /** a failed runner DB read: a latched stop → the stop outcome; the counted ceiling → BUDGET_EXHAUSTED (honest); anything else → DB_ERROR/<site> */
  const dbFail = (e, site) => (e instanceof Stopped ? stopOutcome() : e instanceof Refusal && e.code === "DB_BUDGET" ? done(uncertain() ?? "BUDGET_EXHAUSTED", "DB_QUERY_CEILING") : done(uncertain() ?? "DB_ERROR", site));
  /** best available OBSERVED facts: recorded on every exit that has them; `factsObserved` distinguishes unobserved from absent */
  const observe = (f) => {
    if (!f || !f.intent) return;
    r.factsObserved = true; r.finalState = f.intent.status; r.finalVersion = f.intent.version;
    r.publicStatus = input && input.tooling && typeof input.tooling.publicStatus === "function" ? String(input.tooling.publicStatus(f.intent)) : null;
    r.reservationId = f.intent.reservation && f.intent.reservation.reservationId !== null && f.intent.reservation.reservationId !== undefined ? String(f.intent.reservation.reservationId) : null;
    r.capturedMinor = f.intent.payment ? f.intent.payment.capturedMinor ?? null : null;
    r.offlineChargeId = f.row && f.row.och !== null && f.row.och !== undefined ? String(f.row.och) : null;
    const caps = f.ops.filter((o) => o.op_type === CAPTURE);
    r.chargeId = caps.length === 1 && caps[0].state === "succeeded" && CHARGE_RE.test(String(caps[0].result_ref ?? "")) ? String(caps[0].result_ref) : null;
    r.cancelOps = f.ops.filter((o) => o.op_type === CANCEL).map((o) => o.state);
    r.refundOps = f.ops.filter((o) => o.op_type === REFUND).map((o) => o.state);
    const mirrors = f.ops.filter((o) => o.op_type === MIRROR);
    r.mirrorOps = mirrors.map((o) => o.state);
    r.mirrorRefundId = mirrors.length === 1 && mirrors[0].state === "succeeded" && OCH_RE.test(String(mirrors[0].result_ref ?? "")) ? String(mirrors[0].result_ref) : null;
    r.refundRecord = f.refunds.length === 0 ? null : f.refunds.map((x) => x.state);
    r.refundId = f.refunds.length === 1 && REFUND_RE.test(String(f.refunds[0].stripe_refund_id ?? "")) ? String(f.refunds[0].stripe_refund_id) : null;
    const recs = f.ops.filter((o) => o.op_type === RECORD);
    r.recordingLinked = recs.length === 0 ? null : recs.length === 1 && recs[0].state === "succeeded" && recs[0].settled_evidence === true;
    const notes = f.ops.filter((o) => o.op_type === NOTIFY);
    r.notifySuppressed = notes.length === 0 ? null : notes.length === 1 && suppressed(notes[0]) && !!f.notify && f.notify.suppressions === 1;
    r.claimHeld = f.claims.length === 1 ? f.claims[0].released === false : null;
    r.legs = f.row ? { reservationCancelled: f.row.cancelled, authorizationSettled: f.row.settled, recordingMirrored: f.row.mirrored } : null;
    r.endOk = f.endOk;
  };
  // ---- (1) LABELLED COPY (Slice 4 F2): ONE counted pool for EVERY statement of the session — runner reads, the request, both workers, the lock session, the
  // teardown residual read and the unlock. `limit` is the body ceiling (total − reserve) until the teardown, then the TOTAL; refused statements never execute.
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
    if (!plan || plan.schema !== PLAN_SCHEMA || plan.accountId !== c.accountId || plan.listingId !== c.listingId || plan.stripeVersion !== c.stripeVersion || plan.currency !== c.currency
        || plan.paymentMethod !== c.paymentMethod || plan.accountRef !== c.accountRef
        || !INTENT_RE.test(String(plan.intentId)) || !isVersion(plan.expectedVersion) || isoMs(plan.notBefore) === null || !PI_RE.test(String(plan.paymentIntentId))
        || !RID_RE.test(String(plan.reservationId)) || c.protectedReservationIds.includes(String(plan.reservationId)) || !CHARGE_RE.test(String(plan.chargeId)) || !isAmount(plan.capturedMinor)
        || !OCH_RE.test(String(plan.offlineChargeId)) || plan.offlineChargeId === plan.reservationId || plan.amount !== exactAmount(plan.capturedMinor)
        || plan.recordingTitle !== offlineChargeTitle(plan.intentId) || plan.mirrorTitle !== mirrorTitle(plan.intentId)
        || !realDate(plan.from) || !realDate(plan.to) || !(plan.from < plan.to) || !isGuests(plan.guests) || !UUID_RE.test(String(plan.attemptId)) || !SESSION_RE.test(String(plan.sessionId))
        || plan.refundIdempotencyKey !== `ref:${plan.intentId}:1` || plan.recordingIdempotencyKey !== `och:${plan.intentId}:1` || plan.mirrorIdempotencyKey !== `ochr:${plan.intentId}:1`
        || plan.intentId === c.synthetic.intentId || typeof planHash !== "string" || sha(canonical(plan)) !== planHash || typeof runId !== "string" || !RUN_ID_RE.test(runId)
        || !pool || typeof pool.query !== "function" || !tooling || !exchanges || typeof exchanges.stripe !== "function" || typeof exchanges.hostaway !== "function"
        || !credentials || typeof credentials.stripe !== "function" || typeof credentials.hostaway !== "function") return done("CORE_INVALID");
    for (const k of TOOLING_KEYS) if (typeof tooling[k] !== "function") return done("CORE_INVALID", "TOOLING_INVALID");
    if (typeof tooling.LOCK_KEY !== "string" || typeof tooling.LOCK_PRECHECK_SQL !== "string") return done("CORE_INVALID", "TOOLING_INVALID");
    if (tooling.mirrorTitle(plan.intentId) !== plan.mirrorTitle) return done("CORE_INVALID", "MIRROR_TITLE_NOT_ACCEPTED");
    r.clientSnapshotId = runId;
    const clock = input.clock ?? (() => Date.now());
    const mono = input.monotonic ?? (() => performance.now());
    const runSignal = input.runSignal ?? null;
    const endsAt = mono() + B.runMs;
    runSignalRef = runSignal; monoRef = mono; endsAtRef = endsAt;
    const sleep = input.sleep ?? ((t) => new Promise((res) => { const h = setTimeout(res, t); runSignal?.addEventListener?.("abort", () => { clearTimeout(h); res(); }, { once: true }); }));
    const lockClientFactory = input.lockClientFactory ?? (() => pool.connect());
    // SYNCHRONOUS latching (Slice 4): the run abort and the wall deadline abort the runner-owned signal the moment they happen (not at the next gate)
    if (runSignal && typeof runSignal.addEventListener === "function") { if (runSignal.aborted) stopped(); else runSignal.addEventListener("abort", () => { stopped(); }, { once: true }); }
    deadlineTimer = setTimeout(() => { stopped(); }, Math.max(1, Math.floor(endsAt - mono())));

    const q = async (sql, params) => { guard(); const res = await countedPool.query(sql, params); return res.rows; };
    const read = (o) => readFacts(q, plan, tooling, { query: (sql, params) => { guard(); return countedPool.query(sql, params); } }, o);

    // ---- (2) read-only start check: the pins are RE-READ and cross-checked; the schema prerequisite is READ, never applied -----------------------
    let f;
    try { f = await read(); } catch (e) { return dbFail(e, "START_READ_FAILED"); }
    r.startState = f.intent ? f.intent.status : null;
    const st = checkStart(f, plan, c, tooling);
    if (!st.ok) return done(st.code === "SCHEMA_PREREQUISITE_MISSING" ? "SCHEMA_PREREQUISITE_MISSING"
      : ["STATE_NOT_CONFIRMED", "VERSION_NOT_PINNED", "HISTORIC_INTENT", "RESERVATION_LEASE_HELD", "WORK_LEASE_HELD", "RECORDING_NOT_PROVEN_LINKED", "HISTORY_NOT_RECORDED", "NOTIFY_NOT_PRISTINE",
        "NOTIFY_NOT_SINGLE", "REASON_CODE_PRESENT", "SETTLEMENT_PRESENT", "READ_HISTORY_UNSETTLED", "RECORDING_HOLD_PRESENT"].includes(st.code) ? "START_STATE_NOT_ELIGIBLE" : "SCOPE_REFUSED", st.code);
    const intent0 = st.intent; const PI = plan.paymentIntentId; const RID = plan.reservationId; const OCH = plan.offlineChargeId;

    // ---- (3) LABELLED COPY (Slice 1 §3, F4): the P3 session lock on a DEDICATED client; pid-stable proof --------------------------------------
    try { lockClient = await lockClientFactory(); } catch { return done("DB_ERROR", "LOCK_CONNECT_FAILED"); }
    const onLockErr = () => { lockErrored = true; r.lockSession = "error_observed"; stopAc.abort(); stopped(); };   // synchronous abort of every composed signal
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
    const proveLock = async (tag) => {
      try { if (!(await ownLock())) { r.lock = "lost"; return done(uncertain() ?? "LOCK_LOST", lockErrored ? "LOCK_SESSION_ERROR" : r.lockSession === "backend_hop" ? "BACKEND_HOP" : "LOCK_NOT_HELD"); } }
      catch (e) { return dbFail(e, "LOCK_PROOF_FAILED"); }
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
    } catch (e) { return dbFail(e, "IDENTITY_READ_FAILED"); }

    // ---- (5) the target-only transport fence (recorded phase): exact URL / method / headers / body; counters BEFORE the exchange; ORDER cancel → refund → mirror --
    const urls = { account: `${STRIPE}/v1/account`, pi: `${STRIPE}/v1/payment_intents/${PI}?expand%5B%5D=latest_charge`, refundPost: `${STRIPE}/v1/refunds`,
      refundList: `${STRIPE}/v1/refunds?payment_intent=${enc(PI)}&limit=100`, reservation: `${HOSTAWAY}/v1/reservations/${RID}`, cancel: `${HOSTAWAY}/v1/reservations/${RID}/statuses/cancelled`,
      list: `${HOSTAWAY}/v1/guestPayments/charges?limit=${LIST_LIMIT}&reservationIds=${RID}`,                       // the ACCEPTED H8 wire (reviewed documented selector)
      mirror: `${HOSTAWAY}/v1/guestPayments/charges/${RID}/${OCH}/refund` };
    const MIRROR_BODY_WIRE = JSON.stringify({ title: plan.mirrorTitle, amount: plan.amount, isIncludeInPriceBreakdown: 0 });   // = the accepted bound transport's serialisation of the bound body
    const fence = { refundOpId: null, refundBody: null, cancelOpen: false, cancelExchanged: false, refundOpen: false, refundExchanged: false, mirrorOpen: false, mirrorExchanged: false };
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
      else if (isRefund && fence.refundOpen && !fence.refundExchanged && fence.cancelExchanged) fence.refundExchanged = true;      // the ONE refund, AFTER the cancel: exact URL / method / headers / body / key
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
      const jsonWrite = hkeys(req.headers) === "Accept,Authorization,Cache-control,Content-Type" && req.headers["Content-Type"] === "application/json";
      const isCancel = req.method === "PUT" && req.url === urls.cancel && jsonWrite && req.body === CANCEL_BODY_WIRE;
      const isMirror = req.method === "POST" && req.url === urls.mirror && jsonWrite && req.body === MIRROR_BODY_WIRE;
      if (plainGet && req.url === urls.reservation && r.hostawayReads < B.hostawayReads) r.hostawayReads += 1;        // ONLY the pinned reservation id
      else if (plainGet && isLookupUrl(req.url) && r.lookupPages < B.lookupPages) r.lookupPages += 1;
      else if (plainGet && req.url === urls.list && r.chargeLists < B.chargeLists) r.chargeLists += 1;                // ONLY the pinned reservation's charge list (accepted H8 wire)
      else if (isCancel && fence.cancelOpen && !fence.cancelExchanged) fence.cancelExchanged = true;                  // the ONE cancel: exact URL / method / headers / body
      else if (isMirror && fence.mirrorOpen && !fence.mirrorExchanged && fence.cancelExchanged && fence.refundExchanged) fence.mirrorExchanged = true;   // the ONE mirror, AFTER cancel + refund
      else { r.refusedAtTransport += 1; return Promise.reject(new Error("gate")); }                                   // no other Hostaway exchange, ever (no create / record / message)
      r.exchanges += 1;
      return exchanges.hostaway(req);
    };
    const ts = tooling.createStripeSend({ exchange: stripeGate, credential: credentials.stripe, accountId: c.accountId, apiVersion: c.stripeVersion });
    const th = tooling.createHostawaySend({ exchange: hostawayGate, credential: credentials.hostaway });
    if (!ts || ts.ok !== true || !th || th.ok !== true) return done("CORE_INVALID", "TRANSPORT_INVALID");
    const composed = (sig) => {
      const parts = [stopAc.signal];                                                                  // the runner-owned stop first
      if (sig instanceof AbortSignal) parts.push(sig);
      if (runSignal instanceof AbortSignal) parts.push(runSignal);
      parts.push(AbortSignal.timeout(Math.max(1, Math.floor(endsAt - mono()))));
      return AbortSignal.any(parts);
    };
    const adapterConfig = tooling.validateAdapterConfig({ allowedListingIds: [c.listingId], refFieldId: c.refFieldId, channelId: 2000, currency: c.currency });
    const cfg = freeze({ accountRef: c.accountRef, channelId: 2000, currency: c.currency, listingId: c.listingId, paymentMethod: c.paymentMethod, refFieldId: c.refFieldId });
    const listArgs = { tooling, intentId: plan.intentId, reservationId: RID, listingId: c.listingId, offlineChargeId: OCH, amountMinor: plan.capturedMinor, currency: c.currency, paymentMethod: c.paymentMethod,
      recordingTitle: plan.recordingTitle, mirrorTitle: plan.mirrorTitle };

    // ---- (6) account + fresh STRICT captured-and-UNREFUNDED Stripe proof + the bound ACTIVE future-arrival reservation (ref ECHOED) + ONE complete LIST (reads only) BEFORE the request --
    try {
      guard();
      const acct = await ts.transport.send({ op: "accounts.retrieve" }, { signal: composed(null) });
      if (!acct || acct.object !== "account" || acct.id !== c.accountId) return done("PROVIDER_PROOF_FAILED", "ACCOUNT");
      guard();
      const pi = await ts.transport.send({ op: "paymentIntents.retrieve", id: PI, params: { expand: ["latest_charge"] } }, { signal: composed(null) });
      const observed = tooling.paymentIntentProofObservationV3(pi, { accountVerified: true });
      const ev = { id: "runner-readback", kind: "payment_intent", readOpType: "stripe.retrieve_payment_intent", requestRef: PI, externalRef: PI, status: observed.status, observed, observedAt: clock() };
      const bound = { intent: intent0, attemptId: st.attemptId, chargeId: plan.chargeId, capturedMinor: plan.capturedMinor, currency: c.currency };
      const v3 = piCapturedV3Refusal(ev, { ...bound, phase: "unrefunded" }, tooling.piIdentityOk);
      if (v3) return done("PROVIDER_PROOF_FAILED", v3);
      const raw = tooling.rawPiPreSendRefusal(pi, { paymentIntentId: PI, chargeId: plan.chargeId, amountMinor: plan.capturedMinor, currency: c.currency });
      if (raw) return done("PROVIDER_PROOF_FAILED", CODE_RE.test(String(raw)) ? String(raw) : "PI_PROOF");
      guard();
      // the ACCEPTED activeReservationProof over runner-read observations (never persisted); the booking ref MUST be echoed: the accepted mirror worker requires the full
      // identity incl. the ref on the CANCELLED reservation (mirrorReservationEvidenceRefusal REF) and has no by-ref lookup, so a non-echoed ref is refused HERE, before any write
      const rr = await th.transport.send({ method: "GET", path: `/v1/reservations/${RID}`, query: {} }, { signal: composed(null) });
      if (!rr || rr.httpStatus !== 200) return done("PROVIDER_PROOF_FAILED", `RESERVATION_READ_${Number.isSafeInteger(rr && rr.httpStatus) ? rr.httpStatus : "FAILED"}`);
      const env = tooling.unwrapEnvelope(rr.json);
      if (!env || env.ok !== true) return done("PROVIDER_PROOF_FAILED", "RESERVATION_ENVELOPE");
      const nr = tooling.normalizeReservation(env.result, adapterConfig);
      if (!nr || nr.ok !== true) return done("PROVIDER_PROOF_FAILED", "RESERVATION_MALFORMED");
      if (nr.reservation.channelId !== 2000) return done("PROVIDER_PROOF_FAILED", "RESERVATION_CHANNEL_NOT_DIRECT");
      const byId = runnerResEvidence("runner-res-by-id", RES_READ_OP, RID, nr.reservation, clock());
      if (byId.observed.bookingRef === undefined) return done("PROVIDER_PROOF_FAILED", "REF_NOT_ECHOED");
      const ap = tooling.activeReservationProof({ intent: intent0, byId, byRef: null, now: clock(), notBefore: isoMs(plan.notBefore) });
      if (!ap || ap.ok !== true) return done("PROVIDER_PROOF_FAILED", ap && CODE_RE.test(String(ap.code)) ? `RESERVATION_${String(ap.code)}` : "RESERVATION_PROOF");
      const arr = tooling.arrivalStrictlyFuture(plan.from, c.listingTimeZone, clock());
      if (!arr || arr.ok !== true) return done("PROVIDER_PROOF_FAILED", "ARRIVAL_NOT_IN_FUTURE");
      guard();
      // ONE complete charge LIST (accepted H8 form): the original present and unchanged, ZERO refund / mirror-marker / same-amount / untyped-link rows (the mirror worker re-reads its own)
      const lr = await th.transport.send({ method: "GET", path: "/v1/guestPayments/charges", query: { limit: LIST_LIMIT, reservationId: RID } }, { signal: composed(null) });
      if (!lr || !Number.isSafeInteger(lr.httpStatus)) return done("PROVIDER_PROOF_FAILED", "LIST_READ_FAILED");
      const lc = chargeListRefusal(lr, { ...listArgs, phase: "before" });
      if (lc) return done("PROVIDER_PROOF_FAILED", `LIST_${lc}`);
      r.proofs.push("PROVIDER_BEFORE_REQUEST");
    } catch (e) { if (e instanceof Stopped || stopped()) return stopOutcome(); return done("PROVIDER_PROOF_FAILED", "READ_FAILED"); }

    // ---- (7) ONE accepted recorded request (the ONLY admission write of this runner): lock proven immediately before; a throw is NEVER repeated ----
    { const p = await proveLock("BEFORE_REQUEST"); if (p) return p; }
    if (stopped()) return stopOutcome();
    const requestEnv = { VERCEL_ENV: "development", MV_E7_TEST_CLEANUP: "enabled" };
    const operator = operatorExpectation(plan, planHash);
    let rq;
    try {
      r.requestInvocations += 1; r.writes.request += 1; r.requestOutcome = "SENT";
      rq = await tooling.requestRecordedTestCleanup(countedPool, plan.intentId, { now: clock(), env: requestEnv, operator });
      r.requestOutcome = rq && typeof rq === "object" ? "REPLIED" : "UNKNOWN";
    } catch (e) {
      r.requestOutcome = "UNKNOWN";                                                                  // the transaction may or may not have committed: read, report, STOP
      try { observe(await read()); } catch { /* reported below */ }
      return done("REQUEST_OUTCOME_UNKNOWN", e instanceof Refusal && e.code === "DB_BUDGET" ? "DB_QUERY_CEILING" : "REQUEST_THREW");
    }
    if (!rq || rq.ok !== true) { try { f = await read(); observe(f); } catch { /* reported below */ } return done("REQUEST_REFUSED", rq && CODE_RE.test(String(rq.error)) ? String(rq.error) : "REQUEST_REFUSED"); }
    if (stopped()) return stopOutcome();
    try { f = await read(); } catch (e) { return dbFail(e, "LINEAGE_READ_FAILED"); }
    observe(f);
    const lin = checkLineage(f, plan, c);
    if (!lin.ok) return done("LINEAGE_MISMATCH", lin.code);
    fence.refundOpId = lin.refundOpId;
    fence.refundBody = `payment_intent=${enc(PI)}&amount=${plan.capturedMinor}&metadata%5Bmv_refund_op%5D=${enc(fence.refundOpId)}&metadata%5Bmv_refund_key%5D=${enc(plan.refundIdempotencyKey)}`;

    // ---- (8) the ISOLATED accepted test-cleanup executors (cleanup phase) over the fence; every write counted and fenced BEFORE the transport -------------
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
    const stopWrap = (fn) => async (...args) => { if (stopped()) { r.refusedByStop += 1; throw new Error("stopped"); } return Reflect.apply(fn, undefined, args); };
    const cleanupExecutors = {};
    for (const k of Object.keys(bx.executors)) cleanupExecutors[k] = stopWrap(bx.executors[k]);
    freeze(cleanupExecutors);
    // ---- (8b) the mirror phase: the accepted executors for the Stripe / reservation reads, the accepted H8 transport form for the LIST, and the NEW accepted BOUND
    // mirror transport for the ONE POST (validated immutable binding, exact fences, private counter) over the accepted real exchange via a runner-local fetch adapter:
    // the adapter adds ONLY the `Cache-control: no-cache` header the accepted exchange requires of a Hostaway write, forwards method / URL / body / signal unchanged, and
    // reduces the exchange reply to the Response-like { status, text() } the bound transport consumes. Counted and fenced BEFORE the transport, after cancel + refund.
    const listSend = async (req, opts) => {
      if (stopped()) { r.refusedByStop += 1; throw new Error("stopped"); }
      if (!req || req.method !== "GET" || req.path !== "/v1/guestPayments/charges" || !req.query || Object.keys(req.query).sort().join(",") !== "limit,reservationId"
          || req.query.limit !== LIST_LIMIT || String(req.query.reservationId) !== RID) { r.refusedAtTransport += 1; throw new Error("list refused"); }
      return th.transport.send({ method: "GET", path: req.path, query: { limit: LIST_LIMIT, reservationId: RID } }, { ...(opts && typeof opts === "object" ? opts : {}), signal: composed(opts && opts.signal) });
    };
    const decoder = new TextDecoder();
    const mirrorFetch = async (url, init) => {
      if (stopped()) { r.refusedByStop += 1; throw new Error("stopped"); }
      const h = init && init.headers && typeof init.headers === "object" ? init.headers : null;
      if (!h || init.method !== "POST" || url !== urls.mirror || hkeys(h) !== "Accept,Authorization,Content-Type" || h.Accept !== "application/json" || h["Content-Type"] !== "application/json"
          || typeof h.Authorization !== "string" || typeof init.body !== "string") { r.refusedAtTransport += 1; throw new Error("mirror wire refused"); }
      const reply = await hostawayGate({ method: "POST", url, headers: freeze({ Accept: "application/json", Authorization: h.Authorization, "Cache-control": "no-cache", "Content-Type": "application/json" }),
        body: init.body, signal: init.signal, maxBytes: 1024 * 1024 });
      const bytes = reply && reply.bytes;
      return { status: Number(reply && reply.status), text: async () => (bytes ? decoder.decode(bytes) : "") };
    };
    const bound = tooling.buildHostawayMirrorExecutors({ fetchImpl: mirrorFetch, baseUrl: HOSTAWAY, bearer: credentials.hostaway,
      binding: { intentId: plan.intentId, reservationId: RID, offlineChargeId: OCH, amountMinor: plan.capturedMinor, currency: c.currency } });
    if (!bound || typeof bound.refundOfflineCharge !== "function" || typeof bound.counts !== "function") return done("CORE_INVALID", "MIRROR_TRANSPORT_INVALID");
    const mirrorSend = async (req, opts) => {
      if (stopped()) { r.refusedByStop += 1; throw new Error("stopped"); }
      if (!req || req.method !== "POST" || req.path !== `/v1/guestPayments/charges/${RID}/${OCH}/refund`) { r.refusedAtTransport += 1; throw new Error("path refused"); }   // the ONE mirror path, nothing else
      if (r.mirrorInvocations >= B.mirror || !fence.cancelExchanged || !fence.refundExchanged || stopped()) { r.refusedAtTransport += 1; throw new Error("mirror budget"); }   // counter fence BEFORE the transport; ORDER
      r.mirrorInvocations += 1; r.writes.mirror += 1; fence.mirrorOpen = true;
      try {
        const out = await bound.refundOfflineCharge(req, { ...(opts && typeof opts === "object" ? opts : {}), signal: composed(opts && opts.signal) });
        r.mirrorOutcome = out && typeof out === "object" && Number.isSafeInteger(out.httpStatus) ? "REPLIED" : "UNKNOWN";
        return out;
      } catch (e) { r.mirrorOutcome = fence.mirrorExchanged ? "UNKNOWN" : "NOT_SENT"; throw e; }
      finally { fence.mirrorOpen = false; r.mirrorTransportPosts = bound.counts().posts; }
    };
    const mirrorExecutors = freeze({ retrieveAccount: cleanupExecutors.retrieveAccount, retrievePaymentIntent: cleanupExecutors.retrievePaymentIntent, retrieveReservation: cleanupExecutors.retrieveReservation,
      listOfflineCharges: stopWrap(listSend), refundOfflineCharge: stopWrap(mirrorSend) });
    const listings = new Map([[c.listingId, { currency: c.currency, timeZone: c.listingTimeZone }]]);
    const cleanupEnv = { VERCEL_ENV: "development", MV_E7_TEST_CLEANUP: "enabled", MV_E7_TEST_CLEANUP_WORKER: "enabled" };
    const mirrorEnv = { VERCEL_ENV: "development", MV_E7_TEST_CLEANUP: "enabled", MV_E7_MIRROR_WORKER: "enabled" };

    // ---- (9) LABELLED COPY (Slice 3 §9): bounded worker steps; lock proven before EVERY step; stop after the awaited proof and before the worker; the accepted
    // cleanup worker until BOTH legs are proven by the DB, then the accepted mirror worker (never before; never both in one step) -------------------------------
    let finalFacts = null;
    for (let step = 1; step <= B.steps; step++) {
      if (stopped()) return stopOutcome();
      { const p = await proveLock(step === 1 ? "BEFORE_WORKER" : `BEFORE_STEP_${step}`); if (p) return p; }
      const legsProven = f.row && f.row.cancelled === true && f.row.settled === true && f.row.mirrored === false;
      const mirrorRows = f.ops.filter((o) => o.op_type === MIRROR);
      let phase = "cleanup";
      if (legsProven) {
        if (mirrorRows.length !== 1) { finalFacts = f; return done("CLEANUP_UNKNOWN_STATE", mirrorRows.length === 0 ? "MIRROR_ROW_MISSING" : "MIRROR_HISTORY_MULTIPLE"); }
        if (mirrorRows[0].state === "pending") { const mr = mirrorRowRefusal(mirrorRows[0], plan, c, { done: false }); if (mr) { finalFacts = f; return done("LINEAGE_MISMATCH", mr); } }
        phase = "mirror";
      } else if (mirrorRows.length !== 0) { finalFacts = f; return done("LINEAGE_MISMATCH", "MIRROR_ROW_PREMATURE"); }
      let w;
      if (stopped()) return stopOutcome();                                                            // immediately BEFORE the worker is admitted
      const stepSignal = composed(null);
      const deadlineAt = clock() + Math.max(0, Math.floor(endsAt - mono()));
      try {
        r.steps += 1;
        if (phase === "cleanup") {
          r.cleanupSteps += 1;
          w = await tooling.runTestCleanupStep(countedPool, { workerId: `e7-hosted-rtc:${plan.approvalRef}`, env: cleanupEnv, adapterConfig, listings, executors: cleanupExecutors, clock, stripeAccountId: c.accountId,
            intentId: plan.intentId, signal: stepSignal, deadlineAt, monotonic: mono });
        } else {
          r.mirrorSteps += 1;
          w = await tooling.runMirrorStep(countedPool, { workerId: `e7-hosted-rtc:${plan.approvalRef}`, env: mirrorEnv, adapterConfig, recordingConfig: cfg, clientSnapshotId: runId, listings, executors: mirrorExecutors,
            clock, stripeAccountId: c.accountId, intentId: plan.intentId, signal: stepSignal, deadlineAt, monotonic: mono });
        }
      } catch (e) {
        if (e instanceof Refusal && e.code === "DB_BUDGET") return done(uncertain() ?? "BUDGET_EXHAUSTED", "DB_QUERY_CEILING");
        if (stopped()) return stopOutcome();
        return done(uncertain() ?? "DB_ERROR", "WORKER_THREW");
      }
      for (const a of (w && Array.isArray(w.actions) ? w.actions : [])) if (r.actions.length < 240 && CODE_RE.test(String(a))) r.actions.push(`${phase === "mirror" ? "M:" : "C:"}${String(a)}`);
      if (w && w.stop && typeof w.stop === "object" && CODE_RE.test(String(w.stop.code)) && CODE_RE.test(String(w.stop.where))) r.workerStop = { phase, code: String(w.stop.code), where: String(w.stop.where) };
      if (w && w.late) await Promise.race([Promise.resolve(w.late).catch(() => {}), sleep(1000)]);                 // dropped late replies are never success
      if (!w || w.status === "refused") return done(uncertain() ?? "WORKER_REFUSED", w && CODE_RE.test(String(w.code)) ? String(w.code) : "WORKER_REFUSED");
      if (uncertain()) { try { finalFacts = await read(); observe(finalFacts); } catch { /* reported below */ } return done("WRITE_OUTCOME_UNKNOWN", r.cancelOutcome === "UNKNOWN" ? "LOST_CANCEL_REPLY" : r.refundOutcome === "UNKNOWN" ? "LOST_REFUND_REPLY" : "LOST_MIRROR_REPLY"); }
      if (stopped()) return stopOutcome();
      try { f = await read(); } catch (e) { return dbFail(e, "STEP_READBACK_FAILED"); }
      observe(f);
      if (stopped()) return stopOutcome();
      const stNow = f.intent ? f.intent.status : null;
      const unknownRow = [...r.cancelOps, ...r.refundOps, ...r.mirrorOps].some((s) => s === "outcome_unknown");
      if (unknownRow) { finalFacts = f; return done("WRITE_OUTCOME_UNKNOWN", "WORKER_SETTLED_UNKNOWN"); }          // v1: the session stops; a resume needs its OWN pinned admission
      if (stNow === "cancelled") { finalFacts = f; break; }
      if (stNow === "reconciliation_required") { finalFacts = f; return done("CLEANUP_ESCALATED", "OWNER_CASE"); }  // incl. every mirror HOLD (owner review; never a resend)
      if (stNow !== "test_cleanup_pending") { finalFacts = f; return done("CLEANUP_UNKNOWN_STATE", `STATE_${String(stNow).toUpperCase()}`); }
      if ([...r.cancelOps, ...r.refundOps, ...r.mirrorOps].some((s) => s === "in_flight")) { finalFacts = f; return done("WRITE_OUTCOME_UNKNOWN", "WRITE_ROW_IN_FLIGHT"); }
      if (r.cancelInvocations > 0 && r.cancelOps.every((s) => s === "pending")) { finalFacts = f; return done("WRITE_OUTCOME_UNKNOWN", "CANCEL_SENT_WITHOUT_SETTLEMENT"); }
      if (r.refundInvocations > 0 && r.refundOps.every((s) => s === "pending")) { finalFacts = f; return done("WRITE_OUTCOME_UNKNOWN", "REFUND_SENT_WITHOUT_SETTLEMENT"); }
      if (r.mirrorInvocations > 0 && r.mirrorOps.every((s) => s === "pending")) { finalFacts = f; return done("WRITE_OUTCOME_UNKNOWN", "MIRROR_SENT_WITHOUT_SETTLEMENT"); }
      if (step === B.steps) { finalFacts = f; return done("STEP_BUDGET_EXHAUSTED", r.mirrorOps.some((s) => s === "succeeded") ? "SUCCEEDED_EVENT_PENDING" : "STEPS"); }
      const delay = w.status === "worked" && Number.isSafeInteger(w.delayMs) ? Math.min(Math.max(w.delayMs, 0), B.waitCapMs) : Math.min(5000, B.waitCapMs);
      const left = endsAt - mono();
      if (left <= delay) { r.stopReason = "DEADLINE"; stopReason = "DEADLINE"; stopAc.abort(); return stopOutcome(); }
      await sleep(delay);
    }

    // ---- (10) read-only postcheck (incl. the accepted 0021 end predicate): output and persisted facts must agree; then fresh bound provider readbacks (reads only) ----
    try { finalFacts = await read({ withEnd: true }); } catch (e) { return dbFail(e, "POSTCHECK_READ_FAILED"); }
    observe(finalFacts);
    const pe = checkEnd(finalFacts, plan, c, tooling);
    if (pe) return done("POSTCHECK_MISMATCH", pe);
    const re = String(finalFacts.refunds[0].stripe_refund_id);
    const mid = String(finalFacts.ops.find((o) => o.op_type === MIRROR).result_ref);
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
      const cr = cancelledReservationReadbackRefusal(nr, { plan, ref: finalFacts.intent.ref, c });
      if (cr) return done("POSTCHECK_MISMATCH", cr);
      guard();
      const lr = await th.transport.send({ method: "GET", path: "/v1/guestPayments/charges", query: { limit: LIST_LIMIT, reservationId: RID } }, { signal: composed(null) });
      const lc = chargeListRefusal(lr, { ...listArgs, phase: "after", mirrorRefundId: mid });
      if (lc) return done("POSTCHECK_MISMATCH", `READBACK_${lc}`);
      r.proofs.push("READBACK");
    } catch (e) { if (e instanceof Stopped || stopped()) return stopOutcome(); return done("POSTCHECK_MISMATCH", "READBACK_FAILED"); }
    r.postcheck = { cancelOps: 1, refundOps: 1, mirrorOps: 1, refundRecord: "succeeded", refundId: re, mirrorRefundId: mid, offlineChargeId: OCH, capturedMinor: finalFacts.intent.payment.capturedMinor,
      recordingLinked: true, notifySuppressed: true, claimReleased: true, openCases: 0, legs: { reservationCancelled: true, authorizationSettled: true, recordingMirrored: true }, endOk: true, publicStatus: "not_completed_refunded" };
    if (stopped()) return stopOutcome();
    return done("RECORDED_CLEANUP_COMPLETED");
  };
  // LABELLED COPY (Slice 4 finally, F2): bounded residual read within the COUNTED reserve, provisional success re-validated, checked unlock on the dedicated session
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
    limit = B.dbQueries;
    const teardownStart = r.dbQueries;
    if ((r.steps > 0 || r.requestInvocations > 0) && countedPool && input.tooling) {
      const raw = { query: (sql, params) => countedPool.query(sql, params) };
      const b = await bounded(readFacts(async (sql, params) => (await countedPool.query(sql, params)).rows, input.plan, input.tooling, raw, { withEnd: true }));
      if (b.done && !b.threw) observe(b.value);
      if (r.outcome === "RECORDED_CLEANUP_COMPLETED") {
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
      if (lockAcquired && !released && r.outcome === "RECORDED_CLEANUP_COMPLETED") { r.outcome = "NOT_CONFIRMED"; r.code = lockErrored ? "LOCK_SESSION_ERROR_AT_TEARDOWN" : "UNLOCK_NOT_PROVEN"; }
    }
    if (r.outcome === "RECORDED_CLEANUP_COMPLETED" && stopped()) { r.outcome = "NOT_CONFIRMED"; r.code = `STOP_${stopReason}_AT_TEARDOWN`; }
    r.dbTeardownQueries = r.dbQueries - teardownStart;
    if (deadlineTimer) clearTimeout(deadlineTimer);
  }
  return snapshot();
}

// =================================================================================================================================
// hosted wrapper (GitHub Actions): preflight (no secrets) / verify / execute (CLOSED until executeEnabled is reviewed true)
// LABELLED COPY of the reviewed Slice 3 runHosted, specialised: recorded inputs (+ the original offline charge id, the run id), closure / runner files, HRT_ codes.
export const CLOSURE_DIGEST_PREFIX = "e7-hosted-recorded-cleanup-closure-v1\n";
export const RUNNER_DIGEST_PREFIX = "e7-hosted-recorded-cleanup-runner-v1\n";
const TEST_FILE = "test/e7-hosted-recorded-cleanup.test.mjs";
const SECRET_KEYS = Object.freeze(["E7_STRIPE_TEST_KEY", "E7_HOSTAWAY_TOKEN", "E7_DEV_BOOKING_DATABASE_URL"]);
export const INPUT_ENV = freeze({ approvalRef: "E7_APPROVAL_REF", intentId: "E7_INTENT_ID", expectedVersion: "E7_EXPECTED_VERSION", notBefore: "E7_NOT_BEFORE", paymentIntentId: "E7_PAYMENT_INTENT_ID",
  reservationId: "E7_RESERVATION_ID", chargeId: "E7_CHARGE_ID", offlineChargeId: "E7_OFFLINE_CHARGE_ID", capturedMinor: "E7_CAPTURED_MINOR", from: "E7_STAY_FROM", to: "E7_STAY_TO", guests: "E7_GUESTS",
  attemptId: "E7_ATTEMPT_ID", sessionId: "E7_SESSION_ID" });
export const RUN_ID_ENV = "E7_RUN_ID";

/** runHosted({ mode, env, proc, wrapperDir, deps }) → { exitCode, result }. Never throws. deps = TEST SEAMS. */
export async function runHosted({ mode = "preflight", env, proc, wrapperDir, deps = {} }) {
  const c = deps.constants ?? CONSTANTS;
  const spawnChild = deps.spawnChild ?? spawnNode;
  const importEnv = deps.importEnv ?? ((dir) => import(pathToFileURL(`${dir}/scripts/e7-connected/probe-env-preflight.mjs`).href));
  const importTooling = deps.importTooling ?? defaultImportTooling;
  const runCore = deps.runCore ?? runRecordedCleanupCore;
  const readPgVersion = deps.readPgVersion ?? (async (dir) => JSON.parse(await readFile(`${dir}/node_modules/pg/package.json`, "utf8")).version);
  const readCa = deps.readCa ?? ((p) => readFile(p));
  const r = { schema: "e7-hosted-recorded-cleanup-hosted-v1", mode: null, code: null, workflowSha: null, toolingCommit: c.toolingCommit, toolingStatus: c.toolingStatus,
    executeEnabled: c.executeEnabled, closureDigest: null, runnerDigest: null, planKind: null, planHash: null, runId: null, envCode: null, tests: null, lockEndpoint: null, core: null };
  let pool = null; let lockPool = null;
  try {
    if (!["preflight", "verify", "execute"].includes(mode)) refuse("HRT_USAGE");
    r.mode = mode;
    r.workflowSha = HEX40.test(env.E7_WORKFLOW_SHA ?? "") ? env.E7_WORKFLOW_SHA : null;
    const has = (k) => typeof env[k] === "string" && env[k].length > 0;
    if (mode !== "execute" && SECRET_KEYS.some(has)) refuse("HRT_SECRET_SCOPE_VIOLATION");
    const inp = {}; for (const k of PLAN_INPUT_KEYS) inp[k] = env[INPUT_ENV[k]] ?? "";
    const expPlan = env.E7_EXPECTED_PLAN_HASH ?? ""; const expClo = env.E7_EXPECTED_CLOSURE_DIGEST ?? ""; const expRun = env.E7_EXPECTED_RUNNER_DIGEST ?? "";
    const runId = env[RUN_ID_ENV] ?? "";
    const vals = PLAN_INPUT_KEYS.map((k) => inp[k]); const anyReal = vals.some((v) => v !== "");
    if (anyReal && vals.some((v) => v === "")) refuse("HRT_INPUT_INCOMPLETE");
    if (anyReal && (!APPROVAL_RE.test(inp.approvalRef) || !INTENT_RE.test(inp.intentId) || !/^[1-9][0-9]{0,6}$/.test(inp.expectedVersion) || isoMs(inp.notBefore) === null || !PI_RE.test(inp.paymentIntentId)
        || !RID_RE.test(inp.reservationId) || !CHARGE_RE.test(inp.chargeId) || !OCH_RE.test(inp.offlineChargeId) || inp.offlineChargeId === inp.reservationId || !/^[1-9][0-9]{0,7}$/.test(inp.capturedMinor)
        || !realDate(inp.from) || !realDate(inp.to) || !/^[1-9][0-9]?$/.test(inp.guests) || !UUID_RE.test(inp.attemptId) || !SESSION_RE.test(inp.sessionId))) refuse("HRT_INPUT_INVALID");
    if (inp.approvalRef === c.synthetic.approvalRef || inp.intentId === c.synthetic.intentId) refuse("HRT_INPUT_INVALID");
    if (mode !== "preflight") {
      if (c.executeEnabled !== true || c.toolingStatus !== "MERGED" || !HEX64.test(String(c.closureDigest))) refuse("HRT_EXECUTE_CLOSED");   // Slice 5: CLOSED
      if (!anyReal || !HEX64.test(expPlan) || !HEX64.test(expClo) || !HEX64.test(expRun)) refuse("HRT_INPUT_INCOMPLETE");
      if (!RUN_ID_RE.test(runId)) refuse("HRT_INPUT_INVALID");
      if (env.GITHUB_REF !== "refs/heads/main") refuse("HRT_REF_NOT_MAIN");
      if (expClo !== c.closureDigest) refuse("HRT_SOURCE_MISMATCH");
    }
    const tooling = await realpath(env.E7_TOOLING_DIR ?? "").catch(() => refuse("HRT_LAYOUT_INVALID"));
    const wdir = await realpath(wrapperDir).catch(() => refuse("HRT_LAYOUT_INVALID"));
    if (tooling === wdir || tooling.startsWith(`${wdir}/`) || wdir.startsWith(`${tooling}/`)) refuse("HRT_LAYOUT_INVALID");
    r.closureDigest = await framedDigest(tooling, c.closure, CLOSURE_DIGEST_PREFIX).catch(() => refuse("HRT_SOURCE_UNREADABLE"));
    if (r.closureDigest !== c.closureDigest) refuse("HRT_SOURCE_MISMATCH");
    r.runnerDigest = await framedDigest(wdir, c.runnerFiles, RUNNER_DIGEST_PREFIX).catch(() => refuse("HRT_SOURCE_UNREADABLE"));
    if (mode !== "preflight" && r.runnerDigest !== expRun) refuse("HRT_RUNNER_MISMATCH");
    r.planKind = anyReal ? "REAL" : "SYNTHETIC";
    const s = c.synthetic;
    const built = buildPlan(c, anyReal ? { ...inp, expectedVersion: Number(inp.expectedVersion), capturedMinor: Number(inp.capturedMinor), guests: Number(inp.guests), runnerDigest: r.runnerDigest }
      : { ...s, runnerDigest: r.runnerDigest });
    r.planHash = built.planHash;
    if (mode !== "preflight") { if (built.planHash !== expPlan) refuse("HRT_PLAN_HASH_MISMATCH"); r.runId = runId; }
    let C1; try { C1 = await importEnv(tooling); } catch { refuse("HRT_IMPORT_FAILED"); }
    const present = Object.fromEntries(C1.PRESENT_KEYS.map((k) => [k, Object.hasOwn(env, k)]));
    let uid = null; try { if (typeof proc.getuid === "function") { const u = proc.getuid(); if (Number.isSafeInteger(u) && u >= 0) uid = u; } } catch { uid = null; }
    const ev = C1.evaluateProbeEnvironment({ schema: C1.ENV_SNAPSHOT_SCHEMA, nodeVersion: String(proc.versions.node), platform: proc.platform,
      execArgvCount: proc.execArgv.length, uidAvailable: uid !== null, present });
    r.envCode = typeof ev.code === "string" && C1.ENV_CODES.includes(ev.code) ? ev.code : "REDACTED";
    if (ev.ok !== true || proc.versions.node !== c.nodeVersion) refuse("HRT_ENV_REFUSED");
    if (mode === "preflight") {
      const o = await spawnChild(["--test", "--test-reporter=tap", TEST_FILE], { cwd: wdir, env: childEnv(env, tooling) });
      if (!o || o.spawnFailed || (o.signal !== null && o.signal !== undefined) || !Number.isSafeInteger(o.status) || o.truncated) refuse("HRT_CHILD_FAILED");
      const num = (re) => { const m = re.exec(o.stdout); return m ? Number(m[1]) : null; };
      r.tests = { status: o.status, tests: num(/^# tests (\d+)$/m), pass: num(/^# pass (\d+)$/m), fail: num(/^# fail (\d+)$/m), connectivityEvidence: false };
      if (o.status !== 0 || !(r.tests.tests > 0) || r.tests.pass !== r.tests.tests || r.tests.fail !== 0) refuse("HRT_TESTS_FAILED");
      r.code = anyReal ? "PREFLIGHT_OK_REAL_PLAN" : "PREFLIGHT_OK_SYNTHETIC_ONLY"; return { exitCode: 0, result: r };
    }
    if (mode === "verify") { r.code = "VERIFY_OK"; return { exitCode: 0, result: r }; }
    if (!SECRET_KEYS.every(has)) refuse("HRT_CREDENTIALS_MISSING");
    let pgv; try { pgv = await readPgVersion(tooling); } catch { pgv = null; }
    if (pgv !== c.pgVersion) refuse("HRT_DEPENDENCY_MISMATCH");
    let skey = env.E7_STRIPE_TEST_KEY; delete env.E7_STRIPE_TEST_KEY;
    let htok = env.E7_HOSTAWAY_TOKEN; delete env.E7_HOSTAWAY_TOKEN;
    let dbUrl = env.E7_DEV_BOOKING_DATABASE_URL; delete env.E7_DEV_BOOKING_DATABASE_URL;
    const wipe = () => { skey = null; htok = null; dbUrl = null; };
    if (!dbTargetOk(dbUrl, c)) { wipe(); refuse("HRT_DB_TARGET_INVALID"); }
    let caPem = null;
    try { const b = await readCa(env.E7_CA_FILE ?? ""); if (sha(b) === (deps.caSha256 ?? OFFICIAL_CA_SHA256) && b.length < 16384) caPem = b.toString("utf8"); } catch { caPem = null; }
    if (caPem === null) { wipe(); refuse("HRT_CA_INVALID"); }
    let mods; try { mods = await importTooling(tooling); } catch { wipe(); refuse("HRT_IMPORT_FAILED"); }
    const xs = mods.X.createE7RealExchange({ provider: "stripe" }); const xh = mods.X.createE7RealExchange({ provider: "hostaway" });
    if (!xs || xs.ok !== true || !xh || xh.ok !== true) { wipe(); refuse("HRT_IMPORT_FAILED"); }
    let lockUrl = sessionLockUrl(dbUrl, c);
    if (lockUrl === null) { wipe(); refuse("HRT_DB_TARGET_INVALID"); }
    try {
      pool = mods.createBookingPool({ connectionString: dbUrl, caPem, max: 3 });                      // worker pool: transaction pooler (6543)
      lockPool = mods.createBookingPool({ connectionString: lockUrl, caPem, max: 1 });                // dedicated SESSION lock connection (5432)
    } catch { wipe(); refuse("HRT_DB_TARGET_INVALID"); } finally { dbUrl = null; lockUrl = null; }
    r.lockEndpoint = `session:${SESSION_LOCK_PORT}`;
    const ac = new AbortController(); const onSig = () => ac.abort(); proc.once?.("SIGINT", onSig); proc.once?.("SIGTERM", onSig);
    try {
      r.core = await runCore({ plan: built.plan, planHash: built.planHash, runId, pool, lockClientFactory: () => lockPool.connect(), tooling: mods.tooling, exchanges: { stripe: xs.exchange, hostaway: xh.exchange },
        credentials: { stripe: () => skey, hostaway: () => htok }, runSignal: ac.signal });
    } finally { wipe(); proc.off?.("SIGINT", onSig); proc.off?.("SIGTERM", onSig); }
    r.code = "EXECUTE_DONE";
    return { exitCode: r.core && r.core.outcome === "RECORDED_CLEANUP_COMPLETED" ? 0 : 1, result: r };
  } catch (e) {
    r.code = e instanceof Refusal && HOSTED_CODES.includes(e.code) ? e.code : "HRT_INTERNAL";
    return { exitCode: 1, result: r };
  } finally {
    if (lockPool) await lockPool.end().catch(() => {});
    if (pool) await pool.end().catch(() => {});
  }
}
async function defaultImportTooling(dir) {
  const u = (p) => pathToFileURL(`${dir}/${p}`).href;
  const [W, MW, TR, R, EX, MT, TT, T, X, P, HR, CP, RP, TP, CO, IS, MP, OP, LK] = await Promise.all([import(u("lib/booking-db/cleanup-worker.js")), import(u("lib/booking-db/mirror-worker.js")),
    import(u("lib/booking-db/test-cleanup-recorded.js")), import(u("lib/booking-db/repo.js")), import(u("scripts/e7-connected/test-cleanup-executors.mjs")), import(u("lib/booking-db/mirror-transport.js")),
    import(u("scripts/e7-connected/test-cleanup-transports.mjs")), import(u("scripts/e7-connected/http-transports.mjs")), import(u("scripts/e7-connected/real-exchange.mjs")), import(u("lib/booking-db/pool.js")),
    import(u("lib/hostaway-reservations.js")), import(u("lib/checkout/capture-proof.js")), import(u("lib/checkout/recovery-plan.js")), import(u("lib/checkout/test-cleanup-proof.js")),
    import(u("lib/checkout/compensation-proof.js")), import(u("lib/checkout/intent-state.js")), import(u("lib/checkout/mirror-proof.js")), import(u("lib/checkout/offline-charge-proof.js")),
    import(u("scripts/e7-connected/run-lock-precheck.mjs"))]);
  return { X, createBookingPool: P.createBookingPool,
    tooling: { runTestCleanupStep: W.runTestCleanupStep, runMirrorStep: MW.runMirrorStep, requestRecordedTestCleanup: TR.requestRecordedTestCleanup, loadIntent: R.loadIntent,
      createTestCleanupExecutors: EX.createTestCleanupExecutors, buildHostawayMirrorExecutors: MT.buildHostawayMirrorExecutors, createStripeSend: TT.createE7StripeTestCleanupSend,
      createHostawaySend: T.createE7HostawaySend, validateAdapterConfig: HR.validateAdapterConfig, unwrapEnvelope: HR.unwrapEnvelope, normalizeReservation: HR.normalizeReservation,
      activeReservationProof: CO.activeReservationProof, paymentIntentProofObservationV3: CP.paymentIntentProofObservationV3, piIdentityOk: RP.piIdentityOk, rawPiPreSendRefusal: TP.rawPiPreSendRefusal,
      refundObservation: TP.refundObservation, arrivalStrictlyFuture: CO.arrivalStrictlyFuture, refundKey: IS.refundKey, publicStatus: IS.publicStatus, mirrorTitle: MP.mirrorTitle,
      classifyTitle: OP.classifyTitle, classifyMirrorTitle: MP.classifyMirrorTitle, providerIdToCanonical: OP.providerIdToCanonical, amountToMinor: HR.amountToMinor,
      LOCK_KEY: LK.LOCK_KEY, LOCK_PRECHECK_SQL: LK.LOCK_PRECHECK_SQL } };
}
export function summaryMarkdown(r) {
  const core = r.core ? ` core=${r.core.outcome}${r.core.code ? `/${r.core.code}` : ""} request=${r.core.requestInvocations}/${r.core.requestOutcome} steps=${r.core.steps}(c${r.core.cleanupSteps}/m${r.core.mirrorSteps}) cancel=${r.core.cancelInvocations}/${r.core.cancelOutcome} refund=${r.core.refundInvocations}/${r.core.refundOutcome} mirror=${r.core.mirrorInvocations}/${r.core.mirrorOutcome} lock=${r.core.lock} publicStatus=${r.core.publicStatus}` : "";
  return `e7-hosted-recorded-cleanup ${r.mode} ${r.code} executeEnabled=${r.executeEnabled} lock=${r.lockEndpoint ?? "-"} plan=${r.planKind ?? "-"}:${r.planHash ?? "-"} runId=${r.runId ?? "-"} closure=${r.closureDigest ?? "-"} runner=${r.runnerDigest ?? "-"}${core}\n`;
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
