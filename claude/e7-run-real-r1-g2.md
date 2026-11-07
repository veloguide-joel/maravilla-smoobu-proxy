# E7 M2-G2 — binding-seam extraction + thin R1 consumer (OFFLINE, LOCAL) — contract and exact change map

Root ruling 0386f3a0 authorizes M2-G2 for LOCAL OFFLINE implementation from e7-test `913f96258eb9ea6797ee0a60e5f2474408b2be6f`.

**Not authorized:**
- G3 (entrypoint, credential ingress, activation);
- remote publication;
- any real provider or shared-DB use.

The work is to produce a reviewable exact diff, not acceptance. The ruling also lets the work stop at a clean mechanical extraction commit, with the remaining consumer work reported precisely. This file states which part each commit delivers.

**Owner clarification (verbatim, recorded separately in the ledger):** "Remember all listings in Hostaway are test listings. It has no impact on our business if they are booked".
- It feeds the EVENTUAL single bounded reviewed test booking + cancel package.
- It grants nothing in this local slice: no provider send, no bulk or arbitrary writes, no adoption, no change to protected or historical rows.

## 0. Delivery plan

| part | content | status in this branch |
|---|---|---|
| **G2a** | mechanical binding-seam extraction in the four v2 modules; v2 public entrypoints and behaviour byte-identical; parity harness against the immutable pre-extraction tree; unchanged synthetic suites (mechanical source pins only) | **this commit** |
| **G2b** | the R1 journal identity / hash domain, the R1-only `RUN_STARTED` shape, and the thin `runReservationAbortR1` with G fences, plus its disposable-PG lifecycle matrix | delivered on `feature/e7-run-real-r1-g2b` from e7-test `85cf7b11` (root beb979e7); §8–§12 |

## 1. The seam: module-branded bindings (G2a)

**Why a brand.** Every v2 module today re-binds by calling `bindManifestV2(manifest)`, which accepts synthetic v2 manifests only. A future R1 consumer must hand the same accepted flow a binding that did NOT come from a v2 manifest. It must do so without:
- a publicly forgeable `…ForBinding(binding)` export;
- letting a caller-made binding-shaped object, or a version string, act as authority.

**`run-journal-memory-v2.mjs` owns a module-private `WeakSet` (BOUND).**
- `bindManifestV2` adds its frozen binding to BOUND before returning. The return value is otherwise unchanged.
- Only binders INSIDE this module can add to BOUND. In G2a that is `bindManifestV2` alone; G2b adds an R1 binder that re-derives through `bindRunPackageR1`.
- New exports accept ONLY a BOUND binding, and refuse anything else with `BINDING_UNVERIFIED`, before any other check:
  - `isBoundBindingV2(b)` → boolean;
  - `validateRecordBound(record, binding)`;
  - `validateJournalBound(records, binding, opts?)`;
  - `journalFactsBound(records, binding, opts?)`;
  - `evaluateStartBound(readResult, binding, opts?)`.
- **Forgery.** A deep copy, a spread, a `JSON` round-trip or a hand-built object with identical fields is NOT in BOUND and is refused (tested). A binding is never re-derived from a version string.
- The existing exports (`validateRecordV2`, `validateJournalV2`, `journalFactsV2`, `evaluateStartV2`, `createMemoryJournalV2`) are now "bind the manifest, then call the same internal function". Their results are byte-identical (parity harness §4).

**`run-journal-file-v2.mjs`.**
- `openFileJournalV2` / `readJournalForRecoveryV2` keep their exact inputs and outputs.
- Internally they call the Bound validators with the binding they derived from the manifest, instead of re-binding the manifest on every record. The verdicts are identical because it is the same binding values.
- No new export in G2a.

**`run-test-abort.mjs`.**
- `runTestAbortBridge({ manifest, … })` is unchanged.
- New `runTestAbortBridgeBound({ binding, operator, journal, trustedHead, pool, env, guard, now, operatorDeps? })` takes a BOUND binding instead of a manifest; anything else → `REFUSED_BEFORE_START` / `BINDING_UNVERIFIED`.
- Both run ONE internal body. The journal read is anchored through `journalFactsBound`.
- The accepted operator core is called exactly as before, at most once.

