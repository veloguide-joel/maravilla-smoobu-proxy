// db/lib/operations.js — Stage E2B. Transactional outbox: claim, complete, recover.
//
// EXTERNAL DISPATCH IS DISABLED in this stage: dispatchOperation() refuses unless the caller injects an executor
// (only tests do, with mocked provider results). No Stripe or Hostaway client exists in this module.
//
// Retry classes (enforced in SQL by booking.external_operations_guard and CHECK constraints):
//   read            -> safe to repeat
//   idempotent      -> repeat with the SAME provider idempotency key, after reading provider state first
//   non_idempotent  -> attempted at most once; an ambiguous result becomes outcome_unknown + a reconciliation case,
//                      never an automatic retry (Hostaway create; Hostaway payment recording)
import { randomUUID } from "node:crypto";
import { DB_CONFIG } from "./config.js";
import { withTx } from "./repo.js";

export const EXTERNAL_DISPATCH_ENABLED = false;

const UNKNOWN_CASE_KIND = Object.freeze({
  "hostaway.create_reservation": "HOSTAWAY_CREATE_OUTCOME_UNKNOWN",
  "hostaway.record_offline_charge": "OFFLINE_CHARGE_OUTCOME_UNKNOWN"
});

async function openCase(c, intentId, kind, openedBy, evidence, now) {
  await c.query(
    `INSERT INTO booking.reconciliation_cases (id, intent_id, kind, status, opened_at, opened_by, evidence)
     VALUES ($1,$2,$3,'open',$4,$5,$6) ON CONFLICT (intent_id, kind) WHERE status = 'open' DO NOTHING`,
    [randomUUID(), intentId, kind, new Date(now), openedBy, evidence]);
}

/**
 * Claim the next due operation for this worker (one short transaction; the row lock lasts one statement).
 * A Hostaway create is only claimable while its intent is reservation_pending with a dispatch record and a live
 * lease; otherwise it is superseded and can never be sent.
 */
export async function claimNextOperation(pool, { workerId, now, leaseMs = DB_CONFIG.operationLeaseMs, opTypes = null, intentId = null, hooks = {} }) {
  const t = new Date(now);
  return withTx(pool, async (c) => {
    await c.query(
      `UPDATE booking.external_operations o SET state = 'superseded', updated_at = $1
         FROM booking.intents i
        WHERE i.id = o.intent_id AND o.op_type = 'hostaway.create_reservation' AND o.state = 'pending'
          AND NOT (i.state = 'reservation_pending' AND i.dispatch_at IS NOT NULL AND i.lease_until >= $1)`, [t]);
    const r = await c.query(
      `WITH c AS (
         SELECT o.id FROM booking.external_operations o
          WHERE o.state = 'pending' AND o.next_attempt_at <= $2
            AND ($4::text[] IS NULL OR o.op_type = ANY($4)) AND ($5::uuid IS NULL OR o.intent_id = $5)
          ORDER BY o.next_attempt_at, o.created_at FOR UPDATE OF o SKIP LOCKED LIMIT 1)
       UPDATE booking.external_operations o
          SET state = 'in_flight', lease_worker_id = $1, lease_until = $3, attempts = o.attempts + 1, dispatched_at = $2, updated_at = $2
         FROM c WHERE o.id = c.id RETURNING o.*`,
      [workerId, t, new Date(now + leaseMs), opTypes, intentId]);
    const op = r.rows[0] || null;
    if (op && op.op_type === "hostaway.create_reservation") {
      await c.query("UPDATE booking.hostaway_reservation_attempts SET send_started_at = $2, updated_at = $2 WHERE operation_id = $1", [op.id, t]);
    }
    if (hooks.beforeCommit) await hooks.beforeCommit(op);
    return op;
  });
}

/**
 * Record a provider result for an in-flight operation held by this worker.
 * outcome: { status: 'succeeded' | 'failed_definite' | 'outcome_unknown', resultRef?, errorCode? }
 * If the lease was lost (expired / recovered), the result is kept as late evidence on ambiguous rows and
 * { ok:false, error:'LEASE_LOST' } is returned — the caller must not apply an E3 event.
 */
export async function completeOperation(pool, opId, { workerId, now, outcome, cfg = DB_CONFIG }) {
  const t = new Date(now);
  return withTx(pool, async (c) => {
    const op = (await c.query("SELECT * FROM booking.external_operations WHERE id = $1 FOR UPDATE", [opId])).rows[0];
    if (!op) return { ok: false, error: "NOT_FOUND" };
    if (op.state !== "in_flight" || op.lease_worker_id !== workerId || t > op.lease_until) {
      let lateEvidenceRecorded = false;
      if (["outcome_unknown", "escalated"].includes(op.state) && outcome && outcome.status) {
        await c.query("UPDATE booking.external_operations SET late_result_status = $2, late_result_ref = $3, updated_at = $4 WHERE id = $1",
          [opId, outcome.status, outcome.resultRef != null ? String(outcome.resultRef) : null, t]);
        lateEvidenceRecorded = true;
      }
      return { ok: false, error: "LEASE_LOST", state: op.state, lateEvidenceRecorded };
    }
    const common = [opId, t, outcome.resultRef != null ? String(outcome.resultRef) : null, outcome.errorCode ?? null];
    if (outcome.status === "succeeded" || outcome.status === "failed_definite") {
      await c.query(`UPDATE booking.external_operations SET state = $5, result_ref = $3, error_code = $4, completed_at = $2,
                     lease_worker_id = NULL, lease_until = NULL, updated_at = $2 WHERE id = $1`, [...common, outcome.status]);
      return { ok: true, state: outcome.status };
    }
    if (outcome.status !== "outcome_unknown") throw new TypeError("outcome.status");
    return { ok: true, state: await markUnknown(c, op, now, outcome.errorCode || "OUTCOME_UNKNOWN", cfg) };
  });
}

