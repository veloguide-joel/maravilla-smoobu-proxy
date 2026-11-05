# E7 checkout TEST page — integrated rehearsal report (OFFLINE)

Branch `feature/e7-checkout-test-integrated` from accepted `fe0ecae3`. Tests and report only: runtime, lib, API, SQL, config, dependencies and containment are unchanged.

## What runs for real vs fake

| layer | in this rehearsal |
|---|---|
| page controller + API client (`public/checkout-test.js`) | REAL, unchanged |
| `createIntentApiHandler` + `intent-api-core` + repo + triggers | REAL, on a disposable TEST-marked local PostgreSQL (`test/db/harness.mjs`) |
| webhook processing | REAL `processVerifiedStripeEvent`, fed a verified mock event (as if the signature passed) |
| release void | REAL, unchanged `runCleanupStep`, with FAKE Stripe executors; the Hostaway executors throw if ever called |
| Stripe (account, Checkout create/retrieve, PaymentIntent) and Hostaway pricing | FAKE in-memory; no network, SDK, key or credential |
| Stripe Checkout page | FAKE (redirect recorded, or intercepted in the browser) |

## Evidence

- **Committed CLAUDE-run test** `test/db/e7-checkout-test-page-integration.test.mjs` drives the page controller through a fetch adapter into the real handler.
  - The adapter sets `Origin` itself, so it is **not** browser evidence.
  - **First full run: 1/2.** My test expected 37500 minor units, but the real server applies the accepted 10% direct discount (33750). That was a fixture expectation error, not a runtime defect; after correcting it, 2/2.
  - **Test 1 — one fresh intent, step by step:**
    1. Create shows the server-priced total.
    2. A real details success (`details_collected`, public `awaiting_details`) makes Pay actually available, including after a reload.
    3. One fake Checkout session is prepared.
    4. The verified mock webhook moves the intent to `payment_authorized`, and the Stripe return shows neutral "Processing — not a booking".
    5. The release request queues one pending void. The claim is held and the route makes zero provider calls.
    6. A reload while queued, and a repeat status, are still honestly queued.
    7. The accepted cleanup moves the intent to `authorization_released` and the page shows "Release verified" with no stale notice. The claim is released: one void, Hostaway writes 0, `guest.notify` queued and never dispatched.
    8. A late same-PI webhook gets the existing `503 AUTHORIZATION_CANCELED` and changes nothing.
  - **Test 2 — reply-boundary faults:**
    - The real pay step ran (Checkout prepared) but its reply was dropped: `PAY_UNCERTAIN` latch. Repeat clicks and a reload sent no second pay; the real `awaiting_payment` status kept the latch, and the session-create count stayed 1.
    - A malformed `200 {}` status (real handler ran, reply replaced) shows "Status not confirmed": latch kept, label dropped, reads stopped.
- **Loopback browser (CLAUDE-run, not committed).** Real Chromium 141 → the real static page over `https://127.0.0.1` (self-signed) → the same REAL handler/core/repo on a disposable harness PostgreSQL. `checkout.stripe.com` was intercepted, a fake page was served, and the verified mock webhook ran.
  - Every API call was a browser-generated same-origin POST with `Origin` and no `Referer`.
  - The DB states matched each screen: `details_collected` → Pay, `payment_authorized` → Processing, `reservation_failed` + claim held → Queued, `authorization_released` + claim released → Verified.
  - Reloads after details and while queued were honest.
  - Zero provider calls in the release route; session creates 1, cancels 1, Hostaway 0; notify pending, never dispatched.
  - Console empty. sessionStorage held only `{token, releaseRequested, detailsSaved, polls, uncertain}`.
  - First run passed.
- **No runtime integration defect found.**
- **ROOT evidence:** prior root reviews only; not part of this run.

Mocks prove the integration of our own code. They prove nothing about connected Stripe, Hostaway, Vercel or the TEST DB.

## Next deployment prerequisites (all CLOSED until approved)

1. A preview build of the accepted branch lineage, with the TEST page and its terms-version meta set to the server's `MV_CHECKOUT_TERMS_VERSION`.
2. Preview env:
   - `MV_CHECKOUT_TEST_API`;
   - `MV_CHECKOUT_ALLOWED_ORIGIN` = the preview origin;
   - `MV_CHECKOUT_RETURN_URL` = `<origin>/checkout-test.html`;
   - `MV_CHECKOUT_TEST_LISTINGS=606998:USD`;
   - `MV_CHECKOUT_TEST_RELEASE`;
   - the E5a/E6 TEST settings and the rate-limit salt.
3. A TEST-marked booking DB with migrations 0001–0016 and its CA.
4. A Stripe TEST webhook endpoint for the preview (event version), reachable through preview protection.
5. Hostaway read access for pricing.
6. A separately approved, scoped owner cleanup run.

The connected-test blockers remain: R-REFUND, and the canceled-PI late-webhook 503.
