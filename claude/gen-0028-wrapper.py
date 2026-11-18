#!/usr/bin/env python3
# Generator for claude/e7-0028-sqleditor-apply-v1.sql and claude/e7-0028-readback-v1.sql (C119 S4) — LABELLED SPECIALISATION of the accepted
# claude/gen-0027-wrapper.py for ONE migration, 0028_pipeline_kickoff_source_rebind_s4, on a database that carries EXACTLY 0001-0027 (the accepted 0027
# packet's POST state). 0028 replaces ONE function body (booking.claim_pipeline_kickoff: only the expected_source_digest literal 880db5b3… → 5294b6b4…);
# it adds no table, column, function, trigger, policy or grant. Deterministic exact-source assembly:
#   * embeds db/migrations/0028_*.up.sql VERBATIM (sha256-checked in-transaction against the pinned migrator checksum; ONE tracking row carrying exactly
#     the migrator's name / up / down checksums),
#   * pins every PRE (0001-0027) / POST (0001-0028) schema-identity fact from claude/e7-0028-pins-v1.json (derived on a DISPOSABLE cluster by
#     claude/derive-0028-pins.mjs with the accepted migrator; PG16 == PG17) and embeds claude/e7-0028-inventory.sql VERBATIM; the ONLY identity key
#     that may change is `functions` (asserted from the pins),
#   * the claim function body POST == the PRE body with EXACTLY the one literal replaced (each literal exactly once / never), same OID-independent
#     signature / owner / ACL / definer / volatility / search_path (part of the pinned identity),
#   * pins the hosted kickoff runner's CATALOG_PINS for the RUNTIME APP ROLE at PRE (= main 5b9c0677) and POST (= the MERGED S4 main a86437a8 — the
#     runtime runner that will read this database),
#   * row preservation over EVERY booking table (0028 touches no row): count + whole-row fingerprint per table (this includes the recorded C116
#     cancellation / refund attestation, inventory claims, guest.notify operations, receipts, payment attempts and the ledger), the intent id set,
#     whole 0001-0027 history rows, the sanitized protected / historical fingerprints (the accepted lists, verbatim), the claim-release-blocker output
#     of EVERY intent, the EXTERNALLY_CANCELLED latch count and the non-null guest projection count (each UNCHANGED, not assumed zero),
#   * never edits a merged migration; NEVER embeds / applies 0001-0027 or any down; never records a cancellation, evidence, attestation or claim;
#     never adopts / upserts / backfills / repairs; refuses on ANY drift.
# Run from the worktree root:  python3 claude/gen-0028-wrapper.py .   (asserts byte-identical regeneration when the outputs exist, unless --write)
import hashlib, json, os, re, sys

ROOT = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("--") else "."
WRITE = "--write" in sys.argv
rd = lambda p: open(os.path.join(ROOT, p), encoding="utf8").read()
sha = lambda s: hashlib.sha256(s.encode("utf8")).hexdigest()

pins = json.loads(rd("claude/e7-0028-pins-v1.json"))
assert pins["schema"] == "e7-0028-pins-v1"
F = pins["files"]
assert F["name28"] == "pipeline_kickoff_source_rebind_s4"
up28 = rd(f"db/migrations/0028_{F['name28']}.up.sql"); down28 = rd(f"db/migrations/0028_{F['name28']}.down.sql")
assert (sha(up28), sha(down28)) == (F["up28"], F["down28"]), "merged migration bytes differ from the pins"
assert F["up28"] == "a72d2ce911cac924b728525f1af43b547c7e908a96bdecbf84f41ca3ebfa3642" and F["down28"] == "c247b17883b23ecdba1eb0ec2a94e5e0e9caa558724ee29c4b0500fb7b77806f"
for tag in ("$e7_0028_up$", "$e7pkg$"): assert tag not in up28, tag
assert not re.search(r"^\s*(BEGIN|COMMIT|ROLLBACK|START TRANSACTION)\s*(WORK|TRANSACTION)?\s*;", up28, re.M | re.I), "the embedded up must not control the transaction"
inventory = rd("claude/e7-0028-inventory.sql")
assert sha(inventory) == pins["inventorySql"], "inventory probe changed after the pins were derived: re-derive"
inv_body = "\n".join(l for l in inventory.splitlines() if not l.startswith("--")).strip()
assert inv_body.endswith(" AS e7_inventory"); inv_body = inv_body[: -len(" AS e7_inventory")]
assert "$" not in inv_body, "dollar signs would break the DO body"
OLD, NEW = pins["literal"]["old"], pins["literal"]["new"]
assert (OLD, NEW) == ("880db5b33024edbf0879fbaf5a3826e3622db12fd1808e8c2047238da507fe1b", "5294b6b467839e1dd825e56063abc1ad1267eafdfb2973f2c2129e9b1f29c3f5")
assert up28.count(NEW) == 1 and OLD not in up28 and down28.count(OLD) == 1 and NEW not in down28