**`run-core-abort-v2.mjs`.**
- `runAbortRehearsalV2(input)` is unchanged externally: options snapshot → `bindManifestV2` → the synthetic-only gate (`PHASE_PLAN_UNSUPPORTED`) → a NON-exported `runAbortFlowV2(o, B)` holding the previous body verbatim.
- The flow's journal calls use the Bound validators with `B`, and its bridge call uses `runTestAbortBridgeBound({ binding: B, … })`. Same binding values, so the same behaviour.
- No flow is exported, and no hook parameter exists. A future R1 consumer lives in THIS module, as a sibling wrapper selecting fixed R1 fences by the binding's kind. It is not a caller-supplied hook.

**No other module changes.** Workers, helpers, reducers, migrations, access control, planners, the G1 binder / preflight logic, transports and guards are unchanged.

The one exception is mechanical: G1's `COPIED_ORIGINS` pins `run-core-abort-v2.mjs` and `run-test-abort.mjs` by SHA-256, so those two pins are updated (§5).

## 2. What G2a guarantees

- The synthetic-only gates stay where they were: `validateRunManifestV2` `REAL_RUN_NOT_IN_THIS_SLICE` / `PROVIDER_MODE_NOT_IN_THIS_SLICE`, and core `PHASE_PLAN_UNSUPPORTED`.
- Unchanged: canonical v2 records, the v2 record hash domain `"e7-run-journal-v2\n"`, trusted-head semantics, start rules (EMPTY only), no-resume and no-adoption rules, ACK / tail / receipt classification and result objects.
- Nothing in G2a can bind a non-synthetic input. BOUND contains only v2-manifest bindings.

## 3. Closure / pin impact (explicit)

**Closure lists.**
- No new module file, so `RUN_PLAN_CLOSURE` (48 paths) and `R1_EXECUTOR_CLOSURE` (30 paths) are unchanged as lists.
- The foundation closure contains the four changed modules, so the foundation `sourceDigestV1` changes. The new value is recomputed and reported, never asserted from the old one.
- `R1_EXECUTOR_CLOSURE` contains none of the four extracted modules, but it does contain `run-preflight-r1.mjs`, whose two pin strings change (§5). So the G1 executor digest changes too; it is recomputed and reported.
- No module embeds a digest.

## 4. Parity harness (G2a)

**Setup.** `test/e7-connected-run-binding-seam-g2a.test.mjs` materializes the IMMUTABLE pre-extraction tree with `git archive 913f9625…` into a temp dir, then imports the old and new modules side by side.

**What it compares, byte for byte:**
- every journal export over a generated corpus (both checkpoint modes, valid / torn / tampered / reordered / cross-mode / wrong-identity / trusted-head match and mismatch, the abort records);
- `createMemoryJournalV2` append / read / ACK and fault sequences (reject / hang / late / landed-hang);
- the bridge's synchronous pre-start refusals.

**Discrimination controls.** The same harness is run against deliberately mutated copies of the OLD tree:
- the hash prefix changed;
- an ACK rule changed;
- a torn-tail rule changed.

It must report each mismatch, so the harness is shown to detect domain / ACK / tail drift.

**DB behaviour of the bridge / core.** Covered by the UNCHANGED accepted disposable-PG suites (M2-C bridge, M2-D core, M2-E file journal). Only their mechanical source pins are updated (§5); no behavioural assertion is changed.

## 5. Mechanical pin updates (reason: the extraction changes these files' bytes; values / behaviour unchanged)

| test or module | pinned file | reason |
|---|---|---|
| `test/e7-connected-run-journal-file-v2.test.mjs` PINS | run-journal-memory-v2, run-core-abort-v2, run-test-abort | the bytes changed by the G2a extraction |
| `test/db/e7-run-core-abort-v2.test.mjs` PINS | run-journal-memory-v2, run-test-abort | same |
| `scripts/e7-connected/run-preflight-r1.mjs` `COPIED_ORIGINS` | run-core-abort-v2, run-test-abort | the copied VALUES (P0 / phase budgets, BRIDGE_LIMITS) are unchanged and still asserted by G1 parity test P0 against the live modules |

