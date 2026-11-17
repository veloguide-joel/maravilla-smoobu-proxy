-- 0027 (DRAFT, LOCAL / DISPOSABLE PostgreSQL ONLY — never applied to the shared DEV database): owner-attested MANUAL external
-- cancellation of a CONFIRMED booking (C118 / N1).
--
-- Operating model (Joel, 2026-11-17): cancellations are made by a person in Hostaway; refunds by a person in the Stripe dashboard.
-- This migration only RECORDS what the owner attests already happened outside the system, and releases our own inventory claim
-- for those nights in the same transaction. It makes no provider call, schedules no provider write and moves no money.
--
-- Invariants (each has a test in test/db/e7-c118-external-cancellation.test.mjs):
--   I1  Admin only: the two recording functions are EXECUTE-granted to mv_booking_admin alone (PUBLIC / runtime / report: none).
--       The app / report / admin roles have NO INSERT / UPDATE / DELETE privilege on the new tables (ACL + RLS); that is the authority.
--       The transaction-local setting checked by the insert guard is a COORDINATION guard only (it keeps the functions' own inserts
--       paired with their checks); it is not an unforgeable capability: the schema owner can set it and is trusted. The one runtime-role
--       grant is EXECUTE on the minimal guest projection booking.external_cancellation_public (F1), which returns no admin / evidence data.
--   I2  Append-only: the cancellation record and every refund attestation are immutable (no UPDATE / DELETE / TRUNCATE).
--   I3  Cancellation status and refund disposition are SEPARATE facts. Recording a cancellation never implies a refund; the initial
--       refund disposition is stated explicitly (pending | none | partial | full) and later changes are new attestation rows.
--       Nothing here writes payment_ledger, payment_refunds, intents.captured_minor or any money column.
--   I4  The intent row is NOT modified (state stays 'confirmed', version unchanged): successful notification / render / receipt,
--       capture and offline-charge history stay exactly as they were. The cancellation is a separate, linked fact.
--   I5  Refused unless: state 'confirmed' at the caller's expected version; no reservation / work lease; no operation leased,
--       in flight, ambiguous, escalated or pending (other than a pristine, never-attempted guest.notify or provider READ); no open case; no
--       unresolved payment attempt or unprocessed webhook; no refund record; the cited cancellation evidence is this intent's,
--       for its own reservation, status 'cancelled', NOT superseded by later evidence, and not older than the reservation.
--   I6  Atomic claim release: the active inventory claim is released in the same transaction (reason EXTERNAL_CANCELLATION_ATTESTED)
--       through the normal claims guard; booking.claim_release_blockers gains exactly one branch for this case.
--   I7  Afterwards, for that intent: no new inventory claim; the queued, never-attempted guest.notify row is LATCHED in the same transaction
--       with code EXTERNALLY_CANCELLED (the accepted owner-visible "never sent" record, so the worker skips it cleanly: no claim attempt,
--       no lease, no render, no retry) and additionally fenced by trigger; no new provider-write or notification operation; no TEST cleanup.
--   I9  The guest's bearer status reports the cancellation honestly (status booking_cancelled, stage cancelled) with the refund
--       disposition as a SEPARATE label; nothing implies money moved unless the host attested a partial / full refund.
--   I8  Idempotent replay: the same request key with identical arguments returns the original record; any difference is refused.
SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------------------------
-- 1. Tables (no guest personal data: ids, codes, amounts, admin labels and short references only)
CREATE TABLE booking.external_cancellations (
  id                       uuid PRIMARY KEY,
  intent_id                uuid NOT NULL UNIQUE REFERENCES booking.intents (id),
  request_key              text NOT NULL UNIQUE CHECK (request_key ~ '^[A-Za-z0-9._:-]{8,116}$'),   -- 116 + ':r1' fits the 120 child key
  hostaway_reservation_id  text NOT NULL,
  cancellation_evidence_id uuid NOT NULL REFERENCES booking.provider_evidence (id),
  evidence_ids             uuid[] NOT NULL CHECK (cardinality(evidence_ids) BETWEEN 1 AND 20),
  expected_version         integer NOT NULL,
  intent_state             text NOT NULL CHECK (intent_state = 'confirmed'),
  captured_minor           bigint NOT NULL CHECK (captured_minor >= 0),
  currency                 char(3) NOT NULL CHECK (currency IN ('MXN', 'USD')),
  released_claim_id        bigint REFERENCES booking.inventory_claims (id),          -- NULL: the claim was already released
  notify_dispositions      jsonb NOT NULL CHECK (jsonb_typeof(notify_dispositions) = 'array'),
  attested_by              text NOT NULL CHECK (attested_by ~ '^[a-z][a-z0-9_-]{0,39}$'),
  reference                text NOT NULL CHECK (reference ~ '^[A-Za-z0-9._:/#-]{1,120}$'),
  justification_code       text NOT NULL CHECK (booking.is_code(justification_code)),
  resolver_session_user    text NOT NULL,
  recorded_at              timestamptz NOT NULL DEFAULT statement_timestamp(),
  CHECK (cancellation_evidence_id = ANY (evidence_ids))
);

