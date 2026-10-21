-- 0002_roles_grants — Stage E2B. Least-privilege roles for the booking schema.
-- Roles are created NOLOGIN and WITHOUT passwords. The owner creates login users (or sets passwords) out of band;
-- no credential is ever written in this repository.
--
--   mv_booking_app     runtime role (future Vercel functions): read/insert/update only what the code needs;
--                      INSERT-only on audit tables; no DELETE anywhere; no DDL; may call purge_guest_data().
--   mv_booking_report  read-only reporting: everything EXCEPT guest personal data.
--   anon / authenticated (Supabase Data API roles, if present): no access at all.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mv_booking_app') THEN
    CREATE ROLE mv_booking_app NOLOGIN NOINHERIT NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mv_booking_report') THEN
    CREATE ROLE mv_booking_report NOLOGIN NOINHERIT NOBYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA booking TO mv_booking_app, mv_booking_report;

-- runtime role
GRANT SELECT ON booking.instance TO mv_booking_app;
GRANT SELECT, INSERT, UPDATE ON
  booking.intents, booking.intent_work, booking.inventory_claims, booking.payment_attempts,
  booking.external_operations, booking.hostaway_reservation_attempts, booking.payment_refunds,
  booking.reconciliation_cases, booking.stripe_webhook_events
  TO mv_booking_app;
GRANT SELECT, INSERT ON
  booking.intent_transitions, booking.intent_applied_events, booking.payment_ledger, booking.intent_guests
  TO mv_booking_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA booking TO mv_booking_app;
GRANT EXECUTE ON FUNCTION booking.purge_guest_data(timestamptz, integer, integer) TO mv_booking_app;

-- reporting role: no guest data
GRANT SELECT ON
  booking.instance, booking.intents, booking.intent_transitions, booking.intent_applied_events, booking.intent_work,
  booking.inventory_claims, booking.payment_attempts, booking.external_operations, booking.hostaway_reservation_attempts,
  booking.payment_ledger, booking.payment_refunds, booking.reconciliation_cases, booking.stripe_webhook_events
  TO mv_booking_report;

-- Row-level security policies (RLS was enabled with no policies in 0001 = deny by default).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['instance','intents','intent_transitions','intent_applied_events','intent_guests','intent_work',
                           'inventory_claims','payment_attempts','external_operations','hostaway_reservation_attempts',
                           'payment_ledger','payment_refunds','reconciliation_cases','stripe_webhook_events'] LOOP
    EXECUTE format('CREATE POLICY app_rw ON booking.%I TO mv_booking_app USING (true) WITH CHECK (true)', t);
    IF t <> 'intent_guests' THEN
      EXECUTE format('CREATE POLICY report_ro ON booking.%I FOR SELECT TO mv_booking_report USING (true)', t);
    END IF;
  END LOOP;
END $$;

-- Supabase Data API roles: explicitly no access (no-op where the roles do not exist, e.g. local tests).
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA booking FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA booking FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA booking FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA booking FROM %I', r);
    END IF;
  END LOOP;
END $$;