async function markUnknown(c, op, now, errorCode, cfg) {
  const t = new Date(now);
  if (op.retry_class === "non_idempotent") {
    await c.query(`UPDATE booking.external_operations SET state = 'outcome_unknown', error_code = $3, lease_worker_id = NULL, lease_until = NULL,
                   updated_at = $2 WHERE id = $1`, [op.id, t, errorCode]);
    await openCase(c, op.intent_id, UNKNOWN_CASE_KIND[op.op_type] || "OPERATION_OUTCOME_UNKNOWN", `op:${op.id}`,
      { operationId: op.id, opType: op.op_type, errorCode }, now);
    return "outcome_unknown";
  }
  if (op.attempts >= op.max_attempts) {
    await c.query(`UPDATE booking.external_operations SET state = 'escalated', error_code = $3, lease_worker_id = NULL, lease_until = NULL,
                   updated_at = $2 WHERE id = $1`, [op.id, t, errorCode]);
    await openCase(c, op.intent_id, "OPERATION_RETRIES_EXHAUSTED", `op:${op.id}`, { operationId: op.id, opType: op.op_type, errorCode }, now);
    return "escalated";
  }
  await c.query(`UPDATE booking.external_operations SET state = 'pending', error_code = $3, lease_worker_id = NULL, lease_until = NULL,
                 requires_provider_read = $4, next_attempt_at = $5, updated_at = $2 WHERE id = $1`,
    [op.id, t, errorCode, op.retry_class === "idempotent", new Date(now + cfg.retryBackoffMs[op.retry_class])]);
  return "pending";
}

/** Crash recovery for operations whose worker lease expired while in flight. */
export async function recoverExpiredOperations(pool, { now, cfg = DB_CONFIG, limit = 50 }) {
  return withTx(pool, async (c) => {
    const r = await c.query(`SELECT * FROM booking.external_operations WHERE state = 'in_flight' AND lease_until < $1
                             ORDER BY lease_until FOR UPDATE SKIP LOCKED LIMIT $2`, [new Date(now), limit]);
    const out = [];
    for (const op of r.rows) out.push({ id: op.id, opType: op.op_type, state: await markUnknown(c, op, now, "LEASE_EXPIRED", cfg) });
    return out;
  });
}

/**
 * Owner/admin resolution of an ambiguous or escalated operation, WITH evidence gathered outside the system.
 * resolution: 'succeeded' (e.g. the Hostaway payment record exists, resultRef = its id) or 'failed_definite'
 * (verified absent). Closes the matching reconciliation case. The caller then applies the matching E3 event.
 */
export async function resolveOperation(pool, opId, { now, resolution, resultRef = null, resolvedBy }) {
  if (!["succeeded", "failed_definite"].includes(resolution)) throw new TypeError("resolution");
  if (typeof resolvedBy !== "string" || !resolvedBy) throw new TypeError("resolvedBy required");
  const t = new Date(now);
  return withTx(pool, async (c) => {
    const op = (await c.query("SELECT * FROM booking.external_operations WHERE id = $1 FOR UPDATE", [opId])).rows[0];
    if (!op || !["outcome_unknown", "escalated"].includes(op.state)) return { ok: false, error: "NOT_RESOLVABLE" };
    await c.query(`UPDATE booking.external_operations SET state = $2, result_ref = $3, completed_at = $4, updated_at = $4 WHERE id = $1`,
      [opId, resolution, resultRef != null ? String(resultRef) : null, t]);
    await c.query(`UPDATE booking.reconciliation_cases SET status = 'resolved', resolution = $3, resolved_by = $4, resolved_at = $5
                   WHERE intent_id = $1 AND opened_by = $2 AND status = 'open'`,
      [op.intent_id, `op:${opId}`, resolution === "succeeded" ? "recorded" : "no_action", resolvedBy.slice(0, 200), t]);
    return { ok: true };
  });
}

/** Execute one claimed operation through an INJECTED executor. With no executor, nothing is ever sent. */
export async function dispatchOperation(op, { executors = {} } = {}) {
  const fn = executors[op.op_type];
  if (typeof fn !== "function") {
    const e = new Error("DISPATCH_DISABLED");
    e.code = "DISPATCH_DISABLED";
    throw e;
  }
  return fn(op);
}
