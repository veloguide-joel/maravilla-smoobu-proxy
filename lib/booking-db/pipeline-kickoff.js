// lib/booking-db/pipeline-kickoff.js — Stage E7 C107 / C108 (OFFLINE): the separately gated CONSUMER of durable pipeline kickoff requests
// (migration 0024). SHIPPED CLOSED: KICKOFF_CONSTANTS.dispatchEnabled is FALSE and no dispatcher exists in this repository; a caller must
// inject both an open constants object and a `dispatch` function (tests inject a FAKE). No GitHub transport, token, environment variable or
// network access exists here.
//
// CONNECTION CONTRACT (C108-F1): the first argument must be a POOL (connect() → a fresh pooled client); a checked-out client or any other
// query object is refused before any read. The consumer OWNS every transaction it relies on: on its own dedicated connection it first
// proves a clean boundary in the database (this statement is its own autocommit transaction: now() = statement_timestamp() and no
// transaction id assigned), then BEGIN → claim → COMMIT, and only a successful COMMIT reply admits the dispatch. It never commits, joins
// or inherits caller-owned work. Any error or lost reply around the claim / COMMIT destroys that connection (release(true)) and dispatches
// NOTHING; if the COMMIT did land, the row is claimed and human-owned (never re-claimed, never re-dispatched).
//
// ONE invocation handles at most ONE request:
//   1. closed / no dispatcher / not a pool → refuse BEFORE any read;
//   2. a FRESH server read of the request row and its intent (never a client value, never a cached state);
//   3. consumer admission (scope, exclusions, cutoff, state / version / ref / PI / amount / USD / livemode / listing, leases, open cases,
//      unsettled operations) → a refusal is recorded durably (requested → refused, committed by the consumer) and nothing is dispatched;
//   4. the EXACT workflow inputs + real plan hash of the pinned reviewed ENABLE revision (lib/checkout/pipeline-kickoff-plan.js);
//   5. booking.claim_pipeline_kickoff in the consumer's OWN transaction — ONE winner, every binding and the exact inputs re-proved against
//      the LOCKED intent row — then COMMIT; the connection is released clean before the dispatch;
//   6. the injected dispatch, invoked ONCE with the stored inputs, bounded by dispatchTimeoutMs;
//   7. booking.settle_pipeline_kickoff in a NEW owned transaction: { accepted: true } → dispatch_accepted; { notSent: true, code } →
//      dispatch_refused; ANYTHING else (throw, timeout, malformed / lost reply) → dispatch_unknown. All three are terminal. A lost settle /
//      COMMIT reply may have committed or not (the row is claimed OR terminal); either way it is human-owned and never re-dispatched.
// A dispatch only hands the bound inputs to the reviewed workflow, which still runs on main only behind the normal `e7-readonly-probe`
// reviewer gate and performs its own fresh Stripe proofs / refund veto / lock / seal / budgets / continuation / durable checkEnd. A handoff
// is NOT an execution, NOT a completion, and HTTP acceptance is NOT a booking: the intent state and its public status are untouched here.
import { loadIntent } from "./repo.js";
import { kickoffDispatch, KickoffPlanRefusal, KICKOFF_SCOPE, PINNED_REVISION } from "../checkout/pipeline-kickoff-plan.js";

const freeze = Object.freeze;
export const KICKOFF_CONSTANTS = freeze({
  dispatchEnabled: false,                                   // SHIPPED CLOSED
  workflow: PINNED_REVISION.workflowFile, ref: "main",      // main only; the workflow's own environment gate is unchanged
  dispatchTimeoutMs: 30000
});
const WORKER_RE = /^[A-Za-z0-9._:-]{1,100}$/;
const CODE_RE = /^[A-Z0-9_:]{1,96}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const codeOf = (v, fb) => (typeof v === "string" && CODE_RE.test(v) ? v : fb);

/** the request row + the facts the consumer admission needs, read fresh (no lock; the claim re-proves everything under locks) */
export async function readKickoffFacts(q, intentId) {
  const r = (await q.query(`SELECT intent_id::text AS intent_id, ref, authorized_version, payment_intent_id, amount_minor::text AS amount_minor, currency,
      listing_id, state, to_char(date_trunc('milliseconds', intent_created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS not_before
      FROM booking.pipeline_kickoff_requests WHERE intent_id = $1`, [intentId])).rows[0] ?? null;
  if (!r) return { request: null };
  const intent = await loadIntent(q, intentId);
  const env = (await q.query("SELECT environment FROM booking.instance")).rows[0]?.environment ?? null;
  const cases = (await q.query("SELECT count(*)::int AS n FROM booking.reconciliation_cases WHERE intent_id = $1 AND status = 'open'", [intentId])).rows[0].n;
  const ops = (await q.query(`SELECT count(*)::int AS n FROM booking.external_operations WHERE intent_id = $1
      AND (state IN ('in_flight', 'outcome_unknown', 'escalated') OR op_type LIKE 'hostaway.%' OR lease_worker_id IS NOT NULL)`, [intentId])).rows[0].n;
  return { request: r, intent, env, openCases: cases, unsettledOps: ops };
}

