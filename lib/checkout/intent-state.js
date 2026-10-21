// lib/checkout/intent-state.js — Stage E3 (owner-authorized 2026-10-21).
//
// Booking-intent state machine for the future direct-booking checkout
// (architecture A' from claude/e0-checkout-architecture-2026-10-20.md:
// validate -> authorize -> re-validate + reserve -> capture / void).
//
// PURE: no I/O, no environment, no clock (the caller passes ctx.now), no
// database, no Stripe, no Hostaway. Not imported by any route.
//
// transition(intent, event, ctx) returns
//   { ok:true, intent, duplicate, effects }   new frozen intent + INTENDED external
//                                             operations (descriptions only; never executed here)
//   { ok:false, error, intent }               the unchanged intent; nothing happened
//
// Safety rules encoded here (E0 §5.3 + owner addendum R1–R5):
//   - No reservation without a verified authorization of the exact amount/currency/mode.
//   - No capture without a verified Hostaway reservation matching listing/dates/total.
//   - Amount and currency are fixed at PRICE_CONFIRMED; a different price needs a new intent.
//   - Once a Hostaway create request may have been sent (RESERVATION_DISPATCHED), an
//     ambiguous result or an interrupted worker NEVER leads to another create: the intent
//     goes to reservation_unknown and only reconciliation evidence can move it on (R1).
//   - A reservation whose payment outcome is uncertain stays in capture_unknown /
//     reconciliation_required; it is never reported as a confirmed paid booking.
//   - A redirect is never an event here (R5): only server-verified facts are.
//   - Leases are short claims, not database transactions held across network calls (R2).
//   - Duplicate events (same event id, or a repeated authorization for the same
//     PaymentIntent) are acknowledged without changing anything.
//   - The 30-minute window is a QUOTE-VALIDITY window only: the guest may accept the
//     quoted price within it. Nothing is held: no reservation, no supplier hold and no
//     persisted price lock exist. Availability and price are re-validated before the
//     reservation is created, and any change refuses the booking.
//   - Authorization deadlines come from Stripe's payment data (authorization creation
//     time and capture deadline). The internal 5-day limit is only an extra, conservative
//     cap; it is NOT an assumption that Stripe keeps an authorization valid for 5 days.
//     Without Stripe's timestamps the authorization is not accepted.
//
// INTEGRATION PREREQUISITES — this module is NOT safe on its own. A future stage
// (E2/E5/E6/E7) must provide, before any real use:
//   1. Durable persistence of every returned intent, written with an atomic version
//      check (UPDATE ... WHERE id = $1 AND version = $expected); a failed check means
//      another worker won and the result must be discarded.
//   2. Write-before-send: RESERVATION_DISPATCHED must be durably committed BEFORE the
//      Hostaway create request leaves the server (Hostaway has no idempotency key).
//   3. Permanent webhook/event de-duplication (e.g. a stripe_events table unique on
//      event id); seenEventIds here is a bounded convenience, not the record.
//   4. Cross-intent overlap control (e.g. an exclusion constraint on listing + dates)
//      so two intents cannot pay for the same nights at once.
//   5. Validated external event authenticity before any event reaches transition():
//      Stripe webhook signatures + livemode, fresh API reads for every RECONCILED_*
//      event, and conservative mapping (only a verified definite refusal is "definite";
//      timeouts, 5xx and 429 are "outcome unknown").
//   6. Synchronised, monotonic server time for ctx.now (leases, quote validity,
//      authorization deadlines).
//   7. Effects executed with the idempotency keys carried in each effect.
// These are prerequisites only; E3 implements none of them.

export const STATE_MACHINE_VERSION = "intent-state-v1";

export const STATES = Object.freeze({
  CREATED: "created",
  PRICE_CONFIRMED: "price_confirmed",
  DETAILS_COLLECTED: "details_collected",
  PAYMENT_PENDING: "payment_pending",           // checkout prepared, guest paying
  PAYMENT_AUTHORIZED: "payment_authorized",     // funds held, not captured
  RESERVATION_PENDING: "reservation_pending",   // worker holds a lease; create may be in flight
  RESERVATION_UNKNOWN: "reservation_unknown",   // create outcome ambiguous -> reconcile only
  RESERVATION_CONFIRMED: "reservation_confirmed",
  CAPTURE_UNKNOWN: "capture_unknown",           // capture outcome ambiguous -> reconcile only
  PAYMENT_CAPTURED: "payment_captured",         // booked and paid; offline charge pending (R3)
  CONFIRMED: "confirmed",
  // failure / closing states
  VALIDATION_FAILED: "validation_failed",
  EXPIRED: "expired",
  PAYMENT_FAILED: "payment_failed",
  PAYMENT_EXPIRED: "payment_expired",
  RESERVATION_FAILED: "reservation_failed",     // definite failure; authorization must be voided
  AUTHORIZATION_RELEASED: "authorization_released",
  CAPTURE_FAILED: "capture_failed",             // reservation exists; must be cancelled
  CANCELLED: "cancelled",
  RECONCILIATION_REQUIRED: "reconciliation_required"
});
const S = STATES;

