# C119 S4 — pipeline admission + fresh admission + one-time cascade (DRAFT, SHIPPED CLOSED) — notes, 2026-11-17

**Status: draft for ROOT review. Everything ships CLOSED and nothing was activated.**
- `executeEnabled`, `dispatchEnabled` and `readEnabled` stay FALSE everywhere.
- No variable, environment, reviewer, secret or settings change was made.
- No SQL was applied, the shared DB was never accessed, no provider was called, and no workflow was dispatched.
- **Both activation blockers stay OPEN** until this implementation and its hosted acceptance are reviewed.
- S5 (healthy-PENDING continuation) is separate.

**Two draft PRs**
- tooling, base e7-test `a314681b`;
- main, base `5b9c0677`.

**Acyclic graph:** pipeline bytes → tooling → downstream frames → release → cross-runner literals.

## 1. Admission placements (all five moved jobs)
| # | where | what |
|---|---|---|
| P0 | pipeline `arm` job (no environment or secret; `contents: read`) | the S2 arm check, unchanged (`node wrapper/scripts/e7-test-arm.mjs check`); the variable is a claim, and the release is recomputed from the checkout |
| P1 | pipeline `execute.if` | `needs: [preflight, arm]`; requires armed, mode `execute`, and main |
| P2 | existing pre-secret re-check step | unchanged |
| **P3** | **new step in all five jobs** (pipeline execute; kickoff detect / execute; confirmation detect / execute), placed right after P2 and before verify / npm / any secret | live `GET /repos/…/git/ref/heads/main`. It uses the **built-in token on stdin only**, https only, no redirects, a 15 s limit and an 8 KiB limit. The reply must be `object.type == commit` with `sha == github.sha`; otherwise the step exits 3 with `MAIN_MOVED` / `MAIN_UNREADABLE`. The step is byte-identical in all five jobs. Permissions are unchanged: `contents: read` already, and the token is never in a provider-secret step |
| P4 | pipeline runner `verify` / `execute` | labelled copy of the arm module; `HPL_ARM_CLOSED` before any value, import, secret, DB or provider; no manual bypass |
| **P5** | pipeline core, under the run lock: at admission (before any provider exchange) **and** again before **each** coordinator invocation | one read of `booking.pipeline_kickoff_requests` as the runtime role (existing 0024 grant + RLS; no new privilege). See the P5 details below |

**P5 details**
- **Admit only if:** exactly one row with a closed row shape, state `claimed` | `dispatch_accepted`, a typed 64-hex `plan_hash` equal to the run's, and `dispatch_inputs` equal to the run's 12 dispatched input strings (closed key set, all strings, exact canonical equality).
- **Refuse (STOP `ADMISSION_REFUSED:*`)** on anything else: no row, several rows, another state, malformed, a read error. The result is zero coordinator invocations and zero provider calls, and the lock is released by the normal teardown.
- **Run-side binding:** the run's own binding must also be closed, typed and consistent with the plan (`CORE_INVALID:REQUEST_BINDING`).
- **Unchanged:** leases, idempotency, unknown-state and cancellation fences.

**Revocation of not-yet-admitted work is a CLOSE commit moving main** (P3), or `gh run cancel`. Clearing the variable is NOT relied on.

**Point-in-time windows (stated, not hidden)**
- P3 → the last step: a few seconds in which a move of main is not seen.
- An admitted run is **not interrupted**: at most 2 invocations, at most a 150 s wait, 20 min. Neither run cancellation nor timeout safely interrupts a provider write that is under way.
- Any unrelated merge to main also revokes pending runs. The intent stays authorized with `dispatch_accepted`, the S3 status runner flags it, and it is human-owned / S5.

**Old runs are not retroactively protected.** Runs created before these checks carry no P3 / P5. The activation runbook must list every queued, waiting or in-progress run of the three workflows and cancel or drain it, with a readback, **before** the arm is set.

