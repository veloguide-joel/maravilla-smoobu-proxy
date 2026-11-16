-- 0024_pipeline_kickoff_requests (up) — Stage E7 C107: CLOSED durable accepted-checkout → hosted pipeline REQUEST / HANDOFF foundation (OFFLINE).
-- DISPOSABLE LOCAL test databases only (shared DEV is at 1..23; 0024 is NOT applied to it by this task). No worker, no transport, no runner,
-- no network; nothing here dispatches anything.
--
--   * booking.pipeline_kickoff_requests — at most ONE row per intent (PK intent_id). Written ONLY by:
--       - booking.pipeline_kickoff_record(): an AFTER UPDATE trigger on booking.intents that fires ONLY on the durable authorization commit
--         payment_pending → payment_authorized (the ONE transition E3 PAYMENT_AUTHORIZED makes; a duplicate / replayed authorization changes
--         no state and never fires it). It runs INSIDE the authorizing transaction: no authorization COMMIT → no request; a request never
--         exists without the committed authorization. INSERT … ON CONFLICT DO NOTHING (never a second row). It never raises for scope:
--         an out-of-scope authorization is simply not recorded (the authorization itself is never refused or rolled back by this table).
--         Scope (server facts only): TEST instance + TEST intent, listing 606998, USD, payment livemode false, PaymentIntent set,
--         authorized = final total, created_at >= 2026-11-15T22:58:01Z, not one of the known historical targets.
--       - booking.claim_pipeline_kickoff(): requested → claimed (single winner, row lock), after re-proving EVERY binding against the
--         locked intent row; any failed fact makes the row refused (terminal). Claimed is the ONE point after which a dispatch may be
--         attempted; it never returns to requested.
--       - booking.refuse_pipeline_kickoff(): requested → refused (a consumer-side admission refusal; terminal, no dispatch).
--       - booking.settle_pipeline_kickoff(): claimed → dispatch_accepted | dispatch_unknown | dispatch_refused (by the claiming worker
--         only; terminal). An ambiguous dispatch is dispatch_unknown — human-owned read-only reconciliation, NEVER re-dispatched. A row
--         left claimed (consumer crash / lost settle reply) is likewise human-owned and is never re-claimed.
--     A BEFORE INSERT / UPDATE guard admits only these shapes and only from a privileged (SECURITY DEFINER) context; DELETE / TRUNCATE are
--     refused. RLS + SELECT for app / admin; no INSERT / UPDATE / DELETE grant; EXECUTE on the three functions to mv_booking_app only.
--   * A request / claim / dispatch is NOT a booking, NOT an execution and NOT a completion; the intent state machine, public status
--     projection and every worker are unchanged.

DO $$
BEGIN
  IF to_regclass('booking.notification_provider_receipts') IS NULL THEN
    RAISE EXCEPTION 'MIGRATION_0024_PRECONDITION: 0023 is not applied' USING ERRCODE = 'check_violation';
  END IF;
END $$;

CREATE TABLE booking.pipeline_kickoff_requests (
  intent_id          uuid PRIMARY KEY REFERENCES booking.intents (id),
  ref                text NOT NULL CHECK (ref ~ '^MV-[A-Z0-9]{6,10}$'),
  authorized_version integer NOT NULL CHECK (authorized_version >= 1),
  payment_intent_id  text NOT NULL CHECK (payment_intent_id ~ '^pi_[A-Za-z0-9_]{1,250}$'),
  amount_minor       bigint NOT NULL CHECK (amount_minor > 0 AND amount_minor <= 99999999),
  currency           char(3) NOT NULL CHECK (currency = 'USD'),
  listing_id         integer NOT NULL CHECK (listing_id = 606998),
  intent_created_at  timestamptz NOT NULL CHECK (intent_created_at >= '2026-11-15T22:58:01Z'),
  requested_at       timestamptz NOT NULL,
  state              text NOT NULL CHECK (state IN ('requested', 'claimed', 'dispatch_accepted', 'dispatch_unknown', 'dispatch_refused', 'refused')),
  claim_worker       text CHECK (claim_worker IS NULL OR claim_worker ~ '^[A-Za-z0-9._:-]{1,100}$'),
  claimed_at         timestamptz,
  plan_hash          text CHECK (plan_hash IS NULL OR plan_hash ~ '^[0-9a-f]{64}$'),
  dispatch_inputs    jsonb CHECK (dispatch_inputs IS NULL OR jsonb_typeof(dispatch_inputs) = 'object'),
  settled_at         timestamptz,
  outcome_code       text CHECK (outcome_code IS NULL OR outcome_code ~ '^[A-Z0-9_:]{1,96}$'),
  CHECK (CASE state
    WHEN 'requested' THEN claim_worker IS NULL AND claimed_at IS NULL AND plan_hash IS NULL AND dispatch_inputs IS NULL AND settled_at IS NULL AND outcome_code IS NULL
    WHEN 'refused'   THEN claim_worker IS NULL AND claimed_at IS NULL AND plan_hash IS NULL AND dispatch_inputs IS NULL AND settled_at IS NOT NULL AND outcome_code IS NOT NULL
    WHEN 'claimed'   THEN claim_worker IS NOT NULL AND claimed_at IS NOT NULL AND plan_hash IS NOT NULL AND dispatch_inputs IS NOT NULL AND settled_at IS NULL AND outcome_code IS NULL
    ELSE claim_worker IS NOT NULL AND claimed_at IS NOT NULL AND plan_hash IS NOT NULL AND dispatch_inputs IS NOT NULL AND settled_at IS NOT NULL AND outcome_code IS NOT NULL END)
);
CREATE INDEX pipeline_kickoff_requests_requested ON booking.pipeline_kickoff_requests (requested_at) WHERE state = 'requested';

