// scripts/e7-connected/readonly-probe.mjs — E7 connected-test runner SLICE P: OFFLINE read-only probe orchestration over INJECTED
// T `send` objects. Contract: claude/e7-connected-readonly-probe-contract.md (rev 2 accepted at a56c2db1, clarifications A–F, §11).
//   * GET-only fixed probe inventory (P-H1…P-H6, P-S1, P-S2); every request is built ONLY from the frozen, branded plan snapshot that
//     produced planHash — never from reply content; no pagination / follow-up / retry / fallback; one send per probe.
//   * No CLI, credential, env, fs, timer, network or process access: deadlines come from INJECTED `monotonic` + `timers.arm`; P owns its
//     per-probe AbortControllers, observers and armed handles ONLY — T / X own transport resources. An UNSETTLED / UNOBSERVABLE tail may
//     still hold arbitrary injected work (not a sandbox). Synchronous dependency / send code that blocks JS is outside every bound.
//   * Every public result is code-only and deep-frozen; metadata values are TRUSTED LABELS echoed from the plan, not runtime attestation
//     and not authentication or proof of approval.
import { createHash } from "node:crypto";
import { types } from "node:util";
import { PROTECTED_HOSTAWAY_RESERVATION_IDS } from "../../lib/checkout/compensation-proof.js";

export const READONLY_PROBE_VERSION = "e7-readonly-probe-v1";
export const PLAN_VERSION = "e7-probe-plan-v1";
export const RESULT_SCHEMA = "e7-probe-result-v1";
export const PROBE_IDS = Object.freeze(["P-H1", "P-H2", "P-H3", "P-H4", "P-H5", "P-H6", "P-S1", "P-S2"]);
export const STRIPE_VERSION_CANDIDATE = "2026-01-28.clover";   // = CHECKOUT_STRIPE_API_VERSION (lib/checkout/intent-api-http.js) and the accepted cleanup client version
export const NODE_VERSION_LABELS = Object.freeze(["22.22.0", "24.22.1"]);
export const MAX_PLAN_STRING = 253;                                   // = longest accepted T id ("pi_" + 250, http-transports.mjs:343)
/** COPIES (parity-tested): T ERROR_CODES (http-transports.mjs:35–36), RESERVATION_STATUSES (accepted Hostaway reservation adapter in lib/, :47 — filename deliberately not named here: its importer pin counts any scripts/ file containing it), charge types
 *  (offline-charge-proof.js:239, module-private there → source-text assertion), PaymentIntent statuses (Stripe docs). */
export const T_ERROR_CODES = Object.freeze(["OPTIONS_INVALID", "REQUEST_NOT_ALLOWED", "ABORTED", "ABORTED_IN_FLIGHT", "CREDENTIAL_INVALID", "KEY_NOT_TEST",
  "EXCHANGE_FAILED", "REDIRECT_REFUSED", "ACCOUNT_MISMATCH", "REPLY_INVALID", "BODY_TOO_LARGE", "JSON_INVALID", "LIVEMODE_REFUSED", "STRIPE_HTTP_4XX", "STRIPE_HTTP_5XX"]);
export const RESERVATION_STATUSES = Object.freeze(["new", "modified", "cancelled", "ownerStay", "pending", "awaitingPayment", "declined", "expired", "inquiry",
  "inquiryPreapproved", "inquiryDenied", "inquiryTimedout", "inquiryNotPossible"]);
export const CHARGE_TYPES = Object.freeze(["charge", "preAuth", "refund"]);
export const PI_STATUSES = Object.freeze(["requires_payment_method", "requires_confirmation", "requires_action", "processing", "requires_capture", "canceled", "succeeded"]);
export const CODES = Object.freeze({
  plan: Object.freeze(["PLAN_SHAPE", "PLAN_STRIPE_VERSION", "PLAN_PROTECTED", "PLAN_CONTROL_SAME", "PLAN_PROBE_DUPLICATE", "PLAN_PROBE_ORDER", "PLAN_DEPENDENCY", "PLAN_UNUSED_INPUT", "PLAN_NOT_VALIDATED"]),
  run: Object.freeze(["RUN_SHAPE", "RUN_TRANSPORT_INVALID", "RUN_DEPS_INVALID", "RUN_SIGNAL_INVALID"]),
  probe: Object.freeze(["PROBE_OK", "PROBE_AUTH_REFUSED", "PROBE_HTTP_STATUS", "PROBE_SHAPE_MISMATCH", "PROBE_LISTING_MISMATCH", "PROBE_RESERVATION_MISMATCH",
    "PROBE_FOREIGN_ROW", "PROBE_PROTECTED_SEEN", "PROBE_ACCOUNT_MISMATCH", "PROBE_LIVEMODE_REFUSED", "PROBE_INCOMPLETE", "PROBE_PAGE_FULL", "PROBE_LIMIT_REACHED",
    "PROBE_EMPTY_SAMPLE", "PROBE_CONTROL_OVERLAP", "PROBE_CHARGE_ABSENT", "PROBE_PROOF_FIELDS_INCOMPLETE", "PROBE_TRANSPORT_FAILED", "PROBE_TIMEOUT", "PROBE_CANCELLED", "PROBE_BUDGET_EXHAUSTED",
    "PROBE_DEPENDENCY_FAILED", "AFTER_STOP", "PREREQ_INCONCLUSIVE"]),
  gate: Object.freeze(["OBSERVED", "SINGLE_SAMPLE", "INCONCLUSIVE", "OPEN", "NOT_PROBED"]),
  outcome: Object.freeze(["OK", "INCONCLUSIVE", "STOP", "NOT_RUN", "COMPLETED", "STOPPED"]),
  tail: Object.freeze(["NONE", "LATE_FULFILLED", "LATE_REJECTED", "UNSETTLED", "UNOBSERVABLE"]),
  elapsed: Object.freeze(["LT_1S", "LT_5S", "LT_15S", "GE_15S"]),
  latestCharge: Object.freeze(["VERIFIED_TEST_CHARGE", "ABSENT"])
});
/** timer cleanup report keys (counts): a cancel that threw, and a rejected handle that offered no safely callable cancel */
export const TIMER_CLEANUP_KEYS = Object.freeze(["cancelFailed", "uncancellable"]);
/** every string a summary may contain besides planHash and the four echoed metadata labels (mechanical redaction whitelist) */
export const VOCABULARY = Object.freeze(new Set([RESULT_SCHEMA, ...PROBE_IDS, ...Object.values(CODES).flat(), ...RESERVATION_STATUSES, ...PI_STATUSES]));

