// E4 CONNECTED-LISTING test sequence — OFFLINE-ONLY first slice (feature/e4-connected-runner, 2026-11-01).
//
// One bounded create -> observe -> cancel -> observe of a single SANDBOX test reservation on the Airbnb-connected pilot
// listing 603566 (Hostaway, MXN, direct channel 2000; Airbnb listing 1798070853315176756). Purpose: evidence that a
// Hostaway-side block reaches Airbnb and that the cancel reopens it there. Owner direction: USD is settled for future
// listings; the existing MXN pilot is accepted for the sandbox test; nothing is converted and no provider currency,
// mapping or connection is changed. 603564 is never addressable (adapter + allowlist).
//
// This module has NO transport, credentials, environment, file or CLI access and is not wired to anything:
// CONNECTED_EXECUTION_WIRED = false. Every provider request goes through an INJECTED transport behind the reviewed
// runner gate (budgets, write-ahead journal, single attempt, timeout) with this module's own allowlist
// (assertConnectedRequest). Independent Airbnb evidence comes from an INJECTED operator checkpoint, never from the
// Hostaway API.
//
// Sequence (a SAFETY halt stops every later write — cleanup included — and runs read-only reconciliation; there are no
// retries and no re-auth anywhere):
//   K0 priceDetails total == manifest totalMinor (MXN)      K1 no reservation at all on the arrival date (non-authoritative)
//   K2 Hostaway calendar: every stay night open             A0 operator: Airbnb shows the nights OPEN (else no write)
//   KW1 create -> verified full identity, status new        K3 side effects: charges zero, exactly ONE conversation, no task
//   K4 read by id (full identity, new)                      K5 ref lookup finds the same id with full identity
//   K6 Hostaway calendar blocked (bounded observation)      A1 operator: Airbnb shows the nights BLOCKED   (evidence only)
//   K7 FRESH read by id; only then is the id cancellable    KW2 cancel -> reply must carry the full identity, cancelled
//   K8 read by id (full identity, cancelled)                K9 side effects after cancel equal K3's      (reported)
//   K10 Hostaway calendar reopened (bounded observation)    A2 operator: Airbnb shows the nights OPEN again (evidence only)
// Evidence outcomes (K6, A1, K9, K10, A2) never cause a write and never block the single cleanup cancel; they decide
// whether the test PASSES. A mismatching cancel reply HALTS (strict, field NAMES recorded) even if later reads agree.

import { randomBytes, createHash } from "node:crypto";
import {
  connectedTestAdapterConfig, CONNECTED_TEST_LISTING_ID, CONNECTED_TEST_CURRENCY, CONNECTED_TEST_REF_FIELD_ID,
  buildCreateReservationRequest, classifyCreateResponse, lookupByRef, isRealDate, DIRECT_CHANNEL_ID, LOOKUP_MAX_PAGES, AdapterError
} from "../../lib/hostaway-reservations.js";
import {
  PLACEHOLDER, MIN_LEAD_DAYS, MAX_WINDOW_NIGHTS, MAX_STAY_NIGHTS, DEFAULT_TIMEOUT_MS, CANCEL_BODY, READ_QUERY, RunnerError,
  nightsBetween, generateRunRefs, sanitizeJournalEntry, createGate, parsePriceTotal, parseReservationResponse, identityMismatches
} from "../e4-write-runner/runner.mjs";
import { evaluateSideEffectResponse, sideEffectRequest, SIDE_EFFECT_SOURCES } from "../e4-write-runner/side-effects.mjs";
import { traverseList, LIST_LIMIT, LIST_MAX_PAGES } from "../e4-recovery/cancel-only.mjs";
import { observeSync, nightsState, evaluateCreateSideEffects } from "./safeguards.mjs";

