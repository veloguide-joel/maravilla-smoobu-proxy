# Checkpoint — C3 fresh TEST capture validation — CLOSURE — 2026-11-13
Claude executor · doc-only. Facts are attributed: **[ROOT]** = ROOT's end/stop readback (pure SELECTs, run logs, reviews, retained by ROOT); **[Claude-obs]** = Claude's read-only provider observation at the stated UTC time through existing signed-in sessions (nothing resent, captured, cancelled, refunded, recorded, notified; no API keys or credentials read; guest contact fields omitted); **UNKNOWN** = not exposed, not inferred. Flags are **CLOSED** again on main; nothing further is authorized by this checkpoint.

**Governing policy (Joel, 2026-11-13):** cancelling a reservation does NOT imply refunding / voiding / cancelling a payment; refunds are MANUAL and policy-assessed; no automated refunds, not even for TEST; Slices 3 / 5 cleanup paths HELD. The validation STOPPED after `payment_captured`: no recording, notification, cleanup, refund or void was performed or queued for dispatch. **No financial obligation is settled by this test.**

## 0. Result in one line
**TEST capture VALIDATED through the hosted path** [ROOT]: at main `1082c0a2` (flags OPEN for this one test; tooling 40779e34 / 59178b04) one Hostaway TEST reservation **R71700931** was created and confirmed (two-session no-echo continuation) and **exactly one fenced capture** of Stripe TEST PaymentIntent `pi_3UbR9W2B9LTneQgw1sqmnm3K` (USD 140.00 = 14000 minor) succeeded with the C1 body (no `final_capture`); intent `abede8b1-8ef6-44f2-876e-6a02fc056a96` / `MV-8L79DEJ7` is `payment_captured` v8; the seven pre-existing intents are byte-identical to T0; the flags are CLOSED on main `a803d207`.

## 1. Code and review state
| Item | Value |
|---|---|
| Enable (OPEN) | main `1082c0a25f34cdf8d2b9e7d0559f5dbacc887988` (tree `577cd132…`), PR #87, readiness review 5897553804 [ROOT] |
| **Close (all FALSE)** | **main `a803d20733bafcb5b2cdf9ddcdb7dbff90acead3`**, PR #88 merged by ROOT, exact reviewed closing tree `7de222823c982df62a95859b751a098e6caa6b89`, closing review 5897964333; **no more execute** [ROOT] |
| Closed runner digests (independently re-derived by ROOT from the merged commit) | reservation `5665544de105e4564a57a4434fa32fd2355b9bbd0e756b250d1248e07feb6b19` · capture `5b547a42200b452055d8a718c84ab70f7f2b5a0cd8343f6174c4a75b0c420ed1` · test-cleanup `33f2ab18984dccd3915a18ff8a55dd4a6e5b6bf89e3d84ba1e578347e6cebd1e` · recording `dafcc415dd2a5b2bfcfa163bcf2c116d99e82c83ee8611353bd1cd395252b683` · recorded-cleanup `3e0eba4204d7dc8c688d8ddeb2afc0d057fe31b99258848b2538934e4c685d16` (= pre-enable pins) |
| Closure digests / pins | S1 `0ffc0b9c…` @ 40779e34 · S2 `adaed044…` @ 59178b04 · S3 `f84b4157…` @ 9d86bfa1 · S4 `ef9341dc…` @ 5a094b16 · S5 `85c72bf6…` @ e41b654a — unchanged throughout |
| Since the close | #89 (C5 evidence, doc-only) merged → main `4187343c…`; this checkpoint branches from that main (contains `a803d207` + the doc) |
| Shared DEV (ROOT SELECT 20:24:20Z) | TEST, migrations exactly 1..21, catalog 22 child tables, 7 intents incl. `c83c1842…` (`capture_unknown` v8), one HELD claim 606998 Nov 21–22, quiescence 0, vocabulary 2 [ROOT] |
| Readiness | C5 evidence (`c5-readonly-readiness-evidence-2026-11-13.md`): gate ON / main-only / admin bypass OFF / queue empty; Stripe TEST webhook `we_1UYdXL…` active on the e7-test alias; Hostaway 606998 Draft, no channel mapping; R71692858 host-cancelled 17:56:05Z. Vercel e7-test alias READY `dpl_3RDyYL4YQtmQs6sN1CNCcYQKuJrg` @ 59178b04 [ROOT] |

