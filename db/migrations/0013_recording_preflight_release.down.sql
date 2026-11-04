-- 0013_recording_preflight_release (down) — restores a FRESH 0012 schema exactly. REFUSES while any 0013 audit exists (preflight holds,
-- release decisions, release reviews, non-zero epochs, or a non-NULL value in a column ADDED by 0013); 0012-era audit (epoch-0 preflight
-- assessments and claim audits) is preserved. Every restored body below is copied verbatim from the 0011 / 0012 files (generator).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM booking.recording_holds WHERE reason IN ('PREFLIGHT_CONFLICT_MARKER', 'PREFLIGHT_CONFLICT_LOOKALIKE', 'PREFLIGHT_CONFLICT_SAME_AMOUNT', 'PREFLIGHT_EXHAUSTED') OR epoch <> 0 OR assessment_id IS NOT NULL)
     OR EXISTS (SELECT 1 FROM booking.recording_hold_decisions WHERE decision = 'release_for_initial_send' OR assessment_id IS NOT NULL)
     OR EXISTS (SELECT 1 FROM booking.recording_assessments WHERE phase <> 'preflight' OR epoch <> 0 OR hold_id IS NOT NULL)
     OR EXISTS (SELECT 1 FROM booking.recording_claim_assessments WHERE epoch <> 0)
     OR EXISTS (SELECT 1 FROM booking.reconciliation_cases WHERE starts_with(kind, 'OFFLINE_CHARGE_HOLD_PREFLIGHT_')) THEN
    RAISE EXCEPTION 'DOWNGRADE_REFUSED_RECORDING_PREFLIGHT_RELEASE_AUDIT: preflight holds / releases / reviews / later epochs exist' USING ERRCODE = 'check_violation';
  END IF;
END $$;

-- restore the replaced function bodies first (0011 [lines 93–119, 123–142, 222–246, 254–282], 0012 [170–177, 183–199, 210–218, 326–356,
-- 370–524, 565–576]); they no longer reference anything 0013 adds
CREATE OR REPLACE FUNCTION booking.recording_holds_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, booking AS $$
DECLARE o booking.external_operations%ROWTYPE; d booking.recording_hold_decisions%ROWTYPE;
BEGIN
  IF NOT booking.is_privileged() THEN
    RAISE EXCEPTION 'RECORDING_HOLD_IMMUTABLE: holds are written only by the recording hold functions' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO o FROM booking.external_operations WHERE id = NEW.operation_id;
    IF o.op_type IS DISTINCT FROM 'hostaway.record_offline_charge' OR o.intent_id IS DISTINCT FROM NEW.intent_id THEN
      RAISE EXCEPTION 'RECORDING_HOLD_BINDING: a hold targets a recording of its own intent' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.released_at IS NOT NULL THEN RAISE EXCEPTION 'RECORDING_HOLD_BINDING: a hold is created active' USING ERRCODE = 'check_violation'; END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - 'released_at' - 'release_decision_id') IS DISTINCT FROM (to_jsonb(OLD) - 'released_at' - 'release_decision_id') THEN
    RAISE EXCEPTION 'RECORDING_HOLD_IMMUTABLE: hold identity is frozen' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.released_at IS NOT NULL THEN RAISE EXCEPTION 'RECORDING_HOLD_IMMUTABLE: a released hold is final' USING ERRCODE = 'check_violation'; END IF;
  IF NEW.released_at IS NULL THEN RAISE EXCEPTION 'RECORDING_HOLD_IMMUTABLE: only a release may change a hold' USING ERRCODE = 'check_violation'; END IF;
  SELECT * INTO d FROM booking.recording_hold_decisions WHERE id = NEW.release_decision_id;
  IF NOT FOUND OR d.hold_id IS DISTINCT FROM NEW.id OR d.operation_id IS DISTINCT FROM NEW.operation_id OR d.case_id IS DISTINCT FROM NEW.case_id
     OR d.decision IS DISTINCT FROM 'link_full_proof' THEN
    RAISE EXCEPTION 'RECORDING_HOLD_BINDING: a release cites this hold''s own releasing owner decision' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION booking.recording_hold_decisions_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, booking AS $$
