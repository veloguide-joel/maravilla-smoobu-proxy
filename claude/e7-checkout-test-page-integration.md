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

## Preview preparation pass (docs only, 2026-11-05)

Branch `feature/e7-preview-prep` from exact `a3f94124`. No runtime change; no suites run (docs only). Nothing was created, deployed, merged, registered or changed; no secret value, credential or SQL was touched.

### 1. Observed setup (facts) vs placeholders

Read 2026-11-05 through the owner's signed-in Vercel session (API reads in the page; only key, target, type and date were returned, never values). Supabase was **not signed in** in that browser: live dashboard status is **UNKNOWN**. DB facts below come from the dated project reports only.

| Item | Observed | Source |
|---|---|---|
| Vercel project | `maravilla-smoobu-proxy` (team `joel-goralskis-projects`), repo `maravilla-smoobu-proxy`, production branch `main`, region `iad1`, no framework | Vercel, today |
| Preview protection | `ssoProtection: all_except_custom_domains`; **0** protection-bypass entries | Vercel, today |
| Project env names (all `sensitive`) | `HOSTAWAY_ACCOUNT_ID`, `HOSTAWAY_CLIENT_SECRET`, `HOSTAWAY_DIAG_KEY` (preview+development); `BOOKING_UI_ORIGINS` (preview). **Nothing else** | Vercel, today |
| Team-shared env | `NEXT_PUBLIC_SUPABASE_URL`/`_ANON_KEY`, **not linked** to this project (unrelated project) | Vercel, today |
| Preview deployments | READY previews exist for `98883e3b` (release) and `db9ef550` (page, first head). **None** for `f7aa427e`, `fe0ecae3` or `a3f94124` in the last 40 deployments. Production = `main` `1f35c02b` | Vercel, today |
| Booking DB | Supabase **maraVilla Booking DEV** `mxotevtiscernhqilyiu` (us-east-1, Micro, PG 17.11, Data API disabled); `booking.instance = test`; migrations **0001–0005** applied (2026-10-21); runtime login `mv_booking_app_dev` passed read-only Smoke 1 22/22 through the transaction pooler with the pinned CA (2026-10-22) | `report-e2c-sql-editor-execution-2026-10-21.md`, `report-e2c-auth-smoke1-2026-10-22.md` |
| Booking DB vs code | The branch has migrations **0006–0016** (added 2026-11-02…04). No record of them on the hosted DB | repo + project docs |
| Code-required env | `BOOKING_DATABASE_URL`, `BOOKING_DATABASE_CA_PEM`, `STRIPE_TEST_SECRET_KEY`, `STRIPE_TEST_ACCOUNT_ID`, `STRIPE_TEST_WEBHOOK_SECRET`, `MV_STRIPE_TEST_WEBHOOK`, `MV_CHECKOUT_TEST_API`, `MV_CHECKOUT_ALLOWED_ORIGIN`, `MV_CHECKOUT_RETURN_URL`, `MV_CHECKOUT_TERMS_VERSION`, `MV_CHECKOUT_TEST_LISTINGS`, `MV_CHECKOUT_TEST_RELEASE`, `MV_RATE_LIMIT_SALT`, optional `MV_CLIENT_ADDRESS_SOURCE` / `BOOKING_RETENTION_*`; gate needs `VERCEL_ENV` preview/development | `grep` of `lib/checkout`, `lib/booking-db` |

**Smallest exact setup delta** (values are owner placeholders, all UNSET):
1. **DB:** apply migrations 0006–0016 to `mxotevtiscernhqilyiu` by the reviewed route, then read-only verify (history 1–16, `test` marker, grants). Confirm `mv_booking_app_dev`'s grants still match the 0016 matrix.
2. **Vercel env, Preview scope only, ideally branch-scoped to the test branch:** the 13 names above. Every one is absent today. Non-secret placeholders: origin/return URL = the branch preview alias; `MV_CHECKOUT_TEST_LISTINGS=606998:USD`; terms version = the page meta. Secrets (`BOOKING_DATABASE_URL`, CA PEM, the three Stripe TEST values, salt) are owner-entered.
3. **Preview deployment** of the branch head to be tested (none exists for the accepted page or integration heads).
4. **Protection path for Stripe → preview webhook:** previews are SSO-protected with no bypass, so delivery needs a Protection Bypass for Automation, or a scoped exception. This is a reserved setting change.
5. **Stripe TEST webhook endpoint** for that preview URL, at event version `2026-01-28.clover` to match the SDK pin. Reserved.

