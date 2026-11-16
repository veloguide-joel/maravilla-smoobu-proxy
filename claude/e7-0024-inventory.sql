-- e7-0024-inventory.sql — PURE READ-ONLY schema-identity inventory of schema booking for the 0024-only apply packet (C112a), shared VERBATIM by the
-- pin derivation (claude/derive-0024-pins.mjs), the apply wrapper (embedded) and the readback. LABELLED SPECIALISATION of the accepted
-- claude/e7-0022-0023-inventory.sql: every generic identity probe (functions .. relation_count, test_cleanup_pending_state) is copied byte-for-byte;
-- `prerequisite_0023`, `objects`, `acls` and `migrations` are specialised to 0024 (pipeline kickoff requests). Independent of OIDs / search_path.
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
  'prerequisite_0023', jsonb_build_object(
    'notification_provider_receipts', to_regclass('booking.notification_provider_receipts') IS NOT NULL,
    'complete_guest_notification_resend', to_regprocedure('booking.complete_guest_notification_resend(uuid,text,text,uuid,boolean,text)') IS NOT NULL,
    'claim_guest_notification_v2', to_regprocedure('booking.claim_guest_notification_v2(uuid,text,text,text,text,text)') IS NOT NULL,
    'intents', to_regclass('booking.intents') IS NOT NULL,
    'reconciliation_cases', to_regclass('booking.reconciliation_cases') IS NOT NULL),
  'objects', jsonb_build_object(
    'pipeline_kickoff_requests', to_regclass('booking.pipeline_kickoff_requests') IS NOT NULL,
    'pipeline_kickoff_requests_requested_idx', to_regclass('booking.pipeline_kickoff_requests_requested') IS NOT NULL,
    'pipeline_kickoff_guard', to_regprocedure('booking.pipeline_kickoff_guard()') IS NOT NULL,
    'pipeline_kickoff_excluded', to_regprocedure('booking.pipeline_kickoff_excluded(uuid)') IS NOT NULL,
    'pipeline_kickoff_record', to_regprocedure('booking.pipeline_kickoff_record()') IS NOT NULL,
    'pipeline_kickoff_refusal', EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'booking' AND p.proname = 'pipeline_kickoff_refusal'),
    'claim_pipeline_kickoff', to_regprocedure('booking.claim_pipeline_kickoff(uuid,text,text,jsonb)') IS NOT NULL,
    'refuse_pipeline_kickoff', to_regprocedure('booking.refuse_pipeline_kickoff(uuid,text)') IS NOT NULL,
    'settle_pipeline_kickoff', to_regprocedure('booking.settle_pipeline_kickoff(uuid,text,text,text)') IS NOT NULL,
    'trg_requests_guard', EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid JOIN pg_catalog.pg_namespace s ON s.oid = c.relnamespace
        WHERE s.nspname = 'booking' AND c.relname = 'pipeline_kickoff_requests' AND t.tgname = 'pipeline_kickoff_requests_guard' AND t.tgenabled = 'O'),
    'trg_requests_no_delete', EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid JOIN pg_catalog.pg_namespace s ON s.oid = c.relnamespace
        WHERE s.nspname = 'booking' AND c.relname = 'pipeline_kickoff_requests' AND t.tgname = 'pipeline_kickoff_requests_no_delete' AND t.tgenabled = 'O'),
    'trg_requests_no_truncate', EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid JOIN pg_catalog.pg_namespace s ON s.oid = c.relnamespace
        WHERE s.nspname = 'booking' AND c.relname = 'pipeline_kickoff_requests' AND t.tgname = 'pipeline_kickoff_requests_no_truncate' AND t.tgenabled = 'O'),
    'trg_intents_pipeline_kickoff', EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid JOIN pg_catalog.pg_namespace s ON s.oid = c.relnamespace
        WHERE s.nspname = 'booking' AND c.relname = 'intents' AND t.tgname = 'intents_pipeline_kickoff' AND t.tgenabled = 'O'),
    'policy_requests_app_admin_read', EXISTS (SELECT 1 FROM pg_catalog.pg_policies WHERE schemaname = 'booking' AND tablename = 'pipeline_kickoff_requests' AND policyname = 'app_admin_read')),
  'acls', (SELECT jsonb_object_agg(f.sig, f.acl) FROM (
      SELECT s.nspname || '.' || p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')' AS sig,
             (SELECT to_jsonb(array_agg(a::text ORDER BY a::text)) FROM unnest(p.proacl) a) AS acl
        FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace s ON s.oid = p.pronamespace
       WHERE s.nspname = 'booking' AND p.proname IN ('claim_pipeline_kickoff', 'refuse_pipeline_kickoff', 'settle_pipeline_kickoff', 'pipeline_kickoff_record', 'pipeline_kickoff_refusal',
                                                    'pipeline_kickoff_excluded', 'pipeline_kickoff_guard', 'claim_guest_notification_v2', 'complete_guest_notification_resend',
                                                    'notification_provider_receipt_binding', 'guest_notification_presend', 'is_privileged', 'is_intent_state', 'reject_change')) f),
  'migrations', (SELECT jsonb_build_object('count', count(*), 'min', min(version), 'max', max(version), 'all_env_test', bool_and(environment = 'test'),
      'aggregate', encode(sha256(convert_to(string_agg(version || ':' || name || ':' || up_checksum || ':' || down_checksum, E'\n' ORDER BY version), 'UTF8')), 'hex'),
      'aggregate_1_23', (SELECT encode(sha256(convert_to(string_agg(version || ':' || name || ':' || up_checksum || ':' || down_checksum, E'\n' ORDER BY version), 'UTF8')), 'hex') FROM booking_migrations.applied WHERE version <= 23),
      'v24', (SELECT to_jsonb(x) FROM (SELECT version, name, up_checksum, down_checksum, environment FROM booking_migrations.applied WHERE version = 24) x)) FROM booking_migrations.applied)
) AS e7_inventory
