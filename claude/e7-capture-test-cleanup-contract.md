# Capture-TEST cleanup CONTRACT — rev2 (design only; NOT accepted for implementation)

Supersedes rev1 (PR #65) per ROOT review 5877971276. Scope unchanged: after ONE hosted TEST capture leaves an intent at `payment_captured`
(TEST Hostaway reservation + captured TEST charge), the smallest REVIEWED path that cancels THAT reservation, refunds THAT bound payment, and
leaves DB / claim / audit state honest. A dashboard refund alone is NOT closure. No captured TEST payment until this is implemented and reviewed.
No automatic chaining from the capture runner.

## 1. Source facts (tooling 40779e34) the design rests on
| Fact | Where |
|---|---|
| `payment_captured` admits only `PAYMENT_AUTHORIZED, CAPTURE_SUCCEEDED, OFFLINE_CHARGE_RECORDED, OFFLINE_CHARGE_FAILED, ESCALATE`; no refund event or state exists; `cancelled` is reachable only from `capture_failed` via two legs | `lib/checkout/intent-state.js` TRANSITIONS |
| Compensation worker is void-only ("never a refund"); captured PI → owner case `CAPTURED_WHILE_VOIDING`; its cancel leg (`PUT /reservations/{id}/statuses/cancelled`, executor `cancelReservation`) works `reservation_failed` / `capture_failed` only; compensation proofs are zero-money proofs — never valid on a refunded charge | `lib/booking-db/compensation-worker.js`, `lib/checkout/compensation-proof.js` |
| No refund executor phase, no `refunds.*` transport op; the capture runner's fence refuses `refunds.create` (test A6) | `scripts/e7-connected/executor-adapters.mjs`, `http-transports.mjs` |
| **Claim release**: `applyEvent` calls `release_claim_if_safe` only when the AFTER state is in `CLAIM_RELEASE_STATES` (`validation_failed, expired, payment_failed, payment_expired, authorization_released, cancelled`) and the state changed; the DB function re-checks `claim_release_blockers` — state releasable, no unresolved payment attempt, `authorization_blockers`, `reservation_blockers`, no `pending/in_flight/outcome_unknown/escalated` provider op (0017's ONE exception: a never-handed-out pristine capture row in state `cancelled`), no open case. It does NOT release on the first cancellation-leg event | `lib/booking-db/repo.js` (`CLAIM_RELEASE_STATES`, `releaseClaimIfSafe`), `db/migrations/0017_cancelled_pristine_capture_release.up.sql` |
| Recording rows: `0001` partial unique index (one active recording per intent); `0003/0005 resolve` settles a recording only with cited `hostaway_offline_charges` evidence after a 15-min settle period; `0011` owner cases | `db/migrations/0001, 0003, 0005, 0011` |
| Stripe Refund object: `status ∈ pending, requires_action, succeeded, failed, canceled`; created on a Charge or PaymentIntent; fields `id (re_…), amount, currency, charge, payment_intent, failure_reason`; **no `livemode` attribute**. Charge object: `refunded`, `amount_refunded` are AGGREGATES over all refunds | https://docs.stripe.com/api/refunds/object , https://docs.stripe.com/api/charges/object |

## 2. State machine (additions; each a separate reviewed change)
| From | Event (actor) | To | Fenced in-tx conditions | Patch / effects |
|---|---|---|---|---|
| `payment_captured` | `TEST_CLEANUP_REQUESTED` (owner; id `test-cleanup:{intent}:{pi}`) | `test_cleanup_pending` | version pinned; `payment.capturedMinor > 0`; ONE capture op `succeeded` with charge id; recording row PRISTINE (`pending`, attempts 0, never dispatched, no lease) — else `UNSUPPORTED_SHAPE` stop; no refund / cancel rows; no open case; claim held | recording row → `superseded` **in this same transaction** (retire ONLY the proven-pristine row; never a dispatched / unknown one); queue `hostaway.cancel_reservation` (attempt 1) and `stripe.refund_payment_intent` (attempt 1, payload §3); `capturedMinor` UNCHANGED; `cleanup: { cancelLeg: "open", refundLeg: "open" }`; NO notify effect |
| `test_cleanup_pending` | `RESERVATION_CANCELLED` (worker) | same | cancel row `succeeded` with confirming read evidence (status `cancelled`, full identity) | `cleanup.cancelLeg = "settled"` |
| `test_cleanup_pending` | `RESERVATION_CANCEL_OUTCOME_UNKNOWN` / `RECONCILED_RESERVATION_STILL_ACTIVE` | same / `reconciliation_required` | existing semantics (reads only; still-active → owner case) | — |
| `test_cleanup_pending` | `REFUND_SUCCEEDED` (worker) | same | refund row `succeeded`; bound refund proof §4 cited; `cancelLeg` may still be open | `payment.refund = { refundId, chargeId, amountMinor, currency }` (SEPARATE from `capturedMinor`, which is preserved); `cleanup.refundLeg = "settled"` |
| `test_cleanup_pending` | `REFUND_OUTCOME_UNKNOWN` | same | refund row `outcome_unknown` | reads only (§5) |
| `test_cleanup_pending` | `REFUND_FAILED` (`failed` / `canceled` / `requires_action` observed, or discovery not uniquely bound) | `reconciliation_required` | — | owner case `REFUND_NOT_PROVEN:{reason}`; no resend |
| `test_cleanup_pending` | `TEST_CLEANUP_COMPLETED` (worker, derived when BOTH legs settled) | `cancelled` (terminal; reasonCode `TEST_CLEANUP_REFUNDED`) | both legs `settled`; both rows `succeeded`; no other unresolved op | `applyEvent` → `release_claim_if_safe` (existing path; `cancelled` ∈ `CLAIM_RELEASE_STATES`) and the DB blockers must agree — the superseded recording row is not `pending/in_flight/outcome_unknown/escalated`, so no 0017-style exception is needed; **the claim is held until this transition** |
| any `test_cleanup_pending` | `ESCALATE` | `reconciliation_required` | existing | owner case |

Rules: `publicStatus` for `test_cleanup_pending` = `"processing"`, for the new terminal = `"not_completed_refunded"` (new string; the existing
`payment_captured → "confirmed"` alignment issue stays open and is NOT changed here). Zero notification templates / sends; `alert.owner` only on
owner cases. No raw-state repair; no widening of the live claim-release policy (no change to `claim_release_blockers` itself).

## 3. Ledger (new rows / columns; migrations are LOCAL candidates first)
| Item | Definition |
|---|---|
| op type `stripe.refund_payment_intent` | payload `{ paymentIntentId, chargeId, amountMinor, currency: "USD", attempt: 1, providerIdempotencyKey }`; key `rf:{intentId}:{pi}` (deterministic; one key family; never regenerated; attempt 2 is never created by any worker) |
| claim fence for it (like 0007 / 0009) | claimable only while the intent is `test_cleanup_pending`, `cleanup.refundLeg = "open"`, the row is `pending`/attempts 0/never dispatched, and NO other refund row exists for the intent (partial unique index on active refund rows per intent) |
| recording retirement | `UPDATE … SET state = 'superseded'` allowed ONLY by the `TEST_CLEANUP_REQUESTED` transition's SECURITY DEFINER path, ONLY when the row is pristine; trigger refuses any other writer (0003-style validity rule) |
| evidence kind `stripe_refund` | `external_ref = re_…`, `observed = { refundId, paymentIntentId, chargeId, amountMinor, currency, status, created, failureReason }`, `read_operation_id` → a `stripe.retrieve_refund` read row; plus the usual `payment_intent` v3 evidence (extended observation: `latestCharge.refunded`, `amountRefunded`, `refundIds[]` from `latest_charge.refunds` when expanded) |
| `payment.refund` JSON | `{ refundId, chargeId, amountMinor, currency, succeededAt }`; `capturedMinor` is never reset |

## 4. Proof (what alone may complete the refund leg)
A refund reply is NEVER proof. Completion requires, read AFTER the send in THIS step (fresh, ≤ 5 min, after dispatch):
1. **Bound refund READ** `GET /v1/refunds/{re_id}` (the id from the reply, or from discovery §5) persisted as `stripe_refund` evidence with: `object = "refund"`, `id = re_…`, `payment_intent = pinned PI`, `charge = pinned charge id` (= the capture op's `result_ref`), `amount = capturedMinor`, `currency = "usd"`, `status = "succeeded"`. Any other status (`pending`, `requires_action`, `failed`, `canceled`) is NOT success.
2. **Matching PI/charge READ** `GET /v1/payment_intents/{pi}?expand[]=latest_charge` (v3 proof): `livemode = false` on the PI and on `latest_charge`, `latest_charge.id = pinned charge`, `amount_received = capturedMinor`, `latest_charge.refunded = true`, `latest_charge.amount_refunded = capturedMinor`; aggregates are CONSISTENCY checks only, never identification.
3. **TEST / account context**: the account read (`object account`, exact `acct_…`) in this step; the transport's `sk_test_` credential scope (existing `KEY_NOT_TEST` rule); the PI / Charge `livemode === false`. Nothing is inferred from a `refund.livemode` field (it does not exist).
Pre-send refusals (read-only, before the claim): any existing refund on the charge (`latest_charge.refunds` non-empty or `amount_refunded > 0`),
`refunded = true`, a dispute, `amount_received ≠ capturedMinor`, charge id ≠ capture op `result_ref`, PI not `succeeded`, non-TEST → stop
`REFUND_PRECONDITION:{code}` (owner case, no POST). Partial / conflicting state is never "topped up".

## 5. Uncertainty (lost POST, pending, discovery)
- Lost / timed-out / 5xx / malformed reply → row `outcome_unknown` + `REFUND_OUTCOME_UNKNOWN`; the POST is NEVER resent (same or new key).
- Reconciliation = READS ONLY, ≥ dispatch + 2 min, bounded (accepted planner cadence): `GET /v1/refunds?payment_intent={pi}&limit=10`
  (+ the PI read). Success is claimed only if EXACTLY ONE refund exists for the PI and it is uniquely attributable to the pinned operation:
  `charge`, `amount`, `currency` match AND `created ≥ dispatched_at` AND `metadata.mv_refund_op = {opId}` (the POST carries this metadata so
  discovery can bind it). Zero refunds after the window → owner STOP `REFUND_NOT_FOUND` (never a resend). More than one, or one that does not
  bind → owner STOP `REFUND_AMBIGUOUS`. A `pending` refund keeps reading until the window ends, then owner STOP.
- A late reply is late evidence only (existing pattern).

## 6. Concurrency / fences (stop on any unsupported shape)
| Row / actor | Fence |
|---|---|
| recording row dispatched / in_flight / outcome_unknown / escalated / already succeeded | `TEST_CLEANUP_REQUESTED` refused (`RECORDING_NOT_PRISTINE`); the Hostaway offline charge must be reconciled by the existing recording path first |
| notification rows (any `guest.notify` queued) | refused (`NOTIFICATION_PRESENT`) — none is expected at `payment_captured`; nothing is sent or drained |
| capture row ≠ exactly one `succeeded` / pending second capture / capture_unknown history | refused (`CAPTURE_HISTORY_UNSUPPORTED`) |
| existing refund / cancel / void rows | refused (`CLEANUP_ROWS_PRESENT`) |
| concurrent workers | P3 session lock (5432, pid-stable) for the hosted runner; work lease (`intent_work`) + op lease + 0007/0009-style claim fences for the rows; `applyEvent` version fences; the capture / recording / compensation workers never claim `test_cleanup_pending` intents (their `WORK_STATES` exclude it) |
| protected reservation ids | refused everywhere |

## 7. Interface (hosted runner `e7-hosted-test-cleanup`, Slice-3 mirror of Slices 1–2; execution CLOSED by default)
Plan pins: approval ref, intent, expected version, not-before, PI, charge id, reservation id, `capturedMinor`, refund key, cancel key. Executor phase
`test-cleanup`: `retrieveAccount, retrievePaymentIntent, retrieveReservation, lookupPage, cancelReservation, createRefund(pi, {amount, metadata}, {idempotencyKey}),
retrieveRefund(re_id), listRefunds(pi)`. Transport fence: Hostaway GET + ONE `PUT …/statuses/cancelled`; Stripe GET account / PI / refund(s) + ONE
`POST /v1/refunds` with exact form body `payment_intent=…&amount=…&metadata[mv_refund_op]=…` and the pinned Idempotency-Key. Budgets: steps ≤ 6,
cancel 1, refund 1, PI reads ≤ 8, refund reads ≤ 8, Hostaway reads ≤ 12, run ≤ 10 min. Order: cancel leg before refund leg. Success output
`TEST_CLEANUP_COMPLETED` only after the residual read shows `cancelled` + claim released + both rows succeeded; otherwise facts reported.

## 8. Tests to deliver with the implementation (disposable PG + fake exchanges, real repo / workers)
1. Admission: pristine recording retired in the same tx; dispatched / unknown recording, notification, extra capture / refund / cancel rows → refused, nothing written.
2. Refund proof: bound read with every field → `REFUND_SUCCEEDED`; wrong charge / amount / PI / currency, status `pending|requires_action|failed|canceled`, aggregate-only evidence (`refunded=true` without a bound read) → never success.
3. Pre-existing / partial refund on the charge → `REFUND_PRECONDITION`, zero POSTs.
4. Lost POST → `outcome_unknown`, zero resend (same step, next step, second session); discovery: unique bound → settled; zero / multiple / unbound → owner STOP.
5. Claim: held after cancel-only and after refund-only; released only on `TEST_CLEANUP_COMPLETED` with `claim_release_blockers = {}`; `capturedMinor` unchanged and `payment.refund` recorded.
6. No `guest.notify` / `alert.owner` (except owner cases) rows; publicStatus mapping; protected ids; lock / stop / deadline / residual / unlock vetoes as in Slices 1–2.

Dependencies: §2 + §3 (state + ledger, offline) → §4/§5 proofs → §7 runner. Nothing here changes the merged capture runner.
