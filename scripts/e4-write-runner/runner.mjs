// E4 bounded write runner — OFFLINE-ONLY scaffold (feature/e4-offline-runner).
//
// WHAT THIS IS: the reviewed state machine for the E4 protocol writes (offline protocol §4, 2026-10-22) on test
// listing 606998 only. Protocol maximum: 3 reservation creates (W1 expected success, W2/W3 expected refusals) and
// 2 cancellation status writes (W4/W5) of the reservation verified as created by W1 of this run. EXECUTABLE now:
// W1 and W2 only (see "Refusals" below) — at most 2 creates and 0 cancellations per run.
//
// WHAT THIS IS NOT: it holds no credentials, reads no environment, imports no HTTP client and contains no
// transport. Every provider request goes through an INJECTED `transport.send(request)`; nothing here can reach
// Hostaway on its own. The CLI (cli.mjs) only plans / dry-runs; it has no execute path (EXECUTION_WIRED = false).
// Lives under scripts/, which .vercelignore keeps out of every deployment.
//
// Safety rules implemented here (each has a focused test in test/e4-write-runner.test.mjs):
//  - Manifest: listing 606998, field 105433, USD, USD 100/night, USD 50 cleaning, 2 guests are FIXED; the window W,
//    block R1, stay R2, overlap range and synthetic guest are owner inputs; placeholders => not approvable.
//  - Plan / dry-run: zero network (no transport parameter exists).
//  - Execute: fail-closed unless ALL prerequisites are supplied (mode, clock, approvable manifest, confirm token
//    bound to the manifest hash, transport, durable fresh journal bound to the manifest, side-effect probe).
//  - Gate: every request is checked against a fixed allowlist of shapes; per-step read/write budgets; run write
//    budget counted from the DURABLE journal (create 3, cancel 2); no DELETE, no payment paths, no
//    forceOverbooking at any depth; cancel only of the id verified as created by this run; one attempt per request,
//    no retries of any kind (the injected transport must not retry or re-authenticate either).
//  - Write-ahead journal: the intent entry is durably appended BEFORE a write is sent; if that fails nothing is sent.
//  - Any ambiguous outcome (timeout, transport error, 401/403, 429, 5xx, malformed or unexpected response),
//    identity/amount/currency mismatch, side-effect signal or unknown side-effect state HALTS every later write,
//    cleanup cancellations included. After a halt only read-only reconciliation runs.
//  - Refusals: with the reviewed EMPTY definite-refusal catalogue, every undocumented 4xx on a create (the adapter's
//    UNCATALOGUED_REFUSAL_CANDIDATE, conflicts included) is AMBIGUOUS and latches a halt at once. A lookup that
//    returns not_found is never authoritative and never unlocks a later write; it runs only as read-only
//    reconciliation. CONSEQUENCE (accepted limitation): the full protocol (3 creates + 2 cancels) cannot complete in
//    one automatic run. Every execution halts at W2 at the latest; W3, W4 and W5 are non-executable steps
//    (STEP_BUDGETS.executable = false) until a reviewed refusal catalogue exists. W1 is left for owner/reviewer-
//    directed cleanup; its id is kept for read-only reconciliation only.
//  - Journal / report entries hold only validated values: codes, ids, our refs, dates, minor units, HTTP statuses.
//    Never guest data, provider strings, tokens or request bodies.

import { createHash, randomBytes } from "node:crypto";
import {
  validateAdapterConfig, buildCreateReservationRequest, classifyCreateResponse, normalizeReservation, unwrapEnvelope,
  lookupByRef, sanitizeForEvidence, amountToMinor, isRealDate, REF_RE, DIRECT_CHANNEL_ID, FORBIDDEN_PILOT_LISTING_IDS,
  LOOKUP_MAX_PAGES, AdapterError
} from "../../lib/hostaway-reservations.js";

export const RUNNER_VERSION = "e4-write-runner-v1";
export const MANIFEST_VERSION = "e4-write-manifest-v1";
export const E4_TEST_LISTING_ID = 606998;
export const E4_REF_FIELD_ID = 105433;          // API-confirmed by the owner-run e4-route-v1 check (2026-10-22)
export const E4_CURRENCY = "USD";               // owner policy: all prices USD
export const E4_NIGHTLY_MINOR = 10000;          // USD 100
export const E4_CLEANING_FEE_MINOR = 5000;      // USD 50, owner-confirmed intentional
export const E4_GUESTS = 2;
export const PLACEHOLDER = "<OWNER_INPUT>";
export const WRITE_BUDGET = Object.freeze({ create: 3, cancel: 2 });
export const MIN_LEAD_DAYS = 90;
export const MAX_WINDOW_NIGHTS = 31;
export const MAX_STAY_NIGHTS = 7;
export const DEFAULT_TIMEOUT_MS = 15000;
export const EXECUTION_WIRED = false;           // no real transport exists on this branch
export const CANCEL_BODY = Object.freeze({ cancelledBy: "host" });
export const READ_QUERY = Object.freeze({ includeResources: 1 });

export const ADAPTER_CFG = Object.freeze({
  allowedListingIds: Object.freeze([E4_TEST_LISTING_ID]), refFieldId: E4_REF_FIELD_ID, channelId: DIRECT_CHANNEL_ID, currency: E4_CURRENCY
});