// ---- intrinsics captured at load (B / T rule) ---------------------------------------------------------------------------------------
const freeze = Object.freeze;
const apply = Reflect.apply;
const ownKeys = Reflect.ownKeys;
const getDesc = Object.getOwnPropertyDescriptor;
const getDescs = Object.getOwnPropertyDescriptors;
const getProto = Object.getPrototypeOf;
const NativePromise = Promise;
const PROMISE_PROTO = Promise.prototype;
const P_THEN = Promise.prototype.then;
const CTOR_DESC = getDesc(Promise.prototype, "constructor");
const SPECIES_DESC = getDesc(Promise, Symbol.species);
const NativeAbortController = AbortController;
const AC_ABORT = AbortController.prototype.abort;
const AC_SIGNAL = getDesc(AbortController.prototype, "signal").get;
const NATIVE_ABORTED = getDesc(AbortSignal.prototype, "aborted").get;
const ET_ADD = EventTarget.prototype.addEventListener;
const ET_REMOVE = EventTarget.prototype.removeEventListener;
const WELL_KNOWN = new Set(Object.getOwnPropertyNames(Symbol).map((k) => Symbol[k]).filter((s) => typeof s === "symbol"));
const PROTECTED = new Set(PROTECTED_HOSTAWAY_RESERVATION_IDS.map(String));
const { isProxy, isPromise } = types;
const isFn = (f) => typeof f === "function" && !isProxy(f);
const isObj = (o) => o !== null && typeof o === "object" && !isProxy(o);
const isPlain = (o) => { try { if (!isObj(o) || Array.isArray(o)) return false; const p = getProto(o); return p === Object.prototype || p === null; } catch { return false; } };
const isArr = (a) => { try { return Array.isArray(a) && !isProxy(a); } catch { return false; } };
/** own DATA property value or undefined (accessors are never invoked) */
const od = (o, k) => { try { if (!isObj(o)) return undefined; const d = getDesc(o, k); return d && "value" in d ? d.value : undefined; } catch { return undefined; } };
const has = (o, k) => { try { return isObj(o) && getDesc(o, k) !== undefined; } catch { return false; } };
const arrLen = (a) => { const l = od(a, "length"); return Number.isSafeInteger(l) ? l : -1; };
const deepFreeze = (v) => { if (v !== null && typeof v === "object" && !Object.isFrozen(v)) { for (const k of ownKeys(v)) deepFreeze(v[k]); freeze(v); } return v; };

function nativeAborted(sig) { if (!isObj(sig)) return null; try { const a = apply(NATIVE_ABORTED, sig, []); return typeof a === "boolean" ? a : null; } catch { return null; } }
function intrinsicsIntact() {
  const c = getDesc(PROMISE_PROTO, "constructor"); const sp = getDesc(NativePromise, Symbol.species);
  return !!c && "value" in c && c.value === CTOR_DESC.value && !!sp && sp.get === SPECIES_DESC.get && sp.set === SPECIES_DESC.set;
}
function isNativePromise(p) {
  try {
    if (!isObj(p) || !isPromise(p) || getProto(p) !== PROMISE_PROTO) return false;
    const d = getDescs(p);
    for (const k of ownKeys(d)) if (typeof k !== "symbol" || WELL_KNOWN.has(k) || Symbol.keyFor(k) !== undefined || !("value" in d[k])) return false;
    return intrinsicsIntact();
  } catch { return false; }
}
/** attach through the captured intrinsic then; false WITHOUT attaching unless `p` is an unpatched native promise */
function observe(p, onF, onR) {
  if (!isNativePromise(p)) return false;
  try { apply(P_THEN, p, [(v) => { try { onF(v); } catch { /* contained */ } }, (e) => { try { onR(e); } catch { /* contained */ } }]); return true; } catch { return false; }
}

