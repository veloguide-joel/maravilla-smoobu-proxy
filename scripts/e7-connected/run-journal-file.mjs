// scripts/e7-connected/run-journal-file.mjs — E7 connected-test runner SLICE F: owner-run LOCAL FILE journal (contract:
// claude/e7-connected-file-journal-contract.md). Implements the accepted journal interface { read(), append(record) } consumed by
// run-core.mjs, with D's accepted record / chain / start rules UNCHANGED (only D's exported pure validators are used; no copied state
// machine). OFFLINE crash / restart preparation only: V1 never resumes, truncates, repairs, rotates or mints a run id / key.
//   * Stored bytes = UTF-8 canonicalJson(record) + "\n". Acks / prevHash use D.recordHash (= sha256(JOURNAL_HASH_PREFIX + canonicalJson))
//     unchanged. A line is NOT independently authenticated: integrity is the chain + an optional OUT-OF-BAND trusted head (D's limits).
//   * Ack only after the whole line was written (bounded write loop) AND the file sync resolved. Directory sync once at creation on
//     POSIX platforms (failure fails closed); Windows is classified 'unsupported' deliberately. No power-loss / storage guarantee is made.
//   * One handle operation at a time (read XOR append); close() waits for every started operation, then closes / unlocks exactly once.
//   * Paths: trusted owner-controlled directory; path identity (lstat) and fd identity (fstat) are re-checked at each boundary; observed
//     swaps are refused. No race-free defence against a hostile process renaming ancestors (no openat-style primitives).
//   * Code-only: every refusal is D's JournalError(code) / { ok:false, code }; no path, errno text, record content or caller value leaks.
//   * No timers, env, network, child process, SDK, worker, DB or core import. `process` is read only by the default fs adapter.
import * as fsp from "node:fs/promises";
import { constants as FSC } from "node:fs";
import { isAbsolute, join, normalize, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { types } from "node:util";
import { canonicalJson } from "./run-manifest.mjs";
import { validateRecord, validateIdentity, validateJournal, recordHash, GENESIS_HASH, MAX_RECORDS, IDENTITY_KEYS, TERMINAL_EVENTS, JournalError } from "./run-journal-memory.mjs";

export const RUN_JOURNAL_FILE_VERSION = "e7-run-journal-file-v1";
export const MAX_LINE_BYTES = 16_384;
export const MAX_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_JSON_DEPTH = 6;                       // a D record nests ≤ 3 (record → refusals[] → {key, code})
export const LOCK_BYTES = 33;                          // 32 hex nonce + "\n"
export const POSIX_PLATFORMS = Object.freeze(["aix", "darwin", "freebsd", "linux", "netbsd", "openbsd", "sunos"]);
export const OPEN_KINDS = Object.freeze(["journal-create", "journal-open", "lock-create", "lock-read"]);
export const journalFileName = (runId) => `e7-journal-${runId}.jsonl`;

const freeze = Object.freeze;
const apply = Reflect.apply;
const getDesc = Object.getOwnPropertyDescriptor;
const getDescs = Object.getOwnPropertyDescriptors;
const getProto = Object.getPrototypeOf;
const isFn = (f) => typeof f === "function" && !types.isProxy(f);
const fail = (code) => Promise.reject(new JournalError(code));
const refuse = (code, extra = {}) => freeze({ ok: false, code, ...extra });

// ---- getter-free snapshots -------------------------------------------------------------------------------------------------------
function plainData(o, keys, optional = []) {
  if (o === null || typeof o !== "object" || types.isProxy(o)) return null;
  const p = getProto(o); if (p !== Object.prototype && p !== null) return null;
  const d = getDescs(o); const ks = Reflect.ownKeys(d);
  for (const k of ks) if (typeof k !== "string" || (!keys.includes(k) && !optional.includes(k)) || !("value" in d[k]) || d[k].enumerable !== true) return null;
  for (const k of keys) if (!(k in d)) return null;
  return Object.fromEntries(ks.map((k) => [k, d[k].value]));
}
const safe = (fn) => { try { return fn(); } catch { return null; } };
/** errno-style classification only (never output): an own data `code` string of a non-proxy object */
const errCode = (e) => safe(() => { if (e === null || typeof e !== "object" || types.isProxy(e)) return null; const d = getDesc(e, "code"); return d && "value" in d && typeof d.value === "string" ? d.value : null; });
const STAT_KEYS = ["dev", "ino", "kind", "mode", "nlink", "size", "uid"];
function statRec(v) {
  const s = safe(() => plainData(v, STAT_KEYS));
  if (!s) return null;
  if (typeof s.dev !== "string" || typeof s.ino !== "string" || !["file", "dir", "symlink", "other"].includes(s.kind)) return null;
  for (const k of ["mode", "nlink", "size"]) if (!Number.isSafeInteger(s[k]) || s[k] < 0) return null;
  if (s.uid !== null && (!Number.isSafeInteger(s.uid) || s.uid < 0)) return null;
  return freeze(s);
}
const sameNode = (a, b) => a !== null && b !== null && a.dev === b.dev && a.ino === b.ino;
const ADAPTER_KEYS = ["lstat", "open", "openDir", "platform", "realpath", "uid", "unlink"];
const HANDLE_KEYS = ["close", "read", "stat", "sync", "write"];
function snapAdapter(a) {
  const s = safe(() => plainData(a, ADAPTER_KEYS));
  if (!s) return null;
  for (const k of ["lstat", "open", "openDir", "realpath", "unlink"]) if (!isFn(s[k])) return null;
  if (typeof s.platform !== "string" || (s.uid !== null && (!Number.isSafeInteger(s.uid) || s.uid < 0))) return null;
  return freeze(s);
}
function snapHandle(h, keys) {
  const s = safe(() => plainData(h, keys));
  if (!s || !keys.every((k) => isFn(s[k]))) return null;
  return freeze(s);
}

// ---- the default adapter (node:fs/promises); the ONLY place that reads `process` ------------------------------------------------
const NOFOLLOW = FSC.O_NOFOLLOW ?? 0;
const FLAGS = freeze({
  "journal-create": FSC.O_RDWR | FSC.O_CREAT | FSC.O_EXCL | FSC.O_APPEND | NOFOLLOW,
  "journal-open": FSC.O_RDWR | FSC.O_APPEND | NOFOLLOW,
  "lock-create": FSC.O_WRONLY | FSC.O_CREAT | FSC.O_EXCL | NOFOLLOW,
  "lock-read": FSC.O_RDONLY | NOFOLLOW
});
const kindOf = (s) => (s.isSymbolicLink() ? "symlink" : s.isFile() ? "file" : s.isDirectory() ? "dir" : "other");
const nodeStat = (s) => freeze({ dev: String(s.dev), ino: String(s.ino), kind: kindOf(s), mode: Number(s.mode), nlink: Number(s.nlink),
  size: s.size > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(s.size), uid: Number(s.uid) });
const wrapHandle = (fh) => freeze({
  write: async (buf, off, len) => ({ bytesWritten: (await fh.write(buf, off, len, null)).bytesWritten }),
  read: async (buf, off, len, pos) => ({ bytesRead: (await fh.read(buf, off, len, pos)).bytesRead }),
  sync: async () => { await fh.sync(); },
  stat: async () => nodeStat(await fh.stat({ bigint: true })),
  close: async () => { await fh.close(); }
});
/** createNodeFsAdapter() → the frozen default adapter (exported for tests that wrap it with labelled faults) */
export function createNodeFsAdapter() {
  return freeze({
    realpath: async (p) => fsp.realpath(p),
    lstat: async (p) => nodeStat(await fsp.lstat(p, { bigint: true })),
    open: async (p, kind) => { if (!OPEN_KINDS.includes(kind)) throw new Error("kind"); return wrapHandle(await fsp.open(p, FLAGS[kind], 0o600)); },
    openDir: async (p) => { const fh = await fsp.open(p, FSC.O_RDONLY); return freeze({ sync: async () => { await fh.sync(); }, close: async () => { await fh.close(); } }); },
    unlink: async (p) => { await fsp.unlink(p); },
    platform: process.platform,
    uid: typeof process.getuid === "function" ? process.getuid() : null
  });
}

// ---- bounded, hostile-input-safe line parsing -------------------------------------------------------------------------------------
const NL = 0x0a;
/** JSON nesting depth of one line, scanning bytes outside strings (bounded; never recursive) */
function depthOk(bytes) {
  let depth = 0; let inStr = false; let esc = false;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (inStr) { if (esc) esc = false; else if (b === 0x5c) esc = true; else if (b === 0x22) inStr = false; continue; }
    if (b === 0x22) inStr = true;
    else if (b === 0x7b || b === 0x5b) { depth += 1; if (depth > MAX_JSON_DEPTH) return false; }
    else if (b === 0x7d || b === 0x5d) depth -= 1;
  }
  return true;
}
function deepFreeze(v, d = 0) {
  if (v !== null && typeof v === "object" && d <= MAX_JSON_DEPTH) { for (const k of Object.keys(v)) deepFreeze(v[k], d + 1); freeze(v); }
  return v;
}
/**
 * parseJournalBytes(buf) → { ok:true, records, tail:'complete'|'torn' } | { ok:false, code:'JOURNAL_CORRUPT'|'JOURNAL_TOO_LARGE' }
 * Byte-level newline boundary FIRST: bytes after the last "\n" are a torn tail and are never decoded (an interrupted multi-byte
 * sequence there is torn, not corrupt). Every COMPLETE line must be 1..MAX_LINE_BYTES, valid UTF-8 (fatal), depth-bounded JSON, and
 * byte-identical to canonicalJson(JSON.parse(line)); anything else → JOURNAL_CORRUPT. Canonical-but-invalid records pass through (D decides).
 */
