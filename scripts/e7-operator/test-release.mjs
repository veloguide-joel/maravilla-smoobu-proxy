// E7 operator TEST release (lost guest token recovery) — DB-ONLY wrapper core. OFFLINE-REVIEWED CODE; NO CLI, NO MAIN.
//
// * Inert on import: no env / fs / network / DB / timer. Every DB handle is injected by the caller.
// * No provider client, no Stripe / Hostaway import anywhere in its closure (test O15 walks it). No HTTP route reaches it:
//   lib/checkout/intent-api-core.js releaseIntent never passes `operator` (test O1 checks that statically).
// * Reads are narrow projections. It never selects access_token_hash, guest tables, the ref, price_snapshot, quote_hash or
//   op payloads; the ONLY payload access is the two scalar projections the accepted cleanup runner's inspect uses
//   (providerIdempotencyKey, paymentIntentId), so the void row is judged exactly as that runner judges it.
// * Writes: exactly ONE call of repo.requestTestRelease(operator) per execute. Never a retry. A thrown error / lost reply after
//   the call began is REQUEST_OUTCOME_UNKNOWN and is reconciled READ-ONLY here; it is never re-sent.
import { createHash } from "node:crypto";
import { loadIntent, requestTestRelease, validOperatorExpectation, OPERATOR_TEST_RELEASE } from "../../lib/booking-db/repo.js";
import { voidKey, testReleaseEventId } from "../../lib/checkout/intent-state.js";

export const OPERATOR_PLAN_SCHEMA = "e7-operator-test-release-plan-v1";
export const CLASSES = Object.freeze(["ELIGIBLE", "ALREADY_REQUESTED", "ALREADY_RELEASED", "NOT_ELIGIBLE", "INVALID"]);
export const OUTCOMES = Object.freeze(["REQUESTED", "POSTCHECK_MISMATCH", "REFUSED", "DUPLICATE_RECONCILED", "REQUEST_OUTCOME_UNKNOWN",
  "NOT_EXECUTED_ALREADY_REQUESTED", "NOT_EXECUTED_ALREADY_RELEASED", "NOT_EXECUTED_NOT_ELIGIBLE", "NOT_EXECUTED_INVALID"]);
/** after the ONE helper invocation began, a failed follow-up read is reported with these codes; it never upgrades or erases the helper result */
export const READ_UNAVAILABLE = Object.freeze({ postcheck: "POSTCHECK_READ_UNAVAILABLE", duplicate: "DUPLICATE_POSTCHECK_READ_UNAVAILABLE",
  reconcile: "RECONCILE_READ_UNAVAILABLE" });

export function canonical(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
}
const sha = (s) => createHash("sha256").update(s).digest("hex");

/** planHash over every expectation field EXCEPT planHash itself, plus the schema and the fixed scope. */
export function operatorPlanHash(fields) {
  const { planHash, ...rest } = fields;              // eslint-disable-line no-unused-vars
  return sha(canonical({ schema: OPERATOR_PLAN_SCHEMA, scope: { ...OPERATOR_TEST_RELEASE }, ...rest }));
}
/** buildOperatorExpectation(fields without planHash) -> the frozen 14-key expectation, or null if it does not validate. */
export function buildOperatorExpectation(fields) {
  try {                                                                       // total: any exotic input is null, never a throw
    if (!fields || typeof fields !== "object" || Array.isArray(fields) || Object.getPrototypeOf(fields) !== Object.prototype || "planHash" in fields) return null;
    const e = { ...fields, planHash: "0".repeat(64) };
    if (!validOperatorExpectation(e, e.intentId)) return null;            // shape first, so the hash only ever sees validated scalars
    e.planHash = operatorPlanHash(fields);
    return validOperatorExpectation(e, e.intentId) ? Object.freeze(e) : null;
  } catch { return null; }
}
const validWithHash = (e) => { try { return validOperatorExpectation(e, e && e.intentId) && e.planHash === operatorPlanHash(e); } catch { return false; } };
/** a bounded error CLASS (SQLSTATE-like code or a fixed name), never a message */
const errClass = (err) => (err && typeof err.code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(err.code) ? err.code : (err && err.name === "RepoError" ? "RepoError" : "Error"));
/** the known helper result, reduced to safe fields (no intent object, no message) */
const helperSummary = (r) => (r && typeof r === "object" ? { ok: r.ok === true, duplicate: r.duplicate === true, error: typeof r.error === "string" ? r.error : null } : null);