/** Per-step budgets. Writes sum to WRITE_BUDGET; reads are hard caps per step. */
export const STEP_BUDGETS = Object.freeze({
  S0_PREFLIGHT_PRICE: Object.freeze({ reads: 1, writes: 0 }),
  S1_PREFLIGHT_R2_CLEAR: Object.freeze({ reads: LOOKUP_MAX_PAGES, writes: 0 }),
  W1_CREATE_R2: Object.freeze({ reads: 0, writes: 1, kind: "create", executable: true }),
  S2_READBACK_W1: Object.freeze({ reads: 1, writes: 0 }),
  S3_LOOKUP_W1_REF: Object.freeze({ reads: LOOKUP_MAX_PAGES, writes: 0 }),
  W2_CREATE_X1B_OVERLAP: Object.freeze({ reads: 0, writes: 1, kind: "create", executable: true }),
  // Protocol steps that are NOT executable while the definite-refusal catalogue is empty (W2 always halts first):
  W3_CREATE_X1A_BLOCKED: Object.freeze({ reads: 0, writes: 1, kind: "create", executable: false }),
  W4_CANCEL_W1: Object.freeze({ reads: 0, writes: 1, kind: "cancel", executable: false }),
  W5_CANCEL_REPEAT: Object.freeze({ reads: 0, writes: 1, kind: "cancel", executable: false }),
  R_RECONCILE: Object.freeze({ reads: 3 * (1 + LOOKUP_MAX_PAGES), writes: 0 })
});
export const BLOCKED_BY_EMPTY_REFUSAL_CATALOGUE = Object.freeze(["W3_CREATE_X1A_BLOCKED", "W4_CANCEL_W1", "W5_CANCEL_REPEAT"]);

/** Provider behaviour this runner relies on that is NOT confirmed by docs read or live evidence. Live-run blockers. */
export const LIVE_UNVERIFIED = Object.freeze([
  "PUT /v1/reservations/{id}/statuses/cancelled with body {cancelledBy:'host'}: from protocol/E0 notes, not re-read from the official reference",
  "GET /v1/reservations/{id}?includeResources=1 returns customFieldValues (needed for ref identity)",
  "create success envelope shape and status 'new' after a direct (2000) create",
  "create refusal HTTP status/body shapes (refusal catalogue stays empty; any refusal is provisional)",
  "repeat-cancel response shape",
  "priceDetails result.totalPrice (seen only in the sanitized owner-run e4-route-v1 output)"
]);

export class RunnerError extends Error {
  constructor(code, detail) { super(detail ? `${code}: ${detail}` : code); this.name = "RunnerError"; this.code = code; }
}

// ---------------------------------------------------------------------------------------------
// helpers

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isPosInt = (v) => Number.isSafeInteger(v) && v > 0;
function deepFreeze(o) {
  if (o && typeof o === "object" && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); }
  return o;
}
const DAY = 86400000;
const toMs = (d) => Date.parse(`${d}T00:00:00Z`);
export const nightsBetween = (a, b) => Math.round((toMs(b) - toMs(a)) / DAY);
const addDays = (d, n) => new Date(toMs(d) + n * DAY).toISOString().slice(0, 10);
const overlaps = (a, b) => a.arrivalDate < b.departureDate && b.arrivalDate < a.departureDate;
function hasKeyCI(v, key) {
  if (Array.isArray(v)) return v.some((x) => hasKeyCI(x, key));
  if (v !== null && typeof v === "object") return Object.keys(v).some((k) => k.toLowerCase() === key || hasKeyCI(v[k], key));
  return false;
}
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
function placeholderPaths(v, path, out) {
  if (v === PLACEHOLDER) out.push(path);
  else if (Array.isArray(v)) v.forEach((x, i) => placeholderPaths(x, `${path}[${i}]`, out));
  else if (isObj(v)) for (const k of Object.keys(v)) placeholderPaths(v[k], path ? `${path}.${k}` : k, out);
  return out;
}

// ---------------------------------------------------------------------------------------------
// 1. Manifest

const MANIFEST_KEYS = ["manifestVersion", "listingId", "refFieldId", "currency", "nightlyMinor", "cleaningFeeMinor", "guests",
  "window", "r1Block", "r2Stay", "x1bOverlap", "guest"];
const FIXED = Object.freeze({ manifestVersion: MANIFEST_VERSION, refFieldId: E4_REF_FIELD_ID, nightlyMinor: E4_NIGHTLY_MINOR,
  cleaningFeeMinor: E4_CLEANING_FEE_MINOR, guests: E4_GUESTS });

export const expectedTotalMinor = (stay) => nightsBetween(stay.arrivalDate, stay.departureDate) * E4_NIGHTLY_MINOR + E4_CLEANING_FEE_MINOR;

export function planFor(m, stay, ref) {
  return { ref, listingId: E4_TEST_LISTING_ID, arrivalDate: stay.arrivalDate, departureDate: stay.departureDate, guests: m.guests,
    guest: { ...m.guest }, totalMinor: expectedTotalMinor(stay), currency: E4_CURRENCY };
}

/**
 * -> { ok: true, manifest, hash, confirmToken } | { ok: false, errors: [code], blockers: [code] }.
 * `blockers` = owner inputs still missing (placeholders). `now` (a function returning a Date) is required.
 */
