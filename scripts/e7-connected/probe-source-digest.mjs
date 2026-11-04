// scripts/e7-connected/probe-source-digest.mjs — E7 probe CLI: PURE source-digest helper (contract claude/e7-connected-probe-cli-contract.md
// §11.4, accepted at d81fea91). It hashes a byte snapshot SUPPLIED by its caller over the fixed reviewed closure; it reads no disk, imports
// none of the listed entries and discovers nothing. A future entrypoint (CLOSED, not implemented) would read the files with its own
// no-follow adapter, call this helper and compare the digest BEFORE importing the command module. Today the entrypoint file does not
// exist, so NO real enforcement exists; tests use a synthetic placeholder for it. The digest proves nothing about bytes later loaded.
import { createHash } from "node:crypto";
import { types } from "node:util";

export const SOURCE_DIGEST_PREFIX = "e7-probe-source-v1\n";
export const SOURCE_CLOSURE = Object.freeze(["package.json", "scripts/e7-connected/probe-cli-main.mjs", "scripts/e7-connected/probe-source-digest.mjs",
  "scripts/e7-connected/probe-command.mjs", "scripts/e7-connected/probe-env-preflight.mjs", "scripts/e7-connected/probe-credential-file.mjs",
  "scripts/e7-connected/readonly-probe.mjs", "scripts/e7-connected/http-transports.mjs", "scripts/e7-connected/real-exchange.mjs",
  "lib/checkout/compensation-proof.js", "lib/checkout/recovery-plan.js", "lib/checkout/capture-proof.js", "lib/checkout/intent-state.js"]);
export const MAX_SOURCE_FILE_BYTES = 262144;
export const MAX_SOURCE_TOTAL_BYTES = 2097152;

// ---- intrinsics captured at load ---------------------------------------------------------------------------------------------------
const freeze = Object.freeze;
const apply = Reflect.apply;
const ownKeys = Reflect.ownKeys;
const getDesc = Object.getOwnPropertyDescriptor;
const getDescs = Object.getOwnPropertyDescriptors;
const getProto = Object.getPrototypeOf;
const isArray = Array.isArray;
const U8 = Uint8Array;
const U8_PROTO = Uint8Array.prototype;
const TA_PROTO = getProto(Uint8Array.prototype);
const TA_LENGTH = getDesc(TA_PROTO, "length").get;
const TA_BUFFER = getDesc(TA_PROTO, "buffer").get;
const TA_SET = TA_PROTO.set;
const { isProxy, isUint8Array, isSharedArrayBuffer } = types;
const ENC = new TextEncoder();
const ENCODE = TextEncoder.prototype.encode;

/** genuine, non-shared Uint8Array of 1…max bytes → an OWNED copy; null otherwise (no caller getter, iterator or shadow is read) */
export function ownedBytes(v, max) {
  try {
    if (v === null || typeof v !== "object" || isProxy(v) || !isUint8Array(v) || getProto(v) !== U8_PROTO) return null;
    const buf = apply(TA_BUFFER, v, []); if (isSharedArrayBuffer(buf)) return null;
    const n = apply(TA_LENGTH, v, []);                                  // a detached view reports 0 → refused by the lower bound
    if (!Number.isSafeInteger(n) || n < 1 || n > max) return null;
    const out = new U8(n); apply(TA_SET, out, [v]);
    return out;
  } catch { return null; }
}
/** own enumerable DATA string-keyed properties exactly `keys` of a plain / null-prototype non-proxy object → null-proto copy | null */
function dataExactly(o, keys) {
  try {
    if (o === null || typeof o !== "object" || isProxy(o) || isArray(o)) return null;
    const p = getProto(o); if (p !== Object.prototype && p !== null) return null;
    const d = getDescs(o); const ks = ownKeys(d); if (ks.length !== keys.length) return null;
    const out = Object.create(null);
    for (const k of ks) { if (typeof k !== "string" || !keys.includes(k) || !("value" in d[k]) || d[k].enumerable !== true) return null; out[k] = d[k].value; }
    return out;
  } catch { return null; }
}
/** genuine dense array (non-proxy, exact prototype) → frozen descriptor copy of its elements, or null */
function denseArray(a, len) {
  try {
    if (a === null || typeof a !== "object" || isProxy(a) || !isArray(a) || getProto(a) !== Array.prototype) return null;
    const d = getDescs(a); const ks = ownKeys(d);
    if (ks.length !== len + 1 || !("length" in d) || d.length.value !== len) return null;
    const out = [];
    for (let i = 0; i < len; i++) { const e = d[String(i)]; if (!e || !("value" in e)) return null; out.push(e.value); }
    return out;
  } catch { return null; }
}

/**
 * computeSourceDigest(snapshot) → frozen { ok:true, digest } | frozen { ok:false, code:'SOURCE_SNAPSHOT_INVALID' }
 *   snapshot: dense array of exactly SOURCE_CLOSURE.length own-data { path, bytes } in closure order; bytes 1…256 KiB each, ≤ 2 MiB total.
 *   digest = SHA-256( PREFIX ‖ Σ utf8(path) ‖ 0x00 ‖ ascii(byteLength) ‖ 0x00 ‖ bytes ‖ 0x00 ), lowercase hex.
 */
export function computeSourceDigest(snapshot) {
  const bad = freeze({ ok: false, code: "SOURCE_SNAPSHOT_INVALID" });
  const arr = denseArray(snapshot, SOURCE_CLOSURE.length); if (arr === null) return bad;
  const files = []; let total = 0;
  for (let i = 0; i < arr.length; i++) {
    const e = dataExactly(arr[i], ["bytes", "path"]);
    if (!e || e.path !== SOURCE_CLOSURE[i]) return bad;
    const b = ownedBytes(e.bytes, MAX_SOURCE_FILE_BYTES); if (b === null) return bad;
    total += b.length; if (total > MAX_SOURCE_TOTAL_BYTES) return bad;
    files.push([SOURCE_CLOSURE[i], b]);
  }
  try {
    const h = createHash("sha256"); const z = new U8([0]);
    h.update(apply(ENCODE, ENC, [SOURCE_DIGEST_PREFIX]));
    for (const [p, b] of files) { h.update(apply(ENCODE, ENC, [p])); h.update(z); h.update(apply(ENCODE, ENC, [String(b.length)])); h.update(z); h.update(b); h.update(z); }
    return freeze({ ok: true, digest: h.digest("hex") });
  } catch { return bad; }
}
