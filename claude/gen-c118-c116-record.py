#!/usr/bin/env python3
# Generator for claude/e7-c118-c116-record-v1.sql and claude/e7-c118-c116-record-readback-v1.sql (C118) — the ONE owner-attested external-cancellation
# reconciliation of the C116 synthetic TEST booking (already cancelled by host in Hostaway; refund still manual and PENDING), on shared DEV TEST at
# EXACTLY the accepted POST-27 state. PARAMETERIZED: the private bindings are <<PLACEHOLDER>> tokens that ROOT substitutes before the single issuance;
# the transaction REFUSES while any token is unbound or malformed. The helper expressions (table fingerprints, quiescence, history, identity compare)
# are LABELLED COPIES of the accepted claude/gen-0027-wrapper.py; the identity probe is claude/e7-0027-inventory.sql VERBATIM and the expected identity
# is claude/e7-0027-pins-v1.json `post` (the state ROOT read back after the reviewed 0027 apply).
# What the ONE transaction does: fail-closed PRE checks → ONE owner-attested `hostaway_reservation` evidence row (status cancelled, observed at the
# fresh dashboard read) via booking.admin_record_evidence → ONE booking.admin_record_external_cancellation (refund 'pending') citing exactly that
# evidence → POST checks (sent_preserved, no latch, only its own claim released, every other row unchanged). Evidence and record are ATOMIC: any refusal
# (wrapper or reviewed function) rolls back both. Never calls a provider, never sends, never refunds, never changes a money / ledger / receipt row.
# Run from the worktree root:  python3 claude/gen-c118-c116-record.py .   (asserts byte-identical regeneration when the outputs exist, unless --write)
import hashlib, json, os, re, sys

ROOT = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("--") else "."
WRITE = "--write" in sys.argv
rd = lambda p: open(os.path.join(ROOT, p), encoding="utf8").read()
sha = lambda s: hashlib.sha256(s.encode("utf8")).hexdigest()

pins = json.loads(rd("claude/e7-0027-pins-v1.json"))
assert pins["schema"] == "e7-0027-pins-v1"
POST = pins["post"]
assert POST["functions"] == "137ea3dae9fb20cd8486598cc6ae71a4a619a34df51a096df501cdda07c15e82" and POST["migrations"]["aggregate"] == "f6f3b20b6be4a603a9fbc6472743dfa9e4d8af62c78156e90c13d34894147980"
inventory = rd("claude/e7-0027-inventory.sql")
assert sha(inventory) == pins["inventorySql"]
inv_body = "\n".join(l for l in inventory.splitlines() if not l.startswith("--")).strip()
assert inv_body.endswith(" AS e7_inventory"); inv_body = inv_body[: -len(" AS e7_inventory")]
assert "$" not in inv_body
IDENTITY_KEYS = ["functions", "function_count", "triggers", "trigger_count", "constraints", "indexes", "columns", "table_acls", "rls", "rls_enabled_count", "policies", "policy_count",
                 "schema_owner", "is_privileged_src", "is_privileged_config", "relations", "relation_count", "test_cleanup_pending_state", "prerequisite_0023", "objects", "acls"]
c_post = json.dumps({k: POST[k] for k in IDENTITY_KEYS}, sort_keys=True, separators=(",", ":")); assert "'" not in c_post and "$" not in c_post
C_HIST27 = POST["migrations"]["aggregate"]

# the bindings ROOT supplies (private; never committed). Each appears ONCE in the transaction, as a text literal validated before any use.
PLACEHOLDERS = ["C116_INTENT_ID", "EXPECTED_VERSION", "C116_RESERVATION_ID", "EXPECTED_LISTING_ID", "EXPECTED_CAPTURED_MINOR", "HOSTAWAY_CANCELLED_AT",
                "OBSERVED_AT", "REQUEST_KEY", "SHORT_REF"]
tok = lambda n: f"<<{n}>>"

