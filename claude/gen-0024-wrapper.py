#!/usr/bin/env python3
# Generator for claude/e7-0024-sqleditor-apply-v1.sql and claude/e7-0024-readback-v1.sql (C112a) — LABELLED SPECIALISATION of the accepted
# claude/gen-0022-0023-wrapper.py for ONE migration (0024_pipeline_kickoff_requests) on a database that carries EXACTLY 0001-0023.
# Deterministic exact-source assembly:
#   * embeds db/migrations/0024_pipeline_kickoff_requests.up.sql VERBATIM (sha256-checked in-transaction against the pinned migrator checksum; the ONE
#     tracking row carries exactly the migrator's name / up / down checksums),
#   * pins every PRE (0001-0023) / POST (0001-0024) schema-identity fact from claude/e7-0024-pins-v1.json (derived on a DISPOSABLE cluster by
#     claude/derive-0024-pins.mjs with the accepted migrator) and embeds claude/e7-0024-inventory.sql VERBATIM as the identity probe,
#   * pins the merged hosted kickoff runner's CATALOG_PINS (main 8503716b) and re-checks them in-transaction for the RUNTIME APP ROLE,
#   * row preservation over the PRE table set (0024 adds NO column to a pre-existing table — asserted from the pins; the NEW table must be EMPTY),
#   * never edits the merged migration; NEVER embeds / applies 0001-0023 or any down; never adopts / upserts / backfills / repairs; refuses on ANY drift.
# Run from the worktree root:  python3 claude/gen-0024-wrapper.py .   (asserts byte-identical regeneration when the outputs exist, unless --write)
import hashlib, json, os, re, sys

ROOT = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("--") else "."
WRITE = "--write" in sys.argv
rd = lambda p: open(os.path.join(ROOT, p), encoding="utf8").read()
sha = lambda s: hashlib.sha256(s.encode("utf8")).hexdigest()

pins = json.loads(rd("claude/e7-0024-pins-v1.json"))
assert pins["schema"] == "e7-0024-pins-v1"
up24 = rd("db/migrations/0024_pipeline_kickoff_requests.up.sql"); down24 = rd("db/migrations/0024_pipeline_kickoff_requests.down.sql")
F = pins["files"]
assert (sha(up24), sha(down24)) == (F["up24"], F["down24"]), "merged migration bytes differ from the pins"
assert F["name24"] == "pipeline_kickoff_requests"
for tag in ("$e7_0024_up$", "$e7pkg$"): assert tag not in up24, tag
assert not re.search(r"^\s*(BEGIN|COMMIT|ROLLBACK|START TRANSACTION)\s*(WORK|TRANSACTION)?\s*;", up24, re.M | re.I), "the embedded up must not control the transaction"
inventory = rd("claude/e7-0024-inventory.sql")
assert sha(inventory) == pins["inventorySql"], "inventory probe changed after the pins were derived: re-derive"
inv_body = "\n".join(l for l in inventory.splitlines() if not l.startswith("--")).strip()
assert inv_body.endswith(" AS e7_inventory"); inv_body = inv_body[: -len(" AS e7_inventory")]
assert "$" not in inv_body, "dollar signs would break the DO body"

PRE, POST = pins["pre"], pins["post"]
IDENTITY_KEYS = ["functions", "function_count", "triggers", "trigger_count", "constraints", "indexes", "columns", "table_acls", "rls", "rls_enabled_count", "policies", "policy_count",
                 "schema_owner", "is_privileged_src", "is_privileged_config", "relations", "relation_count", "test_cleanup_pending_state", "prerequisite_0023", "objects", "acls"]
