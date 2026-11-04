// scripts/e7-connected/run-core.mjs — E7 connected-test runner SLICE E: the offline core (contract §2.4, §6, §9.4, §12).
// Drives ONE existing synthetic payment_authorized booking through the REAL imported accepted workers, one bounded step at a time,
// using only the accepted foundations: A run-manifest, B run-guard, C run-facts, D run-journal (interface), the executor adapters.
//   * No CLI, no real transport, no credential loading, no ingress, no durable journal, no env / fs / fetch / timer of its own.
//   * The only SQL text here: the same-DB statement (§12.1) and the two advisory-lock statements (§12.2).
//   * Worker-owned SQL (each step's maintenance, claims, releaseWork, late evidence) runs on the caller's pools.app and is OUTSIDE
//     this module's disposal control; after a timeout or rejection it may still be running.
//   * A frozen snapshot is a basis, never a fence. The advisory lock coordinates compliant runners only.
import { types } from "node:util";
import { validateRunManifest } from "./run-manifest.mjs";
import { validateGuardDeps, createGuard, createLifecycle, createLedger, wrapExecutors, trackClient, LIMITS } from "./run-guard.mjs";
import { readRunSnapshot, readGuestBinding, deriveRecoveryCandidate } from "./run-facts.mjs";
import { projectActions, evaluateStart, validateRecord, recordHash, PHASE_END_STATES, GENESIS_HASH } from "./run-journal-memory.mjs";
import { createPhaseExecutors } from "./executor-adapters.mjs";
import { runOrchestratorStep, DEFAULT_TIMEOUTS } from "../../lib/booking-db/reservation-worker.js";
import { runCaptureStep, CAPTURE_DEFAULT_TIMEOUTS } from "../../lib/booking-db/capture-worker.js";
import { runRecordingStep, RECORDING_DEFAULT_TIMEOUTS } from "../../lib/booking-db/recording-worker.js";
import { runCleanupStep, CLEANUP_DEFAULT_TIMEOUTS } from "../../lib/booking-db/compensation-worker.js";

export const RUN_CORE_VERSION = "e7-run-core-v1";
export const LOCK_KEY = "e7-connected-runner";
export const SQL = Object.freeze({
  LOCK: "SELECT pg_try_advisory_lock(hashtext($1), 0) AS ok",
  UNLOCK: "SELECT pg_advisory_unlock(hashtext($1), 0) AS ok",
  SAME_DB: `SELECT i.environment, i.created_at::text AS created_at, current_database() AS db, pg_postmaster_start_time()::text AS started,
       inet_server_port() AS port,
       pg_has_role(current_user, 'mv_booking_report', 'MEMBER') AS is_report,
       pg_has_role(current_user, 'mv_booking_app', 'MEMBER') AS is_app,
       (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) AS privileged
  FROM booking.instance i`
});
/** §6.1 phase bounds (routine technical choice): step cap and monotonic budget */
export const PHASE_LIMITS = Object.freeze({
  reservation: Object.freeze({ maxSteps: 12, budgetMs: 15 * 60_000, stepBudgetMs: DEFAULT_TIMEOUTS.stepBudgetMs }),
  capture: Object.freeze({ maxSteps: 6, budgetMs: 10 * 60_000, stepBudgetMs: CAPTURE_DEFAULT_TIMEOUTS.stepBudgetMs }),
  recording: Object.freeze({ maxSteps: 6, budgetMs: 10 * 60_000, stepBudgetMs: RECORDING_DEFAULT_TIMEOUTS.stepBudgetMs }),
  cleanup: Object.freeze({ maxSteps: 8, budgetMs: 15 * 60_000, stepBudgetMs: CLEANUP_DEFAULT_TIMEOUTS.stepBudgetMs })
});
export const IDLE_WAIT_MS = 5_000;
export const P0_BUDGET_MS = 60_000;
const WORK_STATES = Object.freeze({ reservation: ["payment_authorized", "reservation_pending", "reservation_unknown"], capture: ["reservation_confirmed", "capture_unknown"],
  recording: ["payment_captured"], cleanup: ["reservation_failed", "capture_failed"] });
const WRITE_TYPES = Object.freeze({ "hostaway.create_reservation": "create", "stripe.capture_payment_intent": "capture", "hostaway.record_offline_charge": "record",
  "stripe.void_payment_intent": "void", "hostaway.cancel_reservation": "cancel" });
const KEY_RANK = Object.freeze({ null: 0, reservedNotConfirmed: 1, captured: 2, confirmed: 3 });
const OPTION_KEYS = Object.freeze(["attest", "clock", "intentId", "journal", "manifest", "monotonic", "pools", "signal", "timers", "transports", "trustedHead"]);

const freeze = Object.freeze;
const apply = Reflect.apply;
const getDesc = Object.getOwnPropertyDescriptor;
const getDescs = Object.getOwnPropertyDescriptors;
const getProto = Object.getPrototypeOf;
const OBJECT_PROTO = Object.prototype;
const NATIVE_ABORTED = getDesc(AbortSignal.prototype, "aborted").get;
const isFn = (f) => typeof f === "function" && !types.isProxy(f);

