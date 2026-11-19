# E7 C122 — L3 status watch (DRAFT): reuse the S3 read-only status runner on a bounded schedule

**Status.** Draft for ROOT review: no merge, run, arm, DB / provider write, or reviewer / secret / settings change. This file is outside every frame. It closes a *visibility* gap only. **Notice delivery to Joel stays UNPROVEN** (see "Limits").

## The gap
A pipeline that ends `PENDING` with a `nextActionAt` exits **0**, and no automatic continuation exists. So a stalled future booking produces no failed run and no notice.
- **Concrete example:** C97 / C103. The pipeline returned `PENDING NOT_DUE` with the intent in `reservation_pending`, and it needed a separately dispatched continuation.
- Under the standing release, nothing would dispatch that continuation. The intent would sit in `reservation_pending` / `payment_authorized`, and its `intent_work.next_action_at` would pass silently.

## What changes (status runner only; frame `e7-hosted-status-v1`, outside the arm release)
1. `readEnabled` is **true**: the runner reads only, as before, with a single read-only snapshot always rolled back. Closed constants still refuse `STS_READ_CLOSED`.
2. **Two windows, one snapshot.** Every aggregate takes `created_at <@ $2::tstzrange`:
   - **Standing** (actionable): created ≥ `2026-11-19T00:00:00Z` (the C121 rollout). This is the existing metric set and existing classifiers. ATTENTION / UNKNOWN → exit 1.
   - **Historic** (visible only): created in `[2026-11-15T22:58:01Z, 2026-11-19T00:00:00Z)`. The same metrics are computed and reported. Any non-OK status becomes **INFO** with `rawStatus` (the status it would have) and a note; it **never pages**. The two older pending confirmations and the C120 `outcome_unknown` op stay listed. Nothing is cleared, settled or resent; the runner cannot write.
   - **UNKNOWN is never downgraded.** A missing, unreadable or malformed reply in **either** window makes the overall status UNKNOWN (exit 1). A notify row claiming both windows, or missing `in_hist`, is UNKNOWN.
   - The notification page is walked **once**, with both window flags. Excluded historical intents are skipped as before. Ops before the historic cutoff stay out of scope (listed in UNOBSERVED).
3. **Workflow:**
   - **Schedule** `7,37 * * * *` (nominal every 30 min; GitHub may delay or drop scheduled runs; not an SLA).
   - The scheduled status job runs **only while `E7_TEST_AUTO_ARMED` is present**. That is a presence gate, not a digest check, so while the release is unarmed no environment job is queued and no approval piles up.
   - The **status job moved** `e7-readonly-probe` → `e7-test-auto`, with the SAME existing secret NAME `E7_DEV_BOOKING_DATABASE_URL` (runtime role), main-only.
   - **Scheduled runs:** the expected source digest is the preflight job's own computation of the same commit. That is a consistency check, **not** an independent review binding; the authority is main-only + the read-only runtime role + fixed SQL. The closure digest is the pinned literal.

## Detection delay for a stalled future booking (nominal, schedule-bound)
| condition | threshold (existing) | nominal worst case to an ATTENTION run |
|---|---|---|
| in-pipeline intent not updated (`pipeline.stalled`) | 30 min | ≤ ~60 min after its last update |
| work due and unclaimed (`work.due_overdue`) | 30 min past `next_action_at` | ≤ ~60 min after `next_action_at` |
| confirmed with no notify op (`notifications.confirmedWithoutNotify`) | none | the next run (≤ ~30 min) |
| ELIGIBLE confirmation not sent (`eligibleStale`) | 90 min | ≤ ~120 min |
| kickoff request not claimed (`requested_stale`) | 90 min | ≤ ~120 min |
| authorization near expiry | 48 h before `capture_before` | the next run |

## Cross-frame proof
- The arm release recomputes to **`b1d6bb63…`**, unchanged. The cross-runner literals are unchanged and pass.
- No pipeline, kickoff, confirmation, SQL migration or tooling byte changed. The pipeline frame `5294b6b4` is untouched.
- Changed files:
  - the status runner, its two tests and its workflow (the status frame, outside the arm);
  - the S4 F1 inventory test (outside every frame): an explicit branch for the moved status job, so the `e7-readonly-probe` count goes 16 → 15;
  - this doc.

## Limits (honest)
- **Notice delivery is UNPROVEN.**
  - GitHub notifies the user who triggered a run (scheduled: the cron creator / last modifier / re-enabler) only if that user's Actions notifications are enabled.
  - Observed: scheduled runs show `actor=veloguide-joel`. That account's Actions notifications are Email (failed workflows only) to `joel@veloguide.com` (ROOT read-only).
  - The deliberate refused probe (run 44554449761) has **not** been seen by Joel. This draft adds no recipient, messaging or setting.
- A scheduled status run itself needs `e7-test-auto` approval until the activation-time reviewer decision. While the release is unarmed it doesn't run at all.
- Serial TEST release, TEST listing only; no Stripe / Hostaway / Resend reads (UNOBSERVED); not production monitoring.
