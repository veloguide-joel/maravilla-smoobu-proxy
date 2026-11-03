-- 0010_recording_evidence_link (up) — Stage E7.4b-D2 (offline). DISPOSABLE LOCAL test databases only.
-- Contract: claude/e74b-db-evidence-case-contract.md revision 3 + the root implementation addendum (A–D).
-- Scope: hostaway.record_offline_charge ONLY. No table or column change; no other op type's behaviour changes.
--
--   * booking.recording_lifecycle_guard()  INVOKER trigger: recording rows cannot be pre-seeded with proof; result_ref /
--     dispatched_at / completed_at / source_version / late_result_* are set once and then frozen; -> succeeded only inside a
--     schema-owner function (is_privileged) WITH a valid link or an owner resolution; a succeeded row is frozen except one
--     validated NULL -> link exception with every other column unchanged. Validates the prospective NEW row.
--   * booking.recording_proof_refusal()    private VOLATILE validator (fresh snapshot per statement; no clock read).
--   * booking.recording_conflict_refusal() private VOLATILE positive-contradiction check (addendum A).
--   * booking.complete_recording_with_evidence() / booking.link_recording_evidence()  granted to mv_booking_app only.
--   * booking.recording_finalisation_guard() SECURITY DEFINER trigger on intents: payment_captured -> confirmed requires the
--     latest recording succeeded, linked, result_ref = offline_charge_id, and no positive contradiction (checked after the
--     per-intent advisory evidence lock, in a fresh READ COMMITTED snapshot).
--   * record_provider_evidence / admin_record_evidence: the per-intent advisory evidence lock for kind
--     hostaway_offline_charges only (same signatures, same grants; every other kind unchanged).
-- Trust limits (not attested by the database): that a read really ran against Hostaway, that executorAccountRef is the same
-- real account, that paymentMethod is the configured owner choice, and that caller-written times (dispatched_at,
-- read completed_at, lease_until) are real. The database checks bindings and DB-clock consistency only.

-- ---------------------------------------------------------------------------------------------
-- helpers (private)

CREATE FUNCTION booking.recording_attempt_no(p_key text) RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT CASE WHEN p_key ~ '^och:[0-9a-f-]{36}:[1-9][0-9]{0,8}$' THEN split_part(p_key, ':', 3)::integer END
$$;
REVOKE ALL ON FUNCTION booking.recording_attempt_no(text) FROM PUBLIC;

-- deterministic latest recording of an intent: highest attempt number (immutable key), then created_at, then id
CREATE FUNCTION booking.recording_latest_id(p_intent uuid) RETURNS uuid
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
  SELECT id FROM booking.external_operations
   WHERE intent_id = p_intent AND op_type = 'hostaway.record_offline_charge'
   ORDER BY booking.recording_attempt_no(idempotency_key) DESC NULLS LAST, created_at DESC, id DESC LIMIT 1
$$;
REVOKE ALL ON FUNCTION booking.recording_latest_id(uuid) FROM PUBLIC;

-- ---------------------------------------------------------------------------------------------
-- full-identity proof validator. VOLATILE on purpose: every statement takes a fresh READ COMMITTED snapshot, so rows
-- committed while the caller waited on a lock are seen. It reads no clock: the decision instant is an argument.
CREATE FUNCTION booking.recording_proof_refusal(p_intent uuid, p_payload jsonb, p_result_ref text, p_dispatched_at timestamptz,
  p_created_at timestamptz, p_evidence uuid, p_mode text, p_decision_at timestamptz) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
DECLARE e booking.provider_evidence%ROWTYPE; r booking.external_operations%ROWTYPE; i booking.intents%ROWTYPE; o jsonb;
        marker text; keys text[];
