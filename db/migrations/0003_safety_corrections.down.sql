-- 0003_safety_corrections (down) — DEV/test only. Restores the 0002 state exactly.
ALTER TABLE booking_migrations.applied DISABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['instance','intents','intent_transitions','intent_applied_events','intent_work','inventory_claims',
                           'payment_attempts','external_operations','hostaway_reservation_attempts','payment_ledger','payment_refunds',
                           'reconciliation_cases','stripe_webhook_events'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS admin_ro ON booking.%I', t);
  END LOOP;
END $$;

DROP TRIGGER IF EXISTS cases_safety_guard ON booking.reconciliation_cases;
DROP TRIGGER IF EXISTS external_operations_safety_guard ON booking.external_operations;
DROP TRIGGER IF EXISTS hostaway_attempts_safety_guard ON booking.hostaway_reservation_attempts;
DROP TRIGGER IF EXISTS payment_attempts_safety_guard ON booking.payment_attempts;
DROP TRIGGER IF EXISTS intents_safety_guard ON booking.intents;
DROP TRIGGER IF EXISTS claims_safety_guard ON booking.inventory_claims;

DROP FUNCTION booking.admin_acquire_claim(uuid, timestamptz);
DROP FUNCTION booking.admin_close_case(uuid, uuid[], text, text, timestamptz);
DROP FUNCTION booking.admin_resolve_intent(uuid, text, uuid[], text, text, text, timestamptz);
DROP FUNCTION booking.admin_resolve_operation(uuid, text, uuid[], text, text, text, timestamptz);
DROP FUNCTION booking.cited_evidence(uuid, uuid[]);
DROP FUNCTION booking.admin_record_evidence(uuid, text, text, text, jsonb, timestamptz, text, text);
DROP FUNCTION booking.record_provider_evidence(uuid, text, text, text, jsonb, text);
DROP FUNCTION booking.cases_safety_guard();
DROP FUNCTION booking.external_operations_safety_guard();
DROP FUNCTION booking.hostaway_attempts_safety_guard();
DROP FUNCTION booking.payment_attempts_safety_guard();
DROP FUNCTION booking.intents_safety_guard();
DROP FUNCTION booking.claim_schedule_review(uuid, timestamptz, boolean);
DROP FUNCTION booking.claim_upgrade(uuid, text);
DROP FUNCTION booking.release_completed_stays(timestamptz);
DROP FUNCTION booking.release_claim_if_safe(uuid, text, timestamptz);
DROP FUNCTION booking.claims_safety_guard();
DROP FUNCTION booking.claim_release_blockers(uuid, timestamptz);
DROP FUNCTION booking.reservation_blockers(uuid);
DROP FUNCTION booking.authorization_blockers(uuid);

ALTER TABLE booking.external_operations DROP COLUMN resolution_id;
DROP TABLE booking.reconciliation_resolutions;
DROP FUNCTION booking.resolutions_guard();
DROP TABLE booking.provider_evidence;
DROP FUNCTION booking.validate_evidence(text, text, jsonb);
DROP TABLE booking.definite_refusal_codes;

ALTER TABLE booking.external_operations DROP CONSTRAINT external_operations_op_type_check;
ALTER TABLE booking.external_operations ADD CONSTRAINT external_operations_op_type_check CHECK (op_type IN (
  'stripe.create_checkout_session', 'stripe.retrieve_payment_intent', 'stripe.capture_payment_intent',
  'stripe.void_payment_intent', 'hostaway.lookup_reservation', 'hostaway.create_reservation',
  'hostaway.cancel_reservation', 'hostaway.record_offline_charge', 'guest.notify', 'alert.owner'));

-- privileges back to the 0002 state
REVOKE ALL ON ALL TABLES IN SCHEMA booking FROM mv_booking_admin;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA booking FROM mv_booking_admin;
REVOKE ALL ON SCHEMA booking FROM mv_booking_admin;
DROP ROLE IF EXISTS mv_booking_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA booking GRANT EXECUTE ON FUNCTIONS TO PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA booking TO PUBLIC;
REVOKE ALL ON FUNCTION booking.purge_guest_data(timestamptz, integer, integer) FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA booking FROM mv_booking_app;
GRANT EXECUTE ON FUNCTION booking.purge_guest_data(timestamptz, integer, integer) TO mv_booking_app;
GRANT UPDATE ON booking.inventory_claims, booking.reconciliation_cases TO mv_booking_app;
DROP FUNCTION booking.is_privileged();
