# Checkpoint C34 — FIRST hosted TEST offline-charge RECORDING trial: closure — PASS (`RECORDING_CONFIRMED`, ONE bookkeeping row) — 2026-11-13/14

Doc-only checkpoint from **closed main `8905d9d7ec07fb2492918ceb785e53c06b1a419b`** (tree `3ec2e196`, parents `b70258a7` enable + `ddc7e927` close; all five runner flags FALSE). Fills the C31 template (`checkpoint-c31-first-recording-trial-closure-TEMPLATE-2026-11-13.md`, now SUPERSEDED) with ROOT's END facts (durable reviews **5900896505** CLOSE verification, **5900942407** full END facts on #104). Attribution: `[Joel-authorized]` = owner standing authority; `[ROOT-obs <ISO>]` = ROOT's own observation; Claude performed no provider / shared-DB / run / browser inspection and infers nothing beyond these facts. Policy unchanged: refunds MANUAL and policy-assessed; cancellation ≠ payment disposition; no automated refund / cancel / void / cleanup / mirror / notification; **no later disposition action is authorized by this checkpoint.**

## 1. Authority and preparation
| | |
|---|---|
| owner authority | `[Joel-authorized 2026-11-13 ~20:20 CDMX]` standing instruction: ONE TEST bookkeeping trial for R71700931 and its captured USD 140.00 (= 14000 minor); merge reviewed #104, fresh proofs, ONE execute, close, document; D-a / D-b / D-c delegated to ROOT within this TEST scope; accepted end state (recorded TEST booking, no automated exit, ONE pristine queued notification, TWO unprocessed conflict-inbox rows, HELD claim); no notification or inbox processing; manual-refund policy preserved |
| proposal | `c27-first-hosted-test-recording-trial-proposal-2026-11-13.md` rev 2 (main `b2696a24`, review 5900228555 — proposal only) |
| enable | #104 head `8fa4658f` (review 5900368624) → **merged main `b70258a7933d11093718b6f3898aab25e45297f4`**, tree `48c12f5e`, GO review 5900825889; runtime = flag only; pin `4ed7a636`, closure `b02f0a76ae2347badc55ef2daaf27640f7ef80c01d7e69d1e9bdc7d8d38c4109`; recording runner digest `8296adaeec8389f013af539dbe7c7a203d8debb19f11854d31759be24bc60295` |
| close | #105 head `ddc7e927` = the reviewed 109-line CLOSE patch SHA-256 `24ee4ba5b7d1e393dec034c6e8f973f3e1b5849869aa71c7dcdcc791cddc8c47` (byte-identical, review 5900896505) → **merged after the completed run: main `8905d9d7`** |
| five digests at `8905d9d7` (ROOT re-derived; Claude re-derived identically) | reservation `5665544d…` · capture `5b547a42…` · test-cleanup `33f2ab18…` (unchanged) · recording `49b5516cb69543a6bd4a697a407d2f2a97a84e18a63f18715338f099917e4824` · recorded-cleanup `9e2021e3ec96bab16869fc194adac672287d559587b2cb7657738ffcd897de1f`; all `executeEnabled=false`; pins / closures unchanged; probe source digest `43715872…` unchanged |

