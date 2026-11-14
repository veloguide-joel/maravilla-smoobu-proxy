-- 0023_gn_v2_resend_receipts (down) — DISPOSABLE LOCAL test databases only. REFUSED while ANY provider receipt exists or any guest.notify
-- operation carries a 'resend:' result (provider evidence is never deleted or rewritten to roll back). Otherwise restores the exact 0021
-- notify_op_fence body (verbatim) and drops the 0023 completion, binding trigger function and receipt table.
LOCK TABLE booking.external_operations, booking.notification_renders IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM booking.notification_provider_receipts)
     OR EXISTS (SELECT 1 FROM booking.external_operations WHERE op_type = 'guest.notify' AND result_ref LIKE 'resend:%') THEN
    RAISE EXCEPTION 'MIGRATION_0023_DOWN_REFUSED: Resend provider evidence exists' USING ERRCODE = 'check_violation';
  END IF;
END $$;

-- the 0021 fence body, verbatim
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
       OR NEW.completed_at IS NULL OR NEW.error_code IS NOT NULL OR NEW.result_ref IS NULL OR NEW.result_ref !~ '^mock-[A-Za-z0-9._:-]{1,95}$'
       OR NOT EXISTS (SELECT 1 FROM booking.notification_renders r WHERE r.operation_id = NEW.id) THEN
      RAISE EXCEPTION 'NOTIFY_COMPLETE_FENCED: succeeded needs a render, a cleared lease and a mock result id' USING ERRCODE = 'check_violation';
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

DROP FUNCTION booking.complete_guest_notification_resend(uuid, text, text, uuid, boolean, text);
DROP TABLE booking.notification_provider_receipts;
DROP FUNCTION booking.notification_provider_receipt_binding();
