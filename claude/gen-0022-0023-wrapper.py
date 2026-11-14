#!/usr/bin/env python3
# Generator for claude/e7-0022-0023-sqleditor-apply-v1.sql and claude/e7-0022-0023-readback-v1.sql (C46) — LABELLED SPECIALISATION of the accepted
# claude/gen-0021-wrapper.py for TWO migrations (0022 then 0023) in ONE transaction, on a database that carries EXACTLY 0001-0021.
# Deterministic exact-source assembly:
#   * embeds db/migrations/0022_gn_v2_booking_confirmation.up.sql and db/migrations/0023_gn_v2_resend_receipts.up.sql VERBATIM (each sha256-checked
#     in-transaction against the pinned migrator checksum; tracking rows carry exactly the migrator's name / up / down checksums),
#   * pins every PRE (0001-0021) / MID (0001-0022) / POST (0001-0023) schema-identity fact from claude/e7-0022-0023-pins-v1.json (derived on a DISPOSABLE
#     cluster by claude/derive-0022-0023-pins.mjs with the accepted migrator) and embeds claude/e7-0022-0023-inventory.sql VERBATIM as the identity probe,
#   * row preservation over the PRE column / table set (the ADDED columns and NEW tables are catalog-derived pins, never hand-listed),
#   * never edits the merged migrations; NEVER embeds / applies 0019 / 0020 / 0021 or any down; never adopts / upserts / repairs; refuses on ANY drift.
# Run from the worktree root:  python3 claude/gen-0022-0023-wrapper.py .   (asserts byte-identical regeneration when the outputs exist, unless --write)
import hashlib, json, os, re, sys

ROOT = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("--") else "."
WRITE = "--write" in sys.argv
rd = lambda p: open(os.path.join(ROOT, p), encoding="utf8").read()
sha = lambda s: hashlib.sha256(s.encode("utf8")).hexdigest()

pins = json.loads(rd("claude/e7-0022-0023-pins-v1.json"))
assert pins["schema"] == "e7-0022-0023-pins-v1"
up22 = rd("db/migrations/0022_gn_v2_booking_confirmation.up.sql"); down22 = rd("db/migrations/0022_gn_v2_booking_confirmation.down.sql")
up23 = rd("db/migrations/0023_gn_v2_resend_receipts.up.sql"); down23 = rd("db/migrations/0023_gn_v2_resend_receipts.down.sql")
F = pins["files"]
assert (sha(up22), sha(down22), sha(up23), sha(down23)) == (F["up22"], F["down22"], F["up23"], F["down23"]), "merged migration bytes differ from the pins"
assert (F["name22"], F["name23"]) == ("gn_v2_booking_confirmation", "gn_v2_resend_receipts")
for up in (up22, up23):
    for tag in ("$e7_0022_up$", "$e7_0023_up$", "$e7pkg$"):
        assert tag not in up, tag
    assert not re.search(r"^\s*(BEGIN|COMMIT|ROLLBACK|START TRANSACTION)\s*(WORK|TRANSACTION)?\s*;", up, re.M | re.I), "an embedded up must not control the transaction"
inventory = rd("claude/e7-0022-0023-inventory.sql")
assert sha(inventory) == pins["inventorySql"], "inventory probe changed after the pins were derived: re-derive"
inv_body = "\n".join(l for l in inventory.splitlines() if not l.startswith("--")).strip()
assert inv_body.endswith(" AS e7_inventory"); inv_body = inv_body[: -len(" AS e7_inventory")]
assert "$" not in inv_body, "dollar signs would break the DO body"

PRE, MID, POST = pins["pre"], pins["mid"], pins["post"]
IDENTITY_KEYS = ["functions", "function_count", "triggers", "trigger_count", "constraints", "indexes", "columns", "table_acls", "rls", "rls_enabled_count", "policies", "policy_count",
                 "schema_owner", "is_privileged_src", "is_privileged_config", "relations", "relation_count", "test_cleanup_pending_state", "prerequisite_0021", "objects", "acls"]
