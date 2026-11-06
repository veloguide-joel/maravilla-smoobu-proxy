-- 0017_cancelled_pristine_capture_release (up) — DISPOSABLE LOCAL test databases only. LOCAL MIGRATION CANDIDATE (root ruling a1dcea0d).
-- Replaces booking.claim_release_blockers(uuid) — baseline definition: db/migrations/0005_db_clock_checkout_create.up.sql
-- (the 0003 two-argument version was dropped there). Same signature, language, volatility, SECURITY DEFINER and search_path;
-- CREATE OR REPLACE keeps the owner and the ACL (0005 REVOKE/GRANT stand). Every other blocker and check is byte-identical.
-- The preserved capture row is never written, superseded or deleted.
CREATE OR REPLACE FUNCTION booking.claim_release_blockers(p_intent uuid) RETURNS text[]
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
                              'hostaway.create_reservation', 'hostaway.cancel_reservation', 'hostaway.record_offline_charge')
              -- 0017: the ONE exception. In state 'cancelled' only, a capture row that was never handed to a sender
              -- (pending, attempts 0, dispatched_at NULL, both lease fields NULL) does not block the release. 0007
              -- capture_claim_fence admits a capture claim only while the intent is reservation_confirmed; no reducer path
              -- returns a cancelled intent there (test/db/e7-claim-release-0017.test.mjs Q6/Q7). The row is kept, unchanged.
              AND NOT (s = 'cancelled' AND op_type = 'stripe.capture_payment_intent' AND state = 'pending' AND attempts = 0
                       AND dispatched_at IS NULL AND lease_worker_id IS NULL AND lease_until IS NULL) LOOP
    out := out || ('PROVIDER_OPERATION_UNRESOLVED:' || r.op_type || ':' || r.state);
  END LOOP;
  FOR r IN SELECT kind FROM booking.reconciliation_cases WHERE intent_id = p_intent AND status = 'open' LOOP
    out := out || ('OPEN_CASE:' || r.kind);
  END LOOP;
  RETURN out;
END $$;