export function validateManifest(input, { now } = {}) {
  const fail = (errors, blockers = []) => ({ ok: false, errors, blockers });
  if (typeof now !== "function") return fail(["CLOCK_REQUIRED"]);
  if (!isObj(input)) return fail(["MANIFEST_NOT_OBJECT"]);
  const errors = [];
  for (const k of Object.keys(input)) if (!MANIFEST_KEYS.includes(k)) errors.push(`UNKNOWN_FIELD:${k}`);
  for (const k of MANIFEST_KEYS) if (!Object.prototype.hasOwnProperty.call(input, k)) errors.push(`MISSING_FIELD:${k}`);
  if (hasKeyCI(input, "forceoverbooking")) errors.push("FORCE_OVERBOOKING_REFUSED");
  if (errors.length) return fail(errors);
  const blockers = placeholderPaths(input, "", []).map((p) => `OWNER_INPUT_REQUIRED:${p}`);
  if (blockers.length) return fail([], blockers);

  const m = JSON.parse(JSON.stringify(input));
  if (m.listingId !== E4_TEST_LISTING_ID) errors.push(FORBIDDEN_PILOT_LISTING_IDS.includes(m.listingId) ? "PILOT_LISTING_FORBIDDEN" : "LISTING_NOT_E4_TEST");
  if (m.currency !== E4_CURRENCY) errors.push("CURRENCY_NOT_USD");
  for (const [k, v] of Object.entries(FIXED)) if (m[k] !== v) errors.push(`FIXED_VALUE_MISMATCH:${k}`);

  const stayOk = (s, name, maxNights) => {
    if (!isObj(s) || Object.keys(s).length !== 2 || !isRealDate(s.arrivalDate) || !isRealDate(s.departureDate)) { errors.push(`DATES_INVALID:${name}`); return false; }
    if (!(s.departureDate > s.arrivalDate)) { errors.push(`DEPARTURE_NOT_AFTER_ARRIVAL:${name}`); return false; }
    if (nightsBetween(s.arrivalDate, s.departureDate) > maxNights) { errors.push(`RANGE_TOO_LONG:${name}`); return false; }
    return true;
  };
  const w = isObj(m.window) && Object.keys(m.window).length === 2 ? { arrivalDate: m.window.start, departureDate: m.window.end } : null;
  const windowOk = w ? stayOk(w, "window", MAX_WINDOW_NIGHTS) : (errors.push("DATES_INVALID:window"), false);
  if (windowOk) {
    const today = now().toISOString().slice(0, 10);
    if (w.arrivalDate < addDays(today, MIN_LEAD_DAYS)) errors.push("WINDOW_NOT_FAR_FUTURE");
  }
  const stays = { r1Block: m.r1Block, r2Stay: m.r2Stay, x1bOverlap: m.x1bOverlap };
  const staysOk = Object.entries(stays).every(([n, s]) => stayOk(s, n, MAX_STAY_NIGHTS));
  if (windowOk && staysOk) {
    for (const [n, s] of Object.entries(stays)) {
      if (s.arrivalDate < w.arrivalDate || s.departureDate > w.departureDate) errors.push(`OUTSIDE_WINDOW:${n}`);
    }
    if (overlaps(m.r1Block, m.r2Stay)) errors.push("R1_R2_OVERLAP");
    if (!overlaps(m.x1bOverlap, m.r2Stay)) errors.push("X1B_NOT_OVERLAPPING_R2");
    if (overlaps(m.x1bOverlap, m.r1Block)) errors.push("X1B_OVERLAPS_R1");
  }
  if (staysOk && !errors.length) {
    try { buildCreateReservationRequest(planFor(m, m.r2Stay, "MV-VALIDATE0"), ADAPTER_CFG); }
    catch (e) { errors.push(e instanceof AdapterError ? `GUEST_OR_PLAN_INVALID:${e.code}` : "GUEST_OR_PLAN_INVALID"); }
  }
  if (errors.length) return fail(errors);
  const hash = createHash("sha256").update(canonical(m)).digest("hex");
  return { ok: true, manifest: deepFreeze(m), hash, confirmToken: `E4-EXECUTE-${hash.slice(0, 12)}` };
}

// ---------------------------------------------------------------------------------------------
// 2. Refs (fresh random suffix per attempt; never reused)

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
export function generateRef(rng = randomBytes) {
  let s = "";
  for (let round = 0; round < 8 && s.length < 8; round++) {
    const bytes = rng(16);
    if (!bytes || typeof bytes.length !== "number") throw new RunnerError("RNG_INVALID");
    for (const b of bytes) if (b < 252 && s.length < 8) s += ALPHABET[b % 36]; // rejection sampling: no modulo bias
  }
  const ref = `MV-${s}`;
  if (!REF_RE.test(ref)) throw new RunnerError("REF_GENERATION_FAILED");
  return ref;
}
export function generateRunRefs(rng = randomBytes, n) {
  const refs = new Set();
  for (let tries = 0; refs.size < n; tries++) {
    if (tries >= n * 4) throw new RunnerError("REF_GENERATION_FAILED");
    refs.add(generateRef(rng));
  }
  return Object.freeze([...refs]);
}

// ---------------------------------------------------------------------------------------------
// 3. Journal entry sanitizer (whitelisted keys, validated values only)

const JOURNAL_TYPES = ["run-start", "intent", "outcome", "read", "side-effect-check", "halt", "reconcile", "run-end"];
const CODE_RE = /^[A-Z0-9_:]{1,80}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const IDENTITY_FIELDS = ["reservationId", "listingId", "from", "to", "totalMinor", "currency", "channelId", "bookingRef", "status"];
const JOURNAL_FIELDS = Object.freeze({
  type: (v) => JOURNAL_TYPES.includes(v),
  at: (v) => typeof v === "string" && ISO_RE.test(v),
  step: (v) => Object.prototype.hasOwnProperty.call(STEP_BUDGETS, v),
  kind: (v) => ["create", "cancel", "read", "lookup", "calc"].includes(v),
  code: (v) => typeof v === "string" && CODE_RE.test(v),
  transport: (v) => ["TIMEOUT", "TRANSPORT_ERROR", "MALFORMED_TRANSPORT_RESULT"].includes(v),
  ref: (v) => typeof v === "string" && REF_RE.test(v),
  refs: (v) => Array.isArray(v) && v.length <= 8 && v.every((r) => typeof r === "string" && REF_RE.test(r)),
  runId: (v) => typeof v === "string" && /^[0-9a-f]{16}$/.test(v),
  manifestHash: (v) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v),
  runnerVersion: (v) => v === RUNNER_VERSION,
  reservationId: isPosInt,
  from: isRealDate,
  to: isRealDate,
  totalMinor: (v) => Number.isSafeInteger(v) && v >= 0,
  observedTotalMinor: (v) => Number.isSafeInteger(v) && v >= 0,
  httpStatus: (v) => Number.isSafeInteger(v) && v >= 100 && v <= 599,
  itemsSeen: (v) => Number.isSafeInteger(v) && v >= 0 && v <= 500,
  signalCount: (v) => Number.isSafeInteger(v) && v >= 0 && v <= 1000,
  mismatches: (v) => Array.isArray(v) && v.length <= IDENTITY_FIELDS.length && v.every((f) => IDENTITY_FIELDS.includes(f)),
  status: (v) => typeof v === "string" && /^[A-Z_]{1,40}$/.test(v)
});
export function sanitizeJournalEntry(entry, { steps = STEP_BUDGETS } = {}) {
  const out = {};
  if (!isObj(entry)) return Object.freeze(out);
  for (const [k, ok] of Object.entries(JOURNAL_FIELDS)) {
    const valid = k === "step" ? (v) => Object.prototype.hasOwnProperty.call(steps, v) : ok; // step names of the calling sequence
    if (Object.prototype.hasOwnProperty.call(entry, k) && valid(entry[k])) out[k] = entry[k];
  }
  if (isObj(entry.evidence)) out.evidence = sanitizeForEvidence(entry.evidence);
  return deepFreeze(out);
}