PRE, POST = pins["pre"], pins["post"]
IDENTITY_KEYS = ["functions", "function_count", "triggers", "trigger_count", "constraints", "indexes", "columns", "table_acls", "rls", "rls_enabled_count", "policies", "policy_count",
                 "schema_owner", "is_privileged_src", "is_privileged_config", "relations", "relation_count", "test_cleanup_pending_state", "prerequisite_0023", "objects", "acls"]
ident = lambda inv: json.dumps({k: inv[k] for k in IDENTITY_KEYS}, sort_keys=True, separators=(",", ":"))
c_pre, c_post = ident(PRE), ident(POST)
for s in (c_pre, c_post): assert "'" not in s and "$" not in s
assert [k for k in IDENTITY_KEYS if PRE[k] != POST[k]] == ["functions"] == pins["identityKeysChanged"], "0028 changes ONLY the function-definition fingerprint"
assert all(v for k, v in PRE["objects"].items() if k.startswith("x27_")), "0027 objects present PRE"
C_HIST27 = PRE["migrations"]["aggregate"]; C_HIST28 = POST["migrations"]["aggregate"]
assert (PRE["migrations"]["count"], PRE["migrations"]["max"], POST["migrations"]["count"], POST["migrations"]["max"]) == (27, 27, 28, 28)
assert PRE["migrations"]["aggregate_1_27"] == C_HIST27 == POST["migrations"]["aggregate_1_27"]
assert C_HIST27 == "f6f3b20b6be4a603a9fbc6472743dfa9e4d8af62c78156e90c13d34894147980", "PRE history = the accepted 0027 packet's POST aggregate"
assert PRE["functions"] == "137ea3dae9fb20cd8486598cc6ae71a4a619a34df51a096df501cdda07c15e82", "PRE functions = the accepted 0027 packet's POST functions"
assert pins["claimSrcMd5"] == {"pre": "fb103173762c5dc6565338d2a15dd067", "post": "98ffe6c804377b46b0d3d8907ac7d284"}
KPRE, KPOST = pins["kickoffCatalogPre"], pins["kickoffCatalogPost"]
assert KPRE != KPOST and [f["src"] for f in KPRE["functions"][1:]] == [f["src"] for f in KPOST["functions"][1:]] and KPRE["table"] == KPOST["table"], "only the claim src differs"
kpre_json = json.dumps(KPRE, sort_keys=True, separators=(",", ":")); kpost_json = json.dumps(KPOST, sort_keys=True, separators=(",", ":"))
for s in (kpre_json, kpost_json): assert "'" not in s and "$" not in s

LOCK_KEY = "e7-connected-runner"   # = scripts/e7-connected/run-lock-precheck.mjs LOCK_KEY (asserted by the tests)
PROTECTED = ["70636076", "71045356", "71072615", "71081885"]                       # the accepted packets' lists, verbatim (already public; unchanged)
HISTORICAL = ["abede8b1-8ef6-44f2-876e-6a02fc056a96", "c83c1842-d342-4e27-9ab7-dc3d50b7a309", "954d476c-71ea-4824-92f6-2220ae302103",
              "669da884-02e8-4105-8825-f908e5d22ae9", "1d6e770f-ba3d-40f7-92c1-ee01be7da532"]
CLAIM = "booking.claim_pipeline_kickoff(uuid,text,text,jsonb)"

