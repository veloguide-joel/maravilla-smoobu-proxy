// E4 CONNECTED-LISTING recovery readiness (OFFLINE-BUILT FOR REVIEW). Inspects, classifies and (optionally) reconciles
// READ-ONLY the ONE bound run of the connected launcher. It NEVER writes to a provider, never creates, never cancels, never
// retries, never resumes the run and never writes a file. It cannot address any other run, reservation or journal:
// the run directory is derived exactly as the launcher derives it (checkout base + manifest hash, location token bound).
//
// Like the launcher, there is no direct command line; a reviewed owner wrapper drives runConnectedRecoverCli(argv, deps).
//   --inspect   --manifest <m.json> --reviewed-commit <40 hex> --location <12 hex>      offline: journal only, no network
//   --reconcile --manifest <m.json> --reviewed-commit <40 hex> --location <12 hex>      + read-only provider reads
//
// Order: strict args -> provenance of CONNECTED_RECOVER_SOURCES at --reviewed-commit -> manifest structure and hash ->
// location token -> the run directory must be a real directory holding exactly the run's journal -> strict journal parse
// and classification. --reconcile then asks deps.prompt (owner's private entry) and reads at most: one read by id (only
// the id THIS journal recorded consistently; protected ids never), one bounded ref lookup on 603566 for the run's ref,
// one calendar read of the run's nights. Output: codes, this run's id/ref, dates, minor units, identity field NAMES.
// A reservation that still looks active is reported as OWNER_DECISION_REQUIRED with the exact identity proof and the
// run's unused budget; any extra cancellation needs a SEPARATE explicit owner decision and a separately reviewed tool.

import { readFileSync, statSync, lstatSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyProvenance, makeGit } from "../e4-launcher/happy-execute.mjs";
import { createHostawayTransport, HOSTAWAY_BASE } from "../e4-transport/hostaway-transport.mjs";
import { readJournalFile, journalFileName } from "../e4-write-runner/journal.mjs";
import { READ_QUERY, RunnerError, createGate, parseReservationResponse, identityMismatches, sanitizeJournalEntry } from "../e4-write-runner/runner.mjs";
import { connectedTestAdapterConfig, lookupByRef, LOOKUP_MAX_PAGES, DIRECT_CHANNEL_ID, REF_RE, MISMATCH_FIELDS } from "../../lib/hostaway-reservations.js";
import { nightsState } from "./safeguards.mjs";
import { validateConnectedManifest, stayNights, CONNECTED_STEPS, CONNECTED_PROTECTED_RESERVATION_IDS, CONNECTED_WRITE_BUDGET, CONNECTED_HISTORICAL_RUN_IDS,
  CONNECTED_VERIFY_MARKER_CODES, CONNECTED_VERIFY_READ_CODES, CONNECTED_VERIFY_LOOKUP_CODES } from "./connected-path.mjs";
import { connectedRunLocation, CONNECTED_EXECUTE_SOURCES } from "./connected-execute.mjs";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const CONNECTED_RECOVER_VERSION = "e4-connected-recover-v1";
export const CONNECTED_RECOVER_SOURCES = Object.freeze([...CONNECTED_EXECUTE_SOURCES, "scripts/e4-connected/connected-recover.mjs"]);
export const CONNECTED_RECOVER_EXIT = Object.freeze({ OK: 0, USAGE: 64, REFUSED: 2, ATTENTION: 3, INTERNAL: 70 });
const RECOVER_STEPS = Object.freeze({ RC_READ: Object.freeze({ reads: 1, writes: 0 }), RC_LOOKUP: Object.freeze({ reads: LOOKUP_MAX_PAGES, writes: 0 }),
  RC_CALENDAR: Object.freeze({ reads: 1, writes: 0 }) });
const JOURNAL_TYPES = Object.freeze(["run-start", "intent", "outcome", "read", "side-effect-check", "halt", "reconcile", "run-end"]);
const MAX_MANIFEST_BYTES = 16384;
export const MAX_JOURNAL_BYTES = 1048576;   // a complete connected run journal is a few KB
const L = 603566;
// The manifest's lead-time rule is an approval rule, not an identity rule: the hash is recomputed with a fixed early clock
// so that recovery stays possible after the approval window. It authorizes nothing.
const STRUCTURE_CLOCK = () => new Date("2000-01-01T00:00:00.000Z");

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isPosInt = (v) => Number.isSafeInteger(v) && v > 0;
// Protected ids for the recovery of the run bound to `manifestHash`: every protected id, EXCEPT the one id the historical run
// with exactly that manifest hash itself created (read-only recovery of its own journal keeps working). Any other run: all protected.
export const recoveryProtection = (manifestHash) => {
  const own = Object.prototype.hasOwnProperty.call(CONNECTED_HISTORICAL_RUN_IDS, manifestHash) ? CONNECTED_HISTORICAL_RUN_IDS[manifestHash] : null;
  return (v) => CONNECTED_PROTECTED_RESERVATION_IDS.includes(Number(v)) && Number(v) !== own;
};
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
const freeze = (o) => { if (o && typeof o === "object" && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) freeze(v); } return o; };

