-- 0001_booking_core — Stage E2B (owner-authorized 2026-10-21). maraVilla booking database, schema "booking".
-- Design: claude/e2a-booking-database-design-2026-10-21.md. Offline foundation only: no route uses this schema yet.
--
-- Contains NO credentials and NO personal data. Guest personal data lives only in booking.intent_guests.
-- Run ONLY through scripts/db-migrate.mjs, which sets booking.migration_environment for this transaction.

CREATE EXTENSION IF NOT EXISTS btree_gist;  -- needed for the listing/night overlap exclusion constraint

CREATE SCHEMA booking;
REVOKE ALL ON SCHEMA booking FROM PUBLIC;

-- ---------------------------------------------------------------------------------------------
-- Environment marker: the application refuses to use a database whose marker differs from the
-- deployment's environment (test vs live). Set once, never changed.
CREATE TABLE booking.instance (
  singleton   boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  environment text NOT NULL CHECK (environment IN ('test', 'live')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO booking.instance (environment) VALUES (current_setting('booking.migration_environment'));

-- Shared helpers ------------------------------------------------------------------------------
CREATE FUNCTION booking.is_code(t text) RETURNS boolean LANGUAGE sql IMMUTABLE
  AS $$ SELECT t ~ '^[A-Z0-9_]{1,64}$' $$;

-- E3 intent-state-v1 states (lib/checkout/intent-state.js STATES).
CREATE FUNCTION booking.is_intent_state(s text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT s IN ('created','price_confirmed','details_collected','payment_pending','payment_authorized',
               'reservation_pending','reservation_unknown','reservation_confirmed','capture_unknown',
               'payment_captured','confirmed','validation_failed','expired','payment_failed',
               'payment_expired','reservation_failed','authorization_released','capture_failed',
               'cancelled','reconciliation_required') $$;

-- E3 TERMINAL_STATES.
CREATE FUNCTION booking.is_terminal_state(s text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT s IN ('confirmed','validation_failed','expired','payment_failed','payment_expired',
               'authorization_released','cancelled') $$;

CREATE FUNCTION booking.reject_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'booking.%: % is not allowed (append-only / no-delete table)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END $$;

-- ---------------------------------------------------------------------------------------------
-- 1. Booking intents: one row per E3 intent. Typed columns mirror the E3 intent object.
CREATE TABLE booking.intents (
  id                        uuid PRIMARY KEY,
  ref                       text NOT NULL UNIQUE CHECK (ref ~ '^MV-[A-Z0-9]{6,10}$'),
  access_token_hash         bytea NOT NULL CHECK (octet_length(access_token_hash) = 32),
  machine_version           text NOT NULL CHECK (machine_version = 'intent-state-v1'),
  environment               text NOT NULL CHECK (environment IN ('test', 'live')),
  state                     text NOT NULL CHECK (booking.is_intent_state(state)),
  version                   integer NOT NULL CHECK (version >= 0),
  -- stay
  listing_id                integer NOT NULL CHECK (listing_id > 0),
  from_date                 date NOT NULL,
  to_date                   date NOT NULL,
  stay                      daterange GENERATED ALWAYS AS (daterange(from_date, to_date, '[)')) STORED,
  guests                    smallint NOT NULL CHECK (guests BETWEEN 1 AND 50),
  -- server-authoritative price, fixed at PRICE_CONFIRMED (E3 intent.price)
  price_snapshot            jsonb CHECK (price_snapshot IS NULL OR jsonb_typeof(price_snapshot) = 'object'),
  currency                  char(3) CHECK (currency IN ('MXN', 'USD')),
  standard_total_minor      bigint CHECK (standard_total_minor >= 0),
  eligible_minor            bigint CHECK (eligible_minor >= 0),
  discount_minor            bigint CHECK (discount_minor >= 0),
  final_total_minor         bigint CHECK (final_total_minor > 0),
  policy_version            text,
  rate_bps                  integer CHECK (rate_bps BETWEEN 0 AND 10000),
  quote_hash                text,                       -- E3 quoteHashFor() fingerprint
  quote_expires_at          timestamptz,                -- quote-validity window; NOT a hold
  details_collected         boolean NOT NULL DEFAULT false,
  -- checkout / payment (E3 intent.checkout / intent.payment)
  checkout_session_id       text UNIQUE,
  checkout_attempt          smallint,
  checkout_prepared_at      timestamptz,
  stripe_payment_intent_id  text UNIQUE,
  payment_livemode          boolean,
  authorized_minor          bigint CHECK (authorized_minor > 0),
  authorization_created_at  timestamptz,                -- from Stripe
  capture_before            timestamptz,                -- from Stripe
  authorization_deadline    timestamptz,                -- E3: min(captureBefore - margin, created + internal cap)
  authorization_accepted_at timestamptz,
  captured_minor            bigint NOT NULL DEFAULT 0 CHECK (captured_minor >= 0),
  -- reservation (E3 intent.reservation / lease / dispatch)
  hostaway_reservation_id   text UNIQUE,
  reservation_confirmed_at  timestamptz,
  lease_worker_id           text CHECK (lease_worker_id IS NULL OR length(lease_worker_id) BETWEEN 1 AND 200),
  lease_until               timestamptz,
  dispatch_at               timestamptz,
  dispatch_attempt          smallint,
  offline_charge_id         text,
  -- E3 counters
  checkout_attempts         smallint NOT NULL DEFAULT 0 CHECK (checkout_attempts >= 0),
  reservation_attempts      smallint NOT NULL DEFAULT 0 CHECK (reservation_attempts >= 0),
  void_attempts             smallint NOT NULL DEFAULT 0 CHECK (void_attempts >= 0),
  reconcile_attempts        smallint NOT NULL DEFAULT 0 CHECK (reconcile_attempts >= 0),
  offline_charge_attempts   smallint NOT NULL DEFAULT 0 CHECK (offline_charge_attempts >= 0),
  reason_code               text CHECK (reason_code IS NULL OR booking.is_code(reason_code)),
  created_at                timestamptz NOT NULL,
  updated_at                timestamptz NOT NULL,

  CONSTRAINT dates_ok       CHECK (to_date > from_date AND to_date - from_date <= 365),
  CONSTRAINT lease_pair     CHECK ((lease_worker_id IS NULL) = (lease_until IS NULL)),
  CONSTRAINT dispatch_pair  CHECK ((dispatch_at IS NULL) = (dispatch_attempt IS NULL)),
  CONSTRAINT price_all_or_none CHECK (
    (price_snapshot IS NULL) = (final_total_minor IS NULL) AND (final_total_minor IS NULL) = (currency IS NULL)
    AND (final_total_minor IS NULL) = (quote_hash IS NULL) AND (final_total_minor IS NULL) = (policy_version IS NULL)
    AND (final_total_minor IS NULL) = (quote_expires_at IS NULL)),
  -- same invariant as lib/direct-pricing.js: direct total = standard - discount, discount <= eligible <= standard
  CONSTRAINT price_arithmetic CHECK (final_total_minor IS NULL OR (
    discount_minor <= eligible_minor AND eligible_minor <= standard_total_minor
    AND standard_total_minor - discount_minor = final_total_minor)),
  -- typed columns must equal the stored E3 price object
  CONSTRAINT price_snapshot_matches CHECK (price_snapshot IS NULL OR (
    (price_snapshot->>'finalTotalMinor')::bigint = final_total_minor
    AND (price_snapshot->>'standardTotalMinor')::bigint = standard_total_minor
    AND (price_snapshot->>'eligibleMinor')::bigint = eligible_minor
    AND (price_snapshot->>'discountMinor')::bigint = discount_minor
    AND price_snapshot->>'currency' = currency
    AND price_snapshot->>'quoteHash' = quote_hash
    AND price_snapshot->>'policyVersion' = policy_version
    AND (price_snapshot->>'listingId')::integer = listing_id
    AND price_snapshot->>'from' = to_char(from_date, 'YYYY-MM-DD')
    AND price_snapshot->>'to' = to_char(to_date, 'YYYY-MM-DD')
    AND (price_snapshot->>'guests')::integer = guests)),
  CONSTRAINT price_required  CHECK (state IN ('created', 'validation_failed', 'expired') OR final_total_minor IS NOT NULL),
  CONSTRAINT auth_required   CHECK (state NOT IN ('payment_authorized', 'reservation_pending', 'reservation_unknown',
                                    'reservation_failed', 'reservation_confirmed', 'capture_unknown', 'capture_failed',
                                    'payment_captured') OR stripe_payment_intent_id IS NOT NULL),
  CONSTRAINT auth_exact      CHECK (stripe_payment_intent_id IS NULL OR (authorized_minor = final_total_minor
                                    AND capture_before IS NOT NULL AND authorization_deadline IS NOT NULL)),
  CONSTRAINT reservation_required CHECK (state NOT IN ('reservation_confirmed', 'capture_unknown', 'capture_failed',
                                    'payment_captured', 'confirmed') OR hostaway_reservation_id IS NOT NULL),
  CONSTRAINT captured_exact  CHECK (state NOT IN ('payment_captured', 'confirmed') OR captured_minor = final_total_minor),
  CONSTRAINT no_capture_without_reservation CHECK (captured_minor = 0 OR hostaway_reservation_id IS NOT NULL),
  CONSTRAINT no_capture_above_price CHECK (captured_minor = 0 OR captured_minor <= final_total_minor),
  CONSTRAINT lease_only_when_reserving CHECK (lease_worker_id IS NULL OR state = 'reservation_pending'),
  UNIQUE (id, listing_id, stay)   -- target of the inventory_claims composite foreign key
);

CREATE INDEX intents_state_idx ON booking.intents (state);

CREATE FUNCTION booking.intents_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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

CREATE TRIGGER intents_guard BEFORE INSERT OR UPDATE ON booking.intents
  FOR EACH ROW EXECUTE FUNCTION booking.intents_guard();
CREATE TRIGGER intents_no_delete BEFORE DELETE ON booking.intents
  FOR EACH ROW EXECUTE FUNCTION booking.reject_change();
CREATE TRIGGER intents_no_truncate BEFORE TRUNCATE ON booking.intents
  FOR EACH STATEMENT EXECUTE FUNCTION booking.reject_change();

-- ---------------------------------------------------------------------------------------------
-- 2. Audit trail: exactly one row per committed intent version (append-only).
CREATE TABLE booking.intent_transitions (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  intent_id     uuid NOT NULL REFERENCES booking.intents (id),
  version_after integer NOT NULL CHECK (version_after >= 0),
  from_state    text CHECK (from_state IS NULL OR booking.is_intent_state(from_state)),
  to_state      text NOT NULL CHECK (booking.is_intent_state(to_state)),
  event_type    text NOT NULL CHECK (booking.is_code(event_type)),
  event_id      text CHECK (event_id IS NULL OR length(event_id) BETWEEN 1 AND 200),
  reason_code   text CHECK (reason_code IS NULL OR booking.is_code(reason_code)),
  actor         text NOT NULL CHECK (actor IN ('guest', 'webhook', 'worker', 'reconciler', 'admin', 'system')),
  worker_id     text CHECK (worker_id IS NULL OR length(worker_id) BETWEEN 1 AND 200),
  at            timestamptz NOT NULL,
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (intent_id, version_after)
);
CREATE TRIGGER intent_transitions_append_only BEFORE UPDATE OR DELETE ON booking.intent_transitions
  FOR EACH ROW EXECUTE FUNCTION booking.reject_change();
CREATE TRIGGER intent_transitions_no_truncate BEFORE TRUNCATE ON booking.intent_transitions
  FOR EACH STATEMENT EXECUTE FUNCTION booking.reject_change();

-- 3. Permanent per-intent event de-duplication (replaces E3's bounded seenEventIds as the record).
CREATE TABLE booking.intent_applied_events (
  intent_id       uuid NOT NULL REFERENCES booking.intents (id),
  event_id        text NOT NULL CHECK (length(event_id) BETWEEN 1 AND 200),
  event_type      text NOT NULL CHECK (booking.is_code(event_type)),
  applied_version integer NOT NULL,
  applied_at      timestamptz NOT NULL,
  PRIMARY KEY (intent_id, event_id)
);
CREATE TRIGGER intent_applied_events_append_only BEFORE UPDATE OR DELETE ON booking.intent_applied_events
  FOR EACH ROW EXECUTE FUNCTION booking.reject_change();

-- 4. Guest personal data — the ONLY table with PII. Purged by booking.purge_guest_data().
CREATE TABLE booking.intent_guests (
  intent_id         uuid PRIMARY KEY REFERENCES booking.intents (id),
  first_name        text NOT NULL CHECK (length(btrim(first_name)) BETWEEN 1 AND 100),
  last_name         text NOT NULL CHECK (length(btrim(last_name)) BETWEEN 1 AND 100),
  email             text NOT NULL CHECK (length(email) BETWEEN 3 AND 254 AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  phone             text CHECK (phone IS NULL OR phone ~ '^[+0-9 ()-]{6,32}$'),
  terms_version     text NOT NULL CHECK (length(terms_version) BETWEEN 1 AND 40),
  terms_accepted_at timestamptz NOT NULL,
  created_at        timestamptz NOT NULL
);

-- 5. Scheduling and worker pick-up. Deliberately separate from intents so scheduling never bumps the E3 version.
CREATE TABLE booking.intent_work (
  intent_id        uuid PRIMARY KEY REFERENCES booking.intents (id),
  next_action_at   timestamptz,
  work_worker_id   text,
  work_lease_until timestamptz,
  CHECK ((work_worker_id IS NULL) = (work_lease_until IS NULL))
);
CREATE INDEX intent_work_due_idx ON booking.intent_work (next_action_at) WHERE next_action_at IS NOT NULL;

-- ---------------------------------------------------------------------------------------------
-- 6. Inventory claims: PostgreSQL-enforced protection against overlapping ACTIVE claims.
--    Half-open [from, to): a check-out day may be the next guest's check-in day.
--    A claim is released only (a) in the same transaction as a safe terminal transition with no unresolved
--    payment attempt, or (b) by evidence-based review. review_after makes a claim DUE FOR REVIEW; time alone never
--    releases it.
CREATE TABLE booking.inventory_claims (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  intent_id      uuid NOT NULL,
  listing_id     integer NOT NULL,
  stay           daterange NOT NULL CHECK (NOT isempty(stay) AND lower_inc(stay) AND NOT upper_inc(stay)),
  kind           text NOT NULL CHECK (kind IN ('checkout', 'authorized', 'reserved')),
  claimed_at     timestamptz NOT NULL,
  review_after   timestamptz NOT NULL,
  review_count   integer NOT NULL DEFAULT 0 CHECK (review_count >= 0),
  released_at    timestamptz,
  release_reason text CHECK (release_reason IS NULL OR booking.is_code(release_reason)),
  CHECK ((released_at IS NULL) = (release_reason IS NULL)),
  FOREIGN KEY (intent_id, listing_id, stay) REFERENCES booking.intents (id, listing_id, stay),
  CONSTRAINT inventory_no_overlap EXCLUDE USING gist (listing_id WITH =, stay WITH &&) WHERE (released_at IS NULL)
);
CREATE UNIQUE INDEX inventory_one_active_claim_per_intent ON booking.inventory_claims (intent_id) WHERE released_at IS NULL;
CREATE INDEX inventory_claims_review_idx ON booking.inventory_claims (review_after) WHERE released_at IS NULL;

CREATE FUNCTION booking.claims_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.intent_id <> OLD.intent_id OR NEW.listing_id <> OLD.listing_id OR NEW.stay <> OLD.stay OR NEW.claimed_at <> OLD.claimed_at THEN
    RAISE EXCEPTION 'claim identity is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.released_at IS NOT NULL THEN
    RAISE EXCEPTION 'a released claim cannot be reactivated or changed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER claims_guard BEFORE UPDATE ON booking.inventory_claims FOR EACH ROW EXECUTE FUNCTION booking.claims_guard();
CREATE TRIGGER claims_no_delete BEFORE DELETE ON booking.inventory_claims FOR EACH ROW EXECUTE FUNCTION booking.reject_change();

-- ---------------------------------------------------------------------------------------------
-- 7. Payment attempts: one Stripe Checkout Session per attempt; payment-specific idempotency key.
--    Written as 'creating' BEFORE the Stripe call, so a session can never exist without a record here.
CREATE TABLE booking.payment_attempts (
  id                         uuid PRIMARY KEY,
  intent_id                  uuid NOT NULL REFERENCES booking.intents (id),
  attempt                    smallint NOT NULL CHECK (attempt >= 1),
  idempotency_key            text NOT NULL UNIQUE,
  status                     text NOT NULL CHECK (status IN ('creating', 'open', 'completed', 'expired', 'failed', 'not_created', 'outcome_unknown')),
  checkout_session_id        text UNIQUE,
  payment_intent_id          text UNIQUE,
  livemode                   boolean,
  amount_minor               bigint NOT NULL CHECK (amount_minor > 0),
  currency                   char(3) NOT NULL CHECK (currency IN ('MXN', 'USD')),
  planned_session_expires_at timestamptz NOT NULL,      -- expires_at we send to Stripe (decided before the call)
  session_expires_at         timestamptz,
  created_at                 timestamptz NOT NULL,
  updated_at                 timestamptz NOT NULL,
  UNIQUE (intent_id, attempt),
  CHECK (idempotency_key = 'cs:' || intent_id::text || ':' || attempt::text),
  CHECK (status IN ('creating', 'outcome_unknown', 'not_created') OR checkout_session_id IS NOT NULL)
);

CREATE FUNCTION booking.payment_attempts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE i booking.intents%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO i FROM booking.intents WHERE id = NEW.intent_id;
    IF i.final_total_minor IS NULL OR NEW.amount_minor <> i.final_total_minor OR NEW.currency <> i.currency THEN
      RAISE EXCEPTION 'payment attempt amount/currency must equal the intent''s confirmed price' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.intent_id <> OLD.intent_id OR NEW.attempt <> OLD.attempt OR NEW.idempotency_key <> OLD.idempotency_key
     OR NEW.amount_minor <> OLD.amount_minor OR NEW.currency <> OLD.currency OR NEW.created_at <> OLD.created_at
     OR NEW.planned_session_expires_at <> OLD.planned_session_expires_at THEN
    RAISE EXCEPTION 'payment attempt identity and amount are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.checkout_session_id IS NOT NULL AND NEW.checkout_session_id IS DISTINCT FROM OLD.checkout_session_id THEN
    RAISE EXCEPTION 'checkout session id is immutable once recorded' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.payment_intent_id IS NOT NULL AND NEW.payment_intent_id IS DISTINCT FROM OLD.payment_intent_id THEN
    RAISE EXCEPTION 'payment intent id is immutable once recorded' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status IN ('completed', 'expired', 'failed', 'not_created') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'payment attempt % is final', OLD.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_attempts_guard BEFORE INSERT OR UPDATE ON booking.payment_attempts
  FOR EACH ROW EXECUTE FUNCTION booking.payment_attempts_guard();
CREATE TRIGGER payment_attempts_no_delete BEFORE DELETE ON booking.payment_attempts
  FOR EACH ROW EXECUTE FUNCTION booking.reject_change();

-- ---------------------------------------------------------------------------------------------
-- 8. Transactional outbox: every external side effect an E3 transition emits, written in the SAME transaction.
--    Nothing in E2B executes these rows against Stripe or Hostaway.
--    A unique row is NOT exactly-once delivery: it bounds what OUR system may send, nothing more.
CREATE TABLE booking.external_operations (
  id                     uuid PRIMARY KEY,
  intent_id              uuid NOT NULL REFERENCES booking.intents (id),
  op_type                text NOT NULL CHECK (op_type IN (
                           'stripe.create_checkout_session', 'stripe.retrieve_payment_intent', 'stripe.capture_payment_intent',
                           'stripe.void_payment_intent', 'hostaway.lookup_reservation', 'hostaway.create_reservation',
                           'hostaway.cancel_reservation', 'hostaway.record_offline_charge', 'guest.notify', 'alert.owner')),
  idempotency_key        text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 3 AND 200),
  retry_class            text NOT NULL CHECK (retry_class IN ('read', 'idempotent', 'non_idempotent')),
  state                  text NOT NULL CHECK (state IN ('pending', 'in_flight', 'succeeded', 'failed_definite',
                           'outcome_unknown', 'superseded', 'escalated')),
  payload                jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),  -- ids/amounts/codes only
  source_version         integer NOT NULL,
  attempts               smallint NOT NULL DEFAULT 0,
  max_attempts           smallint NOT NULL CHECK (max_attempts >= 1),
  requires_provider_read boolean NOT NULL DEFAULT false,   -- after an interrupted idempotent call: read provider state first
  lease_worker_id        text,
  lease_until            timestamptz,
  next_attempt_at        timestamptz NOT NULL,
  dispatched_at          timestamptz,
  completed_at           timestamptz,
  result_ref             text,
  error_code             text CHECK (error_code IS NULL OR booking.is_code(error_code)),
  late_result_status     text CHECK (late_result_status IS NULL OR late_result_status IN ('succeeded', 'failed_definite', 'outcome_unknown')),
  late_result_ref        text,
  created_at             timestamptz NOT NULL,
  updated_at             timestamptz NOT NULL,
  CHECK (attempts <= max_attempts),
  -- A non-idempotent provider write (Hostaway create, Hostaway payment recording) is attempted at most ONCE per row.
  CHECK (retry_class <> 'non_idempotent' OR max_attempts = 1),
  CHECK ((lease_worker_id IS NULL) = (lease_until IS NULL)),
  CHECK (state <> 'in_flight' OR lease_until IS NOT NULL),
  CHECK (op_type NOT IN ('hostaway.create_reservation', 'hostaway.record_offline_charge') OR retry_class = 'non_idempotent')
);
CREATE INDEX external_operations_due_idx ON booking.external_operations (next_attempt_at) WHERE state = 'pending';
CREATE INDEX external_operations_inflight_idx ON booking.external_operations (lease_until) WHERE state = 'in_flight';
-- At most ONE Hostaway create per intent, ever (R1).
CREATE UNIQUE INDEX external_operations_one_hostaway_create ON booking.external_operations (intent_id)
  WHERE op_type = 'hostaway.create_reservation';
-- No new Hostaway payment-recording while an earlier one is pending, in flight, ambiguous or escalated.
CREATE UNIQUE INDEX external_operations_one_open_offline_charge ON booking.external_operations (intent_id)
  WHERE op_type = 'hostaway.record_offline_charge' AND state IN ('pending', 'in_flight', 'outcome_unknown', 'escalated');

CREATE FUNCTION booking.external_operations_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'pending' OR NEW.attempts <> 0 THEN
      RAISE EXCEPTION 'operations are created pending with no attempts' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.intent_id <> OLD.intent_id OR NEW.op_type <> OLD.op_type OR NEW.idempotency_key <> OLD.idempotency_key
     OR NEW.retry_class <> OLD.retry_class OR NEW.payload <> OLD.payload OR NEW.max_attempts <> OLD.max_attempts
     OR NEW.created_at <> OLD.created_at OR NEW.attempts < OLD.attempts THEN
    RAISE EXCEPTION 'operation identity is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state = OLD.state THEN RETURN NEW; END IF;
  -- Allowed state moves (operations' own state machine).
  IF NOT (
       (OLD.state = 'pending'         AND NEW.state IN ('in_flight', 'superseded', 'escalated'))
    OR (OLD.state = 'in_flight'       AND NEW.state IN ('succeeded', 'failed_definite', 'outcome_unknown', 'escalated'))
    OR (OLD.state = 'in_flight'       AND NEW.state = 'pending' AND OLD.retry_class <> 'non_idempotent')
    OR (OLD.state = 'outcome_unknown' AND NEW.state IN ('succeeded', 'failed_definite', 'escalated'))
    OR (OLD.state = 'outcome_unknown' AND NEW.state = 'pending' AND OLD.retry_class <> 'non_idempotent')
    OR (OLD.state = 'escalated'       AND NEW.state IN ('succeeded', 'failed_definite'))
  ) THEN
    RAISE EXCEPTION 'operation state % -> % not allowed (retry class %)', OLD.state, NEW.state, OLD.retry_class
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER external_operations_guard BEFORE INSERT OR UPDATE ON booking.external_operations
  FOR EACH ROW EXECUTE FUNCTION booking.external_operations_guard();
CREATE TRIGGER external_operations_no_delete BEFORE DELETE ON booking.external_operations
  FOR EACH ROW EXECUTE FUNCTION booking.reject_change();

-- ---------------------------------------------------------------------------------------------
-- 9. Hostaway reservation attempts: inserted in the SAME transaction as E3 RESERVATION_DISPATCHED, i.e. before
--    any create request can leave the server. UNIQUE (intent_id): one create per intent, ever.
CREATE TABLE booking.hostaway_reservation_attempts (
  id                       uuid PRIMARY KEY,
  intent_id                uuid NOT NULL UNIQUE REFERENCES booking.intents (id),
  operation_id             uuid NOT NULL UNIQUE REFERENCES booking.external_operations (id),
  booking_ref              text NOT NULL,                 -- = intents.ref; sent in a Hostaway custom field for lookup
  state                    text NOT NULL CHECK (state IN ('dispatched', 'succeeded', 'refused', 'outcome_unknown',
                             'reconciled_found', 'escalated')),
  dispatched_at            timestamptz NOT NULL,          -- committed BEFORE sending
  send_started_at          timestamptz,                   -- set when a worker claims the send (evidence only)
  responded_at             timestamptz,
  http_status              smallint,
  refusal_code             text CHECK (refusal_code IS NULL OR booking.is_code(refusal_code)),
  hostaway_reservation_id  text UNIQUE,
  verified_listing_id      integer,
  verified_from            date,
  verified_to              date,
  verified_total_minor     bigint,
  lookup_count             integer NOT NULL DEFAULT 0,
  last_lookup_at           timestamptz,
  last_lookup_result       text CHECK (last_lookup_result IS NULL OR last_lookup_result IN ('found', 'not_found', 'error')),
  updated_at               timestamptz NOT NULL
);
CREATE FUNCTION booking.hostaway_attempts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.intent_id <> OLD.intent_id OR NEW.operation_id <> OLD.operation_id OR NEW.booking_ref <> OLD.booking_ref
     OR NEW.dispatched_at <> OLD.dispatched_at THEN
    RAISE EXCEPTION 'Hostaway attempt identity is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.hostaway_reservation_id IS NOT NULL AND NEW.hostaway_reservation_id IS DISTINCT FROM OLD.hostaway_reservation_id THEN
    RAISE EXCEPTION 'recorded Hostaway reservation id is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.state IN ('succeeded', 'reconciled_found', 'refused') AND NEW.state <> OLD.state THEN
    RAISE EXCEPTION 'Hostaway attempt % is final', OLD.state USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hostaway_attempts_guard BEFORE UPDATE ON booking.hostaway_reservation_attempts
  FOR EACH ROW EXECUTE FUNCTION booking.hostaway_attempts_guard();
CREATE TRIGGER hostaway_attempts_no_delete BEFORE DELETE ON booking.hostaway_reservation_attempts
  FOR EACH ROW EXECUTE FUNCTION booking.reject_change();

-- ---------------------------------------------------------------------------------------------
-- 10. Money ledger (append-only): every verified money fact once.
CREATE TABLE booking.payment_ledger (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  intent_id    uuid NOT NULL REFERENCES booking.intents (id),
  entry        text NOT NULL CHECK (entry IN ('authorization_accepted', 'authorization_rejected', 'authorization_voided',
                 'capture_succeeded', 'refund_succeeded', 'refund_failed', 'offline_charge_recorded')),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency     char(3) NOT NULL,
  provider     text NOT NULL CHECK (provider IN ('stripe', 'hostaway')),
  provider_ref text NOT NULL,
  source       text NOT NULL,
  at           timestamptz NOT NULL,
  UNIQUE (entry, provider, provider_ref)
);
CREATE TRIGGER payment_ledger_append_only BEFORE UPDATE OR DELETE ON booking.payment_ledger
  FOR EACH ROW EXECUTE FUNCTION booking.reject_change();
CREATE TRIGGER payment_ledger_no_truncate BEFORE TRUNCATE ON booking.payment_ledger
  FOR EACH STATEMENT EXECUTE FUNCTION booking.reject_change();

-- 11. Refunds (outside the E3 state machine; flows arrive in a later stage).
CREATE TABLE booking.payment_refunds (
  id                  uuid PRIMARY KEY,
  intent_id           uuid NOT NULL REFERENCES booking.intents (id),
  seq                 smallint NOT NULL CHECK (seq >= 1),
  idempotency_key     text NOT NULL UNIQUE,
  stripe_refund_id    text UNIQUE,
  amount_minor        bigint NOT NULL CHECK (amount_minor > 0),
  currency            char(3) NOT NULL,
  reason_code         text NOT NULL CHECK (booking.is_code(reason_code)),
  requested_by        text NOT NULL CHECK (requested_by IN ('admin', 'system')),
  state               text NOT NULL CHECK (state IN ('requested', 'in_flight', 'succeeded', 'failed', 'outcome_unknown')),
  hostaway_state      text NOT NULL DEFAULT 'pending' CHECK (hostaway_state IN ('pending', 'recorded', 'failed', 'outcome_unknown')),
  hostaway_refund_ref text,
  created_at          timestamptz NOT NULL,
  updated_at          timestamptz NOT NULL,
  UNIQUE (intent_id, seq),
  CHECK (idempotency_key = 'ref:' || intent_id::text || ':' || seq::text)
);
CREATE FUNCTION booking.payment_refunds_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cap bigint; cur char(3); total bigint;
BEGIN
  -- Lock the intent row (short; no network inside) so concurrent refund requests are serialised.
  SELECT captured_minor, currency INTO cap, cur FROM booking.intents WHERE id = NEW.intent_id FOR UPDATE;
  IF NEW.currency <> cur THEN
    RAISE EXCEPTION 'refund currency must equal the intent currency' USING ERRCODE = 'check_violation';
  END IF;
  SELECT coalesce(sum(amount_minor), 0) INTO total FROM booking.payment_refunds
   WHERE intent_id = NEW.intent_id AND state <> 'failed' AND id <> NEW.id;
  IF NEW.state <> 'failed' AND total + NEW.amount_minor > cap THEN
    RAISE EXCEPTION 'refunds (%) would exceed captured amount (%)', total + NEW.amount_minor, cap USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_refunds_guard BEFORE INSERT OR UPDATE ON booking.payment_refunds
  FOR EACH ROW EXECUTE FUNCTION booking.payment_refunds_guard();
CREATE TRIGGER payment_refunds_no_delete BEFORE DELETE ON booking.payment_refunds
  FOR EACH ROW EXECUTE FUNCTION booking.reject_change();

-- 12. Reconciliation cases: anything uncertain, for owner review. One OPEN case per (intent, kind).
CREATE TABLE booking.reconciliation_cases (
  id          uuid PRIMARY KEY,
  intent_id   uuid NOT NULL REFERENCES booking.intents (id),
  kind        text NOT NULL CHECK (booking.is_code(kind)),
  status      text NOT NULL CHECK (status IN ('open', 'resolved')),
  opened_at   timestamptz NOT NULL,
  opened_by   text NOT NULL,                          -- event or operation id
  evidence    jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence) = 'object'),  -- ids/amounts/codes only
  resolution  text CHECK (resolution IS NULL OR resolution IN ('confirmed', 'released', 'cancelled', 'refunded', 'recorded', 'no_action')),
  resolved_by text,
  resolved_at timestamptz,
  CHECK ((status = 'resolved') = (resolved_at IS NOT NULL AND resolution IS NOT NULL AND resolved_by IS NOT NULL))
);
CREATE UNIQUE INDEX reconciliation_one_open_case ON booking.reconciliation_cases (intent_id, kind) WHERE status = 'open';
CREATE TRIGGER reconciliation_cases_no_delete BEFORE DELETE ON booking.reconciliation_cases
  FOR EACH ROW EXECUTE FUNCTION booking.reject_change();

-- 13. Stripe webhook events: permanent de-duplication by event id. Only signature-verified events are inserted.
--     No payload is stored (Checkout payloads contain guest name and email).
CREATE TABLE booking.stripe_webhook_events (
  event_id          text PRIMARY KEY CHECK (event_id ~ '^evt_[A-Za-z0-9_]{1,200}$'),
  event_type        text NOT NULL CHECK (event_type ~ '^[a-z_.]{1,100}$'),
  livemode          boolean NOT NULL,
  api_version       text,
  stripe_created_at timestamptz NOT NULL,
  object_id         text CHECK (object_id IS NULL OR object_id ~ '^[a-z]{2,6}_[A-Za-z0-9_]{1,200}$'),
  intent_id         uuid REFERENCES booking.intents (id),
  received_at       timestamptz NOT NULL,
  status            text NOT NULL CHECK (status IN ('received', 'processed', 'ignored', 'failed_retryable')),
  processed_at      timestamptz,
  attempts          integer NOT NULL DEFAULT 1 CHECK (attempts >= 1),
  error_code        text CHECK (error_code IS NULL OR booking.is_code(error_code))
);
CREATE FUNCTION booking.stripe_events_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.event_id <> OLD.event_id OR NEW.event_type <> OLD.event_type OR NEW.livemode <> OLD.livemode
     OR NEW.stripe_created_at <> OLD.stripe_created_at OR NEW.received_at <> OLD.received_at
     OR NEW.object_id IS DISTINCT FROM OLD.object_id OR NEW.attempts < OLD.attempts
     OR (OLD.intent_id IS NOT NULL AND NEW.intent_id IS DISTINCT FROM OLD.intent_id) THEN
    RAISE EXCEPTION 'webhook event record is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status IN ('processed', 'ignored') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'webhook event % is final', OLD.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stripe_events_guard BEFORE UPDATE ON booking.stripe_webhook_events
  FOR EACH ROW EXECUTE FUNCTION booking.stripe_events_guard();
CREATE TRIGGER stripe_events_no_delete BEFORE DELETE ON booking.stripe_webhook_events
  FOR EACH ROW EXECUTE FUNCTION booking.reject_change();
CREATE TRIGGER stripe_events_no_truncate BEFORE TRUNCATE ON booking.stripe_webhook_events
  FOR EACH STATEMENT EXECUTE FUNCTION booking.reject_change();

-- ---------------------------------------------------------------------------------------------
-- 14. Guest-data purge with CALLER-SUPPLIED (configurable, provisional) retention periods.
--     SECURITY DEFINER so the runtime role needs no DELETE privilege. Never purges an intent that is still in
--     progress or that has an open reconciliation case.
CREATE FUNCTION booking.purge_guest_data(p_now timestamptz, p_failed_attempt_days integer, p_post_checkout_days integer)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
DECLARE n integer;
BEGIN
  IF p_now IS NULL OR p_failed_attempt_days IS NULL OR p_post_checkout_days IS NULL
     OR p_failed_attempt_days NOT BETWEEN 1 AND 3650 OR p_post_checkout_days NOT BETWEEN 1 AND 3650 THEN
    RAISE EXCEPTION 'invalid retention parameters' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  DELETE FROM booking.intent_guests g
   USING booking.intents i
   WHERE i.id = g.intent_id
     AND NOT EXISTS (SELECT 1 FROM booking.reconciliation_cases c WHERE c.intent_id = i.id AND c.status = 'open')
     AND (
          -- no booking was made
          (i.state IN ('validation_failed', 'expired', 'payment_failed', 'payment_expired', 'authorization_released', 'cancelled')
           AND i.updated_at + make_interval(days => p_failed_attempt_days) <= p_now)
          -- booking made: keep until the configured period after check-out
       OR (i.state = 'confirmed'
           AND (i.to_date + p_post_checkout_days)::timestamp AT TIME ZONE 'UTC' <= p_now)
     );
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION booking.purge_guest_data(timestamptz, integer, integer) FROM PUBLIC;

-- ---------------------------------------------------------------------------------------------
-- Deny by default: row-level security on every table; policies for the runtime role are added in 0002.
ALTER TABLE booking.instance                      ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking.intents                       ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking.intent_transitions            ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking.intent_applied_events         ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking.intent_guests                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking.intent_work                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking.inventory_claims              ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking.payment_attempts              ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking.external_operations           ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking.hostaway_reservation_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking.payment_ledger                ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking.payment_refunds               ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking.reconciliation_cases          ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking.stripe_webhook_events         ENABLE ROW LEVEL SECURITY;