# per-table count + whole-row fingerprint over EVERY booking table (0028 adds no table and no column). The table list is read from the catalog.
tblfp = ("(SELECT jsonb_object_agg(t.relname, x.v ORDER BY t.relname) FROM pg_catalog.pg_class t JOIN pg_catalog.pg_namespace s ON s.oid = t.relnamespace, "
         "LATERAL (SELECT (xpath('/row/v/text()', query_to_xml(format("
         "'SELECT count(*) || '':'' || md5(coalesce(string_agg(q.r, E''\\n'' ORDER BY q.r), '''')) AS v FROM (SELECT to_jsonb(x)::text AS r FROM booking.%I x) q', t.relname), "
         "false, true, '')))[1]::text AS v) x WHERE s.nspname = 'booking' AND t.relkind IN ('r', 'p'))")
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
hist_rows27 = ("(SELECT count(*) || ':' || md5(coalesce(string_agg(to_jsonb(a)::text, E'\\n' ORDER BY a.version), '')) FROM booking_migrations.applied a WHERE a.version <= 27)")
kickoff_rows = "(SELECT count(*) FROM booking.pipeline_kickoff_requests)"
prot_list = ", ".join(f"'{p}'" for p in PROTECTED); hist_list = ", ".join(f"'{h}'" for h in HISTORICAL)
protected_fp = ("(SELECT count(*) || ':' || md5(coalesce(string_agg(to_jsonb(i)::text, E'\\n' ORDER BY i.id), '')) FROM booking.intents i "
                f"WHERE i.hostaway_reservation_id::text IN ({prot_list}))")
historical_fp = ("(SELECT count(*) || ':' || md5(coalesce(string_agg(to_jsonb(i)::text, E'\\n' ORDER BY i.id), '')) FROM booking.intents i "
                 f"WHERE i.id::text IN ({hist_list}))")
# the hosted kickoff runner's catalog probe, evaluated for the RUNTIME APP ROLE (explicit role argument; the wrapper runs as the schema owner) —
# byte-identical to the accepted claude/gen-0027-wrapper.py kick_catalog
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
claim_src = f"(SELECT p.prosrc FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('{CLAIM}'))"
ROLES = ["mv_booking_app", "mv_booking_admin", "mv_booking_report", "public"]
claim_acl = "jsonb_build_object(" + ", ".join(f"'{r}', has_function_privilege('{r}', to_regprocedure('{CLAIM}'), 'EXECUTE')" for r in ROLES) + ")"
EXPECTED_CLAIM_ACL = {"mv_booking_admin": False, "mv_booking_app": True, "mv_booking_report": False, "public": False}
claim_acl_json = json.dumps(EXPECTED_CLAIM_ACL, sort_keys=True, separators=(",", ":"))
# 0027 state that must be UNCHANGED (never assumed zero: the C116 cancellation is recorded on shared TEST)
x27_latches = "(SELECT count(*) FROM booking.notification_latches WHERE code = 'EXTERNALLY_CANCELLED')"
projection_nonnull = "(SELECT count(*) FROM booking.intents i WHERE booking.external_cancellation_public(i.id) IS NOT NULL)"
blockers = ("(SELECT count(*) || ':' || md5(coalesce(string_agg(i.id::text || '=' || array_to_string(booking.claim_release_blockers(i.id), ','), E'\\n' ORDER BY i.id), '')) "
            "FROM booking.intents i)")
kick_pending = "(SELECT count(*) FROM booking.pipeline_kickoff_requests WHERE state IN ('requested', 'claimed', 'dispatch_unknown'))"

