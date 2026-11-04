# E7 connected-test orchestration + live-gate manifest — CONTRACT (all changes PROPOSED)

**Status (2026-11-04):** root ACCEPTED `1df87d5a` as a conditional OFFLINE planning baseline (not a live approval package), with the cleanup-wording corrections applied below. The offline / injected-fake executor-adapter foundation is implemented on `feature/e7-connected-executor-adapters` (§9; pending root CODE review). Every live gate stays CLOSED; every owner input stays UNSET.

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
| **H-real / S-mock** | real account | in-memory mock (as the rehearsals) | authorization FIXTURE: `applyEvent(PAYMENT_AUTHORIZED)` with a synthetic PI, as in the E7 rehearsals | the reservation worker's real create / lookup / read path. **No automated exit for a successful reservation:** a pre-reservation refusal (`reservation_failed`) is an authorization void only (mock here), and this mode must not manufacture `capture_failed` or cancel a successfully reserved booking to fake an exit. A real reservation left standing needs an explicitly approved cleanup procedure even with no capture | **No card, no Stripe shape.** Capture would be mock-only. Recording would then write a REAL "paid" Hostaway row for money that never existed, so in this mode recording **must be excluded** (stop at `payment_captured` is not acceptable either, §4) |
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
| P6 | Failure compensation (only `reservation_failed` / `capture_failed`, `compensation-worker.js:50`), state-specific (`compensation-worker.js:103–107`) | `runCleanupStep` (`compensation-worker.js:643`) | `reservation_failed`: one authorization void max. `capture_failed`: the void (if the authorization is still unsettled) and the host cancel (if the reservation is not yet cancelled), per the accepted compensation plan, one each max | `authorization_released` / `cancelled` → Joel attests the **Airbnb reopen** (G9 checkpoint 2) |
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
| pre-reservation refusal → `reservation_failed` | P6: the authorization void only (no reservation was created, so no host cancel), then report |
| `reservation_unknown` / `capture_unknown` / recording `UNKNOWN` / `OFFLINE_CHARGE_OUTCOME_UNKNOWN` case | STOP. The run ends after the worker's own bounded recovery read (if any) settles or escalates; no second write. Owner resolution only through the existing admin functions (`db/lib/admin.js`) |
| contradictory evidence (identity / amount / currency / ref mismatch, protected id anywhere) | STOP; no write; report the code |
| `reconciliation_required` / any open case | STOP; owner review |
| database COMMIT uncertainty (outer DB error) | STOP; the process exits; nothing is retried; the next start re-reads persisted state only |
| process restart | the CLI re-runs P0 and resumes ONLY from persisted state, through the same scoped step functions. A leased in-flight row is never re-sent; lease expiry → unknown by scoped maintenance |
| `payment_captured` that cannot be recorded (branch P, or recording refused) | STOP. **No automated exit exists.** This is a captured TEST charge on a real reservation, and it needs the owner-run manual cleanup in §4.3 |

### 4.3 Cleanup — decided before any create or capture

| Situation | Path | Status |
|---|---|---|
| `reservation_failed` (refused before any reservation exists) | `runCleanupStep`: authorization void only (`compensation-proof.js:274–286`) | Accepted offline; real path UNVERIFIED |
| `capture_failed` | `runCleanupStep`, conditional per the accepted plan (`compensation-worker.js:103–107`): void if still unsettled; host cancel `PUT /v1/reservations/{id}/statuses/cancelled`, body `{cancelledBy:"host"}` (`compensation-proof.js:27`, `:421`), if not yet cancelled | Reached offline only by a test-applied event; the cancel endpoint is ASSUMED / LIVE-UNVERIFIED |
| A **successfully reserved** booking that does not reach `confirmed` (e.g. H-real / S-mock, or a stopped run) | **none automated**; never fake `capture_failed`, never cancel through the compensation worker | An explicitly approved owner cleanup procedure, exactly like the captured / confirmed row below |
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

## 9. Implementation map — executor-adapter foundation (OFFLINE / INJECTED FAKES; pending root CODE review)

**Branch** `feature/e7-connected-executor-adapters`, cut from exact `1df87d5aea0f70bbd95659d46c749d93cd5ce38d`. **Files:** new `scripts/e7-connected/executor-adapters.mjs`; new `test/e7-connected-executor-adapters.test.mjs`; this section + the status line and cleanup corrections above.

