-- 0019_test_cleanup_refund_settlement (down) — restores the 0018 schema exactly: functions = their last accepted bodies (0003 / 0005 / 0010 / 0011 / 0017),
-- constraints / index / vocabulary = their prior definitions. Fails (by design) if any row already uses the 0019 vocabulary.
DROP TRIGGER zy_recording_retirement_fence ON booking.external_operations;
DROP FUNCTION booking.recording_retirement_fence();
DROP TRIGGER external_operations_refund_claim_fence ON booking.external_operations;

CREATE OR REPLACE FUNCTION booking.void_cancel_claim_fence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
DECLARE s text; auth_settled boolean; res_cancelled boolean; pi text; rid text;
BEGIN
  SELECT state, settlement_authorization_settled, settlement_reservation_cancelled, stripe_payment_intent_id, hostaway_reservation_id
    INTO s, auth_settled, res_cancelled, pi, rid FROM booking.intents WHERE id = NEW.intent_id FOR SHARE;
  IF NEW.op_type = 'stripe.void_payment_intent' THEN
    IF NOT (s = 'reservation_failed' OR (s = 'capture_failed' AND auth_settled IS FALSE))
       OR pi IS NULL OR (NEW.payload ->> 'paymentIntentId') IS DISTINCT FROM pi
       OR booking.authorization_settled_for(NEW.intent_id, pi) THEN
      RAISE EXCEPTION 'VOID_CLAIM_FENCED: the authorization leg of this intent is not open for a void'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF s IS DISTINCT FROM 'capture_failed' OR res_cancelled IS NOT FALSE
       OR rid IS NULL OR (NEW.payload ->> 'reservationId') IS DISTINCT FROM rid THEN
      RAISE EXCEPTION 'CANCEL_CLAIM_FENCED: the reservation leg of this intent is not open for a cancel'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP FUNCTION booking.refund_claim_fence();

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
     WHERE intent_id = NEW.id AND status = 'open'
       AND NOT starts_with(kind, 'OFFLINE_CHARGE_HOLD_');   -- 0011: owner-hold cases stay open (bound to their holds)
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION booking.claim_release_blockers(p_intent uuid) RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
DECLARE s text; td date; out text[] := '{}'; r record;
BEGIN
  SELECT state, to_date INTO s, td FROM booking.intents WHERE id = p_intent;
  IF s IS NULL THEN RETURN ARRAY['INTENT_NOT_FOUND']; END IF;
  IF s = 'confirmed' THEN
    -- a confirmed booking keeps its nights until check-out day in Mexico City (O5, provisional), by the DATABASE clock
    IF td <= (statement_timestamp() AT TIME ZONE 'America/Mexico_City')::date THEN RETURN '{}'; END IF;
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
                              'hostaway.create_reservation', 'hostaway.cancel_reservation', 'hostaway.record_offline_charge')
              -- 0017: the ONE exception. In state 'cancelled' only, a capture row that was never handed to a sender
              -- (pending, attempts 0, dispatched_at NULL, both lease fields NULL) does not block the release. 0007
              -- capture_claim_fence admits a capture claim only while the intent is reservation_confirmed; no reducer path
              -- returns a cancelled intent there (test/db/e7-claim-release-0017.test.mjs Q6/Q7). The row is kept, unchanged.
              AND NOT (s = 'cancelled' AND op_type = 'stripe.capture_payment_intent' AND state = 'pending' AND attempts = 0
                       AND dispatched_at IS NULL AND lease_worker_id IS NULL AND lease_until IS NULL) LOOP
    out := out || ('PROVIDER_OPERATION_UNRESOLVED:' || r.op_type || ':' || r.state);
  END LOOP;
  FOR r IN SELECT kind FROM booking.reconciliation_cases WHERE intent_id = p_intent AND status = 'open' LOOP
    out := out || ('OPEN_CASE:' || r.kind);
  END LOOP;
  RETURN out;
END $$;