export function parseJournalBytes(buf) {
  try {
    if (!(buf instanceof Uint8Array)) return { ok: false, code: "JOURNAL_CORRUPT" };
    if (buf.length > MAX_FILE_BYTES) return { ok: false, code: "JOURNAL_TOO_LARGE" };
    const last = buf.lastIndexOf(NL);
    const torn = buf.length > 0 && last !== buf.length - 1;
    const records = [];
    const dec = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    let start = 0;
    while (start <= last) {
      const end = buf.indexOf(NL, start);
      const line = buf.subarray(start, end);
      start = end + 1;
      if (records.length >= MAX_RECORDS) return { ok: false, code: "JOURNAL_TOO_LARGE" };
      if (line.length === 0 || line.length > MAX_LINE_BYTES || !depthOk(line)) return { ok: false, code: "JOURNAL_CORRUPT" };
      const text = dec.decode(line);
      const parsed = JSON.parse(text);
      if (canonicalJson(parsed) !== text) return { ok: false, code: "JOURNAL_CORRUPT" };
      records.push(deepFreeze(parsed));
    }
    return { ok: true, records: freeze(records), tail: torn ? "torn" : "complete" };
  } catch { return { ok: false, code: "JOURNAL_CORRUPT" }; }
}
export const encodeRecordLine = (validatedRecord) => Buffer.from(`${canonicalJson(validatedRecord)}\n`, "utf8");

