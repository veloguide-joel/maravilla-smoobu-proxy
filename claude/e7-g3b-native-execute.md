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
