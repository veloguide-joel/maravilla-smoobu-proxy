-- 0021_recorded_cleanup_foundation (up) — LOCAL MIGRATION CANDIDATE (ROOT design pass 5884066227 on the recorded-state cleanup packet rev2).
-- DISPOSABLE LOCAL test databases only. NOT applied to any shared database (shared DEV 0019/0020 must precede it; apply issuance on HOLD).
--
-- Foundation for the TEST cleanup of a RECORDED TEST booking (state confirmed: captured TEST payment + ONE succeeded, linked Hostaway
-- offline-charge recording + ONE pristine guest.notify row). It adds NO worker, NO transport, NO runner. It adds the persisted facts and
-- the fail-closed fences every later slice must satisfy:
--   1. intents.settlement_recording_mirrored boolean NULL — the THIRD settlement leg (NULL = pristine / non-recorded path; FALSE = recorded
--      cleanup entered, mirror unproven; TRUE = mirror proven). Set to FALSE ONLY by confirmed -> test_cleanup_pending; immutable except
--      false -> true with booking.offline_refund_settled_for(); never back to NULL / false.
--   2. fact-derived discriminator: test_cleanup_pending -> cancelled is REFUSED whenever offline_charge_id IS NOT NULL (or a succeeded
--      recording exists) unless the mirror is proven — deleting / downgrading the flag can never unlock the terminal. offline_charge_id is
--      immutable once set.
--   3. op type hostaway.refund_offline_charge (the ONE mirror op, key ochr:<intent>:1, reconcile_first, payload
--      {reservationId, offlineChargeId, amountMinor, currency}): created ONLY once BOTH other legs are TRUE and the recording is succeeded+linked
--      with result_ref = offlineChargeId; claimable ONLY as attempt 1 while the mirror leg is open; succeeds ONLY through
--      booking.complete_offline_refund_with_evidence() on a full persisted typed LIST proof (booking.offline_refund_proof_refusal()).
--   4. booking.offline_refund_settled_for(intent): latest-consistent persisted proof (tie / later contradiction / untyped field -> false).
--   5. guest.notify pending -> superseded: a NEW fenced transition (0016 fence body replaced; everything else byte-identical) allowed only
--      through booking.suppress_guest_notification() (SECURITY DEFINER, authority token action 'suppress', append-only audit row in
--      booking.notification_suppressions written in the same statement sequence; a deferred constraint trigger refuses a suppression without
--      its audit row). Never after attempt 1 / dispatch / lease / render / latch (a latched row is owner-visible).
--   6. payment_ledger entry offline_charge_refund_recorded (hostaway; MAGNITUDE stored, the entry name carries the direction — the 0001 ledger
--      CHECK amount_minor >= 0 and the existing refund_succeeded convention are kept; see the packet note).
--   7. booking.recorded_state_cleanup_ok(intent): read-only end-state predicate.
--   8. booking.intents_guard() (0001): confirmed is a DB terminal state; ONE added exception admits confirmed -> test_cleanup_pending on a TEST
--      instance (every other requirement of that entry is enforced by intents_safety_guard). Source conflict the packet audit had not listed.
-- Everything else (0019 pristine path, 0020 refund evidence settlement, 0016 claim / completion, 0010–0014 recording lifecycle) is unchanged.

-- ---------------------------------------------------------------------------------------------
-- 1. the third settlement leg
ALTER TABLE booking.intents ADD COLUMN settlement_recording_mirrored boolean;
-- offline_charge_id is set ONCE (OFFLINE_CHARGE_RECORDED); the discriminator relies on it never changing afterwards
ALTER TABLE booking.intents ADD CONSTRAINT intents_recording_mirrored_needs_charge
  CHECK (settlement_recording_mirrored IS NULL OR offline_charge_id IS NOT NULL);

-- ---------------------------------------------------------------------------------------------
-- 2. vocabulary: the mirror op type, its one-row bounds, the ledger entry, the authority action
ALTER TABLE booking.external_operations DROP CONSTRAINT external_operations_op_type_check;
ALTER TABLE booking.external_operations ADD CONSTRAINT external_operations_op_type_check CHECK (op_type IN (
  'stripe.create_checkout_session', 'stripe.retrieve_checkout_session', 'stripe.retrieve_payment_intent',
  'stripe.capture_payment_intent', 'stripe.void_payment_intent',
  'hostaway.lookup_reservation', 'hostaway.retrieve_reservation', 'hostaway.list_offline_charges',
  'hostaway.create_reservation', 'hostaway.cancel_reservation', 'hostaway.record_offline_charge',
  'guest.notify', 'alert.owner',
  'stripe.refund_payment_intent', 'stripe.retrieve_refund',
  'hostaway.refund_offline_charge'));
ALTER TABLE booking.external_operations DROP CONSTRAINT ops_provider_writes_reconcile_first;
ALTER TABLE booking.external_operations ADD CONSTRAINT ops_provider_writes_reconcile_first
  CHECK (op_type NOT IN ('stripe.create_checkout_session', 'stripe.capture_payment_intent', 'stripe.void_payment_intent',
                         'hostaway.cancel_reservation', 'stripe.refund_payment_intent', 'hostaway.refund_offline_charge')
         OR retry_class = 'reconcile_first');
DROP INDEX booking.external_operations_one_open_provider_write;
CREATE UNIQUE INDEX external_operations_one_open_provider_write ON booking.external_operations
  (intent_id, op_type, (coalesce(payload ->> 'paymentIntentId', payload ->> 'reservationId')))
  WHERE op_type IN ('stripe.capture_payment_intent', 'stripe.void_payment_intent', 'hostaway.cancel_reservation', 'stripe.refund_payment_intent',
                    'hostaway.refund_offline_charge')
    AND state IN ('pending', 'in_flight', 'outcome_unknown', 'escalated');
-- the mirror row is created at most ONCE per intent, in any state (no attempt 2, no new key)
CREATE UNIQUE INDEX external_operations_one_offline_refund_ever ON booking.external_operations (intent_id) WHERE op_type = 'hostaway.refund_offline_charge';

ALTER TABLE booking.payment_ledger DROP CONSTRAINT payment_ledger_entry_check;
ALTER TABLE booking.payment_ledger ADD CONSTRAINT payment_ledger_entry_check CHECK (entry IN ('authorization_accepted', 'authorization_rejected',
  'authorization_voided', 'capture_succeeded', 'refund_succeeded', 'refund_failed', 'offline_charge_recorded', 'offline_charge_refund_recorded'));

