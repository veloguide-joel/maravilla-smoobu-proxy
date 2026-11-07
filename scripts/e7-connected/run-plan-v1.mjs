// scripts/e7-connected/run-plan-v1.mjs — E7 M2-F: PURE plan-only run package (contract claude/e7-run-plan-v1.md; root review 48d9e328).
//   * A package is SCOPE BINDING only: never provider evidence, readiness, authorization or cleanup permission. executable is ALWAYS false.
//   * Pure: imports only pure accepted modules (graph externals node:crypto / node:util); no process / fs / net / timers / DB / provider.
//   * Constants that live in DB / worker modules are COPIED with origin SHA-256 (parity is asserted by tests from the origin TEXT).
import { createHash } from "node:crypto";
import { types } from "node:util";
import { canonicalJson, isRealDate, MAX_AMOUNT_MINOR, MAX_GUESTS } from "./run-manifest.mjs";
import { CHECKPOINTS_BY_CONNECTION } from "./run-manifest-v2.mjs";
import { localDateInZone } from "../../lib/checkout/compensation-proof.js";
import { evaluateProbeEnvironment } from "./probe-env-preflight.mjs";
import { ownedBytes } from "./probe-source-digest.mjs";

export const RUN_PLAN_VERSION = "e7-run-plan-v1";
export const RUN_PLAN_KIND = "reservation-test-abort-v1";
export const PACKAGE_SCHEMA = "e7-run-package-v1";
export const PLAN_HASH_PREFIX = "e7-run-plan-v1\n";
export const SOURCE_HASH_PREFIX = "e7-run-plan-source-v1\n";
export const PACKAGE_HASH_PREFIX = "e7-run-package-v1\n";
export const MAX_PLAN_BYTES = 16_384;
export const MAX_PLAN_DEPTH = 8;
export const MAX_SOURCE_FILE_BYTES = 262_144;
export const MAX_SOURCE_TOTAL_BYTES = 4 * 1024 * 1024;
export const MAX_PLAN_AGE_MS = 24 * 3_600_000;

/** COPIED constant (origin lib/booking-db/test-abort.js TEST_ABORT_LISTINGS; origin sha256 below; parity asserted by tests) */
export const TEST_ABORT_LISTINGS_COPY = Object.freeze([Object.freeze({ listingId: 606998, currency: "USD" })]);
/** COPIED constant (origin lib/booking-db/reservation-worker.js:69 PROTECTED_HOSTAWAY_RESERVATION_IDS) */
export const PROTECTED_RESERVATION_IDS_COPY = Object.freeze(["70636076", "71045356", "71072615", "71081885"]);
export const CONSTANT_ORIGINS = Object.freeze({
  "lib/booking-db/test-abort.js": "91724d9dcd6c3c514eef70b5d3f4a4458b7298106b0286a797506bd99b48f852",
  "lib/booking-db/reservation-worker.js": "601f48f67052f5dac40b83354b9cf10d5f81950ff9fe9cbd587288d19ed05e88"
});
/** exact historical identifiers from the accepted ledger; null = the identifier did NOT exist (explicit, never guessed) */
export const HISTORICAL_EXCLUSIONS = Object.freeze({
  protectedReservationIds: PROTECTED_RESERVATION_IDS_COPY,
  runs: Object.freeze([
    Object.freeze({ label: "run1", intentId: "b312e325-e6b5-498c-80b5-b91ce5bb3df2", paymentIntentId: null, reservationId: null }),
    Object.freeze({ label: "run2", intentId: "48b59c0d-1c8c-4f32-ad91-08dbab1e8e3c", paymentIntentId: null, reservationId: null }),
    Object.freeze({ label: "run3", intentId: "cc53bc11-565d-4e9b-8be1-95f3febc8a39", paymentIntentId: "pi_3UYqhH2B9LTneQgw1Q0IoYtz", reservationId: null })
  ]),
  otherPaymentIntentIds: Object.freeze(["pi_3UYUIm2B9LTneQgw0mGFQdwG"])
});
export const ALLOWED_OPS = Object.freeze(["hostaway.lookup_by_ref", "hostaway.get_reservation_created", "hostaway.get_listing", "hostaway.get_calendar",
  "hostaway.price_details", "hostaway.create_reservation", "hostaway.cancel_reservation_created", "stripe.accounts.retrieve",
  "stripe.paymentIntents.retrieve_bound", "stripe.paymentIntents.cancel_bound"]);
