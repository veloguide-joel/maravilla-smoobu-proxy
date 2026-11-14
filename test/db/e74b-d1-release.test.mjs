// Stage E7.4b-D1 slice B — migration 0013: preflight HOLDS, release REVIEWS and the OWNER RELEASE of the initial Hostaway payment recording
// (claude/e74b-preflight-release-contract.md at 6204619 + root ruling C1–C5 / A–F). Throwaway local PostgreSQL; repository code runs as the runtime
// login (test_app ∈ mv_booking_app); owner decisions as test_admin (∈ mv_booking_admin); test_report for privilege probes; the schema owner only for
// probes and explicitly-labelled TEST SETUP (triggers bypassed). Every provider observation is a SYNTHETIC fixture; no provider / network call here.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { startMigratedDatabase, startPostgres } from "./harness.mjs";
import * as F from "./fixtures.mjs";
import { applyEvent } from "../../db/lib/repo.js";
import { claimNextOperation, completeOperation, requestRead, recordRecordingAssessment, recordReleaseReviewAssessment, openRecordingPreflightHold } from "../../db/lib/operations.js";
import { adminReleasePreflightHold, adminResolveRecordingHold } from "../../db/lib/admin.js";
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
const setupInFlight = [];                                                                    // recordings put in flight as labelled TEST SETUP (no claim)
before(async () => { db = await startMigratedDatabase(); report = new pg.Pool({ connectionString: db.reportUrl(), max: 2 }); });
after(async () => { await report.end().catch(() => {}); await db.close(); });

