#!/usr/bin/env node
// E4 CANCEL-ONLY RECOVERY for the attempt-2 test reservation 70636076 / MV-OTHL9CQU (offline-built; running it needs a
// concrete owner approval). It can send AT MOST ONE write, ever: the host cancel of that one reservation. It never creates.
//
//   node scripts/e4-recovery/cancel-only.mjs --journal-dir <run\journal> --confirm E4-RECOVER-<12 hex> --reviewed-commit <sha>
//
// Before any prompt or network (fail closed):
//   1. strict args; 2. read-only git provenance of every loaded source;
//   3. the ORIGINAL attempt-2 journal (only read, never modified) must show exactly: run-start of manifest f34575db…,
//      one HW1 create intent with ref MV-OTHL9CQU, its outcome RESERVATION_ID_INCONSISTENT, NO cancel intent/outcome,
//      run-end HALTED;
//   4. the RECOVERY journal (exclusive, bound to attempt-2 hash + reservation + ref) must not exist: one run ever per folder;
//   5. the confirm token must equal E4-RECOVER-<recovery hash12>.
// Then the reviewed hidden prompt and the reviewed single-mint transport behind a local URL allowlist, and:
//   R1 identity read by id (full identity, status new)    R2 unique by ref (bounded lookup, same id)
//   R3 side effects BEFORE: charges (documented complete count) must be zero; conversations and tasks by bounded
//      offset traversal to a terminal EMPTY page must equal the approved baseline (conversations exactly {55098382},
//      tasks none). Anything unprovable is UNKNOWN => HALT. The probe is never relaxed or skipped.
//   R4 FRESH identity read immediately before the write; only then is 70636076 cancellable
//   W1 ONE host cancel (write-ahead intent in the recovery journal; one attempt; reply must show the same identity,
//      cancelled). Ambiguous/failed => HALT; never retried.
//   R5 read by id after (cancelled?)   R6 side effects AFTER (same rules; reported)   R7 calendar 2027-03-10/11 (reported)
//   R8 (only if R7 is not reopened AND R5 independently read `cancelled`): bounded read-only calendar observation
//      (safeguards.observeSync: N consecutive confirming reads, overall deadline, read cap). Never a write, never a retry.
// Three results are reported SEPARATELY and never merged: the cancel COMMAND REPLY (code, httpStatus, mismatching identity
// field NAMES), the independent FINAL STATE read (R5), and the calendar (immediate R7, then delayed R8). A command reply
// that does not show the full identity with `cancelled` keeps status HALTED / ok false whatever R5..R8 show.
// Output: codes, booleans, counts and ids of the fixed target only. Never provider bodies, guest data, the channel
// reservation identifier, conversation/task contents, tokens or error text.
// Residuals: list reads are sequential, not an atomic snapshot; a concurrent change between pages can go undetected
// (duplicates and count changes ARE detected). Message sends inside an existing conversation are NOT observable here.