// The create outcome's sanitized evidence (already revalidated at the disk boundary): only the mismatching identity field
// NAMES the create reply was classified with, and the integer HTTP status. Never values.
function createEvidence(co) {
  const ev = isObj(co.evidence) ? co.evidence : null;
  if (!ev) return {};
  const names = Array.isArray(ev.mismatches) ? ev.mismatches.filter((f) => MISMATCH_FIELDS.includes(f)) : [];
  return { ...(names.length ? { replyMismatchFields: names } : {}), ...(Number.isSafeInteger(ev.httpStatus) && ev.httpStatus >= 100 && ev.httpStatus <= 599 ? { replyHttpStatus: ev.httpStatus } : {}) };
}

// Categorical per-night calendar shape (documented calendar-day fields only; enums or bounded small integers; never price,
// note, reservations or any raw string): for reading API/UI discrepancies without dumping the provider body.
const DAY_STATUSES = Object.freeze(["available", "blocked", "mblocked", "hardBlock", "conflicted", "reserved", "pending", "mreserved"]);
const COUNT_KEYS = Object.freeze(["countAvailableUnits", "availableUnitsToSell", "countPendingUnits", "countBlockedUnits", "countReservedUnits"]);
export function calendarNightShapes(resp, nights) {
  const ok = isObj(resp) && !resp.transportError && resp.httpStatus === 200 && isObj(resp.json) && resp.json.status === "success" && Array.isArray(resp.json.result);
  if (!ok) return null;
  const bit = (v) => (v === 1 || v === true ? "TRUE" : v === 0 || v === false ? "FALSE" : v === null || v === undefined ? "ABSENT" : "OTHER");
  return nights.map((date) => {
    const d = resp.json.result.filter((x) => isObj(x) && x.date === date);
    if (d.length !== 1) return { date, code: d.length ? "NIGHT_DUPLICATED" : "NIGHT_MISSING" };
    const x = d[0];
    const counts = {};
    for (const k of COUNT_KEYS) counts[k] = Number.isSafeInteger(x[k]) && x[k] >= 0 && x[k] <= 99 ? x[k] : x[k] === null || x[k] === undefined ? "ABSENT" : "OTHER";
    return { date, status: DAY_STATUSES.includes(x.status) ? x.status : x.status === undefined ? "ABSENT" : "OTHER", isAvailable: bit(x.isAvailable), isProcessed: bit(x.isProcessed),
      ...counts, reservationsListed: Array.isArray(x.reservations) ? Math.min(x.reservations.length, 99) : "ABSENT" };
  });
}

const LATER_STEPS = Object.freeze(["K3_SIDE_EFFECTS_CREATE", "K4_READBACK", "K5_LOOKUP_REF", "K6_CALENDAR_BLOCKED", "A1_AIRBNB_AFTER_CREATE", "K7_PRECANCEL",
  "KW2_CANCEL", "K8_POSTCANCEL", "K9_SIDE_EFFECTS_CANCEL", "K10_CALENDAR_REOPENED", "A2_AIRBNB_AFTER_CANCEL"]);
