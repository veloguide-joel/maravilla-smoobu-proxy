// scripts/e7-connected/run-journal-memory.mjs — E7 connected-test runner SLICE D: IN-MEMORY journal + record / chain / start validation.
// Contract: claude/e7-connected-runner-contract.md §2.5, §8. OFFLINE UNIT foundation only.
//   * NOT durable and NOT a file journal: records live in this process's memory. Nothing here proves fsync, filesystem atomicity, disk
//     durability or the absence of a late append (all CLOSED). A memory journal is never a live gate, an approval or a DB check.
//   * Pure: node:crypto (via the accepted manifest hash helpers), node:util. No timer, env, fs, network, SDK, worker or DB.
//   * Every caller value is copied through ONE getter-free own-enumerable-data-descriptor snapshot BEFORE any await; the validated
//     frozen copy is what is hashed, stored and returned. Caller code / errors never reach a result or a diagnostic code.
//   * Integrity is RELATIVE TO A TRUSTED HEAD (seq + hash), not authentication: whoever can rewrite the whole chain can forge it.
import { createHash } from "node:crypto";
import { types } from "node:util";
import { canonicalJson, CHECKPOINTS } from "./run-manifest.mjs";

export const RUN_JOURNAL_VERSION = "e7-run-journal-v1";
export const RECORD_VERSION = 1;
export const JOURNAL_HASH_PREFIX = `${RUN_JOURNAL_VERSION}\n`;
export const GENESIS_HASH = "0".repeat(64);
export const MAX_RECORDS = 1024;                  // finite bound on one run's journal (a run is ≤ ~60 steps; generous)
export const MAX_ACTIONS = 64;
export const MAX_RAW_ACTIONS = 256;
export const MAX_REFUSALS = 16;
export const MAX_STEP = 64;

const freeze = Object.freeze;
const getDescs = Object.getOwnPropertyDescriptors;
const getProto = Object.getPrototypeOf;
const ownKeys = Reflect.ownKeys;
const OBJECT_PROTO = Object.prototype;
const ARRAY_PROTO = Array.prototype;

// ---- vocabulary (pinned from accepted sources; parity asserted by the tests) ---------------------------------------------------
/** booking.is_intent_state (0001_booking_core.up.sql:27–32) = lib/checkout/intent-state.js STATES */
export const INTENT_STATES = freeze(["created", "price_confirmed", "details_collected", "payment_pending", "payment_authorized", "reservation_pending",
  "reservation_unknown", "reservation_confirmed", "capture_unknown", "payment_captured", "confirmed", "validation_failed", "expired", "payment_failed",
  "payment_expired", "reservation_failed", "authorization_released", "capture_failed", "cancelled", "reconciliation_required"]);
/** external_operations.op_type (0003_safety_corrections.up.sql:31–36) */
export const OPERATION_TYPES = freeze(["stripe.create_checkout_session", "stripe.retrieve_checkout_session", "stripe.retrieve_payment_intent",
  "stripe.capture_payment_intent", "stripe.void_payment_intent", "hostaway.lookup_reservation", "hostaway.retrieve_reservation",
  "hostaway.list_offline_charges", "hostaway.create_reservation", "hostaway.cancel_reservation", "hostaway.record_offline_charge", "guest.notify", "alert.owner"]);
/** external_operations.state (0001_booking_core.up.sql:365–366) */
export const OPERATION_STATES = freeze(["pending", "in_flight", "succeeded", "failed_definite", "outcome_unknown", "superseded", "escalated"]);
/** action verbs the accepted workers push (reservation / capture / recording / compensation workers + recovery) */
export const ACTION_NAMES = freeze(["RESERVATION_STARTED", "RESERVATION_DISPATCHED", "CREATE_CLAIMED", "RESERVATION_SUCCEEDED", "CREATE_REF_NOT_ECHOED",
  "RESERVATION_OUTCOME_UNKNOWN", "RESERVATION_CANCELLED", "CAPTURE_CLAIMED", "CAPTURE_SUCCEEDED", "CAPTURE_OUTCOME_UNKNOWN", "AUTHORIZATION_GONE",
  "VOID_CLAIMED", "VOID_SUCCEEDED", "CANCEL_CLAIMED", "ASSESSED", "ASSESS", "CLAIMED", "COMPLETED", "COMPLETE", "RECORDED", "EVIDENCE", "HOLD",
  "ESCALATE", "WAIT", "STOP", "UNKNOWN", "SEND_ABORTED", "LEASE_LOST"]);
/** planner event types (lib/checkout/recovery-plan.js ev("…")) usable after "RECOVERY:" */
export const RECOVERY_EVENTS = freeze(["CAPTURE_OUTCOME_UNKNOWN", "ESCALATE", "OFFLINE_CHARGE_FAILED", "OFFLINE_CHARGE_RECORDED", "RECONCILED_AUTHORIZATION_GONE",
  "RECONCILED_CAPTURE_SUCCEEDED", "RECONCILED_RESERVATION_FOUND", "RECONCILED_RESERVATION_STILL_ACTIVE", "RECONCILED_STILL_AUTHORIZED", "RECONCILIATION_INCONCLUSIVE",
  "RESERVATION_CANCELLED", "RESERVATION_CANCEL_FAILED", "RESERVATION_CANCEL_OUTCOME_UNKNOWN", "RESERVATION_FAILED", "RESERVATION_OUTCOME_UNKNOWN",
  "RESERVATION_SUCCEEDED", "VOID_FAILED", "VOID_OUTCOME_UNKNOWN", "VOID_SUCCEEDED"]);