**Not changed:** workers, `lib/`, SQL, config, routes, packages, other tests.

**Not present:** runner, CLI entrypoint, credential loader, default / real transport, SDK construction, env access, `fetch`.

### 9.1 Factory interface (injection mandatory)

`createPhaseExecutors({ phase, binding, hostaway, stripe? })` returns `{ ok:true, executors }` or `{ ok:false, code }`.

| Argument | Rule |
|---|---|
| `phase` | `reservation`, `capture`, `cleanup` or `recording` |
| `binding` | exactly `BINDING_KEYS[phase]`, plus the optional `pilotException` |
| `hostaway` | exactly `{ send }`, always required |
| `stripe` | exactly `{ send }`; required for capture / cleanup, refused otherwise |

Refusal codes: `OPTIONS_INVALID`, `PHASE_INVALID`, `BINDING_INVALID`, `TRANSPORT_INVALID`.

How inputs are read:
- **Synchronous, one pass.** Option and binding validation is synchronous: each object is read once through its own data properties (the R-G1 rules).
- **What is refused:** accessors, symbol keys, non-enumerable, extra or missing keys, `__proto__` keys, non-plain prototypes, sparse or iterator-patched arrays, and hostile or revoked proxies. No getter or iterator ever runs.
- **What is caught:** only this introspection is caught; transports are never invoked by the factory.
- **What is kept:** the binding is kept as a deep-frozen copy, so later caller mutation changes nothing. Transport functions are called unbound.

`executors` has exactly the key set of that worker's gate (`PHASE_KEYS`; recording adds the TRUST `label`), and is frozen. All four accepted gates accept the factories' outputs (test 1).

**Injected transport interfaces (documented here; not an SDK convention):**
- `hostaway.send(request, { signal })` → `Promise<{ httpStatus: int 100–599, json }>`.
  - `request` is frozen `{ method, path, query, body? }`.
  - `path` always has exactly ONE `/v1` prefix.
  - `query` / `body` are frozen data copies.
- `stripe.send(call, { signal })` → `Promise<raw Stripe object>`.
  - `call` is frozen `{ op }` with `op` ∈ `accounts.retrieve`, `paymentIntents.retrieve`, `paymentIntents.capture`, `paymentIntents.cancel`, plus `id`, `params` and `idempotencyKey` where applicable.
  - A future real implementation must map this to the SDK with **zero automatic retries**, including SDK and auth retries, proven by its own reviewed tests. A fake or a label does not establish that.
  - `lib/hostaway.js` is not reused as a write transport.

### 9.2 Scope binding (immutable per factory instance)

| Phase | Binding keys | Notes |
|---|---|---|
| reservation | `listingId, arrivalDate, departureDate, ref, guests, totalMinor, currency, refFieldId, guest{firstName,lastName,email}, reservationId:null` | The creation / lookup factory never has a bound id. `retrieveReservation` refuses `RESERVATION_UNBOUND`; a later id-bound phase uses a new factory |
| capture | `listingId, arrivalDate, departureDate, ref, reservationId, accountId, paymentIntentId, amountMinor, captureIdempotencyKey` | — |
| cleanup | `listingId, arrivalDate, departureDate, ref, reservationId (or null for the void-only reservation_failed path), accountId, paymentIntentId, voidIdempotencyKey` | — |
| recording | `listingId, reservationId, intentId, amountMinor, paymentMethod (credit_card / other), accountRef, clientSnapshotId` | The label is TRUST, not verified ownership |

Rules that apply to every phase:
- **Bound id source.** No id is ever adopted from a reply. The Hostaway lookup cursor `afterId` is accepted only as an opaque positive integer and only on the lookup path. The future runner must take every bound value from accepted persisted worker proof / journal (outside this slice).
- **Protected ids.** Protected ids 70636076 / 71045356 / 71072615 / 71081885 are refused in every binding, and again before every id-bound call.
- **Pilots.**
  - 603564: always refused.
  - 603566: only with `pilotException: "E4_CONNECTED_603566_MXN"`, never with USD, never for recording (USD-only).
  - The exception flag is refused on any other listing.
  - The workers' own branded adapter config remains required separately.

### 9.3 Executor keys, worker arguments and mapping

The worker call sites are pinned verbatim by test 2 at this baseline.