const KV_ROLES = Object.freeze([
  { step: "KV1_READ_VERIFY", kind: "read", codes: CONNECTED_VERIFY_MARKER_CODES },
  { step: "KV1_READ_VERIFY", kind: "read", codes: CONNECTED_VERIFY_READ_CODES },
  { step: "KV2_LOOKUP_VERIFY", kind: "lookup", codes: CONNECTED_VERIFY_LOOKUP_CODES }
]);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const is2xx = (v) => Number.isSafeInteger(v) && v >= 200 && v <= 299;   // = classifyCreateResponse / parseReservationResponse success range
/** The create outcome qualifies for the read-only path only exactly as the producer writes it. -> positive id | null */
function unechoedRefOutcomeId(co, isProtected) {
  if (!isObj(co) || co.code !== "RESERVATION_MISMATCH" || co.transport !== undefined || !isObj(co.evidence)) return null;
  const ev = co.evidence;
  if (ev.outcome !== "conflict" || ev.code !== "RESERVATION_MISMATCH" || !is2xx(ev.httpStatus)) return null;
  if (!Array.isArray(ev.mismatches) || ev.mismatches.length !== 1 || ev.mismatches[0] !== "bookingRef") return null;
  if (!isPosInt(ev.reservationId) || isProtected(ev.reservationId) || has(ev, "reservation")) return null;
  return ev.reservationId;
}
function verifyKvSequence({ kvAt, co, coIdx, firstHaltIdx, xiIdx, laterIdx, ref, isProtected }) {
  const out = { conflicts: [], readVerified: false, refEcho: null, readVerify: null, lookupVerify: null };
  if (!kvAt.length) return out;
  const en = (x, list) => (x === undefined || x === null ? null : list.includes(x) ? x : "OTHER");
  const add = (c) => { if (!out.conflicts.includes(c)) out.conflicts.push(c); };
  // reported codes by POSITION (role), never by guessing from the code text
  for (let r = 0; r < kvAt.length && r < 3; r++) {
    const val = en(kvAt[r][1].code, KV_ROLES[r].codes);
    if (r === 0) out.refEcho = val; else if (r === 1) out.readVerify = val; else out.lookupVerify = val;
  }
  const coId = unechoedRefOutcomeId(co, isProtected);
  if (coIdx < 0 || kvAt[0][0] < coIdx) add("CREATE_VERIFICATION_BEFORE_CREATE_OUTCOME");
  if (coId === null) add("CREATE_VERIFICATION_WITHOUT_UNECHOED_REF");
  if (kvAt.length > 3) add("CREATE_VERIFICATION_DUPLICATED");
  if (firstHaltIdx >= 0 && kvAt.some(([i]) => i > firstHaltIdx)) add("CREATE_VERIFICATION_AFTER_HALT");
  if (xiIdx >= 0 && kvAt.some(([i]) => i > xiIdx)) add("CREATE_VERIFICATION_AFTER_CANCEL");
  if (laterIdx.length && kvAt.some(([i]) => i > laterIdx[0])) add("CREATE_VERIFICATION_AFTER_LATER_STEP");
  kvAt.forEach(([i, e], r) => {
    const role = KV_ROLES[Math.min(r, 2)];
    if (coIdx < 0 || i !== coIdx + 1 + r) add("CREATE_VERIFICATION_OUT_OF_ORDER");     // contiguous: outcome, marker, read, lookup
    if (e.step !== role.step || e.kind !== role.kind) add("CREATE_VERIFICATION_OUT_OF_ORDER");
    if (!role.codes.includes(e.code)) {
      // a code of ANOTHER role in this slot is an ordering violation (e.g. the read before the marker); otherwise unknown
      add(KV_ROLES.some((o) => o !== role && o.codes.includes(e.code)) ? "CREATE_VERIFICATION_OUT_OF_ORDER" : "CREATE_VERIFICATION_CODE_UNKNOWN");
    }
    if (r < 2) {                                                                         // marker and read: the outcome id, always
      if (!isPosInt(e.reservationId) || e.reservationId !== coId) add("CREATE_VERIFICATION_ID_NOT_BOUND");
      if (has(e, "ref")) add("CREATE_VERIFICATION_CONTRADICTORY");
    } else {
      if (e.ref !== ref) add("CREATE_VERIFICATION_REF_NOT_BOUND");
      if (has(e, "reservationId") && e.reservationId !== coId) add("CREATE_VERIFICATION_ID_NOT_BOUND");
    }
  });
  // success / marker codes must not coexist with contradicting metadata
  const [m, rd, lk] = [kvAt[0]?.[1], kvAt[1]?.[1], kvAt[2]?.[1]];
  const extra = (e, allowed) => Object.keys(e).some((k) => !allowed.includes(k));
  if (m && extra(m, ["type", "step", "kind", "code", "reservationId", "at"])) add("CREATE_VERIFICATION_CONTRADICTORY");
  if (rd && rd.code === "VERIFY_READ_IDENTITY_OK" && (!is2xx(rd.httpStatus) || extra(rd, ["type", "step", "kind", "code", "reservationId", "httpStatus", "at"]))) add("CREATE_VERIFICATION_CONTRADICTORY");
  if (rd && rd.code === "VERIFY_READ_IDENTITY_MISMATCH" && !(Array.isArray(rd.mismatches) && rd.mismatches.length)) add("CREATE_VERIFICATION_CONTRADICTORY");
  if (lk && lk.code === "VERIFY_LOOKUP_SAME_ID_IDENTITY_OK" && (lk.reservationId !== coId || extra(lk, ["type", "step", "kind", "code", "ref", "reservationId", "at"]))) add("CREATE_VERIFICATION_CONTRADICTORY");
  if (lk && lk.code === "VERIFY_LOOKUP_IDENTITY_MISMATCH" && !(Array.isArray(lk.mismatches) && lk.mismatches.length)) add("CREATE_VERIFICATION_CONTRADICTORY");
  // a later-success after an earlier failure (the producer halts on any KV failure)
  if (rd && rd.code !== "VERIFY_READ_IDENTITY_OK" && lk) add("CREATE_VERIFICATION_CONTRADICTORY");
  out.readVerified = !out.conflicts.length && kvAt.length === 3 && out.readVerify === "VERIFY_READ_IDENTITY_OK" &&
    out.lookupVerify === "VERIFY_LOOKUP_SAME_ID_IDENTITY_OK" && out.refEcho !== null && out.refEcho !== "OTHER";
  return out;
}

/**
 * Pure classification of the bound run's journal. -> { ok:false, code } for a journal that is not exactly this run's, else
 * { ok:true, state, ... } where state is one of:
 *   NO_CREATE_ATTEMPTED | CREATE_OUTCOME_MISSING | CREATE_NOT_VERIFIED | CREATED_NO_CANCEL_ATTEMPT |
 *   CANCEL_OUTCOME_MISSING | CANCEL_NOT_VERIFIED | CANCEL_VERIFIED
 */
