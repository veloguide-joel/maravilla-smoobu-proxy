// lib/booking-db/recovery.js — Stage E7.1 (offline). Durable-evidence recovery foundation. NO provider calls.
//
// Not imported by any route. There is no executor, no dispatch runner, no cron and no API wiring here: these functions
// only READ persisted facts, queue provider READ operations (bounded, deduplicated) and apply E3 events that the pure
// planner (lib/checkout/recovery-plan.js) derived from persisted facts + fresh verified evidence.
//
//   findMissedOutcomes      bounded, read-only: completed provider WRITES whose outcome the intent still awaits
//   loadRecoveryFacts       read-only: the facts the planner needs for one operation
//   requestRecoveryRead     a planner "needs_fresh_read": at most MAX_RECOVERY_READS per (operation, read, ref); never
//                           while the same read is still open
//   findOrphanReads         bounded, read-only: SUCCEEDED reads whose evidence was never recorded (crash gap, errata E4)
//   reissueOrphanRead       one NEW read for an orphan (the lost values are never reconstructed); deduplicated, bounded
//   applyRecoveryPlan       settles an outcome_unknown row from the cited evidence (database decides), then applies the
//                           planned event only if the intent version and the operation row are still what was planned
//
// Never: a re-queue, re-claim or re-creation of an already-claimed write; a provider write of any kind; a refund path.
import { randomUUID } from "node:crypto";
import { applyEvent, loadIntentRow, withTx, RepoError } from "./repo.js";
import { rowToIntent } from "./codec.js";
import { settleOperationFromEvidence } from "./operations.js";
import { DB_CONFIG } from "./config.js";
import { WRITE_OP_TYPES, RECOVERY_EVENT_ID } from "../checkout/recovery-plan.js";

export const RECOVERY_MAX_BATCH = 100;
export const RECOVERY_DEFAULT_GRACE_MS = 2 * 60 * 1000;   // never race a live worker that is about to apply its own result
export const MAX_RECOVERY_READS = 3;                       // per (operation, read type, ref); then the planner must escalate
export const MAX_REISSUE_DEPTH = 3;                        // a reissued read that is itself orphaned, at most this deep

const READ_FIELD = Object.freeze({
  "stripe.retrieve_checkout_session": "sessionId",
  "stripe.retrieve_payment_intent": "paymentIntentId",
  "hostaway.retrieve_reservation": "reservationId",
  "hostaway.list_offline_charges": "reservationId",
  "hostaway.lookup_reservation": "ref"
});
const TERMINAL_OR_ESCALATED = ["confirmed", "validation_failed", "expired", "payment_failed", "payment_expired", "authorization_released",
  "cancelled", "reconciliation_required"];

const bound = (limit) => Math.max(1, Math.min(RECOVERY_MAX_BATCH, Number.isInteger(limit) ? limit : RECOVERY_MAX_BATCH));
const ms = (d) => (d == null ? null : new Date(d).getTime());

/**
 * The intent still AWAITS this operation's outcome (precise definition of "not yet handled", together with the
 * op-outcome:{opId} applied-event check). Mirrors the planner's NOT_AWAITING rules.
 *   create          reservation_pending (with dispatch) | reservation_unknown
 *   capture         reservation_confirmed | capture_unknown, and the row is the CURRENT attempt
 *   void            reservation_failed | capture_failed with the authorization leg open, and the row is the latest void
 *   cancel          capture_failed with the reservation leg open, and the row is the latest cancel
 *   offline charge  payment_captured, the row is the latest recording, and no owner case is open for an unknown result
 */
