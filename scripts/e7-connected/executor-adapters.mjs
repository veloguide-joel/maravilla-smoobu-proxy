// scripts/e7-connected/executor-adapters.mjs — E7 connected-test EXECUTOR ADAPTER FOUNDATION (OFFLINE; injected transports only).
// Contract: claude/e7-connected-test-manifest.md (§6 executor matrix, §9 implementation map). Lives under scripts/ (excluded from upload).
//
// What this is: pure factories that turn ONE accepted worker's executor calls into exactly ONE call on an INJECTED transport:
//   * Hostaway: hostaway.send(request, { signal }) -> Promise<{ httpStatus, json }>, request = frozen { method, path ('/v1/...'), query, body? }
//   * Stripe:   stripe.send(call, { signal })      -> Promise<raw Stripe object>,  call = frozen { op, id?, params?, idempotencyKey? }
// Every request is validated against an IMMUTABLE per-factory binding (listing / dates / ref / account / PaymentIntent / bound reservation
// id / amount) before the single invocation; anything else is refused with ZERO transport calls.
//
// What this is NOT (all outside this slice and still CLOSED): a runner, CLI, credential loader, default / real transport, SDK construction,
// environment access, network call or probe. Nothing here imports `lib/hostaway.js` (its auth retry is no one-write evidence) or the Stripe SDK.
// The cancel (`PUT /v1/reservations/{id}/statuses/cancelled`) and offline-charge (`POST /v1/guestPayments/charges/{id}`) mappings remain
// ASSUMED / LIVE-UNVERIFIED: these adapters prove request MAPPING only, never provider support. Labels are TRUST, not account ownership.
//
// Error contract (matches the workers' existing handling, which treats ANY rejection from an executor as a transport failure — a read
// retry / unknown, never a definite refusal):
//   * ExecutorRefusal (code only): the request was refused BEFORE any invocation (bad scope / shape / aborted signal / unbound id);
//   * ExecutorTransportFailure (code 'TRANSPORT_FAILED' or 'TRANSPORT_REPLY_SHAPE'): the ONE invocation threw / rejected / returned a
//     non-envelope. The original error / body / message is never read, kept or returned.
// HTTP statuses (404 / 429 / 5xx / anything) are passed through unchanged inside the envelope; nothing is reclassified, retried or rewritten.
// At-most-once across processes is the accepted DB operation fence + the future journal, not anything in this module.
import { types as nodeTypes } from "node:util";
import { PROTECTED_HOSTAWAY_RESERVATION_IDS, CANCEL_BODY } from "../../lib/checkout/compensation-proof.js";
import { LIST_LIMIT, offlineChargeTitle, exactAmount, APPROVED_PAYMENT_METHODS } from "../../lib/checkout/offline-charge-proof.js";

