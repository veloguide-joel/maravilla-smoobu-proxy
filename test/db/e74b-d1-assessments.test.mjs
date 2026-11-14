// Stage E7.4b-D1 slice A — migration 0012: persisted PREFLIGHT ASSESSMENTS and the eligible-assessment CLAIM FENCE with the existence-based
// conflict / exhaustion LATCH (claude/e74b-preflight-assessment-contract.md revision 2 + root addendum A–F).
// Throwaway local PostgreSQL; repository code runs as the runtime login (test_app ∈ mv_booking_app); test_admin ∈ mv_booking_admin and
// test_report ∈ mv_booking_report for privilege probes; the schema owner (postgres) only for probes, explicitly-labelled history /
// fault setup (triggers bypassed) and migrations. Every provider observation is a SYNTHETIC fixture; no provider or network call exists here.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { startMigratedDatabase, startPostgres } from "./harness.mjs";
import * as F from "./fixtures.mjs";
import { applyEvent } from "../../db/lib/repo.js";
import { claimNextOperation, completeOperation, completeRecordingWithEvidence, recordRecordingAssessment, requestRead, recordProviderEvidence }
  from "../../db/lib/operations.js";
import { adminRecordEvidence } from "../../db/lib/admin.js";
import { migrateDown, migrateUp, migrationStatus, loadMigrations } from "../../db/lib/migrate.js";

// ---- C26 migration-boundary helpers (test-local; no harness default changed) ------------------------------------------------------------
// The repository's migration chain (loadMigrations enforces contiguity 1..TOP). A boundary N is EXPLICIT: every migration above N must roll back
// mechanically in a fresh, data-free cluster (down == TOP..N+1 exactly), the recorded history must then be exactly 1..N applied / N+1..TOP pending,
// the schema must equal a fresh cluster migrated UP to N, and the re-up must return exactly N+1..TOP. Nothing here accepts "whatever the top is":
// the expected lists are derived from the migration files in this tree and re-checked against the bookkeeping table at each boundary.
const MIGRATION_VERSIONS = loadMigrations().map((m) => m.version); const TOP = MIGRATION_VERSIONS.at(-1);
assert.deepEqual(MIGRATION_VERSIONS, Array.from({ length: TOP }, (_, i) => i + 1), "contiguous migration chain");
const range = (from, to) => (from <= to ? Array.from({ length: to - from + 1 }, (_, i) => from + i) : Array.from({ length: from - to + 1 }, (_, i) => from - i));
/** down from the current top to boundary N in a fresh cluster: exact descending list + exact history */
async function downToBoundary(c, n) {
  const ran = await migrateDown(c, { env: "test", to: n });
  assert.deepEqual(ran, range(TOP, n + 1), `every migration above ${n} rolls back mechanically (fresh, data-free)`);
  const st = await migrationStatus(c, { env: "test" });
  assert.deepEqual([st.applied, st.pending], [range(1, n), range(n + 1, TOP)], `history at boundary ${n}`);
  return ran;
}
/** re-up from boundary N to the top: exact ascending list + exact history */
async function upFromBoundary(c, n) {
  const ran = await migrateUp(c, { env: "test" });
  assert.deepEqual(ran, range(n + 1, TOP), `re-up from ${n} applies exactly the rest of the chain`);
  const st = await migrationStatus(c, { env: "test" });
  assert.deepEqual([st.applied, st.pending], [range(1, TOP), []], "history at top");
  return ran;
}
/** a dedicated disposable cluster migrated UP to exactly N (the intended boundary built forward, never by rolling back) */
async function freshAt(n) {
  const d = await startPostgres(); const c = new pg.Client({ connectionString: d.adminUrl }); await c.connect();
  assert.deepEqual(await migrateUp(c, { env: "test", to: n }), range(1, n));
  const st = await migrationStatus(c, { env: "test" }); assert.deepEqual([st.applied, st.pending], [range(1, n), range(n + 1, TOP)]);
  return { d, c, close: async () => { await c.end(); d.stop(); } };
}
/** full schema shape (bodies / ACLs / security / volatility / search_path / triggers / columns / grants / policies / constraints / indexes / RLS) */
const schemaObjects = async (c) => (await c.query(`
      SELECT 'fn|' || p.oid::regprocedure::text || '|' || md5(pg_get_functiondef(p.oid)) || '|' || coalesce(array_to_string(p.proacl, ','), '') || '|' ||
             p.prosecdef::text || '|' || p.provolatile::text || '|' || coalesce(array_to_string(p.proconfig, ','), '') AS o FROM pg_proc p WHERE p.pronamespace = 'booking'::regnamespace
      UNION ALL SELECT 'trg|' || tgrelid::regclass::text || '|' || tgname || '|' || pg_get_triggerdef(oid) FROM pg_trigger WHERE NOT tgisinternal AND tgrelid::regclass::text LIKE 'booking.%'
      UNION ALL SELECT 'col|' || table_name || '|' || column_name || '|' || data_type || '|' || is_nullable FROM information_schema.columns WHERE table_schema = 'booking'
      UNION ALL SELECT 'tbl|' || grantee || '|' || table_name || '|' || privilege_type FROM information_schema.role_table_grants WHERE table_schema = 'booking'
      UNION ALL SELECT 'pol|' || tablename || '|' || policyname || '|' || array_to_string(roles, ',') || '|' || cmd FROM pg_policies WHERE schemaname = 'booking'
      UNION ALL SELECT 'con|' || conrelid::regclass::text || '|' || conname || '|' || pg_get_constraintdef(oid) FROM pg_constraint WHERE connamespace = 'booking'::regnamespace
      UNION ALL SELECT 'idx|' || indexrelid::regclass::text || '|' || pg_get_indexdef(indexrelid) FROM pg_index WHERE indrelid::regclass::text LIKE 'booking.%'
      UNION ALL SELECT 'rls|' || relname || '|' || relrowsecurity::text FROM pg_class WHERE relnamespace = 'booking'::regnamespace AND relkind = 'r'
      ORDER BY 1`)).rows.map((r) => r.o);

let db; let report;
before(async () => { db = await startMigratedDatabase(); report = new pg.Pool({ connectionString: db.reportUrl(), max: 2 }); });
after(async () => { await report.end().catch(() => {}); await db.close(); });

