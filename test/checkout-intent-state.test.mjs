// Offline tests for lib/checkout/intent-state.js — Stage E3. Run: npm test
// Deterministic: fixed clock values, no network, no credentials, no Stripe, no Hostaway, no database.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createIntent, transition, publicStatus, isConfirmedPaid, idempotencyKeys, allowedEvents, voidKey, captureKey,
  STATES as S, TERMINAL_STATES, EVENTS, DEFAULT_CONFIG
} from "../lib/checkout/intent-state.js";

const T0 = Date.UTC(2026, 9, 21, 15, 0, 0);
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const PRICE = Object.freeze({
  listingId: 603566, from: "2026-12-20", to: "2026-12-24", guests: 2, nights: 4, currency: "MXN",
  standardTotalMinor: 640000, eligibleMinor: 640000, discountMinor: 64000, finalTotalMinor: 576000,
  policyVersion: "direct-v1", rateBps: 1000, lines: [], charge: { currency: "mxn", amountMinor: 576000, quantity: 1 }, quoteHash: "a".repeat(64)
});
// Stripe-provided timestamps: authorization created at T0+4m; capture deadline 7 days later (example value, not an assumption).
const AUTH = { type: "PAYMENT_AUTHORIZED", paymentIntentId: "pi_test_1", sessionId: "cs_test_1", amountMinor: 576000, currency: "mxn", livemode: false,
  authorizationCreatedAt: T0 + 4 * MIN, captureBefore: T0 + 4 * MIN + 7 * DAY };
const RES = { reservationId: 9001, listingId: 603566, from: "2026-12-20", to: "2026-12-24", totalMinor: 576000, currency: "MXN" };

const fresh = () => createIntent({ id: "int_1", ref: "MV-7K3Q9P", listingId: 603566, from: "2026-12-20", to: "2026-12-24", guests: 2, now: T0 });

/** Apply a sequence of [event, minutesAfterT0] and assert each succeeds. */
function drive(intent, steps, config) {
  let cur = intent;
  for (const [ev, m] of steps) {
    const r = transition(cur, ev, { now: T0 + m * MIN, config });
    assert.equal(r.ok, true, `${ev.type} from ${cur.status}: ${r.error}`);
    cur = r.intent;
  }
  return cur;
}
const toPending = () => drive(fresh(), [[{ type: "PRICE_CONFIRMED", price: PRICE }, 0], [{ type: "DETAILS_COLLECTED" }, 1], [{ type: "CHECKOUT_PREPARED", sessionId: "cs_test_1" }, 2]]);
const toAuthorized = () => drive(toPending(), [[{ ...AUTH, id: "evt_auth_1" }, 5]]);
const toDispatched = () => drive(toAuthorized(), [[{ type: "RESERVATION_STARTED", workerId: "w1", recheck: { bookable: true, priceSame: true } }, 6], [{ type: "RESERVATION_DISPATCHED", workerId: "w1" }, 6]]);
const toReserved = () => drive(toDispatched(), [[{ type: "RESERVATION_SUCCEEDED", reservation: RES }, 7]]);
const effectTypes = (r) => r.effects.map((e) => e.type);

// ---------- structure ----------
test("every state has a route table; terminal states accept only late money events", () => {
  for (const s of Object.values(S)) assert.ok(Array.isArray(allowedEvents(s)), s);
  for (const s of TERMINAL_STATES) assert.ok(allowedEvents(s).every((e) => e === "PAYMENT_AUTHORIZED" || e === "CAPTURE_SUCCEEDED"), s);
  for (const s of Object.values(S)) for (const e of allowedEvents(s)) assert.ok(EVENTS.includes(e), `${s}:${e}`);
});

test("happy path: validate → authorize → reserve → capture → record → confirmed", () => {
  let i = toReserved();
  assert.equal(i.status, S.RESERVATION_CONFIRMED);
  assert.equal(isConfirmedPaid(i), false, "reserved but not yet captured is not a paid booking");
  let r = transition(i, { type: "CAPTURE_SUCCEEDED", id: "evt_cap", amountMinor: 576000, currency: "mxn" }, { now: T0 + 8 * MIN });
  assert.equal(r.intent.status, S.PAYMENT_CAPTURED);
  assert.deepEqual(effectTypes(r), ["hostaway.record_offline_charge"]);
  assert.equal(isConfirmedPaid(r.intent), true);
  r = transition(r.intent, { type: "OFFLINE_CHARGE_RECORDED", chargeId: 55 }, { now: T0 + 9 * MIN });
  assert.equal(r.intent.status, S.CONFIRMED);
  assert.equal(publicStatus(r.intent), "confirmed");
  assert.deepEqual(r.intent.history.map((h) => h.to), [
    S.PRICE_CONFIRMED, S.DETAILS_COLLECTED, S.PAYMENT_PENDING, S.PAYMENT_AUTHORIZED, S.RESERVATION_PENDING, S.RESERVATION_PENDING,
    S.RESERVATION_CONFIRMED, S.PAYMENT_CAPTURED, S.CONFIRMED
  ]);
  assert.ok(Object.isFrozen(r.intent) && Object.isFrozen(r.intent.history));
});

