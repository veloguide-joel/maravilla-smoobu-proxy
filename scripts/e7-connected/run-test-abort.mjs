// scripts/e7-connected/run-test-abort.mjs — E7 M2-C: journalled TEST-abort BRIDGE (OFFLINE / LOCAL; inert until called with injected deps).
// Contract: claude/e7-run-test-abort-bridge.md. No env, fs, network, timers of its own, provider or worker; every capability (v2 journal, pool,
// guard, env object, clock value) is INJECTED. It reuses the accepted operator core (scripts/e7-operator/test-abort.mjs → requestTestAbort)
// exactly once and never resends. Journal evidence is a trusted producer's record, not independent DB authentication.
//
// runTestAbortBridge(input) → Promise<frozen BridgeResult> (never rejects for a refusal):
//   input = { manifest, operator, journal, trustedHead, pool, env, guard, now, operatorDeps? }   (plain own data properties only)
//   outcome ∈ REFUSED_BEFORE_START | STOPPED_START_UNACKED | STOPPED_BEFORE_OPERATOR | ABORT_REFUSED | ABORT_NOT_THIS_RUN | ABORT_OUTCOME_UNKNOWN
//             | ABORT_POSTCHECK_FAILED | STOPPED_RECEIPT_UNACKED | ABORT_ACCEPTED_JOURNALED      (cleanupPermitted is true ONLY for the last)
//   counters: operatorCoreInvocations = calls of the accepted executeOperatorAbort, counted INSIDE the guard's started callback (0 or 1);
//             requestHelperInvocations = the core's OWN reported count of requestTestAbort calls (0 / 1), null when the core's result is unknown.
//   dbAbortApplied: true = applied event + transition for the deterministic id OBSERVED; false = both OBSERVED absent at the read; null = not read.
//   trustedHead: the LAST ACKNOWLEDGED journal head (seq / hash). It never advances on a lost / malformed ACK; a consumer must validate
//             against it (an unacknowledged landed record is then an extra tail → refused) and must honour the stop, never an unanchored
//             journalFactsV2 view. receiptLanding: NOT_ATTEMPTED | ACKED | UNACKED_MAY_HAVE_LANDED (a started, unACKed receipt is never claimed absent).
import { types } from "node:util";
import { bindManifestV2, journalFactsV2, recordHashV2, ABORT_QUEUED, ABORT_REASON, RECORD_VERSION_V2 } from "./run-journal-memory-v2.mjs";
import { LIMITS } from "./run-guard.mjs";
import { bindAbortExpectation } from "../../lib/booking-db/test-abort.js";
import { loadIntent } from "../../lib/booking-db/repo.js";
import { executeOperatorAbort, abortPlanHash } from "../e7-operator/test-abort.mjs";
import { testAbortEventId } from "../../lib/checkout/intent-state.js";

export const BRIDGE_VERSION = "e7-run-test-abort-bridge-v1";
export const BRIDGE_OUTCOMES = Object.freeze(["REFUSED_BEFORE_START", "STOPPED_START_UNACKED", "STOPPED_BEFORE_OPERATOR", "ABORT_REFUSED", "ABORT_NOT_THIS_RUN", "ABORT_OUTCOME_UNKNOWN",
  "ABORT_POSTCHECK_FAILED", "STOPPED_RECEIPT_UNACKED", "ABORT_ACCEPTED_JOURNALED"]);
export const BRIDGE_LIMITS = Object.freeze({ journalMs: LIMITS.JOURNAL_MS, abortMs: LIMITS.STEP_MARGIN_MS, postcheckMs: LIMITS.SNAPSHOT_MS });
const INPUT_KEYS = ["env", "guard", "journal", "manifest", "now", "operator", "operatorDeps", "pool", "trustedHead"];
const REQUIRED = ["env", "guard", "journal", "manifest", "now", "operator", "pool", "trustedHead"];
const freeze = Object.freeze;
const HEX64 = /^[0-9a-f]{64}$/;