The Hostaway pricing credentials are already present in preview. No other prerequisite was found.

### 2a. R-REFUND (repo-only decision note)

> **Superseded by evidence (2026-11-05, root-verified).** A read-only GET of the existing canceled $1.00 TEST PaymentIntent (run 42091575058, job 127470681079; 2 exchanges, 0 writes, Stripe-Version `2026-01-28.clover`) reported the charge `captured:false`, `amount_captured` 0, **`amount_refunded` 0**, `refunded:false`. R-REFUND is CLOSED for this observed profile (TEST, manual capture, card, clover). **No proof change.** This is not proof for all cards or accounts, and not live readiness. The analysis below is kept as the record of the question.

- **Accepted strict canceled proof** (`lib/checkout/compensation-proof.js:170-189`, `piCanceledProofV3`):
  - the PI is `canceled`, with `amount_received` 0 and `amount_capturable` 0;
  - the charge is expanded, bound, TEST, `captured:false` and `amount_captured` 0;
  - **`amount_refunded === 0`**;
  - the amount and currency equal the price.
  - The reconcile-gone and captured proofs in `recovery-plan.js:123` and `capture-proof.js:103` also require refunded 0.
- **What the isolated runner checked** (`main:scripts/e7-stripe-authorization-test.mjs:154-161` `releaseProof`): the same facts, but it accepts `amount_refunded ∈ {0, amount}`.
  - Its published result has only `final {status, amountReceived, amountCapturable}` and `cleanup: VERIFIED` (`:180-183`).
  - So run 42073005090 shows the release happened. It does **not** show which value `amount_refunded` had.
- **Official semantics** (Stripe API reference, *Cancel a PaymentIntent*): "For PaymentIntents with a `status` of `requires_capture`, the remaining `amount_capturable` is automatically refunded."
  - That points toward `amount_refunded = amount` (with a Refund object) on the canceled charge. If so, our worker would escalate every real void to `VOID_PROOF_NOT_STRICT`.
  - The reference does not state the charge field values.
- **Minimal additional evidence:**
  - one approved read of a canceled, never-captured TEST PI, made at the worker's Stripe-Version, publishing only `pi.status`, `amount_received`, `amount_capturable` and the expanded `latest_charge`'s `captured`, `amount`, `amount_captured`, `amount_refunded`, `refunded` and `status`;
  - optionally the charge's refund count and amounts (no ids beyond the charge).
  - PaymentIntent `pi_3UYUIm2B9LTneQgw0mGFQdwG` is outside current authorization: the consumed $1 approval does not cover any further request. *(Corrected by root review of 5c0e1ea3: it is not protected by policy; it is simply not authorized.)* A separately approved **read-only retrieval of an existing canceled TEST PaymentIntent** may be the smallest evidence step, smaller than creating another hold.
- **Is a code change supportable now?** No. The doc wording makes a change likely, but the proof must not move on an inference.
  - The supportable change *after* evidence is narrow. Accept `amount_refunded` equal to exactly the authorized amount only when every other canceled fact holds: `captured:false`, `amount_captured` 0, `amount_received` 0, `amount_capturable` 0, and the exact charge amount and currency. Optionally also require `refunded:true`.
  - The change would cover the canceled proof and the reconcile-gone proof only, never the captured or still-authorized proofs.
  - It needs tests for 0 and for the exact amount (both accepted), and for any partial or other value (refused).

### 2b. Post-void late `checkout.session.completed` (decision note)

- **Source order today:**
  1. `processVerifiedStripeEvent` records the event first (`lib/checkout/stripe-test-webhook.js:113-116`). A redelivery of an **already processed** event id returns `200 ALREADY_PROCESSED` before any read, so it is safe today.
  2. A **new** event id, or a retry of an *unfinished* one, re-reads the session and PI (`:132-147`) and calls `bindAuthorization` (`:148`).
  3. `bindAuthorization` refuses `canceled` at `lib/checkout/stripe-test-mode.js:185`, before E3. The result is `503 AUTHORIZATION_CANCELED`, which Stripe retries.
  4. The E3 duplicate rule that would otherwise apply is in `lib/checkout/intent-state.js:397-399`: same PI, and the status is in `AUTH_ACCEPTED` or is `reconciliation_required`.
- **Smallest safe acknowledgement (proposal):**
  - Keep `bindAuthorization` unchanged for its own outcomes.
  - Only when it returns `AUTHORIZATION_CANCELED`, run a pure check `bindCanceledDuplicate({session, pi, attempt, intent})` followed by one DB transaction. It acknowledges `200 DUPLICATE_CANCELED`, marks the event processed, and makes **no** transition, no `applyEvent`, no effect, no claim change and no operation.
