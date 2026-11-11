// scripts/e7-connected/e7-mint-provider-file.mjs — H2 (DRAFT rev 2, offline; ROOT review): owner-only creation of the E7 PROVIDER credential
// file when no saved Hostaway ACCESS TOKEN exists. It requests ONE new access token with an EXISTING Hostaway API key (client credentials;
// NO API-key creation, reset or rotation) and writes the token into the private provider file without ever displaying it.
//   Usage: node scripts/e7-connected/e7-mint-provider-file.mjs <ABSOLUTE path>
//   * Order: grammar → platform → TTY → path prevalidation (H1) → Stripe TEST key, hidden, twice (H1 reader; sk_test_ checked) → Hostaway
//     API-key secret for the FIXED account 201434, hidden, once → path re-prevalidation → ONE token request (fixed URL, POST,
//     redirect:"error", ONE total deadline covering request + body, INCREMENTAL byte cap, no retry) → H1 buildProvider → H1
//     exclusiveWrite (O_EXCL, 0600; the token IS written to this file) → H1 round-trip through the ACCEPTED reader → CREATED_VALIDATED.
//   * Offline checks run BEFORE the request to reduce the chance of a token that cannot be stored. They CANNOT guarantee storage: the
//     file may appear, the write / round-trip may fail, or the returned token may be too large for H1's 4096-byte provider file (JSON
//     escaping included). Those cases end in a TOKEN_MINTED_* code (exit 8) with the file disposition stated truthfully.
//   * AFTER the request is sent, only a 4xx reply is treated as a provider refusal (MINT_REFUSED_HTTP_4XX, exit 7; issuance not expected,
//     still not proof). Network errors, timeouts, 5xx, redirects and unreadable / oversized / invalid replies are MINT_OUTCOME_UNKNOWN_*
//     (exit 9): the provider MAY have issued a token whose value nobody holds. Never rerun blindly after exit 8 or 9 — report to ROOT.
//   * An issued token stays valid at Hostaway (up to 24 months) and is revocable only with its value. This tool never revokes, issues a
//     second token, or retries.
//   * Output: ONE stdout line {"schema","kind","code"[,"httpStatus"]}; stderr = fixed prompt labels only. Never a value, token, secret,
//     URL, path, response body, message or stack. The secret and token live only in local variables; nothing in argv / env / logs.
//   * Reuses H1 exports unchanged (reader, prevalidation, build, exclusive write, round-trip). Cleanup uses H2's own removeOwnStrict
//     (dev/ino + exact bytes), because inode numbers can be reused after an unlink. H1, E4 and the native closure are NOT modified.
//     Not part of the native execution closure.
import process from "node:process";
import * as fsSync from "node:fs";
import { lstat as fspLstat, realpath as fspRealpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readHiddenLineH1, prevalidateTarget, buildProvider, exclusiveWrite, roundTrip, streamDead, LIMITS, LABELS } from "./e7-fill-credential-file.mjs";
import { createNativeAdapters, nativeSupported } from "./probe-cli-main.mjs";

export const SCHEMA = "e7-cred-mint-v2";
export const KIND = "provider-mint";
export const ACCOUNT_ID = "201434";                                   // recorded Hostaway Account ID (ledger 2026-11-01)
export const TOKEN_URL = "https://api.hostaway.com/v1/accessTokens";
export const LIMITS_H2 = Object.freeze({ apiSecret: 512, bodyBytes: 65_536, timeoutMs: 15_000 });
export const LABEL_SECRET = "Hostaway API key SECRET for account 201434 - an EXISTING key, do NOT create or reset one (hidden)";
const PRE = Object.freeze({ USAGE: 2, PLATFORM_UNSUPPORTED: 3, TTY_REQUIRED: 3, TTY_SETUP_FAILED: 3, PATH_INVALID: 4, PARENT_UNSAFE: 4, IN_REPO: 4,
  IN_GIT_TREE: 4, EXISTS: 4, SYMLINK: 4, ENTRY_MISMATCH: 5, ENTRY_INVALID: 5, INPUT_TOO_LONG: 5, KEY_NOT_TEST: 5, ABORTED: 130, INTERNAL: 6 });
