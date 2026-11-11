// scripts/e7-connected/e7-fill-credential-file.mjs — H1 (root ruling: P-B + F-A): guided HIDDEN-ENTRY creation of ONE owner credential file.
//   Usage: node scripts/e7-connected/e7-fill-credential-file.mjs <app-login|provider> <ABSOLUTE path>
//   * Kinds: app-login (the mv_booking_app_dev login file; the EXISTING password is REUSED, never reset) | provider (Hostaway token + Stripe
//     TEST key). There is NO report kind. The target must NOT exist (O_EXCL); no existing file is ever overwritten or read.
//   * Order: grammar (pure) → platform → TTY → path prevalidation → hidden double entry (H1-local bounded reader) → in-memory build +
//     validation → ONE synchronous exclusive create (dev/ino captured immediately after open) / write / fsync / close → signal check →
//     round-trip through the ACCEPTED reader (accepted native credentialFs, F-A) → signal check → CREATED_VALIDATED.
//   * Output: ONE stdout line {"schema","kind","code"}; stderr = fixed prompt labels only. Never a value, URL, path, message or stack.
//   * No network / DNS / pg / launcher. Importing probe-cli-main loads built-ins incl. node:https (module load only; never invoked).
//   * Input lifecycle is RUN-WIDE (ROOT H1 review): an already ended / destroyed / closed stdin, or 'end' / 'close' / 'error' at ANY point
//     from before path prevalidation until the final cleanup, aborts the run's single AbortController — so EOF between prompts, during
//     prompt setup or during prevalidation can never leave the run waiting. Prompt-local listeners stay prompt-local (own listeners only).
//   * Cleanup after a create is an identity check (lstat dev/ino) + unlink under the prevalidated, trusted parent — NOT an atomic
//     compare-and-unlink. Nothing is recoverable from SIGKILL / a process crash. JS strings cannot be wiped from memory.
import process from "node:process";
import { StringDecoder } from "node:string_decoder";
import * as fsSync from "node:fs";
import { lstat as fspLstat, realpath as fspRealpath } from "node:fs/promises";
import { dirname, join, normalize, isAbsolute, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { readOneDbLogin } from "./db-credential-file.mjs";
import { readProbeCredentialFile } from "./probe-credential-file.mjs";
import { createNativeAdapters, nativeSupported } from "./probe-cli-main.mjs";

export const SCHEMA = "e7-cred-fill-v1";
export const KINDS = Object.freeze(["app-login", "provider"]);
export const LIMITS = Object.freeze({ password: 512, hostawayToken: 4096, stripeTestKey: 256, chunk: 65_536, fileBytes: 4096, connectionString: 2048 });
// the launcher's ENDPOINTS.direct literal values, checked TEXTUALLY (the launcher is never imported: it pulls pg)
export const DIRECT = Object.freeze({ host: "db.mxotevtiscernhqilyiu.supabase.co", port: "5432", database: "postgres" });
export const APP_USER = "mv_booking_app_dev";
export const APP_ROLE = "mv_booking_app";
export const LABELS = Object.freeze({
  pw1: "mv_booking_app_dev password - REUSE the existing value, do NOT reset (hidden)", pw2: "Confirm mv_booking_app_dev password (hidden)",
  tok1: "Hostaway access token (hidden)", tok2: "Confirm Hostaway access token (hidden)",
  key1: "Stripe TEST secret key sk_test_... (hidden)", key2: "Confirm Stripe TEST secret key (hidden)" });
export const EXIT = Object.freeze({ CREATED_VALIDATED: 0, USAGE: 2, PLATFORM_UNSUPPORTED: 3, TTY_REQUIRED: 3, TTY_SETUP_FAILED: 3,
  PATH_INVALID: 4, PARENT_UNSAFE: 4, IN_REPO: 4, IN_GIT_TREE: 4, EXISTS: 4, SYMLINK: 4,
  ENTRY_MISMATCH: 5, ENTRY_INVALID: 5, INPUT_TOO_LONG: 5, KEY_NOT_TEST: 5, TOO_LARGE: 5,
  OWNERSHIP_UNPROVEN_LEFT_IN_PLACE: 6, WRITE_FAILED_REMOVED: 6, WRITE_FAILED_LEFT_IN_PLACE: 6, ROUNDTRIP_FAILED_REMOVED: 6,
  ROUNDTRIP_FAILED_LEFT_IN_PLACE: 6, INTERNAL: 6, ABORTED: 130, ABORTED_REMOVED: 130, ABORTED_LEFT_IN_PLACE: 130 });
const freeze = Object.freeze;
class H1Error extends Error { constructor(code) { super(code); this.name = "H1Error"; this.code = code; } }
const err = (code) => new H1Error(code);
/** the stream can deliver no further input (already ended / destroyed / closed) */
export const streamDead = (s) => !!s && (s.readableEnded === true || s.destroyed === true || s.closed === true);
const codeOf = (e) => (e instanceof H1Error && Object.prototype.hasOwnProperty.call(EXIT, e.code) ? e.code : "INTERNAL");

/**
 * readHiddenLineH1 — H1-local bounded echo-off reader. Same state machine as the accepted E4 readHiddenLine (ESC / CSI / SS3 skipping,
 * Ctrl-C / Ctrl-D abort FIRST, CR / LF finish with leading-terminator skip, Backspace / DEL, other controls dropped) plus: per-prompt
 * maxLength, UTF-8 assembled across chunks (StringDecoder), bounded chunk size, end / close / error → ABORTED, AbortSignal → ABORTED.
 * finish() runs once: removes ONLY its own listeners, restores raw mode if it set it, pauses, clears the value.
 */
export function readHiddenLineH1({ input, output, label, maxLength, skipLeadingTerminators = true, signal }) {
  return new Promise((resolve, reject) => {
    if (!input || input.isTTY !== true || typeof input.setRawMode !== "function") { reject(err("TTY_REQUIRED")); return; }
    if (!Number.isSafeInteger(maxLength) || maxLength < 1) { reject(err("INTERNAL")); return; }
    if ((signal && signal.aborted) || streamDead(input)) { reject(err("ABORTED")); return; }
    const dec = new StringDecoder("utf8");
    let value = ""; let done = false; let esc = 0; let rawSet = false;
    const own = [];
    const finish = (e) => {
      if (done) return;
      done = true;
      for (const [ev, fn] of own) { try { input.removeListener(ev, fn); } catch { /* best effort */ } }
      if (signal) { try { signal.removeEventListener("abort", onAbort); } catch { /* best effort */ } }
      if (rawSet) { try { input.setRawMode(false); } catch { /* best effort */ } }
      try { if (typeof input.pause === "function") input.pause(); } catch { /* best effort */ }
      try { output.write("\n"); } catch { /* best effort */ }
      try { dec.end(); } catch { /* discard */ }
      if (e) { value = ""; reject(e); } else { const v = value; value = ""; resolve(v); }
    };
    const onAbort = () => finish(err("ABORTED"));
    const onData = (chunk) => {
      if (done) return;
      let text;
      try {
        if (typeof chunk === "string") { if (chunk.length > LIMITS.chunk) return finish(err("INPUT_TOO_LONG")); text = chunk; }
        else { if (!chunk || typeof chunk.length !== "number" || chunk.length > LIMITS.chunk) return finish(err("INPUT_TOO_LONG")); text = dec.write(chunk); }
      } catch { return finish(err("ENTRY_INVALID")); }
      for (const ch of text) {
        if (ch === "\u0003" || ch === "\u0004") return finish(err("ABORTED"));
        if (esc === 1) { esc = ch === "[" ? 2 : ch === "O" ? 3 : 0; continue; }
        if (esc === 2) { if (ch >= "@" && ch <= "~") esc = 0; continue; }
        if (esc === 3) { esc = 0; continue; }
        if (ch === "\u001b") { esc = 1; continue; }
        if (ch === "\r" || ch === "\n") { if (skipLeadingTerminators === true && value.length === 0) continue; return finish(); }
        if (ch === "\u007f" || ch === "\b") { value = value.slice(0, -1); continue; }
        if (ch < " ") continue;
        if (value.length >= maxLength) return finish(err("INPUT_TOO_LONG"));
        value += ch;
      }
    };
    const onEnd = () => finish(err("ABORTED"));
    const stop = () => done || (signal && signal.aborted) || streamDead(input);
    try {
      // abort / end / close / error listeners FIRST, so an event during the label write or setRawMode is never missed
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      for (const [ev, fn] of [["end", onEnd], ["close", onEnd], ["error", onEnd]]) { input.on(ev, fn); own.push([ev, fn]); }
      if (stop()) return finish(err("ABORTED"));
      output.write(`${label}: `);
      if (stop()) return finish(err("ABORTED"));                       // never enable raw mode after an abort / EOF
      // Own restoration before calling setup: it can abort or throw after changing terminal mode.
      rawSet = true; input.setRawMode(true);
      if (stop()) return finish(err("ABORTED"));
      input.on("data", onData); own.push(["data", onData]);
      if (stop()) return finish(err("ABORTED"));                       // re-checked after setup, before resume
      if (typeof input.resume === "function") input.resume();
    } catch { finish(err("TTY_SETUP_FAILED")); }
  });
}

/** in-memory app-login bytes: role mv_booking_app, user mv_booking_app_dev, percent-encoded password, FIXED direct endpoint; verified textually */
export function buildAppLogin(pw) {
  if (typeof pw !== "string" || pw.length < 1 || pw.length > LIMITS.password) return { ok: false, code: "ENTRY_INVALID" };
  let enc; try { enc = encodeURIComponent(pw); } catch { return { ok: false, code: "ENTRY_INVALID" }; }    // lone surrogate → URIError
  const cs = `postgresql://${APP_USER}:${enc}@${DIRECT.host}:${DIRECT.port}/${DIRECT.database}`;
  if (cs.length > LIMITS.connectionString || !/^[\x21-\x7e]+$/.test(cs)) return { ok: false, code: "TOO_LARGE" };
  let u; try { u = new URL(cs); } catch { return { ok: false, code: "ENTRY_INVALID" }; }
  let dec; try { dec = decodeURIComponent(u.password); } catch { return { ok: false, code: "ENTRY_INVALID" }; }
  if (u.protocol !== "postgresql:" || u.username !== APP_USER || dec !== pw || u.hostname !== DIRECT.host || u.port !== DIRECT.port
    || u.pathname !== `/${DIRECT.database}` || u.search !== "" || u.hash !== "") return { ok: false, code: "ENTRY_INVALID" };
  const bytes = Buffer.from(JSON.stringify({ schema: "e7-db-login-v1", role: APP_ROLE, connectionString: cs }) + "\n", "utf8");
  if (bytes.length > LIMITS.fileBytes) return { ok: false, code: "TOO_LARGE" };
  return { ok: true, bytes, connectionString: cs };
}
/** in-memory provider bytes: exactly hostawayToken + stripeTestKey (sk_test_ only), shapes = the accepted reader's */
export function buildProvider(token, key) {
  if (typeof token !== "string" || !/^[\x21-\x7e]{1,4096}$/.test(token)) return { ok: false, code: "ENTRY_INVALID" };
  if (typeof key !== "string" || !/^sk_test_[A-Za-z0-9]{1,247}$/.test(key)) return { ok: false, code: "KEY_NOT_TEST" };
  const bytes = Buffer.from(JSON.stringify({ hostawayToken: token, stripeTestKey: key }) + "\n", "utf8");
  if (bytes.length > LIMITS.fileBytes) return { ok: false, code: "TOO_LARGE" };
  return { ok: true, bytes };
}

const canonical = (p) => typeof p === "string" && p.length > 1 && p.length <= 4096 && !p.includes("\0") && isAbsolute(p) && normalize(p) === p && !p.endsWith(sep);
const within = (p, root) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);
/** prevalidation BEFORE entry: canonical path, absent target, trusted parent (realpath-equal, own uid, mode & 022 == 0), not in repo / .git */
export async function prevalidateTarget(path, { repoRoot, uid, lstat = fspLstat, realpath = fspRealpath }) {
  if (!canonical(path)) return "PATH_INVALID";
  try { const t = await lstat(path); return t.isSymbolicLink() ? "SYMLINK" : "EXISTS"; }
  catch (e) { if (!e || e.code !== "ENOENT") return "PATH_INVALID"; }
  const parent = dirname(path);
  let ps; try { ps = await lstat(parent); } catch { return "PARENT_UNSAFE"; }
  if (!ps.isDirectory() || ps.uid !== uid || (ps.mode & 0o022) !== 0) return "PARENT_UNSAFE";
  let rp; try { rp = await realpath(parent); } catch { return "PARENT_UNSAFE"; }
  if (rp !== parent) return "PARENT_UNSAFE";
  let rr; try { rr = await realpath(repoRoot); } catch { return "INTERNAL"; }
  if (within(parent, rr) || within(path, rr)) return "IN_REPO";
  for (let d = parent, i = 0; i < 64; i++) {
    try { await lstat(join(d, ".git")); return "IN_GIT_TREE"; } catch (e) { if (!e || e.code !== "ENOENT") return "PARENT_UNSAFE"; }
    const up = dirname(d); if (up === d) break; d = up;
  }
  return null;
}