import { fileURLToPath } from "node:url";
import { resolve, join } from "node:path";
import { statSync } from "node:fs";
import { createHash } from "node:crypto";
import { verifyProvenance, makeGit, EXECUTE_SOURCES } from "../e4-launcher/happy-execute.mjs";
import { createHostawayTransport, HOSTAWAY_BASE } from "../e4-transport/hostaway-transport.mjs";
import { promptHostawayCredentials } from "../e4-transport/credential-prompt.mjs";
import {
  createGate, parseReservationResponse, identityMismatches, reconcileAttempts, sanitizeJournalEntry,
  withTimeout, RunnerError, ADAPTER_CFG, READ_QUERY, CANCEL_BODY, DEFAULT_TIMEOUT_MS, E4_TEST_LISTING_ID
} from "../e4-write-runner/runner.mjs";
import { evaluateSideEffectResponse, sideEffectRequest, SIDE_EFFECT_SOURCES } from "../e4-write-runner/side-effects.mjs";
import { createFileJournal, readJournalFile, journalFileName } from "../e4-write-runner/journal.mjs";
import { observeSync, realTimer } from "../e4-connected/safeguards.mjs";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const RECOVERY_VERSION = "e4-cancel-only-v1";
export const RECOVERY_SOURCES = Object.freeze([...EXECUTE_SOURCES, "scripts/e4-connected/safeguards.mjs", "scripts/e4-recovery/cancel-only.mjs"]);
export const RECOVERY_EXIT = Object.freeze({ OK: 0, USAGE: 64, REFUSED: 2, HALTED: 3, INTERNAL: 70 });
export const TARGET = Object.freeze({
  attempt2Hash: "f34575db1138082472d4fe63ac2b29f464043e0ca2c0287b6a37c828bb20e112",
  reservationId: 70636076, ref: "MV-OTHL9CQU", listingId: E4_TEST_LISTING_ID, from: "2027-03-10", to: "2027-03-12",
  nights: Object.freeze(["2027-03-10", "2027-03-11"]), totalMinor: 25000, currency: "USD", channelId: 2000
});
// Approved side-effect baseline (from the dashboard observation; must be re-approved in the owner package). Ids only.
export const BASELINE = Object.freeze({ conversations: Object.freeze([55098382]), tasks: Object.freeze([]) });
export const LIST_LIMIT = 100;          // requested page size; completeness never assumes the server honoured it
export const LIST_MAX_PAGES = 3;        // per list per pass (terminal empty page included)
export const LOOKUP_PAGES = 5;          // = adapter LOOKUP_MAX_PAGES (asserted in tests)
// Delayed calendar observation after a cancel (read-only): first read at once, then every 5 s; 2 consecutive "open"
// reads needed; at most 10 reads and 60 s overall. A timeout or cap concludes nothing.
export const SETTLE = Object.freeze({ intervalMs: 5000, timeoutMs: 60000, maxReads: 10, confirmReads: 2 });
export const RECOVERY_HASH = createHash("sha256").update(`${RECOVERY_VERSION}:${TARGET.attempt2Hash}:${TARGET.reservationId}:${TARGET.ref}`).digest("hex");
export const CONFIRM_TOKEN = `E4-RECOVER-${RECOVERY_HASH.slice(0, 12)}`;
export const RECOVERY_STEPS = Object.freeze({
  R1_IDENTITY: Object.freeze({ reads: 1, writes: 0 }),
  R2_LOOKUP: Object.freeze({ reads: LOOKUP_PAGES, writes: 0 }),
  R3_SIDE_EFFECTS_BEFORE: Object.freeze({ reads: 1 + 2 * LIST_MAX_PAGES, writes: 0 }),
  R4_PRECANCEL: Object.freeze({ reads: 1, writes: 0 }),
  W1_CANCEL: Object.freeze({ reads: 0, writes: 1, kind: "cancel", executable: true }),
  R5_POSTCANCEL: Object.freeze({ reads: 1, writes: 0 }),
  R6_SIDE_EFFECTS_AFTER: Object.freeze({ reads: 1 + 2 * LIST_MAX_PAGES, writes: 0 }),
  R7_CALENDAR: Object.freeze({ reads: 1, writes: 0 }),
  R8_CALENDAR_SETTLE: Object.freeze({ reads: SETTLE.maxReads, writes: 0 })
});
const WRITE_BUDGET = Object.freeze({ create: 0, cancel: 1 });
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isPosInt = (v) => Number.isSafeInteger(v) && v > 0;
const sameId = (v, id) => v === id || (typeof v === "string" && v === String(id));

// ---------------------------------------------------------------------------------------------
// Pure checks

/**
 * The ORIGINAL attempt-2 journal must be EXACTLY the sequence the reviewed runner (ad5510f) writes when the create reply
 * fails the id check: run-start -> P0 read -> P1 read -> HW1 create intent -> HW1 outcome -> HW1 side-effect-check ->
 * HW1 halt -> one HR_RECONCILE -> run-end HALTED. Each record may carry only the fields that runner writes for it;
 * the intent and outcome must be bound to the target ref, dates and total. Unknown types/steps/fields, any other or
 * extra record (a potential write), reordering or truncation => refused. The journal is only read, never modified.
 */
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ATTEMPT2_SEQUENCE = Object.freeze([
  { type: "run-start", keys: ["runId", "manifestHash", "refs"], ok: (e) => /^[0-9a-f]{16}$/.test(e.runId) && e.manifestHash === TARGET.attempt2Hash &&
    Array.isArray(e.refs) && e.refs.length === 2 && e.refs[1] === TARGET.ref && e.refs[0] !== TARGET.ref && e.refs.every((r) => typeof r === "string" && /^MV-[A-Z0-9]{6,10}$/.test(r)) },
  { type: "read", step: "P0_PREFLIGHT_PRICE", keys: ["kind", "code", "observedTotalMinor", "httpStatus"], ok: (e) => e.kind === "calc" && e.code === "PRICE_OK" &&
    e.observedTotalMinor === TARGET.totalMinor && e.httpStatus === 200 },
  { type: "read", step: "P1_PREFLIGHT_CLEAR", keys: ["kind", "code", "ref", "itemsSeen"], ok: (e, es) => e.kind === "lookup" && e.code === "NOT_FOUND_NON_AUTHORITATIVE" &&
    e.ref === es[0].refs[0] && e.itemsSeen === 0 },
  { type: "intent", step: "HW1_CREATE", noAt: true, keys: ["kind", "ref", "from", "to", "totalMinor"], ok: (e) => e.kind === "create" && e.ref === TARGET.ref &&
    e.from === TARGET.from && e.to === TARGET.to && e.totalMinor === TARGET.totalMinor },
  { type: "outcome", step: "HW1_CREATE", keys: ["kind", "ref", "code", "evidence", "transport"], ok: (e) => e.kind === "create" && e.ref === TARGET.ref &&
    e.code === "RESERVATION_ID_INCONSISTENT" && e.transport === undefined && isObj(e.evidence) && e.evidence.outcome === "ambiguous" &&
    e.evidence.code === "RESERVATION_ID_INCONSISTENT" && e.evidence.httpStatus === 200 && e.evidence.reservationId === undefined && e.evidence.reservation === undefined },
  { type: "side-effect-check", step: "HW1_CREATE", keys: ["code"], ok: (e) => e.code === "SIDE_EFFECT_CHECK_UNKNOWN" },
  { type: "halt", step: "HW1_CREATE", keys: ["code"], ok: (e) => e.code === "SIDE_EFFECT_CHECK_UNKNOWN" },
  { type: "reconcile", step: "HR_RECONCILE", keys: ["ref", "code"], ok: (e) => e.ref === TARGET.ref && e.code === "ITEM_RESERVATION_ID_INCONSISTENT" },
  { type: "run-end", keys: ["code"], ok: (e) => e.code === "HALTED" }
]);
export function checkAttempt2Journal(entries) {
  const no = (code, i) => ({ ok: false, code: `ATTEMPT2_JOURNAL_${code}`, ...(i === undefined ? {} : { at: i }) });
  if (!Array.isArray(entries) || !entries.every(isObj)) return no("SHAPE");
  if (entries.some((e) => e.step === "HW2_CANCEL" || e.kind === "cancel")) return no("CANCEL_ALREADY_ATTEMPTED");
  if (entries.length !== ATTEMPT2_SEQUENCE.length) return no(entries.length < ATTEMPT2_SEQUENCE.length ? "TRUNCATED_OR_SHORT" : "UNEXPECTED_EXTRA_RECORDS");
  for (let i = 0; i < ATTEMPT2_SEQUENCE.length; i++) {
    const want = ATTEMPT2_SEQUENCE[i], e = entries[i];
    if (e.type !== want.type || e.step !== want.step) return no("UNEXPECTED_RECORD", i);
    // The reviewed createGate appends the write INTENT directly (no jappend/now()), so the authentic intent has NO `at`;
    // every other record is written via jappend and carries one. Exactly that shape is accepted.
    const allowed = ["type", ...(want.noAt ? [] : ["at"]), ...(want.step ? ["step"] : []), ...want.keys];
    if (Object.keys(e).some((k) => !allowed.includes(k))) return no("UNKNOWN_FIELD", i);
    if (!want.noAt) {
      const prev = entries.slice(0, i).reverse().find((x) => typeof x.at === "string");
      if (typeof e.at !== "string" || !ISO.test(e.at) || (prev && e.at < prev.at)) return no("TIMESTAMP_INVALID", i);
    }
    if (!want.ok(e, entries)) return no("RECORD_MISMATCH", i);
  }
  return { ok: true, code: "ATTEMPT2_JOURNAL_CANCEL_UNUSED" };
}

