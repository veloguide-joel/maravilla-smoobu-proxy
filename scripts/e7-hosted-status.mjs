// scripts/e7-hosted-status.mjs — E7 C119 S3 (DRAFT): a bounded, READ-ONLY TEST STATUS / RECONCILIATION runner. It REPORTS; it never repairs.
//
// HONEST LABEL: SHIPPED CLOSED. CONSTANTS.readEnabled is FALSE: `verify` and `status` refuse STS_READ_CLOSED from KEY NAMES only — before any
// environment VALUE, tooling import, credential, database or network. MANUAL workflow_dispatch only (no schedule, no arm, no activation wiring);
// this runner is OUTSIDE the C119 S2 arm release (its frame is in no arm component) — wiring it to a schedule / the arm is future, separately reviewed work.
//   * Reads ONLY through the EXISTING runtime role (secret NAME E7_DEV_BOOKING_DATABASE_URL, the pinned DEV pooler target, the pinned CA) in ONE
//     REPEATABLE READ READ ONLY transaction, always ROLLBACK: role proof (runtime app role ONLY), the EXACT schema-27 catalog identity (labelled copy of
//     the C50 runner's probe + pin), TEST instance. Fixed SQL only (no input-selected identifier, no arbitrary SQL); every reply shape-checked; bounded
//     statements / time / rows. No provider credential, no provider call, no write of any kind, no new grant / migration / secret.
//   * Output: per metric { source, scope, status OK | WAIT | ACTION | INFO | UNKNOWN, counts, oldest age in minutes } — codes and counts only,
//     never an intent / op / request / guest / recipient / provider identifier. Missing / unreadable / malformed data → UNKNOWN (never zero, never
//     healthy); a scope larger than the row bound → UNKNOWN (never a partial OK). Overall: UNKNOWN > ATTENTION (any ACTION) > WAIT > OK; INFO never pages.
//   * Thresholds are TECHNICAL TEST-ONLY heuristics (documented in CONSTANTS.thresholds and the C119 S3 notes), not a guest-facing SLA.
import process from "node:process";
import { readFile, realpath, lstat } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

const freeze = Object.freeze;
function deepFreeze(v) { if (v && typeof v === "object") { for (const k of Object.keys(v)) deepFreeze(v[k]); freeze(v); } return v; }

// ---- LABELLED COPIES of scripts/e7-hosted-booking-confirmation.mjs (the schema-27 identity probe + pin; asserted equal by the tests) -----------
const CATALOG_PIN_27 = {"catalog":"bcc116319adfa7c2e0c2f42d32d48b67fdc53ab35cd4058e777e5de5376c6d16","readPath":"b881c9e076b2d113508399dfc0d16322ea5e759fe9fcc6c6ec1eed25324a930a","readPathCount":7,"sections":{"con":"4c9a9148388a8b3846c9ffdb563454b129ea033bf8ee10ec8578db673671b589","col":"4707a34d900203ce83b3a201876fb64897c45c9c10a587f49bb32e753732435f","fn":"6003d12e6fe64492e52bd6e60727cbedaaa047001853b0185413298a5e1d0b49","pol":"f33e232460e9c4d9e4e29945f6e38526fef3551b122efa7a9f8793b182d40b64","rel":"845368cfa6b65e98bbe47af3e8140057be46bcefd1f6ded3034bd1dd06a66d54","trg":"6887ee0464f01e23a8987b963944e856a2065c8e3f0c2e7d6d0d82808018dd42"}};
export const INSPECT_READ_PATH_FUNCTIONS = freeze(["gn_check_scope", "gn_recipient_in_scope", "guest_notification_class", "guest_notification_protected", "list_guest_notifications",
  "recording_protected_reservation_ids"]);
export const READ_PATH_FUNCTIONS = freeze([...INSPECT_READ_PATH_FUNCTIONS, "external_cancellation_public"]);
export const OWNER_ACL_CANON = "CASE WHEN split_part(a.item, '=', 1) = a.owner AND split_part(a.item, '/', 2) = a.owner THEN a.owner || '=' || replace(split_part(split_part(a.item, '=', 2), '/', 1), 'm', '') || '/' || a.owner ELSE a.item END";
export const CATALOG_SQL = `SELECT jsonb_build_object(
  'sections', (SELECT jsonb_object_agg(s.k, s.h) FROM (SELECT q.k, encode(sha256(convert_to(string_agg(q.x, E'\\n' ORDER BY q.x), 'UTF8')), 'hex') AS h FROM (
      SELECT 'fn' AS k, p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')|' || md5(pg_catalog.pg_get_functiondef(p.oid)) || '|' || p.prosecdef::text || '|'
             || p.provolatile::text || '|' || coalesce(array_to_string(p.proconfig, ','), '') || '|' || coalesce((SELECT string_agg(a::text, ',' ORDER BY a::text) FROM unnest(p.proacl) a), '') AS x
        FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'booking'::regnamespace
      UNION ALL SELECT 'rel', c.relname || '|' || c.relkind::text || '|' || pg_catalog.pg_get_userbyid(c.relowner) || '|' || c.relrowsecurity::text || '|' || c.relforcerowsecurity::text || '|'
             || coalesce((SELECT string_agg(z.x, ',' ORDER BY z.x) FROM (SELECT ${OWNER_ACL_CANON} AS x FROM (SELECT unnest(c.relacl)::text AS item, pg_catalog.pg_get_userbyid(c.relowner) AS owner) a) z), '-')
        FROM pg_catalog.pg_class c WHERE c.relnamespace = 'booking'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
      UNION ALL SELECT 'col', c.relname || '|' || a.attname || '|' || pg_catalog.format_type(a.atttypid, a.atttypmod) || '|' || a.attnotnull::text
        FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
       WHERE c.relnamespace = 'booking'::regnamespace AND c.relkind IN ('r', 'p', 'v') AND a.attnum > 0 AND NOT a.attisdropped
      UNION ALL SELECT 'con', c.relname || '|' || k.conname || '|' || pg_catalog.pg_get_constraintdef(k.oid)
        FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_class c ON c.oid = k.conrelid WHERE k.connamespace = 'booking'::regnamespace
      UNION ALL SELECT 'trg', c.relname || '|' || t.tgname || '|' || pg_catalog.pg_get_triggerdef(t.oid)
        FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace = 'booking'::regnamespace AND NOT t.tgisinternal
      UNION ALL SELECT 'pol', c.relname || '|' || pl.polname || '|' || pl.polcmd::text || '|' || coalesce(pg_catalog.pg_get_expr(pl.polqual, pl.polrelid), '') || '|'
             || coalesce(pg_catalog.pg_get_expr(pl.polwithcheck, pl.polrelid), '') || '|'
             || coalesce((SELECT string_agg(z.x, ',' ORDER BY z.x) FROM (SELECT CASE WHEN r = 0 THEN 'public' ELSE r::regrole::text END AS x FROM unnest(pl.polroles) r) z), '')
        FROM pg_catalog.pg_policy pl JOIN pg_catalog.pg_class c ON c.oid = pl.polrelid WHERE c.relnamespace = 'booking'::regnamespace) q GROUP BY q.k) s),
  'readPath', (SELECT encode(sha256(convert_to(coalesce(string_agg(p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')|' || pg_catalog.pg_get_functiondef(p.oid),
      E'\\n' ORDER BY p.proname), ''), 'UTF8')), 'hex')
      FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'booking'::regnamespace AND p.proname = ANY ($1::text[])),
  'readPathCount', (SELECT count(*) FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'booking'::regnamespace AND p.proname = ANY ($1::text[]))) AS id`;