/** own enumerable DATA properties of a plain, non-Proxy object → null-prototype copy | null (no getter / trap is run) */
function dataProps(o, allowed) {
  try {
    if (o === null || typeof o !== "object" || types.isProxy(o) || Array.isArray(o)) return null;
    const p = Object.getPrototypeOf(o); if (p !== Object.prototype && p !== null) return null;
    const d = Object.getOwnPropertyDescriptors(o); const out = Object.create(null);
    for (const k of Reflect.ownKeys(d)) {
      if (typeof k !== "string" || !allowed.includes(k) || !("value" in d[k]) || d[k].enumerable !== true) return null;
      out[k] = d[k].value;
    }
    return out;
  } catch { return null; }
}
/** a capability object (frozen journal / guard): the named methods read from own DATA descriptors (functions), no getter */
function methods(o, names) {
  try {
    if (o === null || typeof o !== "object" || types.isProxy(o)) return null;
    const out = Object.create(null);
    for (const n of names) { const d = Object.getOwnPropertyDescriptor(o, n); if (!d || !("value" in d) || typeof d.value !== "function") return null; out[n] = d.value; }
    return out;
  } catch { return null; }
}
const envCopy = (e) => { const c = dataProps(e, ["VERCEL_ENV", "MV_E7_TEST_ABORT"]); return c && Object.values(c).every((v) => typeof v === "string") ? freeze({ ...c }) : null; };
const headCopy = (h) => { const c = dataProps(h, ["hash", "seq"]); return c && Number.isSafeInteger(c.seq) && c.seq >= 1 && typeof c.hash === "string" && HEX64.test(c.hash) && Object.keys(c).length === 2 ? freeze({ seq: c.seq, hash: c.hash }) : null; };

/** the bounded observation of ONE started operation → { kind:'fulfilled', value } | { kind:'rejected' } | { kind:'uncertain', code } */
async function bounded(guard, ms, start) {
  let n;
  try { n = guard.now(); } catch { return { kind: "uncertain", code: "GUARD_NOW_FAULT", started: false }; }       // injected clock fault: code-only, not started
  let value;
  try { if (!n || typeof n !== "object" || n.ok !== true) return { kind: "uncertain", code: "GUARD_NOW_INVALID", started: false }; value = n.value; }
  catch { return { kind: "uncertain", code: "GUARD_NOW_INVALID", started: false }; }
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isFinite(value + ms)) return { kind: "uncertain", code: "GUARD_NOW_INVALID", started: false };
  let r;
  try { r = await guard.observe(value + ms, start); } catch { return { kind: "uncertain", code: "GUARD_FAULT", started: true }; }
  if (!r || typeof r !== "object") return { kind: "uncertain", code: "GUARD_FAULT", started: true };
  if (r.kind === "fulfilled") return { kind: "fulfilled", value: r.value, started: true };
  if (r.kind === "rejected") return { kind: "rejected", started: true };
  if (r.kind === "not_started") return { kind: "uncertain", code: `NOT_STARTED_${typeof r.code === "string" ? r.code : "UNKNOWN"}`.slice(0, 48), started: false };
  return { kind: "uncertain", code: r.kind === "timeout" ? "TIMEOUT" : "OBSERVATION_FAILED", started: true };
}
const ackOk = (ack, rec) => { try {
  if (ack === null || typeof ack !== "object" || types.isProxy(ack)) return false;
  const d = Object.getOwnPropertyDescriptors(ack); const ks = Reflect.ownKeys(d);
  return ks.length === 2 && "value" in (d.seq || {}) && "value" in (d.hash || {}) && d.seq.value === rec.seq && d.hash.value === recordHashV2(rec);
} catch { return false; } };

