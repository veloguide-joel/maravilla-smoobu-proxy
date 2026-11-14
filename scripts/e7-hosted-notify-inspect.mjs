// scripts/e7-hosted-notify-inspect.mjs — E7 C47 (Slice 6-P): HOSTED READ-ONLY guest-notification ADMISSION INSPECTION for ONE bound TEST
// guest.notify operation on the shared DEV TEST database. It reports how the EXISTING reviewed 0016 classification sees the row (the class the
// accepted worker would act on, the latch code) and safely allowlisted render metadata / hashes. NOTHING ELSE.
//
// HONEST LABEL: MANUAL hosted READ-ONLY inspection (workflow_dispatch + the EXISTING `e7-readonly-probe` reviewer gate). NOT a sender, NOT a worker,
// NOT a claim. No notification executor / transport / worker is imported, constructed or invoked; there is no send / execute mode at all
// (executeEnabled / sendEnabled are FALSE and no code path reads them as permission). Refunds stay manual; all five runner flags stay CLOSED.
//   * Inert on import (`import.meta.main` guard): no env / fs / network / DB / timer until a mode runs.
//   * SELF-CONTAINED source frame: this file + its two test files + its workflow. The few pure hosted-boot helpers (canonical, framedDigest,
//     childEnv, spawnNode, dbTargetOk, the official CA SHA-256, the fixed TEST constants) are LABELLED COPIES of scripts/e7-hosted-reservation.mjs
//     (cross-checked byte-for-behaviour by test/e7-hosted-notify-inspect.test.mjs); no existing runner file is imported or edited.
//   * Immutable tooling: e7-test d322d219 (C46 merge). Its INDEPENDENT closure manifest is only what this runner loads from it at run time:
//     lib/booking-db/pool.js (verified-TLS pool), scripts/e7-connected/probe-env-preflight.mjs (accepted env refusals), package.json and
//     package-lock.json (pg 8.18.0). The disposable-PG tests additionally read the tooling's migrations / harness / fixtures (test-only).
//   * Inputs: approval label, intent UUID (v4), operation UUID, expected intent version, and the exact expected plan / source / closure digests.
//     FIXED: TEST environment, DEV project ref, listing 606998, the protected reservation ids (refused). NO contact / sender / recipient / body /
//     subject / locale input exists; any unexpected E7_* variable is refused before anything else.
//   * The ONE database session (6543 transaction pooler, the runtime app role from the sole secret E7_DEV_BOOKING_DATABASE_URL, verified TLS with
//     the pinned Supabase CA) runs ONE transaction: BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY → SET LOCAL statement / lock / idle bounds →
//     role + read-only proof → catalog identity (pg_catalog only; EXACTLY one of the reviewed schema 21 / 22 / 23 identities, else refused — a
//     future or drifted catalog is never adopted) → TEST instance → the intent / operation binding → the class + latch code through the reviewed
//     STABLE read-only booking.list_guest_notifications (paged, bounded) → allowlisted render / latch / receipt metadata → ROLLBACK. Every
//     statement is a fixed text from QUERIES (asserted). No advisory / session lock is taken (none is needed to read). Never: claim, latch,
//     recover, release, snapshot, presend, complete, suppress, purge, or any write; never a guest name / email / phone / facts / subject / body /
//     header / credential in a query result kept, a log line or the result.
//   * The guest_notification_refusal() detail is OWNER-ONLY in 0016 (not executable by the runtime role) and is NOT recomputed here: the result
//     says so (refusalDetail "UNAVAILABLE_TO_RUNTIME_ROLE") instead of inventing a copy.
import process from "node:process";
import { readFile, realpath, lstat } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";

const freeze = Object.freeze;
function deepFreeze(v) { if (v && typeof v === "object") { for (const k of Object.keys(v)) deepFreeze(v[k]); freeze(v); } return v; }

