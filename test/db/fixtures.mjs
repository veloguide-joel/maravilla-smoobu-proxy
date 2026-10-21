// test/db/fixtures.mjs — Stage E2B. Deterministic fixtures and step helpers for the booking DB tests.
// Fixed clock values; provider results are MOCKED constants (no Stripe, no Hostaway, no network).
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  createIntentRecord, applyEvent, collectGuestDetails, beginPayStep, recordCheckoutSession, loadIntent, recordHostawayCreateResult
} from "../../db/lib/repo.js";
import { claimNextOperation, completeOperation, requestRead, recordProviderEvidence } from "../../db/lib/operations.js";
import { adminRecordEvidence } from "../../db/lib/admin.js";

export const T0 = Date.UTC(2026, 9, 21, 15, 0, 0);
export const MIN = 60 * 1000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
export const at = (m) => T0 + m * MIN;

export const GUEST = Object.freeze({ firstName: "Zanabria", lastName: "Quintessa", email: "zq.fixture.guest@example.test", phone: "+52 322 555 0199" });

let refCounter = 0;
export const nextRef = () => `MV-T${(++refCounter).toString(36).toUpperCase().padStart(5, "0")}`;
export const tokenHash = () => createHash("sha256").update(randomUUID()).digest();

/** A price object shaped like lib/checkout/final-price.js output (values as in the E3 tests). */
export function priceFor({ listingId = 603566, from = "2026-12-20", to = "2026-12-24", guests = 2 } = {}) {
  return {
    version: "final-price-v1", quoteBasis: "hostaway.priceDetails.v2",
    listingId, from, to, guests, nights: 4, currency: "MXN",
    standardTotalMinor: 640000, eligibleMinor: 640000, discountMinor: 64000, finalTotalMinor: 576000,
    policyVersion: "direct-v1", rateBps: 1000,
    lines: [{ kind: "accommodation", code: "baseRate", label: "Accommodation", amountMinor: 640000 },
            { kind: "direct_discount", code: "direct-v1", label: "Book Direct discount (10%)", amountMinor: -64000 }],
    charge: { currency: "mxn", amountMinor: 576000, quantity: 1, description: `Stay · ${from} to ${to} · 4 nights · 2 guests` },
    quoteHash: "b".repeat(64)
  };
}

/** Mocked Stripe authorization facts (example values, not assumptions about Stripe). */
export const authEvent = (sessionId, piId, minutes = 5, extra = {}) => ({
  type: "PAYMENT_AUTHORIZED", id: `evt_auth_${piId}`, paymentIntentId: piId, sessionId, amountMinor: 576000, currency: "mxn",
  livemode: false, authorizationCreatedAt: at(minutes - 1), captureBefore: at(minutes - 1) + 7 * DAY, ...extra
});
let resCounter = 20000;
export const nextReservationId = () => ++resCounter;
export const reservationFor = (stay = {}, reservationId = 9001) => ({
  reservationId, listingId: stay.listingId ?? 603566, from: stay.from ?? "2026-12-20", to: stay.to ?? "2026-12-24", totalMinor: 576000, currency: "MXN"
});

export function ok(r, msg) {
  assert.equal(r.ok, true, `${msg || "expected ok"}: ${r.error || ""}`);
  return r;
}

