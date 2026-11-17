-- e7-0025-0026-readback-v1.sql — PURE READ-ONLY (C116). Run it BEFORE and AFTER the 0025 + 0026 apply wrapper and compare with the pins
-- (claude/e7-0025-0026-pins-v1.json: `pre` must equal the BEFORE identity keys, `post` the AFTER). LABELLED SPECIALISATION of the accepted
-- claude/e7-0024-readback-v1.sql. Writes nothing, takes no lock, returns only counts / hashes / flags (no guest field, no credential). Schema owner.
-- `identity` = claude/e7-0025-0026-inventory.sql verbatim (sha256 b911b4d543dcf180136b3da791a69c16154e137bd0fe40c6589f4a65402d91ed).
-- `exclusion` shows why an apply would refuse now. `data` must be IDENTICAL before and after: per-table count + whole-row fingerprint over EVERY
-- booking table (incl. pipeline_kickoff_requests and the notification tables), the intent id set, the whole 0001-0024 history rows, and the sanitized
-- protected-reservation / historical-intent fingerprints (counts + md5 only). `kickoff_catalog` BEFORE == pins.kickoffCatalogPre (the 0024 packet's
-- pins); AFTER == pins.kickoffCatalogPins (= scripts/e7-hosted-kickoff.mjs CATALOG_PINS on main adacbdad, evaluated for mv_booking_app).
-- Expected BEFORE: identity.functions = 8e73bb25c38f0a6e32566483c9a6cf57a6faa9f5feebdee34ec381564265304d, migrations.max = 24, aggregate = bcd453f800c037e978138d5d6bf979baaa00b46cbe807fb7aca8281a9cacc7f2,
--                  claim_literal = original, sink_scope = {"sink": false, "lookalike": false, "invalid_scope": true}.
-- Expected AFTER:  identity.functions = bf0085e31e7cd75feefd20ea930bb4220d895c2a1135bd587e94ca9ad502d3b5, migrations.max = 26, aggregate = 3dae7c0df75f4f51c4acdec3d79af4bb35050ee1d49c23c47e36b05f3d469ab1, aggregate_1_24 unchanged,
--                  v25 up 160127cf57c65a7d370515c3a5a48384fa4061b03358d3c2ec5d8c72ca4612c3, v26 up 4ad443e635b716a73bd22bd99c3e04cd5781d8a8aeef4fb2fa596e380fc58528, claim_literal = rebound, sink_scope = {"sink": true, "lookalike": false, "invalid_scope": true},
--                  `data` identical.
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
                                                                   'notification_provider_receipt_binding', 'guest_notification_presend', 'is_privileged', 'is_intent_state', 'reject_change',
                                                                   'gn_recipient_in_scope')) f),
                 'migrations', (SELECT jsonb_build_object('count', count(*), 'min', min(version), 'max', max(version), 'all_env_test', bool_and(environment = 'test'),
                     'aggregate', encode(sha256(convert_to(string_agg(version || ':' || name || ':' || up_checksum || ':' || down_checksum, E'\n' ORDER BY version), 'UTF8')), 'hex'),
                     'aggregate_1_24', (SELECT encode(sha256(convert_to(string_agg(version || ':' || name || ':' || up_checksum || ':' || down_checksum, E'\n' ORDER BY version), 'UTF8')), 'hex') FROM booking_migrations.applied WHERE version <= 24),
                     'v25', (SELECT to_jsonb(x) FROM (SELECT version, name, up_checksum, down_checksum, environment FROM booking_migrations.applied WHERE version = 25) x),
                     'v26', (SELECT to_jsonb(x) FROM (SELECT version, name, up_checksum, down_checksum, environment FROM booking_migrations.applied WHERE version = 26) x)) FROM booking_migrations.applied)
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
    'booking_tables', (SELECT jsonb_object_agg(t.relname, x.v ORDER BY t.relname) FROM pg_catalog.pg_class t JOIN pg_catalog.pg_namespace s ON s.oid = t.relnamespace, LATERAL (SELECT (xpath('/row/v/text()', query_to_xml(format('SELECT count(*) || '':'' || md5(coalesce(string_agg(q.r, E''\n'' ORDER BY q.r), '''')) AS v FROM (SELECT (to_jsonb(x) - %L::text[])::text AS r FROM booking.%I x) q', ARRAY(SELECT jsonb_array_elements_text(coalesce('{}'::jsonb -> t.relname::text, '[]'::jsonb))), t.relname), false, true, '')))[1]::text AS v) x WHERE s.nspname = 'booking' AND t.relkind IN ('r', 'p')),
    'intent_ids', (SELECT count(*) || ':' || encode(sha256(convert_to(coalesce(string_agg(i.id::text, ',' ORDER BY i.id), ''), 'UTF8')), 'hex') FROM booking.intents i),
    'history_rows_1_24', (SELECT count(*) || ':' || md5(coalesce(string_agg(to_jsonb(a)::text, E'\n' ORDER BY a.version), '')) FROM booking_migrations.applied a WHERE a.version <= 24),
    'protected_reservations', (SELECT count(*) || ':' || md5(coalesce(string_agg(to_jsonb(i)::text, E'\n' ORDER BY i.id), '')) FROM booking.intents i WHERE i.hostaway_reservation_id::text IN ('70636076', '71045356', '71072615', '71081885')),
    'historical_intents', (SELECT count(*) || ':' || md5(coalesce(string_agg(to_jsonb(i)::text, E'\n' ORDER BY i.id), '')) FROM booking.intents i WHERE i.id::text IN ('abede8b1-8ef6-44f2-876e-6a02fc056a96', 'c83c1842-d342-4e27-9ab7-dc3d50b7a309', '954d476c-71ea-4824-92f6-2220ae302103', '669da884-02e8-4105-8825-f908e5d22ae9', '1d6e770f-ba3d-40f7-92c1-ee01be7da532'))),
  'kickoff_rows', (SELECT count(*) FROM booking.pipeline_kickoff_requests),
  'kickoff_catalog', jsonb_build_object('functions', (SELECT jsonb_agg(jsonb_build_object('sig', p.oid::regprocedure::text, 'src', md5(p.prosrc), 'secdef', p.prosecdef, 'vol', p.provolatile::text, 'cfg', coalesce(array_to_string(p.proconfig, ','), ''), 'acl', coalesce((SELECT string_agg(a.grantee::regrole::text || ':' || a.privilege_type, ',' ORDER BY a.grantee::regrole::text, a.privilege_type) FROM aclexplode(p.proacl) a WHERE a.grantee <> p.proowner), '')) ORDER BY x.n) FROM unnest(ARRAY['booking.claim_pipeline_kickoff(uuid,text,text,jsonb)', 'booking.refuse_pipeline_kickoff(uuid,text)', 'booking.settle_pipeline_kickoff(uuid,text,text,text)', 'booking.pipeline_kickoff_record()', 'booking.pipeline_kickoff_refusal(booking.intents,booking.pipeline_kickoff_requests)', 'booking.pipeline_kickoff_excluded(uuid)', 'booking.pipeline_kickoff_guard()']) WITH ORDINALITY AS x(s, n) JOIN pg_catalog.pg_proc p ON p.oid = to_regprocedure(x.s)), 'table', (SELECT jsonb_build_object('rls', c.relrowsecurity, 'sel', has_table_privilege('mv_booking_app', c.oid, 'SELECT'), 'ins', has_table_privilege('mv_booking_app', c.oid, 'INSERT'), 'upd', has_table_privilege('mv_booking_app', c.oid, 'UPDATE'), 'del', has_table_privilege('mv_booking_app', c.oid, 'DELETE'), 'trg', (SELECT count(*)::int FROM pg_catalog.pg_trigger g WHERE g.tgrelid = 'booking.intents'::regclass AND g.tgname = 'intents_pipeline_kickoff' AND g.tgfoid = to_regprocedure('booking.pipeline_kickoff_record()') AND g.tgenabled = 'O')) FROM pg_catalog.pg_class c WHERE c.oid = to_regclass('booking.pipeline_kickoff_requests'))),
  'claim_literal', (SELECT CASE WHEN position('880db5b33024edbf0879fbaf5a3826e3622db12fd1808e8c2047238da507fe1b' in p.prosrc) > 0 AND position('f09bcbbdfac88ca8dfd212a386d2af03698f9b710a49189b0ac9262531510999' in p.prosrc) = 0 THEN 'rebound' WHEN position('f09bcbbdfac88ca8dfd212a386d2af03698f9b710a49189b0ac9262531510999' in p.prosrc) > 0 AND position('880db5b33024edbf0879fbaf5a3826e3622db12fd1808e8c2047238da507fe1b' in p.prosrc) = 0 THEN 'original' ELSE 'other' END FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('booking.claim_pipeline_kickoff(uuid,text,text,jsonb)')),
  'sink_scope', jsonb_build_object('sink', booking.gn_recipient_in_scope('delivered@resend.dev'), 'lookalike', booking.gn_recipient_in_scope('delivered+x@resend.dev'), 'invalid_scope', booking.gn_recipient_in_scope('guest@example.invalid'))
) AS e7_2526_readback;
