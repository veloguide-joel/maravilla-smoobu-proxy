-- 0005_db_clock_checkout_create (down) — DEV/test only. Restores the 0001/0003/0004 definitions exactly.
-- Refused if E2B.2-only data exists ('none_found' Checkout evidence, which 0003 validation would not accept).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM booking.provider_evidence WHERE kind = 'checkout_session' AND status = 'none_found') THEN
    RAISE EXCEPTION 'cannot roll back 0005: none_found Checkout evidence exists';
  END IF;
END $$;

DROP TRIGGER intent_transitions_stamp ON booking.intent_transitions;
DROP FUNCTION booking.intent_transitions_stamp();
DROP INDEX booking.payment_attempts_one_unresolved;
DROP INDEX booking.external_operations_one_open_checkout_create;
ALTER TABLE booking.external_operations DROP CONSTRAINT ops_provider_writes_reconcile_first;
ALTER TABLE booking.external_operations ADD CONSTRAINT ops_provider_writes_reconcile_first
  CHECK (op_type NOT IN ('stripe.capture_payment_intent', 'stripe.void_payment_intent', 'hostaway.cancel_reservation')
         OR retry_class = 'reconcile_first');

DROP FUNCTION booking.purge_guest_data(integer, integer);
DROP FUNCTION booking.release_completed_stays();
DROP FUNCTION booking.release_claim_if_safe(uuid, text);
DROP FUNCTION booking.claim_release_blockers(uuid);

CREATE FUNCTION booking.purge_guest_data(p_now timestamptz, p_failed_attempt_days integer, p_post_checkout_days integer)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
DECLARE n integer;
BEGIN
  IF p_now IS NULL OR p_failed_attempt_days IS NULL OR p_post_checkout_days IS NULL
     OR p_failed_attempt_days NOT BETWEEN 1 AND 3650 OR p_post_checkout_days NOT BETWEEN 1 AND 3650 THEN
    RAISE EXCEPTION 'invalid retention parameters' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  DELETE FROM booking.intent_guests g
   USING booking.intents i
   WHERE i.id = g.intent_id
     AND NOT EXISTS (SELECT 1 FROM booking.reconciliation_cases c WHERE c.intent_id = i.id AND c.status = 'open')
     AND (
          -- no booking was made
          (i.state IN ('validation_failed', 'expired', 'payment_failed', 'payment_expired', 'authorization_released', 'cancelled')
           AND i.updated_at + make_interval(days => p_failed_attempt_days) <= p_now)
          -- booking made: keep until the configured period after check-out
       OR (i.state = 'confirmed'
           AND (i.to_date + p_post_checkout_days)::timestamp AT TIME ZONE 'UTC' <= p_now)
     );
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

CREATE FUNCTION booking.claim_release_blockers(p_intent uuid, p_at timestamptz) RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
DECLARE s text; td date; out text[] := '{}'; r record;
BEGIN
  SELECT state, to_date INTO s, td FROM booking.intents WHERE id = p_intent;
  IF s IS NULL THEN RETURN ARRAY['INTENT_NOT_FOUND']; END IF;
  IF s = 'confirmed' THEN
    -- a confirmed booking keeps its nights until check-out day in Mexico City (O5, provisional)
    IF td <= (p_at AT TIME ZONE 'America/Mexico_City')::date THEN RETURN '{}'; END IF;
    RETURN ARRAY['STAY_NOT_COMPLETED'];
  END IF;
  IF s NOT IN ('validation_failed', 'expired', 'payment_failed', 'payment_expired', 'authorization_released', 'cancelled') THEN
    RETURN ARRAY['STATE_NOT_RELEASABLE:' || s];
  END IF;
  FOR r IN SELECT id, status FROM booking.payment_attempts WHERE intent_id = p_intent AND status IN ('creating', 'open', 'outcome_unknown') LOOP
    out := out || ('PAYMENT_ATTEMPT_UNRESOLVED:' || r.status);
  END LOOP;
  out := out || booking.authorization_blockers(p_intent) || booking.reservation_blockers(p_intent);
  FOR r IN SELECT op_type, state FROM booking.external_operations
            WHERE intent_id = p_intent AND state IN ('pending', 'in_flight', 'outcome_unknown', 'escalated')
              AND op_type IN ('stripe.create_checkout_session', 'stripe.capture_payment_intent', 'stripe.void_payment_intent',
                              'hostaway.create_reservation', 'hostaway.cancel_reservation', 'hostaway.record_offline_charge') LOOP
    out := out || ('PROVIDER_OPERATION_UNRESOLVED:' || r.op_type || ':' || r.state);
  END LOOP;
  FOR r IN SELECT kind FROM booking.reconciliation_cases WHERE intent_id = p_intent AND status = 'open' LOOP
    out := out || ('OPEN_CASE:' || r.kind);
  END LOOP;
  RETURN out;
