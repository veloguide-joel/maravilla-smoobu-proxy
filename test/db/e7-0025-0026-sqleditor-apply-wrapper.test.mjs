// e7-0025-0026-sqleditor-apply-wrapper — proves claude/e7-0025-0026-sqleditor-apply-v1.sql + claude/e7-0025-0026-readback-v1.sql (C116) on DISPOSABLE
// PostgreSQL ONLY. LABELLED SPECIALISATION of test/db/e7-0024-sqleditor-apply-wrapper.test.mjs for TWO consecutive in-place function replacements (0025
// gn_recipient_in_scope, 0026 claim_pipeline_kickoff) on a cluster at EXACTLY 0001-0024. The packet is reviewable tooling for the shared DEV TEST
// database; ROOT reviews and owns any actual shared apply — nothing here touches a shared database, a provider or the network. Scoped to packet correctness:
//   P0 deterministic assembly + continuity with the accepted 0024 POST pins + parity with main adacbdad's kickoff CATALOG_PINS / notification catalogPin26;
//   P1 one atomic apply over schema-24 data (incl. kickoff request rows) → exact MID / POST identity, kickoff catalog + notification catalog parity (runtime
//      app role), the claim literal rebound, the sink predicate, EVERY booking table / intents / history / protected / historical fingerprint unchanged,
//      migrator-built 26 == POST, second apply = provable no-op;
//   P2 refusals at 24 with NO write (environment, history drift, foreign env row, wrong role, identity drift incl. a pre-applied 0025 body, quiescence)
//      + wrong history (23);
//   P3 STOP states at 25 (a 0025-only database) and at 26 (POST drift, widened claim ACL, foreign checksum), never continued or repaired;
//   P4 atomic rollback (injected failure after both tracking rows, tampered MID / POST / kickoff pins, tampered embedded bytes) then a clean apply.
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
import { notificationCatalog } from "../../claude/derive-0025-0026-pins.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const rd = (p) => readFileSync(join(ROOT, p), "utf8");
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const WRAPPER = rd("claude/e7-0025-0026-sqleditor-apply-v1.sql"); const READBACK = rd("claude/e7-0025-0026-readback-v1.sql");
const INVENTORY = rd("claude/e7-0025-0026-inventory.sql"); const PINS = JSON.parse(rd("claude/e7-0025-0026-pins-v1.json"));
const PINS24 = JSON.parse(rd("claude/e7-0024-pins-v1.json"));
const IDENTITY_KEYS = ["functions", "function_count", "triggers", "trigger_count", "constraints", "indexes", "columns", "table_acls", "rls", "rls_enabled_count", "policies", "policy_count",
  "schema_owner", "is_privileged_src", "is_privileged_config", "relations", "relation_count", "test_cleanup_pending_state", "prerequisite_0023", "objects", "acls"];
const identity = (inv) => Object.fromEntries(IDENTITY_KEYS.map((k) => [k, inv[k]]));
const M = loadMigrations(); const m25 = M.find((m) => m.version === 25); const m26 = M.find((m) => m.version === 26);
/** literal copies (labelled) of main adacbdad: scripts/e7-hosted-kickoff.mjs CATALOG_PINS and scripts/e7-hosted-booking-confirmation.mjs catalogPin26 */
const RUNNER_CATALOG_PINS = {
  functions: [
    { sig: "booking.claim_pipeline_kickoff(uuid,text,text,jsonb)", src: "fb103173762c5dc6565338d2a15dd067", secdef: true, vol: "v", cfg: "search_path=pg_catalog, booking", acl: "mv_booking_app:EXECUTE" },
    { sig: "booking.refuse_pipeline_kickoff(uuid,text)", src: "fe1b6c137b618527bd5d03b7944e212a", secdef: true, vol: "v", cfg: "search_path=pg_catalog, booking", acl: "mv_booking_app:EXECUTE" },
    { sig: "booking.settle_pipeline_kickoff(uuid,text,text,text)", src: "35ec51fa266e024de510073414d6e307", secdef: true, vol: "v", cfg: "search_path=pg_catalog, booking", acl: "mv_booking_app:EXECUTE" },
    { sig: "booking.pipeline_kickoff_record()", src: "f2df109c551f28799a5d107547c90ebc", secdef: true, vol: "v", cfg: "search_path=pg_catalog, booking", acl: "" },
    { sig: "booking.pipeline_kickoff_refusal(booking.intents,booking.pipeline_kickoff_requests)", src: "1616ea311e3da7261bc308ac64293d6c", secdef: true, vol: "s", cfg: "search_path=pg_catalog, booking", acl: "" },
    { sig: "booking.pipeline_kickoff_excluded(uuid)", src: "279b1c33d03002d21757c5848056db1a", secdef: false, vol: "i", cfg: "search_path=pg_catalog", acl: "" },
    { sig: "booking.pipeline_kickoff_guard()", src: "01d5d885bcde5cb2f7d0f67aee53fdf9", secdef: false, vol: "v", cfg: "search_path=pg_catalog, booking", acl: "" }],
  table: { rls: true, sel: true, ins: false, upd: false, del: false, trg: 1 } };
