# E7 connected-test runner — FILE JOURNAL CONTRACT, revision 2 (Slice F IMPLEMENTED offline; HOLD R-F1 / R-F2 corrected, pending root CODE re-review)

**Revision 1** (`d365d816`, branch `feature/e7-connected-file-journal-contract` from `dfdbc32c`, DOCS ONLY) was root DESIGN **ACCEPTED** as the basis for Slice F with binding clarifications 1–7. **Revision 2** (this file; branch `feature/e7-connected-file-journal` from exact `d365d816`) records the implementation: new `scripts/e7-connected/run-journal-file.mjs`, new `test/e7-connected-run-journal-file.test.mjs`, this contract (corrections + §9), a status pointer in the runner contract. Nothing else changed (A–E, core, adapters, workers, pins, packages untouched). Sections 0–8 below are revision 1 with the clarification corrections applied in place; §9 is the implementation / resolution map.

**What this is.** The smallest **owner-run, local, file-backed** implementation of the accepted journal interface `{ read(), append(record) }` that the accepted core already consumes (`run-core.mjs:149`, `:258–268`, `:360–366`), using D's accepted record / chain / start rules unchanged. Its purpose is **offline crash / restart preparation**: after a process death, the next invocation must find the evidence and refuse (V1: **no resume**).

**What it is not.** A CLI, a real transport, a credential loader, Stripe ingress, a live approval, permission to run connected, a resume mechanism, a signing / authentication / key-management system, or a durability guarantee for every storage stack. Live gates stay **CLOSED**; owner inputs **UNSET**; protected reservations 70636076 / 71045356 / 71072615 / 71081885 zero-action; e74a OPEN (FIRST FULL TAP / STOP if ever reproduced).

**Citation convention.** `file:line` at `dfdbc32c`. D = `scripts/e7-connected/run-journal-memory.mjs`; A = `run-manifest.mjs`; B = `run-guard.mjs`; core = `run-core.mjs` (all under `scripts/e7-connected/`).

## 0. Decisions at a glance

