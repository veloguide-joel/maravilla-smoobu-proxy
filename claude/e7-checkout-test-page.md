# E7 checkout TEST page — implementation note (OFFLINE)

Branch `feature/e7-checkout-test-page` from accepted `98883e3b`. This slice has not been merged or deployed. It made no provider, credential, environment or dashboard action.

## Files

| file | role |
|---|---|
| `public/checkout-test.html` | The page. It carries a CSP meta, `no-referrer`, `noindex`, a TEST ONLY banner and configuration in data attributes (listing 606998, USD). The `mv-test-terms-version` meta is empty. |
| `public/checkout-test.js` | A dependency-free ES module: a DOM-free controller with pure helpers, plus a thin DOM binding. |
| `public/checkout-test.css` | Styles only: no `url()`, no imports, no fonts. |
| `lib/checkout/intent-api-http.js` | POST `{step:"status"}` alias (body exactly `{step}`; extra fields → 400 before any dependency). It reuses `core.intentStatus` and the unchanged Origin, bearer, rate-limit and TEST-DB gates. GET behaviour is unchanged. |
| tests | `test/e7-checkout-test-page.test.mjs` (new), `test/e6-intent-api-http.test.mjs` (status alias), and the identical exact `public/` allowlist edit in `test/static-containment.test.mjs` and `test/packaging-closure.test.mjs`. |

## Flow

1. **Create.** The guest picks dates and guests, and the page sends POST `/api/checkout/intents`. The server owns the listing check, validation and price.
2. **Details.** The guest must tick an explicit acceptance of the configured terms version.
3. **Pay.** The pay step returns a `checkoutUrl`. The page opens it only if it is `https:` on exactly `checkout.stripe.com`, with no port and no credentials. Stripe collects the TEST card; our page has no payment fields.
4. **Return.** `?checkout=complete|cancelled` is shown as a hint only, stripped with `history.replaceState`, and never used as evidence.
5. **Status.** The page asks the server through POST `{step:"status"}`. `processing` is shown NEUTRALLY as "Processing — not a booking": a hold may exist, but this coarse status cannot show capture or release (R-UI2). `payment_authorized`, `reservation_pending` and `capture_unknown` all map to it.
6. **Release.** "Request release" (one click) gives `release_requested`, shown as "Release requested — not released yet". Only a later `unavailable_not_charged`, in a tab that asked for a release, is shown as "Release verified". That still requires the separately approved, scoped owner cleanup worker.
7. **Other states.** `under_review` means owner review. `confirmed` is flagged as unexpected and never shown as a booking. `expired`, `payment_failed` and unknown statuses are each stated honestly.

## Safety rules (implemented and tested)

- **Token handling.** The token is sent only in the `Authorization` header. It is kept per tab in sessionStorage as `{token, releaseRequested, polls}`, with no guest data. Nothing goes to a URL, the console, localStorage or analytics.
- **Requests.** Fetch uses `credentials: omit`, `referrerPolicy: no-referrer`, `redirect: error`, `mode: same-origin`, `no-store` and a 15 s timeout.
- **Rendering.** Server strings are rendered with `textContent`, and codes are sanitised to `[A-Z0-9_]`.
- **Writes.** Each write needs one explicit click and only one request runs at a time. An uncertain write (network error, timeout, unreadable reply) is never retried: the page asks for "Refresh status".
- **Reloads.** A reload or a lost token never creates, pays or releases automatically. If storage is refused, payment is disabled.
- **Automatic status reads.**
  - Limited to 24 per 10 minutes per tab and token, persisted across reloads and the Stripe return. This leaves room under the shared per-token limit of 40 per 600 s.
  - They run only after a Stripe return (while awaiting payment) or after a release request.
  - They stop on 429, 401, an error or an unreadable reply. A budget that cannot be persisted is never used.
  - Manual Refresh is always available.

## Evidence

Each layer was tested separately; they are listed by what they actually prove.