ident = lambda inv: json.dumps({k: inv[k] for k in IDENTITY_KEYS}, sort_keys=True, separators=(",", ":"))
c_pre, c_mid, c_post = ident(PRE), ident(MID), ident(POST)
for s in (c_pre, c_mid, c_post): assert "'" not in s and "$" not in s
C_HIST21 = PRE["migrations"]["aggregate"]; C_HIST23 = POST["migrations"]["aggregate"]
assert (PRE["migrations"]["count"], PRE["migrations"]["max"], MID["migrations"]["max"], POST["migrations"]["count"], POST["migrations"]["max"]) == (21, 21, 22, 23, 23)
assert PRE["migrations"]["aggregate_1_21"] == C_HIST21 == POST["migrations"]["aggregate_1_21"] == MID["migrations"]["aggregate_1_21"]
assert all(v is True for v in PRE["prerequisite_0021"].values()) and all(v is True for v in POST["prerequisite_0021"].values())
assert all(v is False for v in PRE["objects"].values()) and all(v is True for v in POST["objects"].values())
assert PRE["schema_owner"] == "postgres" == POST["schema_owner"]
ADDED = pins["addedColumns"]; NEW = pins["newTables"]
assert ADDED == {"notification_renders": ["locale", "copy_contract_version"]} and NEW == ["notification_provider_receipts"], "0022 / 0023 catalog deltas as reviewed"
R12 = pins["preColumnsOf"]["notification_renders"]; assert len(R12) == 12
LOCK_KEY = "e7-connected-runner"   # = scripts/e7-connected/run-lock-precheck.mjs LOCK_KEY (asserted by the tests)
added_json = json.dumps(ADDED, sort_keys=True, separators=(",", ":")); new_list = ", ".join(f"'{t}'" for t in NEW)
assert "'" not in added_json and "$" not in added_json

# per-table count + whole-row fingerprint over the PRE column set (the pinned ADDED columns removed from each row's jsonb — a no-op before the apply)
# and the PRE table set (the NEW tables excluded; they must be EMPTY, asserted separately). The table list is read from the catalog at run time.
tblfp = ("(SELECT jsonb_object_agg(t.relname, x.v ORDER BY t.relname) FROM pg_catalog.pg_class t JOIN pg_catalog.pg_namespace s ON s.oid = t.relnamespace, "
         "LATERAL (SELECT (xpath('/row/v/text()', query_to_xml(format("
         "'SELECT count(*) || '':'' || md5(coalesce(string_agg(q.r, E''\\n'' ORDER BY q.r), '''')) AS v FROM (SELECT (to_jsonb(x) - %L::text[])::text AS r FROM booking.%I x) q', "
         f"ARRAY(SELECT jsonb_array_elements_text(coalesce('{added_json}'::jsonb -> t.relname::text, '[]'::jsonb))), t.relname), "
         f"false, true, '')))[1]::text AS v) x WHERE s.nspname = 'booking' AND t.relkind IN ('r', 'p') AND t.relname NOT IN ({new_list}))")
r12 = ", ".join(R12)
renders12 = ("(SELECT count(*) || ':' || md5(coalesce(string_agg(row_to_json(q)::text, E'\\n' ORDER BY row_to_json(q)::text), '')) "
             f"FROM (SELECT {r12} FROM booking.notification_renders) q)")
intent_ids = ("(SELECT count(*) || ':' || encode(sha256(convert_to(coalesce(string_agg(i.id::text, ',' ORDER BY i.id), ''), 'UTF8')), 'hex') FROM booking.intents i)")
hist_rows21 = ("(SELECT count(*) || ':' || md5(coalesce(string_agg(to_jsonb(a)::text, E'\\n' ORDER BY a.version), '')) FROM booking_migrations.applied a WHERE a.version <= 21)")
hist = lambda where: ("SELECT encode(sha256(convert_to(string_agg(version || ':' || name || ':' || up_checksum || ':' || down_checksum, E'\\n' ORDER BY version), 'UTF8')), 'hex') "
                      f"FROM booking_migrations.applied{where}")