ALTER TABLE booking.notification_write_authority DROP CONSTRAINT notification_write_authority_action_check;
ALTER TABLE booking.notification_write_authority ADD CONSTRAINT notification_write_authority_action_check CHECK (action IN ('claim', 'complete', 'suppress'));

-- ---------------------------------------------------------------------------------------------
-- 3. append-only suppression audit (one row per suppressed notification; owner-readable, app/admin SELECT only)
CREATE TABLE booking.notification_suppressions (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  operation_id    uuid NOT NULL UNIQUE REFERENCES booking.external_operations (id),
  intent_id       uuid NOT NULL REFERENCES booking.intents (id),
  intent_version  integer NOT NULL CHECK (intent_version >= 0),
  reason          text NOT NULL CHECK (reason IN ('TEST_CLEANUP_RECORDED')),
  suppressed_by   text NOT NULL CHECK (length(suppressed_by) BETWEEN 1 AND 200),
  suppressed_at   timestamptz NOT NULL
);
CREATE TRIGGER notification_suppressions_append_only BEFORE UPDATE OR DELETE ON booking.notification_suppressions
  FOR EACH ROW EXECUTE FUNCTION booking.reject_change();
CREATE TRIGGER notification_suppressions_no_truncate BEFORE TRUNCATE ON booking.notification_suppressions
  FOR EACH STATEMENT EXECUTE FUNCTION booking.reject_change();
ALTER TABLE booking.notification_suppressions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON booking.notification_suppressions FROM PUBLIC;
GRANT SELECT ON booking.notification_suppressions TO mv_booking_app, mv_booking_admin;
CREATE POLICY app_admin_read ON booking.notification_suppressions FOR SELECT TO mv_booking_app, mv_booking_admin USING (true);

-- ---------------------------------------------------------------------------------------------
-- 4. the mirror proof (persisted, typed, bound; every test explicit so no NULL can pass)
--    p_mode 'worker_fresh' (completion: evidence within 2 minutes of the decision instant, after the mirror send) | 'linked' (re-verification of
--    the persisted proof at the terminal / predicate: content + binding, no freshness window).
CREATE FUNCTION booking.offline_refund_proof_refusal(p_intent uuid, p_payload jsonb, p_result_ref text, p_dispatched_at timestamptz,
  p_evidence uuid, p_mode text, p_decision_at timestamptz) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
DECLARE e booking.provider_evidence%ROWTYPE; r booking.external_operations%ROWTYPE; i booking.intents%ROWTYPE; o jsonb; rf jsonb; ri jsonb;
        marker text; mirror text; keys text[]; neg text;