END $$;

CREATE OR REPLACE FUNCTION booking.claims_safety_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b text[]; s text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT booking.is_privileged() THEN
      SELECT state INTO s FROM booking.intents WHERE id = NEW.intent_id;
      IF s IS DISTINCT FROM 'details_collected' THEN
        RAISE EXCEPTION 'a claim is taken only at the Pay step (intent state %)', s USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF NEW.kind <> 'checkout' AND NOT booking.is_privileged() THEN
      RAISE EXCEPTION 'new claims start as checkout' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT booking.is_privileged() THEN
    RAISE EXCEPTION 'claims change only through controlled functions' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.released_at IS NOT NULL AND OLD.released_at IS NULL THEN
    b := booking.claim_release_blockers(NEW.intent_id, NEW.released_at);
    IF cardinality(b) > 0 THEN
      RAISE EXCEPTION 'CLAIM_RELEASE_BLOCKED: %', array_to_string(b, ', ') USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF (OLD.kind = 'reserved' AND NEW.kind <> 'reserved') OR (OLD.kind = 'authorized' AND NEW.kind = 'checkout') THEN
    RAISE EXCEPTION 'claim kind only moves forward' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION booking.release_claim_if_safe(p_intent uuid, p_reason text, p_at timestamptz) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
DECLARE b text[];
BEGIN
  IF NOT booking.is_code(p_reason) THEN RAISE EXCEPTION 'reason must be a code' USING ERRCODE = 'invalid_parameter_value'; END IF;
  IF NOT EXISTS (SELECT 1 FROM booking.inventory_claims WHERE intent_id = p_intent AND released_at IS NULL) THEN RETURN false; END IF;
  b := booking.claim_release_blockers(p_intent, p_at);
  IF cardinality(b) > 0 THEN
    UPDATE booking.inventory_claims SET review_after = LEAST(review_after, p_at) WHERE intent_id = p_intent AND released_at IS NULL;
    RETURN false;
  END IF;
  UPDATE booking.inventory_claims SET released_at = p_at, release_reason = p_reason WHERE intent_id = p_intent AND released_at IS NULL;
  RETURN true;
END $$;

CREATE FUNCTION booking.release_completed_stays(p_at timestamptz) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
DECLARE n integer;
BEGIN
  UPDATE booking.inventory_claims c SET released_at = p_at, release_reason = 'STAY_COMPLETED'
    FROM booking.intents i
   WHERE i.id = c.intent_id AND c.released_at IS NULL AND i.state = 'confirmed'
     AND i.to_date <= (p_at AT TIME ZONE 'America/Mexico_City')::date;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

