// Route B SQL-editor scripts — disposable PostgreSQL (test/db/harness.mjs startPostgres; loopback, trust auth, deleted on stop).
// A: the accepted runner applies 1–5, then the GENERATED scripts 06..16 are applied ONCE each, every script as ONE simple-protocol
//    submission (the editor's shape). B: the accepted runner applies 1–16. Both end with an identical catalog fingerprint.
// Also: PRE / POST verification, runner status parity, isolated refusals (already applied / order / drift / missing / env / bookkeeping /
// lock timeout) each followed by ROLLBACK with history unchanged, and a mid-body failure that rolls back every partial object.
// Every migration runs as a NON-superuser owner `sbpostgres` (CREATEROLE + CREATE on the database), like a hosted Supabase `postgres`.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { startPostgres } from "./harness.mjs";
import { migrateUp, migrationStatus } from "../../db/lib/migrate.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(ROOT, "claude", "evidence", "e7-routeb-2026-11-05");
const manifest = JSON.parse(readFileSync(join(OUT, "manifest.json"), "utf8"));
const script = (v) => readFileSync(join(OUT, manifest.scripts.find((s) => s.version === v).file), "utf8");
const PRE = readFileSync(join(OUT, "pre_verify.sql"), "utf8"), POST = readFileSync(join(OUT, "post_verify.sql"), "utf8");

const FP = `SELECT json_build_object(
  'nsp', (SELECT json_agg(json_build_array(nspname, nspacl::text, pg_get_userbyid(nspowner)) ORDER BY nspname) FROM pg_namespace WHERE nspname IN ('booking','booking_migrations','public')),
  'rels', (SELECT json_agg(json_build_array(n.nspname, c.relname, c.relkind, c.relrowsecurity, c.relforcerowsecurity, c.relacl::text, pg_get_userbyid(c.relowner)) ORDER BY n.nspname, c.relname)
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname IN ('booking','booking_migrations')),
  'cols', (SELECT json_agg(json_build_array(c.relname, a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull, pg_get_expr(d.adbin, d.adrelid), a.attacl::text) ORDER BY c.relname, a.attnum)
           FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
           WHERE c.relnamespace IN ('booking'::regnamespace, 'booking_migrations'::regnamespace) AND a.attnum > 0 AND NOT a.attisdropped),
  'cons', (SELECT json_agg(json_build_array(conrelid::regclass::text, conname, pg_get_constraintdef(oid), condeferrable, condeferred) ORDER BY conrelid::regclass::text, conname)
           FROM pg_constraint WHERE connamespace IN ('booking'::regnamespace, 'booking_migrations'::regnamespace)),
  'idx', (SELECT json_agg(pg_get_indexdef(i.indexrelid) ORDER BY pg_get_indexdef(i.indexrelid)) FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid
           WHERE c.relnamespace IN ('booking'::regnamespace, 'booking_migrations'::regnamespace)),
  'trg', (SELECT json_agg(json_build_array(tgrelid::regclass::text, tgname, pg_get_triggerdef(oid), tgenabled) ORDER BY tgrelid::regclass::text, tgname) FROM pg_trigger
           WHERE NOT tgisinternal AND tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'booking'::regnamespace)),
  'fn', (SELECT json_agg(json_build_array(p.oid::regprocedure::text, md5(pg_get_functiondef(p.oid)), p.prosecdef, p.proconfig::text, p.proacl::text, pg_get_userbyid(p.proowner)) ORDER BY p.oid::regprocedure::text)
           FROM pg_proc p WHERE p.pronamespace = 'booking'::regnamespace),
  'pol', (SELECT json_agg(json_build_array(tablename, policyname, permissive, roles::text, cmd, qual, with_check) ORDER BY tablename, policyname) FROM pg_policies WHERE schemaname = 'booking'),
  'roles', (SELECT json_agg(json_build_array(rolname, rolcanlogin, rolinherit, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolconfig::text) ORDER BY rolname) FROM pg_roles WHERE rolname LIKE 'mv\\_booking\\_%'),
  'members', (SELECT json_agg(json_build_array(g.rolname, r.rolname, m.admin_option) ORDER BY g.rolname, r.rolname) FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid
           JOIN pg_roles r ON r.oid = m.member WHERE g.rolname LIKE 'mv\\_booking\\_%' OR r.rolname LIKE 'mv\\_booking\\_%'),
  'ext', (SELECT json_agg(json_build_array(extname, extversion) ORDER BY extname) FROM pg_extension),
  'defacl', (SELECT json_agg(json_build_array(pg_get_userbyid(defaclrole), defaclnamespace::regnamespace::text, defaclobjtype, defaclacl::text) ORDER BY 1) FROM pg_default_acl),
  'applied', (SELECT json_agg(json_build_array(version, name, up_checksum, down_checksum, environment) ORDER BY version) FROM booking_migrations.applied),
  'instance', (SELECT json_agg(environment) FROM booking.instance)) AS fp`;