/** the REVIEWED FOUNDATION closure (sorted): scanned transitive relative imports of the accepted roots + planner + command + manifests */
export const RUN_PLAN_CLOSURE = Object.freeze([
  "lib/bookability.js", "lib/booking-db/capture-worker.js", "lib/booking-db/codec.js", "lib/booking-db/compensation-worker.js", "lib/booking-db/config.js",
  "lib/booking-db/operations.js", "lib/booking-db/pool.js", "lib/booking-db/recording-worker.js", "lib/booking-db/recovery.js", "lib/booking-db/repo.js",
  "lib/booking-db/reservation-worker.js", "lib/booking-db/test-abort.js", "lib/checkout/capture-proof.js", "lib/checkout/compensation-proof.js",
  "lib/checkout/final-price.js", "lib/checkout/intent-state.js", "lib/checkout/offline-charge-proof.js", "lib/checkout/recovery-plan.js",
  "lib/checkout/server-pricer.js", "lib/direct-policy.js", "lib/direct-pricing.js", "lib/hostaway-calendar.js", "lib/hostaway-reservations.js", "lib/hostaway.js",
  "lib/public-api.js", "lib/quote-public.js", "package-lock.json", "package.json", "scripts/e7-connected/executor-adapters.mjs", "scripts/e7-connected/http-transports.mjs",
  "scripts/e7-connected/probe-credential-file.mjs", "scripts/e7-connected/probe-env-preflight.mjs", "scripts/e7-connected/probe-source-digest.mjs",
  "scripts/e7-connected/real-exchange.mjs", "scripts/e7-connected/run-binding-r1.mjs", "scripts/e7-connected/run-core-abort-v2.mjs", "scripts/e7-connected/run-core.mjs", "scripts/e7-connected/run-facts.mjs",
  "scripts/e7-connected/run-guard.mjs", "scripts/e7-connected/run-journal-file-v2.mjs", "scripts/e7-connected/run-journal-file.mjs",
  "scripts/e7-connected/run-journal-memory-v2.mjs", "scripts/e7-connected/run-journal-memory.mjs", "scripts/e7-connected/run-manifest-v2.mjs",
  "scripts/e7-connected/run-manifest.mjs", "scripts/e7-connected/run-plan-command.mjs", "scripts/e7-connected/run-plan-v1.mjs",
  "scripts/e7-connected/run-preflight-r1.mjs", "scripts/e7-connected/run-test-abort.mjs", "scripts/e7-operator/test-abort.mjs"]);
export const P_CHECKS = Object.freeze(["schema", "hashDomains", "sourceClosure", "sourceDigest", "environmentSnapshot", "stripeTestMode", "listingAllowed", "phasesExact",
  "allowedOpsExact", "checkpointsExact", "deadlineCaps", "stayRules", "exclusionsExact", "binding"]);
export const L_CHECKS = Object.freeze(["dbSameInstanceTestMarkerAppAndReport", "intentPaymentAuthorizedExactBinding", "exclusionRowsUnchanged", "stripeAccountTestMode",
  "paymentIntentRequiresCaptureAmountCurrencyLivemodeExpiryMargin", "hostawayListingIdentity", "calendarAvailability", "freshQuoteEqualsAmount", "existingRefLookupEmpty"]);
export const G_CHECKS = Object.freeze(["dbLockHeld", "signalNotAborted", "freshStepDeadline", "quoteAndAuthorizationStillValid", "journalCombinedAckBeforeSend",
  "ownerAttestationRecorded", "stopBoundaryM8", "cancelTargetIsCreatedIdNotExcluded", "voidTargetIsBoundPaymentIntent", "acceptedProtectedStateLockAckGates"]);
