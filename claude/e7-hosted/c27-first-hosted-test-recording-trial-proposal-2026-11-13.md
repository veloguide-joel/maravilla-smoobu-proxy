# C27 — Proposal: FIRST hosted TEST offline-charge RECORDING validation (bounded trial) — source-only, 2026-11-13

Claude executor · OFFLINE, doc-only, from closed main `bd5e2f0c` (all five runner flags FALSE; runtime tooling pin `4ed7a636`). **This is a reviewable proposal, not an enable PR and not execution authority.** Nothing here was run; no provider / shared DB / dashboard / run was inspected; both TEST intents, their claims and provider objects are untouched. Refunds are MANUAL and policy-assessed; recording / notification / cleanup remain HELD until an owner decision.

## 0. Decision table (what this proposal asks ROOT / Joel to decide; nothing is pre-decided)
| # | Decision | Owner | Default if undecided |
|---|---|---|---|
| D-a | Is a ONE-recording bounded trial on the existing captured TEST intent acceptable under current policy, knowing the recorded state has **no automated exit** (§2)? | Joel (policy) | HELD — nothing runs |
| D-b | Accept the live-unverified create-path assumptions (§5) as the explicit object of the trial (the trial *is* the test of those shapes, fail-closed)? | ROOT + Joel | HELD |
| D-c | Who performs the eventual **manual** disposition of the captured USD 140.00 (= 14000 minor) and of the Hostaway `paid` bookkeeping row, and how it is observed in the DB (C14 §2.1 rows, owner-attested)? | Joel | funds stay captured; reservation active; claim HELD |
| D-d | Open the flag (recording `executeEnabled: true`) by a separately reviewed flag-only PR, run ONCE under the existing gate, then close by a second flag-only PR (§3)? | ROOT (review) → Joel (gate approval) | FALSE |

## 1. D4 status — does the current residual condition allow a bounded trial?
- D4's two original conditions are **met** (C7 §0, merged evidence): (1) recorded-state cleanup contract implemented (0021 + mirror worker + Slice 5 runner, all CLOSED), (2) shared DEV schema = exactly 0001..0021 (ROOT SELECT 2026-11-13 20:24:20Z; never re-applied / rolled back). These are **not** reopened or treated as unresolved here.
- The condition that **replaced D4's exit path** is a business-policy fact, still in force: **no automated refunds, not even TEST** → the only coded exit from `confirmed` (`TEST_CLEANUP_REQUESTED_RECORDED` → Slice 5 cancel + Stripe refund + mirror) is HELD. A recorded TEST intent therefore has **no automated exit**; its disposition is manual, and the DB observes it only through owner-attested evidence rows (C14/C15), never through an inferred ledger entry.
- **Conclusion:** a bounded trial is technically permitted by the accepted runner (every gate stays), but it **requires a genuinely new owner decision (D-a / D-c)**, because its end state is a `confirmed` TEST booking with captured funds and a `paid` Hostaway bookkeeping row that only manual, policy-assessed action can dispose of. This proposal does **not** lift the manual-refund HOLD or any of the Slice 3 / 5 holds; it adds a second TEST artefact that will need the same manual disposition path as today's captured intent.

## 2. Target (facts as last recorded; **ROOT must independently refresh every one before any step**)
| | last recorded (C3 closure / C12 / C20) | required fresh proof before the trial (ROOT only; no Claude action) |
|---|---|---|
| intent | `abede8b1-8ef6-44f2-876e-6a02fc056a96`, ref `MV-8L79DEJ7`, `payment_captured` **v8**, recording op `och:<intent>:1` `pending` / 0 attempts / never dispatched, ONE claim HELD on 606998 `[2026-11-23, 2026-11-24)` | ROOT-only pure-SELECT baseline (C3-A snapshot v2): `child_catalog_matches = true` (22 child tables), full `intent_ids` set, every foreign intent's `row_fp` + 22 child fingerprints, target `row_fp`, state `payment_captured` v8, op pristine, `expectedVersion = 8` |
| Stripe TEST | PI `pi_3UbR9W2B9LTneQgw1sqmnm3K`, charge `ch_3UbR9W2B9LTneQgw1foeKLft`, USD 14000 captured (C3 closure 20:57:10Z) | fresh **raw** read: PI `succeeded`, `amount_received 14000`, `amount_capturable 0`, charge `captured true`, `refunded false`, `amount_refunded 0`; **no conflicting stored observation** for this PI (`provider_evidence`). The wrapper's stored-refund veto (`PAYMENT_REFUND_OBSERVED`, C16) is a defence-in-depth stop on stored rows — it is **not** fresh affirmative Stripe proof and does not substitute for this read |
| Hostaway | R `71700931` status `new`, listing 606998, 2026-11-23 → 24, totalPrice 140, ref field 105433 = `MV-8L79DEJ7` (C20 identity read 23:20Z); charge list `count 0` at 23:20Z | fresh identity: `new`, same binding; fresh LIST: **no marker, no look-alike, no same-amount-paid** row for R (C20 was a point-in-time observation, not historical absence); the C25 probe at 4ed7a636 (manual gate, read-only) can supply both reads if ROOT dispatches it |
| binding | — | preflight → `planHash` over exactly these inputs; `expected_plan_hash`, `expected_closure_digest`, `expected_runner_digest`, main SHA and the pinned tooling ref all bound to the SAME inputs at dispatch (verify step refuses otherwise) |