export const TERMINAL_STATES = Object.freeze([
  S.CONFIRMED, S.VALIDATION_FAILED, S.EXPIRED, S.PAYMENT_FAILED, S.PAYMENT_EXPIRED, S.AUTHORIZATION_RELEASED, S.CANCELLED
]);

export const EVENTS = Object.freeze([
  "PRICE_CONFIRMED", "VALIDATION_FAILED", "DETAILS_COLLECTED", "CHECKOUT_PREPARED", "EXPIRE",
  "PAYMENT_AUTHORIZED", "PAYMENT_FAILED", "CHECKOUT_EXPIRED",
  "RESERVATION_STARTED", "RESERVATION_DISPATCHED", "RESERVATION_SUCCEEDED", "RESERVATION_FAILED", "RESERVATION_OUTCOME_UNKNOWN", "RECOVER_INTERRUPTED",
  "RECONCILED_RESERVATION_FOUND", "RECONCILED_RESERVATION_ABSENT", "RECONCILIATION_INCONCLUSIVE",
  "VOID_SUCCEEDED", "VOID_FAILED",
  "CAPTURE_SUCCEEDED", "CAPTURE_FAILED", "CAPTURE_OUTCOME_UNKNOWN",
  "RECONCILED_CAPTURE_SUCCEEDED", "RECONCILED_STILL_AUTHORIZED", "RECONCILED_AUTHORIZATION_GONE",
  "RESERVATION_CANCELLED", "RESERVATION_CANCEL_FAILED",
  "OFFLINE_CHARGE_RECORDED", "OFFLINE_CHARGE_FAILED",
  "ESCALATE", "RESOLVE"
]);

export const DEFAULT_CONFIG = Object.freeze({
  quoteValidityMs: 30 * 60 * 1000,              // quote may be accepted for 30 min; NOT a hold (see header)
  leaseMs: 2 * 60 * 1000,                       // worker claim on reservation_pending
  internalAuthorizationDeadlineMs: 5 * 24 * 60 * 60 * 1000, // internal conservative cap from Stripe's authorization time; not a Stripe guarantee
  captureSafetyMarginMs: 12 * 60 * 60 * 1000,  // stop relying on an authorization this long before Stripe's capture deadline
  maxClockSkewMs: 5 * 60 * 1000,               // tolerated difference between Stripe timestamps and ctx.now
  maxVoidAttempts: 5,
  maxReconcileAttempts: 5,
  maxOfflineChargeAttempts: 10,
  expectedLivemode: false,                      // sandbox by default
  lookupAbsenceIsAuthoritative: false,          // R1: until E4 proves Hostaway lookup, absence is NOT proof
  maxSeenEventIds: 100
});

const ROUTES = Object.freeze({
  [S.CREATED]: ["PRICE_CONFIRMED", "VALIDATION_FAILED", "EXPIRE", "ESCALATE"],
  [S.PRICE_CONFIRMED]: ["DETAILS_COLLECTED", "VALIDATION_FAILED", "EXPIRE", "ESCALATE"],
  [S.DETAILS_COLLECTED]: ["CHECKOUT_PREPARED", "EXPIRE", "ESCALATE"],
  [S.PAYMENT_PENDING]: ["CHECKOUT_PREPARED", "PAYMENT_AUTHORIZED", "PAYMENT_FAILED", "CHECKOUT_EXPIRED", "ESCALATE"],
  [S.PAYMENT_AUTHORIZED]: ["PAYMENT_AUTHORIZED", "RESERVATION_STARTED", "ESCALATE"],
  [S.RESERVATION_PENDING]: ["PAYMENT_AUTHORIZED", "RESERVATION_DISPATCHED", "RESERVATION_SUCCEEDED", "RESERVATION_FAILED", "RESERVATION_OUTCOME_UNKNOWN", "RECOVER_INTERRUPTED", "ESCALATE"],
  [S.RESERVATION_UNKNOWN]: ["PAYMENT_AUTHORIZED", "RECONCILED_RESERVATION_FOUND", "RECONCILED_RESERVATION_ABSENT", "RECONCILIATION_INCONCLUSIVE", "ESCALATE"],
  [S.RESERVATION_FAILED]: ["PAYMENT_AUTHORIZED", "VOID_SUCCEEDED", "VOID_FAILED", "ESCALATE"],
  [S.RESERVATION_CONFIRMED]: ["PAYMENT_AUTHORIZED", "CAPTURE_SUCCEEDED", "CAPTURE_FAILED", "CAPTURE_OUTCOME_UNKNOWN", "ESCALATE"],
  [S.CAPTURE_UNKNOWN]: ["PAYMENT_AUTHORIZED", "RECONCILED_CAPTURE_SUCCEEDED", "RECONCILED_STILL_AUTHORIZED", "RECONCILED_AUTHORIZATION_GONE", "RECONCILIATION_INCONCLUSIVE", "ESCALATE"],
  [S.CAPTURE_FAILED]: ["PAYMENT_AUTHORIZED", "RESERVATION_CANCELLED", "RESERVATION_CANCEL_FAILED", "ESCALATE"],
  [S.PAYMENT_CAPTURED]: ["PAYMENT_AUTHORIZED", "CAPTURE_SUCCEEDED", "OFFLINE_CHARGE_RECORDED", "OFFLINE_CHARGE_FAILED", "ESCALATE"],
  [S.RECONCILIATION_REQUIRED]: ["PAYMENT_AUTHORIZED", "RESOLVE"],
  // terminal states: only a late authorization (money held on a closed intent) is accepted
  [S.CONFIRMED]: ["PAYMENT_AUTHORIZED", "CAPTURE_SUCCEEDED"],
  [S.VALIDATION_FAILED]: ["PAYMENT_AUTHORIZED"],
  [S.EXPIRED]: ["PAYMENT_AUTHORIZED"],
  [S.PAYMENT_FAILED]: ["PAYMENT_AUTHORIZED"],
  [S.PAYMENT_EXPIRED]: ["PAYMENT_AUTHORIZED"],
  [S.AUTHORIZATION_RELEASED]: ["PAYMENT_AUTHORIZED"],
  [S.CANCELLED]: ["PAYMENT_AUTHORIZED"]
});