// ---------------------------------------------------------------------------------------------
// 4. Request allowlist + gate (budgets, halt latch, write-ahead journal, single attempt, timeout)

const CREATE_BODY_KEYS = Object.freeze(["channelId", "listingMapId", "arrivalDate", "departureDate", "numberOfGuests", "guestName",
  "guestFirstName", "guestLastName", "guestEmail", "totalPrice", "currency", "customFieldValues"]);
const LOOKUP_QUERY_KEYS = Object.freeze(["listingId", "channelId", "arrivalStartDate", "arrivalEndDate", "limit", "includeResources", "afterId"]);

/** Throws RunnerError unless `req` is one of the five allowed shapes for listing 606998. */
export function assertAllowedRequest(req, state, writeKind) {
  if (!isObj(req) || typeof req.method !== "string" || typeof req.path !== "string") throw new RunnerError("REQUEST_MALFORMED");
  if (hasKeyCI(req, "forceoverbooking")) throw new RunnerError("FORCE_OVERBOOKING_REFUSED");
  const q = req.query === undefined ? {} : req.query;
  if (!isObj(q)) throw new RunnerError("REQUEST_MALFORMED");
  const L = E4_TEST_LISTING_ID;
  const emptyQuery = Object.keys(q).length === 0;
  let kind; let m;
  if (req.method === "POST" && req.path === `/listings/${L}/calendar/priceDetails` && emptyQuery) kind = "calc";
  else if (req.method === "POST" && req.path === "/reservations" && emptyQuery && isObj(req.body) &&
    Object.keys(req.body).every((k) => CREATE_BODY_KEYS.includes(k)) &&
    req.body.listingMapId === L && req.body.channelId === DIRECT_CHANNEL_ID && req.body.currency === E4_CURRENCY) kind = "create";
  else if (req.method === "GET" && req.path === "/reservations" && Object.keys(q).every((k) => LOOKUP_QUERY_KEYS.includes(k)) &&
    q.listingId === L && q.channelId === DIRECT_CHANNEL_ID && req.body === undefined) kind = "lookup";
  else if (req.method === "GET" && (m = /^\/reservations\/([1-9]\d{0,15})$/.exec(req.path)) && req.body === undefined &&
    canonical(q) === canonical(READ_QUERY)) {
    if (!state.readableIds.has(Number(m[1]))) throw new RunnerError("READ_TARGET_NOT_FROM_THIS_RUN");
    kind = "read";
  } else if (req.method === "PUT" && (m = /^\/reservations\/([1-9]\d{0,15})\/statuses\/cancelled$/.exec(req.path)) && emptyQuery &&
    canonical(req.body) === canonical(CANCEL_BODY)) {
    if (state.cancellableId === null || Number(m[1]) !== state.cancellableId) throw new RunnerError("CANCEL_TARGET_NOT_VERIFIED");
    kind = "cancel";
  } else throw new RunnerError("REQUEST_NOT_ALLOWLISTED");
  const isWrite = kind === "create" || kind === "cancel";
  if ((isWrite ? kind : null) !== (writeKind ?? null)) throw new RunnerError("WRITE_KIND_MISMATCH");
  return kind;
}

const normalizeTransportResult = (r) => {
  if (!isObj(r)) return { transportError: true, code: "MALFORMED_TRANSPORT_RESULT" };
  if (r.transportError) return { transportError: true, code: "TRANSPORT_ERROR" };
  return { httpStatus: r.httpStatus, json: r.json };
};

export async function withTimeout(promiseFactory, timeoutMs, onTimeout) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(onTimeout), timeoutMs); });
  try { return await Promise.race([Promise.resolve().then(promiseFactory), timeout]); } finally { clearTimeout(timer); }
}

export function createGate({ transport, journal, timeoutMs, state, budgets = STEP_BUDGETS, writeBudget = WRITE_BUDGET }) {
  const reads = new Map();
  const writes = new Map();
  let requests = 0;
  const journalWrites = (kind) => journal.load().filter((e) => e.type === "intent" && e.kind === kind).length;
  async function send(step, req, { writeKind = null, intent = null } = {}) {
    const budget = Object.prototype.hasOwnProperty.call(budgets, step) ? budgets[step] : undefined;
    if (!budget) throw new RunnerError("STEP_UNKNOWN");
    assertAllowedRequest(req, state, writeKind);
    if (writeKind) {
      if (state.halted) throw new RunnerError("WRITE_AFTER_HALT");
      if (state.readOnly) throw new RunnerError("WRITE_IN_READ_ONLY_MODE");
      if (budget.kind !== writeKind) throw new RunnerError("STEP_KIND_MISMATCH");
      if (budget.executable !== true) throw new RunnerError("STEP_NOT_EXECUTABLE");
      if ((writes.get(step) ?? 0) >= budget.writes) throw new RunnerError("STEP_WRITE_BUDGET_EXHAUSTED");
      if (journalWrites(writeKind) >= writeBudget[writeKind]) throw new RunnerError("RUN_WRITE_BUDGET_EXHAUSTED");
      if (!isObj(intent)) throw new RunnerError("INTENT_REQUIRED");
      writes.set(step, (writes.get(step) ?? 0) + 1);
      try { journal.append(sanitizeJournalEntry({ ...intent, type: "intent", step, kind: writeKind }, { steps: budgets })); } // write-ahead, durable
      catch { state.halted = true; throw new RunnerError("JOURNAL_WRITE_FAILED"); }                  // nothing sent
    } else {
      if ((reads.get(step) ?? 0) >= budget.reads) throw new RunnerError("STEP_READ_BUDGET_EXHAUSTED");
      reads.set(step, (reads.get(step) ?? 0) + 1);
    }
    requests++;
    const frozen = deepFreeze(JSON.parse(JSON.stringify({ method: req.method, path: req.path, query: req.query ?? {}, ...(req.body === undefined ? {} : { body: req.body }) })));
    return withTimeout(
      () => Promise.resolve(transport.send(frozen)).then(normalizeTransportResult, () => ({ transportError: true, code: "TRANSPORT_ERROR" })),
      timeoutMs, { transportError: true, code: "TIMEOUT" });
  }
  return Object.freeze({ send, requestCount: () => requests });
}

