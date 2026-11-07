// scripts/e7-connected/run-journal-file-v2.mjs — E7 M2-E: OFFLINE v2 FILE journal + a SEPARATELY PERSISTED head file (contract:
// claude/e7-run-journal-file-v2.md; root review b323715f route A with corrections 1–4). Inert: no CLI, no env, no timers, no network.
//   * Reuses the accepted v1 file-journal codec + node fs adapter BYTE-EXACT (imports only), and the accepted v2 validators.
//   * Writer = CREATION ONLY (never reopen / resume / repair). ACK only after: journal line written + fsync, THEN head line written + fsync
//     (and, at open, both directory entries fsynced). Any ambiguity poisons the handle. No ACK-delivery bit exists or is invented.
//   * Recovery = read-only DIAGNOSTICS: disk relation + validated chain + evidence classes; permission is ALWAYS all-false.
//   * Same-machine separate directory = separately persisted head, NOT independent authentication / failure domain (same uid / disk = TRUST).
import { isAbsolute, join, normalize, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { types } from "node:util";
import { canonicalJson } from "./run-manifest.mjs";
import { parseJournalBytes, encodeRecordLine, createNodeFsAdapter, MAX_LINE_BYTES, MAX_FILE_BYTES, LOCK_BYTES, POSIX_PLATFORMS } from "./run-journal-file.mjs";
import { bindManifestV2, validateRecordBound, validateJournalBound, journalFactsBound, recordHashV2, GENESIS_HASH } from "./run-journal-memory-v2.mjs";

export const RUN_JOURNAL_FILE_V2_VERSION = "e7-run-journal-file-v2";
export const journalFileNameV2 = (runId) => `e7-journal-v2-${runId}.jsonl`;
export const headFileNameV2 = (runId) => `e7-head-v2-${runId}.jsonl`;
export const RELATIONS = Object.freeze(["GENESIS_EMPTY", "AT_ESCROW_HEAD", "JOURNAL_AHEAD_1", "HEAD_AHEAD", "GAP_GT_1", "HASH_MISMATCH", "HEAD_IDENTITY_MISMATCH",
  "JOURNAL_INVALID", "JOURNAL_MISSING", "HEAD_MISSING", "BOTH_MISSING", "CORRUPT", "UNSAFE"]);
export const NO_PERMISSION = Object.freeze({ newRun: false, resume: false, adopt: false, cleanup: false, send: false });

const freeze = Object.freeze;
const apply = Reflect.apply;
const getDesc = Object.getOwnPropertyDescriptor;
const getDescs = Object.getOwnPropertyDescriptors;
const getProto = Object.getPrototypeOf;
const isFn = (f) => typeof f === "function" && !types.isProxy(f);
const refuse = (code, extra = {}) => freeze({ ok: false, code, ...extra });
class JournalErrorV2 extends Error { constructor(code) { super(code); this.name = "JournalErrorV2"; this.code = code; } }
const fail = (code) => Promise.reject(new JournalErrorV2(code));
const HEX64 = /^[0-9a-f]{64}$/;

// ---- getter-free snapshots (same rules as the v1 file journal; re-stated here because v1 does not export them) ---------------------
function plainData(o, keys, optional = []) {
  if (o === null || typeof o !== "object" || types.isProxy(o)) return null;
  const p = getProto(o); if (p !== Object.prototype && p !== null) return null;
  const d = getDescs(o); const ks = Reflect.ownKeys(d);
  for (const k of ks) if (typeof k !== "string" || (!keys.includes(k) && !optional.includes(k)) || !("value" in d[k]) || d[k].enumerable !== true) return null;
  for (const k of keys) if (!(k in d)) return null;
  return Object.fromEntries(ks.map((k) => [k, d[k].value]));
}
const safe = (fn) => { try { return fn(); } catch { return null; } };
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
const sameNode = (a, b) => !!a && !!b && a.dev === b.dev && a.ino === b.ino;
const ADAPTER_KEYS = ["lstat", "open", "openDir", "platform", "realpath", "uid", "unlink"];
const HANDLE_KEYS = ["close", "read", "stat", "sync", "write"];
function snapAdapter(a) {
  const s = safe(() => plainData(a, ADAPTER_KEYS));
  if (!s) return null;
  for (const k of ["lstat", "open", "openDir", "realpath", "unlink"]) if (!isFn(s[k])) return null;
  if (typeof s.platform !== "string" || (s.uid !== null && (!Number.isSafeInteger(s.uid) || s.uid < 0))) return null;
  return freeze(s);
}
function snapHandle(h, keys) { const s = safe(() => plainData(h, keys)); return s && keys.every((k) => isFn(s[k])) ? freeze(s) : null; }

/** shared fs helpers over ONE adapter snapshot */
function fsKit(fs) {
  const call = (fn, args) => apply(fn, undefined, args);
  const owned = (s) => s.uid === fs.uid && (s.mode & 0o022) === 0;
  const openH = async (p, kind) => { const h = snapHandle(await call(fs.open, [p, kind]), HANDLE_KEYS); return h ? { fns: h, closed: false } : null; };
  const closeOnce = async (h) => { if (!h || h.closed) return "none"; h.closed = true; try { await call(h.fns.close, []); return "closed"; } catch { return "failed"; } };
  const writeAll = async (h, buf) => {
    let off = 0; let n = 0;
    while (off < buf.length) {
      if (++n > buf.length) return false;
      const r = await call(h.fns.write, [buf, off, buf.length - off]);
      const k = safe(() => { const d = getDesc(r, "bytesWritten"); return d && "value" in d ? d.value : null; });
      if (!Number.isSafeInteger(k) || k <= 0 || k > buf.length - off) return false;
      off += k;
    }
    return true;
  };
  /** exactly `size` bytes from offset 0, then prove no growth (bounded) */
  const readExact = async (h, size) => {
    const buf = Buffer.alloc(size); let off = 0;
    while (off < size) {
      const r = await call(h.fns.read, [buf, off, size - off, off]);
      const k = safe(() => getDesc(r, "bytesRead").value);
      if (!Number.isSafeInteger(k) || k < 0 || k > size - off) return { code: "IO" };
      if (k === 0) return { code: "CHANGED" };
      off += k;
    }
    const probe = Buffer.alloc(1);
    const pr = await call(h.fns.read, [probe, 0, 1, size]);
    const pk = safe(() => getDesc(pr, "bytesRead").value);
    if (pk !== 0) return { code: pk === 1 ? "CHANGED" : "IO" };
    return { buf };
  };
  /** a directory that is safe to hold the files: absolute, normalized, realpath-equal, owned, not group / world writable */
  const checkDir = async (dir) => {
    if (typeof dir !== "string" || dir.length === 0 || dir.length > 4096 || dir.includes("\0") || !isAbsolute(dir)) return { code: "JOURNAL_DIR_INVALID" };
    if (normalize(dir) !== dir || (dir.length > 1 && dir.endsWith(sep))) return { code: "JOURNAL_DIR_INVALID" };
    let real; try { real = await call(fs.realpath, [dir]); } catch { return { code: "JOURNAL_DIR_INVALID" }; }
    if (real !== dir) return { code: "JOURNAL_DIR_UNSAFE" };
    let ds; try { ds = statRec(await call(fs.lstat, [dir])); } catch { return { code: "JOURNAL_DIR_INVALID" }; }
    if (!ds || ds.kind !== "dir" || !owned(ds)) return { code: "JOURNAL_DIR_UNSAFE" };
    return { stat: ds };
  };
  /** ENOENT → null; a stat record otherwise; other errors → "IO" */
  const lstatOrNull = async (p) => { try { return statRec(await call(fs.lstat, [p])) ?? "IO"; } catch (e) { return errCode(e) === "ENOENT" ? null : "IO"; } };
  const syncDir = async (dir) => {
    let dh; try { dh = snapHandle(await call(fs.openDir, [dir]), ["close", "sync"]); } catch { return false; }
    if (!dh) return false;
    let ok = false; try { await call(dh.sync, []); ok = true; } catch { ok = false; }
    let closed = true; try { await call(dh.close, []); } catch { closed = false; }
    return ok && closed;
  };
  return { call, owned, openH, closeOnce, writeAll, readExact, checkDir, lstatOrNull, syncDir };
}

/** an exclusive nonce lock (the v1 lock format) with an ownership-proven release */
function makeLock(fs, K, path) {
  let ident = null;
  async function acquire() {
    let h;
    try { h = await K.openH(path, "lock-create"); } catch (e) { return errCode(e) === "EEXIST" ? "LOCKED" : "IO"; }
    if (!h) return "IO";
    const nonce = randomBytes(16).toString("hex");
    let ok = false; let st = null;
    try { ok = await K.writeAll(h, Buffer.from(`${nonce}\n`, "utf8")) && (await K.call(h.fns.sync, []), true); st = statRec(await K.call(h.fns.stat, [])); } catch { ok = false; }
    const c = await K.closeOnce(h);
    if (st) ident = { dev: st.dev, ino: st.ino, nonce };
    return ok && st && c === "closed" ? "ACQUIRED" : "IO";
  }
  async function release() {
    if (!ident) return "none";
    try {
      const s1 = statRec(await K.call(fs.lstat, [path]));
      if (!s1 || s1.kind !== "file" || s1.nlink !== 1 || !sameNode(s1, ident) || s1.size !== LOCK_BYTES) return "not_owned";
      const h = await K.openH(path, "lock-read");
      if (!h) return "failed";
      let content = null; let same = false;
      try {
        same = sameNode(statRec(await K.call(h.fns.stat, [])), ident);
        const r = await K.readExact(h, LOCK_BYTES);
        if (r.buf) content = r.buf.toString("utf8");
      } catch { content = null; }
      if ((await K.closeOnce(h)) === "failed") return "failed";
      if (!same || content !== `${ident.nonce}\n`) return "not_owned";
      const s2 = statRec(await K.call(fs.lstat, [path]));
      if (!s2 || s2.kind !== "file" || !sameNode(s2, ident)) return "not_owned";
      await K.call(fs.unlink, [path]);
      ident = null;
      return "released";
    } catch (e) { return errCode(e) === "ENOENT" ? "not_owned" : "failed"; }
  }
  return { acquire, release, held: () => ident !== null };
}

const headLine = (identity, seq, hash) => Buffer.from(`${canonicalJson({ v: 2, runId: identity.runId, manifestHash: identity.manifestHash, seq, hash })}\n`, "utf8");

// =================================================================================================================================
/**
 * openFileJournalV2({ journalDir, headDir, manifest, fsAdapter? }) → Promise<frozen { ok:true, journal:{ append, read }, close, status }
 *                                                                     | frozen { ok:false, code, cleanup? }>   (never rejects)
 */
export async function openFileJournalV2(input) {
  const o = safe(() => plainData(input, ["journalDir", "headDir", "manifest"], ["fsAdapter"]));
  if (!o) return refuse("JOURNAL_OPTIONS_INVALID");
  const b = bindManifestV2(o.manifest);
  if (!b.ok) return refuse(b.manifestCode || "MANIFEST_INVALID");
  const binding = b.binding; const identity = binding.identity;
  const fs = "fsAdapter" in o ? snapAdapter(o.fsAdapter) : createNodeFsAdapter();
  if (!fs) return refuse("JOURNAL_OPTIONS_INVALID");
  if (!POSIX_PLATFORMS.includes(fs.platform)) return refuse("JOURNAL_PLATFORM_UNSUPPORTED");
  const K = fsKit(fs);
  const { journalDir, headDir } = o;
  const jd = await K.checkDir(journalDir); if (jd.code) return refuse(jd.code);
  const hd = await K.checkDir(headDir); if (hd.code) return refuse(hd.code);
  if (sameNode(jd.stat, hd.stat) || journalDir === headDir) return refuse("JOURNAL_DIR_ALIAS");
  const jPath = join(journalDir, journalFileNameV2(identity.runId)); const hPath = join(headDir, headFileNameV2(identity.runId));
  const jLock = makeLock(fs, K, `${jPath}.lock`); const hLock = makeLock(fs, K, `${hPath}.lock`);
  const cleanupLocks = async () => { const h = await hLock.release(); const j = await jLock.release(); return h === "failed" || j === "failed" ? "failed" : "released_own"; };

  // ---- creation only: neither file may exist (checked before AND enforced by O_EXCL) ----
  for (const p of [jPath, hPath]) { const s = await K.lstatOrNull(p); if (s === "IO") return refuse("JOURNAL_IO_FAILED"); if (s !== null) return refuse("JOURNAL_EXISTS"); }
  // ---- two exclusive locks; failing the second releases ONLY the first, ownership-proven ----
  const a1 = await jLock.acquire();
  if (a1 !== "ACQUIRED") { const cleanup = await jLock.release(); return refuse(a1 === "LOCKED" ? "JOURNAL_LOCKED" : "JOURNAL_IO_FAILED", { cleanup }); }
  const a2 = await hLock.acquire();
  if (a2 !== "ACQUIRED") { const own = await hLock.release(); const cleanup = await jLock.release(); return refuse(a2 === "LOCKED" ? "HEAD_LOCKED" : "JOURNAL_IO_FAILED", { cleanup: own === "failed" ? "failed" : cleanup }); }
  // ---- files (exclusive create) + fsync, then BOTH directory fsyncs, before ok ----
  let jh = null; let hh = null;
  const abort = async (code) => { const c1 = await K.closeOnce(jh); const c2 = await K.closeOnce(hh); const cl = await cleanupLocks(); return refuse(code, { cleanup: c1 === "failed" || c2 === "failed" ? "failed" : cl }); };
  const ident = {};
  try {
    for (const [p, slot] of [[jPath, "j"], [hPath, "h"]]) {
      let h;
      try { h = await K.openH(p, "journal-create"); } catch (e) { return abort(errCode(e) === "EEXIST" ? "JOURNAL_EXISTS" : "JOURNAL_IO_FAILED"); }
      if (!h) return abort("JOURNAL_IO_FAILED");
      if (slot === "j") jh = h; else hh = h;
      try { await K.call(h.fns.sync, []); } catch { return abort("JOURNAL_IO_FAILED"); }
      const fst = statRec(await K.call(h.fns.stat, [])); const pst = statRec(await K.call(fs.lstat, [p]));
      if (!fst || !pst || fst.kind !== "file" || pst.kind !== "file" || !sameNode(fst, pst) || fst.nlink !== 1 || fst.size !== 0) return abort(slot === "j" ? "JOURNAL_FILE_CHANGED" : "HEAD_FILE_CHANGED");
      ident[slot] = { dev: fst.dev, ino: fst.ino };
    }
    if (!(await K.syncDir(journalDir))) return abort("JOURNAL_DIR_SYNC_FAILED");
    if (!(await K.syncDir(headDir))) return abort("HEAD_DIR_SYNC_FAILED");
  } catch { return abort("JOURNAL_IO_FAILED"); }

  const F = { j: { h: jh, path: jPath, ident: ident.j, known: Buffer.alloc(0), changed: "JOURNAL_FILE_CHANGED" },
    h: { h: hh, path: hPath, ident: ident.h, known: Buffer.alloc(0), changed: "HEAD_FILE_CHANGED" } };
  const S = { state: "open", busy: null, pending: new Set(), head: null, history: [], dirSync: freeze({ journal: "synced", head: "synced" }) };
  const poison = (code) => { if (S.state === "open") S.state = "failed"; return code; };
  const track = (p) => { S.pending.add(p); const done = () => { S.pending.delete(p); }; p.then(done, done); return p; };
  const gate = (op) => (S.state === "closing" || S.state === "closed" ? "JOURNAL_CLOSED" : S.state === "failed" ? "JOURNAL_FAILED"
    : S.busy !== null ? (op === "append" ? "APPEND_IN_FLIGHT" : "JOURNAL_BUSY") : null);
  /** path identity = fd identity = creation identity, single link, known size, and the bounded bytes equal what this handle wrote */
  async function verify(f) {
    const ps = statRec(await K.call(fs.lstat, [f.path])); const fst = statRec(await K.call(f.h.fns.stat, []));
    if (!ps || !fst || ps.kind !== "file" || !sameNode(ps, f.ident) || !sameNode(fst, f.ident) || fst.nlink !== 1 || fst.size !== f.known.length) return f.changed;
    const r = await K.readExact(f.h, f.known.length);
    if (r.code) return r.code === "IO" ? "JOURNAL_IO_FAILED" : f.changed;
    return Buffer.compare(r.buf, f.known) === 0 ? null : f.changed;
  }

  function append(record) {
    const g = gate("append"); if (g) return fail(g);
    const vr = validateRecordBound(record, binding);               // G2a: the SAME binding (BOUND by bindManifestV2 above), not a re-bind
    if (!vr.ok) return fail(vr.code || "RECORD_INVALID");
    const r = vr.record;
    const expSeq = S.head ? S.head.seq + 1 : 1; const expPrev = S.head ? S.head.hash : GENESIS_HASH;
    if (r.seq !== expSeq || r.prevHash !== expPrev) return fail("CHAIN_MISMATCH");
    const vj = validateJournalBound([...S.history, r], binding);
    if (!vj.ok) return fail(vj.code || "ORDER_INVALID");
    let line; try { line = encodeRecordLine(r); } catch { return fail("RECORD_INVALID"); }
    if (line.length > MAX_LINE_BYTES) return fail("LINE_TOO_LONG");
    if (F.j.known.length + line.length > MAX_FILE_BYTES) return fail("JOURNAL_FULL");
    const hash = recordHashV2(r); const hl = headLine(identity, r.seq, hash);
    S.busy = "append";
    return track((async () => {
      try {
        for (const f of [F.j, F.h]) { const c = await verify(f); if (c) throw new JournalErrorV2(poison(c)); }
        if (!(await K.writeAll(F.j.h, line))) throw new JournalErrorV2(poison("JOURNAL_IO_FAILED"));
        try { await K.call(F.j.h.fns.sync, []); } catch { throw new JournalErrorV2(poison("JOURNAL_IO_FAILED")); }
        F.j.known = Buffer.concat([F.j.known, line]);
        if (!(await K.writeAll(F.h.h, hl))) throw new JournalErrorV2(poison("HEAD_IO_FAILED"));
        try { await K.call(F.h.h.fns.sync, []); } catch { throw new JournalErrorV2(poison("HEAD_IO_FAILED")); }
        F.h.known = Buffer.concat([F.h.known, hl]);
        S.history.push(r); S.head = freeze({ seq: r.seq, hash });
        return freeze({ seq: r.seq, hash });
      } catch (e) {
        if (e instanceof JournalErrorV2) throw e;
        throw new JournalErrorV2(poison("JOURNAL_IO_FAILED"));
      } finally { S.busy = null; }
    })());
  }
  function read() {
    const g = gate("read"); if (g) return fail(g);
    S.busy = "read";
    return track((async () => {
      try {
        for (const f of [F.j, F.h]) { const c = await verify(f); if (c) throw new JournalErrorV2(poison(c)); }
        const p = parseJournalBytes(F.j.known);
        if (!p.ok) throw new JournalErrorV2(poison(p.code));
        return freeze({ records: p.records, tail: p.tail });
      } catch (e) {
        if (e instanceof JournalErrorV2) throw e;
        throw new JournalErrorV2(poison("JOURNAL_IO_FAILED"));
      } finally { S.busy = null; }
    })());
  }
  let closeP = null;
  function close() {
    if (closeP) return closeP;
    S.state = "closing";
    closeP = (async () => {
      while (S.pending.size) await Promise.allSettled([...S.pending]);
      const c1 = await K.closeOnce(F.j.h); const c2 = await K.closeOnce(F.h.h);
      const headLock = await hLock.release(); const journalLock = await jLock.release();
      S.state = "closed";
      return freeze({ fileClose: c1 === "failed" || c2 === "failed" ? "failed" : "closed", headLock, journalLock });
    })().catch(() => freeze({ fileClose: "failed", headLock: "failed", journalLock: "failed" }));
    return closeP;
  }
  const status = () => freeze({ state: S.state, head: S.head, records: S.history.length, dirSync: S.dirSync, busy: S.busy });
  return freeze({ ok: true, journal: freeze({ append, read }), close, status, identity });
}

// =================================================================================================================================
/** one file, read-only: { state:'missing' } | { state:'present', bytes } | { code } (UNSAFE / IO / CHANGED) */
async function readOnlyFile(fs, K, path) {
  const ps = await K.lstatOrNull(path);
  if (ps === "IO") return { code: "IO" };
  if (ps === null) return { state: "missing" };
  if (ps.kind !== "file" || ps.nlink !== 1 || !K.owned(ps)) return { code: "UNSAFE" };
  if (ps.size > MAX_FILE_BYTES) return { code: "CORRUPT" };
  let h;
  try { h = await K.openH(path, "lock-read"); } catch (e) { return { code: errCode(e) === "ELOOP" ? "UNSAFE" : "IO" }; }
  if (!h) return { code: "IO" };
  try {
    const fst = statRec(await K.call(h.fns.stat, []));
    if (!fst || !sameNode(fst, ps) || fst.size !== ps.size) return { code: "CHANGED" };
    const r = await K.readExact(h, ps.size);
    if (r.code) return { code: r.code };
    return { state: "present", bytes: r.buf };
  } catch { return { code: "IO" }; } finally { await K.closeOnce(h); }
}
const presenceOf = async (K, p) => { const s = await K.lstatOrNull(p); return s === null ? "missing" : s === "IO" ? "unknown" : "present"; };
const HEAD_KEYS = ["hash", "manifestHash", "runId", "seq", "v"];

/**
 * readJournalForRecoveryV2({ journalDir, headDir, manifest, trustedHead?, fsAdapter? }) → Promise<frozen RecoveryReport> (never rejects)
 * DIAGNOSTIC ONLY: creates / writes / removes nothing; permission is ALWAYS NO_PERMISSION; a pure function of the bytes (+ supplied head).
 */
export async function readJournalForRecoveryV2(input) {
  const out = (o) => freeze({ version: RUN_JOURNAL_FILE_V2_VERSION, permission: NO_PERMISSION, ...o });
  const o = safe(() => plainData(input, ["journalDir", "headDir", "manifest"], ["fsAdapter", "trustedHead"]));
  if (!o) return out({ ok: false, code: "RECOVERY_OPTIONS_INVALID" });
  const b = bindManifestV2(o.manifest);
  if (!b.ok) return out({ ok: false, code: b.manifestCode || "MANIFEST_INVALID" });
  const binding = b.binding; const identity = binding.identity;
  let supplied = null;
  if ("trustedHead" in o && o.trustedHead !== null) {
    const t = safe(() => plainData(o.trustedHead, ["hash", "seq"]));
    if (!t || !Number.isSafeInteger(t.seq) || t.seq < 1 || typeof t.hash !== "string" || !HEX64.test(t.hash)) return out({ ok: false, code: "TRUSTED_HEAD_INVALID" });
    supplied = freeze({ seq: t.seq, hash: t.hash });
  }
  const fs = "fsAdapter" in o ? snapAdapter(o.fsAdapter) : createNodeFsAdapter();
  if (!fs) return out({ ok: false, code: "RECOVERY_OPTIONS_INVALID" });
  if (!POSIX_PLATFORMS.includes(fs.platform)) return out({ ok: false, code: "JOURNAL_PLATFORM_UNSUPPORTED" });
  const K = fsKit(fs);
  const base = { ok: true, effects: "UNKNOWN_FROM_DISK" };
  const unsafe = (detail) => out({ ...base, relation: "UNSAFE", detail, unresolved: freeze(["DISK_UNREADABLE"]) });
  const jd = await K.checkDir(o.journalDir); if (jd.code) return unsafe(jd.code);
  const hd = await K.checkDir(o.headDir); if (hd.code) return unsafe(hd.code);
  if (sameNode(jd.stat, hd.stat) || o.journalDir === o.headDir) return unsafe("JOURNAL_DIR_ALIAS");
  const jPath = join(o.journalDir, journalFileNameV2(identity.runId)); const hPath = join(o.headDir, headFileNameV2(identity.runId));
  const presence = freeze({ journal: await presenceOf(K, jPath), head: await presenceOf(K, hPath), journalLock: await presenceOf(K, `${jPath}.lock`), headLock: await presenceOf(K, `${hPath}.lock`) });
  const jf = await readOnlyFile(fs, K, jPath); const hf = await readOnlyFile(fs, K, hPath);
  if (jf.code || hf.code) return out({ ...base, presence, relation: (jf.code || hf.code) === "CORRUPT" ? "CORRUPT" : "UNSAFE", detail: `${jf.code || "ok"}/${hf.code || "ok"}`, unresolved: freeze(["DISK_UNREADABLE"]) });
  if (jf.state === "missing" || hf.state === "missing") {
    const rel = jf.state === "missing" && hf.state === "missing" ? "BOTH_MISSING" : jf.state === "missing" ? "JOURNAL_MISSING" : "HEAD_MISSING";
    return out({ ...base, effects: rel === "BOTH_MISSING" ? "NO_RECORD_ON_DISK" : "UNKNOWN_FROM_DISK", presence, relation: rel, unresolved: freeze(["FILES_INCOMPLETE"]) });
  }
  const pj = parseJournalBytes(jf.bytes); const ph = parseJournalBytes(hf.bytes);
  if (!pj.ok || !ph.ok) return out({ ...base, presence, relation: "CORRUPT", detail: `${pj.ok ? "ok" : pj.code}/${ph.ok ? "ok" : ph.code}`, unresolved: freeze(["DISK_UNREADABLE"]) });
  const tails = { journalTail: pj.tail, headTail: ph.tail };
  // head lines: exact shape, this identity, contiguous seq from 1
  const heads = [];
  for (const [i, x] of ph.records.entries()) {
    const ok = x && typeof x === "object" && !Array.isArray(x) && Object.keys(x).sort().join() === HEAD_KEYS.join() && x.v === 2 && x.runId === identity.runId
      && x.manifestHash === identity.manifestHash && x.seq === i + 1 && typeof x.hash === "string" && HEX64.test(x.hash);
    if (!ok) return out({ ...base, presence, ...tails, relation: "HEAD_IDENTITY_MISMATCH", unresolved: freeze(["HEAD_UNTRUSTED"]) });
    heads.push(x);
  }
  const recs = pj.records; const n = recs.length; const m = heads.length;
  const vj = validateJournalBound(recs, binding);
  if (!vj.ok) return out({ ...base, effects: n ? "UNKNOWN_FROM_DISK" : "NO_RECORD_ON_DISK", presence, ...tails, relation: "JOURNAL_INVALID", detail: vj.code, unresolved: freeze(["JOURNAL_UNTRUSTED"]) });
  const hashes = recs.map((r) => recordHashV2(r));
  for (let i = 0; i < Math.min(n, m); i++) if (hashes[i] !== heads[i].hash) return out({ ...base, presence, ...tails, relation: "HASH_MISMATCH", at: i + 1, unresolved: freeze(["REPLACED_OR_EDITED"]) });
  let relation;
  if (n === 0 && m === 0) relation = "GENESIS_EMPTY";
  else if (n === m) relation = "AT_ESCROW_HEAD";
  else if (n === m + 1) relation = "JOURNAL_AHEAD_1";
  else if (m > n) relation = "HEAD_AHEAD";
  else relation = "GAP_GT_1";
  const refusal = relation === "HEAD_AHEAD" || relation === "GAP_GT_1";
  const anchor = m > 0 ? freeze({ seq: m, hash: heads[m - 1].hash }) : null;
  const facts = n ? journalFactsBound(recs, binding).facts : null;
  // supplied (separately retained) trusted head: checked against the JOURNAL chain, never replaced by the head-file tip
  let suppliedHead = "NOT_SUPPLIED";
  if (supplied) suppliedHead = supplied.seq > n ? "AHEAD_OF_FILES" : hashes[supplied.seq - 1] !== supplied.hash ? "NOT_IN_CHAIN" : supplied.seq === n ? "MATCH_TIP" : "IN_CHAIN_BEHIND_TIP";
  const unresolved = [];
  if (n === 0) unresolved.push("NO_RECORDS");
  else {
    unresolved.push("LAST_RECORD_ACK_DELIVERY_UNKNOWN");
    if (relation === "JOURNAL_AHEAD_1") unresolved.push("UNESCROWED_LAST_RECORD");
    if (facts && facts.openStep) unresolved.push("OPEN_STEP");
    if (facts && facts.abortStarted && !facts.abortAccepted) unresolved.push("ABORT_STARTED_UNRECEIPTED");
    if (facts && facts.abortAccepted) unresolved.push("ABORT_RECEIPT_ACK_UNKNOWN");
    if (facts && facts.ended) unresolved.push("TERMINAL_RECORDED");
  }
  if (pj.tail === "torn") unresolved.push("TORN_JOURNAL_TAIL");
  if (ph.tail === "torn") unresolved.push("TORN_HEAD_TAIL");
  if (refusal) unresolved.push("HEAD_RELATION_REFUSED");
  if (suppliedHead === "AHEAD_OF_FILES" || suppliedHead === "NOT_IN_CHAIN") unresolved.push("SUPPLIED_HEAD_CONTRADICTS_FILES");
  return out({ ...base, effects: n ? "UNKNOWN_FROM_DISK" : "NO_RECORD_ON_DISK", presence, ...tails, relation, records: n, headRecords: m,
    chain: freeze({ status: vj.status, anchoredPrefix: refusal ? null : anchor, facts: facts ? freeze({ ...facts }) : null, factsAre: "EVIDENCE_NOT_PERMISSION" }),
    suppliedHead, unresolved: freeze(unresolved) });
}