wrapper = f"""-- e7-0028-sqleditor-apply-v1.sql — ONE atomic DO statement for the Supabase SQL editor (schema owner = dashboard `postgres`). C119 S4.
-- Reviewable packet for the maraVilla shared TEST database at EXACTLY 0001-0027. ROOT reviews and owns any actual shared apply; this file is not an
-- owner command. LABELLED SPECIALISATION of the accepted claude/e7-0027-sqleditor-apply-v1.sql for ONE migration: applies EXACTLY
-- db/migrations/0028_{F["name28"]}.up.sql (bytes embedded verbatim, sha256-checked in-transaction) mirroring db/lib/migrate.js migrateUp: advisory xact
-- lock 7302215001; TEST instance + schema-owner role; history exactly 0001-0027 (names + checksums = the accepted 0027 packet's POST aggregate);
-- FULL PRE schema identity + the PRE-S4 kickoff catalog (main 5b9c0677) for the runtime app role; quiescence (hosted-run lock, work / intent /
-- operation leases, in-flight operations, unsettled kickoff requests, prepared transactions, other sessions' write locks on booking relations); then
-- 0028 up + ONE tracking row; the FULL POST identity (ONLY `functions` differs from PRE); the claim body == the PRE body with EXACTLY the one source
-- literal replaced; the claim ACL unchanged (runtime role EXECUTE only); the POST kickoff catalog == the MERGED S4 main a86437a8 CATALOG_PINS for the
-- runtime app role; unchanged 0001-0027 history rows (whole rows); EVERY booking table's count + whole-row fingerprint UNCHANGED (incl. the recorded
-- C116 cancellation / refund attestation, claims, notify operations, receipts, payment attempts, ledger); the intent id set; the sanitized protected /
-- historical fingerprints; the claim-release-blocker output of EVERY intent; the EXTERNALLY_CANCELLED latch count and the guest projection count.
-- Any drift → RAISE → the whole statement rolls back (schema, data and history unchanged). Never adopts, upserts, backfills, repairs, widens a grant or
-- runs a down; never embeds 0001-0027. Zero booking DML. Returns no guest field and no credential.
-- REPLAY: on a database already at EXACTLY the pinned POST state (history 0001-0028 aggregate + full POST identity + POST kickoff catalog) it is a provable
-- NO-OP (no write, notice E7_28_ALREADY_EXACT_NOOP). Any other state at or above 28 → E7_28_POST_STATE_MISMATCH_STOP; never "repaired" or continued.
-- After an UNCERTAIN issuance ROOT runs claude/e7-0028-readback-v1.sql FIRST and never re-issues blindly.
-- Applying 0028 enables nothing: every hosted runner on main ships executeEnabled / dispatchEnabled / readEnabled FALSE; no worker, flag, variable,
-- environment or workflow changes. After it the MERGED main runners' pins match (kickoff CATALOG_PINS; notification / status catalogPin28), and the
-- PRE-S4 runners (main 5b9c0677 and earlier) refuse — fail-closed.
-- Generated by claude/gen-0028-wrapper.py from the merged migration bytes + claude/e7-0028-pins-v1.json (disposable-cluster derived); the identity probe
-- is claude/e7-0028-inventory.sql verbatim. TIME BOUND: the SET LOCAL statements below run BEFORE the DO in the same editor batch (one implicit
-- transaction block), so they bound the DO and leave the caller's session settings unchanged afterwards.
SET LOCAL statement_timeout = '180s';
SET LOCAL lock_timeout = '5s';
DO $e7pkg$
DECLARE
  up28      constant text  := $e7_0028_up${up28}$e7_0028_up$;
  c_up28    constant text  := '{F["up28"]}';
  c_down28  constant text  := '{F["down28"]}';
  c_hist27  constant text  := '{C_HIST27}';
  c_hist28  constant text  := '{C_HIST28}';
  c_pre     constant jsonb := '{c_pre}'::jsonb;
  c_post    constant jsonb := '{c_post}'::jsonb;
  c_kick_pre  constant jsonb := '{kpre_json}'::jsonb;
  c_kick_post constant jsonb := '{kpost_json}'::jsonb;
  c_claim_acl constant jsonb := '{claim_acl_json}'::jsonb;
  c_old     constant text  := '{OLD}';
  c_new     constant text  := '{NEW}';
  inv jsonb; t_pre jsonb; t_post jsonb; h text; n bigint; mx int; k text; bad text := '';
  ids_pre text; hrows_pre text; prot_pre text; hist_pre text; blk_pre text; src_pre text; src_post text; latch_pre bigint; proj_pre bigint;
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  PERFORM pg_advisory_xact_lock(7302215001);                             -- = db/lib/migrate.js LOCK_KEY (transaction-scoped)
  IF encode(sha256(convert_to(up28, 'UTF8')), 'hex') <> c_up28 THEN RAISE EXCEPTION 'E7_28_UP28_BYTES_MISMATCH'; END IF;
  IF current_user::text <> (SELECT pg_catalog.pg_get_userbyid(nspowner)::text FROM pg_catalog.pg_namespace WHERE nspname = 'booking') THEN RAISE EXCEPTION 'E7_28_NOT_SCHEMA_OWNER'; END IF;
  IF to_regclass('booking_migrations.applied') IS NULL THEN RAISE EXCEPTION 'E7_28_NO_TRACKING_TABLE'; END IF;
  IF to_regclass('booking.instance') IS NULL THEN RAISE EXCEPTION 'E7_28_NO_INSTANCE'; END IF;
  SELECT count(*) INTO n FROM booking.instance;
  IF n <> 1 OR (SELECT environment FROM booking.instance) IS DISTINCT FROM 'test' THEN RAISE EXCEPTION 'E7_28_NOT_TEST'; END IF;
  IF EXISTS (SELECT 1 FROM booking_migrations.applied WHERE environment IS DISTINCT FROM 'test') THEN RAISE EXCEPTION 'E7_28_ENV_MISMATCH'; END IF;
  SELECT max(version) INTO mx FROM booking_migrations.applied;
  IF mx >= 28 THEN
    -- provable exact-POST no-op: full history aggregate 0001-0028 AND the full POST identity AND the POST kickoff catalog; anything else is an explicit STOP
    inv := ({indent(inv_body, 11)});
    SELECT ({hist("")}) INTO h;
    IF mx = 28 AND (SELECT count(*) FROM booking_migrations.applied) = 28 AND (SELECT min(version) FROM booking_migrations.applied) = 1 AND h = c_hist28 THEN
      bad := '';
      FOR k IN SELECT jsonb_object_keys(c_post) LOOP
        IF (inv -> k) IS DISTINCT FROM (c_post -> k) THEN bad := bad || k || ','; END IF;
      END LOOP;
      IF {kick_catalog} IS DISTINCT FROM c_kick_post THEN bad := bad || 'kickoff_catalog,'; END IF;
      IF bad = '' THEN RAISE NOTICE 'E7_28_ALREADY_EXACT_NOOP'; RETURN; END IF;
      RAISE EXCEPTION 'E7_28_POST_STATE_MISMATCH_STOP:%', bad;
    END IF;
    RAISE EXCEPTION 'E7_28_POST_STATE_MISMATCH_STOP:history';
  END IF;
  IF (SELECT count(*) FROM booking_migrations.applied) <> 27 OR (SELECT min(version) FROM booking_migrations.applied) <> 1 OR mx <> 27
     THEN RAISE EXCEPTION 'E7_28_HISTORY_NOT_1_TO_27'; END IF;
  SELECT ({hist("")}) INTO h;
  IF h IS DISTINCT FROM c_hist27 THEN RAISE EXCEPTION 'E7_28_HISTORY_DRIFT'; END IF;
  -- quiescence
  IF {active_lock} THEN RAISE EXCEPTION 'E7_28_ACTIVE_RUN_LOCK_HELD'; END IF;
  IF NOT pg_try_advisory_xact_lock(pg_catalog.hashtext('{LOCK_KEY}'), 0) THEN RAISE EXCEPTION 'E7_28_ACTIVE_RUN_LOCK_HELD'; END IF;
  IF EXISTS (SELECT 1 FROM booking.intent_work WHERE work_worker_id IS NOT NULL OR work_lease_until IS NOT NULL) THEN RAISE EXCEPTION 'E7_28_ACTIVE_WORK_LEASE'; END IF;
  IF EXISTS (SELECT 1 FROM booking.intents WHERE lease_worker_id IS NOT NULL OR lease_until IS NOT NULL) THEN RAISE EXCEPTION 'E7_28_ACTIVE_INTENT_LEASE'; END IF;
  IF EXISTS (SELECT 1 FROM booking.external_operations WHERE lease_worker_id IS NOT NULL OR lease_until IS NOT NULL OR state = 'in_flight') THEN RAISE EXCEPTION 'E7_28_OPERATION_LEASED_OR_IN_FLIGHT'; END IF;
  IF {kick_pending} <> 0 THEN RAISE EXCEPTION 'E7_28_KICKOFF_REQUEST_UNSETTLED'; END IF;
  IF {prepared} <> 0 THEN RAISE EXCEPTION 'E7_28_PREPARED_TRANSACTION_PRESENT'; END IF;
  IF {write_locks} <> 0 THEN RAISE EXCEPTION 'E7_28_BOOKING_WRITE_LOCK_HELD'; END IF;
  inv := ({indent(inv_body, 9)});
{compare("inv", "c_pre", "E7_28_SCHEMA_IDENTITY_DRIFT")}
  IF {kick_catalog} IS DISTINCT FROM c_kick_pre THEN RAISE EXCEPTION 'E7_28_KICKOFF_CATALOG_PRE_DRIFT'; END IF;
  IF {claim_acl} IS DISTINCT FROM c_claim_acl THEN RAISE EXCEPTION 'E7_28_CLAIM_ACL_PRE_DRIFT'; END IF;
  src_pre := {claim_src};
  IF src_pre IS NULL OR array_length(string_to_array(src_pre, c_old), 1) <> 2 OR position(c_new IN src_pre) <> 0 THEN RAISE EXCEPTION 'E7_28_CLAIM_PRE_LITERAL_DRIFT'; END IF;
  t_pre := {tblfp};
  ids_pre := {intent_ids};
  hrows_pre := {hist_rows27};
  prot_pre := {protected_fp};
  hist_pre := {historical_fp};
  blk_pre := {blockers};
  latch_pre := {x27_latches};
  proj_pre := {projection_nonnull};
  PERFORM set_config('booking.migration_environment', 'test', true);
  -- ---- 0028, exactly what migrateUp does for one version ----
  EXECUTE up28;
  INSERT INTO booking_migrations.applied (version, name, up_checksum, down_checksum, environment) VALUES (28, '{F["name28"]}', c_up28, c_down28, 'test');
  -- ---- post-conditions (same statement; any failure rolls everything back) ----
  inv := ({indent(inv_body, 9)});
{compare("inv", "c_post", "E7_28_POST_SCHEMA_IDENTITY_UNEXPECTED")}
  src_post := {claim_src};
  IF src_post IS DISTINCT FROM replace(src_pre, c_old, c_new) OR array_length(string_to_array(src_post, c_new), 1) <> 2 OR position(c_old IN src_post) <> 0
     THEN RAISE EXCEPTION 'E7_28_CLAIM_BODY_UNEXPECTED'; END IF;
  IF {claim_acl} IS DISTINCT FROM c_claim_acl THEN RAISE EXCEPTION 'E7_28_CLAIM_ACL_UNEXPECTED'; END IF;
  IF {kick_catalog} IS DISTINCT FROM c_kick_post THEN RAISE EXCEPTION 'E7_28_KICKOFF_CATALOG_UNEXPECTED'; END IF;
  SELECT ({hist(" WHERE version <= 27")}) INTO h;
  IF h IS DISTINCT FROM c_hist27 OR {hist_rows27} IS DISTINCT FROM hrows_pre THEN RAISE EXCEPTION 'E7_28_POST_HISTORY_1_TO_27_CHANGED'; END IF;
  SELECT ({hist("")}) INTO h;
  IF h IS DISTINCT FROM c_hist28 OR (SELECT count(*) FROM booking_migrations.applied) <> 28
     OR NOT EXISTS (SELECT 1 FROM booking_migrations.applied WHERE version = 28 AND name = '{F["name28"]}' AND up_checksum = c_up28 AND down_checksum = c_down28 AND environment = 'test')
     THEN RAISE EXCEPTION 'E7_28_POST_TRACKING_ROW_UNEXPECTED'; END IF;
  t_post := {tblfp};
  IF t_post IS DISTINCT FROM t_pre THEN RAISE EXCEPTION 'E7_28_BOOKING_ROWS_CHANGED'; END IF;
  IF {intent_ids} IS DISTINCT FROM ids_pre THEN RAISE EXCEPTION 'E7_28_INTENT_SET_CHANGED'; END IF;
  IF {protected_fp} IS DISTINCT FROM prot_pre OR {historical_fp} IS DISTINCT FROM hist_pre THEN RAISE EXCEPTION 'E7_28_PROTECTED_OR_HISTORICAL_CHANGED'; END IF;
  IF {blockers} IS DISTINCT FROM blk_pre THEN RAISE EXCEPTION 'E7_28_CLAIM_RELEASE_BLOCKERS_CHANGED'; END IF;
  IF {x27_latches} IS DISTINCT FROM latch_pre OR {projection_nonnull} IS DISTINCT FROM proj_pre THEN RAISE EXCEPTION 'E7_28_CANCELLATION_STATE_CHANGED'; END IF;
  RAISE NOTICE 'E7_28_APPLIED';
END
$e7pkg$;
-- read-only status line (the editor's last result; the true state whether or not the DO above succeeded)
SELECT jsonb_build_object('migrations_max', (SELECT max(version) FROM booking_migrations.applied),
  'v28', EXISTS (SELECT 1 FROM booking_migrations.applied WHERE version = 28),
  'claim_src_md5', md5({claim_src}),
  'functions_sha256', ({indent(inv_body, 2)}) -> 'functions') AS e7_28_status;
"""