export const CONNECTED_VERSION = "e4-connected-v1";
export const CONNECTED_MANIFEST_VERSION = "e4-connected-manifest-v1";
export const CONNECTED_AIRBNB_LISTING_ID = "1798070853315176756";   // channel link of 603566 (root/Claude read-only evidence)
export const CONNECTED_EXECUTION_WIRED = false;                      // no CLI, transport or credential path exists
// Complete static import closure of this module (asserted by test). A future CLI must verify the provenance of all of these.
// traverseList is reused from the reviewed cancel-only module, which brings its (import-inert) launcher closure along.
export const CONNECTED_SOURCES = Object.freeze([
  "lib/hostaway-reservations.js", "scripts/e4-connected/connected-path.mjs", "scripts/e4-connected/safeguards.mjs",
  "scripts/e4-launcher/happy-execute.mjs", "scripts/e4-recovery/cancel-only.mjs", "scripts/e4-transport/credential-prompt.mjs",
  "scripts/e4-transport/hostaway-transport.mjs", "scripts/e4-write-runner/happy-path.mjs", "scripts/e4-write-runner/happy-preflight.mjs",
  "scripts/e4-write-runner/journal.mjs", "scripts/e4-write-runner/runner.mjs", "scripts/e4-write-runner/side-effects.mjs"
]);
export const CONNECTED_MAX_GUESTS = 2;                               // 603566 capacity (dashboard read-only evidence)
export const CONNECTED_WRITE_BUDGET = Object.freeze({ create: 1, cancel: 1 });
// Reservations this runner must never read, cancel or adopt, whatever a provider reply claims (the 2026-10-23 E4 test
// reservation on 606998, cancelled 2026-10-24 by the reviewed recovery tool).
export const CONNECTED_PROTECTED_RESERVATION_IDS = Object.freeze([70636076]);
const isProtected = (v) => CONNECTED_PROTECTED_RESERVATION_IDS.includes(Number(v));
// Hostaway-side calendar observation after the create and after the cancel: read at once, then every 10 s; 2 consecutive
// confirming reads; at most 12 reads and 120 s each. A timeout or cap concludes nothing (and writes nothing).
export const CONNECTED_SYNC = Object.freeze({ intervalMs: 10000, timeoutMs: 120000, maxReads: 12, confirmReads: 2 });
const SIDE_READS = 1 + 2 * LIST_MAX_PAGES;
export const CONNECTED_STEPS = Object.freeze({
  K0_PRICE: Object.freeze({ reads: 1, writes: 0 }),
  K1_CLEAR: Object.freeze({ reads: LOOKUP_MAX_PAGES, writes: 0 }),
  K2_CALENDAR_BEFORE: Object.freeze({ reads: 1, writes: 0 }),
  A0_AIRBNB_BEFORE: Object.freeze({ reads: 0, writes: 0 }),
  KW1_CREATE: Object.freeze({ reads: 0, writes: 1, kind: "create", executable: true }),
  K3_SIDE_EFFECTS_CREATE: Object.freeze({ reads: SIDE_READS, writes: 0 }),
  K4_READBACK: Object.freeze({ reads: 1, writes: 0 }),
  K5_LOOKUP_REF: Object.freeze({ reads: LOOKUP_MAX_PAGES, writes: 0 }),
  K6_CALENDAR_BLOCKED: Object.freeze({ reads: CONNECTED_SYNC.maxReads, writes: 0 }),
  A1_AIRBNB_AFTER_CREATE: Object.freeze({ reads: 0, writes: 0 }),
  K7_PRECANCEL: Object.freeze({ reads: 1, writes: 0 }),
  KW2_CANCEL: Object.freeze({ reads: 0, writes: 1, kind: "cancel", executable: true }),
  K8_POSTCANCEL: Object.freeze({ reads: 1, writes: 0 }),
  K9_SIDE_EFFECTS_CANCEL: Object.freeze({ reads: SIDE_READS, writes: 0 }),
  K10_CALENDAR_REOPENED: Object.freeze({ reads: CONNECTED_SYNC.maxReads, writes: 0 }),
  A2_AIRBNB_AFTER_CANCEL: Object.freeze({ reads: 0, writes: 0 }),
  KR_RECONCILE: Object.freeze({ reads: 1 + LOOKUP_MAX_PAGES, writes: 0 })
});
export const CONNECTED_LIVE_UNVERIFIED = Object.freeze([
  "custom field 105433 (booking ref) is stored and returned for reservations on 603566 (verified only on 606998)",
  "priceDetails v2 result.totalPrice for 603566 in MXN equals the create totalPrice Hostaway accepts",
  "cancel reply carries the full identity (the 2026-10-24 cancel on 606998 replied CANCEL_RESPONSE_MISMATCH; field unknown)",
  "Hostaway calendar status/isAvailable for a direct reservation on 603566; Airbnb sync latency and how Airbnb shows the block",
  "notifications/messages Airbnb or Hostaway may send for a direct reservation on a connected listing"
]);

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isPosInt = (v) => Number.isSafeInteger(v) && v > 0;
function deepFreeze(o) {
  if (o && typeof o === "object" && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); }
  return o;
}
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
function hasKeyCI(v, key) {
  if (Array.isArray(v)) return v.some((x) => hasKeyCI(x, key));
  if (v !== null && typeof v === "object") return Object.keys(v).some((k) => k.toLowerCase() === key || hasKeyCI(v[k], key));
  return false;
}
function placeholderPaths(v, path, out) {
  if (v === PLACEHOLDER) out.push(path);
  else if (isObj(v)) for (const k of Object.keys(v)) placeholderPaths(v[k], path ? `${path}.${k}` : k, out);
  return out;
}
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
/** The stay's nights (arrival-inclusive, departure-exclusive). */
export const stayNights = (s) => Array.from({ length: nightsBetween(s.arrivalDate, s.departureDate) }, (_, i) => addDays(s.arrivalDate, i));

// ---------------------------------------------------------------------------------------------
// Manifest: listing, Airbnb mapping, channel, ref field and currency are FIXED; everything else is an owner input
// and has NO default (the template carries placeholders only; candidate dates from earlier sessions are not used).

const KEYS = ["manifestVersion", "listingId", "airbnbListingId", "channelId", "refFieldId", "currency", "guests", "totalMinor", "window", "stay",
  "guest", "reviewedCommit"];
const FIXED = Object.freeze({ manifestVersion: CONNECTED_MANIFEST_VERSION, listingId: CONNECTED_TEST_LISTING_ID, airbnbListingId: CONNECTED_AIRBNB_LISTING_ID,
  channelId: DIRECT_CHANNEL_ID, refFieldId: CONNECTED_TEST_REF_FIELD_ID, currency: CONNECTED_TEST_CURRENCY });
const MAX_TOTAL_MINOR = 99999999;

/** A fresh template: fixed fields filled, every owner input a placeholder. */
export function connectedManifestTemplate() {
  return { ...FIXED, guests: PLACEHOLDER, totalMinor: PLACEHOLDER, window: { start: PLACEHOLDER, end: PLACEHOLDER },
    stay: { arrivalDate: PLACEHOLDER, departureDate: PLACEHOLDER }, guest: { firstName: PLACEHOLDER, lastName: PLACEHOLDER, email: PLACEHOLDER },
    reviewedCommit: PLACEHOLDER };
}

const planOf = (m, ref) => ({ ref, listingId: CONNECTED_TEST_LISTING_ID, arrivalDate: m.stay.arrivalDate, departureDate: m.stay.departureDate,
  guests: m.guests, guest: m.guest, totalMinor: m.totalMinor, currency: CONNECTED_TEST_CURRENCY });

