// e7-0028-sqleditor-apply-wrapper — proves claude/e7-0028-sqleditor-apply-v1.sql + claude/e7-0028-readback-v1.sql (C119 S4) on DISPOSABLE PostgreSQL ONLY.
// LABELLED SPECIALISATION of test/db/e7-0027-sqleditor-apply-wrapper.test.mjs for ONE migration (0028: the claim_pipeline_kickoff source-literal rebind)
// on a cluster at EXACTLY 0001-0027. The packet is reviewable tooling for the shared TEST database; ROOT reviews and owns any actual shared apply —
// nothing here touches a shared database, a provider or the network. Scoped to packet correctness:
//   P0 deterministic assembly + continuity with the accepted 0027 POST pins + PRE / POST runner-catalog parity (main 5b9c0677 → MERGED S4 main a86437a8:
//      kickoff CATALOG_PINS, notification / status catalogPin27 → catalogPin28) + nothing outside the embedded up writes anything;
//   P1 one atomic apply over REALISTIC schema-27 data (incl. a C116-like REAL external cancellation with a pending refund attestation, the released claim and
//      the preserved SENT confirmation, a queued confirmation, a settled kickoff request, captured / reserved / authorized intents) → exact POST identity
//      (ONLY `functions` differs), the claim body == PRE with exactly the literal replaced, claim ACL unchanged, POST kickoff / notification / status catalogs
//      == merged main as the runtime app role, EVERY table row fingerprint + intent set + history + protected / historical + blockers + latch / projection
//      counts unchanged, migrator-built 28 == POST, the REAL claim now binds the S4 frame, second apply = provable no-op;
//   P2 refusals at 27 with NO write (environment, history drift, foreign env row, wrong role, identity drift incl. a pre-edited claim literal, quiescence
//      incl. an unsettled kickoff request / leased operation / run lock / write lock / migrator lock) + wrong history (26);
//   P3 STOP states at 28 (an extra function, a widened claim ACL, a foreign 0028 checksum), never continued or repaired;
//   P4 atomic rollback (injected failure after the tracking row, tampered POST / kickoff-POST / claim-ACL pins, tampered embedded bytes) then a clean apply;
//   P5 rollback limits stated honestly in the operator document (down restores 0026's literal; runner pins then refuse) and the packet never claims.
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
import { migrateUp, migrateDown, migrationStatus, loadMigrations } from "../../db/lib/migrate.js";
import { adminRecordEvidence } from "../../db/lib/admin.js";
import { LOCK_KEY } from "../../scripts/e7-connected/run-lock-precheck.mjs";
import { kickoffCatalog } from "../../claude/derive-0024-pins.mjs";
import { notificationCatalog } from "../../claude/derive-0025-0026-pins.mjs";
import { PINNED_REVISION } from "../../lib/checkout/pipeline-kickoff-plan.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const rd = (p) => readFileSync(join(ROOT, p), "utf8");
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const WRAPPER = rd("claude/e7-0028-sqleditor-apply-v1.sql"); const READBACK = rd("claude/e7-0028-readback-v1.sql");
const INVENTORY = rd("claude/e7-0028-inventory.sql"); const PINS = JSON.parse(rd("claude/e7-0028-pins-v1.json"));
const PINS27 = JSON.parse(rd("claude/e7-0027-pins-v1.json"));
const IDENTITY_KEYS = ["functions", "function_count", "triggers", "trigger_count", "constraints", "indexes", "columns", "table_acls", "rls", "rls_enabled_count", "policies", "policy_count",
  "schema_owner", "is_privileged_src", "is_privileged_config", "relations", "relation_count", "test_cleanup_pending_state", "prerequisite_0023", "objects", "acls"];
const identity = (inv) => Object.fromEntries(IDENTITY_KEYS.map((k) => [k, inv[k]]));
const M = loadMigrations(); const m28 = M.find((m) => m.version === 28);
const CLAIM_ACL = { mv_booking_admin: false, mv_booking_app: true, mv_booking_report: false, public: false };
/** accepted artifacts this packet must not alter (vs the tooling merge bbf12aa2 it is built from) */
const BASE = "bbf12aa22446807df7b63a55e38a464f4be88763";
const SPENT = Object.freeze(["db", "lib", "scripts", "api", "public", "claude/e7-0027-sqleditor-apply-v1.sql", "claude/e7-0027-readback-v1.sql", "claude/e7-0027-inventory.sql",
  "claude/e7-0027-pins-v1.json", "claude/gen-0027-wrapper.py", "claude/derive-0027-pins.mjs", "claude/derive-0024-pins.mjs", "claude/derive-0025-0026-pins.mjs"]);

