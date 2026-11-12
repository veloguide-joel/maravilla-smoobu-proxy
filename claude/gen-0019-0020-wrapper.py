#!/usr/bin/env python3
# Generator for claude/e7-0019-0020-sqleditor-apply-v1.sql and claude/e7-0019-0020-readback-v1.sql — LABELLED SPECIALISATION of the accepted
# claude/gen-0018-wrapper.py pattern for TWO ordered migrations in ONE transaction. Deterministic exact-source assembly:
#   * embeds db/migrations/0019_*.up.sql and 0020_*.up.sql VERBATIM (sha256-checked in-transaction against the pinned file checksums),
#   * pins every PRE / POST schema-identity fact from claude/e7-0019-0020-pins-v1.json (derived on a DISPOSABLE cluster by
#     claude/derive-0019-0020-pins.mjs with the accepted migrator), and embeds claude/e7-0019-0020-inventory.sql VERBATIM as the identity probe,
#   * never edits the merged migrations; never adopts / upserts / replays / runs a down; refuses on ANY drift (RAISE -> whole statement rolls back).
# PREPARATION ONLY: this is reviewable prep for the shared DEV TEST database, NOT permission to apply. Run from the worktree root:
#   python3 claude/gen-0019-0020-wrapper.py .      (asserts byte-identical regeneration when the outputs already exist, unless --write)
import hashlib, json, os, re, sys

ROOT = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("--") else "."
WRITE = "--write" in sys.argv
rd = lambda p: open(os.path.join(ROOT, p), encoding="utf8").read()
sha = lambda s: hashlib.sha256(s.encode("utf8")).hexdigest()

pins = json.loads(rd("claude/e7-0019-0020-pins-v1.json"))
assert pins["schema"] == "e7-0019-0020-pins-v1"
up19 = rd("db/migrations/0019_test_cleanup_refund_settlement.up.sql"); down19 = rd("db/migrations/0019_test_cleanup_refund_settlement.down.sql")
up20 = rd("db/migrations/0020_test_refund_evidence_settlement.up.sql"); down20 = rd("db/migrations/0020_test_refund_evidence_settlement.down.sql")
F = pins["files"]
assert sha(up19) == F["up19"] and sha(down19) == F["down19"] and sha(up20) == F["up20"] and sha(down20) == F["down20"], "merged migration bytes differ from the pins"
assert F["name19"] == "test_cleanup_refund_settlement" and F["name20"] == "test_refund_evidence_settlement"
for tag in ("$e7_0019_up$", "$e7_0020_up$", "$e7pkg$"):
    assert tag not in up19 and tag not in up20, tag
inventory = rd("claude/e7-0019-0020-inventory.sql")
assert sha(inventory) == pins["inventorySql"], "inventory probe changed after the pins were derived: re-derive"
# the probe as a scalar subquery: drop the leading comment lines and the trailing alias
inv_body = "\n".join(l for l in inventory.splitlines() if not l.startswith("--")).strip()
assert inv_body.endswith(" AS e7_inventory"); inv_body = inv_body[: -len(" AS e7_inventory")]
assert "$" not in inv_body, "dollar signs would break the DO body"

PRE = dict(pins["pre"]); POST = dict(pins["post"])
IDENTITY_KEYS = ["functions", "function_count", "triggers", "trigger_count", "constraints", "indexes", "columns", "table_acls", "schema_owner",
                 "is_privileged_src", "is_privileged_config", "test_cleanup_pending_state", "objects", "acls"]
ident = lambda inv: json.dumps({k: inv[k] for k in IDENTITY_KEYS}, sort_keys=True, separators=(",", ":"))
c_pre, c_post = ident(PRE), ident(POST)
assert "'" not in c_pre and "'" not in c_post and "$" not in c_pre and "$" not in c_post
C_HIST18 = PRE["migrations"]["aggregate"]
assert PRE["migrations"]["count"] == 18 and PRE["migrations"]["max"] == 18 and POST["migrations"]["count"] == 20 and POST["migrations"]["max"] == 20
assert PRE["is_privileged_src"] == "a14a1dc5befcd96d03ca1c7e28020c5b07b6d1b212510cc1ad715368bc43fb9d", "0018 (qualified is_privileged) is the pinned prerequisite"
assert PRE["test_cleanup_pending_state"] is False and POST["test_cleanup_pending_state"] is True
assert all(v is False for v in PRE["objects"].values()) and all(v is True for v in POST["objects"].values())
assert PRE["schema_owner"] == "postgres" == POST["schema_owner"]
LOCK_KEY = "e7-connected-runner"   # = scripts/e7-connected/run-lock-precheck.mjs LOCK_KEY (the hosted runners' P3 session lock; asserted by the tests)

