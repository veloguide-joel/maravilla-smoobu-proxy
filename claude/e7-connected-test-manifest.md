# E7 connected-test orchestration + live-gate manifest — CONTRACT (DOCS ONLY, all changes PROPOSED)

**Branch** `feature/e7-connected-test-manifest`, cut from exact `62843150ad36c2db75a6819811c1d4f634ee5156`. **Runtime baseline** `ede4c43c25f9c025c540ba1f26a766eef5845556` (unchanged; not merged, deployed or live). Every source citation is at that runtime baseline.
**What this is.** A conditional plan for ONE manually run, owner-supervised connected test, concrete enough for root design review. **What it is not:**
- not the live approval package;
- not an implementation;
- no authorization for any read, write, credential use, deployment or message.

Every real value is **UNSET** (§7). Protected reservations 70636076 / 71045356 / 71072615 / 71081885 stay zero-action. Historical e74a listing-lock failure stays OPEN: any future authorized reproduction → FIRST FULL TAP and STOP.

## 1. The proposed test, in one paragraph

A local, owner-run CLI under `scripts/` drives ONE booking intent on ONE listing through the accepted step functions, with one disposable TEST-marked database. Each step is bounded and the CLI pauses for Joel between phases. Executors are injected:
- Hostaway: a real-account transport;
- Stripe: TEST mode only (the accepted proofs refuse LIVE money).

No notification or owner-alert transport is supplied, so queued outbox rows stay queued. Cleanup is fixed in the approval **before** any create or capture. The CLI writes a redacted journal and stops on the first uncertainty. Nothing here validates the hosted checkout, the deployed webhook route or any production environment.

## 2. Provider-mode matrix (one must be chosen by root + Joel; none is chosen here)

| Mode | Hostaway | Stripe | How the intent reaches `payment_authorized` | What it proves | What it cannot prove / risks |
|---|---|---|---|---|---|
| **H-real / S-mock** | real account | in-memory mock (as the rehearsals) | authorization FIXTURE: `applyEvent(PAYMENT_AUTHORIZED)` with a synthetic PI, as in the E7 rehearsals | the reservation worker's real create / lookup / read path; and, if cleanup is a pre-capture refusal, the real host cancel | **No card, no Stripe shape.** Capture would be mock-only. Recording would then write a REAL "paid" Hostaway row for money that never existed, so in this mode recording **must be excluded** (stop at `payment_captured` is not acceptable either, §4) |
| **H-real / S-TEST** | real account | Stripe TEST account, real TEST API | a real TEST Checkout Session completed with a TEST card, then a verified `checkout.session.completed` processed by the accepted handler (`processVerifiedStripeEvent`, `lib/checkout/stripe-test-webhook.js:102`). Ingress is an open root choice (§5.4) | real TEST PaymentIntent shapes for capture / void (`capture-proof.js:84–107`; `compensation-proof.js:184`) and real Hostaway; with recording, the offline-charge create shape | **TEST money only.** A captured TEST charge plus a real Hostaway `status: "paid"` offline charge (`offline-charge-proof.js:373–375`) records a **TEST artifact as if paid**. That artifact and its review / cleanup must be in the consolidated approval (§4.3) |
| **S-LIVE** | — | live | — | — | **Refused by code**: `CHARGE_NOT_TEST_MODE` (`capture-proof.js:97`, `compensation-proof.js:184`), webhook `LIVEMODE_REFUSED` (`stripe-test-webhook.js:108`), `stripeTestGate` (`stripe-test-mode.js:45–49`). Out of scope; no proposal flips livemode |

A mock authorization is never evidence of a real card payment. A TEST capture is never evidence of real money.

## 3. Listing branch (both explicit; neither authorized)

