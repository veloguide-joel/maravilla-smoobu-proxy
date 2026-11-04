# E7 connected-test runner — TRANSPORT SAFETY CONTRACT, revision 1 (DOCS ONLY; proposed Slice T; not implemented, not authorized)

**Branch** `feature/e7-connected-transport-contract`, cut from exact `14d975ab` (A–F + the file-journal rehearsal ACCEPTED offline). Files: this new contract + a status pointer in `claude/e7-connected-file-journal-rehearsal.md`. No code, test, run, config, dependency, core, worker, adapter, SQL or UI change. Public official documentation was read (read-only) for §5; no API request, login, probe, token, key or provider write.

**What this is.** The smallest next OFFLINE layer: two transport factories that turn the accepted executor adapters' envelopes into exactly one HTTP exchange each — through an **injected** exchange function, never a default network path. It prepares later read-only probes and Stripe TEST use.

**What it is not.** A credential / env loader, CLI, SDK choice, token minting, retry layer, Stripe ingress, live approval or permission to connect. **No accepted manifest authorizes a real connection:** A refuses `synthetic !== true` (`REAL_RUN_NOT_IN_THIS_SLICE`) and any `providerMode` other than `{ hostaway:'fake', stripe:'mock' }` (`PROVIDER_MODE_NOT_IN_THIS_SLICE`) — `scripts/e7-connected/run-manifest.mjs:134–135`. Even an implemented transport stays synthetic-only until a separately reviewed mode / gate change. Owner inputs UNSET; live gates CLOSED; protected reservations 70636076 / 71045356 / 71072615 / 71081885 zero-action; notification / owner-alert sending CLOSED; e74a OPEN.

**Citation convention.** `file:line` at `14d975ab`. Adapters = `scripts/e7-connected/executor-adapters.mjs`.

## 0. Decisions at a glance

| # | Decision |
|---|---|
| T1 | New module `scripts/e7-connected/http-transports.mjs`: `createE7HostawaySend(opts)` → frozen `{ send(request, { signal }) }` and `createE7StripeTestSend(opts)` → frozen `{ send(call, { signal }) }`, exactly the injected shapes the adapters require (`createPhaseExecutors`, adapters `:418–448`: `{ send }` only) |
| T2 | Every network effect goes through an **injected** `exchange({ method, url, headers, body, signal, maxBytes })` → native `Promise<{ status, contentType, bytes }>`. The module imports no `fetch`, `node:http(s)`, `undici`, SDK, env, timer or file API. The real exchange implementation is a later, separately reviewed slice (recommendation §2.4) and stays CLOSED |
| T3 | Fixed hosts `https://api.hostaway.com` and `https://api.stripe.com`; the URL is built only by this module from an exact per-operation allowlist (§1); no host / path / port / scheme override; redirects never followed (a 3xx is a code-only failure) |
| T4 | **One exchange per `send`, at most.** No retry, no backoff, no token refresh / re-mint, no 401 / 403 re-attempt, no redirect follow, no second write after an ambiguous outcome |
| T5 | Credentials come from an injected, synchronous `credential()` callback read **once per send** and never stored, logged, returned, thrown or journaled; Stripe accepts **TEST-mode secret keys only** (§3) |
| T6 | Bounded response bytes; response consumed once; code-only failures (`E7TransportError(code)`); HTTP statuses passed through for Hostaway, mapped to a code-only rejection for Stripe non-2xx (the adapters already discard error content, adapters `:210–224`) |
| T7 | Official-doc evidence (§5): Stripe paths / encoding / idempotency / version / key prefixes **documented**; Hostaway base / auth / several paths documented, but **cancel**, **create offline charge** and the **charge-list filter parameter** could not be established from reachable official text → those three mappings stay **UNVERIFIED and blocked** for any real wiring |

## 1. Exact envelope → HTTP mapping (from the accepted adapters)

### 1.1 Hostaway (`send(request, { signal })` → `{ httpStatus, json }`)
The adapter passes a frozen `{ method, path:'/v1/…', query, body? }` (`hostawayRequest`, adapters `:226–230`; path forms enforced by `workerRequest`, `:232–239`). The transport re-validates independently (defence in depth) against exactly these nine forms; `{L}` = a positive integer listing id, `{R}` = `^[1-9][0-9]{0,15}$` and not protected:

