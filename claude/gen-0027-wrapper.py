#!/usr/bin/env python3
# Generator for claude/e7-0027-sqleditor-apply-v1.sql and claude/e7-0027-readback-v1.sql (C118) — LABELLED SPECIALISATION of the accepted
# claude/gen-0025-0026-wrapper.py (and, for the new-table handling, claude/gen-0024-wrapper.py) for ONE migration, 0027_external_cancellation_disposition,
# on a database that carries EXACTLY 0001-0026 (the accepted 0025 + 0026 packet's POST state). Deterministic exact-source assembly:
#   * embeds db/migrations/0027_*.up.sql VERBATIM (sha256-checked in-transaction against the pinned migrator checksum; ONE tracking row carrying exactly
#     the migrator's name / up / down checksums),
#   * pins every PRE (0001-0026) / POST (0001-0027) schema-identity fact from claude/e7-0027-pins-v1.json (derived on a DISPOSABLE cluster by
#     claude/derive-0027-pins.mjs with the accepted migrator; PG16 == PG17) and embeds claude/e7-0027-inventory.sql VERBATIM,
#   * pins the merged hosted kickoff runner's CATALOG_PINS (main 92c1b674) at PRE and POST for the RUNTIME APP ROLE (0027 must not change it),
#   * row preservation over the PRE table set (0027 adds no column to a pre-existing table — asserted from the pins; the two NEW tables must be EMPTY),
#     the intent id set, whole 0001-0026 history rows, the sanitized protected / historical fingerprints (the accepted lists, verbatim), the
#     claim-release-blocker output of EVERY intent, zero EXTERNALLY_CANCELLED latches and a null guest projection for every intent,
#   * an explicit post ACL / RLS matrix for the new functions and tables,
#   * never edits a merged migration; NEVER embeds / applies 0001-0026 or any down; never records an external cancellation, evidence or refund attestation;
#     never adopts / upserts / backfills / repairs; refuses on ANY drift.
# Run from the worktree root:  python3 claude/gen-0027-wrapper.py .   (asserts byte-identical regeneration when the outputs exist, unless --write)
import hashlib, json, os, re, sys

ROOT = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("--") else "."
WRITE = "--write" in sys.argv
rd = lambda p: open(os.path.join(ROOT, p), encoding="utf8").read()
sha = lambda s: hashlib.sha256(s.encode("utf8")).hexdigest()

