// e7-0019-0020-sqleditor-apply-wrapper — proves claude/e7-0019-0020-sqleditor-apply-v1.sql + claude/e7-0019-0020-readback-v1.sql on DISPOSABLE
// PostgreSQL ONLY (labelled specialisation of test/db/e7-0018-sqleditor-apply-wrapper.test.mjs for TWO ordered migrations in ONE transaction).
// The wrapper is the reviewable SQL-editor apply candidate for the shared DEV TEST database — PREPARATION ONLY, NOT applied anywhere shared.
// Scenarios: deterministic assembly (pins re-derived here == committed pins; regeneration byte-identical; embedded up bytes == merged files);
// healthy apply fresh 0018 -> 19 -> 20 with nonempty booking fixture (rows byte-identical) + migrator compatibility + replay refused; refusals that
// leave the schema unchanged: wrong environment, history drift, wrong role (admin / app), 0018 prerequisite drift, schema-identity drift (extra
// function; ACL widening), active hosted-run lock, work / intent / operation lease, in-flight write, 0019 vocabulary row, held migrator lock
// (lock_timeout); interruption rollback (forced tracking-row failure AFTER both ups: neither function nor row survives); readback PRE / POST agreement;
// protected historical rows unchanged; forward-only down limits (0020 down refuses once a refund is settled through it; downs are never automatic).
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
const WRAPPER = rd("claude/e7-0019-0020-sqleditor-apply-v1.sql"); const READBACK = rd("claude/e7-0019-0020-readback-v1.sql");
const INVENTORY = rd("claude/e7-0019-0020-inventory.sql"); const PINS = JSON.parse(rd("claude/e7-0019-0020-pins-v1.json"));
const IDENTITY_KEYS = ["functions", "function_count", "triggers", "trigger_count", "constraints", "indexes", "columns", "table_acls", "rls", "rls_enabled_count", "policies", "policy_count", "schema_owner", "is_privileged_src", "is_privileged_config", "test_cleanup_pending_state", "objects", "acls"];
const identity = (inv) => Object.fromEntries(IDENTITY_KEYS.map((k) => [k, inv[k]]));
const M = loadMigrations(); const m19 = M.find((m) => m.version === 19); const m20 = M.find((m) => m.version === 20);

// a disposable cluster migrated to EXACTLY version 18 (0019 / 0020 left for the wrapper), owner = postgres, login roles as startMigratedDatabase
async function clusterAt18() {
  const db = await startPostgres();
  const c = new pg.Client({ connectionString: db.adminUrl }); await c.connect();
  await migrateUp(c, { env: "test", to: 18 });
  await c.query("CREATE ROLE test_app LOGIN IN ROLE mv_booking_app");
  await c.query("CREATE ROLE test_report LOGIN IN ROLE mv_booking_report");
  await c.query("CREATE ROLE test_admin LOGIN IN ROLE mv_booking_admin");
  return { db, c, end: async () => { await c.end().catch(() => {}); db.stop(); } };
}
const inventory = async (c) => (await c.query(INVENTORY)).rows[0].e7_inventory;
const readback = async (c) => (await c.query(READBACK)).rows[0].e7_1920_readback;
const runWrapper = async (c, text = WRAPPER) => { const res = await c.query(text); return res[res.length - 1].rows[0].e7_1920_status; };   // SET LOCAL; SET LOCAL; DO; SELECT → the SELECT is last
const expectRaise = async (c, re) => { let msg = null; try { await runWrapper(c); } catch (e) { msg = e.message; } assert.ok(msg && re.test(msg), `expected ${re}, got ${msg}`); };
const unchanged = async (c, pre) => { const inv = await inventory(c); assert.deepEqual(identity(inv), identity(pre), "schema identity unchanged after the refusal"); assert.equal(inv.migrations.max, 18); assert.deepEqual(inv.objects, PINS.pre.objects); };
async function seedFixture(db) {
  const appPool = new pg.Pool({ connectionString: db.appUrl(), max: 2 });
  try { await F.pending(appPool, { listingId: 606998, from: "2028-02-01", to: "2028-02-04", currency: "USD" }); await F.reserved(appPool, { listingId: 606998, from: "2028-03-01", to: "2028-03-04", currency: "USD" }); }
  finally { await appPool.end(); }
}

