// Stage E2B — REGRESSION: ambiguous Hostaway accounting update (offline charge recording).
// E2A §5.4: E3's OFFLINE_CHARGE_FAILED retries up to 10 times, but Hostaway's offline-charge create has no
// idempotency key. A timeout followed by an automatic retry could record the same payment twice in Hostaway's books.
// Required: an ambiguous recording is NEVER retried automatically; it is marked for reconciliation.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { startMigratedDatabase } from "./harness.mjs";
import * as F from "./fixtures.mjs";
import { applyEvent, loadIntent } from "../../db/lib/repo.js";
import { claimNextOperation, completeOperation, recoverExpiredOperations, resolveOperation } from "../../db/lib/operations.js";
import { isConfirmedPaid } from "../../lib/checkout/intent-state.js";

let db;
before(async () => { db = await startMigratedDatabase(); });
after(async () => { await db.close(); });
const ochOps = async (id) => (await db.app.query("SELECT * FROM booking.external_operations WHERE intent_id = $1 AND op_type = 'hostaway.record_offline_charge' ORDER BY source_version", [id])).rows;
const OCH = ["hostaway.record_offline_charge"];

test("timeout while recording the payment in Hostaway -> outcome_unknown + case; no retry; booking stays valid", async () => {
  const c = await F.captured(db.app, { listingId: 750001 });
  const op = await claimNextOperation(db.app, { workerId: "w1", now: F.at(9), intentId: c.id, opTypes: OCH });
  F.ok(await completeOperation(db.app, op.id, { workerId: "w1", now: F.at(9.2), outcome: { status: "outcome_unknown", errorCode: "TIMEOUT" } }));
  assert.equal((await ochOps(c.id))[0].state, "outcome_unknown");
  assert.equal(await F.count(db.app, "SELECT count(*) AS n FROM booking.reconciliation_cases WHERE intent_id = $1 AND kind = 'OFFLINE_CHARGE_OUTCOME_UNKNOWN' AND status = 'open'", [c.id]), 1);

  // the E3 retry path is refused while the outcome is unresolved
  const retry = await applyEvent(db.app, c.id, { type: "OFFLINE_CHARGE_FAILED" }, { now: F.at(10) });
  assert.equal(retry.error, "OFFLINE_CHARGE_OUTCOME_UNRESOLVED");
  assert.equal((await ochOps(c.id)).length, 1, "no second recording operation");
  assert.equal(await claimNextOperation(db.app, { workerId: "w2", now: F.at(1000), intentId: c.id, opTypes: OCH }), null, "nothing claimable, ever");

  // the guest's booking is unaffected: reserved and paid
  const i = await loadIntent(db.app, c.id);
  assert.equal(i.status, "payment_captured");
  assert.equal(isConfirmedPaid(i), true);
});

test("database backstops: no second open recording per intent, no re-queue of an ambiguous one, single attempt", async () => {
  const c = await F.captured(db.app, { listingId: 750002 });
  const op = await claimNextOperation(db.app, { workerId: "w1", now: F.at(9), intentId: c.id, opTypes: OCH });
  F.ok(await completeOperation(db.app, op.id, { workerId: "w1", now: F.at(9.2), outcome: { status: "outcome_unknown" } }));
  // bypassing the code: insert a second recording op directly
  await assert.rejects(db.app.query(`INSERT INTO booking.external_operations (id, intent_id, op_type, idempotency_key, retry_class, state, source_version, max_attempts, next_attempt_at, created_at, updated_at)
    VALUES ($1, $2, 'hostaway.record_offline_charge', $3, 'non_idempotent', 'pending', 99, 1, now(), now(), now())`, [randomUUID(), c.id, `och:${c.id}:bypass`]), /one_open_offline_charge/);
  // bypassing the code: put the ambiguous op back in the queue
  await assert.rejects(db.app.query("UPDATE booking.external_operations SET state = 'pending' WHERE id = $1", [op.id]), /not allowed/);
  // bypassing the code: allow more attempts
  await assert.rejects(db.app.query("UPDATE booking.external_operations SET max_attempts = 3 WHERE id = $1", [op.id]), /immutable|check constraint/);
});