ident = lambda inv: json.dumps({k: inv[k] for k in IDENTITY_KEYS}, sort_keys=True, separators=(",", ":"))
c_pre, c_post = ident(PRE), ident(POST)
for s in (c_pre, c_post): assert "'" not in s and "$" not in s
C_HIST23 = PRE["migrations"]["aggregate"]; C_HIST24 = POST["migrations"]["aggregate"]
assert (PRE["migrations"]["count"], PRE["migrations"]["max"], POST["migrations"]["count"], POST["migrations"]["max"]) == (23, 23, 24, 24)
assert PRE["migrations"]["aggregate_1_23"] == C_HIST23 == POST["migrations"]["aggregate_1_23"]
assert C_HIST23 == "7df0b8fe542b7f85f43bdaf7138438c71627b7bc88a48104314eeb1482270ef0", "PRE history = the accepted 0022 / 0023 packet's POST aggregate (shared DEV exact post-23)"
assert all(v is True for v in PRE["prerequisite_0023"].values()) and all(v is True for v in POST["prerequisite_0023"].values())
assert all(v is False for v in PRE["objects"].values()) and all(v is True for v in POST["objects"].values())
assert PRE["schema_owner"] == "postgres" == POST["schema_owner"]
ADDED = pins["addedColumns"]; NEW = pins["newTables"]
assert ADDED == {} and NEW == ["pipeline_kickoff_requests"], "0024 catalog delta as reviewed: one new table, no added column"
KP = pins["kickoffCatalogPins"]
assert [f["sig"] for f in KP["functions"]] == ["booking.claim_pipeline_kickoff(uuid,text,text,jsonb)", "booking.refuse_pipeline_kickoff(uuid,text)",
  "booking.settle_pipeline_kickoff(uuid,text,text,text)", "booking.pipeline_kickoff_record()", "booking.pipeline_kickoff_refusal(booking.intents,booking.pipeline_kickoff_requests)",
  "booking.pipeline_kickoff_excluded(uuid)", "booking.pipeline_kickoff_guard()"]
assert KP["table"] == {"rls": True, "sel": True, "ins": False, "upd": False, "del": False, "trg": 1}
kp_json = json.dumps(KP, sort_keys=True, separators=(",", ":")); assert "'" not in kp_json and "$" not in kp_json
LOCK_KEY = "e7-connected-runner"   # = scripts/e7-connected/run-lock-precheck.mjs LOCK_KEY (asserted by the tests)
added_json = json.dumps(ADDED, sort_keys=True, separators=(",", ":")); new_list = ", ".join(f"'{t}'" for t in NEW)
PROTECTED = ["70636076", "71045356", "71072615", "71081885"]
HISTORICAL = ["abede8b1-8ef6-44f2-876e-6a02fc056a96", "c83c1842-d342-4e27-9ab7-dc3d50b7a309", "954d476c-71ea-4824-92f6-2220ae302103",
              "669da884-02e8-4105-8825-f908e5d22ae9", "1d6e770f-ba3d-40f7-92c1-ee01be7da532"]

# per-table count + whole-row fingerprint over the PRE column set (the pinned ADDED columns removed from each row's jsonb — a no-op before the apply)
# and the PRE table set (the NEW tables excluded; they must be EMPTY, asserted separately). The table list is read from the catalog at run time.
tblfp = ("(SELECT jsonb_object_agg(t.relname, x.v ORDER BY t.relname) FROM pg_catalog.pg_class t JOIN pg_catalog.pg_namespace s ON s.oid = t.relnamespace, "
         "LATERAL (SELECT (xpath('/row/v/text()', query_to_xml(format("
         "'SELECT count(*) || '':'' || md5(coalesce(string_agg(q.r, E''\\n'' ORDER BY q.r), '''')) AS v FROM (SELECT (to_jsonb(x) - %L::text[])::text AS r FROM booking.%I x) q', "
         f"ARRAY(SELECT jsonb_array_elements_text(coalesce('{added_json}'::jsonb -> t.relname::text, '[]'::jsonb))), t.relname), "
         f"false, true, '')))[1]::text AS v) x WHERE s.nspname = 'booking' AND t.relkind IN ('r', 'p') AND t.relname NOT IN ({new_list}))")
