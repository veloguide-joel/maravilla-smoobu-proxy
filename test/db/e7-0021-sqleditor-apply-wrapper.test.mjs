// e7-0021-sqleditor-apply-wrapper — proves claude/e7-0021-sqleditor-apply-v1.sql + claude/e7-0021-readback-v1.sql on DISPOSABLE PostgreSQL ONLY
// (LABELLED SPECIALISATION of test/db/e7-0019-0020-sqleditor-apply-wrapper.test.mjs for ONE migration, 0021, on a cluster that ALREADY carries exactly
// 0001-0020). The wrapper is reviewable FUTURE prep for the shared DEV TEST database — NOT applied anywhere shared (shared DEV is at 0018; the 0019/0020
// issuance HOLD is unchanged; nothing here authorises an apply, retry or fallback).
// Scenarios: deterministic assembly (pins re-derived here == committed pins; regeneration byte-identical; embedded up bytes == the merged 0021 file; 0019 /
// 0020 NEVER embedded; the spent 0019/0020 packet artifacts byte-untouched); healthy apply fresh 0020 -> 21 with nonempty booking fixture (rows
// byte-identical) + migrator compatibility (1..21, nothing pending, further up a no-op) + replay refused; refusals that leave the schema unchanged: wrong
// environment, history drift (incl. a drifted 0019 / 0020 row), wrong role (admin / app), 0018 and 0019/0020 prerequisite drift, 0021 vocabulary already
// present, schema-identity drift (extra function; ACL widening; RLS / policy changes), active hosted-run lock, work / intent / operation lease, in-flight
// write, held migrator lock (lock_timeout); interruption rollback (forced tracking-row failure AFTER the up: no 0021 function / table / column / row survives);
// readback PRE / POST agreement; protected 0001-0020 rows unchanged; forward-only down limits; the REAL time bound at the transport with caller settings preserved.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import { startPostgres } from "./harness.mjs";
import * as F from "./fixtures.mjs";
import { migrateUp, migrateDown, migrationStatus, loadMigrations } from "../../db/lib/migrate.js";
import { LOCK_KEY } from "../../scripts/e7-connected/run-lock-precheck.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const rd = (p) => readFileSync(join(ROOT, p), "utf8");
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const WRAPPER = rd("claude/e7-0021-sqleditor-apply-v1.sql"); const READBACK = rd("claude/e7-0021-readback-v1.sql");
const INVENTORY = rd("claude/e7-0021-inventory.sql"); const PINS = JSON.parse(rd("claude/e7-0021-pins-v1.json"));
const IDENTITY_KEYS = ["functions", "function_count", "triggers", "trigger_count", "constraints", "indexes", "columns", "table_acls", "rls", "rls_enabled_count", "policies", "policy_count", "schema_owner",
  "is_privileged_src", "is_privileged_config", "test_cleanup_pending_state", "prerequisite_0020", "objects", "acls"];
const identity = (inv) => Object.fromEntries(IDENTITY_KEYS.map((k) => [k, inv[k]]));
const M = loadMigrations(); const m21 = M.find((m) => m.version === 21); const m19 = M.find((m) => m.version === 19); const m20 = M.find((m) => m.version === 20);
/** the SPENT 0019/0020 packet artifacts (ROOT: never alter their bytes) — pinned here and asserted untouched */
const SPENT = Object.freeze({ "claude/e7-0019-0020-sqleditor-apply-v1.sql": "528eeee53a89dd4f5b072fe2f7ce1f8f28f0e11d87ef08bd95ebc8fc5562f425", "claude/e7-0019-0020-readback-v1.sql": "3993363d9acd2595f601dcb75ccaf296767416112558829a9baf9fbb3843c809",
  "claude/e7-0019-0020-inventory.sql": "891f3e2521dba0910739a93966c5392ecbee512d4a1e0138d2f6467103aab29d", "claude/e7-0019-0020-pins-v1.json": "9edf7888248d76fb476de3712c915b76d1545f71585640d28ff1048eb6619c43",
  "claude/gen-0019-0020-wrapper.py": "cd2c8700fab6e65b33100251d0e2525430ceaba01e20616c8d69b188715e7c2a", "claude/derive-0019-0020-pins.mjs": "aadc94b35c3595dcc80a52668581bf71c2da83fb1b47182ae08e0b9cfe3e1e33" });

