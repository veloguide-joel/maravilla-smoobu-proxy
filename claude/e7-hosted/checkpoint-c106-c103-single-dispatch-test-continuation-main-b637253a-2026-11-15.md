# Checkpoint C106 — C103 single-dispatch TEST pipeline booking (healthy non-echo continuation in ONE run), CLOSED on main b637253a

**Status: CLOSED.** ONE fresh TEST checkout went through ONE manually gated dispatch of the merged hosted pipeline runner. Inside that single run the
coordinator was invoked twice: the first returned `PENDING NOT_DUE` after ONE Hostaway create; after ONE bounded wait and a FINAL fresh
re-admission, the second returned `CONFIRMED_VERIFIED`. Cumulative 1 create / 1 capture / 1 offline-charge record; no uncertain-write retry,
no third invocation. The pipeline was closed again (#141). All eight **tracked** runner `executeEnabled` flags are false on main `b637253a`.

**What it validates:** one manually gated dispatch can bridge a healthy Hostaway non-echo delay to a verified completion (reservation → Stripe
TEST capture → Hostaway offline-charge recording), with a durable readback by the runner and ROOT, and the TEST guest page then shows the booking
as confirmed.

**What it does NOT validate:** an automatic accepted-checkout → pipeline trigger (NOT implemented; this was a manual `workflow_dispatch`, not an
autonomous guest checkout); production or UI automation readiness; any failure path live (the C99 UI failure vectors remain offline-tested only).

**Financial status:** the captured TEST funds, the active reservation (Hostaway status NEW), its paid offline-charge row and the HELD claim await a
**separately reviewed, manual, policy-assessed disposition**. No financial obligation is settled. Refunds stay manual.

**Attribution:** `[ROOT-obs]` = ROOT review `5913339514` on #140 (real plan / baseline / normal gate) and END review `5913365587` on #141; C102
GO `5913211469` on #138; the C103 STOP handoff. `[Claude-obs]` = the C105 read-only Hostaway session. All times UTC. Claude authored #137 / #138
and ran no dispatch, gate approval, DB, checkout, payment or Stripe action. No e-mail, contact, guest name or screenshot is recorded here.

---

## 1. Code provenance

| item | value | source |
|---|---|---|
| Runner (C100 + C101) | #137 → CLOSED main `68e5ccba`, tree `1cd7265c4ce145fca56b748381edd0db5938952e`; source `ce13841b28cbe1677c19b1b21b11b139050e7bdad4c32c47bf1c91240bbf4005`, synthetic plan `1e1c086c0f2b4ba8f8f43fb75ac2365aa23869d5dc36c42155d1579c97085e97`, closure `f7d7cad646eaed2fb37a63e031157732ee6e2a44824f9d935d6b9104e08f7273`, tooling `71c3dcf83c6b78a2cb0c6a7e829b5ecb23d37af5` | — |
| ENABLE (C102) | #138 → `03597afb`, exact enable tree `f5eac3c1e31d0a9b90f841eac519a025dd6a444b`; enabled source `f09bcbbdfac88ca8dfd212a386d2af03698f9b710a49189b0ac9262531510999` | [ROOT-obs] GO `5913211469` |
| STOP close (C103) | #139, the exact reviewed inverse → `0e40da41`, tree `1cd7265c` | [ROOT-obs]; Claude git-verified (C104) |
| Same reviewed ENABLE | #140 → `9455bc9e`, tree `f5eac3c1` | [ROOT-obs] `5913339514` |
| END close (current main) | #141 → **`b637253ac1e453d0876d178f21fb33fe40f58b72`**, tree **`1cd7265c`** | [ROOT-obs] `5913365587` |

Flags: the eight tracked flags (5 legacy runners, notify-inspect, booking-confirmation, pipeline) are false per ROOT's git read. The older
`scripts/e7-test-abort-cleanup.mjs`, outside these eight, is unchanged by this cycle; no broader "all flags" claim is made.

## 2. Checkout target and timeline [ROOT-obs unless marked]

Target `1d6e770f-ba3d-40f7-92c1-ee01be7da532` / `MV-HYFP633M` / listing 606998 / 2026-12-01 → 12-02 / 1 guest / USD 14000 minor.
PI `pi_3UcCBg2B9LTneQgw1FnY0jHm`, charge `ch_3UcCBg2B9LTneQgw1GRpciwq`, Hostaway R71794358, offline charge 35739022.

| time | event |
|---|---|
| 22:19:41.727Z | target created ONCE; details saved once; Continue-to-Stripe clicked once |
| — | Stripe page explicitly Sandbox, saved TEST card; order summary livemode false / usd / 14000 / non-recurring |
| — | ROOT's ONE submit request was **denied by the automatic browser approval review before submission** (prior-submission outcome uncertain / retry risk); **no workaround, no retry** |
| 22:26:14Z | DB: `payment_pending` v3, no PI, authorized null, captured 0, no reservation / offline charge (provider state not inferred) |
| — | Joel reported clicking Pay once on the EXISTING checkout; exact click time unrecorded |
| 22:47:08.392849Z | DB: `authorized` v4, authorized 14000, captured 0, no reservation / offline charge (no earlier provider state inferred) |
| 22:48:55.440Z | fresh baseline (§4) |
| 22:50–22:53Z | the ONE run (§3) |
| 22:54:34.624Z | ROOT END snapshot (§4) |
| 22:55:17.736883Z | allowed detail SELECT (§4) |
| ~22:55Z | ONE TEST-page status refresh (§6) |
| 22:56–22:58Z | [Claude-obs] C105 Hostaway END (§5) |

No repeated checkout was created.

## 3. The run [ROOT-obs]

| item | value |
|---|---|
| Run | `43771442036-1` on `9455bc9e`; approval `ROOT-C103-PIPELINE-20261115`; expectedVersion 4; notBefore 2026-11-15T22:18:49.649Z |
| Gate | normal existing `e7-readonly-probe` reviewer gate approved ~22:50Z; no bypass or settings change |
| Preflight | job `132988026740`: bindings 22:50:02.4424071Z; 24/24 + result 22:50:07.6739417Z |
| Execute | job `132988138470`: VERIFY_OK 22:51:09.1326266Z; EXECUTE_DONE 22:53:50.4244130Z **CONFIRMED_VERIFIED**, v4 → v9 |
| Digests (MATCH) | real plan `11c29542491236af50ce8e89f28983c425944a3d0ee54ce642cccd1af754ca1b`; source `f09bcbbd…0999`; closure `f7d7cad6…7273` |

**Inside the ONE dispatch:**
- Invocation 1: `PENDING NOT_DUE`, sends create / capture / record 1 / 0 / 0.
- ONE bounded wait of 118519 ms to the due time 22:53:19.485Z; FINAL fresh re-admission OK at version 6.
- Invocation 2: `CONFIRMED`, sends 0 / 1 / 1 (the existing create was read, never re-sent).
- **Cumulative 1 / 1 / 1, all REPLIED.** Two coordinator invocations in one dispatch; no third call; not an uncertain-write retry.
- Fresh Stripe proofs: start, continuation, before capture, before recording, plus the ref-echo proof (5 proof labels).
- 26 exchanges, 556 DB statements; lock released, POOLS_ENDED; no seal; no unknown DB outcome; postcheck PASS.

## 4. Database [ROOT-obs]

**Baseline (22:48:55.440Z):** exactly 11 ids; schema 23; catalog 23-child match; target `authorized` v4; the 10 foreign intents' whole rows and 23
children equal the previous C95 final snapshot; no leases, in-flight ops, cases, advisory locks or prepared transactions.

**END (22:54:34.624Z):** the same 11 ids; the 10 foreign whole rows + 23 children byte-identical to the baseline; **all 7 globals identical** to the
baseline (claim strictly bound to these two timestamps; a later status refresh may change only `api_rate_limits`); no leases, in-flight ops,
cases or advisory locks; target `confirmed` v9.

**Target deltas (baseline → END):** ops 3 → 16; evidence 2 → 11; Hostaway attempts 0 → 1; ledger 1 → 3; transitions 5 → 10; applied events 3 → 8;
recording assessments 0 → 1; claim assessments 0 → 1; inbox 0 → 2; the work row changed with lease null. The **claim was promoted from authorized
to reserved and is STILL HELD** (not unchanged). Guest, payment-attempt, webhook, refund and notification tables unchanged.

**Detail (22:55:17.736883Z):** custom `guest.notify` `e300cf74-939a-4939-ab59-ad6f68dae576` pending, attempts 0, undispatched; 2 inbox rows with
`processed_at` NULL; no cases, holds or refunds.

## 5. Hostaway END [Claude-obs, C105, read-only, 2026-11-15T22:56Z–22:58Z]

Page reads only; no inbox, thread, contact or foreign reservation opened; no edit, save, toggle, send, cancel, refund or cleanup.

| item | observed |
|---|---|
| R71794358 | Hostaway reservation status **NEW** (Hostaway's status; the durable intent is `confirmed` v9 — not the same thing); payment status **Paid**; Hostaway Direct; listing 606998; check-in 2026-12-01 3:00 PM → check-out 2026-12-02 11:00 AM, 1 night, 1 guest; USD; base rate / total price 140.00; Payment balance Total $140.00 / Paid $140.00; booking ref field `MV-HYFP633M`; Synced Yes |
| R71794358 logs (UTC) | 22:53:45 and 22:53:46 "Payment status value was changed from Unknown to Paid"; 22:53:46 "Total paid value was changed from to 140" |
| Guest Payments | exactly ONE row: charge **35739022**, "maraVilla payment mvoch1-1d6e770f-ba3d-40f7-92c1-ee01be7da532", Charge, **$140.00, Paid**, charge date 2026-11-15 (≈22:53Z), no failure reason |
| Calendar 606998 | reservation bar Dec 1 → Dec 2 (Hostaway Direct, 1 night, 1 guest, $140.00): night Dec 1 occupied, checkout Dec 2; night Dec 2 open. The historical Nov 30 → Dec 1 bar was only observed |
| Automation 511521 | the only automation; **OFF**; last edit 2026-11-15 6:24 PM, unchanged |

**No e-mail is claimed.** The native rule is OFF and the custom notify is unsent; inbox and messages were not inspected.

## 6. Limits

- **Guest UI** [ROOT-obs]: ONE status refresh (~22:55Z) of the TEST page showed the TEST booking confirmed with ref `MV-HYFP633M`; no Pay or
  release was offered; the Forget warning and the confirmation were retained. No failure path was tested live.
- **Stripe:** the raw proofs ran inside the runner only; there was no later independent Stripe dashboard END observation.
- **Historical objects:** no current provider state is inferred for them.

## 7. Residuals (owner / ROOT decisions; none authorized here)

- **Money:** captured TEST funds (14000 minor), the active R71794358 (NEW / Paid), its paid offline charge 35739022 and the HELD claim await a
  separately reviewed manual, policy-assessed disposition. Nothing is cancelled or refunded; no financial obligation is settled.
- **Preserved untouched:** the pending custom `guest.notify` `e300cf74…` and the 2 unprocessed inbox rows (no drain, suppression or mark-complete).
- **Unchanged:** rule 511521 OFF; protected reservations, historical intents (incl. `669da884…`) and the 28 migrated listings untouched; C67 PARKED.
- **Gap:** no automatic accepted-checkout → pipeline trigger exists. No notify, inbox, refund, cancel, cleanup or further live authority comes
  from this checkpoint.
