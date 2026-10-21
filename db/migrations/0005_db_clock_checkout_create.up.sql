-- 0005_db_clock_checkout_create — Stage E2B.2 (owner-authorized 2026-10-21). Final database corrections.
--
-- Finding A — database-controlled time for safety decisions
--   * claim release (completed stays, safe release, release blockers) and guest-data purge decide "now" with
--     PostgreSQL's own clock (statement_timestamp()). The caller-supplied timestamp parameters are REMOVED: the old
--     signatures are dropped, so no role can ask the database to act "as of" a future date.
--   * a released claim's released_at is always stamped by the database (claims trigger), whoever issues the UPDATE.
--   * intent_transitions.recorded_at is always stamped by the database; the failed-attempt retention period is
--     measured from the database-stamped time the intent entered its final state, not from the caller's updated_at.
--
-- Finding B — an uncertain Stripe Checkout Session create is reconciled before anything else is sent
--   * stripe.create_checkout_session becomes "reconcile_first": one attempt per row; an interrupted, timed-out or
--     lease-expired create becomes outcome_unknown and is NEVER re-queued (no reliance on Stripe's 24-hour
--     idempotency-key retention).
--   * at most one OPEN create per intent, and at most one unresolved payment attempt per intent.
--   * a payment attempt becomes 'open' only for the session id that a SUCCEEDED create returned.
--   * an unknown create is settled only from evidence: runtime, by an API read of a KNOWN session id that is bound to
--     this payment attempt; otherwise by the owner (manual until E5 confirms a Stripe lookup for unknown ids).
--
-- Applies to a database with no E2B-era Checkout create rows (no hosted database exists yet).

-- ---------------------------------------------------------------------------------------------
-- A1. Database-stamped audit time for intent transitions.
CREATE FUNCTION booking.intent_transitions_stamp() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.recorded_at := statement_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER intent_transitions_stamp BEFORE INSERT ON booking.intent_transitions
  FOR EACH ROW EXECUTE FUNCTION booking.intent_transitions_stamp();

-- ---------------------------------------------------------------------------------------------
-- A2. Claim release on the database clock. Old (caller-time) signatures are removed.
DROP FUNCTION booking.release_completed_stays(timestamptz);
DROP FUNCTION booking.release_claim_if_safe(uuid, text, timestamptz);
DROP FUNCTION booking.claim_release_blockers(uuid, timestamptz);

CREATE FUNCTION booking.claim_release_blockers(p_intent uuid) RETURNS text[]
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
                              'hostaway.create_reservation', 'hostaway.cancel_reservation', 'hostaway.record_offline_charge') LOOP
    out := out || ('PROVIDER_OPERATION_UNRESOLVED:' || r.op_type || ':' || r.state);
  END LOOP;
  FOR r IN SELECT kind FROM booking.reconciliation_cases WHERE intent_id = p_intent AND status = 'open' LOOP
    out := out || ('OPEN_CASE:' || r.kind);
  END LOOP;
  RETURN out;
END $$;