## 3. Exact current pins / closures / digests and the flag-only diff (NOT implemented here)
| | value at main `bd5e2f0c` |
|---|---|
| recording runner | `scripts/e7-hosted-recording.mjs` `toolingCommit 4ed7a636fee57981262b9c02574190d225b8a1fc` (C24), `closureDigest b02f0a76ae2347badc55ef2daaf27640f7ef80c01d7e69d1e9bdc7d8d38c4109` (30 paths), `pgVersion 8.18.0`, `executeEnabled: false`, budgets `{ steps 6, record 1, hostawayReads 9, chargeLists 12, exchanges 24, dbQueries 600, runMs 600000 }` |
| recording runner digest | `800002531edcc2be14569830eb0e664c19884512aa0b015fd7ceb4f8c9acf561` (runner + reservation runner + workflow + test) |
| other four runners | reservation `5665544d…` @40779e34 · capture `5b547a42…` @59178b04 · test-cleanup `33f2ab18…` @9d86bfa1 · recorded-cleanup `e9011de7…` @e41b654a — all `executeEnabled=false`, untouched by this proposal |
| gate | `.github/workflows/e7-hosted-recording.yml`: `workflow_dispatch` only; `mode: execute` requires `github.ref == refs/heads/main` + `environment: e7-readonly-probe` (required reviewer, admin bypass OFF — C5); secrets `E7_HOSTAWAY_TOKEN` + `E7_DEV_BOOKING_DATABASE_URL` in the execute step only; no Stripe key; one Hostaway POST budget |
| **proposed enable diff (flag-only, separate reviewed PR, NOT here)** | `scripts/e7-hosted-recording.mjs`: `executeEnabled: false` → `true` (one token) + header comment; **nothing else** — no pin, closure, budget, grammar, workflow or test change beyond the C1-style assertion `assert.equal(C.executeEnabled, true)` for that PR only. Runner digest changes (recomputed and bound as `expected_runner_digest`). |
| **proposed close diff** | the reverse one-token change immediately after the single run (as C4/C6 did for Slices 1–3), restoring `executeEnabled: false`; digest re-derived; checkpoint doc |

## 4. The ONE run (existing runner, existing workflow; nothing new)
1. **Preflight** (`mode: preflight`, no secrets) with the thirteen real inputs → REAL plan, `planHash`, closure + runner digests printed; fake tests pass in the child; ROOT records the values.
2. **Execute** (`mode: execute`, main only, gate approval by Joel): `verify` re-checks pins / digests / inputs / `HRC_EXECUTE_CLOSED` (must now be open) → `npm ci` (lockfile) → CA fetch (pinned SHA) → `execute`: session lock (5432 advisory), START facts (state `payment_captured` v8, op pristine, no open case, **stored-refund veto**: newest `payment_intent` evidence for the PI must not show a refund), identity read (`new`, binding), LIST read (complete page, zero marker / look-alike / same-amount), eligibility → **exactly ONE** `POST /v1/guestPayments/charges/71700931` with the existing five-field body `{ title: "maraVilla payment mvoch1-abede8b1-…", amount: 140, paymentMethod: "credit_card", status: "paid", scheduledDate: "<capture instant UTC>" }` → reply CANDIDATE (insufficient alone) → **confirming LIST read** (exactly one exact-title row == the reply id, `offline`, `paid`, 14000) → `completeRecordingWithEvidence` (0010/0012 fences) → `OFFLINE_CHARGE_RECORDED` → `confirmed` → **final postcheck** (state / version / `offline_charge_id` link / ledger `offline_charge_recorded` / ONE `guest.notify` row `pending`, 0 attempts, never dispatched / claim HELD / no open case / lock released) + **final charge-list readback** (ROOT 5883758657 F1).
3. **STOP.** Success ends at `confirmed`. No notification transport exists or is permitted; no refund / cancel / void / mirror / cleanup step exists in this run; the claim stays HELD; funds stay captured awaiting Joel's manual, policy-assessed disposition.

## 5. Assumptions that stay LIVE-UNVERIFIED until this run (the run is their test; every one is fail-closed)
- `amount` **units** on `POST` and in the create reply (accepted: major units, ≤ 2 decimals; docs silent — C21/C22). A unit surprise refuses at `REPLY_AMOUNT` / `CONFIRM_AMOUNT_MISMATCH` and the recording is `WRITE_OUTCOME_UNKNOWN` / held — **no retry**.
- `POST /v1/guestPayments/charges/{reservationId}` acceptance on a **Draft, unmapped listing** with `paymentMethod credit_card` (documented list; never sent on this account).
- Create-reply **HTTP status** (accepted 200/201; docs state no code) and reply shape (documented example matched offline only, C21 D3).
- Non-empty LIST row shapes (only the EMPTY envelope is live-proven, C20); a documented null-provider row is admitted since C24/C25 — reported `UNKNOWN`, never inferred `offline`.
No synthetic claim is made that any of these is proven; a green run would prove them for THIS account / listing / reservation only.