export function validateConnectedManifest(input, { now } = {}) {
  const fail = (errors, blockers = []) => ({ ok: false, errors, blockers });
  if (typeof now !== "function") return fail(["CLOCK_REQUIRED"]);
  if (!isObj(input)) return fail(["MANIFEST_NOT_OBJECT"]);
  const errors = [];
  for (const k of Object.keys(input)) if (!KEYS.includes(k)) errors.push(`UNKNOWN_FIELD:${k}`);
  for (const k of KEYS) if (!Object.prototype.hasOwnProperty.call(input, k)) errors.push(`MISSING_FIELD:${k}`);
  if (hasKeyCI(input, "forceoverbooking")) errors.push("FORCE_OVERBOOKING_REFUSED");
  if (errors.length) return fail(errors);
  for (const [k, v] of Object.entries(FIXED)) if (input[k] !== v) errors.push(`FIXED_VALUE_MISMATCH:${k}`);
  if (errors.length) return fail(errors);                       // a wrong listing/currency never reaches the owner-input stage
  const blockers = placeholderPaths(input, "", []).map((p) => `OWNER_INPUT_REQUIRED:${p}`);
  if (blockers.length) return fail([], blockers);
  const m = JSON.parse(JSON.stringify(input));
  if (!(Number.isSafeInteger(m.guests) && m.guests >= 1 && m.guests <= CONNECTED_MAX_GUESTS)) errors.push("GUESTS_INVALID");
  if (!(Number.isSafeInteger(m.totalMinor) && m.totalMinor > 0 && m.totalMinor <= MAX_TOTAL_MINOR)) errors.push("TOTAL_MINOR_INVALID");
  if (typeof m.reviewedCommit !== "string" || !/^[0-9a-f]{40}$/.test(m.reviewedCommit)) errors.push("REVIEWED_COMMIT_INVALID");
  const range = (a, b, name, max) => {
    if (!isRealDate(a) || !isRealDate(b)) { errors.push(`DATES_INVALID:${name}`); return false; }
    if (!(b > a)) { errors.push(`DEPARTURE_NOT_AFTER_ARRIVAL:${name}`); return false; }
    if (nightsBetween(a, b) > max) { errors.push(`RANGE_TOO_LONG:${name}`); return false; }
    return true;
  };
  const w = m.window, s = m.stay;
  const wOk = isObj(w) && Object.keys(w).length === 2 ? range(w.start, w.end, "window", MAX_WINDOW_NIGHTS) : (errors.push("DATES_INVALID:window"), false);
  const sOk = isObj(s) && Object.keys(s).length === 2 ? range(s.arrivalDate, s.departureDate, "stay", MAX_STAY_NIGHTS) : (errors.push("DATES_INVALID:stay"), false);
  if (wOk && w.start < addDays(now().toISOString().slice(0, 10), MIN_LEAD_DAYS)) errors.push("WINDOW_NOT_FAR_FUTURE");
  if (wOk && sOk && (s.arrivalDate < w.start || s.departureDate > w.end)) errors.push("OUTSIDE_WINDOW:stay");
  if (sOk && !errors.length) {
    try { buildCreateReservationRequest(planOf(m, "MV-VALIDATE0"), connectedTestAdapterConfig()); }
    catch (e) { errors.push(e instanceof AdapterError ? `GUEST_OR_PLAN_INVALID:${e.code}` : "GUEST_OR_PLAN_INVALID"); }
  }
  if (errors.length) return fail(errors);
  const hash = createHash("sha256").update(canonical(m)).digest("hex");
  return { ok: true, manifest: deepFreeze(m), hash, confirmToken: `E4-CONNECTED-${hash.slice(0, 12)}` };
}

// ---------------------------------------------------------------------------------------------
// Allowlist (passed to the reviewed gate). Listing 603566 only; reads/cancel only of an id THIS run verified.

const LOOKUP_QUERY_KEYS = Object.freeze(["listingId", "channelId", "arrivalStartDate", "arrivalEndDate", "limit", "includeResources", "afterId"]);
const SIDE_PATHS = Object.freeze({ "/guestPayments/charges": "charges", "/conversations": "conversations", "/tasks": "tasks" });

/**
 * Throws RunnerError unless `req` is one of the connected test's allowed shapes, each bound EXACTLY to this run's private
 * state: state.bound = { priceBody, createBody, arrivalDate } (from the validated manifest and the generated ref) and
 * state.calendar = { startDate, endDate }. Reads/cancel only of an id this run verified; protected ids never.
 */