pins = json.loads(rd("claude/e7-0027-pins-v1.json"))
assert pins["schema"] == "e7-0027-pins-v1"
F = pins["files"]
assert F["name27"] == "external_cancellation_disposition"
up27 = rd(f"db/migrations/0027_{F['name27']}.up.sql"); down27 = rd(f"db/migrations/0027_{F['name27']}.down.sql")
assert (sha(up27), sha(down27)) == (F["up27"], F["down27"]), "merged migration bytes differ from the pins"
assert F["up27"] == "ae949bf42450cf1af2632212f2cc2c2704b66ca314f4fc4f2744e6130f9c8ecf" and F["down27"] == "8e3810678bc788df6915a4be9c728296a89f0b040ae0df245ceef7583fc6ba6c"
for tag in ("$e7_0027_up$", "$e7pkg$"): assert tag not in up27, tag
assert not re.search(r"^\s*(BEGIN|COMMIT|ROLLBACK|START TRANSACTION)\s*(WORK|TRANSACTION)?\s*;", up27, re.M | re.I), "the embedded up must not control the transaction"
inventory = rd("claude/e7-0027-inventory.sql")
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
C_HIST26 = PRE["migrations"]["aggregate"]; C_HIST27 = POST["migrations"]["aggregate"]
assert (PRE["migrations"]["count"], PRE["migrations"]["max"], POST["migrations"]["count"], POST["migrations"]["max"]) == (26, 26, 27, 27)
assert PRE["migrations"]["aggregate_1_26"] == C_HIST26 == POST["migrations"]["aggregate_1_26"]
assert C_HIST26 == "3dae7c0df75f4f51c4acdec3d79af4bb35050ee1d49c23c47e36b05f3d469ab1", "PRE history = the accepted 0025 + 0026 packet's POST aggregate"
assert PRE["functions"] == "bf0085e31e7cd75feefd20ea930bb4220d895c2a1135bd587e94ca9ad502d3b5", "PRE functions = the accepted 0025 + 0026 packet's POST functions"
for k in ("schema_owner", "is_privileged_src", "is_privileged_config", "test_cleanup_pending_state", "prerequisite_0023"): assert PRE[k] == POST[k], f"0027 must not change {k}"
assert PRE["schema_owner"] == "postgres" == POST["schema_owner"]
assert not any(v for k, v in PRE["objects"].items() if k.startswith("x27_")) and all(v for k, v in POST["objects"].items() if k.startswith("x27_")), "0027 objects absent PRE, present POST"
ADDED = pins["addedColumns"]; NEW = pins["newTables"]
assert ADDED == {} and NEW == ["external_cancellations", "external_refund_attestations"], "0027 catalog delta as reviewed: two new tables, no added column"
KP = pins["kickoffCatalogPins"]; assert pins["kickoffCatalogPre"] == KP, "0027 does not change the kickoff catalog"
kp_json = json.dumps(KP, sort_keys=True, separators=(",", ":")); assert "'" not in kp_json and "$" not in kp_json
PROTECTED = ["70636076", "71045356", "71072615", "71081885"]                       # the accepted packets' lists, verbatim (already public; unchanged)
HISTORICAL = ["abede8b1-8ef6-44f2-876e-6a02fc056a96", "c83c1842-d342-4e27-9ab7-dc3d50b7a309", "954d476c-71ea-4824-92f6-2220ae302103",
              "669da884-02e8-4105-8825-f908e5d22ae9", "1d6e770f-ba3d-40f7-92c1-ee01be7da532"]

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
hist_rows26 = ("(SELECT count(*) || ':' || md5(coalesce(string_agg(to_jsonb(a)::text, E'\\n' ORDER BY a.version), '')) FROM booking_migrations.applied a WHERE a.version <= 26)")
kickoff_rows = "(SELECT count(*) FROM booking.pipeline_kickoff_requests)"
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


# ---- 0027-specific behavioural probes (all SELECT-only) ----
blockers = ("(SELECT count(*) || ':' || md5(coalesce(string_agg(i.id::text || '=' || array_to_string(booking.claim_release_blockers(i.id), ','), E'\\n' ORDER BY i.id), '')) "
            "FROM booking.intents i)")
x27_latches = "(SELECT count(*) FROM booking.notification_latches WHERE code = 'EXTERNALLY_CANCELLED')"
cnt = lambda rel: (f"(CASE WHEN to_regclass('booking.{rel}') IS NULL THEN NULL ELSE "
                   f"(xpath('/row/n/text()', query_to_xml('SELECT count(*) AS n FROM booking.{rel}', false, true, '')))[1]::text::bigint END)")
projection_nonnull = ("(CASE WHEN to_regprocedure('booking.external_cancellation_public(uuid)') IS NULL THEN NULL ELSE "
                      "(xpath('/row/n/text()', query_to_xml('SELECT count(*) AS n FROM booking.intents i WHERE booking.external_cancellation_public(i.id) IS NOT NULL', false, true, '')))[1]::text::bigint END)")
FN_ADMIN = ["booking.admin_record_external_cancellation(uuid,integer,uuid[],uuid,text,bigint,text,text,text,text,text)",
            "booking.admin_attest_external_refund(uuid,text,bigint,text,text,text,text)"]