const AWAITING = `(
  (o.op_type = 'hostaway.create_reservation' AND ((i.state = 'reservation_pending' AND i.dispatch_at IS NOT NULL) OR i.state = 'reservation_unknown'))
  OR (o.op_type = 'stripe.capture_payment_intent' AND i.state IN ('reservation_confirmed', 'capture_unknown')
      AND (o.payload ->> 'attempt') = i.capture_attempts::text)
  OR (o.op_type = 'stripe.void_payment_intent'
      AND (i.state = 'reservation_failed' OR (i.state = 'capture_failed' AND i.settlement_authorization_settled IS NOT TRUE))
      AND NOT EXISTS (SELECT 1 FROM booking.external_operations n WHERE n.intent_id = o.intent_id AND n.op_type = o.op_type
                       AND (n.source_version, n.created_at, n.id) > (o.source_version, o.created_at, o.id)))
  OR (o.op_type = 'hostaway.cancel_reservation' AND i.state = 'capture_failed' AND i.settlement_reservation_cancelled IS NOT TRUE
      AND NOT EXISTS (SELECT 1 FROM booking.external_operations n WHERE n.intent_id = o.intent_id AND n.op_type = o.op_type
                       AND (n.source_version, n.created_at, n.id) > (o.source_version, o.created_at, o.id)))
  OR (o.op_type = 'hostaway.record_offline_charge' AND i.state = 'payment_captured'
      AND NOT EXISTS (SELECT 1 FROM booking.external_operations n WHERE n.intent_id = o.intent_id AND n.op_type = o.op_type
                       AND (n.source_version, n.created_at, n.id) > (o.source_version, o.created_at, o.id))
      AND NOT (o.state = 'outcome_unknown' AND EXISTS (SELECT 1 FROM booking.reconciliation_cases rc
                WHERE rc.intent_id = o.intent_id AND rc.status = 'open' AND rc.opened_by = 'op:' || o.id::text)))
)`;

/**
 * Bounded, read-only finder of missed outcomes. Keyset-paginated by (updated_at, id) so stuck rows never starve others:
 * pass the returned `next` back as `after`. Rows changed within `graceMs` are skipped (a live worker may still apply).
 */
export async function findMissedOutcomes(pool, { now, graceMs = RECOVERY_DEFAULT_GRACE_MS, limit = RECOVERY_MAX_BATCH, after = null } = {}) {
  if (!Number.isFinite(now)) throw new TypeError("findMissedOutcomes: now required");
  const n = bound(limit);
  const r = await pool.query(
    `SELECT o.id, o.intent_id, o.op_type, o.state, o.updated_at FROM booking.external_operations o
       JOIN booking.intents i ON i.id = o.intent_id
      WHERE o.op_type = ANY($1) AND o.state IN ('succeeded', 'failed_definite', 'outcome_unknown') AND o.dispatched_at IS NOT NULL
        AND o.updated_at <= $2
        AND NOT EXISTS (SELECT 1 FROM booking.intent_applied_events e WHERE e.intent_id = o.intent_id AND e.event_id = 'op-outcome:' || o.id::text)
        AND ${AWAITING}
        AND ($3::timestamptz IS NULL OR (o.updated_at, o.id) > ($3::timestamptz, $4::uuid))
      ORDER BY o.updated_at, o.id LIMIT $5`,
    [WRITE_OP_TYPES, new Date(now - graceMs), after ? new Date(after.updatedAt) : null, after ? after.id : null, n]);
  const rows = r.rows.map((x) => ({ opId: x.id, intentId: x.intent_id, opType: x.op_type, state: x.state, updatedAt: ms(x.updated_at) }));
  const last = rows[rows.length - 1];
  return { rows, next: rows.length === n ? { updatedAt: last.updatedAt, id: last.opId } : null };
}

