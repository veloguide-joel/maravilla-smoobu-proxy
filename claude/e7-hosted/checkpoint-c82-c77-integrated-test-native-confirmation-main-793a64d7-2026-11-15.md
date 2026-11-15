# Checkpoint C82 — C77 integrated TEST run (checkout → reservation → capture → recording → native Hostaway confirmation), CLOSED on main 793a64d7

**Status: CLOSED.** ONE fresh TEST checkout ran through these stages once each, all under the normal environment gates:
- S1-A — Hostaway create;
- S1-B — read / reconcile only;
- S2 — Stripe TEST capture;
- S4 — Hostaway offline-charge recording.

The ONE native Hostaway automation (rule `511521`) then generated exactly ONE confirmation message. ROOT verified that message in the owner-controlled inbox. The rule was then turned OFF. The execution flags opened by #125 were restored to false by the exact reviewed CLOSE PR #126. All seven `executeEnabled` flags are false on main.

**What it validates:** ONE integrated TEST booking end to end:
- Stripe TEST authorization;
- Hostaway create;
- Stripe TEST capture;
- Hostaway offline-charge recording, which makes Hostaway derive payment status Paid;
- ONE native Hostaway confirmation, scoped to the exact new ref, generated after Paid.

**What it does NOT validate:**
- general production readiness;
- native e-mail timing guarantees (one observation only);
- the custom MiCasaDirect sender path. The queued custom `guest.notify` stays undispatched, and C67 stays PARKED; a custom duplicate path is not needed now.

**Financial status:**
- The captured TEST funds, the active Paid reservation, its paid offline-charge row and the HELD claim await a **manual, policy-assessed disposition**. No financial obligation is settled.
- Refunds stay manual; no automated refund is enabled or authorized. Cancellation does not imply a refund or a payment cancellation.
- No further live action is authorized by this checkpoint.

**Attribution:**
- `[ROOT-obs]` — run, job, gate, DB and Gmail facts are ROOT observations.
- `[Claude-obs]` — Hostaway / Stripe dashboard facts in §5–§7 were observed read-only by Claude in its signed-in browser. Claude's two writes were the C76 rule Save and the C81 OFF toggle, each explicitly authorized by ROOT.
- Claude authored #125, #126 and this checkpoint. Claude ran no dispatch, gate approval, DB, checkout or capture action.
- No e-mail address, relay id, account contact, guest name or screenshot is recorded here.

---

## 1. Code provenance

| item | value | source |
|---|---|---|
| Enable PR | #125 (C73): S1 reservation, S2 capture and S4 recording `executeEnabled` → true; flags, comments and narrow test expectations only | ROOT GO `5911996236` |
| Enable merge | main `76eed281ec4be072d0d95d83a99ad9ef0092a3bf`, tree `df01da462135ba813bbd224633ac7dd2b70d36ce` | [ROOT-obs] |
| Independent tests at #125 | Node 22, each suite at its own pin, **170/170**, zero skips: five runners 94 + R0 1 + charge-list 19 + sink 22 + inspect 17 + booking 17 | ROOT `5911996236` |
| CLOSE PR | #126 (C74): the exact reviewed 302-line CLOSE patch, sha256 `06eeb6cf96bbb639b9760b56d453e17c3a341920c416c550f189338af0f132b6` | ROOT technical `5912007350`; END / CLOSE GO `5912156210` |
| CLOSE merge (current main) | **`793a64d75e69357aa9962eab61cc75fba1a92cfa`**, tree **`ad3fcfb4588e335719c8e42b2f8709330f74cdbd`** == tree of the closed main `88cd428c`; parents `76eed281` + `784d2bfb` | [ROOT-obs] |
| CLOSE validation | Full-tree restoration is byte-exact, so no redundant test claim is made. The closed-state suites (20/15/20/23/16, R0 1, W1–W7 ×4) ran on the same bytes in scratch during C73. | — |

