# E7 run journal v2 — M2-B (MEMORY-ONLY, MODE-BOUND FOUNDATION)

**Status:**
- `scripts/e7-connected/run-journal-memory-v2.mjs` is a pure, in-memory v2 journal plus record, chain and start validation.
- It is **not** durable, a file journal, a hosted store, a live gate, an approval or a DB check.
- **Nothing consumes it:** `run-core`, the v1 memory and file journals, the launcher, workflows and workers are byte-exact, and they still consume manifest v1 and journal v1 only. Test J11 pins their hashes.
- No v1 journal is relabelled, migrated or adopted.

## Contract decisions

1. **Version and hash domain.**
   - Record `v: 2`.
   - Hash `sha256("e7-run-journal-v2\n" + canonical JSON)`, using the accepted canonical JSON.
   - v1 and v2 records and journals cross-refuse (J9):
     - a v1 record has no `manifestVersion` / `connection`, so it is a `RECORD_SHAPE` / `JOURNAL_MALFORMED` in v2;
     - a v2 record has extra keys, so it is a `RECORD_SHAPE` in v1;
     - a v1 chain relabelled without re-hashing gives `JOURNAL_CHAIN_INVALID`.
2. **Identity is derived, never supplied.**
   - `bindManifestV2(manifestInput)` runs `validateRunManifestV2` on the manifest input.
   - The identity `{ manifestVersion, connection, runId, intentId, baselineCommit, manifestHash }` uses the validated manifest's fields and its **computed** v2 hash.
   - There is no identity, connection or hash option: `createMemoryJournalV2` accepts only `{ manifest, preload?, faults? }`.
   - Every record carries all six identity fields.
   - The frozen binding fixes the checkpoint mode and the planned phases for the journal's life, and caller mutation after construction changes nothing (J2).
   - `validateJournalV2` and `evaluateStartV2` re-validate the manifest input on every call.
3. **Mode-exact checkpoints.**
   - The names come from the validated manifest: disconnected = `CALENDAR_BASELINE / CALENDAR_BLOCKED / CALENDAR_REOPENED`; airbnb = `CALENDAR_BASELINE / AIRBNB_BLOCKED / AIRBNB_REOPENED`.
   - An ATTESTED checkpoint outside the bound mode's three gives `CHECKPOINT_MODE_MISMATCH`, at append and at replay, even inside a fully re-hashed hostile chain (J3).
   - Any other name gives a field error.
   - The internal list of known names is used ONLY to tell those two apart. It is never a permission, and v1 `CHECKPOINTS` is not widened.
4. **The accepted v1 rules apply unchanged, with the mode's names** (J4, J7):
   - one RUN_STARTED;
   - baseline before any step;
   - blocked only after the reservation phase ENDED `reservation_confirmed`;
   - capture only after blocked;
   - reopened only after a reservation existed AND cleanup ended `cancelled`;
   - phase entry and end states, consecutive steps, open-step rules, write counts, and the exact cleanup key per outcome;
   - one terminal, append-after-terminal refused, serial appends (`APPEND_IN_FLIGHT`), no retry, and refusals never mutate history;
   - start verdicts: `EMPTY_JOURNAL` (still requires the core's DB eligibility check), `RESTART_AMBIGUOUS`, `RUN_ENDED`, `JOURNAL_PARTIAL`.
5. **Planned phases.**
   - A capture step when `phases.capture` is false, or a recording step when `phases.recording` is false, gives `PHASE_NOT_PLANNED` at append and replay.
   - Outcomes that need an unplanned phase are refused (J5).
6. **testAbortAfterReservation.**
   - It is bound only through the manifest hash: a no-abort journal is a different identity (J6).
   - **No abort is represented.** There is no abort event, transition or API.
   - From `reservation_confirmed`, cleanup cannot start (the v1 cleanup entry from reservation is `reservation_failed` only), and `ENDED_RELEASED` and any reopen are refused.
   - The only honest terminal is `ENDED_RESERVED_NOT_CAPTURED` with owner cleanup key `reservedNotConfirmed`. Nothing fabricates abort, completion or release evidence.
7. **Integrity is relative to an independently trusted head (seq + hash).**
   - A fully consistent re-hashed rewrite validates without one; that is the documented limit (J8).
   - With a trusted head, a rewrite, truncation or extra tail gives `TRUSTED_HEAD_MISMATCH`.
   - A reorder or changed byte gives `JOURNAL_CHAIN_INVALID`; corrupt fields give `JOURNAL_MALFORMED`; a torn read gives `JOURNAL_PARTIAL`.
   - Memory-only: this is never a durable or hosted gate.
8. **Inputs.**
   - `bindManifestV2`, which every manifest-taking API calls (`validateRecordV2`, `validateJournalV2`, `evaluateStartV2`; the constructor additionally snapshots its whole options first), takes this module's OWN snapshot of the complete manifest input BEFORE the accepted v2 validator runs. A top-level, nested or revoked Proxy, or an accessor, therefore gives `MANIFEST_INVALID` (constructor: `JOURNAL_OPTIONS_INVALID`) with zero trap or getter calls and no throw. The validator only ever sees that frozen copy (root review of 868621b; J12).
   - There is one getter-free, own-data-descriptor, bounded snapshot before any await. It is a copy of the private v1 rules (v1 stays byte-exact), and it refuses Proxies.
   - Accessors, `toJSON`, symbols and boxed values are refused code-only with 0 caller calls.
   - An accessor anywhere in the journal options gives `JOURNAL_OPTIONS_INVALID`, the same as the v1 options rule. In `validateJournalV2` the manifest is validated directly, giving `MANIFEST_INVALID`.
   - Code-only `JournalError` (the accepted v1 class).

## Required next (NOT in M2-B)

- **Abort consumer slice.** Record an actual, accepted `TEST_ABORT_REQUESTED` (the reviewed E3 event and its DB transaction) as journal evidence BEFORE the two-leg cleanup. The design must include:
  - a new reviewed entry rule `(reservation, reservation_confirmed) → cleanup`, valid only when `testAbortAfterReservation` is true AND that abort evidence is present;
  - cleanup proofs for BOTH legs before `cancelled`;
  - the mode's reopened attestation;
  - `ENDED_RELEASED`.
  - No completion or release is ever inferred from the flag.
- **Durable v2 store.** A file or hosted durable v2 journal is a separate reviewed slice, with torn-tail, fsync and trusted-head anchoring evidence. The hosted durable-journal prerequisites stay parked.
- **Run-core integration.** Wiring run-core or a launcher to v2 is a separate reviewed slice. v1 runs stay v1.
