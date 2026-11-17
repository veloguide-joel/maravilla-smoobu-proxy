// scripts/e7-hosted-booking-confirmation.mjs — E7 C50: HOSTED gn-v2 BOOKING-CONFIRMATION runner for ONE bound TEST guest.notify operation, around the
// ALREADY ACCEPTED tooling (e7-test 5ba7f793 = C116 #180 DRAFT HEAD on top of the #178 merge 9b7a96bf (reviewed head d7e39ae3, tree 40dbe13f): the recipient-only simulation-sink scope + migration 0025; C55 pin was 46b3eaf8; C54 #120 added lib/notify/sender-identity.js): lib/booking-db/notification-worker.js (gn-v2 opt-in + branded Resend provider opt-in, C41 / C45),
// lib/checkout/booking-confirmation-request.js (gn-v2 builder), lib/notify/resend-notification-executor.js (branded executor) and
// scripts/e7-resend/resend-exchange.mjs (the reviewed single-use HTTPS exchange), with the schema-23 typed receipts (0023) on the reviewed schema 26. Nothing here re-implements the worker.
//
// HONEST LABEL: SHIPPED CLOSED. executeEnabled is FALSE: `verify` and `execute` refuse NBC_EXECUTE_CLOSED right after the mode / unexpected-input checks,
// BEFORE any tooling import, credential read, database or provider access. The execute BODY exists so that it can be reviewed and exercised through the
// test-local constants / deps seam on disposable PostgreSQL (schema 26) with FAKE exchanges only. Enabling it is a separate reviewed change (no enable diff
// here). Even then: the sender is the FIXED approved identity bookings@mail.micasadirect.com / MiCasaDirect (C54/C55; equal to the pinned tooling's
// APPROVED_REAL_SENDER, which the accepted worker admits ONLY with gn-v2 + the branded Resend executor). Its sending domain is NOT verified and this
// source claims no sender / auth readiness. The recipient comes ONLY from the database through the accepted `.invalid`-scoped fences (no rewrite, no simulation-sink substitution). C116: the
// fences admit `.invalid` OR exactly the 0025 simulation sink delivered@resend.dev (recipient only; never a sender; no real-recipient / domain policy). Provider acceptance (HTTP 200 + id) is NOT delivery.
//   * Inert on import (`import.meta.main` guard). Self-contained source frame: this file + its two test files + its workflow. Labelled copies of the
//     hosted-boot helpers (scripts/e7-hosted-reservation.mjs) and of the C47/C48 catalog identity probe (scripts/e7-hosted-notify-inspect.mjs) are
//     cross-checked by the tests; no existing runner file is imported or edited.
//   * Exactly ONE bound intent / operation / expected version / locale (en | es) and the fixed sender are in the plan hash. The historical TEST intents
//     abede8b1… and c83c1842… are refused by id; protected reservation ids are refused; listing 606998, TEST, DEV project ref fixed.
//   * Admission (ONE REPEATABLE READ READ ONLY transaction as the runtime app role → ROLLBACK): role proof; catalog identity = EXACTLY the reviewed
//     schema 26 (C116: 0025 sink scope + 0026 claim literal + receipts required; 21 / 22 / 23 / 24 / 25 / drift refused); TEST instance; intent bound (version / listing / USD / confirmed / not protected / not
//     excluded); EXACTLY ONE guest.notify op for the intent and it IS the bound op, pending / attempts 0 / never dispatched / unleased / no result /
//     payload keys exactly ["template"] / booking_confirmed; the reviewed 0016 class ELIGIBLE; no render / latch / receipt; the intent work unleased.
//   * Bound-op contract on the accepted worker (no tooling change): the worker is scoped to the bound intent (claim_notification_work p_intent) and
//     given the accepted `hooks.afterInitialObservation` (runs after the read-only snapshot, BEFORE any claim / latch / render / send) and
//     `hooks.afterClaim`: each throws NBC_BOUND_OP_MISMATCH unless the worker's op is the bound op; the worker's returned opId must match too.
//     Residual (documented worker behaviour): on such a throw the work / op leases are left to expire — no claim / send happens.
//   * Budgets: ONE worker invocation, ONE exchange call (a counting fence in front of the reviewed exchange; a second call is refused), no retry,
//     statement / connect bounds. Any non-acceptance → the worker's durable UNKNOWN (no resend: the lifecycle fences + this admission refuse a rerun).
//   * C51 verified completion: an accepted worker outcome is a success (exit 0) ONLY with ONE valid read-only readback of the bound op matching the durable
//     accepted shape (succeeded / attempts 1 / resend ref / no error / exactly 1 typed receipt / gn-v2 render / plan locale / replay consistent);
//     otherwise ACCEPTED_UNVERIFIED_STOP (acceptance retained, exit 1). Provider acceptance is still NOT delivery (deliveryProven false).
//   * Never: a second send, a retry, a generic sweep, notification / inbox processing beyond the ONE bound op, refund / cancel / void / claim release,
//     or a recipient / name / subject / text / header / key / raw exception in a result or log (codes / hashes / sanitized operation metadata only).
import process from "node:process";
import { readFile, realpath, lstat } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";

const freeze = Object.freeze;
function deepFreeze(v) { if (v && typeof v === "object") { for (const k of Object.keys(v)) deepFreeze(v[k]); freeze(v); } return v; }

/** C116: the reviewed schema-26 catalog identity (0001..0026 at the pinned tooling; 25 → 26 changes only the fn section: 0026 rebinds the claim literal), derived with THIS file's CATALOG_SQL as the runtime app role on
 *  disposable PostgreSQL 16 AND 17.11 (identical). The same derivation reproduces the accepted schema-23 pin byte-for-byte (asserted by the tests).
 *  vs schema 24: only the `fn` section and the read path differ (0025 replaces booking.gn_recipient_in_scope in place). Schemas 21 / 22 / 23 / 24 are refused. */
