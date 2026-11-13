// scripts/e7-connected/http-transports.mjs — E7 connected-test runner SLICE T: one-shot HTTP transports for the accepted executor adapters'
// injected `send` interfaces (contract: claude/e7-connected-transport-contract.md, rev 2 accepted at 167118ab). OFFLINE foundation only.
//   * Every network effect goes through an INJECTED `exchange(request)` → native Promise<{ status, contentType, bytes }>. This module has no
//     default network path: it imports no fetch / http(s) / net / undici / SDK and reads no env, file or timer. The injected exchange is
//     TRUSTED code; a real exchange (CLOSED) must itself refuse redirects and enforce the byte budget while reading. No accepted manifest
//     authorizes real connections; labels do not physically prevent injected code from doing I/O.
//   * Exactly ONE exchange per permitted send, at most. No retry, backoff, token refresh / re-mint, redirect follow or second request —
//     whatever the reply (401 / 403 / 3xx / error / abort / late). One application exchange is NOT a guarantee of one server-side effect.
//   * Fixed hosts; URLs built only here from exact allowlisted forms; caller values are own-data snapshots taken before any await.
//   * Semantic binding (listing / dates / guest / amount / PaymentIntent / idempotency-key VALUES) is the accepted adapters' job; this module
//     re-checks formats only, and binds itself: hosts, forms, protected ids, the H8 wire translation, headers, Stripe-Version, the S1
//     expected account id, the TEST key-prefix rule, reply bounds and operation-specific reply checks.
//   * Credentials: an injected synchronous callback, called ONCE per permitted send after request validation. The value necessarily exists
//     in the private exchange request's Authorization header; it is never returned, thrown, logged or kept by this module.
//   * Errors are code-only (E7TransportError); no URL, header, id, key, token, provider body or caller error ever leaves.
//   * Promise observation (root HOLD R-TC2, the accepted run-guard rule ported, not imported): `send` is a plain function returning a
//     promise made by the captured native constructor; it never `await`s. A caller promise is observed ONLY through the intrinsic
//     Promise.prototype.then captured at load, and only when it is unpatched (brand, exact prototype, no own string key, only plain
//     unregistered symbol DATA props) AND Promise.prototype.constructor / Promise[@@species] still have their load-time descriptors
//     (descriptor identity, re-checked synchronously immediately before each attachment; no getter runs). GLOBAL INTRINSIC TRUST: this
//     module does not claim arbitrary same-process code cannot modify built-ins (e.g. Object.prototype); it is not a sandbox. A caller
//     return that is not such a promise is refused code-only and never assimilated; a rejection it carries is then not observed here.
//   * Abort (R-TC1): the genuine signal is re-checked after the exchange settles — fulfilled OR rejected — before the reply is used;
//     aborted → ABORTED_IN_FLIGHT. That does NOT mean the request had no server effect.
import { types } from "node:util";
import { PROTECTED_HOSTAWAY_RESERVATION_IDS } from "../../lib/checkout/compensation-proof.js";

export const HTTP_TRANSPORTS_VERSION = "e7-http-transports-v1";
export const HOSTAWAY_ORIGIN = "https://api.hostaway.com";
export const STRIPE_ORIGIN = "https://api.stripe.com";
export const HOSTAWAY_MAX_BYTES = 1024 * 1024;
export const STRIPE_MAX_BYTES = 256 * 1024;
export const MAX_JSON_DEPTH = 32;
export const CHARGE_LIST_LIMIT = 500;                       // = offline-charge-proof LIST_LIMIT (asserted equal by the test)
export const ERROR_CODES = Object.freeze(["OPTIONS_INVALID", "REQUEST_NOT_ALLOWED", "ABORTED", "ABORTED_IN_FLIGHT", "CREDENTIAL_INVALID", "KEY_NOT_TEST",
  "EXCHANGE_FAILED", "REDIRECT_REFUSED", "ACCOUNT_MISMATCH", "REPLY_INVALID", "BODY_TOO_LARGE", "JSON_INVALID", "LIVEMODE_REFUSED", "STRIPE_HTTP_4XX", "STRIPE_HTTP_5XX"]);