// Adapter constants: deliberately NOT imported from the pure Hostaway adapter module, whose importer set is pinned by accepted containment
// tests; each value is asserted equal to that module's export by test/e7-connected-executor-adapters.test.mjs (drift = test failure).
export const DIRECT_CHANNEL_ID = 2000;
export const LOOKUP_PAGE_LIMIT = 100;
export const REF_RE = /^MV-[A-Z0-9]{6,10}$/;
export const FORBIDDEN_PILOT_LISTING_IDS = Object.freeze([603564, 603566]);
export const CONNECTED_TEST_LISTING_ID = 603566;
export const CONNECTED_TEST_CURRENCY = "MXN";
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** a real calendar date 'YYYY-MM-DD' (same rule as the pure adapter's isRealDate; parity asserted in the tests) */
export function isRealDate(s) {
  if (typeof s !== "string") return false;
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 2000 || y > 2100) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

export const EXECUTOR_ADAPTERS_VERSION = "e7-connected-executor-adapters-v1";
// "reservation-recovery" (R-A1): the reservation worker's key set bound to ONE persisted candidate reservation id for its by-id recovery
// read; createReservation always refuses in this mode. The creation factory ("reservation") stays unbound.
export const PHASES = Object.freeze(["reservation", "reservation-recovery", "capture", "cleanup", "recording"]);
/** the exact executor key set each accepted worker gate requires (reservation-worker.js:53, capture-worker.js:46, compensation-worker.js:49,
 *  recording-worker.js:30 + the `label` the recording gate requires, :73–77) */
export const PHASE_KEYS = Object.freeze({
  reservation: Object.freeze(["pricing", "lookupPage", "retrieveReservation", "createReservation"]),
  "reservation-recovery": Object.freeze(["pricing", "lookupPage", "retrieveReservation", "createReservation"]),
  capture: Object.freeze(["retrieveAccount", "retrievePaymentIntent", "capturePaymentIntent", "retrieveReservation", "lookupPage"]),
  cleanup: Object.freeze(["retrieveAccount", "retrievePaymentIntent", "cancelPaymentIntent", "retrieveReservation", "lookupPage", "cancelReservation"]),
  recording: Object.freeze(["retrieveReservation", "listOfflineCharges", "createOfflineCharge", "label"])
});
const COMMON = ["listingId", "arrivalDate", "departureDate", "ref"];
export const BINDING_KEYS = Object.freeze({
  reservation: Object.freeze([...COMMON, "guests", "totalMinor", "currency", "refFieldId", "guest", "reservationId"].sort()),
  "reservation-recovery": Object.freeze([...COMMON, "guests", "totalMinor", "currency", "refFieldId", "guest", "reservationId"].sort()),
  capture: Object.freeze([...COMMON, "reservationId", "accountId", "paymentIntentId", "amountMinor", "captureIdempotencyKey"].sort()),
  cleanup: Object.freeze([...COMMON, "reservationId", "accountId", "paymentIntentId", "voidIdempotencyKey"].sort()),
  recording: Object.freeze(["listingId", "reservationId", "intentId", "amountMinor", "paymentMethod", "accountRef", "clientSnapshotId"].sort())
});
const OPTIONAL_BINDING = Object.freeze(["pilotException"]);
export const PILOT_EXCEPTION = "E4_CONNECTED_603566_MXN";   // the ONLY pilot form: the branded E4 connected-test config (603566, MXN)

export class ExecutorRefusal extends Error { constructor(code) { super("EXECUTOR_REFUSED"); this.name = "ExecutorRefusal"; this.code = code; Object.freeze(this); } }
export class ExecutorTransportFailure extends Error { constructor(code) { super("EXECUTOR_TRANSPORT_FAILED"); this.name = "ExecutorTransportFailure"; this.code = code; Object.freeze(this); } }

const RID_RE = /^[1-9][0-9]{0,15}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ACCT_RE = /^acct_[A-Za-z0-9]{1,64}$/;
const PI_RE = /^pi_[A-Za-z0-9_]{1,250}$/;
const KEY_RE = /^[A-Za-z0-9:_-]{1,255}$/;
const LABEL_RE = /^[A-Za-z0-9._:-]{1,100}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const SCHEDULED_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M} .'-]{0,59}$/u;
const EMAIL_RE = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const isPosInt = (v) => Number.isSafeInteger(v) && v > 0;

// ---------------------------------------------------------------------------------------------
// R-G1 descriptor snapshots: ONE own-property-descriptor read per object; own, string-keyed, enumerable DATA properties only; '__proto__'
// refused; values copied into null-prototype objects / fresh arrays; no getter, iterator or caller method is ever invoked (proxy traps
// necessarily run when inspected). Any introspection failure is a refusal (the caller's error is never kept).

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
/** JSON-like deep snapshot (primitives, plain / null-prototype objects, dense ordinary arrays), frozen; BAD otherwise */
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
const keysEq = (o, keys) => { const k = Object.keys(o).sort(); return k.length === keys.length && k.every((x, i) => x === [...keys].sort()[i]); };
const refuse = (code) => { throw new ExecutorRefusal(code); };
/** snapshot a caller argument; introspection errors become a refusal (never the caller's error) */
function argSnap(v) { let s; try { s = snap(v); } catch { s = BAD; } if (s === BAD) refuse("ARGUMENT_INVALID"); return s; }
// R-A2: native branded signal inspection. The intrinsic `aborted` getter is captured ONCE at module load from AbortSignal.prototype and
// applied with Reflect.apply: it reads the internal aborted state of a GENUINE AbortSignal, ignores any own `aborted` property (shadow
// getter or data) and throws for anything without the internal slot (a prototype fake); proxies (incl. revoked) are refused first by the
// native util.types.isProxy check, because Node's getter would otherwise see through a proxy to its target. No caller property,
// getter or method (incl. `instanceof` / Symbol.hasInstance) is consulted. Only this inspection is caught.
const NATIVE_ABORTED = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted").get;
/** true / false for a genuine AbortSignal; ExecutorRefusal('SIGNAL_REQUIRED') for anything else (code only, never the caller's error) */
function nativeAborted(sig) {
  if (sig === null || typeof sig !== "object") refuse("SIGNAL_REQUIRED");
  // Node's intrinsic getter brand-checks THROUGH a proxy (its internal-slot test is forwarded to the target), so proxies are refused
  // first with the native util.types.isProxy check, which runs no trap
  if (nodeTypes.isProxy(sig)) refuse("SIGNAL_REQUIRED");
  let a;
  try { a = Reflect.apply(NATIVE_ABORTED, sig, []); } catch { refuse("SIGNAL_REQUIRED"); }
  if (typeof a !== "boolean") refuse("SIGNAL_REQUIRED");
  return a;
}
/** the worker's per-call options: exactly the allowed keys; `signal` must be a GENUINE, not-yet-aborted AbortSignal */
function callOptions(o, allowed) {
  let p; try { p = plainProps(o); } catch { p = BAD; }
  if (p === BAD) refuse("OPTIONS_INVALID");
  for (const k of Object.keys(p)) if (!allowed.includes(k)) refuse("OPTIONS_INVALID");
  if (nativeAborted(p.signal)) refuse("ABORTED");
  return p;
}
/** immediately before the ONE invocation (after all argument introspection, whose proxy traps could have aborted it) */
function stillLive(signal) { if (nativeAborted(signal)) refuse("ABORTED"); }
const protectedId = (id) => PROTECTED_HOSTAWAY_RESERVATION_IDS.includes(String(id));