// ---- step helpers (each a real persisted transition) ----
export async function newIntent(pool, stay = {}, shift = 0) {
  const s = { listingId: 603566, from: "2026-12-20", to: "2026-12-24", guests: 2, ...stay };
  const intent = await createIntentRecord(pool, { ref: nextRef(), accessTokenHash: tokenHash(), environment: "test", now: at(shift), ...s });
  return intent.id;
}
export async function priced(pool, stay = {}, shift = 0) {
  const id = await newIntent(pool, stay, shift);
  ok(await applyEvent(pool, id, { type: "PRICE_CONFIRMED", price: priceFor(stay) }, { now: at(shift), actor: "guest" }), "price");
  return id;
}
export async function withDetails(pool, stay = {}, shift = 0) {
  const id = await priced(pool, stay, shift);
  ok(await collectGuestDetails(pool, id, GUEST, { now: at(shift + 1), termsVersion: "terms-2026-10" }), "details");
  return id;
}
/** Pay step + recorded Checkout Session (mocked Stripe response). Returns { id, attemptId, sessionId }. */
export async function pending(pool, stay = {}) {
  const id = await withDetails(pool, stay);
  const b = ok(await beginPayStep(pool, id, { now: at(2) }), "pay");
  const sessionId = `cs_test_${id.slice(0, 8)}`;
  // worker claims the Stripe create-session op; the mocked Stripe response is the session id
  const op = await claimNextOperation(pool, { workerId: "w-pay", now: at(2), intentId: id, opTypes: ["stripe.create_checkout_session"] });
  ok(await completeOperation(pool, op.id, { workerId: "w-pay", now: at(2), outcome: { status: "succeeded", resultRef: sessionId } }), "cs op");
  ok(await recordCheckoutSession(pool, id, b.attempt.id, { sessionId, expiresAt: at(32), now: at(2) }), "session");
  return { id, attemptId: b.attempt.id, sessionId };
}
export async function authorized(pool, stay = {}) {
  const p = await pending(pool, stay);
  const piId = `pi_test_${p.id.slice(0, 8)}`;
  ok(await applyEvent(pool, p.id, authEvent(p.sessionId, piId), { now: at(5), actor: "webhook" }), "auth");
  return { ...p, piId };
}
export async function dispatched(pool, stay = {}, worker = "w1") {
  const a = await authorized(pool, stay);
  ok(await applyEvent(pool, a.id, { type: "RESERVATION_STARTED", workerId: worker, recheck: { bookable: true, priceSame: true } }, { now: at(6), actor: "worker", workerId: worker }), "start");
  const d = ok(await applyEvent(pool, a.id, { type: "RESERVATION_DISPATCHED", workerId: worker }, { now: at(6), actor: "worker", workerId: worker }), "dispatch");
  return { ...a, createOpId: d.operations.find((o) => o.opType === "hostaway.create_reservation").id };
}
/** Worker claims one operation of a type for an intent (mock "send" happens between claim and complete). */
export async function claimOp(pool, intentId, opType, now, workerId = "w1", leaseMs) {
  return claimNextOperation(pool, { workerId, now, intentId, opTypes: [opType], ...(leaseMs ? { leaseMs } : {}) });
}
export async function reserved(pool, stay = {}) {
  const d = await dispatched(pool, stay);
  const rid = nextReservationId();
  const op = await claimOp(pool, d.id, "hostaway.create_reservation", at(6));
  assert.ok(op, "create op claimable while lease held");
  // mocked Hostaway 201
  await recordHostawayCreateResult(pool, d.id, { httpStatus: 201, reservation: reservationFor(stay, rid) }, { now: at(7) });
  ok(await completeOperation(pool, op.id, { workerId: "w1", now: at(7), outcome: { status: "succeeded", resultRef: rid } }), "create op");
  ok(await applyEvent(pool, d.id, { type: "RESERVATION_SUCCEEDED", reservation: reservationFor(stay, rid) }, { now: at(7), actor: "worker" }), "reserved");
  return { ...d, reservationId: rid };
}
export async function captured(pool, stay = {}) {
  const r = await reserved(pool, stay);
  const op = await claimOp(pool, r.id, "stripe.capture_payment_intent", at(8));
  ok(await completeOperation(pool, op.id, { workerId: "w1", now: at(8), outcome: { status: "succeeded", resultRef: r.piId } }), "capture op");
  const c = ok(await applyEvent(pool, r.id, { type: "CAPTURE_SUCCEEDED", id: `evt_cap_${r.piId}`, amountMinor: 576000, currency: "mxn" }, { now: at(8), actor: "webhook" }), "capture");
  return { ...r, ochOpId: c.operations.find((o) => o.opType === "hostaway.record_offline_charge").id };
}
export async function confirmed(pool, stay = {}) {
  const c = await captured(pool, stay);
  const chargeId = nextReservationId() + 500000;
  const op = await claimOp(pool, c.id, "hostaway.record_offline_charge", at(9));
  ok(await completeOperation(pool, op.id, { workerId: "w1", now: at(9), outcome: { status: "succeeded", resultRef: chargeId } }), "och op");
  ok(await applyEvent(pool, c.id, { type: "OFFLINE_CHARGE_RECORDED", chargeId }, { now: at(9), actor: "worker" }), "confirmed");
  return { ...c, chargeId };
}

