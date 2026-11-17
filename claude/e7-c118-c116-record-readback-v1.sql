-- e7-c118-c116-record-readback-v1.sql — PURE READ-ONLY (C118). PARAMETERIZED with the SAME bound tokens as claude/e7-c118-c116-record-v1.sql
-- (<<C116_INTENT_ID>>, <<C116_RESERVATION_ID>>, <<REQUEST_KEY>>). Run BEFORE and AFTER the single issuance (and FIRST after any uncertain one).
-- Writes nothing, takes no lock; returns counts / flags / hashes and the bound booking's own state only (no guest field, no provider id, no credential).
-- Expected BEFORE: schema 27 identity; target confirmed, own_claim_held 1, notify succeeded / 1 / renders 1 / receipts 1 / latch 0; records 0;
--                  latest reservation evidence = an earlier observation (not the fresh one); projection null.
-- Expected AFTER:  same intent row hash and version; own_claim_held 0 (released EXTERNAL_CANCELLATION_ATTESTED); notify unchanged; latch 0; records 1 with the
--                  bound key; refund ['pending']; latest reservation evidence cancelled; projection {cancelled: true, refundStatus: pending};
--                  others_fingerprint IDENTICAL to BEFORE.
SELECT jsonb_build_object(
  'bound', ('<<C116_INTENT_ID>>' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' AND '<<C116_RESERVATION_ID>>' ~ '^[1-9][0-9]*$'),
  'schema', jsonb_build_object('max', (SELECT max(version) FROM booking_migrations.applied), 'aggregate_matches_post27', (SELECT encode(sha256(convert_to(string_agg(version || ':' || name || ':' || up_checksum || ':' || down_checksum, E'\n' ORDER BY version), 'UTF8')), 'hex') FROM booking_migrations.applied) = 'f6f3b20b6be4a603a9fbc6472743dfa9e4d8af62c78156e90c13d34894147980',
    'functions_matches_post27', ((SELECT jsonb_build_object(
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
          'policy_requests_app_admin_read', EXISTS (SELECT 1 FROM pg_catalog.pg_policies WHERE schemaname = 'booking' AND tablename = 'pipeline_kickoff_requests' AND policyname = 'app_admin_read'),
          'x27_external_cancellations', to_regclass('booking.external_cancellations') IS NOT NULL,
          'x27_external_refund_attestations', to_regclass('booking.external_refund_attestations') IS NOT NULL,
          'x27_admin_record_external_cancellation', to_regprocedure('booking.admin_record_external_cancellation(uuid,integer,uuid[],uuid,text,bigint,text,text,text,text,text)') IS NOT NULL,
          'x27_admin_attest_external_refund', to_regprocedure('booking.admin_attest_external_refund(uuid,text,bigint,text,text,text,text)') IS NOT NULL,
          'x27_external_cancellation_public', to_regprocedure('booking.external_cancellation_public(uuid)') IS NOT NULL,
          'x27_trg_claim_fence', EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid JOIN pg_catalog.pg_namespace s ON s.oid = c.relnamespace
              WHERE s.nspname = 'booking' AND c.relname = 'inventory_claims' AND t.tgname = 'external_cancellation_claim_fence' AND t.tgenabled = 'O'),
          'x27_trg_op_fence', EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid JOIN pg_catalog.pg_namespace s ON s.oid = c.relnamespace
              WHERE s.nspname = 'booking' AND c.relname = 'external_operations' AND t.tgname = 'external_cancellation_op_fence' AND t.tgenabled = 'O'),
          'x27_trg_intent_fence', EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid JOIN pg_catalog.pg_namespace s ON s.oid = c.relnamespace
              WHERE s.nspname = 'booking' AND c.relname = 'intents' AND t.tgname = 'external_cancellation_intent_fence' AND t.tgenabled = 'O')),
        'acls', (SELECT jsonb_object_agg(f.sig, f.acl) FROM (
            SELECT s.nspname || '.' || p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')' AS sig,
                   (SELECT to_jsonb(array_agg(a::text ORDER BY a::text)) FROM unnest(p.proacl) a) AS acl
              FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace s ON s.oid = p.pronamespace
             WHERE s.nspname = 'booking' AND p.proname IN ('claim_pipeline_kickoff', 'refuse_pipeline_kickoff', 'settle_pipeline_kickoff', 'pipeline_kickoff_record', 'pipeline_kickoff_refusal',
                                                          'pipeline_kickoff_excluded', 'pipeline_kickoff_guard', 'claim_guest_notification_v2', 'complete_guest_notification_resend',
                                                          'notification_provider_receipt_binding', 'guest_notification_presend', 'is_privileged', 'is_intent_state', 'reject_change',
                                                          'gn_recipient_in_scope', 'claim_release_blockers', 'externally_cancelled', 'external_refund_check',
                                                          'admin_record_external_cancellation', 'admin_attest_external_refund', 'external_cancellation_public',
                                                          'external_disposition_insert_guard', 'external_cancellation_claim_fence', 'external_cancellation_op_fence',
                                                          'external_cancellation_intent_fence')) f),
        'migrations', (SELECT jsonb_build_object('count', count(*), 'min', min(version), 'max', max(version), 'all_env_test', bool_and(environment = 'test'),
            'aggregate', encode(sha256(convert_to(string_agg(version || ':' || name || ':' || up_checksum || ':' || down_checksum, E'\n' ORDER BY version), 'UTF8')), 'hex'),
            'aggregate_1_26', (SELECT encode(sha256(convert_to(string_agg(version || ':' || name || ':' || up_checksum || ':' || down_checksum, E'\n' ORDER BY version), 'UTF8')), 'hex') FROM booking_migrations.applied WHERE version <= 26),
            'v27', (SELECT to_jsonb(x) FROM (SELECT version, name, up_checksum, down_checksum, environment FROM booking_migrations.applied WHERE version = 27) x)) FROM booking_migrations.applied)
      )) -> 'functions') = '"137ea3dae9fb20cd8486598cc6ae71a4a619a34df51a096df501cdda07c15e82"'::jsonb),
  'instance', (SELECT min(environment) FROM booking.instance),
  'exclusion', jsonb_build_object('hosted_run_lock_held', EXISTS (SELECT 1 FROM pg_catalog.pg_locks l WHERE l.locktype = 'advisory' AND l.granted AND l.database = (SELECT d.oid FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database()) AND l.classid = ((pg_catalog.hashtext('e7-connected-runner')::bigint + 4294967296) % 4294967296)::oid AND l.objid = 0::oid AND l.objsubid = 2),
    'work_leases', (SELECT count(*) FROM booking.intent_work WHERE work_worker_id IS NOT NULL OR work_lease_until IS NOT NULL),
    'intent_leases', (SELECT count(*) FROM booking.intents WHERE lease_worker_id IS NOT NULL OR lease_until IS NOT NULL),
    'operation_leases_or_in_flight', (SELECT count(*) FROM booking.external_operations WHERE lease_worker_id IS NOT NULL OR lease_until IS NOT NULL OR state = 'in_flight'),
    'kickoff_unsettled', (SELECT count(*) FROM booking.pipeline_kickoff_requests WHERE state IN ('requested', 'claimed', 'dispatch_unknown')), 'prepared_transactions', (SELECT count(*) FROM pg_catalog.pg_prepared_xacts), 'other_session_write_locks', (SELECT count(*) FROM pg_catalog.pg_locks l JOIN pg_catalog.pg_class c ON c.oid = l.relation JOIN pg_catalog.pg_namespace s ON s.oid = c.relnamespace WHERE l.locktype = 'relation' AND l.granted AND l.pid <> pg_catalog.pg_backend_pid() AND l.mode <> 'AccessShareLock' AND l.database = (SELECT d.oid FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database()) AND s.nspname IN ('booking', 'booking_migrations'))),
  'target', (SELECT jsonb_build_object('state', i.state, 'version', i.version, 'reservation_matches', i.hostaway_reservation_id = '<<C116_RESERVATION_ID>>',
      'listing_id', i.listing_id, 'currency', i.currency, 'captured_minor', i.captured_minor, 'final_total_minor', i.final_total_minor,
      'intent_row_md5', md5(to_jsonb(i)::text),
      'own_claim_held', (SELECT count(*) FROM booking.inventory_claims c WHERE c.intent_id = i.id AND c.released_at IS NULL),
      'own_claim_release_reasons', (SELECT coalesce(jsonb_agg(c.release_reason ORDER BY c.id), '[]'::jsonb) FROM booking.inventory_claims c WHERE c.intent_id = i.id),
      'notify', (SELECT jsonb_agg(jsonb_build_object('state', o.state, 'attempts', o.attempts, 'renders', (SELECT count(*) FROM booking.notification_renders r WHERE r.operation_id = o.id),
          'receipts', (SELECT count(*) FROM booking.notification_provider_receipts p WHERE p.operation_id = o.id),
          'latches', (SELECT count(*) FROM booking.notification_latches l WHERE l.operation_id = o.id), 'row_md5', md5(to_jsonb(o)::text)))
        FROM booking.external_operations o WHERE o.intent_id = i.id AND o.op_type = 'guest.notify'),
      'history_md5', jsonb_build_object(
        'operations', (SELECT md5(coalesce(string_agg(to_jsonb(o)::text, E'\n' ORDER BY o.id), '')) FROM booking.external_operations o WHERE o.intent_id = i.id),
        'renders', (SELECT md5(coalesce(string_agg(to_jsonb(r)::text, E'\n' ORDER BY r.operation_id), '')) FROM booking.notification_renders r WHERE r.intent_id = i.id),
        'receipts', (SELECT md5(coalesce(string_agg(to_jsonb(p)::text, E'\n' ORDER BY p.operation_id), '')) FROM booking.notification_provider_receipts p WHERE p.intent_id = i.id),
        'ledger', (SELECT md5(coalesce(string_agg(to_jsonb(l)::text, E'\n' ORDER BY l.id), '')) FROM booking.payment_ledger l WHERE l.intent_id = i.id),
        'transitions', (SELECT md5(coalesce(string_agg(to_jsonb(t)::text, E'\n' ORDER BY t.version_after), '')) FROM booking.intent_transitions t WHERE t.intent_id = i.id)),
      'latest_reservation_evidence', (SELECT jsonb_build_object('status', e.status, 'source', e.source, 'observed_at', e.observed_at) FROM booking.provider_evidence e
        WHERE e.intent_id = i.id AND e.kind = 'hostaway_reservation' AND e.external_ref = '<<C116_RESERVATION_ID>>' ORDER BY e.observed_at DESC, e.created_at DESC, e.id DESC LIMIT 1),
      'record', (SELECT jsonb_build_object('key_matches', x.request_key = '<<REQUEST_KEY>>', 'notify_dispositions', (SELECT jsonb_agg(d ->> 'disposition') FROM jsonb_array_elements(x.notify_dispositions) d),
          'released_claim_present', x.released_claim_id IS NOT NULL) FROM booking.external_cancellations x WHERE x.intent_id = i.id),
      'refund_statuses', (SELECT coalesce(jsonb_agg(f.refund_status ORDER BY f.seq), '[]'::jsonb) FROM booking.external_refund_attestations f WHERE f.intent_id = i.id),
      'projection', booking.external_cancellation_public(i.id))
    FROM booking.intents i WHERE i.id::text = '<<C116_INTENT_ID>>'),
  'records_total', (SELECT count(*) FROM booking.external_cancellations),
  'externally_cancelled_latches', (SELECT count(*) FROM booking.notification_latches WHERE code = 'EXTERNALLY_CANCELLED'),
  'others_fingerprint', jsonb_build_object(
    'claims_other_intents', (SELECT count(*) || ':' || md5(coalesce(string_agg(to_jsonb(c)::text, E'\n' ORDER BY c.id), '')) FROM booking.inventory_claims c WHERE c.intent_id::text <> '<<C116_INTENT_ID>>'),
    'intents_other', (SELECT count(*) || ':' || md5(coalesce(string_agg(to_jsonb(o)::text, E'\n' ORDER BY o.id), '')) FROM booking.intents o WHERE o.id::text <> '<<C116_INTENT_ID>>'),
    'tables', (SELECT jsonb_object_agg(t.relname, x.v ORDER BY t.relname) FROM pg_catalog.pg_class t JOIN pg_catalog.pg_namespace s ON s.oid = t.relnamespace, LATERAL (SELECT (xpath('/row/v/text()', query_to_xml(format('SELECT count(*) || '':'' || md5(coalesce(string_agg(q.r, E''\n'' ORDER BY q.r), '''')) AS v FROM (SELECT to_jsonb(x)::text AS r FROM booking.%I x) q', t.relname), false, true, '')))[1]::text AS v) x WHERE s.nspname = 'booking' AND t.relkind IN ('r', 'p') AND t.relname NOT IN ('inventory_claims', 'provider_evidence', 'external_cancellations', 'external_refund_attestations')))
) AS e7_c116_readback;
