# E7 path A — Stripe TEST authorization rehearsal (OFFLINE implementation map)

Status: OFFLINE implementation for root CODE review. **Not consent.** No provider write, dispatch, merge, environment change or credential action is authorized by this file, the code, the workflow inputs, a label or a hash. Execute stays CLOSED until Joel approves ONE exact filled package.

Scope: account check → ONE create (manual capture, confirm) → ONE retrieve (expand latest_charge) → ONE cancel → ONE final retrieve. Not Checkout UI, not E7 DB / worker end to end. No capture, refund, DB, webhook, Hostaway, email, Vercel or new infrastructure.

## Files (feature branch `feature/e7-stripe-authorization-test`, from main `ae0734de`)

| file | role |
|---|---|
| `scripts/e7-stripe-authorization-test.mjs` | runner. Inert on import. Injected core `runAuthorizationCore` plus gated hosted wiring `runHosted` (preflight / verify / execute). |
| `test/e7-stripe-authorization-test.test.mjs` | fake-provider tests: real accepted T / X / C1, a fake exchange or a fake primitive, and guards on native https and fetch. |
| `.github/workflows/e7-stripe-authorization-test.yml` | **DRAFT** manual workflow. It is not on main, so it cannot be dispatched. |
| `claude/e7-stripe-authorization-test.md` | this map |

No helper file was added. The accepted T / X / P / C1–C3, the read-only workflow, the wrapper, its test and its doc are all byte-identical to main.

## Reuse and identity boundaries

- **Accepted tooling.** It is checked out separately at the FIXED commit `d1e20d71`. The runner recomputes the accepted 13-path framed digest `23212caa…3ce3d` BEFORE it dynamically imports anything. Test H2 tampers one file and confirms the import is never reached.
- **Modules used.**
  - T `createE7StripeTestSend`: account read, PI retrieve with expand latest_charge, PI cancel.
  - X `createE7RealExchange`: the one create POST. The runner builds it itself, so T is NOT broadened.
  - C1 `evaluateProbeEnvironment`: env checks.
- **Runner digest.** A separate boundary over the runner, workflow and test bytes. It uses the framed recipe with the domain prefix `e7-stripe-auth-runner-v1\n`. The accepted digest does NOT cover this code. Execute requires `expected_runner_digest` to match the reviewed bytes.
- **Versions.**
  - Stripe-Version is `2026-08-26.dahlia`. This equals run #6 and the hosted read-only probe; no upgrade.
  - Node is 22.22.0.
  - Action SHAs are pinned to the same values as the read-only workflow.

## Fixed request set (code ceiling; no amount / currency / account / payment-method input exists)

| # | operation | via | form |
|---|---|---|---|
| 1 | account check | T `accounts.retrieve` | `GET /v1/account`; id must equal `acct_1TyHE42B9LTneQgw` |
| 2 | create (WRITE) | X | `POST /v1/payment_intents`, headers exactly Authorization / Content-Type form / Idempotency-Key `e7-auth-<run_ref>-create` / Stripe-Version; body exactly `amount=100&currency=usd&capture_method=manual&confirm=true&payment_method=pm_card_visa&allowed_payment_method_types%5B%5D=card&metadata%5Be7_purpose%5D=e7-authorization-test&metadata%5Be7_run_ref%5D=<run_ref>` |
| 3 | retrieve | T | `GET /v1/payment_intents/<bound id>?expand%5B%5D=latest_charge` |
| 4 | cancel (WRITE) | T | `POST /v1/payment_intents/<bound id>/cancel`, empty form, Idempotency-Key `e7-auth-<run_ref>-cancel` |
| 5 | final retrieve | T | as #3 |

**Primary-doc finding, at the pinned version.** The Stripe changelog for `2026-08-26.dahlia` removes the writable `payment_method_types` on PaymentIntent create, update and confirm. Passing it now returns 400 `payment_method_types_no_longer_supported`. The replacement is `allowed_payment_method_types` (added in `2026-07-29.dahlia`), so card-only is expressed as `allowed_payment_method_types[]=card`.

