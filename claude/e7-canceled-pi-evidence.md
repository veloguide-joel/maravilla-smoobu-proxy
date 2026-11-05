# E7 R-REFUND evidence — read-only look at ONE canceled Stripe TEST PaymentIntent (OFFLINE package)

Status: OFFLINE implementation for root CODE review. **Not consent.** This file, the code, workflow inputs, a label or a hash authorize no provider request, dispatch, merge, environment change or credential action. Execute stays CLOSED until Joel approves ONE exact filled package.

**Purpose.** R-REFUND asks whether a real Stripe cancel of a `requires_capture` PaymentIntent reports the expanded charge's `amount_refunded` as 0 or as the released amount. The accepted strict proofs require 0. The isolated authorization run (`AUTH_TEST_COMPLETED_OK`, run 42073005090) did not publish that field. This package reads the SAME already-canceled object again; it creates no new hold.

## Files (branch `feature/e7-canceled-pi-evidence` from verified main `1f35c02b`; no E7 lineage)

| file | role |
|---|---|
| `scripts/e7-canceled-pi-evidence.mjs` | runner. Inert on import; injected core `runEvidenceCore` + gated hosted wiring `runHosted` (preflight / verify / execute) |
| `test/e7-canceled-pi-evidence.test.mjs` | fake-provider tests (14): real accepted T / X / C1, fake exchange or fake primitive, native https / fetch guarded at zero |
| `.github/workflows/e7-canceled-pi-evidence.yml` | **DRAFT** manual workflow; execute job runs only on `refs/heads/main`, so it cannot be dispatched from this branch |
| `claude/e7-canceled-pi-evidence.md` | this note |

Accepted T / X / C1, the authorization runner, the read-only probe wrapper, their workflows and tests are byte-identical to main.

## Fixed scope (code ceiling; no account / PaymentIntent / version / amount input exists)

| # | request (via accepted T) | check |
|---|---|---|
| 1 | `GET https://api.stripe.com/v1/account` | the credential's account is exactly `acct_1TyHE42B9LTneQgw` (MiCasaDirect TEST) |
| 2 | `GET https://api.stripe.com/v1/payment_intents/pi_3UYUIm2B9LTneQgw0mGFQdwG?expand%5B%5D=latest_charge` | T: object + exact id + `livemode:false`. Runner baseline: `canceled`, `manual`, `usd`, amount **100 minor units ($1.00)**, received 0, capturable 0, `metadata.e7_purpose = e7-authorization-test`; expanded charge object `ch_…` bound to this PI, `livemode:false`, `usd`, amount 100, typed `status` / `captured` / `amount_captured` / `amount_refunded` (0..amount) / `refunded` |

- **Header / version.** Stripe-Version `2026-01-28.clover`, the version of the checkout and cleanup clients the strict proof will run under. TEST key `sk_test_` only (T refuses anything else with zero exchanges).
- **Write-free by construction.** One counted gate in front of the exchange admits at most TWO requests: method GET, the two exact URLs above in order, no body, header set exactly Authorization + Stripe-Version at clover. Anything else is refused before the exchange (test E9).
  - No POST, no idempotency key, no create / capture / cancel / refund / update, no retry, no redirect (T `REDIRECT_REFUSED`), no pagination, no fallback.
  - Per-call deadline: `AbortSignal.timeout(15000)`. An operator abort stops before the next GET.
- **No decision.** The result always carries `decision: "NONE"` and `writesSent: 0`. `refundedClass` (ZERO / FULL / PARTIAL) and `chargeBaseline` (NEVER_CAPTURED / CAPTURE_REPORTED) are descriptive labels, not release proof. There is no DB write and no state change.

## Published fields (whitelist; copied scalars only)

account `OK`; PaymentIntent `id, status, captureMethod, currency, amount, amountReceived, amountCapturable`; charge `id, status, currency, amount, captured, amountCaptured, amountRefunded, refunded`; `refundedClass`, `chargeBaseline`, `outcome`, `exchanges`, `writesSent`, `stripeVersion`, `decision`; hosted: mode / code / workflow commit / tooling commit / source + runner digests / planHash / env code / fake-test counts.

