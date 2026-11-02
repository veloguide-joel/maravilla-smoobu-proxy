// E4 CONNECTED-LISTING launcher: ONE create + ONE cancel on 603566 (OFFLINE-BUILT FOR REVIEW; its presence is NOT permission
// to run it). Running it needs a concrete owner approval of the exact manifest, reviewed commit, confirm token and run
// location. The create and the cancel are LIVE provider writes on Hostaway, visible to Airbnb (there is no sandbox).
//
// There is NO direct command line: the module only exports runConnectedExecuteCli(argv, deps). It is driven by a reviewed
// owner wrapper that supplies deps.prompt (native hidden entry over a private pipe) and deps.airbnbCheckpoint (the owner's
// independent Airbnb answers). The raw TTY prompt is never used here. Without both, execute is refused.
//
//   --dry-run --manifest <m.json> --reviewed-commit <40 hex>
//   --execute --manifest <m.json> --reviewed-commit <40 hex> --confirm E4-CONNECTED-<12 hex> --location <12 hex>
//
// Order (every step is fatal; nothing below a failed step runs; no prompt, no network and no file write before step 6):
//   1. strict arguments;
//   2. read-only git provenance of the complete import closure (CONNECTED_EXECUTE_SOURCES) at --reviewed-commit;
//   3. manifest: size cap, JSON, validateConnectedManifest (fixed 603566/Airbnb/channel/currency/ref field; owner inputs);
//      manifest.reviewedCommit must equal --reviewed-commit;
//   4. the ONE canonical run location, derived (never chosen): <checkout base>/connected-runs/<full manifest hash>, where
//      the checkout base is the parent of this repository checkout. No journal-dir/resume/alternate-location option exists.
//      The base and connected-runs must be real directories (no symlink/junction/reparse point). The location token
//      binds the approval to this exact location: sha256("e4-connected-location-v1:" + resolved connected-runs + ":" + hash).
//      Dry-run stops here and writes nothing (it reports whether the location already exists).
//   5. execute only: --confirm == manifest confirm token; --location == location token; the run directory must NOT exist
//      (a replay of the same manifest is refused before any prompt); deps.prompt and deps.airbnbCheckpoint present;
//   6. the owner's private credential entry (deps.prompt);
//   7. connected-runs is created if absent (non-recursive), then the run directory with an EXCLUSIVE mkdir (a concurrent
//      second start, or any start after a first one, fails here: RUN_LOCATION_EXISTS, nothing sent), then the
//      exclusive durable journal (O_EXCL) inside it. The original run folder is never touched (it is not on this path);
//   8. the reviewed connected sequence (executeConnectedRun: budgets create 1 / cancel 1, fresh price/lookup/calendar
//      checks and the Airbnb-open attestation before the write, halt on any identity/journal/side-effect/transport
//      doubt, no retries, read-only reconciliation) behind the reviewed single-mint transport and a URL-level allowlist;
//   9. the journal is closed BEFORE the final result (a failed close => journalDurable false, not passed, exit 3; the
//      facts already reported are kept, nothing is retried); then a SANITIZED summary (codes, ids of this run, our ref, dates, minor units, mismatching
//      identity field NAMES, counts). Never provider bodies, guest data, the channel reservation id, tokens or error text.
// Residual (operator procedure, stated): deleting the run directory, or copying the checkout to another base, defeats the
// replay guard; the location token in the approval then no longer matches a different base. Dry-run is zero writes.

import { readFileSync, statSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyProvenance, makeGit } from "../e4-launcher/happy-execute.mjs";
import { createHostawayTransport, HOSTAWAY_BASE } from "../e4-transport/hostaway-transport.mjs";
import { createFileJournal } from "../e4-write-runner/journal.mjs";
import { READ_QUERY, CANCEL_BODY } from "../e4-write-runner/runner.mjs";
import { LOOKUP_MAX_PAGES, DIRECT_CHANNEL_ID, REF_ECHO_SHAPES, REF_NOT_ECHOED_REFUSALS } from "../../lib/hostaway-reservations.js";
import { realTimer } from "./safeguards.mjs";
import {
  validateConnectedManifest, planConnectedRun, executeConnectedRun, stayNights, CONNECTED_SOURCES, CONNECTED_STEPS,
  CONNECTED_PROTECTED_RESERVATION_IDS, CONNECTED_VERSION, CONNECTED_VERIFY_READ_CODES, CONNECTED_VERIFY_LOOKUP_CODES
} from "./connected-path.mjs";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const CONNECTED_EXECUTE_VERSION = "e4-connected-execute-v1";
export const CONNECTED_EXECUTE_SOURCES = Object.freeze([...CONNECTED_SOURCES, "scripts/e4-connected/connected-execute.mjs"]);
export const CONNECTED_EXECUTE_EXIT = Object.freeze({ PASSED: 0, USAGE: 64, REFUSED: 2, NOT_PASSED: 3, INTERNAL: 70 });
export const RUNS_DIR_NAME = "connected-runs";
const MAX_MANIFEST_BYTES = 16384;
const L = 603566;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const codeOf = (e, dflt) => (typeof e?.code === "string" && /^[A-Z_:]{1,60}$/.test(e.code) ? e.code : dflt);

