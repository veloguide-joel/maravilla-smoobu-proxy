-- 0013_recording_preflight_release (up) — Stage E7.4b-D1 slice B (offline). DISPOSABLE LOCAL test databases only.
-- Preflight HOLDS and the OWNER RELEASE for the initial Hostaway payment recording (claude/e74b-preflight-release-contract.md at 6204619 +
-- root ruling: C1–C5 and binding details A–F). Every actual epoch-0 / phase / latch / hold dependency of 0011 / 0012 (contract §1, E1–E16)
-- is replaced; the down migration restores each replaced body / CHECK verbatim from the 0011 / 0012 files.
--   * current epoch of an op := number of its RELEASED preflight holds (changes only inside admin_release_preflight_hold, under op UPDATE);
--   * normal preflight keeps the active-hold + latch refusals; release_review exists ONLY under the active current-epoch preflight hold,
--     never counts toward exhaustion and never satisfies a claim;
--   * DB-derived opener (no worker / lease / intent state / version requirement); owner release needs the LATEST review (any outcome) to be
--     eligible, version = hold version = review version, both evidence rows fresh at the post-lock DB instant;
--   * lock order everywhere: intent -> [work] -> op -> [reads] -> advisory evidence key -> hold -> case, clock after the final lock.
-- A release never claims, sends or confirms; the next epoch needs a NEW normal preflight with NEW reads / evidence written after the release.

DO $$
BEGIN
  IF to_regclass('booking.recording_assessments') IS NULL THEN
    RAISE EXCEPTION 'MIGRATION_0013_PRECONDITION: 0012 is not applied' USING ERRCODE = 'check_violation';
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------
-- columns / constraints / indexes (E1, E2, E8, E10, E11, E12)
ALTER TABLE booking.recording_assessments ADD COLUMN hold_id uuid;
ALTER TABLE booking.recording_assessments ADD CONSTRAINT recording_assessments_hold_fk FOREIGN KEY (hold_id) REFERENCES booking.recording_holds (id);
ALTER TABLE booking.recording_assessments DROP CONSTRAINT recording_assessments_phase_check;
ALTER TABLE booking.recording_assessments ADD CONSTRAINT recording_assessments_phase_check CHECK (phase IN ('preflight', 'release_review'));
ALTER TABLE booking.recording_assessments ADD CONSTRAINT recording_assessments_hold_check CHECK ((phase = 'release_review') = (hold_id IS NOT NULL));
ALTER TABLE booking.recording_assessments DROP CONSTRAINT recording_assessments_epoch_check;
ALTER TABLE booking.recording_assessments ADD CONSTRAINT recording_assessments_epoch_check CHECK (epoch >= 0);
CREATE INDEX recording_assessments_hold ON booking.recording_assessments (hold_id, seq) WHERE hold_id IS NOT NULL;

ALTER TABLE booking.recording_holds DROP CONSTRAINT recording_holds_reason_check;
ALTER TABLE booking.recording_holds ADD CONSTRAINT recording_holds_reason_check CHECK (reason IN ('ATTEMPT_GT1', 'SUCCEEDED_UNPROVEN', 'LINKED_CONTRADICTED',
  'PREFLIGHT_CONFLICT_MARKER', 'PREFLIGHT_CONFLICT_LOOKALIKE', 'PREFLIGHT_CONFLICT_SAME_AMOUNT', 'PREFLIGHT_EXHAUSTED'));
ALTER TABLE booking.recording_holds DROP CONSTRAINT recording_holds_epoch_check;
ALTER TABLE booking.recording_holds ADD CONSTRAINT recording_holds_epoch_check CHECK (epoch >= 0 AND (reason IN ('PREFLIGHT_CONFLICT_MARKER',
  'PREFLIGHT_CONFLICT_LOOKALIKE', 'PREFLIGHT_CONFLICT_SAME_AMOUNT', 'PREFLIGHT_EXHAUSTED') OR epoch = 0));
ALTER TABLE booking.recording_holds ADD COLUMN assessment_id uuid;
ALTER TABLE booking.recording_holds ADD CONSTRAINT recording_holds_assessment_fk FOREIGN KEY (assessment_id) REFERENCES booking.recording_assessments (id);
ALTER TABLE booking.recording_holds ADD CONSTRAINT recording_holds_assessment_check CHECK ((reason IN ('PREFLIGHT_CONFLICT_MARKER',
  'PREFLIGHT_CONFLICT_LOOKALIKE', 'PREFLIGHT_CONFLICT_SAME_AMOUNT', 'PREFLIGHT_EXHAUSTED')) = (assessment_id IS NOT NULL));
CREATE UNIQUE INDEX recording_holds_one_preflight_per_epoch ON booking.recording_holds (operation_id, epoch)
  WHERE reason IN ('PREFLIGHT_CONFLICT_MARKER', 'PREFLIGHT_CONFLICT_LOOKALIKE', 'PREFLIGHT_CONFLICT_SAME_AMOUNT', 'PREFLIGHT_EXHAUSTED');

ALTER TABLE booking.recording_hold_decisions DROP CONSTRAINT recording_hold_decisions_decision_check;
ALTER TABLE booking.recording_hold_decisions ADD CONSTRAINT recording_hold_decisions_decision_check
  CHECK (decision IN ('keep_visible', 'link_full_proof', 'release_for_initial_send'));
ALTER TABLE booking.recording_hold_decisions ADD COLUMN assessment_id uuid;
ALTER TABLE booking.recording_hold_decisions ADD CONSTRAINT recording_hold_decisions_assessment_fk FOREIGN KEY (assessment_id) REFERENCES booking.recording_assessments (id);
ALTER TABLE booking.recording_hold_decisions ADD CONSTRAINT recording_hold_decisions_assessment_check
  CHECK ((decision = 'release_for_initial_send') = (assessment_id IS NOT NULL));
CREATE UNIQUE INDEX recording_hold_decisions_one_release ON booking.recording_hold_decisions (hold_id)
  WHERE decision IN ('link_full_proof', 'release_for_initial_send');

ALTER TABLE booking.recording_claim_assessments DROP CONSTRAINT recording_claim_assessments_epoch_check;
ALTER TABLE booking.recording_claim_assessments ADD CONSTRAINT recording_claim_assessments_epoch_check CHECK (epoch >= 0);

-- ---------------------------------------------------------------------------------------------
-- epoch + latch citation (private; SECURITY DEFINER; VOLATILE: fresh snapshot per statement; no lock, no clock)
CREATE FUNCTION booking.recording_preflight_epoch(p_op uuid) RETURNS integer
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
  SELECT count(*)::integer FROM booking.recording_holds
   WHERE operation_id = p_op AND released_at IS NOT NULL
     AND reason IN ('PREFLIGHT_CONFLICT_MARKER', 'PREFLIGHT_CONFLICT_LOOKALIKE', 'PREFLIGHT_CONFLICT_SAME_AMOUNT', 'PREFLIGHT_EXHAUSTED')
