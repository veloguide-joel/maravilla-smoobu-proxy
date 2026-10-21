-- 0003_safety_corrections — Stage E2B.1 (owner-authorized 2026-10-21). Corrections C1–C7 from
-- claude/review-e2b-acceptance-2026-10-21.md. Applied migrations 0001/0002 are not edited.
--
-- Principles
--   * Provider outcomes are settled only by PERSISTED EVIDENCE (booking.provider_evidence), never by booleans.
--   * Owner-only decisions go through SECURITY DEFINER admin functions granted to mv_booking_admin only, and are
--     recorded in booking.reconciliation_resolutions with the evidence ids they relied on.
--   * The runtime role keeps ordinary write access, but triggers refuse every state change that would settle an
--     uncertain outcome or release dates without the required evidence, whoever issues the SQL.
--   * Trust boundary (cannot be enforced in SQL): the database cannot check that a provider response recorded by
--     the runtime (an operation result or an API evidence row) is genuine. See db/README.md.

-- ---------------------------------------------------------------------------------------------
-- Context helper: true only inside functions owned by the schema owner (SECURITY DEFINER) or for the owner itself.
CREATE FUNCTION booking.is_privileged() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT current_user::text = (SELECT pg_get_userbyid(nspowner)::text FROM pg_namespace WHERE nspname = 'booking')
$$;

-- ---------------------------------------------------------------------------------------------
-- Admin role (NOLOGIN, no password). The owner grants it to an admin login out of band.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mv_booking_admin') THEN
    CREATE ROLE mv_booking_admin NOLOGIN NOINHERIT NOBYPASSRLS;
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------
-- New read operation types (evidence is gathered through recorded read operations).
ALTER TABLE booking.external_operations DROP CONSTRAINT external_operations_op_type_check;
ALTER TABLE booking.external_operations ADD CONSTRAINT external_operations_op_type_check CHECK (op_type IN (
  'stripe.create_checkout_session', 'stripe.retrieve_checkout_session', 'stripe.retrieve_payment_intent',
  'stripe.capture_payment_intent', 'stripe.void_payment_intent',
  'hostaway.lookup_reservation', 'hostaway.retrieve_reservation', 'hostaway.list_offline_charges',
  'hostaway.create_reservation', 'hostaway.cancel_reservation', 'hostaway.record_offline_charge',
  'guest.notify', 'alert.owner'));

-- C1: catalogue of provider responses that are DEFINITE refusals of a non-idempotent write. Empty until E4 has
-- established them (owner-approved migration). Until then every non-success of a non-idempotent write is
-- outcome_unknown and can only be settled by an owner resolution with evidence.
CREATE TABLE booking.definite_refusal_codes (
  op_type  text NOT NULL CHECK (op_type IN ('hostaway.create_reservation', 'hostaway.record_offline_charge')),
  code     text NOT NULL CHECK (booking.is_code(code)),
  note     text NOT NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (op_type, code)
);