CREATE OR REPLACE FUNCTION booking.authorization_blockers(p_intent uuid) RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
DECLARE pi text; st text; out text[] := '{}';
BEGIN
  FOR pi IN
    SELECT DISTINCT x FROM (
      SELECT stripe_payment_intent_id AS x FROM booking.intents WHERE id = p_intent
      UNION SELECT payment_intent_id FROM booking.payment_attempts WHERE intent_id = p_intent
      UNION SELECT provider_ref FROM booking.payment_ledger
             WHERE intent_id = p_intent AND provider = 'stripe' AND entry IN ('authorization_accepted', 'authorization_rejected')
    ) s WHERE x IS NOT NULL
  LOOP
    CONTINUE WHEN EXISTS (SELECT 1 FROM booking.payment_ledger WHERE provider = 'stripe' AND entry = 'authorization_voided' AND provider_ref = pi);
    SELECT status INTO st FROM booking.provider_evidence
     WHERE intent_id = p_intent AND kind = 'payment_intent' AND external_ref = pi ORDER BY observed_at DESC, created_at DESC LIMIT 1;
    IF st IS NULL OR st NOT IN ('canceled', 'requires_payment_method') THEN
      out := out || ('AUTHORIZATION_UNSETTLED:' || pi);
    END IF;
  END LOOP;
  RETURN out;
END $$;

DROP FUNCTION booking.test_refund_ledgered(uuid, text);
DROP FUNCTION booking.test_refund_settled_for(uuid, text);

