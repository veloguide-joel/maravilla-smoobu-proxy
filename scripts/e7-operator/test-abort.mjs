// E7 operator TEST ABORT (confirmed, never-captured TEST reservation) — DB-ONLY operator core. OFFLINE-REVIEWED CODE; NO CLI, NO MAIN.
// Sibling of scripts/e7-operator/test-release.mjs (that file is untouched).
//
// * Inert on import: no env / fs / network / DB / timer. Every DB handle and the gate env OBJECT are injected by the caller.
// * No provider client, no Stripe / Hostaway import in its closure. No HTTP route reaches it (static test).
// * Reads are narrow projections (no guest tables, token hashes, refs, payloads beyond two scalar fields).
// * Writes: exactly ONE call of lib/booking-db/test-abort.js requestTestAbort per execute. Never a retry. A thrown error / lost
//   reply after the call began is REQUEST_OUTCOME_UNKNOWN and is reconciled READ-ONLY here; it is never re-sent.
import { createHash } from "node:crypto";
import { loadIntent } from "../../lib/booking-db/repo.js";
import { requestTestAbort, bindAbortExpectation, ownDataSnapshot, listingAllowed, TEST_ABORT_EXPECTATION_KEYS } from "../../lib/booking-db/test-abort.js";
import { testAbortEventId, TEST_ABORT_REASON } from "../../lib/checkout/intent-state.js";

export const ABORT_PLAN_SCHEMA = "e7-operator-test-abort-plan-v1";
export const ABORT_SCOPE = Object.freeze({ provider: "none", writes: "one-e3-event", effects: ["hostaway.cancel_reservation", "stripe.void_payment_intent", "alert.owner"],
  sends: 0 });
export const CLASSES = Object.freeze(["ELIGIBLE", "ALREADY_REQUESTED", "NOT_ELIGIBLE", "INVALID"]);
export const OUTCOMES = Object.freeze(["REQUESTED", "REFUSED", "DUPLICATE_RECONCILED", "POSTCHECK_MISMATCH", "REQUEST_OUTCOME_UNKNOWN",
  "NOT_EXECUTED_ALREADY_REQUESTED", "NOT_EXECUTED_NOT_ELIGIBLE", "NOT_EXECUTED_INVALID"]);
export function canonical(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
}
const sha = (s) => createHash("sha256").update(s).digest("hex");
/** abortPlanHash(fields) over every expectation field except planHash, plus the schema and the fixed scope */
export function abortPlanHash(fields) {
  const { planHash, ...rest } = fields;   // eslint-disable-line no-unused-vars
  return sha(canonical({ schema: ABORT_PLAN_SCHEMA, scope: ABORT_SCOPE, ...rest }));
}
const FIELD_KEYS = Object.freeze(TEST_ABORT_EXPECTATION_KEYS.filter((k) => k !== "planHash"));
/** buildAbortExpectation(fields without planHash) → frozen 15-key expectation | null. The 14 input fields are snapshotted from their own
 *  data descriptors FIRST (no getter / spread / `in` on the caller object), then every value is validated, then the hash is computed. */
export function buildAbortExpectation(fields) {
  try {
    const f = ownDataSnapshot(fields, FIELD_KEYS);
    if (f === null) return null;
    const probe = bindAbortExpectation({ ...f, planHash: "0".repeat(64) });   // values validated before hashing
    if (probe === null) return null;
    const e = bindAbortExpectation({ ...f, planHash: abortPlanHash({ ...f }) });
    return e !== null && listingAllowed(e.listingId, e.currency) ? e : null;
  } catch { return null; }
}
/** the frozen bound copy of a hash-consistent expectation | null (synchronous) */
const bindWithHash = (e) => { try { const b = bindAbortExpectation(e); return b !== null && b.planHash === abortPlanHash(b) ? b : null; } catch { return null; } };

export const QUERIES = Object.freeze({
  applied: "/*e7ab:applied*/ SELECT applied_version FROM booking.intent_applied_events WHERE intent_id = $1 AND event_id = $2",
  ops: "/*e7ab:ops*/ SELECT op_type, state, attempts, (dispatched_at IS NOT NULL) AS dispatched, payload ->> 'attempt' AS attempt FROM booking.external_operations WHERE intent_id = $1 ORDER BY created_at, id",
  attempts: "/*e7ab:attempts*/ SELECT id::text AS id, status, checkout_session_id, payment_intent_id, livemode FROM booking.payment_attempts WHERE intent_id = $1 ORDER BY attempt",
  claims: "/*e7ab:claims*/ SELECT (released_at IS NOT NULL) AS released FROM booking.inventory_claims WHERE intent_id = $1",
  legs: "/*e7ab:legs*/ SELECT settlement_reservation_cancelled AS c, settlement_authorization_settled AS a FROM booking.intents WHERE id = $1"
});
const pick = (o, ks) => Object.fromEntries(ks.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));