/**
 * Bounded completeness for a reservation-filtered list without a documented complete count (conversations, tasks).
 * Documented: limit = "Maximum number of items in the list", offset = "Number of items to skip from beginning".
 * Terminal criterion: an EMPTY page at offset = number of items actually received (never the requested page size).
 * Every item must carry a positive id and the filtered reservationId; ids must be unique across pages; any present
 * `count` must be a non-negative safe integer, identical on every page and equal to the final total; page > limit,
 * a cap without the empty page, transport/HTTP/envelope doubt => UNKNOWN. Absent metadata is never read as zero.
 */
export async function traverseList(fetchPage, source, reservationId) {
  const unknown = (code, pages) => ({ state: "unknown", code: `${source}_${code}`, pagesRead: pages });
  const ids = []; let offset = 0; let count; let countMode;     // countMode fixed by the FIRST page: "present" | "absent"
  for (let page = 1; page <= LIST_MAX_PAGES; page++) {
    let r;
    try { r = await fetchPage({ offset }); } catch { return unknown("TRANSPORT_UNCERTAIN", page - 1); }
    if (!isObj(r) || r.transportError) return unknown("TRANSPORT_UNCERTAIN", page - 1);
    if (r.httpStatus !== 200) return unknown("HTTP_NOT_OK", page);
    const j = r.json;
    if (!isObj(j) || j.status !== "success" || !Array.isArray(j.result)) return unknown("MALFORMED", page);
    const items = j.result;
    if (items.length > LIST_LIMIT) return unknown("PAGE_OVER_LIMIT", page);
    const has = Object.prototype.hasOwnProperty.call(j, "count") && j.count !== null;
    if (countMode === undefined) countMode = has ? "present" : "absent";
    else if ((countMode === "present") !== has) return unknown("COUNT_CHANGED", page);   // metadata appearing/vanishing
    if (has) {
      if (!(Number.isSafeInteger(j.count) && j.count >= 0)) return unknown("COUNT_INVALID", page);
      if (count !== undefined && j.count !== count) return unknown("COUNT_CHANGED", page);
      count = j.count;
    }
    if (items.length === 0) {
      if (count !== undefined && count !== ids.length) return unknown("COUNT_INCONSISTENT", page);
      return { state: "complete", code: `${source}_COMPLETE`, ids: [...ids].sort((a, b) => a - b), pagesRead: page, countSeen: count !== undefined };
    }
    for (const it of items) {
      if (!isObj(it) || !isPosInt(it.id)) return unknown("ITEM_ID_INVALID", page);
      if (!sameId(it.reservationId, reservationId)) return unknown("FILTER_NOT_APPLIED", page);
      if (ids.includes(it.id)) return unknown("DUPLICATE_ITEM", page);
      ids.push(it.id);
    }
    if (count !== undefined && ids.length > count) return unknown("COUNT_INCONSISTENT", page);
    offset += items.length;
  }
  return unknown("PAGE_CAP_REACHED", LIST_MAX_PAGES);
}