export const CONSTANTS = deepFreeze({
  readEnabled: false,                                                  // SHIPPED CLOSED: verify / status refuse STS_READ_CLOSED from key names only
  toolingCommit: "66133a22edca925e6386c4d178c251fa5f11c82e", toolingStatus: "MERGED",
  closure: ["lib/booking-db/pool.js", "package-lock.json", "package.json"],                     // pool.js imports only `pg` (the test rescans it)
  closureDigest: "20e8a125a7981f6d442bfd61749e22cfd0ee2fefe4272201a413577cf598ef54",
  pgVersion: "8.18.0", nodeVersion: "22.22.0",
  runnerFiles: ["scripts/e7-hosted-status.mjs", "test/e7-hosted-status.test.mjs", "test/e7-hosted-status-workflow.test.mjs", ".github/workflows/e7-hosted-status.yml"],
  listingId: 606998, dbEnvironment: "test", dbProjectRef: "mxotevtiscernhqilyiu",
  catalogPin27: CATALOG_PIN_27,
  // scope: the reviewed kickoff scope (cutoff + exclusions); intents by created_at, kickoff requests by intent_created_at, notifications by op created_at
  scope: { cutoff: "2026-11-15T22:58:01.000Z", excludedIntentIds: ["abede8b1-8ef6-44f2-876e-6a02fc056a96", "c83c1842-d342-4e27-9ab7-dc3d50b7a309", "1d6e770f-ba3d-40f7-92c1-ee01be7da532"],
    maxIntents: 500, notifyPages: 20, notifyPageLimit: 100 },
  // TECHNICAL TEST-ONLY age thresholds (minutes) separating a recent wait from actionable stalled work — NOT a launch SLA
  thresholds: { kickoffRequestedStaleMin: 90, kickoffClaimedStaleMin: 15, kickoffAcceptedNoProgressMin: 30, pipelineStalledMin: 30, authExpiryHorizonMin: 2880,
    opPendingStaleMin: 60, workDueOverdueMin: 30, notifyEligibleStaleMin: 90, notifyWaitingStaleMin: 30, notifyInFlightStaleMin: 30 },
  budgets: { statements: 60, statementMs: 5000, lockMs: 1000, idleMs: 20000, connectMs: 10000, endMs: 5000, rollbackMs: 2000 }
});

class Refusal extends Error { constructor(code) { super("e7-hosted-status"); this.code = code; } }
const refuse = (code) => { throw new Refusal(code); };
const sha = (s) => createHash("sha256").update(s).digest("hex");
const HEX64 = /^[0-9a-f]{64}$/; const HEX40 = /^[0-9a-f]{40}$/;
const RUN_ID_RE = /^[A-Za-z0-9._:-]{8,64}$/;
const CODE_RE = /^[A-Z][A-Z0-9_]{0,62}$/;
export function canonical(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
}
export async function framedDigest(dir, files, prefix) {
  const h = createHash("sha256"); h.update(prefix); let total = 0;
  for (const rel of files) {
    const st = await lstat(`${dir}/${rel}`); if (!st.isFile() || st.size < 1 || st.size > 1048576) refuse("STS_SOURCE_UNREADABLE");
    const b = await readFile(`${dir}/${rel}`); if (b.length !== st.size) refuse("STS_SOURCE_UNREADABLE");
    total += b.length; if (total > 6291456) refuse("STS_SOURCE_UNREADABLE");
    h.update(rel); h.update(Buffer.from([0])); h.update(String(b.length)); h.update(Buffer.from([0])); h.update(b); h.update(Buffer.from([0]));
  }
  return h.digest("hex");
}
export function dbTargetOk(url, c = CONSTANTS) {
  let u; try { u = new URL(url); } catch { return false; }
  return (u.protocol === "postgresql:" || u.protocol === "postgres:") && u.hostname === "aws-0-us-east-1.pooler.supabase.com" && u.port === "6543"
    && decodeURIComponent(u.username) === `mv_booking_app_dev.${c.dbProjectRef}` && u.pathname === "/postgres" && u.search === "" && u.hash === "";
}
export const OFFICIAL_CA_SHA256 = "700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7";
export function bounded(promise, ms, onLate = () => {}) {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve({ ok: false, timedOut: true }); } }, ms);
    Promise.resolve(promise).then((v) => { if (done) { try { onLate(v); } catch { /* ignore */ } return; } done = true; clearTimeout(t); resolve({ ok: true, value: v }); },
      () => { if (done) return; done = true; clearTimeout(t); resolve({ ok: false, timedOut: false }); });
  });
}