const clusters = [], clients = [];
async function cluster({ env = "test", to = 5 } = {}) {
  const db = await startPostgres(); clusters.push(db);
  const su = new pg.Client({ connectionString: db.adminUrl }); await su.connect();
  await su.query("CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE sbpostgres LOGIN CREATEROLE; GRANT CREATE ON DATABASE postgres TO sbpostgres");
  await su.query("CREATE DATABASE empty OWNER sbpostgres");
  await su.end();
  const url = db.adminUrl.replace("postgres@", "sbpostgres@");
  const owner = new pg.Client({ connectionString: url }); await owner.connect(); clients.push(owner);
  if (to > 0) await migrateUp(owner, { env, to });
  if (to >= 2) await owner.query("CREATE ROLE mv_booking_app_dev LOGIN IN ROLE mv_booking_app");
  const conn = async (dbname = "postgres") => { const c = new pg.Client({ connectionString: url.replace(/\/postgres$/, `/${dbname}`) }); await c.connect(); return c; };
  return { db, owner, conn, url };
}
after(async () => { for (const c of clients) await c.end().catch(() => {}); for (const d of clusters) d.stop(); });

/** one editor-shaped submission; on error the session is left in the failed transaction, and the operator's next step is ROLLBACK */
async function submit(c, sql) {
  try { await c.query(sql); return { ok: true }; } catch (e) { const st = await c.query("SELECT 1").then(() => "IDLE", (x) => x.code); await c.query("ROLLBACK"); return { ok: false, message: e.message, code: e.code, sessionState: st }; }
}
const history = async (c) => (await c.query("SELECT version, name, up_checksum, down_checksum, environment FROM booking_migrations.applied ORDER BY version")).rows;
const checks = async (c, sql) => { const r = await c.query(sql); const rows = r.find((x) => x.command === "SELECT").rows; return rows; };
const fingerprint = async (c) => (await c.query(FP)).rows[0].fp;

let A, B;
before(async () => { [A, B] = await Promise.all([cluster({ to: 5 }), cluster({ to: 16 })]); });

test("R1 PRE (1–5) passes on the runner-built 1–5 database; every check row ok", async () => {
  const rows = await checks(A.owner, PRE);
  const bad = rows.filter((r) => r.ok !== true);
  assert.deepEqual(bad, []);
  assert.equal(rows.length, 14);
  assert.equal(rows.find((r) => r.check_name === "history_exactly_1_to_5").detail, "1,2,3,4,5");
  assert.match(rows.find((r) => r.check_name === "data_counts").detail, /^intents=0 guests=0 /);
});

test("R2 generated 06..16 applied ONCE each (one submission per script) → history 1–16, POST passes, catalog = runner 1–16 path", async () => {
  for (const s of manifest.scripts) {
    const r = await submit(A.owner, script(s.version));
    assert.equal(r.ok, true, `${s.file}: ${r.message}`);
    const h = await history(A.owner);
    assert.equal(h.length, s.version); assert.deepEqual(h.at(-1), { version: s.version, name: s.name, up_checksum: s.upChecksum, down_checksum: s.downChecksum, environment: "test" });
  }
  const post = await checks(A.owner, POST);
  assert.deepEqual(post.filter((r) => r.ok !== true), []);
  assert.equal(post.find((r) => r.check_name === "history_exactly_1_to_16").detail, "1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16");
  const postB = await checks(B.owner, POST);
  assert.deepEqual(postB.filter((r) => r.ok !== true), []);
  assert.deepEqual(post.map((r) => [r.check_name, r.ok, r.detail]), postB.map((r) => [r.check_name, r.ok, r.detail]));
  const [fa, fb] = [await fingerprint(A.owner), await fingerprint(B.owner)];
  assert.equal(fa.applied.length, 16);
  for (const c of [A.owner, B.owner]) assert.equal((await c.query("SELECT count(*)::int AS n FROM booking.recording_assessment_codes")).rows[0].n, 51);
  assert.deepEqual(fa, fb);
  // the accepted runner sees the editor-built history as its own: status clean, nothing pending, a further migrateUp is a no-op
  const st = await migrationStatus(A.owner, { env: "test" });
  assert.deepEqual(st.applied, [...Array(16).keys()].map((i) => i + 1)); assert.deepEqual(st.pending, []);
  assert.deepEqual(await migrateUp(A.owner, { env: "test" }), []);
  // PRE on the finished database fails exactly where it must (history and new-table checks), so the two files are distinct
  const pre = await checks(A.owner, PRE);
  assert.deepEqual(pre.filter((r) => r.ok !== true).map((r) => r.check_name).sort(), ["history_exactly_1_to_5", "new_tables_absent"]);
});