DECLARE h booking.recording_holds%ROWTYPE;
BEGIN
  IF NOT booking.is_privileged() THEN
    RAISE EXCEPTION 'RECORDING_HOLD_IMMUTABLE: owner decisions are written only by booking.admin_resolve_recording_hold' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO h FROM booking.recording_holds WHERE id = NEW.hold_id;
  IF NOT FOUND OR h.operation_id IS DISTINCT FROM NEW.operation_id OR h.case_id IS DISTINCT FROM NEW.case_id OR h.intent_id IS DISTINCT FROM NEW.intent_id THEN
    RAISE EXCEPTION 'RECORDING_HOLD_BINDING: a decision is bound to its hold, operation, case and intent' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.decision = 'link_full_proof' AND h.reason IS DISTINCT FROM 'SUCCEEDED_UNPROVEN' THEN
    RAISE EXCEPTION 'RECORDING_HOLD_BINDING: link_full_proof applies to SUCCEEDED_UNPROVEN holds only' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(NEW.evidence_ids) x
              WHERE NOT EXISTS (SELECT 1 FROM booking.provider_evidence e WHERE e.id = x AND e.intent_id = NEW.intent_id)) THEN
    RAISE EXCEPTION 'RECORDING_HOLD_BINDING: cited evidence must belong to the intent' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION booking.reserved_case_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, booking AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF starts_with(NEW.kind, 'OFFLINE_CHARGE_HOLD_') THEN
      IF NOT booking.is_privileged() THEN
        RAISE EXCEPTION 'RESERVED_CASE_KIND: OFFLINE_CHARGE_HOLD_* cases are opened only by the recording hold functions' USING ERRCODE = 'insufficient_privilege';
      END IF;
      IF NEW.kind NOT IN ('OFFLINE_CHARGE_HOLD_ATTEMPT_GT1', 'OFFLINE_CHARGE_HOLD_SUCCEEDED_UNPROVEN', 'OFFLINE_CHARGE_HOLD_LINKED_CONTRADICTED')
         OR NEW.opened_by IS DISTINCT FROM 'recording-hold:' || NEW.id::text OR NEW.status IS DISTINCT FROM 'open' THEN
        RAISE EXCEPTION 'RESERVED_CASE_BINDING: a hold case is opened open, of a known reason kind, with opened_by recording-hold:<case id>'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF starts_with(OLD.kind, 'OFFLINE_CHARGE_HOLD_') OR starts_with(NEW.kind, 'OFFLINE_CHARGE_HOLD_') THEN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.intent_id IS DISTINCT FROM OLD.intent_id OR NEW.kind IS DISTINCT FROM OLD.kind
       OR NEW.opened_by IS DISTINCT FROM OLD.opened_by OR NEW.opened_at IS DISTINCT FROM OLD.opened_at OR NEW.evidence IS DISTINCT FROM OLD.evidence THEN
      RAISE EXCEPTION 'RESERVED_CASE_IMMUTABLE: a hold case''s identity is frozen' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.status = 'resolved' THEN RAISE EXCEPTION 'RESERVED_CASE_IMMUTABLE: a resolved hold case is final' USING ERRCODE = 'check_violation'; END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION booking.reserved_case_binding_verify(p_case uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
DECLARE c booking.reconciliation_cases%ROWTYPE; n integer; n_active integer;
BEGIN
  SELECT * INTO c FROM booking.reconciliation_cases WHERE id = p_case;
  IF NOT FOUND OR NOT starts_with(c.kind, 'OFFLINE_CHARGE_HOLD_') THEN
    RAISE EXCEPTION 'RESERVED_CASE_BINDING: a hold is bound only to a reserved OFFLINE_CHARGE_HOLD_* case' USING ERRCODE = 'check_violation';
  END IF;
  IF c.opened_by IS DISTINCT FROM 'recording-hold:' || c.id::text THEN
    RAISE EXCEPTION 'RESERVED_CASE_BINDING: opened_by must be recording-hold:<case id>' USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*), count(*) FILTER (WHERE released_at IS NULL) INTO n, n_active FROM booking.recording_holds WHERE case_id = c.id;
  IF n = 0 THEN RAISE EXCEPTION 'RESERVED_CASE_BINDING: a reserved case needs at least one bound hold' USING ERRCODE = 'check_violation'; END IF;
  IF EXISTS (SELECT 1 FROM booking.recording_holds h WHERE h.case_id = c.id
              AND (h.intent_id IS DISTINCT FROM c.intent_id OR 'OFFLINE_CHARGE_HOLD_' || h.reason IS DISTINCT FROM c.kind)) THEN
    RAISE EXCEPTION 'RESERVED_CASE_BINDING: a bound hold must match the case intent and kind' USING ERRCODE = 'check_violation';
  END IF;
  IF (c.status = 'open') IS DISTINCT FROM (n_active > 0) THEN
    RAISE EXCEPTION 'RESERVED_CASE_BINDING: a hold case is open exactly while one of its holds is active' USING ERRCODE = 'check_violation';
  END IF;
  IF c.status = 'resolved' AND c.resolution IS DISTINCT FROM 'recorded' THEN
    RAISE EXCEPTION 'RESERVED_CASE_BINDING: a hold case is resolved only as recorded (link_full_proof)' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM booking.recording_holds h WHERE h.case_id = c.id AND h.released_at IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM booking.recording_hold_decisions d WHERE d.id = h.release_decision_id AND d.hold_id = h.id
                                AND d.case_id = c.id AND d.operation_id = h.operation_id AND d.decision = 'link_full_proof')) THEN
    RAISE EXCEPTION 'RESERVED_CASE_BINDING: every released hold cites its own releasing decision' USING ERRCODE = 'check_violation';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION booking.recording_assessments_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, booking AS $$