active_lock = ("EXISTS (SELECT 1 FROM pg_catalog.pg_locks l WHERE l.locktype = 'advisory' AND l.granted "
               "AND l.database = (SELECT d.oid FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database()) "
               f"AND l.classid = ((pg_catalog.hashtext('{LOCK_KEY}')::bigint + 4294967296) % 4294967296)::oid AND l.objid = 0::oid AND l.objsubid = 2)")
write_locks = ("(SELECT count(*) FROM pg_catalog.pg_locks l JOIN pg_catalog.pg_class c ON c.oid = l.relation JOIN pg_catalog.pg_namespace s ON s.oid = c.relnamespace "
               "WHERE l.locktype = 'relation' AND l.granted AND l.pid <> pg_catalog.pg_backend_pid() AND l.mode <> 'AccessShareLock' "
               "AND l.database = (SELECT d.oid FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database()) AND s.nspname IN ('booking', 'booking_migrations'))")
prepared = "(SELECT count(*) FROM pg_catalog.pg_prepared_xacts)"
renders_meta = ("(SELECT count(*) FROM booking.notification_renders r WHERE r.template_version IS DISTINCT FROM 'gn-v1' "
                "OR to_jsonb(r) ->> 'locale' IS NOT NULL OR to_jsonb(r) ->> 'copy_contract_version' IS NOT NULL)")
receipts_rows = ("(CASE WHEN to_regclass('booking.notification_provider_receipts') IS NULL THEN NULL ELSE "
                 "(xpath('/row/v/text()', query_to_xml('SELECT count(*) AS v FROM booking.notification_provider_receipts', false, true, '')))[1]::text::bigint END)")
indent = lambda s, n: ("\n" + " " * n).join(s.splitlines())
def compare(var, const, code):
    return (f"  bad := '';\n  FOR k IN SELECT jsonb_object_keys({const}) LOOP\n    IF ({var} -> k) IS DISTINCT FROM ({const} -> k) THEN bad := bad || k || ','; END IF;\n  END LOOP;\n"
            f"  IF bad <> '' THEN RAISE EXCEPTION '{code}:%', bad; END IF;               -- key names only, never values")