test("amount and currency are fixed at price confirmation", () => {
  const i = toPending();
  assert.equal(i.price.finalTotalMinor, 576000);
  assert.equal(transition(i, { type: "PRICE_CONFIRMED", price: { ...PRICE, finalTotalMinor: 1 } }, { now: T0 }).error, "ILLEGAL_TRANSITION");
  const c = transition(fresh(), { type: "PRICE_CONFIRMED", price: { ...PRICE, from: "2026-12-21" } }, { now: T0 });
  assert.equal(c.error, "PRICE_STAY_MISMATCH");
  assert.equal(transition(fresh(), { type: "PRICE_CONFIRMED", price: { ...PRICE, finalTotalMinor: 0 } }, { now: T0 }).error, "INVALID_PRICE");
});

// ---------- illegal / repeated transitions ----------
test("illegal transitions are refused and leave the intent untouched", () => {
  const i = fresh();
  for (const ev of [AUTH, { type: "RESERVATION_STARTED", workerId: "w" }, { type: "CAPTURE_SUCCEEDED", amountMinor: 1, currency: "MXN" }, { type: "CHECKOUT_PREPARED", sessionId: "cs" }]) {
    const r = transition(i, ev, { now: T0 });
    assert.equal(r.ok, false, ev.type);
    assert.equal(r.intent, i);
  }
  assert.equal(transition(i, { type: "NOPE" }, { now: T0 }).error, "UNKNOWN_EVENT");
  // no capture before a reservation exists
  assert.equal(transition(toAuthorized(), { type: "CAPTURE_SUCCEEDED", amountMinor: 576000, currency: "MXN" }, { now: T0 }).error, "ILLEGAL_TRANSITION");
  // no reservation without authorization
  assert.equal(transition(toPending(), { type: "RESERVATION_STARTED", workerId: "w", recheck: { bookable: true, priceSame: true } }, { now: T0 }).error, "ILLEGAL_TRANSITION");
  // no re-entering reservation once confirmed
  assert.equal(transition(toReserved(), { type: "RESERVATION_STARTED", workerId: "w", recheck: { bookable: true, priceSame: true } }, { now: T0 }).error, "ILLEGAL_TRANSITION");
});

test("terminal states cannot be left except by money-safety escalation", () => {
  const expired = drive(fresh(), [[{ type: "EXPIRE" }, 31]]);
  assert.equal(expired.status, S.EXPIRED);
  for (const ev of [{ type: "PRICE_CONFIRMED", price: PRICE }, { type: "DETAILS_COLLECTED" }, { type: "RESOLVE", outcome: "confirmed" }]) {
    assert.equal(transition(expired, ev, { now: T0 + 40 * MIN }).error, "ILLEGAL_TRANSITION");
  }
});

// ---------- expiry ----------
test("expired booking intent (before payment)", () => {
  const pc = drive(fresh(), [[{ type: "PRICE_CONFIRMED", price: PRICE }, 0]]);
  assert.equal(transition(pc, { type: "EXPIRE" }, { now: T0 + 29 * MIN }).error, "NOT_EXPIRED");
  assert.equal(transition(pc, { type: "DETAILS_COLLECTED" }, { now: T0 + 31 * MIN }).error, "QUOTE_EXPIRED");
  const dc = drive(pc, [[{ type: "DETAILS_COLLECTED" }, 1]]);
  assert.equal(transition(dc, { type: "CHECKOUT_PREPARED", sessionId: "cs" }, { now: T0 + 30 * MIN }).error, "QUOTE_EXPIRED");
  const e = transition(dc, { type: "EXPIRE" }, { now: T0 + 30 * MIN });
  assert.equal(e.intent.status, S.EXPIRED);
  assert.equal(publicStatus(e.intent), "expired");
});

test("payment_pending never expires on the clock alone; only Stripe's expiry evidence closes it", () => {
  const p = toPending();
  assert.equal(transition(p, { type: "EXPIRE" }, { now: T0 + 999 * MIN }).error, "ILLEGAL_TRANSITION");
  const r = transition(p, { type: "CHECKOUT_EXPIRED", id: "evt_exp" }, { now: T0 + 40 * MIN });
  assert.equal(r.intent.status, S.PAYMENT_EXPIRED);
});

