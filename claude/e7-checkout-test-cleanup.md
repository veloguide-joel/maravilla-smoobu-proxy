# E7 owner cleanup runner — ONE released TEST authorization (gap C; OFFLINE)

Status: OFFLINE implementation for root code review. **Not consent.** Code, inputs, labels and hashes authorize nothing. There was no dispatch, secret read, DB connection, provider call, preview or settings action.

Branch `feature/e7-checkout-test-cleanup-runner`, from verified main `2090b3cc1ce95e9ebe4908569112528998a450a8`. No E7 history was merged into main.

| file | role |
|---|---|
| `scripts/e7-checkout-test-cleanup.mjs` | runner. Inert on import. `inspect` (read-only precheck), `runCleanupCore` (injected), `runHosted` (preflight / verify / execute) |
| `test/e7-checkout-test-cleanup.test.mjs` | 13 fake tests (always) + 4 opt-in DB tests (`E7_CLEANUP_DB_TESTS=1`: the real worker on disposable PG 17) |
| `.github/workflows/e7-checkout-test-cleanup.yml` | **DRAFT**, manual only; execute is main-only, environment `e7-readonly-probe` |
| `claude/e7-checkout-test-cleanup.md` | this note |

## Reuse (nothing modified)

- **Checked out separately at FIXED `6d703acd`:**
  - the accepted `runCleanupStep` (compensation worker), `loadIntent`;
  - `createPhaseExecutors` (cleanup phase), T `createE7StripeTestSend`, X `createE7RealExchange`, C1;
  - `createBookingPool` (verified TLS);
  - `voidKey` / `testReleaseEventId`, `validateAdapterConfig`.
- **Closure.** The runner's closure is the scanned transitive import closure of every tooling module it imports: 29 files, which includes `package.json` and `package-lock.json`. The framed digest is `ce0a418a8b07ed27b6167e2b4b6fbce0e8b2e2e69dcad29318210b799e923c8f`. It is verified before any tooling import; test H2 re-scans the closure and tampers one byte, and the lockfile too.
- **Dependency.** The only non-builtin dependency is `pg`, pinned at 8.18.0 by that lock. The workflow installs it in the execute job only, after verify (`npm ci --ignore-scripts --omit=dev`), and the runner re-checks `node_modules/pg` = 8.18.0 before importing.
- **Defaults.** Preflight installs nothing, reads no secret, opens no DB and makes no network call.

## Scope and gates (all before any provider call)

- **Plan (hashed).**
  - Inputs: the approval label plus the ONE intent UUID and its PaymentIntent.
  - Fixed: tooling commit, closure digest, runner digest, pg version, account `acct_1TyHE42B9LTneQgw`, listing 606998 USD, DB env `test` / ref `mxotevtiscernhqilyiu`, Stripe-Version `2026-01-28.clover`, the budgets.
  - The synthetic preflight id never qualifies verify / execute or the core.
- **DB target.** Exactly the transaction-pooler user `mv_booking_app_dev.mxotevtiscernhqilyiu` @ `aws-0-us-east-1.pooler.supabase.com:6543/postgres`, with no query string. Anything else (postgres user, other port, host or ref, `sslmode`) is refused before a pool exists.
  - TLS goes through the accepted pool with the CA. The CA is public; the workflow fetches it and the runner requires its SHA-256 `700723…f3b7`, the same pin as the accepted `db-smoke.mjs`.
  - Runtime login only; no owner credential.
- **`inspect`** (SELECTs only, runtime role, no transaction held across a provider call). It requires, or refuses with a code:
  - `booking.instance = test`;
  - the intent exists, with listing 606998, USD;
  - payment: the plan's PaymentIntent, `livemode:false`, captured 0;
  - no reservation and no dispatch; counters for reservation / capture / cancel / offline charge are 0, and void ≤ 1;
  - a bound session;
  - **lineage:** exactly one `PAYMENT_AUTHORIZED`, immediately followed by `TEST_RELEASE_REQUESTED` (payment_authorized → reservation_failed, reason `TEST_RELEASE_REQUESTED`, event id `testReleaseEventId(intent, PI)`), then at most `VOID_SUCCEEDED`; nothing else;
  - exactly one completed attempt bound to session + PI + TEST + amount + currency;
  - zero Hostaway attempts and zero reconciliation cases; ledger only `authorization_accepted` / `authorization_voided`;
  - operations only checkout create / reads / void / notify, so any `hostaway.*`, capture or `alert.owner` is refused;
  - exactly ONE void row: row key `void:<intent>:v<release version>`, provider key `voidKey(intent, PI)`, payload PI;
  - one claim on 606998.