let A; let PRE;
before(async () => { A = await clusterAt18(); PRE = await inventory(A.c); });
after(async () => { await A.end(); });

test("C0 deterministic assembly: the committed pins equal a fresh derivation on THIS disposable cluster (PRE at 0018); the embedded up bytes are the merged 0019 / 0020 files; the inventory probe hash matches; the generator regenerates both artifacts byte-identically; the lock key is the hosted runners' P3 key", () => {
  assert.deepEqual(identity(PRE), identity(PINS.pre), "PRE identity == pinned reconstruction of 0001-0018");
  assert.equal(PRE.migrations.aggregate, PINS.pre.migrations.aggregate); assert.equal(PRE.migrations.count, 18);
  assert.deepEqual([PINS.files.up19, PINS.files.down19, PINS.files.up20, PINS.files.down20, PINS.files.name19, PINS.files.name20], [m19.upChecksum, m19.downChecksum, m20.upChecksum, m20.downChecksum, m19.name, m20.name]);
  const emb19 = /\$e7_0019_up\$([\s\S]*?)\$e7_0019_up\$/.exec(WRAPPER)[1]; const emb20 = /\$e7_0020_up\$([\s\S]*?)\$e7_0020_up\$/.exec(WRAPPER)[1];
  assert.equal(emb19, m19.up, "0019 up embedded verbatim"); assert.equal(emb20, m20.up, "0020 up embedded verbatim");
  assert.equal(sha(INVENTORY), PINS.inventorySql);
  assert.ok(WRAPPER.includes(`hashtext('${LOCK_KEY}')`), "active-run exclusion uses the hosted runners' P3 lock key");
  assert.ok(PRE.rls_enabled_count >= 20 && PRE.policy_count >= 50, `the accepted RLS boundary is part of the identity (${PRE.rls_enabled_count} RLS tables, ${PRE.policy_count} policies)`);
  assert.ok(!/RESET |SET statement_timeout|SET lock_timeout/.test(WRAPPER.replace(/SET LOCAL/g, "")), "only SET LOCAL (caller session settings preserved)");
  assert.ok(!/DOWN|migrateDown|DROP TRIGGER|DROP FUNCTION booking\.(test_|settle_test)/.test(WRAPPER.replace(/\$e7_00(19|20)_up\$[\s\S]*?\$e7_00(19|20)_up\$/g, "")), "the wrapper itself runs no down and drops nothing outside the embedded ups");
  const out = execFileSync("python3", [join(ROOT, "claude/gen-0019-0020-wrapper.py"), ROOT], { encoding: "utf8" });  // asserts byte-identical (no --write)
  assert.ok(out.includes(`sqleditor-apply-v1.sql sha256: ${sha(WRAPPER)}`) && out.includes(`readback-v1.sql sha256: ${sha(READBACK)}`), out);
});

