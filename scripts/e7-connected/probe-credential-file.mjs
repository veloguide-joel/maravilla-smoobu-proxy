// scripts/e7-connected/probe-credential-file.mjs — E7 probe CLI stage C1 (OFFLINE): bounded, POSIX-only, read-only credential-file
// ingress over an INJECTED read-only fs adapter. Contract: claude/e7-connected-probe-cli-contract.md rev 2 (accepted at 34903dec) §2.2 +
// C1 map (§10).
//   * NO default fs: this module never imports node:fs and never reads `process` or env. A NEW adapter schema (not the file journal's).
//   * Finite OPERATION bounds only; NO elapsed-time bound — a hanging or synchronously blocking injected (or later real) fs keeps the
//     promise pending / blocks; no timer, retry or fallback exists here.
//   * TRUST: an owner-controlled directory namespace; the checks detect changes within their window but do not defeat a same-uid or root
//     actor; there is no atomic no-rename guarantee and this is not a sandbox.
//   * Results: PUBLIC failures are code-only `{ ok:false, code, closeState }`; a success carries a PRIVATE capability whose secrets are
//     own NON-ENUMERABLE properties — never to be serialized, logged or written by any caller.
import { types } from "node:util";

export const CREDENTIAL_CODES = Object.freeze(["CRED_OK", "CRED_INPUT_INVALID", "CRED_ADAPTER_INVALID", "CRED_PLATFORM_UNSUPPORTED", "CRED_PATH_INVALID", "CRED_PATH_NOT_CANONICAL",
  "CRED_IN_REPO", "CRED_IN_GIT_TREE", "CRED_MISSING", "CRED_NOT_REGULAR", "CRED_OWNER", "CRED_MODE", "CRED_LINKS", "CRED_SIZE", "CRED_CHANGED", "CRED_IO", "CRED_CLOSE_FAILED",
  "CRED_PARSE", "CRED_SHAPE", "CRED_KEY_NOT_TEST"]);
export const CLOSE_STATES = Object.freeze(["CLOSED", "CLOSE_FAILED", "UNCLOSABLE", "NOT_OPENED"]);
export const OPEN_KIND = "credential-read";                         // the single reviewed kind: O_RDONLY | O_NOFOLLOW (later real adapter)
export const MAX_CREDENTIAL_BYTES = 4096;
export const READ_BUFFER_BYTES = MAX_CREDENTIAL_BYTES + 1;          // one-byte growth probe
export const MAX_READ_CALLS = READ_BUFFER_BYTES + 1;
export const MAX_ANCESTORS = 64;
export const STAT_KEYS = Object.freeze(["dev", "ino", "kind", "mode", "nlink", "size", "uid", "mtimeNs", "ctimeNs"]);

// ---- intrinsics captured at load ----------------------------------------------------------------------------------------------------
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
const NativeUint8Array = Uint8Array;
const TA_FILL = getProto(Uint8Array.prototype).fill;
const TA_SUBARRAY = getProto(Uint8Array.prototype).subarray;
const DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });   // a BOM is KEPT in the text and then refused by the parser
const DECODE = TextDecoder.prototype.decode;
const WELL_KNOWN = new Set(Object.getOwnPropertyNames(Symbol).map((k) => Symbol[k]).filter((s) => typeof s === "symbol"));
const { isProxy, isPromise } = types;
const isFn = (f) => typeof f === "function" && !isProxy(f);
const isObj = (o) => o !== null && typeof o === "object" && !isProxy(o);

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
/** settle an UNPATCHED native promise into our own promise of { ok, v | e }; null (nothing attached, nothing assimilated) otherwise.
 *  Residual: a non-native / thenable / patched return is never observed; any rejection it carries is caller-owned. */
