-- 0021_recorded_cleanup_foundation (down) — LOCAL MIGRATION CANDIDATE. Removes the recorded-cleanup foundation exactly and restores
-- booking.intents_safety_guard() to its 0019 body and booking.notify_op_fence() to its 0016 body (both byte-identical copies).
-- Refuses (by design) if the foundation was USED: any intent with a mirror leg, any mirror op row, any suppression audit row, any
-- offline_charge_refund_recorded ledger entry — none of that can be rolled back honestly.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM booking.intents WHERE settlement_recording_mirrored IS NOT NULL)
     OR EXISTS (SELECT 1 FROM booking.external_operations WHERE op_type = 'hostaway.refund_offline_charge')
     OR EXISTS (SELECT 1 FROM booking.notification_suppressions)
     OR EXISTS (SELECT 1 FROM booking.external_operations WHERE op_type = 'guest.notify' AND state = 'superseded')
     OR EXISTS (SELECT 1 FROM booking.payment_ledger WHERE entry = 'offline_charge_refund_recorded') THEN
    RAISE EXCEPTION 'the recorded-cleanup foundation was used (mirror leg / mirror op / suppression / ledger): it cannot be rolled back' USING ERRCODE = 'check_violation';
  END IF;
END $$;

-- 8 / 7 / 6 / 4: functions, triggers, table (reverse order)
DROP FUNCTION booking.recorded_state_cleanup_ok(uuid);
DROP FUNCTION booking.suppress_guest_notification(uuid, text);
DROP TRIGGER notification_suppressions_bound ON booking.notification_suppressions;
DROP FUNCTION booking.notification_suppressions_bound();
DROP TRIGGER notify_suppression_audit_required ON booking.external_operations;
DROP FUNCTION booking.notify_suppression_audit_required();
DROP FUNCTION booking.complete_offline_refund_with_evidence(uuid, text, uuid, text, integer);
DROP TRIGGER external_operations_offline_refund_success_fence ON booking.external_operations;
DROP FUNCTION booking.offline_refund_success_fence();
DROP TRIGGER external_operations_offline_refund_claim_fence ON booking.external_operations;
DROP FUNCTION booking.offline_refund_claim_fence();
DROP TRIGGER external_operations_offline_refund_create_fence ON booking.external_operations;
DROP FUNCTION booking.offline_refund_create_fence();

-- 7. notify_op_fence: the 0016 body exactly
CREATE OR REPLACE FUNCTION booking.notify_op_fence() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, booking AS $$
DECLARE i_state text; i_version integer; t text;
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

