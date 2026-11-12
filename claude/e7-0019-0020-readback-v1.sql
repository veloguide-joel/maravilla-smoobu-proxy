-- e7-0019-0020-readback-v1.sql — PURE READ-ONLY. Run it BEFORE and AFTER the 0019+0020 apply wrapper and compare the JSON with the pins
-- (claude/e7-0019-0020-pins-v1.json: `pre` must equal the BEFORE identity keys, `post` the AFTER; table_acls is canonical over the PG16 / PG17 owner
-- MAINTAIN default, rls / policies cover the accepted RLS boundary). It writes nothing, takes no lock (the advisory
-- probe only READS pg_locks), returns no guest field or credential. SCHEMA-OWNER ONLY in practice (booking_migrations has no app/admin/report USAGE).
-- `identity` = claude/e7-0019-0020-inventory.sql verbatim (sha256 891f3e2521dba0910739a93966c5392ecbee512d4a1e0138d2f6467103aab29d); `exclusion` shows why an apply would refuse now
-- (active hosted-run lock, work / intent / operation leases, in-flight writes, 0019 vocabulary already present); `booking_tables_fingerprint`
-- must be IDENTICAL before and after (zero booking-row writes).
-- Expected BEFORE: identity.functions = 47e3409b3ca867cd8e36728b2e3d293ad0d963bf6c600b7e56345d4c3fe19b5e, migrations.max = 18, aggregate = a46acad20b6f259b07ee7749e5f2954ee4e7f9aa13caf8fc866a281d79ab351e, every identity.objects = false.
-- Expected AFTER:  identity.functions = 5ad41abbb9cac6245b25b0f0f979171cbc44c4824866cba398c23d1b0a96a086, migrations.max = 20 with exactly the two added rows (v19 up 734bbb221a2f6700a14b38d49960e62ecc16fe231d3a2712df41a520a13e886a, v20 up 23af20d7103d9019deefe5ac5c0d9947c6faa818309d7635256ffd3d26a9d004),
--                  aggregate_1_18 unchanged, every identity.objects = true, test_cleanup_pending_state = true, booking_tables_fingerprint identical.
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
                 'test_cleanup_pending_state', booking.is_intent_state('test_cleanup_pending'),
                 'objects', jsonb_build_object(
                   'test_refund_pi_observation_ok', to_regprocedure('booking.test_refund_pi_observation_ok(jsonb,uuid,text,text,bigint,text)') IS NOT NULL,
                   'test_refund_settled_for', to_regprocedure('booking.test_refund_settled_for(uuid,text)') IS NOT NULL,
                   'test_refund_ledgered', to_regprocedure('booking.test_refund_ledgered(uuid,text)') IS NOT NULL,
                   'test_cleanup_cancel_bound', to_regprocedure('booking.test_cleanup_cancel_bound()') IS NOT NULL,
                   'refund_claim_fence', to_regprocedure('booking.refund_claim_fence()') IS NOT NULL,
                   'recording_retirement_fence', to_regprocedure('booking.recording_retirement_fence()') IS NOT NULL,
                   'settle_test_refund_from_evidence', to_regprocedure('booking.settle_test_refund_from_evidence(uuid,uuid)') IS NOT NULL,
                   'trg_test_cleanup_cancel_bound', EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgname = 'external_operations_test_cleanup_cancel_bound' AND tgrelid = 'booking.external_operations'::regclass),
                   'trg_refund_claim_fence', EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgname = 'external_operations_refund_claim_fence' AND tgrelid = 'booking.external_operations'::regclass),
                   'trg_recording_retirement_fence', EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgname = 'zy_recording_retirement_fence' AND tgrelid = 'booking.external_operations'::regclass),
                   'idx_one_refund_ever', to_regclass('booking.external_operations_one_refund_ever') IS NOT NULL),
                 'acls', (SELECT jsonb_object_agg(f.sig, f.acl) FROM (
                     SELECT s.nspname || '.' || p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')' AS sig,
                            (SELECT to_jsonb(array_agg(a::text ORDER BY a::text)) FROM unnest(p.proacl) a) AS acl
                       FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace s ON s.oid = p.pronamespace
                      WHERE s.nspname = 'booking' AND p.proname IN ('test_refund_pi_observation_ok', 'test_refund_settled_for', 'test_refund_ledgered', 'test_cleanup_cancel_bound',
                                                                   'refund_claim_fence', 'recording_retirement_fence', 'settle_test_refund_from_evidence', 'settle_operation_from_evidence',
                                                                   'authorization_blockers', 'claim_release_blockers', 'intents_safety_guard', 'void_cancel_claim_fence', 'validate_evidence', 'record_provider_evidence', 'is_intent_state')) f),
                 'migrations', (SELECT jsonb_build_object('count', count(*), 'min', min(version), 'max', max(version), 'all_env_test', bool_and(environment = 'test'),
                     'aggregate', encode(sha256(convert_to(string_agg(version || ':' || name || ':' || up_checksum || ':' || down_checksum, E'\n' ORDER BY version), 'UTF8')), 'hex'),
                     'aggregate_1_18', (SELECT encode(sha256(convert_to(string_agg(version || ':' || name || ':' || up_checksum || ':' || down_checksum, E'\n' ORDER BY version), 'UTF8')), 'hex') FROM booking_migrations.applied WHERE version <= 18),
                     'v19', (SELECT to_jsonb(x) FROM (SELECT version, name, up_checksum, down_checksum, environment FROM booking_migrations.applied WHERE version = 19) x),
                     'v20', (SELECT to_jsonb(x) FROM (SELECT version, name, up_checksum, down_checksum, environment FROM booking_migrations.applied WHERE version = 20) x)) FROM booking_migrations.applied)
               )),
  'instance', (SELECT jsonb_build_object('rows', count(*), 'environment', min(environment)) FROM booking.instance),
  'current_user', current_user::text,
  'exclusion', jsonb_build_object(
    'hosted_run_lock_held', EXISTS (SELECT 1 FROM pg_catalog.pg_locks l WHERE l.locktype = 'advisory' AND l.granted AND l.database = (SELECT d.oid FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database()) AND l.classid = ((pg_catalog.hashtext('e7-connected-runner')::bigint + 4294967296) % 4294967296)::oid AND l.objid = 0::oid AND l.objsubid = 2),
    'work_leases', (SELECT count(*) FROM booking.intent_work WHERE work_worker_id IS NOT NULL OR work_lease_until IS NOT NULL),
    'intent_leases', (SELECT count(*) FROM booking.intents WHERE lease_worker_id IS NOT NULL OR lease_until IS NOT NULL),
    'operation_leases_or_in_flight', (SELECT count(*) FROM booking.external_operations WHERE lease_worker_id IS NOT NULL OR lease_until IS NOT NULL OR state = 'in_flight'),
    'vocabulary_rows', (SELECT (SELECT count(*) FROM booking.intents WHERE state = 'test_cleanup_pending') + (SELECT count(*) FROM booking.external_operations WHERE op_type IN ('stripe.refund_payment_intent', 'stripe.retrieve_refund'))
                        + (SELECT count(*) FROM booking.provider_evidence WHERE kind = 'stripe_refund') + (SELECT count(*) FROM booking.payment_refunds WHERE hostaway_state = 'not_applicable'))),
  'booking_tables_fingerprint', (SELECT jsonb_object_agg(t.relname, x.v) FROM pg_class t JOIN pg_namespace s ON s.oid = t.relnamespace, LATERAL (SELECT (xpath('/row/v/text()', query_to_xml(format('SELECT count(*) || '':'' || md5(coalesce(string_agg(x::text, E''\n'' ORDER BY x::text), '''')) AS v FROM booking.%I x', t.relname), false, true, '')))[1]::text AS v) x WHERE s.nspname = 'booking' AND t.relkind IN ('r', 'p'))
) AS e7_1920_readback;