## 2. T0 baseline [ROOT]
**T0 = 2026-11-13T20:27:29.438Z**: `__T0_IDS__` = 7 ids (six historical + `c83c1842-d342-4e27-9ab7-dc3d50b7a309`); full `booking.intents` rows + all 22 child-table counts/digests per id + global table fingerprints recorded; leases / in-flight / locks / prepared / open cases 0; held claims = the Nov 21–22 claim of `c83c1842…` on 606998.

## 3. The ONE new TEST intent [ROOT]
| Field | Value |
|---|---|
| intent / ref | `abede8b1-8ef6-44f2-876e-6a02fc056a96` / `MV-8L79DEJ7` |
| listing / stay / guests | 606998 · 2026-11-23 → 2026-11-24 (1 night) · 1 guest — no overlap with the HELD Nov 21–22 claim |
| total | USD 140.00 (= 14000 minor units), server-quoted |
| Stripe TEST PI / attempt | `pi_3UbR9W2B9LTneQgw1sqmnm3K` (livemode false) · one completed attempt `d84a59df-aaae-4ab4-94a5-5161024eef6b` · `checkout.session.completed` processed |
| 20:33:21Z | `payment_authorized` v4, `captured_minor` 0; stored captureBefore 2026-11-20T20:32:54Z / authorizationDeadline 2026-11-18T20:32:54Z |
| C3-B / C3-C 20:33:55Z | exactly one new id (accepted); `binding_ok`; 7 foreign rows + 22 child fps byte-identical to T0; `api_rate_limits` the only global delta; no leases / locks / cases |