let netAttempts = 0; const realFetch = globalThis.fetch;
globalThis.fetch = async () => { netAttempts += 1; throw new Error("network refused (offline C119 S4 packet suite)"); };

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
  const reconciler = new pg.Pool({ connectionString: base.adminUrl2(), max: 2 });
  const c = new pg.Client({ connectionString: base.adminUrl }); await c.connect();
  return { ...base, app, reconciler, c, async close() { await c.end().catch(() => {}); await app.end().catch(() => {}); await reconciler.end().catch(() => {}); base.stop(); } };
}
const inventory = async (c) => (await c.query(INVENTORY)).rows[0].e7_inventory;
const readback = async (c) => (await c.query(READBACK)).rows[0].e7_28_readback;
async function runWrapper(c, text = WRAPPER) {
  const notices = []; const on = (n) => notices.push(n.message); c.on("notice", on);
  try { const res = await c.query(text); return { status: res[res.length - 1].rows[0].e7_28_status, notices }; } finally { c.off("notice", on); }
}
const expectRaise = async (c, re, text) => { let msg = null; try { await runWrapper(c, text); } catch (e) { msg = e.message; } assert.ok(msg && re.test(msg), `expected ${re}, got ${msg}`); };
async function unchanged(c, pre) {
  const rb = await readback(c);
  assert.deepEqual(identity(rb.identity), identity(pre.identity), "schema identity unchanged");
  assert.deepEqual(rb.identity.migrations, pre.identity.migrations, "history unchanged");
  assert.deepEqual(rb.data, pre.data, "rows unchanged");
  for (const k of ["kickoff_rows", "kickoff_catalog", "claim"]) assert.deepEqual(rb[k], pre[k], k);
}
/** REALISTIC schema-27 data (accepted fixtures; synthetic guests only; owner-managed TEST SETUP marked): authorized / reserved / captured intents, a
 *  confirmed booking with a QUEUED confirmation, and a C116-like booking: confirmed, its confirmation SENT, then cancelled by a person in Hostaway and
 *  RECORDED through the REAL 0027 admin function (owner evidence + pending refund attestation; its own claim released; sent_preserved). */
async function seed(B) {
  const owner = new pg.Pool({ connectionString: B.adminUrl, max: 1 });
  try {
    const au = await F.authorized(B.app, { listingId: 606998, currency: "USD", from: "2027-05-01", to: "2027-05-04" });
    await F.reserved(B.app, { listingId: 772611 });
    await F.captured(B.app, { listingId: 772612, from: "2027-06-01", to: "2027-06-04" });
    await F.confirmed(B.app, { listingId: 772613, from: "2027-07-01", to: "2027-07-04" });
    const sent = await F.confirmed(B.app, { listingId: 772614, from: "2027-08-01", to: "2027-08-04" });
    await F.ownerManagedHistory(owner, `UPDATE booking.external_operations SET state = 'succeeded', attempts = 1, dispatched_at = now(), completed_at = now(),
      result_ref = 'mock-sent-1' WHERE intent_id = $1 AND op_type = 'guest.notify'`, [sent.id]);      // TEST SETUP ONLY: a sent confirmation's terminal row
    const ev = F.ok(await adminRecordEvidence(B.reconciler, { intentId: sent.id, kind: "hostaway_reservation", externalRef: String(sent.reservationId), status: "cancelled",
      observed: {}, observedAt: Date.now(), attestedBy: "owner", reference: "hostaway-dashboard-cancelled" }), "owner evidence").id;
    const v = (await B.c.query("SELECT version FROM booking.intents WHERE id = $1", [sent.id])).rows[0].version;
    const rec = (await B.reconciler.query("SELECT booking.admin_record_external_cancellation($1,$2,$3::uuid[],$4,$5,$6,$7,$8,$9,$10,$11) AS r",
      [sent.id, v, [ev], ev, "pending", null, null, "owner", "hostaway-dash-check-1", "OWNER_CANCELLED_IN_HOSTAWAY", "packet28-seed-key-1"])).rows[0].r;
    // TEST SETUP ONLY: one SETTLED (refused) kickoff request row (the fixture clock predates the 0024 cutoff, so the trigger did not create one)
    await F.ownerManagedHistory(owner, `INSERT INTO booking.pipeline_kickoff_requests (intent_id, ref, authorized_version, payment_intent_id, amount_minor, currency, listing_id,
      intent_created_at, requested_at, state, settled_at, outcome_code) SELECT i.id, i.ref, i.version, i.stripe_payment_intent_id, i.final_total_minor, 'USD', 606998,
      '2026-11-16T00:00:00Z', now(), 'refused', now(), 'TEST_SETUP_SETTLED' FROM booking.intents i WHERE i.id = $1`, [au.id]);
    return { sentId: sent.id, record: rec };
  } finally { await owner.end(); }
}