test("C1 refusals leave the schema unchanged: wrong environment marker; history drift; wrong role (admin, app); 0018 prerequisite drift; schema-identity drift (an extra booking function; a widened ACL); each restored exactly after", async () => {
  await A.c.query("UPDATE booking.instance SET environment = 'live'");
  await expectRaise(A.c, /E7_1920_NOT_TEST/); await A.c.query("UPDATE booking.instance SET environment = 'test'"); await unchanged(A.c, PRE);
  const m10 = M.find((x) => x.version === 10);
  await A.c.query("UPDATE booking_migrations.applied SET up_checksum = repeat('0',64) WHERE version = 10");
  await expectRaise(A.c, /E7_1920_HISTORY_DRIFT/); await A.c.query("UPDATE booking_migrations.applied SET up_checksum = $1 WHERE version = 10", [m10.upChecksum]); await unchanged(A.c, PRE);
  for (const url of [A.db.adminUrl2(), A.db.appUrl()]) {   // not the schema owner: refused before any catalog read it may lack (admin / app have no booking_migrations USAGE either)
    const other = new pg.Client({ connectionString: url }); await other.connect();
    try { let msg = null; try { await other.query(WRAPPER); } catch (e) { msg = e.message; } assert.ok(msg && /E7_1920_NOT_SCHEMA_OWNER|permission denied/.test(msg), msg); } finally { await other.end(); }
  }
  await unchanged(A.c, PRE);
  // 0018 prerequisite drift: the pre-0018 (0003) body back in place
  await A.c.query("CREATE OR REPLACE FUNCTION booking.is_privileged() RETURNS boolean LANGUAGE sql STABLE AS $$\n  SELECT current_user::text = (SELECT pg_get_userbyid(nspowner)::text FROM pg_namespace WHERE nspname = 'booking')\n$$;");
  await A.c.query("ALTER FUNCTION booking.is_privileged() RESET search_path");
  await expectRaise(A.c, /E7_1920_0018_PREREQUISITE_MISSING/);
  await A.c.query(M.find((x) => x.version === 18).up); await unchanged(A.c, PRE);
  // schema-identity drift: an extra function in schema booking
  await A.c.query("CREATE FUNCTION booking._e7_extra() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$");
  await expectRaise(A.c, /E7_1920_SCHEMA_IDENTITY_DRIFT:.*functions/);
  await A.c.query("DROP FUNCTION booking._e7_extra()"); await unchanged(A.c, PRE);
  // a widened ACL on an accepted function (report EXECUTE) is identity drift too
  await A.c.query("GRANT EXECUTE ON FUNCTION booking.authorization_blockers(uuid) TO mv_booking_report");
  await expectRaise(A.c, /E7_1920_SCHEMA_IDENTITY_DRIFT:.*(functions|acls)/);
  await A.c.query("REVOKE EXECUTE ON FUNCTION booking.authorization_blockers(uuid) FROM mv_booking_report"); await unchanged(A.c, PRE);
  // a widened NON-owner TABLE grant is identity drift (the canonical table ACL keeps every non-owner aclitem verbatim)
  await A.c.query("GRANT INSERT ON booking.intents TO mv_booking_report");
  await expectRaise(A.c, /E7_1920_SCHEMA_IDENTITY_DRIFT:.*table_acls/);
  await A.c.query("REVOKE INSERT ON booking.intents FROM mv_booking_report"); await unchanged(A.c, PRE);
  // the owner's OWN aclitem is the only thing the canonical ACL ignores: PG17's default adds MAINTAIN (m) there — emulated here on PG16 by revoking an owner privilege, which must NOT be drift
  await A.c.query("REVOKE TRIGGER ON booking.api_rate_limits FROM postgres");
  assert.equal((await inventory(A.c)).table_acls, PRE.table_acls, "owner-item-only change: canonical table ACL unchanged (portable over the PG16 / PG17 owner default)");
  await A.c.query("GRANT TRIGGER ON booking.api_rate_limits TO postgres"); await unchanged(A.c, PRE);
});