BEGIN
  IF p_mode IS NULL OR p_mode NOT IN ('worker_fresh', 'linked') THEN RETURN 'MODE_INVALID'; END IF;
  IF p_decision_at IS NULL THEN RETURN 'DECISION_TIME_REQUIRED'; END IF;
  IF p_evidence IS NULL THEN RETURN 'EVIDENCE_REQUIRED'; END IF;
  IF p_result_ref IS NULL OR p_result_ref !~ '^[1-9][0-9]{0,15}$' OR p_result_ref::numeric > 9007199254740991 THEN RETURN 'RESULT_REF_NOT_CANONICAL'; END IF;
  IF p_mode = 'worker_fresh' AND p_dispatched_at IS NULL THEN RETURN 'DISPATCH_TIME_REQUIRED'; END IF;
  IF p_dispatched_at IS NOT NULL AND p_dispatched_at > p_decision_at THEN RETURN 'DISPATCH_IN_FUTURE'; END IF;
  SELECT * INTO i FROM booking.intents WHERE id = p_intent;
  IF NOT FOUND THEN RETURN 'INTENT_NOT_FOUND'; END IF;
  IF i.offline_charge_id IS NULL OR i.offline_charge_id !~ '^[1-9][0-9]{0,15}$' THEN RETURN 'INTENT_NOT_RECORDED'; END IF;
  IF i.offline_charge_id = p_result_ref THEN RETURN 'RESULT_REF_IS_ORIGINAL'; END IF;        -- the refund row id is never the charge id
  IF NOT EXISTS (SELECT 1 FROM booking.external_operations x WHERE x.intent_id = p_intent AND x.op_type = 'hostaway.record_offline_charge'
                  AND x.state = 'succeeded' AND x.settled_evidence_id IS NOT NULL AND x.result_ref = i.offline_charge_id) THEN
    RETURN 'RECORDING_NOT_PROVEN';
  END IF;
  SELECT * INTO e FROM booking.provider_evidence WHERE id = p_evidence;
  IF NOT FOUND THEN RETURN 'EVIDENCE_NOT_FOUND'; END IF;
  IF e.intent_id IS DISTINCT FROM p_intent THEN RETURN 'EVIDENCE_OTHER_INTENT'; END IF;
  IF e.kind IS DISTINCT FROM 'hostaway_offline_charges' OR e.source IS DISTINCT FROM 'hostaway_api' OR e.status IS DISTINCT FROM 'listed' THEN
    RETURN 'EVIDENCE_NOT_API_CHARGE_LIST';
  END IF;
  SELECT * INTO r FROM booking.external_operations WHERE id = e.read_operation_id;
  IF NOT FOUND OR r.intent_id IS DISTINCT FROM p_intent OR r.op_type IS DISTINCT FROM 'hostaway.list_offline_charges'
     OR r.retry_class IS DISTINCT FROM 'read' OR r.state IS DISTINCT FROM 'succeeded' THEN
    RETURN 'EVIDENCE_READ_BINDING';
  END IF;
  IF i.hostaway_reservation_id IS NULL OR (p_payload ->> 'reservationId') IS DISTINCT FROM i.hostaway_reservation_id
     OR (p_payload ->> 'offlineChargeId') IS DISTINCT FROM i.offline_charge_id
     OR (r.payload ->> 'reservationId') IS DISTINCT FROM i.hostaway_reservation_id OR e.external_ref IS DISTINCT FROM i.hostaway_reservation_id THEN
    RETURN 'EVIDENCE_RESERVATION_BINDING';
  END IF;
  IF e.observed_at IS DISTINCT FROM r.completed_at THEN RETURN 'EVIDENCE_TIME_NOT_READ_COMPLETION'; END IF;
  IF p_dispatched_at IS NOT NULL AND (r.dispatched_at IS NULL OR r.dispatched_at < p_dispatched_at OR NOT (e.observed_at > p_dispatched_at)) THEN
    RETURN 'EVIDENCE_NOT_AFTER_SEND';
  END IF;
  IF e.observed_at > p_decision_at THEN RETURN 'EVIDENCE_IN_FUTURE'; END IF;
  IF p_mode = 'worker_fresh' AND e.observed_at < p_decision_at - interval '2 minutes' THEN RETURN 'EVIDENCE_STALE'; END IF;
  -- observed: the re-observed ORIGINAL (recording-proof shape, unchanged) + the typed mirror discovery
  o := e.observed;
  SELECT array_agg(k ORDER BY k) INTO keys FROM jsonb_object_keys(o) k;
  IF keys IS DISTINCT FROM ARRAY['amountMinor','chargeId','currency','executorAccountRef','linkedRefundCount','listingMapId','marker','matchingChargeCount',
       'matchingChargeIds','matchingRefundCount','matchingRefundIds','mirrorMarker','paymentMethod','paymentProvider','readCount','refundRow',
       'reservationId','status','title','type'] THEN
    RETURN 'OBSERVED_KEYS';
  END IF;
  marker := 'mvoch1-' || p_intent::text;
  mirror := 'mvochr1-' || p_intent::text;
  -- the original: still exactly ONE matching charge, unchanged (type charge / status paid / full amount / bound)
  IF jsonb_typeof(o -> 'matchingChargeCount') IS DISTINCT FROM 'number' OR (o ->> 'matchingChargeCount') IS DISTINCT FROM '1' THEN RETURN 'ORIGINAL_COUNT'; END IF;
  IF jsonb_typeof(o -> 'matchingChargeIds') IS DISTINCT FROM 'array' OR jsonb_array_length(o -> 'matchingChargeIds') IS DISTINCT FROM 1
     OR jsonb_typeof(o -> 'matchingChargeIds' -> 0) IS DISTINCT FROM 'string' OR (o -> 'matchingChargeIds' ->> 0) IS DISTINCT FROM i.offline_charge_id THEN
    RETURN 'ORIGINAL_IDS';
  END IF;
  IF jsonb_typeof(o -> 'chargeId') IS DISTINCT FROM 'string' OR (o ->> 'chargeId') IS DISTINCT FROM i.offline_charge_id THEN RETURN 'ORIGINAL_CHARGE_ID'; END IF;
  IF jsonb_typeof(o -> 'reservationId') IS DISTINCT FROM 'string' OR (o ->> 'reservationId') IS DISTINCT FROM i.hostaway_reservation_id THEN RETURN 'ORIGINAL_RESERVATION'; END IF;
  IF jsonb_typeof(o -> 'listingMapId') IS DISTINCT FROM 'number' OR (o ->> 'listingMapId') IS DISTINCT FROM i.listing_id::text THEN RETURN 'ORIGINAL_LISTING'; END IF;
  IF jsonb_typeof(o -> 'amountMinor') IS DISTINCT FROM 'number' OR (o ->> 'amountMinor') !~ '^[1-9][0-9]{0,15}$'
     OR (o ->> 'amountMinor') IS DISTINCT FROM (p_payload ->> 'amountMinor')
     OR (o ->> 'amountMinor') IS DISTINCT FROM i.captured_minor::text OR (o ->> 'amountMinor') IS DISTINCT FROM i.final_total_minor::text THEN
    RETURN 'ORIGINAL_AMOUNT';
  END IF;
  IF jsonb_typeof(o -> 'currency') IS DISTINCT FROM 'string' OR (o ->> 'currency') IS DISTINCT FROM i.currency::text
     OR (p_payload ->> 'currency') IS DISTINCT FROM i.currency::text THEN RETURN 'ORIGINAL_CURRENCY'; END IF;
  IF jsonb_typeof(o -> 'status') IS DISTINCT FROM 'string' OR (o ->> 'status') IS DISTINCT FROM 'paid' THEN RETURN 'ORIGINAL_STATUS'; END IF;
  IF jsonb_typeof(o -> 'type') IS DISTINCT FROM 'string' OR (o ->> 'type') IS DISTINCT FROM 'charge' THEN RETURN 'ORIGINAL_TYPE'; END IF;
  IF jsonb_typeof(o -> 'paymentProvider') IS DISTINCT FROM 'string' OR (o ->> 'paymentProvider') IS DISTINCT FROM 'offline' THEN RETURN 'ORIGINAL_PROVIDER'; END IF;
  IF jsonb_typeof(o -> 'paymentMethod') IS DISTINCT FROM 'string' OR (o ->> 'paymentMethod') NOT IN ('credit_card', 'other') THEN RETURN 'ORIGINAL_METHOD'; END IF;
  IF jsonb_typeof(o -> 'marker') IS DISTINCT FROM 'string' OR (o ->> 'marker') IS DISTINCT FROM marker THEN RETURN 'ORIGINAL_MARKER'; END IF;
  IF jsonb_typeof(o -> 'title') IS DISTINCT FROM 'string' OR (o ->> 'title') IS DISTINCT FROM 'maraVilla payment ' || marker THEN RETURN 'ORIGINAL_TITLE'; END IF;
  IF jsonb_typeof(o -> 'readCount') IS DISTINCT FROM 'number' OR (o ->> 'readCount') !~ '^[1-9][0-9]{0,2}$' OR (o ->> 'readCount')::integer > 500 THEN
    RETURN 'OBSERVED_READ_COUNT';
  END IF;
  IF jsonb_typeof(o -> 'executorAccountRef') IS DISTINCT FROM 'string' OR (o ->> 'executorAccountRef') !~ '^[A-Za-z0-9._:-]{1,64}$' THEN
    RETURN 'OBSERVED_ACCOUNT_REF_FORMAT';
  END IF;
  -- the mirror discovery: EXACTLY ONE row typed-linked to the original, EXACTLY ONE row carrying the mirror marker, and they are the same row
  IF jsonb_typeof(o -> 'mirrorMarker') IS DISTINCT FROM 'string' OR (o ->> 'mirrorMarker') IS DISTINCT FROM mirror THEN RETURN 'MIRROR_MARKER'; END IF;
  IF jsonb_typeof(o -> 'linkedRefundCount') IS DISTINCT FROM 'number' OR (o ->> 'linkedRefundCount') IS DISTINCT FROM '1' THEN RETURN 'MIRROR_LINKED_COUNT'; END IF;
  IF jsonb_typeof(o -> 'matchingRefundCount') IS DISTINCT FROM 'number' OR (o ->> 'matchingRefundCount') IS DISTINCT FROM '1' THEN RETURN 'MIRROR_COUNT'; END IF;
  IF jsonb_typeof(o -> 'matchingRefundIds') IS DISTINCT FROM 'array' OR jsonb_array_length(o -> 'matchingRefundIds') IS DISTINCT FROM 1
     OR jsonb_typeof(o -> 'matchingRefundIds' -> 0) IS DISTINCT FROM 'string' OR (o -> 'matchingRefundIds' ->> 0) IS DISTINCT FROM p_result_ref THEN
    RETURN 'MIRROR_IDS';
  END IF;
  rf := o -> 'refundRow';
  IF jsonb_typeof(rf) IS DISTINCT FROM 'object' THEN RETURN 'MIRROR_ROW'; END IF;
  SELECT array_agg(k ORDER BY k) INTO keys FROM jsonb_object_keys(rf) k;
  IF keys IS DISTINCT FROM ARRAY['amountMinor','currency','id','listingMapId','paymentProvider','refundInfo','reservationId','status','title','type'] THEN
    RETURN 'MIRROR_ROW_KEYS';
  END IF;
  IF jsonb_typeof(rf -> 'id') IS DISTINCT FROM 'string' OR (rf ->> 'id') IS DISTINCT FROM p_result_ref THEN RETURN 'MIRROR_ROW_ID'; END IF;
  IF jsonb_typeof(rf -> 'type') IS DISTINCT FROM 'string' OR (rf ->> 'type') IS DISTINCT FROM 'refund' THEN RETURN 'MIRROR_ROW_TYPE'; END IF;
  IF jsonb_typeof(rf -> 'status') IS DISTINCT FROM 'string' OR (rf ->> 'status') IS DISTINCT FROM 'succeeded' THEN RETURN 'MIRROR_ROW_STATUS'; END IF;
  IF jsonb_typeof(rf -> 'paymentProvider') IS DISTINCT FROM 'string' OR (rf ->> 'paymentProvider') IS DISTINCT FROM 'offline' THEN RETURN 'MIRROR_ROW_PROVIDER'; END IF;
  neg := '-' || i.captured_minor::text;
  IF jsonb_typeof(rf -> 'amountMinor') IS DISTINCT FROM 'number' OR (rf ->> 'amountMinor') !~ '^-[1-9][0-9]{0,15}$' OR (rf ->> 'amountMinor') IS DISTINCT FROM neg THEN
    RETURN 'MIRROR_ROW_AMOUNT';                                                                -- the FULL recorded amount, negative, exact
  END IF;
  IF jsonb_typeof(rf -> 'currency') IS DISTINCT FROM 'string' OR (rf ->> 'currency') IS DISTINCT FROM i.currency::text THEN RETURN 'MIRROR_ROW_CURRENCY'; END IF;
  IF jsonb_typeof(rf -> 'reservationId') IS DISTINCT FROM 'string' OR (rf ->> 'reservationId') IS DISTINCT FROM i.hostaway_reservation_id THEN RETURN 'MIRROR_ROW_RESERVATION'; END IF;
  IF jsonb_typeof(rf -> 'listingMapId') IS DISTINCT FROM 'number' OR (rf ->> 'listingMapId') IS DISTINCT FROM i.listing_id::text THEN RETURN 'MIRROR_ROW_LISTING'; END IF;
  IF jsonb_typeof(rf -> 'title') IS DISTINCT FROM 'string' OR (rf ->> 'title') IS DISTINCT FROM 'maraVilla refund ' || mirror THEN RETURN 'MIRROR_ROW_TITLE'; END IF;
  ri := rf -> 'refundInfo';
  IF jsonb_typeof(ri) IS DISTINCT FROM 'object' THEN RETURN 'MIRROR_LINK'; END IF;
  SELECT array_agg(k ORDER BY k) INTO keys FROM jsonb_object_keys(ri) k;
  IF keys IS DISTINCT FROM ARRAY['chargeId','id','refundedChargeId'] THEN RETURN 'MIRROR_LINK_KEYS'; END IF;
  -- typed nested ids: refundInfo.chargeId IS the refund row id; refundInfo.refundedChargeId IS the pinned ORIGINAL; never inverted
  IF jsonb_typeof(ri -> 'chargeId') IS DISTINCT FROM 'string' OR (ri ->> 'chargeId') IS DISTINCT FROM p_result_ref THEN RETURN 'MIRROR_LINK_CHARGE_ID'; END IF;
  IF jsonb_typeof(ri -> 'refundedChargeId') IS DISTINCT FROM 'string' OR (ri ->> 'refundedChargeId') IS DISTINCT FROM i.offline_charge_id THEN RETURN 'MIRROR_LINK_REFUNDED_ID'; END IF;
  IF jsonb_typeof(ri -> 'id') IS DISTINCT FROM 'string' OR (ri ->> 'id') !~ '^[1-9][0-9]{0,15}$' THEN RETURN 'MIRROR_LINK_ID'; END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION booking.offline_refund_proof_refusal(uuid, jsonb, text, timestamptz, uuid, text, timestamptz) FROM PUBLIC;

