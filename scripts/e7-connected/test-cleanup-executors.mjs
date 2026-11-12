// scripts/e7-connected/test-cleanup-executors.mjs — E7 captured-TEST cleanup EXECUTOR PHASE (OFFLINE; injected transports only). ISOLATED: the
// accepted executor-adapters.mjs (phases reservation / capture / cleanup / recording) is NOT modified and still exposes no refund key anywhere.
// Contract: claude/e7-capture-test-cleanup-contract.md rev4 §7 (phase `test-cleanup`: retrieveAccount, retrievePaymentIntent, retrieveReservation,
// lookupPage, cancelReservation, createRefund(pi, { amount, metadata }, { idempotencyKey }), retrieveRefund(re_id), listRefunds(pi)).
//
// Pure factory: each executor call becomes exactly ONE call on an INJECTED transport, validated against an IMMUTABLE per-factory binding first:
//   * Hostaway: hostaway.send(request, { signal }) -> Promise<{ httpStatus, json }>; request = frozen { method, path ('/v1/...'), query, body? }
//     (GET /reservations page, GET /reservations/{bound id}, ONE PUT /reservations/{bound id}/statuses/cancelled { cancelledBy: "host" })
//   * Stripe:   stripe.send(call, { signal })      -> Promise<raw Stripe object>; call = frozen { op, id?, params?, idempotencyKey? }
//     (accounts.retrieve; paymentIntents.retrieve expand latest_charge; refunds.create with EXACTLY payment_intent / amount / metadata{mv_refund_op,
//     mv_refund_key} and the bound Idempotency-Key; refunds.retrieve of a re_ id; refunds.list for the bound PI, limit 100). NO capture, void, create,
//     offline charge, notification or any other operation is buildable here.
// Anything else is refused with ZERO transport calls (ExecutorRefusal, code only); the one invocation's failure is a code-only transport failure.
// LABELLED COPY: the hostile-input discipline below (own-data snapshots, native signal brand check, one invocation outside every try) mirrors
// executor-adapters.mjs (R-G1 / R-A2) — duplicated on purpose so the accepted module stays byte-identical; parity is asserted by the tests.
import { types as nodeTypes } from "node:util";
import { PROTECTED_HOSTAWAY_RESERVATION_IDS, CANCEL_BODY } from "../../lib/checkout/compensation-proof.js";
import { REFUND_METADATA_KEYS } from "../../lib/checkout/test-cleanup-proof.js";

export const TEST_CLEANUP_EXECUTORS_VERSION = "e7-test-cleanup-executors-v1";
export const PHASE = "test-cleanup";
export const DIRECT_CHANNEL_ID = 2000;            // asserted equal to executor-adapters.mjs by the tests
export const LOOKUP_PAGE_LIMIT = 100;
export const REFUND_LIST_LIMIT = 100;             // = cleanup-worker TEST_CLEANUP_WORKER_LIMITS.listLimit (asserted by the tests)
export const TEST_CLEANUP_LISTING_ID = 606998;    // the ONE allowed listing (lib/booking-db/test-cleanup.js TEST_CLEANUP_LISTINGS; asserted by the tests)
export const PHASE_KEYS = Object.freeze(["retrieveAccount", "retrievePaymentIntent", "retrieveReservation", "lookupPage", "cancelReservation", "createRefund", "retrieveRefund", "listRefunds"]);
export const BINDING_KEYS = Object.freeze(["accountId", "amountMinor", "arrivalDate", "chargeId", "departureDate", "listingId", "paymentIntentId", "ref", "refundIdempotencyKey", "refundOpId", "reservationId"]);
export class ExecutorRefusal extends Error { constructor(code) { super("EXECUTOR_REFUSED"); this.name = "ExecutorRefusal"; this.code = code; Object.freeze(this); } }
export class ExecutorTransportFailure extends Error { constructor(code) { super("EXECUTOR_TRANSPORT_FAILED"); this.name = "ExecutorTransportFailure"; this.code = code; Object.freeze(this); } }

