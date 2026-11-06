# E7 hosted read-only probe — implementation / running / activation packet (NOT ACTIVATED, NOT AUTHORIZED)

> **G6B revision (offline, review only, branch `feature/e7-hosted-probe-g6b`):** scope is now **P-H2 → P-S1 → P-S2** (≤ 3 GETs): the 606998 calendar for 2027-01-18 → 2027-01-20, the Stripe TEST account, and the canceled Run-3 TEST PaymentIntent `pi_3UYqhH2B9LTneQgw1Q0IoYtz` (`expand[]=latest_charge`). Tooling `43ef79cab2c928e2aad19e77258b4b31116ff7c0` (d1e20d71 + Stripe-Version constant `2026-01-28.clover` + tests), sourceDigest `19b99e6f97cff5d8e405b3b52feff99f441445796b9651a719ffca046d8069f0`. Where this packet below says P-H1 / 2 GETs / Dahlia / d1e20d71, the G6B values apply. No dispatch is authorized by this revision.

**Status.** This prepares a temporary **GitHub-hosted Ubuntu runner**, controlled from a browser, as the execution location for the accepted read-only probe tooling. Joel needs no Mac or Linux machine and no installs.

**Not activated:**
- the workflow is not on `main`, so no "Run workflow" button exists yet;
- no PR has been opened or merged;
- no environment, secret or permission has been set;
- nothing has run on a runner, so **no native network or runner-environment fact is verified**.

**Real execution stays CLOSED** until Joel explicitly approves one exact filled package. Workflow inputs, labels and hashes are never consent.

## 1. What was added (branch `feature/e7-hosted-readonly-probe`, based on exact `main` `55267fba`, no E7 history)
| File | Role |
|---|---|
| `.github/workflows/e7-readonly-probe.yml` | Manual `workflow_dispatch` only. Default `mode: preflight`. Two jobs, both on `ubuntu-24.04` with Node exactly `22.22.0` |
| `scripts/e7-hosted-probe.mjs` | Thin wrapper (Node built-ins only) around the **accepted, unchanged** tooling |
| `test/e7-hosted-probe.test.mjs` | Offline tests: synthetic tooling tree, fake CLI child, guarded https / fetch |
| `claude/e7-hosted-probe.md` | This packet |

**The workflow:**
- **Trigger and token:** manual `workflow_dispatch` only (no push / PR / `pull_request_target` / schedule triggers); `permissions: contents: read`; `concurrency` with `cancel-in-progress: false`; no artifact or cache action.
- **Pinned official actions** (commit SHAs verified from the public GitHub repositories; tags resolve to these commits): `actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803` (v6.1.0) and `actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38` (v6.5.0, `package-manager-cache: false`).
- **Checkouts:** both use `persist-credentials: false`. One is the wrapper (the dispatched commit, i.e. `main` after activation). The other is the accepted tooling at the **fixed** commit `43ef79cab2c928e2aad19e77258b4b31116ff7c0` (G6B), in `tooling/`. There is no ref, script or module-path input.
- **Inputs** reach the wrapper only through `env:`. Every `run:` line is a fixed command.
- **Job `preflight`**, the default: no secrets, no provider request.
- **Job `execute`:**
  - runs only when `mode == execute` **and** `github.ref == refs/heads/main`;
  - uses `environment: e7-readonly-probe`;
  - step "Verify" has no secrets;
  - **only the final step** maps `secrets.E7_HOSTAWAY_TOKEN` / `secrets.E7_STRIPE_TEST_KEY` into its `env`. No third-party action receives them.
- **Timeout:** 20 minutes per job. A job timeout could still interrupt a running step, so it is **not** a claim that zero requests were made.

