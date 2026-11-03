-- 0010_recording_evidence_link (down) — DISPOSABLE LOCAL test databases only.
-- Precondition (checked first): no recording carries a link and none progressed beyond pending, so a downgrade can never
-- silently re-enable unproven finalisation. Then the triggers, the functions, and the 0003 evidence-writer bodies are
-- restored exactly (same signatures => grants unchanged). 0008 is untouched.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM booking.external_operations WHERE op_type = 'hostaway.record_offline_charge'
              AND (settled_evidence_id IS NOT NULL OR state IN ('in_flight', 'succeeded', 'outcome_unknown', 'escalated'))) THEN
    RAISE EXCEPTION 'DOWNGRADE_REFUSED_RECORDINGS_PROGRESSED: recordings with links or beyond pending exist' USING ERRCODE = 'check_violation';
  END IF;
END $$;
DROP TRIGGER zz0_intents_recording_finalisation ON booking.intents;
DROP TRIGGER zz0_recording_lifecycle_guard ON booking.external_operations;
DROP FUNCTION booking.recording_finalisation_guard();
DROP FUNCTION booking.link_recording_evidence(uuid, uuid);
DROP FUNCTION booking.complete_recording_with_evidence(uuid, text, uuid, text, integer);
DROP FUNCTION booking.recording_lifecycle_guard();
DROP FUNCTION booking.recording_conflict_refusal(uuid, timestamptz, text, uuid);
DROP FUNCTION booking.recording_proof_refusal(uuid, jsonb, text, timestamptz, timestamptz, uuid, text, timestamptz);
DROP FUNCTION booking.recording_latest_id(uuid);
DROP FUNCTION booking.recording_attempt_no(text);

-- restore the 0003 bodies verbatim
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
  RETURN new_id;
END $$;

-- Owner evidence from a provider dashboard: attested, with an external reference (report id, screenshot id, ...).
CREATE OR REPLACE FUNCTION booking.admin_record_evidence(p_intent uuid, p_kind text, p_external_ref text, p_status text, p_observed jsonb,
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