export function assertConnectedRequest(req, state, writeKind) {
  if (!isObj(req) || typeof req.method !== "string" || typeof req.path !== "string") throw new RunnerError("REQUEST_MALFORMED");
  if (hasKeyCI(req, "forceoverbooking")) throw new RunnerError("FORCE_OVERBOOKING_REFUSED");
  const q = req.query === undefined ? {} : req.query;
  if (!isObj(q)) throw new RunnerError("REQUEST_MALFORMED");
  const L = CONNECTED_TEST_LISTING_ID;
  const emptyQuery = Object.keys(q).length === 0;
  const b = state.bound;
  if (!isObj(b) || !isObj(b.priceBody) || !isObj(b.createBody) || typeof b.arrivalDate !== "string") throw new RunnerError("REQUEST_NOT_BOUND_TO_RUN");
  for (const m0 of req.path.matchAll(/\d+/g)) if (isProtected(m0[0])) throw new RunnerError("PROTECTED_RESERVATION");
  if (Object.prototype.hasOwnProperty.call(q, "reservationId") && isProtected(q.reservationId)) throw new RunnerError("PROTECTED_RESERVATION");
  const readable = (v) => (Number.isSafeInteger(v) || (typeof v === "string" && /^[1-9]\d{0,15}$/.test(v))) && !isProtected(v) && state.readableIds.has(Number(v));
  const lookupBase = { listingId: L, channelId: DIRECT_CHANNEL_ID, arrivalStartDate: b.arrivalDate, arrivalEndDate: b.arrivalDate, limit: 100, includeResources: 1 };
  let kind; let m;
  if (req.method === "POST" && req.path === `/listings/${L}/calendar/priceDetails` && emptyQuery && isObj(req.body) &&
    canonical(req.body) === canonical(b.priceBody)) kind = "calc";
  else if (req.method === "POST" && req.path === "/reservations" && emptyQuery && isObj(req.body) &&
    canonical(req.body) === canonical(b.createBody)) kind = "create";
  else if (req.method === "GET" && req.path === "/reservations" && req.body === undefined && Object.keys(q).every((k) => LOOKUP_QUERY_KEYS.includes(k)) &&
    canonical(Object.fromEntries(Object.entries(q).filter(([k]) => k !== "afterId"))) === canonical(lookupBase) &&
    (!Object.prototype.hasOwnProperty.call(q, "afterId") || isPosInt(q.afterId))) kind = "lookup";
  else if (req.method === "GET" && (m = /^\/reservations\/([1-9]\d{0,15})$/.exec(req.path)) && req.body === undefined &&
    canonical(q) === canonical(READ_QUERY)) {
    if (!readable(m[1])) throw new RunnerError("READ_TARGET_NOT_FROM_THIS_RUN");
    kind = "read";
  } else if (req.method === "PUT" && (m = /^\/reservations\/([1-9]\d{0,15})\/statuses\/cancelled$/.exec(req.path)) && emptyQuery &&
    canonical(req.body) === canonical(CANCEL_BODY)) {
    if (state.cancellableId === null || Number(m[1]) !== state.cancellableId || !readable(m[1])) throw new RunnerError("CANCEL_TARGET_NOT_VERIFIED");
    kind = "cancel";
  } else if (req.method === "GET" && req.path === `/listings/${L}/calendar` && req.body === undefined && isObj(state.calendar) &&
    canonical(q) === canonical(state.calendar)) kind = "read";
  else if (req.method === "GET" && Object.prototype.hasOwnProperty.call(SIDE_PATHS, req.path) && req.body === undefined &&
    Object.keys(q).length === 3 && readable(q.reservationId) && q.limit === (req.path === "/guestPayments/charges" ? 100 : LIST_LIMIT) &&
    Number.isSafeInteger(q.offset) && q.offset >= 0 && q.offset <= 9999 && (req.path !== "/guestPayments/charges" || q.offset === 0)) kind = "read";
  else throw new RunnerError("REQUEST_NOT_ALLOWLISTED");
  const isWrite = kind === "create" || kind === "cancel";
  if ((isWrite ? kind : null) !== (writeKind ?? null)) throw new RunnerError("WRITE_KIND_MISMATCH");
  return kind;
}

// ---------------------------------------------------------------------------------------------
// Plan / dry-run: zero network.

export function planConnectedRun(manifestInput, { now } = {}) {
  const v = validateConnectedManifest(manifestInput, { now });
  if (!v.ok) return deepFreeze({ mode: "dry-run", network: "none", ok: false, errors: v.errors, blockers: v.blockers });
  const s = v.manifest.stay;
  return deepFreeze({
    mode: "dry-run", network: "none", ok: true, version: CONNECTED_VERSION, manifestHash: v.hash, confirmToken: v.confirmToken,
    executionWired: CONNECTED_EXECUTION_WIRED, writeBudget: CONNECTED_WRITE_BUDGET, liveUnverified: CONNECTED_LIVE_UNVERIFIED,
    sync: CONNECTED_SYNC, reviewedCommit: v.manifest.reviewedCommit,
    stay: { listingId: CONNECTED_TEST_LISTING_ID, airbnbListingId: CONNECTED_AIRBNB_LISTING_ID, from: s.arrivalDate, to: s.departureDate,
      nights: stayNights(s), totalMinor: v.manifest.totalMinor, currency: CONNECTED_TEST_CURRENCY, channelId: DIRECT_CHANNEL_ID,
      guests: v.manifest.guests, ref: "<generated at execution>", guest: "<manifest guest; not shown>" },
    steps: Object.keys(CONNECTED_STEPS)
  });
}

// ---------------------------------------------------------------------------------------------
// Execute: injected transport, journal, operator checkpoint and timers only.

export function checkConnectedPrerequisites(opts = {}) {
  const missing = [];
  if (opts.mode !== "execute") missing.push("MODE_NOT_EXECUTE");
  if (typeof opts.now !== "function") missing.push("CLOCK_MISSING");
  const v = validateConnectedManifest(opts.manifest, { now: opts.now });
  if (!v.ok) missing.push("MANIFEST_NOT_APPROVABLE");
  else {
    if (opts.confirm !== v.confirmToken) missing.push("CONFIRM_TOKEN_MISMATCH");
    if (opts.reviewedCommit !== v.manifest.reviewedCommit) missing.push("REVIEWED_COMMIT_NOT_BOUND");
  }
  if (!opts.transport || typeof opts.transport.send !== "function") missing.push("TRANSPORT_MISSING");
  const j = opts.journal;
  if (!j || typeof j.load !== "function" || typeof j.append !== "function") missing.push("JOURNAL_MISSING");
  else {
    if (j.durable !== true) missing.push("JOURNAL_NOT_DURABLE");
    if (v.ok && j.boundHash !== v.hash) missing.push("JOURNAL_NOT_BOUND_TO_MANIFEST");
    let entries = null;
    try { entries = j.load(); } catch { missing.push("JOURNAL_UNREADABLE"); }
    if (entries !== null && (!Array.isArray(entries) || entries.length !== 0)) missing.push("JOURNAL_NOT_EMPTY");
  }
  if (typeof opts.airbnbCheckpoint !== "function") missing.push("AIRBNB_CHECKPOINT_MISSING");
  if (typeof opts.startTimer !== "function" || typeof opts.clock !== "function") missing.push("TIMERS_MISSING");
  if (opts.timeoutMs !== undefined && !(Number.isSafeInteger(opts.timeoutMs) && opts.timeoutMs >= 1 && opts.timeoutMs <= 60000)) missing.push("TIMEOUT_INVALID");
  return v.ok && !missing.length ? { ok: true, manifest: v.manifest, hash: v.hash } : { ok: false, missing, manifestErrors: v.errors ?? [], blockers: v.blockers ?? [] };
}