tblfp = ("(SELECT jsonb_object_agg(t.relname, x.v) FROM pg_class t JOIN pg_namespace s ON s.oid = t.relnamespace, "
         "LATERAL (SELECT (xpath('/row/v/text()', query_to_xml(format("
         "'SELECT count(*) || '':'' || md5(coalesce(string_agg(x::text, E''\\n'' ORDER BY x::text), '''')) AS v FROM booking.%I x', t.relname), "
         "false, true, '')))[1]::text AS v) x WHERE s.nspname = 'booking' AND t.relkind IN ('r', 'p'))")
hist = lambda where: ("SELECT encode(sha256(convert_to(string_agg(version || ':' || name || ':' || up_checksum || ':' || down_checksum, E'\\n' ORDER BY version), 'UTF8')), 'hex') "
                      f"FROM booking_migrations.applied{where}")
active_lock = ("EXISTS (SELECT 1 FROM pg_catalog.pg_locks l WHERE l.locktype = 'advisory' AND l.granted "
               "AND l.database = (SELECT d.oid FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database()) "
               f"AND l.classid = ((pg_catalog.hashtext('{LOCK_KEY}')::bigint + 4294967296) % 4294967296)::oid AND l.objid = 0::oid AND l.objsubid = 2)")
indent = lambda s, n: ("\n" + " " * n).join(s.splitlines())

