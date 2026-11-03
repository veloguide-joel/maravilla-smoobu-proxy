-- 0009_void_cancel_claim_fence (up) — Stage E7.4a (offline). DISPOSABLE LOCAL test databases only.
-- A Stripe void row may move pending -> in_flight (be claimed for sending) only while its intent's AUTHORIZATION leg is
-- open: reservation_failed, or capture_failed with settlement_authorization_settled explicitly false; the row binds the
-- intent's current PaymentIntent; and booking.authorization_settled_for() is not already true. A Hostaway cancel row only
-- while the intent is capture_failed with settlement_reservation_cancelled explicitly false and the row binds the intent's
-- reservation id. A never-sent row of an already-settled leg (e.g. the void of an authorization proven gone) can
-- therefore never be claimed, by any claim path. The intent row is share-locked inside the same transaction (as 0007),
-- so a concurrent transition either commits first (and the claim is refused) or waits for the claim to commit.
-- The authorization_settled_for() refusal is conservative only: it is broader than the cleanup worker's strict proofs.
-- No table, column, grant or E3 change.
CREATE FUNCTION booking.void_cancel_claim_fence() RETURNS trigger
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
REVOKE ALL ON FUNCTION booking.void_cancel_claim_fence() FROM PUBLIC;
CREATE TRIGGER external_operations_void_cancel_claim_fence BEFORE UPDATE ON booking.external_operations
  FOR EACH ROW WHEN (OLD.state = 'pending' AND NEW.state = 'in_flight'
                     AND NEW.op_type IN ('stripe.void_payment_intent', 'hostaway.cancel_reservation'))
  EXECUTE FUNCTION booking.void_cancel_claim_fence();