BEGIN
  IF p_mode IS NULL OR p_mode NOT IN ('worker_fresh', 'owner_historical') THEN RETURN 'MODE_INVALID'; END IF;
  IF p_decision_at IS NULL THEN RETURN 'DECISION_TIME_REQUIRED'; END IF;
  IF p_evidence IS NULL THEN RETURN 'EVIDENCE_REQUIRED'; END IF;
  IF p_result_ref IS NULL OR p_result_ref !~ '^[1-9][0-9]{0,15}$' OR p_result_ref::numeric > 9007199254740991 THEN RETURN 'RESULT_REF_NOT_CANONICAL'; END IF;
  IF p_dispatched_at IS NULL THEN RETURN 'DISPATCH_TIME_REQUIRED'; END IF;
  IF p_dispatched_at > p_decision_at THEN RETURN 'DISPATCH_IN_FUTURE'; END IF;
  SELECT * INTO i FROM booking.intents WHERE id = p_intent;
  IF NOT FOUND THEN RETURN 'INTENT_NOT_FOUND'; END IF;
  SELECT * INTO e FROM booking.provider_evidence WHERE id = p_evidence;
  IF NOT FOUND THEN RETURN 'EVIDENCE_NOT_FOUND'; END IF;
  IF e.intent_id IS DISTINCT FROM p_intent THEN RETURN 'EVIDENCE_OTHER_INTENT'; END IF;
  IF e.kind IS DISTINCT FROM 'hostaway_offline_charges' OR e.source IS DISTINCT FROM 'hostaway_api' OR e.status IS DISTINCT FROM 'listed' THEN
    RETURN 'EVIDENCE_NOT_API_CHARGE_LIST';
  END IF;
  SELECT * INTO r FROM booking.external_operations WHERE id = e.read_operation_id;
  IF NOT FOUND OR r.intent_id IS DISTINCT FROM p_intent OR r.op_type IS DISTINCT FROM 'hostaway.list_offline_charges'
     OR r.retry_class IS DISTINCT FROM 'read' OR r.state IS DISTINCT FROM 'succeeded' THEN
    RETURN 'EVIDENCE_READ_BINDING';
  END IF;
  IF i.hostaway_reservation_id IS NULL OR (p_payload ->> 'reservationId') IS DISTINCT FROM i.hostaway_reservation_id
     OR (r.payload ->> 'reservationId') IS DISTINCT FROM i.hostaway_reservation_id OR e.external_ref IS DISTINCT FROM i.hostaway_reservation_id THEN
    RETURN 'EVIDENCE_RESERVATION_BINDING';
  END IF;
  IF e.observed_at IS DISTINCT FROM r.completed_at THEN RETURN 'EVIDENCE_TIME_NOT_READ_COMPLETION'; END IF;
  IF r.created_at IS NULL OR p_created_at IS NULL OR r.created_at < p_created_at OR r.dispatched_at IS NULL OR r.dispatched_at < p_dispatched_at THEN
    RETURN 'EVIDENCE_READ_BEFORE_SEND';
  END IF;
  IF NOT (e.observed_at > p_dispatched_at) THEN RETURN 'EVIDENCE_NOT_AFTER_DISPATCH'; END IF;
  IF e.observed_at > p_decision_at THEN RETURN 'EVIDENCE_IN_FUTURE'; END IF;
  IF p_mode = 'worker_fresh' AND e.observed_at < p_decision_at - interval '2 minutes' THEN RETURN 'EVIDENCE_STALE'; END IF;
  IF p_mode = 'owner_historical' AND e.observed_at < p_dispatched_at + interval '15 minutes' THEN RETURN 'EVIDENCE_TOO_EARLY_FOR_HISTORICAL'; END IF;
  -- observed: exact key set, every value typed and bound (no NULL can pass: every test is explicit)
  o := e.observed;
  SELECT array_agg(k ORDER BY k) INTO keys FROM jsonb_object_keys(o) k;
  IF keys IS DISTINCT FROM ARRAY['amountMinor','chargeId','currency','executorAccountRef','listingMapId','marker','matchingChargeCount',
       'matchingChargeIds','paymentMethod','paymentProvider','readCount','reservationId','status','title','type'] THEN
    RETURN 'OBSERVED_KEYS';
  END IF;
  marker := 'mvoch1-' || p_intent::text;
  IF jsonb_typeof(o -> 'matchingChargeCount') IS DISTINCT FROM 'number' OR (o ->> 'matchingChargeCount') IS DISTINCT FROM '1' THEN RETURN 'OBSERVED_COUNT'; END IF;
  IF jsonb_typeof(o -> 'matchingChargeIds') IS DISTINCT FROM 'array' OR jsonb_array_length(o -> 'matchingChargeIds') IS DISTINCT FROM 1
     OR jsonb_typeof(o -> 'matchingChargeIds' -> 0) IS DISTINCT FROM 'string' OR (o -> 'matchingChargeIds' ->> 0) IS DISTINCT FROM p_result_ref THEN
    RETURN 'OBSERVED_IDS';
  END IF;
  IF jsonb_typeof(o -> 'chargeId') IS DISTINCT FROM 'string' OR (o ->> 'chargeId') IS DISTINCT FROM p_result_ref THEN RETURN 'OBSERVED_CHARGE_ID'; END IF;
  IF jsonb_typeof(o -> 'reservationId') IS DISTINCT FROM 'string' OR (o ->> 'reservationId') IS DISTINCT FROM i.hostaway_reservation_id THEN RETURN 'OBSERVED_RESERVATION'; END IF;
  IF jsonb_typeof(o -> 'listingMapId') IS DISTINCT FROM 'number' OR (o ->> 'listingMapId') IS DISTINCT FROM i.listing_id::text THEN RETURN 'OBSERVED_LISTING'; END IF;
  IF jsonb_typeof(o -> 'amountMinor') IS DISTINCT FROM 'number' OR (o ->> 'amountMinor') !~ '^[1-9][0-9]{0,15}$'
     OR (o ->> 'amountMinor') IS DISTINCT FROM (p_payload ->> 'amountMinor')
     OR (o ->> 'amountMinor') IS DISTINCT FROM i.captured_minor::text OR (o ->> 'amountMinor') IS DISTINCT FROM i.final_total_minor::text THEN
    RETURN 'OBSERVED_AMOUNT';
  END IF;
  IF jsonb_typeof(o -> 'currency') IS DISTINCT FROM 'string' OR (o ->> 'currency') IS DISTINCT FROM i.currency::text THEN RETURN 'OBSERVED_CURRENCY'; END IF;
  IF (o ->> 'status') IS DISTINCT FROM 'paid' OR jsonb_typeof(o -> 'status') IS DISTINCT FROM 'string' THEN RETURN 'OBSERVED_STATUS'; END IF;
  IF (o ->> 'type') IS DISTINCT FROM 'charge' OR jsonb_typeof(o -> 'type') IS DISTINCT FROM 'string' THEN RETURN 'OBSERVED_TYPE'; END IF;
  IF (o ->> 'paymentProvider') IS DISTINCT FROM 'offline' OR jsonb_typeof(o -> 'paymentProvider') IS DISTINCT FROM 'string' THEN RETURN 'OBSERVED_PROVIDER'; END IF;
  IF jsonb_typeof(o -> 'paymentMethod') IS DISTINCT FROM 'string' OR (o ->> 'paymentMethod') NOT IN ('credit_card', 'other') THEN RETURN 'OBSERVED_METHOD'; END IF;
  IF jsonb_typeof(o -> 'marker') IS DISTINCT FROM 'string' OR (o ->> 'marker') IS DISTINCT FROM marker THEN RETURN 'OBSERVED_MARKER'; END IF;
  IF jsonb_typeof(o -> 'title') IS DISTINCT FROM 'string' OR (o ->> 'title') IS DISTINCT FROM 'maraVilla payment ' || marker THEN RETURN 'OBSERVED_TITLE'; END IF;
  IF jsonb_typeof(o -> 'readCount') IS DISTINCT FROM 'number' OR (o ->> 'readCount') !~ '^[1-9][0-9]{0,2}$' OR (o ->> 'readCount')::integer > 500 THEN
    RETURN 'OBSERVED_READ_COUNT';
  END IF;
  IF jsonb_typeof(o -> 'executorAccountRef') IS DISTINCT FROM 'string' OR (o ->> 'executorAccountRef') !~ '^[A-Za-z0-9._:-]{1,64}$' THEN
    RETURN 'OBSERVED_ACCOUNT_REF_FORMAT';
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION booking.recording_proof_refusal(uuid, jsonb, text, timestamptz, timestamptz, uuid, text, timestamptz) FROM PUBLIC;

