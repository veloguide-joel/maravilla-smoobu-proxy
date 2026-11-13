#!/usr/bin/env python3
# Generator for claude/e7-0021-sqleditor-apply-v1.sql and claude/e7-0021-readback-v1.sql — LABELLED SPECIALISATION of the accepted
# claude/gen-0019-0020-wrapper.py pattern for ONE migration (0021 ONLY) in ONE transaction, on a database that ALREADY carries exactly 0001-0020.
# Deterministic exact-source assembly:
#   * embeds db/migrations/0021_recorded_cleanup_foundation.up.sql VERBATIM (sha256-checked in-transaction against the pinned file checksum),
#   * pins every PRE / POST schema-identity fact from claude/e7-0021-pins-v1.json (derived on a DISPOSABLE cluster by claude/derive-0021-pins.mjs
#     with the accepted migrator), and embeds claude/e7-0021-inventory.sql VERBATIM as the identity probe,
#   * never edits the merged migrations; NEVER embeds / applies 0019 or 0020 (their spent artifacts claude/e7-0019-0020-* are untouched); never adopts /
#     upserts / replays / runs a down; refuses on ANY drift (RAISE -> whole statement rolls back).
# FUTURE PREPARATION ONLY: the shared DEV TEST database is still at 0018 and the 0019/0020 issuance HOLD is unchanged; this packet is NOT permission to
# apply, retry or fall back. Run from the worktree root:
#   python3 claude/gen-0021-wrapper.py .      (asserts byte-identical regeneration when the outputs already exist, unless --write)
import hashlib, json, os, re, sys

ROOT = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("--") else "."
WRITE = "--write" in sys.argv
rd = lambda p: open(os.path.join(ROOT, p), encoding="utf8").read()
sha = lambda s: hashlib.sha256(s.encode("utf8")).hexdigest()

pins = json.loads(rd("claude/e7-0021-pins-v1.json"))
assert pins["schema"] == "e7-0021-pins-v1"
up21 = rd("db/migrations/0021_recorded_cleanup_foundation.up.sql"); down21 = rd("db/migrations/0021_recorded_cleanup_foundation.down.sql")
F = pins["files"]
assert sha(up21) == F["up21"] and sha(down21) == F["down21"], "merged migration bytes differ from the pins"
assert F["name21"] == "recorded_cleanup_foundation"
for tag in ("$e7_0021_up$", "$e7pkg$"):
    assert tag not in up21, tag
inventory = rd("claude/e7-0021-inventory.sql")
assert sha(inventory) == pins["inventorySql"], "inventory probe changed after the pins were derived: re-derive"
# the probe as a scalar subquery: drop the leading comment lines and the trailing alias
inv_body = "\n".join(l for l in inventory.splitlines() if not l.startswith("--")).strip()
assert inv_body.endswith(" AS e7_inventory"); inv_body = inv_body[: -len(" AS e7_inventory")]
assert "$" not in inv_body, "dollar signs would break the DO body"

PRE = dict(pins["pre"]); POST = dict(pins["post"])
IDENTITY_KEYS = ["functions", "function_count", "triggers", "trigger_count", "constraints", "indexes", "columns", "table_acls", "rls", "rls_enabled_count", "policies", "policy_count",
                 "schema_owner", "is_privileged_src", "is_privileged_config", "test_cleanup_pending_state", "prerequisite_0020", "objects", "acls"]