// ---------------------------------------------------------------------------------------------
// binding (immutable per factory)

function validateBinding(phase, raw) {
  const b = snap(raw);
  if (b === BAD) return null;
  const keys = Object.keys(b);
  for (const k of keys) if (!BINDING_KEYS[phase].includes(k) && !OPTIONAL_BINDING.includes(k)) return null;
  for (const k of BINDING_KEYS[phase]) if (!(k in b)) return null;
  if (!isPosInt(b.listingId) || b.listingId > 2147483647) return null;
  // pilots: refused, except the ONE branded E4 form (603566, MXN) when explicitly requested; 603564 never
  if (FORBIDDEN_PILOT_LISTING_IDS.includes(b.listingId)) {
    if (b.listingId !== CONNECTED_TEST_LISTING_ID || b.pilotException !== PILOT_EXCEPTION) return null;
    if (phase === "recording") return null;                                       // recording is USD-only (offline-charge-proof.js:33)
    if ((phase === "reservation" || phase === "reservation-recovery") && b.currency !== CONNECTED_TEST_CURRENCY) return null;
  } else if (b.pilotException !== undefined) return null;
  if (b.reservationId !== null && b.reservationId !== undefined && (typeof b.reservationId !== "string" || !RID_RE.test(b.reservationId) || protectedId(b.reservationId))) return null;
  if (phase !== "recording") {
    if (!isRealDate(b.arrivalDate) || !isRealDate(b.departureDate) || !(b.arrivalDate < b.departureDate)) return null;
    if (typeof b.ref !== "string" || !REF_RE.test(b.ref)) return null;
  }
  if (phase === "reservation" || phase === "reservation-recovery") {
    if (phase === "reservation" && b.reservationId !== null) return null;          // creation / lookup factory: no bound id (§9.2)
    if (phase === "reservation-recovery" && typeof b.reservationId !== "string") return null;   // ONE persisted candidate id (§9.2a)
    if (!isPosInt(b.guests) || b.guests > 50 || !isPosInt(b.totalMinor) || typeof b.currency !== "string" || !CURRENCY_RE.test(b.currency) || !isPosInt(b.refFieldId)) return null;
    if (exactAmount(b.totalMinor) === null) return null;
    const g = b.guest;
    if (g === null || typeof g !== "object" || Array.isArray(g) || !keysEq(g, ["email", "firstName", "lastName"])
        || typeof g.firstName !== "string" || !NAME_RE.test(g.firstName) || typeof g.lastName !== "string" || !NAME_RE.test(g.lastName)
        || typeof g.email !== "string" || g.email.length > 254 || !EMAIL_RE.test(g.email)) return null;
  }
  if (phase === "capture" || phase === "cleanup") {
    if (typeof b.accountId !== "string" || !ACCT_RE.test(b.accountId) || typeof b.paymentIntentId !== "string" || !PI_RE.test(b.paymentIntentId)) return null;
  }
  if (phase === "capture") {
    if (typeof b.reservationId !== "string" || !isPosInt(b.amountMinor) || typeof b.captureIdempotencyKey !== "string" || !KEY_RE.test(b.captureIdempotencyKey)) return null;
  }
  if (phase === "cleanup" && (typeof b.voidIdempotencyKey !== "string" || !KEY_RE.test(b.voidIdempotencyKey))) return null;
  if (phase === "recording") {
    if (typeof b.reservationId !== "string" || typeof b.intentId !== "string" || !UUID_RE.test(b.intentId) || exactAmount(b.amountMinor) === null
        || !APPROVED_PAYMENT_METHODS.includes(b.paymentMethod) || typeof b.accountRef !== "string" || !LABEL_RE.test(b.accountRef)
        || typeof b.clientSnapshotId !== "string" || !LABEL_RE.test(b.clientSnapshotId)) return null;
  }
  return b;
}