-- ---------------------------------------------------------------------------------------------
-- positive-contradiction check (addendum A; root review of 4242a34 items 2 + 3). An evidence row contradicts the recording only if
-- it is about THE SAME booking and POSITIVELY shows something else:
--   scope: same intent, kind hostaway_offline_charges, external_ref = the intent's Hostaway reservation id (API evidence: the
--     read's selector, bound by record_provider_evidence; dashboard evidence: the owner-supplied reference), observed AFTER the
--     recording was dispatched, and not the reference proof itself;
--   full API shape (has the marker key) for THIS marker: >= 2 matching ids; one id <> result_ref; or any PRESENT full field
--     incompatible with the intent facts, or (paymentMethod / executorAccountRef) with the reference proof's value;
--   count-only shape (no marker key: legacy / dashboard): >= 2 matching ids, or one id <> result_ref (it proves only the id set);
--   matchingChargeCount 0 is absence / provider lag, never a contradiction; a full-shape row for ANOTHER marker is ignored.
-- Trust limit: a different executorAccountRef label is a detectable conflict; equal labels do not prove the same credential.
-- A different paymentMethod is detectable against the stored proof; the DB cannot attest the owner's configured value.
-- p_reference = the proof being linked (completion / link) or the linked proof (finalisation / scan).
-- VOLATILE: called after the advisory evidence lock, so each statement sees rows committed while waiting.
CREATE FUNCTION booking.recording_conflict_refusal(p_intent uuid, p_dispatched_at timestamptz, p_result_ref text, p_reference uuid) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
DECLARE i booking.intents%ROWTYPE; ref_obs jsonb; marker text; n integer;
BEGIN
  IF p_dispatched_at IS NULL OR p_result_ref IS NULL OR p_reference IS NULL THEN RETURN 'CONFLICT_CHECK_INPUT'; END IF;
  SELECT * INTO i FROM booking.intents WHERE id = p_intent;
  SELECT observed INTO ref_obs FROM booking.provider_evidence WHERE id = p_reference AND intent_id = p_intent;
  IF i.id IS NULL OR i.hostaway_reservation_id IS NULL OR ref_obs IS NULL THEN RETURN 'CONFLICT_CHECK_INPUT'; END IF;
  marker := 'mvoch1-' || p_intent::text;
  SELECT count(*) INTO n FROM booking.provider_evidence e
   WHERE e.intent_id = p_intent AND e.kind = 'hostaway_offline_charges' AND e.external_ref = i.hostaway_reservation_id
     AND e.observed_at > p_dispatched_at AND e.id <> p_reference
     AND ((e.observed ->> 'matchingChargeCount')::integer >= 1)
     AND (NOT (e.observed ? 'marker') OR (e.observed ->> 'marker') = marker)
     AND (
          (e.observed ->> 'matchingChargeCount')::integer >= 2
       OR (e.observed -> 'matchingChargeIds' ->> 0) IS DISTINCT FROM p_result_ref
       OR (e.observed ? 'marker' AND (                                                       -- only fields PRESENT are compared
              (e.observed ? 'amountMinor' AND (e.observed ->> 'amountMinor') IS DISTINCT FROM i.final_total_minor::text)
           OR (e.observed ? 'currency' AND (e.observed ->> 'currency') IS DISTINCT FROM i.currency::text)
           OR (e.observed ? 'status' AND (e.observed ->> 'status') IS DISTINCT FROM 'paid')
           OR (e.observed ? 'type' AND (e.observed ->> 'type') IS DISTINCT FROM 'charge')
           OR (e.observed ? 'paymentProvider' AND (e.observed ->> 'paymentProvider') IS DISTINCT FROM 'offline')
           OR (e.observed ? 'title' AND (e.observed ->> 'title') IS DISTINCT FROM 'maraVilla payment ' || marker)
           OR (e.observed ? 'listingMapId' AND (e.observed ->> 'listingMapId') IS DISTINCT FROM i.listing_id::text)
           OR (e.observed ? 'reservationId' AND (e.observed ->> 'reservationId') IS DISTINCT FROM i.hostaway_reservation_id)
           OR (e.observed ? 'chargeId' AND (e.observed ->> 'chargeId') IS DISTINCT FROM p_result_ref)
           OR (e.observed ? 'paymentMethod' AND (e.observed ->> 'paymentMethod') IS DISTINCT FROM (ref_obs ->> 'paymentMethod'))
           OR (e.observed ? 'executorAccountRef' AND (e.observed ->> 'executorAccountRef') IS DISTINCT FROM (ref_obs ->> 'executorAccountRef')))));
  RETURN CASE WHEN n > 0 THEN 'POSITIVE_CONTRADICTION' END;
