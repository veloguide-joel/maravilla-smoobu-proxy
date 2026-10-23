// E4 HAPPY-PATH sequence — OFFLINE-ONLY scaffold (feature/e4-happy-path-offline).
//
// One bounded create -> verify -> cancel of a single test reservation on listing 606998. Write budget:
// 1 create + 1 cancel. No overlap/refusal probes, no repeat cancel, no calendar block. The protocol runner
// (runner.mjs, KEEP 2d9f510) is unchanged in behaviour; this module reuses its reviewed gate, allowlist, journal
// sanitizer, response parsing and reconciliation, and the reviewed adapter (fc913c4).
//
// Like runner.mjs it has NO transport, credentials or environment access: every provider request goes through an
// INJECTED transport.send(); nothing is wired to a real client and the CLI has no execute path.
//
// Cancellation (official reference api.hostaway.com/documentation, "Cancel a reservation", read 2026-10-22):
//   PUT /v1/reservations/{reservationId}/statuses/cancelled
//   "cancelledBy JSON body parameter should be specified with value host or guest."  Response: "The cancelled
//   reservation object or error response."  => body { cancelledBy: "host" }. The response ENVELOPE for this endpoint
//   is not shown in the reference: LIVE-UNVERIFIED (handled fail-closed: anything but a success envelope with a
//   reservation matching the full identity and status "cancelled" halts).
//
// Sequence (any failure, mismatch, ambiguity or side-effect signal HALTS every later write, cleanup included; after a
// halt only read-only reconciliation runs; no retries, no re-auth):
//   P0 priceDetails total == manifest total (USD)          P1 no reservation at all on the stay's arrival date
//   HW1 create  -> verified: id, listing, dates, USD total, channel 2000, ref, status new
//   P2 read by id == full identity (status new)            P3 ref lookup finds the same id with full identity
//   P4 FRESH read by id immediately before cancel == full identity (status new); only then is the id cancellable
//   HW2 cancel  -> response must carry the same full identity with status cancelled
//   P5 read by id == full identity with status cancelled

import { randomBytes, createHash } from "node:crypto";
import {
  validateAdapterConfig, buildCreateReservationRequest, classifyCreateResponse, lookupByRef, isRealDate, DIRECT_CHANNEL_ID,
  FORBIDDEN_PILOT_LISTING_IDS, LOOKUP_MAX_PAGES, AdapterError
} from "../../lib/hostaway-reservations.js";
import {
  ADAPTER_CFG, E4_TEST_LISTING_ID, E4_REF_FIELD_ID, E4_CURRENCY, E4_NIGHTLY_MINOR, E4_CLEANING_FEE_MINOR, E4_GUESTS, PLACEHOLDER,
  MIN_LEAD_DAYS, MAX_WINDOW_NIGHTS, MAX_STAY_NIGHTS, DEFAULT_TIMEOUT_MS, CANCEL_BODY, READ_QUERY, RunnerError,
  nightsBetween, expectedTotalMinor, planFor, generateRunRefs, sanitizeJournalEntry, createGate, withTimeout, parsePriceTotal,
  parseReservationResponse, identityMismatches, reconcileAttempts
} from "./runner.mjs";

