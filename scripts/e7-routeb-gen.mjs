#!/usr/bin/env node
// scripts/e7-routeb-gen.mjs — Route B: deterministic generator of Supabase SQL-editor scripts for migrations 0006–0016 (TEST DEV only).
// NEW implementation (built-ins only: node:fs / node:path / node:crypto / node:url). It does NOT import db/lib/migrate.js or any runtime
// module; it re-implements that runner's file rules and reproduces its migrateUp() semantics in SQL (see the source citations below).
// The historical uncommitted 2026-10-21 generator (SHA-256 e3ea1ffc…c4fb7) is NOT restored; this file does not claim its hash.
//
// Semantics reproduced from db/lib/migrate.js at 6d703acd (line numbers there):
//   * files  NNNN_name.(up|down).sql, both required, versions 1..N without gaps            (FILE_RE :17, loadMigrations :27-46)
//   * checksums = SHA-256 of the file's UTF-8 text                                           (sha256 :20, :35-37)
//   * one transaction per migration under pg_advisory_xact_lock(7302215001)                  (LOCK_KEY :16, inTx :78-89)
//   * under the lock: every applied row must match its file (name, up/down checksums) and the requested environment, and the
//     booking.instance marker must equal it                                                  (verify :63-76, databaseEnvironment :55-59)
//   * ordering: applied count must be exactly version-1                                      (migrateUp :116)
//   * set_config('booking.migration_environment', env, true); the migration text; the history INSERT (migrateUp :117-120)
// Differences (by design): the environment is fixed to `test`; the PRIOR history must be EXACTLY versions 1..N-1 (a row at N or later
// raises E7RB_ALREADY_APPLIED_OR_LATER instead of the runner's silent no-op); booking.instance must exist with exactly one `test` row;
// SET LOCAL lock_timeout / statement_timeout bound waits inside the editor's single transaction. No down script is generated.
//
// The migration bytes are embedded VERBATIM between two marker lines (never normalized, re-encoded or interpolated); a file that is
// not exact UTF-8, has a BOM / NUL / CR, contains a top-level BEGIN / COMMIT / ROLLBACK line or the guard's dollar tag is refused.
// Only validated literals ([a-z0-9_] names, 64-hex checksums, integers) are interpolated into the wrapper SQL.
//
// Usage: node scripts/e7-routeb-gen.mjs <outDir>      (writes 06..16 scripts, pre_verify.sql, post_verify.sql, manifest.json)
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export const LOCK_KEY = 7302215001;
export const ENV = "test";
export const FROM = 6; export const TO = 16;
export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "db", "migrations");
export const TIMEOUTS = Object.freeze({ lock: "15s", statement: "600s" });
const FILE_RE = /^(\d{4})_([a-z0-9_]+)\.(up|down)\.sql$/;
const HEX64 = /^[0-9a-f]{64}$/;
const NAME_RE = /^[a-z0-9_]+$/;
const TAG = "$e7rb_guard$";
const sha = (b) => createHash("sha256").update(b).digest("hex");

export class GenError extends Error { constructor(code, detail) { super(`${code}: ${detail}`); this.code = code; } }

/** load + validate exactly like the runner's loadMigrations (plus byte-exactness rules for verbatim embedding) */
export function loadMigrationFiles(dir = MIGRATIONS_DIR) {
  const byVersion = new Map();
  for (const f of readdirSync(dir).sort()) {
    const m = FILE_RE.exec(f);
    if (!m) { if (f.endsWith(".sql")) throw new GenError("BAD_FILENAME", f); continue; }
    const version = Number(m[1]);
    const e = byVersion.get(version) || { version, name: m[2] };
    if (e.name !== m[2]) throw new GenError("NAME_MISMATCH", f);
    const bytes = readFileSync(join(dir, f));
    const text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes)) throw new GenError("NOT_EXACT_UTF8", f);
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) throw new GenError("BOM", f);
    if (bytes.includes(0) || bytes.includes(0x0d)) throw new GenError("NUL_OR_CR", f);
    e[m[3]] = bytes; e[`${m[3]}Checksum`] = sha(bytes);           // = runner sha256(text, "utf8") because the round trip is exact
    byVersion.set(version, e);
  }
  const list = [...byVersion.values()].sort((a, b) => a.version - b.version);
  list.forEach((e, i) => {
    if (e.version !== i + 1) throw new GenError("GAP", `expected ${i + 1}, found ${e.version}`);
    if (!e.up || !e.down) throw new GenError("MISSING_PAIR", `${e.version}_${e.name}`);
    if (!NAME_RE.test(e.name) || !HEX64.test(e.upChecksum) || !HEX64.test(e.downChecksum)) throw new GenError("LITERAL_UNSAFE", e.name);
  });
  return list;
}

