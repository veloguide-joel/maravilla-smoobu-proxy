// scripts/e7-connected/run-core-abort-v2.mjs — E7 M2-D: the v2 reservation → intentional TEST abort → cleanup CONSUMER (OFFLINE, LOCAL, inert).
// Contract: claude/e7-run-core-abort-v2.md. A NEW core beside the unchanged v1 run-core.mjs; it reuses the accepted foundations verbatim:
//   v2 manifest + v2 journal (bind ONCE, frozen copy only), run-guard (guard / lifecycle / ledger / wrapExecutors / trackClient), run-facts
//   (C snapshot, guest binding, recovery candidate), the executor adapters, the REAL accepted reservation + compensation workers, the v1
//   same-DB check / lock SQL, the accepted operator expectation builder and the accepted M2-C runTestAbortBridge (called at most ONCE).
//   * Only plan: testAbortAfterReservation=true, capture=false, recording=false, synthetic, fake/mock providers. No capture, no recording.
//   * No CLI, no real transport, no credentials, no durable journal, no env / fs / fetch / timer of its own.
//   * SQL text here: the v1 lock / same-DB statements (imported) and ONE release-proof claim read (SQL_CLAIM_HELD).
//   * Cleanup is entered ONLY through the consumer gate (§4): an ACKed receipt anchored by the journal read against that exact head.
import { types } from "node:util";
import { bindManifestV2, validateRecordV2, recordHashV2, evaluateStartV2, journalFactsV2, GENESIS_HASH } from "./run-journal-memory-v2.mjs";
import { projectActions, PHASE_END_STATES } from "./run-journal-memory.mjs";
import { validateGuardDeps, createGuard, createLifecycle, createLedger, wrapExecutors, trackClient, LIMITS } from "./run-guard.mjs";
import { readRunSnapshot, readGuestBinding, deriveRecoveryCandidate } from "./run-facts.mjs";
import { createPhaseExecutors } from "./executor-adapters.mjs";
import { checkSameDatabase, SQL, LOCK_KEY } from "./run-core.mjs";
import { runTestAbortBridge } from "./run-test-abort.mjs";
import { buildAbortExpectation } from "../e7-operator/test-abort.mjs";
import { loadIntent } from "../../lib/booking-db/repo.js";
import { runOrchestratorStep, DEFAULT_TIMEOUTS } from "../../lib/booking-db/reservation-worker.js";
import { runCleanupStep, CLEANUP_DEFAULT_TIMEOUTS } from "../../lib/booking-db/compensation-worker.js";

export const RUN_CORE_ABORT_V2_VERSION = "e7-run-core-abort-v2";
export { LOCK_KEY };
export const SQL_CLAIM_HELD = "/*m2d:claim*/ SELECT count(*)::int AS n FROM booking.inventory_claims WHERE intent_id = $1 AND released_at IS NULL";
export const PHASE_LIMITS = Object.freeze({
  reservation: Object.freeze({ maxSteps: 12, budgetMs: 15 * 60_000, stepBudgetMs: DEFAULT_TIMEOUTS.stepBudgetMs }),
  cleanup: Object.freeze({ maxSteps: 8, budgetMs: 15 * 60_000, stepBudgetMs: CLEANUP_DEFAULT_TIMEOUTS.stepBudgetMs })
});
export const IDLE_WAIT_MS = 5_000;
export const P0_BUDGET_MS = 60_000;
/** the bridge outcomes after which the journal tail is the start ACK (the start record was ACKed; no receipt append was started) */
const START_ACKED_STOPS = Object.freeze(["STOPPED_BEFORE_OPERATOR", "ABORT_REFUSED", "ABORT_NOT_THIS_RUN", "ABORT_OUTCOME_UNKNOWN", "ABORT_POSTCHECK_FAILED"]);
const BRIDGE_ENV = Object.freeze({ VERCEL_ENV: "development", MV_E7_TEST_ABORT: "enabled" });
const WORK_STATES = Object.freeze({ reservation: ["payment_authorized", "reservation_pending", "reservation_unknown"], cleanup: ["reservation_failed", "capture_failed"] });
const WRITE_TYPES = Object.freeze({ "hostaway.create_reservation": "create", "stripe.capture_payment_intent": "capture", "hostaway.record_offline_charge": "record",
  "stripe.void_payment_intent": "void", "hostaway.cancel_reservation": "cancel" });
const KEY_RANK = Object.freeze({ null: 0, reservedNotConfirmed: 1, captured: 2, confirmed: 3 });
const OPTION_KEYS = Object.freeze(["attest", "clock", "intentId", "journal", "manifest", "monotonic", "pools", "signal", "timers", "transports", "trustedHead"]);
const HEX64 = /^[0-9a-f]{64}$/;