wrapper = f"""-- e7-0022-0023-sqleditor-apply-v1.sql — ONE atomic DO statement for the Supabase SQL editor (schema owner = dashboard `postgres`). C46.
-- Reviewable packet for the maraVilla shared DEV TEST database at EXACTLY 0001-0021. ROOT reviews and owns any actual shared apply; this file is not an
-- owner command. LABELLED SPECIALISATION of the accepted claude/e7-0021-sqleditor-apply-v1.sql for TWO migrations in ONE transaction: applies EXACTLY
-- db/migrations/0022_gn_v2_booking_confirmation.up.sql then db/migrations/0023_gn_v2_resend_receipts.up.sql (bytes embedded verbatim, sha256-checked
-- in-transaction) mirroring db/lib/migrate.js migrateUp per version: advisory xact lock 7302215001; TEST instance + schema-owner role; history exactly
-- 0001-0021 (names + checksums); 0021 prerequisite; FULL PRE schema identity; quiescence (hosted-run lock, work / intent / operation leases, in-flight
-- writes, prepared transactions, other sessions' write locks on booking relations); no 0022 / 0023 object present; then 0022 up + ONE tracking row,
-- the MID identity, 0023 up + ONE tracking row, then the FULL POST identity, unchanged 0001-0021 history rows (whole rows), every pre-existing booking
-- table's count + whole-row fingerprint over the PRE column set (the 0022 render columns removed — the ONLY added columns, catalog-derived), the
-- original 12 notification_renders columns, the intent id set, the added render columns NULL on every row and the new receipts table EMPTY.
-- Any drift → RAISE → the whole statement rolls back (schema, data and history unchanged). Never adopts, upserts, repairs, widens a grant or runs a down;
-- never embeds 0019 / 0020 / 0021. Zero booking DML. Returns no guest field and no credential.
-- REPLAY: on a database already at EXACTLY the pinned POST state (history 0001-0023 aggregate + full POST identity) it is a provable NO-OP (no write,
-- notice E7_23_ALREADY_EXACT_NOOP). Schema at 22 → E7_23_AT_22_STOP; any other state at or above 23 → E7_23_POST_STATE_MISMATCH_STOP. Neither is ever
-- "repaired" by this packet; after an uncertain issuance ROOT reads the actual state (readback) first.
-- Applying 0022 / 0023 enables NO notification: the .invalid recipient / sender fences, flags and workers are unchanged.
-- Generated by claude/gen-0022-0023-wrapper.py from the merged migration bytes + claude/e7-0022-0023-pins-v1.json (disposable-cluster derived); the
-- identity probe is claude/e7-0022-0023-inventory.sql verbatim. TIME BOUND: the SET LOCAL statements below run BEFORE the DO in the same editor batch
-- (one implicit transaction block), so they bound the DO and leave the caller's session settings unchanged afterwards.
SET LOCAL statement_timeout = '180s';
SET LOCAL lock_timeout = '5s';
DO $e7pkg$
DECLARE
  up22      constant text  := $e7_0022_up${up22}$e7_0022_up$;
  up23      constant text  := $e7_0023_up${up23}$e7_0023_up$;
  c_up22    constant text  := '{F["up22"]}';
  c_down22  constant text  := '{F["down22"]}';
  c_up23    constant text  := '{F["up23"]}';
  c_down23  constant text  := '{F["down23"]}';
  c_hist21  constant text  := '{C_HIST21}';
  c_hist23  constant text  := '{C_HIST23}';
  c_pre     constant jsonb := '{c_pre}'::jsonb;
  c_mid     constant jsonb := '{c_mid}'::jsonb;
  c_post    constant jsonb := '{c_post}'::jsonb;
  inv jsonb; t_pre jsonb; t_post jsonb; h text; n bigint; mx int; k text; bad text := '';
  r12_pre text; ids_pre text; hrows_pre text;
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  PERFORM pg_advisory_xact_lock(7302215001);                             -- = db/lib/migrate.js LOCK_KEY (transaction-scoped)
  IF encode(sha256(convert_to(up22, 'UTF8')), 'hex') <> c_up22 THEN RAISE EXCEPTION 'E7_23_UP22_BYTES_MISMATCH'; END IF;
  IF encode(sha256(convert_to(up23, 'UTF8')), 'hex') <> c_up23 THEN RAISE EXCEPTION 'E7_23_UP23_BYTES_MISMATCH'; END IF;
  IF current_user::text <> (SELECT pg_catalog.pg_get_userbyid(nspowner)::text FROM pg_catalog.pg_namespace WHERE nspname = 'booking') THEN RAISE EXCEPTION 'E7_23_NOT_SCHEMA_OWNER'; END IF;
  IF to_regclass('booking_migrations.applied') IS NULL THEN RAISE EXCEPTION 'E7_23_NO_TRACKING_TABLE'; END IF;
  IF to_regclass('booking.instance') IS NULL THEN RAISE EXCEPTION 'E7_23_NO_INSTANCE'; END IF;
  SELECT count(*) INTO n FROM booking.instance;
  IF n <> 1 OR (SELECT environment FROM booking.instance) IS DISTINCT FROM 'test' THEN RAISE EXCEPTION 'E7_23_NOT_TEST'; END IF;
  IF EXISTS (SELECT 1 FROM booking_migrations.applied WHERE environment IS DISTINCT FROM 'test') THEN RAISE EXCEPTION 'E7_23_ENV_MISMATCH'; END IF;
  SELECT max(version) INTO mx FROM booking_migrations.applied;
  IF mx >= 23 THEN
    -- provable exact-POST no-op: full history aggregate 0001-0023 AND the full POST identity; anything else at/above 23 is an explicit STOP
    inv := ({indent(inv_body, 11)});
    SELECT ({hist("")}) INTO h;
    IF mx = 23 AND (SELECT count(*) FROM booking_migrations.applied) = 23 AND (SELECT min(version) FROM booking_migrations.applied) = 1 AND h = c_hist23 THEN
      bad := '';
      FOR k IN SELECT jsonb_object_keys(c_post) LOOP
        IF (inv -> k) IS DISTINCT FROM (c_post -> k) THEN bad := bad || k || ','; END IF;
      END LOOP;
      IF bad = '' THEN RAISE NOTICE 'E7_23_ALREADY_EXACT_NOOP'; RETURN; END IF;
      RAISE EXCEPTION 'E7_23_POST_STATE_MISMATCH_STOP:%', bad;
    END IF;
    RAISE EXCEPTION 'E7_23_POST_STATE_MISMATCH_STOP:history';
  END IF;
  IF mx = 22 THEN RAISE EXCEPTION 'E7_23_AT_22_STOP'; END IF;            -- a partial / separately applied 0022: never continued by this packet
  IF (SELECT count(*) FROM booking_migrations.applied) <> 21 OR (SELECT min(version) FROM booking_migrations.applied) <> 1 OR mx <> 21
     THEN RAISE EXCEPTION 'E7_23_HISTORY_NOT_1_TO_21'; END IF;
  SELECT ({hist("")}) INTO h;
  IF h IS DISTINCT FROM c_hist21 THEN RAISE EXCEPTION 'E7_23_HISTORY_DRIFT'; END IF;
  -- quiescence
  IF {active_lock} THEN RAISE EXCEPTION 'E7_23_ACTIVE_RUN_LOCK_HELD'; END IF;
  IF NOT pg_try_advisory_xact_lock(pg_catalog.hashtext('{LOCK_KEY}'), 0) THEN RAISE EXCEPTION 'E7_23_ACTIVE_RUN_LOCK_HELD'; END IF;
  IF EXISTS (SELECT 1 FROM booking.intent_work WHERE work_worker_id IS NOT NULL OR work_lease_until IS NOT NULL) THEN RAISE EXCEPTION 'E7_23_ACTIVE_WORK_LEASE'; END IF;
  IF EXISTS (SELECT 1 FROM booking.intents WHERE lease_worker_id IS NOT NULL OR lease_until IS NOT NULL) THEN RAISE EXCEPTION 'E7_23_ACTIVE_INTENT_LEASE'; END IF;
  IF EXISTS (SELECT 1 FROM booking.external_operations WHERE lease_worker_id IS NOT NULL OR lease_until IS NOT NULL OR state = 'in_flight') THEN RAISE EXCEPTION 'E7_23_OPERATION_LEASED_OR_IN_FLIGHT'; END IF;
  IF {prepared} <> 0 THEN RAISE EXCEPTION 'E7_23_PREPARED_TRANSACTION_PRESENT'; END IF;
  IF {write_locks} <> 0 THEN RAISE EXCEPTION 'E7_23_BOOKING_WRITE_LOCK_HELD'; END IF;
  -- no 0022 / 0023 object or gn-v2 render may exist at 21 (an unrecorded partial apply or foreign data)
  IF to_regprocedure('booking.claim_guest_notification_v2(uuid,text,text,text,text,text)') IS NOT NULL OR to_regclass('booking.notification_provider_receipts') IS NOT NULL
     OR to_regprocedure('booking.complete_guest_notification_resend(uuid,text,text,uuid,boolean,text)') IS NOT NULL
     OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'booking' AND table_name = 'notification_renders' AND column_name IN ('locale', 'copy_contract_version'))
     THEN RAISE EXCEPTION 'E7_23_VOCABULARY_ALREADY_PRESENT'; END IF;
  IF {renders_meta} <> 0 THEN RAISE EXCEPTION 'E7_23_PRE_NON_GN_V1_RENDER'; END IF;
  inv := ({indent(inv_body, 9)});
  IF (inv -> 'prerequisite_0021') IS DISTINCT FROM (c_pre -> 'prerequisite_0021') THEN RAISE EXCEPTION 'E7_23_0021_PREREQUISITE_MISSING'; END IF;
{compare("inv", "c_pre", "E7_23_SCHEMA_IDENTITY_DRIFT")}
  t_pre := {tblfp};
  r12_pre := {renders12};
  ids_pre := {intent_ids};
  hrows_pre := {hist_rows21};
  -- ---- 0022, exactly what migrateUp does for one version ----
  PERFORM set_config('booking.migration_environment', 'test', true);
  EXECUTE up22;
  INSERT INTO booking_migrations.applied (version, name, up_checksum, down_checksum, environment) VALUES (22, '{F["name22"]}', c_up22, c_down22, 'test');
  inv := ({indent(inv_body, 9)});
{compare("inv", "c_mid", "E7_23_MID_SCHEMA_IDENTITY_UNEXPECTED")}
  -- ---- 0023 ----
  EXECUTE up23;
  INSERT INTO booking_migrations.applied (version, name, up_checksum, down_checksum, environment) VALUES (23, '{F["name23"]}', c_up23, c_down23, 'test');
  -- ---- post-conditions (same statement; any failure rolls everything back) ----
  inv := ({indent(inv_body, 9)});
{compare("inv", "c_post", "E7_23_POST_SCHEMA_IDENTITY_UNEXPECTED")}
  SELECT ({hist(" WHERE version <= 21")}) INTO h;
  IF h IS DISTINCT FROM c_hist21 OR {hist_rows21} IS DISTINCT FROM hrows_pre THEN RAISE EXCEPTION 'E7_23_POST_HISTORY_1_TO_21_CHANGED'; END IF;
  SELECT ({hist("")}) INTO h;
  IF h IS DISTINCT FROM c_hist23 OR (SELECT count(*) FROM booking_migrations.applied) <> 23
     OR NOT EXISTS (SELECT 1 FROM booking_migrations.applied WHERE version = 22 AND name = '{F["name22"]}' AND up_checksum = c_up22 AND down_checksum = c_down22 AND environment = 'test')
     OR NOT EXISTS (SELECT 1 FROM booking_migrations.applied WHERE version = 23 AND name = '{F["name23"]}' AND up_checksum = c_up23 AND down_checksum = c_down23 AND environment = 'test')
     THEN RAISE EXCEPTION 'E7_23_POST_TRACKING_ROWS_UNEXPECTED'; END IF;
  t_post := {tblfp};
  IF t_post IS DISTINCT FROM t_pre THEN RAISE EXCEPTION 'E7_23_BOOKING_ROWS_CHANGED'; END IF;
  IF {renders12} IS DISTINCT FROM r12_pre THEN RAISE EXCEPTION 'E7_23_RENDER_ORIGINAL_COLUMNS_CHANGED'; END IF;
  IF {intent_ids} IS DISTINCT FROM ids_pre THEN RAISE EXCEPTION 'E7_23_INTENT_SET_CHANGED'; END IF;
  IF EXISTS (SELECT 1 FROM booking.notification_renders WHERE locale IS NOT NULL OR copy_contract_version IS NOT NULL) THEN RAISE EXCEPTION 'E7_23_NEW_RENDER_COLUMNS_NOT_NULL'; END IF;
  IF (SELECT count(*) FROM booking.notification_provider_receipts) <> 0 THEN RAISE EXCEPTION 'E7_23_NEW_TABLE_NOT_EMPTY'; END IF;
  RAISE NOTICE 'E7_23_APPLIED';
END
$e7pkg$;
-- read-only status line (the editor's last result; the true state whether or not the DO above succeeded)
SELECT jsonb_build_object('migrations_max', (SELECT max(version) FROM booking_migrations.applied),
  'v22', EXISTS (SELECT 1 FROM booking_migrations.applied WHERE version = 22),
  'v23', EXISTS (SELECT 1 FROM booking_migrations.applied WHERE version = 23),
  'claim_guest_notification_v2', to_regprocedure('booking.claim_guest_notification_v2(uuid,text,text,text,text,text)') IS NOT NULL,
  'complete_guest_notification_resend', to_regprocedure('booking.complete_guest_notification_resend(uuid,text,text,uuid,boolean,text)') IS NOT NULL,
  'receipts_rows', {receipts_rows},
  'functions_sha256', ({indent(inv_body, 2)}) -> 'functions') AS e7_23_status;
"""

