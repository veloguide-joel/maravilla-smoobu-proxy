# E7 M2-D — v2 reservation → intentional TEST abort → cleanup consumer (OFFLINE, LOCAL, inert)

> **STATUS: BLOCKED on an accepted-contract contradiction (§8). Nothing was relaxed.** With the accepted helper unchanged, every real-worker lifecycle stops at the bridge with `ABORT_REFUSED / TEST_ABORT_EVIDENCE_CONFLICT`, fail-closed. A minimal helper proposal is in §8 for root; it is NOT applied on this branch.

`scripts/e7-connected/run-core-abort-v2.mjs` exports `runAbortRehearsalV2(opts)`. It is a new, separate core.

- **Byte-exact (unchanged):** the v1 `run-core.mjs`, every journal, every manifest, the workers, the migrations, the launcher, the workflows and the accepted M2-C bridge.
- **Not built here:** hosted activation, real-manifest acceptance, a durable store, capture and recording.

## 1. Input and binding (synchronous, before ANY await)

**Options.** The core accepts exactly these keys: `attest, clock, intentId, journal, manifest, monotonic, pools{app,report}, signal, timers, transports{hostaway,stripe}, trustedHead`. They are read through the v1 getter-free helpers.

**Manifest.**
- `bindManifestV2` snapshots the manifest (Proxy-refusing) and validates it. The ONE frozen copy (`binding.manifest`) is the only manifest used afterwards.
- The plan must be exactly `testAbortAfterReservation=true, capture=false, recording=false`, with `synthetic=true` and `providerMode {hostaway:"fake", stripe:"mock"}`. Anything else is `PHASE_PLAN_UNSUPPORTED`.
- Every refusal here happens with zero DB, journal, transport, attestation or timer calls.

**Intent and identity.**
- `intentId` must equal the manifest's intent.
- Journal records are v2 records: `{v:2, seq, prevHash, ...binding.identity, at, event, ...}`. Each is validated by `validateRecordV2` against the frozen copy.
- Checkpoint names come from `binding.checkpoints`: `baseline`, `blocked`, `reopened`. Synthetic attestations name the mode's checkpoints and are never Airbnb or calendar proof.

## 2. Carried over unchanged from v1 (same code shape, same accepted modules)

- **P0:**
  - report-role lock client;
  - the `e7-connected-runner` advisory lock, the SAME key as v1, so a v1 and a v2 run exclude each other;
  - the S1/S2 same-DB and TEST-marker check (report vs app);
  - the journal start rule (`evaluateStartV2`: EMPTY only, optional trusted head);
  - the C snapshot, with the protected-reference scan first, the `payment_authorized` / no-write / no-case eligibility, and the exact expected-intent identity.
- **Bounds:** fresh absolute deadlines (`deadline(ms)` capped by the phase budget), bounded steps, the post-result tail observation, the stop-before-every-operation rule (`blocked()`), and the exact `{seq, hash}` journal ACK protocol. After an unACKed append, no later append is ever made.
- **Workers:** the reservation and compensation phases call the REAL accepted `runOrchestratorStep` / `runCleanupStep` on `pools.app`, through `createPhaseExecutors` + `wrapExecutors` over the injected transports.
  - Every call passes `intentId` = the ONE bound intent and `listings` = a Map holding ONLY the manifest listing. The workers derive their maintenance scope (`listingIds`) from that Map, so no global maintenance runs.
  - No admin credential is substituted.
- **Out of scope:** no new quote and no adoption of historical rows. Guest notification and owner alert operations stay queued and unsent; no notification worker is invoked.

## 3. Flow

```
P0 eligibility → RUN_STARTED → ATTESTED(baseline)
→ reservation phase (accepted worker; unknown create → its own reads / stop, never a second create)
   ├─ reservation_failed → cleanup phase → authorization_released → ENDED_RELEASED (v1 void-only route; no blocked / reopened)
   └─ reservation_confirmed → ATTESTED(blocked)
→ fresh snapshot (strict fact stops) + expectation build → runTestAbortBridge ONCE
→ CONSUMER GATE (§4) → cleanup phase (accepted compensation worker) → `cancelled`
→ release proof (§5) → ATTESTED(reopened) → RUN_ENDED ENDED_RELEASED (ownerCleanupRequired null)
```

**Expectation.** It is built with the accepted `buildAbortExpectation` from the frozen manifest and the fresh post-blocked snapshot:
- `expectedVersion`, PI, reservation id and `authorizedMinor` come from the intent facts;
- `sessionId` / `attemptId` come from EXACTLY ONE succeeded `stripe.create_checkout_session` operation (its `resultRef` and its `paymentAttemptId` payload);
- `approvalRef = e7-run:{runId}`.

Missing or ambiguous data gives `ABORT_EXPECTATION_UNAVAILABLE` (a stop, before the bridge). The accepted helper re-verifies every field against the DB under its own locks.

**Bridge call.** The bridge gets these arguments:
- `manifest`: the frozen copy;
- `journal`: a frozen `{append, read}` facade over the caller's journal;
- `guard`: a frozen `{observe, now}` facade over the run's guard;
- `trustedHead`: the run's LAST ACKED head;
- `pool`: `pools.app`;
- `env`: `{VERCEL_ENV:"development", MV_E7_TEST_ABORT:"enabled"}`;
- `now`: the business clock.

There are no `operatorDeps`. The bridge is called at most once per run.

## 4. Consumer gate (before ANY cleanup step)

All of these must hold:

