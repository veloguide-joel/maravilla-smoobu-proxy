-- 0004_capture_recovery — Stage E3.2 (owner-authorized 2026-10-21). Failed-capture recovery aligned with E3.
--   * intents: E3.2 counters (capture/cancel attempts) and the two recovery legs of capture_failed
--   * capture / void / cancel are "reconcile_first": attempted once per operation row; an ambiguous result is
--     settled only by an authoritative provider read (or an owner resolution) — never re-queued automatically
--   * at most one OPEN capture / void (per PaymentIntent) / cancel (per reservation) per intent
--   * settle_operation_from_evidence(): runtime settlement of an ambiguous Stripe/Hostaway write from API evidence
--     observed at least 2 minutes after the call
-- Applies to a database with no E2B-era capture/void/cancel rows (no hosted database exists yet).

ALTER TABLE booking.intents
  ADD COLUMN capture_attempts smallint NOT NULL DEFAULT 0 CHECK (capture_attempts >= 0),
  ADD COLUMN cancel_attempts smallint NOT NULL DEFAULT 0 CHECK (cancel_attempts >= 0),
  ADD COLUMN settlement_reservation_cancelled boolean,
  ADD COLUMN settlement_authorization_settled boolean,
  ADD CONSTRAINT settlement_pair CHECK ((settlement_reservation_cancelled IS NULL) = (settlement_authorization_settled IS NULL)),
  ADD CONSTRAINT settlement_in_capture_failed CHECK (state <> 'capture_failed' OR settlement_reservation_cancelled IS NOT NULL);

ALTER TABLE booking.external_operations DROP CONSTRAINT external_operations_retry_class_check;
ALTER TABLE booking.external_operations ADD CONSTRAINT external_operations_retry_class_check
  CHECK (retry_class IN ('read', 'idempotent', 'non_idempotent', 'reconcile_first'));
ALTER TABLE booking.external_operations ADD CONSTRAINT ops_reconcile_first_single_attempt
  CHECK (retry_class <> 'reconcile_first' OR max_attempts = 1);
ALTER TABLE booking.external_operations ADD CONSTRAINT ops_provider_writes_reconcile_first
  CHECK (op_type NOT IN ('stripe.capture_payment_intent', 'stripe.void_payment_intent', 'hostaway.cancel_reservation')
         OR retry_class = 'reconcile_first');
ALTER TABLE booking.external_operations ADD COLUMN settled_evidence_id uuid REFERENCES booking.provider_evidence (id);
CREATE UNIQUE INDEX external_operations_one_open_provider_write ON booking.external_operations
  (intent_id, op_type, (coalesce(payload ->> 'paymentIntentId', payload ->> 'reservationId')))
  WHERE op_type IN ('stripe.capture_payment_intent', 'stripe.void_payment_intent', 'hostaway.cancel_reservation')
    AND state IN ('pending', 'in_flight', 'outcome_unknown', 'escalated');

-- the card authorization of this intent is verifiably settled: a succeeded void, or the latest Stripe evidence
-- shows no funds held
CREATE FUNCTION booking.authorization_settled_for(p_intent uuid, p_pi text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
  SELECT p_pi IS NOT NULL AND (
    EXISTS (SELECT 1 FROM booking.external_operations
             WHERE intent_id = p_intent AND op_type = 'stripe.void_payment_intent' AND state = 'succeeded'
               AND payload ->> 'paymentIntentId' = p_pi)
    OR coalesce((SELECT status IN ('canceled', 'requires_payment_method') FROM booking.provider_evidence
                  WHERE intent_id = p_intent AND kind = 'payment_intent' AND external_ref = p_pi
                  ORDER BY observed_at DESC, created_at DESC LIMIT 1), false))
$$;

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
    OR (OLD.state = 'in_flight'       AND NEW.state = 'pending' AND OLD.retry_class NOT IN ('non_idempotent', 'reconcile_first'))
    OR (OLD.state = 'outcome_unknown' AND NEW.state IN ('succeeded', 'failed_definite', 'escalated'))
    OR (OLD.state = 'outcome_unknown' AND NEW.state = 'pending' AND OLD.retry_class NOT IN ('non_idempotent', 'reconcile_first'))
    OR (OLD.state = 'escalated'       AND NEW.state IN ('succeeded', 'failed_definite'))
  ) THEN
    RAISE EXCEPTION 'operation state % -> % not allowed (retry class %)', OLD.state, NEW.state, OLD.retry_class
      USING ERRCODE = 'check_violation';
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
    -- E3.2: a provider write that is reconciled first may be reported "definitely refused" only with an explicit
    -- provider error code; timeouts, network errors, 5xx/429 and lease expiry are ambiguous by definition.
    IF OLD.state = 'in_flight' AND NEW.state = 'failed_definite' AND OLD.retry_class = 'reconcile_first'
       AND (NEW.error_code IS NULL OR NEW.error_code IN ('TIMEOUT', 'NETWORK_ERROR', 'LEASE_EXPIRED', 'OUTCOME_UNKNOWN', 'HTTP_5XX', 'RATE_LIMITED')) THEN
      RAISE EXCEPTION 'AMBIGUOUS_RESULT_NOT_DEFINITE: % is not a definite refusal for %', coalesce(NEW.error_code, 'NULL'), OLD.op_type
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION booking.intents_safety_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
DECLARE r booking.reconciliation_resolutions%ROWTYPE; want text; sess text;
BEGIN
  -- E3.2: each recovery leg of capture_failed is marked settled only on verified facts
  IF NEW.settlement_reservation_cancelled IS TRUE AND OLD.settlement_reservation_cancelled IS NOT TRUE AND NOT (
       EXISTS (SELECT 1 FROM booking.external_operations
                WHERE intent_id = NEW.id AND op_type = 'hostaway.cancel_reservation' AND state = 'succeeded')
       AND EXISTS (SELECT 1 FROM booking.provider_evidence
                    WHERE intent_id = NEW.id AND kind = 'hostaway_reservation' AND external_ref = NEW.hostaway_reservation_id
                      AND status = 'cancelled')) THEN
    RAISE EXCEPTION 'CANCELLATION_NOT_VERIFIED' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.settlement_authorization_settled IS TRUE AND OLD.settlement_authorization_settled IS NOT TRUE
     AND NOT booking.authorization_settled_for(NEW.id, NEW.stripe_payment_intent_id) THEN
    RAISE EXCEPTION 'AUTHORIZATION_NOT_VERIFIED_SETTLED' USING ERRCODE = 'check_violation';
  END IF;
  IF (OLD.settlement_reservation_cancelled IS TRUE AND NEW.settlement_reservation_cancelled IS NOT TRUE)
     OR (OLD.settlement_authorization_settled IS TRUE AND NEW.settlement_authorization_settled IS NOT TRUE) THEN
    RAISE EXCEPTION 'settlement legs only move forward' USING ERRCODE = 'check_violation';
  END IF;
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
     AND NOT booking.authorization_settled_for(NEW.id, NEW.stripe_payment_intent_id) THEN
    RAISE EXCEPTION 'VOID_NOT_VERIFIED' USING ERRCODE = 'check_violation';
  END IF;

  -- C5 / E3.2: "cancelled" after a failed capture needs BOTH legs verified (the flags above enforce each leg)
  IF OLD.state = 'capture_failed' AND NEW.state = 'cancelled'
     AND NOT (NEW.settlement_reservation_cancelled IS TRUE AND NEW.settlement_authorization_settled IS TRUE) THEN
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

