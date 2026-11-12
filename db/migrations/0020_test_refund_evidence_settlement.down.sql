-- 0020_test_refund_evidence_settlement (down) — drops the explicit TEST refund settlement and restores booking.settle_operation_from_evidence to its
-- 0005 body exactly (the trailing ELSE assumption). Fails (by design) if any refund row was settled through the 0020 function.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM booking.external_operations WHERE op_type = 'stripe.refund_payment_intent' AND settled_evidence_id IS NOT NULL) THEN
    RAISE EXCEPTION 'a refund row is settled from evidence through 0020: it cannot be rolled back' USING ERRCODE = 'check_violation';
  END IF;
END $$;
DROP FUNCTION booking.settle_test_refund_from_evidence(uuid, uuid);

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
  ELSE -- hostaway.cancel_reservation
    IF e.kind <> 'hostaway_reservation' OR e.external_ref IS DISTINCT FROM op.payload ->> 'reservationId' THEN
      RAISE EXCEPTION 'EVIDENCE_REF_MISMATCH' USING ERRCODE = 'check_violation';
    END IF;
    decision := CASE WHEN e.status = 'cancelled' THEN 'succeeded' WHEN e.status = 'found_active' THEN 'failed_definite' END;
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