CREATE TABLE booking.external_refund_attestations (
  id                    uuid PRIMARY KEY,
  cancellation_id       uuid NOT NULL REFERENCES booking.external_cancellations (id),
  intent_id             uuid NOT NULL REFERENCES booking.intents (id),
  seq                   integer NOT NULL CHECK (seq >= 1),
  request_key           text NOT NULL UNIQUE CHECK (request_key ~ '^[A-Za-z0-9._:-]{8,120}$'),
  refund_status         text NOT NULL CHECK (refund_status IN ('pending', 'none', 'partial', 'full')),
  refunded_minor        bigint CHECK (refunded_minor IS NULL OR refunded_minor >= 0),
  currency              char(3) NOT NULL CHECK (currency IN ('MXN', 'USD')),
  provider_reference    text CHECK (provider_reference IS NULL OR provider_reference ~ '^[A-Za-z0-9._:/#-]{1,120}$'),
  attested_by           text NOT NULL CHECK (attested_by ~ '^[a-z][a-z0-9_-]{0,39}$'),
  reference             text NOT NULL CHECK (reference ~ '^[A-Za-z0-9._:/#-]{1,120}$'),
  resolver_session_user text NOT NULL,
  recorded_at           timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (cancellation_id, seq),
  CHECK ((refund_status = 'pending') = (refunded_minor IS NULL)),
  CHECK (refund_status <> 'none' OR refunded_minor = 0),
  CHECK (refund_status NOT IN ('partial', 'full') OR refunded_minor > 0)
);

-- I2: append-only
CREATE TRIGGER external_cancellations_append_only BEFORE UPDATE OR DELETE ON booking.external_cancellations
  FOR EACH ROW EXECUTE FUNCTION booking.reject_change();
CREATE TRIGGER external_cancellations_no_truncate BEFORE TRUNCATE ON booking.external_cancellations
  FOR EACH STATEMENT EXECUTE FUNCTION booking.reject_change();
CREATE TRIGGER external_refund_attestations_append_only BEFORE UPDATE OR DELETE ON booking.external_refund_attestations
  FOR EACH ROW EXECUTE FUNCTION booking.reject_change();
CREATE TRIGGER external_refund_attestations_no_truncate BEFORE TRUNCATE ON booking.external_refund_attestations
  FOR EACH STATEMENT EXECUTE FUNCTION booking.reject_change();

-- I1: rows are inserted only inside the recording functions' own transaction (authority token), never directly.
CREATE FUNCTION booking.external_disposition_insert_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, booking AS $$
BEGIN
  IF current_setting('booking.external_disposition_txn', true) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'EXTERNAL_DISPOSITION_AUTHORITY: rows are written only by the admin recording functions' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.recorded_at := statement_timestamp();
  NEW.resolver_session_user := session_user;
  RETURN NEW;