**Closed state on main 793a64d7:**
- **Flags:** all seven `executeEnabled` are false (the five booking runners, notify-inspect and booking-confirmation).
- **Re-derived closed runner digests:**
  - reservation `5665544de105e4564a57a4434fa32fd2355b9bbd0e756b250d1248e07feb6b19`
  - capture `5b547a42200b452055d8a718c84ab70f7f2b5a0cd8343f6174c4a75b0c420ed1`
  - test-cleanup `33f2ab18984dccd3915a18ff8a55dd4a6e5b6bf89e3d84ba1e578347e6cebd1e`
  - recording `49b5516cb69543a6bd4a697a407d2f2a97a84e18a63f18715338f099917e4824`
  - recorded-cleanup `9e2021e3ec96bab16869fc194adac672287d559587b2cb7657738ffcd897de1f`
- **Notification runners:**
  - notify-inspect source `889d6a31af4249cede0bf8b64360b5ca0e7ca2d994c4c882f0348e5f57c2c8e7`, synthetic plan `af56dee10e72f2adb27adb93060f415cb3037794b3cbe95e6ddb03d09a919067`
  - booking-confirmation source `aff728cf8b3867a2580c8159f73081bccf2fd1659b4e07075822e14a7c4c16a0`, synthetic plan `6f5bdd7872b5107c35b2c64fbeb2529b610f96dc2063af89c7cb5284ae8258b4`
- **Probes unchanged:** charge-list `43715872ddb450889286880c848acefd8757da6fe33bc5c6a3a547bd27219cf3`, Resend sink `aef26da954d986dc2d922b607d391be404dd73f1145ece0ae66ea0d80673ade4`.
- **Schema:** shared DEV is at schema 23. The 23 `intent_id` child tables include `notification_provider_receipts`.

## 2. Target and baseline [ROOT-obs]

| item | value |
|---|---|
| Intent | `954d476c-71ea-4824-92f6-2220ae302103`, ref **MV-XXU5YPDP** |
| Stay | listing 606998 ("maraVilla TEST - DO NOT BOOK."), 2026-11-28 → 2026-11-29, 1 guest, USD 14000 minor, TEST |
| Created / notBefore | 2026-11-15T17:49:15.766Z / 17:48:15.766Z |
| Stripe TEST | PI `pi_3Uc7b42B9LTneQgw0v0oPyMU`, charge `ch_3Uc7b42B9LTneQgw0OzKJhrj`, attempt `2509a13e-32d9-4515-aa66-327bbcc48c3a` |
| T0 snapshot | 2026-11-15T17:48:18.113Z: 8 baseline intent ids; all 23 child catalogs matched; schema 23; 0 active leases / locks / prepared / cases; only the old held claims (Nov 21–22, Nov 23–24) |
| Discovery | 17:50:02.400Z: the exact set difference is ONE new id, none missing |
| Bound proof | 17:50:16.760Z: `details_collected` v2; no PI / reservation / ops / claims / cases yet |
| Checkout | ONE Stripe Checkout created (Sandbox MiCasaDirect, $140 TEST); ONE TEST authorization completed. DB at 17:52:29.890Z: v4, authorized, captured 0 |

**Pre-run Hostaway readiness (C75)** [Claude-obs], 17:47:40Z–17:50:27Z:
- 606998 is Draft and unmapped (no channel), with zero auto-payment rules.
- Nov 28 and 29 were open, and there were zero message automations.

## 3. Native rule (C76) [Claude-obs]

- **Saved:** ONE rule, `511521`, at **17:59:38Z**, after a fresh pre-save readback (17:59:20Z) that matched the reviewed 17:54:17Z draft.
- **Name / subject:** "MiCasaDirect TEST confirmation — MV-XXU5YPDP".
- **Body:** the fixed English TEST text.
- **Scope:**
  - trigger At · Reservation; Guest stays;
  - channel Hostaway Direct ONLY; listing 606998 ONLY;
  - conditions: Reservation custom field `maraVilla booking ref` **is `MV-XXU5YPDP`**, AND Payment Status **is Paid**.
- **Off:** SMS, CC, attachments, add-new-listings, always-trigger. Apply listing timezone was left at its default (on).
- **Zero historical match:** no existing reservation on 606998 carried this ref.
- **State after save:** ONE rule listed, toggle ON, no messages generated (no reservation existed yet).
- **Caveat:** the Hostaway UI does not label conditions as AND or OR. It reads "only … if the following conditions are met".

## 4. Runner executions [ROOT-obs; normal gates ≈ 18:02 / 18:08 / 18:13 / 18:19Z, no bypass]

