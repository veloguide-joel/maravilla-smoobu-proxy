# E7 checkout TEST release — implementation note (OFFLINE)

Branch `feature/e7-checkout-test-release` from accepted `d1e20d71`. This slice has not been merged or deployed. It made no provider, network, credential, environment or infrastructure change.

## What it adds

- **E3 event `TEST_RELEASE_REQUESTED`** (`lib/checkout/intent-state.js`).
  - The only starting state is `payment_authorized`. The event moves the intent to `reservation_failed` with reason `TEST_RELEASE_REQUESTED`, plus exactly ONE ordinary void effect.
  - It reuses `reservation_failed` solely to enter the accepted authorization-only compensation path. The reason records an intentional TEST release, not a provider failure.
  - It is refused unless all of these hold:
    - `cfg.testReleaseEnabled === true` (default `false`) and `expectedLivemode === false`;
    - the persisted payment has `livemode: false` and nothing captured;
    - the event's PaymentIntent equals the bound one, and the deterministic id is `test-release:{intent}:{pi}`;
    - there is no lease, dispatch, reservation or settlement, and every counter (reservation, capture, void, cancel and offline-charge attempts) is 0.
  - Public status is `release_requested` while the void is only queued. The existing `unavailable_not_charged` label appears only after `authorization_released`.
- **`repo.requestTestRelease(pool, intentId, { now })`** builds the event from the DATABASE intent; no client value is used.
  - It calls `applyEvent` with the flag set for this one call. Its `inTx` runs after the intent row is version-locked and re-reads, in the established lock order:
    1. `booking.instance`, which must be `test`;
    2. `intent_work` `FOR SHARE`: no acquired lease, live or stale;
    3. `payment_attempts` `FOR SHARE`: nothing unresolved, and exactly one `completed` attempt bound to the intent's session;
    4. `external_operations` `FOR SHARE`: only the settled Checkout create and settled Stripe reads; exactly one new pending void queued;
    5. `hostaway_reservation_attempts`: none.
  - A guard refusal becomes `{ ok:false, error:TEST_RELEASE_* }`. Any other database error propagates unchanged.
  - The inventory claim stays held, because `reservation_failed` is not a claim-release state. Only the accepted worker's verified VOID_SUCCEEDED or RECONCILED_AUTHORIZATION_GONE releases it.
- **HTTP step `{"step":"release"}`** (`intent-api-http.js` / `intent-api-core.js releaseIntent`).
  - It exists only with `MV_CHECKOUT_TEST_RELEASE=enabled`; otherwise it gets the same `400 UNKNOWN_STEP` as any unknown step. The existing gate (production 404), origin, bearer and rate limits all apply, and the body must be exactly `{step}`.
  - Responses:
    - `202 { status: "release_requested", release: "REQUESTED" }`;
    - `409 NOT_AUTHORIZED_YET` when the payment is not yet authorized;
    - `409 TEST_RELEASE_*` or `ILLEGAL_TRANSITION` otherwise.
  - The step makes no provider call and imports no worker; packaging is unchanged and green.
- **SDK pin.** Both Checkout clients now pass `apiVersion: "2026-01-28.clover"`, which equals the installed stripe 20.3.1 default, with retries 0 and timeout 10 s. Checkout's `payment_method_types: ["card"]` is unchanged. No package changed. The webhook endpoint's event version is a future approval input.

Unchanged: the compensation worker, proofs, adapters, SQL migrations, the reservation worker, the webhook binding, the standalone dahlia runners and the fixed tooling.

## Request vs cleanup

The request only records intent and queues the void. The accepted `runCleanupStep` later does the work:

1. reads the account and the PaymentIntent;
2. checks the strict still-authorized proof;
3. sends the one void;
4. confirms with a strict canceled read;
5. applies VOID_SUCCEEDED → `authorization_released`, and the claim is released.

Running the worker against a real deployment needs a separate approved package.

## Residuals (documented, not solved here)

1. **R-REFUND.** The accepted strict canceled proof requires the charge's `amount_refunded` to be 0. If a real Stripe cancel reports the released amount as refunded, the worker escalates to `reconciliation_required` / `VOID_PROOF_NOT_STRICT`. The release is then never claimed and the dates stay held (tested). The real Stripe behaviour is unverified.
2. **Late webhook after the void.** The existing binding refuses a canceled PaymentIntent before E3: `503 AUTHORIZATION_CANCELED`, no state change, but Stripe would redeliver. A same-PI completion that is read while the payment is still authorized stays an E3 duplicate.
3. **A different PaymentIntent on a closed intent** only queues a void plus review (`reconciliation_required`). The compensation worker does not process that state, so the second payment is not voided automatically.
4. **No sweeper and no guest page.** A hold the guest never releases stays until Stripe expires it. The `guest.notify` row stays queued, because no notification transport exists.
5. **The TEST marker check** inside the transaction is code-path only. The disposable cluster is always `test`, and changing the marker would weaken a fixture.