test("R3 refusal on the finished database: re-running 06 and 16 → E7RB_ALREADY_APPLIED_OR_LATER, rolled back, history unchanged", async () => {
  const h0 = await history(A.owner), f0 = await fingerprint(A.owner);
  for (const v of [6, 16]) {
    const r = await submit(A.owner, script(v));
    assert.equal(r.ok, false); assert.match(r.message, /^E7RB_ALREADY_APPLIED_OR_LATER/); assert.equal(r.sessionState, "25P02"); // in_failed_sql_transaction until ROLLBACK
  }
  assert.deepEqual(await history(A.owner), h0); assert.deepEqual(await fingerprint(A.owner), f0);
});

test("R4 isolated refusals at 1–5 (order / drift / missing / unknown env row / env marker / no bookkeeping / lock timeout), each rolled back", async () => {
  const C = await cluster({ to: 5 });
  const o = C.owner, h0 = await history(o), f0 = await fingerprint(o);
  const unchanged = async (label) => { assert.deepEqual(await history(o), h0, label); assert.deepEqual(await fingerprint(o), f0, label); };
  const expectRefusal = async (v, re, label) => { const r = await submit(o, script(v)); assert.equal(r.ok, false, label); assert.match(r.message, re, label); };

  await expectRefusal(7, /^E7RB_HISTORY_MISMATCH: 1 prior row/, "07 before 06 (order)"); await unchanged("order");
  await expectRefusal(16, /^E7RB_HISTORY_MISMATCH: 10 prior row/, "16 at 5 (order)"); await unchanged("order16");

  const tamper = async (sql, v, re, label) => {
    await o.query(sql.do); try { await expectRefusal(v, re, label); } finally { await o.query(sql.undo); }
    await unchanged(label);
  };
  await tamper({ do: "UPDATE booking_migrations.applied SET up_checksum = repeat('0', 64) WHERE version = 3",
    undo: `UPDATE booking_migrations.applied SET up_checksum = '${manifest.history1to5[2].upChecksum}' WHERE version = 3` }, 6, /^E7RB_HISTORY_MISMATCH: 1 /, "drift up checksum");
  await tamper({ do: "UPDATE booking_migrations.applied SET name = 'renamed' WHERE version = 1",
    undo: `UPDATE booking_migrations.applied SET name = '${manifest.history1to5[0].name}' WHERE version = 1` }, 6, /^E7RB_HISTORY_MISMATCH: 1 /, "drift name");
  await tamper({ do: "UPDATE booking_migrations.applied SET environment = 'live' WHERE version = 5",
    undo: "UPDATE booking_migrations.applied SET environment = 'test' WHERE version = 5" }, 6, /^E7RB_HISTORY_MISMATCH: 1 /, "history row env");
  const row2 = h0[1];
  await tamper({ do: "DELETE FROM booking_migrations.applied WHERE version = 2",
    undo: `INSERT INTO booking_migrations.applied (version, name, up_checksum, down_checksum, environment, applied_at) SELECT 2, '${row2.name}', '${row2.up_checksum}', '${row2.down_checksum}', 'test', now()` },
    6, /^E7RB_HISTORY_MISMATCH: 1 /, "missing prior row");
  await tamper({ do: "UPDATE booking.instance SET environment = 'live'", undo: "UPDATE booking.instance SET environment = 'test'" }, 6, /^E7RB_ENV_MISMATCH: 1 instance row\(s\), environment live/, "env marker live");

  // a database without the bookkeeping schema
  const e = await C.conn("empty");
  const r = await submit(e, script(6)); assert.equal(r.ok, false); assert.match(r.message, /^E7RB_BOOKKEEPING_MISSING/);
  assert.equal((await e.query("SELECT count(*)::int AS n FROM pg_namespace WHERE nspname LIKE 'booking%'")).rows[0].n, 0); await e.end();

  // the SAME advisory key as the runner: while another session holds it, the script waits at most lock_timeout and then fails, nothing applied
  const holder = await C.conn(); await holder.query("BEGIN"); await holder.query("SELECT pg_advisory_xact_lock(7302215001)");
  const t0 = Date.now(); const lt = await submit(o, script(6)); const waited = Date.now() - t0;
  await holder.query("ROLLBACK"); await holder.end();
  assert.equal(lt.ok, false); assert.equal(lt.code, "55P03"); assert.match(lt.message, /lock timeout/); assert.ok(waited >= 14000 && waited < 30000, `waited ${waited}ms`);
  await unchanged("lock timeout");
  // and the lock is released after ROLLBACK (another session can take it at once)
  const probe = await C.conn(); await probe.query("BEGIN"); assert.equal((await probe.query("SELECT pg_try_advisory_xact_lock(7302215001) AS ok")).rows[0].ok, true);
  await probe.query("ROLLBACK"); await probe.end();
});