export const PERMISSIONS_NONE = Object.freeze({ execute: false, providerWrite: false, providerRead: false, dbRead: false, dbWrite: false, cleanup: false, adopt: false });
export const PLAN_CODES = Object.freeze(["PLAN_OK", "PLAN_BYTES_INVALID", "PLAN_TOO_LARGE", "PLAN_TOO_DEEP", "PLAN_NOT_JSON", "PLAN_NOT_CANONICAL", "PLAN_SHAPE",
  "VERSION_UNSUPPORTED", "KIND_UNSUPPORTED", "RUN_ID_INVALID", "CREATED_AT_INVALID", "CREATED_AT_FUTURE", "PLAN_STALE", "BASELINE_INVALID", "STRIPE_NOT_TEST",
  "STRIPE_ACCOUNT_INVALID", "HOSTAWAY_LABEL_INVALID", "DB_SCOPE_INVALID", "LISTING_INVALID", "LISTING_NOT_ALLOWED", "TIMEZONE_INVALID", "PHASES_NOT_EXACT",
  "ALLOWED_OPS_NOT_EXACT", "CHECKPOINTS_NOT_EXACT", "DEADLINES_INVALID", "STAY_RULES_INVALID", "EXCLUSIONS_NOT_EXACT", "BINDING_SHAPE", "BINDING_ID_INVALID",
  "BINDING_DATES_INVALID", "BINDING_STAY_REVERSED", "BINDING_NIGHTS", "BINDING_LEAD_TIME", "BINDING_GUESTS", "BINDING_AMOUNT", "BINDING_RATE", "QUOTE_MISMATCH",
  "QUOTE_CURRENCY_MISMATCH", "TIMESTAMP_INVALID", "TIMESTAMP_FUTURE", "TIMESTAMP_ORDER", "QUOTE_TOO_OLD", "AUTHORIZATION_TOO_OLD", "BINDING_EXCLUDED",
  "CLOCK_INVALID", "ENV_REFUSED", "SOURCE_INVALID", "SOURCE_DIGEST_MISMATCH"]);

const freeze = Object.freeze;
const getProto = Object.getPrototypeOf;
const defineProp = Object.defineProperty;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RUN_ID_RE = /^[a-z0-9-]{8,64}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const ACCT_RE = /^acct_[A-Za-z0-9]{8,32}$/;
const LABEL_RE = /^[A-Za-z0-9._:-]{1,100}$/;
const PI_RE = /^pi_[A-Za-z0-9]{8,64}$/;
const REF_RE = /^[A-Z0-9-]{4,32}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_STRING = 1024; const MAX_NODES = 2048;
const isInt = (v, lo, hi) => typeof v === "number" && Number.isSafeInteger(v) && v >= lo && v <= hi;

/**
 * snapshotData(v) → a deep FROZEN copy of plain JSON-like data, or null. Descriptor-only (no getter is executed): plain or null-prototype
 * objects and real arrays only (no proxies, accessors, symbols, boxed primitives, holes, extra array props), strings ≤ 1024, safe integers,
 * booleans, null; depth ≤ 8 and ≤ 2048 nodes.
 */
export function snapshotData(v) {
  let nodes = 0;
  const walk = (x, depth) => {
    if (++nodes > MAX_NODES || depth > MAX_PLAN_DEPTH) throw 0;
    if (x === null || typeof x === "boolean") return x;
    if (typeof x === "string") { if (x.length > MAX_STRING) throw 0; return x; }
    if (typeof x === "number") { if (!Number.isSafeInteger(x)) throw 0; return x; }
    if (typeof x !== "object" || types.isProxy(x) || types.isBoxedPrimitive(x)) throw 0;
    const d = Object.getOwnPropertyDescriptors(x); const keys = Reflect.ownKeys(d);
    if (Array.isArray(x)) {
      if (getProto(x) !== Array.prototype) throw 0;
      const len = d.length && d.length.value;
      if (!Number.isSafeInteger(len) || keys.length !== len + 1) throw 0;
      const out = [];
      for (let i = 0; i < len; i++) { const e = d[String(i)]; if (!e || !("value" in e)) throw 0; out.push(walk(e.value, depth + 1)); }
      return freeze(out);
    }
    const p = getProto(x); if (p !== Object.prototype && p !== null) throw 0;
    const out = {};
    // defineProperty, never `out[k] =`: an own "__proto__" key must stay an own data key (the legacy setter would drop it and re-prototype the copy)
    for (const k of keys) { if (typeof k !== "string") throw 0; const e = d[k]; if (!("value" in e) || e.enumerable !== true) throw 0;
      defineProp(out, k, { value: walk(e.value, depth + 1), enumerable: true, writable: true, configurable: true }); }
    return freeze(out);
  };
  try { return walk(v, 0); } catch { return null; }
}
const keysEq = (o, ks) => o !== null && typeof o === "object" && !Array.isArray(o) && Object.keys(o).length === ks.length && ks.every((k) => Object.hasOwn(o, k));
const iso = (s) => (typeof s === "string" && ISO_RE.test(s) && (() => { const t = Date.parse(s); return Number.isFinite(t) && new Date(t).toISOString() === s ? t : null; })()) || null;
const days = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const same = (a, b) => canonicalJson(a) === canonicalJson(b);