// ---------------------------------------------------------------------------------------------
// 5. Response interpretation not covered by the adapter

export function parsePriceTotal(resp) {
  if (resp.transportError) return { ok: false, code: resp.code === "TIMEOUT" ? "PRICE_TIMEOUT" : "PRICE_TRANSPORT_UNCERTAIN" };
  if (resp.httpStatus !== 200) return { ok: false, code: "PRICE_HTTP_NOT_OK" };
  const env = unwrapEnvelope(resp.json);
  if (!env.ok) return { ok: false, code: `PRICE_${env.code}` };
  const t = isObj(env.result) ? amountToMinor(env.result.totalPrice) : null;
  return t === null ? { ok: false, code: "PRICE_TOTAL_NOT_EXACT" } : { ok: true, totalMinor: t };
}

export function parseReservationResponse(resp, prefix) {
  if (resp.transportError) return { ok: false, code: `${prefix}_TRANSPORT_UNCERTAIN`, transport: resp.code };
  const s = resp.httpStatus;
  if (!Number.isSafeInteger(s) || s < 100 || s > 599) return { ok: false, code: `${prefix}_NO_HTTP_STATUS` };
  if (s === 401 || s === 403) return { ok: false, code: `${prefix}_AUTH_UNCERTAIN`, httpStatus: s };
  if (s === 429) return { ok: false, code: `${prefix}_RATE_LIMITED`, httpStatus: s };
  if (s >= 500) return { ok: false, code: `${prefix}_UPSTREAM_5XX`, httpStatus: s };
  if (s >= 400) return { ok: false, code: `${prefix}_REFUSAL_CANDIDATE`, httpStatus: s, refusalCandidate: true };
  if (s < 200 || s > 299) return { ok: false, code: `${prefix}_UNEXPECTED_HTTP_STATUS`, httpStatus: s };
  const env = unwrapEnvelope(resp.json);
  if (!env.ok) return { ok: false, code: `${prefix}_${env.code}`, httpStatus: s };
  const n = normalizeReservation(env.result, ADAPTER_CFG);
  if (!n.ok) return { ok: false, code: `${prefix}_${n.code}`, httpStatus: s };
  return { ok: true, httpStatus: s, reservation: n.reservation };
}

/** Names of identity fields where `r` differs from `exp` (fields absent from `exp` are not compared). */
export function identityMismatches(r, exp) {
  return IDENTITY_FIELDS.filter((f) => Object.prototype.hasOwnProperty.call(exp, f) && r[f] !== exp[f]);
}

// ---------------------------------------------------------------------------------------------
// 6. Plan / dry-run (zero network: there is no transport parameter)

export function planRun(manifestInput, { now } = {}) {
  const v = validateManifest(manifestInput, { now });
  if (!v.ok) return deepFreeze({ mode: "dry-run", network: "none", ok: false, errors: v.errors, blockers: v.blockers });
  const m = v.manifest;
  const DRY_REF = "MV-DRYRUN0"; // only to validate the request shape; never shown, never sent
  const create = (step, stay, expect) => {
    const req = buildCreateReservationRequest(planFor(m, stay, DRY_REF), ADAPTER_CFG);
    return { step, kind: "create", method: req.method, path: req.path, expect, budget: STEP_BUDGETS[step],
      summary: { listingId: req.body.listingMapId, channelId: req.body.channelId, from: stay.arrivalDate, to: stay.departureDate,
        guests: req.body.numberOfGuests, totalMinor: expectedTotalMinor(stay), currency: req.body.currency, ref: "<generated at execution>", guest: "<manifest guest; not shown>" } };
  };
  const read = (step, kind, method, path, expect) => ({ step, kind, method, path, expect, budget: STEP_BUDGETS[step] });
  const steps = [
    read("S0_PREFLIGHT_PRICE", "calc", "POST", `/listings/${E4_TEST_LISTING_ID}/calendar/priceDetails`, `totalMinor == ${expectedTotalMinor(m.r2Stay)} (USD)`),
    read("S1_PREFLIGHT_R2_CLEAR", "lookup", "GET", "/reservations", "no reservation at all on R2 arrival (non-authoritative guard)"),
    create("W1_CREATE_R2", m.r2Stay, "verified created: id, listing, dates, USD, total, channel 2000, ref, status new"),
    read("S2_READBACK_W1", "read", "GET", "/reservations/{W1 id}", "identity + status new"),
    read("S3_LOOKUP_W1_REF", "lookup", "GET", "/reservations", "found, same id"),
    create("W2_CREATE_X1B_OVERLAP", m.x1bOverlap, "any outcome HALTS (a refusal candidate is ambiguous with the empty catalogue)"),
    { ...create("W3_CREATE_X1A_BLOCKED", m.r1Block, "NOT EXECUTABLE"), executable: false, blockedBy: "EMPTY_REFUSAL_CATALOGUE" },
    { ...read("W4_CANCEL_W1", "cancel", "PUT", "/reservations/{W1 id}/statuses/cancelled", "NOT EXECUTABLE"), body: CANCEL_BODY, executable: false, blockedBy: "EMPTY_REFUSAL_CATALOGUE" },
    { ...read("W5_CANCEL_REPEAT", "cancel", "PUT", "/reservations/{W1 id}/statuses/cancelled", "NOT EXECUTABLE"), body: CANCEL_BODY, executable: false, blockedBy: "EMPTY_REFUSAL_CATALOGUE" },
    read("R_RECONCILE", "lookup", "GET", "/reservations[/{id}]", "read-only reconciliation of every create attempt after the halt")
  ];
  return deepFreeze({
    mode: "dry-run", network: "none", ok: true, runnerVersion: RUNNER_VERSION, manifestHash: v.hash, confirmToken: v.confirmToken,
    writeBudget: WRITE_BUDGET, executableWrites: { create: 2, cancel: 0 }, expectedTerminal: "HALTED_AT_W2_BY_DESIGN", steps, executionWired: EXECUTION_WIRED, liveUnverified: LIVE_UNVERIFIED
  });
}

