# E7 FILE-JOURNAL INTEGRATION REHEARSAL — report (TESTS + REPORT ONLY; offline; pending root review)

**Branch** `feature/e7-connected-file-journal-rehearsal`, cut from exact `94c29abf66dfcfd5b580471f847e670a14a2871c` (A–F ACCEPTED offline). Files: new `test/db/e7-connected-file-journal-rehearsal.test.mjs` (440 lines), this report, a status pointer in `claude/e7-connected-file-journal-contract.md`. **No runtime change**: core, file journal, A–D, adapters, workers, `lib/`, SQL, fixtures, config, packages, pins untouched.

## 1. What ran, and which layers were real

| Layer | Real or injected |
|---|---|
| Disposable local PG (`startMigratedDatabase`), `test_app` (pools.app) / `test_report` (pools.report) logins | **REAL** |
| Core `runConnectedTest` (`scripts/e7-connected/run-core.mjs:135`), B guard / lifecycle, C facts, D validators, adapters, the four imported workers | **REAL, unchanged** |
| File journal `openFileJournal` (`scripts/e7-connected/run-journal-file.mjs:170`) on real local files in fresh `os.tmpdir()` 0700 directories | **REAL, unchanged** (default `node:fs` adapter in G1 / G2) |
| Provider world, transports, `payment_authorized` booking setup | **SYNTHETIC** — copied verbatim from `test/db/e7-connected-adapter-rehearsal.test.mjs:41–226` (byte-identical, checked with `diff`); mocked authorization |
| G3 / G4 file faults | **INJECTED (labelled)**: a test-local `fsAdapter` wrapping the module's own `createNodeFsAdapter()`, changing exactly ONE journal operation (one sync error / one gated write) |
| Time | scaled real timers (K = 10) passed as `monotonic` / `timers`; business clock = real clock (G1, G2a, G3, G4) or 20 min behind real time, capped 5 s behind (G2b recovery) |

Not used: worker injection, hooks, timeouts, trigger bypass, raw lifecycle writes, network (global fetch guard: 0 attempts), credentials. The core gets the file journal's `{ append, read }` object directly (no wrapper); it observes each call through `guard.observe(now + JOURNAL_MS, …)` (`run-core.mjs:258`, `:361`).

## 2. Cases and evidence (all CLAUDE-RUN; root cannot run PG)

**G1 — end to end, real file journal.** Fresh synthetic USD booking → `ENDED_CONFIRMED`, key `confirmed`, `journalTerminal:'acknowledged'`, `effectsKnown:true`; `finalize` → `unlocked`; file `close` → `{ closed, released }`.
- Independent counts agree: world writes `{ create 1, capture 1, offline charge 1, void 0, cancel 0 }`; transport requests `POST /v1/reservations` 1, `paymentIntents.capture` 1, `POST /v1/guestPayments/charges/<id>` 1, cancel 0, `PUT` 0; DB dispatched write ops 1 / 1 / 1 / 0 / 0; state `confirmed`; no open case; `guest.notify` row `["pending", null, 0]` (queued, never invoked).
- Journal on disk (15 records): `RUN_STARTED, ATTESTED:CALENDAR_BASELINE, STEP×2 reservation (pending → confirmed), PHASE_ENDED reservation, ATTESTED:AIRBNB_BLOCKED, STEP capture → payment_captured, PHASE_ENDED capture, STEP recording → confirmed, PHASE_ENDED recording, RUN_ENDED`.
- Independent verification with a FRESH handle: stored bytes = concatenated `encodeRecordLine(record)`; every `prevHash` = `D.recordHash(previous)`; handle head = `{ 15, recordHash(last) }` = the core's `journalSeq`; `validateJournal` → `ENDED`; `evaluateStart` → `RUN_ENDED`. No guest value and no path in the file.
- Re-invoke with a fresh handle → `REFUSED RUN_ENDED`, `journalSeq 0`; transport count, world writes and DB facts (writes, op count, transitions, cases, notify) unchanged.

**G2 — no resume.**
- (a) Stop **before** any provider write: `CALENDAR_BASELINE` declined → `STOPPED OWNER_DECLINED`, key `null`, `effectsKnown:true`, zero transport calls, intent still `payment_authorized`, zero dispatched writes. File: `RUN_STARTED, RUN_STOPPED` (code `OWNER_DECLINED`, key `null`) → D `RUN_ENDED`. Re-invoke → `REFUSED RUN_ENDED`, zero effects.
- (b) Stop **after** a genuinely applied write: the accepted world mode `appliedThen503` (the fake applies the create, then answers 503). The accepted recovery reached `reservation_confirmed` (journal: 2 + 4 reservation steps, `unknown` ×4 → `confirmed`). After `AIRBNB_BLOCKED` the core's strict gate stopped **`OPEN_CASE`**, key `reservedNotConfirmed`. One applied create, zero capture-phase calls. DB: exactly one create row, still `outcome_unknown`, case `HOSTAWAY_CREATE_OUTCOME_UNKNOWN` still OPEN — never reconciled or closed for convenience. Re-invoke → `REFUSED RUN_ENDED`; same single create idempotency key, no new row / key.