test("authorization arriving on an expired/closed intent: void + review, never a booking", () => {
  const closed = drive(toPending(), [[{ type: "CHECKOUT_EXPIRED", id: "evt_exp" }, 40]]);
  const r = transition(closed, { ...AUTH, id: "evt_late" }, { now: T0 + 41 * MIN });
  assert.equal(r.intent.status, S.RECONCILIATION_REQUIRED);
  assert.equal(r.intent.reasonCode, "AUTHORIZATION_ON_CLOSED_INTENT");
  assert.deepEqual(effectTypes(r), ["alert.owner", "stripe.void_payment_intent"]);
  assert.equal(isConfirmedPaid(r.intent), false);
});

// ---------- duplicates and replays ----------
test("duplicate Stripe webhook events are acknowledged without effects", () => {
  const a = toAuthorized();
  const sameEvent = transition(a, { ...AUTH, id: "evt_auth_1" }, { now: T0 + 6 * MIN });
  assert.deepEqual([sameEvent.ok, sameEvent.duplicate, sameEvent.effects.length], [true, true, 0]);
  assert.equal(sameEvent.intent, a);
  // same PaymentIntent, different event (e.g. amount_capturable_updated), even out of order later on
  const later = toReserved();
  const dup = transition(later, { ...AUTH, id: "evt_other" }, { now: T0 + 8 * MIN });
  assert.deepEqual([dup.duplicate, dup.intent.status], [true, S.RESERVATION_CONFIRMED]);
  // duplicate capture report after capture
  const cap = drive(later, [[{ type: "CAPTURE_SUCCEEDED", id: "c1", amountMinor: 576000, currency: "MXN" }, 8]]);
  const capDup = transition(cap, { type: "CAPTURE_SUCCEEDED", id: "c2", amountMinor: 576000, currency: "MXN" }, { now: T0 + 9 * MIN });
  assert.deepEqual([capDup.duplicate, capDup.intent.version], [true, cap.version]);
});

test("replayed checkout request reuses the same session; a second session is refused", () => {
  const p = toPending();
  const replay = transition(p, { type: "CHECKOUT_PREPARED", sessionId: "cs_test_1" }, { now: T0 + 3 * MIN });
  assert.deepEqual([replay.ok, replay.duplicate], [true, true]);
  assert.equal(transition(p, { type: "CHECKOUT_PREPARED", sessionId: "cs_test_2" }, { now: T0 + 3 * MIN }).error, "CHECKOUT_ALREADY_PREPARED");
  assert.equal(idempotencyKeys(p).checkoutSession, "cs:int_1:1");
  assert.deepEqual({ ...idempotencyKeys(p) }, { checkoutSession: "cs:int_1:1", capture: null, void: null, offlineCharge: "och:int_1", hostawayReservationRef: "MV-7K3Q9P" });
  assert.deepEqual([idempotencyKeys(toAuthorized()).void, idempotencyKeys(toAuthorized()).capture], ["void:int_1:pi_test_1", "cap:int_1:pi_test_1"]);
});

test("a second, different PaymentIntent for the same intent is voided and escalated", () => {
  const r = transition(toAuthorized(), { ...AUTH, id: "evt_x", paymentIntentId: "pi_other" }, { now: T0 + 6 * MIN });
  assert.equal(r.intent.status, S.RECONCILIATION_REQUIRED);
  assert.deepEqual(r.effects.find((e) => e.type === "stripe.void_payment_intent").paymentIntentId, "pi_other");
});

test("REGRESSION: distinct payment attempts on one intent get distinct void/capture keys", () => {
  const a = toAuthorized();
  const stray = transition(a, { ...AUTH, id: "evt_stray", paymentIntentId: "pi_other" }, { now: T0 + 6 * MIN });
  const strayVoid = stray.effects.find((e) => e.type === "stripe.void_payment_intent");
  assert.equal(strayVoid.idempotencyKey, voidKey("int_1", "pi_other"));
  const failed = transition(a, { type: "RESERVATION_STARTED", workerId: "w1", recheck: { bookable: false, priceSame: true } }, { now: T0 + 6 * MIN });
  const ownVoid = failed.effects.find((e) => e.type === "stripe.void_payment_intent");
  assert.equal(ownVoid.idempotencyKey, voidKey("int_1", "pi_test_1"));
  assert.notEqual(strayVoid.idempotencyKey, ownVoid.idempotencyKey);
  const cap = transition(toDispatched(), { type: "RESERVATION_SUCCEEDED", reservation: RES }, { now: T0 + 7 * MIN });
  assert.equal(cap.effects[0].idempotencyKey, captureKey("int_1", "pi_test_1"));
  // every Stripe-side effect carries an idempotency key
  for (const r of [stray, failed, cap]) for (const e of r.effects) if (e.type.startsWith("stripe.") && e.type !== "stripe.retrieve_payment_intent") assert.ok(e.idempotencyKey, e.type);
});

