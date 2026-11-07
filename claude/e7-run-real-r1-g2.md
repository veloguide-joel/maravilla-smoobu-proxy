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
| **G2b** | the R1 journal identity / hash domain, the R1-only `RUN_STARTED` shape, and the thin `runReservationAbortR1` with G fences, plus its disposable-PG lifecycle matrix | **NOT in this commit**; §6 lists exactly what remains |

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

## 7. Limits

Unchanged: no G3, no credentials, no runner / dirs (owner-parked), shared 0017 unapplied, no real provider traffic, Run1's truncated session id unguessed. Real Hostaway writes stay outside any current send authority: the owner clarification only informs the future reviewed package.
