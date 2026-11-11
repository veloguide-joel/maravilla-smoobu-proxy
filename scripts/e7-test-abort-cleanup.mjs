// scripts/e7-test-abort-cleanup.mjs — E7 RUNNER A (DRAFT, OFFLINE): ONE intentional TEST abort of ONE confirmed, never-captured TEST
// reservation, then the accepted two-leg cleanup (Hostaway cancel <= 1, Stripe void <= 1) on the TEST DEV database.
// OFFLINE slice: code is NOT consent. Nothing here authorizes a dispatch, a DB connection or a provider request.
//   * EXECUTE IS CLOSED IN CODE: CONSTANTS.executeEnabled === false. verify / execute refuse ATC_EXECUTE_CLOSED until a separately reviewed
//     change opens it (and Joel approves the exact filled package). Tooling = the MERGED guard commit bf44bf0d (PR #53, e7-test).
//   * Inert on import (`import.meta.main` guard): no env / fs / network / DB / timer until a mode runs.
//   * Reuses the accepted lineage at ONE fixed tooling commit (checked out separately): executeOperatorAbort (-> requestTestAbort, ONE call),
//     runCleanupStep, createPhaseExecutors('cleanup'), createE7HostawaySend, createE7StripeTestSend, createE7RealExchange, pool, repo,
//     intent-state keys, normalizeReservation. Its full transitive closure (+ package.json / lock) is digest-verified BEFORE any tooling import.
//   * Exact pins (plan hash): approval label, intent UUID, PaymentIntent, Hostaway reservation id, the intent's expected version; fixed listing
//     606998 USD, Stripe account, Stripe-Version, DEV project ref. Every other expectation field is read from the DB and CROSS-CHECKED against
//     fresh provider proofs (Stripe PI + Hostaway reservation by id) BEFORE the abort and again BEFORE the first cleanup send.
//   * Flow: precheck (read-only) -> fresh proofs -> ONE abort invocation -> verified capture_failed / TEST_ABORT_REQUESTED lineage -> fresh
//     proofs -> bounded runCleanupStep -> full postcheck (both settlement legs, both ops, claim released, capture never dispatched) + fresh
//     provider readback (PI canceled, reservation cancelled).
//   * Transport fence (target-only): Hostaway GET /v1/reservations/<rid>, the accepted by-ref lookup page for THIS listing / arrival date
//     (exact parameter set, page budget), and ONE PUT /v1/reservations/<rid>/statuses/cancelled; Stripe GET account, GET the bound PI, ONE
//     POST cancel of the bound PI with the E3 void key. Everything else is refused before bytes leave.
//   * PI proofs are the ACCEPTED v3 proofs of the pinned tooling (stillAuthorizedV3Refusal before, piCanceledProofV3 after). A reservation
//     whose by-id read does not echo the booking ref is accepted ONLY when the read-only by-ref lookup finds exactly it (else refused BEFORE
//     the abort: a cleanup the worker cannot prove is never queued).
//   * DB budget: every statement on the one counted pool (runner reads + operator abort + worker), pinned ceiling from the PG integration.
//     No capture, refund, create, record, notify; no account / key change. Finite run time, step, read and exchange budgets.
//   * STOP on: refusal, escalation, any uncertain write (abort / cancel / void), DB error, scope drift, budget, deadline, cancellation.
//     No retry, no rerun, no new key. Output: whitelisted codes / counts / states / flags only.
import process from "node:process";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath, appendFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

// measured on disposable PG16 with the REAL operator + worker (test I1): 240 (ref echoed) / 272 (ref not echoed + lookups) statements for a 2-step
// happy path; ceiling = ~2.2x the larger, leaving room for the worker's idle / retry steps inside the 8-step cap. Fail-closed past it.
const DB_QUERY_CEILING = 600;
export const CONSTANTS = Object.freeze({
  // the MERGED guard (PR #53 merge bf44bf0d on e7-test; tree bf67c761 = reviewed ae2b7cc2: d06b9250 guard + ROOT stager fix outside this closure)
  toolingCommit: "bf44bf0da9b0f7b3fdf8dfbcfdb7136b36ad05df",
  toolingStatus: "MERGED",
  executeEnabled: false,
  closure: Object.freeze(["package.json", "package-lock.json",
    "lib/bookability.js", "lib/booking-db/codec.js", "lib/booking-db/compensation-worker.js", "lib/booking-db/config.js", "lib/booking-db/operations.js",
    "lib/booking-db/pool.js", "lib/booking-db/recovery.js", "lib/booking-db/repo.js", "lib/booking-db/reservation-worker.js", "lib/booking-db/test-abort.js",
    "lib/checkout/capture-proof.js", "lib/checkout/compensation-proof.js", "lib/checkout/final-price.js", "lib/checkout/intent-state.js",
    "lib/checkout/offline-charge-proof.js", "lib/checkout/recovery-plan.js", "lib/checkout/server-pricer.js", "lib/direct-policy.js", "lib/direct-pricing.js",
    "lib/hostaway-calendar.js", "lib/hostaway-reservations.js", "lib/hostaway.js", "lib/public-api.js", "lib/quote-public.js",
    "scripts/e7-connected/executor-adapters.mjs", "scripts/e7-connected/http-transports.mjs", "scripts/e7-connected/probe-env-preflight.mjs",
    "scripts/e7-connected/real-exchange.mjs", "scripts/e7-operator/test-abort.mjs"]),
  // framed SHA-256 of `closure` at bf44bf0d (test C2 recomputes it; byte-identical at d06b9250 / ae2b7cc2: the stager files are outside it)
  closureDigest: "90f4d544a30a9d004f9dfbf9e811b31e58f5b7373503687f6b5941a8f347e188",
  pgVersion: "8.18.0",
  runnerFiles: Object.freeze(["scripts/e7-test-abort-cleanup.mjs", ".github/workflows/e7-test-abort-cleanup.yml", "test/e7-test-abort-cleanup.test.mjs"]),
  accountId: "acct_1TyHE42B9LTneQgw",
  listingId: 606998, currency: "USD", refFieldId: 105433, listingTimeZone: "America/Mexico_City",
  stripeVersion: "2026-01-28.clover",
  protectedReservationIds: Object.freeze(["70636076", "71045356", "71072615", "71081885"]),
  // dbQueries = EVERY statement on the runner's pool: pool.query + every connected-client query (runner reads, the operator abort, the worker,
  // BEGIN / COMMIT / ROLLBACK included), counted once at that boundary. Ceiling evidenced by the disposable-PG integration (test I1 prints it).
  // provider read ceilings: 3 runner proof rounds (before abort / before cleanup / readback) + the worker's per-step reads over <= 8 steps;
  // lookups: <= 5 pages per lookupByRef, <= 3 runner + <= 2 worker lookups. Measured happy paths are printed by integration test I1.
  budgets: Object.freeze({ steps: 8, abort: 1, hostawayCancel: 1, stripeCancel: 1, hostawayReads: 12, lookupPages: 25, accountReads: 12, piReads: 16, exchanges: 64,
    dbQueries: DB_QUERY_CEILING, runMs: 10 * 60 * 1000, waitCapMs: 35 * 1000 }),
  dbEnvironment: "test", dbProjectRef: "mxotevtiscernhqilyiu",
  nodeVersion: "22.22.0",
  synthetic: Object.freeze({ approvalRef: "SYNTHETIC-preflight-not-for-execute", intentId: "00000000-0000-4000-8000-000000000000",
    paymentIntentId: "pi_SYNTHETICnotForExecute0", reservationId: "1", expectedVersion: 1 })
});
export const PLAN_SCHEMA = "e7-test-abort-cleanup-plan-v2";
export const RESULT_SCHEMA = "e7-test-abort-cleanup-result-v1";
export const OUTCOMES = Object.freeze(["CLEANED", "SCOPE_REFUSED", "START_STATE_NOT_ELIGIBLE", "PROVIDER_PROOF_FAILED", "ABORT_REFUSED",
  "ABORT_OUTCOME_UNKNOWN", "ABORT_POSTCHECK_MISMATCH", "WORKER_REFUSED", "ESCALATED", "HOSTAWAY_CANCEL_OUTCOME_UNKNOWN", "VOID_OUTCOME_UNKNOWN",
  "SEND_NOT_SENT", "SECOND_SEND_REFUSED", "BUDGET_EXHAUSTED", "DEADLINE", "ABORTED", "DB_ERROR", "NOT_CLEANED", "CORE_INVALID"]);