const sameSet = (a, b) => a.length === b.length && [...a].sort((x, y) => x - y).every((v, i) => v === [...b].sort((x, y) => x - y)[i]);
/** -> { ok, code, charges, conversations, tasks } (codes/ids/counts only). ok only when everything equals the baseline. */
export async function readSideEffects(send, reservationId) {
  const chargesSrc = SIDE_EFFECT_SOURCES.find((s) => s.name === "CHARGES");
  let cr;
  try { cr = await send(sideEffectRequest(chargesSrc, reservationId)); } catch { cr = { transportError: true }; }
  const charges = evaluateSideEffectResponse(chargesSrc, cr, reservationId);
  const listReq = (path) => ({ offset }) => send({ method: "GET", path, query: { reservationId, limit: LIST_LIMIT, offset } });
  const conversations = await traverseList(listReq("/conversations"), "CONVERSATIONS", reservationId);
  const tasks = await traverseList(listReq("/tasks"), "TASKS", reservationId);
  const out = { charges: charges.code, conversations: { code: conversations.code, ...(conversations.ids ? { ids: conversations.ids } : {}) },
    tasks: { code: tasks.code, ...(tasks.ids ? { ids: tasks.ids } : {}) } };
  if (charges.state !== "zero") return { ok: false, code: charges.state === "present" ? "CHARGES_PRESENT" : "CHARGES_UNKNOWN", ...out };
  if (conversations.state !== "complete") return { ok: false, code: "CONVERSATIONS_UNKNOWN", ...out };
  if (tasks.state !== "complete") return { ok: false, code: "TASKS_UNKNOWN", ...out };
  if (!sameSet(conversations.ids, BASELINE.conversations)) return { ok: false, code: "CONVERSATIONS_BASELINE_MISMATCH", ...out };
  if (!sameSet(tasks.ids, BASELINE.tasks)) return { ok: false, code: "TASKS_BASELINE_MISMATCH", ...out };
  return { ok: true, code: "SIDE_EFFECTS_MATCH_BASELINE", ...out };
}

/** Calendar nights 2027-03-10 and 2027-03-11 must both be `available` with isAvailable true/1 (documented day object). */
export function evaluateCalendar(resp) {
  if (!isObj(resp) || resp.transportError) return "CALENDAR_TRANSPORT_UNCERTAIN";
  if (resp.httpStatus !== 200) return "CALENDAR_HTTP_NOT_OK";
  const j = resp.json;
  if (!isObj(j) || j.status !== "success" || !Array.isArray(j.result)) return "CALENDAR_MALFORMED";
  const days = j.result.filter((d) => isObj(d) && TARGET.nights.includes(d.date));
  if (days.length !== TARGET.nights.length || new Set(days.map((d) => d.date)).size !== TARGET.nights.length) return "CALENDAR_DAYS_MISSING";
  return days.every((d) => d.status === "available" && (d.isAvailable === 1 || d.isAvailable === true)) ? "CALENDAR_REOPENED" : "CALENDAR_NOT_REOPENED";
}

const CAL_STATUSES = Object.freeze(["available", "reserved", "pending", "blocked", "hardBlock", "mreserved", "mblocked", "conflicted"]);
/** Per-night state codes for exactly TARGET.nights, built only from enums: NIGHT_<STATUS|OTHER|MISSING>_<TRUE|FALSE|OTHER>. */
export function calendarNightCodes(resp) {
  const ok = isObj(resp) && !resp.transportError && resp.httpStatus === 200 && isObj(resp.json) && resp.json.status === "success" && Array.isArray(resp.json.result);
  if (!ok) return null;
  return TARGET.nights.map((date) => {
    const d = resp.json.result.filter((x) => isObj(x) && x.date === date);
    if (d.length !== 1) return { date, code: d.length ? "NIGHT_DUPLICATED" : "NIGHT_MISSING" };
    const st = CAL_STATUSES.includes(d[0].status) ? d[0].status.toUpperCase() : "OTHER";
    const av = d[0].isAvailable === 1 || d[0].isAvailable === true ? "TRUE" : d[0].isAvailable === 0 || d[0].isAvailable === false ? "FALSE" : "OTHER";
    return { date, code: `NIGHT_${st}_${av}` };
  });
}

// ---------------------------------------------------------------------------------------------
// Network allowlist (defence in depth under the gate): exact method + path + query sets, each with a hard count.