## 4. Sessions [ROOT]
### S1-A reservation (authorized admission)
- preflight **43503210071 PASS 20/20**, planHash `aa7207dcc11e168b26601bd89bc4810b7486b87320c9af901c3fc5e84b0258fd` = ROOT's local plan hash; source / closure / runner digests matched the OPEN pins.
- execute **43503528915** (submitted once; gate approved by ROOT under Joel's standing authority) ended **2026-11-13T20:43:38Z**: `STEP_BUDGET_EXHAUSTED` / `STEPS`, 12 steps, `payment_authorized` → **`reservation_pending` v6**; actions `RESERVATION_STARTED`, `RESERVATION_DISPATCHED`, `CREATE_CLAIMED`, `CREATE_REF_NOT_ECHOED:READS_REQUIRED`; createInvocations 1, createOutcome REPLIED, createOps `[succeeded]`; lock released; no capture / refund / record / notify / cancel / void. **Expected no-echo continuation** (same as 2026-11-13 S1-A 43472636610), not an uncertain-create rerun.
- 20:44:51Z proof: `binding_ok`; **R = 71700931** bound from the create op `result_ref` and the Hostaway attempt row (never assumed); work / op leases 0; known create succeeded 1; `next_action_at` 20:44:12Z due. Intent `reservationId` NULL before confirmation is expected for the pending admission.
### S1-B reservation (pending admission; same bound intent, pinned R, fresh version)
- preflight **43504977306 PASS 20/20**, planHash `01a3fc01d17256943865072fa6b1de6649ddeb0247b7637ab65f43e9b9723c66`.
- execute **43505124805 SUCCESS 20:51:01Z**: `RESERVATION_CONFIRMED_INTERMEDIATE` → **`reservation_confirmed` v7**, R71700931, 3 steps, **create 0 / all provider writes 0**; fresh by-ref + by-id reads found the reservation (ref echoed on the reads); capture op queued pristine; lock released.
- C3-C 20:51:36Z: `reservation_confirmed` v7, intent lease false.
### S2 capture (@ 59178b04; body `amount_to_capture=14000&expand[]=latest_charge`)
- preflight **43505601305 PASS 15/15**, planHash `41d52b6016265e76220540c320b3b5d6bbdf77da4c5cb8a6c1bdf868ac5f4d29`, closure `adaed044…`, runner `0b83183b…`, pin 59178b04. Fresh 20:56:43Z proof: v7, capture op pristine (0 attempts, undispatched), no leases; gate approved normally.
- execute **43505796029 SUCCESS 20:57:10Z**: `PAYMENT_CAPTURED_INTERMEDIATE` → **`payment_captured` v8**, R71700931, `capturedMinor` 14000, charge **`ch_3UbR9W2B9LTneQgw1foeKLft`**, 1 step (`CAPTURE_CLAIMED` / `CAPTURE_SUCCEEDED`), captureInvocations 1 REPLIED, exchanges 7, piReads 3, lock released, **recordingQueuedPristine = true**, all other provider writes 0.
- C3-C 20:57:42Z: `payment_captured` v8; capture op `succeeded`/1/`ch_…`; recording op `pending`/0/undispatched key `och:<intent>:1`; ledger `authorization_accepted` + `capture_succeeded`; refunds / cases / suppressions 0; claim HELD; no leases.

## 5. END readback
### 5.1 Database [ROOT] — C3-A 20:58:25Z
Exact 8 ids = T0 seven + `abede8b1…`; **all 7 foreign full rows + all 22 child-table counts / digests byte-identical to T0**; only global delta `api_rate_limits`; leases (work / intent / op) 0, in-flight 0, locks 0, prepared 0, open cases 0; migrations {21, 1, 21}; vocabulary 2; held claims = old Nov 21–22 (`c83c1842…`) + new Nov 23–24 (`abede8b1…`). Old `c83c1842…` v8 evidence byte-identical. Protected reservations never admitted or acted on. (No claim of a provider-wide snapshot.)
### 5.2 Stripe TEST account `acct_1TyHE42B9LTneQgw` [Claude-obs 2026-11-13T21:01:16Z–21:01:50Z]
| Item | Observed |
|---|---|
| PI `pi_3UbR9W2B9LTneQgw1sqmnm3K` (dashboard) | **Succeeded**, $140.00 USD; activity "$140.00 captured Nov 13 8:57 PM" (20:57Z), authorized / started 8:32 PM (20:32Z); last updated 8:57 PM; processing fee −$5.48, net $134.52; **no refund activity, no later event** (event list ends with "payment … has succeeded" / "charge … captured" at 20:57:09Z); funds available Nov 20; metadata `mv_intent_id=abede8b1-…`, `mv_payment_attempt_id=d84a59df-…`, `mv_stage=e5a-test` |
| Logs for the PI | `POST /v1/checkout/sessions` 200 20:31:16Z · `POST /v1/payment_pages/cs_test_a0ya…/confirm` 200 20:32:54Z · **exactly one `POST /v1/payment_intents/pi_3UbR9W…/capture` 200 at 2026-11-13T20:57:10Z, request `req_tIG0i81IDWcZAU`**, API version 2026-01-28.clover |
| Capture request (Workbench log) | **Request body `{ "amount_to_capture": "14000", "expand": ["latest_charge"] }` — no `final_capture`**; **Idempotency key `cap:abede8b1-8ef6-44f2-876e-6a02fc056a96:pi_3UbR9W2B9LTneQgw1sqmnm3K`** (the accepted provider key) |
| Capture response (raw fields, expanded `latest_charge`) | PI `status=succeeded`, `amount=14000`, **`amount_received=14000`, `amount_capturable=0`**, `capture_method=manual`, `livemode=false`; charge `id=ch_3UbR9W2B9LTneQgw1foeKLft`, `amount=14000`, **`amount_captured=14000`, `amount_refunded=0`, `captured=true`, `refunded=false`**, `paid=true`, `status=succeeded`, `disputed=false`, `balance_transaction=txn_3UbR9W2B9LTneQgw1WTbykko`, `created=1794601974` (2026-11-13T20:32:54Z) |
| Current-state caveat | the raw numeric fields above are from the capture *response* (20:57:10Z); the dashboard at 21:01Z shows the same state (Succeeded, no refund entries, no later events). A separate live object read was not performed (no API key use). |
| Old PI `pi_3UbO8K…` | not re-read in C12 (C5 readback stands: uncaptured, `amount_received=0`, no refund); untouched by the runners [ROOT] |
### 5.3 Hostaway [Claude-obs 2026-11-13T21:02:37Z–21:04:30Z]
| Item | Observed |
|---|---|
| R71700931 | **Status `New`** (active; NOT cancelled by any runner), payment status Unknown; channel Hostaway Direct; listing `maraVilla TEST - DO NOT BOOK.` (606998); **stay 2026-11-23 → 2026-11-24 (1 night)**, 1 guest; total 140.00; **Balance due $140.00 / Remaining charges $140.00 / no transactions** (nothing charged or recorded in Hostaway — recording was never dispatched); custom field **"maraVilla booking ref" (105433) = `MV-8L79DEJ7`**; Reservation Stored No / Channel active Yes / Synced Yes; last updated 2026-11-13 8:42 PM (listing time); **Logs: "We couldn't find any data"** (no status change since creation) |
| Calendar (multi view, row 606998) | **Mon Nov 23 shows the Hostaway reservation bar (1 night)**; Nov 20–22 open ($100 cells) — the old Nov 21–22 dates remain free on Hostaway (R71692858 cancelled), while the DB claim for them stays HELD |
| Account-level note (outside the test) | the Hostaway account now lists 31 listings (4 at the 20:18Z C5 read) — unrelated owner-side activity; not part of this validation and not interpreted |

## 6. Outcome statement
> "TEST capture validated through the hosted path at main `1082c0a2` (tooling 40779e34 / 59178b04): one TEST reservation (R71700931, Nov 23–24, 606998) and exactly one fenced capture (`pi_3UbR9W2B9LTneQgw1sqmnm3K` → `ch_3UbR9W2B9LTneQgw1foeKLft`, USD 140.00) on the Stripe TEST account; intent `abede8b1…` is `payment_captured` v8 with its recording op queued pristine and never dispatched; **the captured TEST funds await manual, policy-assessed disposition by the owner; reservation R71700931 is active pending the owner's decision; the DB inventory claim for Nov 23–24 is HELD; no financial obligation is settled by this test.** The seven pre-existing intents (incl. `c83c1842…` and its `pi_3UbO8K…` authorization and HELD Nov 21–22 claim) are byte-identical / untouched; the four protected reservations were never admitted. Flags are CLOSED on main `a803d207` with the pre-enable digests re-derived."

## 7. Operational notes (brief; corrections to the C3 packet's wording, no runtime change)
1. **Historical intent-lease field vs quiescence.** The C3 packet's quiescence rule reads `booking.intents.lease_worker_id IS NOT NULL` as "intent lease". During S1-A/S1-B the E3-era intent lease field was **non-null but EXPIRED (20:44:08Z)** on the pending intent; the reviewed pinned reservation worker (`reservation-worker.js` ~294) and repo (`repo.js` ~700–720) explicitly exempt a proven succeeded-create / read-continuation from interrupted-create recovery, so this is not a live lease and is not a Class-E signal. No DB repair was done or needed. Future C3-A/C3-C readings should report `lease_until` alongside `lease_worker_id` and treat an expired pair as historical, not as a held lease. [ROOT]
2. **DB operation key vs provider idempotency key.** The capture *operation row* key is `cap:<intent>:v7` (version-bound DB key), while the *provider* Idempotency-Key sent to Stripe is `cap:<intent>:<pi>` (accepted `captureKey`); ROOT verified the payload PI / 14000 / provider key by pure SELECT, and the Workbench log shows the provider key verbatim (§5.2). The two must not be conflated in proofs or packets. [ROOT + Claude-obs]
3. **Pending admission facts.** With the no-echo continuation, `intents.hostaway_reservation_id` is NULL until S1-B confirms; R is bound from the create op `result_ref` + the Hostaway attempt row, never assumed. [ROOT]

## 8. What remains (not authorized by this checkpoint)
- Owner's manual disposition of the captured TEST funds (`pi_3UbR9W…` / `ch_3UbR9W…`) and of the still-open old `pi_3UbO8K…` authorization, and of R71700931 — outside this checkpoint; to be recorded later as owner-reported, provider-observed facts (see `c7-d4-residual-blocker-map-2026-11-13.md` R4 for the missing manual-disposition record shape).
- Reviews of the separate DRAFTs: #90 (D4 residual map), #91 (ordering regression; rebase + recording digest re-derivation now that flags are closed), #81 (page-integration maintenance on e7-test 59178b04).
- Recording / notification remain CLOSED (D4 / D3); nothing here opens them.