## 2. Concurrency (a TEST capacity / recovery limitation, not successful unattended processing)
- The global groups (`cancel-in-progress: false`) keep at most one pending run per workflow. A newer queued run **cancels** the older pending one (GitHub docs).
- Two kickoff dispatches within one pipeline run's duration can therefore leave a request `dispatch_accepted` with no progress.
- There is **no automatic re-dispatch or retry.** The status runner flags it as ACTION after 30 min, and recovery is human-owned / S5.

## 3. Isolated TEST environment (design / code only)
- The five moved jobs reference `environment: e7-test-auto`. The other **17** job references to `e7-readonly-probe` are untouched.
- While unarmed, every `e7-test-auto` job is skipped, so GitHub never auto-creates the environment.
- **The owner must create and configure `e7-test-auto` before any armed run:**
  - main-only deployment branch;
  - secret NAMES `E7_DEV_BOOKING_DATABASE_URL`, `E7_STRIPE_TEST_KEY`, `E7_HOSTAWAY_TOKEN`, `E7_RESEND_TEST_KEY`;
  - reviewers per D-ENV.
- That is NOT done here. The sandbox cannot read the environments API (HTTP 403), so the current configuration has not been verified.

## 4. K2 (resolved, executable)
- The historic `wrapperCommit` 9455bc9e does NOT contain the S4 bytes, so tooling `PINNED_REVISION` no longer names it. It now describes the reviewed ENABLE artifact honestly:
  - `closedSourceCommit 8c8c2d58` (commit 1/2 of the main PR, which contains only the pipeline files and the re-derived delta frames);
  - the closed frame, the sha-pinned C102 delta path, the ENABLE runner / workflow sha256, and the ENABLE frame.
- The transport's default GET pin is now a **named** historic constant. It never sends; the runtime always passes its own `github.sha`.
- **Tooling K2** reads the git objects at `closedSourceCommit` and applies the delta to reproduce the hashes (and checks the reverse). It then imports the REAL ENABLE runner and checks `CONSTANTS` / `buildPlan` / input names, and that the ENABLE runner's own P5 accepts exactly the kickoff-generated binding (a one-field change is refused). It is REQUIRED in the tooling focused CI (`E7_K2_REQUIRED=1`).
- **Main-side F4** does the same from this checkout's bytes.
- **Merge requirement:** the main PR must merge with a **merge commit**, so that `8c8c2d58` stays reachable.