// ---- the fixed read-only queries ($1 listing, $2 cutoff, $3 exclusions, $4 asOf | NULL = the statement clock; thresholds in minutes) -------------
const NOW = "coalesce($4::timestamptz, statement_timestamp())";
const SCOPE = `booking.intents i WHERE i.listing_id = $1::int AND i.created_at >= $2::timestamptz AND NOT (i.id = ANY ($3::uuid[]))`;
const AGE = (col) => `floor(extract(epoch FROM (${NOW} - ${col})) / 60)::int`;
export const STATUS_QUERIES = deepFreeze({
  begin: "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
  bounds: "SELECT set_config('statement_timeout', $1, true) AS s, set_config('lock_timeout', $2, true) AS l, set_config('idle_in_transaction_session_timeout', $3, true) AS i",
  role: `SELECT current_setting('transaction_read_only') AS ro, current_setting('transaction_isolation') AS iso,
    (SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user) AS su,
    pg_catalog.pg_has_role(current_user, 'mv_booking_app', 'MEMBER') AS app, pg_catalog.pg_has_role(current_user, 'mv_booking_admin', 'MEMBER') AS adm,
    pg_catalog.pg_has_role(current_user, 'mv_booking_report', 'MEMBER') AS rep,
    pg_catalog.pg_has_role(current_user, (SELECT n.nspowner FROM pg_catalog.pg_namespace n WHERE n.nspname = 'booking'), 'MEMBER') AS own`,
  catalog: CATALOG_SQL,
  instance: "SELECT count(*)::int AS n, min(environment) AS env FROM booking.instance",
  clock: `SELECT ${NOW} IS NOT NULL AS ok, ($4::timestamptz IS NOT NULL) AS synthetic FROM (SELECT $1::int, $2::timestamptz, $3::uuid[]) x`,
  scope: `SELECT count(*)::int AS n FROM ${SCOPE}`,
  kickoff: `SELECT count(*)::int AS total,
      count(*) FILTER (WHERE r.state = 'requested')::int AS requested,
      count(*) FILTER (WHERE r.state = 'requested' AND r.requested_at < ${NOW} - make_interval(mins => $5::int))::int AS requested_stale,
      count(*) FILTER (WHERE r.state = 'claimed')::int AS claimed,
      count(*) FILTER (WHERE r.state = 'claimed' AND r.claimed_at < ${NOW} - make_interval(mins => $6::int))::int AS claimed_stale,
      count(*) FILTER (WHERE r.state = 'dispatch_accepted')::int AS accepted,
      count(*) FILTER (WHERE r.state = 'dispatch_accepted' AND i.state = 'payment_authorized' AND r.settled_at < ${NOW} - make_interval(mins => $7::int))::int AS accepted_no_progress,
      count(*) FILTER (WHERE r.state = 'dispatch_unknown')::int AS dispatch_unknown,
      count(*) FILTER (WHERE r.state IN ('refused', 'dispatch_refused'))::int AS refused,
      count(*) FILTER (WHERE r.state IN ('refused', 'dispatch_refused') AND i.state = 'payment_authorized')::int AS refused_still_authorized,
      count(*) FILTER (WHERE i.id IS NULL)::int AS orphan,
      max(${AGE("r.requested_at")}) FILTER (WHERE r.state = 'requested') AS oldest_requested_min
    FROM booking.pipeline_kickoff_requests r LEFT JOIN booking.intents i ON i.id = r.intent_id
    WHERE r.listing_id = $1::int AND r.intent_created_at >= $2::timestamptz AND NOT (r.intent_id = ANY ($3::uuid[]))`,
  pipeline: `SELECT count(*)::int AS total,
      count(*) FILTER (WHERE i.state IN ('payment_authorized', 'reservation_pending', 'reservation_confirmed', 'payment_captured'))::int AS in_pipeline,
      count(*) FILTER (WHERE i.state IN ('payment_authorized', 'reservation_pending', 'reservation_confirmed', 'payment_captured') AND i.updated_at < ${NOW} - make_interval(mins => $5::int))::int AS stalled,
      count(*) FILTER (WHERE i.state IN ('reservation_unknown', 'capture_unknown', 'reconciliation_required'))::int AS unknown_states,
      count(*) FILTER (WHERE i.state IN ('reservation_failed', 'capture_failed', 'test_cleanup_pending'))::int AS compensating,
      count(*) FILTER (WHERE i.state IN ('reservation_failed', 'capture_failed', 'test_cleanup_pending') AND i.updated_at < ${NOW} - make_interval(mins => $5::int))::int AS compensating_stalled,
      count(*) FILTER (WHERE i.state = 'confirmed')::int AS confirmed,
      count(*) FILTER (WHERE i.state IN ('created', 'price_confirmed', 'details_collected', 'payment_pending'))::int AS pre_payment,
      count(*) FILTER (WHERE i.state IN ('validation_failed', 'expired', 'payment_failed', 'payment_expired', 'authorization_released', 'cancelled'))::int AS closed,
      max(${AGE("i.updated_at")}) FILTER (WHERE i.state IN ('payment_authorized', 'reservation_pending', 'reservation_confirmed', 'payment_captured')) AS oldest_in_pipeline_min,
      count(*) FILTER (WHERE i.state IN ('payment_authorized', 'reservation_pending', 'reservation_confirmed', 'reservation_unknown', 'capture_unknown'))::int AS authorized_uncaptured,
      count(*) FILTER (WHERE i.state IN ('payment_authorized', 'reservation_pending', 'reservation_confirmed', 'reservation_unknown', 'capture_unknown') AND i.capture_before IS NULL)::int AS auth_horizon_missing,
      count(*) FILTER (WHERE i.state IN ('payment_authorized', 'reservation_pending', 'reservation_confirmed', 'reservation_unknown', 'capture_unknown') AND i.capture_before < ${NOW} + make_interval(mins => $6::int))::int AS auth_near_expiry,
      min(floor(extract(epoch FROM (i.capture_before - ${NOW})) / 60)::int) FILTER (WHERE i.state IN ('payment_authorized', 'reservation_pending', 'reservation_confirmed', 'reservation_unknown', 'capture_unknown')) AS min_auth_remaining_min
    FROM ${SCOPE}`,
  operations: `SELECT count(*)::int AS total,
      count(*) FILTER (WHERE o.state = 'outcome_unknown')::int AS outcome_unknown,
      count(*) FILTER (WHERE o.state = 'escalated')::int AS escalated,
      count(*) FILTER (WHERE o.state = 'in_flight' AND o.lease_until < ${NOW})::int AS in_flight_expired,
      count(*) FILTER (WHERE o.state = 'in_flight' AND o.lease_until >= ${NOW})::int AS in_flight_live,
      count(*) FILTER (WHERE o.state = 'pending' AND o.op_type <> 'guest.notify')::int AS pending,
      count(*) FILTER (WHERE o.state = 'pending' AND o.op_type <> 'guest.notify' AND coalesce(o.next_attempt_at, o.created_at) < ${NOW} - make_interval(mins => $5::int))::int AS pending_stale
    FROM booking.external_operations o JOIN booking.intents i ON i.id = o.intent_id
    WHERE i.listing_id = $1::int AND i.created_at >= $2::timestamptz AND NOT (i.id = ANY ($3::uuid[]))`,
  cases: `SELECT count(*) FILTER (WHERE c.status = 'open')::int AS open, max(${AGE("c.opened_at")}) FILTER (WHERE c.status = 'open') AS oldest_open_min
    FROM booking.reconciliation_cases c JOIN booking.intents i ON i.id = c.intent_id
    WHERE i.listing_id = $1::int AND i.created_at >= $2::timestamptz AND NOT (i.id = ANY ($3::uuid[]))`,
  work: `SELECT count(*) FILTER (WHERE w.work_worker_id IS NOT NULL AND w.work_lease_until < ${NOW})::int AS lease_expired,
      count(*) FILTER (WHERE w.work_worker_id IS NOT NULL AND w.work_lease_until >= ${NOW})::int AS lease_live,
      count(*) FILTER (WHERE w.work_worker_id IS NULL AND w.next_action_at < ${NOW} - make_interval(mins => $5::int)
        AND i.state IN ('payment_authorized', 'reservation_pending', 'reservation_confirmed', 'payment_captured', 'reservation_failed', 'capture_failed', 'test_cleanup_pending'))::int AS due_overdue
    FROM booking.intent_work w JOIN booking.intents i ON i.id = w.intent_id
    WHERE i.listing_id = $1::int AND i.created_at >= $2::timestamptz AND NOT (i.id = ANY ($3::uuid[]))`,
  notifyMissing: `SELECT count(*)::int AS n FROM ${SCOPE} AND i.state = 'confirmed'
      AND NOT EXISTS (SELECT 1 FROM booking.external_operations o WHERE o.intent_id = i.id AND o.op_type = 'guest.notify')`,
  notifyPage: `SELECT l.op_id::text AS op_id, l.intent_id::text AS intent_id, l.template AS template, l.class AS class, l.code AS code,
      (l.created_at >= $4::timestamptz) AS in_scope, floor(extract(epoch FROM (coalesce($5::timestamptz, statement_timestamp()) - l.created_at)) / 60)::int AS age_min
    FROM booking.list_guest_notifications($1::int[], $2::uuid, $3::int) l`,
  refunds: `SELECT booking.external_cancellation_public(i.id) AS x FROM ${SCOPE} AND i.state = 'confirmed' ORDER BY i.id LIMIT 501`,
  rollback: "ROLLBACK"
});
export const METRIC_SOURCES = deepFreeze({
  kickoff: "booking.pipeline_kickoff_requests (0024 / 0026) ⨝ booking.intents — runtime SELECT (app_admin_read policy)",
  pipeline: "booking.intents (state, updated_at, capture_before) — runtime SELECT (app_rw policy)",
  operations: "booking.external_operations ⨝ booking.intents — runtime SELECT",
  cases: "booking.reconciliation_cases ⨝ booking.intents — runtime SELECT",
  work: "booking.intent_work ⨝ booking.intents — runtime SELECT",
  notifications: "booking.list_guest_notifications (0016 reviewed page; class + latch code) + booking.external_operations (missing op) — runtime EXECUTE / SELECT",
  refunds: "booking.external_cancellation_public(intent) (0027 minimal projection; the ONLY runtime read of external cancellations) — runtime EXECUTE"
});
export const UNOBSERVED = deepFreeze([
  "STRIPE_LIVE_AUTHORIZATION_STATUS: Stripe is not read (no provider credential); authorization age uses the stored capture_before only",
  "HOSTAWAY_LIVE_RESERVATION_STATUS: Hostaway is not read; a manual Hostaway cancellation is visible only once recorded (0027)",
  "PROVIDER_REFUND_EXECUTION: refunds are manual in the Stripe dashboard; only the attested refund label of the 0027 projection is read",
  "REFUND_ATTESTATION_DETAILS: admin / report-only tables (external_cancellations, external_refund_attestations, payment_refunds amounts) are not read",
  "GITHUB_RUN_STATE: workflow runs / queued jobs / approvals are not read",
  "OUTSIDE_SCOPE: listings other than the TEST listing, intents created before the cutoff, and the excluded historical intents"
]);
export const STATUS_CODES = freeze(["OK", "WAIT", "ACTION", "INFO", "UNKNOWN"]);
export const OVERALL = freeze(["OK", "WAIT", "ATTENTION", "UNKNOWN"]);
export const RESULT_SCHEMA = "e7-hosted-status-result-v1";
const NOTIFY_ACTION_CLASSES = freeze(["UNKNOWN", "OTHER", "OUT_OF_V1_SCOPE", "PROTECTED", "NOT_NOTIFY"]);
const KNOWN_CLASSES = freeze(["ELIGIBLE", "SUCCEEDED", "LATCHED", "WAITING", "IN_FLIGHT", ...NOTIFY_ACTION_CLASSES]);