// ---------------------------------------------------------------------------------------------
// the ONE invocation (outside every validation try): exactly one call, no retry; failures become a code-only transport failure

async function invokeHostaway(send, request, signal) {
  stillLive(signal);
  let reply;
  try { reply = await send(request, Object.freeze({ signal })); } catch { throw new ExecutorTransportFailure("TRANSPORT_FAILED"); }
  let env;
  try { env = plainProps(reply); } catch { env = BAD; }
  if (env === BAD || !keysEq(env, ["httpStatus", "json"]) || !Number.isSafeInteger(env.httpStatus) || env.httpStatus < 100 || env.httpStatus > 599) {
    throw new ExecutorTransportFailure("TRANSPORT_REPLY_SHAPE");
  }
  return env;                                                                 // json passed through unchanged (provider facts untouched)
}
async function invokeStripe(send, call, signal) {
  stillLive(signal);
  try { return await send(call, Object.freeze({ signal })); } catch { throw new ExecutorTransportFailure("TRANSPORT_FAILED"); }
}
/** Hostaway request: both worker path conventions ('/x' relative to /v1, and '/v1/x') normalised to exactly ONE '/v1' prefix */
function hostawayRequest(method, path, query, body) {
  const r = { method, path: `/v1${path}`, query: Object.freeze({ ...query }) };
  if (body !== undefined) r.body = body;
  return Object.freeze(r);
}
/** the worker's Hostaway request snapshot: exact keys, and the path must equal one of the accepted forms (no other path is buildable) */
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

// ---------------------------------------------------------------------------------------------
// per-key adapters

function hostawayKeys(b, send) {
  const keys = {};
  keys.lookupPage = async (req, opts) => {
    const o = callOptions(opts, ["signal"]);
    const r = workerRequest(req, { method: "GET", paths: both("/reservations") });
    const q = r.query;
    const qk = Object.keys(q).sort();
    const base = ["arrivalEndDate", "arrivalStartDate", "channelId", "includeResources", "limit", "listingId"];
    if (!(keysEq(q, base) || keysEq(q, [...base, "afterId"]))) refuse("QUERY");
    if (q.listingId !== b.listingId || q.channelId !== DIRECT_CHANNEL_ID || q.arrivalStartDate !== b.arrivalDate || q.arrivalEndDate !== b.arrivalDate
        || q.limit !== LOOKUP_PAGE_LIMIT || q.includeResources !== 1 || (qk.includes("afterId") && !isPosInt(q.afterId))) refuse("QUERY_SCOPE");
    return invokeHostaway(send, hostawayRequest("GET", "/reservations", q), o.signal);         // afterId = the opaque cursor only
  };
  keys.retrieveReservation = async (req, opts) => {
    const o = callOptions(opts, ["signal"]);
    if (typeof b.reservationId !== "string") refuse("RESERVATION_UNBOUND");                  // never adopted from a reply
    const r = workerRequest(req, { method: "GET", paths: both(`/reservations/${b.reservationId}`) });
    if (Object.keys(r.query).length !== 0) refuse("QUERY");
    if (protectedId(b.reservationId)) refuse("PROTECTED_RESERVATION_ID");
    return invokeHostaway(send, hostawayRequest("GET", `/reservations/${b.reservationId}`, {}), o.signal);
  };
  return keys;
}