END $$;
REVOKE ALL ON FUNCTION booking.recording_conflict_refusal(uuid, timestamptz, text, uuid) FROM PUBLIC;

-- ---------------------------------------------------------------------------------------------
-- lifecycle guard: SECURITY INVOKER (is_privileged() then means "inside a schema-owner function"); recording rows only.
CREATE FUNCTION booking.recording_lifecycle_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, booking AS $$
DECLARE r text; t timestamptz;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.settled_evidence_id IS NOT NULL OR NEW.result_ref IS NOT NULL OR NEW.completed_at IS NOT NULL OR NEW.dispatched_at IS NOT NULL
       OR NEW.lease_worker_id IS NOT NULL OR NEW.lease_until IS NOT NULL OR NEW.late_result_status IS NOT NULL OR NEW.late_result_ref IS NOT NULL
       OR NEW.resolution_id IS NOT NULL THEN
      RAISE EXCEPTION 'RECORDING_LIFECYCLE_IMMUTABLE: a recording is created without proof, result, times, lease or resolution'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.idempotency_key IS NULL OR NEW.idempotency_key !~ ('^och:' || NEW.intent_id::text || ':[1-9][0-9]{0,8}$') THEN
      RAISE EXCEPTION 'RECORDING_LIFECYCLE_IMMUTABLE: recording key must be och:<intent>:<n>' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  -- UPDATE
  IF OLD.state = 'succeeded' THEN
    IF (to_jsonb(NEW) - 'updated_at' - 'settled_evidence_id') IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at' - 'settled_evidence_id') THEN
      RAISE EXCEPTION 'RECORDING_LIFECYCLE_IMMUTABLE: a succeeded recording is frozen' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.settled_evidence_id IS NOT DISTINCT FROM OLD.settled_evidence_id THEN RETURN NEW; END IF;
    -- the single exception: NULL -> validated link (0008 refuses clear / repoint afterwards)
    IF OLD.settled_evidence_id IS NOT NULL THEN RETURN NEW; END IF;                       -- 0008 raises SETTLED_EVIDENCE_IMMUTABLE
    IF NOT booking.is_privileged() THEN
      RAISE EXCEPTION 'RECORDING_SUCCESS_REQUIRES_FUNCTION: a link is attached only through booking.link_recording_evidence'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    t := clock_timestamp();
    r := booking.recording_proof_refusal(NEW.intent_id, NEW.payload, NEW.result_ref, NEW.dispatched_at, NEW.created_at, NEW.settled_evidence_id,
                                          'owner_historical', t);
    IF r IS NOT NULL THEN RAISE EXCEPTION 'RECORDING_PROOF_REFUSED: %', r USING ERRCODE = 'check_violation'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.source_version IS DISTINCT FROM OLD.source_version THEN
    RAISE EXCEPTION 'RECORDING_LIFECYCLE_IMMUTABLE: source_version' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.dispatched_at IS DISTINCT FROM OLD.dispatched_at
     AND NOT (OLD.dispatched_at IS NULL AND NEW.dispatched_at IS NOT NULL AND OLD.state = 'pending' AND NEW.state = 'in_flight') THEN
    RAISE EXCEPTION 'RECORDING_LIFECYCLE_IMMUTABLE: dispatched_at' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.completed_at IS DISTINCT FROM OLD.completed_at
     AND NOT (OLD.completed_at IS NULL AND NEW.completed_at IS NOT NULL AND NEW.state IN ('succeeded', 'failed_definite') AND NEW.state <> OLD.state) THEN
    RAISE EXCEPTION 'RECORDING_LIFECYCLE_IMMUTABLE: completed_at' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.result_ref IS DISTINCT FROM OLD.result_ref
     AND NOT (OLD.result_ref IS NULL AND NEW.state IN ('succeeded', 'failed_definite') AND NEW.state <> OLD.state) THEN
    RAISE EXCEPTION 'RECORDING_LIFECYCLE_IMMUTABLE: result_ref' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.late_result_status IS DISTINCT FROM OLD.late_result_status OR NEW.late_result_ref IS DISTINCT FROM OLD.late_result_ref)
     AND NOT (OLD.late_result_status IS NULL AND OLD.late_result_ref IS NULL AND NEW.state IN ('outcome_unknown', 'escalated')) THEN
    RAISE EXCEPTION 'RECORDING_LIFECYCLE_IMMUTABLE: late result is recorded once' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.settled_evidence_id IS NOT NULL AND NEW.state <> 'succeeded' THEN
    RAISE EXCEPTION 'RECORDING_LIFECYCLE_IMMUTABLE: a link is attached only to a succeeded recording' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state = 'succeeded' THEN                                                           -- transition into succeeded
    IF NOT booking.is_privileged() THEN
      RAISE EXCEPTION 'RECORDING_SUCCESS_REQUIRES_FUNCTION: a recording succeeds only through booking.complete_recording_with_evidence'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.settled_evidence_id IS NULL THEN
      IF NEW.resolution_id IS NULL THEN
        RAISE EXCEPTION 'RECORDING_FINALISATION_UNPROVEN: a succeeded recording needs a validated link or an owner resolution'
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;                                                                            -- owner resolution: succeeded-unproven
    END IF;
    IF NEW.completed_at IS NULL OR NEW.completed_at > clock_timestamp() THEN
      RAISE EXCEPTION 'RECORDING_PROOF_REFUSED: COMPLETION_TIME_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    r := booking.recording_proof_refusal(NEW.intent_id, NEW.payload, NEW.result_ref, NEW.dispatched_at, NEW.created_at, NEW.settled_evidence_id,
                                          'worker_fresh', NEW.completed_at);
    IF r IS NOT NULL THEN RAISE EXCEPTION 'RECORDING_PROOF_REFUSED: %', r USING ERRCODE = 'check_violation'; END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION booking.recording_lifecycle_guard() FROM PUBLIC;