// a disposable cluster migrated to EXACTLY version 20 (0021 left for the wrapper), owner = postgres, login roles as startMigratedDatabase
async function clusterAt20() {
  const db = await startPostgres();
  const c = new pg.Client({ connectionString: db.adminUrl }); await c.connect();
  await migrateUp(c, { env: "test", to: 20 });
  await c.query("CREATE ROLE test_app LOGIN IN ROLE mv_booking_app");
  await c.query("CREATE ROLE test_report LOGIN IN ROLE mv_booking_report");
  await c.query("CREATE ROLE test_admin LOGIN IN ROLE mv_booking_admin");
  return { db, c, end: async () => { await c.end().catch(() => {}); db.stop(); } };
}
const inventory = async (c) => (await c.query(INVENTORY)).rows[0].e7_inventory;
const readback = async (c) => (await c.query(READBACK)).rows[0].e7_21_readback;
const runWrapper = async (c, text = WRAPPER) => { const res = await c.query(text); return res[res.length - 1].rows[0].e7_21_status; };   // SET LOCAL; SET LOCAL; DO; SELECT → the SELECT is last
const expectRaise = async (c, re) => { let msg = null; try { await runWrapper(c); } catch (e) { msg = e.message; } assert.ok(msg && re.test(msg), `expected ${re}, got ${msg}`); };
const unchanged = async (c, pre) => { const inv = await inventory(c); assert.deepEqual(identity(inv), identity(pre), "schema identity unchanged after the refusal"); assert.equal(inv.migrations.max, 20); assert.deepEqual(inv.objects, PINS.pre.objects); };
async function seedFixture(db) {
  const appPool = new pg.Pool({ connectionString: db.appUrl(), max: 2 });
  try { await F.pending(appPool, { listingId: 606998, from: "2028-02-01", to: "2028-02-04", currency: "USD" }); await F.reserved(appPool, { listingId: 606998, from: "2028-03-01", to: "2028-03-04", currency: "USD" }); }
  finally { await appPool.end(); }
}
const gone21 = async (c) => (await c.query(`SELECT to_regprocedure('booking.complete_offline_refund_with_evidence(uuid,text,uuid,text,integer)') IS NULL AS f, to_regclass('booking.notification_suppressions') IS NULL AS t,
  NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'booking' AND table_name = 'intents' AND column_name = 'settlement_recording_mirrored') AS col,
  to_regclass('booking.external_operations_one_offline_refund_ever') IS NULL AS idx, (SELECT count(*)::int FROM booking_migrations.applied WHERE version >= 21) = 0 AS rows`)).rows[0];

let A; let PRE;
before(async () => { A = await clusterAt20(); PRE = await inventory(A.c); });
after(async () => { await A.end(); });