export const planHashV1 = (validatedPlan) => createHash("sha256").update(PLAN_HASH_PREFIX + canonicalJson(validatedPlan), "utf8").digest("hex");
export const packageHashV1 = (body) => createHash("sha256").update(PACKAGE_HASH_PREFIX + canonicalJson(body), "utf8").digest("hex");
/** the source framing: prefix, then per entry  path ‖ 0x00 ‖ decimal length ‖ 0x00 ‖ bytes ‖ 0x00  (entries are already validated / owned) */
export function sourceDigestV1(entries) {
  const h = createHash("sha256"); const z = new Uint8Array([0]); const enc = new TextEncoder();
  h.update(enc.encode(SOURCE_HASH_PREFIX));
  for (const { path, bytes } of entries) { h.update(enc.encode(path)); h.update(z); h.update(enc.encode(String(bytes.length))); h.update(z); h.update(bytes); h.update(z); }
  return h.digest("hex");
}

/** validateRunPlanV1(plan, { planClock }) → frozen { ok:true, plan, bound } | { ok:false, code }; pure; plan is snapshotted first */
export function validateRunPlanV1(planInput, opts) {
  const R = (code) => freeze({ ok: false, code });
  const o = snapshotData(opts);
  if (!o || !keysEq(o, ["planClock"]) || !isInt(o.planClock, 1, 8.64e15)) return R("CLOCK_INVALID");
  const now = o.planClock;
  const m = snapshotData(planInput);
  if (!m || !keysEq(m, ["allowedOps", "baseline", "binding", "checkpoints", "createdAt", "deadlines", "environment", "exclusions", "kind", "listing", "phases", "runId", "stayRules", "version"])) return R("PLAN_SHAPE");
  if (m.version !== RUN_PLAN_VERSION) return R("VERSION_UNSUPPORTED");
  if (m.kind !== RUN_PLAN_KIND) return R("KIND_UNSUPPORTED");
  if (typeof m.runId !== "string" || !RUN_ID_RE.test(m.runId)) return R("RUN_ID_INVALID");
  const created = iso(m.createdAt); if (created === null) return R("CREATED_AT_INVALID");
  if (created > now) return R("CREATED_AT_FUTURE");
  if (now - created > MAX_PLAN_AGE_MS) return R("PLAN_STALE");
  const b = m.baseline;
  if (!keysEq(b, ["repoCommit", "sourceDigest"]) || typeof b.repoCommit !== "string" || !COMMIT_RE.test(b.repoCommit) || typeof b.sourceDigest !== "string" || !HEX64.test(b.sourceDigest)) return R("BASELINE_INVALID");
  const e = m.environment;
  if (!keysEq(e, ["db", "hostaway", "stripe"])) return R("PLAN_SHAPE");
  if (!keysEq(e.stripe, ["accountId", "mode"])) return R("PLAN_SHAPE");
  if (e.stripe.mode !== "test") return R("STRIPE_NOT_TEST");
  if (typeof e.stripe.accountId !== "string" || !ACCT_RE.test(e.stripe.accountId)) return R("STRIPE_ACCOUNT_INVALID");
  if (!keysEq(e.hostaway, ["accountRef", "clientSnapshotId"]) || ![e.hostaway.accountRef, e.hostaway.clientSnapshotId].every((x) => typeof x === "string" && LABEL_RE.test(x))) return R("HOSTAWAY_LABEL_INVALID");
  if (!keysEq(e.db, ["appRole", "instanceEnvironment", "reportRole"]) || e.db.instanceEnvironment !== "test" || e.db.appRole !== "mv_booking_app" || e.db.reportRole !== "mv_booking_report") return R("DB_SCOPE_INVALID");
  const l = m.listing;
  if (!keysEq(l, ["connection", "currency", "id", "refFieldId", "timeZone"]) || !isInt(l.id, 1, 1e12) || typeof l.currency !== "string" || !isInt(l.refFieldId, 1, 1e9)
    || !["disconnected", "airbnb"].includes(l.connection) || typeof l.timeZone !== "string") return R("LISTING_INVALID");
  if (!TEST_ABORT_LISTINGS_COPY.some((x) => x.listingId === l.id && x.currency === l.currency)) return R("LISTING_NOT_ALLOWED");
  const today = localDateInZone(now, l.timeZone); if (today === null) return R("TIMEZONE_INVALID");
  if (!same(m.phases, { capture: false, recording: false, testAbortAfterReservation: true }) || !keysEq(m.phases, ["capture", "recording", "testAbortAfterReservation"])) return R("PHASES_NOT_EXACT");
  if (!Array.isArray(m.allowedOps) || !same(m.allowedOps, ALLOWED_OPS)) return R("ALLOWED_OPS_NOT_EXACT");
  if (!Array.isArray(m.checkpoints) || !same(m.checkpoints, CHECKPOINTS_BY_CONNECTION[l.connection])) return R("CHECKPOINTS_NOT_EXACT");
  const dl = m.deadlines;
  if (!keysEq(dl, ["authorizationMaxAgeHours", "quoteMaxAgeMinutes"]) || !isInt(dl.quoteMaxAgeMinutes, 1, 30) || !isInt(dl.authorizationMaxAgeHours, 1, 24)) return R("DEADLINES_INVALID");
  const sr = m.stayRules;
  if (!keysEq(sr, ["maxNights", "minLeadDays"]) || !isInt(sr.minLeadDays, 7, 365) || !isInt(sr.maxNights, 1, 7)) return R("STAY_RULES_INVALID");
  if (!same(m.exclusions, HISTORICAL_EXCLUSIONS)) return R("EXCLUSIONS_NOT_EXACT");
  let bound = false;
  if (m.binding !== null) {
    const x = m.binding;
    if (!keysEq(x, ["amountMinor", "authorizedAt", "expectedRef", "intentId", "paymentIntentId", "quote", "rateBps", "stay"]) || !keysEq(x.stay, ["arrival", "departure", "guests"])
      || !keysEq(x.quote, ["currency", "quotedAt", "totalMinor"])) return R("BINDING_SHAPE");
    if (typeof x.intentId !== "string" || !UUID_RE.test(x.intentId) || typeof x.paymentIntentId !== "string" || !PI_RE.test(x.paymentIntentId)
      || typeof x.expectedRef !== "string" || !REF_RE.test(x.expectedRef)) return R("BINDING_ID_INVALID");
    const ex = HISTORICAL_EXCLUSIONS;
    if (ex.runs.some((r) => r.intentId === x.intentId) || ex.runs.some((r) => r.paymentIntentId !== null && r.paymentIntentId === x.paymentIntentId)
      || ex.otherPaymentIntentIds.includes(x.paymentIntentId)) return R("BINDING_EXCLUDED");
    if (!isRealDate(x.stay.arrival) || !isRealDate(x.stay.departure)) return R("BINDING_DATES_INVALID");
    const nights = days(x.stay.arrival, x.stay.departure);
    if (nights < 1) return R("BINDING_STAY_REVERSED");
    if (nights > sr.maxNights) return R("BINDING_NIGHTS");
    if (days(today, x.stay.arrival) < sr.minLeadDays) return R("BINDING_LEAD_TIME");
    if (!isInt(x.stay.guests, 1, MAX_GUESTS)) return R("BINDING_GUESTS");
    if (!isInt(x.amountMinor, 1, MAX_AMOUNT_MINOR)) return R("BINDING_AMOUNT");
    if (!isInt(x.rateBps, 0, 10_000)) return R("BINDING_RATE");
    if (!isInt(x.quote.totalMinor, 1, MAX_AMOUNT_MINOR) || x.quote.totalMinor !== x.amountMinor) return R("QUOTE_MISMATCH");
    if (x.quote.currency !== l.currency) return R("QUOTE_CURRENCY_MISMATCH");
    const q = iso(x.quote.quotedAt); const a = iso(x.authorizedAt);
    if (q === null || a === null) return R("TIMESTAMP_INVALID");
    if (q > now || a > now) return R("TIMESTAMP_FUTURE");
    if (!(q <= a && a <= created)) return R("TIMESTAMP_ORDER");
    if (now - q > dl.quoteMaxAgeMinutes * 60_000) return R("QUOTE_TOO_OLD");
    if (now - a > dl.authorizationMaxAgeHours * 3_600_000) return R("AUTHORIZATION_TOO_OLD");   // dominated today (q ≤ a, quote cap ≤ 30 min < 1 h); kept as defence
    bound = true;
  }
  return freeze({ ok: true, plan: m, bound });
}