ident = lambda inv: json.dumps({k: inv[k] for k in IDENTITY_KEYS}, sort_keys=True, separators=(",", ":"))
c_pre, c_post = ident(PRE), ident(POST)
assert "'" not in c_pre and "'" not in c_post and "$" not in c_pre and "$" not in c_post
C_HIST20 = PRE["migrations"]["aggregate"]
assert PRE["migrations"]["count"] == 20 and PRE["migrations"]["max"] == 20 and POST["migrations"]["count"] == 21 and POST["migrations"]["max"] == 21
assert PRE["is_privileged_src"] == "a14a1dc5befcd96d03ca1c7e28020c5b07b6d1b212510cc1ad715368bc43fb9d", "0018 (qualified is_privileged) stays the pinned prerequisite"
assert PRE["test_cleanup_pending_state"] is True and POST["test_cleanup_pending_state"] is True, "0019 vocabulary is a PRE fact here"
assert all(v is True for v in PRE["prerequisite_0020"].values()) and all(v is True for v in POST["prerequisite_0020"].values()), "0019 / 0020 objects are the PRE prerequisite"
assert all(v is False for v in PRE["objects"].values()) and all(v is True for v in POST["objects"].values())
assert PRE["migrations"]["aggregate_1_20"] == C_HIST20 and POST["migrations"]["aggregate_1_20"] == C_HIST20
assert PRE["schema_owner"] == "postgres" == POST["schema_owner"]
LOCK_KEY = "e7-connected-runner"   # = scripts/e7-connected/run-lock-precheck.mjs LOCK_KEY (the hosted runners' P3 session lock; asserted by the tests)

# booking-row identity: 0021 ADDS one column (intents.settlement_recording_mirrored, NULL on every pre-existing row) and one EMPTY table (notification_suppressions),
# so a whole-row text fingerprint cannot be byte-identical across the apply (unlike the 0019/0020 packet, which added no column). The fingerprint is therefore taken
# over the PRE column set (the 0021 column key removed from the row's jsonb - a no-op before the apply) and over the PRE table set (the new table, which must be
# EMPTY, is asserted separately); every other table / column / row is compared byte-for-byte.
tblfp = ("(SELECT jsonb_object_agg(t.relname, x.v) FROM pg_class t JOIN pg_namespace s ON s.oid = t.relnamespace, "
         "LATERAL (SELECT (xpath('/row/v/text()', query_to_xml(format("
         "'SELECT count(*) || '':'' || md5(coalesce(string_agg((to_jsonb(x) - ''settlement_recording_mirrored'')::text, E''\\n'' ORDER BY (to_jsonb(x) - ''settlement_recording_mirrored'')::text), '''')) AS v FROM booking.%I x', t.relname), "
         "false, true, '')))[1]::text AS v) x WHERE s.nspname = 'booking' AND t.relkind IN ('r', 'p') AND t.relname <> 'notification_suppressions')")
hist = lambda where: ("SELECT encode(sha256(convert_to(string_agg(version || ':' || name || ':' || up_checksum || ':' || down_checksum, E'\\n' ORDER BY version), 'UTF8')), 'hex') "
                      f"FROM booking_migrations.applied{where}")
active_lock = ("EXISTS (SELECT 1 FROM pg_catalog.pg_locks l WHERE l.locktype = 'advisory' AND l.granted "
               "AND l.database = (SELECT d.oid FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database()) "
               f"AND l.classid = ((pg_catalog.hashtext('{LOCK_KEY}')::bigint + 4294967296) % 4294967296)::oid AND l.objid = 0::oid AND l.objsubid = 2)")
indent = lambda s, n: ("\n" + " " * n).join(s.splitlines())