/** Read-only: everything planRecovery() needs for one operation. Evidence = API evidence only (bound to a read row). */
export async function loadRecoveryFacts(q, opId) {
  const op = (await q.query("SELECT * FROM booking.external_operations WHERE id = $1", [opId])).rows[0];
  if (!op) return null;
  const row = await loadIntentRow(q, op.intent_id);
  const intent = rowToIntent(row);
  const evid = await q.query(
    `SELECT e.id, e.kind, e.external_ref, e.status, e.observed, e.observed_at, r.op_type AS read_op_type
       FROM booking.provider_evidence e JOIN booking.external_operations r ON r.id = e.read_operation_id
      WHERE e.intent_id = $1 AND e.source IN ('stripe_api', 'hostaway_api') AND e.observed_at >= $2
      ORDER BY e.observed_at DESC, e.id DESC LIMIT 50`, [op.intent_id, op.dispatched_at ?? op.created_at]);
  const applied = await q.query(
    `SELECT event_id FROM booking.intent_applied_events WHERE intent_id = $1 AND event_id LIKE ANY($2)`,
    [op.intent_id, [`op-outcome:${op.id}`, `op-unknown:${op.id}`, `op-inconclusive:${op.id}:%`]]);
  let paymentAttemptId = null;
  if (intent.payment && intent.payment.paymentIntentId) {
    const a = await q.query(`SELECT id FROM booking.payment_attempts WHERE intent_id = $1 AND payment_intent_id = $2 AND status = 'completed'`,
      [op.intent_id, intent.payment.paymentIntentId]);
    if (a.rowCount === 1) paymentAttemptId = a.rows[0].id;
  }
  return {
    intent,
    op: { id: op.id, opType: op.op_type, state: op.state, dispatchedAt: ms(op.dispatched_at), payload: op.payload,
      resultRef: op.result_ref, errorCode: op.error_code, settledEvidenceId: op.settled_evidence_id },
    evidence: evid.rows.map((e) => ({ id: e.id, kind: e.kind, readOpType: e.read_op_type, externalRef: e.external_ref, status: e.status,
      observed: e.observed, observedAt: ms(e.observed_at) })),
    appliedEventIds: applied.rows.map((x) => x.event_id),
    paymentAttemptId
  };
}

