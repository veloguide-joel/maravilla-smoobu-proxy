# E7 hosted connected-runner launcher — slice L1 (PREFLIGHT ONLY, packaging proof)

**Status:** LOCAL branch `feature/e7-connected-runner-hosted-l1` from exact main `a5f5ecb4b4e470cae217befb35ee2578b862ef6c`. NOT pushed, NOT merged, NOT dispatched. Root ruling: L1 accepted with revisions (2026-11-06).

## What it is
- `scripts/e7-connected-runner-hosted.mjs` — a launcher with exactly ONE mode, `preflight`. Every other mode (`verify`, `execute`, anything else) is refused FIRST, before any env read beyond the mode, any filesystem access, any tooling import and any child process (`CRH_MODE_NOT_IMPLEMENTED`).
- `.github/workflows/e7-connected-runner.yml` — `workflow_dispatch`, choice `[preflight]` only, `contents: read`, no `environment`, no `secrets.*`, no install. It checks out the launcher and the pinned runner tooling `6d00d0d6c7ac63b77d703f8c212381109096723c`, then sets up Node 22.22.0.
- `test/e7-connected-runner-hosted.test.mjs` — the offline tests (H1–H9, P1).

## What a preflight proves (PACKAGING ONLY)
1. **Boundary:** credential-bearing env keys (DB / Postgres / Supabase / Stripe / Hostaway) are refused by name, values never echoed. Any `E7_` input other than `E7_TOOLING_DIR` / `E7_WORKFLOW_SHA` is refused: L1 has no real manifest input.
2. **Closure first:** the pinned tooling closure (46 files) is digest-verified BEFORE any tooling import.
   - It is the scanned transitive closure of `run-core`, `http-transports`, `real-exchange`, `run-journal-file`, `probe-env-preflight` and the five child suites.
   - It also covers the data files those suites read, plus `package.json` / `package-lock.json`.
3. **Two pure imports only:** exactly `run-manifest.mjs` and `probe-env-preflight.mjs`, through one allowlisted import gate. `run-core`, the workers, adapters, transports, real exchange, pool and file journal are verified bytes only: never imported, constructed or invoked.
4. **Synthetic manifest:** a SYNTHETIC-labelled manifest is validated by the ACCEPTED validator, and its accepted framed hash (`e7-run-manifest-v1\n` + canonical JSON) is bound into the outer plan. It never names runs 1 / 2 / 3 (explicitly refused).
5. **Environment:** the accepted C1 env evaluation, plus an exact Node 22.22.0.
6. **Fake-only suites:** the five accepted fake-only suites run in a plain child at the tooling root, with only the OS allowlist + `E7_TOOLING_DIR`.

| suite | slice | why it is offline |
|---|---|---|
| `test/e7-connected-run-manifest.test.mjs` | A | pure validator and hash; global fetch trapped |
| `test/e7-connected-run-guard.test.mjs` | B | injected fake monotonic / timers / clients / lock |
| `test/e7-connected-run-journal.test.mjs` | D | in-memory journal; source-grammar parity reads only |
| `test/e7-connected-http-transports.test.mjs` | T | injected fake exchange; synthetic credentials; fetch guarded |
| `test/e7-connected-real-exchange.test.mjs` | X | injected fake EventEmitter primitive; no socket / DNS / TLS |

- Deliberately NOT run: the disposable-PG suites under `test/db/` (runner, run-facts, rehearsals), the file-journal suite (real filesystem), and any provider suite.

**It proves NOTHING about** DB access, credentials, transports, providers, journal durability, a booking, or any later `verify` / `execute`.

## Outer plan
`runnerPlanHash = sha256("e7-connected-runner-hosted-plan-v1\n" + canonical(plan))`. The plan holds:
- schema, `proof: PACKAGING_ONLY`, `planKind: SYNTHETIC`;
- tooling commit, closure digest, runner digest (launcher + workflow + test), runtime Node;
- `manifest {version, hash, synthetic: true}`, modes implemented `[preflight]`, child suites;
- effects all 0.

## Planning facts recorded with this slice (root corrections, 2026-11-06)
- **Hosted probe scope:**
  - the existing `e7-readonly-probe` workflow is hard-coded to TWO GETs (P-H1 listing, P-S1 TEST account) at tooling `d1e20d71`;
  - it has no inputs for P-H2..H6 / P-S2, so a wider G6 package needs a reviewed extension.
- **Reservation-only cleanup is a BLOCKER:**
  - run-core ends a reservation-only run (`phases.capture = false`) at `reservation_confirmed` with `ENDED_RESERVED_NOT_CAPTURED` and owner-procedure key `reservedNotConfirmed`, an owner reference, not automatic compensation;
  - the cleanup worker's entry states are `reservation_failed` / `capture_failed` only (`compensation-worker.js:50`);
  - `reservation_confirmed` admits only `PAYMENT_AUTHORIZED`, `CAPTURE_*` and `ESCALATE` (`intent-state.js:130`);
  - so no legal E3 transition leads from a confirmed reservation to cancel + void. Capture failure must never be synthesized.
- **Manifest v1 vs a disconnected listing:**
  - the accepted validator requires the exact checkpoint list `CALENDAR_BASELINE, AIRBNB_BLOCKED, AIRBNB_REOPENED`;
  - listing 606998 has no Airbnb connection, so a real run on it needs a reviewed manifest rule for disconnected listings;
  - L1's synthetic manifest uses the accepted list unchanged.
- **Report pool:** must be a separate least-privilege report login (owner provisioning; L1 needs none).
- **Durable journal:** a future hosted execute needs synchronous durable append acknowledgements (ordered, hash-bound records, trusted-head verification, fail-closed on ambiguous append). An end-of-job artifact is supplementary only. Not in L1.