intent_ids = ("(SELECT count(*) || ':' || encode(sha256(convert_to(coalesce(string_agg(i.id::text, ',' ORDER BY i.id), ''), 'UTF8')), 'hex') FROM booking.intents i)")
hist = lambda where: ("SELECT encode(sha256(convert_to(string_agg(version || ':' || name || ':' || up_checksum || ':' || down_checksum, E'\\n' ORDER BY version), 'UTF8')), 'hex') "
                      f"FROM booking_migrations.applied{where}")
active_lock = ("EXISTS (SELECT 1 FROM pg_catalog.pg_locks l WHERE l.locktype = 'advisory' AND l.granted "
               "AND l.database = (SELECT d.oid FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database()) "
               f"AND l.classid = ((pg_catalog.hashtext('{LOCK_KEY}')::bigint + 4294967296) % 4294967296)::oid AND l.objid = 0::oid AND l.objsubid = 2)")
write_locks = ("(SELECT count(*) FROM pg_catalog.pg_locks l JOIN pg_catalog.pg_class c ON c.oid = l.relation JOIN pg_catalog.pg_namespace s ON s.oid = c.relnamespace "
               "WHERE l.locktype = 'relation' AND l.granted AND l.pid <> pg_catalog.pg_backend_pid() AND l.mode <> 'AccessShareLock' "
               "AND l.database = (SELECT d.oid FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database()) AND s.nspname IN ('booking', 'booking_migrations'))")
prepared = "(SELECT count(*) FROM pg_catalog.pg_prepared_xacts)"
indent = lambda s, n: ("\n" + " " * n).join(s.splitlines())
def compare(var, const, code):
    return (f"  bad := '';\n  FOR k IN SELECT jsonb_object_keys({const}) LOOP\n    IF ({var} -> k) IS DISTINCT FROM ({const} -> k) THEN bad := bad || k || ','; END IF;\n  END LOOP;\n"
            f"  IF bad <> '' THEN RAISE EXCEPTION '{code}:%', bad; END IF;               -- key names only, never values")
hist_rows23 = ("(SELECT count(*) || ':' || md5(coalesce(string_agg(to_jsonb(a)::text, E'\\n' ORDER BY a.version), '')) FROM booking_migrations.applied a WHERE a.version <= 23)")
kickoff_rows = ("(CASE WHEN to_regclass('booking.pipeline_kickoff_requests') IS NULL THEN NULL ELSE "
                "(xpath('/row/v/text()', query_to_xml('SELECT count(*) AS v FROM booking.pipeline_kickoff_requests', false, true, '')))[1]::text::bigint END)")
prot_list = ", ".join(f"'{p}'" for p in PROTECTED); hist_list = ", ".join(f"'{h}'" for h in HISTORICAL)
# sanitized protected / historical preservation: counts + whole-row fingerprints only (no field values leave the database)
protected_fp = ("(SELECT count(*) || ':' || md5(coalesce(string_agg(to_jsonb(i)::text, E'\\n' ORDER BY i.id), '')) FROM booking.intents i "
                f"WHERE i.hostaway_reservation_id::text IN ({prot_list}))")
historical_fp = ("(SELECT count(*) || ':' || md5(coalesce(string_agg(to_jsonb(i)::text, E'\\n' ORDER BY i.id), '')) FROM booking.intents i "
                 f"WHERE i.id::text IN ({hist_list}))")