/** the reviewed catalog identities (pg_catalog-only probe CATALOG_SQL, read as the runtime app role) of the tooling migrations 0001..21 / ..22 / ..23 */
const CATALOG_PINS = {"21":{"catalog":"c81b29c863e577fe6b1b375f5939f1795d50bbab181f888ad71ea84232bf1658","readPath":"b65eddc193d48fe1d03d265084bff9318052226b5f7bc06faa25b881359cea42","readPathCount":6,"sections":{"col":"fc4df946eb4ce7a8973f62ec08f64a4c30af5ff67a9fe16a6d8c1be7c2b3da6d","con":"73e075a81ca19a23eb2aeacd0501e0b81d46457937c45a4e38cd41a7fa65e4fa","fn":"d5f1c5901248783c89fa6346e46c99efd1eb42a2dc4871cf6481f03dc3cb9335","pol":"5d722ffc57a95a8df04328383c7ad56ceb6e6189f15632a218b6bac3d237a16b","rel":"5ddc22a5866f5b3b9c163fd2c93f615322a1fa8468d27463c75f1a44bcd546f7","trg":"e5ecc89050c0d2a3448acc894abf0d6a6930a0927a087e4d632337cb32dfef9a"}},"22":{"catalog":"ff09bb45fdac7a2f88f2f0d41311d3764d8b349b7c5266293a4e6b49ab7b2899","readPath":"b65eddc193d48fe1d03d265084bff9318052226b5f7bc06faa25b881359cea42","readPathCount":6,"sections":{"col":"c3ceb904d9251d9a866bd77f5d1e69096dcb818cc3ffed0745ee06f45839d45b","con":"0d223ff8db8670a8e38feaa448951047b122d9391839f0443391178a39b18f75","fn":"fac3894b2c99ad8abfb84b42b9995e9bfe69df02f84ea7635ad9f63cec8fa237","pol":"5d722ffc57a95a8df04328383c7ad56ceb6e6189f15632a218b6bac3d237a16b","rel":"5ddc22a5866f5b3b9c163fd2c93f615322a1fa8468d27463c75f1a44bcd546f7","trg":"e5ecc89050c0d2a3448acc894abf0d6a6930a0927a087e4d632337cb32dfef9a"}},"23":{"catalog":"80f7360140dd27217941ba41efe97d6399d60e068ee0d3a4cb5cf2dfef36ec19","readPath":"b65eddc193d48fe1d03d265084bff9318052226b5f7bc06faa25b881359cea42","readPathCount":6,"sections":{"col":"60cc4581c26ef735546498ed91fdc15cb28e178978276c90f30eb94e3c5d5efa","con":"0551bcedfedd2195dde1b886f226ad3c571a161ac5ad37680491e8b860de7018","fn":"faa842932cde62c14c41897f12a7ce96b0a155c9b9b2a8d9e2aced13191b1db1","pol":"ae6d6afdc00aff7bb6d809be72d28c9f99f9b29761641c8361cef4282d501cb6","rel":"d42fa6154d8160224460f4975bcc1114268cf7adb9955d12814a9a4e5edb80e5","trg":"8824ff6a6d24a88a164dee959594d44f8e8215423eb082aaea49a9db6d69a874"}}};

export const CONSTANTS = deepFreeze({
  toolingCommit: "d322d2192b377d18b6a9280ae06c17eddfe3e73e",          // e7-test: #115 merged (C46) on top of #114 (C45); immutable
  toolingStatus: "MERGED",
  executeEnabled: false,                                                // there is NO execute / send mode in this runner; never read as permission
  sendEnabled: false,
  closure: ["lib/booking-db/pool.js", "package-lock.json", "package.json", "scripts/e7-connected/probe-env-preflight.mjs"],
  closureDigest: "a703b0130f93a18fc86336d4904f1908d3146665d41cff1d4eabbd7a90da12e0",   // framed SHA-256 of `closure` at d322d219 (test recomputes it from the pinned tree + an independent import scan)
  pgVersion: "8.18.0",
  runnerFiles: ["scripts/e7-hosted-notify-inspect.mjs", "test/e7-hosted-notify-inspect.test.mjs", "test/e7-hosted-notify-inspect-workflow.test.mjs",
    ".github/workflows/e7-hosted-notify-inspect.yml"],
  listingId: 606998, dbEnvironment: "test", dbProjectRef: "mxotevtiscernhqilyiu", nodeVersion: "22.22.0",
  protectedReservationIds: ["70636076", "71045356", "71072615", "71081885"],
  catalogPins: CATALOG_PINS,
  budgets: { statements: 40, pages: 20, pageLimit: 100, statementMs: 5000, lockMs: 1000, idleMs: 20000, overallMs: 30000 },
  synthetic: { approvalRef: "SYNTHETIC-notify-inspect-preflight-not-for-inspect", intentId: "00000000-0000-4000-8000-000000000000",
    opId: "00000000-0000-4000-8000-000000000001", expectedVersion: 1 }
});

class Refusal extends Error { constructor(code) { super("e7-hosted-notify-inspect"); this.code = code; } }
const refuse = (code) => { throw new Refusal(code); };
const sha = (s) => createHash("sha256").update(s).digest("hex");
const HEX64 = /^[0-9a-f]{64}$/; const HEX40 = /^[0-9a-f]{40}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INTENT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const APPROVAL_RE = /^[A-Za-z0-9._:-]{1,80}$/;
const RUN_ID_RE = /^[A-Za-z0-9._:-]{8,64}$/;
const CODE_RE = /^[A-Z][A-Z0-9_]{0,62}$/;
const TOKEN_RE = /^[a-z][a-z0-9_.-]{0,62}$/;

export const PLAN_SCHEMA = "e7-hosted-notify-inspect-plan-v1";
export const RESULT_SCHEMA = "e7-hosted-notify-inspect-result-v1";
export const NOTIFY_CLASSES = freeze(["NOT_NOTIFY", "PROTECTED", "SUCCEEDED", "IN_FLIGHT", "UNKNOWN", "OTHER", "LATCHED", "OUT_OF_V1_SCOPE", "WAITING", "ELIGIBLE"]);
export const CORE_CODES = freeze(["INSPECTED", "NIN_DB_FAILED", "NIN_DB_TIMEOUT", "NIN_BUDGET", "NIN_NOT_READ_ONLY", "NIN_ROLE_REFUSED", "NIN_CATALOG_UNKNOWN",
  "NIN_NOT_TEST", "NIN_INTENT_NOT_FOUND", "NIN_LISTING_MISMATCH", "NIN_VERSION_MISMATCH", "NIN_PROTECTED", "NIN_OP_NOT_FOUND", "NIN_OP_INTENT_MISMATCH",
  "NIN_OP_NOT_NOTIFY", "NIN_OP_PAYLOAD_SHAPE", "NIN_REPLY_SHAPE"]);
