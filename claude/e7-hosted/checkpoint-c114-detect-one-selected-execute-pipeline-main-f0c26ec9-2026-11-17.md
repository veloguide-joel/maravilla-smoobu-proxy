# Checkpoint C114: first hosted detect ONE → gate #2 → selected execute → pipeline TEST booking, CLOSED on main f0c26ec9 (DRAFT)

**Status: CLOSED. DRAFT for ROOT review (doc-only).**

**What happened:**
- One fresh Stripe Sandbox TEST request was carried end to end on the reviewed ENABLE merge **X = `ab974bcb`**:
  - a hosted detect `ONE`;
  - the candidate fingerprint visible to the reviewer (#170);
  - ROOT's gate #2 after an independent recompute;
  - a **selected** execute: re-selection, fingerprint equality, then the existing consumer path;
  - one pipeline `workflow_dispatch`;
  - one separately gated pipeline run ending `CONFIRMED_VERIFIED`.
- CLOSE #172 then returned main to the exact closed tree `150e5c3b`.

This closes the main gap left by the C113 NO_REQUEST checkpoint.

**Financial status:** one Stripe Sandbox TEST authorization of USD 140.00, captured by the pipeline. Disposition is MANUAL and separately reviewed. Refunds stay manual; nothing settles any obligation. The Hostaway status is "New", which is never called confirmed.

**Privacy:** no intent, ref, payment, session, reservation, charge or contact identifier is recorded here, and no private DB value. ROOT holds the DB / payment proofs privately.

**Attribution (all times UTC, 2026-11-17 unless noted):**
- `[GitHub]` = public Actions run / job / approval data, read by Claude with read-only tools.
- `[Claude-obs]` = Claude's read-only Hostaway / TEST-page reads.
- `[ROOT-held]` = facts ROOT holds privately; they are not reproduced here.

Claude ran no workflow, gate approval, merge, DB query, payment or provider write.

---

## 1. Code provenance [GitHub]

| item | value |
|---|---|
| F1 fix | #170 → `d42e056d`, tree `150e5c3b`: the detect summary shows `candidateFingerprint=` for outcome ONE only |
| ENABLE | #171 merged 03:43:55Z → **X `ab974bcb7d69212eac299a4bcaf17c9a19e6e9d0`**. Same 7-path flag delta as #165 (98 identical +/- lines); pipeline files byte-identical to `9455bc9e` |
| CLOSE | #172 merged 03:50:33Z → **`f0c26ec9dc8ae32bc98abc3e71c89221f2fd7e1a`**, tree **`150e5c3b2156edbd7a2f5325060c4b7b801676ba`** == the pre-ENABLE closed tree `d42e056d` |
| Digests at X | kickoff source `d4ac34ab…4e24`; kickoff closure `07fedfca…e87b`; pipeline source `f09bcbbd…0999`; pipeline closure `f7d7cad6…7273`; plan hash `5b52b840…e731` |

## 2. Kickoff run 44012555878 at X [GitHub]

`workflow_dispatch` on `main`, mode `detect`, attempt 1, conclusion **success**. Every job succeeded:

| job | window (UTC) | result |
|---|---|---|
| preflight | 03:46:44–03:47:09 | `PREFLIGHT_OK_PIPELINE_BOUND`; source `d4ac34ab`; closure `07fedfca`; flags open |
| verify | 03:47:10–03:47:23 | `VERIFY_OK`, flow detect |
| **detect** (gate #1) | 03:47:54–03:48:16 | `DETECT_DONE`. Core `DETECTED/ONE`, candidates 1. **The summary shows `candidateFingerprint=070dc7245bb0…`** (64-hex, the same value as the job output). gets 0 / posts 0; claimed false; credentialReads 0; 18 DB statements; TLS client checks 11/11 verified; backend SSL true; POOL_ENDED |
| **execute** (gate #2) | 03:49:56–03:50:13 | `EXECUTE_DONE`. Core source **`selected`**, `ACCEPTED_VERIFIED / HANDOFF_ACCEPTED`. **gets 1 / posts 1**; verified true; sealed false; claimed true; credentialReads 1; 33 DB statements; TLS 16/16 verified; backend SSL true; POOL_ENDED |

**Approvals on environment `e7-readonly-probe`, both by ROOT** (comments paraphrased):
1. **Gate #1:** approve the read-only detect only, at the reviewed release. Execution remains a separate, candidate-specific decision.
2. **Gate #2:** the detected ONE fingerprint matched ROOT's independent Python and database recomputations; fresh readiness, calendar and automation checks passed. Approve this selected kickoff execution once; the pipeline stays separately gated.

## 3. Pipeline run 44012956409 at X [GitHub]

`workflow_dispatch` on `main` (the ONE dispatch from the kickoff), conclusion **success**.

| job | window (UTC) | result |
|---|---|---|
| preflight | 03:50:14–03:50:33 | `PREFLIGHT_OK_REAL_PLAN`; source `f09bcbbd`; closure `f7d7cad6`; plan `5b52b840…` |
| execute | 03:52:29–03:55:28 | `VERIFY_OK` → `EXECUTE_DONE` **`CONFIRMED_VERIFIED`** |

**Inside the execute job:**
- Invocation 1 `PENDING / NOT_DUE`; ONE bounded wait (118404 ms); then `CONFIRMED`.
- **Cumulative sends create / capture / record = 1 / 1 / 1, all REPLIED.**
- 26 exchanges; lock released.

**Approval by ROOT:** ROOT reviewed the exact-release preflight, its independently recomputed plan hash matched, and fresh TEST admission and calendar checks passed. It approved this one bounded run: at most one create, TEST capture and recording; no refund, cancellation, void or notification; main already CLOSED.

**Runs at X:** exactly one kickoff run and one pipeline run are documented here. ROOT confirmed there were no others; that is ROOT's observation, not re-proven here.

## 4. Provider end state [Claude-obs, read-only, sanitized]

**TEST listing 606998** (monthly calendar, December 2026, 03:58:04Z):
- the night of **Dec 15 is `reserved`**;
- Dec 14 and Dec 16 onward are `available`.

That matches a 1-night stay, Dec 15 → 16.

**The reservation on that night:**
- **status label "New"**; channel Hostaway Direct; 1 night;
- total $140.00; payment balance "$140.00 of $140.00", **Paid**;
- **exactly ONE charge row:** type CHARGE, $140.00, status PAID; no refund row.
- Its log shows the payment status and total-paid fields set at 03:55:20Z, matching the pipeline record step.

**Messaging** (04:00:15Z):
- automation 511521 is the only rule listed, **switch OFF**;
- **AI Replies OFF**;
- the inbox was not opened.

**TEST page:** right after the Pay, ~03:41:55Z, it showed "Processing — not a booking".

## 5. Request lifecycle (sanitized)
- Two earlier C114 Checkout sessions expired unpaid. ROOT recorded the first intent as `payment_expired`, with its claim auto-released; both are kept as audit history.
- The third session was created once by Claude. It was paid **by Joel himself** in Stripe Sandbox with Stripe's public test card at ~03:41Z. Claude never enters cards, Link or OTP, and never clicks Pay.
- `[ROOT-held]`:
  - DB proof of `payment_authorized`, then capture;
  - the single `requested` row and its claim / `dispatch_accepted` transition;
  - the recomputed fingerprint;
  - the post-run DB end state.

## 6. Not proven / remaining
1. **Disposition** of the TEST reservation and capture: manual, separately reviewed.
2. **Hosted outcomes other than ONE / NO_REQUEST:** `AMBIGUOUS` / `INELIGIBLE` / `STOP` and the selected-path uncertainty outcomes are proven offline only.
3. **Trigger:** manual dispatch only; scheduling remains a separate decision.
4. **Notification:** `guest.notify` remains a separate contract. The native Hostaway automation stayed OFF.
5. **Test payments:** Claude cannot enter cards on hosted pages, so the owner performs the Pay click. A TEST-only API payment helper is parked for later review.