# the merged hosted kickoff runner's catalog probe, evaluated for the RUNTIME APP ROLE (explicit role argument; the wrapper runs as the schema owner)
kick_fn = ("(SELECT jsonb_agg(jsonb_build_object('sig', p.oid::regprocedure::text, 'src', md5(p.prosrc), 'secdef', p.prosecdef, 'vol', p.provolatile::text, "
           "'cfg', coalesce(array_to_string(p.proconfig, ','), ''), 'acl', coalesce((SELECT string_agg(a.grantee::regrole::text || ':' || a.privilege_type, ',' "
           "ORDER BY a.grantee::regrole::text, a.privilege_type) FROM aclexplode(p.proacl) a WHERE a.grantee <> p.proowner), '')) ORDER BY x.n) "
           "FROM unnest(ARRAY['booking.claim_pipeline_kickoff(uuid,text,text,jsonb)', 'booking.refuse_pipeline_kickoff(uuid,text)', 'booking.settle_pipeline_kickoff(uuid,text,text,text)', "
           "'booking.pipeline_kickoff_record()', 'booking.pipeline_kickoff_refusal(booking.intents,booking.pipeline_kickoff_requests)', 'booking.pipeline_kickoff_excluded(uuid)', "
           "'booking.pipeline_kickoff_guard()']) WITH ORDINALITY AS x(s, n) JOIN pg_catalog.pg_proc p ON p.oid = to_regprocedure(x.s))")
kick_table = ("(SELECT jsonb_build_object('rls', c.relrowsecurity, 'sel', has_table_privilege('mv_booking_app', c.oid, 'SELECT'), 'ins', has_table_privilege('mv_booking_app', c.oid, 'INSERT'), "
              "'upd', has_table_privilege('mv_booking_app', c.oid, 'UPDATE'), 'del', has_table_privilege('mv_booking_app', c.oid, 'DELETE'), "
              "'trg', (SELECT count(*)::int FROM pg_catalog.pg_trigger g WHERE g.tgrelid = 'booking.intents'::regclass AND g.tgname = 'intents_pipeline_kickoff' "
              "AND g.tgfoid = to_regprocedure('booking.pipeline_kickoff_record()') AND g.tgenabled = 'O')) FROM pg_catalog.pg_class c WHERE c.oid = to_regclass('booking.pipeline_kickoff_requests'))")
kick_catalog = f"jsonb_build_object('functions', {kick_fn}, 'table', {kick_table})"