const lit = (s) => { if (!/^[a-z0-9_]+$/.test(s)) throw new GenError("LITERAL_UNSAFE", s); return `'${s}'`; };
const padv = (v) => String(v).padStart(2, "0");
export const scriptName = (m) => `${padv(m.version)}_${m.name}.sql`;

function bodyRefusals(m) {
  const text = m.up.toString("utf8");
  if (/^(BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION|ABORT)\s*(TRANSACTION|WORK)?\s*;/im.test(text)) throw new GenError("TX_CONTROL_IN_BODY", `${m.version}_${m.name}`);
  if (text.includes("$e7rb_")) throw new GenError("GUARD_TAG_IN_BODY", `${m.version}_${m.name}`);
}

/** one SQL-editor script = ONE transaction for ONE migration (wrapper + verbatim bytes + wrapper) */
export function buildScript(all, m) {
  bodyRefusals(m);
  const prior = all.filter((x) => x.version < m.version);
  const values = prior.map((x) => `(${x.version}, ${lit(x.name)}, '${x.upChecksum}', '${x.downChecksum}')`).join(",\n      ");
  const head = [
    `-- Route B (E7) SQL-editor script: migration ${String(m.version).padStart(4, "0")}_${m.name}, environment ${ENV}. Generated by scripts/e7-routeb-gen.mjs.`,
    `-- Reproduces db/lib/migrate.js migrateUp() for ONE version: one transaction, pg_advisory_xact_lock(${LOCK_KEY}), exact prior history, env marker,`,
    `-- set_config, the verbatim migration, the history row. Run ONCE as one editor submission; on ANY error or an uncertain result: stop,`,
    `-- run ROLLBACK; then inspect history read-only (post_verify.sql / pre_verify.sql). Never re-run blindly.`,
    `-- up sha256 ${m.upChecksum}`,
    `-- down sha256 ${m.downChecksum}`,
    "BEGIN;",
    `SET LOCAL lock_timeout = '${TIMEOUTS.lock}';`,
    `SET LOCAL statement_timeout = '${TIMEOUTS.statement}';`,
    `SELECT pg_advisory_xact_lock(${LOCK_KEY});`,
    `DO ${TAG}`,
    "DECLARE later integer; bad integer; inst integer; dbenv text;",
    "BEGIN",
    "  IF to_regclass('booking_migrations.applied') IS NULL THEN RAISE EXCEPTION 'E7RB_BOOKKEEPING_MISSING'; END IF;",
    `  SELECT count(*) INTO later FROM booking_migrations.applied WHERE version >= ${m.version};`,
    `  IF later > 0 THEN RAISE EXCEPTION 'E7RB_ALREADY_APPLIED_OR_LATER: % history row(s) at version >= ${m.version}', later; END IF;`,
    "  -- the prior history must be EXACTLY versions 1..N-1 with these names, checksums and environment (missing / unknown / drift / env)",
    "  SELECT count(*) INTO bad FROM booking_migrations.applied a",
    `    FULL JOIN (VALUES\n      ${values}) f(version, name, up, down) USING (version)`,
    `   WHERE a.version IS NULL OR f.version IS NULL OR a.name <> f.name OR a.up_checksum <> f.up OR a.down_checksum <> f.down OR a.environment <> ${lit(ENV)};`,
    `  IF bad > 0 THEN RAISE EXCEPTION 'E7RB_HISTORY_MISMATCH: % prior row(s) missing, unknown, drifted or not ${ENV} (expected exactly 1..${m.version - 1})', bad; END IF;`,
    "  IF to_regclass('booking.instance') IS NULL THEN RAISE EXCEPTION 'E7RB_INSTANCE_MISSING'; END IF;",
    "  SELECT count(*), max(environment) INTO inst, dbenv FROM booking.instance;",
    `  IF inst <> 1 OR dbenv IS DISTINCT FROM ${lit(ENV)} THEN RAISE EXCEPTION 'E7RB_ENV_MISMATCH: % instance row(s), environment %', inst, dbenv; END IF;`,
    "END",
    `${TAG};`,
    `SELECT set_config('booking.migration_environment', ${lit(ENV)}, true);`,
    `-- ===== BEGIN VERBATIM ${String(m.version).padStart(4, "0")}_${m.name}.up.sql (${m.up.length} bytes, sha256 ${m.upChecksum}) =====`,
    ""].join("\n");
  const tail = [
    "",
    `-- ===== END VERBATIM ${String(m.version).padStart(4, "0")}_${m.name}.up.sql =====`,
    `INSERT INTO booking_migrations.applied (version, name, up_checksum, down_checksum, environment)`,
    `  VALUES (${m.version}, ${lit(m.name)}, '${m.upChecksum}', '${m.downChecksum}', ${lit(ENV)});`,
    "COMMIT;",
    ""].join("\n");
  const content = Buffer.concat([Buffer.from(head, "utf8"), m.up, Buffer.from(tail, "utf8")]);
  return { file: scriptName(m), content, bodyOffset: Buffer.byteLength(head, "utf8"), bodyLength: m.up.length };
}