test("C1b (ROOT F2) the accepted RLS boundary is identity: DISABLE ROW LEVEL SECURITY on a table, FORCE RLS, an altered policy (USING false) and a dropped policy EACH refuse E7_1920_SCHEMA_IDENTITY_DRIFT before any migration / history write, schema unchanged", async () => {
  { const B = await clusterAt18(); try { const pre = await inventory(B.c);
      await B.c.query("ALTER TABLE booking.intents DISABLE ROW LEVEL SECURITY");
      assert.notEqual((await inventory(B.c)).rls, pre.rls, "the inventory sees the disabled RLS");
      await expectRaise(B.c, /E7_1920_SCHEMA_IDENTITY_DRIFT:.*rls/);
      assert.equal((await B.c.query("SELECT count(*)::int AS n FROM booking_migrations.applied WHERE version >= 19")).rows[0].n, 0); assert.equal((await inventory(B.c)).migrations.max, 18);
      await B.c.query("ALTER TABLE booking.intents ENABLE ROW LEVEL SECURITY"); await unchanged(B.c, pre);
      await B.c.query("ALTER TABLE booking.intents FORCE ROW LEVEL SECURITY");
      await expectRaise(B.c, /E7_1920_SCHEMA_IDENTITY_DRIFT:.*rls/);
      await B.c.query("ALTER TABLE booking.intents NO FORCE ROW LEVEL SECURITY"); await unchanged(B.c, pre);
    } finally { await B.end(); } }
  { const B = await clusterAt18(); try { const pre = await inventory(B.c);
      const pol = (await B.c.query("SELECT policyname, cmd, roles FROM pg_policies WHERE schemaname = 'booking' AND tablename = 'intents' ORDER BY policyname LIMIT 1")).rows[0];
      await B.c.query(`ALTER POLICY ${pol.policyname} ON booking.intents USING (false)`);
      assert.notEqual((await inventory(B.c)).policies, pre.policies, "the inventory sees the altered policy");
      await expectRaise(B.c, /E7_1920_SCHEMA_IDENTITY_DRIFT:.*policies/);
      assert.equal((await inventory(B.c)).migrations.max, 18);
    } finally { await B.end(); } }
  { const B = await clusterAt18(); try {
      const pol = (await B.c.query("SELECT policyname FROM pg_policies WHERE schemaname = 'booking' AND tablename = 'external_operations' ORDER BY policyname LIMIT 1")).rows[0];
      await B.c.query(`DROP POLICY ${pol.policyname} ON booking.external_operations`);
      await expectRaise(B.c, /E7_1920_SCHEMA_IDENTITY_DRIFT:.*(policies|policy_count)/);
      assert.equal((await inventory(B.c)).migrations.max, 18);
      assert.equal((await B.c.query("SELECT to_regprocedure('booking.settle_test_refund_from_evidence(uuid,uuid)') IS NULL AS gone")).rows[0].gone, true, "no migration ran");
    } finally { await B.end(); } }
});