## 6. Accepted deltas if the run succeeds (and nothing else)
| where | exact delta | everything else |
|---|---|---|
| `booking.intents` (target only) | `payment_captured` v8 → **`confirmed` v9**, `offline_charge_id` = the provider charge id | every foreign intent `row_fp` and all 22 child fingerprints byte-identical (C3-A END snapshot); `intent_ids` set unchanged |
| `booking.external_operations` (target) | recording op `och:<intent>:1`: `pending` → **`succeeded`**, attempts 1, dispatched/completed, `result_ref` = charge id; **ONE new `guest.notify` row** (`booking_confirmed`) `pending` / 0 / never dispatched — **QUEUED PRISTINE** | no other op created or changed |
| `booking.payment_ledger` / transitions / evidence | ONE `offline_charge_recorded` entry; transition `payment_captured → confirmed`; `provider_evidence` rows for the reads (`hostaway_reservation`, `hostaway_offline_charges`) + the 0010 recording evidence link | no refund / void / mirror / cleanup row |
| `booking.inventory_claims` | **unchanged** (HELD, not released) | — |
| Hostaway | **ONE** offline charge row on R71700931 (`charge`, `paid`, `offline`, `credit_card`, 140 USD, exact title); reservation **unchanged** (`new`, not cancelled) | no cancel / PUT / refund |
| Stripe | **nothing** (no call is made) | PI stays `succeeded`, charge captured, `refunded false` |
Non-success outcomes write less: `PROVIDER_PROOF_FAILED` / `START_*` / `SCOPE_REFUSED` → zero writes; `RECORDING_HELD` → hold + owner case, zero provider writes; `WRITE_OUTCOME_UNKNOWN` → op `outcome_unknown` + ONE open case, intent still `payment_captured`, at most one charge may exist at the provider.

## 7. Class-E handling (possibly-sent write without an admissible reply) and read-only reconciliation
- The runner **never resends** (`record: 1`; a second admission refuses `RECORDING_OUTCOME_UNKNOWN_REQUIRES_REVIEW` / `OPEN_CASE`). There is **no universal retry, no DB repair, no claim release, no inferred manual-disposition ledger**.
- Reconciliation is **identity-specific and READ-ONLY**: a ROOT-dispatched read-only LIST for R71700931 (the C25 probe under its own gate, or the recording runner's own evidence reads) establishes whether exactly one marker row exists; the outcome is then resolved by a **specifically reviewed owner action** (existing `admin_resolve_*` / owner-case path with attested evidence, C14 §2.1) — not by code in this proposal.
- Cancellation and payment stay independent: a Hostaway cancellation (if the owner ever does one) is an A-type observation; the captured payment's disposition is a separate C-type decision; neither is inferred from the other.

## 8. Residual owner decisions / unknowns (named, not resolved here)
- Whether Hostaway auto-changes `new` on a Draft listing after N days (identity read would then refuse — safe, but the trial window matters).
- Whether Hostaway generates guest-facing alerts/messages when an offline charge is added (R6 in C7; never observed; a TEST reservation carries a synthetic `.invalid` guest).
- The manual disposition path for the captured USD 140.00 and the Hostaway `paid` row after the trial (Stripe refund / Hostaway refund-row / reservation cancel are each separate owner actions, each observed via C14/C15 rows; none automated).
- `paymentMethod "credit_card"` and `accountRef "hostaway-e7-test"` are TEST labels; any production use is a separate owner configuration decision.
- Close-flag checkpoint steps after the run: close-flag PR (one token back), five digests re-derived, C3-A END snapshot by ROOT (foreign set identical; target deltas exactly §6), checkpoint doc from ROOT's readback, skeleton-then-final as in C20.

## 9. Sources
C7 `c7-d4-residual-blocker-map` (D4 status, R1–R6) · C3 packet + closure (`c3-fresh-test-capture-validation-packet-v1`, `checkpoint-c3-…-closure`: snapshot v2, 22 child tables, 16/16 isolation controls, target facts) · C12/C20 live observations (`checkpoint-c20-…-main-6e0b008d`) · C14/C15 (`c14-manual-disposition-observation-contract-review` rev2: owner-attested observation rows, blockers, no ESCALATE as observation) · C16 veto (`c16-recording-refund-observation-veto-scope-note`) · C21/C22 doc audit (`c21-hostaway-charge-contract-doc-audit`) · C24/C25 pins (PRs #100 / #101) · runner `scripts/e7-hosted-recording.mjs` (CONSTANTS, budgets, codes) and workflow `e7-hosted-recording.yml` at main `bd5e2f0c`.