# ---- labelled copies of the accepted claude/gen-0027-wrapper.py helper expressions ----
LOCK_KEY = "e7-connected-runner"
EXCLUDED = ["inventory_claims", "provider_evidence", "external_cancellations", "external_refund_attestations"]   # checked separately, row by row
excl = ", ".join(f"'{t}'" for t in EXCLUDED)
tblfp = ("(SELECT jsonb_object_agg(t.relname, x.v ORDER BY t.relname) FROM pg_catalog.pg_class t JOIN pg_catalog.pg_namespace s ON s.oid = t.relnamespace, "
         "LATERAL (SELECT (xpath('/row/v/text()', query_to_xml(format("
         "'SELECT count(*) || '':'' || md5(coalesce(string_agg(q.r, E''\\n'' ORDER BY q.r), '''')) AS v FROM (SELECT to_jsonb(x)::text AS r FROM booking.%I x) q', t.relname), "
         f"false, true, '')))[1]::text AS v) x WHERE s.nspname = 'booking' AND t.relkind IN ('r', 'p') AND t.relname NOT IN ({excl}))")
hist = ("SELECT encode(sha256(convert_to(string_agg(version || ':' || name || ':' || up_checksum || ':' || down_checksum, E'\\n' ORDER BY version), 'UTF8')), 'hex') "
        "FROM booking_migrations.applied")
active_lock = ("EXISTS (SELECT 1 FROM pg_catalog.pg_locks l WHERE l.locktype = 'advisory' AND l.granted "
               "AND l.database = (SELECT d.oid FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database()) "
               f"AND l.classid = ((pg_catalog.hashtext('{LOCK_KEY}')::bigint + 4294967296) % 4294967296)::oid AND l.objid = 0::oid AND l.objsubid = 2)")
write_locks = ("(SELECT count(*) FROM pg_catalog.pg_locks l JOIN pg_catalog.pg_class c ON c.oid = l.relation JOIN pg_catalog.pg_namespace s ON s.oid = c.relnamespace "
               "WHERE l.locktype = 'relation' AND l.granted AND l.pid <> pg_catalog.pg_backend_pid() AND l.mode <> 'AccessShareLock' "
               "AND l.database = (SELECT d.oid FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database()) AND s.nspname IN ('booking', 'booking_migrations'))")
prepared = "(SELECT count(*) FROM pg_catalog.pg_prepared_xacts)"
kick_pending = "(SELECT count(*) FROM booking.pipeline_kickoff_requests WHERE state IN ('requested', 'claimed', 'dispatch_unknown'))"
indent = lambda s, n: ("\n" + " " * n).join(s.splitlines())
# row-level fingerprints for the separately checked tables
other_claims = "(SELECT count(*) || ':' || md5(coalesce(string_agg(to_jsonb(c)::text, E'\\n' ORDER BY c.id), '')) FROM booking.inventory_claims c WHERE c.intent_id <> v_intent)"
evidence_rows = "(SELECT count(*) || ':' || md5(coalesce(string_agg(to_jsonb(e)::text, E'\\n' ORDER BY e.id), '')) FROM booking.provider_evidence e WHERE e.id <> coalesce(v_ev, '00000000-0000-0000-0000-000000000000'::uuid))"