const CATALOG_PIN_26 = {"catalog":"47b1d904a25cde0f4f9f85b8554b93cd914364d70ef1091cb273ce68043379da","readPath":"31f23b641bb57d5cbdec1aa4896447a574190dd057e4b92e6c5fdf8326220baf","readPathCount":6,"sections":{"con":"550534b1daca47fc1df90a557d5dd28a7f6e1f1df11c581cdbd7a671eb95c188","col":"9d645f671980c7a2e0e679aa07d9a3c30a937e488236f132b589a0a162237fbe","fn":"501f34f7f4db9a5a5fb98c00046013a7904745faea78cd731bbafa23ddf8fb7c","pol":"7c69ad5c06cae91f06e96c8ac9d86d97dbc09e94d95a8afb399b141162ee83ee","rel":"359796c40820562166a4f10dce97ae433fe7ae53c5fd2b3385fc41f179437e89","trg":"13e79df7b90097f365a7f3f15337e58c7b7d5277378608fd482c77e2051982f5"}};

export const CONSTANTS = deepFreeze({
  toolingCommit: "5ba7f793be8ca4e09ec3ce7a7388b34e97dd7cba",          // C116: e7-test #180 DRAFT HEAD (0026 on top of the #178 merge 9b7a96bf); repin to #180's merge commit. #178 merge: tree 40dbe13f == reviewed head d7e39ae3; sink recipient scope + 0025). C55 pin was 46b3eaf8
  toolingStatus: "DRAFT_HEAD",
  executeEnabled: false,                                                // SHIPPED CLOSED: verify / execute refuse NBC_EXECUTE_CLOSED before any import / secret / DB / provider
  // the INDEPENDENTLY scanned transitive relative imports of the five runtime roots at 5ba7f793 (+ package files); bare imports: node:* and pg only
  closure: ["lib/booking-db/notification-worker.js", "lib/booking-db/pool.js", "lib/checkout/booking-confirmation-copy.js", "lib/checkout/booking-confirmation-request.js",
    "lib/checkout/guest-notification.js", "lib/notify/resend-notification-executor.js", "lib/notify/sender-identity.js", "package-lock.json", "package.json", "scripts/e7-connected/probe-env-preflight.mjs",
    "scripts/e7-resend/resend-exchange.mjs"],
  closureDigest: "6f02ce24f92dc0ef4a4d4bbe22adc4203f15f7ec64f36909dd0b1a8d2bd55d06",   // C116: framed SHA-256 of `closure` at 5ba7f793 (== 9b7a96bf == d7e39ae3 closure bytes) (was 4203b451… at 46b3eaf8; only the three C116 files changed) (the test recomputes it from the pinned tree + an independent import scan)
  pgVersion: "8.18.0",
  runnerFiles: ["scripts/e7-hosted-booking-confirmation.mjs", "test/e7-hosted-booking-confirmation.test.mjs", "test/e7-hosted-booking-confirmation-workflow.test.mjs",
    ".github/workflows/e7-hosted-booking-confirmation.yml"],
  listingId: 606998, dbEnvironment: "test", dbProjectRef: "mxotevtiscernhqilyiu", nodeVersion: "22.22.0",
  protectedReservationIds: ["70636076", "71045356", "71072615", "71081885"],
  excludedIntentIds: ["abede8b1-8ef6-44f2-876e-6a02fc056a96", "c83c1842-d342-4e27-9ab7-dc3d50b7a309"],   // historical TEST intents: never admitted
  locales: ["en", "es"],
  // FIXED approved sender (C55): == the pinned tooling's lib/notify/sender-identity.js APPROVED_REAL_SENDER (asserted by the tests). SENDER ONLY: the
  // recipient scope stays the accepted `.invalid` fences. NOT a domain-verification / readiness claim.
  sender: { fromAddress: "bookings@mail.micasadirect.com", fromName: "MiCasaDirect" },
  workerEnv: { VERCEL_ENV: "preview", MV_E7_NOTIFICATION_WORKER: "enabled" },   // the accepted worker's own gate marker, passed ONLY inside the (closed) execute body
  catalogPin26: CATALOG_PIN_26,
  // timing scope: every connect ≤ connectMs (this wrapper; the frozen pool has no connect timeout), every statement ≤ the pool's statement_timeout
  // (statementMs, server-side), ≤ statements in total, ONE provider exchange ≤ the reviewed exchange's own 10 s deadline, pool.end ≤ endMs. Not a single
  // wall clock: the workflow's job timeout is a separate outer cancellation.
  budgets: { workerInvocations: 1, sends: 1, statements: 80, pages: 20, pageLimit: 100, statementMs: 5000, lockMs: 1000, idleMs: 20000, connectMs: 10000, endMs: 5000, rollbackMs: 2000 },
  synthetic: { approvalRef: "SYNTHETIC-booking-confirmation-preflight-not-for-execute", intentId: "00000000-0000-4000-8000-000000000000",
    opId: "00000000-0000-4000-8000-000000000001", expectedVersion: 1, locale: "en" }
});

class Refusal extends Error { constructor(code) { super("e7-hosted-booking-confirmation"); this.code = code; } }
const refuse = (code) => { throw new Refusal(code); };
const sha = (s) => createHash("sha256").update(s).digest("hex");
const HEX64 = /^[0-9a-f]{64}$/; const HEX40 = /^[0-9a-f]{40}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INTENT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const APPROVAL_RE = /^[A-Za-z0-9._:-]{1,80}$/;
const RUN_ID_RE = /^[A-Za-z0-9._:-]{8,64}$/;
const CODE_RE = /^[A-Z][A-Z0-9_]{0,62}$/;
const TOKEN_RE = /^[a-z][a-z0-9_.-]{0,62}$/;
const WORKER_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;

export const PLAN_SCHEMA = "e7-hosted-booking-confirmation-plan-v1";
export const RESULT_SCHEMA = "e7-hosted-booking-confirmation-result-v1";
export const CORE_CODES = freeze(["PROVIDER_ACCEPTED", "PROVIDER_ACCEPTED_REPLAY", "ACCEPTED_UNVERIFIED_STOP", "UNKNOWN_STOP", "NOT_SENT", "NBC_ADMISSION_REFUSED", "NBC_BOUND_OP_MISMATCH",
  "NBC_WORKER_REFUSED", "NBC_WORKER_ERROR", "NBC_EXECUTOR_INVALID", "NBC_DB_FAILED", "NBC_DB_TIMEOUT", "NBC_BUDGET"]);