$$;
REVOKE ALL ON FUNCTION booking.recording_preflight_epoch(uuid) FROM PUBLIC;

-- the latch of the CURRENT epoch and its exact citation: the EARLIEST conflict (precedence, as recording_preflight_block) or the counted
-- refusal of rank 3 by seq. o_reason NULL = no latch.
CREATE FUNCTION booking.recording_preflight_latch_citation(p_op uuid, OUT o_reason text, OUT o_assessment uuid, OUT o_epoch integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
DECLARE a booking.recording_assessments%ROWTYPE;
BEGIN
  o_epoch := booking.recording_preflight_epoch(p_op);
  SELECT * INTO a FROM booking.recording_assessments
   WHERE operation_id = p_op AND phase = 'preflight' AND epoch = o_epoch AND outcome IN ('conflict_marker', 'conflict_lookalike', 'conflict_same_amount')
   ORDER BY seq LIMIT 1;
  IF a.id IS NOT NULL THEN
    o_reason := CASE a.outcome WHEN 'conflict_marker' THEN 'PREFLIGHT_CONFLICT_MARKER' WHEN 'conflict_lookalike' THEN 'PREFLIGHT_CONFLICT_LOOKALIKE'
                               ELSE 'PREFLIGHT_CONFLICT_SAME_AMOUNT' END;
    o_assessment := a.id;
    RETURN;
  END IF;
  SELECT * INTO a FROM booking.recording_assessments
   WHERE operation_id = p_op AND phase = 'preflight' AND epoch = o_epoch AND outcome IN ('incomplete', 'identity_refused')
   ORDER BY seq OFFSET 2 LIMIT 1;
  IF a.id IS NOT NULL THEN o_reason := 'PREFLIGHT_EXHAUSTED'; o_assessment := a.id; END IF;
END $$;
REVOKE ALL ON FUNCTION booking.recording_preflight_latch_citation(uuid) FROM PUBLIC;

-- ---------------------------------------------------------------------------------------------
-- 0012 replacements (E5, E6, E7, E9; down restores the 0012 bodies verbatim)
CREATE OR REPLACE FUNCTION booking.recording_preflight_block(p_op uuid) RETURNS text
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM booking.recording_assessments a WHERE a.operation_id = p_op AND a.phase = 'preflight'
                    AND a.epoch = booking.recording_preflight_epoch(p_op)
                    AND a.outcome IN ('conflict_marker', 'conflict_lookalike', 'conflict_same_amount')) THEN 'CONFLICT_LATCHED'
    WHEN (SELECT count(*) FROM booking.recording_assessments a WHERE a.operation_id = p_op AND a.phase = 'preflight'
             AND a.epoch = booking.recording_preflight_epoch(p_op)
             AND a.outcome IN ('incomplete', 'identity_refused')) >= 3 THEN 'EXHAUSTED'
  END
$$;

CREATE OR REPLACE FUNCTION booking.recording_claim_refusal(p_op uuid, p_worker text, p_t timestamptz) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
DECLARE o booking.external_operations%ROWTYPE; i booking.intents%ROWTYPE; w booking.intent_work%ROWTYPE; a booking.recording_assessments%ROWTYPE;
        b text; ie timestamptz; le timestamptz; v_epoch integer;
BEGIN
  IF p_t IS NULL THEN RETURN 'DECISION_TIME_MISSING'; END IF;
  SELECT * INTO o FROM booking.external_operations WHERE id = p_op AND op_type = 'hostaway.record_offline_charge';
  IF o.id IS NULL THEN RETURN 'NOT_A_RECORDING'; END IF;
  SELECT * INTO i FROM booking.intents WHERE id = o.intent_id;
  SELECT * INTO w FROM booking.intent_work WHERE intent_id = o.intent_id;
  b := booking.recording_preflight_block(p_op);
  IF b IS NOT NULL THEN RETURN 'PREFLIGHT_' || b; END IF;
  v_epoch := booking.recording_preflight_epoch(p_op);                                          -- 0013: the CURRENT epoch only
  SELECT * INTO a FROM booking.recording_assessments WHERE operation_id = p_op AND phase = 'preflight' AND epoch = v_epoch ORDER BY seq DESC LIMIT 1;
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

CREATE OR REPLACE FUNCTION booking.recording_claim_audit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
DECLARE v_t timestamptz; r text; a booking.recording_assessments%ROWTYPE;
BEGIN
  v_t := clock_timestamp();
  r := booking.recording_claim_refusal(NEW.id, NEW.lease_worker_id, v_t);
  IF r IS NOT NULL THEN RAISE EXCEPTION 'RECORDING_CLAIM_FENCED: preflight assessment % (audit)', r USING ERRCODE = 'check_violation'; END IF;
  SELECT * INTO a FROM booking.recording_assessments WHERE operation_id = NEW.id AND phase = 'preflight'
     AND epoch = booking.recording_preflight_epoch(NEW.id) ORDER BY seq DESC LIMIT 1;                 -- 0013: the CURRENT epoch only
  INSERT INTO booking.recording_claim_assessments (operation_id, intent_id, assessment_id, worker, epoch, claimed_at)
  VALUES (NEW.id, NEW.intent_id, a.id, NEW.lease_worker_id, a.epoch, v_t);
  RETURN NULL;
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
     OR NEW.epoch IS DISTINCT FROM booking.recording_preflight_epoch(NEW.operation_id)                              -- 0013: the CURRENT epoch
     OR a.outcome IS DISTINCT FROM 'eligible' OR a.worker IS DISTINCT FROM NEW.worker OR o.lease_worker_id IS DISTINCT FROM NEW.worker
     OR o.state IS DISTINCT FROM 'in_flight' OR o.op_type IS DISTINCT FROM 'hostaway.record_offline_charge' THEN
    RAISE EXCEPTION 'RECORDING_CLAIM_AUDIT_BINDING: claim audit does not bind the eligible assessment and the claimed row' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- assessment rows: privileged INSERT only (0012), plus the phase / hold / epoch binding (defense in depth; the writers check it too)
