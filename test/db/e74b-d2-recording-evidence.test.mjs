// Stage E7.4b-D2 — migration 0010: recording success <-> full immutable API proof; finalisation gate; positive-contradiction
// semantics; evidence-writer serialisation. Throwaway local PostgreSQL; repository code runs as the runtime login (test_app ∈
// mv_booking_app), owner reconciliation as test_admin (∈ mv_booking_admin); the schema owner (postgres) only for setup / probes.
// Every provider observation is a SYNTHETIC fixture shaped like the accepted pure module's EVIDENCE_OBSERVED_KEYS.
// 0010 compares proof times with the DATABASE clock, so recording steps use real caller times (Date.now()).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { startMigratedDatabase } from "./harness.mjs";
import * as F from "./fixtures.mjs";
import { applyEvent, loadIntent } from "../../db/lib/repo.js";
import { claimNextOperation, completeOperation, completeRecordingWithEvidence, linkRecordingEvidence, recoverExpiredOperations,
  listRecordingContradictions, requestRead, recordProviderEvidence } from "../../db/lib/operations.js";
import { adminResolveOperation } from "../../db/lib/admin.js";
import { migrateDown } from "../../db/lib/migrate.js";

let db;
before(async () => { db = await startMigratedDatabase(); });
after(async () => { await db.close(); });

const MIN = 60 * 1000;
const OCH = ["hostaway.record_offline_charge"];
let stayN = 0;
const stay = () => { stayN += 1; const d = new Date(Date.UTC(2028, 0, 1) + stayN * 6 * 86400000).toISOString().slice(0, 10);
  const e = new Date(Date.UTC(2028, 0, 1) + (stayN * 6 + 3) * 86400000).toISOString().slice(0, 10); return { listingId: 780000 + stayN, from: d, to: e }; };
const row = async (id) => (await db.app.query("SELECT * FROM booking.external_operations WHERE id = $1", [id])).rows[0];
const facts = async (id) => (await db.app.query("SELECT version, listing_id, state FROM booking.intents WHERE id = $1", [id])).rows[0];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function capturedIntent() {
  const c = await F.captured(db.app, stay());
  const f = await facts(c.id);
  return { ...c, listingId: f.listing_id };
}
/** captured + claimed initial recording (work lease held by w1); -> { c, op, t } */
async function claimed({ at = Date.now(), leaseMs = 10 * MIN } = {}) {
  const c = await capturedIntent();
  await db.app.query("UPDATE booking.intent_work SET work_worker_id = 'w1', work_lease_until = $2 WHERE intent_id = $1", [c.id, new Date(at + 10 * MIN)]);
  const op = await claimNextOperation(db.app, { workerId: "w1", now: at, intentId: c.id, opTypes: OCH, leaseMs });
  assert.ok(op);
  return { c, op, t: at };
}
const obs = (c, id, o = {}) => F.recordingObserved(c, id, o);
const evAt = (c, observed, t = Date.now()) => F.chargeListEvidence(db.app, c, observed, t);
const version = async (c) => (await facts(c.id)).version;
const complete = async (c, op, ev, resultRef, o = {}) => completeRecordingWithEvidence(db.app, op.id, { workerId: "w1", evidenceId: ev, resultRef,
  expectedVersion: o.expectedVersion ?? await version(c), ...o });
