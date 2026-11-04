// scripts/e7-connected/real-exchange.mjs — E7 connected-test runner SLICE X: the one-request HTTP exchange that can later be injected
// into the ACCEPTED Slice T transports as `exchange({ method, url, headers, body, signal, maxBytes }) → native Promise<{ status,
// contentType, bytes }>`. Contract: claude/e7-connected-real-exchange-contract.md (rev 1 accepted at b7000f8d) §2–§5 + §9.
//   * OFFLINE SLICE. The default primitive is node:https `request` / `Agent`, captured as references at load. Importing or constructing
//     does no I/O: no Agent, socket, DNS, timer or env read happens until a VALID exchange is invoked. No caller wiring, credential
//     loader, token mint, CLI or manifest real-mode exists or is authorized; tests inject a FAKE primitive only.
//   * One permitted invocation → one fresh dedicated non-keep-alive Agent + exactly ONE ClientRequest. Never a retry, redirect follow,
//     second request, new Agent or re-dispatch — whatever the status / error / abort. One application exchange is NOT one server effect:
//     once request creation has started, no failure here claims the request had no network effect.
//   * TLS options explicit and fixed (rejectUnauthorized:true; no CA / cert / proxy / createConnection / lookup / insecure parser option).
//   * The caller's genuine AbortSignal is the ONLY deadline: this module owns no timer, idle timeout or retry.
//   * Code-only E7ExchangeError; no URL / header / key / token / query / body / provider text / raw error is kept, thrown or logged. The
//     successful body bytes are the normal result (handed to T) and may contain guest / provider data — not claimed non-sensitive.
//   * TRUST: the primitive (default node:https or injected) and same-process built-ins are TRUSTED (global intrinsic trust); this module
//     is not a sandbox. It only removes listeners IT attached and never calls removeAllListeners().
import { request as httpsRequest, Agent as HttpsAgent } from "node:https";
import { types } from "node:util";
import { PROTECTED_HOSTAWAY_RESERVATION_IDS } from "../../lib/checkout/compensation-proof.js";

export const REAL_EXCHANGE_VERSION = "e7-real-exchange-v1";
export const ORIGINS = Object.freeze({ hostaway: "https://api.hostaway.com", stripe: "https://api.stripe.com" });
export const MAX_BYTES_CAP = Object.freeze({ hostaway: 1024 * 1024, stripe: 256 * 1024 });
export const MAX_REQUEST_BODY_BYTES = 64 * 1024;
export const AGENT_OPTIONS = Object.freeze({ keepAlive: false, maxSockets: 1, maxCachedSessions: 0 });
export const EXCHANGE_ERROR_CODES = Object.freeze(["EXCHANGE_OPTIONS_INVALID", "EXCHANGE_INPUT_INVALID", "EXCHANGE_ABORTED", "EXCHANGE_SETUP_FAILED",
  "EXCHANGE_NETWORK_ERROR", "EXCHANGE_PREMATURE_CLOSE", "EXCHANGE_STATUS_INVALID", "EXCHANGE_HEADERS_INVALID", "EXCHANGE_ENCODING_REFUSED", "EXCHANGE_BODY_TOO_LARGE"]);
/** the default primitive, exported for the source pin only (identity with node:https); never called on import */
export const NODE_HTTPS_PRIMITIVE = Object.freeze({ request: httpsRequest, Agent: HttpsAgent });

export class E7ExchangeError extends Error {
  constructor(code) { super("E7_EXCHANGE_ERROR"); this.name = "E7ExchangeError"; this.code = EXCHANGE_ERROR_CODES.includes(code) ? code : "EXCHANGE_SETUP_FAILED"; Object.freeze(this); }
}