wrapper = f"""-- e7-0024-sqleditor-apply-v1.sql — ONE atomic DO statement for the Supabase SQL editor (schema owner = dashboard `postgres`). C112a.
-- Reviewable packet for the maraVilla shared DEV TEST database at EXACTLY 0001-0023. ROOT reviews and owns any actual shared apply; this file is not an
-- owner command. LABELLED SPECIALISATION of the accepted claude/e7-0022-0023-sqleditor-apply-v1.sql for ONE migration: applies EXACTLY
-- db/migrations/0024_pipeline_kickoff_requests.up.sql (bytes embedded verbatim, sha256-checked in-transaction) mirroring db/lib/migrate.js migrateUp:
-- advisory xact lock 7302215001; TEST instance + schema-owner role; history exactly 0001-0023 (names + checksums = the accepted 0022 / 0023 POST
-- aggregate); 0023 prerequisite; FULL PRE schema identity; quiescence (hosted-run lock, work / intent / operation leases, in-flight operations,
-- prepared transactions, other sessions' write locks on booking relations); no 0024 object present; then 0024 up + ONE tracking row, then the FULL POST
-- identity, the merged hosted kickoff runner's CATALOG_PINS for the runtime app role (7 functions: source md5 / SECURITY DEFINER / volatility /
-- search_path / non-owner ACL; table RLS + app privileges SELECT only; the intents trigger, enabled), unchanged 0001-0023 history rows (whole rows),
-- every pre-existing booking table's count + whole-row fingerprint (0024 adds NO column to a pre-existing table), the intent id set, the sanitized
-- protected-reservation and historical-intent fingerprints, and ZERO kickoff request rows (no adoption, no backfill: the trigger records only FUTURE
-- payment_pending → payment_authorized transitions of in-scope intents).
-- Any drift → RAISE → the whole statement rolls back (schema, data and history unchanged). Never adopts, upserts, backfills, repairs, widens a grant or
-- runs a down; never embeds 0001-0023. Zero booking DML. Returns no guest field and no credential.
-- REPLAY: on a database already at EXACTLY the pinned POST state (history 0001-0024 aggregate + full POST identity + kickoff catalog) it is a provable
-- NO-OP (no write, notice E7_24_ALREADY_EXACT_NOOP). Any other state at or above 24 → E7_24_POST_STATE_MISMATCH_STOP; it is never "repaired" by this
-- packet. After an UNCERTAIN issuance (editor error / lost reply) ROOT runs claude/e7-0024-readback-v1.sql FIRST and never re-issues blindly.
-- Applying 0024 enables NO dispatch: the hosted kickoff runner ships executeEnabled / dispatchEnabled FALSE; no worker, flag or workflow changes.
-- Generated by claude/gen-0024-wrapper.py from the merged migration bytes + claude/e7-0024-pins-v1.json (disposable-cluster derived); the identity probe
-- is claude/e7-0024-inventory.sql verbatim. TIME BOUND: the SET LOCAL statements below run BEFORE the DO in the same editor batch (one implicit
-- transaction block), so they bound the DO and leave the caller's session settings unchanged afterwards.
SET LOCAL statement_timeout = '180s';
SET LOCAL lock_timeout = '5s';
DO $e7pkg$
DECLARE
  up24      constant text  := $e7_0024_up${up24}$e7_0024_up$;
  c_up24    constant text  := '{F["up24"]}';
  c_down24  constant text  := '{F["down24"]}';
  c_hist23  constant text  := '{C_HIST23}';
  c_hist24  constant text  := '{C_HIST24}';
  c_pre     constant jsonb := '{c_pre}'::jsonb;
  c_post    constant jsonb := '{c_post}'::jsonb;
  c_kick    constant jsonb := '{kp_json}'::jsonb;
  inv jsonb; t_pre jsonb; t_post jsonb; h text; n bigint; mx int; k text; bad text := '';
  ids_pre text; hrows_pre text; prot_pre text; hist_pre text;
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  PERFORM pg_advisory_xact_lock(7302215001);                             -- = db/lib/migrate.js LOCK_KEY (transaction-scoped)
  IF encode(sha256(convert_to(up24, 'UTF8')), 'hex') <> c_up24 THEN RAISE EXCEPTION 'E7_24_UP24_BYTES_MISMATCH'; END IF;
  IF current_user::text <> (SELECT pg_catalog.pg_get_userbyid(nspowner)::text FROM pg_catalog.pg_namespace WHERE nspname = 'booking') THEN RAISE EXCEPTION 'E7_24_NOT_SCHEMA_OWNER'; END IF;
  IF to_regclass('booking_migrations.applied') IS NULL THEN RAISE EXCEPTION 'E7_24_NO_TRACKING_TABLE'; END IF;
  IF to_regclass('booking.instance') IS NULL THEN RAISE EXCEPTION 'E7_24_NO_INSTANCE'; END IF;
  SELECT count(*) INTO n FROM booking.instance;
  IF n <> 1 OR (SELECT environment FROM booking.instance) IS DISTINCT FROM 'test' THEN RAISE EXCEPTION 'E7_24_NOT_TEST'; END IF;
  IF EXISTS (SELECT 1 FROM booking_migrations.applied WHERE environment IS DISTINCT FROM 'test') THEN RAISE EXCEPTION 'E7_24_ENV_MISMATCH'; END IF;
  SELECT max(version) INTO mx FROM booking_migrations.applied;
  IF mx >= 24 THEN
    -- provable exact-POST no-op: full history aggregate 0001-0024 AND the full POST identity AND the kickoff catalog; anything else is an explicit STOP
    inv := ({indent(inv_body, 11)});
    SELECT ({hist("")}) INTO h;
    IF mx = 24 AND (SELECT count(*) FROM booking_migrations.applied) = 24 AND (SELECT min(version) FROM booking_migrations.applied) = 1 AND h = c_hist24 THEN
      bad := '';
      FOR k IN SELECT jsonb_object_keys(c_post) LOOP
        IF (inv -> k) IS DISTINCT FROM (c_post -> k) THEN bad := bad || k || ','; END IF;
      END LOOP;
      IF {kick_catalog} IS DISTINCT FROM c_kick THEN bad := bad || 'kickoff_catalog,'; END IF;
      IF bad = '' THEN RAISE NOTICE 'E7_24_ALREADY_EXACT_NOOP'; RETURN; END IF;
      RAISE EXCEPTION 'E7_24_POST_STATE_MISMATCH_STOP:%', bad;
    END IF;
    RAISE EXCEPTION 'E7_24_POST_STATE_MISMATCH_STOP:history';
  END IF;
  IF (SELECT count(*) FROM booking_migrations.applied) <> 23 OR (SELECT min(version) FROM booking_migrations.applied) <> 1 OR mx <> 23
     THEN RAISE EXCEPTION 'E7_24_HISTORY_NOT_1_TO_23'; END IF;
  SELECT ({hist("")}) INTO h;
  IF h IS DISTINCT FROM c_hist23 THEN RAISE EXCEPTION 'E7_24_HISTORY_DRIFT'; END IF;
  -- quiescence
  IF {active_lock} THEN RAISE EXCEPTION 'E7_24_ACTIVE_RUN_LOCK_HELD'; END IF;
  IF NOT pg_try_advisory_xact_lock(pg_catalog.hashtext('{LOCK_KEY}'), 0) THEN RAISE EXCEPTION 'E7_24_ACTIVE_RUN_LOCK_HELD'; END IF;
  IF EXISTS (SELECT 1 FROM booking.intent_work WHERE work_worker_id IS NOT NULL OR work_lease_until IS NOT NULL) THEN RAISE EXCEPTION 'E7_24_ACTIVE_WORK_LEASE'; END IF;
  IF EXISTS (SELECT 1 FROM booking.intents WHERE lease_worker_id IS NOT NULL OR lease_until IS NOT NULL) THEN RAISE EXCEPTION 'E7_24_ACTIVE_INTENT_LEASE'; END IF;
  IF EXISTS (SELECT 1 FROM booking.external_operations WHERE lease_worker_id IS NOT NULL OR lease_until IS NOT NULL OR state = 'in_flight') THEN RAISE EXCEPTION 'E7_24_OPERATION_LEASED_OR_IN_FLIGHT'; END IF;
  IF {prepared} <> 0 THEN RAISE EXCEPTION 'E7_24_PREPARED_TRANSACTION_PRESENT'; END IF;
  IF {write_locks} <> 0 THEN RAISE EXCEPTION 'E7_24_BOOKING_WRITE_LOCK_HELD'; END IF;
  -- no 0024 object may exist at 23 (an unrecorded partial apply or foreign object) — never adopted
  IF to_regclass('booking.pipeline_kickoff_requests') IS NOT NULL OR to_regprocedure('booking.claim_pipeline_kickoff(uuid,text,text,jsonb)') IS NOT NULL
     OR to_regprocedure('booking.pipeline_kickoff_record()') IS NOT NULL OR to_regprocedure('booking.pipeline_kickoff_guard()') IS NOT NULL
     OR to_regprocedure('booking.pipeline_kickoff_excluded(uuid)') IS NOT NULL OR to_regprocedure('booking.refuse_pipeline_kickoff(uuid,text)') IS NOT NULL
     OR to_regprocedure('booking.settle_pipeline_kickoff(uuid,text,text,text)') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'booking' AND p.proname LIKE '%pipeline_kickoff%')
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid = 'booking.intents'::regclass AND t.tgname = 'intents_pipeline_kickoff')
     THEN RAISE EXCEPTION 'E7_24_VOCABULARY_ALREADY_PRESENT'; END IF;
  inv := ({indent(inv_body, 9)});
  IF (inv -> 'prerequisite_0023') IS DISTINCT FROM (c_pre -> 'prerequisite_0023') THEN RAISE EXCEPTION 'E7_24_0023_PREREQUISITE_MISSING'; END IF;
{compare("inv", "c_pre", "E7_24_SCHEMA_IDENTITY_DRIFT")}
  t_pre := {tblfp};
  ids_pre := {intent_ids};
  hrows_pre := {hist_rows23};
  prot_pre := {protected_fp};
  hist_pre := {historical_fp};
  -- ---- 0024, exactly what migrateUp does for one version ----
  PERFORM set_config('booking.migration_environment', 'test', true);
  EXECUTE up24;
  INSERT INTO booking_migrations.applied (version, name, up_checksum, down_checksum, environment) VALUES (24, '{F["name24"]}', c_up24, c_down24, 'test');
  -- ---- post-conditions (same statement; any failure rolls everything back) ----
  inv := ({indent(inv_body, 9)});
{compare("inv", "c_post", "E7_24_POST_SCHEMA_IDENTITY_UNEXPECTED")}
  IF {kick_catalog} IS DISTINCT FROM c_kick THEN RAISE EXCEPTION 'E7_24_KICKOFF_CATALOG_UNEXPECTED'; END IF;
  SELECT ({hist(" WHERE version <= 23")}) INTO h;
  IF h IS DISTINCT FROM c_hist23 OR {hist_rows23} IS DISTINCT FROM hrows_pre THEN RAISE EXCEPTION 'E7_24_POST_HISTORY_1_TO_23_CHANGED'; END IF;
  SELECT ({hist("")}) INTO h;
  IF h IS DISTINCT FROM c_hist24 OR (SELECT count(*) FROM booking_migrations.applied) <> 24
     OR NOT EXISTS (SELECT 1 FROM booking_migrations.applied WHERE version = 24 AND name = '{F["name24"]}' AND up_checksum = c_up24 AND down_checksum = c_down24 AND environment = 'test')
     THEN RAISE EXCEPTION 'E7_24_POST_TRACKING_ROW_UNEXPECTED'; END IF;
  t_post := {tblfp};
  IF t_post IS DISTINCT FROM t_pre THEN RAISE EXCEPTION 'E7_24_BOOKING_ROWS_CHANGED'; END IF;
  IF {intent_ids} IS DISTINCT FROM ids_pre THEN RAISE EXCEPTION 'E7_24_INTENT_SET_CHANGED'; END IF;
  IF {protected_fp} IS DISTINCT FROM prot_pre OR {historical_fp} IS DISTINCT FROM hist_pre THEN RAISE EXCEPTION 'E7_24_PROTECTED_OR_HISTORICAL_CHANGED'; END IF;
  IF (SELECT count(*) FROM booking.pipeline_kickoff_requests) <> 0 THEN RAISE EXCEPTION 'E7_24_KICKOFF_ROWS_NOT_ZERO'; END IF;
  RAISE NOTICE 'E7_24_APPLIED';
END
$e7pkg$;
-- read-only status line (the editor's last result; the true state whether or not the DO above succeeded)
SELECT jsonb_build_object('migrations_max', (SELECT max(version) FROM booking_migrations.applied),
  'v24', EXISTS (SELECT 1 FROM booking_migrations.applied WHERE version = 24),
  'pipeline_kickoff_requests', to_regclass('booking.pipeline_kickoff_requests') IS NOT NULL,
  'claim_pipeline_kickoff', to_regprocedure('booking.claim_pipeline_kickoff(uuid,text,text,jsonb)') IS NOT NULL,
  'kickoff_rows', {kickoff_rows},
  'functions_sha256', ({indent(inv_body, 2)}) -> 'functions') AS e7_24_status;
"""