// ---------- authorization verification ----------
test("authorization with wrong amount, currency, mode or session is never accepted", () => {
  const cases = [
    [{ amountMinor: 575999 }, "AUTHORIZATION_AMOUNT_MISMATCH"],
    [{ currency: "usd" }, "AUTHORIZATION_AMOUNT_MISMATCH"],
    [{ livemode: true }, "LIVEMODE_MISMATCH"],
    [{ sessionId: "cs_wrong" }, "SESSION_MISMATCH"]
  ];
  for (const [over, code] of cases) {
    const r = transition(toPending(), { ...AUTH, ...over }, { now: T0 + 5 * MIN });
    assert.equal(r.intent.status, S.RECONCILIATION_REQUIRED, code);
    assert.equal(r.intent.reasonCode, code);
    assert.ok(effectTypes(r).includes("stripe.void_payment_intent"));
  }
});

// ---------- authorization deadlines (from Stripe data; 5 days is only an internal cap) ----------
test("authorization without Stripe's timestamps is not accepted (fail closed, nothing changes)", () => {
  const p = toPending();
  for (const drop of ["authorizationCreatedAt", "captureBefore"]) {
    const ev = { ...AUTH }; delete ev[drop];
    const r = transition(p, ev, { now: T0 + 5 * MIN });
    assert.deepEqual([r.ok, r.error, r.intent], [false, "AUTHORIZATION_DEADLINE_UNKNOWN", p], drop);
  }
});

test("inconsistent Stripe timestamps: void + review", () => {
  const before = transition(toPending(), { ...AUTH, captureBefore: AUTH.authorizationCreatedAt }, { now: T0 + 5 * MIN });
  assert.equal(before.intent.reasonCode, "AUTHORIZATION_TIMESTAMPS_INVALID");
  const future = transition(toPending(), { ...AUTH, authorizationCreatedAt: T0 + 60 * MIN }, { now: T0 + 5 * MIN });
  assert.equal(future.intent.reasonCode, "AUTHORIZATION_TIMESTAMPS_INVALID");
  assert.ok(effectTypes(future).includes("stripe.void_payment_intent"));
});

test("deadline = earliest of (Stripe capture deadline − safety margin) and (Stripe authorization time + internal cap)", () => {
  // Stripe allows 7 days -> the internal 5-day cap from Stripe's authorization time wins
  const long = toAuthorized();
  assert.equal(long.payment.authorizationDeadline, AUTH.authorizationCreatedAt + DEFAULT_CONFIG.internalAuthorizationDeadlineMs);
  // Stripe allows only 2 days -> Stripe's deadline minus the margin wins
  const shortAuth = { ...AUTH, id: "evt_s", captureBefore: AUTH.authorizationCreatedAt + 2 * DAY };
  const short = drive(toPending(), [[shortAuth, 5]]);
  assert.equal(short.payment.authorizationDeadline, shortAuth.captureBefore - DEFAULT_CONFIG.captureSafetyMarginMs);
  const startAt = (i, t) => transition(i, { type: "RESERVATION_STARTED", workerId: "w1", recheck: { bookable: true, priceSame: true } }, { now: t });
  assert.equal(startAt(short, AUTH.authorizationCreatedAt + 1 * DAY).intent.status, S.RESERVATION_PENDING);
  const late = startAt(short, short.payment.authorizationDeadline);
  assert.deepEqual([late.intent.status, late.intent.reasonCode], [S.RECONCILIATION_REQUIRED, "AUTHORIZATION_DEADLINE_PASSED"]);
  assert.ok(effectTypes(late).includes("stripe.void_payment_intent"));
  // the internal cap applies even when Stripe would allow longer
  assert.equal(startAt(long, long.payment.authorizationDeadline).intent.reasonCode, "AUTHORIZATION_DEADLINE_PASSED");
  // an authorization that arrives already past its deadline is not accepted
  const stale = transition(toPending(), { ...AUTH, captureBefore: T0 + 5 * MIN + DEFAULT_CONFIG.captureSafetyMarginMs }, { now: T0 + 5 * MIN });
  assert.equal(stale.intent.reasonCode, "AUTHORIZATION_DEADLINE_PASSED");
});

