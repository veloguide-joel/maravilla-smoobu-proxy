// lib/booking-db/test-cleanup-recorded.js — E7 operator TEST CLEANUP of a RECORDED TEST booking (OFFLINE foundation; 0021).
//
// INTERNAL LIBRARY ONLY: no route, CLI, launcher, scheduler, provider client or default caller. The PRISTINE request (test-cleanup.js) is
// untouched; it can never admit a recorded booking (it requires the recording row retired and zero notifications). This module writes ONE E3
// event (TEST_CLEANUP_REQUESTED_RECORDED) through applyEvent for a CONFIRMED TEST booking whose captured payment was RECORDED at Hostaway
// (ONE succeeded, LINKED offline-charge recording = intents.offline_charge_id) and whose ONE guest.notify row is still PRISTINE. It enters
// test_cleanup_pending with THREE legs open: ONE host-cancel + ONE bound FULL Stripe refund (both as 0019) now; the ONE Hostaway mirror
// (hostaway.refund_offline_charge, key ochr:<intent>:1) is queued by the reducer only once BOTH are proven, and the 0021 DB creation fence
// re-checks that. In the SAME transaction the accepted repo creates the audited payment_refunds record and SUPPRESSES the pristine
// notification through booking.suppress_guest_notification (authority token + append-only booking.notification_suppressions row; a
// claimed / rendered / latched / attempted row refuses and the whole request rolls back). The recording row is NOT retired: it is the
// proven book entry the mirror reverses. Nothing is sent, nothing is notified.
//
//   * Gate (disabled by default): identical to the pristine request (env OBJECT: VERCEL_ENV development|preview AND
//     MV_E7_TEST_CLEANUP === "enabled"; DB instance AND intent "test"; listing EXACTLY 606998 / USD).
//   * Operator expectation (exact 18 keys, validated and COPIED synchronously before any DB access): the pristine 17 with the Stripe charge
//     under its own name `stripeChargeId` (ch_|py_) PLUS `offlineChargeId` (the Hostaway decimal id). The two are never interchanged.
//   * In the SAME transaction, under the intent row lock taken first by applyEvent, every persisted fact is re-read in the established
//     order (intents -> intent_work -> payment_attempts -> external_operations -> hostaway_reservation_attempts; then plain reads of
//     provider_evidence / reconciliation_cases / payment_refunds / payment_ledger / notification_suppressions). Required: before = confirmed at
//     the expected version with offlineChargeId; after = test_cleanup_pending with settlement { false, false, false }; ONE succeeded capture
//     (attempt 1, result_ref = stripeChargeId); ONE recording row succeeded + linked with result_ref = offlineChargeId; ONE guest.notify row,
//     now `superseded` by this transaction (attempts 0, never dispatched, unleased) with its audit row; NO alert.owner; NO void / refund /
//     cancel / mirror history other than the two rows queued now; the capture_succeeded AND offline_charge_recorded ledger entries; the ONE
//     payment_refunds row just created; the recording's linked charge-list evidence is the only offline-charge evidence; an open case refuses.
//     Any mismatch → RepoError → rollback → ZERO writes.
//   * Deterministic event id test-cleanup-recorded:{intent}:{pi}:{reservation}:{offlineChargeId}: a replay is a duplicate.
import { applyEvent, loadIntent, RepoError } from "./repo.js";
import { isProtectedReservationId } from "./reservation-worker.js";
import { STATES as S, TEST_CLEANUP_REASON, testCleanupRecordedEventId, refundKey } from "../checkout/intent-state.js";
import { testCleanupGate, ownDataSnapshot, listingAllowed, TEST_CLEANUP_LISTINGS } from "./test-cleanup.js";

export { testCleanupGate, listingAllowed, TEST_CLEANUP_LISTINGS };
export const TEST_CLEANUP_RECORDED_EXPECTATION_KEYS = Object.freeze(["approvalRef", "attemptId", "authorizedMinor", "capturedMinor", "currency", "expectedVersion",
  "finalTotalMinor", "from", "guests", "intentId", "listingId", "offlineChargeId", "paymentIntentId", "planHash", "reservationId", "sessionId", "stripeChargeId", "to"]);