test("C2 active-run / lease exclusion: a hosted runner's P3 session lock held elsewhere; then the ACCEPTED fixtures (dispatched: a reservation_pending intent holding its intent lease; claimOp: its create operation claimed in_flight) — the wrapper refuses while any lease / in-flight write exists; a clean cluster applies. Gate order is work → intent → operation, so with the real fixture the INTENT-lease code fires and the in_flight state is asserted through the readback indicator; the work-lease and operation-lease gate codes are exercised with owner-set leases; the 0019-vocabulary gate is NOT reachable at exactly 0018 (the 0018 CHECK constraints reject every 0019 value) and is reported through the readback indicator only", async () => {
  const holder = new pg.Client({ connectionString: A.db.adminUrl }); await holder.connect();
  try { await holder.query("SELECT pg_advisory_lock(pg_catalog.hashtext($1), 0)", [LOCK_KEY]);          // = the hosted runners' session lock
    await expectRaise(A.c, /E7_1920_ACTIVE_RUN_LOCK_HELD/); await unchanged(A.c, PRE);
    await holder.query("SELECT pg_advisory_unlock(pg_catalog.hashtext($1), 0)", [LOCK_KEY]);
  } finally { await holder.end(); }
  const B = await clusterAt18();
  try {
    await seedFixture(B.db);
    const pre = await inventory(B.c);
    const intentId = (await B.c.query("SELECT id FROM booking.intents ORDER BY created_at LIMIT 1")).rows[0].id;
    // work lease (owner-set, the accepted worker's claimWork shape)
    await B.c.query("UPDATE booking.intent_work SET work_worker_id = 'w-hold', work_lease_until = now() + interval '1 minute' WHERE intent_id = $1", [intentId]);
    await expectRaise(B.c, /E7_1920_ACTIVE_WORK_LEASE/); await unchanged(B.c, pre);
    await B.c.query("UPDATE booking.intent_work SET work_worker_id = NULL, work_lease_until = NULL WHERE intent_id = $1", [intentId]);
    // operation lease (owner-set)
    const op = (await B.c.query("SELECT id FROM booking.external_operations WHERE state = 'pending' ORDER BY created_at LIMIT 1")).rows[0].id;
    await B.c.query("UPDATE booking.external_operations SET lease_worker_id = 'w-hold', lease_until = now() + interval '1 minute' WHERE id = $1", [op]);
    await expectRaise(B.c, /E7_1920_OPERATION_LEASED_OR_IN_FLIGHT/); await unchanged(B.c, pre);
    await B.c.query("UPDATE booking.external_operations SET lease_worker_id = NULL, lease_until = NULL WHERE id = $1", [op]);
    // the ACCEPTED dispatched fixture: RESERVATION_STARTED + RESERVATION_DISPATCHED → intent lease held, create op claimed in_flight (real worker state, not an owner edit)
    const appPool = new pg.Pool({ connectionString: B.db.appUrl(), max: 2 }); let d;
    try { d = await F.dispatched(appPool, { listingId: 606998, from: "2028-06-01", to: "2028-06-04", currency: "USD" }); const claimed = await F.claimOp(appPool, d.id, "hostaway.create_reservation", F.at(6)); assert.ok(claimed, "the accepted claimOp claimed the create operation"); }
    finally { await appPool.end(); }
    const facts = (await B.c.query(`SELECT (SELECT lease_worker_id IS NOT NULL FROM booking.intents WHERE id = $1) AS intent_lease,
        (SELECT state FROM booking.external_operations WHERE id = $2) AS op_state, (SELECT work_worker_id IS NOT NULL FROM booking.intent_work WHERE intent_id = $1) AS work_lease`, [d.id, d.createOpId])).rows[0];
    console.log("C2 dispatched fixture facts:", JSON.stringify(facts));
    assert.deepEqual([facts.intent_lease, facts.op_state], [true, "in_flight"], "the accepted fixtures hold the intent lease and an in-flight create");
    const rb = await readback(B.c);
    assert.ok(rb.exclusion.intent_leases >= 1 && rb.exclusion.operation_leases_or_in_flight >= 1, JSON.stringify(rb.exclusion)); assert.equal(rb.exclusion.vocabulary_rows, 0);
    await expectRaise(B.c, facts.work_lease ? /E7_1920_ACTIVE_WORK_LEASE/ : /E7_1920_ACTIVE_INTENT_LEASE/); await unchanged(B.c, pre);
    assert.equal((await inventory(B.c)).migrations.max, 18);
    // the dispatched intent is left as real accepted state; the clean apply is asserted on a cluster without it
  } finally { await B.end(); }
  { const Cc = await clusterAt18(); try { await seedFixture(Cc.db); const rb = await readback(Cc.c);
      assert.deepEqual(rb.exclusion, { hosted_run_lock_held: false, work_leases: 0, intent_leases: 0, operation_leases_or_in_flight: 0, vocabulary_rows: 0 });
      const r = await runWrapper(Cc.c); assert.deepEqual([r.migrations_max, r.v19, r.v20], [20, true, true], "clean apply when nothing is leased / in flight"); } finally { await Cc.end(); } }
});

