# E7 DEV read-only DB smoke — hosted wrapper (closes the packet's db-smoke execution gap; OFFLINE)

Status: OFFLINE implementation for root code review. **Not consent.** Code, inputs, labels and hashes authorize nothing. There was no dispatch, secret read, DB connection or network call.

Branch `feature/e7-dev-db-smoke-runner`, from verified main `91e20666d6f93c5d2660badaff4f26f023193e68`. No E7 history was merged into main.

| file | role |
|---|---|
| `scripts/e7-dev-db-smoke.mjs` | wrapper. Inert on import. `preflight` / `verify` / `execute` |
| `test/e7-dev-db-smoke.test.mjs` | 9 fake tests (always) + 1 opt-in real loopback rehearsal (`E7_SMOKE_DB_TESTS=1`) |
| `.github/workflows/e7-dev-db-smoke.yml` | **DRAFT**, manual only; execute is main-only, environment `e7-readonly-probe` |
| `claude/e7-dev-db-smoke.md` | this note |

## What runs (nothing modified)

- **The smoke.** The accepted `scripts/db-smoke.mjs` at the FIXED tooling commit `6d703acd`, **unchanged**, ONCE, with exactly:
  ```
  scripts/db-smoke.mjs --url-env E7_DEV_BOOKING_DATABASE_URL --ca-file <RUNNER_TEMP>/prod-ca-2021.crt --expect-role mv_booking_app_dev --env test
  ```
  It never uses `--write-probe` or `--loopback-rehearsal`. `argvOk` refuses any other shape.
- **Closure.** The smoke's full transitive closure, scanned by test S2:
  - `scripts/db-smoke.mjs` → `db/lib/pool.js` → `lib/booking-db/pool.js` → `pg`;
  - plus `package.json` and `package-lock.json`.
  - Framed digest **`45b512b0498d82c329e9c05edde165e242a9910fbeac533644cf926f890af5ca`**, verified before anything else. A tampered smoke or lock byte is refused before any child.
- **Dependency.** `pg` 8.18.0 comes from that lock. It is installed in the execute job only, after verify (`npm ci --ignore-scripts --omit=dev`), and the version is re-checked before the child starts. There is no new dependency.
  - Like the accepted cleanup workflow, `npm ci --omit=dev` installs the lock's production set (`pg`, `dotenv`, `stripe`). Only `pg` is reachable from the smoke closure.
- **No tooling import.** This process imports no tooling module.
- **Reuse, disclosed.** `dbTargetOk`, `framedDigest` and `OFFICIAL_CA_SHA256` are imported from the accepted cleanup runner `scripts/e7-checkout-test-cleanup.mjs`. They are pure, and that module is inert on import. It is therefore part of this wrapper's runner digest, so a change there changes the pin.

## Scope and gates (all before the child)

- **Preflight (default).** No secret is allowed (the DB URL and any Stripe / Hostaway / owner DB variable are refused). There is no install, no CA or pg read, and no DB or network.
  - It computes the digests and the plan, and runs the fake test file as a child.
  - Output codes: `PREFLIGHT_OK_SYNTHETIC_ONLY` / `PREFLIGHT_OK_REAL_PLAN`.
  - It claims no connectivity (`connectivityEvidence:false`).
- **Verify / execute** require all of:
  - the `refs/heads/main` ref;
  - Node 22.22.0;
  - an approval label;
  - an exact `expected_plan_hash`, `expected_closure_digest` (= the constant) and `expected_runner_digest`.
  
  The plan hash binds the tooling commit, closure, runner digest, pg version, the fixed smoke flags, the target (host / port / user / db / ref), the CA pin, timeout, `runs:1` / `retries:0` and the label.
- **Target.** This is the same rule as the accepted cleanup runner (the same function). It allows exactly user `mv_booking_app_dev.mxotevtiscernhqilyiu` @ `aws-0-us-east-1.pooler.supabase.com:6543/postgres`, with no query string and no hash fragment.
  - The owner / `postgres` user, another ref, port 5432, another host, a direct host, `?sslmode=…`, another path or scheme are each refused before the child (S4).
- **CA.** The workflow fetches the public CA. The wrapper requires SHA-256 `700723…f3b7`, and the smoke checks it again itself. TLS goes through the accepted pool unchanged (verified, `rejectUnauthorized:true`).
- **Secrets.**
  - ONE secret, `E7_DEV_BOOKING_DATABASE_URL` (the runtime login; the same future secret as the cleanup runner). There is no owner credential and no provider secret.
  - It exists in the final step only, and is never on a shell line or in argv.
  - It is read once and deleted from the process env object.
  - The child env is ONLY `{E7_DEV_BOOKING_DATABASE_URL}`: no PATH, no `PG*`, no provider variable (S8 checks this with a real child).
- **Bounded.** ONE child, hard-killed after 90 s. A timeout reports `SMOKE_TIMEOUT_UNKNOWN`, the true state: the read-only transaction may or may not have reached the DB. There is no retry, rerun or fallback (S6 counts exactly one child). The workflow `timeout-minutes: 10` is a backstop.

## Output and success