// ---------------------------------------------------------------------------------------------
// 7. Execute (injected transport only; fail-closed prerequisites)

export function checkExecutionPrerequisites(opts = {}) {
  const missing = [];
  if (opts.mode !== "execute") missing.push("MODE_NOT_EXECUTE");
  if (typeof opts.now !== "function") missing.push("CLOCK_MISSING");
  const v = validateManifest(opts.manifest, { now: opts.now });
  if (!v.ok) missing.push("MANIFEST_NOT_APPROVABLE");
  else if (opts.confirm !== v.confirmToken) missing.push("CONFIRM_TOKEN_MISMATCH");
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
  if (typeof opts.sideEffectProbe !== "function") missing.push("SIDE_EFFECT_PROBE_MISSING");
  if (opts.timeoutMs !== undefined && !(Number.isSafeInteger(opts.timeoutMs) && opts.timeoutMs >= 1 && opts.timeoutMs <= 60000)) missing.push("TIMEOUT_INVALID");
  return v.ok && !missing.length ? { ok: true, manifest: v.manifest, hash: v.hash } : { ok: false, missing, manifestErrors: v.errors ?? [], blockers: v.blockers ?? [] };
}

export async function executeRun(opts = {}) {
  const pre = checkExecutionPrerequisites(opts);
  if (!pre.ok) return deepFreeze({ status: "REFUSED", requests: 0, prerequisites: pre.missing, manifestErrors: pre.manifestErrors, blockers: pre.blockers });
  const { transport, journal, sideEffectProbe, now } = opts;
  const m = pre.manifest;
  const cfg = validateAdapterConfig(ADAPTER_CFG);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const state = { halted: false, readOnly: false, readableIds: new Set(), cancellableId: null };
  const report = { status: "RUNNING", runnerVersion: RUNNER_VERSION, manifestHash: pre.hash, steps: [], writes: { create: 0, cancel: 0 },
    refusalCandidates: [], halt: null, reconcile: [] };
  let refs;
  try { refs = generateRunRefs(opts.rng ?? randomBytes, 3); }
  catch { return deepFreeze({ status: "REFUSED", requests: 0, prerequisites: ["REF_GENERATION_FAILED"] }); }
  const [probeRef, ref1, ref2] = refs;
  const runId = createHash("sha256").update(`${pre.hash}:${refs.join(",")}`).digest("hex").slice(0, 16);
  const jappend = (e) => journal.append(sanitizeJournalEntry({ ...e, at: now().toISOString() }));
  try { jappend({ type: "run-start", runId, manifestHash: pre.hash, runnerVersion: RUNNER_VERSION, refs }); }
  catch { return deepFreeze({ status: "REFUSED", requests: 0, prerequisites: ["JOURNAL_WRITE_FAILED"] }); }

  const gate = createGate({ transport, journal, timeoutMs, state });
  const attempts = [];
  const record = (step, o) => report.steps.push(sanitizeJournalEntry({ step, ...o }));
  const halt = (step, code, extra = {}) => {
    if (state.halted && report.halt) return;
    state.halted = true;
    report.halt = sanitizeJournalEntry({ step, code, ...extra });
    try { jappend({ type: "halt", step, code, ...extra }); } catch { /* halt latch already set in memory */ }
  };
  const safeAppend = (step, e) => { try { jappend(e); } catch { halt(step, "JOURNAL_WRITE_FAILED"); } };
  const runStep = async (step, fn) => {
    if (state.halted) return;
    try { await fn(); } catch (e) { halt(step, e instanceof RunnerError ? e.code : "INTERNAL_ERROR"); }
  };
  const probe = async (step) => {
    let r;
    try { r = await withTimeout(() => sideEffectProbe(deepFreeze({ step, listingId: E4_TEST_LISTING_ID, reservationIds: [...state.readableIds] })), timeoutMs, undefined); }
    catch { r = undefined; }
    const clean = isObj(r) && Object.keys(r).length === 1 && Array.isArray(r.signals) && r.signals.length === 0;
    const signalled = isObj(r) && Array.isArray(r.signals) && r.signals.length > 0;
    const code = clean ? "NO_SIGNAL_REPORTED" : signalled ? "SIDE_EFFECT_SIGNAL" : "SIDE_EFFECT_CHECK_UNKNOWN";
    safeAppend(step, { type: "side-effect-check", step, code, ...(signalled ? { signalCount: r.signals.length } : {}) });
    if (!clean) halt(step, code);
  };
  const readById = async (step, id) => {
    const resp = await gate.send(step, { method: "GET", path: `/reservations/${id}`, query: READ_QUERY });
    const p = parseReservationResponse(resp, "READ");
    safeAppend(step, { type: "read", step, kind: "read", code: p.ok ? "READ_OK" : p.code, reservationId: id,
      ...(p.httpStatus ? { httpStatus: p.httpStatus } : {}), ...(p.transport ? { transport: p.transport } : {}),
      ...(p.ok ? { evidence: { reservation: p.reservation } } : {}) });
    return p;
  };
  const lookup = async (step, ref, stay) => {
    let itemsSeen = 0;
    const fetchPage = async (req) => {
      const resp = await gate.send(step, req);
      if (!resp.transportError && resp.httpStatus === 200 && isObj(resp.json) && Array.isArray(resp.json.result)) itemsSeen += resp.json.result.length;
      return resp;
    };
    const r = await lookupByRef({ ref, listingId: E4_TEST_LISTING_ID, arrivalDate: stay.arrivalDate, departureDate: stay.departureDate }, cfg, fetchPage);
    if (r.reservation) state.readableIds.add(r.reservation.reservationId);
    safeAppend(step, { type: "read", step, kind: "lookup", code: r.code, ref, itemsSeen, evidence: r });
    return { ...r, itemsSeen };
  };
  const createAttempt = async (step, ref, stay) => {
    const plan = planFor(m, stay, ref);
    const req = buildCreateReservationRequest(plan, cfg);
    const attempt = { step, ref, stay, reservationId: null };
    attempts.push(attempt);
    const resp = await gate.send(step, req, { writeKind: "create",
      intent: { ref, from: stay.arrivalDate, to: stay.departureDate, totalMinor: plan.totalMinor } });
    report.writes.create++;
    const cls = classifyCreateResponse(resp, plan, cfg);
    const id = cls.reservation?.reservationId ?? cls.reservationId;
    if (isPosInt(id)) { attempt.reservationId = id; state.readableIds.add(id); }
    safeAppend(step, { type: "outcome", step, kind: "create", ref, code: cls.code, evidence: cls,
      ...(resp.transportError ? { transport: resp.code } : {}) });
    await probe(step);
    return cls;
  };
  // Expected-refusal step: EVERY outcome halts. A refusal candidate is ambiguous (empty catalogue); a success is
  // unexpected. The bounded ref lookup then runs only inside read-only reconciliation and can never unlock a write.
  const refusalStep = async (writeStep, ref, stay) => {
    const cls = await createAttempt(writeStep, ref, stay);
    if (cls.outcome === "created" || cls.outcome === "conflict") return halt(writeStep, "UNEXPECTED_CREATE_ON_REFUSAL_STEP");
    if (cls.outcome === "ambiguous" && cls.code === "UNCATALOGUED_REFUSAL_CANDIDATE") {
      report.refusalCandidates.push(sanitizeJournalEntry({ step: writeStep, httpStatus: cls.httpStatus, code: "PROVISIONAL_REFUSAL_CANDIDATE" }));
      return halt(writeStep, "REFUSAL_CANDIDATE_AMBIGUOUS", { httpStatus: cls.httpStatus });
    }
    return halt(writeStep, `WRITE_AMBIGUOUS:${cls.code}`);
  };


  const r2 = m.r2Stay;
  const w1Expect = { listingId: E4_TEST_LISTING_ID, from: r2.arrivalDate, to: r2.departureDate, totalMinor: expectedTotalMinor(r2),
    currency: E4_CURRENCY, channelId: DIRECT_CHANNEL_ID, bookingRef: ref1 };
  let w1Id = null;

  await runStep("S0_PREFLIGHT_PRICE", async () => {
    const resp = await gate.send("S0_PREFLIGHT_PRICE", { method: "POST", path: `/listings/${E4_TEST_LISTING_ID}/calendar/priceDetails`, query: {},
      body: { startingDate: r2.arrivalDate, endingDate: r2.departureDate, numberOfGuests: m.guests, version: 2 } });
    const p = parsePriceTotal(resp);
    safeAppend("S0_PREFLIGHT_PRICE", { type: "read", step: "S0_PREFLIGHT_PRICE", kind: "calc", code: p.ok ? "PRICE_OK" : p.code,
      ...(p.ok ? { observedTotalMinor: p.totalMinor } : {}) });
    if (!p.ok) return halt("S0_PREFLIGHT_PRICE", p.code);
    if (p.totalMinor !== w1Expect.totalMinor) return halt("S0_PREFLIGHT_PRICE", "PREFLIGHT_TOTAL_MISMATCH", { observedTotalMinor: p.totalMinor });
    record("S0_PREFLIGHT_PRICE", { code: "PRICE_MATCHES_MANIFEST", totalMinor: p.totalMinor });
  });
  await runStep("S1_PREFLIGHT_R2_CLEAR", async () => {
    const lk = await lookup("S1_PREFLIGHT_R2_CLEAR", probeRef, r2);
    if (lk.outcome !== "not_found" || lk.itemsSeen !== 0) return halt("S1_PREFLIGHT_R2_CLEAR", "PREFLIGHT_R2_NOT_CLEAR", { itemsSeen: lk.itemsSeen });
    record("S1_PREFLIGHT_R2_CLEAR", { code: "NO_ITEMS_SEEN_NON_AUTHORITATIVE" });
  });
  await runStep("W1_CREATE_R2", async () => {
    const cls = await createAttempt("W1_CREATE_R2", ref1, r2);
    if (cls.outcome !== "created") return halt("W1_CREATE_R2", `W1_NOT_VERIFIED:${cls.code}`);
    const mm = identityMismatches(cls.reservation, { ...w1Expect, status: "new" });
    if (mm.length) return halt("W1_CREATE_R2", "W1_IDENTITY_MISMATCH", { mismatches: mm });
    w1Id = cls.reservation.reservationId;
    record("W1_CREATE_R2", { code: "W1_VERIFIED_CREATED", reservationId: w1Id });
  });
  await runStep("S2_READBACK_W1", async () => {
    const p = await readById("S2_READBACK_W1", w1Id);
    if (!p.ok) return halt("S2_READBACK_W1", p.code);
    const mm = identityMismatches(p.reservation, { ...w1Expect, reservationId: w1Id, status: "new" });
    if (mm.length) return halt("S2_READBACK_W1", "READBACK_IDENTITY_MISMATCH", { mismatches: mm });
  });
  await runStep("S3_LOOKUP_W1_REF", async () => {
    const lk = await lookup("S3_LOOKUP_W1_REF", ref1, r2);
    if (lk.outcome !== "found" || lk.reservation.reservationId !== w1Id) return halt("S3_LOOKUP_W1_REF", `W1_LOOKUP_NOT_CONFIRMED:${lk.code}`);
    // Full identity, not just the id: the list item must agree with the verified create on every field.
    const mm = identityMismatches(lk.reservation, { ...w1Expect, reservationId: w1Id, status: "new" });
    if (mm.length) return halt("S3_LOOKUP_W1_REF", "W1_LOOKUP_IDENTITY_MISMATCH", { mismatches: mm });
    record("S3_LOOKUP_W1_REF", { code: "W1_FOUND_BY_REF", reservationId: w1Id });
  });
  await runStep("W2_CREATE_X1B_OVERLAP", () => refusalStep("W2_CREATE_X1B_OVERLAP", ref2, m.x1bOverlap));
  // W3/W4/W5: not executable (BLOCKED_BY_EMPTY_REFUSAL_CATALOGUE). W2 has halted the run by now in every case;
  // the latch below is a second, independent guarantee.
  if (!state.halted) halt("W2_CREATE_X1B_OVERLAP", "INTERNAL_W2_DID_NOT_HALT");

  if (state.halted) {
    state.cancellableId = null;
    state.readOnly = true;
    report.reconcile = await reconcileAttempts(gate, attempts, cfg, (e) => safeAppend("R_RECONCILE", e));
  }
  report.status = "HALTED"; // always, by design, while the refusal catalogue is empty
  try { jappend({ type: "run-end", code: report.status }); } catch { /* reported below */ }
  report.requests = gate.requestCount();
  return deepFreeze(report);
}