export const READ_OUTCOMES = freeze(["found", "not_found", "conflict", "error", "lease_lost"]);

const alt = (xs) => xs.map((x) => x.replace(/[.]/g, "\\.")).join("|");
const CODE = "[A-Za-z0-9_]{1,48}";
const NAME = `(?:${alt(ACTION_NAMES)})`;
const STATE = `(?:${alt(INTENT_STATES)})`;
const OPTYPE = `(?:${alt(OPERATION_TYPES)})`;
const OPSTATE = `(?:${alt(OPERATION_STATES)})`;
const REVENT = `(?:${alt(RECOVERY_EVENTS)})`;
/** whole-token grammar (anchored; never a prefix match) */
export const ACTION_TOKEN_RE = new RegExp(`^(?:${[
  `${NAME}(?::${CODE}){0,2}(?:->${STATE})?`,
  `${NAME}!${CODE}`,
  `READ:${OPTYPE}(?::(?:${alt(READ_OUTCOMES)}))?`,
  `READ:PI(?:!${CODE})?`,
  `READ:(?:ID|LIST):${CODE}(?:(?::|!)${CODE})?`,
  `READ:LEASE!${CODE}`,
  `READ!${CODE}`,
  `RECOVERY:READ:(?:${OPTYPE}|PI)`,
  `RECOVERY:${REVENT}(?:!${CODE})?`,
  `RECOVERY:ESCALATE(?::|!)${CODE}`,
  `RECOVERY:REISSUE(?:!${CODE})?`,
  `MAINTENANCE:${OPTYPE}:${OPSTATE}`
].join("|")})$`);
export const MAX_TOKEN_LENGTH = 160;
export const isActionToken = (t) => typeof t === "string" && t.length <= MAX_TOKEN_LENGTH && ACTION_TOKEN_RE.test(t);

// ---- record vocabulary ------------------------------------------------------------------------------------------------------------
export const EVENTS = freeze(["RUN_STARTED", "STEP_STARTED", "STEP_ENDED", "PHASE_ENDED", "ATTESTED", "RUN_STOPPED", "RUN_ENDED"]);
export const TERMINAL_EVENTS = freeze(["RUN_STOPPED", "RUN_ENDED"]);
export const STEP_PHASES = freeze(["reservation", "capture", "recording", "cleanup"]);
export const FACTORY_PHASES = freeze(["reservation", "reservation-recovery", "capture", "cleanup", "recording"]);
export const STEP_RESULTS = freeze(["worked", "idle", "refused", "rejected", "timeout", "observation_failed"]);
export const OUTCOMES = freeze(["ENDED_CONFIRMED", "ENDED_RESERVED_NOT_CAPTURED", "ENDED_CAPTURED_NOT_RECORDED", "ENDED_RELEASED"]);
export const CLEANUP_KEYS = freeze(["reservedNotConfirmed", "captured", "confirmed"]);
export const WRITE_KEYS = freeze(["cancel", "capture", "create", "record", "void"]);
/** the intent states a phase may END in (PHASE_ENDED.state = the phase's last STEP_ENDED.state) — §6.1 */
export const PHASE_END_STATES = freeze({ reservation: freeze(["reservation_confirmed", "reservation_failed"]), capture: freeze(["payment_captured", "capture_failed"]),
  recording: freeze(["confirmed"]), cleanup: freeze(["authorization_released", "cancelled"]) });
/** a phase may START only after the previous phase ENDED in this state (§6.1): the run's single path through P2–P5 */
const ENTRY = freeze({ capture: ["reservation", "reservation_confirmed"], recording: ["capture", "payment_captured"] });
const CLEANUP_ENTRY = freeze([["reservation", "reservation_failed"], ["capture", "capture_failed"]]);
/** successful terminal outcomes: the phase that must have ENDED last, in which state, and the exact cleanup key */
export const OUTCOME_RULES = freeze({
  ENDED_RESERVED_NOT_CAPTURED: freeze({ phase: "reservation", state: "reservation_confirmed", key: "reservedNotConfirmed", checkpoint: "AIRBNB_BLOCKED" }),
  ENDED_CAPTURED_NOT_RECORDED: freeze({ phase: "capture", state: "payment_captured", key: "captured", checkpoint: "AIRBNB_BLOCKED" }),
  ENDED_CONFIRMED: freeze({ phase: "recording", state: "confirmed", key: "confirmed", checkpoint: "AIRBNB_BLOCKED" }),
  ENDED_RELEASED: freeze({ phase: "cleanup" })              // key / checkpoint depend on whether a reservation had existed (orderStep)
});
const COMMON_KEYS = ["v", "seq", "prevHash", "runId", "intentId", "manifestHash", "baselineCommit", "at", "event"];
const EVENT_KEYS = freeze({
  RUN_STARTED: [],
  STEP_STARTED: ["phase", "step", "factory"],
  STEP_ENDED: ["phase", "step", "result", "state", "actions", "unlistedActions", "refusals", "writes"],
  PHASE_ENDED: ["phase", "state"],
  ATTESTED: ["attestation"],
  RUN_STOPPED: ["code", "outstanding", "effectsKnown", "exclusion", "ownerCleanupRequired", "writes"],
  RUN_ENDED: ["outcome", "outstanding", "effectsKnown", "exclusion", "ownerCleanupRequired", "writes"]
});
export const IDENTITY_KEYS = freeze(["baselineCommit", "intentId", "manifestHash", "runId"]);