const nni = (v) => Number.isSafeInteger(v) && v >= 0;
const intOrNull = (v) => v === null || Number.isSafeInteger(v);
function metric(source, scope, status, counts, extra = {}) { return { source, scope, status, counts, ...extra }; }
const unknown = (source, scope, code) => metric(source, scope, "UNKNOWN", null, { code });
const worst = (...s) => (s.includes("UNKNOWN") ? "UNKNOWN" : s.includes("ACTION") ? "ACTION" : s.includes("WAIT") ? "WAIT" : s.includes("INFO") ? "INFO" : "OK");
/** a one-row aggregate whose every listed key is a non-negative integer (or, for *_min, an integer or NULL) → the row | null */
function aggRow(res, ints, mins = []) {
  if (!res || !Array.isArray(res.rows) || res.rows.length !== 1) return null;
  const r = res.rows[0]; if (!r || typeof r !== "object") return null;
  if (JSON.stringify(Object.keys(r).sort()) !== JSON.stringify([...ints, ...mins].sort())) return null;
  for (const k of ints) if (!nni(r[k])) return null;
  for (const k of mins) if (!intOrNull(r[k])) return null;
  return r;
}

/** classifiers (pure, exported for the tests) */
export function classifyKickoff(r) {
  if (!r) return null;
  const st = r.dispatch_unknown > 0 || r.claimed_stale > 0 || r.requested_stale > 0 || r.accepted_no_progress > 0 || r.refused_still_authorized > 0 || r.orphan > 0 ? "ACTION"
    : r.requested > 0 || r.claimed > 0 ? "WAIT" : r.refused > 0 ? "INFO" : "OK";
  return st;
}
export function classifyPipeline(r) {
  if (!r) return { pipeline: null, authorization: null };
  const pipeline = r.stalled > 0 || r.unknown_states > 0 || r.compensating_stalled > 0 ? "ACTION" : r.in_pipeline > 0 || r.compensating > 0 ? "WAIT" : "OK";
  const authorization = r.auth_horizon_missing > 0 ? "UNKNOWN" : r.auth_near_expiry > 0 ? "ACTION" : r.authorized_uncaptured > 0 ? "WAIT" : "OK";
  return { pipeline, authorization };
}
export function classifyOperations(r) { return !r ? null : r.outcome_unknown > 0 || r.escalated > 0 || r.in_flight_expired > 0 || r.pending_stale > 0 ? "ACTION" : r.in_flight_live > 0 || r.pending > 0 ? "WAIT" : "OK"; }
export function classifyCases(r) { return !r ? null : r.open > 0 ? "ACTION" : "OK"; }
export function classifyWork(r) { return !r ? null : r.lease_expired > 0 || r.due_overdue > 0 ? "ACTION" : r.lease_live > 0 ? "WAIT" : "OK"; }
/** notification rows (already shape-checked, in scope, not excluded, template booking_confirmed or other) → { counts, status } */
export function classifyNotifications(rows, missing, t) {
  const c = { bookingConfirmed: 0, succeeded: 0, eligibleRecent: 0, eligibleStale: 0, latchedExternallyCancelled: 0, latchedOther: 0, waitingRecent: 0, waitingStale: 0,
    inFlightRecent: 0, inFlightStale: 0, attentionClass: 0, otherTemplates: 0, otherTemplatesUnresolved: 0, confirmedWithoutNotify: missing, oldestEligibleMin: null };
  for (const x of rows) {
    if (x.template !== "booking_confirmed") { c.otherTemplates += 1; if (x.class === "UNKNOWN" || x.class === "IN_FLIGHT") c.otherTemplatesUnresolved += 1; continue; }
    c.bookingConfirmed += 1;
    if (x.class === "SUCCEEDED") c.succeeded += 1;
    else if (x.class === "ELIGIBLE") { if (x.age_min >= t.notifyEligibleStaleMin) c.eligibleStale += 1; else c.eligibleRecent += 1; c.oldestEligibleMin = Math.max(c.oldestEligibleMin ?? -1, x.age_min); }
    else if (x.class === "LATCHED") { if (x.code === "EXTERNALLY_CANCELLED") c.latchedExternallyCancelled += 1; else c.latchedOther += 1; }
    else if (x.class === "WAITING") { if (x.age_min >= t.notifyWaitingStaleMin) c.waitingStale += 1; else c.waitingRecent += 1; }
    else if (x.class === "IN_FLIGHT") { if (x.age_min >= t.notifyInFlightStaleMin) c.inFlightStale += 1; else c.inFlightRecent += 1; }
    else c.attentionClass += 1;                                                                 // UNKNOWN / OTHER / OUT_OF_V1_SCOPE / PROTECTED / NOT_NOTIFY
  }
  const status = c.eligibleStale + c.latchedOther + c.waitingStale + c.inFlightStale + c.attentionClass + c.otherTemplatesUnresolved + c.confirmedWithoutNotify > 0 ? "ACTION"
    : c.eligibleRecent + c.waitingRecent + c.inFlightRecent > 0 ? "WAIT" : c.latchedExternallyCancelled > 0 ? "INFO" : "OK";
  return { counts: c, status };
}