/** ONE synchronous exclusive create / write / fsync / close; dev/ino captured IMMEDIATELY after open (before any write) */
export function exclusiveWrite(path, bytes, f = fsSync) {
  const C = f.constants;
  let fd;
  try { fd = f.openSync(path, C.O_CREAT | C.O_EXCL | C.O_WRONLY | C.O_NOFOLLOW, 0o600); }
  catch (e) { return { ok: false, created: false, code: e && e.code === "EEXIST" ? "EXISTS" : e && e.code === "ELOOP" ? "SYMLINK" : "WRITE_FAILED_LEFT_IN_PLACE_NOT_CREATED" }; }
  let ident;
  try { const st = f.fstatSync(fd, { bigint: true }); ident = { dev: st.dev, ino: st.ino }; }
  catch { try { f.closeSync(fd); } catch { /* best effort */ } return { ok: false, created: true, ident: null, code: "OWNERSHIP_UNPROVEN_LEFT_IN_PLACE" }; }
  try {
    let off = 0; let calls = 0;
    while (off < bytes.length) {
      calls += 1; if (calls > bytes.length + 1) throw new Error("e7");
      const n = f.writeSync(fd, bytes, off, bytes.length - off);
      if (!Number.isSafeInteger(n) || n <= 0 || n > bytes.length - off) throw new Error("e7");
      off += n;
    }
    f.fsyncSync(fd);
  } catch { try { f.closeSync(fd); } catch { /* best effort */ } return { ok: false, created: true, ident, code: "WRITE_FAILED" }; }
  try { f.closeSync(fd); } catch { return { ok: false, created: true, ident, code: "WRITE_FAILED" }; }
  return { ok: true, created: true, ident };
}
/** identity-checked removal of the file THIS run created (final lstat dev/ino under the trusted parent; NOT atomic) → true if removed */
export function removeOwn(path, ident, f = fsSync) {
  if (!ident) return false;
  try {
    const st = f.lstatSync(path, { bigint: true });
    if (!st.isFile() || st.dev !== ident.dev || st.ino !== ident.ino) return false;
    f.unlinkSync(path);
    return true;
  } catch { return false; }
}

