// scripts/e7-connected/run-journal-memory-v2.mjs — E7 M2-B: MODE-BOUND v2 IN-MEMORY journal foundation (OFFLINE, PURE).
// Note: claude/e7-run-journal-v2.md. The accepted v1 journal (run-journal-memory.mjs), the file journal, run-core, the launcher, workflows
// and workers are UNCHANGED and still consume manifest v1 / journal v1 ONLY. Nothing here is durable, a file / hosted store, a live gate, an
// approval, a DB check, an abort transition or a worker.
//   * Identity is DERIVED from an actually validated v2 manifest (validateRunManifestV2), never from a supplied connection string or an
//     unchecked hash: { manifestVersion, connection, runId, intentId, baselineCommit, manifestHash } is bound into every record, and the SAME
//     frozen binding fixes the checkpoint mode (CALENDAR_* for disconnected, AIRBNB_* for airbnb) and the planned phases throughout
//     construction, append, read-back validation and start evaluation. No default, no inference, no union of modes.
//   * The accepted v1 sequencing, phase-state, write-count, duplicate / terminal and trusted-head / hash-chain rules are applied with the
//     mode's EXACT checkpoint names; capture / recording work is refused when the manifest did not plan it.
//   * testAbortAfterReservation is bound through the manifest hash ONLY: no abort event, transition or release is represented here; a
//     reservation_confirmed run can never end "released" without the v1 cleanup path (which, from reservation, starts only after
//     reservation_failed).
//   * M2-C (claude/e7-run-test-abort-bridge.md): v2-local ABORT_REQUEST_STARTED / ABORT_ACCEPTED records; cleanup may start from
//     reservation_confirmed ONLY after an ABORT_ACCEPTED receipt; a chain without them validates exactly as in M2-B.
//   * Record version 2, hash domain sha256("e7-run-journal-v2\n" + canonical JSON). v1 and v2 records / journals cross-refuse; no v1 journal
//     is relabelled, migrated or adopted.
//   * Every caller value is copied through ONE getter-free own-enumerable-data-descriptor snapshot BEFORE any await (copied v1 rules: the v1
//     snapshot / field / order functions are private and v1 must stay byte-exact). Integrity is RELATIVE TO AN INDEPENDENTLY TRUSTED HEAD
//     (seq + hash); a hash chain alone is not authentication.
import { createHash } from "node:crypto";
import { types } from "node:util";
import { canonicalJson } from "./run-manifest.mjs";
import { validateRunManifestV2, RUN_MANIFEST_V2_VERSION } from "./run-manifest-v2.mjs";
import { INTENT_STATES, EVENTS, STEP_PHASES, FACTORY_PHASES, STEP_RESULTS, OUTCOMES, CLEANUP_KEYS, WRITE_KEYS, PHASE_END_STATES, MAX_RECORDS, MAX_ACTIONS,
  MAX_RAW_ACTIONS, MAX_REFUSALS, MAX_STEP, GENESIS_HASH, isActionToken, JournalError, FAULT_MODES, READ_FAULT_MODES } from "./run-journal-memory.mjs";

export const RUN_JOURNAL_V2_VERSION = "e7-run-journal-v2";
export const RECORD_VERSION_V2 = 2;
export const JOURNAL_V2_HASH_PREFIX = `${RUN_JOURNAL_V2_VERSION}\n`;
export const IDENTITY_V2_KEYS = Object.freeze(["baselineCommit", "connection", "intentId", "manifestHash", "manifestVersion", "runId"]);
/** every checkpoint name either mode knows — used ONLY to tell a cross-mode name (CHECKPOINT_MODE_MISMATCH) from garbage; never a permission */
/** M2-C: the v1 event vocabulary plus the two v2-local abort records */
export const EVENTS_V2 = Object.freeze([...EVENTS, "ABORT_REQUEST_STARTED", "ABORT_ACCEPTED"]);
export const ABORT_QUEUED = Object.freeze(["alert.owner:pending", "hostaway.cancel_reservation:pending", "stripe.void_payment_intent:pending"]);
export const ABORT_REASON = "TEST_ABORT_REQUESTED";
const ABORT_KEYS = ["eventId", "expectedVersion", "paymentIntentId", "planHash", "reservationId"];
const RECEIPT_KEYS = ["appliedVersion", "capture", "claimHeld", "queued", "reason", "state"];
const PI_RE = /^pi_[A-Za-z0-9]{8,64}$/; const RID_RE = /^[1-9][0-9]{0,11}$/;
const KNOWN_CHECKPOINTS = Object.freeze(["CALENDAR_BASELINE", "CALENDAR_BLOCKED", "CALENDAR_REOPENED", "AIRBNB_BLOCKED", "AIRBNB_REOPENED"]);
export { JournalError, GENESIS_HASH };