// ---- read-only verification SQL (aggregates / catalog only; never a guest column) ------------------------------------------------------
const S = "SELECT", I = "INSERT", U = "UPDATE";
/** runtime privilege matrix after 0016 = scripts/db-smoke.mjs EXPECTED_TABLE_PRIVS at 6d703acd (the test asserts equality) */
export const EXPECTED_APP_PRIVS = Object.freeze({
  instance: [S], intents: [S, I, U], intent_work: [S, I, U], payment_attempts: [S, I, U], external_operations: [S, I, U],
  hostaway_reservation_attempts: [S, I, U], payment_refunds: [S, I, U], stripe_webhook_events: [S, I, U], inventory_claims: [S, I],
  reconciliation_cases: [S, I], intent_transitions: [S, I], intent_applied_events: [S, I], payment_ledger: [S, I], intent_guests: [S, I],
  provider_evidence: [S], reconciliation_resolutions: [S], definite_refusal_codes: [S], api_rate_limits: [],
  recording_holds: [S], recording_hold_decisions: [S], recording_hold_observations: [S], recording_conflict_inbox: [S],
  recording_assessment_codes: [S], recording_assessments: [S], recording_claim_assessments: [S],
  notification_renders: [S], notification_latches: [S], notification_write_authority: []
});
/** = scripts/db-smoke.mjs FUNCS_ALLOWED / FUNCS_DENIED at 6d703acd (the test asserts equality) */
export const FUNCS_ALLOWED = Object.freeze(["booking.claim_release_blockers(uuid)", "booking.release_claim_if_safe(uuid,text)",
  "booking.release_completed_stays()", "booking.purge_guest_data(integer,integer)", "booking.settle_operation_from_evidence(uuid,uuid)",
  "booking.record_provider_evidence(uuid,text,text,text,jsonb,text)", "booking.rate_limit_hit(text,integer,integer)"]);
export const FUNCS_DENIED = Object.freeze(["booking.admin_resolve_operation(uuid,text,uuid[],text,text,text,timestamptz)",
  "booking.admin_resolve_intent(uuid,text,uuid[],text,text,text,timestamptz)", "booking.admin_close_case(uuid,uuid[],text,text,timestamptz)",
  "booking.admin_record_evidence(uuid,text,text,text,jsonb,timestamptz,text,text)", "booking.admin_acquire_claim(uuid,timestamptz)"]);
