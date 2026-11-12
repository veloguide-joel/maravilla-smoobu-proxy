// lib/booking-db/test-cleanup.js — E7 operator TEST CLEANUP of a CAPTURED TEST payment (OFFLINE foundation; 0019).
//
// INTERNAL LIBRARY ONLY: no route, CLI, launcher, scheduler, provider client or default caller. It writes ONE E3 event
// (TEST_CLEANUP_REQUESTED) through applyEvent, which enters test_cleanup_pending with BOTH legs open: ONE host-cancel (the accepted cancel
// effect) + ONE bound FULL refund row (op type stripe.refund_payment_intent, key ref:<intent>:1 = booking.payment_refunds.idempotency_key =
// the Stripe Idempotency-Key). In the SAME transaction the accepted repo retires the PRISTINE recording row (0019 fence) and creates the
// audited payment_refunds record (seq 1, 'requested', hostaway_state 'not_applicable'). It never sends anything: a separately reviewed
// cleanup runner settles the legs later, each on its own verified proof (cancel: succeeded row + cancelled read; refund: succeeded row +
// bound Refund read + PI read, re-verified by booking.test_refund_settled_for when the leg flag is set). The claim stays held until BOTH
// legs are proven and the terminal transition's DB blockers agree (authorization_blockers via test_refund_ledgered). Nothing is notified.
//
//   * Gate (disabled by default): the caller's env OBJECT must say VERCEL_ENV development|preview (production refused) AND
//     MV_E7_TEST_CLEANUP === "enabled"; the DB instance marker AND the intent must be "test"; the listing must be EXACTLY 606998 / USD.
//   * Operator expectation (exact 17 keys, validated and COPIED synchronously before any DB access; primitive values only) binds intent /
//     version / listing / stay / amounts / PaymentIntent / Checkout Session / completed payment attempt / reservation id / CAPTURED amount /
//     charge id + the label and its plan hash (audit only).
//   * In the SAME transaction, under the intent row lock taken first by applyEvent, every persisted fact is re-read in the established
//     order (intents -> intent_work -> payment_attempts -> external_operations -> hostaway_reservation_attempts; then plain reads of
//     provider_evidence / reconciliation_cases / payment_refunds / payment_ledger). Required: ONE succeeded capture row (attempt 1, result_ref
//     = the bound charge id, amount = captured); ONE recording row, now `superseded` by this transaction (it was pristine: the UPDATE matched
//     exactly one pending / attempts 0 / never dispatched / unleased row, and the 0019 fence refused anything else); NO notification row;
//     NO void / refund / cancel history other than the two rows queued now; the capture_succeeded ledger entry for the captured amount; the
//     ONE payment_refunds row just created; an open case or unsupported evidence refuses. Any mismatch → RepoError → rollback → ZERO writes.
//   * Deterministic event id test-cleanup:{intent}:{pi}:{reservation}: a replay is a duplicate (no transition / op / record).
import { applyEvent, loadIntent, RepoError } from "./repo.js";
import { isProtectedReservationId } from "./reservation-worker.js";
import { STATES as S, TEST_CLEANUP_REASON, testCleanupEventId, refundKey } from "../checkout/intent-state.js";

export const TEST_CLEANUP_LISTINGS = Object.freeze([Object.freeze({ listingId: 606998, currency: "USD" })]);
export const TEST_CLEANUP_EXPECTATION_KEYS = Object.freeze(["approvalRef", "attemptId", "authorizedMinor", "capturedMinor", "chargeId", "currency", "expectedVersion",
  "finalTotalMinor", "from", "guests", "intentId", "listingId", "paymentIntentId", "planHash", "reservationId", "sessionId", "to"]);
