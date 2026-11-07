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
import { migrateUp, migrationStatus } from "../../db/lib/migrate.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WRAPPER = readFileSync(join(ROOT, "claude/e7-0018-sqleditor-apply-v1.sql"), "utf8");
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
  await expectRaise(A.c, /E7_0018_FUNCTION_ACL_DRIFT/);
  await A.c.query("REVOKE EXECUTE ON FUNCTION booking.is_privileged() FROM mv_booking_report");
  assert.equal(await prosrcSha(A.c), C_SRC_OLD, "ACL drift: function unchanged");
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
    const booking0 = (await B.c.query("SELECT count(*)::int AS n FROM booking.instance")).rows[0].n;
    assert.equal(booking0, 1, "nonempty booking fixture present (booking.instance)");
    const res = await runWrapper(B.c);
    const last = Array.isArray(res) ? res[res.length - 1] : res;    // multi-statement simple query → array of results; the SELECT is last
    const status = last.rows[0].e7_0018_status;
    assert.equal(status.migrations_max, 18); assert.equal(status.v18, true);
    assert.equal(status.is_privileged_prosrc_sha256, C_SRC_NEW, "qualified body after apply");
    assert.deepEqual(status.is_privileged_proconfig, ["search_path=pg_catalog, pg_temp"]);
    // migrator compatibility: it sees 1..18 applied, no checksum drift, and a further up is a no-op
    const st = await migrationStatus(B.c, { env: "test" });
    assert.deepEqual(st.applied, [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18]);
    assert.deepEqual(st.pending, []);
    assert.deepEqual(await migrateUp(B.c, { env: "test" }), [], "migrator no-op after the wrapper applied 18");
    // replay refused
    await expectRaise(B.c, /E7_0018_ALREADY_APPLIED_OR_LATER/);
    assert.equal(await prosrcSha(B.c), C_SRC_NEW, "replay left the applied fix in place, nothing doubled");
    assert.equal((await B.c.query("SELECT count(*)::int AS n FROM booking_migrations.applied WHERE version=18")).rows[0].n, 1, "exactly one v18 row");
  } finally { await B.end(); }
});
