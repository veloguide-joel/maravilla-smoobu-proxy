// db/lib/codec.js — Stage E2B. Pure mapping between a booking.intents row and an E3 intent object.
// E3 history and seenEventIds are NOT columns: they live in intent_transitions / intent_applied_events.
import { STATE_MACHINE_VERSION } from "../../lib/checkout/intent-state.js";

const ms = (d) => (d == null ? null : new Date(d).getTime());
const ts = (n) => (n == null ? null : new Date(n));
/** pg returns bigint as string; convert, refusing anything that is not a safe integer. */
export function num(v) {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isSafeInteger(n)) throw new RangeError(`unsafe integer from database: ${v}`);
  return n;
}

/** Columns selected for an intent (dates as text so no timezone conversion can shift them). */
export const INTENT_SELECT = "SELECT *, from_date::text AS from_date_s, to_date::text AS to_date_s FROM booking.intents";

export function rowToIntent(row) {
  if (row.machine_version !== STATE_MACHINE_VERSION) throw new TypeError(`unsupported machine version ${row.machine_version}`);
  const pi = row.stripe_payment_intent_id;
  const captured = num(row.captured_minor);
  let payment = null;
  if (pi) {
    payment = {
      paymentIntentId: pi,
      amountMinor: num(row.authorized_minor),
      currency: row.currency,
      livemode: row.payment_livemode,
      authorizationCreatedAt: ms(row.authorization_created_at),
      captureBefore: ms(row.capture_before),
      authorizationDeadline: ms(row.authorization_deadline),
      acceptedAt: ms(row.authorization_accepted_at),
      capturedMinor: captured
    };
  } else if (captured > 0) {
    payment = { capturedMinor: captured }; // E3 RESOLVE(confirmed) on an intent that never accepted a PaymentIntent
  }
  return {
    machine: row.machine_version,
    id: row.id,
    ref: row.ref,
    listingId: row.listing_id,
    from: row.from_date_s,
    to: row.to_date_s,
    guests: row.guests,
    status: row.state,
    version: row.version,
    createdAt: ms(row.created_at),
    updatedAt: ms(row.updated_at),
    price: row.price_snapshot ? structuredClone(row.price_snapshot) : null,
    quoteExpiresAt: ms(row.quote_expires_at),
    detailsCollected: row.details_collected,
    checkout: row.checkout_session_id
      ? { sessionId: row.checkout_session_id, attempt: row.checkout_attempt, preparedAt: ms(row.checkout_prepared_at) } : null,
    payment,
    reservation: row.hostaway_reservation_id
      ? { reservationId: row.hostaway_reservation_id, confirmedAt: ms(row.reservation_confirmed_at) } : null,
    lease: row.lease_worker_id ? { workerId: row.lease_worker_id, until: ms(row.lease_until) } : null,
    dispatch: row.dispatch_at ? { at: ms(row.dispatch_at), attempt: row.dispatch_attempt } : null,
    counters: {
      reservationAttempts: row.reservation_attempts,
      voidAttempts: row.void_attempts,
      reconcileAttempts: row.reconcile_attempts,
      offlineChargeAttempts: row.offline_charge_attempts,
      checkoutAttempts: row.checkout_attempts
    },
    offlineChargeId: row.offline_charge_id,
    reasonCode: row.reason_code,
    seenEventIds: [],
    history: []
  };
}

/** Columns written on every compare-and-swap update (identity columns are never rewritten). */
export const MUTABLE_COLUMNS = Object.freeze([
  "state", "version", "price_snapshot", "currency", "standard_total_minor", "eligible_minor", "discount_minor",
  "final_total_minor", "policy_version", "rate_bps", "quote_hash", "quote_expires_at", "details_collected",
  "checkout_session_id", "checkout_attempt", "checkout_prepared_at", "stripe_payment_intent_id", "payment_livemode",
  "authorized_minor", "authorization_created_at", "capture_before", "authorization_deadline", "authorization_accepted_at",
  "captured_minor", "hostaway_reservation_id", "reservation_confirmed_at", "lease_worker_id", "lease_until",
  "dispatch_at", "dispatch_attempt", "offline_charge_id", "checkout_attempts", "reservation_attempts", "void_attempts",
  "reconcile_attempts", "offline_charge_attempts", "reason_code", "updated_at"
]);

export function intentToRow(intent) {
  const p = intent.price;
  const pay = intent.payment;
  const c = intent.counters;
  return {
    id: intent.id,
    ref: intent.ref,
    machine_version: intent.machine,
    listing_id: intent.listingId,
    from_date: intent.from,
    to_date: intent.to,
    guests: intent.guests,
    created_at: ts(intent.createdAt),
    state: intent.status,
    version: intent.version,
    price_snapshot: p ? JSON.parse(JSON.stringify(p)) : null,
    currency: p ? p.currency : null,
    standard_total_minor: p ? p.standardTotalMinor : null,
    eligible_minor: p ? p.eligibleMinor : null,
    discount_minor: p ? p.discountMinor : null,
    final_total_minor: p ? p.finalTotalMinor : null,
    policy_version: p ? p.policyVersion : null,
    rate_bps: p && Number.isInteger(p.rateBps) ? p.rateBps : null,
    quote_hash: p ? p.quoteHash : null,
    quote_expires_at: ts(intent.quoteExpiresAt),
    details_collected: intent.detailsCollected === true,
    checkout_session_id: intent.checkout ? intent.checkout.sessionId : null,
    checkout_attempt: intent.checkout ? intent.checkout.attempt : null,
    checkout_prepared_at: intent.checkout ? ts(intent.checkout.preparedAt) : null,
    stripe_payment_intent_id: pay && pay.paymentIntentId ? pay.paymentIntentId : null,
    payment_livemode: pay && pay.paymentIntentId ? pay.livemode : null,
    authorized_minor: pay && pay.paymentIntentId ? pay.amountMinor : null,
    authorization_created_at: pay && pay.paymentIntentId ? ts(pay.authorizationCreatedAt) : null,
    capture_before: pay && pay.paymentIntentId ? ts(pay.captureBefore) : null,
    authorization_deadline: pay && pay.paymentIntentId ? ts(pay.authorizationDeadline) : null,
    authorization_accepted_at: pay && pay.paymentIntentId ? ts(pay.acceptedAt) : null,
    captured_minor: pay && Number.isInteger(pay.capturedMinor) ? pay.capturedMinor : 0,
    hostaway_reservation_id: intent.reservation ? String(intent.reservation.reservationId) : null,
    reservation_confirmed_at: intent.reservation ? ts(intent.reservation.confirmedAt) : null,
    lease_worker_id: intent.lease ? intent.lease.workerId : null,
    lease_until: intent.lease ? ts(intent.lease.until) : null,
    dispatch_at: intent.dispatch ? ts(intent.dispatch.at) : null,
    dispatch_attempt: intent.dispatch ? intent.dispatch.attempt : null,
    offline_charge_id: intent.offlineChargeId == null ? null : String(intent.offlineChargeId),
    checkout_attempts: c.checkoutAttempts,
    reservation_attempts: c.reservationAttempts,
    void_attempts: c.voidAttempts,
    reconcile_attempts: c.reconcileAttempts,
    offline_charge_attempts: c.offlineChargeAttempts,
    reason_code: intent.reasonCode,
    updated_at: ts(intent.updatedAt)
  };
}
