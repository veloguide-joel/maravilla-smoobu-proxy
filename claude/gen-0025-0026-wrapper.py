#!/usr/bin/env python3
# Generator for claude/e7-0025-0026-sqleditor-apply-v1.sql and claude/e7-0025-0026-readback-v1.sql (C116) — LABELLED SPECIALISATION of the accepted
# claude/gen-0024-wrapper.py for TWO consecutive in-place function replacements (0025_gn_sink_recipient_scope, 0026_pipeline_kickoff_source_rebind) on a
# database that carries EXACTLY 0001-0024 (the accepted 0024 packet's POST state). Deterministic exact-source assembly:
#   * embeds db/migrations/0025_*.up.sql and 0026_*.up.sql VERBATIM (each sha256-checked in-transaction against the pinned migrator checksum; ONE
#     tracking row each, carrying exactly the migrator's name / up / down checksums), in version order, with a MID identity check after 0025,
#   * pins every PRE (0001-0024) / MID (0001-0025) / POST (0001-0026) schema-identity fact from claude/e7-0025-0026-pins-v1.json (derived on a DISPOSABLE
#     cluster by claude/derive-0025-0026-pins.mjs with the accepted migrator; PG16 == PG17) and embeds claude/e7-0025-0026-inventory.sql VERBATIM,
#   * pins the merged hosted kickoff runner's CATALOG_PINS (main adacbdad) at POST (and the 0024 packet's pins at PRE) for the RUNTIME APP ROLE,
#   * row preservation over EVERY booking table (0025 / 0026 add / drop no table or column — asserted from the pins), incl. pipeline_kickoff_requests and
#     the notification tables, plus the intent id set, whole 0001-0024 history rows and the sanitized protected / historical fingerprints,
#   * never edits a merged migration; NEVER embeds / applies 0001-0024 or any down; never adopts / upserts / backfills / repairs; refuses on ANY drift.
# Run from the worktree root:  python3 claude/gen-0025-0026-wrapper.py .   (asserts byte-identical regeneration when the outputs exist, unless --write)
import hashlib, json, os, re, sys

ROOT = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("--") else "."
WRITE = "--write" in sys.argv
rd = lambda p: open(os.path.join(ROOT, p), encoding="utf8").read()
sha = lambda s: hashlib.sha256(s.encode("utf8")).hexdigest()

pins = json.loads(rd("claude/e7-0025-0026-pins-v1.json"))
assert pins["schema"] == "e7-0025-0026-pins-v1"
F = pins["files"]
assert (F["name25"], F["name26"]) == ("gn_sink_recipient_scope", "pipeline_kickoff_source_rebind")
up25 = rd(f"db/migrations/0025_{F['name25']}.up.sql"); down25 = rd(f"db/migrations/0025_{F['name25']}.down.sql")
up26 = rd(f"db/migrations/0026_{F['name26']}.up.sql"); down26 = rd(f"db/migrations/0026_{F['name26']}.down.sql")
assert (sha(up25), sha(down25), sha(up26), sha(down26)) == (F["up25"], F["down25"], F["up26"], F["down26"]), "merged migration bytes differ from the pins"
for body in (up25, up26):
    for tag in ("$e7_0025_up$", "$e7_0026_up$", "$e7pkg$"): assert tag not in body, tag
    assert not re.search(r"^\s*(BEGIN|COMMIT|ROLLBACK|START TRANSACTION)\s*(WORK|TRANSACTION)?\s*;", body, re.M | re.I), "an embedded up must not control the transaction"
inventory = rd("claude/e7-0025-0026-inventory.sql")
assert sha(inventory) == pins["inventorySql"], "inventory probe changed after the pins were derived: re-derive"
inv_body = "\n".join(l for l in inventory.splitlines() if not l.startswith("--")).strip()
assert inv_body.endswith(" AS e7_inventory"); inv_body = inv_body[: -len(" AS e7_inventory")]
assert "$" not in inv_body, "dollar signs would break the DO body"