All times below are on 2026-11-15 UTC. Full plan hashes were independently calculated by ROOT and matched the hosted preflight logs.

| stage | preflight run / job · tests · plan | execute run / job | VERIFY → DONE (UTC) | result |
|---|---|---|---|---|
| S1-A create | `43743684345` / `132902187787` · 20/20 · `f157471df920d7fa3ffcb44f0b3f9058e20f5c88cdcf4d0d78958c3d6909cd9d` | `43744398571` / `132904388024` (once) | 18:02:43.676Z → 18:04:09.027Z | STEP_BUDGET_EXHAUSTED / STEPS. createInvocations 1, REPLIED; CREATE_REF_NOT_ECHOED: READS_REQUIRED. DB create op succeeded 1, result ref 71781276; v6 `reservation_pending`. **Not an uncertain create.** |
| (lease) | — | — | ROOT 18:05:15.221Z | The intent lease marker until 18:04:46.692Z had expired; nextAction 18:04:48.376Z had passed. Work / op unleased; **no DB repair** |
| S1-B read / reconcile | `43744817338` / `132905680818` · 20/20 at 18:06:27.988Z · `7ed9f7b5dc779d4a8e2d96289de3d25b0fe5dc95237f7e3293a326791663af1c` | `43744985414` / `132906196875` | 18:08:39.219Z → 18:08:52.498Z | SUCCESS: RESERVATION_CONFIRMED_INTERMEDIATE v7, createInvocations **0**, R 71781276, capture queued pristine, lock released, no cases |
| S2 capture | `43745172697` / `132906780133` · 15/15 at 18:10:05.804Z · `8fdff31423ea526f4c4bb05841005f7d70103aa6b2a49f2704ee1f7a69cd6f50` | `43745437216` / `132907591645` | 18:13:37.020Z → 18:13:49.545Z | PAYMENT_CAPTURED_INTERMEDIATE v8; captureInvocations 1, REPLIED; captured 14000; recording op pristine; claim HELD; cases 0 |
| S4 recording | `43745797865` / `132908693136` · 23/23 at 18:16:30.220Z · `953ea409cdf4ac2bf7d24bcf75bcfe640999490528c0866d30d18b21711caa63` | `43746039485` / `132909436767` (E7_RUN_ID `43746039485-1`) | 18:19:44.085Z → 18:19:58.360Z | RECORDING_CONFIRMED v9; offline charge **35730158**; ONE POST (recordInvocations 1, REPLIED); 7 exchanges (2 identity, 4 lists); 147 DB statements in total, incl. 15 teardown; four proofs + postcheck; lock released; cases / holds 0 |

Approval reviews:
- #125 enable GO `5911996236`
- S1-A GO `5912062234`
- S1-B read-only GO `5912082729`
- S2 GO `5912102137`
- S4 GO `5912141727`

## 5. Stripe TEST facts [Claude-obs, Workbench Inspector, current object, API version 2026-06-24.dahlia]

| read (UTC) | PI status / livemode / amount / received / capturable | charge status / paid / captured / amount_captured / refunded / amount_refunded |
|---|---|---|
| pre-S2 18:11:31Z / 18:12:10Z | `requires_capture` / false / 14000 / 0 / 14000 | `succeeded` / true / **false** / 0 / false / 0 |
| post-S2 18:15:07Z / 18:15:24Z | `succeeded` / false / 14000 / 14000 / 0 | `succeeded` / true / **true** / 14000 / false / 0 |
| END 18:22:32Z / 18:22:51Z | unchanged from post-S2 | unchanged from post-S2 |

**Capture log:** exactly ONE `POST /v1/payment_intents/pi_3Uc7b42B9LTneQgw0v0oPyMU/capture`.
- Result: 200 at 18:13:45Z; request `req_Enpa0mWNDiVvXt`; request API version 2026-01-28.clover.
- Idempotency key: `cap:954d476c-71ea-4824-92f6-2220ae302103:pi_3Uc7b42B9LTneQgw0v0oPyMU`.
- Body: `{"amount_to_capture": "14000", "expand": ["latest_charge"]}`, with **no `final_capture`**.

The only other logged requests are the checkout session create (17:50:42Z) and the payment-page confirm (17:52:11Z). The recording made no Stripe write.

## 6. Hostaway reservation facts [Claude-obs]

