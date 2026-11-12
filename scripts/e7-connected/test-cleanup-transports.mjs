// scripts/e7-connected/test-cleanup-transports.mjs — E7 captured-TEST cleanup: the ONE-shot Stripe TEST HTTP transport for the test-cleanup executor
// phase (test-cleanup-executors.mjs). OFFLINE foundation only; ISOLATED: the accepted http-transports.mjs is NOT modified (its Stripe send still refuses
// every refund operation; the Hostaway transport createE7HostawaySend is REUSED unchanged — GET reservation / page and ONE PUT …/statuses/cancelled are
// already its H1 / H2 / H7 forms). Contract: claude/e7-capture-test-cleanup-contract.md rev4 §7 (transport fence).
//
// Exactly these Stripe operations, nothing else is buildable:
//   accounts.retrieve            GET  /v1/account
//   paymentIntents.retrieve      GET  /v1/payment_intents/{pi}?expand[]=latest_charge
//   refunds.create               POST /v1/refunds  body payment_intent={pi}&amount={capturedMinor}&metadata[mv_refund_op]={opId}&metadata[mv_refund_key]=ref:{intent}:1
//                                (wire: brackets / colons percent-encoded as application/x-www-form-urlencoded requires), Idempotency-Key: ref:{intent}:1
//   refunds.retrieve             GET  /v1/refunds/{re_id}
//   refunds.list                 GET  /v1/refunds?payment_intent={pi}&limit=100
// Rules (labelled copy of the accepted transport, http-transports.mjs rev 2): one exchange per permitted send, never retried / redirected / re-minted;
// fixed origin; own-data snapshots before any await; the sk_test_ key-prefix rule (live / restricted / anything else: zero exchanges); the S1 expected
// account id; bounded reply bytes / JSON depth; operation-specific reply checks (PaymentIntent livemode false; a Refund object carries NO livemode — the
// refund's TEST-ness comes from the PI / charge evidence + the key scope); native-promise observation (R-TC2); abort re-checked after settlement (R-TC1);
// code-only errors (no URL, header, id, key, token or provider body ever leaves). GLOBAL INTRINSIC TRUST: not a sandbox.
import { types } from "node:util";

export const TEST_CLEANUP_TRANSPORTS_VERSION = "e7-test-cleanup-transports-v1";
export const STRIPE_ORIGIN = "https://api.stripe.com";
export const STRIPE_MAX_BYTES = 256 * 1024;
export const MAX_JSON_DEPTH = 32;
export const REFUND_LIST_LIMIT = 100;
export const STRIPE_OPS = Object.freeze(["accounts.retrieve", "paymentIntents.retrieve", "refunds.create", "refunds.retrieve", "refunds.list"]);
export const ERROR_CODES = Object.freeze(["OPTIONS_INVALID", "REQUEST_NOT_ALLOWED", "ABORTED", "ABORTED_IN_FLIGHT", "CREDENTIAL_INVALID", "KEY_NOT_TEST",
  "EXCHANGE_FAILED", "REDIRECT_REFUSED", "ACCOUNT_MISMATCH", "REPLY_INVALID", "BODY_TOO_LARGE", "JSON_INVALID", "LIVEMODE_REFUSED", "STRIPE_HTTP_4XX", "STRIPE_HTTP_5XX"]);

export class E7TransportError extends Error {
  constructor(code) { super("E7_TRANSPORT_ERROR"); this.name = "E7TransportError"; this.code = ERROR_CODES.includes(code) ? code : "REPLY_INVALID"; Object.freeze(this); }
}
const fail = (code) => { throw new E7TransportError(code); };

// ---- intrinsics captured at load (labelled copy) --------------------------------------------------------------------------------
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
const isFn = (f) => typeof f === "function" && !types.isProxy(f);
const isSyncFn = (f) => isFn(f) && !types.isAsyncFunction(f) && !types.isGeneratorFunction(f);

