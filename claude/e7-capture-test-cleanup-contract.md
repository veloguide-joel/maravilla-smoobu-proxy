# Capture-TEST cleanup CONTRACT — rev3 (design; implementation FOUNDATION offered separately as a DRAFT PR from e7-test 40779e34)

Supersedes rev1 (PR #65) per ROOT review 5877971276 and rev2 per ROOT review 5878146178 (F1: the claim-release path). Scope unchanged: after ONE hosted TEST capture leaves an intent at `payment_captured`
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
| **F1 (ROOT 5878146178)**: `booking.authorization_blockers` (0003:146–165, no later override) settles a PI ONLY through an `authorization_voided` ledger entry or latest PI evidence `canceled` / `requires_payment_method`. A fully refunded CAPTURED PI stays `succeeded` → `AUTHORIZATION_UNSETTLED:<pi>` forever; rev2's §2/§8 completion was impossible as written. Reproduced RED on the unchanged 0018 schema (foundation PR test R0) | `db/migrations/0003_safety_corrections.up.sql` |
| **Existing refund ledger**: `booking.payment_refunds` (0001) — `seq`, `idempotency_key` CHECK `ref:<intent>:<seq>`, `stripe_refund_id` UNIQUE, `amount_minor`, `currency`, `reason_code`, `requested_by admin|system`, `state requested|in_flight|succeeded|failed|outcome_unknown`, `hostaway_state pending|recorded|failed|outcome_unknown`, guard: sum of non-failed refunds ≤ `intents.captured_minor`, same currency, intent row locked; `payment_ledger.entry` already admits `refund_succeeded` / `refund_failed`; 0016 notification fence refuses any intent with a refund row | `db/migrations/0001_booking_core.up.sql:478–531`, `0016_guest_notification_fence.up.sql:318` |
| Recording rows: `0001` partial unique index (one active recording per intent); `0003/0005 resolve` settles a recording only with cited `hostaway_offline_charges` evidence after a 15-min settle period; `0011` owner cases | `db/migrations/0001, 0003, 0005, 0011` |
| Stripe Refund object: `status ∈ pending, requires_action, succeeded, failed, canceled`; created on a Charge or PaymentIntent; fields `id (re_…), amount, currency, charge, payment_intent, failure_reason`; **no `livemode` attribute**. Charge object: `refunded`, `amount_refunded` are AGGREGATES over all refunds | https://docs.stripe.com/api/refunds/object , https://docs.stripe.com/api/charges/object |

## 2. State machine (additions; implemented in the foundation DRAFT PR, test-first)
| From | Event (actor) | To | Fenced in-tx conditions | Patch / effects |
|---|---|---|---|---|
| `payment_captured` | `TEST_CLEANUP_REQUESTED` (operator; id `test-cleanup:{intent}:{pi}:{rid}`; `lib/booking-db/test-cleanup.js requestTestCleanup`, gate `MV_E7_TEST_CLEANUP=enabled` + dev/preview, listing 606998/USD, 17-key bound expectation) | `test_cleanup_pending` | TEST instance + TEST intent (0019 guard `TEST_CLEANUP_NOT_TEST`); version pinned; `capturedMinor = finalTotalMinor > 0`; ONE capture op `succeeded`, attempt 1, exact amount, `result_ref` = the bound charge id; recording row PRISTINE (`pending`, attempts 0, never dispatched, unleased) — else `TEST_CLEANUP_RECORDING_NOT_PRISTINE`; no void / refund / cancel / notification rows; no open case; claim held; capture ledgered | **same transaction**: recording row → `superseded` (0019 `recording_retirement_fence`: only this shape, only now); `payment_refunds` row seq 1 created (`ref:<intent>:1`, `requested`, `reason_code TEST_CLEANUP`, `requested_by admin`, `hostaway_state not_applicable` — no Hostaway payment record ever existed); queue `hostaway.cancel_reservation` (attempt 1) + `stripe.refund_payment_intent` (attempt 1, payload §3); `settlement = {reservationCancelled:false, authorizationSettled:false}` (the existing two-leg flags); `capturedMinor` UNCHANGED; **nothing** queued for notification |
| `test_cleanup_pending` | `RESERVATION_CANCELLED` (worker) | same | existing guard: cancel row `succeeded` + `hostaway_reservation` evidence `cancelled` for the bound id (0009 fence extended so the cancel row is claimable in this state) | `settlement.reservationCancelled = true` |
| `test_cleanup_pending` | `RESERVATION_CANCEL_OUTCOME_UNKNOWN` / `RECONCILED_RESERVATION_STILL_ACTIVE` | same / `reconciliation_required` | existing semantics (reads only; still-active → owner case) | — |
| `test_cleanup_pending` | `REFUND_SUCCEEDED` (worker; `{refundId, chargeId, amountMinor = capturedMinor, currency}`) | same | repo guard: the ONE refund row `succeeded` with `result_ref = refundId` (`REFUND_NOT_VERIFIED`); DB guard (0019): `booking.test_refund_settled_for(intent, pi)` must be true when the flag is set (`AUTHORIZATION_NOT_VERIFIED_SETTLED`) — §4 | `settlement.authorizationSettled = true`; `payment_refunds` → `succeeded` + `stripe_refund_id`; ledger `refund_succeeded` (amount = captured, provider_ref = refund id); `capturedMinor` preserved |
| `test_cleanup_pending` | `REFUND_OUTCOME_UNKNOWN` | same | refund row `outcome_unknown` | `payment_refunds` → `outcome_unknown`; ONE PI read queued; reads only (§5); the row is never claimable again (0019 fence + `one_refund_ever`) |
| `test_cleanup_pending` | `REFUND_FAILED` (`failed` / `canceled` / `requires_action` observed, or discovery not uniquely bound) | `reconciliation_required` | — | owner case `REFUND_NOT_PROVEN`; `payment_refunds` stays `outcome_unknown` (the provider-proven money fact is the owner's to settle with evidence); no resend |
| `test_cleanup_pending` | second leg event (whichever lands last) | `cancelled` (terminal; `reasonCode TEST_CLEANUP_REQUESTED`, `publicStatus "not_completed_refunded"`) | 0019 guard: both flags true AND `test_refund_settled_for` re-verified at this instant (`CANCELLATION_NOT_VERIFIED`) | `applyEvent` → `release_claim_if_safe` (existing path) → `claim_release_blockers` → `authorization_blockers` **with the ONE 0019 exception** `CONTINUE WHEN booking.test_refund_ledgered(intent, pi)` (settled §4 AND `payment_refunds` seq 1 `succeeded` with that refund id, exact amount, currency, `TEST_CLEANUP`, `not_applicable` AND ledger `refund_succeeded` for that id). No void entry, no canceled evidence, no zeroed amount, no bypass — **the claim is held until this transition and released only if every blocker agrees** |
| any `test_cleanup_pending` | `ESCALATE` | `reconciliation_required` | existing | owner case |

Rules: `publicStatus` for `test_cleanup_pending` = `"processing"`, for the cleanup terminal = `"not_completed_refunded"` (the existing
`payment_captured → "confirmed"` alignment issue stays open and is NOT changed here). Zero notification templates / sends (the request queues no
`alert.owner` either); owner cases only on `REFUND_FAILED` / `ESCALATE`. No raw-state repair. `claim_release_blockers` itself changes only by
listing the refund write among unresolved provider operations; `authorization_settled_for` (void path) and every non-TEST / void / capture_failed
behaviour are unchanged (foundation test Q7 re-runs the 0017 P-class precedent).

## 3. Ledger (new rows / columns; migrations are LOCAL candidates first)
| Item | Definition |
|---|---|
| op type `stripe.refund_payment_intent` (0019) | `retry_class reconcile_first`, `max_attempts 1`; payload `{ paymentIntentId, chargeId, amountMinor, currency, attempt: 1, providerIdempotencyKey }`; row key `refund:{intent}:1`; **provider Idempotency-Key = `ref:{intent}:1` = `payment_refunds.idempotency_key`** (ONE identity for the audited record, the row and the Stripe request; the rev2 `rf:` family is dropped); `one_open_provider_write` extended; `one_refund_ever` unique index: at most ONE refund row per intent in ANY state (attempt 2 never exists; no same-key or new-key resend) |
| `payment_refunds` mapping (existing table) | seq 1 only; `reason_code TEST_CLEANUP`; `requested_by admin` (operator action); `state` follows the row (`requested` → `succeeded` + `stripe_refund_id` / `outcome_unknown`); `hostaway_state = 'not_applicable'` (new CHECK value: the pristine recording was retired, so no Hostaway payment record exists to refund; `hostaway_refund_ref` null); the 0001 guard (≤ captured, same currency) stays authoritative |
| claim fence `refund_claim_fence` (0019, 0007 pattern) | `pending → in_flight` only while the intent is `test_cleanup_pending`, `settlement_authorization_settled IS FALSE`, TEST instance + intent, payload attempt 1; the JS claim SQL mirrors it (`REFUND_FENCE`) |
| recording retirement fence (0019 `zy_recording_retirement_fence`) | a recording row becomes `superseded` ONLY from `pending` / attempts 0 / never dispatched / unleased, ONLY while the intent is `test_cleanup_pending` on a TEST instance (= the `TEST_CLEANUP_REQUESTED` transaction, whose repo UPDATE must match exactly one row); 0010's lifecycle guard still forbids every other field change |
| evidence kind `stripe_refund` (0019) | API source only (`record_provider_evidence` with a `stripe.retrieve_refund` read whose payload `refundId` = `external_ref`; `admin_record_evidence` is deliberately NOT extended — a dashboard refund is not closure); `status ∈ pending|requires_action|succeeded|failed|canceled`; `observed` must carry `refundId, paymentIntentId, chargeId, amountMinor (>0), currency`; plus the accepted v3 `payment_intent` evidence (`latestCharge.amountRefundedMinor` is Charge.amount_refunded) |
| intent columns | **none added**: the two legs reuse `settlement_reservation_cancelled` / `settlement_authorization_settled`; the refund identity / amount live in `payment_refunds` + the refund row + the ledger; `captured_minor` is never reset |

## 4. Proof (what alone may complete the refund leg) — `booking.test_refund_settled_for(intent, pi)` (0019), evaluated by the DB guard
A refund reply is NEVER proof. Completion requires, read AFTER the send in THIS step (fresh, ≤ 5 min, after dispatch):
0. **Scope**: `booking.instance.environment = 'test'` AND `intents.environment = 'test'` AND the ONE completed payment attempt for the PI has `livemode = false`; `captured_minor > 0`; ONE capture row `succeeded`, attempt 1, exact amount, `result_ref` = a charge id; ONE refund row `succeeded`, dispatched, payload bound to PI / that charge / exact amount / currency / attempt 1 / key `ref:<intent>:1`, `result_ref = re_…`.
1. **Bound refund READ** `GET /v1/refunds/{re_id}` persisted as `stripe_refund` evidence (API, observed AFTER the refund dispatch) with: `refundId` = the row's `result_ref`, `paymentIntentId` = PI, `chargeId` = the capture charge, `amountMinor = captured_minor`, `currency` = intent currency, `status = succeeded`. Any other status is NOT success; a LATER non-succeeded read of the same id contradicts (a refund can fail after pending) and un-settles.
2. **Matching PI READ** (the accepted v3 observation, API, observed AFTER the dispatch, the LATEST for the PI): `status succeeded`, `livemode false`, `latestCharge.id` = that charge, `latestCharge.captured true`, `amountReceivedMinor = latestCharge.amountCapturedMinor = captured_minor`, `latestCharge.amountRefundedMinor = captured_minor` (full), `latestCharge.livemode false`, `latestCharge.refunded` true when present. Aggregates are CONSISTENCY checks only, never identification.
3. **TEST / account context**: no `refund.livemode` (the field does not exist); TEST-ness = instance + intent + payment-attempt livemode + PI/Charge livemode in the evidence + (runner side) the verified account read and the `sk_test_` credential scope.
4. **Release** additionally needs `booking.test_refund_ledgered`: the `payment_refunds` seq-1 record `succeeded` with that refund id, exact amount, currency, `TEST_CLEANUP`, `not_applicable`, AND the ledger `refund_succeeded` entry for that id and amount.
Pre-send refusals (read-only, before the claim): any existing refund on the charge (`latest_charge.refunds` non-empty or `amount_refunded > 0`),
`refunded = true`, a dispute, `amount_received ≠ capturedMinor`, charge id ≠ capture op `result_ref`, PI not `succeeded`, non-TEST → stop
`REFUND_PRECONDITION:{code}` (owner case, no POST). Partial / conflicting state is never "topped up".

## 5. Uncertainty (lost POST, pending, discovery)
- Lost / timed-out / 5xx / malformed reply → row `outcome_unknown` + `REFUND_OUTCOME_UNKNOWN`; the POST is NEVER resent (same or new key).
- Reconciliation = READS ONLY, ≥ dispatch + 2 min, bounded (accepted planner cadence): `GET /v1/refunds?payment_intent={pi}&limit=100`
  (+ the PI read). **A truncated list (`has_more = true`) is refused outright** (owner STOP `REFUND_LIST_TRUNCATED`): discovery never pages. Success
  is claimed only if EXACTLY ONE refund exists for the PI and it is uniquely attributable to the pinned operation: `charge`, `amount`, `currency`
  match AND `metadata.mv_refund_op = {opId}` AND `metadata.mv_refund_key = ref:{intent}:1` (the POST carries both) AND the time binding below. Zero
  refunds after the window → owner STOP `REFUND_NOT_FOUND` (never a resend). More than one, or one that does not bind → owner STOP
  `REFUND_AMBIGUOUS`. A `pending` refund keeps reading until the window ends, then owner STOP. The discovered id then needs the bound READ (§4.1).
- **Time binding (conservative)**: Stripe `created` is an INTEGER SECOND; the DB `dispatched_at` has sub-second precision. Compare
  `created ≥ floor(dispatched_at_ms / 1000) − 1` (one full second of slack towards the past, because the provider truncates), AND
  `created ≤ ceil(now_ms / 1000)`. `created` alone never binds: it is a filter that can only EXCLUDE a candidate; identity comes from the
  metadata + charge + amount + currency match.
- A late reply is late evidence only (existing pattern).

## 6. Concurrency / fences (stop on any unsupported shape)
| Row / actor | Fence |
|---|---|
| recording row dispatched / in_flight / outcome_unknown / escalated / already succeeded | `TEST_CLEANUP_REQUESTED` refused (`TEST_CLEANUP_RECORDING_NOT_PRISTINE`), nothing retired (foundation Q2); the Hostaway offline charge must be reconciled by the existing recording path first |
| notification rows (any `guest.notify` / `alert.owner` queued) | refused (`TEST_CLEANUP_NOTIFICATION_PRESENT`); nothing is sent or drained |
| capture row ≠ exactly one `succeeded` attempt 1 with the bound charge id and exact amount | refused (`TEST_CLEANUP_CAPTURE_NOT_PROVEN`) |
| existing refund / cancel / void rows, refund records, open case, work lease held | refused (`TEST_CLEANUP_OPERATION_HISTORY` / `TEST_CLEANUP_REFUND_PRESENT` (DB unique) / `TEST_CLEANUP_OPEN_CASE` / `TEST_CLEANUP_WORK_LEASE_HELD`) |
| concurrent workers | intent row lock first (applyEvent `FOR NO KEY UPDATE`), `intent_work` lease, op leases, 0007 / 0009 / 0019 claim fences (`REFUND_CLAIM_FENCED`, `CANCEL_CLAIM_FENCED`), version fences; the capture / recording / compensation workers never claim `test_cleanup_pending` intents (their `WORK_STATES` exclude it); the hosted runner adds the P3 session lock (5432, pid-stable) |
| protected reservation ids | refused everywhere |

## 7. Interface (hosted runner `e7-hosted-test-cleanup`, Slice-3 mirror of Slices 1–2; execution CLOSED by default)
Plan pins: approval ref, intent, expected version, not-before, PI, charge id, reservation id, `capturedMinor`, refund key, cancel key. Executor phase
`test-cleanup`: `retrieveAccount, retrievePaymentIntent, retrieveReservation, lookupPage, cancelReservation, createRefund(pi, {amount, metadata}, {idempotencyKey}),
retrieveRefund(re_id), listRefunds(pi)`. Transport fence: Hostaway GET + ONE `PUT …/statuses/cancelled`; Stripe GET account / PI / refund(s) + ONE
`POST /v1/refunds` with exact form body `payment_intent=…&amount=…&metadata[mv_refund_op]=…` and the pinned Idempotency-Key. Budgets: steps ≤ 6,
cancel 1, refund 1, PI reads ≤ 8, refund reads ≤ 8, Hostaway reads ≤ 12, run ≤ 10 min. Order: cancel leg before refund leg. Success output
`TEST_CLEANUP_COMPLETED` only after the residual read shows `cancelled` + claim released + both rows succeeded; otherwise facts reported.

## 8. Tests — foundation (delivered, `test/db/e7-test-cleanup-0019.test.mjs`, disposable PG, real repo / operations / evidence API)
R0 RED on the UNCHANGED 0018 blockers (fresh cluster): refunded captured PI → `AUTHORIZATION_UNSETTLED`; 0019 vocabulary refused. S1 static state
machine. Q1 request: both rows, pristine recording retired in the same tx, refund record, capture row / ledger untouched, nothing notified, replay
duplicate, claim held. Q2 refusals with ZERO writes (gate, production, stale, wrong charge / PI / amount / reservation / listing, protected id,
non-pristine recording, open case, non-TEST instance). Q3 legs in both orders: held after either single leg, released only after both exact proven
legs; `cancelled` + `not_completed_refunded`; `capturedMinor` immutable; refund recorded separately. Q4 negative proofs never settle (missing read,
other id / PI / charge, partial, other currency, pending, failed, PI partial, stale evidence, a later failed read contradicts the terminal). Q5 lost
reply → unknown, no resend, second row impossible, `REFUND_FAILED` → owner case. Q6 fences (retirement, refund claim, cancel claim). Q7 synthetic
negative matrix on a completed cleanup + the void path unchanged. Q8 migration round trip (down = 0018 exactly, up idempotent, function
attributes preserved).
Still to deliver (runner slice): §4.3 account / credential context, §5 discovery + `has_more` refusal + time binding, counter fences, lock / stop /
deadline / residual / unlock vetoes as in Slices 1–2.

Dependencies: foundation (this) → runner slice mirroring Slice 2 → ROOT review → only then any captured TEST payment.