| Phase.key | Worker call (signal position) | Validated against the binding | Injected call |
|---|---|---|---|
| reservation.pricing.get | `(path, { query?, timeoutMs, signal })` (`reservation-worker.js:110`) | path `/listings/{L}` (no query) or `/listings/{L}/calendar` with exactly `{startDate: arrival, endDate: departure}` | `GET /v1/listings/{L}[/calendar]`; the reply is returned as `{ status, json }` (the pricing contract, `server-pricer.js:29–45`) |
| reservation.pricing.post | `(path, body, { timeoutMs, signal })` (`:111`) | `/listings/{L}/calendar/priceDetails`, body exactly `{startingDate, endingDate, numberOfGuests: guests, version: 2}` | `POST /v1/listings/{L}/calendar/priceDetails` → `{ status, json }` |
| *.lookupPage | `(req, { signal })` (`reservation-worker.js:211`, `capture-worker.js:280`, `compensation-worker.js:280`) | `GET /reservations`, query exactly `{listingId: L, channelId: 2000, arrivalStartDate = arrivalEndDate = arrival, limit: 100, includeResources: 1[, afterId: int]}` | `GET /v1/reservations` → `{ httpStatus, json }` |
| *.retrieveReservation | `(req, { signal })` (`reservation-worker.js:238`, `capture-worker.js:252`, `compensation-worker.js:253`, `recording-worker.js:217`) | `GET /reservations/{bound}` or `/v1/reservations/{bound}`, empty query | `GET /v1/reservations/{bound}` |
| reservation.createReservation | `(request, { signal })` (`reservation-worker.js:366`) | `POST /reservations`, **empty query** (no `forceOverbooking` / `provider` / anything). Body exactly the 12 mapped fields (`hostaway-reservations.js:252–265`), each equal to the binding (listing, dates, guests, `exactAmount(totalMinor)`, currency, guest names / e-mail, channel 2000, `customFieldValues = [{refFieldId, ref}]`). `forceOverbooking` anywhere is refused | `POST /v1/reservations` |
| capture.retrieveAccount / cleanup | `({ signal })` (`capture-worker.js:217`, `compensation-worker.js:215`) | options exactly `{signal}` | `{op:"accounts.retrieve"}`; the worker itself checks `id === stripeAccountId` (`capture-worker.js:219`) |
| *.retrievePaymentIntent | `(pi, { expand:["latest_charge"] }, { signal })` (`capture-worker.js:233`, `compensation-worker.js:231`) | `pi` = bound PI; params exactly `{expand:["latest_charge"]}` | `{op:"paymentIntents.retrieve", id, params}` |
| capture.capturePaymentIntent | `(pi, { amount_to_capture, final_capture, expand }, { idempotencyKey, signal })` (`capture-worker.js:437–438`) | bound PI; `amount_to_capture = amountMinor`; `final_capture: true`; expand latest_charge; `idempotencyKey` = the bound key exactly (never a new or implicit key) | `{op:"paymentIntents.capture", id, params, idempotencyKey}` |
| cleanup.cancelPaymentIntent | `(pi, {}, { idempotencyKey, signal })` (`compensation-worker.js:427`) | bound PI; empty params; bound void key | `{op:"paymentIntents.cancel", id, params:{}, idempotencyKey}` |
| cleanup.cancelReservation | `(req, { signal })` (`compensation-worker.js:521`) | `PUT /v1/reservations/{bound}/statuses/cancelled` (either prefix form), empty query, body exactly `{cancelledBy:"host"}` | `PUT /v1/reservations/{bound}/statuses/cancelled` — **ASSUMED / LIVE-UNVERIFIED** |
| recording.listOfflineCharges | `(req, { signal })` (`recording-worker.js:217`, `:223`) | `GET /v1/guestPayments/charges`, query exactly `{reservationId: bound, limit: 500}` | `GET /v1/guestPayments/charges` |
| recording.createOfflineCharge | `(plan.request, { signal })` (`recording-worker.js:439`) | `POST /v1/guestPayments/charges/{bound}`, empty query, body exactly `{title: offlineChargeTitle(intentId), amount: exactAmount(amountMinor), paymentMethod: bound, status:"paid", scheduledDate: 'YYYY-MM-DD HH:MM:SS'}` | `POST /v1/guestPayments/charges/{bound}` — **ASSUMED / LIVE-UNVERIFIED** |