export const HOSTED_CODES = freeze(["NIN_USAGE", "NIN_INPUT_UNEXPECTED", "NIN_SECRET_SCOPE_VIOLATION", "NIN_INPUT_INVALID", "NIN_INPUT_INCOMPLETE", "NIN_REF_NOT_MAIN",
  "NIN_LAYOUT_INVALID", "NIN_SOURCE_UNREADABLE", "NIN_SOURCE_MISMATCH", "NIN_CLOSURE_MISMATCH", "NIN_PLAN_HASH_MISMATCH", "NIN_IMPORT_FAILED", "NIN_ENV_REFUSED",
  "NIN_CHILD_FAILED", "NIN_TESTS_FAILED", "NIN_CREDENTIALS_MISSING", "NIN_DEPENDENCY_MISMATCH", "NIN_DB_TARGET_INVALID", "NIN_CA_INVALID", "NIN_INTERNAL"]);

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
    if (!st.isFile() || st.size < 1 || st.size > MAX_FILE) refuse("NIN_SOURCE_UNREADABLE");
    const b = await readFile(p); if (b.length !== st.size) refuse("NIN_SOURCE_UNREADABLE");
    total += b.length; if (total > MAX_TOTAL) refuse("NIN_SOURCE_UNREADABLE");
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

// ---- the plan ------------------------------------------------------------------------------------------------------------------------
export const PLAN_INPUT_KEYS = freeze(["approvalRef", "intentId", "opId", "expectedVersion"]);
export function buildPlan(c, { approvalRef, intentId, opId, expectedVersion, sourceDigest }) {
  const plan = { schema: PLAN_SCHEMA, kind: "notify-admission-inspection-read-only", approvalRef, intentId, opId, expectedVersion,
    listingId: c.listingId, dbEnvironment: c.dbEnvironment, dbProjectRef: c.dbProjectRef, toolingCommit: c.toolingCommit, closureDigest: c.closureDigest,
    sourceDigest, catalogPins: c.catalogPins, protectedReservationIds: c.protectedReservationIds, executeEnabled: false, sendEnabled: false };
  return { plan: deepFreeze(plan), planHash: sha(canonical(plan)) };
}

// ---- the ONLY statements this runner can send (fixed texts; every one is BEGIN / SELECT / ROLLBACK) ----------------------------------------
const READ_PATH = freeze(["gn_check_scope", "gn_recipient_in_scope", "guest_notification_class", "guest_notification_protected", "list_guest_notifications",
  "recording_protected_reservation_ids"]);
export const READ_PATH_FUNCTIONS = READ_PATH;
export const CATALOG_SQL = `SELECT jsonb_build_object(
  'sections', (SELECT jsonb_object_agg(s.k, s.h) FROM (SELECT q.k, encode(sha256(convert_to(string_agg(q.x, E'\\n' ORDER BY q.x), 'UTF8')), 'hex') AS h FROM (
      SELECT 'fn' AS k, p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')|' || md5(pg_catalog.pg_get_functiondef(p.oid)) || '|' || p.prosecdef::text || '|'
             || p.provolatile::text || '|' || coalesce(array_to_string(p.proconfig, ','), '') || '|' || coalesce((SELECT string_agg(a::text, ',' ORDER BY a::text) FROM unnest(p.proacl) a), '') AS x
        FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'booking'::regnamespace
      UNION ALL SELECT 'rel', c.relname || '|' || c.relkind::text || '|' || c.relrowsecurity::text || '|' || c.relforcerowsecurity::text || '|'
             || coalesce((SELECT string_agg(a::text, ',' ORDER BY a::text) FROM unnest(c.relacl) a), '')
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
             || coalesce((SELECT string_agg(CASE WHEN r = 0 THEN 'public' ELSE r::regrole::text END, ',' ORDER BY 1) FROM unnest(pl.polroles) r), '')
        FROM pg_catalog.pg_policy pl JOIN pg_catalog.pg_class c ON c.oid = pl.polrelid WHERE c.relnamespace = 'booking'::regnamespace) q GROUP BY q.k) s),
  'readPath', (SELECT encode(sha256(convert_to(coalesce(string_agg(p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')|' || pg_catalog.pg_get_functiondef(p.oid),
      E'\\n' ORDER BY p.proname), ''), 'UTF8')), 'hex')
      FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'booking'::regnamespace AND p.proname = ANY ($1::text[])),
  'readPathCount', (SELECT count(*) FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'booking'::regnamespace AND p.proname = ANY ($1::text[]))) AS id`;