/** argv -> { ok, mode, manifestPath, reviewedCommit, confirm?, location? } | { ok:false, code } */
export function parseConnectedExecuteArgs(argv) {
  const a = Array.isArray(argv) ? argv : [];
  const mode = a[0];
  const want = mode === "--dry-run" ? ["--manifest", "--reviewed-commit"] : mode === "--execute" ? ["--manifest", "--reviewed-commit", "--confirm", "--location"] : null;
  if (!want || a.length !== 1 + 2 * want.length) return { ok: false, code: "USAGE" };
  const o = {};
  for (let i = 1; i < a.length; i += 2) {
    if (!want.includes(a[i]) || Object.prototype.hasOwnProperty.call(o, a[i]) || typeof a[i + 1] !== "string" || !a[i + 1] || a[i + 1].startsWith("--")) return { ok: false, code: "USAGE" };
    o[a[i]] = a[i + 1];
  }
  if (!/^[0-9a-f]{40}$/.test(o["--reviewed-commit"])) return { ok: false, code: "REVIEWED_COMMIT_INVALID" };
  if (mode === "--execute") {
    if (!/^E4-CONNECTED-[0-9a-f]{12}$/.test(o["--confirm"])) return { ok: false, code: "CONFIRM_TOKEN_INVALID" };
    if (!/^[0-9a-f]{12}$/.test(o["--location"])) return { ok: false, code: "LOCATION_TOKEN_INVALID" };
  }
  return { ok: true, mode: mode.slice(2), manifestPath: o["--manifest"], reviewedCommit: o["--reviewed-commit"], confirm: o["--confirm"], location: o["--location"] };
}

const realDir = (p) => { try { const s = lstatSync(p); return s.isDirectory() && !s.isSymbolicLink(); } catch { return false; } };
const exists = (p) => { try { lstatSync(p); return true; } catch { return false; } };

/** The one canonical run location for a manifest hash under a checkout base (pure path arithmetic + token). */
export function connectedRunLocation(base, manifestHash) {
  const runsRoot = join(resolve(base), RUNS_DIR_NAME);
  const runDir = join(runsRoot, manifestHash);
  const token = createHash("sha256").update(`e4-connected-location-v1:${runsRoot}:${manifestHash}`).digest("hex").slice(0, 12);
  return Object.freeze({ runsRoot, runDir, token });
}

/** Read-only location check (no write). -> { ok, code?, runsRoot, runDir, token, runDirExists } */
export function checkRunLocation(base, manifestHash) {
  const loc = connectedRunLocation(base, manifestHash);
  if (!realDir(resolve(base))) return { ok: false, code: "CHECKOUT_BASE_NOT_A_REAL_DIRECTORY", ...loc };
  if (exists(loc.runsRoot) && !realDir(loc.runsRoot)) return { ok: false, code: "RUNS_ROOT_NOT_A_REAL_DIRECTORY", ...loc };
  return { ok: true, ...loc, runDirExists: exists(loc.runDir) };
}

/**
 * Creates the run directory EXCLUSIVELY (the replay/concurrency lock) and returns it. connected-runs is created
 * non-recursively if absent. Throws { code } on any doubt; nothing has been sent at that point.
 */