function reservationKeys(b, send, recovery) {
  const k = hostawayKeys(b, send);
  const L = b.listingId;
  const pricingReply = (env) => Object.freeze({ status: env.httpStatus, json: env.json });   // pricing's accepted {status, json} contract
  k.pricing = Object.freeze({
    get: async (path, opts) => {
      const o = callOptions(opts, ["query", "signal", "timeoutMs"]);
      const p = argSnap(path);
      if (p === `/listings/${L}`) {
        if (o.query !== undefined) refuse("QUERY");
        return pricingReply(await invokeHostaway(send, hostawayRequest("GET", `/listings/${L}`, {}), o.signal));
      }
      if (p === `/listings/${L}/calendar`) {
        const q = argSnap(o.query);
        if (q === null || typeof q !== "object" || !keysEq(q, ["endDate", "startDate"]) || q.startDate !== b.arrivalDate || q.endDate !== b.departureDate) refuse("QUERY_SCOPE");
        return pricingReply(await invokeHostaway(send, hostawayRequest("GET", `/listings/${L}/calendar`, q), o.signal));
      }
      refuse("PATH");
    },
    post: async (path, body, opts) => {
      const o = callOptions(opts, ["signal", "timeoutMs"]);
      if (argSnap(path) !== `/listings/${L}/calendar/priceDetails`) refuse("PATH");
      const x = argSnap(body);
      if (x === null || typeof x !== "object" || !keysEq(x, ["endingDate", "numberOfGuests", "startingDate", "version"]) || x.startingDate !== b.arrivalDate
          || x.endingDate !== b.departureDate || x.numberOfGuests !== b.guests || x.version !== 2) refuse("BODY_SCOPE");
      return pricingReply(await invokeHostaway(send, hostawayRequest("POST", `/listings/${L}/calendar/priceDetails`, {}, x), o.signal));
    }
  });
  const CREATE_BODY_KEYS = ["arrivalDate", "channelId", "currency", "customFieldValues", "departureDate", "guestEmail", "guestFirstName", "guestLastName",
    "guestName", "listingMapId", "numberOfGuests", "totalPrice"];
  k.createReservation = async (req, opts) => {
    if (recovery) refuse("RECOVERY_MODE_NO_CREATE");                                       // a recovery factory never creates
    const o = callOptions(opts, ["signal"]);
    const r = workerRequest(req, { method: "POST", paths: both("/reservations"), body: true });
    if (Object.keys(r.query).length !== 0) refuse("CREATE_QUERY_REFUSED");                  // never forceOverbooking / provider / any param
    const x = r.body;
    if (x === null || typeof x !== "object" || Array.isArray(x)) refuse("BODY_SHAPE");
    if (JSON.stringify(x).includes("forceOverbooking")) refuse("FORCE_OVERBOOKING_REFUSED");
    if (!keysEq(x, CREATE_BODY_KEYS)) refuse("BODY_SHAPE");
    const g = b.guest;
    const cf = x.customFieldValues;
    if (x.channelId !== DIRECT_CHANNEL_ID || x.listingMapId !== L || x.arrivalDate !== b.arrivalDate || x.departureDate !== b.departureDate
        || x.numberOfGuests !== b.guests || x.totalPrice !== exactAmount(b.totalMinor) || x.currency !== b.currency
        || x.guestFirstName !== g.firstName || x.guestLastName !== g.lastName || x.guestName !== `${g.firstName} ${g.lastName}` || x.guestEmail !== g.email
        || !Array.isArray(cf) || cf.length !== 1 || cf[0] === null || typeof cf[0] !== "object" || !keysEq(cf[0], ["customFieldId", "value"])
        || cf[0].customFieldId !== b.refFieldId || cf[0].value !== b.ref) refuse("BODY_SCOPE");
    return invokeHostaway(send, hostawayRequest("POST", "/reservations", {}, x), o.signal);
  };
  return k;
}