function settleNative(p) {
  if (!isNativePromise(p)) return null;
  return new NativePromise((res) => { try { apply(P_THEN, p, [(v) => res({ ok: true, v }), (e) => res({ ok: false, e })]); } catch { res(null); } });
}
/** own enumerable DATA properties exactly `keys` of a plain / null-prototype object → null-proto copy, or null (no getter ever runs) */
function dataExactly(o, keys) {
  try {
    if (!isObj(o) || Array.isArray(o)) return null;
    const p = getProto(o); if (p !== Object.prototype && p !== null) return null;
    const d = getDescs(o); const ks = ownKeys(d);
    if (ks.length !== keys.length) return null;
    const out = Object.create(null);
    for (const k of ks) { if (typeof k !== "string" || !keys.includes(k) || !("value" in d[k]) || d[k].enumerable !== true) return null; out[k] = d[k].value; }
    return out;
  } catch { return null; }
}
/** own DATA `code` of a rejection reason (descriptor read; accessor / proxy / non-object → null) */
const errCode = (e) => { try { if (!isObj(e)) return null; const d = getDesc(e, "code"); return d && "value" in d && typeof d.value === "string" ? d.value : null; } catch { return null; } };
const isAbsent = (e) => { const c = errCode(e); return c === "ENOENT" || c === "ENOTDIR"; };

// ---- canonical POSIX paths -------------------------------------------------------------------------------------------------------
/** absolute, ≤ 4096, no NUL, no empty / '.' / '..' segment, no trailing '/'; "/" itself only when allowRoot */
function canonical(p, allowRoot) {
  if (typeof p !== "string" || p.length < 1 || p.length > 4096 || p[0] !== "/" || p.includes("\0")) return false;
  if (p === "/") return allowRoot;
  const segs = p.slice(1).split("/");
  return segs.every((s) => s !== "" && s !== "." && s !== "..");
}
const dirname = (p) => { const i = p.lastIndexOf("/"); return i === 0 ? "/" : p.slice(0, i); };
const join = (d, name) => (d === "/" ? `/${name}` : `${d}/${name}`);
/** is `p` equal to or under `root`? root "/" contains everything (fail closed: there is nowhere outside it) */
const within = (p, root) => root === "/" || p === root || p.startsWith(`${root}/`);

// ---- stat records -----------------------------------------------------------------------------------------------------------------
const DEC_RE = /^(0|[1-9][0-9]{0,39})$/;
const KINDS = ["file", "dir", "symlink", "other"];
/** strict stat-record schema (before any comparison) → frozen copy or null */
function statRecord(v) {
  const s = dataExactly(v, STAT_KEYS);
  if (!s) return null;
  if (typeof s.dev !== "string" || !DEC_RE.test(s.dev) || typeof s.ino !== "string" || !DEC_RE.test(s.ino) || !KINDS.includes(s.kind)) return null;
  if (!Number.isSafeInteger(s.mode) || s.mode < 0 || s.mode > 0o177777) return null;
  if (!Number.isSafeInteger(s.nlink) || s.nlink < 0 || s.nlink > 0xffffffff || !Number.isSafeInteger(s.uid) || s.uid < 0 || s.uid > 0xffffffff) return null;
  if (!Number.isSafeInteger(s.size) || s.size < 0) return null;
  if (typeof s.mtimeNs !== "string" || !DEC_RE.test(s.mtimeNs) || typeof s.ctimeNs !== "string" || !DEC_RE.test(s.ctimeNs)) return null;
  return freeze(s);
}
/** credential-file policy on ONE stat → refusal code or null (checked on every stat: pre lstat, both fd stats, post-read lstat) */
function policy(s, uid) {
  if (s.kind !== "file") return "CRED_NOT_REGULAR";
  if (s.uid !== uid) return "CRED_OWNER";
  if ((s.mode & 0o7777) !== 0o600) return "CRED_MODE";
  if (s.nlink !== 1) return "CRED_LINKS";
  if (s.size < 1 || s.size > MAX_CREDENTIAL_BYTES) return "CRED_SIZE";
  return null;
}
const sameRecord = (a, b) => STAT_KEYS.every((k) => a[k] === b[k]);