- **Unit mocks** (`test/e7-checkout-test-page.test.mjs`): a fake API, storage, timers and navigation, with no DOM and no network.
  - **First full run: 5/9.** The failures were a test-helper defect: the rig exposed no `state` getter. After the fix, 9/9.
- **HTTP unit mocks** (`e6-intent-api-http`): fake pool, access and core; 8/8.
- **Loopback browser rehearsal** (not committed): real Chromium 141 loads the real page and calls the real `createIntentApiHandler` over `https://127.0.0.1` (self-signed). Core, pool and access are fakes; `checkout.stripe.com` was intercepted and answered by a fake page, with no external request.
  - **What it proved:**
    - Every POST carried a browser-generated `Origin`, with no Referer and no cookie.
    - A same-origin GET from the page arrived without `Origin` and the real handler refused it with 403, confirming the blocker.
    - The flow went create → details → pay → return (query stripped) → polled → authorized → release queued → verified. A reload sent only one status read.
    - A malicious price label was rendered as text: no `<img>`, no script run.
    - Storage held only `token`, `releaseRequested` and `polls`; localStorage stayed empty.
  - **Run 1** showed a CSS defect: `form { display: grid }` overrode `[hidden]`, so every form showed. A `[hidden] { display: none !important }` rule fixed it, confirmed in run 2 with screenshots.
  - The rehearsal injected the documented terms-version setting at serve time; the committed page keeps it empty.

## Pending deployment inputs (not set here; future approval)

- **Terms version:** set the `mv-test-terms-version` meta to the server's `MV_CHECKOUT_TERMS_VERSION`.
- **Preview environment:**
  - `MV_CHECKOUT_RETURN_URL` = `https://<preview host>/checkout-test.html`;
  - `MV_CHECKOUT_ALLOWED_ORIGIN` = `https://<preview host>`;
  - `MV_CHECKOUT_TEST_LISTINGS` includes `606998:USD`;
  - `MV_CHECKOUT_TEST_RELEASE` = `enabled`;
  - plus the existing E5a/E6 TEST settings.
- **TEST database** with migrations 0001–0016; a Stripe TEST webhook endpoint and its event version; Hostaway read access for pricing; and whether preview protection allows the webhook.
- **Separately approved owner cleanup run** for the void. The connected-test blockers remain: R-REFUND, and the canceled-PI late-webhook 503.

## Residuals

- `unavailable_not_charged` is shared by `authorization_released` and a non-TEST `reservation_failed`. The page calls it "Release verified" only when this tab requested a release.
- Lost storage, or another tab, cannot resume a booking. The same token in two tabs has separate polling budgets, but the shared server-side rate limit still applies.
- `confirm()` is used for "Forget this TEST booking in this tab". It only forgets locally; nothing is cancelled or released.

## Root HOLD corrections on db9ef550 (R-UI1 / R-UI2)

- **R-UI1 uncertainty latch.**
  - **What counts as uncertain.** No reply, a timeout, an unreadable reply, HTTP 5xx or 408 on create, details, pay or release. That latches the action. Its typed name is kept per tab in session state (`uncertain`, with no guest or provider data); in memory only if storage is refused.
  - **What the latch blocks.** The ordinary button stays disabled in both the controller and the DOM, and repeat clicks and reloads send nothing.
  - **How each latch clears.** Refresh status is always a read. A latch clears only when a status proves the action resolved:
    - details: once the status is no longer `awaiting_details`;
    - pay: once the status is neither `awaiting_payment` nor `awaiting_details`. `awaiting_payment` proves nothing about an unknown pay;
    - release: once the status is no longer `processing`.
  - **Explicit resend.** If a fresh status shows the step is still allowed, an EXPLICIT resend button appears for details or release. Release repeats are server-idempotent. Pay never gets a resend.
  - **Unknown create.** Without a bearer, the page shows an explicit "a TEST intent may already exist" acknowledgement in place of the Create button, including after a reload.
  - **Wording.** Definite 4xx refusals say "definite refusal"; uncertainty says "unknown whether … took effect".
