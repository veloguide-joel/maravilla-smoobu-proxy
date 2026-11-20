-- 0030 down: restores the EXACT 0025 body and attributes of booking.gn_recipient_in_scope (IMMUTABLE; `.invalid` or the sink), in place.
-- Removes no data.
SET LOCAL lock_timeout = '5s';
CREATE OR REPLACE FUNCTION booking.gn_recipient_in_scope(p_email text) RETURNS boolean
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog, booking AS $$
  SELECT coalesce(length(p_email) <= 254 AND (p_email ~ '^[a-z0-9._+-]{1,64}@([a-z0-9-]{1,63}\.)+invalid$' OR p_email = 'delivered@resend.dev'), false)
$$;