1. `outcome === "ABORT_ACCEPTED_JOURNALED"`, `cleanupPermitted === true`, `receiptLanding === "ACKED"`.
2. `startAck.seq === head.seq + 1` and `receiptAck.seq === head.seq + 2`. `receiptAck` deep-equals `trustedHead`, and both are well-formed `{seq, hash}`.
3. A bounded journal read, validated by `journalFactsV2(records, frozenManifest, {trustedHead: receiptAck})`, shows anchored, IN_PROGRESS, `abortAccepted && cleanupEntryPermitted`.
4. The lock is still held and there is no stop cause.

Permission is NEVER inferred from the manifest flag, a helper or DB success boolean, `dbAbortApplied`, or an UNANCHORED `journalFacts`. A failed gate is `ABORT_GATE_FAILED`.

## 5. Release proof (after cleanup ENDED `cancelled`)

One bounded app-client read: the accepted `loadIntent`, plus `SELECT count(*) … inventory_claims WHERE intent_id=$1 AND released_at IS NULL`. It requires:
- `cancelled / TEST_ABORT_REQUESTED`;
- settlement legs `true/true` (host-cancel and authorization-void; these are not refunds);
- claim released (the local 0017 candidate).

Otherwise the result is `RELEASE_NOT_PROVEN`. This read and the v1 lock / same-DB statements are the only SQL text in this module.

## 6. Every bridge stop is honoured

The stopped result carries `bridge` (the full frozen bridge result: counters, acks, trustedHead, receiptLanding, dbAbortApplied, postcheck), `trustedHead` (the run's last ACKed head) and `journalTail` (`KNOWN` | `UNKNOWN`).

| bridge outcome | journal tail after it | RUN_STOPPED appended? |
|---|---|---|
| `REFUSED_BEFORE_START` | the caller's head (nothing appended) | yes |
| `STOPPED_START_UNACKED`, code `GUARD_NOW_*` / `NOT_STARTED_*` (append never started) | the caller's head | yes |
| `STOPPED_START_UNACKED`, any other code | UNKNOWN (the start MAY have landed) | **no** |
| `STOPPED_BEFORE_OPERATOR` / `ABORT_REFUSED` / `ABORT_NOT_THIS_RUN` / `ABORT_OUTCOME_UNKNOWN` / `ABORT_POSTCHECK_FAILED` | the start ACK | yes (allowed after ABORT_REQUEST_STARTED) |
| `STOPPED_RECEIPT_UNACKED`, `receiptLanding NOT_ATTEMPTED` | the start ACK | yes |
| `STOPPED_RECEIPT_UNACKED`, `UNACKED_MAY_HAVE_LANDED` | UNKNOWN | **no** |
| `ABORT_ACCEPTED_JOURNALED`, shape or ACK checks (§4.1–2) fail | UNKNOWN | **no** |
| `ABORT_ACCEPTED_JOURNALED`, exact receipt ACK, then a stop / lock loss before the gate read | the receipt ACK (KNOWN) | yes (e.g. `exclusion: lost`) |
| `ABORT_ACCEPTED_JOURNALED`, gate read fails or is not anchored to `receiptAck` | UNKNOWN (the journal disagrees or is unread) | **no** |

**Effects.** Once the operator core was started, `effectsKnown=false` and the counts are stale; the bridge's operations are guard-bounded but NOT lifecycle-tracked.
- A stop never retries the bridge or resends.
- It never truncates or adopts.
- It never continues to cleanup.

The owner cleanup key is conservative: `reservedNotConfirmed` once a reservation existed.

## 7. Limits

- Memory journal and fake/mock providers only.
- Not wired to a launcher or a hosted runner.
- 0017 is applied only to disposable local PG.
- The v1 core is untouched; its suite is not rerun (no v1 source change).

## 8. BLOCKER: the accepted helper's evidence rule vs the accepted reservation worker and schema

**The rule.** `lib/booking-db/test-abort.js:179` (accepted, pinned `a00952ca…`) refuses ANY `hostaway_reservation` evidence row unless `external_ref === reservationId && status === "new"`.

**Why it can never be met.**
- The schema allows only `found_active`, `cancelled` or `not_found` for that kind (`db/migrations/0003_safety_corrections.up.sql:85–88`). So `"new"` can never occur, and every such row refuses.
- The accepted reservation worker ALWAYS records its pre-create by-ref lookup as evidence `{kind: hostaway_reservation, external_ref: <booking ref>, status: not_found, observed: {bookingRef, matchCount: 0}}` (`lib/booking-db/reservation-worker.js:214–221`).
- Observed on disposable PG at the blocked point (`diag.txt`): `[{"kind":"hostaway_reservation","external_ref":"MV-T00001","status":"not_found","source":"hostaway_api"}]`.

**Why the helper's own suites missed it.** They (e7-test-abort, M2-C B1–B9) build `reservation_confirmed` through `recordHostawayCreateResult` with no lookup, so no evidence row exists.

**Minimal proposal (root decision; helper change; one condition).** Accept exactly two shapes and keep every other row a conflict (cancelled, a foreign ref or id, offline charges, a non-`requires_capture` PI):
- `found_active` for the bound reservation id;
- the pre-create `not_found` for the DB intent's own booking ref.

```js
if (x.kind === "hostaway_reservation" && !((x.external_ref === e.reservationId && x.status === "found_active")
  || (x.external_ref === before.ref && x.status === "not_found"))) fail("TEST_ABORT_EVIDENCE_CONFLICT");
```

**Proof.** In a THROWAWAY copy (not on any branch) with only that change, this suite passes 6/7. The only failure is M7, which pins the helper's accepted bytes and fails by design.

If accepted, the proposal is a separate root-reviewed helper slice. After it, the M7 pin and this note are updated. No M2-D code change is expected.