const RID_RE = /^[1-9][0-9]{0,15}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ACCT_RE = /^acct_[A-Za-z0-9]{1,64}$/;
const PI_RE = /^pi_[A-Za-z0-9_]{1,250}$/;
const CHARGE_RE = /^(ch|py)_[A-Za-z0-9_]{1,200}$/;
const REFUND_RE = /^re_[A-Za-z0-9_]{1,200}$/;
const REF_RE = /^MV-[A-Z0-9]{6,10}$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const isPosInt = (v) => Number.isSafeInteger(v) && v > 0;
function isRealDate(s) {
  if (typeof s !== "string") return false;
  const m = DATE_RE.exec(s); if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 2000 || y > 2100) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

// ---- getter-free snapshots (labelled copy of executor-adapters.mjs R-G1) ----------------------------------------------------------
const BAD = Symbol("bad");
function plainProps(o) {
  if (o === null || typeof o !== "object" || Array.isArray(o)) return BAD;
  const proto = Object.getPrototypeOf(o);
  if (proto !== Object.prototype && proto !== null) return BAD;
  const d = Object.getOwnPropertyDescriptors(o);
  const out = Object.create(null);
  for (const k of Reflect.ownKeys(d)) {
    if (typeof k !== "string" || k === "__proto__" || !("value" in d[k]) || d[k].enumerable !== true) return BAD;
    out[k] = d[k].value;
  }
  return out;
}
function denseArray(a, max) {
  if (!Array.isArray(a) || Object.getPrototypeOf(a) !== Array.prototype) return BAD;
  const d = Object.getOwnPropertyDescriptors(a);
  const keys = Reflect.ownKeys(d); const len = d.length;
  if (!len || !("value" in len) || !Number.isSafeInteger(len.value) || len.value > max || keys.length !== len.value + 1) return BAD;
  const out = [];
  for (let i = 0; i < len.value; i++) { const di = d[String(i)]; if (!di || !("value" in di) || di.enumerable !== true) return BAD; out.push(di.value); }
  for (const k of keys) if (k !== "length" && !(typeof k === "string" && /^(0|[1-9][0-9]*)$/.test(k) && Number(k) < len.value)) return BAD;
  return out;
}
function snap(v, depth = 6) {
  if (v === null || typeof v === "string" || typeof v === "boolean") return v;
  if (typeof v === "number") return Number.isFinite(v) ? v : BAD;
  if (typeof v !== "object" || depth <= 0) return BAD;
  if (Array.isArray(v)) {
    const a = denseArray(v, 1000); if (a === BAD) return BAD;
    const out = []; for (const x of a) { const s = snap(x, depth - 1); if (s === BAD) return BAD; out.push(s); }
    return Object.freeze(out);
  }
  const p = plainProps(v); if (p === BAD) return BAD;
  const out = Object.create(null);
  for (const k of Object.keys(p)) { const s = snap(p[k], depth - 1); if (s === BAD) return BAD; out[k] = s; }
  return Object.freeze(out);
}
const keysEq = (o, keys) => { const k = Object.keys(o).sort(); const w = [...keys].sort(); return k.length === w.length && k.every((x, i) => x === w[i]); };
const refuse = (code) => { throw new ExecutorRefusal(code); };
function argSnap(v) { let s; try { s = snap(v); } catch { s = BAD; } if (s === BAD) refuse("ARGUMENT_INVALID"); return s; }
// R-A2: native branded signal inspection (intrinsic getter captured at load; proxies refused first)
const NATIVE_ABORTED = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted").get;
function nativeAborted(sig) {
  if (sig === null || typeof sig !== "object") refuse("SIGNAL_REQUIRED");
  if (nodeTypes.isProxy(sig)) refuse("SIGNAL_REQUIRED");
  let a;
  try { a = Reflect.apply(NATIVE_ABORTED, sig, []); } catch { refuse("SIGNAL_REQUIRED"); }
  if (typeof a !== "boolean") refuse("SIGNAL_REQUIRED");
  return a;
}
function callOptions(o, allowed) {
  let p; try { p = plainProps(o); } catch { p = BAD; }
  if (p === BAD) refuse("OPTIONS_INVALID");
  for (const k of Object.keys(p)) if (!allowed.includes(k)) refuse("OPTIONS_INVALID");
  if (nativeAborted(p.signal)) refuse("ABORTED");
  return p;
}
function stillLive(signal) { if (nativeAborted(signal)) refuse("ABORTED"); }
const protectedId = (id) => PROTECTED_HOSTAWAY_RESERVATION_IDS.includes(String(id));

