-- 0002_roles_grants (down) — removes policies and grants, then the two roles (if nothing else depends on them).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['instance','intents','intent_transitions','intent_applied_events','intent_guests','intent_work',
                           'inventory_claims','payment_attempts','external_operations','hostaway_reservation_attempts',
                           'payment_ledger','payment_refunds','reconciliation_cases','stripe_webhook_events'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS app_rw ON booking.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS report_ro ON booking.%I', t);
  END LOOP;
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA booking FROM mv_booking_app, mv_booking_report;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA booking FROM mv_booking_app, mv_booking_report;
REVOKE ALL ON FUNCTION booking.purge_guest_data(timestamptz, integer, integer) FROM mv_booking_app;
REVOKE ALL ON SCHEMA booking FROM mv_booking_app, mv_booking_report;
DROP ROLE IF EXISTS mv_booking_app;
DROP ROLE IF EXISTS mv_booking_report;
