-- 0025_gn_sink_recipient_scope (up) — Stage E7 C116: admit EXACTLY ONE simulation-sink RECIPIENT beside the v1 `.invalid` scope.
-- Base: schema 24 (0024 applied). DISPOSABLE LOCAL test databases by this task; any shared DEV apply is a separate, reviewed packet.
--
--   * booking.gn_recipient_in_scope(text) is replaced IN PLACE (CREATE OR REPLACE): same name / signature / return type, same LANGUAGE sql,
--     IMMUTABLE, SECURITY INVOKER and SET search_path = pg_catalog, booking. CREATE OR REPLACE keeps the function's OID, OWNER and ACL (the 0016
--     REVOKE ALL … FROM PUBLIC stays in force; NO grant is added). Its two callers (guest_notification_class, guest_notification_refusal) are
--     unchanged and pick the new predicate up by name.
--   * New predicate = the unchanged v1 test (length ≤ 254 AND the exact `.invalid` regex) OR exact equality with 'delivered@resend.dev' (Resend's
--     documented delivery-SIMULATION address). Exact text equality: no lower(), trim, +label, subdomain, trailing dot or look-alike; NULL → false.
--     It mirrors lib/checkout/isRecipientInScope (JS) — the parity is tested on PostgreSQL 16 and 17.
--   * RECIPIENT scope only: no sender rule exists in SQL and none is added; the JS sender checks and the gn-v1 builder are unchanged, so the v1
--     (mock) path still refuses the sink before any claim. No table, row, claim, latch, render, receipt, lifecycle or grant is touched.
--   * HONEST LABEL: admission to the scope is NOT a send permission (the hosted runner, its gates and executeEnabled decide) and provider
--     acceptance at the sink is NOT delivery to any real inbox.
CREATE OR REPLACE FUNCTION booking.gn_recipient_in_scope(p_email text) RETURNS boolean
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog, booking AS $$
  SELECT coalesce(length(p_email) <= 254 AND (p_email ~ '^[a-z0-9._+-]{1,64}@([a-z0-9-]{1,63}\.)+invalid$' OR p_email = 'delivered@resend.dev'), false)
$$;