-- the latest persisted charge-list observation of the intent's reservation decides; two observations tied at the same instant with different
-- content, or a later observation that does not carry the same proof, refuse (fail closed). NULL = not settled.
CREATE FUNCTION booking.offline_refund_settled_for(p_intent uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
DECLARE i booking.intents%ROWTYPE; m booking.external_operations%ROWTYPE; latest_at timestamptz; n_latest integer; n_distinct integer; latest_id uuid;
BEGIN
  SELECT * INTO i FROM booking.intents WHERE id = p_intent;
  IF NOT FOUND OR i.offline_charge_id IS NULL OR i.hostaway_reservation_id IS NULL THEN RETURN false; END IF;
  SELECT * INTO m FROM booking.external_operations WHERE intent_id = p_intent AND op_type = 'hostaway.refund_offline_charge';
  IF NOT FOUND OR m.state IS DISTINCT FROM 'succeeded' OR m.settled_evidence_id IS NULL OR m.result_ref IS NULL
     OR m.idempotency_key IS DISTINCT FROM 'ochr:' || p_intent::text || ':1' THEN RETURN false; END IF;
  IF booking.offline_refund_proof_refusal(p_intent, m.payload, m.result_ref, m.dispatched_at, m.settled_evidence_id, 'linked', clock_timestamp()) IS NOT NULL THEN
    RETURN false;
  END IF;
  SELECT max(observed_at) INTO latest_at FROM booking.provider_evidence
   WHERE intent_id = p_intent AND kind = 'hostaway_offline_charges' AND external_ref = i.hostaway_reservation_id;
  SELECT count(*), count(DISTINCT observed) INTO n_latest, n_distinct FROM booking.provider_evidence
   WHERE intent_id = p_intent AND kind = 'hostaway_offline_charges' AND external_ref = i.hostaway_reservation_id AND observed_at = latest_at;
  IF n_latest <> 1 AND n_distinct <> 1 THEN RETURN false; END IF;                             -- tie with different content
  SELECT id INTO latest_id FROM booking.provider_evidence
   WHERE intent_id = p_intent AND kind = 'hostaway_offline_charges' AND external_ref = i.hostaway_reservation_id AND observed_at = latest_at
   ORDER BY id LIMIT 1;
  IF latest_id IS DISTINCT FROM m.settled_evidence_id
     AND booking.offline_refund_proof_refusal(p_intent, m.payload, m.result_ref, NULL, latest_id, 'linked', clock_timestamp()) IS NOT NULL THEN
    RETURN false;                                                                             -- a later observation contradicts the proof
  END IF;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION booking.offline_refund_settled_for(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION booking.offline_refund_settled_for(uuid) TO mv_booking_app, mv_booking_admin;

-- ---------------------------------------------------------------------------------------------
-- 4b. claim release blockers (0019 body + the mirror op in the unresolved provider-write list; otherwise byte-identical)
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
                              'hostaway.create_reservation', 'hostaway.cancel_reservation', 'hostaway.record_offline_charge', 'stripe.refund_payment_intent',
                              'hostaway.refund_offline_charge')
              AND NOT (s = 'cancelled' AND op_type = 'stripe.capture_payment_intent' AND state = 'pending' AND attempts = 0
                       AND dispatched_at IS NULL AND lease_worker_id IS NULL AND lease_until IS NULL) LOOP
    out := out || ('PROVIDER_OPERATION_UNRESOLVED:' || r.op_type || ':' || r.state);
  END LOOP;
  FOR r IN SELECT kind FROM booking.reconciliation_cases WHERE intent_id = p_intent AND status = 'open' LOOP
    out := out || ('OPEN_CASE:' || r.kind);
  END LOOP;
  RETURN out;
END $$;

-- ---------------------------------------------------------------------------------------------
-- 4c. the 0001 terminal guard (byte-identical except the ONE added exception below): confirmed is a terminal state there; the recorded
--     TEST cleanup is the only transition that may leave it, and only on a TEST instance
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
  -- 0021: the ONE added exception — a confirmed TEST booking may enter the recorded TEST cleanup (TEST instance only; every other
  -- requirement of that entry is booking.intents_safety_guard's). All other terminal states, and confirmed to anything else, unchanged.
  IF booking.is_terminal_state(OLD.state) AND NEW.state NOT IN (OLD.state, 'reconciliation_required')
     AND NOT (OLD.state = 'confirmed' AND NEW.state = 'test_cleanup_pending' AND OLD.environment = 'test'
              AND (SELECT environment FROM booking.instance) IS NOT DISTINCT FROM 'test') THEN
    RAISE EXCEPTION 'terminal state % cannot move to %', OLD.state, NEW.state USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.captured_minor < OLD.captured_minor THEN
    RAISE EXCEPTION 'captured amount cannot decrease (refunds are recorded separately)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;


-- ---------------------------------------------------------------------------------------------
-- 5. intents guard (0019 body + the recorded-cleanup clauses; the 0019 clauses are byte-identical)
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
  -- 0021: offline_charge_id is written once; the recorded-cleanup discriminator derives from it
  IF OLD.offline_charge_id IS NOT NULL AND NEW.offline_charge_id IS DISTINCT FROM OLD.offline_charge_id THEN
    RAISE EXCEPTION 'OFFLINE_CHARGE_ID_IMMUTABLE' USING ERRCODE = 'check_violation';
  END IF;
  -- 0021: the third leg. NULL -> FALSE only by confirmed -> test_cleanup_pending (the recorded request); FALSE -> TRUE only with the proven
  -- mirror; never NULL -> TRUE, TRUE -> FALSE, non-NULL -> NULL
  IF NEW.settlement_recording_mirrored IS DISTINCT FROM OLD.settlement_recording_mirrored THEN
    IF OLD.settlement_recording_mirrored IS NULL AND NEW.settlement_recording_mirrored IS FALSE THEN
      IF NOT (OLD.state = 'confirmed' AND NEW.state = 'test_cleanup_pending') THEN
        RAISE EXCEPTION 'MIRROR_FLAG_IMMUTABLE: the mirror leg opens only with the recorded TEST cleanup request' USING ERRCODE = 'check_violation';
      END IF;
    ELSIF OLD.settlement_recording_mirrored IS FALSE AND NEW.settlement_recording_mirrored IS TRUE THEN
      IF NOT booking.offline_refund_settled_for(NEW.id) THEN
        RAISE EXCEPTION 'MIRROR_NOT_VERIFIED' USING ERRCODE = 'check_violation';
      END IF;
    ELSE
      RAISE EXCEPTION 'MIRROR_FLAG_IMMUTABLE' USING ERRCODE = 'check_violation';
    END IF;
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
  -- 0021: fact-derived discriminator — a RECORDED booking (offline charge id set, or any succeeded recording) reaches cancelled ONLY with the
  -- proven mirror (flag TRUE re-verified at this instant); a pristine (0019) booking carries no flag at all
  IF OLD.state = 'test_cleanup_pending' AND NEW.state = 'cancelled' THEN
    IF NEW.offline_charge_id IS NOT NULL
       OR EXISTS (SELECT 1 FROM booking.external_operations WHERE intent_id = NEW.id AND op_type = 'hostaway.record_offline_charge' AND state = 'succeeded') THEN
      IF NOT (NEW.settlement_recording_mirrored IS TRUE AND booking.offline_refund_settled_for(NEW.id)) THEN
        RAISE EXCEPTION 'CANCELLATION_NOT_VERIFIED: MIRROR_NOT_VERIFIED' USING ERRCODE = 'check_violation';
      END IF;
    ELSIF NEW.settlement_recording_mirrored IS NOT NULL THEN
      RAISE EXCEPTION 'MIRROR_FLAG_IMMUTABLE: a pristine cleanup carries no mirror leg' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  -- 0019: payment_captured leaves ONLY to confirmed / reconciliation_required (existing) or test_cleanup_pending on a TEST instance
  IF OLD.state = 'payment_captured' AND NEW.state = 'test_cleanup_pending'
     AND ((SELECT environment FROM booking.instance) IS DISTINCT FROM 'test' OR NEW.environment <> 'test' OR NEW.captured_minor IS NULL OR NEW.captured_minor <= 0) THEN
    RAISE EXCEPTION 'TEST_CLEANUP_NOT_TEST' USING ERRCODE = 'check_violation';
  END IF;
  -- 0021: the pristine entry carries no mirror leg; the recorded entry (confirmed -> test_cleanup_pending) opens it on a TEST instance over a
  -- succeeded, linked recording of exactly the pinned offline charge
  IF OLD.state = 'payment_captured' AND NEW.state = 'test_cleanup_pending' AND NEW.settlement_recording_mirrored IS NOT NULL THEN
    RAISE EXCEPTION 'MIRROR_FLAG_IMMUTABLE: a pristine cleanup carries no mirror leg' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.state = 'confirmed' AND NEW.state = 'test_cleanup_pending' THEN
    IF (SELECT environment FROM booking.instance) IS DISTINCT FROM 'test' OR NEW.environment <> 'test' OR NEW.captured_minor IS NULL OR NEW.captured_minor <= 0 THEN
      RAISE EXCEPTION 'TEST_CLEANUP_NOT_TEST' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.settlement_recording_mirrored IS NOT FALSE OR NEW.settlement_reservation_cancelled IS NOT FALSE OR NEW.settlement_authorization_settled IS NOT FALSE
       OR NEW.offline_charge_id IS NULL
       OR NOT EXISTS (SELECT 1 FROM booking.external_operations WHERE intent_id = NEW.id AND op_type = 'hostaway.record_offline_charge'
                       AND state = 'succeeded' AND settled_evidence_id IS NOT NULL AND result_ref = NEW.offline_charge_id)
       OR (SELECT count(*) FROM booking.external_operations WHERE intent_id = NEW.id AND op_type = 'hostaway.record_offline_charge') <> 1 THEN
      RAISE EXCEPTION 'TEST_CLEANUP_RECORDED_NOT_VERIFIED' USING ERRCODE = 'check_violation';
    END IF;
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

-- ---------------------------------------------------------------------------------------------
-- 6. the mirror op: creation / claim / success fences
CREATE FUNCTION booking.offline_refund_create_fence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
DECLARE i booking.intents%ROWTYPE;
BEGIN
  SELECT * INTO i FROM booking.intents WHERE id = NEW.intent_id FOR SHARE;
  IF NOT FOUND OR i.state IS DISTINCT FROM 'test_cleanup_pending' OR i.settlement_reservation_cancelled IS NOT TRUE OR i.settlement_authorization_settled IS NOT TRUE
     OR i.settlement_recording_mirrored IS NOT FALSE OR i.offline_charge_id IS NULL OR i.hostaway_reservation_id IS NULL
     OR i.environment <> 'test' OR (SELECT environment FROM booking.instance) IS DISTINCT FROM 'test'
     OR NOT booking.test_refund_settled_for(i.id, i.stripe_payment_intent_id)
     OR NOT EXISTS (SELECT 1 FROM booking.external_operations x WHERE x.intent_id = i.id AND x.op_type = 'hostaway.record_offline_charge'
                     AND x.state = 'succeeded' AND x.settled_evidence_id IS NOT NULL AND x.result_ref = i.offline_charge_id)
     OR EXISTS (SELECT 1 FROM booking.external_operations x WHERE x.intent_id = i.id AND x.op_type = 'hostaway.refund_offline_charge' AND x.id <> NEW.id) THEN
    RAISE EXCEPTION 'MIRROR_CREATE_FENCED: the mirror row exists only after both proven legs of a recorded TEST cleanup' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.idempotency_key IS DISTINCT FROM 'ochr:' || i.id::text || ':1' OR NEW.retry_class IS DISTINCT FROM 'reconcile_first' OR NEW.state <> 'pending'
     OR NEW.attempts <> 0 OR NEW.dispatched_at IS NOT NULL OR NEW.lease_worker_id IS NOT NULL OR NEW.lease_until IS NOT NULL OR NEW.result_ref IS NOT NULL
     OR NEW.completed_at IS NOT NULL OR NEW.settled_evidence_id IS NOT NULL OR NEW.resolution_id IS NOT NULL OR NEW.late_result_status IS NOT NULL
     OR NEW.payload IS DISTINCT FROM jsonb_build_object('reservationId', i.hostaway_reservation_id, 'offlineChargeId', i.offline_charge_id,
                                                        'amountMinor', i.captured_minor, 'currency', i.currency::text) THEN
    RAISE EXCEPTION 'MIRROR_CREATE_FENCED: key / payload / lifecycle columns not canonical' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION booking.offline_refund_create_fence() FROM PUBLIC;
CREATE TRIGGER external_operations_offline_refund_create_fence BEFORE INSERT ON booking.external_operations
  FOR EACH ROW WHEN (NEW.op_type = 'hostaway.refund_offline_charge') EXECUTE FUNCTION booking.offline_refund_create_fence();

CREATE FUNCTION booking.offline_refund_claim_fence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
DECLARE i booking.intents%ROWTYPE;
BEGIN
  SELECT * INTO i FROM booking.intents WHERE id = NEW.intent_id FOR SHARE;
  IF NOT FOUND OR i.state IS DISTINCT FROM 'test_cleanup_pending' OR i.settlement_recording_mirrored IS NOT FALSE
     OR i.settlement_reservation_cancelled IS NOT TRUE OR i.settlement_authorization_settled IS NOT TRUE
     OR i.environment <> 'test' OR (SELECT environment FROM booking.instance) IS DISTINCT FROM 'test'
     OR OLD.attempts <> 0 OR OLD.dispatched_at IS NOT NULL OR NEW.attempts <> 1 OR NEW.idempotency_key IS DISTINCT FROM 'ochr:' || i.id::text || ':1' THEN
    RAISE EXCEPTION 'MIRROR_CLAIM_FENCED: the mirror row is claimable once, as attempt 1, while the mirror leg is open' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION booking.offline_refund_claim_fence() FROM PUBLIC;
CREATE TRIGGER external_operations_offline_refund_claim_fence BEFORE UPDATE ON booking.external_operations
  FOR EACH ROW WHEN (OLD.state = 'pending' AND NEW.state = 'in_flight' AND NEW.op_type = 'hostaway.refund_offline_charge')
  EXECUTE FUNCTION booking.offline_refund_claim_fence();

-- success ONLY through the completion function (schema-owner context) with a linked proof that passes the typed check; the generic
-- settle_operation_from_evidence (0005/0020) cannot succeed this row: its evidence is never a passing charge-list proof
CREATE FUNCTION booking.offline_refund_success_fence() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, booking AS $$
DECLARE r text;
BEGIN
  IF NOT booking.is_privileged() THEN
    RAISE EXCEPTION 'MIRROR_SUCCESS_REQUIRES_FUNCTION: a mirror succeeds only through booking.complete_offline_refund_with_evidence' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.settled_evidence_id IS NULL OR NEW.result_ref IS NULL OR NEW.completed_at IS NULL OR NEW.lease_worker_id IS NOT NULL OR NEW.lease_until IS NOT NULL
     OR NEW.attempts <> 1 OR NEW.resolution_id IS NOT NULL THEN
    RAISE EXCEPTION 'MIRROR_SUCCESS_FENCED: a succeeded mirror carries its linked proof, result and a cleared lease' USING ERRCODE = 'check_violation';
  END IF;
  r := booking.offline_refund_proof_refusal(NEW.intent_id, NEW.payload, NEW.result_ref, NEW.dispatched_at, NEW.settled_evidence_id, 'linked', clock_timestamp());
  IF r IS NOT NULL THEN RAISE EXCEPTION 'MIRROR_PROOF_REFUSED: %', r USING ERRCODE = 'check_violation'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION booking.offline_refund_success_fence() FROM PUBLIC;
CREATE TRIGGER external_operations_offline_refund_success_fence BEFORE UPDATE ON booking.external_operations
  FOR EACH ROW WHEN (NEW.state = 'succeeded' AND OLD.state IS DISTINCT FROM 'succeeded' AND NEW.op_type = 'hostaway.refund_offline_charge')
  EXECUTE FUNCTION booking.offline_refund_success_fence();

-- completion (0011 complete_recording_with_evidence pattern): work lease + op lease + version + attempt 1 + fresh proof, under the per-intent
-- evidence lock; p_result_ref = the provider's refund row id (the reply's result.id, which the caller admits only when it equals the nested
-- refundInfo.chargeId; the persisted LIST row re-proves that equality here)
CREATE FUNCTION booking.complete_offline_refund_with_evidence(p_op uuid, p_worker text, p_evidence uuid, p_result_ref text, p_expected_version integer)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
DECLARE v_intent uuid; i booking.intents%ROWTYPE; w booking.intent_work%ROWTYPE; o booking.external_operations%ROWTYPE; v_t timestamptz; r text;
BEGIN
  SELECT intent_id INTO v_intent FROM booking.external_operations WHERE id = p_op AND op_type = 'hostaway.refund_offline_charge';
  IF v_intent IS NULL THEN RAISE EXCEPTION 'MIRROR_STATE: not a mirror operation' USING ERRCODE = 'check_violation'; END IF;
  SELECT * INTO i FROM booking.intents WHERE id = v_intent FOR SHARE;
  SELECT * INTO w FROM booking.intent_work WHERE intent_id = v_intent FOR SHARE;
  SELECT * INTO o FROM booking.external_operations WHERE id = p_op FOR UPDATE;
  PERFORM pg_advisory_xact_lock(hashtext('booking.recording_evidence'), hashtext(v_intent::text));
  v_t := clock_timestamp();
  IF i.state IS DISTINCT FROM 'test_cleanup_pending' OR i.settlement_recording_mirrored IS NOT FALSE
     OR i.settlement_reservation_cancelled IS NOT TRUE OR i.settlement_authorization_settled IS NOT TRUE THEN
    RAISE EXCEPTION 'MIRROR_STATE: intent is not test_cleanup_pending with the mirror leg open' USING ERRCODE = 'check_violation';
  END IF;
  IF p_expected_version IS NULL OR i.version IS DISTINCT FROM p_expected_version THEN RAISE EXCEPTION 'MIRROR_VERSION_CHANGED' USING ERRCODE = 'check_violation'; END IF;
  IF p_worker IS NULL OR w.work_worker_id IS DISTINCT FROM p_worker OR w.work_lease_until IS NULL OR w.work_lease_until < v_t THEN
    RAISE EXCEPTION 'MIRROR_WORK_LEASE_LOST' USING ERRCODE = 'check_violation';
  END IF;
  IF o.state IS DISTINCT FROM 'in_flight' THEN RAISE EXCEPTION 'MIRROR_STATE: operation is %', o.state USING ERRCODE = 'check_violation'; END IF;
  IF o.lease_worker_id IS DISTINCT FROM p_worker OR o.lease_until IS NULL OR o.lease_until < v_t THEN RAISE EXCEPTION 'MIRROR_LEASE_LOST' USING ERRCODE = 'check_violation'; END IF;
  IF o.idempotency_key IS DISTINCT FROM 'ochr:' || v_intent::text || ':1' OR o.attempts IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'MIRROR_STATE: only the single attempt completes through this function' USING ERRCODE = 'check_violation';
  END IF;
  r := booking.offline_refund_proof_refusal(v_intent, o.payload, p_result_ref, o.dispatched_at, p_evidence, 'worker_fresh', v_t);
  IF r IS NOT NULL THEN RAISE EXCEPTION 'MIRROR_PROOF_REFUSED: %', r USING ERRCODE = 'check_violation'; END IF;
  UPDATE booking.external_operations
     SET state = 'succeeded', result_ref = p_result_ref, settled_evidence_id = p_evidence, completed_at = v_t,
         lease_worker_id = NULL, lease_until = NULL, updated_at = v_t
   WHERE id = p_op;
  RETURN 'succeeded';
END $$;
REVOKE ALL ON FUNCTION booking.complete_offline_refund_with_evidence(uuid, text, uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION booking.complete_offline_refund_with_evidence(uuid, text, uuid, text, integer) TO mv_booking_app;

-- ---------------------------------------------------------------------------------------------
-- 7. guest.notify pending -> superseded (suppression): the 0016 fence body with ONE added branch; every other line byte-identical to 0016
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

-- the audit row is mandatory: a suppression whose transaction commits without its notification_suppressions row is refused (deferred)
CREATE FUNCTION booking.notify_suppression_audit_required() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM booking.notification_suppressions s WHERE s.operation_id = NEW.id AND s.intent_id = NEW.intent_id) THEN
    RAISE EXCEPTION 'NOTIFY_SUPPRESS_UNAUDITED: a suppressed notification needs its audit row' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION booking.notify_suppression_audit_required() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER notify_suppression_audit_required AFTER UPDATE ON booking.external_operations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (OLD.state = 'pending' AND NEW.state = 'superseded' AND NEW.op_type = 'guest.notify')
  EXECUTE FUNCTION booking.notify_suppression_audit_required();
-- an audit row exists only for a row that IS superseded (the pair is written by the API below, in one function)
CREATE FUNCTION booking.notification_suppressions_bound() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM booking.external_operations o WHERE o.id = NEW.operation_id AND o.intent_id = NEW.intent_id AND o.op_type = 'guest.notify'
                  AND o.state = 'superseded' AND o.attempts = 0 AND o.dispatched_at IS NULL) THEN
    RAISE EXCEPTION 'NOTIFY_SUPPRESS_AUDIT_UNBOUND: the audit row describes a superseded, never-attempted guest.notify row' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION booking.notification_suppressions_bound() FROM PUBLIC;