const TOKEN_URL = `${HOSTAWAY_BASE}/accessTokens`;
export function guardFetch(fetchImpl) {
  const R = TARGET.reservationId;
  const exact = (q) => (p) => Object.keys(q).length === [...p.keys()].length && Object.entries(q).every(([k, v]) => p.get(k) === String(v));
  const rules = [
    { name: "token", max: 1, m: "POST", path: "/v1/accessTokens", q: (p) => [...p.keys()].length === 0, body: true },
    { name: "read", max: 3, m: "GET", path: `/v1/reservations/${R}`, q: exact(READ_QUERY) },
    { name: "lookup", max: LOOKUP_PAGES, m: "GET", path: "/v1/reservations", q: (p) => {
      const base = { listingId: TARGET.listingId, channelId: 2000, arrivalStartDate: TARGET.from, arrivalEndDate: TARGET.from, limit: 100, includeResources: 1 };
      const keys = [...p.keys()].filter((k) => k !== "afterId");
      return exact(base)(new URLSearchParams(keys.map((k) => [k, p.get(k)]))) && (!p.has("afterId") || /^[1-9]\d{0,15}$/.test(p.get("afterId")));
    } },
    { name: "charges", max: 2, m: "GET", path: "/v1/guestPayments/charges", q: exact({ reservationId: R, limit: 100, offset: 0 }) },
    ...["conversations", "tasks"].map((n) => ({ name: n, max: 2 * LIST_MAX_PAGES, m: "GET", path: `/v1/${n}`,
      q: (p) => [...p.keys()].length === 3 && p.get("reservationId") === String(R) && p.get("limit") === String(LIST_LIMIT) && /^(0|[1-9]\d{0,3})$/.test(p.get("offset") ?? "") })),
    { name: "cancel", max: 1, m: "PUT", path: `/v1/reservations/${R}/statuses/cancelled`, q: (p) => [...p.keys()].length === 0, body: true },
    { name: "calendar", max: 1 + SETTLE.maxReads, m: "GET", path: `/v1/listings/${TARGET.listingId}/calendar`, q: exact({ startDate: TARGET.nights[0], endDate: TARGET.nights[1] }) }
  ];
  const used = Object.fromEntries(rules.map((r) => [r.name, 0]));
  let refused = 0;
  const guarded = async (url, init = {}) => {
    let u = null; try { u = new URL(String(url)); } catch { u = null; }
    const method = init && typeof init.method === "string" ? init.method : "GET";
    const rule = u && u.origin === "https://api.hostaway.com" ? rules.find((r) => r.m === method && r.path === u.pathname && r.q(u.searchParams) &&
      (r.body ? init.body !== undefined : init.body === undefined)) : undefined;
    if (!rule || used[rule.name] >= rule.max || (rule.name === "token" && String(url) !== TOKEN_URL)) {
      refused++; throw Object.assign(new Error("refused by local allowlist"), { name: "LocalRefusal" });
    }
    used[rule.name]++;
    return fetchImpl(url, init);
  };
  return { guarded, used: () => Object.freeze({ ...used, refused }) };
}

// ---------------------------------------------------------------------------------------------
// The run (transport + journal injected; no file or network access of its own)