function stripeKeys(b, send, phase) {
  const k = {};
  const PI = b.paymentIntentId;
  k.retrieveAccount = async (opts) => {
    const o = callOptions(opts, ["signal"]);
    return invokeStripe(send, Object.freeze({ op: "accounts.retrieve" }), o.signal);          // the worker checks id === stripeAccountId
  };
  const expandOnly = (p) => p !== null && typeof p === "object" && keysEq(p, ["expand"]) && Array.isArray(p.expand) && p.expand.length === 1 && p.expand[0] === "latest_charge";
  k.retrievePaymentIntent = async (id, params, opts) => {
    const o = callOptions(opts, ["signal"]);
    if (argSnap(id) !== PI) refuse("PAYMENT_INTENT_SCOPE");
    const p = argSnap(params);
    if (!expandOnly(p)) refuse("PARAMS");
    return invokeStripe(send, Object.freeze({ op: "paymentIntents.retrieve", id: PI, params: p }), o.signal);
  };
  if (phase === "capture") {
    k.capturePaymentIntent = async (id, params, opts) => {
      const o = callOptions(opts, ["idempotencyKey", "signal"]);
      if (argSnap(id) !== PI) refuse("PAYMENT_INTENT_SCOPE");
      const p = argSnap(params);
      // C1 (2026-11-13): exact param set is amount_to_capture + expand ONLY; `final_capture` (multicapture-only) is never forwarded
      if (p === null || typeof p !== "object" || !keysEq(p, ["amount_to_capture", "expand"]) || p.amount_to_capture !== b.amountMinor
          || !expandOnly({ expand: p.expand })) refuse("PARAMS");
      if (o.idempotencyKey !== b.captureIdempotencyKey) refuse("IDEMPOTENCY_KEY");              // never a new / implicit key
      return invokeStripe(send, Object.freeze({ op: "paymentIntents.capture", id: PI, params: p, idempotencyKey: b.captureIdempotencyKey }), o.signal);
    };
  }
  if (phase === "cleanup") {
    k.cancelPaymentIntent = async (id, params, opts) => {
      const o = callOptions(opts, ["idempotencyKey", "signal"]);
      if (argSnap(id) !== PI) refuse("PAYMENT_INTENT_SCOPE");
      const p = argSnap(params);
      if (p === null || typeof p !== "object" || Array.isArray(p) || Object.keys(p).length !== 0) refuse("PARAMS");
      if (o.idempotencyKey !== b.voidIdempotencyKey) refuse("IDEMPOTENCY_KEY");
      return invokeStripe(send, Object.freeze({ op: "paymentIntents.cancel", id: PI, params: p, idempotencyKey: b.voidIdempotencyKey }), o.signal);
    };
  }
  return k;
}

function cleanupHostawayKeys(b, send) {
  const k = hostawayKeys(b, send);
  // ASSUMED / LIVE-UNVERIFIED endpoint (compensation-proof.js:421; E4 used the same verb and path, owner-reported)
  k.cancelReservation = async (req, opts) => {
    const o = callOptions(opts, ["signal"]);
    if (typeof b.reservationId !== "string") refuse("RESERVATION_UNBOUND");
    const r = workerRequest(req, { method: "PUT", paths: both(`/reservations/${b.reservationId}/statuses/cancelled`), body: true });
    if (Object.keys(r.query).length !== 0) refuse("QUERY");
    const x = r.body;
    if (x === null || typeof x !== "object" || !keysEq(x, Object.keys(CANCEL_BODY)) || x.cancelledBy !== CANCEL_BODY.cancelledBy) refuse("BODY_SCOPE");
    if (protectedId(b.reservationId)) refuse("PROTECTED_RESERVATION_ID");
    return invokeHostaway(send, hostawayRequest("PUT", `/reservations/${b.reservationId}/statuses/cancelled`, {}, x), o.signal);
  };
  return k;
}

