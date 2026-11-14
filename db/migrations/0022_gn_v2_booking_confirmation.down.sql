-- 0022_gn_v2_booking_confirmation (down) — DISPOSABLE LOCAL test databases only. REFUSED while ANY gn-v2 render exists (whatever the
-- operation state: in flight, unknown or succeeded) — the append-only audit is never deleted or rewritten to roll back. Otherwise restores
-- the exact 0016 objects: the 0016 presend body (verbatim), the two 0016 column CHECKs (same names / definitions), no locale /
-- copy_contract_version columns, no v2 claim. Existing gn-v1 rows are untouched.
LOCK TABLE booking.external_operations, booking.notification_renders IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM booking.notification_renders WHERE template_version <> 'gn-v1' OR locale IS NOT NULL OR copy_contract_version IS NOT NULL) THEN
    RAISE EXCEPTION 'MIGRATION_0022_DOWN_REFUSED: gn-v2 render audit exists' USING ERRCODE = 'check_violation';
  END IF;
END $$;

DROP FUNCTION booking.claim_guest_notification_v2(uuid, text, text, text, text, text);

-- the 0016 pre-send body, verbatim
CREATE OR REPLACE FUNCTION booking.guest_notification_presend(p_op uuid, p_worker text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
DECLARE o booking.external_operations%ROWTYPE; rd booking.notification_renders%ROWTYPE; i booking.intents%ROWTYPE; w booking.intent_work%ROWTYPE;
        g booking.intent_guests%ROWTYPE; r text; v_t timestamptz;
BEGIN
  PERFORM booking.gn_require_observation_context();
  PERFORM booking.gn_check_worker(p_worker);
  IF p_op IS NULL THEN RAISE EXCEPTION 'NOTIFY_ARGUMENT_INVALID: op' USING ERRCODE = 'invalid_parameter_value'; END IF;
  SELECT * INTO o FROM booking.external_operations WHERE id = p_op;
  IF o.id IS NULL OR o.op_type <> 'guest.notify' THEN RETURN jsonb_build_object('ok', false, 'code', 'NOT_NOTIFY'); END IF;
  IF booking.guest_notification_protected(o.intent_id) THEN RETURN jsonb_build_object('ok', false, 'code', 'PROTECTED'); END IF;
  SELECT * INTO rd FROM booking.notification_renders WHERE operation_id = p_op;
  SELECT * INTO i FROM booking.intents WHERE id = o.intent_id;
  SELECT * INTO w FROM booking.intent_work WHERE intent_id = o.intent_id;
  SELECT * INTO g FROM booking.intent_guests WHERE intent_id = o.intent_id;
  IF o.state <> 'in_flight' OR o.attempts <> 1 OR rd.operation_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'NOT_IN_FLIGHT'); END IF;
  IF o.lease_worker_id IS DISTINCT FROM p_worker OR rd.worker IS DISTINCT FROM p_worker OR w.work_worker_id IS DISTINCT FROM p_worker THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LEASE_NOT_HELD');
  END IF;
  IF i.version IS DISTINCT FROM rd.intent_version THEN RETURN jsonb_build_object('ok', false, 'code', 'VERSION_DRIFT'); END IF;
  r := booking.guest_notification_refusal(p_op);
  IF r IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'code', r); END IF;
  IF booking.gn_hash_facts(booking.guest_notification_facts(p_op)) IS DISTINCT FROM rd.facts_hash THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FACTS_CHANGED');
  END IF;
  IF booking.gn_recipient_hash_of(g.email, g.first_name) IS DISTINCT FROM rd.recipient_hash THEN
    RETURN jsonb_build_object('ok', false, 'code', 'RECIPIENT_CHANGED');
  END IF;
  v_t := clock_timestamp();                                                                  -- END of the checks
  IF o.lease_until IS NULL OR o.lease_until <= v_t OR w.work_lease_until IS NULL OR w.work_lease_until <= v_t THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LEASE_NOT_HELD');
  END IF;
  RETURN jsonb_build_object('ok', true, 'code', NULL, 'dbNow', v_t, 'opLeaseUntil', o.lease_until, 'workLeaseUntil', w.work_lease_until,
    'contentHash', rd.content_hash, 'templateVersion', rd.template_version, 'messageRef', rd.message_ref);
END $$;

ALTER TABLE booking.notification_renders DROP CONSTRAINT notification_renders_version_binding;
ALTER TABLE booking.notification_renders DROP COLUMN copy_contract_version, DROP COLUMN locale;
ALTER TABLE booking.notification_renders ADD CONSTRAINT notification_renders_template_version_check CHECK (template_version = 'gn-v1');
ALTER TABLE booking.notification_renders ADD CONSTRAINT notification_renders_check CHECK (message_ref = 'gn1-' || operation_id::text);