## 2. Fresh proofs before GO `[ROOT-obs]`
| | |
|---|---|
| recording **preflight** | run `43546328149` / job `132298413350` PASS 23/23 at 2026-11-14T02:26:52.721Z; `planHash b4ebd222eeb667d1b91fa91e15f9119371621678de8c1cfbbf43c3452511b6a0` (independently recalculated, MATCH); closure `b02f0a76…c4109`; runner `8296adae…0295`; `approvalRef ROOT-C33-JOEL-20261114-RECORD71700931`; `expectedVersion 8`; `notBefore 2026-11-13T20:26:56.489Z` (= createdAt 20:27:56.489 − 1 min); other bound inputs = the known target ids / stay / attempt / session; no new checkout |
| **DB baseline** C3-A v2 (pure SELECT) | 02:30:56.404Z: 22 child tables, catalog matches; exact 8-id intent set (same existing 8; no discovery / new id); target `payment_captured` v8, recording op pending / 0 / never dispatched, claim HELD; all 8 full-row + 22 child fps and globals unchanged vs the first read 02:23:38.289Z; leases / work / op / in-flight / locks / prepared / open cases = 0; migrations 21/1/21, vocab 2 |
| contact check | private ROOT check: owner-name / email **labels** suitable; no actual contacts disclosed; **no claim about Hostaway alert behaviour** |
| **Stripe RAW before** | read-only Workbench `GET payment_intents retrieve` (expand `latest_charge`) 02:25:54.282Z: PI `succeeded`, amount 14000, received 14000, capturable 0, manual capture, USD, livemode false; charge `ch_3UbR9W…1foeKLft` captured true, amount captured 14000, refunded false, amount refunded 0, disputed false. Full raw response NOT saved / shared (contains client secret / contact); only allowed fields recorded. Stored payment evidence: no refund observations (absence noted as not fresh proof — the fresh read above is the proof) |
| **Hostaway fresh read** (C25 probe, main `b70258a7`) | run `43546414991`: preflight job `132298688446` 12/12, source digest `43715872…` MATCH; normal gate ROOT-approved ~02:28Z, no bypass; probe job `132298800356` SUCCESS 02:28:54.408Z: `e7-charge-list-probe-result-v2 stop=- outcome=SHAPE_COMPATIBLE calls=2 urls=[GET /v1/reservations/71700931, GET /v1/guestPayments/charges?limit=500&reservationIds=71700931] identity=200/success/ok status=new currency=USD list=200/success/ok count=0 types=[] matching=0 unknown=0 offset=null limit=absent elapsedMs=793` |

## 3. The ONE execute `[ROOT-obs]`
| | |
|---|---|
| GO | execution GO review **5900902940** |
| dispatch | run **`43546826686`** / job `132299998749`, `E7_RUN_ID 43546826686-1`, submitted ONCE; normal `e7-readonly-probe` gate ROOT-approved ~02:34Z under Joel's standing authority, no bypass |
| verify | `VERIFY_OK` 02:34:18.479Z — exact main / pin / plan / closure / runner |
| execute | `EXECUTE_DONE` 02:34:24.986Z **`RECORDING_CONFIRMED`**, code null; `payment_captured` v8 → **`confirmed` v9**, `publicStatus confirmed`; R71700931 `offlineChargeId 35684256`, `capturedMinor 14000` |
| steps / actions | steps 1; `READ:ID:OK, READ:LIST:OK, ASSESSED:eligible, CLAIMED, COMPLETED, RECORDED->confirmed`; recordInvocations 1 / `REPLIED`; exchanges 7, hostawayReads 2, chargeLists 4, dbQueries 147 TOTAL incl. dbTeardownQueries 15; lock released |
| proofs | `PROVIDER_BEFORE_WORKER`, `BEFORE_WORKER`, `BEFORE_READBACK`, `READBACK` all passed; postcheck recordingOps 1, notifyQueuedPristine 1, claimHeld true, holds 0, openCases 0 |
| writes | record **1**; capture / create / cancel / refund / notify / void / stripe **all 0**; **no rerun** |