const RE = { runId: /^[a-z0-9-]{8,64}$/, uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, hash: /^[0-9a-f]{64}$/,
  commit: /^[0-9a-f]{40}$/, code: /^[A-Z][A-Z0-9_]{0,47}$/, refusalCode: /^[A-Z_]{1,40}$/, refusalKey: /^[a-zA-Z]{1,40}(?:\.[a-z]{1,10})?$/,
  rid: /^[1-9][0-9]{0,15}$/, evidenceRef: /^[A-Za-z0-9._:/-]{1,128}$/ };

// ---- getter-free snapshot ---------------------------------------------------------------------------------------------------------
const BAD = Symbol("bad");
const LIMIT = freeze({ depth: 4, keys: 24, array: MAX_RAW_ACTIONS, string: 256 });
/** own enumerable DATA properties only; plain / null prototypes; dense plain arrays; no symbols / accessors / __proto__ / proxies */
function snap(v, depth) {
  if (v === null || typeof v === "boolean") return v;
  if (typeof v === "string") return v.length <= LIMIT.string ? v : BAD;
  if (typeof v === "number") return Number.isFinite(v) ? v : BAD;
  if (typeof v !== "object" || depth > LIMIT.depth || types.isProxy(v)) return BAD;
  const d = getDescs(v);
  const keys = ownKeys(d);
  if (Array.isArray(v)) {
    if (getProto(v) !== ARRAY_PROTO) return BAD;
    const len = d.length;
    if (!len || !("value" in len) || len.value > LIMIT.array || keys.length !== len.value + 1) return BAD;
    const out = [];
    for (let i = 0; i < len.value; i++) {
      const di = d[String(i)];
      if (!di || !("value" in di) || di.enumerable !== true) return BAD;
      const s = snap(di.value, depth + 1); if (s === BAD) return BAD; out.push(s);
    }
    return freeze(out);
  }
  const proto = getProto(v);
  if (proto !== OBJECT_PROTO && proto !== null) return BAD;
  if (keys.length > LIMIT.keys) return BAD;
  const out = Object.create(null);
  for (const k of keys) {
    if (typeof k !== "string" || k === "__proto__" || !("value" in d[k]) || d[k].enumerable !== true) return BAD;
    const s = snap(d[k].value, depth + 1); if (s === BAD) return BAD; out[k] = s;
  }
  return freeze(out);
}
const safeSnap = (v) => { try { return snap(v, 0); } catch { return BAD; } };
const isRec = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const keysExactly = (o, ks) => { const a = Object.keys(o).sort(); const b = [...ks].sort(); return a.length === b.length && a.every((x, i) => x === b[i]); };
const int = (v, lo, hi) => Number.isSafeInteger(v) && v >= lo && v <= hi;

// ---- identity -------------------------------------------------------------------------------------------------------------------------
/** validateIdentity(input) → frozen { ok:true, identity } | frozen { ok:false, code:'IDENTITY_INVALID' } */
export function validateIdentity(input) {
  const m = safeSnap(input);
  if (m === BAD || !isRec(m) || !keysExactly(m, IDENTITY_KEYS)) return freeze({ ok: false, code: "IDENTITY_INVALID" });
  if (typeof m.runId !== "string" || !RE.runId.test(m.runId) || typeof m.intentId !== "string" || !RE.uuid.test(m.intentId)
    || typeof m.manifestHash !== "string" || !RE.hash.test(m.manifestHash) || typeof m.baselineCommit !== "string" || !RE.commit.test(m.baselineCommit)) {
    return freeze({ ok: false, code: "IDENTITY_INVALID" });
  }
  return freeze({ ok: true, identity: m });
}

// ---- action projection (core helper) --------------------------------------------------------------------------------------------
/** projectActions(rawActions) → frozen { ok:true, actions, unlistedActions } | { ok:false, code:'ACTIONS_INVALID' }.
 *  Worker action tokens matching the whole-token grammar are KEPT (in order, at most MAX_ACTIONS); anything else (or beyond the cap) is
 *  only COUNTED, never copied. Inspection is getter-free. */
export function projectActions(raw) {
  const a = safeSnap(raw);
  if (a === BAD || !Array.isArray(a)) return freeze({ ok: false, code: "ACTIONS_INVALID" });
  const kept = []; let unlisted = 0;
  for (const t of a) { if (isActionToken(t) && kept.length < MAX_ACTIONS) kept.push(t); else unlisted += 1; }
  return freeze({ ok: true, actions: freeze(kept), unlistedActions: unlisted });
}

