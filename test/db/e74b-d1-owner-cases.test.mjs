// Stage E7.4b-D1 — migration 0011: durable case-only OWNER HOLDS for Hostaway payment recordings (contract r2 + root addendum A–D).
// Throwaway local PostgreSQL; repository code runs as the runtime login (test_app ∈ mv_booking_app), owner decisions as test_admin
// (∈ mv_booking_admin); the schema owner (postgres) only for setup, probes and explicitly-labelled owner-managed HISTORY (triggers
// bypassed). Every provider observation is a SYNTHETIC fixture; no provider, notification or network call exists in this file.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { readFileSync } from "node:fs";
import { startMigratedDatabase } from "./harness.mjs";
import * as F from "./fixtures.mjs";
import { applyEvent, applyResolution } from "../../db/lib/repo.js";
import { claimNextOperation, completeOperation, completeRecordingWithEvidence, linkRecordingEvidence, listRecordingContradictions, requestRead,
  recordProviderEvidence, openRecordingVisibilityHold, drainRecordingConflictInbox } from "../../db/lib/operations.js";
import { adminResolveOperation, adminResolveIntent, adminCloseCase, adminResolveRecordingHold } from "../../db/lib/admin.js";
import { migrateDown, migrateUp } from "../../db/lib/migrate.js";

let db;
before(async () => { db = await startMigratedDatabase(); });
after(async () => { await db.close(); });

const MIN = 60 * 1000;
const OCH = ["hostaway.record_offline_charge"];
let stayN = 0;
const stay = () => { stayN += 1; const d = new Date(Date.UTC(2029, 0, 1) + stayN * 6 * 86400000).toISOString().slice(0, 10);
  const e = new Date(Date.UTC(2029, 0, 1) + (stayN * 6 + 3) * 86400000).toISOString().slice(0, 10); return { listingId: 790000 + stayN, from: d, to: e }; };
let idN = 993000;
const cid = () => String(++idN);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const row = async (id) => (await db.app.query("SELECT * FROM booking.external_operations WHERE id = $1", [id])).rows[0];
const facts = async (id) => (await db.app.query("SELECT version, listing_id, state, offline_charge_id FROM booking.intents WHERE id = $1", [id])).rows[0];
const effects = async (id) => Number((await db.app.query("SELECT count(*) AS n FROM booking.external_operations WHERE intent_id = $1 AND retry_class <> 'read'", [id])).rows[0].n);
const snapshot = async (c) => ({ intent: await facts(c.id), effects: await effects(c.id),
  ops: (await db.app.query(`SELECT id, state, dispatched_at, settled_evidence_id, result_ref, attempts, resolution_id FROM booking.external_operations
                             WHERE intent_id = $1 AND retry_class <> 'read' ORDER BY id`, [c.id])).rows });
const obs = (c, id, o = {}) => F.recordingObserved(c, id, o);
const cnt = (ids) => ({ matchingChargeCount: ids.length, matchingChargeIds: ids.map(String) });
const evAt = (c, observed, t = Date.now()) => F.chargeListEvidence(db.app, c, observed, t);
const dash = async (c, ref, observed, at, reference = "dash") => (await db.reconciler.query(
  "SELECT booking.admin_record_evidence($1,'hostaway_offline_charges',$2,'listed',$3,$4::timestamptz,'owner',$5) AS id", [c.id, String(ref), observed, at, reference])).rows[0].id;