test("R5 a failure inside the migration body rolls back the whole script: no partial object, no history row", async () => {
  const C = await cluster({ to: 5 });
  const o = C.owner;
  // 0006 creates api_rate_limits + its index + rate_limit_hit() BEFORE the unique token-hash index; pre-create that index's name so the body
  // fails late (after earlier objects exist inside the transaction)
  await o.query("CREATE INDEX intents_access_token_hash_key ON booking.intents (id)");
  const h0 = await history(o), f0 = await fingerprint(o);
  const r = await submit(o, script(6));
  assert.equal(r.ok, false); assert.equal(r.code, "42P07"); assert.match(r.message, /intents_access_token_hash_key/);
  assert.deepEqual(await history(o), h0); assert.deepEqual(await fingerprint(o), f0);
  const objs = (await o.query(`SELECT to_regclass('booking.api_rate_limits') AS t, to_regclass('booking.api_rate_limits_window_start_idx') AS i,
    to_regprocedure('booking.rate_limit_hit(text,integer,integer)') AS f`)).rows[0];
  assert.deepEqual(objs, { t: null, i: null, f: null });
  // after the operator removes the conflicting object the SAME unchanged script applies once
  await o.query("DROP INDEX booking.intents_access_token_hash_key");
  assert.equal((await submit(o, script(6))).ok, true);
  assert.equal((await history(o)).length, 6);
});

test("R6 a database created as environment live is refused by the first script (history rows are live)", async () => {
  const L = await cluster({ env: "live", to: 5 });
  const h0 = await history(L.owner);
  const r = await submit(L.owner, script(6));
  assert.equal(r.ok, false); assert.match(r.message, /^E7RB_HISTORY_MISMATCH: 5 prior row/);
  assert.deepEqual(await history(L.owner), h0);
  const pre = await checks(L.owner, PRE);
  assert.deepEqual(pre.filter((x) => x.ok !== true).map((x) => x.check_name).sort(), ["history_exactly_1_to_5", "instance_test"]);
});

test("R7 POST stays strict: an extra runtime grant or a second login in the runtime group is detected", async () => {
  const o = B.owner;
  await o.query("GRANT DELETE ON booking.intents TO mv_booking_app");
  try {
    const rows = await checks(o, POST);
    assert.deepEqual(rows.filter((r) => r.ok !== true).map((r) => r.check_name), ["runtime_privilege_matrix_exact_0016"]);
  } finally { await o.query("REVOKE DELETE ON booking.intents FROM mv_booking_app"); }
  await o.query("GRANT mv_booking_report TO mv_booking_app_dev");
  try {
    const rows = await checks(o, POST);
    assert.deepEqual(rows.filter((r) => r.ok !== true).map((r) => r.check_name), ["runtime_login_member_of_app_only"]);
  } finally { await o.query("REVOKE mv_booking_report FROM mv_booking_app_dev"); }
  assert.deepEqual((await checks(o, POST)).filter((r) => r.ok !== true), []);
});