## 4. END state `[ROOT-obs]`
| where | observed |
|---|---|
| **END C3-A** 02:35:05.244Z | exact 8 ids unchanged; **ALL 7 foreign intents** full-row + 22 child fps **byte-identical** to baseline; **ALL global fps identical** (incl. `api_rate_limits`); migrations 1..21 / vocab 2 unchanged; leases / work / op / in-flight / locks / prepared / open cases = 0 |
| target `booking.intents` | `confirmed` v9, `offline_charge_id 35684256` |
| target `external_operations` | 12 → 16: + `hostaway.retrieve_reservation` succeeded/1, + `hostaway.list_offline_charges` ×2 succeeded/1, + **`guest.notify` pending / 0 / undispatched (PRISTINE)**; original `hostaway.record_offline_charge` pending → **succeeded / 1**, dispatched 02:34:22.780Z, completed 02:34:24.274Z, `result_ref 35684256`, key `och:abede8b1-8ef6-44f2-876e-6a02fc056a96:1`; the old 11 ops unchanged |
| `provider_evidence` | 8 → 11: + `hostaway_reservation found_active` 02:34:22.235Z (status `new`, listing 606998, channel 2000, stay 2026-11-23 → 24, USD 14000, ref `MV-8L79DEJ7`); + list `count 0` 02:34:22.714Z; + confirming list 02:34:24.222Z (type `charge` / `paid` / `offline` / `credit_card` / USD 14000 / id `35684256` / exact marker title / matching 1 / `[35684256]`) |
| `recording_assessments` / `recording_claim_assessments` | 0 → 1 / 0 → 1 |
| `recording_conflict_inbox` | 0 → **2, BOTH `processed_at` NULL** (no processing authority) |
| `intent_transitions` / `intent_applied_events` / `payment_ledger` | 9 → 10 / 7 → 8 / 2 → 3 (`authorization_accepted`, `capture_succeeded`, `offline_charge_recorded`) |
| `intent_work` | 1 row changed; lease NULL at END |
| `inventory_claims` | whole-row fp **UNCHANGED — HELD** |
| refunds / cases / `notification_*` / webhook / guest / payment_attempts | unchanged |
| detailed SELECT 02:36:04.582Z | reconfirms ops / evidence / ledger / inbox 2 unprocessed / claim held |
| Hostaway | runner's own final provider readback PASS at END; **no extra POST**; the worker's confirming LIST and the runner's final readback are the LIVE provider proof. Dashboard END read hit login — **no dashboard observation / login / credential attempted**; no claim about dashboard balance / calendar / alert absence |
| **Stripe RAW END** 02:35:42.491Z | same read-only GET: same PI / charge / amount / currency / manual / TEST / `succeeded` / received 14000 / capturable 0 / captured true / amount captured 14000 / refunded false / amount refunded 0 / disputed false — numeric / state comparison MATCHES BEFORE; **no Stripe write** |
| old intent `c83c1842…` / its claim | DB fps unchanged; no fresh old-PI / R / protected provider-wide query — **no new claim about their current provider state** |

## 5. Outcome
**ONE live TEST bookkeeping recording validated:** the accepted create path (five-field `POST /v1/guestPayments/charges/71700931`), the create reply and the confirming LIST behaved as the accepted proofs expect for THIS account / listing / reservation (amount units, reply shape and non-empty row shape now live-observed once — for this case only; no general or production claim). The intent is `confirmed` v9 with the linked offline charge `35684256`, ONE new `offline_charge_recorded` ledger entry, ONE pristine queued `guest.notify`, TWO unprocessed conflict-inbox rows, and the inventory claim still HELD.
**Pending by design (no action authorized here):** the captured TEST funds (USD 140.00 = 14000 minor), the active R71700931, the Hostaway `paid` row `35684256` and the HELD claim await **separate, manual, policy-assessed disposition**; no financial obligation is settled; no refund / cancel / void / cleanup / notify / mirror action was executed or enabled by this trial. Cancellation and payment remain independent decisions.

## 6. Closure
- [x] §2–§4 filled verbatim from ROOT's END facts (reviews 5900896505 / 5900942407); nothing inferred
- [x] CLOSE merged after the completed run; five flags FALSE; five digests re-derived at `8905d9d7` (ROOT and Claude, identical)
- [x] C31 template marked SUPERSEDED by this checkpoint (project)
- [ ] any later disposition / reconciliation step = a separate, specifically reviewed ROOT task from fresh observations