/**
 * runStatusCore({ pool, c, asOf }) → frozen result. Never throws. ONE read-only snapshot; asOf (ISO string) is a TEST-ONLY synthetic clock seam
 * (the hosted runner always passes null = the database statement clock).
 */
export async function runStatusCore({ pool, c = CONSTANTS, asOf = null }) {
  const out = { schema: RESULT_SCHEMA, overall: "UNKNOWN", code: null, clock: asOf === null ? "database" : "synthetic", metrics: {}, unobserved: [...UNOBSERVED],
    thresholds: { ...c.thresholds }, scope: { listingId: c.listingId, cutoff: c.scope.cutoff, excludedIntents: c.scope.excludedIntentIds.length, maxIntents: c.scope.maxIntents }, statements: 0 };
  const Q = STATUS_QUERIES; let client = null; let began = false; let statements = 0;
  const q = async (t, p) => {
    statements += 1; if (statements > c.budgets.statements) refuse("STS_BUDGET");
    try { return await client.query(t, p); } catch (e) { if (e instanceof Refusal) throw e; refuse("STS_DB_FAILED"); }
  };
  const S = METRIC_SOURCES; const T = c.thresholds; const scopeLabel = `listing ${c.listingId}; created ≥ ${c.scope.cutoff}; ${c.scope.excludedIntentIds.length} excluded`;
  const base = [c.listingId, c.scope.cutoff, [...c.scope.excludedIntentIds], asOf];
  try {
    if (asOf !== null && (typeof asOf !== "string" || !Number.isFinite(Date.parse(asOf)))) refuse("STS_CLOCK_INVALID");
    const r = await bounded(pool.connect(), c.budgets.connectMs, (cl) => { try { cl.release(true); } catch { /* ignore */ } });
    if (!r.ok || !r.value) refuse(r.timedOut ? "STS_DB_TIMEOUT" : "STS_DB_FAILED");
    client = r.value;
    await q(Q.begin); began = true;
    await q(Q.bounds, [String(c.budgets.statementMs), String(c.budgets.lockMs), String(c.budgets.idleMs)]);
    const one = (res) => (res && Array.isArray(res.rows) && res.rows.length === 1 ? res.rows[0] : null);
    const role = one(await q(Q.role));
    if (!role || role.ro !== "on" || role.iso !== "repeatable read") refuse("STS_NOT_READ_ONLY");
    if (role.su !== false || role.app !== true || role.adm !== false || role.rep !== false || role.own !== false) refuse("STS_ROLE_REFUSED");
    const id = one(await q(Q.catalog, [[...READ_PATH_FUNCTIONS]]))?.id;
    if (!id || typeof id !== "object" || !id.sections) refuse("STS_REPLY_SHAPE");
    const sections = {}; for (const k of ["con", "col", "fn", "pol", "rel", "trg"]) sections[k] = id.sections[k] ?? null;
    if (Object.keys(id.sections).some((k) => !Object.hasOwn(sections, k))) refuse("STS_REPLY_SHAPE");
    if (sha(canonical(sections)) !== c.catalogPin27.catalog || id.readPath !== c.catalogPin27.readPath || id.readPathCount !== c.catalogPin27.readPathCount) refuse("STS_CATALOG_NOT_27");
    const inst = one(await q(Q.instance)); if (!inst || inst.n !== 1 || inst.env !== c.dbEnvironment) refuse("STS_NOT_TEST");
    const ck = one(await q(Q.clock, base)); if (!ck || ck.ok !== true || ck.synthetic !== (asOf !== null)) refuse("STS_REPLY_SHAPE");
    const sc = one(await q(Q.scope, base.slice(0, 3)));
    if (!sc || !nni(sc.n)) refuse("STS_REPLY_SHAPE");
    if (sc.n > c.scope.maxIntents) refuse("STS_SCOPE_TOO_LARGE");                                          // never a partial OK
    out.scope.intents = sc.n;
    const M = out.metrics;
    // kickoff
    const kr = aggRow(await q(Q.kickoff, [...base, T.kickoffRequestedStaleMin, T.kickoffClaimedStaleMin, T.kickoffAcceptedNoProgressMin]),
      ["total", "requested", "requested_stale", "claimed", "claimed_stale", "accepted", "accepted_no_progress", "dispatch_unknown", "refused", "refused_still_authorized", "orphan"], ["oldest_requested_min"]);
    M.kickoff = kr ? metric(S.kickoff, `${scopeLabel} (by intent_created_at)`, classifyKickoff(kr), { ...kr }) : unknown(S.kickoff, scopeLabel, "REPLY_SHAPE");
    // pipeline + authorization horizon
    const pr = aggRow(await q(Q.pipeline, [...base, T.pipelineStalledMin, T.authExpiryHorizonMin]),
      ["total", "in_pipeline", "stalled", "unknown_states", "compensating", "compensating_stalled", "confirmed", "pre_payment", "closed", "authorized_uncaptured", "auth_horizon_missing", "auth_near_expiry"],
      ["oldest_in_pipeline_min", "min_auth_remaining_min"]);
    if (pr) {
      const k = classifyPipeline(pr);
      M.pipeline = metric(S.pipeline, scopeLabel, k.pipeline, { total: pr.total, inPipeline: pr.in_pipeline, stalled: pr.stalled, unknownStates: pr.unknown_states, compensating: pr.compensating,
        compensatingStalled: pr.compensating_stalled, confirmed: pr.confirmed, prePayment: pr.pre_payment, closed: pr.closed, oldestInPipelineMin: pr.oldest_in_pipeline_min });
      M.authorization = metric(S.pipeline, `${scopeLabel}; stored capture_before only (Stripe unobserved)`, k.authorization,
        { authorizedUncaptured: pr.authorized_uncaptured, horizonMissing: pr.auth_horizon_missing, nearExpiry: pr.auth_near_expiry, minRemainingMin: pr.min_auth_remaining_min });
    } else { M.pipeline = unknown(S.pipeline, scopeLabel, "REPLY_SHAPE"); M.authorization = unknown(S.pipeline, scopeLabel, "REPLY_SHAPE"); }
    const orow = aggRow(await q(Q.operations, [...base, T.opPendingStaleMin]), ["total", "outcome_unknown", "escalated", "in_flight_expired", "in_flight_live", "pending", "pending_stale"]);
    M.operations = orow ? metric(S.operations, `${scopeLabel}; guest.notify pending is reported under notifications`, classifyOperations(orow), { ...orow }) : unknown(S.operations, scopeLabel, "REPLY_SHAPE");
    const crow = aggRow(await q(Q.cases, base), ["open"], ["oldest_open_min"]);
    M.cases = crow ? metric(S.cases, scopeLabel, classifyCases(crow), { ...crow }) : unknown(S.cases, scopeLabel, "REPLY_SHAPE");
    const wrow = aggRow(await q(Q.work, [...base, T.workDueOverdueMin]), ["lease_expired", "lease_live", "due_overdue"]);
    M.work = wrow ? metric(S.work, scopeLabel, classifyWork(wrow), { ...wrow }) : unknown(S.work, scopeLabel, "REPLY_SHAPE");
    // notifications: the reviewed bounded page (all templates; booking_confirmed classified) + confirmed intents without any notify op
    const miss = aggRow(await q(Q.notifyMissing, base.slice(0, 3)), ["n"]);
    let rows = []; let cursor = null; let pages = 0; let bad = null;
    for (;;) {
      if (pages >= c.scope.notifyPages) { bad = "NOTIFY_BUDGET"; break; }
      pages += 1;
      const pg = await q(Q.notifyPage, [[c.listingId], cursor, c.scope.notifyPageLimit, c.scope.cutoff, asOf]);
      if (!pg || !Array.isArray(pg.rows) || pg.rows.length > c.scope.notifyPageLimit) { bad = "REPLY_SHAPE"; break; }
      for (const x of pg.rows) {
        if (!x || typeof x.op_id !== "string" || typeof x.intent_id !== "string" || typeof x.in_scope !== "boolean" || !Number.isSafeInteger(x.age_min)
            || typeof x.class !== "string" || !KNOWN_CLASSES.includes(x.class) || !(x.template === null || typeof x.template === "string")
            || !(x.code === null || (typeof x.code === "string" && CODE_RE.test(x.code)))) { bad = "REPLY_SHAPE"; break; }
        if (x.in_scope && !c.scope.excludedIntentIds.includes(x.intent_id)) rows.push({ template: x.template, class: x.class, code: x.code, age_min: x.age_min });
      }
      if (bad || pg.rows.length < c.scope.notifyPageLimit) break;
      cursor = pg.rows[pg.rows.length - 1].op_id;
    }
    if (bad || !miss) M.notifications = unknown(S.notifications, scopeLabel, bad ?? "REPLY_SHAPE");
    else { const k = classifyNotifications(rows, miss.n, T); M.notifications = metric(S.notifications, `${scopeLabel} (notify op created ≥ cutoff)`, k.status, k.counts); }
    rows = null;
    // refunds: the 0027 projection for every confirmed intent in scope (bounded); a pending refund is EXPECTED manual work → INFO, never ACTION
    const rf = await q(Q.refunds, base.slice(0, 3));
    if (!rf || !Array.isArray(rf.rows) || rf.rows.length > c.scope.maxIntents) M.refunds = unknown(S.refunds, scopeLabel, "REPLY_SHAPE");
    else {
      const k = { confirmedRead: rf.rows.length, externallyCancelled: 0, refundPending: 0, refundOther: 0, refundNone: 0 }; let malformed = false;
      for (const x of rf.rows) {
        if (!x || typeof x !== "object" || !Object.hasOwn(x, "x")) { malformed = true; break; }
        if (x.x === null) continue;
        const v = x.x; if (!v || typeof v !== "object" || Array.isArray(v) || v.cancelled !== true || !(v.refundStatus === null || (typeof v.refundStatus === "string" && /^[a-z_]{1,40}$/.test(v.refundStatus)))) { malformed = true; break; }
        k.externallyCancelled += 1;
        if (v.refundStatus === "pending") k.refundPending += 1; else if (v.refundStatus === null) k.refundNone += 1; else k.refundOther += 1;
      }
      M.refunds = malformed ? unknown(S.refunds, scopeLabel, "REPLY_SHAPE")
        : metric(S.refunds, `${scopeLabel}; the attested label only (Stripe dashboard execution unobserved)`, k.refundPending > 0 || k.refundNone > 0 ? "INFO" : "OK", k,
          { note: "a pending manual refund is expected owner work (Stripe dashboard): reported, never paged" });
    }
    const all = Object.values(M).map((m) => m.status);
    out.overall = all.includes("UNKNOWN") ? "UNKNOWN" : all.includes("ACTION") ? "ATTENTION" : all.includes("WAIT") ? "WAIT" : "OK";
    out.code = `STATUS_${out.overall}`;
  } catch (e) {
    out.overall = "UNKNOWN"; out.metrics = {}; out.code = e instanceof Refusal ? e.code : "STS_DB_FAILED";
  } finally {
    if (client) {
      if (began) { let rt; try { await Promise.race([client.query(Q.rollback), new Promise((_, rej) => { rt = setTimeout(() => rej(new Error("rb")), c.budgets.rollbackMs); })]); } catch { /* discarded */ } finally { clearTimeout(rt); } }
      try { client.release(true); } catch { /* ignore */ }
    }
  }
  out.statements = statements;
  return deepFreeze(out);
}