// ---- read-only SQL (narrow projections; every statement is a SELECT filtered by intent_id) ------------------------------------
export const QUERIES = Object.freeze({
  instance: "/*e7op:instance*/ SELECT environment FROM booking.instance",
  transitions: "/*e7op:transitions*/ SELECT version_after, from_state, to_state, event_type, event_id, reason_code, actor FROM booking.intent_transitions WHERE intent_id = $1 ORDER BY version_after",
  attempts: "/*e7op:attempts*/ SELECT id::text AS id, status, checkout_session_id, payment_intent_id, livemode, amount_minor::text AS amount_minor, currency FROM booking.payment_attempts WHERE intent_id = $1 ORDER BY attempt",
  ops: "/*e7op:ops*/ SELECT op_type, state, idempotency_key, payload ->> 'providerIdempotencyKey' AS provider_key, payload ->> 'paymentIntentId' AS payload_pi, attempts, (dispatched_at IS NOT NULL) AS dispatched FROM booking.external_operations WHERE intent_id = $1 ORDER BY created_at, id",
  claims: "/*e7op:claims*/ SELECT kind, listing_id, stay::text AS stay, (released_at IS NOT NULL) AS released FROM booking.inventory_claims WHERE intent_id = $1 ORDER BY id",
  webhooks: "/*e7op:webhooks*/ SELECT status, livemode, object_id FROM booking.stripe_webhook_events WHERE intent_id = $1 AND event_type = 'checkout.session.completed'",
  hostaway: "/*e7op:hostaway*/ SELECT count(*)::int AS n FROM booking.hostaway_reservation_attempts WHERE intent_id = $1",
  cases: "/*e7op:cases*/ SELECT count(*)::int AS n FROM booking.reconciliation_cases WHERE intent_id = $1",
  ledger: "/*e7op:ledger*/ SELECT entry FROM booking.payment_ledger WHERE intent_id = $1"
});
const NO_RELEASE_OPS = Object.freeze({
  "stripe.create_checkout_session": ["succeeded"],
  "stripe.retrieve_checkout_session": ["succeeded", "failed_definite", "superseded"],
  "stripe.retrieve_payment_intent": ["succeeded", "failed_definite", "superseded"]
});
const AFTER_RELEASE_OPS = Object.freeze(["stripe.create_checkout_session", "stripe.retrieve_checkout_session", "stripe.retrieve_payment_intent",
  "stripe.void_payment_intent", "guest.notify"]);                                // = the accepted runner's ALLOWED_OPS
const ALLOWED_LEDGER = Object.freeze(["authorization_accepted", "authorization_voided"]);

/**
 * classify(pool, expectation) -> frozen { class, code, ...report }. READ-ONLY; throws only on a DB failure.
 * ELIGIBLE requires version === expectedVersion. ALREADY_* classify identity + exact lineage INDEPENDENTLY of expectedVersion and of
 * the release actor; they report releaseVersion, releaseActor and releasedAtExpectedVersion and never infer who wrote the release.
 */
