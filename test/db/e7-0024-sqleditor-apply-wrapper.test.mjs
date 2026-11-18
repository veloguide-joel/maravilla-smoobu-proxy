// e7-0024-sqleditor-apply-wrapper — proves claude/e7-0024-sqleditor-apply-v1.sql + claude/e7-0024-readback-v1.sql (C112a) on DISPOSABLE PostgreSQL
// ONLY. LABELLED SPECIALISATION of test/db/e7-0022-0023-sqleditor-apply-wrapper.test.mjs for ONE migration (0024) on a cluster at EXACTLY 0001-0023.
// The packet is reviewable tooling for the shared DEV TEST database; ROOT reviews and owns any actual shared apply — nothing here touches a shared
// database, a provider or the network. Scoped to packet correctness:
//   P0 deterministic assembly + continuity with the accepted 0022 / 0023 POST pins + parity with the merged hosted kickoff runner's CATALOG_PINS;
//   P1 one atomic apply over schema-23 data → exact POST identity, kickoff catalog parity (runtime app role), rows / intents / history / protected /
//      historical fingerprints unchanged, ZERO kickoff rows (no adoption / backfill), migrator-built 24 == POST, second apply = provable no-op;
//   P2 refusals at 23 with NO write (wrong environment, history drift, foreign env row, wrong role, 0024 object pre-created, identity drift,
//      quiescence) + wrong history (22);
//   P3 STOP states at 24 (POST drift, kickoff ACL drift, foreign checksum), never repaired;
//   P4 atomic rollback (injected failure after the tracking row, tampered POST / kickoff pins, tampered embedded bytes) then a clean apply.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import { startPostgres } from "./harness.mjs";
import * as F from "./fixtures.mjs";
import { migrateUp, migrationStatus, loadMigrations } from "../../db/lib/migrate.js";
import { LOCK_KEY } from "../../scripts/e7-connected/run-lock-precheck.mjs";
import { kickoffCatalog } from "../../claude/derive-0024-pins.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const rd = (p) => readFileSync(join(ROOT, p), "utf8");
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const WRAPPER = rd("claude/e7-0024-sqleditor-apply-v1.sql"); const READBACK = rd("claude/e7-0024-readback-v1.sql");
const INVENTORY = rd("claude/e7-0024-inventory.sql"); const PINS = JSON.parse(rd("claude/e7-0024-pins-v1.json"));
const PINS23 = JSON.parse(rd("claude/e7-0022-0023-pins-v1.json"));
const IDENTITY_KEYS = ["functions", "function_count", "triggers", "trigger_count", "constraints", "indexes", "columns", "table_acls", "rls", "rls_enabled_count", "policies", "policy_count",
  "schema_owner", "is_privileged_src", "is_privileged_config", "relations", "relation_count", "test_cleanup_pending_state", "prerequisite_0023", "objects", "acls"];
