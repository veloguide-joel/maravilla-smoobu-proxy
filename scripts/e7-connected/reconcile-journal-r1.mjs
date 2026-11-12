// scripts/e7-connected/reconcile-journal-r1.mjs — E7 N2 reconcile-only runner (R-B, Step A): its OWN creation-only journal.
// A NEW journal kind ("e7-reconcile-r1"), never the native R1 journal: one file per reconcile runId, created with O_EXCL / O_NOFOLLOW, mode
// EXACTLY 0600 in an own-uid 0700 directory; records are hash-chained (sha256 over prev ‖ the record line) and fsynced one by one.
// An existing file (any content) refuses — there is no resume, no replay, no repair, no overwrite. NOT part of any reviewed closure.
import fsp from "node:fs/promises";
import { constants as C } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

export const RECONCILE_JOURNAL_KIND = "e7-reconcile-r1";
export const RUN_ID_RE = /^[a-z0-9-]{8,64}$/;
export const journalName = (runId) => `${RECONCILE_JOURNAL_KIND}-${runId}.jsonl`;
const freeze = Object.freeze;
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const GENESIS = "0".repeat(64);

/** openReconcileJournalR1({ dir, runId, uid, openHandle? }) → { ok:true, journal } | { ok:false, code } — never throws.
 *  openHandle (TEST-ONLY injection, default fs.promises.open) lets fault tests wrap write / sync; production never passes it. */
export async function openReconcileJournalR1({ dir, runId, uid, openHandle } = {}) {
  const open = typeof openHandle === "function" ? openHandle : (f, flags, mode) => fsp.open(f, flags, mode);
  const bad = (code) => freeze({ ok: false, code });
  if (typeof dir !== "string" || !path.isAbsolute(dir) || dir.includes("\0") || path.normalize(dir) !== dir) return bad("JOURNAL_DIR_INVALID");
  if (typeof runId !== "string" || !RUN_ID_RE.test(runId)) return bad("RUN_ID_INVALID");
  let st;
  try { st = await fsp.lstat(dir); } catch { return bad("JOURNAL_DIR_UNREADABLE"); }
  if (!st.isDirectory() || st.isSymbolicLink()) return bad("JOURNAL_DIR_NOT_DIRECTORY");
  if ((st.mode & 0o777) !== 0o700 || (Number.isSafeInteger(uid) && st.uid !== uid)) return bad("JOURNAL_DIR_NOT_PRIVATE");
  const file = path.join(dir, journalName(runId));
  let fh;
  try { fh = await open(file, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW | C.O_APPEND, 0o600); }
  catch (e) { return bad(e && e.code === "EEXIST" ? "JOURNAL_EXISTS" : "JOURNAL_CREATE_FAILED"); }
  try {
    const fst = await fh.stat();
    if (!fst.isFile() || fst.nlink !== 1 || (fst.mode & 0o777) !== 0o600 || (Number.isSafeInteger(uid) && fst.uid !== uid)) {
      await fh.close().catch(() => {});
      return bad("JOURNAL_FILE_NOT_PRIVATE_LEFT_IN_PLACE");                       // never chmod-repaired or removed
    }
  } catch { await fh.close().catch(() => {}); return bad("JOURNAL_CREATE_FAILED"); }
  let seq = 0; let prev = GENESIS; let closed = false; let failed = null;
  const journal = freeze({
    file,
    /** append(type, at, data) → { ok, seq, hash } | { ok:false, code }. The FULL line is written (a zero-progress or over-progress write fails;
     *  partial progress continues from the reported offset), then fsync; only then do seq / head advance. Any failure latches: every later
     *  append refuses with the first code — no retry, no repair, no truncation (a partial line on disk is reported by the reader). */
    async append(type, at, data = {}) {
      if (closed) return freeze({ ok: false, code: "JOURNAL_CLOSED" });
      if (failed) return freeze({ ok: false, code: failed });
      const nseq = seq + 1;
      const rec = { kind: RECONCILE_JOURNAL_KIND, seq: nseq, prev, type, at, data };
      const line = JSON.stringify(rec);
      const hash = sha(`${prev}\n${line}`);
      let buf;
      try { buf = Buffer.from(`${JSON.stringify({ ...rec, hash })}\n`, "utf8"); } catch { failed = "JOURNAL_ENCODE_FAILED"; return freeze({ ok: false, code: failed }); }
      try {
        let off = 0;
        while (off < buf.length) {
          const r = await fh.write(buf, off, buf.length - off);
          const n = r && r.bytesWritten;
          if (!Number.isSafeInteger(n) || n <= 0) { failed = "JOURNAL_WRITE_NO_PROGRESS"; return freeze({ ok: false, code: failed }); }
          if (n > buf.length - off) { failed = "JOURNAL_WRITE_OVER_PROGRESS"; return freeze({ ok: false, code: failed }); }
          off += n;
        }
      } catch { failed = "JOURNAL_WRITE_FAILED"; return freeze({ ok: false, code: failed }); }
      try { await fh.sync(); } catch { failed = "JOURNAL_SYNC_FAILED"; return freeze({ ok: false, code: failed }); }
      seq = nseq; prev = hash;                                                        // acknowledged ONLY after full write + fsync
      return freeze({ ok: true, seq, hash });
    },
    get failed() { return failed; },
    head: () => freeze({ seq, hash: prev }),
    async close() { if (closed) return; closed = true; await fh.close().catch(() => {}); }
  });
  return freeze({ ok: true, journal });
}

/** readReconcileJournalR1(file) → { ok, records, head } | { ok:false, code } — verifies the chain; read-only */
export async function readReconcileJournalR1(file) {
  let text;
  try { text = await fsp.readFile(file, "utf8"); } catch { return freeze({ ok: false, code: "JOURNAL_UNREADABLE" }); }
  const lines = text.split("\n"); if (lines.at(-1) === "") lines.pop();
  let prev = GENESIS; const records = [];
  for (const [i, l] of lines.entries()) {
    let r; try { r = JSON.parse(l); } catch { return freeze({ ok: false, code: "JOURNAL_CORRUPT", at: i + 1 }); }
    const { hash, ...rest } = r;
    if (rest.kind !== RECONCILE_JOURNAL_KIND || rest.seq !== i + 1 || rest.prev !== prev || sha(`${prev}\n${JSON.stringify(rest)}`) !== hash) {
      return freeze({ ok: false, code: "JOURNAL_CHAIN_BROKEN", at: i + 1 });
    }
    prev = hash; records.push(freeze(r));
  }
  return freeze({ ok: true, records: freeze(records), head: freeze({ seq: records.length, hash: prev }) });
}