export const ADMISSION_CODES = freeze(["NOT_READ_ONLY", "ROLE_REFUSED", "CATALOG_NOT_26", "NOT_TEST", "INTENT_NOT_FOUND", "INTENT_EXCLUDED", "LISTING_MISMATCH",
  "VERSION_MISMATCH", "CURRENCY_NOT_USD", "STATE_NOT_CONFIRMED", "PROTECTED", "OP_COUNT", "OP_NOT_BOUND", "OP_NOT_PRISTINE", "OP_PAYLOAD_SHAPE", "TEMPLATE_NOT_V2",
  "CLASS_NOT_ELIGIBLE", "RENDER_PRESENT", "LATCH_PRESENT", "RECEIPT_PRESENT", "WORK_LEASED", "REPLY_SHAPE"]);
export const HOSTED_CODES = freeze(["NBC_USAGE", "NBC_INPUT_UNEXPECTED", "NBC_EXECUTE_CLOSED", "NBC_SECRET_SCOPE_VIOLATION", "NBC_INPUT_INVALID", "NBC_INPUT_INCOMPLETE",
  "NBC_INTENT_EXCLUDED", "NBC_REF_NOT_MAIN", "NBC_LAYOUT_INVALID", "NBC_SOURCE_UNREADABLE", "NBC_SOURCE_MISMATCH", "NBC_CLOSURE_MISMATCH", "NBC_PLAN_HASH_MISMATCH",
  "NBC_IMPORT_FAILED", "NBC_ENV_REFUSED", "NBC_CHILD_FAILED", "NBC_TESTS_FAILED", "NBC_CREDENTIALS_MISSING", "NBC_DEPENDENCY_MISMATCH", "NBC_DB_TARGET_INVALID",
  "NBC_CA_INVALID", "NBC_INTERNAL"]);

// ---- LABELLED COPIES of scripts/e7-hosted-reservation.mjs pure helpers (asserted equal by the tests) -------------------------------------
export function canonical(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
}
const MAX_FILE = 1048576; const MAX_TOTAL = 6291456;
export async function framedDigest(dir, files, prefix) {
  const h = createHash("sha256"); h.update(prefix); let total = 0;
  for (const rel of files) {
    const p = `${dir}/${rel}`; const st = await lstat(p);
    if (!st.isFile() || st.size < 1 || st.size > MAX_FILE) refuse("NBC_SOURCE_UNREADABLE");
    const b = await readFile(p); if (b.length !== st.size) refuse("NBC_SOURCE_UNREADABLE");
    total += b.length; if (total > MAX_TOTAL) refuse("NBC_SOURCE_UNREADABLE");
    h.update(rel); h.update(Buffer.from([0])); h.update(String(b.length)); h.update(Buffer.from([0])); h.update(b); h.update(Buffer.from([0]));
  }
  return h.digest("hex");
}
export const CHILD_ENV_ALLOWLIST = freeze(["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "TZ"]);
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
export function dbTargetOk(url, c = CONSTANTS) {
  let u; try { u = new URL(url); } catch { return false; }
  return (u.protocol === "postgresql:" || u.protocol === "postgres:") && u.hostname === "aws-0-us-east-1.pooler.supabase.com" && u.port === "6543"
    && decodeURIComponent(u.username) === `mv_booking_app_dev.${c.dbProjectRef}` && u.pathname === "/postgres" && u.search === "" && u.hash === "";
}
export const OFFICIAL_CA_SHA256 = "700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7";
/** bounded(promise, ms, onLate) — LABELLED COPY of scripts/e7-hosted-notify-inspect.mjs (C48-F2) */
export function bounded(promise, ms, onLate = () => {}) {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve({ ok: false, timedOut: true }); } }, ms);
    Promise.resolve(promise).then((v) => { if (done) { try { onLate(v); } catch { /* ignore */ } return; } done = true; clearTimeout(t); resolve({ ok: true, value: v }); },
      () => { if (done) return; done = true; clearTimeout(t); resolve({ ok: false, timedOut: false }); });
  });
}
const dispose = (cl) => { try { cl?.release?.(true); } catch { /* ignore */ } };

// ---- the catalog identity probe: LABELLED COPIES of scripts/e7-hosted-notify-inspect.mjs (asserted byte-equal) --------------------------------
export const READ_PATH_FUNCTIONS = freeze(["gn_check_scope", "gn_recipient_in_scope", "guest_notification_class", "guest_notification_protected", "list_guest_notifications",
  "recording_protected_reservation_ids"]);
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

// ---- the plan ------------------------------------------------------------------------------------------------------------------------
export const PLAN_INPUT_KEYS = freeze(["approvalRef", "intentId", "opId", "expectedVersion", "locale"]);
export function buildPlan(c, { approvalRef, intentId, opId, expectedVersion, locale, sourceDigest }) {
  const plan = { schema: PLAN_SCHEMA, kind: "gn-v2-booking-confirmation-one-bound-op", approvalRef, intentId, opId, expectedVersion, locale,
    sender: c.sender, listingId: c.listingId, dbEnvironment: c.dbEnvironment, dbProjectRef: c.dbProjectRef, toolingCommit: c.toolingCommit, closureDigest: c.closureDigest,
    sourceDigest, catalogPin26: c.catalogPin26, excludedIntentIds: c.excludedIntentIds, protectedReservationIds: c.protectedReservationIds,
    budgets: { workerInvocations: c.budgets.workerInvocations, sends: c.budgets.sends }, executeEnabled: c.executeEnabled };
  return { plan: deepFreeze(plan), planHash: sha(canonical(plan)) };
}