readback = f"""-- e7-0022-0023-readback-v1.sql — PURE READ-ONLY (C46). Run it BEFORE and AFTER the 0022 + 0023 apply wrapper and compare with the pins
-- (claude/e7-0022-0023-pins-v1.json: `pre` must equal the BEFORE identity keys, `post` the AFTER). LABELLED SPECIALISATION of the accepted
-- claude/e7-0021-readback-v1.sql. Writes nothing, takes no lock, returns only counts / hashes / flags (no guest field, no credential). Schema owner.
-- `identity` = claude/e7-0022-0023-inventory.sql verbatim (sha256 {pins["inventorySql"]}).
-- `exclusion` shows why an apply would refuse now. `data` must be IDENTICAL before and after: per-table count + whole-row fingerprint over the PRE
-- column / table set (0022's two render columns removed; the new receipts table excluded), the original 12 render columns, the intent id set and the
-- whole 0001-0021 history rows. `renders_non_gn_v1_or_meta` must be 0 before AND after; `receipts_rows` null before, 0 after.
-- Expected BEFORE: identity.functions = {PRE["functions"]}, migrations.max = 21, aggregate = {C_HIST21}, every identity.objects = false.
-- Expected AFTER:  identity.functions = {POST["functions"]}, migrations.max = 23, aggregate = {C_HIST23}, aggregate_1_21 unchanged,
--                  v22 up {F["up22"]}, v23 up {F["up23"]}, every identity.objects = true, `data` identical.
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
    'renders_original_12', {renders12},
    'intent_ids', {intent_ids},
    'history_rows_1_21', {hist_rows21}),
  'renders_non_gn_v1_or_meta', {renders_meta},
  'receipts_rows', {receipts_rows}
) AS e7_23_readback;
"""

for path, text in (("claude/e7-0022-0023-sqleditor-apply-v1.sql", wrapper), ("claude/e7-0022-0023-readback-v1.sql", readback)):
    full = os.path.join(ROOT, path)
    if os.path.exists(full) and not WRITE:
        assert open(full, encoding="utf8").read() == text, f"{path} is not byte-identical to the deterministic assembly (re-run with --write)"
    else:
        open(full, "w", encoding="utf8").write(text)
    print(path, "sha256:", sha(text))
assert re.search(r"\$e7_0022_up\$(.*?)\$e7_0022_up\$", wrapper, re.S).group(1) == up22
assert re.search(r"\$e7_0023_up\$(.*?)\$e7_0023_up\$", wrapper, re.S).group(1) == up23
for v in ("0019_test_cleanup_refund_settlement", "0020_test_refund_evidence_settlement", "0021_recorded_cleanup_foundation"):
    assert rd(f"db/migrations/{v}.up.sql") not in wrapper
for d in (down22, down23): assert d not in wrapper
print("embedded up22 sha256:", sha(up22)); print("embedded up23 sha256:", sha(up23))