export async function classify(pool, e) {
  const out = (cls, code, extra = {}) => Object.freeze({ class: cls, code, ...extra });
  if (!validWithHash(e)) return out("INVALID", "EXPECTATION_INVALID");
  const id = e.intentId;
  const q = async (sql, args = [id]) => (await pool.query(sql, args)).rows;
  const inst = await q(QUERIES.instance, []);
  if (inst.length !== 1 || inst[0].environment !== "test") return out("NOT_ELIGIBLE", "DB_NOT_TEST");
  const i = await loadIntent(pool, id);
  if (!i) return out("NOT_ELIGIBLE", "INTENT_NOT_FOUND");
  const base = { state: i.status, version: i.version, expectedVersion: e.expectedVersion };
  // identity tuple (immutable by trigger; asserted anyway) + payment + session + attempt
  if (i.id !== id || i.listingId !== e.listingId || i.from !== e.from || i.to !== e.to || i.guests !== e.guests
      || !i.price || i.price.finalTotalMinor !== e.finalTotalMinor || i.price.currency !== e.currency) return out("NOT_ELIGIBLE", "IDENTITY_MISMATCH", base);
  const p = i.payment;
  if (!p || p.paymentIntentId !== e.paymentIntentId || p.amountMinor !== e.authorizedMinor || p.currency !== e.currency
      || p.livemode !== false || p.capturedMinor !== 0) return out("NOT_ELIGIBLE", "PAYMENT_MISMATCH", base);
  if (!i.checkout || i.checkout.sessionId !== e.sessionId) return out("NOT_ELIGIBLE", "SESSION_MISMATCH", base);
  const at = await q(QUERIES.attempts);
  if (at.length !== 1 || at[0].id !== e.attemptId || at[0].status !== "completed" || at[0].checkout_session_id !== e.sessionId
      || at[0].payment_intent_id !== e.paymentIntentId || at[0].livemode !== false || at[0].amount_minor !== String(e.authorizedMinor)
      || at[0].currency !== e.currency) return out("NOT_ELIGIBLE", "ATTEMPT_MISMATCH", base);
  if (i.reservation !== null || i.dispatch !== null) return out("NOT_ELIGIBLE", "RESERVATION_OR_DISPATCH", base);
  const k = i.counters;
  if (k.reservationAttempts !== 0 || k.captureAttempts !== 0 || k.cancelAttempts !== 0 || k.offlineChargeAttempts !== 0) return out("NOT_ELIGIBLE", "COUNTERS", base);
  if ((await q(QUERIES.hostaway))[0].n !== 0) return out("NOT_ELIGIBLE", "HOSTAWAY_ATTEMPT_PRESENT", base);
  if ((await q(QUERIES.cases))[0].n !== 0) return out("NOT_ELIGIBLE", "RECONCILIATION_PRESENT", base);
  if ((await q(QUERIES.ledger)).some((l) => !ALLOWED_LEDGER.includes(l.entry))) return out("NOT_ELIGIBLE", "LEDGER", base);
  const wh = await q(QUERIES.webhooks);
  if (wh.length !== 1 || wh[0].status !== "processed" || wh[0].livemode !== false || wh[0].object_id !== e.sessionId) return out("NOT_ELIGIBLE", "EVIDENCE", base);
  // lineage (the accepted runner's inspect semantics): exactly one PAYMENT_AUTHORIZED; after it nothing, or THE release, or THE release + VOID_SUCCEEDED
  const tr = await q(QUERIES.transitions);
  const ia = tr.findIndex((t) => t.event_type === "PAYMENT_AUTHORIZED");
  if (ia < 0 || tr.filter((t) => t.event_type === "PAYMENT_AUTHORIZED").length !== 1) return out("NOT_ELIGIBLE", "LINEAGE", base);
  const after = tr.slice(ia + 1);
  const ops = await q(QUERIES.ops);
  const claims = await q(QUERIES.claims);
  const settled = (t) => ops.some((o) => o.op_type === t && o.state === "succeeded");
  if (!settled("stripe.retrieve_checkout_session") || !settled("stripe.retrieve_payment_intent")) return out("NOT_ELIGIBLE", "EVIDENCE", base);
  if (claims.length !== 1 || claims[0].listing_id !== e.listingId || claims[0].stay !== `[${e.from},${e.to})`) return out("NOT_ELIGIBLE", "CLAIM", base);

  if (after.length === 0) {
    if (i.status !== "payment_authorized" || tr[tr.length - 1].to_state !== "payment_authorized") return out("NOT_ELIGIBLE", "LINEAGE", base);
    if (ops.some((o) => !(NO_RELEASE_OPS[o.op_type] || []).includes(o.state))) return out("NOT_ELIGIBLE", "OPERATION_HISTORY", base);
    if (claims[0].released || !["checkout", "authorized"].includes(claims[0].kind)) return out("NOT_ELIGIBLE", "CLAIM", base);
    if (k.voidAttempts !== 0) return out("NOT_ELIGIBLE", "COUNTERS", base);
    if (i.version !== e.expectedVersion) return out("NOT_ELIGIBLE", "STALE", base);
    return out("ELIGIBLE", null, base);
  }
  const rel = after[0];
  if (rel.event_type !== "TEST_RELEASE_REQUESTED" || rel.from_state !== "payment_authorized" || rel.to_state !== "reservation_failed"
      || rel.reason_code !== "TEST_RELEASE_REQUESTED" || rel.event_id !== testReleaseEventId(id, e.paymentIntentId)) return out("NOT_ELIGIBLE", "LINEAGE", base);
  const tail = after.slice(1);
  const voided = tail.length === 1 && tail[0].event_type === "VOID_SUCCEEDED" && tail[0].from_state === "reservation_failed" && tail[0].to_state === "authorization_released";
  if (!(tail.length === 0 || voided) || tr[tr.length - 1].to_state !== i.status) return out("NOT_ELIGIBLE", "LINEAGE", base);
  if (ops.some((o) => !AFTER_RELEASE_OPS.includes(o.op_type))) return out("NOT_ELIGIBLE", "OPERATION_HISTORY", base);
  const voids = ops.filter((o) => o.op_type === "stripe.void_payment_intent");
  if (voids.length !== 1 || voids[0].idempotency_key !== `void:${id}:v${rel.version_after}` || voids[0].provider_key !== voidKey(id, e.paymentIntentId)
      || voids[0].payload_pi !== e.paymentIntentId) return out("NOT_ELIGIBLE", "VOID_ROW_UNEXPECTED", base);
  const report = { ...base, releaseVersion: rel.version_after, releaseActor: rel.actor, releasedAtExpectedVersion: rel.version_after === e.expectedVersion + 1,
    voidState: voids[0].state, voidAttempts: voids[0].attempts, voidDispatched: voids[0].dispatched, claimReleased: claims[0].released };
  if (tail.length === 0) {
    if (i.status !== "reservation_failed" || i.reasonCode !== "TEST_RELEASE_REQUESTED") return out("NOT_ELIGIBLE", "LINEAGE", base);
    if (!["pending", "in_flight", "outcome_unknown", "escalated", "failed_definite"].includes(voids[0].state)) return out("NOT_ELIGIBLE", "VOID_ROW_UNEXPECTED", base);
    return out("ALREADY_REQUESTED", null, { ...report, claimAnomaly: claims[0].released === true });
  }
  if (i.status !== "authorization_released" || voids[0].state !== "succeeded") return out("NOT_ELIGIBLE", "TERMINAL_INCONSISTENT", base);
  // claim state is REPORTED, never required: a held claim after a verified void is a no-write anomaly for the owner
  return out("ALREADY_RELEASED", null, { ...report, claimAnomaly: claims[0].released !== true });
}

