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
import { migrateDown, migrateUp } from "../../db/lib/migrate.js";

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

test("inherited already-confirmed unlinked row: link allowed, state unchanged", async () => {
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
});

test("policy: automated completion is initial-attempt only; maintenance LINK is allowed on the latest owner-succeeded attempt 2 (no send, no new attempt); a failed attempt is not linkable", async () => {
  const c2 = await capturedIntent();
  const a1 = await claimNextOperation(db.app, { workerId: "w1", now: F.at(9), intentId: c2.id, opTypes: OCH });
  F.ok(await completeOperation(db.app, a1.id, { workerId: "w1", now: F.at(9.2), outcome: { status: "outcome_unknown" } }));
  const api = await F.readEvidence(db.app, c2.id, "hostaway_offline_charges", String(c2.reservationId), "listed", { matchingChargeCount: 0, matchingChargeIds: [] }, 40);
  const dsh = await F.dashboardEvidence(db.reconciler, c2.id, "hostaway_offline_charges", String(c2.reservationId), "listed", { matchingChargeCount: 0, matchingChargeIds: [] }, 45);
  F.ok(await adminResolveOperation(db.reconciler, { operationId: a1.id, decision: "failed_definite", evidenceIds: [api, dsh], resolver: "owner",
    justification: "NO_CHARGE_IN_HOSTAWAY", at: F.at(60) }));
  F.ok(await applyEvent(db.app, c2.id, { type: "OFFLINE_CHARGE_FAILED" }, { now: F.at(61) }));
  // attempt 2 (queued by E3): the automatic claim path is fenced since 0011, so the test writes it as genuinely owner-managed /
  // inherited HISTORY (schema owner, triggers bypassed): in flight since t2 under w1's lease. No provider is called anywhere.
  const t2 = Date.now() - 30 * MIN;
  await db.app.query("UPDATE booking.intent_work SET work_worker_id = 'w1', work_lease_until = $2 WHERE intent_id = $1", [c2.id, new Date(Date.now() + 10 * MIN)]);
  assert.equal(await claimNextOperation(db.app, { workerId: "w1", now: t2, intentId: c2.id, opTypes: OCH, leaseMs: 60 * MIN }), null, "attempt 2 is fenced (0011)");
  const a2 = (await F.ownerManagedHistory(db.owner, `UPDATE booking.external_operations SET state = 'in_flight', attempts = 1, dispatched_at = $2,
      lease_worker_id = 'w1', lease_until = $3, updated_at = $2 WHERE intent_id = $1 AND op_type = 'hostaway.record_offline_charge' AND state = 'pending'
      RETURNING *`, [c2.id, new Date(t2), new Date(t2 + 60 * MIN)])).rows[0];
  assert.ok(a2 && a2.idempotency_key.endsWith(":2"));
  const ev2 = await evAt(c2, obs(c2, "880202"));
  assert.equal((await complete(c2, a2, ev2, "880202")).error, "RECORDING_STATE", "automated completion: initial attempt only");
  assert.equal((await linkRecordingEvidence(db.app, a1.id, { evidenceId: ev2 })).error, "RECORDING_STATE", "a failed attempt is not linkable");
  assert.equal((await linkRecordingEvidence(db.app, a2.id, { evidenceId: ev2 })).error, "RECORDING_STATE", "an in-flight attempt is not linkable");
  F.ok(await completeOperation(db.app, a2.id, { workerId: "w1", now: Date.now(), outcome: { status: "outcome_unknown" } }));
  const dash2 = (await db.reconciler.query("SELECT booking.admin_record_evidence($1,'hostaway_offline_charges',$2,'listed',$3,$4,'owner','dash-a2') AS id",
    [c2.id, String(c2.reservationId), { matchingChargeCount: 1, matchingChargeIds: ["880202"] }, new Date(Date.now() - 1000)])).rows[0].id;
  F.ok(await adminResolveOperation(db.reconciler, { operationId: a2.id, decision: "succeeded", evidenceIds: [dash2], resultRef: 880202, resolver: "owner",
    justification: "CHARGE_FOUND_IN_HOSTAWAY", at: Date.now() }));
  const recs = async () => (await db.app.query("SELECT idempotency_key, state FROM booking.external_operations WHERE intent_id = $1 AND op_type = 'hostaway.record_offline_charge' ORDER BY idempotency_key", [c2.id])).rows;
  const r0 = await recs(); const e0 = await effects(c2.id); const t0 = await transitions(c2.id);
  assert.deepEqual(r0.map((x) => x.state), ["failed_definite", "succeeded"]);
  assert.deepEqual(await linkRecordingEvidence(db.app, a2.id, { evidenceId: ev2 }), { ok: true, state: "linked" }, "latest owner-succeeded attempt 2: >= 15 min proof links");
  assert.deepEqual([await recs(), await effects(c2.id), await transitions(c2.id)], [r0, e0, t0], "maintenance link: no send, no new attempt, no effect, no transition");
  assert.equal((await row(a2.id)).settled_evidence_id, ev2);
  F.ok(await applyEvent(db.app, c2.id, { type: "OFFLINE_CHARGE_RECORDED", chargeId: "880202" }, { now: Date.now() }));
  assert.equal((await facts(c2.id)).state, "confirmed");
  assert.deepEqual(await recs(), r0, "still exactly two recording rows; no attempt 3");
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

test("read-only contradiction scan pages > limit findings with a stable (observed_at exact, evidence id, op id) cursor", async () => {
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
  try {
    // E7.4b-D1: 0011 (latest) rolls back first (this file holds no owner-hold audit), then 0010 refuses; re-apply 0011 after
    await assert.rejects(migrateDown(o, { env: "test", to: 9 }), /DOWNGRADE_REFUSED_RECORDINGS_PROGRESSED/);
    assert.deepEqual(await migrateUp(o, { env: "test" }), [11]);
  } finally { await o.end(); }
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

// ============================== root HOLD on 4242a34: corrections ==============================
const cntOnly = (ids) => ({ matchingChargeCount: ids.length, matchingChargeIds: ids.map(String) });
const dashAt = async (c, ref, observed, at, reference = "dash") => (await db.reconciler.query(
  "SELECT booking.admin_record_evidence($1,'hostaway_offline_charges',$2,'listed',$3,$4::timestamptz,'owner',$5) AS id", [c.id, String(ref), observed, at, reference])).rows[0].id;
async function apiOtherRef(c, ref, observed, t = Date.now()) {                                  // an API list read for ANOTHER reservation, same intent
  const rid = await requestRead(db.app, c.id, "hostaway.list_offline_charges", String(ref), { now: t });
  assert.ok(await claimNextOperation(db.app, { workerId: "w-read", now: t, opId: rid }));
  F.ok(await completeOperation(db.app, rid, { workerId: "w-read", now: t, outcome: { status: "succeeded" } }));
  return F.ok(await recordProviderEvidence(db.app, { readOpId: rid, kind: "hostaway_offline_charges", externalRef: String(ref), status: "listed", observed })).id;
}
async function scanAll(limit) {
  const all = []; let after = null; let pages = 0;
  do {
    const p = await listRecordingContradictions(db.app, { after, limit });
    assert.ok(p.rows.length <= limit);
    all.push(...p.rows); after = p.next; pages += 1;
    assert.ok(pages < 5000, "scan terminates");
  } while (after);
  return { all, pages };
}
async function ownerSucceededUnlinked(chargeId) {                                              // dispatched at F.at(9), owner-resolved succeeded, no link
  const c = await capturedIntent();
  const op = await claimNextOperation(db.app, { workerId: "w1", now: F.at(9), intentId: c.id, opTypes: OCH });
  F.ok(await completeOperation(db.app, op.id, { workerId: "w1", now: F.at(9.2), outcome: { status: "outcome_unknown" } }));
  const ev0 = await F.readEvidence(db.app, c.id, "hostaway_offline_charges", String(c.reservationId), "listed", cntOnly([chargeId]), 30);
  F.ok(await adminResolveOperation(db.reconciler, { operationId: op.id, decision: "succeeded", evidenceIds: [ev0], resultRef: Number(chargeId), resolver: "owner",
    justification: "CHARGE_FOUND_IN_HOSTAWAY", at: F.at(60) }));
  return { c, op };
}
const waitingLockTypes = async () => (await db.owner.query("SELECT DISTINCT locktype FROM pg_locks WHERE NOT granted ORDER BY 1")).rows.map((x) => x.locktype);
const caseCount = async (id) => Number((await db.app.query("SELECT count(*) AS n FROM booking.reconciliation_cases WHERE intent_id = $1", [id])).rows[0].n);

test("lossless cursor (real PG): microsecond observed_at within ONE millisecond, equal timestamps with different ids; page sizes 1/2/3 return each row exactly once, in order, then a terminal next", async () => {
  const { c, op, t } = await claimed();
  F.ok(await complete(c, op, await evAt(c, obs(c, "992001"), t + 5), "992001"));
  const ms = (k) => new Date(t + 1000 + k).toISOString().slice(0, 23);                        // 'YYYY-MM-DDTHH:MM:SS.mmm'
  const exacts = [`${ms(0)}100Z`, `${ms(0)}200Z`, `${ms(0)}900Z`, `${ms(1)}000Z`, `${ms(1)}000Z`, `${ms(1)}000Z`, `${ms(2)}000500Z`.replace(/(\.\d{3})000500Z$/, "$1500Z")];
  const mine = [];
  for (const [k, x] of exacts.entries()) mine.push({ exact: x, id: await dashAt(c, c.reservationId, cntOnly([String(992100 + k)]), x, `us-${k}`) });
  const stored = (await db.owner.query(`SELECT id, to_char(observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS x FROM booking.provider_evidence WHERE id = ANY($1)`,
    [mine.map((m) => m.id)])).rows;
  for (const m of mine) assert.equal(stored.find((s) => s.id === m.id).x, m.exact, "the database kept microsecond precision");
  const expected = [...mine].sort((a, b) => (a.exact < b.exact ? -1 : a.exact > b.exact ? 1 : a.id < b.id ? -1 : 1)).map((m) => m.id);
  for (const limit of [1, 2, 3]) {
    const { all, pages } = await scanAll(limit);
    const keys = all.map((x) => `${x.evidenceId}/${x.opId}`);
    assert.equal(new Set(keys).size, keys.length, `limit ${limit}: no row twice anywhere in the scan`);
    const got = all.filter((x) => x.intentId === c.id);
    assert.deepEqual(got.map((x) => x.evidenceId), expected, `limit ${limit}: each of mine exactly once, in (exact time, id) order`);
    for (const x of got) {
      assert.equal(x.observedAtExact, mine.find((m) => m.id === x.evidenceId).exact, "cursor text is the exact stored value");
      assert.equal(x.observedAt, Date.parse(x.observedAtExact.slice(0, 23) + "Z"), "display ms is separate (truncated)");
    }
    assert.ok(pages >= Math.ceil(all.length / limit), `limit ${limit}: > limit pages`);
  }
  // the 4242a34 failure mode: a millisecond cursor would re-select the .000200 row; the exact cursor resumes strictly after it
  const first = await listRecordingContradictions(db.app, { after: { observedAtExact: exacts[0], evidenceId: mine[0].id, opId: op.id }, limit: 1 });
  assert.equal(first.rows[0].evidenceId, expected[1]);
  assert.ok(first.next && first.next.observedAtExact === exacts[1]);
});

test("scan input validation: after must be a complete well-formed cursor; limit is capped at RECORDING_CONTRADICTION_SCAN_MAX", async () => {
  const u = "00000000-0000-4000-8000-000000000000";
  const good = { observedAtExact: "2099-01-01T00:00:00.000100Z", evidenceId: u, opId: u };
  assert.deepEqual((await listRecordingContradictions(db.app, { after: good, limit: 5 })).rows, [], "a well-formed cursor past every row is accepted: empty page");
  for (const bad of [{}, { ...good, opId: undefined }, { observedAtExact: good.observedAtExact, evidenceId: u }, { ...good, extra: 1 },
    { ...good, observedAtExact: "2026-11-03T20:00:00.000Z" }, { ...good, observedAtExact: 1762200000000 }, { ...good, observedAtExact: "2026-11-03 20:00:00.000100+00" },
    { ...good, evidenceId: "x" }, { ...good, opId: "0000000a-0000-4000-8000-00000000000b".toUpperCase() }, "cursor", 5, [good]]) {
    await assert.rejects(listRecordingContradictions(db.app, { after: bad, limit: 5 }), TypeError, JSON.stringify(bad));
  }
  // cap: 505 contradictions on one linked recording; a huge limit returns 500 and a next
  const { c, op, t } = await claimed();
  F.ok(await complete(c, op, await evAt(c, obs(c, "992501"), t + 5), "992501"));
  await db.reconciler.query(`SELECT booking.admin_record_evidence($1,'hostaway_offline_charges',$2,'listed',
      jsonb_build_object('matchingChargeCount',1,'matchingChargeIds',jsonb_build_array((993000 + g)::text)), $3::timestamptz + make_interval(secs => g / 1000000.0), 'owner', 'cap')
    FROM generate_series(1, 505) g`, [c.id, String(c.reservationId), new Date(t + 1000)]);
  const big = await listRecordingContradictions(db.app, { after: null, limit: 1e9 });
  assert.equal(big.rows.length, 500);
  assert.ok(big.next);
  for (const lim of [0, -3, 1.5, "7", NaN]) assert.ok((await listRecordingContradictions(db.app, { limit: lim })).rows.length <= 500);
  const { all } = await scanAll(500);
  assert.equal(all.filter((x) => x.intentId === c.id).length, 505, "full set reachable across pages");
});

test("reservation scope: count-only other id under ANOTHER reservation (same intent; API and dashboard) never blocks completion / link / finalisation and is not scanned; the same reservation still blocks", async () => {
  const otherRef = (c) => `9${c.reservationId}`;
  // completion + finalisation
  const { c, op, t } = await claimed();
  const foreign = [await apiOtherRef(c, otherRef(c), cntOnly(["992601"]), t + 1), await dashAt(c, otherRef(c), cntOnly(["992602"]), new Date(t + 2))];
  assert.deepEqual((await db.owner.query("SELECT array_agg(external_ref ORDER BY external_ref) AS r FROM booking.provider_evidence WHERE id = ANY($1)", [foreign])).rows[0].r,
    [otherRef(c), otherRef(c)], "persisted under the other reservation");
  assert.deepEqual(await complete(c, op, await evAt(c, obs(c, "992600"), t + 5), "992600"), { ok: true, state: "succeeded" });
  foreign.push(await apiOtherRef(c, otherRef(c), cntOnly(["992603", "992604"])), await dashAt(c, otherRef(c), cntOnly(["992605"]), new Date()));
  F.ok(await applyEvent(db.app, c.id, { type: "OFFLINE_CHARGE_RECORDED", chargeId: "992600" }, { now: Date.now() }));
  assert.equal((await facts(c.id)).state, "confirmed");
  let { all } = await scanAll(100);
  assert.equal(all.filter((x) => foreign.includes(x.evidenceId)).length, 0, "another reservation's rows are not this recording's contradictions");
  const same = await evAt(c, cntOnly(["992606"]));                                              // positive control on the SAME reservation
  ({ all } = await scanAll(100));
  assert.deepEqual(all.filter((x) => x.intentId === c.id).map((x) => x.evidenceId), [same]);
  // link
  const { c: c3, op: op3 } = await ownerSucceededUnlinked("992610");
  await apiOtherRef(c3, otherRef(c3), cntOnly(["992611"])); await dashAt(c3, otherRef(c3), cntOnly(["992612"]), new Date());
  assert.deepEqual(await linkRecordingEvidence(db.app, op3.id, { evidenceId: await evAt(c3, obs(c3, "992610"), F.at(40)) }), { ok: true, state: "linked" });
  // same reservation, other id: completion and link both still refuse
  const { c: c2, op: op2, t: t2 } = await claimed();
  await apiOtherRef(c2, otherRef(c2), cntOnly(["992621"]), t2 + 1);
  await dashAt(c2, c2.reservationId, cntOnly(["992622"]), new Date(t2 + 2));
  assert.equal((await complete(c2, op2, await evAt(c2, obs(c2, "992620"), t2 + 5), "992620")).error, "RECORDING_EVIDENCE_CONFLICT");
  const { c: c4, op: op4 } = await ownerSucceededUnlinked("992630");
  await dashAt(c4, c4.reservationId, cntOnly(["992631"]), new Date());
  assert.equal((await linkRecordingEvidence(db.app, op4.id, { evidenceId: await evAt(c4, obs(c4, "992630"), F.at(40)) })).error, "RECORDING_EVIDENCE_CONFLICT");
});

test("paymentMethod / executorAccountRef: a same-id full proof with another approved method or another well-formed account label conflicts (reference = candidate before linking, linked proof after); check and scan agree", async () => {
  const runComplete = async (prior, id) => {
    const { c, op, t } = await claimed();
    await evAt(c, obs(c, id, prior), t + 1);
    return complete(c, op, await evAt(c, obs(c, id), t + 5), id);
  };
  assert.deepEqual(await runComplete({}, "992700"), { ok: true, state: "succeeded" }, "control: an identical earlier full proof is consistent");
  assert.equal((await runComplete({ paymentMethod: "other" }, "992701")).error, "RECORDING_EVIDENCE_CONFLICT", "method differs from the candidate");
  assert.equal((await runComplete({ executorAccountRef: "acct-test-2" }, "992702")).error, "RECORDING_EVIDENCE_CONFLICT", "account label differs from the candidate");
  // the candidate is the reference: the same earlier 'other' row is consistent with an 'other' candidate
  {
    const { c, op, t } = await claimed();
    await evAt(c, obs(c, "992703", { paymentMethod: "other" }), t + 1);
    assert.deepEqual(await complete(c, op, await evAt(c, obs(c, "992703", { paymentMethod: "other" }), t + 5), "992703"), { ok: true, state: "succeeded" });
  }
  // link: reference = the candidate proof
  {
    const { c, op } = await ownerSucceededUnlinked("992704");
    await evAt(c, obs(c, "992704", { executorAccountRef: "acct-test-2" }), F.at(35));
    assert.equal((await linkRecordingEvidence(db.app, op.id, { evidenceId: await evAt(c, obs(c, "992704"), F.at(40)) })).error, "RECORDING_EVIDENCE_CONFLICT");
    // (that refused candidate is now itself a stored full row with the other label, so this intent stays conflicted either way)
    assert.equal((await linkRecordingEvidence(db.app, op.id, { evidenceId: await evAt(c, obs(c, "992704", { executorAccountRef: "acct-test-2" }), F.at(41)) })).error,
      "RECORDING_EVIDENCE_CONFLICT");
    const { c: cb, op: opb } = await ownerSucceededUnlinked("992707");
    await evAt(cb, obs(cb, "992707", { executorAccountRef: "acct-test-2" }), F.at(35));
    assert.deepEqual(await linkRecordingEvidence(db.app, opb.id, { evidenceId: await evAt(cb, obs(cb, "992707", { executorAccountRef: "acct-test-2" }), F.at(40)) }),
      { ok: true, state: "linked" }, "consistent with a candidate carrying that label (equal labels prove nothing about the credential)");
  }
  // after linking: reference = the linked proof; finalisation (DB check) and the scan flag the same rows
  const { c, op, t } = await claimed();
  F.ok(await complete(c, op, await evAt(c, obs(c, "992705"), t + 5), "992705"));
  const m = await evAt(c, obs(c, "992705", { paymentMethod: "other" }));
  const a = await evAt(c, obs(c, "992705", { executorAccountRef: "acct-test-2" }));
  await evAt(c, obs(c, "992705"));                                                             // identical: not a finding
  await evAt(c, cntOnly(["992705"]));                                                          // count-only same id lacks the fields: not a finding
  const { all } = await scanAll(50);
  assert.deepEqual(all.filter((x) => x.intentId === c.id).map((x) => x.evidenceId).sort(), [m, a].sort());
  const r = await applyEvent(db.app, c.id, { type: "OFFLINE_CHARGE_RECORDED", chargeId: "992705" }, { now: Date.now() });
  assert.deepEqual([r.ok, r.error], [false, "RECORDING_EVIDENCE_CONFLICT"]);
  // and with only the consistent rows, both agree there is nothing
  const { c: c2, op: op2, t: t2 } = await claimed();
  F.ok(await complete(c2, op2, await evAt(c2, obs(c2, "992706"), t2 + 5), "992706"));
  await evAt(c2, obs(c2, "992706")); await evAt(c2, cntOnly(["992706"]));
  assert.equal((await scanAll(50)).all.filter((x) => x.intentId === c2.id).length, 0);
  F.ok(await applyEvent(db.app, c2.id, { type: "OFFLINE_CHARGE_RECORDED", chargeId: "992706" }, { now: Date.now() }));
});

/** a pool whose withTx transactions pause just before COMMIT until released */
function commitGatedPool(pool) {
  let release; const gate = new Promise((r) => { release = r; });
  let reached; const atCommit = new Promise((r) => { reached = r; });
  return { release, atCommit, pool: { connect: async () => {
    const cl = await pool.connect();
    return { query: async (sql, p) => { if (sql === "COMMIT") { reached(); await gate; } return cl.query(sql, p); }, release: (...x) => cl.release(...x) };
  } } };
}

test("completion vs recoverExpiredOperations, order A (completion uncommitted first): maintenance does not wait (SKIP LOCKED, observed: no lock waiter) and skips; completion commits linked; nothing marked unknown", async () => {
  const { c, op } = await claimed({ leaseMs: 10 * MIN });
  const ev = await evAt(c, obs(c, "992801"));
  const v = await version(c);
  const cl = await asAppClient();
  let rec;
  try {
    await cl.query("BEGIN");
    assert.equal((await cl.query("SELECT booking.complete_recording_with_evidence($1,'w1',$2,'992801',$3) AS r", [op.id, ev, v])).rows[0].r, "succeeded");
    const p = recoverExpiredOperations(db.app, { now: Date.now() + 60 * MIN, intentId: c.id }).then((x) => { rec = x; });
    const r = await Promise.race([p.then(() => "returned"), sleep(3000).then(() => "BLOCKED")]);
    assert.equal(r, "returned", "maintenance returned while the completion was still uncommitted");
    assert.deepEqual(rec, [], "the locked row was skipped, not marked outcome_unknown");
    await cl.query("COMMIT");
  } finally { await cl.end(); }
  assert.deepEqual(await recoverExpiredOperations(db.app, { now: Date.now() + 60 * MIN, intentId: c.id }), [], "after commit: succeeded, not in flight");
  const r = await row(op.id);
  assert.deepEqual([r.state, r.settled_evidence_id, r.result_ref], ["succeeded", ev, "992801"]);
  assert.equal(await caseCount(c.id), 0, "no unknown-outcome case");
});

test("completion vs recoverExpiredOperations, order B (maintenance holds the marked row uncommitted): completion WAITS (observed row lock), then refuses on the committed state; no link, no resend, no new attempt", async () => {
  const { c, op } = await claimed({ leaseMs: 10 * MIN });
  const ev = await evAt(c, obs(c, "992802"));
  const v = await version(c);
  const e0 = await effects(c.id);
  const g = commitGatedPool(db.app);
  const mp = recoverExpiredOperations(g.pool, { now: Date.now() + 60 * MIN, intentId: c.id });
  await g.atCommit;                                                                              // marked outcome_unknown, not yet committed
  let res;
  const cp = completeRecordingWithEvidence(db.app, op.id, { workerId: "w1", evidenceId: ev, resultRef: "992802", expectedVersion: v }).then((x) => { res = x; });
  await waitForLockWaiters(1);
  const waits = await waitingLockTypes();
  assert.ok(waits.includes("transactionid") || waits.includes("tuple"), `observed wait: ${waits}`);
  assert.equal(res, undefined, "still waiting");
  g.release();
  assert.deepEqual((await mp).map((x) => x.state), ["outcome_unknown"]);
  await cp;
  assert.deepEqual(res, { ok: false, error: "RECORDING_STATE" });
  const r = await row(op.id);
  assert.deepEqual([r.state, r.settled_evidence_id, r.result_ref], ["outcome_unknown", null, null], "maintenance's truth stands; no partial success");
  assert.equal(await effects(c.id), e0, "no resend, no new attempt");
  assert.equal(await caseCount(c.id), 1, "the owner case maintenance opened (its own documented effect)");
});

test("duplicate concurrent completion: the second WAITS on the first's row lock, then refuses; no repoint, exactly one truth; Promise.all variant: exactly one success", async () => {
  {
    const { c, op } = await claimed();
    const ev = await evAt(c, obs(c, "992901")); const ev2 = await evAt(c, obs(c, "992901"));
    const v = await version(c); const e0 = await effects(c.id);
    const cl = await asAppClient();
    const res = [];
    try {
      await cl.query("BEGIN");
      assert.equal((await cl.query("SELECT booking.complete_recording_with_evidence($1,'w1',$2,'992901',$3) AS r", [op.id, ev, v])).rows[0].r, "succeeded");
      const ps = [ev, ev2].map((e, k) => completeRecordingWithEvidence(db.app, op.id, { workerId: "w1", evidenceId: e, resultRef: "992901", expectedVersion: v }).then((x) => { res[k] = x; }));
      await waitForLockWaiters(2);
      const waits = await waitingLockTypes();
      assert.ok(waits.includes("transactionid") || waits.includes("tuple"), `observed wait: ${waits}`);
      await cl.query("COMMIT");
      await Promise.all(ps);
    } finally { await cl.end(); }
    assert.deepEqual(res, [{ ok: false, error: "RECORDING_STATE" }, { ok: false, error: "RECORDING_STATE" }], "same and different evidence: losing calls are refused, not 'ok'");
    const r = await row(op.id);
    assert.deepEqual([r.state, r.settled_evidence_id], ["succeeded", ev], "no repoint");
    assert.equal(await effects(c.id), e0);
  }
  {
    const { c, op } = await claimed();
    const ev = await evAt(c, obs(c, "992902"));
    const v = await version(c);
    const out = await Promise.all([0, 1, 2].map(() => completeRecordingWithEvidence(db.app, op.id, { workerId: "w1", evidenceId: ev, resultRef: "992902", expectedVersion: v })));
    assert.equal(out.filter((x) => x.ok).length, 1);
    assert.ok(out.filter((x) => !x.ok).every((x) => x.error === "RECORDING_STATE"));
    assert.equal((await row(op.id)).settled_evidence_id, ev);
  }
});

test("duplicate concurrent link: callers WAIT on the first link, then same evidence -> already_linked, different -> RECORDING_ALREADY_LINKED_DIFFERENT; no repoint, no effects", async () => {
  const { c, op } = await ownerSucceededUnlinked("992910");
  const full = await evAt(c, obs(c, "992910"), F.at(40)); const full2 = await evAt(c, obs(c, "992910"), F.at(41));
  const e0 = await effects(c.id); const t0 = await transitions(c.id);
  const cl = await asAppClient();
  const res = [];
  try {
    await cl.query("BEGIN");
    assert.equal((await cl.query("SELECT booking.link_recording_evidence($1,$2) AS r", [op.id, full])).rows[0].r, "linked");
    const ps = [full, full2].map((e, k) => linkRecordingEvidence(db.app, op.id, { evidenceId: e }).then((x) => { res[k] = x; }));
    await waitForLockWaiters(2);
    const waits = await waitingLockTypes();
    assert.ok(waits.includes("transactionid") || waits.includes("tuple"), `observed wait: ${waits}`);
    await cl.query("COMMIT");
    await Promise.all(ps);
  } finally { await cl.end(); }
  assert.deepEqual(res, [{ ok: true, state: "already_linked" }, { ok: false, error: "RECORDING_ALREADY_LINKED_DIFFERENT" }]);
  assert.deepEqual([(await row(op.id)).settled_evidence_id, await effects(c.id), await transitions(c.id)], [full, e0, t0]);
  const out = await Promise.all([full2, full2].map((e) => linkRecordingEvidence(db.app, op.id, { evidenceId: e })));
  assert.ok(out.every((x) => x.error === "RECORDING_ALREADY_LINKED_DIFFERENT"));
});
