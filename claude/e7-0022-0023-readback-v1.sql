-- e7-0022-0023-readback-v1.sql — PURE READ-ONLY (C46). Run it BEFORE and AFTER the 0022 + 0023 apply wrapper and compare with the pins
-- (claude/e7-0022-0023-pins-v1.json: `pre` must equal the BEFORE identity keys, `post` the AFTER). LABELLED SPECIALISATION of the accepted
-- claude/e7-0021-readback-v1.sql. Writes nothing, takes no lock, returns only counts / hashes / flags (no guest field, no credential). Schema owner.
-- `identity` = claude/e7-0022-0023-inventory.sql verbatim (sha256 900df66e9d2becba43f36d65c66818cc18d483f4ce48404c17c6fd70481ad778).
-- `exclusion` shows why an apply would refuse now. `data` must be IDENTICAL before and after: per-table count + whole-row fingerprint over the PRE
-- column / table set (0022's two render columns removed; the new receipts table excluded), the original 12 render columns, the intent id set and the
-- whole 0001-0021 history rows. `renders_non_gn_v1_or_meta` must be 0 before AND after; `receipts_rows` null before, 0 after.
-- Expected BEFORE: identity.functions = bc3a24df47ec6ffb9937609979e4db45921bdd4093f8cbac2f65c87b35b2c1cb, migrations.max = 21, aggregate = 5473ec1de85742ebb2f7a3638b1a6a42ae20be219a8a0e637a425861e6698e51, every identity.objects = false.
-- Expected AFTER:  identity.functions = 50a50a7fbea38e8dd59ddd9f1094bcbd776fd465a2053f0430f0f1a4cb03ea84, migrations.max = 23, aggregate = 7df0b8fe542b7f85f43bdaf7138438c71627b7bc88a48104314eeb1482270ef0, aggregate_1_21 unchanged,
--                  v22 up cc878c9473145a7f58dc8ad58b8bb3f198f7a6dab7f7b8f33289ef15c60690b3, v23 up c551539b164b0da7c34577531fd06ad2465dc24cd493eeda0e699ca6e1ba65cb, every identity.objects = true, `data` identical.
SELECT jsonb_build_object(
  'identity', (SELECT jsonb_build_object(
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
               )),
  'instance', (SELECT jsonb_build_object('rows', count(*), 'environment', min(environment)) FROM booking.instance),
  'current_user', current_user::text,
  'exclusion', jsonb_build_object(
    'hosted_run_lock_held', EXISTS (SELECT 1 FROM pg_catalog.pg_locks l WHERE l.locktype = 'advisory' AND l.granted AND l.database = (SELECT d.oid FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database()) AND l.classid = ((pg_catalog.hashtext('e7-connected-runner')::bigint + 4294967296) % 4294967296)::oid AND l.objid = 0::oid AND l.objsubid = 2),
    'work_leases', (SELECT count(*) FROM booking.intent_work WHERE work_worker_id IS NOT NULL OR work_lease_until IS NOT NULL),
    'intent_leases', (SELECT count(*) FROM booking.intents WHERE lease_worker_id IS NOT NULL OR lease_until IS NOT NULL),
    'operation_leases_or_in_flight', (SELECT count(*) FROM booking.external_operations WHERE lease_worker_id IS NOT NULL OR lease_until IS NOT NULL OR state = 'in_flight'),
    'prepared_transactions', (SELECT count(*) FROM pg_catalog.pg_prepared_xacts),
    'other_session_write_locks', (SELECT count(*) FROM pg_catalog.pg_locks l JOIN pg_catalog.pg_class c ON c.oid = l.relation JOIN pg_catalog.pg_namespace s ON s.oid = c.relnamespace WHERE l.locktype = 'relation' AND l.granted AND l.pid <> pg_catalog.pg_backend_pid() AND l.mode <> 'AccessShareLock' AND l.database = (SELECT d.oid FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database()) AND s.nspname IN ('booking', 'booking_migrations'))),
  'data', jsonb_build_object(
    'booking_tables', (SELECT jsonb_object_agg(t.relname, x.v ORDER BY t.relname) FROM pg_catalog.pg_class t JOIN pg_catalog.pg_namespace s ON s.oid = t.relnamespace, LATERAL (SELECT (xpath('/row/v/text()', query_to_xml(format('SELECT count(*) || '':'' || md5(coalesce(string_agg(q.r, E''\n'' ORDER BY q.r), '''')) AS v FROM (SELECT (to_jsonb(x) - %L::text[])::text AS r FROM booking.%I x) q', ARRAY(SELECT jsonb_array_elements_text(coalesce('{"notification_renders":["locale","copy_contract_version"]}'::jsonb -> t.relname::text, '[]'::jsonb))), t.relname), false, true, '')))[1]::text AS v) x WHERE s.nspname = 'booking' AND t.relkind IN ('r', 'p') AND t.relname NOT IN ('notification_provider_receipts')),
    'renders_original_12', (SELECT count(*) || ':' || md5(coalesce(string_agg(row_to_json(q)::text, E'\n' ORDER BY row_to_json(q)::text), '')) FROM (SELECT operation_id, intent_id, template, template_version, intent_version, facts, facts_hash, recipient_hash, content_hash, message_ref, worker, claimed_at FROM booking.notification_renders) q),
    'intent_ids', (SELECT count(*) || ':' || encode(sha256(convert_to(coalesce(string_agg(i.id::text, ',' ORDER BY i.id), ''), 'UTF8')), 'hex') FROM booking.intents i),
    'history_rows_1_21', (SELECT count(*) || ':' || md5(coalesce(string_agg(to_jsonb(a)::text, E'\n' ORDER BY a.version), '')) FROM booking_migrations.applied a WHERE a.version <= 21)),
  'renders_non_gn_v1_or_meta', (SELECT count(*) FROM booking.notification_renders r WHERE r.template_version IS DISTINCT FROM 'gn-v1' OR to_jsonb(r) ->> 'locale' IS NOT NULL OR to_jsonb(r) ->> 'copy_contract_version' IS NOT NULL),
  'receipts_rows', (CASE WHEN to_regclass('booking.notification_provider_receipts') IS NULL THEN NULL ELSE (xpath('/row/v/text()', query_to_xml('SELECT count(*) AS v FROM booking.notification_provider_receipts', false, true, '')))[1]::text::bigint END)
) AS e7_23_readback;