const NOTIFICATION_CATALOG_PIN_26 = { catalog: "47b1d904a25cde0f4f9f85b8554b93cd914364d70ef1091cb273ce68043379da", readPath: "31f23b641bb57d5cbdec1aa4896447a574190dd057e4b92e6c5fdf8326220baf",
  readPathCount: 6, sections: { con: "550534b1daca47fc1df90a557d5dd28a7f6e1f1df11c581cdbd7a671eb95c188", col: "9d645f671980c7a2e0e679aa07d9a3c30a937e488236f132b589a0a162237fbe",
    fn: "501f34f7f4db9a5a5fb98c00046013a7904745faea78cd731bbafa23ddf8fb7c", pol: "7c69ad5c06cae91f06e96c8ac9d86d97dbc09e94d95a8afb399b141162ee83ee",
    rel: "359796c40820562166a4f10dce97ae433fe7ae53c5fd2b3385fc41f179437e89", trg: "13e79df7b90097f365a7f3f15337e58c7b7d5277378608fd482c77e2051982f5" } };
/** the accepted packet artifacts and merged migrations this task must not alter (vs e7-test 66133a22) */
const SPENT = Object.freeze(["claude/e7-0024-sqleditor-apply-v1.sql", "claude/e7-0024-readback-v1.sql", "claude/e7-0024-inventory.sql", "claude/e7-0024-pins-v1.json",
  "claude/gen-0024-wrapper.py", "claude/derive-0024-pins.mjs", "db/migrations/0025_gn_sink_recipient_scope.up.sql", "db/migrations/0025_gn_sink_recipient_scope.down.sql",
  "db/migrations/0026_pipeline_kickoff_source_rebind.up.sql", "db/migrations/0026_pipeline_kickoff_source_rebind.down.sql"]);

let netAttempts = 0; const realFetch = globalThis.fetch;
globalThis.fetch = async () => { netAttempts += 1; throw new Error("network refused (offline C116 suite)"); };

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
const readback = async (c) => (await c.query(READBACK)).rows[0].e7_2526_readback;
async function runWrapper(c, text = WRAPPER) {
  const notices = []; const on = (n) => notices.push(n.message); c.on("notice", on);
  try { const res = await c.query(text); return { status: res[res.length - 1].rows[0].e7_2526_status, notices }; } finally { c.off("notice", on); }
}
const expectRaise = async (c, re, text) => { let msg = null; try { await runWrapper(c, text); } catch (e) { msg = e.message; } assert.ok(msg && re.test(msg), `expected ${re}, got ${msg}`); };
async function unchanged(c, pre) {
  const rb = await readback(c);
  assert.deepEqual(identity(rb.identity), identity(pre.identity), "schema identity unchanged");
  assert.deepEqual(rb.identity.migrations, pre.identity.migrations, "history unchanged");
  assert.deepEqual(rb.data, pre.data, "rows unchanged");
  for (const k of ["kickoff_rows", "kickoff_catalog", "claim_literal", "sink_scope"]) assert.deepEqual(rb[k], pre[k], k);
}
/** realistic schema-24 data: authorized (606998 USD → a kickoff request row) / reserved / captured / confirmed (accepted fixtures; synthetic guests only) */
async function seed(pool) {
  await F.authorized(pool, { listingId: 606998, currency: "USD", from: "2027-05-01", to: "2027-05-04" });
  await F.reserved(pool, { listingId: 772501 });
  await F.captured(pool, { listingId: 772502, from: "2027-06-01", to: "2027-06-04" });
  await F.confirmed(pool, { listingId: 772503, from: "2027-07-01", to: "2027-07-04" });
}
const SINK_BEFORE = { sink: false, lookalike: false, invalid_scope: true }; const SINK_AFTER = { sink: true, lookalike: false, invalid_scope: true };