/** classify(pool, e) → frozen projection. READ-ONLY. The in-transaction checks of requestTestAbort stay authoritative. */
export async function classify(pool, input) {
  const e = bindWithHash(input);                                         // bound BEFORE the first await
  if (e === null) return Object.freeze({ class: "INVALID", code: "EXPECTATION_INVALID" });
  const q = (sql, params = [e.intentId]) => pool.query(sql, params).then((r) => r.rows);
  const i = await loadIntent(pool, e.intentId);
  if (!i) return Object.freeze({ class: "NOT_ELIGIBLE", code: "NOT_FOUND" });
  const base = { state: i.status, version: i.version, expectedVersion: e.expectedVersion };
  const evId = testAbortEventId(e.intentId, e.paymentIntentId, e.reservationId);
  const applied = await q(QUERIES.applied, [e.intentId, evId]);
  const ops = await q(QUERIES.ops);
  const opState = (t) => { const r = ops.filter((o) => o.op_type === t); return r.length === 1 ? r[0] : null; };
  if (applied.length === 1) {
    const legs = (await q(QUERIES.legs))[0] || {};
    const claims = await q(QUERIES.claims);
    const cancel = opState("hostaway.cancel_reservation"); const voidOp = opState("stripe.void_payment_intent"); const cap = opState("stripe.capture_payment_intent");
    return Object.freeze({ class: "ALREADY_REQUESTED", code: null, ...base, abortVersion: applied[0].applied_version, reason: i.reasonCode === TEST_ABORT_REASON ? TEST_ABORT_REASON : "OTHER",
      cancelState: cancel ? cancel.state : null, voidState: voidOp ? voidOp.state : null, captureState: cap ? cap.state : null,
      captureDispatched: cap ? cap.dispatched : null, legReservationCancelled: legs.c ?? null, legAuthorizationSettled: legs.a ?? null,
      claimReleased: claims.length === 1 ? claims[0].released : null });
  }
  if (i.status !== "reservation_confirmed") return Object.freeze({ class: "NOT_ELIGIBLE", code: `STATE_${i.status}`, ...base });
  if (i.version !== e.expectedVersion) return Object.freeze({ class: "NOT_ELIGIBLE", code: "STALE_VERSION", ...base });
  const pa = await q(QUERIES.attempts);
  const p = i.payment || {}; const r = i.reservation || {};
  const identity = i.listingId === e.listingId && i.from === e.from && i.to === e.to && i.guests === e.guests && i.price && i.price.currency === e.currency
    && i.price.finalTotalMinor === e.finalTotalMinor && p.paymentIntentId === e.paymentIntentId && p.amountMinor === e.authorizedMinor && p.livemode === false
    && p.capturedMinor === 0 && i.checkout && i.checkout.sessionId === e.sessionId && String(r.reservationId) === e.reservationId
    && pa.length === 1 && pa[0].id === e.attemptId && pa[0].status === "completed" && pa[0].payment_intent_id === e.paymentIntentId;
  if (!identity) return Object.freeze({ class: "NOT_ELIGIBLE", code: "IDENTITY_MISMATCH", ...base });
  const caps = ops.filter((o) => o.op_type === "stripe.capture_payment_intent");
  if (caps.length !== 1 || caps[0].state !== "pending" || caps[0].attempts !== 0 || caps[0].dispatched) return Object.freeze({ class: "NOT_ELIGIBLE", code: "CAPTURE_NOT_PRISTINE", ...base });
  return Object.freeze({ class: "ELIGIBLE", code: null, ...base });
}

/**
 * executeOperatorAbort(pool, e, { now, env, hooks?, deps? }) → frozen { outcome, code, precheck, helper, reconciled, invocations }
 *   ONE requestTestAbort call at most; never a retry. deps.requestTestAbort (tests: the call spy / gate), deps.afterReply (tests: lost reply).
 */
export async function executeOperatorAbort(pool, input, { now, env, hooks = {}, deps = {} } = {}) {
  const r = { outcome: null, code: null, precheck: null, helper: null, reconciled: null, invocations: 0 };
  const done = () => Object.freeze(JSON.parse(JSON.stringify(r)));
  const e = bindWithHash(input);                                         // ONE bound copy for precheck, the call and the postcheck
  if (e === null) { r.precheck = Object.freeze({ class: "INVALID", code: "EXPECTATION_INVALID" }); r.outcome = "NOT_EXECUTED_INVALID"; return done(); }
  const pre = await classify(pool, e);
  r.precheck = pre;
  if (pre.class === "INVALID") { r.outcome = "NOT_EXECUTED_INVALID"; return done(); }
  if (pre.class === "ALREADY_REQUESTED") { r.outcome = "NOT_EXECUTED_ALREADY_REQUESTED"; r.reconciled = pre; return done(); }
  if (pre.class !== "ELIGIBLE") { r.outcome = "NOT_EXECUTED_NOT_ELIGIBLE"; r.code = pre.code; return done(); }
  const call = deps.requestTestAbort ?? requestTestAbort;
  let res;
  try {
    r.invocations += 1;
    res = await call(pool, e.intentId, { now, env, operator: e, hooks });
    if (deps.afterReply) await deps.afterReply(res);
  } catch {
    r.outcome = "REQUEST_OUTCOME_UNKNOWN";
    try { r.reconciled = await classify(pool, e); } catch { r.reconciled = null; r.code = "RECONCILE_READ_UNAVAILABLE"; }
    return done();
  }
  r.helper = res && typeof res === "object" ? { ok: res.ok === true, duplicate: res.duplicate === true, error: typeof res.error === "string" ? res.error : null } : null;
  if (!res || res.ok !== true) { r.outcome = "REFUSED"; r.code = r.helper ? r.helper.error : "HELPER_INVALID"; return done(); }
  try { r.reconciled = await classify(pool, e); } catch { r.code = "POSTCHECK_READ_UNAVAILABLE"; r.outcome = "REQUESTED"; return done(); }
  const ok = r.reconciled.class === "ALREADY_REQUESTED" && r.reconciled.state === "capture_failed" && r.reconciled.cancelState === "pending"
    && r.reconciled.voidState === "pending" && r.reconciled.captureState === "pending" && r.reconciled.captureDispatched === false
    && r.reconciled.claimReleased === false;
  r.outcome = res.duplicate ? "DUPLICATE_RECONCILED" : ok ? "REQUESTED" : "POSTCHECK_MISMATCH";
  return done();
}
export { TEST_ABORT_EXPECTATION_KEYS };