-- 5. intents_safety_guard: the 0019 body exactly
CREATE OR REPLACE FUNCTION booking.intents_safety_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
DECLARE r booking.reconciliation_resolutions%ROWTYPE; want text; sess text;
BEGIN
  IF NEW.settlement_reservation_cancelled IS TRUE AND OLD.settlement_reservation_cancelled IS NOT TRUE AND NOT (
       EXISTS (SELECT 1 FROM booking.external_operations
                WHERE intent_id = NEW.id AND op_type = 'hostaway.cancel_reservation' AND state = 'succeeded')
       AND EXISTS (SELECT 1 FROM booking.provider_evidence
                    WHERE intent_id = NEW.id AND kind = 'hostaway_reservation' AND external_ref = NEW.hostaway_reservation_id
                      AND status = 'cancelled')) THEN
    RAISE EXCEPTION 'CANCELLATION_NOT_VERIFIED' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.settlement_authorization_settled IS TRUE AND OLD.settlement_authorization_settled IS NOT TRUE
     AND NOT (booking.authorization_settled_for(NEW.id, NEW.stripe_payment_intent_id)
              OR (OLD.state = 'test_cleanup_pending' AND booking.test_refund_settled_for(NEW.id, NEW.stripe_payment_intent_id))) THEN
    RAISE EXCEPTION 'AUTHORIZATION_NOT_VERIFIED_SETTLED' USING ERRCODE = 'check_violation';
  END IF;
  IF (OLD.settlement_reservation_cancelled IS TRUE AND NEW.settlement_reservation_cancelled IS NOT TRUE)
     OR (OLD.settlement_authorization_settled IS TRUE AND NEW.settlement_authorization_settled IS NOT TRUE) THEN
    RAISE EXCEPTION 'settlement legs only move forward' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state IS NOT DISTINCT FROM OLD.state THEN RETURN NEW; END IF;

  IF NEW.state IN ('payment_pending', 'payment_authorized', 'reservation_pending', 'reservation_unknown', 'reservation_failed',
                   'reservation_confirmed', 'capture_unknown', 'capture_failed', 'payment_captured', 'confirmed', 'test_cleanup_pending')
     AND NOT EXISTS (SELECT 1 FROM booking.inventory_claims WHERE intent_id = NEW.id AND released_at IS NULL) THEN
    RAISE EXCEPTION 'CLAIM_REQUIRED: % requires an active date claim', NEW.state USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.state IN ('payment_failed', 'payment_expired') THEN
    sess := coalesce(NEW.checkout_session_id, OLD.checkout_session_id);
    IF sess IS NULL OR NOT EXISTS (SELECT 1 FROM booking.provider_evidence
                                    WHERE intent_id = NEW.id AND kind = 'checkout_session' AND external_ref = sess AND status = 'expired') THEN
      RAISE EXCEPTION 'CHECKOUT_EXPIRY_NOT_VERIFIED' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF OLD.state = 'reservation_failed' AND NEW.state = 'authorization_released'
     AND NOT booking.authorization_settled_for(NEW.id, NEW.stripe_payment_intent_id) THEN
    RAISE EXCEPTION 'VOID_NOT_VERIFIED' USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.state = 'capture_failed' AND NEW.state = 'cancelled'
     AND NOT (NEW.settlement_reservation_cancelled IS TRUE AND NEW.settlement_authorization_settled IS TRUE) THEN
    RAISE EXCEPTION 'CANCELLATION_NOT_VERIFIED' USING ERRCODE = 'check_violation';
  END IF;
  -- 0019: the TEST cleanup terminal: both legs flagged AND the refund settlement re-verified at this instant
  IF OLD.state = 'test_cleanup_pending' AND NEW.state = 'cancelled'
     AND NOT (NEW.settlement_reservation_cancelled IS TRUE AND NEW.settlement_authorization_settled IS TRUE
              AND booking.test_refund_settled_for(NEW.id, NEW.stripe_payment_intent_id)) THEN
    RAISE EXCEPTION 'CANCELLATION_NOT_VERIFIED' USING ERRCODE = 'check_violation';
  END IF;
  -- 0019: payment_captured leaves ONLY to confirmed / reconciliation_required (existing) or test_cleanup_pending on a TEST instance
  IF OLD.state = 'payment_captured' AND NEW.state = 'test_cleanup_pending'
     AND ((SELECT environment FROM booking.instance) IS DISTINCT FROM 'test' OR NEW.environment <> 'test' OR NEW.captured_minor IS NULL OR NEW.captured_minor <= 0) THEN
    RAISE EXCEPTION 'TEST_CLEANUP_NOT_TEST' USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.state = 'reconciliation_required' THEN
    want := CASE NEW.state WHEN 'confirmed' THEN 'intent_confirmed' WHEN 'authorization_released' THEN 'intent_released'
                           WHEN 'cancelled' THEN 'intent_cancelled' END;
    SELECT * INTO r FROM booking.reconciliation_resolutions
     WHERE intent_id = NEW.id AND decision = want AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'RESOLUTION_REQUIRED: % from reconciliation_required needs an owner resolution', NEW.state USING ERRCODE = 'check_violation';
    END IF;
    IF want = 'intent_confirmed' AND NEW.hostaway_reservation_id IS DISTINCT FROM r.result_ref THEN
      RAISE EXCEPTION 'RESOLUTION_MISMATCH' USING ERRCODE = 'check_violation';
    END IF;
    UPDATE booking.reconciliation_resolutions SET consumed_at = NEW.updated_at, consumed_version = NEW.version WHERE id = r.id;
    UPDATE booking.reconciliation_cases SET status = 'resolved',
           resolution = CASE want WHEN 'intent_confirmed' THEN 'confirmed' WHEN 'intent_released' THEN 'released' ELSE 'cancelled' END,
           resolved_by = r.resolver, resolved_at = NEW.updated_at
     WHERE intent_id = NEW.id AND status = 'open'
       AND NOT starts_with(kind, 'OFFLINE_CHARGE_HOLD_');
  END IF;
  RETURN NEW;
END $$;

