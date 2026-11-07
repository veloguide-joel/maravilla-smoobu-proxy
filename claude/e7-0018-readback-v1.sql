-- e7-0018-readback-v1.sql — PURE READ-ONLY. Run it BEFORE and AFTER the 0018 apply wrapper and compare the two JSON results by eye / hash.
-- It writes nothing, takes no lock, and returns no guest field or credential. Owner/app/admin may run it (it only reads catalogs + counts).
-- Expected BEFORE: is_privileged.prosrc_sha256 = 701fade9…20c69, proconfig = null, acl = the exact owner/app/admin set, migrations.max = 17.
-- Expected AFTER:  is_privileged.prosrc_sha256 = a14a1dc5…fb9d, proconfig = ["search_path=pg_catalog, pg_temp"], acl UNCHANGED, migrations.max = 18
--                  with exactly one added v18 row; every OTHER booking function fingerprint and every booking table row fingerprint IDENTICAL.
SELECT jsonb_build_object(
  'is_privileged', (SELECT jsonb_build_object(
      'oid', p.oid::bigint,
      'owner', pg_catalog.pg_get_userbyid(p.proowner),
      'acl', (SELECT array_to_json(array_agg(a::text ORDER BY a::text)) FROM unnest(p.proacl) a),
      'secdef', p.prosecdef, 'volatile', p.provolatile, 'lang', l.lanname,
      'rettype', pg_catalog.format_type(p.prorettype, NULL), 'args', pg_catalog.pg_get_function_identity_arguments(p.oid),
      'kind', p.prokind, 'proconfig', to_jsonb(p.proconfig),
      'prosrc_sha256', encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex'),
      'public_execute', EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0),
      'app_execute', has_function_privilege('mv_booking_app', p.oid, 'EXECUTE'),
      'admin_execute', has_function_privilege('mv_booking_admin', p.oid, 'EXECUTE'),
      'report_execute', has_function_privilege('mv_booking_report', p.oid, 'EXECUTE'))
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_language l ON l.oid = p.prolang
    WHERE p.oid = 'booking.is_privileged()'::regprocedure),
  'migrations', (SELECT jsonb_build_object(
      'count', count(*), 'min', min(version), 'max', max(version),
      'all_env_test', bool_and(environment = 'test'),
      'aggregate', encode(sha256(convert_to(string_agg(version || ':' || name || ':' || up_checksum || ':' || down_checksum, E'\n' ORDER BY version), 'UTF8')), 'hex'),
      'aggregate_1_17', (SELECT encode(sha256(convert_to(string_agg(version || ':' || name || ':' || up_checksum || ':' || down_checksum, E'\n' ORDER BY version), 'UTF8')), 'hex')
                          FROM booking_migrations.applied WHERE version <= 17),
      'v18', (SELECT to_jsonb(x) FROM (SELECT version, name, up_checksum, down_checksum, environment FROM booking_migrations.applied WHERE version = 18) x))
    FROM booking_migrations.applied),
  'other_functions_fingerprint', (SELECT encode(sha256(convert_to(coalesce(string_agg(
        p.oid::regprocedure::text || '|' || encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') || '|' ||
        coalesce(to_jsonb(p.proconfig)::text, 'null') || '|' || coalesce(p.proacl::text, ''), E'\n' ORDER BY p.oid::regprocedure::text), ''), 'UTF8')), 'hex')
      FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace s ON s.oid = p.pronamespace
      WHERE s.nspname = 'booking' AND p.oid <> 'booking.is_privileged()'::regprocedure),
  'booking_tables_fingerprint', (SELECT jsonb_object_agg(t.relname, x.v) FROM pg_catalog.pg_class t JOIN pg_catalog.pg_namespace s ON s.oid = t.relnamespace,
      LATERAL (SELECT (xpath('/row/v/text()', query_to_xml(format(
        'SELECT count(*) || '':'' || md5(coalesce(string_agg(x::text, E''\n'' ORDER BY x::text), '''')) AS v FROM booking.%I x', t.relname),
        false, true, '')))[1]::text AS v) x
      WHERE s.nspname = 'booking' AND t.relkind IN ('r', 'p'))
) AS e7_0018_readback;