// ---- intrinsics captured at load --------------------------------------------------------------------------------------------------
const freeze = Object.freeze;
const apply = Reflect.apply;
const ownKeys = Reflect.ownKeys;
const getDesc = Object.getOwnPropertyDescriptor;
const getDescs = Object.getOwnPropertyDescriptors;
const getProto = Object.getPrototypeOf;
const NativePromise = Promise;
const NativeURL = URL;
const NativeUint8Array = Uint8Array;
const TA_PROTO = getProto(Uint8Array.prototype);
const TA_BUFFER = getDesc(TA_PROTO, "buffer").get;
const TA_LENGTH = getDesc(TA_PROTO, "byteLength").get;
const TA_SET = TA_PROTO.set;
const AB_DETACHED = getDesc(ArrayBuffer.prototype, "detached")?.get ?? null;
const NATIVE_ABORTED = getDesc(AbortSignal.prototype, "aborted").get;
const ET_ADD = EventTarget.prototype.addEventListener;
const ET_REMOVE = EventTarget.prototype.removeEventListener;
const ENCODE = TextEncoder.prototype.encode;
const ENCODER = new TextEncoder();
const STR_LOWER = String.prototype.toLowerCase;
const STR_TRIM = String.prototype.trim;
const PROTECTED = new Set(PROTECTED_HOSTAWAY_RESERVATION_IDS.map(String));
const { isProxy, isUint8Array, isSharedArrayBuffer, isArrayBuffer } = types;
const isFn = (f) => typeof f === "function" && !isProxy(f);
const lower = (s) => apply(STR_LOWER, s, []);

// ---- getter-free snapshots ----------------------------------------------------------------------------------------------------------
/** own enumerable DATA properties exactly `keys` (+ optional) of a plain object → null-proto copy; never runs a getter */
function topData(o, keys, optional = []) {
  try {
    if (o === null || typeof o !== "object" || isProxy(o)) return null;
    const p = getProto(o); if (p !== Object.prototype && p !== null) return null;
    const d = getDescs(o); const ks = ownKeys(d);
    for (const k of ks) if (typeof k !== "string" || (!keys.includes(k) && !optional.includes(k)) || !("value" in d[k]) || d[k].enumerable !== true) return null;
    for (const k of keys) if (!(k in d)) return null;
    const out = Object.create(null); for (const k of ks) out[k] = d[k].value; return out;
  } catch { return null; }
}
/** own DATA property value of an object from the trusted primitive (statusCode / rawHeaders / complete); accessor → undefined */
function ownData(o, k) { try { const d = getDesc(o, k); return d && "value" in d ? d.value : undefined; } catch { return undefined; } }
function nativeAborted(sig) {
  if (sig === null || typeof sig !== "object" || isProxy(sig)) return null;
  try { const a = apply(NATIVE_ABORTED, sig, []); return typeof a === "boolean" ? a : null; } catch { return null; }
}
/** a handle from the primitive must offer the EventEmitter methods this module uses (trusted primitive; shape check only) */
const handleShape = (h, extra) => h !== null && typeof h === "object" && !isProxy(h) && isFn(h.on) && isFn(h.removeListener) && isFn(h.destroy) && extra.every((k) => isFn(h[k]));

// ---- request validation (contract §2) ------------------------------------------------------------------------------------------------
const HEADER_SETS = freeze({
  hostaway: freeze({ GET: ["Accept", "Authorization", "Cache-control"], POST: ["Accept", "Authorization", "Cache-control", "Content-Type"], PUT: ["Accept", "Authorization", "Cache-control", "Content-Type"] }),
  stripe: freeze({ GET: ["Authorization", "Stripe-Version"], POST: ["Authorization", "Content-Type", "Idempotency-Key", "Stripe-Version"] })
});
const HEADER_VALUE_RE = /^[\x20-\x7e]{1,4096}$/;
const PATH_RE = /^\/v1(\/[A-Za-z0-9_.-]+)+$/;
const SEARCH_RE = /^\?[A-Za-z0-9_.%=&-]{1,1024}$/;
function validateRequest(provider, input) {
  const r = topData(input, ["body", "headers", "maxBytes", "method", "signal", "url"]);
  if (!r) return null;
  const methods = HEADER_SETS[provider];
  if (typeof r.method !== "string" || !Object.hasOwn(methods, r.method)) return null;
  if (typeof r.url !== "string" || r.url.length > 2048) return null;
  let u; try { u = new NativeURL(r.url); } catch { return null; }
  const origin = ORIGINS[provider];
  if (u.protocol !== "https:" || u.origin !== origin || u.port !== "" || u.username !== "" || u.password !== "" || u.hash !== "") return null;
  if (r.url !== `${origin}${u.pathname}${u.search}`) return null;                     // canonical round-trip: no normalisation tricks
  if (!PATH_RE.test(u.pathname)) return null;
  const segs = u.pathname.split("/").slice(1);
  if (segs.some((s) => s === "." || s === ".." || PROTECTED.has(s))) return null;
  if (u.search !== "") {
    if (!SEARCH_RE.test(u.search)) return null;
    for (const kv of u.search.slice(1).split("&")) { const v = kv.split("=")[1] ?? ""; if (PROTECTED.has(v)) return null; }
  }
  const h = topData(r.headers, HEADER_SETS[provider][r.method]);
  if (!h || ownKeys(h).length !== HEADER_SETS[provider][r.method].length) return null;
  for (const k of ownKeys(h)) if (typeof h[k] !== "string" || !HEADER_VALUE_RE.test(h[k])) return null;
  if (!h.Authorization.startsWith("Bearer ")) return null;
  let bodyBytes = null;
  if (r.method === "GET") { if (r.body !== null) return null; }
  else {
    if (typeof r.body !== "string") return null;
    bodyBytes = apply(ENCODE, ENCODER, [r.body]);
    if (apply(TA_LENGTH, bodyBytes, []) > MAX_REQUEST_BODY_BYTES) return null;
  }
  if (nativeAborted(r.signal) === null) return null;
  if (!Number.isSafeInteger(r.maxBytes) || r.maxBytes < 1 || r.maxBytes > MAX_BYTES_CAP[provider]) return null;
  const headers = { ...h };
  if (bodyBytes !== null) headers["Content-Length"] = String(apply(TA_LENGTH, bodyBytes, []));
  const options = freeze({ protocol: "https:", hostname: u.hostname, port: 443, servername: u.hostname, method: r.method, path: `${u.pathname}${u.search}`,
    headers: freeze(headers), rejectUnauthorized: true, setHost: true, insecureHTTPParser: false, maxHeaderSize: 16384, joinDuplicateHeaders: false });
  return { options, bodyBytes, signal: r.signal, maxBytes: r.maxBytes };
}

