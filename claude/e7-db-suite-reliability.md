# E7 DB suite reliability: two intermittent failures at d801b43

**Scope.** Test reliability only, on `feature/e7-db-suite-reliability` from exact `d801b43cf79fc446e064af863a5e4ac8ed566fdd`. No migration, runtime, worker, adapter, route, config or dependency change.

**Environment.** Local PostgreSQL 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1), started by `test/db/harness.mjs`: one throwaway cluster per test file, on 127.0.0.1 with a free port, fsync off. Node test runner. The machine has 2 CPUs.

**Commands.**
- Full DB suite: `npm run test:db` (`node --test --test-concurrency=4 test/db/*.test.mjs`).
- Unit suite: `npm test`.

All runs below are Claude-run.

## 0. What survived from the original failures

On d801b43, `npm run test:db` was run 5 times:

| Run | Result | Failing test |
|---|---|---|
| 1 | 302/303 | `e74a-claim-listing-lock`: "guard: the helper waits on THIS listing's advisory lock before inserting its claim, then completes once it is released" |
| 2 | 302/303 | `e72-reservation-worker`: "reply without the ref echo: id recorded, waits for evidence freshness, then by-ref + by-id reads prove it" |
| 3–5 | 303/303 | none |

Those runs were piped through `grep '^not ok|^# pass|^# fail'`. Only the test names survive. The assertion text, SQLSTATE, stack and timings were **not kept**. That is a process loss on my side, and it limits what can be concluded below.

From now on, full TAP output is kept for every run (`scratchpad/rel/*.out`).

## 1. e72-reservation-worker: fixture id collision (measured and reproduced; fixed test-only)

### Mechanism (source)

`test/db/e72-reservation-worker.test.mjs:29` (at d801b43):

```js
nextId: 700000 + Math.floor(Math.random() * 1000) * 100
```

Each fake Hostaway `world()` draws a random bucket out of 1000, then mints ids `base, base+1, …`. The file calls `world()` 45 times per run (measured). All worlds share **one** cluster per file.

Both of these columns are UNIQUE:
- `booking.intents.hostaway_reservation_id` (0001:86);
- `booking.hostaway_reservation_attempts.hostaway_reservation_id` (0001:447).

When two worlds draw the same bucket and both create a reservation, the second create's reply carries an id already bound to another intent. `recordHostawayCreateResult` (`lib/booking-db/repo.js:599–609`) then fails on the UNIQUE constraint, or the later evidence or late result cannot be stored. Which test fails depends on which pair collides.

### Measured

**Natural runs.** The file was run alone 6 times with a diagnostic preload that records each `world()` draw and its call line (`scratchpad/rel/trace-random.mjs`, not committed):

| Run | Same-bucket collisions | Failing test |
|---|---|---|
| t0 | 612/682, 303/766 | root (3), the world at line 682: `duplicate key value violates unique constraint "hostaway_reservation_attempts_hostaway_reservation_id_key"` from `recordHostawayCreateResult` ← `createStep` |
| nat1 | none | none |
| nat2 | 334/454, 435/612 | root (2): the late result on id 732400 was not recorded (`[outcome_unknown, null, null]` instead of `[outcome_unknown, succeeded, '732400']`) |
| nat3 | 263/435/766, 435/435 | none |
| nat4 | 612/766 | none |
| nat5 | none | none |

- Every failure coincided with a collision involving the failing test's world.
- Not every collision fails. Some colliding worlds never create, or create in an order that causes no conflict.

**Forced runs.** A second preload (`scratchpad/rel/force-random.mjs`, not committed) gives every world a distinct bucket and forces only the listed call lines to share one:

| Forced | Result |
|---|---|
| no collision | 31/31 |
| 612 + 682 | root (3) fails with the same duplicate-key error |
| 193 + 454 | **"reply without the ref echo" fails** with `duplicate key value violates unique constraint "hostaway_reservation_attempts_hostaway_reservation_id_key"`, the test name from the original suite failure |