-- the guard: only the documented transitions, only from a SECURITY DEFINER context (the trigger / the three functions); never DELETE / TRUNCATE
CREATE FUNCTION booking.pipeline_kickoff_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, booking AS $$
BEGIN
  IF NOT booking.is_privileged() THEN
    RAISE EXCEPTION 'KICKOFF_IMMUTABLE: kickoff requests are written only by the authorization trigger and the kickoff functions' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'requested' THEN RAISE EXCEPTION 'KICKOFF_BINDING: a request is created requested' USING ERRCODE = 'check_violation'; END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - 'state' - 'claim_worker' - 'claimed_at' - 'plan_hash' - 'dispatch_inputs' - 'settled_at' - 'outcome_code')
     IS DISTINCT FROM (to_jsonb(OLD) - 'state' - 'claim_worker' - 'claimed_at' - 'plan_hash' - 'dispatch_inputs' - 'settled_at' - 'outcome_code') THEN
    RAISE EXCEPTION 'KICKOFF_IMMUTABLE: the bound request facts are frozen' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT ((OLD.state = 'requested' AND NEW.state IN ('claimed', 'refused'))
          OR (OLD.state = 'claimed' AND NEW.state IN ('dispatch_accepted', 'dispatch_unknown', 'dispatch_refused')
              AND NEW.claim_worker = OLD.claim_worker AND NEW.claimed_at = OLD.claimed_at AND NEW.plan_hash = OLD.plan_hash
              AND NEW.dispatch_inputs = OLD.dispatch_inputs)) THEN
    RAISE EXCEPTION 'KICKOFF_TRANSITION: % -> % is not a kickoff transition', OLD.state, NEW.state USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION booking.pipeline_kickoff_guard() FROM PUBLIC;
CREATE TRIGGER pipeline_kickoff_requests_guard BEFORE INSERT OR UPDATE ON booking.pipeline_kickoff_requests
  FOR EACH ROW EXECUTE FUNCTION booking.pipeline_kickoff_guard();
CREATE TRIGGER pipeline_kickoff_requests_no_delete BEFORE DELETE ON booking.pipeline_kickoff_requests
  FOR EACH ROW EXECUTE FUNCTION booking.reject_change();
CREATE TRIGGER pipeline_kickoff_requests_no_truncate BEFORE TRUNCATE ON booking.pipeline_kickoff_requests
  FOR EACH STATEMENT EXECUTE FUNCTION booking.reject_change();

ALTER TABLE booking.pipeline_kickoff_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON booking.pipeline_kickoff_requests FROM PUBLIC;
GRANT SELECT ON booking.pipeline_kickoff_requests TO mv_booking_app, mv_booking_admin;
CREATE POLICY app_admin_read ON booking.pipeline_kickoff_requests FOR SELECT TO mv_booking_app, mv_booking_admin USING (true);

-- the known historical targets (never requested, never claimed)
CREATE FUNCTION booking.pipeline_kickoff_excluded(p_intent uuid) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT p_intent = ANY (ARRAY['abede8b1-8ef6-44f2-876e-6a02fc056a96', 'c83c1842-d342-4e27-9ab7-dc3d50b7a309', '954d476c-71ea-4824-92f6-2220ae302103',
                               '669da884-02e8-4105-8825-f908e5d22ae9', '1d6e770f-ba3d-40f7-92c1-ee01be7da532']::uuid[])
