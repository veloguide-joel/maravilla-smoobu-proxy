-- 0022_gn_v2_booking_confirmation (up) — Stage E7 guest notification: gn-v2 BOOKING-CONFIRMATION render support (C41, OFFLINE).
-- DISPOSABLE LOCAL test databases only (shared DEV is at 1..21 and is NOT migrated by this task). Integration under the EXISTING fences:
-- `.invalid` recipients only (gn_recipient_in_scope unchanged), mock executor ids only (complete_guest_notification unchanged).
--
--   * notification_renders gains two nullable columns, `locale` and `copy_contract_version`. The two 0016 column CHECKs
--     (template_version = 'gn-v1'; message_ref = 'gn1-' || op) are replaced by ONE cross-field CHECK that admits exactly
--       gn-v1: message_ref 'gn1-<op>', locale NULL, copy_contract_version NULL (every 0016 row, unchanged), or
--       gn-v2: template 'booking_confirmed' ONLY, message_ref 'gn2-<op>', locale 'en' | 'es', copy_contract_version 'bcc-v1';
--     every mixed version / prefix / template / locale / copy combination is refused. Every operand is NOT NULL or explicitly tested
--     IS NOT NULL, so the expression is never NULL (a NULL CHECK result would PASS). The table stays append-only (0016 triggers).
--   * booking.claim_guest_notification_v2 — a NEW, narrowly named dedicated claim with an explicit locale and FIXED 'gn-v2' / 'bcc-v1'.
--     It is a COPY of the 0016 booking.claim_guest_notification body; exact semantic diff (everything else byte-identical, same locks /
--     evidence lock / protected / NOT_PENDING / LATCHED / work-lease / refusal + latch / facts-hash / recipient-hash checks in the same order,
--     ONE claim, no retry):
--       [1] signature: p_template_version → p_locale (same arity / types: uuid, text, text, text, text, text);
--       [2] argument guard: p_template_version = 'gn-v1' → p_locale IN ('en', 'es');
--       [3] NEW check after LATCHED, before WORK_LEASE (so before the refusal can latch): payload template must be 'booking_confirmed',
--           else not_claimable TEMPLATE_NOT_V2 — another template is never claimed, latched or rendered by the v2 path;
--       [4] render INSERT: template_version 'gn-v2', message_ref 'gn2-' || op, locale p_locale, copy_contract_version 'bcc-v1'.
--     SECURITY DEFINER, search_path pg_catalog, booking; REVOKE ALL FROM PUBLIC; EXECUTE to mv_booking_app only (same boundary as 0016).
--   * booking.guest_notification_presend — body unchanged except its success object ADDITIONALLY carries `locale` and
--     `copyContractVersion` for a gn-v2 render (gn-v1 output byte-identical). ACL kept (CREATE OR REPLACE).
--   * The 0016 six-argument claim is NOT changed: it still refuses any template version but 'gn-v1'.
-- The content hash stays a TRUST field: SQL binds the request VERSION, message_ref prefix, template, locale and copy contract version,
-- but cannot re-derive the rendered subject / body.

DO $$
BEGIN
  IF to_regprocedure('booking.suppress_guest_notification(uuid,text)') IS NULL
     OR to_regprocedure('booking.claim_guest_notification(uuid,text,text,text,text,text)') IS NULL THEN
    RAISE EXCEPTION 'MIGRATION_0022_PRECONDITION: 0021 is not applied' USING ERRCODE = 'check_violation';
  END IF;
END $$;

LOCK TABLE booking.external_operations, booking.notification_renders IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE booking.notification_renders ADD COLUMN locale text, ADD COLUMN copy_contract_version text;
ALTER TABLE booking.notification_renders DROP CONSTRAINT notification_renders_template_version_check, DROP CONSTRAINT notification_renders_check;
ALTER TABLE booking.notification_renders ADD CONSTRAINT notification_renders_version_binding CHECK (
     (template_version = 'gn-v1' AND message_ref = 'gn1-' || operation_id::text AND locale IS NULL AND copy_contract_version IS NULL)
  OR (template_version = 'gn-v2' AND template = 'booking_confirmed' AND message_ref = 'gn2-' || operation_id::text
      AND locale IS NOT NULL AND locale IN ('en', 'es') AND copy_contract_version IS NOT NULL AND copy_contract_version = 'bcc-v1'));

-- claim (gn-v2): copy of 0016 booking.claim_guest_notification with the four labelled edits above
CREATE FUNCTION booking.claim_guest_notification_v2(p_op uuid, p_worker text, p_locale text, p_content_hash text,
  p_expected_facts_hash text, p_expected_recipient_hash text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
DECLARE v_intent uuid; v_type text; o booking.external_operations%ROWTYPE; w booking.intent_work%ROWTYPE; i booking.intents%ROWTYPE;
        v_t timestamptz; r text; f jsonb; fh text; rh text;
BEGIN
  PERFORM booking.gn_check_worker(p_worker);
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
          p_locale, 'bcc-v1');
  INSERT INTO booking.notification_write_authority (txid, operation_id, action) VALUES (pg_current_xact_id(), p_op, 'claim');
  UPDATE booking.external_operations SET state = 'in_flight', attempts = 1, dispatched_at = v_t, lease_worker_id = p_worker,
         lease_until = v_t + interval '60 seconds', updated_at = v_t
   WHERE id = p_op;
  DELETE FROM booking.notification_write_authority WHERE txid = pg_current_xact_id() AND operation_id = p_op AND action = 'claim';
  RETURN jsonb_build_object('status', 'claimed', 'leaseUntil', v_t + interval '60 seconds', 'dbNow', v_t);
END $$;
REVOKE ALL ON FUNCTION booking.claim_guest_notification_v2(uuid, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION booking.claim_guest_notification_v2(uuid, text, text, text, text, text) TO mv_booking_app;

-- pre-send (0016 body; gn-v2 renders additionally return locale / copyContractVersion)
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
    'contentHash', rd.content_hash, 'templateVersion', rd.template_version, 'messageRef', rd.message_ref)
    || CASE WHEN rd.template_version = 'gn-v2'                                                -- [0022] gn-v2 only; gn-v1 output byte-identical
            THEN jsonb_build_object('locale', rd.locale, 'copyContractVersion', rd.copy_contract_version) ELSE '{}'::jsonb END;
END $$;