test("reservation verified after Stripe's capture deadline: cancel, never capture", () => {
  const r = transition(toDispatched(), { type: "RESERVATION_SUCCEEDED", reservation: RES }, { now: AUTH.captureBefore });
  assert.deepEqual([r.intent.status, r.intent.reasonCode], [S.CAPTURE_FAILED, "AUTHORIZATION_EXPIRED"]);
  // E3.2: both recovery legs — cancel the reservation AND void the authorization (lapse is never assumed)
  assert.deepEqual(effectTypes(r), ["hostaway.cancel_reservation", "stripe.void_payment_intent", "alert.owner"]);
  assert.equal(r.effects[0].reservationId, "9001");
  const u = drive(toReserved(), [[{ type: "CAPTURE_OUTCOME_UNKNOWN" }, 8]]);
  const still = transition(u, { type: "RECONCILED_STILL_AUTHORIZED" }, { now: AUTH.captureBefore });
  assert.deepEqual([still.intent.status, still.intent.reasonCode], [S.CAPTURE_FAILED, "AUTHORIZATION_EXPIRED"]);
});

// ---------- re-validation at reservation time ----------
test("listing no longer available at reservation time: void, not charged", () => {
  const r = transition(toAuthorized(), { type: "RESERVATION_STARTED", workerId: "w1", recheck: { bookable: false, priceSame: true } }, { now: T0 + 6 * MIN });
  assert.equal(r.intent.status, S.RESERVATION_FAILED);
  assert.equal(r.intent.reasonCode, "NO_LONGER_AVAILABLE");
  assert.deepEqual(effectTypes(r), ["stripe.void_payment_intent"]);
  assert.equal(publicStatus(r.intent), "unavailable_not_charged");
  const v = transition(r.intent, { type: "VOID_SUCCEEDED" }, { now: T0 + 7 * MIN });
  assert.equal(v.intent.status, S.AUTHORIZATION_RELEASED);
  assert.equal(v.effects[0].template, "not_charged_authorization_may_show"); // R4
});

test("price changed between quote and reservation: void, guest re-confirms on a new intent", () => {
  const r = transition(toAuthorized(), { type: "RESERVATION_STARTED", workerId: "w1", recheck: { bookable: true, priceSame: false } }, { now: T0 + 6 * MIN });
  assert.deepEqual([r.intent.status, r.intent.reasonCode], [S.RESERVATION_FAILED, "PRICE_CHANGED"]);
  // a missing recheck is treated as a failure, never as a pass
  const m = transition(toAuthorized(), { type: "RESERVATION_STARTED", workerId: "w1" }, { now: T0 + 6 * MIN });
  assert.equal(m.intent.status, S.RESERVATION_FAILED);
});

// ---------- Hostaway outcomes ----------
test("Stripe authorized but Hostaway creation definitely fails: void, no capture", () => {
  const r = transition(toDispatched(), { type: "RESERVATION_FAILED", definite: true, code: "OVERBOOKING_REFUSED" }, { now: T0 + 7 * MIN });
  assert.equal(r.intent.status, S.RESERVATION_FAILED);
  assert.deepEqual(effectTypes(r), ["stripe.void_payment_intent"]);
  assert.ok(!effectTypes(r).includes("stripe.capture_payment_intent"));
  // an ambiguous failure may not be reported as definite
  assert.equal(transition(toDispatched(), { type: "RESERVATION_FAILED", code: "500" }, { now: T0 + 7 * MIN }).error, "NOT_DEFINITE");
});

test("Hostaway timeout / unknown result: reconcile only — never a second create", () => {
  const u = transition(toDispatched(), { type: "RESERVATION_OUTCOME_UNKNOWN", code: "TIMEOUT" }, { now: T0 + 7 * MIN });
  assert.equal(u.intent.status, S.RESERVATION_UNKNOWN);
  assert.deepEqual(effectTypes(u), ["hostaway.lookup_reservation"]);
  assert.equal(publicStatus(u.intent), "processing");
  // creation can't be restarted or re-dispatched from here
  for (const ev of [{ type: "RESERVATION_STARTED", workerId: "w2", recheck: { bookable: true, priceSame: true } }, { type: "RESERVATION_DISPATCHED", workerId: "w2" }]) {
    assert.equal(transition(u.intent, ev, { now: T0 + 8 * MIN }).error, "ILLEGAL_TRANSITION");
  }
  // lookup finds our reservation -> adopt it and capture
  const found = transition(u.intent, { type: "RECONCILED_RESERVATION_FOUND", reservation: RES }, { now: T0 + 9 * MIN });
  assert.equal(found.intent.status, S.RESERVATION_CONFIRMED);
  assert.deepEqual(effectTypes(found), ["stripe.capture_payment_intent"]);
  // an unknown result must have been dispatched first
  const notSent = drive(toAuthorized(), [[{ type: "RESERVATION_STARTED", workerId: "w1", recheck: { bookable: true, priceSame: true } }, 6]]);
  assert.equal(transition(notSent, { type: "RESERVATION_OUTCOME_UNKNOWN" }, { now: T0 + 7 * MIN }).error, "NOT_DISPATCHED");
});

