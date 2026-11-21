// e7-0027-sqleditor-apply-wrapper — proves claude/e7-0027-sqleditor-apply-v1.sql + claude/e7-0027-readback-v1.sql (C118) on DISPOSABLE PostgreSQL ONLY.
// LABELLED SPECIALISATION of test/db/e7-0025-0026-sqleditor-apply-wrapper.test.mjs for ONE migration (0027 external cancellation disposition: two new
// tables, functions, triggers, policies) on a cluster at EXACTLY 0001-0026. The packet is reviewable tooling for the shared DEV TEST database; ROOT
// reviews and owns any actual shared apply — nothing here touches a shared database, a provider or the network. Scoped to packet correctness:
//   P0 deterministic assembly + continuity with the accepted 0025 + 0026 POST pins + parity with main 92c1b674's kickoff CATALOG_PINS (PRE == POST) and
//      notification catalogPin26 (PRE match; POST honestly DIFFERENT) + no disposition / evidence / booking write outside the embedded up;
//   P1 one atomic apply over realistic schema-26 data (confirmed bookings with queued and SENT confirmations, kickoff rows) → exact POST identity, ACL /
//      RLS matrix, kickoff catalog unchanged as the runtime app role, notification catalog refusal mapped, EVERY pre-existing table / intents / history /
//      protected / historical / claim-release-blocker fingerprint unchanged, new tables empty, no EXTERNALLY_CANCELLED latch, null guest projection,
//      migrator-built 27 == POST, second apply = provable no-op;
//   P2 refusals at 26 with NO write (environment, history drift, foreign env row, wrong role, identity drift incl. a pre-created 0027 table / function,
//      quiescence incl. an unsettled kickoff request) + wrong history (25);
//   P3 STOP states at 27 (POST drift, widened projection ACL, foreign checksum), never continued or repaired;
//   P4 atomic rollback (injected failure after the tracking row, tampered POST / kickoff / ACL pins, tampered embedded bytes) then a clean apply;
//   P5 the packet itself records no cancellation: after apply the 0027 admin functions exist but nothing was recorded, and the one-record C116 step is
//      only described (placeholders) in the operator document.
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
const WRAPPER = rd("claude/e7-0027-sqleditor-apply-v1.sql"); const READBACK = rd("claude/e7-0027-readback-v1.sql");
const INVENTORY = rd("claude/e7-0027-inventory.sql"); const PINS = JSON.parse(rd("claude/e7-0027-pins-v1.json"));
const PINS2526 = JSON.parse(rd("claude/e7-0025-0026-pins-v1.json"));
const IDENTITY_KEYS = ["functions", "function_count", "triggers", "trigger_count", "constraints", "indexes", "columns", "table_acls", "rls", "rls_enabled_count", "policies", "policy_count",
  "schema_owner", "is_privileged_src", "is_privileged_config", "relations", "relation_count", "test_cleanup_pending_state", "prerequisite_0023", "objects", "acls"];
const identity = (inv) => Object.fromEntries(IDENTITY_KEYS.map((k) => [k, inv[k]]));
const M = loadMigrations(); const m27 = M.find((m) => m.version === 27);
/** literal copies (labelled) of main 92c1b674 (tree 601fb091, = adacbdad tree): scripts/e7-hosted-kickoff.mjs CATALOG_PINS and
 *  scripts/e7-hosted-booking-confirmation.mjs catalogPin26 — identical to the accepted 0025 + 0026 test's copies */
const RUNNER_CATALOG_PINS = PINS2526.kickoffCatalogPins;
const NOTIFICATION_CATALOG_PIN_26 = PINS2526.notificationCatalogPin;
/** accepted artifacts and merged migrations this task must not alter (vs e7-test 22ba3e46) */
const SPENT = Object.freeze(["claude/e7-0025-0026-sqleditor-apply-v1.sql", "claude/e7-0025-0026-readback-v1.sql", "claude/e7-0025-0026-inventory.sql",
  "claude/e7-0025-0026-pins-v1.json", "claude/gen-0025-0026-wrapper.py", "claude/derive-0025-0026-pins.mjs", "claude/derive-0024-pins.mjs",
  "db/migrations/0027_external_cancellation_disposition.up.sql", "db/migrations/0027_external_cancellation_disposition.down.sql", "lib", "scripts", "api", "public"]);