const AIRBNB_STATES = Object.freeze(["open", "blocked"]);

export async function executeConnectedRun(opts = {}) {
  const pre = checkConnectedPrerequisites(opts);
  if (!pre.ok) return deepFreeze({ status: "REFUSED", requests: 0, prerequisites: pre.missing, manifestErrors: pre.manifestErrors, blockers: pre.blockers });
  const { transport, journal, now, airbnbCheckpoint, startTimer, clock } = opts;
  const sync = opts.sync ?? CONNECTED_SYNC;
  const m = pre.manifest;
  const s = m.stay;
  const nights = stayNights(s);
  const cfg = connectedTestAdapterConfig();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const san = (e) => sanitizeJournalEntry(e, { steps: CONNECTED_STEPS });
  const state = { halted: false, readOnly: false, readableIds: new Set(), cancellableId: null,
    calendar: Object.freeze({ startDate: nights[0], endDate: nights[nights.length - 1] }) };
  const report = { status: "RUNNING", version: CONNECTED_VERSION, manifestHash: pre.hash, steps: [], writes: { create: 0, cancel: 0 }, halt: null,
    commandReply: null, finalState: null, sideEffectsCreate: null, sideEffectsCancel: null,
    evidence: { hostawayBlocked: null, airbnbBlocked: null, hostawayReopened: null, airbnbReopened: null }, reconcile: [],
    journalDurable: true, journalFailures: [], runEndRecorded: false };
  // Every journal append failure LATCHES (never cleared by later successful appends): the run can never again report a
  // clean or durable result, and a failure before the cancel stops every later write.
  const latch = (what) => { report.journalDurable = false; if (report.journalFailures.length < 16) report.journalFailures.push(what ?? "UNKNOWN"); };
  let refs;
  try { refs = generateRunRefs(opts.rng ?? randomBytes, 2); }
  catch { return deepFreeze({ status: "REFUSED", requests: 0, prerequisites: ["REF_GENERATION_FAILED"] }); }
  const [probeRef, ref] = refs;
  const priceBody = { startingDate: s.arrivalDate, endingDate: s.departureDate, numberOfGuests: m.guests, version: 2 };
  const plan = planOf(m, ref);
  let createReq;
  try { createReq = buildCreateReservationRequest(plan, cfg); }
  catch { return deepFreeze({ status: "REFUSED", requests: 0, prerequisites: ["PLAN_INVALID"] }); }
  state.bound = deepFreeze({ priceBody, createBody: createReq.body, arrivalDate: s.arrivalDate });   // private: the only shapes the guard admits
  const runId = createHash("sha256").update(`${pre.hash}:${refs.join(",")}`).digest("hex").slice(0, 16);
  const jappend = (e) => journal.append(san({ ...e, at: now().toISOString() }));
  try { jappend({ type: "run-start", runId, manifestHash: pre.hash, refs }); }
  catch { return deepFreeze({ status: "REFUSED", requests: 0, prerequisites: ["JOURNAL_WRITE_FAILED"], journalDurable: false, journalFailures: ["RUN_START"], runEndRecorded: false }); }

  const rawGate = createGate({ transport, journal, timeoutMs, state, budgets: CONNECTED_STEPS, writeBudget: CONNECTED_WRITE_BUDGET,
    allowRequest: assertConnectedRequest });
  let lastDiag = null;
  const gate = Object.freeze({ requestCount: () => rawGate.requestCount(), send: async (...a) => {
    lastDiag = null;
    const r = await rawGate.send(...a);
    if (r && r.transportError && r.diag) lastDiag = r.diag;
    return r;
  } });
  const attempts = [];
  const record = (step, o) => report.steps.push(san({ step, ...o }));
  const halt = (step, code, extra = {}) => {
    if (state.halted && report.halt) return;
    state.halted = true;
    state.cancellableId = null;
    const withDiag = lastDiag ? { ...extra, diag: lastDiag } : extra;
    report.halt = san({ step, code, ...withDiag });
    try { jappend({ type: "halt", step, code, ...withDiag }); } catch { latch(`HALT:${step}`); }
  };
  const safeAppend = (step, e) => { try { jappend(e); } catch { latch(`${e.type}:${step}`); halt(step, "JOURNAL_WRITE_FAILED"); } };
  const runStep = async (step, fn) => {
    if (state.halted) return;
    try { await fn(); } catch (e) {
      if (e instanceof RunnerError && e.code === "JOURNAL_WRITE_FAILED") latch(`intent:${step}`);   // the gate's write-ahead intent: nothing was sent
      halt(step, e instanceof RunnerError ? e.code : "INTERNAL_ERROR");
    }
  };
  const expectNew = { listingId: CONNECTED_TEST_LISTING_ID, from: s.arrivalDate, to: s.departureDate, totalMinor: m.totalMinor,
    currency: CONNECTED_TEST_CURRENCY, channelId: DIRECT_CHANNEL_ID, bookingRef: ref, status: "new" };
  let id = null;
  const readFull = async (step, status, code) => {
    const resp = await gate.send(step, { method: "GET", path: `/reservations/${id}`, query: READ_QUERY });
    const p = parseReservationResponse(resp, "READ");
    const mm = p.ok ? identityMismatches(p.reservation, { ...expectNew, reservationId: id, status }) : [];
    const rc = !p.ok ? p.code : mm.length ? code : "IDENTITY_OK";
    safeAppend(step, { type: "read", step, kind: "read", code: rc, reservationId: id, ...(p.httpStatus ? { httpStatus: p.httpStatus } : {}),
      ...(p.transport ? { transport: p.transport } : {}), ...(mm.length ? { mismatches: mm } : {}) });
    record(step, { code: rc, ...(mm.length ? { mismatches: mm } : {}) });
    const res = { ok: p.ok && !mm.length, code: rc, status: p.ok ? p.reservation.status : null, ...(mm.length ? { mismatches: mm } : {}) };
    if (!p.ok) halt(step, p.code);
    else if (mm.length) halt(step, code, { mismatches: mm });
    return res;
  };
  const calendarRead = (step) => () => gate.send(step, { method: "GET", path: `/listings/${CONNECTED_TEST_LISTING_ID}/calendar`, query: state.calendar })
    .catch(() => ({ transportError: true }));                  // a gate refusal (e.g. budget) is an unknown read, never a pass
  const sideEffects = async (step) => {
    const chargesSrc = SIDE_EFFECT_SOURCES.find((x) => x.name === "CHARGES");
    let cr;
    try { cr = await gate.send(step, sideEffectRequest(chargesSrc, id)); } catch { cr = { transportError: true }; }
    const charges = evaluateSideEffectResponse(chargesSrc, cr, id);
    const list = (path) => ({ offset }) => gate.send(step, { method: "GET", path, query: { reservationId: id, limit: LIST_LIMIT, offset } });
    const conversations = await traverseList(list("/conversations"), "CONVERSATIONS", id);
    const tasks = await traverseList(list("/tasks"), "TASKS", id);
    const verdict = evaluateCreateSideEffects({ charges: charges.state, conversations, tasks });
    const out = { ok: verdict.ok, code: verdict.code, charges: charges.code, conversations: { code: conversations.code, ...(conversations.ids ? { ids: conversations.ids } : {}) },
      tasks: { code: tasks.code, ...(tasks.ids ? { ids: tasks.ids } : {}) } };
    safeAppend(step, { type: "side-effect-check", step, code: verdict.code });
    return out;
  };
  const observe = async (step, expect) => {
    let o;
    try {
      o = await observeSync({ readCalendar: calendarRead(step), nights, expect, intervalMs: sync.intervalMs, timeoutMs: sync.timeoutMs,
        maxReads: Math.min(sync.maxReads, CONNECTED_STEPS[step].reads), confirmReads: sync.confirmReads, startTimer, now: clock });
    } catch { o = { code: "SYNC_INTERNAL_ERROR", reads: 0, history: [] }; }
    safeAppend(step, { type: "read", step, kind: "read", code: `SYNC_${o.code}`, itemsSeen: Math.min(o.reads, 500) });
    return { code: o.code, reads: o.reads, history: o.history, ...(o.observedAfterMs !== undefined ? { observedAfterMs: o.observedAfterMs } : {}) };
  };
  const checkpoint = async (step, stage, expect) => {
    let v;
    try { v = await airbnbCheckpoint(deepFreeze({ stage, airbnbListingId: CONNECTED_AIRBNB_LISTING_ID, nights: [...nights], expect })); }
    catch { v = undefined; }
    const st = AIRBNB_STATES.includes(v) ? v : "unknown";
    safeAppend(step, { type: "read", step, kind: "read", code: `AIRBNB_ATTESTED_${st.toUpperCase()}` });
    record(step, { code: `AIRBNB_ATTESTED_${st.toUpperCase()}` });
    return st;
  };

  // ---- before any write
  await runStep("K0_PRICE", async () => {
    const resp = await gate.send("K0_PRICE", { method: "POST", path: `/listings/${CONNECTED_TEST_LISTING_ID}/calendar/priceDetails`, query: {},
      body: { startingDate: s.arrivalDate, endingDate: s.departureDate, numberOfGuests: m.guests, version: 2 } });
    const p = parsePriceTotal(resp);
    safeAppend("K0_PRICE", { type: "read", step: "K0_PRICE", kind: "calc", code: p.ok ? "PRICE_OK" : p.code, ...(p.ok ? { observedTotalMinor: p.totalMinor } : {}),
      ...(!resp.transportError && Number.isSafeInteger(resp.httpStatus) ? { httpStatus: resp.httpStatus } : {}) });
    if (!p.ok) return halt("K0_PRICE", p.code);
    if (p.totalMinor !== m.totalMinor) return halt("K0_PRICE", "PREFLIGHT_TOTAL_MISMATCH", { observedTotalMinor: p.totalMinor });
    record("K0_PRICE", { code: "PRICE_MATCHES_MANIFEST", totalMinor: p.totalMinor });
  });
  await runStep("K1_CLEAR", async () => {
    let itemsSeen = 0;
    const lk = await lookupByRef({ ref: probeRef, listingId: CONNECTED_TEST_LISTING_ID, arrivalDate: s.arrivalDate, departureDate: s.departureDate }, cfg,
      async (req) => {
        const resp = await gate.send("K1_CLEAR", req);
        if (!resp.transportError && resp.httpStatus === 200 && isObj(resp.json) && Array.isArray(resp.json.result)) itemsSeen += resp.json.result.length;
        return resp;
      });
    safeAppend("K1_CLEAR", { type: "read", step: "K1_CLEAR", kind: "lookup", code: lk.code, ref: probeRef, itemsSeen });
    if (lk.outcome !== "not_found" || itemsSeen !== 0) return halt("K1_CLEAR", "PREFLIGHT_NOT_CLEAR", { itemsSeen });
    record("K1_CLEAR", { code: "NO_ITEMS_SEEN_NON_AUTHORITATIVE" });
  });
  await runStep("K2_CALENDAR_BEFORE", async () => {
    const st = nightsState(await calendarRead("K2_CALENDAR_BEFORE")(), nights);
    safeAppend("K2_CALENDAR_BEFORE", { type: "read", step: "K2_CALENDAR_BEFORE", kind: "read", code: `CALENDAR_${st.toUpperCase()}` });
    if (st !== "open") return halt("K2_CALENDAR_BEFORE", "CALENDAR_NOT_OPEN_BEFORE");
    record("K2_CALENDAR_BEFORE", { code: "CALENDAR_OPEN" });
  });
  await runStep("A0_AIRBNB_BEFORE", async () => {
    if ((await checkpoint("A0_AIRBNB_BEFORE", "before-create", "open")) !== "open") halt("A0_AIRBNB_BEFORE", "AIRBNB_NOT_ATTESTED_OPEN_BEFORE");
  });

  // ---- the one create
  await runStep("KW1_CREATE", async () => {
    const req = createReq;
    const attempt = { ref, reservationId: null };
    attempts.push(attempt);
    const resp = await gate.send("KW1_CREATE", req, { writeKind: "create", intent: { ref, from: s.arrivalDate, to: s.departureDate, totalMinor: m.totalMinor } });
    report.writes.create++;
    const cls = classifyCreateResponse(resp, plan, cfg);
    const rid = cls.reservation?.reservationId ?? cls.reservationId;
    if (isPosInt(rid) && isProtected(rid)) {                  // never adopted: not readable, not cancellable, not reconciled by id
      safeAppend("KW1_CREATE", { type: "outcome", step: "KW1_CREATE", kind: "create", ref, code: "CREATE_RETURNED_PROTECTED_ID" });
      return halt("KW1_CREATE", "CREATE_RETURNED_PROTECTED_ID");
    }
    if (isPosInt(rid)) { attempt.reservationId = rid; state.readableIds.add(rid); }
    safeAppend("KW1_CREATE", { type: "outcome", step: "KW1_CREATE", kind: "create", ref, code: cls.code, evidence: cls,
      ...(resp.transportError ? { transport: resp.code } : {}) });
    if (cls.outcome !== "created") return halt("KW1_CREATE", `CREATE_NOT_VERIFIED:${cls.code}`);
    const mm = identityMismatches(cls.reservation, expectNew);
    if (mm.length) return halt("KW1_CREATE", "CREATE_IDENTITY_MISMATCH", { mismatches: mm });
    if (state.halted) return;
    id = cls.reservation.reservationId;
    record("KW1_CREATE", { code: "VERIFIED_CREATED", reservationId: id });
  });
  await runStep("K3_SIDE_EFFECTS_CREATE", async () => {
    report.sideEffectsCreate = await sideEffects("K3_SIDE_EFFECTS_CREATE");
    if (!report.sideEffectsCreate.ok) halt("K3_SIDE_EFFECTS_CREATE", report.sideEffectsCreate.code);
  });
  await runStep("K4_READBACK", () => readFull("K4_READBACK", "new", "READBACK_IDENTITY_MISMATCH"));
  await runStep("K5_LOOKUP_REF", async () => {
    const lk = await lookupByRef({ ref, listingId: CONNECTED_TEST_LISTING_ID, arrivalDate: s.arrivalDate, departureDate: s.departureDate }, cfg,
      (req) => gate.send("K5_LOOKUP_REF", req));
    safeAppend("K5_LOOKUP_REF", { type: "read", step: "K5_LOOKUP_REF", kind: "lookup", code: lk.code, ref });
    if (lk.outcome !== "found" || lk.reservation.reservationId !== id || isProtected(id)) return halt("K5_LOOKUP_REF", `LOOKUP_NOT_CONFIRMED:${lk.code}`);
    const mm = identityMismatches(lk.reservation, { ...expectNew, reservationId: id });
    if (mm.length) return halt("K5_LOOKUP_REF", "LOOKUP_IDENTITY_MISMATCH", { mismatches: mm });
  });
  await runStep("K6_CALENDAR_BLOCKED", async () => {
    const o = await observe("K6_CALENDAR_BLOCKED", "blocked");
    report.evidence.hostawayBlocked = o;
  });
  await runStep("A1_AIRBNB_AFTER_CREATE", async () => {
    report.evidence.airbnbBlocked = await checkpoint("A1_AIRBNB_AFTER_CREATE", "after-create", "blocked");
  });

  // ---- the one cancel
  await runStep("K7_PRECANCEL", async () => {
    if (!(await readFull("K7_PRECANCEL", "new", "PRECANCEL_IDENTITY_MISMATCH")).ok) return;
    state.cancellableId = id;                                  // only the id THIS run created and verified, freshly re-read
  });
  await runStep("KW2_CANCEL", async () => {
    const resp = await gate.send("KW2_CANCEL", { method: "PUT", path: `/reservations/${id}/statuses/cancelled`, query: {}, body: CANCEL_BODY },
      { writeKind: "cancel", intent: { reservationId: id, ref } });
    state.cancellableId = null;                                // one cancel attempt, whatever the outcome
    report.writes.cancel++;
    const p = parseReservationResponse(resp, "CANCEL");
    const mm = p.ok ? identityMismatches(p.reservation, { ...expectNew, reservationId: id, status: "cancelled" }) : [];
    const code = !p.ok ? p.code : mm.length ? "CANCEL_RESPONSE_MISMATCH" : "VERIFIED_CANCELLED";
    report.commandReply = { code, ...(p.httpStatus ? { httpStatus: p.httpStatus } : {}), ...(mm.length ? { mismatches: mm } : {}) };
    safeAppend("KW2_CANCEL", { type: "outcome", step: "KW2_CANCEL", kind: "cancel", reservationId: id, code, ...(mm.length ? { mismatches: mm } : {}),
      ...(p.httpStatus ? { httpStatus: p.httpStatus } : {}), ...(p.transport ? { transport: p.transport } : {}) });
    if (code !== "VERIFIED_CANCELLED") halt("KW2_CANCEL", code, mm.length ? { mismatches: mm } : {});
  });
  state.readOnly = true;                                       // no write is possible from here on
  // ---- read-only verification after the cancel attempt (also after an ambiguous reply: reads only)
  if (report.writes.cancel === 1) {
    const step = "K8_POSTCANCEL";
    let r = null;
    try { r = await readFull(step, "cancelled", "POSTCANCEL_IDENTITY_MISMATCH"); } catch (e) { halt(step, e instanceof RunnerError ? e.code : "INTERNAL_ERROR"); }
    report.finalState = r ? { code: r.code, status: r.status, identityOk: r.ok, ...(r.mismatches ? { mismatches: r.mismatches } : {}) }
      : { code: "NOT_READ", status: null, identityOk: false };
    try { report.sideEffectsCancel = await sideEffects("K9_SIDE_EFFECTS_CANCEL"); } catch { report.sideEffectsCancel = { ok: false, code: "SIDE_EFFECTS_INTERNAL_ERROR" }; }
    const created = report.sideEffectsCreate?.conversations?.ids;
    const after = report.sideEffectsCancel?.conversations?.ids;
    if (report.sideEffectsCancel.ok && !(Array.isArray(created) && Array.isArray(after) && canonical(created) === canonical(after))) {
      report.sideEffectsCancel = { ...report.sideEffectsCancel, ok: false, code: "CONVERSATIONS_CHANGED_AFTER_CANCEL" };
    }
    if (report.finalState.identityOk) {
      report.evidence.hostawayReopened = await observe("K10_CALENDAR_REOPENED", "open");
      report.evidence.airbnbReopened = await checkpoint("A2_AIRBNB_AFTER_CANCEL", "after-cancel", "open");
    }
  }

  if (state.halted) {
    state.cancellableId = null;
    report.reconcile = await reconcileReadOnly(gate, attempts, cfg, s, (e) => safeAppend("KR_RECONCILE", e));
  }
  const ev = report.evidence;
  report.syncProven = ev.hostawayBlocked?.code === "OBSERVED_STABLE" && ev.airbnbBlocked === "blocked" &&
    ev.hostawayReopened?.code === "OBSERVED_STABLE" && ev.airbnbReopened === "open";
  const endCode = state.halted || !report.journalDurable ? "HALTED" : "COMPLETED";
  try { jappend({ type: "run-end", code: endCode }); report.runEndRecorded = true; } catch { latch("RUN_END"); }
  // COMPLETED only with no halt AND a durable journal including the terminal record; otherwise never a clean completion.
  report.status = state.halted ? "HALTED" : report.journalDurable && report.runEndRecorded ? "COMPLETED" : "COMPLETED_JOURNAL_NOT_DURABLE";
  report.passed = report.status === "COMPLETED" && report.commandReply?.code === "VERIFIED_CANCELLED" && report.finalState?.identityOk === true &&
    report.sideEffectsCancel?.ok === true && report.syncProven === true;
  report.requests = gate.requestCount();
  return deepFreeze(report);
}

