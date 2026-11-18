-- 0028_pipeline_kickoff_source_rebind_s4 (up) — Stage E7 C119 S4: rebind ONLY the reviewed ENABLE source-digest LITERAL in booking.claim_pipeline_kickoff.
-- Base: schema 27 (0027 applied). DISPOSABLE LOCAL test databases by this task; any shared TEST apply is a separate, reviewed packet.
--
--   * The pipeline runner gained its C119 S4 admission gates (arm job, live-main fresh admission, labelled arm gate, durable request binding,
--     environment e7-test-auto), so its reviewed ENABLE frame moved 880db5b3… → 5294b6b4… = the UNCHANGED C102 ENABLE delta applied to the S4
--     CLOSED pipeline frame ca63c1d7… at main draft commit 8c8c2d58 (see lib/checkout/pipeline-kickoff-plan.js PINNED_REVISION).
--   * CREATE OR REPLACE of the SAME function: same signature / return type / LANGUAGE plpgsql / VOLATILE / SECURITY DEFINER / SET search_path =
--     pg_catalog, booking; the OID, OWNER and ACL are kept (the 0024 REVOKE ALL … FROM PUBLIC and the ONE GRANT EXECUTE TO mv_booking_app stay; no
--     grant is added). The body is BYTE-IDENTICAL to 0026 except the one expected_source_digest literal; every claim condition, lock order, refusal
--     code and the closure-digest literal f7d7cad6… are unchanged. No table, row, trigger, policy or other function is touched (0027 untouched).
--   * The down migration restores the exact 0026 body (literal 880db5b3…).
CREATE OR REPLACE FUNCTION booking.claim_pipeline_kickoff(p_intent uuid, p_worker text, p_plan_hash text, p_inputs jsonb) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
DECLARE i booking.intents%ROWTYPE; r booking.pipeline_kickoff_requests%ROWTYPE; v_why text; v_expected jsonb;
BEGIN
  IF p_intent IS NULL OR p_worker IS NULL OR p_worker !~ '^[A-Za-z0-9._:-]{1,100}$' OR p_plan_hash IS NULL OR p_plan_hash !~ '^[0-9a-f]{64}$'
     OR p_inputs IS NULL OR jsonb_typeof(p_inputs) <> 'object' THEN
    RAISE EXCEPTION 'KICKOFF_ARGUMENT_INVALID' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO i FROM booking.intents WHERE id = p_intent FOR SHARE;                -- lock order: intent, then request (as applyEvent → trigger)
  SELECT * INTO r FROM booking.pipeline_kickoff_requests WHERE intent_id = p_intent FOR UPDATE;
  IF NOT FOUND THEN RETURN 'NO_REQUEST'; END IF;
  IF r.state <> 'requested' THEN RETURN 'NOT_REQUESTED:' || upper(r.state); END IF;
  v_why := CASE WHEN i.id IS NULL THEN 'INTENT_NOT_FOUND' ELSE booking.pipeline_kickoff_refusal(i, r) END;
  IF v_why IS NULL THEN
    v_expected := jsonb_build_object(
      'mode', 'execute', 'approval_ref', 'E7-KICKOFF-' || r.ref || '-v' || r.authorized_version, 'intent_id', r.intent_id::text, 'booking_ref', r.ref,
      'expected_version', r.authorized_version::text,
      'not_before', to_char(date_trunc('milliseconds', r.intent_created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'payment_intent_id', r.payment_intent_id, 'amount_minor', r.amount_minor::text, 'currency', 'USD', 'expected_plan_hash', p_plan_hash,
      -- C108-F2: the reviewed ENABLE revision's source / closure digests are LITERAL here (never copied from the caller)
      'expected_source_digest', '5294b6b467839e1dd825e56063abc1ad1267eafdfb2973f2c2129e9b1f29c3f5',
      'expected_closure_digest', 'f7d7cad646eaed2fb37a63e031157732ee6e2a44824f9d935d6b9104e08f7273');
    IF p_inputs IS DISTINCT FROM v_expected THEN
      v_why := 'INPUTS_NOT_BOUND';
    END IF;
  END IF;
  IF v_why IS NOT NULL THEN
    UPDATE booking.pipeline_kickoff_requests SET state = 'refused', settled_at = clock_timestamp(), outcome_code = v_why WHERE intent_id = p_intent;
    RETURN 'REFUSED:' || v_why;
  END IF;
  UPDATE booking.pipeline_kickoff_requests SET state = 'claimed', claim_worker = p_worker, claimed_at = clock_timestamp(), plan_hash = p_plan_hash,
    dispatch_inputs = p_inputs WHERE intent_id = p_intent;
  RETURN 'CLAIMED';
END $$;