END $$;
CREATE TRIGGER external_cancellations_insert_guard BEFORE INSERT ON booking.external_cancellations
  FOR EACH ROW EXECUTE FUNCTION booking.external_disposition_insert_guard();
CREATE TRIGGER external_refund_attestations_insert_guard BEFORE INSERT ON booking.external_refund_attestations
  FOR EACH ROW EXECUTE FUNCTION booking.external_disposition_insert_guard();

CREATE FUNCTION booking.externally_cancelled(p_intent uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
  SELECT EXISTS (SELECT 1 FROM booking.external_cancellations x WHERE x.intent_id = p_intent)
$$;

-- ---------------------------------------------------------------------------------------------
-- 2. I6: claim release. The 0021 body, unchanged except the one marked branch for an attested external cancellation.
CREATE OR REPLACE FUNCTION booking.claim_release_blockers(p_intent uuid) RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
DECLARE s text; td date; out text[] := '{}'; r record;
BEGIN
  SELECT state, to_date INTO s, td FROM booking.intents WHERE id = p_intent;
  IF s IS NULL THEN RETURN ARRAY['INTENT_NOT_FOUND']; END IF;
  IF s = 'confirmed' THEN
    IF td <= (statement_timestamp() AT TIME ZONE 'America/Mexico_City')::date THEN RETURN '{}'; END IF;
    -- 0027: a confirmed booking whose cancellation outside the system is owner-attested (booking.external_cancellations).
    -- The money stays as it is (refunds are a separate, manual fact); only our own unsettled work blocks the release.
    IF NOT booking.externally_cancelled(p_intent) THEN RETURN ARRAY['STAY_NOT_COMPLETED']; END IF;
    FOR r IN SELECT id, status FROM booking.payment_attempts WHERE intent_id = p_intent AND status IN ('creating', 'open', 'outcome_unknown') LOOP
      out := out || ('PAYMENT_ATTEMPT_UNRESOLVED:' || r.status);
    END LOOP;
    out := out || booking.reservation_blockers(p_intent);
    FOR r IN SELECT op_type, state FROM booking.external_operations
              WHERE intent_id = p_intent AND (state IN ('in_flight', 'outcome_unknown', 'escalated') OR lease_worker_id IS NOT NULL
                                               OR (state = 'pending' AND op_type <> 'guest.notify'
                                                   AND NOT (retry_class = 'read' AND attempts = 0 AND dispatched_at IS NULL))) LOOP
      out := out || ('PROVIDER_OPERATION_UNRESOLVED:' || r.op_type || ':' || r.state);
    END LOOP;
    FOR r IN SELECT kind FROM booking.reconciliation_cases WHERE intent_id = p_intent AND status = 'open' LOOP
      out := out || ('OPEN_CASE:' || r.kind);
    END LOOP;
    RETURN out;
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
                              'hostaway.create_reservation', 'hostaway.cancel_reservation', 'hostaway.record_offline_charge', 'stripe.refund_payment_intent',
                              'hostaway.refund_offline_charge')
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
-- 3. I7 fences after the record exists (new trigger functions; no existing function body is changed)
-- 3a. no new inventory claim for the intent (incl. the reconciliation re-claim path)
CREATE FUNCTION booking.external_cancellation_claim_fence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
BEGIN
  IF booking.externally_cancelled(NEW.intent_id) THEN
    RAISE EXCEPTION 'EXTERNALLY_CANCELLED: no new claim for an externally cancelled booking' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER external_cancellation_claim_fence BEFORE INSERT ON booking.inventory_claims
  FOR EACH ROW EXECUTE FUNCTION booking.external_cancellation_claim_fence();