readback = f"""-- e7-0028-readback-v1.sql — PURE READ-ONLY (C119 S4). Run it BEFORE and AFTER the 0028 apply wrapper and compare with the pins
-- (claude/e7-0028-pins-v1.json: `pre` must equal the BEFORE identity keys, `post` the AFTER). LABELLED SPECIALISATION of the accepted
-- claude/e7-0027-readback-v1.sql. Writes nothing, takes no lock, returns only counts / hashes / flags (no guest field, no credential). Schema owner.
-- `identity` = claude/e7-0028-inventory.sql verbatim (sha256 {pins["inventorySql"]}).
-- `exclusion` shows why an apply would refuse now. `data` must be IDENTICAL before and after: per-table count + whole-row fingerprint over EVERY
-- booking table, the intent id set, the whole 0001-0027 history rows, the sanitized protected-reservation / historical-intent fingerprints (counts + md5
-- only), the claim-release-blocker output of every intent, the EXTERNALLY_CANCELLED latch count and the non-null guest projection count.
-- `kickoff_catalog` BEFORE == pins.kickoffCatalogPre (main 5b9c0677 CATALOG_PINS); AFTER == pins.kickoffCatalogPost (MERGED S4 main a86437a8).
-- Expected BEFORE: identity.functions = {PRE["functions"]}, migrations.max = 27, aggregate = {C_HIST27},
--                  claim.src_md5 = {pins["claimSrcMd5"]["pre"]}, claim.old_literal = 1, claim.new_literal = 0.
-- Expected AFTER:  identity.functions = {POST["functions"]}, migrations.max = 28, aggregate = {C_HIST28}, aggregate_1_27 unchanged,
--                  v28 up {F["up28"]}, `data` identical, claim.src_md5 = {pins["claimSrcMd5"]["post"]}, claim.old_literal = 0, claim.new_literal = 1,
--                  claim.acl = {claim_acl_json}.
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
    'history_rows_1_27', {hist_rows27},
    'protected_reservations', {protected_fp},
    'historical_intents', {historical_fp},
    'claim_release_blockers', {blockers},
    'externally_cancelled_latches', {x27_latches},
    'projection_not_null', {projection_nonnull}),
  'kickoff_rows', {kickoff_rows},
  'kickoff_catalog', {kick_catalog},
  'claim', jsonb_build_object(
    'src_md5', md5({claim_src}),
    'old_literal', array_length(string_to_array({claim_src}, '{OLD}'), 1) - 1,
    'new_literal', array_length(string_to_array({claim_src}, '{NEW}'), 1) - 1,
    'acl', {claim_acl})
) AS e7_28_readback;
"""

