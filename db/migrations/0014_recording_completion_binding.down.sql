-- 0014_recording_completion_binding (down) — restores a FRESH 0013 schema exactly (the 0010 lifecycle guard body, lines 166–242, verbatim; the
-- predicate dropped). 0014 stores no data. REFUSES while a D5-governed attach is still possible (root addendum A, conservative):
--   * ANY recording WITH a claim audit and settled_evidence_id NULL, in ANY state (in_flight, outcome_unknown, escalated, succeeded-unlinked,
--     failed_definite, superseded, ...): owner resolution could make it succeeded-unlinked and a proof could then be attached unbound;
--   * ANY in_flight recording WITHOUT a claim audit: down would re-enable its (fail-closed) worker completion.
-- Linked immutable rows may remain. RESIDUAL: claims created AFTER an authorized downgrade use schema-13 semantics (no binding).
-- migration-level serialization only (no runtime lock-order change): block concurrent operation / claim-audit writes, in this fixed order,
-- for the rest of this migration transaction, BEFORE the precondition is checked
LOCK TABLE booking.external_operations, booking.recording_claim_assessments IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM booking.external_operations o JOIN booking.recording_claim_assessments ca ON ca.operation_id = o.id
              WHERE o.op_type = 'hostaway.record_offline_charge' AND o.settled_evidence_id IS NULL)
     OR EXISTS (SELECT 1 FROM booking.external_operations o
                 WHERE o.op_type = 'hostaway.record_offline_charge' AND o.state = 'in_flight'
                   AND NOT EXISTS (SELECT 1 FROM booking.recording_claim_assessments ca WHERE ca.operation_id = o.id)) THEN
    RAISE EXCEPTION 'DOWNGRADE_REFUSED_RECORDING_COMPLETION_BINDING: a claimed recording is still unlinked, or an unclaimed recording is in flight'
      USING ERRCODE = 'check_violation';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION booking.recording_lifecycle_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, booking AS $$
DECLARE r text; t timestamptz;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.settled_evidence_id IS NOT NULL OR NEW.result_ref IS NOT NULL OR NEW.completed_at IS NOT NULL OR NEW.dispatched_at IS NOT NULL
       OR NEW.lease_worker_id IS NOT NULL OR NEW.lease_until IS NOT NULL OR NEW.late_result_status IS NOT NULL OR NEW.late_result_ref IS NOT NULL
       OR NEW.resolution_id IS NOT NULL THEN
      RAISE EXCEPTION 'RECORDING_LIFECYCLE_IMMUTABLE: a recording is created without proof, result, times, lease or resolution'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.idempotency_key IS NULL OR NEW.idempotency_key !~ ('^och:' || NEW.intent_id::text || ':[1-9][0-9]{0,8}$') THEN
      RAISE EXCEPTION 'RECORDING_LIFECYCLE_IMMUTABLE: recording key must be och:<intent>:<n>' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  -- UPDATE
  IF OLD.state = 'succeeded' THEN
    IF (to_jsonb(NEW) - 'updated_at' - 'settled_evidence_id') IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at' - 'settled_evidence_id') THEN
      RAISE EXCEPTION 'RECORDING_LIFECYCLE_IMMUTABLE: a succeeded recording is frozen' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.settled_evidence_id IS NOT DISTINCT FROM OLD.settled_evidence_id THEN RETURN NEW; END IF;
    -- the single exception: NULL -> validated link (0008 refuses clear / repoint afterwards)
    IF OLD.settled_evidence_id IS NOT NULL THEN RETURN NEW; END IF;                       -- 0008 raises SETTLED_EVIDENCE_IMMUTABLE
    IF NOT booking.is_privileged() THEN
      RAISE EXCEPTION 'RECORDING_SUCCESS_REQUIRES_FUNCTION: a link is attached only through booking.link_recording_evidence'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    t := clock_timestamp();
    r := booking.recording_proof_refusal(NEW.intent_id, NEW.payload, NEW.result_ref, NEW.dispatched_at, NEW.created_at, NEW.settled_evidence_id,
                                          'owner_historical', t);
    IF r IS NOT NULL THEN RAISE EXCEPTION 'RECORDING_PROOF_REFUSED: %', r USING ERRCODE = 'check_violation'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.source_version IS DISTINCT FROM OLD.source_version THEN
    RAISE EXCEPTION 'RECORDING_LIFECYCLE_IMMUTABLE: source_version' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.dispatched_at IS DISTINCT FROM OLD.dispatched_at
     AND NOT (OLD.dispatched_at IS NULL AND NEW.dispatched_at IS NOT NULL AND OLD.state = 'pending' AND NEW.state = 'in_flight') THEN
    RAISE EXCEPTION 'RECORDING_LIFECYCLE_IMMUTABLE: dispatched_at' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.completed_at IS DISTINCT FROM OLD.completed_at
     AND NOT (OLD.completed_at IS NULL AND NEW.completed_at IS NOT NULL AND NEW.state IN ('succeeded', 'failed_definite') AND NEW.state <> OLD.state) THEN
    RAISE EXCEPTION 'RECORDING_LIFECYCLE_IMMUTABLE: completed_at' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.result_ref IS DISTINCT FROM OLD.result_ref
     AND NOT (OLD.result_ref IS NULL AND NEW.state IN ('succeeded', 'failed_definite') AND NEW.state <> OLD.state) THEN
    RAISE EXCEPTION 'RECORDING_LIFECYCLE_IMMUTABLE: result_ref' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.late_result_status IS DISTINCT FROM OLD.late_result_status OR NEW.late_result_ref IS DISTINCT FROM OLD.late_result_ref)
     AND NOT (OLD.late_result_status IS NULL AND OLD.late_result_ref IS NULL AND NEW.state IN ('outcome_unknown', 'escalated')) THEN
    RAISE EXCEPTION 'RECORDING_LIFECYCLE_IMMUTABLE: late result is recorded once' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.settled_evidence_id IS NOT NULL AND NEW.state <> 'succeeded' THEN
    RAISE EXCEPTION 'RECORDING_LIFECYCLE_IMMUTABLE: a link is attached only to a succeeded recording' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state = 'succeeded' THEN                                                           -- transition into succeeded
    IF NOT booking.is_privileged() THEN
      RAISE EXCEPTION 'RECORDING_SUCCESS_REQUIRES_FUNCTION: a recording succeeds only through booking.complete_recording_with_evidence'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.settled_evidence_id IS NULL THEN
      IF NEW.resolution_id IS NULL THEN
        RAISE EXCEPTION 'RECORDING_FINALISATION_UNPROVEN: a succeeded recording needs a validated link or an owner resolution'
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;                                                                            -- owner resolution: succeeded-unproven
    END IF;
    IF NEW.completed_at IS NULL OR NEW.completed_at > clock_timestamp() THEN
      RAISE EXCEPTION 'RECORDING_PROOF_REFUSED: COMPLETION_TIME_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    r := booking.recording_proof_refusal(NEW.intent_id, NEW.payload, NEW.result_ref, NEW.dispatched_at, NEW.created_at, NEW.settled_evidence_id,
                                          'worker_fresh', NEW.completed_at);
    IF r IS NOT NULL THEN RAISE EXCEPTION 'RECORDING_PROOF_REFUSED: %', r USING ERRCODE = 'check_violation'; END IF;
  END IF;
  RETURN NEW;
END $$;

DROP FUNCTION booking.recording_completion_binding_refusal(uuid, uuid, text);
