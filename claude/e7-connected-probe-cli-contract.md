# E7 connected-test runner — OWNER-RUN READ-ONLY PROBE CLI / PREFLIGHT / CREDENTIAL-INGRESS CONTRACT, revision 3: C1 ACCEPTED (§10) + C2 executable contract (§11, PROPOSED)

> **Revision 3 (DOCS ONLY; branch `feature/e7-connected-probe-command-contract` from exact `ac974d75`):** C1 ACCEPTED OFFLINE by root at `ac974d75` (R-C1A closed). §11 is the C2 executable contract, finishing the §4 deferred interface and superseding §§3–4 where they differ. **C2 is NOT implemented and NOT authorized; C3 and any real request remain CLOSED.** The note below and §§0–10 are kept verbatim as history.


> **C1 implementation (branch `feature/e7-connected-probe-ingress`, cut from exact `34903dec`):** stage C1 ONLY, OFFLINE, fake-only tests — `scripts/e7-connected/probe-env-preflight.mjs`, `scripts/e7-connected/probe-credential-file.mjs`, `test/e7-connected-probe-ingress.test.mjs`, and §10 of this file. **C2 and C3 are DEFERRED — not implemented, not authorized**; C2 needs a refreshed executable contract after C1 before any implementation; C3 stays CLOSED. §§0–9 below are kept verbatim as the revision 2 history (their "PROPOSED / not implemented" wording describes revision 2 at `34903dec`); §10 records what C1 implements, every binding clarification A–E, deviations and residuals.


**Branch** `feature/e7-connected-probe-cli-contract`; revision 1 `984b8159` (cut from exact `b6603cac`); revision 2 = fast-forward from exact `984b8159` resolving root DESIGN HOLD R-CLI1 / R-CLI2 / R-CLI3 and root's technical rulings (map: §9). Files: this contract; the pointer in `claude/e7-connected-probe-stack-rehearsal.md`; the §12 whitelist union + pointer in `claude/e7-connected-readonly-probe-contract.md`. No code, test, runtime, SQL, config, dependency, pin, worker, core, A, F, T, X or P change. **Nothing was executed:** no request, credential / env / owner / account access, key / token creation, install, native / loopback / TLS / DNS / socket experiment or permission change. Public primary docs and repository source read-only.

**Scope.** The smallest owner-run, read-only command around the accepted P / T / X, so ONE later consolidated exact approval package from Joel can name concrete things. Not a hosted service, booking CLI, write path or token mint; the booking runner and A stay synthetic-only and are never imported or relaxed. **C3 (the executable entrypoint) stays CLOSED.** Owner inputs UNSET; live gates G-AUTH / G-FILTER / G-SHAPE / B4–B6, owner environment, credentials and the approval package CLOSED; protected reservations 70636076 / 71045356 / 71072615 / 71081885 zero-action; e74a OPEN (FIRST FULL TAP / STOP if ever reproduced). No readiness claim.

**Citation convention.** `file:line` at `b6603cac` (identical at `984b8159`, docs-only).

## 0. Present (ACCEPTED, offline) vs PROPOSED
| Piece | State | Source |
|---|---|---|
| P `validateProbePlan`, `runReadonlyProbes`, `VOCABULARY`, `T_ERROR_CODES`, `TIMER_CLEANUP_KEYS`, `NODE_VERSION_LABELS`, `STRIPE_VERSION_CANDIDATE` | ACCEPTED `27c0ea11` | `scripts/e7-connected/readonly-probe.mjs:18–19, 23, 43, 45, 138, 366` |
| T Hostaway / Stripe sends | ACCEPTED `0830f9a4` | `scripts/e7-connected/http-transports.mjs:307, 353` |
| X real exchange, default `node:https` primitive | ACCEPTED `af1b4db0` (fake-primitive tests only) | `scripts/e7-connected/real-exchange.mjs:28, 186` |
| P → T → X composition | ACCEPTED rehearsal `b6603cac` | `test/e7-connected-probe-stack-rehearsal.test.mjs` |
| fs identity prior art (NOT imported, NOT reused as-is): F's adapter exposes `{ dev, ino, kind, mode, nlink, size, uid }` (no timestamps) and only the open kinds `journal-create` / `journal-open` / `lock-create` / `lock-read` | ACCEPTED F | `scripts/e7-connected/run-journal-file.mjs:52–67, 78, 86–104` |
| C1 env preflight + credential loader, C2 command core, C3 entrypoint | **PROPOSED** | — |

## 1. Stages and boundaries
| Stage | Files | State in this design |
|---|---|---|
| **C1** | NEW `scripts/e7-connected/probe-env-preflight.mjs`, NEW `scripts/e7-connected/probe-credential-file.mjs` | exact contract (§2); next proposed slice |
| **C2** | NEW `scripts/e7-connected/probe-command.mjs` | deferred contract (§4); not proposed for implementation until C1 is accepted |
| **C3** | NEW `scripts/e7-connected/probe-cli-main.mjs` | CLOSED contract outline (§5); no executable live CLI |
- C1 needs no C2 / C3 file to exist and implements no source digest. C1 modules read no `process`, env, real fs, clock or network; every dependency is injected.
- Never imported by C1–C3: A, F, core, workers, journals, DB, adapters, SDKs, `lib/hostaway.js`, any plugin / loader; no git or child process.

## 2. C1 — exact contract (PROPOSED)
### 2.1 `probe-env-preflight.mjs`
Imports: `node:util` (`types`) only. Export `evaluateProbeEnvironment(snapshot) → frozen { ok, code, checks }`; never throws; never reads `process`.
- **Snapshot (exact; produced later by C3 only):** a plain object with own DATA properties exactly
  `{ schema:'e7-probe-env-snapshot-v1', nodeVersion, platform, execArgvCount, uidAvailable, present }` where `nodeVersion` string ≤ 32, `platform` string ≤ 16, `execArgvCount` safe int 0…1024 (a COUNT, not the array — C3 never passes flag values), `uidAvailable` boolean, and `present` a plain object with own DATA boolean properties exactly:
  `NODE_OPTIONS, NODE_TLS_REJECT_UNAUTHORIZED, NODE_EXTRA_CA_CERTS, NODE_USE_ENV_PROXY, NODE_DEBUG, NODE_DEBUG_NATIVE, SSLKEYLOGFILE, OPENSSL_CONF, HTTPS_PROXY, HTTP_PROXY, NO_PROXY, https_proxy, http_proxy, no_proxy`.
  Any missing / extra / non-data / wrong-type key, proxy, accessor, symbol key, non-plain prototype → `ENV_SNAPSHOT_INVALID` (descriptor-only reads; no getter, `toJSON` or iterator runs).