/** READ-ONLY postcheck facts (SELECT / loadIntent only); every proof field explicit */
async function postcheck(pool, e, rid) {
  const evId = testAbortEventId(e.intentId, e.paymentIntentId, rid);
  const applied = e.expectedVersion + 1;
  const q = async (sql, params) => (await pool.query(sql, params)).rows;
  const i = await loadIntent(pool, e.intentId);
  const ae = await q("/*m2c:applied*/ SELECT event_type, applied_version FROM booking.intent_applied_events WHERE intent_id = $1 AND event_id = $2", [e.intentId, evId]);
  const tr = await q("/*m2c:transition*/ SELECT from_state, to_state, event_type, actor, version_after FROM booking.intent_transitions WHERE intent_id = $1 AND event_id = $2", [e.intentId, evId]);
  const caps = await q("/*m2c:capture*/ SELECT state, attempts, (dispatched_at IS NOT NULL) AS dispatched, (lease_worker_id IS NOT NULL OR lease_until IS NOT NULL) AS leased FROM booking.external_operations WHERE intent_id = $1 AND op_type = 'stripe.capture_payment_intent'", [e.intentId]);
  const fresh = await q("/*m2c:queued*/ SELECT op_type, state, attempts FROM booking.external_operations WHERE intent_id = $1 AND source_version = $2 ORDER BY op_type", [e.intentId, applied]);
  const claims = await q("/*m2c:claim*/ SELECT (released_at IS NULL) AS held FROM booking.inventory_claims WHERE intent_id = $1", [e.intentId]);
  const cases = await q("/*m2c:cases*/ SELECT count(*)::int AS n FROM booking.reconciliation_cases WHERE intent_id = $1 AND status = 'open'", [e.intentId]);
  const facts = {
    eventId: evId, appliedEvents: ae.length, appliedEventType: ae[0] ? ae[0].event_type : null, appliedVersion: ae[0] ? ae[0].applied_version : null,
    transition: tr.length === 1 ? `${tr[0].from_state}>${tr[0].to_state}:${tr[0].event_type}:${tr[0].actor}:${tr[0].version_after}` : `rows:${tr.length}`,
    intentState: i ? i.status : null, intentReason: i ? i.reasonCode : null, intentVersion: i ? i.version : null,
    piMatches: !!(i && i.payment && i.payment.paymentIntentId === e.paymentIntentId),
    reservationMatches: !!(i && i.reservation && String(i.reservation.reservationId) === rid),
    legs: i && i.settlement ? `${i.settlement.reservationCancelled}/${i.settlement.authorizationSettled}` : "none",
    captureRows: caps.length, capture: caps[0] ? `${caps[0].state}:${caps[0].attempts}:${caps[0].dispatched}:${caps[0].leased}` : null,
    queued: fresh.map((o) => `${o.op_type}:${o.state}:${o.attempts}`), claimHeld: claims.length === 1 && claims[0].held === true, openCases: cases[0] ? cases[0].n : null
  };
  const ok = facts.appliedEvents === 1 && facts.appliedEventType === ABORT_REASON && facts.appliedVersion === applied
    && facts.transition === `reservation_confirmed>capture_failed:${ABORT_REASON}:admin:${applied}`
    && facts.intentState === "capture_failed" && facts.intentReason === ABORT_REASON && facts.intentVersion === applied && facts.piMatches && facts.reservationMatches
    && facts.legs === "false/false" && facts.captureRows === 1 && facts.capture === "pending:0:false:false"
    && JSON.stringify(facts.queued) === JSON.stringify(ABORT_QUEUED.map((x) => `${x}:0`)) && facts.claimHeld && facts.openCases === 0;
  return { ok, facts: freeze({ ...facts, queued: freeze([...facts.queued]) }) };
}