/** accepted-reader round-trip with the accepted native credentialFs (F-A); compares in memory only */
export async function roundTrip(kind, path, expected, { repoRoot, credentialFs }) {
  try {
    if (kind === "app-login") {
      const r = await readOneDbLogin({ path, repoRoot, fs: credentialFs, slot: "app" });
      if (!r || r.ok !== true || !r.login || r.login.role !== APP_ROLE) return false;
      const cs = r.login.connectionString;
      if (cs !== expected.connectionString) return false;
      return decodeURIComponent(new URL(cs).password) === expected.pw;
    }
    const r = await readProbeCredentialFile({ path, repoRoot, needs: { hostaway: true, stripe: true }, fs: credentialFs });
    return !!r && r.ok === true && r.credentials.hostawayToken === expected.token && r.credentials.stripeTestKey === expected.key;
  } catch { return false; }
}

const defaultRepoRoot = () => join(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** runFill(env) → { exit, line }. All I/O is injectable for tests; main() wires the real process. */
export async function runFill({ argv, stdin, stderr, platform, uid, signals, repoRoot = defaultRepoRoot(), fs = fsSync, lstat = fspLstat, realpath = fspRealpath, adapters = createNativeAdapters }) {
  const say = (kind, code) => freeze({ exit: EXIT[code] ?? EXIT.INTERNAL, line: JSON.stringify({ schema: SCHEMA, kind, code: Object.prototype.hasOwnProperty.call(EXIT, code) ? code : "INTERNAL" }) });
  if (!Array.isArray(argv) || argv.length !== 2 || !KINDS.includes(argv[0]) || typeof argv[1] !== "string") return say(null, "USAGE");
  const [kind, path] = argv;
  if (!nativeSupported(platform, fs.constants)) return say(kind, "PLATFORM_UNSUPPORTED");
  if (!stdin || stdin.isTTY !== true || typeof stdin.setRawMode !== "function") return say(kind, "TTY_REQUIRED");
  const ac = new AbortController();
  const isAborted = () => ac.signal.aborted;
  const onSig = () => { ac.abort(); };
  const onStreamEnd = () => { ac.abort(); };                           // RUN-WIDE: EOF / close / error at any point aborts the run
  const SIGS = ["SIGINT", "SIGTERM", "SIGHUP"]; const STREAM_EVS = ["end", "close", "error"];
  for (const s of SIGS) { try { signals.on(s, onSig); } catch { /* best effort */ } }
  for (const ev of STREAM_EVS) { try { stdin.on(ev, onStreamEnd); } catch { /* best effort */ } }
  const restore = () => { try { stdin.setRawMode(false); } catch { /* best effort */ } };
  try {
    if (streamDead(stdin)) ac.abort();
    if (isAborted()) return say(kind, "ABORTED");
    const pv = await prevalidateTarget(path, { repoRoot, uid, lstat, realpath });
    if (isAborted() || streamDead(stdin)) return say(kind, "ABORTED");  // an abort / EOF during prevalidation wins over its result
    if (pv) return say(kind, pv);
    const ask = (label, maxLength) => readHiddenLineH1({ input: stdin, output: stderr, label, maxLength, signal: ac.signal });
    const twice = async (l1, l2, max) => { const a = await ask(l1, max); const b = await ask(l2, max); if (a !== b) throw err("ENTRY_MISMATCH"); return a; };
    let built; let expected;
    try {
      if (kind === "app-login") {
        const pw = await twice(LABELS.pw1, LABELS.pw2, LIMITS.password);
        built = buildAppLogin(pw); expected = { pw, connectionString: built.connectionString };
      } else {
        const token = await twice(LABELS.tok1, LABELS.tok2, LIMITS.hostawayToken);
        const key = await twice(LABELS.key1, LABELS.key2, LIMITS.stripeTestKey);
        built = buildProvider(token, key); expected = { token, key };
      }
    } catch (e) { return say(kind, codeOf(e)); }
    if (isAborted()) return say(kind, "ABORTED");
    if (!built.ok) return say(kind, built.code);
    // ---- ONE synchronous block (no await inside): exclusive create, immediate identity, bounded write, fsync, close ----
    const w = exclusiveWrite(path, built.bytes, fs);
    if (!w.ok) {
      if (!w.created) return say(kind, w.code === "EXISTS" || w.code === "SYMLINK" ? w.code : "WRITE_FAILED_LEFT_IN_PLACE");
      if (w.code === "OWNERSHIP_UNPROVEN_LEFT_IN_PLACE") return say(kind, w.code);
      return say(kind, removeOwn(path, w.ident, fs) ? "WRITE_FAILED_REMOVED" : "WRITE_FAILED_LEFT_IN_PLACE");
    }
    if (isAborted()) return say(kind, removeOwn(path, w.ident, fs) ? "ABORTED_REMOVED" : "ABORTED_LEFT_IN_PLACE");
    let credentialFs;
    try { credentialFs = adapters({ platform, uid, constants: fs.constants, gate: () => { if (isAborted()) throw err("ABORTED"); } }).credentialFs; }
    catch { return say(kind, removeOwn(path, w.ident, fs) ? "ROUNDTRIP_FAILED_REMOVED" : "ROUNDTRIP_FAILED_LEFT_IN_PLACE"); }
    const ok = await roundTrip(kind, path, expected, { repoRoot, credentialFs });
    expected = null; built = null;
    if (isAborted()) return say(kind, removeOwn(path, w.ident, fs) ? "ABORTED_REMOVED" : "ABORTED_LEFT_IN_PLACE");
    if (!ok) return say(kind, removeOwn(path, w.ident, fs) ? "ROUNDTRIP_FAILED_REMOVED" : "ROUNDTRIP_FAILED_LEFT_IN_PLACE");
    return say(kind, "CREATED_VALIDATED");
  } catch { return say(kind, "INTERNAL"); }
  finally {
    for (const s of SIGS) { try { signals.removeListener(s, onSig); } catch { /* best effort */ } }
    for (const ev of STREAM_EVS) { try { stdin.removeListener(ev, onStreamEnd); } catch { /* best effort */ } }
    restore();
  }
}

if (import.meta.main === true) {
  const r = await runFill({ argv: process.argv.slice(2), stdin: process.stdin, stderr: process.stderr, platform: process.platform,
    uid: typeof process.getuid === "function" ? process.getuid() : -1, signals: process });
  process.stdout.write(r.line + "\n");
  process.exit(r.exit);
}
