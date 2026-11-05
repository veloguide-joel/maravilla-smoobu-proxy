// scripts/e7-checkout-test-cleanup.mjs — E7 owner cleanup of ONE released Stripe TEST authorization on the TEST DEV database.
// Doc: claude/e7-checkout-test-cleanup.md. Node built-ins only in this file. OFFLINE slice: code is NOT consent; nothing here authorizes a
// dispatch, a DB connection or a provider request. execute stays CLOSED until Joel approves the exact filled package.
//   * Inert on import (`import.meta.main` guard at the bottom): no env / fs / network / DB / timer until a mode runs.
//   * Reuses the ACCEPTED checkout lineage at the FIXED commit 6d703acd (checked out separately as "tooling"): the compensation worker
//     `runCleanupStep`, the executor adapters `createPhaseExecutors`, T `createE7StripeTestSend`, X `createE7RealExchange`, C1, the pool and
//     repo. Its full transitive import closure (+ package.json / package-lock.json) is digest-verified BEFORE any tooling import; the pinned
//     `pg` dependency is installed from that lockfile and its version re-checked. None of those files is modified.
//   * Scope (code ceiling): ONE explicit intent UUID + its PaymentIntent (workflow inputs bound into the plan hash), TEST-marked DEV DB,
//     listing 606998 USD, account acct_1TyHE42B9LTneQgw, Stripe-Version 2026-01-28.clover. Only an intent whose persisted lineage is EXACTLY
//     payment authorized -> TEST_RELEASE_REQUESTED (-> VOID_SUCCEEDED) qualifies; ordinary booking compensation, capture_failed,
//     reconciliation, any Hostaway attempt / reservation / dispatch, any capture or alert is refused before any provider call.
//   * Provider budget at the transport boundary: <= 1 cancelPaymentIntent invocation for the WHOLE run (0 unless the void row is pristine),
//     <= 4 account reads, <= 8 PaymentIntent reads, <= 8 worker steps, one run deadline. Hostaway executors fail BEFORE any transport.
//   * STOP on: refusal, escalation, uncertain cancel, DB error, scope drift, budget, deadline, cancellation. No retry / rerun / new key.
//   * Output: whitelisted codes / counts / states / flags only; never a key, URL, raw provider body, guest data or DB error text.
import process from "node:process";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath, appendFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

export const CONSTANTS = Object.freeze({
  toolingCommit: "6d703acdcfa205138d1ce4ba65b2ec58fc9493c9",
  // full transitive closure of every tooling module this runner imports (relative imports, scanned at 6d703acd) + package manifest + lock
  closure: Object.freeze(["package.json", "package-lock.json",
    "lib/bookability.js", "lib/booking-db/codec.js", "lib/booking-db/compensation-worker.js", "lib/booking-db/config.js", "lib/booking-db/operations.js",
    "lib/booking-db/pool.js", "lib/booking-db/recovery.js", "lib/booking-db/repo.js", "lib/booking-db/reservation-worker.js", "lib/checkout/capture-proof.js",
    "lib/checkout/compensation-proof.js", "lib/checkout/final-price.js", "lib/checkout/intent-state.js", "lib/checkout/offline-charge-proof.js",
    "lib/checkout/recovery-plan.js", "lib/checkout/server-pricer.js", "lib/direct-policy.js", "lib/direct-pricing.js", "lib/hostaway-calendar.js",
    "lib/hostaway-reservations.js", "lib/hostaway.js", "lib/public-api.js", "lib/quote-public.js", "scripts/e7-connected/executor-adapters.mjs",
    "scripts/e7-connected/http-transports.mjs", "scripts/e7-connected/probe-env-preflight.mjs", "scripts/e7-connected/real-exchange.mjs"]),
  closureDigest: "ce0a418a8b07ed27b6167e2b4b6fbce0e8b2e2e69dcad29318210b799e923c8f",   // framed SHA-256 of `closure` at 6d703acd (test C2 recomputes it)
  pgVersion: "8.18.0",                                        // = package-lock.json node_modules/pg at 6d703acd
  runnerFiles: Object.freeze(["scripts/e7-checkout-test-cleanup.mjs", ".github/workflows/e7-checkout-test-cleanup.yml", "test/e7-checkout-test-cleanup.test.mjs"]),
  accountId: "acct_1TyHE42B9LTneQgw",
  listingId: 606998, currency: "USD",
  listingTimeZone: "America/Bahia_Banderas",                  // worker gate input only; the release path plans no Hostaway cancel
  refFieldId: 1,                                              // worker gate input only (positive int); Hostaway executors never reach transport
  stripeVersion: "2026-01-28.clover",
  budgets: Object.freeze({ steps: 8, cancel: 1, accountReads: 4, piReads: 8, exchanges: 13, runMs: 6 * 60 * 1000, waitCapMs: 35 * 1000 }),
  dbEnvironment: "test", dbProjectRef: "mxotevtiscernhqilyiu",
  nodeVersion: "22.22.0",
  synthetic: Object.freeze({ approvalRef: "SYNTHETIC-preflight-not-for-execute", intentId: "00000000-0000-4000-8000-000000000000",
    paymentIntentId: "pi_SYNTHETICnotForExecute0" })
});
export const PLAN_SCHEMA = "e7-checkout-test-cleanup-plan-v1";
export const RESULT_SCHEMA = "e7-checkout-test-cleanup-result-v1";
export const OUTCOMES = Object.freeze(["RELEASED", "ALREADY_RELEASED", "SCOPE_REFUSED", "START_STATE_NOT_ELIGIBLE", "WORKER_REFUSED",
  "ESCALATED", "CANCEL_OUTCOME_UNKNOWN", "CANCEL_NOT_SENT", "SECOND_CANCEL_REFUSED", "BUDGET_EXHAUSTED", "DEADLINE", "ABORTED", "DB_ERROR", "NOT_RELEASED", "CORE_INVALID"]);