BEGIN
  IF NOT booking.is_privileged() THEN
    RAISE EXCEPTION 'ASSESSMENT_IMMUTABLE: assessments are written only by booking.record_recording_assessment' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION booking.recording_claim_assessments_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, booking AS $$
DECLARE a booking.recording_assessments%ROWTYPE; o booking.external_operations%ROWTYPE;
BEGIN
  IF NOT booking.is_privileged() THEN
    RAISE EXCEPTION 'ASSESSMENT_IMMUTABLE: claim audit is written only by the recording claim trigger' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO a FROM booking.recording_assessments WHERE id = NEW.assessment_id;
  SELECT * INTO o FROM booking.external_operations WHERE id = NEW.operation_id;
  IF a.id IS NULL OR o.id IS NULL OR a.operation_id IS DISTINCT FROM NEW.operation_id OR a.intent_id IS DISTINCT FROM NEW.intent_id
     OR o.intent_id IS DISTINCT FROM NEW.intent_id OR a.phase IS DISTINCT FROM 'preflight' OR a.epoch IS DISTINCT FROM NEW.epoch
     OR a.outcome IS DISTINCT FROM 'eligible' OR a.worker IS DISTINCT FROM NEW.worker OR o.lease_worker_id IS DISTINCT FROM NEW.worker
     OR o.state IS DISTINCT FROM 'in_flight' OR o.op_type IS DISTINCT FROM 'hostaway.record_offline_charge' THEN
    RAISE EXCEPTION 'RECORDING_CLAIM_AUDIT_BINDING: claim audit does not bind the eligible assessment and the claimed row' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION booking.recording_preflight_block(p_op uuid) RETURNS text
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM booking.recording_assessments a WHERE a.operation_id = p_op AND a.phase = 'preflight' AND a.epoch = 0
                    AND a.outcome IN ('conflict_marker', 'conflict_lookalike', 'conflict_same_amount')) THEN 'CONFLICT_LATCHED'
    WHEN (SELECT count(*) FROM booking.recording_assessments a WHERE a.operation_id = p_op AND a.phase = 'preflight' AND a.epoch = 0
             AND a.outcome IN ('incomplete', 'identity_refused')) >= 3 THEN 'EXHAUSTED'
  END
$$;

CREATE OR REPLACE FUNCTION booking.recording_claim_refusal(p_op uuid, p_worker text, p_t timestamptz) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
DECLARE o booking.external_operations%ROWTYPE; i booking.intents%ROWTYPE; w booking.intent_work%ROWTYPE; a booking.recording_assessments%ROWTYPE;
        b text; ie timestamptz; le timestamptz;