export const EXIT = Object.freeze({ CREATED_VALIDATED: 0, ...PRE,
  // request sent; the provider REFUSED (4xx). Issuance not expected (not proof).
  MINT_REFUSED_HTTP_4XX: 7,
  // request sent; outcome UNKNOWN — a token MAY have been issued and nobody holds it. No blind rerun.
  MINT_OUTCOME_UNKNOWN_NETWORK: 9, MINT_OUTCOME_UNKNOWN_HTTP: 9, MINT_OUTCOME_UNKNOWN_RESPONSE: 9, MINT_OUTCOME_UNKNOWN_INTERNAL: 9,
  // a token WAS obtained. Disposition of this run's file stated explicitly:
  TOKEN_MINTED_NO_FILE_CREATED: 8,                 // invalid / too large / target existed / create refused: nothing written by this run
  TOKEN_MINTED_FILE_REMOVED: 8,                    // this run's file was written then removed (identity-checked unlink)
  TOKEN_MINTED_FILE_LEFT_IN_PLACE: 8,              // this run's file may still exist and may contain the token: inspect privately, do not trust
  TOKEN_MINTED_FILE_UNPROVEN_LEFT_IN_PLACE: 8 });  // created, identity not captured: a file at the path may contain the token
const freeze = Object.freeze;

/** Attempt cancellation once; await settlement only until the caller's existing deadline/abort. A late rejection stays handled. */
async function cancelWithinSignal(cancel, signal) {
  let onAbort;
  const pending = Promise.resolve().then(cancel);
  const stopped = new Promise((resolve) => {
    onAbort = resolve;
    if (signal?.aborted) resolve();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
  try { await (signal ? Promise.race([pending, stopped]) : pending); }
  catch { /* cancellation rejection must not replace the original outcome */ }
  finally { signal?.removeEventListener("abort", onAbort); }
}

/** read at most `cap` bytes from a WHATWG body; cancellation shares the caller's deadline/abort. Never drains beyond the cap. */
export async function readBounded(body, cap, signal) {
  if (!body || typeof body.getReader !== "function") return { ok: false, reason: "NO_BODY" };
  let reader; try { reader = body.getReader(); } catch { return { ok: false, reason: "READ_FAILED" }; }
  const cancel = () => cancelWithinSignal(() => reader.cancel(), signal);
  let onAbort; const aborted = new Promise((res) => { onAbort = () => res({ aborted: true }); });
  if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true }); }
  const chunks = []; let total = 0;
  try {
    for (;;) {
      let r;
      try { r = await Promise.race([reader.read(), aborted]); } catch { await cancel(); return { ok: false, reason: "READ_FAILED" }; }
      if (r && r.aborted) { await cancel(); return { ok: false, reason: "ABORTED" }; }
      if (r.done) break;
      const v = r.value;
      if (!(v instanceof Uint8Array)) { await cancel(); return { ok: false, reason: "READ_FAILED" }; }
      if (total + v.length > cap) { await cancel(); return { ok: false, reason: "OVERFLOW" }; }
      chunks.push(v); total += v.length;
    }
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort);
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
  return { ok: true, bytes: Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)), total) };
}
/**
 * removeOwnStrict — STRICTER than H1 removeOwn (inode numbers can be reused after an unlink): remove the file ONLY if it is a regular
 * file with this run's dev/ino AND exactly the bytes this run wrote (read back via an O_NOFOLLOW fd whose fstat matches). Otherwise leave
 * it. Not atomic (check-then-unlink under the trusted parent). → true if removed.
 */
export function removeOwnStrict(path, ident, expected, f = fsSync) {
  if (!ident || !Buffer.isBuffer(expected)) return false;
  let fd = null;
  try {
    const st = f.lstatSync(path, { bigint: true });
    if (!st.isFile() || st.dev !== ident.dev || st.ino !== ident.ino || st.size !== BigInt(expected.length)) return false;
    fd = f.openSync(path, f.constants.O_RDONLY | f.constants.O_NOFOLLOW);
    const fst = f.fstatSync(fd, { bigint: true });
    if (fst.dev !== ident.dev || fst.ino !== ident.ino) return false;
    const buf = Buffer.alloc(expected.length + 1);
    let off = 0;
    for (let i = 0; i <= expected.length + 1; i++) { const n = f.readSync(fd, buf, off, buf.length - off, null); if (n <= 0) break; off += n; if (off >= buf.length) break; }
    if (off !== expected.length || !buf.subarray(0, off).equals(expected)) return false;
    f.closeSync(fd); fd = null;
    f.unlinkSync(path);
    return true;
  } catch { return false; }
  finally { if (fd !== null) { try { f.closeSync(fd); } catch { /* ignore */ } } }
}
const discard = async (resp, signal) => {
  if (resp && resp.body && typeof resp.body.cancel === "function") await cancelWithinSignal(() => resp.body.cancel(), signal);
};