/** tri-state from OBSERVED rows only (see the header) */
function observedApplied(facts) {
  if (!facts || typeof facts.transition !== "string") return null;
  if (facts.appliedEvents === 1 && facts.appliedEventType === ABORT_REASON && facts.transition.startsWith(`reservation_confirmed>capture_failed:${ABORT_REASON}:`)) return true;
  if (facts.appliedEvents === 0 && facts.transition === "rows:0") return false;     // both OBSERVED absent at that read
  return null;
}
export async function runTestAbortBridge(input) {
  const out = { version: BRIDGE_VERSION, outcome: null, code: null, cleanupPermitted: false, operatorCoreInvocations: 0, requestHelperInvocations: null, operatorOutcome: null,
    startAck: null, receiptAck: null, trustedHead: null, receiptLanding: "NOT_ATTEMPTED", postcheck: null, dbAbortApplied: null };
  const done = (outcome, code = null) => { out.outcome = outcome; out.code = code; return freeze({ ...out }); };
  // ---- synchronous binding (before any await) -------------------------------------------------------------------------------------
  const inp = dataProps(input, INPUT_KEYS);
  if (!inp || !REQUIRED.every((k) => k in inp)) return done("REFUSED_BEFORE_START", "INPUT_INVALID");
  const br = bindManifestV2(inp.manifest);
  if (!br.ok) return done("REFUSED_BEFORE_START", "MANIFEST_INVALID");
  const b = br.binding;
  if (b.phases.testAbortAfterReservation !== true || b.phases.capture !== false || b.phases.recording !== false) return done("REFUSED_BEFORE_START", "MANIFEST_NOT_ABORT_PLAN");
  const e = bindAbortExpectation(inp.operator);
  if (!e || e.planHash !== abortPlanHash(e)) return done("REFUSED_BEFORE_START", "OPERATOR_EXPECTATION_INVALID");
  const f = b.facts;
  if (e.intentId !== b.identity.intentId || e.listingId !== f.listingId || e.currency !== f.currency || e.from !== f.arrival || e.to !== f.departure || e.guests !== f.guests
    || e.finalTotalMinor !== f.amountMinor || e.authorizedMinor !== f.amountMinor) return done("REFUSED_BEFORE_START", "OPERATOR_MANIFEST_MISMATCH");
  const jm = methods(inp.journal, ["append", "read"]); const gm = methods(inp.guard, ["observe", "now"]);
  if (!jm || !gm) return done("REFUSED_BEFORE_START", "CAPABILITY_INVALID");
  const guard = freeze({ observe: (d, s) => gm.observe(d, s), now: () => gm.now() });
  const head = headCopy(inp.trustedHead);
  if (!head) return done("REFUSED_BEFORE_START", "TRUSTED_HEAD_INVALID");
  out.trustedHead = head;
  const env = envCopy(inp.env);
  if (!env) return done("REFUSED_BEFORE_START", "ENV_INVALID");
  if (!Number.isSafeInteger(inp.now) || inp.now < 0) return done("REFUSED_BEFORE_START", "CLOCK_INVALID");
  const now = inp.now; const pool = inp.pool;
  let opDeps = undefined;
  if (inp.operatorDeps !== undefined) { const d = dataProps(inp.operatorDeps, ["requestTestAbort", "afterReply"]); if (!d) return done("REFUSED_BEFORE_START", "INPUT_INVALID"); opDeps = freeze({ ...d }); }
  const manifest = b.manifest;                                        // the VALIDATED FROZEN copy: never the caller's object after an await
  // ---- (1) read + anchor the journal ------------------------------------------------------------------------------------------------
  const rd = await bounded(guard, BRIDGE_LIMITS.journalMs, () => jm.read());
  if (rd.kind !== "fulfilled") return done("REFUSED_BEFORE_START", `JOURNAL_READ_${rd.kind === "rejected" ? "REJECTED" : rd.code}`.slice(0, 48));
  const rr = dataProps(rd.value, ["records", "tail"]);
  if (!rr || rr.tail !== "complete") return done("REFUSED_BEFORE_START", "JOURNAL_READ_INVALID");
  const jf = journalFactsV2(rr.records, manifest, { trustedHead: head });
  if (!jf.ok) return done("REFUSED_BEFORE_START", `JOURNAL_${jf.code}`.slice(0, 48));
  if (!jf.anchored || jf.status !== "IN_PROGRESS" || !jf.facts.abortReady) return done("REFUSED_BEFORE_START", "JOURNAL_NOT_ABORT_READY");
  // the reservation id is the operator's; the journal holds no provider id — requestTestAbort binds it to the DATABASE intent authoritatively
  const reservationId = e.reservationId;
  const abort = freeze({ eventId: testAbortEventId(e.intentId, e.paymentIntentId, reservationId), planHash: e.planHash, expectedVersion: e.expectedVersion,
    paymentIntentId: e.paymentIntentId, reservationId });
  const common = (seq, prevHash, event) => ({ v: RECORD_VERSION_V2, seq, prevHash, ...b.identity, at: now, event });
  // ---- (2) start record, exact ACK before ANY helper call ------------------------------------------------------------------------
  const startRec = freeze({ ...common(head.seq + 1, head.hash, "ABORT_REQUEST_STARTED"), abort });
  const sa = await bounded(guard, BRIDGE_LIMITS.journalMs, () => jm.append(startRec));
  if (sa.kind !== "fulfilled" || !ackOk(sa.value, startRec)) return done("STOPPED_START_UNACKED", sa.kind === "fulfilled" ? "ACK_INVALID" : sa.kind === "rejected" ? "APPEND_REJECTED" : sa.code);
  out.startAck = freeze({ seq: startRec.seq, hash: recordHashV2(startRec) });
  out.trustedHead = out.startAck;
  // ---- (3) the accepted operator core, at most ONCE, bounded; never resent --------------------------------------------------------
  const ex = await bounded(guard, BRIDGE_LIMITS.abortMs, () => { out.operatorCoreInvocations += 1; return executeOperatorAbort(pool, e, { now, env, ...(opDeps ? { deps: opDeps } : {}) }); });
  /** bounded READ-ONLY diagnostics; the tri-state dbAbortApplied comes ONLY from what was observed */
  const diag = async () => {
    const pc = await bounded(guard, BRIDGE_LIMITS.postcheckMs, () => postcheck(pool, e, reservationId));
    out.postcheck = pc.kind === "fulfilled" ? pc.value.facts : null;
    out.dbAbortApplied = observedApplied(out.postcheck);
  };
  if (ex.kind !== "fulfilled") {
    if (ex.started === false && out.operatorCoreInvocations === 0) return done("STOPPED_BEFORE_OPERATOR", ex.code);   // the core was never started
    await diag(); return done("ABORT_OUTCOME_UNKNOWN", ex.kind === "rejected" ? "HELPER_REJECTED" : ex.code);
  }
  const xo = ex.value && typeof ex.value.outcome === "string" ? ex.value.outcome : null;
  out.operatorOutcome = xo;
  out.requestHelperInvocations = ex.value && Number.isSafeInteger(ex.value.invocations) && ex.value.invocations >= 0 && ex.value.invocations <= 1 ? ex.value.invocations : null;
  // the deterministic abort already exists (the core's precheck saw it; it sent NOTHING): never adopted, never a "refusal that nothing exists"
  if (xo === "NOT_EXECUTED_ALREADY_REQUESTED") { await diag(); return done("ABORT_NOT_THIS_RUN", "ALREADY_REQUESTED_OUTSIDE_HANDSHAKE"); }
  if (xo === "DUPLICATE_RECONCILED") { await diag(); return done("ABORT_NOT_THIS_RUN", "DUPLICATE_OUTSIDE_HANDSHAKE"); }
  if (xo === "REFUSED" || (xo && xo.startsWith("NOT_EXECUTED_"))) { await diag(); return done("ABORT_REFUSED", typeof ex.value.code === "string" ? ex.value.code.slice(0, 48) : null); }
  if (xo !== "REQUESTED") { await diag(); return done("ABORT_OUTCOME_UNKNOWN", xo || "HELPER_RESULT_INVALID"); }
  // ---- (4) bounded READ-ONLY postcheck: exact applied event / transition / state / pristine capture / queued obligations / claim ------
  const pc = await bounded(guard, BRIDGE_LIMITS.postcheckMs, () => postcheck(pool, e, reservationId));
  if (pc.kind !== "fulfilled") return done("ABORT_OUTCOME_UNKNOWN", `POSTCHECK_${pc.kind === "rejected" ? "REJECTED" : pc.code}`.slice(0, 48));
  out.postcheck = pc.value.facts;
  out.dbAbortApplied = observedApplied(out.postcheck);
  if (!pc.value.ok) return done("ABORT_POSTCHECK_FAILED", "POSTCHECK_MISMATCH");
  // ---- (5) receipt, exact ACK before cleanup is permitted ----------------------------------------------------------------------------
  const receipt = freeze({ appliedVersion: e.expectedVersion + 1, state: "capture_failed", reason: ABORT_REASON, capture: freeze({ state: "pending", attempts: 0, dispatched: false }),
    queued: ABORT_QUEUED, claimHeld: true });
  const recRec = freeze({ ...common(head.seq + 2, out.startAck.hash, "ABORT_ACCEPTED"), abort, receipt });
  const ra = await bounded(guard, BRIDGE_LIMITS.journalMs, () => jm.append(recRec));
  if (ra.kind !== "fulfilled" || !ackOk(ra.value, recRec)) {
    // the trusted head stays at the start ACK; a receipt MAY already be stored (late / landed / bad ACK): never claimed absent, never deleted
    // (a rejected append is NOT proof of absence either: only a never-started append is reported as not attempted)
    out.receiptLanding = ra.started === false ? "NOT_ATTEMPTED" : "UNACKED_MAY_HAVE_LANDED";
    return done("STOPPED_RECEIPT_UNACKED", ra.kind === "fulfilled" ? "ACK_INVALID" : ra.kind === "rejected" ? "APPEND_REJECTED" : ra.code);
  }
  out.receiptAck = freeze({ seq: recRec.seq, hash: recordHashV2(recRec) });
  out.trustedHead = out.receiptAck; out.receiptLanding = "ACKED";
  out.cleanupPermitted = true;
  return done("ABORT_ACCEPTED_JOURNALED");
}
