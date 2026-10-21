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
//   reconcile_first -> attempted at most once per row; an ambiguous result becomes outcome_unknown and is settled only
//                      from evidence (E3.2: capture / void / cancel; E2B.2: Stripe Checkout Session create)
//
// Notification operations (guest.notify / alert.owner) stay "idempotent": a retry after an ambiguous send can deliver
// a DUPLICATE message (e-mail/SMS providers have no shared idempotency here). Accepted for E2B; revisit with E8.
import { randomUUID } from "node:crypto";
import { DB_CONFIG } from "./config.js";
import { withTx, dbSafetyCode } from "./repo.js";

export const EXTERNAL_DISPATCH_ENABLED = false;

const UNKNOWN_CASE_KIND = Object.freeze({
  "hostaway.create_reservation": "HOSTAWAY_CREATE_OUTCOME_UNKNOWN",
  "hostaway.record_offline_charge": "OFFLINE_CHARGE_OUTCOME_UNKNOWN",
  "stripe.create_checkout_session": "CHECKOUT_CREATE_OUTCOME_UNKNOWN"
});
const CHECKOUT_CREATE = "stripe.create_checkout_session";

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
export async function completeOperation(pool, opId, opts) {
  try { return await completeOperationOnce(pool, opId, opts); }
  catch (e) { const code = dbSafetyCode(e); if (code) return { ok: false, error: code }; throw e; }
}

async function completeOperationOnce(pool, opId, { workerId, now, outcome, cfg = DB_CONFIG }) {
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
      if (op.op_type === CHECKOUT_CREATE && outcome.status === "failed_definite") {
        // an explicit Stripe refusal of the create: no session exists for this attempt
        await c.query("UPDATE booking.payment_attempts SET status = 'not_created', updated_at = $2 WHERE id = $1::uuid AND status = 'creating'",
          [op.payload.paymentAttemptId, t]);
      }
      return { ok: true, state: outcome.status };
    }
    if (outcome.status !== "outcome_unknown") throw new TypeError("outcome.status");
    return { ok: true, state: await markUnknown(c, op, now, outcome.errorCode || "OUTCOME_UNKNOWN", cfg) };
  });
}