PRE, MID, POST = pins["pre"], pins["mid"], pins["post"]
IDENTITY_KEYS = ["functions", "function_count", "triggers", "trigger_count", "constraints", "indexes", "columns", "table_acls", "rls", "rls_enabled_count", "policies", "policy_count",
                 "schema_owner", "is_privileged_src", "is_privileged_config", "relations", "relation_count", "test_cleanup_pending_state", "prerequisite_0023", "objects", "acls"]
ident = lambda inv: json.dumps({k: inv[k] for k in IDENTITY_KEYS}, sort_keys=True, separators=(",", ":"))
c_pre, c_mid, c_post = ident(PRE), ident(MID), ident(POST)
for s in (c_pre, c_mid, c_post): assert "'" not in s and "$" not in s
C_HIST24 = PRE["migrations"]["aggregate"]; C_HIST25 = MID["migrations"]["aggregate"]; C_HIST26 = POST["migrations"]["aggregate"]
assert (PRE["migrations"]["count"], PRE["migrations"]["max"], MID["migrations"]["max"], POST["migrations"]["count"], POST["migrations"]["max"]) == (24, 24, 25, 26, 26)
assert PRE["migrations"]["aggregate_1_24"] == C_HIST24 == MID["migrations"]["aggregate_1_24"] == POST["migrations"]["aggregate_1_24"]
assert C_HIST24 == "bcd453f800c037e978138d5d6bf979baaa00b46cbe807fb7aca8281a9cacc7f2", "PRE history = the accepted 0024 packet's POST aggregate (shared DEV exact post-24)"
assert PRE["functions"] == "8e73bb25c38f0a6e32566483c9a6cf57a6faa9f5feebdee34ec381564265304d", "PRE functions = the accepted 0024 packet's POST functions"
for k in IDENTITY_KEYS:
    if k not in ("functions", "acls"): assert PRE[k] == MID[k] == POST[k], f"0025 / 0026 change ONLY function bodies: {k}"
assert len({PRE["functions"], MID["functions"], POST["functions"]}) == 3
assert PRE["schema_owner"] == "postgres" == POST["schema_owner"]
ADDED = pins["addedColumns"]; assert ADDED == {} and pins["newTables"] == [], "no table / column delta"
KP = pins["kickoffCatalogPins"]; KP0 = pins["kickoffCatalogPre"]
assert [f["sig"] for f in KP["functions"]] == [f["sig"] for f in KP0["functions"]]
assert [i for i, (a, b) in enumerate(zip(KP["functions"], KP0["functions"])) if a != b] == [0] and KP["table"] == KP0["table"], "only the claim function changes"
assert (KP0["functions"][0]["src"], KP["functions"][0]["src"]) == ("ede022a83e0869ec2194470665cab759", "fb103173762c5dc6565338d2a15dd067")
kp_json = json.dumps(KP, sort_keys=True, separators=(",", ":")); kp0_json = json.dumps(KP0, sort_keys=True, separators=(",", ":"))
for s in (kp_json, kp0_json): assert "'" not in s and "$" not in s
OLD_SRC = "f09bcbbdfac88ca8dfd212a386d2af03698f9b710a49189b0ac9262531510999"; NEW_SRC = "880db5b33024edbf0879fbaf5a3826e3622db12fd1808e8c2047238da507fe1b"
assert up26.count(NEW_SRC) == 1 and down26.count(OLD_SRC) == 1
LOCK_KEY = "e7-connected-runner"   # = scripts/e7-connected/run-lock-precheck.mjs LOCK_KEY (asserted by the tests)
added_json = json.dumps(ADDED, sort_keys=True, separators=(",", ":"))
PROTECTED = ["70636076", "71045356", "71072615", "71081885"]
HISTORICAL = ["abede8b1-8ef6-44f2-876e-6a02fc056a96", "c83c1842-d342-4e27-9ab7-dc3d50b7a309", "954d476c-71ea-4824-92f6-2220ae302103",
              "669da884-02e8-4105-8825-f908e5d22ae9", "1d6e770f-ba3d-40f7-92c1-ee01be7da532"]

