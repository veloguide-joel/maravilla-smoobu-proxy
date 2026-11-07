-- e7-0018-sqleditor-apply-v1.sql — ONE atomic DO statement for the Supabase SQL editor (schema owner = dashboard `postgres`).
-- LOCAL-ONLY header: PENDING an explicit root shared-DEV scope exception. This is reviewable prep, NOT permission to apply.
-- Applies EXACTLY db/migrations/0018_is_privileged_qualify.up.sql (bytes embedded verbatim, header intact, sha256-checked in-transaction)
-- to the maraVilla DEV TEST database, mirroring scripts/db-migrate.mjs + db/lib/migrate.js migrateUp for ONE version:
-- advisory xact lock 7302215001, re-verified history/environment/body/EXACT-ACL, the up SQL, ONE tracking row.
-- Refuses (RAISE -> whole statement rolls back) on ANY drift: never adopts, replays, upserts, creates bookkeeping, or runs a down. No booking DML.
-- The security fix must NOT be published or shared-applied ahead of remediation. Returns no guest field and no credential.
DO $e7pkg$
DECLARE
  up        constant text   := $e7_0018_up$-- 0018_is_privileged_qualify (up) — DISPOSABLE LOCAL test databases only. LOCAL MIGRATION CANDIDATE (root ruling 2026-11-07).
-- Replaces booking.is_privileged() — baseline definition: db/migrations/0003_safety_corrections.up.sql.
-- Same signature, RETURNS boolean, LANGUAGE sql, STABLE and SECURITY INVOKER (default); CREATE OR REPLACE keeps owner and ACL.
-- Fix: both catalog references are fully schema-qualified (pg_catalog.pg_namespace, pg_catalog.pg_get_userbyid), which is
-- immune to search_path / pg_temp manipulation; a function-local SET search_path = pg_catalog, pg_temp (pg_temp explicit and
-- LAST) is defense in depth and clears the mutable-search_path advisor warning for this function. Semantics are unchanged:
-- true iff current_user owns schema booking (the owner, or inside a schema-owner SECURITY DEFINER function).
CREATE OR REPLACE FUNCTION booking.is_privileged() RETURNS boolean LANGUAGE sql STABLE
  SET search_path = pg_catalog, pg_temp AS $$
  SELECT current_user::text = (SELECT pg_catalog.pg_get_userbyid(n.nspowner)::text
                               FROM pg_catalog.pg_namespace n WHERE n.nspname = 'booking')
