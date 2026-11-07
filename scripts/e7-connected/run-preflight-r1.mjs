// scripts/e7-connected/run-preflight-r1.mjs — E7 M2-G1: READ-ONLY L-preflight over INJECTED capabilities (contract claude/e7-run-real-r1.md §3–§6).
//   * Never executes a worker, never writes a booking record / event / op / evidence, never sends a provider write, never reads a credential,
//     env or file. Every verdict: executable:false, all permissions false. NOT activation, readiness or permission.
//   * Every ACTUAL start (pool.connect, every SQL statement incl. nested ones inside accepted helpers, every provider exchange incl. the
//     three inside priceStay) honours blocked() at the start itself; no retry; the first refusal / stop short-circuits all later reads.
//   * Constants / SQL from executable modules (run-core, run-core-abort-v2, run-test-abort, reservation-worker, recovery) are COPIED with
//     origin SHA-256 pins (parity asserted by tests), never imported.
import { types } from "node:util";
import { createHash } from "node:crypto";
import { canonicalJson } from "./run-manifest.mjs";
import { bindRunPackageR1 } from "./run-binding-r1.mjs";
import { snapshotData, PERMISSIONS_NONE } from "./run-plan-v1.mjs";
import { createLifecycle, trackClient, LIMITS } from "./run-guard.mjs";
import { readRunSnapshot, readGuestBinding, deriveRecoveryCandidate } from "./run-facts.mjs";
import { createPhaseExecutors } from "./executor-adapters.mjs";
import { loadIntent } from "../../lib/booking-db/repo.js";
import { priceStay } from "../../lib/checkout/server-pricer.js";
import { compareFinalPrice } from "../../lib/checkout/final-price.js";
import { paymentIntentProofObservationV3, stillAuthorizedV3Refusal } from "../../lib/checkout/capture-proof.js";
import { PROTECTED_HOSTAWAY_RESERVATION_IDS } from "../../lib/checkout/compensation-proof.js";
import { readDirectPolicyFromEnv } from "../../lib/direct-policy.js";
import { todayInTimeZone } from "../../lib/public-api.js";

export const PREFLIGHT_VERDICT_SCHEMA = "e7-run-preflight-r1-verdict";
export const PREFLIGHT_DIGEST_PREFIX = "e7-run-preflight-r1\n";
export const BASELINE_DIGEST_PREFIX = "e7-exclusion-baseline-r1\n";
export const BASELINE_CAP = 200;

// ---- COPIED constants / SQL (origin pins; parity asserted by tests) ---------------------------------------------------------------
/** origin file → its SHA-256 at the reviewed base (what each copy came from is named in the comment) */
export const COPIED_ORIGINS = Object.freeze({
  "scripts/e7-connected/run-core.mjs": "ad1dcbb29e7cb1ce0aac71ac178d903076d4e5cc293dd17f972c04b4beaa5afe",          // SAME_DB SQL, checkSameDatabase
  "scripts/e7-connected/run-core-abort-v2.mjs": "a4924d5b43b842efadbb06e8c4788273a42e7f252b4098a1210ea998572caacd",  // P0 / phase budgets, WRITE_TYPES, P0 eligibility
  "scripts/e7-connected/run-test-abort.mjs": "57d97e1806fbaad83f76cf0b794cb45893a95d36456ad09b5acb7fd8b2f62b21",     // BRIDGE_LIMITS
  "lib/booking-db/reservation-worker.js": "601f48f67052f5dac40b83354b9cf10d5f81950ff9fe9cbd587288d19ed05e88",       // DEFAULT_TIMEOUTS
  "lib/booking-db/recovery.js": "17aa5a665d32cbe959e7daa4c2baffd01a00645e454eb69218938696dfa8dfc7"                  // completed payment-attempt SELECT
});
export const SQL_SAME_DB = `SELECT i.environment, i.created_at::text AS created_at, current_database() AS db, pg_postmaster_start_time()::text AS started,
       inet_server_port() AS port,
       pg_has_role(current_user, 'mv_booking_report', 'MEMBER') AS is_report,
       pg_has_role(current_user, 'mv_booking_app', 'MEMBER') AS is_app,
       (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) AS privileged
  FROM booking.instance i`;
export const SQL_PAYMENT_ATTEMPT = `SELECT id FROM booking.payment_attempts WHERE intent_id = $1 AND payment_intent_id = $2 AND status = 'completed'`;
export const SQL_BEGIN = "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY";
export const SQL_COMMIT = "COMMIT";
export const P0_BUDGET_MS = 60_000;
export const PHASE_BUDGET_MS = Object.freeze({ reservation: 15 * 60_000, cleanup: 15 * 60_000 });
export const BRIDGE_LIMITS_COPY = Object.freeze({ journalMs: LIMITS.JOURNAL_MS, abortMs: LIMITS.STEP_MARGIN_MS, postcheckMs: LIMITS.SNAPSHOT_MS });
export const PROVIDER_TIMEOUTS_COPY = Object.freeze({ pricingCallMs: 8000, readCallMs: 10000 });
const WRITE_TYPES = Object.freeze({ "hostaway.create_reservation": "create", "stripe.capture_payment_intent": "capture", "hostaway.record_offline_charge": "record",
  "stripe.void_payment_intent": "void", "hostaway.cancel_reservation": "cancel" });
const writeOps = (facts) => facts.operations.filter((o) => WRITE_TYPES[o.opType]);
const openCase = (facts) => facts.cases.some((c) => c.status === "open");
/** COPIED verbatim (run-core.mjs:117–129) */
export function checkSameDatabase(a, b) {
  const one = (rows) => (Array.isArray(rows) && rows.length === 1 && rows[0] !== null && typeof rows[0] === "object" ? rows[0] : null);
  const x = one(a); const y = one(b);
  if (!x) return freeze({ ok: false, code: "MARKER_INVALID" });
  if (x.environment !== "test") return freeze({ ok: false, code: "DATABASE_NOT_TEST" });
  if (!(x.is_report === true && x.is_app === false && x.privileged === false)) return freeze({ ok: false, code: "ROLE_NOT_REPORT" });
  if (!y) return freeze({ ok: false, code: "MARKER_INVALID" });
  if (y.environment !== "test") return freeze({ ok: false, code: "DATABASE_NOT_TEST" });
  if (!(y.is_app === true && y.is_report === false && y.privileged === false)) return freeze({ ok: false, code: "ROLE_NOT_APP" });
  const same = ["created_at", "db", "started"].every((k) => typeof x[k] === "string" && x[k] === y[k])
    && ((Number.isInteger(x.port) && x.port === y.port) || (x.port === null && y.port === null));
  return same ? freeze({ ok: true }) : freeze({ ok: false, code: "POOLS_MISMATCH" });
}

