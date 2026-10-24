#!/usr/bin/env node
// E4 recovery PRECHECK — strictly READ-ONLY companion of cancel-only.mjs (reuses its reviewed checks; adds NO write path).
//
//   node scripts/e4-recovery/precheck.mjs --journal-check --journal-dir <run\journal> --reviewed-commit <sha>
//        offline: zero network, zero credentials, zero files written. Reports whether the ORIGINAL attempt-2 journal
//        passes the strict check the recovery will apply, the record SHAPE (types/steps/field names only, no values),
//        and whether a recovery journal already exists.
//   node scripts/e4-recovery/precheck.mjs --precheck --journal-dir <run\journal> --reviewed-commit <sha>
//        the same offline check, then the reviewed hidden prompt and ONE token mint, then bounded GETs only:
//        identity read of 70636076, unique-by-ref lookup, charges (complete count), conversations and tasks (bounded
//        traversal to a terminal empty page), calendar 2027-03-10..11. A local allowlist refuses every other request
//        (no PUT/POST except the token) before fetch. Nothing is journaled; no file is written.
// Output: codes, booleans, counts, ids of the fixed target/baseline, list metadata presence, and the FIRST transport
// failure's allowlisted diagnostic (stage/code/httpStatus/errorKind/causeCode via the runner's sanitizeTransportDiag) plus
// the transport's mint state/fetch count. Never provider bodies, guest data, conversation/task contents, the channel
// reservation id, URLs, account ids, tokens, keys or error text.

import { fileURLToPath } from "node:url";
import { resolve, join } from "node:path";
import { statSync } from "node:fs";
import { verifyProvenance, makeGit, EXECUTE_SOURCES } from "../e4-launcher/happy-execute.mjs";
import { createHostawayTransport, HOSTAWAY_BASE } from "../e4-transport/hostaway-transport.mjs";
import { promptHostawayCredentials } from "../e4-transport/credential-prompt.mjs";
import { createGate, parseReservationResponse, identityMismatches, reconcileAttempts, withTimeout, RunnerError, ADAPTER_CFG, READ_QUERY,
  DEFAULT_TIMEOUT_MS, sanitizeTransportDiag } from "../e4-write-runner/runner.mjs";
import { evaluateSideEffectResponse, sideEffectRequest, SIDE_EFFECT_SOURCES } from "../e4-write-runner/side-effects.mjs";
import { readJournalFile, journalFileName } from "../e4-write-runner/journal.mjs";
import { TARGET, BASELINE, RECOVERY_HASH, LIST_LIMIT, LIST_MAX_PAGES, LOOKUP_PAGES, checkAttempt2Journal, traverseList } from "./cancel-only.mjs";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const PRECHECK_SOURCES = Object.freeze([...EXECUTE_SOURCES, "scripts/e4-connected/safeguards.mjs", "scripts/e4-recovery/cancel-only.mjs", "scripts/e4-recovery/precheck.mjs"]);
export const PRECHECK_EXIT = Object.freeze({ OK: 0, USAGE: 64, REFUSED: 2, INCOMPLETE: 3, INTERNAL: 70 });
const STEPS = Object.freeze({ C1_IDENTITY: Object.freeze({ reads: 1, writes: 0 }), C2_LOOKUP: Object.freeze({ reads: LOOKUP_PAGES, writes: 0 }) });
const NO_WRITES = Object.freeze({ create: 0, cancel: 0 });
const DAY_STATUSES = ["available", "blocked", "mblocked", "hardBlock", "conflicted", "reserved", "pending", "mreserved"];
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Offline, read-only: strict attempt-2 check + record SHAPE (no values) + recovery-journal existence. */
export function journalCheck(jdir, { readJournal = readJournalFile, exists } = {}) {
  const ex = exists ?? ((p) => { try { statSync(p); return true; } catch (e) { return e && e.code === "ENOENT" ? false : null; } });
  let entries = null, readCode = "READ_OK";
  try { entries = readJournal(join(jdir, journalFileName(TARGET.attempt2Hash))); }
  catch (e) { readCode = e && e.code === "JOURNAL_CORRUPT" ? "ATTEMPT2_JOURNAL_CORRUPT" : "ATTEMPT2_JOURNAL_UNREADABLE"; }
  const chk = entries ? checkAttempt2Journal(entries) : { ok: false, code: readCode };
  const shape = entries ? entries.map((e) => ({ type: typeof e.type === "string" ? e.type : typeof e.type, ...(typeof e.step === "string" ? { step: e.step } : {}),
    fields: Object.keys(e).sort() })) : null;
  const rec = ex(join(jdir, journalFileName(RECOVERY_HASH)));
  return { attempt2Journal: { ok: chk.ok, code: chk.code, ...(chk.at !== undefined ? { at: chk.at } : {}) },
    recordShape: shape && shape.length <= 40 && shape.every((s) => /^[a-z-]{1,24}$/.test(s.type) && (!s.step || /^[A-Z0-9_]{1,40}$/.test(s.step))) ? shape : (shape ? "SHAPE_NOT_PRINTABLE" : null),
    recoveryJournal: rec === false ? "ABSENT" : rec === true ? "PRESENT" : "UNKNOWN", filesWritten: 0 };
}