async function apiOtherRef(c, ref, observed, t = Date.now()) {
  const rid = await requestRead(db.app, c.id, "hostaway.list_offline_charges", String(ref), { now: t });
  assert.ok(await claimNextOperation(db.app, { workerId: "w-read", now: t, opId: rid }));
  F.ok(await completeOperation(db.app, rid, { workerId: "w-read", now: t, outcome: { status: "succeeded" } }));
  return F.ok(await recordProviderEvidence(db.app, { readOpId: rid, kind: "hostaway_offline_charges", externalRef: String(ref), status: "listed", observed })).id;
}
async function capturedIntent() { const st = stay(); const c = await F.captured(db.app, st); const f = await facts(c.id); return { ...c, ...st, listingId: f.listing_id }; }
async function claimed({ leaseMs = 10 * MIN } = {}) {
  const c = await capturedIntent(); const t = Date.now();
  await db.app.query("UPDATE booking.intent_work SET work_worker_id = 'w1', work_lease_until = $2 WHERE intent_id = $1", [c.id, new Date(t + 10 * MIN)]);
  const op = await F.claimHealthyRecording(db.app, { workerId: "w1", now: t, intentId: c.id, opTypes: OCH, leaseMs });
  assert.ok(op, "attempt 1 claimable");
  return { c, op, t };
}
async function linked() {
  const { c, op, t } = await claimed(); const id = cid();
  const proof = await evAt(c, obs(c, id), t + 5);
  F.ok(await completeRecordingWithEvidence(db.app, op.id, { workerId: "w1", evidenceId: proof, resultRef: id, expectedVersion: (await facts(c.id)).version }));
  return { c, op, t, proof, id };
}
/** dispatched at F.at(9), owner-resolved succeeded from count-only API evidence, unlinked */
async function ownerSucceededUnlinked() {
  const c = await capturedIntent(); const id = cid();
  const op = await F.claimHealthyRecording(db.app, { workerId: "w1", now: F.at(9), intentId: c.id, opTypes: OCH });
  F.ok(await completeOperation(db.app, op.id, { workerId: "w1", now: F.at(9.2), outcome: { status: "outcome_unknown" } }));
  const ev0 = await F.readEvidence(db.app, c.id, "hostaway_offline_charges", String(c.reservationId), "listed", cnt([id]), 30);
  F.ok(await adminResolveOperation(db.reconciler, { operationId: op.id, decision: "succeeded", evidenceIds: [ev0], resultRef: Number(id), resolver: "owner",
    justification: "CHARGE_FOUND_IN_HOSTAWAY", at: F.at(60) }));
  return { c, op: await row(op.id), id, ev0 };
}
/** genuine E3 path: attempt 1 owner-failed, OFFLINE_CHARGE_FAILED queues attempt 2 (pending, never dispatched) */
async function attempt2Pending() {
  const c = await capturedIntent();
  const a1 = await F.claimHealthyRecording(db.app, { workerId: "w1", now: F.at(9), intentId: c.id, opTypes: OCH });
  F.ok(await completeOperation(db.app, a1.id, { workerId: "w1", now: F.at(9.2), outcome: { status: "outcome_unknown" } }));
  const api = await F.readEvidence(db.app, c.id, "hostaway_offline_charges", String(c.reservationId), "listed", cnt([]), 40);
  const dsh = await F.dashboardEvidence(db.reconciler, c.id, "hostaway_offline_charges", String(c.reservationId), "listed", cnt([]), 45);
  F.ok(await adminResolveOperation(db.reconciler, { operationId: a1.id, decision: "failed_definite", evidenceIds: [api, dsh], resolver: "owner",
    justification: "NO_CHARGE_IN_HOSTAWAY", at: F.at(60) }));
  F.ok(await applyEvent(db.app, c.id, { type: "OFFLINE_CHARGE_FAILED" }, { now: F.at(61) }));
  const a2 = (await db.app.query("SELECT * FROM booking.external_operations WHERE intent_id = $1 AND op_type = $2 AND state = 'pending'", [c.id, OCH[0]])).rows[0];
  assert.ok(a2 && a2.idempotency_key.endsWith(":2"));
  return { c, a1, a2, api, dsh };
}
const drainAll = async (pool = db.app) => {
  let total = { processed: [], errors: [], drained: false, stoppedOnRepeatedError: false, calls: 0 };
  for (let k = 0; k < 50; k++) {
    const o = await drainRecordingConflictInbox(pool, { by: "test-drain" });
    total = { processed: [...total.processed, ...o.processed], errors: [...total.errors, ...o.errors],
      drained: o.drained, stoppedOnRepeatedError: o.stoppedOnRepeatedError, calls: total.calls + o.calls };
    if (o.drained || o.stoppedOnRepeatedError) return total;
  }
  return total;
};
const inbox = async (ev) => (await db.owner.query("SELECT * FROM booking.recording_conflict_inbox WHERE evidence_id = $1", [ev])).rows[0];
const holdsOf = async (intentId) => (await db.owner.query("SELECT * FROM booking.recording_holds WHERE intent_id = $1 ORDER BY created_at, id", [intentId])).rows;
const caseRow = async (id) => (await db.owner.query("SELECT * FROM booking.reconciliation_cases WHERE id = $1", [id])).rows[0];
const obsOf = async (holdId) => (await db.owner.query("SELECT evidence_id FROM booking.recording_hold_observations WHERE hold_id = $1 ORDER BY recorded_at, id", [holdId])).rows.map((x) => x.evidence_id);
async function waitForLockWaiters(n = 1, timeoutMs = 5000) {
  const t0 = Date.now();
  for (;;) {
    const r = await db.owner.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`);
    if (r.rows[0].n >= n) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`no lock waiter observed within ${timeoutMs} ms`);
    await sleep(10);
  }
}
const waitingLockTypes = async () => (await db.owner.query("SELECT DISTINCT locktype FROM pg_locks WHERE NOT granted ORDER BY 1")).rows.map((x) => x.locktype);
async function asOwnerClient() { const c = new pg.Client({ connectionString: db.adminUrl }); await c.connect(); return c; }
async function asAppClient() { const c = new pg.Client({ connectionString: db.appUrl() }); await c.connect(); return c; }
/** owner transaction expected to FAIL (at statement or at COMMIT); returns the error */
async function ownerTxError(fn) {
  const c = await asOwnerClient();
  try { await c.query("BEGIN"); await fn(c); await c.query("COMMIT"); return null; }
  catch (e) { await c.query("ROLLBACK").catch(() => {}); return e; }
  finally { await c.end(); }
}
/** HISTORY / probe setup only: an artificial hold + bound case written with every trigger bypassed */
async function artificialHold(c, opId, reason) {
  const caseId = (await db.owner.query("SELECT gen_random_uuid() AS id")).rows[0].id;
  const holdId = (await db.owner.query("SELECT gen_random_uuid() AS id")).rows[0].id;
  const o = await row(opId); const f = await facts(c.id);
  await F.ownerManagedHistory(db.owner, `WITH k AS (INSERT INTO booking.reconciliation_cases (id, intent_id, kind, status, opened_at, opened_by, evidence)
      VALUES ($1::uuid, $3::uuid, 'OFFLINE_CHARGE_HOLD_' || $5::text, 'open', now(), 'recording-hold:' || $1::uuid::text, '{}'::jsonb) RETURNING id)
    INSERT INTO booking.recording_holds (id, operation_id, intent_id, reason, case_id, op_state_at_hold, op_key_at_hold, intent_state_at_hold,
      intent_version_at_hold, created_at, created_by) SELECT $2::uuid, $4::uuid, $3::uuid, $5::text, k.id, $6::text, $7::text, $8::text, $9::integer, now(), 'probe' FROM k`,
    [caseId, holdId, c.id, opId, reason, o.state, o.idempotency_key, f.state, f.version]);
  return { caseId, holdId };
}
const removeArtificialHold = (h) => F.ownerManagedHistory(db.owner,
  "WITH d AS (DELETE FROM booking.recording_holds WHERE id = $1 RETURNING case_id) DELETE FROM booking.reconciliation_cases WHERE id IN (SELECT case_id FROM d)", [h.holdId]);
const keepVisible = (holdId, o = {}) => adminResolveRecordingHold(db.reconciler, { holdId, decision: "keep_visible", evidenceIds: [], resolver: "owner",
  justification: "OWNER_REVIEWING", at: F.at(100), ...o });

// =============================================================================================
test("T-A1: no role can write the owner-hold tables directly; append-only / frozen rows hold even for the schema owner", async () => {
  const { c, op } = await ownerSucceededUnlinked();
  const h = F.ok(await openRecordingVisibilityHold(db.app, op.id, { reason: "SUCCEEDED_UNPROVEN", by: "t" }));
  const report = new pg.Pool({ connectionString: db.reportUrl(), max: 1 });
  try {
    for (const [pool, who] of [[db.app, "app"], [db.reconciler, "admin"], [report, "report"]]) {
      for (const sql of [
        ["INSERT INTO booking.recording_holds (id, operation_id, intent_id, reason, case_id, op_state_at_hold, op_key_at_hold, intent_state_at_hold, intent_version_at_hold, created_at, created_by) VALUES (gen_random_uuid(), $1, $2, 'SUCCEEDED_UNPROVEN', $3, 's', 'k', 's', 1, now(), 'x')", [op.id, c.id, (await holdsOf(c.id))[0].case_id]],
        ["UPDATE booking.recording_holds SET released_at = now() WHERE id = $1", [h.holdId]],
        ["DELETE FROM booking.recording_conflict_inbox", []],
        ["UPDATE booking.recording_conflict_inbox SET attempts = attempts + 1", []],
        ["INSERT INTO booking.recording_hold_decisions (id, hold_id, operation_id, case_id, intent_id, decision, resolver, justification_code, resolver_session_user, decided_at, recorded_at) VALUES (gen_random_uuid(), $1, $2, $3, $4, 'keep_visible', 'x', 'X', 'x', now(), now())", [h.holdId, op.id, (await holdsOf(c.id))[0].case_id, c.id]],
        ["INSERT INTO booking.recording_hold_observations (id, hold_id, evidence_id, recorded_at) VALUES (gen_random_uuid(), $1, $2, now())", [h.holdId, (await row(op.id)).id]]]) {
        await assert.rejects(pool.query(...sql), (e) => e.code === "42501", `${who}: ${sql[0].slice(0, 40)}`);
      }
      assert.ok((await pool.query("SELECT count(*) FROM booking.recording_holds")).rows[0], `${who}: SELECT allowed`);
    }
  } finally { await report.end(); }
  // schema owner (bypasses RLS / grants): the guards and append-only triggers still refuse
  F.ok(await keepVisible(h.holdId));
  for (const sql of ["UPDATE booking.recording_hold_decisions SET resolver = 'x'", "DELETE FROM booking.recording_hold_decisions", "TRUNCATE booking.recording_hold_observations",
    "TRUNCATE booking.recording_holds CASCADE", "DELETE FROM booking.recording_conflict_inbox"]) {
    await assert.rejects(db.owner.query(sql), (e) => e.code === "55000" || e.code === "23001" || /not allowed/.test(e.message), sql);
  }
  await assert.rejects(db.owner.query("UPDATE booking.recording_holds SET reason = 'ATTEMPT_GT1' WHERE id = $1", [h.holdId]), /RECORDING_HOLD_IMMUTABLE/);
  await assert.rejects(db.owner.query("UPDATE booking.recording_holds SET created_by = 'x' WHERE id = $1", [h.holdId]), /RECORDING_HOLD_IMMUTABLE/);
  const done = (await db.owner.query("SELECT evidence_id FROM booking.recording_conflict_inbox WHERE processed_at IS NOT NULL LIMIT 1")).rows[0]
    ?? (await drainAll(), (await db.owner.query("SELECT evidence_id FROM booking.recording_conflict_inbox WHERE processed_at IS NOT NULL LIMIT 1")).rows[0]);
  await assert.rejects(db.owner.query("UPDATE booking.recording_conflict_inbox SET outcome = 'consistent' WHERE evidence_id = $1", [done.evidence_id]), /RECORDING_INBOX_IMMUTABLE/);
});

test("T-A2 (addendum A): reserved cases — app INSERT refused; privileged open+unbound / resolved+unbound / wrong opened_by / orphan / mismatched / repurposed refused at statement or COMMIT", async () => {
  const { c, op } = await ownerSucceededUnlinked();
  const app = await asAppClient();
  try {
    await assert.rejects(app.query(`INSERT INTO booking.reconciliation_cases (id, intent_id, kind, status, opened_at, opened_by, evidence)
      VALUES (gen_random_uuid(), $1, 'OFFLINE_CHARGE_HOLD_SUCCEEDED_UNPROVEN', 'open', now(), 'x', '{}')`, [c.id]), (e) => e.code === "42501" && /RESERVED_CASE_KIND/.test(e.message));
  } finally { await app.end(); }
  const ins = (cc, { kind = "OFFLINE_CHARGE_HOLD_SUCCEEDED_UNPROVEN", status = "open", openedBy = null, intent = c.id } = {}) => cc.query(
    `INSERT INTO booking.reconciliation_cases (id, intent_id, kind, status, opened_at, opened_by, evidence, resolution, resolved_by, resolved_at)
     SELECT x.id, $1, $2, $3, now(), coalesce($4, 'recording-hold:' || x.id::text), '{}',
            CASE WHEN $3 = 'resolved' THEN 'recorded' END, CASE WHEN $3 = 'resolved' THEN 'o' END, CASE WHEN $3 = 'resolved' THEN now() END
       FROM (SELECT gen_random_uuid() AS id) x RETURNING id`, [intent, kind, status, openedBy]);
  assert.match((await ownerTxError((cc) => ins(cc))).message, /RESERVED_CASE_BINDING: a reserved case needs at least one bound hold/, "open + unbound: refused at COMMIT");
  assert.match((await ownerTxError((cc) => ins(cc, { status: "resolved" }))).message, /RESERVED_CASE_BINDING/, "resolved + unbound: refused");
  assert.match((await ownerTxError((cc) => ins(cc, { openedBy: "recording-hold:other" }))).message, /RESERVED_CASE_BINDING/, "opened_by must be recording-hold:<case id>");
  assert.match((await ownerTxError((cc) => ins(cc, { kind: "OFFLINE_CHARGE_HOLD_PREFLIGHT_EXHAUSTED" }))).message, /RESERVED_CASE_BINDING/, "0012 kinds do not exist");
  // a valid hold + case, then probes against it
  const h = F.ok(await openRecordingVisibilityHold(db.app, op.id, { reason: "SUCCEEDED_UNPROVEN", by: "t" }));
  const caseId = (await holdsOf(c.id))[0].case_id;
  const hold = (await holdsOf(c.id))[0];
  const holdSql = (cc, caseRef, intent = c.id, opId = op.id, reason = "SUCCEEDED_UNPROVEN") => cc.query(`INSERT INTO booking.recording_holds (id, operation_id, intent_id, reason, case_id,
      op_state_at_hold, op_key_at_hold, intent_state_at_hold, intent_version_at_hold, created_at, created_by) VALUES (gen_random_uuid(), $1, $2, $3, $4, 's', 'k', 's', 1, now(), 'probe')`,
    [opId, intent, reason, caseRef]);
  const other = await ownerSucceededUnlinked();
  // orphan / mismatched holds
  const normalCase = (await db.owner.query(`INSERT INTO booking.reconciliation_cases (id, intent_id, kind, status, opened_at, opened_by) VALUES (gen_random_uuid(), $1, 'PROBE_CASE', 'open', now(), 'probe') RETURNING id`, [other.c.id])).rows[0].id;
  assert.match((await ownerTxError((cc) => holdSql(cc, normalCase, other.c.id, other.op.id))).message, /RESERVED_CASE_BINDING: a hold is bound only to a reserved/, "hold bound to a non-reserved case");
  assert.match((await ownerTxError((cc) => holdSql(cc, caseId, other.c.id, other.op.id))).message, /RESERVED_CASE_BINDING: a bound hold must match the case intent and kind/, "hold of another intent bound to this case");
  assert.match((await ownerTxError((cc) => holdSql(cc, "00000000-0000-4000-8000-000000000000", other.c.id, other.op.id))).message, /foreign key/, "orphan hold");
  assert.match((await ownerTxError((cc) => holdSql(cc, caseId, c.id, other.op.id))).message, /RECORDING_HOLD_BINDING/, "hold of another intent's operation");
  // repurpose / resolve / reopen the reserved case directly
  for (const sql of ["UPDATE booking.reconciliation_cases SET kind = 'OFFLINE_CHARGE_HOLD_ATTEMPT_GT1' WHERE id = $1",
    "UPDATE booking.reconciliation_cases SET opened_by = 'probe' WHERE id = $1", "UPDATE booking.reconciliation_cases SET evidence = '{\"x\":1}' WHERE id = $1",
    "UPDATE booking.reconciliation_cases SET intent_id = (SELECT intent_id FROM booking.reconciliation_cases WHERE id <> $1 LIMIT 1) WHERE id = $1"]) {
    assert.match((await ownerTxError((cc) => cc.query(sql, [caseId]))).message, /RESERVED_CASE_IMMUTABLE/, sql);
  }
  assert.match((await ownerTxError((cc) => cc.query(`UPDATE booking.reconciliation_cases SET status = 'resolved', resolution = 'recorded', resolved_by = 'o', resolved_at = now() WHERE id = $1`, [caseId]))).message,
    /RESERVED_CASE_BINDING: a hold case is open exactly while one of its holds is active/, "resolve while the hold is active");
  assert.match((await ownerTxError((cc) => cc.query("UPDATE booking.reconciliation_cases SET kind = 'OFFLINE_CHARGE_HOLD_ATTEMPT_GT1' WHERE id = $1", [normalCase]))).message,
    /RESERVED_CASE_IMMUTABLE/, "a normal case cannot become reserved");
  // un-release / re-release / mismatched release (owner role, direct)
  assert.match((await ownerTxError((cc) => cc.query("UPDATE booking.recording_holds SET released_at = now(), release_decision_id = gen_random_uuid() WHERE id = $1", [h.holdId]))).message,
    /RECORDING_HOLD_BINDING|foreign key/);
  const kv = F.ok(await keepVisible(h.holdId));
  assert.match((await ownerTxError((cc) => cc.query("UPDATE booking.recording_holds SET released_at = now(), release_decision_id = $2 WHERE id = $1", [h.holdId, kv.id]))).message,
    /RECORDING_HOLD_BINDING: a release cites this hold's own releasing owner decision/, "keep_visible never releases");
  assert.equal((await caseRow(caseId)).status, "open");
  assert.equal(hold.released_at, null);
});

test("T-A3: unrelated owner resolution cannot close or repurpose a hold case — admin_close_case refused; admin_resolve_intent + RESOLVE leaves the hold case OPEN", async () => {
  const { c, op } = await ownerSucceededUnlinked();
  const h = F.ok(await openRecordingVisibilityHold(db.app, op.id, { reason: "SUCCEEDED_UNPROVEN", by: "t" }));
  const caseId = (await holdsOf(c.id))[0].case_id;
  const ev = (await db.app.query("SELECT id FROM booking.provider_evidence WHERE intent_id = $1 LIMIT 1", [c.id])).rows[0].id;
  assert.equal((await adminCloseCase(db.reconciler, { caseId, evidenceIds: [ev], resolver: "owner", justification: "X", at: F.at(70) })).error,
    "HOLD_CASE_USE_ADMIN_RESOLVE_RECORDING_HOLD");
  // the intent goes through reconciliation and is resolved by the owner: every OTHER open case is resolved, the hold case stays
  F.ok(await applyEvent(db.app, c.id, { type: "ESCALATE", code: "TEST_ESCALATION" }, { now: F.at(71) }));
  assert.equal((await facts(c.id)).state, "reconciliation_required");
  const probe = (await db.app.query(`INSERT INTO booking.reconciliation_cases (id, intent_id, kind, status, opened_at, opened_by) VALUES (gen_random_uuid(), $1, 'PROBE_OTHER_CASE', 'open', now(), 'probe') RETURNING id`, [c.id])).rows[0].id;
  const found = await F.reservationStatus(db.app, c.id, String(c.reservationId), "found_active", { listingId: c.listingId, from: c.from, to: c.to, totalMinor: 576000 }, 72);
  const paid = await F.piStatus(db.app, c.id, c.piId, "succeeded", { amountReceivedMinor: 576000 }, 73);
  const res = F.ok(await adminResolveIntent(db.reconciler, { intentId: c.id, decision: "confirmed", evidenceIds: [found, paid], resultRef: String(c.reservationId),
    resolver: "owner", justification: "BOOKED", at: F.at(74) }));
  F.ok(await applyResolution(db.app, c.id, res.id, { now: F.at(75) }));
  assert.equal((await facts(c.id)).state, "confirmed");
  assert.equal((await caseRow(probe)).status, "resolved", "intents_safety_guard still resolves every other open case");
  assert.equal((await caseRow(caseId)).status, "open", "the hold case stays open and visible");
  assert.equal((await holdsOf(c.id))[0].released_at, null);
  assert.equal(h.holdId, (await holdsOf(c.id))[0].id);
});

test("T-B1/B2: the recording claim fence covers every claim path — attempt 2 (genuine E3 path), an active hold / open hold case on attempt 1, payload / intent mismatch; a healthy attempt 1 claims", async () => {
  const { c, a2 } = await attempt2Pending();
  const paths = async (cc, opId) => [
    await claimNextOperation(db.app, { workerId: "w9", now: Date.now(), intentId: cc.id, opTypes: OCH }),
    await claimNextOperation(db.app, { workerId: "w9", now: Date.now(), opId }),
    await claimNextOperation(db.app, { workerId: "w9", now: Date.now(), opTypes: OCH, intentId: cc.id })];
  assert.deepEqual(await paths(c, a2.id), [null, null, null], "attempt 2: skipped by the mirrored fragment");
  const direct = (opId) => db.app.query(`UPDATE booking.external_operations SET state = 'in_flight', lease_worker_id = 'w9', lease_until = now() + interval '5 minutes',
      attempts = attempts + 1, dispatched_at = now(), updated_at = now() WHERE id = $1`, [opId]);
  await assert.rejects(direct(a2.id), /RECORDING_CLAIM_FENCED: only the never-dispatched initial attempt/);
  assert.equal((await row(a2.id)).state, "pending");
  // attempt 1 under an (artificial) active hold: every path refused
  const c1 = await capturedIntent();
  const op1 = (await db.app.query("SELECT * FROM booking.external_operations WHERE intent_id = $1 AND op_type = $2", [c1.id, OCH[0]])).rows[0];
  // 0012: a real eligible assessment exists first, so the refusal below is the 0011 hold (the assessment alone would qualify)
  await db.app.query("UPDATE booking.intent_work SET work_worker_id = 'w9', work_lease_until = $2 WHERE intent_id = $1", [c1.id, new Date(Date.now() + 10 * MIN)]);
  F.ok((await F.preflight(db.app, c1.id, op1.id, { workerId: "w9" })).r, "eligible assessment");
  const h = await artificialHold(c1, op1.id, "ATTEMPT_GT1");
  assert.deepEqual(await paths(c1, op1.id), [null, null, null]);
  await assert.rejects(direct(op1.id), /RECORDING_CLAIM_FENCED: an owner hold is active/);
  await removeArtificialHold(h);
  // payload / intent bindings (history setup): amount mismatch, intent not payment_captured
  const c2 = await capturedIntent();
  const op2 = (await db.app.query("SELECT * FROM booking.external_operations WHERE intent_id = $1 AND op_type = $2", [c2.id, OCH[0]])).rows[0];
  await db.app.query("UPDATE booking.intent_work SET work_worker_id = 'w9', work_lease_until = $2 WHERE intent_id = $1", [c2.id, new Date(Date.now() + 10 * MIN)]);
  F.ok((await F.preflight(db.app, c2.id, op2.id, { workerId: "w9" })).r, "eligible assessment (0012); the payload binding alone fences");
  await F.ownerManagedHistory(db.owner, "UPDATE booking.external_operations SET payload = payload || '{\"amountMinor\": 1}'::jsonb WHERE id = $1", [op2.id]);
  assert.deepEqual(await paths(c2, op2.id), [null, null, null]);
  await assert.rejects(direct(op2.id), /RECORDING_CLAIM_FENCED: payload/);
  // healthy attempt 1: allowed by every path (helper)
  const c3 = await capturedIntent();
  const op3 = await F.claimHealthyRecording(db.app, { workerId: "w9", now: Date.now(), intentId: c3.id, opTypes: OCH });
  assert.ok(op3 && op3.idempotency_key.endsWith(":1"), "healthy attempt 1 is claimable");
  // unrelated op types are unchanged (a read claims normally)
  const rid = await requestRead(db.app, c3.id, "hostaway.list_offline_charges", String(c3.reservationId), { now: Date.now() });
  assert.ok(await claimNextOperation(db.app, { workerId: "w-read", now: Date.now(), opId: rid }));
});

test("T-B3: direct UPDATE claim inversion vs an applyEvent-ordered transaction gives a bounded 40P01 on one side; the fence is never bypassed (no in_flight row)", async () => {
  const { c, a2 } = await attempt2Pending();
  const k1 = await asAppClient(); const k2 = await asAppClient();
  const res = [];
  try {
    await k1.query("BEGIN"); await k1.query("SELECT 1 FROM booking.intents WHERE id = $1 FOR NO KEY UPDATE", [c.id]);   // applyEvent's first lock
    await k2.query("BEGIN");
    const p2 = k2.query(`UPDATE booking.external_operations SET state = 'in_flight', lease_worker_id = 'w9', lease_until = now() + interval '5 minutes',
        attempts = attempts + 1, dispatched_at = now(), updated_at = now() WHERE id = $1`, [a2.id]).then(() => "ok", (e) => e.code + ":" + e.message.split(":")[0]);
    await waitForLockWaiters(1);
    const p1 = k1.query("SELECT 1 FROM booking.external_operations WHERE id = $1 FOR SHARE", [a2.id]).then(() => "ok", (e) => e.code + ":" + e.message.split(":")[0]);
    res.push(...await Promise.all([p1, p2]));
  } finally { await k1.query("ROLLBACK").catch(() => {}); await k2.query("ROLLBACK").catch(() => {}); await k1.end(); await k2.end(); }
  const deadlocks = res.filter((x) => x.startsWith("40P01")).length;
  assert.ok(deadlocks <= 1, JSON.stringify(res));
  assert.ok(res.every((x) => x === "ok" || x.startsWith("40P01") || /RECORDING_CLAIM_FENCED/.test(x)), JSON.stringify(res));
  assert.ok(!res.includes("ok") || res[1] !== "ok", "the direct claim of attempt 2 never succeeds");
  assert.equal((await row(a2.id)).state, "pending", "never in_flight");
  console.log(`# T-B3 observed outcomes: ${JSON.stringify(res)}`);
});