// States in which an authorization for THIS intent has already been accepted.
const AUTH_ACCEPTED = new Set([S.PAYMENT_AUTHORIZED, S.RESERVATION_PENDING, S.RESERVATION_UNKNOWN, S.RESERVATION_FAILED,
  S.RESERVATION_CONFIRMED, S.CAPTURE_UNKNOWN, S.CAPTURE_FAILED, S.PAYMENT_CAPTURED, S.CONFIRMED, S.AUTHORIZATION_RELEASED]);

const isInt = (v) => Number.isInteger(v);
const isNonEmpty = (v) => typeof v === "string" && v.trim() !== "" && v.length <= 200;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function deepFreeze(o) {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

/**
 * createIntent({ id, ref, listingId, from, to, guests, now }) -> frozen intent in state "created".
 * No guest PII is ever stored in the state machine.
 */
export function createIntent({ id, ref, listingId, from, to, guests, now } = {}) {
  if (!isNonEmpty(id)) throw new TypeError("createIntent: id required");
  if (!isNonEmpty(ref)) throw new TypeError("createIntent: ref required");
  if (!isInt(listingId) || listingId <= 0) throw new TypeError("createIntent: listingId");
  if (!DATE_RE.test(from || "") || !DATE_RE.test(to || "") || !(to > from)) throw new TypeError("createIntent: dates");
  if (!isInt(guests) || guests < 1) throw new TypeError("createIntent: guests");
  if (!Number.isFinite(now)) throw new TypeError("createIntent: now");
  return deepFreeze({
    machine: STATE_MACHINE_VERSION,
    id, ref, listingId, from, to, guests,
    status: S.CREATED,
    version: 0,
    createdAt: now,
    updatedAt: now,
    price: null,                 // frozen final price (amount + currency fixed here)
    quoteExpiresAt: null,
    detailsCollected: false,
    checkout: null,              // { sessionId, attempt, preparedAt }
    payment: null,               // { paymentIntentId, amountMinor, currency, livemode, authorizationCreatedAt, captureBefore, authorizationDeadline, acceptedAt, capturedMinor }
    reservation: null,           // { reservationId, confirmedAt }
    lease: null,                 // { workerId, until }
    dispatch: null,              // { at, attempt } — set BEFORE a Hostaway create may be sent
    counters: { reservationAttempts: 0, voidAttempts: 0, reconcileAttempts: 0, offlineChargeAttempts: 0, checkoutAttempts: 0 },
    offlineChargeId: null,
    reasonCode: null,            // last failure / escalation reason (codes only, no PII)
    seenEventIds: [],
    history: []                  // [{ from, to, event, at }]
  });
}

/** Deterministic idempotency keys for the future external calls (no PII, no amounts). */
export const voidKey = (intentId, paymentIntentId) => `void:${intentId}:${paymentIntentId}`;
export const captureKey = (intentId, paymentIntentId) => `cap:${intentId}:${paymentIntentId}`;

export function idempotencyKeys(intent) {
  const attempt = intent.checkout ? intent.checkout.attempt : intent.counters.checkoutAttempts + 1;
  const pi = intent.payment ? intent.payment.paymentIntentId : null;
  return Object.freeze({
    checkoutSession: `cs:${intent.id}:${attempt}`,
    capture: pi ? captureKey(intent.id, pi) : null, // per PaymentIntent
    void: pi ? voidKey(intent.id, pi) : null,       // per PaymentIntent; a stray second PI gets its own key
    offlineCharge: `och:${intent.id}`,
    offlineCharge: `och:${intent.id}`,
    hostawayReservationRef: intent.ref // stored in a Hostaway custom field for lookup-before-create
  });
}

/** True only when the stay is both reserved and paid. */
export function isConfirmedPaid(intent) {
  return intent.status === S.PAYMENT_CAPTURED || intent.status === S.CONFIRMED;
}

/** Guest-facing status. Never "confirmed" while any outcome is uncertain. */
export function publicStatus(intent) {
  switch (intent.status) {
    case S.CREATED: case S.PRICE_CONFIRMED: case S.DETAILS_COLLECTED: return "awaiting_details";
    case S.PAYMENT_PENDING: return "awaiting_payment";
    case S.PAYMENT_AUTHORIZED: case S.RESERVATION_PENDING: case S.RESERVATION_UNKNOWN:
    case S.RESERVATION_CONFIRMED: case S.CAPTURE_UNKNOWN: return "processing";
    case S.PAYMENT_CAPTURED: case S.CONFIRMED: return "confirmed";
    case S.RESERVATION_FAILED: case S.AUTHORIZATION_RELEASED: return "unavailable_not_charged";
    case S.CAPTURE_FAILED: case S.CANCELLED: return "not_completed_not_charged";
    case S.PAYMENT_FAILED: return "payment_failed";
    case S.PAYMENT_EXPIRED: case S.EXPIRED: return "expired";
    case S.VALIDATION_FAILED: return "unavailable";
    case S.RECONCILIATION_REQUIRED: return "under_review";
    default: return "under_review";
  }
}

/** Allowed event types for a state (for documentation/tests). */
export function allowedEvents(status) {
  return ROUTES[status] ? [...ROUTES[status]] : [];
}

// ---------------------------------------------------------------------------

const voidEffect = (intentId, paymentIntentId) => ({ type: "stripe.void_payment_intent", paymentIntentId, idempotencyKey: voidKey(intentId, paymentIntentId) });
const captureEffect = (intent) => ({ type: "stripe.capture_payment_intent", paymentIntentId: intent.payment.paymentIntentId,
  amountMinor: intent.price.finalTotalMinor, idempotencyKey: captureKey(intent.id, intent.payment.paymentIntentId) });
const cancelEffects = (intent, reason) => [{ type: "hostaway.cancel_reservation", reservationId: intent.reservation.reservationId, cancelledBy: "host" }, { type: "alert.owner", reason }];

const reject = (intent, error, extra = {}) => ({ ok: false, error, intent, ...extra });

function next(intent, to, eventType, now, patch = {}, effects = [], eventId = null, cfg = DEFAULT_CONFIG) {
  const seen = eventId ? [...intent.seenEventIds, eventId].slice(-cfg.maxSeenEventIds) : intent.seenEventIds;
  const history = to === intent.status && !patch.__recordSelf ? intent.history : [...intent.history, { from: intent.status, to, event: eventType, at: now }];
  const { __recordSelf, ...rest } = patch;
  const out = {
    ...intent,
    ...rest,
    counters: { ...intent.counters, ...(rest.counters || {}) },
    status: to,
    version: intent.version + 1,
    updatedAt: now,
    seenEventIds: seen,
    history
  };
  return { ok: true, duplicate: false, intent: deepFreeze(out), effects: deepFreeze(effects.map((e) => ({ ...e }))) };
}

const escalate = (intent, code, eventType, now, eventId, cfg, effects = []) =>
  next(intent, S.RECONCILIATION_REQUIRED, eventType, now, { reasonCode: code, lease: null }, [{ type: "alert.owner", reason: code }, ...effects], eventId, cfg);

function sameMoney(intent, amountMinor, currency) {
  return isInt(amountMinor) && typeof currency === "string" && intent.price &&
    amountMinor === intent.price.finalTotalMinor && currency.toUpperCase() === intent.price.currency;
}

function reservationMatches(intent, r) {
  return r && isNonEmpty(String(r.reservationId ?? "")) && r.listingId === intent.listingId && r.from === intent.from && r.to === intent.to &&
    sameMoney(intent, r.totalMinor, r.currency);
}

/** Record a verified reservation, then capture — or, if Stripe's capture deadline has passed, cancel. */
function afterReservation(intent, r, type, now, eventId, cfg, extraPatch) {
  const reservation = { reservationId: String(r.reservationId), confirmedAt: now };
  const withRes = { ...intent, reservation };
  if (now >= intent.payment.captureBefore) {
    return next(intent, S.CAPTURE_FAILED, type, now, { ...extraPatch, reservation, reasonCode: "AUTHORIZATION_EXPIRED" }, cancelEffects(withRes, "AUTHORIZATION_EXPIRED"), eventId, cfg);
  }
  return next(intent, S.RESERVATION_CONFIRMED, type, now, { ...extraPatch, reservation }, [captureEffect(intent)], eventId, cfg);
}

/**
 * transition(intent, event, ctx)
 *   event: { type, id?, ...payload }
 *   ctx:   { now (epoch ms, required), config? }
 */
export function transition(intent, event, ctx = {}) {
  if (!intent || intent.machine !== STATE_MACHINE_VERSION) throw new TypeError("transition: not an intent");
  if (!event || typeof event.type !== "string") throw new TypeError("transition: event.type required");
  if (!Number.isFinite(ctx.now)) throw new TypeError("transition: ctx.now required");
  const cfg = Object.freeze({ ...DEFAULT_CONFIG, ...(ctx.config || {}) });
  const now = ctx.now;
  const type = event.type;
  const eventId = event.id != null ? String(event.id) : null;

  if (!EVENTS.includes(type)) return reject(intent, "UNKNOWN_EVENT");

  // Exactly-once per event id (duplicate Stripe/Hostaway deliveries, replayed requests).
  if (eventId && intent.seenEventIds.includes(eventId)) return { ok: true, duplicate: true, intent, effects: Object.freeze([]) };

  const routes = ROUTES[intent.status] || [];
  if (!routes.includes(type)) return reject(intent, "ILLEGAL_TRANSITION", { from: intent.status, event: type });

  switch (type) {
    // ---------------- pricing & details ----------------
    case "PRICE_CONFIRMED": {
      const p = event.price;
      if (!p || !isInt(p.finalTotalMinor) || p.finalTotalMinor <= 0 || typeof p.currency !== "string" || !isNonEmpty(p.quoteHash)) return reject(intent, "INVALID_PRICE");
      if (p.listingId !== intent.listingId || p.from !== intent.from || p.to !== intent.to || p.guests !== intent.guests) return reject(intent, "PRICE_STAY_MISMATCH");
      if (intent.status === S.PRICE_CONFIRMED) return reject(intent, "PRICE_ALREADY_CONFIRMED");
      return next(intent, S.PRICE_CONFIRMED, type, now, { price: { ...p, lines: p.lines ? p.lines.map((l) => ({ ...l })) : [], charge: p.charge ? { ...p.charge } : null }, quoteExpiresAt: now + cfg.quoteValidityMs }, [], eventId, cfg);
    }
    case "VALIDATION_FAILED": {
      const code = isNonEmpty(event.code) ? event.code : "VALIDATION_FAILED";
      return next(intent, S.VALIDATION_FAILED, type, now, { reasonCode: code }, [], eventId, cfg);
    }
    case "DETAILS_COLLECTED": {
      if (now >= intent.quoteExpiresAt) return reject(intent, "QUOTE_EXPIRED");
      return next(intent, S.DETAILS_COLLECTED, type, now, { detailsCollected: true }, [], eventId, cfg);
    }
    case "CHECKOUT_PREPARED": {
      if (!isNonEmpty(event.sessionId)) return reject(intent, "INVALID_SESSION");
      if (intent.status === S.PAYMENT_PENDING) {
        // replayed "pay" request: the same session is acknowledged; a different one is refused.
        if (intent.checkout && intent.checkout.sessionId === event.sessionId) return { ok: true, duplicate: true, intent, effects: Object.freeze([]) };
        return reject(intent, "CHECKOUT_ALREADY_PREPARED");
      }
      if (now >= intent.quoteExpiresAt) return reject(intent, "QUOTE_EXPIRED");
      const attempt = intent.counters.checkoutAttempts + 1;
      return next(intent, S.PAYMENT_PENDING, type, now,
        { checkout: { sessionId: event.sessionId, attempt, preparedAt: now }, counters: { checkoutAttempts: attempt } }, [], eventId, cfg);
    }
    case "EXPIRE": {
      const deadline = intent.status === S.CREATED ? intent.createdAt + cfg.quoteValidityMs : intent.quoteExpiresAt;
      if (now < deadline) return reject(intent, "NOT_EXPIRED");
      return next(intent, S.EXPIRED, type, now, { reasonCode: "QUOTE_EXPIRED" }, [], eventId, cfg);
    }

    // ---------------- payment (Stripe facts, server-verified) ----------------
    case "PAYMENT_AUTHORIZED": {
      const piId = event.paymentIntentId;
      if (!isNonEmpty(piId)) return reject(intent, "INVALID_PAYMENT_EVENT");
      // Repeated/out-of-order authorization for the PaymentIntent we already accepted: no-op.
      if (intent.payment && intent.payment.paymentIntentId === piId && (AUTH_ACCEPTED.has(intent.status) || intent.status === S.RECONCILIATION_REQUIRED)) {
        return { ok: true, duplicate: true, intent, effects: Object.freeze([]) };
      }
      // Money held on an intent that cannot use it (closed, or a second PaymentIntent): void + review.
      if (intent.status !== S.PAYMENT_PENDING) {
        return escalate(intent, "AUTHORIZATION_ON_CLOSED_INTENT", type, now, eventId, cfg, [voidEffect(intent.id, piId)]);
      }
      if (event.livemode !== cfg.expectedLivemode) {
        return escalate(intent, "LIVEMODE_MISMATCH", type, now, eventId, cfg, [voidEffect(intent.id, piId)]);
      }
      if (!sameMoney(intent, event.amountMinor, event.currency)) {
        return escalate(intent, "AUTHORIZATION_AMOUNT_MISMATCH", type, now, eventId, cfg, [voidEffect(intent.id, piId)]);
      }
      if (event.sessionId != null && intent.checkout && event.sessionId !== intent.checkout.sessionId) {
        return escalate(intent, "SESSION_MISMATCH", type, now, eventId, cfg, [voidEffect(intent.id, piId)]);
      }
      // Deadlines come from Stripe's payment data; without them the authorization is not accepted.
      const createdAt = event.authorizationCreatedAt;
      const captureBefore = event.captureBefore;
      if (!Number.isFinite(createdAt) || !Number.isFinite(captureBefore)) return reject(intent, "AUTHORIZATION_DEADLINE_UNKNOWN");
      if (captureBefore <= createdAt || createdAt > now + cfg.maxClockSkewMs) {
        return escalate(intent, "AUTHORIZATION_TIMESTAMPS_INVALID", type, now, eventId, cfg, [voidEffect(intent.id, piId)]);
      }
      const authorizationDeadline = Math.min(captureBefore - cfg.captureSafetyMarginMs, createdAt + cfg.internalAuthorizationDeadlineMs);
      if (now >= authorizationDeadline) {
        return escalate(intent, "AUTHORIZATION_DEADLINE_PASSED", type, now, eventId, cfg, [voidEffect(intent.id, piId)]);
      }
      return next(intent, S.PAYMENT_AUTHORIZED, type, now,
        { payment: { paymentIntentId: piId, amountMinor: event.amountMinor, currency: intent.price.currency, livemode: event.livemode,
          authorizationCreatedAt: createdAt, captureBefore, authorizationDeadline, acceptedAt: now, capturedMinor: 0 } },
        [{ type: "orchestrator.schedule" }], eventId, cfg);
    }
    case "PAYMENT_FAILED":
      return next(intent, S.PAYMENT_FAILED, type, now, { reasonCode: isNonEmpty(event.code) ? event.code : "PAYMENT_FAILED" }, [], eventId, cfg);
    case "CHECKOUT_EXPIRED":
      return next(intent, S.PAYMENT_EXPIRED, type, now, { reasonCode: "CHECKOUT_EXPIRED" }, [], eventId, cfg);

    // ---------------- reservation ----------------
    case "RESERVATION_STARTED": {
      if (!isNonEmpty(event.workerId)) return reject(intent, "INVALID_WORKER");
      if (now >= intent.payment.authorizationDeadline) {
        return escalate(intent, "AUTHORIZATION_DEADLINE_PASSED", type, now, eventId, cfg, [voidEffect(intent.id, intent.payment.paymentIntentId)]);
      }
      const recheck = event.recheck || {};
      if (recheck.bookable !== true) {
        return next(intent, S.RESERVATION_FAILED, type, now, { reasonCode: "NO_LONGER_AVAILABLE" },
          [voidEffect(intent.id, intent.payment.paymentIntentId)], eventId, cfg);
      }
      if (recheck.priceSame !== true) {
        return next(intent, S.RESERVATION_FAILED, type, now, { reasonCode: "PRICE_CHANGED" },
          [voidEffect(intent.id, intent.payment.paymentIntentId)], eventId, cfg);
      }
      const attempts = intent.counters.reservationAttempts + 1;
      return next(intent, S.RESERVATION_PENDING, type, now,
        { lease: { workerId: event.workerId, until: now + cfg.leaseMs }, dispatch: null, counters: { reservationAttempts: attempts } },
        [{ type: "hostaway.lookup_reservation", ref: intent.ref }], eventId, cfg);
    }
    case "RESERVATION_DISPATCHED": {
      // Recorded BEFORE the network call. From here on, the create may have reached Hostaway.
      if (!intent.lease || intent.lease.workerId !== event.workerId || now > intent.lease.until) return reject(intent, "LEASE_NOT_HELD");
      if (intent.dispatch) return reject(intent, "ALREADY_DISPATCHED");
      return next(intent, S.RESERVATION_PENDING, type, now, { dispatch: { at: now, attempt: intent.counters.reservationAttempts }, __recordSelf: true },
        [{ type: "hostaway.create_reservation", ref: intent.ref, forceOverbooking: false }], eventId, cfg);
    }
    case "RESERVATION_SUCCEEDED": {
      if (!intent.dispatch) return reject(intent, "NOT_DISPATCHED");
      const r = event.reservation;
      if (!reservationMatches(intent, r)) {
        return escalate(intent, "RESERVATION_MISMATCH", type, now, eventId, cfg);
      }
      return afterReservation(intent, r, type, now, eventId, cfg, { lease: null });
    }
    case "RESERVATION_FAILED": {
      if (event.definite !== true) return reject(intent, "NOT_DEFINITE"); // ambiguous results must use RESERVATION_OUTCOME_UNKNOWN
      return next(intent, S.RESERVATION_FAILED, type, now, { reasonCode: isNonEmpty(event.code) ? event.code : "RESERVATION_REFUSED", lease: null },
        [voidEffect(intent.id, intent.payment.paymentIntentId)], eventId, cfg);
    }
    case "RESERVATION_OUTCOME_UNKNOWN": {
      if (!intent.dispatch) return reject(intent, "NOT_DISPATCHED");
      return next(intent, S.RESERVATION_UNKNOWN, type, now, { reasonCode: isNonEmpty(event.code) ? event.code : "OUTCOME_UNKNOWN", lease: null },
        [{ type: "hostaway.lookup_reservation", ref: intent.ref }], eventId, cfg);
    }
    case "RECOVER_INTERRUPTED": {
      if (intent.lease && now <= intent.lease.until) return reject(intent, "LEASE_HELD");
      if (!intent.dispatch) {
        // Crash before anything was sent: safe to retry with a fresh claim (nothing reached Hostaway).
        return next(intent, S.PAYMENT_AUTHORIZED, type, now, { lease: null, dispatch: null }, [{ type: "orchestrator.schedule" }], eventId, cfg);
      }
      // A create may have been sent: never create again; reconcile.
      return next(intent, S.RESERVATION_UNKNOWN, type, now, { reasonCode: "WORKER_INTERRUPTED", lease: null },
        [{ type: "hostaway.lookup_reservation", ref: intent.ref }], eventId, cfg);
    }
    case "RECONCILED_RESERVATION_FOUND": {
      const r = event.reservation;
      if (!reservationMatches(intent, r)) return escalate(intent, "RESERVATION_MISMATCH", type, now, eventId, cfg);
      return afterReservation(intent, r, type, now, eventId, cfg, {});
    }
    case "RECONCILED_RESERVATION_ABSENT": {
      if (event.authoritative !== true || !cfg.lookupAbsenceIsAuthoritative) {
        // R1: "not found" is not proof until lookup reliability is established (E4). Manual review.
        return escalate(intent, "RESERVATION_ABSENCE_UNPROVEN", type, now, eventId, cfg);
      }
      // Proven absent: release the money. Never re-create automatically.
      return next(intent, S.RESERVATION_FAILED, type, now, { reasonCode: "RESERVATION_NOT_CREATED" },
        [voidEffect(intent.id, intent.payment.paymentIntentId)], eventId, cfg);
    }
    case "RECONCILIATION_INCONCLUSIVE": {
      const n = intent.counters.reconcileAttempts + 1;
      if (n >= cfg.maxReconcileAttempts) return escalate({ ...intent, counters: { ...intent.counters, reconcileAttempts: n } }, "RECONCILIATION_EXHAUSTED", type, now, eventId, cfg);
      const lookup = intent.status === S.RESERVATION_UNKNOWN ? { type: "hostaway.lookup_reservation", ref: intent.ref } : { type: "stripe.retrieve_payment_intent", paymentIntentId: intent.payment.paymentIntentId };
      return next(intent, intent.status, type, now, { counters: { reconcileAttempts: n }, __recordSelf: true }, [lookup], eventId, cfg);
    }

    // ---------------- void ----------------
    case "VOID_SUCCEEDED":
      return next(intent, S.AUTHORIZATION_RELEASED, type, now, {}, [{ type: "guest.notify", template: "not_charged_authorization_may_show" }], eventId, cfg);
    case "VOID_FAILED": {
      const n = intent.counters.voidAttempts + 1;
      if (n >= cfg.maxVoidAttempts) return escalate({ ...intent, counters: { ...intent.counters, voidAttempts: n } }, "VOID_EXHAUSTED", type, now, eventId, cfg);
      return next(intent, S.RESERVATION_FAILED, type, now, { counters: { voidAttempts: n }, __recordSelf: true },
        [voidEffect(intent.id, intent.payment.paymentIntentId)], eventId, cfg);
    }

    // ---------------- capture ----------------
    case "CAPTURE_SUCCEEDED": {
      if (intent.status === S.PAYMENT_CAPTURED || intent.status === S.CONFIRMED) {
        // repeated success report for the same capture
        if (sameMoney(intent, event.amountMinor, event.currency)) return { ok: true, duplicate: true, intent, effects: Object.freeze([]) };
        return escalate(intent, "CAPTURE_MISMATCH", type, now, eventId, cfg);
      }
      if (!intent.reservation) return reject(intent, "NO_RESERVATION");
      if (!sameMoney(intent, event.amountMinor, event.currency)) return escalate(intent, "CAPTURE_MISMATCH", type, now, eventId, cfg);
      return next(intent, S.PAYMENT_CAPTURED, type, now, { payment: { ...intent.payment, capturedMinor: event.amountMinor } },
        [{ type: "hostaway.record_offline_charge", reservationId: intent.reservation.reservationId, amountMinor: event.amountMinor }], eventId, cfg);
    }
    case "CAPTURE_FAILED": {
      if (event.definite !== true) return reject(intent, "NOT_DEFINITE");
      return next(intent, S.CAPTURE_FAILED, type, now, { reasonCode: isNonEmpty(event.code) ? event.code : "CAPTURE_REFUSED" },
        cancelEffects(intent, "CAPTURE_FAILED"), eventId, cfg);
    }
    case "CAPTURE_OUTCOME_UNKNOWN":
      return next(intent, S.CAPTURE_UNKNOWN, type, now, { reasonCode: isNonEmpty(event.code) ? event.code : "CAPTURE_OUTCOME_UNKNOWN" },
        [{ type: "stripe.retrieve_payment_intent", paymentIntentId: intent.payment.paymentIntentId }], eventId, cfg);
    case "RECONCILED_CAPTURE_SUCCEEDED": {
      if (!sameMoney(intent, event.amountMinor, event.currency)) return escalate(intent, "CAPTURE_MISMATCH", type, now, eventId, cfg);
      return next(intent, S.PAYMENT_CAPTURED, type, now, { payment: { ...intent.payment, capturedMinor: event.amountMinor } },
        [{ type: "hostaway.record_offline_charge", reservationId: intent.reservation.reservationId, amountMinor: event.amountMinor }], eventId, cfg);
    }
    case "RECONCILED_STILL_AUTHORIZED":
      // Nothing was captured. Retrying with the same idempotency key is safe — but only before
      // Stripe's capture deadline; after it, the reservation must be cancelled instead.
      if (now >= intent.payment.captureBefore) {
        return next(intent, S.CAPTURE_FAILED, type, now, { reasonCode: "AUTHORIZATION_EXPIRED" }, cancelEffects(intent, "AUTHORIZATION_EXPIRED"), eventId, cfg);
      }
      return next(intent, S.RESERVATION_CONFIRMED, type, now, {},
        [captureEffect(intent)], eventId, cfg);
    case "RECONCILED_AUTHORIZATION_GONE":
      return next(intent, S.CAPTURE_FAILED, type, now, { reasonCode: "AUTHORIZATION_GONE" },
        cancelEffects(intent, "AUTHORIZATION_GONE"), eventId, cfg);

    // ---------------- after capture ----------------
    case "RESERVATION_CANCELLED":
      return next(intent, S.CANCELLED, type, now, {}, [{ type: "guest.notify", template: "not_completed_not_charged" }], eventId, cfg);
    case "RESERVATION_CANCEL_FAILED":
      return escalate(intent, "RESERVATION_CANCEL_FAILED", type, now, eventId, cfg);
    case "OFFLINE_CHARGE_RECORDED": {
      if (!isNonEmpty(String(event.chargeId ?? ""))) return reject(intent, "INVALID_CHARGE");
      return next(intent, S.CONFIRMED, type, now, { offlineChargeId: String(event.chargeId) }, [{ type: "guest.notify", template: "booking_confirmed" }], eventId, cfg);
    }
    case "OFFLINE_CHARGE_FAILED": {
      const n = intent.counters.offlineChargeAttempts + 1;
      // R3: the booking itself stays valid (reserved + paid); only the bookkeeping is escalated.
      if (n >= cfg.maxOfflineChargeAttempts) return escalate({ ...intent, counters: { ...intent.counters, offlineChargeAttempts: n } }, "OFFLINE_CHARGE_UNRECORDED", type, now, eventId, cfg);
      return next(intent, S.PAYMENT_CAPTURED, type, now, { counters: { offlineChargeAttempts: n }, __recordSelf: true },
        [{ type: "hostaway.record_offline_charge", reservationId: intent.reservation.reservationId, amountMinor: intent.payment.capturedMinor }], eventId, cfg);
    }

    // ---------------- manual ----------------
    case "ESCALATE":
      return escalate(intent, isNonEmpty(event.code) ? event.code : "MANUAL_ESCALATION", type, now, eventId, cfg);
    case "RESOLVE": {
      // Admin resolution with explicit evidence; never inferred.
      const ev = event.evidence || {};
      if (event.outcome === "confirmed") {
        if (!isNonEmpty(String(ev.reservationId ?? "")) || !sameMoney(intent, ev.capturedMinor, ev.currency)) return reject(intent, "INSUFFICIENT_EVIDENCE");
        return next(intent, S.CONFIRMED, type, now, { reservation: { reservationId: String(ev.reservationId), confirmedAt: now }, payment: { ...(intent.payment || {}), capturedMinor: ev.capturedMinor } }, [], eventId, cfg);
      }
      if (event.outcome === "released") {
        if (ev.authorizationVoided !== true || ev.noReservation !== true) return reject(intent, "INSUFFICIENT_EVIDENCE");
        return next(intent, S.AUTHORIZATION_RELEASED, type, now, {}, [], eventId, cfg);
      }
      if (event.outcome === "cancelled") {
        if (ev.reservationCancelled !== true || ev.notCaptured !== true) return reject(intent, "INSUFFICIENT_EVIDENCE");
        return next(intent, S.CANCELLED, type, now, {}, [], eventId, cfg);
      }
      return reject(intent, "INVALID_OUTCOME");
    }
    default:
      return reject(intent, "UNKNOWN_EVENT");
  }
}
