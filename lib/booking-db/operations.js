// lib/booking-db/operations.js (moved verbatim from db/lib/operations.js for packaging, 2026-11-02) — Stage E2B. Transactional outbox: claim, complete, recover.
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
 * Claim the next due operation for this worker (one short transaction).
 * A Hostaway create is only claimable while its intent is reservation_pending with a dispatch record and a live
 * lease; any other create row is never claimed (it is superseded by E3 when the intent leaves reservation_pending, or
 * by supersedeUnclaimableCreates()).
 * E5a: `opId` restricts the claim to one known row (a webhook claims exactly the read it queued).
 * E7.1 capture fence: a stripe.capture_payment_intent row is claimable only while its intent is reservation_confirmed
 * AND the row's payload.attempt equals the intent's current capture_attempts.
 * Lock order is INTENT FIRST for every row this function locks: the candidate is found without locks, its intent row
 * is share-locked (serialising with applyEvent's FOR NO KEY UPDATE), and only then is the operation row locked and
 * the fences re-checked in the same transaction. No other row is locked or updated here. Migration 0007 enforces the
 * capture fence in the database for every claim path; a generic direct UPDATE of an operation row locks the row
 * before the trigger share-locks the intent (operation-then-intent): PostgreSQL may then abort one side with a
 * deadlock error (40P01), which is a retryable failure, never a fence bypass.
 */
const CAPTURE_FENCE = `(o.op_type <> 'stripe.capture_payment_intent' OR EXISTS (
    SELECT 1 FROM booking.intents fi WHERE fi.id = o.intent_id AND fi.state = 'reservation_confirmed'
       AND (o.payload ->> 'attempt') = fi.capture_attempts::text))`;
// E7.4a void / cancel fences (fail closed): a Stripe void row is claimable only while its intent's AUTHORIZATION leg is
// open (reservation_failed, or capture_failed with authorizationSettled explicitly false), the row binds the intent's
// current PaymentIntent, and booking.authorization_settled_for() is NOT already true; a Hostaway cancel row only while the
// intent is capture_failed with reservationCancelled explicitly false and the row binds the intent's reservation. This is
// a conservative refusal only: authorization_settled_for() is broader (it accepts requires_payment_method) and is never a
// substitute for the cleanup worker's strict proofs. Migration 0009 enforces the same conditions for every claim path.
const VOID_FENCE = `(o.op_type <> 'stripe.void_payment_intent' OR EXISTS (
    SELECT 1 FROM booking.intents vi WHERE vi.id = o.intent_id
       AND (vi.state = 'reservation_failed' OR (vi.state = 'capture_failed' AND vi.settlement_authorization_settled IS FALSE))
       AND vi.stripe_payment_intent_id IS NOT NULL AND (o.payload ->> 'paymentIntentId') = vi.stripe_payment_intent_id
       AND NOT booking.authorization_settled_for(vi.id, vi.stripe_payment_intent_id)))`;
const CANCEL_FENCE = `(o.op_type <> 'hostaway.cancel_reservation' OR EXISTS (
    SELECT 1 FROM booking.intents ki WHERE ki.id = o.intent_id AND ki.state = 'capture_failed'
       AND ki.settlement_reservation_cancelled IS FALSE
       AND ki.hostaway_reservation_id IS NOT NULL AND (o.payload ->> 'reservationId') = ki.hostaway_reservation_id))`;
const CREATE_FENCE = (t) => `(o.op_type <> 'hostaway.create_reservation' OR EXISTS (
    SELECT 1 FROM booking.intents ci WHERE ci.id = o.intent_id AND ci.state = 'reservation_pending'
       AND ci.dispatch_at IS NOT NULL AND ci.lease_until >= ${t}))`;
export const CLAIM_MAX_CANDIDATES = 10;

export async function claimNextOperation(pool, { workerId, now, leaseMs = DB_CONFIG.operationLeaseMs, opTypes = null, intentId = null, opId = null, hooks = {} }) {
  const t = new Date(now);
  return withTx(pool, async (c) => {
    const skip = [];
    for (let n = 0; n < CLAIM_MAX_CANDIDATES; n++) {
      // 1. a candidate (no lock), already filtered by the fences
      const cand = (await c.query(
        `SELECT o.id, o.intent_id FROM booking.external_operations o
          WHERE o.state = 'pending' AND o.next_attempt_at <= $1
            AND ($2::text[] IS NULL OR o.op_type = ANY($2)) AND ($3::uuid IS NULL OR o.intent_id = $3) AND ($4::uuid IS NULL OR o.id = $4)
            AND NOT (o.id = ANY($5::uuid[])) AND ${CAPTURE_FENCE} AND ${CREATE_FENCE("$1")} AND ${VOID_FENCE} AND ${CANCEL_FENCE}
          ORDER BY o.next_attempt_at, o.created_at LIMIT 1`, [t, opTypes, intentId, opId, skip])).rows[0];
      if (!cand) break;
      // 2. intent first: share lock (waits for / blocks a concurrent transition of this intent)
      await c.query("SELECT 1 FROM booking.intents WHERE id = $1 FOR SHARE", [cand.intent_id]);
      if (hooks.afterIntentLock) await hooks.afterIntentLock(cand);
      // 3. then the operation row; the fences are re-evaluated against the now-locked intent row
      const r = await c.query(
        `WITH c AS (
           SELECT o.id FROM booking.external_operations o
            WHERE o.id = $4 AND o.state = 'pending' AND o.next_attempt_at <= $2 AND ${CAPTURE_FENCE} AND ${CREATE_FENCE("$2")} AND ${VOID_FENCE} AND ${CANCEL_FENCE}
            FOR UPDATE OF o SKIP LOCKED)
         UPDATE booking.external_operations o
            SET state = 'in_flight', lease_worker_id = $1, lease_until = $3, attempts = o.attempts + 1, dispatched_at = $2, updated_at = $2
           FROM c WHERE o.id = c.id RETURNING o.*`,
        [workerId, t, new Date(now + leaseMs), cand.id]);
      const op = r.rows[0] || null;
      if (!op) { skip.push(cand.id); continue; }       // taken by another worker or fenced meanwhile
      if (op.op_type === "hostaway.create_reservation") {
        await c.query("UPDATE booking.hostaway_reservation_attempts SET send_started_at = $2, updated_at = $2 WHERE operation_id = $1", [op.id, t]);
      }
      if (hooks.beforeCommit) await hooks.beforeCommit(op);
      return op;
    }
    if (hooks.beforeCommit) await hooks.beforeCommit(null);
    return null;
  });
}

/**
 * Retire PENDING Hostaway create rows that can no longer be claimed (intent not reservation_pending with a dispatch
 * and a live lease). A pending row was never handed to a sender, so it cannot have reached Hostaway. Bounded; one
 * short INTENT-FIRST transaction per row (intent share-locked, then the row updated with the condition re-checked).
 */
export async function supersedeUnclaimableCreates(pool, { now, limit = 50 }) {
  const t = new Date(now);
  const cands = (await pool.query(
    `SELECT o.id, o.intent_id FROM booking.external_operations o
      WHERE o.op_type = 'hostaway.create_reservation' AND o.state = 'pending' AND NOT ${CREATE_FENCE("$1")}
      ORDER BY o.created_at, o.id LIMIT $2`, [t, Math.max(1, Math.min(100, limit))])).rows;
  const out = [];
  for (const cand of cands) {
    const done = await withTx(pool, async (c) => {
      await c.query("SELECT 1 FROM booking.intents WHERE id = $1 FOR SHARE", [cand.intent_id]);
      const u = await c.query(
        `UPDATE booking.external_operations o SET state = 'superseded', updated_at = $1
          WHERE o.id = $2 AND o.state = 'pending' AND NOT ${CREATE_FENCE("$1")} RETURNING o.id`, [t, cand.id]);
      return u.rowCount === 1;
    });
    if (done) out.push(cand.id);
  }
  return out;
}

/**
 * Record a provider result for an in-flight operation held by this worker.
 * outcome: { status: 'succeeded' | 'failed_definite' | 'outcome_unknown', resultRef?, errorCode? }
 * If the lease was lost (expired / recovered), the result is kept as late evidence on ambiguous rows and
 * { ok:false, error:'LEASE_LOST' } is returned — the caller must not apply an E3 event.
 */
export async function completeOperation(pool, opId, opts) {
  // E7.4b-D2 (0010): a Hostaway payment recording succeeds ONLY through completeRecordingWithEvidence (full linked proof).
  // Decided from the immutable op_type, read WITHOUT a lock, before any transaction: no op-first lock is ever taken here.
  if (opts && opts.outcome && opts.outcome.status === "succeeded") {
    const t = (await pool.query("SELECT op_type FROM booking.external_operations WHERE id = $1", [opId])).rows[0];
    if (t && t.op_type === RECORDING_OP) return { ok: false, error: "RECORDING_SUCCESS_REQUIRES_EVIDENCE" };
  }
  try { return await completeOperationOnce(pool, opId, opts); }
  catch (e) { const code = dbSafetyCode(e); if (code) return { ok: false, error: code }; throw e; }
}

const RECORDING_OP = "hostaway.record_offline_charge";
const callRecordingFn = async (pool, sql, params) => {
  try { return { ok: true, state: (await pool.query(sql, params)).rows[0].r }; }
  catch (e) { const code = dbSafetyCode(e); if (code) return { ok: false, error: code }; throw e; }
};
/**
 * E7.4b-D2: complete the INITIAL Hostaway payment recording as succeeded, atomically linked to full confirming API evidence
 * (booking.complete_recording_with_evidence: intent SHARE -> work SHARE -> op UPDATE -> advisory evidence lock, then the DB
 * decision instant; work lease, op lease, version, latest, attempt 1, 2-minute fresh proof, no positive contradiction).
 * -> { ok:true, state:'succeeded' } | { ok:false, error } (known refusal codes); unknown database errors throw.
 */
export async function completeRecordingWithEvidence(pool, opId, { workerId, evidenceId, resultRef, expectedVersion } = {}) {
  if (typeof workerId !== "string" || !workerId || typeof evidenceId !== "string" || typeof resultRef !== "string" || !/^[1-9]\d{0,15}$/.test(resultRef)
      || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw new TypeError("completeRecordingWithEvidence: workerId, evidenceId, canonical resultRef, expectedVersion");
  return callRecordingFn(pool, "SELECT booking.complete_recording_with_evidence($1, $2, $3, $4, $5) AS r", [opId, workerId, evidenceId, resultRef, expectedVersion]);
}
export const RECORDING_CONTRADICTION_SCAN_MAX = 500;
const EXACT_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/**
 * E7.4b-D2 diagnostic (READ-ONLY; no writer, no case, no reversal): the deterministic latest recording of each intent, LINKED
 * and succeeded, that later evidence positively contradicts (the 0010 recording_conflict_refusal predicate restated for the
 * runtime role, which cannot execute the private function; same scope: intent + reservation + window + marker, reference =
 * the linked proof). Keyset-paged on (evidence observed_at at full microsecond precision, evidence id, recording id).
 *   after = the previous page's `next`: { observedAtExact: 'YYYY-MM-DDTHH:MM:SS.ffffffZ', evidenceId, opId } (validated, unchanged)
 * -> { rows: [{ opId, intentId, resultRef, evidenceId, source, observedAt (ms, display only), observedAtExact }], next | null }
 */
export async function listRecordingContradictions(pool, { after = null, limit = 100 } = {}) {
  if (after !== null) {
    const ok = after && typeof after === "object" && JSON.stringify(Object.keys(after).sort()) === JSON.stringify(["evidenceId", "observedAtExact", "opId"])
      && typeof after.observedAtExact === "string" && EXACT_TS_RE.test(after.observedAtExact) && UUID_RE.test(after.evidenceId) && UUID_RE.test(after.opId);
    if (!ok) throw new TypeError("listRecordingContradictions: after must be a previous page's next cursor");
  }
  const n = Math.max(1, Math.min(RECORDING_CONTRADICTION_SCAN_MAX, Number.isSafeInteger(limit) ? limit : 100));
  const r = await pool.query(
    `SELECT o.id AS op_id, o.intent_id, o.result_ref, e.id AS evidence_id, e.source, e.observed_at,
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
      ORDER BY e.observed_at, e.id, o.id LIMIT $4`,
    [after ? after.observedAtExact : null, after ? after.evidenceId : null, after ? after.opId : null, n]);
  const rows = r.rows.map((x) => ({ opId: x.op_id, intentId: x.intent_id, resultRef: x.result_ref, evidenceId: x.evidence_id, source: x.source,
    observedAt: new Date(x.observed_at).getTime(), observedAtExact: x.observed_at_exact }));
  const last = rows[rows.length - 1];
  return { rows, next: rows.length === n ? { observedAtExact: last.observedAtExact, evidenceId: last.evidenceId, opId: last.opId } : null };
}
/**
 * E7.4b-D2: attach owner-historical full proof (>= 15 min after dispatch) to a recording ALREADY succeeded without a link
 * (owner-resolved / inherited). Maintenance only: no worker, lease or version input; it can change only the link.
 * -> { ok:true, state:'linked' | 'already_linked' } | { ok:false, error }
 */
export async function linkRecordingEvidence(pool, opId, { evidenceId } = {}) {
  if (typeof evidenceId !== "string") throw new TypeError("linkRecordingEvidence: evidenceId");
  return callRecordingFn(pool, "SELECT booking.link_recording_evidence($1, $2) AS r", [opId, evidenceId]);
}

async function completeOperationOnce(pool, opId, { workerId, now, outcome, cfg = DB_CONFIG }) {
  const t = new Date(now);
  return withTx(pool, async (c) => {
    const op = (await c.query("SELECT * FROM booking.external_operations WHERE id = $1 FOR UPDATE", [opId])).rows[0];
    if (!op) return { ok: false, error: "NOT_FOUND" };
    if (op.state !== "in_flight" || op.lease_worker_id !== workerId || t > op.lease_until) {
      let lateEvidenceRecorded = false;
      // a recording keeps its FIRST late result (0010 freezes it); a repeated late report records nothing and still says LEASE_LOST
      const firstLateOnly = op.op_type === RECORDING_OP && (op.late_result_status !== null || op.late_result_ref !== null);
      if (["outcome_unknown", "escalated"].includes(op.state) && outcome && outcome.status && !firstLateOnly) {
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

/**
 * Crash recovery for operations whose worker lease expired while in flight.
 * E7.2: optional scope filters (opTypes, intentId, listingIds) are applied in SQL BEFORE the limit; with none given the
 * behaviour is the original global one.
 */
export async function recoverExpiredOperations(pool, { now, cfg = DB_CONFIG, limit = 50, opTypes = null, intentId = null, listingIds = null, intentStates = null }) {
  return withTx(pool, async (c) => {
    if (intentStates !== null) {
      // E7.3b (optional; default null = unchanged global behaviour): phase-guarded maintenance. The owning intents are locked
      // FIRST (FOR SHARE, the claimNextOperation lock order) and must be in one of intentStates, so a concurrent transition out
      // of that phase either commits before (row skipped) or waits until this transaction ends. No provider call is made here.
      if (!Array.isArray(intentStates) || intentStates.length === 0) throw new TypeError("recoverExpiredOperations: intentStates");
      const locked = (await c.query(
        `SELECT i.id FROM booking.intents i
          WHERE i.state = ANY($1) AND ($3::uuid IS NULL OR i.id = $3) AND ($4::int[] IS NULL OR i.listing_id = ANY($4))
            AND EXISTS (SELECT 1 FROM booking.external_operations o WHERE o.intent_id = i.id AND o.state = 'in_flight' AND o.lease_until < $2
                         AND ($5::text[] IS NULL OR o.op_type = ANY($5)))
          ORDER BY i.id FOR SHARE OF i`, [intentStates, new Date(now), intentId, listingIds, opTypes])).rows.map((x) => x.id);
      if (locked.length === 0) return [];
      const r = await c.query(`SELECT o.* FROM booking.external_operations o
                                WHERE o.state = 'in_flight' AND o.lease_until < $1 AND o.intent_id = ANY($3::uuid[])
                                  AND ($4::text[] IS NULL OR o.op_type = ANY($4))
                                  AND EXISTS (SELECT 1 FROM booking.intents si WHERE si.id = o.intent_id AND si.state = ANY($5))
                                ORDER BY o.lease_until FOR UPDATE OF o SKIP LOCKED LIMIT $2`, [new Date(now), limit, locked, opTypes, intentStates]);
      const out = [];
      for (const op of r.rows) out.push({ id: op.id, opType: op.op_type, state: await markUnknown(c, op, now, "LEASE_EXPIRED", cfg) });
      return out;
    }
    const r = await c.query(`SELECT o.* FROM booking.external_operations o
                              WHERE o.state = 'in_flight' AND o.lease_until < $1
                                AND ($3::text[] IS NULL OR o.op_type = ANY($3)) AND ($4::uuid IS NULL OR o.intent_id = $4)
                                AND ($5::int[] IS NULL OR EXISTS (SELECT 1 FROM booking.intents si WHERE si.id = o.intent_id AND si.listing_id = ANY($5)))
                              ORDER BY o.lease_until FOR UPDATE OF o SKIP LOCKED LIMIT $2`, [new Date(now), limit, opTypes, intentId, listingIds]);
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

/** E5a: the latest Checkout Session create row for one payment attempt ({ id, state, result_ref } or null). Read-only. */
export async function findCheckoutCreateForAttempt(q, intentId, paymentAttemptId) {
  const r = await q.query(
    `SELECT id, state, result_ref FROM booking.external_operations
      WHERE intent_id = $1 AND op_type = 'stripe.create_checkout_session' AND payload ->> 'paymentAttemptId' = $2
      ORDER BY created_at DESC LIMIT 1`, [intentId, String(paymentAttemptId)]);
  return r.rows[0] || null;
}