/** AUTOMATIC work budget (contract §5): a conservative automatic-work POLICY derived from accepted bounds — NOT a completion claim.
 *  Omitted / unbounded: owner attestation waits, fsync beyond observation bounds, late server / provider tails, finalize, scheduling. */
export const AUTOMATIC_WORK_BUDGET_MS = P0_BUDGET_MS + LIMITS.JOURNAL_MS
  + PHASE_BUDGET_MS.reservation
  + LIMITS.CONNECT_MS + LIMITS.SNAPSHOT_MS + 3 * BRIDGE_LIMITS_COPY.journalMs + BRIDGE_LIMITS_COPY.abortMs + BRIDGE_LIMITS_COPY.postcheckMs + LIMITS.JOURNAL_MS
  + PHASE_BUDGET_MS.cleanup
  + LIMITS.CONNECT_MS + 2 * LIMITS.STATEMENT_MS
  + 4 * LIMITS.JOURNAL_MS;
export const AUTOMATIC_BUDGET_OMITS = Object.freeze(["ownerAttestationWaits", "fsyncBeyondObservationBounds", "lateServerOrProviderTails", "finalizeQuiescence", "processScheduling"]);

export const PREFLIGHT_CODES = Object.freeze(["PREFLIGHT_OK", "INPUT_INVALID", "CLOCK_INVALID", "BLOCKED_INVALID", "STOPPED", "GUARD_FAULT",
  "TIMEOUT_DB_CONNECT", "TIMEOUT_DB_READ", "DB_FAILURE", "DB_RESULT_INVALID", "CLIENT_LOST",
  "MARKER_INVALID", "DATABASE_NOT_TEST", "ROLE_NOT_REPORT", "ROLE_NOT_APP", "POOLS_MISMATCH",
  "INTENT_NOT_FOUND", "INTENT_NOT_TEST", "INTENT_NOT_ELIGIBLE", "INTENT_IDENTITY_MISMATCH", "FACTS_MOVED", "FACT_MALFORMED", "FACT_LIMIT_EXCEEDED", "FACTS_INCONSISTENT",
  "PROTECTED_REFERENCE", "PROTECTED_REFERENCE_IN_RUN_INTENT", "GUEST_NOT_FOUND", "PAYMENT_ATTEMPT_NOT_UNIQUE", "PAYMENT_STATE_INVALID", "BASELINE_LIMIT_EXCEEDED",
  "TIMEOUT_PROVIDER", "PROVIDER_FAILURE", "ACCOUNT_MISMATCH", "PAYMENT_INTENT_PROOF_FAILED", "AUTHORIZATION_MARGIN_INSUFFICIENT", "EXECUTORS_INVALID",
  "PRICING_PROOF_INCOMPLETE", "NOT_BOOKABLE_OR_PRICE_REFUSED", "QUOTE_CHANGED", "REF_LOOKUP_NOT_EMPTY", "LOOKUP_INVALID", "POLICY_INVALID", "INTERNAL"]);

const freeze = Object.freeze;
const apply = Reflect.apply;
const getDesc = Object.getOwnPropertyDescriptor;
const getProto = Object.getPrototypeOf;
const isFn = (f) => typeof f === "function" && !types.isProxy(f);
const NOT_SENT = freeze({ notSent: true });
const P_THEN = Promise.prototype.then;                                       // the intrinsic, captured at load
const PROTECTED = new Set(PROTECTED_HOSTAWAY_RESERVATION_IDS);
const sha = (prefix, v) => createHash("sha256").update(prefix + canonicalJson(v), "utf8").digest("hex");
const rowsOf = (res) => { const d = res !== null && typeof res === "object" ? getDesc(res, "rows") : undefined; return d && "value" in d && Array.isArray(d.value) ? d.value : null; };
function dataExactly(o, keys) {
  try {
    if (o === null || typeof o !== "object" || types.isProxy(o) || Array.isArray(o)) return null;
    const p = getProto(o); if (p !== Object.prototype && p !== null) return null;
    const d = Object.getOwnPropertyDescriptors(o); const ks = Reflect.ownKeys(d);
    if (ks.length !== keys.length) return null;
    const out = Object.create(null);
    for (const k of ks) { if (typeof k !== "string" || !keys.includes(k) || !("value" in d[k]) || d[k].enumerable !== true) return null; out[k] = d[k].value; }
    return out;
  } catch { return null; }
}
/** a DATA method found along the prototype chain without running any getter (pg pools / clients use prototype methods) */
function dataMethod(obj, name) {
  if (obj === null || typeof obj !== "object" || types.isProxy(obj)) return null;
  for (let o = obj, n = 0; o !== null && n < 8; o = getProto(o), n += 1) {
    if (types.isProxy(o)) return null;
    const d = getDesc(o, name);
    if (d === undefined) continue;
    return "value" in d && isFn(d.value) ? d.value : null;
  }
  return null;
}
/** bounded scan of a provider reply for any protected reservation id (string or number value) */
function containsProtected(v) {
  let nodes = 0;
  const walk = (x, d) => {
    if (++nodes > 50_000 || d > 40) return true;                                  // unbounded / too deep: treated as unsafe
    if (typeof x === "string") return PROTECTED.has(x);
    if (typeof x === "number") return PROTECTED.has(String(x));
    if (x === null || typeof x !== "object") return false;
    for (const k of Object.keys(x)) { if (walk(x[k], d + 1)) return true; }
    return false;
  };
  try { return walk(v, 0); } catch { return true; }
}