CREATE TRIGGER notification_suppressions_bound BEFORE INSERT ON booking.notification_suppressions
  FOR EACH ROW EXECUTE FUNCTION booking.notification_suppressions_bound();

-- the ONLY path: locks the intent row (SHARE; the calling request already holds it FOR NO KEY UPDATE), then the ONE notify row FOR UPDATE,
-- re-checks every pristine fact, writes token -> UPDATE -> audit, drops the token. Returns the suppressed op id.
CREATE FUNCTION booking.suppress_guest_notification(p_intent uuid, p_by text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
DECLARE i booking.intents%ROWTYPE; o booking.external_operations%ROWTYPE; n integer; v_t timestamptz;
BEGIN
  IF p_by IS NULL OR length(p_by) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'NOTIFY_SUPPRESS_INPUT' USING ERRCODE = 'check_violation'; END IF;
  SELECT * INTO i FROM booking.intents WHERE id = p_intent FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOTIFY_SUPPRESS_REFUSED: NO_INTENT' USING ERRCODE = 'check_violation'; END IF;
  IF i.state IS DISTINCT FROM 'test_cleanup_pending' OR i.settlement_recording_mirrored IS NOT FALSE OR i.offline_charge_id IS NULL
     OR i.environment <> 'test' OR (SELECT environment FROM booking.instance) IS DISTINCT FROM 'test' THEN
    RAISE EXCEPTION 'NOTIFY_SUPPRESS_REFUSED: INTENT_STATE' USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*) INTO n FROM booking.external_operations WHERE intent_id = p_intent AND op_type = 'guest.notify';
  IF n <> 1 THEN RAISE EXCEPTION 'NOTIFY_SUPPRESS_REFUSED: NOTIFY_COUNT' USING ERRCODE = 'check_violation'; END IF;
  SELECT * INTO o FROM booking.external_operations WHERE intent_id = p_intent AND op_type = 'guest.notify' FOR UPDATE;
  IF o.state <> 'pending' OR o.attempts <> 0 OR o.dispatched_at IS NOT NULL OR o.lease_worker_id IS NOT NULL OR o.lease_until IS NOT NULL
     OR o.late_result_status IS NOT NULL OR (o.payload ->> 'template') IS DISTINCT FROM 'booking_confirmed' THEN
    RAISE EXCEPTION 'NOTIFY_SUPPRESS_REFUSED: NOT_PRISTINE' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM booking.notification_renders r WHERE r.operation_id = o.id) THEN RAISE EXCEPTION 'NOTIFY_SUPPRESS_REFUSED: RENDERED' USING ERRCODE = 'check_violation'; END IF;
  IF EXISTS (SELECT 1 FROM booking.notification_latches l WHERE l.operation_id = o.id) THEN RAISE EXCEPTION 'NOTIFY_SUPPRESS_REFUSED: LATCHED' USING ERRCODE = 'check_violation'; END IF;
  v_t := clock_timestamp();
  INSERT INTO booking.notification_write_authority (txid, operation_id, action) VALUES (pg_current_xact_id(), o.id, 'suppress');
  UPDATE booking.external_operations SET state = 'superseded', updated_at = v_t WHERE id = o.id;
  INSERT INTO booking.notification_suppressions (operation_id, intent_id, intent_version, reason, suppressed_by, suppressed_at)
  VALUES (o.id, p_intent, i.version, 'TEST_CLEANUP_RECORDED', p_by, v_t);
  DELETE FROM booking.notification_write_authority WHERE txid = pg_current_xact_id() AND operation_id = o.id AND action = 'suppress';
  RETURN o.id;
