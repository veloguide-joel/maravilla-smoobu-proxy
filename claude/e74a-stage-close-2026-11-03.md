# E7.4a stage close: review record (2026-11-03)

Branch `feature/e7-cancel-void-worker`. Offline only: no merge, rebase, deployment, live provider call or new credential. E7.4b stays BLOCKED, and this document does not authorize it.

## 1. Commit ancestry (linear; each commit's parent is the row above it)

| # | Commit | Content | Root status |
|---|---|---|---|
| 0 | `a49b8d9` (`feature/e7-compensation-proof`) | E7.4a-0 pure compensation proof / request foundation | KEEP (accepted earlier) |
| 1 | `8c9dfe0` | E7.4a cleanup worker (void / host-cancel), fake providers, local PG | HOLD (claim gap) → superseded by 2–3 |
| 2 | `dc32f93` | void/cancel claim fences in both `claimNextOperation` stages + migration 0009 | satisfactory on source review |
| 3 | `8b85d1d606d976d4b6372038d87627c8e941f2d5` | phase-guarded `reissueOrphanRead`; version-bound capture exhaustion | **ACCEPTED OFFLINE (E7.4a)** |
| 4 | `c1ce4811f9ba6d652480de1c370d1c4fcf49c8b4` | reservation worker uses the scoped re-issue + bound exhaustion | sound on review; HOLD for maintenance gap → 5 |
| 5 | `24f6ba5e8302be4a43cf67effd5bb513d8f43ab4` | reservation-worker maintenance `intentStates: WORK_STATES` | **ACCEPTED OFFLINE** |
| 6 | `9848bc71d0c6e06a333994c554e0d8ee216902cd` | `requestRecoveryRead` intent-first `FOR NO KEY UPDATE` serialization | **ACCEPTED OFFLINE** (scope: the proven competing-`requestRecoveryRead` race only) |
| 7 | this commit | test-only diagnostic + evidence for `concurrency.test.mjs` "12 random concurrent claims" + this record | awaiting root |

## 2. Verification: who verified what

| Item | Root (independent) | Claude-reported (not root-verified) |
|---|---|---|
| 8b85d1d source/design | exact source review, acceptance | DB tests: new orphan-scope file 8/8 (7 fail on dc32f93) |
| c1ce481 | source review: sound | 5/5; 3 fail on 8b85d1d |
| 24f6ba5 | source review, acceptance | 3/3; 2 fail on c1ce481 |
| 9848bc7 | exact commit/source/test review; `node --check` of recovery.js and the new serialization test | forced test 3/3 (old code fails 2/3 with 2 pending reads); e7-recovery 24/24 ×3; `npm test` 650/650; `npm run test:db` 268/268 (one run) |
| full PostgreSQL / unit suites, all commits | not run by root | all suite counts above |
| this commit (diagnostic) | — | §3 |

## 3. Diagnosis of the `concurrency.test.mjs` "12 random concurrent claims" failure

**Classification: retry exhaustion on 40P01 deadlocks among overlapping exclusion-constraint inserts.** This is a runtime availability defect in `beginPayStep`. No invariant was violated, and it is not a fixture or harness fault.

- **Method.** `test/db/diag/random-claims-diagnostic.mjs` (outside the `test/db/*.test.mjs` glob) re-runs the exact 12-claim scenario on fresh listings for a bounded number of iterations. It uses an instrumented pool that records every SQL error (SQLSTATE, statement, PostgreSQL detail, intent) and collects outcomes with `Promise.allSettled`. It stops at the first failure and dumps the claim, attempt, outbox and intent rows. The source is 9848bc7; production code is unchanged.
- **Bounded effort.** 100 iterations solo, then 4 parallel processes × 100 (to mimic `--test-concurrency=4`).
  - Solo: 0/100 failures, 35 deadlocks, at most 1 per intent.
  - Parallel: 1 failure (process 3, iteration 0); the other three processes went 100/100, 100/100 and 100/100 with 35–40 deadlocks each, at most 3 per intent.
