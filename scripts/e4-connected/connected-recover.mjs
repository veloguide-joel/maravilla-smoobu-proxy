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
import { READ_QUERY, RunnerError, createGate, parseReservationResponse, identityMismatches } from "../e4-write-runner/runner.mjs";
import { connectedTestAdapterConfig, lookupByRef, LOOKUP_MAX_PAGES, DIRECT_CHANNEL_ID, REF_RE } from "../../lib/hostaway-reservations.js";
import { nightsState } from "./safeguards.mjs";
import { validateConnectedManifest, stayNights, CONNECTED_STEPS, CONNECTED_PROTECTED_RESERVATION_IDS, CONNECTED_WRITE_BUDGET } from "./connected-path.mjs";
import { connectedRunLocation, CONNECTED_EXECUTE_SOURCES } from "./connected-execute.mjs";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const CONNECTED_RECOVER_VERSION = "e4-connected-recover-v1";
export const CONNECTED_RECOVER_SOURCES = Object.freeze([...CONNECTED_EXECUTE_SOURCES, "scripts/e4-connected/connected-recover.mjs"]);
export const CONNECTED_RECOVER_EXIT = Object.freeze({ OK: 0, USAGE: 64, REFUSED: 2, ATTENTION: 3, INTERNAL: 70 });
const RECOVER_STEPS = Object.freeze({ RC_READ: Object.freeze({ reads: 1, writes: 0 }), RC_LOOKUP: Object.freeze({ reads: LOOKUP_MAX_PAGES, writes: 0 }),
  RC_CALENDAR: Object.freeze({ reads: 1, writes: 0 }) });