-- Whoever releases a claim (runtime function, owner function or a direct UPDATE by the schema owner), the release
-- time is the database's and every blocker is re-checked against the database clock.
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
    NEW.released_at := NULL; NEW.release_reason := NULL;  -- a claim is born active
    RETURN NEW;
  END IF;
  IF NOT booking.is_privileged() THEN
    RAISE EXCEPTION 'claims change only through controlled functions' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.released_at IS NOT NULL AND OLD.released_at IS NULL THEN
    NEW.released_at := statement_timestamp();
    b := booking.claim_release_blockers(NEW.intent_id);
    IF cardinality(b) > 0 THEN
      RAISE EXCEPTION 'CLAIM_RELEASE_BLOCKED: %', array_to_string(b, ', ') USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF (OLD.kind = 'reserved' AND NEW.kind <> 'reserved') OR (OLD.kind = 'authorized' AND NEW.kind = 'checkout') THEN
    RAISE EXCEPTION 'claim kind only moves forward' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION booking.release_claim_if_safe(p_intent uuid, p_reason text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
DECLARE b text[];
BEGIN
  IF NOT booking.is_code(p_reason) THEN RAISE EXCEPTION 'reason must be a code' USING ERRCODE = 'invalid_parameter_value'; END IF;
  IF NOT EXISTS (SELECT 1 FROM booking.inventory_claims WHERE intent_id = p_intent AND released_at IS NULL) THEN RETURN false; END IF;
  b := booking.claim_release_blockers(p_intent);
  IF cardinality(b) > 0 THEN
    UPDATE booking.inventory_claims SET review_after = LEAST(review_after, statement_timestamp())
     WHERE intent_id = p_intent AND released_at IS NULL;
    RETURN false;
  END IF;
  UPDATE booking.inventory_claims SET released_at = statement_timestamp(), release_reason = p_reason
   WHERE intent_id = p_intent AND released_at IS NULL;
  RETURN true;
END $$;

CREATE FUNCTION booking.release_completed_stays() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
DECLARE n integer;
BEGIN
  UPDATE booking.inventory_claims c SET released_at = statement_timestamp(), release_reason = 'STAY_COMPLETED'
    FROM booking.intents i
   WHERE i.id = c.intent_id AND c.released_at IS NULL AND i.state = 'confirmed'
     AND i.to_date <= (statement_timestamp() AT TIME ZONE 'America/Mexico_City')::date;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- ---------------------------------------------------------------------------------------------
-- A3. Guest-data purge on the database clock. Retention periods stay configurable (O6, provisional); the time does not.
DROP FUNCTION booking.purge_guest_data(timestamptz, integer, integer);
CREATE FUNCTION booking.purge_guest_data(p_failed_attempt_days integer, p_post_checkout_days integer)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
DECLARE n integer;
BEGIN
  IF p_failed_attempt_days IS NULL OR p_post_checkout_days IS NULL
     OR p_failed_attempt_days NOT BETWEEN 1 AND 3650 OR p_post_checkout_days NOT BETWEEN 1 AND 3650 THEN
    RAISE EXCEPTION 'invalid retention parameters' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  DELETE FROM booking.intent_guests g
   USING booking.intents i
   WHERE i.id = g.intent_id
     AND NOT EXISTS (SELECT 1 FROM booking.reconciliation_cases c WHERE c.intent_id = i.id AND c.status = 'open')
     AND (
          -- no booking was made: measured from the database-stamped time of the intent's last transition
          (i.state IN ('validation_failed', 'expired', 'payment_failed', 'payment_expired', 'authorization_released', 'cancelled')
           AND (SELECT max(t.recorded_at) FROM booking.intent_transitions t WHERE t.intent_id = i.id)
               + make_interval(days => p_failed_attempt_days) <= statement_timestamp())
          -- booking made: keep until the configured period after check-out
       OR (i.state = 'confirmed'
           AND (i.to_date + p_post_checkout_days)::timestamp AT TIME ZONE 'UTC' <= statement_timestamp())
     );
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- ---------------------------------------------------------------------------------------------
-- B1. Checkout Session create is reconcile-first; one open create and one unresolved payment attempt per intent.
ALTER TABLE booking.external_operations DROP CONSTRAINT ops_provider_writes_reconcile_first;
ALTER TABLE booking.external_operations ADD CONSTRAINT ops_provider_writes_reconcile_first
  CHECK (op_type NOT IN ('stripe.create_checkout_session', 'stripe.capture_payment_intent', 'stripe.void_payment_intent',
                         'hostaway.cancel_reservation')
         OR retry_class = 'reconcile_first');
CREATE UNIQUE INDEX external_operations_one_open_checkout_create ON booking.external_operations (intent_id)
  WHERE op_type = 'stripe.create_checkout_session' AND state IN ('pending', 'in_flight', 'outcome_unknown', 'escalated');
CREATE UNIQUE INDEX payment_attempts_one_unresolved ON booking.payment_attempts (intent_id)
  WHERE status IN ('creating', 'open', 'outcome_unknown');

-- B2. Checkout Session evidence. 'none_found' = an owner dashboard search for sessions of one payment attempt found
--     none (external_ref = the payment attempt id). No API lookup by attempt exists yet (E5).
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

-- B3. Payment attempts: 'open' only for the session a SUCCEEDED create returned; 'not_created' also after a create
--     settled as definitely not applied.
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
  IF NEW.status = 'open' AND (NEW.checkout_session_id IS NULL OR NOT EXISTS (
       SELECT 1 FROM booking.external_operations WHERE intent_id = NEW.intent_id AND op_type = 'stripe.create_checkout_session'
          AND payload ->> 'paymentAttemptId' = NEW.id::text AND state = 'succeeded' AND result_ref = NEW.checkout_session_id)) THEN
    RAISE EXCEPTION 'CHECKOUT_CREATE_NOT_VERIFIED: an attempt opens only for the session a succeeded create returned' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'not_created' AND NOT EXISTS (
       SELECT 1 FROM booking.external_operations WHERE intent_id = NEW.intent_id AND op_type = 'stripe.create_checkout_session'
          AND payload ->> 'paymentAttemptId' = NEW.id::text
          AND ((state = 'superseded' AND dispatched_at IS NULL) OR state = 'failed_definite')) THEN
    RAISE EXCEPTION 'not_created requires a create operation that was never dispatched or was settled as not applied' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- B4. Runtime settlement from an authoritative read now also covers an ambiguous Checkout Session create, but only
--     for a KNOWN session id whose read shows it belongs to this payment attempt. A read can show a session EXISTS;
--     nothing a runtime read returns proves a create did NOT apply, so "not applied" is never settled here.
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
  IF op.op_type = 'stripe.create_checkout_session' THEN
    IF e.kind <> 'checkout_session' OR e.status NOT IN ('open', 'complete', 'expired') THEN
      RAISE EXCEPTION 'EVIDENCE_INCONCLUSIVE' USING ERRCODE = 'check_violation';
    END IF;
    IF e.observed ->> 'paymentAttemptId' IS DISTINCT FROM op.payload ->> 'paymentAttemptId' THEN
      RAISE EXCEPTION 'EVIDENCE_REF_MISMATCH' USING ERRCODE = 'check_violation';
    END IF;
    decision := 'succeeded';   -- the session exists: the create applied
  ELSIF op.op_type IN ('stripe.capture_payment_intent', 'stripe.void_payment_intent') THEN
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
  -- the case opened for an unknown Checkout create is settled by the same evidence
  UPDATE booking.reconciliation_cases SET status = 'resolved', resolution = 'recorded', resolved_by = 'reconciler', resolved_at = e.observed_at
   WHERE intent_id = op.intent_id AND opened_by = 'op:' || op.id::text AND status = 'open';
  RETURN decision;
END $$;

-- B5. Owner settlement of an ambiguous Checkout Session create (manual until E5):
--   succeeded       : cites Checkout Session evidence (API or dashboard) for p_result_ref bound to this payment attempt
--   failed_definite : "no session was created" — only after the expires_at we sent to Stripe has passed by the
--                     DATABASE clock (plus 15 minutes), citing an owner dashboard search for this payment attempt,
--                     observed after that time, that found no session.
CREATE OR REPLACE FUNCTION booking.admin_resolve_operation(p_op uuid, p_decision text, p_evidence uuid[], p_result_ref text,
  p_resolver text, p_justification text, p_at timestamptz) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
DECLARE op booking.external_operations%ROWTYPE; i booking.intents%ROWTYPE; res_id uuid := gen_random_uuid();
        settle timestamptz; rid text; pi text; ok boolean := false; aid text; planned timestamptz;
BEGIN
  SELECT * INTO op FROM booking.external_operations WHERE id = p_op FOR UPDATE;
  IF NOT FOUND OR op.state NOT IN ('outcome_unknown', 'escalated') THEN RAISE EXCEPTION 'NOT_RESOLVABLE' USING ERRCODE = 'check_violation'; END IF;
  IF p_decision NOT IN ('succeeded', 'failed_definite') THEN RAISE EXCEPTION 'invalid decision' USING ERRCODE = 'invalid_parameter_value'; END IF;
  SELECT * INTO i FROM booking.intents WHERE id = op.intent_id;
  PERFORM booking.cited_evidence(op.intent_id, p_evidence);
  settle := coalesce(op.dispatched_at, op.created_at) + interval '15 minutes'; -- evidence must post-date the call by a settle period
  rid := op.payload ->> 'reservationId';
  pi := op.payload ->> 'paymentIntentId';

  IF op.op_type = 'stripe.create_checkout_session' THEN
    aid := op.payload ->> 'paymentAttemptId';
    planned := (op.payload ->> 'expiresAt')::timestamptz;
    IF p_decision = 'succeeded' THEN
      ok := p_result_ref IS NOT NULL AND EXISTS (SELECT 1 FROM booking.cited_evidence(op.intent_id, p_evidence) e
                     WHERE e.kind = 'checkout_session' AND e.external_ref = p_result_ref AND e.status IN ('open', 'complete', 'expired')
                       AND e.observed ->> 'paymentAttemptId' = aid);
    ELSE
      IF statement_timestamp() < planned + interval '15 minutes' THEN
        RAISE EXCEPTION 'TOO_EARLY: a session from this create could still be payable until %', planned USING ERRCODE = 'check_violation';
      END IF;
      ok := EXISTS (SELECT 1 FROM booking.cited_evidence(op.intent_id, p_evidence) e
                     WHERE e.kind = 'checkout_session' AND e.source = 'stripe_dashboard' AND e.observed_at >= planned
                       AND e.status = 'none_found' AND e.external_ref = aid AND e.observed ->> 'paymentAttemptId' = aid);
      -- a session that WAS found (even expired) is settled as 'succeeded' with its id, then expired by its own evidence
    END IF;
  ELSIF op.op_type = 'hostaway.record_offline_charge' THEN
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
         error_code = CASE WHEN p_decision = 'failed_definite' AND op.op_type = 'stripe.create_checkout_session'
                           THEN 'RECONCILED_NOT_APPLIED' ELSE error_code END,
         lease_worker_id = NULL, lease_until = NULL, updated_at = p_at WHERE id = op.id;
  IF op.op_type = 'stripe.create_checkout_session' AND p_decision = 'failed_definite' THEN
    UPDATE booking.payment_attempts SET status = 'not_created', updated_at = p_at
     WHERE id = aid::uuid AND status IN ('creating', 'outcome_unknown');
  END IF;
  UPDATE booking.reconciliation_cases SET status = 'resolved', resolution = CASE p_decision WHEN 'succeeded' THEN 'recorded' ELSE 'no_action' END,
         resolved_by = p_resolver, resolved_at = p_at
   WHERE intent_id = op.intent_id AND opened_by = 'op:' || op.id::text AND status = 'open';
  RETURN res_id;
END $$;

-- ---------------------------------------------------------------------------------------------
-- Privileges for the new signatures (PUBLIC has none; default privileges already revoke it).
REVOKE ALL ON FUNCTION booking.claim_release_blockers(uuid), booking.release_claim_if_safe(uuid, text),
  booking.release_completed_stays(), booking.purge_guest_data(integer, integer), booking.intent_transitions_stamp() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION booking.claim_release_blockers(uuid), booking.release_claim_if_safe(uuid, text),
  booking.release_completed_stays(), booking.purge_guest_data(integer, integer) TO mv_booking_app;
GRANT EXECUTE ON FUNCTION booking.claim_release_blockers(uuid) TO mv_booking_admin;
GRANT EXECUTE ON FUNCTION booking.intent_transitions_stamp() TO mv_booking_app, mv_booking_admin;
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA booking FROM %I', r);
    END IF;
  END LOOP;
END $$;