| # | Adapter key | Method | Path | Query (exact keys) | Body | Doc status (§5) |
|---|---|---|---|---|---|---|
| H1 | `lookupPage` (`:248–258`) | GET | `/v1/reservations` | `listingId, channelId(2000), arrivalStartDate, arrivalEndDate, limit(100), includeResources(1)` [+ `afterId`] | — | path + `includeResources` + `afterId` documented; other params not seen |
| H2 | `retrieveReservation` (`:259–266`, `:379–384`) | GET | `/v1/reservations/{R}` | none | — | section exists; path not retrieved |
| H3 | `pricing.get` listing (`:275–281`) | GET | `/v1/listings/{L}` | none | — | listings section documented (list form) |
| H4 | `pricing.get` calendar (`:282–286`) | GET | `/v1/listings/{L}/calendar` | `startDate, endDate` | — | path documented |
| H5 | `pricing.post` (`:289–296`) | POST | `/v1/listings/{L}/calendar/priceDetails` | none | `{ startingDate, endingDate, numberOfGuests, version:2 }` | path documented (rate-limit table) |
| H6 | `createReservation` (`:300–318`) | POST | `/v1/reservations` | **none** (no `forceOverbooking`) | the 12 bound fields | path documented; `channelId` 2000 accepted |
| H7 | `cancelReservation` (`:363–374`) | PUT | `/v1/reservations/{R}/statuses/cancelled` | none | `{ cancelledBy:'host' }` | **UNVERIFIED — blocked** |
| H8 | `listOfflineCharges` (`:385–391`) | GET | `/v1/guestPayments/charges` | `reservationId, limit(500)` | — | list exists, `limit` ≤ 500 documented; **filter param documented as `reservationIds` → UNVERIFIED — blocked** |
| H9 | `createOfflineCharge` (`:393–402`) | POST | `/v1/guestPayments/charges/{R}` | none | `{ title, amount, paymentMethod, scheduledDate, status:'paid' }` | **UNVERIFIED — blocked** |

- URL: `https://api.hostaway.com` + path + (query: keys sorted, each value a string / safe integer, `URLSearchParams` encoding). Any other method / path / key / value type → `E7TransportError('REQUEST_NOT_ALLOWED')` with zero exchanges.
- Headers (exact): `Authorization: Bearer <token>`, `Accept: application/json`, `Cache-control: no-cache` (documented for the token call; kept as the accepted E4 transport did), and for H5 / H6 / H7 / H9 `Content-Type: application/json` with `JSON.stringify(body)` of the adapter's frozen snapshot. No other header; no caller header.
- Reply: `httpStatus` = the exchange's integer status (100–599, else `REPLY_INVALID`); `json` = the parsed body when it is non-empty valid JSON within the byte bound, else `null`. 2xx / 4xx / 5xx are passed through **unchanged** — the workers and proofs classify them (a 403 is just a 403: no re-mint).

### 1.2 Stripe (`send(call, { signal })` → the raw Stripe object)
The adapter passes a frozen `{ op, id?, params?, idempotencyKey? }` (`stripeKeys`, adapters `:321–361`). Exactly four ops:

| # | `op` | Method | Path | Encoding | Idempotency | Doc status |
|---|---|---|---|---|---|---|
| S1 | `accounts.retrieve` (`:324–327`, no id) | GET | `/v1/accounts/{boundAccountId}` | — | none (GET) | documented path `GET /v1/accounts/:id`; the transport is bound to the manifest's `stripeAccountId`; the undocumented `/v1/account` form is **not** used |
| S2 | `paymentIntents.retrieve` (`:329–335`) | GET | `/v1/payment_intents/{pi}` | query `expand[]=latest_charge` | none | documented (path; `expand[]` syntax) |
| S3 | `paymentIntents.capture` (`:337–346`) | POST | `/v1/payment_intents/{pi}/capture` | form: `amount_to_capture=<int>&final_capture=true&expand[]=latest_charge` | header `Idempotency-Key: <bound capture key>` | documented |
| S4 | `paymentIntents.cancel` (`:348–357`) | POST | `/v1/payment_intents/{pi}/cancel` | empty form body (no `cancellation_reason`) | header `Idempotency-Key: <bound void key>` | documented |