wrapper = f"""-- e7-c118-c116-record-v1.sql — ONE atomic DO statement for the Supabase SQL editor (schema owner = dashboard `postgres`). C118.
-- PARAMETERIZED reconciliation TEMPLATE for the ONE C116 synthetic TEST booking that a person already cancelled in Hostaway. ROOT substitutes every
-- <<PLACEHOLDER>> token with the private binding (never committed), reviews the bound text, and issues it ONCE. This file is not an owner command.
-- Tokens: {", ".join(tok(p) for p in PLACEHOLDERS)}.
-- PRE (fail-closed; any failure → RAISE → nothing written): every token bound and well-formed; schema-owner role; TEST instance; history exactly
-- 0001-0027 with the accepted POST-27 aggregate; the FULL POST-27 schema identity (claude/e7-0027-inventory.sql verbatim vs claude/e7-0027-pins-v1.json
-- `post`); the recording / evidence functions EXECUTE for mv_booking_admin and NOT for mv_booking_app; quiescence (hosted-run lock, work / intent /
-- operation leases, in-flight operations, unsettled kickoff requests, prepared transactions, other sessions' write locks); NO external-cancellation record
-- anywhere yet; the bound intent: TEST, confirmed, exactly the expected version, the expected Hostaway reservation and listing, USD, captured ==
-- final total == the expected amount; exactly ONE held claim of its own (its own listing and stay); its confirmation SENT: exactly one guest.notify
-- operation, succeeded, attempt 1, dispatched, unleased, ONE gn-v2 render, ONE typed provider receipt, NO latch; the fresh observation time is not in
-- the future, within 24 h, not before the Hostaway cancellation time, and later than every existing observation of that reservation (so the new
-- evidence is the latest).
-- THEN (same transaction): ONE booking.admin_record_evidence (hostaway_reservation, status cancelled, observed at the bound observation time, attested 'owner')
-- and ONE booking.admin_record_external_cancellation citing exactly that evidence, refund 'pending' (no amount, no provider reference).
-- POST (same transaction): the reviewed function reports exactly [sent_preserved] and released exactly its own claim (reason
-- EXTERNAL_CANCELLATION_ATTESTED); exactly one cancellation row and one refund attestation ('pending', no amount); the guest projection is
-- {{"cancelled": true, "refundStatus": "pending"}}; every other booking table (intents, operations, renders, receipts, ledger, transitions, latches,
-- refunds, kickoff requests, ...) row-for-row identical; every OTHER claim identical; every pre-existing evidence row identical plus exactly the one
-- new row; schema identity still POST-27. Any failure rolls back the evidence AND the record together.
-- REPLAY: if THIS booking already carries a record with exactly this request key and evidence time → provable NO-OP (notice
-- E7_C116_ALREADY_RECORDED_NOOP). Any other existing record → E7_C116_EXISTING_RECORD_STOP; never repaired or re-issued blindly. After an UNCERTAIN
-- issuance ROOT runs claude/e7-c118-c116-record-readback-v1.sql (same bindings) FIRST.
-- Never calls a provider, sends, refunds, voids, cancels, deletes, latches or changes a money / ledger / receipt / notification row.
-- Generated by claude/gen-c118-c116-record.py. TIME BOUND: the SET LOCAL statements run BEFORE the DO in the same editor batch.
SET LOCAL statement_timeout = '60s';
SET LOCAL lock_timeout = '5s';
DO $e7c116$
DECLARE
  b_intent    constant text := '{tok("C116_INTENT_ID")}';
  b_version   constant text := '{tok("EXPECTED_VERSION")}';
  b_res       constant text := '{tok("C116_RESERVATION_ID")}';
  b_listing   constant text := '{tok("EXPECTED_LISTING_ID")}';
  b_captured  constant text := '{tok("EXPECTED_CAPTURED_MINOR")}';
  b_cancelled constant text := '{tok("HOSTAWAY_CANCELLED_AT")}';
  b_observed  constant text := '{tok("OBSERVED_AT")}';
  b_key       constant text := '{tok("REQUEST_KEY")}';
  b_ref       constant text := '{tok("SHORT_REF")}';
  c_hist27    constant text  := '{C_HIST27}';
  c_post      constant jsonb := '{c_post}'::jsonb;
  v_intent uuid; v_version int; v_listing int; v_captured bigint; v_cancelled timestamptz; v_observed timestamptz;
  v_ev uuid; v_claim bigint; v_op uuid; v_r jsonb; v_i booking.intents%ROWTYPE; inv jsonb; h text; n bigint; k text; bad text := '';
  t_pre jsonb; claims_pre text; ev_pre text; v_x booking.external_cancellations%ROWTYPE; v_f booking.external_refund_attestations%ROWTYPE;
  v_e booking.provider_evidence%ROWTYPE; latest timestamptz; latches_pre bigint;
BEGIN
  -- ---- bindings: every token bound and well-formed (validated BEFORE any read of booking data) ----
  IF b_intent || b_version || b_res || b_listing || b_captured || b_cancelled || b_observed || b_key || b_ref LIKE '%<<%' THEN RAISE EXCEPTION 'E7_C116_PLACEHOLDER_NOT_BOUND'; END IF;
  IF b_intent !~ '^[0-9a-f]{{8}}-[0-9a-f]{{4}}-[0-9a-f]{{4}}-[0-9a-f]{{4}}-[0-9a-f]{{12}}$' OR b_version !~ '^[1-9][0-9]{{0,6}}$' OR b_res !~ '^[1-9][0-9]{{0,14}}$'
     OR b_listing !~ '^[1-9][0-9]{{0,9}}$' OR b_captured !~ '^[1-9][0-9]{{0,9}}$' OR b_key !~ '^[A-Za-z0-9._:-]{{8,116}}$' OR b_ref !~ '^[A-Za-z0-9._:/#-]{{1,120}}$'
     OR b_cancelled !~ '^\\d{{4}}-\\d{{2}}-\\d{{2}}T\\d{{2}}:\\d{{2}}:\\d{{2}}(\\.\\d{{1,6}})?Z$' OR b_observed !~ '^\\d{{4}}-\\d{{2}}-\\d{{2}}T\\d{{2}}:\\d{{2}}:\\d{{2}}(\\.\\d{{1,6}})?Z$' THEN
    RAISE EXCEPTION 'E7_C116_BINDING_MALFORMED';
  END IF;
  v_intent := b_intent::uuid; v_version := b_version::int; v_listing := b_listing::int; v_captured := b_captured::bigint;
  v_cancelled := b_cancelled::timestamptz; v_observed := b_observed::timestamptz;
  -- ---- role / instance / schema ----
  IF current_user::text <> (SELECT pg_catalog.pg_get_userbyid(nspowner)::text FROM pg_catalog.pg_namespace WHERE nspname = 'booking') THEN RAISE EXCEPTION 'E7_C116_NOT_SCHEMA_OWNER'; END IF;
  SELECT count(*) INTO n FROM booking.instance;
  IF n <> 1 OR (SELECT environment FROM booking.instance) IS DISTINCT FROM 'test' THEN RAISE EXCEPTION 'E7_C116_NOT_TEST'; END IF;
  IF (SELECT count(*) FROM booking_migrations.applied) <> 27 OR (SELECT max(version) FROM booking_migrations.applied) <> 27 OR (SELECT min(version) FROM booking_migrations.applied) <> 1
     OR EXISTS (SELECT 1 FROM booking_migrations.applied WHERE environment IS DISTINCT FROM 'test') THEN RAISE EXCEPTION 'E7_C116_HISTORY_NOT_1_TO_27'; END IF;
  SELECT ({hist}) INTO h;
  IF h IS DISTINCT FROM c_hist27 THEN RAISE EXCEPTION 'E7_C116_HISTORY_DRIFT'; END IF;
  inv := ({indent(inv_body, 9)});
  FOR k IN SELECT jsonb_object_keys(c_post) LOOP
    IF (inv -> k) IS DISTINCT FROM (c_post -> k) THEN bad := bad || k || ','; END IF;
  END LOOP;
  IF bad <> '' THEN RAISE EXCEPTION 'E7_C116_SCHEMA_IDENTITY_DRIFT:%', bad; END IF;                 -- key names only, never values
  IF NOT has_function_privilege('mv_booking_admin', 'booking.admin_record_external_cancellation(uuid,integer,uuid[],uuid,text,bigint,text,text,text,text,text)', 'EXECUTE')
     OR has_function_privilege('mv_booking_app', 'booking.admin_record_external_cancellation(uuid,integer,uuid[],uuid,text,bigint,text,text,text,text,text)', 'EXECUTE')
     OR NOT has_function_privilege('mv_booking_admin', 'booking.admin_record_evidence(uuid,text,text,text,jsonb,timestamptz,text,text)', 'EXECUTE')
     OR has_function_privilege('mv_booking_app', 'booking.admin_record_evidence(uuid,text,text,text,jsonb,timestamptz,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'E7_C116_ADMIN_ACL_UNEXPECTED';
  END IF;
  -- ---- quiescence ----
  IF {active_lock} THEN RAISE EXCEPTION 'E7_C116_ACTIVE_RUN_LOCK_HELD'; END IF;
  IF NOT pg_try_advisory_xact_lock(pg_catalog.hashtext('{LOCK_KEY}'), 0) THEN RAISE EXCEPTION 'E7_C116_ACTIVE_RUN_LOCK_HELD'; END IF;
  IF EXISTS (SELECT 1 FROM booking.intent_work WHERE work_worker_id IS NOT NULL OR work_lease_until IS NOT NULL) THEN RAISE EXCEPTION 'E7_C116_ACTIVE_WORK_LEASE'; END IF;
  IF EXISTS (SELECT 1 FROM booking.intents WHERE lease_worker_id IS NOT NULL OR lease_until IS NOT NULL) THEN RAISE EXCEPTION 'E7_C116_ACTIVE_INTENT_LEASE'; END IF;
  IF EXISTS (SELECT 1 FROM booking.external_operations WHERE lease_worker_id IS NOT NULL OR lease_until IS NOT NULL OR state = 'in_flight') THEN RAISE EXCEPTION 'E7_C116_OPERATION_LEASED_OR_IN_FLIGHT'; END IF;
  IF {kick_pending} <> 0 THEN RAISE EXCEPTION 'E7_C116_KICKOFF_REQUEST_UNSETTLED'; END IF;
  IF {prepared} <> 0 THEN RAISE EXCEPTION 'E7_C116_PREPARED_TRANSACTION_PRESENT'; END IF;
  IF {write_locks} <> 0 THEN RAISE EXCEPTION 'E7_C116_BOOKING_WRITE_LOCK_HELD'; END IF;
  -- ---- replay / existing records ----
  SELECT * INTO v_x FROM booking.external_cancellations WHERE intent_id = v_intent;
  IF FOUND THEN
    SELECT * INTO v_e FROM booking.provider_evidence WHERE id = v_x.cancellation_evidence_id;
    SELECT * INTO v_f FROM booking.external_refund_attestations WHERE cancellation_id = v_x.id AND seq = 1;
    IF v_x.request_key = b_key AND v_e.observed_at = v_observed AND v_e.status = 'cancelled' AND v_e.external_ref = b_res AND v_f.refund_status = 'pending'
       AND (SELECT count(*) FROM booking.external_cancellations) = 1 THEN
      RAISE NOTICE 'E7_C116_ALREADY_RECORDED_NOOP'; RETURN;
    END IF;
    RAISE EXCEPTION 'E7_C116_EXISTING_RECORD_STOP';
  END IF;
  IF EXISTS (SELECT 1 FROM booking.external_cancellations) OR EXISTS (SELECT 1 FROM booking.external_refund_attestations) THEN RAISE EXCEPTION 'E7_C116_EXISTING_RECORD_STOP'; END IF;
  -- ---- the bound booking ----
  SELECT * INTO v_i FROM booking.intents WHERE id = v_intent FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'E7_C116_INTENT_NOT_FOUND'; END IF;
  IF v_i.environment <> 'test' OR v_i.state <> 'confirmed' THEN RAISE EXCEPTION 'E7_C116_INTENT_NOT_CONFIRMED_TEST'; END IF;
  IF v_i.version <> v_version THEN RAISE EXCEPTION 'E7_C116_STALE_VERSION'; END IF;
  IF v_i.hostaway_reservation_id IS DISTINCT FROM b_res OR v_i.listing_id <> v_listing THEN RAISE EXCEPTION 'E7_C116_RESERVATION_BINDING_MISMATCH'; END IF;
  IF v_i.currency IS DISTINCT FROM 'USD' OR v_i.captured_minor <> v_captured OR v_i.final_total_minor IS DISTINCT FROM v_captured THEN RAISE EXCEPTION 'E7_C116_AMOUNT_BINDING_MISMATCH'; END IF;
  SELECT count(*) INTO n FROM booking.inventory_claims WHERE intent_id = v_intent AND released_at IS NULL;
  IF n <> 1 THEN RAISE EXCEPTION 'E7_C116_OWN_CLAIM_NOT_HELD'; END IF;
  SELECT id INTO v_claim FROM booking.inventory_claims WHERE intent_id = v_intent AND released_at IS NULL AND listing_id = v_i.listing_id AND stay = v_i.stay;
  IF v_claim IS NULL THEN RAISE EXCEPTION 'E7_C116_OWN_CLAIM_NOT_HELD'; END IF;
  -- ---- the SENT confirmation ----
  IF (SELECT count(*) FROM booking.external_operations WHERE intent_id = v_intent AND op_type = 'guest.notify') <> 1 THEN RAISE EXCEPTION 'E7_C116_NOTIFY_NOT_SENT'; END IF;
  SELECT id INTO v_op FROM booking.external_operations WHERE intent_id = v_intent AND op_type = 'guest.notify' AND state = 'succeeded' AND attempts = 1
     AND dispatched_at IS NOT NULL AND completed_at IS NOT NULL AND lease_worker_id IS NULL;
  IF v_op IS NULL OR (SELECT count(*) FROM booking.notification_renders WHERE operation_id = v_op AND template_version = 'gn-v2') <> 1
     OR (SELECT count(*) FROM booking.notification_renders WHERE operation_id = v_op) <> 1
     OR (SELECT count(*) FROM booking.notification_provider_receipts WHERE operation_id = v_op) <> 1
     OR EXISTS (SELECT 1 FROM booking.notification_latches WHERE operation_id = v_op) THEN RAISE EXCEPTION 'E7_C116_NOTIFY_NOT_SENT'; END IF;
  -- ---- the fresh observation ----
  SELECT max(observed_at) INTO latest FROM booking.provider_evidence WHERE intent_id = v_intent AND kind = 'hostaway_reservation' AND external_ref = b_res;
  IF v_observed > statement_timestamp() OR v_observed < statement_timestamp() - interval '24 hours' OR v_observed < v_cancelled
     OR v_cancelled > statement_timestamp() OR (latest IS NOT NULL AND v_observed <= latest) THEN
    RAISE EXCEPTION 'E7_C116_OBSERVATION_NOT_FRESH_LATEST';
  END IF;
  -- ---- PRE fingerprints ----
  t_pre := {tblfp};
  claims_pre := {other_claims};
  ev_pre := {evidence_rows};
  latches_pre := (SELECT count(*) FROM booking.notification_latches);
  -- ---- the ONE evidence row and the ONE record (atomic) ----
  v_ev := booking.admin_record_evidence(v_intent, 'hostaway_reservation', b_res, 'cancelled', '{{}}'::jsonb, v_observed, 'owner', b_ref);
  v_r := booking.admin_record_external_cancellation(v_intent, v_version, ARRAY[v_ev], v_ev, 'pending', NULL, NULL, 'owner', b_ref, 'OWNER_CANCELLED_IN_HOSTAWAY', b_key);
  -- ---- POST ----
  IF (v_r ->> 'replayed')::boolean IS DISTINCT FROM false OR (v_r ->> 'releasedClaimId')::bigint IS DISTINCT FROM v_claim
     OR jsonb_array_length(v_r -> 'notify') <> 1 OR (v_r -> 'notify' -> 0 ->> 'disposition') IS DISTINCT FROM 'sent_preserved' OR (v_r -> 'notify' -> 0 ->> 'operationId')::uuid IS DISTINCT FROM v_op THEN
    RAISE EXCEPTION 'E7_C116_RECORD_RESULT_UNEXPECTED';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM booking.inventory_claims WHERE id = v_claim AND released_at IS NOT NULL AND release_reason = 'EXTERNAL_CANCELLATION_ATTESTED')
     OR EXISTS (SELECT 1 FROM booking.inventory_claims WHERE intent_id = v_intent AND released_at IS NULL) THEN RAISE EXCEPTION 'E7_C116_OWN_CLAIM_NOT_RELEASED'; END IF;
  IF {other_claims} IS DISTINCT FROM claims_pre THEN RAISE EXCEPTION 'E7_C116_OTHER_CLAIMS_CHANGED'; END IF;
  IF {evidence_rows} IS DISTINCT FROM ev_pre OR (SELECT count(*) FROM booking.provider_evidence WHERE id = v_ev AND intent_id = v_intent AND kind = 'hostaway_reservation'
     AND external_ref = b_res AND status = 'cancelled' AND observed_at = v_observed AND source = 'hostaway_dashboard') <> 1 THEN RAISE EXCEPTION 'E7_C116_EVIDENCE_UNEXPECTED'; END IF;
  IF (SELECT count(*) FROM booking.external_cancellations) <> 1 OR (SELECT count(*) FROM booking.external_refund_attestations) <> 1
     OR NOT EXISTS (SELECT 1 FROM booking.external_refund_attestations WHERE intent_id = v_intent AND seq = 1 AND refund_status = 'pending' AND refunded_minor IS NULL AND provider_reference IS NULL)
     THEN RAISE EXCEPTION 'E7_C116_RECORD_ROWS_UNEXPECTED'; END IF;
  IF booking.external_cancellation_public(v_intent) IS DISTINCT FROM '{{"cancelled": true, "refundStatus": "pending"}}'::jsonb THEN RAISE EXCEPTION 'E7_C116_PROJECTION_UNEXPECTED'; END IF;
  IF (SELECT count(*) FROM booking.notification_latches) <> latches_pre THEN RAISE EXCEPTION 'E7_C116_LATCH_WRITTEN'; END IF;
  IF {tblfp} IS DISTINCT FROM t_pre THEN RAISE EXCEPTION 'E7_C116_OTHER_ROWS_CHANGED'; END IF;
  IF (({indent(inv_body, 7)}) -> 'functions') IS DISTINCT FROM (c_post -> 'functions') THEN RAISE EXCEPTION 'E7_C116_SCHEMA_CHANGED'; END IF;
  RAISE NOTICE 'E7_C116_RECORDED';
END
$e7c116$;
-- read-only status line (the true state whether or not the DO above succeeded; counts / flags only)
SELECT jsonb_build_object('external_cancellations', (SELECT count(*) FROM booking.external_cancellations),
  'external_refund_attestations', (SELECT count(*) FROM booking.external_refund_attestations),
  'refund_statuses', (SELECT coalesce(jsonb_agg(refund_status ORDER BY seq), '[]'::jsonb) FROM booking.external_refund_attestations),
  'externally_cancelled_latches', (SELECT count(*) FROM booking.notification_latches WHERE code = 'EXTERNALLY_CANCELLED')) AS e7_c116_status;
"""