wrapper = f"""-- e7-0021-sqleditor-apply-v1.sql — ONE atomic DO statement for the Supabase SQL editor (schema owner = dashboard `postgres`).
-- FUTURE PREPARATION ONLY: reviewable prep for the maraVilla shared DEV TEST database ONCE it carries exactly 0001-0020 (today it is at 0018 and the
-- 0019/0020 issuance HOLD is unchanged); NOT permission to apply, retry or fall back, and NOT an owner command. LABELLED SPECIALISATION of the accepted
-- claude/e7-0019-0020-sqleditor-apply-v1.sql for ONE migration. Applies EXACTLY db/migrations/0021_recorded_cleanup_foundation.up.sql (bytes embedded
-- verbatim, header intact, sha256-checked in-transaction) in ONE transaction, mirroring scripts/db-migrate.mjs + db/lib/migrate.js migrateUp for one
-- version: advisory xact lock 7302215001, re-verified history (exactly 0001-0020) / environment / schema-owner role / 0018 + 0019/0020 prerequisites /
-- FULL schema identity (functions, triggers, constraints, indexes, columns, table ACLs, RLS, policies, exact function ACLs) / no active hosted run or
-- work / intent / operation lease / no 0021 vocabulary in use, the ONE up script, ONE tracking row (21), then the FULL POST identity, exact ACLs, RLS,
-- unchanged 0001-0020 history and byte-identical booking table rows over the PRE column / table set (the added column NULL everywhere, the added table empty). Refuses (RAISE -> whole statement rolls back) on ANY drift: never adopts,
-- replays, upserts, creates bookkeeping, repairs data, widens a grant or runs a down; NEVER embeds or applies 0019 / 0020. Zero booking DML.
-- Returns no guest field and no credential. Generated by claude/gen-0021-wrapper.py from the merged migration bytes + claude/e7-0021-pins-v1.json
-- (disposable-cluster derived); the identity probe is claude/e7-0021-inventory.sql verbatim. Repeat behaviour: a second run refuses
-- E7_21_ALREADY_APPLIED_OR_LATER. Forward-only: 0021's down refuses once the foundation was used (mirror leg / mirror op / suppression / ledger);
-- the shared database is NEVER downed automatically — a rollback is its own reviewed decision.
-- TIME BOUND (ROOT local finding): a statement_timeout set INSIDE a running DO does not bound that DO. The bound is therefore set by the SEPARATE
-- SET LOCAL statements below, which run BEFORE the DO in the same editor batch (one simple-query string = one implicit transaction block, so
-- SET LOCAL is effective for the DO and the status SELECT and the caller's pre-existing session settings are preserved afterwards whether the batch
-- succeeds or fails). The tests prove this empirically with a short timeout and a non-default session control.
-- SCHEMA IDENTITY covers functions / triggers / constraints / indexes / columns / canonical table ACLs (owner item reduced to `owner`: portable over the
-- PG16 / PG17 owner-default MAINTAIN difference; every non-owner grant verbatim) / RLS flags / every policy definition / exact function ACLs / objects.
SET LOCAL statement_timeout = '180s';
SET LOCAL lock_timeout = '5s';
DO $e7pkg$
DECLARE
  up21      constant text  := $e7_0021_up${up21}$e7_0021_up$;
  c_up21    constant text  := '{F["up21"]}';
  c_down21  constant text  := '{F["down21"]}';
  c_hist20  constant text  := '{C_HIST20}';
  c_pre     constant jsonb := '{c_pre}'::jsonb;
  c_post    constant jsonb := '{c_post}'::jsonb;
  inv_pre jsonb; inv_post jsonb; t_pre jsonb; t_post jsonb; h text; n bigint; k text; bad text := '';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);                        -- never wait unboundedly for the lock or a catalog row
  PERFORM pg_advisory_xact_lock(7302215001);                             -- = db/lib/migrate.js LOCK_KEY (transaction-scoped)
  IF encode(sha256(convert_to(up21, 'UTF8')), 'hex') <> c_up21 THEN RAISE EXCEPTION 'E7_21_UP21_BYTES_MISMATCH'; END IF;
  -- schema-owner-only: the dashboard owner role (schema booking's owner), never app / admin / report
  IF current_user::text <> (SELECT pg_catalog.pg_get_userbyid(nspowner)::text FROM pg_catalog.pg_namespace WHERE nspname = 'booking') THEN RAISE EXCEPTION 'E7_21_NOT_SCHEMA_OWNER'; END IF;
  IF to_regclass('booking_migrations.applied') IS NULL THEN RAISE EXCEPTION 'E7_21_NO_TRACKING_TABLE'; END IF;   -- never create one
  IF to_regclass('booking.instance') IS NULL THEN RAISE EXCEPTION 'E7_21_NO_INSTANCE'; END IF;
  SELECT count(*) INTO n FROM booking.instance;
  IF n <> 1 OR (SELECT environment FROM booking.instance) IS DISTINCT FROM 'test' THEN RAISE EXCEPTION 'E7_21_NOT_TEST'; END IF;
  IF EXISTS (SELECT 1 FROM booking_migrations.applied WHERE version >= 21) THEN RAISE EXCEPTION 'E7_21_ALREADY_APPLIED_OR_LATER'; END IF;
  IF (SELECT count(*) FROM booking_migrations.applied) <> 20 OR (SELECT min(version) FROM booking_migrations.applied) <> 1
     OR (SELECT max(version) FROM booking_migrations.applied) <> 20 THEN RAISE EXCEPTION 'E7_21_HISTORY_NOT_1_TO_20'; END IF;         -- 0019 + 0020 must ALREADY be applied through their own reviewed packet
  IF EXISTS (SELECT 1 FROM booking_migrations.applied WHERE environment IS DISTINCT FROM 'test') THEN RAISE EXCEPTION 'E7_21_ENV_MISMATCH'; END IF;
  SELECT ({hist("")}) INTO h;
  IF h IS DISTINCT FROM c_hist20 THEN RAISE EXCEPTION 'E7_21_HISTORY_DRIFT'; END IF;               -- names + up/down checksums of 0001-0020 exactly
  -- active-run / work-lease exclusion: the hosted runners' P3 session lock must be free (and is held for this transaction), no work / op / intent lease, no in-flight write
  IF {active_lock} THEN RAISE EXCEPTION 'E7_21_ACTIVE_RUN_LOCK_HELD'; END IF;
  IF NOT pg_try_advisory_xact_lock(pg_catalog.hashtext('{LOCK_KEY}'), 0) THEN RAISE EXCEPTION 'E7_21_ACTIVE_RUN_LOCK_HELD'; END IF;
  IF EXISTS (SELECT 1 FROM booking.intent_work WHERE work_worker_id IS NOT NULL OR work_lease_until IS NOT NULL) THEN RAISE EXCEPTION 'E7_21_ACTIVE_WORK_LEASE'; END IF;
  IF EXISTS (SELECT 1 FROM booking.intents WHERE lease_worker_id IS NOT NULL OR lease_until IS NOT NULL) THEN RAISE EXCEPTION 'E7_21_ACTIVE_INTENT_LEASE'; END IF;
  IF EXISTS (SELECT 1 FROM booking.external_operations WHERE lease_worker_id IS NOT NULL OR lease_until IS NOT NULL OR state = 'in_flight') THEN RAISE EXCEPTION 'E7_21_OPERATION_LEASED_OR_IN_FLIGHT'; END IF;
  -- 0021 vocabulary must not already be in use (it would mean an unrecorded partial apply or foreign data); the 0019 vocabulary MAY be present (it is PRE here)
  IF EXISTS (SELECT 1 FROM booking.external_operations WHERE op_type = 'hostaway.refund_offline_charge')
     OR EXISTS (SELECT 1 FROM booking.payment_ledger WHERE entry = 'offline_charge_refund_recorded')
     OR to_regclass('booking.notification_suppressions') IS NOT NULL
     OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'booking' AND table_name = 'intents' AND column_name = 'settlement_recording_mirrored')
     THEN RAISE EXCEPTION 'E7_21_VOCABULARY_ALREADY_IN_USE'; END IF;
  -- FULL PRE schema identity == the disposable-cluster reconstruction of EXACTLY 0001-0020 (functions / triggers / constraints / indexes / columns / ACLs / RLS / 0019-0020 objects present / 0021 objects absent)
  inv_pre := ({indent(inv_body, 13)});
  IF (inv_pre ->> 'is_privileged_src') IS DISTINCT FROM (c_pre ->> 'is_privileged_src') OR (inv_pre -> 'is_privileged_config') IS DISTINCT FROM (c_pre -> 'is_privileged_config')
     THEN RAISE EXCEPTION 'E7_21_0018_PREREQUISITE_MISSING'; END IF;
  IF (inv_pre -> 'prerequisite_0020') IS DISTINCT FROM (c_pre -> 'prerequisite_0020') OR (inv_pre -> 'test_cleanup_pending_state') <> 'true'::jsonb
     THEN RAISE EXCEPTION 'E7_21_0019_0020_PREREQUISITE_MISSING'; END IF;
  FOR k IN SELECT jsonb_object_keys(c_pre) LOOP
    IF (inv_pre -> k) IS DISTINCT FROM (c_pre -> k) THEN bad := bad || k || ','; END IF;
  END LOOP;
  IF bad <> '' THEN RAISE EXCEPTION 'E7_21_SCHEMA_IDENTITY_DRIFT:%', bad; END IF;               -- key names only, never values
  t_pre := {tblfp};
  -- ---- the ONE migration, exactly what migrateUp does for one version ----
  PERFORM set_config('booking.migration_environment', 'test', true);
  EXECUTE up21;
  INSERT INTO booking_migrations.applied (version, name, up_checksum, down_checksum, environment) VALUES (21, '{F["name21"]}', c_up21, c_down21, 'test');
  -- ---- post-conditions (still inside the same statement; any failure rolls everything back) ----
  inv_post := ({indent(inv_body, 14)});
  bad := '';
  FOR k IN SELECT jsonb_object_keys(c_post) LOOP
    IF (inv_post -> k) IS DISTINCT FROM (c_post -> k) THEN bad := bad || k || ','; END IF;
  END LOOP;
  IF bad <> '' THEN RAISE EXCEPTION 'E7_21_POST_SCHEMA_IDENTITY_UNEXPECTED:%', bad; END IF;    -- exact objects / definitions / ACLs / triggers after
  IF (inv_post -> 'objects') <> '{json.dumps({k: True for k in POST["objects"]}, sort_keys=True, separators=(",", ":"))}'::jsonb THEN RAISE EXCEPTION 'E7_21_POST_OBJECTS_MISSING'; END IF;
  IF (inv_post -> 'test_cleanup_pending_state') <> 'true'::jsonb THEN RAISE EXCEPTION 'E7_21_POST_STATE_NOT_ACCEPTED'; END IF;
  SELECT ({hist(" WHERE version <= 20")}) INTO h;
  IF h IS DISTINCT FROM c_hist20 THEN RAISE EXCEPTION 'E7_21_POST_HISTORY_1_TO_20_CHANGED'; END IF;            -- 0001-0020 rows untouched
  IF (SELECT count(*) FROM booking_migrations.applied) <> 21 OR (SELECT max(version) FROM booking_migrations.applied) <> 21
     OR NOT EXISTS (SELECT 1 FROM booking_migrations.applied WHERE version = 21 AND name = '{F["name21"]}' AND up_checksum = c_up21 AND down_checksum = c_down21 AND environment = 'test')
     THEN RAISE EXCEPTION 'E7_21_POST_TRACKING_ROW_UNEXPECTED'; END IF;
  t_post := {tblfp};
  IF t_post IS DISTINCT FROM t_pre THEN RAISE EXCEPTION 'E7_21_BOOKING_ROWS_CHANGED'; END IF;        -- zero booking-row writes over the PRE column / table set (or a concurrent writer)
  IF EXISTS (SELECT 1 FROM booking.intents WHERE settlement_recording_mirrored IS NOT NULL) THEN RAISE EXCEPTION 'E7_21_NEW_COLUMN_NOT_NULL'; END IF;   -- the added column is NULL on every pre-existing row
  IF (SELECT count(*) FROM booking.notification_suppressions) <> 0 THEN RAISE EXCEPTION 'E7_21_NEW_TABLE_NOT_EMPTY'; END IF;                     -- the added audit table starts empty
  RAISE NOTICE 'E7_21_APPLIED';
END
$e7pkg$;
-- read-only status line (shown by the editor as the last result; true state whether or not the DO above succeeded)
SELECT jsonb_build_object('migrations_max', (SELECT max(version) FROM booking_migrations.applied),
  'v21', EXISTS (SELECT 1 FROM booking_migrations.applied WHERE version = 21),
  'mirrored_column', EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'booking' AND table_name = 'intents' AND column_name = 'settlement_recording_mirrored'),
  'complete_offline_refund_with_evidence', to_regprocedure('booking.complete_offline_refund_with_evidence(uuid,text,uuid,text,integer)') IS NOT NULL,
  'recorded_state_cleanup_ok', to_regprocedure('booking.recorded_state_cleanup_ok(uuid)') IS NOT NULL,
  'functions_sha256', ({indent(inv_body, 2)}) -> 'functions') AS e7_21_status;
"""