/** Night states for 2027-03-10/11 (documented day object fields only). */
export function calendarNights(resp) {
  if (!isObj(resp) || resp.transportError) return { code: "CALENDAR_TRANSPORT_UNCERTAIN" };
  if (resp.httpStatus !== 200) return { code: "CALENDAR_HTTP_NOT_OK" };
  const j = resp.json;
  if (!isObj(j) || j.status !== "success" || !Array.isArray(j.result)) return { code: "CALENDAR_MALFORMED" };
  const nights = TARGET.nights.map((date) => {
    const d = j.result.filter((x) => isObj(x) && x.date === date);
    if (d.length !== 1) return { date, status: "MISSING" };
    return { date, status: DAY_STATUSES.includes(d[0].status) ? d[0].status : "OTHER",
      isAvailable: d[0].isAvailable === 1 || d[0].isAvailable === true ? true : d[0].isAvailable === 0 || d[0].isAvailable === false ? false : null };
  });
  return { code: nights.every((n) => n.status !== "MISSING") ? "CALENDAR_READ" : "CALENDAR_DAYS_MISSING", nights };
}

export function guardFetch(fetchImpl) {
  const R = TARGET.reservationId;
  const exact = (q) => (p) => [...p.keys()].length === Object.keys(q).length && Object.entries(q).every(([k, v]) => p.get(k) === String(v));
  const rules = [
    { name: "token", max: 1, m: "POST", path: "/v1/accessTokens", q: (p) => [...p.keys()].length === 0, body: true },
    { name: "read", max: 1, m: "GET", path: `/v1/reservations/${R}`, q: exact(READ_QUERY) },
    { name: "lookup", max: LOOKUP_PAGES, m: "GET", path: "/v1/reservations", q: (p) => {
      const base = { listingId: TARGET.listingId, channelId: 2000, arrivalStartDate: TARGET.from, arrivalEndDate: TARGET.from, limit: 100, includeResources: 1 };
      const rest = new URLSearchParams([...p.keys()].filter((k) => k !== "afterId").map((k) => [k, p.get(k)]));
      return exact(base)(rest) && (!p.has("afterId") || /^[1-9]\d{0,15}$/.test(p.get("afterId")));
    } },
    { name: "charges", max: 1, m: "GET", path: "/v1/guestPayments/charges", q: exact({ reservationId: R, limit: 100, offset: 0 }) },
    ...["conversations", "tasks"].map((n) => ({ name: n, max: LIST_MAX_PAGES, m: "GET", path: `/v1/${n}`,
      q: (p) => [...p.keys()].length === 3 && p.get("reservationId") === String(R) && p.get("limit") === String(LIST_LIMIT) && /^(0|[1-9]\d{0,3})$/.test(p.get("offset") ?? "") })),
    { name: "calendar", max: 1, m: "GET", path: `/v1/listings/${TARGET.listingId}/calendar`, q: exact({ startDate: TARGET.nights[0], endDate: TARGET.nights[1] }) }
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

/** Read-only reads against an injected transport. Never sends a write (the gate has no write budget and no cancellable id). */
const MINT_STATES = ["none", "ok", "failed"];
export async function runPrecheck({ transport, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const T = TARGET;
  // First transport failure, reduced to the runner's allowlisted diagnostic shape (or null). Observation only: it never
  // changes control flow, triggers a retry or a re-mint.
  let firstDiag = null;
  const note = (r) => { if (firstDiag === null && r && r.transportError) { const d = sanitizeTransportDiag(r.diag); if (d) firstDiag = d; } return r; };
  const GATE_TIMEOUT = Object.freeze({ transportError: true, diag: Object.freeze({ stage: "GATE", code: "GATE_TIMEOUT" }) });
  const state = { halted: false, readOnly: true, readableIds: new Set([T.reservationId]), cancellableId: null };
  const noJournal = Object.freeze({ durable: false, load: () => [], append: () => { throw new RunnerError("PRECHECK_WRITES_NOTHING"); } });
  const rawGate = createGate({ transport, journal: noJournal, timeoutMs, state, budgets: STEPS, writeBudget: NO_WRITES });
  // Every gate read (identity here, and the lookup pages sent by reconcileAttempts) is noted on the gate's RESULT, so the
  // gate-synthesized GATE_TIMEOUT / TRANSPORT_THREW are seen as well as transport failures. Pure pass-through: same
  // arguments, same result object, same throw; budgets, request counting, retries and flow stay the gate's own.
  const gate = Object.freeze({ send: async (step, req) => note(await rawGate.send(step, req)), requestCount: () => rawGate.requestCount() });
  let direct = 0;
  // Direct reads: noted once here (covers the transport result and the locally synthesized throw/timeout results).
  const THREW = Object.freeze({ transportError: true, diag: Object.freeze({ stage: "GATE", code: "TRANSPORT_THREW" }) });
  const send = async (req) => { direct++; return note(await withTimeout(() => Promise.resolve(transport.send(req)).then((r) => r, () => THREW), timeoutMs, GATE_TIMEOUT)); };
  const out = {};
  // identity
  let resp;
  try { resp = await gate.send("C1_IDENTITY", { method: "GET", path: `/reservations/${T.reservationId}`, query: READ_QUERY }); } catch { resp = { transportError: true, code: "GATE" }; }
  const p = parseReservationResponse(resp, "READ");
  const mm = p.ok ? identityMismatches(p.reservation, { reservationId: T.reservationId, listingId: T.listingId, from: T.from, to: T.to,
    totalMinor: T.totalMinor, currency: T.currency, channelId: T.channelId, bookingRef: T.ref, status: "new" }) : [];
  out.identity = { code: !p.ok ? p.code : mm.length ? "IDENTITY_MISMATCH" : "IDENTITY_OK", ...(mm.length ? { mismatches: mm } : {}), ...(p.ok ? { status: p.reservation.status } : {}) };
  // unique by ref
  try {
    const [rc] = await reconcileAttempts(gate, [{ ref: T.ref, stay: { arrivalDate: T.from, departureDate: T.to }, reservationId: null }], ADAPTER_CFG, () => {}, "C2_LOOKUP");
    out.lookup = { code: rc.lookupCode, sameId: rc.foundReservationId === T.reservationId };
  } catch { out.lookup = { code: "LOOKUP_FAILED", sameId: false }; }
  // side effects
  const chargesSrc = SIDE_EFFECT_SOURCES.find((s) => s.name === "CHARGES");
  let cr; try { cr = await send(sideEffectRequest(chargesSrc, T.reservationId)); } catch { cr = { transportError: true }; }
  out.charges = evaluateSideEffectResponse(chargesSrc, cr, T.reservationId).code;
  const listReq = (path) => ({ offset }) => send({ method: "GET", path, query: { reservationId: T.reservationId, limit: LIST_LIMIT, offset } });
  const conv = await traverseList(listReq("/conversations"), "CONVERSATIONS", T.reservationId);
  const tasks = await traverseList(listReq("/tasks"), "TASKS", T.reservationId);
  const pick = (r) => ({ code: r.code, pagesRead: r.pagesRead, ...(r.ids ? { ids: r.ids, countSeen: r.countSeen } : {}) });
  out.conversations = pick(conv); out.tasks = pick(tasks);
  // calendar
  let cal; try { cal = await send({ method: "GET", path: `/listings/${T.listingId}/calendar`, query: { startDate: T.nights[0], endDate: T.nights[1] } }); } catch { cal = { transportError: true }; }
  out.calendar = calendarNights(cal);
  const same = (a, b) => a.length === b.length && [...a].sort((x, y) => x - y).join() === [...b].sort((x, y) => x - y).join();
  out.precheckComplete = out.identity.code === "IDENTITY_OK" && out.lookup.code === "FOUND_BY_REF" && out.lookup.sameId &&
    ["CHARGES_NONE", "CHARGES_PRESENT"].includes(out.charges) && conv.state === "complete" && tasks.state === "complete" && out.calendar.code === "CALENDAR_READ";
  out.baselineMatches = out.precheckComplete && out.charges === "CHARGES_NONE" && same(conv.ids, BASELINE.conversations) && same(tasks.ids, BASELINE.tasks) &&
    out.calendar.nights.length === TARGET.nights.length && out.calendar.nights.every((n) => n.status === "reserved" && n.isAvailable === false);
  out.requests = gate.requestCount() + direct;                  // runner-level calls, NOT provider HTTP requests
  out.transportDiag = firstDiag;
  let usage = null;
  try { usage = typeof transport.usage === "function" ? transport.usage() : null; } catch { usage = null; }
  out.transportUsage = usage && MINT_STATES.includes(usage.mintState) && Number.isSafeInteger(usage.fetches) && usage.fetches >= 0 && usage.fetches <= 100
    ? { mintState: usage.mintState, fetches: usage.fetches } : null;  // fetches = real fetch() calls incl. the token mint
  return out;
}

const refuse = (exitCode, stage, error) => ({ exitCode, output: Object.freeze({ ok: false, mode: "recovery-precheck", stage, error, network: "none", filesWritten: 0 }) });

/** deps (tests): { git, prompt, fetchImpl, sleep, readJournal, exists, timeoutMs } */
export async function runPrecheckCli(argv, deps = {}) {
  const a = Array.isArray(argv) ? argv : [];
  if (a.length !== 5 || !["--journal-check", "--precheck"].includes(a[0])) return refuse(PRECHECK_EXIT.USAGE, "arguments", "USAGE");
  const mode = a[0], opts = {};
  for (let i = 1; i < 5; i += 2) {
    if (!["--journal-dir", "--reviewed-commit"].includes(a[i]) || Object.prototype.hasOwnProperty.call(opts, a[i]) || typeof a[i + 1] !== "string") return refuse(PRECHECK_EXIT.USAGE, "arguments", "USAGE");
    opts[a[i]] = a[i + 1];
  }
  const sha = opts["--reviewed-commit"], dir = opts["--journal-dir"];
  if (!/^[0-9a-f]{40}$/.test(sha)) return refuse(PRECHECK_EXIT.USAGE, "arguments", "REVIEWED_COMMIT_INVALID");
  if (!dir || dir.startsWith("--")) return refuse(PRECHECK_EXIT.USAGE, "arguments", "USAGE");
  const prov = verifyProvenance({ reviewedCommit: sha, git: deps.git ?? makeGit(ROOT), sources: PRECHECK_SOURCES });
  if (!prov.ok) return refuse(PRECHECK_EXIT.REFUSED, "provenance", prov.code);
  const jc = journalCheck(resolve(dir), { readJournal: deps.readJournal, exists: deps.exists });
  if (mode === "--journal-check") {
    const ok = jc.attempt2Journal.ok && jc.recoveryJournal === "ABSENT";
    return { exitCode: ok ? PRECHECK_EXIT.OK : PRECHECK_EXIT.INCOMPLETE, output: Object.freeze({ ok, mode: "journal-check", reviewedCommit: sha, network: "none", credentialsRequested: false, ...jc }) };
  }
  let creds;
  try { creds = await (deps.prompt ?? promptHostawayCredentials)(); } catch (e) {
    return refuse(PRECHECK_EXIT.REFUSED, "credentials", typeof e?.code === "string" && /^[A-Z_]{1,40}$/.test(e.code) ? e.code : "CREDENTIALS_UNAVAILABLE");
  }
  const getCredentials = async () => { const c = creds; creds = null; return c; };
  try {
    const guard = guardFetch(deps.fetchImpl ?? globalThis.fetch);
    const transport = createHostawayTransport({ fetchImpl: guard.guarded, getCredentials, ...(deps.sleep ? { sleep: deps.sleep } : {}) });
    const r = await runPrecheck({ transport, ...(deps.timeoutMs ? { timeoutMs: deps.timeoutMs } : {}) });
    const ok = r.precheckComplete && r.baselineMatches && jc.attempt2Journal.ok && jc.recoveryJournal === "ABSENT";
    return { exitCode: ok ? PRECHECK_EXIT.OK : PRECHECK_EXIT.INCOMPLETE, output: Object.freeze({ ok, mode: "recovery-precheck", reviewedCommit: sha,
      target: { reservationId: TARGET.reservationId, ref: TARGET.ref }, journal: jc, ...r, guard: guard.used(), filesWritten: 0 }) };
  } catch {
    return { exitCode: PRECHECK_EXIT.INTERNAL, output: Object.freeze({ ok: false, mode: "recovery-precheck", stage: "run", error: "INTERNAL_ERROR" }) };
  } finally { creds = null; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = await runPrecheckCli(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(r.output, null, 2)}\n`);
  process.exitCode = r.exitCode;
}