-- Runtime settlement of an ambiguous capture / void / cancel from an AUTHORITATIVE provider read (API evidence
-- recorded from a succeeded read operation), observed at least 2 minutes after the call was handed to a sender.
CREATE FUNCTION booking.settle_operation_from_evidence(p_op uuid, p_evidence uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
DECLARE op booking.external_operations%ROWTYPE; e booking.provider_evidence%ROWTYPE; i booking.intents%ROWTYPE; decision text;
BEGIN
  SELECT * INTO op FROM booking.external_operations WHERE id = p_op FOR UPDATE;
  IF NOT FOUND OR op.retry_class <> 'reconcile_first' OR op.state <> 'outcome_unknown' THEN
    RAISE EXCEPTION 'NOT_SETTLEABLE' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO e FROM booking.provider_evidence WHERE id = p_evidence;
  IF NOT FOUND OR e.intent_id <> op.intent_id OR e.source NOT IN ('stripe_api', 'hostaway_api') THEN
    RAISE EXCEPTION 'EVIDENCE_NOT_ACCEPTABLE' USING ERRCODE = 'check_violation';
  END IF;
  IF e.observed_at < coalesce(op.dispatched_at, op.created_at) + interval '2 minutes' THEN
    RAISE EXCEPTION 'EVIDENCE_TOO_EARLY' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO i FROM booking.intents WHERE id = op.intent_id;
  IF op.op_type IN ('stripe.capture_payment_intent', 'stripe.void_payment_intent') THEN
    IF e.kind <> 'payment_intent' OR e.external_ref IS DISTINCT FROM op.payload ->> 'paymentIntentId' THEN
      RAISE EXCEPTION 'EVIDENCE_REF_MISMATCH' USING ERRCODE = 'check_violation';
    END IF;
    IF op.op_type = 'stripe.capture_payment_intent' THEN
      decision := CASE WHEN e.status = 'succeeded' AND (e.observed ->> 'amountReceivedMinor')::bigint = i.final_total_minor THEN 'succeeded'
                       WHEN e.status IN ('requires_capture', 'canceled', 'requires_payment_method') THEN 'failed_definite' END;
    ELSE
      decision := CASE WHEN e.status = 'canceled' THEN 'succeeded'
                       WHEN e.status IN ('requires_capture', 'succeeded') THEN 'failed_definite' END;
    END IF;
  ELSE -- hostaway.cancel_reservation
    IF e.kind <> 'hostaway_reservation' OR e.external_ref IS DISTINCT FROM op.payload ->> 'reservationId' THEN
      RAISE EXCEPTION 'EVIDENCE_REF_MISMATCH' USING ERRCODE = 'check_violation';
    END IF;
    decision := CASE WHEN e.status = 'cancelled' THEN 'succeeded' WHEN e.status = 'found_active' THEN 'failed_definite' END;
  END IF;
  IF decision IS NULL THEN RAISE EXCEPTION 'EVIDENCE_INCONCLUSIVE' USING ERRCODE = 'check_violation'; END IF;
  UPDATE booking.external_operations
     SET state = decision, completed_at = e.observed_at, settled_evidence_id = e.id, result_ref = e.external_ref,
         error_code = CASE WHEN decision = 'failed_definite' THEN 'RECONCILED_NOT_APPLIED' END, updated_at = e.observed_at
   WHERE id = op.id;
  RETURN decision;
END $$;

REVOKE EXECUTE ON FUNCTION booking.authorization_settled_for(uuid, text), booking.settle_operation_from_evidence(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION booking.authorization_settled_for(uuid, text), booking.settle_operation_from_evidence(uuid, uuid) TO mv_booking_app;
GRANT EXECUTE ON FUNCTION booking.authorization_settled_for(uuid, text) TO mv_booking_admin;
