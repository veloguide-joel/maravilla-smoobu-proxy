# C119 S2 — TEST arm gate + draft confirmation schedule (DRAFT, SHIPPED CLOSED), 2026-11-17

**Status:** draft code only. `executeEnabled` / `dispatchEnabled` stay **false** in every runner. No repository variable, environment, reviewer, secret or setting is created or changed. No dispatch and no DB or provider action. **Not for activation.**

## 1. Release digest: the exact, non-circular construction
- **Manifest:** `scripts/e7-test-arm/manifest.json` (schema `e7-test-arm-manifest-v1`).
  - It lists the reviewed component **frames** by `name` / `prefix` / `files` only. It never holds a digest, and the tests assert no 40+ hex run appears in it.
  - Fixed component order:

    | component | files |
    |---|---|
    | `arm-gate` | `scripts/e7-test-arm.mjs`, `test/e7-test-arm.test.mjs` |
    | `kickoff` | the kickoff runner's 4 frame files |
    | `booking-confirmation` | the C50 runner's 4 frame files |
    | `pipeline` | the pipeline's 4 frame files (bytes untouched in S2) |

- **Frame** of a component = the reviewed runners' framedDigest convention: SHA-256(prefix, then for each file: path NUL length NUL bytes NUL).
- **Release** = SHA-256(canonical({ schema: `e7-test-arm-release-v1`, manifest: SHA-256(manifest bytes), components: [{ name, frame }, …] in manifest order })).
- **Acyclic:**
  - The release is always **computed** from the checked-out bytes.
  - No component file and not the manifest contains the release, nor the frame of any component that S2 changes. Only the untouched pipeline frame may be pinned by a component (the kickoff already does), and the pipeline component references nothing of the arm.
  - The ONE literal reviewed expectation of a release lives in `test/e7-cross-runner-regression.test.mjs`, which is outside every component and every runtime frame.
- **Strict parsing:** exact keys / order / schema, safe relative paths, no duplicates, the manifest and the cross-runner regression never listed, size bounds. Any violation → `ARM_RELEASE_UNREADABLE`.

## 2. The arm decision (the caller-supplied value is never the authority)
- **Value:** the repository variable `vars.E7_TEST_AUTO_ARMED`, to be set out-of-band by ROOT at a future, separately authorized activation. It is passed to code as `E7_TEST_ARM`.
- **Armed only when** the value **equals the release recomputed from this checkout** and the ref is `refs/heads/main`.
- **Otherwise not armed:**
  - absent / empty → `ARM_ABSENT`;
  - not 64-lowercase-hex → `ARM_MALFORMED`;
  - another ref → `ARM_REF_NOT_MAIN`;
  - unreadable release → `ARM_RELEASE_UNREADABLE`;
  - any other value, i.e. a stale release, a moved main or a tampered byte → `ARM_MISMATCH`.

## 3. Where it gates (both routing and runner verification)
1. **Workflow routing.** A new `arm` job runs in `e7-hosted-kickoff.yml` and `e7-hosted-booking-confirmation.yml`: checkout of the exact SHA + Node, **no environment, no secret, no database, no tooling**, and `node scripts/e7-test-arm.mjs check`.
   - It always exits 0. Its outputs: `armed` plus (armed only) the recomputed kickoff / confirmation frame.
   - Every environment job (`detect`, `execute`) requires `needs.arm.outputs.armed == 'true'`, so not armed is a **CLOSED_NOOP before any environment acquisition, approval prompt, secret, SQL or HTTP**.
   - This holds on every non-preflight route: schedule, manual detect and **manual execute (no manual bypass)**. Manual `preflight` never needs the arm.
2. **Runner verification.** Labelled copies of the arm block (asserted byte-equal) sit in both runners.
   - For verify / detect / execute they recompute the release from their own checkout and compare it with `E7_TEST_ARM`. They also require the release's frame of themselves to equal their own source digest.
   - Not armed → `NBC_ARM_CLOSED` / `HKO_ARM_CLOSED`, or for the kickoff detect-flow verify `CLOSED_NOOP` (open=false).
   - This happens **after** the SHIPPED-CLOSED refusal and **before** any tooling import, secret value, DB, token or provider.
   - Every runner step in an environment job re-reads `vars.E7_TEST_AUTO_ARMED` when it starts. A **queued** job whose variable was cleared or changed before it started therefore refuses.
3. **Scheduled source pins.**
   - The kickoff's scheduled `expected_source_digest` = the arm job's recomputed kickoff frame (or `MISSING`). This replaces `vars.E7_KICKOFF_EXPECTED_SOURCE`, which is retired.
   - The confirmation's scheduled source = the arm job's recomputed confirmation frame; its closure = the pinned literal.

## 4. Draft confirmation schedule
- `cron: '28,58 * * * *'` on `e7-hosted-booking-confirmation.yml`. It is always the detect flow with empty bindings and never routes to the manual execute path.
- The cadence is **TEST-only and nominal** (GitHub may delay or drop scheduled runs). It is **not a launch SLA**.
- Shipped CLOSED: with `executeEnabled` false, nothing past the arm job can do anything even when armed.

## 5. Preserved
- Detect cutoff / exclusions, the fact-bound fingerprint, admission, worker claim / lease / latch / receipt / pre-send fences and no-resend are unchanged.
- The capacity limitation (more than one eligible → STOP) is unchanged.
- No pipeline bytes, no kickoff tooling, no SQL / migration.

## 6. Limitations (explicit; do NOT activate on S2 alone)
- **The pipeline is NOT gated by the arm.** `e7-hosted-pipeline.yml` and its runner are untouched; their bytes are SQL-bound via 0026. A pipeline run that is **already queued**, or that is **dispatched directly** (manually, or by a kickoff run that passed its gates before the variable changed), is not refused by the arm.
  - Do not activate until a separate reviewed pipeline / environment cascade (D-ENV (b) + the 0028 literal rebind) adds the same admission to the pipeline.
- **Clearing or changing the variable does not stop already-running work.** A job that already passed its gates continues under its own fences. Only gates evaluated afterwards refuse.
- A GitHub environment approval granted later does not re-run the arm job. But every runner step re-reads the variable at its own start, so a stale queued job refuses.
- The arm decides only routing and admission. The runners' own closed flags, the environment reviewer gate and all DB fences remain the authorities.
