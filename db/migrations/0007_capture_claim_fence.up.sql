-- 0007_capture_claim_fence (up) — Stage E7.1 (offline). DISPOSABLE LOCAL test databases only.
-- A Stripe capture operation may move pending -> in_flight (be claimed for sending) only while its intent is
-- reservation_confirmed AND the row's payload.attempt equals the intent's current capture_attempts. A capture row left
-- behind by an earlier attempt, or by an intent that moved to capture_unknown / capture_failed / reconciliation, can
-- therefore never be claimed, by any claim path. The intent row is share-locked inside the same transaction, so a
-- concurrent transition either commits first (and the claim is refused) or waits for the claim to commit.
CREATE FUNCTION booking.capture_claim_fence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
DECLARE s text; a integer;
BEGIN
  SELECT state, capture_attempts INTO s, a FROM booking.intents WHERE id = NEW.intent_id FOR SHARE;
  IF s IS DISTINCT FROM 'reservation_confirmed' OR (NEW.payload ->> 'attempt') IS DISTINCT FROM a::text THEN
    RAISE EXCEPTION 'CAPTURE_CLAIM_FENCED: capture attempt % is not the current claimable attempt', NEW.payload ->> 'attempt'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION booking.capture_claim_fence() FROM PUBLIC;
CREATE TRIGGER external_operations_capture_claim_fence BEFORE UPDATE ON booking.external_operations
  FOR EACH ROW WHEN (OLD.state = 'pending' AND NEW.state = 'in_flight' AND NEW.op_type = 'stripe.capture_payment_intent')
  EXECUTE FUNCTION booking.capture_claim_fence();