export const HAPPY_VERSION = "e4-happy-path-v1";
export const HAPPY_MANIFEST_VERSION = "e4-happy-manifest-v1";
export const HAPPY_WRITE_BUDGET = Object.freeze({ create: 1, cancel: 1 });
export const HAPPY_EXECUTION_WIRED = false;
export const HAPPY_STEPS = Object.freeze({
  P0_PREFLIGHT_PRICE: Object.freeze({ reads: 1, writes: 0 }),
  P1_PREFLIGHT_CLEAR: Object.freeze({ reads: LOOKUP_MAX_PAGES, writes: 0 }),
  HW1_CREATE: Object.freeze({ reads: 0, writes: 1, kind: "create", executable: true }),
  P2_READBACK: Object.freeze({ reads: 1, writes: 0 }),
  P3_LOOKUP_REF: Object.freeze({ reads: LOOKUP_MAX_PAGES, writes: 0 }),
  P4_PRECANCEL_READ: Object.freeze({ reads: 1, writes: 0 }),
  HW2_CANCEL: Object.freeze({ reads: 0, writes: 1, kind: "cancel", executable: true }),
  P5_POSTCANCEL_READ: Object.freeze({ reads: 1, writes: 0 }),
  HR_RECONCILE: Object.freeze({ reads: 1 + LOOKUP_MAX_PAGES, writes: 0 })
});
export const HAPPY_LIVE_UNVERIFIED = Object.freeze([
  "cancel response envelope ({status:'success', result:<reservation>}) — reference says only 'The cancelled reservation object or error response'",
  "GET /v1/reservations/{id} returns customFieldValues (the reference documents includeResources only for the list endpoint)",
  "create success envelope shape and status 'new' after a direct (2000) create",
  "totalPrice unchanged by a host cancellation (a change halts after the cancel; nothing further is written)",
  "priceDetails result.totalPrice (seen only in the sanitized owner-run e4-route-v1 output)"
]);

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
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

// ---------------------------------------------------------------------------------------------
// Manifest: fixed listing/prices/currency/guests; owner inputs = window, stay, synthetic guest.

const KEYS = ["manifestVersion", "listingId", "refFieldId", "currency", "nightlyMinor", "cleaningFeeMinor", "guests", "window", "stay", "guest"];
const FIXED = Object.freeze({ manifestVersion: HAPPY_MANIFEST_VERSION, refFieldId: E4_REF_FIELD_ID, nightlyMinor: E4_NIGHTLY_MINOR,
  cleaningFeeMinor: E4_CLEANING_FEE_MINOR, guests: E4_GUESTS });

export function validateHappyManifest(input, { now } = {}) {
  const fail = (errors, blockers = []) => ({ ok: false, errors, blockers });
  if (typeof now !== "function") return fail(["CLOCK_REQUIRED"]);
  if (!isObj(input)) return fail(["MANIFEST_NOT_OBJECT"]);
  const errors = [];
  for (const k of Object.keys(input)) if (!KEYS.includes(k)) errors.push(`UNKNOWN_FIELD:${k}`);
  for (const k of KEYS) if (!Object.prototype.hasOwnProperty.call(input, k)) errors.push(`MISSING_FIELD:${k}`);
  if (hasKeyCI(input, "forceoverbooking")) errors.push("FORCE_OVERBOOKING_REFUSED");
  if (errors.length) return fail(errors);
  const blockers = placeholderPaths(input, "", []).map((p) => `OWNER_INPUT_REQUIRED:${p}`);
  if (blockers.length) return fail([], blockers);
  const m = JSON.parse(JSON.stringify(input));
  if (m.listingId !== E4_TEST_LISTING_ID) errors.push(FORBIDDEN_PILOT_LISTING_IDS.includes(m.listingId) ? "PILOT_LISTING_FORBIDDEN" : "LISTING_NOT_E4_TEST");
  if (m.currency !== E4_CURRENCY) errors.push("CURRENCY_NOT_USD");
  for (const [k, v] of Object.entries(FIXED)) if (m[k] !== v) errors.push(`FIXED_VALUE_MISMATCH:${k}`);
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
    try { buildCreateReservationRequest(planFor(m, s, "MV-VALIDATE0"), ADAPTER_CFG); }
    catch (e) { errors.push(e instanceof AdapterError ? `GUEST_OR_PLAN_INVALID:${e.code}` : "GUEST_OR_PLAN_INVALID"); }
  }
  if (errors.length) return fail(errors);
  const hash = createHash("sha256").update(canonical(m)).digest("hex");
  return { ok: true, manifest: deepFreeze(m), hash, confirmToken: `E4-HAPPY-${hash.slice(0, 12)}` };
}

// ---------------------------------------------------------------------------------------------
// Plan / dry-run: zero network (no transport parameter).

