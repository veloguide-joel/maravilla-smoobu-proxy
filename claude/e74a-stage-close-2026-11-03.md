# E7.4a stage close: review record (2026-11-03; updated for 386df8a)

Branch `feature/e7-cancel-void-worker`. Offline only: no merge, rebase, deployment, live provider call or new credential. E7.4b stays BLOCKED, and this document does not authorize it. Stage completion is root's call; nothing here declares it.

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
| 7 | `8eea6ab2cebfa1e335fe294d5e3a293d0112a972` | test-only diagnostic + evidence for `concurrency.test.mjs` "12 random concurrent claims" + this record | **accepted as OFFLINE DIAGNOSIS/EVIDENCE** (not stage/release completion) |
| 8 | `4c22ec6f4db95dc9142d62f818c174d8f1e6fb9a` | raw 24f6ba5 `requestRecoveryRead` old-failure output (evidence only) | accepted with 7 (diagnosis/evidence) |
| 9 | `386df8a08e88b327f781da1d35f1d17d83aeeb7d` | `beginPayStepOnce`: per-listing `pg_advisory_xact_lock` immediately before the claim insert + `test/db/e74a-claim-listing-lock.test.mjs` | awaiting root |
| 10 | the commit after 386df8a (doc/evidence only) | this update + `test/db/diag/claim-listing-lock-evidence-386df8a.txt` | awaiting root |

## 2. Verification: who verified what

| Item | Root (independent) | Claude-reported (not root-verified) |
|---|---|---|
| 8b85d1d source/design | exact source review, acceptance | DB tests: new orphan-scope file 8/8 (7 fail on dc32f93) |
| c1ce481 | source review: sound | 5/5; 3 fail on 8b85d1d |
| 24f6ba5 | source review, acceptance | 3/3; 2 fail on c1ce481 |
| 9848bc7 | exact commit/source/test review; `node --check` of recovery.js and the new serialization test | forced test 3/3 (old code fails 2/3 with 2 pending reads); e7-recovery 24/24 ×3; `npm test` 650/650; `npm run test:db` 268/268 (one run) |
| full PostgreSQL / unit suites, all commits | not run by root | all suite counts above |
| 8eea6ab..4c22ec6 (diagnostic) | fetched the diagnostic, captured SQLSTATE/rows, this doc and current `beginPayStep`; compared 9848bc7..4c22ec6 (exactly 2 commits, test/doc/evidence only, no lib/db change); `node --check` diagnostic | stress counts (solo 100; 4×100 parallel; 4×100 simulated lock) |
| 386df8a (claim lock) | — (awaiting review) | §4a: guard old-fail / new-pass; focused 5/5; concurrency.test.mjs 8/8; `npm test` 650/650; `npm run test:db` 273/273 (one run each); post-fix diagnostic 4×100 without simulation: 0 failures, 0 deadlocks |

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

## 4. Fix proposal (as proposed at 8eea6ab; IMPLEMENTED at 386df8a after root authorization, see §4a)

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

## 4a. Implementation at 386df8a (Claude-reported; awaiting root review)

- **Diff:** `lib/booking-db/repo.js` +4 lines (3 comment, 1 statement), only inside `beginPayStepOnce`'s no-existing-claim branch, immediately before `INSERT INTO booking.inventory_claims`:
  ```js
  await c.query("SELECT pg_advisory_xact_lock(hashtext('booking.inventory_claims'), $1::int)", [row.listing_id]);
  ```
  - `row.listing_id` comes from the intent row locked `FOR UPDATE` just above, and is `integer NOT NULL` in schema 0001, so the cast is exact.
  - The lock lasts for the transaction only. No provider work runs inside it: the Stripe create is only queued.
  - Unchanged: the retry loop and budget (`casMaxRetries` = 3), return/error semantics, exclusion constraint, attempt/outbox idempotency, every other flow.
