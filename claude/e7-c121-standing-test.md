# E7 C121 — STANDING TEST bundle (DRAFT, CLOSED until ROOT merges and arms)

**Status.** This is a draft for ROOT review. It does not activate production, set the arm, or change reviewers, protections, schedules, settings, secrets, providers or the DB. This file is outside every arm component.

## What it is
The C120 pattern opened the runners for ONE run with an ENABLE PR, an arm and a CLOSE PR. C121 replaces that with a **standing TEST release**:
- The enable bytes stay on main.
- The repository variable `E7_TEST_AUTO_ARMED`, which must equal the recomputed release digest, is the on/off switch.

No code, PR or arm change is needed per booking.

| component | frame | vs #209 (C120d ENABLE) |
|---|---|---|
| arm-gate | `7af70f3e…` | unchanged |
| kickoff | `47d309ce45f0963e518676265192e18245802edab366826a05205b44b2e80f69` | **byte-identical** |
| pipeline | `5294b6b467839e1dd825e56063abc1ad1267eafdfb2973f2c2129e9b1f29c3f5` | **byte-identical** (SQL / tooling untouched) |
| booking-confirmation | `24fc31b4c1520c3725d17986c1377cec00145e8009df2f8c30001bfcd8a97e96` | **changed** (below) |
| **release** | **`b1d6bb6395205f59f4c6dc7a0629edc6b3c6aaada7a0415a155745a3b84822b6`** | was `2dfceb27…` |

No migration, tooling pin, catalog pin or pipeline change. The only literals updated are the cross-runner X1 (confirmation frame) and X5 (release).

## The one functional change: a prospective confirmation cutoff
- `CONSTANTS.detect.cutoff` moves from the C119 S1 kickoff cutoff `2026-11-15T22:58:01Z` to **`2026-11-19T00:00:00Z`** (the C121 rollout).
- **Detect:** ops created before the cutoff are counted as `historic` and never selected. Historic rows never STOP, even when unresolved.
- **Execute, BOTH flows (manual hand-bound and detect-flow):** admission now reads `created_at >= cutoff` for the bound op through the same reviewed `booking.list_guest_notifications` read path (no new SQL function or grant). A historic op is refused `BEFORE_STANDING_CUTOFF` before any claim, render or send. A non-boolean value is `REPLY_SHAPE`, never read as in scope.
- **Effect:**
  - The two older pending `booking_confirmed` rows and the C120 `outcome_unknown` op are outside standing scope and stay **untouched**: no resend, settlement or adjudication.
  - The existing `OP_NOT_PRISTINE` / `RECEIPT_PRESENT` / `LATCH_PRESENT` fences still forbid any resend of in-scope ops.
- **Activation-time check (ROOT, read-only):** no `guest.notify` op on 606998 has `created_at >= 2026-11-19T00:00:00Z` before the arm is set.

## Unchanged fences
- TEST listing 606998, the Stripe sandbox, USD, the sink recipient scope, the fixed sender, budgets of 1 worker invocation / 1 send per dispatch, and no resend.
- The P3 live-main check and P5 request binding, the arm digest check, catalog 28, and the protected / excluded ids.
- **Serial capacity:** more than one eligible confirmation → STOP `DETECT_MORE_THAN_ONE`. The kickoff and pipeline keep their per-dispatch bounds. This is a **TEST serial release, NOT production concurrency readiness**.

## Historical "ONE run" comments vs the standing policy (honest note)
The kickoff and pipeline files keep #209's bytes, so their comments still say "ONE bounded / gated TEST run; the CLOSE companion restores false". Under C121 the policy is:
- the runners stay opened on main;
- each **dispatch** is bounded exactly as before (kickoff: one request; pipeline: ≤ 2 coordinator invocations, cumulative ≤ 1 create / 1 capture / 1 record; confirmation: 1 invocation, 1 send);
- consecutive bookings are handled one after another, serially;
- the off switch is deleting the arm variable, and a CLOSE commit stays available.

Rewording those comments would change their frames (and the pipeline frame `5294b6b4`), so they are deliberately left as is and explained here.

## Revocation semantics (what is and is NOT proven)
- **Arm digest mismatch:** a run whose component bytes differ from the armed release is refused.
- **Docs-only move of main:** can leave the release digest **unchanged**, so it does **not** disarm. P3 (live main == the run's commit) refuses work dispatched against an older main commit.
- **Deleting the arm variable:** refuses runs that **read** the absent value. It is **NOT proven** to revoke work that is already queued, approval-held or running: when GitHub refreshes `vars` for those is unverified.
- **To stop and drain**, use the S4 sequence: delete the arm, merge a CLOSE commit (P3 then refuses not-yet-admitted work), cancel queued / approval-held runs, and let a running job finish inside its bounded budgets. The bounded-running limitation stays.

## Exception visibility (minimum; nothing sent now)
- Every runner exits non-zero on STOP / UNKNOWN, so GitHub marks the run failed.
- **Minimum delivery:** GitHub's own failed-workflow notification (no new permission, token or messaging integration). For scheduled runs it goes to the user who last edited the workflow's schedule; for dispatched runs, to the actor.
  - Whether it actually reaches Joel is **unobserved**. Activation-time check: one deliberately refused TEST run, and Joel confirms he received the notice.
- **Reconciliation view:** reuse the existing S3 read-only status runner (`scripts/e7-hosted-status.mjs`, `readEnabled` false, manual only, outside the arm). It exits 1 on ATTENTION / UNKNOWN. Opening it (`readEnabled` true, optionally on a schedule) is a **separate** reviewed slice; it is not part of this bundle.

## Remaining activation steps (ROOT)
1. Review and merge this bundle (main moves; release `b1d6bb63…`).
2. Read-only checks: no active runs; DB quiescent; no `guest.notify` op created on or after the cutoff; C120 and the two older rows unchanged.
3. **One activation-time policy / security decision:** the `e7-test-auto` environment's required-reviewer rule. Today every scheduled job waits for approval. Removing or changing it is the single action that makes TEST runs unattended. It is a once-only decision, not a per-booking step.
4. Set the arm to `b1d6bb63…` (ROOT, out of band).
5. **First acceptance:** ONE clean future TEST booking runs end to end with no human step after Pay, and its confirmation shows `httpStatus=200` with one matching Resend log. A second booking only if a specific unresolved behaviour needs it.