// ---- hosted boot ---------------------------------------------------------------------------------------------------------------------------------
export const SOURCE_DIGEST_PREFIX = "e7-hosted-status-v1\n";
export const CLOSURE_DIGEST_PREFIX = "e7-hosted-status-closure-v1\n";
export const SECRET_KEYS = freeze(["E7_DEV_BOOKING_DATABASE_URL"]);
export const ALLOWED_E7_KEYS = freeze(["E7_TOOLING_DIR", "E7_EXPECTED_SOURCE_DIGEST", "E7_EXPECTED_CLOSURE_DIGEST", "E7_WORKFLOW_SHA", "E7_RUN_ID", "E7_CA_FILE", ...SECRET_KEYS]);
export const HOSTED_CODES = freeze(["STS_USAGE", "STS_INPUT_UNEXPECTED", "STS_READ_CLOSED", "STS_SECRET_SCOPE_VIOLATION", "STS_INPUT_INCOMPLETE", "STS_INPUT_INVALID", "STS_REF_NOT_MAIN",
  "STS_LAYOUT_INVALID", "STS_SOURCE_UNREADABLE", "STS_SOURCE_MISMATCH", "STS_CLOSURE_MISMATCH", "STS_ENV_REFUSED", "STS_CREDENTIALS_MISSING", "STS_DEPENDENCY_MISMATCH",
  "STS_DB_TARGET_INVALID", "STS_CA_INVALID", "STS_IMPORT_FAILED", "STS_INTERNAL"]);