const JOURNAL_TYPES = Object.freeze(["run-start", "intent", "outcome", "read", "side-effect-check", "halt", "reconcile", "run-end"]);
const MAX_MANIFEST_BYTES = 16384;
const L = 603566;
// The manifest's lead-time rule is an approval rule, not an identity rule: the hash is recomputed with a fixed early clock
// so that recovery stays possible after the approval window. It authorizes nothing.
const STRUCTURE_CLOCK = () => new Date("2000-01-01T00:00:00.000Z");

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isPosInt = (v) => Number.isSafeInteger(v) && v > 0;
const isProtected = (v) => CONNECTED_PROTECTED_RESERVATION_IDS.includes(Number(v));
const freeze = (o) => { if (o && typeof o === "object" && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) freeze(v); } return o; };

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
  const ids = new Set(); let protectedSeen = false; let halt = null; let runEnd = null;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!isObj(e) || !JOURNAL_TYPES.includes(e.type)) return bad("JOURNAL_UNEXPECTED_ENTRY");
    if (e.type === "run-start" && i !== 0) return bad("JOURNAL_SECOND_RUN_START");
    if (Object.prototype.hasOwnProperty.call(e, "step") && !Object.prototype.hasOwnProperty.call(CONNECTED_STEPS, e.step)) return bad("JOURNAL_UNKNOWN_STEP");
    if (runEnd && i > 0) return bad("JOURNAL_ENTRY_AFTER_RUN_END");
    const noteId = (v) => { if (isPosInt(v)) { if (isProtected(v)) protectedSeen = true; else ids.add(v); } };
    if (e.type === "intent" || e.type === "outcome") {
      if (!["create", "cancel"].includes(e.kind)) return bad("JOURNAL_UNEXPECTED_WRITE_KIND");
      if (e.kind === "create" && (e.step !== "KW1_CREATE" || e.ref !== ref)) return bad("JOURNAL_CREATE_NOT_THIS_RUN");
      if (e.kind === "cancel" && e.step !== "KW2_CANCEL") return bad("JOURNAL_CANCEL_NOT_THIS_RUN");
      (e.type === "intent" ? intents : outcomes)[e.kind].push(e);
    }
    if (e.type === "outcome" && e.kind === "create" && isObj(e.evidence)) { noteId(e.evidence.reservationId); if (isObj(e.evidence.reservation)) noteId(e.evidence.reservation.reservationId); }
    if (e.kind === "cancel" || (e.type === "read" && ["K4_READBACK", "K7_PRECANCEL", "K8_POSTCANCEL"].includes(e.step))) noteId(e.reservationId);
    if (e.type === "halt" && !halt) halt = { step: e.step ?? null, code: e.code ?? null };
    if (e.type === "run-end") runEnd = { code: e.code ?? null };
  }
  for (const k of ["create", "cancel"]) {
    if (intents[k].length > CONNECTED_WRITE_BUDGET[k] || outcomes[k].length > intents[k].length) return bad(`JOURNAL_${k.toUpperCase()}_BUDGET_INCONSISTENT`);
  }
  if (intents.cancel.length && !intents.create.length) return bad("JOURNAL_CANCEL_WITHOUT_CREATE");
  const reservationId = ids.size === 1 ? [...ids][0] : null;
  const co = outcomes.create[0] ?? null; const xo = outcomes.cancel[0] ?? null;
  let state;
  if (!intents.create.length) state = "NO_CREATE_ATTEMPTED";
  else if (!co) state = "CREATE_OUTCOME_MISSING";
  else if (!intents.cancel.length) state = reservationId ? "CREATED_NO_CANCEL_ATTEMPT" : "CREATE_NOT_VERIFIED";   // an id from this run => it may be live
  else if (!xo) state = "CANCEL_OUTCOME_MISSING";
  else state = xo.code === "VERIFIED_CANCELLED" ? "CANCEL_VERIFIED" : "CANCEL_NOT_VERIFIED";
  return freeze({
    ok: true, state, ref, reservationId, idsConsistent: ids.size <= 1, protectedIdSeen: protectedSeen,
    createAttempts: intents.create.length, cancelAttempts: intents.cancel.length,
    createOutcome: co ? { code: co.code ?? null, ...(co.transport ? { transport: co.transport } : {}) } : null,
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
  const state = { halted: false, readOnly: true, readableIds: new Set(), cancellableId: null, readId: c.idsConsistent && c.reservationId ? c.reservationId : null,
    arrivalDate: s.arrivalDate, calendar: Object.freeze({ startDate: nights[0], endDate: nights[nights.length - 1] }) };
  const noJournal = Object.freeze({ durable: false, load: () => [], append: () => { throw new RunnerError("RECOVERY_WRITES_NOTHING"); } });
  const gate = createGate({ transport, journal: noJournal, timeoutMs, state, budgets: RECOVER_STEPS, writeBudget: { create: 0, cancel: 0 }, allowRequest: assertRecoverRequest });
  const send = async (step, req) => { try { return await gate.send(step, req); } catch (e) { return { transportError: true, code: e instanceof RunnerError ? e.code : "GATE" }; } };
  const expect = { listingId: L, from: s.arrivalDate, to: s.departureDate, totalMinor: manifest.totalMinor, currency: "MXN", channelId: DIRECT_CHANNEL_ID, bookingRef: c.ref };
  const out = { read: null, lookup: null, calendar: null };
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
  out.calendar = { code: `CALENDAR_${nightsState(cal, nights).toUpperCase()}` };
  // verdict
  const r = out.read; const lk = out.lookup;
  const idOk = r && r.code === "READ_IDENTITY_OK";
  const lkOk = lk && lk.outcome === "found" && !lk.mismatches && isPosInt(lk.foundReservationId) && (!state.readId || lk.foundReservationId === state.readId);
  const status = idOk ? r.status : lkOk ? lk.status : null;
  let verdict;
  if (r && r.code === "READ_IDENTITY_MISMATCH") verdict = "IDENTITY_MISMATCH_MANUAL_REVIEW";
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
  let entries;
  try { entries = (deps.readJournal ?? readJournalFile)(join(loc.runDir, jname)); } catch (e) {
    return refuse("journal", typeof e?.code === "string" && /^[A-Z_]{1,40}$/.test(e.code) ? e.code : "JOURNAL_UNREADABLE");
  }
  const cls = classifyConnectedJournal(entries, v.hash);
  if (!cls.ok) return refuse("journal", cls.code);
  const summary = { ok: true, stage: args.mode, manifestHash: v.hash, location: { token: loc.token, runDir: loc.runDir }, journalFile: jname, classification: cls };
  const needsReads = cls.providerReservationPossible;
  if (args.mode === "inspect") {
    return out(needsReads && cls.state !== "CANCEL_VERIFIED" ? CONNECTED_RECOVER_EXIT.ATTENTION : CONNECTED_RECOVER_EXIT.OK,
      { ...summary, network: "none", credentialsRequested: false, nextStep: !needsReads ? "NONE_NOTHING_SENT_BY_A_CREATE" : "RECONCILE_READ_ONLY" });
  }
  if (!needsReads) return out(CONNECTED_RECOVER_EXIT.OK, { ...summary, network: "none", credentialsRequested: false, nextStep: "NONE_NOTHING_SENT_BY_A_CREATE" });
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
    return out(rec.verdict === "RESERVATION_CANCELLED_CONFIRMED" || rec.verdict === "NOT_FOUND_BY_REF_NON_AUTHORITATIVE" ? CONNECTED_RECOVER_EXIT.OK : CONNECTED_RECOVER_EXIT.ATTENTION,
      { ...summary, credentialsRequested: true, reconcile: rec, guard: guard.used(),
        transportUsage: usage && ["none", "ok", "failed"].includes(usage.mintState) ? { mintState: usage.mintState, fetches: usage.fetches } : null });
  } catch {
    return out(CONNECTED_RECOVER_EXIT.INTERNAL, { ok: false, stage: "reconcile", error: "INTERNAL_ERROR", credentialsRequested: true });
  } finally { creds = null; }
}