-- "zz0_" fires after the existing guards and before 0008's "zz_" immutability trigger (name order)
CREATE TRIGGER zz0_recording_lifecycle_guard BEFORE INSERT OR UPDATE ON booking.external_operations
  FOR EACH ROW WHEN (NEW.op_type = 'hostaway.record_offline_charge') EXECUTE FUNCTION booking.recording_lifecycle_guard();

-- ---------------------------------------------------------------------------------------------
-- worker completion: atomic success + immutable full proof. Locks first, THEN the decision instant (clock_timestamp()).
CREATE FUNCTION booking.complete_recording_with_evidence(p_op uuid, p_worker text, p_evidence uuid, p_result_ref text, p_expected_version integer)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
DECLARE v_intent uuid; i booking.intents%ROWTYPE; w booking.intent_work%ROWTYPE; o booking.external_operations%ROWTYPE; v_t timestamptz; r text;
BEGIN
  SELECT intent_id INTO v_intent FROM booking.external_operations WHERE id = p_op AND op_type = 'hostaway.record_offline_charge';
  IF v_intent IS NULL THEN RAISE EXCEPTION 'RECORDING_STATE: not a recording operation' USING ERRCODE = 'check_violation'; END IF;
  SELECT * INTO i FROM booking.intents WHERE id = v_intent FOR SHARE;
  SELECT * INTO w FROM booking.intent_work WHERE intent_id = v_intent FOR SHARE;
  SELECT * INTO o FROM booking.external_operations WHERE id = p_op FOR UPDATE;
  PERFORM pg_advisory_xact_lock(hashtext('booking.recording_evidence'), hashtext(v_intent::text));
  v_t := clock_timestamp();                                                                  -- after every potentially blocking lock
  IF i.state IS DISTINCT FROM 'payment_captured' THEN RAISE EXCEPTION 'RECORDING_STATE: intent is not payment_captured' USING ERRCODE = 'check_violation'; END IF;
  IF p_expected_version IS NULL OR i.version IS DISTINCT FROM p_expected_version THEN
    RAISE EXCEPTION 'RECORDING_VERSION_CHANGED' USING ERRCODE = 'check_violation';
  END IF;
  IF p_worker IS NULL OR w.work_worker_id IS DISTINCT FROM p_worker OR w.work_lease_until IS NULL OR w.work_lease_until < v_t THEN
    RAISE EXCEPTION 'RECORDING_WORK_LEASE_LOST' USING ERRCODE = 'check_violation';
  END IF;
  IF o.state IS DISTINCT FROM 'in_flight' THEN RAISE EXCEPTION 'RECORDING_STATE: operation is %', o.state USING ERRCODE = 'check_violation'; END IF;
  IF o.lease_worker_id IS DISTINCT FROM p_worker OR o.lease_until IS NULL OR o.lease_until < v_t THEN
    RAISE EXCEPTION 'RECORDING_LEASE_LOST' USING ERRCODE = 'check_violation';
  END IF;
  IF booking.recording_latest_id(v_intent) IS DISTINCT FROM p_op THEN RAISE EXCEPTION 'RECORDING_NOT_LATEST' USING ERRCODE = 'check_violation'; END IF;
  IF o.idempotency_key IS DISTINCT FROM 'och:' || v_intent::text || ':1' OR o.attempts IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'RECORDING_STATE: only the initial attempt completes through this function' USING ERRCODE = 'check_violation';
  END IF;
  r := booking.recording_proof_refusal(v_intent, o.payload, p_result_ref, o.dispatched_at, o.created_at, p_evidence, 'worker_fresh', v_t);
  IF r IS NOT NULL THEN RAISE EXCEPTION 'RECORDING_PROOF_REFUSED: %', r USING ERRCODE = 'check_violation'; END IF;
  r := booking.recording_conflict_refusal(v_intent, o.dispatched_at, p_result_ref, p_evidence);
  IF r IS NOT NULL THEN RAISE EXCEPTION 'RECORDING_EVIDENCE_CONFLICT: %', r USING ERRCODE = 'check_violation'; END IF;
  UPDATE booking.external_operations
     SET state = 'succeeded', result_ref = p_result_ref, settled_evidence_id = p_evidence, completed_at = v_t,
         lease_worker_id = NULL, lease_until = NULL, updated_at = v_t
   WHERE id = p_op;
  RETURN 'succeeded';