wrapper = f"""-- e7-0019-0020-sqleditor-apply-v1.sql — ONE atomic DO statement for the Supabase SQL editor (schema owner = dashboard `postgres`).
-- PREPARATION ONLY: reviewable prep for the maraVilla shared DEV TEST database, NOT permission to apply and NOT an owner command.
-- Applies EXACTLY db/migrations/0019_test_cleanup_refund_settlement.up.sql THEN 0020_test_refund_evidence_settlement.up.sql (bytes embedded
-- verbatim, header intact, sha256-checked in-transaction) in ONE transaction, mirroring scripts/db-migrate.mjs + db/lib/migrate.js migrateUp
-- for two consecutive versions: advisory xact lock 7302215001, re-verified history (exactly 0001-0018) / environment / schema-owner role /
-- 0018 prerequisite / FULL schema identity (functions, triggers, constraints, indexes, columns, table ACLs, exact function ACLs) / no active
-- hosted run or work lease / no 0019 vocabulary in use, the two up scripts, TWO ordered tracking rows, then the FULL POST identity, exact ACLs,
-- unchanged 0001-0018 history and byte-identical booking table rows. Refuses (RAISE -> whole statement rolls back) on ANY drift: never adopts,
-- replays, upserts, creates bookkeeping, repairs data, widens a grant or runs a down. Zero booking DML. Returns no guest field and no credential.
-- Generated by claude/gen-0019-0020-wrapper.py from the merged migration bytes + claude/e7-0019-0020-pins-v1.json (disposable-cluster derived);
-- the identity probe is claude/e7-0019-0020-inventory.sql verbatim. Repeat behaviour: a second run refuses E7_1920_ALREADY_APPLIED_OR_LATER.
-- Forward-only: 0020's down refuses once any refund row was settled through it, 0019's down refuses once its vocabulary is in use; the shared
-- database is NEVER downed automatically — a rollback is its own reviewed decision.
-- TIME BOUND (ROOT local finding): a statement_timeout set INSIDE a running DO does not bound that DO. The bound is therefore set by the SEPARATE
-- statements below, which run BEFORE the DO in the same editor batch (one simple-query string = one implicit transaction: an error in the DO
-- rolls the whole batch back, the SETs included, and leaves no session residue). The tests prove this empirically with a short timeout.
SET statement_timeout = '180s';
SET lock_timeout = '5s';
DO $e7pkg$
DECLARE
  up19      constant text  := $e7_0019_up${up19}$e7_0019_up$;
  up20      constant text  := $e7_0020_up${up20}$e7_0020_up$;
  c_up19    constant text  := '{F["up19"]}';
  c_down19  constant text  := '{F["down19"]}';
  c_up20    constant text  := '{F["up20"]}';
  c_down20  constant text  := '{F["down20"]}';
  c_hist18  constant text  := '{C_HIST18}';
  c_pre     constant jsonb := '{c_pre}'::jsonb;
  c_post    constant jsonb := '{c_post}'::jsonb;
  inv_pre jsonb; inv_post jsonb; t_pre jsonb; t_post jsonb; h text; n bigint; k text; bad text := '';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);                        -- never wait unboundedly for the lock or a catalog row
  PERFORM pg_advisory_xact_lock(7302215001);                             -- = db/lib/migrate.js LOCK_KEY (transaction-scoped)
  IF encode(sha256(convert_to(up19, 'UTF8')), 'hex') <> c_up19 THEN RAISE EXCEPTION 'E7_1920_UP19_BYTES_MISMATCH'; END IF;
  IF encode(sha256(convert_to(up20, 'UTF8')), 'hex') <> c_up20 THEN RAISE EXCEPTION 'E7_1920_UP20_BYTES_MISMATCH'; END IF;
  -- schema-owner-only: the dashboard owner role (schema booking's owner), never app / admin / report
  IF current_user::text <> (SELECT pg_catalog.pg_get_userbyid(nspowner)::text FROM pg_catalog.pg_namespace WHERE nspname = 'booking') THEN RAISE EXCEPTION 'E7_1920_NOT_SCHEMA_OWNER'; END IF;
  IF to_regclass('booking_migrations.applied') IS NULL THEN RAISE EXCEPTION 'E7_1920_NO_TRACKING_TABLE'; END IF;   -- never create one
  IF to_regclass('booking.instance') IS NULL THEN RAISE EXCEPTION 'E7_1920_NO_INSTANCE'; END IF;
  SELECT count(*) INTO n FROM booking.instance;
  IF n <> 1 OR (SELECT environment FROM booking.instance) IS DISTINCT FROM 'test' THEN RAISE EXCEPTION 'E7_1920_NOT_TEST'; END IF;
  IF EXISTS (SELECT 1 FROM booking_migrations.applied WHERE version >= 19) THEN RAISE EXCEPTION 'E7_1920_ALREADY_APPLIED_OR_LATER'; END IF;
  IF (SELECT count(*) FROM booking_migrations.applied) <> 18 OR (SELECT min(version) FROM booking_migrations.applied) <> 1
     OR (SELECT max(version) FROM booking_migrations.applied) <> 18 THEN RAISE EXCEPTION 'E7_1920_HISTORY_NOT_1_TO_18'; END IF;
  IF EXISTS (SELECT 1 FROM booking_migrations.applied WHERE environment IS DISTINCT FROM 'test') THEN RAISE EXCEPTION 'E7_1920_ENV_MISMATCH'; END IF;
  SELECT ({hist("")}) INTO h;
  IF h IS DISTINCT FROM c_hist18 THEN RAISE EXCEPTION 'E7_1920_HISTORY_DRIFT'; END IF;             -- names + up/down checksums of 0001-0018 exactly
  -- active-run / work-lease exclusion: the hosted runners' P3 session lock must be free (and is held for this transaction), no work / op / intent lease, no in-flight write
  IF {active_lock} THEN RAISE EXCEPTION 'E7_1920_ACTIVE_RUN_LOCK_HELD'; END IF;
  IF NOT pg_try_advisory_xact_lock(pg_catalog.hashtext('{LOCK_KEY}'), 0) THEN RAISE EXCEPTION 'E7_1920_ACTIVE_RUN_LOCK_HELD'; END IF;
  IF EXISTS (SELECT 1 FROM booking.intent_work WHERE work_worker_id IS NOT NULL OR work_lease_until IS NOT NULL) THEN RAISE EXCEPTION 'E7_1920_ACTIVE_WORK_LEASE'; END IF;
  IF EXISTS (SELECT 1 FROM booking.intents WHERE lease_worker_id IS NOT NULL OR lease_until IS NOT NULL) THEN RAISE EXCEPTION 'E7_1920_ACTIVE_INTENT_LEASE'; END IF;
  IF EXISTS (SELECT 1 FROM booking.external_operations WHERE lease_worker_id IS NOT NULL OR lease_until IS NOT NULL OR state = 'in_flight') THEN RAISE EXCEPTION 'E7_1920_OPERATION_LEASED_OR_IN_FLIGHT'; END IF;
  -- 0019 vocabulary must not already be in use (it would mean an unrecorded partial apply or foreign data)
  IF EXISTS (SELECT 1 FROM booking.intents WHERE state = 'test_cleanup_pending')
     OR EXISTS (SELECT 1 FROM booking.external_operations WHERE op_type IN ('stripe.refund_payment_intent', 'stripe.retrieve_refund'))
     OR EXISTS (SELECT 1 FROM booking.provider_evidence WHERE kind = 'stripe_refund')
     OR EXISTS (SELECT 1 FROM booking.payment_refunds WHERE hostaway_state = 'not_applicable') THEN RAISE EXCEPTION 'E7_1920_VOCABULARY_ALREADY_IN_USE'; END IF;
  -- FULL PRE schema identity == the disposable-cluster reconstruction of EXACTLY 0001-0018 (functions / triggers / constraints / indexes / columns / ACLs / objects absent)
  inv_pre := ({indent(inv_body, 13)});
  IF (inv_pre ->> 'is_privileged_src') IS DISTINCT FROM (c_pre ->> 'is_privileged_src') OR (inv_pre -> 'is_privileged_config') IS DISTINCT FROM (c_pre -> 'is_privileged_config')
     THEN RAISE EXCEPTION 'E7_1920_0018_PREREQUISITE_MISSING'; END IF;
  FOR k IN SELECT jsonb_object_keys(c_pre) LOOP
    IF (inv_pre -> k) IS DISTINCT FROM (c_pre -> k) THEN bad := bad || k || ','; END IF;
  END LOOP;
  IF bad <> '' THEN RAISE EXCEPTION 'E7_1920_SCHEMA_IDENTITY_DRIFT:%', bad; END IF;             -- key names only, never values
  t_pre := {tblfp};
  -- ---- the two migrations, in order, exactly what migrateUp does for each version ----
  PERFORM set_config('booking.migration_environment', 'test', true);
  EXECUTE up19;
  INSERT INTO booking_migrations.applied (version, name, up_checksum, down_checksum, environment) VALUES (19, '{F["name19"]}', c_up19, c_down19, 'test');
  EXECUTE up20;
  INSERT INTO booking_migrations.applied (version, name, up_checksum, down_checksum, environment) VALUES (20, '{F["name20"]}', c_up20, c_down20, 'test');
  -- ---- post-conditions (still inside the same statement; any failure rolls everything back) ----
  inv_post := ({indent(inv_body, 14)});
  bad := '';
  FOR k IN SELECT jsonb_object_keys(c_post) LOOP
    IF (inv_post -> k) IS DISTINCT FROM (c_post -> k) THEN bad := bad || k || ','; END IF;
  END LOOP;
  IF bad <> '' THEN RAISE EXCEPTION 'E7_1920_POST_SCHEMA_IDENTITY_UNEXPECTED:%', bad; END IF;  -- exact objects / definitions / ACLs / triggers after
  IF (inv_post -> 'objects') <> '{json.dumps({k: True for k in POST["objects"]}, sort_keys=True, separators=(",", ":"))}'::jsonb THEN RAISE EXCEPTION 'E7_1920_POST_OBJECTS_MISSING'; END IF;
  IF (inv_post -> 'test_cleanup_pending_state') <> 'true'::jsonb THEN RAISE EXCEPTION 'E7_1920_POST_STATE_NOT_ACCEPTED'; END IF;
  SELECT ({hist(" WHERE version <= 18")}) INTO h;
  IF h IS DISTINCT FROM c_hist18 THEN RAISE EXCEPTION 'E7_1920_POST_HISTORY_1_TO_18_CHANGED'; END IF;          -- 0001-0018 rows untouched
  IF (SELECT count(*) FROM booking_migrations.applied) <> 20 OR (SELECT max(version) FROM booking_migrations.applied) <> 20
     OR NOT EXISTS (SELECT 1 FROM booking_migrations.applied WHERE version = 19 AND name = '{F["name19"]}' AND up_checksum = c_up19 AND down_checksum = c_down19 AND environment = 'test')
     OR NOT EXISTS (SELECT 1 FROM booking_migrations.applied WHERE version = 20 AND name = '{F["name20"]}' AND up_checksum = c_up20 AND down_checksum = c_down20 AND environment = 'test')
     THEN RAISE EXCEPTION 'E7_1920_POST_TRACKING_ROWS_UNEXPECTED'; END IF;
  t_post := {tblfp};
  IF t_post IS DISTINCT FROM t_pre THEN RAISE EXCEPTION 'E7_1920_BOOKING_ROWS_CHANGED'; END IF;      -- zero booking-row writes (or a concurrent writer)
  RAISE NOTICE 'E7_1920_APPLIED';
END
$e7pkg$;
-- read-only status line (shown by the editor as the last result; true state whether or not the DO above succeeded)
SELECT jsonb_build_object('migrations_max', (SELECT max(version) FROM booking_migrations.applied),
  'v19', EXISTS (SELECT 1 FROM booking_migrations.applied WHERE version = 19), 'v20', EXISTS (SELECT 1 FROM booking_migrations.applied WHERE version = 20),
  'test_cleanup_pending_state', booking.is_intent_state('test_cleanup_pending'),
  'settle_test_refund_from_evidence', to_regprocedure('booking.settle_test_refund_from_evidence(uuid,uuid)') IS NOT NULL,
  'functions_sha256', ({indent(inv_body, 2)}) -> 'functions') AS e7_1920_status;
RESET statement_timeout;
RESET lock_timeout;
"""

