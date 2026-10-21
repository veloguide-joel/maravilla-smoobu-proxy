-- 0004_capture_recovery (down) — DEV/test only. Restores the 0003 definitions exactly.
DROP FUNCTION booking.settle_operation_from_evidence(uuid, uuid);

CREATE OR REPLACE FUNCTION booking.intents_safety_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
DECLARE r booking.reconciliation_resolutions%ROWTYPE; want text; sess text;
BEGIN
  IF NEW.state IS NOT DISTINCT FROM OLD.state THEN RETURN NEW; END IF;

  -- C6: payment and everything after it require this intent's own active claim
  IF NEW.state IN ('payment_pending', 'payment_authorized', 'reservation_pending', 'reservation_unknown', 'reservation_failed',
                   'reservation_confirmed', 'capture_unknown', 'capture_failed', 'payment_captured', 'confirmed')
     AND NOT EXISTS (SELECT 1 FROM booking.inventory_claims WHERE intent_id = NEW.id AND released_at IS NULL) THEN
    RAISE EXCEPTION 'CLAIM_REQUIRED: % requires an active date claim', NEW.state USING ERRCODE = 'check_violation';
  END IF;

  -- C3: a payment attempt ends only on verified checkout expiry (a single declined card is not final)
  IF NEW.state IN ('payment_failed', 'payment_expired') THEN
    sess := coalesce(NEW.checkout_session_id, OLD.checkout_session_id);
    IF sess IS NULL OR NOT EXISTS (SELECT 1 FROM booking.provider_evidence
                                    WHERE intent_id = NEW.id AND kind = 'checkout_session' AND external_ref = sess AND status = 'expired') THEN
      RAISE EXCEPTION 'CHECKOUT_EXPIRY_NOT_VERIFIED' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- C4: a void is reported only after the void operation succeeded
  IF OLD.state = 'reservation_failed' AND NEW.state = 'authorization_released'
     AND NOT EXISTS (SELECT 1 FROM booking.external_operations
                      WHERE intent_id = NEW.id AND op_type = 'stripe.void_payment_intent' AND state = 'succeeded') THEN
    RAISE EXCEPTION 'VOID_NOT_VERIFIED' USING ERRCODE = 'check_violation';
  END IF;

  -- C5: cancellation is complete only when the cancel call succeeded AND a read verifies the reservation is cancelled
  IF OLD.state = 'capture_failed' AND NEW.state = 'cancelled' AND NOT (
       EXISTS (SELECT 1 FROM booking.external_operations
                WHERE intent_id = NEW.id AND op_type = 'hostaway.cancel_reservation' AND state = 'succeeded')
       AND EXISTS (SELECT 1 FROM booking.provider_evidence
                    WHERE intent_id = NEW.id AND kind = 'hostaway_reservation' AND external_ref = OLD.hostaway_reservation_id
                      AND status = 'cancelled')) THEN
    RAISE EXCEPTION 'CANCELLATION_NOT_VERIFIED' USING ERRCODE = 'check_violation';
  END IF;

  -- C4: leaving reconciliation requires an unconsumed owner resolution for exactly this outcome
  IF OLD.state = 'reconciliation_required' THEN
    want := CASE NEW.state WHEN 'confirmed' THEN 'intent_confirmed' WHEN 'authorization_released' THEN 'intent_released'
                           WHEN 'cancelled' THEN 'intent_cancelled' END;
    SELECT * INTO r FROM booking.reconciliation_resolutions
     WHERE intent_id = NEW.id AND decision = want AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'RESOLUTION_REQUIRED: % from reconciliation_required needs an owner resolution', NEW.state USING ERRCODE = 'check_violation';
    END IF;
    IF want = 'intent_confirmed' AND NEW.hostaway_reservation_id IS DISTINCT FROM r.result_ref THEN
      RAISE EXCEPTION 'RESOLUTION_MISMATCH' USING ERRCODE = 'check_violation';
    END IF;
    UPDATE booking.reconciliation_resolutions SET consumed_at = NEW.updated_at, consumed_version = NEW.version WHERE id = r.id;
    UPDATE booking.reconciliation_cases SET status = 'resolved',
           resolution = CASE want WHEN 'intent_confirmed' THEN 'confirmed' WHEN 'intent_released' THEN 'released' ELSE 'cancelled' END,
           resolved_by = r.resolver, resolved_at = NEW.updated_at
     WHERE intent_id = NEW.id AND status = 'open';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION booking.external_operations_safety_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.resolution_id IS NOT NULL AND NOT booking.is_privileged() THEN
      RAISE EXCEPTION 'resolution links are set only by owner functions' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.op_type = 'hostaway.record_offline_charge' AND EXISTS (
         SELECT 1 FROM booking.external_operations o
          WHERE o.intent_id = NEW.intent_id AND o.op_type = 'hostaway.record_offline_charge'
            AND NOT (o.state = 'failed_definite' AND (o.resolution_id IS NOT NULL OR EXISTS (
                     SELECT 1 FROM booking.definite_refusal_codes d WHERE d.op_type = o.op_type AND d.code = o.error_code))))
    THEN
      RAISE EXCEPTION 'PRIOR_RECORDING_NOT_VERIFIED_FAILED: an earlier Hostaway payment recording is not verified as failed'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.resolution_id IS DISTINCT FROM OLD.resolution_id AND NOT booking.is_privileged() THEN
    RAISE EXCEPTION 'resolution links are set only by owner functions' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    IF OLD.state IN ('outcome_unknown', 'escalated') AND NOT booking.is_privileged() THEN
      RAISE EXCEPTION 'OWNER_RESOLUTION_REQUIRED: an uncertain operation is settled only by an owner resolution with evidence'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF OLD.state = 'in_flight' AND NEW.state = 'failed_definite' AND OLD.retry_class = 'non_idempotent' AND NOT EXISTS (
         SELECT 1 FROM booking.definite_refusal_codes d WHERE d.op_type = OLD.op_type AND d.code = NEW.error_code) THEN
      RAISE EXCEPTION 'NOT_A_CATALOGUED_DEFINITE_REFUSAL: % for %', NEW.error_code, OLD.op_type USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION booking.external_operations_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'pending' OR NEW.attempts <> 0 THEN
      RAISE EXCEPTION 'operations are created pending with no attempts' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.intent_id <> OLD.intent_id OR NEW.op_type <> OLD.op_type OR NEW.idempotency_key <> OLD.idempotency_key
     OR NEW.retry_class <> OLD.retry_class OR NEW.payload <> OLD.payload OR NEW.max_attempts <> OLD.max_attempts
     OR NEW.created_at <> OLD.created_at OR NEW.attempts < OLD.attempts THEN
    RAISE EXCEPTION 'operation identity is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state = OLD.state THEN RETURN NEW; END IF;
  -- Allowed state moves (operations' own state machine).
  IF NOT (
       (OLD.state = 'pending'         AND NEW.state IN ('in_flight', 'superseded', 'escalated'))
    OR (OLD.state = 'in_flight'       AND NEW.state IN ('succeeded', 'failed_definite', 'outcome_unknown', 'escalated'))
    OR (OLD.state = 'in_flight'       AND NEW.state = 'pending' AND OLD.retry_class <> 'non_idempotent')
    OR (OLD.state = 'outcome_unknown' AND NEW.state IN ('succeeded', 'failed_definite', 'escalated'))
    OR (OLD.state = 'outcome_unknown' AND NEW.state = 'pending' AND OLD.retry_class <> 'non_idempotent')
    OR (OLD.state = 'escalated'       AND NEW.state IN ('succeeded', 'failed_definite'))
  ) THEN
    RAISE EXCEPTION 'operation state % -> % not allowed (retry class %)', OLD.state, NEW.state, OLD.retry_class
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP FUNCTION booking.authorization_settled_for(uuid, text);
DROP INDEX booking.external_operations_one_open_provider_write;
ALTER TABLE booking.external_operations DROP COLUMN settled_evidence_id;
ALTER TABLE booking.external_operations DROP CONSTRAINT ops_provider_writes_reconcile_first;
ALTER TABLE booking.external_operations DROP CONSTRAINT ops_reconcile_first_single_attempt;
ALTER TABLE booking.external_operations DROP CONSTRAINT external_operations_retry_class_check;
ALTER TABLE booking.external_operations ADD CONSTRAINT external_operations_retry_class_check
  CHECK (retry_class IN ('read', 'idempotent', 'non_idempotent'));
ALTER TABLE booking.intents
  DROP CONSTRAINT settlement_in_capture_failed,
  DROP CONSTRAINT settlement_pair,
  DROP COLUMN settlement_authorization_settled,
  DROP COLUMN settlement_reservation_cancelled,
  DROP COLUMN cancel_attempts,
  DROP COLUMN capture_attempts;