// ---- strict object-of-strings JSON (no JSON.parse: duplicate keys, incl. escaped aliases, must be refused, not last-key-wins) --------
/** → { ok:true, obj:Map } | { ok:false, code:'CRED_PARSE' | 'CRED_SHAPE' } */
function parseCredentialJson(text) {
  let i = 0; const n = text.length;
  const ws = () => { while (i < n && (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r")) i++; };
  const str = () => {
    if (text[i] !== "\"") return null; i++; let out = "";
    while (i < n) {
      const c = text[i];
      if (c === "\"") { i++; return out; }
      if (c.charCodeAt(0) < 0x20) return null;
      if (c === "\\") {
        const e = text[i + 1]; i += 2;
        if (e === "\"" || e === "\\" || e === "/") out += e; else if (e === "b") out += "\b"; else if (e === "f") out += "\f"; else if (e === "n") out += "\n";
        else if (e === "r") out += "\r"; else if (e === "t") out += "\t";
        else if (e === "u") { const h = text.slice(i, i + 4); if (!/^[0-9A-Fa-f]{4}$/.test(h)) return null; out += String.fromCharCode(parseInt(h, 16)); i += 4; }
        else return null;
        continue;
      }
      out += c; i++;
    }
    return null;
  };
  ws(); if (text[i] !== "{") return { ok: false, code: "CRED_PARSE" }; i++; ws();
  const obj = new Map();
  if (text[i] === "}") { i++; }
  else {
    for (;;) {
      const k = str(); if (k === null) return { ok: false, code: "CRED_PARSE" };
      ws(); if (text[i] !== ":") return { ok: false, code: "CRED_PARSE" }; i++; ws();
      if (text[i] !== "\"") return { ok: false, code: text[i] === undefined ? "CRED_PARSE" : "CRED_SHAPE" };   // non-string value: type confusion refused
      const v = str(); if (v === null) return { ok: false, code: "CRED_PARSE" };
      if (obj.has(k)) return { ok: false, code: "CRED_SHAPE" };                                            // duplicate (incl. escaped alias)
      obj.set(k, v); ws();
      if (text[i] === ",") { i++; ws(); continue; }
      if (text[i] === "}") { i++; break; }
      return { ok: false, code: "CRED_PARSE" };
    }
  }
  ws(); if (i !== n) return { ok: false, code: "CRED_PARSE" };
  return { ok: true, obj };
}
const TOKEN_RE = /^[\x21-\x7e]{1,4096}$/;                            // = T's Hostaway token rule
const TEST_KEY_RE = /^sk_test_[A-Za-z0-9]{1,247}$/;                  // = T's TEST key rule

const fail = (code, closeState) => freeze({ ok: false, code, closeState });

/**
 * readProbeCredentialFile({ path, repoRoot, needs, fs }) → native Promise<frozen result>; never rejects.
 *   PUBLIC failure: { ok:false, code, closeState } · PRIVATE success: { ok:true, closeState:'CLOSED', credentials } (secrets non-enumerable)
 */
export function readProbeCredentialFile(input) {
  return new NativePromise((resolve) => {
    let inner;
    try { inner = run(input); } catch { resolve(fail("CRED_INPUT_INVALID", "NOT_OPENED")); return; }
    apply(P_THEN, inner, [resolve, () => resolve(fail("CRED_IO", "NOT_OPENED"))]);
  });
}

async function run(input) {
  // ---- inputs + adapter: snapshotted once, getter-free -----------------------------------------------------------------------------
  const o = dataExactly(input, ["fs", "needs", "path", "repoRoot"]);
  if (!o) return fail("CRED_INPUT_INVALID", "NOT_OPENED");
  const needs = dataExactly(o.needs, ["hostaway", "stripe"]);
  if (!needs || typeof needs.hostaway !== "boolean" || typeof needs.stripe !== "boolean" || (!needs.hostaway && !needs.stripe)) return fail("CRED_INPUT_INVALID", "NOT_OPENED");
  if (!canonical(o.path, false) || !canonical(o.repoRoot, true)) return fail("CRED_INPUT_INVALID", "NOT_OPENED");
  const fs = dataExactly(o.fs, ["lstat", "open", "platform", "realpath", "uid"]);
  if (!fs || typeof fs.platform !== "string" || !Number.isSafeInteger(fs.uid) || fs.uid < 0 || fs.uid > 0xffffffff || !isFn(fs.lstat) || !isFn(fs.realpath) || !isFn(fs.open)) return fail("CRED_ADAPTER_INVALID", "NOT_OPENED");
  const { lstat, realpath, open, uid } = fs; const path = o.path;
  if (fs.platform !== "linux" && fs.platform !== "darwin") return fail("CRED_PLATFORM_UNSUPPORTED", "NOT_OPENED");
  const parent = dirname(path);
  // ancestor bound decided from the path text BEFORE any fs call: parent's segments + the root itself
  if ((parent === "/" ? 1 : parent.split("/").length) > MAX_ANCESTORS) return fail("CRED_PATH_INVALID", "NOT_OPENED");

  /** call an adapter function once → { ok, v | e } | null (invalid promise / sync throw) */
  const call = async (fn, args) => { let p; try { p = apply(fn, undefined, args); } catch { return null; } const s = settleNative(p); return s === null ? null : await s; };
  const doRealpath = async (p) => { const r = await call(realpath, [p]); if (r === null) return { code: "CRED_ADAPTER_INVALID" }; if (!r.ok) return { code: "CRED_IO" };
    return canonical(r.v, true) ? { v: r.v } : { code: "CRED_ADAPTER_INVALID" }; };
  const doLstat = async (p) => { const r = await call(lstat, [p]); if (r === null) return { code: "CRED_ADAPTER_INVALID" }; if (!r.ok) return isAbsent(r.e) ? { absent: true } : { code: "CRED_IO" };
    const s = statRecord(r.v); return s ? { v: s } : { code: "CRED_ADAPTER_INVALID" }; };

  // ---- (2) canonical parent, repo; (3) .git ancestor walk --------------------------------------------------------------------------
  const rp = await doRealpath(parent); if (rp.code) return fail(rp.code, "NOT_OPENED");
  if (rp.v !== parent) return fail("CRED_PATH_NOT_CANONICAL", "NOT_OPENED");
  const rr = await doRealpath(o.repoRoot); if (rr.code) return fail(rr.code, "NOT_OPENED");
  if (within(parent, rr.v) || within(path, rr.v)) return fail("CRED_IN_REPO", "NOT_OPENED");
  let dir = parent; let walked = 0;
  for (;;) {
    walked += 1; if (walked > MAX_ANCESTORS) return fail("CRED_PATH_INVALID", "NOT_OPENED");   // unreachable after the textual bound (invariant)
    const g = await doLstat(join(dir, ".git"));
    if (g.code) return fail(g.code, "NOT_OPENED");
    if (!g.absent) return fail("CRED_IN_GIT_TREE", "NOT_OPENED");
    if (dir === "/") break;
    dir = dirname(dir);
  }
  // ---- (4) pre lstat + policy -----------------------------------------------------------------------------------------------------
  const pre = await doLstat(path);
  if (pre.code) return fail(pre.code, "NOT_OPENED");
  if (pre.absent) return fail("CRED_MISSING", "NOT_OPENED");
  const p0 = policy(pre.v, uid); if (p0) return fail(p0, "NOT_OPENED");

  // ---- (5) open; close captured FIRST; every later path closes exactly once ---------------------------------------------------------
  const opened = await call(open, [path, OPEN_KIND]);
  if (opened === null) return fail("CRED_ADAPTER_INVALID", "NOT_OPENED");   // residual: a caller-owned thenable may have acquired something
  if (!opened.ok) return fail("CRED_IO", "NOT_OPENED");
  const h = opened.v;
  let closeFn = null;
  if (isObj(h)) { try { const cd = getDesc(h, "close"); if (cd && "value" in cd && isFn(cd.value)) closeFn = cd.value; } catch { closeFn = null; } }
  const buf = new NativeUint8Array(READ_BUFFER_BYTES);
  let primary = null; let text = null;
  try {
    const hd = dataExactly(h, ["close", "read", "stat"]);
    if (!hd || closeFn === null || !isFn(hd.read) || !isFn(hd.stat)) { primary = "CRED_ADAPTER_INVALID"; }
    else {
      const { read, stat } = hd;
      const doStat = async () => { const r = await call(stat, []); if (r === null) return { code: "CRED_ADAPTER_INVALID" }; if (!r.ok) return { code: "CRED_IO" };
        const s = statRecord(r.v); return s ? { v: s } : { code: "CRED_ADAPTER_INVALID" }; };
      // (6) fd stat: policy first, then identity with the path lstat
      const s1 = await doStat();
      if (s1.code) primary = s1.code;
      else if (policy(s1.v, uid)) primary = policy(s1.v, uid);
      else if (!sameRecord(s1.v, pre.v)) primary = "CRED_CHANGED";
      // (7) bounded read into the owned buffer only
      let offset = 0;
      if (primary === null) {
        let calls = 0; let eof = false;
        while (!eof && offset < READ_BUFFER_BYTES) {
          calls += 1; if (calls > MAX_READ_CALLS) { primary = "CRED_IO"; break; }     // unreachable under strict positive progress (invariant)
          const r = await call(read, [buf, offset, READ_BUFFER_BYTES - offset]);
          if (r === null) { primary = "CRED_ADAPTER_INVALID"; break; }
          if (!r.ok) { primary = "CRED_IO"; break; }
          const n = r.v;
          if (!Number.isSafeInteger(n) || n < 0 || n > READ_BUFFER_BYTES - offset) { primary = "CRED_IO"; break; }
          if (n === 0) eof = true; else offset += n;
        }
        if (primary === null) {
          if (offset >= READ_BUFFER_BYTES) primary = "CRED_SIZE";                   // the growth-probe byte arrived
          else if (offset !== s1.v.size) primary = "CRED_CHANGED";                 // early EOF / truncation / growth within the bound
        }
      }
      // (8) fd stat after the read: full policy, then identity with s1
      if (primary === null) {
        const s2 = await doStat();
        if (s2.code) primary = s2.code; else if (policy(s2.v, uid)) primary = policy(s2.v, uid); else if (!sameRecord(s2.v, s1.v)) primary = "CRED_CHANGED";
        // (9) post-read PATH lstat: detects a renamed / replaced path
        if (primary === null) {
          const post = await doLstat(path);
          if (post.code) primary = post.code; else if (post.absent) primary = "CRED_CHANGED";
          else if (policy(post.v, uid)) primary = policy(post.v, uid); else if (!sameRecord(post.v, s2.v)) primary = "CRED_CHANGED";
        }
      }
      if (primary === null) { try { text = apply(DECODE, DECODER, [apply(TA_SUBARRAY, buf, [0, offset])]); } catch { primary = "CRED_PARSE"; } }
    }
  } catch { if (primary === null) primary = "CRED_IO"; }
  finally { try { apply(TA_FILL, buf, [0]); } catch { /* best effort; JS strings are not provably erased */ } }

  // ---- (10) close exactly once, after every started handle operation settled (sequential awaits); never retried ---------------------
  let closeState;
  if (closeFn === null) closeState = "UNCLOSABLE";                          // no safely callable close: no cleanup claimed
  else {
    const c = await call(closeFn, []);
    // acknowledged ONLY by a native fulfilment with exactly `undefined` (§2.2 schema); any other fulfilment value, a rejection or an
    // unobservable reply is CLOSE_FAILED — evaluation of the trusted adapter's contract, not proof the descriptor is closed
    closeState = c !== null && c.ok && c.v === undefined ? "CLOSED" : "CLOSE_FAILED";
  }
  if (primary !== null) { text = null; return fail(primary, closeState); }
  if (closeState !== "CLOSED") { text = null; return fail("CRED_CLOSE_FAILED", closeState); }   // success and every secret withheld

  // ---- (11) strict parse + exact provider-needed keys ------------------------------------------------------------------------------
  const parsed = parseCredentialJson(text); text = null;
  if (!parsed.ok) return fail(parsed.code, "CLOSED");
  const want = [...(needs.hostaway ? ["hostawayToken"] : []), ...(needs.stripe ? ["stripeTestKey"] : [])];
  if (parsed.obj.size !== want.length || !want.every((k) => parsed.obj.has(k))) return fail("CRED_SHAPE", "CLOSED");
  const tok = parsed.obj.get("hostawayToken"); const key = parsed.obj.get("stripeTestKey");
  if (needs.hostaway && !TOKEN_RE.test(tok)) return fail("CRED_SHAPE", "CLOSED");
  if (needs.stripe && !TEST_KEY_RE.test(key)) return fail("CRED_KEY_NOT_TEST", "CLOSED");       // live / restricted / other: never echoed
  const credentials = Object.create(null);
  if (needs.hostaway) Object.defineProperty(credentials, "hostawayToken", { value: tok, enumerable: false });
  if (needs.stripe) Object.defineProperty(credentials, "stripeTestKey", { value: key, enumerable: false });
  freeze(credentials);
  return freeze({ ok: true, closeState: "CLOSED", credentials });
}
