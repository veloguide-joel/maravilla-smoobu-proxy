# Capture-TEST cleanup CONTRACT (design only; not implemented) — 2026-11-12

Scope: after ONE hosted TEST capture (Slice 2) leaves an intent at `payment_captured` with a Hostaway TEST reservation and a captured TEST
charge, the smallest REVIEWED path that (a) cancels THAT reservation, (b) refunds THAT bound TEST payment with provider readback, and (c) leaves
the DB / claim / audit state honest. A dashboard refund is NOT sufficient closure: it leaves `payment_captured` + a held claim + a pristine
recording row that the accepted state machine would still try to record. No captured TEST payment is authorized until this path is reviewed.

## Source-backed facts (tooling 40779e34)
- `lib/checkout/intent-state.js` TRANSITIONS: `payment_captured` admits only `PAYMENT_AUTHORIZED | CAPTURE_SUCCEEDED | OFFLINE_CHARGE_RECORDED |
  OFFLINE_CHARGE_FAILED | ESCALATE`. There is NO refund event anywhere (`grep -i refund` → only the E3.2 comment "never refund or cancel
  automatically" and `amount_refunded` in proofs). `cancelled` is reachable ONLY from `capture_failed` (two legs: RESERVATION_CANCELLED +
  VOID_SUCCEEDED / RECONCILED_AUTHORIZATION_GONE). `ESCALATE` → `reconciliation_required` (owner case; `RESOLVE`).
- `lib/booking-db/compensation-worker.js` (E7.4a) is VOID-ONLY for a HELD authorization ("never a refund"); a captured PI is an owner case
  (`CAPTURED_WHILE_VOIDING`). Its cancel leg (`PUT /v1/reservations/{id}/statuses/cancelled`, executor `cancelReservation`, transport mapping
  present) works intents in `reservation_failed` / `capture_failed` only; `compensation-proof.js` proofs are zero-money proofs (void), not
  refund proofs — a void proof MUST NOT be reused on a refunded charge.
- `scripts/e7-connected/executor-adapters.mjs` PHASES has no refund phase; `http-transports.mjs` maps no `refunds.*` op. The capture runner's
  fence therefore refuses `refunds.create` today (test A6), and nothing in the tooling can send one.
- Stripe primary docs (api/refunds): a refund is created on a Charge or a PaymentIntent (`POST /v1/refunds`, form-encoded, idempotency key);
  Refund `status` ∈ `pending | requires_action | succeeded | failed | canceled` (card refunds: pending / succeeded / failed; a pending refund can
  later FAIL with `failure_reason` e.g. `expired_or_canceled_card`, `insufficient_funds`, `declined`); the Charge reflects it via
  `amount_refunded` / `refunded`. A refund reply is therefore NOT proof: the proof is a later READ.

## Smallest reviewed path (ONE bounded hosted step, same patterns as Slices 1–2)
Preconditions (read-only admission, pinned by plan hash): `payment_captured`, version pinned, bound PI / reservation id / `capturedMinor` pinned,
TEST livemode, ONE succeeded capture op (result_ref = charge id), recording row PRISTINE (never dispatched — if it was dispatched, STOP: the
Hostaway offline charge must be reconciled first), claim held, no open case, no refund / cancel rows, protected ids refused, `not_before` fence.

Leg 1 — reservation cancel (Hostaway): fresh by-id identity read (status `new`, listing / dates / ref / booking ref), then ONE
`PUT /reservations/{id}/statuses/cancelled` through the ACCEPTED cleanup `cancelReservation` executor + the existing transport mapping; proof =
a confirming by-id READ showing `cancelled`. Hostaway GET + this ONE PUT only.