const freeze = Object.freeze;
const getDescs = Object.getOwnPropertyDescriptors;
const getProto = Object.getPrototypeOf;
const ownKeys = Reflect.ownKeys;
const OBJECT_PROTO = Object.prototype;
const ARRAY_PROTO = Array.prototype;

/** successful terminal outcomes: the phase that must have ENDED last, in which state, the exact cleanup key, and which checkpoint ROLE */
const OUTCOME_RULES = freeze({
  ENDED_RESERVED_NOT_CAPTURED: freeze({ phase: "reservation", state: "reservation_confirmed", key: "reservedNotConfirmed" }),
  ENDED_CAPTURED_NOT_RECORDED: freeze({ phase: "capture", state: "payment_captured", key: "captured" }),
  ENDED_CONFIRMED: freeze({ phase: "recording", state: "confirmed", key: "confirmed" }),
  ENDED_RELEASED: freeze({ phase: "cleanup" })
});
const ENTRY = freeze({ capture: ["reservation", "reservation_confirmed"], recording: ["capture", "payment_captured"] });
const CLEANUP_ENTRY = freeze([["reservation", "reservation_failed"], ["capture", "capture_failed"]]);
const COMMON_KEYS = ["v", "seq", "prevHash", "manifestVersion", "connection", "runId", "intentId", "manifestHash", "baselineCommit", "at", "event"];
const EVENT_KEYS = freeze({
  RUN_STARTED: [], STEP_STARTED: ["phase", "step", "factory"],
  STEP_ENDED: ["phase", "step", "result", "state", "actions", "unlistedActions", "refusals", "writes"], PHASE_ENDED: ["phase", "state"], ATTESTED: ["attestation"],
  RUN_STOPPED: ["code", "outstanding", "effectsKnown", "exclusion", "ownerCleanupRequired", "writes"],
  RUN_ENDED: ["outcome", "outstanding", "effectsKnown", "exclusion", "ownerCleanupRequired", "writes"],
  ABORT_REQUEST_STARTED: ["abort"], ABORT_ACCEPTED: ["abort", "receipt"]
});
const RE = { runId: /^[a-z0-9-]{8,64}$/, uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, hash: /^[0-9a-f]{64}$/,
  commit: /^[0-9a-f]{40}$/, code: /^[A-Z][A-Z0-9_]{0,47}$/, refusalCode: /^[A-Z_]{1,40}$/, refusalKey: /^[a-zA-Z]{1,40}(?:\.[a-z]{1,10})?$/,
  rid: /^[1-9][0-9]{0,15}$/, evidenceRef: /^[A-Za-z0-9._:/-]{1,128}$/ };

// ---- getter-free snapshot (copied v1 rules) ---------------------------------------------------------------------------------------
const BAD = Symbol("bad");
const LIMIT = freeze({ depth: 4, keys: 24, array: MAX_RAW_ACTIONS, string: 256 });
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

// ---- binding: derived ONLY from a validated v2 manifest ----------------------------------------------------------------------------
// M2-G2a binding SEAM: a module-private brand. ONLY binders inside THIS module add to it (G2a: bindManifestV2 alone), so a copied,
// spread, JSON-round-tripped or hand-built binding-shaped object is never accepted by the *Bound entrypoints (BINDING_UNVERIFIED).
const BOUND = new WeakSet();
/** isBoundBindingV2(b) → true iff `b` is a binding minted by this module's verified binder (never by shape / version string) */
export const isBoundBindingV2 = (b) => b !== null && typeof b === "object" && BOUND.has(b);
/**
 * bindManifestV2(manifestInput) → frozen { ok:true, binding } | frozen { ok:false, code:'MANIFEST_INVALID', manifestCode }
 *   binding = { identity: { manifestVersion, connection, runId, intentId, baselineCommit, manifestHash }, checkpoints: { baseline, blocked,
 *   reopened }, phases: { capture, recording, testAbortAfterReservation } } — all from the validated frozen manifest copy and its COMPUTED hash.
 *   The input is first copied through this module's Proxy-refusing snapshot (BAD → MANIFEST_INVALID / manifestCode MANIFEST_SNAPSHOT_REFUSED).
 */