/** ownPlanBytes(v) → an OWNED copy of a genuine non-shared Uint8Array of 1…PLAN_COPY_MAX bytes, or null (no caller getter / iterator is read) */
export const PLAN_COPY_MAX = 4 * MAX_PLAN_BYTES;
export const ownPlanBytes = (v) => ownedBytes(v, PLAN_COPY_MAX);
/**
 * parsePlanBytes(bytes) → { ok:true, value } | { ok:false, code }: exact canonicalJson + "\n", bounded size and depth (scanned before JSON.parse).
 * Not ownable (non-Uint8Array, proxy, shared, empty, > PLAN_COPY_MAX) → PLAN_BYTES_INVALID; owned but > MAX_PLAN_BYTES → PLAN_TOO_LARGE.
 */
export function parsePlanBytes(input) {
  const b = ownPlanBytes(input);
  if (b === null) return { ok: false, code: "PLAN_BYTES_INVALID" };
  if (b.length > MAX_PLAN_BYTES) return { ok: false, code: "PLAN_TOO_LARGE" };
  let depth = 0; let inStr = false; let esc = false;
  for (const c of b) {
    if (inStr) { if (esc) esc = false; else if (c === 0x5c) esc = true; else if (c === 0x22) inStr = false; continue; }
    if (c === 0x22) inStr = true; else if (c === 0x7b || c === 0x5b) { if (++depth > MAX_PLAN_DEPTH) return { ok: false, code: "PLAN_TOO_DEEP" }; } else if (c === 0x7d || c === 0x5d) depth -= 1;
  }
  let text; try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(b); } catch { return { ok: false, code: "PLAN_NOT_JSON" }; }
  if (!text.endsWith("\n")) return { ok: false, code: "PLAN_NOT_CANONICAL" };
  let v; try { v = JSON.parse(text.slice(0, -1)); } catch { return { ok: false, code: "PLAN_NOT_JSON" }; }
  let canon; try { canon = canonicalJson(v); } catch { return { ok: false, code: "PLAN_NOT_CANONICAL" }; }
  if (`${canon}\n` !== text) return { ok: false, code: "PLAN_NOT_CANONICAL" };            // also refuses duplicate keys / whitespace / key order
  return { ok: true, value: v };
}