// ---- getter-free option helpers ---------------------------------------------------------------------------------------------------
const plainData = (o, keys) => {
  if (o === null || typeof o !== "object" || types.isProxy(o)) return null;
  const p = getProto(o); if (p !== OBJECT_PROTO && p !== null) return null;
  const d = getDescs(o); const ks = Reflect.ownKeys(d);
  if (ks.length !== keys.length || !ks.every((k) => typeof k === "string" && keys.includes(k) && "value" in d[k] && d[k].enumerable === true)) return null;
  return Object.fromEntries(keys.map((k) => [k, d[k].value]));
};
/** a DATA method found along the prototype chain without running any getter (pg clients / pools use prototype methods) */
function dataMethod(obj, name) {
  if (obj === null || typeof obj !== "object" || types.isProxy(obj)) return null;
  for (let o = obj, n = 0; o !== null && n < 8; o = getProto(o), n += 1) {
    if (types.isProxy(o)) return null;
    const d = getDesc(o, name);
    if (d === undefined) continue;
    return "value" in d && isFn(d.value) ? d.value : null;
  }
  return null;
}
const nativeAborted = (sig) => { try { return types.isProxy(sig) ? null : apply(NATIVE_ABORTED, sig, []); } catch { return null; } };
const rowsOf = (res) => { const d = res !== null && typeof res === "object" ? getDesc(res, "rows") : undefined; return d && "value" in d && Array.isArray(d.value) ? d.value : null; };

// ---- facts helpers ----------------------------------------------------------------------------------------------------------------
function countWrites(facts) {
  const w = { cancel: 0, capture: 0, create: 0, record: 0, void: 0 };
  for (const o of facts.operations) { const k = WRITE_TYPES[o.opType]; if (k && o.dispatchedAt !== null) w[k] += 1; }
  return w;
}
const writeOps = (facts) => facts.operations.filter((o) => WRITE_TYPES[o.opType]);
const openCase = (facts) => facts.cases.some((c) => c.status === "open");
/** clarification 2: ANY in_flight / outcome_unknown / escalated write */
const uncertainWrite = (facts) => writeOps(facts).some((o) => o.state === "in_flight" || o.state === "outcome_unknown" || o.state === "escalated");
const maxKey = (a, b) => (KEY_RANK[String(b)] > KEY_RANK[String(a)] ? b : a);
/** §6.2 conservative cleanup key from acknowledged facts + the open phase (never suppressed by unused phases / false flags) */
function conservativeKey(facts, phase, unfinished, entryKey, effectsKnown) {
  let k = null;
  if (facts) {
    const s = facts.intent.state;
    if (["reservation_unknown", "reservation_confirmed", "capture_unknown", "capture_failed"].includes(s)) k = maxKey(k, "reservedNotConfirmed");
    if (s === "payment_captured") k = maxKey(k, "captured");
    if (s === "confirmed") k = maxKey(k, "confirmed");
    for (const o of writeOps(facts)) {
      const possible = ["in_flight", "succeeded", "outcome_unknown", "escalated"].includes(o.state) || (o.dispatchedAt !== null && !["failed_definite", "superseded"].includes(o.state));
      if (!possible) continue;
      if (o.opType === "hostaway.create_reservation") k = maxKey(k, "reservedNotConfirmed");
      if (o.opType === "stripe.capture_payment_intent") k = maxKey(k, "captured");
      if (o.opType === "hostaway.record_offline_charge") k = maxKey(k, "confirmed");
    }
  }
  if (unfinished) k = maxKey(k, phase === "reservation" ? "reservedNotConfirmed" : phase === "capture" ? "captured" : phase === "recording" ? "confirmed" : entryKey);
  if (phase === "cleanup") k = maxKey(k, entryKey);
  // §6.2: null only when effects are known, no create op is beyond `pending`, and no reservation-phase work is outstanding / rejected
  const createBeyondPending = !facts || facts.operations.some((o) => o.opType === "hostaway.create_reservation" && o.state !== "pending");
  if (k === null && S_PHASE_STARTED.has(phase) && (!effectsKnown || createBeyondPending || (phase === "reservation" && unfinished))) k = "reservedNotConfirmed";
  return k;
}
const S_PHASE_STARTED = new Set(["reservation", "capture", "recording", "cleanup"]);

/** checkSameDatabase(s1Rows, s2Rows) → frozen { ok:true } | frozen { ok:false, code } — §12.1 pure comparison of the two statement
 *  results (S1 on the report lock client, S2 on an app client). Accidental-misconfiguration detection only, NOT a cluster identity. */
export function checkSameDatabase(a, b) {
  const one = (rows) => (Array.isArray(rows) && rows.length === 1 && rows[0] !== null && typeof rows[0] === "object" ? rows[0] : null);
  const x = one(a); const y = one(b);
  if (!x) return freeze({ ok: false, code: "MARKER_INVALID" });
  if (x.environment !== "test") return freeze({ ok: false, code: "DATABASE_NOT_TEST" });
  if (!(x.is_report === true && x.is_app === false && x.privileged === false)) return freeze({ ok: false, code: "ROLE_NOT_REPORT" });
  if (!y) return freeze({ ok: false, code: "MARKER_INVALID" });
  if (y.environment !== "test") return freeze({ ok: false, code: "DATABASE_NOT_TEST" });
  if (!(y.is_app === true && y.is_report === false && y.privileged === false)) return freeze({ ok: false, code: "ROLE_NOT_APP" });
  const same = ["created_at", "db", "started"].every((k) => typeof x[k] === "string" && x[k] === y[k])
    && ((Number.isInteger(x.port) && x.port === y.port) || (x.port === null && y.port === null));
  return same ? freeze({ ok: true }) : freeze({ ok: false, code: "POOLS_MISMATCH" });
}