-- ---------------------------------------------------------------------------------------------
-- C4: durable provider evidence (append-only). API evidence must come from a SUCCEEDED read operation of the
-- matching type; dashboard evidence can only be recorded by the admin role, with attestation and a reference.
CREATE TABLE booking.provider_evidence (
  id                    uuid PRIMARY KEY,
  intent_id             uuid NOT NULL REFERENCES booking.intents (id),
  kind                  text NOT NULL CHECK (kind IN ('checkout_session', 'payment_intent', 'hostaway_reservation', 'hostaway_offline_charges')),
  source                text NOT NULL CHECK (source IN ('stripe_api', 'hostaway_api', 'stripe_dashboard', 'hostaway_dashboard')),
  external_ref          text NOT NULL CHECK (length(external_ref) BETWEEN 1 AND 200),
  status                text NOT NULL CHECK (status ~ '^[a-z_]{1,40}$'),
  observed              jsonb NOT NULL CHECK (jsonb_typeof(observed) = 'object'),   -- ids, amounts, statuses only
  observed_at           timestamptz NOT NULL,
  read_operation_id     uuid UNIQUE REFERENCES booking.external_operations (id),
  provider_request_id   text CHECK (provider_request_id IS NULL OR length(provider_request_id) BETWEEN 1 AND 200),
  attested_by           text CHECK (attested_by IS NULL OR length(attested_by) BETWEEN 1 AND 200),
  reference             text CHECK (reference IS NULL OR length(reference) BETWEEN 1 AND 500),
  recorded_by_role      text NOT NULL,
  recorded_session_user text NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CHECK ((source IN ('stripe_api', 'hostaway_api')) = (read_operation_id IS NOT NULL)),
  CHECK (source IN ('stripe_api', 'hostaway_api') OR (attested_by IS NOT NULL AND reference IS NOT NULL)),
  CHECK ((kind IN ('checkout_session', 'payment_intent')) = (source IN ('stripe_api', 'stripe_dashboard')))
);
CREATE INDEX provider_evidence_lookup ON booking.provider_evidence (intent_id, kind, external_ref, observed_at DESC);
CREATE TRIGGER provider_evidence_append_only BEFORE UPDATE OR DELETE ON booking.provider_evidence
  FOR EACH ROW EXECUTE FUNCTION booking.reject_change();
CREATE TRIGGER provider_evidence_no_truncate BEFORE TRUNCATE ON booking.provider_evidence
  FOR EACH STATEMENT EXECUTE FUNCTION booking.reject_change();

CREATE FUNCTION booking.validate_evidence(p_kind text, p_status text, p_observed jsonb) RETURNS void LANGUAGE plpgsql IMMUTABLE AS $$
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

-- ---------------------------------------------------------------------------------------------
-- C4: owner reconciliation decisions, each citing the evidence it relied on. Append-only except one-time consumption.
CREATE TABLE booking.reconciliation_resolutions (
  id                    uuid PRIMARY KEY,
  intent_id             uuid NOT NULL REFERENCES booking.intents (id),
  decision              text NOT NULL CHECK (decision IN ('operation_succeeded', 'operation_failed', 'intent_confirmed',
                          'intent_released', 'intent_cancelled', 'case_closed')),
  operation_id          uuid REFERENCES booking.external_operations (id),
  case_id               uuid REFERENCES booking.reconciliation_cases (id),
  evidence_ids          uuid[] NOT NULL CHECK (cardinality(evidence_ids) >= 1),
  result_ref            text,
  resolver              text NOT NULL CHECK (length(btrim(resolver)) BETWEEN 1 AND 200),
  justification_code    text NOT NULL CHECK (booking.is_code(justification_code)),
  resolver_session_user text NOT NULL,
  decided_at            timestamptz NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  consumed_at           timestamptz,
  consumed_version      integer,
  CHECK ((decision IN ('operation_succeeded', 'operation_failed')) = (operation_id IS NOT NULL)),
  CHECK ((decision = 'case_closed') = (case_id IS NOT NULL))
);
CREATE FUNCTION booking.resolutions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'resolutions cannot be deleted' USING ERRCODE = 'restrict_violation'; END IF;
  IF NOT booking.is_privileged() THEN
    RAISE EXCEPTION 'resolutions are written only through owner functions' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'UPDATE' AND (OLD.consumed_at IS NOT NULL
     OR (to_jsonb(NEW) - 'consumed_at' - 'consumed_version') <> (to_jsonb(OLD) - 'consumed_at' - 'consumed_version')) THEN
    RAISE EXCEPTION 'a resolution is immutable and can be consumed once' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER resolutions_guard BEFORE INSERT OR UPDATE OR DELETE ON booking.reconciliation_resolutions
  FOR EACH ROW EXECUTE FUNCTION booking.resolutions_guard();

ALTER TABLE booking.external_operations ADD COLUMN resolution_id uuid REFERENCES booking.reconciliation_resolutions (id);

-- ---------------------------------------------------------------------------------------------
-- Settlement checks (read-only). Each returns the list of reasons that something is still unresolved.

