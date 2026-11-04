-- 0015_scoped_recording_inbox (down) — DISPOSABLE LOCAL test databases only. Function-only: UNGATED. Rows written through the scoped API are
-- ordinary 0011 audit (inbox marks / attempts / holds / observations / cases), valid under 0011–0014 and never deleted or rewritten here.
-- 1. restore the 0011 processor VERBATIM (0011:654–718; only CREATE -> CREATE OR REPLACE) BEFORE dropping its new private dependency;
-- 2. drop the new functions in dependency order. Grants / owner / security / search_path of the legacy function are kept by CREATE OR REPLACE.
CREATE OR REPLACE FUNCTION booking.process_recording_conflict_inbox_one(p_by text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
DECLARE q booking.recording_conflict_inbox%ROWTYPE; v_op uuid; i booking.intents%ROWTYPE; o booking.external_operations%ROWTYPE;
        h booking.recording_holds%ROWTYPE; c booking.reconciliation_cases%ROWTYPE; v_t timestamptz; v_out text; v_hold uuid; v_case uuid;
        st text; msg text;
BEGIN
  IF p_by IS NULL OR length(btrim(p_by)) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'INBOX_BY_INVALID' USING ERRCODE = 'invalid_parameter_value'; END IF;
  SELECT * INTO q FROM booking.recording_conflict_inbox WHERE processed_at IS NULL ORDER BY attempts, seq LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN NULL; END IF;
  BEGIN
    SELECT * INTO i FROM booking.intents WHERE id = q.intent_id FOR SHARE;
    v_op := booking.recording_latest_id(q.intent_id);
    IF v_op IS NOT NULL THEN SELECT * INTO o FROM booking.external_operations WHERE id = v_op FOR SHARE; END IF;
    PERFORM pg_advisory_xact_lock(hashtext('booking.recording_evidence'), hashtext(q.intent_id::text));
    v_t := clock_timestamp();
    IF v_op IS NULL OR booking.recording_latest_id(q.intent_id) IS DISTINCT FROM v_op OR o.state IS DISTINCT FROM 'succeeded'
       OR o.settled_evidence_id IS NULL OR o.result_ref IS NULL THEN
      v_out := 'not_latest_linked';                                                          -- judged by 0010 at completion / link / finalisation
    ELSIF NOT booking.recording_evidence_contradicts(q.intent_id, o.dispatched_at, o.result_ref, o.settled_evidence_id, q.evidence_id) THEN
      v_out := 'consistent';
    ELSE
      SELECT * INTO h FROM booking.recording_holds WHERE operation_id = v_op AND released_at IS NULL FOR UPDATE;
      SELECT * INTO c FROM booking.reconciliation_cases
       WHERE intent_id = q.intent_id AND kind = 'OFFLINE_CHARGE_HOLD_LINKED_CONTRADICTED' AND status = 'open' FOR UPDATE;
      v_t := clock_timestamp();
      IF h.id IS NOT NULL AND h.reason IS DISTINCT FROM 'LINKED_CONTRADICTED' THEN
        RAISE EXCEPTION 'HOLD_STATE_UNEXPECTED: % hold % is active on a linked recording', h.reason, h.id USING ERRCODE = 'check_violation';
      END IF;
      IF h.id IS NOT NULL THEN
        v_hold := h.id;
        IF EXISTS (SELECT 1 FROM booking.recording_hold_observations WHERE hold_id = h.id AND evidence_id = q.evidence_id) THEN
          v_out := 'contradiction_duplicate';
        ELSE
          INSERT INTO booking.recording_hold_observations (id, hold_id, evidence_id, recorded_at) VALUES (gen_random_uuid(), h.id, q.evidence_id, v_t);
          v_out := 'contradiction_appended';
        END IF;
      ELSE
        v_hold := gen_random_uuid();
        IF c.id IS NULL THEN
          v_case := gen_random_uuid();
          INSERT INTO booking.reconciliation_cases (id, intent_id, kind, status, opened_at, opened_by, evidence)
          VALUES (v_case, q.intent_id, 'OFFLINE_CHARGE_HOLD_LINKED_CONTRADICTED', 'open', v_t, 'recording-hold:' || v_case::text,
                  jsonb_build_object('operationId', v_op, 'reason', 'LINKED_CONTRADICTED', 'opKey', o.idempotency_key, 'opState', o.state,
                                     'intentVersion', i.version, 'firstEvidenceId', q.evidence_id));
          v_out := 'contradiction_opened';
        ELSE
          v_case := c.id;
          v_out := 'contradiction_joined_case';
        END IF;
        INSERT INTO booking.recording_holds (id, operation_id, intent_id, reason, case_id, op_state_at_hold, op_key_at_hold, intent_state_at_hold,
           intent_version_at_hold, created_at, created_by)
        VALUES (v_hold, v_op, q.intent_id, 'LINKED_CONTRADICTED', v_case, o.state, o.idempotency_key, i.state, i.version, v_t, p_by);
        INSERT INTO booking.recording_hold_observations (id, hold_id, evidence_id, recorded_at) VALUES (gen_random_uuid(), v_hold, q.evidence_id, v_t);
      END IF;
    END IF;
    UPDATE booking.recording_conflict_inbox SET processed_at = v_t, outcome = v_out, hold_id = v_hold WHERE evidence_id = q.evidence_id;
    RETURN jsonb_build_object('evidenceId', q.evidence_id, 'outcome', v_out, 'holdId', v_hold);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, msg = MESSAGE_TEXT;
    UPDATE booking.recording_conflict_inbox
       SET attempts = attempts + 1, last_error = left(st || ': ' || msg, 500), last_attempt_at = clock_timestamp()
     WHERE evidence_id = q.evidence_id;
    RETURN jsonb_build_object('evidenceId', q.evidence_id, 'error', st, 'message', left(msg, 300));
  END;
END $$;
REVOKE ALL ON FUNCTION booking.process_recording_conflict_inbox_one(text) FROM PUBLIC;

DROP FUNCTION booking.recording_inbox_summary(integer[], uuid);
DROP FUNCTION booking.recording_inbox_page(integer[], uuid, text, bigint, integer);
DROP FUNCTION booking.process_recording_conflict_inbox_scoped_one(text, integer[], uuid);
DROP FUNCTION booking.recording_inbox_process_locked(uuid, text, integer[], uuid);
DROP FUNCTION booking.recording_inbox_ref_protected(text, text);
DROP FUNCTION booking.recording_protected_reservation_ids();