FN_APP = "booking.external_cancellation_public(uuid)"
ROLES = ["mv_booking_app", "mv_booking_admin", "mv_booking_report", "public"]
fpriv = lambda sig: "jsonb_build_object(" + ", ".join(f"'{r}', has_function_privilege('{r}', to_regprocedure('{sig}'), 'EXECUTE')" for r in ROLES) + ")"
tpriv = lambda rel: "jsonb_build_object(" + ", ".join(f"'{r}', jsonb_build_array(" + ", ".join(
    f"has_table_privilege('{r}', to_regclass('booking.{rel}'), '{p}')" for p in ("SELECT", "INSERT", "UPDATE", "DELETE")) + ")" for r in ROLES if r != "public") + \
    f", 'rls', (SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid = to_regclass('booking.{rel}')))"
acl_matrix = ("jsonb_build_object('record', " + fpriv(FN_ADMIN[0]) + ", 'attest', " + fpriv(FN_ADMIN[1]) + ", 'projection', " + fpriv(FN_APP) +
              ", 'external_cancellations', " + tpriv("external_cancellations") + ", 'external_refund_attestations', " + tpriv("external_refund_attestations") + ")")
f_ = lambda: {r: False for r in ROLES}
EXPECTED_ACL = {"record": {**f_(), "mv_booking_admin": True}, "attest": {**f_(), "mv_booking_admin": True}, "projection": {**f_(), "mv_booking_app": True},
                "external_cancellations": {"mv_booking_app": [False] * 4, "mv_booking_admin": [True, False, False, False], "mv_booking_report": [True, False, False, False], "rls": True},
                "external_refund_attestations": {"mv_booking_app": [False] * 4, "mv_booking_admin": [True, False, False, False], "mv_booking_report": [True, False, False, False], "rls": True}}
acl_json = json.dumps(EXPECTED_ACL, sort_keys=True, separators=(",", ":"))
kick_pending = "(SELECT count(*) FROM booking.pipeline_kickoff_requests WHERE state IN ('requested', 'claimed', 'dispatch_unknown'))"