export function bindManifestV2(manifestInput) {
  // the journal's OWN getter-free, Proxy-refusing snapshot of the COMPLETE manifest input comes first (top-level and nested Proxies, revoked
  // Proxies, accessors refuse here with zero caller traps); the accepted v2 validator then sees ONLY that frozen copy
  const s = safeSnap(manifestInput);
  if (s === BAD) return freeze({ ok: false, code: "MANIFEST_INVALID", manifestCode: "MANIFEST_SNAPSHOT_REFUSED" });
  const v = validateRunManifestV2(s);
  if (!v.ok) return freeze({ ok: false, code: "MANIFEST_INVALID", manifestCode: v.code });
  const m = v.manifest; const ck = m.checkpoints;
  const binding = freeze({
    identity: freeze({ manifestVersion: RUN_MANIFEST_V2_VERSION, connection: m.listing.connection, runId: m.runId, intentId: m.intentId, baselineCommit: m.baselineCommit,
      manifestHash: v.hash }),
    checkpoints: freeze({ baseline: ck[0], blocked: ck[1], reopened: ck[2] }),
    phases: freeze({ capture: m.phases.capture, recording: m.phases.recording, testAbortAfterReservation: m.phases.testAbortAfterReservation }),
    /** M2-C: the validated stay / money facts an operator TEST-abort expectation must equal (never defaulted) */
    facts: freeze({ listingId: m.listing.id, currency: m.listing.currency, arrival: m.stay.arrival, departure: m.stay.departure, guests: m.stay.guests,
      amountMinor: m.amountMinor }),
    /** M2-C: the validated FROZEN manifest copy itself, so a consumer can re-bind after an await without touching the caller's object */
    manifest: m
  });
  BOUND.add(binding);
  return freeze({ ok: true, binding });
}
const UNVERIFIED = freeze({ ok: false, code: "BINDING_UNVERIFIED" });