test("worker crash mid-recording (lease expiry) is treated exactly like a timeout", async () => {
  const c = await F.captured(db.app, { listingId: 750003 });
  const op = await claimNextOperation(db.app, { workerId: "w1", now: F.at(9), intentId: c.id, opTypes: OCH, leaseMs: 60000 });
  const rec = await recoverExpiredOperations(db.app, { now: F.at(11) });
  assert.equal(rec.find((x) => x.id === op.id).state, "outcome_unknown");
  assert.equal((await applyEvent(db.app, c.id, { type: "OFFLINE_CHARGE_FAILED" }, { now: F.at(12) })).error, "OFFLINE_CHARGE_OUTCOME_UNRESOLVED");
  assert.equal((await ochOps(c.id)).length, 1);
});

test("owner resolution A — the charge WAS recorded (found in Hostaway): mark succeeded, confirm, ledger once", async () => {
  const c = await F.captured(db.app, { listingId: 750004 });
  const op = await claimNextOperation(db.app, { workerId: "w1", now: F.at(9), intentId: c.id, opTypes: OCH });
  F.ok(await completeOperation(db.app, op.id, { workerId: "w1", now: F.at(9.2), outcome: { status: "outcome_unknown" } }));
  F.ok(await resolveOperation(db.app, op.id, { now: F.at(60), resolution: "succeeded", resultRef: 880001, resolvedBy: "owner" }));
  F.ok(await applyEvent(db.app, c.id, { type: "OFFLINE_CHARGE_RECORDED", chargeId: 880001 }, { now: F.at(60), actor: "admin" }));
  assert.equal(await F.state(db.app, c.id), "confirmed");
  assert.equal(await F.count(db.app, "SELECT count(*) AS n FROM booking.payment_ledger WHERE intent_id = $1 AND entry = 'offline_charge_recorded'", [c.id]), 1);
  assert.equal((await ochOps(c.id)).length, 1, "recorded exactly once by this system");
  assert.equal(await F.count(db.app, "SELECT count(*) AS n FROM booking.reconciliation_cases WHERE intent_id = $1 AND status = 'open'", [c.id]), 0);
});

test("owner resolution B — verified NOT recorded: only then may E3 schedule a new recording", async () => {
  const c = await F.captured(db.app, { listingId: 750005 });
  const op = await claimNextOperation(db.app, { workerId: "w1", now: F.at(9), intentId: c.id, opTypes: OCH });
  F.ok(await completeOperation(db.app, op.id, { workerId: "w1", now: F.at(9.2), outcome: { status: "outcome_unknown" } }));
  F.ok(await resolveOperation(db.app, op.id, { now: F.at(60), resolution: "failed_definite", resolvedBy: "owner" }));
  const r = F.ok(await applyEvent(db.app, c.id, { type: "OFFLINE_CHARGE_FAILED" }, { now: F.at(61) }));
  assert.equal(r.intent.status, "payment_captured");
  const ops = await ochOps(c.id);
  assert.deepEqual(ops.map((o) => o.state), ["failed_definite", "pending"]);
  assert.deepEqual(ops.map((o) => o.idempotency_key.split(":").pop()), ["1", "2"]);
});

test("definite failure (e.g. catalogued 4xx) follows E3's bounded retry; each retry is a NEW single-attempt operation", async () => {
  const c = await F.captured(db.app, { listingId: 750006 });
  for (let n = 1; n <= 3; n++) {
    const op = await claimNextOperation(db.app, { workerId: "w1", now: F.at(9 + n), intentId: c.id, opTypes: OCH });
    assert.ok(op, `attempt ${n}`);
    F.ok(await completeOperation(db.app, op.id, { workerId: "w1", now: F.at(9 + n), outcome: { status: "failed_definite", errorCode: "VALIDATION_ERROR" } }));
    F.ok(await applyEvent(db.app, c.id, { type: "OFFLINE_CHARGE_FAILED" }, { now: F.at(9 + n) }));
  }
  const ops = await ochOps(c.id);
  assert.equal(ops.length, 4);
  assert.ok(ops.every((o) => o.max_attempts === 1 && o.attempts <= 1));
  assert.equal(ops.filter((o) => ["pending", "in_flight", "outcome_unknown", "escalated"].includes(o.state)).length, 1);
});