BEGIN
  IF p_t IS NULL THEN RETURN 'DECISION_TIME_MISSING'; END IF;
  SELECT * INTO o FROM booking.external_operations WHERE id = p_op AND op_type = 'hostaway.record_offline_charge';
  IF o.id IS NULL THEN RETURN 'NOT_A_RECORDING'; END IF;
  SELECT * INTO i FROM booking.intents WHERE id = o.intent_id;
  SELECT * INTO w FROM booking.intent_work WHERE intent_id = o.intent_id;
  b := booking.recording_preflight_block(p_op);
  IF b IS NOT NULL THEN RETURN 'PREFLIGHT_' || b; END IF;
  SELECT * INTO a FROM booking.recording_assessments WHERE operation_id = p_op AND phase = 'preflight' AND epoch = 0 ORDER BY seq DESC LIMIT 1;
  IF a.id IS NULL THEN RETURN 'NO_ASSESSMENT'; END IF;
  IF a.outcome IS DISTINCT FROM 'eligible' THEN RETURN 'LATEST_NOT_ELIGIBLE'; END IF;
  IF a.intent_id IS DISTINCT FROM o.intent_id OR i.id IS NULL OR a.intent_version IS DISTINCT FROM i.version THEN RETURN 'VERSION_CHANGED'; END IF;
  IF a.cfg -> 'listingId' IS DISTINCT FROM to_jsonb(i.listing_id) OR a.cfg -> 'currency' IS DISTINCT FROM to_jsonb(i.currency::text) THEN
    RETURN 'CONFIG_BINDING';
  END IF;
  IF w.intent_id IS NULL OR w.work_worker_id IS NULL OR w.work_lease_until IS NULL OR w.work_worker_id IS DISTINCT FROM a.worker
     OR w.work_lease_until < p_t THEN
    RETURN 'WORK_LEASE';
  END IF;
  IF p_worker IS NOT NULL AND p_worker IS DISTINCT FROM a.worker THEN RETURN 'NOT_ASSESSING_WORKER'; END IF;
  SELECT observed_at INTO ie FROM booking.provider_evidence WHERE id = a.identity_evidence;
  SELECT observed_at INTO le FROM booking.provider_evidence WHERE id = a.list_evidence;
  IF ie IS NULL OR le IS NULL OR ie < p_t - interval '2 minutes' OR ie > p_t OR le < p_t - interval '2 minutes' OR le > p_t THEN
    RETURN 'STALE';
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION booking.record_recording_assessment(p_op uuid, p_worker text, p_outcome text, p_code text, p_identity_read uuid, p_list_read uuid,
  p_identity_evidence uuid, p_list_evidence uuid, p_expected_version integer, p_module_version text, p_client_label text, p_account_ref text,
  p_cfg jsonb) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
DECLARE v_intent uuid; i booking.intents%ROWTYPE; w booking.intent_work%ROWTYPE; o booking.external_operations%ROWTYPE;
        ri booking.external_operations%ROWTYPE; rl booking.external_operations%ROWTYPE; v_rule text; v_t timestamptz; v_floor timestamptz;
        v_block text; v_id uuid := gen_random_uuid(); ei booking.provider_evidence%ROWTYPE; el booking.provider_evidence%ROWTYPE; v_term timestamptz;