/**
 * executeOperatorRelease(pool, expectation, { now, hooks?, deps? }) -> frozen { outcome, code, precheck, helper?, reconciled, ... }
 *   ONE logical requestTestRelease call at most; never retries. deps.afterReply (tests only) runs AFTER the call returned (i.e. after commit)
 *   and may throw to model a lost reply; deps.requestTestRelease (tests only) is the call spy.
 *   Once the call has begun, every follow-up read is guarded: a read failure keeps the KNOWN helper result and reports
 *   reconciled:null + a READ_UNAVAILABLE code + an error class. A committed reply whose post-check cannot be read is POSTCHECK_MISMATCH
 *   (never REQUESTED); a definite refusal stays REFUSED with its original code; a duplicate never becomes a bare success.
 *   A failure of the PRECHECK read (before any call) still throws: nothing was invoked.
 */
export async function executeOperatorRelease(pool, e, { now, hooks = {}, deps = {} } = {}) {
  if (!Number.isFinite(now)) throw new TypeError("executeOperatorRelease: now required");
  const done = (outcome, code, extra) => Object.freeze({ outcome, code: code ?? null, ...extra });
  const pre = await classify(pool, e);
  if (pre.class !== "ELIGIBLE") return done(`NOT_EXECUTED_${pre.class}`, pre.code, { precheck: pre });
  const call = deps.requestTestRelease ?? requestTestRelease;
  /** read-only follow-up; never throws */
  const reread = async () => { try { return { ok: true, value: await classify(pool, e) }; } catch (err) { return { ok: false, errorClass: errClass(err) }; } };
  let r;
  try {
    r = await call(pool, e.intentId, { now, hooks, operator: e });
    if (deps.afterReply) await deps.afterReply(r);
  } catch (err) {
    // the call began: the commit may or may not have happened. Never re-sent; reconciled read-only.
    const rc = await reread();
    return done("REQUEST_OUTCOME_UNKNOWN", null, { precheck: pre, helper: null, errorClass: errClass(err),     // a class only, never a message
      reconciled: rc.ok ? rc.value : null, ...(rc.ok ? {} : { reconcileError: READ_UNAVAILABLE.reconcile, reconcileErrorClass: rc.errorClass }) });
  }
  const helper = helperSummary(r);
  if (!r || r.ok !== true) {
    const rc = await reread();
    return done("REFUSED", r && typeof r.error === "string" ? r.error : "UNKNOWN_REFUSAL", { precheck: pre, helper,
      reconciled: rc.ok ? rc.value : null, ...(rc.ok ? {} : { reconcileError: READ_UNAVAILABLE.reconcile, reconcileErrorClass: rc.errorClass }) });
  }
  const post = await reread();
  if (!post.ok) return done("POSTCHECK_MISMATCH", r.duplicate ? READ_UNAVAILABLE.duplicate : READ_UNAVAILABLE.postcheck,
    { precheck: pre, helper, reconciled: null, errorClass: post.errorClass });
  if (r.duplicate) return done("DUPLICATE_RECONCILED", null, { precheck: pre, helper, reconciled: post.value });
  const v = post.value;
  const ok = v.class === "ALREADY_REQUESTED" && v.releasedAtExpectedVersion === true && v.releaseVersion === e.expectedVersion + 1
    && v.releaseActor === "admin" && v.voidState === "pending" && v.voidAttempts === 0 && v.voidDispatched === false && v.claimReleased === false;
  return done(ok ? "REQUESTED" : "POSTCHECK_MISMATCH", null, { precheck: pre, helper, reconciled: v });
}