readback = f"""-- e7-0024-readback-v1.sql — PURE READ-ONLY (C112a). Run it BEFORE and AFTER the 0024 apply wrapper and compare with the pins
-- (claude/e7-0024-pins-v1.json: `pre` must equal the BEFORE identity keys, `post` the AFTER). LABELLED SPECIALISATION of the accepted
-- claude/e7-0022-0023-readback-v1.sql. Writes nothing, takes no lock, returns only counts / hashes / flags (no guest field, no credential). Schema owner.
-- `identity` = claude/e7-0024-inventory.sql verbatim (sha256 {pins["inventorySql"]}).
-- `exclusion` shows why an apply would refuse now. `data` must be IDENTICAL before and after: per-table count + whole-row fingerprint over the PRE
-- table set (the new kickoff table excluded), the intent id set, the whole 0001-0023 history rows, and the sanitized protected-reservation /
-- historical-intent fingerprints (counts + md5 only). `kickoff_rows` null before, 0 after. `kickoff_catalog` null-ish before; after, it must equal
-- pins.kickoffCatalogPins (= scripts/e7-hosted-kickoff.mjs CATALOG_PINS on main 8503716b, evaluated for mv_booking_app).
-- Expected BEFORE: identity.functions = {PRE["functions"]}, migrations.max = 23, aggregate = {C_HIST23}, every identity.objects = false.
-- Expected AFTER:  identity.functions = {POST["functions"]}, migrations.max = 24, aggregate = {C_HIST24}, aggregate_1_23 unchanged,
--                  v24 up {F["up24"]}, every identity.objects = true, `data` identical, kickoff_rows = 0.
SELECT jsonb_build_object(
  'identity', ({indent(inv_body, 15)}),
  'instance', (SELECT jsonb_build_object('rows', count(*), 'environment', min(environment)) FROM booking.instance),
  'current_user', current_user::text,
  'exclusion', jsonb_build_object(
    'hosted_run_lock_held', {active_lock},
    'work_leases', (SELECT count(*) FROM booking.intent_work WHERE work_worker_id IS NOT NULL OR work_lease_until IS NOT NULL),
    'intent_leases', (SELECT count(*) FROM booking.intents WHERE lease_worker_id IS NOT NULL OR lease_until IS NOT NULL),
    'operation_leases_or_in_flight', (SELECT count(*) FROM booking.external_operations WHERE lease_worker_id IS NOT NULL OR lease_until IS NOT NULL OR state = 'in_flight'),
    'prepared_transactions', {prepared},
    'other_session_write_locks', {write_locks}),
  'data', jsonb_build_object(
    'booking_tables', {tblfp},
    'intent_ids', {intent_ids},
    'history_rows_1_23', {hist_rows23},
    'protected_reservations', {protected_fp},
    'historical_intents', {historical_fp}),
  'kickoff_rows', {kickoff_rows},
  'kickoff_catalog', CASE WHEN to_regclass('booking.pipeline_kickoff_requests') IS NULL THEN NULL ELSE {kick_catalog} END
) AS e7_24_readback;
"""

for path, text in (("claude/e7-0024-sqleditor-apply-v1.sql", wrapper), ("claude/e7-0024-readback-v1.sql", readback)):
    full = os.path.join(ROOT, path)
    if os.path.exists(full) and not WRITE:
        assert open(full, encoding="utf8").read() == text, f"{path} is not byte-identical to the deterministic assembly (re-run with --write)"
    else:
        open(full, "w", encoding="utf8").write(text)
    print(path, "sha256:", sha(text))
assert re.search(r"\$e7_0024_up\$(.*?)\$e7_0024_up\$", wrapper, re.S).group(1) == up24
for v in sorted(f for f in os.listdir(os.path.join(ROOT, "db/migrations")) if f.endswith(".up.sql") and not f.startswith("0024_")):
    assert rd(f"db/migrations/{v}") not in wrapper, v
assert down24 not in wrapper
print("embedded up24 sha256:", sha(up24))