async function markUnknown(c, op, now, errorCode, cfg) {
  const t = new Date(now);
  if (op.retry_class === "reconcile_first") {
    // E3.2: capture / void / cancel — never re-queued. E3 is told the outcome is unknown and reads the provider;
    // the row is settled only by settle_operation_from_evidence() (or an owner resolution).
    await c.query(`UPDATE booking.external_operations SET state = 'outcome_unknown', error_code = $3, lease_worker_id = NULL, lease_until = NULL,
                   updated_at = $2 WHERE id = $1`, [op.id, t, errorCode]);
    if (op.op_type === CHECKOUT_CREATE) {
      // E2B.2 (B): a Checkout Session may or may not exist. The attempt waits on reconciliation (no second create is
      // ever requested for it) and the owner is told: with no session id, only a manual check can settle it until E5.
      await c.query("UPDATE booking.payment_attempts SET status = 'outcome_unknown', updated_at = $2 WHERE id = $1::uuid AND status = 'creating'",
        [op.payload.paymentAttemptId, t]);
      await openCase(c, op.intent_id, UNKNOWN_CASE_KIND[op.op_type], `op:${op.id}`,
        { operationId: op.id, opType: op.op_type, errorCode, paymentAttemptId: op.payload.paymentAttemptId }, now);
    }
    return "outcome_unknown";
  }
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

// Owner resolution of uncertain operations is NOT available to the runtime role (E2B.1, C1/C7):
// see db/lib/admin.js -> booking.admin_resolve_operation(), granted to mv_booking_admin only.

const READ_TYPES = Object.freeze({
  "stripe.retrieve_checkout_session": "sessionId",
  "stripe.retrieve_payment_intent": "paymentIntentId",
  "hostaway.retrieve_reservation": "reservationId",
  "hostaway.list_offline_charges": "reservationId",
  "hostaway.lookup_reservation": "ref"
});

/** Queue a provider READ (no side effects at the provider). Its result can then be recorded as evidence. */
export async function requestRead(pool, intentId, opType, ref, { now }) {
  const field = READ_TYPES[opType];
  if (!field) throw new TypeError(`not a read operation: ${opType}`);
  if (typeof ref !== "string" || !ref) throw new TypeError("ref required");
  const v = (await pool.query("SELECT version FROM booking.intents WHERE id = $1", [intentId])).rows[0];
  if (!v) throw new Error("NOT_FOUND");
  const id = randomUUID();
  await pool.query(
    `INSERT INTO booking.external_operations (id, intent_id, op_type, idempotency_key, retry_class, state, payload, source_version,
       max_attempts, next_attempt_at, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'read','pending',$5,$6,$7,$8,$8,$8)`,
    [id, intentId, opType, `read:${opType}:${id}`, { [field]: ref }, v.version, DB_CONFIG.maxAttempts.read, new Date(now)]);
  return id;
}

/**
 * Record what a SUCCEEDED read operation observed (Stripe/Hostaway API). The database binds the evidence to that
 * read (type, identifier, completion time, recording role). TRUST BOUNDARY: the database cannot verify that the
 * observed values are what the provider actually returned; only verified provider reads may be recorded here.
 */
export async function recordProviderEvidence(pool, { readOpId, kind, externalRef, status, observed, providerRequestId = null }) {
  try {
    const r = await pool.query("SELECT booking.record_provider_evidence($1, $2, $3, $4, $5, $6) AS id",
      [readOpId, kind, externalRef, status, observed, providerRequestId]);
    return { ok: true, id: r.rows[0].id };
  } catch (e) {
    const m = /^([A-Z_]+)/.exec(e.message || "");
    if (e.code === "23514" && m) return { ok: false, error: m[1] };
    if (e.code === "23505" && /read_operation_id/.test(e.constraint || "")) return { ok: false, error: "EVIDENCE_ALREADY_RECORDED" };
    throw e;
  }
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

// ---------------------------------------------------------------------------------------------
// E3.2: reconcile-first provider writes (capture / void / cancel)

/**
 * Settle an ambiguous capture/void/cancel — or Checkout Session create (E2B.2) — from persisted API evidence (a verified
 * provider read). A create is settled only as "applied", from a read of a KNOWN session bound to its payment attempt.
 */
export async function settleOperationFromEvidence(pool, opId, evidenceId) {
  try {
    const r = await pool.query("SELECT booking.settle_operation_from_evidence($1, $2) AS state", [opId, evidenceId]);
    return { ok: true, state: r.rows[0].state };
  } catch (e) {
    const m = /^([A-Z_]+)/.exec(e.message || "");
    if (e.code === "23514" && m) return { ok: false, error: m[1] };
    throw e;
  }
}

const UNKNOWN_EVENT_FOR = Object.freeze({
  "stripe.capture_payment_intent": "CAPTURE_OUTCOME_UNKNOWN",
  "stripe.void_payment_intent": "VOID_OUTCOME_UNKNOWN",
  "hostaway.cancel_reservation": "RESERVATION_CANCEL_OUTCOME_UNKNOWN"
});

/**
 * After a worker interruption, tell E3 that a reconcile-first write has an unknown outcome so that E3 schedules the
 * authoritative read (and never a blind re-send). Idempotent per operation.
 */
export async function reportUnknownOutcome(pool, opId, { now, config }) {
  const { applyEvent } = await import("./repo.js");
  const op = (await pool.query("SELECT * FROM booking.external_operations WHERE id = $1", [opId])).rows[0];
  if (!op || op.state !== "outcome_unknown" || !UNKNOWN_EVENT_FOR[op.op_type]) return { ok: false, error: "NOT_APPLICABLE" };
  return applyEvent(pool, op.intent_id, { type: UNKNOWN_EVENT_FOR[op.op_type], id: `op-unknown:${op.id}`, code: op.error_code || "OUTCOME_UNKNOWN" },
    { now, config, actor: "reconciler" });
}
