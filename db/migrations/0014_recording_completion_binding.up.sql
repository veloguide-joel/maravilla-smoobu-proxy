-- 0014_recording_completion_binding (up) — Stage E7.4b-D1 D5 (offline). DISPOSABLE LOCAL test databases only.
-- Claim-to-confirmation binding (claude/e74b-completion-binding-contract.md at cb532dc + root addendum A–E): the first proof link of a recording
-- that was CLAIMED through the 0012 / 0013 fence must carry executorAccountRef = the claimed assessment's account_ref (= cfg.accountRef) and
-- paymentMethod = that assessment's cfg.paymentMethod. Labels stay TRUST (not provider-account authentication); no paymentMethod is chosen here.
-- One private predicate + the 0010 recording_lifecycle_guard (lines 166–242, copied verbatim) with two marked "-- 0014" blocks after the existing
-- proof acceptance. No public function, signature, grant, table or runtime lock order changes.

DO $$
BEGIN
  IF to_regprocedure('booking.record_release_review_assessment(uuid,text,text,text,uuid,uuid,uuid,uuid,integer,text,text,text,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'MIGRATION_0014_PRECONDITION: 0013 is not applied' USING ERRCODE = 'check_violation';
  END IF;
END $$;

-- migration-level serialization only (no runtime lock-order change): block concurrent operation / claim-audit writes, in this fixed order,
-- for the rest of this migration transaction, BEFORE the precondition is checked
LOCK TABLE booking.external_operations, booking.recording_claim_assessments IN SHARE ROW EXCLUSIVE MODE;

-- the D5 predicate (private; SECURITY DEFINER; VOLATILE; takes no lock, reads no clock). Anchor: ONLY the immutable claim audit's assessment_id.
-- p_worker NOT NULL = worker attach (must equal the claim worker); NULL = owner / maintenance mode (the guard passes NULL only in the NULL -> link branch).
-- Reads only immutable columns of the operation row (op_type, intent_id), so the OLD row visible inside a BEFORE trigger is sufficient.
-- -> NULL (bound) | 'NO_CLAIM_AUDIT' | a refusal code. Every comparison is NULL-safe (coalesce(.., false) / IS DISTINCT FROM).
CREATE FUNCTION booking.recording_completion_binding_refusal(p_op uuid, p_evidence uuid, p_worker text) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
DECLARE v_intent uuid; ca booking.recording_claim_assessments%ROWTYPE; a booking.recording_assessments%ROWTYPE; e booking.provider_evidence%ROWTYPE;
BEGIN
  IF p_op IS NULL OR p_evidence IS NULL THEN RETURN 'BINDING_INPUT'; END IF;
  SELECT intent_id INTO v_intent FROM booking.external_operations WHERE id = p_op AND op_type = 'hostaway.record_offline_charge';
  IF v_intent IS NULL THEN RETURN 'NOT_A_RECORDING'; END IF;
  SELECT * INTO ca FROM booking.recording_claim_assessments WHERE operation_id = p_op;
  IF ca.operation_id IS NULL THEN RETURN 'NO_CLAIM_AUDIT'; END IF;
  SELECT * INTO a FROM booking.recording_assessments WHERE id = ca.assessment_id;
  IF NOT coalesce(a.id IS NOT NULL AND a.operation_id = p_op AND ca.intent_id = v_intent AND a.intent_id = v_intent AND a.phase = 'preflight'
                  AND a.outcome = 'eligible' AND a.epoch = ca.epoch AND a.worker = ca.worker
                  AND ca.epoch = booking.recording_preflight_epoch(p_op), false) THEN
    RETURN 'CLAIM_AUDIT_BINDING';
  END IF;
  IF p_worker IS NOT NULL AND p_worker IS DISTINCT FROM ca.worker THEN RETURN 'CLAIM_WORKER'; END IF;
  IF NOT coalesce(jsonb_typeof(a.cfg -> 'accountRef') = 'string' AND a.cfg -> 'accountRef' = to_jsonb(a.account_ref)
                  AND jsonb_typeof(a.cfg -> 'paymentMethod') = 'string' AND (a.cfg ->> 'paymentMethod') IN ('credit_card', 'other'), false) THEN
    RETURN 'CLAIM_CONFIG_INVALID';
  END IF;
  SELECT * INTO e FROM booking.provider_evidence WHERE id = p_evidence;
  IF e.id IS NULL OR e.intent_id IS DISTINCT FROM v_intent THEN RETURN 'EVIDENCE_BINDING'; END IF;
  IF NOT coalesce(jsonb_typeof(e.observed -> 'executorAccountRef') = 'string' AND e.observed -> 'executorAccountRef' = to_jsonb(a.account_ref), false) THEN
    RETURN 'EXECUTOR_ACCOUNT_MISMATCH';
  END IF;
  IF NOT coalesce(jsonb_typeof(e.observed -> 'paymentMethod') = 'string' AND e.observed -> 'paymentMethod' = a.cfg -> 'paymentMethod', false) THEN
    RETURN 'PAYMENT_METHOD_MISMATCH';
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION booking.recording_completion_binding_refusal(uuid, uuid, text) FROM PUBLIC;

-- consistency precondition (root addendum B; NOT new provenance attestation): every recording that is ALREADY linked and HAS a claim audit must
-- satisfy the binding in owner mode; otherwise the whole up fails and nothing changes. Linked rows without a claim audit stay under the legacy policy.
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM booking.external_operations o JOIN booking.recording_claim_assessments ca ON ca.operation_id = o.id
   WHERE o.op_type = 'hostaway.record_offline_charge' AND o.settled_evidence_id IS NOT NULL
     AND booking.recording_completion_binding_refusal(o.id, o.settled_evidence_id, NULL) IS NOT NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'MIGRATION_0014_PRECONDITION_UNBOUND_LINK: % linked claimed recording(s) carry proof not bound to their claim', n USING ERRCODE = 'check_violation';
  END IF;
END $$;

-- 0010 lifecycle guard, verbatim, with the two "-- 0014" blocks (security INVOKER, search_path, ACL and trigger unchanged)
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
    -- 0014 (D5): a recording WITH a claim audit links only proof bound to its claim (owner / maintenance mode: no worker). Only a recording with NO
    -- claim audit keeps the historical owner-maintenance policy (the existing owner_historical proof above); every other refusal raises.
    r := booking.recording_completion_binding_refusal(NEW.id, NEW.settled_evidence_id, NULL);
    IF r IS NOT NULL AND r <> 'NO_CLAIM_AUDIT' THEN RAISE EXCEPTION 'RECORDING_CLAIM_BINDING: %', r USING ERRCODE = 'check_violation'; END IF;
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
    -- 0014 (D5): worker completion only with proof bound to THIS recording's claim by the claiming worker; no claim audit refuses (fail closed)
    IF OLD.lease_worker_id IS NULL THEN RAISE EXCEPTION 'RECORDING_CLAIM_BINDING: CLAIM_WORKER' USING ERRCODE = 'check_violation'; END IF;
    r := booking.recording_completion_binding_refusal(NEW.id, NEW.settled_evidence_id, OLD.lease_worker_id);
    IF r IS NOT NULL THEN RAISE EXCEPTION 'RECORDING_CLAIM_BINDING: %', r USING ERRCODE = 'check_violation'; END IF;
  END IF;
  RETURN NEW;
END $$;
