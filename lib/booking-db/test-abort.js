// lib/booking-db/test-abort.js — E7 operator TEST ABORT of a CONFIRMED, never-captured TEST reservation (OFFLINE slice).
//
// INTERNAL LIBRARY ONLY: no route, CLI, launcher, scheduler, provider client or default caller. Nothing guest-controlled reaches it:
// the HTTP intent API never imports this module (static test). It writes ONE E3 event (TEST_ABORT_REQUESTED) through applyEvent,
// which enters the accepted two-leg capture_failed compensation (ONE host-cancel + ONE void + the existing queued alert.owner).
// It never sends anything; the accepted compensation worker settles the legs later, each on its own verified proof.
//
//   * Gate (disabled by default): the caller's env OBJECT must say VERCEL_ENV development|preview (production refused) AND
//     MV_E7_TEST_ABORT === "enabled"; the DB instance marker must be "test"; the listing must be EXACTLY 606998 / USD.
//   * Operator expectation (exact 15 keys, validated and COPIED synchronously before any DB access; primitive values only) binds intent / version / listing / stay / amounts /
//     PaymentIntent / Checkout Session / completed payment attempt / reservation id + the label and its plan hash (audit only).
//   * In the SAME transaction, under the intent row lock taken first by applyEvent (FOR NO KEY UPDATE), every persisted fact is
//     re-read in the established order (intents -> intent_work -> payment_attempts -> external_operations ->
//     hostaway_reservation_attempts; then plain reads of provider_evidence / reconciliation_cases, which the runtime role cannot row-lock). The ONE capture row must still be
//     pending, attempts 0, never dispatched, unleased: a claimed row is "possibly sent" and refuses (the capture claim takes the
//     intent SHARE lock first, so the two serialise). The pending capture row is KEPT as audit; 0007 fences it forever once the
//     state leaves reservation_confirmed. Any mismatch → RepoError → rollback → { ok:false, error } with ZERO writes.
//   * Deterministic event id test-abort:{intent}:{pi}:{reservation}: a replay is a duplicate (no transition / op / alert).
//   * Reservation provenance (candidate rev, E7 r02): the ONE hostaway_reservation_attempts row is either `succeeded` (the worker applied
//     RESERVATION_SUCCEEDED) or `reconciled_found` (the accepted interrupted-worker recovery applied RECONCILED_RESERVATION_FOUND — e.g. the
//     ref-not-echoed create whose fresh-read window opens after the 2-min intent lease). `reconciled_found` is accepted ONLY with BOTH:
//     (a) the ONE create operation SUCCEEDED with result_ref = the bound reservation id (the provider's own create reply), and (b) at least
//     POSITIVE post-create by-id proof: a found_active hostaway_reservation row for exactly that id, recorded from a SUCCEEDED by-id
//     retrieve of that id whose completed_at is strictly AFTER the ONE create dispatch (and which, like every row, passes
//     reservationEvidenceAllowed). Absence of conflicting evidence alone is never enough. Nothing else changes; every other state (outcome_unknown, escalated, refused,
//     dispatched) still refuses.
import { applyEvent, loadIntent, RepoError } from "./repo.js";
import { isProtectedReservationId } from "./reservation-worker.js";
import { STATES as S, TEST_ABORT_REASON, testAbortEventId } from "../checkout/intent-state.js";

export const TEST_ABORT_LISTINGS = Object.freeze([Object.freeze({ listingId: 606998, currency: "USD" })]);
export const TEST_ABORT_EXPECTATION_KEYS = Object.freeze(["approvalRef", "attemptId", "authorizedMinor", "currency", "expectedVersion", "finalTotalMinor", "from",
  "guests", "intentId", "listingId", "paymentIntentId", "planHash", "reservationId", "sessionId", "to"]);