# per-table count + whole-row fingerprint over the PRE column set (the pinned ADDED columns removed from each row's jsonb — a no-op before the apply)
# and the PRE table set (the NEW tables excluded; they must be EMPTY, asserted separately). The table list is read from the catalog at run time.
tblfp = ("(SELECT jsonb_object_agg(t.relname, x.v ORDER BY t.relname) FROM pg_catalog.pg_class t JOIN pg_catalog.pg_namespace s ON s.oid = t.relnamespace, "
         "LATERAL (SELECT (xpath('/row/v/text()', query_to_xml(format("
         "'SELECT count(*) || '':'' || md5(coalesce(string_agg(q.r, E''\\n'' ORDER BY q.r), '''')) AS v FROM (SELECT (to_jsonb(x) - %L::text[])::text AS r FROM booking.%I x) q', "
         f"ARRAY(SELECT jsonb_array_elements_text(coalesce('{added_json}'::jsonb -> t.relname::text, '[]'::jsonb))), t.relname), "
         f"false, true, '')))[1]::text AS v) x WHERE s.nspname = 'booking' AND t.relkind IN ('r', 'p'))")
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
hist_rows24 = ("(SELECT count(*) || ':' || md5(coalesce(string_agg(to_jsonb(a)::text, E'\\n' ORDER BY a.version), '')) FROM booking_migrations.applied a WHERE a.version <= 24)")
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

probe_sink = ("jsonb_build_object('sink', booking.gn_recipient_in_scope('delivered@resend.dev'), 'lookalike', booking.gn_recipient_in_scope('delivered+x@resend.dev'), "
              "'invalid_scope', booking.gn_recipient_in_scope('guest@example.invalid'))")
claim_literal = ("(SELECT CASE WHEN position('" + NEW_SRC + "' in p.prosrc) > 0 AND position('" + OLD_SRC + "' in p.prosrc) = 0 THEN 'rebound' "
                 "WHEN position('" + OLD_SRC + "' in p.prosrc) > 0 AND position('" + NEW_SRC + "' in p.prosrc) = 0 THEN 'original' ELSE 'other' END "
                 "FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('booking.claim_pipeline_kickoff(uuid,text,text,jsonb)'))")