/** checkSourceEntries(entries) → { ok:true, entries:[{path, bytes}] (owned copies) } | { ok:false }: EXACT closure order, no missing / extra / duplicate */
export function checkSourceEntries(input) {
  try {
    if (!Array.isArray(input) || types.isProxy(input) || getProto(input) !== Array.prototype) return { ok: false };
    const d = Object.getOwnPropertyDescriptors(input);
    if (!d.length || d.length.value !== RUN_PLAN_CLOSURE.length || Reflect.ownKeys(d).length !== RUN_PLAN_CLOSURE.length + 1) return { ok: false };
    const out = []; let total = 0;
    for (let i = 0; i < RUN_PLAN_CLOSURE.length; i++) {
      const e = d[String(i)]; if (!e || !("value" in e)) return { ok: false };
      const x = e.value;
      if (x === null || typeof x !== "object" || types.isProxy(x) || (getProto(x) !== Object.prototype && getProto(x) !== null)) return { ok: false };
      const xd = Object.getOwnPropertyDescriptors(x); const ks = Reflect.ownKeys(xd);
      if (ks.length !== 2 || !xd.path || !xd.bytes || !("value" in xd.path) || !("value" in xd.bytes)) return { ok: false };
      if (xd.path.value !== RUN_PLAN_CLOSURE[i]) return { ok: false };
      const bytes = ownedBytes(xd.bytes.value, MAX_SOURCE_FILE_BYTES); if (bytes === null) return { ok: false };
      total += bytes.length; if (total > MAX_SOURCE_TOTAL_BYTES) return { ok: false };
      out.push(freeze({ path: RUN_PLAN_CLOSURE[i], bytes }));
    }
    return { ok: true, entries: freeze(out) };
  } catch { return { ok: false }; }
}

