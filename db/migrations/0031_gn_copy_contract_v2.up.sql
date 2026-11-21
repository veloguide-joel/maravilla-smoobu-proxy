-- 0031 (P2d-3, owner decision 2026-11-20): the booking confirmation may carry the copy contract "bcc-v2" (MiCasaDirect brand, total
-- with taxes included, the owner's cancellation policy; lib/checkout/booking-confirmation-copy.js).
--
--   * notification_renders_version_binding: a gn-v2 render names 'bcc-v1' OR 'bcc-v2' (everything else in the CHECK is unchanged).
--   * booking.claim_guest_notification_v3: the 0022 claim_guest_notification_v2 body, byte-for-byte, with exactly three edits:
--       [1] one more argument p_copy_contract text; [2] it must be 'bcc-v1' or 'bcc-v2' (else an exception; nothing is claimed);
--       [3] the render row stores p_copy_contract instead of the literal 'bcc-v1'.
--     Same owner, SECURITY DEFINER, search_path and grant as v2. claim_guest_notification_v2 is NOT changed.
-- No row is modified. The content hash stays a trust field bound by the claim, as before.
SET LOCAL lock_timeout = '5s';

ALTER TABLE booking.notification_renders DROP CONSTRAINT notification_renders_version_binding;
ALTER TABLE booking.notification_renders ADD CONSTRAINT notification_renders_version_binding CHECK (
     (template_version = 'gn-v1' AND message_ref = 'gn1-' || operation_id::text AND locale IS NULL AND copy_contract_version IS NULL)
  OR (template_version = 'gn-v2' AND template = 'booking_confirmed' AND message_ref = 'gn2-' || operation_id::text
      AND locale IS NOT NULL AND locale IN ('en', 'es') AND copy_contract_version IS NOT NULL AND copy_contract_version IN ('bcc-v1', 'bcc-v2')));

CREATE FUNCTION booking.claim_guest_notification_v3(p_op uuid, p_worker text, p_locale text, p_content_hash text,
  p_expected_facts_hash text, p_expected_recipient_hash text, p_copy_contract text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
DECLARE v_intent uuid; v_type text; o booking.external_operations%ROWTYPE; w booking.intent_work%ROWTYPE; i booking.intents%ROWTYPE;
        v_t timestamptz; r text; f jsonb; fh text; rh text;
BEGIN
  PERFORM booking.gn_check_worker(p_worker);
  IF p_copy_contract IS NULL OR p_copy_contract NOT IN ('bcc-v1', 'bcc-v2') THEN RAISE EXCEPTION 'MV_GN_COPY_CONTRACT_INVALID' USING ERRCODE = '22023'; END IF;
  IF p_op IS NULL OR p_locale IS NULL OR p_locale NOT IN ('en', 'es') OR p_content_hash IS NULL OR p_content_hash !~ '^[0-9a-f]{64}$'
     OR p_expected_facts_hash IS NULL OR p_expected_facts_hash !~ '^[0-9a-f]{64}$'
     OR (p_expected_recipient_hash IS NOT NULL AND p_expected_recipient_hash !~ '^[0-9a-f]{64}$') THEN
    RAISE EXCEPTION 'NOTIFY_ARGUMENT_INVALID: claim arguments' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT intent_id, op_type INTO v_intent, v_type FROM booking.external_operations WHERE id = p_op;
  IF v_intent IS NULL OR v_type <> 'guest.notify' THEN RETURN jsonb_build_object('status', 'not_claimable', 'code', 'NOT_NOTIFY'); END IF;
  PERFORM booking.gn_lock_bundle(v_intent, false);
  SELECT * INTO w FROM booking.intent_work WHERE intent_id = v_intent FOR SHARE;
  SELECT * INTO o FROM booking.external_operations WHERE id = p_op FOR UPDATE;
  PERFORM 1 FROM booking.intent_guests WHERE intent_id = v_intent FOR KEY SHARE;
  PERFORM booking.gn_facts_advisory(v_intent);
  PERFORM pg_advisory_xact_lock(hashtext('booking.recording_evidence'), hashtext(v_intent::text));
  v_t := clock_timestamp();
  IF booking.guest_notification_protected(v_intent) THEN RETURN jsonb_build_object('status', 'protected'); END IF;
  SELECT * INTO o FROM booking.external_operations WHERE id = p_op;
  IF o.state <> 'pending' OR o.attempts <> 0 OR o.dispatched_at IS NOT NULL
     OR EXISTS (SELECT 1 FROM booking.notification_renders x WHERE x.operation_id = p_op) THEN
    RETURN jsonb_build_object('status', 'not_claimable', 'code', 'NOT_PENDING');
  END IF;
  IF EXISTS (SELECT 1 FROM booking.notification_latches x WHERE x.operation_id = p_op) THEN
    RETURN jsonb_build_object('status', 'not_claimable', 'code', 'LATCHED');
  END IF;
  IF (o.payload ->> 'template') IS DISTINCT FROM 'booking_confirmed' THEN                       -- [0022 edit 3] gn-v2 is booking_confirmed ONLY
    RETURN jsonb_build_object('status', 'not_claimable', 'code', 'TEMPLATE_NOT_V2');
  END IF;
  SELECT * INTO w FROM booking.intent_work WHERE intent_id = v_intent;
  IF w.work_worker_id IS DISTINCT FROM p_worker OR w.work_lease_until IS NULL OR w.work_lease_until < v_t + interval '60 seconds' THEN
    RETURN jsonb_build_object('status', 'not_claimable', 'code', 'WORK_LEASE');
  END IF;
  r := booking.guest_notification_refusal(p_op);
  IF r IS NOT NULL THEN
    IF booking.gn_non_latching(r) THEN RETURN jsonb_build_object('status', 'waiting', 'code', r); END IF;
    SELECT * INTO i FROM booking.intents WHERE id = v_intent;
    INSERT INTO booking.notification_latches (operation_id, intent_id, code, intent_version_seen, latched_at, worker)
    VALUES (p_op, v_intent, r, i.version, v_t, p_worker);
    RETURN jsonb_build_object('status', 'latched', 'code', r);
  END IF;
  f := booking.guest_notification_facts(p_op);
  fh := booking.gn_hash_facts(f);
  rh := booking.guest_notification_recipient_hash(v_intent);
  IF fh IS DISTINCT FROM p_expected_facts_hash OR rh IS DISTINCT FROM p_expected_recipient_hash THEN
    RETURN jsonb_build_object('status', 'not_claimable', 'code', 'SNAPSHOT_STALE');
  END IF;
  SELECT * INTO i FROM booking.intents WHERE id = v_intent;
  INSERT INTO booking.notification_renders (operation_id, intent_id, template, template_version, intent_version, facts, facts_hash, recipient_hash,
     content_hash, message_ref, worker, claimed_at, locale, copy_contract_version)
  VALUES (p_op, v_intent, o.payload ->> 'template', 'gn-v2', o.source_version, f, fh, rh, p_content_hash, 'gn2-' || p_op::text, p_worker, v_t,
          p_locale, p_copy_contract);
  INSERT INTO booking.notification_write_authority (txid, operation_id, action) VALUES (pg_current_xact_id(), p_op, 'claim');
  UPDATE booking.external_operations SET state = 'in_flight', attempts = 1, dispatched_at = v_t, lease_worker_id = p_worker,
         lease_until = v_t + interval '60 seconds', updated_at = v_t
   WHERE id = p_op;
  DELETE FROM booking.notification_write_authority WHERE txid = pg_current_xact_id() AND operation_id = p_op AND action = 'claim';
  RETURN jsonb_build_object('status', 'claimed', 'leaseUntil', v_t + interval '60 seconds', 'dbNow', v_t);
END $$;
REVOKE ALL ON FUNCTION booking.claim_guest_notification_v3(uuid, text, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION booking.claim_guest_notification_v3(uuid, text, text, text, text, text, text) TO mv_booking_app;