// ---- binding (immutable per factory) --------------------------------------------------------------------------------------------
function validateBinding(raw) {
  const b = snap(raw);
  if (b === BAD || !keysEq(b, BINDING_KEYS)) return null;
  if (b.listingId !== TEST_CLEANUP_LISTING_ID) return null;                                                 // the ONE allowed listing
  if (typeof b.reservationId !== "string" || !RID_RE.test(b.reservationId) || protectedId(b.reservationId)) return null;
  if (!isRealDate(b.arrivalDate) || !isRealDate(b.departureDate) || !(b.arrivalDate < b.departureDate)) return null;
  if (typeof b.ref !== "string" || !REF_RE.test(b.ref)) return null;
  if (typeof b.accountId !== "string" || !ACCT_RE.test(b.accountId) || typeof b.paymentIntentId !== "string" || !PI_RE.test(b.paymentIntentId)) return null;
  if (typeof b.chargeId !== "string" || !CHARGE_RE.test(b.chargeId) || !isPosInt(b.amountMinor)) return null;
  if (typeof b.refundOpId !== "string" || !UUID_RE.test(b.refundOpId)) return null;
  // the ONE refund key family (lib/checkout/intent-state.js refundKey): ref:<intent uuid>:1 — attempt 1 only
  if (typeof b.refundIdempotencyKey !== "string" || !/^ref:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:1$/.test(b.refundIdempotencyKey)) return null;
  return b;
}

// ---- the ONE invocation ------------------------------------------------------------------------------------------------------------
async function invokeHostaway(send, request, signal) {
  stillLive(signal);
  let reply;
  try { reply = await send(request, Object.freeze({ signal })); } catch { throw new ExecutorTransportFailure("TRANSPORT_FAILED"); }
  let env;
  try { env = plainProps(reply); } catch { env = BAD; }
  if (env === BAD || !keysEq(env, ["httpStatus", "json"]) || !Number.isSafeInteger(env.httpStatus) || env.httpStatus < 100 || env.httpStatus > 599) throw new ExecutorTransportFailure("TRANSPORT_REPLY_SHAPE");
  return env;
}
async function invokeStripe(send, call, signal) {
  stillLive(signal);
  try { return await send(call, Object.freeze({ signal })); } catch { throw new ExecutorTransportFailure("TRANSPORT_FAILED"); }
}
function hostawayRequest(method, path, query, body) {
  const r = { method, path: `/v1${path}`, query: Object.freeze({ ...query }) };
  if (body !== undefined) r.body = body;
  return Object.freeze(r);
}
function workerRequest(req, { method, paths, body }) {
  const r = argSnap(req);
  if (r === null || typeof r !== "object" || Array.isArray(r)) refuse("REQUEST_INVALID");
  if (!keysEq(r, body ? ["body", "method", "path", "query"] : ["method", "path", "query"])) refuse("REQUEST_SHAPE");
  if (r.method !== method) refuse("METHOD");
  if (typeof r.path !== "string" || !paths.includes(r.path)) refuse("PATH");
  if (r.query === null || typeof r.query !== "object" || Array.isArray(r.query)) refuse("QUERY");
  return r;
}
const both = (p) => [p, `/v1${p}`];