- **Start states.**
  - `reservation_failed` with a **pristine** void row (pending, 0 attempts, never dispatched) and the claim held: cancel budget 1.
  - `authorization_released` with void succeeded and the claim released: `ALREADY_RELEASED`, zero steps and zero exchanges.
  - Anything else (dispatched / unknown void row, capture_failed, reconciliation_required, or another reason): refused.

## Budgets and STOP rules

- **Transport boundary.**
  - ≤ 1 `paymentIntents.cancel` for the whole run, and only with the worker's provider key.
  - ≤ 4 account reads, ≤ 8 PaymentIntent reads (expand latest_charge), ≤ 13 exchanges.
  - Exact URLs, methods and header sets; anything else is refused before X.
- **Run.** ≤ 8 worker steps, all for the named intent (`intentId` scope), a 6-minute deadline, and waits capped at 35 s.
- **Hostaway executors** are the accepted adapters with a send that throws before any transport; reaching it stops the run.
- **STOP outcomes**, with no retry, rerun or new key:
  - `CANCEL_OUTCOME_UNKNOWN`: a cancel exchange that failed, timed out or got 5xx; the worker reporting `VOID_OUTCOME_UNKNOWN`; or a worker / DB / reload error after a cancel;
  - `CANCEL_NOT_SENT`: T refused the cancel before any exchange;
  - `SECOND_CANCEL_REFUSED`; `ESCALATED` (escalate / send-aborted); `WORKER_REFUSED`; `NOT_RELEASED` (state moved);
  - `BUDGET_EXHAUSTED`; `DEADLINE`; `ABORTED`; `DB_ERROR`.
  - Success is only `RELEASED`, after a post-check of the void op (succeeded) and the claim (released).
- Account verification and the strict canceled proof are the accepted worker's own and unchanged.
- **Output:** whitelisted codes, counts, states, flags and worker action codes only.

## Evidence (CLAUDE-run, local; nothing hosted)

- **Fake section, first full TAP: 9/13.** Four failures:
  - a wrong expectation (an already-aborted signal is refused by the accepted adapter before the boundary);
  - **one real runtime fix:** the runner slept once after the final allowed step;
  - an F8 request shape the adapter refuses before its send;
  - an over-broad source pin.
  - After fixes: 13/13.
- **DB section, first full TAP: 14/17.** The fake DB shape was wrong: the void row key is `void:<intent>:v<version>` and the provider key sits in its payload. **Runtime fix:** `inspect` now checks both.
  - Run 2: 15/17. The real worker reported `VOID_OUTCOME_UNKNOWN:CONFIRM_READ_NOT_CANCELED` and kept waiting. **Runtime fix:** STOP on that action.
  - Run 3: 17/17. D1 real release + repeat ALREADY_RELEASED + another intent untouched; D2 refunded-on-cancel → STOP with the claim held; D3 network / timeout → UNKNOWN, rerun refused (`LINEAGE_NOT_RELEASE`), one cancel only; D4 scope.
- **Regressions:**
  - main `test/*.test.mjs` (evidence / auth / probe, parity dir set): 46/46;
  - tooling at 6d703acd: release + e74a compensation + e74b-d1 release: 30/30.
- **Local preflight** (clean env, no secrets): `PREFLIGHT_OK_SYNTHETIC_ONLY`, 13/13 fake. runnerDigest `7020a60b7619fb3964811539b491833fcfd4e858f2a0ddea96794e6ef6ad8db9`.

## Limits and open points for review

1. **Inert gate inputs.** `listingTimeZone` (`America/Bahia_Banderas`) and `refFieldId` (1) are required by the worker gate but unused on the release path. They are not verified Hostaway facts.
2. **Environment.** The workflow reuses `e7-readonly-probe` (normal review) as directed, although execute can send ONE TEST cancel. It needs ONE new owner-entered environment secret, `E7_DEV_BOOKING_DATABASE_URL` (runtime login).
3. **Containment pin.** The closure list necessarily names the Hostaway adapter module path. This runner lives on main, where the E7 containment test does not run; on the E7 lineage, the rule is "no new script imports it". The runner imports it only through the worker plus `validateAdapterConfig`.
4. **What the DB tests do and do not prove.** They use a fixed clock, so worker freshness waits do not advance. The strict-proof refusal therefore surfaces as `VOID_OUTCOME_UNKNOWN` in one step, not the later `ESCALATE:VOID_PROOF_NOT_STRICT`; either way the run stops with the claim held. A real step that needs only a freshness wait and then a read-only confirm stays within 8 steps / 35 s waits / 6 minutes, but no test proves it live.
5. **Usability.** Hosted execute is usable only after a real released intent exists, which needs the preview package. Main must also contain this reviewed runner (root-reviewed merge).