- **Child output.**
  - The child's stderr is never read.
  - Stdout is capped at 64 KiB.
  - If the URL or the password appears anywhere in stdout, everything is withheld (`SECRET_IN_OUTPUT_WITHHELD`).
  - Only the accepted JSON shape is accepted: `{at, pass, checks:[{check, pass, detail?}]}`, with known check names and no duplicates. Any other shape is `SMOKE_OUTPUT_INVALID`, and the raw output is withheld.
- **Details.** Only safe shapes survive: SQLSTATE / Node codes, TLS protocol, timeout settings, `N tables`, table names, privilege diffs, function signatures, `readable`, and the smoke's own static usage texts. Everything else is `REDACTED`.
- **`SMOKE_PASS` only if all hold:**
  - exit 0;
  - `pass:true`;
  - the exact non-empty expected set of 22 read-only checks, every one passed.
  
  Otherwise the outcome is `SMOKE_FAIL` (exit 1, failed check names listed), `SMOKE_OUTPUT_INVALID` (partial / inconsistent / malformed / empty / truncated), `SMOKE_TIMEOUT_UNKNOWN` or `SMOKE_CHILD_FAILED`. The workflow exit is 0 only for `SMOKE_PASS`.
- **What "read-only" means here.** The smoke legitimately does more than SELECT:
  - pool session setup (`statement_timeout`, `idle_in_transaction_session_timeout`, `application_name`);
  - `BEGIN READ ONLY` with savepoints, always ending in `ROLLBACK`;
  - expected **denied-permission probes**: reading `booking_migrations.applied` must fail 42501; the function-privilege checks; `booking.claim_release_blockers(gen_random_uuid())`, a read of the DB clock.
  
  It writes nothing.
- **The empty-data rule is the smoke's, unchanged.** Only the `instance` row and the 51-row `recording_assessment_codes` seed are allowed. A non-empty DEV database **FAILS** (`data_only_instance_row`); nothing is cleared or weakened.
- **What a pass does not prove.** A catalog-only POST (`post_verify.sql`) is not proof of the runtime login or TLS. Equally, this wrapper is **not proof of anything until it is separately approved and dispatched**.

## Evidence (CLAUDE-run, local; nothing hosted)

- **Fake section** (`node --test test/e7-dev-db-smoke.test.mjs`):
  - First full TAP: the file failed to load (a test-code syntax error: `await` inside a non-async helper), 0 tests.
  - Run 2: 8/9 (+1 skip). S9 had a wrong ordering expectation (a quote in the curl line).
  - Run 3: 9/9 (+1 skip).
  - The opt-in test was then made conditional (registered only when `E7_SMOKE_DB_TESTS=1`, never a skip), so the preflight counts pass = tests.
  - S1–S9 cover: built-ins / inert / reuse; the closure scan + digest + lock + tamper refusals; zero-effect preflight + secret refusals; every execute refusal before the child; exact single child argv / cwd / env / timeout + SMOKE_PASS; 19 failure shapes, never retried; redaction; a real bounded child (kill, stdout cap, stderr unread, minimal env); the workflow pins.
- **Opt-in S10** (the REAL tooling smoke on a disposable loopback PostgreSQL 16 via tooling `test/db/harness.mjs`, using the TEST-ONLY `--loopback-rehearsal` argv that `argvOk` refuses):
  - First run: the real smoke output parsed as an all-pass loopback set (17 checks). The test then failed on its own synthetic insert (`intents_ref_check`: a wrong test ref).
  - Run 2: 10/10.
  - The same real output against the REMOTE set is not a pass (the TLS / CA checks are absent). After one synthetic intent, the real smoke fails exactly `data_only_instance_row` → `SMOKE_FAIL`.
- **Local preflight** (clean env, no secrets): `PREFLIGHT_OK_SYNTHETIC_ONLY`, 9/9 fake. runnerDigest **`0d697185a88e91457c285033c7e7dcb6d9a60182820af7baf6a716a420e22ec1`**. The plan hash depends on the approval label, so it is computed by the real-plan preflight at dispatch time.
- **Main units, once, each file with its pinned tooling checkout:**

  | file | tooling | result |
  |---|---|---|
  | canceled-pi | `d1e20d71` | 14/14 |
  | stripe-authorization | `d1e20d71` | 18/18 |
  | hosted-probe | `d1e20d71`, parity dir set | 14/14 |
  | cleanup | `6d703acd` | 20/20 |
  | this file | `6d703acd` | 9/9 |

  A single `npm test` with one `E7_TOOLING_DIR` cannot satisfy both pins: the first attempt with `6d703acd` showed 6 expected digest failures in the `d1e20d71`-pinned files.

## Limits

- Hosted Supabase behaviour (pooler, role settings, platform grants) is unverified. The local rehearsal used loopback without TLS, and the smoke's TLS checks were exercised only by fakes here.
- A secret in an unexpected encoding (for example, a password that the URL percent-encodes differently) is withheld only through the URL / decoded-password match. The child prints only check names and codes by design.
- Usability needs the owner-entered environment secret `E7_DEV_BOOKING_DATABASE_URL`, and main must contain this reviewed wrapper (a root-reviewed merge).