export const QUERIES = deepFreeze({
  begin: "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
  bounds: "SELECT set_config('statement_timeout', $1, true) AS s, set_config('lock_timeout', $2, true) AS l, set_config('idle_in_transaction_session_timeout', $3, true) AS i",
  role: `SELECT current_setting('transaction_read_only') AS ro, current_setting('transaction_isolation') AS iso, current_user::text AS who,
    (SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user) AS su,
    pg_catalog.pg_has_role(current_user, 'mv_booking_app', 'MEMBER') AS app, pg_catalog.pg_has_role(current_user, 'mv_booking_admin', 'MEMBER') AS adm,
    pg_catalog.pg_has_role(current_user, 'mv_booking_report', 'MEMBER') AS rep,
    pg_catalog.pg_has_role(current_user, (SELECT n.nspowner FROM pg_catalog.pg_namespace n WHERE n.nspname = 'booking'), 'MEMBER') AS own`,
  catalog: CATALOG_SQL,
  instance: "SELECT count(*)::int AS n, min(environment) AS env FROM booking.instance",
  intent: `SELECT i.id::text AS id, i.state AS state, i.version AS version, i.listing_id AS listing_id, i.currency AS currency,
    (i.hostaway_reservation_id IS NOT NULL) AS has_reservation, coalesce(i.hostaway_reservation_id = ANY ($2::text[]), false) AS protected_reservation
    FROM booking.intents i WHERE i.id = $1::uuid`,
  op: `SELECT o.id::text AS id, o.intent_id::text AS intent_id, o.op_type AS op_type, o.state AS state, o.attempts AS attempts, o.source_version AS source_version,
    (o.dispatched_at IS NOT NULL) AS dispatched, (o.lease_worker_id IS NOT NULL OR o.lease_until IS NOT NULL) AS leased, (o.completed_at IS NOT NULL) AS completed,
    o.error_code AS error_code, (o.result_ref IS NOT NULL) AS has_result, o.payload ->> 'template' AS template,
    (SELECT coalesce(array_agg(k ORDER BY k), '{}'::text[]) FROM jsonb_object_keys(o.payload) k) AS payload_keys,
    coalesce((o.payload ->> 'reservationId') = ANY ($2::text[]), false) AS protected_payload
    FROM booking.external_operations o WHERE o.id = $1::uuid`,
  page: "SELECT l.op_id::text AS op_id, l.intent_id::text AS intent_id, l.template AS template, l.state AS state, l.class AS class, l.code AS code FROM booking.list_guest_notifications($1::int[], $2::uuid, $3::int) l",
  render: `SELECT r.template_version AS template_version, r.intent_version AS intent_version, r.message_ref AS message_ref, r.content_hash AS content_hash,
    r.facts_hash AS facts_hash, (r.recipient_hash IS NOT NULL) AS has_recipient_hash, to_jsonb(r) ->> 'locale' AS locale,
    to_jsonb(r) ->> 'copy_contract_version' AS copy_contract_version FROM booking.notification_renders r WHERE r.operation_id = $1::uuid`,
  latch: "SELECT l.code AS code, l.intent_version_seen AS intent_version_seen FROM booking.notification_latches l WHERE l.operation_id = $1::uuid",
  receipts: "SELECT count(*)::int AS n, coalesce(bool_or(p.replayed), false) AS any_replayed FROM booking.notification_provider_receipts p WHERE p.operation_id = $1::uuid",
  rollback: "ROLLBACK"
});

/**
 * inspectNotification({ client, plan, c, now }) → frozen result. client = ONE connected pg client (or a fake with the same .query(text, params)).
 * Never throws; never returns a database error text. The transaction always ends with ROLLBACK (attempted even after a failure).
 */