### Classification

- **Fixture collision:** measured, and reproduced deterministically.
- **Inferred, not measured:** that the original suite failure of "reply without the ref echo" was such a collision. Its log did not survive. The mechanism reproduces that exact test failing.
- It is independent of concurrency: the file failed **alone** in 2 of 6 natural runs.

### Fix (test-only)

Each world now gets its own disjoint block of 1000 ids from a file-level counter (`nextWorldIdBlock += 1000`). Ids are deterministic and unique across all worlds in the file.

- No assertion, timeout, retry or concurrency setting changed.
- The protected-id test still sets `w.nextId` explicitly.
- `refNotEchoedOtherId` (`id + 50`) stays inside its own block.

**Validation after the fix:**
- alone: 2/2 runs 31/31, with zero `Math.random` draws from `world()` (traced);
- 4-file concurrency (e72, e74a-claim-listing-lock, e73b, e74a-compensation): 3/3 runs 84/84;
- full suite and unit results: §3.

### Runtime observation (for root; not changed)

A create reply carrying a reservation id already bound to **another** intent surfaces as a raw UNIQUE violation thrown from `recordHostawayCreateResult`, or as an unrecorded late result. It is not a typed conflict.

Nothing is confirmed or captured on that path, so it fails closed. Real Hostaway ids are unique, so this is not expected to occur live. Whether to map it to a typed refusal or escalation is a runtime design question, and is left for root review.

## 2. e74a-claim-listing-lock guard: not reproduced; cause unknown

### Mechanism candidates (source)

`test/db/e74a-claim-listing-lock.test.mjs:33–41`: `waitForListingWaiter` polls `pg_locks ⋈ pg_stat_activity` every 10 ms, for at most **3000 ms of wall clock**, or until the call completes. The guard test (`:49–68`) then requires exactly one ungranted advisory waiter on that listing's key. The waiter must be the app login, its statement the helper's `pg_advisory_xact_lock`, and it must be a different pid from the holder.

- **H1, tested:** under 4-file load, the helper takes more than 3000 ms to reach the lock. That would make the test fail with `done=false`.
- The ids and clock are fixed (listing 996001, fixed `T0`), each file has its own cluster, and no test signals other clusters. So id collision and cross-file interference were **not** plausible here.

### Experiments (an uncommitted diagnostic copy of the guard; same steps, records the time to the first observed waiter)

| Condition | Runs | ms to waiter | Failures |
|---|---|---|---|
| serial, alone | 3 | 8, 8, 9 | 0 |
| 4-file concurrency (diag + e73b + e74b-d2 + e74a-compensation) | 5 | 17, 29, 20, 21, 17 | 0 (78/78 each) |
| alone + the unchanged file, with 6 CPU-burning processes on 2 CPUs | 3 | 19, 14, 8 | 0 (6/6 each) |
| unchanged file inside the 4-file e72 validation runs | 3 | n/a | 0 |

### Classification

**Not reproduced.** The observed worst case is 29 ms against a 3000 ms window. That is a 100× margin, which does **not** support H1 (inferred).

Without the original assertion text, I cannot tell whether the failure was:
- `waiters.length` 0 (timeout, or an early error that set `done`);
- a different assertion in the test;
- or a runtime defect.

So **no edit was made** to this test. It stays an unresolved suite-health item.

**Proposed next step (not done):** keep full TAP logs for every suite run, so the next occurrence yields the assertion and timing.

## 3. Final runs on the branch head

| Suite | Result |
|---|---|
| `npm test` | 674/674 |
| `npm run test:db` (one normal run, full log kept) | 303/303 (220 s) |

One green full run is not proof of stability; §2 remains open.

## 4. Residual nondeterminism

- The `e74a-claim-listing-lock` guard failure is unexplained (§2).
- Other wall-clock-bounded waits in the suite (`waitForLockWaiters`, 3–5 s windows) were not investigated beyond this test. Their observed margins in this run are large.