export function classifyConnectedJournal(entries, manifestHash) {
  const bad = (code) => freeze({ ok: false, code });
  if (!Array.isArray(entries) || entries.length === 0) return bad("JOURNAL_EMPTY");
  const first = entries[0];
  if (!isObj(first) || first.type !== "run-start") return bad("JOURNAL_NO_RUN_START");
  if (first.manifestHash !== manifestHash) return bad("JOURNAL_FOREIGN_MANIFEST");
  if (!Array.isArray(first.refs) || first.refs.length !== 2 || !first.refs.every((r) => typeof r === "string" && REF_RE.test(r))) return bad("JOURNAL_REFS_INVALID");
  const ref = first.refs[1];
  const intents = { create: [], cancel: [] }; const outcomes = { create: [], cancel: [] };
  const isProtected = recoveryProtection(manifestHash);
  const ids = new Set(); let protectedSeen = false; let halt = null; let runEnd = null;
  const kvAt = [];                 // [index, entry] of every KV data entry, in journal order
  let coIdx = -1; let firstHaltIdx = -1; let xiIdx = -1; const laterIdx = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!isObj(e) || !JOURNAL_TYPES.includes(e.type)) return bad("JOURNAL_UNEXPECTED_ENTRY");
    // Disk boundary: every loaded entry must be EXACTLY what the reviewed sanitizer would keep (connected step names),
    // so no raw value, object or unknown field can ever reach the output. Any difference refuses the journal.
    if (canonical(sanitizeJournalEntry(e, { steps: CONNECTED_STEPS })) !== canonical(e)) return bad("JOURNAL_ENTRY_NOT_SANITIZED");
    if (e.type === "run-start" && i !== 0) return bad("JOURNAL_SECOND_RUN_START");
    if (Object.prototype.hasOwnProperty.call(e, "step") && !Object.prototype.hasOwnProperty.call(CONNECTED_STEPS, e.step)) return bad("JOURNAL_UNKNOWN_STEP");
    if (runEnd && i > 0) return bad("JOURNAL_ENTRY_AFTER_RUN_END");
    const noteId = (v) => { if (isPosInt(v)) { if (isProtected(v)) protectedSeen = true; else ids.add(v); } };
    if (e.type === "intent" || e.type === "outcome") {
      if (!["create", "cancel"].includes(e.kind)) return bad("JOURNAL_UNEXPECTED_WRITE_KIND");
      if (e.kind === "create" && (e.step !== "KW1_CREATE" || e.ref !== ref)) return bad("JOURNAL_CREATE_NOT_THIS_RUN");
      if (e.kind === "cancel" && e.step !== "KW2_CANCEL") return bad("JOURNAL_CANCEL_NOT_THIS_RUN");
      // ordering exactly as the reviewed sequence produces it: create intent -> create outcome -> cancel intent -> cancel outcome
      if (e.type === "outcome" && outcomes[e.kind].length >= intents[e.kind].length) return bad(`JOURNAL_${e.kind.toUpperCase()}_OUTCOME_WITHOUT_INTENT`);
      if (e.kind === "cancel" && e.type === "intent" && outcomes.create.length !== 1) return bad("JOURNAL_CANCEL_BEFORE_CREATE_OUTCOME");
      if (e.kind === "create" && (intents.cancel.length || outcomes.cancel.length)) return bad("JOURNAL_CREATE_AFTER_CANCEL");
      (e.type === "intent" ? intents : outcomes)[e.kind].push(e);
    }
    if (e.type === "outcome" && e.kind === "create" && isObj(e.evidence)) { noteId(e.evidence.reservationId); if (isObj(e.evidence.reservation)) noteId(e.evidence.reservation.reservationId); }
    if (e.kind === "cancel" || (e.type === "read" && ["KV1_READ_VERIFY", "KV2_LOOKUP_VERIFY", "K4_READBACK", "K7_PRECANCEL", "K8_POSTCANCEL"].includes(e.step))) noteId(e.reservationId);
    if ((e.step === "KV1_READ_VERIFY" || e.step === "KV2_LOOKUP_VERIFY") && e.type !== "halt") {
      if (e.type !== "read") return bad("JOURNAL_UNEXPECTED_VERIFY_ENTRY");
      kvAt.push([i, e]);
    }
    if (e.type === "outcome" && e.kind === "create" && coIdx < 0) coIdx = i;
    if (e.type === "halt" && firstHaltIdx < 0) firstHaltIdx = i;
    if (e.type === "intent" && e.kind === "cancel" && xiIdx < 0) xiIdx = i;
    // entries of steps that only ever follow an adopted create (reads/side effects/observations/checkpoints, the cancel)
    if (e.type !== "halt" && typeof e.step === "string" && LATER_STEPS.includes(e.step)) laterIdx.push(i);
    if (e.type === "halt" && !halt) halt = { step: e.step ?? null, code: e.code ?? null };
    if (e.type === "run-end") runEnd = { code: e.code ?? null };
  }
  for (const k of ["create", "cancel"]) {
    if (intents[k].length > CONNECTED_WRITE_BUDGET[k] || outcomes[k].length > intents[k].length) return bad(`JOURNAL_${k.toUpperCase()}_BUDGET_INCONSISTENT`);
  }
  if (intents.cancel.length && !intents.create.length) return bad("JOURNAL_CANCEL_WITHOUT_CREATE");
  const reservationId = ids.size === 1 && !protectedSeen ? [...ids][0] : null;
  const co = outcomes.create[0] ?? null; const xo = outcomes.cancel[0] ?? null;
  // Contradictions never yield a clean result: they are listed and force attention (and a manual-review verdict).
  const conflicts = [];
  if (ids.size > 1) conflicts.push("RESERVATION_IDS_INCONSISTENT");
  if (protectedSeen) conflicts.push("PROTECTED_ID_IN_JOURNAL");
  const xi = intents.cancel[0] ?? null;
  // Read-only create verification (KV1/KV2), bound EXACTLY to the sequence the producer writes: the matching create outcome
  // (2xx conflict RESERVATION_MISMATCH, mismatches exactly [bookingRef], a positive unprotected id) immediately followed
  // by marker -> KV1 result -> KV2 result, contiguous, before any halt, later step or cancel; every KV id equal to the outcome
  // id, the lookup ref equal to the run ref, and success codes free of contradicting metadata. A strict PREFIX of that
  // sequence (crash/halt) is clean but NOT_VERIFIED. Anything else is a conflict and NOT_VERIFIED. Explicit enums only.
  const v = verifyKvSequence({ kvAt, co, coIdx, firstHaltIdx, xiIdx, laterIdx, ref, isProtected });
  conflicts.push(...v.conflicts);
  const readVerified = v.readVerified;
  const replyVerified = co?.code === "VERIFIED_CREATED" && kvAt.length === 0;
  if (xi && !replyVerified && !readVerified) conflicts.push("CANCEL_WITHOUT_VERIFIED_CREATE");
  if (laterIdx.length && !replyVerified && !readVerified) conflicts.push("LATER_STEP_WITHOUT_VERIFIED_CREATE");
  const createVerification = { path: co?.code === "VERIFIED_CREATED" ? "REPLY" : kvAt.length ? "READ_FALLBACK" : "NONE",
    result: replyVerified ? "REPLY_VERIFIED" : readVerified ? "READ_VERIFIED" : "NOT_VERIFIED", refEcho: v.refEcho, readVerify: v.readVerify, lookupVerify: v.lookupVerify };
  if (xi && !isPosInt(xi.reservationId)) conflicts.push("CANCEL_INTENT_WITHOUT_ID");
  if (xo && xi && xo.reservationId !== xi.reservationId) conflicts.push("CANCEL_OUTCOME_ID_DIFFERS_FROM_INTENT");
  if (xi && ids.size === 1 && isPosInt(xi.reservationId) && xi.reservationId !== [...ids][0]) conflicts.push("CANCEL_TARGET_DIFFERS");
  let state;
  if (!intents.create.length) state = "NO_CREATE_ATTEMPTED";
  else if (!co) state = "CREATE_OUTCOME_MISSING";
  else if (!intents.cancel.length) state = reservationId ? "CREATED_NO_CANCEL_ATTEMPT" : "CREATE_NOT_VERIFIED";   // an id from this run => it may be live
  else if (!xo) state = "CANCEL_OUTCOME_MISSING";
  else state = xo.code === "VERIFIED_CANCELLED" ? "CANCEL_VERIFIED" : "CANCEL_NOT_VERIFIED";
  return freeze({
    ok: true, state, ref, reservationId, manifestHash, createVerification, idsConsistent: ids.size <= 1, protectedIdSeen: protectedSeen, conflicts, clean: conflicts.length === 0,
    createAttempts: intents.create.length, cancelAttempts: intents.cancel.length,
    createOutcome: co ? { code: co.code ?? null, ...(co.transport ? { transport: co.transport } : {}), ...createEvidence(co) } : null,
    cancelOutcome: xo ? { code: xo.code ?? null, ...(xo.httpStatus ? { httpStatus: xo.httpStatus } : {}), ...(xo.mismatches ? { mismatches: xo.mismatches } : {}),
      ...(xo.transport ? { transport: xo.transport } : {}) } : null,
    halt, runEnd, unusedRunBudget: { create: CONNECTED_WRITE_BUDGET.create - intents.create.length, cancel: CONNECTED_WRITE_BUDGET.cancel - intents.cancel.length },
    providerReservationPossible: intents.create.length > 0, launcherWillNotResume: true
  });
}

