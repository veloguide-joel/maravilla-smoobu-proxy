-- e7-0022-0023-inventory.sql — PURE READ-ONLY schema-identity inventory of schema booking for the 0022 + 0023 apply packet (C46), shared VERBATIM by the
-- pin derivation (claude/derive-0022-0023-pins.mjs), the apply wrapper (embedded) and the readback. LABELLED SPECIALISATION of the accepted
-- claude/e7-0021-inventory.sql: every generic identity probe (functions .. is_privileged_config) is copied byte-for-byte; ADDED `relations` (every
-- booking relation by name + kind, read from the catalog, so a new / missing child relation of any kind changes the identity); `prerequisite_0021`,
-- `objects`, `acls` and `migrations` specialised to 0022 (gn-v2 render support) + 0023 (gn-v2 Resend receipts). Independent of OIDs / search_path.
-- No row data, no guest field, no credential. Returns ONE jsonb.
SELECT jsonb_build_object(
  'functions', (SELECT encode(sha256(convert_to(coalesce(string_agg(
        s.nspname || '.' || p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')' || '|' || encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex')
        || '|' || coalesce(to_jsonb(p.proconfig)::text, 'null') || '|' || coalesce(p.proacl::text, '') || '|' || p.prosecdef::text || '|' || p.provolatile::text || '|' || p.prokind::text
        || '|' || pg_catalog.pg_get_userbyid(p.proowner) || '|' || pg_catalog.format_type(p.prorettype, NULL) || '|' || l.lanname,
        E'\n' ORDER BY s.nspname || '.' || p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')'), ''), 'UTF8')), 'hex')
      FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace s ON s.oid = p.pronamespace JOIN pg_catalog.pg_language l ON l.oid = p.prolang WHERE s.nspname = 'booking'),
  'function_count', (SELECT count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'booking'),
  'triggers', (SELECT encode(sha256(convert_to(coalesce(string_agg(c.relname || '|' || t.tgname || '|' || t.tgenabled::text || '|' || pg_catalog.pg_get_triggerdef(t.oid), E'\n' ORDER BY c.relname, t.tgname), ''), 'UTF8')), 'hex')
      FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid JOIN pg_catalog.pg_namespace s ON s.oid = c.relnamespace WHERE s.nspname = 'booking' AND NOT t.tgisinternal),
  'trigger_count', (SELECT count(*) FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid JOIN pg_catalog.pg_namespace s ON s.oid = c.relnamespace WHERE s.nspname = 'booking' AND NOT t.tgisinternal),
  'constraints', (SELECT encode(sha256(convert_to(coalesce(string_agg(c.relname || '|' || k.conname || '|' || k.contype::text || '|' || pg_catalog.pg_get_constraintdef(k.oid), E'\n' ORDER BY c.relname, k.conname), ''), 'UTF8')), 'hex')
      FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_class c ON c.oid = k.conrelid JOIN pg_catalog.pg_namespace s ON s.oid = c.relnamespace WHERE s.nspname = 'booking'),
  'indexes', (SELECT encode(sha256(convert_to(coalesce(string_agg(tablename || '|' || indexname || '|' || indexdef, E'\n' ORDER BY tablename, indexname), ''), 'UTF8')), 'hex')
      FROM pg_catalog.pg_indexes WHERE schemaname = 'booking'),
  'columns', (SELECT encode(sha256(convert_to(coalesce(string_agg(table_name || '|' || column_name || '|' || data_type || '|' || coalesce(column_default, '') || '|' || is_nullable, E'\n' ORDER BY table_name, ordinal_position), ''), 'UTF8')), 'hex')
      FROM information_schema.columns WHERE table_schema = 'booking'),
  -- table ACLs, CANONICAL and portable across the reviewed PG16 / PG17 owner-default difference (PG17 adds MAINTAIN `m` to the OWNER's default aclitem only):
  -- the owner's own aclitem is reduced to the marker `owner`; EVERY non-owner aclitem is kept verbatim (grantee=privileges/grantor), so any widened or
  -- extra non-owner grant (incl. a MAINTAIN grant to a non-owner) still changes the fingerprint; a NULL relacl (no explicit grants) is kept as `-`.
  'table_acls', (SELECT encode(sha256(convert_to(coalesce(string_agg(c.relname || '|' || coalesce((SELECT string_agg(CASE WHEN split_part(a.item, '=', 1) = pg_catalog.pg_get_userbyid(c.relowner) THEN 'owner' ELSE a.item END, ','
        ORDER BY CASE WHEN split_part(a.item, '=', 1) = pg_catalog.pg_get_userbyid(c.relowner) THEN 'owner' ELSE a.item END) FROM (SELECT unnest(c.relacl)::text AS item) a), '-'), E'\n' ORDER BY c.relname), ''), 'UTF8')), 'hex')
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace s ON s.oid = c.relnamespace WHERE s.nspname = 'booking' AND c.relkind IN ('r', 'p', 'v')),
  -- the accepted RLS boundary: per-table relrowsecurity / relforcerowsecurity and EVERY policy (name, permissive, roles, command, USING, WITH CHECK)
  'rls', (SELECT encode(sha256(convert_to(coalesce(string_agg(c.relname || '|' || c.relrowsecurity::text || '|' || c.relforcerowsecurity::text, E'\n' ORDER BY c.relname), ''), 'UTF8')), 'hex')
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace s ON s.oid = c.relnamespace WHERE s.nspname = 'booking' AND c.relkind IN ('r', 'p')),
  'rls_enabled_count', (SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace s ON s.oid = c.relnamespace WHERE s.nspname = 'booking' AND c.relkind IN ('r', 'p') AND c.relrowsecurity),
  'policies', (SELECT encode(sha256(convert_to(coalesce(string_agg(tablename || '|' || policyname || '|' || permissive || '|' || coalesce(array_to_string(roles, ','), '') || '|' || cmd || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''), E'\n' ORDER BY tablename, policyname), ''), 'UTF8')), 'hex')
      FROM pg_catalog.pg_policies WHERE schemaname = 'booking'),
  'policy_count', (SELECT count(*) FROM pg_catalog.pg_policies WHERE schemaname = 'booking'),
  'schema_owner', (SELECT pg_catalog.pg_get_userbyid(nspowner) FROM pg_catalog.pg_namespace WHERE nspname = 'booking'),
  'is_privileged_src', (SELECT encode(sha256(convert_to(prosrc, 'UTF8')), 'hex') FROM pg_catalog.pg_proc WHERE oid = 'booking.is_privileged()'::regprocedure),
  'is_privileged_config', (SELECT to_jsonb(proconfig) FROM pg_catalog.pg_proc WHERE oid = 'booking.is_privileged()'::regprocedure),
  'relations', (SELECT encode(sha256(convert_to(coalesce(string_agg(c.relname || '|' || c.relkind::text, E'\n' ORDER BY c.relname), ''), 'UTF8')), 'hex')
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace s ON s.oid = c.relnamespace WHERE s.nspname = 'booking' AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')),
  'relation_count', (SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace s ON s.oid = c.relnamespace WHERE s.nspname = 'booking' AND c.relkind IN ('r', 'p')),
  'test_cleanup_pending_state', booking.is_intent_state('test_cleanup_pending'),
  'prerequisite_0021', jsonb_build_object(
    'suppress_guest_notification', to_regprocedure('booking.suppress_guest_notification(uuid,text)') IS NOT NULL,
    'notification_suppressions', to_regclass('booking.notification_suppressions') IS NOT NULL,
    'recorded_state_cleanup_ok', to_regprocedure('booking.recorded_state_cleanup_ok(uuid)') IS NOT NULL,
    'claim_guest_notification_0016', to_regprocedure('booking.claim_guest_notification(uuid,text,text,text,text,text)') IS NOT NULL,
    'complete_guest_notification_0016', to_regprocedure('booking.complete_guest_notification(uuid,text,text,text,text)') IS NOT NULL,
    'guest_notification_presend', to_regprocedure('booking.guest_notification_presend(uuid,text)') IS NOT NULL,
    'notify_op_fence', to_regprocedure('booking.notify_op_fence()') IS NOT NULL),
  'objects', jsonb_build_object(
    'renders_locale_column', EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'booking' AND table_name = 'notification_renders' AND column_name = 'locale'),
    'renders_copy_contract_column', EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'booking' AND table_name = 'notification_renders' AND column_name = 'copy_contract_version'),
    'renders_version_binding', EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'notification_renders_version_binding' AND conrelid = 'booking.notification_renders'::regclass),
    'claim_guest_notification_v2', to_regprocedure('booking.claim_guest_notification_v2(uuid,text,text,text,text,text)') IS NOT NULL,
    'notification_provider_receipts', to_regclass('booking.notification_provider_receipts') IS NOT NULL,
    'notification_provider_receipt_binding', to_regprocedure('booking.notification_provider_receipt_binding()') IS NOT NULL,
    'complete_guest_notification_resend', to_regprocedure('booking.complete_guest_notification_resend(uuid,text,text,uuid,boolean,text)') IS NOT NULL,
    'trg_receipts_append_only', EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid JOIN pg_catalog.pg_namespace s ON s.oid = c.relnamespace
        WHERE s.nspname = 'booking' AND c.relname = 'notification_provider_receipts' AND t.tgname = 'notification_provider_receipts_append_only'),
    'trg_receipts_no_truncate', EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid JOIN pg_catalog.pg_namespace s ON s.oid = c.relnamespace
        WHERE s.nspname = 'booking' AND c.relname = 'notification_provider_receipts' AND t.tgname = 'notification_provider_receipts_no_truncate'),
    'trg_receipts_binding', EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid JOIN pg_catalog.pg_namespace s ON s.oid = c.relnamespace
        WHERE s.nspname = 'booking' AND c.relname = 'notification_provider_receipts' AND t.tgname = 'notification_provider_receipts_binding'),
    'policy_receipts_app_admin_read', EXISTS (SELECT 1 FROM pg_catalog.pg_policies WHERE schemaname = 'booking' AND tablename = 'notification_provider_receipts' AND policyname = 'app_admin_read')),
  'acls', (SELECT jsonb_object_agg(f.sig, f.acl) FROM (
      SELECT s.nspname || '.' || p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')' AS sig,
             (SELECT to_jsonb(array_agg(a::text ORDER BY a::text)) FROM unnest(p.proacl) a) AS acl
        FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace s ON s.oid = p.pronamespace
       WHERE s.nspname = 'booking' AND p.proname IN ('claim_guest_notification_v2', 'guest_notification_presend', 'complete_guest_notification_resend', 'notification_provider_receipt_binding',
                                                    'notify_op_fence', 'claim_guest_notification', 'complete_guest_notification', 'suppress_guest_notification', 'notification_suppressions_bound',
                                                    'notify_suppression_audit_required', 'claim_notification_work', 'release_notification_work', 'recover_expired_notifications',
                                                    'guest_notification_snapshot', 'is_privileged', 'is_intent_state', 'reject_change')) f),
  'migrations', (SELECT jsonb_build_object('count', count(*), 'min', min(version), 'max', max(version), 'all_env_test', bool_and(environment = 'test'),
      'aggregate', encode(sha256(convert_to(string_agg(version || ':' || name || ':' || up_checksum || ':' || down_checksum, E'\n' ORDER BY version), 'UTF8')), 'hex'),
      'aggregate_1_21', (SELECT encode(sha256(convert_to(string_agg(version || ':' || name || ':' || up_checksum || ':' || down_checksum, E'\n' ORDER BY version), 'UTF8')), 'hex') FROM booking_migrations.applied WHERE version <= 21),
      'v22', (SELECT to_jsonb(x) FROM (SELECT version, name, up_checksum, down_checksum, environment FROM booking_migrations.applied WHERE version = 22) x),
      'v23', (SELECT to_jsonb(x) FROM (SELECT version, name, up_checksum, down_checksum, environment FROM booking_migrations.applied WHERE version = 23) x)) FROM booking_migrations.applied)
) AS e7_inventory