const BASE = "22ba3e463bc5a77ff2e491f2394a762a93a3da0d";
const ACL_EXPECTED = { record: { mv_booking_app: false, mv_booking_admin: true, mv_booking_report: false, public: false },
  attest: { mv_booking_app: false, mv_booking_admin: true, mv_booking_report: false, public: false },
  projection: { mv_booking_app: true, mv_booking_admin: false, mv_booking_report: false, public: false },
  external_cancellations: { mv_booking_app: [false, false, false, false], mv_booking_admin: [true, false, false, false], mv_booking_report: [true, false, false, false], rls: true },
  external_refund_attestations: { mv_booking_app: [false, false, false, false], mv_booking_admin: [true, false, false, false], mv_booking_report: [true, false, false, false], rls: true } };

let netAttempts = 0; const realFetch = globalThis.fetch;
globalThis.fetch = async () => { netAttempts += 1; throw new Error("network refused (offline C118 packet suite)"); };

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
const readback = async (c) => (await c.query(READBACK)).rows[0].e7_27_readback;
async function runWrapper(c, text = WRAPPER) {
  const notices = []; const on = (n) => notices.push(n.message); c.on("notice", on);
  try { const res = await c.query(text); return { status: res[res.length - 1].rows[0].e7_27_status, notices }; } finally { c.off("notice", on); }
}
const expectRaise = async (c, re, text) => { let msg = null; try { await runWrapper(c, text); } catch (e) { msg = e.message; } assert.ok(msg && re.test(msg), `expected ${re}, got ${msg}`); };
async function unchanged(c, pre) {
  const rb = await readback(c);
  assert.deepEqual(identity(rb.identity), identity(pre.identity), "schema identity unchanged");
  assert.deepEqual(rb.identity.migrations, pre.identity.migrations, "history unchanged");
  assert.deepEqual(rb.data, pre.data, "rows unchanged");
  for (const k of ["kickoff_rows", "kickoff_catalog", "x27"]) assert.deepEqual(rb[k], pre[k], k);
}
/** realistic schema-26 data (accepted fixtures; synthetic guests only): authorized (606998 USD → a kickoff request row, settled below), reserved,
 *  captured, confirmed with a QUEUED confirmation, and confirmed with a SENT confirmation (owner-managed test history: no provider here) */
async function seed(pool, owner) {
  const au = await F.authorized(pool, { listingId: 606998, currency: "USD", from: "2027-05-01", to: "2027-05-04" });
  await F.reserved(pool, { listingId: 772601 });
  await F.captured(pool, { listingId: 772602, from: "2027-06-01", to: "2027-06-04" });
  await F.confirmed(pool, { listingId: 772603, from: "2027-07-01", to: "2027-07-04" });
  const sent = await F.confirmed(pool, { listingId: 772604, from: "2027-08-01", to: "2027-08-04" });
  await F.ownerManagedHistory(owner, `UPDATE booking.external_operations SET state = 'succeeded', attempts = 1, dispatched_at = now(), completed_at = now(),
    result_ref = 'mock-sent-1' WHERE intent_id = $1 AND op_type = 'guest.notify'`, [sent.id]);      // TEST SETUP ONLY: a sent confirmation's terminal row
  // TEST SETUP ONLY: one SETTLED (refused) kickoff request row for the 606998 authorization (its fixture clock predates the 0024 cutoff, so the
  // accepted trigger did not create one); exists so the row fingerprints cover pipeline_kickoff_requests
  await F.ownerManagedHistory(owner, `INSERT INTO booking.pipeline_kickoff_requests (intent_id, ref, authorized_version, payment_intent_id, amount_minor, currency, listing_id,
    intent_created_at, requested_at, state, settled_at, outcome_code) SELECT i.id, i.ref, i.version, i.stripe_payment_intent_id, i.final_total_minor, 'USD', 606998,
    '2026-11-16T00:00:00Z', now(), 'refused', now(), 'TEST_SETUP_SETTLED' FROM booking.intents i WHERE i.id = $1`, [au.id]);
}

let db;
before(async () => { db = await startDbAt(26); const o = new pg.Pool({ connectionString: db.adminUrl, max: 1 }); try { await seed(db.app, o); } finally { await o.end(); } });
after(async () => { globalThis.fetch = realFetch; await db.close(); assert.equal(netAttempts, 0); });

