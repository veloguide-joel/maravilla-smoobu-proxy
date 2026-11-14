-- 0023_gn_v2_resend_receipts (up) — Stage E7 guest notification: gn-v2 → RESEND provider completion binding (C45, OFFLINE).
-- DISPOSABLE LOCAL test databases only (shared DEV is at 1..21; 0022 / 0023 are NOT applied to it by this task). Integration under the
-- EXISTING fences: `.invalid` recipients only (gn_recipient_in_scope unchanged), sender validated by the worker / builder (unchanged).
--
--   * booking.notification_provider_receipts — append-only, ONE typed receipt per operation, keyed to the gn-v2 render
--     (operation_id → notification_renders): provider 'resend', protocol 'resend-gn2-v1', provider_message_id (uuid, unique), replayed
--     (the documented `idempotent-replayed` flag, recorded honestly), idempotency_key = 'mv-gn2-resend-v1/<op>/<render content hash>',
--     content_hash (= the render's), worker, recorded_at. A BEFORE INSERT binding trigger refuses any receipt whose render is not gn-v2,
--     whose intent / content hash differ from the render, or whose key is not the canonical one. RLS + SELECT for app / admin only
--     (same boundary as notification_renders); no INSERT / UPDATE / DELETE grant.
--   * booking.complete_guest_notification_resend — a NEW dedicated completion; COPY of the 0016 booking.complete_guest_notification body
--     with this exact semantic diff (everything else byte-identical: same worker check, bundle lock, row lock, facts advisory, protection,
--     lease checks, write-authority token, unknown path and reconciliation case):
--       [1] signature: p_ref text → p_provider_message_id uuid, p_replayed boolean (6 arguments);
--       [2] argument guard: accepted needs a provider id + replayed flag and no code; unknown needs neither and a code from the 0016 list
--           PLUS the Resend exchange / reply codes and PROVIDER_REFUSED_NOT_INVOKED;
--       [3] accepted: requires THIS operation's gn-v2 render (else NOTIFY_ARGUMENT_INVALID) and INSERTs the receipt bound to it;
--       [4] accepted: result_ref = 'resend:' || provider_message_id (never disguised as a mock id).
--     SECURITY DEFINER, search_path pg_catalog, booking; REVOKE ALL FROM PUBLIC; EXECUTE to mv_booking_app only (same boundary as 0016).
--   * booking.notify_op_fence — the 0021 body with ONE condition widened in the in_flight → succeeded branch: result_ref may be the 0021
--     mock id (unchanged) OR 'resend:<uuid>' backed by a receipt whose render is gn-v2 and whose content hash equals the render's. A gn-v1
--     render can never complete with a UUID; there is no raw completion bypass (the write token and privilege checks are unchanged).
--   * The 0016 complete_guest_notification, the 0016 / 0022 claims, the pre-send and every render row are unchanged.

DO $$
BEGIN
  IF to_regprocedure('booking.claim_guest_notification_v2(uuid,text,text,text,text,text)') IS NULL THEN
    RAISE EXCEPTION 'MIGRATION_0023_PRECONDITION: 0022 is not applied' USING ERRCODE = 'check_violation';
  END IF;
END $$;

LOCK TABLE booking.external_operations, booking.notification_renders IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE booking.notification_provider_receipts (
  operation_id        uuid PRIMARY KEY REFERENCES booking.notification_renders (operation_id),
  intent_id           uuid NOT NULL REFERENCES booking.intents (id),
  provider            text NOT NULL CHECK (provider = 'resend'),
  protocol            text NOT NULL CHECK (protocol = 'resend-gn2-v1'),
  provider_message_id uuid NOT NULL UNIQUE,
  replayed            boolean NOT NULL,
  idempotency_key     text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 256),
  content_hash        text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  worker              text NOT NULL CHECK (length(worker) BETWEEN 1 AND 100),
  recorded_at         timestamptz NOT NULL,
  CHECK (idempotency_key = 'mv-gn2-resend-v1/' || operation_id::text || '/' || content_hash)
);
CREATE TRIGGER notification_provider_receipts_append_only BEFORE UPDATE OR DELETE ON booking.notification_provider_receipts
  FOR EACH ROW EXECUTE FUNCTION booking.reject_change();
CREATE TRIGGER notification_provider_receipts_no_truncate BEFORE TRUNCATE ON booking.notification_provider_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION booking.reject_change();