test("lookup says 'absent': not trusted until proven (R1) — manual review, no auto-void, no re-create", () => {
  const u = drive(toDispatched(), [[{ type: "RESERVATION_OUTCOME_UNKNOWN", code: "TIMEOUT" }, 7]]);
  const r = transition(u, { type: "RECONCILED_RESERVATION_ABSENT", authoritative: true }, { now: T0 + 8 * MIN });
  assert.deepEqual([r.intent.status, r.intent.reasonCode], [S.RECONCILIATION_REQUIRED, "RESERVATION_ABSENCE_UNPROVEN"]);
  assert.ok(!effectTypes(r).some((t) => t.startsWith("hostaway.create") || t.startsWith("stripe.")));
  // once E4 proves lookups are authoritative (config), proven absence voids — still never re-creates
  const proven = transition(u, { type: "RECONCILED_RESERVATION_ABSENT", authoritative: true }, { now: T0 + 8 * MIN, config: { lookupAbsenceIsAuthoritative: true } });
  assert.equal(proven.intent.status, S.RESERVATION_FAILED);
  assert.deepEqual(effectTypes(proven), ["stripe.void_payment_intent"]);
  // a non-authoritative "absent" is never enough, whatever the config
  const weak = transition(u, { type: "RECONCILED_RESERVATION_ABSENT" }, { now: T0 + 8 * MIN, config: { lookupAbsenceIsAuthoritative: true } });
  assert.equal(weak.intent.status, S.RECONCILIATION_REQUIRED);
});

test("inconclusive reconciliation retries a bounded number of times, then escalates", () => {
  let cur = drive(toDispatched(), [[{ type: "RESERVATION_OUTCOME_UNKNOWN" }, 7]]);
  for (let n = 1; n < DEFAULT_CONFIG.maxReconcileAttempts; n++) {
    const r = transition(cur, { type: "RECONCILIATION_INCONCLUSIVE" }, { now: T0 + (7 + n) * MIN });
    assert.equal(r.intent.status, S.RESERVATION_UNKNOWN);
    assert.deepEqual(effectTypes(r), ["hostaway.lookup_reservation"]);
    cur = r.intent;
  }
  const last = transition(cur, { type: "RECONCILIATION_INCONCLUSIVE" }, { now: T0 + 20 * MIN });
  assert.deepEqual([last.intent.status, last.intent.reasonCode], [S.RECONCILIATION_REQUIRED, "RECONCILIATION_EXHAUSTED"]);
});

test("reservation that doesn't match the intent (dates/listing/total) is never adopted", () => {
  for (const bad of [{ totalMinor: 640000 }, { to: "2026-12-25" }, { listingId: 603564 }, { currency: "USD" }, { reservationId: "" }]) {
    const r = transition(toDispatched(), { type: "RESERVATION_SUCCEEDED", reservation: { ...RES, ...bad } }, { now: T0 + 7 * MIN });
    assert.deepEqual([r.intent.status, r.intent.reasonCode], [S.RECONCILIATION_REQUIRED, "RESERVATION_MISMATCH"], JSON.stringify(bad));
    assert.ok(!effectTypes(r).includes("stripe.capture_payment_intent"));
  }
});

// ---------- worker interruption ----------
test("retry after worker interruption BEFORE dispatch: safe to retry with a fresh claim", () => {
  const started = drive(toAuthorized(), [[{ type: "RESERVATION_STARTED", workerId: "w1", recheck: { bookable: true, priceSame: true } }, 6]]);
  assert.equal(transition(started, { type: "RECOVER_INTERRUPTED" }, { now: T0 + 7 * MIN }).error, "LEASE_HELD");
  const r = transition(started, { type: "RECOVER_INTERRUPTED" }, { now: T0 + 9 * MIN }); // lease (2 min) expired
  assert.equal(r.intent.status, S.PAYMENT_AUTHORIZED);
  const again = transition(r.intent, { type: "RESERVATION_STARTED", workerId: "w2", recheck: { bookable: true, priceSame: true } }, { now: T0 + 10 * MIN });
  assert.equal(again.intent.status, S.RESERVATION_PENDING);
  assert.equal(again.intent.counters.reservationAttempts, 2);
});

