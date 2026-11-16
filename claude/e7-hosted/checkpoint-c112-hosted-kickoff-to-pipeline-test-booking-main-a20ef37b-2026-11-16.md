# Checkpoint C112 — first hosted KICKOFF → ONE gated PIPELINE TEST booking (existing request), CLOSED on main a20ef37b — DRAFT

**Status: CLOSED. DRAFT for ROOT review (doc-only).**
- ONE hosted kickoff run handed the ONE existing, already-authorized durable TEST request to the merged pipeline workflow on main X (`4fff60c6`).
- Exactly ONE pipeline run was created at X. ROOT approved its normal reviewer gate once, and it ended `CONFIRMED_VERIFIED`.
- The CLOSE draft (#160) was merged right after the kickoff was terminal and the single pipeline run was identified. The final main `a20ef37b` has the tree `bb693e0a`, identical to the closed main `a94fcde`.
- Every booking runner's execute / dispatch flag is false.

**What it validates:**
- The hosted kickoff path end to end: token-shape gate (C112-F1), both-hop TLS admission (C112 #157), exact catalog / role / binding admission, an owned claim, a release-bound GET, ONE POST, and a verified readback.
- The merged pipeline completing reservation → Stripe TEST capture → Hostaway offline-charge recording for that request, in ONE gated run.

**What it does NOT validate:**
- An **automatic** checkout → kickoff trigger. The kickoff was a manual `workflow_dispatch`; the automatic consumer trigger remains a **gap** (§8).
- Guest notification: `guest.notify` is still PENDING, never dispatched.
- Production readiness, or any failure path live.

**Financial status:**
- The TEST funds are captured and the TEST reservation is active (Hostaway status **NEW**, never called "confirmed").
- Its single offline-charge row is paid.
- Disposition is **manual** and separately reviewed. Refunds stay MANUAL. No obligation is settled.

**Privacy:** private provider / payment / session / contact identifiers are intentionally OMITTED here and kept only in the private project report. No name, e-mail, guest detail or screenshot is recorded.

**Attribution (all times UTC):**
- `[ROOT-obs]` = ROOT's GitHub / DB observations as relayed to Claude.
- `[Claude-obs]` = Claude's read-only dashboard observations.
- `[Claude-code]` = git facts reproduced by Claude.

Claude authored #157 / #158 / #159 / #160 and applied ONE ROOT-authorized DEV setting change (§3). Claude ran no workflow, gate approval, DB query, checkout, payment, capture or provider write.

---

## 1. Code provenance [Claude-code unless marked]

| item | value |
|---|---|
| Token-shape fix | e7-test #153 merge `4e79f266` (tooling pin); main #154 → `b4afb8fa` |
| TLS both-hop admission | #157 → `425fb334`, tree `ae441482`; closed kickoff source `490bf3bc7e94e0b7c9f86b0406457fac3c72f9f4fccfd77417c1ac0897caf4ea` |
| Read-only TLS probe | #158 → `a94fcde8`, tree `bb693e0a2d62e9939b7affd4bf7ff4ec9051c2d3`; probe source `417d43ba5ea22780feba5cd19d5148ca051ae113590040133687d8c56e807d3b` |
| ENABLE (C112g) | #159 → **X = `4fff60c64dea83cd37076408bfe9855080c3c9d8`**, tree `2ae9a3dd86f5ac1a68264860276cf8c98213fdd8`. Pipeline files byte-identical to `9455bc9e` (enabled source `f09bcbbdfac88ca8dfd212a386d2af03698f9b710a49189b0ac9262531510999`, closure `f7d7cad646eaed2fb37a63e031157732ee6e2a44824f9d935d6b9104e08f7273`, tooling `71c3dcf8`). Kickoff source `cd403e64c0c5d163106beea5eaacecd67b70e3f99610efcd6496e3f83d209250`, closure `07fedfcaec968aef325f2bdd6bdc40697504058cf8fd3dd0a30795d445e5e87b`, tooling `4e79f266` MERGED |
| CLOSE (C112g) | #160 → **`a20ef37ba58ca16281a14c3d1b2e41c4d96d40cb`**, tree **`bb693e0a`** == `a94fcde` (exact `git revert`; byte-reverse proof `diff(main→ENABLE) == diff(CLOSE→ENABLE)`) |

**Flags on `a20ef37b`:**
- kickoff `executeEnabled` / `dispatchEnabled`: false;
- pipeline, reservation, capture, recording, recorded-cleanup, test-cleanup, booking-confirmation `executeEnabled`: false;
- notify-inspect: no execute mode;
- read-only TLS probe: `probeEnabled` true (a read-only diagnostic, accepted by ROOT).

The probe's tests assert the closed booking state, so the probe is a closed-main-only diagnostic.

## 2. Pre-run state

- **[ROOT-obs]** One authorized TEST intent at version 4: authorized 14000 USD minor, captured 0, no reservation / recording. Exactly one pristine `requested` kickoff row. No leases, in-flight operations, advisory locks or prepared transactions.
- The first kickoff attempt (run 43882287093) stopped `HKO_CREDENTIALS_MISSING` (token shape).
- The second (run 43891682165) stopped `TLS_REQUIRED` with zero effects. That run is the cause of C112's both-hop TLS work.

## 3. DEV transport security change

- **[ROOT-obs]** Read-only compatibility audit accepted; DEV quiescent at ~17:22–17:23Z.
- **[Claude-obs]** Supabase DEV project (`maraVilla Booking DEV`), Database → SSL configuration:
  - "Enforce SSL on incoming connections" was OFF;
  - it was turned ON once at ~17:24Z, with the expected restart confirmation clicked once;
  - it read ON at 17:25:32Z and after a reload at 17:25:49Z;
  - the overview showed Healthy at 17:26:03Z and 17:26:26Z;
  - no other setting changed.
- **[ROOT-obs]** Hosted read-only TLS probe run 43918578581: `BOTH_HOPS_PROVEN`, 5/5 fresh connections (client + backend + identity + read-only + rollback).
  - `distinctBackends` was 1, so the backend-hop proof is a sample; the project setting provides the broader enforcement.
  - Booking-row fingerprints were unchanged before and after.
- **Not claimed:** the backend-hop encryption state of earlier runs (C94–C106) is **unproven**; they did not check it.

## 4. The kickoff [ROOT-obs]

| item | value |
|---|---|
| Synthetic preflight at X | run 43919691391 PASS (expected source + pipeline binding) |
| Kickoff | run **43920491125** at X → terminal **`ACCEPTED_VERIFIED` / `HANDOFF_ACCEPTED`**, gets 1 / posts 1, verified true |
| Budgets (kickoff, at X) | runMs 90000, teardownMs 5000, connectMs 8000, statementMs 6000, dbQueries 48, gets 1, posts 1, poolMax 2 |
| Kickoff row after | `dispatch_accepted`, outcome `HANDOFF_ACCEPTED` |

## 5. The pipeline [ROOT-obs]

| item | value |
|---|---|
| Created | exactly ONE run, **43920750001**, at X, 17:39:58Z |
| Review before the gate | real plan `9c0b2ac02d562a57207ca04886b541161e0a0141a132ee7db4742546371efadb`, source `f09bcbbd…0999`, closure `f7d7cad6…7273`; fresh DB: no leases or conflicting claims, current v4, authorized 14000 |
| Gate | the normal existing reviewer gate, approved ONCE at ~17:41Z |
| Result | terminal SUCCESS 17:44:41Z; core `CONFIRMED_VERIFIED` / `CONFIRMED`; sends create / capture / record 1 / 1 / 1, all REPLIED; verifiedCompletion true; possiblyEffected false; cleanup POOLS_ENDED; lock released |
| Budgets (pipeline at 9455bc9e) | coordinatorInvocations 2, maxWaits 1, maxWaitMs 150000, maxSteps 6, create 1, capture 1, record 1, exchanges 160, dbQueries 1500, runMs 720000 |
| Repeat | no second dispatch, no retry |

**CLOSE timing [ROOT-obs]:** #160 was merged immediately after the kickoff was terminal and the single pipeline run at X was identified, before the pipeline finished. CLOSE cannot revoke a run already fixed to X.

## 6. Database end state [ROOT-obs]

- The existing intent is `confirmed` at v9: listing 606998, 2026-12-08 → 12-09, USD, authorized 14000 / captured 14000, livemode false.
- A Hostaway reservation id and an offline-charge id are recorded (values in the private report only).
- Create / capture / record operations each succeeded with attempts 1.
- `guest.notify`: **PENDING, attempts 0, dispatched false**.
- All intent / work / operation leases 0; in-flight 0; advisory locks 0.
- Sanitized whole-row fingerprints of ALL other intents, operations, inventory claims and kickoff rows are unchanged.

## 7. Provider end state [Claude-obs, read-only, 17:46–17:48Z]

- **Stripe TEST (Sandbox):** the request's payment is Succeeded at $140.00 USD. Events show authorized → captured $140.00 → succeeded. No refund or cancellation event, and test mode.
- **Hostaway**, listing 606998 ("maraVilla TEST - DO NOT BOOK."):
  - the new reservation's status is **"New"** (Hostaway's label; not "confirmed");
  - dates 2026-12-08 → 12-09; channel Hostaway Direct; 1 guest; USD;
  - total $140.00, paid $140.00;
  - one booking-reference custom field is present;
  - **exactly one** charge row: type Charge, $140.00, Paid, titled with the maraVilla payment prefix;
  - the calendar shows the night of Dec 8 occupied;
  - automation 511521 OFF; AI Replies OFF.
- No inbox or message was opened, and no protected or historical record was touched.

## 8. Limits and remaining gaps

- **Automatic trigger:** the checkout → kickoff path is still manual (`workflow_dispatch` by ROOT). Webhook-driven durable request → gated runner is the remaining gap; a proposal is in the private project report.
- **Notification:** `guest.notify` is pending and was not sent. No sender is enabled.
- **Money:** captured TEST funds and the active TEST reservation await **manual**, policy-assessed disposition. No refund, cancellation or cleanup was performed or is implied.
- **TLS:** the backend-hop proof is one sampled backend; broader assurance comes from the DEV setting. Historical backend-hop state is unproven.
- **Production:** not validated.