| Branch | Adapter config | What code allows today | Consequence |
|---|---|---|---|
| **U: a USD listing (Joel's future direction)** | `validateAdapterConfig` with that listing id, currency `USD` (`hostaway-reservations.js:202`); pilots 603564 / 603566 refused by default (`:25–28`) | Reservation, capture, compensation and recording (`APPROVED_CURRENCIES = ["USD"]`, `offline-charge-proof.js:33`); 0016 notification scope USD | The full success path to `confirmed` is reachable offline. Listing existence, currency and its channels are UNVERIFIED (read-only probe P1) |
| **P: the E4 pilot exception (603566, MXN, branded config)** | only `connectedTestAdapterConfig()` (`hostaway-reservations.js:52–63`) | Reservation / capture / compensation accept the adapter currency; **recording refuses MXN** (`CURRENCY_NOT_APPROVED`, `offline-charge-proof.js:129`) | `confirmed` is **unreachable**: a capture would end at `payment_captured` with no automated way out (§4.2). Pilot protection is not lifted by this document; recording is not broadened to MXN |

## 4. Phases, stops and cleanup

### 4.1 Phase order (one intent, one listing; every step scoped with `intentId` and `listingIds = [L]`)

| # | Phase | Entrypoint (accepted) | Bound | Mandatory pause / check after |
|---|---|---|---|---|
| P0 | Preflight | `assertEnvironment(pool, "test")` (`lib/booking-db/pool.js:73–77`); every worker gate (`reservation-worker.js:126–136`, `capture-worker.js:73–79`, `compensation-worker.js:73–78`, `recording-worker.js:66–83`); journal opened with the manifest hash + baseline commit | no provider call | Joel confirms: the G8 read-only freshness result; the G9 baseline (Airbnb + Hostaway calendar for the dates); no existing reservation on the arrival date; L, dates and amount match the approval |
| P1 | Intent + price | `createIntentRecord`, `PRICE_CONFIRMED` via fresh `priceStay` (`server-pricer.js:29–45`), `collectGuestDetails` (`repo.js:62`, `:337`, `:430`) | Hostaway reads only | price = approved amount, else STOP |
| P2 | Authorization | S-mock: fixture `PAYMENT_AUTHORIZED`. S-TEST: `beginPayStep` (`repo.js:457`) → `startTestCheckout` (`stripe-test-webhook.js:182`) → Joel completes the TEST checkout → verified event → `processVerifiedStripeEvent` | one TEST session | state `payment_authorized`; PI `requires_capture` (S-TEST) |
| P3 | Reservation | `runOrchestratorStep` (`reservation-worker.js:585`), ≤ N steps (N fixed in the runner contract; each step bounded by `DEFAULT_TIMEOUTS`, `:78`) | **one create** max (`hcreate:{intent}`, non-idempotent, `repo.js:97–98`) | `reservation_confirmed` → Joel attests the **Airbnb block** (G9 checkpoint 1). `reservation_failed` → P6 |
| P4 | Capture | `runCaptureStep` (`capture-worker.js:600`; states `:47`) | **one capture** per accepted capture row (idempotency key `intent-state.js:251`) | `payment_captured`, else stop per §4.2 |
| P5 | Recording (U only; excluded in S-mock) | `runRecordingStep` (`recording-worker.js:598`); only the initial `och:{intent}:1` is ever eligible (`offline-charge-proof.js:21`) | **one create** max | `confirmed` → P7 (cleanup of a confirmed booking: manual, §4.3) |
| P6 | Failure compensation (only `reservation_failed` / `capture_failed`, `compensation-worker.js:50`) | `runCleanupStep` (`compensation-worker.js:643`) | one void + one cancel max | `authorization_released` / `cancelled` → Joel attests the **Airbnb reopen** (G9 checkpoint 2) |
| P7 | Report | journal close: phase decisions, provider-write counts, final states, Airbnb attestations, outbox rows still queued | — | root review of the journal |

**Maintenance:** only the accepted scoped forms (`recoverExpiredOperations` with `opTypes`, `intentId` and `listingIds`, `operations.js:441`), plus the workers' own recovery passes. **Excluded:**
- the global / unscoped generic maintenance (U2);
- any generic notify maintenance;
- the inbox drain fallback;
- `runNotificationStep`;
- any `alert.owner` dispatch.

### 4.2 State-based stops (the CLI never makes a new attempt, mints a new key or replays an uncertain write)

| Observed | Stop |
|---|---|
| success at each phase | pause for Joel, then the next phase |
| pre-capture refusal → `reservation_failed` | P6 only (void + host cancel), then report |
| `reservation_unknown` / `capture_unknown` / recording `UNKNOWN` / `OFFLINE_CHARGE_OUTCOME_UNKNOWN` case | STOP. The run ends after the worker's own bounded recovery read (if any) settles or escalates; no second write. Owner resolution only through the existing admin functions (`db/lib/admin.js`) |
| contradictory evidence (identity / amount / currency / ref mismatch, protected id anywhere) | STOP; no write; report the code |
| `reconciliation_required` / any open case | STOP; owner review |
| database COMMIT uncertainty (outer DB error) | STOP; the process exits; nothing is retried; the next start re-reads persisted state only |
| process restart | the CLI re-runs P0 and resumes ONLY from persisted state, through the same scoped step functions. A leased in-flight row is never re-sent; lease expiry → unknown by scoped maintenance |
| `payment_captured` that cannot be recorded (branch P, or recording refused) | STOP. **No automated exit exists.** This is a captured TEST charge on a real reservation, and it needs the owner-run manual cleanup in §4.3 |

### 4.3 Cleanup — decided before any create or capture

| Situation | Path | Status |
|---|---|---|
| Failure before capture | `runCleanupStep`: void (`compensation-proof.js:274–286`) + host cancel `PUT /v1/reservations/{id}/statuses/cancelled`, body `{cancelledBy:"host"}` (`compensation-proof.js:27`, `:421`) | Accepted offline; real path UNVERIFIED |
| `capture_failed` | same worker | reached offline only by a test-applied event |
| **Confirmed / captured booking** | **NOT IMPLEMENTED.** E3 never refunds or cancels captured money (`intent-state.js:547`); `runCleanupStep` does not run in `payment_captured` / `confirmed` | Two options, neither designed here: **(a)** an owner-run manual procedure. It must state: who cancels the Hostaway reservation and how; Stripe TEST refund or no refund; how the TEST-paid offline-charge row is reviewed and deleted or annotated (deletion support is UNVERIFIED); the read-only proof of each; and how the DB intent is resolved (`admin_resolve_intent`, `db/lib/admin.js:38`). **(b)** a future, separately designed automated cancel / refund path |
| Hostaway / Airbnb automations (guest messages, payment requests, tasks, channel e-mails) | **not controlled by this code**; `guest.notify` staying queued does not suppress them | Must be verified independently (side-effect reads as in E4: charges / conversations / tasks) and listed in the approval |

**G10 is not ready while §4.3 row 3 (if capture is in scope) has no chosen, written procedure.** In-run Airbnb: baseline (P0) → block after the create (P3) → reopen after the authorized cleanup (P6 or the manual procedure). Each step is attested with evidence; there is no action on existing reservations, blocked dates or prior journals.

## 5. Boundaries

1. **DB:** a disposable local PostgreSQL migrated to 0001–0016, marker `test` asserted at P0 and by every gate. No shared or live DB. No production env (`VERCEL_ENV` must be development / preview; the worker flags are set only in the CLI's own env object).
2. **Secrets:** entered by Joel locally at run time; never in files, journal, results, docs or chats; transports drop them after use (E4 pattern).
3. **Allowlist:** exactly one listing L and one intent id; any other id in a request → refusal before network. Protected-id check in every phase (`recording_protected_reservation_ids`, `0015:20–23`; `isProtectedReservationId`, `compensation-proof.js:24`).
4. **Stripe ingress for S-TEST (open root choice):** a hosted webhook route is **not** assumed (route packaging stays HOLD). Candidates for review: a local signed-event forwarder, or a server read of the event (`events.retrieve`, UNVERIFIED) before `processVerifiedStripeEvent`. Neither is designed here.
5. **Budgets:** the workers' fixed timeouts (`reservation-worker.js:78`, `capture-worker.js:51`, `compensation-worker.js:51`, `recording-worker.js:32`). A fixed step count per phase. One provider write per accepted operation. No live retries.
6. **Journal:** the manifest hash, baseline commit, phase start / end decisions, provider-call counts by key, codes only. Redacted: no tokens, guest contact, card or raw provider bodies.
7. **Retained residuals and their relevance here:**

| Residual | Matters to this test? |
|---|---|
| U2 | Yes as a rule: never call unscoped generic maintenance |
| Raw non-E3 INSERT | No writer in the run |
| Post-snapshot race / TRUST labels | Yes. Account labels are not verified ownership; the account check is `stripe.accounts.retrieve()` id equality (`capture-worker.js:219`). The Hostaway account identity is TRUST |
| e74a | No (test reliability) |
| N2 / N3 | No (notification excluded) |

## 6. Executor matrix (what a real adapter must do; nothing is built or probed here)

Path convention differs by worker and must be handled explicitly by an adapter: the reservation / capture / compensation reads use paths relative to `/v1` (`/reservations/{id}`), while recording and the compensation cancel use `/v1/...` paths.

| Worker.key | Request as built today (source) | Expected reply fields the proofs check | Provenance | LIVE-UNVERIFIED | Minimal read-only probe (separately approved) |
|---|---|---|---|---|---|
| reservation.pricing (`get` / `post`) | `GET /listings/{id}`, `GET /listings/{id}/calendar?startDate&endDate`, `POST /listings/{id}/calendar/priceDetails {startingDate, endingDate, numberOfGuests, version:2}` (`server-pricer.js:29–45`) | `currencyCode`, capacity / stay limits, day records, `totalPrice` / components | pre-E7 stages D / F (`api/hostaway/quote.js:1–12`) | the price for the chosen dates at run time | P1: listing + calendar + priceDetails for L and the dates (also G8) |
| reservation.lookupPage | `GET /reservations?listingId&channelId=2000&arrivalStartDate&arrivalEndDate&limit=100&includeResources=1[&afterId]` (`hostaway-reservations.js:443–457`) | items checked against every filter; ref in `customFieldValues` | documented params (`:96–100`) | which filters are honoured; ref presence | P2: lookup for L / arrival date (also proves "no existing reservation") |
| reservation.retrieveReservation, capture / compensation same | `GET /reservations/{id}` (`reservation-worker.js:237`, `capture-worker.js:250`, `compensation-worker.js:251`) | `normalizeReservation` fields (`hostaway-reservations.js:286`) | documented object; owner-observed E4 GET | id type (`:87`), status values | P3: GET of a non-protected reservation Joel names (or skip until P3 of the run) |
| reservation.createReservation | `POST /reservations` body per mapping (`hostaway-reservations.js:236–267`, `:69–83`), no query, channel 2000 | `classifyCreateResponse` (`:345`): id, listing, ref, dates, total, currency, channel, status `new` | documented; E4 connected run created and cancelled one reservation (owner-reported, 2026-11-02) | ref echo (E4 saw `ABSENT_EMPTY_ARRAY`), status `new`, total float | **write — no probe**; the run itself |
| capture.retrieveAccount / compensation | `stripe.accounts.retrieve()` (`stripe-test-webhook.js:57`) | `object:"account"`, `id === stripeAccountId` (`capture-worker.js:219`) | Stripe SDK `^20.3.1` (`package.json:12`) | TEST account id (Joel) | P4: one TEST-mode account read |
| capture.retrievePaymentIntent / compensation | `retrievePaymentIntent(pi, {expand:["latest_charge"]})` (`capture-worker.js:233`, `compensation-worker.js:231`) | `capture-proof.js:81–107` v3 observation: status, `amount_capturable`, `amount_received`, metadata, `capture_method` manual, latest charge (livemode false, paid, captured, `capture_before`) | E5a TEST slice; doc-derived | `capture_before` location; field set on the pinned API version | P5: TEST PI read (only after P2 of the run) |
| capture.capturePaymentIntent | `(piId, {amount_to_capture, final_capture:true, expand:["latest_charge"]}, {idempotencyKey})` (`capture-proof.js:197–211`, `capture-worker.js:437`) | reply re-proved by a fresh read | doc-derived | TEST reply shape | write — the run |
| compensation.cancelPaymentIntent | `(piId, {}, {idempotencyKey})` (`compensation-proof.js:274–286`, `compensation-worker.js:427`) | strict canceled read afterwards | doc-derived | — | write — the run |
| compensation.cancelReservation | `PUT /v1/reservations/{rid}/statuses/cancelled {cancelledBy:"host"}` (`compensation-proof.js:421`, `:27`) | confirming read | E4 connected run used the same verb and path (owner-reported); the E4 runner notes it is "not re-read from the official" docs (`scripts/e4-write-runner/runner.mjs:84`) | primary documentation **UNVERIFIED**, a prerequisite | write — the run |
| recording.retrieveReservation | `GET /v1/reservations/{rid}` (`recording-worker.js:222`) | identity snapshot | as above | — | P3 |
| recording.listOfflineCharges | `GET /v1/guestPayments/charges?reservationId&limit` (`recording-worker.js:223`) | single-page assessment: marker, title, amount, currency, status, `paymentMethod` (`offline-charge-proof.js:238`) | DOC-DERIVED; E4 read this path for side-effect checks (`scripts/e4-recovery/precheck.mjs:79`) | row fields, page semantics | P6: list for a non-protected reservation |
| recording.createOfflineCharge | `POST /v1/guestPayments/charges/{reservationId}` body exactly `{title, amount, paymentMethod, status:"paid", scheduledDate}` (`offline-charge-proof.js:359–375`) | create-reply candidate + confirming list | DOC-DERIVED only | **whole endpoint UNVERIFIED** (no live evidence); delete / void of such a row UNVERIFIED | none read-only; documentation review is a prerequisite |

## 7. Owner choices for the later consolidated approval (UNSET here)

1. Listing L and currency: branch U (recommended direction) or P.
2. Dates, guest identity (synthetic vs real person) and amount.
3. Verified Stripe TEST account and Hostaway account; `paymentMethod` (`credit_card` / `other`).
4. Provider mode (§2), and whether capture and recording are in scope.
5. Notification / automation scope: the in-repo guest email stays excluded. Which Hostaway / Airbnb automations are acceptable, and how they are checked.
6. Cleanup meaning and procedure (§4.3), including the TEST-paid artifact.

Routine technical choices are root's: CLI location, step counts, the ingress mechanism, journal format and adapter boundaries. Joel is not asked for those.

## 8. Recommended next offline implementation (NOT started)

**"E7 connected executor adapters — proof foundation".** Pure, injected adapters that turn each worker's executor call (§6) into exactly one documented transport request or Stripe SDK call. They refuse anything else before any network, and have no default transport.

**Proposed allowed files:**
- new `scripts/e7-connected/executor-adapters.mjs` (under `scripts/`, excluded from upload);
- new `test/e7-connected-executor-adapters.test.mjs`;
- a status pointer in this contract.

No `lib/`, SQL, worker, route, config or dependency change.

**Acceptance tests (offline, fake transport + fake Stripe client, global fetch guard):**
- For every key in §6: the exact method, path (with both path conventions normalized explicitly), query and body; and the exact SDK method, params and idempotency option.
- One call, no retry; timeouts via the worker's signal.
- Refusal, with zero calls, for: another listing or reservation id; a protected id; extra fields; `forceOverbooking`; any query on create.
- Replies are passed through unmodified to the accepted proofs. Errors are mapped to the workers' existing classes without leaking bodies.
- No secret is stored or returned.
- The accepted worker suites stay green, run against the adapters with fake transports.

**Genuine blockers:**
- None for this offline slice.
- For later gates:
  - the owner choices in §7;
  - primary documentation for the cancel and offline-charge endpoints;
  - the read-only probes P1–P6;
  - the confirmed-booking cleanup procedure.