// ---- record validation ------------------------------------------------------------------------------------------------------------
const writesOk = (w) => isRec(w) && keysExactly(w, WRITE_KEYS) && WRITE_KEYS.every((k) => int(w[k], 0, 1000));
/** shape / field validation of ONE snapshotted v2 record (no history, no binding) → error code | null */
function fieldCheck(r) {
  if (!isRec(r) || typeof r.event !== "string" || !EVENTS_V2.includes(r.event)) return "RECORD_SHAPE";
  if (!keysExactly(r, [...COMMON_KEYS, ...EVENT_KEYS[r.event]])) return "RECORD_SHAPE";
  if (r.v !== RECORD_VERSION_V2 || !int(r.seq, 1, MAX_RECORDS) || typeof r.prevHash !== "string" || !RE.hash.test(r.prevHash) || !int(r.at, 0, 8.64e15)) return "RECORD_FIELD_INVALID";
  if (r.manifestVersion !== RUN_MANIFEST_V2_VERSION || (r.connection !== "disconnected" && r.connection !== "airbnb")) return "RECORD_FIELD_INVALID";
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
      return isRec(a) && keysExactly(a, ["checkpoint", "evidenceRef"]) && KNOWN_CHECKPOINTS.includes(a.checkpoint) && typeof a.evidenceRef === "string" && RE.evidenceRef.test(a.evidenceRef) ? null : "RECORD_FIELD_INVALID";
    }
    case "RUN_STOPPED":
    case "RUN_ENDED": {
      if (!["NONE", "STEP", "TAIL"].includes(r.outstanding) || typeof r.effectsKnown !== "boolean" || !["held", "lost"].includes(r.exclusion)) return "RECORD_FIELD_INVALID";
      if (r.ownerCleanupRequired !== null && !CLEANUP_KEYS.includes(r.ownerCleanupRequired)) return "RECORD_FIELD_INVALID";
      if (!writesOk(r.writes)) return "RECORD_FIELD_INVALID";
      if (r.outstanding !== "NONE" && r.effectsKnown !== false) return "RECORD_FIELD_INVALID";
      if (r.event === "RUN_STOPPED") return typeof r.code === "string" && RE.code.test(r.code) ? null : "RECORD_FIELD_INVALID";
      if (!OUTCOMES.includes(r.outcome) || r.outstanding !== "NONE" || r.effectsKnown !== true) return "RECORD_FIELD_INVALID";
      const rule = OUTCOME_RULES[r.outcome];
      if (rule.key !== undefined && r.ownerCleanupRequired !== rule.key) return "RECORD_FIELD_INVALID";
      if (r.outcome === "ENDED_RELEASED" && r.ownerCleanupRequired !== null && r.ownerCleanupRequired !== "reservedNotConfirmed") return "RECORD_FIELD_INVALID";
      return null;
    }
    case "ABORT_REQUEST_STARTED":
    case "ABORT_ACCEPTED": {
      if (!abortOk(r)) return "RECORD_FIELD_INVALID";
      if (r.event === "ABORT_REQUEST_STARTED") return null;
      const x = r.receipt;
      if (!isRec(x) || !keysExactly(x, RECEIPT_KEYS) || x.appliedVersion !== r.abort.expectedVersion + 1 || x.state !== "capture_failed" || x.reason !== ABORT_REASON
        || x.claimHeld !== true || !Array.isArray(x.queued) || x.queued.length !== ABORT_QUEUED.length || x.queued.some((q, i) => q !== ABORT_QUEUED[i])
        || !isRec(x.capture) || !keysExactly(x.capture, ["attempts", "dispatched", "state"]) || x.capture.state !== "pending" || x.capture.attempts !== 0 || x.capture.dispatched !== false) {
        return "RECORD_FIELD_INVALID";
      }
      return null;
    }
    default: return null;
  }
}
/** the abort identity: exact keys, typed values, and the DETERMINISTIC event id for this record's own intent id */
function abortOk(r) {
  const a = r.abort;
  return isRec(a) && keysExactly(a, ABORT_KEYS) && typeof a.planHash === "string" && RE.hash.test(a.planHash) && int(a.expectedVersion, 0, 1_000_000)
    && typeof a.paymentIntentId === "string" && PI_RE.test(a.paymentIntentId) && typeof a.reservationId === "string" && RID_RE.test(a.reservationId)
    && a.eventId === `test-abort:${r.intentId}:${a.paymentIntentId}:${a.reservationId}`;
}
const sameAbort = (a, b) => ABORT_KEYS.every((k) => a[k] === b[k]);
const sameIdentity = (r, id) => IDENTITY_V2_KEYS.every((k) => r[k] === id[k]);
/** binding-dependent record check: the identity, and an ATTESTED checkpoint name must be one of THIS mode's three → code | null */
function bindingCheck(r, b) {
  if (!sameIdentity(r, b.identity)) return "IDENTITY_MISMATCH";
  if (r.event === "ATTESTED") {
    const c = r.attestation.checkpoint; const k = b.checkpoints;
    if (c !== k.baseline && c !== k.blocked && c !== k.reopened) return "CHECKPOINT_MODE_MISMATCH";
  }
  return null;
}

/** validateRecordV2(input, manifestInput) → frozen { ok:true, record } | frozen { ok:false, code } — shape, fields, identity, mode; no history */
export function validateRecordV2(input, manifestInput) {
  const br = bindManifestV2(manifestInput);
  if (!br.ok) return freeze({ ok: false, code: "MANIFEST_INVALID" });
  return recordVerdict(input, br.binding);
}
/** validateRecordBound(input, binding) — validateRecordV2 for a BOUND binding (BINDING_UNVERIFIED otherwise) */
export function validateRecordBound(input, binding) { return isBoundBindingV2(binding) ? recordVerdict(input, binding) : UNVERIFIED; }
function recordVerdict(input, b) {
  const r = safeSnap(input);
  if (r === BAD) return freeze({ ok: false, code: "RECORD_SHAPE" });
  const c = fieldCheck(r) || bindingCheck(r, b);
  return c ? freeze({ ok: false, code: c }) : freeze({ ok: true, record: r });
}
/** recordHashV2(validatedRecord) = sha256("e7-run-journal-v2\n" + canonicalJson(record)) */
export const recordHashV2 = (record) => createHash("sha256").update(JOURNAL_V2_HASH_PREFIX + canonicalJson(record), "utf8").digest("hex");

// ---- event-order state machine (the accepted v1 rules with the mode's exact checkpoint names and the planned phases) --------------
const initialState = () => ({ n: 0, ended: false, phase: null, phaseEnd: new Map(), lastState: Object.create(null), steps: Object.create(null), openStep: null,
  attested: new Set(), abort: null, abortAccepted: false });
