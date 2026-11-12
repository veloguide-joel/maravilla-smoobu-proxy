// e7-0018-sqleditor-apply-wrapper — proves claude/e7-0018-sqleditor-apply-v1.sql on DISPOSABLE PostgreSQL (root 3ab11ddf C).
// The wrapper is the reviewable SQL-editor apply candidate (NOT applied to any shared DB). It mirrors migrateUp for ONE version:
// advisory xact lock 7302215001, re-verified history/env/body/ACL, the embedded 0018 up (sha-checked), ONE tracking row, post-fingerprints.
// Scenarios: healthy apply + migrator compatibility; replay refused; marker / history / body / ACL drift refusals (function unchanged);
// forced tracking-insert failure rolls the function change back; a held xact lock times out. No shared DB, no push.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import { startPostgres } from "./harness.mjs";
import * as F from "./fixtures.mjs";
import { migrateUp, migrationStatus } from "../../db/lib/migrate.js";

const ACL_EXACT = ["mv_booking_admin=X/postgres", "mv_booking_app=X/postgres", "postgres=X/postgres"];   // root live baseline

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WRAPPER = readFileSync(join(ROOT, "claude/e7-0018-sqleditor-apply-v1.sql"), "utf8");
const READBACK = readFileSync(join(ROOT, "claude/e7-0018-readback-v1.sql"), "utf8");
const C_HIST17 = "c8b46a43693a1ab222534ee7f49401beb171eb7ecb7512bb3889d9ed7f04d4c3";
const C_SRC_OLD = "701fade99915db198c1aff0eee3e94d7106c314480ee5863321739444ba20c69";
const C_SRC_NEW = "a14a1dc5befcd96d03ca1c7e28020c5b07b6d1b212510cc1ad715368bc43fb9d";
const OLD_BODY = "CREATE OR REPLACE FUNCTION booking.is_privileged() RETURNS boolean LANGUAGE sql STABLE AS $$\n" +
  "  SELECT current_user::text = (SELECT pg_get_userbyid(nspowner)::text FROM pg_namespace WHERE nspname = 'booking')\n$$;";

// a disposable cluster migrated to EXACTLY version 17 (0018 left for the wrapper), owner = postgres
async function clusterAt17() {
  const db = await startPostgres();
  const c = new pg.Client({ connectionString: db.adminUrl }); await c.connect();
  await migrateUp(c, { env: "test", to: 17 });
  // login roles (mirror startMigratedDatabase) so the app path can seed a realistic fixture
  await c.query("CREATE ROLE test_app LOGIN IN ROLE mv_booking_app");
  await c.query("CREATE ROLE test_report LOGIN IN ROLE mv_booking_report");
  await c.query("CREATE ROLE test_admin LOGIN IN ROLE mv_booking_admin");
  return { db, c, end: async () => { await c.end().catch(() => {}); db.stop(); } };
}
const prosrcSha = async (c) => (await c.query("SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') AS s FROM pg_proc WHERE oid='booking.is_privileged()'::regprocedure")).rows[0].s;
const runWrapper = (c) => c.query(WRAPPER);                         // DO + trailing SELECT as one simple query; the SELECT row is returned
const expectRaise = async (c, re) => { let msg = null; try { await runWrapper(c); } catch (e) { msg = e.message; } assert.ok(msg && re.test(msg), `expected ${re}, got ${msg}`); };

let A;
before(async () => { A = await clusterAt17(); });
after(async () => { await A.end(); });

test("C1 disposable PRE aggregate of 0001-0017 equals root's pinned c_hist17 (validates the wrapper's live history gate)", async () => {
  const h = (await A.c.query(`SELECT encode(sha256(convert_to(string_agg(version||':'||name||':'||up_checksum||':'||down_checksum, E'\\n' ORDER BY version),'UTF8')),'hex') AS h FROM booking_migrations.applied`)).rows[0].h;
  assert.equal(h, C_HIST17, "accepted 0001-0017 files reproduce root's live applied-aggregate");
  assert.equal(await prosrcSha(A.c), C_SRC_OLD, "live/0003 body present before apply");
  const acl = (await A.c.query("SELECT array_agg(a::text ORDER BY a::text) AS arr FROM unnest((SELECT proacl FROM pg_proc WHERE oid='booking.is_privileged()'::regprocedure)) a")).rows[0].arr;
  assert.deepEqual(acl, ACL_EXACT, "disposable baseline ACL == pinned exact set (owner postgres / app / admin only; no PUBLIC, no other grantee)");
});