/**
 * C147: fresh TEST-identity fence for the kickoff consumer. -> null | "KICKOFF_FENCE_" + one of:
 *   DATABASE_NOT_TEST            booking.instance is not exactly one 'test' row (missing / duplicated marker fails closed)
 *   INTENT_ENVIRONMENT_NOT_TEST  the intent row's environment is not 'test'
 *   INTENT_NOT_TEST_MODE         the intent's recorded payment is not livemode = false (also when absent / null)
 * Run (1) right after the fresh admission read, BEFORE admission / refuse / claim: a refusal returns FENCE:<code> with NO write (no
 * refuse_pipeline_kickoff, no claim) and no dispatch; and (2) after the claim COMMIT, immediately BEFORE the one dispatch: a refusal
 * returns FENCE_AFTER_CLAIM:<code> with no dispatch and no settle; the row stays claimed and human-owned (never re-claimed / re-dispatched).
 */
export const KICKOFF_FENCE_CODES = freeze(["KICKOFF_FENCE_DATABASE_NOT_TEST", "KICKOFF_FENCE_INTENT_ENVIRONMENT_NOT_TEST", "KICKOFF_FENCE_INTENT_NOT_TEST_MODE"]);
export async function kickoffTestFenceRefusal(q, intentId) {
  const inst = (await q.query("SELECT environment FROM booking.instance")).rows;
  if (inst.length !== 1 || inst[0].environment !== "test") return "KICKOFF_FENCE_DATABASE_NOT_TEST";
  const r = (await q.query("SELECT environment, payment_livemode FROM booking.intents WHERE id = $1", [intentId])).rows[0];
  if (!r || r.environment !== "test") return "KICKOFF_FENCE_INTENT_ENVIRONMENT_NOT_TEST";
  if (r.payment_livemode !== false) return "KICKOFF_FENCE_INTENT_NOT_TEST_MODE";
  return null;
}

/** consumer admission over FRESH facts → null | refusal code (the SQL claim re-proves the same facts under locks) */
export function kickoffAdmission(f, scope = KICKOFF_SCOPE) {
  const r = f.request; const i = f.intent;
  if (!r) return "NO_REQUEST";
  if (r.state !== "requested") return `NOT_REQUESTED:${String(r.state).toUpperCase()}`;
  if (f.env !== "test") return "NOT_TEST";
  if (!i) return "INTENT_NOT_FOUND";
  if (scope.excludedIntentIds.includes(r.intent_id)) return "HISTORICAL_TARGET";
  if (!Number.isSafeInteger(i.createdAt) || i.createdAt < Date.parse(scope.cutoff) || Date.parse(r.not_before) < Date.parse(scope.cutoff)
      || Date.parse(r.not_before) > i.createdAt) return "HISTORIC_INTENT";
  if (i.listingId !== scope.listingId || Number(r.listing_id) !== scope.listingId || scope.excludedListingIds.includes(i.listingId)) return "LISTING_NOT_SCOPED";
  if (i.status !== "payment_authorized") return "STATE_NOT_PAYMENT_AUTHORIZED";
  if (i.version !== Number(r.authorized_version)) return "VERSION_STALE";
  if (i.ref !== r.ref) return "REF_MISMATCH";
  if (!i.payment || i.payment.paymentIntentId !== r.payment_intent_id) return "PAYMENT_INTENT_MISMATCH";
  if (i.payment.livemode !== false) return "LIVEMODE_NOT_FALSE";
  const amt = Number(r.amount_minor);
  if (!i.price || i.price.currency !== scope.currency || r.currency !== scope.currency || i.price.finalTotalMinor !== amt || i.payment.amountMinor !== amt
      || (i.payment.capturedMinor ?? 0) !== 0) return "AMOUNT_MISMATCH";
  if (i.reservation || i.offlineChargeId) return "ALREADY_PROGRESSED";
  if (i.lease || i.dispatch) return "INTENT_LEASED";
  if (f.openCases !== 0) return "OPEN_CASE";
  if (f.unsettledOps !== 0) return "OPERATION_NOT_SETTLED";
  return null;
}