- **Advisory keyspace check:** the only other advisory lock in lib/db/scripts is the migration runner's single-bigint `pg_advisory_xact_lock(7302215001)`. The two-int4 form is a separate keyspace in `pg_locks` (`objsubid` 2 vs 1), so the two cannot collide. No other code takes this key.
- **Lock order:** intent row, then the listing advisory lock. The holder of the listing lock waits only on the exclusion check, i.e. on uncommitted claims, and those can come only from another checkout holding the same listing lock (impossible) or from `admin_acquire_claim`.
- **Regression** (`test/db/e74a-claim-listing-lock.test.mjs`), 5 tests:
  - The guard identifies the SPECIFIC waiter: an ungranted `pg_locks` advisory row with this listing's key (`classid` = hashtext key, `objid` = listing, `objsubid` = 2), from an app-pool backend whose current statement is the helper's lock call, while no claim exists.
  - The other four cover: another listing proceeds while a lock is held; 12 competing same-listing calls each return ok or `DATES_CLAIMED` with no overlaps, and refused calls leave no claim/attempt/outbox; adjacent stays both succeed; same-intent repeated calls reuse one attempt and op.
  - **Old source** (4c22ec6 repo.js): guard FAILS, "helper must wait on listing 996001's advisory lock (completed without waiting: true)", actual 0 vs expected 1. The other 4 pass, since they are behavioural and already held before the fix. **New source:** 5/5.
- **Post-fix bounded contention check:** the unchanged diagnostic, no simulated lock, 4 parallel × 100 iterations gave 0 failures and 0 deadlocks (40P01). Before the fix: 35–40 deadlocks per 100 and 1 captured failure.
- Evidence: `test/db/diag/claim-listing-lock-evidence-386df8a.txt`.

## 5. Open residuals

1. The `beginPayStep` deadlock retry exhaustion (§3) is addressed for checkout-vs-checkout at 386df8a, awaiting root review. **Mixed-producer residual:** `booking.admin_acquire_claim` (0003, owner-only) still inserts claims without the listing lock, so a concurrent owner acquire and checkout on overlapping nights can still deadlock-abort (40P01), or one waits briefly. Safety is unchanged (the exclusion constraint still prevents overlaps). Covering it needs a migration and is not proposed. 386df8a does NOT claim global deadlock-freedom for claim inserts.
2. 9848bc7's scope is the competing `requestRecoveryRead` race only. It is **not** global uniqueness: `requestRead` and other read producers take only FK `KEY SHARE`, which is compatible with the lock.
3. Fake providers only; no platform validation; R-REFUND unverified; B5 limitation retained; the non-constructible pending-cancel / settled-reservation fixture.
4. The raw old-failure evidence is kept (feature branch evidence files and local `e2c-out/evidence/`). The project upload of the raw 24f6ba5 failure text was refused for capacity, and its key fields are in the ledger.

## 6. Next-stage recommendation

- **First:** root review of 386df8a (§4a). Stage completion is root's decision.
- **E7.4b (offline-charge bookkeeping) stays BLOCKED.** Needed before any implementation, with no new credentials or live calls:
  - **B1 evidence (owner-supplied or decided).** The public Hostaway docs list `POST /v1/guestPayments/charges/{reservationId}`, a guest-charges LIST (limit 100 by default, 500 max, reservationIds filter) and the `paymentMethod` values. Still unproven:
    - live acceptance of the request shape;
    - which `paymentMethod` represents a Stripe-collected payment (owner decision: e.g. `credit_card` vs `other`);
    - whether a marker in title/description is returned by the LIST, which is needed for the "exactly one charge with marker + amount" confirmation;
    - the LIST's ordering and pagination semantics.

    These can come from an owner-run, already-authorized read in a future approved live step, or from Hostaway support documentation. Neither is requested here.
  - **I7 owner decision.** Confirm the contract rule: an unknown offline-charge recording stays a case-only alert (the existing `markUnknown` → `OFFLINE_CHARGE_OUTCOME_UNKNOWN`), the paid intent is never escalated to `under_review`, and the planner's operator plan is intercepted. Alternatively, authorize a reviewed DB entry point for a non-escalating alert kind.