const GENERIC = IDENTITY_KEYS.slice(0, 18);
const identity = (inv) => Object.fromEntries(IDENTITY_KEYS.map((k) => [k, inv[k]]));
const M = loadMigrations(); const m24 = M.find((m) => m.version === 24);
/** the merged hosted kickoff runner's catalog pins (main 8503716b scripts/e7-hosted-kickoff.mjs CATALOG_PINS) — literal copy, labelled */
const RUNNER_CATALOG_PINS = {
  functions: [
    { sig: "booking.claim_pipeline_kickoff(uuid,text,text,jsonb)", src: "ede022a83e0869ec2194470665cab759", secdef: true, vol: "v", cfg: "search_path=pg_catalog, booking", acl: "mv_booking_app:EXECUTE" },
    { sig: "booking.refuse_pipeline_kickoff(uuid,text)", src: "fe1b6c137b618527bd5d03b7944e212a", secdef: true, vol: "v", cfg: "search_path=pg_catalog, booking", acl: "mv_booking_app:EXECUTE" },
    { sig: "booking.settle_pipeline_kickoff(uuid,text,text,text)", src: "35ec51fa266e024de510073414d6e307", secdef: true, vol: "v", cfg: "search_path=pg_catalog, booking", acl: "mv_booking_app:EXECUTE" },
    { sig: "booking.pipeline_kickoff_record()", src: "f2df109c551f28799a5d107547c90ebc", secdef: true, vol: "v", cfg: "search_path=pg_catalog, booking", acl: "" },
    { sig: "booking.pipeline_kickoff_refusal(booking.intents,booking.pipeline_kickoff_requests)", src: "1616ea311e3da7261bc308ac64293d6c", secdef: true, vol: "s", cfg: "search_path=pg_catalog, booking", acl: "" },
    { sig: "booking.pipeline_kickoff_excluded(uuid)", src: "279b1c33d03002d21757c5848056db1a", secdef: false, vol: "i", cfg: "search_path=pg_catalog", acl: "" },
    { sig: "booking.pipeline_kickoff_guard()", src: "01d5d885bcde5cb2f7d0f67aee53fdf9", secdef: false, vol: "v", cfg: "search_path=pg_catalog, booking", acl: "" }],
  table: { rls: true, sel: true, ins: false, upd: false, del: false, trg: 1 } };
/** the accepted packet artifacts this task must not alter */
const SPENT = Object.freeze(["claude/e7-0022-0023-sqleditor-apply-v1.sql", "claude/e7-0022-0023-readback-v1.sql", "claude/e7-0022-0023-inventory.sql", "claude/e7-0022-0023-pins-v1.json",
  "claude/gen-0022-0023-wrapper.py", "claude/derive-0022-0023-pins.mjs", "db/migrations/0024_pipeline_kickoff_requests.up.sql", "db/migrations/0024_pipeline_kickoff_requests.down.sql"]);

let netAttempts = 0; const realFetch = globalThis.fetch;
globalThis.fetch = async () => { netAttempts += 1; throw new Error("network refused (offline C112a suite)"); };

/** a disposable cluster migrated to EXACTLY `to` with the harness login roles (copied test-locally from the accepted 0022 / 0023 suite) */
async function startDbAt(to) {
  const base = await startPostgres();
  const admin = new pg.Client({ connectionString: base.adminUrl }); await admin.connect();
  try {
    await migrateUp(admin, { env: "test", to });
    await admin.query("CREATE ROLE test_app LOGIN IN ROLE mv_booking_app");
    await admin.query("CREATE ROLE test_report LOGIN IN ROLE mv_booking_report");
    await admin.query("CREATE ROLE test_admin LOGIN IN ROLE mv_booking_admin");
  } finally { await admin.end(); }
  const app = new pg.Pool({ connectionString: base.appUrl(), max: 6 });
  const c = new pg.Client({ connectionString: base.adminUrl }); await c.connect();
  return { ...base, app, c, async close() { await c.end().catch(() => {}); await app.end().catch(() => {}); base.stop(); } };
}
const inventory = async (c) => (await c.query(INVENTORY)).rows[0].e7_inventory;
const readback = async (c) => (await c.query(READBACK)).rows[0].e7_24_readback;
async function runWrapper(c, text = WRAPPER) {
  const notices = []; const on = (n) => notices.push(n.message); c.on("notice", on);
  try { const res = await c.query(text); return { status: res[res.length - 1].rows[0].e7_24_status, notices }; } finally { c.off("notice", on); }
}
const expectRaise = async (c, re, text) => { let msg = null; try { await runWrapper(c, text); } catch (e) { msg = e.message; } assert.ok(msg && re.test(msg), `expected ${re}, got ${msg}`); };
async function unchanged(c, pre) {
  const rb = await readback(c);
  assert.deepEqual(identity(rb.identity), identity(pre.identity), "schema identity unchanged");
  assert.deepEqual(rb.identity.migrations, pre.identity.migrations, "history unchanged");
  assert.deepEqual(rb.data, pre.data, "rows unchanged"); assert.equal(rb.kickoff_rows, pre.kickoff_rows); assert.deepEqual(rb.kickoff_catalog, pre.kickoff_catalog);
}
/** realistic schema-23 data: authorized / reserved / captured / confirmed intents incl. listing 606998 USD (accepted fixtures; synthetic guests only) */
async function seed(pool) {
  await F.authorized(pool, { listingId: 606998, currency: "USD", from: "2027-05-01", to: "2027-05-04" });
  await F.reserved(pool, { listingId: 772501 });
  await F.captured(pool, { listingId: 772502, from: "2027-06-01", to: "2027-06-04" });
  await F.confirmed(pool, { listingId: 772503, from: "2027-07-01", to: "2027-07-04" });
}

