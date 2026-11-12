-- 0020_test_refund_evidence_settlement (up) — DISPOSABLE LOCAL test databases only. LOCAL MIGRATION CANDIDATE (ROOT GO on the cleanup worker slice).
--
-- Problem: the accepted runtime settlement of an ambiguous provider write, booking.settle_operation_from_evidence (0004 / 0005), dispatches on
-- op_type with a trailing ELSE that ASSUMES hostaway.cancel_reservation. The 0019 refund write (stripe.refund_payment_intent, reconcile_first) is
-- not one of its explicit branches: a refund row reaching it would fall through to the Hostaway-cancel branch (refused today only because a
-- stripe_refund evidence row never carries the reservation id). Nothing may settle the ONE refund row by an accidental branch or by a direct UPDATE.
--
-- Fix (smallest explicit API; TRUST BOUNDARY stated below):
--   1. booking.settle_test_refund_from_evidence(op, evidence): the ONLY settlement path for an outcome_unknown refund row — TEST instance + TEST intent
--      in test_cleanup_pending; the row is THE 0019 refund row (reconcile_first, dispatched, payload bound to the intent's PI); the evidence is an API
--      `stripe_refund` read of the same intent, observed ≥ dispatch + 2 min, whose strictly typed identity / money fields equal the row's payload AND
--      the intent's captured amount / currency; decision: succeeded → 'succeeded' (result_ref = the refund id); failed | canceled → 'failed_definite'
--      (error_code RECONCILED_REFUND_<STATUS>); pending | requires_action → EVIDENCE_INCONCLUSIVE (not settled). settled_evidence_id is set once (0008
--      keeps it immutable). No event, no ledger, no payment_refunds change here: the legal REFUND_* event (repo.js) + the 0019 guards decide those.
--   2. booking.settle_operation_from_evidence: the 0005 body with its trailing ELSE made EXPLICIT (ELSIF op.op_type = 'hostaway.cancel_reservation')
--      and every other op_type refused with OP_TYPE_NOT_SETTLEABLE — the refund row (and any future write type) can never fall through.
-- TRUST BOUNDARY (unchanged from 0005 / 0008): the database binds evidence to a succeeded read of the runtime role; it cannot authenticate the
-- provider. Only verified executed API reads may be recorded; the settlement here moves ONE row state from the cited evidence and nothing else.
-- Down restores the 0005 body byte-for-byte and drops the new function (fails by design if a row was settled through it).

CREATE FUNCTION booking.settle_test_refund_from_evidence(p_op uuid, p_evidence uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
DECLARE op booking.external_operations%ROWTYPE; e booking.provider_evidence%ROWTYPE; i record; decision text; st text;
BEGIN
  SELECT * INTO op FROM booking.external_operations WHERE id = p_op FOR UPDATE;
  IF NOT FOUND OR op.op_type <> 'stripe.refund_payment_intent' OR op.retry_class <> 'reconcile_first' OR op.state <> 'outcome_unknown'
     OR op.dispatched_at IS NULL OR op.settled_evidence_id IS NOT NULL THEN
    RAISE EXCEPTION 'NOT_SETTLEABLE' USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT environment FROM booking.instance) IS DISTINCT FROM 'test' THEN
    RAISE EXCEPTION 'TEST_CLEANUP_NOT_TEST' USING ERRCODE = 'check_violation';
  END IF;
  SELECT environment, state, currency, captured_minor, stripe_payment_intent_id INTO i FROM booking.intents WHERE id = op.intent_id;
  IF NOT FOUND OR i.environment <> 'test' THEN
    RAISE EXCEPTION 'TEST_CLEANUP_NOT_TEST' USING ERRCODE = 'check_violation';
  END IF;
  IF i.state <> 'test_cleanup_pending' OR i.captured_minor IS NULL OR i.captured_minor <= 0 OR i.stripe_payment_intent_id IS DISTINCT FROM op.payload ->> 'paymentIntentId'
     OR (op.payload ->> 'attempt') IS DISTINCT FROM '1' OR (op.payload ->> 'amountMinor')::bigint <> i.captured_minor
     OR upper(op.payload ->> 'currency') IS DISTINCT FROM upper(i.currency) OR op.payload ->> 'providerIdempotencyKey' IS DISTINCT FROM 'ref:' || op.intent_id::text || ':1' THEN
    RAISE EXCEPTION 'REFUND_ROW_NOT_BOUND' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO e FROM booking.provider_evidence WHERE id = p_evidence;
  IF NOT FOUND OR e.intent_id <> op.intent_id OR e.kind <> 'stripe_refund' OR e.source <> 'stripe_api' THEN
    RAISE EXCEPTION 'EVIDENCE_NOT_ACCEPTABLE' USING ERRCODE = 'check_violation';
  END IF;
  IF e.observed_at < op.dispatched_at + interval '2 minutes' THEN
    RAISE EXCEPTION 'EVIDENCE_TOO_EARLY' USING ERRCODE = 'check_violation';
  END IF;
  -- strictly typed identity / money binding: the Refund object read must be OUR refund (PI, charge, exact captured amount, currency)
  IF jsonb_typeof(e.observed -> 'refundId') IS DISTINCT FROM 'string' OR e.observed ->> 'refundId' <> e.external_ref OR e.external_ref !~ '^re_[A-Za-z0-9_]{1,200}$'
     OR jsonb_typeof(e.observed -> 'paymentIntentId') IS DISTINCT FROM 'string' OR e.observed ->> 'paymentIntentId' <> op.payload ->> 'paymentIntentId'
     OR jsonb_typeof(e.observed -> 'chargeId') IS DISTINCT FROM 'string' OR e.observed ->> 'chargeId' <> op.payload ->> 'chargeId'
     OR jsonb_typeof(e.observed -> 'amountMinor') IS DISTINCT FROM 'number' OR (e.observed ->> 'amountMinor')::numeric <> (op.payload ->> 'amountMinor')::numeric
     OR (e.observed ->> 'amountMinor')::numeric <> i.captured_minor
     OR jsonb_typeof(e.observed -> 'currency') IS DISTINCT FROM 'string' OR upper(e.observed ->> 'currency') <> upper(op.payload ->> 'currency')
     OR jsonb_typeof(e.observed -> 'status') IS DISTINCT FROM 'string' OR e.observed ->> 'status' <> e.status THEN
    RAISE EXCEPTION 'EVIDENCE_REF_MISMATCH' USING ERRCODE = 'check_violation';
  END IF;
  st := e.status;
  decision := CASE WHEN st = 'succeeded' THEN 'succeeded' WHEN st IN ('failed', 'canceled') THEN 'failed_definite' END;
  IF decision IS NULL THEN RAISE EXCEPTION 'EVIDENCE_INCONCLUSIVE' USING ERRCODE = 'check_violation'; END IF;   -- pending / requires_action
  UPDATE booking.external_operations
     SET state = decision, completed_at = e.observed_at, settled_evidence_id = e.id, result_ref = e.external_ref,
         error_code = CASE WHEN decision = 'failed_definite' THEN 'RECONCILED_REFUND_' || upper(st) END, updated_at = e.observed_at
   WHERE id = op.id;
  RETURN decision;
END $$;
REVOKE ALL ON FUNCTION booking.settle_test_refund_from_evidence(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION booking.settle_test_refund_from_evidence(uuid, uuid) TO mv_booking_app;

-- the accepted generic settlement (0005 body) with its trailing ELSE made explicit; every other op_type (incl. the refund write) is refused
CREATE OR REPLACE FUNCTION booking.settle_operation_from_evidence(p_op uuid, p_evidence uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
DECLARE op booking.external_operations%ROWTYPE; e booking.provider_evidence%ROWTYPE; i booking.intents%ROWTYPE; decision text;
BEGIN
  SELECT * INTO op FROM booking.external_operations WHERE id = p_op FOR UPDATE;
  IF NOT FOUND OR op.retry_class <> 'reconcile_first' OR op.state <> 'outcome_unknown' THEN
    RAISE EXCEPTION 'NOT_SETTLEABLE' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO e FROM booking.provider_evidence WHERE id = p_evidence;
  IF NOT FOUND OR e.intent_id <> op.intent_id OR e.source NOT IN ('stripe_api', 'hostaway_api') THEN
    RAISE EXCEPTION 'EVIDENCE_NOT_ACCEPTABLE' USING ERRCODE = 'check_violation';
  END IF;
  IF e.observed_at < coalesce(op.dispatched_at, op.created_at) + interval '2 minutes' THEN
    RAISE EXCEPTION 'EVIDENCE_TOO_EARLY' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO i FROM booking.intents WHERE id = op.intent_id;
  IF op.op_type = 'stripe.create_checkout_session' THEN
    IF e.kind <> 'checkout_session' OR e.status NOT IN ('open', 'complete', 'expired') THEN
      RAISE EXCEPTION 'EVIDENCE_INCONCLUSIVE' USING ERRCODE = 'check_violation';
    END IF;
    IF e.observed ->> 'paymentAttemptId' IS DISTINCT FROM op.payload ->> 'paymentAttemptId' THEN
      RAISE EXCEPTION 'EVIDENCE_REF_MISMATCH' USING ERRCODE = 'check_violation';
    END IF;
    decision := 'succeeded';   -- the session exists: the create applied
  ELSIF op.op_type IN ('stripe.capture_payment_intent', 'stripe.void_payment_intent') THEN
    IF e.kind <> 'payment_intent' OR e.external_ref IS DISTINCT FROM op.payload ->> 'paymentIntentId' THEN
      RAISE EXCEPTION 'EVIDENCE_REF_MISMATCH' USING ERRCODE = 'check_violation';
    END IF;
    IF op.op_type = 'stripe.capture_payment_intent' THEN
      decision := CASE WHEN e.status = 'succeeded' AND (e.observed ->> 'amountReceivedMinor')::bigint = i.final_total_minor THEN 'succeeded'
                       WHEN e.status IN ('requires_capture', 'canceled', 'requires_payment_method') THEN 'failed_definite' END;
    ELSE
      decision := CASE WHEN e.status = 'canceled' THEN 'succeeded'
                       WHEN e.status IN ('requires_capture', 'succeeded') THEN 'failed_definite' END;
    END IF;
  ELSIF op.op_type = 'hostaway.cancel_reservation' THEN
    IF e.kind <> 'hostaway_reservation' OR e.external_ref IS DISTINCT FROM op.payload ->> 'reservationId' THEN
      RAISE EXCEPTION 'EVIDENCE_REF_MISMATCH' USING ERRCODE = 'check_violation';
    END IF;
    decision := CASE WHEN e.status = 'cancelled' THEN 'succeeded' WHEN e.status = 'found_active' THEN 'failed_definite' END;
  ELSE
    -- 0020: never an implicit branch — the 0019 refund write has its own explicit settlement (booking.settle_test_refund_from_evidence)
    RAISE EXCEPTION 'OP_TYPE_NOT_SETTLEABLE' USING ERRCODE = 'check_violation';
  END IF;
  IF decision IS NULL THEN RAISE EXCEPTION 'EVIDENCE_INCONCLUSIVE' USING ERRCODE = 'check_violation'; END IF;
  UPDATE booking.external_operations
     SET state = decision, completed_at = e.observed_at, settled_evidence_id = e.id, result_ref = e.external_ref,
         error_code = CASE WHEN decision = 'failed_definite' THEN 'RECONCILED_NOT_APPLIED' END, updated_at = e.observed_at
   WHERE id = op.id;
  -- the case opened for an unknown Checkout create is settled by the same evidence
  UPDATE booking.reconciliation_cases SET status = 'resolved', resolution = 'recorded', resolved_by = 'reconciler', resolved_at = e.observed_at
   WHERE intent_id = op.intent_id AND opened_by = 'op:' || op.id::text AND status = 'open';
  RETURN decision;
END $$;