test("P0 deterministic assembly: pins == a fresh PRE derivation (schema 26) and == the accepted 0025 + 0026 POST pins on every unchanged identity key + history aggregate; the embedded up is the merged 0027 file only (no other up, no down); delta = two new tables, no added column; kickoff catalog PRE == POST == main; notification PRE == catalogPin26, POST honestly differs; no disposition / evidence / booking write outside the embedded up; regeneration byte-identical; operator manifest exact; accepted artifacts untouched", async () => {
  const pre = await inventory(db.c);
  assert.deepEqual(identity(pre), identity(PINS.pre), "PRE identity == pinned reconstruction of 0001-0026");
  assert.equal(pre.migrations.aggregate, PINS.pre.migrations.aggregate); assert.equal(pre.migrations.count, 26);
  for (const k of IDENTITY_KEYS) if (!["acls", "objects"].includes(k)) assert.deepEqual(PINS.pre[k], PINS2526.post[k], `continuity with the accepted 0025 + 0026 POST pin: ${k}`);
  for (const k of Object.keys(PINS2526.post.acls)) assert.deepEqual(PINS.pre.acls[k], PINS2526.post.acls[k], `acl continuity ${k}`);
  for (const k of Object.keys(PINS2526.post.objects)) assert.equal(PINS.pre.objects[k], PINS2526.post.objects[k], `object continuity ${k}`);
  assert.equal(PINS.pre.migrations.aggregate, PINS2526.post.migrations.aggregate, "same 0001-0026 history aggregate as the accepted shared-DEV post-26 state");
  assert.equal(PINS.pre.migrations.aggregate, "3dae7c0df75f4f51c4acdec3d79af4bb35050ee1d49c23c47e36b05f3d469ab1");
  assert.deepEqual([PINS.files.up27, PINS.files.down27, PINS.files.name27], [m27.upChecksum, m27.downChecksum, m27.name]);
  assert.deepEqual([m27.upChecksum, m27.downChecksum], ["ae949bf42450cf1af2632212f2cc2c2704b66ca314f4fc4f2744e6130f9c8ecf", "8e3810678bc788df6915a4be9c728296a89f0b040ae0df245ceef7583fc6ba6c"]);
  assert.equal(/\$e7_0027_up\$([\s\S]*?)\$e7_0027_up\$/.exec(WRAPPER)[1], m27.up); assert.equal(WRAPPER.split("$e7_0027_up$").length, 3);
  for (const m of M) { if (m.version < 27) assert.ok(!WRAPPER.includes(m.up), `up ${m.version} absent`); assert.ok(!WRAPPER.includes(m.down), `down ${m.version} absent`); }
  assert.equal((WRAPPER.match(/INSERT INTO booking_migrations\.applied/g) || []).length, 1); assert.ok(!/VALUES \((?!27,)\d+,/.test(WRAPPER), "only the 27 tracking row");
  const outside = WRAPPER.replace(/\$e7_0027_up\$[\s\S]*?\$e7_0027_up\$/g, "");
  assert.ok(!/migrateDown|DROP (TABLE|FUNCTION|TRIGGER|POLICY)|DELETE FROM|UPDATE booking\.|INSERT INTO booking\.|CREATE (OR REPLACE )?FUNCTION|GRANT |REVOKE /.test(outside),
    "outside the embedded up the wrapper drops / deletes / updates / inserts / creates / grants nothing (zero booking DML; no adoption / backfill)");
  assert.ok(!/(PERFORM|SELECT|CALL)\s+booking\.(admin_record_external_cancellation|admin_attest_external_refund|admin_record_evidence)\b/.test(outside + READBACK),
    "no cancellation record, refund attestation or evidence write anywhere in the packet SQL");
  assert.ok(WRAPPER.includes(`hashtext('${LOCK_KEY}')`)); assert.ok(!/RESET |SET statement_timeout|SET lock_timeout/.test(WRAPPER.replace(/SET LOCAL/g, "")), "only SET LOCAL");
  assert.equal(sha(INVENTORY), PINS.inventorySql);
  assert.deepEqual([PINS.addedColumns, PINS.newTables], [{}, ["external_cancellations", "external_refund_attestations"]]);
  for (const k of ["schema_owner", "is_privileged_src", "is_privileged_config", "test_cleanup_pending_state", "prerequisite_0023"]) assert.deepEqual(PINS.post[k], PINS.pre[k], k);
  assert.deepEqual(PINS.kickoffCatalogPre, RUNNER_CATALOG_PINS, "PRE kickoff catalog == main CATALOG_PINS");
  assert.deepEqual(PINS.kickoffCatalogPins, RUNNER_CATALOG_PINS, "POST kickoff catalog == main CATALOG_PINS: 0027 does not change it");
  assert.deepEqual(PINS.notificationCatalogPre, NOTIFICATION_CATALOG_PIN_26, "PRE notification catalog == main catalogPin26");
  assert.notEqual(PINS.notificationCatalogPost.catalog, NOTIFICATION_CATALOG_PIN_26.catalog, "POST notification catalog DIFFERS: that runner refuses 27 until a reviewed repin");
  assert.deepEqual(PINS.notificationSectionsChanged, ["col", "con", "fn", "pol", "rel", "trg"]);
  assert.deepEqual([PINS.runners.mainCommit, PINS.runners.mainTree], ["92c1b6748a719654bf324063242afd3c07ccb9d3", "601fb09191989f8f6cb9f866eef4c9c70025bb75"]);
  const mainDir = process.env.E7_MAIN_DIR;
  if (mainDir && existsSync(join(mainDir, PINS.runners.kickoff.path))) {
    const K = await import(pathToFileURL(join(mainDir, PINS.runners.kickoff.path)).href); const N = await import(pathToFileURL(join(mainDir, PINS.runners.notification.path)).href);
    assert.deepEqual(JSON.parse(JSON.stringify(K.CATALOG_PINS)), RUNNER_CATALOG_PINS, "== the kickoff runner module export itself");
    assert.deepEqual(JSON.parse(JSON.stringify(N.CONSTANTS.catalogPin26)), NOTIFICATION_CATALOG_PIN_26, "== the notification runner module export itself");
    for (const r of [PINS.runners.kickoff, PINS.runners.notification]) assert.equal(createHash("sha256").update(readFileSync(join(mainDir, r.path))).digest("hex"), r.sha256, r.path);
  }
  const out = execFileSync("python3", [join(ROOT, "claude/gen-0027-wrapper.py"), ROOT], { encoding: "utf8" });
  assert.ok(out.includes(`sqleditor-apply-v1.sql sha256: ${sha(WRAPPER)}`) && out.includes(`readback-v1.sql sha256: ${sha(READBACK)}`), out);
  let haveGit = true; try { execFileSync("git", ["-C", ROOT, "cat-file", "-e", `${BASE}^{commit}`]); } catch { haveGit = false; }
  // C119 S4: lib/ is untouched vs the accepted base EXCEPT exactly the two kickoff-only files the S4 rebind changes (PINNED_REVISION 5294b6b4 and the
  // transport's named default pin) — neither is read by this packet, its pins or its readback; anything else changed in lib/ still fails here
  const S4_LIB = ["lib/booking-db/pipeline-dispatch-transport.js", "lib/checkout/pipeline-kickoff-plan.js"];
  if (haveGit) for (const p of SPENT) {
    const ex = p === "lib" ? S4_LIB.map((f) => `:(exclude)${f}`) : [];
    assert.equal(execFileSync("git", ["-C", ROOT, "diff", "--quiet", BASE, "--", p, ...ex], { encoding: "utf8" }), "", `untouched vs ${BASE.slice(0, 8)}: ${p}`);
  }
  if (haveGit) assert.deepEqual(execFileSync("git", ["-C", ROOT, "diff", "--name-only", BASE, "--", "lib"], { encoding: "utf8" }).trim().split("\n").filter(Boolean).sort(), S4_LIB, "C119 S4: exactly the two kickoff-only lib files differ");
  if (haveGit) for (const f of S4_LIB) assert.doesNotMatch(rd("claude/gen-0027-wrapper.py") + rd("claude/derive-0027-pins.mjs"), new RegExp(f.replace(/[./]/g, "\\$&")), `${f} is not an input of this packet`);
  const doc = rd("claude/e7-0027-apply-operator-sequence.md");
  const manifest = [...doc.matchAll(/^\| `([^`]+)` \| `([0-9a-f]{64})` \|$/gm)].map((x) => [x[1], x[2]]);
  assert.equal(manifest.length, 9, "operator manifest lists every packet + migration file");
  for (const [p, h] of manifest) if (p !== "test/db/e7-0027-sqleditor-apply-wrapper.test.mjs") assert.equal(sha(rd(p)), h, `operator manifest: ${p}`);
  assert.ok(doc.includes(PINS.post.functions) && doc.includes(PINS.pre.migrations.aggregate) && doc.includes(PINS.post.migrations.aggregate), "operator doc carries the expected pins");
  assert.doesNotMatch(doc, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\b7\d{7}\b|cs_test_|pi_[A-Za-z0-9]|@(?!example)[a-z]+\.[a-z]/, "no private identifier in the operator document");
});

test("P1 one atomic apply over schema-26 data: E7_27_APPLIED, status 27 + ONE exact tracking row; POST identity; ACL / RLS matrix; kickoff catalog unchanged as the runtime app role; notification catalog refusal mapped; every pre-existing table / intent / history / protected / historical / claim-release-blocker fingerprint unchanged; new tables empty; no latch; null projection; migrator-built 27 == POST; second apply = provable no-op", async () => {
  const pre = await readback(db.c);
  assert.deepEqual(pre.exclusion, { hosted_run_lock_held: false, work_leases: 0, intent_leases: 0, operation_leases_or_in_flight: 0, kickoff_unsettled: 0, prepared_transactions: 0, other_session_write_locks: 0 });
  assert.equal(pre.x27.external_cancellations, null); assert.equal(pre.x27.projection_not_null, null); assert.equal(pre.x27.externally_cancelled_latches, 0);
  assert.deepEqual(pre.kickoff_catalog, RUNNER_CATALOG_PINS);
  assert.ok(Number(pre.data.intent_ids.split(":")[0]) >= 5); assert.match(pre.data.claim_release_blockers, /^\d+:[0-9a-f]{32}$/);
  assert.ok(!("external_cancellations" in pre.data.booking_tables));
  const r = await runWrapper(db.c);
  assert.deepEqual(r.notices, ["E7_27_APPLIED"]);
  assert.deepEqual({ ...r.status, functions_sha256: undefined }, { migrations_max: 27, v27: true, external_cancellations: 0, external_refund_attestations: 0, externally_cancelled_latches: 0, functions_sha256: undefined });
  assert.equal(r.status.functions_sha256, PINS.post.functions);
  const post = await readback(db.c);
  assert.deepEqual(identity(post.identity), identity(PINS.post), "POST identity == pins");
  assert.equal(post.identity.migrations.aggregate, PINS.post.migrations.aggregate); assert.equal(post.identity.migrations.aggregate_1_26, PINS.pre.migrations.aggregate);
  assert.deepEqual(post.identity.migrations.v27, { version: 27, name: m27.name, up_checksum: m27.upChecksum, down_checksum: m27.downChecksum, environment: "test" });
  assert.deepEqual(post.data, pre.data, "every pre-existing booking table, the intent set, 0001-0026 history rows, protected + historical fingerprints and claim-release blockers unchanged");
  assert.deepEqual(post.x27, { external_cancellations: 0, external_refund_attestations: 0, externally_cancelled_latches: 0, projection_not_null: 0, acl: ACL_EXPECTED });
  assert.deepEqual([post.kickoff_rows, post.kickoff_catalog], [pre.kickoff_rows, RUNNER_CATALOG_PINS]);
  const appc = new pg.Client({ connectionString: db.appUrl() }); await appc.connect();
  try {
    assert.deepEqual(await kickoffCatalog(appc), RUNNER_CATALOG_PINS, "the kickoff runner's own probe, as the runtime app role, still admits this database at 27");
    const mainDir = process.env.E7_MAIN_DIR;
    if (mainDir && existsSync(join(mainDir, PINS.runners.notification.path))) {
      const N = await import(pathToFileURL(join(mainDir, PINS.runners.notification.path)).href);
      const nc = await notificationCatalog(appc, N);
      assert.deepEqual(nc, PINS.notificationCatalogPost, "the notification runner's own CATALOG_SQL at 27 == the recorded POST identity");
      assert.notEqual(nc.catalog, N.CONSTANTS.catalogPin26.catalog, "→ that runner's catalogPin26 check REFUSES schema 27 (fail-closed; no repin here)");
    }
  } finally { await appc.end(); }
  const st = await migrationStatus(db.c, { env: "test" }); assert.deepEqual([st.applied.length, st.pending], [27, [28, 29, 30, 31]]);   // P1: + 0029 (mechanical)   // C119 S4: mechanical pin, only the later 0028 is pending
  const r2 = await runWrapper(db.c); assert.deepEqual(r2.notices, ["E7_27_ALREADY_EXACT_NOOP"]); assert.deepEqual(await readback(db.c), post, "second apply wrote nothing");
  const B = await startDbAt(27);
  try { assert.deepEqual(identity(await inventory(B.c)), identity(PINS.post), "migrator-built 27 == the wrapper POST"); assert.deepEqual((await runWrapper(B.c)).notices, ["E7_27_ALREADY_EXACT_NOOP"]); }
  finally { await B.close(); }
});

test("P2 refusals at 26 write NOTHING: wrong environment; history drift (0010, 0026 rows); foreign environment row; wrong role (admin, app); identity drift (a pre-created 0027 table, a pre-created 0027 function, an extra function, a widened claim-release ACL, RLS off); quiescence (run lock, write lock, held migrator lock 55P03, an unsettled kickoff request, a leased operation); schema 25 → HISTORY_NOT_1_TO_26", async () => {
  const B = await startDbAt(26);
  try {
    const owner = new pg.Pool({ connectionString: B.adminUrl, max: 1 });
    await seed(B.app, owner); const c = B.c; const pre = await readback(c);
    const pre0settled = (await c.query("SELECT settled_at::text AS t FROM booking.pipeline_kickoff_requests LIMIT 1")).rows[0].t;
    await c.query("UPDATE booking.instance SET environment = 'live'"); await expectRaise(c, /E7_27_NOT_TEST/); await c.query("UPDATE booking.instance SET environment = 'test'"); await unchanged(c, pre);
    for (const v of [10, 26]) {
      const m = M.find((x) => x.version === v);
      await c.query("UPDATE booking_migrations.applied SET up_checksum = repeat('0',64) WHERE version = $1", [v]);
      await expectRaise(c, /E7_27_HISTORY_DRIFT/); await c.query("UPDATE booking_migrations.applied SET up_checksum = $1 WHERE version = $2", [m.upChecksum, v]); await unchanged(c, pre);
    }
    await c.query("UPDATE booking_migrations.applied SET environment = 'live' WHERE version = 5"); await expectRaise(c, /E7_27_ENV_MISMATCH/);
    await c.query("UPDATE booking_migrations.applied SET environment = 'test' WHERE version = 5"); await unchanged(c, pre);
    for (const url of [B.adminUrl2(), B.appUrl()]) {
      const other = new pg.Client({ connectionString: url }); await other.connect();
      try { let msg = null; try { await other.query(WRAPPER); } catch (e) { msg = e.message; } assert.ok(msg && /E7_27_NOT_SCHEMA_OWNER|permission denied/.test(msg), msg); } finally { await other.end(); }
    }
    await unchanged(c, pre);
    for (const [make, drop, re] of [
      ["CREATE TABLE booking.external_cancellations (x int)", "DROP TABLE booking.external_cancellations", /E7_27_SCHEMA_IDENTITY_DRIFT:.*relations/],
      ["CREATE FUNCTION booking.external_cancellation_public(p uuid) RETURNS jsonb LANGUAGE sql AS $$ SELECT NULL::jsonb $$", "DROP FUNCTION booking.external_cancellation_public(uuid)", /E7_27_SCHEMA_IDENTITY_DRIFT:.*functions/],
      ["CREATE FUNCTION booking._e7_extra() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$", "DROP FUNCTION booking._e7_extra()", /E7_27_SCHEMA_IDENTITY_DRIFT:.*functions/],
      ["GRANT EXECUTE ON FUNCTION booking.claim_release_blockers(uuid) TO mv_booking_report",
        "REVOKE EXECUTE ON FUNCTION booking.claim_release_blockers(uuid) FROM mv_booking_report", /E7_27_SCHEMA_IDENTITY_DRIFT:.*(functions|acls)/],
      ["ALTER TABLE booking.notification_provider_receipts DISABLE ROW LEVEL SECURITY", "ALTER TABLE booking.notification_provider_receipts ENABLE ROW LEVEL SECURITY", /E7_27_SCHEMA_IDENTITY_DRIFT:.*rls/]]) {
      await c.query(make); await expectRaise(c, re); await c.query(drop); await unchanged(c, pre);
    }
    const holder = new pg.Client({ connectionString: B.adminUrl }); await holder.connect();
    try {
      await holder.query("SELECT pg_advisory_lock(pg_catalog.hashtext($1), 0)", [LOCK_KEY]); await expectRaise(c, /E7_27_ACTIVE_RUN_LOCK_HELD/);
      await holder.query("SELECT pg_advisory_unlock(pg_catalog.hashtext($1), 0)", [LOCK_KEY]); await unchanged(c, pre);
      await holder.query("BEGIN"); await holder.query("LOCK TABLE booking.intents IN ROW EXCLUSIVE MODE");
      await expectRaise(c, /E7_27_BOOKING_WRITE_LOCK_HELD/); await holder.query("ROLLBACK"); await unchanged(c, pre);
      await holder.query("BEGIN"); await holder.query("SELECT pg_advisory_xact_lock(7302215001)");
      let code = null; try { await runWrapper(c); } catch (e) { code = e.code; } assert.equal(code, "55P03", "held migrator lock → lock_timeout");
      await holder.query("ROLLBACK"); await unchanged(c, pre);
    } finally { await holder.end(); }
    // an unsettled kickoff request and a leased operation (TEST SETUP ONLY, owner-managed, reverted)
    const kr = (await c.query("SELECT intent_id AS id FROM booking.pipeline_kickoff_requests LIMIT 1")).rows[0];
    assert.ok(kr, "the seeded settled kickoff request row");
    await F.ownerManagedHistory(owner, "UPDATE booking.pipeline_kickoff_requests SET state = 'requested', settled_at = NULL, outcome_code = NULL WHERE intent_id = $1", [kr.id]);
    await expectRaise(c, /E7_27_KICKOFF_REQUEST_UNSETTLED/);
    await F.ownerManagedHistory(owner, "UPDATE booking.pipeline_kickoff_requests SET state = 'refused', settled_at = $2::timestamptz, outcome_code = 'TEST_SETUP_SETTLED' WHERE intent_id = $1",
      [kr.id, pre0settled]);
    await unchanged(c, pre);
    const op = (await c.query("SELECT id FROM booking.external_operations WHERE state = 'pending' LIMIT 1")).rows[0];
    await F.ownerManagedHistory(owner, "UPDATE booking.external_operations SET lease_worker_id = 'w-x', lease_until = now() + interval '1 minute' WHERE id = $1", [op.id]);
    await expectRaise(c, /E7_27_OPERATION_LEASED_OR_IN_FLIGHT/);
    await F.ownerManagedHistory(owner, "UPDATE booking.external_operations SET lease_worker_id = NULL, lease_until = NULL WHERE id = $1", [op.id]); await unchanged(c, pre);
    const rb = await readback(c); assert.deepEqual([rb.identity.migrations.max, rb.x27.external_cancellations], [26, null]);
    await owner.end();
  } finally { await B.close(); }
  const C = await startDbAt(25);
  try { await expectRaise(C.c, /E7_27_HISTORY_NOT_1_TO_26/); assert.equal((await C.c.query("SELECT max(version)::int AS m FROM booking_migrations.applied")).rows[0].m, 25); } finally { await C.close(); }
});

test("P3 STOP states at 27, never continued or repaired: an extra function → STOP:functions; a widened projection ACL (EXECUTE to report) → STOP; a foreign 0027 checksum → STOP:history; each writes nothing", async () => {
  const C = await startDbAt(27);
  try {
    const c = C.c; const base = await readback(c);
    await c.query("CREATE FUNCTION booking._e7_extra() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$");
    const r1 = await readback(c); await expectRaise(c, /E7_27_POST_STATE_MISMATCH_STOP:.*functions/); await unchanged(c, r1);
    await c.query("DROP FUNCTION booking._e7_extra()");
    await c.query("GRANT EXECUTE ON FUNCTION booking.external_cancellation_public(uuid) TO mv_booking_report");
    const r2 = await readback(c); await expectRaise(c, /E7_27_POST_STATE_MISMATCH_STOP:.*(functions|acls)/); await unchanged(c, r2);
    await c.query("REVOKE EXECUTE ON FUNCTION booking.external_cancellation_public(uuid) FROM mv_booking_report");
    await c.query("UPDATE booking_migrations.applied SET down_checksum = repeat('0',64) WHERE version = 27");
    const r3 = await readback(c); await expectRaise(c, /E7_27_POST_STATE_MISMATCH_STOP:history/); await unchanged(c, r3);
    await c.query("UPDATE booking_migrations.applied SET down_checksum = $1 WHERE version = 27", [m27.downChecksum]);
    assert.deepEqual(await readback(c), base);
  } finally { await C.close(); }
});

test("P4 atomic rollback: an injected failure AFTER the up + tracking row, a tampered POST / kickoff / ACL pin and tampered embedded 0027 bytes each leave NOTHING (history 26, no 0027 object, rows unchanged); the untampered packet then applies cleanly", async () => {
  const B = await startDbAt(26);
  try {
    const owner = new pg.Pool({ connectionString: B.adminUrl, max: 1 });
    await seed(B.app, owner); await owner.end(); const c = B.c; const pre = await readback(c);
    const at26 = async () => { const rb = await readback(c); assert.deepEqual([rb.identity.migrations.max, rb.x27.external_cancellations, rb.identity.objects.x27_trg_op_fence], [26, null, false]); await unchanged(c, pre); };
    const inject = WRAPPER.replace("RAISE NOTICE 'E7_27_APPLIED';", "RAISE EXCEPTION 'E7_27_INJECTED_AFTER_TRACKING_ROW';"); assert.notEqual(inject, WRAPPER);
    await expectRaise(c, /E7_27_INJECTED_AFTER_TRACKING_ROW/, inject); await at26();
    const tamper = (key, from, to) => { const line = WRAPPER.split("\n").find((l) => l.startsWith(`  ${key} `)); assert.ok(line, key); const t = line.replace(from, to); assert.notEqual(t, line, key); return WRAPPER.replace(line, t); };
    await expectRaise(c, /E7_27_POST_SCHEMA_IDENTITY_UNEXPECTED:functions/, tamper("c_post", /"functions":"[0-9a-f]{64}"/, `"functions":"${"0".repeat(64)}"`)); await at26();
    await expectRaise(c, /E7_27_KICKOFF_CATALOG_PRE_DRIFT/, tamper("c_kick", /"src":"[0-9a-f]{32}"/, `"src":"${"0".repeat(32)}"`)); await at26();
    await expectRaise(c, /E7_27_ACL_MATRIX_UNEXPECTED/, tamper("c_acl", /"projection":\{"mv_booking_admin":false,"mv_booking_app":true/, `"projection":{"mv_booking_admin":false,"mv_booking_app":false`)); await at26();
    const BYTES = WRAPPER.replace("$e7_0027_up$-- 0027", "$e7_0027_up$--  0027"); assert.notEqual(BYTES, WRAPPER);
    await expectRaise(c, /E7_27_UP27_BYTES_MISMATCH/, BYTES); await at26();
    assert.deepEqual((await runWrapper(c)).notices, ["E7_27_APPLIED"]);
    const post = await readback(c); assert.deepEqual(post.data, pre.data); assert.deepEqual(identity(post.identity), identity(PINS.post));
  } finally { await B.close(); }
});

test("P5 the packet records NO cancellation: after the apply the admin functions exist and are admin-only, yet no cancellation / refund attestation / EXTERNALLY_CANCELLED latch exists and every claim is as before; the operator document describes the one later C116 record with placeholders only (refund pending, sent_preserved, no latch, own claim only)", async () => {
  const rb = await readback(db.c);   // the P1 cluster, already at 27
  assert.equal(rb.identity.migrations.max, 27);
  assert.deepEqual([rb.x27.external_cancellations, rb.x27.external_refund_attestations, rb.x27.externally_cancelled_latches, rb.x27.projection_not_null], [0, 0, 0, 0]);
  const appErr = await db.app.query("SELECT booking.admin_record_external_cancellation(gen_random_uuid(),0,ARRAY[]::uuid[],gen_random_uuid(),'pending',NULL,NULL,'owner','x','X','packet-test-key-1')").then(() => null, (e) => e.code);
  assert.equal(appErr, "42501", "the runtime role cannot record");
  const doc = rd("claude/e7-0027-apply-operator-sequence.md");
  for (const s of ["<C116_INTENT_ID>", "<EXPECTED_VERSION>", "<C116_RESERVATION_ID>", "'pending'", "sent_preserved", "SEPARATE reviewed step"]) assert.ok(doc.includes(s), s);
  assert.match(doc, /no latch/i); assert.match(doc, /only (its|that intent's) own claim/i);
});