// ---- admission: fixed read-only statements (BEGIN … READ ONLY / SELECT / ROLLBACK) ------------------------------------------------------------
export const ADMISSION_QUERIES = deepFreeze({
  begin: "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
  bounds: "SELECT set_config('statement_timeout', $1, true) AS s, set_config('lock_timeout', $2, true) AS l, set_config('idle_in_transaction_session_timeout', $3, true) AS i",
  role: `SELECT current_setting('transaction_read_only') AS ro, current_setting('transaction_isolation') AS iso,
    (SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user) AS su,
    pg_catalog.pg_has_role(current_user, 'mv_booking_app', 'MEMBER') AS app, pg_catalog.pg_has_role(current_user, 'mv_booking_admin', 'MEMBER') AS adm,
    pg_catalog.pg_has_role(current_user, 'mv_booking_report', 'MEMBER') AS rep,
    pg_catalog.pg_has_role(current_user, (SELECT n.nspowner FROM pg_catalog.pg_namespace n WHERE n.nspname = 'booking'), 'MEMBER') AS own`,
  catalog: CATALOG_SQL,
  instance: "SELECT count(*)::int AS n, min(environment) AS env FROM booking.instance",
  intent: `SELECT i.id::text AS id, i.state AS state, i.version AS version, i.listing_id AS listing_id, i.currency AS currency,
    coalesce(i.hostaway_reservation_id = ANY ($2::text[]), false) AS protected_reservation FROM booking.intents i WHERE i.id = $1::uuid`,
  ops: `SELECT o.id::text AS id, o.state AS state, o.attempts AS attempts, (o.dispatched_at IS NOT NULL) AS dispatched,
    (o.lease_worker_id IS NOT NULL OR o.lease_until IS NOT NULL) AS leased, (o.completed_at IS NOT NULL) AS completed, (o.result_ref IS NOT NULL) AS has_result,
    o.payload ->> 'template' AS template, (SELECT coalesce(array_agg(k ORDER BY k), '{}'::text[]) FROM jsonb_object_keys(o.payload) k) AS payload_keys,
    coalesce((o.payload ->> 'reservationId') = ANY ($2::text[]), false) AS protected_payload
    FROM booking.external_operations o WHERE o.intent_id = $1::uuid AND o.op_type = 'guest.notify' ORDER BY o.id`,
  page: "SELECT l.op_id::text AS op_id, l.intent_id::text AS intent_id, l.class AS class FROM booking.list_guest_notifications($1::int[], $2::uuid, $3::int) l",
  artefacts: `SELECT (SELECT count(*)::int FROM booking.notification_renders r WHERE r.operation_id = $1::uuid) AS renders,
    (SELECT count(*)::int FROM booking.notification_latches l WHERE l.operation_id = $1::uuid) AS latches,
    (SELECT count(*)::int FROM booking.notification_provider_receipts p WHERE p.operation_id = $1::uuid) AS receipts,
    (SELECT count(*)::int FROM booking.intent_work w WHERE w.intent_id = $2::uuid AND (w.work_worker_id IS NOT NULL OR w.work_lease_until IS NOT NULL)) AS work_leased`,
  rollback: "ROLLBACK"
});
export const POSTCHECK_QUERY = `SELECT o.state AS state, o.attempts AS attempts, coalesce(o.result_ref LIKE 'resend:%', false) AS resend_ref, o.error_code AS error_code,
    (SELECT count(*)::int FROM booking.notification_provider_receipts p WHERE p.operation_id = o.id) AS receipts,
    (SELECT coalesce(bool_or(p.replayed), false) FROM booking.notification_provider_receipts p WHERE p.operation_id = o.id) AS replayed,
    (SELECT r.template_version FROM booking.notification_renders r WHERE r.operation_id = o.id) AS template_version,
    (SELECT r.locale FROM booking.notification_renders r WHERE r.operation_id = o.id) AS locale
    FROM booking.external_operations o WHERE o.id = $1::uuid`;

// ---- C51: the final readback of the ONE bound op — strict RAW types before any allowlisted mapping (never coerced into plausible null / false) ----
export const READBACK_CODES = freeze(["VERIFIED", "NOT_REQUIRED", "UNAVAILABLE", "MISSING", "MALFORMED", "CONTRADICTS"]);
const READBACK_KEYS = freeze(["attempts", "error_code", "locale", "receipts", "replayed", "resend_ref", "state", "template_version"]);
/** parseReadback(res) → { kind: "OK", value } | { kind: "MISSING" } | { kind: "MALFORMED" } — pure; res = the raw pg result of POSTCHECK_QUERY */
export function parseReadback(res) {
  if (!res || typeof res !== "object" || !Array.isArray(res.rows)) return { kind: "MALFORMED" };
  if (res.rows.length === 0) return { kind: "MISSING" };
  if (res.rows.length !== 1) return { kind: "MALFORMED" };
  const r = res.rows[0];
  if (!r || typeof r !== "object" || JSON.stringify(Object.keys(r).sort()) !== JSON.stringify(READBACK_KEYS)) return { kind: "MALFORMED" };
  const nni = (v) => Number.isSafeInteger(v) && v >= 0;
  if (typeof r.state !== "string" || !TOKEN_RE.test(r.state) || !nni(r.attempts) || typeof r.resend_ref !== "boolean"
      || !(r.error_code === null || (typeof r.error_code === "string" && CODE_RE.test(r.error_code))) || !nni(r.receipts) || typeof r.replayed !== "boolean"
      || !(r.template_version === null || r.template_version === "gn-v1" || r.template_version === "gn-v2") || !(r.locale === null || r.locale === "en" || r.locale === "es")) return { kind: "MALFORMED" };
  return { kind: "OK", value: freeze({ state: r.state, attempts: r.attempts, resendRef: r.resend_ref, errorCode: r.error_code, receipts: r.receipts, replayed: r.replayed,
    templateVersion: r.template_version, locale: r.locale }) };
}
/** verifiesAcceptance(v, plan, replay) — the ONE durable shape of a verified accepted completion of the bound op */
export function verifiesAcceptance(v, plan, replay) {
  return v.state === "succeeded" && v.attempts === 1 && v.resendRef === true && v.errorCode === null && v.receipts === 1 && v.templateVersion === "gn-v2"
    && v.locale === plan.locale && v.replayed === replay;
}