// ---- §3 exclusion baseline (statements issued by the CALLER's gated runner, inside ONE REPEATABLE READ READ ONLY transaction) ----------
const T = (c) => `(floor(extract(epoch from ${c}) * 1000000))::bigint`;
const obj = (pairs) => `jsonb_build_object(${pairs.map(([k, e]) => `'${k}', ${e ?? k}`).join(", ")})`;
const fp = (pairs) => `encode(sha256(convert_to(${obj(pairs)}::text, 'UTF8')), 'hex')`;
// identifier-array tokens: {I} intent ids, {P} PaymentIntent ids, {R} reservation ids. Each family binds ONLY the arrays it references,
// numbered $1…$n in first-use order (Postgres refuses unreferenced / untyped parameters); `uses` records the binding order.
const ANY_I = (c) => `${c}::text = ANY({I}::text[])`;
const PI = "{P}::text[]"; const RES = "{R}::text[]"; const PIRES = "({P}::text[] || {R}::text[])";
const fam = (name, table, key, intent, pairs, whereT) => {
  const uses = [];
  const where = whereT.replace(/\{([IPR])\}/g, (_, t) => { if (!uses.includes(t)) uses.push(t); return `$${uses.indexOf(t) + 1}`; });
  return freeze({ name, uses: freeze(uses), sql: `SELECT ${key} AS key, ${intent} AS intent_id, ${fp(pairs)} AS fingerprint FROM booking.${table}
  WHERE ${where} ORDER BY ${key} COLLATE "C" LIMIT ${BASELINE_CAP + 1}` });
};
export const BASELINE_FAMILIES = Object.freeze([
  fam("intents", "intents", "id::text", "id::text", [["id"], ["ref"], ["machine_version"], ["environment"], ["state"], ["version"], ["listing_id"], ["from_date", "from_date::text"],
    ["to_date", "to_date::text"], ["guests"], ["price_snapshot"], ["currency"], ["standard_total_minor"], ["eligible_minor"], ["discount_minor"], ["final_total_minor"],
    ["policy_version"], ["rate_bps"], ["quote_hash"], ["quote_expires_at", T("quote_expires_at")], ["details_collected"], ["checkout_session_id"], ["checkout_attempt"],
    ["checkout_prepared_at", T("checkout_prepared_at")], ["stripe_payment_intent_id"], ["payment_livemode"], ["authorized_minor"],
    ["authorization_created_at", T("authorization_created_at")], ["capture_before", T("capture_before")], ["authorization_deadline", T("authorization_deadline")],
    ["authorization_accepted_at", T("authorization_accepted_at")], ["captured_minor"], ["hostaway_reservation_id"], ["reservation_confirmed_at", T("reservation_confirmed_at")],
    ["lease_worker_id"], ["lease_until", T("lease_until")], ["dispatch_at", T("dispatch_at")], ["dispatch_attempt"], ["offline_charge_id"], ["reason_code"],
    ["counters", "jsonb_build_array(checkout_attempts, reservation_attempts, void_attempts, reconcile_attempts, offline_charge_attempts, capture_attempts, cancel_attempts)"],
    ["settlement", "jsonb_build_array(settlement_reservation_cancelled, settlement_authorization_settled)"], ["created_at", T("created_at")], ["updated_at", T("updated_at")]],
  `${ANY_I("id")} OR stripe_payment_intent_id = ANY(${PI}) OR hostaway_reservation_id = ANY(${RES})`),
  fam("intent_transitions", "intent_transitions", "id::text", "intent_id::text", [["id"], ["intent_id"], ["version_after"], ["from_state"], ["to_state"], ["event_type"], ["event_id"],
    ["reason_code"], ["actor"], ["worker_id"], ["at", T("at")], ["recorded_at", T("recorded_at")]], ANY_I("intent_id")),
  fam("intent_applied_events", "intent_applied_events", "intent_id::text || ':' || event_id", "intent_id::text", [["intent_id"], ["event_id"], ["event_type"], ["applied_version"],
    ["applied_at", T("applied_at")]], ANY_I("intent_id")),
  fam("intent_work", "intent_work", "intent_id::text", "intent_id::text", [["intent_id"], ["next_action_at", T("next_action_at")], ["work_worker_id"],
    ["work_lease_until", T("work_lease_until")]], ANY_I("intent_id")),
  fam("inventory_claims", "inventory_claims", "id::text", "intent_id::text", [["id"], ["intent_id"], ["listing_id"], ["stay", "stay::text"], ["kind"], ["claimed_at", T("claimed_at")],
    ["review_after", T("review_after")], ["review_count"], ["released_at", T("released_at")], ["release_reason"]], ANY_I("intent_id")),
  fam("external_operations", "external_operations", "id::text", "intent_id::text", [["id"], ["intent_id"], ["op_type"], ["idempotency_key"], ["retry_class"], ["state"], ["payload"],
    ["source_version"], ["attempts"], ["max_attempts"], ["requires_provider_read"], ["lease_worker_id"], ["lease_until", T("lease_until")], ["next_attempt_at", T("next_attempt_at")],
    ["dispatched_at", T("dispatched_at")], ["completed_at", T("completed_at")], ["result_ref"], ["error_code"], ["late_result_status"], ["late_result_ref"],
    ["created_at", T("created_at")], ["updated_at", T("updated_at")], ["resolution_id"], ["settled_evidence_id"]],
  `${ANY_I("intent_id")} OR payload ->> 'paymentIntentId' = ANY(${PI}) OR payload ->> 'reservationId' = ANY(${RES}) OR result_ref = ANY(${PIRES}) OR late_result_ref = ANY(${PIRES})`),
  fam("provider_evidence", "provider_evidence", "id::text", "intent_id::text", [["id"], ["intent_id"], ["kind"], ["source"], ["external_ref"], ["status"], ["observed"],
    ["observed_at", T("observed_at")], ["read_operation_id"], ["provider_request_id"], ["attested_by"], ["reference"], ["recorded_by_role"], ["recorded_session_user"],
    ["created_at", T("created_at")]],
  `${ANY_I("intent_id")} OR external_ref = ANY(${PIRES}) OR observed ->> 'reservationId' = ANY(${RES}) OR observed ->> 'paymentIntentId' = ANY(${PI})`),
  fam("hostaway_reservation_attempts", "hostaway_reservation_attempts", "id::text", "intent_id::text", [["id"], ["intent_id"], ["operation_id"], ["booking_ref"], ["state"],
    ["dispatched_at", T("dispatched_at")], ["send_started_at", T("send_started_at")], ["responded_at", T("responded_at")], ["http_status"], ["refusal_code"],
    ["hostaway_reservation_id"], ["verified_listing_id"], ["verified_from", "verified_from::text"], ["verified_to", "verified_to::text"], ["verified_total_minor"],
    ["lookup_count"], ["last_lookup_at", T("last_lookup_at")], ["last_lookup_result"], ["updated_at", T("updated_at")]],
  `${ANY_I("intent_id")} OR hostaway_reservation_id = ANY(${RES})`),
  fam("payment_attempts", "payment_attempts", "id::text", "intent_id::text", [["id"], ["intent_id"], ["attempt"], ["idempotency_key"], ["status"], ["checkout_session_id"],
    ["payment_intent_id"], ["livemode"], ["amount_minor"], ["currency"], ["planned_session_expires_at", T("planned_session_expires_at")],
    ["session_expires_at", T("session_expires_at")], ["created_at", T("created_at")], ["updated_at", T("updated_at")]],
  `${ANY_I("intent_id")} OR payment_intent_id = ANY(${PI})`),
  fam("payment_ledger", "payment_ledger", "id::text", "intent_id::text", [["id"], ["intent_id"], ["entry"], ["amount_minor"], ["currency"], ["provider"], ["provider_ref"], ["source"],
    ["at", T("at")]], `${ANY_I("intent_id")} OR provider_ref = ANY(${PI})`),
  fam("payment_refunds", "payment_refunds", "id::text", "intent_id::text", [["id"], ["intent_id"], ["seq"], ["idempotency_key"], ["stripe_refund_id"], ["amount_minor"], ["currency"],
    ["reason_code"], ["requested_by"], ["state"], ["hostaway_state"], ["hostaway_refund_ref"], ["created_at", T("created_at")], ["updated_at", T("updated_at")]], ANY_I("intent_id")),
  fam("reconciliation_cases", "reconciliation_cases", "id::text", "intent_id::text", [["id"], ["intent_id"], ["kind"], ["status"], ["opened_at", T("opened_at")], ["opened_by"],
    ["evidence"], ["resolution"], ["resolved_by"], ["resolved_at", T("resolved_at")]], ANY_I("intent_id")),
  fam("reconciliation_resolutions", "reconciliation_resolutions", "id::text", "intent_id::text", [["id"], ["intent_id"], ["decision"], ["operation_id"], ["case_id"],
    ["evidence_ids", "to_jsonb(evidence_ids)"], ["result_ref"], ["resolver"], ["justification_code"], ["resolver_session_user"], ["decided_at", T("decided_at")],
    ["created_at", T("created_at")], ["consumed_at", T("consumed_at")], ["consumed_version"]], `${ANY_I("intent_id")} OR result_ref = ANY(${PIRES})`),
  fam("stripe_webhook_events", "stripe_webhook_events", "event_id", "intent_id::text", [["event_id"], ["event_type"], ["livemode"], ["api_version"],
    ["stripe_created_at", T("stripe_created_at")], ["object_id"], ["intent_id"], ["received_at", T("received_at")], ["status"], ["processed_at", T("processed_at")],
    ["attempts"], ["error_code"]], `${ANY_I("intent_id")} OR object_id = ANY(${PI})`)
]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const strList = (a, re) => Array.isArray(a) && a.length <= 32 && a.every((x) => typeof x === "string" && re.test(x)) && new Set(a).size === a.length;
/** exclusion identifiers from the binding's exact planner exclusions (null = did not exist → not an identifier) */
export function exclusionIdentifiers(exclusions) {
  const runs = exclusions.runs;
  return freeze({ intentIds: freeze(runs.map((r) => r.intentId)),
    paymentIntentIds: freeze([...runs.map((r) => r.paymentIntentId).filter((x) => x !== null), ...exclusions.otherPaymentIntentIds]),
    reservationIds: freeze([...exclusions.protectedReservationIds, ...runs.map((r) => r.reservationId).filter((x) => x !== null)]) });
}
/**
 * readExclusionBaselineR1({ statement, ids, currentIntentId }) → Promise<frozen { ok:true, baseline, baselineDigest } | { ok:false, code }>
 *   statement(sql, params) → Promise<{ ok:true, rows } | { ok:false, code }> — the caller's GATED runner inside ONE RR READ ONLY transaction.
 */
export async function readExclusionBaselineR1(input) {
  const o = dataExactly(input, ["currentIntentId", "ids", "statement"]);
  if (!o || !isFn(o.statement) || typeof o.currentIntentId !== "string" || !UUID_RE.test(o.currentIntentId)) return freeze({ ok: false, code: "INPUT_INVALID" });
  const ids = snapshotData(o.ids);
  if (!ids || Object.keys(ids).sort().join() !== "intentIds,paymentIntentIds,reservationIds" || !strList(ids.intentIds, UUID_RE)
    || !strList(ids.paymentIntentIds, /^pi_[A-Za-z0-9_]{1,250}$/) || !strList(ids.reservationIds, /^[1-9][0-9]{0,15}$/)) return freeze({ ok: false, code: "INPUT_INVALID" });
  const arrays = { I: [...ids.intentIds], P: [...ids.paymentIntentIds], R: [...ids.reservationIds] };
  const rows = [];
  for (const f of BASELINE_FAMILIES) {
    const r = await apply(o.statement, undefined, [f.sql, f.uses.map((t) => [...arrays[t]])]);
    if (!r || r.ok !== true) return freeze({ ok: false, code: (r && typeof r.code === "string" && PREFLIGHT_CODES.includes(r.code)) ? r.code : "DB_FAILURE" });
    if (!Array.isArray(r.rows)) return freeze({ ok: false, code: "DB_RESULT_INVALID" });
    if (r.rows.length > BASELINE_CAP) return freeze({ ok: false, code: "BASELINE_LIMIT_EXCEEDED" });
    for (const x of r.rows) {
      if (x === null || typeof x !== "object" || typeof x.key !== "string" || x.key.length > 300 || !(x.intent_id === null || (typeof x.intent_id === "string" && UUID_RE.test(x.intent_id)))
        || typeof x.fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(x.fingerprint)) return freeze({ ok: false, code: "DB_RESULT_INVALID" });
      rows.push(freeze({ family: f.name, key: x.key, intentId: x.intent_id, fingerprint: x.fingerprint }));
    }
  }
  if (rows.some((x) => x.intentId === o.currentIntentId)) return freeze({ ok: false, code: "PROTECTED_REFERENCE_IN_RUN_INTENT" });
  const present = new Set(rows.filter((x) => x.family === "intents").map((x) => x.key));
  rows.sort((a, b) => (a.family < b.family ? -1 : a.family > b.family ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const baseline = snapshotData({ identifiers: { intents: ids.intentIds.map((id) => ({ id, presence: present.has(id) ? "PRESENT" : "ABSENT" })),
    paymentIntentIds: [...ids.paymentIntentIds], reservationIds: [...ids.reservationIds] }, rows: rows.map((x) => ({ ...x })) });
  if (!baseline) return freeze({ ok: false, code: "BASELINE_LIMIT_EXCEEDED" });   // > snapshot node bound: fail closed
  return freeze({ ok: true, baseline, baselineDigest: sha(BASELINE_DIGEST_PREFIX, baseline) });
}

// ---- §4 preflight -------------------------------------------------------------------------------------------------------------------
const verdictOf = (S, code, extra = {}) => freeze({ schema: PREFLIGHT_VERDICT_SCHEMA, ok: code === "PREFLIGHT_OK", code: PREFLIGHT_CODES.includes(code) ? code : "INTERNAL",
  step: S.step, executable: false, permissions: PERMISSIONS_NONE, automaticBudgetMs: AUTOMATIC_WORK_BUDGET_MS, dbUncertainty: S.db, transportUncertainty: S.tr,
  counts: freeze({ connects: S.connects, statements: S.statements, exchanges: S.exchanges }), ...extra });

/** runPreflightR1({ bind, pools:{app, report}, transports:{hostaway, stripe}, guard, blocked, clock }) → Promise<frozen verdict>; never rejects */
export function runPreflightR1(input) {
  const S = { step: "INPUT", stop: null, connects: 0, statements: 0, exchanges: 0, db: "none", tr: "none", forms: [] };
  return (async () => {
    // ---------------- synchronous binding (before ANY await) ----------------
    const o = dataExactly(input, ["bind", "blocked", "clock", "guard", "pools", "transports"]);
    if (!o) return verdictOf(S, "INPUT_INVALID");
    const pools = dataExactly(o.pools, ["app", "report"]); const tr = dataExactly(o.transports, ["hostaway", "stripe"]);
    if (!pools || !tr || !isFn(o.blocked) || !isFn(o.clock)) return verdictOf(S, "INPUT_INVALID");
    const hT = dataExactly(tr.hostaway, ["send"]); const sT = dataExactly(tr.stripe, ["send"]);
    const connApp = dataMethod(pools.app, "connect"); const connRep = dataMethod(pools.report, "connect");
    if (!hT || !sT || !isFn(hT.send) || !isFn(sT.send) || !connApp || !connRep) return verdictOf(S, "INPUT_INVALID");
    const hSend = hT.send; const sSend = sT.send; const blocked = o.blocked; const clock = o.clock; const appPool = pools.app; const repPool = pools.report;
    let lc; try { lc = createLifecycle({ guard: o.guard }); } catch { return verdictOf(S, "INPUT_INVALID"); }
    const guard = o.guard;
    const readClock = () => { try { const t = apply(clock, undefined, []); return Number.isSafeInteger(t) && t >= 1 ? t : null; } catch { return null; } };
    const execClock = readClock(); if (execClock === null) return verdictOf(S, "CLOCK_INVALID");
    let bindInput; try { bindInput = dataExactly(o.bind, ["envSnapshot", "executorSources", "expected", "foundationSources", "packageBytes", "planBytes"]); } catch { bindInput = null; }
    if (!bindInput) return verdictOf(S, "INPUT_INVALID");
    S.step = "BIND";
    const br = bindRunPackageR1({ ...bindInput, execClock });                 // the binder snapshots / owns everything synchronously
    if (!br.ok) return verdictOf(S, "INPUT_INVALID", { binderCode: br.code });
    const B = br.binding; const sc = B.scope;
    const stop = (code) => { if (S.stop === null) S.stop = code; return S.stop; };
    const halted = () => {
      if (S.stop !== null) return true;
      let b; try { b = apply(blocked, undefined, []); } catch { stop("BLOCKED_INVALID"); return true; }
      if (b === true) { stop("STOPPED"); return true; }
      if (b !== false) { stop("BLOCKED_INVALID"); return true; }
      return false;
    };
    const done = (code, extra) => verdictOf(S, S.stop !== null && code !== "PREFLIGHT_OK" ? S.stop : code, extra);
    /** guarded observation of ONE start; the start itself re-checks halted() (blocked-aware at the actual start) */
    const observed = async (ms, start) => {
      if (halted()) return { kind: "not_started", code: S.stop };
      const n = guard.now(); if (!n.ok) { stop("GUARD_FAULT"); return { kind: "not_started", code: "GUARD_FAULT" }; }
      const r = await guard.observe(n.value + ms, () => (halted() ? Promise.reject(NOT_SENT) : start()));
      if (r.kind === "rejected" && r.reason === NOT_SENT) return { kind: "not_started", code: S.stop };
      if (r.kind === "not_started" && r.code !== S.stop) stop("GUARD_FAULT");
      return r;
    };

    // ---------------- DB client ownership (accepted lifecycle / tracker) ----------------
    async function acquire(pool, connect) {
      const r = await lc.observeConnect(nowPlus(LIMITS.CONNECT_MS), () => { if (halted()) return Promise.reject(NOT_SENT); S.connects += 1; return apply(connect, pool, []); },
        (c) => { const rel = dataMethod(c, "release"); if (rel) { try { apply(rel, c, [true]); } catch { /* local */ } } });
      if (r.kind !== "fulfilled") {
        if (r.kind === "timeout") { S.db = "destroyed_client"; return { fail: stop("TIMEOUT_DB_CONNECT") }; }
        if (S.stop !== null) return { fail: S.stop };
        return { fail: stop(r.kind === "rejected" ? "DB_FAILURE" : "GUARD_FAULT") };
      }
      const c = r.client;
      const on = dataMethod(c, "on"); const off = dataMethod(c, "removeListener"); const rel = dataMethod(c, "release"); const query = dataMethod(c, "query");
      if (!on || !off || !rel || !query) { if (rel) { try { apply(rel, c, [true]); } catch { /* local */ } } S.db = "destroyed_client"; return { fail: stop("DB_FAILURE") }; }
      const t = trackClient({ subscribe: (e, h) => apply(on, c, [e, h]), unsubscribe: (e, h) => apply(off, c, [e, h]), destroy: () => apply(rel, c, [true]),
        onLoss: () => { S.db = S.db === "none" ? "destroyed_client" : S.db; stop("CLIENT_LOST"); } });
      if (!t.ok) { S.db = "destroyed_client"; return { fail: stop("DB_FAILURE") }; }
      const h = { client: c, query, tracker: t.tracker, open: true };
      h.release = () => { if (!h.open) return; h.open = false; t.tracker.dispose(); if (t.tracker.state() === "open") { try { apply(rel, c, []); } catch { t.tracker.destroy(); } } };
      h.destroy = (why = "destroyed_client") => { if (!h.open) return; h.open = false; t.tracker.dispose(); t.tracker.destroy(); if (S.db !== "statement_may_still_run") S.db = why; };
      if (t.tracker.state() !== "open") { h.destroy(); return { fail: stop("CLIENT_LOST") }; }
      if (halted()) { h.release(); return { fail: S.stop }; }               // never queried: returned once
      /** the read capability handed to accepted helpers: refuses (nothing sent) once halted or the client is no longer open */
      h.gated = freeze({ query: (sql, params) => {
        if (!h.open || t.tracker.state() !== "open" || halted()) return Promise.reject(NOT_SENT);
        S.statements += 1; return apply(query, c, [sql, params]);
      } });
      return h;
    }
    function nowPlus(ms) { const n = guard.now(); return n.ok ? n.value + ms : -1; }
    /** ONE statement on h (gated); timeout / rejection / fault → the client is DESTROYED (never released while a statement may run) */
    async function statement(h, sql, params) {
      const r = await observed(LIMITS.STATEMENT_MS, () => h.gated.query(sql, params));
      if (r.kind === "fulfilled") { const rows = rowsOf(r.value); if (rows) return { ok: true, rows }; h.destroy(); return { ok: false, code: stop("DB_RESULT_INVALID") }; }
      if (r.kind === "not_started") { if (h.inTx) h.destroy(); return { ok: false, code: S.stop }; }
      if (r.kind === "timeout") { h.destroy("statement_may_still_run"); S.db = "statement_may_still_run"; return { ok: false, code: stop("TIMEOUT_DB_READ") }; }
      h.destroy(); return { ok: false, code: stop(S.stop ?? (r.kind === "rejected" ? "DB_FAILURE" : "GUARD_FAULT")) };
    }
    /** an accepted helper result with a clientDisposition → destroy / release accordingly */
    const disposeAfter = (h, r) => { if (r.clientDisposition === "destroy") h.destroy(); };

    let rep = null; let app = null;
    try {
      // ---------------- L1 same instance / TEST / roles ----------------
      S.step = "L1";
      rep = await acquire(repPool, connRep); if (rep.fail) { const c = rep.fail; rep = null; return done(c); }
      const s1 = await statement(rep, SQL_SAME_DB, []); if (!s1.ok) return done(s1.code);
      app = await acquire(appPool, connApp); if (app.fail) { const c = app.fail; app = null; return done(c); }
      const s2 = await statement(app, SQL_SAME_DB, []); if (!s2.ok) return done(s2.code);
      const same = checkSameDatabase(s1.rows, s2.rows); if (!same.ok) return done(stop(same.code));
      // ---------------- L2 accepted facts snapshot + eligibility + exact identity ----------------
      S.step = "L2";
      if (halted()) return done(S.stop);
      const snap = await readRunSnapshot({ client: rep.gated, intentId: sc.intentId, guard, deadline: nowPlus(LIMITS.SNAPSHOT_MS) });
      if (!snap.ok) {
        disposeAfter(rep, snap);
        if (S.stop !== null) return done(S.stop);
        if (snap.failure === "db") { if (snap.code === "TIMEOUT_DB_READ") S.db = "statement_may_still_run"; return done(stop(PREFLIGHT_CODES.includes(snap.code) ? snap.code : "DB_FAILURE")); }
        return done(stop(PREFLIGHT_CODES.includes(snap.code) ? snap.code : "FACT_MALFORMED"));
      }
      const f = snap.facts; const i = f.intent;
      const cand = deriveRecoveryCandidate(f);
      if (!cand.ok && ["PROTECTED_REFERENCE", "FACT_MALFORMED", "FACTS_INCONSISTENT"].includes(cand.code)) return done(stop(cand.code));
      if (i.state !== "payment_authorized" || writeOps(f).length > 0 || openCase(f)) return done(stop("INTENT_NOT_ELIGIBLE"));
      if (cand.ok || cand.code !== "NO_CANDIDATE") return done(stop("INTENT_NOT_ELIGIBLE"));
      const idOk = i.id === sc.intentId && i.ref === sc.expectedRef && i.listingId === sc.listing.id && i.from === sc.stay.arrival && i.to === sc.stay.departure
        && i.guests === sc.stay.guests && i.finalTotalMinor === sc.amountMinor && i.rateBps === sc.rateBps && i.currency === sc.listing.currency
        && i.stripePaymentIntentId === sc.paymentIntentId && i.hostawayReservationId === null;
      if (!idOk) return done(stop("INTENT_IDENTITY_MISMATCH"));
      const g = await readGuestBinding({ client: app.gated, intentId: sc.intentId, guard, deadline: nowPlus(LIMITS.STATEMENT_MS) });
      if (!g.ok) { disposeAfter(app, g); if (S.stop !== null) return done(S.stop); return done(stop(PREFLIGHT_CODES.includes(g.code) ? g.code : g.failure === "db" ? "DB_FAILURE" : "FACT_MALFORMED")); }
      const guest = g.guest;                                                   // memory only; never in any verdict / digest / log
      app.release(); app = null;
      // ---------------- L3 ONE REPEATABLE READ READ ONLY transaction: loadIntent + payment attempt + exclusion baseline ----------------
      S.step = "L3";
      const b0 = await statement(rep, SQL_BEGIN, []); if (!b0.ok) return done(b0.code);
      rep.inTx = true;
      const li = await observed(LIMITS.STATEMENT_MS, () => loadIntent(rep.gated, sc.intentId));
      if (li.kind !== "fulfilled") { if (li.kind === "timeout") { rep.destroy("statement_may_still_run"); S.db = "statement_may_still_run"; return done(stop("TIMEOUT_DB_READ")); } rep.destroy(); return done(stop(S.stop ?? "DB_FAILURE")); }
      const I = li.value;
      const pay = I && I.payment;
      if (!I || I.version !== i.version || I.status !== "payment_authorized") { rep.destroy(); return done(stop("FACTS_MOVED")); }
      if (!pay || pay.paymentIntentId !== sc.paymentIntentId || pay.livemode !== false || pay.amountMinor !== sc.amountMinor || String(pay.currency || "").toUpperCase() !== sc.listing.currency
        || !Number.isSafeInteger(pay.captureBefore) || !Number.isSafeInteger(pay.authorizationDeadline) || !I.price || I.price.finalTotalMinor !== sc.amountMinor
        || I.price.rateBps !== sc.rateBps) { rep.destroy(); return done(stop("PAYMENT_STATE_INVALID")); }
      const pa = await statement(rep, SQL_PAYMENT_ATTEMPT, [sc.intentId, sc.paymentIntentId]); if (!pa.ok) return done(pa.code);
      if (pa.rows.length !== 1 || typeof pa.rows[0].id !== "string" || !UUID_RE.test(pa.rows[0].id)) { rep.destroy(); return done(stop("PAYMENT_ATTEMPT_NOT_UNIQUE")); }
      const paymentAttemptId = pa.rows[0].id;
      const bl = await readExclusionBaselineR1({ statement: (sql, p) => statement(rep, sql, p), ids: exclusionIdentifiers(B.exclusions), currentIntentId: sc.intentId });
      if (!bl.ok) { if (rep.open) { const c0 = await statement(rep, SQL_COMMIT, []); if (c0.ok) { rep.inTx = false; rep.release(); } } return done(stop(bl.code)); }
      const cm = await statement(rep, SQL_COMMIT, []); if (!cm.ok) return done(cm.code);
      rep.inTx = false; rep.release(); rep = null;
      // ---------------- L4 Stripe (account FIRST, then the bound PaymentIntent) ----------------
      S.step = "L4";
      const stripeCall = (call) => observed(PROVIDER_TIMEOUTS_COPY.readCallMs, () => providerStart((signal) => providerSend(() => apply(sSend, undefined, [call, freeze({ signal })]))));
      const acc = await stripeCall(freeze({ op: "accounts.retrieve" }));
      if (acc.kind !== "fulfilled") return done(providerFail(acc));
      const accObj = acc.value;
      const ao = accObj !== null && typeof accObj === "object" && !types.isProxy(accObj) ? getDesc(accObj, "object") : undefined;
      const aid = accObj !== null && typeof accObj === "object" && !types.isProxy(accObj) ? getDesc(accObj, "id") : undefined;
      if (!ao || ao.value !== "account" || !aid || aid.value !== sc.stripeAccountId) return done(stop("ACCOUNT_MISMATCH"));
      const piR = await stripeCall(freeze({ op: "paymentIntents.retrieve", id: sc.paymentIntentId, params: freeze({ expand: freeze(["latest_charge"]) }) }));
      if (piR.kind !== "fulfilled") return done(providerFail(piR));
      const observedPi = paymentIntentProofObservationV3(piR.value, { accountVerified: true });
      const ev = { kind: "payment_intent", requestRef: sc.paymentIntentId, externalRef: sc.paymentIntentId, status: observedPi.status, observed: observedPi };
      if (stillAuthorizedV3Refusal(ev, I, paymentAttemptId) !== null) return done(stop("PAYMENT_INTENT_PROOF_FAILED"));
      // ---------------- L6 Hostaway: accepted pricing composition + empty ref lookup (ONLY pricing + lookupPage retained) ----------------
      S.step = "L6";
      const L = sc.listing.id;
      const allowed = (r) => (r.method === "GET" && r.path === `/v1/listings/${L}` && Object.keys(r.query).length === 0 && !("body" in r) ? "H3"
        : r.method === "GET" && r.path === `/v1/listings/${L}/calendar` && !("body" in r) ? "H4"
          : r.method === "POST" && r.path === `/v1/listings/${L}/calendar/priceDetails` && "body" in r ? "H5"
            : r.method === "GET" && r.path === "/v1/reservations" && !("body" in r) && r.query.listingId === L ? "H1" : null);
      const gatedHostaway = (req, opts) => {
        const r = snapshotData(req); const form = r && typeof r === "object" && !Array.isArray(r) && r.query && typeof r.query === "object" ? allowed(r) : null;
        if (form === null || halted()) return Promise.reject(NOT_SENT);
        S.forms.push(form);
        return providerSend(() => apply(hSend, undefined, [req, opts]));
      };
      const built = createPhaseExecutors({ phase: "reservation", hostaway: { send: gatedHostaway },
        binding: { listingId: L, arrivalDate: sc.stay.arrival, departureDate: sc.stay.departure, ref: sc.expectedRef, guests: sc.stay.guests, totalMinor: sc.amountMinor,
          currency: sc.listing.currency, refFieldId: sc.listing.refFieldId, guest, reservationId: null } });
      if (!built.ok) return done(stop("EXECUTORS_INVALID"));
      const pricing = built.executors.pricing; const lookupPage = built.executors.lookupPage;   // write executors are dropped here, before any await
      const viaGuard = async (fn) => { const r = await observed(PROVIDER_TIMEOUTS_COPY.pricingCallMs, () => providerStart(fn)); if (r.kind === "fulfilled") return r.value; providerFail(r); throw NOT_SENT; };
      const pc = freeze({
        get: (path, x = {}) => viaGuard((signal) => pricing.get(path, x.query !== undefined ? { query: x.query, signal } : { signal })),
        post: (path, body) => viaGuard((signal) => pricing.post(path, body, { signal }))
      });
      const pol = readDirectPolicyFromEnv({ DIRECT_DISCOUNT_BPS: String(sc.rateBps) });
      if (!pol.ok) return done(stop("POLICY_INVALID"));
      const now = readClock(); if (now === null || now < execClock) return done(stop("CLOCK_INVALID"));
      const priced = await priceStay({ request: { listingId: L, from: sc.stay.arrival, to: sc.stay.departure, guests: sc.stay.guests }, listingConfig: { currency: sc.listing.currency },
        client: pc, policy: pol.policy, today: todayInTimeZone(undefined, new Date(now)), now });
      if (S.stop !== null) return done(S.stop);
      if (S.forms.join(",") !== "H3,H4,H5") return done(stop(priced.ok ? "PRICING_PROOF_INCOMPLETE" : "NOT_BOOKABLE_OR_PRICE_REFUSED"));
      if (!priced.ok) return done(stop("NOT_BOOKABLE_OR_PRICE_REFUSED"));
      if (!compareFinalPrice(I.price, priced.price).same || priced.price.finalTotalMinor !== sc.amountMinor) return done(stop("QUOTE_CHANGED"));
      const lk = await observed(PROVIDER_TIMEOUTS_COPY.readCallMs, () => providerStart((signal) => lookupPage(freeze({ method: "GET", path: "/reservations",
        query: freeze({ listingId: L, channelId: 2000, arrivalStartDate: sc.stay.arrival, arrivalEndDate: sc.stay.arrival, limit: 100, includeResources: 1 }) }), { signal })));
      if (lk.kind !== "fulfilled") return done(providerFail(lk));
      const env = lk.value;
      const st = env && getDesc(env, "httpStatus"); const js = env && getDesc(env, "json");
      if (!st || st.value !== 200 || !js || js.value === null || typeof js.value !== "object" || js.value.status !== "success" || !Array.isArray(js.value.result)) return done(stop("LOOKUP_INVALID"));
      if (js.value.result.length !== 0) return done(stop("REF_LOOKUP_NOT_EMPTY"));
      if (S.forms.join(",") !== "H3,H4,H5,H1") return done(stop("PRICING_PROOF_INCOMPLETE"));
      // ---------------- L5 margin at a FRESH clock, strict, safe integers ----------------
      S.step = "L5";
      if (halted()) return done(S.stop);
      const verdictClock = readClock(); if (verdictClock === null || verdictClock < now) return done(stop("CLOCK_INVALID"));
      const marginMs = pay.authorizationDeadline - verdictClock;
      if (!Number.isSafeInteger(marginMs) || !(marginMs > AUTOMATIC_WORK_BUDGET_MS)) return done(stop("AUTHORIZATION_MARGIN_INSUFFICIENT"), { marginMs: Number.isSafeInteger(marginMs) ? marginMs : null });
      S.step = "DONE";
      const preflightDigest = sha(PREFLIGHT_DIGEST_PREFIX, { packageHash: B.packageHash, executorDigest: B.executorDigest, baselineDigest: bl.baselineDigest,
        intentId: sc.intentId, intentVersion: I.version, paymentAttemptId, pi: { status: observedPi.status, amountMinor: observedPi.amountMinor, currency: observedPi.currency,
          captureBefore: observedPi.latestCharge.captureBefore }, authorizationDeadline: pay.authorizationDeadline, accountId: sc.stripeAccountId,
        quote: { finalTotalMinor: priced.price.finalTotalMinor, quoteHash: priced.price.quoteHash }, lookupCount: 0, execClock, verdictClock });
      return done("PREFLIGHT_OK", { packageHash: B.packageHash, executorDigest: B.executorDigest, baselineDigest: bl.baselineDigest, preflightDigest, marginMs });
    } finally {
      try { if (rep && rep.open) { if (rep.inTx) rep.destroy(); else rep.release(); } } catch { /* local */ }
      try { if (app && app.open) app.release(); } catch { /* local */ }
    }

    /** a provider start: counted, aborted on timeout by the caller's observation; protected replies refuse and stop later reads */
    function providerStart(fn) {
      const ac = new AbortController();
      S.lastAbort = ac;
      return fn(ac.signal);
    }
    function providerSend(f) {
      S.exchanges += 1;
      const p = f();
      // only an UNPATCHED native promise is chained here (the intrinsic then); anything else is handed to the guard unchanged (→ unobservable)
      if (!types.isPromise(p) || types.isProxy(p) || getProto(p) !== Promise.prototype || Reflect.ownKeys(p).some((k) => typeof k === "string")) return p;
      return apply(P_THEN, p, [(v) => { if (containsProtected(v)) { stop("PROTECTED_REFERENCE"); throw NOT_SENT; } return v; }]);
    }
    function providerFail(r) {
      if (r.kind === "timeout" || r.kind === "observation_failed") { try { if (S.lastAbort) S.lastAbort.abort(); } catch { /* local */ } S.tr = "aborted_in_flight"; return stop("TIMEOUT_PROVIDER"); }
      return stop(S.stop ?? "PROVIDER_FAILURE");
    }
  })().catch(() => verdictOf(S, "INTERNAL"));
}