export function claimRunLocation(base, manifestHash) {
  const loc = connectedRunLocation(base, manifestHash);
  if (!realDir(resolve(base))) throw Object.assign(new Error("x"), { code: "CHECKOUT_BASE_NOT_A_REAL_DIRECTORY" });
  try { mkdirSync(loc.runsRoot); } catch (e) { if (e?.code !== "EEXIST") throw Object.assign(new Error("x"), { code: "RUNS_ROOT_CREATE_FAILED" }); }
  if (!realDir(loc.runsRoot)) throw Object.assign(new Error("x"), { code: "RUNS_ROOT_NOT_A_REAL_DIRECTORY" });
  try { mkdirSync(loc.runDir); } catch (e) { throw Object.assign(new Error("x"), { code: e?.code === "EEXIST" ? "RUN_LOCATION_EXISTS" : "RUN_LOCATION_CREATE_FAILED" }); }
  if (!realDir(loc.runDir) || readdirSync(loc.runDir).length !== 0) throw Object.assign(new Error("x"), { code: "RUN_LOCATION_NOT_EMPTY_DIRECTORY" });
  return loc;
}

/**
 * URL-level allowlist under the transport (defence in depth BELOW the gate, which keeps the exact run-bound shapes and the
 * verified cancel target): only api.hostaway.com, only the connected paths for 603566, a protected id never, per-shape caps
 * derived from CONNECTED_STEPS, and cheap body checks (create: listing/channel/currency/stay dates; price: stay dates;
 * cancel: the host body). It deliberately does NOT re-implement the full create body or the cancel-target binding.
 */
export function guardConnectedFetch(fetchImpl, { calendar, arrivalDate, departureDate }) {
  const sum = (...steps) => steps.reduce((n, s) => n + CONNECTED_STEPS[s].reads, 0);
  const exact = (q) => (p) => [...p.keys()].length === Object.keys(q).length && Object.entries(q).every(([k, v]) => p.get(k) === String(v));
  const noProtected = (u) => ![...u.pathname.matchAll(/\d+/g), ...[...u.searchParams.values()].flatMap((v) => [...v.matchAll(/\d+/g)])]
    .some((m) => CONNECTED_PROTECTED_RESERVATION_IDS.includes(Number(m[0])));
  const lookupBase = { listingId: L, channelId: DIRECT_CHANNEL_ID, arrivalStartDate: arrivalDate, arrivalEndDate: arrivalDate, limit: 100, includeResources: 1 };
  // Cheap body binding (the gate keeps the exact bound shapes): listing/channel/currency/dates for the create, the stay dates
  // for the price; the cancel body must be the host cancel. The cancel TARGET id is bound by the gate (this run's verified id).
  const json = (b) => { try { const v = JSON.parse(String(b)); return isObj(v) ? v : null; } catch { return null; } };
  const createOk = (b) => { const v = json(b); return !!v && v.listingMapId === L && v.channelId === DIRECT_CHANNEL_ID && v.currency === "MXN" &&
    v.arrivalDate === arrivalDate && v.departureDate === departureDate && !Object.keys(v).some((k) => k.toLowerCase() === "forceoverbooking"); };
  const priceOk = (b) => { const v = json(b); return !!v && v.startingDate === arrivalDate && v.endingDate === departureDate; };
  const cancelOk = (b) => { const v = json(b); return !!v && JSON.stringify(v) === JSON.stringify(CANCEL_BODY); };
  const side = (p) => [...p.keys()].length === 3 && /^[1-9]\d{0,15}$/.test(p.get("reservationId") ?? "") && /^\d{1,4}$/.test(p.get("offset") ?? "") && /^\d{1,3}$/.test(p.get("limit") ?? "");
  const rules = [
    { name: "token", max: 1, m: "POST", re: /^\/v1\/accessTokens$/, q: exact({}), body: true },
    { name: "price", max: CONNECTED_STEPS.K0_PRICE.reads, m: "POST", re: new RegExp(`^/v1/listings/${L}/calendar/priceDetails$`), q: exact({}), body: true, bodyOk: priceOk },
    { name: "create", max: 1, m: "POST", re: /^\/v1\/reservations$/, q: exact({}), body: true, bodyOk: createOk },
    { name: "cancel", max: 1, m: "PUT", re: /^\/v1\/reservations\/[1-9]\d{0,15}\/statuses\/cancelled$/, q: exact({}), body: true, bodyOk: cancelOk },
    { name: "lookup", max: sum("K1_CLEAR", "KV2_LOOKUP_VERIFY", "K5_LOOKUP_REF") + LOOKUP_MAX_PAGES, m: "GET", re: /^\/v1\/reservations$/, q: (p) => {
      const rest = new URLSearchParams([...p.keys()].filter((k) => k !== "afterId").map((k) => [k, p.get(k)]));
      return exact(lookupBase)(rest) && (!p.has("afterId") || /^[1-9]\d{0,15}$/.test(p.get("afterId")));
    } },
    { name: "read", max: sum("KV1_READ_VERIFY", "K4_READBACK", "K7_PRECANCEL", "K8_POSTCANCEL") + 1, m: "GET", re: /^\/v1\/reservations\/[1-9]\d{0,15}$/, q: exact(READ_QUERY) },
    { name: "calendar", max: sum("K2_CALENDAR_BEFORE", "K6_CALENDAR_BLOCKED", "K10_CALENDAR_REOPENED"), m: "GET", re: new RegExp(`^/v1/listings/${L}/calendar$`), q: exact(calendar) },
    { name: "side", max: sum("K3_SIDE_EFFECTS_CREATE", "K9_SIDE_EFFECTS_CANCEL"), m: "GET", re: /^\/v1\/(guestPayments\/charges|conversations|tasks)$/, q: side }
  ];
  const used = Object.fromEntries(rules.map((r) => [r.name, 0]));
  let refused = 0;
  const guarded = async (url, init = {}) => {
    let u = null; try { u = new URL(String(url)); } catch { u = null; }
    const method = init && typeof init.method === "string" ? init.method : "GET";
    const rule = u && u.origin === "https://api.hostaway.com" && u.hash === "" && noProtected(u)
      ? rules.find((r) => r.m === method && r.re.test(u.pathname) && r.q(u.searchParams) && (r.body ? init.body !== undefined : init.body === undefined)) : undefined;
    if (!rule || used[rule.name] >= rule.max || (rule.name === "token" && String(url) !== `${HOSTAWAY_BASE}/accessTokens`) ||
      (rule.bodyOk && !rule.bodyOk(init.body))) {
      refused++; throw Object.assign(new Error("refused by local allowlist"), { name: "LocalRefusal" });
    }
    used[rule.name]++;
    return fetchImpl(url, init);
  };
  return { guarded, used: () => Object.freeze({ ...used, refused }) };
}