-- Every PaymentIntent ever associated with the intent must be voided (ledger, from a succeeded void) or verified
-- by evidence as holding no funds (canceled / requires_payment_method). A captured PaymentIntent is NOT settled
-- for release purposes (money taken -> refund path).
CREATE FUNCTION booking.authorization_blockers(p_intent uuid) RETURNS text[]
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

-- Every reservation that may exist must be verified cancelled. A Hostaway create that was dispatched is settled
-- only by a catalogued definite refusal, or by a found reservation that is then verified cancelled.
-- "not_found" evidence never counts (R1, until E4).
CREATE FUNCTION booking.reservation_blockers(p_intent uuid) RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
DECLARE a booking.hostaway_reservation_attempts%ROWTYPE; has_attempt boolean; rid text; st text; out text[] := '{}';
BEGIN
  SELECT * INTO a FROM booking.hostaway_reservation_attempts WHERE intent_id = p_intent;
  has_attempt := FOUND;
  FOR rid IN
    SELECT DISTINCT x FROM (
      SELECT hostaway_reservation_id AS x FROM booking.intents WHERE id = p_intent
      UNION SELECT hostaway_reservation_id FROM booking.hostaway_reservation_attempts WHERE intent_id = p_intent
      UNION SELECT external_ref FROM booking.provider_evidence WHERE intent_id = p_intent AND kind = 'hostaway_reservation' AND status = 'found_active'
    ) s WHERE x IS NOT NULL
  LOOP
    SELECT status INTO st FROM booking.provider_evidence
     WHERE intent_id = p_intent AND kind = 'hostaway_reservation' AND external_ref = rid AND status <> 'not_found'
     ORDER BY observed_at DESC, created_at DESC LIMIT 1;
    IF st IS DISTINCT FROM 'cancelled' THEN out := out || ('RESERVATION_NOT_VERIFIED_CANCELLED:' || rid); END IF;
  END LOOP;
  IF has_attempt AND a.state <> 'refused' AND cardinality(out) = 0
     AND NOT EXISTS (SELECT 1 FROM booking.provider_evidence WHERE intent_id = p_intent AND kind = 'hostaway_reservation' AND status = 'cancelled') THEN
    out := out || 'RESERVATION_OUTCOME_UNRESOLVED'::text;
  END IF;
  RETURN out;
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

-- ---------------------------------------------------------------------------------------------
-- C2 / C6 / C7: claims. The runtime role loses UPDATE on claims; every claim change goes through the functions
-- below. Release re-checks every blocker in the trigger, so even the owner cannot release unsafely.
CREATE FUNCTION booking.claims_safety_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER claims_safety_guard BEFORE INSERT OR UPDATE ON booking.inventory_claims
  FOR EACH ROW EXECUTE FUNCTION booking.claims_safety_guard();

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