// ---- record validation ------------------------------------------------------------------------------------------------------------
const writesOk = (w) => isRec(w) && keysExactly(w, WRITE_KEYS) && WRITE_KEYS.every((k) => int(w[k], 0, 1000));
/** shape / field validation of ONE snapshotted record (no history) → error code | null */
function fieldCheck(r) {
  if (!isRec(r) || typeof r.event !== "string" || !EVENTS.includes(r.event)) return "RECORD_SHAPE";
  if (!keysExactly(r, [...COMMON_KEYS, ...EVENT_KEYS[r.event]])) return "RECORD_SHAPE";
  if (r.v !== RECORD_VERSION || !int(r.seq, 1, MAX_RECORDS) || typeof r.prevHash !== "string" || !RE.hash.test(r.prevHash) || !int(r.at, 0, 8.64e15)) return "RECORD_FIELD_INVALID";
  if (typeof r.runId !== "string" || !RE.runId.test(r.runId) || typeof r.intentId !== "string" || !RE.uuid.test(r.intentId)
    || typeof r.manifestHash !== "string" || !RE.hash.test(r.manifestHash) || typeof r.baselineCommit !== "string" || !RE.commit.test(r.baselineCommit)) return "RECORD_FIELD_INVALID";
  switch (r.event) {
    case "STEP_STARTED": {
      const f = r.factory;
      if (!STEP_PHASES.includes(r.phase) || !int(r.step, 1, MAX_STEP) || !isRec(f) || !keysExactly(f, ["phase", "reservationId"]) || !FACTORY_PHASES.includes(f.phase)) return "RECORD_FIELD_INVALID";
      if (f.reservationId !== null && (typeof f.reservationId !== "string" || !RE.rid.test(f.reservationId))) return "RECORD_FIELD_INVALID";
      const fp = f.phase === "reservation-recovery" ? "reservation" : f.phase;
      if (fp !== r.phase) return "RECORD_FIELD_INVALID";
      if (f.phase === "reservation-recovery" && f.reservationId === null) return "RECORD_FIELD_INVALID";
      if (f.phase === "reservation" && f.reservationId !== null) return "RECORD_FIELD_INVALID";
      return null;
    }
    case "STEP_ENDED": {
      if (!STEP_PHASES.includes(r.phase) || !int(r.step, 1, MAX_STEP) || !STEP_RESULTS.includes(r.result)) return "RECORD_FIELD_INVALID";
      if (r.state !== null && !INTENT_STATES.includes(r.state)) return "RECORD_FIELD_INVALID";
      if (!Array.isArray(r.actions) || r.actions.length > MAX_ACTIONS || !r.actions.every(isActionToken)) return "ACTION_INVALID";
      if (!int(r.unlistedActions, 0, MAX_RAW_ACTIONS)) return "RECORD_FIELD_INVALID";
      if (!Array.isArray(r.refusals) || r.refusals.length > MAX_REFUSALS
        || !r.refusals.every((x) => isRec(x) && keysExactly(x, ["key", "code"]) && typeof x.key === "string" && RE.refusalKey.test(x.key) && typeof x.code === "string" && RE.refusalCode.test(x.code))) return "RECORD_FIELD_INVALID";
      return writesOk(r.writes) ? null : "RECORD_FIELD_INVALID";
    }
    case "PHASE_ENDED":
      return STEP_PHASES.includes(r.phase) && (r.state === null || INTENT_STATES.includes(r.state)) ? null : "RECORD_FIELD_INVALID";
    case "ATTESTED": {
      const a = r.attestation;
      return isRec(a) && keysExactly(a, ["checkpoint", "evidenceRef"]) && CHECKPOINTS.includes(a.checkpoint) && typeof a.evidenceRef === "string" && RE.evidenceRef.test(a.evidenceRef) ? null : "RECORD_FIELD_INVALID";
    }
    case "RUN_STOPPED":
    case "RUN_ENDED": {
      if (!["NONE", "STEP", "TAIL"].includes(r.outstanding) || typeof r.effectsKnown !== "boolean" || !["held", "lost"].includes(r.exclusion)) return "RECORD_FIELD_INVALID";
      if (r.ownerCleanupRequired !== null && !CLEANUP_KEYS.includes(r.ownerCleanupRequired)) return "RECORD_FIELD_INVALID";
      if (!writesOk(r.writes)) return "RECORD_FIELD_INVALID";
      if (r.outstanding !== "NONE" && r.effectsKnown !== false) return "RECORD_FIELD_INVALID";      // outstanding work ⇒ effects unknown
      if (r.event === "RUN_STOPPED") return typeof r.code === "string" && RE.code.test(r.code) ? null : "RECORD_FIELD_INVALID";
      if (!OUTCOMES.includes(r.outcome) || r.outstanding !== "NONE" || r.effectsKnown !== true) return "RECORD_FIELD_INVALID";
      const rule = OUTCOME_RULES[r.outcome];
      if (rule.key !== undefined && r.ownerCleanupRequired !== rule.key) return "RECORD_FIELD_INVALID";   // exact key per outcome
      if (r.outcome === "ENDED_RELEASED" && r.ownerCleanupRequired !== null && r.ownerCleanupRequired !== "reservedNotConfirmed") return "RECORD_FIELD_INVALID";
      return null;
    }
    default: return null;                                    // RUN_STARTED: common fields only
  }
}