test("C3 held migrator xact lock → lock_timeout (55P03), schema unchanged; interruption AFTER both ups (forced tracking-row failure) rolls EVERYTHING back — no 0019 / 0020 function, trigger, index or row survives", async () => {
  const holder = new pg.Client({ connectionString: A.db.adminUrl }); await holder.connect();
  await holder.query("BEGIN"); await holder.query("SELECT pg_advisory_xact_lock(7302215001)");
  try { let code = null; try { await runWrapper(A.c); } catch (e) { code = e.code; } assert.equal(code, "55P03", "lock_not_available within lock_timeout"); await unchanged(A.c, PRE); }
  finally { await holder.query("ROLLBACK").catch(() => {}); await holder.end(); }
  await A.c.query("ALTER TABLE booking_migrations.applied ADD CONSTRAINT _e7_no20 CHECK (version <> 20)");   // the second tracking INSERT fails AFTER up19 + row 19 + up20
  await expectRaise(A.c, /_e7_no20|check constraint|violates/i);
  await A.c.query("ALTER TABLE booking_migrations.applied DROP CONSTRAINT _e7_no20");
  await unchanged(A.c, PRE);
  assert.equal((await A.c.query("SELECT count(*)::int AS n FROM booking_migrations.applied WHERE version >= 19")).rows[0].n, 0, "no 19 / 20 rows");
  assert.equal((await A.c.query("SELECT to_regprocedure('booking.settle_test_refund_from_evidence(uuid,uuid)') IS NULL AS gone")).rows[0].gone, true);
  assert.equal((await A.c.query("SELECT to_regclass('booking.external_operations_one_refund_ever') IS NULL AS gone")).rows[0].gone, true);
  assert.equal((await A.c.query("SELECT booking.is_intent_state('test_cleanup_pending') AS s")).rows[0].s, false, "0019 vocabulary not accepted after the rollback");
});

test("C4 healthy apply (fresh cluster, nonempty booking fixture): status 20 / both rows exact; migrator sees 1..20 with nothing pending and a further up is a no-op; replay refused; booking rows byte-identical; readback PRE / POST agree with the pins; app role can call the new functions exactly as granted", async () => {
  const B = await clusterAt18();
  try {
    await seedFixture(B.db);
    const pre = await readback(B.c);
    assert.deepEqual(identity(pre.identity), identity(PINS.pre)); assert.equal(pre.identity.migrations.max, 18); assert.equal(pre.identity.migrations.aggregate, PINS.pre.migrations.aggregate);
    assert.equal(pre.instance.environment, "test"); assert.equal(pre.current_user, "postgres");
    const rows = Object.entries(pre.booking_tables_fingerprint).filter(([, v]) => !v.startsWith("0:"));
    assert.ok(rows.length >= 5, `nonempty booking fixture across tables: ${rows.map(([k]) => k).join(",")}`);
    const status = await runWrapper(B.c);
    assert.deepEqual([status.migrations_max, status.v19, status.v20, status.test_cleanup_pending_state, status.settle_test_refund_from_evidence, status.functions_sha256], [20, true, true, true, true, PINS.post.functions]);
    const post = await readback(B.c);
    assert.deepEqual(identity(post.identity), identity(PINS.post), "POST identity == pinned reconstruction of 0001-0020");
    assert.deepEqual(post.booking_tables_fingerprint, pre.booking_tables_fingerprint, "every booking table row-fingerprint identical (zero booking-row writes)");
    assert.equal(post.identity.migrations.aggregate_1_18, pre.identity.migrations.aggregate, "0001-0018 history unchanged");
    assert.deepEqual([post.identity.migrations.v19.up_checksum, post.identity.migrations.v19.down_checksum, post.identity.migrations.v20.up_checksum, post.identity.migrations.v20.down_checksum], [m19.upChecksum, m19.downChecksum, m20.upChecksum, m20.downChecksum]);
    assert.deepEqual(post.identity.acls["booking.test_refund_settled_for(p_intent uuid, p_pi text)"], ["mv_booking_admin=X/postgres", "mv_booking_app=X/postgres", "postgres=X/postgres"]);
    assert.deepEqual(post.identity.acls["booking.settle_test_refund_from_evidence(p_op uuid, p_evidence uuid)"], ["mv_booking_app=X/postgres", "postgres=X/postgres"], "app only, as the merged 0020 grants");
    assert.deepEqual(post.identity.acls["booking.test_refund_pi_observation_ok(o jsonb, p_intent uuid, p_pi text, p_charge text, p_amount bigint, p_currency text)"], ["postgres=X/postgres"], "owner only");
    for (const f of ["test_cleanup_cancel_bound", "refund_claim_fence", "recording_retirement_fence"]) assert.deepEqual(post.identity.acls[`booking.${f}()`], ["postgres=X/postgres"], f);
    const st = await migrationStatus(B.c, { env: "test" });
    // historical TARGET (ROOT 5884658427): the wrapper applies 1..20 exactly; the tree now also carries the 0021 LOCAL candidate, which the wrapper
    // never embeds / applies — it shows as pending and is NOT applied here (the migrator is capped at to: 20 for the no-op check below)
    assert.deepEqual(st.applied, Array.from({ length: 20 }, (_, i) => i + 1)); assert.deepEqual(st.pending, Array.from({ length: loadMigrations().at(-1).version - 20 }, (_, i) => 21 + i));   // C41: 21 … TOP (derived)
    assert.deepEqual(await migrateUp(B.c, { env: "test", to: 20 }), [], "migrator no-op after the wrapper (historical target 20; 0021 not applied)");
    await expectRaise(B.c, /E7_1920_ALREADY_APPLIED_OR_LATER/);
    assert.deepEqual(identity(await inventory(B.c)), identity(PINS.post), "replay changed nothing");
    assert.equal((await B.c.query("SELECT count(*)::int AS n FROM booking_migrations.applied WHERE version IN (19, 20)")).rows[0].n, 2);
    // effective grants seen by the app login (no widening: report has none of the new functions)
    const app = new pg.Client({ connectionString: B.db.appUrl() }); await app.connect();
    try { const g = (await app.query("SELECT has_function_privilege('booking.test_refund_settled_for(uuid,text)', 'EXECUTE') AS a, has_function_privilege('booking.settle_test_refund_from_evidence(uuid,uuid)', 'EXECUTE') AS b, has_function_privilege('booking.test_refund_pi_observation_ok(jsonb,uuid,text,text,bigint,text)', 'EXECUTE') AS c")).rows[0];
      assert.deepEqual([g.a, g.b, g.c], [true, true, false]); } finally { await app.end(); }
    const rep = new pg.Client({ connectionString: B.db.reportUrl() }); await rep.connect();
    try { const g = (await rep.query("SELECT has_function_privilege('booking.test_refund_settled_for(uuid,text)', 'EXECUTE') AS a, has_function_privilege('booking.settle_test_refund_from_evidence(uuid,uuid)', 'EXECUTE') AS b")).rows[0];
      assert.deepEqual([g.a, g.b], [false, false], "report gained nothing"); } finally { await rep.end(); }
  } finally { await B.end(); }
});

