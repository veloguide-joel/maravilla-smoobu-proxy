# E7 connected-test runner — OWNER-RUN READ-ONLY PROBE CLI / PREFLIGHT / CREDENTIAL-INGRESS CONTRACT, revision 1 (DOCS ONLY; PROPOSED; not implemented, not authorized)

**Branch** `feature/e7-connected-probe-cli-contract`, cut from exact `b6603cac` (P / T / X and the P→T→X rehearsal ACCEPTED offline). Files: this new contract; an accepted / next pointer in `claude/e7-connected-probe-stack-rehearsal.md`; a normative whitelist-union clarification + status pointer in `claude/e7-connected-readonly-probe-contract.md` (§11 / §11.1 history kept). No code, test, runtime, SQL, config, dependency, pin, worker, core, A, T, X or P change. **Nothing was executed:** no request, no owner credential / account / dashboard access, no env / secret read, no key / token creation, no install, no native / loopback / TLS / DNS / socket experiment, no trust / proxy / permission change. Public primary docs and repository source read-only.

**What this is.** The smallest usable owner-run, read-only command around the accepted P / T / X, so a later ONE consolidated exact approval package from Joel can name concrete things. **What it is not:** a hosted service, a booking CLI, a write path, a token mint, or permission to run anything. The booking runner and A stay synthetic-only and are never imported or relaxed. Owner inputs UNSET; live gates G-AUTH / G-FILTER / G-SHAPE / B4–B6, owner environment, credentials and the approval package CLOSED; protected reservations 70636076 / 71045356 / 71072615 / 71081885 zero-action; e74a OPEN (FIRST FULL TAP / STOP if ever reproduced). No readiness percentage; checkout is not live.

**Citation convention.** `file:line` at `b6603cac`.

## 0. Present (ACCEPTED, offline) vs PROPOSED
| Piece | State | Source |
|---|---|---|
| P `validateProbePlan` / `runReadonlyProbes`, `VOCABULARY`, `T_ERROR_CODES`, `TIMER_CLEANUP_KEYS`, `NODE_VERSION_LABELS`, `STRIPE_VERSION_CANDIDATE` | ACCEPTED (`27c0ea11`) | `scripts/e7-connected/readonly-probe.mjs:18–19, 23, 43, 45, 138, 366` |
| T `createE7HostawaySend` / `createE7StripeTestSend` | ACCEPTED (`0830f9a4`) | `scripts/e7-connected/http-transports.mjs:307, 353` |
| X `createE7RealExchange`, default `NODE_HTTPS_PRIMITIVE` | ACCEPTED (`af1b4db0`); fake-primitive tests only | `scripts/e7-connected/real-exchange.mjs:28, 186` |
| P→T→X composition over a fake primitive | ACCEPTED rehearsal (`b6603cac`) | `test/e7-connected-probe-stack-rehearsal.test.mjs` |
| fs identity prior art (lstat + fstat identity, `O_NOFOLLOW`, injected fs adapter) | ACCEPTED file journal F | `scripts/e7-connected/run-journal-file.mjs:10, 52–67, 78, 86–104` |
| exit-code / staged-refusal prior art | accepted E4 launcher | `scripts/e4-launcher/auth-check.mjs:50–97` |
| env preflight, credential ingress, command core, entrypoint | **PROPOSED here** | — |