export async function inspectNotification({ client, plan, c = CONSTANTS, now = Date.now }) {
  const out = { schema: RESULT_SCHEMA, code: null, stage: null, statements: 0, catalogSchema: null, catalogSections: null, admission: null };
  const start = now(); let stage = "begin"; let began = false;
  const deadline = start + c.budgets.overallMs;
  const run = async (key, params) => {
    out.statements += 1;
    if (out.statements > c.budgets.statements) refuse("NIN_BUDGET");
    const remain = deadline - now();
    if (remain <= 0) refuse("NIN_DB_TIMEOUT");
    let timer;
    const t = new Promise((_, rej) => { timer = setTimeout(() => rej(new Refusal("NIN_DB_TIMEOUT")), remain); });
    try { return await Promise.race([client.query(QUERIES[key], params), t]); }
    catch (e) { if (e instanceof Refusal) throw e; refuse("NIN_DB_FAILED"); }
    finally { clearTimeout(timer); }
  };
  const one = (res) => { if (!res || !Array.isArray(res.rows) || res.rows.length !== 1) refuse("NIN_REPLY_SHAPE"); return res.rows[0]; };
  const bool = (v) => { if (v !== true && v !== false) refuse("NIN_REPLY_SHAPE"); return v; };
  const int = (v) => { if (!Number.isSafeInteger(v)) refuse("NIN_REPLY_SHAPE"); return v; };
  const codeOrNull = (v) => { if (v === null) return null; if (typeof v !== "string" || !CODE_RE.test(v)) refuse("NIN_REPLY_SHAPE"); return v; };
  try {
    stage = "begin"; await run("begin"); began = true;
    stage = "bounds"; await run("bounds", [String(c.budgets.statementMs), String(c.budgets.lockMs), String(c.budgets.idleMs)]);
    stage = "role"; const r = one(await run("role"));
    if (r.ro !== "on" || r.iso !== "repeatable read") refuse("NIN_NOT_READ_ONLY");
    if (bool(r.su) || !bool(r.app) || bool(r.adm) || bool(r.rep) || bool(r.own)) refuse("NIN_ROLE_REFUSED");
    stage = "catalog"; const id = one(await run("catalog", [[...READ_PATH]])).id;
    if (!id || typeof id !== "object" || !id.sections || typeof id.sections !== "object") refuse("NIN_REPLY_SHAPE");
    const sections = {}; for (const k of ["con", "col", "fn", "pol", "rel", "trg"]) { const h = id.sections[k] ?? null; if (h !== null && !HEX64.test(h)) refuse("NIN_REPLY_SHAPE"); sections[k] = h; }
    if (Object.keys(id.sections).some((k) => !Object.hasOwn(sections, k))) refuse("NIN_REPLY_SHAPE");
    out.catalogSections = sections;
    const catalog = sha(canonical(sections));
    const match = Object.entries(c.catalogPins).filter(([, p]) => p.catalog === catalog && p.readPath === id.readPath && p.readPathCount === id.readPathCount).map(([v]) => v);
    if (match.length !== 1) refuse("NIN_CATALOG_UNKNOWN");
    out.catalogSchema = Number(match[0]);
    stage = "instance"; const inst = one(await run("instance"));
    if (inst.n !== 1 || inst.env !== c.dbEnvironment) refuse("NIN_NOT_TEST");
    stage = "intent"; const ir = (await run("intent", [plan.intentId, [...c.protectedReservationIds]]));
    if (!ir || !Array.isArray(ir.rows)) refuse("NIN_REPLY_SHAPE");
    if (ir.rows.length === 0) refuse("NIN_INTENT_NOT_FOUND");
    const i = one(ir);
    if (i.id !== plan.intentId) refuse("NIN_REPLY_SHAPE");
    if (bool(i.protected_reservation)) refuse("NIN_PROTECTED");
    if (int(i.listing_id) !== c.listingId) refuse("NIN_LISTING_MISMATCH");
    if (int(i.version) !== plan.expectedVersion) refuse("NIN_VERSION_MISMATCH");
    if (typeof i.state !== "string" || !TOKEN_RE.test(i.state) || typeof i.currency !== "string" || !/^[A-Z]{3}$/.test(i.currency)) refuse("NIN_REPLY_SHAPE");
    stage = "op"; const orr = await run("op", [plan.opId, [...c.protectedReservationIds]]);
    if (!orr || !Array.isArray(orr.rows)) refuse("NIN_REPLY_SHAPE");
    if (orr.rows.length === 0) refuse("NIN_OP_NOT_FOUND");
    const o = one(orr);
    if (o.id !== plan.opId) refuse("NIN_REPLY_SHAPE");
    if (o.intent_id !== plan.intentId) refuse("NIN_OP_INTENT_MISMATCH");
    if (o.op_type !== "guest.notify") refuse("NIN_OP_NOT_NOTIFY");
    if (bool(o.protected_payload)) refuse("NIN_PROTECTED");
    if (!Array.isArray(o.payload_keys) || o.payload_keys.length !== 1 || o.payload_keys[0] !== "template") refuse("NIN_OP_PAYLOAD_SHAPE");
    if (typeof o.template !== "string" || !TOKEN_RE.test(o.template) || typeof o.state !== "string" || !TOKEN_RE.test(o.state)) refuse("NIN_REPLY_SHAPE");
    const opv = { state: o.state, attempts: int(o.attempts), sourceVersionMatchesIntent: int(o.source_version) === i.version, dispatched: bool(o.dispatched), leased: bool(o.leased),
      completed: bool(o.completed), hasResultRef: bool(o.has_result), errorCode: codeOrNull(o.error_code), template: o.template };
    stage = "class"; let row = null; let cursor = null; let pages = 0;
    while (row === null) {
      pages += 1; if (pages > c.budgets.pages) refuse("NIN_BUDGET");
      const pg = await run("page", [[c.listingId], cursor, c.budgets.pageLimit]);
      if (!pg || !Array.isArray(pg.rows) || pg.rows.length > c.budgets.pageLimit) refuse("NIN_REPLY_SHAPE");
      for (const x of pg.rows) { if (typeof x.op_id !== "string" || !UUID_RE.test(x.op_id)) refuse("NIN_REPLY_SHAPE"); if (x.op_id === plan.opId) { row = x; break; } }
      if (row !== null || pg.rows.length < c.budgets.pageLimit) break;
      cursor = pg.rows[pg.rows.length - 1].op_id;
    }
    let cls = "NOT_LISTED"; let latchCode = null;
    if (row !== null) {
      if (row.intent_id !== plan.intentId || row.template !== o.template || row.state !== o.state || !NOTIFY_CLASSES.includes(row.class)) refuse("NIN_REPLY_SHAPE");
      cls = row.class; latchCode = codeOrNull(row.code);
    }
    stage = "render"; const rr = await run("render", [plan.opId]);
    if (!rr || !Array.isArray(rr.rows) || rr.rows.length > 1) refuse("NIN_REPLY_SHAPE");
    let render = null;
    if (rr.rows.length === 1) {
      const x = rr.rows[0];
      const optTok = (v) => { if (v === null) return null; if (typeof v !== "string" || !TOKEN_RE.test(v)) refuse("NIN_REPLY_SHAPE"); return v; };
      if (typeof x.template_version !== "string" || !/^gn-v[12]$/.test(x.template_version) || typeof x.message_ref !== "string" || x.message_ref !== `${x.template_version === "gn-v2" ? "gn2" : "gn1"}-${plan.opId}`
          || !HEX64.test(x.content_hash ?? "") || !HEX64.test(x.facts_hash ?? "")) refuse("NIN_REPLY_SHAPE");
      render = { templateVersion: x.template_version, intentVersion: int(x.intent_version), messageRef: x.message_ref, contentHash: x.content_hash, factsHash: x.facts_hash,
        hasRecipientHash: bool(x.has_recipient_hash), locale: optTok(x.locale), copyContractVersion: optTok(x.copy_contract_version) };
    }
    stage = "latch"; const lr = await run("latch", [plan.opId]);
    if (!lr || !Array.isArray(lr.rows) || lr.rows.length > 1) refuse("NIN_REPLY_SHAPE");
    const latch = lr.rows.length === 1 ? { code: codeOrNull(lr.rows[0].code), intentVersionSeen: int(lr.rows[0].intent_version_seen) } : null;
    let receipts = "UNAVAILABLE_AT_SCHEMA_" + out.catalogSchema;
    if (out.catalogSchema === 23) {
      stage = "receipts"; const pr = one(await run("receipts", [plan.opId]));
      receipts = { count: int(pr.n), anyReplayed: bool(pr.any_replayed) };
    }
    out.admission = deepFreeze({ intent: { state: i.state, version: i.version, listingId: i.listing_id, currency: i.currency, hasReservation: bool(i.has_reservation) },
      operation: opv, notifyClass: cls, latchCode, refusalDetail: "UNAVAILABLE_TO_RUNTIME_ROLE", render, latch, receipts,
      eligibleBy0016Class: cls === "ELIGIBLE", note: "read-only inspection; no claim / latch / recover / release / send; class is the reviewed 0016 view" });
    out.code = "INSPECTED"; out.stage = "done";
  } catch (e) {
    out.code = e instanceof Refusal && CORE_CODES.includes(e.code) ? e.code : "NIN_DB_FAILED";
    out.stage = stage; out.admission = null;
  } finally {
    if (began) {
      try { out.statements += 1; await Promise.race([client.query(QUERIES.rollback), new Promise((_, rej) => setTimeout(() => rej(new Error("rollback timeout")), 2000).unref?.())]); }
      catch { if (out.code === "INSPECTED") { out.code = "NIN_DB_FAILED"; out.stage = "rollback"; out.admission = null; } }
    }
  }
  return deepFreeze(out);
}

