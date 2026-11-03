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
    "5_db_clock_checkout_create", "6_api_rate_limits", "7_capture_claim_fence"]);
  for (const x of m) for (const sql of [x.up, x.down]) {
    assert.doesNotMatch(sql, /PASSWORD\s+'|ENCRYPTED\s+PASSWORD|sk_(test|live)_|whsec_|postgres(ql)?:\/\//i);
  }
});

test("up applies everything once; a second up is a no-op (repeatable)", async () => {
  assert.deepEqual(await migrateUp(client, { env: "test" }), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(await tables(), 18);
  assert.deepEqual(await migrateUp(client, { env: "test" }), []);
  assert.deepEqual(await migrateUp(client, { env: "test" }), []);
  const s = await migrationStatus(client, { env: "test" });
  assert.deepEqual(s, { applied: [1, 2, 3, 4, 5, 6, 7], pending: [], environment: "test" });
});

test("down then up restores an identical schema (repeatable round trip)", async () => {
  const snapshot = async () => (await client.query(`SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns
                                                     WHERE table_schema = 'booking' ORDER BY 1, 2`)).rows;
  const constraints = async () => (await client.query(`SELECT conrelid::regclass::text AS t, conname, pg_get_constraintdef(oid) AS d FROM pg_constraint
                                                       WHERE connamespace = 'booking'::regnamespace ORDER BY 1, 2`)).rows;
  const before1 = await snapshot(); const c1 = await constraints();
  assert.deepEqual(await migrateDown(client, { env: "test", to: 1 }), [7, 6, 5, 4, 3, 2]);
  assert.equal((await client.query("SELECT count(*)::int AS n FROM pg_roles WHERE rolname LIKE 'mv_booking_%'")).rows[0].n, 0);
  assert.deepEqual(await migrateDown(client, { env: "test" }), [1]);
  assert.equal((await client.query("SELECT to_regnamespace('booking') AS s")).rows[0].s, null);
  assert.deepEqual(await migrateUp(client, { env: "test" }), [1, 2, 3, 4, 5, 6, 7]);
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
  assert.deepEqual(await migrateDown(client, { env: "test", to: 6 }), [7]);              // E7.1: 0007 first
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
  assert.deepEqual(await migrateUp(client, { env: "test" }), [7]);
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
  assert.deepEqual(await migrateDown(client, { env: "test", to: 6 }), [7]);
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
  assert.deepEqual(await migrateUp(client, { env: "test" }), [7]);
});

test("E7.1: 0007 down restores the 0006 schema exactly (fresh cluster at 6); up re-applies identically; fence trigger present", async () => {
  const objects = async (c) => (await c.query(`
      SELECT 'fn|' || p.oid::regprocedure::text || '|' || md5(pg_get_functiondef(p.oid)) || '|' || coalesce(array_to_string(p.proacl, ','), '') AS o
        FROM pg_proc p WHERE p.pronamespace = 'booking'::regnamespace
      UNION ALL SELECT 'trg|' || tgrelid::regclass::text || '|' || tgname || '|' || pg_get_triggerdef(oid) FROM pg_trigger
        WHERE NOT tgisinternal AND tgrelid::regclass::text LIKE 'booking.%'
      ORDER BY 1`)).rows.map((r) => r.o);
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
  assert.deepEqual(await migrateUp(client, { env: "test" }), [7]);
  assert.deepEqual(await objects(client), at7);
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
  assert.deepEqual(JSON.parse(okRun.stdout).applied, [1, 2, 3, 4, 5, 6, 7]);
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
