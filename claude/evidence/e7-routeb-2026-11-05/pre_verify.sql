-- Route B (E7) PRE verification, READ ONLY (catalog + aggregate counts; never a guest column). Expect every ok = true (history 1..5).
-- data_counts / other_logins_in_booking_groups are REPORTED, not asserted: the hosted data and logins are not assumed.
BEGIN READ ONLY;
SELECT 'instance_test' AS check_name, (SELECT count(*) = 1 AND bool_and(environment = 'test') FROM booking.instance) AS ok, NULL::text AS detail
UNION ALL
SELECT 'history_exactly_1_to_5', (SELECT count(*) = 0 FROM booking_migrations.applied a FULL JOIN (VALUES (1, 'booking_core', 'f1550b3ab41cad09c0ee65295c07e483faef7d55554f18f04b1a148a0f2e045a', '948afbb80ab046c59bb5828bd858558a4ca4f2b608b15a8b53f34a27ab8aef7c'), (2, 'roles_grants', 'f2a35ad4f92043bdb09573451ea22b6da8444da207d798ef1d0fdd60621d80b7', '107c2010d5d385f4b25350ce9e848f8f362d8bc4ed6374bbb959f8afd1b752cf'), (3, 'safety_corrections', '51143492f332bc771696a0c1cca241bc1fd078535f1a6e91dabd3c1b05b539f7', '5f6ce4613908eb4bc4601c1a10a7b7c9f54c78654190c69bbbca620c8a1907fb'), (4, 'capture_recovery', '2ffb8af83913e3090b87fbf28a264ef96f15707bdbef647f5098b39f143be472', '9a41c4eeb99f01470df7fa9c352b123383139a9d6cf339d9a1f785da8a1ddcab'), (5, 'db_clock_checkout_create', 'd487975b8bc5f451b7ca22d0b91330cf4365b5d315a4f8dbb3f5ccac3f368637', 'fbf0814e5b39d44eadd9728cce3ba272dfa9f59d81de146818a43c5a53fcca5d')) f(version, name, up, down) USING (version)
      WHERE a.version IS NULL OR f.version IS NULL OR a.name <> f.name OR a.up_checksum <> f.up OR a.down_checksum <> f.down OR a.environment <> 'test'), (SELECT string_agg(version::text, ',' ORDER BY version) FROM booking_migrations.applied)
UNION ALL
SELECT 'new_tables_absent', (to_regclass('booking.api_rate_limits') IS NULL AND to_regclass('booking.recording_holds') IS NULL AND to_regclass('booking.notification_renders') IS NULL), NULL
UNION ALL
SELECT 'pre_tables_present', (SELECT count(*) = 17 FROM pg_class c WHERE c.relnamespace = 'booking'::regnamespace AND c.relkind = 'r' AND c.relname IN ('instance', 'intents', 'intent_work', 'payment_attempts', 'external_operations', 'hostaway_reservation_attempts', 'payment_refunds', 'stripe_webhook_events', 'inventory_claims', 'reconciliation_cases', 'intent_transitions', 'intent_applied_events', 'payment_ledger', 'intent_guests', 'provider_evidence', 'reconciliation_resolutions', 'definite_refusal_codes')), NULL
UNION ALL
SELECT 'btree_gist', (SELECT count(*) = 1 FROM pg_extension WHERE extname = 'btree_gist'), (SELECT extversion FROM pg_extension WHERE extname = 'btree_gist')
UNION ALL
SELECT 'roles_groups_nologin', (SELECT count(*) = 3 AND bool_and(NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls) FROM pg_roles WHERE rolname IN ('mv_booking_admin', 'mv_booking_app', 'mv_booking_report')), NULL
UNION ALL
SELECT 'runtime_login_mv_booking_app_dev', (SELECT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreaterole AND NOT rolcreatedb FROM pg_roles WHERE rolname = 'mv_booking_app_dev') IS TRUE,
       (SELECT string_agg(g.rolname, ',' ORDER BY g.rolname) FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = 'mv_booking_app_dev')
UNION ALL
SELECT 'runtime_login_member_of_app_only', (SELECT string_agg(g.rolname, ',' ORDER BY g.rolname) FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = 'mv_booking_app_dev') IS NOT DISTINCT FROM 'mv_booking_app', NULL
UNION ALL
SELECT 'other_logins_in_booking_groups', true, (SELECT string_agg(r.rolname, ',' ORDER BY r.rolname) FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid JOIN pg_roles r ON r.oid = m.member WHERE g.rolname LIKE 'mv\_booking\_%' AND r.rolcanlogin AND r.rolname <> 'mv_booking_app_dev')
UNION ALL
SELECT 'pre_0006_no_duplicate_token_hash', (SELECT count(*) = count(DISTINCT access_token_hash) FROM booking.intents), NULL
UNION ALL
SELECT 'pre_0011_no_reserved_offline_hold_case', NOT EXISTS (SELECT 1 FROM booking.reconciliation_cases WHERE starts_with(kind, 'OFFLINE_CHARGE_HOLD_')), NULL
UNION ALL
SELECT 'pre_0016_notify_rows_canonical_unattempted', NOT EXISTS (SELECT 1 FROM booking.external_operations o WHERE o.op_type = 'guest.notify' AND (
        o.state <> 'pending' OR o.attempts <> 0 OR o.dispatched_at IS NOT NULL OR o.lease_worker_id IS NOT NULL OR o.lease_until IS NOT NULL
     OR o.completed_at IS NOT NULL OR o.result_ref IS NOT NULL OR o.settled_evidence_id IS NOT NULL OR o.resolution_id IS NOT NULL
     OR o.retry_class <> 'idempotent'
     OR o.payload <> jsonb_build_object('template', o.payload ->> 'template')
     OR (o.payload ->> 'template') IS NULL
     OR (o.payload ->> 'template') NOT IN ('booking_confirmed', 'not_charged_authorization_may_show', 'not_completed_not_charged')
     OR o.idempotency_key <> 'notify:' || o.intent_id::text || ':' || (o.payload ->> 'template'))), NULL
UNION ALL
SELECT 'pre_0016_notify_one_per_intent', NOT EXISTS (SELECT 1 FROM booking.external_operations WHERE op_type = 'guest.notify' GROUP BY intent_id HAVING count(*) > 1), NULL
UNION ALL
SELECT 'data_counts', true, (SELECT format('intents=%s guests=%s attempts=%s ops=%s notify_ops=%s cases=%s webhook_events=%s claims=%s ledger=%s',
       (SELECT count(*) FROM booking.intents), (SELECT count(*) FROM booking.intent_guests), (SELECT count(*) FROM booking.payment_attempts),
       (SELECT count(*) FROM booking.external_operations), (SELECT count(*) FROM booking.external_operations WHERE op_type = 'guest.notify'),
       (SELECT count(*) FROM booking.reconciliation_cases), (SELECT count(*) FROM booking.stripe_webhook_events), (SELECT count(*) FROM booking.inventory_claims),
       (SELECT count(*) FROM booking.payment_ledger)));
ROLLBACK;