-- 3b. operations: the pristine guest.notify row can never be claimed (no send, no resend); no new notification or provider-write
--     operation is created. Provider READS stay allowed (reconciliation may still look).
CREATE FUNCTION booking.external_cancellation_op_fence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
BEGIN
  IF NOT booking.externally_cancelled(NEW.intent_id) THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.op_type IN ('guest.notify', 'stripe.create_checkout_session', 'stripe.capture_payment_intent', 'stripe.void_payment_intent',
                       'stripe.refund_payment_intent', 'hostaway.create_reservation', 'hostaway.cancel_reservation',
                       'hostaway.record_offline_charge', 'hostaway.refund_offline_charge') THEN
      RAISE EXCEPTION 'EXTERNALLY_CANCELLED: % is not created for an externally cancelled booking', NEW.op_type USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.op_type = 'guest.notify' AND OLD.state = 'pending' AND NEW.state IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION 'EXTERNALLY_CANCELLED: the queued notification of an externally cancelled booking is never sent' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER external_cancellation_op_fence BEFORE INSERT OR UPDATE ON booking.external_operations
  FOR EACH ROW EXECUTE FUNCTION booking.external_cancellation_op_fence();

-- 3c. no TEST cleanup entry (it would cancel / refund automatically)
CREATE FUNCTION booking.external_cancellation_intent_fence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
BEGIN
  IF OLD.state = 'confirmed' AND NEW.state = 'test_cleanup_pending' AND booking.externally_cancelled(OLD.id) THEN
    RAISE EXCEPTION 'EXTERNALLY_CANCELLED: TEST cleanup does not apply to an externally cancelled booking' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER external_cancellation_intent_fence BEFORE UPDATE ON booking.intents
  FOR EACH ROW EXECUTE FUNCTION booking.external_cancellation_intent_fence();