CREATE OR REPLACE FUNCTION booking.recording_assessments_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, booking AS $$
DECLARE h booking.recording_holds%ROWTYPE;
BEGIN
  IF NOT booking.is_privileged() THEN
    RAISE EXCEPTION 'ASSESSMENT_IMMUTABLE: assessments are written only by booking.record_recording_assessment' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.epoch IS DISTINCT FROM booking.recording_preflight_epoch(NEW.operation_id) THEN
    RAISE EXCEPTION 'ASSESSMENT_BINDING: an assessment belongs to the current epoch of its recording' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.phase = 'release_review' THEN
    SELECT * INTO h FROM booking.recording_holds WHERE id = NEW.hold_id;
    IF h.id IS NULL OR h.released_at IS NOT NULL OR h.operation_id IS DISTINCT FROM NEW.operation_id OR h.intent_id IS DISTINCT FROM NEW.intent_id
       OR h.epoch IS DISTINCT FROM NEW.epoch
       OR h.reason NOT IN ('PREFLIGHT_CONFLICT_MARKER', 'PREFLIGHT_CONFLICT_LOOKALIKE', 'PREFLIGHT_CONFLICT_SAME_AMOUNT', 'PREFLIGHT_EXHAUSTED') THEN
      RAISE EXCEPTION 'ASSESSMENT_BINDING: a release review belongs to the ACTIVE current-epoch preflight hold of its recording' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.hold_id IS NOT NULL THEN
    RAISE EXCEPTION 'ASSESSMENT_BINDING: a preflight assessment cites no hold' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------------------------
-- the PRIVATE shared validator (C4), in two explicit parts so the 0012 refusal order is preserved exactly:
--   recording_assessment_input_rule: the lock-free input / code / nullability / config-shape checks -> the (outcome, code) evidence rule;
--   recording_assessment_validate:   the post-lock content checks (config vs intent, reads, evidence, freshness at p_t, floors).
-- p_extra_floor (NULL in epoch 0) is supplied ONLY by the writers from DB rows (release decision recorded_at / hold created_at); it is
-- never a caller input. Neither part takes a lock, reads a clock or writes anything. Owner only.
CREATE FUNCTION booking.recording_assessment_input_rule(p_op uuid, p_worker text, p_outcome text, p_code text, p_identity_read uuid,
  p_list_read uuid, p_identity_evidence uuid, p_list_evidence uuid, p_expected_version integer, p_module_version text, p_client_label text,
  p_account_ref text, p_cfg jsonb) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
DECLARE v_rule text;
BEGIN
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
  IF (v_rule IN ('eligible', 'list_present') AND (p_list_read IS NULL OR p_identity_evidence IS NULL OR p_list_evidence IS NULL))
     OR (v_rule IN ('list_absent_response', 'list_absent_escalated') AND (p_list_read IS NULL OR p_identity_evidence IS NULL OR p_list_evidence IS NOT NULL))
     OR (v_rule IN ('identity_absent', 'identity_absent_escalated') AND (p_list_read IS NOT NULL OR p_identity_evidence IS NOT NULL OR p_list_evidence IS NOT NULL))
     OR (v_rule IN ('identity_absent_or_not_found', 'identity_absent_or_mismatch', 'identity_absent_or_inactive')
         AND (p_list_read IS NOT NULL OR p_list_evidence IS NOT NULL)) THEN
    RAISE EXCEPTION 'ASSESSMENT_INPUT: read / evidence shape does not match (%, %)', p_outcome, p_code USING ERRCODE = 'check_violation';
  END IF;
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
  RETURN v_rule;
END $$;
REVOKE ALL ON FUNCTION booking.recording_assessment_input_rule(uuid, text, text, text, uuid, uuid, uuid, uuid, integer, text, text, text, jsonb) FROM PUBLIC;

CREATE FUNCTION booking.recording_assessment_validate(p_op uuid, p_rule text, p_outcome text, p_code text, p_identity_read uuid, p_list_read uuid,
  p_identity_evidence uuid, p_list_evidence uuid, p_client_label text, p_account_ref text, p_cfg jsonb, p_t timestamptz, p_extra_floor timestamptz)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
DECLARE v_intent uuid; i booking.intents%ROWTYPE; o booking.external_operations%ROWTYPE; ri booking.external_operations%ROWTYPE;
        rl booking.external_operations%ROWTYPE; ei booking.provider_evidence%ROWTYPE; el booking.provider_evidence%ROWTYPE; v_term timestamptz;
        v_floor timestamptz;