function hostawayKeys(b, send) {
  const k = {};
  k.lookupPage = async (req, opts) => {
    const o = callOptions(opts, ["signal"]);
    const r = workerRequest(req, { method: "GET", paths: both("/reservations") });
    const q = r.query; const qk = Object.keys(q).sort();
    const base = ["arrivalEndDate", "arrivalStartDate", "channelId", "includeResources", "limit", "listingId"];
    if (!(keysEq(q, base) || keysEq(q, [...base, "afterId"]))) refuse("QUERY");
    if (q.listingId !== b.listingId || q.channelId !== DIRECT_CHANNEL_ID || q.arrivalStartDate !== b.arrivalDate || q.arrivalEndDate !== b.arrivalDate
        || q.limit !== LOOKUP_PAGE_LIMIT || q.includeResources !== 1 || (qk.includes("afterId") && !isPosInt(q.afterId))) refuse("QUERY_SCOPE");
    return invokeHostaway(send, hostawayRequest("GET", "/reservations", q), o.signal);
  };
  k.retrieveReservation = async (req, opts) => {
    const o = callOptions(opts, ["signal"]);
    const r = workerRequest(req, { method: "GET", paths: both(`/reservations/${b.reservationId}`) });
    if (Object.keys(r.query).length !== 0) refuse("QUERY");
    if (protectedId(b.reservationId)) refuse("PROTECTED_RESERVATION_ID");
    return invokeHostaway(send, hostawayRequest("GET", `/reservations/${b.reservationId}`, {}), o.signal);
  };
  // ASSUMED / LIVE-UNVERIFIED endpoint (compensation-proof.js:421; executor-adapters.mjs:362): mapping only, never provider support
  k.cancelReservation = async (req, opts) => {
    const o = callOptions(opts, ["signal"]);
    const r = workerRequest(req, { method: "PUT", paths: both(`/reservations/${b.reservationId}/statuses/cancelled`), body: true });
    if (Object.keys(r.query).length !== 0) refuse("QUERY");
    const x = r.body;
    if (x === null || typeof x !== "object" || !keysEq(x, Object.keys(CANCEL_BODY)) || x.cancelledBy !== CANCEL_BODY.cancelledBy) refuse("BODY_SCOPE");
    if (protectedId(b.reservationId)) refuse("PROTECTED_RESERVATION_ID");
    return invokeHostaway(send, hostawayRequest("PUT", `/reservations/${b.reservationId}/statuses/cancelled`, {}, x), o.signal);
  };
  return k;
}