const reservationExisted = (st) => st.phaseEnd.get("reservation") === "reservation_confirmed";
function orderStep(st, r, b) {
  const K = b.checkpoints;
  if (st.ended) return "APPEND_AFTER_TERMINAL";
  if (st.n === 0 && r.event !== "RUN_STARTED") return "ORDER_INVALID";
  if (st.n > 0 && r.event === "RUN_STARTED") return "ORDER_INVALID";
  // M2-C: between ABORT_REQUEST_STARTED and its receipt only ABORT_ACCEPTED or RUN_STOPPED may follow
  if (st.abort && !st.abortAccepted && r.event !== "ABORT_ACCEPTED" && r.event !== "RUN_STOPPED") return "ORDER_INVALID";
  switch (r.event) {
    case "RUN_STARTED": break;
    case "ABORT_REQUEST_STARTED":
      if (!b.phases.testAbortAfterReservation) return "PHASE_NOT_PLANNED";
      if (st.openStep || st.abort || st.phase !== "reservation" || st.phaseEnd.get("reservation") !== "reservation_confirmed" || !st.attested.has(K.blocked)) return "ORDER_INVALID";
      st.abort = r.abort;
      break;
    case "ABORT_ACCEPTED":
      if (!st.abort || st.abortAccepted || st.openStep || !sameAbort(st.abort, r.abort)) return "ORDER_INVALID";
      st.abortAccepted = true;
      break;
    case "ATTESTED": {
      const c = r.attestation.checkpoint;
      if (st.openStep || st.attested.has(c)) return "ORDER_INVALID";
      if (c === K.baseline && st.phase !== null) return "ORDER_INVALID";
      if (c === K.blocked && st.phaseEnd.get("reservation") !== "reservation_confirmed") return "ORDER_INVALID";
      if (c === K.reopened && !(reservationExisted(st) && st.phaseEnd.get("cleanup") === "cancelled")) return "ORDER_INVALID";
      st.attested.add(c);
      break;
    }
    case "STEP_STARTED": {
      if (st.openStep || !st.attested.has(K.baseline)) return "ORDER_INVALID";
      if ((r.phase === "capture" && !b.phases.capture) || (r.phase === "recording" && !b.phases.recording)) return "PHASE_NOT_PLANNED";
      if (st.phase !== r.phase) {
        if (st.phase === null) { if (r.phase !== "reservation") return "ORDER_INVALID"; }
        else {
          if (!st.phaseEnd.has(st.phase) || st.phaseEnd.has(r.phase)) return "ORDER_INVALID";
          const from = [st.phase, st.phaseEnd.get(st.phase)];
          // M2-C: (reservation, reservation_confirmed) → cleanup ONLY after a journalled ABORT_ACCEPTED receipt (DB: capture_failed / TEST_ABORT_REQUESTED)
          const abortEntry = st.abortAccepted && from[0] === "reservation" && from[1] === "reservation_confirmed";
          const ok = r.phase === "cleanup" ? abortEntry || CLEANUP_ENTRY.some(([p, x]) => p === from[0] && x === from[1])
            : !st.abort && ENTRY[r.phase] !== undefined && ENTRY[r.phase][0] === from[0] && ENTRY[r.phase][1] === from[1];
          if (!ok) return "ORDER_INVALID";
          if (r.phase === "capture" && !st.attested.has(K.blocked)) return "ORDER_INVALID";
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
      if (st.openStep || st.phase !== r.phase || st.phaseEnd.has(r.phase) || !st.steps[r.phase]) return "ORDER_INVALID";
      if (r.state === null || r.state !== st.lastState[r.phase] || !PHASE_END_STATES[r.phase].includes(r.state)) return "ORDER_INVALID";
      st.phaseEnd.set(r.phase, r.state);
      break;
    case "RUN_STOPPED":
      if (st.openStep && r.effectsKnown !== false) return "ORDER_INVALID";
      st.openStep = null; st.ended = true;
      break;
    case "RUN_ENDED": {
      if (st.openStep) return "ORDER_INVALID";
      const rule = OUTCOME_RULES[r.outcome];
      if ((r.outcome === "ENDED_CAPTURED_NOT_RECORDED" && !b.phases.capture) || (r.outcome === "ENDED_CONFIRMED" && !b.phases.recording)) return "PHASE_NOT_PLANNED";
      if (st.abort && r.outcome !== "ENDED_RELEASED") return "ORDER_INVALID";      // after an abort record the DB state changed / is uncertain
      if (st.phase !== rule.phase || !st.phaseEnd.has(rule.phase)) return "ORDER_INVALID";
      if (rule.phase !== "cleanup") {
        if (st.phaseEnd.get(rule.phase) !== rule.state || !st.attested.has(K.blocked)) return "ORDER_INVALID";
      } else {
        const end = st.phaseEnd.get("cleanup");
        if (!reservationExisted(st)) {
          if (end !== "authorization_released" || r.ownerCleanupRequired !== null || st.attested.has(K.reopened)) return "ORDER_INVALID";
        } else if (end === "cancelled") {
          if (r.ownerCleanupRequired !== null || !st.attested.has(K.reopened)) return "ORDER_INVALID";
        } else if (r.ownerCleanupRequired !== "reservedNotConfirmed" || st.attested.has(K.reopened)) return "ORDER_INVALID";
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
  steps: Object.assign(Object.create(null), st.steps), attested: new Set(st.attested), openStep: st.openStep ? { ...st.openStep } : null,
  abort: st.abort, abortAccepted: st.abortAccepted });

// ---- whole-journal validation (pure) ----------------------------------------------------------------------------------------------
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
function trustedHeadOf(opts) {
  if (opts === undefined) return { trusted: null };
  const o = safeSnap(opts);
  if (o === BAD || !isRec(o) || !Object.keys(o).every((k) => k === "trustedHead")) return { bad: true };
  if (o.trustedHead === undefined || o.trustedHead === null) return { trusted: null };
  const h = o.trustedHead;
  if (!isRec(h) || !keysExactly(h, ["seq", "hash"]) || !int(h.seq, 0, MAX_RECORDS) || typeof h.hash !== "string" || !RE.hash.test(h.hash)) return { bad: true };
  return { trusted: h };
}
/** verdict over a snapshotted list with a binding (shared by validateJournalV2 and the journal) */
function journalVerdict(list, b, trusted) {
  for (const [i, r] of list.entries()) if (fieldCheck(r)) return freeze({ ok: false, code: "JOURNAL_MALFORMED", at: i + 1 });
  for (const [i, r] of list.entries()) if (!sameIdentity(r, b.identity)) return freeze({ ok: false, code: "MANIFEST_MISMATCH", at: i + 1 });
  for (const [i, r] of list.entries()) if (bindingCheck(r, b)) return freeze({ ok: false, code: "CHECKPOINT_MODE_MISMATCH", at: i + 1 });
  let prev = GENESIS_HASH;
  for (const [i, r] of list.entries()) {
    if (r.seq !== i + 1 || r.prevHash !== prev) return freeze({ ok: false, code: "JOURNAL_CHAIN_INVALID", at: i + 1 });
    prev = recordHashV2(r);
  }
  const st = initialState();
  for (const [i, r] of list.entries()) { const c = orderStep(st, r, b); if (c) return freeze({ ok: false, code: c === "PHASE_NOT_PLANNED" ? "PHASE_NOT_PLANNED" : "JOURNAL_MALFORMED", at: i + 1 }); }
  const head = list.length ? freeze({ seq: list.length, hash: prev }) : null;
  if (trusted) {
    const match = trusted.seq === 0 ? head === null && trusted.hash === GENESIS_HASH : head !== null && head.seq === trusted.seq && head.hash === trusted.hash;
    if (!match) return freeze({ ok: false, code: "TRUSTED_HEAD_MISMATCH" });
  }
  const anchored = trusted !== null;
  if (!head) return freeze({ ok: true, status: "EMPTY", head: null, anchored, st });
  if (st.ended) return freeze({ ok: true, status: "ENDED", head, terminal: list.at(-1).event, anchored, st });
  return freeze({ ok: true, status: "IN_PROGRESS", head, openStep: st.openStep !== null, anchored, st });
}
/**
 * journalFactsV2(records, manifestInput, { trustedHead } = {}) → frozen { ok:true, status, head, anchored, facts } | frozen { ok:false, code }
 *   facts: { reservationEnd, blockedAttested, abortStarted, abortAccepted, openStep, ended, abortReady, cleanupEntryPermitted } — derived from
 *   the SAME validation as validateJournalV2 (a trusted producer's record; anchored only when a trusted head matched).
 */
export function journalFactsV2(records, manifestInput, opts) {
  const br = bindManifestV2(manifestInput);
  if (!br.ok) return freeze({ ok: false, code: "MANIFEST_INVALID" });
  return factsVerdict(records, br, opts);
}
/** journalFactsBound(records, binding, opts?) — journalFactsV2 for a BOUND binding (BINDING_UNVERIFIED otherwise) */
export function journalFactsBound(records, binding, opts) { return isBoundBindingV2(binding) ? factsVerdict(records, { binding }, opts) : UNVERIFIED; }
function factsVerdict(records, br, opts) {
  const th = trustedHeadOf(opts);
  if (th.bad) return freeze({ ok: false, code: "TRUSTED_HEAD_INVALID" });
  const list = safeSnapList(records);
  if (list === BAD) return freeze({ ok: false, code: "JOURNAL_MALFORMED" });
  const v = journalVerdict(list, br.binding, th.trusted);
  if (!v.ok) return v;
  const st = v.st; const K = br.binding.checkpoints;
  const reservationEnd = st.phaseEnd.get("reservation") ?? null;
  const blockedAttested = st.attested.has(K.blocked);
  const abortReady = !st.ended && !st.openStep && !st.abort && br.binding.phases.testAbortAfterReservation && st.phase === "reservation"
    && reservationEnd === "reservation_confirmed" && blockedAttested;
  return freeze({ ok: true, status: v.status, head: v.head, anchored: v.anchored, facts: freeze({ reservationEnd, blockedAttested, abortStarted: st.abort !== null,
    abortAccepted: st.abortAccepted, openStep: st.openStep !== null, ended: st.ended, abortReady,
    cleanupEntryPermitted: !st.ended && !st.openStep && st.abortAccepted && st.phase === "reservation" }) });
}
const publicVerdict = (v) => { if (!v.ok) return v; const { st, ...rest } = v; void st; return freeze(rest); };

/**
 * validateJournalV2(records, manifestInput, { trustedHead } = {}) → frozen verdict (v1 statuses / codes) plus MANIFEST_INVALID,
 *   CHECKPOINT_MODE_MISMATCH and PHASE_NOT_PLANNED. Priority: manifest → trusted-head option → per-record shape / fields → identity →
 *   checkpoint mode → seq / prevHash chain → event order → trusted head. `anchored` = a trusted head was supplied AND matched.
 */
export function validateJournalV2(records, manifestInput, opts) {
  const br = bindManifestV2(manifestInput);
  if (!br.ok) return freeze({ ok: false, code: "MANIFEST_INVALID" });
  return journalPublic(records, br.binding, opts);
}
/** validateJournalBound(records, binding, opts?) — validateJournalV2 for a BOUND binding (BINDING_UNVERIFIED otherwise) */
export function validateJournalBound(records, binding, opts) { return isBoundBindingV2(binding) ? journalPublic(records, binding, opts) : UNVERIFIED; }
function journalPublic(records, b, opts) {
  const th = trustedHeadOf(opts);
  if (th.bad) return freeze({ ok: false, code: "TRUSTED_HEAD_INVALID" });
  const list = safeSnapList(records);
  if (list === BAD) return freeze({ ok: false, code: "JOURNAL_MALFORMED" });
  return publicVerdict(journalVerdict(list, b, th.trusted));
}

/** evaluateStartV2(readResult, manifestInput, { trustedHead } = {}) → the v1 start verdicts (EMPTY_JOURNAL is the only start-permitting one,
 *  and only subject to the core's separate DB eligibility check; RESTART_AMBIGUOUS / RUN_ENDED / JOURNAL_PARTIAL / refusal codes otherwise) */
export function evaluateStartV2(readResult, manifestInput, opts) { return startVerdict(readResult, (records) => validateJournalV2(records, manifestInput, opts)); }
/** evaluateStartBound(readResult, binding, opts?) — evaluateStartV2 for a BOUND binding (BINDING_UNVERIFIED otherwise) */
export function evaluateStartBound(readResult, binding, opts) {
  if (!isBoundBindingV2(binding)) return UNVERIFIED;
  return startVerdict(readResult, (records) => journalPublic(records, binding, opts));
}
function startVerdict(readResult, validate) {
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
  const v = validate(rr.records);
  if (!v.ok) return freeze({ ok: false, code: v.code });
  if (v.status === "EMPTY") return freeze({ ok: true, code: "EMPTY_JOURNAL", dbEligibilityRequired: true, anchored: v.anchored });
  if (v.status === "ENDED") return freeze({ ok: false, code: "RUN_ENDED", anchored: v.anchored });
  return freeze({ ok: false, code: "RESTART_AMBIGUOUS", interruptedStep: v.openStep, anchored: v.anchored });
}

// ---- the in-memory v2 journal (memory-only; NEVER a durable or hosted gate) ---------------------------------------------------------
const reject = (code) => Promise.reject(new JournalError(code));
/**
 * createMemoryJournalV2({ manifest, preload?, faults? }) → frozen { ok:true, journal, controls, identity } | frozen { ok:false, code }
 *   manifest: the v2 manifest INPUT — validated here; its frozen binding (identity, checkpoint mode, planned phases) is fixed for the life of
 *   the journal (caller mutation after construction cannot change it). preload / faults: the v1 TEST-ONLY semantics.
 * journal.append(record) → Promise<frozen { seq, hash }> | rejects JournalError(code): validated synchronously on ONE frozen copy BEFORE any
 *   await (shape / fields → identity → checkpoint mode → seq / prevHash → order incl. planned phases / one terminal); serial (APPEND_IN_FLIGHT);
 *   no retry; a refusal never mutates stored history. journal.read() → Promise<frozen { records, tail }>.
 */
export function createMemoryJournalV2(input) {
  const o = safeSnap(input);
  if (o === BAD || !isRec(o) || !Object.keys(o).every((k) => ["manifest", "preload", "faults"].includes(k))) return freeze({ ok: false, code: "JOURNAL_OPTIONS_INVALID" });
  const br = bindManifestV2(o.manifest);
  if (!br.ok) return freeze({ ok: false, code: "MANIFEST_INVALID" });
  const b = br.binding;
  const stored = [];
  if (o.preload !== undefined) {
    if (!Array.isArray(o.preload) || o.preload.length > MAX_RECORDS) return freeze({ ok: false, code: "JOURNAL_OPTIONS_INVALID" });
    for (const r of o.preload) stored.push(r);
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
  const pendingLate = new Map();
  function tail() { const v = journalVerdict(stored, b, null); return v.ok ? { st: v.st, head: v.head } : null; }
  const store = (rec) => { stored.push(rec); return freeze({ seq: rec.seq, hash: recordHashV2(rec) }); };
  function append(record) {
    appendCalls += 1;
    const callNo = appendCalls;
    const r = safeSnap(record);                                 // ONE frozen copy, before any await
    if (r === BAD) return reject("RECORD_INVALID");
    const fc = fieldCheck(r);
    if (fc) return reject(fc === "ACTION_INVALID" ? "ACTION_INVALID" : "RECORD_INVALID");
    if (inFlight) return reject("APPEND_IN_FLIGHT");
    const bc = bindingCheck(r, b);
    if (bc) return reject(bc);
    const t = tail();
    if (!t) return reject("JOURNAL_HISTORY_INVALID");
    const expectSeq = t.head ? t.head.seq + 1 : 1;
    const expectPrev = t.head ? t.head.hash : GENESIS_HASH;
    if (r.seq !== expectSeq || r.prevHash !== expectPrev) return reject("CHAIN_MISMATCH");
    const st = cloneState(t.st);
    const oc = orderStep(st, r, b);
    if (oc) return reject(oc === "APPEND_AFTER_TERMINAL" || oc === "PHASE_NOT_PLANNED" ? oc : "ORDER_INVALID");
    if (stored.length >= MAX_RECORDS) return reject("JOURNAL_FULL");
    const mode = plan.append[String(callNo)];
    if (mode === "reject") return reject("INJECTED_APPEND_FAILURE");
    if (mode === "hang") { inFlight = true; return new Promise(() => {}); }
    if (mode === "landed_hang") { inFlight = true; store(r); return new Promise(() => {}); }
    if (mode === "late") { inFlight = true; return new Promise((resolve) => { pendingLate.set(callNo, { record: r, resolve }); }); }
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
    release: (callNo) => {
      const p = pendingLate.get(callNo);
      if (!p) return false;
      pendingLate.delete(callNo);
      const ack = store(p.record); inFlight = false; p.resolve(ack);
      return true;
    },
    appendCalls: () => appendCalls, readCalls: () => readCalls, size: () => stored.length
  });
  return freeze({ ok: true, journal, controls, identity: b.identity });
}
