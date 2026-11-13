-- e7-0021-readback-v1.sql — PURE READ-ONLY. Run it BEFORE and AFTER the 0021 apply wrapper and compare the JSON with the pins
-- (claude/e7-0021-pins-v1.json: `pre` must equal the BEFORE identity keys, `post` the AFTER; table_acls is canonical over the PG16 / PG17 owner
-- MAINTAIN default, rls / policies cover the accepted RLS boundary). LABELLED SPECIALISATION of the accepted claude/e7-0019-0020-readback-v1.sql. It writes
-- nothing, takes no lock (the advisory probe only READS pg_locks), returns no guest field or credential. SCHEMA-OWNER ONLY in practice.
-- `identity` = claude/e7-0021-inventory.sql verbatim (sha256 c456f8258cb12c111b8fb2fcf75755c3435a1b5924f8b37f1131a2e45c1e20fa); `exclusion` shows why an apply would refuse now
-- (active hosted-run lock, work / intent / operation leases, in-flight writes, 0021 vocabulary already present); `booking_tables_fingerprint`
-- must be IDENTICAL before and after (zero booking-row writes; taken over the PRE column / table set, see the wrapper header). FUTURE PREP: the shared DEV database is at 0018 today (0019 / 0020 not applied).
-- Expected BEFORE: identity.functions = 5ad41abbb9cac6245b25b0f0f979171cbc44c4824866cba398c23d1b0a96a086, migrations.max = 20, aggregate = a1c2821dea03ff5d00777359c35dbc1cc9d420fe29b62220b368d4f47ec0f183, every identity.prerequisite_0020 = true, every identity.objects = false.
-- Expected AFTER:  identity.functions = bc3a24df47ec6ffb9937609979e4db45921bdd4093f8cbac2f65c87b35b2c1cb, migrations.max = 21 with exactly the ONE added row (v21 up 79017a94f1b9d534890a20597edd3be547836808b1bc2b3a3dd6afb60d497db7, down b6a973b4e184e20a3909993f2d31e5db5fdcbe8219cd71be316303812a594557),
--                  aggregate_1_20 unchanged, every identity.objects = true, booking_tables_fingerprint identical.
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
                 'prerequisite_0020', jsonb_build_object(
                   'settle_test_refund_from_evidence', to_regprocedure('booking.settle_test_refund_from_evidence(uuid,uuid)') IS NOT NULL,
                   'test_refund_settled_for', to_regprocedure('booking.test_refund_settled_for(uuid,text)') IS NOT NULL,
                   'recording_retirement_fence', to_regprocedure('booking.recording_retirement_fence()') IS NOT NULL,
                   'notify_op_fence_0016', to_regprocedure('booking.notify_op_fence()') IS NOT NULL),
                 'objects', jsonb_build_object(
                   'mirrored_column', EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'booking' AND table_name = 'intents' AND column_name = 'settlement_recording_mirrored'),
                   'notification_suppressions', to_regclass('booking.notification_suppressions') IS NOT NULL,
                   'offline_refund_proof_refusal', to_regprocedure('booking.offline_refund_proof_refusal(uuid,jsonb,text,timestamptz,uuid,text,timestamptz)') IS NOT NULL,
                   'offline_refund_settled_for', to_regprocedure('booking.offline_refund_settled_for(uuid)') IS NOT NULL,
                   'recorded_cleanup_legs_unsettled', to_regprocedure('booking.recorded_cleanup_legs_unsettled(uuid,boolean)') IS NOT NULL,
                   'complete_offline_refund_with_evidence', to_regprocedure('booking.complete_offline_refund_with_evidence(uuid,text,uuid,text,integer)') IS NOT NULL,
                   'suppress_guest_notification', to_regprocedure('booking.suppress_guest_notification(uuid,text)') IS NOT NULL,
                   'recorded_state_cleanup_ok', to_regprocedure('booking.recorded_state_cleanup_ok(uuid)') IS NOT NULL,
                   'offline_refund_create_fence', to_regprocedure('booking.offline_refund_create_fence()') IS NOT NULL,
                   'offline_refund_claim_fence', to_regprocedure('booking.offline_refund_claim_fence()') IS NOT NULL,
                   'offline_refund_success_fence', to_regprocedure('booking.offline_refund_success_fence()') IS NOT NULL,
                   'offline_refund_ledger_fence', to_regprocedure('booking.offline_refund_ledger_fence()') IS NOT NULL,
                   'offline_refund_ledger_required', to_regprocedure('booking.offline_refund_ledger_required()') IS NOT NULL,
                   'notify_suppression_audit_required', to_regprocedure('booking.notify_suppression_audit_required()') IS NOT NULL,
                   'notification_suppressions_bound', to_regprocedure('booking.notification_suppressions_bound()') IS NOT NULL,
                   'trg_offline_refund_create_fence', EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgname = 'external_operations_offline_refund_create_fence' AND tgrelid = 'booking.external_operations'::regclass),
                   'trg_offline_refund_claim_fence', EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgname = 'external_operations_offline_refund_claim_fence' AND tgrelid = 'booking.external_operations'::regclass),
                   'trg_offline_refund_success_fence', EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgname = 'external_operations_offline_refund_success_fence' AND tgrelid = 'booking.external_operations'::regclass),
                   'trg_payment_ledger_offline_refund_fence', EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgname = 'payment_ledger_offline_refund_fence' AND tgrelid = 'booking.payment_ledger'::regclass),
                   'idx_one_offline_refund_ever', to_regclass('booking.external_operations_one_offline_refund_ever') IS NOT NULL),
                 'acls', (SELECT jsonb_object_agg(f.sig, f.acl) FROM (
                     SELECT s.nspname || '.' || p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')' AS sig,
                            (SELECT to_jsonb(array_agg(a::text ORDER BY a::text)) FROM unnest(p.proacl) a) AS acl
                       FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace s ON s.oid = p.pronamespace
                      WHERE s.nspname = 'booking' AND p.proname IN ('offline_refund_proof_refusal', 'offline_refund_settled_for', 'recorded_cleanup_legs_unsettled', 'complete_offline_refund_with_evidence',
                                                                   'suppress_guest_notification', 'recorded_state_cleanup_ok', 'offline_refund_create_fence', 'offline_refund_claim_fence', 'offline_refund_success_fence',
                                                                   'offline_refund_ledger_fence', 'offline_refund_ledger_required', 'notify_suppression_audit_required', 'notification_suppressions_bound',
                                                                   'claim_release_blockers', 'intents_guard', 'intents_safety_guard', 'notify_op_fence', 'settle_test_refund_from_evidence', 'test_refund_settled_for',
                                                                   'recording_retirement_fence', 'record_provider_evidence', 'is_intent_state')) f),
                 'migrations', (SELECT jsonb_build_object('count', count(*), 'min', min(version), 'max', max(version), 'all_env_test', bool_and(environment = 'test'),
                     'aggregate', encode(sha256(convert_to(string_agg(version || ':' || name || ':' || up_checksum || ':' || down_checksum, E'\n' ORDER BY version), 'UTF8')), 'hex'),
                     'aggregate_1_20', (SELECT encode(sha256(convert_to(string_agg(version || ':' || name || ':' || up_checksum || ':' || down_checksum, E'\n' ORDER BY version), 'UTF8')), 'hex') FROM booking_migrations.applied WHERE version <= 20),
                     'v21', (SELECT to_jsonb(x) FROM (SELECT version, name, up_checksum, down_checksum, environment FROM booking_migrations.applied WHERE version = 21) x)) FROM booking_migrations.applied)
               )),
  'instance', (SELECT jsonb_build_object('rows', count(*), 'environment', min(environment)) FROM booking.instance),
  'current_user', current_user::text,
  'exclusion', jsonb_build_object(
    'hosted_run_lock_held', EXISTS (SELECT 1 FROM pg_catalog.pg_locks l WHERE l.locktype = 'advisory' AND l.granted AND l.database = (SELECT d.oid FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database()) AND l.classid = ((pg_catalog.hashtext('e7-connected-runner')::bigint + 4294967296) % 4294967296)::oid AND l.objid = 0::oid AND l.objsubid = 2),
    'work_leases', (SELECT count(*) FROM booking.intent_work WHERE work_worker_id IS NOT NULL OR work_lease_until IS NOT NULL),
    'intent_leases', (SELECT count(*) FROM booking.intents WHERE lease_worker_id IS NOT NULL OR lease_until IS NOT NULL),
    'operation_leases_or_in_flight', (SELECT count(*) FROM booking.external_operations WHERE lease_worker_id IS NOT NULL OR lease_until IS NOT NULL OR state = 'in_flight'),
    'vocabulary_rows', (SELECT (SELECT count(*) FROM booking.external_operations WHERE op_type = 'hostaway.refund_offline_charge') + (SELECT count(*) FROM booking.payment_ledger WHERE entry = 'offline_charge_refund_recorded')),
    'vocabulary_objects', (SELECT (to_regclass('booking.notification_suppressions') IS NOT NULL)::int + (EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'booking' AND table_name = 'intents' AND column_name = 'settlement_recording_mirrored'))::int)),
  'booking_tables_fingerprint', (SELECT jsonb_object_agg(t.relname, x.v) FROM pg_class t JOIN pg_namespace s ON s.oid = t.relnamespace, LATERAL (SELECT (xpath('/row/v/text()', query_to_xml(format('SELECT count(*) || '':'' || md5(coalesce(string_agg((to_jsonb(x) - ''settlement_recording_mirrored'')::text, E''\n'' ORDER BY (to_jsonb(x) - ''settlement_recording_mirrored'')::text), '''')) AS v FROM booking.%I x', t.relname), false, true, '')))[1]::text AS v) x WHERE s.nspname = 'booking' AND t.relkind IN ('r', 'p') AND t.relname <> 'notification_suppressions')
) AS e7_21_readback;
