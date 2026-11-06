# E7 M2-E — v2 FILE journal with a separately persisted head (OFFLINE, LOCAL, inert)

Module `scripts/e7-connected/run-journal-file-v2.mjs`. Route A of the design (root review b323715f), with the required corrections 1–4.

This is an OFFLINE alternative awaiting a deployment choice. It does NOT establish or replace any hosted durability prerequisite. The owner machine, the directories and the credential files are not chosen and stay parked.

**Unchanged and reused:**
- the v1 file journal's exported codec and adapter (`parseJournalBytes`, `encodeRecordLine`, `createNodeFsAdapter`), byte-exact;
- the v2 validators (`bindManifestV2`, `validateRecordV2`, `validateJournalV2`, `journalFactsV2`, `recordHashV2`).

No v1 module, core, bridge, manifest, helper, worker, guard, migration, workflow or launcher changes.

## 1. Files, names and platform

**Journal file:** `<journalDir>/e7-journal-v2-<runId>.jsonl`. One record per line (the v1 `encodeRecordLine` = `canonicalJson(record) + "\n"`). Records are exact v2 records, including `ABORT_REQUEST_STARTED` / `ABORT_ACCEPTED`.

**Head file:** `<headDir>/e7-head-v2-<runId>.jsonl`.
- One line per ACKed record: `canonicalJson({ v: 2, runId, manifestHash, seq, hash }) + "\n"`.
- `hash` = `recordHashV2(record)`, and seq is contiguous from 1.

**Locks:** `<journalFile>.lock` and `<headFile>.lock`, each holding a 32-hex nonce (the v1 lock format).

**Directories:**
- each is absolute and normalized; realpath equals the given path (no symlink); a directory owned by the process uid; not group- or world-writable;
- `journalDir` and `headDir` must be DIFFERENT directories. The same dev+ino is refused as `JOURNAL_DIR_ALIAS`.

**Platform:** POSIX only (`JOURNAL_PLATFORM_UNSUPPORTED` otherwise), because directory fsync is mandatory here (§3).

**What the separate directory is and is not.**
- It is a SEPARATELY PERSISTED head on the same machine. It is NOT independent authentication and NOT an independent failure domain.
- It detects journal-only corruption, truncation or replacement relative to that head.
- It does NOT detect a coherent rollback or rewrite of BOTH files. Only a separately retained trusted head supplied by the caller (§6) can detect that.
- Same-uid or root actors and same-disk loss are TRUST.
- No power-loss guarantee is made beyond what `fsync` provides on the chosen machine. Mocked fs tests prove call ORDER, not durability.

## 2. Writer open: `openFileJournalV2({ journalDir, headDir, manifest, fsAdapter? })` — never rejects

The manifest is bound once with `bindManifestV2`, and that frozen copy is used throughout. A Proxy manifest, or one that fails validation, is refused with the binding's manifest code.

**Creation only.** Both files must NOT exist, and neither may either lock.
- If either file exists, the result is `JOURNAL_EXISTS`: the writer NEVER reopens, resumes or repairs.
- Every non-empty journal stays ineligible for a new run. Existing files are inspected with `readJournalForRecoveryV2` (§5) only.

**Order:**
1. Exclusive-create the journal lock (`JOURNAL_LOCKED` on EEXIST), write the nonce, fsync, close.
2. Exclusive-create the head lock the same way. If this fails, the instance removes ONLY the first lock, and only if it still holds this instance's dev/ino and nonce (the v1 ownership proof). It never touches another writer's lock.
3. Exclusive-create the journal file, then fsync it.
4. Exclusive-create the head file, then fsync it.
5. fsync `journalDir` (the names of the journal file and its lock), then fsync `headDir` (the names of the head file and its lock).

`ok:true` is returned ONLY after both directory syncs resolve, so both NAMES are durable before any first ACK. A failure at any step refuses, releases only the locks this instance demonstrably owns, and leaves every created file in place (never deleted).

## 3. `append(record)` — the combined ACK

**Synchronous gates, before any I/O:**
- open state (`JOURNAL_FAILED`, `JOURNAL_CLOSED`, `APPEND_IN_FLIGHT`);
- `validateRecordV2(record, frozenManifest)`;
- `seq = head.seq + 1`, `prevHash = head.hash` (genesis: 1 and 64 zeros);
- `validateJournalV2([...history, r], frozenManifest)` order and grammar;
- line and file size bounds.

**Then:**
1. Re-check BOTH files: lstat path identity = fstat fd identity = the creation identity, `nlink === 1`, size equals the known size, and the bounded bytes equal the bytes this handle wrote. Otherwise `JOURNAL_FILE_CHANGED` / `HEAD_FILE_CHANGED`.
2. Write the journal line (a bounded loop, never retried), then fsync the journal.
3. Write the head line, then fsync the head file.
4. Return the ACK `{ seq, hash }`.

**Write progress (root review of 01a9425).** One file write is a bounded loop over the accepted `bytesWritten` contract.
- A valid POSITIVE short count (1 ≤ k ≤ remaining) is normal progress. The remaining bytes continue at the advanced offset, with no duplicate prefix. The loop is bounded by the line length in calls.
- This is completion of ONE local file write, never a resend of a provider operation.
- A zero, negative, non-integer or out-of-range count, or a rejected write, ends the write. Any bytes already written stay on disk as a torn prefix, never truncated or repaired.

**Any failure** (a zero, invalid or out-of-range write count; a write or sync rejection; an identity change): no ACK, and the handle is POISONED (`JOURNAL_FAILED` for every later append or read). Nothing is truncated, repaired or retried.