const MIN = 60 * 1000;
const OCH = ["hostaway.record_offline_charge"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let stayN = 0;
const stay = () => { stayN += 1; const d = new Date(Date.UTC(2030, 0, 1) + stayN * 6 * 86400000).toISOString().slice(0, 10);
  const e = new Date(Date.UTC(2030, 0, 1) + (stayN * 6 + 3) * 86400000).toISOString().slice(0, 10); return { listingId: 820000 + stayN, from: d, to: e }; };

// ---- helpers --------------------------------------------------------------------------------------------------------
const lease = (intentId, worker = "w1", ms = 10 * MIN) =>
  db.app.query("UPDATE booking.intent_work SET work_worker_id = $2, work_lease_until = $3 WHERE intent_id = $1", [intentId, worker, new Date(Date.now() + ms)]);
/** captured intent, work lease held by w1, its pending initial recording and DB facts */
async function setup({ worker = "w1" } = {}) {
  const c = await F.captured(db.app, stay());
  await lease(c.id, worker);
  return { c, opId: await F.initialRecordingId(db.app, c.id), f: await F.preflightFacts(db.app, c.id) };
}
const now = () => Date.now() - 100;
const idRead = (s, t = now()) => F.completedRead(db.app, s.c.id, "hostaway.retrieve_reservation", s.f.hostaway_reservation_id, t);
const listRead = (s, t = now()) => F.completedRead(db.app, s.c.id, "hostaway.list_offline_charges", s.f.hostaway_reservation_id, t);
const idEv = (s, readId, observed = F.identityObserved(s.f), status = "found_active") =>
  F.readEvidenceOf(db.app, readId, "hostaway_reservation", s.f.hostaway_reservation_id, status, observed);
const listEv = (s, readId, observed = F.preflightListObserved()) => F.readEvidenceOf(db.app, readId, "hostaway_offline_charges", s.f.hostaway_reservation_id, "listed", observed);
async function positive(s, t = now()) { const identityReadId = await idRead(s, t); return { identityReadId, identityEvidenceId: await idEv(s, identityReadId) }; }
async function parts(s, { t = now(), list = F.preflightListObserved(), identity = F.identityObserved(s.f) } = {}) {
  const identityReadId = await idRead(s, t); const identityEvidenceId = await idEv(s, identityReadId, identity);
  const listReadId = await listRead(s, t); const listEvidenceId = await listEv(s, listReadId, list);
  return { identityReadId, identityEvidenceId, listReadId, listEvidenceId };
}
const rec = (s, o) => recordRecordingAssessment(db.app, s.opId, { workerId: "w1", expectedVersion: s.f.version, moduleVersion: F.PROOF_MODULE_VERSION,
  clientLabel: F.PREFLIGHT_CLIENT_LABEL, accountRef: F.PREFLIGHT_ACCOUNT_REF, config: F.preflightConfig(s.f), ...o });
const eligible = async (s, o = {}) => rec(s, { outcome: "eligible", ...(await parts(s)), ...o });
const conflictList = () => F.preflightListObserved({ matchingChargeCount: 1, matchingChargeIds: ["700001"], rowCount: 1 });
const conflict = async (s) => rec(s, { outcome: "conflict_marker", code: "PRIOR_RECORDING_MARKER_PRESENT", ...(await parts(s, { list: conflictList() })) });
const counted = async (s) => rec(s, { outcome: "identity_refused", code: "IDENTITY_FAIL_ENVELOPE", identityReadId: await idRead(s) });
/** an identity / list read escalated through the real retry path (10 attempts, outcome_unknown each), last attempt ~now */
async function escalatedRead(s, opType) {
  const base = Date.now() - 9 * 31000 - 300;
  const id = await requestRead(db.app, s.c.id, opType, s.f.hostaway_reservation_id, { now: base });
  for (let k = 0; k < 10; k++) {
    const t = base + k * 31000;
    assert.ok(await claimNextOperation(db.app, { workerId: "w-read", now: t, opId: id }), `attempt ${k + 1}`);
    F.ok(await completeOperation(db.app, id, { workerId: "w-read", now: t, outcome: { status: "outcome_unknown" } }));
  }
  assert.equal((await opRow(id)).state, "escalated");
  return id;
}
const opRow = async (id) => (await db.owner.query("SELECT * FROM booking.external_operations WHERE id = $1", [id])).rows[0];
const ready = async (opId, pool = db.app, worker = null) => (await pool.query("SELECT booking.recording_claim_ready($1, $2) AS r", [opId, worker])).rows[0].r;
const refusal = async (opId, worker = null) => (await db.owner.query("SELECT booking.recording_claim_refusal($1, $2, clock_timestamp()) AS r", [opId, worker])).rows[0].r;
const helperClaim = (s, worker = "w1") => claimNextOperation(db.app, { workerId: worker, now: Date.now(), intentId: s.c.id, opTypes: OCH, leaseMs: 10 * MIN });
const DIRECT = `UPDATE booking.external_operations SET state = 'in_flight', lease_worker_id = $2, lease_until = now() + interval '5 minutes',
  attempts = attempts + 1, dispatched_at = now(), updated_at = now() WHERE id = $1`;
const direct = (opId, worker = "w1", c = db.app) => c.query(DIRECT, [opId, worker]);
const audits = async (opId) => (await db.owner.query("SELECT * FROM booking.recording_claim_assessments WHERE operation_id = $1", [opId])).rows;
const assessments = async (opId) => (await db.owner.query("SELECT * FROM booking.recording_assessments WHERE operation_id = $1 ORDER BY seq", [opId])).rows;
async function waitForLockWaiters(n = 1, timeoutMs = 5000) {
  const t0 = Date.now();
  for (;;) {
    const r = await db.owner.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`);
    if (r.rows[0].n >= n) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`no lock waiter observed within ${timeoutMs} ms`);
    await sleep(10);
  }
}
const lockWaiters = async () => (await db.owner.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`)).rows[0].n;
async function appClient() { const c = new pg.Client({ connectionString: db.appUrl() }); c.on("error", () => {}); await c.connect(); return c; }
async function ownerTx(fn) {
  const c = await db.owner.connect();
  try { await c.query("BEGIN"); await c.query("SET LOCAL session_replication_role = replica"); return await fn(c); }
  finally { await c.query("ROLLBACK").catch(() => {}); c.release(); }
}
const errCode = (p) => p.then(() => "ok", (e) => `${e.code}:${String(e.message).split(":")[0]}`);

// ---- A-1: privileges, append-only, frozen seed, claim-audit binding ------------------------------------------------
test("A-1: no role writes the three 0012 tables; append-only even for the schema owner; the seed is frozen (owner INSERT included); claim audit binds exactly; grants", async () => {
  const s = await setup(); F.ok(await eligible(s));
  const a = (await assessments(s.opId))[0];
  for (const [who, pool] of [["app", db.app], ["admin", db.reconciler], ["report", report]]) {
    await assert.rejects(pool.query("INSERT INTO booking.recording_assessment_codes VALUES ('incomplete', 'ZZ_PROBE', 'list_absent_response')"), /permission denied/, who);
    await assert.rejects(pool.query("UPDATE booking.recording_assessments SET outcome = 'eligible'"), /permission denied/, who);
    await assert.rejects(pool.query("DELETE FROM booking.recording_claim_assessments"), /permission denied/, who);
    assert.ok((await pool.query("SELECT count(*) FROM booking.recording_assessments")).rows[0], `${who} SELECT`);
  }
  // owner: frozen seed (INSERT / UPDATE / DELETE / TRUNCATE), append-only assessments / audit
  await assert.rejects(db.owner.query("INSERT INTO booking.recording_assessment_codes VALUES ('incomplete', 'ZZ_PROBE', 'list_absent_response')"), /not allowed/);
  await assert.rejects(db.owner.query("UPDATE booking.recording_assessment_codes SET evidence_rule = 'identity_absent'"), /not allowed/);
  await assert.rejects(db.owner.query("DELETE FROM booking.recording_assessment_codes"), /not allowed/);
  await assert.rejects(db.owner.query("TRUNCATE booking.recording_assessment_codes CASCADE"), /not allowed/);
  await assert.rejects(db.owner.query("UPDATE booking.recording_assessments SET outcome = 'incomplete' WHERE id = $1", [a.id]), /not allowed/);
  await assert.rejects(db.owner.query("DELETE FROM booking.recording_assessments WHERE id = $1", [a.id]), /not allowed/);
  await assert.rejects(db.owner.query("TRUNCATE booking.recording_assessments CASCADE"), /not allowed/);
  // claim audit: owner INSERT is privileged but must bind an eligible assessment of THIS op, in_flight, same worker
  await assert.rejects(db.owner.query(`INSERT INTO booking.recording_claim_assessments VALUES ($1, $2, $3, 'w1', 0, now())`, [s.opId, s.c.id, a.id]),
    /RECORDING_CLAIM_AUDIT_BINDING/, "the op is not in_flight");
  const op = await helperClaim(s); assert.ok(op);
  await assert.rejects(db.owner.query("UPDATE booking.recording_claim_assessments SET worker = 'x'"), /not allowed/);
  await assert.rejects(db.owner.query("DELETE FROM booking.recording_claim_assessments"), /not allowed/);
  // function grants: record = app only; ready = app + admin; private helpers owner only; PUBLIC nothing
  const fns = (await db.owner.query(`SELECT p.proname, coalesce(array_to_string(p.proacl, ','), '') AS acl, p.prosecdef, p.provolatile, p.proconfig
      FROM pg_proc p WHERE p.pronamespace = 'booking'::regnamespace AND p.proname IN ('record_recording_assessment', 'recording_claim_ready',
      'recording_claim_refusal', 'recording_preflight_block', 'recording_identity_positive', 'recording_identity_refused_evidence_ok', 'recording_list_evidence_ok',
      'recording_claim_audit', 'recording_claim_fence', 'recording_assessments_guard', 'recording_claim_assessments_guard') ORDER BY 1`)).rows;
  assert.equal(fns.length, 11);
  for (const f of fns) {
    assert.doesNotMatch(f.acl, /(^|,)=X\//, `${f.proname}: no PUBLIC EXECUTE`);
    assert.deepEqual(f.proconfig, ["search_path=pg_catalog, booking"], `${f.proname}: fixed search_path`);
    assert.equal(f.provolatile, "v", `${f.proname}: VOLATILE`);
    assert.equal(f.prosecdef, !f.proname.endsWith("_guard"), `${f.proname}: security mode`);
    const app = /mv_booking_app=X/.test(f.acl), admin = /mv_booking_admin=X/.test(f.acl), rep = /mv_booking_report=X/.test(f.acl);
    assert.deepEqual([app, admin, rep], f.proname === "record_recording_assessment" ? [true, false, false]
      : f.proname === "recording_claim_ready" ? [true, true, false] : [false, false, false], f.proname);
  }
  await assert.rejects(report.query("SELECT booking.recording_claim_ready($1, NULL)", [s.opId]), /permission denied/);
  await assert.rejects(db.reconciler.query("SELECT booking.record_recording_assessment(NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)"), /permission denied/);
  await assert.rejects(db.app.query("SELECT booking.recording_preflight_block($1)", [s.opId]), /permission denied/);
  await assert.rejects(db.app.query("SELECT booking.recording_claim_refusal($1, 'w1', now())", [s.opId]), /permission denied/);
  const rls = (await db.owner.query(`SELECT relname, relrowsecurity FROM pg_class WHERE relnamespace = 'booking'::regnamespace
      AND relname IN ('recording_assessment_codes', 'recording_assessments', 'recording_claim_assessments')`)).rows;
  assert.ok(rls.length === 3 && rls.every((r) => r.relrowsecurity));
});

// ---- A-2 / addendum A+B: codes, nullability and seed probes ----------------------------------------------------------
test("A-2: worker-local codes are never persisted; seeded codes only under their outcome; eligible iff code NULL; READ_NOT_COMPLETED never for a conflict", async () => {
  const s = await setup();
  for (const code of ["CONFIG_REQUIRED", "PAYMENT_METHOD_UNSET", "CURRENCY_NOT_APPROVED", "IDENTITY_SNAPSHOT_SHAPE", "IDENTITY_ACCOUNT_REF_MISMATCH",
    "IDENTITY_CLIENT_LABEL_INVALID", "LIST_READ_SHAPE", "LIST_ACCOUNT_REF_MISMATCH", "LIST_REQUEST_NOT_CANONICAL", "IDENTITY_STALE", "LIST_OBSERVED_IN_FUTURE",
    "IDENTITY_NOW_INVALID", "POSITIVE_IDENTITY_REQUIRED", "COMPLETE_LIST_REQUIRED", "IDENTITY_CONTEXT_CHANGED", "UNEXPECTED_INPUT", "ZZ_ARBITRARY"]) {
    for (const outcome of ["identity_refused", "incomplete"]) {
      assert.deepEqual(await rec(s, { outcome, code, identityReadId: await idRead(s) }), { ok: false, error: "ASSESSMENT_CODE" }, `${outcome}/${code}`);
    }
  }
  const p = await parts(s);
  assert.deepEqual(await rec(s, { outcome: "eligible", code: "LIST_HTTP_STATUS", ...p }), { ok: false, error: "ASSESSMENT_CODE" });
  assert.deepEqual(await rec(s, { outcome: "incomplete", code: "IDENTITY_HTTP_STATUS", ...p }), { ok: false, error: "ASSESSMENT_CODE" }, "seeded code, wrong outcome");
  assert.deepEqual(await rec(s, { outcome: "conflict_marker", code: "MARKER_LOOKALIKE_CONFLICT", ...p }), { ok: false, error: "ASSESSMENT_CODE" });
  assert.deepEqual(await rec(s, { outcome: "conflict_marker", code: "READ_NOT_COMPLETED", ...p }), { ok: false, error: "ASSESSMENT_CODE" });
  assert.deepEqual(await rec(s, { outcome: "incomplete", code: null, ...p }), { ok: false, error: "ASSESSMENT_CODE" });
  assert.deepEqual(await rec(s, { outcome: "bogus", code: "X", ...p }), { ok: false, error: "ASSESSMENT_CODE" });
  assert.equal((await assessments(s.opId)).length, 0, "nothing persisted, nothing counted");
  // the seed: exactly the reviewed pairs; READ_NOT_COMPLETED only for incomplete / identity_refused; one closed rule per pair
  const seed = (await db.app.query("SELECT outcome, code, evidence_rule FROM booking.recording_assessment_codes ORDER BY 1, 2")).rows;
  assert.equal(seed.length, 51);
  assert.deepEqual(seed.filter((r) => r.code === "READ_NOT_COMPLETED").map((r) => `${r.outcome}:${r.evidence_rule}`),
    ["identity_refused:identity_absent_escalated", "incomplete:list_absent_escalated"]);
  assert.deepEqual(seed.filter((r) => r.outcome.startsWith("conflict_")).map((r) => r.code).sort(),
    ["MARKER_LOOKALIKE_CONFLICT", "PRIOR_RECORDING_MARKER_PRESENT", "SAME_AMOUNT_PAID_UNMARKED_CONFLICT"]);
  assert.ok(!seed.some((r) => r.outcome === "eligible"));
});

test("A-2b (addendum B): constraint probes with triggers bypassed — NULL never satisfies a safety CHECK; seed rule / outcome / code CHECKs; per-outcome shape", async () => {
  const s = await setup(); F.ok(await eligible(s));
  const a = (await assessments(s.opId))[0];
  const cols = "id, operation_id, intent_id, phase, epoch, outcome, code, identity_read_op, list_read_op, identity_evidence, list_evidence, intent_version, worker, module_version, cfg, client_label, account_ref, recorded_at";
  const base = { ...a, id: null };
  const probe = async (o) => ownerTx(async (c) => {
    const r = { ...base, ...o, id: (await c.query("SELECT gen_random_uuid() AS id")).rows[0].id };
    try {
      await c.query(`INSERT INTO booking.recording_assessments (${cols}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [r.id, r.operation_id, r.intent_id, r.phase, r.epoch, r.outcome, r.code, r.identity_read_op, r.list_read_op, r.identity_evidence, r.list_evidence,
          r.intent_version, r.worker, r.module_version, r.cfg, r.client_label, r.account_ref, r.recorded_at]);
      return "inserted";
    } catch (e) { return e.constraint || e.code; }
  });
  // reads are UNIQUE: every probe reuses them, so the uniqueness constraint answers first unless a CHECK / NOT NULL fails before it
  assert.equal(await probe({}), "recording_assessments_identity_read_key");
  for (const [o, want] of [
    [{ outcome: null }, "23502"], [{ phase: null }, "23502"], [{ epoch: null }, "23502"], [{ worker: null }, "23502"], [{ cfg: null }, "23502"],
    [{ intent_version: null }, "23502"], [{ module_version: null }, "23502"], [{ client_label: null }, "23502"], [{ recorded_at: null }, "23502"],
    [{ identity_read_op: null }, "23502"], [{ phase: "audit" }, "recording_assessments_phase_check"], [{ phase: "release_review" }, "recording_assessments_hold_check"],
    [{ epoch: -1 }, "recording_assessments_epoch_check"],
    [{ code: "PRIOR_RECORDING_MARKER_PRESENT" }, "recording_assessments_code_check"], [{ outcome: "incomplete", code: null }, "recording_assessments_code_check"],
    [{ list_evidence: null }, "recording_assessments_shape_check"], [{ list_read_op: null }, "recording_assessments_shape_check"],
    [{ outcome: "incomplete", code: "LIST_HTTP_STATUS" }, "recording_assessments_shape_check"],
    [{ outcome: "identity_refused", code: "IDENTITY_FAIL_ENVELOPE", list_evidence: null }, "recording_assessments_shape_check"],
    [{ module_version: "offline-charge-proof-v2" }, "recording_assessments_module_check"], [{ client_label: "bad label" }, "recording_assessments_label_check"],
    [{ cfg: "[]" }, "recording_assessments_cfg_check"], [{ worker: " " }, "recording_assessments_worker_check"],
  ]) assert.equal(await probe(o), want, JSON.stringify(o));
    const unused = await idRead(s);
  // FK probe with triggers ACTIVE (replica mode, superuser-only, also disables RI checks): the schema owner passes the INSERT guard, the composite FK refuses
  const fk = await ownerTx(async (c) => {
    await c.query("SET LOCAL session_replication_role = origin");
    try { await c.query(`INSERT INTO booking.recording_assessments (${cols}) SELECT gen_random_uuid(), operation_id, intent_id, phase, epoch, 'identity_refused', 'ZZ_NOT_SEEDED',
        $2, NULL, NULL, NULL, intent_version, worker, module_version, cfg, client_label, account_ref, recorded_at FROM booking.recording_assessments WHERE id = $1`, [a.id, unused]); return "inserted"; }
    catch (e) { return e.constraint || e.code; }
  });
  assert.equal(fk, "recording_assessments_code_fk", "an unseeded (outcome, code) pair is refused by the composite FK (privileged owner INSERT)");
  // seed table CHECKs (triggers bypassed): NULL / unknown rule / eligible outcome / bad code
  const seedProbe = (o, c, r) => ownerTx(async (k) => { try { await k.query("INSERT INTO booking.recording_assessment_codes VALUES ($1, $2, $3)", [o, c, r]); return "inserted"; } catch (e) { return e.constraint || e.code; } });
  assert.equal(await seedProbe("incomplete", "ZZ_PROBE", null), "23502");
  assert.equal(await seedProbe("incomplete", "ZZ_PROBE", "any"), "recording_assessment_codes_rule_check");
  assert.equal(await seedProbe("eligible", "ZZ_PROBE", "list_present"), "recording_assessment_codes_outcome_check");
  assert.equal(await seedProbe(null, "ZZ_PROBE", "list_present"), "23502");
  assert.equal(await seedProbe("incomplete", "zz", "list_present"), "recording_assessment_codes_code_check");
  assert.equal(await seedProbe("incomplete", "LIST_HTTP_STATUS", "list_present"), "recording_assessment_codes_pkey", "one closed rule per pair (no duplicate PK rows)");
});

// ---- A-3 / addendum A: identity evidence rules and re-derivation -----------------------------------------------------
test("A-3: real refused identity observations are retained and RE-DERIVED (found_active mismatch, cancelled, not_found); no fabricated positive; evidence-less codes stay TRUST", async () => {
  // found_active mismatch with real evidence: retained only if the named field really differs
  for (const [code, o] of [["IDENTITY_TOTAL_MISMATCH", { totalMinor: 1 }], ["IDENTITY_REF_MISMATCH", { bookingRef: "MV-ZZZZZZ" }],
    ["IDENTITY_LISTING_MISMATCH", { listingId: 1 }], ["IDENTITY_ARRIVAL_MISMATCH", { from: "2031-01-01" }], ["IDENTITY_DEPARTURE_MISMATCH", { to: "2031-01-09" }],
    ["IDENTITY_CURRENCY_MISMATCH", { currency: "USD" }], ["IDENTITY_CHANNEL_MISMATCH", { channelId: 2005 }],
    ["IDENTITY_RESERVATION_ID_MISMATCH", { reservationId: "1" }], ["IDENTITY_STATUS_NOT_ACTIVE", { status: "modified" }]]) {
    const s = await setup();
    const r1 = await idRead(s); const e1 = await idEv(s, r1, F.identityObserved(s.f, o));
    const okRow = await rec(s, { outcome: "identity_refused", code, identityReadId: r1, identityEvidenceId: e1 });
    assert.equal(okRow.ok, true, `${code}: ${okRow.error}`);
    // the same code against a MATCHING observation is refused: the DB re-derives the mismatch
    const r2 = await idRead(s); const e2 = await idEv(s, r2);
    assert.deepEqual(await rec(s, { outcome: "identity_refused", code, identityReadId: r2, identityEvidenceId: e2 }), { ok: false, error: "ASSESSMENT_EVIDENCE_MISMATCH" }, code);
    // and that mismatching observation can never serve as positive identity for eligible / incomplete
    const r3 = await idRead(s); const e3 = await idEv(s, r3, F.identityObserved(s.f, o));
    const l3 = await listRead(s); const le3 = await listEv(s, l3);
    assert.deepEqual(await rec(s, { outcome: "eligible", identityReadId: r3, identityEvidenceId: e3, listReadId: l3, listEvidenceId: le3 }),
      { ok: false, error: "ASSESSMENT_EVIDENCE_MISMATCH" }, `${code}: never positive`);
  }
  const s = await setup();
  // a mismatch of ANOTHER field does not satisfy this code
  const rA = await idRead(s); const eA = await idEv(s, rA, F.identityObserved(s.f, { totalMinor: 1 }));
  assert.deepEqual(await rec(s, { outcome: "identity_refused", code: "IDENTITY_REF_MISMATCH", identityReadId: rA, identityEvidenceId: eA }), { ok: false, error: "ASSESSMENT_EVIDENCE_MISMATCH" });
  // cancelled observation for STATUS_NOT_ACTIVE; not_found observation only for HTTP_STATUS
  const rC = await idRead(s); const eC = await idEv(s, rC, F.identityObserved(s.f, { status: "cancelled" }), "cancelled");
  F.ok(await rec(s, { outcome: "identity_refused", code: "IDENTITY_STATUS_NOT_ACTIVE", identityReadId: rC, identityEvidenceId: eC }));
  const s2 = await setup();
  const nf = { reservationId: s2.f.hostaway_reservation_id, executorAccountRef: F.PREFLIGHT_ACCOUNT_REF, clientSnapshotId: F.PREFLIGHT_CLIENT_LABEL };
  const rN = await idRead(s2); const eN = await idEv(s2, rN, nf, "not_found");
  assert.deepEqual(await rec(s2, { outcome: "identity_refused", code: "IDENTITY_TOTAL_MISMATCH", identityReadId: rN, identityEvidenceId: eN }), { ok: false, error: "ASSESSMENT_EVIDENCE_MISMATCH" });
  F.ok(await rec(s2, { outcome: "identity_refused", code: "IDENTITY_HTTP_STATUS", identityReadId: rN, identityEvidenceId: eN }));
  const rF = await idRead(s2); const eF = await idEv(s2, rF);
  assert.deepEqual(await rec(s2, { outcome: "identity_refused", code: "IDENTITY_HTTP_STATUS", identityReadId: rF, identityEvidenceId: eF }), { ok: false, error: "ASSESSMENT_EVIDENCE_MISMATCH" });
  // evidence-absent codes: evidence on the read must be cited (not hidden) and may not be cited for an absent-only rule
  const rX = await idRead(s2); await idEv(s2, rX);
  assert.deepEqual(await rec(s2, { outcome: "identity_refused", code: "IDENTITY_FAIL_ENVELOPE", identityReadId: rX }), { ok: false, error: "ASSESSMENT_EVIDENCE_PRESENT" });
  assert.deepEqual(await rec(s2, { outcome: "identity_refused", code: "IDENTITY_TOTAL_MISMATCH", identityReadId: rX }), { ok: false, error: "ASSESSMENT_EVIDENCE_PRESENT" });
  const rY = await idRead(s2); const eY = await idEv(s2, rY);
  assert.deepEqual(await rec(s2, { outcome: "identity_refused", code: "IDENTITY_FAIL_ENVELOPE", identityReadId: rY, identityEvidenceId: eY }), { ok: false, error: "ASSESSMENT_INPUT" });
  // TRUST: an evidence-less mismatch code is accepted on a succeeded read (the allowlist is not proof of provider contents)
  const s3 = await setup();
  F.ok(await rec(s3, { outcome: "identity_refused", code: "IDENTITY_REF_MISMATCH", identityReadId: await idRead(s3) }));
  // READ_NOT_COMPLETED: only with the corresponding ESCALATED read and no evidence
  const s4 = await setup();
  assert.deepEqual(await rec(s4, { outcome: "identity_refused", code: "READ_NOT_COMPLETED", identityReadId: await idRead(s4) }), { ok: false, error: "ASSESSMENT_READ_BINDING" });
  const esc = await escalatedRead(s4, "hostaway.retrieve_reservation");
  assert.deepEqual(await rec(s4, { outcome: "identity_refused", code: "IDENTITY_FAIL_ENVELOPE", identityReadId: esc }), { ok: false, error: "ASSESSMENT_READ_BINDING" });
  F.ok(await rec(s4, { outcome: "identity_refused", code: "READ_NOT_COMPLETED", identityReadId: esc }));
  const s5 = await setup();
  const escL = await escalatedRead(s5, "hostaway.list_offline_charges");
  F.ok(await rec(s5, { outcome: "incomplete", code: "READ_NOT_COMPLETED", ...(await positive(s5)), listReadId: escL }));
  assert.deepEqual(await rec(s5, { outcome: "incomplete", code: "READ_NOT_COMPLETED", ...(await positive(s5)), listReadId: await listRead(s5) }), { ok: false, error: "ASSESSMENT_READ_BINDING" });
});

// ---- A-4: list shape ------------------------------------------------------------------------------------------------
test("A-4: preflight list shape — ranges, ids / count, duplicates, rowCount, labels, complete, requestLimit, outcome-count relation; incomplete forbids list evidence; D7 positive identity", async () => {
  const s = await setup();
  const bad = [{ matchingChargeCount: 501, matchingChargeIds: Array.from({ length: 501 }, (_, k) => String(800000 + k)), rowCount: 501 },
    { lookalikeCount: -1 }, { lookalikeCount: 1.5 }, { rowCount: 501 }, { sameAmountPaidCount: "0" },
    { complete: false }, { requestLimit: 100 }, { readCount: 2 }, { executorAccountRef: "acct-other" }, { clientSnapshotId: "other-client" },
    { lookalikeCount: 1, rowCount: 1 }, { sameAmountPaidCount: 1, rowCount: 1 }, { matchingChargeCount: 1, matchingChargeIds: ["7"], rowCount: 1 },
    { matchingChargeCount: 2, matchingChargeIds: ["7", "7"], rowCount: 2 }, { matchingChargeCount: 1, matchingChargeIds: ["07"], rowCount: 1 },
    { lookalikeCount: 1, rowCount: 0 }, { marker: "x" }];
  for (const o of bad) {
    const p = await parts(s, { list: F.preflightListObserved(o) });
    assert.deepEqual(await rec(s, { outcome: "eligible", ...p }), { ok: false, error: "ASSESSMENT_EVIDENCE_MISMATCH" }, JSON.stringify(o).slice(0, 80));
  }
  const missing = F.preflightListObserved(); delete missing.rowCount;
  assert.deepEqual(await rec(s, { outcome: "eligible", ...(await parts(s, { list: missing })) }), { ok: false, error: "ASSESSMENT_EVIDENCE_MISMATCH" });
  // duplicates / non-canonical ids refuse even where a positive count is valid (conflict_marker)
  for (const ids of [["7", "7"], ["07"], [7]]) {
    const pl = await parts(s, { list: F.preflightListObserved({ matchingChargeCount: ids.length, matchingChargeIds: ids, rowCount: ids.length }) });
    assert.deepEqual(await rec(s, { outcome: "conflict_marker", code: "PRIOR_RECORDING_MARKER_PRESENT", ...pl }), { ok: false, error: "ASSESSMENT_EVIDENCE_MISMATCH" }, JSON.stringify(ids));
  }
  // ids length != count never even becomes evidence (0003 validate_evidence)
  const lr = await listRead(s);
  await assert.rejects(recordProviderEvidence(db.app, { readOpId: lr, kind: "hostaway_offline_charges", externalRef: s.f.hostaway_reservation_id, status: "listed",
    observed: F.preflightListObserved({ matchingChargeCount: 2, matchingChargeIds: ["7"] }) }), /offline charge evidence must be/);
  // conflict precedence mirrors the pure module: marker > lookalike > same amount
  assert.deepEqual(await rec(s, { outcome: "conflict_lookalike", code: "MARKER_LOOKALIKE_CONFLICT", ...(await parts(s, { list: conflictList() })) }), { ok: false, error: "ASSESSMENT_EVIDENCE_MISMATCH" });
  assert.deepEqual(await rec(s, { outcome: "conflict_same_amount", code: "SAME_AMOUNT_PAID_UNMARKED_CONFLICT",
    ...(await parts(s, { list: F.preflightListObserved({ lookalikeCount: 1, sameAmountPaidCount: 1, rowCount: 2 }) })) }), { ok: false, error: "ASSESSMENT_EVIDENCE_MISMATCH" });
  // incomplete: list read with evidence cannot count as incomplete; identity must be positive (D7)
  const p = await parts(s);
  assert.deepEqual(await rec(s, { outcome: "incomplete", code: "LIST_COUNT_INVALID", identityReadId: p.identityReadId, identityEvidenceId: p.identityEvidenceId, listReadId: p.listReadId }),
    { ok: false, error: "ASSESSMENT_EVIDENCE_PRESENT" });
  const neg = await idRead(s); const negEv = await idEv(s, neg, F.identityObserved(s.f, { totalMinor: 1 }));
  assert.deepEqual(await rec(s, { outcome: "incomplete", code: "LIST_COUNT_INVALID", identityReadId: neg, identityEvidenceId: negEv, listReadId: await listRead(s) }),
    { ok: false, error: "ASSESSMENT_EVIDENCE_MISMATCH" }, "D7: incomplete requires a positive identity");
  assert.deepEqual(await rec(s, { outcome: "incomplete", code: "LIST_COUNT_INVALID", identityReadId: await idRead(s), listReadId: await listRead(s) }), { ok: false, error: "ASSESSMENT_INPUT" });
  assert.equal((await assessments(s.opId)).length, 0);
});

// ---- A-5: config snapshot -------------------------------------------------------------------------------------------
test("A-5: p_cfg exact keys / types / bounds and cross-checks; paymentMethod required from the approved set, no default; module allowlist; labels", async () => {
  const s = await setup();
  const cfg = F.preflightConfig(s.f);
  const drop = (k) => { const c = { ...cfg }; delete c[k]; return c; };
  for (const c of [drop("paymentMethod"), drop("refFieldId"), { ...cfg, extra: 1 }, { ...cfg, channelId: "2000" }, { ...cfg, channelId: 2005 },
    { ...cfg, paymentMethod: null }, { ...cfg, paymentMethod: "cash" }, { ...cfg, paymentMethod: "" }, { ...cfg, listingId: Number(s.f.listing_id) + 1 },
    { ...cfg, listingId: String(s.f.listing_id) }, { ...cfg, currency: s.f.currency === "USD" ? "MXN" : "USD" }, { ...cfg, accountRef: "acct-other" },
    { ...cfg, refFieldId: 0 }, { ...cfg, refFieldId: 1.5 }, { ...cfg, refFieldId: 2147483648 }, { ...cfg, refFieldId: "123" }]) {
    assert.deepEqual(await eligible(s, { config: c }), { ok: false, error: "ASSESSMENT_CONFIG" }, JSON.stringify(c));
  }
  assert.deepEqual(await eligible(s, { moduleVersion: "offline-charge-proof-v2" }), { ok: false, error: "ASSESSMENT_INPUT" });
  assert.deepEqual(await eligible(s, { clientLabel: "bad label" }), { ok: false, error: "ASSESSMENT_INPUT" });
  assert.deepEqual(await eligible(s, { accountRef: "acct-other", config: { ...cfg, accountRef: "acct-other" } }), { ok: false, error: "ASSESSMENT_EVIDENCE_MISMATCH" },
    "cfg accountRef must also equal the evidence labels");
  F.ok(await eligible(s, { config: { ...cfg, paymentMethod: "other" } }), "both approved values accepted (fixture; no owner choice implied)");
});

// ---- A-6: read binding ----------------------------------------------------------------------------------------------
test("A-6: reads are bound to intent / type / canonical payload / terminal state and counted once ever (both columns); dashboard / foreign evidence refused", async () => {
  const s = await setup(); const o = await setup();
  const p = await parts(s);
  F.ok(await rec(s, { outcome: "eligible", ...p }));
  const q = await parts(s);
  assert.deepEqual(await rec(s, { outcome: "eligible", ...q, identityReadId: p.identityReadId, identityEvidenceId: p.identityEvidenceId }), { ok: false, error: "ASSESSMENT_READ_REUSED" });
  assert.deepEqual(await rec(s, { outcome: "eligible", ...q, listReadId: p.listReadId, listEvidenceId: p.listEvidenceId }), { ok: false, error: "ASSESSMENT_READ_REUSED" });
  // foreign intent's reads / evidence
  const op2 = await parts(o);
  assert.deepEqual(await rec(s, { outcome: "eligible", ...op2 }), { ok: false, error: "ASSESSMENT_READ_BINDING" });
  // wrong read types (swapped)
  const r = await parts(s);
  assert.deepEqual(await rec(s, { outcome: "eligible", identityReadId: r.listReadId, identityEvidenceId: r.listEvidenceId, listReadId: r.identityReadId, listEvidenceId: r.identityEvidenceId }),
    { ok: false, error: "ASSESSMENT_READ_BINDING" });
  // payload for another reservation id
  const otherRid = await F.completedRead(db.app, s.c.id, "hostaway.retrieve_reservation", "424242", now());
  const otherEv = await F.readEvidenceOf(db.app, otherRid, "hostaway_reservation", "424242", "found_active", F.identityObserved(s.f, { reservationId: "424242" }));
  assert.deepEqual(await rec(s, { outcome: "eligible", ...(await parts(s)), identityReadId: otherRid, identityEvidenceId: otherEv }), { ok: false, error: "ASSESSMENT_READ_BINDING" });
  // evidence of another read of the same intent; dashboard evidence
  const t = await parts(s); const u = await parts(s);
  assert.deepEqual(await rec(s, { outcome: "eligible", ...t, identityEvidenceId: u.identityEvidenceId }), { ok: false, error: "ASSESSMENT_EVIDENCE_MISMATCH" });
  const dash = F.ok(await adminRecordEvidence(db.reconciler, { intentId: s.c.id, kind: "hostaway_reservation", externalRef: s.f.hostaway_reservation_id, status: "found_active",
    observed: F.identityObserved(s.f), observedAt: Date.now() - 1000, attestedBy: "owner", reference: "dashboard-probe" })).id;
  assert.deepEqual(await rec(s, { outcome: "eligible", ...(await parts(s)), identityEvidenceId: dash }), { ok: false, error: "ASSESSMENT_EVIDENCE_MISMATCH" });
  // a pending (non-terminal) read
  const pend = await requestRead(db.app, s.c.id, "hostaway.retrieve_reservation", s.f.hostaway_reservation_id, { now: now() });
  assert.deepEqual(await rec(s, { outcome: "identity_refused", code: "IDENTITY_FAIL_ENVELOPE", identityReadId: pend }), { ok: false, error: "ASSESSMENT_READ_BINDING" });
  // a read requested BEFORE the recording row existed (caller-time floor, TRUST)
  const early = await F.completedRead(db.app, s.c.id, "hostaway.retrieve_reservation", s.f.hostaway_reservation_id, F.at(1));
  assert.deepEqual(await rec(s, { outcome: "identity_refused", code: "IDENTITY_FAIL_ENVELOPE", identityReadId: early }), { ok: false, error: "ASSESSMENT_FLOOR" });
  assert.equal((await assessments(s.opId)).length, 1);
});

test("A-6b (addendum A): late REAL evidence on an already-counted evidence-less read never lets that read qualify a new assessment; the counted row stays", async () => {
  const s = await setup();
  const id = await positive(s); const lr = await listRead(s);
  F.ok(await rec(s, { outcome: "incomplete", code: "LIST_FAIL_ENVELOPE", ...id, listReadId: lr }));
  const late = await listEv(s, lr);                                                               // the evidence writer itself is unaware of assessments
  assert.deepEqual(await rec(s, { outcome: "eligible", ...(await positive(s)), listReadId: lr, listEvidenceId: late }), { ok: false, error: "ASSESSMENT_READ_REUSED" });
  const rows = await assessments(s.opId);
  assert.deepEqual(rows.map((x) => [x.outcome, x.code, x.list_evidence]), [["incomplete", "LIST_FAIL_ENVELOPE", null]]);
  assert.equal(await refusal(s.opId), "LATEST_NOT_ELIGIBLE");
});

// ---- A-7 / A-8: freshness and floors --------------------------------------------------------------------------------
test("A-7: freshness at the DB decision instant — evidence observed_at and, for evidence-less refusals, the read's terminal caller time; no future", async () => {
  const s = await setup();
  assert.deepEqual(await rec(s, { outcome: "eligible", ...(await parts(s, { t: Date.now() - 2 * MIN - 2000 })) }), { ok: false, error: "ASSESSMENT_STALE" });
  assert.deepEqual(await rec(s, { outcome: "eligible", ...(await parts(s, { t: Date.now() + 5000 })) }), { ok: false, error: "ASSESSMENT_STALE" });
  // each evidence row is judged on its own: a stale identity with a fresh list, and the reverse
  const staleId = await positive(s, Date.now() - 2 * MIN - 2000); const freshL = await listRead(s); const freshLe = await listEv(s, freshL);
  assert.deepEqual(await rec(s, { outcome: "eligible", ...staleId, listReadId: freshL, listEvidenceId: freshLe }), { ok: false, error: "ASSESSMENT_STALE" }, "stale identity only");
  const freshId = await positive(s); const staleL = await listRead(s, Date.now() - 2 * MIN - 2000); const staleLe = await listEv(s, staleL);
  assert.deepEqual(await rec(s, { outcome: "eligible", ...freshId, listReadId: staleL, listEvidenceId: staleLe }), { ok: false, error: "ASSESSMENT_STALE" }, "stale list only");
  F.ok(await rec(s, { outcome: "eligible", ...(await parts(s, { t: Date.now() - 2 * MIN + 5000 })) }), "inside the inclusive 2-minute window");
  const s2 = await setup();
  assert.deepEqual(await rec(s2, { outcome: "identity_refused", code: "IDENTITY_FAIL_ENVELOPE", identityReadId: await idRead(s2, Date.now() - 3 * MIN) }), { ok: false, error: "ASSESSMENT_STALE" });
  assert.deepEqual(await rec(s2, { outcome: "identity_refused", code: "IDENTITY_FAIL_ENVELOPE", identityReadId: await idRead(s2, Date.now() + 5000) }), { ok: false, error: "ASSESSMENT_STALE" });
  assert.deepEqual(await rec(s2, { outcome: "incomplete", code: "LIST_FAIL_ENVELOPE", ...(await positive(s2)), listReadId: await listRead(s2, Date.now() - 3 * MIN) }), { ok: false, error: "ASSESSMENT_STALE" });
  assert.equal((await assessments(s2.opId)).length, 0);
});

test("A-8 (addendum C): DB-stamped floors — evidence written before the current version's transition is refused; a missing transition row refuses; version must match", async () => {
  // evidence created BEFORE the capture transition (and before the recording row existed)
  const r = await F.reserved(db.app, stay());
  const f0 = await F.preflightFacts(db.app, r.id);
  const t = now();
  const ir = await F.completedRead(db.app, r.id, "hostaway.retrieve_reservation", f0.hostaway_reservation_id, t);
  const lr = await F.completedRead(db.app, r.id, "hostaway.list_offline_charges", f0.hostaway_reservation_id, t);
  const op = await F.claimOp(db.app, r.id, "stripe.capture_payment_intent", F.at(8));
  F.ok(await completeOperation(db.app, op.id, { workerId: "w1", now: F.at(8), outcome: { status: "succeeded", resultRef: r.piId } }));
  // evidence written after the reads but BEFORE the capture transition commits
  const s = { c: r, f: f0 };
  const ie = await idEv(s, ir); const le = await listEv(s, lr);
  F.ok(await applyEvent(db.app, r.id, { type: "CAPTURE_SUCCEEDED", id: `evt_cap_${r.piId}`, amountMinor: 576000, currency: "mxn" }, { now: F.at(8), actor: "webhook" }));
  await lease(r.id);
  const s1 = { c: r, opId: await F.initialRecordingId(db.app, r.id), f: await F.preflightFacts(db.app, r.id) };
  assert.deepEqual(await rec(s1, { outcome: "eligible", identityReadId: ir, identityEvidenceId: ie, listReadId: lr, listEvidenceId: le }), { ok: false, error: "ASSESSMENT_FLOOR" });
  assert.deepEqual(await rec(s1, { outcome: "eligible", ...(await parts(s1)), expectedVersion: s1.f.version - 1 }), { ok: false, error: "ASSESSMENT_VERSION_CHANGED" });
  F.ok(await eligible(s1), "fresh evidence after the transition qualifies");
  // TEST-ONLY state fault (owner, triggers bypassed): a version with no transition row -> the floor is missing -> refused; the old eligible no longer fences open
  await F.ownerManagedHistory(db.owner, "UPDATE booking.intents SET version = version + 1 WHERE id = $1", [r.id]);
  const s2 = { ...s1, f: await F.preflightFacts(db.app, r.id) };
  assert.deepEqual(await eligible(s2), { ok: false, error: "ASSESSMENT_FLOOR" });
  assert.equal(await refusal(s1.opId), "VERSION_CHANGED");
  assert.equal(await helperClaim(s1), null);
  await assert.rejects(direct(s1.opId), /RECORDING_CLAIM_FENCED: preflight assessment VERSION_CHANGED/);
});

// ---- A-9 .. A-12: the latch -----------------------------------------------------------------------------------------
test("A-9 (R1): conflict then fresh eligible — the later preflight is refused; the fence and the mirror block regardless; INJECTED newer eligible history is still blocked", async () => {
  const s = await setup();
  F.ok(await eligible(s));
  assert.equal(await ready(s.opId), true);
  F.ok(await conflict(s));
  assert.deepEqual(await eligible(s), { ok: false, error: "ASSESSMENT_EPOCH_CONFLICTED" });
  assert.deepEqual(await counted(s), { ok: false, error: "ASSESSMENT_EPOCH_CONFLICTED" }, "no further preflight of any outcome");
  assert.equal(await ready(s.opId), false); assert.equal(await ready(s.opId, db.reconciler), false);
  assert.equal(await refusal(s.opId, "w1"), "PREFLIGHT_CONFLICT_LATCHED");
  assert.equal(await helperClaim(s), null);
  await assert.rejects(direct(s.opId), /RECORDING_CLAIM_FENCED: preflight assessment PREFLIGHT_CONFLICT_LATCHED/);
  // TEST-ONLY injection (schema owner, privileged INSERT path): a NEWER eligible row with higher seq. A zero-match list never erases history.
  const last = (await assessments(s.opId)).find((x) => x.outcome === "eligible");
  const p = await parts(s);
  await db.owner.query(`INSERT INTO booking.recording_assessments (id, operation_id, intent_id, phase, epoch, outcome, code, identity_read_op, list_read_op, identity_evidence,
      list_evidence, intent_version, worker, module_version, cfg, client_label, account_ref, recorded_at)
    VALUES (gen_random_uuid(), $1, $2, 'preflight', 0, 'eligible', NULL, $3, $4, $5, $6, $7, 'w1', $8, $9, $10, $11, clock_timestamp())`,
    [s.opId, s.c.id, p.identityReadId, p.listReadId, p.identityEvidenceId, p.listEvidenceId, last.intent_version, last.module_version, last.cfg, last.client_label, last.account_ref]);
  const rows = await assessments(s.opId);
  assert.deepEqual(rows.map((x) => x.outcome), ["eligible", "conflict_marker", "eligible"], "latest row is eligible");
  assert.equal(await ready(s.opId), false);
  assert.equal(await helperClaim(s), null);
  await assert.rejects(direct(s.opId), /PREFLIGHT_CONFLICT_LATCHED/);
  assert.equal((await opRow(s.opId)).state, "pending"); assert.equal((await audits(s.opId)).length, 0);
  // each conflict outcome latches
  for (const [outcome, code, list] of [["conflict_lookalike", "MARKER_LOOKALIKE_CONFLICT", F.preflightListObserved({ lookalikeCount: 1, rowCount: 1 })],
    ["conflict_same_amount", "SAME_AMOUNT_PAID_UNMARKED_CONFLICT", F.preflightListObserved({ sameAmountPaidCount: 2, rowCount: 3 })]]) {
    const x = await setup();
    F.ok(await rec(x, { outcome, code, ...(await parts(x, { list })) }));
    assert.deepEqual(await eligible(x), { ok: false, error: "ASSESSMENT_EPOCH_CONFLICTED" }, outcome);
    assert.equal(await refusal(x.opId), "PREFLIGHT_CONFLICT_LATCHED");
  }
});

test("A-10 (R1): concurrent assessments of one op serialize on the advisory key; the second sees the first's committed conflict on a fresh post-wait snapshot (both orders, observed waits)", async () => {
  for (const order of ["conflict-first", "eligible-first"]) {
    const s = await setup();
    const pc = await parts(s, { list: conflictList() }); const pe = await parts(s);
    const args = (o, p) => [s.opId, "w1", o.outcome, o.code ?? null, p.identityReadId, p.listReadId, p.identityEvidenceId, p.listEvidenceId, s.f.version,
      F.PROOF_MODULE_VERSION, F.PREFLIGHT_CLIENT_LABEL, F.PREFLIGHT_ACCOUNT_REF, JSON.stringify(F.preflightConfig(s.f))];
    const SQL = "SELECT booking.record_recording_assessment($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) AS id";
    const first = order === "conflict-first" ? args({ outcome: "conflict_marker", code: "PRIOR_RECORDING_MARKER_PRESENT" }, pc) : args({ outcome: "eligible" }, pe);
    const second = order === "conflict-first" ? args({ outcome: "eligible" }, pe) : args({ outcome: "conflict_marker", code: "PRIOR_RECORDING_MARKER_PRESENT" }, pc);
    const k1 = await appClient(); const k2 = await appClient();
    try {
      await k1.query("BEGIN"); await k1.query(SQL, first);
      const p2 = errCode(k2.query(SQL, second));
      await waitForLockWaiters(1);
      await k1.query("COMMIT");
      const r2 = await p2;
      if (order === "conflict-first") assert.equal(r2, "23514:ASSESSMENT_EPOCH_CONFLICTED", "the waiting eligible sees the committed conflict");
      else assert.equal(r2, "ok", "a conflict after an eligible is recorded and latches");
    } finally { await k1.end(); await k2.end(); }
    assert.equal(await refusal(s.opId), "PREFLIGHT_CONFLICT_LATCHED", order);
    assert.equal(await helperClaim(s), null);
    const seqs = (await assessments(s.opId)).map((x) => Number(x.seq));
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), "seq allocated in serialization order");
  }
  // two eligible writers: both serialize and succeed; the latest qualifies
  const s = await setup();
  const [a, b] = await Promise.all([eligible(s), eligible(s)]);
  assert.ok(a.ok && b.ok);
  assert.equal(await ready(s.opId), true);
});

test("A-11 (R1, addendum E): no opener exists in 0012 — a committed conflict blocks with no hold; a rolled-back / killed-before-commit conflict leaves nothing; a conflict committed before its connection dies still latches", async () => {
  // rolled back: nothing recorded, an eligible later qualifies
  const s = await setup();
  const k = await appClient();
  const pc = await parts(s, { list: conflictList() });
  try {
    await k.query("BEGIN");
    await k.query("SELECT booking.record_recording_assessment($1, 'w1', 'conflict_marker', 'PRIOR_RECORDING_MARKER_PRESENT', $2, $3, $4, $5, $6, $7, $8, $9, $10) AS id",
      [s.opId, pc.identityReadId, pc.listReadId, pc.identityEvidenceId, pc.listEvidenceId, s.f.version, F.PROOF_MODULE_VERSION, F.PREFLIGHT_CLIENT_LABEL, F.PREFLIGHT_ACCOUNT_REF,
        JSON.stringify(F.preflightConfig(s.f))]);
    const pid = (await k.query("SELECT pg_backend_pid() AS p")).rows[0].p;
    await db.owner.query("SELECT pg_terminate_backend($1)", [pid]);                                     // dies before COMMIT
  } catch { /* the killed client */ } finally { await k.end().catch(() => {}); }
  await sleep(100);
  assert.equal((await assessments(s.opId)).length, 0, "killed before commit: no row");
  F.ok(await eligible(s)); assert.equal(await ready(s.opId), true);
  // committed, then its connection dies: the conflict stays and blocks (no hold, no opener)
  const s2 = await setup();
  const k2 = await appClient();
  const p2 = await parts(s2, { list: conflictList() });
  await k2.query("SELECT booking.record_recording_assessment($1, 'w1', 'conflict_marker', 'PRIOR_RECORDING_MARKER_PRESENT', $2, $3, $4, $5, $6, $7, $8, $9, $10) AS id",
    [s2.opId, p2.identityReadId, p2.listReadId, p2.identityEvidenceId, p2.listEvidenceId, s2.f.version, F.PROOF_MODULE_VERSION, F.PREFLIGHT_CLIENT_LABEL, F.PREFLIGHT_ACCOUNT_REF,
      JSON.stringify(F.preflightConfig(s2.f))]);
  await db.owner.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = 'test_app' AND pid = $1", [k2.processID]).catch(() => {});
  await k2.end().catch(() => {});
  assert.equal((await db.owner.query("SELECT count(*)::int AS n FROM booking.recording_holds WHERE operation_id = $1", [s2.opId])).rows[0].n, 0, "no hold in 0012");
  assert.equal(await refusal(s2.opId), "PREFLIGHT_CONFLICT_LATCHED");
  assert.deepEqual(await eligible(s2), { ok: false, error: "ASSESSMENT_EPOCH_CONFLICTED" });
  assert.equal(await helperClaim(s2), null);
  await assert.rejects(direct(s2.opId), /PREFLIGHT_CONFLICT_LATCHED/);
});

test("A-12 (D2): exhaustion — only incomplete + identity_refused count; 3 per epoch latch (further preflight refused, fence refuses); 2 + a fresh eligible still qualifies", async () => {
  const s = await setup();
  F.ok(await counted(s)); F.ok(await rec(s, { outcome: "incomplete", code: "LIST_HTTP_STATUS", ...(await positive(s)), listReadId: await listRead(s) }));
  F.ok(await eligible(s));
  assert.equal(await ready(s.opId), true, "2 counted + latest eligible");
  F.ok(await counted(s));
  assert.equal(await refusal(s.opId), "PREFLIGHT_EXHAUSTED");
  assert.deepEqual(await eligible(s), { ok: false, error: "ASSESSMENT_EPOCH_EXHAUSTED" });
  assert.deepEqual(await conflict(s), { ok: false, error: "ASSESSMENT_EPOCH_EXHAUSTED" });
  assert.equal(await helperClaim(s), null);
  await assert.rejects(direct(s.opId), /PREFLIGHT_EXHAUSTED/);
  // eligible rows never count
  const s2 = await setup();
  for (let k = 0; k < 4; k++) F.ok(await eligible(s2));
  assert.equal(await refusal(s2.opId), null);
});

// ---- A-13 / A-14 / A-15: the fence, the audit, locks ---------------------------------------------------------------
test("A-13: fence — no assessment, latest not eligible, other worker, missing lease, stale evidence at the claim instant; every path (helper generic / opId, direct UPDATE)", async () => {
  const s = await setup();
  const paths = async (worker = "w1") => [await helperClaim(s, worker), await claimNextOperation(db.app, { workerId: worker, now: Date.now(), opId: s.opId })];
  assert.deepEqual(await paths(), [null, null], "pending initial row with NO assessment is unclaimable (no grandfathering)");
  await assert.rejects(direct(s.opId), (e) => /preflight assessment NO_ASSESSMENT$/.test(e.message), "refused by the BEFORE fence itself (not only the AFTER audit re-check)");
  F.ok(await eligible(s)); F.ok(await counted(s));
  assert.deepEqual(await paths(), [null, null]);
  await assert.rejects(direct(s.opId), (e) => /preflight assessment LATEST_NOT_ELIGIBLE$/.test(e.message));
  F.ok(await eligible(s));
  assert.deepEqual(await paths("w2"), [null, null], "the claimant must be the assessing worker");
  await assert.rejects(direct(s.opId, "w2"), /NOT_ASSESSING_WORKER/);
  await db.app.query("UPDATE booking.intent_work SET work_worker_id = NULL, work_lease_until = NULL WHERE intent_id = $1", [s.c.id]);
  assert.deepEqual(await paths(), [null, null]);
  await assert.rejects(direct(s.opId), /WORK_LEASE/);
  await lease(s.c.id, "w2");
  await assert.rejects(direct(s.opId, "w2"), /WORK_LEASE/, "lease now held by another worker than the assessor");
  await lease(s.c.id, "w1");
  // evidence ages past 2 minutes between assessment and claim
  const x = await setup();
  F.ok(await rec(x, { outcome: "eligible", ...(await parts(x, { t: Date.now() - 2 * MIN + 1500 })) }));
  await sleep(2000);
  assert.equal(await ready(x.opId), false);
  assert.equal(await helperClaim(x), null);
  await assert.rejects(direct(x.opId), /STALE/);
  assert.equal((await audits(x.opId)).length, 0);
});

test("A-13b (addendum D): work lease is locked and judged AFTER the wait — expiry while waiting, reassignment committed first (claim waits, refused), claim first (writer SKIPs / waits)", async () => {
  // expiry while the direct claim waits on the work row (an uncommitted lease writer holds it)
  const s = await setup(); F.ok(await eligible(s));
  const k1 = await appClient(); const k2 = await appClient();
  try {
    await k1.query("BEGIN");
    await k1.query("UPDATE booking.intent_work SET work_lease_until = clock_timestamp() + interval '1200 milliseconds' WHERE intent_id = $1", [s.c.id]);
    const p = errCode(direct(s.opId, "w1", k2));
    await waitForLockWaiters(1);
    await sleep(1500);
    await k1.query("COMMIT");
    assert.equal(await p, "23514:RECORDING_CLAIM_FENCED", "lease expired at the post-wait decision instant");
  } finally { await k1.end(); await k2.end(); }
  assert.equal((await opRow(s.opId)).state, "pending");
  // the assessment writer likewise judges the lease after its wait
  await lease(s.c.id, "w1");
  const k3 = await appClient();
  try {
    await k3.query("BEGIN");
    await k3.query("UPDATE booking.intent_work SET work_lease_until = clock_timestamp() + interval '1200 milliseconds' WHERE intent_id = $1", [s.c.id]);
    const p = errCode(eligible(s).then((r) => { if (!r.ok) throw Object.assign(new Error(r.error), { code: "23514" }); }));
    await waitForLockWaiters(1); await sleep(1500); await k3.query("COMMIT");
    assert.equal(await p, "23514:ASSESSMENT_WORK_LEASE_LOST");
  } finally { await k3.end(); }
  // reassignment committed while the claim waits: claim refused
  const r = await setup(); F.ok(await eligible(r));
  const a1 = await appClient(); const a2 = await appClient();
  try {
    await a1.query("BEGIN");
    await a1.query("UPDATE booking.intent_work SET work_worker_id = 'w2' WHERE intent_id = $1", [r.c.id]);
    const p = errCode(direct(r.opId, "w1", a2));
    await waitForLockWaiters(1);
    await a1.query("COMMIT");
    assert.equal(await p, "23514:RECORDING_CLAIM_FENCED");
  } finally { await a1.end(); await a2.end(); }
  // claim FIRST (holds work SHARE until commit): the claimIntentWork statement (SKIP LOCKED) skips the row without waiting; a plain writer waits
  const q = await setup();
  await lease(q.c.id, "w1", 4000);
  F.ok(await eligible(q));
  await db.app.query("UPDATE booking.intent_work SET next_action_at = now() - interval '1 minute' WHERE intent_id = $1", [q.c.id]);
  const b1 = await appClient(); const b2 = await appClient();
  const CLAIM_WORK = `WITH c AS (SELECT w.intent_id FROM booking.intent_work w JOIN booking.intents i ON i.id = w.intent_id
      WHERE w.intent_id = $1 AND w.next_action_at <= now() AND (w.work_lease_until IS NULL OR w.work_lease_until < now()) AND i.state = 'payment_captured'
      FOR UPDATE OF w SKIP LOCKED LIMIT 1)
    UPDATE booking.intent_work w SET work_worker_id = 'w2', work_lease_until = now() + interval '1 minute' FROM c WHERE w.intent_id = c.intent_id RETURNING w.intent_id`;
  try {
    await b1.query("BEGIN"); await direct(q.opId, "w1", b1);                                           // claim committed later
    await sleep(4500);                                                                                  // lease now expired, row still SHARE-locked
    const t0 = Date.now();
    assert.equal((await b2.query(CLAIM_WORK, [q.c.id])).rowCount, 0, "claimIntentWork's statement skips the share-locked row");
    assert.ok(Date.now() - t0 < 1000, "without waiting");
    const plain = errCode(b2.query("UPDATE booking.intent_work SET work_worker_id = 'w3' WHERE intent_id = $1", [q.c.id]));
    await waitForLockWaiters(1);
    await b1.query("COMMIT");
    assert.equal(await plain, "ok");
  } finally { await b1.end(); await b2.end(); }
  const au = await audits(q.opId);
  assert.equal(au.length, 1); assert.equal(au[0].worker, "w1");
});

test("A-14 (addendum E): happy path — claim + exact claim-audit row in the claim statement; completion / proof link unchanged; a rolled-back or refused UPDATE leaves no audit", async () => {
  const s = await setup(); const { r } = await F.preflight(db.app, s.c.id, s.opId);
  F.ok(r);
  // rollback: no audit, still pending
  const k = await appClient();
  try { await k.query("BEGIN"); await direct(s.opId, "w1", k); assert.equal((await k.query("SELECT count(*)::int AS n FROM booking.recording_claim_assessments WHERE operation_id = $1", [s.opId])).rows[0].n, 1);
    await k.query("ROLLBACK"); } finally { await k.end(); }
  assert.equal((await audits(s.opId)).length, 0); assert.equal((await opRow(s.opId)).state, "pending");
  const op = await helperClaim(s);
  assert.ok(op && op.state === "in_flight" && op.attempts === 1);
  const au = await audits(s.opId);
  assert.equal(au.length, 1);
  const a = (await assessments(s.opId)).at(-1);
  assert.deepEqual([au[0].assessment_id, au[0].intent_id, au[0].worker, au[0].epoch], [r.id, s.c.id, "w1", 0]);
  assert.ok(new Date(au[0].claimed_at) >= new Date(a.recorded_at));
  // after the claim: no further assessment of this row; never a second claim
  assert.deepEqual(await eligible(s), { ok: false, error: "ASSESSMENT_TARGET_STATE" });
  // completion with full proof (0010 path) is unchanged
  const chargeId = "771001";
  const ev = await F.chargeListEvidence(db.app, { ...s.c, listingId: Number(s.f.listing_id) }, F.recordingObserved({ ...s.c, listingId: Number(s.f.listing_id) }, chargeId), Date.now());
  F.ok(await completeRecordingWithEvidence(db.app, op.id, { workerId: "w1", evidenceId: ev, resultRef: chargeId, expectedVersion: s.f.version }));
  assert.equal((await opRow(op.id)).state, "succeeded");
  // a healthy F.confirmed flow end to end
  const c = await F.confirmed(db.app, stay());
  assert.equal(await F.state(db.app, c.id), "confirmed");
  assert.equal((await audits(c.recordingOpId)).length, 1);
});

test("A-14b (addendum D): record-only work lock in the helper — a recording candidate share-locks intent_work between intent and op; other op types do not", async () => {
  const s = await setup(); F.ok(await eligible(s));
  const k = await appClient();
  let release = () => {}; let release2 = () => {}; let claim = null; let c2 = null; let types = [];
  try {
    const gate = new Promise((r) => { release = r; });
    claim = claimNextOperation(db.app, { workerId: "w1", now: Date.now(), intentId: s.c.id, opTypes: OCH, leaseMs: 10 * MIN,
      hooks: { afterIntentLock: async () => { await gate; } } });
    await sleep(300);
    const blocker = (await db.owner.query(`SELECT count(*)::int AS n FROM pg_locks l WHERE l.granted AND l.mode = 'RowShareLock' AND l.relation = 'booking.intent_work'::regclass
        AND l.pid IN (SELECT pid FROM pg_stat_activity WHERE state = 'idle in transaction')`)).rows[0].n;
    assert.ok(blocker >= 1, "the paused recording claim holds a row-share lock on intent_work (FOR SHARE)");
    const w = errCode(k.query("UPDATE booking.intent_work SET next_action_at = now() WHERE intent_id = $1", [s.c.id]));
    await waitForLockWaiters(1);
    types = (await db.owner.query("SELECT DISTINCT l.locktype || ':' || coalesce(l.relation::regclass::text, '-') AS t FROM pg_locks l WHERE NOT l.granted ORDER BY 1")).rows.map((x) => x.t);
    release(); assert.ok(await claim); assert.equal(await w, "ok");
    // a read candidate: no work lock (a concurrent work writer is not blocked while the helper is paused after its intent lock)
    const rid = await requestRead(db.app, s.c.id, "hostaway.retrieve_reservation", s.f.hostaway_reservation_id, { now: now() });
    const gate2 = new Promise((r) => { release2 = r; });
    c2 = claimNextOperation(db.app, { workerId: "w-read", now: Date.now(), opId: rid, hooks: { afterIntentLock: async () => { await gate2; } } });
    await sleep(300);
    const w2 = errCode(k.query("UPDATE booking.intent_work SET next_action_at = now() WHERE intent_id = $1", [s.c.id]));
    await sleep(500);
    assert.equal(await lockWaiters(), 0, "a read candidate takes no intent_work lock");
    release2(); assert.ok(await c2); assert.equal(await w2, "ok");
  } finally {
    release(); release2();
    await Promise.allSettled([claim, c2].filter(Boolean));
    await k.end();
  }
  console.log(`# A-14b waiting lock types while the recording helper paused: ${JSON.stringify(types)}`);
});

test("A-14c: the recheck-stage mirror — a conflict committed between the helper's candidate and recheck stages makes the helper SKIP (null), not raise", async () => {
  const s = await setup(); F.ok(await eligible(s));
  const pc = await parts(s, { list: conflictList() });
  const op = await claimNextOperation(db.app, { workerId: "w1", now: Date.now(), intentId: s.c.id, opTypes: OCH, leaseMs: 10 * MIN,
    hooks: { afterIntentLock: async () => { F.ok(await rec(s, { outcome: "conflict_marker", code: "PRIOR_RECORDING_MARKER_PRESENT", ...pc })); } } });
  assert.equal(op, null);
  assert.equal((await opRow(s.opId)).state, "pending"); assert.equal((await audits(s.opId)).length, 0);
});

test("A-14d: the candidate-stage mirror keeps an unscoped claim live — more than CLAIM_MAX_CANDIDATES fenced recordings queued AHEAD do not hide a claimable one", async () => {
  for (let k = 0; k < 11; k++) await F.captured(db.app, stay());                                      // fenced: no assessment
  const s = await setup({ worker: "w-global" });
  F.ok(await eligible(s, { workerId: "w-global" }));
  // TEST SETUP (ordering only, owner, triggers bypassed): queue this row AFTER the fenced ones
  await F.ownerManagedHistory(db.owner, "UPDATE booking.external_operations SET next_attempt_at = $2 WHERE id = $1", [s.opId, new Date(F.at(9))]);
  const ahead = (await db.owner.query(`SELECT count(*)::int AS n FROM booking.external_operations WHERE op_type = 'hostaway.record_offline_charge' AND state = 'pending'
      AND next_attempt_at <= $1 AND id <> $2`, [new Date(F.at(9)), s.opId])).rows[0].n;
  assert.ok(ahead > 10, `${ahead} fenced recordings queued ahead`);
  const op = await claimNextOperation(db.app, { workerId: "w-global", now: Date.now(), opTypes: OCH, leaseMs: 10 * MIN });
  assert.ok(op && op.id === s.opId, "the claimable recording is found past the fenced ones");
});

test("A-15: assessment vs claim in both orders (observed waits); direct-UPDATE inversion vs an applyEvent-ordered transaction (40P01 bounded, never a bypass)", async () => {
  // assessment first (uncommitted): the helper SKIPs the op (SKIP LOCKED); a direct claim waits, then sees the committed latest row
  const s = await setup(); F.ok(await eligible(s));
  const p = await parts(s, { list: conflictList() });
  const k1 = await appClient(); const k2 = await appClient();
  try {
    await k1.query("BEGIN");
    await k1.query("SELECT booking.record_recording_assessment($1, 'w1', 'conflict_marker', 'PRIOR_RECORDING_MARKER_PRESENT', $2, $3, $4, $5, $6, $7, $8, $9, $10) AS id",
      [s.opId, p.identityReadId, p.listReadId, p.identityEvidenceId, p.listEvidenceId, s.f.version, F.PROOF_MODULE_VERSION, F.PREFLIGHT_CLIENT_LABEL, F.PREFLIGHT_ACCOUNT_REF,
        JSON.stringify(F.preflightConfig(s.f))]);
    assert.equal(await claimNextOperation(db.app, { workerId: "w1", now: Date.now(), opId: s.opId }), null, "helper skips the share-locked op");
    const d = errCode(direct(s.opId, "w1", k2));
    await waitForLockWaiters(1);
    await k1.query("COMMIT");
    assert.equal(await d, "23514:RECORDING_CLAIM_FENCED", "the waiting direct claim sees the committed conflict");
  } finally { await k1.end(); await k2.end(); }
  // claim first (uncommitted): the assessment waits, then sees in_flight
  const x = await setup(); F.ok(await eligible(x));
  const c1 = await appClient();
  try {
    await c1.query("BEGIN"); await direct(x.opId, "w1", c1);
    const a = eligible(x);
    await waitForLockWaiters(1);
    await c1.query("COMMIT");
    assert.deepEqual(await a, { ok: false, error: "ASSESSMENT_TARGET_STATE" });
  } finally { await c1.end(); }
  // inversion (attempt 1 WITH a qualifying assessment): applyEvent's intent NO KEY UPDATE first, then op SHARE vs a direct UPDATE (op first)
  const y = await setup(); F.ok(await eligible(y));
  const i1 = await appClient(); const i2 = await appClient();
  const res = [];
  try {
    await i1.query("BEGIN"); await i1.query("SELECT 1 FROM booking.intents WHERE id = $1 FOR NO KEY UPDATE", [y.c.id]);
    await i2.query("BEGIN");
    const p2 = errCode(i2.query(DIRECT, [y.opId, "w1"]));
    await waitForLockWaiters(1);
    const p1 = errCode(i1.query("SELECT 1 FROM booking.external_operations WHERE id = $1 FOR SHARE", [y.opId]));
    res.push(...await Promise.all([p1, p2]));
  } finally { await i1.query("ROLLBACK").catch(() => {}); await i2.query("ROLLBACK").catch(() => {}); await i1.end(); await i2.end(); }
  assert.ok(res.filter((r) => r.startsWith("40P01")).length <= 1, JSON.stringify(res));
  assert.ok(res.every((r) => r === "ok" || r.startsWith("40P01")), JSON.stringify(res));
  assert.equal((await opRow(y.opId)).state, "pending", "both rolled back: never in_flight");
  assert.equal((await audits(y.opId)).length, 0, "no audit survives a rolled-back claim");
  console.log(`# A-15 inversion observed outcomes: ${JSON.stringify(res)}`);
});

// ---- A-16 / D: slice A alone; down gates; exact rollback ------------------------------------------------------------
test("A-16: 0012 stands alone — no 0013 object (no hold_id / assessment_id on 0011 tables, no preflight reason / release / review functions); epoch 0 and preflight only", async () => {
  // E7.4b-D1 (0014): this file's shared database holds claimed recordings that are still unlinked (0014 down correctly refuses), so the schema is
  // measured at the 0012 boundary in FRESH disposable clusters; the data clause below stays on this file's database. C26: the boundary is built
  // two ways and compared — rolled back from the current top (exact TOP..13 list + history) and migrated UP to 12 from empty — then re-up is exact.
  assert.equal((await db.owner.query("SELECT count(*)::int AS n FROM booking.recording_assessments WHERE epoch <> 0 OR phase <> 'preflight'")).rows[0].n, 0);
  const d12 = await startMigratedDatabase();
  const mo = new pg.Client({ connectionString: d12.adminUrl }); await mo.connect();
  const up12 = await freshAt(12);
  try {
  await downToBoundary(mo, 12);
  assert.deepEqual(await schemaObjects(mo), await schemaObjects(up12.c), "down from the top to 12 == a fresh cluster migrated up to 12 (all later migrations are mechanical)");
  const cols = (await mo.query(`SELECT table_name || '.' || column_name AS c FROM information_schema.columns WHERE table_schema = 'booking'
      AND column_name IN ('hold_id', 'assessment_id') ORDER BY 1`)).rows.map((x) => x.c);
  assert.deepEqual(cols, ["recording_claim_assessments.assessment_id", "recording_conflict_inbox.hold_id", "recording_hold_decisions.hold_id", "recording_hold_observations.hold_id"]);
  assert.equal((await mo.query("SELECT count(*)::int AS n FROM pg_proc WHERE proname IN ('admin_release_preflight_hold', 'open_recording_preflight_hold', 'record_release_review_assessment', 'recording_preflight_epoch')")).rows[0].n, 0);
  const defs = (await mo.query(`SELECT conname, pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname IN ('recording_holds_reason_check', 'recording_hold_decisions_decision_check')`)).rows;
  assert.ok(defs.every((x) => !/PREFLIGHT|release_for_initial_send/.test(x.d)), "0011 CHECKs unchanged");
  await upFromBoundary(mo, 12);
  } finally { await mo.end(); await up12.close(); await d12.close(); }
});

test("D-1..D-3: down gates — 0012 down restores a FRESH 0011 exactly (bodies / ACLs / security / volatility / search_path / triggers / constraints / policies / RLS) and re-up is identical; refuses with audit; then the 0011 / 0010 gates", async () => {
  const objects = schemaObjects;
  const d2 = await startMigratedDatabase();
  const o = new pg.Client({ connectionString: d2.adminUrl }); await o.connect();
  const fresh = await startPostgres(); const f11 = new pg.Client({ connectionString: fresh.adminUrl }); await f11.connect();
  const up12 = await freshAt(12);
  try {
    // this measures 0012 itself: every later migration (0013 … TOP; fresh cluster, no data) rolls back first — exact list + history (C26)
    await downToBoundary(o, 12);
    const at12 = await objects(o);
    assert.deepEqual(at12, await objects(up12.c), "down from the top to 12 == a fresh cluster migrated up to 12");
    // D-1: audit-free -> exact fresh 11, then identical re-up
    assert.deepEqual(await migrateDown(o, { env: "test", to: 11 }), [12]);
    assert.deepEqual(await migrateUp(f11, { env: "test", to: 11 }), range(1, 11));
    assert.deepEqual(await objects(o), await objects(f11), "down 0012 == fresh cluster at 11 (incl. the 0011 fence body)");
    assert.deepEqual(await migrateUp(o, { env: "test", to: 12 }), [12]);
    assert.deepEqual(await objects(o), at12, "re-up identical");
    // D-2: any assessment / claim audit refuses the rollback; nothing changes
    const c = await F.confirmed(d2.app, { listingId: 829901, from: "2031-03-01", to: "2031-03-04" });
    await assert.rejects(migrateDown(o, { env: "test", to: 11 }), /DOWNGRADE_REFUSED_RECORDING_ASSESSMENT_AUDIT/);
    assert.deepEqual(await objects(o), at12);
    assert.equal(Number((await o.query("SELECT count(*) AS n FROM booking.recording_claim_assessments")).rows[0].n), 1);
    // D-3: TEST SETUP ONLY in this throwaway cluster (superuser, triggers bypassed): remove the 0012 audit to simulate pre-0012 history, then the
    // older gates answer exactly as before: 0011 rolls back (no owner-hold audit), 0010 refuses PROGRESSED (a linked, confirmed recording)
    await F.ownerManagedHistory(d2.owner, "DELETE FROM booking.recording_claim_assessments");
    await F.ownerManagedHistory(d2.owner, "DELETE FROM booking.recording_assessments");
    await assert.rejects(migrateDown(o, { env: "test", to: 9 }), /DOWNGRADE_REFUSED_RECORDINGS_PROGRESSED/);
    assert.deepEqual((await o.query("SELECT max(version)::int AS v FROM booking_migrations.applied")).rows[0].v, 10, "0012 and 0011 rolled back, 0010 refused");
    assert.equal(await F.state(d2.app, c.id), "confirmed");
  } finally { await o.end(); await f11.end(); fresh.stop(); await up12.close(); await d2.close(); }
});