// How the one create was verified, from explicit enums only: REPLY_VERIFIED (the strict full create reply) vs READ_VERIFIED
// (unechoed ref; fresh read by id + unique same-id ref lookup) vs NOT_VERIFIED. Any value outside the allowlists -> "OTHER".
const CV_PATHS = Object.freeze(["NONE", "REPLY", "READ_FALLBACK"]);
const CV_RESULTS = Object.freeze(["NOT_VERIFIED", "REPLY_VERIFIED", "READ_VERIFIED"]);
export function createVerificationSummary(cv) {
  if (!isObj(cv)) return { path: "NONE", result: "NOT_VERIFIED", refEcho: null, refusal: null, readVerify: null, lookupVerify: null };
  const en = (v, list) => (v === null || v === undefined ? null : list.includes(v) ? v : "OTHER");
  return { path: en(cv.path, CV_PATHS) ?? "NONE", result: en(cv.result, CV_RESULTS) ?? "NOT_VERIFIED", refEcho: en(cv.refEcho, REF_ECHO_SHAPES),
    refusal: en(cv.refusal, REF_NOT_ECHOED_REFUSALS), readVerify: en(cv.readVerify, CONNECTED_VERIFY_READ_CODES), lookupVerify: en(cv.lookupVerify, CONNECTED_VERIFY_LOOKUP_CODES) };
}