/** argv -> { ok, mode, manifestPath, reviewedCommit, location } | { ok:false, code } */
export function parseConnectedRecoverArgs(argv) {
  const a = Array.isArray(argv) ? argv : [];
  if (!["--inspect", "--reconcile"].includes(a[0]) || a.length !== 7) return { ok: false, code: "USAGE" };
  const o = {};
  for (let i = 1; i < 7; i += 2) {
    if (!["--manifest", "--reviewed-commit", "--location"].includes(a[i]) || Object.prototype.hasOwnProperty.call(o, a[i]) || typeof a[i + 1] !== "string" || !a[i + 1] || a[i + 1].startsWith("--")) return { ok: false, code: "USAGE" };
    o[a[i]] = a[i + 1];
  }
  if (!/^[0-9a-f]{40}$/.test(o["--reviewed-commit"])) return { ok: false, code: "REVIEWED_COMMIT_INVALID" };
  if (!/^[0-9a-f]{12}$/.test(o["--location"])) return { ok: false, code: "LOCATION_TOKEN_INVALID" };
  return { ok: true, mode: a[0].slice(2), manifestPath: o["--manifest"], reviewedCommit: o["--reviewed-commit"], location: o["--location"] };
}

/** Allowlist for the recovery reads (passed to the reviewed gate). No write shape exists at all. */
export function assertRecoverRequest(req, state, writeKind) {
  if (writeKind !== null && writeKind !== undefined) throw new RunnerError("RECOVERY_NEVER_WRITES");
  if (!isObj(req) || req.method !== "GET" || typeof req.path !== "string" || req.body !== undefined) throw new RunnerError("REQUEST_NOT_ALLOWLISTED");
  const q = req.query ?? {};
  const isProtected = typeof state.isProtected === "function" ? state.isProtected : (v) => CONNECTED_PROTECTED_RESERVATION_IDS.includes(Number(v));
  for (const m of req.path.matchAll(/\d+/g)) if (isProtected(m[0])) throw new RunnerError("PROTECTED_RESERVATION");
  const same = (a, b) => JSON.stringify(Object.keys(a).sort().map((k) => [k, a[k]])) === JSON.stringify(Object.keys(b).sort().map((k) => [k, b[k]]));
  let m;
  if ((m = /^\/reservations\/([1-9]\d{0,15})$/.exec(req.path)) && same(q, READ_QUERY)) {
    if (state.readId === null || Number(m[1]) !== state.readId) throw new RunnerError("READ_TARGET_NOT_FROM_THIS_RUN");
    return "read";
  }
  const lookupBase = { listingId: L, channelId: DIRECT_CHANNEL_ID, arrivalStartDate: state.arrivalDate, arrivalEndDate: state.arrivalDate, limit: 100, includeResources: 1 };
  if (req.path === "/reservations" && same(Object.fromEntries(Object.entries(q).filter(([k]) => k !== "afterId")), lookupBase) &&
    (!Object.prototype.hasOwnProperty.call(q, "afterId") || isPosInt(q.afterId))) return "lookup";
  if (req.path === `/listings/${L}/calendar` && same(q, state.calendar)) return "read";
  throw new RunnerError("REQUEST_NOT_ALLOWLISTED");
}