**G3 — INJECTED sync failure after an applied create.** Journal sync #7 (= append #6, the `STEP_ENDED` of the create step) throws `EIO` (the write itself completed).
- Core: `STOPPED JOURNAL_FAILURE`, `journalTerminal:'not_attempted'`, `effectsKnown:false`, key `reservedNotConfirmed`; exactly 6 journal writes / 7 syncs (no `RUN_STOPPED`, no retry); no capture-phase call; the file handle is poisoned (`failed`).
- Lifecycles stay distinct: runner `finalize` → `unlocked` (a journal failure is not a DB failure); file `close` → `{ closed, released }` after every started file operation settled.
- Reopen: the unacknowledged line IS on disk (6 records, last `STEP_ENDED reservation_confirmed`) — a failure / timeout never proves absence. D's actual verdict: `RESTART_AMBIGUOUS` (`interruptedStep:false`). DB: `reservation_confirmed`, 1 dispatched create, 0 captures. Re-invoke → `REFUSED RESTART_AMBIGUOUS`, zero effects.

**G4 — terminal append timeout with a test-controlled late completion.** On the planned `ENDED_RESERVED_NOT_CAPTURED` path, journal write #9 (`RUN_ENDED`) waits for a test gate.
- Core: bounded failed result `STOPPED TIMEOUT_JOURNAL`, `journalTerminal:'unknown'`, key `reservedNotConfirmed` (R-E3 semantics); exactly 9 journal writes (one terminal attempt); no further worker / provider call.
- Runner `finalize` → `unlocked` (worker / DB ownership quiescent). File `close` stays pending (> 300 ms observed) while the write is held; the journal lock still exists; the handle still shows 8 acknowledged records. After the gate opens, the write lands and `close` resolves `{ closed, released }`.
- Fresh reopen: 9 records, last `RUN_ENDED ENDED_RESERVED_NOT_CAPTURED` → D `RUN_ENDED`; re-invoke → `REFUSED RUN_ENDED`, zero resend.

## 3. Resource cleanup
Every successfully opened file journal in the suite is closed and its result asserted `{ fileClose:'closed', lock:'released' }` (including every verification and re-invoke handle); every `RunResult.finalize` was observed and resolved `unlocked`; no lock file remains (G4 asserts it exists only while the write is pending). Under `--trace-warnings` all runs printed **zero** "Closing file descriptor … on garbage collection" / DEP0137 lines. Temp directories are removed after the suite. No ownership was force-released.

## 4. Validation (CLAUDE-RUN)
```
node --trace-warnings --test --test-concurrency=1 test/db/e7-connected-file-journal-rehearsal.test.mjs   # needs local PG binaries
node --test test/e7-connected-*.test.mjs test/hostaway-reservations.test.mjs test/e4-connected-path.test.mjs
npm test
```
- **FIRST FULL TAP:** 4/4 (≈ 16 s), zero GC fd warnings. No first-run failure to retain.
- Two further runs: 4/4, zero warnings.
- Foundation / file / adapters / pins: 148/148. `npm test`: 813/813.
- The accepted runner PG suite was not rerun: no harness module or runtime changed (the rehearsal copies its helpers test-locally). Full `test:db` not run (no wider concern). e74a not reproduced.

## 5. Limitations (stated)
- Linux only; no Windows run. No power-loss / storage durability claim; fsync semantics as the file-journal contract §3.3.
- Fakes prove mapping and integration only — no real provider behaviour, mapping or support claim (cancel / offline-charge endpoints remain LIVE-UNVERIFIED).
- G3 / G4 file faults are injected through the swappable adapter, not real disk failures.
- The no-resume refusals rest on the journal; a lost or replaced journal falls back to the core's DB P0 eligibility (file-journal contract §5), which this rehearsal does not re-test.
- Live gates CLOSED; owner inputs UNSET; protected ids zero action (no fake request named one); e74a OPEN.

## 6. Status / next step
Root REVIEW **ACCEPTED** this rehearsal offline at `14d975ab` (tests / report / pointer only; PG results CLAUDE-RUN). Next (DOCS ONLY, not implemented, not authorized): the transport safety contract `claude/e7-connected-transport-contract.md` (branch `feature/e7-connected-transport-contract`), specifying the injected HTTP transport layer for the accepted adapters' `send` interfaces. Nothing in this report changes.