// ---- plan snapshot + validation ------------------------------------------------------------------------------------------------------
const BAD = Symbol("bad");
function snap(v, depth = 6) {
  if (v === null || typeof v === "boolean") return v;
  if (typeof v === "string") return v.length <= MAX_PLAN_STRING ? v : BAD;
  if (typeof v === "number") return Number.isFinite(v) ? v : BAD;
  if (!isObj(v) || depth <= 0) return BAD;
  let d; try { d = getDescs(v); } catch { return BAD; }
  const ks = ownKeys(d);
  if (isArr(v)) {
    if (getProto(v) !== Array.prototype) return BAD;
    const len = d.length; if (!len || !("value" in len) || !Number.isSafeInteger(len.value) || len.value > 64 || ks.length !== len.value + 1) return BAD;
    const out = [];
    for (let i = 0; i < len.value; i++) { const di = d[String(i)]; if (!di || !("value" in di) || di.enumerable !== true) return BAD; const s = snap(di.value, depth - 1); if (s === BAD) return BAD; out.push(s); }
    return out;
  }
  if (!isPlain(v)) return BAD;
  const out = Object.create(null);
  for (const k of ks) {
    if (typeof k !== "string" || k === "__proto__" || k === "toJSON" || !("value" in d[k]) || d[k].enumerable !== true) return BAD;
    const s = snap(d[k].value, depth - 1); if (s === BAD) return BAD; out[k] = s;
  }
  return out;
}
const keysEq = (o, keys) => { if (!o || typeof o !== "object" || Array.isArray(o)) return false; const k = Object.keys(o).sort(); const w = [...keys].sort(); return k.length === w.length && k.every((x, i) => x === w[i]); };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const realDate = (s) => { if (typeof s !== "string" || !DATE_RE.test(s)) return false; const t = Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)); return new Date(t).toISOString().slice(0, 10) === s; };
const dayIndex = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 86_400_000;
const RID_RE = /^[1-9][0-9]{0,15}$/;
const ACCT_RE = /^acct_[A-Za-z0-9]{1,64}$/;                            // = T http-transports.mjs:342
const PI_RE = /^pi_[A-Za-z0-9_]{1,250}$/;                              // = T http-transports.mjs:343
const posInt = (v, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(v) && v >= 1 && v <= max;
const BRAND = new WeakSet();
/** canonical JSON: keys sorted by UTF-16 code unit, no whitespace, JSON.stringify escaping */
export function canonicalJson(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(",")}}`;
}
const planFail = (code) => freeze({ ok: false, code });
/** validateProbePlan(input) → frozen { ok:true, plan } | frozen { ok:false, code } — the caller object is read exactly once */
export function validateProbePlan(input) {
  const p = snap(input);
  if (p === BAD || !keysEq(p, ["hostaway", "limits", "metadata", "probes", "stripe", "version"]) || p.version !== PLAN_VERSION) return planFail("PLAN_SHAPE");
  const m = p.metadata;
  if (!keysEq(m, ["approvalRef", "nodeVersion", "reviewedCommit", "stripeVersion"]) || typeof m.reviewedCommit !== "string" || !/^[0-9a-f]{40}$/.test(m.reviewedCommit)
      || !NODE_VERSION_LABELS.includes(m.nodeVersion) || typeof m.approvalRef !== "string" || !/^[A-Za-z0-9._:-]{1,80}$/.test(m.approvalRef)) return planFail("PLAN_SHAPE");
  if (m.stripeVersion !== STRIPE_VERSION_CANDIDATE) return planFail("PLAN_STRIPE_VERSION");
  const l = p.limits;
  if (!keysEq(l, ["perProbeMs", "runMs", "tailMs"]) || !Number.isSafeInteger(l.perProbeMs) || l.perProbeMs < 1000 || l.perProbeMs > 15000
      || !Number.isSafeInteger(l.runMs) || l.runMs < 1000 || l.runMs > 180000 || l.runMs < l.perProbeMs || !Number.isSafeInteger(l.tailMs) || l.tailMs < 0 || l.tailMs > 10000) return planFail("PLAN_SHAPE");
  const h = p.hostaway;
  if (h !== null) {
    if (!keysEq(h, ["calendar", "control", "listingId", "lookup", "sample"]) || !posInt(h.listingId, 2147483647)) return planFail("PLAN_SHAPE");
    if (h.calendar !== null && (!keysEq(h.calendar, ["endDate", "startDate"]) || !realDate(h.calendar.startDate) || !realDate(h.calendar.endDate)
        || dayIndex(h.calendar.endDate) < dayIndex(h.calendar.startDate) || dayIndex(h.calendar.endDate) - dayIndex(h.calendar.startDate) + 1 > 31)) return planFail("PLAN_SHAPE");
    if (h.lookup !== null && (!keysEq(h.lookup, ["arrivalDate", "optIn"]) || !realDate(h.lookup.arrivalDate) || h.lookup.optIn !== true)) return planFail("PLAN_SHAPE");
    for (const k of ["sample", "control"]) {
      const s = h[k]; if (s === null) continue;
      if (!keysEq(s, ["listingId", "reservationId"]) || typeof s.reservationId !== "string" || !RID_RE.test(s.reservationId) || !posInt(s.listingId, 2147483647)) return planFail("PLAN_SHAPE");
      if (PROTECTED.has(s.reservationId)) return planFail("PLAN_PROTECTED");
    }
    if (h.control !== null && h.sample !== null && h.control.reservationId === h.sample.reservationId) return planFail("PLAN_CONTROL_SAME");
  }
  const s = p.stripe;
  if (s !== null && (!keysEq(s, ["accountId", "paymentIntentId"]) || typeof s.accountId !== "string" || !ACCT_RE.test(s.accountId)
      || (s.paymentIntentId !== null && (typeof s.paymentIntentId !== "string" || !PI_RE.test(s.paymentIntentId))))) return planFail("PLAN_SHAPE");
  const ids = p.probes;
  if (!isArr(ids) || ids.length < 1 || ids.length > 8 || !ids.every((x) => PROBE_IDS.includes(x))) return planFail("PLAN_SHAPE");
  if (new Set(ids).size !== ids.length) return planFail("PLAN_PROBE_DUPLICATE");
  for (let i = 1; i < ids.length; i++) if (PROBE_IDS.indexOf(ids[i]) < PROBE_IDS.indexOf(ids[i - 1])) return planFail("PLAN_PROBE_ORDER");
  const inPlan = (x) => ids.includes(x);
  const dep = {
    "P-H1": h !== null, "P-H2": h !== null && h.calendar !== null, "P-H3": h !== null && h.lookup !== null, "P-H4": h !== null && h.sample !== null,
    "P-H5": h !== null && h.sample !== null && inPlan("P-H4"), "P-H6": h !== null && h.control !== null && inPlan("P-H5"),
    "P-S1": s !== null, "P-S2": s !== null && s.paymentIntentId !== null && inPlan("P-S1")
  };
  if (!ids.every((x) => dep[x])) return planFail("PLAN_DEPENDENCY");
  const unused = (h !== null && !ids.some((x) => x.startsWith("P-H"))) || (h !== null && h.calendar !== null && !inPlan("P-H2")) || (h !== null && h.lookup !== null && !inPlan("P-H3"))
    || (h !== null && h.sample !== null && !inPlan("P-H4")) || (h !== null && h.control !== null && !inPlan("P-H6")) || (s !== null && !inPlan("P-S1"))
    || (s !== null && s.paymentIntentId !== null && !inPlan("P-S2"));
  if (unused) return planFail("PLAN_UNUSED_INPUT");
  const body = deepFreeze(p);
  const planHash = createHash("sha256").update(canonicalJson(body)).digest("hex");
  const plan = freeze({ ...body, planHash });
  BRAND.add(plan);
  return freeze({ ok: true, plan });
}

// ---- reply checks (§1.1); every function returns { outcome, code, evidence } with whitelisted values only --------------------------
const OKR = (evidence) => ({ outcome: "OK", code: "PROBE_OK", evidence });
const INC = (code, evidence = null) => ({ outcome: "INCONCLUSIVE", code, evidence });
const STP = (code) => ({ outcome: "STOP", code, evidence: null });
/** canonical provider id (accepted providerIdToCanonical rule, offline-charge-proof.js:67–69): positive safe integer NUMBER → String */
const canonicalId = (v) => (posInt(v) ? String(v) : null);
/** exact money (accepted amountToMinor rule of the Hostaway reservation adapter, :184–191; parity-tested) */
export function amountToMinor(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(value)); if (!m) return null;
  const minor = Number(m[1]) * 100 + Number((m[2] || "").padEnd(2, "0"));
  return Number.isSafeInteger(minor) ? minor : null;
}
function envelope(reply) {
  const st = od(reply, "httpStatus");
  if (!Number.isSafeInteger(st)) return { fail: STP("PROBE_SHAPE_MISMATCH"), status: null };
  if (st === 401 || st === 403) return { fail: STP("PROBE_AUTH_REFUSED"), status: st };
  if (st !== 200) return { fail: STP("PROBE_HTTP_STATUS"), status: st };
  const j = od(reply, "json");
  if (!isPlain(j) || od(j, "status") !== "success" || !has(j, "result")) return { fail: STP("PROBE_SHAPE_MISMATCH"), status: st };
  return { json: j, result: od(j, "result"), status: st };
}
const protectedId = (v) => { const c = canonicalId(v) ?? (typeof v === "string" ? v : null); return c !== null && (PROTECTED.has(c) || PROTECTED.has(c.replace(/^0+(?=[0-9])/, ""))); };
/** reservation field types: the accepted normalizeReservation rules for the LISTED fields only (no refFieldId / custom-field content check) */
function reservationTypesOk(r) {
  const id = od(r, "id"); if (!posInt(id)) return false;
  if (has(r, "hostawayReservationId")) { const a = od(r, "hostawayReservationId"); if (a !== undefined && a !== id && a !== String(id)) return false; }
  if (!posInt(od(r, "listingMapId")) || !Number.isSafeInteger(od(r, "channelId"))) return false;
  const a = od(r, "arrivalDate"); const d = od(r, "departureDate");
  if (!realDate(a) || !realDate(d) || !(d > a)) return false;
  if (amountToMinor(od(r, "totalPrice")) === null) return false;
  const c = od(r, "currency"); if (typeof c !== "string" || !/^[A-Za-z]{3}$/.test(c)) return false;
  if (!RESERVATION_STATUSES.includes(od(r, "status"))) return false;
  if (has(r, "customFieldValues")) { const cf = od(r, "customFieldValues"); if (cf !== undefined && cf !== null && !isArr(cf)) return false; }
  return true;
}
const aliasProtected = (r) => protectedId(od(r, "id")) || (has(r, "hostawayReservationId") && protectedId(od(r, "hostawayReservationId")));

function checkH1(reply, plan) {
  const e = envelope(reply); if (e.fail) return e.fail;
  const r = e.result; if (!isPlain(r)) return STP("PROBE_SHAPE_MISMATCH");
  if (od(r, "id") !== plan.hostaway.listingId || od(r, "currencyCode") !== "USD") return STP("PROBE_LISTING_MISMATCH");
  return OKR({ idMatches: true, currencyUSD: true });
}
function checkH2(reply, plan) {
  const e = envelope(reply); if (e.fail) return e.fail;
  const days = e.result; const n = arrLen(days);
  if (!isArr(days) || n < 0 || n > 62) return STP("PROBE_SHAPE_MISMATCH");
  const { startDate: S, endDate: E } = plan.hostaway.calendar; const seen = new Set();
  for (let i = 0; i < n; i++) {
    const d = od(days, i); if (!isPlain(d)) return STP("PROBE_SHAPE_MISMATCH");
    const date = od(d, "date"); if (!realDate(date)) return STP("PROBE_SHAPE_MISMATCH");
    if (date < S || date > E) return STP("PROBE_FOREIGN_ROW");
    if (seen.has(date)) return STP("PROBE_SHAPE_MISMATCH"); seen.add(date);
    if (![0, 1].includes(od(d, "isAvailable")) || typeof od(d, "status") !== "string") return STP("PROBE_SHAPE_MISMATCH");
    for (const k of ["minimumStay", "maximumStay"]) if (has(d, k) && !(Number.isSafeInteger(od(d, k)) && od(d, k) >= 0)) return STP("PROBE_SHAPE_MISMATCH");
  }
  const expected = dayIndex(E) - dayIndex(S) + 1;
  const ev = { dayCount: n, inWindow: true, complete: n === expected };
  return n === expected ? OKR(ev) : INC("PROBE_INCOMPLETE", ev);
}
function checkH3(reply, plan) {
  const e = envelope(reply); if (e.fail) return e.fail;
  const rows = e.result; const n = arrLen(rows);
  if (!isArr(rows) || n < 0 || n > 100) return STP("PROBE_SHAPE_MISMATCH");
  for (let i = 0; i < n; i++) if (aliasProtected(od(rows, i))) return STP("PROBE_PROTECTED_SEEN");
  const L = plan.hostaway.listingId; const D = plan.hostaway.lookup.arrivalDate;
  for (let i = 0; i < n; i++) { const r = od(rows, i); if (!isPlain(r) || od(r, "listingMapId") !== L || od(r, "arrivalDate") !== D || od(r, "channelId") !== 2000) return STP("PROBE_FOREIGN_ROW"); }
  const ids = new Set();
  for (let i = 0; i < n; i++) { const r = od(rows, i); if (!reservationTypesOk(r)) return STP("PROBE_SHAPE_MISMATCH"); const id = od(r, "id"); if (ids.has(id)) return STP("PROBE_SHAPE_MISMATCH"); ids.add(id); }
  const ev = { rowCount: n, allScoped: true, typesOk: true, pageFull: n === 100 };
  return n === 100 ? INC("PROBE_PAGE_FULL", ev) : OKR(ev);
}
function checkH4(reply, plan) {
  const e = envelope(reply); if (e.fail) return e.fail;
  const r = e.result; if (!isPlain(r)) return STP("PROBE_SHAPE_MISMATCH");
  if (aliasProtected(r)) return STP("PROBE_PROTECTED_SEEN");
  const s = plan.hostaway.sample; const id = od(r, "id");
  if (id !== Number(s.reservationId) || od(r, "listingMapId") !== s.listingId) return STP("PROBE_RESERVATION_MISMATCH");
  if (!reservationTypesOk(r)) return STP("PROBE_SHAPE_MISMATCH");
  return OKR({ idMatches: true, listingMatches: true, typesOk: true, status: od(r, "status") });
}
const ROW_STRING_FIELDS = ["type", "title", "currency", "status", "paymentProvider", "paymentMethod"];   // = offline-charge-proof.js:238 (private; source-text asserted)
/** charge list for `scope` = { reservationId, listingId }; returns the check result + a PRIVATE ephemeral charge-id set (never output) */
function checkCharges(reply, scope) {
  const e = envelope(reply); if (e.fail) return { r: e.fail, ids: null, status: e.status };
  const j = e.json; const rows = e.result; const n = arrLen(rows);
  if (!isArr(rows) || n < 0) return { r: STP("PROBE_SHAPE_MISMATCH"), ids: null, status: e.status };
  const count = od(j, "count");
  if (!Number.isSafeInteger(count) || count < 0 || count > 500 || n !== count) return { r: STP("PROBE_SHAPE_MISMATCH"), ids: null, status: e.status };
  let more = false;
  if (has(j, "hasMore")) { const v = od(j, "hasMore"); if (typeof v !== "boolean") return { r: STP("PROBE_SHAPE_MISMATCH"), ids: null, status: e.status }; more = more || v; }
  if (has(j, "offset")) { const v = od(j, "offset"); if (!(v === null || (Number.isSafeInteger(v) && v >= 0))) return { r: STP("PROBE_SHAPE_MISMATCH"), ids: null, status: e.status }; more = more || v !== null; }
  if (has(j, "total")) { const v = od(j, "total"); if (!Number.isSafeInteger(v) || v < count) return { r: STP("PROBE_SHAPE_MISMATCH"), ids: null, status: e.status }; more = more || v > count; }
  for (let i = 0; i < n; i++) { const row = od(rows, i); if (isObj(row) && protectedId(od(row, "reservationId"))) return { r: STP("PROBE_PROTECTED_SEEN"), ids: null, status: e.status }; }
  for (let i = 0; i < n; i++) { const row = od(rows, i); if (!isPlain(row) || canonicalId(od(row, "reservationId")) !== scope.reservationId || od(row, "listingMapId") !== scope.listingId) return { r: STP("PROBE_FOREIGN_ROW"), ids: null, status: e.status }; }
  const ids = new Set();
  for (let i = 0; i < n; i++) {
    const row = od(rows, i); const cid = canonicalId(od(row, "id"));
    if (cid === null || ids.has(cid)) return { r: STP("PROBE_SHAPE_MISMATCH"), ids: null, status: e.status };
    ids.add(cid);
    for (const k of ROW_STRING_FIELDS) if (typeof od(row, k) !== "string") return { r: STP("PROBE_SHAPE_MISMATCH"), ids: null, status: e.status };
    const t = od(row, "type"); const amt = od(row, "amount");
    if (!CHARGE_TYPES.includes(t) || typeof amt !== "number" || !Number.isFinite(amt)) return { r: STP("PROBE_SHAPE_MISMATCH"), ids: null, status: e.status };
    if (t === "refund" ? !(amt <= 0 && amountToMinor(-amt) !== null) : amountToMinor(amt) === null) return { r: STP("PROBE_SHAPE_MISMATCH"), ids: null, status: e.status };
  }
  const complete = !more && count < 500;
  const ev = { rowCount: n, allRowsMatch: true, typesOk: true, complete };
  if (!complete) return { r: INC("PROBE_LIMIT_REACHED", ev), ids: null, status: e.status };
  if (n === 0) return { r: INC("PROBE_EMPTY_SAMPLE", ev), ids: null, status: e.status };
  return { r: OKR(ev), ids, status: e.status };
}
function checkS1(reply, plan) {
  if (!isPlain(reply) || od(reply, "object") !== "account" || od(reply, "id") !== plan.stripe.accountId) return STP("PROBE_ACCOUNT_MISMATCH");
  return OKR({ accountIdMatches: true });
}
const nni = (v) => Number.isSafeInteger(v) && v >= 0;
const cur = (v) => typeof v === "string" && /^[a-z]{3}$/.test(v);
function checkS2(reply, plan) {
  const PI = plan.stripe.paymentIntentId;
  if (!isPlain(reply) || od(reply, "object") !== "payment_intent" || od(reply, "id") !== PI) return STP("PROBE_SHAPE_MISMATCH");
  if (od(reply, "livemode") !== false) return STP("PROBE_LIVEMODE_REFUSED");
  const status = od(reply, "status");
  if (!PI_STATUSES.includes(status) || typeof od(reply, "capture_method") !== "string" || !nni(od(reply, "amount")) || !nni(od(reply, "amount_capturable"))
      || !nni(od(reply, "amount_received")) || !cur(od(reply, "currency")) || !isPlain(od(reply, "metadata"))) return STP("PROBE_SHAPE_MISMATCH");
  if (!has(reply, "latest_charge")) return STP("PROBE_SHAPE_MISMATCH");
  const lc = od(reply, "latest_charge");
  if (lc === null) return INC("PROBE_CHARGE_ABSENT", { status, livemode: false, latestCharge: "ABSENT", proofFieldsTyped: false });
  if (!isPlain(lc)) return STP("PROBE_SHAPE_MISMATCH");                // string id (expand not applied) or any other type
  if (od(lc, "livemode") !== false) return STP("PROBE_LIVEMODE_REFUSED");
  const pi = od(lc, "payment_intent"); const piOk = pi === PI || (isPlain(pi) && od(pi, "id") === PI);
  const id = od(lc, "id");
  if (od(lc, "object") !== "charge" || typeof id !== "string" || !/^ch_[A-Za-z0-9_]+$/.test(id) || !piOk || typeof od(lc, "status") !== "string"
      || typeof od(lc, "paid") !== "boolean" || typeof od(lc, "captured") !== "boolean" || !nni(od(lc, "amount")) || !nni(od(lc, "amount_captured"))
      || !nni(od(lc, "amount_refunded")) || !cur(od(lc, "currency"))) return STP("PROBE_SHAPE_MISMATCH");
  // R-PC3 conditional proof-field rule: full coverage needs payment_method_details.card.capture_before as a positive int (the accepted
  // capture proof reads it). Absent / null pmd, a non-card method, a null card, or an absent / null capture_before → coverage INCOMPLETE
  // (TEST charge observed, proof fields NOT verified, B4 stays OPEN). A present-but-invalid shape (non-object pmd / card, zero, negative,
  // non-integer, string, accessor) → STOP. No assumption that every legitimate charge is a manual card charge.
  const incomplete = () => INC("PROBE_PROOF_FIELDS_INCOMPLETE", { status, livemode: false, latestCharge: "VERIFIED_TEST_CHARGE", proofFieldsTyped: false });
  if (!has(lc, "payment_method_details")) return incomplete();
  const pmd = od(lc, "payment_method_details");
  if (pmd === null) return incomplete();
  if (!isPlain(pmd)) return STP("PROBE_SHAPE_MISMATCH");
  if (!has(pmd, "card")) return incomplete();
  const card = od(pmd, "card");
  if (card === null) return incomplete();
  if (!isPlain(card)) return STP("PROBE_SHAPE_MISMATCH");
  if (!has(card, "capture_before")) return incomplete();
  const cb = od(card, "capture_before");
  if (cb === null) return incomplete();
  if (!posInt(cb)) return STP("PROBE_SHAPE_MISMATCH");
  return OKR({ status, livemode: false, latestCharge: "VERIFIED_TEST_CHARGE", proofFieldsTyped: true });
}
/** exact T input per probe, built ONLY from the frozen plan (§1) */
function requestFor(id, plan) {
  const h = plan.hostaway; const s = plan.stripe;
  switch (id) {
    case "P-H1": return { provider: "hostaway", req: { method: "GET", path: `/v1/listings/${h.listingId}`, query: {} } };
    case "P-H2": return { provider: "hostaway", req: { method: "GET", path: `/v1/listings/${h.listingId}/calendar`, query: { startDate: h.calendar.startDate, endDate: h.calendar.endDate } } };
    case "P-H3": return { provider: "hostaway", req: { method: "GET", path: "/v1/reservations", query: { listingId: h.listingId, channelId: 2000, arrivalStartDate: h.lookup.arrivalDate,
      arrivalEndDate: h.lookup.arrivalDate, limit: 100, includeResources: 1 } } };
    case "P-H4": return { provider: "hostaway", req: { method: "GET", path: `/v1/reservations/${h.sample.reservationId}`, query: {} } };
    case "P-H5": return { provider: "hostaway", req: { method: "GET", path: "/v1/guestPayments/charges", query: { reservationId: h.sample.reservationId, limit: 500 } } };
    case "P-H6": return { provider: "hostaway", req: { method: "GET", path: "/v1/guestPayments/charges", query: { reservationId: h.control.reservationId, limit: 500 } } };
    case "P-S1": return { provider: "stripe", req: { op: "accounts.retrieve" } };
    case "P-S2": return { provider: "stripe", req: { op: "paymentIntents.retrieve", id: s.paymentIntentId, params: { expand: ["latest_charge"] } } };
    default: return null;
  }
}
const deepFrozenCopy = (v) => deepFreeze(JSON.parse(JSON.stringify(v)));
const bucket = (ms) => (ms < 1000 ? "LT_1S" : ms < 5000 ? "LT_5S" : ms < 15000 ? "LT_15S" : "GE_15S");
/** rejection → T code via the own-data `code` only (no getter, message, stack or cause read) */
function tCode(e) { const c = od(e, "code"); return typeof c === "string" && T_ERROR_CODES.includes(c) ? c : null; }

// =================================================================================================================================
/**
 * runReadonlyProbes({ plan, hostaway?, stripe?, deps, signal? }) → frozen { ok:true, result, finalize } | frozen { ok:false, code }
 *   result: native Promise<deep-frozen summary> (never rejects); finalize(): the SAME native Promise<frozen { tail }> on every call.
 */
export function runReadonlyProbes(input) {
  let o;
  try {
    if (!isPlain(input)) return freeze({ ok: false, code: "RUN_SHAPE" });
    const d = getDescs(input); const ks = ownKeys(d);
    const allowed = ["deps", "hostaway", "plan", "signal", "stripe"];
    if (!ks.every((k) => typeof k === "string" && allowed.includes(k) && "value" in d[k]) || !("plan" in d) || !("deps" in d)) return freeze({ ok: false, code: "RUN_SHAPE" });
    o = Object.fromEntries(ks.map((k) => [k, d[k].value]));
  } catch { return freeze({ ok: false, code: "RUN_SHAPE" }); }
  const plan = o.plan;
  if (!isObj(plan) || !BRAND.has(plan)) return freeze({ ok: false, code: "PLAN_NOT_VALIDATED" });
  const needH = plan.probes.some((x) => x.startsWith("P-H")); const needS = plan.probes.some((x) => x.startsWith("P-S"));
  const sendOf = (t) => { if (!isPlain(t)) return null; try { const dd = getDescs(t); const ks = ownKeys(dd); if (ks.length !== 1 || ks[0] !== "send" || !("value" in dd.send) || !isFn(dd.send.value)) return null; return dd.send.value; } catch { return null; } };
  const hSend = o.hostaway === undefined ? null : sendOf(o.hostaway); const sSend = o.stripe === undefined ? null : sendOf(o.stripe);
  if ((o.hostaway !== undefined && hSend === null) || (o.stripe !== undefined && sSend === null) || needH !== (hSend !== null) || needS !== (sSend !== null)) return freeze({ ok: false, code: "RUN_TRANSPORT_INVALID" });
  let monotonic, arm;
  try {
    if (!isPlain(o.deps)) throw 0;
    const dd = getDescs(o.deps); if (ownKeys(dd).length !== 2 || !dd.monotonic || !("value" in dd.monotonic) || !dd.timers || !("value" in dd.timers)) throw 0;
    monotonic = dd.monotonic.value; const tm = dd.timers.value;
    if (!isFn(monotonic) || !isPlain(tm)) throw 0;
    const td = getDescs(tm); if (ownKeys(td).length !== 1 || !td.arm || !("value" in td.arm) || !isFn(td.arm.value)) throw 0;
    arm = td.arm.value;
  } catch { return freeze({ ok: false, code: "RUN_DEPS_INVALID" }); }
  const signal = o.signal;
  if (signal !== undefined && nativeAborted(signal) === null) return freeze({ ok: false, code: "RUN_SIGNAL_INVALID" });

  // ---------------- shared run state ----------------
  let lastNow = -Infinity;
  /** finite non-decreasing monotonic; null on throw / invalid / backwards (dependency failure) */
  const now = () => { let t; try { t = apply(monotonic, undefined, []); } catch { return null; } if (typeof t !== "number" || !Number.isFinite(t) || t < lastNow) return null; lastNow = t; return t; };
  /** timer cleanup report (R-PC2): counts only; never raw errors */
  const cleanup = { cancelFailed: 0, uncancellable: 0 };
  const cleanupReport = () => freeze({ cancelFailed: cleanup.cancelFailed, uncancellable: cleanup.uncancellable });
  /** arm(ms) → { cancelOnce } with the handle promise ALREADY observed, or null on any fault. The cleanup capability is captured FIRST
   *  (own DATA `cancel`, non-proxy function — never a getter), so a handle rejected for any other reason is still cancelled exactly once.
   *  Exact shape: plain object, own keys exactly { promise, cancel }, both data properties, promise an unpatched native promise.
   *  cancelOnce() → true, or false when the cancel threw (counted in cleanup.cancelFailed; the caller decides the STOP). */
  const armTimer = (ms, onFire, onFault) => {
    let h; try { h = apply(arm, undefined, [ms]); } catch { return null; }
    let cancelFn = null;
    if (isObj(h)) { try { const cd = getDesc(h, "cancel"); if (cd && "value" in cd && isFn(cd.value)) cancelFn = cd.value; } catch { cancelFn = null; } }
    let cancelled = false;
    const cancelOnce = () => {
      if (cancelled) return true; cancelled = true;
      if (cancelFn === null) { cleanup.uncancellable += 1; return true; }
      try { apply(cancelFn, undefined, []); return true; } catch { cleanup.cancelFailed += 1; return false; }
    };
    let promise; let ok = false;
    try {
      if (isPlain(h) && cancelFn !== null) {
        const d = getDescs(h); const ks = ownKeys(d);
        ok = ks.length === 2 && typeof ks[0] === "string" && typeof ks[1] === "string" && "promise" in d && "cancel" in d && "value" in d.promise;
        if (ok) promise = d.promise.value;
      }
    } catch { ok = false; }
    if (!ok || !observe(promise, onFire, onFault)) { cancelOnce(); return null; }   // rejected handle: its validated cleanup runs once
    return { cancelOnce };
  };
  const callerAborted = () => (signal === undefined ? false : nativeAborted(signal) !== false);
  let wake = null; const kick = () => { const w = wake; wake = null; if (w) w(); };
  let callerListening = false;
  const onCallerAbort = () => kick();
  if (signal !== undefined) { try { apply(ET_ADD, signal, ["abort", onCallerAbort, { once: true }]); callerListening = true; } catch { /* checked natively at every boundary anyway */ } }
  const tail = { state: "NONE", pending: false, settle: null };

  async function drive() {
    const probes = []; let stop = null; let stopProbe = null; const inconclusive = new Set(); let h5Ids = null; const statusOf = {};
    const t0 = now();
    if (t0 === null) { stop = "PROBE_DEPENDENCY_FAILED"; }
    const runEnd = t0 === null ? 0 : t0 + plan.limits.runMs;
    const prereq = { "P-H5": ["P-H4"], "P-H6": ["P-H5"], "P-S2": ["P-S1"] };
    for (const id of plan.probes) {
      if (stop !== null) { probes.push({ id, outcome: "NOT_RUN", code: "AFTER_STOP", httpStatus: null, transportCode: null, elapsed: null, evidence: null }); continue; }
      if ((prereq[id] || []).some((x) => inconclusive.has(x))) { inconclusive.add(id); probes.push({ id, outcome: "NOT_RUN", code: "PREREQ_INCONCLUSIVE", httpStatus: null, transportCode: null, elapsed: null, evidence: null }); continue; }
      const rec = (outcome, code, extra = {}) => { const p = { id, outcome, code, httpStatus: null, transportCode: null, elapsed: null, evidence: null, ...extra }; probes.push(p); if (outcome === "STOP") { stop = code; stopProbe = id; } if (outcome === "INCONCLUSIVE") inconclusive.add(id); return p; };
      // (1) caller abort, (2) budget — absolute deadlines; preparation time consumes budget
      if (callerAborted()) { rec("STOP", "PROBE_CANCELLED"); continue; }
      const n0 = now(); if (n0 === null) { rec("STOP", "PROBE_DEPENDENCY_FAILED"); continue; }
      const remaining = runEnd - n0; const minStart = Math.max(1000, plan.limits.perProbeMs / 10);
      if (remaining < minStart) { rec("STOP", "PROBE_BUDGET_EXHAUSTED"); continue; }
      const probeBound = plan.limits.perProbeMs <= remaining;             // true: per-probe deadline governs; false: run deadline governs
      const deadline = n0 + Math.min(plan.limits.perProbeMs, remaining);
      const deadlineCode = probeBound ? "PROBE_TIMEOUT" : "PROBE_BUDGET_EXHAUSTED";
      const built = requestFor(id, plan); const req = deepFrozenCopy(built.req); const send = built.provider === "hostaway" ? hSend : sSend;
      // (3) observe timer + abort BEFORE invocation
      let fired = false; let timerFault = false;
      const handle = armTimer(deadline - n0, () => { fired = true; kick(); }, () => { timerFault = true; kick(); });
      if (handle === null) { rec("STOP", "PROBE_DEPENDENCY_FAILED"); continue; }
      // (4) recheck caller abort AND absolute deadline immediately before the single send, after every preparation boundary
      if (callerAborted()) { handle.cancelOnce(); rec("STOP", "PROBE_CANCELLED"); continue; }
      const n1 = now(); if (n1 === null) { handle.cancelOnce(); rec("STOP", "PROBE_DEPENDENCY_FAILED"); continue; }
      if (n1 >= deadline) { handle.cancelOnce(); rec("STOP", deadlineCode); continue; }
      if (timerFault || fired) { handle.cancelOnce(); rec("STOP", "PROBE_DEPENDENCY_FAILED"); continue; }   // fired / faulted before its deadline
      const ac = new NativeAbortController(); const sig = apply(AC_SIGNAL, ac, []);
      const abortOwn = () => { try { apply(AC_ABORT, ac, []); } catch { /* contained */ } };
      // R-PC1 final handoff: the last injected call above (monotonic) may have aborted the caller; native re-check (captured intrinsic,
      // no caller getter, no further injected call) IMMEDIATELY before dispatch
      if (callerAborted()) { handle.cancelOnce(); rec("STOP", "PROBE_CANCELLED"); continue; }
      // (5) exactly one send
      let p; let settled = null;
      try { p = apply(send, undefined, [req, freeze({ signal: sig })]); }
      catch { handle.cancelOnce(); rec("STOP", "PROBE_TRANSPORT_FAILED"); continue; }
      const observed = observe(p, (v) => { if (settled === null) { settled = { kind: "fulfilled", v }; kick(); } else tailSettle("LATE_FULFILLED"); },
        (e) => { if (settled === null) { settled = { kind: "rejected", e }; kick(); } else tailSettle("LATE_REJECTED"); });
      if (!observed) { handle.cancelOnce(); abortOwn(); tail.state = "UNOBSERVABLE"; rec("STOP", "PROBE_TRANSPORT_FAILED"); continue; }   // caller-owned rejection residual
      // (6) race: first cause wins, recorded once
      let cause = null;
      for (;;) {
        if (settled !== null) {
          const ns = now();
          if (ns === null) cause = "DEP"; else if (ns >= deadline) cause = "DEADLINE"; else cause = "SETTLED";   // settlement at / after the deadline is a timeout
          break;
        }
        if (callerAborted()) { cause = "CANCEL"; break; }
        if (timerFault) { cause = "DEP"; break; }
        if (fired) { const nf = now(); if (nf === null) cause = "DEP"; else if (nf >= deadline) cause = "DEADLINE"; else cause = "DEP"; break; }   // early fire: fail closed, no re-arm
        await new NativePromise((r) => { wake = r; });
      }
      const elapsed = bucket(Math.max(0, (lastNow === -Infinity ? n1 : lastNow) - n1));
      const cancelOk = fired ? true : handle.cancelOnce();               // a fired timer is spent: never cancelled; otherwise exactly once
      if (cause === "SETTLED" && !cancelOk) {                              // R-PC2: a cancel fault after a settled reply is a dependency STOP
        rec("STOP", "PROBE_DEPENDENCY_FAILED", { elapsed });                 // the reply is not evaluated; no evidence retained
        continue;
      }
      if (cause !== "SETTLED") {
        abortOwn();
        if (settled === null) { tail.pending = true; settled = { kind: "late" }; }   // later settlement is observed by kind only
        rec("STOP", cause === "CANCEL" ? "PROBE_CANCELLED" : cause === "DEADLINE" ? deadlineCode : "PROBE_DEPENDENCY_FAILED", { elapsed });
        continue;
      }
      if (settled.kind === "rejected") {
        const tc = tCode(settled.e);
        const code = tc === "ACCOUNT_MISMATCH" ? "PROBE_ACCOUNT_MISMATCH" : tc === "LIVEMODE_REFUSED" ? "PROBE_LIVEMODE_REFUSED"
          : tc === "ABORTED" || tc === "ABORTED_IN_FLIGHT" ? "PROBE_CANCELLED" : "PROBE_TRANSPORT_FAILED";
        rec("STOP", code, { transportCode: tc, elapsed });
        continue;
      }
      // (7) reply checks; any unexpected fault inside a check is a code-only shape mismatch
      let r; let httpStatus = null;
      try {
        const v = settled.v;
        if (id === "P-H5" || id === "P-H6") {
          const scope = id === "P-H5" ? plan.hostaway.sample : plan.hostaway.control;
          const c = checkCharges(v, scope); r = c.r; httpStatus = c.status;
          if (id === "P-H5") h5Ids = c.ids;                                   // PRIVATE ephemeral set: compared once, never output
          else if (c.r.outcome === "OK") {
            let overlap = h5Ids === null; if (!overlap) for (const x of c.ids) if (h5Ids.has(x)) { overlap = true; break; }
            if (overlap) r = INC("PROBE_CONTROL_OVERLAP", c.r.evidence);
            h5Ids = null;
          }
        } else {
          if (id.startsWith("P-H")) { const st = od(v, "httpStatus"); httpStatus = Number.isSafeInteger(st) ? st : null; }
          r = ({ "P-H1": checkH1, "P-H2": checkH2, "P-H3": checkH3, "P-H4": checkH4, "P-S1": checkS1, "P-S2": checkS2 })[id](v, plan);
        }
      } catch { r = STP("PROBE_SHAPE_MISMATCH"); }
      statusOf[id] = r;
      rec(r.outcome, r.code, { httpStatus: id.startsWith("P-H") ? httpStatus : null, elapsed, evidence: r.evidence });
    }
    h5Ids = null;
    if (callerListening) { callerListening = false; try { apply(ET_REMOVE, signal, ["abort", onCallerAbort]); } catch { /* contained */ } }
    // ---------------- gates (scoped observations only) ----------------
    const pr = Object.fromEntries(probes.map((x) => [x.id, x]));
    const okp = (x) => pr[x] && pr[x].outcome === "OK";
    const shape = (x) => (!pr[x] ? "NOT_PROBED" : okp(x) ? "OBSERVED" : pr[x].outcome === "INCONCLUSIVE" ? "INCONCLUSIVE" : "OPEN");
    const h5 = pr["P-H5"];
    const gates = {
      G_AUTH_charges_read: !h5 ? "NOT_PROBED" : h5.httpStatus === 200 ? "OBSERVED" : "OPEN",
      G_FILTER: !h5 ? "NOT_PROBED" : okp("P-H5") && okp("P-H6") ? "OBSERVED" : okp("P-H5") && !pr["P-H6"] ? "SINGLE_SAMPLE" : "OPEN",
      G_SHAPE_listing: shape("P-H1"), G_SHAPE_calendar: shape("P-H2"), G_SHAPE_lookup: shape("P-H3"), G_SHAPE_reservation: shape("P-H4"), G_SHAPE_charges: shape("P-H5"),
      B4_pi_read: !pr["P-S2"] ? "NOT_PROBED" : okp("P-S2") ? "OBSERVED" : "OPEN",
      TEST_mode_pi: !pr["P-S2"] ? "NOT_PROBED" : okp("P-S2") || (pr["P-S2"].code === "PROBE_PROOF_FIELDS_INCOMPLETE") ? "OBSERVED" : "OPEN"   // TEST mode ≠ full proof coverage
    };
    return deepFreeze({ schema: RESULT_SCHEMA, planHash: plan.planHash, metadata: { ...plan.metadata }, outcome: stop === null ? "COMPLETED" : "STOPPED",
      stopCode: stop, stopProbe, probes, gates, timerCleanup: cleanupReport() });
  }
  function tailSettle(kind) { if (tail.state === "NONE" || tail.state === "UNSETTLED") { tail.state = kind; } tail.pending = false; if (tail.settle) { const s = tail.settle; tail.settle = null; s(); } }
  // result: never rejects (an internal fault becomes a fixed dependency failure summary)
  const result = new NativePromise((resolve) => {
    let inner; try { inner = drive(); } catch { inner = null; }
    const fallback = () => resolve(deepFreeze({ schema: RESULT_SCHEMA, planHash: plan.planHash, metadata: { ...plan.metadata }, outcome: "STOPPED", stopCode: "PROBE_DEPENDENCY_FAILED",
      stopProbe: null, probes: plan.probes.map((id) => ({ id, outcome: "NOT_RUN", code: "AFTER_STOP", httpStatus: null, transportCode: null, elapsed: null, evidence: null })),
      gates: { G_AUTH_charges_read: "OPEN", G_FILTER: "OPEN", G_SHAPE_listing: "OPEN", G_SHAPE_calendar: "OPEN", G_SHAPE_lookup: "OPEN", G_SHAPE_reservation: "OPEN", G_SHAPE_charges: "OPEN", B4_pi_read: "OPEN", TEST_mode_pi: "OPEN" }, timerCleanup: cleanupReport() }));
    if (!inner) { fallback(); return; }
    apply(P_THEN, inner, [resolve, fallback]);
  });
  let finalP = null;
  /** idempotent: the SAME native promise on every call; never dispatches a request or mutates the summary */
  const finalize = () => {
    if (finalP) return finalP;
    finalP = new NativePromise((resolve) => {
      apply(P_THEN, result, [() => {
        const done = (state) => resolve(freeze({ tail: state, timerCleanup: cleanupReport() }));   // a tail cancel fault is counted, tail kind unchanged
        if (tail.state === "UNOBSERVABLE") { done("UNOBSERVABLE"); return; }
        if (!tail.pending) { done(tail.state); return; }                 // NONE, or a late settlement already observed
        if (plan.limits.tailMs === 0) { done("UNSETTLED"); return; }      // tailMs = 0: report immediately, no tail timer
        const n0 = now();
        let th = null;
        tail.settle = () => { if (th) th.cancelOnce(); done(tail.state); };
        const onTail = () => { if (!tail.pending) return; tail.settle = null; done("UNSETTLED"); };   // tail timer fire, early fire or timer fault: UNSETTLED, never re-armed
        th = n0 === null ? null : armTimer(plan.limits.tailMs, onTail, onTail);
        if (th === null) { tail.settle = null; done("UNSETTLED"); }
      }, () => resolve(freeze({ tail: "UNSETTLED", timerCleanup: cleanupReport() }))]);
    });
    return finalP;
  };
  return freeze({ ok: true, result, finalize });
}