/** Read-only reconciliation of create attempts: read-by-id when an id is known, plus the bounded ref lookup. */
export async function reconcileAttempts(gate, attempts, cfg, append, step = "R_RECONCILE") {
  const out = [];
  for (const a of attempts) {
    const item = { step, ref: a.ref };
    if (a.reservationId) {
      item.reservationId = a.reservationId;
      try {
        const resp = await gate.send(step, { method: "GET", path: `/reservations/${a.reservationId}`, query: READ_QUERY });
        const p = parseReservationResponse(resp, "READ");
        item.readCode = p.ok ? "READ_OK" : p.code;
        if (p.ok) item.reservationStatus = p.reservation.status; // documented enum only (adapter normalizeReservation)
      } catch (e) { item.readCode = e instanceof RunnerError ? e.code : "INTERNAL_ERROR"; }
    }
    try {
      const r = await lookupByRef({ ref: a.ref, listingId: E4_TEST_LISTING_ID, arrivalDate: a.stay.arrivalDate, departureDate: a.stay.departureDate },
        cfg, (req) => gate.send(step, req));
      item.lookupCode = r.code;
      if (r.reservation) item.foundReservationId = r.reservation.reservationId;
    } catch (e) { item.lookupCode = e instanceof RunnerError ? e.code : "INTERNAL_ERROR"; }
    append({ type: "reconcile", step, ref: a.ref, code: item.lookupCode,
      ...(item.reservationId ? { reservationId: item.reservationId } : {}) });
    out.push(deepFreeze(item));
  }
  return out;
}