/** validateRecord(input) → frozen { ok:true, record } (the ONE validated frozen copy) | frozen { ok:false, code } — no history checks */
export function validateRecord(input) {
  const r = safeSnap(input);
  if (r === BAD) return freeze({ ok: false, code: "RECORD_SHAPE" });
  const c = fieldCheck(r);
  return c ? freeze({ ok: false, code: c }) : freeze({ ok: true, record: r });
}

/** recordHash(validatedRecord) = sha256(JOURNAL_HASH_PREFIX + canonicalJson(record)) — the accepted manifest canonical JSON (sorted keys) */
export const recordHash = (record) => createHash("sha256").update(JOURNAL_HASH_PREFIX + canonicalJson(record), "utf8").digest("hex");

// ---- event-order state machine ----------------------------------------------------------------------------------------------------
const initialState = () => ({ n: 0, ended: false, phase: null, phaseEnd: new Map(), lastState: Object.create(null), steps: Object.create(null), openStep: null,
  attested: new Set() });
const reservationExisted = (st) => st.phaseEnd.get("reservation") === "reservation_confirmed";
/** apply ONE field-valid record to the order state → error code | null (the state is mutated only on success: callers pass a clone).
 *  Structural lifecycle consistency only — never DB or provider attestation. */
function orderStep(st, r) {
  if (st.ended) return "APPEND_AFTER_TERMINAL";
  if (st.n === 0 && r.event !== "RUN_STARTED") return "ORDER_INVALID";
  if (st.n > 0 && r.event === "RUN_STARTED") return "ORDER_INVALID";
  switch (r.event) {
    case "RUN_STARTED": break;
    case "ATTESTED": {
      const c = r.attestation.checkpoint;
      if (st.openStep || st.attested.has(c)) return "ORDER_INVALID";
      if (c === "CALENDAR_BASELINE" && st.phase !== null) return "ORDER_INVALID";
      if (c === "AIRBNB_BLOCKED" && st.phaseEnd.get("reservation") !== "reservation_confirmed") return "ORDER_INVALID";
      // re-opened only when a reservation had existed AND the cleanup cancelled it
      if (c === "AIRBNB_REOPENED" && !(reservationExisted(st) && st.phaseEnd.get("cleanup") === "cancelled")) return "ORDER_INVALID";
      st.attested.add(c);
      break;
    }
    case "STEP_STARTED": {
      if (st.openStep || !st.attested.has("CALENDAR_BASELINE")) return "ORDER_INVALID";
      if (st.phase !== r.phase) {
        if (st.phase === null) { if (r.phase !== "reservation") return "ORDER_INVALID"; }
        else {
          if (!st.phaseEnd.has(st.phase) || st.phaseEnd.has(r.phase)) return "ORDER_INVALID";
          const from = [st.phase, st.phaseEnd.get(st.phase)];
          const ok = r.phase === "cleanup" ? CLEANUP_ENTRY.some(([p, x]) => p === from[0] && x === from[1])
            : ENTRY[r.phase] !== undefined && ENTRY[r.phase][0] === from[0] && ENTRY[r.phase][1] === from[1];
          if (!ok) return "ORDER_INVALID";
          if (r.phase === "capture" && !st.attested.has("AIRBNB_BLOCKED")) return "ORDER_INVALID";
        }
        st.phase = r.phase;
      } else if (st.phaseEnd.has(r.phase)) return "ORDER_INVALID";
      if (r.step !== (st.steps[r.phase] || 0) + 1) return "ORDER_INVALID";
      st.steps[r.phase] = r.step;
      st.openStep = { phase: r.phase, step: r.step };
      break;
    }
    case "STEP_ENDED":
      if (!st.openStep || st.openStep.phase !== r.phase || st.openStep.step !== r.step) return "ORDER_INVALID";
      st.openStep = null;
      st.lastState[r.phase] = r.state;
      break;
    case "PHASE_ENDED":
      // a phase ends only after ≥ 1 completed step, in the state its LAST completed step reported, and in an allowed end state
      if (st.openStep || st.phase !== r.phase || st.phaseEnd.has(r.phase) || !st.steps[r.phase]) return "ORDER_INVALID";
      if (r.state === null || r.state !== st.lastState[r.phase] || !PHASE_END_STATES[r.phase].includes(r.state)) return "ORDER_INVALID";
      st.phaseEnd.set(r.phase, r.state);
      break;
    case "RUN_STOPPED":
      // a failure stop may close an OPEN logged step with the truthful lifecycle status (NONE after a rejection before any executor
      // start, TAIL after a rejection with a start, STEP after an observation timeout); it never fabricates a STEP_ENDED. With an open
      // step, effects are never claimed known.
      if (st.openStep && r.effectsKnown !== false) return "ORDER_INVALID";
      st.openStep = null; st.ended = true;
      break;
    case "RUN_ENDED": {
      if (st.openStep) return "ORDER_INVALID";
      const rule = OUTCOME_RULES[r.outcome];
      if (st.phase !== rule.phase || !st.phaseEnd.has(rule.phase)) return "ORDER_INVALID";      // the outcome's phase is the LAST one, ended
      if (rule.phase !== "cleanup") {
        if (st.phaseEnd.get(rule.phase) !== rule.state || !st.attested.has(rule.checkpoint)) return "ORDER_INVALID";
      } else {
        const end = st.phaseEnd.get("cleanup");
        if (!reservationExisted(st)) {                        // reservation_failed → void only: nothing standing, nothing to re-open
          if (end !== "authorization_released" || r.ownerCleanupRequired !== null || st.attested.has("AIRBNB_REOPENED")) return "ORDER_INVALID";
        } else if (end === "cancelled") {                     // a reservation existed and was cancelled: Airbnb re-open attested
          if (r.ownerCleanupRequired !== null || !st.attested.has("AIRBNB_REOPENED")) return "ORDER_INVALID";
        } else if (r.ownerCleanupRequired !== "reservedNotConfirmed" || st.attested.has("AIRBNB_REOPENED")) return "ORDER_INVALID";   // it still stands
      }
      st.ended = true;
      break;
    }
    default: return "ORDER_INVALID";
  }
  st.n += 1;
  return null;
}
const cloneState = (st) => ({ ...st, phaseEnd: new Map(st.phaseEnd), lastState: Object.assign(Object.create(null), st.lastState),
  steps: Object.assign(Object.create(null), st.steps), attested: new Set(st.attested), openStep: st.openStep ? { ...st.openStep } : null });