**The wrapper** (`preflight` | `verify` | `execute`):
1. **Inputs:** validated (`acct_[A-Za-z0-9]{1,64}`, label `[A-Za-z0-9._:-]{1,80}`, 64-hex hashes), never echoed. The **reserved SYNTHETIC account and label are refused in every mode** (R-H3). Preflight takes the account and label together or not at all. `verify` / `execute` require account, label, expected `planHash` and expected `sourceDigest` with **no defaults**, and the expected digest must equal the fixed accepted digest. `verify` and `preflight` refuse if a secret is in scope.
2. **Layout:** `RUNNER_TEMP` must be outside both the workspace and the tooling checkout.
3. **Tooling bytes:** the 13 closure files are hashed (regular files only, no symlink, ≤ 256 KiB each, ≤ 2 MiB total, the accepted framing) **before any tooling code runs**. The result must equal `23212caabf508f0aa929a2c3beb9f6f216b0cc3bc697cd783ba7ed203e21ce3d`. Locally, the wrapper's own function over the accepted checkout gives exactly that value.
4. **Preflight only — E1:** `node --test --test-reporter=tap test/e7-connected-probe-cli-main.test.mjs` in the tooling checkout. These are fake / synthetic tests, **labelled not connectivity evidence**. E1 passes only with an acknowledged child (no spawn failure or signal, not truncated), status 0 and a meaningful TAP (`# tests` > 0, pass = tests, fail = 0).
5. **Plan:** listing `606998`, calendar `2027-01-18 → 2027-01-20`, PaymentIntent `pi_3UYqhH2B9LTneQgw1Q0IoYtz`, `["P-H2","P-S1","P-S2"]` (maxRequests 3), limits `10000 / 30000 / 5000`, `Stripe-Version 2026-01-28.clover`, Node `22.22.0`, `reviewedCommit` = the tooling commit.
   - With no account / label, preflight builds a **labelled SYNTHETIC** plan (`acct_SyntheticPreflightOnly`, `SYNTHETIC-preflight-not-for-execute`) whose hash is reported as `planKind: SYNTHETIC` and is never usable for execute.
   - With them, it builds the **REAL** plan.

   The accepted CLI's `prepare-plan` writes the canonical plan in a fresh `0700` temp dir.
   - **prepare** must have real process status 0 plus `e7-probe-prepare-v1` / `PREP_OK` / file `CLOSED_ACK` / `exitCode` 0.
   - **inspect** must have real process status **10** plus the `e7-probe-cli-stdout-v1` envelope with `exitCode` 10, `ENV_OK`, the fixed digest, the same `planHash` and exactly 2 probes.

   These checks happen **before** any credential file or network, and a failed prepare / inspect never leads to `execute` (R-H1).
6. **`execute`:**
   - the inspected `planHash` must equal the expected one;
   - both secrets must be present (otherwise `HOSTED_CREDENTIALS_MISSING`, with no file and no child);
   - a `0600` credential file is written with `O_EXCL` in a fresh `0700` dir under `RUNNER_TEMP`;
   - the accepted CLI `execute` runs with `--expect-requests 2`;
   - the credential file and every job-owned temp dir are removed afterwards. Nothing else is deleted.
7. **Children:** every child is a plain `node <cli> …` (no Node flags, `shell: false`). Its env is the job env **minus every `E7_*` key**, so neither secret reaches a child. Refused security variables are **not** unset or bypassed. stdout is captured with a bound, stderr is only counted, and the execute child is never killed by the wrapper.
8. **Execute status (R-H1):** an unacknowledged child (spawn failure, signal, truncated stdout) gives `HOSTED_CHILD_FAILED` with output `UNKNOWN`. The real process status must equal the envelope's own `exitCode`, otherwise `HOSTED_CHILD_OUTPUT_UNKNOWN`. Success requires status 0, `exitCode` 0, `CLI_COMPLETED_OK`, `tailUncertain:false`, summary file `CLOSED_ACK` and close state `CLOSED`. Known nonzero accepted outcomes (e.g. 6 / 11 / 8 / 9) stay `EXECUTE_NOT_OK`, with their evidence and no retry.
9. **Publication:** only a **reviewed projection** is printed (one JSON line in the step log plus a job-summary table): mode, code, workflow commit, tooling commit, computed digest, plan kind, `planHash`, E1 counts, inspect exit / env code, and the execute envelope's exit / outcome / `tailUncertain` / summary-file state / per-probe id-outcome-code-HTTP / gates.
   - **Every published child string must be an exact member of its field's copied accepted vocabulary** (`VOCAB`: probe ids / outcomes / codes, transport codes, gate names and values, tail, primary outcomes, summary-file / close states, env and credential codes). Digests and hashes must be exact 64-hex, and HTTP statuses must be integers 100…599.
   - Anything else is published as `REDACTED`, and unknown gate NAMES are dropped and only counted. It is never a syntax-rule pass (R-H2).
   - The workflow and tooling identities are fixed constants, or a separately validated 40-hex commit.

   There are no raw child outputs, paths, secrets or error text. The public repo's logs show only this.