export const TEST_ABORT_CODES = Object.freeze(["TEST_ABORT_GATE_CLOSED", "TEST_ABORT_EXPECTATION_INVALID", "TEST_ABORT_LISTING_NOT_ALLOWED",
  "TEST_ABORT_DATABASE_NOT_TEST", "TEST_ABORT_STALE", "TEST_ABORT_IDENTITY_MISMATCH", "TEST_ABORT_RESERVATION_PROTECTED", "TEST_ABORT_WORK_LEASE_HELD",
  "TEST_ABORT_WORK_ROW_MISSING", "TEST_ABORT_ATTEMPT_NOT_BOUND", "TEST_ABORT_CAPTURE_NOT_PRISTINE", "TEST_ABORT_OPERATION_HISTORY",
  "TEST_ABORT_EFFECTS_UNEXPECTED", "TEST_ABORT_RESERVATION_HISTORY", "TEST_ABORT_EVIDENCE_CONFLICT", "TEST_ABORT_OPEN_CASE"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PI_RE = /^pi_[A-Za-z0-9]{8,64}$/;
const CS_RE = /^cs_test_[A-Za-z0-9]{8,96}$/;
const RES_RE = /^[1-9][0-9]{0,11}$/;
const LABEL_RE = /^[A-Za-z0-9._:-]{1,80}$/;
const HEX64 = /^[0-9a-f]{64}$/;
/** history op types and the states each may be in (anything else refuses). Provider READS may also still be pending (never claimed:
 *  a pending read has no provider effect); a claimed read (in_flight / outcome_unknown) or any non-succeeded WRITE refuses. */
const HISTORY_OPS = Object.freeze({
  "stripe.create_checkout_session": Object.freeze(["succeeded"]),
  "stripe.retrieve_checkout_session": Object.freeze(["pending", "succeeded", "failed_definite", "superseded"]),
  "stripe.retrieve_payment_intent": Object.freeze(["pending", "succeeded", "failed_definite", "superseded"]),
  "hostaway.lookup_reservation": Object.freeze(["pending", "succeeded", "failed_definite", "superseded"]),
  "hostaway.retrieve_reservation": Object.freeze(["pending", "succeeded", "failed_definite", "superseded"]),
  "hostaway.create_reservation": Object.freeze(["succeeded"])
});
const isInt = (v) => Number.isSafeInteger(v);
const isPlainObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const OBSERVED_RESERVATION_KEYS = Object.freeze(["bookingRef", "currency", "from", "listingId", "matchCount", "reservationId", "status", "to", "totalMinor"]);
/**
 * hostaway_reservation history the abort tolerates (root ruling b43935f0). The schema's normalized vocabulary is found_active / cancelled /
 * not_found (booking.validate_evidence); every row must be an API read bound to a SUCCEEDED read operation of THIS intent (observed_at =
 * that read's completed_at, the same injected clock that stamps dispatched_at). Exactly two classes are allowed; everything else conflicts:
 *  1. found_active for EXACTLY the bound reservation, its observed identity consistent with the bound listing / stay / total / currency /
 *     reservation (and booking ref when present), read by a by-id retrieve of that id or the by-ref lookup of this intent's ref.
 *  2. the PRE-CREATE by-ref not_found for EXACTLY this intent's ref: a lookup of that ref, observed bookingRef = ref and matchCount 0, completed
 *     strictly BEFORE the one create dispatch. Tolerated history ONLY — never proof of present absence, cancellation, void or release.
 * Missing / ambiguous provenance refuses.
 */
async function reservationEvidenceAllowed(c, x, { intentId, e, ref, createOp }) {
  if (x.source !== "hostaway_api" || typeof x.read_operation_id !== "string" || !isPlainObj(x.observed) || !(x.observed_at instanceof Date)) return false;
  const o = (await c.query(`SELECT intent_id::text AS intent_id, op_type, state, completed_at, payload ->> 'ref' AS ref, payload ->> 'reservationId' AS rid
      FROM booking.external_operations WHERE id = $1`, [x.read_operation_id])).rows[0];
  if (!o || o.intent_id !== intentId || o.state !== "succeeded" || !(o.completed_at instanceof Date) || o.completed_at.getTime() !== x.observed_at.getTime()) return false;
  const ob = x.observed;
  if (Object.keys(ob).some((k) => !OBSERVED_RESERVATION_KEYS.includes(k))) return false;
  const byRef = o.op_type === "hostaway.lookup_reservation" && o.ref === ref && ob.bookingRef === ref;
  if (x.status === "not_found") {
    if (!(byRef && x.external_ref === ref && ob.matchCount === 0 && Object.keys(ob).length === 2)) return false;
    // the ONE create dispatch (same injected clock); a lookup completed at or after it is post-create and conflicts
    return !!createOp && createOp.dispatched_at instanceof Date && x.observed_at.getTime() < createOp.dispatched_at.getTime();
  }
  if (x.status !== "found_active" || x.external_ref !== e.reservationId) return false;
  const byId = o.op_type === "hostaway.retrieve_reservation" && o.rid === e.reservationId;
  if (!byId && !(byRef && ob.matchCount === 1)) return false;
  if (byId && ob.matchCount !== undefined) return false;
  if ("bookingRef" in ob && ob.bookingRef !== ref) return false;
  return ob.reservationId === e.reservationId && String(ob.listingId) === String(e.listingId) && ob.from === e.from && ob.to === e.to
    && ob.totalMinor === e.finalTotalMinor && ob.currency === e.currency;
}
/** a PRIMITIVE string matching re — RegExp.test alone would coerce arrays / boxed values / numbers */
const strRe = (v, re) => typeof v === "string" && re.test(v);
/** a primitive canonical YYYY-MM-DD that is a real calendar day: a non-finite parse (month 00/13, day 00/99) is false BEFORE toISOString
 *  (which would throw RangeError); a rolled-over day (2027-02-30 → 03-02) fails the exact canonical round-trip */
const realDate = (s) => {
  if (typeof s !== "string" || !DATE_RE.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  if (!Number.isFinite(t)) return false;
  return new Date(t).toISOString().slice(0, 10) === s;
};

/** testAbortGate(env) → { ok:true } | { ok:false, code }. Reads only the passed OBJECT (never process.env). */
export function testAbortGate(env) {
  if (!env || typeof env !== "object") return { ok: false, code: "ENV_REQUIRED" };
  if (env.VERCEL_ENV === "production") return { ok: false, code: "PRODUCTION_REFUSED" };
  if (env.VERCEL_ENV !== "development" && env.VERCEL_ENV !== "preview") return { ok: false, code: "ENVIRONMENT_NOT_ALLOWED" };
  if (env.MV_E7_TEST_ABORT !== "enabled") return { ok: false, code: "NOT_ENABLED" };
  return { ok: true };
}

/**
 * ownDataSnapshot(o, keys) → a null-prototype copy of EXACTLY `keys` | null. Synchronous; never invokes a getter, setter or toString:
 * refuses non-plain objects, arrays, symbol / extra / missing keys, accessors and non-enumerable properties, and copies each
 * value from its own data DESCRIPTOR (not by property read). Values themselves are checked by the caller.
 */
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
/** checks a snapshot's VALUES (primitives only, exactly typed); the snapshot has no prototype and no accessor */
function validValues(v) {
  if (!strRe(v.intentId, UUID_RE) || !strRe(v.attemptId, UUID_RE) || !isInt(v.expectedVersion) || v.expectedVersion < 0) return false;
  if (!isInt(v.listingId) || !realDate(v.from) || !realDate(v.to) || !(v.from < v.to) || !isInt(v.guests) || v.guests < 1 || v.guests > 50) return false;
  if (!strRe(v.currency, /^[A-Z]{3}$/)) return false;
  if (!isInt(v.finalTotalMinor) || v.finalTotalMinor < 1 || v.authorizedMinor !== v.finalTotalMinor) return false;
  if (!strRe(v.paymentIntentId, PI_RE) || !strRe(v.sessionId, CS_RE) || !strRe(v.reservationId, RES_RE)) return false;
  if (!strRe(v.approvalRef, LABEL_RE) || !strRe(v.planHash, HEX64)) return false;
  return true;
}
/** bindAbortExpectation(e) → a FROZEN plain copy of the exact 15-key expectation | null. Synchronous; the copy is what every later check uses. */
export function bindAbortExpectation(e) {
  const v = ownDataSnapshot(e, TEST_ABORT_EXPECTATION_KEYS);
  if (v === null || !validValues(v)) return null;
  return Object.freeze({ ...v });
}
/** validAbortExpectation(e) → boolean. Exact 15 own data keys of a plain object; every value exactly typed (primitive strings / safe integers). */
export const validAbortExpectation = (e) => bindAbortExpectation(e) !== null;
export const listingAllowed = (listingId, currency) => TEST_ABORT_LISTINGS.some((l) => l.listingId === listingId && l.currency === currency);

/**
 * requestTestAbort(pool, intentId, { now, env, operator, hooks? }) → applyEvent result | { ok:false, error }
 *   env: the caller's env object (gate); operator: the exact frozen expectation. Never throws for a refusal; a database error that is
 *   not one of ours keeps its existing behaviour (rethrown: the caller treats it as an unknown outcome and reconciles read-only).
 */
export async function requestTestAbort(pool, intentId, { now, env, operator, hooks = {} } = {}) {
  if (!Number.isFinite(now)) throw new TypeError("requestTestAbort: now required");
  const g = testAbortGate(env);
  if (!g.ok) return { ok: false, error: "TEST_ABORT_GATE_CLOSED", gate: g.code };
  // validated AND copied synchronously, before the first await: later mutation of the caller's object cannot reach any check below
  const e = bindAbortExpectation(operator);
  if (e === null || typeof intentId !== "string" || e.intentId !== intentId) return { ok: false, error: "TEST_ABORT_EXPECTATION_INVALID" };
  if (!listingAllowed(e.listingId, e.currency)) return { ok: false, error: "TEST_ABORT_LISTING_NOT_ALLOWED" };
  if (isProtectedReservationId(e.reservationId)) return { ok: false, error: "TEST_ABORT_RESERVATION_PROTECTED" };
  const current = await loadIntent(pool, intentId);
  if (!current) return { ok: false, error: "NOT_FOUND" };
  // the event is built from the EXPECTATION; the reducer and the in-transaction checks bind it to the DATABASE intent
  const event = { type: "TEST_ABORT_REQUESTED", id: testAbortEventId(intentId, e.paymentIntentId, e.reservationId), paymentIntentId: e.paymentIntentId,
    reservationId: e.reservationId };
  const fail = (code) => { throw new RepoError(code); };
  try {
    return await applyEvent(pool, intentId, event, {
      now, actor: "admin", config: { testAbortEnabled: true, expectedLivemode: false }, hooks,
      inTx: async (c, { before, after, operations }) => {
        const inst = (await c.query("SELECT environment FROM booking.instance")).rows[0];
        if (!inst || inst.environment !== "test") fail("TEST_ABORT_DATABASE_NOT_TEST");
        // exact identity of the DB intent (before = the version the lock was taken at)
        if (before.status !== S.RESERVATION_CONFIRMED || before.version !== e.expectedVersion) fail("TEST_ABORT_STALE");
        if (after.status !== S.CAPTURE_FAILED || after.reasonCode !== TEST_ABORT_REASON) fail("TEST_ABORT_EFFECTS_UNEXPECTED");
        const p = before.price || {}; const pay = before.payment || {}; const res = before.reservation || {};
        const ie = (await c.query("SELECT environment FROM booking.intents WHERE id = $1", [intentId])).rows[0];
        if (!ie || ie.environment !== "test") fail("TEST_ABORT_DATABASE_NOT_TEST");
        if (before.listingId !== e.listingId || before.from !== e.from || before.to !== e.to || before.guests !== e.guests
            || p.currency !== e.currency || p.finalTotalMinor !== e.finalTotalMinor || pay.paymentIntentId !== e.paymentIntentId
            || pay.amountMinor !== e.authorizedMinor || pay.livemode !== false || pay.capturedMinor !== 0
            || !before.checkout || before.checkout.sessionId !== e.sessionId || String(res.reservationId) !== e.reservationId) fail("TEST_ABORT_IDENTITY_MISMATCH");
        if (!listingAllowed(before.listingId, p.currency)) fail("TEST_ABORT_LISTING_NOT_ALLOWED");
        if (isProtectedReservationId(String(res.reservationId))) fail("TEST_ABORT_RESERVATION_PROTECTED");
        const w = (await c.query("SELECT work_worker_id, work_lease_until FROM booking.intent_work WHERE intent_id = $1 FOR SHARE", [intentId])).rows[0];
        if (!w) fail("TEST_ABORT_WORK_ROW_MISSING");
        if (w.work_worker_id !== null || w.work_lease_until !== null) fail("TEST_ABORT_WORK_LEASE_HELD");
        const pa = (await c.query("SELECT id::text AS id, status, checkout_session_id, payment_intent_id, livemode FROM booking.payment_attempts WHERE intent_id = $1 ORDER BY attempt FOR SHARE",
          [intentId])).rows;
        if (pa.length !== 1 || pa[0].id !== e.attemptId || pa[0].status !== "completed" || pa[0].checkout_session_id !== e.sessionId
            || pa[0].payment_intent_id !== e.paymentIntentId || pa[0].livemode !== false) fail("TEST_ABORT_ATTEMPT_NOT_BOUND");
        const queued = new Set(operations.filter((o) => o.inserted).map((o) => o.id));
        const ops = (await c.query(
          `SELECT id, op_type, state, attempts, dispatched_at, lease_worker_id, lease_until, late_result_status, payload ->> 'attempt' AS attempt, result_ref
             FROM booking.external_operations WHERE intent_id = $1 ORDER BY created_at, id FOR SHARE`, [intentId])).rows;
        const captures = ops.filter((o) => !queued.has(o.id) && o.op_type === "stripe.capture_payment_intent");
        if (captures.length !== 1) fail("TEST_ABORT_CAPTURE_NOT_PRISTINE");
        const cap = captures[0];
        // a claimed capture is POSSIBLY SENT (capturedMinor 0 proves nothing): only a never-claimed row admits the abort
        if (cap.state !== "pending" || cap.attempts !== 0 || cap.dispatched_at !== null || cap.lease_worker_id !== null || cap.lease_until !== null
            || cap.late_result_status !== null || cap.attempt !== "1") fail("TEST_ABORT_CAPTURE_NOT_PRISTINE");
        let creates = 0; let createOp = null;
        for (const o of ops) {
          if (queued.has(o.id) || o.id === cap.id) continue;
          const allowed = HISTORY_OPS[o.op_type];
          if (!allowed || !allowed.includes(o.state) || o.late_result_status !== null) fail("TEST_ABORT_OPERATION_HISTORY");
          if (o.op_type === "hostaway.create_reservation") { creates += 1; createOp = o; }
        }
        if (creates !== 1) fail("TEST_ABORT_OPERATION_HISTORY");
        const fresh = ops.filter((o) => queued.has(o.id));
        const types = fresh.map((o) => `${o.op_type}:${o.state}`).sort();
        if (JSON.stringify(types) !== JSON.stringify(["alert.owner:pending", "hostaway.cancel_reservation:pending", "stripe.void_payment_intent:pending"])) fail("TEST_ABORT_EFFECTS_UNEXPECTED");
        const h = (await c.query("SELECT state, hostaway_reservation_id FROM booking.hostaway_reservation_attempts WHERE intent_id = $1 FOR SHARE", [intentId])).rows;
        if (h.length !== 1 || String(h[0].hostaway_reservation_id) !== e.reservationId) fail("TEST_ABORT_RESERVATION_HISTORY");
        let needFoundActive = false;
        if (h[0].state === "reconciled_found") {
          // recovered provenance: the ONE create SUCCEEDED with the provider's own reply id = the bound reservation (createOp is the single
          // succeeded hostaway.create_reservation row admitted by the history check above)
          if (!createOp || createOp.state !== "succeeded" || createOp.result_ref === null || String(createOp.result_ref) !== e.reservationId) fail("TEST_ABORT_RESERVATION_HISTORY");
          needFoundActive = true;
        } else if (h[0].state !== "succeeded") fail("TEST_ABORT_RESERVATION_HISTORY");
        // provider_evidence is append-only for the runtime role (no row-lock privilege): a plain read inside the locked transaction
        const ev = (await c.query("SELECT kind, source, external_ref, status, observed, observed_at, read_operation_id FROM booking.provider_evidence WHERE intent_id = $1",
          [intentId])).rows;
        for (const x of ev) {
          if (x.kind === "payment_intent" && !(x.external_ref === e.paymentIntentId && x.status === "requires_capture")) fail("TEST_ABORT_EVIDENCE_CONFLICT");
          if (x.kind === "hostaway_reservation" && !(await reservationEvidenceAllowed(c, x, { intentId, e, ref: before.ref, createOp }))) fail("TEST_ABORT_EVIDENCE_CONFLICT");
          if (x.kind === "hostaway_offline_charges") fail("TEST_ABORT_EVIDENCE_CONFLICT");
        }
        if (needFoundActive) {
          const pos = (await c.query(`SELECT count(*)::int AS n FROM booking.provider_evidence pe JOIN booking.external_operations o ON o.id = pe.read_operation_id
              WHERE pe.intent_id = $1 AND pe.kind = 'hostaway_reservation' AND pe.source = 'hostaway_api' AND pe.status = 'found_active' AND pe.external_ref = $2
                AND o.intent_id = $1 AND o.op_type = 'hostaway.retrieve_reservation' AND o.state = 'succeeded' AND o.payload ->> 'reservationId' = $2
                AND o.completed_at = pe.observed_at AND o.completed_at > $3`, [intentId, e.reservationId, createOp.dispatched_at])).rows[0].n;
          if (!(pos >= 1)) fail("TEST_ABORT_RESERVATION_HISTORY");
        }
        const cases = (await c.query("SELECT 1 FROM booking.reconciliation_cases WHERE intent_id = $1 AND status = 'open'", [intentId])).rows;
        if (cases.length !== 0) fail("TEST_ABORT_OPEN_CASE");
      }
    });
  } catch (err) {
    if (err instanceof RepoError && TEST_ABORT_CODES.includes(err.code)) return { ok: false, error: err.code };
    throw err;
  }
}
