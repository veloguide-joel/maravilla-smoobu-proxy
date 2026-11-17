-- 0025_gn_sink_recipient_scope (down) — DISPOSABLE LOCAL test databases only. Restores the EXACT 0016 body of booking.gn_recipient_in_scope
-- (`.invalid` only), in place (CREATE OR REPLACE: same OID / owner / ACL / attributes). Removes no data: a notification already rendered, claimed,
-- sent or receipted for the sink stays as durable evidence; it is merely out of scope again for any NEW admission.
CREATE OR REPLACE FUNCTION booking.gn_recipient_in_scope(p_email text) RETURNS boolean
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog, booking AS $$
  SELECT coalesce(length(p_email) <= 254 AND p_email ~ '^[a-z0-9._+-]{1,64}@([a-z0-9-]{1,63}\.)+invalid$', false)
$$;