export class E7TransportError extends Error {
  constructor(code) { super("E7_TRANSPORT_ERROR"); this.name = "E7TransportError"; this.code = ERROR_CODES.includes(code) ? code : "REPLY_INVALID"; Object.freeze(this); }
}
const fail = (code) => { throw new E7TransportError(code); };

// ---- intrinsics captured at load (caller-shadowable properties are never consulted) ------------------------------------------
const freeze = Object.freeze;
const apply = Reflect.apply;
const getDesc = Object.getOwnPropertyDescriptor;
const getDescs = Object.getOwnPropertyDescriptors;
const getProto = Object.getPrototypeOf;
const ownKeys = Reflect.ownKeys;
const TA_PROTO = getProto(Uint8Array.prototype);
const TA_BUFFER = getDesc(TA_PROTO, "buffer").get;
const TA_LENGTH = getDesc(TA_PROTO, "byteLength").get;
const TA_SET = TA_PROTO.set;
const AB_DETACHED = getDesc(ArrayBuffer.prototype, "detached")?.get ?? null;
const NATIVE_ABORTED = getDesc(AbortSignal.prototype, "aborted").get;
const NativePromise = Promise;
const P_THEN = Promise.prototype.then;
const PROMISE_PROTO = Promise.prototype;
const CTOR_DESC = getDesc(Promise.prototype, "constructor");
const SPECIES_DESC = getDesc(Promise, Symbol.species);
const SYMBOL_KEY_FOR = Symbol.keyFor;
const DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
const PROTECTED = new Set(PROTECTED_HOSTAWAY_RESERVATION_IDS.map(String));
const isFn = (f) => typeof f === "function" && !types.isProxy(f);
const isSyncFn = (f) => isFn(f) && !types.isAsyncFunction(f) && !types.isGeneratorFunction(f);

// ---- getter-free snapshots ------------------------------------------------------------------------------------------------------
const BAD = Symbol("bad");
/** JSON-like own-data snapshot: primitives, plain / null-prototype objects, dense ordinary arrays; no getter / iterator / toJSON runs */
function snap(v, depth = 8) {
  if (v === null || typeof v === "string" || typeof v === "boolean") return v;
  if (typeof v === "number") return Number.isFinite(v) ? v : BAD;
  if (typeof v !== "object" || depth <= 0 || types.isProxy(v)) return BAD;
  const d = getDescs(v); const ks = ownKeys(d);
  if (Array.isArray(v)) {
    if (getProto(v) !== Array.prototype) return BAD;
    const len = d.length;
    if (!len || !("value" in len) || !Number.isSafeInteger(len.value) || len.value > 64 || ks.length !== len.value + 1) return BAD;
    const out = [];
    for (let i = 0; i < len.value; i++) { const di = d[String(i)]; if (!di || !("value" in di) || di.enumerable !== true) return BAD; const s = snap(di.value, depth - 1); if (s === BAD) return BAD; out.push(s); }
    return freeze(out);
  }
  const p = getProto(v); if (p !== Object.prototype && p !== null) return BAD;
  const out = Object.create(null);
  for (const k of ks) {
    if (typeof k !== "string" || k === "__proto__" || !("value" in d[k]) || d[k].enumerable !== true) return BAD;
    const s = snap(d[k].value, depth - 1); if (s === BAD) return BAD; out[k] = s;
  }
  return freeze(out);
}
const safeSnap = (v) => { try { return snap(v); } catch { return BAD; } };
/** own enumerable DATA properties exactly `keys` (+ optional) of a plain object; values NOT deep-copied (functions allowed) */
function topData(o, keys, optional = []) {
  try {
    if (o === null || typeof o !== "object" || types.isProxy(o)) return null;
    const p = getProto(o); if (p !== Object.prototype && p !== null) return null;
    const d = getDescs(o); const ks = ownKeys(d);
    for (const k of ks) if (typeof k !== "string" || (!keys.includes(k) && !optional.includes(k)) || !("value" in d[k]) || d[k].enumerable !== true) return null;
    for (const k of keys) if (!(k in d)) return null;
    return Object.fromEntries(ks.map((k) => [k, d[k].value]));
  } catch { return null; }
}
const keysExactly = (o, keys) => { const k = Object.keys(o); return k.length === keys.length && keys.every((x) => k.includes(x)); };