-- 4c. intents_guard: the 0001 body exactly
CREATE OR REPLACE FUNCTION booking.intents_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE env text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT environment INTO env FROM booking.instance;
    IF NEW.environment IS DISTINCT FROM env THEN
      RAISE EXCEPTION 'intent environment % does not match database environment %', NEW.environment, env
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.version <> 0 OR NEW.state <> 'created' THEN
      RAISE EXCEPTION 'new intents start at version 0 in state created' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  -- UPDATE: compare-and-swap discipline — every committed change is exactly one version step.
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'version must advance by exactly 1 (old %, new %)', OLD.version, NEW.version
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.id <> OLD.id OR NEW.ref <> OLD.ref OR NEW.access_token_hash <> OLD.access_token_hash
     OR NEW.machine_version <> OLD.machine_version OR NEW.environment <> OLD.environment
     OR NEW.created_at <> OLD.created_at OR NEW.listing_id <> OLD.listing_id
     OR NEW.from_date <> OLD.from_date OR NEW.to_date <> OLD.to_date OR NEW.guests <> OLD.guests THEN
    RAISE EXCEPTION 'intent identity and stay are immutable' USING ERRCODE = 'check_violation';
  END IF;
  -- "A different price needs a new intent": once priced, the price never changes.
  IF OLD.final_total_minor IS NOT NULL AND (
       NEW.price_snapshot IS DISTINCT FROM OLD.price_snapshot OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.final_total_minor IS DISTINCT FROM OLD.final_total_minor OR NEW.quote_hash IS DISTINCT FROM OLD.quote_hash
    OR NEW.quote_expires_at IS DISTINCT FROM OLD.quote_expires_at) THEN
    RAISE EXCEPTION 'price is immutable after PRICE_CONFIRMED' USING ERRCODE = 'check_violation';
  END IF;
  -- An accepted authorization is never replaced by another PaymentIntent.
  IF OLD.stripe_payment_intent_id IS NOT NULL AND NEW.stripe_payment_intent_id IS DISTINCT FROM OLD.stripe_payment_intent_id THEN
    RAISE EXCEPTION 'accepted PaymentIntent is immutable' USING ERRCODE = 'check_violation';
  END IF;
  -- A recorded Hostaway reservation is never replaced.
  IF OLD.hostaway_reservation_id IS NOT NULL AND NEW.hostaway_reservation_id IS DISTINCT FROM OLD.hostaway_reservation_id THEN
    RAISE EXCEPTION 'Hostaway reservation id is immutable' USING ERRCODE = 'check_violation';
  END IF;
  -- Once a create may have been sent, the dispatch record is never cleared (write-before-send, R1).
  IF OLD.dispatch_at IS NOT NULL AND NEW.dispatch_at IS DISTINCT FROM OLD.dispatch_at THEN
    RAISE EXCEPTION 'dispatch record is immutable once set' USING ERRCODE = 'check_violation';
  END IF;
  -- E3 terminal states accept only escalation to reconciliation (late money on a closed intent).
  IF booking.is_terminal_state(OLD.state) AND NEW.state NOT IN (OLD.state, 'reconciliation_required') THEN
    RAISE EXCEPTION 'terminal state % cannot move to %', OLD.state, NEW.state USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.captured_minor < OLD.captured_minor THEN
    RAISE EXCEPTION 'captured amount cannot decrease (refunds are recorded separately)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- 4b. claim_release_blockers: the 0019 body exactly