export const TEST_CLEANUP_CODES = Object.freeze(["TEST_CLEANUP_GATE_CLOSED", "TEST_CLEANUP_EXPECTATION_INVALID", "TEST_CLEANUP_LISTING_NOT_ALLOWED",
  "TEST_CLEANUP_DATABASE_NOT_TEST", "TEST_CLEANUP_STALE", "TEST_CLEANUP_IDENTITY_MISMATCH", "TEST_CLEANUP_RESERVATION_PROTECTED", "TEST_CLEANUP_WORK_LEASE_HELD",
  "TEST_CLEANUP_WORK_ROW_MISSING", "TEST_CLEANUP_ATTEMPT_NOT_BOUND", "TEST_CLEANUP_CAPTURE_NOT_PROVEN", "TEST_CLEANUP_RECORDING_NOT_PRISTINE",
  "TEST_CLEANUP_NOTIFICATION_PRESENT", "TEST_CLEANUP_OPERATION_HISTORY", "TEST_CLEANUP_EFFECTS_UNEXPECTED", "TEST_CLEANUP_RESERVATION_HISTORY",
  "TEST_CLEANUP_EVIDENCE_CONFLICT", "TEST_CLEANUP_OPEN_CASE", "TEST_CLEANUP_LEDGER_MISMATCH", "TEST_CLEANUP_REFUND_RECORD", "TEST_CLEANUP_REFUND_PRESENT"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PI_RE = /^pi_[A-Za-z0-9_]{8,250}$/;
const CH_RE = /^(ch|py)_[A-Za-z0-9_]{8,200}$/;
const CS_RE = /^cs_test_[A-Za-z0-9]{8,96}$/;
const RES_RE = /^[1-9][0-9]{0,11}$/;
const LABEL_RE = /^[A-Za-z0-9._:-]{1,80}$/;
const HEX64 = /^[0-9a-f]{64}$/;
/** history op types and the states each may be in (anything else refuses). A claimed read (in_flight / outcome_unknown) or any non-succeeded WRITE refuses. */
const HISTORY_OPS = Object.freeze({
  "stripe.create_checkout_session": Object.freeze(["succeeded"]),
  "stripe.retrieve_checkout_session": Object.freeze(["pending", "succeeded", "failed_definite", "superseded"]),
  "stripe.retrieve_payment_intent": Object.freeze(["pending", "succeeded", "failed_definite", "superseded"]),
  "hostaway.lookup_reservation": Object.freeze(["pending", "succeeded", "failed_definite", "superseded"]),
  "hostaway.retrieve_reservation": Object.freeze(["pending", "succeeded", "failed_definite", "superseded"]),
  "hostaway.create_reservation": Object.freeze(["succeeded"]),
  "stripe.capture_payment_intent": Object.freeze(["succeeded"]),
  "hostaway.record_offline_charge": Object.freeze(["superseded"])             // retired by THIS transaction (fence-verified pristine)
});
const isInt = (v) => Number.isSafeInteger(v);
const strRe = (v, re) => typeof v === "string" && re.test(v);
const realDate = (s) => {
  if (typeof s !== "string" || !DATE_RE.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  if (!Number.isFinite(t)) return false;
  return new Date(t).toISOString().slice(0, 10) === s;
};

/** testCleanupGate(env) → { ok:true } | { ok:false, code }. Reads only the passed OBJECT (never process.env). */
export function testCleanupGate(env) {
  if (!env || typeof env !== "object") return { ok: false, code: "ENV_REQUIRED" };
  if (env.VERCEL_ENV === "production") return { ok: false, code: "PRODUCTION_REFUSED" };
  if (env.VERCEL_ENV !== "development" && env.VERCEL_ENV !== "preview") return { ok: false, code: "ENVIRONMENT_NOT_ALLOWED" };
  if (env.MV_E7_TEST_CLEANUP !== "enabled") return { ok: false, code: "NOT_ENABLED" };
  return { ok: true };
}
/** ownDataSnapshot(o, keys) → a null-prototype copy of EXACTLY `keys` | null (LABELLED COPY of test-abort.js: synchronous; never invokes a getter). */
export function ownDataSnapshot(o, keys) {
  try {
    if (!o || typeof o !== "object" || Array.isArray(o) || Object.getPrototypeOf(o) !== Object.prototype) return null;
    const own = Reflect.ownKeys(o);
    if (own.length !== keys.length || own.some((k) => typeof k !== "string" || !keys.includes(k))) return null;
    const out = Object.create(null);
    for (const k of keys) {
      const d = Object.getOwnPropertyDescriptor(o, k);
      if (!d || !("value" in d) || !d.enumerable) return null;
      out[k] = d.value;
    }
    return out;
  } catch { return null; }
}
function validValues(v) {
  if (!strRe(v.intentId, UUID_RE) || !strRe(v.attemptId, UUID_RE) || !isInt(v.expectedVersion) || v.expectedVersion < 0) return false;
  if (!isInt(v.listingId) || !realDate(v.from) || !realDate(v.to) || !(v.from < v.to) || !isInt(v.guests) || v.guests < 1 || v.guests > 50) return false;
  if (!strRe(v.currency, /^[A-Z]{3}$/)) return false;
  if (!isInt(v.finalTotalMinor) || v.finalTotalMinor < 1 || v.authorizedMinor !== v.finalTotalMinor || v.capturedMinor !== v.finalTotalMinor) return false;
  if (!strRe(v.paymentIntentId, PI_RE) || !strRe(v.chargeId, CH_RE) || !strRe(v.sessionId, CS_RE) || !strRe(v.reservationId, RES_RE)) return false;
  if (!strRe(v.approvalRef, LABEL_RE) || !strRe(v.planHash, HEX64)) return false;
  return true;
}
/** bindCleanupExpectation(e) → a FROZEN plain copy of the exact 17-key expectation | null. */
export function bindCleanupExpectation(e) {
  const v = ownDataSnapshot(e, TEST_CLEANUP_EXPECTATION_KEYS);
  if (v === null || !validValues(v)) return null;
  return Object.freeze({ ...v });
}
export const validCleanupExpectation = (e) => bindCleanupExpectation(e) !== null;
export const listingAllowed = (listingId, currency) => TEST_CLEANUP_LISTINGS.some((l) => l.listingId === listingId && l.currency === currency);

/**
 * requestTestCleanup(pool, intentId, { now, env, operator, hooks? }) → applyEvent result | { ok:false, error }
 *   env: the caller's env object (gate); operator: the exact frozen expectation. Never throws for a refusal.
 */
export async function requestTestCleanup(pool, intentId, { now, env, operator, hooks = {} } = {}) {
  if (!Number.isFinite(now)) throw new TypeError("requestTestCleanup: now required");
  const g = testCleanupGate(env);
  if (!g.ok) return { ok: false, error: "TEST_CLEANUP_GATE_CLOSED", gate: g.code };
  const e = bindCleanupExpectation(operator);
  if (e === null || typeof intentId !== "string" || e.intentId !== intentId) return { ok: false, error: "TEST_CLEANUP_EXPECTATION_INVALID" };
  if (!listingAllowed(e.listingId, e.currency)) return { ok: false, error: "TEST_CLEANUP_LISTING_NOT_ALLOWED" };
  if (isProtectedReservationId(e.reservationId)) return { ok: false, error: "TEST_CLEANUP_RESERVATION_PROTECTED" };
  const current = await loadIntent(pool, intentId);
  if (!current) return { ok: false, error: "NOT_FOUND" };
  const event = { type: "TEST_CLEANUP_REQUESTED", id: testCleanupEventId(intentId, e.paymentIntentId, e.reservationId), paymentIntentId: e.paymentIntentId,
    reservationId: e.reservationId, chargeId: e.chargeId };
  const fail = (code) => { throw new RepoError(code); };
  try {
    return await applyEvent(pool, intentId, event, {
      now, actor: "admin", config: { testCleanupEnabled: true, expectedLivemode: false }, hooks,
      inTx: async (c, { before, after, operations }) => {
        const inst = (await c.query("SELECT environment FROM booking.instance")).rows[0];
        if (!inst || inst.environment !== "test") fail("TEST_CLEANUP_DATABASE_NOT_TEST");
        if (before.status !== S.PAYMENT_CAPTURED || before.version !== e.expectedVersion) fail("TEST_CLEANUP_STALE");
        if (after.status !== S.TEST_CLEANUP_PENDING || after.reasonCode !== TEST_CLEANUP_REASON) fail("TEST_CLEANUP_EFFECTS_UNEXPECTED");
        const p = before.price || {}; const pay = before.payment || {}; const res = before.reservation || {};
        const ie = (await c.query("SELECT environment FROM booking.intents WHERE id = $1", [intentId])).rows[0];
        if (!ie || ie.environment !== "test") fail("TEST_CLEANUP_DATABASE_NOT_TEST");
        if (before.listingId !== e.listingId || before.from !== e.from || before.to !== e.to || before.guests !== e.guests
            || p.currency !== e.currency || p.finalTotalMinor !== e.finalTotalMinor || pay.paymentIntentId !== e.paymentIntentId
            || pay.amountMinor !== e.authorizedMinor || pay.livemode !== false || pay.capturedMinor !== e.capturedMinor
            || !before.checkout || before.checkout.sessionId !== e.sessionId || String(res.reservationId) !== e.reservationId) fail("TEST_CLEANUP_IDENTITY_MISMATCH");
        if (!listingAllowed(before.listingId, p.currency)) fail("TEST_CLEANUP_LISTING_NOT_ALLOWED");
        if (isProtectedReservationId(String(res.reservationId))) fail("TEST_CLEANUP_RESERVATION_PROTECTED");
        const w = (await c.query("SELECT work_worker_id, work_lease_until FROM booking.intent_work WHERE intent_id = $1 FOR SHARE", [intentId])).rows[0];
        if (!w) fail("TEST_CLEANUP_WORK_ROW_MISSING");
        if (w.work_worker_id !== null || w.work_lease_until !== null) fail("TEST_CLEANUP_WORK_LEASE_HELD");
        const pa = (await c.query("SELECT id::text AS id, status, checkout_session_id, payment_intent_id, livemode FROM booking.payment_attempts WHERE intent_id = $1 ORDER BY attempt FOR SHARE",
          [intentId])).rows;
        if (pa.length !== 1 || pa[0].id !== e.attemptId || pa[0].status !== "completed" || pa[0].checkout_session_id !== e.sessionId
            || pa[0].payment_intent_id !== e.paymentIntentId || pa[0].livemode !== false) fail("TEST_CLEANUP_ATTEMPT_NOT_BOUND");
        const queued = new Set(operations.filter((o) => o.inserted).map((o) => o.id));
        const ops = (await c.query(
          `SELECT id, op_type, state, attempts, dispatched_at, lease_worker_id, lease_until, late_result_status, payload, result_ref, completed_at
             FROM booking.external_operations WHERE intent_id = $1 ORDER BY created_at, id FOR SHARE`, [intentId])).rows;
        // the ONE capture: succeeded, attempt 1, exact amount, the bound charge id
        const captures = ops.filter((o) => !queued.has(o.id) && o.op_type === "stripe.capture_payment_intent");
        if (captures.length !== 1) fail("TEST_CLEANUP_CAPTURE_NOT_PROVEN");
        const cap = captures[0];
        if (cap.state !== "succeeded" || cap.attempts !== 1 || cap.dispatched_at === null || cap.late_result_status !== null || String(cap.result_ref) !== e.chargeId
            || !cap.payload || cap.payload.paymentIntentId !== e.paymentIntentId || cap.payload.attempt !== 1 || cap.payload.amountMinor !== e.capturedMinor) fail("TEST_CLEANUP_CAPTURE_NOT_PROVEN");
        // the ONE recording row: retired by this transaction from a pristine row (never dispatched / leased / attempted)
        const recs = ops.filter((o) => !queued.has(o.id) && o.op_type === "hostaway.record_offline_charge");
        if (recs.length !== 1 || recs[0].state !== "superseded" || recs[0].attempts !== 0 || recs[0].dispatched_at !== null || recs[0].lease_worker_id !== null
            || recs[0].lease_until !== null || recs[0].late_result_status !== null || recs[0].result_ref !== null) fail("TEST_CLEANUP_RECORDING_NOT_PRISTINE");
        let creates = 0;
        for (const o of ops) {
          if (queued.has(o.id)) continue;
          if (o.op_type === "guest.notify" || o.op_type === "alert.owner") fail("TEST_CLEANUP_NOTIFICATION_PRESENT");
          const allowed = HISTORY_OPS[o.op_type];
          if (!allowed || !allowed.includes(o.state) || (o.op_type !== "hostaway.record_offline_charge" && o.late_result_status !== null)) fail("TEST_CLEANUP_OPERATION_HISTORY");
          if (o.op_type === "hostaway.create_reservation") { creates += 1; if (String(o.result_ref) !== e.reservationId) fail("TEST_CLEANUP_RESERVATION_HISTORY"); }
        }
        if (creates !== 1) fail("TEST_CLEANUP_OPERATION_HISTORY");
        const fresh = ops.filter((o) => queued.has(o.id));
        const types = fresh.map((o) => `${o.op_type}:${o.state}`).sort();
        if (JSON.stringify(types) !== JSON.stringify(["hostaway.cancel_reservation:pending", "stripe.refund_payment_intent:pending"])) fail("TEST_CLEANUP_EFFECTS_UNEXPECTED");
        const rf = fresh.find((o) => o.op_type === "stripe.refund_payment_intent");
        if (!rf.payload || rf.payload.paymentIntentId !== e.paymentIntentId || rf.payload.chargeId !== e.chargeId || rf.payload.amountMinor !== e.capturedMinor
            || rf.payload.currency !== e.currency || rf.payload.attempt !== 1 || rf.payload.providerIdempotencyKey !== refundKey(intentId, 1)) fail("TEST_CLEANUP_EFFECTS_UNEXPECTED");
        const h = (await c.query("SELECT state, hostaway_reservation_id FROM booking.hostaway_reservation_attempts WHERE intent_id = $1 FOR SHARE", [intentId])).rows;
        if (h.length !== 1 || String(h[0].hostaway_reservation_id) !== e.reservationId || !["succeeded", "reconciled_found"].includes(h[0].state)) fail("TEST_CLEANUP_RESERVATION_HISTORY");
        // evidence (plain reads): payment_intent rows only for THIS PI; hostaway_reservation rows only for THIS reservation (or this ref's pre-create
        // lookup); NO offline-charge / refund evidence yet
        const ev = (await c.query("SELECT kind, external_ref, status FROM booking.provider_evidence WHERE intent_id = $1", [intentId])).rows;
        for (const x of ev) {
          if (x.kind === "payment_intent" && x.external_ref !== e.paymentIntentId) fail("TEST_CLEANUP_EVIDENCE_CONFLICT");
          if (x.kind === "hostaway_reservation" && x.external_ref !== e.reservationId && !(x.status === "not_found" && x.external_ref === before.ref)) fail("TEST_CLEANUP_EVIDENCE_CONFLICT");
          if (x.kind === "hostaway_reservation" && x.status === "cancelled") fail("TEST_CLEANUP_EVIDENCE_CONFLICT");
          if (x.kind === "hostaway_offline_charges" || x.kind === "stripe_refund") fail("TEST_CLEANUP_EVIDENCE_CONFLICT");
        }
        const cases = (await c.query("SELECT 1 FROM booking.reconciliation_cases WHERE intent_id = $1 AND status = 'open'", [intentId])).rows;
        if (cases.length !== 0) fail("TEST_CLEANUP_OPEN_CASE");
        // money facts: the capture is ledgered for exactly the captured amount; no refund/void ledger yet; exactly the ONE refund record just created
        const led = (await c.query("SELECT entry, amount_minor::text AS amt, currency, provider_ref FROM booking.payment_ledger WHERE intent_id = $1", [intentId])).rows;
        const capLed = led.filter((l) => l.entry === "capture_succeeded");
        if (capLed.length !== 1 || capLed[0].amt !== String(e.capturedMinor) || capLed[0].currency !== e.currency || capLed[0].provider_ref !== e.paymentIntentId) fail("TEST_CLEANUP_LEDGER_MISMATCH");
        if (led.some((l) => ["refund_succeeded", "refund_failed", "authorization_voided", "offline_charge_recorded"].includes(l.entry))) fail("TEST_CLEANUP_LEDGER_MISMATCH");
        const refunds = (await c.query("SELECT seq, idempotency_key, state, hostaway_state, amount_minor::text AS amt, currency, stripe_refund_id FROM booking.payment_refunds WHERE intent_id = $1", [intentId])).rows;
        if (refunds.length !== 1 || refunds[0].seq !== 1 || refunds[0].idempotency_key !== refundKey(intentId, 1) || refunds[0].state !== "requested"
            || refunds[0].hostaway_state !== "not_applicable" || refunds[0].amt !== String(e.capturedMinor) || refunds[0].currency !== e.currency || refunds[0].stripe_refund_id !== null) fail("TEST_CLEANUP_REFUND_RECORD");
      }
    });
  } catch (err) {
    if (err instanceof RepoError && TEST_CLEANUP_CODES.includes(err.code)) return { ok: false, error: err.code };
    if (err instanceof RepoError && err.code === "TEST_CLEANUP_RECORDING_NOT_PRISTINE") return { ok: false, error: err.code };
    // a refund row / record already exists for this intent (any state): the DB refuses a second one, ever
    if (err && err.code === "23505" && /one_refund_ever|payment_refunds/.test(err.constraint || "")) return { ok: false, error: "TEST_CLEANUP_REFUND_PRESENT" };
    throw err;
  }
}