-- ---------------------------------------------------------------------------------------------
-- 4. Refund amount rule (shared by both functions)
CREATE FUNCTION booking.external_refund_check(p_status text, p_minor bigint, p_captured bigint) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('pending', 'none', 'partial', 'full') THEN
    RAISE EXCEPTION 'REFUND_STATUS_INVALID' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF (p_status = 'pending' AND p_minor IS NOT NULL) OR (p_status = 'none' AND p_minor IS DISTINCT FROM 0)
     OR (p_status = 'partial' AND (p_minor IS NULL OR p_minor <= 0 OR p_minor >= p_captured))
     OR (p_status = 'full' AND p_minor IS DISTINCT FROM p_captured) THEN
    RAISE EXCEPTION 'REFUND_AMOUNT_INVALID: % of % captured', coalesce(p_minor::text, 'null'), p_captured USING ERRCODE = 'check_violation';
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------
-- 5. The admin recording function (I1, I3–I6, I8)
CREATE FUNCTION booking.admin_record_external_cancellation(
  p_intent uuid, p_expected_version integer, p_evidence uuid[], p_cancellation_evidence uuid,
  p_refund_status text, p_refunded_minor bigint, p_refund_reference text,
  p_attested_by text, p_reference text, p_justification text, p_request_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
DECLARE x booking.external_cancellations%ROWTYPE; f booking.external_refund_attestations%ROWTYPE; i booking.intents%ROWTYPE;
        e booking.provider_evidence%ROWTYPE; r record; nd jsonb := '[]'::jsonb; claim_id bigint; cid uuid := gen_random_uuid();
        fid uuid := gen_random_uuid(); w booking.intent_work%ROWTYPE; to_latch uuid[] := '{}';
BEGIN
  IF p_request_key IS NULL OR p_request_key !~ '^[A-Za-z0-9._:-]{8,116}$' THEN
    RAISE EXCEPTION 'REQUEST_KEY_INVALID' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- I8: replay
  SELECT * INTO x FROM booking.external_cancellations WHERE request_key = p_request_key;
  IF FOUND THEN
    SELECT * INTO f FROM booking.external_refund_attestations WHERE cancellation_id = x.id AND seq = 1;
    IF x.intent_id IS DISTINCT FROM p_intent OR x.expected_version IS DISTINCT FROM p_expected_version
       OR x.evidence_ids IS DISTINCT FROM p_evidence OR x.cancellation_evidence_id IS DISTINCT FROM p_cancellation_evidence
       OR x.attested_by IS DISTINCT FROM p_attested_by OR x.reference IS DISTINCT FROM p_reference
       OR x.justification_code IS DISTINCT FROM p_justification OR f.refund_status IS DISTINCT FROM p_refund_status
       OR f.refunded_minor IS DISTINCT FROM p_refunded_minor OR f.provider_reference IS DISTINCT FROM p_refund_reference THEN
      RAISE EXCEPTION 'REQUEST_KEY_CONFLICT: the key was used with different arguments' USING ERRCODE = 'unique_violation';
    END IF;
    RETURN jsonb_build_object('replayed', true, 'cancellationId', x.id, 'refundAttestationId', f.id,
                              'releasedClaimId', x.released_claim_id, 'notify', x.notify_dispositions);
  END IF;

  SELECT * INTO i FROM booking.intents WHERE id = p_intent FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'INTENT_NOT_FOUND' USING ERRCODE = 'check_violation'; END IF;
  IF booking.externally_cancelled(p_intent) THEN RAISE EXCEPTION 'ALREADY_RECORDED' USING ERRCODE = 'unique_violation'; END IF;
  IF i.state <> 'confirmed' THEN RAISE EXCEPTION 'NOT_CONFIRMED: %', i.state USING ERRCODE = 'check_violation'; END IF;
  IF p_expected_version IS DISTINCT FROM i.version THEN
    RAISE EXCEPTION 'STALE_VERSION: expected %, current %', p_expected_version, i.version USING ERRCODE = 'serialization_failure';
  END IF;
  IF i.hostaway_reservation_id IS NULL THEN RAISE EXCEPTION 'NO_RESERVATION' USING ERRCODE = 'check_violation'; END IF;
  IF i.lease_worker_id IS NOT NULL THEN RAISE EXCEPTION 'INTENT_LEASE_PRESENT' USING ERRCODE = 'lock_not_available'; END IF;
  SELECT * INTO w FROM booking.intent_work WHERE intent_id = p_intent FOR UPDATE;
  IF w.work_worker_id IS NOT NULL THEN RAISE EXCEPTION 'WORK_LEASE_PRESENT' USING ERRCODE = 'lock_not_available'; END IF;

  -- I5: our own work must be settled (rows locked so a worker cannot claim them while this runs)
  FOR r IN SELECT o.* FROM booking.external_operations o WHERE o.intent_id = p_intent ORDER BY o.created_at, o.id FOR UPDATE LOOP
    IF r.lease_worker_id IS NOT NULL THEN
      RAISE EXCEPTION 'OPERATION_LEASED: %', r.op_type USING ERRCODE = 'lock_not_available';
    END IF;
    IF r.state IN ('in_flight', 'outcome_unknown', 'escalated') THEN
      RAISE EXCEPTION 'OPERATION_UNSETTLED: %:%', r.op_type, r.state USING ERRCODE = 'check_violation';
    END IF;
    IF r.op_type = 'guest.notify' THEN
      IF r.state = 'pending' THEN
        IF r.attempts <> 0 OR r.dispatched_at IS NOT NULL OR r.completed_at IS NOT NULL OR r.result_ref IS NOT NULL
           OR EXISTS (SELECT 1 FROM booking.notification_renders n WHERE n.operation_id = r.id) THEN
          RAISE EXCEPTION 'NOTIFY_NOT_PRISTINE' USING ERRCODE = 'check_violation';
        END IF;
        IF EXISTS (SELECT 1 FROM booking.notification_latches l WHERE l.operation_id = r.id) THEN
          -- already refused by the worker (e.g. it saw the cancellation evidence first): the existing latch is the record; kept as is
          nd := nd || jsonb_build_object('operationId', r.id, 'template', r.payload ->> 'template', 'state', 'pending', 'disposition', 'latched_preserved');
        ELSE
          to_latch := to_latch || r.id;
          nd := nd || jsonb_build_object('operationId', r.id, 'template', r.payload ->> 'template', 'state', 'pending', 'disposition', 'latched_unsent');
        END IF;
      ELSIF r.state = 'succeeded' THEN
        nd := nd || jsonb_build_object('operationId', r.id, 'template', r.payload ->> 'template', 'state', 'succeeded', 'disposition', 'sent_preserved');
      ELSE
        nd := nd || jsonb_build_object('operationId', r.id, 'template', r.payload ->> 'template', 'state', r.state, 'disposition', 'terminal_preserved');
      END IF;
    ELSIF r.state = 'pending' AND NOT (r.retry_class = 'read' AND r.attempts = 0 AND r.dispatched_at IS NULL) THEN
      -- a never-attempted provider READ (e.g. the lookup-before-create left pending when the create succeeded) changes nothing
      RAISE EXCEPTION 'OPERATION_PENDING: %', r.op_type USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM booking.reconciliation_cases c WHERE c.intent_id = p_intent AND c.status = 'open') THEN
    RAISE EXCEPTION 'OPEN_CASE' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM booking.payment_attempts a WHERE a.intent_id = p_intent AND a.status IN ('creating', 'open', 'outcome_unknown')) THEN
    RAISE EXCEPTION 'PAYMENT_ATTEMPT_UNRESOLVED' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM booking.stripe_webhook_events s WHERE s.intent_id = p_intent AND s.status IN ('received', 'failed_retryable')) THEN
    RAISE EXCEPTION 'WEBHOOK_UNPROCESSED' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM booking.payment_refunds pr WHERE pr.intent_id = p_intent) THEN
    RAISE EXCEPTION 'REFUND_RECORD_PRESENT: automated refund history belongs to the TEST cleanup path' USING ERRCODE = 'check_violation';
  END IF;

  -- I5: the evidence
  IF p_cancellation_evidence IS NULL OR p_evidence IS NULL OR NOT (p_cancellation_evidence = ANY (p_evidence)) THEN
    RAISE EXCEPTION 'CANCELLATION_EVIDENCE_REQUIRED' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM booking.cited_evidence(p_intent, p_evidence);                 -- every cited id is this intent's (raises otherwise)
  SELECT * INTO e FROM booking.provider_evidence WHERE id = p_cancellation_evidence;
  IF e.kind <> 'hostaway_reservation' OR e.status <> 'cancelled' OR e.external_ref IS DISTINCT FROM i.hostaway_reservation_id THEN
    RAISE EXCEPTION 'CANCELLATION_EVIDENCE_MISMATCH' USING ERRCODE = 'check_violation';
  END IF;
  IF i.reservation_confirmed_at IS NOT NULL AND e.observed_at < i.reservation_confirmed_at THEN
    RAISE EXCEPTION 'EVIDENCE_PREDATES_RESERVATION' USING ERRCODE = 'check_violation';
  END IF;
  IF booking.gn_latest_evidence(p_intent, 'hostaway_reservation', i.hostaway_reservation_id) IS DISTINCT FROM e.id THEN
    RAISE EXCEPTION 'EVIDENCE_SUPERSEDED: later reservation evidence exists' USING ERRCODE = 'check_violation';
  END IF;
  IF cardinality(booking.reservation_blockers(p_intent)) > 0 THEN
    RAISE EXCEPTION 'RESERVATION_NOT_VERIFIED_CANCELLED: %', array_to_string(booking.reservation_blockers(p_intent), ', ') USING ERRCODE = 'check_violation';
  END IF;

  -- I3: the refund disposition is stated, never inferred
  PERFORM booking.external_refund_check(p_refund_status, p_refunded_minor, i.captured_minor);

  -- write (I6: record + release in this one transaction)
  PERFORM set_config('booking.external_disposition_txn', pg_current_xact_id()::text, true);
  SELECT c.id INTO claim_id FROM booking.inventory_claims c WHERE c.intent_id = p_intent AND c.released_at IS NULL FOR UPDATE;
  INSERT INTO booking.external_cancellations (id, intent_id, request_key, hostaway_reservation_id, cancellation_evidence_id, evidence_ids,
     expected_version, intent_state, captured_minor, currency, released_claim_id, notify_dispositions, attested_by, reference,
     justification_code, resolver_session_user)
  VALUES (cid, p_intent, p_request_key, i.hostaway_reservation_id, p_cancellation_evidence, p_evidence, p_expected_version, i.state,
     i.captured_minor, i.currency, claim_id, nd, p_attested_by, p_reference, p_justification, session_user);
  INSERT INTO booking.external_refund_attestations (id, cancellation_id, intent_id, seq, request_key, refund_status, refunded_minor, currency,
     provider_reference, attested_by, reference, resolver_session_user)
  VALUES (fid, cid, p_intent, 1, p_request_key || ':r1', p_refund_status, p_refunded_minor, i.currency, p_refund_reference, p_attested_by,
     p_reference, session_user);
  -- I7: the queued, never-attempted confirmation is latched (append-only, owner-visible; the worker never claims a latched row)
  INSERT INTO booking.notification_latches (operation_id, intent_id, code, intent_version_seen, latched_at, worker)
  SELECT u, p_intent, 'EXTERNALLY_CANCELLED', i.version, statement_timestamp(), 'admin-external-cancellation' FROM unnest(to_latch) AS u;
  IF claim_id IS NOT NULL THEN
    UPDATE booking.inventory_claims SET released_at = statement_timestamp(), release_reason = 'EXTERNAL_CANCELLATION_ATTESTED'
     WHERE id = claim_id;                                               -- claims_safety_guard re-checks claim_release_blockers
  END IF;
  PERFORM set_config('booking.external_disposition_txn', '', true);
  RETURN jsonb_build_object('replayed', false, 'cancellationId', cid, 'refundAttestationId', fid, 'releasedClaimId', claim_id, 'notify', nd);