test("T-B4: an active hold refuses app link / completion / finalisation (RECORDING_HOLD_ACTIVE); a same-link replay stays a read-only no-op; the owner path is separate", async () => {
  // SUCCEEDED_UNPROVEN: the app link is refused while held
  const u = await ownerSucceededUnlinked();
  F.ok(await openRecordingVisibilityHold(db.app, u.op.id, { reason: "SUCCEEDED_UNPROVEN", by: "t" }));
  const proof = await evAt(u.c, obs(u.c, u.id), F.at(40));
  assert.deepEqual(await linkRecordingEvidence(db.app, u.op.id, { evidenceId: proof }), { ok: false, error: "RECORDING_HOLD_ACTIVE" });
  assert.equal((await row(u.op.id)).settled_evidence_id, null);
  // completion with an (artificial) hold on the in-flight row
  const { c, op, t } = await claimed();
  const id = cid(); const ev = await evAt(c, obs(c, id), t + 5);
  const h = await artificialHold(c, op.id, "ATTEMPT_GT1");
  assert.deepEqual(await completeRecordingWithEvidence(db.app, op.id, { workerId: "w1", evidenceId: ev, resultRef: id, expectedVersion: (await facts(c.id)).version }),
    { ok: false, error: "RECORDING_HOLD_ACTIVE" });
  assert.equal((await row(op.id)).state, "in_flight");
  await removeArtificialHold(h);
  // LINKED_CONTRADICTED: finalisation refused (helper mirror AND direct DB update); link replay = already_linked (no write)
  const l = await linked();
  const bad = await evAt(l.c, cnt([cid()]));
  await drainAll();
  assert.equal((await holdsOf(l.c.id))[0].reason, "LINKED_CONTRADICTED");
  assert.equal((await applyEvent(db.app, l.c.id, { type: "OFFLINE_CHARGE_RECORDED", chargeId: l.id }, { now: Date.now() })).error, "RECORDING_HOLD_ACTIVE");
  await assert.rejects(db.app.query("UPDATE booking.intents SET state = 'confirmed', offline_charge_id = $2, version = version + 1 WHERE id = $1", [l.c.id, l.id]),
    /RECORDING_HOLD_ACTIVE/);
  const before = await row(l.op.id);
  assert.deepEqual(await linkRecordingEvidence(db.app, l.op.id, { evidenceId: l.proof }), { ok: true, state: "already_linked" });
  assert.deepEqual(await row(l.op.id), before, "replay wrote nothing");
  assert.equal((await facts(l.c.id)).state, "payment_captured");
  assert.ok(bad);
});