- **Required conditions:**
  - **All identity checks** that `bindAuthorization` already passes before `:185`: account verified; session bound, TEST, `complete`, with metadata; PI = the session's PI, TEST, with metadata, `manual` capture. These are re-asserted, not assumed.
  - The PI is `canceled`, with `amount_received` 0 and the charge, if present, bound to this PI, TEST, `captured:false` and `amount_captured` 0. `amount_refunded` is ignored: this acknowledgement claims no release.
  - **A durable prior accepted authorization, checked in the transaction after locking the intent row `FOR SHARE`:**
    - `intent.payment.paymentIntentId === pi.id`;
    - `intent.checkout.sessionId === session.id === attempt.checkout_session_id`;
    - `attempt.intent_id === intent.id`, and the attempt is `completed`;
    - `pi.amount === intent.payment.amountMinor`, and the currency equals `intent.price.currency`;
    - `intent.payment.livemode === false`;
    - a `PAYMENT_AUTHORIZED` row in `booking.intent_applied_events` for this intent under a **different** event id;
    - a status in `AUTH_ACCEPTED` ∪ {`reconciliation_required`}, the same set the E3 duplicate rule uses.
  - Neither terminal state alone nor a canceled PI alone qualifies.
- **Behaviour in other cases** (each unchanged unless noted):
  - **Malformed / livemode / Connect:** 400 before recording.
  - **Foreign session:** `200 IGNORED_FOREIGN_SESSION`.
  - **Different PI:** not a duplicate.
    - If that PI is `requires_capture`, the existing E3 `AUTHORIZATION_ON_CLOSED_INTENT` applies (void + review).
    - If it is canceled, it stays `503` and goes to the owner (residual 3).
  - **No prior authorization** (intent still `payment_pending` or never authorized, PI canceled): stays `503`. It fails closed.
  - **Concurrent release:**
    - A completion read while the PI is still `requires_capture` takes the existing E3 duplicate path.
    - One read after the cancel is checked under `FOR SHARE` against the committed intent. It serializes with the release and the VOID_SUCCEEDED version CAS, so it acknowledges in `reservation_failed` or `authorization_released` and never changes either.
- **Tests to add:**
  - a new-id late event after a verified void → `200 DUPLICATE_CANCELED`, with state, operations, claim and notify unchanged and the event processed;
  - the same event replayed → `ALREADY_PROCESSED`;
  - one test per broken binding (account, session, metadata, PI id, amount, currency, livemode, attempt, missing prior `PAYMENT_AUTHORIZED` row) → still `503`, no change;
  - a different canceled PI → `503`;
  - `payment_pending` + canceled → `503`;
  - a race where the cancel lands between the PI read and the transaction, and one where the void is applied while the acknowledgement waits on the lock;
  - `bindAuthorization` outcomes otherwise byte-identical;
  - the existing release test (`test/db/e7-checkout-test-release.test.mjs:191-200`) updated from 503 to the new code.

### 3. Prioritized finish list (sequencing corrected by root review of 5c0e1ea3)

> **Status 2026-11-05.** Item 1 is done (`6d703acd`, accepted). Item 2 is done: the R-REFUND evidence above; no correction was justified. The infrastructure items (3, 4) are now the concrete execution packet `claude/e7-dev-preview-packet.md`, which also flags two required offline gaps: the preview-config commit P, and the owner-cleanup runner C (no reviewed hosted cleanup mechanism exists yet). The hosted DB state is UNKNOWN beyond the dated 0001–0005 reports.

1. **Offline slice:** 2b — now implemented (next section).
2. **R-REFUND evidence FIRST.** It must be settled BEFORE any guest Checkout hold that relies on the strict worker proof is authorized.
   - Smallest step: one separately approved, read-only retrieval of an existing canceled TEST PaymentIntent with its expanded charge (fields in 2a). No provider action is prepared here.
   - Then a reviewed proof correction **only if** the evidence justifies it; otherwise the proof stays as it is.
3. **Infrastructure (reserved; owner):** hosted migrations 0006–0016 + read-only verify; Preview-scoped env (13 names); the webhook protection path; the Stripe TEST webhook endpoint at `2026-01-28.clover`.
   - Existing preview deployments do not mean their runtime settings are ready: today none of the 13 names exists.