wrapper = f"""-- e7-0027-sqleditor-apply-v1.sql — ONE atomic DO statement for the Supabase SQL editor (schema owner = dashboard `postgres`). C118.
-- Reviewable packet for the maraVilla shared DEV TEST database at EXACTLY 0001-0026. ROOT reviews and owns any actual shared apply; this file is not an
-- owner command. LABELLED SPECIALISATION of the accepted claude/e7-0025-0026-sqleditor-apply-v1.sql for ONE migration: applies EXACTLY
-- db/migrations/0027_{F["name27"]}.up.sql (bytes embedded verbatim, sha256-checked in-transaction) mirroring db/lib/migrate.js migrateUp: advisory xact
-- lock 7302215001; TEST instance + schema-owner role; history exactly 0001-0026 (names + checksums = the accepted 0025 + 0026 packet's POST aggregate);
-- FULL PRE schema identity + the main 92c1b674 kickoff catalog for the runtime app role; quiescence (hosted-run lock, work / intent / operation leases,
-- in-flight operations, unsettled kickoff requests, prepared transactions, other sessions' write locks on booking relations); then 0027 up + ONE
-- tracking row; the FULL POST identity; the UNCHANGED kickoff catalog; the explicit ACL / RLS matrix of the new functions and tables; unchanged 0001-0026
-- history rows (whole rows); EVERY pre-existing booking table's count + whole-row fingerprint (0027 adds no column to them); the two NEW tables EMPTY; the
-- intent id set; the sanitized protected-reservation / historical-intent fingerprints; the claim-release-blocker output of EVERY intent unchanged; zero
-- EXTERNALLY_CANCELLED latches; a null guest projection for every intent.
-- Any drift → RAISE → the whole statement rolls back (schema, data and history unchanged). Never adopts, upserts, backfills, repairs, widens a grant or
-- runs a down; never embeds 0001-0026. Zero booking DML. NEVER records an external cancellation, provider evidence or a refund attestation: the one later
-- C116 record is a separate reviewed step. Returns no guest field and no credential.
-- REPLAY: on a database already at EXACTLY the pinned POST state (history 0001-0027 aggregate + full POST identity + kickoff catalog) it is a provable
-- NO-OP (no write, notice E7_27_ALREADY_EXACT_NOOP). Any other state at or above 27 → E7_27_POST_STATE_MISMATCH_STOP; never "repaired" or continued.
-- After an UNCERTAIN issuance ROOT runs claude/e7-0027-readback-v1.sql FIRST and never re-issues blindly.
-- Applying 0027 enables nothing: every hosted runner on main ships executeEnabled / dispatchEnabled FALSE; no worker, flag, variable or workflow changes.
-- The hosted notification runner's whole-schema catalogPin26 no longer matches after this apply: it REFUSES (fail-closed) until a separately reviewed repin.
-- Generated by claude/gen-0027-wrapper.py from the merged migration bytes + claude/e7-0027-pins-v1.json (disposable-cluster derived); the identity probe
-- is claude/e7-0027-inventory.sql verbatim. TIME BOUND: the SET LOCAL statements below run BEFORE the DO in the same editor batch (one implicit
-- transaction block), so they bound the DO and leave the caller's session settings unchanged afterwards.
SET LOCAL statement_timeout = '180s';
SET LOCAL lock_timeout = '5s';
DO $e7pkg$
DECLARE
  up27      constant text  := $e7_0027_up${up27}$e7_0027_up$;
  c_up27    constant text  := '{F["up27"]}';
  c_down27  constant text  := '{F["down27"]}';
  c_hist26  constant text  := '{C_HIST26}';
  c_hist27  constant text  := '{C_HIST27}';
  c_pre     constant jsonb := '{c_pre}'::jsonb;
  c_post    constant jsonb := '{c_post}'::jsonb;
  c_kick    constant jsonb := '{kp_json}'::jsonb;
  c_acl     constant jsonb := '{acl_json}'::jsonb;
  inv jsonb; t_pre jsonb; t_post jsonb; h text; n bigint; mx int; k text; bad text := '';
  ids_pre text; hrows_pre text; prot_pre text; hist_pre text; blk_pre text;
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  PERFORM pg_advisory_xact_lock(7302215001);                             -- = db/lib/migrate.js LOCK_KEY (transaction-scoped)
  IF encode(sha256(convert_to(up27, 'UTF8')), 'hex') <> c_up27 THEN RAISE EXCEPTION 'E7_27_UP27_BYTES_MISMATCH'; END IF;
  IF current_user::text <> (SELECT pg_catalog.pg_get_userbyid(nspowner)::text FROM pg_catalog.pg_namespace WHERE nspname = 'booking') THEN RAISE EXCEPTION 'E7_27_NOT_SCHEMA_OWNER'; END IF;
  IF to_regclass('booking_migrations.applied') IS NULL THEN RAISE EXCEPTION 'E7_27_NO_TRACKING_TABLE'; END IF;
  IF to_regclass('booking.instance') IS NULL THEN RAISE EXCEPTION 'E7_27_NO_INSTANCE'; END IF;
  SELECT count(*) INTO n FROM booking.instance;
  IF n <> 1 OR (SELECT environment FROM booking.instance) IS DISTINCT FROM 'test' THEN RAISE EXCEPTION 'E7_27_NOT_TEST'; END IF;
  IF EXISTS (SELECT 1 FROM booking_migrations.applied WHERE environment IS DISTINCT FROM 'test') THEN RAISE EXCEPTION 'E7_27_ENV_MISMATCH'; END IF;
  SELECT max(version) INTO mx FROM booking_migrations.applied;
  IF mx >= 27 THEN
    -- provable exact-POST no-op: full history aggregate 0001-0027 AND the full POST identity AND the kickoff catalog; anything else is an explicit STOP
    inv := ({indent(inv_body, 11)});
    SELECT ({hist("")}) INTO h;
    IF mx = 27 AND (SELECT count(*) FROM booking_migrations.applied) = 27 AND (SELECT min(version) FROM booking_migrations.applied) = 1 AND h = c_hist27 THEN
      bad := '';
      FOR k IN SELECT jsonb_object_keys(c_post) LOOP
        IF (inv -> k) IS DISTINCT FROM (c_post -> k) THEN bad := bad || k || ','; END IF;
      END LOOP;
      IF {kick_catalog} IS DISTINCT FROM c_kick THEN bad := bad || 'kickoff_catalog,'; END IF;
      IF bad = '' THEN RAISE NOTICE 'E7_27_ALREADY_EXACT_NOOP'; RETURN; END IF;
      RAISE EXCEPTION 'E7_27_POST_STATE_MISMATCH_STOP:%', bad;
    END IF;
    RAISE EXCEPTION 'E7_27_POST_STATE_MISMATCH_STOP:history';
  END IF;
  IF (SELECT count(*) FROM booking_migrations.applied) <> 26 OR (SELECT min(version) FROM booking_migrations.applied) <> 1 OR mx <> 26
     THEN RAISE EXCEPTION 'E7_27_HISTORY_NOT_1_TO_26'; END IF;
  SELECT ({hist("")}) INTO h;
  IF h IS DISTINCT FROM c_hist26 THEN RAISE EXCEPTION 'E7_27_HISTORY_DRIFT'; END IF;
  -- quiescence
  IF {active_lock} THEN RAISE EXCEPTION 'E7_27_ACTIVE_RUN_LOCK_HELD'; END IF;
  IF NOT pg_try_advisory_xact_lock(pg_catalog.hashtext('{LOCK_KEY}'), 0) THEN RAISE EXCEPTION 'E7_27_ACTIVE_RUN_LOCK_HELD'; END IF;
  IF EXISTS (SELECT 1 FROM booking.intent_work WHERE work_worker_id IS NOT NULL OR work_lease_until IS NOT NULL) THEN RAISE EXCEPTION 'E7_27_ACTIVE_WORK_LEASE'; END IF;
  IF EXISTS (SELECT 1 FROM booking.intents WHERE lease_worker_id IS NOT NULL OR lease_until IS NOT NULL) THEN RAISE EXCEPTION 'E7_27_ACTIVE_INTENT_LEASE'; END IF;
  IF EXISTS (SELECT 1 FROM booking.external_operations WHERE lease_worker_id IS NOT NULL OR lease_until IS NOT NULL OR state = 'in_flight') THEN RAISE EXCEPTION 'E7_27_OPERATION_LEASED_OR_IN_FLIGHT'; END IF;
  IF {kick_pending} <> 0 THEN RAISE EXCEPTION 'E7_27_KICKOFF_REQUEST_UNSETTLED'; END IF;
  IF {prepared} <> 0 THEN RAISE EXCEPTION 'E7_27_PREPARED_TRANSACTION_PRESENT'; END IF;
  IF {write_locks} <> 0 THEN RAISE EXCEPTION 'E7_27_BOOKING_WRITE_LOCK_HELD'; END IF;
  inv := ({indent(inv_body, 9)});
{compare("inv", "c_pre", "E7_27_SCHEMA_IDENTITY_DRIFT")}
  IF {kick_catalog} IS DISTINCT FROM c_kick THEN RAISE EXCEPTION 'E7_27_KICKOFF_CATALOG_PRE_DRIFT'; END IF;
  t_pre := {tblfp};
  ids_pre := {intent_ids};
  hrows_pre := {hist_rows26};
  prot_pre := {protected_fp};
  hist_pre := {historical_fp};
  blk_pre := {blockers};
  PERFORM set_config('booking.migration_environment', 'test', true);
  -- ---- 0027, exactly what migrateUp does for one version ----
  EXECUTE up27;
  INSERT INTO booking_migrations.applied (version, name, up_checksum, down_checksum, environment) VALUES (27, '{F["name27"]}', c_up27, c_down27, 'test');
  -- ---- post-conditions (same statement; any failure rolls everything back) ----
  inv := ({indent(inv_body, 9)});
{compare("inv", "c_post", "E7_27_POST_SCHEMA_IDENTITY_UNEXPECTED")}
  IF {kick_catalog} IS DISTINCT FROM c_kick THEN RAISE EXCEPTION 'E7_27_KICKOFF_CATALOG_UNEXPECTED'; END IF;
  IF {acl_matrix} IS DISTINCT FROM c_acl THEN RAISE EXCEPTION 'E7_27_ACL_MATRIX_UNEXPECTED'; END IF;
  SELECT ({hist(" WHERE version <= 26")}) INTO h;
  IF h IS DISTINCT FROM c_hist26 OR {hist_rows26} IS DISTINCT FROM hrows_pre THEN RAISE EXCEPTION 'E7_27_POST_HISTORY_1_TO_26_CHANGED'; END IF;
  SELECT ({hist("")}) INTO h;
  IF h IS DISTINCT FROM c_hist27 OR (SELECT count(*) FROM booking_migrations.applied) <> 27
     OR NOT EXISTS (SELECT 1 FROM booking_migrations.applied WHERE version = 27 AND name = '{F["name27"]}' AND up_checksum = c_up27 AND down_checksum = c_down27 AND environment = 'test')
     THEN RAISE EXCEPTION 'E7_27_POST_TRACKING_ROW_UNEXPECTED'; END IF;
  t_post := {tblfp};
  IF t_post IS DISTINCT FROM t_pre THEN RAISE EXCEPTION 'E7_27_BOOKING_ROWS_CHANGED'; END IF;
  IF {cnt("external_cancellations")} <> 0 OR {cnt("external_refund_attestations")} <> 0 THEN RAISE EXCEPTION 'E7_27_NEW_TABLES_NOT_EMPTY'; END IF;
  IF {intent_ids} IS DISTINCT FROM ids_pre THEN RAISE EXCEPTION 'E7_27_INTENT_SET_CHANGED'; END IF;
  IF {protected_fp} IS DISTINCT FROM prot_pre OR {historical_fp} IS DISTINCT FROM hist_pre THEN RAISE EXCEPTION 'E7_27_PROTECTED_OR_HISTORICAL_CHANGED'; END IF;
  IF {blockers} IS DISTINCT FROM blk_pre THEN RAISE EXCEPTION 'E7_27_CLAIM_RELEASE_BLOCKERS_CHANGED'; END IF;
  IF {x27_latches} <> 0 THEN RAISE EXCEPTION 'E7_27_EXTERNALLY_CANCELLED_LATCH_PRESENT'; END IF;
  IF {projection_nonnull} <> 0 THEN RAISE EXCEPTION 'E7_27_GUEST_PROJECTION_NOT_NULL'; END IF;
  RAISE NOTICE 'E7_27_APPLIED';
END
$e7pkg$;
-- read-only status line (the editor's last result; the true state whether or not the DO above succeeded)
SELECT jsonb_build_object('migrations_max', (SELECT max(version) FROM booking_migrations.applied),
  'v27', EXISTS (SELECT 1 FROM booking_migrations.applied WHERE version = 27),
  'external_cancellations', {cnt("external_cancellations")},
  'external_refund_attestations', {cnt("external_refund_attestations")},
  'externally_cancelled_latches', {x27_latches},
  'functions_sha256', ({indent(inv_body, 2)}) -> 'functions') AS e7_27_status;
"""