let db;
before(async () => { db = await startDbAt(24); await seed(db.app); });
after(async () => { globalThis.fetch = realFetch; await db.close(); assert.equal(netAttempts, 0); });

test("P0 deterministic assembly: pins == a fresh PRE derivation (schema 24) and == the accepted 0024 POST pins on every identity key + history aggregate; the embedded ups are the merged 0025 / 0026 files only (no other up, no down); no table / column delta; only function bodies change; kickoff / notification catalog pins == main adacbdad; operator manifest", async () => {
  const pre = await inventory(db.c);
  assert.deepEqual(identity(pre), identity(PINS.pre), "PRE identity == pinned reconstruction of 0001-0024");
  assert.equal(pre.migrations.aggregate, PINS.pre.migrations.aggregate); assert.equal(pre.migrations.count, 24);
  for (const k of IDENTITY_KEYS) if (k !== "acls") assert.deepEqual(PINS.pre[k], PINS24.post[k], `continuity with the accepted 0024 POST pin: ${k}`);
  assert.deepEqual(Object.keys(PINS.pre.acls).filter((k) => k !== "booking.gn_recipient_in_scope(p_email text)").sort(), Object.keys(PINS24.post.acls).sort(), "acls lists exactly one more function (gn_recipient_in_scope)");
  for (const k of Object.keys(PINS24.post.acls)) assert.deepEqual(PINS.pre.acls[k], PINS24.post.acls[k], `acl continuity ${k}`);
  assert.equal(PINS.pre.migrations.aggregate, PINS24.post.migrations.aggregate, "same 0001-0024 history aggregate as the accepted shared-DEV post-24 state");
  assert.equal(PINS.pre.migrations.aggregate, "bcd453f800c037e978138d5d6bf979baaa00b46cbe807fb7aca8281a9cacc7f2");
  assert.deepEqual([PINS.files.up25, PINS.files.down25, PINS.files.name25, PINS.files.up26, PINS.files.down26, PINS.files.name26],
    [m25.upChecksum, m25.downChecksum, m25.name, m26.upChecksum, m26.downChecksum, m26.name]);
  assert.equal(/\$e7_0025_up\$([\s\S]*?)\$e7_0025_up\$/.exec(WRAPPER)[1], m25.up); assert.equal(WRAPPER.split("$e7_0025_up$").length, 3);
  assert.equal(/\$e7_0026_up\$([\s\S]*?)\$e7_0026_up\$/.exec(WRAPPER)[1], m26.up); assert.equal(WRAPPER.split("$e7_0026_up$").length, 3);
  for (const m of M) { if (m.version < 25) assert.ok(!WRAPPER.includes(m.up), `up ${m.version} absent`); assert.ok(!WRAPPER.includes(m.down), `down ${m.version} absent`); }
  assert.equal((WRAPPER.match(/INSERT INTO booking_migrations\.applied/g) || []).length, 2); assert.ok(!/VALUES \((?!25,|26,)\d+,/.test(WRAPPER), "only the 25 / 26 tracking rows");
  const outside = WRAPPER.replace(/\$e7_0025_up\$[\s\S]*?\$e7_0025_up\$/g, "").replace(/\$e7_0026_up\$[\s\S]*?\$e7_0026_up\$/g, "");
  assert.ok(!/migrateDown|DROP (TABLE|FUNCTION|TRIGGER|POLICY)|DELETE FROM|UPDATE booking\.|INSERT INTO booking\.|CREATE (OR REPLACE )?FUNCTION|GRANT |REVOKE /.test(outside),
    "outside the embedded ups the wrapper drops / deletes / updates / inserts / creates / grants nothing (zero booking DML; no adoption / backfill)");
  assert.ok(WRAPPER.includes(`hashtext('${LOCK_KEY}')`)); assert.ok(!/RESET |SET statement_timeout|SET lock_timeout/.test(WRAPPER.replace(/SET LOCAL/g, "")), "only SET LOCAL");
  assert.equal(sha(INVENTORY), PINS.inventorySql);
  assert.deepEqual([PINS.addedColumns, PINS.newTables], [{}, []]);
  for (const k of IDENTITY_KEYS) if (!["functions", "acls"].includes(k)) assert.deepEqual([PINS.mid[k], PINS.post[k]], [PINS.pre[k], PINS.pre[k]], `only function bodies change: ${k}`);
  assert.deepEqual(PINS.kickoffCatalogPre, PINS24.kickoffCatalogPins, "PRE kickoff catalog == the accepted 0024 packet's pins");
  assert.deepEqual(PINS.kickoffCatalogPins, RUNNER_CATALOG_PINS, "POST kickoff pins == main adacbdad CATALOG_PINS (literal copy)");
  assert.deepEqual(PINS.notificationCatalogPin, NOTIFICATION_CATALOG_PIN_26, "POST notification catalog == main adacbdad catalogPin26 (literal copy)");
  const mainDir = process.env.E7_MAIN_DIR;
  if (mainDir && existsSync(join(mainDir, PINS.runners.kickoff.path))) {
    const K = await import(pathToFileURL(join(mainDir, PINS.runners.kickoff.path)).href); const N = await import(pathToFileURL(join(mainDir, PINS.runners.notification.path)).href);
    assert.deepEqual(JSON.parse(JSON.stringify(K.CATALOG_PINS)), RUNNER_CATALOG_PINS, "== the kickoff runner module export itself");
    assert.deepEqual(JSON.parse(JSON.stringify(N.CONSTANTS.catalogPin26)), NOTIFICATION_CATALOG_PIN_26, "== the notification runner module export itself");
    for (const r of [PINS.runners.kickoff, PINS.runners.notification]) assert.equal(createHash("sha256").update(readFileSync(join(mainDir, r.path))).digest("hex"), r.sha256, r.path);
  }
  const out = execFileSync("python3", [join(ROOT, "claude/gen-0025-0026-wrapper.py"), ROOT], { encoding: "utf8" });
  assert.ok(out.includes(`sqleditor-apply-v1.sql sha256: ${sha(WRAPPER)}`) && out.includes(`readback-v1.sql sha256: ${sha(READBACK)}`), out);
  for (const p of SPENT) assert.equal(execFileSync("git", ["-C", ROOT, "diff", "--quiet", "66133a22edca925e6386c4d178c251fa5f11c82e", "--", p], { encoding: "utf8" }), "", `untouched vs 66133a22: ${p}`);
  const doc = rd("claude/e7-0025-0026-apply-operator-sequence.md");
  const manifest = [...doc.matchAll(/^\| `([^`]+)` \| `([0-9a-f]{64})` \|$/gm)].map((x) => [x[1], x[2]]);
  assert.equal(manifest.length, 11, "operator manifest lists every packet + migration file");
  for (const [p, h] of manifest) if (p !== "test/db/e7-0025-0026-sqleditor-apply-wrapper.test.mjs") assert.equal(sha(rd(p)), h, `operator manifest: ${p}`);
  assert.ok(doc.includes(PINS.post.functions) && doc.includes(PINS.pre.migrations.aggregate) && doc.includes(PINS.post.migrations.aggregate), "operator doc carries the expected pins");
});

test("P1 one atomic apply over schema-24 data: notice E7_2526_APPLIED, status 26 + TWO exact tracking rows; POST identity; kickoff catalog == main CATALOG_PINS and notification catalog == catalogPin26 as the runtime app role; claim literal rebound; sink in scope; every booking table / intent / history / protected / historical fingerprint unchanged (kickoff + notification rows included); migrator-built 26 == POST; second apply is a provable no-op", async () => {
  const pre = await readback(db.c);
  assert.deepEqual(pre.exclusion, { hosted_run_lock_held: false, work_leases: 0, intent_leases: 0, operation_leases_or_in_flight: 0, prepared_transactions: 0, other_session_write_locks: 0 });
  assert.deepEqual([pre.claim_literal, pre.sink_scope, pre.kickoff_catalog], ["original", SINK_BEFORE, PINS.kickoffCatalogPre]);
  assert.ok(Number(pre.data.intent_ids.split(":")[0]) >= 4); assert.ok("pipeline_kickoff_requests" in pre.data.booking_tables && "intents" in pre.data.booking_tables);
  assert.match(pre.data.protected_reservations, /^0:/); assert.match(pre.data.historical_intents, /^0:/);
  const r = await runWrapper(db.c);
  assert.deepEqual(r.notices, ["E7_2526_APPLIED"]);
  assert.deepEqual({ ...r.status, functions_sha256: undefined }, { migrations_max: 26, v25: true, v26: true, claim_literal: "rebound", sink_scope: SINK_AFTER, kickoff_rows: pre.kickoff_rows, functions_sha256: undefined });
  assert.equal(r.status.functions_sha256, PINS.post.functions);
  const post = await readback(db.c);
  assert.deepEqual(identity(post.identity), identity(PINS.post), "POST identity == pins");
  assert.equal(post.identity.migrations.aggregate, PINS.post.migrations.aggregate); assert.equal(post.identity.migrations.aggregate_1_24, PINS.pre.migrations.aggregate);
  assert.deepEqual(post.identity.migrations.v25, { version: 25, name: m25.name, up_checksum: m25.upChecksum, down_checksum: m25.downChecksum, environment: "test" });
  assert.deepEqual(post.identity.migrations.v26, { version: 26, name: m26.name, up_checksum: m26.upChecksum, down_checksum: m26.downChecksum, environment: "test" });
  assert.deepEqual(post.data, pre.data, "every booking table (incl. kickoff requests / notifications), the intent set, 0001-0024 history rows, protected + historical fingerprints unchanged");
  assert.deepEqual([post.kickoff_rows, post.kickoff_catalog, post.claim_literal, post.sink_scope], [pre.kickoff_rows, RUNNER_CATALOG_PINS, "rebound", SINK_AFTER]);
  const appc = new pg.Client({ connectionString: db.appUrl() }); await appc.connect();
  try {
    assert.deepEqual(await kickoffCatalog(appc), RUNNER_CATALOG_PINS, "the kickoff runner's own probe, as the runtime app role, admits this database");
    const mainDir = process.env.E7_MAIN_DIR;
    if (mainDir && existsSync(join(mainDir, PINS.runners.notification.path))) {
      const N = await import(pathToFileURL(join(mainDir, PINS.runners.notification.path)).href);
      assert.deepEqual(await notificationCatalog(appc, N), NOTIFICATION_CATALOG_PIN_26, "the notification runner's own CATALOG_SQL, as the runtime app role, admits this database");
    }
  } finally { await appc.end(); }
  const st = await migrationStatus(db.c, { env: "test" }); assert.deepEqual([st.applied.length, st.pending], [26, [27, 28]]);   // C119 S4: + 0028 (mechanical)   // C118 draft: mechanical pin, only the later 0027 is pending
  const r2 = await runWrapper(db.c); assert.deepEqual(r2.notices, ["E7_2526_ALREADY_EXACT_NOOP"]); assert.deepEqual(await readback(db.c), post, "second apply wrote nothing");
  const B = await startDbAt(26);
  try { assert.deepEqual(identity(await inventory(B.c)), identity(PINS.post), "migrator-built 26 == the wrapper POST"); assert.deepEqual((await runWrapper(B.c)).notices, ["E7_2526_ALREADY_EXACT_NOOP"]); }
  finally { await B.close(); }
});

test("P2 refusals at 24 write NOTHING: wrong environment; history drift (0010, 0024 rows); foreign environment row; wrong role (admin, app); identity drift (a pre-applied 0025 body, an extra function, a revoked claim ACL, an extra table, RLS off); quiescence (run lock, write lock, held migrator lock 55P03); schema 23 → HISTORY_NOT_1_TO_24", async () => {
  const B = await startDbAt(24);
  try {
    await seed(B.app); const c = B.c; const pre = await readback(c);
    await c.query("UPDATE booking.instance SET environment = 'live'"); await expectRaise(c, /E7_2526_NOT_TEST/); await c.query("UPDATE booking.instance SET environment = 'test'"); await unchanged(c, pre);
    for (const v of [10, 24]) {
      const m = M.find((x) => x.version === v);
      await c.query("UPDATE booking_migrations.applied SET up_checksum = repeat('0',64) WHERE version = $1", [v]);
      await expectRaise(c, /E7_2526_HISTORY_DRIFT/); await c.query("UPDATE booking_migrations.applied SET up_checksum = $1 WHERE version = $2", [m.upChecksum, v]); await unchanged(c, pre);
    }
    await c.query("UPDATE booking_migrations.applied SET environment = 'live' WHERE version = 5"); await expectRaise(c, /E7_2526_ENV_MISMATCH/);
    await c.query("UPDATE booking_migrations.applied SET environment = 'test' WHERE version = 5"); await unchanged(c, pre);
    for (const url of [B.adminUrl2(), B.appUrl()]) {
      const other = new pg.Client({ connectionString: url }); await other.connect();
      try { let msg = null; try { await other.query(WRAPPER); } catch (e) { msg = e.message; } assert.ok(msg && /E7_2526_NOT_SCHEMA_OWNER|permission denied/.test(msg), msg); } finally { await other.end(); }
    }
    await unchanged(c, pre);
    const fn24 = (await c.query("SELECT pg_get_functiondef('booking.gn_recipient_in_scope(text)'::regprocedure) AS d")).rows[0].d;
    for (const [make, drop, re] of [
      [m25.up, fn24, /E7_2526_SCHEMA_IDENTITY_DRIFT:.*functions/],
      ["CREATE FUNCTION booking._e7_extra() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$", "DROP FUNCTION booking._e7_extra()", /E7_2526_SCHEMA_IDENTITY_DRIFT:.*functions/],
      ["REVOKE EXECUTE ON FUNCTION booking.claim_pipeline_kickoff(uuid,text,text,jsonb) FROM mv_booking_app",
        "GRANT EXECUTE ON FUNCTION booking.claim_pipeline_kickoff(uuid,text,text,jsonb) TO mv_booking_app", /E7_2526_SCHEMA_IDENTITY_DRIFT:.*(functions|acls)/],
      ["CREATE TABLE booking._e7_extra (x int)", "DROP TABLE booking._e7_extra", /E7_2526_SCHEMA_IDENTITY_DRIFT:.*relations/],
      ["ALTER TABLE booking.notification_provider_receipts DISABLE ROW LEVEL SECURITY", "ALTER TABLE booking.notification_provider_receipts ENABLE ROW LEVEL SECURITY", /E7_2526_SCHEMA_IDENTITY_DRIFT:.*rls/]]) {
      await c.query(make); await expectRaise(c, re); await c.query(drop); await unchanged(c, pre);
    }
    const holder = new pg.Client({ connectionString: B.adminUrl }); await holder.connect();
    try {
      await holder.query("SELECT pg_advisory_lock(pg_catalog.hashtext($1), 0)", [LOCK_KEY]); await expectRaise(c, /E7_2526_ACTIVE_RUN_LOCK_HELD/);
      await holder.query("SELECT pg_advisory_unlock(pg_catalog.hashtext($1), 0)", [LOCK_KEY]); await unchanged(c, pre);
      await holder.query("BEGIN"); await holder.query("LOCK TABLE booking.intents IN ROW EXCLUSIVE MODE");
      await expectRaise(c, /E7_2526_BOOKING_WRITE_LOCK_HELD/); await holder.query("ROLLBACK"); await unchanged(c, pre);
      await holder.query("BEGIN"); await holder.query("SELECT pg_advisory_xact_lock(7302215001)");
      let code = null; try { await runWrapper(c); } catch (e) { code = e.code; } assert.equal(code, "55P03", "held migrator lock → lock_timeout");
      await holder.query("ROLLBACK"); await unchanged(c, pre);
    } finally { await holder.end(); }
    const rb = await readback(c); assert.deepEqual([rb.identity.migrations.max, rb.claim_literal, rb.sink_scope], [24, "original", SINK_BEFORE]);
  } finally { await B.close(); }
  const C = await startDbAt(23);
  try { await expectRaise(C.c, /E7_2526_HISTORY_NOT_1_TO_24/); assert.equal((await C.c.query("SELECT max(version)::int AS m FROM booking_migrations.applied")).rows[0].m, 23); } finally { await C.close(); }
});

test("P3 STOP states, never continued or repaired: a 0025-only database (25) → STOP:history; at 26 an extra function → STOP:functions, a widened claim ACL (EXECUTE to report) → STOP incl. kickoff_catalog, a foreign 0026 checksum → STOP:history; each writes nothing", async () => {
  const H = await startDbAt(25);
  try { const r0 = await readback(H.c); await expectRaise(H.c, /E7_2526_POST_STATE_MISMATCH_STOP:history/); await unchanged(H.c, r0); } finally { await H.close(); }
  const C = await startDbAt(26);
  try {
    const c = C.c; const base = await readback(c);
    await c.query("CREATE FUNCTION booking._e7_extra() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$");
    const r1 = await readback(c); await expectRaise(c, /E7_2526_POST_STATE_MISMATCH_STOP:.*functions/); await unchanged(c, r1);
    await c.query("DROP FUNCTION booking._e7_extra()");
    await c.query("GRANT EXECUTE ON FUNCTION booking.claim_pipeline_kickoff(uuid,text,text,jsonb) TO mv_booking_report");
    const r2 = await readback(c); await expectRaise(c, /E7_2526_POST_STATE_MISMATCH_STOP:.*kickoff_catalog/); await unchanged(c, r2);
    await c.query("REVOKE EXECUTE ON FUNCTION booking.claim_pipeline_kickoff(uuid,text,text,jsonb) FROM mv_booking_report");
    await c.query("UPDATE booking_migrations.applied SET down_checksum = repeat('0',64) WHERE version = 26");
    const r3 = await readback(c); await expectRaise(c, /E7_2526_POST_STATE_MISMATCH_STOP:history/); await unchanged(c, r3);
    await c.query("UPDATE booking_migrations.applied SET down_checksum = $1 WHERE version = 26", [m26.downChecksum]);
    assert.deepEqual(await readback(c), base);
  } finally { await C.close(); }
});

test("P4 atomic rollback: an injected failure AFTER both ups + tracking rows, a tampered MID / POST / kickoff pin and tampered embedded 0025 / 0026 bytes each leave NOTHING (history 24, original bodies, rows unchanged); the untampered packet then applies cleanly", async () => {
  const B = await startDbAt(24);
  try {
    await seed(B.app); const c = B.c; const pre = await readback(c);
    const at24 = async () => { const rb = await readback(c); assert.deepEqual([rb.identity.migrations.max, rb.claim_literal, rb.sink_scope], [24, "original", SINK_BEFORE]); await unchanged(c, pre); };
    const inject = WRAPPER.replace("RAISE NOTICE 'E7_2526_APPLIED';", "RAISE EXCEPTION 'E7_2526_INJECTED_AFTER_TRACKING_ROWS';"); assert.notEqual(inject, WRAPPER);
    await expectRaise(c, /E7_2526_INJECTED_AFTER_TRACKING_ROWS/, inject); await at24();
    const tamper = (key) => { const line = WRAPPER.split("\n").find((l) => l.startsWith(`  ${key} `)); assert.ok(line, key);
      return WRAPPER.replace(line, line.replace(/"functions":"[0-9a-f]{64}"/, `"functions":"${"0".repeat(64)}"`).replace(/"src":"[0-9a-f]{32}"/, `"src":"${"0".repeat(32)}"`)); };
    await expectRaise(c, /E7_2526_MID_SCHEMA_IDENTITY_UNEXPECTED:functions/, tamper("c_mid")); await at24();
    await expectRaise(c, /E7_2526_POST_SCHEMA_IDENTITY_UNEXPECTED:functions/, tamper("c_post")); await at24();
    await expectRaise(c, /E7_2526_KICKOFF_CATALOG_UNEXPECTED/, tamper("c_kick")); await at24();
    for (const [tag, code] of [["$e7_0025_up$-- 0025", /E7_2526_UP25_BYTES_MISMATCH/], ["$e7_0026_up$-- 0026", /E7_2526_UP26_BYTES_MISMATCH/]]) {
      const BYTES = WRAPPER.replace(tag, tag.replace("-- ", "--  ")); assert.notEqual(BYTES, WRAPPER, tag);
      await expectRaise(c, code, BYTES); await at24();
    }
    assert.deepEqual((await runWrapper(c)).notices, ["E7_2526_APPLIED"]);
    const post = await readback(c); assert.deepEqual(post.data, pre.data); assert.deepEqual(identity(post.identity), identity(PINS.post)); assert.equal(post.claim_literal, "rebound");
  } finally { await B.close(); }
});