/** Read-only: read by id (if one is known) and a ref lookup on 603566 for every create attempt. Never writes. */
async function reconcileReadOnly(gate, attempts, cfg, stay, append) {
  const out = [];
  for (const a of attempts) {
    const item = { ref: a.ref };
    if (a.reservationId) {
      item.reservationId = a.reservationId;
      try {
        const p = parseReservationResponse(await gate.send("KR_RECONCILE", { method: "GET", path: `/reservations/${a.reservationId}`, query: READ_QUERY }), "READ");
        item.readCode = p.ok ? "READ_OK" : p.code;
        if (p.ok) item.reservationStatus = p.reservation.status;
      } catch (e) { item.readCode = e instanceof RunnerError ? e.code : "INTERNAL_ERROR"; }
    }
    try {
      const r = await lookupByRef({ ref: a.ref, listingId: CONNECTED_TEST_LISTING_ID, arrivalDate: stay.arrivalDate, departureDate: stay.departureDate },
        cfg, (req) => gate.send("KR_RECONCILE", req));
      item.lookupCode = r.code;
      if (r.reservation) item.foundReservationId = r.reservation.reservationId;
    } catch (e) { item.lookupCode = e instanceof RunnerError ? e.code : "INTERNAL_ERROR"; }
    append({ type: "reconcile", step: "KR_RECONCILE", ref: a.ref, code: item.lookupCode, ...(item.reservationId ? { reservationId: item.reservationId } : {}) });
    out.push(deepFreeze(item));
  }
  return out;
}
