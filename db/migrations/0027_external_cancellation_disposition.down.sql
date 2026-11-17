-- 0027 down (DRAFT, local only). Refused once any external disposition has been recorded: a released claim cannot be re-taken
-- and the attestation history must not be lost. Otherwise removes the 0027 objects and restores the 0021 claim_release_blockers.
SET LOCAL lock_timeout = '5s';
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM booking.external_cancellations) OR EXISTS (SELECT 1 FROM booking.external_refund_attestations) THEN
    RAISE EXCEPTION 'DOWN_REFUSED: external cancellation records exist' USING ERRCODE = 'restrict_violation';
  END IF;
END $$;
DROP TRIGGER external_cancellation_intent_fence ON booking.intents;
DROP TRIGGER external_cancellation_op_fence ON booking.external_operations;
DROP TRIGGER external_cancellation_claim_fence ON booking.inventory_claims;
DROP FUNCTION booking.admin_attest_external_refund(uuid, text, bigint, text, text, text, text);
DROP FUNCTION booking.admin_record_external_cancellation(uuid, integer, uuid[], uuid, text, bigint, text, text, text, text, text);
DROP FUNCTION booking.external_refund_check(text, bigint, bigint);
DROP FUNCTION booking.external_cancellation_intent_fence();
DROP FUNCTION booking.external_cancellation_op_fence();
DROP FUNCTION booking.external_cancellation_claim_fence();
-- restore the 0021 body exactly
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

DROP FUNCTION booking.externally_cancelled(uuid);
DROP TABLE booking.external_refund_attestations;
DROP TABLE booking.external_cancellations;
DROP FUNCTION booking.external_disposition_insert_guard();