CREATE OR REPLACE FUNCTION booking.claim_release_blockers(p_intent uuid) RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
DECLARE s text; td date; out text[] := '{}'; r record;
BEGIN
  SELECT state, to_date INTO s, td FROM booking.intents WHERE id = p_intent;
  IF s IS NULL THEN RETURN ARRAY['INTENT_NOT_FOUND']; END IF;
  IF s = 'confirmed' THEN
    IF td <= (statement_timestamp() AT TIME ZONE 'America/Mexico_City')::date THEN RETURN '{}'; END IF;
    RETURN ARRAY['STAY_NOT_COMPLETED'];
  END IF;
  IF s NOT IN ('validation_failed', 'expired', 'payment_failed', 'payment_expired', 'authorization_released', 'cancelled') THEN
    RETURN ARRAY['STATE_NOT_RELEASABLE:' || s];
  END IF;
  FOR r IN SELECT id, status FROM booking.payment_attempts WHERE intent_id = p_intent AND status IN ('creating', 'open', 'outcome_unknown') LOOP
    out := out || ('PAYMENT_ATTEMPT_UNRESOLVED:' || r.status);
  END LOOP;
  out := out || booking.authorization_blockers(p_intent) || booking.reservation_blockers(p_intent);
  FOR r IN SELECT op_type, state FROM booking.external_operations
            WHERE intent_id = p_intent AND state IN ('pending', 'in_flight', 'outcome_unknown', 'escalated')
              AND op_type IN ('stripe.create_checkout_session', 'stripe.capture_payment_intent', 'stripe.void_payment_intent',
                              'hostaway.create_reservation', 'hostaway.cancel_reservation', 'hostaway.record_offline_charge', 'stripe.refund_payment_intent')
              AND NOT (s = 'cancelled' AND op_type = 'stripe.capture_payment_intent' AND state = 'pending' AND attempts = 0
                       AND dispatched_at IS NULL AND lease_worker_id IS NULL AND lease_until IS NULL) LOOP
    out := out || ('PROVIDER_OPERATION_UNRESOLVED:' || r.op_type || ':' || r.state);
  END LOOP;
  FOR r IN SELECT kind FROM booking.reconciliation_cases WHERE intent_id = p_intent AND status = 'open' LOOP
    out := out || ('OPEN_CASE:' || r.kind);
  END LOOP;
  RETURN out;
END $$;

-- 4. proof functions
DROP FUNCTION booking.offline_refund_settled_for(uuid);
DROP FUNCTION booking.offline_refund_proof_refusal(uuid, jsonb, text, timestamptz, uuid, text, timestamptz);

-- 3. audit table
DROP TABLE booking.notification_suppressions;

-- 2. vocabulary: back to the 0019 / 0016 / 0001 definitions
ALTER TABLE booking.notification_write_authority DROP CONSTRAINT notification_write_authority_action_check;
ALTER TABLE booking.notification_write_authority ADD CONSTRAINT notification_write_authority_action_check CHECK (action IN ('claim', 'complete'));
ALTER TABLE booking.payment_ledger DROP CONSTRAINT payment_ledger_entry_check;
ALTER TABLE booking.payment_ledger ADD CONSTRAINT payment_ledger_entry_check CHECK (entry IN ('authorization_accepted', 'authorization_rejected', 'authorization_voided',
                 'capture_succeeded', 'refund_succeeded', 'refund_failed', 'offline_charge_recorded'));
DROP INDEX booking.external_operations_one_offline_refund_ever;
DROP INDEX booking.external_operations_one_open_provider_write;
CREATE UNIQUE INDEX external_operations_one_open_provider_write ON booking.external_operations
  (intent_id, op_type, (coalesce(payload ->> 'paymentIntentId', payload ->> 'reservationId')))
  WHERE op_type IN ('stripe.capture_payment_intent', 'stripe.void_payment_intent', 'hostaway.cancel_reservation', 'stripe.refund_payment_intent')
    AND state IN ('pending', 'in_flight', 'outcome_unknown', 'escalated');
ALTER TABLE booking.external_operations DROP CONSTRAINT ops_provider_writes_reconcile_first;
ALTER TABLE booking.external_operations ADD CONSTRAINT ops_provider_writes_reconcile_first
  CHECK (op_type NOT IN ('stripe.create_checkout_session', 'stripe.capture_payment_intent', 'stripe.void_payment_intent',
                         'hostaway.cancel_reservation', 'stripe.refund_payment_intent')
         OR retry_class = 'reconcile_first');
ALTER TABLE booking.external_operations DROP CONSTRAINT external_operations_op_type_check;
ALTER TABLE booking.external_operations ADD CONSTRAINT external_operations_op_type_check CHECK (op_type IN (
  'stripe.create_checkout_session', 'stripe.retrieve_checkout_session', 'stripe.retrieve_payment_intent',
  'stripe.capture_payment_intent', 'stripe.void_payment_intent',
  'hostaway.lookup_reservation', 'hostaway.retrieve_reservation', 'hostaway.list_offline_charges',
  'hostaway.create_reservation', 'hostaway.cancel_reservation', 'hostaway.record_offline_charge',
  'guest.notify', 'alert.owner',
  'stripe.refund_payment_intent', 'stripe.retrieve_refund'));

-- 1. the column
ALTER TABLE booking.intents DROP CONSTRAINT intents_recording_mirrored_needs_charge;
ALTER TABLE booking.intents DROP COLUMN settlement_recording_mirrored;