const SRC10 = readFileSync(new URL("../../db/migrations/0010_recording_evidence_link.up.sql", import.meta.url), "utf8");
const BODY10 = SRC10.slice(SRC10.indexOf("CREATE FUNCTION booking.recording_conflict_refusal("), SRC10.indexOf("END $$;", SRC10.indexOf("CREATE FUNCTION booking.recording_conflict_refusal(")) + 7);
test("T-P1/P2: the explicit-reference core and the 0011 wrapper agree EXACTLY with the 0010 predicate (copied from the 0010 file) in candidate-unlinked and linked contexts", async () => {
  const o = await asOwnerClient();
  try {
    await o.query(BODY10.replace("CREATE FUNCTION booking.recording_conflict_refusal(", "CREATE FUNCTION pg_temp.ref_refusal("));
    await o.query(BODY10.replace("CREATE FUNCTION booking.recording_conflict_refusal(", "CREATE FUNCTION pg_temp.ref_rows(").replace("RETURNS text", "RETURNS SETOF uuid")
      .replace(/RETURN 'CONFLICT_CHECK_INPUT';/g, "RETURN;").replace("SELECT count(*) INTO n FROM booking.provider_evidence e", "RETURN QUERY SELECT e.id FROM booking.provider_evidence e")
      .replace("  RETURN CASE WHEN n > 0 THEN 'POSITIVE_CONTRADICTION' END;", "  RETURN;"));
    // context 1 (candidate-unlinked): an in-flight recording; context 2 (linked)
    const cand = await claimed();
    const lk = await linked();
    let compared = 0;
    for (const ctx of [{ ...cand, id: cid() }, lk]) {
      const { c, t } = ctx; const id = ctx.id;
      const rows = [];
      const fullA = await evAt(c, obs(c, id), t + 10);
      const fullB = await evAt(c, obs(c, id, { paymentMethod: "other" }), t + 20);
      const fullC = await evAt(c, obs(c, id, { executorAccountRef: "acct-test-2" }), t + 30);
      rows.push(fullA, fullB, fullC, await evAt(c, cnt([id]), t + 40), await evAt(c, cnt([cid()]), t + 50), await evAt(c, cnt([]), t + 60),
        await evAt(c, { ...obs(c, cid()), marker: "mvoch1-00000000-0000-4000-8000-000000000000" }, t + 70), await apiOtherRef(c, `9${c.reservationId}`, cnt([cid()]), t + 80),
        await evAt(c, obs(c, id, { amountMinor: 1 }), t + 90), await evAt(c, cnt([id, cid()]), t + 100),
        await dash(c, c.reservationId, cnt([cid()]), new Date(t + 110)), await dash(c, c.reservationId, cnt([id]), new Date(t - 60000)));
      const refs = [fullA, fullB, fullC, ...(ctx.proof ? [ctx.proof] : [])];
      for (const reference of refs) for (const result of [id, cid()]) for (const disp of [new Date(t), new Date(t + 45)]) {
        const args = [c.id, disp, result, reference];
        const ref = (await o.query("SELECT pg_temp.ref_refusal($1, $2, $3, $4) AS r", args)).rows[0].r;
        const now = (await o.query("SELECT booking.recording_conflict_refusal($1, $2, $3, $4) AS r", args)).rows[0].r;
        assert.equal(now, ref, `wrapper parity ${JSON.stringify(args)}`);
        const refSet = new Set((await o.query("SELECT x FROM pg_temp.ref_rows($1, $2, $3, $4) x", args)).rows.map((x) => x.x));
        const coreSet = new Set((await o.query(`SELECT e.id FROM booking.provider_evidence e WHERE e.intent_id = $1 AND e.kind = 'hostaway_offline_charges'
            AND booking.recording_evidence_contradicts($1, $2, $3, $4, e.id)`, args)).rows.map((x) => x.id));
        assert.deepEqual([...coreSet].sort(), [...refSet].sort(), "per-row core parity");
        compared += 1;
      }
      // input handling: the wrapper RETURNS the 0010 value; the core RAISES
      for (const bad of [[c.id, null, id, fullA], [c.id, new Date(t), null, fullA], [c.id, new Date(t), id, null], [c.id, new Date(t), id, "00000000-0000-4000-8000-000000000000"], ["00000000-0000-4000-8000-000000000000", new Date(t), id, fullA]]) {
        assert.equal((await o.query("SELECT booking.recording_conflict_refusal($1, $2, $3, $4) AS r", bad)).rows[0].r,
          (await o.query("SELECT pg_temp.ref_refusal($1, $2, $3, $4) AS r", bad)).rows[0].r);
      }
      await assert.rejects(o.query("SELECT booking.recording_evidence_contradicts($1, NULL, $2, $3, $3)", [c.id, id, fullA]), /CONFLICT_CHECK_INPUT/);
      assert.ok(rows.length === 12);
    }
    assert.ok(compared >= 28);
  } finally { await o.end(); }
});

const REF_SCAN_SQL = `SELECT o.id AS op_id, o.intent_id, o.result_ref, e.id AS evidence_id, e.source, e.observed_at,
            to_char(e.observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS observed_at_exact
       FROM booking.external_operations o
       JOIN booking.intents i ON i.id = o.intent_id
       JOIN booking.provider_evidence p ON p.id = o.settled_evidence_id
       JOIN booking.provider_evidence e ON e.intent_id = o.intent_id AND e.kind = 'hostaway_offline_charges' AND e.external_ref = i.hostaway_reservation_id
      WHERE o.op_type = 'hostaway.record_offline_charge' AND o.state = 'succeeded' AND o.settled_evidence_id IS NOT NULL
        AND o.id = (SELECT l.id FROM booking.external_operations l WHERE l.intent_id = o.intent_id AND l.op_type = 'hostaway.record_offline_charge'
                     ORDER BY CASE WHEN l.idempotency_key ~ '^och:[0-9a-f-]{36}:[1-9][0-9]{0,8}$' THEN split_part(l.idempotency_key, ':', 3)::integer END
                              DESC NULLS LAST, l.created_at DESC, l.id DESC LIMIT 1)
        AND e.id <> o.settled_evidence_id AND e.observed_at > o.dispatched_at
        AND (e.observed ->> 'matchingChargeCount')::integer >= 1
        AND (NOT (e.observed ? 'marker') OR (e.observed ->> 'marker') = 'mvoch1-' || o.intent_id::text)
        AND ((e.observed ->> 'matchingChargeCount')::integer >= 2
          OR (e.observed -> 'matchingChargeIds' ->> 0) IS DISTINCT FROM o.result_ref
          OR (e.observed ? 'marker' AND (
               (e.observed ? 'amountMinor' AND (e.observed ->> 'amountMinor') IS DISTINCT FROM i.final_total_minor::text)
            OR (e.observed ? 'currency' AND (e.observed ->> 'currency') IS DISTINCT FROM i.currency::text)
            OR (e.observed ? 'status' AND (e.observed ->> 'status') IS DISTINCT FROM 'paid')
            OR (e.observed ? 'type' AND (e.observed ->> 'type') IS DISTINCT FROM 'charge')
            OR (e.observed ? 'paymentProvider' AND (e.observed ->> 'paymentProvider') IS DISTINCT FROM 'offline')
            OR (e.observed ? 'title' AND (e.observed ->> 'title') IS DISTINCT FROM 'maraVilla payment mvoch1-' || o.intent_id::text)
            OR (e.observed ? 'listingMapId' AND (e.observed ->> 'listingMapId') IS DISTINCT FROM i.listing_id::text)
            OR (e.observed ? 'reservationId' AND (e.observed ->> 'reservationId') IS DISTINCT FROM i.hostaway_reservation_id)
            OR (e.observed ? 'chargeId' AND (e.observed ->> 'chargeId') IS DISTINCT FROM o.result_ref)
            OR (e.observed ? 'paymentMethod' AND (e.observed ->> 'paymentMethod') IS DISTINCT FROM (p.observed ->> 'paymentMethod'))
            OR (e.observed ? 'executorAccountRef' AND (e.observed ->> 'executorAccountRef') IS DISTINCT FROM (p.observed ->> 'executorAccountRef')))))
        AND ($1::timestamptz IS NULL OR (e.observed_at, e.id, o.id) > ($1::timestamptz, $2::uuid, $3::uuid))
      ORDER BY e.observed_at, e.id, o.id LIMIT $4`;
test("T-P3: the SQL page function (via the thin JS caller) returns exactly the rows / order / cursor of the 0010 JS scan, at page sizes 1 / 2 / 3, with microsecond ties", async () => {
  const l = await linked();
  const ms = (k) => new Date(l.t + 1000 + k).toISOString().slice(0, 23);
  for (const [k, x] of [`${ms(0)}100Z`, `${ms(0)}200Z`, `${ms(1)}000Z`, `${ms(1)}000Z`].entries()) await dash(l.c, l.c.reservationId, cnt([cid()]), x, `us-${k}`);
  await evAt(l.c, obs(l.c, l.id, { executorAccountRef: "acct-test-9" }));
  const refPage = async (after, n) => (await db.app.query(REF_SCAN_SQL, [after ? after.observedAtExact : null, after ? after.evidenceId : null, after ? after.opId : null, n])).rows
    .map((x) => ({ opId: x.op_id, intentId: x.intent_id, resultRef: x.result_ref, evidenceId: x.evidence_id, source: x.source, observedAtExact: x.observed_at_exact }));
  for (const limit of [1, 2, 3]) {
    const mine = []; const ref = []; let a = null; let b = null; let pages = 0;
    do {
      const p = await listRecordingContradictions(db.app, { after: a, limit });
      const r = await refPage(b, limit);
      assert.deepEqual(p.rows.map(({ observedAt, ...x }) => x), r, `page ${pages} at limit ${limit}`);
      mine.push(...p.rows); ref.push(...r);
      a = p.next; b = r.length === limit ? { observedAtExact: r.at(-1).observedAtExact, evidenceId: r.at(-1).evidenceId, opId: r.at(-1).opId } : null;
      assert.deepEqual(a, b, "identical cursor");
      pages += 1; assert.ok(pages < 3000);
    } while (a);
    assert.ok(mine.filter((x) => x.intentId === l.c.id).length >= 5);
  }
  await assert.rejects(db.app.query("SELECT * FROM booking.recording_contradictions_page('2026-01-01T00:00:00.000Z', NULL, NULL, 5)"), /RECORDING_SCAN_CURSOR_INVALID/);
  await assert.rejects(listRecordingContradictions(db.app, { after: { observedAtExact: "x", evidenceId: l.proof, opId: l.op.id } }), TypeError);
});