const BAD = Symbol("bad");
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
const WELL_KNOWN = new Set(Object.getOwnPropertyNames(Symbol).map((k) => Symbol[k]).filter((s) => typeof s === "symbol"));
function intrinsicsIntact() {
  const c = getDesc(PROMISE_PROTO, "constructor");
  const sp = getDesc(NativePromise, Symbol.species);
  return !!c && "value" in c && c.value === CTOR_DESC.value && !!sp && sp.get === SPECIES_DESC.get && sp.set === SPECIES_DESC.set;
}
const isNativePromise = (p) => {
  try {
    if (p === null || typeof p !== "object" || types.isProxy(p) || !types.isPromise(p) || getProto(p) !== PROMISE_PROTO) return false;
    const d = getDescs(p);
    for (const k of ownKeys(d)) if (typeof k !== "symbol" || WELL_KNOWN.has(k) || apply(SYMBOL_KEY_FOR, Symbol, [k]) !== undefined || !("value" in d[k])) return false;
    return intrinsicsIntact();
  } catch { return false; }
};
function observe(p, onFulfilled, onRejected) {
  if (!isNativePromise(p)) return false;
  try { apply(P_THEN, p, [(v) => { try { onFulfilled(v); } catch { /* contained */ } }, (e) => { try { onRejected(e); } catch { /* contained */ } }]); return true; } catch { return false; }
}
const noop = () => {};
const asCode = (e) => (e instanceof E7TransportError ? e : new E7TransportError("REPLY_INVALID"));
const rejected = (e) => new NativePromise((_, rej) => { rej(asCode(e)); });
function callCredential(credential) {
  let v;
  try { v = apply(credential, undefined, []); } catch { fail("CREDENTIAL_INVALID"); }
  if (typeof v !== "string") { if (v !== null && typeof v === "object") observe(v, noop, noop); fail("CREDENTIAL_INVALID"); }
  return v;
}
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
function parseJson(bytes) {
  if (bytes.length === 0 || !depthOk(bytes)) return BAD;
  try { return deepFreeze(JSON.parse(DECODER.decode(bytes))); } catch { return BAD; }
}
function exchangeOnce(exchange, req, signal, max, finish) {
  return new NativePromise((resolve, reject) => {
    const a = nativeAborted(signal);
    if (a !== false) { reject(new E7TransportError(a === true ? "ABORTED" : "OPTIONS_INVALID")); return; }
    let p;
    try { p = apply(exchange, undefined, [req]); } catch { reject(new E7TransportError("EXCHANGE_FAILED")); return; }
    const attached = observe(p, (r) => {
      try {
        if (nativeAborted(signal) !== false) fail("ABORTED_IN_FLIGHT");
        const env = topData(r, ["bytes", "contentType", "status"]);
        if (!env) fail("REPLY_INVALID");
        if (!Number.isSafeInteger(env.status) || env.status < 100 || env.status > 599) fail("REPLY_INVALID");
        if (env.contentType !== null && typeof env.contentType !== "string") fail("REPLY_INVALID");
        if (env.status >= 300 && env.status <= 399) fail("REDIRECT_REFUSED");
        resolve(finish(env.status, copyBytes(env.bytes, max)));
      } catch (e) { reject(asCode(e)); }
    }, () => { reject(new E7TransportError(nativeAborted(signal) === false ? "EXCHANGE_FAILED" : "ABORTED_IN_FLIGHT")); });
    if (!attached) reject(new E7TransportError("EXCHANGE_FAILED"));
  });
}
const maxOpt = (v, cap) => (v === undefined ? cap : Number.isSafeInteger(v) && v >= 1 && v <= cap ? v : null);

// ---- Stripe TEST (the five cleanup operations) ----------------------------------------------------------------------------------------
const ACCT_RE = /^acct_[A-Za-z0-9]{1,64}$/;
const PI_RE = /^pi_[A-Za-z0-9_]{1,250}$/;
const REFUND_RE = /^re_[A-Za-z0-9_]{1,200}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REFUND_KEY_RE = /^ref:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:1$/;
const VERSION_RE = /^\d{4}-\d{2}-\d{2}(\.[a-z]{1,32})?$/;
const TEST_KEY_RE = /^sk_test_[A-Za-z0-9]{1,247}$/;
const REFUND_STATUSES = ["pending", "requires_action", "succeeded", "failed", "canceled"];
const expandOnly = (p) => p && typeof p === "object" && keysExactly(p, ["expand"]) && Array.isArray(p.expand) && p.expand.length === 1 && p.expand[0] === "latest_charge";
const isPosInt = (v) => Number.isSafeInteger(v) && v > 0;
/** application/x-www-form-urlencoded value (every input is already format-checked; colons / brackets are percent-encoded on the wire) */
const enc = (v) => encodeURIComponent(String(v));
const refundShape = (o) => o !== null && typeof o === "object" && !Array.isArray(o) && o.object === "refund" && typeof o.id === "string" && REFUND_RE.test(o.id) && REFUND_STATUSES.includes(o.status);

/**
 * createE7StripeTestCleanupSend({ exchange, credential, accountId, apiVersion, maxBytes? }) → frozen { ok:true, transport:{ send } } | { ok:false, code }
 * send(call, { signal }) → native Promise<frozen Stripe object> | rejects E7TransportError(code)
 */