test("C2 drift refusals leave the function unchanged (marker / history / body / ACL), each restored exactly after", async () => {
  const aggregate = async () => (await A.c.query(`SELECT encode(sha256(convert_to(string_agg(version||':'||name||':'||up_checksum||':'||down_checksum, E'\\n' ORDER BY version),'UTF8')),'hex') AS h FROM booking_migrations.applied`)).rows[0].h;
  // marker drift
  await A.c.query("UPDATE booking.instance SET environment = 'live'");
  await expectRaise(A.c, /E7_0018_NOT_TEST/);
  assert.equal(await prosrcSha(A.c), C_SRC_OLD, "marker drift: function unchanged");
  await A.c.query("UPDATE booking.instance SET environment = 'test'");
  // history drift: tamper one applied checksum, then restore it exactly from the file checksum
  const { loadMigrations } = await import("../../db/lib/migrate.js");
  const m10 = loadMigrations().find((x) => x.version === 10);
  await A.c.query("UPDATE booking_migrations.applied SET up_checksum = repeat('0',64) WHERE version = 10");
  await expectRaise(A.c, /E7_0018_HISTORY_DRIFT/);
  assert.equal(await prosrcSha(A.c), C_SRC_OLD, "history drift: function unchanged");
  await A.c.query("UPDATE booking_migrations.applied SET up_checksum = $1 WHERE version = 10", [m10.upChecksum]);
  assert.equal(await aggregate(), C_HIST17, "history restored exactly");
  // body drift: a changed (but still INVOKER/STABLE) body
  await A.c.query("CREATE OR REPLACE FUNCTION booking.is_privileged() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$");
  await expectRaise(A.c, /E7_0018_FUNCTION_BODY_DRIFT/);
  await A.c.query(OLD_BODY);
  assert.equal(await prosrcSha(A.c), C_SRC_OLD, "0003 body restored byte-exact");
  // ACL drift: grant report EXECUTE (the wrapper must refuse; real grants are app + admin only)
  await A.c.query("GRANT EXECUTE ON FUNCTION booking.is_privileged() TO mv_booking_report");
  await expectRaise(A.c, /E7_0018_FUNCTION_ACL/);                       // report EXECUTE: caught by exact set and/or effective report check
  await A.c.query("REVOKE EXECUTE ON FUNCTION booking.is_privileged() FROM mv_booking_report");
  assert.equal(await prosrcSha(A.c), C_SRC_OLD, "ACL drift (report): function unchanged");
  // EXTRA-GRANTEE drift (root 3ab11ddf): an UNRELATED role with EXECUTE — the effective app/admin/report/PUBLIC checks all still
  // pass, so only the EXACT-set gate catches it. This is why the gate pins the exact aclitem set, not just four effective checks.
  await A.c.query("CREATE ROLE _e7_extra NOLOGIN");
  await A.c.query("GRANT EXECUTE ON FUNCTION booking.is_privileged() TO _e7_extra");
  await expectRaise(A.c, /E7_0018_FUNCTION_ACL_NOT_EXACT/);
  assert.equal(await prosrcSha(A.c), C_SRC_OLD, "extra-grantee drift: function unchanged");
  await A.c.query("REVOKE EXECUTE ON FUNCTION booking.is_privileged() FROM _e7_extra");
  await A.c.query("DROP ROLE _e7_extra");
  const aclBack = (await A.c.query("SELECT array_agg(a::text ORDER BY a::text) AS arr FROM unnest((SELECT proacl FROM pg_proc WHERE oid='booking.is_privileged()'::regprocedure)) a")).rows[0].arr;
  assert.deepEqual(aclBack, ACL_EXACT, "ACL restored to the exact baseline after the drift probes");
});

test("C3 forced tracking-insert failure rolls the whole statement back (the function change is NOT left behind)", async () => {
  await A.c.query("ALTER TABLE booking_migrations.applied ADD CONSTRAINT _e7_no18 CHECK (version <> 18)");  // make the INSERT (18,...) fail AFTER the function is replaced
  await expectRaise(A.c, /_e7_no18|check constraint|violates/i);
  assert.equal(await prosrcSha(A.c), C_SRC_OLD, "atomic: function reverted when the tracking insert failed");
  assert.equal((await A.c.query("SELECT count(*)::int AS n FROM booking_migrations.applied WHERE version = 18")).rows[0].n, 0, "no tracking row");
  await A.c.query("ALTER TABLE booking_migrations.applied DROP CONSTRAINT _e7_no18");
});

test("C4 a held migration xact lock makes the wrapper time out (lock_timeout 5s), function unchanged", async () => {
  const holder = new pg.Client({ connectionString: A.db.adminUrl }); await holder.connect();
  await holder.query("BEGIN"); await holder.query("SELECT pg_advisory_xact_lock(7302215001)");
  try {
    let code = null; try { await runWrapper(A.c); } catch (e) { code = e.code; }
    assert.equal(code, "55P03", "lock_not_available within lock_timeout");
    assert.equal(await prosrcSha(A.c), C_SRC_OLD, "lock timeout: function unchanged");
  } finally { await holder.query("ROLLBACK").catch(() => {}); await holder.end(); }
});