test("C0 deterministic assembly: the committed pins equal a fresh derivation on THIS disposable cluster (PRE at 0020); the embedded up bytes are the merged 0021 file; 0019 / 0020 are NEVER embedded and their spent packet artifacts are byte-untouched; the inventory probe hash matches; the generator regenerates both artifacts byte-identically; the lock key is the hosted runners' P3 key; RLS boundary is identity", () => {
  assert.deepEqual(identity(PRE), identity(PINS.pre), "PRE identity == pinned reconstruction of 0001-0020");
  assert.equal(PRE.migrations.aggregate, PINS.pre.migrations.aggregate); assert.equal(PRE.migrations.count, 20); assert.equal(PRE.migrations.aggregate_1_20, PRE.migrations.aggregate);
  assert.deepEqual([PINS.files.up21, PINS.files.down21, PINS.files.name21], [m21.upChecksum, m21.downChecksum, m21.name]); assert.equal(PINS.schema, "e7-0021-pins-v1");
  const emb21 = /\$e7_0021_up\$([\s\S]*?)\$e7_0021_up\$/.exec(WRAPPER)[1];
  assert.equal(emb21, m21.up, "0021 up embedded verbatim"); assert.equal(WRAPPER.split("$e7_0021_up$").length, 3, "exactly one embedded script");
  assert.ok(!WRAPPER.includes(m19.up) && !WRAPPER.includes(m20.up) && !WRAPPER.includes(m19.down) && !WRAPPER.includes(m20.down) && !WRAPPER.includes(m21.down), "0019 / 0020 ups and every down are absent");
  assert.ok(!/\$e7_0019_up\$|\$e7_0020_up\$|VALUES \(19,|VALUES \(20,/.test(WRAPPER), "no 0019 / 0020 apply or tracking row");
  for (const [p, h] of Object.entries(SPENT)) assert.equal(sha(rd(p)), h, `spent artifact untouched: ${p}`);
  assert.equal(sha(INVENTORY), PINS.inventorySql);
  assert.ok(WRAPPER.includes(`hashtext('${LOCK_KEY}')`), "active-run exclusion uses the hosted runners' P3 lock key");
  assert.ok(PRE.rls_enabled_count >= 28 && PRE.policy_count >= 72, `the accepted RLS boundary is part of the identity (${PRE.rls_enabled_count} RLS tables, ${PRE.policy_count} policies)`);
  assert.ok(PINS.post.rls_enabled_count === PRE.rls_enabled_count + 1 && PINS.post.policy_count > PRE.policy_count, "0021 adds the RLS-enabled notification_suppressions table with its policy");
  assert.ok(!/RESET |SET statement_timeout|SET lock_timeout/.test(WRAPPER.replace(/SET LOCAL/g, "")), "only SET LOCAL (caller session settings preserved)");
  assert.ok(!/DOWN|migrateDown|DROP TRIGGER|DROP FUNCTION booking\.(offline_refund|recorded_|suppress_|complete_offline)/.test(WRAPPER.replace(/\$e7_0021_up\$[\s\S]*?\$e7_0021_up\$/g, "")), "the wrapper itself runs no down and drops nothing outside the embedded up");
  assert.deepEqual(Object.values(PINS.pre.objects), Object.values(PINS.pre.objects).map(() => false)); assert.deepEqual(Object.values(PINS.post.objects), Object.values(PINS.post.objects).map(() => true));
  assert.deepEqual(Object.values(PINS.pre.prerequisite_0020), Object.values(PINS.pre.prerequisite_0020).map(() => true), "0019 / 0020 objects are the PRE prerequisite");
  const out = execFileSync("python3", [join(ROOT, "claude/gen-0021-wrapper.py"), ROOT], { encoding: "utf8" });  // asserts byte-identical (no --write)
  assert.ok(out.includes(`sqleditor-apply-v1.sql sha256: ${sha(WRAPPER)}`) && out.includes(`readback-v1.sql sha256: ${sha(READBACK)}`) && out.includes(`embedded up21 sha256: ${m21.upChecksum}`), out);
});

test("C1 refusals leave the schema unchanged: wrong environment marker; history drift (a 0010 row; a 0020 row); wrong role (admin, app); 0018 prerequisite drift; 0021 vocabulary already present (the mirrored column pre-created by an owner); schema-identity drift (an extra booking function; a widened function ACL; a widened non-owner table grant); the owner-only aclitem change is NOT drift; each restored exactly after", async () => {
  await A.c.query("UPDATE booking.instance SET environment = 'live'");
  await expectRaise(A.c, /E7_21_NOT_TEST/); await A.c.query("UPDATE booking.instance SET environment = 'test'"); await unchanged(A.c, PRE);
  for (const v of [10, 20]) {
    const m = M.find((x) => x.version === v);
    await A.c.query("UPDATE booking_migrations.applied SET up_checksum = repeat('0',64) WHERE version = $1", [v]);
    await expectRaise(A.c, /E7_21_HISTORY_DRIFT/); await A.c.query("UPDATE booking_migrations.applied SET up_checksum = $1 WHERE version = $2", [m.upChecksum, v]); await unchanged(A.c, PRE);
  }
  for (const url of [A.db.adminUrl2(), A.db.appUrl()]) {   // not the schema owner: refused before any catalog read it may lack (admin / app have no booking_migrations USAGE either)
    const other = new pg.Client({ connectionString: url }); await other.connect();
    try { let msg = null; try { await other.query(WRAPPER); } catch (e) { msg = e.message; } assert.ok(msg && /E7_21_NOT_SCHEMA_OWNER|permission denied/.test(msg), msg); } finally { await other.end(); }
  }
  await unchanged(A.c, PRE);
  // 0018 prerequisite drift: the pre-0018 (0003) body back in place
  await A.c.query("CREATE OR REPLACE FUNCTION booking.is_privileged() RETURNS boolean LANGUAGE sql STABLE AS $$\n  SELECT current_user::text = (SELECT pg_get_userbyid(nspowner)::text FROM pg_namespace WHERE nspname = 'booking')\n$$;");
  await A.c.query("ALTER FUNCTION booking.is_privileged() RESET search_path");
  await expectRaise(A.c, /E7_21_0018_PREREQUISITE_MISSING/);
  await A.c.query(M.find((x) => x.version === 18).up); await unchanged(A.c, PRE);
  // 0021 vocabulary already present (an owner pre-created the mirrored column): refused BEFORE the identity probe, nothing applied
  await A.c.query("ALTER TABLE booking.intents ADD COLUMN settlement_recording_mirrored boolean");
  await expectRaise(A.c, /E7_21_VOCABULARY_ALREADY_IN_USE/);
  await A.c.query("ALTER TABLE booking.intents DROP COLUMN settlement_recording_mirrored"); await unchanged(A.c, PRE);
  // schema-identity drift: an extra function in schema booking
  await A.c.query("CREATE FUNCTION booking._e7_extra() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$");
  await expectRaise(A.c, /E7_21_SCHEMA_IDENTITY_DRIFT:.*functions/);
  await A.c.query("DROP FUNCTION booking._e7_extra()"); await unchanged(A.c, PRE);
  // a widened ACL on an accepted 0020 function (report EXECUTE) is identity drift too
  await A.c.query("GRANT EXECUTE ON FUNCTION booking.settle_test_refund_from_evidence(uuid,uuid) TO mv_booking_report");
  await expectRaise(A.c, /E7_21_SCHEMA_IDENTITY_DRIFT:.*(functions|acls)/);
  await A.c.query("REVOKE EXECUTE ON FUNCTION booking.settle_test_refund_from_evidence(uuid,uuid) FROM mv_booking_report"); await unchanged(A.c, PRE);
  // a widened NON-owner TABLE grant is identity drift (the canonical table ACL keeps every non-owner aclitem verbatim)
  await A.c.query("GRANT INSERT ON booking.intents TO mv_booking_report");
  await expectRaise(A.c, /E7_21_SCHEMA_IDENTITY_DRIFT:.*table_acls/);
  await A.c.query("REVOKE INSERT ON booking.intents FROM mv_booking_report"); await unchanged(A.c, PRE);
  // the owner's OWN aclitem is the only thing the canonical ACL ignores (PG17 owner-default MAINTAIN) — emulated on PG16 by revoking an owner privilege: NOT drift
  await A.c.query("REVOKE TRIGGER ON booking.api_rate_limits FROM postgres");
  assert.equal((await inventory(A.c)).table_acls, PRE.table_acls, "owner-item-only change: canonical table ACL unchanged (portable over the PG16 / PG17 owner default)");
  await A.c.query("GRANT TRIGGER ON booking.api_rate_limits TO postgres"); await unchanged(A.c, PRE);
});

test("C1b 0019 / 0020 prerequisite + RLS boundary: a cluster at 0018 (0019 / 0020 NOT applied) refuses E7_21_HISTORY_NOT_1_TO_20 with nothing applied — this wrapper NEVER applies 0019 / 0020; a dropped 0020 function at 0020 refuses the 0019/0020 prerequisite; DISABLE / FORCE RLS, an altered policy and a dropped policy EACH refuse E7_21_SCHEMA_IDENTITY_DRIFT before any migration / history write", async () => {
  { const db = await startPostgres(); const c = new pg.Client({ connectionString: db.adminUrl }); await c.connect();
    try { await migrateUp(c, { env: "test", to: 18 });
      let msg = null; try { await runWrapper(c); } catch (e) { msg = e.message; } assert.match(msg, /E7_21_HISTORY_NOT_1_TO_20/);
      const st = await migrationStatus(c, { env: "test" }); assert.deepEqual(st.applied, Array.from({ length: 18 }, (_, i) => i + 1)); assert.deepEqual(st.pending, Array.from({ length: loadMigrations().at(-1).version - 18 }, (_, i) => 19 + i));   // C41: 19 … TOP pending (derived)
      assert.equal((await c.query("SELECT to_regprocedure('booking.settle_test_refund_from_evidence(uuid,uuid)') IS NULL AS gone")).rows[0].gone, true, "0020 was NOT applied by this wrapper");
      assert.deepEqual(await gone21(c), { f: true, t: true, col: true, idx: true, rows: true });
    } finally { await c.end(); db.stop(); } }
  { const B = await clusterAt20(); try { const pre = await inventory(B.c);
      await B.c.query("DROP FUNCTION booking.settle_test_refund_from_evidence(uuid,uuid)");
      await expectRaise(B.c, /E7_21_0019_0020_PREREQUISITE_MISSING/);
      assert.deepEqual(await gone21(B.c), { f: true, t: true, col: true, idx: true, rows: true });
      assert.notEqual((await inventory(B.c)).functions, pre.functions, "the dropped prerequisite is visible to the identity (the cluster is discarded)");
    } finally { await B.end(); } }
  { const B = await clusterAt20(); try { const pre = await inventory(B.c);
      await B.c.query("ALTER TABLE booking.intents DISABLE ROW LEVEL SECURITY");
      assert.notEqual((await inventory(B.c)).rls, pre.rls, "the inventory sees the disabled RLS");
      await expectRaise(B.c, /E7_21_SCHEMA_IDENTITY_DRIFT:.*rls/);
      assert.deepEqual(await gone21(B.c), { f: true, t: true, col: true, idx: true, rows: true });
      await B.c.query("ALTER TABLE booking.intents ENABLE ROW LEVEL SECURITY"); await unchanged(B.c, pre);
      await B.c.query("ALTER TABLE booking.intents FORCE ROW LEVEL SECURITY");
      await expectRaise(B.c, /E7_21_SCHEMA_IDENTITY_DRIFT:.*rls/);
      await B.c.query("ALTER TABLE booking.intents NO FORCE ROW LEVEL SECURITY"); await unchanged(B.c, pre);
    } finally { await B.end(); } }
  { const B = await clusterAt20(); try { const pre = await inventory(B.c);
      const pol = (await B.c.query("SELECT policyname FROM pg_policies WHERE schemaname = 'booking' AND tablename = 'intents' ORDER BY policyname LIMIT 1")).rows[0];
      await B.c.query(`ALTER POLICY ${pol.policyname} ON booking.intents USING (false)`);
      assert.notEqual((await inventory(B.c)).policies, pre.policies, "the inventory sees the altered policy");
      await expectRaise(B.c, /E7_21_SCHEMA_IDENTITY_DRIFT:.*policies/);
      assert.equal((await inventory(B.c)).migrations.max, 20);
    } finally { await B.end(); } }
  { const B = await clusterAt20(); try {
      const pol = (await B.c.query("SELECT policyname FROM pg_policies WHERE schemaname = 'booking' AND tablename = 'external_operations' ORDER BY policyname LIMIT 1")).rows[0];
      await B.c.query(`DROP POLICY ${pol.policyname} ON booking.external_operations`);
      await expectRaise(B.c, /E7_21_SCHEMA_IDENTITY_DRIFT:.*(policies|policy_count)/);
      assert.deepEqual(await gone21(B.c), { f: true, t: true, col: true, idx: true, rows: true }, "no migration ran");
    } finally { await B.end(); } }
});

test("C2 active-run / lease exclusion: a hosted runner's P3 session lock held elsewhere; the ACCEPTED fixtures (dispatched: a reservation_pending intent holding its intent lease; claimOp: its create operation in_flight) and owner-set work / operation leases — the wrapper refuses while any lease / in-flight write exists; a clean cluster applies. The 0021 vocabulary ROW gates (mirror op type, mirror ledger entry) are NOT reachable at exactly 0020 (the 0020 CHECK constraints reject every 0021 value) and are reported through the readback indicator only", async () => {
  const holder = new pg.Client({ connectionString: A.db.adminUrl }); await holder.connect();
  try { await holder.query("SELECT pg_advisory_lock(pg_catalog.hashtext($1), 0)", [LOCK_KEY]);          // = the hosted runners' session lock
    await expectRaise(A.c, /E7_21_ACTIVE_RUN_LOCK_HELD/); await unchanged(A.c, PRE);
    await holder.query("SELECT pg_advisory_unlock(pg_catalog.hashtext($1), 0)", [LOCK_KEY]);
  } finally { await holder.end(); }
  const B = await clusterAt20();
  try {
    await seedFixture(B.db);
    const pre = await inventory(B.c);
    const intentId = (await B.c.query("SELECT id FROM booking.intents ORDER BY created_at LIMIT 1")).rows[0].id;
    await B.c.query("UPDATE booking.intent_work SET work_worker_id = 'w-hold', work_lease_until = now() + interval '1 minute' WHERE intent_id = $1", [intentId]);
    await expectRaise(B.c, /E7_21_ACTIVE_WORK_LEASE/); await unchanged(B.c, pre);
    await B.c.query("UPDATE booking.intent_work SET work_worker_id = NULL, work_lease_until = NULL WHERE intent_id = $1", [intentId]);
    const op = (await B.c.query("SELECT id FROM booking.external_operations WHERE state = 'pending' ORDER BY created_at LIMIT 1")).rows[0].id;
    await B.c.query("UPDATE booking.external_operations SET lease_worker_id = 'w-hold', lease_until = now() + interval '1 minute' WHERE id = $1", [op]);
    await expectRaise(B.c, /E7_21_OPERATION_LEASED_OR_IN_FLIGHT/); await unchanged(B.c, pre);
    await B.c.query("UPDATE booking.external_operations SET lease_worker_id = NULL, lease_until = NULL WHERE id = $1", [op]);
    const appPool = new pg.Pool({ connectionString: B.db.appUrl(), max: 2 }); let d;
    try { d = await F.dispatched(appPool, { listingId: 606998, from: "2028-06-01", to: "2028-06-04", currency: "USD" }); const claimed = await F.claimOp(appPool, d.id, "hostaway.create_reservation", F.at(6)); assert.ok(claimed, "the accepted claimOp claimed the create operation"); }
    finally { await appPool.end(); }
    const facts = (await B.c.query(`SELECT (SELECT lease_worker_id IS NOT NULL FROM booking.intents WHERE id = $1) AS intent_lease,
        (SELECT state FROM booking.external_operations WHERE id = $2) AS op_state, (SELECT work_worker_id IS NOT NULL FROM booking.intent_work WHERE intent_id = $1) AS work_lease`, [d.id, d.createOpId])).rows[0];
    assert.deepEqual([facts.intent_lease, facts.op_state], [true, "in_flight"], "the accepted fixtures hold the intent lease and an in-flight create");
    const rb = await readback(B.c);
    assert.ok(rb.exclusion.intent_leases >= 1 && rb.exclusion.operation_leases_or_in_flight >= 1, JSON.stringify(rb.exclusion)); assert.equal(rb.exclusion.vocabulary_rows, 0); assert.equal(rb.exclusion.vocabulary_objects, 0);
    await expectRaise(B.c, facts.work_lease ? /E7_21_ACTIVE_WORK_LEASE/ : /E7_21_ACTIVE_INTENT_LEASE/); await unchanged(B.c, pre);
    // the 0021 vocabulary values are rejected by the 0020 CHECK constraints at exactly 0020 (so the row gates cannot fire here; the object gates are covered in C1)
    let msg = null; try { await B.c.query("INSERT INTO booking.payment_ledger (intent_id, entry, amount_minor, currency, provider, provider_ref) SELECT id, 'offline_charge_refund_recorded', 1, 'USD', 'hostaway', 'x' FROM booking.intents LIMIT 1"); } catch (e) { msg = e.message; }
    assert.ok(msg && /violates|check|invalid input|constraint/i.test(msg), `0021 ledger vocabulary rejected at 0020: ${msg}`);
    assert.equal((await inventory(B.c)).migrations.max, 20);
  } finally { await B.end(); }
  { const Cc = await clusterAt20(); try { await seedFixture(Cc.db); const rb = await readback(Cc.c);
      assert.deepEqual(rb.exclusion, { hosted_run_lock_held: false, work_leases: 0, intent_leases: 0, operation_leases_or_in_flight: 0, vocabulary_rows: 0, vocabulary_objects: 0 });
      const r = await runWrapper(Cc.c); assert.deepEqual([r.migrations_max, r.v21, r.mirrored_column], [21, true, true], "clean apply when nothing is leased / in flight"); } finally { await Cc.end(); } }
});

test("C3 held migrator xact lock → lock_timeout (55P03), schema unchanged; interruption AFTER the up (forced tracking-row failure) rolls EVERYTHING back — no 0021 function, table, column, index or row survives; 0001-0020 rows untouched", async () => {
  const holder = new pg.Client({ connectionString: A.db.adminUrl }); await holder.connect();
  await holder.query("BEGIN"); await holder.query("SELECT pg_advisory_xact_lock(7302215001)");
  try { let code = null; try { await runWrapper(A.c); } catch (e) { code = e.code; } assert.equal(code, "55P03", "lock_not_available within lock_timeout"); await unchanged(A.c, PRE); }
  finally { await holder.query("ROLLBACK").catch(() => {}); await holder.end(); }
  await A.c.query("ALTER TABLE booking_migrations.applied ADD CONSTRAINT _e7_no21 CHECK (version <> 21)");   // the tracking INSERT fails AFTER up21
  await expectRaise(A.c, /_e7_no21|check constraint|violates/i);
  await A.c.query("ALTER TABLE booking_migrations.applied DROP CONSTRAINT _e7_no21");
  await unchanged(A.c, PRE);
  assert.deepEqual(await gone21(A.c), { f: true, t: true, col: true, idx: true, rows: true }, "nothing of 0021 survives the rollback");
  assert.equal((await inventory(A.c)).migrations.aggregate_1_20, PINS.pre.migrations.aggregate, "0001-0020 rows untouched");
});

test("C4 healthy apply (fresh cluster, nonempty booking fixture): status 21 / the ONE row exact; migrator sees 1..21 with nothing pending and a further up is a no-op; replay refused; booking rows byte-identical; readback PRE / POST agree with the pins; grants exactly as the merged 0021 (app / admin / owner-only), report gained nothing", async () => {
  const B = await clusterAt20();
  try {
    await seedFixture(B.db);
    const pre = await readback(B.c);
    assert.deepEqual(identity(pre.identity), identity(PINS.pre)); assert.equal(pre.identity.migrations.max, 20); assert.equal(pre.identity.migrations.aggregate, PINS.pre.migrations.aggregate);
    assert.equal(pre.instance.environment, "test"); assert.equal(pre.current_user, "postgres");
    const rows = Object.entries(pre.booking_tables_fingerprint).filter(([, v]) => !v.startsWith("0:"));
    assert.ok(rows.length >= 5, `nonempty booking fixture across tables: ${rows.map(([k]) => k).join(",")}`);
    const status = await runWrapper(B.c);
    assert.deepEqual([status.migrations_max, status.v21, status.mirrored_column, status.complete_offline_refund_with_evidence, status.recorded_state_cleanup_ok, status.functions_sha256], [21, true, true, true, true, PINS.post.functions]);
    const post = await readback(B.c);
    assert.deepEqual(identity(post.identity), identity(PINS.post), "POST identity == pinned reconstruction of 0001-0021");
    assert.deepEqual(post.booking_tables_fingerprint, pre.booking_tables_fingerprint, "every booking table row-fingerprint identical (zero booking-row writes)");
    assert.equal(post.identity.migrations.aggregate_1_20, pre.identity.migrations.aggregate, "0001-0020 history unchanged");
    assert.deepEqual([post.identity.migrations.v21.up_checksum, post.identity.migrations.v21.down_checksum, post.identity.migrations.v21.name, post.identity.migrations.v21.environment], [m21.upChecksum, m21.downChecksum, m21.name, "test"]);
    assert.deepEqual(post.identity.acls["booking.complete_offline_refund_with_evidence(p_op uuid, p_worker text, p_evidence uuid, p_result_ref text, p_expected_version integer)"], ["mv_booking_app=X/postgres", "postgres=X/postgres"], "app only, as the merged 0021 grants");
    assert.deepEqual(post.identity.acls["booking.suppress_guest_notification(p_intent uuid, p_by text)"], ["mv_booking_app=X/postgres", "postgres=X/postgres"], "app only");
    assert.deepEqual(post.identity.acls["booking.recorded_cleanup_legs_unsettled(p_intent uuid, p_require_ledger boolean)"], ["mv_booking_admin=X/postgres", "mv_booking_app=X/postgres", "postgres=X/postgres"]);
    assert.deepEqual(post.identity.acls["booking.recorded_state_cleanup_ok(p_intent uuid)"], ["mv_booking_admin=X/postgres", "mv_booking_app=X/postgres", "postgres=X/postgres"]);
    assert.deepEqual(post.identity.acls["booking.offline_refund_settled_for(p_intent uuid)"], ["mv_booking_admin=X/postgres", "mv_booking_app=X/postgres", "postgres=X/postgres"]);
    assert.deepEqual(post.identity.acls["booking.offline_refund_proof_refusal(p_intent uuid, p_payload jsonb, p_result_ref text, p_dispatched_at timestamp with time zone, p_evidence uuid, p_mode text, p_decision_at timestamp with time zone)"], ["postgres=X/postgres"], "owner only");
    for (const f of ["offline_refund_create_fence", "offline_refund_claim_fence", "offline_refund_success_fence", "offline_refund_ledger_fence", "offline_refund_ledger_required", "notify_suppression_audit_required", "notification_suppressions_bound"]) assert.deepEqual(post.identity.acls[`booking.${f}()`], ["postgres=X/postgres"], f);
    const st = await migrationStatus(B.c, { env: "test" });
    // historical TARGET 21 (C41, same convention as the 0019/0020 wrapper test): the wrapper applies 1..21 exactly; the tree now also carries
    // 0022, which the wrapper never embeds / applies — it shows as pending (derived) and the migrator no-op check is capped at to: 21
    assert.deepEqual(st.applied, Array.from({ length: 21 }, (_, i) => i + 1));
    assert.deepEqual(st.pending, Array.from({ length: loadMigrations().at(-1).version - 21 }, (_, i) => 22 + i));
    assert.deepEqual(await migrateUp(B.c, { env: "test", to: 21 }), [], "migrator no-op after the wrapper (historical target 21; 0022 not applied)");
    await expectRaise(B.c, /E7_21_ALREADY_APPLIED_OR_LATER/);
    assert.deepEqual(identity(await inventory(B.c)), identity(PINS.post), "replay changed nothing");
    assert.equal((await B.c.query("SELECT count(*)::int AS n FROM booking_migrations.applied WHERE version = 21")).rows[0].n, 1);
    const app = new pg.Client({ connectionString: B.db.appUrl() }); await app.connect();
    try { const g = (await app.query(`SELECT has_function_privilege('booking.complete_offline_refund_with_evidence(uuid,text,uuid,text,integer)', 'EXECUTE') AS a, has_function_privilege('booking.recorded_state_cleanup_ok(uuid)', 'EXECUTE') AS b,
        has_function_privilege('booking.offline_refund_proof_refusal(uuid,jsonb,text,timestamptz,uuid,text,timestamptz)', 'EXECUTE') AS c, has_table_privilege('booking.notification_suppressions', 'SELECT') AS d, has_table_privilege('booking.notification_suppressions', 'INSERT') AS e`)).rows[0];
      assert.deepEqual([g.a, g.b, g.c, g.d, g.e], [true, true, false, true, false]); } finally { await app.end(); }
    const rep = new pg.Client({ connectionString: B.db.reportUrl() }); await rep.connect();
    try { const g = (await rep.query("SELECT has_function_privilege('booking.complete_offline_refund_with_evidence(uuid,text,uuid,text,integer)', 'EXECUTE') AS a, has_function_privilege('booking.recorded_state_cleanup_ok(uuid)', 'EXECUTE') AS b, has_table_privilege('booking.notification_suppressions', 'SELECT') AS c")).rows[0];
      assert.deepEqual([g.a, g.b, g.c], [false, false, false], "report gained nothing"); } finally { await rep.end(); }
  } finally { await B.end(); }
});

test("C5 forward-only limits: after the wrapper, migrateDown 21 → 20 works on an UNUSED schema (disposable only) and re-applies through the migrator; the wrapper embeds / runs no down. The USED-schema refusal (0021 down once the foundation was used) is the merged down script's own guard (source asserted); no claim beyond that", async () => {
  const B = await clusterAt20();
  try {
    await runWrapper(B.c);
    assert.deepEqual(await migrateDown(B.c, { env: "test", to: 20 }), [21], "disposable only: 0021 down on an unused schema is possible");
    assert.deepEqual(identity(await inventory(B.c)), identity(PINS.pre), "the down restores the exact PRE identity (round trip, disposable only)");
    assert.deepEqual(await migrateUp(B.c, { env: "test", to: 21 }), [21], "and re-applies");
    assert.deepEqual(identity(await inventory(B.c)), identity(PINS.post));
    assert.match(m21.down, /cannot be rolled back/);
    assert.ok(!WRAPPER.includes(m21.down), "the wrapper embeds no down script");
  } finally { await B.end(); }
});

test("C6 the time bound is REAL at the transport: RED control — statement_timeout set INSIDE a DO does not cancel it; GREEN — the batch envelope (SET LOCAL before the DO, same simple-query string) cancels a slow DO with 57014; the ACTUAL wrapper under a 20 ms bound is cancelled: schema / history / rows unchanged, no lock or session residue; a caller's NON-DEFAULT timeouts survive both a failed and a healthy batch", async () => {
  const t0 = Date.now();
  await A.c.query("DO $$ BEGIN PERFORM pg_catalog.set_config($q$statement_timeout$q$, $q$20ms$q$, true); PERFORM pg_catalog.pg_sleep(0.1); END $$;");
  assert.ok(Date.now() - t0 >= 90, "the probe ran to completion: an in-DO statement_timeout is NOT a bound");
  let code = null; try { await A.c.query("SET LOCAL statement_timeout = '100ms';\nDO $$ BEGIN PERFORM pg_catalog.pg_sleep(1); END $$;\nSELECT 1;"); } catch (e) { code = e.code; }
  assert.equal(code, "57014", "query_canceled by the envelope's SET LOCAL statement_timeout");
  assert.equal((await A.c.query("SHOW statement_timeout")).rows[0].statement_timeout, "0", "no session residue after the failed batch");
  const SHORT = WRAPPER.replace("SET LOCAL statement_timeout = '180s';", "SET LOCAL statement_timeout = '20ms';");
  assert.notEqual(SHORT, WRAPPER); assert.equal(SHORT.split("20ms").length, 2);
  const preRows = (await A.c.query(READBACK)).rows[0].e7_21_readback;
  code = null; try { await A.c.query(SHORT); } catch (e) { code = e.code; }
  assert.equal(code, "57014", "the wrapper was cancelled by the envelope bound");
  await unchanged(A.c, PRE);
  const postRows = (await A.c.query(READBACK)).rows[0].e7_21_readback;
  assert.deepEqual(postRows.booking_tables_fingerprint, preRows.booking_tables_fingerprint); assert.equal(postRows.identity.migrations.max, 20);
  assert.deepEqual(await gone21(A.c), { f: true, t: true, col: true, idx: true, rows: true });
  assert.equal((await A.c.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'")).rows[0].n, 0, "no advisory lock left behind");
  assert.deepEqual([(await A.c.query("SHOW statement_timeout")).rows[0].statement_timeout, (await A.c.query("SHOW lock_timeout")).rows[0].lock_timeout], ["0", "0"], "no session residue");
  assert.equal((await A.c.query("SELECT 1 AS ok")).rows[0].ok, 1, "the session is usable (no aborted-transaction state)");
  await A.c.query("SET statement_timeout = '30s'"); await A.c.query("SET lock_timeout = '7s'");
  code = null; try { await A.c.query(SHORT); } catch (e) { code = e.code; } assert.equal(code, "57014");
  assert.deepEqual([(await A.c.query("SHOW statement_timeout")).rows[0].statement_timeout, (await A.c.query("SHOW lock_timeout")).rows[0].lock_timeout], ["30s", "7s"], "caller settings preserved after the failed batch");
  const B = await clusterAt20();
  try { await B.c.query("SET statement_timeout = '30s'"); await B.c.query("SET lock_timeout = '7s'");
    const st = await runWrapper(B.c); assert.equal(st.migrations_max, 21);
    assert.deepEqual([(await B.c.query("SHOW statement_timeout")).rows[0].statement_timeout, (await B.c.query("SHOW lock_timeout")).rows[0].lock_timeout], ["30s", "7s"], "caller settings preserved after the healthy batch");
  } finally { await B.end(); }
  await A.c.query("RESET statement_timeout"); await A.c.query("RESET lock_timeout");
});