/**
 * ONE token request (fetchImpl injected). One total deadline covers request + body. Returns
 *   { ok:true, token, httpStatus } | { ok:false, code, httpStatus?, sent } — never throws, never retries.
 * sent:false only when nothing was handed to fetchImpl.
 */
export async function requestToken({ fetchImpl, clientSecret, timeoutMs = LIMITS_H2.timeoutMs, signal }) {
  if (typeof fetchImpl !== "function" || typeof clientSecret !== "string" || !/^[\x21-\x7e]{1,512}$/.test(clientSecret)) return { ok: false, code: "ENTRY_INVALID", sent: false };
  const body = new URLSearchParams({ grant_type: "client_credentials", client_id: ACCOUNT_ID, client_secret: clientSecret, scope: "general" }).toString();
  // ONE total deadline (a REF'd timer, so a stalled body can never outlive it) covering request + body; cleared on every return
  const dl = new AbortController(); const timer = setTimeout(() => dl.abort(), timeoutMs);
  const sig = signal ? AbortSignal.any([signal, dl.signal]) : dl.signal;
  try { return await requestOnce({ fetchImpl, body, sig }); } finally { clearTimeout(timer); }
}
async function requestOnce({ fetchImpl, body, sig }) {
  let resp;
  try {
    resp = await fetchImpl(TOKEN_URL, { method: "POST", redirect: "error", signal: sig, body,
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Cache-control": "no-cache", Accept: "application/json" } });
  } catch { return { ok: false, code: "MINT_OUTCOME_UNKNOWN_NETWORK", sent: true }; }   // incl. timeout, abort, redirect, DNS/TLS
  const httpStatus = Number.isSafeInteger(resp?.status) && resp.status >= 100 && resp.status <= 599 ? resp.status : undefined;
  const st = httpStatus === undefined ? {} : { httpStatus };
  if (!resp || resp.ok !== true) {
    await discard(resp, sig);
    if (httpStatus !== undefined && httpStatus >= 400 && httpStatus <= 499) return { ok: false, code: "MINT_REFUSED_HTTP_4XX", ...st, sent: true };
    return { ok: false, code: "MINT_OUTCOME_UNKNOWN_HTTP", ...st, sent: true };          // 5xx / 1xx / 3xx / malformed
  }
  const rb = await readBounded(resp.body, LIMITS_H2.bodyBytes, sig);
  if (!rb.ok) return { ok: false, code: rb.reason === "ABORTED" ? "MINT_OUTCOME_UNKNOWN_NETWORK" : "MINT_OUTCOME_UNKNOWN_RESPONSE", ...st, sent: true };
  let data = null; try { data = JSON.parse(rb.bytes.toString("utf8")); } catch { data = null; }
  const token = data && typeof data === "object" && !Array.isArray(data) ? data.access_token : undefined;
  data = null;
  if (typeof token !== "string" || !/^[\x21-\x7e]{20,4096}$/.test(token)) return { ok: false, code: "MINT_OUTCOME_UNKNOWN_RESPONSE", ...st, sent: true };
  return { ok: true, token, ...st };
}

const defaultRepoRoot = () => join(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** runMint(env) → { exit, line }. All I/O injectable (tests); main() wires the real process with globalThis.fetch. */
export async function runMint({ argv, stdin, stderr, platform, uid, signals, fetchImpl, repoRoot = defaultRepoRoot(), fs = fsSync,
  lstat = fspLstat, realpath = fspRealpath, adapters = createNativeAdapters, roundTripImpl = roundTrip, timeoutMs = LIMITS_H2.timeoutMs }) {
  const say = (code, httpStatus) => freeze({ exit: EXIT[code] ?? EXIT.INTERNAL,
    line: JSON.stringify({ schema: SCHEMA, kind: KIND, code: Object.prototype.hasOwnProperty.call(EXIT, code) ? code : "INTERNAL",
      ...(Number.isSafeInteger(httpStatus) ? { httpStatus } : {}) }) });
  if (!Array.isArray(argv) || argv.length !== 1 || typeof argv[0] !== "string") return say("USAGE");
  const path = argv[0];
  if (!nativeSupported(platform, fs.constants)) return say("PLATFORM_UNSUPPORTED");
  if (!stdin || stdin.isTTY !== true || typeof stdin.setRawMode !== "function") return say("TTY_REQUIRED");
  if (typeof fetchImpl !== "function") return say("INTERNAL");
  const ac = new AbortController(); const isAborted = () => ac.signal.aborted;
  const onAbort = () => { ac.abort(); };
  const SIGS = ["SIGINT", "SIGTERM", "SIGHUP"]; const STREAM_EVS = ["end", "close", "error"];
  for (const s of SIGS) { try { signals.on(s, onAbort); } catch { /* best effort */ } }
  for (const ev of STREAM_EVS) { try { stdin.on(ev, onAbort); } catch { /* best effort */ } }
  // post-request state, kept OUTSIDE the try so every exit (incl. the catch) reports the true disposition
  let sent = false; let minted = false; let created = null;      // created = { ident, bytes } once exclusiveWrite created a file
  const disposition = () => {
    if (!created) return say("TOKEN_MINTED_NO_FILE_CREATED");
    if (!created.ident) return say("TOKEN_MINTED_FILE_UNPROVEN_LEFT_IN_PLACE");
    return say(removeOwnStrict(path, created.ident, created.bytes, fs) ? "TOKEN_MINTED_FILE_REMOVED" : "TOKEN_MINTED_FILE_LEFT_IN_PLACE");
  };
  try {
    if (streamDead(stdin)) ac.abort();
    if (isAborted()) return say("ABORTED");
    const pv = await prevalidateTarget(path, { repoRoot, uid, lstat, realpath });
    if (isAborted() || streamDead(stdin)) return say("ABORTED");
    if (pv) return say(pv);
    const ask = (label, max) => readHiddenLineH1({ input: stdin, output: stderr, label, maxLength: max, signal: ac.signal });
    let key; let secret;
    try {
      const k1 = await ask(LABELS.key1, LIMITS.stripeTestKey); const k2 = await ask(LABELS.key2, LIMITS.stripeTestKey);
      if (k1 !== k2) return say("ENTRY_MISMATCH");
      key = k1;
      const pre = buildProvider("x".repeat(20), key);                 // Stripe key shape BEFORE any network
      if (!pre.ok) return say(pre.code);
      secret = await ask(LABEL_SECRET, LIMITS_H2.apiSecret);
    } catch (e) { const c = e && typeof e.code === "string" && Object.prototype.hasOwnProperty.call(PRE, e.code) ? e.code : "INTERNAL"; return say(c); }
    if (typeof secret !== "string" || !/^[\x21-\x7e]{1,512}$/.test(secret)) return say("ENTRY_INVALID");
    if (isAborted()) return say("ABORTED");
    const pv2 = await prevalidateTarget(path, { repoRoot, uid, lstat, realpath });   // a file that appeared meanwhile must not cost a request
    if (pv2) return say(pv2);
    if (isAborted()) return say("ABORTED");
    sent = true;
    const r = await requestToken({ fetchImpl, clientSecret: secret, signal: ac.signal, timeoutMs });
    secret = null;
    if (!r.ok) return say(r.code, r.httpStatus);
    minted = true;
    let token = r.token;
    let built = buildProvider(token, key);                             // may be TOO_LARGE / invalid even after a valid-looking token
    if (!built.ok) return disposition();
    if (isAborted()) return disposition();
    const w = exclusiveWrite(path, built.bytes, fs);
    if (!w.ok) {
      if (!w.created) return disposition();                            // EXISTS / SYMLINK / create refused: nothing of ours on disk
      created = { ident: w.ident ?? null, bytes: built.bytes };
      return disposition();
    }
    created = { ident: w.ident, bytes: built.bytes };
    built = null;
    if (isAborted()) return disposition();
    let credentialFs;
    try { credentialFs = adapters({ platform, uid, constants: fs.constants, gate: () => { if (isAborted()) throw new Error("ABORTED"); } }).credentialFs; }
    catch { return disposition(); }
    let ok = false;
    try { ok = await roundTripImpl("provider", path, { token, key }, { repoRoot, credentialFs }); } catch { ok = false; }
    token = null; key = null;
    if (isAborted() || ok !== true) return disposition();
    return say("CREATED_VALIDATED");
  } catch {
    if (minted) return disposition();
    if (sent) return say("MINT_OUTCOME_UNKNOWN_INTERNAL");
    return say("INTERNAL");
  } finally {
    for (const s of SIGS) { try { signals.removeListener(s, onAbort); } catch { /* best effort */ } }
    for (const ev of STREAM_EVS) { try { stdin.removeListener(ev, onAbort); } catch { /* best effort */ } }
    try { stdin.setRawMode(false); } catch { /* best effort */ }
  }
}

if (import.meta.main === true) {
  const r = await runMint({ argv: process.argv.slice(2), stdin: process.stdin, stderr: process.stderr, platform: process.platform,
    uid: typeof process.getuid === "function" ? process.getuid() : -1, signals: process, fetchImpl: globalThis.fetch });
  process.stdout.write(r.line + "\n");
  process.exit(r.exit);
}