export async function runRecovery({ transport, journal, now, timeoutMs = DEFAULT_TIMEOUT_MS, startTimer = realTimer, clock = () => Date.now(), settle = SETTLE }) {
  const T = TARGET;
  const state = { halted: false, readOnly: false, readableIds: new Set([T.reservationId]), cancellableId: null };
  const report = { status: "RUNNING", version: RECOVERY_VERSION, recoveryHash: RECOVERY_HASH, steps: [], cancel: { sent: false, code: null },
    sideEffectsBefore: null, sideEffectsAfter: null, postcancelStatus: null, postcancelIdentityOk: false, calendar: null, halt: null,
    finalState: null, calendarImmediate: null, calendarSettled: null, calendarFinal: null,
    journalDurable: true, journalFailures: [], runEndRecorded: false };
  const san = (e) => sanitizeJournalEntry(e, { steps: RECOVERY_STEPS });
  const jappend = (e) => journal.append(san({ ...e, at: now().toISOString() }));
  try { jappend({ type: "run-start", manifestHash: RECOVERY_HASH, refs: [T.ref] }); }
  catch { return { ...report, status: "REFUSED", halt: { step: "R0", code: "JOURNAL_WRITE_FAILED" }, journalDurable: false, journalFailures: ["RUN_START"], requests: 0 }; }
  const gate = createGate({ transport, journal, timeoutMs, state, budgets: RECOVERY_STEPS, writeBudget: WRITE_BUDGET });
  let direct = 0;
  const send = (req) => { direct++; return withTimeout(() => Promise.resolve(transport.send(req)).then((r) => r, () => ({ transportError: true })),
    timeoutMs, { transportError: true }); };
  // Every journal append failure LATCHES: the run can never again report a clean/durable result (no retry, no extra write).
  const latch = (step) => { report.journalDurable = false; if (report.journalFailures.length < 16) report.journalFailures.push(step ?? "UNKNOWN"); };
  const safe = (e) => { try { jappend(e); return true; } catch { latch(e && e.step ? e.step : e && e.type === "run-end" ? "RUN_END" : undefined); return false; } };
  const halt = (step, code, extra = {}) => {
    state.halted = true; state.cancellableId = null;          // the gate may already have latched halted itself
    if (report.halt) return;
    report.halt = { step, code, ...extra };
    safe({ type: "halt", step, code, ...extra });
  };
  const expected = (status) => ({ reservationId: T.reservationId, listingId: T.listingId, from: T.from, to: T.to, totalMinor: T.totalMinor,
    currency: T.currency, channelId: T.channelId, bookingRef: T.ref, status });
  const readId = async (step, status) => {
    let resp;
    try { resp = await gate.send(step, { method: "GET", path: `/reservations/${T.reservationId}`, query: READ_QUERY }); }
    catch (e) { halt(step, e instanceof RunnerError ? e.code : "INTERNAL_ERROR"); return null; }
    const p = parseReservationResponse(resp, "READ");
    const mm = p.ok ? identityMismatches(p.reservation, expected(status)) : [];
    const code = !p.ok ? p.code : mm.length ? "IDENTITY_MISMATCH" : "IDENTITY_OK";
    if (!safe({ type: "read", step, kind: "read", code, reservationId: T.reservationId, ...(p.httpStatus ? { httpStatus: p.httpStatus } : {}),
      ...(mm.length ? { mismatches: mm } : {}) })) halt(step, "JOURNAL_WRITE_FAILED");
    report.steps.push({ step, code, ...(mm.length ? { mismatches: mm } : {}), ...(p.ok ? { status: p.reservation.status } : {}) });
    return { ok: p.ok && !mm.length, reservation: p.ok ? p.reservation : null, code };
  };
  const sideEffects = async (step) => {
    const se = await readSideEffects(send, T.reservationId);
    if (!safe({ type: "side-effect-check", step, code: se.code })) halt(step, "JOURNAL_WRITE_FAILED");
    return se;
  };

  // R1 identity, R2 unique by ref
  const r1 = await readId("R1_IDENTITY", "new");
  if (!state.halted && !r1.ok) halt("R1_IDENTITY", r1.code);
  if (!state.halted) {
    const [rc] = await reconcileAttempts(gate, [{ ref: T.ref, stay: { arrivalDate: T.from, departureDate: T.to }, reservationId: null }],
      ADAPTER_CFG, (e) => { if (!safe({ ...e, step: "R2_LOOKUP" })) halt("R2_LOOKUP", "JOURNAL_WRITE_FAILED"); }, "R2_LOOKUP");
    report.steps.push({ step: "R2_LOOKUP", code: rc.lookupCode, ...(rc.foundReservationId ? { reservationId: rc.foundReservationId } : {}) });
    if (!state.halted && !(rc.lookupCode === "FOUND_BY_REF" && rc.foundReservationId === T.reservationId)) halt("R2_LOOKUP", `LOOKUP_NOT_UNIQUE_SAME_ID:${rc.lookupCode}`);
  }
  // R3 side effects must equal the approved baseline
  if (!state.halted) {
    report.sideEffectsBefore = await sideEffects("R3_SIDE_EFFECTS_BEFORE");
    if (!report.sideEffectsBefore.ok) halt("R3_SIDE_EFFECTS_BEFORE", report.sideEffectsBefore.code);
  }
  // R4 fresh read; only then cancellable
  if (!state.halted) {
    const r4 = await readId("R4_PRECANCEL", "new");
    if (!state.halted && !r4.ok) halt("R4_PRECANCEL", r4.code);
    if (!state.halted) state.cancellableId = T.reservationId;
  }
  // W1 the one cancel
  if (!state.halted && state.cancellableId === T.reservationId) {
    let resp = null;
    try {
      resp = await gate.send("W1_CANCEL", { method: "PUT", path: `/reservations/${T.reservationId}/statuses/cancelled`, query: {}, body: CANCEL_BODY },
        { writeKind: "cancel", intent: { reservationId: T.reservationId, ref: T.ref } });
      report.cancel.sent = true;
    } catch (e) {
      report.cancel.code = e instanceof RunnerError ? e.code : "INTERNAL_ERROR";
      if (report.cancel.code === "JOURNAL_WRITE_FAILED") latch("W1_CANCEL");       // the write-ahead intent was not durable
    }
    state.cancellableId = null;                                     // one attempt, whatever happened
    let mm = [];
    if (resp) {
      const p = parseReservationResponse(resp, "CANCEL");
      mm = p.ok ? identityMismatches(p.reservation, expected("cancelled")) : [];
      report.cancel.code = !p.ok ? p.code : mm.length ? "CANCEL_RESPONSE_MISMATCH" : "VERIFIED_CANCELLED";
      // The command reply is reported on its own: code, HTTP status and the NAMES of mismatching identity fields (never values).
      if (p.httpStatus) report.cancel.httpStatus = p.httpStatus;
      if (mm.length) report.cancel.mismatches = mm;
      if (!safe({ type: "outcome", step: "W1_CANCEL", kind: "cancel", reservationId: T.reservationId, code: report.cancel.code,
        ...(p.httpStatus ? { httpStatus: p.httpStatus } : {}), ...(resp.transportError ? { transport: resp.code } : {}),
        ...(mm.length ? { mismatches: mm } : {}) })) halt("W1_CANCEL", "JOURNAL_WRITE_FAILED");
    }
    if (report.cancel.code !== "VERIFIED_CANCELLED") halt("W1_CANCEL", report.cancel.code ?? "CANCEL_NOT_VERIFIED", mm.length ? { mismatches: mm } : {});
  }
  state.readOnly = true;
  // R5..R7: read-only verification (also after an ambiguous cancel: reads only)
  if (report.cancel.sent) {
    const r5 = await readId("R5_POSTCANCEL", "cancelled");
    report.postcancelStatus = r5 && r5.reservation ? r5.reservation.status : null;
    report.postcancelIdentityOk = !!(r5 && r5.ok);
    const r5mm = report.steps.find((x) => x.step === "R5_POSTCANCEL")?.mismatches;
    report.finalState = { code: r5 ? r5.code : "NOT_READ", status: report.postcancelStatus, identityOk: report.postcancelIdentityOk, ...(r5mm ? { mismatches: r5mm } : {}) };
    report.sideEffectsAfter = await sideEffects("R6_SIDE_EFFECTS_AFTER");
    const calendarRead = async () => {
      try { return await send({ method: "GET", path: `/listings/${T.listingId}/calendar`, query: { startDate: T.nights[0], endDate: T.nights[1] } }); }
      catch { return { transportError: true }; }
    };
    const cal = await calendarRead();
    report.calendar = evaluateCalendar(cal);
    const nights = calendarNightCodes(cal);
    report.calendarImmediate = { code: report.calendar, ...(nights ? { nights } : {}) };
    safe({ type: "read", step: "R7_CALENDAR", kind: "read", code: report.calendar });
    for (const n of nights ?? []) safe({ type: "read", step: "R7_CALENDAR", kind: "read", code: n.code, from: n.date });
    report.calendarFinal = report.calendar;
    // R8: delayed, read-only observation; only when the immediate read is not reopened AND the independent final state is
    // cancelled with full identity (otherwise no reopening is expected and nothing is polled).
    if (report.calendar !== "CALENDAR_REOPENED" && report.postcancelIdentityOk && report.postcancelStatus === "cancelled") {
      let o;
      try {
        o = await observeSync({ readCalendar: calendarRead, nights: [...T.nights], expect: "open", intervalMs: settle.intervalMs, timeoutMs: settle.timeoutMs,
          maxReads: settle.maxReads, confirmReads: settle.confirmReads, startTimer, now: clock });
      } catch { o = { code: "SETTLE_INTERNAL_ERROR", reads: 0, history: [] }; }
      report.calendarSettled = { code: o.code, reads: o.reads, history: o.history, ...(o.observedAfterMs !== undefined ? { observedAfterMs: o.observedAfterMs } : {}) };
      safe({ type: "read", step: "R8_CALENDAR_SETTLE", kind: "read", code: `SETTLE_${o.code}`, itemsSeen: Math.min(o.reads, 500) });
      if (o.code === "OBSERVED_STABLE") report.calendarFinal = "CALENDAR_REOPENED_DELAYED";
    }
  }
  const verified = report.cancel.code === "VERIFIED_CANCELLED" && report.postcancelIdentityOk === true && report.postcancelStatus === "cancelled";
  report.status = verified ? "CANCELLED_VERIFIED" : "HALTED";
  report.runEndRecorded = safe({ type: "run-end", code: report.status === "HALTED" || !report.journalDurable ? "HALTED" : "COMPLETED" });
  // Provider verification stays reported truthfully (status), but a clean result also requires a durable journal,
  // including the terminal run-end record.
  // Delayed reopening (R8 OBSERVED_STABLE) counts as reopened, but only on top of a VERIFIED command reply and final state.
  report.allPostChecksPassed = verified && !!report.sideEffectsAfter?.ok && ["CALENDAR_REOPENED", "CALENDAR_REOPENED_DELAYED"].includes(report.calendarFinal) &&
    report.journalDurable && report.runEndRecorded;
  report.requests = gate.requestCount() + direct;
  return report;
}