- URL: `https://api.stripe.com` + path; `{pi}` must equal the factory-bound PaymentIntent id (the adapter already binds it; the transport re-checks against its own binding).
- Headers (exact): `Authorization: Bearer <test key>` (documented alternative to Basic), `Stripe-Version: <pinned version>` (§3.3), `Content-Type: application/x-www-form-urlencoded` for S3 / S4, `Idempotency-Key` for S3 / S4 only (Stripe: "Don't send idempotency keys in GET and DELETE requests"). No `Stripe-Account` header (no Connect).
- Reply: 2xx with a JSON object within bounds → that object (frozen deep copy); **then** `livemode !== false` → `E7TransportError('LIVEMODE_REFUSED')` (defence in depth; the accepted proofs already require `livemode === false`, `lib/checkout/capture-proof.js:97`, `lib/checkout/compensation-proof.js:184`). Any non-2xx, non-JSON, oversize or non-object body → code-only `E7TransportError('STRIPE_HTTP_<status class>' | 'REPLY_INVALID' | 'BODY_TOO_LARGE')`. The adapter maps every rejection to `TRANSPORT_FAILED` (adapters `:221–224`), and the workers treat that as a transport failure / unknown, never a definite refusal — so a genuine Stripe decline (402) is conservatively an unknown that needs reconciliation reads (residual R3).

## 2. Abort, deadline, body ownership

### 2.1 Signal
- The adapter has already checked the GENUINE `AbortSignal` natively before the call (`nativeAborted`, adapters `:139–148`, `stillLive` `:158`). The transport re-reads the options object through one own-data-descriptor snapshot (exactly `{ signal }`), re-checks the signal with the same captured intrinsic `aborted` getter (no caller getter, iterator, `instanceof` or method runs), refuses `ABORTED` with zero exchanges, and passes **the same signal object** to `exchange`.
- The transport owns no timer and no deadline: the worker's per-call timer + `AbortController` (e.g. `reservation-worker.js:96–108`) is the deadline. An abort after the exchange started is the exchange's to honour (the later real implementation passes it to the HTTP client); the transport then rejects `ABORTED_IN_FLIGHT`.
- **An abort / timeout never proves absence.** A write whose exchange started may have been applied (HTTP, proxy, server).

