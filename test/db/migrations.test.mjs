// Stage E2B — migration repeatability and runner safety. Throwaway local PostgreSQL only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, cpSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import pg from "pg";
import { startPostgres } from "./harness.mjs";
import { migrateUp, migrateDown, migrationStatus, loadMigrations, DEFAULT_MIGRATIONS_DIR } from "../../db/lib/migrate.js";

let db, client;
before(async () => { db = await startPostgres(); client = new pg.Client({ connectionString: db.adminUrl }); await client.connect(); });
after(async () => { await client.end(); db.stop(); });

const tables = async () => (await client.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'booking'")).rows[0].n;

test("migration files are paired, ordered and contain no credentials", () => {
  const m = loadMigrations();
  assert.deepEqual(m.map((x) => `${x.version}_${x.name}`), ["1_booking_core", "2_roles_grants", "3_safety_corrections", "4_capture_recovery",
    "5_db_clock_checkout_create", "6_api_rate_limits", "7_capture_claim_fence", "8_settled_evidence_immutable", "9_void_cancel_claim_fence",
    "10_recording_evidence_link", "11_recording_owner_cases", "12_recording_assessments", "13_recording_preflight_release",
    "14_recording_completion_binding", "15_scoped_recording_inbox", "16_guest_notification_fence", "17_cancelled_pristine_capture_release",
    "18_is_privileged_qualify"]);   // 0018 (is_privileged qualify) mechanical pin   // E7 (0015/0017): mechanical pin
  for (const x of m) for (const sql of [x.up, x.down]) {
    assert.doesNotMatch(sql, /PASSWORD\s+'|ENCRYPTED\s+PASSWORD|sk_(test|live)_|whsec_|postgres(ql)?:\/\//i);
  }
});

test("up applies everything once; a second up is a no-op (repeatable)", async () => {
  assert.deepEqual(await migrateUp(client, { env: "test" }), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
  assert.equal(await tables(), 28);
  assert.deepEqual(await migrateUp(client, { env: "test" }), []);
  assert.deepEqual(await migrateUp(client, { env: "test" }), []);
  const s = await migrationStatus(client, { env: "test" });
  assert.deepEqual(s, { applied: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18], pending: [], environment: "test" });
});

test("down then up restores an identical schema (repeatable round trip)", async () => {
  const snapshot = async () => (await client.query(`SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns
                                                     WHERE table_schema = 'booking' ORDER BY 1, 2`)).rows;
  const constraints = async () => (await client.query(`SELECT conrelid::regclass::text AS t, conname, pg_get_constraintdef(oid) AS d FROM pg_constraint
                                                       WHERE connamespace = 'booking'::regnamespace ORDER BY 1, 2`)).rows;
  const before1 = await snapshot(); const c1 = await constraints();
  assert.deepEqual(await migrateDown(client, { env: "test", to: 1 }), [18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
  assert.equal((await client.query("SELECT count(*)::int AS n FROM pg_roles WHERE rolname LIKE 'mv_booking_%'")).rows[0].n, 0);
  assert.deepEqual(await migrateDown(client, { env: "test" }), [1]);
  assert.equal((await client.query("SELECT to_regnamespace('booking') AS s")).rows[0].s, null);
  assert.deepEqual(await migrateUp(client, { env: "test" }), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
  assert.deepEqual(await snapshot(), before1);
  // constraint names/definitions identical after the round trip
  assert.deepEqual((await constraints()).map((r) => `${r.t}|${r.conname}|${r.d}`), c1.map((r) => `${r.t}|${r.conname}|${r.d}`));
});

test("E2B.2: 0005 down restores the 0004 functions, grants, constraints and indexes exactly; up re-applies identically", async () => {
  const objects = async () => (await client.query(`
      SELECT 'fn|' || p.oid::regprocedure::text || '|' || md5(pg_get_functiondef(p.oid)) || '|' || coalesce(array_to_string(p.proacl, ','), '') AS o
        FROM pg_proc p WHERE p.pronamespace = 'booking'::regnamespace
      UNION ALL SELECT 'con|' || conrelid::regclass::text || '|' || conname || '|' || pg_get_constraintdef(oid)
        FROM pg_constraint WHERE connamespace = 'booking'::regnamespace
      UNION ALL SELECT 'idx|' || indexrelid::regclass::text || '|' || pg_get_indexdef(indexrelid)
        FROM pg_index WHERE indrelid::regclass::text LIKE 'booking.%'
      UNION ALL SELECT 'trg|' || tgrelid::regclass::text || '|' || tgname FROM pg_trigger
        WHERE NOT tgisinternal AND tgrelid::regclass::text LIKE 'booking.%'
      ORDER BY 1`)).rows.map((r) => r.o);
  assert.deepEqual(await migrateDown(client, { env: "test", to: 6 }), [18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7]);        // E7.4a/E7.1a/E7.1: 0009, 0008, 0007 first
  const at6 = await objects();
  assert.deepEqual(await migrateDown(client, { env: "test", to: 5 }), [6]);              // E6: 0006 first
  const at5 = await objects();
  assert.deepEqual(await migrateDown(client, { env: "test", to: 4 }), [5]);
  const at4 = await objects();
  assert.ok(at4.some((o) => o.startsWith("fn|booking.release_completed_stays(timestamp with time zone)")), "0004 caller-time signature restored");
  assert.ok(!at4.some((o) => o.startsWith("fn|booking.release_completed_stays()|")));
  assert.ok(!at4.some((o) => o.includes("intent_transitions_stamp")));
  // 0004 as originally applied: fresh cluster at 4 must match the rolled-back state exactly
  const fresh = await startPostgres();
  const c2 = new pg.Client({ connectionString: fresh.adminUrl });
  await c2.connect();
  try {
    await migrateUp(c2, { env: "test", to: 4 });
    const q = client; client = c2;
    const fresh4 = await objects();
    client = q;
    assert.deepEqual(at4, fresh4, "rollback of 0005 leaves exactly the 0004 schema");
  } finally { await c2.end(); fresh.stop(); }
  assert.deepEqual(await migrateUp(client, { env: "test", to: 5 }), [5]);
  assert.deepEqual(await objects(), at5, "re-applying 0005 is identical");
  assert.deepEqual(await migrateUp(client, { env: "test", to: 6 }), [6]);
  assert.deepEqual(await objects(), at6, "re-applying 0006 is identical");
  assert.deepEqual(await migrateUp(client, { env: "test" }), [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
});

test("E6: 0006 down restores the 0005 schema exactly (fresh cluster at 5); up re-applies identically; runtime role can only call the function", async () => {
  const objects = async (c) => (await c.query(`
      SELECT 'fn|' || p.oid::regprocedure::text || '|' || md5(pg_get_functiondef(p.oid)) || '|' || coalesce(array_to_string(p.proacl, ','), '') AS o
        FROM pg_proc p WHERE p.pronamespace = 'booking'::regnamespace
      UNION ALL SELECT 'con|' || conrelid::regclass::text || '|' || conname || '|' || pg_get_constraintdef(oid)
        FROM pg_constraint WHERE connamespace = 'booking'::regnamespace
      UNION ALL SELECT 'idx|' || indexrelid::regclass::text || '|' || pg_get_indexdef(indexrelid)
        FROM pg_index WHERE indrelid::regclass::text LIKE 'booking.%'
      UNION ALL SELECT 'tbl|' || c.relname || '|' || c.relrowsecurity || '|' || coalesce(array_to_string(c.relacl, ','), '')
        FROM pg_class c WHERE c.relnamespace = 'booking'::regnamespace AND c.relkind = 'r'
      ORDER BY 1`)).rows.map((r) => r.o);
  assert.deepEqual(await migrateDown(client, { env: "test", to: 6 }), [18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7]);
  const at6 = await objects(client);
  assert.ok(at6.some((o) => o.startsWith("tbl|api_rate_limits|true|")), "RLS on");
  assert.ok(!at6.some((o) => o.startsWith("tbl|api_rate_limits|") && o.includes("mv_booking_app")), "no direct table privilege for the runtime role");
  const fn = at6.find((o) => o.startsWith("fn|booking.rate_limit_hit(text,integer,integer)|"));
  assert.ok(fn && fn.includes("mv_booking_app=X/") && !/(^|,)=X\//.test(fn.split("|")[3]), "EXECUTE for the runtime role only, not PUBLIC");
  assert.deepEqual(await migrateDown(client, { env: "test", to: 5 }), [6]);
  const at5 = await objects(client);
  const fresh = await startPostgres();
  const c2 = new pg.Client({ connectionString: fresh.adminUrl });
  await c2.connect();
  try { await migrateUp(c2, { env: "test", to: 5 }); assert.deepEqual(at5, await objects(c2), "rollback of 0006 leaves exactly the 0005 schema"); }
  finally { await c2.end(); fresh.stop(); }
  assert.deepEqual(await migrateUp(client, { env: "test", to: 6 }), [6]);
  assert.deepEqual(await objects(client), at6);
  assert.deepEqual(await migrateUp(client, { env: "test" }), [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
});

test("E7.1: 0007 down restores the 0006 schema exactly (fresh cluster at 6); up re-applies identically; fence trigger present", async () => {
  const objects = async (c) => (await c.query(`
      SELECT 'fn|' || p.oid::regprocedure::text || '|' || md5(pg_get_functiondef(p.oid)) || '|' || coalesce(array_to_string(p.proacl, ','), '') AS o
        FROM pg_proc p WHERE p.pronamespace = 'booking'::regnamespace
      UNION ALL SELECT 'trg|' || tgrelid::regclass::text || '|' || tgname || '|' || pg_get_triggerdef(oid) FROM pg_trigger
        WHERE NOT tgisinternal AND tgrelid::regclass::text LIKE 'booking.%'
      ORDER BY 1`)).rows.map((r) => r.o);
  assert.deepEqual(await migrateDown(client, { env: "test", to: 7 }), [18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8]);
  const at7 = await objects(client);
  assert.ok(at7.some((o) => o.includes("external_operations_capture_claim_fence")));
  const fn = at7.find((o) => o.startsWith("fn|booking.capture_claim_fence()|"));
  assert.ok(fn && !/(^|,)=X\//.test(fn.split("|")[3]), "not executable by PUBLIC");
  assert.deepEqual(await migrateDown(client, { env: "test", to: 6 }), [7]);
  const at6 = await objects(client);
  const fresh = await startPostgres();
  const c2 = new pg.Client({ connectionString: fresh.adminUrl });
  await c2.connect();
  try { await migrateUp(c2, { env: "test", to: 6 }); assert.deepEqual(at6, await objects(c2), "rollback of 0007 leaves exactly the 0006 schema"); }
  finally { await c2.end(); fresh.stop(); }
  assert.deepEqual(await migrateUp(client, { env: "test", to: 7 }), [7]);
  assert.deepEqual(await objects(client), at7);
  assert.deepEqual(await migrateUp(client, { env: "test" }), [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
});

test("E7.1a: 0008 down restores the 0007 schema exactly (fresh cluster at 7); up re-applies identically; privileges unchanged", async () => {
  const objects = async (c) => (await c.query(`
      SELECT 'fn|' || p.oid::regprocedure::text || '|' || md5(pg_get_functiondef(p.oid)) || '|' || coalesce(array_to_string(p.proacl, ','), '') AS o
        FROM pg_proc p WHERE p.pronamespace = 'booking'::regnamespace
      UNION ALL SELECT 'trg|' || tgrelid::regclass::text || '|' || tgname || '|' || pg_get_triggerdef(oid) FROM pg_trigger
        WHERE NOT tgisinternal AND tgrelid::regclass::text LIKE 'booking.%'
      UNION ALL SELECT 'col|' || table_name || '|' || column_name || '|' || data_type || '|' || is_nullable FROM information_schema.columns WHERE table_schema = 'booking'
      ORDER BY 1`)).rows.map((r) => r.o);
  // every table, column, sequence and routine privilege in the booking schema, plus role memberships of the booking roles
  const privileges = async (c) => (await c.query(`
      SELECT 'tbl|' || grantee || '|' || table_name || '|' || privilege_type AS o FROM information_schema.role_table_grants WHERE table_schema = 'booking'
      UNION ALL SELECT 'colg|' || grantee || '|' || table_name || '|' || column_name || '|' || privilege_type FROM information_schema.column_privileges WHERE table_schema = 'booking'
      UNION ALL SELECT 'fn|' || p.oid::regprocedure::text || '|' || coalesce(array_to_string(p.proacl, ','), 'default') FROM pg_proc p
        WHERE p.pronamespace = 'booking'::regnamespace AND p.proname <> 'settled_evidence_immutable'
      UNION ALL SELECT 'seq|' || c.relname || '|' || coalesce(array_to_string(c.relacl, ','), '') FROM pg_class c WHERE c.relnamespace = 'booking'::regnamespace AND c.relkind = 'S'
      UNION ALL SELECT 'mem|' || r.rolname || '|' || m.rolname FROM pg_auth_members a JOIN pg_roles r ON r.oid = a.roleid JOIN pg_roles m ON m.oid = a.member
        WHERE r.rolname LIKE 'mv_booking_%'
      ORDER BY 1`)).rows.map((r) => r.o);
  assert.deepEqual(await migrateDown(client, { env: "test", to: 8 }), [18, 17, 16, 15, 14, 13, 12, 11, 10, 9]);          // E7.4a: compare against the 0008 schema
  const at8 = await objects(client); const priv8 = await privileges(client);
  assert.ok(at8.some((o) => o.includes("zz_external_operations_settled_evidence_immutable")));
  const fn = at8.find((o) => o.startsWith("fn|booking.settled_evidence_immutable()|"));
  assert.ok(fn && !/(^|,)=X\//.test(fn.split("|")[3]), "not executable by PUBLIC");
  assert.ok(!/mv_booking_(app|report|admin)=X/.test(fn.split("|")[3]), "no new EXECUTE grant to any booking role");
  const def = (await client.query("SELECT prosecdef, proconfig FROM pg_proc WHERE proname = 'settled_evidence_immutable'")).rows[0];
  assert.deepEqual([def.prosecdef, def.proconfig], [false, ["search_path=pg_catalog"]], "not SECURITY DEFINER; fixed search_path");
  assert.deepEqual(await migrateDown(client, { env: "test", to: 7 }), [8]);
  const at7 = await objects(client);
  assert.deepEqual(await privileges(client), priv8, "0008 changes no privilege");
  const fresh = await startPostgres();
  const c2 = new pg.Client({ connectionString: fresh.adminUrl });
  await c2.connect();
  try { await migrateUp(c2, { env: "test", to: 7 }); assert.deepEqual(at7, await objects(c2), "rollback of 0008 leaves exactly the 0007 schema"); }
  finally { await c2.end(); fresh.stop(); }
  assert.deepEqual(await migrateUp(client, { env: "test", to: 8 }), [8]);
  assert.deepEqual(await objects(client), at8);
  assert.deepEqual(await privileges(client), priv8);
  assert.deepEqual(await migrateUp(client, { env: "test" }), [9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
});

test("a changed migration file is refused (checksum drift)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mv-mig-"));
  try {
    cpSync(DEFAULT_MIGRATIONS_DIR, dir, { recursive: true });
    appendFileSync(join(dir, "0001_booking_core.up.sql"), "\n-- edited after apply\n");
    await assert.rejects(migrateUp(client, { env: "test", dir }), (e) => e.code === "CHECKSUM_MISMATCH");
    await assert.rejects(migrationStatus(client, { env: "test", dir }), (e) => e.code === "CHECKSUM_MISMATCH");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("environment marker mismatch is refused; down is refused for live", async () => {
  await assert.rejects(migrateUp(client, { env: "live" }), (e) => e.code === "ENV_MISMATCH");
  await assert.rejects(migrateDown(client, { env: "live" }), (e) => e.code === "LIVE_DOWN_REFUSED");
  await assert.rejects(migrateUp(client, { env: "staging" }), (e) => e.code === "BAD_ENV");
  assert.equal((await client.query("SELECT environment FROM booking.instance")).rows[0].environment, "test");
});

test("CLI: works on loopback; refuses DATABASE_URL, remote hosts and missing variables", () => {
  const cli = (args, env = {}) => spawnSync(process.execPath, ["scripts/db-migrate.mjs", ...args], {
    encoding: "utf8", env: { PATH: process.env.PATH, ...env } });
  const okRun = cli(["status", "--env", "test", "--url-env", "MV_TEST_DB"], { MV_TEST_DB: db.adminUrl });
  assert.equal(okRun.status, 0, okRun.stderr);
  assert.deepEqual(JSON.parse(okRun.stdout).applied, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
  const legacy = cli(["status", "--env", "test", "--url-env", "DATABASE_URL"], { DATABASE_URL: db.adminUrl });
  assert.notEqual(legacy.status, 0);
  assert.match(legacy.stderr, /retired legacy variable/);
  const remote = cli(["status", "--env", "test", "--url-env", "MV_REMOTE"], { MV_REMOTE: "postgresql://u@db.example.invalid:5432/postgres" });
  assert.notEqual(remote.status, 0);
  assert.match(remote.stderr, /remote database refused/);
  assert.doesNotMatch(remote.stderr + remote.stdout, /db\.example\.invalid/, "connection details are never printed");
  const missing = cli(["status", "--env", "test", "--url-env", "MV_NOT_SET"]);
  assert.notEqual(missing.status, 0);
});

test("E7.4a: 0009 down restores the 0008 schema exactly (fresh cluster at 8); up re-applies identically; privileges unchanged", async () => {
  const objects = async (c) => (await c.query(`
      SELECT 'fn|' || p.oid::regprocedure::text || '|' || md5(pg_get_functiondef(p.oid)) || '|' || coalesce(array_to_string(p.proacl, ','), '') AS o
        FROM pg_proc p WHERE p.pronamespace = 'booking'::regnamespace
      UNION ALL SELECT 'trg|' || tgrelid::regclass::text || '|' || tgname || '|' || pg_get_triggerdef(oid) FROM pg_trigger
        WHERE NOT tgisinternal AND tgrelid::regclass::text LIKE 'booking.%'
      UNION ALL SELECT 'col|' || table_name || '|' || column_name || '|' || data_type || '|' || is_nullable FROM information_schema.columns WHERE table_schema = 'booking'
      ORDER BY 1`)).rows.map((r) => r.o);
  const privileges = async (c) => (await c.query(`
      SELECT 'tbl|' || grantee || '|' || table_name || '|' || privilege_type AS o FROM information_schema.role_table_grants WHERE table_schema = 'booking'
      UNION ALL SELECT 'colg|' || grantee || '|' || table_name || '|' || column_name || '|' || privilege_type FROM information_schema.column_privileges WHERE table_schema = 'booking'
      UNION ALL SELECT 'fn|' || p.oid::regprocedure::text || '|' || coalesce(array_to_string(p.proacl, ','), 'default') FROM pg_proc p
        WHERE p.pronamespace = 'booking'::regnamespace AND p.proname <> 'void_cancel_claim_fence'
      UNION ALL SELECT 'mem|' || r.rolname || '|' || m.rolname FROM pg_auth_members a JOIN pg_roles r ON r.oid = a.roleid JOIN pg_roles m ON m.oid = a.member
        WHERE r.rolname LIKE 'mv_booking_%'
      ORDER BY 1`)).rows.map((r) => r.o);
  assert.deepEqual(await migrateDown(client, { env: "test", to: 9 }), [18, 17, 16, 15, 14, 13, 12, 11, 10]);           // E7.4b-D2: measure 0009 itself (0010 off)
  const at9 = await objects(client); const priv9 = await privileges(client);
  assert.ok(at9.some((o) => o.includes("external_operations_void_cancel_claim_fence")));
  const fn = at9.find((o) => o.startsWith("fn|booking.void_cancel_claim_fence()|"));
  assert.ok(fn && !/(^|,)=X\//.test(fn.split("|")[3]), "not executable by PUBLIC");
  assert.ok(!/mv_booking_(app|report|admin)=X/.test(fn.split("|")[3]), "no new EXECUTE grant to any booking role");
  const def = (await client.query("SELECT prosecdef, proconfig FROM pg_proc WHERE proname = 'void_cancel_claim_fence'")).rows[0];
  assert.deepEqual([def.prosecdef, def.proconfig], [true, ["search_path=pg_catalog, booking"]], "as 0007: SECURITY DEFINER with a fixed search_path");
  assert.deepEqual(await migrateDown(client, { env: "test", to: 8 }), [9]);
  const at8 = await objects(client);
  assert.ok(!at8.some((o) => o.includes("void_cancel_claim_fence")));
  assert.deepEqual(await privileges(client), priv9, "0009 changes no privilege");
  const fresh = await startPostgres();
  const c2 = new pg.Client({ connectionString: fresh.adminUrl });
  await c2.connect();
  try { await migrateUp(c2, { env: "test", to: 8 }); assert.deepEqual(at8, await objects(c2), "rollback of 0009 leaves exactly the 0008 schema"); }
  finally { await c2.end(); fresh.stop(); }
  assert.deepEqual(await migrateUp(client, { env: "test", to: 9 }), [9]);
  assert.deepEqual(await objects(client), at9);
  assert.deepEqual(await migrateUp(client, { env: "test" }), [10, 11, 12, 13, 14, 15, 16, 17, 18]);
});

test("E7.4b-D2: 0010 down restores the 0009 schema exactly (fresh cluster at 9); up re-applies identically; only the two recording functions are app-executable", async () => {
  const objects = async (c) => (await c.query(`
      SELECT 'fn|' || p.oid::regprocedure::text || '|' || md5(pg_get_functiondef(p.oid)) || '|' || coalesce(array_to_string(p.proacl, ','), '') AS o
        FROM pg_proc p WHERE p.pronamespace = 'booking'::regnamespace
      UNION ALL SELECT 'trg|' || tgrelid::regclass::text || '|' || tgname || '|' || pg_get_triggerdef(oid) FROM pg_trigger
        WHERE NOT tgisinternal AND tgrelid::regclass::text LIKE 'booking.%'
      UNION ALL SELECT 'col|' || table_name || '|' || column_name || '|' || data_type || '|' || is_nullable FROM information_schema.columns WHERE table_schema = 'booking'
      UNION ALL SELECT 'tbl|' || grantee || '|' || table_name || '|' || privilege_type FROM information_schema.role_table_grants WHERE table_schema = 'booking'
      ORDER BY 1`)).rows.map((r) => r.o);
  const at10 = await objects(client);
  const acl = (name) => at10.filter((o) => o.startsWith(`fn|booking.${name}(`)).map((o) => o.split("|")[3]);
  for (const f of ["complete_recording_with_evidence", "link_recording_evidence"]) {
    assert.equal(acl(f).length, 1, f);
    assert.match(acl(f)[0], /mv_booking_app=X\//, `${f}: app EXECUTE`);
    assert.doesNotMatch(acl(f)[0], /(^|,)=X\/|mv_booking_(report|admin)=X/, `${f}: no PUBLIC / other role EXECUTE`);
  }
  for (const f of ["recording_proof_refusal", "recording_conflict_refusal", "recording_lifecycle_guard", "recording_finalisation_guard", "recording_latest_id",
    "recording_attempt_no"]) {
    assert.equal(acl(f).length, 1, f);
    assert.doesNotMatch(acl(f)[0], /(^|,)=X\/|mv_booking_(app|report|admin)=X/, `${f}: private (owner only)`);
  }
  const sd = (await client.query(`SELECT proname, prosecdef, provolatile, proconfig FROM pg_proc WHERE pronamespace = 'booking'::regnamespace
      AND proname IN ('recording_lifecycle_guard','recording_proof_refusal','recording_conflict_refusal','complete_recording_with_evidence',
                      'link_recording_evidence','recording_finalisation_guard') ORDER BY proname`)).rows;
  for (const r of sd) {
    assert.deepEqual(r.proconfig, ["search_path=pg_catalog, booking"], `${r.proname}: fixed search_path`);
    assert.equal(r.provolatile, "v", `${r.proname}: VOLATILE (fresh snapshot per statement)`);
    assert.equal(r.prosecdef, r.proname !== "recording_lifecycle_guard", `${r.proname}: ${r.proname === "recording_lifecycle_guard" ? "INVOKER" : "SECURITY DEFINER"}`);
  }
  // the two evidence writers keep their exact signatures and grants across 0010
  const writers = async () => (await client.query(`SELECT p.oid::regprocedure::text || '|' || coalesce(array_to_string(p.proacl, ','), '') AS o FROM pg_proc p
      WHERE p.pronamespace = 'booking'::regnamespace AND p.proname IN ('record_provider_evidence', 'admin_record_evidence') ORDER BY 1`)).rows.map((r) => r.o);
  const w10 = await writers();
  assert.deepEqual(await migrateDown(client, { env: "test", to: 9 }), [18, 17, 16, 15, 14, 13, 12, 11, 10]);
  const at9 = await objects(client);
  assert.deepEqual(await writers(), w10, "writer signatures / grants unchanged");
  assert.ok(!at9.some((o) => /recording_(lifecycle|finalisation|proof|conflict)|complete_recording|link_recording/.test(o)));
  const fresh = await startPostgres();
  const c2 = new pg.Client({ connectionString: fresh.adminUrl });
  await c2.connect();
  try { await migrateUp(c2, { env: "test", to: 9 }); assert.deepEqual(at9, await objects(c2), "rollback of 0010 leaves exactly the 0009 schema (incl. the 0003 writer bodies)"); }
  finally { await c2.end(); fresh.stop(); }
  assert.deepEqual(await migrateUp(client, { env: "test" }), [10, 11, 12, 13, 14, 15, 16, 17, 18]);
  assert.deepEqual(await objects(client), at10);
});

test("E7.4b-D1: 0011 down restores the 0010 schema exactly (fresh cluster at 10: function bodies, ACLs, triggers, columns, grants, policies); up re-applies identically; no 0012 object exists (measured at 11; 0012 is rolled back first and re-applied last)", async () => {
  assert.deepEqual(await migrateDown(client, { env: "test", to: 11 }), [18, 17, 16, 15, 14, 13, 12]);             // E7.4b-D1 (0012 / 0013): measure 0011 itself
  const objects = async (c) => (await c.query(`
      SELECT 'fn|' || p.oid::regprocedure::text || '|' || md5(pg_get_functiondef(p.oid)) || '|' || coalesce(array_to_string(p.proacl, ','), '') AS o
        FROM pg_proc p WHERE p.pronamespace = 'booking'::regnamespace
      UNION ALL SELECT 'trg|' || tgrelid::regclass::text || '|' || tgname || '|' || pg_get_triggerdef(oid) FROM pg_trigger
        WHERE NOT tgisinternal AND tgrelid::regclass::text LIKE 'booking.%'
      UNION ALL SELECT 'col|' || table_name || '|' || column_name || '|' || data_type || '|' || is_nullable FROM information_schema.columns WHERE table_schema = 'booking'
      UNION ALL SELECT 'tbl|' || grantee || '|' || table_name || '|' || privilege_type FROM information_schema.role_table_grants WHERE table_schema = 'booking'
      UNION ALL SELECT 'pol|' || tablename || '|' || policyname || '|' || array_to_string(roles, ',') || '|' || cmd FROM pg_policies WHERE schemaname = 'booking'
      UNION ALL SELECT 'con|' || conrelid::regclass::text || '|' || conname || '|' || pg_get_constraintdef(oid) FROM pg_constraint
        WHERE connamespace = 'booking'::regnamespace
      ORDER BY 1`)).rows.map((r) => r.o);
  const at11 = await objects(client);
  const acl = (name) => at11.filter((o) => o.startsWith(`fn|booking.${name}(`)).map((o) => o.split("|")[3]);
  for (const f of ["open_recording_visibility_hold", "process_recording_conflict_inbox_one", "recording_contradictions_page"]) {
    assert.equal(acl(f).length, 1, f);
    assert.match(acl(f)[0], /mv_booking_app=X\//, `${f}: app EXECUTE`);
    assert.match(acl(f)[0], /mv_booking_admin=X\//, `${f}: admin EXECUTE`);
    assert.doesNotMatch(acl(f)[0], /(^|,)=X\/|mv_booking_report=X/, `${f}: no PUBLIC / report EXECUTE`);
  }
  assert.match(acl("admin_resolve_recording_hold")[0], /mv_booking_admin=X\//);
  assert.doesNotMatch(acl("admin_resolve_recording_hold")[0], /(^|,)=X\/|mv_booking_(app|report)=X/, "owner decisions: admin only");
  for (const f of ["recording_evidence_contradicts", "recording_active_hold_id", "recording_claim_fence", "recording_inbox_enqueue", "reserved_case_guard",
    "reserved_case_binding_check", "reserved_case_binding_verify", "recording_holds_guard", "recording_hold_decisions_guard",
    "recording_hold_observations_guard", "recording_conflict_inbox_guard"]) {
    assert.equal(acl(f).length, 1, f);
    assert.doesNotMatch(acl(f)[0], /(^|,)=X\/|mv_booking_(app|report|admin)=X/, `${f}: private (owner only)`);
  }
  const defs = (await client.query(`SELECT proname, prosecdef, proconfig FROM pg_proc WHERE pronamespace = 'booking'::regnamespace AND proname IN
      ('recording_evidence_contradicts','recording_conflict_refusal','open_recording_visibility_hold','process_recording_conflict_inbox_one',
       'recording_contradictions_page','admin_resolve_recording_hold','recording_claim_fence','recording_inbox_enqueue','reserved_case_binding_verify',
       'reserved_case_guard','recording_holds_guard') ORDER BY proname`)).rows;
  assert.equal(defs.length, 11);
  for (const r of defs) {
    assert.deepEqual(r.proconfig, ["search_path=pg_catalog, booking"], `${r.proname}: fixed search_path`);
    assert.equal(r.prosecdef, !["reserved_case_guard", "recording_holds_guard"].includes(r.proname), `${r.proname}: security mode`);
  }
  // no role may write the owner-hold tables directly; SELECT for app / admin / report only
  const writes = at11.filter((o) => /^tbl\|mv_booking_(app|admin|report)\|recording_(holds|hold_decisions|hold_observations|conflict_inbox)\|/.test(o)
    && !o.endsWith("|SELECT"));
  assert.deepEqual(writes, []);
  assert.equal(at11.filter((o) => /^tbl\|mv_booking_(app|admin|report)\|recording_(holds|hold_decisions|hold_observations|conflict_inbox)\|SELECT$/.test(o)).length, 12);
  // 0012 is absent: no assessments table / assessment_id column / preflight reason
  assert.ok(!at11.some((o) => /recording_assessments|assessment_id|PREFLIGHT/.test(o)), "no 0012 placeholder");
  const writers = async () => (await client.query(`SELECT p.oid::regprocedure::text || '|' || md5(pg_get_functiondef(p.oid)) || '|' || coalesce(array_to_string(p.proacl, ','), '') AS o
      FROM pg_proc p WHERE p.pronamespace = 'booking'::regnamespace AND p.proname IN ('record_provider_evidence', 'admin_record_evidence') ORDER BY 1`)).rows.map((r) => r.o);
  const w11 = await writers();
  assert.deepEqual(await migrateDown(client, { env: "test", to: 10 }), [11]);
  const at10 = await objects(client);
  assert.deepEqual(await writers(), w11, "the two evidence writers are not changed by 0011");
  const fresh = await startPostgres();
  const c2 = new pg.Client({ connectionString: fresh.adminUrl });
  await c2.connect();
  try { await migrateUp(c2, { env: "test", to: 10 }); assert.deepEqual(at10, await objects(c2), "rollback of 0011 leaves exactly the 0010 schema (bodies, ACLs, policies, constraints)"); }
  finally { await c2.end(); fresh.stop(); }
  assert.deepEqual(await migrateUp(client, { env: "test", to: 11 }), [11]);
  assert.deepEqual(await objects(client), at11);
  assert.deepEqual(await migrateUp(client, { env: "test" }), [12, 13, 14, 15, 16, 17, 18]);
});