**18:06:59Z, after S1-A** — R 71781276:
- ref `MV-XXU5YPDP`; listing 606998; Hostaway Direct; 2026-11-28 → 29, 1 night;
- 1 guest; USD; total 140.00;
- status New; payment status **Unknown**.

**18:16:24Z, after S2:** unchanged; payment Unknown; no message.

**18:21:25Z, END:**
- Status New, payment **Paid**.
- Change log at **18:19:53Z UTC:** payment status Unknown → Paid; total paid → 140.
- Exactly ONE charge row: `35730158`, $140.00, Paid.
- Ref, listing and dates are unchanged.

## 7. Native confirmation and rule closure

| item | value | source |
|---|---|---|
| Hostaway Paid | 18:19:53Z (reservation change log) | [Claude-obs] |
| Owner inbox | exactly ONE message received **18:22:04Z**: subject "MiCasaDirect TEST confirmation — MV-XXU5YPDP", expected body, no CC / BCC / attachments. Also seen on Joel's own screen. | [ROOT-obs] Gmail connector |
| Manage Messages before receipt | 18:21:55Z: no row for this target yet | [Claude-obs] |
| Rule OFF | toggled once at **18:24:17Z**. The confirm dialog's **default-ticked** "Also delete any existing scheduled messages?" box was **unticked**, so nothing was deleted. Reload at 18:24:31Z: rule `511521` still listed, **OFF**, scope retained | [Claude-obs] |
| Manage Messages after | 18:24:50Z: exactly ONE new row `528762090`, **SENT**, same subject, trigger Reservation, listing 606998, R 71781276, check-in 2026-11-28 3:00 PM / check-out 2026-11-29 11:00 AM. The UI showed only "2 minutes ago"; no exact Hostaway send timestamp is claimed | [Claude-obs] |

Observed timing for this one run: Paid 18:19:53Z → received 18:22:04Z. This is one observation, not a timing guarantee. Hostaway documents that Reservation conditions are re-evaluated on updates and several times a day.

## 8. END database state [ROOT-obs]

**END snapshot 18:22:42.415Z**
- **Identity:** the exact 9 ids = the T0 set plus the target. All 8 foreign rows and their 23 child fingerprints are identical; catalog true; schema 23.
- **Globals:** `booking.api_rate_limits` is the only global delta from T0. Every global fingerprint at END is identical to the pre-S4 snapshot at 18:17:27.340Z.
- **Idle:** work, intent and operation active leases, in-flight operations, advisory locks, prepared transactions and open cases are each 0.

**S4 target deltas**
- ops 12 → 16, evidence 8 → 11
- recording_assessments 0 → 1, recording_claim_assessments 0 → 1, recording_conflict_inbox 0 → 2
- transitions 9 → 10, applied 7 → 8, ledger 2 → 3
- intent_work lease cleared
- inventory_claims full-row fingerprint unchanged (HELD) versus pre-S4; the other child-table counts and fingerprints are unchanged versus pre-S4

**Read-only detail 18:24:59.968Z / 18:25:03.568Z**
- Confirmed v9; create, capture and record each succeeded 1; ref bound.
- Custom notify `ffd71bd2-3755-480e-a3e6-422958a645d0` is pending, attempt 0, undispatched.
- 2 inbox rows have `processed_at` NULL.
- Custom provider receipts 0; no holds, cases or refunds.

## 9. Residuals (owner / ROOT decisions; none authorized here)

**Money**
- Captured TEST funds (14000 minor), the active Paid R 71781276 with paid offline charge 35730158, and the HELD claim all await a **manual, policy-assessed disposition**.
- Nothing is cancelled or refunded, and no financial obligation is settled.

**Preserved untouched**
- The custom `guest.notify` (pending, undispatched) and 2 unprocessed `recording_conflict_inbox` rows. No suppression, drain or mark-complete.

**Unchanged elsewhere**
- Protected reservations 70636076 / 71045356 / 71072615 / 71081885 and historical intents `abede8b1…` / `c83c1842…`.
- Rule `511521` stays OFF (kept for audit, not deleted).

**Closed or parked**
- All seven runner flags are false.
- C67 (custom owner-test inbox / Resend recipient) stays PARKED.
- No further live action is authorized by this checkpoint.