4. **ONE approval package (eventual), in this order:**
   - a. the read-only evidence step of item 2;
   - b. the reviewed proof correction, only if justified;
   - c. infrastructure (item 3: migrations + verify, owner-entered Preview values, one preview of an accepted head, one bypass + one TEST webhook endpoint);
   - d. one guest TEST run on the page (authorize → release → worker void + strict proof);
   - e. scoped owner cleanup.
   - Every step runs once, with no retry or fallback. It stays CLOSED until Joel approves.

## Late canceled duplicate acknowledgement (OFFLINE implementation)

Branch `feature/e7-late-canceled-duplicate` from exact `5c0e1ea3`. No SQL, migration, E3, worker, proof, public file, route, SDK version, dependency, config or containment change.

- **Where it runs.** Only the `checkout.session.completed` authorization path, and only when the unchanged `bindAuthorization` answers exactly `AUTHORIZATION_CANCELED` (`lib/checkout/stripe-test-webhook.js`).
- **Pure check** — `bindCanceledDuplicate` (additive, `lib/checkout/stripe-test-mode.js`):
  - re-asserts every session / PaymentIntent / attempt / TEST / manual-capture / metadata identity explicitly, with the account verified;
  - requires the PaymentIntent `canceled`, with `amount_received` 0 and `amount_capturable` 0;
  - requires the expanded charge bound to that PaymentIntent, TEST, `captured:false`, `amount_captured` 0, with the same amount and currency;
  - requires one strict integer amount and one case-normalized currency across session `amount_total`, attempt `amount_minor` (canonical digits), PaymentIntent and charge. Nothing is coerced.
  - `amount_refunded` is ignored **only** here, because this acknowledges a notification; it never proves a release.
- **Locked DB check** — `acknowledgeCanceledDuplicate` (`lib/booking-db/webhooks.js`), ONE short transaction in lock order `intents FOR SHARE` → `payment_attempts FOR SHARE` → `stripe_webhook_events` (the same order applyEvent + `markStripeEventProcessedInTx` use). It re-checks:
  - the CURRENT intent payment (PaymentIntent, TEST), session and money (payment amount = price total = binding; currencies);
  - the attempt: `completed`, same session, PaymentIntent, TEST and money;
  - exactly one `PAYMENT_AUTHORIZED` applied under a DIFFERENT event id whose processed webhook record names the same session; this event id never applied;
  - E3's own duplicate rule (`transition()` on the locked intent must answer duplicate). No status list is copied.
  - Then it marks ONLY this event `processed` (`error_code CANCELED_DUPLICATE`): no `applyEvent`, transition, effect, claim change or operation beyond the existing verified read trail.
- **Replies.**
  - Acknowledged: `200 DUPLICATE_CANCELED`.
  - Same event already finished by a concurrent delivery: `200 ALREADY_PROCESSED` (its real status, never a second acknowledgement).
  - Any failed check: the accepted `503 AUTHORIZATION_CANCELED`, with the specific reason as the event's `error_code`.
  - A failed COMMIT throws and is answered 503: success is never reported for an unacknowledged commit.
- **Account trust boundary.** The configured TEST account is verified against the credential (`verifyAccount`) before the reads. The schema has no durable account column on `intents` or `payment_attempts`, so no persisted account binding exists to check; none was invented.
- **Unchanged.** An active `requires_capture` completion still takes the E3 duplicate path. A different, still-held PaymentIntent still gets E3's void + review. A different canceled PaymentIntent, or a never-authorized intent, stays 503.
- **Tests:**
  - `test/e7-late-canceled-duplicate.test.mjs` (pure, 4);
  - `test/db/e7-checkout-test-release.test.mjs` (+3 tests, happy chain updated): a new-id late event → `DUPLICATE_CANCELED` with state / version / transitions / applied events / claim / non-read ops / notify unchanged; a same-id replay → `ALREADY_PROCESSED` with zero reads; 11 negatives (no prior authorization, different PaymentIntent, money, currency, charge TEST / missing / captured, amount received, metadata, PaymentIntent TEST, account); the REAL worker's `VOID_SUCCEEDED` observed waiting (in `pg_stat_activity`) on the acknowledgement's intent lock, then both commit; concurrent same-id deliveries → one acknowledgement + `ALREADY_PROCESSED`;
  - the page-integration test now expects `DUPLICATE_CANCELED` and asserts exactly one `guest.notify` row.

Not claimed: connected readiness. All live, preview, merge and provider gates stay closed. Protected reservations 70636076 / 71045356 / 71072615 / 71081885 remain zero-action.