readback = f"""-- e7-0027-readback-v1.sql — PURE READ-ONLY (C118). Run it BEFORE and AFTER the 0027 apply wrapper and compare with the pins
-- (claude/e7-0027-pins-v1.json: `pre` must equal the BEFORE identity keys, `post` the AFTER). LABELLED SPECIALISATION of the accepted
-- claude/e7-0025-0026-readback-v1.sql. Writes nothing, takes no lock, returns only counts / hashes / flags (no guest field, no credential). Schema owner.
-- `identity` = claude/e7-0027-inventory.sql verbatim (sha256 {pins["inventorySql"]}).
-- `exclusion` shows why an apply would refuse now. `data` must be IDENTICAL before and after: per-table count + whole-row fingerprint over EVERY
-- pre-existing booking table (the two 0027 tables excluded; reported separately in `x27`), the intent id set, the whole 0001-0026 history rows, the
-- sanitized protected-reservation / historical-intent fingerprints (counts + md5 only) and the claim-release-blocker output of every intent.
-- `kickoff_catalog` BEFORE and AFTER == pins.kickoffCatalogPins (= scripts/e7-hosted-kickoff.mjs CATALOG_PINS on main 92c1b674, for mv_booking_app).
-- Expected BEFORE: identity.functions = {PRE["functions"]}, migrations.max = 26, aggregate = {C_HIST26},
--                  x27 = all null (no 0027 objects) except externally_cancelled_latches = 0.
-- Expected AFTER:  identity.functions = {POST["functions"]}, migrations.max = 27, aggregate = {C_HIST27}, aggregate_1_26 unchanged,
--                  v27 up {F["up27"]}, `data` identical, x27 = {{external_cancellations: 0, external_refund_attestations: 0, externally_cancelled_latches: 0,
--                  projection_not_null: 0, acl: (the wrapper's c_acl)}}.
SELECT jsonb_build_object(
  'identity', ({indent(inv_body, 15)}),
  'instance', (SELECT jsonb_build_object('rows', count(*), 'environment', min(environment)) FROM booking.instance),
  'current_user', current_user::text,
  'exclusion', jsonb_build_object(
    'hosted_run_lock_held', {active_lock},
    'work_leases', (SELECT count(*) FROM booking.intent_work WHERE work_worker_id IS NOT NULL OR work_lease_until IS NOT NULL),
    'intent_leases', (SELECT count(*) FROM booking.intents WHERE lease_worker_id IS NOT NULL OR lease_until IS NOT NULL),
    'operation_leases_or_in_flight', (SELECT count(*) FROM booking.external_operations WHERE lease_worker_id IS NOT NULL OR lease_until IS NOT NULL OR state = 'in_flight'),
    'kickoff_unsettled', {kick_pending},
    'prepared_transactions', {prepared},
    'other_session_write_locks', {write_locks}),
  'data', jsonb_build_object(
    'booking_tables', {tblfp},
    'intent_ids', {intent_ids},
    'history_rows_1_26', {hist_rows26},
    'protected_reservations', {protected_fp},
    'historical_intents', {historical_fp},
    'claim_release_blockers', {blockers}),
  'kickoff_rows', {kickoff_rows},
  'kickoff_catalog', {kick_catalog},
  'x27', jsonb_build_object(
    'external_cancellations', {cnt("external_cancellations")},
    'external_refund_attestations', {cnt("external_refund_attestations")},
    'externally_cancelled_latches', {x27_latches},
    'projection_not_null', {projection_nonnull},
    'acl', {acl_matrix})
) AS e7_27_readback;
"""