/** Explicit allowlist of the report (already codes/ids only); nothing else leaves the process. */
export function summarizeConnected(report, extra = {}) {
  const pick = (o, keys) => (isObj(o) ? Object.fromEntries(keys.filter((k) => Object.prototype.hasOwnProperty.call(o, k)).map((k) => [k, o[k]])) : null);
  const ev = report.evidence ?? {};
  const obs = (o) => pick(o, ["code", "reads", "history", "observedAfterMs"]);
  const side = (o) => (isObj(o) ? { ...pick(o, ["ok", "code", "charges"]), conversations: pick(o.conversations, ["code", "ids"]), tasks: pick(o.tasks, ["code", "ids"]) } : null);
  return {
    status: report.status, passed: report.passed === true, version: report.version ?? CONNECTED_VERSION, manifestHash: report.manifestHash ?? null,
    writes: report.writes ?? { create: 0, cancel: 0 }, requests: report.requests ?? 0,
    halt: pick(report.halt, ["step", "code", "mismatches", "observedTotalMinor", "itemsSeen", "diag"]),
    steps: (report.steps || []).map((s) => pick(s, ["step", "code", "reservationId", "totalMinor", "mismatches"])),
    commandReply: pick(report.commandReply, ["code", "httpStatus", "mismatches"]),
    finalState: pick(report.finalState, ["code", "status", "identityOk", "mismatches"]),
    sideEffectsCreate: side(report.sideEffectsCreate), sideEffectsCancel: side(report.sideEffectsCancel),
    evidence: { hostawayBlocked: obs(ev.hostawayBlocked), airbnbBlocked: ev.airbnbBlocked ?? null, hostawayReopened: obs(ev.hostawayReopened), airbnbReopened: ev.airbnbReopened ?? null },
    syncProven: report.syncProven === true,
    createVerification: createVerificationSummary(report.createVerification),
    reconcile: (report.reconcile || []).map((r) => pick(r, ["ref", "reservationId", "readCode", "reservationStatus", "lookupCode", "foundReservationId"])),
    journalDurable: report.journalDurable !== false, journalFailures: report.journalFailures ?? [], runEndRecorded: report.runEndRecorded === true,
    ...(report.prerequisites ? { prerequisites: report.prerequisites } : {}),
    ...extra
  };
}

/**
 * deps (all injectable for tests): { root, base, git, readText, now, prompt, airbnbCheckpoint, fetchImpl, startTimer, clock,
 * timeoutMs, sync, sleep }. Returns { exitCode, output } with a plain sanitized output.
 */