// ---- hosted boot -----------------------------------------------------------------------------------------------------------------------
export const SOURCE_DIGEST_PREFIX = "e7-hosted-notify-inspect-v1\n";
export const CLOSURE_DIGEST_PREFIX = "e7-hosted-notify-inspect-closure-v1\n";
const TEST_FILES = freeze(["test/e7-hosted-notify-inspect.test.mjs", "test/e7-hosted-notify-inspect-workflow.test.mjs"]);
const SECRET_KEYS = freeze(["E7_DEV_BOOKING_DATABASE_URL"]);
export const INPUT_ENV = freeze({ approvalRef: "E7_APPROVAL_REF", intentId: "E7_INTENT_ID", opId: "E7_OP_ID", expectedVersion: "E7_EXPECTED_VERSION" });
/** EVERY E7_* variable this runner admits; any other E7_* name (a recipient, sender, body, key, token …) is refused before anything else */
export const ALLOWED_E7_KEYS = freeze([...Object.values(INPUT_ENV), "E7_TOOLING_DIR", "E7_EXPECTED_PLAN_HASH", "E7_EXPECTED_SOURCE_DIGEST", "E7_EXPECTED_CLOSURE_DIGEST",
  "E7_WORKFLOW_SHA", "E7_RUN_ID", "E7_CA_FILE", ...SECRET_KEYS]);