let db; let seeded;
before(async () => { db = await startDbAt(27); seeded = await seed(db); });
after(async () => { globalThis.fetch = realFetch; await db.close(); assert.equal(netAttempts, 0); });

test("P0 deterministic assembly: pins == a fresh PRE derivation (schema 27) and == the accepted 0027 POST pins on EVERY identity key + history aggregate; ONLY `functions` changes; the embedded up is the merged 0028 file only (no other up, no down); claim src md5 fb103173 → 98ffe6c8; kickoff / notification catalogs PRE == main 5b9c0677 and POST == MERGED S4 main a86437a8; nothing outside the embedded up writes; regeneration byte-identical; operator manifest exact; accepted artifacts untouched", async () => {
  const B = await startDbAt(27);
  try { assert.deepEqual(identity(await inventory(B.c)), identity(PINS.pre), "PRE identity == a fresh 0001-0027 build"); } finally { await B.close(); }
  for (const k of IDENTITY_KEYS) assert.deepEqual(PINS.pre[k], PINS27.post[k], `continuity with the accepted 0027 POST pin: ${k}`);
  assert.equal(PINS.pre.migrations.aggregate, PINS27.post.migrations.aggregate, "same 0001-0027 history aggregate as the accepted shared-TEST post-27 state");
  assert.deepEqual(IDENTITY_KEYS.filter((k) => JSON.stringify(PINS.pre[k]) !== JSON.stringify(PINS.post[k])), ["functions"]); assert.deepEqual(PINS.identityKeysChanged, ["functions"]);
  assert.deepEqual([PINS.files.up28, PINS.files.down28, PINS.files.name28], [m28.upChecksum, m28.downChecksum, m28.name]);
  assert.deepEqual([m28.upChecksum, m28.downChecksum], ["a72d2ce911cac924b728525f1af43b547c7e908a96bdecbf84f41ca3ebfa3642", "c247b17883b23ecdba1eb0ec2a94e5e0e9caa558724ee29c4b0500fb7b77806f"]);
  assert.equal(M.at(-1).version, 29);   // P1: 0029 (price tax) follows; this packet is still about 28
  assert.equal(/\$e7_0028_up\$([\s\S]*?)\$e7_0028_up\$/.exec(WRAPPER)[1], m28.up); assert.equal(WRAPPER.split("$e7_0028_up$").length, 3);
  for (const m of M) { if (m.version < 28) assert.ok(!WRAPPER.includes(m.up), `up ${m.version} absent`); assert.ok(!WRAPPER.includes(m.down), `down ${m.version} absent`); }
  assert.equal((WRAPPER.match(/INSERT INTO booking_migrations\.applied/g) || []).length, 1); assert.ok(!/VALUES \((?!28,)\d+,/.test(WRAPPER), "only the 28 tracking row");
  const outside = WRAPPER.replace(/\$e7_0028_up\$[\s\S]*?\$e7_0028_up\$/g, "");
  assert.ok(!/migrateDown|DROP (TABLE|FUNCTION|TRIGGER|POLICY)|DELETE FROM|UPDATE booking\.|INSERT INTO booking\.|CREATE (OR REPLACE )?FUNCTION|GRANT |REVOKE /.test(outside),
    "outside the embedded up the wrapper drops / deletes / updates / inserts / creates / grants nothing (zero booking DML; no adoption / backfill)");
  assert.ok(!/(PERFORM|SELECT|CALL)\s+booking\.(admin_record_external_cancellation|admin_attest_external_refund|admin_record_evidence|claim_pipeline_kickoff)\s*\(/.test(outside + READBACK),
    "no record / attestation / evidence / claim call anywhere in the packet SQL");
  assert.ok(WRAPPER.includes(`hashtext('${LOCK_KEY}')`)); assert.ok(!/RESET |SET statement_timeout|SET lock_timeout/.test(WRAPPER.replace(/SET LOCAL/g, "")), "only SET LOCAL");
  assert.equal(sha(INVENTORY), PINS.inventorySql);
  assert.deepEqual(PINS.claimSrcMd5, { pre: "fb103173762c5dc6565338d2a15dd067", post: "98ffe6c804377b46b0d3d8907ac7d284" });
  assert.deepEqual([PINS.runners.pre.commit, PINS.runners.post.commit], ["5b9c06774757c9b84036fbc91773c3a098835d8f", "a86437a8738b176f132e1661cabffaa82c2515c2"]);
  assert.deepEqual(PINS.notificationSectionsChanged, ["fn"]);
  assert.equal(PINS.notificationCatalogPost.catalog, "96d74ab10cdf7bdd99e125eb6825284e9b57cacec33478fb1a666746e8f91b1b");
  assert.equal(PINS.notificationCatalogPre.catalog, "bcc116319adfa7c2e0c2f42d32d48b67fdc53ab35cd4058e777e5de5376c6d16");
  assert.equal(PINS.kickoffCatalogPre.functions[0].src, PINS.claimSrcMd5.pre); assert.equal(PINS.kickoffCatalogPost.functions[0].src, PINS.claimSrcMd5.post);
  for (const [dirKey, side] of [["E7_MAIN_PRE_DIR", "pre"], ["E7_MAIN_DIR", "post"]]) {
    const dir = process.env[dirKey]; if (!dir || !existsSync(join(dir, PINS.runners.paths.kickoff))) continue;
    for (const [k, p] of Object.entries(PINS.runners.paths)) assert.equal(createHash("sha256").update(readFileSync(join(dir, p))).digest("hex"), PINS.runners[side].sha256[k], `${side} ${p}`);
    const K = await import(pathToFileURL(join(dir, PINS.runners.paths.kickoff)).href); const N = await import(pathToFileURL(join(dir, PINS.runners.paths.notification)).href);
    const S = await import(pathToFileURL(join(dir, PINS.runners.paths.status)).href);
    const J = (x) => JSON.parse(JSON.stringify(x));
    assert.deepEqual(J(K.CATALOG_PINS), side === "pre" ? PINS.kickoffCatalogPre : PINS.kickoffCatalogPost, `${side} kickoff CATALOG_PINS`);
    assert.deepEqual(J(side === "pre" ? N.CONSTANTS.catalogPin27 : N.CONSTANTS.catalogPin28), side === "pre" ? PINS.notificationCatalogPre : PINS.notificationCatalogPost, `${side} notification pin`);
    if (side === "post") assert.deepEqual(J(S.CONSTANTS.catalogPin28), PINS.notificationCatalogPost, "status runner pin");
  }
  const out = execFileSync("python3", [join(ROOT, "claude/gen-0028-wrapper.py"), ROOT], { encoding: "utf8" });
  assert.ok(out.includes(`sqleditor-apply-v1.sql sha256: ${sha(WRAPPER)}`) && out.includes(`readback-v1.sql sha256: ${sha(READBACK)}`), out);
  let haveGit = true; try { execFileSync("git", ["-C", ROOT, "cat-file", "-e", `${BASE}^{commit}`]); } catch { haveGit = false; }
  if (haveGit) for (const p of SPENT) assert.equal(execFileSync("git", ["-C", ROOT, "diff", "--quiet", BASE, "--", p], { encoding: "utf8" }), "", `untouched vs ${BASE.slice(0, 8)}: ${p}`);
  const doc = rd("claude/e7-0028-apply-operator-sequence.md");
  const manifest = [...doc.matchAll(/^\| `([^`]+)` \| `([0-9a-f]{64})` \|$/gm)].map((x) => [x[1], x[2]]);
  assert.equal(manifest.length, 9, "operator manifest lists every packet + migration file");
  for (const [p, h] of manifest) if (p !== "test/db/e7-0028-sqleditor-apply-wrapper.test.mjs") assert.equal(sha(rd(p)), h, `operator manifest: ${p}`);
  assert.ok(doc.includes(PINS.post.functions) && doc.includes(PINS.pre.migrations.aggregate) && doc.includes(PINS.post.migrations.aggregate), "operator doc carries the expected pins");
  assert.doesNotMatch(doc, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\b7\d{7}\b|cs_test_|pi_[A-Za-z0-9]|@(?!example)[a-z]+\.[a-z]/, "no private identifier in the operator document");
});

test("P1 one atomic apply over REALISTIC schema-27 data (incl. a REAL recorded C116-like cancellation + pending refund + released claim + preserved SENT confirmation): E7_28_APPLIED; status 28 + ONE exact tracking row; POST identity (only `functions`); claim body == PRE with exactly the literal replaced; claim ACL unchanged; POST kickoff / notification / status catalogs == MERGED main as the runtime app role; EVERY table / intent / history / protected / historical / blocker / latch / projection fingerprint unchanged; the REAL claim now binds the S4 frame; migrator-built 28 == POST; second apply = provable no-op", async () => {
  assert.ok(seeded.record, "the REAL 0027 record function recorded the seed cancellation");
  const pre = await readback(db.c);
  assert.deepEqual(pre.exclusion, { hosted_run_lock_held: false, work_leases: 0, intent_leases: 0, operation_leases_or_in_flight: 0, kickoff_unsettled: 0, prepared_transactions: 0, other_session_write_locks: 0 });
  assert.deepEqual(pre.kickoff_catalog, PINS.kickoffCatalogPre);
  assert.deepEqual(pre.claim, { src_md5: PINS.claimSrcMd5.pre, old_literal: 1, new_literal: 0, acl: CLAIM_ACL });
  for (const t of ["external_cancellations", "external_refund_attestations", "inventory_claims", "external_operations", "payment_attempts", "pipeline_kickoff_requests", "provider_evidence"]) {
    assert.ok(t in pre.data.booking_tables, t); }
  assert.ok(Number(pre.data.booking_tables.external_cancellations.split(":")[0]) >= 1 && Number(pre.data.booking_tables.external_refund_attestations.split(":")[0]) >= 1, "a REAL recorded cancellation + attestation are covered");
  assert.ok(pre.data.projection_not_null >= 1, "the recorded cancellation is visible through the projection");
  const r = await runWrapper(db.c);
  assert.deepEqual(r.notices, ["E7_28_APPLIED"]);
  assert.deepEqual(r.status, { migrations_max: 28, v28: true, claim_src_md5: PINS.claimSrcMd5.post, functions_sha256: PINS.post.functions });
  const post = await readback(db.c);
  assert.deepEqual(identity(post.identity), identity(PINS.post), "POST identity == pins");
  assert.equal(post.identity.migrations.aggregate, PINS.post.migrations.aggregate); assert.equal(post.identity.migrations.aggregate_1_27, PINS.pre.migrations.aggregate);
  assert.deepEqual(post.identity.migrations.v28, { version: 28, name: m28.name, up_checksum: m28.upChecksum, down_checksum: m28.downChecksum, environment: "test" });
  assert.deepEqual(post.data, pre.data, "EVERY booking table (cancellation / refund / claim / notify / payment / evidence / kickoff ...), intents, history, protected, historical, blockers, latches, projection unchanged");
  assert.deepEqual(post.claim, { src_md5: PINS.claimSrcMd5.post, old_literal: 0, new_literal: 1, acl: CLAIM_ACL });
  assert.deepEqual([post.kickoff_rows, post.kickoff_catalog], [pre.kickoff_rows, PINS.kickoffCatalogPost]);
  const appc = new pg.Client({ connectionString: db.appUrl() }); await appc.connect();
  try {
    assert.deepEqual(await kickoffCatalog(appc), PINS.kickoffCatalogPost, "the kickoff runner's probe as the runtime app role == merged main CATALOG_PINS");
    const dir = process.env.E7_MAIN_DIR;
    if (dir && existsSync(join(dir, PINS.runners.paths.notification))) {
      const N = await import(pathToFileURL(join(dir, PINS.runners.paths.notification)).href); const S = await import(pathToFileURL(join(dir, PINS.runners.paths.status)).href);
      const nc = await notificationCatalog(appc, N);
      assert.deepEqual(nc, JSON.parse(JSON.stringify(N.CONSTANTS.catalogPin28)), "the MERGED notification runner's own CATALOG_SQL at 28 == its catalogPin28 (admits)");
      assert.deepEqual(nc, JSON.parse(JSON.stringify(S.CONSTANTS.catalogPin28)), "and == the status runner's pin");
    }
  } finally { await appc.end(); }
  // the REAL claim function now binds the S4 frame literal (the kickoff tooling's own dispatch inputs) — exercised on a FRESH disposable cluster
  const st = await migrationStatus(db.c, { env: "test" }); assert.deepEqual([st.applied.length, st.pending], [28, [29]]);   // P1: + 0029 (mechanical)
  const r2 = await runWrapper(db.c); assert.deepEqual(r2.notices, ["E7_28_ALREADY_EXACT_NOOP"]); assert.deepEqual(await readback(db.c), post, "second apply wrote nothing");
  const B = await startDbAt(28);
  try { assert.deepEqual(identity(await inventory(B.c)), identity(PINS.post), "migrator-built 28 == the wrapper POST"); assert.deepEqual((await runWrapper(B.c)).notices, ["E7_28_ALREADY_EXACT_NOOP"]); }
  finally { await B.close(); }
  const src = (await db.c.query("SELECT prosrc FROM pg_catalog.pg_proc WHERE oid = 'booking.claim_pipeline_kickoff(uuid,text,text,jsonb)'::regprocedure")).rows[0].prosrc;
  assert.ok(PINNED_REVISION.sourceDigest === PINS.literal.new && src.includes(`'${PINNED_REVISION.sourceDigest}'`) && !src.includes(PINS.literal.old), "the applied claim literal == the merged tooling's pinned S4 ENABLE frame (PINNED_REVISION.sourceDigest)");
});

test("P2 refusals at 27 write NOTHING: wrong environment; history drift (0010, 0027 rows); foreign environment row; wrong role (admin, app); identity drift (an extra function, a pre-edited claim literal, a widened claim ACL, RLS off); quiescence (run lock, write lock, held migrator lock 55P03, an unsettled kickoff request, a leased operation); history 26 → HISTORY_NOT_1_TO_27", async () => {
  const B = await startDbAt(27);
  try {
    await seed(B); const c = B.c; const pre = await readback(c);
    const owner = new pg.Pool({ connectionString: B.adminUrl, max: 1 });
    await c.query("UPDATE booking.instance SET environment = 'live'"); await expectRaise(c, /E7_28_NOT_TEST/); await c.query("UPDATE booking.instance SET environment = 'test'"); await unchanged(c, pre);
    for (const v of [10, 27]) {
      const m = M.find((x) => x.version === v);
      await c.query("UPDATE booking_migrations.applied SET up_checksum = repeat('0',64) WHERE version = $1", [v]);
      await expectRaise(c, /E7_28_HISTORY_DRIFT/); await c.query("UPDATE booking_migrations.applied SET up_checksum = $1 WHERE version = $2", [m.upChecksum, v]); await unchanged(c, pre);
    }
    await c.query("UPDATE booking_migrations.applied SET environment = 'live' WHERE version = 5"); await expectRaise(c, /E7_28_ENV_MISMATCH/);
    await c.query("UPDATE booking_migrations.applied SET environment = 'test' WHERE version = 5"); await unchanged(c, pre);
    for (const url of [B.adminUrl2(), B.appUrl()]) {
      const other = new pg.Client({ connectionString: url }); await other.connect();
      try { let msg = null; try { await other.query(WRAPPER); } catch (e) { msg = e.message; } assert.ok(msg && /E7_28_NOT_SCHEMA_OWNER|permission denied/.test(msg), msg); } finally { await other.end(); }
    }
    await unchanged(c, pre);
    const up28 = M.find((x) => x.version === 28).up; const down28 = M.find((x) => x.version === 28).down;
    for (const [make, undo, re] of [
      ["CREATE FUNCTION booking._e7_extra() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$", "DROP FUNCTION booking._e7_extra()", /E7_28_SCHEMA_IDENTITY_DRIFT:.*functions/],
      [up28, down28, /E7_28_SCHEMA_IDENTITY_DRIFT:.*functions/],            // the claim already rebound out-of-band (history still 27) → identity drift, never adopted
      ["GRANT EXECUTE ON FUNCTION booking.claim_pipeline_kickoff(uuid,text,text,jsonb) TO mv_booking_report",
        "REVOKE EXECUTE ON FUNCTION booking.claim_pipeline_kickoff(uuid,text,text,jsonb) FROM mv_booking_report", /E7_28_SCHEMA_IDENTITY_DRIFT:.*(functions|acls)/],
      ["ALTER TABLE booking.notification_provider_receipts DISABLE ROW LEVEL SECURITY", "ALTER TABLE booking.notification_provider_receipts ENABLE ROW LEVEL SECURITY", /E7_28_SCHEMA_IDENTITY_DRIFT:.*rls/]]) {
      await c.query(make); await expectRaise(c, re); await c.query(undo); await unchanged(c, pre);
    }
    const holder = new pg.Client({ connectionString: B.adminUrl }); await holder.connect();
    try {
      await holder.query("SELECT pg_advisory_lock(pg_catalog.hashtext($1), 0)", [LOCK_KEY]); await expectRaise(c, /E7_28_ACTIVE_RUN_LOCK_HELD/);
      await holder.query("SELECT pg_advisory_unlock(pg_catalog.hashtext($1), 0)", [LOCK_KEY]); await unchanged(c, pre);
      await holder.query("BEGIN"); await holder.query("LOCK TABLE booking.intents IN ROW EXCLUSIVE MODE");
      await expectRaise(c, /E7_28_BOOKING_WRITE_LOCK_HELD/); await holder.query("ROLLBACK"); await unchanged(c, pre);
      await holder.query("BEGIN"); await holder.query("SELECT pg_advisory_xact_lock(7302215001)");
      let code = null; try { await runWrapper(c); } catch (e) { code = e.code; } assert.equal(code, "55P03", "held migrator lock → lock_timeout");
      await holder.query("ROLLBACK"); await unchanged(c, pre);
    } finally { await holder.end(); }
    const kr = (await c.query("SELECT intent_id AS id, settled_at::text AS t FROM booking.pipeline_kickoff_requests LIMIT 1")).rows[0];
    await F.ownerManagedHistory(owner, "UPDATE booking.pipeline_kickoff_requests SET state = 'requested', settled_at = NULL, outcome_code = NULL WHERE intent_id = $1", [kr.id]);
    await expectRaise(c, /E7_28_KICKOFF_REQUEST_UNSETTLED/);
    await F.ownerManagedHistory(owner, "UPDATE booking.pipeline_kickoff_requests SET state = 'refused', settled_at = $2::timestamptz, outcome_code = 'TEST_SETUP_SETTLED' WHERE intent_id = $1", [kr.id, kr.t]);
    await unchanged(c, pre);
    const op = (await c.query("SELECT id FROM booking.external_operations WHERE state = 'pending' LIMIT 1")).rows[0];
    await F.ownerManagedHistory(owner, "UPDATE booking.external_operations SET lease_worker_id = 'w-x', lease_until = now() + interval '1 minute' WHERE id = $1", [op.id]);
    await expectRaise(c, /E7_28_OPERATION_LEASED_OR_IN_FLIGHT/);
    await F.ownerManagedHistory(owner, "UPDATE booking.external_operations SET lease_worker_id = NULL, lease_until = NULL WHERE id = $1", [op.id]); await unchanged(c, pre);
    assert.equal((await readback(c)).identity.migrations.max, 27);
    await owner.end();
  } finally { await B.close(); }
  const C = await startDbAt(26);
  try { await expectRaise(C.c, /E7_28_HISTORY_NOT_1_TO_27/); assert.equal((await C.c.query("SELECT max(version)::int AS m FROM booking_migrations.applied")).rows[0].m, 26); } finally { await C.close(); }
});

test("P3 STOP states at 28, never continued or repaired: an extra function → STOP:functions; a widened claim ACL (EXECUTE to report) → STOP; a foreign 0028 checksum → STOP:history; each writes nothing", async () => {
  const C = await startDbAt(28);
  try {
    const c = C.c; const base = await readback(c);
    await c.query("CREATE FUNCTION booking._e7_extra() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$");
    const r1 = await readback(c); await expectRaise(c, /E7_28_POST_STATE_MISMATCH_STOP:.*functions/); await unchanged(c, r1);
    await c.query("DROP FUNCTION booking._e7_extra()");
    await c.query("GRANT EXECUTE ON FUNCTION booking.claim_pipeline_kickoff(uuid,text,text,jsonb) TO mv_booking_report");
    const r2 = await readback(c); await expectRaise(c, /E7_28_POST_STATE_MISMATCH_STOP:.*(functions|acls|kickoff_catalog)/); await unchanged(c, r2);
    await c.query("REVOKE EXECUTE ON FUNCTION booking.claim_pipeline_kickoff(uuid,text,text,jsonb) FROM mv_booking_report");
    await c.query("UPDATE booking_migrations.applied SET down_checksum = repeat('0',64) WHERE version = 28");
    const r3 = await readback(c); await expectRaise(c, /E7_28_POST_STATE_MISMATCH_STOP:history/); await unchanged(c, r3);
    await c.query("UPDATE booking_migrations.applied SET down_checksum = $1 WHERE version = 28", [m28.downChecksum]);
    assert.deepEqual(await readback(c), base);
  } finally { await C.close(); }
});

test("P4 atomic rollback: an injected failure AFTER the up + tracking row, tampered POST / kickoff-POST / claim-ACL pins and tampered embedded 0028 bytes each leave NOTHING (history 27, claim still the 0026 literal, rows unchanged); the untampered packet then applies cleanly", async () => {
  const B = await startDbAt(27);
  try {
    await seed(B); const c = B.c; const pre = await readback(c);
    const at27 = async () => { const rb = await readback(c); assert.deepEqual([rb.identity.migrations.max, rb.claim.src_md5], [27, PINS.claimSrcMd5.pre]); await unchanged(c, pre); };
    const inject = WRAPPER.replace("RAISE NOTICE 'E7_28_APPLIED';", "RAISE EXCEPTION 'E7_28_INJECTED_AFTER_TRACKING_ROW';"); assert.notEqual(inject, WRAPPER);
    await expectRaise(c, /E7_28_INJECTED_AFTER_TRACKING_ROW/, inject); await at27();
    const tamper = (key, from, to) => { const line = WRAPPER.split("\n").find((l) => l.startsWith(`  ${key} `)); assert.ok(line, key); const t = line.replace(from, to); assert.notEqual(t, line, key); return WRAPPER.replace(line, t); };
    await expectRaise(c, /E7_28_POST_SCHEMA_IDENTITY_UNEXPECTED:functions/, tamper("c_post", /"functions":"[0-9a-f]{64}"/, `"functions":"${"0".repeat(64)}"`)); await at27();
    await expectRaise(c, /E7_28_KICKOFF_CATALOG_UNEXPECTED/, tamper("c_kick_post", /"src":"[0-9a-f]{32}"/, `"src":"${"0".repeat(32)}"`)); await at27();
    await expectRaise(c, /E7_28_KICKOFF_CATALOG_PRE_DRIFT/, tamper("c_kick_pre", /"src":"[0-9a-f]{32}"/, `"src":"${"0".repeat(32)}"`)); await at27();
    await expectRaise(c, /E7_28_CLAIM_ACL_PRE_DRIFT/, tamper("c_claim_acl", /"mv_booking_app":true/, `"mv_booking_app":false`)); await at27();
    const BYTES = WRAPPER.replace("$e7_0028_up$-- 0028", "$e7_0028_up$--  0028"); assert.notEqual(BYTES, WRAPPER);
    await expectRaise(c, /E7_28_UP28_BYTES_MISMATCH/, BYTES); await at27();
    assert.deepEqual((await runWrapper(c)).notices, ["E7_28_APPLIED"]);
    const post = await readback(c); assert.deepEqual(post.data, pre.data); assert.deepEqual(identity(post.identity), identity(PINS.post));
  } finally { await B.close(); }
});

test("P5 rollback limits stated honestly: the migrator's 0028 down restores EXACTLY the 0026 claim body (PRE identity + history 27 again, rows unchanged) on a disposable cluster; the operator document says the down is a separately reviewed owner step, that PRE-S4 runners refuse after the apply and merged-main runners refuse after a down, and that no provider effect is involved", async () => {
  const B = await startDbAt(27);
  try {
    await seed(B); const c = B.c; const pre = await readback(c);
    assert.deepEqual((await runWrapper(c)).notices, ["E7_28_APPLIED"]);
    assert.deepEqual(await migrateDown(c, { env: "test", to: 27 }), [28]);
    const back = await readback(c);
    assert.deepEqual(identity(back.identity), identity(PINS.pre)); assert.deepEqual(back.identity.migrations, pre.identity.migrations); assert.deepEqual(back.data, pre.data);
    assert.deepEqual(back.claim, pre.claim);
  } finally { await B.close(); }
  const doc = rd("claude/e7-0028-apply-operator-sequence.md");
  for (const s of ["separately reviewed", "readback-v1.sql FIRST", "never re-issue", "PRE-S4", "refuse", "no provider", "E7_28_ALREADY_EXACT_NOOP", "E7_28_POST_STATE_MISMATCH_STOP"]) assert.ok(doc.includes(s), s);
});