let db;
before(async () => { db = await startDbAt(23); await seed(db.app); });
after(async () => { globalThis.fetch = realFetch; await db.close(); assert.equal(netAttempts, 0); });

test("P0 deterministic assembly: pins == a fresh PRE derivation (schema 23) and == the accepted 0022 / 0023 POST pins on every generic key + history aggregate; the embedded up is the merged 0024 file only (no other up, no down); one new table, no added column; kickoff pins == the merged runner CATALOG_PINS; regeneration byte-identical; accepted artifacts untouched", async () => {
  const pre = await inventory(db.c);
  assert.deepEqual(identity(pre), identity(PINS.pre), "PRE identity == pinned reconstruction of 0001-0023");
  assert.equal(pre.migrations.aggregate, PINS.pre.migrations.aggregate); assert.equal(pre.migrations.count, 23);
  for (const k of GENERIC) assert.deepEqual(PINS.pre[k], PINS23.post[k], `continuity with the accepted 0022 / 0023 POST pin: ${k}`);
  assert.equal(PINS.pre.migrations.aggregate, PINS23.post.migrations.aggregate, "same 0001-0023 history aggregate as the accepted shared-DEV post-23 state");
  assert.equal(PINS.pre.migrations.aggregate, "7df0b8fe542b7f85f43bdaf7138438c71627b7bc88a48104314eeb1482270ef0");
  assert.deepEqual([PINS.files.up24, PINS.files.down24, PINS.files.name24], [m24.upChecksum, m24.downChecksum, m24.name]);
  assert.equal(/\$e7_0024_up\$([\s\S]*?)\$e7_0024_up\$/.exec(WRAPPER)[1], m24.up); assert.equal(WRAPPER.split("$e7_0024_up$").length, 3);
  for (const m of M) { if (m.version !== 24) assert.ok(!WRAPPER.includes(m.up), `up ${m.version} absent`); assert.ok(!WRAPPER.includes(m.down), `down ${m.version} absent`); }
  assert.equal((WRAPPER.match(/INSERT INTO booking_migrations\.applied/g) || []).length, 1); assert.ok(!/VALUES \((?!24,)\d+,/.test(WRAPPER), "only the 24 tracking row");
  assert.ok(!/migrateDown|DROP (TABLE|FUNCTION|TRIGGER|POLICY)|DELETE FROM|UPDATE booking\.|INSERT INTO booking\./.test(WRAPPER.replace(/\$e7_0024_up\$[\s\S]*?\$e7_0024_up\$/g, "")),
    "outside the embedded up the wrapper drops / deletes / updates / inserts nothing (zero booking DML; no adoption / backfill)");
  assert.ok(WRAPPER.includes(`hashtext('${LOCK_KEY}')`)); assert.ok(!/RESET |SET statement_timeout|SET lock_timeout/.test(WRAPPER.replace(/SET LOCAL/g, "")), "only SET LOCAL");
  assert.equal(sha(INVENTORY), PINS.inventorySql);
  assert.deepEqual(PINS.addedColumns, {}); assert.deepEqual(PINS.newTables, ["pipeline_kickoff_requests"]);
  assert.equal(PINS.post.relation_count, PINS.pre.relation_count + 1); assert.equal(PINS.post.rls_enabled_count, PINS.pre.rls_enabled_count + 1);
  assert.equal(PINS.post.trigger_count, PINS.pre.trigger_count + 4); assert.equal(PINS.post.policy_count, PINS.pre.policy_count + 1);
  assert.ok(Object.values(PINS.pre.objects).every((v) => v === false) && Object.values(PINS.post.objects).every((v) => v === true));
  assert.deepEqual(PINS.kickoffCatalogPins, RUNNER_CATALOG_PINS, "kickoff pins == the merged runner's CATALOG_PINS (literal copy)");
  const mainDir = process.env.E7_MAIN_DIR;
  if (mainDir && existsSync(join(mainDir, "scripts/e7-hosted-kickoff.mjs"))) {
    const R = await import(pathToFileURL(join(mainDir, "scripts/e7-hosted-kickoff.mjs")).href);
    assert.deepEqual(JSON.parse(JSON.stringify(R.CATALOG_PINS)), PINS.kickoffCatalogPins, "kickoff pins == the runner module export itself");
    assert.equal(createHash("sha256").update(readFileSync(join(mainDir, "scripts/e7-hosted-kickoff.mjs"))).digest("hex"), PINS.kickoffRunner.sha256);
  }
  const out = execFileSync("python3", [join(ROOT, "claude/gen-0024-wrapper.py"), ROOT], { encoding: "utf8" });
  assert.ok(out.includes(`sqleditor-apply-v1.sql sha256: ${sha(WRAPPER)}`) && out.includes(`readback-v1.sql sha256: ${sha(READBACK)}`), out);
  for (const p of SPENT) assert.equal(execFileSync("git", ["-C", ROOT, "diff", "--quiet", "8af49e87149ed7ed83d212714b1f1d173e08c189", "--", p], { encoding: "utf8" }), "", `untouched vs 8af49e87: ${p}`);
  const doc = rd("claude/e7-0024-apply-operator-sequence.md");
  const manifest = [...doc.matchAll(/^\| `([^`]+)` \| `([0-9a-f]{64})` \|$/gm)].map((x) => [x[1], x[2]]);
  assert.equal(manifest.length, 9, "operator manifest lists every packet + migration file");
  for (const [p, h] of manifest) if (p !== "test/db/e7-0024-sqleditor-apply-wrapper.test.mjs") assert.equal(sha(rd(p)), h, `operator manifest: ${p}`);
  assert.ok(doc.includes(PINS.post.functions) && doc.includes(PINS.pre.migrations.aggregate) && doc.includes(PINS.post.migrations.aggregate), "operator doc carries the expected pins");
});

test("P1 one atomic apply over schema-23 data: notice E7_24_APPLIED, status 24 + ONE exact tracking row; POST identity; kickoff catalog == runner CATALOG_PINS (wrapper-derived AND the runner's own probe as the runtime app role); every pre-existing table / intent set / 0001-0023 history rows / protected + historical fingerprints identical; ZERO kickoff rows; migrator-built 24 == POST; second apply = provable no-op", async () => {
  const pre = await readback(db.c);
  assert.deepEqual(pre.exclusion, { hosted_run_lock_held: false, work_leases: 0, intent_leases: 0, operation_leases_or_in_flight: 0, prepared_transactions: 0, other_session_write_locks: 0 });
  assert.equal(pre.kickoff_rows, null); assert.equal(pre.kickoff_catalog, null); assert.ok(Number(pre.data.intent_ids.split(":")[0]) >= 4);
  assert.match(pre.data.protected_reservations, /^0:/); assert.match(pre.data.historical_intents, /^0:/);
  const r = await runWrapper(db.c);
  assert.deepEqual(r.notices, ["E7_24_APPLIED"]);
  assert.deepEqual({ ...r.status, functions_sha256: undefined }, { migrations_max: 24, v24: true, pipeline_kickoff_requests: true, claim_pipeline_kickoff: true, kickoff_rows: 0, functions_sha256: undefined });
  assert.equal(r.status.functions_sha256, PINS.post.functions);
  const post = await readback(db.c);
  assert.deepEqual(identity(post.identity), identity(PINS.post), "POST identity == pins");
  assert.equal(post.identity.migrations.aggregate, PINS.post.migrations.aggregate); assert.equal(post.identity.migrations.aggregate_1_23, PINS.pre.migrations.aggregate);
  assert.deepEqual(post.identity.migrations.v24, { version: 24, name: m24.name, up_checksum: m24.upChecksum, down_checksum: m24.downChecksum, environment: "test" });
  assert.deepEqual(post.data, pre.data, "every pre-existing booking table, the intent set, 0001-0023 history rows, protected + historical fingerprints unchanged");
  assert.equal(post.kickoff_rows, 0, "no adoption / backfill");
  assert.deepEqual(post.kickoff_catalog, RUNNER_CATALOG_PINS);
  const appc = new pg.Client({ connectionString: db.appUrl() }); await appc.connect();
  try { assert.deepEqual(await kickoffCatalog(appc), RUNNER_CATALOG_PINS, "the runner's own probe, as the runtime app role, admits this database"); } finally { await appc.end(); }
  const st = await migrationStatus(db.c, { env: "test" }); assert.deepEqual([st.applied.length, st.pending], [24, [25, 26, 27, 28]]);   // C119 S4: + 0028 (mechanical)   // C118 draft: + 0027 (external cancellation disposition)   // C116: + 0026 (kickoff source literal rebind)   // 0025 (C116 sink recipient scope) mechanical pin: only the later migration is pending
  const r2 = await runWrapper(db.c); assert.deepEqual(r2.notices, ["E7_24_ALREADY_EXACT_NOOP"]); assert.deepEqual(await readback(db.c), post, "second apply wrote nothing");
  const B = await startDbAt(24);
  try { assert.deepEqual(identity(await inventory(B.c)), identity(PINS.post), "migrator-built 24 == the wrapper POST"); assert.deepEqual((await runWrapper(B.c)).notices, ["E7_24_ALREADY_EXACT_NOOP"]); }
  finally { await B.close(); }
});

test("P2 refusals at 23 write NOTHING: wrong environment; history drift (0010, 0023 rows); foreign environment row; wrong role (admin, app); a 0024 object pre-created (table, function, intents trigger); identity drift (extra function, revoked ACL, extra table, RLS off); quiescence (hosted-run lock, another session's write lock, held migrator lock → 55P03); schema 22", async () => {
  const B = await startDbAt(23);
  try {
    await seed(B.app); const c = B.c; const pre = await readback(c);
    await c.query("UPDATE booking.instance SET environment = 'live'"); await expectRaise(c, /E7_24_NOT_TEST/); await c.query("UPDATE booking.instance SET environment = 'test'"); await unchanged(c, pre);
    for (const v of [10, 23]) {
      const m = M.find((x) => x.version === v);
      await c.query("UPDATE booking_migrations.applied SET up_checksum = repeat('0',64) WHERE version = $1", [v]);
      await expectRaise(c, /E7_24_HISTORY_DRIFT/); await c.query("UPDATE booking_migrations.applied SET up_checksum = $1 WHERE version = $2", [m.upChecksum, v]); await unchanged(c, pre);
    }
    await c.query("UPDATE booking_migrations.applied SET environment = 'live' WHERE version = 5"); await expectRaise(c, /E7_24_ENV_MISMATCH/);
    await c.query("UPDATE booking_migrations.applied SET environment = 'test' WHERE version = 5"); await unchanged(c, pre);
    for (const url of [B.adminUrl2(), B.appUrl()]) {
      const other = new pg.Client({ connectionString: url }); await other.connect();
      try { let msg = null; try { await other.query(WRAPPER); } catch (e) { msg = e.message; } assert.ok(msg && /E7_24_NOT_SCHEMA_OWNER|permission denied/.test(msg), msg); } finally { await other.end(); }
    }
    await unchanged(c, pre);
    for (const [make, drop, re] of [
      ["CREATE TABLE booking.pipeline_kickoff_requests (intent_id uuid)", "DROP TABLE booking.pipeline_kickoff_requests", /E7_24_VOCABULARY_ALREADY_PRESENT/],
      ["CREATE FUNCTION booking.pipeline_kickoff_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$", "DROP FUNCTION booking.pipeline_kickoff_guard()", /E7_24_VOCABULARY_ALREADY_PRESENT/],
      ["CREATE FUNCTION booking.e7_pipeline_kickoff_shadow() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$", "DROP FUNCTION booking.e7_pipeline_kickoff_shadow()", /E7_24_VOCABULARY_ALREADY_PRESENT/],
      ["CREATE FUNCTION booking._e7_trg() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$; CREATE TRIGGER intents_pipeline_kickoff AFTER UPDATE ON booking.intents FOR EACH ROW EXECUTE FUNCTION booking._e7_trg()",
        "DROP TRIGGER intents_pipeline_kickoff ON booking.intents; DROP FUNCTION booking._e7_trg()", /E7_24_VOCABULARY_ALREADY_PRESENT/],
      ["CREATE FUNCTION booking._e7_extra() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$", "DROP FUNCTION booking._e7_extra()", /E7_24_SCHEMA_IDENTITY_DRIFT:.*functions/],
      ["REVOKE EXECUTE ON FUNCTION booking.claim_guest_notification_v2(uuid,text,text,text,text,text) FROM mv_booking_app",
        "GRANT EXECUTE ON FUNCTION booking.claim_guest_notification_v2(uuid,text,text,text,text,text) TO mv_booking_app", /E7_24_SCHEMA_IDENTITY_DRIFT:.*(functions|acls)/],
      ["CREATE TABLE booking._e7_extra (x int)", "DROP TABLE booking._e7_extra", /E7_24_SCHEMA_IDENTITY_DRIFT:.*relations/],
      ["ALTER TABLE booking.notification_provider_receipts DISABLE ROW LEVEL SECURITY", "ALTER TABLE booking.notification_provider_receipts ENABLE ROW LEVEL SECURITY", /E7_24_SCHEMA_IDENTITY_DRIFT:.*rls/]]) {
      await c.query(make); await expectRaise(c, re); await c.query(drop); await unchanged(c, pre);
    }
    const holder = new pg.Client({ connectionString: B.adminUrl }); await holder.connect();
    try {
      await holder.query("SELECT pg_advisory_lock(pg_catalog.hashtext($1), 0)", [LOCK_KEY]); await expectRaise(c, /E7_24_ACTIVE_RUN_LOCK_HELD/);
      await holder.query("SELECT pg_advisory_unlock(pg_catalog.hashtext($1), 0)", [LOCK_KEY]); await unchanged(c, pre);
      await holder.query("BEGIN"); await holder.query("LOCK TABLE booking.intents IN ROW EXCLUSIVE MODE");
      await expectRaise(c, /E7_24_BOOKING_WRITE_LOCK_HELD/); await holder.query("ROLLBACK"); await unchanged(c, pre);
      await holder.query("BEGIN"); await holder.query("SELECT pg_advisory_xact_lock(7302215001)");
      let code = null; try { await runWrapper(c); } catch (e) { code = e.code; } assert.equal(code, "55P03", "held migrator lock → lock_timeout");
      await holder.query("ROLLBACK"); await unchanged(c, pre);
    } finally { await holder.end(); }
    const rb = await readback(c); assert.equal(rb.kickoff_rows, null); assert.equal(rb.identity.migrations.max, 23);
  } finally { await B.close(); }
  const C = await startDbAt(22);
  try { const pre = await readback(C.c).catch(() => null); await expectRaise(C.c, /E7_24_HISTORY_NOT_1_TO_23|E7_24_0023_PREREQUISITE_MISSING/);
    assert.equal((await C.c.query("SELECT max(version)::int AS m FROM booking_migrations.applied")).rows[0].m, 22); void pre; } finally { await C.close(); }
});

test("P3 STOP states at 24, never continued or repaired: extra function → POST_STATE_MISMATCH_STOP:functions; widened kickoff ACL (record fn EXECUTE to report) → STOP incl. kickoff_catalog; foreign 0024 checksum → STOP:history; each writes nothing", async () => {
  const C = await startDbAt(24);
  try {
    const c = C.c; const base = await readback(c);
    await c.query("CREATE FUNCTION booking._e7_extra() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$");
    const r1 = await readback(c); await expectRaise(c, /E7_24_POST_STATE_MISMATCH_STOP:.*functions/); await unchanged(c, r1);
    await c.query("DROP FUNCTION booking._e7_extra()");
    await c.query("GRANT EXECUTE ON FUNCTION booking.pipeline_kickoff_record() TO mv_booking_report");
    const r2 = await readback(c); await expectRaise(c, /E7_24_POST_STATE_MISMATCH_STOP:.*kickoff_catalog/); await unchanged(c, r2);
    await c.query("REVOKE EXECUTE ON FUNCTION booking.pipeline_kickoff_record() FROM mv_booking_report");
    await c.query("UPDATE booking_migrations.applied SET down_checksum = repeat('0',64) WHERE version = 24");
    const r3 = await readback(c); await expectRaise(c, /E7_24_POST_STATE_MISMATCH_STOP:history/); await unchanged(c, r3);
    await c.query("UPDATE booking_migrations.applied SET down_checksum = $1 WHERE version = 24", [m24.downChecksum]);
    assert.deepEqual(await readback(c), base);
  } finally { await C.close(); }
});

test("P4 atomic rollback: an injected failure AFTER the 0024 up + tracking row, a tampered POST pin, a tampered kickoff pin and tampered embedded bytes each leave NOTHING (no 0024 object, no tracking row, rows unchanged); the untampered packet then applies cleanly", async () => {
  const B = await startDbAt(23);
  try {
    await seed(B.app); const c = B.c; const pre = await readback(c);
    const objects = async () => (await inventory(c)).objects;
    const none = (o) => Object.values(o).every((v) => v === false);
    const inject = WRAPPER.replace("RAISE NOTICE 'E7_24_APPLIED';", "RAISE EXCEPTION 'E7_24_INJECTED_AFTER_TRACKING_ROW';"); assert.notEqual(inject, WRAPPER);
    await expectRaise(c, /E7_24_INJECTED_AFTER_TRACKING_ROW/, inject); assert.ok(none(await objects())); await unchanged(c, pre);
    const tamper = (key) => { const line = WRAPPER.split("\n").find((l) => l.startsWith(`  ${key} `)); assert.ok(line, key);
      return WRAPPER.replace(line, line.replace(/"functions":"[0-9a-f]{64}"/, `"functions":"${"0".repeat(64)}"`).replace(/"src":"[0-9a-f]{32}"/, `"src":"${"0".repeat(32)}"`)); };
    await expectRaise(c, /E7_24_POST_SCHEMA_IDENTITY_UNEXPECTED:functions/, tamper("c_post")); assert.ok(none(await objects())); await unchanged(c, pre);
    await expectRaise(c, /E7_24_KICKOFF_CATALOG_UNEXPECTED/, tamper("c_kick")); assert.ok(none(await objects())); await unchanged(c, pre);
    const BYTES = WRAPPER.replace("$e7_0024_up$-- 0024", "$e7_0024_up$--  0024"); assert.notEqual(BYTES, WRAPPER);
    await expectRaise(c, /E7_24_UP24_BYTES_MISMATCH/, BYTES); assert.ok(none(await objects())); await unchanged(c, pre);
    assert.deepEqual((await runWrapper(c)).notices, ["E7_24_APPLIED"]);
    const post = await readback(c); assert.deepEqual(post.data, pre.data); assert.equal(post.kickoff_rows, 0); assert.deepEqual(identity(post.identity), identity(PINS.post));
  } finally { await B.close(); }
});