### 2.2 Response bytes
- `maxBytes` (routine: Hostaway 1 MiB — the charge list ≤ 500 rows; Stripe 256 KiB) is passed to `exchange`, which must stop reading beyond it; the transport re-checks `bytes.length ≤ maxBytes` (else `BODY_TOO_LARGE`) and decodes once (fatal UTF-8, then `JSON.parse` once, depth-bounded like the file journal's scan). The body is consumed exactly once; nothing of it enters an error, log, diagnostic or journal.
- `exchange` results are snapshotted getter-free (exact keys `status`, `contentType`, `bytes`; `bytes` a `Uint8Array`); anything else → `REPLY_INVALID`. An `exchange` rejection → `E7TransportError('EXCHANGE_FAILED')`; the original error object is never read beyond a native type check, never kept or returned.

### 2.3 One invocation ≠ one server-side effect (stated, not hidden)
- The transport guarantees **at most one `exchange` call per `send`** and never resends. It does **not** guarantee one server-side effect: a client library, OS, proxy or load balancer may replay a request on a broken connection; a request can be applied even if the reply is lost or the abort fired.
- Stripe S3 / S4 carry the DB-persisted idempotency key, so a duplicate delivery with identical parameters returns the saved first result (Stripe: v1 saves "the status code and body of the first request … after endpoint execution begins"; keys may be pruned after ≥ 24 h). Hostaway H6 / H7 / H9 have no documented idempotency mechanism → an ambiguous write stays an unknown handled by the accepted DB operation fence and reads (never resent by this layer or the runner).

### 2.4 Recommended later real exchange (CLOSED now)
Node's built-in `fetch` (no new dependency): `redirect: 'error'`, the worker's `signal`, `cache: 'no-store'`, `keepalive: false`, the body read through `response.body.getReader()` with a running byte count that cancels the stream beyond `maxBytes`; no `fetch` wrapper retry, no global dispatcher change. Its own review must confirm the installed Node / undici version performs no automatic request retry for these calls. Not implemented, not authorized.

## 3. Credentials and TEST boundary (future wrapper; CLOSED)

### 3.1 Injected credential callbacks (no loader here)
- `createE7HostawaySend({ exchange, credential, maxBytes? })`: `credential()` → a non-empty token string; called synchronously once per `send` immediately before the exchange; the token is placed only in the `Authorization` header object handed to `exchange`, then dropped. **Token acquisition (`POST /v1/accessTokens`, ≥ 1 s activation delay, long expiry) and expiry handling stay a separate CLOSED slice;** a 401 / 403 is passed through, never answered by a re-mint.
- `createE7StripeTestSend({ exchange, credential, accountId, paymentIntentId, apiVersion, maxBytes? })`: binds the account and PaymentIntent of the phase factory; `credential()` → the key.

### 3.2 Stripe TEST-only checks (where they fire)
1. **Construction:** `accountId` matches `^acct_[A-Za-z0-9]{1,64}$` and equals the manifest's `stripeAccountId`; `apiVersion` is the pinned string (§3.3).
2. **Every send, before the exchange:** the key must start with `sk_test_` (documented test-mode secret prefix). Any `sk_live_` / `rk_live_` (documented live prefixes), any other prefix, or an empty / non-string value → `E7TransportError('KEY_NOT_TEST')`, zero exchanges. A restricted TEST key prefix is not established by the docs read here, so restricted keys are refused for now.
3. **Every reply:** `livemode === false` required (`LIVEMODE_REFUSED` otherwise; a write may already be applied → treated as unknown and a hard stop).
4. **S1 reply:** the worker already checks `id === stripeAccountId` (capture `capture-worker.js:219`). The account label (`hostawayAccountLabel`) remains TRUST, not ownership (adapters `:403`).
- Keys / tokens never enter records, results, errors, diagnostics or the journal (the journal schema has no field for them; D validates every record).
- Verified Stripe event ingress (`processVerifiedStripeEvent`) stays a separate CLOSED slice.

### 3.3 Stripe API version
Stripe chooses the version from the `Stripe-Version` header, else an SDK pin, else the account default (docs `api-versions`). The transport therefore **always** sends an explicit, reviewed `Stripe-Version`. Which version the accepted proofs' field expectations (`latest_charge` expansion, `amount_capturable`, `livemode`, `payment_method_details.card.capture_before`) are verified against is a **blocker for real wiring** (B4): it must be settled by a read-only probe review, not guessed. The repository's draft checkout code uses `2022-11-15` (`lib/stripe-checkout-draft.js:98`), which is not evidence for the workers.

## 4. Errors and redaction
- `E7TransportError(code)` (frozen; `message` fixed `'E7_TRANSPORT_ERROR'`; `code` from a fixed list: `OPTIONS_INVALID, REQUEST_NOT_ALLOWED, ABORTED, ABORTED_IN_FLIGHT, CREDENTIAL_INVALID, KEY_NOT_TEST, EXCHANGE_FAILED, REDIRECT_REFUSED, REPLY_INVALID, BODY_TOO_LARGE, JSON_INVALID, LIVEMODE_REFUSED, STRIPE_HTTP_4XX, STRIPE_HTTP_5XX`).
- Never in an error, result or diagnostic: URL, path ids, query, body, headers, token, key, account id, provider body, the exchange's error object or message.
- A test-only recorder may capture `{ method, url, headerNames, body }` with `Authorization` redacted to `'<redacted>'`; it is a test helper, not part of the module.

## 5. Official public-documentation evidence (read-only, 2026-11-04)

| Claim | Status | Official source |
|---|---|---|
| Stripe base `https://api.stripe.com`; form-encoded request bodies; JSON responses; key decides live vs sandbox | DOCUMENTED | [docs.stripe.com/api](https://docs.stripe.com/api/?lang=node) |
| `GET /v1/payment_intents/:id` | DOCUMENTED | [Retrieve a PaymentIntent](https://docs.stripe.com/api/payment_intents/retrieve.md) |
| `POST /v1/payment_intents/:id/capture`; `amount_to_capture` ≤ original; `final_capture` default true (false only with multicapture); requires `requires_capture` | DOCUMENTED | [Capture a PaymentIntent](https://docs.stripe.com/docs/api/payment_intents/capture) |
| `POST /v1/payment_intents/:id/cancel`; cancellable from `requires_capture`; remaining `amount_capturable` refunded; error if already canceled | DOCUMENTED | [Cancel a PaymentIntent](https://docs.stripe.com/api/payment_intents/cancel) |
| `GET /v1/accounts/:id` (the reference lists no `/v1/account` path) | DOCUMENTED (`:id` form only) | [Accounts](https://docs.stripe.com/api/accounts), [Retrieve account](https://docs.stripe.com/api/accounts/retrieve?api-version=2025-11-17.preview) |
| `expand[]` request syntax, depth ≤ 4, usable on any endpoint | DOCUMENTED | [Expanding responses](https://docs.stripe.com/api/expanding_objects?api-version=2026-05-27.preview) |
| `Idempotency-Key` on POST; first result (incl. 500) saved after execution begins; ≥ 24 h pruning; param mismatch errors; not for GET | DOCUMENTED | [Idempotent requests](https://docs.stripe.com/api/idempotent_requests.md) |
| Version from `Stripe-Version` header → SDK pin → account default | DOCUMENTED | [How API versioning works](https://docs.stripe.com/api-versions) |
| Basic or Bearer auth; HTTPS only; `sk_test_` test secret, `sk_live_` / `rk_live_` live prefixes | DOCUMENTED (restricted TEST prefix not shown) | [Authentication](https://docs.stripe.com/api/authentication?lang=curl), [edge reference](https://edge-docs.stripe.com/api/authentication) |
| HTTP status meanings incl. 402 request failed, 409 idempotency conflict, 429, 5xx | DOCUMENTED | [Errors](https://docs.stripe.com/api/errors) |
| Hostaway base `https://api.hostaway.com` + `/v1`; HTTPS / JSON; `POST /v1/accessTokens` (form, `client_credentials`, `scope=general`, `Cache-control: no-cache`); `Authorization: Bearer`; ≥ 1 s activation; 403 ⇒ token invalid | DOCUMENTED | [Hostaway Public API Reference](https://api.hostaway.com/documentation) |
| `GET /v1/reservations`; `includeResources=1` attaches custom field values; `afterId` cursor; `offset` deprecated | DOCUMENTED | same; [hostaway.github.io/api](https://hostaway.github.io/api/) |
| `listingId`, `channelId`, `arrivalStartDate`, `arrivalEndDate`, `limit` on the reservations list | NOT ESTABLISHED in the reachable official text (the fetched reference text ends inside the Listings section) | — |
| `POST /v1/reservations` (rate-limit table); `channelId` must be 2000 / 2002 / 2020 | DOCUMENTED; body fields / `forceOverbooking` not retrieved | Hostaway reference changelog |
| `GET /v1/listings/{id}/calendar`; `POST /v1/listings/{id}/calendar/priceDetails` | DOCUMENTED (paths); bodies not retrieved | Hostaway reference |
| **Cancel reservation** — an official section `reservation_cancelReservation` exists (and "cancel responses" are in the changelog) | method / path / body **NOT retrieved → UNVERIFIED** | [official doc source index](https://github.com/Hostaway/api/blob/master/source/index.html.md) |
| **Create offline charge** — official section `guestPayment_createOfflineCharge` exists; "create offline charges" added 2023-08-25; refund endpoint documented as `POST /v1/guestPayments/charges/{reservationId}/{chargeId}/refund` (consistent with, but not proof of, H9) | method / path / body **NOT retrieved → UNVERIFIED** | official index above; [Hostaway/api PR #65](https://github.com/Hostaway/api/pull/65) |
| **Get guest charges list** — `limit` default 100 / max 500 (matches `LIST_LIMIT 500`, `offline-charge-proof.js:35`); the documented filter is **`reservationIds`** (≤ 200 ids) | path not retrieved; **the adapter's `reservationId` filter is UNVERIFIED** | Hostaway reference changelog (2026-10-02) |

Limits of this evidence: the per-endpoint include files of the official Hostaway source repository were not reachable from this session (robots / allowlist), and the rendered reference text available to the fetcher ends before the reservation and guest-payment sections. Nothing above was guessed; reply SHAPES of every Hostaway write remain LIVE-UNVERIFIED regardless.

**Consequence (blocks only these mappings):** H7 cancel, H9 create offline charge and H8's filter parameter are **blocked for any real wiring** until the official section text is obtained (owner / root copies the three sections, or a reviewed retrieval) and compared. The accepted FAKE mappings stay unchanged (no adapter change). The charge-list proof already fails closed on foreign rows (`IDENTITY_RESERVATION_ID_MISMATCH`, `offline-charge-proof.js:218`), so a wrongly-named filter cannot misattribute a charge — but it could make the proof refuse, which must be known before any real use.

## 6. Proposed Slice T — smallest offline implementation (not authorized)

**Allowed files (proposed):** new `scripts/e7-connected/http-transports.mjs`; new `test/e7-connected-http-transports.test.mjs` (pure; runs under `npm test`); this contract (status + implementation map).

**Import boundary:** `node:util` (`types`) only + the adapters' exported `PROTECTED_*` check via `lib/checkout/compensation-proof.js` constants (as the adapters do) — or a local copy asserted equal by test. No `fetch`, `node:http(s)`, `node:net`, `undici`, SDK, env, timers, fs, child process, core / worker / D import. Names avoid every pinned string (`createHostawayTransport`, `hostaway-reservations`, `allowRequest:`, `connectedTestAdapterConfig`). The accepted E4 transport (`scripts/e4-transport/hostaway-transport.mjs`) is prior art only; it is not imported or changed (it mints tokens, sleeps and reads unbounded text, and its users are pinned).

**Tests (no PG, no network, no install; root-runnable):**
1. Exact mapping for H1–H9 and S1–S4: recorded `{ method, url, headerNames, body }` byte-equal to the table (sorted query, `expand[]`, form encoding, JSON body); `Authorization` redacted in the recorder.
2. Containment: every non-allowlisted method / path / query key / value type / host attempt, protected ids, accessor / proxy options, non-genuine or aborted signal → refused with ZERO exchange calls.
3. One invocation: exactly one `exchange` per `send`; a rejected / hanging / late-resolving exchange is never retried; 3xx → `REDIRECT_REFUSED` without a second exchange; Hostaway 401 / 403 passed through, no re-mint.
4. Bodies: exactly-at and over `maxBytes`, non-UTF-8, non-JSON, deep nesting, empty body, non-object Stripe body; consumed once; code-only errors with no path / id / key / body text.
5. Stripe TEST: `sk_live_` / `rk_live_` / other / empty keys refused before any exchange; `livemode:true` reply refused; `Idempotency-Key` present exactly on S3 / S4 and equal to the bound key; `Stripe-Version` always present.
6. Integration with the accepted adapters (pure): `createPhaseExecutors` with these sends over a fake exchange → the same envelopes the accepted fakes received (`e7-connected-adapter-rehearsal` routes), still synthetic.

**Validation (proposed):** `node --test test/e7-connected-http-transports.test.mjs`; foundation / adapters / pins unit set; `npm test`.

## 7. Future read-only probe checklist (CLOSED; for a later reviewed slice)
1. Owner supplies TEST credentials through a reviewed wrapper (never pasted into chat / files).
2. Hostaway: token mint once (separate slice) → `GET /v1/listings/{owner test listing}` → `GET /v1/listings/{L}/calendar` (owner dates) → `GET /v1/reservations?…` with the exact H1 query → record status + shape only (no guest data printed).
3. Hostaway docs comparison for H7 / H8 / H9 completed before any write is even mapped live.
4. Stripe TEST: `GET /v1/accounts/{acct}` and `GET /v1/payment_intents/{test pi}?expand[]=latest_charge` with the pinned `Stripe-Version`; confirm `livemode:false` and the proof fields.
5. Every probe: one request, no retry, journaled code-only, protected ids never named.

## 8. Consolidated owner approval gates for ANY real action (all UNSET / CLOSED)
Real reservation create, PaymentIntent capture, PaymentIntent cancel (void), Hostaway cancel, offline-charge record, and any guest / owner notification each require, explicitly and separately: the owner decisions of the runner contract §10 (listing / ref field / time zone, dates / guest / amount, pricing rate, verified Stripe TEST account and Hostaway account, `paymentMethod`, provider mode / phase scope, automation scope, cleanup procedure for every outcome); a reviewed manifest mode beyond `synthetic` (A change); completion of the blockers below; a reviewed credential wrapper; a file journal and evidence plan; and root approval of the exact run.

## 9. Blockers and routine recommendations
**Real blockers (for real wiring, not for the offline Slice T):**
- **B1** Official text for Hostaway cancel (H7) — UNVERIFIED.
- **B2** Official text for Hostaway create offline charge (H9) — UNVERIFIED.
- **B3** Charge-list filter `reservationId` vs documented `reservationIds` (H8) — UNVERIFIED.
- **B4** Pinned `Stripe-Version` for the accepted proofs — to be set by a read-only probe review.
- **B5** No manifest mode authorizes real connections (A); a separately reviewed gate change is required.
- **B6** Credential wrapper, Hostaway token slice, real exchange (§2.4) — all separate, CLOSED.

**Routine choices resolved here (root's):** module / export names; byte bounds; header set; `Authorization: Bearer` for Stripe; `GET /v1/accounts/{bound}` for `accounts.retrieve`; code list; no `Stripe-Account`; `sk_test_` only.

**Residuals:** R1 one invocation ≠ one server effect (§2.3); R2 Hostaway writes lack idempotency keys; R3 Stripe definite refusals surface as unknowns through the adapters (conservative, accepted behaviour); R4 reply shapes LIVE-UNVERIFIED; R5 documentation can change after 2026-11-04.