- **R-UI2.**
  - Neutral `processing` wording.
  - Action and hint notices are tied to the status they were issued for, and any newer authoritative status clears them. "Release verified" and owner review never show the stale "queued, not done" notice.
- **Tests on exact db9ef550 (red first).**
  - **Red:** 5 new tests failed, 9 passed. Among the failures, the second details call was sent, and the stale notice and processing wording were confirmed.
  - **Fix:** 4 existing assertions changed to match. The `*_UNKNOWN` codes are now `*_UNCERTAIN`; the stored keys now include `uncertain`; a release 503 is now uncertain, not a refusal.
  - **Green:** 14/14. One of my new wording assertions was too broad: it matched "uncaptured" inside a negated phrase, so I reworded the page text.
- **Loopback browser regression (fake core, intercepted Stripe).**
  - **Pay answered 503:** the button stays disabled. Forced clicks and `element.click()` ×2 sent no second pay; after a reload it was still disabled, stored `uncertain: "pay"`, and pay count was 1.
  - **Main flow:** neutral processing title; the "Release verified" screen has no notice.

## Root re-review HOLD on f7aa427e (R-UI1a / R-UI1b)

- **R-UI1a: semantic reply boundary.**
  - **Status replies.** Only a RECOGNISED public status (`KNOWN_STATUSES` = the accepted `publicStatus` values plus `release_requested`) can resolve a latch. A 200 with a missing, null, non-string or unknown status:
    - keeps every latch;
    - stops automatic reads (`UNREADABLE`);
    - drops the previous label (`last = null`) and shows "Status not confirmed";
    - blocks every ordinary action.
  - **Write replies.** JSON alone is not success; each write must match its accepted API shape:
    - create: `201 {token, status:"awaiting_details"}`;
    - details: `200 {status:"awaiting_details"}`;
    - pay: `200` with a valid Stripe `checkoutUrl`;
    - release: `202 {status:<recognised>, release:"REQUESTED"}`.

    Any other 2xx latches the action. It is never called a refusal, never resent by its ordinary button, and a bad URL is never opened. A create 201 that carries a valid bearer keeps the bearer for safe status reads, and a recognised status then resolves the latch. Without a bearer, create needs the explicit acknowledgement.
- **Accepted details shape (found while checking the shapes above).** `details_collected` maps publicly to `awaiting_details`. The previous page would have shown the details form again after a successful save; the rehearsal's fake core had masked this by returning `awaiting_payment`.
  - **Fix:** a session flag `detailsSaved`, a boolean only with no guest data, set only by a verified details reply or a prepared Checkout.
  - **Uncertain details while still `awaiting_details`:** the page offers an explicit resend or an explicit Pay attempt. A definite `409 NOT_READY_FOR_PAYMENT` proves the details were not saved and re-opens the form.
- **R-UI1b: reload budget.** Every page-load or Stripe-return status read is AUTOMATIC and spends the persisted 24-per-10-minutes budget, including a latched reload.
  - A latched tab never polls on its own.
  - Once the budget is exhausted, a reload sends nothing; explicit Refresh remains the manual read.
  - Without persistable storage, a reload sends nothing automatically.
- **Tests (exact red controls on f7aa427e).**
  - **Red:** 14/18. The 4 new tests failed: malformed status, malformed 2xx writes, the accepted details shape, and 30 reloads.
  - **Green:** 18/18. Two test-side updates: the stored-keys list now includes `detailsSaved`, and one new test reused the wrong storage and status script, corrected before acceptance.
- **Loopback browser.**
  - **Fake core:** now returns the accepted details shape. Main flow: details → pay → fake Stripe → processing (neutral) → queued → verified with no notice.
  - **Uncertain pay:** after a reload, a malformed `{}` status gives "Status not confirmed". Pay stays hidden or disabled, pay count 1, stored `uncertain: "pay"`.