/** runHosted({ mode, env, proc, wrapperDir, deps }) → { exitCode, result }. Never throws. deps = TEST SEAMS (constants included). */
export async function runHosted({ mode = "preflight", env, proc, wrapperDir, deps = {} }) {
  const c = deps.constants ?? CONSTANTS;
  const r = { schema: "e7-hosted-status-hosted-v1", mode: null, code: null, readEnabled: c.readEnabled, workflowSha: null, closureDigest: null, sourceDigest: null, runId: null, status: null, cleanup: null };
  let pool = null;
  try {
    if (!["preflight", "verify", "status"].includes(mode)) refuse("STS_USAGE");
    r.mode = mode;
    const keys = Object.keys(env);                                                               // key NAMES only before the next gates
    if (keys.some((k) => k.startsWith("E7_") && !ALLOWED_E7_KEYS.includes(k))) refuse("STS_INPUT_UNEXPECTED");
    if (mode !== "preflight" && c.readEnabled !== true) refuse("STS_READ_CLOSED");                // SHIPPED: refuses HERE — before any value / import / secret / DB
    if (mode !== "status" && SECRET_KEYS.some((k) => keys.includes(k))) refuse("STS_SECRET_SCOPE_VIOLATION");
    const importPool = deps.importPool ?? ((dir) => import(pathToFileURL(`${dir}/lib/booking-db/pool.js`).href));
    const runCore = deps.runCore ?? runStatusCore;
    const readPgVersion = deps.readPgVersion ?? (async (dir) => JSON.parse(await readFile(`${dir}/node_modules/pg/package.json`, "utf8")).version);
    const readCa = deps.readCa ?? ((p) => readFile(p));
    r.workflowSha = HEX40.test(env.E7_WORKFLOW_SHA ?? "") ? env.E7_WORKFLOW_SHA : null;
    const expSrc = env.E7_EXPECTED_SOURCE_DIGEST ?? ""; const expClo = env.E7_EXPECTED_CLOSURE_DIGEST ?? ""; const runId = env.E7_RUN_ID ?? "";
    if (mode !== "preflight") {
      if (c.toolingStatus !== "MERGED" || !HEX64.test(String(c.closureDigest))) refuse("STS_CLOSURE_MISMATCH");
      if (!HEX64.test(expSrc) || !HEX64.test(expClo)) refuse("STS_INPUT_INCOMPLETE");
      if (!RUN_ID_RE.test(runId)) refuse("STS_INPUT_INVALID");
      if (env.GITHUB_REF !== "refs/heads/main") refuse("STS_REF_NOT_MAIN");
      if (expClo !== c.closureDigest) refuse("STS_CLOSURE_MISMATCH");
    }
    const tooling = await realpath(env.E7_TOOLING_DIR ?? "").catch(() => refuse("STS_LAYOUT_INVALID"));
    const wdir = await realpath(wrapperDir).catch(() => refuse("STS_LAYOUT_INVALID"));
    if (tooling === wdir || tooling.startsWith(`${wdir}/`) || wdir.startsWith(`${tooling}/`)) refuse("STS_LAYOUT_INVALID");
    r.closureDigest = await framedDigest(tooling, c.closure, CLOSURE_DIGEST_PREFIX).catch((e) => refuse(e instanceof Refusal ? e.code : "STS_SOURCE_UNREADABLE"));
    if (r.closureDigest !== c.closureDigest) refuse("STS_CLOSURE_MISMATCH");                         // pinned bytes verified BEFORE any import
    r.sourceDigest = await framedDigest(wdir, c.runnerFiles, SOURCE_DIGEST_PREFIX).catch((e) => refuse(e instanceof Refusal ? e.code : "STS_SOURCE_UNREADABLE"));
    if (mode !== "preflight" && r.sourceDigest !== expSrc) refuse("STS_SOURCE_MISMATCH");
    if (proc.versions.node !== c.nodeVersion) refuse("STS_ENV_REFUSED");
    if (mode === "preflight") { r.code = "PREFLIGHT_OK"; return { exitCode: 0, result: r }; }
    if (mode === "verify") { r.code = "VERIFY_OK"; return { exitCode: 0, result: r }; }
    r.runId = runId;
    if (!(typeof env.E7_DEV_BOOKING_DATABASE_URL === "string" && env.E7_DEV_BOOKING_DATABASE_URL.length > 0)) refuse("STS_CREDENTIALS_MISSING");
    let dbUrl = env.E7_DEV_BOOKING_DATABASE_URL; delete env.E7_DEV_BOOKING_DATABASE_URL;
    try {
      let pgv; try { pgv = await readPgVersion(tooling); } catch { pgv = null; }
      if (pgv !== c.pgVersion) refuse("STS_DEPENDENCY_MISMATCH");
      if (!dbTargetOk(dbUrl, c)) refuse("STS_DB_TARGET_INVALID");
      let caPem = null;
      try { const b = await readCa(env.E7_CA_FILE ?? ""); if (b.length < 16384 && sha(b) === (deps.caSha256 ?? OFFICIAL_CA_SHA256)) caPem = b.toString("utf8"); } catch { caPem = null; }
      if (caPem === null) refuse("STS_CA_INVALID");
      let P; try { P = await importPool(tooling); } catch { refuse("STS_IMPORT_FAILED"); }
      try { pool = P.createBookingPool({ connectionString: dbUrl, caPem, max: 1, statementTimeoutMs: c.budgets.statementMs }); } catch { refuse("STS_DB_TARGET_INVALID"); }
      dbUrl = null;
      r.status = await runCore({ pool, c, asOf: null });
    } finally { dbUrl = null; }
    r.code = "STATUS_DONE";
    return { exitCode: r.status && (r.status.overall === "OK" || r.status.overall === "WAIT") ? 0 : 1, result: r };
  } catch (e) {
    r.code = e instanceof Refusal && HOSTED_CODES.includes(e.code) ? e.code : "STS_INTERNAL";
    return { exitCode: 1, result: r };
  } finally {
    if (pool) { let e; try { e = await bounded(pool.end(), c.budgets.endMs); } catch { e = { ok: false, timedOut: false }; } r.cleanup = e.ok ? "POOL_ENDED" : (e.timedOut ? "POOL_END_TIMEOUT" : "POOL_END_FAILED"); }
  }
}
export function summaryMarkdown(r) {
  const s = r.status; const m = s ? Object.entries(s.metrics).map(([k, v]) => `${k}=${v.status}`).join(" ") : "";
  return `e7-hosted-status ${r.mode} ${r.code} readEnabled=${r.readEnabled} source=${r.sourceDigest ?? "-"} closure=${r.closureDigest ?? "-"}${s ? ` overall=${s.overall} ${m}` : ""}\n`;
}

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