const PRE_TABLES = ["instance", "intents", "intent_work", "payment_attempts", "external_operations", "hostaway_reservation_attempts", "payment_refunds",
  "stripe_webhook_events", "inventory_claims", "reconciliation_cases", "intent_transitions", "intent_applied_events", "payment_ledger", "intent_guests",
  "provider_evidence", "reconciliation_resolutions", "definite_refusal_codes"];

function historySql(list) {
  const v = list.map((x) => `(${x.version}, ${lit(x.name)}, '${x.upChecksum}', '${x.downChecksum}')`).join(", ");
  return `(SELECT count(*) = 0 FROM booking_migrations.applied a FULL JOIN (VALUES ${v}) f(version, name, up, down) USING (version)
      WHERE a.version IS NULL OR f.version IS NULL OR a.name <> f.name OR a.up_checksum <> f.up OR a.down_checksum <> f.down OR a.environment <> ${lit(ENV)})`;
}
function rolesSql() {
  return [
    `SELECT 'roles_groups_nologin', (SELECT count(*) = 3 AND bool_and(NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls) FROM pg_roles WHERE rolname IN ('mv_booking_admin', 'mv_booking_app', 'mv_booking_report')), NULL`,
    `SELECT 'runtime_login_mv_booking_app_dev', (SELECT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreaterole AND NOT rolcreatedb FROM pg_roles WHERE rolname = 'mv_booking_app_dev') IS TRUE,
       (SELECT string_agg(g.rolname, ',' ORDER BY g.rolname) FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = 'mv_booking_app_dev')`,
    `SELECT 'runtime_login_member_of_app_only', (SELECT string_agg(g.rolname, ',' ORDER BY g.rolname) FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = 'mv_booking_app_dev') IS NOT DISTINCT FROM 'mv_booking_app', NULL`,
    `SELECT 'other_logins_in_booking_groups', true, (SELECT string_agg(r.rolname, ',' ORDER BY r.rolname) FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid JOIN pg_roles r ON r.oid = m.member WHERE g.rolname LIKE 'mv\\_booking\\_%' AND r.rolcanlogin AND r.rolname <> 'mv_booking_app_dev')`
  ];
}
function countsSql() {
  // aggregate counts only (report, not assert: the hosted data volume is NOT assumed); plus the 0006 / 0011 / 0014 / 0016 preconditions as booleans
  return [
    `SELECT 'data_counts', true, (SELECT format('intents=%s guests=%s attempts=%s ops=%s notify_ops=%s cases=%s webhook_events=%s claims=%s ledger=%s',
       (SELECT count(*) FROM booking.intents), (SELECT count(*) FROM booking.intent_guests), (SELECT count(*) FROM booking.payment_attempts),
       (SELECT count(*) FROM booking.external_operations), (SELECT count(*) FROM booking.external_operations WHERE op_type = 'guest.notify'),
       (SELECT count(*) FROM booking.reconciliation_cases), (SELECT count(*) FROM booking.stripe_webhook_events), (SELECT count(*) FROM booking.inventory_claims),
       (SELECT count(*) FROM booking.payment_ledger)))`
  ];
}
export function preVerifySql(all) {
  const p = all.filter((x) => x.version < FROM);
  const rows = [
    `SELECT 'instance_test' AS check_name, (SELECT count(*) = 1 AND bool_and(environment = ${lit(ENV)}) FROM booking.instance) AS ok, NULL::text AS detail`,
    `SELECT 'history_exactly_1_to_${FROM - 1}', ${historySql(p)}, (SELECT string_agg(version::text, ',' ORDER BY version) FROM booking_migrations.applied)`,
    `SELECT 'new_tables_absent', (to_regclass('booking.api_rate_limits') IS NULL AND to_regclass('booking.recording_holds') IS NULL AND to_regclass('booking.notification_renders') IS NULL), NULL`,
    `SELECT 'pre_tables_present', (SELECT count(*) = ${PRE_TABLES.length} FROM pg_class c WHERE c.relnamespace = 'booking'::regnamespace AND c.relkind = 'r' AND c.relname IN (${PRE_TABLES.map(lit).join(", ")})), NULL`,
    `SELECT 'btree_gist', (SELECT count(*) = 1 FROM pg_extension WHERE extname = 'btree_gist'), (SELECT extversion FROM pg_extension WHERE extname = 'btree_gist')`,
    ...rolesSql(),
    `SELECT 'pre_0006_no_duplicate_token_hash', (SELECT count(*) = count(DISTINCT access_token_hash) FROM booking.intents), NULL`,
    `SELECT 'pre_0011_no_reserved_offline_hold_case', NOT EXISTS (SELECT 1 FROM booking.reconciliation_cases WHERE starts_with(kind, 'OFFLINE_CHARGE_HOLD_')), NULL`,
    // = the 0016 up's own NOTIFY_UPGRADE_PRECONDITION predicate (0016_guest_notification_fence.up.sql:28-35), evaluated read-only beforehand
    `SELECT 'pre_0016_notify_rows_canonical_unattempted', NOT EXISTS (SELECT 1 FROM booking.external_operations o WHERE o.op_type = 'guest.notify' AND (
        o.state <> 'pending' OR o.attempts <> 0 OR o.dispatched_at IS NOT NULL OR o.lease_worker_id IS NOT NULL OR o.lease_until IS NOT NULL
     OR o.completed_at IS NOT NULL OR o.result_ref IS NOT NULL OR o.settled_evidence_id IS NOT NULL OR o.resolution_id IS NOT NULL
     OR o.retry_class <> 'idempotent'
     OR o.payload <> jsonb_build_object('template', o.payload ->> 'template')
     OR (o.payload ->> 'template') IS NULL
     OR (o.payload ->> 'template') NOT IN ('booking_confirmed', 'not_charged_authorization_may_show', 'not_completed_not_charged')
     OR o.idempotency_key <> 'notify:' || o.intent_id::text || ':' || (o.payload ->> 'template'))), NULL`,
    `SELECT 'pre_0016_notify_one_per_intent', NOT EXISTS (SELECT 1 FROM booking.external_operations WHERE op_type = 'guest.notify' GROUP BY intent_id HAVING count(*) > 1), NULL`,
    ...countsSql()];
  return wrapVerify("PRE", `history 1..${FROM - 1}`, rows);
}
export function postVerifySql(all) {
  const p = all.filter((x) => x.version <= TO);
  const matrix = Object.entries(EXPECTED_APP_PRIVS).map(([t, privs]) => `(${lit(t)}, '${[...privs].sort().join(",")}')`).join(", ");
  const rows = [
    `SELECT 'instance_test' AS check_name, (SELECT count(*) = 1 AND bool_and(environment = ${lit(ENV)}) FROM booking.instance) AS ok, NULL::text AS detail`,
    `SELECT 'history_exactly_1_to_${TO}', ${historySql(p)}, (SELECT string_agg(version::text, ',' ORDER BY version) FROM booking_migrations.applied)`,
    `SELECT 'new_tables_present', (to_regclass('booking.api_rate_limits') IS NOT NULL AND to_regclass('booking.recording_holds') IS NOT NULL AND to_regclass('booking.recording_assessments') IS NOT NULL
       AND to_regclass('booking.notification_renders') IS NOT NULL AND to_regclass('booking.notification_latches') IS NOT NULL AND to_regclass('booking.notification_write_authority') IS NOT NULL), NULL`,
    `SELECT 'rls_on_every_booking_table', NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.relnamespace = 'booking'::regnamespace AND c.relkind = 'r' AND NOT c.relrowsecurity), NULL`,
    `SELECT 'no_public_anon_authenticated_table_grants', NOT EXISTS (SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
       WHERE c.relnamespace = 'booking'::regnamespace AND (a.grantee = 0 OR a.grantee IN (SELECT oid FROM pg_roles WHERE rolname IN ('anon', 'authenticated')))), NULL`,
    `SELECT 'runtime_privilege_matrix_exact_0016', NOT EXISTS (
       SELECT 1 FROM (VALUES ${matrix}) e(tbl, privs)
       FULL JOIN (SELECT c.relname AS tbl, coalesce((SELECT string_agg(DISTINCT a.privilege_type, ',' ORDER BY a.privilege_type) FROM aclexplode(c.relacl) a
                    WHERE a.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'mv_booking_app')), '') AS privs
                  FROM pg_class c WHERE c.relnamespace = 'booking'::regnamespace AND c.relkind = 'r') g USING (tbl)
       WHERE e.tbl IS NULL OR g.tbl IS NULL OR e.privs <> g.privs), NULL`,
    `SELECT 'btree_gist', (SELECT count(*) = 1 FROM pg_extension WHERE extname = 'btree_gist'), (SELECT extversion FROM pg_extension WHERE extname = 'btree_gist')`,
    `SELECT 'runtime_functions_executable', (SELECT bool_and(has_function_privilege('mv_booking_app', f, 'EXECUTE')) FROM unnest(ARRAY[${FUNCS_ALLOWED.map((f) => `'${f}'`).join(", ")}]::text[]) f), NULL`,
    `SELECT 'admin_functions_not_executable', (SELECT NOT bool_or(has_function_privilege('mv_booking_app', f, 'EXECUTE')) FROM unnest(ARRAY[${FUNCS_DENIED.map((f) => `'${f}'`).join(", ")}]::text[]) f), NULL`,
    ...rolesSql(),
    ...countsSql()];
  return wrapVerify("POST", `history 1..${TO}`, rows);
}
function wrapVerify(kind, what, rows) {
  return [`-- Route B (E7) ${kind} verification, READ ONLY (catalog + aggregate counts; never a guest column). Expect every ok = true (${what}).`,
    "-- data_counts / other_logins_in_booking_groups are REPORTED, not asserted: the hosted data and logins are not assumed.",
    "BEGIN READ ONLY;", rows.join("\nUNION ALL\n") + ";", "ROLLBACK;", ""].join("\n");
}

