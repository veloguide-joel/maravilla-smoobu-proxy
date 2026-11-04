// Stage E7 guest notification — STAGE 1 unit checks of the narrow operations.js changes (no database): the two-stage NOTIFY_FENCE in
// claimNextOperation, the guest.notify markUnknown branch (D1 = A) and the generic success refusal. A recording fake pool stands in for
// PostgreSQL; it returns only synthetic rows. Contract: claude/e7-guest-notification-contract.md revision 3 (§6.1, §6.5 i–ii).
import { test } from "node:test";
import assert from "node:assert/strict";
import { claimNextOperation, completeOperation, recoverExpiredOperations } from "../lib/booking-db/operations.js";

/** fake pool: `responder(sql, params)` returns { rows, rowCount } or throws; every statement is recorded */
function fakePool(responder) {
  const log = [];
  const q = async (sql, params = []) => { log.push({ sql, params }); const r = await responder(sql, params, log); return { rows: [], rowCount: 0, ...(r || {}) }; };
  return { log, query: q, connect: async () => ({ query: q, release: () => {} }) };
}
const OP = "5a1f0e3e-0000-4000-8000-000000000001";
const INTENT = "5a1f0e3e-0000-4000-8000-0000000000aa";
const notifyRow = (o = {}) => ({ id: OP, intent_id: INTENT, op_type: "guest.notify", retry_class: "idempotent", state: "in_flight", attempts: 1, max_attempts: 5,
  lease_worker_id: "w1", lease_until: new Date(Date.now() + 60000), payload: { template: "booking_confirmed" }, ...o });

test("claimNextOperation: NOTIFY_FENCE is applied in BOTH the unlocked candidate stage and the locked claim stage", async () => {
  const pool = fakePool(() => ({ rows: [] }));
  assert.equal(await claimNextOperation(pool, { workerId: "w", now: Date.now(), opTypes: ["guest.notify"] }), null);
  const cand = pool.log.find((x) => /SELECT o\.id, o\.intent_id, o\.op_type FROM booking\.external_operations o/.test(x.sql));
  assert.ok(cand && cand.sql.includes("(o.op_type <> 'guest.notify')"), "candidate stage fenced");
  // force the locked stage: a candidate is returned (as if the unlocked read raced), the locked UPDATE must carry the fence too
  let n = 0;
  const pool2 = fakePool((sql) => {
    if (/SELECT o\.id, o\.intent_id, o\.op_type FROM booking\.external_operations o/.test(sql)) return n++ === 0 ? { rows: [{ id: OP, intent_id: INTENT, op_type: "guest.notify" }] } : { rows: [] };
    return { rows: [] };
  });
  assert.equal(await claimNextOperation(pool2, { workerId: "w", now: Date.now(), opId: OP }), null);
  const locked = pool2.log.find((x) => /UPDATE booking\.external_operations o\s+SET state = 'in_flight'/.test(x.sql));
  assert.ok(locked && locked.sql.includes("(o.op_type <> 'guest.notify')"), "locked stage fenced");
});

test("completeOperation(succeeded) on guest.notify: refused from the immutable op_type BEFORE any transaction (dedicated completion only)", async () => {
  const pool = fakePool((sql) => (/SELECT op_type FROM booking\.external_operations WHERE id = \$1$/.test(sql) ? { rows: [{ op_type: "guest.notify" }] } : { rows: [] }));
  assert.deepEqual(await completeOperation(pool, OP, { workerId: "w1", now: Date.now(), outcome: { status: "succeeded", resultRef: "mock-1" } }),
    { ok: false, error: "NOTIFY_SUCCESS_REQUIRES_DEDICATED_COMPLETION" });
  assert.equal(pool.log.length, 1, "one read, no BEGIN / UPDATE");
});

test("markUnknown guest.notify branch (D1 = A): completion as unknown → outcome_unknown + NOTIFICATION_OUTCOME_UNKNOWN case; never pending / requires_provider_read", async () => {
  const pool = fakePool((sql) => (/FOR UPDATE$/.test(sql.trim()) ? { rows: [notifyRow()] } : { rows: [], rowCount: 1 }));
  assert.deepEqual(await completeOperation(pool, OP, { workerId: "w1", now: Date.now(), outcome: { status: "outcome_unknown", errorCode: "SEND_TIMEOUT" } }),
    { ok: true, state: "outcome_unknown" });
  const upd = pool.log.find((x) => /^UPDATE booking\.external_operations SET state = /.test(x.sql));
  assert.match(upd.sql, /state = 'outcome_unknown'/);
  assert.doesNotMatch(upd.sql, /pending|requires_provider_read|next_attempt_at/);
  const cs = pool.log.find((x) => /INSERT INTO booking\.reconciliation_cases/.test(x.sql));
  assert.equal(cs.params[2], "NOTIFICATION_OUTCOME_UNKNOWN");
  assert.equal(cs.params[4], `op:${OP}`);
  assert.deepEqual(cs.params[5], { operationId: OP, opType: "guest.notify", errorCode: "SEND_TIMEOUT" });
  // independent of attempts / max_attempts (even attempts < max: never re-queued)
  const pool2 = fakePool((sql) => (/^SELECT o\.\* FROM booking\.external_operations o/.test(sql.trim()) ? { rows: [notifyRow({ attempts: 1, max_attempts: 5 })] } : { rows: [], rowCount: 1 }));
  assert.deepEqual((await recoverExpiredOperations(pool2, { now: Date.now(), opTypes: ["guest.notify"] })).map((x) => x.state), ["outcome_unknown"]);
  assert.ok(!pool2.log.some((x) => /state = 'pending'/.test(x.sql)));
});

test("other op types keep their generic behaviour (idempotent alert.owner still re-queues; recording success guard unchanged)", async () => {
  const pool = fakePool((sql) => (/FOR UPDATE$/.test(sql.trim()) ? { rows: [notifyRow({ op_type: "alert.owner" })] } : { rows: [], rowCount: 1 }));
  assert.deepEqual(await completeOperation(pool, OP, { workerId: "w1", now: Date.now(), outcome: { status: "outcome_unknown", errorCode: "X" } }), { ok: true, state: "pending" });
  const pool2 = fakePool((sql) => (/SELECT op_type FROM/.test(sql) ? { rows: [{ op_type: "hostaway.record_offline_charge" }] } : { rows: [] }));
  assert.equal((await completeOperation(pool2, OP, { workerId: "w1", now: Date.now(), outcome: { status: "succeeded" } })).error, "RECORDING_SUCCESS_REQUIRES_EVIDENCE");
});

test("an outer database error propagates as the IDENTICAL object, with no further query", async () => {
  const boom = Object.assign(new Error("synthetic outer failure"), { code: "57P01" });
  for (const call of [
    (p) => completeOperation(p, OP, { workerId: "w1", now: Date.now(), outcome: { status: "succeeded", resultRef: "mock-1" } }),
    (p) => claimNextOperation(p, { workerId: "w", now: Date.now(), opTypes: ["guest.notify"] })]) {
    let count = 0;
    const pool = fakePool(() => { count += 1; if (count >= 1) throw boom; });
    const pool2 = { ...pool, connect: async () => ({ query: async (sql) => { count += 1; if (/^BEGIN$|^ROLLBACK$/.test(sql)) return { rows: [] }; throw boom; }, release: () => {} }) };
    let got;
    try { await call(pool2); } catch (e) { got = e; }
    assert.equal(got, boom, "identical object");
    assert.ok(count <= 3, "no follow-up query beyond BEGIN / the failing statement / ROLLBACK");
  }
});