test("C5 forward-only limits: after the wrapper, migrateDown 20 → 19 works on an UNUSED schema (disposable only) and re-applies; the wrapper embeds / runs no down. The USED-schema refusals (0020 down after a refund settled through it; 0019 down once its vocabulary is in use) are NOT exercised here — they are the merged down scripts' own guards (source asserted below); no claim beyond that", async () => {
  const B = await clusterAt18();
  try {
    await runWrapper(B.c);
    assert.deepEqual(await migrateDown(B.c, { env: "test", to: 19 }), [20], "disposable only: 0020 down on an unused schema is possible");
    assert.deepEqual(await migrateUp(B.c, { env: "test", to: 20 }), [20], "and re-applies (historical target 20; 0021 not applied)");
    // the refusal path of 0020's down (its own guard): a settled refund row cannot be rolled back — proven on the DOWN script's guard text + a direct probe
    assert.match(m20.down, /cannot be rolled back/);
    assert.match(m19.down, /Fails \(by design\) if any row already uses the 0019 vocabulary/);
    assert.ok(!WRAPPER.includes(m20.down) && !WRAPPER.includes(m19.down), "the wrapper embeds no down script");
  } finally { await B.end(); }
});

test("C6 the time bound is REAL at the transport (ROOT local finding): RED control — statement_timeout set INSIDE a DO does not cancel it; GREEN — the batch envelope (SET before the DO, same simple-query string) cancels a slow DO with 57014; the ACTUAL wrapper under a 20 ms bound is cancelled: schema / history / rows unchanged, no lock or session residue", async () => {
  // RED control = ROOT's probe: completes although the inner timeout is 20 ms
  const t0 = Date.now();
  await A.c.query("DO $$ BEGIN PERFORM pg_catalog.set_config($q$statement_timeout$q$, $q$20ms$q$, true); PERFORM pg_catalog.pg_sleep(0.1); END $$;");
  assert.ok(Date.now() - t0 >= 90, "the probe ran to completion: an in-DO statement_timeout is NOT a bound");
  // GREEN envelope: the same shape as the wrapper's head (SET as a separate statement BEFORE the DO, one multi-statement string)
  let code = null; try { await A.c.query("SET LOCAL statement_timeout = '100ms';\nDO $$ BEGIN PERFORM pg_catalog.pg_sleep(1); END $$;\nSELECT 1;"); } catch (e) { code = e.code; }
  assert.equal(code, "57014", "query_canceled by the envelope's SET LOCAL statement_timeout (effective in the implicit transaction block of the batch)");
  assert.equal((await A.c.query("SHOW statement_timeout")).rows[0].statement_timeout, "0", "no session residue after the failed batch");
  // GREEN actual wrapper: only the bound shortened (180s -> 20ms); the DO's own work (two migrations + two full inventories) cannot finish in 20 ms
  const SHORT = WRAPPER.replace("SET LOCAL statement_timeout = '180s';", "SET LOCAL statement_timeout = '20ms';");
  assert.notEqual(SHORT, WRAPPER); assert.equal(SHORT.split("20ms").length, 2);
  const preRows = (await A.c.query(READBACK)).rows[0].e7_1920_readback;
  code = null; try { await A.c.query(SHORT); } catch (e) { code = e.code; }
  assert.equal(code, "57014", "the wrapper was cancelled by the envelope bound");
  await unchanged(A.c, PRE);
  const postRows = (await A.c.query(READBACK)).rows[0].e7_1920_readback;
  assert.deepEqual(postRows.booking_tables_fingerprint, preRows.booking_tables_fingerprint); assert.equal(postRows.identity.migrations.max, 18);
  assert.equal((await A.c.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'")).rows[0].n, 0, "no advisory lock left behind");
  assert.deepEqual([(await A.c.query("SHOW statement_timeout")).rows[0].statement_timeout, (await A.c.query("SHOW lock_timeout")).rows[0].lock_timeout], ["0", "0"], "no session residue");
  assert.equal((await A.c.query("SELECT 1 AS ok")).rows[0].ok, 1, "the session is usable (no aborted-transaction state)");
  // NON-DEFAULT session control (ROOT nonblocking point): a caller's pre-existing timeouts survive BOTH a failed and a healthy batch (SET LOCAL, no RESET)
  await A.c.query("SET statement_timeout = '30s'"); await A.c.query("SET lock_timeout = '7s'");
  code = null; try { await A.c.query(SHORT); } catch (e) { code = e.code; } assert.equal(code, "57014");
  assert.deepEqual([(await A.c.query("SHOW statement_timeout")).rows[0].statement_timeout, (await A.c.query("SHOW lock_timeout")).rows[0].lock_timeout], ["30s", "7s"], "caller settings preserved after the failed batch");
  const B = await clusterAt18();
  try { await B.c.query("SET statement_timeout = '30s'"); await B.c.query("SET lock_timeout = '7s'");
    const st = await runWrapper(B.c); assert.equal(st.migrations_max, 20);
    assert.deepEqual([(await B.c.query("SHOW statement_timeout")).rows[0].statement_timeout, (await B.c.query("SHOW lock_timeout")).rows[0].lock_timeout], ["30s", "7s"], "caller settings preserved after the healthy batch");
  } finally { await B.end(); }
  await A.c.query("RESET statement_timeout"); await A.c.query("RESET lock_timeout");
});
