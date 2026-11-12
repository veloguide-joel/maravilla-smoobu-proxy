-- 0019_test_cleanup_refund_settlement (up) — DISPOSABLE LOCAL test databases only. LOCAL MIGRATION CANDIDATE (ROOT review 5878146178, F1).
--
-- Problem (F1): booking.authorization_blockers (0003) settles a PaymentIntent for claim release ONLY through an authorization_voided ledger
-- entry or canceled / requires_payment_method PI evidence. A fully refunded CAPTURED TEST payment keeps PI status `succeeded`, so the claim
-- of a cancelled-after-capture TEST intent is never released (AUTHORIZATION_UNSETTLED:<pi>). Nothing may fake a void, canceled evidence or a
-- zero captured amount, and release_claim_if_safe is never bypassed.
--
-- Fix: ONE narrowly TEST-scoped, evidence-bound FULL-REFUND settlement predicate, booking.test_refund_settled_for(intent, pi), consulted by
-- (a) authorization_blockers (one extra CONTINUE WHEN, body otherwise byte-identical to 0003) and (b) intents_safety_guard for the
-- authorization leg flag and the new terminal transition test_cleanup_pending -> cancelled (0011 body otherwise verbatim). The predicate is
-- true only when ALL of these hold on this TEST database: instance + intent environment 'test'; the completed payment attempt for the PI is
-- livemode=false; the ONE capture row succeeded with a charge id; the ONE refund row (op type stripe.refund_payment_intent, payload bound to
-- the PI / charge / exact captured amount / currency / attempt 1 / key ref:<intent>:1) succeeded with result_ref = the refund id; a bound
-- `stripe_refund` evidence row (API read of exactly that refund id, observed AFTER the refund dispatch) shows status succeeded, the same PI,
-- charge, exact amount and currency; and the LATEST payment_intent evidence (observed after the dispatch) shows status succeeded, livemode
-- false, that charge captured, amount_received = captured amount, charge amount_refunded = captured amount (full). The payment_refunds row (seq 1, key
-- ref:<intent>:1, state succeeded, stripe_refund_id = the refund id) and the payment_ledger refund_succeeded entry are additionally required
-- for claim RELEASE (booking.test_refund_ledgered). Aggregates alone never identify the operation; pending / requires_action / failed /
-- canceled never settle. Non-TEST / void / capture_failed behaviour is unchanged.
--
-- Also here (all additive): intent state 'test_cleanup_pending'; op types stripe.refund_payment_intent / stripe.retrieve_refund; evidence
-- kind 'stripe_refund' (API read only — a dashboard refund is NOT closure, so admin_record_evidence is deliberately NOT extended);
-- payment_refunds.hostaway_state value 'not_applicable' (the pristine recording was retired: no Hostaway payment record exists to refund);
-- the refund write is reconcile_first / single-attempt / one open row per intent (existing constraints extended); refund claim fence
-- (claimable only while the intent is test_cleanup_pending with the authorization leg open); pristine-recording retirement fence (a
-- recording row may become superseded ONLY from a pristine row of an intent in test_cleanup_pending on a TEST instance);
-- claim_release_blockers (0017 body) also treats an unresolved refund row as a blocker.