**Tests (CLAUDE-run, container, Node `22.22.0`):** the original head `07807310` passed 10/10 on its first full run. See §4 for the root CODE HOLD corrections and their red / green runs. It covers:
- mode defaults / usage;
- synthetic vs real plan separation;
- the E1 failure path;
- input refusals before any child;
- digest / symlink / missing-file / layout refusals before any child;
- missing explicit execute inputs;
- secret-scope violations;
- `planHash` / env / scope / inspect mismatches before any credential file;
- the full execute handoff over a FAKE CLI: `0600` / `0700` modes, exact argv, no `E7_*` in the child env, `execArgv` 0, cleanup;
- missing credentials;
- hostile / malformed child output (REDACTED / `UNKNOWN`, stderr only counted);
- workflow static pins;
- wrapper source pins.

The https / fetch guards counted 0, and no real credential or network was used. A YAML parse (Python `yaml.safe_load`) confirms the single trigger, permissions, concurrency, jobs and steps; `actionlint` is not installed and was not installed. `main` has no `npm test` script (`package.json` defines none), so none was run and none was invented.

## 2. Activation — the remaining actions (none done; each needs its own explicit go-ahead)
1. **Root CODE review** of this branch.
2. **Isolated PR to `main`** containing exactly these four files. The branch is based on `main` `55267fba`, so the diff is only them: no E7 history, no change to `api/`, `package.json` or `vercel.json`.
   - GitHub shows the manual "Run workflow" button **only once the workflow file is on the default branch** ([manually run a workflow](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)).
   - Merging needs Joel's explicit approval.
   - Whether a `main` push triggers the existing Vercel deployment is **UNVERIFIED**. The four files contain no secrets and the repository is already public.