// =================================================================================================================================
/**
 * openFileJournal({ dir, identity, fsAdapter? }) → Promise<frozen { ok:true, journal:{ append, read }, close, status }
 *                                                         | frozen { ok:false, code, cleanup? }>   (never rejects)
 *   dir       absolute, normalized, symlink-free (realpath equal) directory; POSIX: owned by the process uid, not group / world writable
 *   identity  D identity { runId, intentId, manifestHash, baselineCommit }; the file is <dir>/e7-journal-<runId>.jsonl, the lock <file>.lock
 *   fsAdapter TEST-ONLY injection (exact frozen data-method snapshot); default createNodeFsAdapter()
 * journal.append(record) → native Promise<frozen { seq, hash }> | rejects JournalError(code)
 * journal.read()         → native Promise<frozen { records, tail }> | rejects JournalError(code)
 * close()                → the SAME native Promise<frozen { fileClose, lock }> on every call; never rejects; may stay pending behind a
 *                          hung started operation (no timer, no force close)
 * status()               → frozen { state, head, records, created, dirSync, historyValid, busy }
 */
export async function openFileJournal(input) {
  // ---- synchronous snapshot of every caller value, before the first await ----
  const o = safe(() => plainData(input, ["dir", "identity"], ["fsAdapter"]));
  if (!o) return refuse("JOURNAL_OPTIONS_INVALID");
  const idr = validateIdentity(o.identity);
  if (!idr.ok) return refuse("IDENTITY_INVALID");
  const identity = idr.identity;
  const fs = "fsAdapter" in o ? snapAdapter(o.fsAdapter) : createNodeFsAdapter();
  if (!fs) return refuse("JOURNAL_OPTIONS_INVALID");
  const dir = o.dir;
  if (typeof dir !== "string" || dir.length === 0 || dir.length > 4096 || dir.includes("\0") || !isAbsolute(dir)) return refuse("JOURNAL_DIR_INVALID");
  if (normalize(dir) !== dir || (dir.length > 1 && dir.endsWith(sep))) return refuse("JOURNAL_DIR_INVALID");
  const posix = POSIX_PLATFORMS.includes(fs.platform);
  if (!posix && fs.platform !== "win32") return refuse("JOURNAL_PLATFORM_UNSUPPORTED");
  const file = join(dir, journalFileName(identity.runId));
  const lockPath = `${file}.lock`;
  const call = (fn, args) => apply(fn, undefined, args);
  const owned = (s) => !posix || (s.uid === fs.uid && (s.mode & 0o022) === 0);

  // ---- directory ----
  let real;
  try { real = await call(fs.realpath, [dir]); } catch { return refuse("JOURNAL_DIR_INVALID"); }
  if (real !== dir) return refuse("JOURNAL_DIR_UNSAFE");
  let ds;
  try { ds = statRec(await call(fs.lstat, [dir])); } catch { return refuse("JOURNAL_DIR_INVALID"); }
  if (!ds || ds.kind !== "dir" || !owned(ds)) return refuse("JOURNAL_DIR_UNSAFE");

  // ---- lock (ownership); every handle closed at most once ----
  let lockIdent = null;                                        // { dev, ino, nonce } of the lock WE created
  const closeOnce = async (h) => { if (!h || h.closed) return "none"; h.closed = true; try { await call(h.fns.close, []); return "closed"; } catch { return "failed"; } };
  const writeAll = async (h, buf) => {
    let off = 0; let guard = 0;
    while (off < buf.length) {
      if (++guard > buf.length) return false;
      const r = await call(h.fns.write, [buf, off, buf.length - off]);
      const n = safe(() => { const d = getDesc(r, "bytesWritten"); return d && "value" in d ? d.value : null; });
      if (!Number.isSafeInteger(n) || n <= 0 || n > buf.length - off) return false;   // zero / negative / > remaining / non-integer
      off += n;
    }
    return true;
  };
  const openH = async (p, kind) => { const h = snapHandle(await call(fs.open, [p, kind]), HANDLE_KEYS); return h ? { fns: h, closed: false } : null; };
  {
    let lh;
    try { lh = await openH(lockPath, "lock-create"); } catch (e) { return refuse(errCode(e) === "EEXIST" ? "JOURNAL_LOCKED" : "JOURNAL_IO_FAILED"); }
    if (!lh) return refuse("JOURNAL_IO_FAILED");
    const nonce = randomBytes(16).toString("hex");
    let ok = false; let st = null;
    try { ok = await writeAll(lh, Buffer.from(`${nonce}\n`, "utf8")) && (await call(lh.fns.sync, []), true); st = statRec(await call(lh.fns.stat, [])); } catch { ok = false; }
    const c = await closeOnce(lh);
    if (st) lockIdent = { dev: st.dev, ino: st.ino, nonce };
    if (!ok || !st || c !== "closed") { const cleanup = lockIdent ? await releaseLock() : "failed"; return refuse("JOURNAL_IO_FAILED", { cleanup }); }   // unprovable ownership: left for the owner
  }
  /** remove the lock ONLY if it is still the regular, single-link file WE created (dev / ino) holding OUR nonce → code-only outcome */
  async function releaseLock() {
    if (!lockIdent) return "none";
    try {
      const s1 = statRec(await call(fs.lstat, [lockPath]));
      if (!s1 || s1.kind !== "file" || s1.nlink !== 1 || !sameNode(s1, lockIdent) || s1.size !== LOCK_BYTES) return "not_owned";
      const h = await openH(lockPath, "lock-read");
      if (!h) return "failed";
      let content = null; let same = false;
      try {
        const fst = statRec(await call(h.fns.stat, []));
        same = sameNode(fst, lockIdent);
        const buf = Buffer.alloc(LOCK_BYTES + 1);
        let n = 0;
        while (n < buf.length) {
          const r = await call(h.fns.read, [buf, n, buf.length - n, n]);
          const k = safe(() => getDesc(r, "bytesRead").value);
          if (!Number.isSafeInteger(k) || k < 0 || k > buf.length - n) { n = -1; break; }
          if (k === 0) break;
          n += k;
        }
        if (n === LOCK_BYTES) content = buf.subarray(0, n).toString("utf8");
      } catch { content = null; }
      if ((await closeOnce(h)) === "failed") return "failed";
      if (!same || content !== `${lockIdent.nonce}\n`) return "not_owned";
      const s2 = statRec(await call(fs.lstat, [lockPath]));        // re-check the PATH right before unlinking
      if (!s2 || s2.kind !== "file" || !sameNode(s2, lockIdent)) return "not_owned";
      await call(fs.unlink, [lockPath]);
      return "released";
    } catch (e) { return errCode(e) === "ENOENT" ? "not_owned" : "failed"; }
  }

  // ---- journal file: open or create, path + fd identity, initial bounded parse ----
  let fh = null; let created = false; let dirSync = "existing_not_proven"; let fileIdent = null; let knownSize = 0;
  const abort = async (code) => { const fileClose = await closeOnce(fh); const cleanup = await releaseLock(); return refuse(code, { cleanup: fileClose === "failed" ? "failed" : cleanup }); };
  try {
    let ps = null;
    try { ps = statRec(await call(fs.lstat, [file])); if (!ps) return abort("JOURNAL_IO_FAILED"); } catch (e) { if (errCode(e) !== "ENOENT") return abort("JOURNAL_IO_FAILED"); }
    if (ps === null) {
      try { fh = await openH(file, "journal-create"); } catch (e) { return abort(errCode(e) === "EEXIST" ? "JOURNAL_FILE_CHANGED" : "JOURNAL_IO_FAILED"); }
      if (!fh) return abort("JOURNAL_IO_FAILED");
      created = true;
      await call(fh.fns.sync, []);
      if (posix) {                                             // POSIX: the new directory entry is synced BEFORE returning (fail closed)
        let dh;
        try { dh = snapHandle(await call(fs.openDir, [dir]), ["close", "sync"]); } catch { return abort("JOURNAL_DIR_SYNC_FAILED"); }
        if (!dh) return abort("JOURNAL_DIR_SYNC_FAILED");
        let synced = false;
        try { await call(dh.sync, []); synced = true; } catch { synced = false; }
        let dclosed = true;
        try { await call(dh.close, []); } catch { dclosed = false; }
        if (!synced || !dclosed) return abort("JOURNAL_DIR_SYNC_FAILED");
        dirSync = "synced";
      } else dirSync = "unsupported";                          // Windows: deliberate classification (no directory handle sync)
    } else {
      if (ps.kind !== "file" || ps.nlink !== 1 || !owned(ps)) return abort("JOURNAL_FILE_UNSAFE");
      if (ps.size > MAX_FILE_BYTES) return abort("JOURNAL_TOO_LARGE");
      try { fh = await openH(file, "journal-open"); } catch (e) { return abort(errCode(e) === "ELOOP" ? "JOURNAL_FILE_UNSAFE" : "JOURNAL_IO_FAILED"); }
      if (!fh) return abort("JOURNAL_IO_FAILED");
    }
    const fst = statRec(await call(fh.fns.stat, []));
    const pst = statRec(await call(fs.lstat, [file]));
    if (!fst || !pst || fst.kind !== "file" || pst.kind !== "file" || !sameNode(fst, pst) || fst.nlink !== 1) return abort("JOURNAL_FILE_CHANGED");
    if (ps !== null && !sameNode(ps, fst)) return abort("JOURNAL_FILE_CHANGED");
    if (fst.size > MAX_FILE_BYTES) return abort("JOURNAL_TOO_LARGE");
    fileIdent = { dev: fst.dev, ino: fst.ino };
    knownSize = fst.size;
  } catch { return abort("JOURNAL_IO_FAILED"); }

  /** read exactly `size` bytes from offset 0, then prove the file did not grow / shrink meanwhile (bounded; never one unbounded read) */
  async function readExact(size) {
    const buf = Buffer.alloc(size);
    let off = 0;
    while (off < size) {
      const r = await call(fh.fns.read, [buf, off, size - off, off]);
      const n = safe(() => getDesc(r, "bytesRead").value);
      if (!Number.isSafeInteger(n) || n < 0 || n > size - off) return { code: "JOURNAL_IO_FAILED" };
      if (n === 0) return { code: "JOURNAL_FILE_CHANGED" };   // shrank under us
      off += n;
    }
    const probe = Buffer.alloc(1);
    const pr = await call(fh.fns.read, [probe, 0, 1, size]);
    const pn = safe(() => getDesc(pr, "bytesRead").value);
    if (pn !== 0) return { code: pn === 1 ? "JOURNAL_FILE_CHANGED" : "JOURNAL_IO_FAILED" };   // grew under us
    return { buf };
  }
  let known;                                                   // the exact bytes this handle knows are in the file
  let history = [];                                            // parsed records of a VALID history
  let head = null;
  let historyValid = false;
  try {
    const r = await readExact(knownSize);
    if (r.code) return abort(r.code);
    known = r.buf;
    const p = parseJournalBytes(known);
    if (p.ok && p.tail === "complete") {
      const v = validateJournal(p.records, identity);
      if (v.ok) { historyValid = true; history = [...p.records]; head = v.head; }
    }
  } catch { return abort("JOURNAL_IO_FAILED"); }

  // ---- handle state: one operation at a time; close waits for every started operation ----
  const S = { state: "open", busy: null, pending: new Set() };
  const poison = (code) => { if (S.state === "open") S.state = "failed"; return code; };
  const track = (p) => { S.pending.add(p); const done = () => { S.pending.delete(p); }; p.then(done, done); return p; };
  const gateCode = (op) => (S.state === "closing" || S.state === "closed" ? "JOURNAL_CLOSED" : S.state === "failed" ? "JOURNAL_FAILED"
    : S.busy !== null ? (op === "append" ? "APPEND_IN_FLIGHT" : "JOURNAL_BUSY") : null);
  /** the PATH still names our file and the FD still has the size this handle wrote (no unexpected external change) */
  async function checkIdentity() {
    const ps = statRec(await call(fs.lstat, [file]));
    const fst = statRec(await call(fh.fns.stat, []));
    if (!ps || !fst || ps.kind !== "file" || !sameNode(ps, fileIdent) || !sameNode(fst, fileIdent) || fst.nlink !== 1) return "JOURNAL_FILE_CHANGED";
    if (fst.size !== knownSize) return "JOURNAL_FILE_CHANGED";
    return null;
  }

  function append(record) {
    const g = gateCode("append");
    if (g) return fail(g);
    if (!historyValid) return fail("JOURNAL_HISTORY_INVALID");
    const vr = validateRecord(record);                         // ONE frozen copy, before any await
    if (!vr.ok) return fail(vr.code === "ACTION_INVALID" ? "ACTION_INVALID" : "RECORD_INVALID");
    const r = vr.record;
    if (!IDENTITY_KEYS.every((k) => r[k] === identity[k])) return fail("IDENTITY_MISMATCH");
    const expSeq = head ? head.seq + 1 : 1; const expPrev = head ? head.hash : GENESIS_HASH;
    if (r.seq !== expSeq || r.prevHash !== expPrev) return fail("CHAIN_MISMATCH");
    if (history.length && TERMINAL_EVENTS.includes(history.at(-1).event)) return fail("APPEND_AFTER_TERMINAL");
    if (history.length >= MAX_RECORDS) return fail("JOURNAL_FULL");
    if (!validateJournal([...history, r], identity).ok) return fail("ORDER_INVALID");   // D's order / grammar rules, not a copy
    let line;
    try { line = encodeRecordLine(r); } catch { return fail("RECORD_INVALID"); }
    if (line.length > MAX_LINE_BYTES) return fail("LINE_TOO_LONG");
    if (knownSize + line.length > MAX_FILE_BYTES) return fail("JOURNAL_FULL");
    S.busy = "append";
    return track((async () => {
      try {
        const ic = await checkIdentity();
        if (ic) throw new JournalError(poison(ic));
        if (!(await writeAll(fh, line))) throw new JournalError(poison("JOURNAL_IO_FAILED"));   // one append, completed; never retried
        try { await call(fh.fns.sync, []); } catch { throw new JournalError(poison("JOURNAL_IO_FAILED")); }
        known = Buffer.concat([known, line]); knownSize += line.length;
        history.push(r);
        head = freeze({ seq: r.seq, hash: recordHash(r) });
        return freeze({ seq: head.seq, hash: head.hash });
      } catch (e) {
        if (e instanceof JournalError) throw e;
        throw new JournalError(poison("JOURNAL_IO_FAILED"));
      } finally { S.busy = null; }
    })());
  }

  function read() {
    const g = gateCode("read");
    if (g) return fail(g);
    S.busy = "read";
    return track((async () => {
      try {
        const ic = await checkIdentity();
        if (ic) throw new JournalError(poison(ic));
        const r = await readExact(knownSize);
        if (r.code) throw new JournalError(poison(r.code));
        if (Buffer.compare(r.buf, known) !== 0) throw new JournalError(poison("JOURNAL_FILE_CHANGED"));   // same size, different bytes
        const p = parseJournalBytes(r.buf);
        if (!p.ok) throw new JournalError(p.code);             // consistent with open (historyValid stays false); not a poison
        return freeze({ records: p.records, tail: p.tail });
      } catch (e) {
        if (e instanceof JournalError) throw e;
        throw new JournalError(poison("JOURNAL_IO_FAILED"));
      } finally { S.busy = null; }
    })());
  }

  let closeP = null;
  function close() {
    if (closeP) return closeP;
    S.state = "closing";                                       // new read / append rejected immediately
    closeP = (async () => {
      while (S.pending.size) await Promise.allSettled([...S.pending]);   // EVERY started operation (no deadline)
      const fileClose = await closeOnce(fh);
      const lock = await releaseLock();
      S.state = "closed";
      return freeze({ fileClose, lock });
    })().catch(() => freeze({ fileClose: "failed", lock: "failed" }));
    return closeP;
  }
  const status = () => freeze({ state: S.state, head, records: history.length, created, dirSync, historyValid, busy: S.busy });
  return freeze({ ok: true, journal: freeze({ append, read }), close, status });
}