/**
 * buildRunPackageV1({ planBytes, sourceEntries, envSnapshot, planClock }) → frozen { ok:true, planHash, sourceDigest, packageHash, package }
 *                                                                          | frozen { ok:false, code }   (pure; never throws)
 */
export function buildRunPackageV1(input) {
  const R = (code) => freeze({ ok: false, code });
  try {
    if (input === null || typeof input !== "object" || types.isProxy(input) || getProto(input) !== Object.prototype) return R("PLAN_SHAPE");
    const d = Object.getOwnPropertyDescriptors(input);
    if (Reflect.ownKeys(d).length !== 4 || !["envSnapshot", "planBytes", "planClock", "sourceEntries"].every((k) => d[k] && "value" in d[k])) return R("PLAN_SHAPE");
    const clock = d.planClock.value; if (!isInt(clock, 1, 8.64e15)) return R("CLOCK_INVALID");
    const envSnap = snapshotData(d.envSnapshot.value);                // ONE descriptor snapshot; the caller's object is not read again
    const env = envSnap === null ? null : evaluateProbeEnvironment(envSnap);
    if (!env || env.code !== "ENV_OK") return R("ENV_REFUSED");
    const src = checkSourceEntries(d.sourceEntries.value); if (!src.ok) return R("SOURCE_INVALID");
    const parsed = parsePlanBytes(d.planBytes.value); if (!parsed.ok) return R(parsed.code);
    const v = validateRunPlanV1(parsed.value, { planClock: clock }); if (!v.ok) return R(v.code);
    const sourceDigest = sourceDigestV1(src.entries);
    if (sourceDigest !== v.plan.baseline.sourceDigest) return R("SOURCE_DIGEST_MISMATCH");
    const planHash = planHashV1(v.plan);
    const P = {}; for (const k of P_CHECKS) P[k] = k === "binding" ? (v.bound ? "PASS" : "UNBOUND") : "PASS";
    const L = {}; for (const k of L_CHECKS) L[k] = "NOT_RUN";
    const G = {}; for (const k of G_CHECKS) G[k] = "NOT_RUN";
    const body = { schema: PACKAGE_SCHEMA, planHash, plan: v.plan, sourceDigest, closure: [...RUN_PLAN_CLOSURE], evaluatedAt: clock,
      toolchain: { nodeVersion: envSnap.nodeVersion, platform: envSnap.platform }, envReport: { code: env.code },
      binding: v.bound ? "BOUND" : "UNBOUND", checks: { P, L, G }, executable: false, permissions: { ...PERMISSIONS_NONE }, nature: "SCOPE_BINDING_ONLY" };
    if (typeof body.toolchain.nodeVersion !== "string" || typeof body.toolchain.platform !== "string") return R("ENV_REFUSED");
    const frozenBody = snapshotDeep(body);
    return freeze({ ok: true, planHash, sourceDigest, packageHash: packageHashV1(frozenBody), package: frozenBody });
  } catch { return R("PLAN_SHAPE"); }
}
const snapshotDeep = (v) => (v !== null && typeof v === "object" ? (Array.isArray(v) ? freeze(v.map(snapshotDeep)) : freeze(Object.fromEntries(Object.entries(v).map(([k, x]) => [k, snapshotDeep(x)])))) : v);
