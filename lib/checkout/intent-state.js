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
  priceHoldMs: 30 * 60 * 1000,                  // price held 30 min (Checkout minimum expiry)
  leaseMs: 2 * 60 * 1000,                       // worker claim on reservation_pending
  maxAuthorizationAgeMs: 5 * 24 * 60 * 60 * 1000, // well inside the ~7-day card authorization window
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
    priceExpiresAt: null,
    detailsCollected: false,
    checkout: null,              // { sessionId, attempt, preparedAt }
    payment: null,               // { paymentIntentId, amountMinor, currency, livemode, authorizedAt, capturedMinor }
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
export function idempotencyKeys(intent) {
  const attempt = intent.checkout ? intent.checkout.attempt : intent.counters.checkoutAttempts + 1;
  return Object.freeze({
    checkoutSession: `cs:${intent.id}:${attempt}`,
    capture: `cap:${intent.id}`,
    void: `void:${intent.id}`,
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
      return next(intent, S.PRICE_CONFIRMED, type, now, { price: { ...p, lines: p.lines ? p.lines.map((l) => ({ ...l })) : [], charge: p.charge ? { ...p.charge } : null }, priceExpiresAt: now + cfg.priceHoldMs }, [], eventId, cfg);
    }
    case "VALIDATION_FAILED": {
      const code = isNonEmpty(event.code) ? event.code : "VALIDATION_FAILED";
      return next(intent, S.VALIDATION_FAILED, type, now, { reasonCode: code }, [], eventId, cfg);
    }
    case "DETAILS_COLLECTED": {
      if (now >= intent.priceExpiresAt) return reject(intent, "PRICE_EXPIRED");
      return next(intent, S.DETAILS_COLLECTED, type, now, { detailsCollected: true }, [], eventId, cfg);
    }
    case "CHECKOUT_PREPARED": {
      if (!isNonEmpty(event.sessionId)) return reject(intent, "INVALID_SESSION");
      if (intent.status === S.PAYMENT_PENDING) {
        // replayed "pay" request: the same session is acknowledged; a different one is refused.
        if (intent.checkout && intent.checkout.sessionId === event.sessionId) return { ok: true, duplicate: true, intent, effects: Object.freeze([]) };
        return reject(intent, "CHECKOUT_ALREADY_PREPARED");
      }
      if (now >= intent.priceExpiresAt) return reject(intent, "PRICE_EXPIRED");
      const attempt = intent.counters.checkoutAttempts + 1;
      return next(intent, S.PAYMENT_PENDING, type, now,
        { checkout: { sessionId: event.sessionId, attempt, preparedAt: now }, counters: { checkoutAttempts: attempt } }, [], eventId, cfg);
    }
    case "EXPIRE": {
      const deadline = intent.status === S.CREATED ? intent.createdAt + cfg.priceHoldMs : intent.priceExpiresAt;
      if (now < deadline) return reject(intent, "NOT_EXPIRED");
      return next(intent, S.EXPIRED, type, now, { reasonCode: "PRICE_HOLD_EXPIRED" }, [], eventId, cfg);
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
        return escalate(intent, "AUTHORIZATION_ON_CLOSED_INTENT", type, now, eventId, cfg, [{ type: "stripe.void_payment_intent", paymentIntentId: piId }]);
      }
      if (event.livemode !== cfg.expectedLivemode) {
        return escalate(intent, "LIVEMODE_MISMATCH", type, now, eventId, cfg, [{ type: "stripe.void_payment_intent", paymentIntentId: piId }]);
      }
      if (!sameMoney(intent, event.amountMinor, event.currency)) {
        return escalate(intent, "AUTHORIZATION_AMOUNT_MISMATCH", type, now, eventId, cfg, [{ type: "stripe.void_payment_intent", paymentIntentId: piId }]);
      }
      if (event.sessionId != null && intent.checkout && event.sessionId !== intent.checkout.sessionId) {
        return escalate(intent, "SESSION_MISMATCH", type, now, eventId, cfg, [{ type: "stripe.void_payment_intent", paymentIntentId: piId }]);
      }
      return next(intent, S.PAYMENT_AUTHORIZED, type, now,
        { payment: { paymentIntentId: piId, amountMinor: event.amountMinor, currency: intent.price.currency, livemode: event.livemode, authorizedAt: now, capturedMinor: 0 } },
        [{ type: "orchestrator.schedule" }], eventId, cfg);
    }
    case "PAYMENT_FAILED":
      return next(intent, S.PAYMENT_FAILED, type, now, { reasonCode: isNonEmpty(event.code) ? event.code : "PAYMENT_FAILED" }, [], eventId, cfg);
    case "CHECKOUT_EXPIRED":
      return next(intent, S.PAYMENT_EXPIRED, type, now, { reasonCode: "CHECKOUT_EXPIRED" }, [], eventId, cfg);

    // ---------------- reservation ----------------
    case "RESERVATION_STARTED": {
      if (!isNonEmpty(event.workerId)) return reject(intent, "INVALID_WORKER");
      if (now - intent.payment.authorizedAt > cfg.maxAuthorizationAgeMs) {
        return escalate(intent, "AUTHORIZATION_TOO_OLD", type, now, eventId, cfg, [{ type: "stripe.void_payment_intent", paymentIntentId: intent.payment.paymentIntentId }]);
      }
      const recheck = event.recheck || {};
      if (recheck.bookable !== true) {
        return next(intent, S.RESERVATION_FAILED, type, now, { reasonCode: "NO_LONGER_AVAILABLE" },
          [{ type: "stripe.void_payment_intent", paymentIntentId: intent.payment.paymentIntentId }], eventId, cfg);
      }
      if (recheck.priceSame !== true) {
        return next(intent, S.RESERVATION_FAILED, type, now, { reasonCode: "PRICE_CHANGED" },
          [{ type: "stripe.void_payment_intent", paymentIntentId: intent.payment.paymentIntentId }], eventId, cfg);
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
      return next(intent, S.RESERVATION_CONFIRMED, type, now, { reservation: { reservationId: String(r.reservationId), confirmedAt: now }, lease: null },
        [{ type: "stripe.capture_payment_intent", paymentIntentId: intent.payment.paymentIntentId, amountMinor: intent.price.finalTotalMinor }], eventId, cfg);
    }
    case "RESERVATION_FAILED": {
      if (event.definite !== true) return reject(intent, "NOT_DEFINITE"); // ambiguous results must use RESERVATION_OUTCOME_UNKNOWN
      return next(intent, S.RESERVATION_FAILED, type, now, { reasonCode: isNonEmpty(event.code) ? event.code : "RESERVATION_REFUSED", lease: null },
        [{ type: "stripe.void_payment_intent", paymentIntentId: intent.payment.paymentIntentId }], eventId, cfg);
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
      return next(intent, S.RESERVATION_CONFIRMED, type, now, { reservation: { reservationId: String(r.reservationId), confirmedAt: now } },
        [{ type: "stripe.capture_payment_intent", paymentIntentId: intent.payment.paymentIntentId, amountMinor: intent.price.finalTotalMinor }], eventId, cfg);
    }
    case "RECONCILED_RESERVATION_ABSENT": {
      if (event.authoritative !== true || !cfg.lookupAbsenceIsAuthoritative) {
        // R1: "not found" is not proof until lookup reliability is established (E4). Manual review.
        return escalate(intent, "RESERVATION_ABSENCE_UNPROVEN", type, now, eventId, cfg);
      }
      // Proven absent: release the money. Never re-create automatically.
      return next(intent, S.RESERVATION_FAILED, type, now, { reasonCode: "RESERVATION_NOT_CREATED" },
        [{ type: "stripe.void_payment_intent", paymentIntentId: intent.payment.paymentIntentId }], eventId, cfg);
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
        [{ type: "stripe.void_payment_intent", paymentIntentId: intent.payment.paymentIntentId }], eventId, cfg);
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
        [{ type: "hostaway.cancel_reservation", reservationId: intent.reservation.reservationId, cancelledBy: "host" }, { type: "alert.owner", reason: "CAPTURE_FAILED" }], eventId, cfg);
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
      // Nothing was captured; retrying the capture with the same idempotency key is safe.
      return next(intent, S.RESERVATION_CONFIRMED, type, now, {},
        [{ type: "stripe.capture_payment_intent", paymentIntentId: intent.payment.paymentIntentId, amountMinor: intent.price.finalTotalMinor }], eventId, cfg);
    case "RECONCILED_AUTHORIZATION_GONE":
      return next(intent, S.CAPTURE_FAILED, type, now, { reasonCode: "AUTHORIZATION_GONE" },
        [{ type: "hostaway.cancel_reservation", reservationId: intent.reservation.reservationId, cancelledBy: "host" }, { type: "alert.owner", reason: "AUTHORIZATION_GONE" }], eventId, cfg);

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