// outbox effects = every non-read operation row (reads are the test's own mocked provider reads)
const effects = async (id) => Number((await db.app.query("SELECT count(*) AS n FROM booking.external_operations WHERE intent_id = $1 AND retry_class <> 'read'", [id])).rows[0].n);
const transitions = async (id) => Number((await db.app.query("SELECT count(*) AS n FROM booking.intent_transitions WHERE intent_id = $1", [id])).rows[0].n);
async function waitForLockWaiters(n = 1, timeoutMs = 5000) {
  const t0 = Date.now();
  for (;;) {
    const r = await db.owner.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`);
    if (r.rows[0].n >= n) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`no lock waiter observed within ${timeoutMs} ms`);
    await sleep(10);
  }
}
const evidenceKey = (intentId) => [ "SELECT pg_advisory_xact_lock(hashtext('booking.recording_evidence'), hashtext($1::text))", [intentId] ];
async function asOwnerClient() { const c = new pg.Client({ connectionString: db.adminUrl }); await c.connect(); return c; }
async function asAppClient() { const c = new pg.Client({ connectionString: db.appUrl() }); await c.connect(); return c; }

// =============================================================================================
test("happy path: success + full proof link commit atomically; finalisation then works; only E3's defined effects appear", async () => {
  const { c, op, t } = await claimed();
  const ev = await evAt(c, obs(c, "990001"), t + 5);
  const e0 = await effects(c.id);
  assert.deepEqual(await complete(c, op, ev, "990001"), { ok: true, state: "succeeded" });
  const r = await row(op.id);
  assert.deepEqual([r.state, r.result_ref, r.settled_evidence_id, r.lease_worker_id], ["succeeded", "990001", ev, null]);
  assert.ok(r.completed_at && new Date(r.completed_at).getTime() <= Date.now() + 1000);
  assert.equal(await effects(c.id), e0, "completion creates no outbox rows");
  const fin = F.ok(await applyEvent(db.app, c.id, { type: "OFFLINE_CHARGE_RECORDED", chargeId: "990001" }, { now: Date.now(), actor: "worker" }));
  assert.equal(fin.intent.status, "confirmed");
  const added = (await db.app.query("SELECT op_type, state, payload FROM booking.external_operations WHERE intent_id = $1 ORDER BY created_at DESC LIMIT 1", [c.id])).rows;
  assert.equal(await effects(c.id), e0 + 1, "finalisation adds exactly E3's own guest.notify outbox row");
  assert.deepEqual([added[0].op_type, added[0].state], ["guest.notify", "pending"], "queued only; nothing dispatched");
});

test("app direct INSERT / UPDATE cannot pre-seed, attach, succeed or relabel a recording", async () => {
  // an intent with NO recording yet (reserved, not captured): only the 0010 lifecycle guard can refuse the pre-seeded INSERT
  const c = await F.reserved(db.app, stay());
  const app = await asAppClient();
  try {
    const ins = (cols) => app.query(`INSERT INTO booking.external_operations (id, intent_id, op_type, idempotency_key, retry_class, state, payload, source_version, max_attempts,
        next_attempt_at, created_at, updated_at${cols.k}) VALUES (gen_random_uuid(), $1, 'hostaway.record_offline_charge', $2, 'non_idempotent', 'pending', $3, 0, 1, now(), now(), now()${cols.v})`,
      [c.id, cols.key ?? `och:${c.id}:1`, { reservationId: String(c.reservationId), amountMinor: 576000 }]);
    for (const cols of [{ k: ", result_ref", v: ", '1'" }, { k: ", completed_at", v: ", now()" }, { k: ", dispatched_at", v: ", now()" },
      { k: ", lease_worker_id, lease_until", v: ", 'w', now()" }, { k: ", late_result_status", v: ", 'succeeded'" }, { k: "", v: "", key: `och:${c.id}:x` },
      { k: "", v: "", key: `och:00000000-0000-4000-8000-000000000000:1` }]) {
      await assert.rejects(ins(cols), /RECORDING_LIFECYCLE_IMMUTABLE/, cols.k || cols.key);
    }
    const anyEv = (await db.owner.query("SELECT id FROM booking.provider_evidence LIMIT 1")).rows[0];
    assert.ok(anyEv);
    await assert.rejects(ins({ k: ", settled_evidence_id", v: `, '${anyEv.id}'` }), /RECORDING_LIFECYCLE_IMMUTABLE/);
  } finally { await app.end(); }
  // key format (as owner, bypassing the earlier-recording guard ordering is not needed: a fresh intent)
  const c2 = await capturedIntent();
  const pending = (await db.app.query("SELECT id FROM booking.external_operations WHERE intent_id = $1 AND op_type = 'hostaway.record_offline_charge'", [c2.id])).rows[0];
  const ev = await evAt(c2, obs(c2, "990002"));
  await assert.rejects(db.app.query("UPDATE booking.external_operations SET settled_evidence_id = $2 WHERE id = $1", [pending.id, ev]), /RECORDING_LIFECYCLE_IMMUTABLE/);
  // claimed row: direct -> succeeded with a VALID link is still refused (authorization: not inside the granted function)
  await db.app.query("UPDATE booking.intent_work SET work_worker_id = 'w1', work_lease_until = $2 WHERE intent_id = $1", [c2.id, new Date(Date.now() + 10 * MIN)]);
  const op = await claimNextOperation(db.app, { workerId: "w1", now: Date.now(), intentId: c2.id, opTypes: OCH, leaseMs: 10 * MIN });
  const ev2 = await evAt(c2, obs(c2, "990002"));
  await assert.rejects(db.app.query(`UPDATE booking.external_operations SET state = 'succeeded', result_ref = '990002', settled_evidence_id = $2, completed_at = now(),
      lease_worker_id = NULL, lease_until = NULL WHERE id = $1`, [op.id, ev2]), (e) => e.code === "42501" && /RECORDING_SUCCESS_REQUIRES_FUNCTION/.test(e.message));
  await assert.rejects(db.app.query("UPDATE booking.external_operations SET dispatched_at = now() WHERE id = $1", [op.id]), /RECORDING_LIFECYCLE_IMMUTABLE: dispatched_at/);
  await assert.rejects(db.app.query("UPDATE booking.external_operations SET source_version = source_version + 1 WHERE id = $1", [op.id]), /source_version/);
  // generic completion refuses success WITHOUT taking the op row lock (another session holds it)
  const holder = await asOwnerClient();
  try {
    await holder.query("BEGIN"); await holder.query("SELECT 1 FROM booking.external_operations WHERE id = $1 FOR UPDATE", [op.id]);
    const r = await Promise.race([completeOperation(db.app, op.id, { workerId: "w1", now: Date.now(), outcome: { status: "succeeded", resultRef: "990002" } }),
      sleep(3000).then(() => "BLOCKED")]);
    assert.deepEqual(r, { ok: false, error: "RECORDING_SUCCESS_REQUIRES_EVIDENCE" });
  } finally { await holder.query("ROLLBACK"); await holder.end(); }
  assert.equal((await row(op.id)).state, "in_flight");
});

test("linked rows are frozen: result_ref / completed_at / dispatched_at / late result / state; repoint and clear refused for every role", async () => {
  const { c, op, t } = await claimed();
  const ev = await evAt(c, obs(c, "990003"), t + 5);
  F.ok(await complete(c, op, ev, "990003"));
  for (const [sql, re] of [["result_ref = '990004'", /frozen/], ["completed_at = now()", /frozen/], ["dispatched_at = now()", /frozen/],
    ["late_result_status = 'succeeded'", /frozen/], ["error_code = 'X'", /frozen/]]) {
    await assert.rejects(db.app.query(`UPDATE booking.external_operations SET ${sql} WHERE id = $1`, [op.id]), re, sql);
    await assert.rejects(db.owner.query(`UPDATE booking.external_operations SET ${sql} WHERE id = $1`, [op.id]), re, `owner ${sql}`);
  }
  const ev2 = await evAt(c, obs(c, "990003"));
  await assert.rejects(db.owner.query("UPDATE booking.external_operations SET settled_evidence_id = $2 WHERE id = $1", [op.id, ev2]), /SETTLED_EVIDENCE_IMMUTABLE/);
  await assert.rejects(db.owner.query("UPDATE booking.external_operations SET settled_evidence_id = NULL WHERE id = $1", [op.id]), /SETTLED_EVIDENCE_IMMUTABLE/);
  assert.equal((await db.app.query("UPDATE booking.external_operations SET updated_at = now() WHERE id = $1", [op.id])).rowCount, 1, "updated_at only: allowed");
  assert.deepEqual(await linkRecordingEvidence(db.app, op.id, { evidenceId: ev }), { ok: true, state: "already_linked" }, "same link: harmless no-op");
  assert.deepEqual(await linkRecordingEvidence(db.app, op.id, { evidenceId: ev2 }), { ok: false, error: "RECORDING_ALREADY_LINKED_DIFFERENT" });
});

test("NEW-row validation (not OLD): a privileged UPDATE is judged on the prospective row", async () => {
  // owner-path UPDATE (schema owner => is_privileged) of an in-flight row: NEW.result_ref must match the linked evidence
  const { c, op, t } = await claimed();
  const ev = await evAt(c, obs(c, "990005"), t + 5);
  await assert.rejects(db.owner.query(`UPDATE booking.external_operations SET state = 'succeeded', result_ref = '990006', settled_evidence_id = $2,
      completed_at = clock_timestamp() WHERE id = $1`, [op.id, ev]), /RECORDING_PROOF_REFUSED: OBSERVED_IDS/);
  // OLD.result_ref is NULL: if OLD were used the next one would also fail; NEW carries the bound id => accepted
  assert.equal((await db.owner.query(`UPDATE booking.external_operations SET state = 'succeeded', result_ref = '990005', settled_evidence_id = $2,
      completed_at = clock_timestamp(), lease_worker_id = NULL, lease_until = NULL WHERE id = $1`, [op.id, ev])).rowCount, 1);
  // future completion time refused even for the owner
  const b = await claimed();
  const evb = await evAt(b.c, obs(b.c, "990007"), b.t + 5);
  await assert.rejects(db.owner.query(`UPDATE booking.external_operations SET state = 'succeeded', result_ref = '990007', settled_evidence_id = $2,
      completed_at = clock_timestamp() + interval '1 hour' WHERE id = $1`, [b.op.id, evb]), /COMPLETION_TIME_INVALID/);
});

test("validator: every observed field (wrong, missing, null, mistyped, extra) and every binding refuses atomically; the row stays in_flight", async () => {
  const { c, op, t } = await claimed();
  const good = obs(c, "990010");
  const cases = [
    ["amountMinor", 575999], ["amountMinor", "576000"], ["amountMinor", null], ["chargeId", "990011"], ["chargeId", 990010], ["currency", "USD"],
    ["executorAccountRef", "has space"], ["executorAccountRef", ""], ["executorAccountRef", "x".repeat(65)], ["listingMapId", c.listingId + 1],
    ["listingMapId", String(c.listingId)], ["marker", `mvoch1-${c.id}x`], ["matchingChargeIds", ["990011"]],
    ["paymentMethod", "cash"], ["paymentMethod", "credit_card_online"], ["paymentProvider", "stripe"], ["readCount", 0], ["readCount", 501], ["readCount", 1.5],
    ["reservationId", Number(c.reservationId)], ["status", "awaiting"], ["title", `maraVilla payment mvoch1-${c.id} `], ["type", "refund"]];
  let i = 0;
  for (const [k, v] of cases) {
    i += 1;
    const ev = await evAt(c, { ...good, [k]: v }, t + i);
    const r = await complete(c, op, ev, "990010");
    assert.equal(r.ok, false, `${k}=${JSON.stringify(v)}`);
    assert.match(r.error, /^RECORDING_PROOF_REFUSED$/, `${k}`);
  }
  // count 2 must come with 2 ids (validate_evidence refuses an inconsistent pair at INSERT, before this validator)
  assert.equal((await complete(c, op, await evAt(c, { ...good, matchingChargeCount: 2, matchingChargeIds: ["990010", "990011"] }, t + 39), "990010")).error,
    "RECORDING_PROOF_REFUSED", "count 2");
  const { title, ...missing } = good;
  assert.equal((await complete(c, op, await evAt(c, missing, t + 40), "990010")).error, "RECORDING_PROOF_REFUSED", "missing key");
  assert.equal((await complete(c, op, await evAt(c, { ...good, extra: 1 }, t + 41), "990010")).error, "RECORDING_PROOF_REFUSED", "extra key");
  // bindings: dashboard source; another intent's evidence; read for another selector; non-canonical result ref
  const dash = await F.dashboardEvidence(db.reconciler, c.id, "hostaway_offline_charges", String(c.reservationId), "listed", good, 0);
  assert.equal((await complete(c, op, dash, "990010")).error, "RECORDING_PROOF_REFUSED", "dashboard evidence is not API proof");
  const other = await capturedIntent();
  const evOther = await evAt(other, obs(other, "990010"));
  assert.equal((await complete(c, op, evOther, "990010")).error, "RECORDING_PROOF_REFUSED", "other intent");
  const rid = await requestRead(db.app, c.id, "hostaway.list_offline_charges", "77777777", { now: Date.now() });
  await claimNextOperation(db.app, { workerId: "w-read", now: Date.now(), opId: rid });
  F.ok(await completeOperation(db.app, rid, { workerId: "w-read", now: Date.now(), outcome: { status: "succeeded" } }));
  const evSel = F.ok(await recordProviderEvidence(db.app, { readOpId: rid, kind: "hostaway_offline_charges", externalRef: "77777777", status: "listed", observed: good })).id;
  assert.equal((await complete(c, op, evSel, "990010")).error, "RECORDING_PROOF_REFUSED", "read for another reservation");
  await assert.rejects(completeRecordingWithEvidence(db.app, op.id, { workerId: "w1", evidenceId: evSel, resultRef: "0990010", expectedVersion: 0 }), TypeError);
  const r = await row(op.id);
  assert.deepEqual([r.state, r.settled_evidence_id, r.result_ref], ["in_flight", null, null], "every refusal rolled back: no partial link");
  // the private validator is not executable by the runtime role
  await assert.rejects(db.app.query("SELECT booking.recording_proof_refusal(gen_random_uuid(), '{}'::jsonb, '1', now(), now(), gen_random_uuid(), 'worker_fresh', now())"),
    (e) => e.code === "42501");
});

test("times: evidence before dispatch / in the future / older than 2 min at the decision instant refused; stale version, foreign work lease, expired lease refused", async () => {
  const { c, op, t } = await claimed({ at: Date.now() - 5 * MIN });
  const v = await version(c);
  assert.equal((await complete(c, op, await evAt(c, obs(c, "990020"), Date.now() + 60 * 1000), "990020")).error, "RECORDING_PROOF_REFUSED", "future");
  assert.equal((await complete(c, op, await evAt(c, obs(c, "990020"), Date.now() - 3 * MIN), "990020")).error, "RECORDING_PROOF_REFUSED", "stale (> 2 min)");
  assert.equal((await complete(c, op, await evAt(c, obs(c, "990020"), t - 1000), "990020")).error, "RECORDING_PROOF_REFUSED", "before dispatch");
  const fresh = await evAt(c, obs(c, "990020"));
  assert.equal((await complete(c, op, fresh, "990020", { expectedVersion: v + 1 })).error, "RECORDING_VERSION_CHANGED");
  await db.app.query("UPDATE booking.intent_work SET work_worker_id = 'w-other' WHERE intent_id = $1", [c.id]);
  assert.equal((await complete(c, op, fresh, "990020")).error, "RECORDING_WORK_LEASE_LOST");
  await db.app.query("UPDATE booking.intent_work SET work_worker_id = 'w1' WHERE intent_id = $1", [c.id]);
  assert.equal((await completeRecordingWithEvidence(db.app, op.id, { workerId: "w2", evidenceId: fresh, resultRef: "990020", expectedVersion: v })).error,
    "RECORDING_WORK_LEASE_LOST");
  const { c: c2, op: op2 } = await claimed({ leaseMs: 1 });
  await sleep(20);
  assert.equal((await complete(c2, op2, await evAt(c2, obs(c2, "990021")), "990021")).error, "RECORDING_LEASE_LOST");
  assert.deepEqual(await complete(c, op, fresh, "990020"), { ok: true, state: "succeeded" });
});

test("post-wait expiry inside ONE function call: op lease (row-lock wait) and work lease (advisory-lock wait) are judged at the post-lock clock", async () => {
  for (const which of ["row", "advisory"]) {
    const { c, op } = await claimed({ leaseMs: which === "row" ? 2000 : 10 * MIN });
    if (which === "advisory") await db.app.query("UPDATE booking.intent_work SET work_lease_until = $2 WHERE intent_id = $1", [c.id, new Date(Date.now() + 2000)]);
    const ev = await evAt(c, obs(c, "990030"));
    const v = await version(c);
    const holder = await asOwnerClient();
    let res;
    try {
      await holder.query("BEGIN");
      if (which === "row") await holder.query("SELECT 1 FROM booking.external_operations WHERE id = $1 FOR UPDATE", [op.id]);
      else await holder.query(...evidenceKey(c.id));
      const p = completeRecordingWithEvidence(db.app, op.id, { workerId: "w1", evidenceId: ev, resultRef: "990030", expectedVersion: v }).then((x) => { res = x; });
      await waitForLockWaiters(1);
      await sleep(2300);                                                                       // the lease expires WHILE the call waits
      await holder.query("COMMIT");
      await p;
    } finally { await holder.end(); }
    assert.deepEqual(res, { ok: false, error: which === "row" ? "RECORDING_LEASE_LOST" : "RECORDING_WORK_LEASE_LOST" }, which);
    assert.equal((await row(op.id)).state, "in_flight", `${which}: nothing changed`);
  }
});

test("evidence aging past 2 min while the call waits on the advisory lock is refused (fresh at call start, stale at the decision instant)", async () => {
  const { c, op } = await claimed({ at: Date.now() - 5 * MIN });
  const ev = await evAt(c, obs(c, "990031"), Date.now() - (2 * MIN - 1500));                  // 1.5 s of freshness left
  const v = await version(c);
  const holder = await asOwnerClient();
  let res;
  try {
    await holder.query("BEGIN"); await holder.query(...evidenceKey(c.id));
    const p = completeRecordingWithEvidence(db.app, op.id, { workerId: "w1", evidenceId: ev, resultRef: "990031", expectedVersion: v }).then((x) => { res = x; });
    await waitForLockWaiters(1);
    await sleep(2500);
    await holder.query("COMMIT");
    await p;
  } finally { await holder.end(); }
  assert.deepEqual(res, { ok: false, error: "RECORDING_PROOF_REFUSED" });
});

test("positive-contradiction semantics (addendum A): zero-then-one OK; count-only same id OK; other id / multiple / contradictory full fields refuse", async () => {
  const cnt = (ids) => ({ matchingChargeCount: ids.length, matchingChargeIds: ids.map(String) });
  const run = async (prior) => {
    const { c, op, t } = await claimed();
    let k = 0;
    for (const p of prior) { k += 1; await evAt(c, typeof p === "function" ? p(c) : p, t + k); }
    return complete(c, op, await evAt(c, obs(c, "990040"), t + 20), "990040");
  };
  assert.deepEqual(await run([cnt([])]), { ok: true, state: "succeeded" }, "an early zero is absence / lag, not a contradiction");
  assert.deepEqual(await run([cnt([]), cnt([])]), { ok: true, state: "succeeded" });
  assert.deepEqual(await run([cnt(["990040"])]), { ok: true, state: "succeeded" }, "count-only with the same id proves only the id: consistent");
  assert.equal((await run([cnt(["990041"])])).error, "RECORDING_EVIDENCE_CONFLICT", "another id positively observed");
  assert.equal((await run([cnt(["990040", "990041"])])).error, "RECORDING_EVIDENCE_CONFLICT", "multiple matching ids");
  assert.equal((await run([(c) => obs(c, "990040", { amountMinor: 575000 })])).error, "RECORDING_EVIDENCE_CONFLICT", "same id, contradictory full field");
  assert.deepEqual(await run([(c) => ({ ...obs(c, "990099"), marker: "mvoch1-00000000-0000-4000-8000-000000000000" })]), { ok: true, state: "succeeded" },
    "a full-shape row for ANOTHER marker is about another recording");
  // dashboard (count-only) contradiction
  const { c, op, t } = await claimed();
  await F.dashboardEvidence(db.reconciler, c.id, "hostaway_offline_charges", String(c.reservationId), "listed", cnt(["990042"]), 0);
                                                                                              // ^ observed before dispatch: ignored
  const ev = await evAt(c, obs(c, "990040"), t + 5);
  const dashLate = (await db.reconciler.query("SELECT booking.admin_record_evidence($1,'hostaway_offline_charges',$2,'listed',$3,$4,'owner','dash-late') AS id",
    [c.id, String(c.reservationId), cnt(["990042"]), new Date(t + 2000)])).rows[0].id;
  assert.ok(dashLate);
  assert.equal((await complete(c, op, ev, "990040")).error, "RECORDING_EVIDENCE_CONFLICT", "dashboard count-only other id after dispatch");
});

test("owner count-only / dashboard resolution stays succeeded-unproven; >= 15 min historical API proof links it (no age cap); replay is a no-op", async () => {
  const c = await capturedIntent();
  const op = await claimNextOperation(db.app, { workerId: "w1", now: F.at(9), intentId: c.id, opTypes: OCH });
  F.ok(await completeOperation(db.app, op.id, { workerId: "w1", now: F.at(9.2), outcome: { status: "outcome_unknown" } }));
  const dash = await F.dashboardEvidence(db.reconciler, c.id, "hostaway_offline_charges", String(c.reservationId), "listed",
    { matchingChargeCount: 1, matchingChargeIds: ["880101"] }, 30);
  F.ok(await adminResolveOperation(db.reconciler, { operationId: op.id, decision: "succeeded", evidenceIds: [dash], resultRef: 880101,
    resolver: "owner", justification: "CHARGE_FOUND_IN_HOSTAWAY", at: F.at(60) }));
  const before = await row(op.id);
  assert.deepEqual([before.state, before.settled_evidence_id], ["succeeded", null], "owner resolution: succeeded, unproven");
  assert.equal((await applyEvent(db.app, c.id, { type: "OFFLINE_CHARGE_RECORDED", chargeId: "880101" }, { now: F.at(61) })).error, "OFFLINE_CHARGE_PROOF_NOT_LINKED");
  const t0 = await transitions(c.id); const e0 = await effects(c.id);
  const early = await evAt(c, obs(c, "880101"), F.at(9 + 14));
  assert.equal((await linkRecordingEvidence(db.app, op.id, { evidenceId: early })).error, "RECORDING_PROOF_REFUSED", "< 15 min after dispatch");
  const old = await evAt(c, obs(c, "880101"), F.at(9 + 15));                                  // exactly 15 min, ~2 weeks ago: no max age
  assert.deepEqual(await linkRecordingEvidence(db.app, op.id, { evidenceId: old }), { ok: true, state: "linked" });
  assert.deepEqual(await linkRecordingEvidence(db.app, op.id, { evidenceId: old }), { ok: true, state: "already_linked" });
  const after = await row(op.id);
  assert.deepEqual([after.result_ref, after.resolution_id, String(after.completed_at)], [before.result_ref, before.resolution_id, String(before.completed_at)],
    "owner resolution identity unchanged");
  assert.deepEqual([await transitions(c.id), await effects(c.id), (await facts(c.id)).state], [t0, e0, "payment_captured"], "link maintenance: no state change, no effects");
  F.ok(await applyEvent(db.app, c.id, { type: "OFFLINE_CHARGE_RECORDED", chargeId: "880101" }, { now: Date.now() }));
  assert.equal((await facts(c.id)).state, "confirmed");
  // a late result reported twice on an unknown recording keeps the FIRST and still answers LEASE_LOST
  const { c: c3, op: op3 } = await claimed({ leaseMs: 1 });
  await sleep(20);
  await recoverExpiredOperations(db.app, { now: Date.now(), intentId: c3.id });
  const l1 = await completeOperation(db.app, op3.id, { workerId: "w1", now: Date.now(), outcome: { status: "succeeded", resultRef: "1" } });
  assert.equal(l1.ok, false);
  const l1b = await completeOperation(db.app, op3.id, { workerId: "w1", now: Date.now(), outcome: { status: "outcome_unknown" } });
  const l2 = await completeOperation(db.app, op3.id, { workerId: "w1", now: Date.now(), outcome: { status: "outcome_unknown", resultRef: "2" } });
  assert.deepEqual([l1b.error, l1b.lateEvidenceRecorded, l2.error, l2.lateEvidenceRecorded], ["LEASE_LOST", true, "LEASE_LOST", false]);
  assert.deepEqual([(await row(op3.id)).late_result_status, (await row(op3.id)).late_result_ref], ["outcome_unknown", null], "first late result kept");
});

test("inherited already-confirmed unlinked row: link allowed, state unchanged; latest selection: only attempt 1 completes / links", async () => {
  const c = await capturedIntent();
  const op = await claimNextOperation(db.app, { workerId: "w1", now: F.at(9), intentId: c.id, opTypes: OCH });
  F.ok(await completeOperation(db.app, op.id, { workerId: "w1", now: F.at(9.2), outcome: { status: "outcome_unknown" } }));
  const ev0 = await F.readEvidence(db.app, c.id, "hostaway_offline_charges", String(c.reservationId), "listed", { matchingChargeCount: 1, matchingChargeIds: ["880201"] }, 30);
  F.ok(await adminResolveOperation(db.reconciler, { operationId: op.id, decision: "succeeded", evidenceIds: [ev0], resultRef: 880201, resolver: "owner",
    justification: "CHARGE_FOUND_IN_HOSTAWAY", at: F.at(60) }));
  // simulate a row finalised BEFORE 0010 existed (triggers bypassed by the superuser only for this setup)
  const o = await asOwnerClient();
  try {
    await o.query("BEGIN"); await o.query("SET LOCAL session_replication_role = replica");
    await o.query("UPDATE booking.intents SET state = 'confirmed', offline_charge_id = '880201', version = version + 1 WHERE id = $1", [c.id]);
    await o.query("COMMIT");
  } finally { await o.end(); }
  const ev = await evAt(c, obs(c, "880201"), F.at(40));
  assert.deepEqual(await linkRecordingEvidence(db.app, op.id, { evidenceId: ev }), { ok: true, state: "linked" });
  assert.equal((await facts(c.id)).state, "confirmed");
  // latest selection: attempt 1 owner-failed, E3 queues attempt 2; attempt 2 cannot complete through the initial-attempt function
  const c2 = await capturedIntent();
  const a1 = await claimNextOperation(db.app, { workerId: "w1", now: F.at(9), intentId: c2.id, opTypes: OCH });
  F.ok(await completeOperation(db.app, a1.id, { workerId: "w1", now: F.at(9.2), outcome: { status: "outcome_unknown" } }));
  const api = await F.readEvidence(db.app, c2.id, "hostaway_offline_charges", String(c2.reservationId), "listed", { matchingChargeCount: 0, matchingChargeIds: [] }, 40);
  const dsh = await F.dashboardEvidence(db.reconciler, c2.id, "hostaway_offline_charges", String(c2.reservationId), "listed", { matchingChargeCount: 0, matchingChargeIds: [] }, 45);
  F.ok(await adminResolveOperation(db.reconciler, { operationId: a1.id, decision: "failed_definite", evidenceIds: [api, dsh], resolver: "owner",
    justification: "NO_CHARGE_IN_HOSTAWAY", at: F.at(60) }));
  F.ok(await applyEvent(db.app, c2.id, { type: "OFFLINE_CHARGE_FAILED" }, { now: F.at(61) }));
  await db.app.query("UPDATE booking.intent_work SET work_worker_id = 'w1', work_lease_until = $2 WHERE intent_id = $1", [c2.id, new Date(Date.now() + 10 * MIN)]);
  const a2 = await claimNextOperation(db.app, { workerId: "w1", now: Date.now(), intentId: c2.id, opTypes: OCH, leaseMs: 10 * MIN });
  assert.ok(a2 && a2.idempotency_key.endsWith(":2"));
  const ev2 = await evAt({ ...c2, listingId: c2.listingId }, obs(c2, "880202"));
  assert.equal((await complete(c2, a2, ev2, "880202")).error, "RECORDING_STATE", "only the initial attempt completes here");
  assert.equal((await linkRecordingEvidence(db.app, a1.id, { evidenceId: ev2 })).error, "RECORDING_STATE", "a failed attempt is not linkable");
});

test("finalisation is gated in the DB: a direct UPDATE on an owner-resolved UNLINKED row is refused by the trigger itself", async () => {
  const c = await capturedIntent();
  const op = await claimNextOperation(db.app, { workerId: "w1", now: F.at(9), intentId: c.id, opTypes: OCH });
  F.ok(await completeOperation(db.app, op.id, { workerId: "w1", now: F.at(9.2), outcome: { status: "outcome_unknown" } }));
  const ev0 = await F.readEvidence(db.app, c.id, "hostaway_offline_charges", String(c.reservationId), "listed", { matchingChargeCount: 1, matchingChargeIds: ["880301"] }, 30);
  F.ok(await adminResolveOperation(db.reconciler, { operationId: op.id, decision: "succeeded", evidenceIds: [ev0], resultRef: 880301, resolver: "owner",
    justification: "CHARGE_FOUND_IN_HOSTAWAY", at: F.at(60) }));
  for (const pool of [db.app, db.owner]) {                                                    // bypasses the repo.js mirror entirely
    await assert.rejects(pool.query("UPDATE booking.intents SET state = 'confirmed', offline_charge_id = '880301', version = version + 1 WHERE id = $1", [c.id]),
      /RECORDING_FINALISATION_UNPROVEN/);
  }
  assert.equal((await facts(c.id)).state, "payment_captured");
});

test("finalisation is gated in the DB: direct UPDATE / generic event without a link refused; positive contradiction refuses", async () => {
  const c = await capturedIntent();
  await assert.rejects(db.app.query("UPDATE booking.intents SET state = 'confirmed', offline_charge_id = '1', version = version + 1 WHERE id = $1", [c.id]),
    /RECORDING_FINALISATION_UNPROVEN|not allowed|transition/i);
  assert.equal((await facts(c.id)).state, "payment_captured");
  const { c: c2, op, t } = await claimed();
  F.ok(await complete(c2, op, await evAt(c2, obs(c2, "990050"), t + 5), "990050"));
  await evAt(c2, { matchingChargeCount: 1, matchingChargeIds: ["990051"] });                  // later contradiction, stored
  const r = await applyEvent(db.app, c2.id, { type: "OFFLINE_CHARGE_RECORDED", chargeId: "990050" }, { now: Date.now() });
  assert.deepEqual([r.ok, r.error], [false, "RECORDING_EVIDENCE_CONFLICT"]);
  assert.equal((await facts(c2.id)).state, "payment_captured", "paid truth kept; nothing reversed or escalated");
});

for (const writer of ["api", "dashboard"]) {
  test(`finalisation vs a concurrent ${writer} evidence writer: writer-first is SEEN after the advisory wait (fresh snapshot); finalisation-first commits, evidence is stored and scannable`, async () => {
    const cnt = { matchingChargeCount: 1, matchingChargeIds: ["990999"] };
    const startWriter = async (c, client) => {
      if (writer === "api") {
        const rid = await requestRead(db.app, c.id, "hostaway.list_offline_charges", String(c.reservationId), { now: Date.now() });
        await claimNextOperation(db.app, { workerId: "w-read", now: Date.now(), opId: rid });
        F.ok(await completeOperation(db.app, rid, { workerId: "w-read", now: Date.now(), outcome: { status: "succeeded" } }));
        return client.query("SELECT booking.record_provider_evidence($1,'hostaway_offline_charges',$2,'listed',$3,NULL) AS id", [rid, String(c.reservationId), cnt]);
      }
      return client.query("SELECT booking.admin_record_evidence($1,'hostaway_offline_charges',$2,'listed',$3,$4,'owner','race') AS id",
        [c.id, String(c.reservationId), cnt, new Date()]);
    };
    let seq = writer === "api" ? 990600 : 990700;
    const mk = async () => { const id = String(++seq); const { c, op, t } = await claimed(); F.ok(await complete(c, op, await evAt(c, obs(c, id), t + 5), id)); return { c, id }; };
    const loginUrl = writer === "api" ? db.appUrl() : db.adminUrl2();
    // (1) writer first: holds the advisory lock with an uncommitted contradiction; finalisation waits; writer commits; finalisation refuses
    {
      const { c, id } = await mk();
      const w = new pg.Client({ connectionString: loginUrl }); await w.connect();
      try {
        await w.query("BEGIN"); await startWriter(c, w);
        const fin = applyEvent(db.app, c.id, { type: "OFFLINE_CHARGE_RECORDED", chargeId: id }, { now: Date.now() });
        await waitForLockWaiters(1);
        await w.query("COMMIT");
        const r = await fin;
        assert.deepEqual([r.ok, r.error], [false, "RECORDING_EVIDENCE_CONFLICT"], "the outer UPDATE snapshot is older than the commit; the post-lock SELECT saw it");
      } finally { await w.end(); }
    }
    // (2) finalisation first: it holds the advisory lock (beforeCommit hook); the writer waits; finalisation commits; evidence then stored
    {
      const { c, id } = await mk();
      const w = new pg.Client({ connectionString: loginUrl }); await w.connect();
      let wp;
      try {
        F.ok(await applyEvent(db.app, c.id, { type: "OFFLINE_CHARGE_RECORDED", chargeId: id }, { now: Date.now(), hooks: { beforeCommit: async () => {
          await w.query("BEGIN"); wp = startWriter(c, w);
          await waitForLockWaiters(1);
        } } }));
        await wp; await w.query("COMMIT");
      } finally { await w.end(); }
      assert.equal((await facts(c.id)).state, "confirmed", "no reversal");
      const all = []; let after = null;
      do { const p = await listRecordingContradictions(db.app, { after, limit: 1 }); all.push(...p.rows); after = p.next; } while (after);
      assert.ok(all.some((x) => x.intentId === c.id && x.source === (writer === "api" ? "hostaway_api" : "hostaway_dashboard")), "found by the paged scan");
    }
  });
}

test("read-only contradiction scan pages > limit findings with a stable (observed_at, id) cursor", async () => {
  const { c, op, t } = await claimed();
  F.ok(await complete(c, op, await evAt(c, obs(c, "990070"), t + 5), "990070"));
  for (let k = 0; k < 5; k++) await evAt(c, { matchingChargeCount: 1, matchingChargeIds: [String(990071 + k)] });
  await evAt(c, { matchingChargeCount: 0, matchingChargeIds: [] });                           // absence: not a finding
  const mine = []; let after = null; let pages = 0;
  do { const p = await listRecordingContradictions(db.app, { after, limit: 2 }); pages += 1; mine.push(...p.rows.filter((x) => x.intentId === c.id)); after = p.next; } while (after);
  assert.equal(mine.length, 5);
  assert.equal(new Set(mine.map((x) => x.evidenceId)).size, 5, "no duplicates across pages");
  assert.ok(pages >= 3);
});

test("downgrade refuses while recordings are linked or progressed (no silent re-enable of unproven finalisation)", async () => {
  const o = await asOwnerClient();
  try { await assert.rejects(migrateDown(o, { env: "test", to: 9 }), /DOWNGRADE_REFUSED_RECORDINGS_PROGRESSED/); }
  finally { await o.end(); }
  assert.ok((await db.owner.query("SELECT to_regprocedure('booking.complete_recording_with_evidence(uuid,text,uuid,text,integer)') AS f")).rows[0].f, "0010 still applied");
});

for (const [who, writer] of [["completion", "api"], ["completion", "dashboard"], ["link", "api"]]) {
  test(`${who} vs a concurrent ${writer} evidence writer holding an UNCOMMITTED contradiction: the call waits on the advisory lock, then sees it (fresh snapshot) and refuses`, async () => {
    const cnt = { matchingChargeCount: 1, matchingChargeIds: ["991999"] };
    let c; let call;
    if (who === "completion") {
      const x = await claimed();
      c = x.c;
      const ev = await evAt(c, obs(c, "991001"), x.t + 5);
      const v = await version(c);
      call = () => completeRecordingWithEvidence(db.app, x.op.id, { workerId: "w1", evidenceId: ev, resultRef: "991001", expectedVersion: v });
    } else {
      c = await capturedIntent();
      const op = await claimNextOperation(db.app, { workerId: "w1", now: F.at(9), intentId: c.id, opTypes: OCH });
      F.ok(await completeOperation(db.app, op.id, { workerId: "w1", now: F.at(9.2), outcome: { status: "outcome_unknown" } }));
      const ev0 = await F.readEvidence(db.app, c.id, "hostaway_offline_charges", String(c.reservationId), "listed", { matchingChargeCount: 1, matchingChargeIds: ["991001"] }, 30);
      F.ok(await adminResolveOperation(db.reconciler, { operationId: op.id, decision: "succeeded", evidenceIds: [ev0], resultRef: 991001, resolver: "owner",
        justification: "CHARGE_FOUND_IN_HOSTAWAY", at: F.at(60) }));
      const full = await evAt(c, obs(c, "991001"), F.at(40));
      call = () => linkRecordingEvidence(db.app, op.id, { evidenceId: full });
    }
    const w = new pg.Client({ connectionString: writer === "api" ? db.appUrl() : db.adminUrl2() }); await w.connect();
    let res;
    try {
      let rid;
      if (writer === "api") {
        rid = await requestRead(db.app, c.id, "hostaway.list_offline_charges", String(c.reservationId), { now: Date.now() });
        await claimNextOperation(db.app, { workerId: "w-read", now: Date.now(), opId: rid });
        F.ok(await completeOperation(db.app, rid, { workerId: "w-read", now: Date.now(), outcome: { status: "succeeded" } }));
      }
      await w.query("BEGIN");
      if (writer === "api") await w.query("SELECT booking.record_provider_evidence($1,'hostaway_offline_charges',$2,'listed',$3,NULL)", [rid, String(c.reservationId), cnt]);
      else await w.query("SELECT booking.admin_record_evidence($1,'hostaway_offline_charges',$2,'listed',$3,$4,'owner','race')", [c.id, String(c.reservationId), cnt, new Date()]);
      const p = call().then((x) => { res = x; });
      await waitForLockWaiters(1);
      const waiting = (await db.owner.query("SELECT locktype FROM pg_locks WHERE NOT granted")).rows.map((x) => x.locktype);
      assert.deepEqual(waiting, ["advisory"], "the call waits on the advisory evidence lock (not a row lock)");
      await w.query("COMMIT");
      await p;
    } finally { await w.end(); }
    assert.deepEqual(res, { ok: false, error: "RECORDING_EVIDENCE_CONFLICT" });
  });
}