/**
 * runConnectedTest(opts) → Promise<frozen RunResult> (contract §2.4). Never rejects for caller input; returns a bounded result and
 * leaves disposal to result.finalize() (= lifecycle.finalize(), B's single memoized promise; it may stay pending forever).
 */
export async function runConnectedTest(input) {
  // ---------------- options (one getter-free snapshot, before any await) ----------------
  let o;
  try { o = plainData(input, OPTION_KEYS); } catch { o = null; }
  const invalid = () => freeze({ ok: false, outcome: "REFUSED", stopCode: "OPTIONS_INVALID", phase: "P0", finalize: () => Promise.resolve(freeze({ quiescence: "observed", lockRelease: "not_acquired" })) });
  if (!o) return invalid();
  const mv = validateRunManifest(o.manifest);
  if (!mv.ok) return freeze({ ...invalid(), stopCode: mv.code });
  const manifest = mv.manifest;
  if (o.intentId !== manifest.intentId) return freeze({ ...invalid(), stopCode: "INTENT_MISMATCH" });
  let pools, journalAppend, journalRead;
  try {
    pools = plainData(o.pools, ["app", "report"]);
    if (!pools || !dataMethod(pools.app, "connect") || !dataMethod(pools.report, "connect")) return invalid();
    journalAppend = dataMethod(o.journal, "append"); journalRead = dataMethod(o.journal, "read");
    if (!journalAppend || !journalRead || !isFn(o.attest) || !isFn(o.clock) || nativeAborted(o.signal) === null) return invalid();
    const tr = plainData(o.transports, ["hostaway", "stripe"]);
    if (!tr || !dataMethod(tr.hostaway, "send") || !dataMethod(tr.stripe, "send")) return invalid();
    if (o.trustedHead !== null && !plainData(o.trustedHead, ["hash", "seq"])) return invalid();
  } catch { return invalid(); }
  const gd = validateGuardDeps({ monotonic: o.monotonic, timers: o.timers });
  if (!gd.ok) return invalid();
  const guard = createGuard(gd.deps);
  const lc = createLifecycle({ guard });
  const { journal, attest, clock, signal, transports } = o;
  const identity = freeze({ runId: manifest.runId, intentId: manifest.intentId, manifestHash: mv.hash, baselineCommit: manifest.baselineCommit });

  // ---------------- run state ----------------
  const S = { phase: "P0", started: false, head: { seq: 0, hash: GENESIS_HASH }, journalOk: true, journalTerminal: "not_attempted", anchored: false,
    lastFacts: null, countsSeq: 0, rejected: false, stale: false, lockLostEarly: false, lockClient: null, lockTracker: null, outcome: null, unfinished: false,
    reservationExisted: false, phaseDeadline: Infinity, cleanupEntryKey: null, cause: null };
  const stop = (code) => { lc.stop(code); if (!S.cause) S.cause = code; return { stop: code }; };
  const dbStop = (code) => { lc.markDbFamily(); S.stale = true; return stop(code); };
  const nowOr = () => { const n = guard.now(); return n.ok ? n.value : null; };
  /** absolute deadline: now + ms, capped by the phase budget (clarification 1); null ⇒ the guard cannot read time */
  const deadline = (ms) => { const n = nowOr(); return n === null ? null : Math.min(n + ms, S.phaseDeadline); };
  const guardCode = () => guard.broken() || "GUARD_MONOTONIC_INVALID";
  const observeMapped = async (ms, start, codes) => {
    const d = deadline(ms);
    if (d === null) return { fail: guardCode() };
    const r = await guard.observe(d, start);
    if (r.kind === "fulfilled") return { value: r.value };
    if (r.kind === "rejected") return { fail: codes.rejected };
    if (r.kind === "timeout") return { fail: codes.timeout };
    if (r.kind === "not_started") return { fail: r.code === "EXPIRED_BEFORE_START" ? "BUDGET_EXHAUSTED" : r.code };
    return { fail: r.code };
  };
  const businessNow = () => { try { const t = apply(clock, undefined, []); return Number.isFinite(t) && t >= 0 ? Math.trunc(t) : null; } catch { return null; } };
  const boundary = () => {
    const snap = lc.snapshot();
    if (snap.exclusion === "lost" || S.lockLostEarly) return stop("LOCK_LOST");
    const ab = nativeAborted(signal);
    if (ab === null) return stop("SIGNAL_INVALID");
    if (ab) return stop("CANCELLED");
    if (guard.broken()) return stop(guard.broken());
    return null;
  };

  // ---------------- clients (B ownership, §12.2) ----------------
  async function acquire(pool, onLoss) {
    const connect = dataMethod(pool, "connect");
    const d = deadline(LIMITS.CONNECT_MS);
    if (d === null) return { fail: guardCode() };
    const r = await lc.observeConnect(d, () => apply(connect, pool, []), (c) => { const rel = dataMethod(c, "release"); if (rel) { try { apply(rel, c, [true]); } catch { /* local */ } } });
    if (r.kind !== "fulfilled") return { fail: r.kind === "timeout" ? "TIMEOUT_DB_CONNECT" : r.kind === "rejected" ? "DB_FAILURE" : r.code === "EXPIRED_BEFORE_START" ? "BUDGET_EXHAUSTED" : r.code };
    const c = r.client;
    const on = dataMethod(c, "on"); const off = dataMethod(c, "removeListener"); const rel = dataMethod(c, "release"); const query = dataMethod(c, "query");
    if (!on || !off || !rel || !query) { if (rel) { try { apply(rel, c, [true]); } catch { /* local */ } } return { fail: "DB_FAILURE" }; }
    const t = trackClient({ subscribe: (e, h) => apply(on, c, [e, h]), unsubscribe: (e, h) => apply(off, c, [e, h]), destroy: () => apply(rel, c, [true]), onLoss });
    if (!t.ok) return { fail: "DB_FAILURE" };
    return { client: c, query, tracker: t.tracker, release: () => { t.tracker.dispose(); if (t.tracker.state() === "open") { try { apply(rel, c, []); } catch { t.tracker.destroy(); } } } };
  }
  const statement = (h, sql, params, ms = LIMITS.STATEMENT_MS) => observeMapped(ms, () => apply(h.query, h.client, [sql, params]), { rejected: "DB_FAILURE", timeout: "TIMEOUT_DB_READ" });
  /** one C report snapshot on a fresh client; disposition honoured exactly */
  async function snapshot() {
    const h = await acquire(pools.report, () => {});
    if (h.fail) return dbStop(h.fail);
    const d = deadline(LIMITS.SNAPSHOT_MS);
    if (d === null) { h.tracker.destroy(); return stop(guardCode()); }
    const r = await readRunSnapshot({ client: h.client, intentId: identity.intentId, guard, deadline: d });
    if (r.ok) { h.release(); S.lastFacts = r.facts; S.countsSeq = S.head.seq; return { facts: r.facts }; }
    if (r.clientDisposition === "destroy") { h.tracker.destroy(); return dbStop(r.code); }
    h.release();
    if (r.failure === "not_started") return stop(r.code === "SNAPSHOT_BUDGET_EXHAUSTED" ? "BUDGET_EXHAUSTED" : r.code);
    return stop(r.code);                                      // acknowledged refusal (marker / role / malformed / cap)
  }
  async function guest() {
    const h = await acquire(pools.app, () => {});
    if (h.fail) return dbStop(h.fail);
    const d = deadline(LIMITS.STATEMENT_MS);
    if (d === null) { h.tracker.destroy(); return stop(guardCode()); }
    const r = await readGuestBinding({ client: h.client, intentId: identity.intentId, guard, deadline: d });
    if (r.ok) { h.release(); return { guest: r.guest }; }
    if (r.clientDisposition === "destroy") { h.tracker.destroy(); return dbStop(r.code); }
    h.release();
    return stop(r.code);
  }

  // ---------------- journal (D interface; §12.3) ----------------
  async function append(event, body) {
    if (!S.journalOk) return false;
    const at = businessNow();
    if (at === null) { S.journalOk = false; stop("CLOCK_INVALID"); return false; }
    const rec = { v: 1, seq: S.head.seq + 1, prevHash: S.head.hash, ...identity, at, event, ...body };
    const vr = validateRecord(rec);
    if (!vr.ok) { S.journalOk = false; stop("JOURNAL_RECORD_INVALID"); return false; }
    const terminal = event === "RUN_STOPPED" || event === "RUN_ENDED";
    const r = await observeMapped(LIMITS.JOURNAL_MS, () => apply(journalAppend, journal, [vr.record]), { rejected: "JOURNAL_FAILURE", timeout: "TIMEOUT_JOURNAL" });
    const expect = recordHash(vr.record);
    const ackOk = !r.fail && r.value !== null && typeof r.value === "object" && getDesc(r.value, "seq")?.value === rec.seq && getDesc(r.value, "hash")?.value === expect;
    if (!ackOk) {
      S.journalOk = false;                                   // no later append, ever (a late landing stays uncertain)
      if (terminal) S.journalTerminal = "unknown"; else stop(r.fail || "JOURNAL_FAILURE");
      return false;
    }
    S.head = { seq: rec.seq, hash: expect };
    if (terminal) S.journalTerminal = "acknowledged";
    return true;
  }
  const attestCheckpoint = async (checkpoint) => {
    const request = freeze({ checkpoint, runId: identity.runId, intentId: identity.intentId, manifestHash: identity.manifestHash });
    const r = await observeMapped(LIMITS.ATTEST_MS, () => apply(attest, undefined, [checkpoint, request, { signal }]), { rejected: "ATTESTATION_FAILED", timeout: "TIMEOUT_ATTEST" });
    if (r.fail) return stop(r.fail);
    const v = plainData(r.value, ["evidenceRef", "ok"]) || plainData(r.value, ["ok"]);
    if (!v || typeof v.ok !== "boolean") return stop("ATTESTATION_FAILED");
    if (!v.ok) return stop("OWNER_DECLINED");
    if (typeof v.evidenceRef !== "string") return stop("ATTESTATION_FAILED");
    const rec = validateRecord({ v: 1, seq: 1, prevHash: GENESIS_HASH, ...identity, at: 0, event: "ATTESTED", attestation: { checkpoint, evidenceRef: v.evidenceRef } });
    if (!rec.ok) return stop("ATTESTATION_FAILED");
    if (!(await append("ATTESTED", { attestation: { checkpoint, evidenceRef: v.evidenceRef } }))) return { stop: S.cause };
    return null;
  };

  // ---------------- result construction ----------------
  function result(outcomeKind, extra = {}) {
    const ls = lc.snapshot();
    const facts = S.lastFacts;
    return freeze({ ok: outcomeKind === "ENDED", outcome: S.outcome || outcomeKind, stopCode: S.cause, phase: S.phase, manifestHash: identity.manifestHash,
      journalSeq: S.head.seq, journalTerminal: S.journalTerminal, anchored: S.anchored,
      writes: freeze(facts ? countWrites(facts) : { cancel: 0, capture: 0, create: 0, record: 0, void: 0 }), countsAsOf: freeze({ seq: S.countsSeq, stale: S.stale }),
      effectsKnown: !S.stale && ls.outstanding === "NONE" && !ls.dbFamily, outstanding: ls.outstanding, outstandingPhase: ls.outstandingPhase,
      tailObservable: ls.tailObservable, exclusion: ls.exclusion === "released" ? "held" : ls.exclusion,
      ownerCleanupRequired: null, finalize: () => lc.finalize(), ...extra });
  }
  /** a pre-RUN_STARTED refusal (no journal record, no worker) */
  const refused = () => result("REFUSED", { outcome: "REFUSED", ownerCleanupRequired: null });
  /** a STOP after RUN_STARTED: one terminal append (if the journal is healthy), conservative key */
  async function stopped() {
    const ls = lc.snapshot();
    const unfinished = S.unfinished || S.rejected || ls.outstanding !== "NONE";
    // §6.2 effectsKnown: false on outstanding work, stale counts, a rejected step, an unknown write, or an open logged step (D)
    const effectsKnown = !unfinished && !S.stale && !ls.dbFamily && !(S.lastFacts && uncertainWrite(S.lastFacts));
    const k = conservativeKey(S.lastFacts, S.phase, unfinished, S.cleanupEntryKey, effectsKnown);
    if (S.journalOk) {
      await append("RUN_STOPPED", { code: S.cause || "STOPPED", outstanding: ls.outstanding, effectsKnown, exclusion: ls.exclusion === "lost" ? "lost" : "held",
        ownerCleanupRequired: k, writes: S.lastFacts ? countWrites(S.lastFacts) : { cancel: 0, capture: 0, create: 0, record: 0, void: 0 } });
    }
    return result("STOPPED", { outcome: "STOPPED", ownerCleanupRequired: k, effectsKnown });
  }
  async function ended(outcome, key) {
    const ls = lc.snapshot();
    S.outcome = outcome;
    const ok = await append("RUN_ENDED", { outcome, outstanding: "NONE", effectsKnown: true, exclusion: ls.exclusion === "lost" ? "lost" : "held", ownerCleanupRequired: key,
      writes: countWrites(S.lastFacts) });
    if (!ok && S.journalTerminal !== "unknown") { S.outcome = null; return stopped(); }
    return result("ENDED", { outcome, ownerCleanupRequired: key, ok: S.journalTerminal === "acknowledged" });
  }

  // =======================================================================================================================
  // P0 — lock, same DB, journal start rule, eligibility (§12.1, §12.2, §6.1)
  S.phaseDeadline = (nowOr() ?? 0) + P0_BUDGET_MS;
  {
    const h = await acquire(pools.report, () => { S.lockLostEarly = true; lc.lockLost(); });
    if (h.fail) { stop(h.fail); lc.markDbFamily(); return refused(); }
    S.lockClient = h;
    const lr = await statement(h, SQL.LOCK, [LOCK_KEY], LIMITS.LOCK_ACQUIRE_MS);
    if (lr.fail) { h.tracker.destroy(); lc.markDbFamily(); stop(lr.fail === "TIMEOUT_DB_READ" ? "TIMEOUT_DB_LOCK" : lr.fail); return refused(); }
    const rows = rowsOf(lr.value);
    if (!rows || rows.length !== 1 || rows[0].ok !== true) { h.tracker.destroy(); stop(rows && rows[0]?.ok === false ? "RUN_LOCK_HELD" : "DB_FAILURE"); return refused(); }
    // clarification 5: a loss detected before attachLock prevents everything later; destroy exactly once (tracker is idempotent)
    if (h.tracker.state() !== "open" || S.lockLostEarly) { h.tracker.destroy(); stop("LOCK_LOST"); return refused(); }
    lc.attachLock({ unlock: () => apply(h.query, h.client, [SQL.UNLOCK, [LOCK_KEY]]).then((res) => { const r2 = rowsOf(res); return !!r2 && r2.length === 1 && r2[0].ok === true; }),
      destroy: () => { h.tracker.destroy(); } });
  }
  {
    const s1 = await statement(S.lockClient, SQL.SAME_DB, []);
    if (s1.fail) { lc.markDbFamily(); stop(s1.fail); return refused(); }
    const a = rowsOf(s1.value);
    const c1 = checkSameDatabase(a, [{ environment: "test", is_app: true, is_report: false, privileged: false }]);
    if (!c1.ok && c1.code !== "POOLS_MISMATCH") { stop(c1.code); return refused(); }      // S1 refusals before any app client
    const app = await acquire(pools.app, () => {});
    if (app.fail) { lc.markDbFamily(); stop(app.fail); return refused(); }
    const s2 = await statement(app, SQL.SAME_DB, []);
    if (s2.fail) { app.tracker.destroy(); lc.markDbFamily(); stop(s2.fail); return refused(); }
    const b = rowsOf(s2.value);
    app.release();
    const c2 = checkSameDatabase(a, b);
    if (!c2.ok) { stop(c2.code); return refused(); }
  }
  {
    const rb = boundary(); if (rb) return refused();
    const jr = await observeMapped(LIMITS.JOURNAL_MS, () => apply(journalRead, journal, []), { rejected: "JOURNAL_FAILURE", timeout: "TIMEOUT_JOURNAL" });
    if (jr.fail) { stop(jr.fail); return refused(); }
    const v = evaluateStart(jr.value, identity, o.trustedHead === null ? undefined : { trustedHead: o.trustedHead });
    S.anchored = v.anchored === true;
    if (!v.ok) { stop(v.code); return refused(); }
  }
  {
    const rb = boundary(); if (rb) return refused();
    const s = await snapshot();
    if (s.stop) return refused();
    const f = s.facts; const i = f.intent; const m = manifest;
    const cand = deriveRecoveryCandidate(f);
    if (!cand.ok && ["PROTECTED_REFERENCE", "FACT_MALFORMED", "FACTS_INCONSISTENT"].includes(cand.code)) { stop(cand.code); return refused(); }   // protected scan first
    if (i.state !== "payment_authorized" || writeOps(f).length > 0 || openCase(f)) { stop("INTENT_NOT_ELIGIBLE"); return refused(); }
    if (!cand.ok && cand.code !== "NO_CANDIDATE") { stop(cand.code); return refused(); }
    if (cand.ok) { stop("INTENT_NOT_ELIGIBLE"); return refused(); }
    const same = i.ref === m.expectedRef && i.listingId === m.listing.id && i.from === m.stay.arrival && i.to === m.stay.departure && i.guests === m.stay.guests
      && i.finalTotalMinor === m.amountMinor && i.rateBps === m.pricing.rateBps && i.currency === m.listing.currency && typeof i.stripePaymentIntentId === "string";
    if (!same) { stop("INTENT_IDENTITY_MISMATCH"); return refused(); }
  }
  if (!(await append("RUN_STARTED", {}))) return result("STOPPED", { outcome: "STOPPED", ownerCleanupRequired: null });
  S.started = true;
  S.phaseDeadline = Infinity;                                 // between phases: each await is bounded by its own LIMITS duration only

  // P1 — the pre-create gate
  S.phase = "P1";
  { const rb = boundary(); if (rb) return stopped(); }
  { const a = await attestCheckpoint("CALENDAR_BASELINE"); if (a && a.stop) return stopped(); }

  // =======================================================================================================================
  // Phases P2–P5
  const m = manifest; const id = m.listing.id;
  const adapterConfig = () => ({ allowedListingIds: [id], refFieldId: m.listing.refFieldId, channelId: 2000, currency: "USD" });
  const baseEnv = { VERCEL_ENV: "development" };
  const common = (i) => ({ listingId: i.listingId, arrivalDate: i.from, departureDate: i.to, ref: i.ref });     // exactly BINDING_KEYS' 4 common keys

  /** build ONE step's frozen binding, executors and worker call from that step's frozen pre-step facts (§12.4) */
  async function prepare(phase, facts) {
    const i = facts.intent;
    if (phase === "reservation") {
      const cand = deriveRecoveryCandidate(facts);
      if (!cand.ok && cand.code !== "NO_CANDIDATE") return stop(cand.code);
      const g = await guest(); if (g.stop) return g;
      const binding = { ...common(i), guests: i.guests, totalMinor: i.finalTotalMinor, currency: i.currency, refFieldId: m.listing.refFieldId, guest: g.guest,
        reservationId: cand.ok ? cand.id : null };
      const factoryPhase = cand.ok ? "reservation-recovery" : "reservation";
      return { factoryPhase, reservationId: binding.reservationId, binding, stripe: false,
        run: (executors) => runOrchestratorStep(pools.app, { workerId: "e7r-res", env: { ...baseEnv, MV_E7_RESERVATION_WORKER: "enabled", DIRECT_DISCOUNT_BPS: String(m.pricing.rateBps) },
          adapterConfig: adapterConfig(), listings: new Map([[id, { currency: "USD" }]]), executors, clock, intentId: identity.intentId }) };
    }
    if (phase === "capture") {
      const caps = facts.operations.filter((x) => x.opType === "stripe.capture_payment_intent");
      if (caps.length !== 1 || typeof caps[0].payload.providerIdempotencyKey !== "string" || typeof i.hostawayReservationId !== "string") return stop("STATE_UNEXPECTED");
      const binding = { ...common(i), reservationId: i.hostawayReservationId, accountId: m.stripeAccountId, paymentIntentId: i.stripePaymentIntentId, amountMinor: i.finalTotalMinor,
        captureIdempotencyKey: caps[0].payload.providerIdempotencyKey };
      return { factoryPhase: "capture", reservationId: binding.reservationId, binding, stripe: true,
        run: (executors) => runCaptureStep(pools.app, { workerId: "e7r-cap", env: { ...baseEnv, MV_E7_CAPTURE_WORKER: "enabled" }, adapterConfig: adapterConfig(),
          listings: new Map([[id, { currency: "USD" }]]), executors, clock, stripeAccountId: m.stripeAccountId, intentId: identity.intentId }) };
    }
    if (phase === "recording") {
      if (typeof i.hostawayReservationId !== "string" || !(i.capturedMinor > 0)) return stop("STATE_UNEXPECTED");
      const binding = { listingId: i.listingId, reservationId: i.hostawayReservationId, intentId: i.id, amountMinor: i.capturedMinor, paymentMethod: m.paymentMethod,
        accountRef: m.hostawayAccountLabel.accountRef, clientSnapshotId: m.hostawayAccountLabel.clientSnapshotId };
      const recCfg = { accountRef: m.hostawayAccountLabel.accountRef, channelId: 2000, currency: "USD", listingId: id, paymentMethod: m.paymentMethod, refFieldId: m.listing.refFieldId };
      return { factoryPhase: "recording", reservationId: binding.reservationId, binding, stripe: false,
        run: (executors) => runRecordingStep(pools.app, { workerId: "e7r-rec", env: { ...baseEnv, MV_E7_RECORDING_WORKER: "enabled" }, listings: new Map([[id, recCfg]]),
          executors, clock, intentId: identity.intentId }) };
    }
    const voids = facts.operations.filter((x) => x.opType === "stripe.void_payment_intent");
    const v = voids.at(-1);
    if (!v || typeof v.payload.providerIdempotencyKey !== "string") return stop("STATE_UNEXPECTED");
    const binding = { ...common(i), reservationId: i.hostawayReservationId ?? null, accountId: m.stripeAccountId, paymentIntentId: i.stripePaymentIntentId,
      voidIdempotencyKey: v.payload.providerIdempotencyKey };
    return { factoryPhase: "cleanup", reservationId: binding.reservationId, binding, stripe: true,
      run: (executors) => runCleanupStep(pools.app, { workerId: "e7r-cln", env: { ...baseEnv, MV_E7_COMPENSATION_WORKER: "enabled" }, adapterConfig: adapterConfig(),
        listings: new Map([[id, { currency: "USD", timeZone: m.listing.timeZone }]]), executors, clock, stripeAccountId: m.stripeAccountId, intentId: identity.intentId }) };
  }
  /** stop rules on any acknowledged facts (pre-step gate and post-step) */
  /** `strict` (before every capture / recording invocation, and after AIRBNB_BLOCKED): any open case, any in_flight / unknown / escalated
   *  write (clarification 2, the conservative reading of §6.1 vs §12.4). Always: C's protected-reference / malformed refusals. */
  function factStops(facts, strict) {
    const c = deriveRecoveryCandidate(facts);
    if (!c.ok && ["PROTECTED_REFERENCE", "FACT_MALFORMED", "FACTS_INCONSISTENT"].includes(c.code)) return stop(c.code);   // other codes: §12.4 binding
    if (strict && openCase(facts)) return stop("OPEN_CASE");
    if (strict && uncertainWrite(facts)) return stop("UNKNOWN_WRITE");
    return null;
  }
  const strictPhase = (phase) => phase === "capture" || phase === "recording";

  /** run one phase to an end state (→ { ended, facts }) or a stop (→ { stop }) */
  async function runPhase(phase) {
    S.phase = phase;
    const L = PHASE_LIMITS[phase];
    const n0 = nowOr(); if (n0 === null) return stop(guardCode());
    S.phaseDeadline = n0 + L.budgetMs;
    let basis = null;                                         // reusable ONLY directly after a step (no wait / attest in between)
    for (let step = 1; step <= L.maxSteps; step++) {
      const b0 = boundary(); if (b0) return b0;
      let facts = basis;
      if (!facts) { const s = await snapshot(); if (s.stop) return s; facts = s.facts; }
      basis = null;
      const fs = factStops(facts, strictPhase(phase)); if (fs) return fs;
      const st = facts.intent.state;
      if (!WORK_STATES[phase].includes(st) && !PHASE_END_STATES[phase].includes(st)) return stop("STATE_UNEXPECTED");
      const now = nowOr(); if (now === null) return stop(guardCode());
      if (now + L.stepBudgetMs + LIMITS.STEP_MARGIN_MS > S.phaseDeadline) return stop("BUDGET_EXHAUSTED");
      const prep = await prepare(phase, facts);
      if (prep.stop) return prep;
      const built = createPhaseExecutors({ phase: prep.factoryPhase, binding: prep.binding, hostaway: transports.hostaway, ...(prep.stripe ? { stripe: transports.stripe } : {}) });
      if (!built.ok) return stop(built.code === "BINDING_INVALID" ? "BINDING_INVALID" : "EXECUTORS_INVALID");
      const ledger = createLedger();
      const wrapped = wrapExecutors(built.executors, ledger);
      if (!wrapped.ok) return stop("EXECUTORS_INVALID");
      if (!(await append("STEP_STARTED", { phase, step, factory: { phase: prep.factoryPhase, reservationId: prep.reservationId } }))) return { stop: S.cause };
      S.unfinished = true;
      const sd = nowOr(); if (sd === null) return stop(guardCode());
      const r = await lc.observeStep({ phase, deadline: Math.min(sd + L.stepBudgetMs + LIMITS.STEP_MARGIN_MS, S.phaseDeadline), ledger, start: () => prep.run(wrapped.executors) });
      if (r.kind !== "fulfilled") {
        S.stale = true;
        if (r.kind === "rejected") { S.rejected = true; lc.markDbFamily(); return stop("DB_FAILURE"); }
        if (r.kind === "timeout") return stop("TIMEOUT_STEP");
        return stop(r.kind === "not_started" && r.code === "EXPIRED_BEFORE_START" ? "BUDGET_EXHAUSTED" : r.code);
      }
      const value = r.value;
      const status = getDesc(value, "status")?.value;
      const delayMs = getDesc(value, "delayMs")?.value;
      const rawActions = getDesc(value, "actions")?.value;
      const pa = projectActions(Array.isArray(rawActions) ? rawActions : []);
      const stepEnded = (state, writes) => ({ phase, step, result: ["worked", "idle", "refused"].includes(status) ? status : "refused", state,
        actions: pa.ok ? [...pa.actions] : [], unlistedActions: pa.ok ? pa.unlistedActions : 0, refusals: ledger.snapshot().refusals.slice(0, 16).map((x) => ({ key: x.key, code: x.code })), writes });
      const lastW = () => (S.lastFacts ? countWrites(S.lastFacts) : { cancel: 0, capture: 0, create: 0, record: 0, void: 0 });
      // post-result tail (§12.2 row 10)
      if (lc.snapshot().outstanding === "TAIL") {
        const td = deadline(LIMITS.TAIL_OBSERVE_MS);
        const t = td === null ? { kind: "observation_failed" } : await lc.observeTail(td);
        if (t.kind !== "settled") {
          S.stale = true;
          if (await append("STEP_ENDED", stepEnded(null, lastW()))) S.unfinished = false;
          return stop(t.kind === "unobservable" || t.kind === "timeout" ? "LATE_TAIL_OUTSTANDING" : (t.code || guardCode()));
        }
      }
      const post = await snapshot();
      if (post.stop) { if (await append("STEP_ENDED", stepEnded(null, lastW()))) S.unfinished = false; return post; }
      if (!(await append("STEP_ENDED", stepEnded(post.facts.intent.state, countWrites(post.facts))))) return { stop: S.cause };
      S.unfinished = false;
      const refusals = ledger.snapshot().refusals;
      if (refusals.length) return stop(refusals.some((x) => x.code === "RESERVATION_UNBOUND") ? "RECOVERY_BINDING_UNAVAILABLE" : "ADAPTER_REFUSED");
      if (pa.ok && pa.actions.some((a) => /^READ:[a-z_.]+:error$/.test(a))) return stop("READ_FAILED");
      if (status === "refused") return stop("STEP_REFUSED");
      const ps = factStops(post.facts, strictPhase(phase)); if (ps) return ps;
      const ns = post.facts.intent.state;
      if (PHASE_END_STATES[phase].includes(ns)) {
        if (!(await append("PHASE_ENDED", { phase, state: ns }))) return { stop: S.cause };
        S.phaseDeadline = Infinity;
        return { ended: ns, facts: post.facts };
      }
      if (!WORK_STATES[phase].includes(ns)) return stop("STATE_UNEXPECTED");
      if (step === L.maxSteps) break;
      const wait = Number.isSafeInteger(delayMs) && delayMs > 0 ? delayMs : status === "idle" ? IDLE_WAIT_MS : 0;
      if (wait > 0) {
        const wd = deadline(wait); if (wd === null) return stop(guardCode());
        const w = await guard.wait(wd);
        if (w.kind !== "elapsed") return stop(w.code === "EXPIRED_BEFORE_START" ? "BUDGET_EXHAUSTED" : w.code);
      } else basis = post.facts;                              // no awaited external boundary in between: the post-step snapshot is the basis
    }
    return stop("BUDGET_EXHAUSTED");
  }

  // P2 — reservation
  let r = await runPhase("reservation");
  if (r.stop) return stopped();
  if (r.ended === "reservation_failed") return cleanupPath(false);
  S.reservationExisted = true;
  { const rb = boundary(); if (rb) return stopped(); }
  { const a = await attestCheckpoint("AIRBNB_BLOCKED"); if (a && a.stop) return stopped(); }
  if (!m.phases.capture) {
    const s = await snapshot(); if (s.stop) return stopped();             // fresh basis after the attestation (clarification 2)
    const fs = factStops(s.facts, true); if (fs) return stopped();
    if (s.facts.intent.state !== "reservation_confirmed") { stop("STATE_UNEXPECTED"); return stopped(); }
    return ended("ENDED_RESERVED_NOT_CAPTURED", "reservedNotConfirmed");
  }
  // P3 — capture: runPhase takes a FRESH snapshot after the attestation and gates it strictly before the first capture step
  r = await runPhase("capture");
  if (r.stop) return stopped();
  if (r.ended === "capture_failed") return cleanupPath(true);
  if (!m.phases.recording) return ended("ENDED_CAPTURED_NOT_RECORDED", "captured");
  // P4 — recording
  r = await runPhase("recording");
  if (r.stop) return stopped();
  return ended("ENDED_CONFIRMED", "confirmed");

  /** P5 — failure compensation; D's three released paths (§12.3) */
  async function cleanupPath(reservationExisted) {
    S.cleanupEntryKey = reservationExisted ? "reservedNotConfirmed" : null;
    const c = await runPhase("cleanup");
    if (c.stop) return stopped();
    if (!reservationExisted) {
      if (c.ended !== "authorization_released") { stop("STATE_UNEXPECTED"); return stopped(); }
      return ended("ENDED_RELEASED", null);
    }
    if (c.ended !== "cancelled") { stop("STATE_UNEXPECTED"); return stopped(); }   // unreachable via E3 (intent-state.js:505–506, :572–574)
    { const rb = boundary(); if (rb) return stopped(); }
    const a = await attestCheckpoint("AIRBNB_REOPENED"); if (a && a.stop) return stopped();
    return ended("ENDED_RELEASED", null);
  }
}
