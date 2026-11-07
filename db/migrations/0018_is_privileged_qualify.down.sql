-- 0018_is_privileged_qualify (down) — DISPOSABLE LOCAL test databases only.
-- Restores booking.is_privileged() to the 0003 definition byte-for-byte (owner and ACL unchanged by CREATE OR REPLACE).
CREATE OR REPLACE FUNCTION booking.is_privileged() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT current_user::text = (SELECT pg_get_userbyid(nspowner)::text FROM pg_namespace WHERE nspname = 'booking')
$$;