## 6. G2b — remaining consumer work (NOT done here; for a later reviewed commit)

1. **R1 journal identity and domain.**
   - An R1 binder inside `run-journal-memory-v2.mjs` re-derives through `bindRunPackageR1`, so no caller binding is ever accepted.
   - Records use `manifestVersion = "e7-run-package-r1"`, `manifestHash = packageHash` and hash domain `"e7-run-journal-r1\n"`. The field check accepts each version only with a matching BOUND binding.
   - Mixed versions, relabelled history and mismatched hashes refuse.
   - The R1-only `RUN_STARTED` shape is `{ preflightDigest, executorDigest }`.
   - File-journal R1 entrypoints, plus a head-line domain for R1.
2. **`runReservationAbortR1` in `run-core-abort-v2.mjs`.**
   - P0 takes the SAME accepted run lock, then same-DB, then the empty-journal rule, then a FRESH G1 preflight (re-derived at a fresh business clock; no stale verdict adopted), then `RUN_STARTED`.
   - One intent; a one-listing `Map`; an explicit reviewed env object; injected transports only.
3. **G fences** after every awaited boundary:
   - the acquire handoff, every attestation or wait, the preflight;
   - before `STEP_STARTED` and again before the actual worker start;
   - the bridge start / operator boundary (M8 facade) and the cleanup gate;
   - a fresh `loadIntent` authorization / `captureBefore` margin before any reservation step;
   - cleanup and reconciliation READS never blocked by expiry, and no presumption that a void is safe.
4. **Diagnostics.** A post-cleanup exclusion re-read reports equal / changed / unread. Changed or unread is never "fully clean".
5. **Disposable-PG R1 lifecycle matrix through the accepted transports + fake exchange.** Each item below is a required case:
   - both checkpoint modes; decoys; zero-action baselines;
   - tampered package / closure; stale authorization / quote;
   - stops at each awaited boundary, including post-attestation and the start ACK;
   - preflight / account / proof failures;
   - unknown create → reads only;
   - unknown cancel / void → accepted owner case;
   - ACK / receipt loss / rejection / hang / late / landed;
   - cleanup under expiry; release + LOCAL 0017 claim;
   - changed / unread exclusion re-read;
   - exact scoped send counts, and zero capture / refund / record / notify.

## 7. Limits (G2a)

Unchanged: no G3, no credentials, no runner / dirs (owner-parked), shared 0017 unapplied, no real provider traffic, Run1's truncated session id unguessed. Real Hostaway writes stay outside any current send authority: the owner clarification only informs the future reviewed package.

## 8. G2b — what was built (root beb979e7; LOCAL OFFLINE; base e7-test `85cf7b11452c0c27d6113b0b1573e8a140cd1f2d`)

§6 is the specification. This section records how each item was met, and the exact deviations.

### 8.1 R1 brand, identity and hash domain (`run-journal-memory-v2.mjs`)

- `bindRunPackageR1Journal(r1Input, execClock)` is the ONLY R1 binder.
  - It takes a getter-free, Proxy-refusing snapshot of exactly `{ packageBytes, planBytes, foundationSources, executorSources, envSnapshot, expected }`.
  - It calls the accepted, unchanged `bindRunPackageR1({ ...input, execClock })`.
  - On success it builds a frozen binding with the v2 binding SHAPE (`identity`, `checkpoints`, `phases`, `facts`, `manifest`), plus `r1` evidence (`packageHash`, `foundationDigest`, `executorDigest`, `execClock`, `evaluatedAt`, `paymentIntentId`, `exclusions`).
  - That binding is added to the module-private `BOUND` set, and a module-private `KIND` WeakMap records `"r1"` for it. `bindManifestV2` now records `"v2"`; nothing else changes there.
  - A binder refusal returns `{ ok:false, code:'R1_BINDING_INVALID', binderCode }`.