CREATE FUNCTION booking.notification_provider_receipt_binding() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, booking AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM booking.notification_renders r WHERE r.operation_id = NEW.operation_id AND r.template_version = 'gn-v2'
                   AND r.intent_id = NEW.intent_id AND r.content_hash = NEW.content_hash) THEN
    RAISE EXCEPTION 'NOTIFY_RECEIPT_BINDING: a provider receipt must bind to this operation''s gn-v2 render and its content hash' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER notification_provider_receipts_binding BEFORE INSERT ON booking.notification_provider_receipts
  FOR EACH ROW EXECUTE FUNCTION booking.notification_provider_receipt_binding();
REVOKE ALL ON FUNCTION booking.notification_provider_receipt_binding() FROM PUBLIC;

ALTER TABLE booking.notification_provider_receipts ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON booking.notification_provider_receipts TO mv_booking_app, mv_booking_admin;   -- same boundary as notification_renders (no report grant)
CREATE POLICY app_admin_read ON booking.notification_provider_receipts FOR SELECT TO mv_booking_app, mv_booking_admin USING (true);

-- completion (Resend): copy of 0016 booking.complete_guest_notification with the four labelled edits above
CREATE FUNCTION booking.complete_guest_notification_resend(p_op uuid, p_worker text, p_kind text, p_provider_message_id uuid, p_replayed boolean, p_code text) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
DECLARE v_intent uuid; v_type text; o booking.external_operations%ROWTYPE; v_t timestamptz; rd booking.notification_renders%ROWTYPE;
BEGIN
  PERFORM booking.gn_check_worker(p_worker);
  IF p_op IS NULL OR p_kind IS NULL OR p_kind NOT IN ('accepted', 'unknown')
     OR (p_kind = 'accepted' AND (p_provider_message_id IS NULL OR p_replayed IS NULL OR p_code IS NOT NULL))                 -- [0023 edit 2]
     OR (p_kind = 'unknown' AND (p_provider_message_id IS NOT NULL OR p_replayed IS NOT NULL OR p_code IS NULL
         OR p_code NOT IN ('SEND_TIMEOUT', 'SEND_THREW', 'REPLY_SHAPE', 'REPLY_UNREADABLE', 'PRESEND_ABORTED_NOT_INVOKED',
                        'HTTP_STATUS',
                        'REPLY_CONTENT_TYPE',
                        'REPLY_JSON_INVALID',
                        'REPLY_ID_INVALID',
                        'REPLAY_HEADER_INVALID',
                        'EXCHANGE_DEADLINE',
                        'EXCHANGE_NETWORK_ERROR',
                        'EXCHANGE_PREMATURE_CLOSE',
                        'EXCHANGE_STATUS_INVALID',
                        'EXCHANGE_ENCODING_REFUSED',
                        'EXCHANGE_BODY_TOO_LARGE',
                        'EXCHANGE_SETUP_FAILED',
                        'EXCHANGE_SPENT',
                        'EXCHANGE_INPUT_INVALID',
                        'EXCHANGE_UNKNOWN',
                        'PROVIDER_REFUSED_NOT_INVOKED'))) THEN
    RAISE EXCEPTION 'NOTIFY_ARGUMENT_INVALID: completion arguments' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT intent_id, op_type INTO v_intent, v_type FROM booking.external_operations WHERE id = p_op;
  IF v_intent IS NULL OR v_type <> 'guest.notify' THEN RETURN 'LEASE_LOST'; END IF;
  PERFORM booking.gn_lock_bundle(v_intent, false);
  SELECT * INTO o FROM booking.external_operations WHERE id = p_op FOR UPDATE;
  PERFORM booking.gn_facts_advisory(v_intent);
  v_t := clock_timestamp();
  IF booking.guest_notification_protected(v_intent) THEN RETURN 'PROTECTED'; END IF;
  SELECT * INTO o FROM booking.external_operations WHERE id = p_op;
  IF o.state <> 'in_flight' OR o.lease_worker_id IS DISTINCT FROM p_worker OR o.lease_until IS NULL OR v_t > o.lease_until THEN RETURN 'LEASE_LOST'; END IF;
  IF p_kind = 'accepted' THEN
    -- [0023 edit 3] a Resend acceptance is recorded ONLY for a gn-v2 render, as ONE typed, append-only receipt bound to that render
    SELECT * INTO rd FROM booking.notification_renders WHERE operation_id = p_op;
    IF rd.operation_id IS NULL OR rd.template_version <> 'gn-v2' OR rd.intent_id <> v_intent THEN
      RAISE EXCEPTION 'NOTIFY_ARGUMENT_INVALID: a Resend completion needs this operation''s gn-v2 render' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    INSERT INTO booking.notification_provider_receipts (operation_id, intent_id, provider, protocol, provider_message_id, replayed, idempotency_key,
       content_hash, worker, recorded_at)
    VALUES (p_op, v_intent, 'resend', 'resend-gn2-v1', p_provider_message_id, p_replayed, 'mv-gn2-resend-v1/' || p_op::text || '/' || rd.content_hash,
            rd.content_hash, p_worker, v_t);
    INSERT INTO booking.notification_write_authority (txid, operation_id, action) VALUES (pg_current_xact_id(), p_op, 'complete');
    UPDATE booking.external_operations SET state = 'succeeded', result_ref = 'resend:' || p_provider_message_id::text, completed_at = v_t,  -- [0023 edit 4]
           lease_worker_id = NULL, lease_until = NULL, updated_at = v_t WHERE id = p_op;
    DELETE FROM booking.notification_write_authority WHERE txid = pg_current_xact_id() AND operation_id = p_op AND action = 'complete';
    RETURN 'succeeded';
  END IF;
  UPDATE booking.external_operations SET state = 'outcome_unknown', error_code = p_code, lease_worker_id = NULL, lease_until = NULL, updated_at = v_t
   WHERE id = p_op;
  INSERT INTO booking.reconciliation_cases (id, intent_id, kind, status, opened_at, opened_by, evidence)
  VALUES (gen_random_uuid(), v_intent, 'NOTIFICATION_OUTCOME_UNKNOWN', 'open', v_t, 'op:' || p_op::text,
          jsonb_build_object('operationId', p_op, 'opType', 'guest.notify', 'errorCode', p_code))
  ON CONFLICT (intent_id, kind) WHERE status = 'open' DO NOTHING;
  RETURN 'outcome_unknown';