END $$;
REVOKE ALL ON FUNCTION booking.complete_recording_with_evidence(uuid, text, uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION booking.complete_recording_with_evidence(uuid, text, uuid, text, integer) TO mv_booking_app;

-- ---------------------------------------------------------------------------------------------
-- link maintenance for a recording ALREADY succeeded without a link (owner-resolved or inherited). Not a send step: no
-- worker / work lease / version argument and none enforced; it can change only settled_evidence_id (NULL -> id).
CREATE FUNCTION booking.link_recording_evidence(p_op uuid, p_evidence uuid) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
DECLARE v_intent uuid; i booking.intents%ROWTYPE; o booking.external_operations%ROWTYPE; v_t timestamptz; r text;
BEGIN
  SELECT intent_id INTO v_intent FROM booking.external_operations WHERE id = p_op AND op_type = 'hostaway.record_offline_charge';
  IF v_intent IS NULL THEN RAISE EXCEPTION 'RECORDING_STATE: not a recording operation' USING ERRCODE = 'check_violation'; END IF;
  SELECT * INTO i FROM booking.intents WHERE id = v_intent FOR SHARE;
  SELECT * INTO o FROM booking.external_operations WHERE id = p_op FOR UPDATE;
  PERFORM pg_advisory_xact_lock(hashtext('booking.recording_evidence'), hashtext(v_intent::text));
  v_t := clock_timestamp();
  IF o.state IS DISTINCT FROM 'succeeded' OR o.result_ref IS NULL THEN
    RAISE EXCEPTION 'RECORDING_STATE: only a succeeded recording with a result can be linked' USING ERRCODE = 'check_violation';
  END IF;
  IF i.state IS NULL OR i.state NOT IN ('payment_captured', 'confirmed') THEN
    RAISE EXCEPTION 'RECORDING_STATE: intent is %', i.state USING ERRCODE = 'check_violation';
  END IF;
  IF booking.recording_latest_id(v_intent) IS DISTINCT FROM p_op THEN RAISE EXCEPTION 'RECORDING_NOT_LATEST' USING ERRCODE = 'check_violation'; END IF;
  IF o.settled_evidence_id IS NOT NULL THEN
    IF o.settled_evidence_id = p_evidence THEN RETURN 'already_linked'; END IF;
    RAISE EXCEPTION 'RECORDING_ALREADY_LINKED_DIFFERENT' USING ERRCODE = 'check_violation';
  END IF;
  r := booking.recording_proof_refusal(v_intent, o.payload, o.result_ref, o.dispatched_at, o.created_at, p_evidence, 'owner_historical', v_t);
  IF r IS NOT NULL THEN RAISE EXCEPTION 'RECORDING_PROOF_REFUSED: %', r USING ERRCODE = 'check_violation'; END IF;
  r := booking.recording_conflict_refusal(v_intent, o.dispatched_at, o.result_ref, p_evidence);
  IF r IS NOT NULL THEN RAISE EXCEPTION 'RECORDING_EVIDENCE_CONFLICT: %', r USING ERRCODE = 'check_violation'; END IF;
  UPDATE booking.external_operations SET settled_evidence_id = p_evidence, updated_at = v_t WHERE id = p_op;
  RETURN 'linked';
END $$;
REVOKE ALL ON FUNCTION booking.link_recording_evidence(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION booking.link_recording_evidence(uuid, uuid) TO mv_booking_app;

-- ---------------------------------------------------------------------------------------------
-- finalisation: payment_captured -> confirmed only with linked full proof and no positive contradiction. SECURITY DEFINER
-- (a validity rule for every writer, like 0007/0009). The conflict SELECT runs as a NEW statement of this VOLATILE function,
-- i.e. in a fresh READ COMMITTED snapshot taken after every wait (the row lock of this UPDATE, then the advisory lock), so
-- evidence committed while waiting is seen. OBSERVED in the 0010 tests (not a general claim): applyEvent's intents UPDATE waited
-- on a concurrent evidence writer's transaction (pg_locks: transactionid / ShareLock), i.e. the writer's row-level lock on the
-- intent; that wait depends on the actual UPDATE lock strength. The advisory lock is therefore kept here as the explicit
-- serialisation; for completion and link it is the observed serialisation (pg_locks: advisory).
CREATE FUNCTION booking.recording_finalisation_guard() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
DECLARE o booking.external_operations%ROWTYPE; r text;
BEGIN
  SELECT * INTO o FROM booking.external_operations WHERE id = booking.recording_latest_id(NEW.id);
  IF NOT FOUND OR o.state IS DISTINCT FROM 'succeeded' OR o.settled_evidence_id IS NULL OR o.result_ref IS NULL
     OR o.result_ref IS DISTINCT FROM NEW.offline_charge_id THEN
    RAISE EXCEPTION 'RECORDING_FINALISATION_UNPROVEN: the latest recording is not succeeded with linked proof for this charge'
      USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('booking.recording_evidence'), hashtext(NEW.id::text));
  r := booking.recording_conflict_refusal(NEW.id, o.dispatched_at, o.result_ref, o.settled_evidence_id);
  IF r IS NOT NULL THEN RAISE EXCEPTION 'RECORDING_EVIDENCE_CONFLICT: %', r USING ERRCODE = 'check_violation'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION booking.recording_finalisation_guard() FROM PUBLIC;
CREATE TRIGGER zz0_intents_recording_finalisation BEFORE UPDATE ON booking.intents
  FOR EACH ROW WHEN (OLD.state = 'payment_captured' AND NEW.state = 'confirmed') EXECUTE FUNCTION booking.recording_finalisation_guard();

-- ---------------------------------------------------------------------------------------------
-- evidence writers: per-intent advisory evidence lock for kind hostaway_offline_charges only. Same signatures => existing
-- grants are kept by CREATE OR REPLACE. Bodies are otherwise identical to 0003.
CREATE OR REPLACE FUNCTION booking.record_provider_evidence(p_read_op uuid, p_kind text, p_external_ref text, p_status text,
  p_observed jsonb, p_provider_request_id text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
DECLARE op booking.external_operations%ROWTYPE; want text; ident text; new_id uuid := gen_random_uuid();
BEGIN
  SELECT * INTO op FROM booking.external_operations WHERE id = p_read_op FOR UPDATE;
  IF NOT FOUND OR op.retry_class <> 'read' OR op.state <> 'succeeded' THEN
    RAISE EXCEPTION 'EVIDENCE_NEEDS_SUCCEEDED_READ' USING ERRCODE = 'check_violation';
  END IF;
  want := CASE p_kind WHEN 'checkout_session' THEN 'stripe.retrieve_checkout_session'
                      WHEN 'payment_intent' THEN 'stripe.retrieve_payment_intent'
                      WHEN 'hostaway_offline_charges' THEN 'hostaway.list_offline_charges'
                      WHEN 'hostaway_reservation' THEN op.op_type END;
  IF want IS NULL OR op.op_type <> want
     OR (p_kind = 'hostaway_reservation' AND op.op_type NOT IN ('hostaway.retrieve_reservation', 'hostaway.lookup_reservation')) THEN
    RAISE EXCEPTION 'EVIDENCE_KIND_DOES_NOT_MATCH_READ' USING ERRCODE = 'check_violation';
  END IF;
  ident := coalesce(op.payload ->> 'sessionId', op.payload ->> 'paymentIntentId', op.payload ->> 'reservationId');
  IF op.op_type = 'hostaway.lookup_reservation' THEN
    IF p_observed ->> 'bookingRef' IS DISTINCT FROM op.payload ->> 'ref' THEN
      RAISE EXCEPTION 'EVIDENCE_REF_MISMATCH' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF ident IS DISTINCT FROM p_external_ref THEN
    RAISE EXCEPTION 'EVIDENCE_REF_MISMATCH' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM booking.validate_evidence(p_kind, p_status, p_observed);
  INSERT INTO booking.provider_evidence (id, intent_id, kind, source, external_ref, status, observed, observed_at, read_operation_id,
     provider_request_id, recorded_by_role, recorded_session_user)
  VALUES (new_id, op.intent_id, p_kind, CASE WHEN p_kind IN ('checkout_session', 'payment_intent') THEN 'stripe_api' ELSE 'hostaway_api' END,
     p_external_ref, p_status, p_observed, op.completed_at, op.id, p_provider_request_id, current_user, session_user);
  -- 0010: AFTER the insert (whose FK already share-locks the intent row), serialise with link / completion. Lock order is then
  -- intent row -> advisory for every party (finalisation: intent row UPDATE -> advisory), so no cycle with finalisation.
  IF p_kind = 'hostaway_offline_charges' THEN
    PERFORM pg_advisory_xact_lock(hashtext('booking.recording_evidence'), hashtext(op.intent_id::text));
  END IF;
  RETURN new_id;
END $$;

CREATE OR REPLACE FUNCTION booking.admin_record_evidence(p_intent uuid, p_kind text, p_external_ref text, p_status text, p_observed jsonb,
  p_observed_at timestamptz, p_attested_by text, p_reference text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
DECLARE new_id uuid := gen_random_uuid();
BEGIN
  PERFORM booking.validate_evidence(p_kind, p_status, p_observed);
  INSERT INTO booking.provider_evidence (id, intent_id, kind, source, external_ref, status, observed, observed_at,
     attested_by, reference, recorded_by_role, recorded_session_user)
  VALUES (new_id, p_intent, p_kind, CASE WHEN p_kind IN ('checkout_session', 'payment_intent') THEN 'stripe_dashboard' ELSE 'hostaway_dashboard' END,
     p_external_ref, p_status, p_observed, p_observed_at, p_attested_by, p_reference, current_user, session_user);
  IF p_kind = 'hostaway_offline_charges' THEN                                                -- 0010: as record_provider_evidence
    PERFORM pg_advisory_xact_lock(hashtext('booking.recording_evidence'), hashtext(p_intent::text));
  END IF;
  RETURN new_id;
END $$;