export function createE7StripeTestCleanupSend(input) {
  const o = topData(input, ["accountId", "apiVersion", "credential", "exchange"], ["maxBytes"]);
  if (!o || !isFn(o.exchange) || !isSyncFn(o.credential) || typeof o.accountId !== "string" || !ACCT_RE.test(o.accountId)
      || typeof o.apiVersion !== "string" || !VERSION_RE.test(o.apiVersion)) return freeze({ ok: false, code: "OPTIONS_INVALID" });
  const max = maxOpt(o.maxBytes, STRIPE_MAX_BYTES);
  if (max === null) return freeze({ ok: false, code: "OPTIONS_INVALID" });
  const { exchange, credential } = o;
  const accountId = o.accountId; const apiVersion = o.apiVersion;
  function send(call, opts) {
   try {
    const signal = callSignal(opts);
    const c = safeSnap(call);
    if (c === BAD || c === null || typeof c !== "object" || Array.isArray(c) || typeof c.op !== "string") fail("REQUEST_NOT_ALLOWED");
    let method, path, form = null, idem = null, kind;
    if (c.op === "accounts.retrieve" && keysExactly(c, ["op"])) { method = "GET"; path = "/v1/account"; kind = "account"; }
    else if (c.op === "paymentIntents.retrieve" && keysExactly(c, ["id", "op", "params"]) && typeof c.id === "string" && PI_RE.test(c.id) && expandOnly(c.params)) {
      method = "GET"; path = `/v1/payment_intents/${c.id}?expand%5B%5D=latest_charge`; kind = "pi";
    } else if (c.op === "refunds.create" && keysExactly(c, ["idempotencyKey", "op", "params"]) && typeof c.idempotencyKey === "string" && REFUND_KEY_RE.test(c.idempotencyKey)
        && c.params && typeof c.params === "object" && keysExactly(c.params, ["amount", "metadata", "payment_intent"]) && typeof c.params.payment_intent === "string" && PI_RE.test(c.params.payment_intent)
        && isPosInt(c.params.amount) && c.params.metadata && typeof c.params.metadata === "object" && keysExactly(c.params.metadata, ["mv_refund_key", "mv_refund_op"])
        && typeof c.params.metadata.mv_refund_op === "string" && UUID_RE.test(c.params.metadata.mv_refund_op) && c.params.metadata.mv_refund_key === c.idempotencyKey) {
      // the ONE bound FULL refund: payment_intent + amount + both discovery metadata fields; Idempotency-Key = mv_refund_key = ref:<intent>:1 (one identity)
      method = "POST"; path = "/v1/refunds"; idem = c.idempotencyKey; kind = "refund";
      form = `payment_intent=${enc(c.params.payment_intent)}&amount=${c.params.amount}&metadata%5Bmv_refund_op%5D=${enc(c.params.metadata.mv_refund_op)}&metadata%5Bmv_refund_key%5D=${enc(c.params.metadata.mv_refund_key)}`;
    } else if (c.op === "refunds.retrieve" && keysExactly(c, ["id", "op"]) && typeof c.id === "string" && REFUND_RE.test(c.id)) {
      method = "GET"; path = `/v1/refunds/${c.id}`; kind = "refund";
    } else if (c.op === "refunds.list" && keysExactly(c, ["op", "params"]) && c.params && typeof c.params === "object" && keysExactly(c.params, ["limit", "payment_intent"])
        && typeof c.params.payment_intent === "string" && PI_RE.test(c.params.payment_intent) && c.params.limit === REFUND_LIST_LIMIT) {
      method = "GET"; path = `/v1/refunds?payment_intent=${enc(c.params.payment_intent)}&limit=${REFUND_LIST_LIMIT}`; kind = "list";
    } else fail("REQUEST_NOT_ALLOWED");
    let key = callCredential(credential);
    if (key.length === 0) fail("CREDENTIAL_INVALID");
    if (!TEST_KEY_RE.test(key)) fail("KEY_NOT_TEST");
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
      if (kind === "account") { if (obj.object !== "account" || obj.id !== accountId) fail("ACCOUNT_MISMATCH"); }
      else if (kind === "pi") { if (obj.object !== "payment_intent" || obj.id !== c.id) fail("REPLY_INVALID"); if (obj.livemode !== false) fail("LIVEMODE_REFUSED"); }
      else if (kind === "refund") {
        // a Refund object carries NO livemode: object / re_ id / documented status only (identity binding is the worker's job on its own ids)
        if (!refundShape(obj)) fail("REPLY_INVALID");
        if (c.op === "refunds.retrieve" && obj.id !== c.id) fail("REPLY_INVALID");
        if (c.op === "refunds.create" && (typeof obj.payment_intent === "string" ? obj.payment_intent : obj.payment_intent && obj.payment_intent.id) !== c.params.payment_intent) fail("REPLY_INVALID");
      } else {
        if (obj.object !== "list" || !Array.isArray(obj.data) || typeof obj.has_more !== "boolean" || obj.data.length > REFUND_LIST_LIMIT || !obj.data.every(refundShape)) fail("REPLY_INVALID");
      }
      return obj;
    });
   } catch (e) { return rejected(e); }
  }
  return freeze({ ok: true, transport: freeze({ send }) });
}