$$;
REVOKE ALL ON FUNCTION booking.pipeline_kickoff_excluded(uuid) FROM PUBLIC;

-- the authorization-commit seam: runs in the authorizing transaction, after the payment_pending → payment_authorized row update
CREATE FUNCTION booking.pipeline_kickoff_record() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
BEGIN
  IF (SELECT environment FROM booking.instance) IS DISTINCT FROM 'test' OR NEW.environment <> 'test'
     OR NEW.listing_id <> 606998 OR NEW.currency IS DISTINCT FROM 'USD' OR NEW.payment_livemode IS DISTINCT FROM false
     OR NEW.stripe_payment_intent_id IS NULL OR NEW.stripe_payment_intent_id !~ '^pi_[A-Za-z0-9_]{1,250}$'
     OR NEW.final_total_minor IS NULL OR NEW.final_total_minor > 99999999 OR NEW.authorized_minor IS DISTINCT FROM NEW.final_total_minor
     OR NEW.created_at < '2026-11-15T22:58:01Z' OR booking.pipeline_kickoff_excluded(NEW.id) THEN
    RETURN NULL;                                                                     -- out of scope: nothing recorded, the authorization stands
  END IF;
  INSERT INTO booking.pipeline_kickoff_requests (intent_id, ref, authorized_version, payment_intent_id, amount_minor, currency, listing_id,
     intent_created_at, requested_at, state)
  VALUES (NEW.id, NEW.ref, NEW.version, NEW.stripe_payment_intent_id, NEW.final_total_minor, 'USD', NEW.listing_id, NEW.created_at,
     clock_timestamp(), 'requested')
  ON CONFLICT (intent_id) DO NOTHING;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION booking.pipeline_kickoff_record() FROM PUBLIC;
CREATE TRIGGER intents_pipeline_kickoff AFTER UPDATE OF state ON booking.intents
  FOR EACH ROW WHEN (OLD.state = 'payment_pending' AND NEW.state = 'payment_authorized')
  EXECUTE FUNCTION booking.pipeline_kickoff_record();

-- the fresh, locked admission facts (caller holds the intent row FOR SHARE and the request FOR UPDATE) → NULL | refusal code
CREATE FUNCTION booking.pipeline_kickoff_refusal(i booking.intents, r booking.pipeline_kickoff_requests) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
BEGIN
  IF (SELECT environment FROM booking.instance) IS DISTINCT FROM 'test' OR i.environment <> 'test' THEN RETURN 'NOT_TEST'; END IF;
  IF booking.pipeline_kickoff_excluded(i.id) THEN RETURN 'HISTORICAL_TARGET'; END IF;
  IF i.created_at < '2026-11-15T22:58:01Z' OR i.created_at IS DISTINCT FROM r.intent_created_at THEN RETURN 'HISTORIC_INTENT'; END IF;
  IF i.listing_id <> 606998 OR i.listing_id <> r.listing_id THEN RETURN 'LISTING_NOT_SCOPED'; END IF;
  IF i.state <> 'payment_authorized' THEN RETURN 'STATE_NOT_PAYMENT_AUTHORIZED'; END IF;
  IF i.version <> r.authorized_version THEN RETURN 'VERSION_STALE'; END IF;
  IF i.ref <> r.ref THEN RETURN 'REF_MISMATCH'; END IF;
  IF i.stripe_payment_intent_id IS DISTINCT FROM r.payment_intent_id THEN RETURN 'PAYMENT_INTENT_MISMATCH'; END IF;
  IF i.payment_livemode IS DISTINCT FROM false THEN RETURN 'LIVEMODE_NOT_FALSE'; END IF;
  IF i.currency IS DISTINCT FROM 'USD' OR i.final_total_minor IS DISTINCT FROM r.amount_minor OR i.authorized_minor IS DISTINCT FROM r.amount_minor
     OR i.captured_minor <> 0 THEN RETURN 'AMOUNT_MISMATCH'; END IF;
  IF i.hostaway_reservation_id IS NOT NULL OR i.offline_charge_id IS NOT NULL THEN RETURN 'ALREADY_PROGRESSED'; END IF;
  IF i.lease_worker_id IS NOT NULL OR i.dispatch_at IS NOT NULL THEN RETURN 'INTENT_LEASED'; END IF;
  IF EXISTS (SELECT 1 FROM booking.reconciliation_cases c WHERE c.intent_id = i.id AND c.status = 'open') THEN RETURN 'OPEN_CASE'; END IF;
  IF EXISTS (SELECT 1 FROM booking.external_operations o WHERE o.intent_id = i.id
               AND (o.state IN ('in_flight', 'outcome_unknown', 'escalated') OR o.op_type LIKE 'hostaway.%' OR o.lease_worker_id IS NOT NULL)) THEN
    RETURN 'OPERATION_NOT_SETTLED';
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION booking.pipeline_kickoff_refusal(booking.intents, booking.pipeline_kickoff_requests) FROM PUBLIC;