export async function runConnectedExecuteCli(argv, deps = {}) {
  const root = deps.root ?? ROOT;
  const base = deps.base ?? dirname(root);
  const out = (exitCode, o) => ({ exitCode, output: { mode: "connected-execute", version: CONNECTED_EXECUTE_VERSION, filesWritten: 0, ...o } });
  const refuse = (stage, error, extra = {}) => out(error === "USAGE" ? CONNECTED_EXECUTE_EXIT.USAGE : CONNECTED_EXECUTE_EXIT.REFUSED,
    { ok: false, stage, error, credentialsRequested: false, network: "none", ...extra });
  const args = parseConnectedExecuteArgs(argv);
  if (!args.ok) return refuse("arguments", args.code);
  // 2. provenance before anything else is read
  const prov = verifyProvenance({ reviewedCommit: args.reviewedCommit, git: deps.git ?? makeGit(root), sources: CONNECTED_EXECUTE_SOURCES });
  if (!prov.ok) return refuse("provenance", prov.code);
  // 3. manifest
  let input;
  try {
    const text = (deps.readText ?? ((p) => { if (statSync(p).size > MAX_MANIFEST_BYTES) throw new Error("big"); return readFileSync(p, "utf8"); }))(resolve(args.manifestPath));
    input = JSON.parse(text);
  } catch { return refuse("manifest", "MANIFEST_UNREADABLE_OR_NOT_JSON"); }
  const now = deps.now ?? (() => new Date());
  const v = validateConnectedManifest(input, { now });
  if (!v.ok) return refuse("manifest", "MANIFEST_INVALID", { manifestErrors: v.errors ?? [], blockers: v.blockers ?? [] });
  if (v.manifest.reviewedCommit !== args.reviewedCommit) return refuse("manifest", "MANIFEST_REVIEWED_COMMIT_MISMATCH");
  // 4. the one canonical location (read-only check)
  const loc = checkRunLocation(base, v.hash);
  if (!loc.ok) return refuse("location", loc.code);
  if (args.mode === "dry-run") {
    const plan = planConnectedRun(input, { now });
    return out(CONNECTED_EXECUTE_EXIT.PASSED, { ok: true, stage: "dry-run", network: "none", credentialsRequested: false, reviewedCommit: args.reviewedCommit,
      manifestHash: v.hash, confirmToken: v.confirmToken, location: { token: loc.token, runDir: loc.runDir, runDirExists: loc.runDirExists,
        wouldRefuseAsReplay: loc.runDirExists }, plan });
  }
  // 5. execute bindings, all before any prompt
  if (args.confirm !== v.confirmToken) return refuse("bindings", "CONFIRM_TOKEN_MISMATCH");
  if (args.location !== loc.token) return refuse("bindings", "LOCATION_TOKEN_MISMATCH");
  if (loc.runDirExists) return refuse("bindings", "REPLAY_REFUSED_RUN_LOCATION_EXISTS");
  if (typeof deps.prompt !== "function" || typeof deps.airbnbCheckpoint !== "function") return refuse("bindings", "OWNER_CHANNEL_MISSING");
  // 6. the owner's private credential entry
  let creds;
  try { creds = await deps.prompt(); } catch (e) {
    return out(CONNECTED_EXECUTE_EXIT.REFUSED, { ok: false, stage: "credentials", error: codeOf(e, "CREDENTIALS_UNAVAILABLE"), credentialsRequested: true, network: "none" });
  }
  const getCredentials = async () => { const c = creds; creds = null; return c; };
  // 7. exclusive location + exclusive journal
  let claimed;
  try { claimed = claimRunLocation(base, v.hash); } catch (e) {
    creds = null;
    return out(CONNECTED_EXECUTE_EXIT.REFUSED, { ok: false, stage: "location", error: codeOf(e, "RUN_LOCATION_FAILED"), credentialsRequested: true, network: "none" });
  }
  let journal = null;
  let journalClosed = false;
  try {
    journal = createFileJournal(claimed.runDir, v.hash);
  } catch (e) {
    creds = null;
    return out(CONNECTED_EXECUTE_EXIT.REFUSED, { ok: false, stage: "journal", error: codeOf(e, "JOURNAL_CREATE_FAILED"), credentialsRequested: true, network: "none", filesWritten: 0 });
  }
  // 8. the reviewed sequence
  try {
    const nights = stayNights(v.manifest.stay);
    const guard = guardConnectedFetch(deps.fetchImpl ?? globalThis.fetch, { calendar: { startDate: nights[0], endDate: nights[nights.length - 1] },
      arrivalDate: v.manifest.stay.arrivalDate, departureDate: v.manifest.stay.departureDate });
    const transport = createHostawayTransport({ fetchImpl: guard.guarded, getCredentials, ...(deps.sleep ? { sleep: deps.sleep } : {}) });
    const report = await executeConnectedRun({ mode: "execute", manifest: input, confirm: args.confirm, reviewedCommit: args.reviewedCommit, transport, journal,
      now, airbnbCheckpoint: deps.airbnbCheckpoint, startTimer: deps.startTimer ?? realTimer, clock: deps.clock ?? (() => Date.now()),
      ...(deps.timeoutMs ? { timeoutMs: deps.timeoutMs } : {}), ...(deps.sync ? { sync: deps.sync } : {}) });
    let usage = null;
    try { usage = transport.usage(); } catch { usage = null; }
    // Close the journal BEFORE any final result: a failed close latches the run as not durable and not passed (the facts
    // about the writes, cancel and post-checks are kept as reported; nothing is retried).
    let closeCode = "JOURNAL_CLOSED";
    try { journal.close(); } catch { closeCode = "JOURNAL_CLOSE_FAILED"; }
    journalClosed = true;
    const closeFailed = closeCode !== "JOURNAL_CLOSED";
    const passed = report.passed === true && !closeFailed;
    const base0 = summarizeConnected(report);
    const output = summarizeConnected(report, { ok: passed, passed, journalClose: closeCode,
      ...(closeFailed ? { journalDurable: false, journalFailures: [...base0.journalFailures, "CLOSE"].slice(0, 17),
        status: report.status === "COMPLETED" ? "COMPLETED_JOURNAL_NOT_DURABLE" : report.status } : {}), stage: "run", reviewedCommit: args.reviewedCommit, location: { token: loc.token, runDir: loc.runDir },
      journalFile: journal.path ? journal.path.slice(claimed.runDir.length + 1) : null, filesWritten: 1, credentialsRequested: true,
      transportUsage: usage && ["none", "ok", "failed"].includes(usage.mintState) ? { mintState: usage.mintState, fetches: usage.fetches } : null, guard: guard.used() });
    const code = report.status === "REFUSED" ? CONNECTED_EXECUTE_EXIT.REFUSED : passed ? CONNECTED_EXECUTE_EXIT.PASSED : CONNECTED_EXECUTE_EXIT.NOT_PASSED;
    return out(code, output);
  } catch {
    return out(CONNECTED_EXECUTE_EXIT.INTERNAL, { ok: false, stage: "run", error: "INTERNAL_ERROR", filesWritten: 1, credentialsRequested: true });
  } finally {
    creds = null;
    // only on an early exit (internal error); the normal path closed it above and reported the outcome
    if (journal && !journalClosed && typeof journal.close === "function") { try { journal.close(); } catch { /* reported as INTERNAL_ERROR already */ } }
  }
}