export const HOSTED_CODES = Object.freeze(["ATC_USAGE", "ATC_SECRET_SCOPE_VIOLATION", "ATC_INPUT_INVALID", "ATC_INPUT_INCOMPLETE", "ATC_REF_NOT_MAIN",
  "ATC_EXECUTE_CLOSED", "ATC_LAYOUT_INVALID", "ATC_SOURCE_UNREADABLE", "ATC_SOURCE_MISMATCH", "ATC_RUNNER_MISMATCH", "ATC_PLAN_HASH_MISMATCH",
  "ATC_DEPENDENCY_MISMATCH", "ATC_ENV_REFUSED", "ATC_TESTS_FAILED", "ATC_CHILD_FAILED", "ATC_IMPORT_FAILED", "ATC_CREDENTIALS_MISSING",
  "ATC_DB_TARGET_INVALID", "ATC_CA_INVALID", "ATC_INTERNAL", "PREFLIGHT_OK_REAL_PLAN", "PREFLIGHT_OK_SYNTHETIC_ONLY", "VERIFY_OK", "EXECUTE_DONE"]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PI_RE = /^pi_[A-Za-z0-9]{8,64}$/;
const RID_RE = /^[1-9][0-9]{0,15}$/;
const APPROVAL_RE = /^[A-Za-z0-9._:-]{1,80}$/;
const HEX64 = /^[0-9a-f]{64}$/; const HEX40 = /^[0-9a-f]{40}$/;
const CODE_RE = /^[A-Za-z0-9_:>!.-]{1,80}$/;
const STRIPE = "https://api.stripe.com"; const HOSTAWAY = "https://api.hostaway.com";
const MAX_FILE = 1048576; const MAX_TOTAL = 6291456;
const freeze = Object.freeze;
class Refusal extends Error { constructor(code) { super("e7-test-abort-cleanup"); this.code = code; } }
const refuse = (code) => { throw new Refusal(code); };
const sha = (s) => createHash("sha256").update(s).digest("hex");
function deepFreeze(v) { if (v && typeof v === "object") { for (const k of Object.keys(v)) deepFreeze(v[k]); freeze(v); } return v; }
export function canonical(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
}
const isVersion = (v) => Number.isSafeInteger(v) && v >= 1 && v <= 1000000;

// =================================================================================================================================
// plan (pure)
/** buildPlan(c, { approvalRef, intentId, paymentIntentId, reservationId, expectedVersion, runnerDigest }) → frozen { plan, planHash } */
export function buildPlan(c, { approvalRef, intentId, paymentIntentId, reservationId, expectedVersion, runnerDigest }) {
  if (typeof approvalRef !== "string" || !APPROVAL_RE.test(approvalRef)) refuse("ATC_INPUT_INVALID");
  if (typeof intentId !== "string" || !UUID_RE.test(intentId) || typeof paymentIntentId !== "string" || !PI_RE.test(paymentIntentId)) refuse("ATC_INPUT_INVALID");
  if (typeof reservationId !== "string" || !RID_RE.test(reservationId) || c.protectedReservationIds.includes(reservationId)) refuse("ATC_INPUT_INVALID");
  if (!isVersion(expectedVersion)) refuse("ATC_INPUT_INVALID");
  if (c.accountId !== "acct_1TyHE42B9LTneQgw" || c.listingId !== 606998 || c.currency !== "USD" || c.stripeVersion !== "2026-01-28.clover" || c.dbEnvironment !== "test"
      || c.budgets.abort !== 1 || c.budgets.hostawayCancel !== 1 || c.budgets.stripeCancel !== 1 || c.budgets.steps !== 8) refuse("ATC_INPUT_INVALID");   // code ceiling
  const plan = { schema: PLAN_SCHEMA, toolingCommit: c.toolingCommit, toolingStatus: c.toolingStatus, closureDigest: c.closureDigest, runnerDigest,
    pgVersion: c.pgVersion, stripeVersion: c.stripeVersion, accountId: c.accountId, listingId: c.listingId, currency: c.currency, refFieldId: c.refFieldId,
    dbEnvironment: c.dbEnvironment, dbProjectRef: c.dbProjectRef, intentId, paymentIntentId, reservationId, expectedVersion, approvalRef, budgets: { ...c.budgets },
    operations: ["db.test_abort<=1", "hostaway.get_reservation(rid)", "hostaway.lookup_by_ref(606998,arrival)", "hostaway.cancel_reservation(rid)<=1", "stripe.accounts.retrieve", "stripe.paymentIntents.retrieve(pi)",
      "stripe.paymentIntents.cancel(pi)<=1"],
    writes: { abortEvent: 1, hostawayCancelMax: 1, stripeCancelMax: 1, capture: 0, refund: 0, create: 0, record: 0, notify: 0, account: 0, keys: 0 } };
  return freeze({ plan: deepFreeze(plan), planHash: sha(canonical(plan)) });
}

// =================================================================================================================================
// DB reads (read-only SELECTs through the runtime login; no transaction is held across a provider call)
const Q = freeze({
  instance: "/*e7atc:instance*/ SELECT environment FROM booking.instance",
  transitions: "/*e7atc:transitions*/ SELECT version_after, from_state, to_state, event_type, event_id, reason_code FROM booking.intent_transitions WHERE intent_id = $1 ORDER BY version_after",
  attempts: "/*e7atc:attempts*/ SELECT id::text AS id, status, checkout_session_id, payment_intent_id, livemode FROM booking.payment_attempts WHERE intent_id = $1 ORDER BY attempt",
  hostaway: "/*e7atc:hostaway*/ SELECT state, hostaway_reservation_id::text AS rid FROM booking.hostaway_reservation_attempts WHERE intent_id = $1",
  ops: "/*e7atc:ops*/ SELECT op_type, state, attempts, (dispatched_at IS NOT NULL) AS dispatched, payload ->> 'providerIdempotencyKey' AS provider_key, payload ->> 'paymentIntentId' AS payload_pi FROM booking.external_operations WHERE intent_id = $1 ORDER BY created_at, id",
  cases: "/*e7atc:cases*/ SELECT count(*)::int AS n FROM booking.reconciliation_cases WHERE intent_id = $1 AND status = 'open'",
  claims: "/*e7atc:claims*/ SELECT listing_id, (released_at IS NOT NULL) AS released FROM booking.inventory_claims WHERE intent_id = $1",
  legs: "/*e7atc:legs*/ SELECT settlement_reservation_cancelled AS c, settlement_authorization_settled AS a FROM booking.intents WHERE id = $1"
});
export const QUERIES = Q;
/** op types a start-eligible confirmed TEST reservation may carry (the in-transaction guard of requestTestAbort stays authoritative) */
const START_OPS = freeze(["stripe.create_checkout_session", "stripe.retrieve_checkout_session", "stripe.retrieve_payment_intent", "hostaway.create_reservation",
  "hostaway.lookup_reservation", "hostaway.retrieve_reservation", "stripe.capture_payment_intent"]);
const AFTER_ABORT_OPS = freeze([...START_OPS, "hostaway.cancel_reservation", "stripe.void_payment_intent", "alert.owner"]);
/** the terminal E3 transition (-> cancelled) QUEUES one guest.notify row (intent-state.js: not_completed_not_charged); the runner never sends it */
const POST_CLEANUP_OPS = freeze([...AFTER_ABORT_OPS, "guest.notify"]);
const one = (rows, t) => rows.filter((o) => o.op_type === t);
const pristine = (o) => o && o.state === "pending" && o.attempts === 0 && o.dispatched === false;

/** readFacts(q, plan, tooling) → raw read set (every query counted / stop-guarded by q) */
async function readFacts(q, plan, tooling) {
  const inst = await q(Q.instance, []);
  const intent = await q.loadIntent(plan.intentId);
  return { inst, intent, tr: await q(Q.transitions), at: await q(Q.attempts), hx: await q(Q.hostaway), ops: await q(Q.ops), cases: await q(Q.cases),
    claims: await q(Q.claims), legs: await q(Q.legs), tooling };
}
/** start eligibility → { ok:false, code } | { ok:true, intent, attemptId } */
export function checkStart(f, plan, c = CONSTANTS) {
  const no = (code) => ({ ok: false, code });
  if (f.inst.length !== 1 || f.inst[0].environment !== plan.dbEnvironment) return no("DB_NOT_TEST");
  const i = f.intent;
  if (!i || i.id !== plan.intentId) return no("INTENT_NOT_FOUND");
  if (i.listingId !== c.listingId || !i.price || i.price.currency !== c.currency) return no("LISTING_SCOPE");
  const p = i.payment;
  if (!p || p.paymentIntentId !== plan.paymentIntentId || p.livemode !== false || p.capturedMinor !== 0 || !(p.amountMinor > 0) || p.currency !== c.currency) return no("PAYMENT_SCOPE");
  if (!i.reservation || String(i.reservation.reservationId) !== plan.reservationId || c.protectedReservationIds.includes(plan.reservationId)) return no("RESERVATION_SCOPE");
  if (!i.checkout || typeof i.checkout.sessionId !== "string" || typeof i.ref !== "string") return no("SESSION_UNBOUND");
  if (f.tr.some((t) => t.event_type === "TEST_ABORT_REQUESTED")) return no("ABORT_ALREADY_APPLIED");
  if (i.status !== "reservation_confirmed") return no("STATE_NOT_CONFIRMED");
  if (i.version !== plan.expectedVersion) return no("VERSION_NOT_PINNED");
  if (f.tr.length === 0 || f.tr[f.tr.length - 1].to_state !== i.status || f.tr[f.tr.length - 1].version_after !== i.version) return no("LINEAGE_INCONSISTENT");
  const done = f.at.filter((a) => a.status === "completed");
  if (f.at.length !== 1 || done.length !== 1 || done[0].payment_intent_id !== p.paymentIntentId || done[0].checkout_session_id !== i.checkout.sessionId || done[0].livemode !== false) return no("ATTEMPT_NOT_BOUND");
  if (f.hx.length !== 1 || f.hx[0].rid !== plan.reservationId || !["succeeded", "reconciled_found"].includes(f.hx[0].state)) return no("RESERVATION_HISTORY");
  if (f.cases[0].n !== 0) return no("OPEN_CASE");
  if (f.ops.some((o) => !START_OPS.includes(o.op_type))) return no("OPERATION_HISTORY");
  const caps = one(f.ops, "stripe.capture_payment_intent"); const creates = one(f.ops, "hostaway.create_reservation");
  if (caps.length !== 1 || !pristine(caps[0])) return no("CAPTURE_NOT_PRISTINE");
  if (creates.length !== 1 || creates[0].state !== "succeeded") return no("CREATE_HISTORY");
  if (f.claims.length !== 1 || f.claims[0].listing_id !== c.listingId || f.claims[0].released !== false) return no("CLAIM_UNEXPECTED");
  // accepted state machine: both settlement legs are NULL (not yet opened) before the abort; any other pair is refused
  if (f.legs.length !== 1 || f.legs[0].c !== null || f.legs[0].a !== null) return no("LEGS_UNEXPECTED");
  return { ok: true, intent: i, attemptId: done[0].id };
}
/** the verified post-abort lineage (capture_failed / TEST_ABORT_REQUESTED, both legs pending pristine, capture untouched, claim held) */
export function checkAborted(f, plan, tooling, c = CONSTANTS) {
  const i = f.intent; const no = (code) => ({ ok: false, code });
  if (!i || i.status !== "capture_failed" || i.reasonCode !== "TEST_ABORT_REQUESTED" || i.version !== plan.expectedVersion + 1) return no("STATE");
  const last = f.tr[f.tr.length - 1];
  if (!last || last.event_type !== "TEST_ABORT_REQUESTED" || last.from_state !== "reservation_confirmed" || last.to_state !== "capture_failed"
      || last.reason_code !== "TEST_ABORT_REQUESTED" || last.version_after !== plan.expectedVersion + 1
      || last.event_id !== tooling.testAbortEventId(plan.intentId, plan.paymentIntentId, plan.reservationId)) return no("LINEAGE");
  if (f.tr.filter((t) => t.event_type === "TEST_ABORT_REQUESTED").length !== 1) return no("LINEAGE");
  if (f.ops.some((o) => !AFTER_ABORT_OPS.includes(o.op_type))) return no("OPERATION_HISTORY");
  const cancel = one(f.ops, "hostaway.cancel_reservation"); const voids = one(f.ops, "stripe.void_payment_intent"); const caps = one(f.ops, "stripe.capture_payment_intent");
  if (cancel.length !== 1 || !pristine(cancel[0])) return no("CANCEL_ROW");
  if (voids.length !== 1 || !pristine(voids[0]) || voids[0].provider_key !== tooling.voidKey(plan.intentId, plan.paymentIntentId) || voids[0].payload_pi !== plan.paymentIntentId) return no("VOID_ROW");
  if (caps.length !== 1 || caps[0].dispatched !== false || caps[0].attempts !== 0) return no("CAPTURE_TOUCHED");
  if (f.claims.length !== 1 || f.claims[0].released !== false) return no("CLAIM");
  if (f.hx.length !== 1 || f.hx[0].rid !== plan.reservationId) return no("RESERVATION_HISTORY");
  if (f.legs.length !== 1 || f.legs[0].c !== false || f.legs[0].a !== false) return no("LEGS_NOT_OPEN");   // the abort opens both legs exactly
  return { ok: true };
}
/** full postcheck: both settlement legs, both write ops succeeded, capture never dispatched, claim released */
export function checkCleaned(f, plan) {
  const i = f.intent;
  const cancel = one(f.ops, "hostaway.cancel_reservation"); const voids = one(f.ops, "stripe.void_payment_intent"); const caps = one(f.ops, "stripe.capture_payment_intent");
  const out = { state: i ? i.status : null, legReservationCancelled: f.legs[0] ? f.legs[0].c : null, legAuthorizationSettled: f.legs[0] ? f.legs[0].a : null,
    cancelOp: cancel.length === 1 ? cancel[0].state : "UNEXPECTED", voidOp: voids.length === 1 ? voids[0].state : "UNEXPECTED",
    captureDispatched: caps.length === 1 ? caps[0].dispatched : null, claimReleased: f.claims.length === 1 ? f.claims[0].released : null };
  const queued = f.ops.filter((o) => o.op_type === "guest.notify" || o.op_type === "alert.owner");
  out.notificationsQueuedOnly = queued.every(pristine);
  out.guestNotifyQueued = one(f.ops, "guest.notify").length;
  out.ok = out.state === "cancelled" && out.legReservationCancelled === true && out.legAuthorizationSettled === true && out.cancelOp === "succeeded"
    && out.voidOp === "succeeded" && out.captureDispatched === false && out.claimReleased === true && out.notificationsQueuedOnly === true
    && out.guestNotifyQueued <= 1 && f.ops.every((o) => POST_CLEANUP_OPS.includes(o.op_type));
  return freeze(out);
}

// =================================================================================================================================
// fresh provider proofs (pure checks over normalized replies)
/** Stripe PI through the ACCEPTED v3 proofs of the pinned tooling (no looser runner-local predicate):
 *  before = stillAuthorizedV3Refusal (identity incl. metadata intent + attempt, manual, amount = price, requires_capture, received 0,
 *  capturable full, expanded TEST charge bound to the PI, succeeded, paid, uncaptured, amount, captured 0, refunded 0, currency, capture_before);
 *  after = piCanceledProofV3 (canceled, received 0, capturable 0, expanded bound TEST charge uncaptured / captured 0 / refunded 0, freshness). */
export function piProof(pi, { tooling, intent, attemptId, phase, now, notBefore, accountVerified }) {
  const observed = tooling.paymentIntentProofObservationV3(pi, { accountVerified: accountVerified === true });
  const ev = { id: "runner-readback", kind: "payment_intent", readOpType: "stripe.retrieve_payment_intent", requestRef: intent.payment.paymentIntentId,
    externalRef: intent.payment.paymentIntentId, status: observed.status, observed, observedAt: now };
  const code = phase === "before" ? tooling.stillAuthorizedV3Refusal(ev, intent, attemptId) : tooling.piCanceledProofV3(ev, intent, attemptId, { now, notBefore });
  return code === null ? null : `PI_${String(code).slice(0, 60)}`;
}
/** Hostaway reservation by id: same id / listing / stay / total / currency / channel; active (before) or cancelled (after); ref absent or ours.
 *  An ABSENT ref is only accepted together with a by-ref lookup that finds exactly this reservation (refProof below), never alone. */
export function reservationProof(res, plan, intent, phase) {
  if (!res || String(res.reservationId) !== plan.reservationId || res.listingId !== plan.listingId || res.from !== intent.from || res.to !== intent.to) return "RES_IDENTITY";
  if (res.totalMinor !== intent.price.finalTotalMinor || res.currency !== plan.currency || res.channelId !== 2000) return "RES_AMOUNT";
  if (!(res.bookingRef === null || res.bookingRef === intent.ref)) return "RES_REF";
  if (phase === "before") return res.status === "new" ? null : "RES_NOT_ACTIVE";       // = compensation-proof ACTIVE_RESERVATION_STATUS
  return res.status === "cancelled" ? null : "RES_NOT_CANCELLED";
}

// =================================================================================================================================
// core (injected; no native I/O of its own)
/**
 * runAbortCleanupCore({ plan, pool, tooling, exchanges:{ stripe, hostaway }, credentials:{ stripe, hostaway }, clock?, monotonic?, sleep?, runSignal?,
 *   workerTimeouts? }) → frozen result. Never throws.
 *   tooling = { executeOperatorAbort, buildAbortExpectation, runCleanupStep, loadIntent, voidKey, testAbortEventId, createPhaseExecutors,
 *     createStripeSend, createHostawaySend, validateAdapterConfig, unwrapEnvelope, normalizeReservation, lookupByRef,
 *     paymentIntentProofObservationV3, stillAuthorizedV3Refusal, piCanceledProofV3 }
 *   The operator abort, the worker and the runner's own reads ALL receive the same counted pool (countedPool below).
 */
export async function runAbortCleanupCore(input) {
  const c = CONSTANTS; const B = c.budgets;
  const r = { schema: RESULT_SCHEMA, outcome: null, code: null, startState: null, finalState: null, abortInvocations: 0, abortOutcome: null, steps: 0, actions: [],
    exchanges: 0, hostawayReads: 0, lookupPages: 0, accountReads: 0, piReads: 0, dbQueries: 0, dbBudgetRefused: 0, hostawayCancelInvocations: 0, hostawayCancelOutcome: "NONE",
    stripeCancelInvocations: 0, stripeCancelOutcome: "NONE", refusedAtTransport: 0, refusedByStop: 0, proofs: [], postcheck: null, providerReadback: null,
    stopReason: null, stripeVersion: c.stripeVersion, writes: { capture: 0, refund: 0, create: 0, record: 0, notify: 0 } };
  const done = (outcome, code = null) => { r.outcome = outcome; r.code = code; return freeze(JSON.parse(JSON.stringify(r))); };
  let stopReason = null; let runSignalRef = null; let monoRef = null; let endsAtRef = Infinity;
  const stopped = () => {
    if (stopReason === null) {
      if (runSignalRef && runSignalRef.aborted) stopReason = "ABORTED";
      else if (monoRef && monoRef() >= endsAtRef) stopReason = "DEADLINE";
      if (stopReason !== null) r.stopReason = stopReason;
    }
    return stopReason;
  };
  class Stopped extends Error { constructor() { super("stopped"); } }
  const guard = () => { if (stopped()) throw new Stopped(); };
  const uncertain = () => r.abortOutcome === "UNKNOWN" ? "ABORT_OUTCOME_UNKNOWN" : r.hostawayCancelOutcome === "UNKNOWN" ? "HOSTAWAY_CANCEL_OUTCOME_UNKNOWN"
    : r.stripeCancelOutcome === "UNKNOWN" ? "VOID_OUTCOME_UNKNOWN" : null;
  const stopOutcome = () => done(uncertain() ?? stopReason, `STOP_${stopReason}`);
  const failOutcome = (fallback, code) => done(uncertain() ?? fallback, code);
  try {
    const { plan, pool, tooling, exchanges, credentials } = input ?? {};
    if (!plan || plan.schema !== PLAN_SCHEMA || plan.accountId !== c.accountId || plan.listingId !== c.listingId || plan.stripeVersion !== c.stripeVersion
        || !UUID_RE.test(String(plan.intentId)) || !PI_RE.test(String(plan.paymentIntentId)) || !RID_RE.test(String(plan.reservationId)) || !isVersion(plan.expectedVersion)
        || c.protectedReservationIds.includes(String(plan.reservationId)) || plan.intentId === c.synthetic.intentId
        || !pool || typeof pool.query !== "function" || !tooling || !exchanges || typeof exchanges.stripe !== "function" || typeof exchanges.hostaway !== "function"
        || !credentials || typeof credentials.stripe !== "function" || typeof credentials.hostaway !== "function") return done("CORE_INVALID");
    const clock = input.clock ?? (() => Date.now());
    const mono = input.monotonic ?? (() => performance.now());
    const runSignal = input.runSignal ?? null;
    const endsAt = mono() + B.runMs;
    runSignalRef = runSignal; monoRef = mono; endsAtRef = endsAt;
    const sleep = input.sleep ?? ((ms) => new Promise((res) => { const t = setTimeout(res, ms); runSignal?.addEventListener?.("abort", () => { clearTimeout(t); res(); }, { once: true }); }));
    const PI = plan.paymentIntentId; const RID = plan.reservationId;
    if (stopped()) return stopOutcome();

    // ---- ONE counted pool for everything: pool.query AND every connected-client .query (checked-out clients only; the real pool's own
    //      internal connect behind pool.query is not re-counted). Past the ceiling every new statement is refused (fail closed).
    const count = () => { if (r.dbQueries >= B.dbQueries) { r.dbBudgetRefused += 1; throw new Error("db query budget"); } r.dbQueries += 1; };
    const countedPool = new Proxy(pool, { get(tg, k) {
      if (k === "query") return (...a) => { count(); return tg.query(...a); };
      if (k === "connect") return async (...a) => {
        const cl = await tg.connect(...a);
        return new Proxy(cl, { get(ct, ck) {
          if (ck === "query") return (...qa) => { count(); return ct.query(...qa); };
          const v = ct[ck]; return typeof v === "function" ? v.bind(ct) : v; } });
      };
      const v = tg[k]; return typeof v === "function" ? v.bind(tg) : v; } });
    const q = async (sql, args = [plan.intentId]) => { guard(); return (await countedPool.query(sql, args)).rows; };
    q.loadIntent = async (id) => { guard(); return tooling.loadIntent(countedPool, id); };
    const read = async () => readFacts(q, plan, tooling);

    // ---- (1) read-only precheck ----------------------------------------------------------------------------------------------------
    let f;
    try { f = await read(); } catch (e) { return e instanceof Stopped ? stopOutcome() : done("DB_ERROR", "PRECHECK_QUERY_FAILED"); }
    r.startState = f.intent ? f.intent.status : null;
    const st = checkStart(f, plan, c);
    if (!st.ok) return done(["STATE_NOT_CONFIRMED", "VERSION_NOT_PINNED", "ABORT_ALREADY_APPLIED"].includes(st.code) ? "START_STATE_NOT_ELIGIBLE" : "SCOPE_REFUSED", st.code);
    const intent0 = st.intent;
    const voidIdem = tooling.voidKey(plan.intentId, PI);

    // ---- (2) the target-only transport fence: exact requests only, counted before they leave; the stop is re-checked first -------------
    const urls = { account: `${STRIPE}/v1/account`, pi: `${STRIPE}/v1/payment_intents/${PI}?expand%5B%5D=latest_charge`, piCancel: `${STRIPE}/v1/payment_intents/${PI}/cancel`,
      res: `${HOSTAWAY}/v1/reservations/${RID}`, resCancel: `${HOSTAWAY}/v1/reservations/${RID}/statuses/cancelled` };
    const fence = { stripeCancelOpen: false, stripeCancelExchanged: false, hostawayCancelOpen: false, hostawayCancelExchanged: false, secondSend: false };
    const hkeys = (h) => Object.keys(h).sort().join(",");
    const stripeGate = (req) => {
      if (stopped()) { r.refusedByStop += 1; return Promise.reject(new Error("stopped")); }
      if (!req || !req.headers || req.headers["Stripe-Version"] !== c.stripeVersion || r.exchanges >= B.exchanges) { r.refusedAtTransport += 1; return Promise.reject(new Error("gate")); }
      const isGet = req.method === "GET" && req.body === null && hkeys(req.headers) === "Authorization,Stripe-Version";
      const isCancel = req.method === "POST" && req.url === urls.piCancel && req.body === "" && req.headers["Idempotency-Key"] === voidIdem
        && hkeys(req.headers) === "Authorization,Content-Type,Idempotency-Key,Stripe-Version";
      if (isGet && req.url === urls.account && r.accountReads < B.accountReads) r.accountReads += 1;
      else if (isGet && req.url === urls.pi && r.piReads < B.piReads) r.piReads += 1;
      else if (isCancel && fence.stripeCancelOpen) fence.stripeCancelExchanged = true;
      else { r.refusedAtTransport += 1; return Promise.reject(new Error("gate")); }
      r.exchanges += 1;
      return exchanges.stripe(req);
    };
    // the ONE by-ref lookup shape the accepted lookupByRef builds for THIS intent: listing 606998, direct channel, arrival = the bound stay
    // date (start = end), limit 100, includeResources 1, optional positive afterId cursor; nothing else (exact parameter set)
    const isLookupUrl = (url) => {
      let u; try { u = new URL(url); } catch { return false; }
      if (u.origin !== HOSTAWAY || u.pathname !== "/v1/reservations" || u.hash !== "") return false;
      const keys = [...u.searchParams.keys()];
      if (new Set(keys).size !== keys.length) return false;
      const base = ["arrivalEndDate", "arrivalStartDate", "channelId", "includeResources", "limit", "listingId"];
      const sorted = [...keys].sort().join(",");
      if (sorted !== base.join(",") && sorted !== ["afterId", ...base].sort().join(",")) return false;
      const g = (k) => u.searchParams.get(k);
      return g("listingId") === String(plan.listingId) && g("channelId") === "2000" && g("arrivalStartDate") === intent0.from && g("arrivalEndDate") === intent0.from
        && g("limit") === "100" && g("includeResources") === "1" && (!u.searchParams.has("afterId") || RID_RE.test(g("afterId")));
    };
    const hostawayGate = (req) => {
      if (stopped()) { r.refusedByStop += 1; return Promise.reject(new Error("stopped")); }
      if (!req || !req.headers || r.exchanges >= B.exchanges) { r.refusedAtTransport += 1; return Promise.reject(new Error("gate")); }
      const plainGet = req.method === "GET" && req.body === null && hkeys(req.headers) === "Accept,Authorization,Cache-control";
      const isGet = plainGet && req.url === urls.res;
      const isLookup = plainGet && isLookupUrl(req.url);
      const isCancel = req.method === "PUT" && req.url === urls.resCancel && req.body === "{\"cancelledBy\":\"host\"}"
        && hkeys(req.headers) === "Accept,Authorization,Cache-control,Content-Type";
      if (isGet && r.hostawayReads < B.hostawayReads) r.hostawayReads += 1;
      else if (isLookup && r.lookupPages < B.lookupPages) r.lookupPages += 1;
      else if (isCancel && fence.hostawayCancelOpen) fence.hostawayCancelExchanged = true;
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
    const adapterConfig = tooling.validateAdapterConfig({ allowedListingIds: [plan.listingId], refFieldId: c.refFieldId, channelId: 2000, currency: c.currency });

    // ---- fresh provider proof round (reads only; any failure = STOP before the next write) --------------------------------------------
    let abortAt = null;
    const lookupSend = (req, signal) => th.transport.send({ method: req.method, path: `/v1${req.path}`, query: req.query }, { signal });
    const proofRound = async (label, intent, phase) => {
      guard();
      const acct = await ts.transport.send({ op: "accounts.retrieve" }, { signal: composed(null) });
      if (!acct || acct.object !== "account" || acct.id !== c.accountId) return "ACCOUNT";
      guard();
      const pi = await ts.transport.send({ op: "paymentIntents.retrieve", id: PI, params: { expand: ["latest_charge"] } }, { signal: composed(null) });
      const now = clock();
      const pe = piProof(pi, { tooling, intent, attemptId: st.attemptId, phase, now, notBefore: phase === "before" ? now : abortAt, accountVerified: true });
      if (pe) return pe;
      guard();
      const h = await th.transport.send({ method: "GET", path: `/v1/reservations/${RID}`, query: {} }, { signal: composed(null) });
      if (!h || h.httpStatus !== 200) return `RES_HTTP_${h && Number.isSafeInteger(h.httpStatus) ? h.httpStatus : "X"}`;
      let n; try { const u = tooling.unwrapEnvelope(h.json); if (!u || u.ok !== true) return "RES_ENVELOPE"; n = tooling.normalizeReservation(u.result, adapterConfig); } catch { return "RES_MALFORMED"; }
      if (!n || n.ok !== true) return "RES_MALFORMED";
      const re = reservationProof(n.reservation, plan, intent, phase); if (re) return re;
      if (n.reservation.bookingRef === null) {
        // ref NOT echoed by id: the accepted worker needs a unique by-ref match to prove (and later confirm) this reservation. Prove it HERE,
        // read-only, so a cleanup that cannot be completed is never queued; anything but exactly this one reservation refuses.
        guard();
        let lk;
        try {
          lk = await tooling.lookupByRef({ ref: intent.ref, listingId: plan.listingId, arrivalDate: intent.from, departureDate: intent.to }, adapterConfig,
            (req) => lookupSend(req, composed(null)), { maxPages: 5 });
        } catch { lk = { outcome: "error" }; }
        if (stopped()) throw new Stopped();
        if (!lk || lk.outcome !== "found" || String(lk.reservation.reservationId) !== RID) return `REF_UNPROVABLE_${lk && typeof lk.outcome === "string" ? lk.outcome : "error"}`;
        const le = reservationProof({ ...lk.reservation, bookingRef: null }, plan, intent, phase); if (le) return `LOOKUP_${le}`;
      }
      r.proofs.push(label);
      return null;
    };
    const proof = async (label, intent, phase) => {
      try { return await proofRound(label, intent, phase); } catch (e) { if (e instanceof Stopped || stopped()) throw new Stopped(); return "READ_FAILED"; }
    };

    // ---- (3) fresh proofs BEFORE the abort ---------------------------------------------------------------------------------------------
    try { const e = await proof("BEFORE_ABORT", intent0, "before"); if (e) return done("PROVIDER_PROOF_FAILED", `BEFORE_ABORT:${e}`); }
    catch { return stopOutcome(); }

    // ---- (4) the ONE abort invocation (DB-only operator core → requestTestAbort; never retried) ----------------------------------------
    if (stopped()) return stopOutcome();
    const expectation = tooling.buildAbortExpectation({ approvalRef: plan.approvalRef, attemptId: st.attemptId, authorizedMinor: intent0.payment.amountMinor,
      currency: c.currency, expectedVersion: plan.expectedVersion, finalTotalMinor: intent0.price.finalTotalMinor, from: intent0.from, guests: intent0.guests,
      intentId: plan.intentId, listingId: plan.listingId, paymentIntentId: PI, reservationId: RID, sessionId: intent0.checkout.sessionId, to: intent0.to });
    if (!expectation) return done("SCOPE_REFUSED", "EXPECTATION_INVALID");
    let ab;
    r.abortInvocations += 1; abortAt = clock();
    try { ab = await tooling.executeOperatorAbort(countedPool, expectation, { now: clock(), env: { VERCEL_ENV: "development", MV_E7_TEST_ABORT: "enabled" } }); }
    catch { r.abortOutcome = "UNKNOWN"; return done("ABORT_OUTCOME_UNKNOWN", "OPERATOR_THREW"); }
    const ao = ab && typeof ab.outcome === "string" ? ab.outcome : null;
    if (!ab || ab.invocations !== 1 || ao === "REQUEST_OUTCOME_UNKNOWN" || ao === null) { r.abortOutcome = "UNKNOWN"; return done("ABORT_OUTCOME_UNKNOWN", ao); }
    if (ao !== "REQUESTED") { r.abortOutcome = "REFUSED"; return done(ao === "POSTCHECK_MISMATCH" ? "ABORT_POSTCHECK_MISMATCH" : "ABORT_REFUSED", CODE_RE.test(String(ab.code)) ? ab.code : ao); }
    r.abortOutcome = "APPLIED";

    // ---- (5) verified post-abort lineage --------------------------------------------------------------------------------------------
    try { f = await read(); } catch (e) { return e instanceof Stopped ? stopOutcome() : done("DB_ERROR", "ABORT_READBACK_FAILED"); }
    const ck = checkAborted(f, plan, tooling, c);
    if (!ck.ok) return done("ABORT_POSTCHECK_MISMATCH", ck.code);

    // ---- (6) fresh proofs again, immediately before the first cleanup send -------------------------------------------------------------
    try { const e = await proof("BEFORE_CLEANUP", intent0, "before"); if (e) return done("PROVIDER_PROOF_FAILED", `BEFORE_CLEANUP:${e}`); }
    catch { return stopOutcome(); }

    // ---- (7) bounded worker steps for the ONE named intent; ONE send per write leg, counted at the send boundary ----------------------
    let hostawayCancelBudget = B.hostawayCancel; let stripeCancelBudget = B.stripeCancel;
    const stripeSend = async (call, opts) => {
      if (stopped()) { r.refusedByStop += 1; throw new Error("stopped"); }
      const o = { ...(opts && typeof opts === "object" ? opts : {}), signal: composed(opts && opts.signal) };
      if (call && call.op === "paymentIntents.cancel") {
        if (stripeCancelBudget < 1) { r.refusedAtTransport += 1; fence.secondSend = true; throw new Error("cancel budget"); }
        stripeCancelBudget -= 1; r.stripeCancelInvocations += 1; fence.stripeCancelOpen = true;
        try { const out = await ts.transport.send(call, o); r.stripeCancelOutcome = "REPLIED"; return out; }
        catch (e) { r.stripeCancelOutcome = fence.stripeCancelExchanged ? "UNKNOWN" : "NOT_SENT"; throw e; }
        finally { fence.stripeCancelOpen = false; }
      }
      if (call && call.op !== "accounts.retrieve" && call.op !== "paymentIntents.retrieve") { r.refusedAtTransport += 1; throw new Error("op refused"); }
      return ts.transport.send(call, o);
    };
    const hostawaySend = async (req, opts) => {
      if (stopped()) { r.refusedByStop += 1; throw new Error("stopped"); }
      const o = { ...(opts && typeof opts === "object" ? opts : {}), signal: composed(opts && opts.signal) };
      if (req && req.method === "PUT") {
        if (hostawayCancelBudget < 1) { r.refusedAtTransport += 1; fence.secondSend = true; throw new Error("cancel budget"); }
        hostawayCancelBudget -= 1; r.hostawayCancelInvocations += 1; fence.hostawayCancelOpen = true;
        try {
          const out = await th.transport.send(req, o);
          r.hostawayCancelOutcome = out && out.httpStatus >= 200 && out.httpStatus < 300 ? "REPLIED_2XX" : "UNKNOWN";   // a non-2xx reply is not proof either way
          return out;
        } catch (e) { r.hostawayCancelOutcome = fence.hostawayCancelExchanged ? "UNKNOWN" : "NOT_SENT"; throw e; }
        finally { fence.hostawayCancelOpen = false; }
      }
      if (!req || req.method !== "GET") { r.refusedAtTransport += 1; throw new Error("method refused"); }
      return th.transport.send(req, o);
    };
    const bx = tooling.createPhaseExecutors({ phase: "cleanup", binding: { listingId: plan.listingId, arrivalDate: intent0.from, departureDate: intent0.to,
      ref: intent0.ref, reservationId: RID, accountId: c.accountId, paymentIntentId: PI, voidIdempotencyKey: voidIdem }, hostaway: { send: hostawaySend }, stripe: { send: stripeSend } });
    if (!bx || bx.ok !== true) return done("SCOPE_REFUSED", "EXECUTOR_BINDING_REFUSED");
    const executors = {};
    for (const k of Object.keys(bx.executors)) {
      const fn = bx.executors[k];
      executors[k] = async (...args) => { if (stopped()) { r.refusedByStop += 1; throw new Error("stopped"); } return Reflect.apply(fn, undefined, args); };
    }
    freeze(executors);
    const listings = new Map([[plan.listingId, { currency: c.currency, timeZone: c.listingTimeZone }]]);
    const env = { VERCEL_ENV: "development", MV_E7_COMPENSATION_WORKER: "enabled" };
    for (;;) {
      if (stopped()) return stopOutcome();
      if (r.steps >= B.steps) return failOutcome("BUDGET_EXHAUSTED", "STEPS");
      r.steps += 1;
      let res;
      try {
        res = await tooling.runCleanupStep(countedPool, { workerId: `e7-test-abort-cleanup:${r.steps}`, env, adapterConfig, listings, executors, clock,
          stripeAccountId: c.accountId, intentId: plan.intentId, timeouts: input.workerTimeouts });
      } catch { if (stopped()) return stopOutcome(); return failOutcome(r.hostawayCancelInvocations || r.stripeCancelInvocations ? "NOT_CLEANED" : "DB_ERROR", "WORKER_THREW"); }
      for (const a of (res && Array.isArray(res.actions) ? res.actions : [])) r.actions.push(typeof a === "string" && CODE_RE.test(a) ? a : "REDACTED");
      if (r.actions.length > 64) r.actions = r.actions.slice(0, 64);
      if (stopped()) return stopOutcome();
      if (fence.secondSend) return done(uncertain() ?? "SECOND_SEND_REFUSED");
      if (uncertain()) return done(uncertain());
      if (r.hostawayCancelOutcome === "NOT_SENT" || r.stripeCancelOutcome === "NOT_SENT") return done("SEND_NOT_SENT");
      if (!res || res.status === "refused") return done("WORKER_REFUSED", res && CODE_RE.test(String(res.code)) ? res.code : null);
      if (r.actions.some((a) => /OUTCOME_UNKNOWN/.test(a))) return done("ESCALATED", "WORKER_OUTCOME_UNKNOWN");
      if (r.actions.some((a) => a.startsWith("ESCALATE") || a.startsWith("RECOVERY:ESCALATE") || a.startsWith("SEND_ABORTED"))) return done("ESCALATED");
      try { f = await read(); } catch (e) { return e instanceof Stopped ? stopOutcome() : failOutcome("DB_ERROR", "RELOAD_FAILED"); }
      r.finalState = f.intent ? f.intent.status : null;
      if (r.finalState === "cancelled") break;
      if (r.finalState !== "capture_failed") return done("NOT_CLEANED", "STATE_MOVED");
      if (r.steps >= B.steps) return done("BUDGET_EXHAUSTED", "STEPS");
      const wait = Math.min(Number.isFinite(res.delayMs) && res.delayMs >= 0 ? res.delayMs : B.waitCapMs, B.waitCapMs);
      if (mono() + wait >= endsAt) { stopReason = stopReason ?? "DEADLINE"; r.stopReason = stopReason; return stopOutcome(); }
      if (wait > 0) await sleep(wait);
    }

    // ---- (8) full postcheck + fresh provider readback (both legs; nothing claimed after a stop) ----------------------------------------
    r.postcheck = checkCleaned(f, plan);
    if (!r.postcheck.ok) return done("NOT_CLEANED", "POSTCHECK");
    if (r.hostawayCancelInvocations !== 1 || r.stripeCancelInvocations !== 1) return done("NOT_CLEANED", "SEND_COUNT");
    try { const e = await proof("AFTER_CLEANUP", intent0, "after"); r.providerReadback = e ?? "OK"; if (e) return done("NOT_CLEANED", `READBACK:${e}`); }
    catch { return stopOutcome(); }
    return done("CLEANED", "POSTCHECK_AND_READBACK");
  } catch {
    if (stopReason) return stopOutcome();
    return failOutcome("CORE_INVALID", "UNEXPECTED");
  }
}

// =================================================================================================================================
// hosted wiring (gated; real fs / child / DB / native https only inside runHosted with the real deps)
export async function framedDigest(dir, files, prefix) {
  const h = createHash("sha256"); h.update(prefix); let total = 0;
  for (const rel of files) {
    const p = `${dir}/${rel}`; const st = await lstat(p);
    if (!st.isFile() || st.size < 1 || st.size > MAX_FILE) refuse("ATC_SOURCE_UNREADABLE");
    const b = await readFile(p); if (b.length !== st.size) refuse("ATC_SOURCE_UNREADABLE");
    total += b.length; if (total > MAX_TOTAL) refuse("ATC_SOURCE_UNREADABLE");
    h.update(rel); h.update(Buffer.from([0])); h.update(String(b.length)); h.update(Buffer.from([0])); h.update(b); h.update(Buffer.from([0]));
  }
  return h.digest("hex");
}
export const CLOSURE_DIGEST_PREFIX = "e7-test-abort-cleanup-closure-v1\n";
export const RUNNER_DIGEST_PREFIX = "e7-test-abort-cleanup-runner-v1\n";
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
const TEST_FILE = "test/e7-test-abort-cleanup.test.mjs";
export function dbTargetOk(url, c = CONSTANTS) {
  let u; try { u = new URL(url); } catch { return false; }
  return (u.protocol === "postgresql:" || u.protocol === "postgres:") && u.hostname === "aws-0-us-east-1.pooler.supabase.com" && u.port === "6543"
    && decodeURIComponent(u.username) === `mv_booking_app_dev.${c.dbProjectRef}` && u.pathname === "/postgres" && u.search === "" && u.hash === "";
}
export const OFFICIAL_CA_SHA256 = "700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7";
const SECRET_KEYS = Object.freeze(["E7_STRIPE_TEST_KEY", "E7_HOSTAWAY_TOKEN", "E7_DEV_BOOKING_DATABASE_URL"]);

/** runHosted({ mode, env, proc, wrapperDir, deps }) → { exitCode, result }. Never throws. deps = TEST SEAMS. */
export async function runHosted({ mode = "preflight", env, proc, wrapperDir, deps = {} }) {
  const c = deps.constants ?? CONSTANTS;
  const spawnChild = deps.spawnChild ?? spawnNode;
  const importEnv = deps.importEnv ?? ((dir) => import(pathToFileURL(`${dir}/scripts/e7-connected/probe-env-preflight.mjs`).href));
  const importTooling = deps.importTooling ?? defaultImportTooling;
  const runCore = deps.runCore ?? runAbortCleanupCore;
  const readPgVersion = deps.readPgVersion ?? (async (dir) => JSON.parse(await readFile(`${dir}/node_modules/pg/package.json`, "utf8")).version);
  const readCa = deps.readCa ?? ((p) => readFile(p));
  const r = { schema: "e7-test-abort-cleanup-hosted-v1", mode: null, code: null, workflowSha: null, toolingCommit: c.toolingCommit, toolingStatus: c.toolingStatus,
    closureDigest: null, runnerDigest: null, planKind: null, planHash: null, envCode: null, tests: null, core: null };
  let pool = null;
  try {
    if (!["preflight", "verify", "execute"].includes(mode)) refuse("ATC_USAGE");
    r.mode = mode;
    r.workflowSha = HEX40.test(env.E7_WORKFLOW_SHA ?? "") ? env.E7_WORKFLOW_SHA : null;
    const has = (k) => typeof env[k] === "string" && env[k].length > 0;
    if (mode !== "execute" && SECRET_KEYS.some(has)) refuse("ATC_SECRET_SCOPE_VIOLATION");
    const ref = env.E7_APPROVAL_REF ?? ""; const iid = env.E7_INTENT_ID ?? ""; const pid = env.E7_PAYMENT_INTENT_ID ?? "";
    const rid = env.E7_RESERVATION_ID ?? ""; const ver = env.E7_EXPECTED_VERSION ?? "";
    const expPlan = env.E7_EXPECTED_PLAN_HASH ?? ""; const expClo = env.E7_EXPECTED_CLOSURE_DIGEST ?? ""; const expRun = env.E7_EXPECTED_RUNNER_DIGEST ?? "";
    const vals = [ref, iid, pid, rid, ver]; const anyReal = vals.some((v) => v !== "");
    if (anyReal && vals.some((v) => v === "")) refuse("ATC_INPUT_INCOMPLETE");
    if (anyReal && (!APPROVAL_RE.test(ref) || !UUID_RE.test(iid) || !PI_RE.test(pid) || !RID_RE.test(rid) || !/^[1-9][0-9]{0,6}$/.test(ver))) refuse("ATC_INPUT_INVALID");
    if (ref === c.synthetic.approvalRef || iid === c.synthetic.intentId || pid === c.synthetic.paymentIntentId) refuse("ATC_INPUT_INVALID");
    if (mode !== "preflight") {
      if (c.executeEnabled !== true || c.toolingStatus !== "MERGED" || !HEX64.test(String(c.closureDigest))) refuse("ATC_EXECUTE_CLOSED");   // closed in code
      if (!anyReal || !HEX64.test(expPlan) || !HEX64.test(expClo) || !HEX64.test(expRun)) refuse("ATC_INPUT_INCOMPLETE");
      if (env.GITHUB_REF !== "refs/heads/main") refuse("ATC_REF_NOT_MAIN");
      if (expClo !== c.closureDigest) refuse("ATC_SOURCE_MISMATCH");
    }
    const tooling = await realpath(env.E7_TOOLING_DIR ?? "").catch(() => refuse("ATC_LAYOUT_INVALID"));
    const wdir = await realpath(wrapperDir).catch(() => refuse("ATC_LAYOUT_INVALID"));
    if (tooling === wdir || tooling.startsWith(`${wdir}/`) || wdir.startsWith(`${tooling}/`)) refuse("ATC_LAYOUT_INVALID");
    r.closureDigest = await framedDigest(tooling, c.closure, CLOSURE_DIGEST_PREFIX).catch((e) => refuse(e instanceof Refusal ? e.code : "ATC_SOURCE_UNREADABLE"));
    if (r.closureDigest !== c.closureDigest) refuse("ATC_SOURCE_MISMATCH");
    r.runnerDigest = await framedDigest(wdir, c.runnerFiles, RUNNER_DIGEST_PREFIX).catch((e) => refuse(e instanceof Refusal ? e.code : "ATC_SOURCE_UNREADABLE"));
    if (mode !== "preflight" && r.runnerDigest !== expRun) refuse("ATC_RUNNER_MISMATCH");
    r.planKind = anyReal ? "REAL" : "SYNTHETIC";
    const s = c.synthetic;
    const built = buildPlan(c, anyReal ? { approvalRef: ref, intentId: iid, paymentIntentId: pid, reservationId: rid, expectedVersion: Number(ver), runnerDigest: r.runnerDigest }
      : { approvalRef: s.approvalRef, intentId: s.intentId, paymentIntentId: s.paymentIntentId, reservationId: s.reservationId, expectedVersion: s.expectedVersion, runnerDigest: r.runnerDigest });
    r.planHash = built.planHash;
    if (mode !== "preflight" && built.planHash !== expPlan) refuse("ATC_PLAN_HASH_MISMATCH");
    let C1; try { C1 = await importEnv(tooling); } catch { refuse("ATC_IMPORT_FAILED"); }
    const present = Object.fromEntries(C1.PRESENT_KEYS.map((k) => [k, Object.hasOwn(env, k)]));
    let uid = null; try { if (typeof proc.getuid === "function") { const u = proc.getuid(); if (Number.isSafeInteger(u) && u >= 0) uid = u; } } catch { uid = null; }
    const ev = C1.evaluateProbeEnvironment({ schema: C1.ENV_SNAPSHOT_SCHEMA, nodeVersion: String(proc.versions.node), platform: proc.platform,
      execArgvCount: proc.execArgv.length, uidAvailable: uid !== null, present });
    r.envCode = typeof ev.code === "string" && C1.ENV_CODES.includes(ev.code) ? ev.code : "REDACTED";
    if (ev.ok !== true || proc.versions.node !== c.nodeVersion) refuse("ATC_ENV_REFUSED");
    if (mode === "preflight") {
      const o = await spawnChild(["--test", "--test-reporter=tap", TEST_FILE], { cwd: wdir, env: childEnv(env, tooling) });
      if (!o || o.spawnFailed || (o.signal !== null && o.signal !== undefined) || !Number.isSafeInteger(o.status) || o.truncated) refuse("ATC_CHILD_FAILED");
      const num = (re) => { const m = re.exec(o.stdout); return m ? Number(m[1]) : null; };
      r.tests = { status: o.status, tests: num(/^# tests (\d+)$/m), pass: num(/^# pass (\d+)$/m), fail: num(/^# fail (\d+)$/m), connectivityEvidence: false };
      if (o.status !== 0 || !(r.tests.tests > 0) || r.tests.pass !== r.tests.tests || r.tests.fail !== 0) refuse("ATC_TESTS_FAILED");
      r.code = anyReal ? "PREFLIGHT_OK_REAL_PLAN" : "PREFLIGHT_OK_SYNTHETIC_ONLY"; return { exitCode: 0, result: r };
    }
    if (mode === "verify") { r.code = "VERIFY_OK"; return { exitCode: 0, result: r }; }
    if (!SECRET_KEYS.every(has)) refuse("ATC_CREDENTIALS_MISSING");
    let pgv; try { pgv = await readPgVersion(tooling); } catch { pgv = null; }
    if (pgv !== c.pgVersion) refuse("ATC_DEPENDENCY_MISMATCH");
    let skey = env.E7_STRIPE_TEST_KEY; delete env.E7_STRIPE_TEST_KEY;
    let htok = env.E7_HOSTAWAY_TOKEN; delete env.E7_HOSTAWAY_TOKEN;
    let dbUrl = env.E7_DEV_BOOKING_DATABASE_URL; delete env.E7_DEV_BOOKING_DATABASE_URL;
    const wipe = () => { skey = null; htok = null; dbUrl = null; };
    if (!dbTargetOk(dbUrl, c)) { wipe(); refuse("ATC_DB_TARGET_INVALID"); }
    let caPem = null;
    try { const b = await readCa(env.E7_CA_FILE ?? ""); if (sha(b) === (deps.caSha256 ?? OFFICIAL_CA_SHA256) && b.length < 16384) caPem = b.toString("utf8"); } catch { caPem = null; }
    if (caPem === null) { wipe(); refuse("ATC_CA_INVALID"); }
    let mods; try { mods = await importTooling(tooling); } catch { wipe(); refuse("ATC_IMPORT_FAILED"); }
    const xs = mods.X.createE7RealExchange({ provider: "stripe" }); const xh = mods.X.createE7RealExchange({ provider: "hostaway" });
    if (!xs || xs.ok !== true || !xh || xh.ok !== true) { wipe(); refuse("ATC_IMPORT_FAILED"); }
    try { pool = mods.createBookingPool({ connectionString: dbUrl, caPem, max: 2 }); } catch { wipe(); refuse("ATC_DB_TARGET_INVALID"); } finally { dbUrl = null; }
    const ac = new AbortController(); const onSig = () => ac.abort(); proc.once?.("SIGINT", onSig); proc.once?.("SIGTERM", onSig);
    try {
      r.core = await runCore({ plan: built.plan, pool, tooling: mods.tooling, exchanges: { stripe: xs.exchange, hostaway: xh.exchange },
        credentials: { stripe: () => skey, hostaway: () => htok }, runSignal: ac.signal });
    } finally { wipe(); proc.off?.("SIGINT", onSig); proc.off?.("SIGTERM", onSig); }
    r.code = "EXECUTE_DONE";
    return { exitCode: r.core && r.core.outcome === "CLEANED" ? 0 : 1, result: r };
  } catch (e) {
    r.code = e instanceof Refusal && HOSTED_CODES.includes(e.code) ? e.code : "ATC_INTERNAL";
    return { exitCode: 1, result: r };
  } finally {
    if (pool) await pool.end().catch(() => {});
  }
}
async function defaultImportTooling(dir) {
  const u = (p) => pathToFileURL(`${dir}/${p}`).href;
  const [W, R, IS, EA, T, X, P, HR, OA, CP, KP] = await Promise.all([import(u("lib/booking-db/compensation-worker.js")), import(u("lib/booking-db/repo.js")),
    import(u("lib/checkout/intent-state.js")), import(u("scripts/e7-connected/executor-adapters.mjs")), import(u("scripts/e7-connected/http-transports.mjs")),
    import(u("scripts/e7-connected/real-exchange.mjs")), import(u("lib/booking-db/pool.js")), import(u("lib/hostaway-reservations.js")),
    import(u("scripts/e7-operator/test-abort.mjs")), import(u("lib/checkout/capture-proof.js")), import(u("lib/checkout/compensation-proof.js"))]);
  return { X, createBookingPool: P.createBookingPool,
    tooling: { executeOperatorAbort: OA.executeOperatorAbort, buildAbortExpectation: OA.buildAbortExpectation, runCleanupStep: W.runCleanupStep,
      loadIntent: R.loadIntent, voidKey: IS.voidKey, testAbortEventId: IS.testAbortEventId, createPhaseExecutors: EA.createPhaseExecutors,
      createStripeSend: T.createE7StripeTestSend, createHostawaySend: T.createE7HostawaySend, validateAdapterConfig: HR.validateAdapterConfig,
      unwrapEnvelope: HR.unwrapEnvelope, normalizeReservation: HR.normalizeReservation, lookupByRef: HR.lookupByRef,
      paymentIntentProofObservationV3: CP.paymentIntentProofObservationV3, stillAuthorizedV3Refusal: CP.stillAuthorizedV3Refusal, piCanceledProofV3: KP.piCanceledProofV3 } };
}

export function summaryMarkdown(r) {
  const k = r.core;
  const rows = [["mode", r.mode], ["code", r.code], ["workflow commit", r.workflowSha], ["tooling commit / status", `${r.toolingCommit} / ${r.toolingStatus}`],
    ["closureDigest (computed)", r.closureDigest], ["runnerDigest (computed)", r.runnerDigest], ["plan kind", r.planKind], ["planHash", r.planHash], ["env", r.envCode],
    ["fake tests (NOT connectivity)", r.tests ? `status ${r.tests.status}, pass ${r.tests.pass}/${r.tests.tests}, fail ${r.tests.fail}` : null],
    ["outcome / code", k ? `${k.outcome} / ${k.code ?? "—"}` : null], ["state start → final", k ? `${k.startState ?? "—"} → ${k.finalState ?? "—"}` : null],
    ["abort invocations / outcome", k ? `${k.abortInvocations} / ${k.abortOutcome ?? "—"}` : null], ["steps", k ? k.steps : null],
    ["exchanges (Hostaway by-id / lookup pages / account / PI reads)", k ? `${k.exchanges} (${k.hostawayReads} / ${k.lookupPages} / ${k.accountReads} / ${k.piReads})` : null],
    ["DB statements (all, incl. operator + worker) / refused by budget", k ? `${k.dbQueries} / ${k.dbBudgetRefused}` : null],
    ["Hostaway cancel invocations / outcome", k ? `${k.hostawayCancelInvocations} / ${k.hostawayCancelOutcome}` : null],
    ["Stripe cancel invocations / outcome", k ? `${k.stripeCancelInvocations} / ${k.stripeCancelOutcome}` : null],
    ["refused at transport / by stop", k ? `${k.refusedAtTransport} / ${k.refusedByStop}` : null], ["proofs", k ? k.proofs.join(" ") : null],
    ["postcheck", k && k.postcheck ? JSON.stringify(k.postcheck) : null], ["provider readback", k ? k.providerReadback : null], ["worker actions", k ? k.actions.join(" ") : null]];
  return `### E7 test abort + cleanup — one confirmed TEST reservation\n\n| field | value |\n|---|---|\n${rows.map(([a, b]) => `| ${a} | ${b === null || b === undefined ? "—" : String(b)} |`).join("\n")}\n\n\`\`\`json\n${JSON.stringify(r)}\n\`\`\`\n`;
}

if (import.meta.main === true) {
  const mode = process.argv[2] ?? "preflight";
  const wrapperDir = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
  const { exitCode, result } = await runHosted({ mode, env: process.env, proc: process, wrapperDir });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summaryMarkdown(result)).catch(() => {});
  process.exitCode = exitCode;
}