for path, text in (("claude/e7-0028-sqleditor-apply-v1.sql", wrapper), ("claude/e7-0028-readback-v1.sql", readback)):
    full = os.path.join(ROOT, path)
    if os.path.exists(full) and not WRITE:
        assert open(full, encoding="utf8").read() == text, f"{path} is not byte-identical to the deterministic assembly (re-run with --write)"
    else:
        open(full, "w", encoding="utf8").write(text)
    print(path, "sha256:", sha(text))
assert re.search(r"\$e7_0028_up\$(.*?)\$e7_0028_up\$", wrapper, re.S).group(1) == up28
for v in sorted(f for f in os.listdir(os.path.join(ROOT, "db/migrations")) if f.endswith(".up.sql") and not f.startswith("0028_")):
    assert rd(f"db/migrations/{v}") not in wrapper, v
assert down28 not in wrapper
outside = re.sub(r"\$e7_0028_up\$.*?\$e7_0028_up\$", "", wrapper, flags=re.S)
assert not re.search(r"(PERFORM|SELECT|CALL)\s+booking\.(admin_record_external_cancellation|admin_attest_external_refund|admin_record_evidence|claim_pipeline_kickoff)\s*\(|INSERT INTO booking\.|UPDATE booking\.|DELETE FROM booking\.", outside), \
    "no cancellation / evidence / claim / booking write outside the embedded up"
print("embedded up28 sha256:", sha(up28))