readback = f"""-- e7-0021-readback-v1.sql — PURE READ-ONLY. Run it BEFORE and AFTER the 0021 apply wrapper and compare the JSON with the pins
-- (claude/e7-0021-pins-v1.json: `pre` must equal the BEFORE identity keys, `post` the AFTER; table_acls is canonical over the PG16 / PG17 owner
-- MAINTAIN default, rls / policies cover the accepted RLS boundary). LABELLED SPECIALISATION of the accepted claude/e7-0019-0020-readback-v1.sql. It writes
-- nothing, takes no lock (the advisory probe only READS pg_locks), returns no guest field or credential. SCHEMA-OWNER ONLY in practice.
-- `identity` = claude/e7-0021-inventory.sql verbatim (sha256 {pins["inventorySql"]}); `exclusion` shows why an apply would refuse now
-- (active hosted-run lock, work / intent / operation leases, in-flight writes, 0021 vocabulary already present); `booking_tables_fingerprint`
-- must be IDENTICAL before and after (zero booking-row writes; taken over the PRE column / table set, see the wrapper header). FUTURE PREP: the shared DEV database is at 0018 today (0019 / 0020 not applied).
-- Expected BEFORE: identity.functions = {PRE["functions"]}, migrations.max = 20, aggregate = {C_HIST20}, every identity.prerequisite_0020 = true, every identity.objects = false.
-- Expected AFTER:  identity.functions = {POST["functions"]}, migrations.max = 21 with exactly the ONE added row (v21 up {F["up21"]}, down {F["down21"]}),
--                  aggregate_1_20 unchanged, every identity.objects = true, booking_tables_fingerprint identical.
SELECT jsonb_build_object(
  'identity', ({indent(inv_body, 15)}),
  'instance', (SELECT jsonb_build_object('rows', count(*), 'environment', min(environment)) FROM booking.instance),
  'current_user', current_user::text,
  'exclusion', jsonb_build_object(
    'hosted_run_lock_held', {active_lock},
    'work_leases', (SELECT count(*) FROM booking.intent_work WHERE work_worker_id IS NOT NULL OR work_lease_until IS NOT NULL),
    'intent_leases', (SELECT count(*) FROM booking.intents WHERE lease_worker_id IS NOT NULL OR lease_until IS NOT NULL),
    'operation_leases_or_in_flight', (SELECT count(*) FROM booking.external_operations WHERE lease_worker_id IS NOT NULL OR lease_until IS NOT NULL OR state = 'in_flight'),
    'vocabulary_rows', (SELECT (SELECT count(*) FROM booking.external_operations WHERE op_type = 'hostaway.refund_offline_charge') + (SELECT count(*) FROM booking.payment_ledger WHERE entry = 'offline_charge_refund_recorded')),
    'vocabulary_objects', (SELECT (to_regclass('booking.notification_suppressions') IS NOT NULL)::int + (EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'booking' AND table_name = 'intents' AND column_name = 'settlement_recording_mirrored'))::int)),
  'booking_tables_fingerprint', {tblfp}
) AS e7_21_readback;
"""

for path, text in (("claude/e7-0021-sqleditor-apply-v1.sql", wrapper), ("claude/e7-0021-readback-v1.sql", readback)):
    full = os.path.join(ROOT, path)
    if os.path.exists(full) and not WRITE:
        assert open(full, encoding="utf8").read() == text, f"{path} is not byte-identical to the deterministic assembly (re-run with --write)"
    else:
        open(full, "w", encoding="utf8").write(text)
    print(path, "sha256:", sha(text))
emb21 = re.search(r"\$e7_0021_up\$(.*?)\$e7_0021_up\$", wrapper, re.S).group(1)
assert emb21 == up21, "embedded up bytes diverged from the file"
up19 = rd("db/migrations/0019_test_cleanup_refund_settlement.up.sql"); up20 = rd("db/migrations/0020_test_refund_evidence_settlement.up.sql")
assert up19 not in wrapper and up20 not in wrapper and "0019_test_cleanup_refund_settlement" not in wrapper.split("$e7_0021_up$")[0], "0019 / 0020 are never embedded by this wrapper"
print("embedded up21 sha256:", sha(emb21))