/** runHosted({ mode, env, proc, wrapperDir, deps }) → { exitCode, result }. Never throws. deps = TEST SEAMS. */
export async function runHosted({ mode = "preflight", env, proc, wrapperDir, deps = {} }) {
  const c = deps.constants ?? CONSTANTS;
  const spawnChild = deps.spawnChild ?? spawnNode;
  const importEnv = deps.importEnv ?? ((dir) => import(pathToFileURL(`${dir}/scripts/e7-connected/probe-env-preflight.mjs`).href));
  const importPool = deps.importPool ?? ((dir) => import(pathToFileURL(`${dir}/lib/booking-db/pool.js`).href));
  const inspect = deps.inspect ?? inspectNotification;
  const readPgVersion = deps.readPgVersion ?? (async (dir) => JSON.parse(await readFile(`${dir}/node_modules/pg/package.json`, "utf8")).version);
  const readCa = deps.readCa ?? ((p) => readFile(p));
  const r = { schema: "e7-hosted-notify-inspect-hosted-v1", mode: null, code: null, workflowSha: null, toolingCommit: c.toolingCommit, toolingStatus: c.toolingStatus,
    executeEnabled: c.executeEnabled, sendEnabled: c.sendEnabled, closureDigest: null, sourceDigest: null, planKind: null, planHash: null, runId: null, envCode: null, tests: null, core: null };
  let pool = null; let client = null;
  try {
    if (!["preflight", "verify", "inspect"].includes(mode)) refuse("NIN_USAGE");
    r.mode = mode;
    if (Object.keys(env).some((k) => k.startsWith("E7_") && !ALLOWED_E7_KEYS.includes(k))) refuse("NIN_INPUT_UNEXPECTED");
    r.workflowSha = HEX40.test(env.E7_WORKFLOW_SHA ?? "") ? env.E7_WORKFLOW_SHA : null;
    const has = (k) => typeof env[k] === "string" && env[k].length > 0;
    if (mode !== "inspect" && SECRET_KEYS.some(has)) refuse("NIN_SECRET_SCOPE_VIOLATION");
    const inp = {}; for (const k of PLAN_INPUT_KEYS) inp[k] = env[INPUT_ENV[k]] ?? "";
    const vals = PLAN_INPUT_KEYS.map((k) => inp[k]); const anyReal = vals.some((v) => v !== "");
    if (anyReal && vals.some((v) => v === "")) refuse("NIN_INPUT_INCOMPLETE");
    if (anyReal && (!APPROVAL_RE.test(inp.approvalRef) || !INTENT_RE.test(inp.intentId) || !UUID_RE.test(inp.opId) || !/^[1-9][0-9]{0,6}$/.test(inp.expectedVersion)
        || inp.opId === inp.intentId)) refuse("NIN_INPUT_INVALID");
    if (anyReal && (inp.approvalRef === c.synthetic.approvalRef || inp.intentId === c.synthetic.intentId || inp.opId === c.synthetic.opId)) refuse("NIN_INPUT_INVALID");
    const expPlan = env.E7_EXPECTED_PLAN_HASH ?? ""; const expSrc = env.E7_EXPECTED_SOURCE_DIGEST ?? ""; const expClo = env.E7_EXPECTED_CLOSURE_DIGEST ?? "";
    const runId = env.E7_RUN_ID ?? "";
    if (mode !== "preflight") {
      if (c.toolingStatus !== "MERGED" || !HEX64.test(String(c.closureDigest))) refuse("NIN_CLOSURE_MISMATCH");
      if (!anyReal || !HEX64.test(expPlan) || !HEX64.test(expSrc) || !HEX64.test(expClo)) refuse("NIN_INPUT_INCOMPLETE");
      if (!RUN_ID_RE.test(runId)) refuse("NIN_INPUT_INVALID");
      if (env.GITHUB_REF !== "refs/heads/main") refuse("NIN_REF_NOT_MAIN");
      if (expClo !== c.closureDigest) refuse("NIN_CLOSURE_MISMATCH");
    }
    const tooling = await realpath(env.E7_TOOLING_DIR ?? "").catch(() => refuse("NIN_LAYOUT_INVALID"));
    const wdir = await realpath(wrapperDir).catch(() => refuse("NIN_LAYOUT_INVALID"));
    if (tooling === wdir || tooling.startsWith(`${wdir}/`) || wdir.startsWith(`${tooling}/`)) refuse("NIN_LAYOUT_INVALID");
    r.closureDigest = await framedDigest(tooling, c.closure, CLOSURE_DIGEST_PREFIX).catch((e) => refuse(e instanceof Refusal ? e.code : "NIN_SOURCE_UNREADABLE"));
    if (r.closureDigest !== c.closureDigest) refuse("NIN_CLOSURE_MISMATCH");
    r.sourceDigest = await framedDigest(wdir, c.runnerFiles, SOURCE_DIGEST_PREFIX).catch((e) => refuse(e instanceof Refusal ? e.code : "NIN_SOURCE_UNREADABLE"));
    if (mode !== "preflight" && r.sourceDigest !== expSrc) refuse("NIN_SOURCE_MISMATCH");
    r.planKind = anyReal ? "REAL" : "SYNTHETIC";
    const built = buildPlan(c, anyReal ? { ...inp, expectedVersion: Number(inp.expectedVersion), sourceDigest: r.sourceDigest } : { ...c.synthetic, sourceDigest: r.sourceDigest });
    r.planHash = built.planHash;
    if (mode !== "preflight" && built.planHash !== expPlan) refuse("NIN_PLAN_HASH_MISMATCH");
    let C1; try { C1 = await importEnv(tooling); } catch { refuse("NIN_IMPORT_FAILED"); }
    const present = Object.fromEntries(C1.PRESENT_KEYS.map((k) => [k, Object.hasOwn(env, k)]));
    let uid = null; try { if (typeof proc.getuid === "function") { const u = proc.getuid(); if (Number.isSafeInteger(u) && u >= 0) uid = u; } } catch { uid = null; }
    const ev = C1.evaluateProbeEnvironment({ schema: C1.ENV_SNAPSHOT_SCHEMA, nodeVersion: String(proc.versions.node), platform: proc.platform,
      execArgvCount: proc.execArgv.length, uidAvailable: uid !== null, present });
    r.envCode = typeof ev.code === "string" && C1.ENV_CODES.includes(ev.code) ? ev.code : "REDACTED";
    if (ev.ok !== true || proc.versions.node !== c.nodeVersion) refuse("NIN_ENV_REFUSED");
    if (mode === "preflight") {
      const o = await spawnChild(["--test", "--test-reporter=tap", ...TEST_FILES], { cwd: wdir, env: childEnv(env, tooling) });
      if (!o || o.spawnFailed || (o.signal !== null && o.signal !== undefined) || !Number.isSafeInteger(o.status) || o.truncated) refuse("NIN_CHILD_FAILED");
      const num = (re) => { const m = re.exec(o.stdout); return m ? Number(m[1]) : null; };
      r.tests = { status: o.status, tests: num(/^# tests (\d+)$/m), pass: num(/^# pass (\d+)$/m), fail: num(/^# fail (\d+)$/m), skipped: num(/^# skipped (\d+)$/m), connectivityEvidence: false };
      if (o.status !== 0 || !(r.tests.tests > 0) || r.tests.pass !== r.tests.tests || r.tests.fail !== 0) refuse("NIN_TESTS_FAILED");
      r.code = anyReal ? "PREFLIGHT_OK_REAL_PLAN" : "PREFLIGHT_OK_SYNTHETIC_ONLY"; return { exitCode: 0, result: r };
    }
    if (mode === "verify") { r.code = "VERIFY_OK"; return { exitCode: 0, result: r }; }
    r.runId = runId;
    if (!SECRET_KEYS.every(has)) refuse("NIN_CREDENTIALS_MISSING");
    let dbUrl = env.E7_DEV_BOOKING_DATABASE_URL; delete env.E7_DEV_BOOKING_DATABASE_URL;
    try {
      let pgv; try { pgv = await readPgVersion(tooling); } catch { pgv = null; }
      if (pgv !== c.pgVersion) refuse("NIN_DEPENDENCY_MISMATCH");
      if (!dbTargetOk(dbUrl, c)) refuse("NIN_DB_TARGET_INVALID");
      let caPem = null;
      try { const b = await readCa(env.E7_CA_FILE ?? ""); if (b.length < 16384 && sha(b) === (deps.caSha256 ?? OFFICIAL_CA_SHA256)) caPem = b.toString("utf8"); } catch { caPem = null; }
      if (caPem === null) refuse("NIN_CA_INVALID");
      let P; try { P = await importPool(tooling); } catch { refuse("NIN_IMPORT_FAILED"); }
      try { pool = P.createBookingPool({ connectionString: dbUrl, caPem, max: 1, statementTimeoutMs: c.budgets.statementMs }); } catch { refuse("NIN_DB_TARGET_INVALID"); }
    } finally { dbUrl = null; }
    try { client = await pool.connect(); } catch { client = null; }
    r.core = client ? await inspect({ client, plan: built.plan, c }) : deepFreeze({ schema: RESULT_SCHEMA, code: "NIN_DB_FAILED", stage: "connect", statements: 0, catalogSchema: null, catalogSections: null, admission: null });
    r.code = "INSPECT_DONE";
    return { exitCode: r.core.code === "INSPECTED" ? 0 : 1, result: r };
  } catch (e) {
    r.code = e instanceof Refusal && HOSTED_CODES.includes(e.code) ? e.code : "NIN_INTERNAL";
    return { exitCode: 1, result: r };
  } finally {
    if (client) { try { client.release(true); } catch { /* ignore */ } }
    if (pool) await pool.end().catch(() => {});
  }
}

export function summaryMarkdown(r) {
  const a = r.core && r.core.admission;
  const core = r.core ? ` core=${r.core.code}/${r.core.stage} schema=${r.core.catalogSchema ?? "-"} statements=${r.core.statements}${a ? ` class=${a.notifyClass} latch=${a.latchCode ?? "-"} opState=${a.operation.state} attempts=${a.operation.attempts} render=${a.render ? a.render.templateVersion : "-"} receipts=${typeof a.receipts === "string" ? a.receipts : a.receipts.count}` : ""}` : "";
  return `e7-hosted-notify-inspect ${r.mode} ${r.code} executeEnabled=${r.executeEnabled} sendEnabled=${r.sendEnabled} plan=${r.planKind ?? "-"}:${r.planHash ?? "-"} runId=${r.runId ?? "-"} closure=${r.closureDigest ?? "-"} source=${r.sourceDigest ?? "-"}${core}\n`;
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