/** admit({ client, plan, c }) → { ok: true } | { ok: false, code }; ONE read-only transaction, always ROLLBACK; throws Refusal(NBC_DB_*) on DB failure */
export async function admit({ client, plan, c = CONSTANTS }) {
  const Q = ADMISSION_QUERIES; let began = false;
  const q = async (k, p) => { try { return await client.query(Q[k], p); } catch (e) { if (e instanceof Refusal) throw e; refuse("NBC_DB_FAILED"); } };
  const no = (code) => { throw Object.assign(new Refusal("NBC_ADMISSION_REFUSED"), { admission: code }); };
  const one = (r) => { if (!r || !Array.isArray(r.rows) || r.rows.length !== 1) no("REPLY_SHAPE"); return r.rows[0]; };
  try {
    await q("begin"); began = true;
    await q("bounds", [String(c.budgets.statementMs), String(c.budgets.lockMs), String(c.budgets.idleMs)]);
    const r = one(await q("role"));
    if (r.ro !== "on" || r.iso !== "repeatable read") no("NOT_READ_ONLY");
    if (r.su !== false || r.app !== true || r.adm !== false || r.rep !== false || r.own !== false) no("ROLE_REFUSED");
    const id = one(await q("catalog", [[...READ_PATH_FUNCTIONS]])).id;
    if (!id || typeof id !== "object" || !id.sections) no("REPLY_SHAPE");
    const sections = {}; for (const k of ["con", "col", "fn", "pol", "rel", "trg"]) sections[k] = id.sections[k] ?? null;
    if (Object.keys(id.sections).some((k) => !Object.hasOwn(sections, k))) no("REPLY_SHAPE");
    if (sha(canonical(sections)) !== c.catalogPin26.catalog || id.readPath !== c.catalogPin26.readPath || id.readPathCount !== c.catalogPin26.readPathCount) no("CATALOG_NOT_26");
    const inst = one(await q("instance")); if (inst.n !== 1 || inst.env !== c.dbEnvironment) no("NOT_TEST");
    if (c.excludedIntentIds.includes(plan.intentId)) no("INTENT_EXCLUDED");
    const ir = await q("intent", [plan.intentId, [...c.protectedReservationIds]]);
    if (!ir || !Array.isArray(ir.rows)) no("REPLY_SHAPE"); if (ir.rows.length === 0) no("INTENT_NOT_FOUND");
    const i = one(ir);
    if (i.id !== plan.intentId) no("REPLY_SHAPE");
    if (i.protected_reservation !== false) no("PROTECTED");
    if (i.listing_id !== c.listingId) no("LISTING_MISMATCH");
    if (i.version !== plan.expectedVersion) no("VERSION_MISMATCH");
    if (i.currency !== "USD") no("CURRENCY_NOT_USD");
    if (i.state !== "confirmed") no("STATE_NOT_CONFIRMED");
    const ops = await q("ops", [plan.intentId, [...c.protectedReservationIds]]);
    if (!ops || !Array.isArray(ops.rows)) no("REPLY_SHAPE"); if (ops.rows.length !== 1) no("OP_COUNT");
    const o = ops.rows[0];
    if (o.id !== plan.opId) no("OP_NOT_BOUND");
    if (o.protected_payload !== false) no("PROTECTED");
    if (!Array.isArray(o.payload_keys) || o.payload_keys.length !== 1 || o.payload_keys[0] !== "template") no("OP_PAYLOAD_SHAPE");
    if (o.template !== "booking_confirmed") no("TEMPLATE_NOT_V2");
    if (o.state !== "pending" || o.attempts !== 0 || o.dispatched !== false || o.leased !== false || o.completed !== false || o.has_result !== false) no("OP_NOT_PRISTINE");
    let cls = null; let cursor = null;
    for (let pages = 1; cls === null; pages += 1) {
      if (pages > c.budgets.pages) refuse("NBC_BUDGET");
      const pg = await q("page", [[c.listingId], cursor, c.budgets.pageLimit]);
      if (!pg || !Array.isArray(pg.rows) || pg.rows.length > c.budgets.pageLimit) no("REPLY_SHAPE");
      for (const x of pg.rows) { if (typeof x.op_id !== "string" || !UUID_RE.test(x.op_id)) no("REPLY_SHAPE"); if (x.op_id === plan.opId) { if (x.intent_id !== plan.intentId) no("REPLY_SHAPE"); cls = String(x.class); break; } }
      if (cls !== null || pg.rows.length < c.budgets.pageLimit) break;
      cursor = pg.rows[pg.rows.length - 1].op_id;
    }
    if (cls !== "ELIGIBLE") no("CLASS_NOT_ELIGIBLE");
    const a = one(await q("artefacts", [plan.opId, plan.intentId]));
    if (a.renders !== 0) no("RENDER_PRESENT"); if (a.latches !== 0) no("LATCH_PRESENT"); if (a.receipts !== 0) no("RECEIPT_PRESENT"); if (a.work_leased !== 0) no("WORK_LEASED");
    return { ok: true };
  } catch (e) {
    if (e instanceof Refusal && e.code === "NBC_ADMISSION_REFUSED") return { ok: false, code: ADMISSION_CODES.includes(e.admission) ? e.admission : "REPLY_SHAPE" };
    throw e;
  } finally {
    if (began) { let rt; try { await Promise.race([client.query(Q.rollback), new Promise((_, rej) => { rt = setTimeout(() => rej(new Error("rollback")), c.budgets.rollbackMs); })]); } catch { /* the connection is discarded */ } finally { clearTimeout(rt); } }
  }
}

/** a counted, connect-bounded view of a pg Pool: exactly the surface the accepted worker uses (query / connect → { query, release }) */
export function countedPool(pool, c, counter) {
  const wrap = (cl) => ({ query: (t, p) => { counter.statements += 1; if (counter.statements > c.budgets.statements) return Promise.reject(new Refusal("NBC_BUDGET")); return cl.query(t, p); },
    release: (d) => cl.release(d) });
  const connect = async () => {
    const r = await bounded(pool.connect(), c.budgets.connectMs, dispose);
    if (!r.ok || !r.value) throw new Refusal(r.timedOut ? "NBC_DB_TIMEOUT" : "NBC_DB_FAILED");
    return wrap(r.value);
  };
  return freeze({ connect, query: async (t, p) => { const cl = await connect(); let bad = false; try { return await cl.query(t, p); } catch (e) { bad = true; throw e; } finally { cl.release(bad ? true : undefined); } } });
}

/**
 * runBookingConfirmationCore({ pool, plan, c, tooling, exchange, credential, runId }) → frozen sanitized result. Never throws.
 * tooling = { runNotificationStep, createResendNotificationExecutor, NOTIFICATION_V2_OPTION_KEY, NOTIFICATION_PROVIDER_OPTION_KEY } (the ACCEPTED modules).
 * exchange = the reviewed single-use Resend exchange function (FAKE in every test); credential = () => key (never logged, never in the result).
 */