BEGIN
  IF p_t IS NULL OR p_rule IS NULL THEN RAISE EXCEPTION 'ASSESSMENT_INPUT: validator called without a decision instant / rule' USING ERRCODE = 'check_violation'; END IF;
  SELECT * INTO o FROM booking.external_operations WHERE id = p_op;
  v_intent := o.intent_id;
  SELECT * INTO i FROM booking.intents WHERE id = v_intent;
  SELECT * INTO ri FROM booking.external_operations WHERE id = p_identity_read;
  IF p_list_read IS NOT NULL THEN SELECT * INTO rl FROM booking.external_operations WHERE id = p_list_read; END IF;
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
  IF ri.state IS DISTINCT FROM (CASE WHEN p_rule = 'identity_absent_escalated' THEN 'escalated' ELSE 'succeeded' END)
     OR (p_list_read IS NOT NULL AND rl.state IS DISTINCT FROM (CASE WHEN p_rule = 'list_absent_escalated' THEN 'escalated' ELSE 'succeeded' END)) THEN
    RAISE EXCEPTION 'ASSESSMENT_READ_BINDING: read terminal state does not match the code' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM booking.recording_assessments a WHERE a.identity_read_op IN (p_identity_read, p_list_read) OR a.list_read_op IN (p_identity_read, p_list_read)) THEN
    RAISE EXCEPTION 'ASSESSMENT_READ_REUSED: a cited read is already counted' USING ERRCODE = 'check_violation';
  END IF;
  -- caller-time floors for every cited read (TRUST: requestRead writes created_at from the caller clock; recording.created_at is caller-written too)
  IF NOT (ri.created_at > o.created_at) OR (p_list_read IS NOT NULL AND NOT (rl.created_at > o.created_at))
     OR (p_extra_floor IS NOT NULL AND (NOT (ri.created_at > p_extra_floor) OR (p_list_read IS NOT NULL AND NOT (rl.created_at > p_extra_floor)))) THEN
    RAISE EXCEPTION 'ASSESSMENT_FLOOR: read requested before the recording / the hold / the release' USING ERRCODE = 'check_violation';
  END IF;
  -- evidence: exact per-rule presence / absence, positive or re-derived content
  IF p_identity_evidence IS NOT NULL THEN SELECT * INTO ei FROM booking.provider_evidence WHERE id = p_identity_evidence; END IF;
  IF p_list_evidence IS NOT NULL THEN SELECT * INTO el FROM booking.provider_evidence WHERE id = p_list_evidence; END IF;
  IF p_rule IN ('eligible', 'list_present', 'list_absent_response', 'list_absent_escalated') THEN
    IF NOT booking.recording_identity_positive(p_identity_evidence, p_identity_read, v_intent, p_account_ref, p_client_label) THEN
      RAISE EXCEPTION 'ASSESSMENT_EVIDENCE_MISMATCH: identity evidence is not the exact positive observation of the cited read' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF p_rule IN ('eligible', 'list_present') THEN
    IF NOT booking.recording_list_evidence_ok(p_list_evidence, p_list_read, v_intent, p_outcome, p_account_ref, p_client_label) THEN
      RAISE EXCEPTION 'ASSESSMENT_EVIDENCE_MISMATCH: list evidence shape / counts do not match the outcome' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF p_rule IN ('list_absent_response', 'list_absent_escalated')
     AND EXISTS (SELECT 1 FROM booking.provider_evidence WHERE read_operation_id = p_list_read) THEN
    RAISE EXCEPTION 'ASSESSMENT_EVIDENCE_PRESENT: the list read has evidence; it cannot be counted as incomplete' USING ERRCODE = 'check_violation';
  END IF;
  IF p_rule IN ('identity_absent', 'identity_absent_escalated', 'identity_absent_or_not_found', 'identity_absent_or_mismatch', 'identity_absent_or_inactive')
     AND p_identity_evidence IS NULL AND EXISTS (SELECT 1 FROM booking.provider_evidence WHERE read_operation_id = p_identity_read) THEN
    RAISE EXCEPTION 'ASSESSMENT_EVIDENCE_PRESENT: the identity read has evidence that must be cited' USING ERRCODE = 'check_violation';
  END IF;
  IF p_rule IN ('identity_absent_or_not_found', 'identity_absent_or_mismatch', 'identity_absent_or_inactive') AND p_identity_evidence IS NOT NULL
     AND NOT booking.recording_identity_refused_evidence_ok(p_identity_evidence, p_identity_read, v_intent, p_code, p_rule, p_account_ref, p_client_label) THEN
    RAISE EXCEPTION 'ASSESSMENT_EVIDENCE_MISMATCH: identity evidence does not re-derive %', p_code USING ERRCODE = 'check_violation';
  END IF;
  -- freshness at p_t (inclusive, no future): evidence observed_at where evidence exists, else the read's terminal caller time
  IF p_identity_evidence IS NOT NULL THEN
    IF ei.observed_at < p_t - interval '2 minutes' OR ei.observed_at > p_t THEN RAISE EXCEPTION 'ASSESSMENT_STALE: identity' USING ERRCODE = 'check_violation'; END IF;
  ELSE
    v_term := CASE WHEN ri.state = 'escalated' THEN ri.updated_at ELSE ri.completed_at END;
    IF v_term IS NULL OR v_term < p_t - interval '2 minutes' OR v_term > p_t THEN RAISE EXCEPTION 'ASSESSMENT_STALE: identity read' USING ERRCODE = 'check_violation'; END IF;
  END IF;
  IF p_list_read IS NOT NULL THEN
    IF p_list_evidence IS NOT NULL THEN
      IF el.observed_at < p_t - interval '2 minutes' OR el.observed_at > p_t THEN RAISE EXCEPTION 'ASSESSMENT_STALE: list' USING ERRCODE = 'check_violation'; END IF;
    ELSE
      v_term := CASE WHEN rl.state = 'escalated' THEN rl.updated_at ELSE rl.completed_at END;
      IF v_term IS NULL OR v_term < p_t - interval '2 minutes' OR v_term > p_t THEN RAISE EXCEPTION 'ASSESSMENT_STALE: list read' USING ERRCODE = 'check_violation'; END IF;
    END IF;
  END IF;
  -- floors for every cited evidence row: after the current version's DB-stamped transition, after the (caller-written) recording row, and in a
  -- later epoch / a review after the DB-stamped release decision / hold (p_extra_floor)
  SELECT recorded_at INTO v_floor FROM booking.intent_transitions WHERE intent_id = v_intent AND version_after = i.version;
  IF v_floor IS NULL THEN RAISE EXCEPTION 'ASSESSMENT_FLOOR: no transition row for the current version' USING ERRCODE = 'check_violation'; END IF;
  IF (p_identity_evidence IS NOT NULL AND NOT (ei.created_at > v_floor AND ei.created_at > o.created_at
                                               AND (p_extra_floor IS NULL OR ei.created_at > p_extra_floor)))
     OR (p_list_evidence IS NOT NULL AND NOT (el.created_at > v_floor AND el.created_at > o.created_at
                                              AND (p_extra_floor IS NULL OR el.created_at > p_extra_floor))) THEN
    RAISE EXCEPTION 'ASSESSMENT_FLOOR: evidence written before the current version / the recording / the hold / the release' USING ERRCODE = 'check_violation';
  END IF;
END $$;
REVOKE ALL ON FUNCTION booking.recording_assessment_validate(uuid, text, text, text, uuid, uuid, uuid, uuid, text, text, jsonb, timestamptz, timestamptz) FROM PUBLIC;

-- ---------------------------------------------------------------------------------------------
-- normal preflight writer (E3, E4): same signature / grant; current epoch; active-hold + latch refusals kept; release floor in a later epoch.
-- Lock order: intent SHARE -> intent_work SHARE -> recording op SHARE -> cited reads SHARE -> advisory, THEN v_t.
CREATE OR REPLACE FUNCTION booking.record_recording_assessment(p_op uuid, p_worker text, p_outcome text, p_code text, p_identity_read uuid, p_list_read uuid,
  p_identity_evidence uuid, p_list_evidence uuid, p_expected_version integer, p_module_version text, p_client_label text, p_account_ref text,
  p_cfg jsonb) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
DECLARE v_intent uuid; i booking.intents%ROWTYPE; w booking.intent_work%ROWTYPE; o booking.external_operations%ROWTYPE; v_rule text; v_t timestamptz;
        v_block text; v_id uuid := gen_random_uuid(); v_epoch integer; v_release timestamptz;