CREATE OR REPLACE FUNCTION booking.validate_evidence(p_kind text, p_status text, p_observed jsonb) RETURNS void LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF p_kind = 'checkout_session' AND p_status NOT IN ('open', 'complete', 'expired') THEN
    RAISE EXCEPTION 'invalid checkout_session status %', p_status USING ERRCODE = 'check_violation';
  ELSIF p_kind = 'payment_intent' AND p_status NOT IN ('requires_payment_method', 'requires_confirmation', 'requires_action',
        'processing', 'requires_capture', 'canceled', 'succeeded') THEN
    RAISE EXCEPTION 'invalid payment_intent status %', p_status USING ERRCODE = 'check_violation';
  ELSIF p_kind = 'hostaway_reservation' THEN
    IF p_status NOT IN ('found_active', 'cancelled', 'not_found') THEN
      RAISE EXCEPTION 'invalid hostaway_reservation status %', p_status USING ERRCODE = 'check_violation';
    END IF;
    IF p_status = 'found_active' AND NOT (p_observed ? 'listingId' AND p_observed ? 'from' AND p_observed ? 'to' AND p_observed ? 'totalMinor') THEN
      RAISE EXCEPTION 'found_active evidence must include listingId, from, to, totalMinor' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF p_kind = 'hostaway_offline_charges' THEN
    IF p_status <> 'listed' OR jsonb_typeof(p_observed -> 'matchingChargeCount') IS DISTINCT FROM 'number'
       OR (p_observed ->> 'matchingChargeCount')::numeric < 0
       OR jsonb_typeof(p_observed -> 'matchingChargeIds') IS DISTINCT FROM 'array'
       OR jsonb_array_length(p_observed -> 'matchingChargeIds') <> (p_observed ->> 'matchingChargeCount')::integer THEN
      RAISE EXCEPTION 'offline charge evidence must be status listed with matchingChargeCount and matchingChargeIds' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION booking.payment_attempts_safety_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM booking.inventory_claims WHERE intent_id = NEW.intent_id AND released_at IS NULL) THEN
      RAISE EXCEPTION 'CLAIM_REQUIRED: checkout preparation requires an active date claim' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
  IF NEW.status IN ('expired', 'failed') AND (NEW.checkout_session_id IS NULL OR NOT EXISTS (
       SELECT 1 FROM booking.provider_evidence WHERE intent_id = NEW.intent_id AND kind = 'checkout_session'
          AND external_ref = NEW.checkout_session_id AND status = 'expired')) THEN
    RAISE EXCEPTION 'CHECKOUT_EXPIRY_NOT_VERIFIED' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'completed' AND NEW.payment_intent_id IS NULL THEN
    RAISE EXCEPTION 'completed attempt needs its PaymentIntent' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'not_created' AND NOT EXISTS (
       SELECT 1 FROM booking.external_operations WHERE intent_id = NEW.intent_id AND op_type = 'stripe.create_checkout_session'
          AND payload ->> 'paymentAttemptId' = NEW.id::text AND state = 'superseded' AND dispatched_at IS NULL) THEN
    RAISE EXCEPTION 'not_created requires a create operation that was never dispatched' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION booking.admin_resolve_operation(p_op uuid, p_decision text, p_evidence uuid[], p_result_ref text,
  p_resolver text, p_justification text, p_at timestamptz) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
DECLARE op booking.external_operations%ROWTYPE; i booking.intents%ROWTYPE; res_id uuid := gen_random_uuid();
        settle timestamptz; rid text; pi text; ok boolean := false;