export function planHappyRun(manifestInput, { now } = {}) {
  const v = validateHappyManifest(manifestInput, { now });
  if (!v.ok) return deepFreeze({ mode: "dry-run", network: "none", ok: false, errors: v.errors, blockers: v.blockers });
  const s = v.manifest.stay;
  const req = buildCreateReservationRequest(planFor(v.manifest, s, "MV-DRYRUN0"), ADAPTER_CFG);
  const step = (id, method, path, expect) => ({ step: id, method, path, expect, budget: HAPPY_STEPS[id] });
  return deepFreeze({
    mode: "dry-run", network: "none", ok: true, version: HAPPY_VERSION, manifestHash: v.hash, confirmToken: v.confirmToken,
    writeBudget: HAPPY_WRITE_BUDGET, executionWired: HAPPY_EXECUTION_WIRED, liveUnverified: HAPPY_LIVE_UNVERIFIED,
    stay: { from: s.arrivalDate, to: s.departureDate, nights: nightsBetween(s.arrivalDate, s.departureDate), totalMinor: expectedTotalMinor(s),
      currency: req.body.currency, listingId: req.body.listingMapId, channelId: req.body.channelId, guests: req.body.numberOfGuests,
      ref: "<generated at execution>", guest: "<manifest guest; not shown>" },
    steps: [
      step("P0_PREFLIGHT_PRICE", "POST", `/listings/${E4_TEST_LISTING_ID}/calendar/priceDetails`, `totalMinor == ${expectedTotalMinor(s)} (USD)`),
      step("P1_PREFLIGHT_CLEAR", "GET", "/reservations", "no reservation at all on the arrival date (non-authoritative guard)"),
      step("HW1_CREATE", "POST", "/reservations", "verified created: full identity, status new"),
      step("P2_READBACK", "GET", "/reservations/{id}", "full identity, status new"),
      step("P3_LOOKUP_REF", "GET", "/reservations", "found, same id, full identity"),
      step("P4_PRECANCEL_READ", "GET", "/reservations/{id}", "fresh full identity, status new — only then cancellable"),
      { ...step("HW2_CANCEL", "PUT", "/reservations/{id}/statuses/cancelled", "same identity, status cancelled"), body: CANCEL_BODY },
      step("P5_POSTCANCEL_READ", "GET", "/reservations/{id}", "full identity, status cancelled")
    ]
  });
}

// ---------------------------------------------------------------------------------------------
// Execute: injected transport only; fail-closed prerequisites (same set as the protocol runner).