BEGIN
  v_rule := booking.recording_assessment_input_rule(p_op, p_worker, p_outcome, p_code, p_identity_read, p_list_read, p_identity_evidence, p_list_evidence,
    p_expected_version, p_module_version, p_client_label, p_account_ref, p_cfg);
  SELECT intent_id INTO v_intent FROM booking.external_operations WHERE id = p_op AND op_type = 'hostaway.record_offline_charge';
  IF v_intent IS NULL THEN RAISE EXCEPTION 'ASSESSMENT_TARGET_STATE: not a recording operation' USING ERRCODE = 'check_violation'; END IF;
  SELECT * INTO i FROM booking.intents WHERE id = v_intent FOR SHARE;
  SELECT * INTO w FROM booking.intent_work WHERE intent_id = v_intent FOR SHARE;
  SELECT * INTO o FROM booking.external_operations WHERE id = p_op FOR SHARE;
  PERFORM 1 FROM booking.external_operations WHERE id = p_identity_read FOR SHARE;
  IF p_list_read IS NOT NULL THEN PERFORM 1 FROM booking.external_operations WHERE id = p_list_read FOR SHARE; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('booking.recording_evidence'), hashtext(v_intent::text));
  v_t := clock_timestamp();                                                                  -- after every potentially blocking lock
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
  v_epoch := booking.recording_preflight_epoch(p_op);                                        -- stable: a release needs the op row FOR UPDATE
  IF v_epoch > 0 THEN                                                                        -- DB-stamped instant of the release that opened this epoch
    SELECT d.recorded_at INTO v_release FROM booking.recording_holds h JOIN booking.recording_hold_decisions d ON d.id = h.release_decision_id
     WHERE h.operation_id = p_op AND h.epoch = v_epoch - 1 AND d.decision = 'release_for_initial_send'
       AND h.reason IN ('PREFLIGHT_CONFLICT_MARKER', 'PREFLIGHT_CONFLICT_LOOKALIKE', 'PREFLIGHT_CONFLICT_SAME_AMOUNT', 'PREFLIGHT_EXHAUSTED');
    IF v_release IS NULL THEN RAISE EXCEPTION 'ASSESSMENT_FLOOR: the release that opened this epoch is missing' USING ERRCODE = 'check_violation'; END IF;
  END IF;
  PERFORM booking.recording_assessment_validate(p_op, v_rule, p_outcome, p_code, p_identity_read, p_list_read, p_identity_evidence, p_list_evidence,
    p_client_label, p_account_ref, p_cfg, v_t, v_release);
  INSERT INTO booking.recording_assessments (id, operation_id, intent_id, phase, epoch, outcome, code, identity_read_op, list_read_op, identity_evidence,
     list_evidence, intent_version, worker, module_version, cfg, client_label, account_ref, recorded_at)
  VALUES (v_id, p_op, v_intent, 'preflight', v_epoch, p_outcome, p_code, p_identity_read, p_list_read, p_identity_evidence, p_list_evidence, i.version,
     p_worker, p_module_version, p_cfg, p_client_label, p_account_ref, v_t);
  RETURN v_id;
END $$;

-- ---------------------------------------------------------------------------------------------
-- release review writer: ONLY under the ACTIVE current-epoch preflight hold of the op; never counts, never satisfies a claim.
-- Lock order: intent SHARE -> intent_work SHARE -> op SHARE -> cited reads SHARE -> advisory -> hold SHARE, THEN v_t.
CREATE FUNCTION booking.record_release_review_assessment(p_hold uuid, p_worker text, p_outcome text, p_code text, p_identity_read uuid, p_list_read uuid,
  p_identity_evidence uuid, p_list_evidence uuid, p_expected_version integer, p_module_version text, p_client_label text, p_account_ref text,
  p_cfg jsonb) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
DECLARE h0 booking.recording_holds%ROWTYPE; h booking.recording_holds%ROWTYPE; i booking.intents%ROWTYPE; w booking.intent_work%ROWTYPE;
        o booking.external_operations%ROWTYPE; v_rule text; v_t timestamptz; v_id uuid := gen_random_uuid();
BEGIN
  IF p_hold IS NULL THEN RAISE EXCEPTION 'ASSESSMENT_INPUT: hold required' USING ERRCODE = 'check_violation'; END IF;
  SELECT * INTO h0 FROM booking.recording_holds WHERE id = p_hold;
  IF h0.id IS NULL THEN RAISE EXCEPTION 'HOLD_NOT_FOUND' USING ERRCODE = 'check_violation'; END IF;
  v_rule := booking.recording_assessment_input_rule(h0.operation_id, p_worker, p_outcome, p_code, p_identity_read, p_list_read, p_identity_evidence,
    p_list_evidence, p_expected_version, p_module_version, p_client_label, p_account_ref, p_cfg);
  SELECT * INTO i FROM booking.intents WHERE id = h0.intent_id FOR SHARE;
  SELECT * INTO w FROM booking.intent_work WHERE intent_id = h0.intent_id FOR SHARE;
  SELECT * INTO o FROM booking.external_operations WHERE id = h0.operation_id FOR SHARE;
  PERFORM 1 FROM booking.external_operations WHERE id = p_identity_read FOR SHARE;
  IF p_list_read IS NOT NULL THEN PERFORM 1 FROM booking.external_operations WHERE id = p_list_read FOR SHARE; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('booking.recording_evidence'), hashtext(h0.intent_id::text));
  SELECT * INTO h FROM booking.recording_holds WHERE id = p_hold FOR SHARE;
  v_t := clock_timestamp();                                                                  -- after every potentially blocking lock
  IF h.reason NOT IN ('PREFLIGHT_CONFLICT_MARKER', 'PREFLIGHT_CONFLICT_LOOKALIKE', 'PREFLIGHT_CONFLICT_SAME_AMOUNT', 'PREFLIGHT_EXHAUSTED') THEN
    RAISE EXCEPTION 'HOLD_DECISION_NOT_ALLOWED: release reviews exist only for preflight holds' USING ERRCODE = 'check_violation';
  END IF;
  IF h.released_at IS NOT NULL THEN RAISE EXCEPTION 'HOLD_NOT_ACTIVE: hold % was released at %', h.id, h.released_at USING ERRCODE = 'check_violation'; END IF;
  IF h.epoch IS DISTINCT FROM booking.recording_preflight_epoch(h.operation_id) THEN
    RAISE EXCEPTION 'HOLD_STATE_UNEXPECTED: hold epoch is not the current epoch' USING ERRCODE = 'check_violation';
  END IF;
  IF o.state IS DISTINCT FROM 'pending' OR o.idempotency_key IS DISTINCT FROM 'och:' || h.intent_id::text || ':1' OR o.attempts IS DISTINCT FROM 0
     OR o.dispatched_at IS NOT NULL THEN
    RAISE EXCEPTION 'HOLD_TARGET_STATE: the held recording is not the pending, never-dispatched initial attempt' USING ERRCODE = 'check_violation';
  END IF;
  IF booking.recording_latest_id(h.intent_id) IS DISTINCT FROM o.id THEN RAISE EXCEPTION 'HOLD_TARGET_NOT_LATEST' USING ERRCODE = 'check_violation'; END IF;
  IF i.state IS DISTINCT FROM 'payment_captured' OR i.captured_minor IS DISTINCT FROM i.final_total_minor OR i.offline_charge_attempts IS DISTINCT FROM 0
     OR i.hostaway_reservation_id IS NULL THEN
    RAISE EXCEPTION 'ASSESSMENT_TARGET_STATE: intent is not payment_captured with an exact capture and a reservation' USING ERRCODE = 'check_violation';
  END IF;
  IF i.version IS DISTINCT FROM p_expected_version OR i.version IS DISTINCT FROM h.intent_version_at_hold THEN
    RAISE EXCEPTION 'ASSESSMENT_VERSION_CHANGED' USING ERRCODE = 'check_violation';
  END IF;
  IF w.intent_id IS NULL OR w.work_worker_id IS NULL OR w.work_lease_until IS NULL OR w.work_worker_id IS DISTINCT FROM p_worker OR w.work_lease_until < v_t THEN
    RAISE EXCEPTION 'ASSESSMENT_WORK_LEASE_LOST' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM booking.recording_assessment_validate(o.id, v_rule, p_outcome, p_code, p_identity_read, p_list_read, p_identity_evidence, p_list_evidence,
    p_client_label, p_account_ref, p_cfg, v_t, h.created_at);                                -- hold floor: proof written after the hold
  INSERT INTO booking.recording_assessments (id, operation_id, intent_id, phase, epoch, outcome, code, identity_read_op, list_read_op, identity_evidence,
     list_evidence, intent_version, worker, module_version, cfg, client_label, account_ref, recorded_at, hold_id)
  VALUES (v_id, o.id, h.intent_id, 'release_review', h.epoch, p_outcome, p_code, p_identity_read, p_list_read, p_identity_evidence, p_list_evidence, i.version,
     p_worker, p_module_version, p_cfg, p_client_label, p_account_ref, v_t, h.id);
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION booking.record_release_review_assessment(uuid, text, text, text, uuid, uuid, uuid, uuid, integer, text, text, text, jsonb) FROM PUBLIC;