/** classify the injected dispatcher's reply: ONLY these two typed shapes are definite; anything else is UNKNOWN */
export function classifyDispatch(out) {
  if (isObj(out) && out.accepted === true && Object.keys(out).length === 1) return { outcome: "dispatch_accepted", code: "HANDOFF_ACCEPTED" };
  if (isObj(out) && out.notSent === true && Object.keys(out).length === 2 && typeof out.code === "string" && CODE_RE.test(out.code)) {
    return { outcome: "dispatch_refused", code: `NOT_SENT:${out.code}`.slice(0, 96) };
  }
  return { outcome: "dispatch_unknown", code: "DISPATCH_REPLY_UNRECOGNIZED" };
}

/** the clean-boundary proof: true only when this statement runs as its OWN autocommit transaction on a session with no open transaction */
const CLEAN_SQL = "SELECT (now() = statement_timestamp() AND pg_catalog.pg_current_xact_id_if_assigned() IS NULL) AS clean";
const isPool = (p) => p !== null && typeof p === "object" && typeof p.connect === "function" && typeof p.release !== "function";

/**
 * runPipelineKickoffOnce(pool, { workerId, dispatch, intentId?, constants?, timer?, hooks? }) → frozen result
 *   { code, intentId, claimed, dispatchAttempted, outcome, settled }
 * pool = a POOL of the runtime app role (mv_booking_app): connect() → a fresh client. intentId optional: otherwise the oldest requested row.
 */