Leg 2 — refund (Stripe): ONE `POST /v1/refunds` with `payment_intent={pi}`, `amount={capturedMinor}` (full, exact), fixed `reason=requested_by_customer`
is NOT used (TEST cleanup → omit reason), idempotency key `rf:{intentId}:{pi}` (new accepted key family, deterministic, never regenerated);
proof = a confirming `GET /v1/payment_intents/{pi}?expand[]=latest_charge` READ showing `latest_charge.refunded === true` and
`amount_refunded === capturedMinor` (or `GET /v1/refunds/{re_id}` status `succeeded`). `pending` → outcome_unknown + reads only (bounded
re-reads ≥ dispatch + 2 min via the accepted planner pattern); `failed` → owner case with `failure_reason`; never a second POST (same or new key).

Ordering: Leg 1 before Leg 2 (a refunded guest with a live reservation is worse than a cancelled reservation with money still held for a
reviewer decision). Both legs via counter fences BEFORE the transport (≤ 1 PUT, ≤ 1 refund POST), stop after awaited lock proofs and before
each send, session-mode lock pool 5432 separate from the 6543 worker pool, pid / ownership checks, no success past the deadline, residual read
must agree, checked unlock.

## Necessary additions (each a separate reviewed change; none exists today)
1. State / events (`intent-state.js`): `payment_captured` → `TEST_CLEANUP_REQUESTED` (owner-labelled, like `TEST_ABORT_REQUESTED`) →
   new state `test_cleanup_pending` with legs `RESERVATION_CANCELLED | RESERVATION_CANCEL_OUTCOME_UNKNOWN | RECONCILED_RESERVATION_STILL_ACTIVE`
   and `REFUND_SUCCEEDED | REFUND_FAILED | REFUND_OUTCOME_UNKNOWN | RECONCILED_REFUND_SUCCEEDED`; terminal `cancelled_refunded` (or reuse
   `cancelled` with `payment.refundedMinor`). Payment patch: `refundedMinor`, `refundId`. The pristine recording row must be settled
   (`cancelled`/`superseded`) in the same fenced transition so the recording worker never picks it up; the inventory claim is released on the
   cancel leg's success (as the existing cancel leg does).
2. Ledger / schema: new op type `stripe.refund_payment_intent` (payload `{paymentIntentId, chargeId, amountMinor, providerIdempotencyKey}`), its
   `claimNextOperation` fence (pending → in_flight guard, migration like 0009), evidence rows for the confirming reads (v3 PI proof extended
   with `amountRefunded` / `refunded`, or a `refund` evidence kind). Public API: `publicStatus` for the new states ("not_completed_refunded");
   the existing `payment_captured → "confirmed"` alignment issue stays open for customer acceptance.
3. Worker / executors: a `test-cleanup` phase in `executor-adapters.mjs` (keys: `retrieveAccount, retrievePaymentIntent, retrieveReservation,
   lookupPage, cancelReservation, createRefund, retrieveRefund`) and `refunds.create` / `refunds.retrieve` mappings in `http-transports.mjs`
   (form `payment_intent=…&amount=…`, Idempotency-Key, livemode false required on the reply); a bounded `runTestCleanupStep` reusing the
   accepted claim → pre-send re-read → ONE send → confirming read → fenced event pattern of the capture / compensation workers.
4. Budgets / proofs: steps ≤ 6, 1 PUT, 1 refund POST, PI reads ≤ 8, Hostaway reads ≤ 12, run ≤ 10 min; account + v3 proof (captured, amount =
   `capturedMinor`, charge id = capture op result_ref) BEFORE the refund; freshness ≤ 5 min; identity proof BEFORE the cancel; late replies =
   late evidence only.
5. Historic-message containment: `guest.notify` stays `*.invalid`-only and NOTHING is queued by the cleanup transitions (no "refunded" email
   template exists; add none in this slice); `alert.owner` only on owner cases. Protected reservations: zero action, as everywhere.

Dependencies / order: (1)+(2) first (offline, unit + PG tests through the accepted repo), then (3) with fake exchanges, then a hosted runner
slice mirroring Slice 2. Nothing here changes Slice 2's capture build, which does not wait for this review.