export async function runBookingConfirmationCore({ pool, plan, c = CONSTANTS, tooling, exchange, credential, runId }) {
  const out = { schema: RESULT_SCHEMA, code: null, admission: null, workerOutcome: null, workerCode: null, sendsAttempted: 0, workerInvocations: 0, statements: 0,
    providerAccepted: false, providerReplay: false, verifiedCompletion: false, readback: null, deliveryProven: false, postcheck: null };
  const counter = { statements: 0 };
  const cp = countedPool(pool, c, counter);
  try {
    // 1. admission (read-only)
    let ac; try { ac = await cp.connect(); } catch (e) { refuse(e instanceof Refusal ? e.code : "NBC_DB_FAILED"); }
    let adm; try { adm = await admit({ client: ac, plan, c }); } finally { ac.release(true); }
    if (!adm.ok) { out.admission = adm.code; refuse("NBC_ADMISSION_REFUSED"); }
    out.admission = "ADMITTED";
    // 2. the ONE-call fence in front of the reviewed exchange (the executor calls it synchronously, at most once)
    let calls = 0;
    const fenced = (req) => { calls += 1; out.sendsAttempted = calls; if (calls > c.budgets.sends) return Promise.reject(Object.assign(new Error("fence"), { code: "EXCHANGE_SPENT" })); return exchange(req); };
    const ex = tooling.createResendNotificationExecutor({ exchange: fenced, credential, sender: { ...c.sender } });
    if (!ex || ex.ok !== true) refuse("NBC_EXECUTOR_INVALID");
    // 3. ONE accepted-worker invocation, scoped to the bound intent; the bound-op contract enforced through the accepted hooks
    const bind = async (opId) => { if (opId !== plan.opId) throw new Refusal("NBC_BOUND_OP_MISMATCH"); };
    const opts = { env: { ...c.workerEnv }, workerId: `hbc-${runId}`, listingIds: [c.listingId], intentId: plan.intentId, sender: { ...c.sender }, clock: Date.now,
      hooks: { afterInitialObservation: bind, afterClaim: bind }, [tooling.NOTIFICATION_V2_OPTION_KEY]: plan.locale, [tooling.NOTIFICATION_PROVIDER_OPTION_KEY]: ex.executor };
    if (!WORKER_ID_RE.test(opts.workerId)) refuse("NBC_WORKER_REFUSED");
    out.workerInvocations += 1; if (out.workerInvocations > c.budgets.workerInvocations) refuse("NBC_BUDGET");
    let w;
    try { w = await tooling.runNotificationStep(cp, opts); }
    catch (e) { out.code = e instanceof Refusal && ["NBC_BOUND_OP_MISMATCH", "NBC_BUDGET", "NBC_DB_TIMEOUT", "NBC_DB_FAILED"].includes(e.code) ? e.code : "NBC_WORKER_ERROR";
      if (calls > 0 && out.code !== "NBC_BOUND_OP_MISMATCH") out.code = "UNKNOWN_STOP"; throw new Refusal(out.code); }
    if (!w || w.ok !== true) { out.workerCode = w && typeof w.code === "string" && CODE_RE.test(w.code) ? w.code : "REDACTED"; refuse("NBC_WORKER_REFUSED"); }
    out.workerOutcome = typeof w.outcome === "string" && TOKEN_RE.test(w.outcome) ? w.outcome : "redacted";
    out.workerCode = typeof w.code === "string" && CODE_RE.test(w.code) ? w.code : null;
    if (w.opId !== undefined && w.opId !== plan.opId) refuse("NBC_BOUND_OP_MISMATCH");
    if (w.outcome === "accepted") { out.providerAccepted = true; out.providerReplay = w.providerReplay === true; out.code = out.providerReplay ? "PROVIDER_ACCEPTED_REPLAY" : "PROVIDER_ACCEPTED"; }
    else if (w.outcome === "unknown" || w.outcome === "lease_lost" || calls > 0) out.code = "UNKNOWN_STOP";
    else out.code = "NOT_SENT";
  } catch (e) {
    if (out.code === null || !CORE_CODES.includes(out.code)) out.code = e instanceof Refusal && CORE_CODES.includes(e.code) ? e.code : "NBC_WORKER_ERROR";
  }
  // 4. ONE read-only readback of the ONE bound op (no retry, no repair, no provider read). For an ACCEPTED worker outcome it is REQUIRED: only a
  //    valid readback matching the durable accepted shape is a verified completion; unavailable / missing / malformed / contradictory → the explicit
  //    STOP ACCEPTED_UNVERIFIED_STOP with providerAccepted / providerReplay RETAINED (the acceptance already happened: never "nothing happened",
  //    never a permission to resend — the lifecycle fences + admission still refuse a rerun). Other outcomes: informational only, never upgraded.
  if (out.admission === "ADMITTED") {
    let parsed;
    try {
      const pc = await cp.connect();
      try {
        await pc.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        parsed = parseReadback(await pc.query(POSTCHECK_QUERY, [plan.opId]));
        await pc.query("ROLLBACK");
      } finally { pc.release(true); }
    } catch { parsed = { kind: "UNAVAILABLE" }; }
    out.postcheck = parsed.kind === "OK" ? parsed.value : null;
    if (out.providerAccepted) {
      out.readback = parsed.kind !== "OK" ? parsed.kind : (verifiesAcceptance(parsed.value, plan, out.providerReplay) ? "VERIFIED" : "CONTRADICTS");
      out.verifiedCompletion = out.readback === "VERIFIED";
      if (!out.verifiedCompletion) out.code = "ACCEPTED_UNVERIFIED_STOP";
    } else out.readback = parsed.kind === "OK" ? "NOT_REQUIRED" : parsed.kind;
  }
  out.statements = counter.statements;
  return deepFreeze(out);
}

// ---- hosted boot -----------------------------------------------------------------------------------------------------------------------
export const SOURCE_DIGEST_PREFIX = "e7-hosted-booking-confirmation-v1\n";
export const CLOSURE_DIGEST_PREFIX = "e7-hosted-booking-confirmation-closure-v1\n";
const TEST_FILES = freeze(["test/e7-hosted-booking-confirmation.test.mjs", "test/e7-hosted-booking-confirmation-workflow.test.mjs"]);
const SECRET_KEYS = freeze(["E7_DEV_BOOKING_DATABASE_URL", "E7_RESEND_TEST_KEY"]);
export const INPUT_ENV = freeze({ approvalRef: "E7_APPROVAL_REF", intentId: "E7_INTENT_ID", opId: "E7_OP_ID", expectedVersion: "E7_EXPECTED_VERSION", locale: "E7_LOCALE" });
export const ALLOWED_E7_KEYS = freeze([...Object.values(INPUT_ENV), "E7_TOOLING_DIR", "E7_EXPECTED_PLAN_HASH", "E7_EXPECTED_SOURCE_DIGEST", "E7_EXPECTED_CLOSURE_DIGEST",
  "E7_WORKFLOW_SHA", "E7_RUN_ID", "E7_CA_FILE", ...SECRET_KEYS]);