-- requested → claimed (the ONE winner) after re-proving every binding and the exact dispatch inputs; any failed fact → refused (terminal)
CREATE FUNCTION booking.claim_pipeline_kickoff(p_intent uuid, p_worker text, p_plan_hash text, p_inputs jsonb) RETURNS text
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
      'expected_source_digest', p_inputs ->> 'expected_source_digest', 'expected_closure_digest', p_inputs ->> 'expected_closure_digest');
    IF p_inputs IS DISTINCT FROM v_expected OR coalesce(p_inputs ->> 'expected_source_digest', '') !~ '^[0-9a-f]{64}$'
       OR coalesce(p_inputs ->> 'expected_closure_digest', '') !~ '^[0-9a-f]{64}$' THEN
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
REVOKE ALL ON FUNCTION booking.claim_pipeline_kickoff(uuid, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION booking.claim_pipeline_kickoff(uuid, text, text, jsonb) TO mv_booking_app;

-- requested → refused (consumer-side admission refusal; terminal)
CREATE FUNCTION booking.refuse_pipeline_kickoff(p_intent uuid, p_code text) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
DECLARE r booking.pipeline_kickoff_requests%ROWTYPE;
BEGIN
  IF p_intent IS NULL OR p_code IS NULL OR p_code !~ '^[A-Z0-9_:]{1,96}$' THEN RAISE EXCEPTION 'KICKOFF_ARGUMENT_INVALID' USING ERRCODE = 'invalid_parameter_value'; END IF;
  SELECT * INTO r FROM booking.pipeline_kickoff_requests WHERE intent_id = p_intent FOR UPDATE;
  IF NOT FOUND THEN RETURN 'NO_REQUEST'; END IF;
  IF r.state <> 'requested' THEN RETURN 'NOT_REQUESTED:' || upper(r.state); END IF;
  UPDATE booking.pipeline_kickoff_requests SET state = 'refused', settled_at = clock_timestamp(), outcome_code = p_code WHERE intent_id = p_intent;
  RETURN 'REFUSED';
END $$;
REVOKE ALL ON FUNCTION booking.refuse_pipeline_kickoff(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION booking.refuse_pipeline_kickoff(uuid, text) TO mv_booking_app;

-- claimed → dispatch_accepted | dispatch_unknown | dispatch_refused (the claiming worker only; terminal; never back to requested)
CREATE FUNCTION booking.settle_pipeline_kickoff(p_intent uuid, p_worker text, p_outcome text, p_code text) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
DECLARE r booking.pipeline_kickoff_requests%ROWTYPE;
BEGIN
  IF p_intent IS NULL OR p_worker IS NULL OR p_outcome IS NULL OR p_outcome NOT IN ('dispatch_accepted', 'dispatch_unknown', 'dispatch_refused')
     OR p_code IS NULL OR p_code !~ '^[A-Z0-9_:]{1,96}$' THEN
    RAISE EXCEPTION 'KICKOFF_ARGUMENT_INVALID' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO r FROM booking.pipeline_kickoff_requests WHERE intent_id = p_intent FOR UPDATE;
  IF NOT FOUND THEN RETURN 'NO_REQUEST'; END IF;
  IF r.state <> 'claimed' THEN RETURN 'NOT_CLAIMED:' || upper(r.state); END IF;
  IF r.claim_worker <> p_worker THEN RETURN 'NOT_CLAIM_WORKER'; END IF;
  UPDATE booking.pipeline_kickoff_requests SET state = p_outcome, settled_at = clock_timestamp(), outcome_code = p_code WHERE intent_id = p_intent;
  RETURN 'SETTLED';
END $$;
REVOKE ALL ON FUNCTION booking.settle_pipeline_kickoff(uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION booking.settle_pipeline_kickoff(uuid, text, text, text) TO mv_booking_app;