/** URL-level guard under the transport: token once, then only the three recovery read shapes. */
export function guardRecoverFetch(fetchImpl, { readId, calendar, arrivalDate }) {
  const exact = (q) => (p) => [...p.keys()].length === Object.keys(q).length && Object.entries(q).every(([k, v]) => p.get(k) === String(v));
  const lookupBase = { listingId: L, channelId: DIRECT_CHANNEL_ID, arrivalStartDate: arrivalDate, arrivalEndDate: arrivalDate, limit: 100, includeResources: 1 };
  const rules = [
    { name: "token", max: 1, m: "POST", path: "/v1/accessTokens", q: exact({}), body: true },
    ...(readId ? [{ name: "read", max: 1, m: "GET", path: `/v1/reservations/${readId}`, q: exact(READ_QUERY) }] : []),
    { name: "lookup", max: LOOKUP_MAX_PAGES, m: "GET", path: "/v1/reservations", q: (p) => exact(lookupBase)(new URLSearchParams([...p.keys()].filter((k) => k !== "afterId").map((k) => [k, p.get(k)]))) &&
      (!p.has("afterId") || /^[1-9]\d{0,15}$/.test(p.get("afterId"))) },
    { name: "calendar", max: 1, m: "GET", path: `/v1/listings/${L}/calendar`, q: exact(calendar) }
  ];
  const used = Object.fromEntries(rules.map((r) => [r.name, 0]));
  let refused = 0;
  const guarded = async (url, init = {}) => {
    let u = null; try { u = new URL(String(url)); } catch { u = null; }
    const method = init && typeof init.method === "string" ? init.method : "GET";
    const rule = u && u.origin === "https://api.hostaway.com" ? rules.find((r) => r.m === method && r.path === u.pathname && r.q(u.searchParams) &&
      (r.body ? init.body !== undefined : init.body === undefined)) : undefined;
    if (!rule || used[rule.name] >= rule.max || (rule.name === "token" && String(url) !== `${HOSTAWAY_BASE}/accessTokens`)) {
      refused++; throw Object.assign(new Error("refused by local allowlist"), { name: "LocalRefusal" });
    }
    used[rule.name]++;
    return fetchImpl(url, init);
  };
  return { guarded, used: () => Object.freeze({ ...used, refused }) };
}