/** runHosted({ mode, env, proc, wrapperDir, deps }) → { exitCode, result }. Never throws. deps = TEST SEAMS (constants included). */
export async function runHosted({ mode = "preflight", env, proc, wrapperDir, deps = {} }) {
  const c = deps.constants ?? CONSTANTS;
  const r = { schema: "e7-hosted-booking-confirmation-hosted-v1", mode: null, code: null, workflowSha: null, toolingCommit: c.toolingCommit, executeEnabled: c.executeEnabled,
    closureDigest: null, sourceDigest: null, planKind: null, planHash: null, runId: null, envCode: null, tests: null, core: null, cleanup: null };
  let pool = null;
  try {
    if (!["preflight", "verify", "execute"].includes(mode)) refuse("NBC_USAGE");
    r.mode = mode;
    const keys = Object.keys(env);                                       // key NAMES only — no value of any variable is read before the next two gates
    if (keys.some((k) => k.startsWith("E7_") && !ALLOWED_E7_KEYS.includes(k))) refuse("NBC_INPUT_UNEXPECTED");
    if (mode !== "preflight" && c.executeEnabled !== true) refuse("NBC_EXECUTE_CLOSED");   // SHIPPED: refuses here — before any import / credential / DB / provider
    const spawnChild = deps.spawnChild ?? spawnNode;
    const importEnv = deps.importEnv ?? ((dir) => import(pathToFileURL(`${dir}/scripts/e7-connected/probe-env-preflight.mjs`).href));
    const importTooling = deps.importTooling ?? defaultImportTooling;
    const runCore = deps.runCore ?? runBookingConfirmationCore;
    const readPgVersion = deps.readPgVersion ?? (async (dir) => JSON.parse(await readFile(`${dir}/node_modules/pg/package.json`, "utf8")).version);
    const readCa = deps.readCa ?? ((p) => readFile(p));
    r.workflowSha = HEX40.test(env.E7_WORKFLOW_SHA ?? "") ? env.E7_WORKFLOW_SHA : null;
    if (mode !== "execute" && SECRET_KEYS.some((k) => keys.includes(k))) refuse("NBC_SECRET_SCOPE_VIOLATION");
    const inp = {}; for (const k of PLAN_INPUT_KEYS) inp[k] = env[INPUT_ENV[k]] ?? "";
    const vals = PLAN_INPUT_KEYS.map((k) => inp[k]); const anyReal = vals.some((v) => v !== "");
    if (anyReal && vals.some((v) => v === "")) refuse("NBC_INPUT_INCOMPLETE");
    if (anyReal && (!APPROVAL_RE.test(inp.approvalRef) || !INTENT_RE.test(inp.intentId) || !UUID_RE.test(inp.opId) || !/^[1-9][0-9]{0,6}$/.test(inp.expectedVersion)
        || !c.locales.includes(inp.locale) || inp.opId === inp.intentId)) refuse("NBC_INPUT_INVALID");
    if (anyReal && (inp.approvalRef === c.synthetic.approvalRef || inp.intentId === c.synthetic.intentId || inp.opId === c.synthetic.opId)) refuse("NBC_INPUT_INVALID");
    if (anyReal && (c.excludedIntentIds.includes(inp.intentId))) refuse("NBC_INTENT_EXCLUDED");
    const expPlan = env.E7_EXPECTED_PLAN_HASH ?? ""; const expSrc = env.E7_EXPECTED_SOURCE_DIGEST ?? ""; const expClo = env.E7_EXPECTED_CLOSURE_DIGEST ?? "";
    const runId = env.E7_RUN_ID ?? "";
    if (mode !== "preflight") {
      if (c.toolingStatus !== "MERGED" || !HEX64.test(String(c.closureDigest))) refuse("NBC_CLOSURE_MISMATCH");
      if (!anyReal || !HEX64.test(expPlan) || !HEX64.test(expSrc) || !HEX64.test(expClo)) refuse("NBC_INPUT_INCOMPLETE");
      if (!RUN_ID_RE.test(runId)) refuse("NBC_INPUT_INVALID");
      if (env.GITHUB_REF !== "refs/heads/main") refuse("NBC_REF_NOT_MAIN");
      if (expClo !== c.closureDigest) refuse("NBC_CLOSURE_MISMATCH");
    }
    const tooling = await realpath(env.E7_TOOLING_DIR ?? "").catch(() => refuse("NBC_LAYOUT_INVALID"));
    const wdir = await realpath(wrapperDir).catch(() => refuse("NBC_LAYOUT_INVALID"));
    if (tooling === wdir || tooling.startsWith(`${wdir}/`) || wdir.startsWith(`${tooling}/`)) refuse("NBC_LAYOUT_INVALID");
    r.closureDigest = await framedDigest(tooling, c.closure, CLOSURE_DIGEST_PREFIX).catch((e) => refuse(e instanceof Refusal ? e.code : "NBC_SOURCE_UNREADABLE"));
    if (r.closureDigest !== c.closureDigest) refuse("NBC_CLOSURE_MISMATCH");           // the pinned bytes are verified BEFORE any tooling import
    r.sourceDigest = await framedDigest(wdir, c.runnerFiles, SOURCE_DIGEST_PREFIX).catch((e) => refuse(e instanceof Refusal ? e.code : "NBC_SOURCE_UNREADABLE"));
    if (mode !== "preflight" && r.sourceDigest !== expSrc) refuse("NBC_SOURCE_MISMATCH");
    r.planKind = anyReal ? "REAL" : "SYNTHETIC";
    const built = buildPlan(c, anyReal ? { ...inp, expectedVersion: Number(inp.expectedVersion), sourceDigest: r.sourceDigest } : { ...c.synthetic, sourceDigest: r.sourceDigest });
    r.planHash = built.planHash;
    if (mode !== "preflight" && built.planHash !== expPlan) refuse("NBC_PLAN_HASH_MISMATCH");
    let C1; try { C1 = await importEnv(tooling); } catch { refuse("NBC_IMPORT_FAILED"); }
    const present = Object.fromEntries(C1.PRESENT_KEYS.map((k) => [k, Object.hasOwn(env, k)]));
    let uid = null; try { if (typeof proc.getuid === "function") { const u = proc.getuid(); if (Number.isSafeInteger(u) && u >= 0) uid = u; } } catch { uid = null; }
    const ev = C1.evaluateProbeEnvironment({ schema: C1.ENV_SNAPSHOT_SCHEMA, nodeVersion: String(proc.versions.node), platform: proc.platform,
      execArgvCount: proc.execArgv.length, uidAvailable: uid !== null, present });
    r.envCode = typeof ev.code === "string" && C1.ENV_CODES.includes(ev.code) ? ev.code : "REDACTED";
    if (ev.ok !== true || proc.versions.node !== c.nodeVersion) refuse("NBC_ENV_REFUSED");
    if (mode === "preflight") {
      const o = await spawnChild(["--test", "--test-reporter=tap", ...TEST_FILES], { cwd: wdir, env: childEnv(env, tooling) });
      if (!o || o.spawnFailed || (o.signal !== null && o.signal !== undefined) || !Number.isSafeInteger(o.status) || o.truncated) refuse("NBC_CHILD_FAILED");
      const num = (re) => { const m = re.exec(o.stdout); return m ? Number(m[1]) : null; };
      r.tests = { status: o.status, tests: num(/^# tests (\d+)$/m), pass: num(/^# pass (\d+)$/m), fail: num(/^# fail (\d+)$/m), skipped: num(/^# skipped (\d+)$/m) };
      if (o.status !== 0 || !(r.tests.tests > 0) || r.tests.pass !== r.tests.tests || r.tests.fail !== 0) refuse("NBC_TESTS_FAILED");
      r.code = anyReal ? "PREFLIGHT_OK_REAL_PLAN" : "PREFLIGHT_OK_SYNTHETIC_ONLY"; return { exitCode: 0, result: r };
    }
    if (mode === "verify") { r.code = "VERIFY_OK"; return { exitCode: 0, result: r }; }
    r.runId = runId;
    if (!SECRET_KEYS.every((k) => typeof env[k] === "string" && env[k].length > 0)) refuse("NBC_CREDENTIALS_MISSING");
    let dbUrl = env.E7_DEV_BOOKING_DATABASE_URL; delete env.E7_DEV_BOOKING_DATABASE_URL;
    let key = env.E7_RESEND_TEST_KEY; delete env.E7_RESEND_TEST_KEY;
    const credential = () => key;
    try {
      let pgv; try { pgv = await readPgVersion(tooling); } catch { pgv = null; }
      if (pgv !== c.pgVersion) refuse("NBC_DEPENDENCY_MISMATCH");
      if (!dbTargetOk(dbUrl, c)) refuse("NBC_DB_TARGET_INVALID");
      let caPem = null;
      try { const b = await readCa(env.E7_CA_FILE ?? ""); if (b.length < 16384 && sha(b) === (deps.caSha256 ?? OFFICIAL_CA_SHA256)) caPem = b.toString("utf8"); } catch { caPem = null; }
      if (caPem === null) refuse("NBC_CA_INVALID");
      let mods; try { mods = await importTooling(tooling); } catch { refuse("NBC_IMPORT_FAILED"); }
      const xr = mods.createResendExchange();
      if (!xr || xr.ok !== true || typeof xr.exchange !== "function") refuse("NBC_IMPORT_FAILED");
      try { pool = mods.createBookingPool({ connectionString: dbUrl, caPem, max: 2, statementTimeoutMs: c.budgets.statementMs }); } catch { refuse("NBC_DB_TARGET_INVALID"); }
      dbUrl = null;
      r.core = await runCore({ pool, plan: built.plan, c, tooling: mods.tooling, exchange: xr.exchange, credential, runId });
    } finally { dbUrl = null; key = null; }
    r.code = "EXECUTE_DONE";
    return { exitCode: r.core && (r.core.code === "PROVIDER_ACCEPTED" || r.core.code === "PROVIDER_ACCEPTED_REPLAY") && r.core.verifiedCompletion === true ? 0 : 1, result: r };
  } catch (e) {
    r.code = e instanceof Refusal && HOSTED_CODES.includes(e.code) ? e.code : "NBC_INTERNAL";
    return { exitCode: 1, result: r };
  } finally {
    if (pool) { let e; try { e = await bounded(pool.end(), c.budgets.endMs); } catch { e = { ok: false, timedOut: false }; } r.cleanup = e.ok ? "POOL_ENDED" : (e.timedOut ? "POOL_END_TIMEOUT" : "POOL_END_FAILED"); }
  }
}
async function defaultImportTooling(dir) {
  const u = (p) => pathToFileURL(`${dir}/${p}`).href;
  const [W, E, X, P] = await Promise.all([import(u("lib/booking-db/notification-worker.js")), import(u("lib/notify/resend-notification-executor.js")),
    import(u("scripts/e7-resend/resend-exchange.mjs")), import(u("lib/booking-db/pool.js"))]);
  return { createBookingPool: P.createBookingPool, createResendExchange: () => X.createResendExchange(),
    tooling: freeze({ runNotificationStep: W.runNotificationStep, createResendNotificationExecutor: E.createResendNotificationExecutor,
      NOTIFICATION_V2_OPTION_KEY: W.NOTIFICATION_V2_OPTION_KEY, NOTIFICATION_PROVIDER_OPTION_KEY: W.NOTIFICATION_PROVIDER_OPTION_KEY }) };
}
export function summaryMarkdown(r) {
  const k = r.core ? ` core=${r.core.code} admission=${r.core.admission ?? "-"} worker=${r.core.workerOutcome ?? "-"}/${r.core.workerCode ?? "-"} sends=${r.core.sendsAttempted} invocations=${r.core.workerInvocations} statements=${r.core.statements} providerAccepted=${r.core.providerAccepted} replay=${r.core.providerReplay} verifiedCompletion=${r.core.verifiedCompletion === true} readback=${r.core.readback ?? "-"} deliveryProven=false` : "";
  return `e7-hosted-booking-confirmation ${r.mode} ${r.code} executeEnabled=${r.executeEnabled} plan=${r.planKind ?? "-"}:${r.planHash ?? "-"} runId=${r.runId ?? "-"} closure=${r.closureDigest ?? "-"} source=${r.sourceDigest ?? "-"} cleanup=${r.cleanup ?? "-"}${k}\n`;
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