/** a GENUINE AbortSignal's aborted state via the captured intrinsic; null for anything else (proxy / fake / revoked) */
function nativeAborted(sig) {
  if (sig === null || typeof sig !== "object" || types.isProxy(sig)) return null;
  try { const a = apply(NATIVE_ABORTED, sig, []); return typeof a === "boolean" ? a : null; } catch { return null; }
}
const callSignal = (opts) => {
  const o = topData(opts, ["signal"]);
  if (!o) fail("OPTIONS_INVALID");
  const a = nativeAborted(o.signal);
  if (a === null) fail("OPTIONS_INVALID");
  if (a) fail("ABORTED");
  return o.signal;
};
// well-known symbols (Symbol.species, Symbol.toStringTag, …) captured at load
const WELL_KNOWN = new Set(Object.getOwnPropertyNames(Symbol).map((k) => Symbol[k]).filter((s) => typeof s === "symbol"));
/** genuine, UNPATCHED native promise: Promise.prototype directly; no own string-keyed property (so no own `then` / `constructor`, which
 *  the intrinsic `then` would consult via SpeciesConstructor), no own well-known or registered symbol. Unique unregistered symbol DATA
 *  properties are tolerated: Node's async_hooks attaches `async_id_symbol` / `trigger_async_id_symbol` to every promise under node:test. */
/** the two built-ins the intrinsic then consults (SpeciesConstructor: p.constructor → C[@@species]) still carry their load-time
 *  descriptors — descriptor identity only, nothing is called */
function intrinsicsIntact() {
  const c = getDesc(PROMISE_PROTO, "constructor");
  const sp = getDesc(NativePromise, Symbol.species);
  return !!c && "value" in c && c.value === CTOR_DESC.value && !!sp && sp.get === SPECIES_DESC.get && sp.set === SPECIES_DESC.set;
}
const isNativePromise = (p) => {
  try {
    if (p === null || typeof p !== "object" || types.isProxy(p) || !types.isPromise(p) || getProto(p) !== PROMISE_PROTO) return false;
    const d = getDescs(p);
    for (const k of ownKeys(d)) {
      if (typeof k !== "symbol" || WELL_KNOWN.has(k) || apply(SYMBOL_KEY_FOR, Symbol, [k]) !== undefined || !("value" in d[k])) return false;
    }
    return intrinsicsIntact();
  } catch { return false; }
};
/** attach handlers through the captured intrinsic then → true; false WITHOUT attaching when `p` is not an unpatched native promise with
 *  intact intrinsics. Checked synchronously immediately before the attachment (no caller code can run in between). Handlers never throw. */
function observe(p, onFulfilled, onRejected) {
  if (!isNativePromise(p)) return false;
  try {
    apply(P_THEN, p, [(v) => { try { onFulfilled(v); } catch { /* contained */ } }, (e) => { try { onRejected(e); } catch { /* contained */ } }]);
    return true;
  } catch { return false; }
}
const noop = () => {};
/** a code-only rejection / error from anything thrown inside this module (never a caller error object) */
const asCode = (e) => (e instanceof E7TransportError ? e : new E7TransportError("REPLY_INVALID"));
const rejected = (e) => new NativePromise((_, rej) => { rej(asCode(e)); });
/** the synchronous credential callback, called once. A non-string return is CREDENTIAL_INVALID; a genuine unpatched native promise
 *  (e.g. a normal function returning Promise.reject(...)) is CONTAINED — a no-op handler attached via the intrinsic then, never awaited
 *  or used as a credential — so it cannot surface as an unhandled rejection (R-TC3). Other thenables are never touched. */