function recordingKeys(b, send) {
  const k = {};
  const R = b.reservationId;
  k.retrieveReservation = async (req, opts) => {
    const o = callOptions(opts, ["signal"]);
    const r = workerRequest(req, { method: "GET", paths: both(`/reservations/${R}`) });
    if (Object.keys(r.query).length !== 0) refuse("QUERY");
    return invokeHostaway(send, hostawayRequest("GET", `/reservations/${R}`, {}), o.signal);
  };
  k.listOfflineCharges = async (req, opts) => {
    const o = callOptions(opts, ["signal"]);
    const r = workerRequest(req, { method: "GET", paths: both("/guestPayments/charges") });
    const q = r.query;
    if (!keysEq(q, ["limit", "reservationId"]) || String(q.reservationId) !== R || !["string", "number"].includes(typeof q.reservationId) || q.limit !== LIST_LIMIT) refuse("QUERY_SCOPE");
    return invokeHostaway(send, hostawayRequest("GET", "/guestPayments/charges", q), o.signal);
  };
  // ASSUMED / LIVE-UNVERIFIED endpoint (offline-charge-proof.js:359–375): no live evidence; mapping only
  k.createOfflineCharge = async (req, opts) => {
    const o = callOptions(opts, ["signal"]);
    const r = workerRequest(req, { method: "POST", paths: both(`/guestPayments/charges/${R}`), body: true });
    if (Object.keys(r.query).length !== 0) refuse("QUERY");
    const x = r.body;
    if (x === null || typeof x !== "object" || !keysEq(x, ["amount", "paymentMethod", "scheduledDate", "status", "title"]) || x.title !== offlineChargeTitle(b.intentId)
        || x.amount !== exactAmount(b.amountMinor) || x.paymentMethod !== b.paymentMethod || x.status !== "paid"
        || typeof x.scheduledDate !== "string" || !SCHEDULED_RE.test(x.scheduledDate)) refuse("BODY_SCOPE");
    return invokeHostaway(send, hostawayRequest("POST", `/guestPayments/charges/${R}`, {}, x), o.signal);
  };
  k.label = Object.freeze({ accountRef: b.accountRef, clientSnapshotId: b.clientSnapshotId });   // TRUST label, not verified ownership
  return k;
}

// ---------------------------------------------------------------------------------------------

/**
 * createPhaseExecutors({ phase, binding, hostaway, stripe? }) -> { ok:true, executors } | { ok:false, code }
 *   phase    'reservation' | 'reservation-recovery' | 'capture' | 'cleanup' | 'recording'
 *   binding  exactly BINDING_KEYS[phase] (+ optional pilotException); frozen copy taken before anything else; see §9.2
 *   hostaway exactly { send: function }   (mandatory injection; no default)
 *   stripe   exactly { send: function }   for capture / cleanup only; absent otherwise
 * The executors object has EXACTLY the key set of that worker's gate (PHASE_KEYS[phase]) and is frozen. Codes: OPTIONS_INVALID,
 * PHASE_INVALID, BINDING_INVALID, TRANSPORT_INVALID. Only this input introspection is caught; nothing here invokes a transport.
 */
export function createPhaseExecutors(opts) {
  let o, phase, binding, hsend, ssend;
  try {
    o = plainProps(opts);
    if (o === BAD) return Object.freeze({ ok: false, code: "OPTIONS_INVALID" });
    phase = o.phase;
    if (!PHASES.includes(phase)) return Object.freeze({ ok: false, code: "PHASE_INVALID" });
    const needStripe = phase === "capture" || phase === "cleanup";
    if (!keysEq(o, needStripe ? ["binding", "hostaway", "phase", "stripe"] : ["binding", "hostaway", "phase"])) return Object.freeze({ ok: false, code: "OPTIONS_INVALID" });
    binding = validateBinding(phase, o.binding);
    if (!binding) return Object.freeze({ ok: false, code: "BINDING_INVALID" });
    const h = plainProps(o.hostaway);
    if (h === BAD || !keysEq(h, ["send"]) || typeof h.send !== "function") return Object.freeze({ ok: false, code: "TRANSPORT_INVALID" });
    hsend = h.send;
    if (needStripe) {
      const s = plainProps(o.stripe);
      if (s === BAD || !keysEq(s, ["send"]) || typeof s.send !== "function") return Object.freeze({ ok: false, code: "TRANSPORT_INVALID" });
      ssend = s.send;
    }
  } catch { return Object.freeze({ ok: false, code: "OPTIONS_INVALID" }); }
  const hs = (req, x) => Reflect.apply(hsend, undefined, [req, x]);               // unbound call: no `this` from caller objects
  const ss = ssend ? (call, x) => Reflect.apply(ssend, undefined, [call, x]) : null;
  let ex;
  if (phase === "reservation" || phase === "reservation-recovery") ex = reservationKeys(binding, hs, phase === "reservation-recovery");
  else if (phase === "capture") ex = { ...hostawayKeys(binding, hs), ...stripeKeys(binding, ss, "capture") };
  else if (phase === "cleanup") ex = { ...cleanupHostawayKeys(binding, hs), ...stripeKeys(binding, ss, "cleanup") };
  else ex = recordingKeys(binding, hs);
  const out = Object.create(null);
  for (const key of PHASE_KEYS[phase]) out[key] = ex[key];
  return Object.freeze({ ok: true, executors: Object.freeze(Object.assign({}, out)) });
}