BEGIN
  -- inputs (no lock)
  IF p_op IS NULL OR p_worker IS NULL OR length(btrim(p_worker)) NOT BETWEEN 1 AND 200 OR p_outcome IS NULL OR p_identity_read IS NULL
     OR p_expected_version IS NULL OR p_module_version IS NULL OR p_client_label IS NULL OR p_account_ref IS NULL OR p_cfg IS NULL THEN
    RAISE EXCEPTION 'ASSESSMENT_INPUT: required input missing' USING ERRCODE = 'check_violation';
  END IF;
  IF p_module_version IS DISTINCT FROM 'offline-charge-proof-v1' THEN RAISE EXCEPTION 'ASSESSMENT_INPUT: module version' USING ERRCODE = 'check_violation'; END IF;
  IF NOT (p_client_label ~ '^[A-Za-z0-9._:-]{1,64}$' AND p_account_ref ~ '^[A-Za-z0-9._:-]{1,64}$') THEN
    RAISE EXCEPTION 'ASSESSMENT_INPUT: labels' USING ERRCODE = 'check_violation';
  END IF;
  IF p_outcome = 'eligible' THEN
    IF p_code IS NOT NULL THEN RAISE EXCEPTION 'ASSESSMENT_CODE: eligible has no code' USING ERRCODE = 'check_violation'; END IF;
    v_rule := 'eligible';
  ELSE
    SELECT evidence_rule INTO v_rule FROM booking.recording_assessment_codes WHERE outcome = p_outcome AND code = p_code;
    IF v_rule IS NULL THEN RAISE EXCEPTION 'ASSESSMENT_CODE: (%, %) is not a persistable pair', p_outcome, p_code USING ERRCODE = 'check_violation'; END IF;
  END IF;
  -- exact nullability per rule
  IF (v_rule IN ('eligible', 'list_present') AND (p_list_read IS NULL OR p_identity_evidence IS NULL OR p_list_evidence IS NULL))
     OR (v_rule IN ('list_absent_response', 'list_absent_escalated') AND (p_list_read IS NULL OR p_identity_evidence IS NULL OR p_list_evidence IS NOT NULL))
     OR (v_rule IN ('identity_absent', 'identity_absent_escalated') AND (p_list_read IS NOT NULL OR p_identity_evidence IS NOT NULL OR p_list_evidence IS NOT NULL))
     OR (v_rule IN ('identity_absent_or_not_found', 'identity_absent_or_mismatch', 'identity_absent_or_inactive')
         AND (p_list_read IS NOT NULL OR p_list_evidence IS NOT NULL)) THEN
    RAISE EXCEPTION 'ASSESSMENT_INPUT: read / evidence shape does not match (%, %)', p_outcome, p_code USING ERRCODE = 'check_violation';
  END IF;
  -- config snapshot: exactly the pure CONFIG_KEYS, typed and bounded, no default. Written as ONE positive conjunction under coalesce(.., false)
  -- (a NULL anywhere refuses); every cast is guarded by its text check first (CASE), so no input can raise a cast error instead of refusing.
  IF NOT coalesce(jsonb_typeof(p_cfg) = 'object'
     AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_cfg) k) = ARRAY['accountRef', 'channelId', 'currency', 'listingId', 'paymentMethod', 'refFieldId']
     AND jsonb_typeof(p_cfg -> 'accountRef') = 'string' AND p_cfg -> 'accountRef' = to_jsonb(p_account_ref)
     AND jsonb_typeof(p_cfg -> 'channelId') = 'number' AND p_cfg -> 'channelId' = to_jsonb(2000)
     AND jsonb_typeof(p_cfg -> 'currency') = 'string'
     AND jsonb_typeof(p_cfg -> 'listingId') = 'number' AND (p_cfg ->> 'listingId') ~ '^[1-9][0-9]{0,9}$'
     AND jsonb_typeof(p_cfg -> 'paymentMethod') = 'string' AND (p_cfg ->> 'paymentMethod') IN ('credit_card', 'other')
     AND jsonb_typeof(p_cfg -> 'refFieldId') = 'number'
     AND (CASE WHEN (p_cfg ->> 'refFieldId') ~ '^[1-9][0-9]{0,9}$' THEN (p_cfg ->> 'refFieldId')::bigint <= 2147483647 ELSE false END), false) THEN
    RAISE EXCEPTION 'ASSESSMENT_CONFIG: config snapshot keys / types / bounds' USING ERRCODE = 'check_violation';
  END IF;

  SELECT intent_id INTO v_intent FROM booking.external_operations WHERE id = p_op AND op_type = 'hostaway.record_offline_charge';
  IF v_intent IS NULL THEN RAISE EXCEPTION 'ASSESSMENT_TARGET_STATE: not a recording operation' USING ERRCODE = 'check_violation'; END IF;
  SELECT * INTO i FROM booking.intents WHERE id = v_intent FOR SHARE;
  SELECT * INTO w FROM booking.intent_work WHERE intent_id = v_intent FOR SHARE;
  SELECT * INTO o FROM booking.external_operations WHERE id = p_op FOR SHARE;
  SELECT * INTO ri FROM booking.external_operations WHERE id = p_identity_read FOR SHARE;
  IF p_list_read IS NOT NULL THEN SELECT * INTO rl FROM booking.external_operations WHERE id = p_list_read FOR SHARE; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('booking.recording_evidence'), hashtext(v_intent::text));
  v_t := clock_timestamp();                                                                  -- after every potentially blocking lock

  -- target (re-read after the waits: the locked rows above are current; latch / holds / evidence are read fresh below)
  IF o.state IS DISTINCT FROM 'pending' OR o.idempotency_key IS DISTINCT FROM 'och:' || v_intent::text || ':1' OR o.attempts IS DISTINCT FROM 0
     OR o.dispatched_at IS NOT NULL THEN
    RAISE EXCEPTION 'ASSESSMENT_TARGET_STATE: only the pending, never-dispatched initial recording is assessed' USING ERRCODE = 'check_violation';
  END IF;
  IF booking.recording_latest_id(v_intent) IS DISTINCT FROM p_op THEN RAISE EXCEPTION 'ASSESSMENT_TARGET_STATE: not the latest recording' USING ERRCODE = 'check_violation'; END IF;
  IF i.state IS DISTINCT FROM 'payment_captured' OR i.captured_minor IS DISTINCT FROM i.final_total_minor OR i.offline_charge_attempts IS DISTINCT FROM 0
     OR i.hostaway_reservation_id IS NULL THEN
    RAISE EXCEPTION 'ASSESSMENT_TARGET_STATE: intent is not payment_captured with an exact capture and a reservation' USING ERRCODE = 'check_violation';
  END IF;
  IF i.version IS DISTINCT FROM p_expected_version THEN RAISE EXCEPTION 'ASSESSMENT_VERSION_CHANGED' USING ERRCODE = 'check_violation'; END IF;
  IF w.intent_id IS NULL OR w.work_worker_id IS NULL OR w.work_lease_until IS NULL OR w.work_worker_id IS DISTINCT FROM p_worker OR w.work_lease_until < v_t THEN
    RAISE EXCEPTION 'ASSESSMENT_WORK_LEASE_LOST' USING ERRCODE = 'check_violation';
  END IF;
  IF booking.recording_active_hold_id(p_op) IS NOT NULL THEN
    RAISE EXCEPTION 'ASSESSMENT_HOLD_ACTIVE: an owner hold is active on this recording' USING ERRCODE = 'check_violation';
  END IF;
  v_block := booking.recording_preflight_block(p_op);
  IF v_block = 'CONFLICT_LATCHED' THEN RAISE EXCEPTION 'ASSESSMENT_EPOCH_CONFLICTED: a conflict is recorded in the current epoch' USING ERRCODE = 'check_violation'; END IF;
  IF v_block = 'EXHAUSTED' THEN RAISE EXCEPTION 'ASSESSMENT_EPOCH_EXHAUSTED: 3 counted refusals in the current epoch' USING ERRCODE = 'check_violation'; END IF;
  IF p_cfg -> 'listingId' IS DISTINCT FROM to_jsonb(i.listing_id) OR p_cfg -> 'currency' IS DISTINCT FROM to_jsonb(i.currency::text) THEN
    RAISE EXCEPTION 'ASSESSMENT_CONFIG: config listing / currency differ from the intent' USING ERRCODE = 'check_violation';
  END IF;

  -- reads: exact intent, type, canonical payload, terminal state; each counted once ever
  IF ri.id IS NULL OR ri.intent_id IS DISTINCT FROM v_intent OR ri.op_type IS DISTINCT FROM 'hostaway.retrieve_reservation' OR ri.retry_class IS DISTINCT FROM 'read'
     OR ri.payload IS DISTINCT FROM jsonb_build_object('reservationId', i.hostaway_reservation_id)
     OR (p_list_read IS NOT NULL AND (rl.id IS NULL OR rl.intent_id IS DISTINCT FROM v_intent OR rl.op_type IS DISTINCT FROM 'hostaway.list_offline_charges'
         OR rl.retry_class IS DISTINCT FROM 'read' OR rl.payload IS DISTINCT FROM jsonb_build_object('reservationId', i.hostaway_reservation_id))) THEN
    RAISE EXCEPTION 'ASSESSMENT_READ_BINDING: read intent / type / payload' USING ERRCODE = 'check_violation';
  END IF;
  IF ri.state IS DISTINCT FROM (CASE WHEN v_rule = 'identity_absent_escalated' THEN 'escalated' ELSE 'succeeded' END)
     OR (p_list_read IS NOT NULL AND rl.state IS DISTINCT FROM (CASE WHEN v_rule = 'list_absent_escalated' THEN 'escalated' ELSE 'succeeded' END)) THEN
    RAISE EXCEPTION 'ASSESSMENT_READ_BINDING: read terminal state does not match the code' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM booking.recording_assessments a WHERE a.identity_read_op IN (p_identity_read, p_list_read) OR a.list_read_op IN (p_identity_read, p_list_read)) THEN
    RAISE EXCEPTION 'ASSESSMENT_READ_REUSED: a cited read is already counted' USING ERRCODE = 'check_violation';
  END IF;
  -- caller-time floor for every cited read (TRUST: requestRead writes created_at from the caller clock)
  IF NOT (ri.created_at > o.created_at) OR (p_list_read IS NOT NULL AND NOT (rl.created_at > o.created_at)) THEN
    RAISE EXCEPTION 'ASSESSMENT_FLOOR: read requested before the recording existed' USING ERRCODE = 'check_violation';
  END IF;

  -- evidence: exact per-rule presence / absence, positive or re-derived content
  IF p_identity_evidence IS NOT NULL THEN SELECT * INTO ei FROM booking.provider_evidence WHERE id = p_identity_evidence; END IF;
  IF p_list_evidence IS NOT NULL THEN SELECT * INTO el FROM booking.provider_evidence WHERE id = p_list_evidence; END IF;
  IF v_rule IN ('eligible', 'list_present', 'list_absent_response', 'list_absent_escalated') THEN
    IF NOT booking.recording_identity_positive(p_identity_evidence, p_identity_read, v_intent, p_account_ref, p_client_label) THEN
      RAISE EXCEPTION 'ASSESSMENT_EVIDENCE_MISMATCH: identity evidence is not the exact positive observation of the cited read' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF v_rule IN ('eligible', 'list_present') THEN
    IF NOT booking.recording_list_evidence_ok(p_list_evidence, p_list_read, v_intent, p_outcome, p_account_ref, p_client_label) THEN
      RAISE EXCEPTION 'ASSESSMENT_EVIDENCE_MISMATCH: list evidence shape / counts do not match the outcome' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF v_rule IN ('list_absent_response', 'list_absent_escalated')
     AND EXISTS (SELECT 1 FROM booking.provider_evidence WHERE read_operation_id = p_list_read) THEN
    RAISE EXCEPTION 'ASSESSMENT_EVIDENCE_PRESENT: the list read has evidence; it cannot be counted as incomplete' USING ERRCODE = 'check_violation';
  END IF;
  IF v_rule IN ('identity_absent', 'identity_absent_escalated', 'identity_absent_or_not_found', 'identity_absent_or_mismatch', 'identity_absent_or_inactive')
     AND p_identity_evidence IS NULL AND EXISTS (SELECT 1 FROM booking.provider_evidence WHERE read_operation_id = p_identity_read) THEN
    RAISE EXCEPTION 'ASSESSMENT_EVIDENCE_PRESENT: the identity read has evidence that must be cited' USING ERRCODE = 'check_violation';
  END IF;
  IF v_rule IN ('identity_absent_or_not_found', 'identity_absent_or_mismatch', 'identity_absent_or_inactive') AND p_identity_evidence IS NOT NULL
     AND NOT booking.recording_identity_refused_evidence_ok(p_identity_evidence, p_identity_read, v_intent, p_code, v_rule, p_account_ref, p_client_label) THEN
    RAISE EXCEPTION 'ASSESSMENT_EVIDENCE_MISMATCH: identity evidence does not re-derive %', p_code USING ERRCODE = 'check_violation';
  END IF;

  -- freshness at v_t (inclusive, no future): evidence observed_at where evidence exists, else the read's terminal caller time
  IF p_identity_evidence IS NOT NULL THEN
    IF ei.observed_at < v_t - interval '2 minutes' OR ei.observed_at > v_t THEN RAISE EXCEPTION 'ASSESSMENT_STALE: identity' USING ERRCODE = 'check_violation'; END IF;
  ELSE
    v_term := CASE WHEN ri.state = 'escalated' THEN ri.updated_at ELSE ri.completed_at END;
    IF v_term IS NULL OR v_term < v_t - interval '2 minutes' OR v_term > v_t THEN RAISE EXCEPTION 'ASSESSMENT_STALE: identity read' USING ERRCODE = 'check_violation'; END IF;
  END IF;
  IF p_list_read IS NOT NULL THEN
    IF p_list_evidence IS NOT NULL THEN
      IF el.observed_at < v_t - interval '2 minutes' OR el.observed_at > v_t THEN RAISE EXCEPTION 'ASSESSMENT_STALE: list' USING ERRCODE = 'check_violation'; END IF;
    ELSE
      v_term := CASE WHEN rl.state = 'escalated' THEN rl.updated_at ELSE rl.completed_at END;
      IF v_term IS NULL OR v_term < v_t - interval '2 minutes' OR v_term > v_t THEN RAISE EXCEPTION 'ASSESSMENT_STALE: list read' USING ERRCODE = 'check_violation'; END IF;
    END IF;
  END IF;

  -- DB-stamped floors for every cited evidence row: written after the current intent version was recorded AND after the recording row
  SELECT recorded_at INTO v_floor FROM booking.intent_transitions WHERE intent_id = v_intent AND version_after = i.version;
  IF v_floor IS NULL THEN RAISE EXCEPTION 'ASSESSMENT_FLOOR: no transition row for the current version' USING ERRCODE = 'check_violation'; END IF;
  IF (p_identity_evidence IS NOT NULL AND NOT (ei.created_at > v_floor AND ei.created_at > o.created_at))
     OR (p_list_evidence IS NOT NULL AND NOT (el.created_at > v_floor AND el.created_at > o.created_at)) THEN
    RAISE EXCEPTION 'ASSESSMENT_FLOOR: evidence written before the current version / the recording' USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO booking.recording_assessments (id, operation_id, intent_id, phase, epoch, outcome, code, identity_read_op, list_read_op, identity_evidence,
     list_evidence, intent_version, worker, module_version, cfg, client_label, account_ref, recorded_at)
  VALUES (v_id, p_op, v_intent, 'preflight', 0, p_outcome, p_code, p_identity_read, p_list_read, p_identity_evidence, p_list_evidence, i.version, p_worker,
     p_module_version, p_cfg, p_client_label, p_account_ref, v_t);
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION booking.recording_claim_audit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
DECLARE v_t timestamptz; r text; a booking.recording_assessments%ROWTYPE;
BEGIN
  v_t := clock_timestamp();
  r := booking.recording_claim_refusal(NEW.id, NEW.lease_worker_id, v_t);
  IF r IS NOT NULL THEN RAISE EXCEPTION 'RECORDING_CLAIM_FENCED: preflight assessment % (audit)', r USING ERRCODE = 'check_violation'; END IF;
  SELECT * INTO a FROM booking.recording_assessments WHERE operation_id = NEW.id AND phase = 'preflight' AND epoch = 0 ORDER BY seq DESC LIMIT 1;
  INSERT INTO booking.recording_claim_assessments (operation_id, intent_id, assessment_id, worker, epoch, claimed_at)
  VALUES (NEW.id, NEW.intent_id, a.id, NEW.lease_worker_id, a.epoch, v_t);
  RETURN NULL;
