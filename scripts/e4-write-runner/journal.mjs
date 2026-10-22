// E4 write runner — durable append-only journal (JSON Lines), OFFLINE scaffold.
//
// Replay protection model (see the review packet for the residual risk):
//  - The journal file name is derived from the manifest hash (e4-journal-<hash12>.jsonl) and is created with
//    O_EXCL ("wx"): the same approved manifest can never start a second run in the same directory, and an
//    existing journal is never reused, truncated or overwritten.
//  - Every entry is written and fsync'ed before append() returns; the runner appends the write INTENT before
//    the request is sent, so a crash after sending leaves an intent without an outcome (=> INDETERMINATE,
//    read-only reconciliation only).
//  - The runner's write budget is counted from these durable entries, not from in-memory counters.
//  - Deleting the journal or choosing another directory defeats this; it is an operator-procedure control.
//  - Residuals: the parent-directory fsync after creation is BEST EFFORT (unsupported on some OSes/filesystems;
//    reported by dirSynced()). fsync is only as reliable as the OS, filesystem and disk. No absolute guarantee
//    against an OS crash or power loss is claimed.
//  - append() writes the complete UTF-8 entry with a checked loop; any short/zero/invalid progress or error fails
//    the append (nothing is mirrored, the caller sends nothing) and permanently fails the journal. The partial file
//    is kept as-is and reads back as JOURNAL_CORRUPT.
// Entries are pre-sanitized by the runner (sanitizeJournalEntry); this module stores and parses JSON only.

import { openSync, writeSync, fsyncSync, closeSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";

export class JournalError extends Error {
  constructor(code) { super(code); this.name = "JournalError"; this.code = code; }
}

export const journalFileName = (manifestHash) => {
  if (typeof manifestHash !== "string" || !/^[0-9a-f]{64}$/.test(manifestHash)) throw new JournalError("MANIFEST_HASH_INVALID");
  return `e4-journal-${manifestHash.slice(0, 12)}.jsonl`;
};

/** Creates a NEW journal file bound to `manifestHash` in `dir`. Throws JOURNAL_EXISTS if one is already there. */
export function createFileJournal(dir, manifestHash) {
  if (typeof dir !== "string" || !dir) throw new JournalError("JOURNAL_DIR_REQUIRED");
  const path = join(dir, journalFileName(manifestHash));
  let fd;
  try { fd = openSync(path, "wx", 0o600); }
  catch (e) { throw new JournalError(e && e.code === "EEXIST" ? "JOURNAL_EXISTS" : "JOURNAL_CREATE_FAILED"); }
  let dirSynced = false;
  try { const d = openSync(dirname(path), "r"); try { fsyncSync(d); dirSynced = true; } finally { closeSync(d); } } catch { /* not supported on every OS */ }
  const mirror = [];
  let closed = false;
  let failed = false;
  return Object.freeze({
    durable: true,
    boundHash: manifestHash,
    path,
    dirSynced: () => dirSynced,
    load: () => mirror.map((e) => JSON.parse(JSON.stringify(e))),
    append(entry) {
      if (closed) throw new JournalError("JOURNAL_CLOSED");
      if (failed) throw new JournalError("JOURNAL_FAILED"); // an earlier append failed: the file is used/corrupt
      const line = `${JSON.stringify(entry)}\n`;
      const buf = Buffer.from(line, "utf8");
      // Write the COMPLETE buffer: writeSync may write fewer bytes than asked. Any non-integer, zero, negative or
      // out-of-range progress, or a thrown error, fails the append. The partial file is left as it is (never
      // truncated, deleted or retried); the journal refuses all further appends.
      try {
        let off = 0;
        while (off < buf.length) {
          const n = writeSync(fd, buf, off, buf.length - off);
          if (!Number.isSafeInteger(n) || n <= 0 || n > buf.length - off) throw new JournalError("JOURNAL_WRITE_INCOMPLETE");
          off += n;
        }
        fsyncSync(fd);                        // only after the whole entry is written
      } catch (e) {
        failed = true;
        throw e instanceof JournalError ? e : new JournalError("JOURNAL_WRITE_FAILED");
      }
      mirror.push(JSON.parse(line));          // only after a complete write AND a successful fsync
    },
    close() { if (!closed) { closed = true; closeSync(fd); } }
  });
}

/** Strictly parses an existing journal. A torn last line or any malformed line => JOURNAL_CORRUPT. */
export function readJournalFile(path) {
  let text;
  try { text = readFileSync(path, "utf8"); } catch { throw new JournalError("JOURNAL_UNREADABLE"); }
  if (text.length && !text.endsWith("\n")) throw new JournalError("JOURNAL_CORRUPT");
  return text.split("\n").filter((l) => l.length).map((l) => {
    try { const v = JSON.parse(l); if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error(); return v; }
    catch { throw new JournalError("JOURNAL_CORRUPT"); }
  });
}