readback = f"""-- e7-c118-c116-record-readback-v1.sql — PURE READ-ONLY (C118). PARAMETERIZED with the SAME bound tokens as claude/e7-c118-c116-record-v1.sql
-- ({tok("C116_INTENT_ID")}, {tok("C116_RESERVATION_ID")}, {tok("REQUEST_KEY")}). Run BEFORE and AFTER the single issuance (and FIRST after any uncertain one).
-- Writes nothing, takes no lock; returns counts / flags / hashes and the bound booking's own state only (no guest field, no provider id, no credential).
-- Expected BEFORE: schema 27 identity; target confirmed, own_claim_held 1, notify succeeded / 1 / renders 1 / receipts 1 / latch 0; records 0;
--                  latest reservation evidence = an earlier observation (not the fresh one); projection null.
-- Expected AFTER:  same intent row hash and version; own_claim_held 0 (released EXTERNAL_CANCELLATION_ATTESTED); notify unchanged; latch 0; records 1 with the
--                  bound key; refund ['pending']; latest reservation evidence cancelled; projection {{cancelled: true, refundStatus: pending}};
--                  others_fingerprint IDENTICAL to BEFORE.
SELECT jsonb_build_object(
  'bound', ('{tok("C116_INTENT_ID")}' ~ '^[0-9a-f]{{8}}-[0-9a-f]{{4}}-[0-9a-f]{{4}}-[0-9a-f]{{4}}-[0-9a-f]{{12}}$' AND '{tok("C116_RESERVATION_ID")}' ~ '^[1-9][0-9]*$'),
  'schema', jsonb_build_object('max', (SELECT max(version) FROM booking_migrations.applied), 'aggregate_matches_post27', ({hist}) = '{C_HIST27}',
    'functions_matches_post27', (({indent(inv_body, 6)}) -> 'functions') = '"{POST["functions"]}"'::jsonb),
  'instance', (SELECT min(environment) FROM booking.instance),
  'exclusion', jsonb_build_object('hosted_run_lock_held', {active_lock},
    'work_leases', (SELECT count(*) FROM booking.intent_work WHERE work_worker_id IS NOT NULL OR work_lease_until IS NOT NULL),
    'intent_leases', (SELECT count(*) FROM booking.intents WHERE lease_worker_id IS NOT NULL OR lease_until IS NOT NULL),
    'operation_leases_or_in_flight', (SELECT count(*) FROM booking.external_operations WHERE lease_worker_id IS NOT NULL OR lease_until IS NOT NULL OR state = 'in_flight'),
    'kickoff_unsettled', {kick_pending}, 'prepared_transactions', {prepared}, 'other_session_write_locks', {write_locks}),
  'target', (SELECT jsonb_build_object('state', i.state, 'version', i.version, 'reservation_matches', i.hostaway_reservation_id = '{tok("C116_RESERVATION_ID")}',
      'listing_id', i.listing_id, 'currency', i.currency, 'captured_minor', i.captured_minor, 'final_total_minor', i.final_total_minor,
      'intent_row_md5', md5(to_jsonb(i)::text),
      'own_claim_held', (SELECT count(*) FROM booking.inventory_claims c WHERE c.intent_id = i.id AND c.released_at IS NULL),
      'own_claim_release_reasons', (SELECT coalesce(jsonb_agg(c.release_reason ORDER BY c.id), '[]'::jsonb) FROM booking.inventory_claims c WHERE c.intent_id = i.id),
      'notify', (SELECT jsonb_agg(jsonb_build_object('state', o.state, 'attempts', o.attempts, 'renders', (SELECT count(*) FROM booking.notification_renders r WHERE r.operation_id = o.id),
          'receipts', (SELECT count(*) FROM booking.notification_provider_receipts p WHERE p.operation_id = o.id),
          'latches', (SELECT count(*) FROM booking.notification_latches l WHERE l.operation_id = o.id), 'row_md5', md5(to_jsonb(o)::text)))
        FROM booking.external_operations o WHERE o.intent_id = i.id AND o.op_type = 'guest.notify'),
      'history_md5', jsonb_build_object(
        'operations', (SELECT md5(coalesce(string_agg(to_jsonb(o)::text, E'\\n' ORDER BY o.id), '')) FROM booking.external_operations o WHERE o.intent_id = i.id),
        'renders', (SELECT md5(coalesce(string_agg(to_jsonb(r)::text, E'\\n' ORDER BY r.operation_id), '')) FROM booking.notification_renders r WHERE r.intent_id = i.id),
        'receipts', (SELECT md5(coalesce(string_agg(to_jsonb(p)::text, E'\\n' ORDER BY p.operation_id), '')) FROM booking.notification_provider_receipts p WHERE p.intent_id = i.id),
        'ledger', (SELECT md5(coalesce(string_agg(to_jsonb(l)::text, E'\\n' ORDER BY l.id), '')) FROM booking.payment_ledger l WHERE l.intent_id = i.id),
        'transitions', (SELECT md5(coalesce(string_agg(to_jsonb(t)::text, E'\\n' ORDER BY t.version_after), '')) FROM booking.intent_transitions t WHERE t.intent_id = i.id)),
      'latest_reservation_evidence', (SELECT jsonb_build_object('status', e.status, 'source', e.source, 'observed_at', e.observed_at) FROM booking.provider_evidence e
        WHERE e.intent_id = i.id AND e.kind = 'hostaway_reservation' AND e.external_ref = '{tok("C116_RESERVATION_ID")}' ORDER BY e.observed_at DESC, e.created_at DESC, e.id DESC LIMIT 1),
      'record', (SELECT jsonb_build_object('key_matches', x.request_key = '{tok("REQUEST_KEY")}', 'notify_dispositions', (SELECT jsonb_agg(d ->> 'disposition') FROM jsonb_array_elements(x.notify_dispositions) d),
          'released_claim_present', x.released_claim_id IS NOT NULL) FROM booking.external_cancellations x WHERE x.intent_id = i.id),
      'refund_statuses', (SELECT coalesce(jsonb_agg(f.refund_status ORDER BY f.seq), '[]'::jsonb) FROM booking.external_refund_attestations f WHERE f.intent_id = i.id),
      'projection', booking.external_cancellation_public(i.id))
    FROM booking.intents i WHERE i.id::text = '{tok("C116_INTENT_ID")}'),
  'records_total', (SELECT count(*) FROM booking.external_cancellations),
  'externally_cancelled_latches', (SELECT count(*) FROM booking.notification_latches WHERE code = 'EXTERNALLY_CANCELLED'),
  'others_fingerprint', jsonb_build_object(
    'claims_other_intents', (SELECT count(*) || ':' || md5(coalesce(string_agg(to_jsonb(c)::text, E'\\n' ORDER BY c.id), '')) FROM booking.inventory_claims c WHERE c.intent_id::text <> '{tok("C116_INTENT_ID")}'),
    'intents_other', (SELECT count(*) || ':' || md5(coalesce(string_agg(to_jsonb(o)::text, E'\\n' ORDER BY o.id), '')) FROM booking.intents o WHERE o.id::text <> '{tok("C116_INTENT_ID")}'),
    'tables', {tblfp})
) AS e7_c116_readback;
"""

for path, text in (("claude/e7-c118-c116-record-v1.sql", wrapper), ("claude/e7-c118-c116-record-readback-v1.sql", readback)):
    full = os.path.join(ROOT, path)
    if os.path.exists(full) and not WRITE:
        assert open(full, encoding="utf8").read() == text, f"{path} is not byte-identical to the deterministic assembly (re-run with --write)"
    else:
        open(full, "w", encoding="utf8").write(text)
    print(path, "sha256:", sha(text))
for p in PLACEHOLDERS: assert wrapper.count(tok(p)) == 2, p        # once in the header list, once bound
assert not re.search(r"\b\d{8}\b", wrapper.replace(C_HIST27, "").replace(POST["functions"], "").replace("00000000-0000-0000-0000-000000000000", "")), "no concrete reservation-like number in the template"
assert not re.search(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", wrapper.replace("00000000-0000-0000-0000-000000000000", "")), "no concrete uuid in the template"