test("C5 healthy apply (fresh cluster) + migrator compatibility + replay refused; booking rows unchanged; exact POST fingerprints", async () => {
  const B = await clusterAt17();
  try {
    assert.equal(await prosrcSha(B.c), C_SRC_OLD);
    // nonempty booking fixture via the accepted app path (F.pending): 2 synthetic pending intents, each touching several booking tables
    const appPool = new pg.Pool({ connectionString: B.db.appUrl(), max: 2 });
    try { await F.pending(appPool, { listingId: 606998, from: "2028-02-01", to: "2028-02-04" }); await F.pending(appPool, { listingId: 606998, from: "2028-03-01", to: "2028-03-04" }); }
    finally { await appPool.end(); }
    const counts = (await B.c.query(`SELECT t.relname AS rel,
        (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM booking.%I', t.relname), false, true, '')))[1]::text::int AS n
      FROM pg_class t JOIN pg_namespace s ON s.oid = t.relnamespace WHERE s.nspname = 'booking' AND t.relkind IN ('r','p') ORDER BY 1`)).rows.filter((r) => r.n > 0);
    console.log("C5 nonempty booking fixture (seeded rows):", JSON.stringify(counts));
    assert.equal(counts.find((r) => r.rel === "intents")?.n, 2, "2 synthetic intents seeded");
    assert.ok(counts.length >= 4, "several nonempty booking tables (intents, intent_transitions, intent_work, instance, payment_attempts, external_operations…)");
    const res = await runWrapper(B.c);
    const last = Array.isArray(res) ? res[res.length - 1] : res;    // multi-statement simple query → array of results; the SELECT is last
    const status = last.rows[0].e7_0018_status;
    assert.equal(status.migrations_max, 18); assert.equal(status.v18, true);
    assert.equal(status.is_privileged_prosrc_sha256, C_SRC_NEW, "qualified body after apply");
    assert.deepEqual(status.is_privileged_proconfig, ["search_path=pg_catalog, pg_temp"]);
    // migrator compatibility: it sees 1..18 applied, no checksum drift, and a further up is a no-op
    const st = await migrationStatus(B.c, { env: "test" });
    assert.deepEqual(st.applied, [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18]);
    assert.deepEqual(st.pending, [19]);                                                   // 0019 (local candidate) is the only later migration
    assert.deepEqual(await migrateUp(B.c, { env: "test", to: 18 }), [], "migrator no-op (through 18) after the wrapper applied 18");
    // replay refused
    await expectRaise(B.c, /E7_0018_ALREADY_APPLIED_OR_LATER/);
    assert.equal(await prosrcSha(B.c), C_SRC_NEW, "replay left the applied fix in place, nothing doubled");
    assert.equal((await B.c.query("SELECT count(*)::int AS n FROM booking_migrations.applied WHERE version=18")).rows[0].n, 1, "exactly one v18 row");
  } finally { await B.end(); }
});

test("C6 read-only PRE/POST artifact (claude/e7-0018-readback-v1.sql) pins the delta: only is_privileged prosrc+proconfig change; migrations 17->18; other-function and booking-table fingerprints identical", async () => {
  const D = await clusterAt17();
  try {
    const appPool = new pg.Pool({ connectionString: D.db.appUrl(), max: 2 });
    try { await F.pending(appPool, { listingId: 606998, from: "2028-04-01", to: "2028-04-04" }); await F.pending(appPool, { listingId: 606998, from: "2028-05-01", to: "2028-05-04" }); }
    finally { await appPool.end(); }
    const readback = async () => (await D.c.query(READBACK)).rows[0].e7_0018_readback;
    const pre = await readback();
    assert.equal(pre.is_privileged.prosrc_sha256, C_SRC_OLD); assert.equal(pre.is_privileged.proconfig, null);
    assert.deepEqual(pre.is_privileged.acl, ACL_EXACT); assert.equal(pre.migrations.max, 17); assert.equal(pre.migrations.aggregate, C_HIST17);
    await runWrapper(D.c);
    const post = await readback();
    assert.equal(post.is_privileged.prosrc_sha256, C_SRC_NEW, "POST: qualified body");
    assert.deepEqual(post.is_privileged.proconfig, ["search_path=pg_catalog, pg_temp"], "POST: pinned search_path");
    assert.deepEqual(post.is_privileged.acl, ACL_EXACT, "POST: ACL unchanged (exact set)");
    assert.equal(post.is_privileged.oid, pre.is_privileged.oid, "POST: same oid (CREATE OR REPLACE)");
    assert.deepEqual(post.is_privileged.report_execute, false, "POST: report still denied");
    assert.equal(post.migrations.max, 18); assert.equal(post.migrations.aggregate_1_17, pre.migrations.aggregate_1_17, "0001-0017 history unchanged");
    assert.equal(post.migrations.v18.up_checksum, "e0289e3599705b7eac34605f3b5074eee0c78ef69169341945cfdfa998126015");
    assert.equal(post.other_functions_fingerprint, pre.other_functions_fingerprint, "no other booking function changed");
    assert.deepEqual(post.booking_tables_fingerprint, pre.booking_tables_fingerprint, "every booking table row-fingerprint identical (zero booking-row writes)");
  } finally { await D.end(); }
});