-- ---------------------------------------------------------------------------------------------
-- DB-derived preflight hold opener (C1): no worker / lease / intent-state / version requirement; ALWAYS the latest pending never-claimed initial
-- recording, its current-epoch latch and its exact citation. p_by is a provenance label (TRUST).
-- Lock order: intent SHARE -> op UPDATE -> advisory -> active hold UPDATE -> open same-kind case UPDATE, THEN v_t.
CREATE FUNCTION booking.open_recording_preflight_hold(p_op uuid, p_by text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
DECLARE v_intent uuid; i booking.intents%ROWTYPE; o booking.external_operations%ROWTYPE; h booking.recording_holds%ROWTYPE;
        c booking.reconciliation_cases%ROWTYPE; cit record; v_t timestamptz; v_kind text; v_hold uuid := gen_random_uuid(); v_case uuid := gen_random_uuid();
BEGIN
  IF p_by IS NULL OR length(btrim(p_by)) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'HOLD_BY_INVALID' USING ERRCODE = 'check_violation'; END IF;
  SELECT intent_id INTO v_intent FROM booking.external_operations WHERE id = p_op AND op_type = 'hostaway.record_offline_charge';
  IF v_intent IS NULL THEN RAISE EXCEPTION 'HOLD_TARGET_STATE: not a recording operation' USING ERRCODE = 'check_violation'; END IF;
  SELECT * INTO i FROM booking.intents WHERE id = v_intent FOR SHARE;
  SELECT * INTO o FROM booking.external_operations WHERE id = p_op FOR UPDATE;
  PERFORM pg_advisory_xact_lock(hashtext('booking.recording_evidence'), hashtext(v_intent::text));
  SELECT * INTO h FROM booking.recording_holds WHERE operation_id = p_op AND released_at IS NULL FOR UPDATE;
  cit := booking.recording_preflight_latch_citation(p_op);
  v_kind := 'OFFLINE_CHARGE_HOLD_' || cit.o_reason;
  IF cit.o_reason IS NOT NULL THEN
    SELECT * INTO c FROM booking.reconciliation_cases WHERE intent_id = v_intent AND kind = v_kind AND status = 'open' FOR UPDATE;
  END IF;
  v_t := clock_timestamp();                                                                  -- after every potentially blocking lock
  IF o.state IS DISTINCT FROM 'pending' OR o.idempotency_key IS DISTINCT FROM 'och:' || v_intent::text || ':1' OR o.attempts IS DISTINCT FROM 0
     OR o.dispatched_at IS NOT NULL THEN
    RAISE EXCEPTION 'HOLD_TARGET_STATE: a preflight hold targets the pending, never-dispatched initial recording' USING ERRCODE = 'check_violation';
  END IF;
  IF booking.recording_latest_id(v_intent) IS DISTINCT FROM p_op THEN RAISE EXCEPTION 'HOLD_TARGET_NOT_LATEST' USING ERRCODE = 'check_violation'; END IF;
  IF cit.o_reason IS NULL THEN RAISE EXCEPTION 'HOLD_TARGET_STATE: no preflight latch in the current epoch' USING ERRCODE = 'check_violation'; END IF;
  IF h.id IS NOT NULL THEN
    IF h.reason = cit.o_reason AND h.epoch = cit.o_epoch AND h.assessment_id = cit.o_assessment THEN RETURN h.id; END IF;   -- idempotent: no write
    RAISE EXCEPTION 'HOLD_ALREADY_ACTIVE: % hold % is active on this recording', h.reason, h.id USING ERRCODE = 'check_violation';
  END IF;
  IF c.id IS NULL THEN
    INSERT INTO booking.reconciliation_cases (id, intent_id, kind, status, opened_at, opened_by, evidence)
    VALUES (v_case, v_intent, v_kind, 'open', v_t, 'recording-hold:' || v_case::text,
            jsonb_build_object('operationId', p_op, 'reason', cit.o_reason, 'assessmentId', cit.o_assessment, 'epoch', cit.o_epoch, 'intentVersion', i.version));
  ELSE
    v_case := c.id;
  END IF;
  INSERT INTO booking.recording_holds (id, operation_id, intent_id, reason, case_id, op_state_at_hold, op_key_at_hold, intent_state_at_hold,
     intent_version_at_hold, epoch, created_at, created_by, assessment_id)
  VALUES (v_hold, p_op, v_intent, cit.o_reason, v_case, o.state, o.idempotency_key, i.state, i.version, cit.o_epoch, v_t, p_by, cit.o_assessment);
  RETURN v_hold;
END $$;
REVOKE ALL ON FUNCTION booking.open_recording_preflight_hold(uuid, text) FROM PUBLIC;

-- ---------------------------------------------------------------------------------------------
-- owner release (admin only). Lock order: intent SHARE -> op UPDATE -> advisory -> hold UPDATE -> case UPDATE, THEN v_t.
-- Requires the LATEST review of the hold (any outcome; C3) to be p_review and eligible, version = hold version = review version, both review
-- evidence rows fresh at v_t. Writes decision + release (+ case resolution when the last active hold of the case is released). Never claims.
CREATE FUNCTION booking.admin_release_preflight_hold(p_hold uuid, p_review uuid, p_resolver text, p_justification text, p_at timestamptz) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
DECLARE h0 booking.recording_holds%ROWTYPE; h booking.recording_holds%ROWTYPE; i booking.intents%ROWTYPE; o booking.external_operations%ROWTYPE;
        c booking.reconciliation_cases%ROWTYPE; prev booking.recording_hold_decisions%ROWTYPE; a booking.recording_assessments%ROWTYPE;
        v_latest uuid; ie timestamptz; le timestamptz; v_t timestamptz; d_id uuid := gen_random_uuid();
BEGIN
  IF p_review IS NULL OR p_at IS NULL OR p_resolver IS NULL OR length(btrim(p_resolver)) NOT BETWEEN 1 AND 200
     OR p_justification IS NULL OR NOT booking.is_code(p_justification) THEN
    RAISE EXCEPTION 'HOLD_DECISION_INVALID: review, resolver, justification code and decision time are required' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO h0 FROM booking.recording_holds WHERE id = p_hold;
  IF h0.id IS NULL THEN RAISE EXCEPTION 'HOLD_NOT_FOUND' USING ERRCODE = 'check_violation'; END IF;
  SELECT * INTO i FROM booking.intents WHERE id = h0.intent_id FOR SHARE;
  SELECT * INTO o FROM booking.external_operations WHERE id = h0.operation_id FOR UPDATE;
  PERFORM pg_advisory_xact_lock(hashtext('booking.recording_evidence'), hashtext(h0.intent_id::text));
  SELECT * INTO h FROM booking.recording_holds WHERE id = p_hold FOR UPDATE;
  SELECT * INTO c FROM booking.reconciliation_cases WHERE id = h.case_id FOR UPDATE;
  v_t := clock_timestamp();                                                                  -- after every potentially blocking lock
  IF h.released_at IS NOT NULL THEN
    SELECT * INTO prev FROM booking.recording_hold_decisions WHERE id = h.release_decision_id;
    IF prev.decision = 'release_for_initial_send' AND prev.assessment_id = p_review THEN RETURN prev.id; END IF;   -- same-review replay: read-only
    RAISE EXCEPTION 'HOLD_NOT_ACTIVE: hold % was released at %', h.id, h.released_at USING ERRCODE = 'check_violation';
  END IF;
  IF h.reason NOT IN ('PREFLIGHT_CONFLICT_MARKER', 'PREFLIGHT_CONFLICT_LOOKALIKE', 'PREFLIGHT_CONFLICT_SAME_AMOUNT', 'PREFLIGHT_EXHAUSTED') THEN
    RAISE EXCEPTION 'HOLD_DECISION_NOT_ALLOWED: release_for_initial_send applies to preflight holds only' USING ERRCODE = 'check_violation';
  END IF;
  IF h.epoch IS DISTINCT FROM booking.recording_preflight_epoch(h.operation_id) THEN
    RAISE EXCEPTION 'HOLD_STATE_UNEXPECTED: hold epoch is not the current epoch' USING ERRCODE = 'check_violation';
  END IF;
  IF o.state IS DISTINCT FROM 'pending' OR o.idempotency_key IS DISTINCT FROM 'och:' || h.intent_id::text || ':1' OR o.attempts IS DISTINCT FROM 0
     OR o.dispatched_at IS NOT NULL THEN
    RAISE EXCEPTION 'HOLD_TARGET_STATE: the held recording is not the pending, never-dispatched initial attempt' USING ERRCODE = 'check_violation';
  END IF;
  IF booking.recording_latest_id(h.intent_id) IS DISTINCT FROM o.id THEN RAISE EXCEPTION 'HOLD_TARGET_NOT_LATEST' USING ERRCODE = 'check_violation'; END IF;
  IF i.state IS DISTINCT FROM 'payment_captured' OR i.captured_minor IS DISTINCT FROM i.final_total_minor OR i.offline_charge_attempts IS DISTINCT FROM 0
     OR i.hostaway_reservation_id IS NULL THEN
    RAISE EXCEPTION 'HOLD_TARGET_STATE: the intent is not payment_captured with an exact capture' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO a FROM booking.recording_assessments WHERE id = p_review;
  IF i.version IS DISTINCT FROM h.intent_version_at_hold OR a.id IS NULL OR a.intent_version IS DISTINCT FROM i.version THEN
    RAISE EXCEPTION 'HOLD_CONTEXT_CHANGED: intent version differs from the hold / review version (the hold stays visible)' USING ERRCODE = 'check_violation';
  END IF;
  SELECT id INTO v_latest FROM booking.recording_assessments WHERE hold_id = h.id AND phase = 'release_review' ORDER BY seq DESC LIMIT 1;
  IF v_latest IS DISTINCT FROM p_review OR a.phase IS DISTINCT FROM 'release_review' OR a.hold_id IS DISTINCT FROM h.id
     OR a.operation_id IS DISTINCT FROM h.operation_id OR a.intent_id IS DISTINCT FROM h.intent_id OR a.epoch IS DISTINCT FROM h.epoch THEN
    RAISE EXCEPTION 'HOLD_REVIEW_NOT_LATEST: the cited review is not the latest review of this hold' USING ERRCODE = 'check_violation';
  END IF;
  IF a.outcome IS DISTINCT FROM 'eligible' THEN RAISE EXCEPTION 'HOLD_REVIEW_NOT_ELIGIBLE: latest review outcome %', a.outcome USING ERRCODE = 'check_violation'; END IF;
  SELECT observed_at INTO ie FROM booking.provider_evidence WHERE id = a.identity_evidence;
  SELECT observed_at INTO le FROM booking.provider_evidence WHERE id = a.list_evidence;
  IF ie IS NULL OR le IS NULL OR ie < v_t - interval '2 minutes' OR ie > v_t OR le < v_t - interval '2 minutes' OR le > v_t THEN
    RAISE EXCEPTION 'HOLD_REVIEW_STALE: review evidence is not fresh at the release instant' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO booking.recording_hold_decisions (id, hold_id, operation_id, case_id, intent_id, decision, evidence_ids, resolver, justification_code,
     resolver_session_user, decided_at, recorded_at, assessment_id)
  VALUES (d_id, h.id, h.operation_id, h.case_id, h.intent_id, 'release_for_initial_send', ARRAY[a.identity_evidence, a.list_evidence], p_resolver,
     p_justification, session_user, p_at, v_t, a.id);
  UPDATE booking.recording_holds SET released_at = v_t, release_decision_id = d_id WHERE id = h.id;
  IF NOT EXISTS (SELECT 1 FROM booking.recording_holds WHERE case_id = c.id AND released_at IS NULL) THEN
    UPDATE booking.reconciliation_cases SET status = 'resolved', resolution = 'no_action', resolved_by = p_resolver, resolved_at = v_t WHERE id = c.id;
  END IF;
  RETURN d_id;
END $$;
REVOKE ALL ON FUNCTION booking.admin_release_preflight_hold(uuid, uuid, text, text, timestamptz) FROM PUBLIC;

-- ---------------------------------------------------------------------------------------------
-- 0011 replacements (E13–E16; down restores the 0011 bodies verbatim)
CREATE OR REPLACE FUNCTION booking.recording_holds_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, booking AS $$
DECLARE o booking.external_operations%ROWTYPE; d booking.recording_hold_decisions%ROWTYPE; cit record;
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
    IF NEW.reason IN ('PREFLIGHT_CONFLICT_MARKER', 'PREFLIGHT_CONFLICT_LOOKALIKE', 'PREFLIGHT_CONFLICT_SAME_AMOUNT', 'PREFLIGHT_EXHAUSTED') THEN   -- 0013
      cit := booking.recording_preflight_latch_citation(NEW.operation_id);
      IF cit.o_reason IS DISTINCT FROM NEW.reason OR cit.o_assessment IS DISTINCT FROM NEW.assessment_id OR cit.o_epoch IS DISTINCT FROM NEW.epoch THEN
        RAISE EXCEPTION 'RECORDING_HOLD_BINDING: a preflight hold cites the current-epoch latch of its recording exactly' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - 'released_at' - 'release_decision_id') IS DISTINCT FROM (to_jsonb(OLD) - 'released_at' - 'release_decision_id') THEN
    RAISE EXCEPTION 'RECORDING_HOLD_IMMUTABLE: hold identity is frozen' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.released_at IS NOT NULL THEN RAISE EXCEPTION 'RECORDING_HOLD_IMMUTABLE: a released hold is final' USING ERRCODE = 'check_violation'; END IF;
  IF NEW.released_at IS NULL THEN RAISE EXCEPTION 'RECORDING_HOLD_IMMUTABLE: only a release may change a hold' USING ERRCODE = 'check_violation'; END IF;
  SELECT * INTO d FROM booking.recording_hold_decisions WHERE id = NEW.release_decision_id;
  IF NOT FOUND OR d.hold_id IS DISTINCT FROM NEW.id OR d.operation_id IS DISTINCT FROM NEW.operation_id OR d.case_id IS DISTINCT FROM NEW.case_id
     OR d.decision IS DISTINCT FROM (CASE WHEN NEW.reason IN ('PREFLIGHT_CONFLICT_MARKER', 'PREFLIGHT_CONFLICT_LOOKALIKE', 'PREFLIGHT_CONFLICT_SAME_AMOUNT',
                                             'PREFLIGHT_EXHAUSTED') THEN 'release_for_initial_send' ELSE 'link_full_proof' END) THEN    -- 0013
    RAISE EXCEPTION 'RECORDING_HOLD_BINDING: a release cites this hold''s own releasing owner decision' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION booking.recording_hold_decisions_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, booking AS $$