CREATE OR REPLACE FUNCTION booking.record_provider_evidence(p_read_op uuid, p_kind text, p_external_ref text, p_status text,
  p_observed jsonb, p_provider_request_id text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
DECLARE op booking.external_operations%ROWTYPE; want text; ident text; new_id uuid := gen_random_uuid();
BEGIN
  SELECT * INTO op FROM booking.external_operations WHERE id = p_read_op FOR UPDATE;
  IF NOT FOUND OR op.retry_class <> 'read' OR op.state <> 'succeeded' THEN
    RAISE EXCEPTION 'EVIDENCE_NEEDS_SUCCEEDED_READ' USING ERRCODE = 'check_violation';
  END IF;
  want := CASE p_kind WHEN 'checkout_session' THEN 'stripe.retrieve_checkout_session'
                      WHEN 'payment_intent' THEN 'stripe.retrieve_payment_intent'
                      WHEN 'hostaway_offline_charges' THEN 'hostaway.list_offline_charges'
                      WHEN 'hostaway_reservation' THEN op.op_type END;
  IF want IS NULL OR op.op_type <> want
     OR (p_kind = 'hostaway_reservation' AND op.op_type NOT IN ('hostaway.retrieve_reservation', 'hostaway.lookup_reservation')) THEN
    RAISE EXCEPTION 'EVIDENCE_KIND_DOES_NOT_MATCH_READ' USING ERRCODE = 'check_violation';
  END IF;
  ident := coalesce(op.payload ->> 'sessionId', op.payload ->> 'paymentIntentId', op.payload ->> 'reservationId');
  IF op.op_type = 'hostaway.lookup_reservation' THEN
    IF p_observed ->> 'bookingRef' IS DISTINCT FROM op.payload ->> 'ref' THEN
      RAISE EXCEPTION 'EVIDENCE_REF_MISMATCH' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF ident IS DISTINCT FROM p_external_ref THEN
    RAISE EXCEPTION 'EVIDENCE_REF_MISMATCH' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM booking.validate_evidence(p_kind, p_status, p_observed);
  INSERT INTO booking.provider_evidence (id, intent_id, kind, source, external_ref, status, observed, observed_at, read_operation_id,
     provider_request_id, recorded_by_role, recorded_session_user)
  VALUES (new_id, op.intent_id, p_kind, CASE WHEN p_kind IN ('checkout_session', 'payment_intent') THEN 'stripe_api' ELSE 'hostaway_api' END,
     p_external_ref, p_status, p_observed, op.completed_at, op.id, p_provider_request_id, current_user, session_user);
  -- 0010: AFTER the insert (whose FK already share-locks the intent row), serialise with link / completion. Lock order is then
  -- intent row -> advisory for every party (finalisation: intent row UPDATE -> advisory), so no cycle with finalisation.
  IF p_kind = 'hostaway_offline_charges' THEN
    PERFORM pg_advisory_xact_lock(hashtext('booking.recording_evidence'), hashtext(op.intent_id::text));
  END IF;
  RETURN new_id;
END $$;

CREATE OR REPLACE FUNCTION booking.validate_evidence(p_kind text, p_status text, p_observed jsonb) RETURNS void LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF p_kind = 'checkout_session' THEN
    IF p_status NOT IN ('open', 'complete', 'expired', 'none_found') THEN
      RAISE EXCEPTION 'invalid checkout_session status %', p_status USING ERRCODE = 'check_violation';
    END IF;
    IF p_status = 'none_found' AND (jsonb_typeof(p_observed -> 'matchingSessionCount') IS DISTINCT FROM 'number'
       OR (p_observed ->> 'matchingSessionCount')::numeric <> 0 OR NOT (p_observed ? 'paymentAttemptId')) THEN
      RAISE EXCEPTION 'none_found evidence must include paymentAttemptId and matchingSessionCount 0' USING ERRCODE = 'check_violation';
    END IF;
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

ALTER TABLE booking.payment_refunds DROP CONSTRAINT payment_refunds_hostaway_state_check;
ALTER TABLE booking.payment_refunds ADD CONSTRAINT payment_refunds_hostaway_state_check
  CHECK (hostaway_state IN ('pending', 'recorded', 'failed', 'outcome_unknown'));

ALTER TABLE booking.provider_evidence DROP CONSTRAINT provider_evidence_refund_api_only_check;
ALTER TABLE booking.provider_evidence DROP CONSTRAINT provider_evidence_kind_source_check;
ALTER TABLE booking.provider_evidence DROP CONSTRAINT provider_evidence_kind_check;
ALTER TABLE booking.provider_evidence ADD CONSTRAINT provider_evidence_kind_check
  CHECK (kind IN ('checkout_session', 'payment_intent', 'hostaway_reservation', 'hostaway_offline_charges'));
ALTER TABLE booking.provider_evidence ADD CONSTRAINT provider_evidence_check2
  CHECK ((kind IN ('checkout_session', 'payment_intent')) = (source IN ('stripe_api', 'stripe_dashboard')));

DROP INDEX booking.external_operations_one_refund_ever;
DROP INDEX booking.external_operations_one_open_provider_write;
CREATE UNIQUE INDEX external_operations_one_open_provider_write ON booking.external_operations
  (intent_id, op_type, (coalesce(payload ->> 'paymentIntentId', payload ->> 'reservationId')))
  WHERE op_type IN ('stripe.capture_payment_intent', 'stripe.void_payment_intent', 'hostaway.cancel_reservation')
    AND state IN ('pending', 'in_flight', 'outcome_unknown', 'escalated');
ALTER TABLE booking.external_operations DROP CONSTRAINT ops_provider_writes_reconcile_first;
ALTER TABLE booking.external_operations ADD CONSTRAINT ops_provider_writes_reconcile_first
  CHECK (op_type NOT IN ('stripe.create_checkout_session', 'stripe.capture_payment_intent', 'stripe.void_payment_intent',
                         'hostaway.cancel_reservation')
         OR retry_class = 'reconcile_first');
ALTER TABLE booking.external_operations DROP CONSTRAINT external_operations_op_type_check;
ALTER TABLE booking.external_operations ADD CONSTRAINT external_operations_op_type_check CHECK (op_type IN (
  'stripe.create_checkout_session', 'stripe.retrieve_checkout_session', 'stripe.retrieve_payment_intent',
  'stripe.capture_payment_intent', 'stripe.void_payment_intent',
  'hostaway.lookup_reservation', 'hostaway.retrieve_reservation', 'hostaway.list_offline_charges',
  'hostaway.create_reservation', 'hostaway.cancel_reservation', 'hostaway.record_offline_charge',
  'guest.notify', 'alert.owner'));

CREATE OR REPLACE FUNCTION booking.is_intent_state(s text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT s IN ('created','price_confirmed','details_collected','payment_pending','payment_authorized',
               'reservation_pending','reservation_unknown','reservation_confirmed','capture_unknown',
               'payment_captured','confirmed','validation_failed','expired','payment_failed',
               'payment_expired','reservation_failed','authorization_released','capture_failed',
               'cancelled','reconciliation_required') $$;