async function openSameRead(c, intentId, opType, field, ref) {
  return (await c.query(
    `SELECT id FROM booking.external_operations WHERE intent_id = $1 AND op_type = $2 AND retry_class = 'read'
        AND state IN ('pending', 'in_flight') AND payload ->> $3 = $4 LIMIT 1`, [intentId, opType, field, ref])).rows[0] || null;
}
async function insertRead(c, { intentId, opType, key, payload, now }) {
  const v = (await c.query("SELECT version FROM booking.intents WHERE id = $1", [intentId])).rows[0];
  const id = randomUUID();
  const r = await c.query(
    `INSERT INTO booking.external_operations (id, intent_id, op_type, idempotency_key, retry_class, state, payload, source_version,
       max_attempts, next_attempt_at, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'read','pending',$5,$6,$7,$8,$8,$8) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
    [id, intentId, opType, key, payload, v.version, DB_CONFIG.maxAttempts.read, new Date(now)]);
  return r.rows[0]?.id ?? null;
}

/**
 * Queue the provider READ a plan asked for. Deduplicated (an open identical read is reused) and bounded per
 * (operation, read, ref) by deterministic keys rr:{opId}:{opType}:{ref}:{n}, n <= MAX_RECOVERY_READS: two concurrent
 * planners compute the same key and only one row is inserted.
 */
export async function requestRecoveryRead(pool, opId, read, { now }) {
  const field = READ_FIELD[read && read.opType];
  if (!field || typeof read.ref !== "string" || !read.ref) throw new TypeError("requestRecoveryRead: a known read and ref required");
  return withTx(pool, async (c) => {
    const op = (await c.query("SELECT intent_id FROM booking.external_operations WHERE id = $1", [opId])).rows[0];
    if (!op) return { ok: false, error: "NOT_FOUND" };
    const open = await openSameRead(c, op.intent_id, read.opType, field, read.ref);
    if (open) return { ok: true, readOpId: open.id, reused: true };
    const prefix = `rr:${opId}:${read.opType}:${read.ref}:`;
    const n = Number((await c.query("SELECT count(*) AS n FROM booking.external_operations WHERE idempotency_key LIKE $1 || '%'",
      [prefix.replace(/[\\%_]/g, "\\$&")])).rows[0].n) + 1;
    if (n > MAX_RECOVERY_READS) return { ok: false, error: "RECOVERY_READS_EXHAUSTED" };
    const id = await insertRead(c, { intentId: op.intent_id, opType: read.opType, key: `${prefix}${n}`, payload: { [field]: read.ref }, now });
    if (!id) return { ok: true, readOpId: null, reused: true };   // a concurrent planner inserted the same key
    return { ok: true, readOpId: id, reused: false };
  });
}

/**
 * Orphan = a SUCCEEDED read with no evidence row, older than graceMs, for a non-terminal intent, that has not been
 * superseded by a newer read of the same thing (any later read row, or later evidence for the same read and ref).
 */
const ORPHAN = `o.retry_class = 'read' AND o.state = 'succeeded' AND o.completed_at <= $1
  AND NOT EXISTS (SELECT 1 FROM booking.provider_evidence e WHERE e.read_operation_id = o.id)
  AND NOT (i.state = ANY($2))
  AND NOT EXISTS (SELECT 1 FROM booking.external_operations n WHERE n.intent_id = o.intent_id AND n.op_type = o.op_type
                   AND n.retry_class = 'read' AND n.id <> o.id AND n.created_at >= o.created_at
                   AND coalesce(n.payload ->> 'sessionId', n.payload ->> 'paymentIntentId', n.payload ->> 'reservationId', n.payload ->> 'ref')
                     = coalesce(o.payload ->> 'sessionId', o.payload ->> 'paymentIntentId', o.payload ->> 'reservationId', o.payload ->> 'ref'))`;

export async function findOrphanReads(pool, { now, graceMs = RECOVERY_DEFAULT_GRACE_MS, limit = RECOVERY_MAX_BATCH } = {}) {
  if (!Number.isFinite(now)) throw new TypeError("findOrphanReads: now required");
  const r = await pool.query(
    `SELECT o.id, o.intent_id, o.op_type FROM booking.external_operations o JOIN booking.intents i ON i.id = o.intent_id
      WHERE ${ORPHAN} ORDER BY o.completed_at, o.id LIMIT $3`, [new Date(now - graceMs), TERMINAL_OR_ESCALATED, bound(limit)]);
  return r.rows.map((x) => ({ readOpId: x.id, intentId: x.intent_id, opType: x.op_type }));
}

/** Issue ONE new read for an orphan (key reissue:{orphanId}); the orphan stays as audit with no evidence (errata E4). */
export async function reissueOrphanRead(pool, orphanId, { now, graceMs = RECOVERY_DEFAULT_GRACE_MS }) {
  return withTx(pool, async (c) => {
    const o = (await c.query("SELECT * FROM booking.external_operations WHERE id = $1 FOR UPDATE", [orphanId])).rows[0];
    if (!o) return { ok: false, error: "NOT_FOUND" };
    const still = await c.query(`SELECT 1 FROM booking.external_operations o JOIN booking.intents i ON i.id = o.intent_id WHERE o.id = $3 AND ${ORPHAN}`,
      [new Date(now - graceMs), TERMINAL_OR_ESCALATED, orphanId]);
    if (still.rowCount === 0) return { ok: false, error: "NOT_AN_ORPHAN" };
    const field = READ_FIELD[o.op_type];
    if (!field || typeof o.payload[field] !== "string") return { ok: false, error: "NOT_REISSUABLE" };
    const depth = Number.isInteger(o.payload.reissueDepth) ? o.payload.reissueDepth + 1 : 1;
    if (depth > MAX_REISSUE_DEPTH) return { ok: false, error: "REISSUE_DEPTH_EXHAUSTED" };
    const id = await insertRead(c, { intentId: o.intent_id, opType: o.op_type, key: `reissue:${o.id}`,
      payload: { [field]: o.payload[field], reissueOf: o.id, reissueDepth: depth }, now });
    return id ? { ok: true, readOpId: id } : { ok: false, error: "ALREADY_REISSUED" };
  });
}

/**
 * Apply a planner "event" plan. Settlement first (when the plan cites evidence for an outcome_unknown row): the
 * database itself decides the row's final state from the evidence and refuses early or mismatched evidence. Then the
 * event, through applyEvent, with a check INSIDE its transaction (intent row locked first) that the intent version is
 * still the planned one and the operation row is still in a state the plan was derived from. A late or stale worker
 * therefore can never apply an outcome event from an outdated plan: { ok:false, error:"STALE_PLAN" }.
 */
export async function applyRecoveryPlan(pool, plan, { now, config, actor = "reconciler", hooks = {} }) {
  if (!plan || plan.kind !== "event" || !plan.event || !plan.opId || !Number.isInteger(plan.intentVersion)) throw new TypeError("applyRecoveryPlan: an event plan required");
  const op0 = (await pool.query("SELECT intent_id, state, settled_evidence_id FROM booking.external_operations WHERE id = $1", [plan.opId])).rows[0];
  if (!op0) return { ok: false, error: "NOT_FOUND" };
  // cheap early refusal of an outdated plan (the authoritative check is inside the event transaction below)
  const v0 = (await pool.query("SELECT version, state FROM booking.intents WHERE id = $1", [op0.intent_id])).rows[0];
  if (!v0 || v0.version !== plan.intentVersion || v0.state !== plan.intentState) return { ok: false, error: "STALE_PLAN" };
  let expectState = null;
  if (hooks.beforeSettle) await hooks.beforeSettle();
  if (plan.settle) {
    if (op0.state === "outcome_unknown") {
      const s = await settleOperationFromEvidence(pool, plan.opId, plan.settle);
      if (s.ok) expectState = s.state;
      else if (s.error !== "NOT_SETTLEABLE") return { ok: false, error: s.error };
      else {
        // a concurrent planner settled the row first: continue only if it used the SAME evidence (the event id then
        // de-duplicates); anything else means this plan is outdated
        const o = (await pool.query("SELECT settled_evidence_id FROM booking.external_operations WHERE id = $1", [plan.opId])).rows[0];
        if (!o || o.settled_evidence_id !== plan.settle) return { ok: false, error: "STALE_PLAN" };
      }
    } else if (op0.settled_evidence_id !== plan.settle) {
      return { ok: false, error: "STALE_PLAN" };                 // settled meanwhile from OTHER evidence
    }
  }
  if (hooks.afterSettle) await hooks.afterSettle();
  try {
    return await applyEvent(pool, op0.intent_id, plan.event, {
      now, config, actor,
      inTx: async (c, { before }) => {
        if (before.version !== plan.intentVersion || before.status !== plan.intentState) throw new RepoError("STALE_PLAN");
        const o = (await c.query("SELECT state, settled_evidence_id FROM booking.external_operations WHERE id = $1 FOR SHARE", [plan.opId])).rows[0];
        if (!o || !["succeeded", "failed_definite", "outcome_unknown"].includes(o.state)) throw new RepoError("STALE_PLAN");
        if (plan.settle && o.settled_evidence_id !== plan.settle) throw new RepoError("STALE_PLAN");
        if (expectState && o.state !== expectState) throw new RepoError("STALE_PLAN");
      }
    });
  } catch (e) {
    if (e instanceof RepoError && e.code === "STALE_PLAN") return { ok: false, error: "STALE_PLAN" };
    throw e;
  }
}

/** For an operator outcome the CALLER may choose to escalate: ESCALATE with a deterministic id (never inferred). */
export async function escalateOperatorPlan(pool, opId, code, { now, config }) {
  const op = (await pool.query("SELECT intent_id FROM booking.external_operations WHERE id = $1", [opId])).rows[0];
  if (!op) return { ok: false, error: "NOT_FOUND" };
  const safe = /^[A-Z0-9_:]{1,64}$/.test(code) ? code.replace(/:/g, "_") : "RECOVERY_OPERATOR_REQUIRED";
  return applyEvent(pool, op.intent_id, { type: "ESCALATE", id: RECOVERY_EVENT_ID.outcome(opId), code: safe }, { now, config, actor: "reconciler" });
}