function stripeKeys(b, send) {
  const k = {}; const PI = b.paymentIntentId;
  const expandOnly = (p) => p !== null && typeof p === "object" && keysEq(p, ["expand"]) && Array.isArray(p.expand) && p.expand.length === 1 && p.expand[0] === "latest_charge";
  k.retrieveAccount = async (opts) => { const o = callOptions(opts, ["signal"]); return invokeStripe(send, Object.freeze({ op: "accounts.retrieve" }), o.signal); };
  k.retrievePaymentIntent = async (id, params, opts) => {
    const o = callOptions(opts, ["signal"]);
    if (argSnap(id) !== PI) refuse("PAYMENT_INTENT_SCOPE");
    const p = argSnap(params);
    if (!expandOnly(p)) refuse("PARAMS");
    return invokeStripe(send, Object.freeze({ op: "paymentIntents.retrieve", id: PI, params: p }), o.signal);
  };
  /** createRefund(pi, { amount, metadata: { mv_refund_op, mv_refund_key } }, { idempotencyKey, signal }) — the ONE bound FULL refund; nothing else is buildable */
  k.createRefund = async (id, params, opts) => {
    const o = callOptions(opts, ["idempotencyKey", "signal"]);
    if (argSnap(id) !== PI) refuse("PAYMENT_INTENT_SCOPE");
    const p = argSnap(params);
    if (p === null || typeof p !== "object" || !keysEq(p, ["amount", "metadata"]) || p.amount !== b.amountMinor) refuse("PARAMS");          // never partial, never a reason
    const md = p.metadata;
    if (md === null || typeof md !== "object" || !keysEq(md, [REFUND_METADATA_KEYS.op, REFUND_METADATA_KEYS.key])
        || md[REFUND_METADATA_KEYS.op] !== b.refundOpId || md[REFUND_METADATA_KEYS.key] !== b.refundIdempotencyKey) refuse("METADATA_SCOPE");
    if (o.idempotencyKey !== b.refundIdempotencyKey) refuse("IDEMPOTENCY_KEY");                                                               // never a new / implicit key
    return invokeStripe(send, Object.freeze({ op: "refunds.create", params: Object.freeze({ payment_intent: PI, amount: b.amountMinor,
      metadata: Object.freeze({ [REFUND_METADATA_KEYS.op]: b.refundOpId, [REFUND_METADATA_KEYS.key]: b.refundIdempotencyKey }) }), idempotencyKey: b.refundIdempotencyKey }), o.signal);
  };
  k.retrieveRefund = async (id, opts) => {
    const o = callOptions(opts, ["signal"]);
    const re = argSnap(id);
    if (typeof re !== "string" || !REFUND_RE.test(re)) refuse("REFUND_ID_INVALID");
    return invokeStripe(send, Object.freeze({ op: "refunds.retrieve", id: re }), o.signal);
  };
  k.listRefunds = async (id, params, opts) => {
    const o = callOptions(opts, ["signal"]);
    if (argSnap(id) !== PI) refuse("PAYMENT_INTENT_SCOPE");
    const p = argSnap(params);
    if (p === null || typeof p !== "object" || !keysEq(p, ["limit"]) || p.limit !== REFUND_LIST_LIMIT) refuse("PARAMS");
    return invokeStripe(send, Object.freeze({ op: "refunds.list", params: Object.freeze({ payment_intent: PI, limit: REFUND_LIST_LIMIT }) }), o.signal);
  };
  return k;
}

/**
 * createTestCleanupExecutors({ binding, hostaway, stripe }) -> { ok:true, executors } | { ok:false, code }
 *   binding  exactly BINDING_KEYS (frozen copy taken before anything else; listing 606998 only; protected ids refused)
 *   hostaway exactly { send }, stripe exactly { send } (mandatory injection; no default)
 * The executors object has EXACTLY the cleanup worker's gate key set (PHASE_KEYS) and is frozen. Codes: OPTIONS_INVALID, BINDING_INVALID, TRANSPORT_INVALID.
 */
export function createTestCleanupExecutors(opts) {
  let binding, hsend, ssend;
  try {
    const o = plainProps(opts);
    if (o === BAD || !keysEq(o, ["binding", "hostaway", "stripe"])) return Object.freeze({ ok: false, code: "OPTIONS_INVALID" });
    binding = validateBinding(o.binding);
    if (!binding) return Object.freeze({ ok: false, code: "BINDING_INVALID" });
    const h = plainProps(o.hostaway); const s = plainProps(o.stripe);
    if (h === BAD || !keysEq(h, ["send"]) || typeof h.send !== "function" || s === BAD || !keysEq(s, ["send"]) || typeof s.send !== "function") return Object.freeze({ ok: false, code: "TRANSPORT_INVALID" });
    hsend = h.send; ssend = s.send;
  } catch { return Object.freeze({ ok: false, code: "OPTIONS_INVALID" }); }
  const hs = (req, x) => Reflect.apply(hsend, undefined, [req, x]);
  const ss = (call, x) => Reflect.apply(ssend, undefined, [call, x]);
  const ex = { ...hostawayKeys(binding, hs), ...stripeKeys(binding, ss) };
  const out = Object.create(null);
  for (const key of PHASE_KEYS) out[key] = ex[key];
  return Object.freeze({ ok: true, executors: Object.freeze(Object.assign({}, out)) });
}