| # | Decision |
|---|---|
| F1 | New module `scripts/e7-connected/run-journal-file.mjs`, one export pair: `openFileJournal(opts)` → `{ ok:true, journal:{ append, read }, close, status }` / `{ ok:false, code }` |
| F2 | One journal file per run, name **derived** from the validated identity: `<dir>/e7-journal-<runId>.jsonl`. The caller supplies only `dir`; the path never enters a record, a result or an error |
| F3 | Format: UTF-8, one record per line = `canonicalJson(validatedRecord) + "\n"` (A `canonicalJson`, `run-manifest.mjs:110`) (clarification 1) — the stored bytes are NOT what D hashes: D's `recordHash` (D:239) is `sha256(JOURNAL_HASH_PREFIX + canonicalJson(record))`; acks / `prevHash` use it unchanged. A line is **not** independently authenticated or self-verifying; integrity is the chain plus an optional out-of-band trusted head, with D's limits. No header, no head sidecar, no signature |
| F4 | Append validation reuses D's exported pure validators: `validateRecord` (D:231), `validateIdentity` (D:156), `validateJournal(history ∪ candidate)` (D:338), `recordHash` (D:239). D's private state machine is **not** copied |
| F5 | Ack `{ seq, hash }` only after every byte is written **and** `fsync(file)` resolved. Directory entry: synced once at creation where the platform supports directory fsync; reported, never assumed |
| F6 | Single writer: in-process serialization (one append in flight, `APPEND_IN_FLIGHT` otherwise, as D's memory journal, D:488) + an exclusive lock file created with `O_CREAT | O_EXCL`. A stale lock after a crash is **never** broken automatically |
| F7 | Any write / sync / IO fault **poisons** the handle: no retry, no truncation, no repair, every later call rejects `JOURNAL_FAILED` |
| F8 | `read()` re-reads the file from disk; a torn final line → `tail:'torn'` (D → `JOURNAL_PARTIAL`); any non-canonical / non-UTF-8 / non-JSON / over-long complete line → rejected read `JOURNAL_CORRUPT` (core → `REFUSED JOURNAL_FAILURE`); parseable-but-invalid records are passed through so D decides (`JOURNAL_MALFORMED` / `JOURNAL_CHAIN_INVALID` / `MANIFEST_MISMATCH` / `RUN_ENDED` / `RESTART_AMBIGUOUS`) |
| F9 | Code-only errors: D's exported `JournalError(code)` (D:424–426). No path, errno message, record content, guest / provider value or caller value in any error or status |
| F10 | Integrity, not authentication: the file is self-consistent only. `trustedHead` stays the caller's out-of-band value (D:338 semantics, core `:363`); the module writes no head file and offers `status().head` only so an owner can record it elsewhere |

## 1. Accepted interfaces this must satisfy (exact)

- **Core consumption.** `journal.append` / `journal.read` are looked up as DATA methods along the prototype chain, getter-free (core `dataMethod`, `:66`, used at `:149`). Both are invoked through `guard.observe(now + JOURNAL_MS, …)` (`LIMITS.JOURNAL_MS = 5000`, B:41–42; core `:258`, `:361`), so each MUST return an **unpatched native promise** (B `isNativePromise`, B:66; an `async` function's result qualifies).
- **Append input.** The core passes D's validated frozen record (`validateRecord(rec).record`, core `:254–258`) with `seq = head.seq + 1`, `prevHash = head.hash`.
- **Append ack.** The core accepts only a resolved value whose own data properties `seq === rec.seq` and `hash === recordHash(record)` (core `:259–260`); anything else (rejection, timeout, wrong ack) → no later append, `journalTerminal:'unknown'` for a terminal, first-cause stop (core `:261–266`).
- **Read result.** Exactly `{ records, tail: 'complete' | 'torn' }`, a plain object with those two own data keys (D `evaluateStart`, D:404–422); `records` a dense array ≤ `MAX_RECORDS = 1024` (D:17) of record objects (D `safeSnapList`, D:374–392).
- **Start rule.** Unchanged D `evaluateStart` (D:404) → only `EMPTY_JOURNAL` permits a start, and only with the core's DB eligibility check (core P0, `run-core.mjs` eligibility block; contract §6.1 / §8.4).
- **Memory-journal parity** (behaviour to mirror, D:448–529): one frozen validated copy before any await; identity, chain, order and size checks before storage; serial appends (`APPEND_IN_FLIGHT`); refusal never mutates stored history; no retry; no extra terminal.

No deviation from the in-memory interface is needed. The file journal adds lifecycle (`close`, `status`) **outside** the `{ append, read }` object the core receives.

## 2. API and lifecycle (F1, F2, F6)

```
openFileJournal({ dir, identity, fsAdapter? }) → Promise<frozen
    { ok:true, journal: frozen { append(record), read() }, close(), status() }
  | { ok:false, code }>
```

- **Options** are read through one getter-free own-data snapshot (the A / C / D pattern), exactly the keys `dir`, `identity`, optional `fsAdapter` (TEST-ONLY injection; default = a frozen adapter over `node:fs/promises`). Anything else → `JOURNAL_OPTIONS_INVALID`. `identity` must pass D `validateIdentity` (D:156) → else `IDENTITY_INVALID`.
- **Path binding.** `file = join(dir, "e7-journal-" + identity.runId + ".jsonl")`, `lock = file + ".lock"`. `runId` is A-validated (`/^[a-z0-9-]{8,64}$/`), so no separator / traversal can enter the name. Every record's identity must equal the opened identity (D `MANIFEST_MISMATCH` on read; `IDENTITY_MISMATCH` on append). The path is held privately; it is never placed in a record, ack, status or error.
- **Directory checks (open):** `dir` is a string, absolute, no NUL; `realpath(dir) === dir` after normalization (rejects relative paths and any symlink component); `lstat(dir).isDirectory()`. POSIX only: owned by the current uid and not group / world writable (`mode & 0o022 === 0`). Failure → `JOURNAL_DIR_UNSAFE` (or `JOURNAL_DIR_INVALID` for shape). Windows ACLs are **not** inspected (residual R4).
- **Lock (ownership):** `open(lock, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW*, 0o600)`, write a random nonce + `fsync`. `EEXIST` → `JOURNAL_LOCKED` (another owner, or a crashed one). The lock is **never** broken automatically: after a crash the owner inspects and removes it by hand. The lock coordinates compliant openers only; it is not an OS-enforced fence against another process writing the file.
- **File (open or create):** `lstat(file)`:
  - absent → create with `O_RDWR | O_CREAT | O_EXCL | O_APPEND | O_NOFOLLOW*`, mode `0o600`; `fsync(file)`; then `fsync(dir)` where supported (§3.3) → status `created:true`;
  - present → must be a regular file, not a symlink, `nlink === 1`, POSIX owner = current uid and mode without group / world write, size ≤ `MAX_FILE_BYTES`; open `O_RDWR | O_APPEND | O_NOFOLLOW*`; then `fstat` must equal the `lstat` `dev` / `ino` (swap detection) → else `JOURNAL_FILE_UNSAFE` / `JOURNAL_FILE_CHANGED` / `JOURNAL_TOO_LARGE`.
  - (`*` `O_NOFOLLOW` where the platform defines it; elsewhere the lstat + fstat identity comparison is the check.)
- **Initial parse.** The whole file is read once (§4) to establish the in-memory history and head. An invalid / torn / corrupt history does **not** fail `open` (so the core can refuse with D's codes); it marks the handle `historyValid:false`, and every `append` then rejects `JOURNAL_HISTORY_INVALID`.
- **`close()`** → one memoized native promise: new calls reject `JOURNAL_CLOSED`; waits for an in-flight append to settle (no deadline: like B `finalize`, it may stay pending if the storage hangs — residual R6), then closes the file handle and removes the lock only if it still holds our nonce. Never truncates, never deletes the journal.
- **`status()`** → frozen `{ state: 'open' | 'failed' | 'closing' | 'closed', head: null | { seq, hash }, records, created, dirSync: 'synced' | 'unsupported' | 'existing_not_proven', historyValid, busy }` (a reopened existing file never claims directory persistence). No path, no record content.
- **Failure of `open`** after the lock was taken releases the lock (nonce-checked) and closes handles; a file it created stays (empty) — nothing is deleted or truncated.

## 3. Append: bytes, durability, serialization (F3, F5, F6, F7)

### 3.1 Algorithm (all synchronous checks before the first await, on one frozen copy)
1. state must be `open` (`JOURNAL_CLOSED` / `JOURNAL_FAILED`), `historyValid` (`JOURNAL_HISTORY_INVALID`), no append in flight (`APPEND_IN_FLIGHT`).
2. `vr = validateRecord(record)` (D:231) → `RECORD_INVALID` / `ACTION_INVALID`; identity equal → else `IDENTITY_MISMATCH`.
3. `seq === head.seq + 1` and `prevHash === head.hash` (genesis `GENESIS_HASH`, D:16) → else `CHAIN_MISMATCH`.
4. last stored event terminal (`RUN_STOPPED` / `RUN_ENDED`) → `APPEND_AFTER_TERMINAL`; `records.length >= MAX_RECORDS` → `JOURNAL_FULL`.
5. `validateJournal([...history, vr.record], identity)` (D:338) must be `ok` → else `ORDER_INVALID` (this reuses D's order / grammar rules without copying them; ≤ 1024 records per check).
6. `line = canonicalJson(vr.record) + "\n"` as UTF-8 bytes; `bytes ≤ MAX_LINE_BYTES` → else `LINE_TOO_LONG`; file size + bytes ≤ `MAX_FILE_BYTES` → else `JOURNAL_FULL`.
7. Mark in flight. **Write loop:** `write(fd, buf, off, len)` with `O_APPEND` positioning until all bytes are written; a short write continues from the returned count; a 0-byte write or any error → **poison** (§3.4), reject `JOURNAL_IO_FAILED`.
8. `fsync(fd)` → error → poison, reject `JOURNAL_IO_FAILED`.
9. Only now: `history.push(record)`, `head = { seq, hash: recordHash(record) }` (D:239), clear in flight, resolve frozen `{ seq, hash }`.

### 3.2 Bounds
`MAX_RECORDS = 1024` (D:17). `MAX_LINE_BYTES = 16384` (largest D-valid record: ≤ 64 action tokens × 160 chars + ≤ 16 refusals + fixed fields ≈ 13 KiB). `MAX_FILE_BYTES = 16 MiB`. Lines are the only unit; there is no compression, rotation or index.

### 3.3 Durability boundary (what an ack means — and does not)
- **Ack = bytes handed to the OS by complete `write` calls, then `fsync(file)` returned success.** On Linux / POSIX this asks the kernel to flush the file's data and metadata to the device; on Windows Node maps `fsync` to `FlushFileBuffers`.
- **Directory entry.** Appends never change the directory; only creation does. At creation the module `fsync`s the directory (open `dir` read-only, `fsync`). (clarification 4) `unsupported` is a **deliberate platform classification**, never an errno fallback: on POSIX platforms (`aix`, `darwin`, `freebsd`, `linux`, `netbsd`, `openbsd`, `sunos`) the directory is synced before a created journal is returned and ANY error (incl. `EPERM` / `EINVAL` / `EIO`) fails `open` closed (`JOURNAL_DIR_SYNC_FAILED`); on `win32` no directory sync is attempted and `status().dirSync = 'unsupported'`; any other platform is refused (`JOURNAL_PLATFORM_UNSUPPORTED`). macOS `fsync` is not `F_FULLFSYNC` (stated in §3.3). For `unsupported`, the created file's entry persistence then relies on the filesystem's own metadata journaling — **UNVERIFIED** and reported, never claimed.
- **Not claimed (CLOSED):** survival of every power loss / crash on every storage stack; drive write-cache behaviour (macOS `fsync` is not `F_FULLFSYNC`; consumer drives may lie); network / cloud-synced folders (Dropbox / OneDrive / NFS / SMB) — the owner must use a local disk; atomicity of a multi-KB line under power loss (a torn line is detected, §4, not prevented); antivirus / backup interference.

### 3.4 Poisoning, timeouts, concurrency
- **Poison.** After any write / sync / IO fault the handle is `failed`; every later `append` / `read` rejects `JOURNAL_FAILED`. The file may now hold a partial or complete-but-unacknowledged line; nothing truncates or rewrites it. The next invocation reads it and refuses (§5).
- **A timeout never proves absence.** The core's `JOURNAL_MS` deadline (5 s) may expire while steps 7–8 are still running. The core then never appends again (core `:261–266`); the module keeps the in-flight flag set, so even a misbehaving caller cannot append a second record or a second terminal with the same or next `seq` until the pending operation settles — and if it settled with an error the handle is poisoned. A late successful landing simply leaves the record on disk: next start → `RUN_ENDED` (terminal landed) or `RESTART_AMBIGUOUS` (not landed / non-terminal), both zero workers (contract §8.3).
- **Concurrency.** In-process: ONE handle operation at a time (clarification 2): `append` while any operation is in flight → `APPEND_IN_FLIGHT`; `read` while any operation is in flight → `JOURNAL_BUSY`. Cross-process: the lock file (§2). Two different run ids use two different files and are coordinated, if at all, by the core's DB advisory lock (runner contract §12.2), which is not a journal fence.

## 4. Read / parse rules (F8)
`read()` (state `open`, no append in flight) re-reads the whole file from offset 0 via the open handle (`fstat` size ≤ `MAX_FILE_BYTES`, `dev` / `ino` unchanged → else `JOURNAL_FILE_CHANGED`):
1. Decode UTF-8 with a fatal decoder → invalid → `JOURNAL_CORRUPT`. A BOM is corrupt.
2. Split on `"\n"`. If the file is non-empty and does not end in `"\n"`, the final segment is a **torn tail** → return `{ records: <complete lines>, tail:'torn' }` (D → `JOURNAL_PARTIAL`, D:413) — unless an earlier complete line is corrupt (then `JOURNAL_CORRUPT`).
3. Each complete line: non-empty, `≤ MAX_LINE_BYTES`, `JSON.parse` succeeds, and **`canonicalJson(parsed) === line`** (rejects CRLF, whitespace, duplicate / reordered keys, non-safe integers, any second encoding of the same record) → else `JOURNAL_CORRUPT`. More than `MAX_RECORDS` lines → `JOURNAL_TOO_LARGE`.
4. Return `{ records: frozen parsed records, tail:'complete' }`. Records that parse canonically but violate D's rules are **returned as they are**, so D's `evaluateStart` decides: middle corruption of a field / identity / chain → `JOURNAL_MALFORMED` / `MANIFEST_MISMATCH` / `JOURNAL_CHAIN_INVALID`; a duplicate or extra terminal → `JOURNAL_MALFORMED` (D `APPEND_AFTER_TERMINAL` order rule); a non-empty valid history → `RESTART_AMBIGUOUS` / `RUN_ENDED`.

A rejected read reaches the core as `REFUSED JOURNAL_FAILURE` (core `:361–362`); D codes reach it as `REFUSED <code>`. Nothing is ever repaired.

## 5. Crash / restart behaviour (V1: never resumes)

| Situation on disk | Next invocation |
|---|---|
| No file (first run, or the owner deleted / lost it) | created empty → `EMPTY_JOURNAL` → **DB P0 eligibility still required** (intent `payment_authorized`, identity = manifest, no write op, no open case; contract §6.1). A lost / replaced journal therefore cannot rerun a booking that progressed; it can only "restart" one whose DB facts are still pre-reservation. File existence or emptiness is never authorization |
| Lock file left by a dead process | `JOURNAL_LOCKED` until the owner inspects and removes it; never auto-broken |
| Torn final line (death mid-write) | `JOURNAL_PARTIAL` |
| Complete but unacknowledged final line (death / timeout after write, before or after `fsync`) | that line may or may not survive power loss; either way `RESTART_AMBIGUOUS` or `RUN_ENDED` |
| `RUN_STARTED` …, no terminal | `RESTART_AMBIGUOUS` (`interruptedStep` if a step is open) |
| Terminal present | `RUN_ENDED` |
| Middle corruption / bad chain / foreign identity / duplicate terminal | `JOURNAL_CORRUPT` → `JOURNAL_FAILURE`, or D `JOURNAL_MALFORMED` / `JOURNAL_CHAIN_INVALID` / `MANIFEST_MISMATCH` |
| A different `runId` for the same intent (new manifest) | new empty file → still subject to DB P0; a progressed intent is refused there. A new manifest / runId is never authority to bypass uncertainty (contract §8.1) |

The module never truncates, rewrites, repairs, skips a recorded step, mints a run id, key or booking attempt, or resumes.

## 6. Integrity vs authentication (F10)
- The per-line hash chain proves **internal consistency** only: anyone able to write the directory can replace the whole file with another self-consistent chain (D header, D:8). A hash or head stored in the same directory is **not** an independent trust anchor, so none is written.
- `trustedHead` remains the caller's optional out-of-band value, passed unchanged to D (`anchored:true` only when supplied **and** matched; core result `anchored`). `status().head` lets the owner copy the head elsewhere (paper, another device) after a run; nothing more is claimed.
- No signing, MAC, key management or remote anchoring is designed or implied (CLOSED).

## 7. Proposed Slice F — the smallest next implementation (not authorized)

**Allowed files (proposed):**
- new `scripts/e7-connected/run-journal-file.mjs`;
- new `test/e7-connected-run-journal-file.test.mjs` (pure / file tests; runs under `npm test`; no PG);
- this contract + the runner contract pointer (status only).

**Import boundary of the new module:** `node:fs/promises` and `node:fs` constants (default adapter only), `node:path`, `node:crypto` (`randomBytes` for the lock nonce), A `canonicalJson`, D `validateRecord` / `validateIdentity` / `validateJournal` / `recordHash` / `GENESIS_HASH` / `MAX_RECORDS` / `JournalError`. `process.platform` / `process.getuid` only through the default adapter. **No** timers, env, network, child processes, SDK, worker, DB or core import. A, B, C, D, the core, the adapters, workers, `lib/`, SQL, fixtures, config, packages and every containment pin stay unchanged; the core's E23 import pin is untouched because the core does not import the file layer (the future owner CLI — CLOSED — would wire `openFileJournal(...).journal` into `runConnectedTest`).

**fsAdapter (TEST-ONLY injection, frozen):** `{ realpath, lstat, open(path, flags, mode) → { write, sync, read, stat, close }, unlink, openDir(path) → { sync, close }, platform, uid }`. Default = `node:fs/promises`. Fault adapters in tests only; accepted workers / runtime are never monkeypatched.

**Focused tests (temp directories under `os.tmpdir()` only; no PG, no network; root-runnable):**
1. Options / identity / path: relative dir, symlinked dir component, non-directory, group-writable dir (POSIX), symlink file, hardlinked file, FIFO / directory in place of the file, oversized file, `runId` binding; no path or caller value in any error / status.
2. Round trip on the real fs: the exact record sequences the accepted core emits for ENDED_CONFIRMED / RELEASED / STOPPED paths (built with D `validateRecord` + `recordHash`), appended then re-read by a **fresh** handle → `validateJournal` ok, `evaluateStart` → `RUN_ENDED`; bytes = `canonicalJson` lines; acks equal `recordHash`.
3. Append refusals mirroring D: identity / seq / prevHash / order / after terminal / full / line too long / in flight; a refusal never changes the file (byte-compare).
4. Faults via the adapter: short writes (completed by the loop), 0-byte write, write error mid-line, `fsync` error, hanging write then late completion — poison, no retry, no second append, close waits; dir-fsync `EPERM` → `dirSync:'unsupported'`, other errors fail open.
5. Read rules on crafted files: torn tail → `JOURNAL_PARTIAL`; CRLF / BOM / invalid UTF-8 / non-JSON / non-canonical / empty line / over-long line → `JOURNAL_CORRUPT`; middle field change → `JOURNAL_MALFORMED`; swapped line → `JOURNAL_CHAIN_INVALID`; duplicate terminal → `JOURNAL_MALFORMED`; foreign identity → `MANIFEST_MISMATCH`. Never truncated (file bytes unchanged).
6. Lock / ownership: second open → `JOURNAL_LOCKED`; close removes only our nonce lock; open failure releases the lock; stale lock never broken.
7. One child-process crash test (`node:child_process` in the TEST only): the child opens, appends, then is killed (`SIGKILL`) during a deliberately split write → the parent sees `tail:'torn'` → `JOURNAL_PARTIAL`, plus the leftover lock → `JOURNAL_LOCKED`.
8. Core-interface compatibility without PG: the journal object passes the core's getter-free data-method lookup shape, both methods return B-native promises (`isNativePromise`, B:66), and `guard.observe` (B) over a hanging adapter write yields `timeout` while the module refuses any second append (`APPEND_IN_FLIGHT`) — the exact core sequence, using fakes. A full connected / PG rehearsal with the file journal is a separate later slice.

**Validation commands (proposed):** `node --test test/e7-connected-run-journal-file.test.mjs`; `node --test test/e7-connected-*.test.mjs test/hostaway-reservations.test.mjs test/e4-connected-path.test.mjs`; `npm test`. The focused runner PG suite is unaffected (no core change) and is not required.

**What the crash tests prove / do not prove.** They prove the module's own behaviour at process death (torn-line detection, lock leftovers, no repair) and its fault handling under injected IO errors. They do **not** prove power-loss durability, drive-cache behaviour, filesystem-specific ordering, or Windows directory-entry persistence (all CLOSED / UNVERIFIED).

## 8. Blockers and residuals
- **Blockers:** none for the offline Slice F beyond root DESIGN acceptance and authorization.
- **R1** Durability is "as far as `fsync` and the local filesystem honour it" (§3.3); no stronger claim.
- **R2** The lock file is advisory (compliant openers only) and a crash leaves it for manual removal.
- **R3** Integrity is relative to an out-of-band trusted head; without one, a whole-file replacement is undetectable by the journal (DB P0 eligibility remains the authority for a fresh start).
- **R4** Windows: no directory fsync, no ACL inspection, `O_NOFOLLOW` absent (lstat + fstat identity used instead), modes not enforced — reported in `status()`, not claimed.
- **R5** Network / synced folders are unsupported and not detected.
- **R6** `close()` may stay pending forever behind a hung storage operation (like B `finalize`); the caller must not delete the directory meanwhile.
- **R7** `MAX_RECORDS` / `MAX_LINE_BYTES` / `MAX_FILE_BYTES` are routine bounds; a run hitting them stops with `JOURNAL_FAILURE` (no rotation).
- Routine choices resolved here (root's, not owner decisions): file name scheme, line format, bounds, lock-file scheme, dir-fsync-at-creation rule, poisoning, error codes.

## 9. Slice F implementation / resolution map (revision 2; CLAUDE-RUN; pending root CODE review)

**Exports** (`scripts/e7-connected/run-journal-file.mjs`): `openFileJournal`, `createNodeFsAdapter` (the default adapter; exported so tests can wrap it with labelled faults), `parseJournalBytes`, `encodeRecordLine`, `journalFileName`, constants `MAX_LINE_BYTES` (16384), `MAX_FILE_BYTES` (16 MiB), `MAX_JSON_DEPTH` (6), `LOCK_BYTES` (33), `POSIX_PLATFORMS`, `OPEN_KINDS`, `RUN_JOURNAL_FILE_VERSION`. Imports (pinned by F14): `node:fs/promises`, `node:fs` (constants), `node:path`, `node:crypto` (`randomBytes`), `node:util` (`types`), A `canonicalJson`, D `validateRecord` / `validateIdentity` / `validateJournal` / `recordHash` / `GENESIS_HASH` / `MAX_RECORDS` / `IDENTITY_KEYS` / `TERMINAL_EVENTS` / `JournalError`. No timer, env, network, child process, SDK, core, worker or DB import; `process.platform` / `process.getuid` only inside `createNodeFsAdapter`.

### 9.1 Root binding clarifications → implementation
1. **Hash wording.** Stored bytes = `encodeRecordLine(r)` = UTF-8 `canonicalJson(r) + "\n"`; acks and `prevHash` use `D.recordHash` unchanged (F3 asserts ack = `recordHash`, and ≠ a hash of the line bytes). §0 F3 corrected; no D or format change.
2. **IO ownership.** One handle operation at a time (`busy`: read XOR append; `APPEND_IN_FLIGHT` / `JOURNAL_BUSY`). Every started operation is tracked; `close()` is one memoized native promise that sets `closing` first (new read / append → `JOURNAL_CLOSED` immediately), waits for EVERY started read and append (no timer, no force close, no retry), then closes the file handle once and releases the lock once. The cache (`known` bytes, `history`, `head`, `historyValid`) changes only after a fully written and synced append; **before every append (R-F1) and on every `read()`** the handle re-reads exactly the known size, proves no growth / shrink, and byte-compares with `known` — any external change → `JOURNAL_FILE_CHANGED`, the handle is poisoned, nothing is written (same-handle external modification is unsupported and refused, never accepted as stale cache). No copied D state machine: order / grammar checks are `validateJournal(history + candidate)`.
3. **Lock ownership.** The lock is created `O_CREAT | O_EXCL | O_NOFOLLOW`, holds a 32-hex random nonce + `"\n"`, is synced, and its `dev` / `ino` (from `fstat` of the creating fd) and nonce are tracked. Release: `lstat` (regular, `nlink 1`, size 33, same `dev` / `ino`) → open `O_RDONLY | O_NOFOLLOW` → `fstat` identity → bounded read (≤ 34 bytes) → nonce equal → `lstat` re-check → `unlink`. Any mismatch → `not_owned` (another lock is never removed); IO error → `failed`; code-only outcome `released | not_owned | failed | none` in `close()` / failed-open `cleanup`. Every file / dir / lock handle is closed at most once (`closeOnce`); a primary open failure keeps its code and reports the cleanup outcome separately. Close never takes the file or lock away from an in-flight operation (it waits). A stale lock is never broken.
4. **Directory sync.** Deliberate platform classification (§3.3, corrected): POSIX → sync before returning a created journal, any error fails closed; `win32` → `unsupported`; other platforms refused. A reopened existing file reports `existing_not_proven`. The `fsAdapter` is ONE frozen data-method snapshot (exact keys `lstat, open, openDir, platform, realpath, uid, unlink`) taken before any await; proxies / getters / extra keys → `JOURNAL_OPTIONS_INVALID` (F1 proves no getter ran). Every adapter-returned handle / stat is itself snapshotted getter-free (`HANDLE_KEYS`, `STAT_KEYS`).
5. **Path vs fd.** Open: `realpath(dir) === dir`; `lstat(dir)`; `lstat(file)`; `fstat(fd)`; `lstat(file)` again, all `dev` / `ino` equal. Before every append and read: `lstat(path)` and `fstat(fd)` must both still name the tracked node with the known size, AND the bounded contents must equal the acknowledged bytes (R-F1). F8 / F15 prove an external append, a same-size rewrite, a pathname replacement and growth during a read are all refused. **Limitation (stated):** the directory namespace is trusted and owner-controlled; the checks detect observed swaps, they are not a race-free defence against a hostile process renaming ancestors (no `openat`-style primitives in Node). No access is expanded or privilege granted.
6. **Hostile parsing.** Newline boundary is found on BYTES first; bytes after the last `"\n"` are a torn tail and are never decoded (an interrupted multi-byte sequence there is torn — F9). Each complete line: 1..16384 bytes, nesting depth ≤ 6 by a non-recursive byte scan BEFORE `JSON.parse` (deep nesting cannot reach the parser), fatal UTF-8 with BOM kept (→ non-canonical), `JSON.parse`, and byte equality with `canonicalJson(parsed)` (duplicate keys, whitespace, CRLF, `1e400`, floats, non-safe integers → `JOURNAL_CORRUPT`); any throw → `JOURNAL_CORRUPT`; > 1024 lines → `JOURNAL_TOO_LARGE`. A canonical line with an own `__proto__` key reaches D and is refused `JOURNAL_MALFORMED`. Open never fails on content: a safe file with torn / corrupt / invalid content opens with `historyValid:false` (every append → `JOURNAL_HISTORY_INVALID`) and `read()` returns the same classification every time (not a poison). Failed opens close every handle (F2 / F11 count opens = closes).
7. **Promises / bounds.** `append` / `read` return native promises (B `isNativePromise`, F6 / F13); the record is one D-validated frozen copy before any await; the ack resolves only after the whole line is written and `sync` resolved. The write loop accepts only an integer `bytesWritten` in `1..remaining` (zero / negative / over / fractional / missing → `JOURNAL_IO_FAILED` + poison, never retried — F5); continuing after a short write completes the same append. The read loop is bounded by the known size, then a 1-byte probe at that offset proves no growth. A pending / late landing can never be followed by a second append (`APPEND_IN_FLIGHT` while pending; poison on failure) — F6.

### 9.2 Deviations from revision 1 (for review)
- `status().dirSync` values are `synced | unsupported | existing_not_proven` (rev 1 said `not_needed`); `status().busy` added.
- `read()` during any in-flight operation → `JOURNAL_BUSY` (rev 1 said `APPEND_IN_FLIGHT`).
- The adapter's `open(path, kind)` takes a symbolic kind (`journal-create | journal-open | lock-create | lock-read`) instead of raw flags, and returns plain stat records `{ dev, ino, kind, mode, nlink, size, uid }` (bigint-exact dev / ino as strings) — so a fault adapter cannot smuggle flags and no Node `Stats` method is called on caller objects.
- The lock fd is closed right after creation (ownership is the tracked `dev` / `ino` + nonce, verified on release), not held open.
- A failed open after creating the journal file leaves that empty file in place (nothing is ever deleted); a later open treats it as an existing file (`existing_not_proven`).

### 9.3 Validation (all CLAUDE-RUN)
Commands from the repository root:
```
node --test test/e7-connected-run-journal-file.test.mjs                                                   # focused (no PG)
node --test test/e7-connected-*.test.mjs test/hostaway-reservations.test.mjs test/e4-connected-path.test.mjs   # foundation + adapters + pins
npm test
```
- **FIRST FULL TAP (preserved):** 12/14 — F5 and F6 failed with `JOURNAL_IO_FAILED` on their first append. Cause: a **test-harness defect** — the labelled fault adapter treated an `async` plan's resolved `null` ("no fault here") as a write reply, i.e. an injected missing `bytesWritten`; the module correctly refused it. Fix in the test only (`await` the plan); no module change.
- Run 2: **14/14**; three further consecutive runs 14/14 (crash test stable).
- Foundation units + adapters + pins (now including F): 146/146. `npm test`: 811/811 (797 + 14). No PG run needed; none done. e74a not reproduced.

### 9.4 Residuals
- R1–R7 (§8) unchanged. Additionally:
- **R8** The crash test (F12) uses POSIX `SIGKILL` semantics and was run on Linux only; Windows behaviour of the suite is not exercised.
- **R9** Same-handle external modification is refused, not supported; an owner editing the file while a run is open poisons the handle (by design).
- **R10** Ancestor-directory rename races by a hostile local process are out of scope (clarification 5).
- Live gates CLOSED; owner inputs UNSET; protected ids zero action; e74a OPEN. No power-loss durability claim.

### 9.5 Root CODE REVIEW HOLD on `2936dc1c` (R-F1, R-F2) — corrections (same branch, fast-forward)

Scope: `run-journal-file.mjs`, its test, this contract. Nothing else changed.

**R-F1 — append on stale cached history.** At `2936dc1c`, `checkIdentity()` verified path / fd inode and size but not the bytes; only `read()` byte-compared. Because the core reads once and then only appends, a same-size rewrite between appends was acknowledged (root's real-fs reproduction: `"at":1000` → `"at":1002`, then a valid seq-2 append was acked over a chain that D then rejects `JOURNAL_CHAIN_INVALID`). **Fix:** inside the existing one-operation gate, after `checkIdentity()` and BEFORE the first write byte, the append now reuses the bounded `readExact(knownSize)` (size-bounded loop + one-byte growth probe) and byte-compares with the acknowledged `known` bytes. Mismatch / growth / shrink → `JOURNAL_FILE_CHANGED` (or `JOURNAL_IO_FAILED` for an invalid read reply), handle poisoned, zero bytes written, no ack, `history` / `head` not advanced. No-retry, short-write completion, late-landing and close semantics are unchanged. **Limitation (unchanged, stated):** this detects changes observed before the write; it is not atomic protection against a hostile process editing the file between the verification and the write (trusted owner-controlled namespace).

**R-F2 — test-owned descriptor cleanup.** Root's 14/14 run emitted "Closing file descriptor … on garbage collection" / DEP0137 for two fds. Sources (TEST harness, not the module): F5's sync-fault case discarded a reopened journal (`(await open(d)).journal.read()`) without closing it; F7's injected close failure threw BEFORE the underlying close, leaving a real fd open. **Fix (test only; no runtime retry / force close; the module's once-only close is unchanged):**
- F5 retains and closes the reopened journal;
- the labelled fault adapter keeps the real fd of an injected close failure in `log.leftover`; F7 asserts the production result (`fileClose:'failed'`, lock released once, `close()` memoized — no second attempt) and THEN the test closes that fd explicitly (`closeLeftovers`), distinguishable from the module;
- every journal open in the suite now goes through a counting passthrough adapter; the adapter counts an open only when an fd exists, and every journal / lock / directory handle close. **F16** asserts, for every adapter log in the suite, opens = closes, dir opens = dir closes, and no leftover — explicit accounting, independent of GC timing. Other fault paths reviewed: the dir-sync fault now closes its real directory fd through the counted wrapper; locked / refused opens hold no fd.

**New / changed tests:** F15 (R-F1: same-size canonical rewrite before append; same-size garbage bytes; unchanged-file control — append called directly, no prior `read()`), F16 (R-F2 accounting); F5 / F7 teardown corrected.

**Validation (CLAUDE-RUN):**
- RED on exact `2936dc1c` module (new suite, `--trace-warnings`): 14/16 — F15 fails (`append` RESOLVED, expected `JOURNAL_FILE_CHANGED`); F16 fails as a cascade (the journal F15 left open when its assertion threw). TAP retained.
- GREEN first full run of the corrected module: 15/16 — F16 still failed: the counting adapter had recorded a lock open that failed with `EEXIST` (F10's expected `JOURNAL_LOCKED`) as if an fd existed. That was a test-accounting artifact, not a leak; I fixed it in the test only (count after a successful open). TAP retained.
- Run 2: 16/16 with ZERO "Closing file descriptor" / DEP0137 lines under `--trace-warnings`; three further runs 16/16, zero GC warnings.
- Foundation units + adapters + pins: 148/148. `npm test`: 813/813 (zero GC warnings). No PG run.