export async function runPipelineKickoffOnce(pool, opts = {}) {
  const c = opts.constants ?? KICKOFF_CONSTANTS;
  const res = { code: null, intentId: null, claimed: false, dispatchAttempted: false, outcome: null, settled: false };
  const done = (code) => { res.code = code; return freeze({ ...res }); };
  if (c.dispatchEnabled !== true) return done("KICKOFF_CLOSED");                      // before any read
  if (typeof opts.dispatch !== "function") return done("DISPATCH_ABSENT");
  if (typeof opts.workerId !== "string" || !WORKER_RE.test(opts.workerId)) return done("WORKER_INVALID");
  if (!isPool(pool)) return done("POOL_CONTRACT_REFUSED");                           // a client / transactional query object is never used
  const hooks = opts.hooks ?? {};
  let intentId = opts.intentId ?? null;
  if (intentId !== null && (typeof intentId !== "string" || !UUID_RE.test(intentId))) return done("INTENT_ID_INVALID");

  /** one OWNED connection: clean-boundary proof first; fn(client) runs; release clean only on success, destroy on any error */
  const owned = async (fn) => {
    const cl = await pool.connect();
    if (!cl || typeof cl.query !== "function" || typeof cl.release !== "function") throw new Error("POOL_CONTRACT");
    let ok = false;
    try {
      const b = (await cl.query(CLEAN_SQL)).rows[0];
      if (!b || b.clean !== true) { const e = new Error("TX_NOT_CLEAN"); e.code = "TX_NOT_CLEAN"; throw e; }
      const out = await fn(cl);
      ok = true;
      return out;
    } finally { try { cl.release(ok ? undefined : true); } catch { /* ignore */ } }
  };
  /** BEGIN → fn → COMMIT on an owned connection; returns fn's value only after the COMMIT replied; any error → destroyed, rethrown */
  const ownedTx = (fn) => owned(async (cl) => {
    await cl.query("BEGIN");
    try { const v = await fn(cl); await cl.query("COMMIT"); return v; }
    catch (e) { try { await cl.query("ROLLBACK"); } catch { /* the connection is destroyed anyway */ } throw e; }
  });

  // fresh admission (read-only, on an owned clean connection)
  let f; let why; let built = null; let fence0 = null;
  try {
    f = await owned(async (cl) => {
      if (intentId === null) {
        const next = (await cl.query("SELECT intent_id::text AS id FROM booking.pipeline_kickoff_requests WHERE state = 'requested' ORDER BY requested_at, intent_id LIMIT 1")).rows[0];
        if (!next) return null;
        intentId = next.id;
      }
      const facts = await readKickoffFacts(cl, intentId);
      if (facts.request) fence0 = await kickoffTestFenceRefusal(cl, intentId);       // C147 (1): fresh, before admission / any write
      return facts;
    });
  } catch (e) { return done(e && e.code === "TX_NOT_CLEAN" ? "TX_NOT_CLEAN" : "READ_FAILED"); }
  if (f === null) return done("NO_REQUEST");
  res.intentId = intentId;
  if (fence0 !== null) return done(`FENCE:${fence0}`);                                 // no refuse / claim write, no dispatch
  if (hooks.afterRead) await hooks.afterRead(f);
  why = kickoffAdmission(f);
  if (why === null) {
    try {
      built = kickoffDispatch({ intentId, ref: f.request.ref, authorizedVersion: Number(f.request.authorized_version), paymentIntentId: f.request.payment_intent_id,
        amountMinor: Number(f.request.amount_minor), currency: f.request.currency, listingId: Number(f.request.listing_id), notBefore: f.request.not_before });
    } catch (e) { if (e instanceof KickoffPlanRefusal) why = e.code; else throw e; }
  }
  if (why !== null) {
    if (!f.request || why.startsWith("NOT_REQUESTED")) return done(`SKIPPED:${why}`);
    let r;
    try { r = await ownedTx(async (cl) => (await cl.query("SELECT booking.refuse_pipeline_kickoff($1, $2) AS r", [intentId, codeOf(why, "ADMISSION_REFUSED")])).rows[0].r); }
    catch { return done("REFUSE_UNCERTAIN"); }
    return done(r === "REFUSED" ? `REFUSED:${why}` : `SKIPPED:${r}`);
  }

  // ONE claim in the consumer's OWN transaction: only a replied COMMIT admits the dispatch
  if (hooks.beforeClaim) await hooks.beforeClaim();
  let claim;
  try {
    claim = await ownedTx(async (cl) => (await cl.query("SELECT booking.claim_pipeline_kickoff($1, $2, $3, $4) AS r", [intentId, opts.workerId, built.planHash, built.inputs])).rows[0].r);
  } catch (e) { return done(e && e.code === "TX_NOT_CLEAN" ? "TX_NOT_CLEAN" : "CLAIM_UNCERTAIN"); }   // nothing dispatched; a landed COMMIT stays human-owned
  if (claim !== "CLAIMED") return done(claim.startsWith("REFUSED:") ? claim : `SKIPPED:${codeOf(claim, "NOT_CLAIMED")}`);
  res.claimed = true;
  if (hooks.afterClaim) await hooks.afterClaim();                                    // strictly after the known COMMIT
  let fence1;                                                                         // C147 (2): fresh, immediately before the ONE dispatch
  try { fence1 = await owned((cl) => kickoffTestFenceRefusal(cl, intentId)); } catch { fence1 = "KICKOFF_FENCE_READ_FAILED"; }
  if (fence1 !== null) return done(`FENCE_AFTER_CLAIM:${fence1}`);                    // no dispatch, no settle: claimed + human-owned

  // the ONE dispatch (bounded); everything but the two typed replies is UNKNOWN
  const setT = opts.timer?.set ?? setTimeout; const clearT = opts.timer?.clear ?? clearTimeout;
  const ac = new AbortController();
  let th = null;
  res.dispatchAttempted = true;
  let cls;
  try {
    const call = Promise.resolve().then(() => opts.dispatch(freeze({ workflow: c.workflow, ref: c.ref, inputs: built.inputs }), { signal: ac.signal }));
    const out = await Promise.race([call, new Promise((_, rej) => { th = setT(() => { ac.abort(); rej(new Error("DISPATCH_TIMEOUT")); }, c.dispatchTimeoutMs); })]);
    cls = classifyDispatch(out);
  } catch (e) {
    cls = { outcome: "dispatch_unknown", code: e && e.message === "DISPATCH_TIMEOUT" ? "DISPATCH_TIMEOUT" : "DISPATCH_THREW" };
  } finally { if (th !== null) clearT(th); }
  res.outcome = cls.outcome;
  if (hooks.beforeSettle) await hooks.beforeSettle(cls);
  let s;
  try { s = await ownedTx(async (cl) => (await cl.query("SELECT booking.settle_pipeline_kickoff($1, $2, $3, $4) AS r", [intentId, opts.workerId, cls.outcome, cls.code])).rows[0].r); }
  catch { return done("SETTLE_UNCERTAIN"); }                                          // claimed OR terminal: human-owned, never re-dispatched
  res.settled = s === "SETTLED";
  return done(res.settled ? cls.code : `SETTLE_REFUSED:${codeOf(s, "UNKNOWN")}`);
}