export const HOSTED_CODES = Object.freeze(["CLN_USAGE", "CLN_SECRET_SCOPE_VIOLATION", "CLN_INPUT_INVALID", "CLN_INPUT_INCOMPLETE", "CLN_REF_NOT_MAIN",
  "CLN_LAYOUT_INVALID", "CLN_SOURCE_UNREADABLE", "CLN_SOURCE_MISMATCH", "CLN_RUNNER_MISMATCH", "CLN_PLAN_HASH_MISMATCH", "CLN_DEPENDENCY_MISMATCH",
  "CLN_ENV_REFUSED", "CLN_TESTS_FAILED", "CLN_CHILD_FAILED", "CLN_IMPORT_FAILED", "CLN_CREDENTIALS_MISSING", "CLN_DB_TARGET_INVALID", "CLN_CA_INVALID", "CLN_INTERNAL",
  "PREFLIGHT_OK_REAL_PLAN", "PREFLIGHT_OK_SYNTHETIC_ONLY", "VERIFY_OK", "EXECUTE_DONE"]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PI_RE = /^pi_[A-Za-z0-9]{8,64}$/;
const APPROVAL_RE = /^[A-Za-z0-9._:-]{1,80}$/;
const HEX64 = /^[0-9a-f]{64}$/; const HEX40 = /^[0-9a-f]{40}$/;
const CODE_RE = /^[A-Za-z0-9_:>!.-]{1,80}$/;
const STRIPE = "https://api.stripe.com";
const MAX_FILE = 1048576; const MAX_TOTAL = 4194304;
const freeze = Object.freeze;
class Refusal extends Error { constructor(code) { super("e7-checkout-test-cleanup"); this.code = code; } }
const refuse = (code) => { throw new Refusal(code); };
const sha = (s) => createHash("sha256").update(s).digest("hex");
function deepFreeze(v) { if (v && typeof v === "object") { for (const k of Object.keys(v)) deepFreeze(v[k]); freeze(v); } return v; }
export function canonical(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
}

// =================================================================================================================================
// plan (pure)
/** buildPlan(c, { approvalRef, intentId, paymentIntentId, runnerDigest }) → frozen { plan, planHash } */
export function buildPlan(c, { approvalRef, intentId, paymentIntentId, runnerDigest }) {
  if (typeof approvalRef !== "string" || !APPROVAL_RE.test(approvalRef)) refuse("CLN_INPUT_INVALID");
  if (typeof intentId !== "string" || !UUID_RE.test(intentId) || typeof paymentIntentId !== "string" || !PI_RE.test(paymentIntentId)) refuse("CLN_INPUT_INVALID");
  if (c.accountId !== "acct_1TyHE42B9LTneQgw" || c.listingId !== 606998 || c.currency !== "USD" || c.stripeVersion !== "2026-01-28.clover"
      || c.budgets.cancel !== 1 || c.budgets.steps !== 8 || c.dbEnvironment !== "test") refuse("CLN_INPUT_INVALID");            // code ceiling
  const plan = { schema: PLAN_SCHEMA, toolingCommit: c.toolingCommit, closureDigest: c.closureDigest, runnerDigest, pgVersion: c.pgVersion,
    stripeVersion: c.stripeVersion, accountId: c.accountId, listingId: c.listingId, currency: c.currency, dbEnvironment: c.dbEnvironment, dbProjectRef: c.dbProjectRef,
    intentId, paymentIntentId, approvalRef, budgets: { ...c.budgets }, operations: ["accounts.retrieve", "paymentIntents.retrieve", "paymentIntents.cancel<=1"],
    writes: { stripeCancelMax: 1, hostaway: 0, capture: 0, refund: 0, create: 0, notify: 0 } };
  return freeze({ plan: deepFreeze(plan), planHash: sha(canonical(plan)) });
}

// =================================================================================================================================
// DB precheck (read-only SELECTs through the runtime login; no network, no transaction held across a provider call)
const Q = freeze({
  instance: "/*e7c:instance*/ SELECT environment FROM booking.instance",
  transitions: "/*e7c:transitions*/ SELECT version_after, from_state, to_state, event_type, event_id, reason_code FROM booking.intent_transitions WHERE intent_id = $1 ORDER BY version_after",
  attempts: "/*e7c:attempts*/ SELECT status, checkout_session_id, payment_intent_id, livemode, amount_minor::text AS amount_minor, currency FROM booking.payment_attempts WHERE intent_id = $1",
  hostaway: "/*e7c:hostaway*/ SELECT count(*)::int AS n FROM booking.hostaway_reservation_attempts WHERE intent_id = $1",
  ops: "/*e7c:ops*/ SELECT op_type, state, idempotency_key, payload ->> 'providerIdempotencyKey' AS provider_key, payload ->> 'paymentIntentId' AS payload_pi, attempts, (dispatched_at IS NOT NULL) AS dispatched FROM booking.external_operations WHERE intent_id = $1",
  cases: "/*e7c:cases*/ SELECT count(*)::int AS n FROM booking.reconciliation_cases WHERE intent_id = $1",
  claims: "/*e7c:claims*/ SELECT listing_id, (released_at IS NOT NULL) AS released FROM booking.inventory_claims WHERE intent_id = $1",
  ledger: "/*e7c:ledger*/ SELECT entry FROM booking.payment_ledger WHERE intent_id = $1"
});
export const QUERIES = Q;
const ALLOWED_OPS = freeze(["stripe.create_checkout_session", "stripe.retrieve_checkout_session", "stripe.retrieve_payment_intent", "stripe.void_payment_intent", "guest.notify"]);
const ALLOWED_LEDGER = freeze(["authorization_accepted", "authorization_voided"]);

/**
 * inspect(pool, plan, tooling) → { ok:false, code } | { ok:true, terminal, cancelBudget, intent }
 *   tooling = { loadIntent, voidKey, testReleaseEventId }
 */
export async function inspect(pool, plan, tooling) {
  const one = async (sql, args = [plan.intentId]) => (await pool.query(sql, args)).rows;
  const inst = await one(Q.instance, []);
  if (inst.length !== 1 || inst[0].environment !== plan.dbEnvironment) return { ok: false, code: "DB_NOT_TEST" };
  let intent;
  try { intent = await tooling.loadIntent(pool, plan.intentId); } catch { return { ok: false, code: "INTENT_NOT_FOUND" }; }
  if (!intent || intent.id !== plan.intentId) return { ok: false, code: "INTENT_NOT_FOUND" };
  if (intent.listingId !== plan.listingId || !intent.price || intent.price.currency !== plan.currency) return { ok: false, code: "LISTING_SCOPE" };
  const p = intent.payment;
  if (!p || p.paymentIntentId !== plan.paymentIntentId) return { ok: false, code: "PAYMENT_INTENT_SCOPE" };
  if (p.livemode !== false || p.capturedMinor !== 0 || p.currency !== plan.currency || !(p.amountMinor > 0)) return { ok: false, code: "PAYMENT_NOT_CLEAN_TEST" };
  if (intent.reservation !== null || intent.dispatch !== null) return { ok: false, code: "HOSTAWAY_RESERVATION_OR_DISPATCH" };
  const k = intent.counters;
  if (k.reservationAttempts !== 0 || k.captureAttempts !== 0 || k.cancelAttempts !== 0 || k.offlineChargeAttempts !== 0 || !(k.voidAttempts === 0 || k.voidAttempts === 1)) {
    return { ok: false, code: "COUNTERS_NOT_RELEASE" };
  }
  if (!intent.checkout || typeof intent.checkout.sessionId !== "string") return { ok: false, code: "SESSION_UNBOUND" };
  // lineage: exactly one PAYMENT_AUTHORIZED, immediately followed by THE TEST release, then at most VOID_SUCCEEDED; nothing else after
  const tr = await one(Q.transitions);
  const ia = tr.findIndex((t) => t.event_type === "PAYMENT_AUTHORIZED");
  if (ia < 0 || tr.filter((t) => t.event_type === "PAYMENT_AUTHORIZED").length !== 1) return { ok: false, code: "LINEAGE_NOT_RELEASE" };
  const after = tr.slice(ia + 1);
  const rel = after[0];
  if (!rel || rel.event_type !== "TEST_RELEASE_REQUESTED" || rel.from_state !== "payment_authorized" || rel.to_state !== "reservation_failed"
      || rel.reason_code !== "TEST_RELEASE_REQUESTED" || rel.event_id !== tooling.testReleaseEventId(intent.id, p.paymentIntentId)) return { ok: false, code: "LINEAGE_NOT_RELEASE" };
  const tail = after.slice(1);
  const voided = tail.length === 1 && tail[0].event_type === "VOID_SUCCEEDED" && tail[0].from_state === "reservation_failed" && tail[0].to_state === "authorization_released";
  if (!(tail.length === 0 || voided)) return { ok: false, code: "LINEAGE_NOT_RELEASE" };
  if (tr[tr.length - 1].to_state !== intent.status) return { ok: false, code: "LINEAGE_NOT_RELEASE" };
  // bound attempt
  const at = await one(Q.attempts);
  const done = at.filter((a) => a.status === "completed");
  if (done.length !== 1 || done[0].checkout_session_id !== intent.checkout.sessionId || done[0].payment_intent_id !== p.paymentIntentId || done[0].livemode !== false
      || done[0].amount_minor !== String(p.amountMinor) || done[0].currency !== plan.currency) return { ok: false, code: "ATTEMPT_NOT_BOUND" };
  if (at.some((a) => a.status !== "completed" && a.payment_intent_id !== null)) return { ok: false, code: "ATTEMPT_NOT_BOUND" };
  if ((await one(Q.hostaway))[0].n !== 0) return { ok: false, code: "HOSTAWAY_ATTEMPT_PRESENT" };
  if ((await one(Q.cases))[0].n !== 0) return { ok: false, code: "RECONCILIATION_PRESENT" };
  const ledger = await one(Q.ledger);
  if (ledger.some((l) => !ALLOWED_LEDGER.includes(l.entry))) return { ok: false, code: "LEDGER_NOT_RELEASE" };
  const ops = await one(Q.ops);
  if (ops.some((o) => !ALLOWED_OPS.includes(o.op_type))) return { ok: false, code: "OPERATION_NOT_RELEASE" };
  const voids = ops.filter((o) => o.op_type === "stripe.void_payment_intent");
  // the ONE void row queued by THE release transition: row key void:<intent>:v<release version>, provider key = E3 voidKey(intent, PI)
  if (voids.length !== 1 || voids[0].idempotency_key !== `void:${intent.id}:v${rel.version_after}` || voids[0].provider_key !== tooling.voidKey(intent.id, p.paymentIntentId)
      || voids[0].payload_pi !== p.paymentIntentId) return { ok: false, code: "VOID_ROW_UNEXPECTED" };
  const claims = await one(Q.claims);
  if (claims.length !== 1 || claims[0].listing_id !== plan.listingId) return { ok: false, code: "CLAIM_UNEXPECTED" };
  const v = voids[0];
  if (intent.status === "authorization_released") {
    if (!voided || v.state !== "succeeded" || claims[0].released !== true) return { ok: false, code: "TERMINAL_INCONSISTENT" };
    return { ok: true, terminal: true, cancelBudget: 0, intent };
  }
  if (intent.status !== "reservation_failed" || intent.reasonCode !== "TEST_RELEASE_REQUESTED") return { ok: false, code: "START_STATE_NOT_ELIGIBLE" };
  // only a PRISTINE void row may be sent once; anything already dispatched / unknown is never re-sent by this runner
  if (v.state !== "pending" || v.attempts !== 0 || v.dispatched !== false || claims[0].released !== false) return { ok: false, code: "START_STATE_NOT_ELIGIBLE" };
  return { ok: true, terminal: false, cancelBudget: 1, intent };
}

// =================================================================================================================================
// core (injected; no native I/O of its own)
/**
 * runCleanupCore({ plan, pool, tooling, exchange, credential, clock?, monotonic?, sleep?, runSignal?, workerTimeouts? }) → frozen result. Never throws.
 *   tooling = { runCleanupStep, loadIntent, voidKey, testReleaseEventId, createPhaseExecutors, createStripeSend, validateAdapterConfig }
 */
export async function runCleanupCore(input) {
  const c = CONSTANTS; const B = c.budgets;
  const r = { schema: RESULT_SCHEMA, outcome: null, code: null, startState: null, finalState: null, steps: 0, actions: [], exchanges: 0,
    accountReads: 0, piReads: 0, cancelInvocations: 0, cancelOutcome: "NONE", refusedAtTransport: 0, hostawayCalls: 0, voidOpState: null, claimReleased: null,
    stripeVersion: c.stripeVersion, writes: { capture: 0, refund: 0, create: 0, hostaway: 0, notify: 0 } };
  const done = (outcome, code = null) => { r.outcome = outcome; r.code = code; return freeze(JSON.parse(JSON.stringify(r))); };
  try {
    const { plan, pool, tooling, exchange, credential } = input ?? {};
    if (!plan || plan.schema !== PLAN_SCHEMA || plan.accountId !== c.accountId || plan.listingId !== c.listingId || plan.stripeVersion !== c.stripeVersion
        || !UUID_RE.test(String(plan.intentId)) || !PI_RE.test(String(plan.paymentIntentId)) || plan.intentId === c.synthetic.intentId
        || !pool || typeof pool.query !== "function" || !tooling || typeof exchange !== "function" || typeof credential !== "function") return done("CORE_INVALID");
    const clock = input.clock ?? (() => Date.now());
    const mono = input.monotonic ?? (() => performance.now());
    const runSignal = input.runSignal ?? null;
    const endsAt = mono() + B.runMs;
    const sleep = input.sleep ?? ((ms) => new Promise((res) => { const t = setTimeout(res, ms); runSignal?.addEventListener?.("abort", () => { clearTimeout(t); res(); }, { once: true }); }));
    const aborted = () => !!(runSignal && runSignal.aborted);
    const PI = plan.paymentIntentId;

    // ---- (1) read-only precheck: persisted lineage / bindings / zero captured money / no Hostaway / exact void row / eligible state ----------
    let pre;
    try { pre = await inspect(pool, plan, tooling); } catch { return done("DB_ERROR", "PRECHECK_QUERY_FAILED"); }
    if (!pre.ok) return done(["START_STATE_NOT_ELIGIBLE", "TERMINAL_INCONSISTENT"].includes(pre.code) ? "START_STATE_NOT_ELIGIBLE" : "SCOPE_REFUSED", pre.code);
    r.startState = pre.intent.status;
    if (pre.terminal) { r.finalState = pre.intent.status; r.voidOpState = "succeeded"; r.claimReleased = true; return done("ALREADY_RELEASED"); }
    if (aborted()) return done("ABORTED", "BEFORE_PROVIDER");
    const voidIdem = tooling.voidKey(plan.intentId, PI);

    // ---- (2) the ONE transport boundary: exact Stripe requests only, counted before they leave ---------------------------------------
    const allowedUrls = { account: `${STRIPE}/v1/account`, pi: `${STRIPE}/v1/payment_intents/${PI}?expand%5B%5D=latest_charge`, cancel: `${STRIPE}/v1/payment_intents/${PI}/cancel` };
    let cancelExchangeOpen = false; let cancelExchanged = false; let secondCancel = false;
    const gate = (req) => {
      const isGet = req && req.method === "GET" && req.body === null && req.headers && Object.keys(req.headers).sort().join(",") === "Authorization,Stripe-Version";
      const isCancel = req && req.method === "POST" && req.url === allowedUrls.cancel && req.body === "" && req.headers && req.headers["Idempotency-Key"] === voidIdem
        && Object.keys(req.headers).sort().join(",") === "Authorization,Content-Type,Idempotency-Key,Stripe-Version";
      if (!req || !req.headers || req.headers["Stripe-Version"] !== c.stripeVersion || r.exchanges >= B.exchanges) { r.refusedAtTransport += 1; return Promise.reject(new Error("gate")); }
      if (isGet && req.url === allowedUrls.account && r.accountReads < B.accountReads) { r.accountReads += 1; }
      else if (isGet && req.url === allowedUrls.pi && r.piReads < B.piReads) { r.piReads += 1; }
      else if (isCancel && cancelExchangeOpen) { cancelExchanged = true; }
      else { r.refusedAtTransport += 1; return Promise.reject(new Error("gate")); }
      r.exchanges += 1;
      return exchange(req);
    };
    const t = tooling.createStripeSend({ exchange: gate, credential, accountId: c.accountId, apiVersion: c.stripeVersion });
    if (!t || t.ok !== true) return done("CORE_INVALID", "TRANSPORT_INVALID");
    let cancelBudget = pre.cancelBudget;
    const stripeSend = async (call, opts) => {
      if (call && call.op === "paymentIntents.cancel") {
        if (cancelBudget < 1 || r.cancelInvocations >= B.cancel) { r.refusedAtTransport += 1; secondCancel = true; throw new Error("cancel budget"); }
        cancelBudget -= 1; r.cancelInvocations += 1; cancelExchangeOpen = true;
        try { const out = await t.transport.send(call, opts); r.cancelOutcome = "REPLIED"; return out; }
        catch (e) { r.cancelOutcome = cancelExchanged ? "UNKNOWN" : "NOT_SENT"; throw e; }   // any failure after the bytes may have left = UNKNOWN
        finally { cancelExchangeOpen = false; }
      }
      return t.transport.send(call, opts);
    };
    const hostawaySend = async () => { r.hostawayCalls += 1; throw new Error("hostaway refused before transport"); };
    const bx = tooling.createPhaseExecutors({ phase: "cleanup", binding: { listingId: plan.listingId, arrivalDate: pre.intent.from, departureDate: pre.intent.to,
      ref: pre.intent.ref, reservationId: null, accountId: c.accountId, paymentIntentId: PI, voidIdempotencyKey: voidIdem }, hostaway: { send: hostawaySend }, stripe: { send: stripeSend } });
    if (!bx || bx.ok !== true) return done("SCOPE_REFUSED", "EXECUTOR_BINDING_REFUSED");
    const adapterConfig = tooling.validateAdapterConfig({ allowedListingIds: [plan.listingId], refFieldId: c.refFieldId, channelId: 2000, currency: c.currency });
    const listings = new Map([[plan.listingId, { currency: c.currency, timeZone: c.listingTimeZone }]]);
    const env = { VERCEL_ENV: "development", MV_E7_COMPENSATION_WORKER: "enabled" };   // the worker's own gate labels (no process env is read)

    // ---- (3) bounded worker steps for the ONE named intent --------------------------------------------------------------------------
    for (;;) {
      if (aborted()) return done("ABORTED", "BETWEEN_STEPS");
      if (mono() >= endsAt) return done("DEADLINE");
      if (r.steps >= B.steps) return done("BUDGET_EXHAUSTED", "STEPS");
      r.steps += 1;
      let res;
      try {
        res = await tooling.runCleanupStep(pool, { workerId: `e7-test-cleanup:${r.steps}`, env, adapterConfig, listings, executors: bx.executors, clock,
          stripeAccountId: c.accountId, intentId: plan.intentId, timeouts: input.workerTimeouts });
      } catch { return done(r.cancelInvocations ? "CANCEL_OUTCOME_UNKNOWN" : "DB_ERROR", "WORKER_THREW"); }
      for (const a of (res && Array.isArray(res.actions) ? res.actions : [])) r.actions.push(typeof a === "string" && CODE_RE.test(a) ? a : "REDACTED");
      if (r.actions.length > 64) r.actions = r.actions.slice(0, 64);
      let now;
      try { now = await tooling.loadIntent(pool, plan.intentId); } catch { return done(r.cancelInvocations ? "CANCEL_OUTCOME_UNKNOWN" : "DB_ERROR", "RELOAD_FAILED"); }
      r.finalState = now.status;
      if (secondCancel) return done("SECOND_CANCEL_REFUSED");
      if (r.cancelOutcome === "UNKNOWN") return done("CANCEL_OUTCOME_UNKNOWN");
      if (r.cancelOutcome === "NOT_SENT") return done("CANCEL_NOT_SENT");
      if (r.hostawayCalls > 0) return done("SCOPE_REFUSED", "HOSTAWAY_EXECUTOR_REACHED");
      if (!res || res.status === "refused") return done("WORKER_REFUSED", res && CODE_RE.test(String(res.code)) ? res.code : null);
      if (r.actions.some((a) => a.startsWith("VOID_OUTCOME_UNKNOWN") || a.startsWith("RECOVERY:VOID_OUTCOME_UNKNOWN"))) return done("CANCEL_OUTCOME_UNKNOWN", "WORKER_VOID_OUTCOME_UNKNOWN");
      if (r.actions.some((a) => a.startsWith("ESCALATE") || a.startsWith("RECOVERY:ESCALATE") || a.startsWith("SEND_ABORTED"))) return done("ESCALATED");
      if (now.status === "authorization_released") {
        let ops, cl;
        try { ops = (await pool.query(Q.ops, [plan.intentId])).rows; cl = (await pool.query(Q.claims, [plan.intentId])).rows; } catch { return done("DB_ERROR", "POSTCHECK_FAILED"); }
        const v = ops.filter((o) => o.op_type === "stripe.void_payment_intent");
        r.voidOpState = v.length === 1 ? v[0].state : "UNEXPECTED";
        r.claimReleased = cl.length === 1 && cl[0].released === true;
        return done(r.voidOpState === "succeeded" && r.claimReleased && r.cancelInvocations <= 1 ? "RELEASED" : "NOT_RELEASED", "POSTCHECK");
      }
      if (now.status !== "reservation_failed") return done("NOT_RELEASED", "STATE_MOVED");
      if (r.steps >= B.steps) return done("BUDGET_EXHAUSTED", "STEPS");                      // never sleep after the last allowed step
      const wait = Math.min(Number.isFinite(res.delayMs) && res.delayMs >= 0 ? res.delayMs : B.waitCapMs, B.waitCapMs);
      if (mono() + wait >= endsAt) return done("DEADLINE");
      if (wait > 0) await sleep(wait);
    }
  } catch {
    return done(r.cancelInvocations ? "CANCEL_OUTCOME_UNKNOWN" : "CORE_INVALID");
  }
}

// =================================================================================================================================
// hosted wiring (gated; real fs / child / DB / native https only inside runHosted with the real deps)
export async function framedDigest(dir, files, prefix = "e7-probe-source-v1\n") {
  const h = createHash("sha256"); h.update(prefix); let total = 0;
  for (const rel of files) {
    const p = `${dir}/${rel}`; const st = await lstat(p);
    if (!st.isFile() || st.size < 1 || st.size > MAX_FILE) refuse("CLN_SOURCE_UNREADABLE");
    const b = await readFile(p); if (b.length !== st.size) refuse("CLN_SOURCE_UNREADABLE");
    total += b.length; if (total > MAX_TOTAL) refuse("CLN_SOURCE_UNREADABLE");
    h.update(rel); h.update(Buffer.from([0])); h.update(String(b.length)); h.update(Buffer.from([0])); h.update(b); h.update(Buffer.from([0]));
  }
  return h.digest("hex");
}
export const CLOSURE_DIGEST_PREFIX = "e7-checkout-test-cleanup-closure-v1\n";
export const RUNNER_DIGEST_PREFIX = "e7-checkout-test-cleanup-runner-v1\n";
export function childEnv(env, toolingDir) { const out = {}; for (const k of Object.keys(env)) if (!k.startsWith("E7_")) out[k] = env[k]; out.E7_TOOLING_DIR = toolingDir; return out; }
export function spawnNode(args, { cwd, env }) {
  return new Promise((resolve) => {
    let out = ""; let outBytes = 0; let truncated = false; let child;
    try { child = spawn(process.execPath, args, { cwd, env, shell: false, stdio: ["ignore", "pipe", "ignore"] }); } catch { resolve({ status: null, signal: null, stdout: "", truncated: false, spawnFailed: true }); return; }
    child.stdout.on("data", (d) => { outBytes += d.length; if (outBytes <= 262144) out += d.toString("utf8"); else truncated = true; });
    child.on("error", () => resolve({ status: null, signal: null, stdout: "", truncated, spawnFailed: true }));
    child.on("close", (status, signal) => resolve({ status, signal, stdout: out, truncated, spawnFailed: false }));
  });
}
const TEST_FILE = "test/e7-checkout-test-cleanup.test.mjs";
/** the DEV runtime login only: transaction pooler user mv_booking_app_dev.<ref>; anything else refused before a pool exists */
export function dbTargetOk(url, c = CONSTANTS) {
  let u; try { u = new URL(url); } catch { return false; }
  return (u.protocol === "postgresql:" || u.protocol === "postgres:") && u.hostname === "aws-0-us-east-1.pooler.supabase.com" && u.port === "6543"
    && decodeURIComponent(u.username) === `mv_booking_app_dev.${c.dbProjectRef}` && u.pathname === "/postgres" && u.search === "" && u.hash === "";
}

/**
 * runHosted({ mode, env, proc, wrapperDir, deps }) → { exitCode, result }. Never throws.
 *   deps (TEST SEAMS): spawnChild, importEnv(dir) → C1, importTooling(dir) → tooling + { X, createBookingPool, CA_PEM }, runCore, constants, readPgVersion
 */
export async function runHosted({ mode = "preflight", env, proc, wrapperDir, deps = {} }) {
  const c = deps.constants ?? CONSTANTS;
  const spawnChild = deps.spawnChild ?? spawnNode;
  const importEnv = deps.importEnv ?? ((dir) => import(pathToFileURL(`${dir}/scripts/e7-connected/probe-env-preflight.mjs`).href));
  const importTooling = deps.importTooling ?? defaultImportTooling;
  const runCore = deps.runCore ?? runCleanupCore;
  const readPgVersion = deps.readPgVersion ?? (async (dir) => JSON.parse(await readFile(`${dir}/node_modules/pg/package.json`, "utf8")).version);
  const readCa = deps.readCa ?? ((p) => readFile(p));
  const r = { schema: "e7-checkout-test-cleanup-hosted-v1", mode: null, code: null, workflowSha: null, toolingCommit: c.toolingCommit, closureDigest: null, runnerDigest: null,
    planKind: null, planHash: null, envCode: null, tests: null, core: null };
  let pool = null;
  try {
    if (!["preflight", "verify", "execute"].includes(mode)) refuse("CLN_USAGE");
    r.mode = mode;
    r.workflowSha = HEX40.test(env.E7_WORKFLOW_SHA ?? "") ? env.E7_WORKFLOW_SHA : null;
    const hasKey = typeof env.E7_STRIPE_TEST_KEY === "string" && env.E7_STRIPE_TEST_KEY.length > 0;
    const hasDb = typeof env.E7_DEV_BOOKING_DATABASE_URL === "string" && env.E7_DEV_BOOKING_DATABASE_URL.length > 0;
    if (mode !== "execute" && (hasKey || hasDb)) refuse("CLN_SECRET_SCOPE_VIOLATION");
    if (Object.keys(env).some((k) => /HOSTAWAY/i.test(k))) refuse("CLN_SECRET_SCOPE_VIOLATION");
    const ref = env.E7_APPROVAL_REF ?? ""; const iid = env.E7_INTENT_ID ?? ""; const pid = env.E7_PAYMENT_INTENT_ID ?? "";
    const expPlan = env.E7_EXPECTED_PLAN_HASH ?? ""; const expClo = env.E7_EXPECTED_CLOSURE_DIGEST ?? ""; const expRun = env.E7_EXPECTED_RUNNER_DIGEST ?? "";
    const anyReal = ref !== "" || iid !== "" || pid !== "";
    if (anyReal && (ref === "" || iid === "" || pid === "")) refuse("CLN_INPUT_INCOMPLETE");
    if (anyReal && (!APPROVAL_RE.test(ref) || !UUID_RE.test(iid) || !PI_RE.test(pid))) refuse("CLN_INPUT_INVALID");
    if (ref === c.synthetic.approvalRef || iid === c.synthetic.intentId || pid === c.synthetic.paymentIntentId) refuse("CLN_INPUT_INVALID");
    if (mode !== "preflight") {
      if (!anyReal || !HEX64.test(expPlan) || !HEX64.test(expClo) || !HEX64.test(expRun)) refuse("CLN_INPUT_INCOMPLETE");
      if (env.GITHUB_REF !== "refs/heads/main") refuse("CLN_REF_NOT_MAIN");
      if (expClo !== c.closureDigest) refuse("CLN_SOURCE_MISMATCH");
    }
    // ---- layout + (1) the accepted closure BEFORE any tooling import ----------------------------------------------------------------
    const tooling = await realpath(env.E7_TOOLING_DIR ?? "").catch(() => refuse("CLN_LAYOUT_INVALID"));
    const wdir = await realpath(wrapperDir).catch(() => refuse("CLN_LAYOUT_INVALID"));
    if (tooling === wdir || tooling.startsWith(`${wdir}/`) || wdir.startsWith(`${tooling}/`)) refuse("CLN_LAYOUT_INVALID");
    r.closureDigest = await framedDigest(tooling, c.closure, CLOSURE_DIGEST_PREFIX).catch((e) => refuse(e instanceof Refusal ? e.code : "CLN_SOURCE_UNREADABLE"));
    if (r.closureDigest !== c.closureDigest) refuse("CLN_SOURCE_MISMATCH");
    r.runnerDigest = await framedDigest(wdir, c.runnerFiles, RUNNER_DIGEST_PREFIX).catch((e) => refuse(e instanceof Refusal ? e.code : "CLN_SOURCE_UNREADABLE"));
    if (mode !== "preflight" && r.runnerDigest !== expRun) refuse("CLN_RUNNER_MISMATCH");
    // ---- (2) plan: approval label + intent + PaymentIntent + fixed scope / code / budgets ---------------------------------------------
    r.planKind = anyReal ? "REAL" : "SYNTHETIC";
    const built = buildPlan(c, anyReal ? { approvalRef: ref, intentId: iid, paymentIntentId: pid, runnerDigest: r.runnerDigest }
      : { approvalRef: c.synthetic.approvalRef, intentId: c.synthetic.intentId, paymentIntentId: c.synthetic.paymentIntentId, runnerDigest: r.runnerDigest });
    r.planHash = built.planHash;
    if (mode !== "preflight" && built.planHash !== expPlan) refuse("CLN_PLAN_HASH_MISMATCH");
    // ---- (3) env evaluation (accepted C1; no dependency import) ---------------------------------------------------------------------
    let C1; try { C1 = await importEnv(tooling); } catch { refuse("CLN_IMPORT_FAILED"); }
    const present = Object.fromEntries(C1.PRESENT_KEYS.map((k) => [k, Object.hasOwn(env, k)]));
    let uid = null; try { if (typeof proc.getuid === "function") { const u = proc.getuid(); if (Number.isSafeInteger(u) && u >= 0) uid = u; } } catch { uid = null; }
    const ev = C1.evaluateProbeEnvironment({ schema: C1.ENV_SNAPSHOT_SCHEMA, nodeVersion: String(proc.versions.node), platform: proc.platform,
      execArgvCount: proc.execArgv.length, uidAvailable: uid !== null, present });
    r.envCode = typeof ev.code === "string" && C1.ENV_CODES.includes(ev.code) ? ev.code : "REDACTED";
    if (ev.ok !== true || proc.versions.node !== c.nodeVersion) refuse("CLN_ENV_REFUSED");
    // ---- (4) preflight: the FAKE test suite as a plain child (no secret, no DB, no network, no dependency) ----------------------------
    if (mode === "preflight") {
      const o = await spawnChild(["--test", "--test-reporter=tap", TEST_FILE], { cwd: wdir, env: childEnv(env, tooling) });
      if (!o || o.spawnFailed || (o.signal !== null && o.signal !== undefined) || !Number.isSafeInteger(o.status) || o.truncated) refuse("CLN_CHILD_FAILED");
      const num = (re) => { const m = re.exec(o.stdout); return m ? Number(m[1]) : null; };
      r.tests = { status: o.status, tests: num(/^# tests (\d+)$/m), pass: num(/^# pass (\d+)$/m), fail: num(/^# fail (\d+)$/m), connectivityEvidence: false };
      if (o.status !== 0 || !(r.tests.tests > 0) || r.tests.pass !== r.tests.tests || r.tests.fail !== 0) refuse("CLN_TESTS_FAILED");
      r.code = anyReal ? "PREFLIGHT_OK_REAL_PLAN" : "PREFLIGHT_OK_SYNTHETIC_ONLY"; return { exitCode: 0, result: r };
    }
    if (mode === "verify") { r.code = "VERIFY_OK"; return { exitCode: 0, result: r }; }
    // ---- (5) execute: the pinned dependency, the TWO secrets (read once, removed from env), the core ----------------------------------
    if (!hasKey || !hasDb) refuse("CLN_CREDENTIALS_MISSING");
    let pgv; try { pgv = await readPgVersion(tooling); } catch { pgv = null; }
    if (pgv !== c.pgVersion) refuse("CLN_DEPENDENCY_MISMATCH");
    let key = env.E7_STRIPE_TEST_KEY; delete env.E7_STRIPE_TEST_KEY;
    let dbUrl = env.E7_DEV_BOOKING_DATABASE_URL; delete env.E7_DEV_BOOKING_DATABASE_URL;
    if (!dbTargetOk(dbUrl, c)) { key = null; dbUrl = null; refuse("CLN_DB_TARGET_INVALID"); }
    let caPem = null;
    try { const b = await readCa(env.E7_CA_FILE ?? ""); if (sha(b) === (deps.caSha256 ?? OFFICIAL_CA_SHA256) && b.length < 16384) caPem = b.toString("utf8"); } catch { caPem = null; }
    if (caPem === null) { key = null; dbUrl = null; refuse("CLN_CA_INVALID"); }
    let mods; try { mods = await importTooling(tooling); } catch { refuse("CLN_IMPORT_FAILED"); }
    const ex = mods.X.createE7RealExchange({ provider: "stripe" });
    if (!ex || ex.ok !== true) refuse("CLN_IMPORT_FAILED");
    try { pool = mods.createBookingPool({ connectionString: dbUrl, caPem, max: 2 }); } catch { refuse("CLN_DB_TARGET_INVALID"); } finally { dbUrl = null; }
    const credential = () => key;
    const ac = new AbortController(); const onSig = () => ac.abort(); proc.once?.("SIGINT", onSig); proc.once?.("SIGTERM", onSig);
    try { r.core = await runCore({ plan: built.plan, pool, tooling: mods.tooling, exchange: ex.exchange, credential, runSignal: ac.signal }); }
    finally { key = null; proc.off?.("SIGINT", onSig); proc.off?.("SIGTERM", onSig); }
    r.code = "EXECUTE_DONE";
    return { exitCode: r.core && ["RELEASED", "ALREADY_RELEASED"].includes(r.core.outcome) ? 0 : 1, result: r };
  } catch (e) {
    r.code = e instanceof Refusal && HOSTED_CODES.includes(e.code) ? e.code : "CLN_INTERNAL";
    return { exitCode: 1, result: r };
  } finally {
    if (pool) await pool.end().catch(() => {});
  }
}
async function defaultImportTooling(dir) {
  const u = (p) => pathToFileURL(`${dir}/${p}`).href;
  const [W, R, IS, EA, T, X, P, HR] = await Promise.all([import(u("lib/booking-db/compensation-worker.js")), import(u("lib/booking-db/repo.js")),
    import(u("lib/checkout/intent-state.js")), import(u("scripts/e7-connected/executor-adapters.mjs")), import(u("scripts/e7-connected/http-transports.mjs")),
    import(u("scripts/e7-connected/real-exchange.mjs")), import(u("lib/booking-db/pool.js")), import(u("lib/hostaway-reservations.js"))]);
  return { X, createBookingPool: P.createBookingPool,
    tooling: { runCleanupStep: W.runCleanupStep, loadIntent: R.loadIntent, voidKey: IS.voidKey, testReleaseEventId: IS.testReleaseEventId,
      createPhaseExecutors: EA.createPhaseExecutors, createStripeSend: T.createE7StripeTestSend, validateAdapterConfig: HR.validateAdapterConfig } };
}
/** Supabase prod-ca-2021.crt is public; the workflow fetches it and THIS hash is the pin (same value as scripts/db-smoke.mjs OFFICIAL_CA_SHA256) */
export const OFFICIAL_CA_SHA256 = "700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7";

export function summaryMarkdown(r) {
  const k = r.core;
  const rows = [["mode", r.mode], ["code", r.code], ["workflow commit", r.workflowSha], ["tooling commit", r.toolingCommit], ["closureDigest (computed)", r.closureDigest],
    ["runnerDigest (computed)", r.runnerDigest], ["plan kind", r.planKind], ["planHash", r.planHash], ["env", r.envCode],
    ["fake tests (NOT connectivity)", r.tests ? `status ${r.tests.status}, pass ${r.tests.pass}/${r.tests.tests}, fail ${r.tests.fail}` : null],
    ["outcome / code", k ? `${k.outcome} / ${k.code ?? "—"}` : null], ["state start → final", k ? `${k.startState ?? "—"} → ${k.finalState ?? "—"}` : null],
    ["steps", k ? k.steps : null], ["exchanges (account / PI reads)", k ? `${k.exchanges} (${k.accountReads} / ${k.piReads})` : null],
    ["cancel invocations / outcome", k ? `${k.cancelInvocations} / ${k.cancelOutcome}` : null], ["refused at transport / Hostaway calls", k ? `${k.refusedAtTransport} / ${k.hostawayCalls}` : null],
    ["void op / claim released", k ? `${k.voidOpState ?? "—"} / ${k.claimReleased ?? "—"}` : null], ["worker actions", k ? k.actions.join(" ") : null]];
  return `### E7 checkout TEST cleanup — one released authorization\n\n| field | value |\n|---|---|\n${rows.map(([a, b]) => `| ${a} | ${b === null || b === undefined ? "—" : String(b)} |`).join("\n")}\n\n\`\`\`json\n${JSON.stringify(r)}\n\`\`\`\n`;
}

if (import.meta.main === true) {
  const mode = process.argv[2] ?? "preflight";
  const wrapperDir = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
  const { exitCode, result } = await runHosted({ mode, env: process.env, proc: process, wrapperDir });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summaryMarkdown(result)).catch(() => {});
  process.exitCode = exitCode;
}