END $$;

-- 6. Later refund attestations (append-only; refunds stay manual — this records, it never moves money)
CREATE FUNCTION booking.admin_attest_external_refund(p_cancellation uuid, p_refund_status text, p_refunded_minor bigint,
  p_provider_reference text, p_attested_by text, p_reference text, p_request_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
DECLARE x booking.external_cancellations%ROWTYPE; f booking.external_refund_attestations%ROWTYPE;
        last booking.external_refund_attestations%ROWTYPE; fid uuid := gen_random_uuid();
BEGIN
  IF p_request_key IS NULL OR p_request_key !~ '^[A-Za-z0-9._:-]{8,120}$' THEN
    RAISE EXCEPTION 'REQUEST_KEY_INVALID' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO f FROM booking.external_refund_attestations WHERE request_key = p_request_key;
  IF FOUND THEN
    IF f.cancellation_id IS DISTINCT FROM p_cancellation OR f.refund_status IS DISTINCT FROM p_refund_status
       OR f.refunded_minor IS DISTINCT FROM p_refunded_minor OR f.provider_reference IS DISTINCT FROM p_provider_reference
       OR f.attested_by IS DISTINCT FROM p_attested_by OR f.reference IS DISTINCT FROM p_reference THEN
      RAISE EXCEPTION 'REQUEST_KEY_CONFLICT: the key was used with different arguments' USING ERRCODE = 'unique_violation';
    END IF;
    RETURN jsonb_build_object('replayed', true, 'refundAttestationId', f.id, 'seq', f.seq);
  END IF;
  SELECT * INTO x FROM booking.external_cancellations WHERE id = p_cancellation FOR UPDATE;   -- serialises attestations per cancellation
  IF NOT FOUND THEN RAISE EXCEPTION 'CANCELLATION_NOT_FOUND' USING ERRCODE = 'check_violation'; END IF;
  PERFORM booking.external_refund_check(p_refund_status, p_refunded_minor, x.captured_minor);
  SELECT * INTO last FROM booking.external_refund_attestations WHERE cancellation_id = x.id ORDER BY seq DESC LIMIT 1;
  IF last.refund_status = 'full' THEN RAISE EXCEPTION 'REFUND_ALREADY_FULL' USING ERRCODE = 'check_violation'; END IF;
  IF last.refund_status <> 'pending' AND (p_refund_status = 'pending' OR p_refunded_minor < last.refunded_minor) THEN
    RAISE EXCEPTION 'REFUND_DECREASE: an attested refund is never reduced or made unknown again' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM set_config('booking.external_disposition_txn', pg_current_xact_id()::text, true);
  INSERT INTO booking.external_refund_attestations (id, cancellation_id, intent_id, seq, request_key, refund_status, refunded_minor, currency,
     provider_reference, attested_by, reference, resolver_session_user)
  VALUES (fid, x.id, x.intent_id, last.seq + 1, p_request_key, p_refund_status, p_refunded_minor, x.currency, p_provider_reference,
     p_attested_by, p_reference, session_user);
  PERFORM set_config('booking.external_disposition_txn', '', true);
  RETURN jsonb_build_object('replayed', false, 'refundAttestationId', fid, 'seq', last.seq + 1);
END $$;

-- ---------------------------------------------------------------------------------------------
-- 6b. I9 (F1): the guest projection read by the bearer status handler (runtime role). Only: cancelled + the latest refund label.
--     No attestation, evidence, reference, amount, time or admin field.
CREATE FUNCTION booking.external_cancellation_public(p_intent uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
  SELECT jsonb_build_object('cancelled', true, 'refundStatus',
           (SELECT f.refund_status FROM booking.external_refund_attestations f WHERE f.cancellation_id = x.id ORDER BY f.seq DESC LIMIT 1))
    FROM booking.external_cancellations x WHERE x.intent_id = p_intent
$$;

-- ---------------------------------------------------------------------------------------------
-- 7. Privileges (local draft): admin-only execution; read for admin / report; RLS deny-by-default
REVOKE ALL ON FUNCTION booking.external_disposition_insert_guard(), booking.externally_cancelled(uuid),
  booking.external_cancellation_claim_fence(), booking.external_cancellation_op_fence(), booking.external_cancellation_intent_fence(),
  booking.external_refund_check(text, bigint, bigint),
  booking.admin_record_external_cancellation(uuid, integer, uuid[], uuid, text, bigint, text, text, text, text, text),
  booking.admin_attest_external_refund(uuid, text, bigint, text, text, text, text), booking.external_cancellation_public(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION booking.external_cancellation_public(uuid) TO mv_booking_app;
GRANT EXECUTE ON FUNCTION
  booking.admin_record_external_cancellation(uuid, integer, uuid[], uuid, text, bigint, text, text, text, text, text),
  booking.admin_attest_external_refund(uuid, text, bigint, text, text, text, text) TO mv_booking_admin;
GRANT SELECT ON booking.external_cancellations, booking.external_refund_attestations TO mv_booking_admin, mv_booking_report;
ALTER TABLE booking.external_cancellations ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking.external_refund_attestations ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_ro ON booking.external_cancellations FOR SELECT TO mv_booking_admin USING (true);
CREATE POLICY report_ro ON booking.external_cancellations FOR SELECT TO mv_booking_report USING (true);
CREATE POLICY admin_ro ON booking.external_refund_attestations FOR SELECT TO mv_booking_admin USING (true);
CREATE POLICY report_ro ON booking.external_refund_attestations FOR SELECT TO mv_booking_report USING (true);