// ---- helpers COPIED VERBATIM from run-core.mjs:48–113 (getter-free options, facts helpers, conservative key) ---------------------
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


const W0 = () => ({ cancel: 0, capture: 0, create: 0, record: 0, void: 0 });
const headOk = (h) => { try { return h !== null && typeof h === "object" && !types.isProxy(h) && Reflect.ownKeys(h).length === 2 && Number.isSafeInteger(getDesc(h, "seq")?.value)
  && getDesc(h, "seq").value >= 1 && typeof getDesc(h, "hash")?.value === "string" && HEX64.test(getDesc(h, "hash").value); } catch { return false; } };
const headOf = (h) => freeze({ seq: getDesc(h, "seq").value, hash: getDesc(h, "hash").value });
const sameHead = (a, b) => a !== null && b !== null && a.seq === b.seq && a.hash === b.hash;
/** a getter-free frozen copy of the bridge result fields this core reads (never the caller-visible object itself) */
function bridgeView(r) {
  try {
    if (r === null || typeof r !== "object" || types.isProxy(r)) return null;
    const g = (k) => { const d = getDesc(r, k); return d && "value" in d ? d.value : undefined; };
    const v = { outcome: g("outcome"), code: g("code"), cleanupPermitted: g("cleanupPermitted"), receiptLanding: g("receiptLanding"),
      operatorCoreInvocations: g("operatorCoreInvocations"), requestHelperInvocations: g("requestHelperInvocations"), operatorOutcome: g("operatorOutcome"),
      dbAbortApplied: g("dbAbortApplied"), startAck: headOk(g("startAck")) ? headOf(g("startAck")) : null, receiptAck: headOk(g("receiptAck")) ? headOf(g("receiptAck")) : null,
      trustedHead: headOk(g("trustedHead")) ? headOf(g("trustedHead")) : null, postcheck: g("postcheck") ?? null };
    return typeof v.outcome === "string" ? freeze(v) : null;
  } catch { return null; }
}
/** the accepted operator expectation from the FROZEN manifest + ONE fresh post-blocked snapshot (exactly one succeeded checkout session) */
function abortExpectation(facts, m) {
  const i = facts.intent;
  const co = facts.operations.filter((o) => o.opType === "stripe.create_checkout_session" && o.state === "succeeded");
  if (co.length !== 1) return null;
  const sessionId = co[0].resultRef; const attemptId = co[0].payload.paymentAttemptId;
  if (typeof sessionId !== "string" || typeof attemptId !== "string" || typeof i.hostawayReservationId !== "string" || typeof i.stripePaymentIntentId !== "string"
    || !Number.isSafeInteger(i.authorizedMinor)) return null;
  return buildAbortExpectation({ intentId: i.id, expectedVersion: i.version, listingId: m.listing.id, from: m.stay.arrival, to: m.stay.departure, guests: m.stay.guests,
    currency: m.listing.currency, finalTotalMinor: m.amountMinor, authorizedMinor: i.authorizedMinor, paymentIntentId: i.stripePaymentIntentId, sessionId, attemptId,
    reservationId: i.hostawayReservationId, approvalRef: `e7-run:${m.runId}`.slice(0, 80) });
}

/**
 * runAbortRehearsalV2(opts) → Promise<frozen RunResult> (contract claude/e7-run-core-abort-v2.md). Never rejects for caller input; returns a
 * bounded result and leaves disposal to result.finalize() (= lifecycle.finalize()).
 */