for path, text in (("claude/e7-0027-sqleditor-apply-v1.sql", wrapper), ("claude/e7-0027-readback-v1.sql", readback)):
    full = os.path.join(ROOT, path)
    if os.path.exists(full) and not WRITE:
        assert open(full, encoding="utf8").read() == text, f"{path} is not byte-identical to the deterministic assembly (re-run with --write)"
    else:
        open(full, "w", encoding="utf8").write(text)
    print(path, "sha256:", sha(text))
assert re.search(r"\$e7_0027_up\$(.*?)\$e7_0027_up\$", wrapper, re.S).group(1) == up27
for v in sorted(f for f in os.listdir(os.path.join(ROOT, "db/migrations")) if f.endswith(".up.sql") and not f.startswith("0027_")):
    assert rd(f"db/migrations/{v}") not in wrapper, v
assert down27 not in wrapper
outside = re.sub(r"\$e7_0027_up\$.*?\$e7_0027_up\$", "", wrapper, flags=re.S)
assert not re.search(r"(PERFORM|SELECT|CALL)\s+booking\.(admin_record_external_cancellation|admin_attest_external_refund|admin_record_evidence)\b|INSERT INTO booking\.|UPDATE booking\.|DELETE FROM booking\.", outside), \
    "no disposition / evidence / booking write outside the embedded up"
print("embedded up27 sha256:", sha(up27))