// ---------------------------------------------------------------------------------------------
// CLI

const refuse = (exitCode, stage, error) => ({ exitCode, output: Object.freeze({ ok: false, mode: "cancel-only-recovery", stage, error, network: "none" }) });

/** deps (tests): { git, prompt, fetchImpl, sleep, now, readJournal, exists, createJournal } */
export async function runRecoveryCli(argv, deps = {}) {
  const a = Array.isArray(argv) ? argv : [];
  if (a.length !== 6) return refuse(RECOVERY_EXIT.USAGE, "arguments", "USAGE");
  const opts = {};
  for (let i = 0; i < 6; i += 2) {
    if (!["--journal-dir", "--confirm", "--reviewed-commit"].includes(a[i]) || Object.prototype.hasOwnProperty.call(opts, a[i]) || typeof a[i + 1] !== "string") return refuse(RECOVERY_EXIT.USAGE, "arguments", "USAGE");
    opts[a[i]] = a[i + 1];
  }
  const reviewedCommit = opts["--reviewed-commit"], dir = opts["--journal-dir"];
  if (!/^[0-9a-f]{40}$/.test(reviewedCommit)) return refuse(RECOVERY_EXIT.USAGE, "arguments", "REVIEWED_COMMIT_INVALID");
  if (opts["--confirm"] !== CONFIRM_TOKEN) return refuse(RECOVERY_EXIT.REFUSED, "arguments", "CONFIRM_TOKEN_MISMATCH");
  if (!dir || dir.startsWith("--")) return refuse(RECOVERY_EXIT.USAGE, "arguments", "USAGE");
  const prov = verifyProvenance({ reviewedCommit, git: deps.git ?? makeGit(ROOT), sources: RECOVERY_SOURCES });
  if (!prov.ok) return refuse(RECOVERY_EXIT.REFUSED, "provenance", prov.code);
  const jdir = resolve(dir);
  let entries;
  try { entries = (deps.readJournal ?? readJournalFile)(join(jdir, journalFileName(TARGET.attempt2Hash))); }
  catch (e) { return refuse(RECOVERY_EXIT.REFUSED, "preflight", e && e.code === "JOURNAL_CORRUPT" ? "ATTEMPT2_JOURNAL_CORRUPT" : "ATTEMPT2_JOURNAL_UNREADABLE"); }
  const chk = checkAttempt2Journal(entries);
  if (!chk.ok) return refuse(RECOVERY_EXIT.REFUSED, "preflight", chk.code);
  const recoveryFile = journalFileName(RECOVERY_HASH);
  const exists = deps.exists ?? ((p) => { try { statSync(p); return true; } catch (e) { return e && e.code === "ENOENT" ? false : null; } });
  const ex = exists(join(jdir, recoveryFile));
  if (ex !== false) return refuse(RECOVERY_EXIT.REFUSED, "preflight", ex === true ? "RECOVERY_ALREADY_RUN" : "RECOVERY_JOURNAL_STATE_UNKNOWN");

  let creds;
  try { creds = await (deps.prompt ?? promptHostawayCredentials)(); } catch (e) {
    return refuse(RECOVERY_EXIT.REFUSED, "credentials", typeof e?.code === "string" && /^[A-Z_]{1,40}$/.test(e.code) ? e.code : "CREDENTIALS_UNAVAILABLE");
  }
  const getCredentials = async () => { const c = creds; creds = null; return c; };
  let journal = null;
  try {
    journal = (deps.createJournal ?? createFileJournal)(jdir, RECOVERY_HASH);
    const guard = guardFetch(deps.fetchImpl ?? globalThis.fetch);
    const transport = createHostawayTransport({ fetchImpl: guard.guarded, getCredentials, ...(deps.sleep ? { sleep: deps.sleep } : {}) });
    const r = await runRecovery({ transport, journal, now: deps.now ?? (() => new Date()), ...(deps.timeoutMs ? { timeoutMs: deps.timeoutMs } : {}),
      ...(deps.startTimer ? { startTimer: deps.startTimer } : {}), ...(deps.clock ? { clock: deps.clock } : {}), ...(deps.settle ? { settle: deps.settle } : {}) });
    const ok = r.status === "CANCELLED_VERIFIED" && r.allPostChecksPassed === true && r.journalDurable === true && r.runEndRecorded === true;
    const output = Object.freeze({ ok, mode: "cancel-only-recovery", reviewedCommit,
      journalDurable: r.journalDurable === true, runEndRecorded: r.runEndRecorded === true, journalFailures: r.journalFailures ?? [],
      status: r.status, allPostChecksPassed: !!r.allPostChecksPassed, target: { reservationId: TARGET.reservationId, ref: TARGET.ref },
      halt: r.halt, cancel: r.cancel, steps: r.steps, sideEffectsBefore: r.sideEffectsBefore, sideEffectsAfter: r.sideEffectsAfter,
      postcancelStatus: r.postcancelStatus, postcancelIdentityOk: r.postcancelIdentityOk, calendar: r.calendar,
      commandReply: r.cancel, finalState: r.finalState, calendarImmediate: r.calendarImmediate, calendarSettled: r.calendarSettled, calendarFinal: r.calendarFinal,
      requests: r.requests, guard: guard.used(), recoveryJournalFile: recoveryFile });
    return { exitCode: output.ok ? RECOVERY_EXIT.OK : r.status === "REFUSED" ? RECOVERY_EXIT.REFUSED : RECOVERY_EXIT.HALTED, output };
  } catch (e) {
    return { exitCode: RECOVERY_EXIT.INTERNAL, output: Object.freeze({ ok: false, mode: "cancel-only-recovery", stage: "run",
      error: typeof e?.code === "string" && /^[A-Z_]{1,40}$/.test(e.code) ? e.code : "INTERNAL_ERROR" }) };
  } finally {
    creds = null;
    if (journal && typeof journal.close === "function") { try { journal.close(); } catch { /* closed */ } }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = await runRecoveryCli(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(r.output, null, 2)}\n`);
  process.exitCode = r.exitCode;
}