BEGIN
  SELECT * INTO op FROM booking.external_operations WHERE id = p_op FOR UPDATE;
  IF NOT FOUND OR op.state NOT IN ('outcome_unknown', 'escalated') THEN RAISE EXCEPTION 'NOT_RESOLVABLE' USING ERRCODE = 'check_violation'; END IF;
  IF p_decision NOT IN ('succeeded', 'failed_definite') THEN RAISE EXCEPTION 'invalid decision' USING ERRCODE = 'invalid_parameter_value'; END IF;
  SELECT * INTO i FROM booking.intents WHERE id = op.intent_id;
  PERFORM booking.cited_evidence(op.intent_id, p_evidence);
  settle := coalesce(op.dispatched_at, op.created_at) + interval '15 minutes'; -- evidence must post-date the call by a settle period
  rid := op.payload ->> 'reservationId';
  pi := op.payload ->> 'paymentIntentId';

  IF op.op_type = 'hostaway.record_offline_charge' THEN
    IF p_decision = 'succeeded' THEN
      ok := EXISTS (SELECT 1 FROM booking.cited_evidence(op.intent_id, p_evidence) e
                     WHERE e.kind = 'hostaway_offline_charges' AND e.external_ref = rid AND e.observed_at >= settle
                       AND (e.observed ->> 'matchingChargeCount')::int = 1 AND e.observed -> 'matchingChargeIds' ->> 0 = p_result_ref);
    ELSE
      -- absence must be shown TWICE, independently: an API read and an owner dashboard check, both after the settle period
      ok := EXISTS (SELECT 1 FROM booking.cited_evidence(op.intent_id, p_evidence) e
                     WHERE e.kind = 'hostaway_offline_charges' AND e.source = 'hostaway_api' AND e.external_ref = rid
                       AND e.observed_at >= settle AND (e.observed ->> 'matchingChargeCount')::int = 0)
        AND EXISTS (SELECT 1 FROM booking.cited_evidence(op.intent_id, p_evidence) e
                     WHERE e.kind = 'hostaway_offline_charges' AND e.source = 'hostaway_dashboard' AND e.external_ref = rid
                       AND e.observed_at >= settle AND (e.observed ->> 'matchingChargeCount')::int = 0);
    END IF;
  ELSIF op.op_type = 'hostaway.create_reservation' THEN
    IF p_decision = 'failed_definite' THEN
      RAISE EXCEPTION 'NOT_PERMITTED_UNTIL_E4: absence of a reservation is not proof that the create failed' USING ERRCODE = 'check_violation';
    END IF;
    ok := EXISTS (SELECT 1 FROM booking.cited_evidence(op.intent_id, p_evidence) e
                   WHERE e.kind = 'hostaway_reservation' AND e.status = 'found_active' AND e.external_ref = p_result_ref
                     AND (e.observed ->> 'listingId')::int = i.listing_id AND e.observed ->> 'from' = to_char(i.from_date, 'YYYY-MM-DD')
                     AND e.observed ->> 'to' = to_char(i.to_date, 'YYYY-MM-DD') AND (e.observed ->> 'totalMinor')::bigint = i.final_total_minor);
  ELSIF op.op_type = 'hostaway.cancel_reservation' THEN
    ok := EXISTS (SELECT 1 FROM booking.cited_evidence(op.intent_id, p_evidence) e
                   WHERE e.kind = 'hostaway_reservation' AND e.external_ref = rid AND e.observed_at >= coalesce(op.dispatched_at, op.created_at)
                     AND e.status = CASE p_decision WHEN 'succeeded' THEN 'cancelled' ELSE 'found_active' END);
  ELSIF op.op_type IN ('stripe.capture_payment_intent', 'stripe.void_payment_intent') THEN
    ok := EXISTS (SELECT 1 FROM booking.cited_evidence(op.intent_id, p_evidence) e
                   WHERE e.kind = 'payment_intent' AND e.external_ref = pi AND e.observed_at >= coalesce(op.dispatched_at, op.created_at)
                     AND CASE
                       WHEN op.op_type = 'stripe.capture_payment_intent' AND p_decision = 'succeeded'
                         THEN e.status = 'succeeded' AND (e.observed ->> 'amountReceivedMinor')::bigint = i.final_total_minor
                       WHEN op.op_type = 'stripe.capture_payment_intent'
                         THEN e.status IN ('requires_capture', 'canceled', 'requires_payment_method')
                       WHEN p_decision = 'succeeded' THEN e.status = 'canceled'
                       ELSE e.status IN ('requires_capture', 'succeeded') END);
  ELSE
    RAISE EXCEPTION 'NOT_SUPPORTED for %', op.op_type USING ERRCODE = 'feature_not_supported';
  END IF;
  IF NOT ok THEN RAISE EXCEPTION 'INSUFFICIENT_EVIDENCE for % %', op.op_type, p_decision USING ERRCODE = 'check_violation'; END IF;

  INSERT INTO booking.reconciliation_resolutions (id, intent_id, decision, operation_id, evidence_ids, result_ref, resolver,
     justification_code, resolver_session_user, decided_at)
  VALUES (res_id, op.intent_id, CASE p_decision WHEN 'succeeded' THEN 'operation_succeeded' ELSE 'operation_failed' END, op.id,
     p_evidence, p_result_ref, p_resolver, p_justification, session_user, p_at);
  UPDATE booking.external_operations SET state = p_decision, result_ref = p_result_ref, completed_at = p_at, resolution_id = res_id,
         lease_worker_id = NULL, lease_until = NULL, updated_at = p_at WHERE id = op.id;
  UPDATE booking.reconciliation_cases SET status = 'resolved', resolution = CASE p_decision WHEN 'succeeded' THEN 'recorded' ELSE 'no_action' END,
         resolved_by = p_resolver, resolved_at = p_at
   WHERE intent_id = op.intent_id AND opened_by = 'op:' || op.id::text AND status = 'open';
  RETURN res_id;
END $$;

CREATE OR REPLACE FUNCTION booking.settle_operation_from_evidence(p_op uuid, p_evidence uuid) RETURNS text
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

REVOKE ALL ON FUNCTION booking.purge_guest_data(timestamptz, integer, integer), booking.claim_release_blockers(uuid, timestamptz),
  booking.release_claim_if_safe(uuid, text, timestamptz), booking.release_completed_stays(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION booking.purge_guest_data(timestamptz, integer, integer), booking.claim_release_blockers(uuid, timestamptz),
  booking.release_claim_if_safe(uuid, text, timestamptz), booking.release_completed_stays(timestamptz) TO mv_booking_app;
GRANT EXECUTE ON FUNCTION booking.claim_release_blockers(uuid, timestamptz) TO mv_booking_admin;