END $$;

-- new functions
DROP FUNCTION booking.admin_release_preflight_hold(uuid, uuid, text, text, timestamptz);
DROP FUNCTION booking.open_recording_preflight_hold(uuid, text);
DROP FUNCTION booking.record_release_review_assessment(uuid, text, text, text, uuid, uuid, uuid, uuid, integer, text, text, text, jsonb);
DROP FUNCTION booking.recording_assessment_validate(uuid, text, text, text, uuid, uuid, uuid, uuid, text, text, jsonb, timestamptz, timestamptz);
DROP FUNCTION booking.recording_assessment_input_rule(uuid, text, text, text, uuid, uuid, uuid, uuid, integer, text, text, text, jsonb);
DROP FUNCTION booking.recording_preflight_latch_citation(uuid);
DROP FUNCTION booking.recording_preflight_epoch(uuid);

-- constraints / indexes / columns, restoring the 0011 / 0012 CHECK definitions under their exact names
ALTER TABLE booking.recording_claim_assessments DROP CONSTRAINT recording_claim_assessments_epoch_check;
ALTER TABLE booking.recording_claim_assessments ADD CONSTRAINT recording_claim_assessments_epoch_check CHECK (epoch = 0);
DROP INDEX booking.recording_hold_decisions_one_release;
ALTER TABLE booking.recording_hold_decisions DROP CONSTRAINT recording_hold_decisions_assessment_check;
ALTER TABLE booking.recording_hold_decisions DROP CONSTRAINT recording_hold_decisions_assessment_fk;
ALTER TABLE booking.recording_hold_decisions DROP COLUMN assessment_id;
ALTER TABLE booking.recording_hold_decisions DROP CONSTRAINT recording_hold_decisions_decision_check;
ALTER TABLE booking.recording_hold_decisions ADD CONSTRAINT recording_hold_decisions_decision_check CHECK (decision IN ('keep_visible', 'link_full_proof'));
DROP INDEX booking.recording_holds_one_preflight_per_epoch;
ALTER TABLE booking.recording_holds DROP CONSTRAINT recording_holds_assessment_check;
ALTER TABLE booking.recording_holds DROP CONSTRAINT recording_holds_assessment_fk;
ALTER TABLE booking.recording_holds DROP COLUMN assessment_id;
ALTER TABLE booking.recording_holds DROP CONSTRAINT recording_holds_epoch_check;
ALTER TABLE booking.recording_holds ADD CONSTRAINT recording_holds_epoch_check CHECK (epoch = 0);
ALTER TABLE booking.recording_holds DROP CONSTRAINT recording_holds_reason_check;
ALTER TABLE booking.recording_holds ADD CONSTRAINT recording_holds_reason_check CHECK (reason IN ('ATTEMPT_GT1', 'SUCCEEDED_UNPROVEN', 'LINKED_CONTRADICTED'));
DROP INDEX booking.recording_assessments_hold;
ALTER TABLE booking.recording_assessments DROP CONSTRAINT recording_assessments_epoch_check;
ALTER TABLE booking.recording_assessments ADD CONSTRAINT recording_assessments_epoch_check CHECK (epoch = 0);
ALTER TABLE booking.recording_assessments DROP CONSTRAINT recording_assessments_hold_check;
ALTER TABLE booking.recording_assessments DROP CONSTRAINT recording_assessments_phase_check;
ALTER TABLE booking.recording_assessments ADD CONSTRAINT recording_assessments_phase_check CHECK (phase = 'preflight');
ALTER TABLE booking.recording_assessments DROP CONSTRAINT recording_assessments_hold_fk;
ALTER TABLE booking.recording_assessments DROP COLUMN hold_id;
