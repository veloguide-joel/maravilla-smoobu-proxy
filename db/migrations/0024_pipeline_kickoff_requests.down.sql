-- 0024_pipeline_kickoff_requests (down) — DISPOSABLE LOCAL test databases only. REFUSED while ANY kickoff request was ever claimed (a claimed /
-- dispatch_* row is the durable record that a dispatch may have been attempted; that evidence is never deleted to roll back). Requested /
-- refused rows (no dispatch ever attempted) are dropped with the table. Removes the intents trigger, the functions and the table; nothing else.
LOCK TABLE booking.intents IN SHARE ROW EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM booking.pipeline_kickoff_requests WHERE state NOT IN ('requested', 'refused')) THEN
    RAISE EXCEPTION 'MIGRATION_0024_DOWN_REFUSED: a kickoff request was claimed (dispatch evidence exists)' USING ERRCODE = 'check_violation';
  END IF;
END $$;
DROP TRIGGER intents_pipeline_kickoff ON booking.intents;
DROP FUNCTION booking.settle_pipeline_kickoff(uuid, text, text, text);
DROP FUNCTION booking.refuse_pipeline_kickoff(uuid, text);
DROP FUNCTION booking.claim_pipeline_kickoff(uuid, text, text, jsonb);
DROP FUNCTION booking.pipeline_kickoff_refusal(booking.intents, booking.pipeline_kickoff_requests);
DROP FUNCTION booking.pipeline_kickoff_record();
DROP TABLE booking.pipeline_kickoff_requests;
DROP FUNCTION booking.pipeline_kickoff_guard();
DROP FUNCTION booking.pipeline_kickoff_excluded(uuid);