// ---- response header reading (rawHeaders own data only; Location and every other header are never read) --------------------------
const CL_RE = /^(0|[1-9][0-9]{0,15})$/;
function readHeaders(rawHeaders) {
  if (!Array.isArray(rawHeaders) || isProxy(rawHeaders) || rawHeaders.length % 2 !== 0 || rawHeaders.length > 1024) return null;
  const d = getDescs(rawHeaders); let ct = null, ce = null, cl = null; const seen = new Set();
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const n = d[String(i)]; const v = d[String(i + 1)];
    if (!n || !v || !("value" in n) || !("value" in v) || typeof n.value !== "string" || typeof v.value !== "string") return null;
    const name = lower(n.value);
    if (name !== "content-type" && name !== "content-encoding" && name !== "content-length") continue;
    if (seen.has(name)) return null;                                                  // duplicate framing / type headers refused
    seen.add(name);
    if (name === "content-type") { if (v.value.length > 256 || !/^[\x20-\x7e]*$/.test(v.value)) return null; ct = v.value; }
    else if (name === "content-encoding") ce = lower(apply(STR_TRIM, v.value, []));
    else { if (!CL_RE.test(v.value)) return null; cl = Number(v.value); }
  }
  return { contentType: ct, contentEncoding: ce, contentLength: cl };
}
/** copy one accepted chunk into owned storage via intrinsics (Buffer accepted as input; never its .buffer / .byteLength / iterator) */
function chunkInfo(c) {
  if (c === null || typeof c !== "object" || isProxy(c) || !isUint8Array(c)) return null;
  try {
    const buf = apply(TA_BUFFER, c, []); const len = apply(TA_LENGTH, c, []);
    if (isSharedArrayBuffer(buf) || !isArrayBuffer(buf)) return null;
    if (AB_DETACHED !== null && apply(AB_DETACHED, buf, []) !== false) return null;
    return Number.isSafeInteger(len) && len >= 0 ? len : null;
  } catch { return null; }
}

// =================================================================================================================================
/**
 * createE7RealExchange({ provider, primitive? }) → frozen { ok:true, exchange } | frozen { ok:false, code:'EXCHANGE_OPTIONS_INVALID' }
 * exchange(request) → native Promise<frozen { status, contentType, bytes }> | rejects E7ExchangeError(code). Inert until invoked.
 */