test("T-C1/C2/C3: a contradiction after link opens hold + case + observation (API and dashboard); more contradictions append once; out-of-scope / consistent rows open nothing; link and state never change", async () => {
  const l = await linked();
  const s0 = await snapshot(l.c);
  const consistent = [await evAt(l.c, cnt([l.id])), await evAt(l.c, cnt([])), await evAt(l.c, obs(l.c, l.id)),
    await apiOtherRef(l.c, `9${l.c.reservationId}`, cnt([cid()])), await evAt(l.c, { ...obs(l.c, cid()), marker: "mvoch1-00000000-0000-4000-8000-000000000000" })];
  await drainAll();
  for (const e of consistent) assert.equal((await inbox(e)).outcome, "consistent");
  assert.deepEqual(await holdsOf(l.c.id), []);
  const x1 = await evAt(l.c, cnt([cid()]));
  const x2 = await dash(l.c, l.c.reservationId, cnt([cid()]), new Date());
  const x3 = await evAt(l.c, obs(l.c, l.id, { paymentMethod: "other" }));
  await drainAll();
  const [h] = await holdsOf(l.c.id);
  assert.equal(h.reason, "LINKED_CONTRADICTED");
  assert.deepEqual([(await inbox(x1)).outcome, (await inbox(x2)).outcome, (await inbox(x3)).outcome], ["contradiction_opened", "contradiction_appended", "contradiction_appended"]);
  assert.deepEqual((await obsOf(h.id)).sort(), [x1, x2, x3].sort());
  const k = await caseRow(h.case_id);
  assert.deepEqual([k.kind, k.status, k.opened_by, k.evidence.firstEvidenceId], ["OFFLINE_CHARGE_HOLD_LINKED_CONTRADICTED", "open", `recording-hold:${k.id}`, x1]);
  assert.deepEqual(await snapshot(l.c), s0, "no intent / version / op / link / effect change");
  // duplicate observation (probe: the observation already exists when the item is processed)
  const x4 = await evAt(l.c, cnt([cid()]));
  await db.owner.query("INSERT INTO booking.recording_hold_observations (id, hold_id, evidence_id, recorded_at) VALUES (gen_random_uuid(), $1, $2, now())", [h.id, x4]);
  await drainAll();
  assert.equal((await inbox(x4)).outcome, "contradiction_duplicate");
  assert.equal((await obsOf(h.id)).filter((e) => e === x4).length, 1);
  await assert.rejects(db.owner.query("INSERT INTO booking.recording_conflict_inbox (evidence_id, intent_id, enqueued_at) VALUES ($1, $2, now())", [x4, l.c.id]), /duplicate key/);
});

test("T-C4: historical dashboard evidence inserted LATER with an old observed_at (older than already-processed rows) is still judged — the inbox selects rows, not a cursor range", async () => {
  const l = await linked();
  await evAt(l.c, cnt([l.id]));
  await drainAll();
  const old = await dash(l.c, l.c.reservationId, cnt([cid()]), new Date(l.t + 1));           // just after dispatch, long ago relative to processed rows
  const tie = await dash(l.c, l.c.reservationId, cnt([cid()]), new Date(l.t + 1));
  await drainAll();
  assert.deepEqual([(await inbox(old)).outcome, (await inbox(tie)).outcome], ["contradiction_opened", "contradiction_appended"]);
  assert.equal((await holdsOf(l.c.id)).length, 1);
});

test("T-C5: writer vs link vs processor — contradiction committed BEFORE the link: link refused (safe block, not_latest_linked); AFTER the link: hold opened; the processor observably waits on the link's op lock", async () => {
  // before the link: blocked, no LINKED_CONTRADICTED hold
  const b = await ownerSucceededUnlinked();
  const bad = await dash(b.c, b.c.reservationId, cnt([cid()]), new Date(F.at(35)));
  await drainAll();
  assert.equal((await inbox(bad)).outcome, "not_latest_linked");
  const proofB = await evAt(b.c, obs(b.c, b.id), F.at(40));
  const r = await linkRecordingEvidence(db.app, b.op.id, { evidenceId: proofB, openVisibilityHoldOnConflict: true });
  assert.equal(r.error, "RECORDING_EVIDENCE_CONFLICT", "the original refusal is returned");
  assert.ok(r.visibilityHold.ok, "separate best-effort visibility hold (helper level, not DB-atomic with the link)");
  assert.equal((await holdsOf(b.c.id))[0].reason, "SUCCEEDED_UNPROVEN");
  // the processor waits on an uncommitted link, then judges with the LINKED reference
  const a = await ownerSucceededUnlinked();
  const proofA = await evAt(a.c, obs(a.c, a.id), F.at(40));
  await drainAll();                                                                           // proofA processed: not_latest_linked
  const later = await evAt(a.c, cnt([a.id]), F.at(41));                                       // consistent count-only, pending in the inbox
  const k = await asAppClient();
  let pr;
  try {
    await k.query("BEGIN");
    assert.equal((await k.query("SELECT booking.link_recording_evidence($1, $2) AS r", [a.op.id, proofA])).rows[0].r, "linked");
    const p = db.app.query("SELECT booking.process_recording_conflict_inbox_one('t') AS r").then((x) => { pr = x.rows[0].r; });
    await waitForLockWaiters(1);
    const waits = await waitingLockTypes();
    assert.ok(waits.includes("transactionid") || waits.includes("tuple"), `observed wait: ${waits}`);
    await k.query("COMMIT");
    await p;
  } finally { await k.end(); }
  assert.deepEqual([pr.evidenceId, pr.outcome], [later, "consistent"], "judged after the link committed, against the linked proof");
  const x = await evAt(a.c, cnt([cid()]), F.at(50));
  await drainAll();
  assert.equal((await inbox(x)).outcome, "contradiction_opened");
});

test("T-C6: caller rollback and a killed connection leave the item unprocessed with no attempt recorded; it is processed later, once", async () => {
  const l = await linked();
  await drainAll();
  const x = await evAt(l.c, cnt([cid()]));
  const k = await asAppClient();
  try {
    await k.query("BEGIN");
    assert.equal((await k.query("SELECT booking.process_recording_conflict_inbox_one('t') AS r")).rows[0].r.outcome, "contradiction_opened");
    await k.query("ROLLBACK");
  } finally { await k.end(); }
  assert.deepEqual([(await inbox(x)).processed_at, (await inbox(x)).attempts], [null, 0]);
  assert.deepEqual(await holdsOf(l.c.id), []);
  const k2 = await asAppClient();
  const pid = (await k2.query("SELECT pg_backend_pid() AS p")).rows[0].p;
  k2.on("error", () => {});
  await k2.query("BEGIN");
  await k2.query("SELECT booking.process_recording_conflict_inbox_one('t') AS r");
  await db.owner.query("SELECT pg_terminate_backend($1)", [pid]);
  await k2.end().catch(() => {});
  assert.deepEqual([(await inbox(x)).processed_at, (await inbox(x)).attempts], [null, 0], "crash: nothing persisted");
  await drainAll();
  assert.equal((await inbox(x)).outcome, "contradiction_opened");
  assert.equal((await holdsOf(l.c.id)).length, 1);
  assert.deepEqual(await obsOf((await holdsOf(l.c.id))[0].id), [x]);
});

test("T-C7/C8: a poison item records attempts / last_error durably, stays unprocessed and queues behind fresh items; an outer error marks nothing; after repair it processes", async () => {
  const l = await linked();
  await drainAll();
  const h = await artificialHold(l.c, l.op.id, "SUCCEEDED_UNPROVEN");                          // impossible state for a linked row (probe)
  const poison = await evAt(l.c, cnt([cid()]));
  const out = await drainAll();
  assert.ok(out.stoppedOnRepeatedError, "the same item failing twice ends the run (no hidden retry loop)");
  let q = await inbox(poison);
  assert.deepEqual([q.processed_at, q.outcome, q.hold_id, q.attempts], [null, null, null, 2]);
  assert.match(q.last_error, /^23514: HOLD_STATE_UNEXPECTED/);
  assert.ok(q.last_attempt_at);
  // fresh items are served first (ORDER BY attempts, seq)
  const fl = await linked();
  await drainRecordingConflictInbox(db.app, { by: "t", maxCalls: 2 });                       // fl's own items (fresh, attempts 0) go first: its 0012 preflight list + its proof
  const fresh = await evAt(fl.c, cnt([]));
  const one = (await db.app.query("SELECT booking.process_recording_conflict_inbox_one('t') AS r")).rows[0].r;
  assert.equal(one.evidenceId, fresh);
  // outer failure: rejected before any item is touched
  await assert.rejects(db.app.query("SELECT booking.process_recording_conflict_inbox_one('')"), /INBOX_BY_INVALID/);
  assert.equal((await inbox(poison)).attempts, 2);
  // repair (probe removal) -> processed normally
  await removeArtificialHold(h);
  await drainAll();
  q = await inbox(poison);
  assert.deepEqual([q.outcome, q.attempts], ["contradiction_opened", 2], "error history kept on success");
});

test("T-H1 (addendum C): the drain helper makes <= maxCalls independent autocommit calls, never retries; a held item lock does not block another item", async () => {
  const l = await linked();
  await drainAll();                                                                           // l's own proof item
  const evs = [await evAt(l.c, cnt([l.id])), await evAt(l.c, cnt([l.id])), await evAt(l.c, cnt([l.id]))];
  const d1 = await drainRecordingConflictInbox(db.app, { by: "t", maxCalls: 2 });
  assert.deepEqual([d1.calls, d1.processed.length, d1.drained], [2, 2, false]);
  const d2 = await drainRecordingConflictInbox(db.app, { by: "t", maxCalls: 100 });
  assert.deepEqual([d2.processed.length, d2.drained], [1, true]);
  for (const e of evs) assert.equal((await inbox(e)).outcome, "consistent");
  // an outer (thrown) failure stops the run and propagates: see T-H3
  const x = await evAt(l.c, cnt([l.id]));
  const single = await asAppClient();
  try { await assert.rejects(drainRecordingConflictInbox(single, { by: "t" }), TypeError, "a single client (possible shared transaction) is refused"); }
  finally { await single.end(); }
  // SKIP LOCKED: an uncommitted processor holding one item never waits for / blocks on another ITEM's inbox lock (other intent)
  const l2 = await linked();
  await drainAll();                                                                           // x and l2's proof
  const y = await evAt(l2.c, cnt([l2.id]));
  const x2 = await evAt(l.c, cnt([l.id]));
  const k = await asAppClient();
  try {
    await k.query("BEGIN");
    const first = (await k.query("SELECT booking.process_recording_conflict_inbox_one('t') AS r")).rows[0].r;
    assert.equal(first.evidenceId, y);
    const second = await Promise.race([db.app.query("SELECT booking.process_recording_conflict_inbox_one('t') AS r").then((r) => r.rows[0].r), sleep(3000).then(() => "BLOCKED")]);
    assert.notEqual(second, "BLOCKED", "the locked item is skipped, the other intent's item is processed without waiting");
    assert.equal(second.evidenceId, x2);
    await k.query("COMMIT");
  } finally { await k.end(); }
  // the SAME intent is serialized by its advisory evidence key (observed), not by an inbox-row lock
  const z1 = await evAt(l.c, cnt([l.id])); const z2 = await evAt(l.c, cnt([l.id]));
  const k2 = await asAppClient();
  try {
    await k2.query("BEGIN");
    assert.equal((await k2.query("SELECT booking.process_recording_conflict_inbox_one('t') AS r")).rows[0].r.evidenceId, z1);
    let r2;
    const p = db.app.query("SELECT booking.process_recording_conflict_inbox_one('t') AS r").then((r) => { r2 = r.rows[0].r; });
    await waitForLockWaiters(1);
    assert.deepEqual(await waitingLockTypes(), ["advisory"], "per-intent advisory key");
    await k2.query("COMMIT");
    await p;
    assert.deepEqual([r2.evidenceId, r2.outcome], [z2, "consistent"]);
  } finally { await k2.end(); }
});

