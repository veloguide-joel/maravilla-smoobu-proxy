# E7 G3b — native R1 EXECUTE wiring (OFFLINE, LOCAL) — contract

**Authority and base.** Root ruling 85ef2e4c part B, starting from e7-test `0807e3048e419b3405c649f445760b1b47f331c3` on the isolated branch `feature/e7-g3b-native-execute`.

**What is authorized.** CODE, plus disposable-PG / FAKE-exchange tests. NOT authorized: any real credential read, connection, quote, authorization, booking, push, PR or merge.

**Accepted modules are used UNCHANGED:**
- `runReservationAbortR1` and its bridge, workers and fences;
- the R1 file journal;
- the T transports and the X exchange;
- the provider and DB login readers;
- `createBookingPool`;
- the binder and preflight.

## 1. Grammar (pure, decided from argv first)

The command is `execute` followed by **all 13 flags**, each exactly once, in any order, with typed values:

| flag | value |
|---|---|
| `--package`, `--plan` | canonical absolute path (the reviewed package / plan bytes) |
| `--expect-package-hash`, `--expect-executor-digest`, `--expect-native-digest` | 64 lowercase hex |
| `--intent` | uuid (must equal the bound package's intent) |
| `--provider-credentials` | path (accepted provider file: Hostaway token + Stripe TEST key) |
| `--db-app`, `--db-report` | paths (G3a login files) |
| `--db-ca` | path to a PEM CA, or `none` (`none` is only usable for loopback; the accepted pool refuses remote without a CA) |
| `--journal-dir`, `--head-dir` | owner directories (creation-only R1 journal) |
| `--stripe-api-version` | the reviewed Stripe-Version pin (still an unresolved owner / root input, B4) |

- All paths must be distinct.
- Anything else is `USAGE` (exit 2). That covers unknown modes, a short or extra `execute`, repeated flags, untyped values and relative paths.
- A `USAGE` refusal happens BEFORE any env / uid / platform / process-property read, import, file, credential, network, pool or journal access.
- There is no module-path or injection argument and no env credential fallback.

`inspect` is unchanged.

## 2. Verification order (honest)

1. **Grammar** (pure).
2. **Platform and uid** (lazy native reads), linux / darwin only.
3. **Native execution closure.** Built-ins only (`node:fs/promises`, `node:crypto`, loaded by fixed specifier); no non-built-in module has been imported yet.
   - **Sources.** `NATIVE_EXEC_SOURCES` is a literal sorted list of 56 paths in the CLI. It is:
     - the scanned static + dynamic relative import graph of `run-plan-cli-main.mjs` and `run-r1-launcher.mjs`;
     - ∪ `RUN_PLAN_CLOSURE` and `R1_EXECUTOR_CLOSURE`, which the binder reads as data;
     - ∪ `package.json` and `package-lock.json`.

     The test suite re-scans it independently.
   - **Dependencies.** `NATIVE_EXTERNALS = ["pg"]` (the scanned bare specifiers). The CLI takes the transitive runtime packages from the lock's `packages` map — 14 packages today. It reads the lock bytes from the closure, so the lock is covered by the same digest. Every regular file in those package directories is hashed; a symlink or special entry refuses.
   - **Read rules.** Every read is `O_RDONLY|O_NOFOLLOW`, regular-file, size-bounded, with total and count caps.
   - **Digest** = SHA-256(`"e7-native-exec-closure-v1\n"` ‖ for each entry sorted by path: `path NUL len NUL bytes NUL`). Today it covers 56 source files + 141 dependency files.
   - **Match.** The digest must equal `--expect-native-digest`, else `NATIVE_CLOSURE_REFUSED` / `NATIVE_DIGEST_MISMATCH` (exit 4). The computed digest is reported; it is not secret.
   - **No self-hash trick.** No module embeds the digest; it arrives on argv from the reviewed package.
   - **Not covered (TRUST):** the Node binary, OS, CA store and filesystem namespace. Directory ancestors are TRUST, as in the accepted reader.
4. **Only now:** fixed-specifier imports of the accepted adapters (`probe-cli-main`) and of `run-r1-launcher.mjs`.
5. **Launcher steps:**
   - **a.** Accepted env evaluation of the presence-only snapshot.
   - **b.** Package / plan bytes plus `RUN_PLAN_CLOSURE` / `R1_EXECUTOR_CLOSURE` from the verified root, then `bindRunPackageR1Journal` (pure). This checks package recompute, the expected package hash, the executor digest and freshness at the current clock. Then `intentId === --intent`.
   - **c.** OWNER ingress, through the accepted readers and the accepted native read-only adapter: provider file (`readProbeCredentialFile`), then DB logins (`readDbLoginFiles`), then the CA PEM, which is a bounded read with a shape check.
   - **d.** CONSTRUCTION only — no connect, no request:
     - `createBookingPool` for app and report: verified TLS with `rejectUnauthorized: true` and the owner CA for remote; plain only for loopback; fails closed on URL TLS overrides.
     - The accepted X → T stack (the Stripe `accountId` comes from the BOUND scope, not a flag).
   - **e.** `openFileJournalR1` with the explicit owner dirs, using the journal-minted binding. It is creation-only, and an existing file refuses.
   - **f.** `runReservationAbortR1`. This is where the same advisory lock, same-DB / TEST / app / report role checks (live), the fresh P0 + post-attestation preflight, the fences, the M8 bridge, receipt / trusted-head cleanup authority, the release proof and the exclusion re-read all happen, unchanged.
   - **g.** Teardown, each step with an honest disposition: `result.finalize()` → journal `close()` → each pool `end()` bounded to 10 s (an unsettled end is reported `unknown`; the process exits after the one line, so nothing is reused).
6. **Output.** ONE stdout line containing whitelisted codes / counts / digests only, plus `teardown`. No URL, password, token, key, path, guest or provider text.
   - Exit codes: 0 `ENDED_RELEASED`, 6 STOPPED, 4 refused / REFUSED, 1 failure.
   - The pool's own errors never carry the URL, and the launcher drops them anyway.

**Digest changes.** The foundation and G1 digests change ONLY because their files changed:
- Foundation (`RUN_PLAN_CLOSURE`) is unchanged: G3b adds no file to it, and every foundation file is byte-identical.
- The G1 executor closure is unchanged.
- The new NATIVE digest is separate and complete for the launched consumer.

## 3. Attestation, signals, hooks

- **Attestation over stdin.** For each checkpoint the core asks for, a prompt is written to stderr: `E7ATTEST {runId, checkpoint, intentId, manifestHash, connection}`. The OWNER answers on stdin with `ATTEST <runId> <checkpoint> <evidenceRef>` or `DECLINE <runId> <checkpoint>`.
  - Lines for another run / checkpoint, or with a malformed `evidenceRef`, are ignored.
  - There is no automation and no fabricated attestation. The core's own `ATTEST_MS` bound and the run signal apply.
- **Signals.** The first SIGINT / SIGTERM aborts the run's AbortSignal (the accepted boundary: stop at the next boundary, nothing retried). A second signal is a terminal exit 130 with the tail uncertain; the journal is never repaired.
  - **During an attestation wait,** the native callback honours the signal by REJECTING (never a fabricated answer or decline), and the accepted core records that first cause as `ATTESTATION_FAILED`.
  - **Interrupt flag.** The CLI line reports `interrupted: true` whenever a signal arrived, so the stop is attributed truthfully without changing the core. Outside attestation waits, the core's own boundary yields `CANCELLED`.
- **Test hooks.** `hooks.launch = { exchanges, timeScale }` is reachable only through the in-process `main(proc, hooks)`. The native boot always passes `defaultHooks()`: real exchanges, real time. Hooks are never selectable from argv / env.

## 4. Known interactions (held for root, NOT widened)

- **sslmode.** G3a's login validator accepts `?sslmode=require|verify-ca|verify-full`, but the accepted pool refuses every `ssl*` URL option (TLS is configured by the pool). Owner login files must therefore OMIT `sslmode`; otherwise the run refuses at construction with `POOL_CONFIG_REFUSED`, after ingress and before any connection.
- **Stripe-Version** is supplied by `--stripe-api-version`. The real pin is still an unresolved review input.

## 5. Changed assertions (G3a tests)

| test | before | now | reason |
|---|---|---|---|
| C4 / C6 `["execute"]`, `["execute","--plan",f]` | `EXECUTE_NOT_IMPLEMENTED` exit 5, zero access | `USAGE` exit 2, zero access (same tracer checks) | execute is implemented, but only through the full grammar; refusal-before-access is kept |
| C5 static / dynamic import lists | 3 dynamic specifiers | + `./run-r1-launcher.mjs`, `node:fs/promises`, `node:crypto` | execute wiring; built-ins are imported only after the grammar |
| C5 forbidden-substring scan | `runReservationAbortR1`, `credential`, `pg`, `https`, `setTimeout` absent | the CLI still never names the consumer / pg / https; `credential` / `setTimeout` now appear (flag name, native timers) | the launcher owns all consumer wiring |

## 6. Activation checklist (remaining)

1. **Machine:** a POSIX machine with Node 22.22.0 / 24.22.1 and no refused env variables, plus durable owner-only `--journal-dir` / `--head-dir` (owner choice; not an ephemeral sandbox).
2. **Owner credential files** (0600, outside the repo): provider file; app / report login files with **no `sslmode`**; the DB CA PEM. Owner-typed values only.
3. **Reviewed inputs:** the Stripe-Version pin, and the reviewed package / plan with its expected package hash, executor digest and native digest (computed on the exact install).
4. **Shared 0017** apply + readback (the reviewed procedure in the G3a contract §5).
5. **A fresh quote and payment_authorized TEST intent**, respecting any automatic review rejection (the prior hosted Pay handoff is never routed around).
6. **ONE bounded run** with the owner answering the three attestations. Capture, recording, refunds and notifications stay out; `guest.notify` stays queued / unsent.

## 7. Evidence and honest limits

**Tests (separate runs; FIRST TAPs preserved).**
- `test/e7-connected-run-r1-native-execute.test.mjs`:
  - N1 closure scan + independent digest;
  - N2 grammar + real child boot with no process-setting / fs access;
  - N3 real child boot closure refusals (wrong digest, tampered source copy, tampered dependency copy, symlink in a package; launcher never resolved);
  - N4 real child boot ordered refusals (package hash / executor pin / intent before owner files; provider / login files before pools; remote DB without a CA → `POOL_CONFIG_REFUSED`; no journal created; canaries never echoed).
- `test/db/e7-run-r1-native-execute.test.mjs`, disposable PG, through `main(proc, hooks)` with real files:
  - E1 both modes: create 1 / host-cancel 1 / void 1, capture / record / refund 0, legs, claim, exclusions equal, three owner attestations, honest teardown, R1 journal files plus recovery, no connection left;
  - E2 live role gates (extra disposable logins), PI and quote refusals;
  - E3 SIGINT / SIGTERM, lock loss, second-signal exit 130;
  - E4 attestation binding / decline, unknown host-cancel / void with exactly one send;
  - E5 refusal order on the in-process path: digest, package, intent, provider, `sslmode`, remote-without-CA, existing journal.

**Limits (stated, not claimed):**
- The full lifecycle is exercised IN-PROCESS. The FAKE exchange can only be injected through the in-process hook; the real child boot is covered up to the pool-construction refusal.
- The real https exchange, a remote TLS database and real Stripe / Hostaway are NOT exercised.
- File-journal ACK loss / unknown tail is not re-injected through the launcher. The launcher passes the accepted file journal through unchanged; that behaviour is covered by the accepted M2-E F2 / F3 and G2b G7 suites.
- A second signal exits 130 without teardown (tail uncertain, nothing repaired), by design.

## 8. Root review of 128ac08 — corrections (H1, H2) and rulings

### H1 — owner attestation adapter (`createStdinAttest`)

**Gap (reproduced).** The candidate QUEUED input lines that arrived while no checkpoint prompt was active, and later adopted them as answers. Root's exact-helper scenario reproduced this; A1, run against 128ac08, resolved all three checkpoints with `synthetic/early` and zero post-prompt replies.

**Fix.**
- **One active prompt at a time.** Each prompt carries a FRESH 128-bit random token.
- **Prompt.** `E7ATTEST {runId, checkpoint, intentId, manifestHash, connection, token, reply}`. It shows the exact reply forms: `ATTEST <runId> <checkpoint> <token> <evidenceRef>` and `DECLINE <runId> <checkpoint> <token>`.
- **Acceptance.** An answer is accepted only while its prompt is active, and only with that prompt's run, checkpoint AND token.
- **Dropped input.**
  - Input that arrives while no prompt is active is DROPPED, never queued: before the first prompt, between checkpoints, or after a match in the same chunk.
  - A partial line buffered before a prompt is discarded when the prompt is issued.
  - Lines are capped at 512 characters, and an over-long line is dropped whole. The counters are bounded.
- **Concurrency.** A second concurrent waiter is refused.
- **Abort.** The abort listener is attached before the prompt is written, and an abort during the write is still caught.
- **Limit.** The token stops stale or pre-queued adoption. It does NOT authenticate the truth of the owner's evidence.
- **Unchanged:** the core / journal protocol.

### H2 — `pg@8.18.0` optional-peer branch

**Gap.** `!!process.env.NODE_PG_FORCE_NATIVE` at `pg` import makes `pg` require `./native`, which requires the OPTIONAL peer `pg-native`. That peer lies outside the lock's dependencies / optionalDependencies traversal, and so outside the native digest.

Reproduced (H2a) on the candidate in a real child, with a labelled synthetic peer copy and an unchanged digest:
- values "1" and "0" load the peer;
- value "" does not (pg's own truthiness).

**Fix (bootstrap only).**
- **Presence-only refusal.** If `NODE_PG_FORCE_NATIVE` is present, with any value, the run refuses as `BOOT_ENV_REFUSED` / `PG_NATIVE_SELECTOR_PRESENT`. This happens right after grammar + platform / uid, BEFORE closure verification and before any import that can load `pg` (H2b).
- **Env evaluation moved earlier.** The ACCEPTED, unchanged env evaluation (`probe-env-preflight`, node:util only, part of the verified closure) now runs in the CLI after closure verification and BEFORE the launcher import. The accepted refused variables and exec flags therefore stop the run before the dependency graph is evaluated. The accepted modules and the env snapshot are unchanged.

**Audit of other resolution inputs for this exact pg load:**
- `NODE_OPTIONS` / exec flags (`--require`, `--import`, `--conditions`, loaders) are refused by the accepted evaluation, now before the pg import. A flag given to the very `node` command still runs before any user code; that is TRUST.
- `NODE_PATH` affects only bare specifiers that are not found locally. `pg` and its 14 runtime packages resolve from the verified `node_modules`, and the only unpinned bare `require` (`pg-native`) is now fenced, so `NODE_PATH` is not reachable on this path.
- `PG*` connection variables (`PGHOST`, `PGSSLMODE`, …) do not override the explicit connection string or the explicit `ssl` object that the accepted pool passes. The accepted pool also fails closed on effective host / TLS.

**Supported driver / install assumption.** The pure-JS `pg@8.18.0` from the reviewed lock, installed in the verified `node_modules`, with NO `pg-native` usage. The native digest is complete for that path only. A runtime-selectable unpinned peer is fenced, not covered.

### Rulings recorded (documentation and inputs only)

- **TLS.** The accepted `createBookingPool` TLS policy is unchanged. The eventual owner login files omit URL `sslmode` and supply an explicit verified CA (`--db-ca`).
- **Stripe version.** `--stripe-api-version` stays typed and is reviewed per run. The intended future pin is `2026-01-28.clover` (matching accepted checkout / cleanup and the observed G6B). That is not a claim of general provider parity and not approval of a run.
- **Teardown.** The accepted `result.finalize()` and `journal.close()` may stay pending until real quiescence; ONLY `pool.end()` has the 10 s bound. A second signal exits 130 with uncertainty. No timeout releases the lock or resources before quiescence.

### Changed assertions (this correction)

| test | change | reason |
|---|---|---|
| DB E1 / E4 replies | the reply carries the prompt token; E4 adds no-token and wrong-token lines | H1 protocol |
| G3a C5 dynamic import list | + `./probe-env-preflight.mjs` | H2 ordering |

### Failing-before attribution

| test | on 128ac08 | meaning |
|---|---|---|
| A1 / A2 | red | A1 shows `synthetic/early` adopted |
| H2a | candidate loads the synthetic peer for "1" and "0" | reproduces H2 |
| DB E6 | red only because the candidate does not accept the new token reply (baseline `TIMEOUT_ATTEST`) | protocol incompatibility, NOT an H1 discriminator; A1 is the discriminator |