CREATE FUNCTION booking.claim_upgrade(p_intent uuid, p_kind text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
DECLARE i booking.intents%ROWTYPE;
BEGIN
  SELECT * INTO i FROM booking.intents WHERE id = p_intent;
  IF p_kind = 'authorized' AND i.stripe_payment_intent_id IS NULL THEN
    RAISE EXCEPTION 'no accepted authorization' USING ERRCODE = 'check_violation';
  ELSIF p_kind = 'reserved' AND i.hostaway_reservation_id IS NULL THEN
    RAISE EXCEPTION 'no recorded reservation' USING ERRCODE = 'check_violation';
  ELSIF p_kind NOT IN ('authorized', 'reserved') THEN
    RAISE EXCEPTION 'invalid kind' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE booking.inventory_claims SET kind = p_kind
   WHERE intent_id = p_intent AND released_at IS NULL AND kind <> p_kind AND NOT (kind = 'reserved' AND p_kind = 'authorized');
END $$;

-- review scheduling only (never a release); returns the new review count
CREATE FUNCTION booking.claim_schedule_review(p_intent uuid, p_review_after timestamptz, p_count_review boolean) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
DECLARE n integer;
BEGIN
  UPDATE booking.inventory_claims SET review_after = p_review_after, review_count = review_count + CASE WHEN p_count_review THEN 1 ELSE 0 END
   WHERE intent_id = p_intent AND released_at IS NULL RETURNING review_count INTO n;
  RETURN n;
END $$;

-- ---------------------------------------------------------------------------------------------
-- C3 / C4 / C5 / C6: intent transitions that depend on verified facts. SECURITY DEFINER so it can consume a
-- resolution and close cases; its checks do not depend on who issued the UPDATE.
CREATE FUNCTION booking.intents_safety_guard() RETURNS trigger
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
CREATE TRIGGER intents_safety_guard BEFORE UPDATE ON booking.intents
  FOR EACH ROW EXECUTE FUNCTION booking.intents_safety_guard();

-- ---------------------------------------------------------------------------------------------
-- C3 / C6: payment attempts. Creating one needs this intent's active claim; final statuses need evidence.
CREATE FUNCTION booking.payment_attempts_safety_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER payment_attempts_safety_guard BEFORE INSERT OR UPDATE ON booking.payment_attempts
  FOR EACH ROW EXECUTE FUNCTION booking.payment_attempts_safety_guard();

-- Hostaway attempts: "refused" only for a catalogued definite refusal.
CREATE FUNCTION booking.hostaway_attempts_safety_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state = 'refused' AND OLD.state <> 'refused' AND NOT EXISTS (
       SELECT 1 FROM booking.external_operations o JOIN booking.definite_refusal_codes d ON d.op_type = o.op_type AND d.code = o.error_code
        WHERE o.id = NEW.operation_id AND o.state = 'failed_definite') THEN
    RAISE EXCEPTION 'REFUSAL_NOT_CATALOGUED: a reservation create is refused only by a catalogued definite response' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state IN ('succeeded', 'reconciled_found') AND NEW.hostaway_reservation_id IS NULL THEN
    RAISE EXCEPTION 'a found reservation needs its id' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hostaway_attempts_safety_guard BEFORE UPDATE ON booking.hostaway_reservation_attempts
  FOR EACH ROW EXECUTE FUNCTION booking.hostaway_attempts_safety_guard();

-- C1 / C7: operations. Uncertain outcomes are settled only by owner resolutions; a non-idempotent write fails
-- "definitely" only by catalogue; a new payment recording needs every earlier one verified as failed.
CREATE FUNCTION booking.external_operations_safety_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER external_operations_safety_guard BEFORE INSERT OR UPDATE ON booking.external_operations
  FOR EACH ROW EXECUTE FUNCTION booking.external_operations_safety_guard();

-- Reconciliation cases: the runtime role may open cases but never resolve them.
CREATE FUNCTION booking.cases_safety_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT booking.is_privileged() THEN
    RAISE EXCEPTION 'cases are resolved only through owner functions' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cases_safety_guard BEFORE UPDATE ON booking.reconciliation_cases
  FOR EACH ROW EXECUTE FUNCTION booking.cases_safety_guard();

-- ---------------------------------------------------------------------------------------------
-- Runtime evidence: recorded from a SUCCEEDED read operation of the matching type (audit: which read, when, who).
CREATE FUNCTION booking.record_provider_evidence(p_read_op uuid, p_kind text, p_external_ref text, p_status text,
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
  RETURN new_id;
END $$;

-- Owner evidence from a provider dashboard: attested, with an external reference (report id, screenshot id, ...).
CREATE FUNCTION booking.admin_record_evidence(p_intent uuid, p_kind text, p_external_ref text, p_status text, p_observed jsonb,
  p_observed_at timestamptz, p_attested_by text, p_reference text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
DECLARE new_id uuid := gen_random_uuid();
BEGIN
  PERFORM booking.validate_evidence(p_kind, p_status, p_observed);
  INSERT INTO booking.provider_evidence (id, intent_id, kind, source, external_ref, status, observed, observed_at,
     attested_by, reference, recorded_by_role, recorded_session_user)
  VALUES (new_id, p_intent, p_kind, CASE WHEN p_kind IN ('checkout_session', 'payment_intent') THEN 'stripe_dashboard' ELSE 'hostaway_dashboard' END,
     p_external_ref, p_status, p_observed, p_observed_at, p_attested_by, p_reference, current_user, session_user);
  RETURN new_id;
END $$;

-- helper: the cited evidence must belong to the intent; returns the rows
CREATE FUNCTION booking.cited_evidence(p_intent uuid, p_ids uuid[]) RETURNS SETOF booking.provider_evidence
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
BEGIN
  IF p_ids IS NULL OR cardinality(p_ids) = 0 THEN RAISE EXCEPTION 'EVIDENCE_REQUIRED' USING ERRCODE = 'check_violation'; END IF;
  IF (SELECT count(*) FROM booking.provider_evidence WHERE id = ANY (p_ids) AND intent_id = p_intent) <> cardinality(p_ids) THEN
    RAISE EXCEPTION 'EVIDENCE_NOT_FOR_THIS_INTENT' USING ERRCODE = 'check_violation';
  END IF;
  RETURN QUERY SELECT * FROM booking.provider_evidence WHERE id = ANY (p_ids);
END $$;

-- C1 / C4: owner settlement of an uncertain provider operation.
CREATE FUNCTION booking.admin_resolve_operation(p_op uuid, p_decision text, p_evidence uuid[], p_result_ref text,
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

-- C4: owner decision on an intent in reconciliation_required. The intent transition itself is then applied
-- through E3 RESOLVE, which the intents trigger accepts only against this unconsumed resolution.
CREATE FUNCTION booking.admin_resolve_intent(p_intent uuid, p_decision text, p_evidence uuid[], p_result_ref text,
  p_resolver text, p_justification text, p_at timestamptz) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
DECLARE i booking.intents%ROWTYPE; res_id uuid := gen_random_uuid(); b text[]; pi text; st text;
BEGIN
  SELECT * INTO i FROM booking.intents WHERE id = p_intent FOR UPDATE;
  IF NOT FOUND OR i.state <> 'reconciliation_required' THEN RAISE EXCEPTION 'NOT_IN_RECONCILIATION' USING ERRCODE = 'check_violation'; END IF;
  PERFORM booking.cited_evidence(p_intent, p_evidence);
  IF p_decision = 'released' THEN
    b := booking.authorization_blockers(p_intent) || booking.reservation_blockers(p_intent);
    IF cardinality(b) > 0 THEN RAISE EXCEPTION 'INSUFFICIENT_EVIDENCE: %', array_to_string(b, ', ') USING ERRCODE = 'check_violation'; END IF;
  ELSIF p_decision = 'cancelled' THEN
    IF i.hostaway_reservation_id IS NULL THEN RAISE EXCEPTION 'NO_RESERVATION_TO_CANCEL' USING ERRCODE = 'check_violation'; END IF;
    b := booking.authorization_blockers(p_intent) || booking.reservation_blockers(p_intent);
    IF cardinality(b) > 0 THEN RAISE EXCEPTION 'INSUFFICIENT_EVIDENCE: %', array_to_string(b, ', ') USING ERRCODE = 'check_violation'; END IF;
  ELSIF p_decision = 'confirmed' THEN
    IF NOT EXISTS (SELECT 1 FROM booking.cited_evidence(p_intent, p_evidence) e
                    WHERE e.kind = 'hostaway_reservation' AND e.status = 'found_active' AND e.external_ref = p_result_ref
                      AND (e.observed ->> 'listingId')::int = i.listing_id AND e.observed ->> 'from' = to_char(i.from_date, 'YYYY-MM-DD')
                      AND e.observed ->> 'to' = to_char(i.to_date, 'YYYY-MM-DD') AND (e.observed ->> 'totalMinor')::bigint = i.final_total_minor)
       OR NOT EXISTS (SELECT 1 FROM booking.cited_evidence(p_intent, p_evidence) e
                       WHERE e.kind = 'payment_intent' AND e.status = 'succeeded'
                         AND (e.observed ->> 'amountReceivedMinor')::bigint = i.final_total_minor) THEN
      RAISE EXCEPTION 'INSUFFICIENT_EVIDENCE: confirmed needs a matching active reservation and a captured payment of the exact amount'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    RAISE EXCEPTION 'invalid decision' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  INSERT INTO booking.reconciliation_resolutions (id, intent_id, decision, evidence_ids, result_ref, resolver, justification_code,
     resolver_session_user, decided_at)
  VALUES (res_id, p_intent, 'intent_' || p_decision, p_evidence, p_result_ref, p_resolver, p_justification, session_user, p_at);
  RETURN res_id;
END $$;

-- C4: owner closes a case (e.g. CLAIM_UNRESOLVED) citing evidence. Closing a case settles nothing else: every other
-- release blocker is still checked when a claim is released.
CREATE FUNCTION booking.admin_close_case(p_case uuid, p_evidence uuid[], p_resolver text, p_justification text, p_at timestamptz) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
DECLARE c booking.reconciliation_cases%ROWTYPE; res_id uuid := gen_random_uuid();
BEGIN
  SELECT * INTO c FROM booking.reconciliation_cases WHERE id = p_case FOR UPDATE;
  IF NOT FOUND OR c.status <> 'open' THEN RAISE EXCEPTION 'CASE_NOT_OPEN' USING ERRCODE = 'check_violation'; END IF;
  IF c.opened_by LIKE 'op:%' THEN
    RAISE EXCEPTION 'OPERATION_CASE_USE_ADMIN_RESOLVE_OPERATION' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM booking.cited_evidence(c.intent_id, p_evidence);
  INSERT INTO booking.reconciliation_resolutions (id, intent_id, decision, case_id, evidence_ids, resolver, justification_code,
     resolver_session_user, decided_at)
  VALUES (res_id, c.intent_id, 'case_closed', c.id, p_evidence, p_resolver, p_justification, session_user, p_at);
  UPDATE booking.reconciliation_cases SET status = 'resolved', resolution = 'no_action', resolved_by = p_resolver, resolved_at = p_at
   WHERE id = c.id;
  RETURN res_id;
END $$;

-- C6: an owner-confirmed booking (e.g. late authorization on a closed intent) must hold its nights again.
CREATE FUNCTION booking.admin_acquire_claim(p_intent uuid, p_at timestamptz) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
DECLARE i booking.intents%ROWTYPE;
BEGIN
  SELECT * INTO i FROM booking.intents WHERE id = p_intent;
  IF i.state <> 'reconciliation_required' THEN RAISE EXCEPTION 'NOT_IN_RECONCILIATION' USING ERRCODE = 'check_violation'; END IF;
  INSERT INTO booking.inventory_claims (intent_id, listing_id, stay, kind, claimed_at, review_after)
  VALUES (p_intent, i.listing_id, i.stay, 'reserved', p_at, p_at + interval '1 day'); -- exclusion constraint still applies
END $$;

-- ---------------------------------------------------------------------------------------------
-- C7: privileges
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA booking FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA booking REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- runtime role: no direct claim or case updates
REVOKE UPDATE ON booking.inventory_claims, booking.reconciliation_cases FROM mv_booking_app;
GRANT SELECT ON booking.provider_evidence, booking.reconciliation_resolutions, booking.definite_refusal_codes TO mv_booking_app;
GRANT EXECUTE ON FUNCTION
  booking.is_code(text), booking.is_intent_state(text), booking.is_terminal_state(text), booking.is_privileged(),
  booking.purge_guest_data(timestamptz, integer, integer),
  booking.claim_release_blockers(uuid, timestamptz), booking.authorization_blockers(uuid), booking.reservation_blockers(uuid),
  booking.release_claim_if_safe(uuid, text, timestamptz), booking.release_completed_stays(timestamptz),
  booking.claim_upgrade(uuid, text), booking.claim_schedule_review(uuid, timestamptz, boolean),
  booking.record_provider_evidence(uuid, text, text, text, jsonb, text), booking.validate_evidence(text, text, jsonb)
  TO mv_booking_app;
-- trigger functions run as the invoking role and need EXECUTE
GRANT EXECUTE ON FUNCTION booking.reject_change(), booking.intents_guard(), booking.claims_guard(), booking.claims_safety_guard(),
  booking.payment_attempts_guard(), booking.payment_attempts_safety_guard(), booking.external_operations_guard(),
  booking.external_operations_safety_guard(), booking.hostaway_attempts_guard(), booking.hostaway_attempts_safety_guard(),
  booking.payment_refunds_guard(), booking.stripe_events_guard(), booking.cases_safety_guard(), booking.resolutions_guard(),
  booking.intents_safety_guard()
  TO mv_booking_app, mv_booking_admin;

-- admin role: read everything except guest personal data; owner decisions only through functions
GRANT USAGE ON SCHEMA booking TO mv_booking_admin;
GRANT SELECT ON booking.instance, booking.intents, booking.intent_transitions, booking.intent_applied_events, booking.intent_work,
  booking.inventory_claims, booking.payment_attempts, booking.external_operations, booking.hostaway_reservation_attempts,
  booking.payment_ledger, booking.payment_refunds, booking.reconciliation_cases, booking.stripe_webhook_events,
  booking.provider_evidence, booking.reconciliation_resolutions, booking.definite_refusal_codes
  TO mv_booking_admin;
GRANT EXECUTE ON FUNCTION
  booking.is_code(text), booking.is_intent_state(text), booking.is_terminal_state(text), booking.is_privileged(),
  booking.claim_release_blockers(uuid, timestamptz), booking.authorization_blockers(uuid), booking.reservation_blockers(uuid),
  booking.admin_record_evidence(uuid, text, text, text, jsonb, timestamptz, text, text),
  booking.admin_resolve_operation(uuid, text, uuid[], text, text, text, timestamptz),
  booking.admin_resolve_intent(uuid, text, uuid[], text, text, text, timestamptz),
  booking.admin_acquire_claim(uuid, timestamptz), booking.validate_evidence(text, text, jsonb),
  booking.admin_close_case(uuid, uuid[], text, text, timestamptz)
  TO mv_booking_admin;
GRANT SELECT ON booking.provider_evidence, booking.reconciliation_resolutions, booking.definite_refusal_codes TO mv_booking_report;

-- RLS on the new tables (deny by default) + policies
ALTER TABLE booking.definite_refusal_codes      ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking.provider_evidence           ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking.reconciliation_resolutions  ENABLE ROW LEVEL SECURITY;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['definite_refusal_codes','provider_evidence','reconciliation_resolutions'] LOOP
    EXECUTE format('CREATE POLICY app_ro ON booking.%I FOR SELECT TO mv_booking_app USING (true)', t);
    EXECUTE format('CREATE POLICY report_ro ON booking.%I FOR SELECT TO mv_booking_report USING (true)', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['instance','intents','intent_transitions','intent_applied_events','intent_work','inventory_claims',
                           'payment_attempts','external_operations','hostaway_reservation_attempts','payment_ledger','payment_refunds',
                           'reconciliation_cases','stripe_webhook_events','definite_refusal_codes','provider_evidence',
                           'reconciliation_resolutions'] LOOP
    EXECUTE format('CREATE POLICY admin_ro ON booking.%I FOR SELECT TO mv_booking_admin USING (true)', t);
  END LOOP;
END $$;
-- migration bookkeeping: deny-by-default RLS too
ALTER TABLE booking_migrations.applied ENABLE ROW LEVEL SECURITY;

-- Supabase Data API roles: no access to the new objects either (no-op locally)
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA booking FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA booking FROM %I', r);
    END IF;
  END LOOP;
END $$;
