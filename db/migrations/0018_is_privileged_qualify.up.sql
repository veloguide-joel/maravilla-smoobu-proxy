-- 0018_is_privileged_qualify (up) — DISPOSABLE LOCAL test databases only. LOCAL MIGRATION CANDIDATE (root ruling 2026-11-07).
-- Replaces booking.is_privileged() — baseline definition: db/migrations/0003_safety_corrections.up.sql.
-- Same signature, RETURNS boolean, LANGUAGE sql, STABLE and SECURITY INVOKER (default); CREATE OR REPLACE keeps owner and ACL.
-- Fix: both catalog references are fully schema-qualified (pg_catalog.pg_namespace, pg_catalog.pg_get_userbyid), which is
-- immune to search_path / pg_temp manipulation; a function-local SET search_path = pg_catalog, pg_temp (pg_temp explicit and
-- LAST) is defense in depth and clears the mutable-search_path advisor warning for this function. Semantics are unchanged:
-- true iff current_user owns schema booking (the owner, or inside a schema-owner SECURITY DEFINER function).
CREATE OR REPLACE FUNCTION booking.is_privileged() RETURNS boolean LANGUAGE sql STABLE
  SET search_path = pg_catalog, pg_temp AS $$
  SELECT current_user::text = (SELECT pg_catalog.pg_get_userbyid(n.nspowner)::text
                               FROM pg_catalog.pg_namespace n WHERE n.nspname = 'booking')
$$;