const sameIdentity = (r, id) => IDENTITY_KEYS.every((k) => r[k] === id[k]);

// ---- whole-journal validation (pure) ----------------------------------------------------------------------------------------------
/**
 * validateJournal(records, identityInput, { trustedHead } = {}) → frozen JournalVerdict:
 *   { ok:true, status:'EMPTY', head:null, anchored }                          no record: NOT an authorization (the core's DB eligibility check remains)
 *   { ok:true, status:'IN_PROGRESS', head, openStep:boolean, anchored }       RUN_STARTED, no terminal (internal; the start rule maps it to RESTART_AMBIGUOUS)
 *   { ok:true, status:'ENDED', head, terminal:'RUN_STOPPED'|'RUN_ENDED', anchored }
 *   { ok:false, code, at?: seq }   code ∈ IDENTITY_INVALID, JOURNAL_MALFORMED (shape / field / action / order), MANIFEST_MISMATCH,
 *                                  JOURNAL_CHAIN_INVALID (seq / prevHash), TRUSTED_HEAD_MISMATCH, TRUSTED_HEAD_INVALID
 * Priority: identity input → per-record shape / fields (first bad record) → identity of every record → seq / prevHash chain →
 * event order → trusted head. `anchored` says whether a trusted head was supplied AND matched; an unanchored chain only proves internal
 * consistency, never that the whole history was not replaced.
 */
export function validateJournal(records, identityInput, opts) {
  const idr = validateIdentity(identityInput);
  if (!idr.ok) return freeze({ ok: false, code: "IDENTITY_INVALID" });
  const id = idr.identity;
  let trusted = null;
  if (opts !== undefined) {
    const o = safeSnap(opts);
    if (o === BAD || !isRec(o) || !Object.keys(o).every((k) => k === "trustedHead")) return freeze({ ok: false, code: "TRUSTED_HEAD_INVALID" });
    if (o.trustedHead !== undefined && o.trustedHead !== null) {
      const h = o.trustedHead;
      if (!isRec(h) || !keysExactly(h, ["seq", "hash"]) || !int(h.seq, 0, MAX_RECORDS) || typeof h.hash !== "string" || !RE.hash.test(h.hash)) return freeze({ ok: false, code: "TRUSTED_HEAD_INVALID" });
      trusted = h;
    }
  }
  const list = safeSnapList(records);
  if (list === BAD) return freeze({ ok: false, code: "JOURNAL_MALFORMED" });
  for (const [i, r] of list.entries()) if (fieldCheck(r)) return freeze({ ok: false, code: "JOURNAL_MALFORMED", at: i + 1 });
  for (const [i, r] of list.entries()) if (!sameIdentity(r, id)) return freeze({ ok: false, code: "MANIFEST_MISMATCH", at: i + 1 });
  let prev = GENESIS_HASH;
  for (const [i, r] of list.entries()) {
    if (r.seq !== i + 1 || r.prevHash !== prev) return freeze({ ok: false, code: "JOURNAL_CHAIN_INVALID", at: i + 1 });
    prev = recordHash(r);
  }
  const st = initialState();
  for (const [i, r] of list.entries()) if (orderStep(st, r)) return freeze({ ok: false, code: "JOURNAL_MALFORMED", at: i + 1 });
  const head = list.length ? freeze({ seq: list.length, hash: prev }) : null;
  if (trusted) {
    const match = trusted.seq === 0 ? head === null && trusted.hash === GENESIS_HASH : head !== null && head.seq === trusted.seq && head.hash === trusted.hash;
    if (!match) return freeze({ ok: false, code: "TRUSTED_HEAD_MISMATCH" });
  }
  const anchored = trusted !== null;
  if (!head) return freeze({ ok: true, status: "EMPTY", head: null, anchored });
  if (st.ended) return freeze({ ok: true, status: "ENDED", head, terminal: list.at(-1).event, anchored });
  return freeze({ ok: true, status: "IN_PROGRESS", head, openStep: st.openStep !== null, anchored });
}
/** the records array (≤ MAX_RECORDS) snapshotted element by element, getter-free */
function safeSnapList(records) {
  try {
    if (records === null || typeof records !== "object" || types.isProxy(records) || !Array.isArray(records) || getProto(records) !== ARRAY_PROTO) return BAD;
    const d = getDescs(records);
    const len = d.length;
    if (!len || !("value" in len) || len.value > MAX_RECORDS || ownKeys(d).length !== len.value + 1) return BAD;
    const out = [];
    for (let i = 0; i < len.value; i++) {
      const di = d[String(i)];
      if (!di || !("value" in di) || di.enumerable !== true) return BAD;
      const s = snap(di.value, 0);
      if (s === BAD) return BAD;
      out.push(s);
    }
    return out;
  } catch { return BAD; }
}