Never published: key, header, URL, raw body or error, client_secret, metadata values, customer, billing / card / payment-method details, receipt, refund objects or lists, logs. Tests plant canaries in each and assert none appear in the result, the hosted JSON or the Markdown summary.

**STOP (code only, no fields, no retry):** `STOPPED_BEFORE_REQUEST`, `ACCOUNT_MISMATCH`, `ACCOUNT_UNKNOWN`, `PI_READ_FAILED` (transport / 4xx / 5xx / 3xx / body), `PI_LIVEMODE_REFUSED`, `PI_NOT_BOUND`, `PI_BASELINE_MISMATCH`, `CHARGE_MISSING`, `CHARGE_NOT_EXPANDED`, `CHARGE_NOT_BOUND`, `CHARGE_FIELDS_INVALID`, `CORE_INVALID`. The execute job exits nonzero on any STOP.

## Reuse and identity boundaries

- Accepted tooling checked out separately at FIXED `d1e20d71`; the 13-path framed digest `23212caa…3ce3d` is recomputed BEFORE any dynamic import (test H2 tampers a byte → mismatch, import never reached).
- Runner digest: framed recipe with domain prefix `e7-canceled-pi-evidence-runner-v1\n` over runner + workflow + test. At the committed bytes it is **`95b7c56cbb5e01312342b6745087a9c383c5c5d5fc8fc6393a3bed63ecad5403`** (local preflight, Node 22.22.0).
- Plan: binds tooling commit, both digests, account, PI, version, baseline, the exact two request lines, `writes: 0`, `decision: NONE` and the approval label. Execute refuses unless GITHUB_REF is main and plan hash, source digest and runner digest all equal the reviewed values.
- Secret: existing name `E7_STRIPE_TEST_KEY`, environment `e7-readonly-probe` (required reviewers), mapped in the final execute step only; preflight / verify refuse if it is in scope. No Hostaway secret or input.

## Local evidence (CLAUDE-run, fake providers only)

- `test/e7-canceled-pi-evidence.test.mjs` first full TAP: 7 pass / 7 cancelled. Cause: test harness only — `AbortSignal.timeout`'s unref'd timer let the fake-only process exit with the E8 hang case pending. Then 12/14 with two test bugs (a `??` that turned the `null` tampered plan into the real plan; a P1 pin matching the closure path `capture-proof.js`). After those test-only fixes: 14/14. No runtime change between runs.
- Existing main regression with the new file (`test/*.test.mjs`, parity dir set): 46/46.
- Local `preflight` (no secrets, clean env): `PREFLIGHT_OK_SYNTHETIC_ONLY`, synthetic planHash `1fa5034b…066ae0`; with label `joel-canceled-pi-read-1`: `PREFLIGHT_OK_REAL_PLAN`, planHash **`bb55c92f9ce64b384a5c1664a2e07426aaf8b11dd398b58cbfc341ae5fa4b067`**.

## DRAFT approval package (all CLOSED; nothing here is approval)

1. Root code review of this exact head.
2. Joel approves a merge of this branch to main (reserved; the execute job is main-only). Root re-verifies main = this reviewed tree.
3. ONE `preflight` dispatch on main with `approval_ref = joel-canceled-pi-read-1` → must show `PREFLIGHT_OK_REAL_PLAN`, source digest `23212caa…3ce3d`, the reviewed runner digest and the planHash above (any difference: STOP).
4. Joel approves exactly ONE `execute` dispatch with those three values. At most two Stripe TEST GETs; no write; no second dispatch whatever the outcome.
5. Root reads the published fields. A proof correction is considered ONLY if the evidence justifies it; otherwise the strict proof stays as it is. Guest Checkout remains blocked until R-REFUND is settled.

No production, preview, Vercel, DB, Hostaway or credential change, and nothing is needed from Joel yet.