DECLARE h booking.recording_holds%ROWTYPE; a booking.recording_assessments%ROWTYPE;
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
  IF NEW.decision = 'release_for_initial_send' THEN                                          -- 0013
    SELECT * INTO a FROM booking.recording_assessments WHERE id = NEW.assessment_id;
    IF h.reason NOT IN ('PREFLIGHT_CONFLICT_MARKER', 'PREFLIGHT_CONFLICT_LOOKALIKE', 'PREFLIGHT_CONFLICT_SAME_AMOUNT', 'PREFLIGHT_EXHAUSTED')
       OR a.id IS NULL OR a.phase IS DISTINCT FROM 'release_review' OR a.hold_id IS DISTINCT FROM h.id OR a.operation_id IS DISTINCT FROM h.operation_id
       OR a.intent_id IS DISTINCT FROM h.intent_id OR a.epoch IS DISTINCT FROM h.epoch OR a.outcome IS DISTINCT FROM 'eligible'
       OR NEW.evidence_ids IS DISTINCT FROM ARRAY[a.identity_evidence, a.list_evidence] OR NEW.linked_evidence_id IS NOT NULL THEN
      RAISE EXCEPTION 'RECORDING_HOLD_BINDING: release_for_initial_send binds this preflight hold''s eligible review and exactly its two evidence rows'
        USING ERRCODE = 'check_violation';
    END IF;
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
      IF NEW.kind NOT IN ('OFFLINE_CHARGE_HOLD_ATTEMPT_GT1', 'OFFLINE_CHARGE_HOLD_SUCCEEDED_UNPROVEN', 'OFFLINE_CHARGE_HOLD_LINKED_CONTRADICTED',
                          'OFFLINE_CHARGE_HOLD_PREFLIGHT_CONFLICT_MARKER', 'OFFLINE_CHARGE_HOLD_PREFLIGHT_CONFLICT_LOOKALIKE',          -- 0013
                          'OFFLINE_CHARGE_HOLD_PREFLIGHT_CONFLICT_SAME_AMOUNT', 'OFFLINE_CHARGE_HOLD_PREFLIGHT_EXHAUSTED')
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
DECLARE c booking.reconciliation_cases%ROWTYPE; n integer; n_active integer; v_preflight boolean;
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
  v_preflight := starts_with(c.kind, 'OFFLINE_CHARGE_HOLD_PREFLIGHT_');                     -- 0013: resolution and releasing decision follow the kind
  IF c.status = 'resolved' AND c.resolution IS DISTINCT FROM (CASE WHEN v_preflight THEN 'no_action' ELSE 'recorded' END) THEN
    RAISE EXCEPTION 'RESERVED_CASE_BINDING: a hold case is resolved only as recorded (link_full_proof) or, for preflight kinds, no_action (release_for_initial_send)'
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM booking.recording_holds h WHERE h.case_id = c.id AND h.released_at IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM booking.recording_hold_decisions d WHERE d.id = h.release_decision_id AND d.hold_id = h.id
                                AND d.case_id = c.id AND d.operation_id = h.operation_id
                                AND d.decision = (CASE WHEN v_preflight THEN 'release_for_initial_send' ELSE 'link_full_proof' END))) THEN
    RAISE EXCEPTION 'RESERVED_CASE_BINDING: every released hold cites its own releasing decision' USING ERRCODE = 'check_violation';
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------
-- grants (new functions only; replaced functions keep their ACLs through CREATE OR REPLACE)
GRANT EXECUTE ON FUNCTION booking.record_release_review_assessment(uuid, text, text, text, uuid, uuid, uuid, uuid, integer, text, text, text, jsonb) TO mv_booking_app;
GRANT EXECUTE ON FUNCTION booking.open_recording_preflight_hold(uuid, text) TO mv_booking_app, mv_booking_admin;
GRANT EXECUTE ON FUNCTION booking.admin_release_preflight_hold(uuid, uuid, text, text, timestamptz) TO mv_booking_admin;