- **Residual risk (can't be checked offline).** This combination with `confirm=true` and no `return_url` has not been exercised. If Stripe refuses it, the result is a 4xx `CREATE_REFUSED` with no hold. There is no retry.
- **Sources.**
  - docs.stripe.com/changelog/dahlia/2026-08-26/removes-payment-method-types-parameter-from-payment-intents-setup-intents
  - …/2026-07-29/allowed-payment-method-types-parameter
  - api/payment_intents/create
  - api/payment_intents/cancel (cancellable statuses; for `requires_capture`, the remaining `amount_capturable` is released)
  - payments/place-a-hold-on-a-payment-method (`requires_capture`; `capture_before` on the charge; uncaptured card authorizations expire, usually after 7 days, and become `canceled`)
  - testing (`pm_card_visa` instead of card numbers)

**Budget.** At most 5 exchanges, counted at the exchange layer, and both T and the create go through the same counter. There is no retry, no backoff, no second create or cancel, and no new idempotency key. The run identity is the reviewed `run_ref` input; the code never generates one. `run_ref` is single-use: Stripe replays an idempotent result for about 24h and then may create anew, so the package must name a fresh `run_ref` and there is no second dispatch.

**Timeouts.** Each call carries a native `AbortSignal.timeout(15000)`, which bounds every tail. An operator abort (SIGINT/SIGTERM) is honoured only BEFORE the create. After the create, cleanup proceeds inside the budget.

## Binding and verification

- **Bound PI.** The create reply must parse within 256 KiB and have:
  - `object` = payment_intent and an `id` matching `pi_…`;
  - `livemode` false;
  - `amount` 100, `currency` usd, `capture_method` manual;
  - `metadata` exactly `{e7_purpose, e7_run_ref}`;
  - a known status.

  Otherwise nothing is bound and no cancel happens. Every later reply must re-match the same fields, and T also checks the object, id and livemode.
- **Authorization verified.** The retrieve must show:
  - `status` requires_capture, `amount_capturable` 100, `amount_received` 0;
  - an expanded `latest_charge` with `object` charge, an id matching `ch_…`, `livemode` false, `payment_intent` = the bound id, `captured` false, `amount_captured` 0, `amount` 100 usd, `amount_refunded` 0, and a boolean `paid`.
- **Proof fields** (the accepted R-PC3 rule):
  - `payment_method_details.card.capture_before` as a positive int → `COMPLETE`. It is published as `captureBefore` (epoch seconds).
  - absent or null → `INCOMPLETE`, reported honestly. The outcome is then `AUTH_TEST_COMPLETED_PROOF_INCOMPLETE`.
  - present but invalid → `INVALID`, and the authorization counts as NOT_VERIFIED.

  In every case the identity is still bound, so cleanup still runs.

## Request / error / cleanup map (predeclared)

| situation | provider calls | cleanup | outcome | residual / locator |
|---|---|---|---|---|
| key not `sk_test_…` (live, restricted, empty) | 0 | — | STOPPED_BEFORE_CREATE | none |
| account mismatch or unknown | 1 GET | — | STOPPED_BEFORE_CREATE | none |
| abort before create | 0–1 GET | — | STOPPED_BEFORE_CREATE | none |
| create: transport failure, timeout, 3xx or 5xx | 2 | **none** (identity unknown; never blind-cancel) | CREATE_UNKNOWN | POSSIBLE_PI_UNKNOWN_IDENTITY; locator = run_ref + create idempotency key; dashboard search by metadata `e7_run_ref` |
| create 4xx (e.g. 400/402) | 2 | none | CREATE_REFUSED (raw error never parsed or published) | POSSIBLE_UNAUTHORIZED_PI_NO_HOLD |
| create 2xx but not bound | 2 | none | CREATE_UNBOUND | POSSIBLE_PI_UNKNOWN_IDENTITY; PI id NOT published |
| retrieve contradicts identity (fields, livemode, a live charge) | 3 | **none** | IDENTITY_CONFLICT | BOUND_PI_NOT_CANCELLED; PI id published |
| retrieve unknown or refused | 3 + cancel + final = 5 | cancel based on the CREATE-bound status | per final readback | — |
| status succeeded | 3 | none (no capture or refund op exists) | CAPTURED_UNEXPECTED | TEST_CHARGE_CAPTURED_NEEDS_OPERATOR |
| status processing | 3 | none | NOT_CANCELLABLE | BOUND_PI_PROCESSING_NOT_CANCELLED |
| status canceled | 3 | skipped | AUTH_TEST_AUTHORIZATION_NOT_VERIFIED (cleanup VERIFIED) | none |
| requires_capture, or another cancellable status | 5 | ONE cancel, then ONE final retrieve | below | — |
| final: canceled, received 0, capturable 0, charge not captured | 5 | VERIFIED | COMPLETED_OK / PROOF_INCOMPLETE / AUTHORIZATION_NOT_VERIFIED | none |
| final: still requires_capture (cancel refused or unknown) | 5 | NOT_DONE | CLEANUP_NOT_DONE | AUTHORIZATION_HELD_UNTIL_EXPIRY ($1.00 TEST hold auto-expires); PI id + cancel key |
| final readback unknown or mismatched | 5 | UNKNOWN | CLEANUP_UNKNOWN | CANCEL_ACKED_READBACK_UNKNOWN or BOUND_PI_STATE_UNKNOWN |

Nothing outside this map exists: no extra calls after a failure, no cleanup retry, no auto-resume, and no state files.

## Hosted boundary (DRAFT workflow)

| mode | requires | what runs |
|---|---|---|
| `preflight` (default) | no secrets; refuses if a TEST key or any `*HOSTAWAY*` variable is present | 13-path digest; runner digest; plan + planHash (REAL if `run_ref` + `approval_ref`, else labelled SYNTHETIC); C1 env check (Node 22.22.0); the fake test file as a plain `node --test` child, env minus `E7_*` plus the tooling dir. Zero provider requests. |
| `verify` | main only (`github.ref` checked by the workflow and again by `GITHUB_REF`); every binding explicit with no defaults (`run_ref`, `approval_ref`, `expected_plan_hash`, `expected_source_digest`, `expected_runner_digest`) | all of the above except tests; compares the bindings; no secret |
| `execute` | the same plus environment `e7-readonly-probe` (required reviewer). Only `E7_STRIPE_TEST_KEY` is mapped, in the final step only. | Reads the key once into a closure and deletes it from the process env. No child process. Builds X with the default node:https primitive, then runs the core. |

Public output is the whitelisted result JSON on stdout plus the job summary built from it. That means:

- fixed code sets, PI statuses and safe integers;
- the PI id only when it is bound;
- `run_ref` and the idempotency keys (non-secret locators).

It never includes a key, header, URL, raw Stripe object, client_secret or raw error. There are no artifacts and no temp files.

## Offline verification

- `node --test test/e7-stripe-authorization-test.test.mjs` with `E7_TOOLING_DIR` set to the d1e20d71 checkout:
  - **FIRST FULL TAP: 14/15.** P1 failed because of a defect in the test fixture: its `/\/capture\b/` pin matched the closure path `lib/checkout/capture-proof.js`.
  - After narrowing the pin to `/\/capture(?![-_a-z])/`: **15/15.**
- Spot mutants, a normal-depth sanity check: metadata binding, livemode conflict, create-4xx branch, abort-before-create and runner-digest check were all killed.
- Existing `test/e7-hosted-probe.test.mjs`:
  - without the parity checkout: 13 pass + 1 skipped;
  - with `E7_PARITY_TOOLING_DIR` set to an absolute path: 14/14. A first invocation with a relative path failed the parity test because the module path could not resolve; that was an operator path error, not a code failure.
- Real CLI `preflight` in this sandbox: computed sourceDigest `23212caa…3ce3d` (matches); `AUTH_ENV_REFUSED` / `ENV_VARIABLE_REFUSED`. That is expected: the sandbox security variables were NOT unset, and no provider request was made.

## Draft approval package (to be filled ONLY by root and approved ONLY by Joel)

1. **Merge.** A separate reviewed PR merges these files to main; the workflow must be on main to dispatch. → reviewed main commit `<sha>`.
2. **Preflight** dispatch on main with `run_ref=<fresh, single-use>` and `approval_ref=<label>`. Record `PREFLIGHT_OK_REAL_PLAN`, `planHash`, `sourceDigest` (= 23212caa…3ce3d) and `runnerDigest`.
3. **Execute** dispatch with the identical `run_ref` / `approval_ref` plus `expected_plan_hash` / `expected_source_digest` / `expected_runner_digest`, then approve the `e7-readonly-probe` environment.
   - At most 5 Stripe TEST exchanges, 2 of them writes: create $1.00 auth, then cancel.
   - Account `acct_1TyHE42B9LTneQgw`, `pm_card_visa`.
   - No retry, rerun or second dispatch, whatever the outcome.
4. **Acceptance.** Success means `AUTH_TEST_COMPLETED_OK`, 5 exchanges, 2 writes and cleanup `VERIFIED`.
   - `AUTH_TEST_COMPLETED_PROOF_INCOMPLETE` is reported as such.
   - Any other outcome → STOP. Report the locator and residual from the map.
   - The capture, DB, worker, notification and Checkout gates stay OPEN.