END $$;
REVOKE ALL ON FUNCTION booking.suppress_guest_notification(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION booking.suppress_guest_notification(uuid, text) TO mv_booking_app;

-- ---------------------------------------------------------------------------------------------
-- 8. read-only end-state predicate (Slice 5 postcheck): every persisted fact of a recorded-cleaned TEST booking
CREATE FUNCTION booking.recorded_state_cleanup_ok(p_intent uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
DECLARE i booking.intents%ROWTYPE;
BEGIN
  SELECT * INTO i FROM booking.intents WHERE id = p_intent;
  IF NOT FOUND THEN RETURN false; END IF;
  RETURN i.state = 'cancelled' AND i.reason_code = 'TEST_CLEANUP_REQUESTED' AND i.offline_charge_id IS NOT NULL
     AND i.settlement_reservation_cancelled IS TRUE AND i.settlement_authorization_settled IS TRUE AND i.settlement_recording_mirrored IS TRUE
     AND booking.test_refund_settled_for(i.id, i.stripe_payment_intent_id) AND booking.offline_refund_settled_for(i.id)
     AND (SELECT count(*) FROM booking.external_operations WHERE intent_id = i.id AND op_type = 'hostaway.record_offline_charge') = 1
     AND EXISTS (SELECT 1 FROM booking.external_operations WHERE intent_id = i.id AND op_type = 'hostaway.record_offline_charge'
                  AND state = 'succeeded' AND settled_evidence_id IS NOT NULL AND result_ref = i.offline_charge_id)
     AND (SELECT count(*) FROM booking.external_operations WHERE intent_id = i.id AND op_type = 'guest.notify') = 1
     AND EXISTS (SELECT 1 FROM booking.external_operations o JOIN booking.notification_suppressions s ON s.operation_id = o.id
                  WHERE o.intent_id = i.id AND o.op_type = 'guest.notify' AND o.state = 'superseded' AND o.attempts = 0 AND o.dispatched_at IS NULL)
     AND (SELECT count(*) FROM booking.payment_ledger WHERE intent_id = i.id AND entry = 'offline_charge_refund_recorded' AND provider = 'hostaway') = 1
     AND NOT EXISTS (SELECT 1 FROM booking.reconciliation_cases WHERE intent_id = i.id AND status = 'open')
     AND NOT EXISTS (SELECT 1 FROM booking.inventory_claims WHERE intent_id = i.id AND released_at IS NULL);
END $$;
REVOKE ALL ON FUNCTION booking.recorded_state_cleanup_ok(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION booking.recorded_state_cleanup_ok(uuid) TO mv_booking_app, mv_booking_admin;