-- ---------------------------------------------------------------------------------------------
-- 1. vocabulary (additive)
CREATE OR REPLACE FUNCTION booking.is_intent_state(s text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT s IN ('created','price_confirmed','details_collected','payment_pending','payment_authorized',
               'reservation_pending','reservation_unknown','reservation_confirmed','capture_unknown',
               'payment_captured','confirmed','validation_failed','expired','payment_failed',
               'payment_expired','reservation_failed','authorization_released','capture_failed',
               'cancelled','reconciliation_required','test_cleanup_pending') $$;

ALTER TABLE booking.external_operations DROP CONSTRAINT external_operations_op_type_check;
ALTER TABLE booking.external_operations ADD CONSTRAINT external_operations_op_type_check CHECK (op_type IN (
  'stripe.create_checkout_session', 'stripe.retrieve_checkout_session', 'stripe.retrieve_payment_intent',
  'stripe.capture_payment_intent', 'stripe.void_payment_intent',
  'hostaway.lookup_reservation', 'hostaway.retrieve_reservation', 'hostaway.list_offline_charges',
  'hostaway.create_reservation', 'hostaway.cancel_reservation', 'hostaway.record_offline_charge',
  'guest.notify', 'alert.owner',
  'stripe.refund_payment_intent', 'stripe.retrieve_refund'));
ALTER TABLE booking.external_operations DROP CONSTRAINT ops_provider_writes_reconcile_first;
ALTER TABLE booking.external_operations ADD CONSTRAINT ops_provider_writes_reconcile_first
  CHECK (op_type NOT IN ('stripe.create_checkout_session', 'stripe.capture_payment_intent', 'stripe.void_payment_intent',
                         'hostaway.cancel_reservation', 'stripe.refund_payment_intent')
         OR retry_class = 'reconcile_first');
DROP INDEX booking.external_operations_one_open_provider_write;
CREATE UNIQUE INDEX external_operations_one_open_provider_write ON booking.external_operations
  (intent_id, op_type, (coalesce(payload ->> 'paymentIntentId', payload ->> 'reservationId')))
  WHERE op_type IN ('stripe.capture_payment_intent', 'stripe.void_payment_intent', 'hostaway.cancel_reservation', 'stripe.refund_payment_intent')
    AND state IN ('pending', 'in_flight', 'outcome_unknown', 'escalated');
-- a refund row is created at most ONCE per intent, in any state (attempt 2 never exists; no same-key or new-key resend)
CREATE UNIQUE INDEX external_operations_one_refund_ever ON booking.external_operations (intent_id) WHERE op_type = 'stripe.refund_payment_intent';

-- provider_evidence: kind 'stripe_refund' (API source only). The two 0003 inline CHECKs (generated names provider_evidence_kind_check /
-- provider_evidence_check2) are replaced by named ones.
ALTER TABLE booking.provider_evidence DROP CONSTRAINT provider_evidence_kind_check;
ALTER TABLE booking.provider_evidence DROP CONSTRAINT provider_evidence_check2;
ALTER TABLE booking.provider_evidence ADD CONSTRAINT provider_evidence_kind_check
  CHECK (kind IN ('checkout_session', 'payment_intent', 'hostaway_reservation', 'hostaway_offline_charges', 'stripe_refund'));
ALTER TABLE booking.provider_evidence ADD CONSTRAINT provider_evidence_kind_source_check
  CHECK ((kind IN ('checkout_session', 'payment_intent', 'stripe_refund')) = (source IN ('stripe_api', 'stripe_dashboard')));
ALTER TABLE booking.provider_evidence ADD CONSTRAINT provider_evidence_refund_api_only_check
  CHECK (kind <> 'stripe_refund' OR source = 'stripe_api');

-- payment_refunds: the Hostaway payment record never existed (pristine recording retired) -> 'not_applicable'
ALTER TABLE booking.payment_refunds DROP CONSTRAINT payment_refunds_hostaway_state_check;
ALTER TABLE booking.payment_refunds ADD CONSTRAINT payment_refunds_hostaway_state_check
  CHECK (hostaway_state IN ('pending', 'recorded', 'failed', 'outcome_unknown', 'not_applicable'));

-- ---------------------------------------------------------------------------------------------
-- 2. evidence validation / recording (0005 / 0010 bodies + the stripe_refund branch)
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
  ELSIF p_kind = 'stripe_refund' THEN
    -- the Stripe Refund object: status vocabulary per https://docs.stripe.com/api/refunds/object ; identity + money fields are mandatory
    IF p_status NOT IN ('pending', 'requires_action', 'succeeded', 'failed', 'canceled') THEN
      RAISE EXCEPTION 'invalid stripe_refund status %', p_status USING ERRCODE = 'check_violation';
    END IF;
    IF jsonb_typeof(p_observed -> 'refundId') IS DISTINCT FROM 'string' OR jsonb_typeof(p_observed -> 'paymentIntentId') IS DISTINCT FROM 'string'
       OR jsonb_typeof(p_observed -> 'chargeId') IS DISTINCT FROM 'string' OR jsonb_typeof(p_observed -> 'amountMinor') IS DISTINCT FROM 'number'
       OR jsonb_typeof(p_observed -> 'currency') IS DISTINCT FROM 'string' OR (p_observed ->> 'amountMinor')::numeric <= 0
       OR (p_observed ->> 'refundId') !~ '^re_[A-Za-z0-9_]{1,200}$' THEN
      RAISE EXCEPTION 'stripe_refund evidence must include refundId, paymentIntentId, chargeId, amountMinor (>0), currency' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
END $$;

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
                      WHEN 'stripe_refund' THEN 'stripe.retrieve_refund'
                      WHEN 'hostaway_reservation' THEN op.op_type END;
  IF want IS NULL OR op.op_type <> want
     OR (p_kind = 'hostaway_reservation' AND op.op_type NOT IN ('hostaway.retrieve_reservation', 'hostaway.lookup_reservation')) THEN
    RAISE EXCEPTION 'EVIDENCE_KIND_DOES_NOT_MATCH_READ' USING ERRCODE = 'check_violation';
  END IF;
  ident := coalesce(op.payload ->> 'sessionId', op.payload ->> 'paymentIntentId', op.payload ->> 'reservationId', op.payload ->> 'refundId');
  IF op.op_type = 'hostaway.lookup_reservation' THEN
    IF p_observed ->> 'bookingRef' IS DISTINCT FROM op.payload ->> 'ref' THEN
      RAISE EXCEPTION 'EVIDENCE_REF_MISMATCH' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF ident IS DISTINCT FROM p_external_ref THEN
    RAISE EXCEPTION 'EVIDENCE_REF_MISMATCH' USING ERRCODE = 'check_violation';
  END IF;
  IF p_kind = 'stripe_refund' AND p_observed ->> 'refundId' IS DISTINCT FROM p_external_ref THEN
    RAISE EXCEPTION 'EVIDENCE_REF_MISMATCH' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM booking.validate_evidence(p_kind, p_status, p_observed);
  INSERT INTO booking.provider_evidence (id, intent_id, kind, source, external_ref, status, observed, observed_at, read_operation_id,
     provider_request_id, recorded_by_role, recorded_session_user)
  VALUES (new_id, op.intent_id, p_kind, CASE WHEN p_kind IN ('checkout_session', 'payment_intent', 'stripe_refund') THEN 'stripe_api' ELSE 'hostaway_api' END,
     p_external_ref, p_status, p_observed, op.completed_at, op.id, p_provider_request_id, current_user, session_user);
  IF p_kind = 'hostaway_offline_charges' THEN
    PERFORM pg_advisory_xact_lock(hashtext('booking.recording_evidence'), hashtext(op.intent_id::text));
  END IF;
  RETURN new_id;
END $$;

-- ---------------------------------------------------------------------------------------------
-- 3. the TEST-scoped full-refund settlement predicates (read-only)
CREATE FUNCTION booking.test_refund_settled_for(p_intent uuid, p_pi text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
DECLARE i record; cap record; rf record; ev record; pe record;
BEGIN
  IF p_pi IS NULL THEN RETURN false; END IF;
  IF (SELECT environment FROM booking.instance) IS DISTINCT FROM 'test' THEN RETURN false; END IF;
  SELECT id, environment, state, currency, captured_minor, stripe_payment_intent_id INTO i FROM booking.intents WHERE id = p_intent;
  IF NOT FOUND OR i.environment <> 'test' OR i.stripe_payment_intent_id IS DISTINCT FROM p_pi OR i.captured_minor IS NULL OR i.captured_minor <= 0 THEN RETURN false; END IF;
  IF i.state NOT IN ('test_cleanup_pending', 'cancelled') THEN RETURN false; END IF;
  -- exactly one completed TEST payment attempt for this PI
  IF (SELECT count(*) FROM booking.payment_attempts WHERE intent_id = p_intent AND payment_intent_id = p_pi) <> 1
     OR NOT EXISTS (SELECT 1 FROM booking.payment_attempts WHERE intent_id = p_intent AND payment_intent_id = p_pi AND status = 'completed' AND livemode = false) THEN
    RETURN false;
  END IF;
  -- the ONE capture row: succeeded, attempt 1, result_ref = the charge id
  IF (SELECT count(*) FROM booking.external_operations WHERE intent_id = p_intent AND op_type = 'stripe.capture_payment_intent') <> 1 THEN RETURN false; END IF;
  SELECT result_ref INTO cap FROM booking.external_operations WHERE intent_id = p_intent AND op_type = 'stripe.capture_payment_intent'
    AND state = 'succeeded' AND payload ->> 'paymentIntentId' = p_pi AND (payload ->> 'attempt') = '1' AND (payload ->> 'amountMinor')::bigint = i.captured_minor
    AND result_ref ~ '^(ch|py)_[A-Za-z0-9_]{1,200}$';
  IF NOT FOUND THEN RETURN false; END IF;
  -- the ONE refund row: succeeded, bound to the PI / charge / exact amount / currency / attempt 1 / key ref:<intent>:1, result_ref = refund id
  IF (SELECT count(*) FROM booking.external_operations WHERE intent_id = p_intent AND op_type = 'stripe.refund_payment_intent') <> 1 THEN RETURN false; END IF;
  SELECT result_ref, dispatched_at INTO rf FROM booking.external_operations WHERE intent_id = p_intent AND op_type = 'stripe.refund_payment_intent'
    AND state = 'succeeded' AND dispatched_at IS NOT NULL AND payload ->> 'paymentIntentId' = p_pi AND payload ->> 'chargeId' = cap.result_ref
    AND (payload ->> 'amountMinor')::bigint = i.captured_minor AND upper(payload ->> 'currency') = upper(i.currency) AND (payload ->> 'attempt') = '1'
    AND payload ->> 'providerIdempotencyKey' = 'ref:' || p_intent::text || ':1' AND result_ref ~ '^re_[A-Za-z0-9_]{1,200}$';
  IF NOT FOUND THEN RETURN false; END IF;
  -- bound Refund READ (API, after the dispatch): exactly this refund id, status succeeded, same PI / charge / exact amount / currency
  SELECT 1 INTO ev FROM booking.provider_evidence e
   WHERE e.intent_id = p_intent AND e.kind = 'stripe_refund' AND e.source = 'stripe_api' AND e.external_ref = rf.result_ref AND e.status = 'succeeded'
     AND e.observed_at >= rf.dispatched_at AND e.observed ->> 'refundId' = rf.result_ref AND e.observed ->> 'paymentIntentId' = p_pi
     AND e.observed ->> 'chargeId' = cap.result_ref AND (e.observed ->> 'amountMinor')::bigint = i.captured_minor AND upper(e.observed ->> 'currency') = upper(i.currency)
   ORDER BY e.observed_at DESC, e.created_at DESC LIMIT 1;
  IF NOT FOUND THEN RETURN false; END IF;
  -- any later Refund read of that id that is NOT succeeded contradicts (a refund can fail after pending)
  IF EXISTS (SELECT 1 FROM booking.provider_evidence e WHERE e.intent_id = p_intent AND e.kind = 'stripe_refund' AND e.external_ref = rf.result_ref AND e.status <> 'succeeded'
             AND e.observed_at >= (SELECT max(observed_at) FROM booking.provider_evidence WHERE intent_id = p_intent AND kind = 'stripe_refund' AND external_ref = rf.result_ref AND status = 'succeeded')) THEN
    RETURN false;
  END IF;
  -- the LATEST PaymentIntent read (API, after the dispatch): succeeded, livemode false, that charge, amount_received = captured, fully refunded
  SELECT status, observed, observed_at INTO pe FROM booking.provider_evidence
   WHERE intent_id = p_intent AND kind = 'payment_intent' AND source = 'stripe_api' AND external_ref = p_pi ORDER BY observed_at DESC, created_at DESC LIMIT 1;
  IF NOT FOUND OR pe.status <> 'succeeded' OR pe.observed_at < rf.dispatched_at THEN RETURN false; END IF;
  -- the accepted v3 observation shape (lib/checkout/recovery-plan.js paymentIntentProofObservation + capture-proof v3): the charge's
  -- amountRefundedMinor (Charge.amount_refunded) must equal the captured amount; a `refunded` flag, when present, must be true
  IF (pe.observed ->> 'livemode') IS DISTINCT FROM 'false' OR pe.observed -> 'latestCharge' ->> 'id' IS DISTINCT FROM cap.result_ref
     OR (pe.observed ->> 'amountReceivedMinor')::bigint IS DISTINCT FROM i.captured_minor
     OR (pe.observed -> 'latestCharge' ->> 'captured') IS DISTINCT FROM 'true'
     OR (pe.observed -> 'latestCharge' ->> 'amountCapturedMinor')::bigint IS DISTINCT FROM i.captured_minor
     OR (pe.observed -> 'latestCharge' ->> 'amountRefundedMinor')::bigint IS DISTINCT FROM i.captured_minor
     OR ((pe.observed -> 'latestCharge') ? 'refunded' AND (pe.observed -> 'latestCharge' ->> 'refunded') IS DISTINCT FROM 'true')
     OR (pe.observed -> 'latestCharge' ->> 'livemode') IS DISTINCT FROM 'false' THEN
    RETURN false;
  END IF;
  RETURN true;
END $$;

-- the audited money record for RELEASE: payment_refunds (seq 1, key ref:<intent>:1) succeeded with that refund id, and the ledger entry
CREATE FUNCTION booking.test_refund_ledgered(p_intent uuid, p_pi text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
DECLARE i record; rf text;
BEGIN
  IF NOT booking.test_refund_settled_for(p_intent, p_pi) THEN RETURN false; END IF;
  SELECT currency, captured_minor INTO i FROM booking.intents WHERE id = p_intent;
  SELECT result_ref INTO rf FROM booking.external_operations WHERE intent_id = p_intent AND op_type = 'stripe.refund_payment_intent' AND state = 'succeeded';
  IF (SELECT count(*) FROM booking.payment_refunds WHERE intent_id = p_intent) <> 1 THEN RETURN false; END IF;
  IF NOT EXISTS (SELECT 1 FROM booking.payment_refunds WHERE intent_id = p_intent AND seq = 1 AND state = 'succeeded' AND stripe_refund_id = rf
                   AND amount_minor = i.captured_minor AND currency = i.currency AND reason_code = 'TEST_CLEANUP' AND hostaway_state = 'not_applicable') THEN
    RETURN false;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM booking.payment_ledger WHERE intent_id = p_intent AND entry = 'refund_succeeded' AND provider = 'stripe' AND provider_ref = rf
                   AND amount_minor = i.captured_minor AND currency = i.currency) THEN
    RETURN false;
  END IF;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION booking.test_refund_settled_for(uuid, text), booking.test_refund_ledgered(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION booking.test_refund_settled_for(uuid, text), booking.test_refund_ledgered(uuid, text) TO mv_booking_app, mv_booking_admin;

-- ---------------------------------------------------------------------------------------------
-- 4. authorization_blockers (0003 body; ONE additional CONTINUE WHEN; everything else byte-identical)
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
    -- 0019: a CAPTURED TEST payment that is proven FULLY refunded (bound refund read + PI read + audited refund record + ledger)
    CONTINUE WHEN booking.test_refund_ledgered(p_intent, pi);
    SELECT status INTO st FROM booking.provider_evidence
     WHERE intent_id = p_intent AND kind = 'payment_intent' AND external_ref = pi ORDER BY observed_at DESC, created_at DESC LIMIT 1;
    IF st IS NULL OR st NOT IN ('canceled', 'requires_payment_method') THEN
      out := out || ('AUTHORIZATION_UNSETTLED:' || pi);
    END IF;
  END LOOP;
  RETURN out;
END $$;

-- ---------------------------------------------------------------------------------------------
-- 5. claim_release_blockers (0017 body; the refund write added to the unresolved-provider-operation list; otherwise byte-identical)
CREATE OR REPLACE FUNCTION booking.claim_release_blockers(p_intent uuid) RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
DECLARE s text; td date; out text[] := '{}'; r record;
BEGIN
  SELECT state, to_date INTO s, td FROM booking.intents WHERE id = p_intent;
  IF s IS NULL THEN RETURN ARRAY['INTENT_NOT_FOUND']; END IF;
  IF s = 'confirmed' THEN
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
                              'hostaway.create_reservation', 'hostaway.cancel_reservation', 'hostaway.record_offline_charge', 'stripe.refund_payment_intent')
              AND NOT (s = 'cancelled' AND op_type = 'stripe.capture_payment_intent' AND state = 'pending' AND attempts = 0
                       AND dispatched_at IS NULL AND lease_worker_id IS NULL AND lease_until IS NULL) LOOP
    out := out || ('PROVIDER_OPERATION_UNRESOLVED:' || r.op_type || ':' || r.state);
  END LOOP;
  FOR r IN SELECT kind FROM booking.reconciliation_cases WHERE intent_id = p_intent AND status = 'open' LOOP
    out := out || ('OPEN_CASE:' || r.kind);
  END LOOP;
  RETURN out;
END $$;

-- ---------------------------------------------------------------------------------------------
-- 6. intents_safety_guard (0011 body verbatim) + the TEST cleanup clauses:
--    (a) the authorization leg flag may also be set by the TEST refund settlement (only from test_cleanup_pending);
--    (b) test_cleanup_pending requires an active claim (C6);
--    (c) test_cleanup_pending -> cancelled needs BOTH legs AND the refund settlement (C5 analogue; the flags enforce each leg).
CREATE OR REPLACE FUNCTION booking.intents_safety_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
DECLARE r booking.reconciliation_resolutions%ROWTYPE; want text; sess text;
BEGIN
  IF NEW.settlement_reservation_cancelled IS TRUE AND OLD.settlement_reservation_cancelled IS NOT TRUE AND NOT (
       EXISTS (SELECT 1 FROM booking.external_operations
                WHERE intent_id = NEW.id AND op_type = 'hostaway.cancel_reservation' AND state = 'succeeded')
       AND EXISTS (SELECT 1 FROM booking.provider_evidence
                    WHERE intent_id = NEW.id AND kind = 'hostaway_reservation' AND external_ref = NEW.hostaway_reservation_id
                      AND status = 'cancelled')) THEN
    RAISE EXCEPTION 'CANCELLATION_NOT_VERIFIED' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.settlement_authorization_settled IS TRUE AND OLD.settlement_authorization_settled IS NOT TRUE
     AND NOT (booking.authorization_settled_for(NEW.id, NEW.stripe_payment_intent_id)
              OR (OLD.state = 'test_cleanup_pending' AND booking.test_refund_settled_for(NEW.id, NEW.stripe_payment_intent_id))) THEN
    RAISE EXCEPTION 'AUTHORIZATION_NOT_VERIFIED_SETTLED' USING ERRCODE = 'check_violation';
  END IF;
  IF (OLD.settlement_reservation_cancelled IS TRUE AND NEW.settlement_reservation_cancelled IS NOT TRUE)
     OR (OLD.settlement_authorization_settled IS TRUE AND NEW.settlement_authorization_settled IS NOT TRUE) THEN
    RAISE EXCEPTION 'settlement legs only move forward' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state IS NOT DISTINCT FROM OLD.state THEN RETURN NEW; END IF;

  IF NEW.state IN ('payment_pending', 'payment_authorized', 'reservation_pending', 'reservation_unknown', 'reservation_failed',
                   'reservation_confirmed', 'capture_unknown', 'capture_failed', 'payment_captured', 'confirmed', 'test_cleanup_pending')
     AND NOT EXISTS (SELECT 1 FROM booking.inventory_claims WHERE intent_id = NEW.id AND released_at IS NULL) THEN
    RAISE EXCEPTION 'CLAIM_REQUIRED: % requires an active date claim', NEW.state USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.state IN ('payment_failed', 'payment_expired') THEN
    sess := coalesce(NEW.checkout_session_id, OLD.checkout_session_id);
    IF sess IS NULL OR NOT EXISTS (SELECT 1 FROM booking.provider_evidence
                                    WHERE intent_id = NEW.id AND kind = 'checkout_session' AND external_ref = sess AND status = 'expired') THEN
      RAISE EXCEPTION 'CHECKOUT_EXPIRY_NOT_VERIFIED' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF OLD.state = 'reservation_failed' AND NEW.state = 'authorization_released'
     AND NOT booking.authorization_settled_for(NEW.id, NEW.stripe_payment_intent_id) THEN
    RAISE EXCEPTION 'VOID_NOT_VERIFIED' USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.state = 'capture_failed' AND NEW.state = 'cancelled'
     AND NOT (NEW.settlement_reservation_cancelled IS TRUE AND NEW.settlement_authorization_settled IS TRUE) THEN
    RAISE EXCEPTION 'CANCELLATION_NOT_VERIFIED' USING ERRCODE = 'check_violation';
  END IF;
  -- 0019: the TEST cleanup terminal: both legs flagged AND the refund settlement re-verified at this instant
  IF OLD.state = 'test_cleanup_pending' AND NEW.state = 'cancelled'
     AND NOT (NEW.settlement_reservation_cancelled IS TRUE AND NEW.settlement_authorization_settled IS TRUE
              AND booking.test_refund_settled_for(NEW.id, NEW.stripe_payment_intent_id)) THEN
    RAISE EXCEPTION 'CANCELLATION_NOT_VERIFIED' USING ERRCODE = 'check_violation';
  END IF;
  -- 0019: payment_captured leaves ONLY to confirmed / reconciliation_required (existing) or test_cleanup_pending on a TEST instance
  IF OLD.state = 'payment_captured' AND NEW.state = 'test_cleanup_pending'
     AND ((SELECT environment FROM booking.instance) IS DISTINCT FROM 'test' OR NEW.environment <> 'test' OR NEW.captured_minor IS NULL OR NEW.captured_minor <= 0) THEN
    RAISE EXCEPTION 'TEST_CLEANUP_NOT_TEST' USING ERRCODE = 'check_violation';
  END IF;

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
       AND NOT starts_with(kind, 'OFFLINE_CHARGE_HOLD_');
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------------------------
-- 7. fences on external_operations
-- 7c. void_cancel_claim_fence (0009 body; the cancel leg also open in test_cleanup_pending; otherwise byte-identical)
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
    -- 0019: the reservation leg of a TEST cleanup is open exactly like capture_failed's
    IF s NOT IN ('capture_failed', 'test_cleanup_pending') OR res_cancelled IS NOT FALSE
       OR rid IS NULL OR (NEW.payload ->> 'reservationId') IS DISTINCT FROM rid THEN
      RAISE EXCEPTION 'CANCEL_CLAIM_FENCED: the reservation leg of this intent is not open for a cancel'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
-- 7a. refund claim fence (0007 pattern): claimable only while the intent is test_cleanup_pending with the authorization leg OPEN, on TEST
CREATE FUNCTION booking.refund_claim_fence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
DECLARE s text; settled boolean; env text;
BEGIN
  SELECT state, settlement_authorization_settled, environment INTO s, settled, env FROM booking.intents WHERE id = NEW.intent_id FOR SHARE;
  IF s IS DISTINCT FROM 'test_cleanup_pending' OR settled IS NOT FALSE OR env IS DISTINCT FROM 'test'
     OR (SELECT environment FROM booking.instance) IS DISTINCT FROM 'test' OR (NEW.payload ->> 'attempt') IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'REFUND_CLAIM_FENCED: the refund row is not claimable in this state' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION booking.refund_claim_fence() FROM PUBLIC;
CREATE TRIGGER external_operations_refund_claim_fence BEFORE UPDATE ON booking.external_operations
  FOR EACH ROW WHEN (OLD.state = 'pending' AND NEW.state = 'in_flight' AND NEW.op_type = 'stripe.refund_payment_intent')
  EXECUTE FUNCTION booking.refund_claim_fence();
-- 7b. pristine-recording retirement fence: a recording row becomes superseded ONLY from a pristine row (pending / attempts 0 / never
--     dispatched / unleased) of an intent that is test_cleanup_pending, on a TEST instance (the TEST_CLEANUP_REQUESTED transaction)
CREATE FUNCTION booking.recording_retirement_fence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
DECLARE s text;
BEGIN
  SELECT state INTO s FROM booking.intents WHERE id = NEW.intent_id FOR SHARE;
  IF OLD.state <> 'pending' OR OLD.attempts <> 0 OR OLD.dispatched_at IS NOT NULL OR OLD.lease_worker_id IS NOT NULL OR OLD.lease_until IS NOT NULL
     OR OLD.late_result_status IS NOT NULL OR s IS DISTINCT FROM 'test_cleanup_pending' OR (SELECT environment FROM booking.instance) IS DISTINCT FROM 'test' THEN
    RAISE EXCEPTION 'RECORDING_RETIREMENT_FENCED: only a pristine recording of a test_cleanup_pending TEST intent may be retired' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION booking.recording_retirement_fence() FROM PUBLIC;
-- "zy_" fires before 0010's "zz0_" lifecycle guard (name order), which already forbids every other field change on this transition
CREATE TRIGGER zy_recording_retirement_fence BEFORE UPDATE ON booking.external_operations
  FOR EACH ROW WHEN (NEW.op_type = 'hostaway.record_offline_charge' AND NEW.state = 'superseded' AND OLD.state IS DISTINCT FROM 'superseded')
  EXECUTE FUNCTION booking.recording_retirement_fence();