test("T-H2 (addendum C): wrapping several calls in ONE transaction per caller with interleaved intents (A,B vs B,A) deadlocks; the 40P01 is caught in the item's subtransaction and recorded; autocommit calls (the contract) do not deadlock", async () => {
  const A = await linked(); const B = await linked();
  await drainAll();
  const A1 = await evAt(A.c, cnt([A.id])); const B1 = await evAt(B.c, cnt([B.id])); const B2 = await evAt(B.c, cnt([B.id])); const A2 = await evAt(A.c, cnt([A.id]));
  const k1 = await asAppClient(); const k2 = await asAppClient();
  const call = (k) => k.query("SELECT booking.process_recording_conflict_inbox_one('t') AS r").then((r) => r.rows[0].r);
  let results;
  try {
    await k1.query("BEGIN"); await k2.query("BEGIN");
    assert.equal((await call(k1)).evidenceId, A1);                                             // k1 holds A's advisory key
    assert.equal((await call(k2)).evidenceId, B1);                                             // k2 holds B's
    const p1 = call(k1);                                                                       // B2 -> waits for k2 (B)
    await waitForLockWaiters(1);
    const p2 = call(k2);                                                                       // A2 -> waits for k1 (A): cycle
    const first = await Promise.race([p1.then((r) => ({ k: 1, r })), p2.then((r) => ({ k: 2, r }))]);
    assert.equal(first.r.error, "40P01", "the deadlock victim's item records the error and returns");
    await (first.k === 1 ? k1 : k2).query("COMMIT");                                           // victim commits: its held key is released
    const other = await (first.k === 1 ? p2 : p1);
    await (first.k === 1 ? k2 : k1).query("COMMIT");
    results = [first.r, other];
  } finally { await k1.end(); await k2.end(); }
  const victim = results[0].evidenceId;
  assert.ok([B2, A2].includes(victim));
  const v = await inbox(victim);
  assert.deepEqual([v.processed_at, v.attempts], [null, 1]);
  assert.match(v.last_error, /^40P01/);
  assert.equal(results[1].outcome, "consistent");
  // the supported contract: independent autocommit calls, even interleaved across intents, never hold two intents' locks
  const more = [await evAt(A.c, cnt([A.id])), await evAt(B.c, cnt([B.id])), await evAt(B.c, cnt([B.id])), await evAt(A.c, cnt([A.id]))];
  const out = await Promise.all([drainAll(), drainAll()]);
  assert.ok(out.every((o) => o.errors.length === 0), JSON.stringify(out.map((o) => o.errors)));
  for (const e of [...more, victim]) assert.equal((await inbox(e)).outcome, "consistent");
});

/** a pg.Pool-shaped wrapper that counts queries and can throw a given error instead of running a chosen query */
function countingPool(inner, failWhen = () => null) {
  const p = { calls: [], totalCount: 0, connect: (...a) => inner.connect(...a),
    query: async (sql, params) => { p.calls.push(sql); const e = failWhen(sql, p.calls.length); if (e) throw e; return inner.query(sql, params); } };
  return p;
}
const pending = async (evs) => Promise.all(evs.map(async (e) => { const q = await inbox(e); return [q.processed_at, q.attempts]; }));

test("T-H3 (root R1): an outer (thrown) failure stops the drain IMMEDIATELY and re-throws the ORIGINAL error — first call, and after one processed item; exact query counts; remaining items untouched; no retry", async () => {
  const l = await linked();
  await drainAll();
  const evs = [await evAt(l.c, cnt([l.id])), await evAt(l.c, cnt([l.id])), await evAt(l.c, cnt([l.id]))];
  // (a) first call fails (a real server error: a login without EXECUTE)
  const report = new pg.Pool({ connectionString: db.reportUrl(), max: 1 });
  try {
    const rp = countingPool(report);
    let caught;
    await assert.rejects(drainRecordingConflictInbox(rp, { by: "t", maxCalls: 3 }), (e) => { caught = e; return true; });
    assert.equal(caught.code, "42501");
    assert.ok(caught instanceof Error && /permission denied/.test(caught.message), "original server error, not a wrapper");
    assert.equal(rp.calls.length, 1, "no second query after the thrown call");
    assert.deepEqual([caught.drainProgress.calls, caught.drainProgress.processed.length, caught.drainProgress.errors.length], [1, 0, 0]);
  } finally { await report.end(); }
  assert.deepEqual(await pending(evs), [[null, 0], [null, 0], [null, 0]], "nothing touched");
  // (b) one item processed, then the second call throws (synthetic connection error object)
  const boom = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
  const ap = countingPool(db.app, (sql, n) => (n === 2 ? boom : null));
  let caught2;
  await assert.rejects(drainRecordingConflictInbox(ap, { by: "t", maxCalls: 100 }), (e) => { caught2 = e; return true; });
  assert.equal(caught2, boom, "the very same error object is propagated");
  assert.equal(ap.calls.length, 2);
  assert.deepEqual([caught2.drainProgress.calls, caught2.drainProgress.processed.map((x) => x.evidenceId)], [2, [evs[0]]]);
  const st = await pending(evs);
  assert.ok(st[0][0] !== null, "the first item was processed");
  assert.deepEqual(st.slice(1), [[null, 0], [null, 0]], "remaining items untouched (no attempt recorded)");
  const rest = await drainRecordingConflictInbox(db.app, { by: "t" });
  assert.deepEqual(rest.processed.map((x) => x.evidenceId).filter((e) => evs.includes(e)), evs.slice(1));
});

test("T-L1 (root R2): the optional separate visibility hold after a link conflict never replaces the original refusal — success, known refusal, outer error (bounded code, no message), disabled; a primary link outer error propagates; exactly one hold attempt", async () => {
  const mk = async () => {
    const b = await ownerSucceededUnlinked();
    await dash(b.c, b.c.reservationId, cnt([cid()]), new Date(F.at(35)));
    return { ...b, proof: await evAt(b.c, obs(b.c, b.id), F.at(40)) };
  };
  const isHold = (sql) => sql.includes("open_recording_visibility_hold");
  const isLink = (sql) => sql.includes("link_recording_evidence");
  // success (real pool)
  const a = await mk();
  const ok = await linkRecordingEvidence(db.app, a.op.id, { evidenceId: a.proof, openVisibilityHoldOnConflict: true });
  assert.equal(ok.error, "RECORDING_EVIDENCE_CONFLICT");
  assert.ok(ok.visibilityHold.ok && ok.visibilityHold.holdId === (await holdsOf(a.c.id))[0].id);
  const b = await mk();
  // known refusal of the hold call
  const known = countingPool(db.app, (sql) => (isHold(sql) ? Object.assign(new Error("HOLD_TARGET_STATE: probe"), { code: "23514" }) : null));
  assert.deepEqual(await linkRecordingEvidence(known, b.op.id, { evidenceId: b.proof, openVisibilityHoldOnConflict: true }),
    { ok: false, error: "RECORDING_EVIDENCE_CONFLICT", visibilityHold: { ok: false, error: "HOLD_TARGET_STATE" } });
  assert.equal(known.calls.filter(isHold).length, 1);
  // outer error of the hold call: caught, bounded, no message / credential leak
  const outer = countingPool(db.app, (sql) => (isHold(sql) ? Object.assign(new Error("socket hang up postgresql://u:secret@h/db"), { code: "ECONNRESET" }) : null));
  const r2 = await linkRecordingEvidence(outer, b.op.id, { evidenceId: b.proof, openVisibilityHoldOnConflict: true });
  assert.deepEqual(r2, { ok: false, error: "RECORDING_EVIDENCE_CONFLICT", visibilityHold: { ok: false, error: "VISIBILITY_HOLD_CALL_FAILED", code: "ECONNRESET" } });
  assert.doesNotMatch(JSON.stringify(r2), /secret|socket|postgresql/);
  assert.equal(outer.calls.filter(isHold).length, 1, "exactly one hold attempt, no retry");
  const weird = countingPool(db.app, (sql) => (isHold(sql) ? Object.assign(new Error("x"), { code: "not a code; secret" }) : null));
  assert.equal((await linkRecordingEvidence(weird, b.op.id, { evidenceId: b.proof, openVisibilityHoldOnConflict: true })).visibilityHold.code, null);
  // disabled option: no hold call
  const off = countingPool(db.app);
  assert.deepEqual(await linkRecordingEvidence(off, b.op.id, { evidenceId: b.proof }), { ok: false, error: "RECORDING_EVIDENCE_CONFLICT" });
  assert.equal(off.calls.filter(isHold).length, 0);
  // primary link outer error: propagated unchanged, no hold attempt
  const boom = Object.assign(new Error("connection terminated"), { code: "ECONNRESET" });
  const prim = countingPool(db.app, (sql) => (isLink(sql) ? boom : null));
  await assert.rejects(linkRecordingEvidence(prim, b.op.id, { evidenceId: b.proof, openVisibilityHoldOnConflict: true }), (e) => e === boom);
  assert.equal(prim.calls.filter(isHold).length, 0);
  assert.deepEqual(await holdsOf(b.c.id), [], "none of the failed / refused / disabled variants opened a hold");
  assert.equal((await row(b.op.id)).settled_evidence_id, null);
});

test("T-C10 (root flag 2): a linked booking that has moved to reconciliation_required (supported ESCALATE path) — a new contradiction is processed once and opens visibility; state / version / link / effects unchanged", async () => {
  const l = await linked();
  F.ok(await applyEvent(db.app, l.c.id, { type: "ESCALATE", code: "TEST_ESCALATION" }, { now: Date.now() }));
  assert.equal((await facts(l.c.id)).state, "reconciliation_required");
  await drainAll();
  const s0 = await snapshot(l.c);
  const x = await evAt(l.c, cnt([cid()]));
  await drainAll();
  const q = await inbox(x);
  assert.equal(q.outcome, "contradiction_opened");
  const [h] = await holdsOf(l.c.id);
  assert.deepEqual([h.reason, h.intent_state_at_hold, h.operation_id], ["LINKED_CONTRADICTED", "reconciliation_required", l.op.id]);
  assert.deepEqual(await obsOf(h.id), [x]);
  assert.deepEqual(await snapshot(l.c), s0, "no state / version / op / link / effect change");
  await drainAll();
  assert.deepEqual([(await inbox(x)).processed_at, (await obsOf(h.id)).length], [q.processed_at, 1], "processed once");
});