test("retry after worker interruption AFTER dispatch: goes to reconciliation, never re-creates", () => {
  const d = toDispatched();
  assert.equal(transition(d, { type: "RECOVER_INTERRUPTED" }, { now: T0 + 7 * MIN }).error, "LEASE_HELD");
  const r = transition(d, { type: "RECOVER_INTERRUPTED" }, { now: T0 + 9 * MIN });
  assert.deepEqual([r.intent.status, r.intent.reasonCode], [S.RESERVATION_UNKNOWN, "WORKER_INTERRUPTED"]);
  assert.deepEqual(effectTypes(r), ["hostaway.lookup_reservation"]);
});

test("only the lease holder can dispatch, and only once", () => {
  const started = drive(toAuthorized(), [[{ type: "RESERVATION_STARTED", workerId: "w1", recheck: { bookable: true, priceSame: true } }, 6]]);
  assert.equal(transition(started, { type: "RESERVATION_DISPATCHED", workerId: "w2" }, { now: T0 + 6 * MIN }).error, "LEASE_NOT_HELD");
  assert.equal(transition(started, { type: "RESERVATION_DISPATCHED", workerId: "w1" }, { now: T0 + 9 * MIN }).error, "LEASE_NOT_HELD"); // expired
  const d = toDispatched();
  assert.equal(transition(d, { type: "RESERVATION_DISPATCHED", workerId: "w1" }, { now: T0 + 6 * MIN }).error, "ALREADY_DISPATCHED");
  assert.equal(transition(started, { type: "RESERVATION_SUCCEEDED", reservation: RES }, { now: T0 + 7 * MIN }).error, "NOT_DISPATCHED");
  const disp = transition(started, { type: "RESERVATION_DISPATCHED", workerId: "w1" }, { now: T0 + 6 * MIN });
  assert.deepEqual(disp.effects.map((e) => [e.type, e.forceOverbooking]), [["hostaway.create_reservation", false]]);
});

// ---------- capture outcomes ----------
test("Hostaway reservation succeeds but Stripe capture fails: cancel reservation, not a paid booking", () => {
  const r = transition(toReserved(), { type: "CAPTURE_FAILED", definite: true, code: "card_declined" }, { now: T0 + 8 * MIN });
  assert.equal(r.intent.status, S.CAPTURE_FAILED);
  // E3.2: both recovery legs are explicit
  assert.deepEqual(effectTypes(r), ["hostaway.cancel_reservation", "stripe.void_payment_intent", "alert.owner"]);
  assert.equal(isConfirmedPaid(r.intent), false);
  const c = transition(r.intent, { type: "RESERVATION_CANCELLED" }, { now: T0 + 9 * MIN });
  assert.equal(c.intent.status, S.CAPTURE_FAILED, "cancellation alone is not enough: the authorization must be settled too");
  const c2 = transition(c.intent, { type: "VOID_SUCCEEDED" }, { now: T0 + 9 * MIN });
  assert.equal(c2.intent.status, S.CANCELLED);
  const cf = transition(r.intent, { type: "RESERVATION_CANCEL_FAILED" }, { now: T0 + 9 * MIN });
  assert.equal(cf.intent.status, S.RECONCILIATION_REQUIRED);
});

test("reservation succeeded but capture outcome unknown: reconciliation state, never 'confirmed'", () => {
  const u = transition(toReserved(), { type: "CAPTURE_OUTCOME_UNKNOWN", code: "TIMEOUT" }, { now: T0 + 8 * MIN });
  assert.equal(u.intent.status, S.CAPTURE_UNKNOWN);
  assert.equal(isConfirmedPaid(u.intent), false);
  assert.equal(publicStatus(u.intent), "processing");
  assert.deepEqual(effectTypes(u), ["stripe.retrieve_payment_intent"]);
  // Stripe says captured -> paid
  const ok = transition(u.intent, { type: "RECONCILED_CAPTURE_SUCCEEDED", amountMinor: 576000, currency: "MXN" }, { now: T0 + 9 * MIN });
  assert.equal(ok.intent.status, S.PAYMENT_CAPTURED);
  // still only authorized -> retry capture (E3.2: attempt-scoped key, only after this authoritative read)
  const retry = transition(u.intent, { type: "RECONCILED_STILL_AUTHORIZED" }, { now: T0 + 9 * MIN });
  assert.deepEqual([retry.intent.status, effectTypes(retry)], [S.RESERVATION_CONFIRMED, ["stripe.capture_payment_intent"]]);
  // authorization gone -> cancel reservation
  const gone = transition(u.intent, { type: "RECONCILED_AUTHORIZATION_GONE" }, { now: T0 + 9 * MIN });
  assert.equal(gone.intent.status, S.CAPTURE_FAILED);
  // captured a different amount -> review
  const wrong = transition(u.intent, { type: "RECONCILED_CAPTURE_SUCCEEDED", amountMinor: 1, currency: "MXN" }, { now: T0 + 9 * MIN });
  assert.equal(wrong.intent.reasonCode, "CAPTURE_MISMATCH");
});

