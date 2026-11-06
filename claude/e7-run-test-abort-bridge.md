# E7 M2-C — journalled TEST-abort bridge (OFFLINE, LOCAL; memory journal only)

## Purpose and boundary

M2-C represents ONE accepted intentional TEST abort after a proved reservation. After it, the v2 journal may enter the existing two-leg cleanup only **after verified abort evidence**.

- Neither the manifest flag nor a caller's or helper's success boolean ever permits cleanup.
- **Unchanged and byte-exact:** M2-A, the v1 modules, run-core, the launcher, workflows, workers, migrations, the accepted abort helper (`lib/booking-db/test-abort.js`) and the operator core (`scripts/e7-operator/test-abort.mjs`).
- **Extended:** only the v2 memory journal, plus the new inert bridge `scripts/e7-connected/run-test-abort.mjs`.
- No file or hosted durable store, no live launcher, no provider transport.
- Memory ACKs prove the **protocol only**, never durability.
- **Journal evidence is a trusted producer's record, not independent DB authentication.** It is anchored only by an independently trusted head (seq + hash).

## New v2-local record vocabulary

v1 readers and old valid v2 chains are unchanged: a chain without these events validates exactly as before.

| event | body | allowed when |
|---|---|---|
| `ABORT_REQUEST_STARTED` | `abort: { eventId, planHash, expectedVersion, paymentIntentId, reservationId }` | Manifest `testAbortAfterReservation=true` (otherwise `PHASE_NOT_PLANNED`); the last phase is `reservation`, ENDED `reservation_confirmed`; the mode's BLOCKED attested; no open step; no earlier abort record. `eventId` must equal `test-abort:{intentId}:{paymentIntentId}:{reservationId}` for the record's own `intentId`. |
| `ABORT_ACCEPTED` | `abort` (byte-equal to the started one) + `receipt: { appliedVersion, state, reason, capture: { state, attempts, dispatched }, queued, claimHeld }` | Immediately after `ABORT_REQUEST_STARTED`. The values are exact: `appliedVersion = expectedVersion + 1`, `state "capture_failed"`, `reason "TEST_ABORT_REQUESTED"`, `capture { "pending", 0, false }`, `queued ["alert.owner:pending", "hostaway.cancel_reservation:pending", "stripe.void_payment_intent:pending"]`, `claimHeld true`. |

**Between the two records** only `ABORT_ACCEPTED` or `RUN_STOPPED` may follow. Any STEP, ATTESTED, PHASE or RUN_ENDED gives `ORDER_INVALID`.

**Cleanup entry.**
- `(reservation, reservation_confirmed) → cleanup` is permitted ONLY after `ABORT_ACCEPTED`. This mirrors the reducer: the DB intent is now `capture_failed / TEST_ABORT_REQUESTED`. No `CAPTURE_FAILED` is fabricated, and capture is never started.
- The v1 entries (`reservation_failed`, `capture_failed`) are unchanged.

**Release.**
- After any abort record, `ENDED_RESERVED_NOT_CAPTURED` is refused, because the DB state changed or is uncertain. The run must STOP or finish the cleanup.
- `ENDED_RELEASED` needs cleanup ENDED `cancelled` and the mode's REOPENED attestation. The cleanup steps carry the accepted worker's BOTH-leg proofs.
- An unknown leg cannot reach `cancelled`, and cleanup ending `authorization_released` with a standing reservation needs the v1 owner key.

## Bridge handshake (`runTestAbortBridge`)

1. **Bind.** `bindManifestV2` (snapshot, then validate) must show `testAbortAfterReservation=true, capture=false, recording=false`.
   - The operator expectation is bound with the accepted `bindAbortExpectation` (frozen; primitive types) and must match the accepted `abortPlanHash`.
   - The expectation must equal the manifest's intentId / listing id / currency / arrival / departure / guests / amountMinor (`finalTotalMinor = authorizedMinor`).
   - No default owner data, no new quote, no historical-row adoption.
2. **Read and anchor.**
   - The journal is read once, bounded by the injected guard (`LIMITS.JOURNAL_MS`).
   - `journalFactsV2` with the caller's INDEPENDENT trusted head must report: in progress, anchored, abort ready (reservation confirmed + blocked, no abort record).