/**
 * Restart path: given the entries of an EXISTING journal, never write. Reports intents without an outcome as
 * INDETERMINATE and runs the bounded read-only reconciliation for every create attempt in the journal.
 */
export async function reconcileFromJournal({ entries, manifest, transport, now, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const v = validateManifest(manifest, { now });
  if (!v.ok) return deepFreeze({ status: "REFUSED", code: "MANIFEST_NOT_APPROVABLE" });
  if (!transport || typeof transport.send !== "function") return deepFreeze({ status: "REFUSED", code: "TRANSPORT_MISSING" });
  if (!Array.isArray(entries) || !entries.length) return deepFreeze({ status: "REFUSED", code: "JOURNAL_INVALID" });
  entries = entries.map(sanitizeJournalEntry); // a journal read from disk is data: re-validate every value
  if (entries[0].type !== "run-start") return deepFreeze({ status: "REFUSED", code: "JOURNAL_INVALID" });
  if (entries[0].manifestHash !== v.hash) return deepFreeze({ status: "REFUSED", code: "JOURNAL_MANIFEST_MISMATCH" });
  const m = v.manifest;
  const stayByStep = { W1_CREATE_R2: m.r2Stay, W2_CREATE_X1B_OVERLAP: m.x1bOverlap };
  const state = { halted: true, readOnly: true, readableIds: new Set(), cancellableId: null };
  const intents = entries.filter((e) => e.type === "intent");
  const outcomes = entries.filter((e) => e.type === "outcome");
  const indeterminate = intents.filter((i) => !outcomes.some((o) => o.step === i.step)).map((i) => i.step);
  const attempts = intents.filter((i) => i.kind === "create" && stayByStep[i.step] && typeof i.ref === "string").map((i) => {
    const o = outcomes.find((x) => x.step === i.step);
    const id = o?.evidence?.reservation?.reservationId ?? o?.evidence?.reservationId ?? null;
    if (isPosInt(id)) state.readableIds.add(id);
    return { step: i.step, ref: i.ref, stay: stayByStep[i.step], reservationId: isPosInt(id) ? id : null };
  });
  const noJournal = { load: () => [], append: () => { throw new RunnerError("WRITE_IN_READ_ONLY_MODE"); } };
  const gate = createGate({ transport, journal: noJournal, timeoutMs, state });
  const reconcile = await reconcileAttempts(gate, attempts, validateAdapterConfig(ADAPTER_CFG), () => {});
  return deepFreeze({ status: "RECONCILED_READ_ONLY", writesPermitted: false, indeterminateSteps: indeterminate,
    priorWrites: { create: intents.filter((i) => i.kind === "create").length, cancel: intents.filter((i) => i.kind === "cancel").length },
    reconcile, requests: gate.requestCount() });
}