readback = f"""-- e7-0019-0020-readback-v1.sql — PURE READ-ONLY. Run it BEFORE and AFTER the 0019+0020 apply wrapper and compare the JSON with the pins
-- (claude/e7-0019-0020-pins-v1.json: `pre` must equal the BEFORE identity keys, `post` the AFTER). It writes nothing, takes no lock (the advisory
-- probe only READS pg_locks), returns no guest field or credential. SCHEMA-OWNER ONLY in practice (booking_migrations has no app/admin/report USAGE).
-- `identity` = claude/e7-0019-0020-inventory.sql verbatim (sha256 {pins["inventorySql"]}); `exclusion` shows why an apply would refuse now
-- (active hosted-run lock, work / intent / operation leases, in-flight writes, 0019 vocabulary already present); `booking_tables_fingerprint`
-- must be IDENTICAL before and after (zero booking-row writes).
-- Expected BEFORE: identity.functions = {PRE["functions"]}, migrations.max = 18, aggregate = {C_HIST18}, every identity.objects = false.
-- Expected AFTER:  identity.functions = {POST["functions"]}, migrations.max = 20 with exactly the two added rows (v19 up {F["up19"]}, v20 up {F["up20"]}),
--                  aggregate_1_18 unchanged, every identity.objects = true, test_cleanup_pending_state = true, booking_tables_fingerprint identical.
SELECT jsonb_build_object(
  'identity', ({indent(inv_body, 15)}),
  'instance', (SELECT jsonb_build_object('rows', count(*), 'environment', min(environment)) FROM booking.instance),
  'current_user', current_user::text,
  'exclusion', jsonb_build_object(
    'hosted_run_lock_held', {active_lock},
    'work_leases', (SELECT count(*) FROM booking.intent_work WHERE work_worker_id IS NOT NULL OR work_lease_until IS NOT NULL),
    'intent_leases', (SELECT count(*) FROM booking.intents WHERE lease_worker_id IS NOT NULL OR lease_until IS NOT NULL),
    'operation_leases_or_in_flight', (SELECT count(*) FROM booking.external_operations WHERE lease_worker_id IS NOT NULL OR lease_until IS NOT NULL OR state = 'in_flight'),
    'vocabulary_rows', (SELECT (SELECT count(*) FROM booking.intents WHERE state = 'test_cleanup_pending') + (SELECT count(*) FROM booking.external_operations WHERE op_type IN ('stripe.refund_payment_intent', 'stripe.retrieve_refund'))
                        + (SELECT count(*) FROM booking.provider_evidence WHERE kind = 'stripe_refund') + (SELECT count(*) FROM booking.payment_refunds WHERE hostaway_state = 'not_applicable'))),
  'booking_tables_fingerprint', {tblfp}
) AS e7_1920_readback;
"""

for path, text in (("claude/e7-0019-0020-sqleditor-apply-v1.sql", wrapper), ("claude/e7-0019-0020-readback-v1.sql", readback)):
    full = os.path.join(ROOT, path)
    if os.path.exists(full) and not WRITE:
        assert open(full, encoding="utf8").read() == text, f"{path} is not byte-identical to the deterministic assembly (re-run with --write)"
    else:
        open(full, "w", encoding="utf8").write(text)
    print(path, "sha256:", sha(text))
emb19 = re.search(r"\$e7_0019_up\$(.*?)\$e7_0019_up\$", wrapper, re.S).group(1); emb20 = re.search(r"\$e7_0020_up\$(.*?)\$e7_0020_up\$", wrapper, re.S).group(1)
assert emb19 == up19 and emb20 == up20, "embedded up bytes diverged from the files"
print("embedded up19 sha256:", sha(emb19)); print("embedded up20 sha256:", sha(emb20))