const MIN = 60 * 1000;
const OCH = ["hostaway.record_offline_charge"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let stayN = 0;
const stay = () => { stayN += 1; const d = new Date(Date.UTC(2031, 0, 1) + stayN * 6 * 86400000).toISOString().slice(0, 10);
  const e = new Date(Date.UTC(2031, 0, 1) + (stayN * 6 + 3) * 86400000).toISOString().slice(0, 10); return { listingId: 840000 + stayN, from: d, to: e }; };

// ---- helpers --------------------------------------------------------------------------------------------------------
const lease = (intentId, worker = "w1", ms = 10 * MIN) =>
  db.app.query("UPDATE booking.intent_work SET work_worker_id = $2, work_lease_until = $3 WHERE intent_id = $1", [intentId, worker, new Date(Date.now() + ms)]);
async function setup({ worker = "w1" } = {}) {
  const c = await F.captured(db.app, stay());
  await lease(c.id, worker);
  return { c, opId: await F.initialRecordingId(db.app, c.id), f: await F.preflightFacts(db.app, c.id) };
}
const refresh = async (s) => { s.f = await F.preflightFacts(db.app, s.c.id); return s; };
// caller times: a read is REQUESTED now (after any hold / release, so the caller-time floors hold) and COMPLETED at `done` (its observed_at)
const now = () => Date.now();
async function readAt(s, opType, done = now(), requested = Math.max(done, now())) {
  const id = await requestRead(db.app, s.c.id, opType, s.f.hostaway_reservation_id, { now: requested });
  assert.ok(await claimNextOperation(db.app, { workerId: "w-read", now: requested, opId: id }));
  F.ok(await completeOperation(db.app, id, { workerId: "w-read", now: done, outcome: { status: "succeeded" } }));
  return id;
}
const idRead = (s, done) => readAt(s, "hostaway.retrieve_reservation", done);
const listRead = (s, done) => readAt(s, "hostaway.list_offline_charges", done);
const idEv = (s, readId, observed = F.identityObserved(s.f)) => F.readEvidenceOf(db.app, readId, "hostaway_reservation", s.f.hostaway_reservation_id, "found_active", observed);
const listEv = (s, readId, observed = F.preflightListObserved()) => F.readEvidenceOf(db.app, readId, "hostaway_offline_charges", s.f.hostaway_reservation_id, "listed", observed);
async function parts(s, { t, list = F.preflightListObserved(), tId = t, tList = t } = {}) {
  const identityReadId = await idRead(s, tId); const identityEvidenceId = await idEv(s, identityReadId);
  const listReadId = await listRead(s, tList); const listEvidenceId = await listEv(s, listReadId, list);
  return { identityReadId, identityEvidenceId, listReadId, listEvidenceId };
}
const common = (s) => ({ workerId: "w1", expectedVersion: s.f.version, moduleVersion: F.PROOF_MODULE_VERSION, clientLabel: F.PREFLIGHT_CLIENT_LABEL,
  accountRef: F.PREFLIGHT_ACCOUNT_REF, config: F.preflightConfig(s.f) });
const rec = (s, o) => recordRecordingAssessment(db.app, s.opId, { ...common(s), ...o });
const review = (s, holdId, o) => recordReleaseReviewAssessment(db.app, holdId, { ...common(s), ...o });
const eligible = async (s, o = {}) => rec(s, { outcome: "eligible", ...(await parts(s)), ...o });
const eligibleReview = async (s, holdId, o = {}) => review(s, holdId, { outcome: "eligible", ...(await parts(s)), ...o });
const conflictList = () => F.preflightListObserved({ matchingChargeCount: 1, matchingChargeIds: ["700001"], rowCount: 1 });
const conflict = async (s) => rec(s, { outcome: "conflict_marker", code: "PRIOR_RECORDING_MARKER_PRESENT", ...(await parts(s, { list: conflictList() })) });
const counted = async (s) => rec(s, { outcome: "identity_refused", code: "IDENTITY_FAIL_ENVELOPE", identityReadId: await idRead(s) });
const open = (s, by = "test-opener") => openRecordingPreflightHold(db.app, s.opId, { by });
const release = (holdId, reviewId, pool = db.reconciler, at = Date.now()) =>
  adminReleasePreflightHold(pool, { holdId, reviewId, resolver: "owner", justification: "PREFLIGHT_RECHECKED_CLEAN", at });
const epoch = async (opId) => (await db.owner.query("SELECT booking.recording_preflight_epoch($1) AS e", [opId])).rows[0].e;
const refusal = async (opId, worker = null) => (await db.owner.query("SELECT booking.recording_claim_refusal($1, $2, clock_timestamp()) AS r", [opId, worker])).rows[0].r;
const ready = async (opId, worker = null) => (await db.app.query("SELECT booking.recording_claim_ready($1, $2) AS r", [opId, worker])).rows[0].r;
const helperClaim = (s, worker = "w1") => claimNextOperation(db.app, { workerId: worker, now: Date.now(), intentId: s.c.id, opTypes: OCH, leaseMs: 10 * MIN });
const DIRECT = `UPDATE booking.external_operations SET state = 'in_flight', lease_worker_id = $2, lease_until = now() + interval '5 minutes',
  attempts = attempts + 1, dispatched_at = now(), updated_at = now() WHERE id = $1`;
const direct = (opId, worker = "w1", c = db.app) => c.query(DIRECT, [opId, worker]);
const one = async (sql, p = []) => (await db.owner.query(sql, p)).rows[0];
const rows = async (sql, p = []) => (await db.owner.query(sql, p)).rows;
const hold = (id) => one("SELECT * FROM booking.recording_holds WHERE id = $1", [id]);
const caseOf = (id) => one("SELECT * FROM booking.reconciliation_cases WHERE id = $1", [id]);
const opRow = (id) => one("SELECT * FROM booking.external_operations WHERE id = $1", [id]);
const decisionsOf = (holdId) => rows("SELECT * FROM booking.recording_hold_decisions WHERE hold_id = $1 ORDER BY recorded_at", [holdId]);
const assessmentsOf = (opId) => rows("SELECT * FROM booking.recording_assessments WHERE operation_id = $1 ORDER BY seq", [opId]);
const audits = (opId) => rows("SELECT * FROM booking.recording_claim_assessments WHERE operation_id = $1", [opId]);
async function waitForLockWaiters(n = 1, timeoutMs = 5000) {
  const t0 = Date.now();
  for (;;) {
    const r = await db.owner.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`);
    if (r.rows[0].n >= n) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`no lock waiter observed within ${timeoutMs} ms`);
    await sleep(10);
  }
}
async function appClient(url = db.appUrl()) { const c = new pg.Client({ connectionString: url }); c.on("error", () => {}); await c.connect(); return c; }
const errCode = (p) => p.then(() => "ok", (e) => `${e.code}:${String(e.message).split(":")[0]}`);
const okOrThrow = (r) => { if (!r.ok) throw Object.assign(new Error(r.error), { code: "23514" }); return r; };
async function ownerTx(fn, { replica = false } = {}) {
  const c = await db.owner.connect();
  try { await c.query("BEGIN"); if (replica) await c.query("SET LOCAL session_replication_role = replica"); return await fn(c); }
  finally { await c.query("ROLLBACK").catch(() => {}); c.release(); }
}
/** a latched (conflict) recording with its DB-derived hold and one fresh eligible review */
async function heldWithReview() {
  const s = await setup(); F.ok(await conflict(s));
  const h = F.ok(await open(s)).holdId;
  const r = F.ok(await eligibleReview(s, h)).id;
  return { s, h, r };
}

// ---- B-1: two full release cycles ----------------------------------------------------------------------------------
test("B-1: TWO release cycles — epoch 0 conflict → hold → review → release → epoch 1 exhaustion → hold → review → release → epoch 2 new preflight → claim + audit; all older audit kept", async () => {
  const s = await setup();
  // epoch 0: conflict latch; DB-derived hold citing the EARLIEST conflict
  F.ok(await eligible(s));
  const c0 = F.ok(await conflict(s)).id;
  assert.equal(await refusal(s.opId), "PREFLIGHT_CONFLICT_LATCHED");
  const h0 = F.ok(await open(s)).holdId;
  let H = await hold(h0);
  assert.deepEqual([H.reason, H.assessment_id, H.epoch, H.released_at], ["PREFLIGHT_CONFLICT_MARKER", c0, 0, null]);
  let C = await caseOf(H.case_id);
  assert.deepEqual([C.kind, C.status, C.opened_by], ["OFFLINE_CHARGE_HOLD_PREFLIGHT_CONFLICT_MARKER", "open", `recording-hold:${C.id}`]);
  assert.equal(await helperClaim(s), null);
  assert.deepEqual(await eligible(s), { ok: false, error: "ASSESSMENT_HOLD_ACTIVE" }, "normal preflight refuses while held");
  const r0 = F.ok(await eligibleReview(s, h0)).id;
  const v0 = (await refresh(s)).f.version;
  const d0 = F.ok(await release(h0, r0)).id;
  const D = (await decisionsOf(h0))[0];
  const rv = (await assessmentsOf(s.opId)).find((x) => x.id === r0);
  assert.deepEqual([D.id, D.decision, D.assessment_id, D.evidence_ids, D.linked_evidence_id], [d0, "release_for_initial_send", r0, [rv.identity_evidence, rv.list_evidence], null]);
  H = await hold(h0); C = await caseOf(H.case_id);
  assert.deepEqual([H.release_decision_id, C.status, C.resolution], [d0, "resolved", "no_action"]);
  assert.equal(await epoch(s.opId), 1);
  // the new epoch is EMPTY: no claim without a NEW preflight
  assert.equal(await refusal(s.opId, "w1"), "NO_ASSESSMENT");
  assert.equal(await helperClaim(s), null);
  await assert.rejects(direct(s.opId), /preflight assessment NO_ASSESSMENT$/);
  // epoch 1: exhaustion; the hold cites the counted refusal of rank 3
  F.ok(await counted(s)); F.ok(await counted(s)); const third = F.ok(await counted(s)).id;
  assert.equal(await refusal(s.opId), "PREFLIGHT_EXHAUSTED");
  const h1 = F.ok(await open(s)).holdId;
  H = await hold(h1);
  assert.deepEqual([H.reason, H.assessment_id, H.epoch], ["PREFLIGHT_EXHAUSTED", third, 1]);
  assert.notEqual(H.case_id, C.id, "a new case: the epoch-0 case is resolved");
  const r1 = F.ok(await eligibleReview(s, h1)).id;
  F.ok(await release(h1, r1));
  assert.equal(await epoch(s.opId), 2);
  // epoch 2: a new eligible preflight qualifies; the claim audit binds the epoch-2 row
  const e2 = F.ok(await eligible(s)).id;
  const op = await helperClaim(s);
  assert.ok(op && op.id === s.opId);
  const au = await audits(s.opId);
  assert.deepEqual([au.length, au[0].assessment_id, au[0].epoch], [1, e2, 2]);
  // all older audit is kept
  const all = await assessmentsOf(s.opId);
  assert.deepEqual(all.map((x) => `${x.epoch}:${x.phase}:${x.outcome}`), ["0:preflight:eligible", "0:preflight:conflict_marker", "0:release_review:eligible",
    "1:preflight:identity_refused", "1:preflight:identity_refused", "1:preflight:identity_refused", "1:release_review:eligible", "2:preflight:eligible"]);
  assert.equal((await rows("SELECT id FROM booking.recording_holds WHERE operation_id = $1", [s.opId])).length, 2);
  assert.equal(v0, (await refresh(s)).f.version, "opener / review / release changed no intent version");
});

// ---- B-2: old-epoch replay -----------------------------------------------------------------------------------------
test("B-2: after a release — old-epoch eligible / review never qualify; used reads refused by UNIQUE; UNUSED pre-release reads / evidence refused by the release floor", async () => {
  const s = await setup(); F.ok(await eligible(s));
  F.ok(await conflict(s));
  const h = F.ok(await open(s)).holdId;
  const unusedBeforeHold = await parts(s);                                                   // written before the hold, never cited
  const r = F.ok(await eligibleReview(s, h)).id;
  const unusedBeforeRelease = await parts(s);                                                // written after the hold, before the release, never cited
  F.ok(await release(h, r));
  assert.equal(await refusal(s.opId, "w1"), "NO_ASSESSMENT", "neither the epoch-0 eligible row nor the review carry forward");
  const rv = (await assessmentsOf(s.opId)).find((x) => x.id === r);
  assert.deepEqual(await rec(s, { outcome: "eligible", identityReadId: rv.identity_read_op, identityEvidenceId: rv.identity_evidence, listReadId: rv.list_read_op,
    listEvidenceId: rv.list_evidence }), { ok: false, error: "ASSESSMENT_READ_REUSED" });
  assert.deepEqual(await rec(s, { outcome: "eligible", ...unusedBeforeHold }), { ok: false, error: "ASSESSMENT_FLOOR" });
  assert.deepEqual(await rec(s, { outcome: "eligible", ...unusedBeforeRelease }), { ok: false, error: "ASSESSMENT_FLOOR" });
  F.ok(await eligible(s), "new reads / evidence after the release qualify");
  assert.equal(await ready(s.opId, "w1"), true);
});

// ---- B-3: opener ---------------------------------------------------------------------------------------------------
test("B-3 (C1): opener is DB-derived — no latch refused; no lease / no worker needed (crash recovery); idempotent; intent moved on still opens; a different active hold refuses; the latch blocks with no hold", async () => {
  const s = await setup();
  assert.deepEqual(await open(s), { ok: false, error: "HOLD_TARGET_STATE" }, "no latch, nothing to show");
  F.ok(await counted(s)); F.ok(await counted(s)); F.ok(await counted(s));
  // the DB latch is the backstop while no hold exists
  assert.equal(await helperClaim(s), null);
  // crash recovery: the assessing worker's lease is gone; another caller (admin pool) opens
  await db.app.query("UPDATE booking.intent_work SET work_worker_id = NULL, work_lease_until = NULL WHERE intent_id = $1", [s.c.id]);
  const h = (await openRecordingPreflightHold(db.reconciler, s.opId, { by: "crash-recovery" })).holdId;
  assert.ok(h);
  assert.equal(F.ok(await open(s, "second")).holdId, h, "idempotent: same hold, no write");
  assert.equal((await rows("SELECT id FROM booking.recording_holds WHERE operation_id = $1", [s.opId])).length, 1);
  assert.equal((await hold(h)).created_by, "crash-recovery");
  // intent moved on (ESCALATE → reconciliation_required): the hold still opens (visibility), and cannot be released
  const m = await setup(); F.ok(await conflict(m));
  F.ok(await applyEvent(db.app, m.c.id, { type: "ESCALATE", code: "MANUAL_REVIEW" }, { now: Date.now() }));
  assert.equal((await opRow(m.opId)).state, "pending");
  const hm = F.ok(await open(m)).holdId;
  const Hm = await hold(hm);
  assert.deepEqual([Hm.intent_state_at_hold, Hm.reason], ["reconciliation_required", "PREFLIGHT_CONFLICT_MARKER"]);
  // a different active hold refuses (TEST SETUP: an artificial non-preflight hold, owner, triggers bypassed)
  const x = await setup(); F.ok(await conflict(x));
  const caseId = (await one("SELECT gen_random_uuid() AS id")).id;
  await F.ownerManagedHistory(db.owner, `WITH k AS (INSERT INTO booking.reconciliation_cases (id, intent_id, kind, status, opened_at, opened_by, evidence)
      VALUES ($1::uuid, $2::uuid, 'OFFLINE_CHARGE_HOLD_ATTEMPT_GT1', 'open', now(), 'recording-hold:' || $1::uuid::text, '{}'::jsonb) RETURNING id)
    INSERT INTO booking.recording_holds (id, operation_id, intent_id, reason, case_id, op_state_at_hold, op_key_at_hold, intent_state_at_hold, intent_version_at_hold, created_at, created_by)
    SELECT gen_random_uuid(), $3::uuid, $2::uuid, 'ATTEMPT_GT1', k.id, 'pending', 'k', 'payment_captured', 1, now(), 'probe' FROM k`, [caseId, x.c.id, x.opId]);
  assert.deepEqual(await open(x), { ok: false, error: "HOLD_ALREADY_ACTIVE" });
  // a claimed (not pending) recording never gets a preflight hold
  const y = await setup(); F.ok(await eligible(y)); assert.ok(await helperClaim(y));
  assert.deepEqual(await open(y), { ok: false, error: "HOLD_TARGET_STATE" });
});

// ---- B-4: review writer --------------------------------------------------------------------------------------------
test("B-4 (C2): release_review only under the ACTIVE current-epoch preflight hold, live lease, version = hold version; 0012 rules + hold floor; any allowlisted outcome; never counts / qualifies a claim", async () => {
  const s = await setup(); F.ok(await conflict(s));
  const pre = await parts(s);                                                                // written before the hold
  const h = F.ok(await open(s)).holdId;
  assert.deepEqual(await review(s, h, { outcome: "eligible", ...pre }), { ok: false, error: "ASSESSMENT_FLOOR" }, "proof written before the hold");
  assert.deepEqual(await eligibleReview(s, h, { workerId: "w2" }), { ok: false, error: "ASSESSMENT_WORK_LEASE_LOST" });
  assert.deepEqual(await eligibleReview(s, h, { expectedVersion: s.f.version + 1 }), { ok: false, error: "ASSESSMENT_VERSION_CHANGED" });
  assert.deepEqual(await review(s, h, { outcome: "eligible", ...(await parts(s, { tId: Date.now() - 2 * MIN - 2000 })) }), { ok: false, error: "ASSESSMENT_STALE" }, "stale identity");
  assert.deepEqual(await review(s, h, { outcome: "eligible", ...(await parts(s, { tList: Date.now() - 2 * MIN - 2000 })) }), { ok: false, error: "ASSESSMENT_STALE" }, "stale list");
  assert.deepEqual(await review(s, h, { outcome: "eligible", ...(await parts(s, { t: Date.now() + 5000 })) }), { ok: false, error: "ASSESSMENT_STALE" }, "future");
  assert.deepEqual(await review(s, h, { outcome: "incomplete", code: "ZZ_NOT_SEEDED", identityReadId: await idRead(s) }), { ok: false, error: "ASSESSMENT_CODE" });
  // any allowlisted outcome is recorded (conflict / refusals too) and none of them counts toward the latch or exhaustion
  F.ok(await review(s, h, { outcome: "identity_refused", code: "IDENTITY_FAIL_ENVELOPE", identityReadId: await idRead(s) }));
  F.ok(await review(s, h, { outcome: "identity_refused", code: "IDENTITY_FAIL_ENVELOPE", identityReadId: await idRead(s) }));
  F.ok(await review(s, h, { outcome: "identity_refused", code: "IDENTITY_FAIL_ENVELOPE", identityReadId: await idRead(s) }));
  F.ok(await review(s, h, { outcome: "conflict_marker", code: "PRIOR_RECORDING_MARKER_PRESENT", ...(await parts(s, { list: conflictList() })) }));
  const latch = await one("SELECT * FROM booking.recording_preflight_latch_citation($1)", [s.opId]);
  assert.equal(latch.o_reason, "PREFLIGHT_CONFLICT_MARKER", "the epoch-0 preflight conflict, not the reviews");
  assert.equal((await one("SELECT count(*)::int AS n FROM booking.recording_assessments WHERE operation_id = $1 AND phase = 'preflight'", [s.opId])).n, 1);
  // a review never satisfies a claim (the refusal reads preflight rows only)
  const r = F.ok(await eligibleReview(s, h)).id;
  F.ok(await release(h, r));
  assert.equal(await refusal(s.opId, "w1"), "NO_ASSESSMENT");
  // after release the hold is not active: no further review
  assert.deepEqual(await eligibleReview(s, h), { ok: false, error: "HOLD_NOT_ACTIVE" });
  // a review needs a preflight hold: a non-preflight hold refuses (artificial SUCCEEDED_UNPROVEN, TEST SETUP)
  const x = await setup();
  const caseId = (await one("SELECT gen_random_uuid() AS id")).id; const hid = (await one("SELECT gen_random_uuid() AS id")).id;
  await F.ownerManagedHistory(db.owner, `WITH k AS (INSERT INTO booking.reconciliation_cases (id, intent_id, kind, status, opened_at, opened_by, evidence)
      VALUES ($1::uuid, $2::uuid, 'OFFLINE_CHARGE_HOLD_SUCCEEDED_UNPROVEN', 'open', now(), 'recording-hold:' || $1::uuid::text, '{}'::jsonb) RETURNING id)
    INSERT INTO booking.recording_holds (id, operation_id, intent_id, reason, case_id, op_state_at_hold, op_key_at_hold, intent_state_at_hold, intent_version_at_hold, created_at, created_by)
    SELECT $4::uuid, $3::uuid, $2::uuid, 'SUCCEEDED_UNPROVEN', k.id, 'pending', 'k', 'payment_captured', 1, now(), 'probe' FROM k`, [caseId, x.c.id, x.opId, hid]);
  assert.deepEqual(await eligibleReview(x, hid), { ok: false, error: "HOLD_DECISION_NOT_ALLOWED" });
  assert.equal((await release(hid, r)).error, "HOLD_DECISION_NOT_ALLOWED");
});

test("B-4b (addendum A): guards reject wrong phase / hold / epoch bindings even from a privileged INSERT (owner, triggers ACTIVE)", async () => {
  const { s, h, r } = await heldWithReview();
  const a = (await assessmentsOf(s.opId)).find((x) => x.id === r);
  const cols = "id, operation_id, intent_id, phase, epoch, outcome, code, identity_read_op, list_read_op, identity_evidence, list_evidence, intent_version, worker, module_version, cfg, client_label, account_ref, recorded_at, hold_id";
  const probe = (o) => ownerTx(async (c) => {
    const x = { ...a, ...o };
    const ir = await F.completedRead(db.app, s.c.id, "hostaway.retrieve_reservation", s.f.hostaway_reservation_id, now());
    try {
      await c.query(`INSERT INTO booking.recording_assessments (${cols}) VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,NULL,NULL,NULL,$8,$9,$10,$11,$12,$13,now(),$14)`,
        [x.operation_id, x.intent_id, x.phase, x.epoch, "identity_refused", "IDENTITY_FAIL_ENVELOPE", ir, x.intent_version, x.worker, x.module_version, x.cfg,
          x.client_label, x.account_ref, x.hold_id]);
      return "inserted";
    } catch (e) { return e.constraint || `${e.code}:${String(e.message).split(":")[0]}`; }
  });
  assert.equal(await probe({}), "inserted", "control: a correct review binding passes the guard");
  assert.equal(await probe({ epoch: 1 }), "23514:ASSESSMENT_BINDING");
  assert.equal(await probe({ phase: "preflight" }), "23514:ASSESSMENT_BINDING", "a preflight row citing a hold");
  assert.equal(await probe({ hold_id: null }), "23514:ASSESSMENT_BINDING", "a review without a hold");
  const other = await heldWithReview();
  assert.equal(await probe({ hold_id: other.h }), "23514:ASSESSMENT_BINDING", "another op's hold");
  F.ok(await release(h, r));
  assert.equal(await probe({}), "23514:ASSESSMENT_BINDING", "a released hold (epoch has moved on)");
  // a preflight row of a past epoch / citing a hold
  assert.equal(await probe({ phase: "preflight", hold_id: null, epoch: 0 }), "23514:ASSESSMENT_BINDING", "past epoch");
});

// ---- B-5: owner release --------------------------------------------------------------------------------------------
test("B-5 (C3): release needs the LATEST review (any outcome) to be eligible; a later refusal supersedes an earlier eligible; replay is read-only; conflicting replay refused; app / report refused", async () => {
  const { s, h, r } = await heldWithReview();
  const later = F.ok(await review(s, h, { outcome: "identity_refused", code: "IDENTITY_FAIL_ENVELOPE", identityReadId: await idRead(s) })).id;
  assert.equal((await release(h, r)).error, "HOLD_REVIEW_NOT_LATEST", "never 'latest eligible' filtered around a newer refusal");
  assert.equal((await release(h, later)).error, "HOLD_REVIEW_NOT_ELIGIBLE");
  const r2 = F.ok(await eligibleReview(s, h)).id;
  assert.equal((await release(h, r2, db.app)).error, "PERMISSION_DENIED");
  assert.equal((await release(h, r2, report)).error, "PERMISSION_DENIED");
  const d = F.ok(await release(h, r2)).id;
  const n = (await decisionsOf(h)).length;
  assert.equal(F.ok(await release(h, r2)).id, d, "same-review replay returns the prior decision");
  assert.equal((await decisionsOf(h)).length, n, "no new row");
  assert.equal((await release(h, r)).error, "HOLD_NOT_ACTIVE", "conflicting replay");
  assert.equal((await release(h, later)).error, "HOLD_NOT_ACTIVE");
  // prior non-eligible / superseded reviews remain as audit
  assert.equal((await rows("SELECT id FROM booking.recording_assessments WHERE hold_id = $1", [h])).length, 3);
});

test("B-5b: release-time checks at the post-lock DB instant — EACH stale evidence row, version changed (D8: stays visible, no reopen), intent moved on, keep_visible works with no release", async () => {
  // stale identity only / stale list only at release time (each fresh at review time)
  for (const which of ["identity", "list"]) {
    const s = await setup(); F.ok(await conflict(s));
    const h = F.ok(await open(s)).holdId;
    const old = Date.now() - 2 * MIN + 1500;
    const p = await parts(s, which === "identity" ? { tId: old } : { tList: old });
    const r = F.ok(await review(s, h, { outcome: "eligible", ...p })).id;
    await sleep(2000);
    assert.equal((await release(h, r)).error, "HOLD_REVIEW_STALE", which);
    assert.equal((await hold(h)).released_at, null);
  }
  // version changed after the review (TEST-ONLY state fault: owner, triggers bypassed): refused permanently; hold + case stay
  const { s, h, r } = await heldWithReview();
  await F.ownerManagedHistory(db.owner, "UPDATE booking.intents SET version = version + 1 WHERE id = $1", [s.c.id]);
  assert.equal((await release(h, r)).error, "HOLD_CONTEXT_CHANGED");
  const H = await hold(h);
  assert.equal(H.released_at, null); assert.equal((await caseOf(H.case_id)).status, "open");
  assert.deepEqual(await open(s), { ok: true, holdId: h }, "no new hold: the same hold stays the visible one");
  await refresh(s);
  assert.deepEqual(await eligibleReview(s, h), { ok: false, error: "ASSESSMENT_VERSION_CHANGED" }, "no new review at the new version either");
  // intent moved on: release refused, hold stays
  const m = await heldWithReview();
  F.ok(await applyEvent(db.app, m.s.c.id, { type: "ESCALATE", code: "MANUAL_REVIEW" }, { now: Date.now() }));
  assert.equal((await release(m.h, m.r)).error, "HOLD_TARGET_STATE");
  assert.equal((await hold(m.h)).released_at, null);
  // keep_visible on a preflight hold: decision recorded, hold / case unchanged
  const k = await heldWithReview();
  const kv = F.ok(await adminResolveRecordingHold(db.reconciler, { holdId: k.h, decision: "keep_visible", resolver: "owner", justification: "LOOKING", at: Date.now() })).id;
  assert.ok(kv);
  assert.equal((await hold(k.h)).released_at, null);
  assert.equal((await adminResolveRecordingHold(db.reconciler, { holdId: k.h, decision: "link_full_proof", evidenceIds: [], linkedEvidenceId: k.r, resolver: "owner",
    justification: "X", at: Date.now() })).error, "HOLD_DECISION_NOT_ALLOWED");
  F.ok(await release(k.h, k.r), "keep_visible does not block a later release");
});

// ---- B-6: case handling, bindings, unrelated cases -------------------------------------------------------------------
test("B-6: last-hold case resolution; an unrelated open reserved case still fences the claim after release; release-decision / case bindings refused at statement or COMMIT", async () => {
  // multiple bound holds (TEST SETUP: a second, artificial active hold bound to the same preflight case, triggers bypassed)
  const { s, h, r } = await heldWithReview();
  const H = await hold(h);
  const other = await setup();
  await F.ownerManagedHistory(db.owner, `INSERT INTO booking.recording_holds (id, operation_id, intent_id, reason, case_id, op_state_at_hold, op_key_at_hold,
      intent_state_at_hold, intent_version_at_hold, epoch, created_at, created_by, assessment_id)
    SELECT gen_random_uuid(), $1::uuid, intent_id, reason, case_id, 'pending', 'k', 'payment_captured', 1, 0, now(), 'probe', assessment_id FROM booking.recording_holds WHERE id = $2`,
    [other.opId, h]);
  F.ok(await release(h, r));
  assert.equal((await caseOf(H.case_id)).status, "open", "another bound hold is still active: the case stays open");
  // unrelated open reserved case (TEST SETUP) still fences a fresh eligible preflight after the release
  const u = await heldWithReview();
  F.ok(await release(u.h, u.r));
  await F.ownerManagedHistory(db.owner, `INSERT INTO booking.reconciliation_cases (id, intent_id, kind, status, opened_at, opened_by, evidence)
    SELECT x.id, $1::uuid, 'OFFLINE_CHARGE_HOLD_LINKED_CONTRADICTED', 'open', now(), 'recording-hold:' || x.id::text, '{}'::jsonb FROM (SELECT gen_random_uuid() AS id) x`, [u.s.c.id]);
  F.ok(await eligible(u.s));
  assert.equal(await helperClaim(u.s), null);
  await assert.rejects(direct(u.s.opId), /an owner hold is active for this recording or intent/);
  // privileged probes with triggers ACTIVE
  const b = await heldWithReview();
  const rv = (await assessmentsOf(b.s.opId)).find((x) => x.id === b.r);
  const dec = (ev, decision = "release_for_initial_send", assessment = b.r) => ownerTx(async (c) => {
    try {
      await c.query(`INSERT INTO booking.recording_hold_decisions (id, hold_id, operation_id, case_id, intent_id, decision, evidence_ids, resolver, justification_code,
          resolver_session_user, decided_at, recorded_at, assessment_id) SELECT gen_random_uuid(), id, operation_id, case_id, intent_id, $2, $3, 'owner', 'X', 'probe', now(), now(), $4
          FROM booking.recording_holds WHERE id = $1`, [b.h, decision, ev, assessment]);
      return "inserted";
    } catch (e) { return String(e.message).split(":")[0]; }
  });
  assert.equal(await dec([rv.identity_evidence, rv.list_evidence]), "inserted", "control");
  assert.equal(await dec([rv.list_evidence, rv.identity_evidence]), "RECORDING_HOLD_BINDING", "canonical order");
  assert.equal(await dec([rv.identity_evidence]), "RECORDING_HOLD_BINDING", "missing row");
  assert.equal(await dec([rv.identity_evidence, rv.list_evidence, rv.identity_evidence]), "RECORDING_HOLD_BINDING", "extra row");
  const other2 = await heldWithReview();
  assert.equal(await dec([rv.identity_evidence, rv.list_evidence], "release_for_initial_send", other2.r), "RECORDING_HOLD_BINDING", "another hold's review");
  // a preflight hold released by a link_full_proof-type decision, or its case resolved 'recorded', fails at COMMIT
  const commitErr = (sql, p) => (async () => {
    const c = await db.owner.connect();
    try { await c.query("BEGIN"); await c.query(sql, p); await c.query("COMMIT"); return "committed"; }
    catch (e) { await c.query("ROLLBACK").catch(() => {}); return String(e.message).split(":")[0]; } finally { c.release(); }
  })();
  assert.equal(await commitErr("UPDATE booking.reconciliation_cases SET status = 'resolved', resolution = 'recorded', resolved_by = 'x', resolved_at = now() WHERE id = $1",
    [(await hold(b.h)).case_id]), "RESERVED_CASE_BINDING");
  // a correct release decision + hold release + case resolution 'recorded' (wrong for a preflight kind) fails at COMMIT; 'no_action' commits
  const fullRelease = (resolution) => (async () => {
    const c = await db.owner.connect();
    try {
      await c.query("BEGIN");
      const d = (await c.query(`INSERT INTO booking.recording_hold_decisions (id, hold_id, operation_id, case_id, intent_id, decision, evidence_ids, resolver, justification_code,
          resolver_session_user, decided_at, recorded_at, assessment_id) SELECT gen_random_uuid(), id, operation_id, case_id, intent_id, 'release_for_initial_send', $2, 'owner', 'X', 'probe', now(), now(), $3
          FROM booking.recording_holds WHERE id = $1 RETURNING id`, [b.h, [rv.identity_evidence, rv.list_evidence], b.r])).rows[0].id;
      await c.query("UPDATE booking.recording_holds SET released_at = now(), release_decision_id = $2 WHERE id = $1", [b.h, d]);
      await c.query("UPDATE booking.reconciliation_cases SET status = 'resolved', resolution = $2, resolved_by = 'x', resolved_at = now() WHERE id = $1", [(await hold(b.h)).case_id, resolution]);
      await c.query("ROLLBACK"); await c.query("BEGIN");                                     // first pass: statements accepted; now the COMMIT check
      const d2 = (await c.query(`INSERT INTO booking.recording_hold_decisions (id, hold_id, operation_id, case_id, intent_id, decision, evidence_ids, resolver, justification_code,
          resolver_session_user, decided_at, recorded_at, assessment_id) SELECT gen_random_uuid(), id, operation_id, case_id, intent_id, 'release_for_initial_send', $2, 'owner', 'X', 'probe', now(), now(), $3
          FROM booking.recording_holds WHERE id = $1 RETURNING id`, [b.h, [rv.identity_evidence, rv.list_evidence], b.r])).rows[0].id;
      await c.query("UPDATE booking.recording_holds SET released_at = now(), release_decision_id = $2 WHERE id = $1", [b.h, d2]);
      await c.query("UPDATE booking.reconciliation_cases SET status = 'resolved', resolution = $2, resolved_by = 'x', resolved_at = now() WHERE id = $1", [(await hold(b.h)).case_id, resolution]);
      await c.query("COMMIT"); return "committed";
    } catch (e) { await c.query("ROLLBACK").catch(() => {}); return String(e.message).split(":")[0]; } finally { c.release(); }
  })();
  assert.equal(await fullRelease("recorded"), "RESERVED_CASE_BINDING");
  assert.equal((await hold(b.h)).released_at, null);
  // a preflight hold released by a keep_visible decision is refused by the hold guard
  const kv = F.ok(await adminResolveRecordingHold(db.reconciler, { holdId: b.h, decision: "keep_visible", resolver: "owner", justification: "LOOKING", at: Date.now() })).id;
  assert.equal(await commitErr("UPDATE booking.recording_holds SET released_at = now(), release_decision_id = $2 WHERE id = $1", [b.h, kv]), "RECORDING_HOLD_BINDING");
  // a privileged INSERT of a preflight hold must cite the CURRENT-epoch latch exactly (wrong assessment / reason / epoch refused)
  const q = await setup(); F.ok(await eligible(q)); const cq = F.ok(await conflict(q)).id;
  const qa = (await assessmentsOf(q.opId))[0].id;
  const holdIns = (reason, assessment, ep) => commitErr(`WITH k AS (INSERT INTO booking.reconciliation_cases (id, intent_id, kind, status, opened_at, opened_by, evidence)
      SELECT x.id, $1::uuid, 'OFFLINE_CHARGE_HOLD_' || $3::text, 'open', now(), 'recording-hold:' || x.id::text, '{}'::jsonb FROM (SELECT gen_random_uuid() AS id) x RETURNING id)
    INSERT INTO booking.recording_holds (id, operation_id, intent_id, reason, case_id, op_state_at_hold, op_key_at_hold, intent_state_at_hold, intent_version_at_hold, epoch, created_at, created_by, assessment_id)
    SELECT gen_random_uuid(), $2::uuid, $1::uuid, $3::text, k.id, 'pending', 'k', 'payment_captured', 1, $5::integer, now(), 'probe', $4::uuid FROM k`, [q.c.id, q.opId, reason, assessment, ep]);
  assert.equal(await holdIns("PREFLIGHT_CONFLICT_MARKER", qa, 0), "RECORDING_HOLD_BINDING", "cites a non-latch assessment");
  assert.equal(await holdIns("PREFLIGHT_EXHAUSTED", cq, 0), "RECORDING_HOLD_BINDING", "wrong reason for the latch");
  assert.equal(await holdIns("PREFLIGHT_CONFLICT_MARKER", cq, 0), "committed", "control: the exact citation is accepted");
});

// ---- B-7: races and rollback ---------------------------------------------------------------------------------------
test("B-7: observed waits — review vs release (both orders), duplicate concurrent openers / releases, opener vs preflight writer (both orders), lease expiry after a wait", async () => {
  const SQLREV = "SELECT booking.record_release_review_assessment($1, 'w1', 'eligible', NULL, $2, $3, $4, $5, $6, $7, $8, $9, $10) AS id";
  const revArgs = (s, h, p) => [h, p.identityReadId, p.listReadId, p.identityEvidenceId, p.listEvidenceId, s.f.version, F.PROOF_MODULE_VERSION, F.PREFLIGHT_CLIENT_LABEL,
    F.PREFLIGHT_ACCOUNT_REF, JSON.stringify(F.preflightConfig(s.f))];
  // review first (uncommitted) → release waits on the op row → then sees the committed review as the latest
  { const { s, h, r } = await heldWithReview(); const p = await parts(s);
    const k = await appClient();
    try {
      await k.query("BEGIN"); const newer = (await k.query(SQLREV, revArgs(s, h, p))).rows[0].id;
      const rel = release(h, r);
      await waitForLockWaiters(1);
      await k.query("COMMIT");
      assert.equal((await rel).error, "HOLD_REVIEW_NOT_LATEST", "the waiting release re-reads the latest review after its wait");
      F.ok(await release(h, newer));
    } finally { await k.end(); } }
  // release first (uncommitted) → review waits → then sees the released hold
  { const { s, h, r } = await heldWithReview(); const p = await parts(s);
    const ka = await appClient(db.adminUrl2());
    try {
      await ka.query("BEGIN");
      await ka.query("SELECT booking.admin_release_preflight_hold($1, $2, 'owner', 'PREFLIGHT_RECHECKED_CLEAN', now()) AS id", [h, r]);
      const rv = review(s, h, { outcome: "eligible", ...p });
      await waitForLockWaiters(1);
      await ka.query("COMMIT");
      assert.deepEqual(await rv, { ok: false, error: "HOLD_NOT_ACTIVE" });
    } finally { await ka.end(); } }
  // duplicate concurrent reviews: both serialize and are kept; only the LATEST (by seq) can be released
  { const { s, h, r } = await heldWithReview();
    const [p1, p2] = [await parts(s), await parts(s)];
    const [x1, x2] = await Promise.all([review(s, h, { outcome: "eligible", ...p1 }), review(s, h, { outcome: "eligible", ...p2 })]);
    assert.ok(x1.ok && x2.ok);
    const latest = (await one("SELECT id FROM booking.recording_assessments WHERE hold_id = $1 ORDER BY seq DESC LIMIT 1", [h])).id;
    const older = latest === x1.id ? x2.id : x1.id;
    assert.equal((await release(h, older)).error, "HOLD_REVIEW_NOT_LATEST");
    assert.equal((await release(h, r)).error, "HOLD_REVIEW_NOT_LATEST");
    F.ok(await release(h, latest)); }
  // duplicate concurrent openers / releases
  { const s = await setup(); F.ok(await conflict(s));
    const [a, b] = await Promise.all([open(s, "a"), open(s, "b")]);
    assert.ok(a.ok && b.ok && a.holdId === b.holdId);
    const r = F.ok(await eligibleReview(s, a.holdId)).id;
    const [x, y] = await Promise.all([release(a.holdId, r), release(a.holdId, r)]);
    assert.ok(x.ok && y.ok && x.id === y.id, "the second release waits, then replays the same decision");
    assert.equal((await decisionsOf(a.holdId)).length, 1); }
  // opener vs preflight writer: writer first (uncommitted conflict) → opener waits → opens on the committed latch
  { const s = await setup(); const p = await parts(s, { list: conflictList() });
    const k = await appClient();
    try {
      await k.query("BEGIN");
      await k.query("SELECT booking.record_recording_assessment($1, 'w1', 'conflict_marker', 'PRIOR_RECORDING_MARKER_PRESENT', $2, $3, $4, $5, $6, $7, $8, $9, $10) AS id",
        [s.opId, p.identityReadId, p.listReadId, p.identityEvidenceId, p.listEvidenceId, s.f.version, F.PROOF_MODULE_VERSION, F.PREFLIGHT_CLIENT_LABEL, F.PREFLIGHT_ACCOUNT_REF,
          JSON.stringify(F.preflightConfig(s.f))]);
      const o = open(s);
      await waitForLockWaiters(1);
      await k.query("COMMIT");
      assert.ok((await o).ok);
    } finally { await k.end(); }
    // opener first (uncommitted) → a normal preflight waits → refused (hold active)
    const s2 = await setup(); F.ok(await conflict(s2));
    const ko = await appClient();
    try {
      await ko.query("BEGIN"); await ko.query("SELECT booking.open_recording_preflight_hold($1, 'k') AS id", [s2.opId]);
      const w = rec(s2, { outcome: "identity_refused", code: "IDENTITY_FAIL_ENVELOPE", identityReadId: await idRead(s2) });
      await waitForLockWaiters(1);
      await ko.query("COMMIT");
      assert.deepEqual(await w, { ok: false, error: "ASSESSMENT_HOLD_ACTIVE" });
    } finally { await ko.end(); } }
  // lease expiry while the review waits on the work row
  { const { s, h } = await heldWithReview(); const p = await parts(s);
    const k = await appClient();
    try {
      await k.query("BEGIN");
      await k.query("UPDATE booking.intent_work SET work_lease_until = clock_timestamp() + interval '1200 milliseconds' WHERE intent_id = $1", [s.c.id]);
      const rv = errCode(review(s, h, { outcome: "eligible", ...p }).then(okOrThrow));
      await waitForLockWaiters(1); await sleep(1500); await k.query("COMMIT");
      assert.equal(await rv, "23514:ASSESSMENT_WORK_LEASE_LOST");
    } finally { await k.end(); } }
});

test("B-7b: a killed / rolled-back release leaves no decision, no release and no case change", async () => {
  const { h, r } = await heldWithReview();
  const H0 = await hold(h); const C0 = await caseOf(H0.case_id);
  const ka = await appClient(db.adminUrl2());
  try {
    await ka.query("BEGIN");
    await ka.query("SELECT booking.admin_release_preflight_hold($1, $2, 'owner', 'PREFLIGHT_RECHECKED_CLEAN', now()) AS id", [h, r]);
    await db.owner.query("SELECT pg_terminate_backend($1)", [ka.processID]);
  } catch { /* the killed client */ } finally { await ka.end().catch(() => {}); }
  await sleep(100);
  assert.deepEqual(await decisionsOf(h), []);
  assert.equal((await hold(h)).released_at, null);
  assert.deepEqual(await caseOf(H0.case_id), C0);
  F.ok(await release(h, r), "released later, once");
});

// ---- B-8: constraint probes ----------------------------------------------------------------------------------------
test("B-8: new CHECKs with triggers bypassed — NULL never satisfies; preflight reason ⇔ assessment; epoch rules; release ⇔ assessment; one preflight hold per op per epoch; one releasing decision per hold", async () => {
  const { s, h, r } = await heldWithReview();
  const H = await hold(h);
  const holdProbe = (o) => ownerTx(async (c) => {
    const x = { ...H, ...o };
    try {
      await c.query(`INSERT INTO booking.recording_holds (id, operation_id, intent_id, reason, case_id, op_state_at_hold, op_key_at_hold, intent_state_at_hold,
          intent_version_at_hold, epoch, created_at, created_by, assessment_id) VALUES (gen_random_uuid(), $1, $2, $3, $4, 'pending', 'k', 'payment_captured', 1, $5, now(), 'probe', $6)`,
        [x.operation_id, x.intent_id, x.reason, x.case_id, x.epoch, x.assessment_id]);
      return "inserted";
    } catch (e) { return e.constraint || e.code; }
  }, { replica: true });
  assert.equal(await holdProbe({ reason: "PREFLIGHT_EXHAUSTED", assessment_id: null }), "recording_holds_assessment_check");
  assert.equal(await holdProbe({ reason: "SUCCEEDED_UNPROVEN" }), "recording_holds_assessment_check");
  assert.equal(await holdProbe({ reason: "SUCCEEDED_UNPROVEN", assessment_id: null, epoch: 1 }), "recording_holds_epoch_check");
  assert.equal(await holdProbe({ epoch: -1 }), "recording_holds_epoch_check");
  assert.equal(await holdProbe({ reason: "PREFLIGHT_BOGUS", assessment_id: null }), "recording_holds_reason_check");
  assert.equal(await holdProbe({ reason: null }), "23502");
  assert.equal(await holdProbe({ epoch: null }), "23502");
  assert.equal(await holdProbe({}), "recording_holds_one_active", "one active hold per op");
  F.ok(await release(h, r));
  assert.equal(await holdProbe({ epoch: 0 }), "recording_holds_one_preflight_per_epoch", "one preflight hold per op per epoch");
  const decProbe = (decision, assessment) => ownerTx(async (c) => {
    try {
      await c.query(`INSERT INTO booking.recording_hold_decisions (id, hold_id, operation_id, case_id, intent_id, decision, evidence_ids, resolver, justification_code,
          resolver_session_user, decided_at, recorded_at, assessment_id) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, '{}', 'owner', 'X', 'probe', now(), now(), $6)`,
        [h, H.operation_id, H.case_id, H.intent_id, decision, assessment]);
      return "inserted";
    } catch (e) { return e.constraint || e.code; }
  }, { replica: true });
  assert.equal(await decProbe("release_for_initial_send", null), "recording_hold_decisions_assessment_check");
  assert.equal(await decProbe("keep_visible", r), "recording_hold_decisions_assessment_check");
  assert.equal(await decProbe("release_for_initial_send", r), "recording_hold_decisions_one_release", "one releasing decision per hold");
  assert.equal(await decProbe(null, null), "23502");
  const auditProbe = (ep) => ownerTx(async (c) => {
    try { await c.query("INSERT INTO booking.recording_claim_assessments VALUES ($1, $2, $3, 'w1', $4, now())", [s.opId, s.c.id, r, ep]); return "inserted"; }
    catch (e) { return e.constraint || e.code; }
  }, { replica: true });
  assert.equal(await auditProbe(-1), "recording_claim_assessments_epoch_check");
  assert.equal(await auditProbe(null), "23502");
  // the claim-audit guard (triggers active): an old-epoch assessment or a review is never a claim audit
  const g = await ownerTx(async (c) => {
    try { await c.query("INSERT INTO booking.recording_claim_assessments VALUES ($1, $2, $3, 'w1', 0, now())", [s.opId, s.c.id, r]); return "inserted"; }
    catch (e) { return String(e.message).split(":")[0]; }
  });
  assert.equal(g, "RECORDING_CLAIM_AUDIT_BINDING");
  // an in-flight recording (TEST SETUP: put in flight with triggers bypassed, no audit) cannot be audited against an OLD-epoch eligible row
  const z = await setup(); const ze = F.ok(await eligible(z)).id; F.ok(await conflict(z));
  const zh = F.ok(await open(z)).holdId; F.ok(await release(zh, F.ok(await eligibleReview(z, zh)).id));
  await F.ownerManagedHistory(db.owner, "UPDATE booking.external_operations SET state = 'in_flight', lease_worker_id = 'w1', lease_until = now() + interval '5 minutes', attempts = 1, dispatched_at = now() WHERE id = $1", [z.opId]);
  setupInFlight.push(z.opId);
  const old = await ownerTx(async (c) => {
    try { await c.query("INSERT INTO booking.recording_claim_assessments VALUES ($1, $2, $3, 'w1', 0, now())", [z.opId, z.c.id, ze]); return "inserted"; }
    catch (e) { return String(e.message).split(":")[0]; }
  });
  assert.equal(old, "RECORDING_CLAIM_AUDIT_BINDING", "the epoch-0 eligible row is not the current epoch");
});

// ---- B-9: privileges, private helpers, effects ----------------------------------------------------------------------
test("B-9: privilege matrix — app: open + review; admin: open + release; report: none; private helpers owner-only; SECURITY / VOLATILE / search_path; no direct writes", async () => {
  const fns = (await rows(`SELECT p.proname, coalesce(array_to_string(p.proacl, ','), '') AS acl, p.prosecdef, p.provolatile, p.proconfig
      FROM pg_proc p WHERE p.pronamespace = 'booking'::regnamespace AND p.proname IN ('open_recording_preflight_hold', 'record_release_review_assessment',
      'admin_release_preflight_hold', 'recording_preflight_epoch', 'recording_preflight_latch_citation', 'recording_assessment_input_rule', 'recording_assessment_validate',
      'record_recording_assessment', 'recording_claim_ready') ORDER BY 1`));
  assert.equal(fns.length, 9);
  const want = { open_recording_preflight_hold: [true, true, false], record_release_review_assessment: [true, false, false], admin_release_preflight_hold: [false, true, false],
    record_recording_assessment: [true, false, false], recording_claim_ready: [true, true, false] };
  for (const f of fns) {
    assert.doesNotMatch(f.acl, /(^|,)=X\//, `${f.proname}: no PUBLIC`);
    assert.deepEqual(f.proconfig, ["search_path=pg_catalog, booking"], f.proname);
    assert.equal(f.provolatile, "v", f.proname); assert.equal(f.prosecdef, true, f.proname);
    assert.deepEqual([/mv_booking_app=X/.test(f.acl), /mv_booking_admin=X/.test(f.acl), /mv_booking_report=X/.test(f.acl)], want[f.proname] || [false, false, false], f.proname);
  }
  const { s, h, r } = await heldWithReview();
  for (const [who, pool] of [["app", db.app], ["admin", db.reconciler], ["report", report]]) {
    await assert.rejects(pool.query("SELECT booking.recording_preflight_epoch($1)", [s.opId]), /permission denied/, who);
    await assert.rejects(pool.query("SELECT * FROM booking.recording_preflight_latch_citation($1)", [s.opId]), /permission denied/, who);
    await assert.rejects(pool.query("SELECT booking.recording_assessment_validate($1, 'eligible', 'eligible', NULL, $1, NULL, NULL, NULL, 'a', 'a', '{}', now(), NULL)", [s.opId]), /permission denied/, who);
    await assert.rejects(pool.query("UPDATE booking.recording_holds SET released_at = now() WHERE id = $1", [h]), /permission denied/, who);
    await assert.rejects(pool.query("DELETE FROM booking.recording_hold_decisions"), /permission denied/, who);
  }
  await assert.rejects(report.query("SELECT booking.open_recording_preflight_hold($1, 'x')", [s.opId]), /permission denied/);
  await assert.rejects(db.reconciler.query("SELECT booking.record_release_review_assessment($1, 'w1', 'eligible', NULL, NULL, NULL, NULL, NULL, 1, 'x', 'x', 'x', '{}')", [h]), /permission denied/);
  assert.equal((await release(h, r, db.app)).error, "PERMISSION_DENIED");
});

test("B-10: no effects across this file — opener / review / release created no operation, notification, refund / cancel / void or dispatched provider write", async () => {
  const n = (await one(`SELECT count(*)::int AS n FROM booking.external_operations WHERE op_type IN ('guest.notify', 'alert.owner', 'stripe.void_payment_intent',
      'hostaway.cancel_reservation') AND state <> 'pending'`)).n;
  assert.equal(n, 0);
  const inflight = (await one(`SELECT count(*)::int AS n FROM booking.external_operations o WHERE op_type = 'hostaway.record_offline_charge' AND state <> 'pending'
      AND NOT EXISTS (SELECT 1 FROM booking.recording_claim_assessments a WHERE a.operation_id = o.id) AND NOT (o.id = ANY($1::uuid[]))`, [setupInFlight])).n;
  assert.equal(inflight, 0, "every non-pending recording in this file was claimed through a claim audit");
  const attempts = (await one("SELECT count(*)::int AS n FROM booking.external_operations WHERE op_type = 'hostaway.record_offline_charge' AND idempotency_key !~ ':1$'")).n;
  assert.equal(attempts, 0, "no attempt > 1 created");
});

// ---- D: rollback ---------------------------------------------------------------------------------------------------
test("D-13: 0013 down with ONLY 0012 epoch-0 audit present == fresh cluster at 12 (bodies / ACLs / security / volatility / search_path / triggers / constraints / indexes / policies / RLS), identical re-up; EACH 0013 audit class refuses and changes nothing", async () => {
  const objects = schemaObjects;
  const d2 = await startMigratedDatabase();
  const o = new pg.Client({ connectionString: d2.adminUrl }); await o.connect();
  const fresh = await startPostgres(); const f12 = new pg.Client({ connectionString: fresh.adminUrl }); await f12.connect();
  const up13 = await freshAt(13);
  try {
    // this measures 0013 itself: every later migration (0014 … TOP; fresh cluster, no data) rolls back first — exact list + history (C26) — and is re-applied last
    await downToBoundary(o, 13);
    const at13 = await objects(o);
    assert.deepEqual(at13, await objects(up13.c), "down from the top to 13 == a fresh cluster migrated up to 13");
    // 0012-era audit present: a confirmed booking (epoch-0 preflight assessment + epoch-0 claim audit)
    const c = await F.confirmed(d2.app, { listingId: 849901, from: "2032-03-01", to: "2032-03-04" });
    assert.equal(Number((await o.query("SELECT count(*) AS n FROM booking.recording_claim_assessments")).rows[0].n), 1);
    // EACH 0013 audit class refuses (synthetic probe rows, TEST SETUP in this throwaway cluster: inserted and removed with triggers bypassed)
    const op = (await o.query("SELECT id FROM booking.external_operations WHERE intent_id = $1 AND op_type = 'hostaway.record_offline_charge'", [c.id])).rows[0].id;
    const a0 = (await o.query("SELECT * FROM booking.recording_assessments WHERE operation_id = $1", [op])).rows[0];
    const replica = async (sql, p) => F.ownerManagedHistory(d2.owner, sql, p);
    const caseId = "00000000-0000-4000-8000-0000000000c1"; const holdId = "00000000-0000-4000-8000-0000000000a1";
    const classes = [
      // each class alone (a preflight hold bound to the existing non-preflight case; a preflight case with no hold): every gate clause is observable
      ["preflight hold", `INSERT INTO booking.recording_holds (id, operation_id, intent_id, reason, case_id, op_state_at_hold, op_key_at_hold, intent_state_at_hold, intent_version_at_hold, epoch, created_at, created_by, assessment_id)
         VALUES ('${holdId}', $2, $1, 'PREFLIGHT_EXHAUSTED', '00000000-0000-4000-8000-0000000000c2', 'pending', 'k', 'payment_captured', 1, 0, now(), 'probe', $3)`, [c.id, op, a0.id],
        `DELETE FROM booking.recording_holds WHERE id = '${holdId}'`],
      ["preflight case", `INSERT INTO booking.reconciliation_cases (id, intent_id, kind, status, opened_at, opened_by, evidence) VALUES ('${caseId}', $1, 'OFFLINE_CHARGE_HOLD_PREFLIGHT_EXHAUSTED', 'open', now(), 'recording-hold:${caseId}', '{}')`, [c.id],
        `DELETE FROM booking.reconciliation_cases WHERE id = '${caseId}'`],
      ["release_review assessment", `INSERT INTO booking.recording_assessments (id, operation_id, intent_id, phase, epoch, outcome, code, identity_read_op, intent_version, worker, module_version, cfg, client_label, account_ref, recorded_at, hold_id)
         VALUES ('00000000-0000-4000-8000-0000000000b1', $1, $2, 'release_review', 0, 'identity_refused', 'IDENTITY_FAIL_ENVELOPE', gen_random_uuid(), 1, 'w', 'offline-charge-proof-v1', '{}', 'l', 'a', now(), gen_random_uuid())`, [op, c.id],
        "DELETE FROM booking.recording_assessments WHERE id = '00000000-0000-4000-8000-0000000000b1'"],
      ["epoch-1 preflight assessment", `INSERT INTO booking.recording_assessments (id, operation_id, intent_id, phase, epoch, outcome, code, identity_read_op, intent_version, worker, module_version, cfg, client_label, account_ref, recorded_at)
         VALUES ('00000000-0000-4000-8000-0000000000b2', $1, $2, 'preflight', 1, 'identity_refused', 'IDENTITY_FAIL_ENVELOPE', gen_random_uuid(), 1, 'w', 'offline-charge-proof-v1', '{}', 'l', 'a', now())`, [op, c.id],
        "DELETE FROM booking.recording_assessments WHERE id = '00000000-0000-4000-8000-0000000000b2'"],
      ["epoch-1 claim audit", "UPDATE booking.recording_claim_assessments SET epoch = 1 WHERE operation_id = $1", [op], `UPDATE booking.recording_claim_assessments SET epoch = 0 WHERE operation_id = '${op}'`],
      ["release decision", `INSERT INTO booking.recording_hold_decisions (id, hold_id, operation_id, case_id, intent_id, decision, evidence_ids, resolver, justification_code, resolver_session_user, decided_at, recorded_at, assessment_id)
         SELECT '00000000-0000-4000-8000-0000000000d1', h.id, h.operation_id, h.case_id, h.intent_id, 'release_for_initial_send', '{}', 'o', 'X', 'p', now(), now(), $1
           FROM booking.recording_holds h LIMIT 1`, [a0.id], "DELETE FROM booking.recording_hold_decisions WHERE id = '00000000-0000-4000-8000-0000000000d1'"],
    ];
    // a non-preflight hold is needed as the parent of the synthetic release decision (TEST SETUP; epoch 0, no assessment)
    await replica(`WITH k AS (INSERT INTO booking.reconciliation_cases (id, intent_id, kind, status, opened_at, opened_by, evidence) VALUES ('00000000-0000-4000-8000-0000000000c2', $1, 'OFFLINE_CHARGE_HOLD_SUCCEEDED_UNPROVEN', 'open', now(), 'recording-hold:00000000-0000-4000-8000-0000000000c2', '{}') RETURNING id)
       INSERT INTO booking.recording_holds (id, operation_id, intent_id, reason, case_id, op_state_at_hold, op_key_at_hold, intent_state_at_hold, intent_version_at_hold, created_at, created_by,
         released_at, release_decision_id)
       SELECT '00000000-0000-4000-8000-0000000000a2', $2, $1, 'SUCCEEDED_UNPROVEN', k.id, 'succeeded', 'k', 'confirmed', 1, now(), 'probe', now(), gen_random_uuid() FROM k`, [c.id, op]);
    for (const [name, ins, p, del] of classes) {
      await replica(ins, p);
      await assert.rejects(migrateDown(o, { env: "test", to: 12 }), /DOWNGRADE_REFUSED_RECORDING_PREFLIGHT_RELEASE_AUDIT/, name);
      assert.deepEqual(await objects(o), at13, `${name}: nothing changed`);
      for (const q of del.split("; ")) await replica(q);
    }
    // only 0012 audit (and a 0011 non-preflight hold) remain: 0013 rolls back to exactly a fresh 12, then re-applies identically
    assert.deepEqual(await migrateDown(o, { env: "test", to: 12 }), [13]);
    assert.deepEqual(await migrateUp(f12, { env: "test", to: 12 }), range(1, 12));
    assert.deepEqual(await objects(o), await objects(f12), "down 0013 == fresh cluster at 12");
    assert.equal(Number((await o.query("SELECT count(*) AS n FROM booking.recording_claim_assessments")).rows[0].n), 1, "0012 audit preserved");
    assert.deepEqual(await migrateUp(o, { env: "test", to: 13 }), [13]);
    assert.deepEqual(await objects(o), at13, "re-up identical");
    await upFromBoundary(o, 13);
  } finally { await o.end(); await f12.end(); fresh.stop(); await up13.close(); await d2.close(); }
});