wrapper = f"""-- e7-0025-0026-sqleditor-apply-v1.sql — ONE atomic DO statement for the Supabase SQL editor (schema owner = dashboard `postgres`). C116.
-- Reviewable packet for the maraVilla shared DEV TEST database at EXACTLY 0001-0024. ROOT reviews and owns any actual shared apply; this file is not an
-- owner command. LABELLED SPECIALISATION of the accepted claude/e7-0024-sqleditor-apply-v1.sql for TWO consecutive migrations: applies EXACTLY
-- db/migrations/0025_{F["name25"]}.up.sql then 0026_{F["name26"]}.up.sql (bytes embedded verbatim, each sha256-checked in-transaction) mirroring
-- db/lib/migrate.js migrateUp: advisory xact lock 7302215001; TEST instance + schema-owner role; history exactly 0001-0024 (names + checksums = the
-- accepted 0024 packet's POST aggregate); FULL PRE schema identity + the 0024 kickoff catalog for the runtime app role; quiescence (hosted-run lock,
-- work / intent / operation leases, in-flight operations, prepared transactions, other sessions' write locks on booking relations); then 0025 up + ONE
-- tracking row, the FULL MID identity, 0026 up + ONE tracking row, the FULL POST identity, the merged hosted kickoff runner's CATALOG_PINS for the
-- runtime app role (main adacbdad: claim src fb103173), the claim's expected_source_digest literal 880db5b3 (and no f09bcbbd), the sink predicate
-- (delivered@resend.dev in scope, a look-alike out, the .invalid scope unchanged), unchanged 0001-0024 history rows (whole rows), EVERY booking table's
-- count + whole-row fingerprint (incl. pipeline_kickoff_requests and the notification tables; 0025 / 0026 add or drop no table or column), the intent id
-- set and the sanitized protected-reservation / historical-intent fingerprints.
-- Any drift → RAISE → the whole statement rolls back (schema, data and history unchanged). Never adopts, upserts, backfills, repairs, widens a grant or
-- runs a down; never embeds 0001-0024. Zero booking DML. Returns no guest field and no credential.
-- REPLAY: on a database already at EXACTLY the pinned POST state (history 0001-0026 aggregate + full POST identity + kickoff catalog) it is a provable
-- NO-OP (no write, notice E7_2526_ALREADY_EXACT_NOOP). Any other state at or above 25 (incl. a 0025-only state) → E7_2526_POST_STATE_MISMATCH_STOP;
-- never "repaired" or continued by this packet. After an UNCERTAIN issuance ROOT runs claude/e7-0025-0026-readback-v1.sql FIRST and never re-issues blindly.
-- Applying 0025 + 0026 enables NO send and NO dispatch: every hosted runner on main ships executeEnabled / dispatchEnabled FALSE; no worker, flag,
-- variable or workflow changes. Admission of the sink address is NOT a send permission; provider acceptance at the sink is NOT inbox delivery.
-- Generated by claude/gen-0025-0026-wrapper.py from the merged migration bytes + claude/e7-0025-0026-pins-v1.json (disposable-cluster derived); the
-- identity probe is claude/e7-0025-0026-inventory.sql verbatim. TIME BOUND: the SET LOCAL statements below run BEFORE the DO in the same editor batch
-- (one implicit transaction block), so they bound the DO and leave the caller's session settings unchanged afterwards.
SET LOCAL statement_timeout = '180s';
SET LOCAL lock_timeout = '5s';
DO $e7pkg$
DECLARE
  up25      constant text  := $e7_0025_up${up25}$e7_0025_up$;
  up26      constant text  := $e7_0026_up${up26}$e7_0026_up$;
  c_up25    constant text  := '{F["up25"]}';
  c_down25  constant text  := '{F["down25"]}';
  c_up26    constant text  := '{F["up26"]}';
  c_down26  constant text  := '{F["down26"]}';
  c_hist24  constant text  := '{C_HIST24}';
  c_hist25  constant text  := '{C_HIST25}';
  c_hist26  constant text  := '{C_HIST26}';
  c_pre     constant jsonb := '{c_pre}'::jsonb;
  c_mid     constant jsonb := '{c_mid}'::jsonb;
  c_post    constant jsonb := '{c_post}'::jsonb;
  c_kick0   constant jsonb := '{kp0_json}'::jsonb;
  c_kick    constant jsonb := '{kp_json}'::jsonb;
  inv jsonb; t_pre jsonb; t_post jsonb; h text; n bigint; mx int; k text; bad text := '';
  ids_pre text; hrows_pre text; prot_pre text; hist_pre text;
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  PERFORM pg_advisory_xact_lock(7302215001);                             -- = db/lib/migrate.js LOCK_KEY (transaction-scoped)
  IF encode(sha256(convert_to(up25, 'UTF8')), 'hex') <> c_up25 THEN RAISE EXCEPTION 'E7_2526_UP25_BYTES_MISMATCH'; END IF;
  IF encode(sha256(convert_to(up26, 'UTF8')), 'hex') <> c_up26 THEN RAISE EXCEPTION 'E7_2526_UP26_BYTES_MISMATCH'; END IF;
  IF current_user::text <> (SELECT pg_catalog.pg_get_userbyid(nspowner)::text FROM pg_catalog.pg_namespace WHERE nspname = 'booking') THEN RAISE EXCEPTION 'E7_2526_NOT_SCHEMA_OWNER'; END IF;
  IF to_regclass('booking_migrations.applied') IS NULL THEN RAISE EXCEPTION 'E7_2526_NO_TRACKING_TABLE'; END IF;
  IF to_regclass('booking.instance') IS NULL THEN RAISE EXCEPTION 'E7_2526_NO_INSTANCE'; END IF;
  SELECT count(*) INTO n FROM booking.instance;
  IF n <> 1 OR (SELECT environment FROM booking.instance) IS DISTINCT FROM 'test' THEN RAISE EXCEPTION 'E7_2526_NOT_TEST'; END IF;
  IF EXISTS (SELECT 1 FROM booking_migrations.applied WHERE environment IS DISTINCT FROM 'test') THEN RAISE EXCEPTION 'E7_2526_ENV_MISMATCH'; END IF;
  SELECT max(version) INTO mx FROM booking_migrations.applied;
  IF mx >= 25 THEN
    -- provable exact-POST no-op: full history aggregate 0001-0026 AND the full POST identity AND the kickoff catalog; anything else is an explicit STOP
    inv := ({indent(inv_body, 11)});
    SELECT ({hist("")}) INTO h;
    IF mx = 26 AND (SELECT count(*) FROM booking_migrations.applied) = 26 AND (SELECT min(version) FROM booking_migrations.applied) = 1 AND h = c_hist26 THEN
      bad := '';
      FOR k IN SELECT jsonb_object_keys(c_post) LOOP
        IF (inv -> k) IS DISTINCT FROM (c_post -> k) THEN bad := bad || k || ','; END IF;
      END LOOP;
      IF {kick_catalog} IS DISTINCT FROM c_kick THEN bad := bad || 'kickoff_catalog,'; END IF;
      IF bad = '' THEN RAISE NOTICE 'E7_2526_ALREADY_EXACT_NOOP'; RETURN; END IF;
      RAISE EXCEPTION 'E7_2526_POST_STATE_MISMATCH_STOP:%', bad;
    END IF;
    RAISE EXCEPTION 'E7_2526_POST_STATE_MISMATCH_STOP:history';
  END IF;
  IF (SELECT count(*) FROM booking_migrations.applied) <> 24 OR (SELECT min(version) FROM booking_migrations.applied) <> 1 OR mx <> 24
     THEN RAISE EXCEPTION 'E7_2526_HISTORY_NOT_1_TO_24'; END IF;
  SELECT ({hist("")}) INTO h;
  IF h IS DISTINCT FROM c_hist24 THEN RAISE EXCEPTION 'E7_2526_HISTORY_DRIFT'; END IF;
  -- quiescence
  IF {active_lock} THEN RAISE EXCEPTION 'E7_2526_ACTIVE_RUN_LOCK_HELD'; END IF;
  IF NOT pg_try_advisory_xact_lock(pg_catalog.hashtext('{LOCK_KEY}'), 0) THEN RAISE EXCEPTION 'E7_2526_ACTIVE_RUN_LOCK_HELD'; END IF;
  IF EXISTS (SELECT 1 FROM booking.intent_work WHERE work_worker_id IS NOT NULL OR work_lease_until IS NOT NULL) THEN RAISE EXCEPTION 'E7_2526_ACTIVE_WORK_LEASE'; END IF;
  IF EXISTS (SELECT 1 FROM booking.intents WHERE lease_worker_id IS NOT NULL OR lease_until IS NOT NULL) THEN RAISE EXCEPTION 'E7_2526_ACTIVE_INTENT_LEASE'; END IF;
  IF EXISTS (SELECT 1 FROM booking.external_operations WHERE lease_worker_id IS NOT NULL OR lease_until IS NOT NULL OR state = 'in_flight') THEN RAISE EXCEPTION 'E7_2526_OPERATION_LEASED_OR_IN_FLIGHT'; END IF;
  IF {prepared} <> 0 THEN RAISE EXCEPTION 'E7_2526_PREPARED_TRANSACTION_PRESENT'; END IF;
  IF {write_locks} <> 0 THEN RAISE EXCEPTION 'E7_2526_BOOKING_WRITE_LOCK_HELD'; END IF;
  inv := ({indent(inv_body, 9)});
{compare("inv", "c_pre", "E7_2526_SCHEMA_IDENTITY_DRIFT")}
  IF {kick_catalog} IS DISTINCT FROM c_kick0 THEN RAISE EXCEPTION 'E7_2526_KICKOFF_CATALOG_PRE_DRIFT'; END IF;
  t_pre := {tblfp};
  ids_pre := {intent_ids};
  hrows_pre := {hist_rows24};
  prot_pre := {protected_fp};
  hist_pre := {historical_fp};
  PERFORM set_config('booking.migration_environment', 'test', true);
  -- ---- 0025, exactly what migrateUp does for one version ----
  EXECUTE up25;
  INSERT INTO booking_migrations.applied (version, name, up_checksum, down_checksum, environment) VALUES (25, '{F["name25"]}', c_up25, c_down25, 'test');
  inv := ({indent(inv_body, 9)});
{compare("inv", "c_mid", "E7_2526_MID_SCHEMA_IDENTITY_UNEXPECTED")}
  SELECT ({hist("")}) INTO h;
  IF h IS DISTINCT FROM c_hist25 THEN RAISE EXCEPTION 'E7_2526_MID_TRACKING_ROW_UNEXPECTED'; END IF;
  -- ---- 0026, exactly what migrateUp does for one version ----
  EXECUTE up26;
  INSERT INTO booking_migrations.applied (version, name, up_checksum, down_checksum, environment) VALUES (26, '{F["name26"]}', c_up26, c_down26, 'test');
  -- ---- post-conditions (same statement; any failure rolls everything back) ----
  inv := ({indent(inv_body, 9)});
{compare("inv", "c_post", "E7_2526_POST_SCHEMA_IDENTITY_UNEXPECTED")}
  IF {kick_catalog} IS DISTINCT FROM c_kick THEN RAISE EXCEPTION 'E7_2526_KICKOFF_CATALOG_UNEXPECTED'; END IF;
  IF {claim_literal} IS DISTINCT FROM 'rebound' THEN RAISE EXCEPTION 'E7_2526_CLAIM_LITERAL_UNEXPECTED'; END IF;
  IF {probe_sink} IS DISTINCT FROM '{{"sink": true, "lookalike": false, "invalid_scope": true}}'::jsonb THEN RAISE EXCEPTION 'E7_2526_SINK_SCOPE_UNEXPECTED'; END IF;
  SELECT ({hist(" WHERE version <= 24")}) INTO h;
  IF h IS DISTINCT FROM c_hist24 OR {hist_rows24} IS DISTINCT FROM hrows_pre THEN RAISE EXCEPTION 'E7_2526_POST_HISTORY_1_TO_24_CHANGED'; END IF;
  SELECT ({hist("")}) INTO h;
  IF h IS DISTINCT FROM c_hist26 OR (SELECT count(*) FROM booking_migrations.applied) <> 26
     OR NOT EXISTS (SELECT 1 FROM booking_migrations.applied WHERE version = 25 AND name = '{F["name25"]}' AND up_checksum = c_up25 AND down_checksum = c_down25 AND environment = 'test')
     OR NOT EXISTS (SELECT 1 FROM booking_migrations.applied WHERE version = 26 AND name = '{F["name26"]}' AND up_checksum = c_up26 AND down_checksum = c_down26 AND environment = 'test')
     THEN RAISE EXCEPTION 'E7_2526_POST_TRACKING_ROWS_UNEXPECTED'; END IF;
  t_post := {tblfp};
  IF t_post IS DISTINCT FROM t_pre THEN RAISE EXCEPTION 'E7_2526_BOOKING_ROWS_CHANGED'; END IF;
  IF {intent_ids} IS DISTINCT FROM ids_pre THEN RAISE EXCEPTION 'E7_2526_INTENT_SET_CHANGED'; END IF;
  IF {protected_fp} IS DISTINCT FROM prot_pre OR {historical_fp} IS DISTINCT FROM hist_pre THEN RAISE EXCEPTION 'E7_2526_PROTECTED_OR_HISTORICAL_CHANGED'; END IF;
  RAISE NOTICE 'E7_2526_APPLIED';
END
$e7pkg$;
-- read-only status line (the editor's last result; the true state whether or not the DO above succeeded)
SELECT jsonb_build_object('migrations_max', (SELECT max(version) FROM booking_migrations.applied),
  'v25', EXISTS (SELECT 1 FROM booking_migrations.applied WHERE version = 25),
  'v26', EXISTS (SELECT 1 FROM booking_migrations.applied WHERE version = 26),
  'claim_literal', {claim_literal},
  'sink_scope', {probe_sink},
  'kickoff_rows', {kickoff_rows},
  'functions_sha256', ({indent(inv_body, 2)}) -> 'functions') AS e7_2526_status;
"""