function callCredential(credential) {
  let v;
  try { v = apply(credential, undefined, []); } catch { fail("CREDENTIAL_INVALID"); }
  if (typeof v !== "string") { if (v !== null && typeof v === "object") observe(v, noop, noop); fail("CREDENTIAL_INVALID"); }
  return v;
}

/** the exchange reply's bytes: genuine Uint8Array (no subclass / proxy), ordinary non-shared non-detached buffer, ≤ max; copied once */
function copyBytes(v, max) {
  if (v === null || typeof v !== "object" || types.isProxy(v) || !types.isUint8Array(v) || getProto(v) !== Uint8Array.prototype) fail("REPLY_INVALID");
  let buf, len;
  try { buf = apply(TA_BUFFER, v, []); len = apply(TA_LENGTH, v, []); } catch { fail("REPLY_INVALID"); }
  if (types.isSharedArrayBuffer(buf) || !types.isArrayBuffer(buf)) fail("REPLY_INVALID");
  if (AB_DETACHED !== null) { let det; try { det = apply(AB_DETACHED, buf, []); } catch { fail("REPLY_INVALID"); } if (det !== false) fail("REPLY_INVALID"); }
  if (!Number.isSafeInteger(len) || len < 0) fail("REPLY_INVALID");
  if (len > max) fail("BODY_TOO_LARGE");
  const out = new Uint8Array(len);
  try { apply(TA_SET, out, [v]); } catch { fail("REPLY_INVALID"); }
  return out;
}
/** bounded JSON: depth scan on bytes (non-recursive), fatal UTF-8, JSON.parse once, deep freeze */
function depthOk(b) {
  let depth = 0; let inStr = false; let esc = false;
  for (let i = 0; i < b.length; i++) {
    const c = b[i];
    if (inStr) { if (esc) esc = false; else if (c === 0x5c) esc = true; else if (c === 0x22) inStr = false; continue; }
    if (c === 0x22) inStr = true;
    else if (c === 0x7b || c === 0x5b) { depth += 1; if (depth > MAX_JSON_DEPTH) return false; }
    else if (c === 0x7d || c === 0x5d) depth -= 1;
  }
  return true;
}
function deepFreeze(v, d = 0) {
  if (v !== null && typeof v === "object" && d <= MAX_JSON_DEPTH + 1) { for (const k of Object.keys(v)) deepFreeze(v[k], d + 1); freeze(v); }
  return v;
}
/** → parsed + frozen JSON value | BAD */
function parseJson(bytes) {
  if (bytes.length === 0 || !depthOk(bytes)) return BAD;
  try { return deepFreeze(JSON.parse(DECODER.decode(bytes))); } catch { return BAD; }
}

/** one exchange → native promise of finish(status, bytes). Final native signal check IMMEDIATELY before the call, exactly one call,
 *  native signal re-checked after settlement (fulfilled or rejected) BEFORE the reply is used, envelope snapshotted, no follow-up. */
function exchangeOnce(exchange, req, signal, max, finish) {
  return new NativePromise((resolve, reject) => {
    const a = nativeAborted(signal);
    if (a !== false) { reject(new E7TransportError(a === true ? "ABORTED" : "OPTIONS_INVALID")); return; }
    let p;
    try { p = apply(exchange, undefined, [req]); } catch { reject(new E7TransportError("EXCHANGE_FAILED")); return; }
    const attached = observe(p, (r) => {
      try {
        if (nativeAborted(signal) !== false) fail("ABORTED_IN_FLIGHT");         // R-TC1: abort observed after a FULFILLED settlement
        const env = topData(r, ["bytes", "contentType", "status"]);
        if (!env) fail("REPLY_INVALID");
        if (!Number.isSafeInteger(env.status) || env.status < 100 || env.status > 599) fail("REPLY_INVALID");
        if (env.contentType !== null && typeof env.contentType !== "string") fail("REPLY_INVALID");
        if (env.status >= 300 && env.status <= 399) fail("REDIRECT_REFUSED");  // never followed
        resolve(finish(env.status, copyBytes(env.bytes, max)));
      } catch (e) { reject(asCode(e)); }
    }, () => { reject(new E7TransportError(nativeAborted(signal) === false ? "EXCHANGE_FAILED" : "ABORTED_IN_FLIGHT")); });
    if (!attached) reject(new E7TransportError("EXCHANGE_FAILED"));          // not observable: never assimilated, never retried
  });
}
const maxOpt = (v, cap) => (v === undefined ? cap : Number.isSafeInteger(v) && v >= 1 && v <= cap ? v : null);