$$;
$e7_0018_up$;
  c_up      constant text   := 'e0289e3599705b7eac34605f3b5074eee0c78ef69169341945cfdfa998126015';
  c_down    constant text   := 'b532911be9cfbac0145564b588a6ad3d99fcf9aece2de799c330cb3ea64208cd';
  c_hist17  constant text   := 'c8b46a43693a1ab222534ee7f49401beb171eb7ecb7512bb3889d9ed7f04d4c3';
  c_src_old constant text   := '701fade99915db198c1aff0eee3e94d7106c314480ee5863321739444ba20c69';
  c_src_new constant text   := 'a14a1dc5befcd96d03ca1c7e28020c5b07b6d1b212510cc1ad715368bc43fb9d';
  acl_exact constant text[] := ARRAY['mv_booking_admin=X/postgres','mv_booking_app=X/postgres','postgres=X/postgres'];   -- the EXACT baseline aclitem set (owner postgres / app / admin only), sorted
  f_pre jsonb; f_post jsonb; t_pre jsonb; t_post jsonb; fn_pre text; fn_post text; h text; n bigint; acl_pre text[]; acl_post text[];
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);                        -- never wait unboundedly for the lock or the function row
  PERFORM pg_advisory_xact_lock(7302215001);                             -- = db/lib/migrate.js LOCK_KEY (transaction-scoped)
  IF encode(sha256(convert_to(up, 'UTF8')), 'hex') <> c_up THEN RAISE EXCEPTION 'E7_0018_UP_BYTES_MISMATCH'; END IF;
  IF to_regclass('booking_migrations.applied') IS NULL THEN RAISE EXCEPTION 'E7_0018_NO_TRACKING_TABLE'; END IF;   -- never create one
  IF to_regclass('booking.instance') IS NULL THEN RAISE EXCEPTION 'E7_0018_NO_INSTANCE'; END IF;
  SELECT count(*) INTO n FROM booking.instance;
  IF n <> 1 OR (SELECT environment FROM booking.instance) IS DISTINCT FROM 'test' THEN RAISE EXCEPTION 'E7_0018_NOT_TEST'; END IF;
  IF EXISTS (SELECT 1 FROM booking_migrations.applied WHERE version >= 18) THEN RAISE EXCEPTION 'E7_0018_ALREADY_APPLIED_OR_LATER'; END IF;
  IF (SELECT count(*) FROM booking_migrations.applied) <> 17 OR (SELECT min(version) FROM booking_migrations.applied) <> 1
     OR (SELECT max(version) FROM booking_migrations.applied) <> 17 THEN RAISE EXCEPTION 'E7_0018_HISTORY_NOT_1_TO_17'; END IF;
  IF EXISTS (SELECT 1 FROM booking_migrations.applied WHERE environment IS DISTINCT FROM 'test') THEN RAISE EXCEPTION 'E7_0018_ENV_MISMATCH'; END IF;
  SELECT encode(sha256(convert_to(string_agg(version || ':' || name || ':' || up_checksum || ':' || down_checksum, E'\n' ORDER BY version), 'UTF8')), 'hex')
    INTO h FROM booking_migrations.applied;
  IF h IS DISTINCT FROM c_hist17 THEN RAISE EXCEPTION 'E7_0018_HISTORY_DRIFT'; END IF;             -- names + up/down checksums of 0001-0017 exactly
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace
       WHERE s.nspname = 'booking' AND p.proname = 'is_privileged') <> 1 THEN RAISE EXCEPTION 'E7_0018_FUNCTION_OVERLOADS'; END IF;
  SELECT jsonb_build_object('oid', p.oid::bigint, 'owner', pg_get_userbyid(p.proowner), 'acl', p.proacl::text, 'secdef', p.prosecdef, 'volatile', p.provolatile, 'lang', l.lanname, 'rettype', format_type(p.prorettype, NULL), 'args', pg_get_function_identity_arguments(p.oid), 'config', to_jsonb(p.proconfig), 'kind', p.prokind, 'src', encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex'), 'public_execute', EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0), 'app_execute', has_function_privilege('mv_booking_app', p.oid, 'EXECUTE'), 'admin_execute', has_function_privilege('mv_booking_admin', p.oid, 'EXECUTE'), 'report_execute', has_function_privilege('mv_booking_report', p.oid, 'EXECUTE')) INTO f_pre FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang WHERE p.oid = 'booking.is_privileged()'::regprocedure;
  IF f_pre ->> 'src' <> c_src_old THEN RAISE EXCEPTION 'E7_0018_FUNCTION_BODY_DRIFT'; END IF;      -- exactly the 0003 (live) body
  IF f_pre ->> 'owner' <> 'postgres' OR f_pre -> 'secdef' <> 'false' OR f_pre ->> 'volatile' <> 's' OR f_pre ->> 'lang' <> 'sql'
     OR f_pre ->> 'rettype' <> 'boolean' OR f_pre ->> 'args' <> '' OR f_pre -> 'config' <> 'null'::jsonb OR f_pre ->> 'kind' <> 'f'
     THEN RAISE EXCEPTION 'E7_0018_FUNCTION_ATTRIBUTES_DRIFT'; END IF;
  acl_pre := (SELECT array_agg(a::text ORDER BY a::text) FROM unnest((SELECT proacl FROM pg_proc WHERE oid = 'booking.is_privileged()'::regprocedure)) a);
  IF acl_pre IS DISTINCT FROM acl_exact THEN RAISE EXCEPTION 'E7_0018_FUNCTION_ACL_NOT_EXACT'; END IF;   -- EXACT set: owner/app/admin only, no PUBLIC, no extra grantee
  IF f_pre -> 'public_execute' <> 'false' OR f_pre -> 'app_execute' <> 'true' OR f_pre -> 'admin_execute' <> 'true'
     OR f_pre -> 'report_execute' <> 'false' THEN RAISE EXCEPTION 'E7_0018_FUNCTION_ACL_DRIFT'; END IF;   -- effective cross-check (redundant with the exact set)
  SELECT (SELECT encode(sha256(convert_to(coalesce(string_agg(p.oid::regprocedure::text || '|' || encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') || '|' || coalesce(to_jsonb(p.proconfig)::text, 'null') || '|' || coalesce(p.proacl::text, ''), E'\n' ORDER BY p.oid::regprocedure::text), ''), 'UTF8')), 'hex') FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'booking' AND p.oid <> 'booking.is_privileged()'::regprocedure) INTO fn_pre;                                                                     -- fingerprint of EVERY OTHER booking function
  t_pre := (SELECT jsonb_object_agg(t.relname, x.v) FROM pg_class t JOIN pg_namespace s ON s.oid = t.relnamespace, LATERAL (SELECT (xpath('/row/v/text()', query_to_xml(format('SELECT count(*) || '':'' || md5(coalesce(string_agg(x::text, E''\n'' ORDER BY x::text), '''')) AS v FROM booking.%I x', t.relname), false, true, '')))[1]::text AS v) x WHERE s.nspname = 'booking' AND t.relkind IN ('r', 'p'));
  -- ---- the migration itself: exactly what migrateUp does for one version ----
  PERFORM set_config('booking.migration_environment', 'test', true);
  EXECUTE up;
  INSERT INTO booking_migrations.applied (version, name, up_checksum, down_checksum, environment)
    VALUES (18, 'is_privileged_qualify', c_up, c_down, 'test');
  -- ---- post-conditions (still inside the same statement; any failure rolls everything back) ----
  SELECT jsonb_build_object('oid', p.oid::bigint, 'owner', pg_get_userbyid(p.proowner), 'acl', p.proacl::text, 'secdef', p.prosecdef, 'volatile', p.provolatile, 'lang', l.lanname, 'rettype', format_type(p.prorettype, NULL), 'args', pg_get_function_identity_arguments(p.oid), 'config', to_jsonb(p.proconfig), 'kind', p.prokind, 'src', encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex'), 'public_execute', EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0), 'app_execute', has_function_privilege('mv_booking_app', p.oid, 'EXECUTE'), 'admin_execute', has_function_privilege('mv_booking_admin', p.oid, 'EXECUTE'), 'report_execute', has_function_privilege('mv_booking_report', p.oid, 'EXECUTE')) INTO f_post FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang WHERE p.oid = 'booking.is_privileged()'::regprocedure;
  IF f_post ->> 'src' <> c_src_new THEN RAISE EXCEPTION 'E7_0018_POST_BODY_UNEXPECTED'; END IF;    -- qualified body
  IF f_post -> 'config' <> '["search_path=pg_catalog, pg_temp"]'::jsonb THEN RAISE EXCEPTION 'E7_0018_POST_CONFIG_UNEXPECTED'; END IF;
  IF (f_post ->> 'oid') <> (f_pre ->> 'oid') THEN RAISE EXCEPTION 'E7_0018_POST_OID_CHANGED'; END IF;    -- CREATE OR REPLACE keeps the oid
  IF (f_post - 'src' - 'config') <> (f_pre - 'src' - 'config') THEN RAISE EXCEPTION 'E7_0018_POST_OWNER_ACL_OR_ATTRIBUTES_CHANGED'; END IF;
  acl_post := (SELECT array_agg(a::text ORDER BY a::text) FROM unnest((SELECT proacl FROM pg_proc WHERE oid = 'booking.is_privileged()'::regprocedure)) a);
  IF acl_post IS DISTINCT FROM acl_exact THEN RAISE EXCEPTION 'E7_0018_POST_ACL_NOT_EXACT'; END IF;      -- ACL still exactly owner/app/admin
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace
       WHERE s.nspname = 'booking' AND p.proname = 'is_privileged') <> 1 THEN RAISE EXCEPTION 'E7_0018_POST_OVERLOADS'; END IF;
  SELECT (SELECT encode(sha256(convert_to(coalesce(string_agg(p.oid::regprocedure::text || '|' || encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') || '|' || coalesce(to_jsonb(p.proconfig)::text, 'null') || '|' || coalesce(p.proacl::text, ''), E'\n' ORDER BY p.oid::regprocedure::text), ''), 'UTF8')), 'hex') FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'booking' AND p.oid <> 'booking.is_privileged()'::regprocedure) INTO fn_post;
  IF fn_post IS DISTINCT FROM fn_pre THEN RAISE EXCEPTION 'E7_0018_OTHER_FUNCTION_OR_CATALOG_EFFECT'; END IF;   -- no other function changed
  SELECT encode(sha256(convert_to(string_agg(version || ':' || name || ':' || up_checksum || ':' || down_checksum, E'\n' ORDER BY version), 'UTF8')), 'hex')
    INTO h FROM booking_migrations.applied WHERE version <= 17;
  IF h IS DISTINCT FROM c_hist17 THEN RAISE EXCEPTION 'E7_0018_POST_HISTORY_1_TO_17_CHANGED'; END IF;          -- 0001-0017 rows untouched
  IF (SELECT count(*) FROM booking_migrations.applied) <> 18 OR (SELECT max(version) FROM booking_migrations.applied) <> 18
     OR NOT EXISTS (SELECT 1 FROM booking_migrations.applied WHERE version = 18 AND name = 'is_privileged_qualify'
                     AND up_checksum = c_up AND down_checksum = c_down AND environment = 'test')
     THEN RAISE EXCEPTION 'E7_0018_POST_TRACKING_ROW_UNEXPECTED'; END IF;
  t_post := (SELECT jsonb_object_agg(t.relname, x.v) FROM pg_class t JOIN pg_namespace s ON s.oid = t.relnamespace, LATERAL (SELECT (xpath('/row/v/text()', query_to_xml(format('SELECT count(*) || '':'' || md5(coalesce(string_agg(x::text, E''\n'' ORDER BY x::text), '''')) AS v FROM booking.%I x', t.relname), false, true, '')))[1]::text AS v) x WHERE s.nspname = 'booking' AND t.relkind IN ('r', 'p'));
  IF t_post IS DISTINCT FROM t_pre THEN RAISE EXCEPTION 'E7_0018_BOOKING_ROWS_CHANGED'; END IF;      -- zero booking-row writes (or a concurrent writer)
  RAISE NOTICE 'E7_0018_APPLIED';
END
$e7pkg$;
-- read-only status line (shown by the editor as the last result; true state whether or not the DO above succeeded)
SELECT jsonb_build_object('migrations_max', (SELECT max(version) FROM booking_migrations.applied),
  'v18', EXISTS (SELECT 1 FROM booking_migrations.applied WHERE version = 18),
  'is_privileged_prosrc_sha256', (SELECT encode(sha256(convert_to(prosrc, 'UTF8')), 'hex') FROM pg_proc
                                   WHERE oid = 'booking.is_privileged()'::regprocedure),
  'is_privileged_proconfig', (SELECT to_jsonb(proconfig) FROM pg_proc WHERE oid = 'booking.is_privileged()'::regprocedure),
  'is_privileged_acl', (SELECT array_to_json(array_agg(a::text ORDER BY a::text)) FROM unnest((SELECT proacl FROM pg_proc
                         WHERE oid = 'booking.is_privileged()'::regprocedure)) a)) AS e7_0018_status;