readback = f"""-- e7-0025-0026-readback-v1.sql — PURE READ-ONLY (C116). Run it BEFORE and AFTER the 0025 + 0026 apply wrapper and compare with the pins
-- (claude/e7-0025-0026-pins-v1.json: `pre` must equal the BEFORE identity keys, `post` the AFTER). LABELLED SPECIALISATION of the accepted
-- claude/e7-0024-readback-v1.sql. Writes nothing, takes no lock, returns only counts / hashes / flags (no guest field, no credential). Schema owner.
-- `identity` = claude/e7-0025-0026-inventory.sql verbatim (sha256 {pins["inventorySql"]}).
-- `exclusion` shows why an apply would refuse now. `data` must be IDENTICAL before and after: per-table count + whole-row fingerprint over EVERY
-- booking table (incl. pipeline_kickoff_requests and the notification tables), the intent id set, the whole 0001-0024 history rows, and the sanitized
-- protected-reservation / historical-intent fingerprints (counts + md5 only). `kickoff_catalog` BEFORE == pins.kickoffCatalogPre (the 0024 packet's
-- pins); AFTER == pins.kickoffCatalogPins (= scripts/e7-hosted-kickoff.mjs CATALOG_PINS on main adacbdad, evaluated for mv_booking_app).
-- Expected BEFORE: identity.functions = {PRE["functions"]}, migrations.max = 24, aggregate = {C_HIST24},
--                  claim_literal = original, sink_scope = {{"sink": false, "lookalike": false, "invalid_scope": true}}.
-- Expected AFTER:  identity.functions = {POST["functions"]}, migrations.max = 26, aggregate = {C_HIST26}, aggregate_1_24 unchanged,
--                  v25 up {F["up25"]}, v26 up {F["up26"]}, claim_literal = rebound, sink_scope = {{"sink": true, "lookalike": false, "invalid_scope": true}},
--                  `data` identical.
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
    'history_rows_1_24', {hist_rows24},
    'protected_reservations', {protected_fp},
    'historical_intents', {historical_fp}),
  'kickoff_rows', {kickoff_rows},
  'kickoff_catalog', {kick_catalog},
  'claim_literal', {claim_literal},
  'sink_scope', {probe_sink}
) AS e7_2526_readback;
"""

for path, text in (("claude/e7-0025-0026-sqleditor-apply-v1.sql", wrapper), ("claude/e7-0025-0026-readback-v1.sql", readback)):
    full = os.path.join(ROOT, path)
    if os.path.exists(full) and not WRITE:
        assert open(full, encoding="utf8").read() == text, f"{path} is not byte-identical to the deterministic assembly (re-run with --write)"
    else:
        open(full, "w", encoding="utf8").write(text)
    print(path, "sha256:", sha(text))
assert re.search(r"\$e7_0025_up\$(.*?)\$e7_0025_up\$", wrapper, re.S).group(1) == up25
assert re.search(r"\$e7_0026_up\$(.*?)\$e7_0026_up\$", wrapper, re.S).group(1) == up26
for v in sorted(f for f in os.listdir(os.path.join(ROOT, "db/migrations")) if f.endswith(".up.sql") and not f.startswith(("0025_", "0026_"))):
    assert rd(f"db/migrations/{v}") not in wrapper, v
assert down25 not in wrapper and down26 not in wrapper
print("embedded up25 sha256:", sha(up25)); print("embedded up26 sha256:", sha(up26))