/**
 * evaluateStart(readResult, identityInput, { trustedHead } = {}) → frozen StartVerdict (pure; never resumes, never mints a run id / key):
 *   { ok:true,  code:'EMPTY_JOURNAL', dbEligibilityRequired:true, anchored }   the ONLY start-permitting verdict, and only subject to the
 *                                                                             core's separate DB eligibility check (§6.1 P0)
 *   { ok:false, code:'RESTART_AMBIGUOUS', interruptedStep:boolean }           acknowledged RUN_STARTED, no terminal (an unfinished
 *                                                                             STEP_STARTED is crash evidence, not permission to resume)
 *   { ok:false, code:'RUN_ENDED' }                                            a terminal record exists
 *   { ok:false, code:'JOURNAL_PARTIAL' }                                      the read reported a torn tail (synthetic representation)
 *   { ok:false, code:'MANIFEST_MISMATCH' | 'JOURNAL_CHAIN_INVALID' | 'JOURNAL_MALFORMED' | 'TRUSTED_HEAD_MISMATCH' | 'TRUSTED_HEAD_INVALID'
 *               | 'IDENTITY_INVALID' | 'READ_RESULT_INVALID' }
 * readResult = what journal.read() resolved: { records, tail:'complete'|'torn' }.
 */
export function evaluateStart(readResult, identityInput, opts) {
  let rr;
  try {
    if (readResult === null || typeof readResult !== "object" || types.isProxy(readResult) || (getProto(readResult) !== OBJECT_PROTO && getProto(readResult) !== null)) return freeze({ ok: false, code: "READ_RESULT_INVALID" });
    const d = getDescs(readResult);
    const ks = ownKeys(d);
    if (ks.length !== 2 || !ks.every((k) => (k === "records" || k === "tail") && "value" in d[k] && d[k].enumerable === true)) return freeze({ ok: false, code: "READ_RESULT_INVALID" });
    rr = { records: d.records.value, tail: d.tail.value };
  } catch { return freeze({ ok: false, code: "READ_RESULT_INVALID" }); }
  if (rr.tail === "torn") return freeze({ ok: false, code: "JOURNAL_PARTIAL" });
  if (rr.tail !== "complete") return freeze({ ok: false, code: "READ_RESULT_INVALID" });
  const v = validateJournal(rr.records, identityInput, opts);
  if (!v.ok) return freeze({ ok: false, code: v.code });
  if (v.status === "EMPTY") return freeze({ ok: true, code: "EMPTY_JOURNAL", dbEligibilityRequired: true, anchored: v.anchored });
  if (v.status === "ENDED") return freeze({ ok: false, code: "RUN_ENDED", anchored: v.anchored });
  return freeze({ ok: false, code: "RESTART_AMBIGUOUS", interruptedStep: v.openStep, anchored: v.anchored });
}

// ---- the in-memory journal --------------------------------------------------------------------------------------------------------
/** code-only journal error: the ONLY rejection reason this module produces (no caller data, no message detail) */
export class JournalError extends Error {
  constructor(code) { super("JOURNAL_ERROR"); this.name = "JournalError"; this.code = code; Object.freeze(this); }
}
export const FAULT_MODES = freeze(["reject", "hang", "late", "landed_hang"]);
export const READ_FAULT_MODES = freeze(["reject", "hang", "torn"]);
const reject = (code) => Promise.reject(new JournalError(code));

/**
 * createMemoryJournal({ identity, preload?, faults? }) → frozen { ok:true, journal, controls } | frozen { ok:false, code }
 *   identity  { runId, intentId, manifestHash, baselineCommit } — every appended record must carry exactly this identity
 *   preload   SYNTHETIC history for tests (≤ 256 records): snapshotted getter-free and stored AS GIVEN (not order-validated), so that start /
 *             chain / identity refusals can be exercised; append() refuses while the stored history does not validate
 *   faults    TEST-ONLY deterministic plan: { append: { [callNo]: 'reject'|'hang'|'late'|'landed_hang' }, read: { [callNo]: 'reject'|'hang'|'torn' } }
 * journal.append(record) → native Promise<frozen { seq, hash }> | rejects with JournalError(code)
 *   Validation (synchronous, BEFORE any await, on one frozen copy): shape / fields / identity / seq = stored + 1 / prevHash = hash of the
 *   stored tail / event order (incl. the one-terminal rule). Appends are SERIAL: while an earlier append is unacknowledged, every new
 *   append is refused APPEND_IN_FLIGHT, so two appends can never reuse a seq / prevHash or bypass the terminal rule. A refusal never
 *   mutates stored history. No retry, ever; no extra terminal record on failure.
 *   faults: reject → rejected, nothing stored; hang → never stored, never settles; late → stored AND acknowledged only when the test calls
 *   controls.release(callNo); landed_hang → stored immediately, never acknowledged. An observer that timed out cannot tell these apart.
 * journal.read() → native Promise<frozen { records: frozen [frozen record], tail: 'complete' | 'torn' }> | rejects JournalError(code)
 *   ('torn' only from the explicit read fault — a SYNTHETIC representation; memory records are never torn bytes)
 * controls: { release(callNo) → boolean, appendCalls(), readCalls(), size() } — TEST-ONLY, separate from the journal interface.
 */