3. **Before any `execute` dispatch**, the repo admin configures **environment `e7-readonly-probe`** in Settings → Environments:
   - **required reviewer: Joel**;
   - **deployment branches: `main` only**;
   - **environment secrets** `E7_HOSTAWAY_TOKEN` (the existing token, no mint) and `E7_STRIPE_TEST_KEY` (an `sk_test_` key) — environment-level only, never repository-wide, never in inputs or chat.

   Environment secrets are available to a job only after its configured rules pass ([manage environments](https://docs.github.com/en/enterprise-cloud@latest/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)).
   - **Caution (same docs):** "Running a workflow that references an environment that does not exist will create an environment with the referenced name." That auto-created environment has no protection rules. Without secrets the wrapper fails closed, but **do not dispatch `execute` before configuring it**. The workflow name alone creates no protection.
   - These are setting changes and are not done here.
4. **Preflight on the runner** (Actions → `e7-readonly-probe` → Run workflow, `mode: preflight`, inputs empty). This gives the first real runner facts: E1, the computed digest and inspect's `preflight.code`. Proxy / refused-variable presence on the runner is unknown until then. Still no provider request.
5. Joel supplies the **Stripe TEST account id** and a **label**, then runs preflight again with them. The result is `planKind: REAL` and the `planHash`.
6. **Fill one exact approval package:** `main` commit, tooling commit `43ef79ca`, digest, `planHash`, listing `606998`, calendar dates, PI, account, label, ≤ 3 GETs, outcome semantics (owner packet §5).
7. **Joel explicitly approves that exact package.**
8. Dispatch `execute` with the exact inputs, then Joel approves the environment gate. That makes at most 3 GETs (P-S2 only after P-S1 succeeds); the evidence is the job summary / log projection.

## 3. Residuals (stated, not hidden)
- **Runner network:** egress, proxy, TLS and refused-variable presence are **UNVERIFIED** until a run. Native X socket / TLS ordering stays a fail-closed residual.
- **Branch selection:** the dispatch UI lets the caller pick a branch. `execute` is guarded to `refs/heads/main` in the workflow, **and** the environment branch policy must enforce it, because a modified workflow on another branch could drop the `if`.
- **Secrets in the wrapper:** they are present in the wrapper process's own env during the final step (never in children, files other than the `0600` credential file, logs or outputs). GitHub's log masking is extra protection, not relied on.
- **Review boundary:** the wrapper and workflow bytes are a **separate review boundary**. They are not covered by the C3 `sourceDigest`, which binds only the tooling closure.
- **Out of scope:** the Hostaway calendar link is irrelevant to these two GETs, and calendar syncing is owner-proven separately. Bookings, writes, payments, notifications and Airbnb stay CLOSED. The protected reservations `70636076 / 71045356 / 71072615 / 71081885` get zero action.

## 4. Root CODE HOLD on `07807310` — corrections (same branch, fast-forward)
Only `scripts/e7-hosted-probe.mjs`, `test/e7-hosted-probe.test.mjs` and this doc changed; the workflow is unchanged.

| Item | Defect (root probes failed 3 / 3) | Correction |
|---|---|---|
| **R-H1** true child status | Process status, signal, spawn failure and truncation were ignored. A child exiting 17 while printing an `exitCode: 0` envelope was reported `EXECUTE_COMPLETED_OK`. The FAKE inspect also exited 0 while claiming 10 — a fixture fault | Every stage validates the acknowledgment (no spawn failure or signal, safe integer status, no truncation) **and** the accepted status plus schema: E1 0 with meaningful TAP; prepare 0 / `PREP_OK` / `CLOSED_ACK`; inspect **10** with envelope `exitCode` 10; execute status === envelope `exitCode`, and success only when all accepted success fields agree. Failures give `HOSTED_CHILD_FAILED` / `HOSTED_CHILD_OUTPUT_UNKNOWN` / `HOSTED_*_FAILED` / `EXECUTE_NOT_OK`, and never reach `execute` after a failed prepare / inspect. The fake CLI now exits with the accepted statuses (prepare 0, inspect 10, execute = envelope `exitCode`) |
| **R-H2** exact output vocabulary | The `[A-Za-z0-9_.:-]` syntax rule let a plain-ASCII synthetic token through into `probes[].code` and the job summary | Per-field exact membership in copied accepted vocabularies (`VOCAB`); exact 64-hex for digests / hashes; otherwise `REDACTED` (unknown gate names dropped and counted). A **parity test** compares every copied list with the accepted exports when `E7_PARITY_TOOLING_DIR` points at the accepted checkout (run here against `d1e20d71`-identical bytes: equal; skipped on `main`, where that checkout is absent) |
| **R-H3** synthetic cannot execute | The synthetic preflight hash plus the reserved synthetic account / label could pass `verify` / `execute` | The reserved synthetic account **or** label is refused (`HOSTED_INPUT_INVALID`) in every mode, at input validation, before the layout check, the source check, any child, any credential file or any network. A synthetic preflight result can never qualify a REAL package |

**Red / green (CLAUDE-run):**
- **RED:** the new tests (and the corrected fixture), run against the unchanged `07807310` wrapper, gave **10 / 14**. The four failures were R-H1, R-H2, the R-H2 parity test (no `VOCAB` export) and R-H3.
- **GREEN, FIRST FULL TAP of the corrected wrapper: 13 / 14.** The R-H1 test helper `failedSpawn("prepare")` matched argv `"prepare"`, but the CLI token is `"prepare-plan"`, so that case never failed the spawn. This was a test bug; the wrapper was unchanged.
- **Run 2: 14 / 14** with parity, and 13 + 1 skipped without the parity directory (as on `main`).
- Guards (https / fetch) counted 0. No provider, PR, merge, environment, secret or runner action.