- **Evaluation precedence (first match wins):** `ENV_SNAPSHOT_INVALID` → `ENV_NODE_UNSUPPORTED` (not exactly `22.22.0` / `24.22.1`) → `ENV_PLATFORM_UNSUPPORTED` (not `linux` / `darwin`) → `ENV_EXEC_FLAGS` (`execArgvCount > 0`) → `ENV_VARIABLE_REFUSED` (any of the first eight `present` keys true) → `ENV_UID_UNAVAILABLE` → `ENV_OK`. This refusal list is a conservative PROPOSAL; no setting is read or changed now.
- **Output (exact keys):** `{ ok:boolean, code, checks:{ nodeVersionSupported, platformSupported, execArgvEmpty, refusedVariablesAbsent, uidAvailable, proxyVariablesPresent } }` (booleans; all `false` on `ENV_SNAPSHOT_INVALID`). Proxy variables are report-only: X's dedicated Agent never reads them; connectivity that REQUIRES a proxy is unsupported (no proxy fallback).
### 2.2 `probe-credential-file.mjs`
Imports: `node:util` (`types`) only. Export `readProbeCredentialFile({ path, repoRoot, needs, fs }) → native Promise<frozen result>`; never rejects.
- **Inputs (own-data, exact keys):** `path`, `repoRoot` absolute strings ≤ 4096 without NUL, lexically normalized (no empty, `.` or `..` segment, no trailing `/`); `needs` exactly `{ hostaway:boolean, stripe:boolean }` with at least one `true`; `fs` the adapter below. Violation → `CRED_INPUT_INVALID`.
- **NEW injected read-only adapter (not F's; F unchanged):** plain object with own DATA properties exactly `{ platform:string, uid:safe int ≥ 0, lstat:function, realpath:function, open:function }` (non-proxy functions) → else `CRED_ADAPTER_INVALID`.
  - `lstat(path)` / handle `stat()` → native unpatched promise of a **stat record**: plain object, own data exactly `{ dev:string, ino:string, kind:'file'|'dir'|'symlink'|'other', mode:safe int, nlink:safe int, size:safe int, uid:safe int, mtimeNs:string, ctimeNs:string }` (`dev` / `ino` / `*Ns` decimal strings ≤ 40 digits from bigint stats — nanosecond precision, compared as exact strings). A rejection whose own-data `code` is `'ENOENT'` or `'ENOTDIR'` means ABSENT; any other rejection (incl. `EACCES`, `ELOOP`, unknown or getter-bearing objects) is `CRED_IO` — never "absent".
  - `realpath(path)` → native promise of an absolute string ≤ 4096; rejection → `CRED_IO`.
  - `open(path, 'credential-read')` → native promise of a **handle**: plain object, own data exactly `{ stat:function, read:function, close:function }`. The single reviewed kind `'credential-read'` = `O_RDONLY | O_NOFOLLOW` (a later real adapter refuses to construct if `O_NOFOLLOW` is unavailable — no weakened no-follow).
  - `read(buffer, offset, length)` → native promise of a safe int `0 … length`; `buffer` is the module-owned `Uint8Array`. `close()` → native promise of `undefined`.
  - Every adapter promise must be an unpatched native promise (B / T / P rule) and is observed through the captured intrinsic `then`; a non-promise / thenable / patched promise → `CRED_ADAPTER_INVALID`.
- **Algorithm (order fixed; first refusal wins):**
  1. `platform ∈ { linux, darwin }` else `CRED_PLATFORM_UNSUPPORTED` (native Windows unsupported until an ACL review; `chmod` bits are not an ACL equivalent).
  2. `parent = dirname(path)`; `realpath(parent) === parent` else `CRED_PATH_NOT_CANONICAL` (symlinked ancestors refused); `rr = realpath(repoRoot)`; `parent === rr` or under `rr + '/'` → `CRED_IN_REPO`.
  3. `.git` ancestor walk: for `parent` and each ancestor up to `/` (≤ 64 directories; deeper → `CRED_PATH_INVALID`): `lstat(dir + '/.git')` ABSENT → continue; success (any kind) → `CRED_IN_GIT_TREE`; other failure → `CRED_IO`.
  4. `pre = lstat(path)`: ABSENT → `CRED_MISSING`; failure → `CRED_IO`; then **policy(pre)**: `kind === 'file'` (`CRED_NOT_REGULAR`, incl. symlink), `uid === fs.uid` (`CRED_OWNER`), `(mode & 0o7777) === 0o600` (`CRED_MODE`), `nlink === 1` (`CRED_LINKS`), `1 ≤ size ≤ 4096` (`CRED_SIZE`).
  5. `open(path, 'credential-read')`: rejection → `CRED_IO`. **Close capture first:** if the resolved value is an object whose own DATA `close` is a non-proxy function, it is captured immediately; then the handle shape is validated; an invalid shape → its captured `close` is invoked once, `CRED_ADAPTER_INVALID`. A handle without a safely callable `close` → `CRED_ADAPTER_INVALID` with `closeState:'UNCLOSABLE'` (precise residual).
  6. `s1 = handle.stat()` → policy(s1) AND every field of `s1` equal to `pre` (`dev, ino, kind, mode, nlink, size, uid, mtimeNs, ctimeNs`) → else `CRED_CHANGED`.
  7. **Bounded read:** module-owned `buf = new Uint8Array(4097)`; `offset = 0`; at most 4098 `read` calls; each `n` must be a safe int `0 … 4097 − offset` (else `CRED_IO`); `n === 0` = EOF; stop at EOF or `offset === 4097`. `offset === 4097` (the one-byte growth probe) → `CRED_SIZE`; EOF with `offset !== s1.size` (early zero / truncation) → `CRED_CHANGED`; iteration limit reached without EOF → `CRED_IO`.
  8. `s2 = handle.stat()` → policy(s2) AND all nine fields equal to `s1` → else `CRED_CHANGED`.
  9. `post = lstat(path)` → policy(post) AND all nine fields equal to `s2` → else `CRED_CHANGED` (detects a renamed / replaced PATH, which an fd `fstat` alone cannot see).
  10. **Close exactly once** (in every path after a handle was acquired, in a `finally`): a close rejection → `closeState:'CLOSE_FAILED'`. Precedence: an earlier refusal code stays primary (with `closeState` reported); otherwise `CRED_CLOSE_FAILED`. **A close failure always withholds success and every secret.** No retry.
  11. Parse: fatal UTF-8 decode of `buf[0, offset)`; byte-level structure scan (depth ≤ 2: one object of string values) then `JSON.parse` once; a plain object with keys EXACTLY `{ hostawayToken }` / `{ stripeTestKey }` / both per `needs` (`CRED_SHAPE`); `hostawayToken` printable ASCII 1…4096 (`CRED_SHAPE`); `stripeTestKey` `^sk_test_[A-Za-z0-9]{1,247}$` — any other value, incl. `sk_live_` / `rk_live_` / `rk_test_` prefixes → `CRED_KEY_NOT_TEST` (never echoed); invalid UTF-8 / JSON / depth → `CRED_PARSE`. `buf` is zero-filled after parsing (best effort for the module's bytes only; JS strings cannot be provably erased).
- **Result:**
  - PUBLIC (safe to log): `{ ok:false, code, closeState:'CLOSED'|'CLOSE_FAILED'|'UNCLOSABLE'|'NOT_OPENED' }`.
  - PRIVATE capability (success only): `{ ok:true, closeState:'CLOSED', credentials }` where `credentials` is a frozen object whose token / key are own **non-enumerable** data properties (so an accidental `JSON.stringify` yields `{}`; defense in depth only). It is a capability between the loader and C2, **never serialized, logged, returned by C2 or written anywhere**; C2 places the values into T's `credential()` closures and drops the reference.
- **Code vocabulary (complete):** `CRED_OK, CRED_INPUT_INVALID, CRED_ADAPTER_INVALID, CRED_PLATFORM_UNSUPPORTED, CRED_PATH_INVALID, CRED_PATH_NOT_CANONICAL, CRED_IN_REPO, CRED_IN_GIT_TREE, CRED_MISSING, CRED_NOT_REGULAR, CRED_OWNER, CRED_MODE, CRED_LINKS, CRED_SIZE, CRED_CHANGED, CRED_IO, CRED_CLOSE_FAILED, CRED_PARSE, CRED_SHAPE, CRED_KEY_NOT_TEST`. No path, size, uid, error message or content ever appears in a result.
- **Bounds (stated precisely):** finite OPERATION bounds — ≤ 2 `realpath`, ≤ 64 ancestor `lstat` + 2 path `lstat`, 1 `open`, 2 handle `stat`, ≤ 4098 `read`, 1 `close`; ≤ 4097 owned bytes. **No elapsed-time bound:** C1 owns no timer; a hanging injected (or real) fs keeps the promise pending, and real file IO cannot be synchronously preempted. **Trust:** the owner's directory namespace is assumed owner-controlled; the checks detect changes within their window but do not defeat a same-uid or root actor (not a hostile-local-process sandbox).
### 2.3 C1 smallest slice — tests and exit criteria
Files (4): the two modules above; NEW `test/e7-connected-probe-ingress.test.mjs`; this contract (implementation map). Tests use **fake snapshots and fake fs adapters only**; no real fs by default (synthetic temp files only through a deliberately test-local adapter, optional).
1. Env: valid controls for both Node labels / both platforms; each precedence row; every malformed snapshot shape (missing / extra / wrong type / proxy / accessor / `execArgv` array instead of count); proxy-only report; output keys exact.
2. Credential policy: each `CRED_*` code from steps 1–11 incl. symlinked parent, repo / `.git` ancestor (ABSENT vs `EACCES` → `CRED_IO`, never "absent"), symlink, hard link, wrong uid, `0640` / `0400` / `0700`, size 0 / 4097, swap between `lstat` and `fstat`, mtime / ctime change, growth (one-byte probe), early zero / truncation, path replaced after read (post `lstat`), invalid `n` (negative / > length / non-int), iteration limit.
3. Handle ownership: close captured before shape validation; invalid handle with callable close → closed once; unclosable handle residual; close rejection withholds success; refusal + close failure precedence; close exactly once on every path; no retry.
4. Parse / redaction: invalid UTF-8, non-JSON, depth 3, extra / missing keys per `needs`, live / restricted keys; sentinels (path, token-looking strings, error messages) never in any public result; success capability non-enumerable (`JSON.stringify` → `{}`).
5. Hostile adapter: proxy / accessor / thenable / patched promise → `CRED_ADAPTER_INVALID`, no getter run; hanging fake fs leaves the promise pending (documented, not "bounded").
6. Source pins: imports exactly `node:util`; no `process`, `node:fs`, timers, network, `console`, F / P / T / X import.
**Exit criteria:** focused suite green with FIRST FULL TAP preserved and real first-run failures reported; foundation / P / T / X / F / pins units and `npm test` green; no change outside the four files; root CODE review.

## 3. Source identity (R-CLI2) — exact recipe (C2 computes, C3 enforces; not C1)
> *Revision 3: superseded where different by §11.4 (pure helper + caller snapshot; C3 computes / enforces before import; C2 re-compares only).*
- **Closure (explicit, reviewed, static):** the CLI's own files `scripts/e7-connected/probe-cli-main.mjs`, `probe-command.mjs`, `probe-env-preflight.mjs`, `probe-credential-file.mjs`, plus the complete static local import closure of P / T / X at `b6603cac`: `scripts/e7-connected/readonly-probe.mjs`, `scripts/e7-connected/http-transports.mjs`, `scripts/e7-connected/real-exchange.mjs`, `lib/checkout/compensation-proof.js` (imports `./recovery-plan.js`, `./capture-proof.js`, `./intent-state.js`, `compensation-proof.js:15–17`; defines the protected ids, `:23`), `lib/checkout/recovery-plan.js`, `lib/checkout/capture-proof.js`, `lib/checkout/intent-state.js`; and the module-resolution input `package.json` (`"type": "module"` decides how the `.js` files load; no `imports` / `exports` maps). Verified now (read-only): these files contain no `require`, `createRequire`, dynamic `import()`, `import.meta` or `process` use; their only non-local imports are `node:crypto`, `node:util`, `node:https`. Any change of the closure (a new import) must change this list in a reviewed revision; there is no dynamic module walk or discovery.
- **Recipe:** `sourceDigest = SHA-256( "e7-probe-source-v1\n" ‖ for each path in the fixed list order: utf8(path) ‖ 0x00 ‖ decimal(byteLength) ‖ 0x00 ‖ bytes ‖ 0x00 )`; files read with the same no-follow regular-file rules (≤ 256 KiB each); any missing / extra / unreadable file → `SOURCE_UNREADABLE`.
- **Order vs loading:** C3 statically imports only Node built-ins, computes the digest from disk, compares it with `--expect-source-digest`, and only then dynamically imports C2 (which imports P / T / X / C1) by fixed relative path. **Limits:** the disk digest does not prove the bytes already loaded if files change between hashing and import (same-uid mutation not defeated); the Node binary, global intrinsics and OS remain TRUST. `metadata.reviewedCommit` stays a label; `approvalRef` / hashes / switches are never permission.
- **Test (in C2):** with a fake reader, changing one byte of `compensation-proof.js` (protected constants) or of `package.json` changes the digest; reordering or adding a file changes it; path / length framing prevents concatenation ambiguity.

## 4. C2 — deferred contract (`probe-command.mjs`; PROPOSED, not yet authorized)
> *Revision 3: superseded where different by §11 (exact schemas, stage order, payload vs disposition, vocabulary).*
`runProbeCommand({ argv, deps }) → native Promise<frozen disposition>`; C2 performs no `process.exit`, owns no real signal, timer or fs, and never writes stdout itself. `deps` (all injected): `readPlanFile`, `envSnapshot`, `credentialFs`, `outputFs`, `repoRoot`, `sourceDigest`, `primitive`, `monotonic`, `timers`, `interrupt` (a genuine `AbortSignal` C3 aborts on the first SIGINT).
- **Grammar:** `inspect --plan <abs>` (default) or `execute --plan <abs> --credentials <abs> --summary-out <abs> --expect-plan-hash <64hex> --expect-source-digest <64hex> --expect-requests <1..8> --approval-ref <label>`; **`--summary-out` is MANDATORY for execute**; every flag once; anything else → `CLI_USAGE`.
- **Stage order (each refusal ⇒ zero later stages; `interrupt` checked natively before every stage and after every await):**
  1. args; 2. env preflight (C1); 3. source digest equality (`CLI_SOURCE_MISMATCH`); 4. plan file (≤ 16 KiB, no-follow regular file, read once) + P validation; 5. bindings: `planHash`, request count = `probes.length`, `metadata.nodeVersion === snapshot.nodeVersion`, `metadata.stripeVersion === STRIPE_VERSION_CANDIDATE`, `metadata.approvalRef === --approval-ref` (`CLI_BINDING_MISMATCH`); 6. **output-parent preflight** (before any secret): canonical parent (`realpath === dirname`), a directory owned by the uid, `(mode & 0o022) === 0`, outside the repo / `.git` tree, target ABSENT (exists → `CLI_OUTPUT_EXISTS`, pre-run refusal, exit 4); 7. credential load (C1; a refusal → `CLI_CREDENTIAL_REFUSED`); 8. construct X → T → P and run; `finalize()`; 9. summary file; 10. disposition.
  - `inspect` runs only 1, 2 (reported, not refused), 3 (reported), 4 and 5 (hash / count / version comparisons reported) — zero credential read, zero T / X / primitive construction.
- **Interrupt (first SIGINT):** before stage 7 → `CLI_INTERRUPTED`, no later stage; during stage 7 → the loader still closes its handle (C1 always closes), the result is discarded, no network; during stage 8 → `interrupt` is P's caller `signal` (P records `PROBE_CANCELLED`); C2 still awaits `result` / `finalize` (bounded by P's timers) and proceeds to stage 9. No repeat, resend or IO retry.
- **Accepted P semantics preserved (no new runner policy):** a STOP ends the run (later probes `AFTER_STOP`); an INCONCLUSIVE probe does NOT end it — independent probes continue and dependent probes are `PREREQ_INCONCLUSIVE`. Disposition `CLI_COMPLETED_OK` only when every probe is OK; `CLI_COMPLETED_INCONCLUSIVE` (exit 11) = completed with ≥ 1 INCONCLUSIVE, **not a general success**; `CLI_PROBE_STOPPED` when P stopped.
- **Single-output ownership state machine:** `summaryFile: NOT_ATTEMPTED → (O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW, 0600) → WRITTEN → FSYNCED → CLOSED_ACK` | `RACE_EXISTS` (O_EXCL `EEXIST`: nothing written by this process) | `UNKNOWN` (any failure after a successful open: partial or landed-but-unacknowledged content is possible — never "nothing written"). Never overwrite, append, repair, unlink or retry. Then `stdout: NOT_ATTEMPTED → ONE write → ACK | UNKNOWN`; C2 returns the line; C3 performs the single write and never attempts a second one.
- **Disposition (returned to C3):** `{ exitCode, primaryOutcome, tailUncertain:boolean, summaryFile, stdoutLine }` — `primaryOutcome` is the true operational result, kept separate from output faults.
- **Exit codes and precedence:** `130` second SIGINT (C3 only; output UNKNOWN) > `9` output not acknowledged (`summaryFile ∈ { RACE_EXISTS, UNKNOWN }` or stdout UNKNOWN) > `8` tail / cleanup uncertain (`UNSETTLED`, `UNOBSERVABLE`, `cancelFailed + uncancellable > 0`) > `6` P stopped > `11` completed inconclusive > `0` completed OK; pre-run refusals `2` usage, `3` env, `4` source / plan / binding / output-exists, `5` credential, `7` interrupted before the run; `10` inspect OK; `1` internal. The stdout line (when acknowledged) always carries `primaryOutcome` and `tailUncertain` even when the exit code reflects a higher-precedence output fault.
- **CLI code vocabulary (complete):** `CLI_INSPECT_OK, CLI_USAGE, CLI_ENV_REFUSED, CLI_SOURCE_MISMATCH, CLI_SOURCE_UNREADABLE, CLI_PLAN_INVALID, CLI_BINDING_MISMATCH, CLI_OUTPUT_PARENT_INVALID, CLI_OUTPUT_EXISTS, CLI_CREDENTIAL_REFUSED, CLI_INTERRUPTED, CLI_COMPLETED_OK, CLI_COMPLETED_INCONCLUSIVE, CLI_PROBE_STOPPED, CLI_TAIL_UNCERTAIN, CLI_OUTPUT_UNKNOWN, CLI_OUTPUT_RACE, CLI_INTERNAL`.
- **Output schema (stdout line = summary file content):** `{ schema:'e7-probe-cli-result-v1', mode, primaryOutcome, exitCode, tailUncertain, preflight:<C1 output>, credential: null | { code, closeState }, plan: null | { planHash, probes, maxRequests, metadata }, sourceDigest, summary: null | <P summary>, finalize: null | { tail, timerCleanup } }` — ≤ 64 KiB; every string in the whitelist union (`readonly-probe` contract §12) ∪ CLI / CRED / ENV codes ∪ `sourceDigest`. No raw body, key, token, guest data, provider text, path, size, env value or error message.
- **Hanging IO:** P's request / run / tail budgets bound only P; a hanging plan / credential / output file operation is NOT bounded by them (stated, not hidden).
- **C2 tests (later):** command matrix of revision 1 §7 adjusted to these rules: inspect zero secrets / network; refusals before any credential read; interrupt at each stage boundary; P semantics (STOP vs INCONCLUSIVE continuation); output state machine incl. `RACE_EXISTS` vs `UNKNOWN`; precedence combinations (9 + 8, 6 + 8, 11 + 9); digest changes for a protected-constant dependency; full P → T → X over a fake primitive with counting guards.

## 5. C3 — CLOSED outline (`probe-cli-main.mjs`)
Owns every process action: builds the env snapshot (presence booleans + `execArgv.length` only), the real read-only fs adapters (refusing to construct without `O_NOFOLLOW`), `performance.now`, `setTimeout` / `clearTimeout` timer handles in P's exact shape, X's default primitive, the SIGINT handler (first → abort `interrupt`; second → `process.exit(130)` immediately with NO further write attempt — any pending stdout / file output is UNKNOWN, never promised flushed), the single stdout write and `process.exitCode`. After the disposition, if `tailUncertain`, C3 exits explicitly — abandoning in-process work, not claiming it destroyed (a request may still have been delivered). **C3 is not proposed for implementation; no default executable live CLI exists.**

## 6. ONE consolidated exact approval package — TEMPLATE (all owner fields UNSET; not an approval)
| Field | Value |
|---|---|
| Scope | READ-ONLY probe run only; separate from any later booking / write / notification / calendar approval |
| Reviewed commit + `sourceDigest` (§3 recipe, full closure) | UNSET |
| Exact command line (paths only) incl. mandatory `--summary-out` | UNSET |
| Plan file + `planHash` | UNSET |
| Request inventory / maximum count | UNSET (≤ 8; P-H3 excluded by default; P-H6 only with an exactly approved control) |
| Listing (USD) / dates / sample + control reservations with listings | UNSET (never a protected id) |
| Stripe TEST account / existing TEST PaymentIntent | UNSET |
| Stripe-Version | `2026-08-26.dahlia` proposed; owner confirmation UNSET; no account / webhook setting change |
| Owner environment | UNSET (linux / darwin; Node exactly `22.22.0` / `24.22.1`; C1 preflight output); native validation evidence UNSET (separate CLOSED scope) |
| Credential ingress | UNSET (POSIX file per §2.2; CP-H existing token, no mint; `sk_test_` key; owner deletes / rotates afterwards) |
| Returned evidence | the stdout line + the `0600` summary file (§4 schema) |
| Stop policy | accepted P semantics: a STOP ends the run; INCONCLUSIVE probes do not, dependents are skipped; no retry / fallback / resend; exit codes per §4 |
| Joel's explicit approval of THIS package | UNSET — given outside the plan; labels never substitute |

**Not establishable offline:** owner machine / exact Node, native validation, credential-to-account correspondence, real provider shapes / auth / filter behaviour, network path. Writing this template provisions, installs or calls nothing.

## 7. Recommended next slice
**C1 only** (§2.3, 4 files). C2 after C1 acceptance; C3 CLOSED. **Open decisions (genuinely root / owner):** acceptance of the conservative env refusal list; the exit-code precedence; whether C3 should ever exist before the approval package. **Technical rulings applied (root):** inspect default; POSIX linux / darwin only; no proxy fallback; mandatory `--summary-out`; C1 tests fake-only by default.

## 8. Sources (read-only)
Repository at `b6603cac` as cited (closure verified by a static import scan of the listed files). Node.js [File system](https://nodejs.org/api/fs.html) (open flags incl. `O_NOFOLLOW`, `fs.Stats` / bigint stats fields, file modes; long platform sections not fully re-read this session — POSIX-only policy regardless).

## 9. Root DESIGN HOLD on `984b8159` — resolution map (revision 2)
| Item | Resolution | Where |
|---|---|---|
| R-CLI1 C1 interfaces / mechanics | exact env snapshot (count not array; all 14 presence keys incl. proxy names; strict types; invalid → `ENV_SNAPSHOT_INVALID`) and output schema; NEW read-only adapter (not F) with exact stat record incl. `mtimeNs` / `ctimeNs` strings, single reviewed open kind `credential-read` (no weakened no-follow), ABSENT only for `ENOENT` / `ENOTDIR`, native-promise rule; full policy re-validated at `fstat` before and after the read AND a post-read path `lstat`; canonical parent / symlinked ancestors / `.git` walk / repo rules; exact bounded-read rules (≤ 4097 bytes, ≤ 4098 calls, invalid `n`, early zero, growth probe), UTF-8 / depth / JSON; close captured first, exactly once, close failure withholds success with precedence; PRIVATE non-enumerable capability vs PUBLIC code-only result; operation vs elapsed-time bounds; complete code vocabulary; C1 tests / exit criteria | §2 |
| R-CLI2 source identity | explicit full static closure (CLI files + P / T / X + `compensation-proof.js` + `recovery-plan.js` + `capture-proof.js` + `intent-state.js` + `package.json`), path / length framed SHA-256 recipe, digest-before-dynamic-import order, TOCTOU / binary / intrinsic TRUST limits, protected-constant digest test in C2; C1 implements no digest | §3 |
| R-CLI3 lifecycle / output / stop | C2 returns a disposition (no `process.exit` / signals); stage order with interrupt checks and output-parent preflight before any secret; mandatory `--summary-out`; `CLI_OUTPUT_EXISTS` (pre-run, exit 4) vs `RACE_EXISTS` / `UNKNOWN` (exit 9); single-output state machine, no second stdout attempt; second SIGINT promises nothing flushed; precedence 130 > 9 > 8 > 6 > 11 > 0 with `primaryOutcome` kept separately; accepted P STOP / INCONCLUSIVE semantics preserved and the approval template corrected; exit 11 not success; complete CLI vocabulary / schema; hanging IO not bounded by P budgets | §4, §5, §6 |

## 10. C1 implementation / clarification / deviation / validation map (branch `feature/e7-connected-probe-ingress` from exact `34903dec`)
**Scope held.** Exactly four files changed: NEW `scripts/e7-connected/probe-env-preflight.mjs`, NEW `scripts/e7-connected/probe-credential-file.mjs`, NEW `test/e7-connected-probe-ingress.test.mjs`, this contract. Both modules import ONLY `import { types } from "node:util";`. There is no default fs adapter, no `process` / env read, and no C2 / C3, digest, plan or summary writer. Nothing changed in P / T / X / F / A / core / worker / DB / config / deps / routes / pins / fixtures. Node / API / version labels are unchanged, and `sourceDigest` is not implemented: it is a C2 / C3 concern and is DEFERRED. `metadata.reviewedCommit`, approval refs / hashes / switches and every live gate are untouched and CLOSED.

**What C1 output means.** `evaluateProbeEnvironment` evaluates the snapshot it is SUPPLIED. It does not attest that the running process has those properties; only the CLOSED C3 would ever build a snapshot. `readProbeCredentialFile` evaluates whatever the injected adapter reports, so it is only as truthful as that adapter (TRUST). All tests use fake versions, OS, uid, booleans, stats, handles and bodies.

### 10.1 Binding clarification A — inputs, intrinsics, promises
| Clarification | Implementation |
|---|---|
| Snapshot own enumerable DATA once, getter-free | `dataExactly(o, keys)` in both modules: `isProxy` first (this covers revoked proxies; `types.isProxy` never traps), plain / null prototype only, no arrays, `getOwnPropertyDescriptors` + `Reflect.ownKeys`, exact string-key set, `value in` descriptor, `enumerable === true` → null-prototype copy. All nested levels go through it: env `present`; cred `needs`, `fs`, the handle and every stat record. |
| Null-prototype controls preserved | Null-prototype snapshots, `present`, input and `needs` are accepted. Tests ENV1 and C2 cover them. |
| Functions captured once | Adapter functions come from the one `fs` snapshot, and `read` / `stat` from the one handle snapshot. They are invoked with `Reflect.apply(fn, undefined, args)`; the module never re-reads a caller property. |
| Initial introspection throws → fixed code | `dataExactly` wraps all introspection in `try` → `null` → `ENV_SNAPSHOT_INVALID` / `CRED_INPUT_INVALID` / `CRED_ADAPTER_INVALID`. The outer `readProbeCredentialFile` also maps a synchronous throw to `CRED_INPUT_INVALID` and an (unreachable) inner rejection to `CRED_IO`, so it never rejects. Test C15 passes a revoked proxy as the whole input. |
| Results deep-frozen; credentials private | The env result and its `checks` are frozen. Credential failures are frozen `{ ok, code, closeState }` objects whose values are all primitives. On success the outer object and the null-prototype `credentials` are frozen, and the token / key are own NON-enumerable data properties. |
| Intrinsics captured at load | `Promise`, `Promise.prototype`, `Promise.prototype.then`, the constructor / `Symbol.species` descriptors, `Uint8Array`, `%TypedArray%.prototype.fill` / `.subarray`, one fatal `TextDecoder` + `TextDecoder.prototype.decode`, `Reflect.apply` / `ownKeys`, the descriptor functions, `Object.freeze` and the well-known-symbol set. **EventTarget is not applicable:** C1 has no abort signal, timer or listener. Other built-ins used at call time (`Number.isSafeInteger`, `Array.prototype.includes` / `every`, `RegExp.prototype.test`, `String.prototype.*`, `Map`) are not re-captured and are TRUST, like the Node binary. |
| No assimilation of thenables or patched promises | `isNativePromise` applies the accepted B/T/P rule: `types.isPromise`, exact `Promise.prototype`, own keys only unregistered non-well-known symbol DATA props (async_hooks), and intact constructor / species. The value is observed only through the captured `then`. Anything else → `CRED_ADAPTER_INVALID` and is never awaited. Test C4 asserts that a thenable's / own `then` is called 0 times. Test C15 covers subclasses, own `then`, registered symbols and well-known symbols. |
| Native rejections observed, incl. losers | The loader issues adapter operations strictly SEQUENTIALLY, so there are no racing "losers": every accepted native promise gets both handlers before the next step. The suite asserts 0 `unhandledRejection`. |
| Invalid-promise rejection ownership | **Residual (explicit):** a non-native / patched / thenable return value is never observed. If it rejects, that rejection is caller-owned (possibly unhandled), and the module runs no caller getter or `then` to "handle" it. |
| Hanging / blocking fs | There is no timer, retry or fallback. A never-settling injected promise leaves the loader pending, and a synchronously blocking fs blocks; elapsed-time guarantees exclude both. Test C17 covers a pending realpath / read / close and checks that close is not issued during a pending read. |

### 10.2 Binding clarification B — adapter, stats, paths, policy
| Clarification | Implementation |
|---|---|
| Adapter exactly §2.2, no F | `{ platform, uid, lstat, realpath, open }`, own-data, non-proxy functions, `uid` safe int 0…2³²−1. F is not imported (pin test) and not changed. |
| Strict stat schema before any comparison | `statRecord`: exactly the nine `STAT_KEYS`. `dev` / `ino` / `mtimeNs` / `ctimeNs` must be canonical decimal strings `^(0\|[1-9][0-9]{0,39})$` (≤ 40 digits, no sign, no leading zero). `mode` safe int 0…0o177777. `nlink` / `uid` safe int 0…2³²−1. `size` safe non-negative int. `kind ∈ {file, dir, symlink, other}`. A malformed record → `CRED_ADAPTER_INVALID` and nothing raw is output. This runs on every stat (the `.git` lstats, pre, s1, s2 and post) before policy or comparison. Test C7 has 27 malformed shapes. |
| Canonical POSIX paths | `canonical(p, allowRoot)`: string 1…4096, leading `/`, no NUL, no empty / `.` / `..` segment and no trailing `/`; `/` itself is allowed only for `repoRoot`. So `//`, `//x` and `/a//b` all fail (empty segment). `dirname` / `join` handle the root deliberately (`dirname('/x') = '/'`, `join('/', '.git') = '/.git'`). |
| `repoRoot = '/'` fails CLOSED | `within(p, root)` is `root === '/' \|\| p === root \|\| p.startsWith(root + '/')`. A root of `/` contains everything, and there is no `'//'` prefix test. This applies to the REALPATH'd root too: a `repoRoot` resolving to `/` refuses. Both the parent and the path itself are tested against the root (the path check is extra and strictly narrower). Test C5 covers this, plus the sibling-prefix controls `/home/fake/.conf` and `…/e7x`. |
| Ancestor root uses `/.git` exactly | Test C6 asserts `lstat /.git` and that no `//` appears in any call. |
| All boundaries / fs calls counted | The depth bound is decided from the PATH TEXT before any fs call: parent segments + root ≤ 64, else `CRED_PATH_INVALID` with zero calls. The loop's own `walked > 64` check is then unreachable (labelled by invariant). Totals: ≤ 2 realpath, ≤ 64 `.git` lstat, 2 path lstat, 1 open, 2 fstat, ≤ 4098 read, ≤ 1 close. Test C1 pins the exact call log; test C6 covers the 64 / 65 boundary. |
| Absence = own-data `ENOENT` / `ENOTDIR` only | `errCode` reads the `code` DESCRIPTOR only on a non-proxy object, and only a data string counts. A getter `code` (not run), a proxy, a revoked proxy, a message-only `Error`, a string or `null`, `EACCES` / `EIO` / unknown → `CRED_IO`. There is no fallback. Test C6. |
| realpath return schema validated first | The result must pass `canonical(v, true)` before it is compared or used; otherwise `CRED_ADAPTER_INVALID`. A realpath rejection → `CRED_IO`. Test C4. |
| Policy on every stat | `policy()` (kind → owner → mode → links → size) runs on pre, s1, s2 and post. The mode test is `(mode & 0o7777) === 0o600`, so setuid / sticky bits, 0640 / 0400 / 0700 / 0644 / 0666 refuse. |
| **Policy vs identity precedence** | On each stat, the POLICY refusal wins over `CRED_CHANGED`. For example, s1 with a changed mode AND ino → `CRED_MODE`; a post lstat that is a symlink with a new ino → `CRED_NOT_REGULAR`. Tests C9 / C11. Across stats, the first failing step wins (steps are ordered). |
| Full post-read path lstat | Step 9 checks absence (→ `CRED_CHANGED`), policy, and all nine fields equal to s2. Test C11/12 covers renamed, replaced, time, policy, EACCES and malformed cases. |
| TRUST | The owner-controlled directory namespace, the root / OS, and same-uid actors are trusted. The checks only detect changes inside their window. This is not a sandbox and gives no atomic no-rename guarantee (stated in the module header). |

### 10.3 Binding clarification C — handle acquisition and close
| Clarification | Implementation |
|---|---|
| Close captured FIRST | Right after a native `open` fulfils, before ANY shape check: if the handle is a non-proxy object whose own DATA `close` is a non-proxy function, it is captured. Only then is the handle validated (`dataExactly` → exact `{ close, read, stat }`). |
| Malformed but closable handles are closed | An extra key, missing `read`, proxy `stat`, accessor `read` (not run) or inherited prototype → `CRED_ADAPTER_INVALID`, with close invoked exactly once and no read / stat. Test C8. |
| UNCLOSABLE | A proxy handle, accessor / missing / non-function / proxy `close`, or a `null` / primitive handle → `CRED_ADAPTER_INVALID` + `closeState:'UNCLOSABLE'`. No cleanup is claimed, and the descriptor may remain open. Test C8. A REVOKED proxy cannot even be a fulfilment value: native resolution's `then` lookup throws, so the fake's own promise rejects → `CRED_IO` / `NOT_OPENED`. Tested and documented. |
| Invoked once, after every started op settled | Handle operations are sequential `await`s, so when control reaches close, no owned operation is in flight. Close is invoked once after the `try / finally`, on every path once a handle was acquired, and is never retried. Test C13 shows order `read-settled → close`; test C17 shows no close while a read is pending. |
| Primary refusal + closeState preserved | An earlier refusal stays the code, and `closeState` reports the close outcome (e.g. `CRED_CHANGED` + `CLOSE_FAILED`, `CRED_ADAPTER_INVALID` + `CLOSE_FAILED`). With no prior refusal, a close failure → `CRED_CLOSE_FAILED` / `CLOSE_FAILED`, and success and every secret are withheld. A close failure covers a rejection, a synchronous throw, a non-native promise, a thenable, a non-promise return, or (R-C1A, §10.8) a native fulfilment with ANY value other than exactly `undefined`; it is not an acknowledged close, so the descriptor may remain open. Test C13. |
| Late / pending open | A native `open` that never settles leaves the loader pending (documented). A native `open` that does settle is always followed by the close logic, even when the handle later fails schema checks. **Residual:** a non-native / thenable `open` result is never observed (`CRED_ADAPTER_INVALID`, `NOT_OPENED`). Anything that thenable acquired is caller-owned; it is not guessed at or destroyed. |
| Zero-fill on ALL exit paths after allocation | `buf.fill(0)` runs in a `finally` that covers adapter-invalid handles, stat / read refusals, size / changed, decode errors and success, BEFORE close and BEFORE parse. The parse runs on the decoded string, so a close failure or parse error also leaves the buffer zeroed. Tests C1, C10, C13 and C14 assert every buffer handed to `read` is all zeros afterwards. This does NOT prove the JS string is erased (`text` is dropped as early as possible). |
| Private capability never in safe outputs | No example in this contract shows a populated capability. Tests assert the absence of token / key / path / repo / `SENTINEL` strings from every public result and from `JSON.stringify` of the success object (`credentials` → `{}`). |

### 10.4 Binding clarification D — bounded read and parse
| Clarification | Implementation |
|---|---|
| Owned 4097-byte buffer only | `new Uint8Array(4097)` (captured constructor). Every `read` receives exactly `(sameBuffer, offset, 4097 − offset)` (test C10 checks identity and arguments). A returned buffer or object is never retained or iterated: a non-integer return (e.g. `{ bytesRead, buffer }`) → `CRED_IO`. |
| Byte counts / progress / EOF / growth / op limit | Each `n` must be a safe int `0…4097 − offset`, else `CRED_IO` (−1, 1.5, NaN, `"3"`, `3n`, `null` and > remaining are all tested). `0` = EOF. The 4097th byte → `CRED_SIZE`. An EOF offset ≠ `s1.size` → `CRED_CHANGED` (zero early EOF, truncation, growth within the bound). `MAX_READ_CALLS = 4098` exhaustion is **unreachable under strict positive progress**: every non-EOF call adds ≥ 1 byte, so there are ≤ 4097 progress calls plus 1 EOF call. It is labelled by invariant, not manufactured. |
| UTF-8 fatal decode | One `TextDecoder('utf-8', { fatal:true, ignoreBOM:true })`. A BOM is therefore KEPT in the text, and the parser then refuses it (`CRED_PARSE`), so there is no silent BOM stripping. Invalid UTF-8 → `CRED_PARSE`. |
| Structural parse | **Deviation from §2.2 step 11 ("structure scan, then `JSON.parse` once"):** C1 uses ONE module-local strict scanner, bounded by the ≤ 4096-char text and linear. It accepts exactly one JSON object whose values are JSON strings, with full escape handling (`\" \\ \/ \b \f \n \r \t \uXXXX`), raw control characters refused, and only JSON whitespace (`space`, `\t`, `\n`, `\r`). `JSON.parse` is not used. Reason: `JSON.parse` resolves duplicate keys last-wins, and binding clarification D asks to refuse that ambiguity. Results go into a `Map`, so `__proto__` / `toJSON` / `constructor` are plain keys (→ extra key) and never touch a prototype. |
| Duplicate keys | **Refused** (`CRED_SHAPE`), comparing DECODED keys. An escaped alias (`"hostawayToken"` + `"hostawayToken"`) is therefore a duplicate. There is no last-key-override behaviour anywhere. Test C14. |
| Code split | Grammar violations (non-object top level, BOM, trailing data or comma, bare keys, bad escapes, raw tab, truncation) → `CRED_PARSE`. A JSON value that is not a string (number / boolean / `null` / array / nested object), an extra / missing / duplicate key, an empty / non-printable token, or a non-ASCII token → `CRED_SHAPE`. So the §2.2 phrase "depth → CRED_PARSE" becomes: nesting is a type confusion → `CRED_SHAPE`. The value rules are unchanged: token `^[\x21-\x7e]{1,4096}$`; key `^sk_test_[A-Za-z0-9]{1,247}$`, anything else → `CRED_KEY_NOT_TEST` (live / restricted / publishable / uppercase / over-long all tested). |
| No content leakage | The scanner produces only `{ ok, code }`, and no exception text is ever propagated. Sentinel assertions cover every refusal. |
| Required test classes | Positive single-provider (both kinds) and both-provider controls (C1); partial one-byte reads; the exact 4096 maximum; zero early EOF; growth / truncation (C10); mutated path / policy / times (C9, C11/12); malformed fs replies (C3, C4, C6, C7, C8); private capability enumerability / deep-freeze (C1); sentinels (all). |

### 10.5 Binding clarification E — pins, labels, stage boundaries
* Source pins are unchanged. The new scripts never spell the pinned reservation-adapter filename, and the PIN test asserts that. The accepted `hostaway-reservations` containment test, the secret-pattern scan and the e4-connected user pins all pass in `npm test`.
* There is no Node / API / version-label or `sourceDigest` change. C2 (command / disposition) and C3 (process entrypoint, real fs adapter, snapshot builder, digest enforcement) are **DEFERRED — not implemented and not authorized**.

### 10.6 Validation (this slice)
* **Focused, FIRST FULL TAP preserved** (`test/e7-connected-probe-ingress.test.mjs`, 20 tests at the time): **16 / 20**. All four were test-fixture defects; the module was unchanged:
  1. C1: `String()` of a null-prototype object threw in the redaction helper.
  2. C6: the 63-deep positive control declared a stat size that did not match its body, so it hit `CRED_CHANGED` before the post lstat; the expectation was tightened to `ok`.
  3. C7: same root cause as C8 — a revoked proxy can't be a promise fulfilment value. `Promise.resolve(revoked)` REJECTS, so `CRED_IO` / `NOT_OPENED` is correct; this is now asserted separately.
  4. C8: same as C7.
  * Second run: 19 / 20. The remaining C7 positive control changed only the path stat, not the fd stat, so the fixture was fixed via the shared `stat` override. Third run: 20 / 20.
* **First full `npm test`:** **870 / 871**. `legacy-routes-retired` "no Stripe key or webhook-secret patterns" flagged the test file's synthetic `sk_test_…` / `sk_live_…` sentinels (≥ 8 alnum). They were shortened to `…_Fake1`.
* **Re-run:** focused 20 / 20, units 206 / 206 (`e7-connected-*`, `hostaway-reservations`, `e4-connected-path`), `npm test` 871 / 871. Afterwards three §2.3-named cases were added (an `execArgv` array instead of the count, mode 0700 / 0640, and C17 hanging fs). **Final:** focused 21 / 21, units 207 / 207, `npm test` 872 / 872.
* **Meaningful optional probes** (each temporarily applied to the module and reverted; module byte-identical afterwards; all killed):
  * M1 — `within` without the root-`/` rule;
  * M2 — zero-fill only on success;
  * M3 — duplicate-key check removed;
  * M4 — post-lstat policy removed;
  * M5 — UNCLOSABLE reported as CLOSED.
* **Zero** network / fetch / default fs / real credential or temp file / env / owner access in any test path. The test reads only the two module sources as TEXT for the pins.

### 10.7 Residuals (precise)
1. A non-native, patched or thenable adapter return (realpath / lstat / open / stat / read / close) is never observed. Any rejection or acquired resource behind it is caller-owned.
2. UNCLOSABLE and CLOSE_FAILED may leave a descriptor open. No cleanup is claimed.
3. A pending native op (including open) keeps the loader pending forever. There is no elapsed bound, and a synchronously blocking fs blocks.
4. Zero-fill is best effort for the module's bytes only. The decoded JS string and any adapter-internal copies are not provably erased.
5. Built-ins other than the captured intrinsics, the Node binary, the OS, the directory namespace and same-uid / root actors are TRUST. A detected change within the check window is the strongest claim.
6. C1 outputs evaluate the supplied snapshot / adapter replies; they are not runtime attestation. No owner environment has been verified.

### 10.8 Root CODE HOLD on `29d7b63e` — correction R-C1A (same branch, fast-forward from exact `29d7b63e`)
**Defect (root, reproduced).** §2.2 defines `close()` → native promise of `undefined`, but step 10 treated ANY native fulfilment as an acknowledged close. With an otherwise valid Hostaway-only fake file, `Promise.resolve(false)`, `Promise.resolve(17)` and `Promise.resolve({ status:'not-acknowledged' })` each released the capability with `ok:true` / `closeState:'CLOSED'`.

**Correction (one expression, `probe-credential-file.mjs` step 10).** `closeState = c !== null && c.ok && c.v === undefined ? 'CLOSED' : 'CLOSE_FAILED'`. Only a native fulfilment with exactly `undefined` is an acknowledged close. Every other fulfilment value is `CLOSE_FAILED`:
- With no earlier refusal → `CRED_CLOSE_FAILED`, and the success capability and every secret are withheld.
- With an earlier refusal → that refusal stays primary, reported with `CLOSE_FAILED`.

Close is still attempted exactly once: no retry, no guessed disposal. This evaluates the trusted adapter's contract; it is not physical proof that a descriptor was closed. Nothing else changed: no parser or API change, and `probe-env-preflight.mjs` and all other files are untouched.

**Red / green.** NEW test C13b:
- Valid control: `undefined` → `ok`, `CLOSED`, close called once.
- Malformed fulfilments: `false`, `null`, `0`, `17`, `NaN`, `''`, `'ok'`, `'undefined'`, `{}`, `{ status:'not-acknowledged' }`, `[]`, a function, a symbol, `0n`. Each gives `CRED_CLOSE_FAILED` / `CLOSE_FAILED`, no `credentials`, sentinels absent, close called once, buffer zeroed.
- Prior-refusal precedence: `CRED_CHANGED` and `CRED_ADAPTER_INVALID` are each kept, with `CLOSE_FAILED`. A prior refusal plus a valid `undefined` close still gives `CLOSED`.

Runs:
- **RED** with the test alone against the exact `29d7b63e` module: 21/22. C13b failed on the first malformed value (`false` → `ok:true`).
- **GREEN after the fix, FIRST FULL TAP:** focused 22/22, units (`e7-connected-*`, `hostaway-reservations`, `e4-connected-path`) 208/208, first full `npm test` 873/873. No first-run failures.

## 11. C2 EXECUTABLE CONTRACT (revision 3; DOCS ONLY; proposed for the next bounded implementation turn, NOT implemented, NOT authorized)
**Status.** C1 was ACCEPTED OFFLINE by root at `ac974d75` (R-C1A closed). The accepted limits are retained:
- the strict object-of-strings parser and its duplicate-key refusal;
- policy-over-identity precedence;
- no elapsed bound;
- ownership of rejections from invalid (non-native) promises stays with the caller;
- `UNCLOSABLE` / `CLOSE_FAILED` may leave a descriptor open;
- same-process / namespace TRUST;
- no JS-string erasure;
- the env result evaluates the supplied snapshot only.

This section **finishes the §4 deferred interface; it does not redesign C1 / P / T / X**. Where §3 or §4 differ from it, **§11 supersedes them**; §§3–4 stay as history. Real execution, C3 and every live gate stay CLOSED.

**Citation convention.** `file:line` at `ac974d75`. Sources:
- P `scripts/e7-connected/readonly-probe.mjs`: `validateProbePlan` :138, `canonicalJson` :131, `runReadonlyProbes` :366 (input keys `{plan, hostaway?, stripe?, deps:{monotonic, timers:{arm}}, signal?}` :371–391), `finalize` :554–571 → `{ tail, timerCleanup }`, summary :539–540, `CODES` :29, `VOCABULARY` :45, `T_ERROR_CODES` :23, `STRIPE_VERSION_CANDIDATE` :18.
- T `scripts/e7-connected/http-transports.mjs`: `createE7HostawaySend({exchange, credential, maxBytes?})` :307 (`credential` must be a SYNCHRONOUS non-async function, :65 / :309), `createE7StripeTestSend({exchange, credential, accountId, apiVersion, maxBytes?})` :353.
- X `scripts/e7-connected/real-exchange.mjs`: `createE7RealExchange({provider, primitive?})` :186. **When `primitive` is omitted, X defaults to `NODE_HTTPS_PRIMITIVE` (:189, :28).** It calls `new PrimAgent(AGENT_OPTIONS)` :282 and then `apply(primRequest, undefined, [options])` :288.
- C1 `probe-env-preflight.mjs` / `probe-credential-file.mjs` (§2, §10).

### 11.1 Files proposed for the C2 implementation turn (exactly four)
| File | Why |
|---|---|
| NEW `scripts/e7-connected/probe-command.mjs` | `runProbeCommand`, the ONLY assembly. Imports exactly: `node:util` (`types`); P `validateProbePlan`, `canonicalJson`, `runReadonlyProbes`, `VOCABULARY`, `T_ERROR_CODES`, `CODES`; T `createE7HostawaySend`, `createE7StripeTestSend`; X `createE7RealExchange`; C1 `evaluateProbeEnvironment`, `ENV_CODES`, `ENV_CHECK_KEYS`, `readProbeCredentialFile`, `CREDENTIAL_CODES`, `CLOSE_STATES`. **Never** imported: `node:fs`, `node:crypto`, `process`, timers, `console`, `node:https` (X imports it transitively; C2 never names `NODE_HTTPS_PRIMITIVE`), booking core, A, workers, DB, SDK, or the reservation adapter. |
| NEW `scripts/e7-connected/probe-source-digest.mjs` | **Justified extra helper (§11.4):** the digest must be computed BEFORE C2 is imported, so it cannot live inside C2 without a circular bootstrap. Pure; imports exactly `node:crypto` (`createHash`) and `node:util` (`types`). It reads nothing itself. |
| NEW `test/e7-connected-probe-command.test.mjs` | Fake-only integration tests (§11.10). |
| `claude/e7-connected-probe-cli-contract.md` | C2 implementation map. |

### 11.2 `runProbeCommand({ argv, deps })` — signature, promise and throw semantics
- **Returns** a native Promise of a deep-frozen **disposition** (§11.8). It **never throws and never rejects.** A synchronous fault or an unexpected internal rejection becomes disposition `CLI_INTERNAL`, exit 1, with no raw error.
- **Top input:** a plain or null-prototype object with own enumerable DATA keys exactly `{ argv, deps }`. It is read once, getter-free (the C1 `dataExactly` rule); proxies, including revoked ones, are refused. A malformed top input gives `CLI_DEPS_INVALID`, exit 1.
- **`argv`:** a genuine dense `Array`, non-proxy, own data elements only, length ≤ 32. Each element is a string of 1…4096 characters without NUL. It is snapshotted once, by index descriptors only; no iterator is ever called.
- **Grammar** (tokens are `--name value` pairs; no `=` form; each flag at most once; nothing positional except the optional first mode word):
  - **`inspect`, the DEFAULT** — used when `argv[0]` is absent or starts with `--`, or when `argv[0] === 'inspect'`.
    - Required: `--plan <abs>`.
    - Optional, compared and reported only, never required: `--expect-plan-hash <64 lowercase hex>`, `--expect-source-digest <64 lowercase hex>`, `--expect-requests <1…8>`, `--approval-ref <label>`.
    - `--credentials` and `--summary-out` are **refused** in inspect (`CLI_USAGE`): inspect has no route to secrets or output.
  - **`execute`** — `argv[0] === 'execute'`. ALL of these are required: `--plan`, `--credentials`, `--summary-out` (**mandatory**), `--expect-plan-hash`, `--expect-source-digest`, `--expect-requests`, `--approval-ref`.
  - **Value rules:**
    - Paths: C1 `canonical(p, false)` — absolute, ≤ 4096, no NUL, no empty / `.` / `..` segment, no trailing `/`, never `/`.
    - Hashes: `^[0-9a-f]{64}$`.
    - `--expect-requests`: `^[1-8]$`.
    - `--approval-ref`: `^[A-Za-z0-9._:-]{1,80}$`, P's metadata rule (`readonly-probe.mjs:143`).
    - In execute, the `--plan`, `--credentials` and `--summary-out` paths must be pairwise distinct.
  - Anything else gives `CLI_USAGE`, exit 2.
- **`deps`:** a plain or null-prototype object with own enumerable DATA keys **exactly** the set for the mode. Extra or missing keys, proxies, accessors or wrong types give `CLI_DEPS_INVALID`, exit 1. This is a C3 wiring fault, never an owner question.

| Key | inspect | execute | Schema / ownership |
|---|---|---|---|
| `envSnapshot` | ✔ | ✔ | Passed to C1 `evaluateProbeEnvironment` unchanged. **It must be frozen, and so must its `present` object** (`Object.isFrozen`), so the `nodeVersion` C2 reads afterwards by own-data descriptor is the same value C1 evaluated. |
| `repoRoot` | ✔ | ✔ | Canonical absolute string (`/` allowed; C1 then fails closed). |
| `sourceDigest` | ✔ | ✔ | `null` or a 64-hex string — a value computed by C3 with §11.4 BEFORE it imports C2. C2 treats it as a TRUSTED injected input. |
| `readPlanFile` | ✔ | ✔ | Non-proxy function (§11.5). |
| `interrupt` | ✔ | ✔ | Genuine `AbortSignal`, checked through the captured `AbortSignal.prototype.aborted` getter (P's `nativeAborted` rule, `readonly-probe.mjs:62, 78`). C3 aborts it on the first SIGINT. |
| `credentialFs` | — | ✔ | Passed verbatim to C1 (C1 validates it; §2.2). |
| `outputFs` | — | ✔ | §11.6. `platform` / `uid` must equal `credentialFs`'s (own-data reads) or `CLI_DEPS_INVALID`. |
| `primitive` | — | ✔ | Own data exactly `{ Agent, request }`, non-proxy functions. **Always passed explicitly to X, so X's default `NODE_HTTPS_PRIMITIVE` is unreachable from C2.** |
| `monotonic`, `timers` | — | ✔ | Passed to P unchanged as `deps:{ monotonic, timers }` (P validates them, `:381–389`). C2 itself owns no clock or timer. |

### 11.3 Stage order (first refusal wins; a refusal means zero later stages; `interrupt` checked at every arrow)
`INT` = a native check of `interrupt`. It runs **before each stage and immediately after every injected call returns synchronously AND after its promise settles** — at the re-entrancy boundary, not only before awaits.
1. **argv → deps** (no injected call).
2. **env:** `evaluateProbeEnvironment(envSnapshot)` → INT. In execute, `!ok` gives `CLI_ENV_REFUSED` (exit 3); inspect reports it.
3. **source:** in execute, `sourceDigest === null` gives `CLI_SOURCE_UNREADABLE` and `sourceDigest !== --expect-source-digest` gives `CLI_SOURCE_MISMATCH` (both exit 4). Inspect reports `sourceDigest` (or `null`) and, when the flag was given, `sourceMatches`. This comparison is a consistency check of an injected value; the real enforcement is C3's pre-import check, which stays CLOSED.
4. **plan:** `readPlanFile(--plan)` → INT → settle → INT → bytes rules (§11.5) → `validateProbePlan(parsed)` (P refusal code reported from `CODES.plan`; `CLI_PLAN_INVALID`, exit 4). Plan problems refuse in BOTH modes.
5. **bindings** (execute refuses with `CLI_BINDING_MISMATCH`, exit 4; inspect reports a boolean or `null` per flag):
   - `plan.planHash === --expect-plan-hash`;
   - `plan.probes.length === --expect-requests`;
   - `plan.metadata.nodeVersion === envSnapshot.nodeVersion`;
   - `plan.metadata.approvalRef === --approval-ref`.

   P already enforces `stripeVersion` (`:144`). `metadata.reviewedCommit` and `approvalRef` are echoed LABELS — never attestation, consent or permission.
   - **Inspect stops here:** `CLI_INSPECT_OK`, exit 10. **Inspect makes zero `credentialFs` / `outputFs` / `primitive` / `monotonic` / `timers` calls and constructs no T, X or Agent** (those deps are not even accepted).
6. **output-parent preflight** (§11.6) → INT. This happens **before any secret read**. A bad parent gives `CLI_OUTPUT_PARENT_INVALID`; a target that already exists gives `CLI_OUTPUT_EXISTS` (pre-run refusal, exit 4).
7. **credentials:** `readProbeCredentialFile({ path: --credentials, repoRoot, needs, fs: credentialFs })`, where `needs = { hostaway: probes include a 'P-H*', stripe: probes include a 'P-S*' }` (derived from the immutable plan only) → INT at return → settle → INT.
   - A C1 refusal gives `CLI_CREDENTIAL_REFUSED` (exit 5), and the public `{ code, closeState }` is reported.
   - **If INT fires after C1 settles:** the capability reference is dropped (`cap = null`) and `CLI_INTERRUPTED` (exit 7) is returned. There is no assembly and no network.
   - **C1 IO may hang** (accepted, no elapsed bound). Neither P's timers nor C2 bound it. An interrupt during a hanging C1 load is observed only when C1 settles; C3 owns any decision to exit (§5).
8. **assembly X → T → P**, directly, with no extra layer:
   - `hx = createE7RealExchange({ provider:'hostaway', primitive: counted })` and `sx = createE7RealExchange({ provider:'stripe', primitive: counted })` (only for the providers in `needs`).
   - **Counted primitive:** `counted = { Agent: primitive.Agent, request(options) { attempted += 1; if (attempted > expectRequests) throw REFUSE; return apply(primitive.request, undefined, [options]); } }`. It never reads, keeps or logs `options`. X maps the synchronous throw to `EXCHANGE_SETUP_FAILED` (`:288`).
     - Reaching the guard is **unreachable through accepted P** (one send per probe, one exchange per send). It is defense in depth, labelled by that invariant.
     - `requestsAttempted` is reported in the payload.
   - **T sends:**
     - `createE7HostawaySend({ exchange: hx.exchange, credential: tokenFn })`;
     - `createE7StripeTestSend({ exchange: sx.exchange, credential: keyFn, accountId: plan.stripe.accountId, apiVersion: plan.metadata.stripeVersion })`;
     - `tokenFn` / `keyFn` are plain synchronous functions that read a C2-local `let creds` (the frozen capability's non-enumerable properties). Any `ok:false` from X or T gives `CLI_INTERNAL`.
   - **P run:** `runReadonlyProbes({ plan, hostaway?, stripe?, deps:{ monotonic, timers }, signal: interrupt })`. P's `ok:false` gives `CLI_INTERNAL` with the P run code reported.
   - **Probe inventory:** only P's accepted GET inventory (`requestFor`, `:341–355`). There is no request, state, page, retry, fallback or write endpoint derived from any reply. Bindings (plan, needs, accountId, version, request limit) are immutable primitives captured before the run.
9. **await `result`, then await `finalize()`** (both native and never-rejecting per P). Then `creds = null`, so a late `credential()` call gets `null` and T gives `CREDENTIAL_INVALID`. An interrupt during stage 9 is P's `signal` (`PROBE_CANCELLED`), and C2 still awaits both truthfully. P's STOP vs INCONCLUSIVE continuation is unchanged: C2 never re-drives, skips or reinterprets probes.
10. **payload → summary file (§11.7) → disposition (§11.8).** Pre-run refusals (stages 1–7, including `CLI_INTERRUPTED`) write **no** summary file (`summaryFile:'NOT_ATTEMPTED'`). Only a run that reached stage 8 writes evidence.

### 11.4 Source digest seam — who computes, who compares
- **Computes:** `probe-source-digest.mjs` exports `SOURCE_CLOSURE` (frozen, fixed order) and `computeSourceDigest(snapshot) → frozen { ok:true, digest } | { ok:false, code:'SOURCE_SNAPSHOT_INVALID' }`.
- **Snapshot:** a dense array, exactly `SOURCE_CLOSURE.length` entries, of own-data `{ path, bytes }` objects.
  - `path` must equal `SOURCE_CLOSURE[i]` exactly.
  - `bytes` must be a genuine `Uint8Array` (exact prototype, non-proxy, not on a `SharedArrayBuffer`), of 1…262144 bytes; the total must be ≤ 2 MiB.
  - Each array is **copied once** into an owned buffer before hashing.
  - Missing, extra, reordered or oversize entries give `SOURCE_SNAPSHOT_INVALID`.
- **Recipe (§3, unchanged framing):** `SHA-256( "e7-probe-source-v1\n" ‖ Σ ( utf8(path) ‖ 0x00 ‖ ascii(decimal(byteLength)) ‖ 0x00 ‖ bytes ‖ 0x00 ) )`, lowercase hex.
- **`SOURCE_CLOSURE` (13 entries, this order):**
  1. `package.json`
  2. `scripts/e7-connected/probe-cli-main.mjs`
  3. `scripts/e7-connected/probe-source-digest.mjs`
  4. `scripts/e7-connected/probe-command.mjs`
  5. `scripts/e7-connected/probe-env-preflight.mjs`
  6. `scripts/e7-connected/probe-credential-file.mjs`
  7. `scripts/e7-connected/readonly-probe.mjs`
  8. `scripts/e7-connected/http-transports.mjs`
  9. `scripts/e7-connected/real-exchange.mjs`
  10. `lib/checkout/compensation-proof.js`
  11. `lib/checkout/recovery-plan.js`
  12. `lib/checkout/capture-proof.js`
  13. `lib/checkout/intent-state.js`

  This is the reviewed static closure of §3 plus the new helper. `intent-state.js` has no imports; the others' local imports are cited in §3. Today's largest member is 45.8 KB, well under the 256 KiB bound.
- **Reads:** nobody in C2. C3 (CLOSED) would statically import only Node built-ins plus this helper, read the 13 files with its own no-follow regular-file adapter, compute the digest, compare it with `--expect-source-digest`, and **only then** dynamically import C2. It then passes the computed value as `deps.sourceDigest`.
  - **`probe-cli-main.mjs` does not exist yet, so real enforcement is impossible until C3 exists.** C2 tests use synthetic bytes for that entry.
  - There is no dynamic module discovery, no git subprocess and no guessing of C3 code.
- **Compares:** C3 is authoritative (pre-import). C2 re-compares the injected value (§11.3 step 3) only to refuse inconsistent wiring.
- **Limits (unchanged):** the disk digest does not prove the bytes actually loaded (TOCTOU, same-uid mutation); the Node binary, intrinsics and OS remain TRUST.

### 11.5 `readPlanFile` — minimum schema
- `readPlanFile(path)` → a native unpatched Promise (B/T/P rule) of a genuine `Uint8Array` (exact prototype, non-proxy, non-shared) of length 1…16384. It is called exactly once and never retried.
  - A rejection, a non-native promise, a sync throw or a wrong value gives `CLI_PLAN_UNREADABLE` (exit 4).
  - A non-native return is never observed; its rejection is caller-owned (the C1 residual, applied unchanged).
- C2 copies the bytes once into an owned buffer, decodes them as fatal UTF-8 (`ignoreBOM:true`, so a BOM is refused), then `JSON.parse`.
- **Canonical-file rule:** the decoded text must equal `canonicalJson(parsed)` exactly, optionally followed by a single `"\n"`; otherwise `CLI_PLAN_INVALID` with plan code `PLAN_NOT_CANONICAL`.
  - This removes duplicate-key and whitespace ambiguity without a new parser: a file containing two values for one key cannot be canonical.
  - The text a human approves is exactly what `planHash` covers (`readonly-probe.mjs:180`).
  - Plan contents are not secret. Plan identifiers never appear in the payload (only `planHash`, `probes`, `maxRequests`, metadata labels).
- The plan adapter (C3, CLOSED) is TRUSTED to read the named path with no-follow regular-file rules. The integrity that matters in execute comes from `--expect-plan-hash`.

### 11.6 `outputFs` — minimum adapter, ownership, bounds
- **Shape:** own data exactly `{ platform, uid, lstat, realpath, create }`.
  - `lstat` / `realpath` follow exactly C1's schema and absence rules (§2.2): the stat record has 9 fields with strict types, and ABSENT means own-data `code` `ENOENT` / `ENOTDIR` only.
  - C2 re-implements the small stat / path validators locally. C1 is accepted and is not modified to export them.
- **Preflight (stage 6)**, with `parent = dirname(--summary-out)`:
  - `realpath(parent) === parent`;
  - `lstat(parent)`: kind `dir`, `uid === outputFs.uid`, `(mode & 0o022) === 0`;
  - not inside `realpath(repoRoot)` (repoRoot `/` fails closed) and no `.git` ancestor (≤ 64, root `/.git` exactly);
  - `lstat(target)` must be ABSENT, otherwise `CLI_OUTPUT_EXISTS`.

  Any other failure or malformed reply gives `CLI_OUTPUT_PARENT_INVALID`.
  - This preflight is only a pre-run refusal; the authoritative race check is `O_EXCL` at create time.
- **`create(path, 'summary-create')`:** the single reviewed kind, `O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW`, mode `0600`. It returns a native promise of a handle with own data exactly `{ write, sync, close }`.
  - **Close is captured FIRST** (C1 rule): close-first capture, invoked once after every started write / sync settled, never retried, acknowledged only by a native fulfilment of exactly `undefined` (R-C1A).
  - Malformed but closable handles are closed. With no safely callable close, the state is `UNCLOSABLE`, and no cleanup is claimed.
- **`write(bytes, offset, length)`:** C2 passes its own payload `Uint8Array`. The reply must be a native promise of a safe integer in 1…`length`; each call makes positive progress. There are at most `payloadBytes` calls (≤ 65536). A `0` reply, an invalid count or a rejection gives UNKNOWN.
- **`sync()`:** a native promise of exactly `undefined`.
- **Operation bounds:** ≤ 2 `realpath`, ≤ 64 `.git` `lstat`, 1 parent `lstat`, 1 target `lstat`, 1 `create`, ≤ 65536 `write`, 1 `sync`, 1 `close`. There is **no elapsed bound**; a hanging output fs keeps C2 pending (C3 decides).
- **Summary file states** (for the file only):
  - `NOT_ATTEMPTED`;
  - `RACE_EXISTS` — create rejected with own-data `code === 'EEXIST'`; nothing was written by this process;
  - `UNKNOWN` — any other create failure (a create that failed for another reason cannot prove no file was created), any write / sync failure, a non-`undefined` sync / close reply, or `CLOSE_FAILED` / `UNCLOSABLE`. Partial or landed-but-unacknowledged content is possible, so this is **never "nothing written"**;
  - `CLOSED_ACK` — every byte acknowledged, `sync` returned `undefined` and `close` returned `undefined`.

  `summaryCloseState ∈ CLOSE_STATES` is reported separately.
- **Never** overwrite, append, repair, unlink, rename, retry or create a second time.

### 11.7 Payload vs output disposition (no circular claims)
- **Payload:** immutable and built BEFORE any output IO. It is a deep-frozen plain object, serialized with P's `canonicalJson`, ≤ 65536 bytes UTF-8:
  - `schema: 'e7-probe-cli-result-v1'`, `mode`, `primaryOutcome`;
  - `runExitCode` — the precedence of the operational facts only (§11.8 rows 8 / 6 / 11 / 0), never output facts;
  - `tailUncertain`, `interruptObserved`;
  - `preflight` (C1 env result), `credential` (`null` or `{ code, closeState }`), `plan` (`{ planHash, probes, maxRequests, metadata }`), `sourceDigest`, `requestsAttempted`;
  - `summary` (P summary verbatim), `finalize` (`{ tail, timerCleanup }` verbatim).

  It contains **no** summary-file, stdout or final-exit status.
- **Summary file bytes** = `canonicalJson(payload) + "\n"`.
- **Stdout line** = `canonicalJson({ schema:'e7-probe-cli-stdout-v1', payload, output:{ summaryFile, summaryCloseState }, exitCode })`, built AFTER the file outcome is known.
  - The payload object is identical (the same canonical bytes) in both places. **The file and stdout are deliberately NOT byte-identical:** stdout carries the later file disposition, which the file cannot contain about itself.
  - For pre-run refusals and inspect, there is no file, and `payload.summary` / `finalize` are `null`.
- **Stdout acknowledgment** cannot be described inside stdout. C3 performs the single write. On failure C3 raises the exit code to 9 (unless it is 130) and makes no second attempt; nothing is promised flushed.
- **Mechanical redaction before any output:**
  - every string value in the payload / stdout must be in the whitelist union: P `VOCABULARY` ∪ `T_ERROR_CODES` ∪ `ENV_CODES` ∪ `CREDENTIAL_CODES` ∪ `CLOSE_STATES` ∪ CLI codes ∪ the summary-file states ∪ the two schemas ∪ the modes ∪ `planHash` ∪ `sourceDigest` ∪ the four metadata labels;
  - keys must come from the fixed key set.

  A violation (unreachable by construction) or an oversize payload gives `CLI_INTERNAL`: no summary file, and a fixed stdout envelope with `payload:null` but with `primaryOutcome` kept. **No raw error, body, path, size, env value, credential or identifier is ever emitted.**

### 11.8 Disposition, precedence (computed exactly once in C2), vocabulary
- **Disposition:** deep-frozen `{ exitCode, primaryOutcome, tailUncertain, summaryFile, summaryCloseState, stdoutLine }`, returned to C3. C2 performs no `process.exit`, owns no signal and never writes stdout.
- **Precedence:** one function `exitFor(facts)`, the only place it is computed in C2. It covers: `9` summary file ≠ `CLOSED_ACK` (execute run only) > `8` tail uncertain (`tail ∈ {UNSETTLED, UNOBSERVABLE}` or `cancelFailed + uncancellable > 0`) > `6` P `STOPPED` > `11` completed with ≥ 1 non-OK probe (INCONCLUSIVE / `PREREQ_INCONCLUSIVE`; **not success**) > `0` all probes OK.
  - C3 applies only the two tiers C2 cannot know: `130` (second SIGINT) and stdout failure → `9`.
  - Pre-run and other codes, with no run: `2` usage, `3` env, `4` source / plan / binding / output-parent / output-exists, `5` credential, `7` interrupted before the run, `10` inspect OK, `1` deps / internal.
- **`primaryOutcome`** (the true operational result, kept separate from the exit code): one of `CLI_INSPECT_OK, CLI_COMPLETED_OK, CLI_COMPLETED_INCONCLUSIVE, CLI_PROBE_STOPPED, CLI_USAGE, CLI_DEPS_INVALID, CLI_ENV_REFUSED, CLI_SOURCE_UNREADABLE, CLI_SOURCE_MISMATCH, CLI_PLAN_UNREADABLE, CLI_PLAN_INVALID, CLI_BINDING_MISMATCH, CLI_OUTPUT_PARENT_INVALID, CLI_OUTPUT_EXISTS, CLI_CREDENTIAL_REFUSED, CLI_INTERRUPTED, CLI_INTERNAL`.
- **Output-fault codes** (disposition / `output` only, never primary): `CLI_TAIL_UNCERTAIN, CLI_OUTPUT_RACE, CLI_OUTPUT_UNKNOWN`.
- **CLI vocabulary:** the union of the two lists above (20 codes). §4's list is superseded by this one, which adds `CLI_DEPS_INVALID` and `CLI_PLAN_UNREADABLE`.
- `PLAN_NOT_CANONICAL` is a C2 plan sub-code added to the whitelist.

### 11.9 Resolution / decision map (root items 1–6)
| # | Decision | Where |
|---|---|---|
| 1 | Exact own-data `{argv, deps}`; inspect default without expect flags; per-mode exact deps sets; never throws or rejects; C1 used as accepted (private capability, close exactly `undefined`), with no new credential API or policy | §11.2 |
| 2 | Pure helper `probe-source-digest.mjs` with a caller-provided read snapshot; C3 computes and enforces before import (CLOSED); C2 re-compares the injected value only; fixed 13-path closure, framing, byte-copy bounds; labels never attestation | §11.4 |
| 3 | Minimal `readPlanFile` (bytes only, canonical-file rule) and `outputFs` (`create` / handle) schemas with bounds and ownership; all preflights before C1; inspect zero secrets / T / X / Agent; direct X → T → P; counted primitive; immutable bindings | §11.3, §11.5, §11.6 |
| 4 | INT before every stage and after every injected return / settle; capability discarded after C1 settles if interrupted; C1 hang unbounded and stated; P result / finalize awaited truthfully, `tail` / `timerCleanup` propagated verbatim; disposition only; P semantics unchanged | §11.3, §11.8 |
| 5 | Immutable payload vs later file / stdout disposition; deliberately non-identical file vs stdout bytes, stated; `RACE_EXISTS` vs `UNKNOWN`; existence preflight vs `O_EXCL` race separated; precedence once; close-first, once, `undefined`-only acknowledgment; no leak | §11.6, §11.7, §11.8 |
| 6 | Exactly four files, with the helper justified; fake-only tests listed below | §11.1, §11.10 |

**Material unresolved blockers: none for the offline C2 implementation.** Items that are not blockers but remain true:
- real enforcement of the digest and of the output adapter's `O_EXCL | O_NOFOLLOW` needs C3 and native evidence (CLOSED);
- the canonical plan file must be produced by the owner-side preparation step (C3-prep scope).

### 11.10 C2 tests (fake-only; meaningful integrated checks, no mutation quota)
All snapshots, fs objects, handles, promises, bodies and primitives are fakes, with short synthetic key patterns (e.g. `sk_test_Fake1`). There are no real files, temp files, env, credentials, PG, installs, provider calls or network.
1. **Inspect:**
   - default (no mode word) and explicit, with and without the optional expect flags;
   - exact reports;
   - **zero** `credentialFs`, `outputFs`, `primitive`, `monotonic` and `timers` deps and calls;
   - refusal of `--credentials` / `--summary-out` in inspect.
2. **Usage / deps matrices:** missing, extra or duplicated flags; bad values; `=` form; proxy / accessor / revoked `argv` and `deps`; an unfrozen `envSnapshot`; mismatched `platform` / `uid` → `CLI_USAGE` / `CLI_DEPS_INVALID`, with zero injected calls.
3. **Refusal before secrets:** env, source (`null` / mismatch), plan unreadable / non-canonical (including a duplicate-key plan) / P-invalid, each binding, output-parent faults, output exists → **zero `credentialFs` calls and zero `primitive` calls.**
4. **C1 → T / X / P over a fake https primitive** (both providers and single-provider plans):
   - `requestsAttempted === probes.length`;
   - `credential()` reads a non-enumerable capability, and after finalize it yields `CREDENTIAL_INVALID`;
   - the summary bytes equal `canonicalJson(payload)+"\n"`, and the stdout envelope holds the identical payload;
   - exit 0;
   - C1 refusal → 5 with zero primitive calls.
5. **P semantics:** STOP → `CLI_PROBE_STOPPED` / 6; INCONCLUSIVE continuation → 11, with independent probes still run.
6. **Interrupt:**
   - before env / after plan read / after the preflight → 7, no credential read;
   - during a pending C1 load (abort, then C1 settles) → capability discarded, zero primitive calls, 7;
   - during P → `PROBE_CANCELLED` per P, result and finalize awaited, summary written.
7. **Output faults:**
   - `EEXIST` → `RACE_EXISTS` / 9;
   - other create rejection → `UNKNOWN` / 9;
   - partial write then rejection / zero write / sync fault / close non-`undefined` / unclosable → `UNKNOWN` / 9;
   - exactly one create and one close, with no retry or second create;
   - `primaryOutcome` preserved.
8. **Tail / cleanup:**
   - `UNSETTLED` / `UNOBSERVABLE` / `cancelFailed` → 8;
   - combinations 9 + 8 → 9 with `tailUncertain:true`; 6 + 8 → 8 with primary `CLI_PROBE_STOPPED`; 11 + 9 → 9.
9. **Source digest helper:**
   - framing vectors;
   - one changed byte in `compensation-proof.js` or `package.json` changes the digest;
   - reorder / missing / extra / oversize / non-genuine bytes → `SOURCE_SNAPSHOT_INVALID`;
   - a synthetic `probe-cli-main.mjs` entry;
   - the input array is copied (mutating it after the call does not change the result).
10. **Redaction / pins:**
    - sentinels (paths, token, key, plan ids, error messages) are absent from every disposition and file payload;
    - the C2 / helper import lists are exact;
    - no `process` / `node:fs` / timers / `console` / `node:https` / `NODE_HTTPS_PRIMITIVE` / booking-core / reservation-adapter text in the new scripts.

**Exit criteria:** focused and relevant units (P / T / X / rehearsal / C1 / pins) plus `npm test` green, the FIRST FULL TAP preserved, no change outside the four files, root CODE review.

### 11.11 Remaining path after C2 (not done here; nothing below is authorization)
1. **C2 implementation** (this spec) → root CODE review.
2. **C3 preparation contract** (CLOSED until separately authorized): the real read-only fs adapters (refusing to construct without `O_NOFOLLOW`), the snapshot builder, the pre-import digest bootstrap, signals / stdout / exit, and a canonical-plan preparation step.
3. **Native evidence** on the owner's exact platform and Node version (separate CLOSED scope).
4. **Owner inputs**, all UNSET: plan values, listing / reservations (never a protected id), TEST account / PI, the credential file.
5. **ONE consolidated exact approval package (§6)** → Joel's explicit approval of that package → a single controlled read-only run.

No step claims readiness or that anything is live.

## 12. C2 implementation / clarification / deviation / FIRST-TAP map (branch `feature/e7-connected-probe-command` from exact `d81fea91`)
**Scope held.** Exactly four files:
- NEW `scripts/e7-connected/probe-command.mjs`
- NEW `scripts/e7-connected/probe-source-digest.mjs`
- NEW `test/e7-connected-probe-command.test.mjs`
- this contract (§§0–11 kept verbatim)

**Imports are exactly §11.1.**
- The command imports `node:util`, P, T, X and the two C1 modules.
- The helper imports `node:crypto` and `node:util`.

Pin test C2-10 checks this. It also checks the absence of `process`, `node:fs`, `node:http(s)`, net / tls / dns, `fetch`, timers, `console`, `Date`, `NODE_HTTPS_PRIMITIVE`, URLs, booking core and the reservation adapter's name.

Nothing outside the four files changed: C1, P, T, X, F, A, core, workers, lib, DB, config, deps, routes, pins, fixtures and other docs are untouched. **There is still no C3 entrypoint, default fs, env, timer, native network or CLI.**

### 12.1 Clarification A — validation and order
- **Single getter-free snapshot of every input:**
  - `{ argv, deps }` own enumerable DATA, read once.
  - `argv` is copied from its index descriptors only. It must be a genuine `Array` with exact prototype and exactly `n` indices plus `length`, so an own `Symbol.iterator` or any extra key refuses. No iterator, getter or trap runs (tests C2-2: `ran === 0`).
  - `deps` must have the exact per-mode key set: inspect accepts only the five `INSPECT_DEPS` keys; execute accepts the ten `EXECUTE_DEPS` keys.
- **Env snapshot:** `envSnapshot` and its own-data `present` are checked as non-proxy and `Object.isFrozen` BEFORE C1 is relied on. `nodeVersion` is then read by descriptor only. Failure gives `CLI_DEPS_INVALID`.
- **Execute-only deps:** `credentialFs` must be non-proxy with own-data `platform` / `uid` equal to `outputFs`; C1 validates the rest of its shape. `primitive` must be exactly `{ Agent, request }` non-proxy functions. P validates `monotonic` / `timers`.
- **Promises:** only unpatched native promises are observed, via the captured `then` (`callOnce`). A thenable or non-native return is never assimilated, and its rejection is caller-owned (the residual, unchanged from C1 / P).
- **Faults are code-only:** sync throws, introspection faults and unexpected internal faults all become fixed codes. The outer wrapper never rejects; its fallback keeps a truthful `primaryOutcome`, and if P ran, that fallback is exit 9 with no file.
- **Order** (C2-3: every pre-secret refusal leaves `credentialFs` and the primitive untouched):
  1. args;
  2. deps;
  3. env;
  4. source;
  5. plan;
  6. bindings;
  7. output parent;
  8. credentials;
  9. X → T → P.
- **Inspect:**
  - It never constructs T, X or an Agent.
  - Execute deps passed to inspect give `CLI_DEPS_INVALID` (C2-1).
  - `bindings.nodeVersion` is always a boolean, because it has no flag. The other three bindings are `null` when their flag is absent.
- **Pre-run dispositions (fixed shape):**
  - The payload always carries every field. Stages not reached are exactly `null`: `source`, `plan`, `planCode`, `bindings`, `credential`, `requestsAttempted`, `internalCode`, `summary`, `finalize` (C2-3).
  - `runExitCode` is the pre-run code.
  - `summaryFile` is `NOT_ATTEMPTED` and `summaryCloseState` is `NOT_OPENED`. A pre-run refusal never writes a file.
- **Fixed codes added (bounded, listed):**
  - `PLAN_FILE_CODES = PLAN_NOT_JSON, PLAN_TOO_DEEP, PLAN_NOT_CANONICAL` (carried in `planCode` alongside P's own plan codes).
  - `INTERNAL_CODES = P's run codes ∪ PLAN_NOT_VALIDATED, OPTIONS_INVALID, EXCHANGE_OPTIONS_INVALID, PAYLOAD_LIMIT, REDACTION, UNEXPECTED` (carried in `internalCode`; only reachable as a P / T / X setup refusal or an unreachable guard).
  - The CLI vocabulary itself is unchanged: 20 codes.

### 12.2 Clarification B — plan / source bytes
- **Bytes rule** (`ownedBytes`; the same rule in both modules):
  - exact `Uint8Array.prototype`, non-proxy;
  - `%TypedArray%.prototype.buffer` / `length` read through captured getters;
  - not on a `SharedArrayBuffer`;
  - a detached view reports length 0 and is refused by the lower bound;
  - copied once with the captured `%TypedArray%.prototype.set`.

  No shadowed property, iterator or `toJSON` is read. `Buffer`, proxies, shared views, empty arrays and oversize arrays are refused (C2-3, C2-9).
- **Plan pipeline:**
  1. fatal UTF-8 decode (`ignoreBOM:true`, so a BOM is refused);
  2. one `JSON.parse`;
  3. an **iterative** structural bound: depth ≤ 8 and ≤ 16384 nodes. This runs before any recursive code (a 5000-deep array is refused as `PLAN_TOO_DEEP`, C2-3b);
  4. `validateProbePlan(parsed)`;
  5. canonical-file equality against `canonicalJson` of the **validated, frozen plan object without `planHash`**. That is the same content P hashed (`readonly-probe.mjs:180`); there is no second parse or caller snapshot.

  Duplicate keys, extra whitespace, two trailing newlines and non-canonical order are all refused as `PLAN_NOT_CANONICAL`.
- **Digest helper:**
  - the snapshot array is copied from its descriptors once;
  - the fixed 13-path closure is checked exactly;
  - framing and limits follow §11.4 (256 KiB per file, 2 MiB total);
  - it reads no disk and imports none of the listed entries.

  The exact SHA-256 framing vector is recomputed independently in the test. A single byte change in `compensation-proof.js`, `package.json` or the placeholder changes the digest, and moving a byte between adjacent entries does too (C2-9).
- **The entrypoint entry is a SYNTHETIC placeholder in tests; no real enforcement exists today.**

### 12.3 Clarification C — interrupt lifecycle (exact boundary)
**Before P is invoked**, `interrupt` is re-checked natively (captured `AbortSignal.prototype.aborted` getter) at these points:
- before the stages;
- after env;
- immediately after EVERY injected call returns synchronously, and again after it settles (plan reader, each output-fs call, C1);
- after C1 settles;
- after X / T construction, immediately before `runReadonlyProbes`.

An abort at any of these gives `CLI_INTERRUPTED` (exit 7):
- the capability reference is dropped;
- C1 has always closed its handle by then (C1 is awaited, never abandoned);
- no X Agent or request is created;
- no file is written.

Tests C2-6 cover: already aborted; aborted inside the plan reader; aborted inside the `.git` walk; aborted inside the C1 open (C1 still closes once, credential reported `CRED_OK` / `CLOSED`, zero primitive use).

**Once P is invoked**, C2 performs no more interrupt checks that could replace the run:
- the abort is P's `signal`;
- `result` and `finalize()` are always awaited;
- the credentials are dropped afterwards (`creds = null`, so a late T `credential()` call gets `null`);
- P's real summary and cause (`PROBE_CANCELLED`) are reported;
- `interruptObserved: true` is set;
- the ONE prescribed evidence write is performed.

An aborted signal does not prohibit that write (C2-6: abort during the first request gives `PROBE_CANCELLED`, `CLOSED_ACK`, one request).

**During output IO** an interrupt does not stop the single prescribed write: every operation in it belongs to that one write, and no new or extra operation is ever started. If an operation faults, no further write / sync is started, and close is invoked once after the started operations settled.

C1 / plan / output IO may hang; there is no elapsed guarantee and no preemption claim. Only the CLOSED entrypoint's second SIGINT would end the process.

The returned disposition is deep-frozen; late callbacks cannot alter it. C2 registers no signal and performs no stdout or process action.

### 12.4 Clarification D — output ownership and payload
- **Create:** `create(target, 'summary-create')` is called once.
  - `EEXIST` (own-data code) gives `RACE_EXISTS` / `NOT_OPENED`.
  - Any other rejection, or a non-native / thenable reply, gives `UNKNOWN` / `NOT_OPENED`.
- **On a native create fulfilment:**
  - close is captured FIRST (own-data, non-proxy function), including on a malformed but closable handle;
  - the shape is then checked as exactly `{ close, sync, write }`;
  - writes must report positive in-range counts (`0`, `1.5` and `len + 1` give `UNKNOWN`);
  - `sync` and `close` must each fulfil with exactly `undefined`;
  - close is invoked once, after the started write / sync settled, and never retried.
- **Results:** `CLOSE_FAILED` / `UNCLOSABLE` / malformed / partial give `UNKNOWN`, with `summaryCloseState` reported separately; acknowledged writes give `CLOSED_ACK`. There is never an overwrite, unlink, rename, repair, retry or second create (C2-7: one create and at most one close in each case).
- The output parent / identity rules are applied as in §11.6 against the supplied fake adapter only.
- **Payload** — fixed before any output:
  - `schema, mode, primaryOutcome, runExitCode, tailUncertain, interruptObserved, preflight, source:{ sourceDigest, matches }, planCode, plan, bindings, credential, requestsAttempted, internalCode, summary, finalize`.
  - **Deviation from §11.7 (additive):** `sourceDigest` is nested in `source`, and `planCode`, `bindings`, `internalCode` and `interruptObserved` were added so pre-run results stay exact.
- **File** = `canonicalJson(payload) + "\n"`, ≤ 65536 bytes including the newline.
- **Stdout envelope** = `{ schema:'e7-probe-cli-stdout-v1', payload | null, output:{ summaryFile, summaryCloseState }, exitCode, primaryOutcome, tailUncertain }`, with its own cap of `MAX_STDOUT_BYTES = 131072`. It carries `primaryOutcome` / `tailUncertain` outside the payload, so the fixed `payload:null` fallback stays truthful.
  - It reports the LATER file outcome.
  - The file never contains `summaryFile` (asserted in C2-4).
  - Stdout cannot claim its own delivery.
  - File bytes equal `canonicalJson(envelope.payload)+"\n"` (C2-4).
- **Redaction** runs before writing and checks BOTH every key and every string value:
  - keys ∈ C2 keys ∪ P summary keys ∪ `T_ERROR_CODES`;
  - values ∈ P `VOCABULARY` ∪ `T_ERROR_CODES` ∪ ENV / CRED / CLOSE / CLI / file-state / plan / internal codes ∪ schemas ∪ modes ∪ the dynamic `planHash` / `sourceDigest` / four metadata labels.

  A violation or oversize payload gives no file and `payload:null`, with primary kept. Sentinel tests check that tokens, keys, paths, plan ids, account / PI ids, guest sentinels and raw error messages appear in neither stdout nor file.
- **Successful credential load** is reported as `{ code:'CRED_OK', closeState:'CLOSED' }`. The capability is never serialized.
- **`exitFor`** is the single precedence function (table-tested in C2-8): run → 9 > 8 > 6 > 11 > 0; no run → fixed pre-run codes. `null` for the output fact gives the payload's `runExitCode`. The entrypoint alone would apply 130 and stdout failure → 9.

### 12.5 Clarification E — coverage
Eleven fake-only tests (C2-1…C2-10, with 3b). The fakes are a labelled copy of the accepted rehearsal https primitive and fake clock (no sleeps). The `node:https` request / Agent guards are installed before X loads, and they, the `fetch` guard and `unhandledRejection` all count 0.

Coverage:
- inspect / default;
- pre-secret refusals;
- both, Hostaway-only and Stripe-only C1 → X → T → P runs;
- P STOP vs INCONCLUSIVE continuation;
- interrupts at the final handoffs;
- output acknowledgment / race / partial / close faults;
- tail / precedence;
- digest framing vectors;
- redaction and pins.

**Not manufactured (labelled):**
- An `UNSETTLED` transport tail is not reachable through accepted X with these fakes: X settles promptly when P aborts it, so P observes `LATE_*`. Tail uncertainty is exercised through P's accepted `timerCleanup.uncancellable` (a timer handle without a callable cancel). P's own suite covers `UNSETTLED` / `UNOBSERVABLE`.
- The counted-request guard is unreachable through accepted P.
- The write-call bound is unreachable under positive progress.

### 12.6 Validation (FIRST FULL TAP preserved)
- **Focused FIRST FULL TAP:** **10 / 11**. C2-8 expected exit 8 but got 6. Cause (test design): the "held" fake request was still observed by P as a `LATE_*` tail, because accepted X settles on abort.
  - Run 2, with the held request also ignoring `destroy`: still 10 / 11, for the same reason. X does not wait for the destroy, so the fixture assumption was wrong.
  - Run 3, with tail uncertainty driven through P's `uncancellable` cleanup report as in §12.5: **11 / 11**.
  - The module did not change between runs.
- **Optional probes** (temporarily applied, then reverted; module byte-identical afterwards):
  - M2 (sync accepts any value): killed (2 failures).
  - M3 (canonical-file check removed): killed (1).
  - M1 (the interrupt check right after C1 removed): survived. This is EQUIVALENT: the next check, immediately before dispatch, catches the same abort with the same result (capability dropped, exit 7, zero primitive use). It is labelled defense-in-depth, not a coverage gap.
- **Units** (`e7-connected-*`, `hostaway-reservations`, `e4-connected-path`): **219 / 219**.
- **First full `npm test`:** **884 / 884**.
- No DB, install or network.

### 12.7 Remaining C3 prerequisites (not readiness; nothing below is authorized)
- **Real adapters**, built only with `O_NOFOLLOW`:
  - the credential `credential-read` adapter;
  - the plan reader;
  - the `summary-create` `O_EXCL` output adapter;
  - real stat-record mapping from bigint stats.
- **Snapshot and bootstrap:**
  - an env snapshot builder that records only presence booleans and the `execArgv` count;
  - the pre-import source-digest bootstrap over the 13-file closure, which needs the entrypoint file itself.
- **Process ownership:** SIGINT (first → abort `interrupt`; second → exit 130, nothing promised flushed), the single stdout write, and stdout failure → 9.
- **Preparation:** a canonical plan-file preparation step.
- **Evidence, inputs and approval:**
  - native evidence on the owner's exact platform / Node;
  - owner inputs, all UNSET;
  - ONE consolidated exact approval package (§6) and Joel's explicit approval.

Live gates, env, credentials and the package stay CLOSED.
