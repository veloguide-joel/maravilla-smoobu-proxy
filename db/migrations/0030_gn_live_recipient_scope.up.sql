-- 0030 (P2d): the guest-notification recipient scope follows the database's own environment marker.
--
--   marker 'test' (or missing / duplicated / unreadable: fail to the TEST scope)   -> UNCHANGED 0025 scope: `.invalid` or exactly the
--                                                                                     simulation sink delivered@resend.dev
--   marker exactly ONE row 'live'                                                  -> a syntactically valid real guest address; never
--                                                                                     `.invalid`, never the simulation sink
-- A TEST database can therefore never admit a real address, whatever a caller passes; a LIVE database never sends to the TEST scope.
-- booking.gn_recipient_in_scope(text) is replaced IN PLACE (same name / signature / return type / owner / ACL / SECURITY INVOKER /
-- search_path). The only attribute change is IMMUTABLE -> STABLE, because it now reads booking.instance. No table, row, claim, latch,
-- render or receipt is touched. Mirrors lib/checkout/guest-notification.js isRecipientInScopeFor.
SET LOCAL lock_timeout = '5s';
CREATE OR REPLACE FUNCTION booking.gn_recipient_in_scope(p_email text) RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, booking AS $$
  SELECT coalesce(length(p_email) <= 254 AND CASE
    WHEN (SELECT count(*) = 1 AND min(environment) = 'live' FROM booking.instance)
      THEN p_email ~ '^[A-Za-z0-9._%+-]{1,64}@([A-Za-z0-9-]{1,63}\.)+[A-Za-z]{2,24}$' AND p_email !~* '\.invalid$' AND lower(p_email) <> 'delivered@resend.dev'
    ELSE p_email ~ '^[a-z0-9._+-]{1,64}@([a-z0-9-]{1,63}\.)+invalid$' OR p_email = 'delivered@resend.dev'
  END, false)
$$;