- **Captured failure** (`test/db/diag/random-claims-evidence-9848bc7.txt`):
  - Outcomes: 5 `ok`, 5 `DATES_CLAIMED`, **2 THROWN `40P01 deadlock detected`**. The test's `res.every(ok || DATES_CLAIMED)` would therefore fail; in the real test, `Promise.all` rejects with the 40P01.
  - The 4 intents in the conflict cluster are i = 2, 5, 8, 11, with stays [14,18), [15,18), [16,18), [17,22). All of them contain night 17.
  - Mechanism, from the PostgreSQL detail:
    1. Transaction 783 (intent `1fbcc74a`, i = 5) inserted its claim and was waiting on another conflicting uncommitted claim.
    2. Each retry by `b6a051d7`, `a0bdadb4` or `83764923` inserted a conflicting tuple. It waited on 783, while 783, rechecking, waited on the newcomer's new transaction ("Process 441 waits for ShareLock on transaction 782/789/791/793…; blocked by process 438/444/447"). That is a fresh 2-cycle every time.
    3. The newcomer was chosen as the victim each time. Retries are immediate, so the cycle re-forms.
  - Retry counts: `b6a051d7` and `a0bdadb4` each hit 40P01 4 times (initial try + `casMaxRetries` = 3), so they exhausted and threw. `83764923` failed 3 times and succeeded on its 4th try. 783 was finally the victim once, retried and got 23P01 → `DATES_CLAIMED`.
  - **Invariant held:** 0 overlapping active claims. The 5 `ok` intents each have exactly one claim, one `creating` attempt and one pending `stripe.create_checkout_session`. The 2 thrown intents left no rows (rolled back). All 12 intents remain `details_collected` v2.

## 4. Fix proposal (NOT implemented; production repo.js is outside this phase)

**Minimal fix:** in `beginPayStepOnce`, after the intent `FOR UPDATE` and immediately before the claim insert, take a per-listing transaction advisory lock:

```sql
SELECT pg_advisory_xact_lock(hashtext('booking.inventory_claims'), $listing_id::int)
```

- **Effect.** Inserts into the claim exclusion constraint for one listing are serialized, so the mutual-wait cycle cannot form. A later caller blocks briefly, then sees the committed claim and gets 23P01 → `DATES_CLAIMED` (or inserts if there is no overlap).
- **Lock order:** intent → listing lock, and the lock is held only for the short transaction. No provider work runs in the transaction: the Stripe create is only queued.
- **Unchanged:** the return contract, the retry budget and the 40P01/40001 retry loop (kept as defence). No schema or migration change.
- **Test-only simulation** (`--simulate-listing-lock`; the wrapper injects the lock, production code untouched): 4 parallel × 100 iterations gave **0 failures and 0 deadlocks**, against 35–40 deadlocks per 100 without it.
- **Residual:** the owner-only `booking.admin_acquire_claim` (0003) inserts claims without that lock. It is still correct (the exclusion constraint applies), but it could deadlock-abort against a concurrent checkout. Covering it would need a migration and is not proposed now.
- **Rejected alternatives:** raising `casMaxRetries` or adding backoff only lowers the probability; relaxing the test hides a real 500 path.
- **Proposed regression:** the diagnostic's parallel scenario, bounded, plus a deterministic check that the lock is taken before the insert.

## 5. Open residuals

1. The `beginPayStep` deadlock retry exhaustion (§3): a runtime defect; the fix is proposed and awaiting root decision.
2. 9848bc7's scope is the competing `requestRecoveryRead` race only. It is **not** global uniqueness: `requestRead` and other read producers take only FK `KEY SHARE`, which is compatible with the lock.
3. Fake providers only; no platform validation; R-REFUND unverified; B5 limitation retained; the non-constructible pending-cancel / settled-reservation fixture.
4. The raw old-failure evidence is kept (feature branch evidence files and local `e2c-out/evidence/`). The project upload of the raw 24f6ba5 failure text was refused for capacity, and its key fields are in the ledger.

## 6. Next-stage recommendation

- **First:** a root decision on §4. If approved, a bounded repo.js change and regression as a separate commit.
- **E7.4b (offline-charge bookkeeping) stays BLOCKED.** Needed before any implementation, with no new credentials or live calls:
  - **B1 evidence (owner-supplied or decided).** The public Hostaway docs list `POST /v1/guestPayments/charges/{reservationId}`, a guest-charges LIST (limit 100 by default, 500 max, reservationIds filter) and the `paymentMethod` values. Still unproven:
    - live acceptance of the request shape;
    - which `paymentMethod` represents a Stripe-collected payment (owner decision: e.g. `credit_card` vs `other`);
    - whether a marker in title/description is returned by the LIST, which is needed for the "exactly one charge with marker + amount" confirmation;
    - the LIST's ordering and pagination semantics.

    These can come from an owner-run, already-authorized read in a future approved live step, or from Hostaway support documentation. Neither is requested here.
  - **I7 owner decision.** Confirm the contract rule: an unknown offline-charge recording stays a case-only alert (the existing `markUnknown` → `OFFLINE_CHARGE_OUTCOME_UNKNOWN`), the paid intent is never escalated to `under_review`, and the planner's operator plan is intercepted. Alternatively, authorize a reviewed DB entry point for a non-escalating alert kind.