export function createMemoryJournal(input) {
  const o = safeSnap(input);
  if (o === BAD || !isRec(o) || !Object.keys(o).every((k) => ["identity", "preload", "faults"].includes(k))) return freeze({ ok: false, code: "JOURNAL_OPTIONS_INVALID" });
  const idr = validateIdentity(o.identity);
  if (!idr.ok) return freeze({ ok: false, code: "IDENTITY_INVALID" });
  const identity = idr.identity;
  const stored = [];
  if (o.preload !== undefined) {
    if (!Array.isArray(o.preload) || o.preload.length > MAX_RECORDS) return freeze({ ok: false, code: "JOURNAL_OPTIONS_INVALID" });
    for (const r of o.preload) stored.push(r);              // already snapshotted + frozen by safeSnap(input)
  }
  const plan = { append: Object.create(null), read: Object.create(null) };
  if (o.faults !== undefined) {
    const f = o.faults;
    if (!isRec(f) || !Object.keys(f).every((k) => k === "append" || k === "read")) return freeze({ ok: false, code: "JOURNAL_OPTIONS_INVALID" });
    for (const [kind, modes] of [["append", FAULT_MODES], ["read", READ_FAULT_MODES]]) {
      if (f[kind] === undefined) continue;
      if (!isRec(f[kind])) return freeze({ ok: false, code: "JOURNAL_OPTIONS_INVALID" });
      for (const [n, m] of Object.entries(f[kind])) { if (!/^[1-9][0-9]{0,4}$/.test(n) || !modes.includes(m)) return freeze({ ok: false, code: "JOURNAL_OPTIONS_INVALID" }); plan[kind][n] = m; }
    }
  }
  let appendCalls = 0; let readCalls = 0; let inFlight = false;
  const pendingLate = new Map();                            // callNo → { record, resolve }

  /** the order state and tail of the CURRENTLY STORED history (null when the stored history itself is invalid) */
  function tail() {
    const v = validateJournal(stored, identity);
    if (!v.ok) return null;
    const st = initialState();
    for (const r of stored) orderStep(st, r);
    return { st, head: v.head };
  }
  const store = (rec) => { stored.push(rec); return freeze({ seq: rec.seq, hash: recordHash(rec) }); };

  function append(record) {
    appendCalls += 1;
    const callNo = appendCalls;
    const vr = validateRecord(record);                      // ONE frozen copy, before any await
    if (!vr.ok) return reject(vr.code === "ACTION_INVALID" ? "ACTION_INVALID" : "RECORD_INVALID");
    const r = vr.record;
    if (inFlight) return reject("APPEND_IN_FLIGHT");
    if (!sameIdentity(r, identity)) return reject("IDENTITY_MISMATCH");
    const t = tail();
    if (!t) return reject("JOURNAL_HISTORY_INVALID");
    const expectSeq = t.head ? t.head.seq + 1 : 1;
    const expectPrev = t.head ? t.head.hash : GENESIS_HASH;
    if (r.seq !== expectSeq || r.prevHash !== expectPrev) return reject("CHAIN_MISMATCH");
    const st = cloneState(t.st);
    const oc = orderStep(st, r);
    if (oc) return reject(oc === "APPEND_AFTER_TERMINAL" ? "APPEND_AFTER_TERMINAL" : "ORDER_INVALID");
    if (stored.length >= MAX_RECORDS) return reject("JOURNAL_FULL");
    const mode = plan.append[String(callNo)];
    if (mode === "reject") return reject("INJECTED_APPEND_FAILURE");
    if (mode === "hang") { inFlight = true; return new Promise(() => {}); }
    if (mode === "landed_hang") { inFlight = true; store(r); return new Promise(() => {}); }
    if (mode === "late") {
      inFlight = true;
      return new Promise((resolve) => { pendingLate.set(callNo, { record: r, resolve }); });
    }
    return Promise.resolve(store(r));
  }
  function read() {
    readCalls += 1;
    const mode = plan.read[String(readCalls)];
    if (mode === "reject") return reject("INJECTED_READ_FAILURE");
    if (mode === "hang") return new Promise(() => {});
    return Promise.resolve(freeze({ records: freeze([...stored]), tail: mode === "torn" ? "torn" : "complete" }));
  }
  const journal = freeze({ append, read });
  const controls = freeze({
    /** TEST-ONLY: land + acknowledge a 'late' append now → true; false if there is no such pending append */
    release: (callNo) => {
      const p = pendingLate.get(callNo);
      if (!p) return false;
      pendingLate.delete(callNo);
      const ack = store(p.record);
      inFlight = false;
      p.resolve(ack);
      return true;
    },
    appendCalls: () => appendCalls,
    readCalls: () => readCalls,
    size: () => stored.length
  });
  return freeze({ ok: true, journal, controls });
}