test("T-D1: visibility holds — SUCCEEDED_UNPROVEN on payment_captured and on an inherited confirmed row, ATTEMPT_GT1 on a genuine pending attempt 2; no state / version / op / effect change", async () => {
  const u = await ownerSucceededUnlinked();
  const s0 = await snapshot(u.c);
  const h1 = F.ok(await openRecordingVisibilityHold(db.app, u.op.id, { reason: "SUCCEEDED_UNPROVEN", by: "maint" }));
  const [hold] = await holdsOf(u.c.id);
  assert.deepEqual([hold.id, hold.reason, hold.op_state_at_hold, hold.intent_state_at_hold], [h1.holdId, "SUCCEEDED_UNPROVEN", "succeeded", "payment_captured"]);
  const k = await caseRow(hold.case_id);
  assert.deepEqual([k.kind, k.status, k.opened_by], ["OFFLINE_CHARGE_HOLD_SUCCEEDED_UNPROVEN", "open", `recording-hold:${k.id}`]);
  assert.deepEqual(await snapshot(u.c), s0);
  // inherited confirmed (history: finalised before 0010 existed)
  const v = await ownerSucceededUnlinked();
  await F.ownerManagedHistory(db.owner, "UPDATE booking.intents SET state = 'confirmed', offline_charge_id = $2, version = version + 1 WHERE id = $1", [v.c.id, v.id]);
  const s1 = await snapshot(v.c);
  F.ok(await openRecordingVisibilityHold(db.app, v.op.id, { reason: "SUCCEEDED_UNPROVEN", by: "maint" }));
  assert.equal((await holdsOf(v.c.id))[0].intent_state_at_hold, "confirmed");
  assert.deepEqual(await snapshot(v.c), s1);
  // ATTEMPT_GT1
  const g = await attempt2Pending();
  const s2 = await snapshot(g.c);
  F.ok(await openRecordingVisibilityHold(db.app, g.a2.id, { reason: "ATTEMPT_GT1", by: "maint" }));
  assert.equal((await holdsOf(g.c.id))[0].reason, "ATTEMPT_GT1");
  assert.deepEqual(await snapshot(g.c), s2);
  // wrong targets
  assert.equal((await openRecordingVisibilityHold(db.app, g.a1.id, { reason: "ATTEMPT_GT1", by: "m" })).error, "HOLD_TARGET_NOT_LATEST");
  assert.equal((await openRecordingVisibilityHold(db.app, g.a2.id, { reason: "SUCCEEDED_UNPROVEN", by: "m" })).error, "HOLD_ALREADY_ACTIVE");
  const l = await linked();
  assert.equal((await openRecordingVisibilityHold(db.app, l.op.id, { reason: "SUCCEEDED_UNPROVEN", by: "m" })).error, "HOLD_TARGET_LINKED");
  assert.equal((await openRecordingVisibilityHold(db.app, l.op.id, { reason: "ATTEMPT_GT1", by: "m" })).error, "HOLD_TARGET_STATE");
  await assert.rejects(openRecordingVisibilityHold(db.app, l.op.id, { reason: "LINKED_CONTRADICTED", by: "m" }), TypeError);
  await assert.rejects(db.app.query("SELECT booking.open_recording_visibility_hold($1, 'LINKED_CONTRADICTED', 'm')", [l.op.id]), /HOLD_REASON_INVALID/);
});

test("T-D2: duplicate openers return the same hold; the O4 race with an app link — link first: opener waits then HOLD_TARGET_LINKED; opener first: link waits then RECORDING_HOLD_ACTIVE (observed waits)", async () => {
  const u = await ownerSucceededUnlinked();
  const ids = await Promise.all([1, 2, 3].map(() => openRecordingVisibilityHold(db.app, u.op.id, { reason: "SUCCEEDED_UNPROVEN", by: "m" })));
  assert.equal(new Set(ids.map((x) => x.holdId)).size, 1);
  assert.equal((await holdsOf(u.c.id)).length, 1);
  for (const order of ["link_first", "hold_first"]) {
    const x = await ownerSucceededUnlinked();
    const proof = await evAt(x.c, obs(x.c, x.id), F.at(40));
    const k = await asAppClient();
    let res;
    try {
      await k.query("BEGIN");
      if (order === "link_first") await k.query("SELECT booking.link_recording_evidence($1, $2)", [x.op.id, proof]);
      else await k.query("SELECT booking.open_recording_visibility_hold($1, 'SUCCEEDED_UNPROVEN', 'm')", [x.op.id]);
      const p = (order === "link_first" ? openRecordingVisibilityHold(db.app, x.op.id, { reason: "SUCCEEDED_UNPROVEN", by: "m" })
        : linkRecordingEvidence(db.app, x.op.id, { evidenceId: proof })).then((r) => { res = r; });
      await waitForLockWaiters(1);
      const waits = await waitingLockTypes();
      assert.ok(waits.includes("transactionid") || waits.includes("tuple"), `${order}: observed wait ${waits}`);
      await k.query("COMMIT");
      await p;
    } finally { await k.end(); }
    assert.deepEqual(res, { ok: false, error: order === "link_first" ? "HOLD_TARGET_LINKED" : "RECORDING_HOLD_ACTIVE" }, order);
  }
});

test("T-D3: operation-history same-kind collision — attempt 2 keeps its ATTEMPT_GT1 hold, attempt 3 becomes pending: its hold JOINS the open case; nothing overwritten; claim fenced", async () => {
  await db.owner.query("INSERT INTO booking.definite_refusal_codes (op_type, code, note) VALUES ('hostaway.record_offline_charge', 'VALIDATION_ERROR', 'test stand-in') ON CONFLICT DO NOTHING");
  const g = await attempt2Pending();
  const h2 = F.ok(await openRecordingVisibilityHold(db.app, g.a2.id, { reason: "ATTEMPT_GT1", by: "m" }));
  const k0 = await caseRow((await holdsOf(g.c.id))[0].case_id);
  // HISTORY: attempt 2 was handled outside automation (catalogued definite failure), E3 then queues attempt 3
  await F.ownerManagedHistory(db.owner, `UPDATE booking.external_operations SET state = 'failed_definite', attempts = 1, dispatched_at = $2, completed_at = $2,
      error_code = 'VALIDATION_ERROR', updated_at = $2 WHERE id = $1`, [g.a2.id, new Date(F.at(80))]);
  F.ok(await applyEvent(db.app, g.c.id, { type: "OFFLINE_CHARGE_FAILED" }, { now: F.at(81) }));
  const a3 = (await db.app.query("SELECT * FROM booking.external_operations WHERE intent_id = $1 AND op_type = $2 AND state = 'pending'", [g.c.id, OCH[0]])).rows[0];
  assert.ok(a3.idempotency_key.endsWith(":3"));
  const h3 = F.ok(await openRecordingVisibilityHold(db.app, a3.id, { reason: "ATTEMPT_GT1", by: "m" }));
  const holds = await holdsOf(g.c.id);
  assert.deepEqual(holds.map((h) => [h.id, h.operation_id, h.released_at]), [[h2.holdId, g.a2.id, null], [h3.holdId, a3.id, null]]);
  assert.equal(holds[0].case_id, holds[1].case_id, "joined the same open case");
  assert.deepEqual(await caseRow(k0.id), k0, "case row untouched (evidence = the first op's snapshot)");
  assert.equal(await claimNextOperation(db.app, { workerId: "w9", now: Date.now(), intentId: g.c.id, opTypes: OCH }), null);
  assert.equal((await adminCloseCase(db.reconciler, { caseId: k0.id, evidenceIds: [g.api], resolver: "o", justification: "X", at: F.at(90) })).error,
    "HOLD_CASE_USE_ADMIN_RESOLVE_RECORDING_HOLD");
});

test("T-E1 (addendum D): keep_visible — admin only, empty evidence allowed, identical resubmission is a no-op, foreign evidence refused; hold and case stay; unknown / wrong-reason holds surfaced", async () => {
  const g = await attempt2Pending();
  const h = F.ok(await openRecordingVisibilityHold(db.app, g.a2.id, { reason: "ATTEMPT_GT1", by: "m" }));
  const s0 = await snapshot(g.c);
  const d1 = F.ok(await keepVisible(h.holdId));
  assert.equal((await keepVisible(h.holdId)).id, d1.id, "identical resubmission: same decision, no new row");
  const d2 = F.ok(await keepVisible(h.holdId, { at: F.at(101), evidenceIds: [g.api] }));
  assert.notEqual(d2.id, d1.id);
  const decisions = (await db.owner.query("SELECT decision, evidence_ids, linked_evidence_id FROM booking.recording_hold_decisions WHERE hold_id = $1 ORDER BY recorded_at", [h.holdId])).rows;
  assert.deepEqual(decisions, [{ decision: "keep_visible", evidence_ids: [], linked_evidence_id: null }, { decision: "keep_visible", evidence_ids: [g.api], linked_evidence_id: null }]);
  const foreign = (await db.app.query("SELECT id FROM booking.provider_evidence WHERE intent_id <> $1 LIMIT 1", [g.c.id])).rows[0].id;
  assert.equal((await keepVisible(h.holdId, { evidenceIds: [foreign], at: F.at(102) })).error, "EVIDENCE_NOT_FOR_THIS_INTENT");
  assert.equal((await adminResolveRecordingHold(db.app, { holdId: h.holdId, decision: "keep_visible", resolver: "x", justification: "X", at: F.at(103) })).error, "PERMISSION_DENIED");
  assert.equal((await adminResolveRecordingHold(db.reconciler, { holdId: h.holdId, decision: "link_full_proof", linkedEvidenceId: g.api, resolver: "o", justification: "X", at: F.at(104) })).error,
    "HOLD_DECISION_NOT_ALLOWED");
  assert.equal((await keepVisible("00000000-0000-4000-8000-000000000000")).error, "HOLD_NOT_FOUND");
  assert.equal((await adminResolveRecordingHold(db.reconciler, { holdId: h.holdId, decision: "release", resolver: "o", justification: "X", at: F.at(105) })).error, "HOLD_DECISION_INVALID");
  const [hold] = await holdsOf(g.c.id);
  assert.equal(hold.released_at, null);
  assert.equal((await caseRow(hold.case_id)).status, "open");
  assert.deepEqual(await snapshot(g.c), s0, "acknowledgement changes nothing else");
});