- **The kind is never read from caller data.** `bindingKindV2(b)` returns `KIND.get(b)` for a BOUND object, and `null` for everything else. Spread, JSON copies, `Object.create(b)` and hand-built objects all give `null` (test J1).
- `binding.manifest` for R1 is a **scope view**, `kind: "r1-scope"`, containing exactly the fields the shared flow reads. It has no `synthetic` or `providerMode` field, so the v2 synthetic gate can never be satisfied or bypassed by it.
- **Record rules are selected by the BINDING's kind** in `fieldCheck(r, kind)` / `bindingCheck`.
  - Kind `v2` keeps the old rule exactly: `RUN_MANIFEST_V2_VERSION`, empty `RUN_STARTED`.
  - Kind `r1` requires `manifestVersion = "e7-run-package-r1"`, and `RUN_STARTED` with keys exactly `{ preflightDigest, executorDigest }` (hex64). `executorDigest` must equal the binding's verified digest.
  - Identity equality (`manifestHash = packageHash`, runId, intent, connection, baseline commit) is unchanged.
  - Every other event shape is shared, so the accepted ABORT / STEP / terminal rules apply unchanged.
- **Hash domain.** `recordHashV2(record)` hashes a record whose `manifestVersion` is the R1 identity version under `"e7-run-journal-r1\n"`. Every other record is hashed exactly as before, under `"e7-run-journal-v2\n"`.
  - Mixed, relabelled and cross-mode chains refuse in both directions: a field / identity / chain mismatch (J2).
  - Only an EMPTY journal starts (J3; DB G3 `RESTART_AMBIGUOUS`, malformed preload).
- `createMemoryJournalBound({ binding, preload?, faults? })` is the same memory journal body for a BOUND binding. `createMemoryJournalV2` still binds its manifest and then runs that same body.

### 8.2 R1 file journal (`run-journal-file-v2.mjs`)

- **One implementation.** The previous `openFileJournalV2` / `readJournalForRecoveryV2` bodies became `openBound(o, binding, FORMAT)` / `recoverBound(o, binding, FORMAT, out)`. `FORMAT.v2` holds EXACTLY the old constants (names, head `v: 2`, report version).
- **New entrypoints.** `openFileJournalR1({ journalDir, headDir, binding, fsAdapter? })` and `readJournalForRecoveryR1({ journalDir, headDir, binding, trustedHead?, fsAdapter? })`.
  - They accept only a binding whose kind is `"r1"`; anything else gets `BINDING_UNVERIFIED`, before any fs effect.
  - File names: `e7-journal-r1-<runId>.jsonl` and `e7-head-r1-<runId>.jsonl`. Head lines use `v: "r1"`. The report version is `e7-run-journal-file-r1`.
- **Mechanics reused unchanged:** creation only (O_EXCL), dual exclusive nonce locks, journal fsync then head fsync before the ACK, directory fsyncs, identity re-verification, poison on ambiguity, no reopen / repair. Recovery is diagnostics only, and its permission is always all-false.
- **Relabel refusals** (J5):
  - R1 files renamed to v2 names → the v2 reader reports `HEAD_IDENTITY_MISMATCH`.
  - v2 files renamed to R1 names → the R1 reader reports `HEAD_IDENTITY_MISMATCH`.
  - A v2 record inside an R1 journal file → `JOURNAL_INVALID` / `HASH_MISMATCH`.

### 8.3 `runReservationAbortR1` (`run-core-abort-v2.mjs`)