// =================================================================================================================================
// Hostaway (H1–H9)
const RID_RE = /^[1-9][0-9]{0,15}$/;
const LID_RE = /^[1-9][0-9]{0,9}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const REF_RE = /^MV-[A-Z0-9]{6,10}$/;
const SCHEDULED_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const TOKEN_RE = /^[\x21-\x7e]{1,4096}$/;
const NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M} .'-]{0,59}$/u;
const EMAIL_RE = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const isPosInt = (v, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(v) && v > 0 && v <= max;
const isMoney = (v) => typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 1e9 && Math.abs(Math.round(v * 100) - v * 100) < 1e-6;   // ≤ 2 decimals
const rid = (s) => (RID_RE.test(s) && !PROTECTED.has(s) ? s : null);
const lid = (s) => (LID_RE.test(s) && Number(s) <= 2147483647 ? s : null);
const isDate = (v) => typeof v === "string" && DATE_RE.test(v);
const CREATE_KEYS = ["arrivalDate", "channelId", "currency", "customFieldValues", "departureDate", "guestEmail", "guestFirstName", "guestLastName", "guestName",
  "listingMapId", "numberOfGuests", "totalPrice"];

/** → { form, path, wireQuery: [k, v][] , body } for exactly one allowlisted form; null otherwise */
function hostawayForm(r) {
  const { method, path, query } = r;
  const q = query; const qk = Object.keys(q);
  const none = qk.length === 0;
  let m;
  if (method === "GET" && path === "/v1/reservations") {
    const base = ["arrivalEndDate", "arrivalStartDate", "channelId", "includeResources", "limit", "listingId"];
    if (!(keysExactly(q, base) || keysExactly(q, [...base, "afterId"]))) return null;
    if (!isPosInt(q.listingId, 2147483647) || q.channelId !== 2000 || !isDate(q.arrivalStartDate) || !isDate(q.arrivalEndDate) || q.limit !== 100 || q.includeResources !== 1) return null;
    if ("afterId" in q && !isPosInt(q.afterId)) return null;
    return { form: "H1", wire: qk.sort().map((k) => [k, String(q[k])]) };
  }
  if (method === "GET" && (m = /^\/v1\/reservations\/([0-9]+)$/.exec(path)) && rid(m[1]) && none) return { form: "H2", wire: [] };
  if (method === "GET" && (m = /^\/v1\/listings\/([0-9]+)$/.exec(path)) && lid(m[1]) && none) return { form: "H3", wire: [] };
  if (method === "GET" && (m = /^\/v1\/listings\/([0-9]+)\/calendar$/.exec(path)) && lid(m[1])) {
    if (!keysExactly(q, ["endDate", "startDate"]) || !isDate(q.startDate) || !isDate(q.endDate)) return null;
    return { form: "H4", wire: [["endDate", q.endDate], ["startDate", q.startDate]] };
  }
  if (method === "POST" && (m = /^\/v1\/listings\/([0-9]+)\/calendar\/priceDetails$/.exec(path)) && lid(m[1]) && none) {
    const b = r.body;
    if (!b || !keysExactly(b, ["endingDate", "numberOfGuests", "startingDate", "version"]) || !isDate(b.startingDate) || !isDate(b.endingDate)
        || !isPosInt(b.numberOfGuests, 50) || b.version !== 2) return null;
    return { form: "H5", wire: [] };
  }
  if (method === "POST" && path === "/v1/reservations" && none) {
    const b = r.body;
    if (!b || !keysExactly(b, CREATE_KEYS) || b.channelId !== 2000 || !isPosInt(b.listingMapId, 2147483647) || !isDate(b.arrivalDate) || !isDate(b.departureDate)
        || !isPosInt(b.numberOfGuests, 50) || !isMoney(b.totalPrice) || typeof b.currency !== "string" || !/^[A-Z]{3}$/.test(b.currency)
        || typeof b.guestFirstName !== "string" || !NAME_RE.test(b.guestFirstName) || typeof b.guestLastName !== "string" || !NAME_RE.test(b.guestLastName)
        || b.guestName !== `${b.guestFirstName} ${b.guestLastName}` || typeof b.guestEmail !== "string" || b.guestEmail.length > 254 || !EMAIL_RE.test(b.guestEmail)
        || !Array.isArray(b.customFieldValues) || b.customFieldValues.length !== 1) return null;
    const cf = b.customFieldValues[0];
    if (!cf || typeof cf !== "object" || !keysExactly(cf, ["customFieldId", "value"]) || !isPosInt(cf.customFieldId) || typeof cf.value !== "string" || !REF_RE.test(cf.value)) return null;
    return { form: "H6", wire: [] };
  }
  if (method === "PUT" && (m = /^\/v1\/reservations\/([0-9]+)\/statuses\/cancelled$/.exec(path)) && rid(m[1]) && none) {
    const b = r.body;
    if (!b || !keysExactly(b, ["cancelledBy"]) || b.cancelledBy !== "host") return null;
    return { form: "H7", wire: [] };
  }
  if (method === "GET" && path === "/v1/guestPayments/charges") {
    // H8: the accepted INTERNAL envelope { limit, reservationId } → the documented WIRE selector reservationIds=<same id> (exactly once)
    if (!keysExactly(q, ["limit", "reservationId"]) || q.limit !== CHARGE_LIST_LIMIT) return null;
    const id = typeof q.reservationId === "string" ? q.reservationId : Number.isSafeInteger(q.reservationId) ? String(q.reservationId) : null;
    if (id === null || !rid(id)) return null;
    return { form: "H8", wire: [["limit", String(CHARGE_LIST_LIMIT)], ["reservationIds", id]] };
  }
  if (method === "POST" && (m = /^\/v1\/guestPayments\/charges\/([0-9]+)$/.exec(path)) && rid(m[1]) && none) {
    const b = r.body;
    if (!b || !keysExactly(b, ["amount", "paymentMethod", "scheduledDate", "status", "title"]) || !isMoney(b.amount) || !["credit_card", "other"].includes(b.paymentMethod)
        || b.status !== "paid" || typeof b.scheduledDate !== "string" || !SCHEDULED_RE.test(b.scheduledDate) || typeof b.title !== "string" || b.title.length < 1 || b.title.length > 200) return null;
    return { form: "H9", wire: [] };
  }
  return null;
}
const queryString = (pairs) => {
  if (!pairs.length) return "";
  const sp = new URLSearchParams();
  for (const [k, v] of pairs) sp.append(k, v);
  return `?${sp.toString()}`;
};

/**
 * createE7HostawaySend({ exchange, credential, maxBytes? }) → frozen { ok:true, transport:{ send } } | frozen { ok:false, code:'OPTIONS_INVALID' }
 * send(request, { signal }) → native Promise<frozen { httpStatus, json }> | rejects E7TransportError(code)
 */
export function createE7HostawaySend(input) {
  const o = topData(input, ["credential", "exchange"], ["maxBytes"]);
  if (!o || !isFn(o.exchange) || !isSyncFn(o.credential)) return freeze({ ok: false, code: "OPTIONS_INVALID" });
  const max = maxOpt(o.maxBytes, HOSTAWAY_MAX_BYTES);
  if (max === null) return freeze({ ok: false, code: "OPTIONS_INVALID" });
  const { exchange, credential } = o;
  function send(request, opts) {
   try {
    const signal = callSignal(opts);
    const r = safeSnap(request);                                 // frozen own-data copy; send never awaits
    if (r === BAD || r === null || typeof r !== "object" || Array.isArray(r)) fail("REQUEST_NOT_ALLOWED");
    const hasBody = "body" in r;
    if (!keysExactly(r, hasBody ? ["body", "method", "path", "query"] : ["method", "path", "query"])) fail("REQUEST_NOT_ALLOWED");
    if (typeof r.method !== "string" || typeof r.path !== "string" || r.query === null || typeof r.query !== "object" || Array.isArray(r.query)) fail("REQUEST_NOT_ALLOWED");
    if (hasBody && (r.body === null || typeof r.body !== "object" || Array.isArray(r.body))) fail("REQUEST_NOT_ALLOWED");
    const f = hostawayForm(r);
    if (!f || (["H5", "H6", "H7", "H9"].includes(f.form) !== hasBody)) fail("REQUEST_NOT_ALLOWED");
    let token = callCredential(credential);
    if (!TOKEN_RE.test(token)) fail("CREDENTIAL_INVALID");
    const headers = { Accept: "application/json", Authorization: `Bearer ${token}`, "Cache-control": "no-cache" };
    if (hasBody) headers["Content-Type"] = "application/json";
    token = null;
    const req = freeze({ method: r.method, url: `${HOSTAWAY_ORIGIN}${r.path}${queryString(f.wire)}`, headers: freeze(headers),
      body: hasBody ? JSON.stringify(r.body) : null, signal, maxBytes: max });
    return exchangeOnce(exchange, req, signal, max, (status, bytes) => {
      const json = parseJson(bytes);
      return freeze({ httpStatus: status, json: json === BAD ? null : json }); // statuses passed through unchanged; no re-mint on 401 / 403
    });
   } catch (e) { return rejected(e); }
  }
  return freeze({ ok: true, transport: freeze({ send }) });
}

// =================================================================================================================================
// Stripe TEST (S1–S4)
const ACCT_RE = /^acct_[A-Za-z0-9]{1,64}$/;
const PI_RE = /^pi_[A-Za-z0-9_]{1,250}$/;
const KEY_RE = /^[A-Za-z0-9:_-]{1,255}$/;
const VERSION_RE = /^\d{4}-\d{2}-\d{2}(\.[a-z]{1,32})?$/;
const TEST_KEY_RE = /^sk_test_[A-Za-z0-9]{1,247}$/;              // documented TEST secret prefix only; live / restricted / other refused
const expandOnly = (p) => p && typeof p === "object" && keysExactly(p, ["expand"]) && Array.isArray(p.expand) && p.expand.length === 1 && p.expand[0] === "latest_charge";

/**
 * createE7StripeTestSend({ exchange, credential, accountId, apiVersion, maxBytes? }) → frozen { ok:true, transport:{ send } } | { ok:false, code }
 * send(call, { signal }) → native Promise<frozen Stripe object> | rejects E7TransportError(code)
 */
export function createE7StripeTestSend(input) {
  const o = topData(input, ["accountId", "apiVersion", "credential", "exchange"], ["maxBytes"]);
  if (!o || !isFn(o.exchange) || !isSyncFn(o.credential) || typeof o.accountId !== "string" || !ACCT_RE.test(o.accountId)
      || typeof o.apiVersion !== "string" || !VERSION_RE.test(o.apiVersion)) return freeze({ ok: false, code: "OPTIONS_INVALID" });
  const max = maxOpt(o.maxBytes, STRIPE_MAX_BYTES);
  if (max === null) return freeze({ ok: false, code: "OPTIONS_INVALID" });
  const { exchange, credential } = o;
  const accountId = o.accountId; const apiVersion = o.apiVersion;     // primitives: immutable binding
  function send(call, opts) {
   try {
    const signal = callSignal(opts);
    const c = safeSnap(call);
    if (c === BAD || c === null || typeof c !== "object" || Array.isArray(c) || typeof c.op !== "string") fail("REQUEST_NOT_ALLOWED");
    let method, path, form = null, idem = null, kind;
    if (c.op === "accounts.retrieve" && keysExactly(c, ["op"])) { method = "GET"; path = "/v1/account"; kind = "account"; }
    else if (c.op === "paymentIntents.retrieve" && keysExactly(c, ["id", "op", "params"]) && typeof c.id === "string" && PI_RE.test(c.id) && expandOnly(c.params)) {
      method = "GET"; path = `/v1/payment_intents/${c.id}?expand%5B%5D=latest_charge`; kind = "pi";
    } else if (c.op === "paymentIntents.capture" && keysExactly(c, ["id", "idempotencyKey", "op", "params"]) && typeof c.id === "string" && PI_RE.test(c.id)
        && typeof c.idempotencyKey === "string" && KEY_RE.test(c.idempotencyKey) && c.params && typeof c.params === "object"
        && keysExactly(c.params, ["amount_to_capture", "expand"]) && isPosInt(c.params.amount_to_capture)
        && expandOnly({ expand: c.params.expand })) {
      // C1 (2026-11-13): single FULL capture — amount_to_capture + expand[]=latest_charge ONLY. `final_capture` is a multicapture-only
      // parameter; Stripe rejects it on an ordinary PaymentIntent (400 invalid_request_error, observed req_29dKSmY0uOuX26). Any request
      // carrying it falls through to REQUEST_NOT_ALLOWED (keysExactly), so the parameter can never reach the wire.
      method = "POST"; path = `/v1/payment_intents/${c.id}/capture`; idem = c.idempotencyKey; kind = "pi";
      form = `amount_to_capture=${c.params.amount_to_capture}&expand%5B%5D=latest_charge`;
    } else if (c.op === "paymentIntents.cancel" && keysExactly(c, ["id", "idempotencyKey", "op", "params"]) && typeof c.id === "string" && PI_RE.test(c.id)
        && typeof c.idempotencyKey === "string" && KEY_RE.test(c.idempotencyKey) && c.params && typeof c.params === "object" && !Array.isArray(c.params) && Object.keys(c.params).length === 0) {
      method = "POST"; path = `/v1/payment_intents/${c.id}/cancel`; idem = c.idempotencyKey; kind = "pi"; form = "";
    } else fail("REQUEST_NOT_ALLOWED");
    let key = callCredential(credential);
    if (key.length === 0) fail("CREDENTIAL_INVALID");
    if (!TEST_KEY_RE.test(key)) fail("KEY_NOT_TEST");                 // sk_live_ / rk_live_ / rk_test_ / anything else: zero exchanges
    const headers = { Authorization: `Bearer ${key}`, "Stripe-Version": apiVersion };
    key = null;
    if (method === "POST") { headers["Content-Type"] = "application/x-www-form-urlencoded"; headers["Idempotency-Key"] = idem; }
    const req = freeze({ method, url: `${STRIPE_ORIGIN}${path}`, headers: freeze(headers), body: method === "POST" ? form : null, signal, maxBytes: max });
    return exchangeOnce(exchange, req, signal, max, (status, bytes) => {
    if (status >= 400) fail(status >= 500 ? "STRIPE_HTTP_5XX" : "STRIPE_HTTP_4XX");
    if (status < 200) fail("REPLY_INVALID");
    const obj = parseJson(bytes);
    if (obj === BAD) fail("JSON_INVALID");
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) fail("REPLY_INVALID");
    if (kind === "account") {
      // the Account object has NO livemode field: it cannot attest TEST mode (the key-prefix rule does); object + exact id only
      if (obj.object !== "account" || obj.id !== accountId) fail("ACCOUNT_MISMATCH");
    } else {
      if (obj.object !== "payment_intent" || obj.id !== c.id) fail("REPLY_INVALID");
      if (obj.livemode !== false) fail("LIVEMODE_REFUSED");
    }
    return obj;
    });
   } catch (e) { return rejected(e); }
  }
  return freeze({ ok: true, transport: freeze({ send }) });
}