export async function runAbortRehearsalV2(input) {
  // ---------------- options + manifest binding (one getter-free snapshot, before any await) ----------------
  let o;
  try { o = plainData(input, OPTION_KEYS); } catch { o = null; }
  const invalid = (code = "OPTIONS_INVALID") => freeze({ ok: false, outcome: "REFUSED", stopCode: code, phase: "P0", finalize: () => Promise.resolve(freeze({ quiescence: "observed", lockRelease: "not_acquired" })) });
  if (!o) return invalid();
  const br = bindManifestV2(o.manifest);
  if (!br.ok) return invalid(br.manifestCode || "MANIFEST_INVALID");
  const B = br.binding; const manifest = B.manifest;                       // the ONE frozen validated copy; the caller's object is never read again
  const P = B.phases;
  if (!(P.testAbortAfterReservation === true && P.capture === false && P.recording === false) || manifest.synthetic !== true
    || manifest.providerMode.hostaway !== "fake" || manifest.providerMode.stripe !== "mock") return invalid("PHASE_PLAN_UNSUPPORTED");
  if (o.intentId !== manifest.intentId) return invalid("INTENT_MISMATCH");
  let pools, journalAppend, journalRead;
  try {
    pools = plainData(o.pools, ["app", "report"]);
    if (!pools || !dataMethod(pools.app, "connect") || !dataMethod(pools.app, "query") || !dataMethod(pools.report, "connect")) return invalid();
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
  const trustedStart = o.trustedHead === null ? null : freeze({ ...plainData(o.trustedHead, ["hash", "seq"]) });
  const identity = B.identity; const K = B.checkpoints;

  // ---------------- run state ----------------
  const S = { phase: "P0", started: false, head: { seq: 0, hash: GENESIS_HASH }, journalOk: true, journalTerminal: "not_attempted", journalTail: "KNOWN", anchored: false,
    lastFacts: null, countsSeq: 0, rejected: false, stale: false, lockLostEarly: false, lockClient: null, outcome: null, unfinished: false,
    phaseDeadline: Infinity, cleanupEntryKey: null, cause: null, bridge: null, bridgeCalls: 0, release: null };
  const stop = (code) => { lc.stop(code); if (!S.cause) S.cause = code; return { stop: code }; };
  const dbStop = (code) => { lc.markDbFamily(); S.stale = true; return stop(code); };
  const nowOr = () => { const n = guard.now(); return n.ok ? n.value : null; };
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
  const blocked = () => S.cause !== null || boundary() !== null;

  // ---------------- clients (B ownership, §12.2) ----------------
  async function acquire(pool, onLoss) {
    if (blocked()) return { pre: true };
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
    const h = { client: c, query, tracker: t.tracker, release: () => { t.tracker.dispose(); if (t.tracker.state() === "open") { try { apply(rel, c, []); } catch { t.tracker.destroy(); } } } };
    // R-E1d: the HANDOFF check, after the awaited connect + tracker setup and before any statement / C helper on this client.
    // (1) the acquired client itself was lost meanwhile → it was already destroyed once by its tracker; never queried; DB family.
    if (t.tracker.state() !== "open") return { fail: "DB_FAILURE" };
    // (2) a stop / lock loss / cancellation / broken guard became observable while connecting → no new SQL: the never-queried client is
    //     returned once (dispose + release) when healthy, destroyed once on the DB-family path; the observed cause is recorded first.
    if (blocked()) { if (lc.snapshot().dbFamily) t.tracker.destroy(); else h.release(); return { pre: true }; }
    return h;
  }
  const statement = (h, sql, params, ms = LIMITS.STATEMENT_MS) => (blocked() ? Promise.resolve({ pre: true })
    : observeMapped(ms, () => apply(h.query, h.client, [sql, params]), { rejected: "DB_FAILURE", timeout: "TIMEOUT_DB_READ" }));
  /** one C report snapshot on a fresh client; disposition honoured exactly */
  async function snapshot() {
    const h = await acquire(pools.report, () => {});
    if (h.pre) return { stop: S.cause };
    if (h.fail) return dbStop(h.fail);
    const d = deadline(LIMITS.SNAPSHOT_MS);
    if (d === null) { h.tracker.destroy(); return stop(guardCode()); }
    const r = await readRunSnapshot({ client: h.client, intentId: identity.intentId, guard, deadline: d });
    if (r.ok) { h.release(); S.lastFacts = r.facts; S.countsSeq = S.head.seq; S.stale = false; return { facts: r.facts }; }   // R-E2: only a valid snapshot clears stale
    if (S.started) S.stale = true;                            // R-E2: ANY unsuccessful observation (incl. an acknowledged refusal) leaves counts stale
    if (r.clientDisposition === "destroy") { h.tracker.destroy(); return dbStop(r.code); }
    h.release();
    if (r.failure === "not_started") return stop(r.code === "SNAPSHOT_BUDGET_EXHAUSTED" ? "BUDGET_EXHAUSTED" : r.code);
    return stop(r.code);                                      // acknowledged refusal (marker / role / malformed / cap)
  }
  async function guest() {
    const h = await acquire(pools.app, () => {});
    if (h.pre) return { stop: S.cause };
    if (h.fail) return dbStop(h.fail);
    const d = deadline(LIMITS.STATEMENT_MS);
    if (d === null) { h.tracker.destroy(); return stop(guardCode()); }
    const r = await readGuestBinding({ client: h.client, intentId: identity.intentId, guard, deadline: d });
    if (r.ok) { h.release(); return { guest: r.guest }; }
    if (r.clientDisposition === "destroy") { h.tracker.destroy(); return dbStop(r.code); }
    h.release();
    return stop(r.code);
  }

  // ---------------- journal (v2 records; exact ACK; no append after an unACKed one) ----------------
  async function append(event, body) {
    if (!S.journalOk) return false;
    const at = businessNow();
    if (at === null) { S.journalOk = false; stop("CLOCK_INVALID"); return false; }
    const vr = validateRecordV2({ v: 2, seq: S.head.seq + 1, prevHash: S.head.hash, ...identity, at, event, ...body }, manifest);
    if (!vr.ok) { S.journalOk = false; stop("JOURNAL_RECORD_INVALID"); return false; }
    const terminal = event === "RUN_STOPPED" || event === "RUN_ENDED";
    const r = await observeMapped(LIMITS.JOURNAL_MS, () => apply(journalAppend, journal, [vr.record]), { rejected: "JOURNAL_FAILURE", timeout: "TIMEOUT_JOURNAL" });
    const expect = recordHashV2(vr.record);
    const ackOk = !r.fail && r.value !== null && typeof r.value === "object" && getDesc(r.value, "seq")?.value === vr.record.seq && getDesc(r.value, "hash")?.value === expect;
    if (!ackOk) {
      S.journalOk = false; S.journalTail = "UNKNOWN";        // a late landing stays uncertain; never repaired
      if (terminal) S.journalTerminal = "unknown";
      stop(r.fail || "JOURNAL_FAILURE");
      return false;
    }
    S.head = { seq: vr.record.seq, hash: expect };
    if (terminal) S.journalTerminal = "acknowledged";
    return true;
  }
  const attestCheckpoint = async (checkpoint) => {
    if (blocked()) return { stop: S.cause };
    const request = freeze({ checkpoint, runId: identity.runId, intentId: identity.intentId, manifestHash: identity.manifestHash, connection: identity.connection });
    const r = await observeMapped(LIMITS.ATTEST_MS, () => apply(attest, undefined, [checkpoint, request, { signal }]), { rejected: "ATTESTATION_FAILED", timeout: "TIMEOUT_ATTEST" });
    if (r.fail) return stop(r.fail);
    const v = plainData(r.value, ["evidenceRef", "ok"]) || plainData(r.value, ["ok"]);
    if (!v || typeof v.ok !== "boolean") return stop("ATTESTATION_FAILED");
    if (!v.ok) return stop("OWNER_DECLINED");
    if (typeof v.evidenceRef !== "string") return stop("ATTESTATION_FAILED");
    if (!(await append("ATTESTED", { attestation: { checkpoint, evidenceRef: v.evidenceRef } }))) return { stop: S.cause };
    return null;
  };

  // ---------------- result construction ----------------
  function result(outcomeKind, extra = {}) {
    const ls = lc.snapshot();
    const facts = S.lastFacts;
    return freeze({ ok: outcomeKind === "ENDED", outcome: S.outcome || outcomeKind, stopCode: S.cause, phase: S.phase, manifestHash: identity.manifestHash,
      connection: identity.connection, journalSeq: S.head.seq, trustedHead: freeze({ ...S.head }), journalTail: S.journalTail, journalTerminal: S.journalTerminal,
      anchored: S.anchored, writes: freeze(facts ? countWrites(facts) : W0()), countsAsOf: freeze({ seq: S.countsSeq, stale: S.stale }),
      effectsKnown: !S.stale && ls.outstanding === "NONE" && !ls.dbFamily, outstanding: ls.outstanding, outstandingPhase: ls.outstandingPhase,
      tailObservable: ls.tailObservable, exclusion: ls.exclusion === "released" ? "held" : ls.exclusion, bridgeCalls: S.bridgeCalls, bridge: S.bridge, release: S.release,
      ownerCleanupRequired: null, finalize: () => lc.finalize(), ...extra });
  }
  const refused = () => result("REFUSED", { outcome: "REFUSED", ownerCleanupRequired: null });
  /** a STOP after RUN_STARTED: ONE terminal append only when the tail is KNOWN and the journal healthy; conservative key */
  async function stopped() {
    const ls = lc.snapshot();
    const unfinished = S.unfinished || S.rejected || ls.outstanding !== "NONE";
    const effectsKnown = !unfinished && !S.stale && !ls.dbFamily && !(S.lastFacts && uncertainWrite(S.lastFacts));
    const k = conservativeKey(S.lastFacts, S.phase, unfinished, S.cleanupEntryKey, effectsKnown);
    if (S.journalOk && S.journalTail === "KNOWN") {
      await append("RUN_STOPPED", { code: S.cause || "STOPPED", outstanding: ls.outstanding, effectsKnown, exclusion: ls.exclusion === "lost" ? "lost" : "held",
        ownerCleanupRequired: k, writes: S.lastFacts ? countWrites(S.lastFacts) : W0() });
    }
    return result("STOPPED", { outcome: "STOPPED", ownerCleanupRequired: k, effectsKnown });
  }
  async function ended(outcome, key) {
    if (blocked()) return stopped();
    const ls = lc.snapshot();
    const ok = await append("RUN_ENDED", { outcome, outstanding: "NONE", effectsKnown: true, exclusion: ls.exclusion === "lost" ? "lost" : "held", ownerCleanupRequired: key,
      writes: countWrites(S.lastFacts) });
    if (!ok) return result("STOPPED", { outcome: "STOPPED", ownerCleanupRequired: key, ok: false });
    S.outcome = outcome;
    return result("ENDED", { outcome, ownerCleanupRequired: key, ok: true });
  }

  // =======================================================================================================================
  // P0 — lock, same DB, journal start rule, eligibility (v1 §12.1, §12.2, §6.1; unchanged rules)
  S.phaseDeadline = (nowOr() ?? 0) + P0_BUDGET_MS;
  {
    const h = await acquire(pools.report, () => { S.lockLostEarly = true; lc.lockLost(); });
    if (h.pre) return refused();
    if (h.fail) { stop(h.fail); lc.markDbFamily(); return refused(); }
    S.lockClient = h;
    const lr = await statement(h, SQL.LOCK, [LOCK_KEY], LIMITS.LOCK_ACQUIRE_MS);
    if (lr.fail) { h.tracker.destroy(); lc.markDbFamily(); stop(lr.fail === "TIMEOUT_DB_READ" ? "TIMEOUT_DB_LOCK" : lr.fail); return refused(); }
    const rows = rowsOf(lr.value);
    if (!rows || rows.length !== 1 || rows[0].ok !== true) { h.tracker.destroy(); stop(rows && rows[0]?.ok === false ? "RUN_LOCK_HELD" : "DB_FAILURE"); return refused(); }
    if (h.tracker.state() !== "open" || S.lockLostEarly) { h.tracker.destroy(); stop("LOCK_LOST"); return refused(); }
    lc.attachLock({ unlock: () => apply(h.query, h.client, [SQL.UNLOCK, [LOCK_KEY]]).then((res) => { const r2 = rowsOf(res); return !!r2 && r2.length === 1 && r2[0].ok === true; }),
      destroy: () => { h.tracker.destroy(); } });
  }
  {
    const s1 = await statement(S.lockClient, SQL.SAME_DB, []);
    if (s1.pre) return refused();
    if (s1.fail) { lc.markDbFamily(); stop(s1.fail); return refused(); }
    const a = rowsOf(s1.value);
    const c1 = checkSameDatabase(a, [{ environment: "test", is_app: true, is_report: false, privileged: false }]);
    if (!c1.ok && c1.code !== "POOLS_MISMATCH") { stop(c1.code); return refused(); }
    const app = await acquire(pools.app, () => {});
    if (app.pre) return refused();
    if (app.fail) { lc.markDbFamily(); stop(app.fail); return refused(); }
    const s2 = await statement(app, SQL.SAME_DB, []);
    if (s2.pre) { app.tracker.destroy(); return refused(); }
    if (s2.fail) { app.tracker.destroy(); lc.markDbFamily(); stop(s2.fail); return refused(); }
    const b = rowsOf(s2.value);
    app.release();
    const c2 = checkSameDatabase(a, b);
    if (!c2.ok) { stop(c2.code); return refused(); }
  }
  {
    if (blocked()) return refused();
    const jr = await observeMapped(LIMITS.JOURNAL_MS, () => apply(journalRead, journal, []), { rejected: "JOURNAL_FAILURE", timeout: "TIMEOUT_JOURNAL" });
    if (jr.fail) { stop(jr.fail); return refused(); }
    const v = evaluateStartV2(jr.value, manifest, trustedStart === null ? undefined : { trustedHead: trustedStart });
    S.anchored = v.anchored === true;
    if (!v.ok) { stop(v.code); return refused(); }
  }
  {
    if (blocked()) return refused();
    const s = await snapshot();
    if (s.stop) return refused();
    const f = s.facts; const i = f.intent; const m = manifest;
    const cand = deriveRecoveryCandidate(f);
    if (!cand.ok && ["PROTECTED_REFERENCE", "FACT_MALFORMED", "FACTS_INCONSISTENT"].includes(cand.code)) { stop(cand.code); return refused(); }
    if (i.state !== "payment_authorized" || writeOps(f).length > 0 || openCase(f)) { stop("INTENT_NOT_ELIGIBLE"); return refused(); }
    if (!cand.ok && cand.code !== "NO_CANDIDATE") { stop(cand.code); return refused(); }
    if (cand.ok) { stop("INTENT_NOT_ELIGIBLE"); return refused(); }
    const same = i.ref === m.expectedRef && i.listingId === m.listing.id && i.from === m.stay.arrival && i.to === m.stay.departure && i.guests === m.stay.guests
      && i.finalTotalMinor === m.amountMinor && i.rateBps === m.pricing.rateBps && i.currency === m.listing.currency && typeof i.stripePaymentIntentId === "string";
    if (!same) { stop("INTENT_IDENTITY_MISMATCH"); return refused(); }
  }
  if (!(await append("RUN_STARTED", {}))) return result("STOPPED", { outcome: "STOPPED", ownerCleanupRequired: null });
  S.started = true;
  S.phaseDeadline = Infinity;

  // P1 — the pre-create gate (the mode's baseline)
  S.phase = "P1";
  { const rb = boundary(); if (rb) return stopped(); }
  { const a = await attestCheckpoint(K.baseline); if (a && a.stop) return stopped(); }

  const m = manifest; const id = m.listing.id;
  const adapterConfig = () => ({ allowedListingIds: [id], refFieldId: m.listing.refFieldId, channelId: 2000, currency: "USD" });
  const baseEnv = { VERCEL_ENV: "development" };
  const common = (i) => ({ listingId: i.listingId, arrivalDate: i.from, departureDate: i.to, ref: i.ref });

  /** ONE step's frozen binding / executors / worker call; the workers ALWAYS get the one intent + a Map holding ONLY the manifest listing */
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
        run: (executors) => runOrchestratorStep(pools.app, { workerId: "e7r2-res", env: { ...baseEnv, MV_E7_RESERVATION_WORKER: "enabled", DIRECT_DISCOUNT_BPS: String(m.pricing.rateBps) },
          adapterConfig: adapterConfig(), listings: new Map([[id, { currency: "USD" }]]), executors, clock, intentId: identity.intentId }) };
    }
    const voids = facts.operations.filter((x) => x.opType === "stripe.void_payment_intent");
    const v = voids.at(-1);
    if (!v || typeof v.payload.providerIdempotencyKey !== "string") return stop("STATE_UNEXPECTED");
    const binding = { ...common(i), reservationId: i.hostawayReservationId ?? null, accountId: m.stripeAccountId, paymentIntentId: i.stripePaymentIntentId,
      voidIdempotencyKey: v.payload.providerIdempotencyKey };
    return { factoryPhase: "cleanup", reservationId: binding.reservationId, binding, stripe: true,
      run: (executors) => runCleanupStep(pools.app, { workerId: "e7r2-cln", env: { ...baseEnv, MV_E7_COMPENSATION_WORKER: "enabled" }, adapterConfig: adapterConfig(),
        listings: new Map([[id, { currency: "USD", timeZone: m.listing.timeZone }]]), executors, clock, stripeAccountId: m.stripeAccountId, intentId: identity.intentId }) };
  }
  function factStops(facts, strict) {
    const c = deriveRecoveryCandidate(facts);
    if (!c.ok && ["PROTECTED_REFERENCE", "FACT_MALFORMED", "FACTS_INCONSISTENT"].includes(c.code)) return stop(c.code);
    if (strict && openCase(facts)) return stop("OPEN_CASE");
    if (strict && uncertainWrite(facts)) return stop("UNKNOWN_WRITE");
    return null;
  }

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
      const fs = factStops(facts, false); if (fs) return fs;
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
      if (blocked()) return { stop: S.cause };                // R-E1b: re-checked after prepare / guest read, before STEP_STARTED
      if (!(await append("STEP_STARTED", { phase, step, factory: { phase: prep.factoryPhase, reservationId: prep.reservationId } }))) return { stop: S.cause };
      S.unfinished = true;                                    // cleared only by a valid post-step snapshot + an acknowledged STEP_ENDED
      if (blocked()) return { stop: S.cause };                // R-E1b: and IMMEDIATELY before the worker is invoked (no start after a detected stop)
      const sd = nowOr(); if (sd === null) return stop(guardCode());
      const r = await lc.observeStep({ phase, deadline: Math.min(sd + L.stepBudgetMs + LIMITS.STEP_MARGIN_MS, S.phaseDeadline), ledger, start: () => { S.stale = true; return prep.run(wrapped.executors); } });   // R-E2: an invoked step can change facts
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
          await append("STEP_ENDED", stepEnded(null, lastW()));   // logged, but effects stay unknown (S.unfinished kept)
          return stop(t.kind === "unobservable" || t.kind === "timeout" ? "LATE_TAIL_OUTSTANDING" : (t.code || guardCode()));
        }
      }
      const post = await snapshot();
      if (post.stop) { await append("STEP_ENDED", stepEnded(null, lastW())); return post; }   // R-E2: no accepted post snapshot ⇒ effects unknown
      if (!(await append("STEP_ENDED", stepEnded(post.facts.intent.state, countWrites(post.facts))))) return { stop: S.cause };
      S.unfinished = false;
      const refusals = ledger.snapshot().refusals;
      if (refusals.length) return stop(refusals.some((x) => x.code === "RESERVATION_UNBOUND") ? "RECOVERY_BINDING_UNAVAILABLE" : "ADAPTER_REFUSED");
      if (pa.ok && pa.actions.some((a) => /^READ:[a-z_.]+:error$/.test(a))) return stop("READ_FAILED");
      if (status === "refused") return stop("STEP_REFUSED");
      const ps = factStops(post.facts, false); if (ps) return ps;
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

  // ---------------- the TEST-abort bridge, ONCE, and the consumer gate (contract §4 / §6) ----------------
  async function abortThenGate() {
    S.phase = "abort";
    { const rb = boundary(); if (rb) return rb; }
    const s = await snapshot(); if (s.stop) return s;                      // a FRESH basis after the blocked attestation
    const fs = factStops(s.facts, true); if (fs) return fs;
    if (s.facts.intent.state !== "reservation_confirmed") return stop("STATE_UNEXPECTED");
    const e = abortExpectation(s.facts, m);
    if (e === null) return stop("ABORT_EXPECTATION_UNAVAILABLE");
    const now = businessNow(); if (now === null) return stop("CLOCK_INVALID");
    if (blocked()) return { stop: S.cause };
    const before = freeze({ ...S.head });
    const jfacade = freeze({ append: (rec) => apply(journalAppend, journal, [rec]), read: () => apply(journalRead, journal, []) });
    // the runner's stop-before-operation rule at the ACTUAL guarded start: guard.observe validates its timer and then calls `start`
    // synchronously in the same turn (run-guard §7.2), so a stop (lock loss, native signal, existing cause) observed HERE means `start`
    // is never called — the bridge receives the established not_started shape (started=false), never a manufactured unknown outcome.
    const gfacade = freeze({
      observe: (d, st) => (blocked() ? Promise.resolve(freeze({ kind: "not_started", started: false, code: S.cause || "STOPPED" })) : guard.observe(d, st)),
      now: () => guard.now()
    });
    S.bridgeCalls += 1;
    let raw;
    try { raw = await runTestAbortBridge({ manifest: m, operator: { ...e }, journal: jfacade, trustedHead: { ...before }, pool: pools.app, env: { ...BRIDGE_ENV }, guard: gfacade, now }); }
    catch { raw = null; }
    const bv = bridgeView(raw);
    S.bridge = bv;
    if (bv === null) { S.journalOk = false; S.journalTail = "UNKNOWN"; S.stale = true; S.unfinished = true; return stop("BRIDGE_RESULT_INVALID"); }
    if (bv.operatorCoreInvocations !== 0) { S.stale = true; }               // the core was started: DB effects may differ from the last counts
    const startAcked = bv.startAck !== null && bv.startAck.seq === before.seq + 1;
    // tail classification (never manufacture a terminal ACK over an unknown tail)
    if (bv.outcome === "ABORT_ACCEPTED_JOURNALED") {
      const okShape = bv.cleanupPermitted === true && bv.receiptLanding === "ACKED" && startAcked && bv.receiptAck !== null && bv.receiptAck.seq === before.seq + 2
        && sameHead(bv.receiptAck, bv.trustedHead);
      if (!okShape) { S.journalOk = false; S.journalTail = "UNKNOWN"; S.unfinished = true; return stop("ABORT_GATE_FAILED"); }
      S.head = { ...bv.receiptAck };                                        // the exact receipt ACK: the run's LAST ACKED head (the tail is known)
      S.unfinished = true;                                                  // until the gate read anchors it, the abort is not a cleanup permission
      if (blocked()) return { stop: S.cause };
      const jr = await observeMapped(LIMITS.JOURNAL_MS, () => apply(journalRead, journal, []), { rejected: "JOURNAL_FAILURE", timeout: "TIMEOUT_JOURNAL" });
      const rec = jr.fail ? null : plainData(jr.value, ["records", "tail"]);
      const jf = rec && rec.tail === "complete" ? journalFactsV2(rec.records, m, { trustedHead: { ...bv.receiptAck } }) : null;
      const anchored = !!(jf && jf.ok && jf.anchored && jf.status === "IN_PROGRESS" && jf.facts.abortAccepted && jf.facts.cleanupEntryPermitted);
      if (!anchored) { S.journalOk = false; S.journalTail = "UNKNOWN"; return stop(jr.fail || "ABORT_GATE_FAILED"); }   // the journal disagrees / unread
      S.unfinished = false;
      return { accepted: true };
    }
    if (bv.outcome === "REFUSED_BEFORE_START") return stop(`BRIDGE_${bv.code || "REFUSED"}`.slice(0, 48));
    if (bv.outcome === "STOPPED_START_UNACKED") {
      const neverStarted = typeof bv.code === "string" && /^(GUARD_NOW_|NOT_STARTED_)/.test(bv.code);
      if (!neverStarted) { S.journalOk = false; S.journalTail = "UNKNOWN"; }
      return stop("ABORT_START_UNACKED");
    }
    if (!startAcked || !sameHead(bv.startAck, bv.trustedHead)) { S.journalOk = false; S.journalTail = "UNKNOWN"; S.unfinished = true; return stop("BRIDGE_RESULT_INVALID"); }
    S.head = { ...bv.startAck };                                            // the start record is ACKed: the run's last ACKed head
    S.unfinished = true;                                                    // an abort may have been requested / applied
    if (bv.outcome === "STOPPED_RECEIPT_UNACKED") {
      if (bv.receiptLanding !== "NOT_ATTEMPTED") { S.journalOk = false; S.journalTail = "UNKNOWN"; }
      return stop("ABORT_RECEIPT_UNACKED");
    }
    if (START_ACKED_STOPS.includes(bv.outcome)) return stop(bv.outcome);
    S.journalOk = false; S.journalTail = "UNKNOWN";
    return stop("BRIDGE_RESULT_INVALID");
  }
  /** release proof after cleanup ENDED cancelled: accepted loadIntent + ONE claim read on a fresh app client (bounded) */
  async function releaseProof() {
    const h = await acquire(pools.app, () => {});
    if (h.pre) return { stop: S.cause };
    if (h.fail) return dbStop(h.fail);
    const r1 = await observeMapped(LIMITS.STATEMENT_MS, () => loadIntent(h.client, identity.intentId), { rejected: "DB_FAILURE", timeout: "TIMEOUT_DB_READ" });
    if (r1.fail) { h.tracker.destroy(); return dbStop(r1.fail); }
    const r2 = await statement(h, SQL_CLAIM_HELD, [identity.intentId]);
    if (r2.pre) { h.release(); return { stop: S.cause }; }
    if (r2.fail) { h.tracker.destroy(); return dbStop(r2.fail); }
    h.release();
    const i = r1.value; const rows = rowsOf(r2.value);
    const legs = i && i.settlement ? `${i.settlement.reservationCancelled}/${i.settlement.authorizationSettled}` : "none";
    const held = rows && rows.length === 1 && Number.isSafeInteger(rows[0].n) ? rows[0].n : null;
    S.release = freeze({ state: i ? i.status : null, reason: i ? i.reasonCode : null, legs, claimsHeld: held });
    if (!(i && i.status === "cancelled" && i.reasonCode === "TEST_ABORT_REQUESTED" && legs === "true/true" && held === 0)) return stop("RELEASE_NOT_PROVEN");
    return null;
  }

  // P2 — reservation
  let r = await runPhase("reservation");
  if (r.stop) return stopped();
  if (r.ended === "reservation_failed") {
    // the accepted void-only route (no reservation existed): v1 cleanup entry, no blocked / reopened
    S.cleanupEntryKey = null;
    const c = await runPhase("cleanup");
    if (c.stop) return stopped();
    if (c.ended !== "authorization_released") { stop("STATE_UNEXPECTED"); return stopped(); }
    return ended("ENDED_RELEASED", null);
  }
  { const rb = boundary(); if (rb) return stopped(); }
  { const a = await attestCheckpoint(K.blocked); if (a && a.stop) return stopped(); }
  // P3 — the ONE intentional TEST abort; cleanup ONLY through the consumer gate
  { const g = await abortThenGate(); if (!g.accepted) return stopped(); }
  // P4 — compensation (both legs); then the release proof; then the mode's reopened
  S.cleanupEntryKey = "reservedNotConfirmed";
  const c = await runPhase("cleanup");
  if (c.stop) return stopped();
  if (c.ended !== "cancelled") { stop("STATE_UNEXPECTED"); return stopped(); }
  { const rp = await releaseProof(); if (rp && rp.stop) return stopped(); }
  { const rb = boundary(); if (rb) return stopped(); }
  { const a = await attestCheckpoint(K.reopened); if (a && a.stop) return stopped(); }
  return ended("ENDED_RELEASED", null);
}