END $$;
REVOKE ALL ON FUNCTION booking.complete_guest_notification_resend(uuid, text, text, uuid, boolean, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION booking.complete_guest_notification_resend(uuid, text, text, uuid, boolean, text) TO mv_booking_app;

-- fence: the 0021 body with the ONE labelled condition above
CREATE OR REPLACE FUNCTION booking.notify_op_fence() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, booking AS $$
DECLARE i_state text; i_version integer; t text; i_mirrored boolean; i_rc boolean; i_as boolean; i_och text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    t := NEW.payload ->> 'template';
    SELECT state, version INTO i_state, i_version FROM booking.intents WHERE id = NEW.intent_id;
    IF t IS NULL OR t NOT IN ('booking_confirmed', 'not_charged_authorization_may_show', 'not_completed_not_charged')
       OR NEW.payload <> jsonb_build_object('template', t)
       OR NEW.idempotency_key IS DISTINCT FROM 'notify:' || NEW.intent_id::text || ':' || t
       OR NEW.retry_class IS DISTINCT FROM 'idempotent' THEN
      RAISE EXCEPTION 'NOTIFY_INSERT_REFUSED: key / payload / retry class not canonical' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.state <> 'pending' OR NEW.attempts <> 0 OR NEW.dispatched_at IS NOT NULL OR NEW.completed_at IS NOT NULL
       OR NEW.lease_worker_id IS NOT NULL OR NEW.lease_until IS NOT NULL OR NEW.result_ref IS NOT NULL OR NEW.error_code IS NOT NULL
       OR NEW.late_result_status IS NOT NULL OR NEW.late_result_ref IS NOT NULL OR NEW.settled_evidence_id IS NOT NULL
       OR NEW.resolution_id IS NOT NULL OR NEW.requires_provider_read THEN
      RAISE EXCEPTION 'NOTIFY_INSERT_REFUSED: lifecycle columns must be initial' USING ERRCODE = 'check_violation';
    END IF;
    IF i_version IS DISTINCT FROM NEW.source_version OR i_state IS DISTINCT FROM
       (CASE t WHEN 'booking_confirmed' THEN 'confirmed' WHEN 'not_charged_authorization_may_show' THEN 'authorization_released'
               ELSE 'cancelled' END) THEN
      RAISE EXCEPTION 'NOTIFY_INSERT_REFUSED: source version / intent state' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  -- UPDATE (op_type / identity immutability is 0004's guard)
  IF NEW.source_version IS DISTINCT FROM OLD.source_version THEN
    RAISE EXCEPTION 'NOTIFY_OP_FROZEN: source_version' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state = OLD.state THEN
    IF (NEW.attempts, NEW.dispatched_at, NEW.lease_worker_id, NEW.lease_until, NEW.result_ref, NEW.completed_at, NEW.next_attempt_at,
        NEW.requires_provider_read, NEW.late_result_status, NEW.late_result_ref, NEW.settled_evidence_id, NEW.resolution_id, NEW.error_code)
       IS DISTINCT FROM
       (OLD.attempts, OLD.dispatched_at, OLD.lease_worker_id, OLD.lease_until, OLD.result_ref, OLD.completed_at, OLD.next_attempt_at,
        OLD.requires_provider_read, OLD.late_result_status, OLD.late_result_ref, OLD.settled_evidence_id, OLD.resolution_id, OLD.error_code) THEN
      RAISE EXCEPTION 'NOTIFY_OP_FROZEN: same-state change of a notification lifecycle column' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  -- columns no transition may touch
  IF (NEW.next_attempt_at, NEW.requires_provider_read, NEW.late_result_status, NEW.late_result_ref, NEW.settled_evidence_id, NEW.resolution_id)
     IS DISTINCT FROM (OLD.next_attempt_at, OLD.requires_provider_read, OLD.late_result_status, OLD.late_result_ref, OLD.settled_evidence_id, OLD.resolution_id) THEN
    RAISE EXCEPTION 'NOTIFY_OP_FROZEN: column not settable by a notification transition' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.state = 'pending' AND NEW.state = 'in_flight' THEN
    IF NOT booking.is_privileged() THEN
      RAISE EXCEPTION 'NOTIFY_CLAIM_AUTHORITY: claimed only through booking.claim_guest_notification' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM booking.notification_write_authority a WHERE a.txid = pg_current_xact_id() AND a.operation_id = NEW.id AND a.action = 'claim') THEN
      RAISE EXCEPTION 'NOTIFY_CLAIM_AUTHORITY: no claim token in this transaction' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF OLD.attempts <> 0 OR OLD.dispatched_at IS NOT NULL OR NEW.attempts <> 1 OR NEW.dispatched_at IS NULL OR NEW.lease_worker_id IS NULL
       OR NEW.lease_until IS NULL OR NEW.result_ref IS NOT NULL OR NEW.completed_at IS NOT NULL OR NEW.error_code IS DISTINCT FROM OLD.error_code THEN
      RAISE EXCEPTION 'NOTIFY_CLAIM_FENCED: only the never-attempted row, attempts 0 -> 1' USING ERRCODE = 'check_violation';
    END IF;
    IF booking.guest_notification_protected(NEW.intent_id) OR EXISTS (SELECT 1 FROM booking.notification_latches l WHERE l.operation_id = NEW.id)
       OR booking.guest_notification_refusal(NEW.id) IS NOT NULL THEN
      RAISE EXCEPTION 'NOTIFY_CLAIM_FENCED: protected, latched or not qualified at the fence instant' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  -- 0021: suppression of the PRISTINE row by the recorded TEST cleanup request (same transaction as confirmed -> test_cleanup_pending)
  IF OLD.state = 'pending' AND NEW.state = 'superseded' THEN
    IF NOT booking.is_privileged() THEN
      RAISE EXCEPTION 'NOTIFY_SUPPRESS_AUTHORITY: suppressed only through booking.suppress_guest_notification' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM booking.notification_write_authority a WHERE a.txid = pg_current_xact_id() AND a.operation_id = NEW.id AND a.action = 'suppress') THEN
      RAISE EXCEPTION 'NOTIFY_SUPPRESS_AUTHORITY: no suppression token in this transaction' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF OLD.attempts <> 0 OR OLD.dispatched_at IS NOT NULL OR OLD.lease_worker_id IS NOT NULL OR OLD.lease_until IS NOT NULL OR OLD.result_ref IS NOT NULL
       OR OLD.completed_at IS NOT NULL OR OLD.error_code IS NOT NULL
       OR NEW.attempts <> 0 OR NEW.dispatched_at IS NOT NULL OR NEW.lease_worker_id IS NOT NULL OR NEW.lease_until IS NOT NULL OR NEW.result_ref IS NOT NULL
       OR NEW.completed_at IS NOT NULL OR NEW.error_code IS NOT NULL THEN
      RAISE EXCEPTION 'NOTIFY_SUPPRESS_FENCED: only the never-attempted, unleased, unsent row' USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM booking.notification_renders r WHERE r.operation_id = NEW.id) THEN
      RAISE EXCEPTION 'NOTIFY_SUPPRESS_FENCED: a rendered row is never suppressed' USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM booking.notification_latches l WHERE l.operation_id = NEW.id) THEN
      RAISE EXCEPTION 'NOTIFY_LATCHED: a latched row is owner-visible and is never suppressed' USING ERRCODE = 'check_violation';
    END IF;
    SELECT state, settlement_recording_mirrored, settlement_reservation_cancelled, settlement_authorization_settled, offline_charge_id
      INTO i_state, i_mirrored, i_rc, i_as, i_och FROM booking.intents WHERE id = NEW.intent_id;
    IF (NEW.payload ->> 'template') IS DISTINCT FROM 'booking_confirmed' OR i_state IS DISTINCT FROM 'test_cleanup_pending' OR i_mirrored IS NOT FALSE
       OR i_rc IS NOT FALSE OR i_as IS NOT FALSE OR i_och IS NULL OR (SELECT environment FROM booking.instance) IS DISTINCT FROM 'test' THEN
      RAISE EXCEPTION 'NOTIFY_SUPPRESS_FENCED: only the booking_confirmed row of a recorded TEST cleanup being requested' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.state = 'in_flight' AND NEW.state = 'succeeded' THEN
    IF NOT booking.is_privileged() THEN
      RAISE EXCEPTION 'NOTIFY_COMPLETE_AUTHORITY: completed only through booking.complete_guest_notification' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM booking.notification_write_authority a WHERE a.txid = pg_current_xact_id() AND a.operation_id = NEW.id AND a.action = 'complete') THEN
      RAISE EXCEPTION 'NOTIFY_COMPLETE_AUTHORITY: no completion token in this transaction' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.attempts <> OLD.attempts OR NEW.dispatched_at IS DISTINCT FROM OLD.dispatched_at OR NEW.lease_worker_id IS NOT NULL OR NEW.lease_until IS NOT NULL
       OR NEW.completed_at IS NULL OR NEW.error_code IS NOT NULL OR NEW.result_ref IS NULL
       OR NOT (NEW.result_ref ~ '^mock-[A-Za-z0-9._:-]{1,95}$'                                                       -- [0023] the 0021 mock id, unchanged
               OR (NEW.result_ref ~ '^resend:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'          -- [0023] OR a typed Resend receipt
                   AND EXISTS (SELECT 1 FROM booking.notification_provider_receipts p JOIN booking.notification_renders rr ON rr.operation_id = p.operation_id
                               WHERE p.operation_id = NEW.id AND rr.template_version = 'gn-v2' AND p.content_hash = rr.content_hash
                                 AND NEW.result_ref = 'resend:' || p.provider_message_id::text)))
       OR NOT EXISTS (SELECT 1 FROM booking.notification_renders r WHERE r.operation_id = NEW.id) THEN
      RAISE EXCEPTION 'NOTIFY_COMPLETE_FENCED: succeeded needs a render, a cleared lease and a mock result id or a bound gn-v2 Resend receipt' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.state = 'in_flight' AND NEW.state = 'outcome_unknown' THEN
    -- the fail-safe direction: any role (generic markUnknown, the dedicated completion / maintenance)
    IF NEW.attempts <> OLD.attempts OR NEW.dispatched_at IS DISTINCT FROM OLD.dispatched_at OR NEW.lease_worker_id IS NOT NULL OR NEW.lease_until IS NOT NULL
       OR NEW.result_ref IS NOT NULL OR NEW.error_code IS NULL THEN
      RAISE EXCEPTION 'NOTIFY_UNKNOWN_FENCED: unknown keeps attempts / dispatch, clears the lease, records a code' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'NOTIFY_TRANSITION_REFUSED: guest.notify % -> % is not allowed (no resend, no reset, no owner settlement in v1)', OLD.state, NEW.state
    USING ERRCODE = 'check_violation';
END $$;