**Path rule.** The outgoing path is always constructed from the binding, never copied from the worker. A worker path is accepted only if it equals one of the two exact accepted forms (relative or `/v1`-prefixed), so these are all refused:
- absolute URLs, `//host`, `/v1/v1`;
- traversal and encoded separators;
- `?` / `#` in the path;
- case changes and leading zeros.

There is no pass-through facility.

### 9.4 Replies, errors, cancellation (no new policy)

**Replies.**
- Hostaway: `{ httpStatus, json }` is passed through with `json` untouched. 404, 429, 5xx and 201 are returned as they are, so the workers' accepted classifiers decide. An ambiguous write reply is never converted into a definite failure.
- Pricing: only the envelope is renamed, to `{ status, json }`.
- Stripe: the raw object is returned unchanged.

**Errors.** The accepted workers treat any executor rejection as a transport failure: a bounded read retry or an `unknown`, never definite.
- `ExecutorRefusal(code)`: refused **before** invocation, zero transport calls. For a write, the worker therefore records an unknown. This is conservative; the future journal records the refusal code.
- `ExecutorTransportFailure("TRANSPORT_FAILED")`: the single invocation threw or rejected. The original error, message, body and credentials are never read or kept (asserted with a planted secret).
- `ExecutorTransportFailure("TRANSPORT_REPLY_SHAPE")`: a non-envelope Hostaway reply. Only exact `{httpStatus: int 100–599, json}` is accepted.

**Invocation and cancellation.**
- Exactly ONE injected invocation per adapter call, no retry.
- The worker's `AbortSignal` is passed as `{ signal }`.
- A missing, fake or already-aborted signal is refused before invocation.

Cross-process at-most-once remains the accepted DB operation fence plus the future journal, not anything in memory.

### 9.5 Tests and results (CLAUDE-RUN)

`test/e7-connected-executor-adapters.test.mjs` has 12 tests, all synthetic, with a global fetch guard (0 network attempts):
1. **Factories and gates:** the factories' key sets are accepted by all four real worker gates.
2. **Source pins:** the worker call-site source is pinned.
3. **Positive mapping:** exact mapping for every key; one invocation each; `/v1` normalisation; replies passed through.
4. **Scope refusals:** 34 cases with zero calls — listing, dates, ref, amount, guest, extra fields, `forceOverbooking`, create query, method, PI, params, idempotency key, cancel body, list query, charge amount / method / extra field / other reservation.
5. **Path bypasses:** 11 cases.
6. **Bindings:** protected ids, pilot rules, malformed and missing values.
7. **Descriptor and mutation probes:** factory options and call arguments; getter / iterator runs = 0.
8. **Signals.**
9. **Transport outcomes:** throws and rejects (no leak), bad envelopes, status passthrough, an ambiguous create not classified as refused.
10. **Compatibility with the accepted pure helpers:** `priceStay` through `pricing`, `buildCreateReservationRequest` → `createReservation` → `classifyCreateResponse` = `created`, `lookupByRef` through `lookupPage` = `found`.
11. **Void-only cleanup factory:** cancel and id reads refused.
12. **Constant parity with the pure Hostaway adapter**, and the module source has no network / env / SDK / `lib/hostaway.js` import.

| Run | Result |
|---|---|
| Focused | 12 / 12 |
| `npm test` | **733 / 733** (721 + 12) |
| Targeted mutants A01–A12 | 11 caught. **A08** (double-`/v1` normalisation) survived as an **equivalent** mutant: the outgoing path is built from the binding, so the normalisation branch is unreachable |

No PG run was needed: the compatibility tests use the accepted gates and pure helpers directly, so no DB-backed worker integration was run. TAP: `gnf/tap/ead-*.tap`.

**Deviation.** The module does **not** import `lib/hostaway-reservations.js`. That module's importer set is pinned by two accepted containment tests (`test/hostaway-reservations.test.mjs:544–569`, `test/e4-connected-path.test.mjs:404–421`), which are outside the allowed files. Instead, five constants and `isRealDate` are local copies, asserted equal to the pure adapter's exports (test 12). Amounts use `exactAmount` from `offline-charge-proof.js`.

**Residuals.**
- Full worker-in-PG runs over these adapters, and the real transports, belong to the future runner slice.
- The fake tests prove mapping only.
- The cancel and offline-charge endpoints remain prerequisites (primary documentation / read-only probes).
- Hostaway account identity remains TRUST.

