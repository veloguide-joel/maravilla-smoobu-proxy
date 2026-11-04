-- 0012_recording_assessments (down) — restores a fresh 0011 schema exactly. REFUSES if any assessment or claim-audit row exists
-- (those rows are audit and are never discarded). The recording_claim_fence body below is copied verbatim from 0011 (lines 553–577).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM booking.recording_assessments) OR EXISTS (SELECT 1 FROM booking.recording_claim_assessments) THEN
    RAISE EXCEPTION 'DOWNGRADE_REFUSED_RECORDING_ASSESSMENT_AUDIT: assessment / claim-audit rows exist' USING ERRCODE = 'check_violation';
  END IF;
END $$;

DROP TRIGGER external_operations_recording_claim_audit ON booking.external_operations;
DROP FUNCTION booking.recording_claim_audit();
CREATE OR REPLACE FUNCTION booking.recording_claim_fence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
DECLARE i booking.intents%ROWTYPE;
BEGIN
  SELECT * INTO i FROM booking.intents WHERE id = NEW.intent_id FOR SHARE;
  IF i.state IS DISTINCT FROM 'payment_captured' OR i.captured_minor IS DISTINCT FROM i.final_total_minor THEN
    RAISE EXCEPTION 'RECORDING_CLAIM_FENCED: the intent is not payment_captured with an exact capture' USING ERRCODE = 'check_violation';
  END IF;
  IF i.hostaway_reservation_id IS NULL OR (NEW.payload ->> 'reservationId') IS DISTINCT FROM i.hostaway_reservation_id
     OR (NEW.payload ->> 'amountMinor') IS DISTINCT FROM i.captured_minor::text THEN
    RAISE EXCEPTION 'RECORDING_CLAIM_FENCED: payload is not bound to the intent reservation / captured amount' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.idempotency_key IS DISTINCT FROM 'och:' || NEW.intent_id::text || ':1' OR OLD.attempts IS DISTINCT FROM 0 OR OLD.dispatched_at IS NOT NULL
     OR i.offline_charge_attempts IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'RECORDING_CLAIM_FENCED: only the never-dispatched initial attempt can be claimed' USING ERRCODE = 'check_violation';
  END IF;
  IF booking.recording_latest_id(NEW.intent_id) IS DISTINCT FROM NEW.id THEN
    RAISE EXCEPTION 'RECORDING_CLAIM_FENCED: not the latest recording' USING ERRCODE = 'check_violation';
  END IF;
  IF booking.recording_active_hold_id(NEW.id) IS NOT NULL
     OR EXISTS (SELECT 1 FROM booking.reconciliation_cases c WHERE c.intent_id = NEW.intent_id AND c.status = 'open' AND starts_with(c.kind, 'OFFLINE_CHARGE_HOLD_')) THEN
    RAISE EXCEPTION 'RECORDING_CLAIM_FENCED: an owner hold is active for this recording or intent' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP FUNCTION booking.recording_claim_ready(uuid, text);
DROP FUNCTION booking.record_recording_assessment(uuid, text, text, text, uuid, uuid, uuid, uuid, integer, text, text, text, jsonb);
DROP FUNCTION booking.recording_claim_refusal(uuid, text, timestamptz);
DROP FUNCTION booking.recording_list_evidence_ok(uuid, uuid, uuid, text, text, text);
DROP FUNCTION booking.recording_identity_refused_evidence_ok(uuid, uuid, uuid, text, text, text, text);
DROP FUNCTION booking.recording_identity_positive(uuid, uuid, uuid, text, text);
DROP FUNCTION booking.recording_preflight_block(uuid);
DROP TABLE booking.recording_claim_assessments;
DROP FUNCTION booking.recording_claim_assessments_guard();
DROP TABLE booking.recording_assessments;
DROP FUNCTION booking.recording_assessments_guard();
DROP TABLE booking.recording_assessment_codes;