test("captured amount different from the intent is escalated, never accepted", () => {
  const r = transition(toReserved(), { type: "CAPTURE_SUCCEEDED", amountMinor: 640000, currency: "MXN" }, { now: T0 + 8 * MIN });
  assert.deepEqual([r.intent.status, r.intent.reasonCode], [S.RECONCILIATION_REQUIRED, "CAPTURE_MISMATCH"]);
});

// ---------- void / offline charge retries ----------
test("void failures retry, then escalate", () => {
  let cur = drive(toAuthorized(), [[{ type: "RESERVATION_STARTED", workerId: "w1", recheck: { bookable: false, priceSame: true } }, 6]]);
  for (let n = 1; n < DEFAULT_CONFIG.maxVoidAttempts; n++) cur = drive(cur, [[{ type: "VOID_FAILED" }, 6 + n]]);
  assert.equal(cur.status, S.RESERVATION_FAILED);
  const r = transition(cur, { type: "VOID_FAILED" }, { now: T0 + 20 * MIN });
  assert.equal(r.intent.reasonCode, "VOID_EXHAUSTED");
});

test("captured but offline charge not recorded (R3): booking stays paid, bookkeeping escalates after retries", () => {
  let cur = drive(toReserved(), [[{ type: "CAPTURE_SUCCEEDED", amountMinor: 576000, currency: "MXN" }, 8]]);
  for (let n = 1; n < DEFAULT_CONFIG.maxOfflineChargeAttempts; n++) {
    const r = transition(cur, { type: "OFFLINE_CHARGE_FAILED" }, { now: T0 + (8 + n) * MIN });
    assert.deepEqual([r.intent.status, effectTypes(r)], [S.PAYMENT_CAPTURED, ["hostaway.record_offline_charge"]]);
    cur = r.intent;
  }
  assert.equal(publicStatus(cur), "confirmed");
  const last = transition(cur, { type: "OFFLINE_CHARGE_FAILED" }, { now: T0 + 30 * MIN });
  assert.equal(last.intent.reasonCode, "OFFLINE_CHARGE_UNRECORDED");
});

// ---------- manual resolution ----------
test("manual resolution requires explicit evidence", () => {
  const rr = transition(toReserved(), { type: "ESCALATE", code: "OPS" }, { now: T0 + 8 * MIN }).intent;
  assert.equal(rr.status, S.RECONCILIATION_REQUIRED);
  assert.equal(transition(rr, { type: "RESOLVE", outcome: "confirmed", evidence: { reservationId: 9001 } }, { now: T0 }).error, "INSUFFICIENT_EVIDENCE");
  assert.equal(transition(rr, { type: "RESOLVE", outcome: "released", evidence: { authorizationVoided: true } }, { now: T0 }).error, "INSUFFICIENT_EVIDENCE");
  assert.equal(transition(rr, { type: "RESOLVE", outcome: "whatever" }, { now: T0 }).error, "INVALID_OUTCOME");
  const ok = transition(rr, { type: "RESOLVE", outcome: "confirmed", evidence: { reservationId: 9001, capturedMinor: 576000, currency: "MXN" } }, { now: T0 + 60 * MIN });
  assert.equal(ok.intent.status, S.CONFIRMED);
});

// ---------- purity / determinism ----------
test("pure and deterministic: same inputs give identical outputs; inputs never mutated", () => {
  const a = toReserved();
  const before = JSON.stringify(a);
  const r1 = transition(a, { type: "CAPTURE_SUCCEEDED", amountMinor: 576000, currency: "MXN" }, { now: T0 + 8 * MIN });
  const r2 = transition(a, { type: "CAPTURE_SUCCEEDED", amountMinor: 576000, currency: "MXN" }, { now: T0 + 8 * MIN });
  assert.equal(JSON.stringify(r1), JSON.stringify(r2));
  assert.equal(JSON.stringify(a), before);
  assert.throws(() => transition(a, { type: "CAPTURE_SUCCEEDED" }, {}), /ctx.now/);
});

test("no guest PII is held in the intent", () => {
  const s = JSON.stringify(toReserved());
  for (const k of ["email", "firstName", "lastName", "phone", "guestName"]) assert.ok(!s.includes(k), k);
});