export function createE7RealExchange(input) {
  const o = topData(input, ["provider"], ["primitive"]);
  if (!o || (o.provider !== "hostaway" && o.provider !== "stripe")) return freeze({ ok: false, code: "EXCHANGE_OPTIONS_INVALID" });
  let prim = NODE_HTTPS_PRIMITIVE;
  if ("primitive" in o) { const p = topData(o.primitive, ["Agent", "request"]); if (!p || !isFn(p.Agent) || !isFn(p.request)) return freeze({ ok: false, code: "EXCHANGE_OPTIONS_INVALID" }); prim = freeze(p); }
  const provider = o.provider;
  const { request: primRequest, Agent: PrimAgent } = prim;
  function exchange(request) {
    return new NativePromise((resolve, reject) => {
      // ---------------- state ----------------
      let settled = false; let agent = null; let req = null; let res = null;
      let agentDestroyed = false; let reqDestroyed = false; let resDestroyed = false; let reqClosed = false; let resClosed = false;
      let abortListening = false; let signal = null;
      const owned = [];                                                  // [emitter, event, fn] — ONLY listeners this module attached
      const chunks = []; let total = 0; let status = 0; let contentType = null;
      const settle = (ok, v) => {
        if (settled) return; settled = true;
        if (abortListening) { abortListening = false; try { apply(ET_REMOVE, signal, ["abort", onAbort]); } catch { /* contained */ } }
        if (ok) resolve(v); else reject(new E7ExchangeError(v));
      };
      const fail = (code) => settle(false, nativeAborted(signal) === true ? "EXCHANGE_ABORTED" : code);
      const listen = (em, ev, fn) => { apply(em.on, em, [ev, fn]); owned.push([em, ev, fn]); };
      const unlisten = (em) => { for (let i = owned.length - 1; i >= 0; i--) if (owned[i][0] === em) { const [e, ev, fn] = owned[i]; owned.splice(i, 1); try { apply(e.removeListener, e, [ev, fn]); } catch { /* contained */ } } };
      const destroyAgent = () => { if (agentDestroyed || agent === null) return; agentDestroyed = true; try { apply(agent.destroy, agent, []); } catch { /* contained */ } };
      const destroyRes = () => { if (resDestroyed || res === null) return; resDestroyed = true; try { apply(res.destroy, res, []); } catch { /* contained */ } };
      const destroyReq = () => { if (reqDestroyed || req === null) return; reqDestroyed = true; try { apply(req.destroy, req, []); } catch { /* contained */ } };
      /** the Agent is destroyed only when the request has closed AND there is no response or the response has closed */
      const maybeDestroyAgent = () => { if (reqClosed && (res === null || resClosed)) destroyAgent(); };
      function onAbort() { if (settled) return; settle(false, "EXCHANGE_ABORTED"); destroyRes(); destroyReq(); }
      const sink = () => {};                                             // error observer kept until the owner's documented close
      // ---------------- response handling ----------------
      function adoptResponse(r) {
        res = r;
        listen(res, "error", sink);                                      // protection first, kept until res 'close'
        listen(res, "close", () => { resClosed = true; if (!settled) fail("EXCHANGE_PREMATURE_CLOSE"); unlisten(res); maybeDestroyAgent(); });
      }
      function onResponse(r) {
        if (res !== null) return;                                        // a second response event is ignored (trusted primitive)
        if (!handleShape(r, [])) { if (!settled) fail("EXCHANGE_SETUP_FAILED"); destroyReq(); return; }
        try { adoptResponse(r); } catch { if (!settled) fail("EXCHANGE_SETUP_FAILED"); destroyReq(); return; }
        if (settled) { destroyRes(); return; }                           // late response after an abort / failure: never processed
        const sc = ownData(r, "statusCode");
        if (!Number.isSafeInteger(sc) || sc < 200 || sc > 599) { fail("EXCHANGE_STATUS_INVALID"); destroyRes(); destroyReq(); return; }
        const hd = readHeaders(ownData(r, "rawHeaders"));
        if (!hd) { fail("EXCHANGE_HEADERS_INVALID"); destroyRes(); destroyReq(); return; }
        if (hd.contentEncoding !== null && hd.contentEncoding !== "identity") { fail("EXCHANGE_ENCODING_REFUSED"); destroyRes(); destroyReq(); return; }
        status = sc; contentType = hd.contentType;
        if (sc >= 300 && sc <= 399) {                                    // never followed: no Location read, no body consumed
          settle(true, freeze({ status, contentType, bytes: new NativeUint8Array(0) })); destroyRes(); destroyReq(); return;
        }
        if (hd.contentLength !== null && hd.contentLength > maxBytes) { fail("EXCHANGE_BODY_TOO_LARGE"); destroyRes(); destroyReq(); return; }
        try {
          listen(r, "aborted", () => { if (!settled) { fail("EXCHANGE_PREMATURE_CLOSE"); destroyRes(); destroyReq(); } });
          listen(r, "data", onData);
          listen(r, "end", onEnd);
        } catch { fail("EXCHANGE_SETUP_FAILED"); destroyRes(); destroyReq(); }
      }
      function onData(c) {
        if (settled) return;
        const len = chunkInfo(c);
        if (len === null) { fail("EXCHANGE_PREMATURE_CLOSE"); destroyRes(); destroyReq(); return; }
        if (len === 0) return;                                           // zero-length chunks retain nothing
        if (total + len > maxBytes) { chunks.length = 0; fail("EXCHANGE_BODY_TOO_LARGE"); destroyRes(); destroyReq(); return; }   // overflow chunk never retained
        const copy = new NativeUint8Array(len);
        apply(TA_SET, copy, [c]);                                        // own copy now: later mutation of the source has no effect
        chunks.push(copy); total += len;
      }
      function onEnd() {
        if (settled) return;
        if (ownData(res, "complete") !== true) { chunks.length = 0; fail("EXCHANGE_PREMATURE_CLOSE"); destroyRes(); destroyReq(); return; }
        const out = new NativeUint8Array(total); let off = 0;
        for (const c of chunks) { apply(TA_SET, out, [c, off]); off += apply(TA_LENGTH, c, []); }
        chunks.length = 0;
        settle(true, freeze({ status, contentType, bytes: out }));
      }
      // ---------------- setup ----------------
      let maxBytes = 0;
      try {
        const v = validateRequest(provider, request);
        if (!v) { settle(false, "EXCHANGE_INPUT_INVALID"); return; }
        signal = v.signal; maxBytes = v.maxBytes;
        if (nativeAborted(signal) !== false) { settle(false, "EXCHANGE_ABORTED"); return; }
        try { agent = new PrimAgent(AGENT_OPTIONS); } catch { agent = null; settle(false, "EXCHANGE_SETUP_FAILED"); return; }
        if (agent === null || typeof agent !== "object" || isProxy(agent) || !isFn(agent.destroy)) { const a = agent; agent = null; try { if (a && isFn(a.destroy)) apply(a.destroy, a, []); } catch { /* contained */ } settle(false, "EXCHANGE_SETUP_FAILED"); return; }
        try { apply(ET_ADD, signal, ["abort", onAbort, { once: true }]); abortListening = true; } catch { destroyAgent(); settle(false, "EXCHANGE_SETUP_FAILED"); return; }
        if (nativeAborted(signal) !== false) { destroyAgent(); settle(false, "EXCHANGE_ABORTED"); return; }          // recheck immediately before creation
        const options = freeze({ ...v.options, agent });
        let r;
        try { r = apply(primRequest, undefined, [options]); } catch { destroyAgent(); fail("EXCHANGE_SETUP_FAILED"); return; }   // creation started: no "not sent" claim
        if (!handleShape(r, ["end"])) { destroyAgent(); fail("EXCHANGE_SETUP_FAILED"); return; }
        req = r;
        try { listen(req, "error", (e) => { if (!settled) fail(res === null ? "EXCHANGE_NETWORK_ERROR" : "EXCHANGE_PREMATURE_CLOSE"); }); }
        catch { req = null; destroyAgent(); fail("EXCHANGE_SETUP_FAILED"); return; }       // no error observer on req: never destroyed here (§9 scope)
        try {
          listen(req, "close", () => { reqClosed = true; if (!settled && res === null) fail("EXCHANGE_PREMATURE_CLOSE"); unlisten(req); maybeDestroyAgent(); });
          listen(req, "response", onResponse);
        } catch { fail("EXCHANGE_SETUP_FAILED"); destroyReq(); return; }
        if (settled) { destroyReq(); return; }                          // a reentrant abort / error during setup
        if (nativeAborted(signal) !== false) { fail("EXCHANGE_ABORTED"); destroyReq(); return; }                  // recheck before end(): no bytes after an observed abort
        try { if (v.bodyBytes === null) apply(req.end, req, []); else apply(req.end, req, [v.bodyBytes]); }
        catch { fail("EXCHANGE_SETUP_FAILED"); destroyReq(); }
      } catch { settle(false, "EXCHANGE_SETUP_FAILED"); destroyRes(); destroyReq(); if (req === null) destroyAgent(); }
    });
  }
  return freeze({ ok: true, exchange });
}
