# Checkpoint C97 — C94 / C95 hosted TEST pipeline booking (fresh checkout → reservation → capture → recording), CLOSED on main 40874321

**Status: CLOSED.** ONE fresh TEST checkout went through the merged hosted pipeline runner (#130) in two separately reviewed, gated invocations of ONE coordinator each:
- **C94:** first attempt → `PENDING NOT_DUE` after ONE successful Hostaway create;
- **C95:** due continuation → `CONFIRMED_VERIFIED`.

Across both attempts there was exactly 1 create, 1 capture and 1 offline-charge record. The continuation was **not** a retry of an uncertain write: C94 ended settled, with no unknown outcome, and C95 created nothing.

The pipeline was closed again after each attempt (#132, #134). **All eight runner `executeEnabled` flags are false** on main `40874321`: the five legacy runners, notify-inspect, booking-confirmation and the pipeline.

**What it validates:**
- ONE fresh TEST booking through the combined pipeline, using ONE coordinator invocation per dispatch, on listing 606998;
- reservation → Stripe TEST capture → Hostaway offline-charge recording;
- the durable readback verified by the runner and by ROOT.

**What it does NOT validate:**
- an integrated guest-facing confirmation UI (see §6);
- production or UI automation readiness;
- automatic resume. The continuation was a separately reviewed dispatch.

**Financial status:**
- The captured TEST funds, the active reservation, its paid offline-charge row and the HELD claim await a **separately reviewed manual disposition**. No financial obligation is settled.
- Refunds stay manual. No refund, cancel, cleanup, notify or inbox authority comes from this checkpoint.

**Attribution:**
- `[ROOT-obs]` = ROOT review `5912974438` and supplement `5912979065` on #134: run / job / gate / digest / DB facts.
- `[Claude-obs]` = the C96 read-only Hostaway session.
- Claude authored #130 – #132. Claude ran no dispatch, gate approval, DB, checkout, capture or Stripe action.
- No e-mail address, guest name, contact or screenshot is recorded here.

---

## 1. Code provenance

| item | value | source |
|---|---|---|
| Runner | #130 (C90 / C91), merge `e04ab542`, closed tree `7f9185eb6bbbbd81f54b26a99f978ea9a8d8da37`. Tooling pin e7-test `71c3dcf8` (coordinator C83 / C86 / C88), closure `f7d7cad646eaed2fb37a63e031157732ee6e2a44824f9d935d6b9104e08f7273` | — |
| ENABLE | #131 (C92), GO `5912862479`, merge `432127816dbeacd7402de3840d9cca938d314126`, tree `6718def4008cf34103771736a2f4ec7f5699bbc7`; enabled source `9fbbf1358ca2c23116b3a236a738a72cf56bccdc3bc51d84a23e1b93e18100c7` | [ROOT-obs] |
| CLOSE after C94 | #132 (C93), the exact reviewed 126-line reverse patch (sha256 `0853fbeb90b788ae6eba4ec3144ca544c5c39a794b2bb30bd78b769ffb6e53dc`) → `8d4e733` | [ROOT-obs] |
| Re-ENABLE for the continuation | #133, separately reviewed, the exact same ENABLE tree, no new semantics → `2fbb2955` | [ROOT-obs] |
| CLOSE after C95 (current main) | #134 → **`40874321de27cdc83c32e6a310c6eb2761a1a4f6`**, tree **`7f9185eb6bbbbd81f54b26a99f978ea9a8d8da37`** = the exact original CLOSED tree | [ROOT-obs] |

**Closed state on main `40874321`:**
- **Pipeline:** source `24314a714da1e93d266424a60e75449ce146c5032f0665adf27b38322786d69a`, synthetic plan `5c5af916ff9f53df9dbc4cc5bdef22772cdb3243bf3370a5786b5ef88020447f`.
- **Legacy runners, unchanged:** reservation `5665544d…`, capture `5b547a42…`, test-cleanup `33f2ab18…`, recording `49b5516c…`, recorded-cleanup `9e2021e3…`.
- **Notification runners, unchanged:** notify-inspect `889d6a31…`, booking-confirmation `aff728cf…`.
- **Schema:** 23, unchanged. [ROOT-obs]

## 2. Target and baselines [ROOT-obs]

| item | value |
|---|---|
| Intent | `669da884-02e8-4105-8825-f908e5d22ae9`, ref **MV-VBQL2LQY** |
| Stay | listing 606998 (TEST), 2026-11-30 → 2026-12-01, USD 14000 minor |
| Stripe TEST | PI `pi_3UcAVN2B9LTneQgw0Kuj1QBs`, charge `ch_3UcAVN2B9LTneQgw0hrhn4Sp` |
| Hostaway | reservation `71789623`, offline charge `35735899` |

**Timestamp baselines (2026-11-15 UTC):**

| time | event |
|---|---|
| 20:56:02.258Z | **T0**: 9 intents; 23-child catalog match; schema 23; no active leases, locks or cases |
| 20:56:41.518Z | target created |
| 20:58:31.885Z | target authorized 14000, v4 |
| 20:59:53.993Z | pre-C94 execute snapshot: 10 ids; the 9 foreign fingerprints unchanged; only `api_rate_limits` differs from T0 |
| 21:04:13.359Z | C94 PENDING END: foreign fingerprints and globals unchanged from pre-execute; target v6, one settled create 71789623 |
| 21:06:15.988Z | due C95 baseline: all 10 whole-row + child fingerprints and globals byte-identical to C94 END; the expired lease is no longer active |
| 21:13:52.084Z | C95 END |
| 21:15:28.079018Z | allowed detail SELECT |
| 21:17:43.556Z | final snapshot, after the status refresh in §6 |

## 3. Runs [ROOT-obs]

| attempt | run / job · gates | result |
|---|---|---|
| **C94** first attempt | run `43761386110-1` on `43212781` | `PENDING NOT_DUE` at 21:03:29.6175913Z. Create 71789623 succeeded once; capture 0 / record 0; no unknown. Then CLOSED by #132 |
| **C95** continuation | run `43762059228-1` on `2fbb2955`, approval `ROOT-C95-PIPELINE-CONTINUE-20261115`. Preflight job `132958838004`: bindings 21:09:20.3054665Z, 17/17 at 21:09:25.7230293Z, source match 21:09:25.7498703Z. Normal `e7-readonly-probe` gate approved ~21:12Z, no bypass or settings change. Execute job `132958943461`: VERIFY_OK 21:12:49.9685815Z | EXECUTE_DONE 21:13:09.9109874Z **CONFIRMED_VERIFIED / CONFIRMED**, v6 → v9 |

**C95 binding digests (all MATCH):**
- plan `20fc654faba30e9e335a8c4f2067a271044801d961f89d54b9a150c9df05109f`
- source `9fbbf1358ca2c23116b3a236a738a72cf56bccdc3bc51d84a23e1b93e18100c7`
- closure `f7d7cad6…7273`

**C95 sends and replies:**
- Continuation sends create / capture / record = 0 / 1 / 1; replies NONE / REPLIED / REPLIED.
- **Total across both attempts: 1 / 1 / 1**, with no repeated create.

**C95 execution detail:**
- ONE coordinator invocation: 5 steps, 19 exchanges, 399 DB statements.
- Fresh Stripe proof at the start, before capture and before recording, plus the ref-echo proof.
- Lock released; sealed false; coordinatorSettled true; POOLS_ENDED.
- verifiedCompletion true, possiblyEffected false. No rerun.

## 4. Database END [ROOT-obs]

**C95 END snapshot (21:13:52.084Z)**
- **Identity:** exactly 10 ids. All 9 foreign intents' whole rows and 23-child fingerprints are byte-identical to T0. All 7 globals are byte-identical to pre-C95 (and to pre-C94 execute).
- **Target deltas:** confirmed v9; ops 5 → 16; evidence 3 → 11; ledger 1 → 3; transitions 7 → 10; applied 5 → 8; assessments 0 → 1; claim assessments 0 → 1; inbox 0 → 2.

**Detail SELECT (21:15:28.079018Z)**
- Create, capture and record each succeeded exactly once.
- The custom `guest.notify` `786805a2-266d-4715-8908-976ba8956242` is pending: attempts 0, undispatched, uncompleted, no result, error null.
- Inbox: attempts 0, processed NULL (2 rows unprocessed).
- **Claim:** the target's NEW claim was **promoted from authorized to reserved while remaining HELD**. Its fingerprint is not claimed unchanged across the continuation. Old claim fingerprints are unchanged.
- Work lease, nextAction and intent lease are NULL.
- No active leases, in-flight ops, open cases, advisory locks or prepared transactions.
- Refunds, renders, latches, receipts and suppression are all 0.

**Final snapshot (21:17:43.556Z)**
- Target whole-row + 23 children byte-identical to 21:13:52.084Z; the 9 foreign rows are still byte-identical to T0.
- The **only** global change since 21:13:52 is `booking.api_rate_limits`, from the explicit status refresh in §6. The other 6 globals are byte-identical.
- No active leases, locks or cases.

## 5. Hostaway END [Claude-obs, C96, read-only, 2026-11-15T21:15:11Z–21:18:30Z]

Page navigation only. No edit, save, toggle, send, cancel or refund; no inbox, thread or foreign reservation was opened.

| item | observed |
|---|---|
| R71789623 (21:15:11Z) | status **NEW** (the Hostaway reservation status; not renamed "confirmed"); payment status **Paid**; Hostaway Direct; listing 606998; 2026-11-30 3:00 PM → 2026-12-01 11:00 AM, 1 night, 1 guest; USD; base rate / total price 140.00; Payment balance Total $140.00 / Paid $140.00; booking ref field `MV-VBQL2LQY`; Synced Yes |
| R71789623 logs (UTC) | 9:13:07 PM "Payment status value was changed from Unknown to Paid" (shown twice); 9:13:07 PM "Total paid value was changed from to 140" |
| Guest Payments (21:17:39Z) | exactly ONE row for the reservation: charge **35735899**, "maraVilla payment mvoch1-669da884-02e8-4105-8825-f908e5d22ae9", Charge, **$140.00, Paid**, charge date 2026-11-15 (21:13 UTC), no failure reason |
| Calendar 606998 (21:17:59Z) | night Nov 30 booked (reservation bar, not selectable); Dec 1 (checkout) and Dec 2 open |
| Automation 511521 (21:18:30Z) | the only automation; **OFF**; last edit 2026-11-15 6:24 PM (the C81 OFF), unchanged |

**No e-mail is claimed.** The native rule is OFF and scoped to the old ref, and the custom notify is unsent. Inbox and Manage Messages were not inspected.

## 6. Limits

- **UI** [ROOT-obs]: refreshing the legacy checkout-test page after the durable confirmed result shows its designed "Unexpected server status", while saying the server reports `confirmed`. That harness is authorization-only, so this is the expected harness contract, not a backend failure. No release, reset or payment action was taken. **A backend-confirmed booking is not a finished integrated guest UX.**
- **Stripe:** the fresh Stripe proof ran inside the runner before recording. There was no independent later Stripe dashboard END observation.
- **Historical objects:** no current provider state is inferred for them.

## 7. Residuals (owner / ROOT decisions; none authorized here)

**Money**
- Captured TEST funds (14000 minor), the active R71789623 (NEW / Paid), its paid offline charge 35735899 and the HELD claim all await a **separately reviewed manual disposition**.
- Nothing is cancelled or refunded, and no financial obligation is settled.

**Preserved untouched**
- The pending custom `guest.notify` `786805a2…` and the 2 unprocessed inbox rows: no drain, suppression or mark-complete.

**Unchanged elsewhere**
- Rule 511521 OFF. Protected reservations and historical intents (including the C77 target `954d476c…`) untouched.

**Closed or parked**
- All eight `executeEnabled` flags are false. C67 stays PARKED.
- Migrated listings are browse-only. Production and Airbnb are untouched.
- No further live action is authorized by this checkpoint.