## 1. Files, interfaces and import boundaries (PROPOSED, staged)
| Stage | File | Interface | Imports (only) |
|---|---|---|---|
| C1 | `scripts/e7-connected/probe-env-preflight.mjs` | `evaluateProbeEnvironment(snapshot) → frozen { ok, code, checks }` — PURE over an explicit snapshot; never reads `process` | none |
| C1 | `scripts/e7-connected/probe-credential-file.mjs` | `readProbeCredentialFile({ path, repoRoot, needs, fs, uid }) → native Promise<frozen { ok:true, hostawayToken?, stripeTestKey? } \| frozen { ok:false, code }>`; `fs` = injected adapter (F's adapter shape); no default fs import in the module | `node:util` |
| C2 | `scripts/e7-connected/probe-command.mjs` | `runProbeCommand({ argv, deps }) → native Promise<frozen { exitCode, output }>`; `deps` = `{ readPlanFile, envSnapshot, credentialFs, uid, repoRoot, sourceDigest, primitive, monotonic, timers, signal, writeSummary }` all injected | P, T, X, C1 modules |
| C3 | `scripts/e7-connected/probe-cli-main.mjs` | thin entry: binds real deps (`node:fs/promises`, `process`, `performance.now`, `setTimeout` / `clearTimeout`, X's default primitive, `SIGINT`), calls `runProbeCommand`, writes ONE stdout line, sets `process.exitCode` | C2 + `node:fs/promises`, `node:crypto` |

- Only C3 touches `process` / real fs / real timers / the real primitive. C1 and C2 are offline-testable with fakes. **C3 is not proposed for implementation in the next slice** (§9): no default executable live CLI exists until separately authorized.
- Never imported anywhere in this chain: A (`run-manifest`), core, workers, journals, DB, adapters, SDKs, `lib/hostaway.js` (env reads + re-mint + retry), any plugin / loader.

## 2. Arguments and lifecycle (PROPOSED)
```
node scripts/e7-connected/probe-cli-main.mjs inspect --plan <path>
node scripts/e7-connected/probe-cli-main.mjs execute --plan <path> --credentials <path> --summary-out <path>
     --expect-plan-hash <64 hex> --expect-source-digest <64 hex> --expect-requests <1..8> --approval-ref <label>
```
- **Arguments:** exactly these flags, each once; paths absolute; no positional extras; anything else → exit `2` `USAGE`. **No secret is ever an argument, env var, chat message, report field or git content.** No subcommand → `inspect`.
- **`inspect` (default):** env preflight (§4) is evaluated and REPORTED; plan file loaded once (§2.1) and validated by accepted P; prints `planHash`, probe ids, maximum request count (= number of probes), metadata labels and the code-identity digest (§2.2). **Zero credential read, zero T / X construction, zero Agent / request** — inspect never even constructs a primitive.
- **`execute` (later, only under the approval package):** strict order; each step refuses with ZERO later steps:
  1. arguments → `USAGE`;
  2. env preflight → `ENV_REFUSED` (no plan, credential or network action yet);
  3. plan file load + P validation → `PLAN_INVALID`;
  4. bindings (enforceable): `planHash === --expect-plan-hash`; `sourceDigest === --expect-source-digest`; `probes.length === --expect-requests`; `metadata.nodeVersion === process.versions.node` exactly; `metadata.stripeVersion === STRIPE_VERSION_CANDIDATE`; `metadata.approvalRef === --approval-ref`; `--summary-out` does not exist and its parent is acceptable (§5) → `BINDING_MISMATCH`;
  5. credential file read (§3), only keys the plan's probes need → `CREDENTIAL_REFUSED`;
  6. construct X (default primitive) → T (credential closures, `accountId` from the plan, `apiVersion = STRIPE_VERSION_CANDIDATE`) → P run with the real deadline deps (§5) → `finalize()`;
  7. write the summary file + one stdout line; exit code (§6).
- **Never:** reply-derived requests, auth fallback (no `jwt` switch), retry, resend, pagination, POST / PUT / DELETE, token mint, any write-capable executor, re-run after uncertainty.
### 2.1 Plan file
Absolute path; `lstat` regular file, not a symlink; ≤ 16 KiB; opened once with `O_RDONLY | O_NOFOLLOW`; read once bounded (> 16 KiB → refuse); fatal UTF-8 decode; `JSON.parse` once; handed to `validateProbePlan` (which snapshots it once). Not secret (no `0600` requirement), but its content is printed only as P's validated, whitelisted fields.
### 2.2 Enforceable checks vs trusted owner assertions
| Enforced by code | Trusted owner assertion (code cannot verify) |
|---|---|
| `planHash` equality with the reviewed value; request count; exact Node version string; fixed Stripe-Version; `approvalRef` string equality; env refusals; credential-file policy; `sourceDigest` = SHA-256 over the exact bytes of P, T, X, C1, C2, C3 files read from disk in a fixed order | that the checked-out tree is the reviewed git commit (no git / child-process use); that Joel approved this exact run (an `approvalRef` string or a CLI switch is **not** consent or authentication; code cannot authenticate a chat approval); account ownership; that ids / listing are the owner's own; machine trust (same-uid processes, root, OS, Node binary integrity) |
- `metadata.reviewedCommit` stays a label; the `sourceDigest` is the enforceable code-identity check the package names. **Neither this design nor later code acceptance permits execution.**

## 3. Credential file ingress (PROPOSED; later CLI scope; POSIX-only)
- **Platform:** `linux` / `darwin` only; `win32` and others → `CREDENTIAL_PLATFORM_UNSUPPORTED` (native Windows unsupported until a reviewed ACL design; Node's `chmod` mode bits are not an ACL equivalent on Windows — never treated as one).
- **Path:** absolute; the canonical parent (`realpath` of the directory) must not equal or lie under the repository root's realpath, and no ancestor (bounded walk ≤ 64 levels) may contain a `.git` entry (`lstat`) → else `CREDENTIAL_IN_REPO`.
- **Identity + policy (path `lstat`, then fd `fstat`, compared):** regular file; not a symlink (`lstat` + `O_NOFOLLOW`); `uid === process uid`; `mode & 0o7777 === 0o600` exactly; `nlink === 1` (hard links refused); `size ≤ 4096`; `dev` / `ino` of `lstat` and `fstat` equal; after the read, `fstat` again: same `dev` / `ino` / `size` / `mtime` → else `CREDENTIAL_CHANGED` (growth / truncation / mutation / swap detected within the read window only).
- **Read:** `O_RDONLY | O_NOFOLLOW`; bounded loop reading at most 4097 bytes total (> 4096 → `CREDENTIAL_TOO_LARGE`); every acquired handle closed exactly once in `finally` (close fault → `CREDENTIAL_IO`, still no retry); no raw error, path, size or content in any output.
- **Parse:** fatal UTF-8; `JSON.parse` once; a plain object with keys EXACTLY those the plan needs (`hostawayToken` iff any P-H probe; `stripeTestKey` iff any P-S probe) → else `CREDENTIAL_SHAPE`; `hostawayToken` printable ASCII 1…4096; `stripeTestKey` `^sk_test_[A-Za-z0-9]+$` (a `sk_live_` / `rk_live_` / `rk_test_` / other prefix → `CREDENTIAL_KEY_NOT_TEST`, value never echoed). T re-checks the key (`http-transports.mjs:346`).
- **Lifetime:** values live only in T's injected `credential()` closures for the run; never written, logged, hashed or returned; references dropped at exit. **No provable memory erasure** (JS strings cannot be wiped). The CLI never deletes, rotates, `chmod`s or rewrites the file; cleanup (delete / rotate) is an owner step named in the package.
- **Trust limits:** the check-then-use window cannot defeat a same-uid or root actor in the owner's namespace; the policy assumes an owner-controlled directory (as F does, `run-journal-file.mjs:10`).
- **CP-H:** the file holds an owner-EXISTING Hostaway access token only. Minting (`POST /v1/accessTokens`) is a separate CLOSED gate, never implied by a GET approval.

## 4. Environment / runtime preflight (PROPOSED)
`evaluateProbeEnvironment(snapshot)`; the snapshot is captured ONLY in C3 at command start: `{ nodeVersion: process.versions.node, platform: process.platform, execArgv: process.execArgv.length, uidAvailable: typeof process.getuid === 'function', present: { <var>: boolean } }` — presence booleans only, **no env value is read into the snapshot except presence**, and nothing is dumped.
| Check | Allow | Refuse code |
|---|---|---|
| Node version | exactly `22.22.0` or `24.22.1` (inspected; owner machine UNKNOWN) | `ENV_NODE_UNSUPPORTED` |
| platform | `linux`, `darwin` | `ENV_PLATFORM_UNSUPPORTED` |
| `process.execArgv` | empty (no `--tls-*`, `--use-*-ca`, `--use-env-proxy`, `--insecure-http-parser`, `--require` / `--import` / `--loader`, inspector, …) | `ENV_EXEC_FLAGS` |
| present env vars | none of `NODE_OPTIONS`, `NODE_TLS_REJECT_UNAUTHORIZED`, `NODE_EXTRA_CA_CERTS`, `NODE_USE_ENV_PROXY`, `NODE_DEBUG`, `NODE_DEBUG_NATIVE`, `SSLKEYLOGFILE`, `OPENSSL_CONF` | `ENV_VARIABLE_REFUSED` |
| proxy vars (`HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`, lower-case) | reported only (X's dedicated Agent never reads them — real-exchange contract §1.1, `_http_agent:116–118` on the inspected Node); connectivity through a required proxy is unsupported | — (`proxyVarsPresent: true` reported) |
| `process.getuid` | available | `ENV_UID_UNAVAILABLE` |
- **No overriding:** a refused setting is reported and the command exits; it never unsets, overrides or "fixes" anything.
- **Same-process trust:** only the listed modules run in the process; global intrinsics are trusted (P / T / X residuals).
- **Native validation remains CLOSED** and separate. It would need to establish, on the owner's exact Node: `ClientRequest` / `IncomingMessage` event order incl. destroy / abort teardown, `rawHeaders` / `complete` semantics, Agent destruction releasing the socket, real TLS verification failure behaviour, and no socket / listener leak — without provider calls. An unknown owner machine is never a reason to weaken a gate or claim Windows support.

## 5. Real timing, AbortSignal and exit (PROPOSED, C3 binds; C2 receives as deps)
- `monotonic = () => performance.now()` (captured at load); `timers.arm(ms)` → `{ promise, cancel }` where `promise` is a native promise resolved by `setTimeout(resolve, ms)` and `cancel = () => clearTimeout(handle)` (never throws; satisfies P's exact handle shape). Plan limits are P's: per probe ≤ 15 s, run ≤ 3 min, tail ≤ 10 s.
- **Ownership:** P owns its per-probe `AbortController`s, observers and timer handles; X owns Agents / requests / sockets and its bounded destroyed-object listener residual; T owns nothing persistent. The CLI owns one run `AbortController` (passed as P's `signal`) and the `SIGINT` handler.
- **SIGINT:** first → abort the run signal (P records `PROBE_CANCELLED`, sends nothing more); the command still awaits `result` and `finalize()` (both bounded by P's timers). Second → immediate `process.exit(130)` after writing a fixed `INTERRUPTED` line if possible; it never resends.
- **Exit policy:** after `finalize()` resolves, the CLI writes output and sets `process.exitCode`. If `tail ∈ { UNSETTLED, UNOBSERVABLE }` or `timerCleanup.cancelFailed + uncancellable > 0`, the output says so and the CLI calls `process.exit(code)` — this abandons in-process work; **it is not a claim that the work was destroyed** (a request may still have been delivered). No forced continuation, resend or re-run on uncertainty.
- **Zero-network guarantee for refusals:** steps 1–5 of §2 construct no T, X, Agent or primitive; a refused environment or plan therefore causes zero credential reads and zero requests (tested with a counting fake primitive and a counting fake credential fs).

## 6. Results, output and exit codes (PROPOSED)
- **stdout:** exactly one JSON line `{ schema:'e7-probe-cli-result-v1', mode:'inspect'|'execute', code, preflight:{ ok, code, checks:{…booleans} }, plan: null | { planHash, probes, maxRequests, metadata }, sourceDigest, summary: null | <P summary>, finalize: null | { tail, timerCleanup } }`; `stderr` unused. All strings ∈ the **whitelist union** (`readonly-probe` contract §12): P `VOCABULARY` ∪ P `T_ERROR_CODES` ∪ the CLI's own fixed code list ∪ `planHash` / `sourceDigest` ∪ the four plan metadata labels ∪ fixed schema keys. No raw body, key, token, guest data, provider text, path, size, env value or error message.
- **Summary file (`--summary-out`, execute only):** the same JSON, ≤ 64 KiB, created with `O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW`, mode `0600`, parent directory owned by the uid and not group / other writable; never overwritten, appended, repaired or auto-re-run; a write / fsync / close fault → exit `9` with the stdout line still emitted.
- **Exit codes:** `0` execute completed, all probes OK, tail `NONE` / `LATE_*`, cleanup 0; `10` inspect OK; `11` execute completed with INCONCLUSIVE probes; `2` USAGE; `3` ENV_REFUSED; `4` PLAN_INVALID / BINDING_MISMATCH; `5` CREDENTIAL_REFUSED; `6` probe run STOPPED; `8` tail / cleanup uncertain (`UNSETTLED`, `UNOBSERVABLE`, cancel counts > 0) — takes precedence over 0 / 6 / 11; `9` output write failed; `130` second SIGINT; `1` internal fault.
- **Metadata comparison:** `nodeVersion` exact string equality with the runtime (refuse on drift); `stripeVersion` equality with the fixed candidate; `reviewedCommit` echoed as a label beside the enforced `sourceDigest`; no silent version drift accepted.
- **Scope of observations:** read-only results never close write auth (H9 `jwt` vs Bearer), write shapes, checkout / webhook version compatibility, booking cleanup, calendar automation, native verification or any launch gate.

## 7. Proposed command-level validation matrix (later slices; fakes and synthetic temp files only)
1. `inspect`: zero credential-fs calls, zero primitive / Agent / request, plan summary whitelisted.
2. Invalid / hostile plan (oversize, symlink, non-UTF-8, invalid P plan, `__proto__`, accessor) and refused env (each §4 row) → exit before any credential read (counting fake fs = 0) or request.
3. Credential file: symlink, hard link (`nlink 2`), wrong uid, mode `0640` / `0400` / `0700`, > 4 KiB, growth / truncation / swap during read (fake fs), inside repo / under a `.git` ancestor, extra / missing keys, `sk_live_` / `rk_live_`, non-JSON, close fault → fixed codes, handles closed exactly once, no path / content / value in output.
4. Parser / raw-error redaction: every fake fs / primitive error message and planted sentinel absent from stdout and summary file.
5. Normal end-to-end: `runProbeCommand` → P → T → X → fake primitive for the default plan; exact wire as the accepted rehearsal; exit 0.
6. SIGINT once / twice, caller abort, deadline (fake timers) → codes, no resend, exit 6 / 130.
7. Dependency / COMMIT-like output uncertainty: a held reply past the deadline, late fulfil / reject, a throwing timer `cancel` → exit 8, no resend, truthful tail.
8. Output faults: existing `--summary-out`, symlinked target, write / close fault → exit 9, no overwrite.
9. Every default network path guarded: real `https.request` / `Agent` replaced by counting guards before X loads; global `fetch` guard; both 0.

## 8. ONE consolidated exact approval package — TEMPLATE (all owner fields UNSET; not an approval)
| Field | Value |
|---|---|
| Scope | READ-ONLY probe run only (GET); separate from any later booking / write / notification / calendar approval |
| Reviewed commit + `sourceDigest` | UNSET (after C1–C3 are accepted) |
| Exact command line (paths only, no secrets) | UNSET |
| Plan file + `planHash` | UNSET |
| Request inventory / maximum count | UNSET (≤ 8; default excludes P-H3; P-H6 only with an exactly approved control) |
| Hostaway listing (USD) / dates / sample + control reservation ids and their listings | UNSET (never a protected id) |
| Stripe TEST account id / existing TEST PaymentIntent id | UNSET |
| Stripe-Version | `2026-08-26.dahlia` proposed — owner confirmation UNSET; no account / webhook setting change |
| Owner environment | UNSET: OS (linux / darwin), exact Node (`22.22.0` / `24.22.1`), preflight output; native validation evidence UNSET (separate CLOSED scope) |
| Credential ingress | UNSET: file path (outside repo), `0600`, CP-H existing token (no mint), Stripe `sk_test_` key; post-run deletion / rotation by the owner |
| Returned evidence | the stdout line + `0600` summary file (schema §6); nothing else retained |
| Stop policy | stop on first non-OK; no retry / fallback / resend; exit-code meaning per §6 |
| Joel's explicit approval of THIS package | UNSET — given outside the plan; plan labels never substitute for it |

**Prerequisites that cannot be established offline:** owner machine + exact Node; native validation; that the token / key belong to the intended accounts; actual provider reply shapes, auth and filter behaviour; network path. Writing this template provisions nothing, installs nothing and calls nothing.

## 9. Recommended next OFFLINE slices (NOT authorized)
- **Slice C1 (4 files):** NEW `scripts/e7-connected/probe-env-preflight.mjs`; NEW `scripts/e7-connected/probe-credential-file.mjs`; NEW `test/e7-connected-probe-ingress.test.mjs` (fake fs adapter + fake snapshots; optionally synthetic temp files in a fresh `0700` temp dir containing only synthetic values); this contract (map). Matrix rows 2–4 (env / credential parts).
- **Slice C2 (3 files):** NEW `scripts/e7-connected/probe-command.mjs` (`runProbeCommand` with ALL deps injected); NEW `test/e7-connected-probe-command.test.mjs` (P→T→X over a fake primitive, fake fs, fake timers, counting guards); this contract (map). Matrix rows 1, 5–9.
- **Slice C3 (entrypoint):** only after C1 / C2 acceptance and a separate decision — CLOSED. No default executable live CLI exists before then.

**Open decisions (genuinely root / owner):** whether C3 should exist before the approval package; the env-var refuse list exactly as above; the exit-code table; `sourceDigest` file set; POSIX credential-file policy acceptance; whether proxy-only connectivity must ever be supported (currently unsupported); Windows (unsupported until an ACL design). **Technical recommendations (not decisions):** inspect as default; injected deps everywhere except C3; whitelist union for every consumer.

## 10. Sources (read-only)
Repository at `b6603cac` as cited in §0. Node.js [File system](https://nodejs.org/api/fs.html) (`fs.constants` open flags incl. `O_NOFOLLOW`, `fs.Stats` fields `dev` / `ino` / `mode` / `nlink` / `uid` / `size`, file modes) — the page's long sections on open-flag platform availability and Windows file modes were not fully re-read in this session; the policy treats POSIX as the only supported platform regardless. Provider facts as recorded in `claude/e7-connected-transport-contract.md` §5 and `claude/e7-connected-readonly-probe-contract.md` §3.