## 5. Exact digest map (S2 / S3 main → S4 draft)
| item | before | S4 |
|---|---|---|
| pipeline CLOSED frame | `cfe62d4d…` | `ca63c1d7db20a24aacd498e74f0bf2e9a229bfc31dc68ee75e59a5b4393ad8f7` |
| pipeline ENABLE frame (= 0028 SQL literal = tooling `sourceDigest`) | `880db5b3…` | `5294b6b467839e1dd825e56063abc1ad1267eafdfb2973f2c2129e9b1f29c3f5` |
| ENABLE runner / workflow sha256 | `a5b9ebca…` / `3feeed15…` | `d4a593e9…f673` / `17208b78…5db4` |
| C102 delta fixture sha256 (ops unchanged) | — | `6c5fbd10…6f0b` |
| C103 known-answer plan hash at the ENABLE frame | `61ef5cef…` | `f4572091…6b59` (real ENABLE runner == tooling copy) |
| tooling (kickoff / TLS probe pin) | `66133a22` (MERGED) | `bbf12aa22446807df7b63a55e38a464f4be88763` (**MERGED** e7-test #194; tree `3057af31` == reviewed head `71750f58`) |
| kickoff closure | `e180398f…` | `573dae82…dc17` (only the plan + transport files differ) |
| 0028 up / down sha256 | — | `a72d2ce9…3642` / `c247b178…806f` |
| claim prosrc md5 (kickoff `CATALOG_PINS`) | `fb103173…` | `98ffe6c8…d284` (PG16 == PG17) |
| notification / status catalog pin | 27 `bcc11631…` | 28 `96d74ab10cdf7bdd99e125eb6825284e9b57cacec33478fb1a666746e8f91b1b` (only the `fn` section differs; read path unchanged) |
| arm manifest | `bae2c308…` | **unchanged** |
| arm-gate frame | `f15d66a7…` | `b0ddf2b7…9b18` (test literal removed, pipeline in the labelled-copy check) |
| kickoff frame | `3e8deca3…` | `dbb0d647…9d4e` |
| booking-confirmation frame | `ccb52e91…` | `f969791b…a859` |
| status frame (outside the release) | `06032c9b…` | `365018eb…54e0` |
| TLS probe frame (outside the release) | — | `7eec86f6…7f87` |
| **TEST arm release** | `12a8f416…` | `7a407d45741b62b3757209a55e096cf47874a0b155613e88fb7053eb6874546b` (literal only in cross-runner X5) |

**Hygiene**
- The pipeline workflow test W7 keeps its structural checks. The **foreign** digest literals moved to cross-runner **X6**, with the checks unchanged, so foreign runner edits can no longer rewrite the SQL-bound pipeline frame.
- The status workflow test no longer pins the release literal.

## 6. Finalization
1. **Done:** ROOT merged the tooling PR #194 into e7-test as `bbf12aa2` (tree `3057af31` == reviewed head `71750f58`; acceptance comment 6967739270).
2. **Done:** this PR was repinned mechanically:
   - the kickoff `toolingCommit` is `bbf12aa2` with status `MERGED`;
   - the TLS probe inherits it;
   - the workflow / CI tooling refs follow.

   Unchanged by the repin: the closure `573dae82`, `PINNED_REVISION`, the 0028 bytes, the pipeline source commit `8c8c2d58` and all four pipeline frame files, the delta and the manifest. Recomputed: the kickoff / TLS frames, the release and X5.
3. **Pending:** ROOT's final review, then merge with a merge commit (keeps `8c8c2d58` reachable).

**Later, separately authorized packets**
- the shared-TEST 0028 apply + readback (until then, kickoff / confirmation / status refuse on shared schema 27; this is fail-closed and intended);
- owner setup of `e7-test-auto`;
- the activation runbook (including the old-run drain);
- hosted acceptance.

## 7. Tests (disposable PG16 + PG17, fake providers)
**Pipeline**
- H5: arm truth table plus the binding handed to the core.
- H18: pure P5 + binding truth tables.
- H19: fake core — refusal before any provider call, fresh re-read before each invocation, lock released, `CORE_INVALID` binding.
- P19: real runtime role / RLS — no row and every non-admitted state or field difference result in STOP with zero calls and an unchanged DB; claimed and `dispatch_accepted` both complete.
- The whole P-suite is bound via labelled TEST SETUP on the immutable 0024 bytes.

**S4 admission suite** (outside every frame)
- F1: P3 static checks across all five jobs.
- F2: P3 executed against a stub curl for each job — the delayed path (main moved while queued / approval-held) refuses with exit 3, plus 13 unreadable / malformed cases; the token never reaches argv or output.
- F3: full chain at schema 28 — a real authorization, then the real kickoff claim via 0028, then the exact inputs, then P5 BOUND ×2, then the real coordinator: confirmed with 1/1/1 sends and ONE pristine notify. A re-run is refused with zero sends.
- F3b: a hand-built dispatch without a claim, and a tampered claimed dispatch, are both refused before any provider call.
- F4: main-side parity.

**Downstream runners:** kickoff / TLS (T''), confirmation / status (schema 28), the arm gate and cross-runner X1–X6.

**Tooling:** K1 / K2 (REQUIRED), the 0028 suite, and mechanical top-of-chain pins for 0028, with no assertion weakened. The SPENT C116 record packet runs at its own schema 27.