- **Options.** The v2 option keys with `manifest` replaced by `r1` (the reviewed binder input, never a binding).
- **Wrapper steps.** A getter-free snapshot, then a FRESH business clock, then `bindRunPackageR1Journal`. It then checks kind `"r1"` and the exact phase plan, and calls the SAME private `runAbortFlowV2(o, B)`.
- **What is refused.** No manifest, no hook, no export of the flow, and no fallback to v1 or the synthetic path. A copied binding, a binding passed as input, or a PASS verdict object is refused `R1_INPUT_INVALID` / `OPTIONS_INVALID` (DB G2).
- **R1 behaviour in the flow** is selected by `bindingKindV2(B) === "r1"`; with kind v2 every branch is skipped:
  1. **P0 order:** SAME accepted lock, then same DB, then the empty-journal rule, then the eligibility snapshot, then a FRESH `runPreflightR1`. The preflight gets the run's own pools, guard, `blocked()` and business clock, with the injected transports re-wrapped as `{ send }` forwarders.
     - It must return `PREFLIGHT_OK` with `packageHash` / `executorDigest` equal to the binding's; otherwise the run is refused `PREFLIGHT_<code>` / `PREFLIGHT_BINDING_MISMATCH`.
     - Then ONE `loadIntent` checks the exact scope identity and records the DB price basis (`canonicalJson(price_snapshot)`).
     - Then the R1 `RUN_STARTED { preflightDigest, executorDigest }`.
  2. **Post-attestation fence.** After the (unbounded) baseline attestation, the FULL accepted preflight runs again: fresh account, PI proof, H3 / H4 / H5 quote, H1 empty ref lookup, exclusion baseline and margin. Its `baselineDigest` must equal P0's, else `EXCLUSION_BASELINE_CHANGED`.
  3. **DB fence** (`fenceR1`) before EVERY reservation / cleanup `STEP_STARTED` and before the bridge. It is a fresh `loadIntent` on a fresh app client, which must show:
     - the same version and state as the step's basis snapshot (`FACTS_MOVED`);
     - the exact identity, PI (test mode), amount / currency / rate, and the price snapshot equal to the P0 basis (`INTENT_IDENTITY_MISMATCH` / `PAYMENT_STATE_INVALID` / `QUOTE_CHANGED`);
     - for reservation steps only, the strict margin: `min(captureBefore, authorizationDeadline) − now > stepBudget + STEP_MARGIN + R1_AFTER_RESERVATION_BUDGET_MS`. That last term is the accepted preflight budget minus P0, its journal and the reservation phase, = 1 020 000 ms. Using `min(captureBefore, authorizationDeadline)` means policy caps never extend Stripe's own expiry.
  4. **Actual worker start.** After `STEP_STARTED` and the existing R-E1b `blocked()` check, the reservation margin is re-checked at a fresh clock, immediately before the worker is invoked. The M8 facade (the bridge's guarded start) is unchanged and still re-checks stop / signal / lock at the operator start.
  5. **Expiry.** Cleanup and the TEST abort are NOT blocked by expiry: their fence is identity-only. Expiry at cleanup entry is recorded in `r1.expiredAtCleanup`, and is never treated as harmless. Every send stays inside the accepted workers' and bridge's own proof / state / idempotency fences (DB G8).
  6. **Exclusion re-read.** After the release proof, and also after the void-only route, the exclusion baseline is re-read in ONE RR READ ONLY transaction on a fresh report client, giving `equal` / `changed` / `unread`. It is diagnostic only. `r1.fullyClean` is true only for `ENDED` and `equal`; `changed` / `unread` keep the accepted `ENDED_RELEASED` record but are never fully clean (DB G9).
- **Unchanged:** attempt discipline, ACK / tail rules, the conservative key, counts, as-of and the release rule are the accepted flow's own. The R1 result adds `r1: { kind, packageHash, executorDigest, preflight, refence, fences, expiredAtCleanup, exclusionAfter, fullyClean }`, and v2 results have no `r1` key.

### 8.4 Closures, pins, overlap

- **Foundation closure.** `RUN_PLAN_CLOSURE` goes from 48 to 50 paths, adding `scripts/e7-connected/run-binding-r1.mjs` and `scripts/e7-connected/run-preflight-r1.mjs`.
  - Reason: the journal now imports the binder, and the core imports the preflight. M2-F T2 rescans the accepted roots and passes with the new list.
  - The foundation digest is recomputed (§11).
- **`R1_EXECUTOR_CLOSURE`.** The list is unchanged (30 paths), because the G1 binder / preflight import graph is unchanged. Its digest changes only because `run-preflight-r1.mjs` changes its two origin pins.
- **Overlap.** Every executor path is now also a foundation path. The binder's existing overlap rule (same bytes in both snapshots) therefore covers every executor file. G1 test B4's "non-overlapping executor file" step no longer has a subject and is replaced (§9).
- **Origin pins.** `run-preflight-r1.mjs` `COPIED_ORIGINS` updates the `run-core-abort-v2.mjs` pin. The copied VALUES (P0 / phase budgets, WRITE_TYPES, eligibility) are unchanged and still asserted by G1 P0 against the live module. `run-test-abort.mjs` is byte-unchanged in G2b.
- **No other runtime file changes:** workers, helpers, reducers, migrations, access control, transports, guard, facts, the planner logic, and the G1 binder / preflight logic.

### 8.5 Root review of cc5e6cf: who owns the client during the exclusion re-read

**Gap (reproduced).** In cc5e6cf, `exclusionRereadR1` mapped every failed `statement()` result to `{ ok:false }` and then ran `COMMIT` anyway. If that COMMIT succeeded, it RELEASED the client for reuse — even though a baseline statement had been rejected or had timed out and might still be running.

Disposable-PG regression G11.1–G11.4, run against cc5e6cf, observed `[BEGIN, F0…, COMMIT]` followed by a release.

**Fix.** The fix is confined to that one function. Its local runner now gives each statement an explicit disposition:
- The FIRST operation that is not a success — rejected, timed out, not started (stop), or a lost client, at BEGIN, in the baseline, or at COMMIT — destroys the client ONCE through its tracker. No further SQL is issued: no COMMIT, no ROLLBACK.
- A lost client is detected BEFORE the next statement would be issued.
- The client is released for reuse ONLY after a successful COMMIT.
- An ACKNOWLEDGED refusal from the accepted reader, where every statement settled (cap / malformed rows / run-intent reference), closes its read-only transaction with COMMIT and is then released.
- A timeout or guard fault records `uncertainty: "statement_may_still_run"`.

**Reporting.** The result gains `r1.exclusionRead = { at, code, disposition, uncertainty }`. `exclusionAfter` stays `unread` and `fullyClean` stays false on any failure.

**Unchanged.** The booking outcome — release proof, legs, claim, ENDED_RELEASED — is never changed by the diagnostic read. DB-family marking is not applied, because the read is read-only and has no booking effect. v2 behaviour is unchanged. The accepted guard, workers, helpers and migrations are untouched.

**Evidence (G11, real disposable PG).** Each case records per-client SQL and release / destroy events.

| case | SQL issued | expected disposition / result |
|---|---|---|
| (1) baseline reject | `[BEGIN, F0]` | exactly one `release(true)`, no `release()`; unread, not fully clean |
| (2) baseline hang | `[BEGIN, F0..F3]` | timeout; same disposition; `statement_may_still_run` |
| (3) baseline late | same as hang | same as hang |
| (4) backend terminated mid-transaction | nothing after the loss | tracker's single destroy |
| (5) signal stop mid-transaction | nothing after the stop | destroyed; run STOPPED, booking proof kept |
| (6) BEGIN reject | `[BEGIN]` | destroyed |
| (7) COMMIT hang | `[BEGIN, every family, COMMIT]` | destroyed, uncertain, unread |
| CONTROL (8) healthy | `[BEGIN, every family, COMMIT]` | `release()` once, equal, fully clean |
| CONTROL (9) acknowledged refusal | `[BEGIN, F0, COMMIT]` | `release()` once, unread |

In every case the booking outcome, claims and legs are kept and nothing is resent.

**Failing-before against cc5e6cf** (TAP retained):
- 1–4 fail on the SQL assertion: COMMIT is issued after the failure, then the client is released.
- 5–7 already showed correct SQL and disposition in cc5e6cf, and fail there only on the new diagnostic field.
- The controls fail there only on the new diagnostic field.

## 9. Changed test assertions (each explained)

| test | assertion | change and reason |
|---|---|---|
| `e7-connected-run-binding-seam-g2a` S2 | export-name equality with the 913f9625 core | now old names + EXACTLY `R1_AFTER_RESERVATION_BUDGET_MS`, `runReservationAbortR1` (intended R1 exports) |
| same S2 | changed runtime files vs 913f9625 | + `run-plan-v1.mjs` (closure list only) and the R1 code in the three journal / core modules; the preflight diff is still exactly its origin-pin lines |
| same, S1 / P1–P3 | OLD-vs-NEW v2 behavioural parity + discrimination controls | **UNCHANGED** (passes on the G2b tree: v2 bytes / hashes / ACK / tail identical) |
| `e7-connected-run-journal-v2` J11 | exact import list of the journal | + `./run-binding-r1.mjs` (the R1 binder is re-derived inside the journal) |
| `e7-connected-run-journal-file-v2` U11 | PINS | PINS for `run-journal-memory-v2` / `run-core-abort-v2` (bytes changed by G2b); the import-specifier list is unchanged |
| `test/db/e7-run-core-abort-v2` M7 | PINS | `run-journal-memory-v2` pin (bytes changed by G2b) |
| `test/db/e7-run-preflight-r1` P0 | `COPIED_ORIGINS` pin check | reads the module's own updated pin; parity of the copied VALUES unchanged |
| `e7-connected-run-binding-r1` B4 | "tamper a non-overlapping executor file" | no executor path is non-overlapping any more (§8.4). It now asserts executor ⊆ foundation, and that (a) a wrong executor pin → `R1_EXECUTOR_DIGEST_MISMATCH`, (b) an executor file tampered in BOTH snapshots with a re-pinned executor digest → `R1_RECOMPUTE_REFUSED` |

## 10. Evidence map (tests)

- `test/e7-connected-run-journal-r1-g2b.test.mjs`:
  - J1 brand / forgery / binder refusals;
  - J2 shape / identity / domains / relabel / mixed / cross-mode;
  - J3 start rule;
  - J4 bound memory journal;
  - J5 R1 file journal round-trip, recovery with no authority, relabel / mixed refusals.
- `test/db/e7-run-reservation-abort-r1.test.mjs` (disposable PG, the accepted T transports over the FAKE exchange, real workers, LOCAL 0017):
  - G1 both modes + decoys + stand-ins;
  - G2 tampered / stale / unbound / closure / pin / option refusals with zero starts;
  - G3 P0 preflight / account / proof / quote / margin / journal / intent refusals;
  - G4 changes after attestation and before the worker (post-attest preflight, DB fence, actual-start clock);
  - G5 lock / signal at the preflight start, at the attestation, and at the start ACK (M8);
  - G6 unknown create / host-cancel / void;
  - G7 start / receipt ACK reject / hang / late / landed / lost;
  - G8 expiry during cleanup;
  - G9 changed / unread re-read, and the void-only route;
  - G10 R1 file journal under the real consumer.
- Retained accepted suites: G2a parity, journal v2, file journal v2, planner, binder, bridge unit, manifest v2; DB M2-D core, M2-E file journal, G1 preflight, M2-C bridge.

## 11. Pins (recomputed on the G2b tree; never asserted from old values)

| pin | starting value (G2a, 85cf7b11) | G2b value |
|---|---|---|
| foundation `sourceDigestV1` (`RUN_PLAN_CLOSURE`) | `5d3fa10178f27930e816421106d34925976f68bfdf440d1e4f8b7f3720159ed1` (48 paths) | cc5e6cf: `b783c947…5ec8` → after the §8.5 fix: `cdb00be067b06ea7ed94faf645fad65317d66b297400315c5f6cbf8c4cc703e1` (50 paths) |
| G1 `executorDigestR1` (`R1_EXECUTOR_CLOSURE`) | `a1329f7d6ec45b1323395cc25ff28d08943931dbc5d8a0e5ce1a4183d305377c` (30 paths) | cc5e6cf: `6935b507…aca0` → after the §8.5 fix: `897d369f24d18ffce446a318d6eff82b8215ea8fb3921b95dffecea90bf11ea7` (30 paths) |

The cc5e6cf values no longer apply: the §8.5 fix changed `run-core-abort-v2.mjs` and therefore the preflight's core origin pin.

Changed runtime files: SHA-256 values are in the bundle `PINS.txt`, computed on the commit tree. No module embeds either digest (G1 B4 "no self-hash" retained).

## 12. Limits (G2b)

No G3, no entrypoint / CLI, no credentials, no runner / dirs (owner-parked), shared 0017 unapplied, no shared DB, no real provider request, no push / PR / merge.
The owner test-inventory clarification informs only the future single reviewed package.