export function checkHappyPrerequisites(opts = {}) {
  const missing = [];
  if (opts.mode !== "execute") missing.push("MODE_NOT_EXECUTE");
  if (typeof opts.now !== "function") missing.push("CLOCK_MISSING");
  const v = validateHappyManifest(opts.manifest, { now: opts.now });
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

export async function executeHappyRun(opts = {}) {
  const pre = checkHappyPrerequisites(opts);
  if (!pre.ok) return deepFreeze({ status: "REFUSED", requests: 0, prerequisites: pre.missing, manifestErrors: pre.manifestErrors, blockers: pre.blockers });
  const { transport, journal, sideEffectProbe, now } = opts;
  const m = pre.manifest;
  const s = m.stay;
  const cfg = validateAdapterConfig(ADAPTER_CFG);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const san = (e) => sanitizeJournalEntry(e, { steps: HAPPY_STEPS });
  const state = { halted: false, readOnly: false, readableIds: new Set(), cancellableId: null };
  const report = { status: "RUNNING", version: HAPPY_VERSION, manifestHash: pre.hash, steps: [], writes: { create: 0, cancel: 0 }, halt: null, reconcile: [] };
  let refs;
  try { refs = generateRunRefs(opts.rng ?? randomBytes, 2); }
  catch { return deepFreeze({ status: "REFUSED", requests: 0, prerequisites: ["REF_GENERATION_FAILED"] }); }
  const [probeRef, ref] = refs;
  const runId = createHash("sha256").update(`${pre.hash}:${refs.join(",")}`).digest("hex").slice(0, 16);
  const jappend = (e) => journal.append(san({ ...e, at: now().toISOString() }));
  try { jappend({ type: "run-start", runId, manifestHash: pre.hash, refs }); }
  catch { return deepFreeze({ status: "REFUSED", requests: 0, prerequisites: ["JOURNAL_WRITE_FAILED"] }); }

  const rawGate = createGate({ transport, journal, timeoutMs, state, budgets: HAPPY_STEPS, writeBudget: HAPPY_WRITE_BUDGET });
  // Remember the allowlisted diagnostic of the most recent transport failure so that a halt caused by it records WHY
  // (token refused / invalid token response / network / local refusal / timeout). Reset on every request.
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
    try { jappend({ type: "halt", step, code, ...withDiag }); } catch { /* latch already set */ }
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
  const expectNew = { listingId: E4_TEST_LISTING_ID, from: s.arrivalDate, to: s.departureDate, totalMinor: expectedTotalMinor(s),
    currency: E4_CURRENCY, channelId: DIRECT_CHANNEL_ID, bookingRef: ref, status: "new" };
  let id = null;
  const readFull = async (step, status, code) => {
    const resp = await gate.send(step, { method: "GET", path: `/reservations/${id}`, query: READ_QUERY });
    const p = parseReservationResponse(resp, "READ");
    safeAppend(step, { type: "read", step, kind: "read", code: p.ok ? "READ_OK" : p.code, reservationId: id,
      ...(p.httpStatus ? { httpStatus: p.httpStatus } : {}), ...(p.transport ? { transport: p.transport } : {}),
      ...(p.ok ? { evidence: { reservation: p.reservation } } : {}) });
    if (!p.ok) { halt(step, p.code); return false; }
    const mm = identityMismatches(p.reservation, { ...expectNew, reservationId: id, status });
    if (mm.length) { halt(step, code, { mismatches: mm }); return false; }
    return true;
  };

  await runStep("P0_PREFLIGHT_PRICE", async () => {
    const resp = await gate.send("P0_PREFLIGHT_PRICE", { method: "POST", path: `/listings/${E4_TEST_LISTING_ID}/calendar/priceDetails`, query: {},
      body: { startingDate: s.arrivalDate, endingDate: s.departureDate, numberOfGuests: m.guests, version: 2 } });
    const p = parsePriceTotal(resp);
    const priceStatus = !resp.transportError && Number.isSafeInteger(resp.httpStatus) ? { httpStatus: resp.httpStatus } : {};
    safeAppend("P0_PREFLIGHT_PRICE", { type: "read", step: "P0_PREFLIGHT_PRICE", kind: "calc", code: p.ok ? "PRICE_OK" : p.code,
      ...(p.ok ? { observedTotalMinor: p.totalMinor } : {}), ...priceStatus, ...(resp.diag ? { diag: resp.diag } : {}) });
    if (!p.ok) return halt("P0_PREFLIGHT_PRICE", p.code, priceStatus);
    if (p.totalMinor !== expectNew.totalMinor) return halt("P0_PREFLIGHT_PRICE", "PREFLIGHT_TOTAL_MISMATCH", { observedTotalMinor: p.totalMinor });
    record("P0_PREFLIGHT_PRICE", { code: "PRICE_MATCHES_MANIFEST", totalMinor: p.totalMinor });
  });
  await runStep("P1_PREFLIGHT_CLEAR", async () => {
    let itemsSeen = 0;
    const lk = await lookupByRef({ ref: probeRef, listingId: E4_TEST_LISTING_ID, arrivalDate: s.arrivalDate, departureDate: s.departureDate }, cfg,
      async (req) => {
        const resp = await gate.send("P1_PREFLIGHT_CLEAR", req);
        if (!resp.transportError && resp.httpStatus === 200 && isObj(resp.json) && Array.isArray(resp.json.result)) itemsSeen += resp.json.result.length;
        return resp;
      });
    safeAppend("P1_PREFLIGHT_CLEAR", { type: "read", step: "P1_PREFLIGHT_CLEAR", kind: "lookup", code: lk.code, ref: probeRef, itemsSeen });
    if (lk.outcome !== "not_found" || itemsSeen !== 0) return halt("P1_PREFLIGHT_CLEAR", "PREFLIGHT_NOT_CLEAR", { itemsSeen });
    record("P1_PREFLIGHT_CLEAR", { code: "NO_ITEMS_SEEN_NON_AUTHORITATIVE" });
  });
  await runStep("HW1_CREATE", async () => {
    const plan = planFor(m, s, ref);
    const req = buildCreateReservationRequest(plan, cfg);
    const attempt = { step: "HW1_CREATE", ref, stay: s, reservationId: null };
    attempts.push(attempt);
    const resp = await gate.send("HW1_CREATE", req, { writeKind: "create",
      intent: { ref, from: s.arrivalDate, to: s.departureDate, totalMinor: plan.totalMinor } });
    report.writes.create++;
    const cls = classifyCreateResponse(resp, plan, cfg);
    const rid = cls.reservation?.reservationId ?? cls.reservationId;
    if (Number.isSafeInteger(rid) && rid > 0) { attempt.reservationId = rid; state.readableIds.add(rid); }
    safeAppend("HW1_CREATE", { type: "outcome", step: "HW1_CREATE", kind: "create", ref, code: cls.code, evidence: cls,
      ...(resp.transportError ? { transport: resp.code } : {}) });
    await probe("HW1_CREATE");
    if (cls.outcome !== "created") return halt("HW1_CREATE", `CREATE_NOT_VERIFIED:${cls.code}`);
    const mm = identityMismatches(cls.reservation, expectNew);
    if (mm.length) return halt("HW1_CREATE", "CREATE_IDENTITY_MISMATCH", { mismatches: mm });
    if (state.halted) return;
    id = cls.reservation.reservationId;
    record("HW1_CREATE", { code: "VERIFIED_CREATED", reservationId: id });
  });
  await runStep("P2_READBACK", () => readFull("P2_READBACK", "new", "READBACK_IDENTITY_MISMATCH"));
  await runStep("P3_LOOKUP_REF", async () => {
    const lk = await lookupByRef({ ref, listingId: E4_TEST_LISTING_ID, arrivalDate: s.arrivalDate, departureDate: s.departureDate }, cfg,
      (req) => gate.send("P3_LOOKUP_REF", req));
    safeAppend("P3_LOOKUP_REF", { type: "read", step: "P3_LOOKUP_REF", kind: "lookup", code: lk.code, ref, evidence: lk });
    if (lk.outcome !== "found" || lk.reservation.reservationId !== id) return halt("P3_LOOKUP_REF", `LOOKUP_NOT_CONFIRMED:${lk.code}`);
    const mm = identityMismatches(lk.reservation, { ...expectNew, reservationId: id });
    if (mm.length) return halt("P3_LOOKUP_REF", "LOOKUP_IDENTITY_MISMATCH", { mismatches: mm });
  });
  await runStep("P4_PRECANCEL_READ", async () => {
    if (!(await readFull("P4_PRECANCEL_READ", "new", "PRECANCEL_IDENTITY_MISMATCH"))) return;
    state.cancellableId = id; // the only id that may ever be cancelled: verified created by THIS run, freshly re-read
  });
  await runStep("HW2_CANCEL", async () => {
    const resp = await gate.send("HW2_CANCEL", { method: "PUT", path: `/reservations/${id}/statuses/cancelled`, query: {}, body: CANCEL_BODY },
      { writeKind: "cancel", intent: { reservationId: id, ref } });
    state.cancellableId = null; // one cancel attempt, whatever the outcome
    report.writes.cancel++;
    const p = parseReservationResponse(resp, "CANCEL");
    const mm = p.ok ? identityMismatches(p.reservation, { ...expectNew, reservationId: id, status: "cancelled" }) : [];
    const code = !p.ok ? p.code : mm.length ? "CANCEL_RESPONSE_MISMATCH" : "VERIFIED_CANCELLED";
    safeAppend("HW2_CANCEL", { type: "outcome", step: "HW2_CANCEL", kind: "cancel", reservationId: id, code, ...(mm.length ? { mismatches: mm } : {}),
      ...(p.httpStatus ? { httpStatus: p.httpStatus } : {}), ...(p.transport ? { transport: p.transport } : {}),
      ...(p.ok ? { evidence: { reservation: p.reservation } } : {}) });
    await probe("HW2_CANCEL");
    if (code !== "VERIFIED_CANCELLED") return halt("HW2_CANCEL", code, mm.length ? { mismatches: mm } : {});
    record("HW2_CANCEL", { code, reservationId: id });
  });
  await runStep("P5_POSTCANCEL_READ", () => readFull("P5_POSTCANCEL_READ", "cancelled", "POSTCANCEL_IDENTITY_MISMATCH"));

  if (state.halted) {
    state.cancellableId = null;
    state.readOnly = true;
    report.reconcile = await reconcileAttempts(gate, attempts, cfg, (e) => safeAppend("HR_RECONCILE", e), "HR_RECONCILE");
  }
  report.status = state.halted ? "HALTED" : "COMPLETED";
  try { jappend({ type: "run-end", code: report.status }); } catch { /* reported via status */ }
  report.requests = gate.requestCount();
  return deepFreeze(report);
}

/** Restart path: never writes. Intents without an outcome are INDETERMINATE; bounded read-only reconciliation only. */
export async function reconcileHappyFromJournal({ entries, manifest, transport, now, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const v = validateHappyManifest(manifest, { now });
  if (!v.ok) return deepFreeze({ status: "REFUSED", code: "MANIFEST_NOT_APPROVABLE" });
  if (!transport || typeof transport.send !== "function") return deepFreeze({ status: "REFUSED", code: "TRANSPORT_MISSING" });
  if (!Array.isArray(entries) || !entries.length) return deepFreeze({ status: "REFUSED", code: "JOURNAL_INVALID" });
  const es = entries.map((e) => sanitizeJournalEntry(e, { steps: HAPPY_STEPS }));
  if (es[0].type !== "run-start") return deepFreeze({ status: "REFUSED", code: "JOURNAL_INVALID" });
  if (es[0].manifestHash !== v.hash) return deepFreeze({ status: "REFUSED", code: "JOURNAL_MANIFEST_MISMATCH" });
  const state = { halted: true, readOnly: true, readableIds: new Set(), cancellableId: null };
  const intents = es.filter((e) => e.type === "intent");
  const outcomes = es.filter((e) => e.type === "outcome");
  const indeterminate = intents.filter((i) => !outcomes.some((o) => o.step === i.step)).map((i) => i.step);
  const attempts = intents.filter((i) => i.step === "HW1_CREATE" && typeof i.ref === "string").map((i) => {
    const o = outcomes.find((x) => x.step === i.step);
    const rid = o?.evidence?.reservation?.reservationId ?? o?.evidence?.reservationId ?? null;
    if (Number.isSafeInteger(rid) && rid > 0) state.readableIds.add(rid);
    return { step: i.step, ref: i.ref, stay: v.manifest.stay, reservationId: Number.isSafeInteger(rid) && rid > 0 ? rid : null };
  });
  const noJournal = { load: () => [], append: () => { throw new RunnerError("WRITE_IN_READ_ONLY_MODE"); } };
  const gate = createGate({ transport, journal: noJournal, timeoutMs, state, budgets: HAPPY_STEPS, writeBudget: HAPPY_WRITE_BUDGET });
  const reconcile = await reconcileAttempts(gate, attempts, validateAdapterConfig(ADAPTER_CFG), () => {}, "HR_RECONCILE");
  return deepFreeze({ status: "RECONCILED_READ_ONLY", writesPermitted: false, indeterminateSteps: indeterminate,
    priorWrites: { create: intents.filter((i) => i.kind === "create").length, cancel: intents.filter((i) => i.kind === "cancel").length },
    reconcile, requests: gate.requestCount() });
}