export const TEST_CLEANUP_RECORDED_CODES = Object.freeze(["TEST_CLEANUP_GATE_CLOSED", "TEST_CLEANUP_EXPECTATION_INVALID", "TEST_CLEANUP_LISTING_NOT_ALLOWED",
  "TEST_CLEANUP_DATABASE_NOT_TEST", "TEST_CLEANUP_STALE", "TEST_CLEANUP_IDENTITY_MISMATCH", "TEST_CLEANUP_RESERVATION_PROTECTED", "TEST_CLEANUP_WORK_LEASE_HELD",
  "TEST_CLEANUP_WORK_ROW_MISSING", "TEST_CLEANUP_ATTEMPT_NOT_BOUND", "TEST_CLEANUP_CAPTURE_NOT_PROVEN", "TEST_CLEANUP_RECORDING_NOT_PROVEN",
  "TEST_CLEANUP_NOTIFY_NOT_PRISTINE", "TEST_CLEANUP_NOTIFY_NOT_SUPPRESSED", "TEST_CLEANUP_NOTIFICATION_PRESENT", "TEST_CLEANUP_OPERATION_HISTORY",
  "TEST_CLEANUP_EFFECTS_UNEXPECTED", "TEST_CLEANUP_RESERVATION_HISTORY", "TEST_CLEANUP_EVIDENCE_CONFLICT", "TEST_CLEANUP_OPEN_CASE",
  "TEST_CLEANUP_LEDGER_MISMATCH", "TEST_CLEANUP_REFUND_RECORD", "TEST_CLEANUP_REFUND_PRESENT", "TEST_CLEANUP_RECORDED_CHARGE_MISMATCH"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PI_RE = /^pi_[A-Za-z0-9_]{8,250}$/;
const CH_RE = /^(ch|py)_[A-Za-z0-9_]{8,200}$/;
const CS_RE = /^cs_test_[A-Za-z0-9]{8,96}$/;
const RES_RE = /^[1-9][0-9]{0,11}$/;
const OCH_RE = /^[1-9][0-9]{0,15}$/;
const LABEL_RE = /^[A-Za-z0-9._:-]{1,80}$/;
const HEX64 = /^[0-9a-f]{64}$/;
/** history op types and the states each may be in (anything else refuses). */
const HISTORY_OPS = Object.freeze({
  "stripe.create_checkout_session": Object.freeze(["succeeded"]),
  "stripe.retrieve_checkout_session": Object.freeze(["pending", "succeeded", "failed_definite", "superseded"]),
  "stripe.retrieve_payment_intent": Object.freeze(["pending", "succeeded", "failed_definite", "superseded"]),
  "hostaway.lookup_reservation": Object.freeze(["pending", "succeeded", "failed_definite", "superseded"]),
  "hostaway.retrieve_reservation": Object.freeze(["pending", "succeeded", "failed_definite", "superseded"]),
  "hostaway.list_offline_charges": Object.freeze(["succeeded"]),                      // the recording's confirming / preflight reads
  "hostaway.create_reservation": Object.freeze(["succeeded"]),
  "stripe.capture_payment_intent": Object.freeze(["succeeded"]),
  "hostaway.record_offline_charge": Object.freeze(["succeeded"]),                     // the proven book entry (NOT retired)
  "guest.notify": Object.freeze(["superseded"])                                       // suppressed by THIS transaction (fence-verified pristine)
});
const isInt = (v) => Number.isSafeInteger(v);
const strRe = (v, re) => typeof v === "string" && re.test(v);
const realDate = (s) => {
  if (typeof s !== "string" || !DATE_RE.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  if (!Number.isFinite(t)) return false;
  return new Date(t).toISOString().slice(0, 10) === s;
};
function validValues(v) {
  if (!strRe(v.intentId, UUID_RE) || !strRe(v.attemptId, UUID_RE) || !isInt(v.expectedVersion) || v.expectedVersion < 0) return false;
  if (!isInt(v.listingId) || !realDate(v.from) || !realDate(v.to) || !(v.from < v.to) || !isInt(v.guests) || v.guests < 1 || v.guests > 50) return false;
  if (!strRe(v.currency, /^[A-Z]{3}$/)) return false;
  if (!isInt(v.finalTotalMinor) || v.finalTotalMinor < 1 || v.authorizedMinor !== v.finalTotalMinor || v.capturedMinor !== v.finalTotalMinor) return false;
  if (!strRe(v.paymentIntentId, PI_RE) || !strRe(v.stripeChargeId, CH_RE) || !strRe(v.sessionId, CS_RE) || !strRe(v.reservationId, RES_RE)) return false;
  if (!strRe(v.offlineChargeId, OCH_RE) || v.offlineChargeId === v.reservationId) return false;   // a Hostaway decimal id; never a Stripe id, never the reservation
  if (!strRe(v.approvalRef, LABEL_RE) || !strRe(v.planHash, HEX64)) return false;
  return true;
}
/** bindRecordedCleanupExpectation(e) → a FROZEN plain copy of the exact 18-key expectation | null. */
export function bindRecordedCleanupExpectation(e) {
  const v = ownDataSnapshot(e, TEST_CLEANUP_RECORDED_EXPECTATION_KEYS);
  if (v === null || !validValues(v)) return null;
  return Object.freeze({ ...v });
}
export const validRecordedCleanupExpectation = (e) => bindRecordedCleanupExpectation(e) !== null;

/**
 * requestRecordedTestCleanup(pool, intentId, { now, env, operator, hooks? }) → applyEvent result | { ok:false, error }
 *   env: the caller's env object (gate); operator: the exact frozen expectation. Never throws for a refusal.
 */
export async function requestRecordedTestCleanup(pool, intentId, { now, env, operator, hooks = {} } = {}) {
  if (!Number.isFinite(now)) throw new TypeError("requestRecordedTestCleanup: now required");
  const g = testCleanupGate(env);
  if (!g.ok) return { ok: false, error: "TEST_CLEANUP_GATE_CLOSED", gate: g.code };
  const e = bindRecordedCleanupExpectation(operator);
  if (e === null || typeof intentId !== "string" || e.intentId !== intentId) return { ok: false, error: "TEST_CLEANUP_EXPECTATION_INVALID" };
  if (!listingAllowed(e.listingId, e.currency)) return { ok: false, error: "TEST_CLEANUP_LISTING_NOT_ALLOWED" };
  if (isProtectedReservationId(e.reservationId)) return { ok: false, error: "TEST_CLEANUP_RESERVATION_PROTECTED" };
  const current = await loadIntent(pool, intentId);
  if (!current) return { ok: false, error: "NOT_FOUND" };
  const event = { type: "TEST_CLEANUP_REQUESTED_RECORDED", id: testCleanupRecordedEventId(intentId, e.paymentIntentId, e.reservationId, e.offlineChargeId),
    paymentIntentId: e.paymentIntentId, reservationId: e.reservationId, stripeChargeId: e.stripeChargeId, offlineChargeId: e.offlineChargeId };
  const fail = (code) => { throw new RepoError(code); };
  try {
    return await applyEvent(pool, intentId, event, {
      now, actor: "admin", config: { testCleanupEnabled: true, expectedLivemode: false }, hooks,
      inTx: async (c, { before, after, operations }) => {
        const inst = (await c.query("SELECT environment FROM booking.instance")).rows[0];
        if (!inst || inst.environment !== "test") fail("TEST_CLEANUP_DATABASE_NOT_TEST");
        if (before.status !== S.CONFIRMED || before.version !== e.expectedVersion) fail("TEST_CLEANUP_STALE");
        if (after.status !== S.TEST_CLEANUP_PENDING || after.reasonCode !== TEST_CLEANUP_REASON || !after.settlement
            || after.settlement.reservationCancelled !== false || after.settlement.authorizationSettled !== false || after.settlement.recordingMirrored !== false) fail("TEST_CLEANUP_EFFECTS_UNEXPECTED");
        const p = before.price || {}; const pay = before.payment || {}; const res = before.reservation || {};
        const ie = (await c.query("SELECT environment, offline_charge_id, settlement_recording_mirrored FROM booking.intents WHERE id = $1", [intentId])).rows[0];
        if (!ie || ie.environment !== "test") fail("TEST_CLEANUP_DATABASE_NOT_TEST");
        if (ie.offline_charge_id !== e.offlineChargeId || String(before.offlineChargeId) !== e.offlineChargeId || String(after.offlineChargeId) !== e.offlineChargeId
            || ie.settlement_recording_mirrored !== false) fail("TEST_CLEANUP_RECORDED_CHARGE_MISMATCH");
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
          `SELECT id, op_type, state, attempts, dispatched_at, lease_worker_id, lease_until, late_result_status, payload, result_ref, completed_at, settled_evidence_id
             FROM booking.external_operations WHERE intent_id = $1 ORDER BY created_at, id FOR SHARE`, [intentId])).rows;
        // the ONE capture: succeeded, attempt 1, exact amount, the bound STRIPE charge id
        const captures = ops.filter((o) => !queued.has(o.id) && o.op_type === "stripe.capture_payment_intent");
        if (captures.length !== 1) fail("TEST_CLEANUP_CAPTURE_NOT_PROVEN");
        const cap = captures[0];
        if (cap.state !== "succeeded" || cap.attempts !== 1 || cap.dispatched_at === null || cap.late_result_status !== null || String(cap.result_ref) !== e.stripeChargeId
            || !cap.payload || cap.payload.paymentIntentId !== e.paymentIntentId || cap.payload.attempt !== 1 || cap.payload.amountMinor !== e.capturedMinor) fail("TEST_CLEANUP_CAPTURE_NOT_PROVEN");
        // the ONE recording row: succeeded, attempt 1, LINKED proof, result_ref = the bound OFFLINE charge id, payload bound to the reservation / amount
        const recs = ops.filter((o) => !queued.has(o.id) && o.op_type === "hostaway.record_offline_charge");
        if (recs.length !== 1) fail("TEST_CLEANUP_RECORDING_NOT_PROVEN");
        const rec = recs[0];
        if (rec.state !== "succeeded" || rec.attempts !== 1 || rec.dispatched_at === null || rec.late_result_status !== null || rec.settled_evidence_id === null
            || String(rec.result_ref) !== e.offlineChargeId || !rec.payload || String(rec.payload.reservationId) !== e.reservationId
            || rec.payload.amountMinor !== e.capturedMinor) fail("TEST_CLEANUP_RECORDING_NOT_PROVEN");
        // the ONE guest.notify row: suppressed by THIS transaction from a pristine row (never attempted / dispatched / leased)
        const notes = ops.filter((o) => !queued.has(o.id) && o.op_type === "guest.notify");
        if (notes.length !== 1) fail("TEST_CLEANUP_NOTIFY_NOT_PRISTINE");
        const nt = notes[0];
        if (nt.state !== "superseded" || nt.attempts !== 0 || nt.dispatched_at !== null || nt.lease_worker_id !== null || nt.lease_until !== null
            || nt.late_result_status !== null || nt.result_ref !== null || nt.completed_at !== null || !nt.payload || nt.payload.template !== "booking_confirmed") fail("TEST_CLEANUP_NOTIFY_NOT_PRISTINE");
        const sup = (await c.query("SELECT operation_id, intent_version, reason FROM booking.notification_suppressions WHERE intent_id = $1", [intentId])).rows;
        if (sup.length !== 1 || sup[0].operation_id !== nt.id || sup[0].intent_version !== after.version || sup[0].reason !== "TEST_CLEANUP_RECORDED") fail("TEST_CLEANUP_NOTIFY_NOT_SUPPRESSED");
        if ((await c.query("SELECT 1 FROM booking.notification_renders WHERE operation_id = $1 UNION ALL SELECT 1 FROM booking.notification_latches WHERE operation_id = $1", [nt.id])).rows.length !== 0) fail("TEST_CLEANUP_NOTIFY_NOT_PRISTINE");
        let creates = 0;
        for (const o of ops) {
          if (queued.has(o.id)) continue;
          if (o.op_type === "alert.owner") fail("TEST_CLEANUP_NOTIFICATION_PRESENT");
          const allowed = HISTORY_OPS[o.op_type];
          if (!allowed || !allowed.includes(o.state) || o.late_result_status !== null) fail("TEST_CLEANUP_OPERATION_HISTORY");
          if (o.op_type === "hostaway.create_reservation") { creates += 1; if (String(o.result_ref) !== e.reservationId) fail("TEST_CLEANUP_RESERVATION_HISTORY"); }
        }
        if (creates !== 1) fail("TEST_CLEANUP_OPERATION_HISTORY");
        // the two rows queued NOW: exactly cancel + the bound Stripe refund; the mirror row does NOT exist yet (queued only after both are proven)
        const fresh = ops.filter((o) => queued.has(o.id));
        const types = fresh.map((o) => `${o.op_type}:${o.state}`).sort();
        if (JSON.stringify(types) !== JSON.stringify(["hostaway.cancel_reservation:pending", "stripe.refund_payment_intent:pending"])) fail("TEST_CLEANUP_EFFECTS_UNEXPECTED");
        const rf = fresh.find((o) => o.op_type === "stripe.refund_payment_intent");
        if (!rf.payload || rf.payload.paymentIntentId !== e.paymentIntentId || rf.payload.chargeId !== e.stripeChargeId || rf.payload.amountMinor !== e.capturedMinor
            || rf.payload.currency !== e.currency || rf.payload.attempt !== 1 || rf.payload.providerIdempotencyKey !== refundKey(intentId, 1)) fail("TEST_CLEANUP_EFFECTS_UNEXPECTED");
        const h = (await c.query("SELECT state, hostaway_reservation_id FROM booking.hostaway_reservation_attempts WHERE intent_id = $1 FOR SHARE", [intentId])).rows;
        if (h.length !== 1 || String(h[0].hostaway_reservation_id) !== e.reservationId || !["succeeded", "reconciled_found"].includes(h[0].state)) fail("TEST_CLEANUP_RESERVATION_HISTORY");
        // evidence (plain reads): PI rows only for THIS PI; reservation rows only for THIS reservation (or this ref's pre-create lookup) and never
        // cancelled; offline-charge evidence only for THIS reservation (the recording's reads; the linked proof must be among them); NO refund evidence
        const ev = (await c.query("SELECT id, kind, external_ref, status FROM booking.provider_evidence WHERE intent_id = $1", [intentId])).rows;
        for (const x of ev) {
          if (x.kind === "payment_intent" && x.external_ref !== e.paymentIntentId) fail("TEST_CLEANUP_EVIDENCE_CONFLICT");
          if (x.kind === "hostaway_reservation" && x.external_ref !== e.reservationId && !(x.status === "not_found" && x.external_ref === before.ref)) fail("TEST_CLEANUP_EVIDENCE_CONFLICT");
          if (x.kind === "hostaway_reservation" && x.status === "cancelled") fail("TEST_CLEANUP_EVIDENCE_CONFLICT");
          if (x.kind === "hostaway_offline_charges" && (x.external_ref !== e.reservationId || x.status !== "listed")) fail("TEST_CLEANUP_EVIDENCE_CONFLICT");
          if (x.kind === "stripe_refund") fail("TEST_CLEANUP_EVIDENCE_CONFLICT");
        }
        if (!ev.some((x) => x.id === rec.settled_evidence_id && x.kind === "hostaway_offline_charges")) fail("TEST_CLEANUP_RECORDING_NOT_PROVEN");
        const cases = (await c.query("SELECT 1 FROM booking.reconciliation_cases WHERE intent_id = $1 AND status = 'open'", [intentId])).rows;
        if (cases.length !== 0) fail("TEST_CLEANUP_OPEN_CASE");
        // money facts: capture ledgered once (Stripe PI), the recording ledgered once (Hostaway offline charge id); no refund / void / mirror ledger yet
        const led = (await c.query("SELECT entry, amount_minor::text AS amt, currency, provider, provider_ref FROM booking.payment_ledger WHERE intent_id = $1", [intentId])).rows;
        const capLed = led.filter((l) => l.entry === "capture_succeeded");
        if (capLed.length !== 1 || capLed[0].amt !== String(e.capturedMinor) || capLed[0].currency !== e.currency || capLed[0].provider_ref !== e.paymentIntentId) fail("TEST_CLEANUP_LEDGER_MISMATCH");
        const recLed = led.filter((l) => l.entry === "offline_charge_recorded");
        if (recLed.length !== 1 || recLed[0].amt !== String(e.capturedMinor) || recLed[0].currency !== e.currency || recLed[0].provider !== "hostaway"
            || recLed[0].provider_ref !== e.offlineChargeId) fail("TEST_CLEANUP_LEDGER_MISMATCH");
        if (led.some((l) => ["refund_succeeded", "refund_failed", "authorization_voided", "offline_charge_refund_recorded"].includes(l.entry))) fail("TEST_CLEANUP_LEDGER_MISMATCH");
        const refunds = (await c.query("SELECT seq, idempotency_key, state, hostaway_state, amount_minor::text AS amt, currency, stripe_refund_id FROM booking.payment_refunds WHERE intent_id = $1", [intentId])).rows;
        if (refunds.length !== 1 || refunds[0].seq !== 1 || refunds[0].idempotency_key !== refundKey(intentId, 1) || refunds[0].state !== "requested"
            || refunds[0].hostaway_state !== "not_applicable" || refunds[0].amt !== String(e.capturedMinor) || refunds[0].currency !== e.currency || refunds[0].stripe_refund_id !== null) fail("TEST_CLEANUP_REFUND_RECORD");
      }
    });
  } catch (err) {
    if (err instanceof RepoError && TEST_CLEANUP_RECORDED_CODES.includes(err.code)) return { ok: false, error: err.code };
    // the DB suppression API refused (claimed / rendered / latched / not pristine / count): read-only refusal, nothing written
    if (err && err.code === "23514" && /^NOTIFY_(SUPPRESS_REFUSED|SUPPRESS_FENCED|LATCHED|SUPPRESS_UNAUDITED)/.test(err.message || "")) return { ok: false, error: "TEST_CLEANUP_NOTIFY_NOT_PRISTINE", detail: err.message.split(/\s/)[0] };
    // a refund row / record already exists for this intent (any state): the DB refuses a second one, ever
    if (err && err.code === "23505" && /one_refund_ever|payment_refunds/.test(err.constraint || "")) return { ok: false, error: "TEST_CLEANUP_REFUND_PRESENT" };
    throw err;
  }
}