test("T-E2 (addendum D): link_full_proof — exact proof at the post-lock clock + candidate-reference check, link + decision + release in ONE transaction, owner resolution intact, case resolved only when its last hold is released; replay / released / early / contradicted surfaced", async () => {
  const u = await ownerSucceededUnlinked();
  const h = F.ok(await openRecordingVisibilityHold(db.app, u.op.id, { reason: "SUCCEEDED_UNPROVEN", by: "m" }));
  const before = await row(u.op.id);
  const early = await evAt(u.c, obs(u.c, u.id), F.at(9 + 14));
  const link = (ev, at = F.at(110)) => adminResolveRecordingHold(db.reconciler, { holdId: h.holdId, decision: "link_full_proof", linkedEvidenceId: ev, resolver: "owner",
    justification: "HISTORICAL_PROOF", at });
  assert.equal((await link(early)).error, "RECORDING_PROOF_REFUSED");
  assert.equal((await link(u.ev0)).error, "RECORDING_PROOF_REFUSED", "count-only evidence is not full proof");
  const proof = await evAt(u.c, obs(u.c, u.id), F.at(40));
  const d = F.ok(await link(proof));
  const after = await row(u.op.id);
  assert.deepEqual([after.settled_evidence_id, after.resolution_id, after.result_ref, String(after.completed_at), after.state],
    [proof, before.resolution_id, before.result_ref, String(before.completed_at), "succeeded"], "prior owner resolution intact");
  const [hold] = await holdsOf(u.c.id);
  assert.deepEqual([hold.release_decision_id, !!hold.released_at], [d.id, true]);
  const k = await caseRow(hold.case_id);
  assert.deepEqual([k.status, k.resolution], ["resolved", "recorded"]);
  assert.equal((await link(proof, F.at(111))).id, d.id, "same-proof replay: read-only no-op");
  assert.equal((await link(early, F.at(112))).error, "HOLD_NOT_ACTIVE");
  assert.equal((await keepVisible(h.holdId)).error, "HOLD_NOT_ACTIVE");
  F.ok(await applyEvent(db.app, u.c.id, { type: "OFFLINE_CHARGE_RECORDED", chargeId: u.id }, { now: Date.now() }));
  assert.equal((await facts(u.c.id)).state, "confirmed");
  // contradicted candidate: refused, nothing written
  const x = await ownerSucceededUnlinked();
  const hx = F.ok(await openRecordingVisibilityHold(db.app, x.op.id, { reason: "SUCCEEDED_UNPROVEN", by: "m" }));
  await dash(x.c, x.c.reservationId, cnt([cid()]), new Date(F.at(35)));
  const px = await evAt(x.c, obs(x.c, x.id), F.at(40));
  assert.equal((await adminResolveRecordingHold(db.reconciler, { holdId: hx.holdId, decision: "link_full_proof", linkedEvidenceId: px, resolver: "o", justification: "X", at: F.at(110) })).error,
    "RECORDING_EVIDENCE_CONFLICT");
  assert.equal((await row(x.op.id)).settled_evidence_id, null);
  assert.equal((await holdsOf(x.c.id))[0].released_at, null);
  // multi-hold case: a NEWER succeeded-unlinked recording (owner-managed history) joins the case; releasing it leaves the case open
  const m = await ownerSucceededUnlinked();
  const hm1 = F.ok(await openRecordingVisibilityHold(db.app, m.op.id, { reason: "SUCCEEDED_UNPROVEN", by: "m" }));
  const id2 = cid();
  const op2 = (await F.ownerManagedHistory(db.owner, `INSERT INTO booking.external_operations (id, intent_id, op_type, idempotency_key, retry_class, state, payload,
      source_version, max_attempts, attempts, next_attempt_at, created_at, updated_at, dispatched_at, completed_at, result_ref)
    SELECT gen_random_uuid(), intent_id, op_type, 'och:' || intent_id::text || ':2', retry_class, 'succeeded', payload, source_version, 1, 1, $2, $2, $3, $3, $3, $4
      FROM booking.external_operations WHERE id = $1 RETURNING id`, [m.op.id, new Date(F.at(65)), new Date(F.at(70)), id2])).rows[0].id;
  const hm2 = F.ok(await openRecordingVisibilityHold(db.app, op2, { reason: "SUCCEEDED_UNPROVEN", by: "m" }));
  const hs = await holdsOf(m.c.id);
  assert.equal(hs[0].case_id, hs[1].case_id);
  const p2 = await evAt(m.c, obs(m.c, id2), F.at(90));
  F.ok(await adminResolveRecordingHold(db.reconciler, { holdId: hm2.holdId, decision: "link_full_proof", linkedEvidenceId: p2, resolver: "o", justification: "X", at: F.at(110) }));
  assert.equal((await caseRow(hs[0].case_id)).status, "open", "another bound hold is still active");
  assert.equal((await adminResolveRecordingHold(db.reconciler, { holdId: hm1.holdId, decision: "link_full_proof", linkedEvidenceId: p2, resolver: "o", justification: "X", at: F.at(111) })).error,
    "HOLD_TARGET_NOT_LATEST", "the older hold's recording is no longer the latest: it can never be linked, only kept visible");
  F.ok(await keepVisible(hm1.holdId));
});

test("T-C9: backfill — 0011 up (from 10) enqueues every existing offline-charge evidence row atomically; an already-confirmed linked row contradicted under 0010 gets a visibility hold, state unchanged", async () => {
  const d2 = await startMigratedDatabase();
  const o = new pg.Client({ connectionString: d2.adminUrl }); await o.connect();
  try {
    // the history is written with today's helpers (they assume 0011), never processed, then 0011 is rolled back (allowed: the inbox is
    // untouched) so the evidence exists BEFORE 0011 up runs its backfill
    const c = await F.confirmed(d2.app, { listingId: 798001, from: "2029-12-01", to: "2029-12-04" });
    const st = (await d2.app.query("SELECT id, listing_id FROM booking.intents WHERE id = $1", [c.id])).rows[0];
    const bad = await F.chargeListEvidence(d2.app, { ...c, listingId: st.listing_id }, { matchingChargeCount: 1, matchingChargeIds: ["991234"] });
    // E7.4b-D1 (0012): the confirmed history above carries a real preflight assessment + claim audit, so 0012 refuses to roll back ...
    await assert.rejects(migrateDown(o, { env: "test", to: 10 }), /DOWNGRADE_REFUSED_RECORDING_ASSESSMENT_AUDIT/);
    // ... TEST SETUP ONLY, in this throwaway cluster: remove the 0012 audit rows as the superuser with triggers bypassed, to simulate history
    // written before 0012 existed; this measures the 0011 BACKFILL from 10 and is never a runtime path
    await F.ownerManagedHistory(d2.owner, "DELETE FROM booking.recording_claim_assessments");
    await F.ownerManagedHistory(d2.owner, "DELETE FROM booking.recording_assessments");
    assert.deepEqual(await migrateDown(o, { env: "test", to: 10 }), [12, 11]);       // E7 (0015): 0015 too; 0014 + 0013 already rolled back by the refused attempt above (no claimed unlinked recording)
    assert.equal((await o.query("SELECT to_regclass('booking.recording_conflict_inbox') AS t")).rows[0].t, null);
    const n = Number((await o.query("SELECT count(*) AS n FROM booking.provider_evidence WHERE kind = 'hostaway_offline_charges'")).rows[0].n);
    assert.ok(n >= 2);
    assert.deepEqual(await migrateUp(o, { env: "test" }), [11, 12, 13, 14, 15, 16]);   // E7 (0015): mechanical suffix
    assert.equal(Number((await o.query("SELECT count(*) AS n FROM booking.recording_conflict_inbox WHERE processed_at IS NULL")).rows[0].n), n);
    const out = await drainRecordingConflictInbox(d2.app, { by: "backfill-drain" });
    assert.ok(out.drained && out.errors.length === 0);
    const h = (await o.query("SELECT * FROM booking.recording_holds WHERE intent_id = $1", [c.id])).rows;
    assert.deepEqual([h.length, h[0].reason, h[0].intent_state_at_hold], [1, "LINKED_CONTRADICTED", "confirmed"]);
    assert.equal((await o.query("SELECT outcome FROM booking.recording_conflict_inbox WHERE evidence_id = $1", [bad])).rows[0].outcome, "contradiction_opened");
    assert.equal((await o.query("SELECT state FROM booking.intents WHERE id = $1", [c.id])).rows[0].state, "confirmed");
    // rollback now refuses: owner-hold audit exists
    await assert.rejects(migrateDown(o, { env: "test", to: 10 }), /DOWNGRADE_REFUSED_RECORDING_OWNER_CASE_AUDIT/);
  } finally { await o.end(); await d2.close(); }
});

test("T-G2: 0011 down refuses while any hold / observation / decision or attempted / processed inbox item exists (audit kept); no 0013 object exists", async () => {
  const o = await asOwnerClient();
  try {
    // E7.4b-D1 (0012 / 0013): this file holds no 0013 audit, so 0013 rolls back; its healthy claims carry real 0012 assessments, so the 0012 gate
    // refuses next; the 0011 OWNER_CASE gate itself is asserted at the end of T-C9 (fresh cluster) and in e74b-d1-assessments (D-3)
    // E7.4b-D1 (0014): this file now holds claimed recordings that are still unlinked, so the 0014 gate refuses FIRST and nothing rolls back;
    // the 0013 rollback / 0012 refusal are asserted in fresh clusters (e74b-d1-release D-13, e74b-d1-assessments D-1..D-3, T-C9 above)
    // E7 (0015): explicit target 14 first (function-only 0015 is ungated), so the 0014 gate is again the LATEST step, exactly as this test measures
    assert.deepEqual(await migrateDown(o, { env: "test", to: 14 }), [16, 15]);
    await assert.rejects(migrateDown(o, { env: "test", to: 10 }), /DOWNGRADE_REFUSED_RECORDING_COMPLETION_BINDING/);
    assert.ok((await o.query("SELECT to_regprocedure('booking.recording_completion_binding_refusal(uuid,uuid,text)') AS f")).rows[0].f, "0014 still applied");
    assert.ok((await o.query("SELECT to_regclass('booking.recording_holds') AS t")).rows[0].t, "0011 still applied");
    assert.ok((await o.query("SELECT to_regclass('booking.recording_assessments') AS t")).rows[0].t, "0012 still applied");
    assert.equal((await o.query("SELECT count(*)::int AS n FROM pg_proc WHERE proname IN ('admin_release_preflight_hold', 'open_recording_preflight_hold', 'record_release_review_assessment')")).rows[0].n, 3,
      "0013 unchanged (refused before it)");
    assert.deepEqual(await migrateUp(o, { env: "test", to: 14 }), [], "nothing rolled back");
    assert.deepEqual(await migrateUp(o, { env: "test" }), [15, 16]);   // E7 (0015): restore the latest schema for the rest of this file
  } finally { await o.end(); }
});

test("T-G3: scoped effects across this file — no ESCALATE / notify / void / cancel / refund operation and no dispatched provider write was created by holds, drains or acknowledgements", async () => {
  const n = (await db.owner.query(`SELECT count(*)::int AS n FROM booking.external_operations WHERE op_type IN ('guest.notify', 'alert.owner', 'stripe.void_payment_intent',
      'hostaway.cancel_reservation', 'stripe.refund_payment') AND created_at > now() - interval '1 day' AND state <> 'pending'`)).rows[0].n;
  assert.equal(n, 0, "nothing dispatched");
  const inflight = (await db.owner.query(`SELECT count(*)::int AS n FROM booking.external_operations WHERE op_type = 'hostaway.record_offline_charge' AND state = 'in_flight'
      AND idempotency_key !~ ':1$'`)).rows[0].n;
  assert.equal(inflight, 0, "no attempt > 1 was ever claimed in flight by automation in this file");
});