**Code labels.**
- A zero or invalid count on the head write gives `HEAD_IO_FAILED`.
- A rejected write on either file, and any journal-write failure, give `JOURNAL_IO_FAILED`.
- Behaviour is identical in every case.

Covered by U12 (positive short progress for both files) and U13 (positive progress, then zero or rejection, for both files).

**What is durable after an ACK is the bytes and names, NOT the fact that the ACK was observed.**
- No persisted bit records ACK delivery, and none is invented.
- If the process dies after step 3, the consumer may or may not have seen the ACK, and the files are identical either way.

## 4. `read()`, `close()`, `status()`

- **`read()`** re-checks both files as in §3.1. It returns `{ records, tail }` from the journal bytes, and rejects with a code otherwise. It is a pure read.
- **`close()`** waits for every started operation (no timer), closes both fds, then releases the head lock and then the journal lock. Each lock is released only if it is still demonstrably this instance's. Never rejects.
- **`status()`** = `{ state, head, records, dirSync: { journal, head } }`.

## 5. Recovery: `readJournalForRecoveryV2({ journalDir, headDir, manifest, trustedHead?, fsAdapter? })` — diagnostic ONLY

**Read-only.**
- It opens with the read-only, no-follow `lock-read` kind, creates and removes nothing, writes nothing and takes no lock.
- The same path, identity and owner checks apply. Lock files are reported (present or absent) and never removed.

**It returns evidence, never permission:**
- `presence`: `{ journal, head, journalLock, headLock }` ∈ present | missing.
- `journalTail` / `headTail`: complete | torn. A torn final line is reported and never cut.
- `relation`, computed over complete lines:

  | relation | meaning |
  |---|---|
  | `GENESIS_EMPTY` | both files exist and are empty |
  | `AT_ESCROW_HEAD` | journal n = head n, every hash matches |
  | `JOURNAL_AHEAD_1` | journal n = head n−1 + 1, the prefix matches |
  | `HEAD_AHEAD` | refusal |
  | `GAP_GT_1` | refusal |
  | `HASH_MISMATCH` | refusal: replacement or edit |
  | `HEAD_IDENTITY_MISMATCH` | refusal: a foreign runId or manifestHash, or a malformed or non-contiguous head line |
  | `JOURNAL_INVALID` | refusal: `validateJournalV2` code (foreign identity, order, ...) |
  | `JOURNAL_MISSING` / `HEAD_MISSING` / `BOTH_MISSING` | refusal |
  | `CORRUPT` | refusal |
  | `UNSAFE` | refusal: path kind, links, owner, mode or dir alias |

  - `AT_ESCROW_HEAD` is evidence-only. It never implies that an ACK was observed, nor that no effect occurred.
  - `JOURNAL_AHEAD_1` proves only that THAT last record could not have received the combined ACK under this adapter contract. It says nothing about earlier operations.
- `chain`: `validateJournalV2` of the complete records, anchored at the head file's tip when the relation allows (`anchoredPrefix: { seq, hash }`), plus `journalFactsV2` facts as EVIDENCE.
- `suppliedHead`: when a caller supplies `trustedHead` = a separately retained `{ seq, hash }`, it is checked against the journal chain and NEVER replaced by the head-file tip.

  | value | meaning |
  |---|---|
  | `NOT_SUPPLIED` | no head given |
  | `MATCH_TIP` | equals the tip |
  | `IN_CHAIN_BEHIND_TIP` | the files continued after it was captured |
  | `NOT_IN_CHAIN` | rewrite |
  | `AHEAD_OF_FILES` | a coherent rollback of BOTH files |

- `unresolved`: a list of evidence classes:
  - `LAST_RECORD_ACK_DELIVERY_UNKNOWN` (always, when there is ≥1 record);
  - `OPEN_STEP` (STEP_STARTED without STEP_ENDED);
  - `ABORT_STARTED_UNRECEIPTED`;
  - `ABORT_RECEIPT_ACK_UNKNOWN` (an `ABORT_ACCEPTED` is present, whether the head file includes it or not);
  - `UNESCROWED_LAST_RECORD`;
  - `TERMINAL_RECORDED`;
  - `NO_RECORDS`.
- `permission`: ALWAYS `{ newRun: false, resume: false, adopt: false, cleanup: false, send: false }`. A durable `ABORT_ACCEPTED` is never a cleanup permission here.
- `effects`: ALWAYS `"UNKNOWN_FROM_DISK"` when there is ≥1 record, and `"NO_RECORD_ON_DISK"` otherwise. Neither is a no-effect claim.

**Paired histories with identical durable bytes produce identical results.** Examples: both fsyncs done with the ACK lost, versus the ACK delivered and a send possibly started. The result is a pure function of the bytes (and the supplied head).

## 6. Run lock and teardown (consumer contract; no core change in this slice)

- **Startup order:** the journal open acquires both file locks; the core takes the DB advisory lock `e7-connected-runner` at P0.
- **On a lock loss or signal**, the core stops before the next operation (M8). The file locks are held until `close()`.
- **After a crash**, lock files remain and are never auto-removed. They are removed by the owner only, after a recovery read.
- **A hanging fsync** keeps the append pending. No ACK is returned, so no gated operation starts (the core's guard deadline then stops the run).

## 7. Limits

- Offline only. Not wired to any launcher, CLI or hosted runner.
- No credentials.
- 0017 is applied only in disposable PG tests.
- Fault-injection tests run over the REAL Node fs in temp directories. They prove ordering and refusal logic, not power-loss durability.
