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
  return Object.freeze({
    durable: true,
    boundHash: manifestHash,
    path,
    dirSynced: () => dirSynced,
    load: () => mirror.map((e) => JSON.parse(JSON.stringify(e))),
    append(entry) {
      if (closed) throw new JournalError("JOURNAL_CLOSED");
      const line = `${JSON.stringify(entry)}\n`;
      writeSync(fd, line);
      fsyncSync(fd);                          // durable before the caller proceeds
      mirror.push(JSON.parse(line));          // mirrors only what was durably written
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