/** Read-only reconciliation of a classified run against an injected transport. Never writes. */
export async function reconcileConnectedRun({ transport, manifest, classification, timeoutMs = 15000 }) {
  const s = manifest.stay; const nights = stayNights(s);
  const c = classification;
  const isProtected = recoveryProtection(c.manifestHash);
  const state = { isProtected, halted: false, readOnly: true, readableIds: new Set(), cancellableId: null, readId: c.idsConsistent && c.reservationId ? c.reservationId : null,
    arrivalDate: s.arrivalDate, calendar: Object.freeze({ startDate: nights[0], endDate: nights[nights.length - 1] }) };
  const noJournal = Object.freeze({ durable: false, load: () => [], append: () => { throw new RunnerError("RECOVERY_WRITES_NOTHING"); } });
  const gate = createGate({ transport, journal: noJournal, timeoutMs, state, budgets: RECOVER_STEPS, writeBudget: { create: 0, cancel: 0 }, allowRequest: assertRecoverRequest });
  const send = async (step, req) => { try { return await gate.send(step, req); } catch (e) { return { transportError: true, code: e instanceof RunnerError ? e.code : "GATE" }; } };
  const expect = { listingId: L, from: s.arrivalDate, to: s.departureDate, totalMinor: manifest.totalMinor, currency: "MXN", channelId: DIRECT_CHANNEL_ID, bookingRef: c.ref };
  const out = { read: null, lookup: null, calendar: null, evidenceConflicts: [] };
  if (state.readId) {
    const p = parseReservationResponse(await send("RC_READ", { method: "GET", path: `/reservations/${state.readId}`, query: READ_QUERY }), "READ");
    const mm = p.ok ? identityMismatches(p.reservation, { ...expect, reservationId: state.readId }) : [];
    out.read = { code: p.ok ? (mm.length ? "READ_IDENTITY_MISMATCH" : "READ_IDENTITY_OK") : p.code, reservationId: state.readId,
      ...(p.ok ? { status: p.reservation.status } : {}), ...(p.httpStatus ? { httpStatus: p.httpStatus } : {}), ...(mm.length ? { mismatches: mm } : {}) };
  }
  try {
    const lk = await lookupByRef({ ref: c.ref, listingId: L, arrivalDate: s.arrivalDate, departureDate: s.departureDate }, connectedTestAdapterConfig(), (req) => send("RC_LOOKUP", req));
    const rid = lk.reservation?.reservationId;
    const mm = lk.outcome === "found" ? identityMismatches(lk.reservation, expect) : [];
    out.lookup = { code: lk.code, outcome: lk.outcome, ...(isPosInt(rid) && !isProtected(rid) ? { foundReservationId: rid, status: lk.reservation.status } : {}),
      ...(isPosInt(rid) && isProtected(rid) ? { protectedIdReturned: true } : {}), ...(mm.length ? { mismatches: mm } : {}), pagesRead: lk.pagesRead ?? null };
  } catch { out.lookup = { code: "LOOKUP_INTERNAL_ERROR" }; }
  const cal = await send("RC_CALENDAR", { method: "GET", path: `/listings/${L}/calendar`, query: state.calendar });
  out.calendar = { code: `CALENDAR_${nightsState(cal, nights).toUpperCase()}`, nights: calendarNightShapes(cal, nights) };
  // verdict
  const r = out.read; const lk = out.lookup;
  const idOk = r && r.code === "READ_IDENTITY_OK";
  const lkOk = lk && lk.outcome === "found" && !lk.mismatches && isPosInt(lk.foundReservationId) && (!state.readId || lk.foundReservationId === state.readId);
  const status = idOk ? r.status : lkOk ? lk.status : null;
  // Explicit contradictions between the provider reads themselves: a clean read by id must not mask a conflicting lookup.
  // The reads are kept as evidence; the verdict becomes manual review and no decision is offered.
  const evidenceConflicts = [];
  if (lk && lk.protectedIdReturned) evidenceConflicts.push("LOOKUP_RETURNED_PROTECTED_ID");
  if (lk && lk.outcome === "conflict") evidenceConflicts.push(`LOOKUP_${lk.code}`);
  if (lk && lk.outcome === "found" && lk.mismatches) evidenceConflicts.push("LOOKUP_IDENTITY_MISMATCH");
  if (state.readId && lk && lk.outcome === "found" && isPosInt(lk.foundReservationId) && lk.foundReservationId !== state.readId) evidenceConflicts.push("LOOKUP_ID_DIFFERS_FROM_READ");
  if (idOk && lk && lk.outcome === "found" && lk.foundReservationId === state.readId && lk.status !== r.status) evidenceConflicts.push("LOOKUP_STATUS_DIFFERS_FROM_READ");
  out.evidenceConflicts = evidenceConflicts;
  let verdict;
  if (!c.clean) verdict = "CONFLICT_MANUAL_REVIEW";                 // contradictions in the journal: evidence only, never a clean verdict
  else if (evidenceConflicts.length) verdict = "EVIDENCE_CONFLICT_MANUAL_REVIEW";
  else if (r && r.code === "READ_IDENTITY_MISMATCH") verdict = "IDENTITY_MISMATCH_MANUAL_REVIEW";
  else if ((idOk || lkOk) && status === "cancelled") verdict = "RESERVATION_CANCELLED_CONFIRMED";
  else if (idOk || lkOk) verdict = "RESERVATION_ACTIVE_OWNER_DECISION_REQUIRED";
  else if (!state.readId && lk && lk.outcome === "not_found") verdict = "NOT_FOUND_BY_REF_NON_AUTHORITATIVE";
  else verdict = "UNKNOWN_MANUAL_REVIEW";
  const decision = verdict === "RESERVATION_ACTIVE_OWNER_DECISION_REQUIRED" ? {
    requiresSeparateOwnerDecision: true, target: { reservationId: idOk ? state.readId : lk.foundReservationId, ref: c.ref, listingId: L, from: s.arrivalDate, to: s.departureDate },
    identityProof: idOk ? "READ_BY_ID_FULL_IDENTITY" : "LOOKUP_BY_REF_FULL_IDENTITY", unusedRunBudget: c.unusedRunBudget, launcherWillNotResume: true,
    note: "NO_CANCEL_IS_SENT_BY_THIS_TOOL"
  } : null;
  return freeze({ ...out, verdict, decision, requests: gate.requestCount() });
}