export const state = async (pool, id) => (await loadIntent(pool, id)).status;
export const count = async (pool, sql, params = []) => Number((await pool.query(sql, params)).rows[0].n);
export const claimOf = async (pool, id) => (await pool.query("SELECT * FROM booking.inventory_claims WHERE intent_id = $1 ORDER BY id DESC LIMIT 1", [id])).rows[0];

/** A two-party barrier: both callers wait until both have arrived. */
export function barrier(n = 2) {
  let arrived = 0; let release;
  const all = new Promise((r) => { release = r; });
  return async () => { arrived += 1; if (arrived >= n) release(); await all; };
}

// ---- E2B.1 evidence helpers: every provider fact enters through a recorded, succeeded READ operation ----
const READ_FOR_KIND = { checkout_session: "stripe.retrieve_checkout_session", payment_intent: "stripe.retrieve_payment_intent",
  hostaway_reservation: "hostaway.retrieve_reservation", hostaway_offline_charges: "hostaway.list_offline_charges" };

/** Mocked provider read -> persisted API evidence. Returns the evidence id. */
export async function readEvidence(pool, intentId, kind, externalRef, status, observed = {}, minutes = 20) {
  const opType = READ_FOR_KIND[kind];
  // use a read E3 already scheduled (e.g. after an ambiguous capture/void/cancel); otherwise queue one
  let op = await claimNextOperation(pool, { workerId: "w-read", now: at(minutes), intentId, opTypes: [opType] });
  if (!op) {
    await requestRead(pool, intentId, opType, String(externalRef), { now: at(minutes) });
    op = await claimNextOperation(pool, { workerId: "w-read", now: at(minutes), intentId, opTypes: [opType] });
  }
  assert.ok(op, "read op claimed");
  const opId = op.id;
  ok(await completeOperation(pool, opId, { workerId: "w-read", now: at(minutes), outcome: { status: "succeeded", resultRef: externalRef } }), "read");
  return ok(await recordProviderEvidence(pool, { readOpId: opId, kind, externalRef: String(externalRef), status, observed, providerRequestId: `req_${opId.slice(0, 8)}` }), "evidence").id;
}
/** Owner-attested dashboard evidence (admin login). */
export async function dashboardEvidence(adminPool, intentId, kind, externalRef, status, observed = {}, minutes = 20) {
  return ok(await adminRecordEvidence(adminPool, { intentId, kind, externalRef: String(externalRef), status, observed,
    observedAt: at(minutes), attestedBy: "owner", reference: `dashboard-check-${minutes}` }), "dashboard evidence").id;
}
export const sessionExpired = (pool, p, minutes = 33) => readEvidence(pool, p.id, "checkout_session", p.sessionId, "expired", {}, minutes);
export const piStatus = (pool, id, pi, status, observed = {}, minutes = 20) => readEvidence(pool, id, "payment_intent", pi, status, observed, minutes);
export const reservationStatus = (pool, id, rid, status, observed = {}, minutes = 20) => readEvidence(pool, id, "hostaway_reservation", rid, status, observed, minutes);

/** Worker completes the pending op of a type for an intent with a mocked provider outcome. */
export async function runOp(pool, intentId, opType, minutes, outcome = { status: "succeeded" }, workerId = "w-op") {
  const op = await claimNextOperation(pool, { workerId, now: at(minutes), intentId, opTypes: [opType] });
  assert.ok(op, `${opType} claimable`);
  const r = await completeOperation(pool, op.id, { workerId, now: at(minutes), outcome });
  return { op, r };
}

// ---- E2B.2: the database clock decides release and purge. Tests use genuinely historical dates relative to it. ----
/** Today's date (YYYY-MM-DD) by the DATABASE clock in a time zone. */
export async function dbToday(pool, tz = "UTC") {
  return (await pool.query("SELECT to_char((statement_timestamp() AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS d", [tz])).rows[0].d;
}
export const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
/**
 * TEST-ONLY historical data: make an intent's audit trail look as if it ended `days` ago. Done as the cluster
 * superuser in the throwaway test cluster with triggers bypassed (session_replication_role = replica), which is the
 * one way to create old rows now that the database stamps transition times itself. No runtime role can do this.
 */
export async function ageIntent(superPool, intentId, days) {
  const c = await superPool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL session_replication_role = replica");
    await c.query("UPDATE booking.intent_transitions SET recorded_at = recorded_at - make_interval(days => $2) WHERE intent_id = $1", [intentId, days]);
    await c.query("COMMIT");
  } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
}