3. **Start record.**
   - Append `ABORT_REQUEST_STARTED` (`seq = head + 1`, `prevHash = head.hash`), bounded.
   - The ACK must equal exactly `{ seq, hash: recordHashV2(record) }`.
   - On reject, timeout, malformed ACK or guard fault: `STOPPED_START_UNACKED` with **0 helper invocations**.
4. **Invoke once.** `executeOperatorAbort(pool, expectation, { now, env })` — the accepted operator core, which calls `requestTestAbort` once and never retries — runs **at most once**, bounded (`LIMITS.STEP_MARGIN_MS`). There is no second implementation and no repo gate is bypassed.
5. **Outcome.**
   - Only `REQUESTED` proceeds.
   - `REFUSED` and `NOT_EXECUTED_*` give `ABORT_REFUSED`.
   - `DUPLICATE_RECONCILED` gives `ABORT_NOT_THIS_RUN`: an abort applied outside this journal handshake is never adopted.
   - Timeout, throw, `REQUEST_OUTCOME_UNKNOWN` or `POSTCHECK_MISMATCH` give `ABORT_OUTCOME_UNKNOWN`.
   - For every non-`REQUESTED` outcome: **no resend**, no receipt, no cleanup permission. Read-only diagnostic facts are returned when the postcheck runs.
6. **Read-only postcheck** (bounded; SELECTs and `loadIntent` only). Every one of these must hold, otherwise `ABORT_POSTCHECK_FAILED`:
   - `intent_applied_events` has exactly the deterministic event id, with type `TEST_ABORT_REQUESTED` and `applied_version = expectedVersion + 1`;
   - `intent_transitions` has `reservation_confirmed → capture_failed`, `TEST_ABORT_REQUESTED`, actor `admin`, `version_after = applied`;
   - the intent is `capture_failed / TEST_ABORT_REQUESTED`, with the version applied, the same PI and reservation id, and settlement legs both false;
   - exactly ONE capture row: pending, attempts 0, undispatched, unleased;
   - the ops of the applied version are exactly the 3 queued obligations, each pending with 0 attempts;
   - the claim is still held;
   - there is no open reconciliation case.
7. **Receipt.**
   - Append `ABORT_ACCEPTED` carrying those proof fields, bounded; the exact ACK is required.
   - A lost or ambiguous receipt gives `STOPPED_RECEIPT_UNACKED`. The DB outcome (accepted) is preserved in the result for recovery, and cleanup is **not** permitted.
   - Only an ACKed receipt gives `ABORT_ACCEPTED_JOURNALED` with `cleanupPermitted: true`.
8. **The bridge never appends RUN_STOPPED / RUN_ENDED and never runs the cleanup worker.** The consumer, run-core in a later slice, decides the stop. The existing compensation worker then settles BOTH legs, each on its own proof. The pending capture row stays untouched and fenced (0007); claim release in `cancelled` relies on the 0017 local candidate.

## Contract decisions made during M2-C

- **Binding carries its own manifest.** `bindManifestV2` now also returns `manifest`: the validated, frozen copy, alongside `facts`.
  - After its first await, the bridge re-binds ONLY that copy, never the caller's object.
  - H5 caught the first draft re-reading the caller's mutated manifest after the journal read; that run was refused, which is fail-closed but wrong.
- **The M2-B J6 export assertion is narrowed.** The journal now names the v2-local record vocabulary (`ABORT_QUEUED`, `ABORT_REASON`), but still exports no function that requests or applies an abort, and it imports no abort helper.
- **Forged identity on abort records** fails the field check (`JOURNAL_MALFORMED`) before the identity check, because the deterministic event id embeds the record's own intent id. A forged identity on a chain without abort records is still `MANIFEST_MISMATCH`.
- **`DUPLICATE_RECONCILED`** from the operator core means an abort was applied outside this handshake. The result is `ABORT_NOT_THIS_RUN`; it is never adopted.

## Limits

- Memory journal only.
- Not wired into run-core or a launcher.
- No hosted runner.
- 0017 is applied only to disposable local PG in tests.