/** generate everything deterministically (no time, no environment input) */
export function generate(dir = MIGRATIONS_DIR) {
  const all = loadMigrationFiles(dir);
  if (all.length !== TO) throw new GenError("UNEXPECTED_SET", `expected ${TO} migrations, found ${all.length}`);
  const files = [];
  const scripts = [];
  for (const m of all.filter((x) => x.version >= FROM && x.version <= TO)) {
    const s = buildScript(all, m);
    files.push({ name: s.file, content: s.content });
    scripts.push({ version: m.version, name: m.name, file: s.file, upChecksum: m.upChecksum, downChecksum: m.downChecksum, scriptSha256: sha(s.content),
      scriptBytes: s.content.length, bodyOffset: s.bodyOffset, bodyLength: s.bodyLength, priorVersions: [1, m.version - 1] });
  }
  const pre = Buffer.from(preVerifySql(all), "utf8"); const post = Buffer.from(postVerifySql(all), "utf8");
  files.push({ name: "pre_verify.sql", content: pre }, { name: "post_verify.sql", content: post });
  const manifest = { schema: "e7-routeb-editor-scripts-v1", environment: ENV, lockKey: LOCK_KEY, timeouts: TIMEOUTS, from: FROM, to: TO,
    history1to5: all.filter((x) => x.version < FROM).map((x) => ({ version: x.version, name: x.name, upChecksum: x.upChecksum, downChecksum: x.downChecksum })),
    scripts, preVerifySha256: sha(pre), postVerifySha256: sha(post) };
  files.push({ name: "manifest.json", content: Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8") });
  return { files, manifest };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = process.argv[2];
  if (!out) { process.stderr.write("usage: node scripts/e7-routeb-gen.mjs <outDir>\n"); process.exit(2); }
  const { files } = generate();
  mkdirSync(out, { recursive: true });
  for (const f of files) writeFileSync(join(out, f.name), f.content);
  process.stdout.write(`${JSON.stringify(files.map((f) => [f.name, sha(f.content)]))}\n`);
}