/** deps: { root, base, git, readText, prompt, fetchImpl, readJournal, timeoutMs, sleep } -> { exitCode, output } */
export async function runConnectedRecoverCli(argv, deps = {}) {
  const root = deps.root ?? ROOT;
  const base = deps.base ?? dirname(root);
  const out = (exitCode, o) => ({ exitCode, output: { mode: "connected-recover", version: CONNECTED_RECOVER_VERSION, filesWritten: 0, writesSent: 0, ...o } });
  const refuse = (stage, error, extra = {}) => out(error === "USAGE" ? CONNECTED_RECOVER_EXIT.USAGE : CONNECTED_RECOVER_EXIT.REFUSED,
    { ok: false, stage, error, credentialsRequested: false, network: "none", ...extra });
  const args = parseConnectedRecoverArgs(argv);
  if (!args.ok) return refuse("arguments", args.code);
  const prov = verifyProvenance({ reviewedCommit: args.reviewedCommit, git: deps.git ?? makeGit(root), sources: CONNECTED_RECOVER_SOURCES });
  if (!prov.ok) return refuse("provenance", prov.code);
  let input;
  try {
    input = JSON.parse((deps.readText ?? ((p) => { if (statSync(p).size > MAX_MANIFEST_BYTES) throw new Error("big"); return readFileSync(p, "utf8"); }))(resolve(args.manifestPath)));
  } catch { return refuse("manifest", "MANIFEST_UNREADABLE_OR_NOT_JSON"); }
  const v = validateConnectedManifest(input, { now: STRUCTURE_CLOCK });
  if (!v.ok) return refuse("manifest", "MANIFEST_INVALID", { manifestErrors: v.errors ?? [], blockers: v.blockers ?? [] });
  const loc = connectedRunLocation(base, v.hash);
  if (args.location !== loc.token) return refuse("location", "LOCATION_TOKEN_MISMATCH");
  const realDir = (p) => { try { const st = lstatSync(p); return st.isDirectory() && !st.isSymbolicLink(); } catch { return false; } };
  if (!realDir(resolve(base)) || !realDir(loc.runsRoot)) return refuse("location", "RUNS_ROOT_NOT_A_REAL_DIRECTORY");
  if (!realDir(loc.runDir)) return refuse("location", "RUN_LOCATION_ABSENT_OR_NOT_A_REAL_DIRECTORY", { runCreatedNothing: true });
  const jname = journalFileName(v.hash);
  let names;
  try { names = readdirSync(loc.runDir); } catch { return refuse("journal", "RUN_LOCATION_UNREADABLE"); }
  if (names.length === 0) return refuse("journal", "RUN_LOCATION_HAS_NO_JOURNAL", { note: "the launcher stopped before its journal; nothing was sent" });
  if (names.length !== 1 || names[0] !== jname) return refuse("journal", "RUN_LOCATION_UNEXPECTED_CONTENT");
  // The journal itself must be a regular, single-linked file of bounded size (never a symlink/junction/reparse point or a
  // hard link to some other file) BEFORE it is read.
  const jpath = join(loc.runDir, jname);
  let jst;
  try { jst = lstatSync(jpath); } catch { return refuse("journal", "JOURNAL_UNREADABLE"); }
  if (jst.isSymbolicLink() || !jst.isFile()) return refuse("journal", "JOURNAL_NOT_A_REGULAR_FILE");
  if (jst.nlink !== 1) return refuse("journal", "JOURNAL_HAS_OTHER_LINKS");
  if (jst.size > MAX_JOURNAL_BYTES) return refuse("journal", "JOURNAL_TOO_LARGE");
  let entries;
  try { entries = (deps.readJournal ?? readJournalFile)(jpath); } catch (e) {
    return refuse("journal", typeof e?.code === "string" && /^[A-Z_]{1,40}$/.test(e.code) ? e.code : "JOURNAL_UNREADABLE");
  }
  const cls = classifyConnectedJournal(entries, v.hash);
  if (!cls.ok) return refuse("journal", cls.code);
  const summary = { ok: true, stage: args.mode, manifestHash: v.hash, location: { token: loc.token, runDir: loc.runDir }, journalFile: jname, classification: cls };
  const needsReads = cls.providerReservationPossible;
  if (args.mode === "inspect") {
    const clean = cls.clean && (!needsReads || cls.state === "CANCEL_VERIFIED");
    return out(clean ? CONNECTED_RECOVER_EXIT.OK : CONNECTED_RECOVER_EXIT.ATTENTION,
      { ...summary, network: "none", credentialsRequested: false, nextStep: !needsReads ? "NONE_NOTHING_SENT_BY_A_CREATE" : "RECONCILE_READ_ONLY" });
  }
  if (!needsReads) return out(cls.clean ? CONNECTED_RECOVER_EXIT.OK : CONNECTED_RECOVER_EXIT.ATTENTION, { ...summary, network: "none", credentialsRequested: false, nextStep: "NONE_NOTHING_SENT_BY_A_CREATE" });
  if (typeof deps.prompt !== "function") return refuse("credentials", "OWNER_CHANNEL_MISSING");
  let creds;
  try { creds = await deps.prompt(); } catch (e) {
    return out(CONNECTED_RECOVER_EXIT.REFUSED, { ok: false, stage: "credentials", error: typeof e?.code === "string" && /^[A-Z_]{1,40}$/.test(e.code) ? e.code : "CREDENTIALS_UNAVAILABLE",
      credentialsRequested: true, network: "none" });
  }
  try {
    const nights = stayNights(v.manifest.stay);
    const guard = guardRecoverFetch(deps.fetchImpl ?? globalThis.fetch, { readId: cls.idsConsistent ? cls.reservationId : null,
      calendar: { startDate: nights[0], endDate: nights[nights.length - 1] }, arrivalDate: v.manifest.stay.arrivalDate });
    const transport = createHostawayTransport({ fetchImpl: guard.guarded, getCredentials: async () => { const c = creds; creds = null; return c; },
      ...(deps.sleep ? { sleep: deps.sleep } : {}) });
    const rec = await reconcileConnectedRun({ transport, manifest: v.manifest, classification: cls, ...(deps.timeoutMs ? { timeoutMs: deps.timeoutMs } : {}) });
    let usage = null; try { usage = transport.usage(); } catch { usage = null; }
    return out(cls.clean && (rec.verdict === "RESERVATION_CANCELLED_CONFIRMED" || rec.verdict === "NOT_FOUND_BY_REF_NON_AUTHORITATIVE") ? CONNECTED_RECOVER_EXIT.OK : CONNECTED_RECOVER_EXIT.ATTENTION,
      { ...summary, credentialsRequested: true, reconcile: rec, guard: guard.used(),
        transportUsage: usage && ["none", "ok", "failed"].includes(usage.mintState) ? { mintState: usage.mintState, fetches: usage.fetches } : null });
  } catch {
    return out(CONNECTED_RECOVER_EXIT.INTERNAL, { ok: false, stage: "reconcile", error: "INTERNAL_ERROR", credentialsRequested: true });
  } finally { creds = null; }
}
