# E7 local connected-test RUNNER — CONTRACT, revision 9 (Slices A–E ACCEPTED offline; next: file-journal contract, DOCS ONLY)

**Branch** `feature/e7-connected-run-core`, cut from exact `ea830a62` (revision 8, root DESIGN ACCEPTED). Slice E changes exactly three files: new `scripts/e7-connected/run-core.mjs`, new `test/db/e7-connected-runner.test.mjs`, and this contract (status + §13). Revision 8 (`feature/e7-connected-core-contract`, from `d5a93e0f`) was docs only.

**Provenance:**
- Revision 1 `36a6da15`: root DESIGN HOLD R-R1 to R-R4.
- Revision 2 `08b107e4`: root DESIGN RE-REVIEW accepted R-R1 (input map) and R-R2 (no resume) as the basis for Slice A, and left the async / interface questions open.
- Revision 3 + Slice A `cc5d877d`: root CODE REVIEW **ACCEPTED** offline Slice A (`scripts/e7-connected/run-manifest.mjs`, `test/e7-connected-run-manifest.test.mjs`).
  - Root independently ran the focused suite 11/11 against the exact repository modules, with no stubs and no DB.
  - Root verified that the same frozen snapshot is validated, hashed and returned.
  - `npm test` 749/749 is **CLAUDE-RUN**, not root-run.
  - No provider or live readiness is implied.
- Revision 4 `49df87b0` turned the former OPEN items A–D into one lifecycle design. Root DESIGN REVIEW **ACCEPTED** it for the bounded Slice B, with binding clarifications 1–6.
- Revision 5 recorded the implemented Slice B. Root CODE REVIEW **HOLD** on `74e8f509` (R-B1–R-B3) was corrected at `86acc274`. Root CODE RE-REVIEW **ACCEPTED** offline Slice B at `86acc274`: root ran 31/31 focused tests and reran the three probes. `npm test` 780/780 and the old-head red / green are CLAUDE-RUN.
- Revision 6 recorded the implemented Slice C. Root CODE REVIEW **HOLD** on `e081b1e4` (R-C1, R-C2) was corrected at `0e8bd27a`. Root CODE RE-REVIEW **ACCEPTED** offline Slice C at `0e8bd27a`: root reran the probes and the extracted 18-case synthetic regression. Root could not run PG; the focused PG 14/14, units / pins 115/115, `npm test` 780/780 and the red / green are CLAUDE-RUN. `checkSameDatabase` stays a core concern (§12.1).
- Revision 7 recorded the implemented Slice D. Root CODE REVIEW **HOLD** on `6cdb8ae0` (R-D1, R-D2) was corrected at `d5a93e0f`. Root CODE RE-REVIEW **ACCEPTED** offline Slice D at `d5a93e0f`: root ran focused journal 17/17 and manifest + guard + journal 59/59 against exact modules, no stubs, no DB. `npm test` 797 and units + pins 132 are CLAUDE-RUN. No live readiness implied.
- Revision 8 (this file, DOCS ONLY) brings the core plan to the **exact accepted A / B / C / D interfaces** and resolves the remaining integration decisions in one source-cited map (§12).
  - It proposes the smallest executable offline core slice (§9.4).
  - The core is **not implemented and not authorized** by this revision.
  - Root DESIGN REVIEW **ACCEPTED** revision 8 at `ea830a62` and authorized Slice E, with binding clarifications 1–6 (recorded in §13.1).
- Revision 9 (this file) records the implemented Slice E (§13): `runConnectedTest` + `checkSameDatabase` in `run-core.mjs`, and the disposable-PG suite E1–E23. All results are **CLAUDE-RUN** (root cannot run PG). Pending root CODE review.
- Root CODE REVIEW **HOLD** on `6e253977` (R-E1 stop boundaries, R-E2 post-step observation, R-E3 terminal failure). Corrections on the same branch (fast-forward), recorded in §13.5; suite now E1–E27. Pending root CODE re-review.
- Root CODE RE-REVIEW at `d16b57ec`: R-E2 / R-E3 CLOSED; narrow HOLD R-E1d (acquisition handoff). Corrected on the same branch (fast-forward), §13.6; suite E1–E28.
- Root CODE RE-REVIEW **ACCEPTED** offline Slice E at `dfdbc32c` (root reran five exact-core synthetic probes and A/B/D 59/59; PG 34/34, units + pins 132, `npm test` 797 are CLAUDE-RUN). R-E1 (incl. d), R-E2, R-E3 CLOSED. A–E ACCEPTED offline; no live readiness implied.
- **Next slice pointer (status only):** the owner-run local FILE JOURNAL is specified, DOCS ONLY, in `claude/e7-connected-file-journal-contract.md` (branch `feature/e7-connected-file-journal-contract` from `dfdbc32c`; proposed Slice F; not implemented, not authorized). Nothing in this contract changes.
- **Slice F status pointer:** root DESIGN ACCEPTED the file-journal contract at `d365d816`; Slice F (`scripts/e7-connected/run-journal-file.mjs` + `test/e7-connected-run-journal-file.test.mjs`) is IMPLEMENTED offline on `feature/e7-connected-file-journal`, pending root CODE review — record in the file-journal contract §9. The core is unchanged.

**Citation convention.**
- Current interfaces are cited by **file:line at `d5a93e0f`**: workers under `lib/booking-db/`, runner modules under `scripts/e7-connected/`.
- Sections marked *design rationale (revision 4)* keep the original reasoning for the accepted designs. Where they differ from an accepted module, the module's exact interface (§2.1–§2.5) and §12 govern.
- The runtime (workers, SQL) is unchanged since `ede4c43c`. The adapters were accepted at `b757d6b7`.

**What this is.** The smallest **offline / injected-fake** orchestration foundation. It is a library that drives ONE existing synthetic booking through the accepted workers, with per-step adapter factories, and then ends.

**What it is not:**
- a CLI, a real transport, a credential loader, Stripe ingress, a file (durable) journal or a live approval;
- automatic cancel / refund;
- a notification / owner-alert sender;
- general resume.

Those are independent, CLOSED slices. All owner inputs stay **UNSET**. Live gates stay **CLOSED**. Protected reservations 70636076 / 71045356 / 71072615 / 71081885 stay zero-action. The historical e74a listing-lock failure stays OPEN (FIRST FULL TAP / STOP if reproduced in any later test).

## 0. Status map

| Scope | Status | Where |
|---|---|---|
| Slice A: manifest v1 validation + canonical hash | **ACCEPTED** (`cc5d877d`) | §2.1, §3.1 |
| Slice B: `run-guard` (deadline guard, lifecycle, executor wrappers, client tracker) | **ACCEPTED** (`86acc274`) | §2.2 |
| Slice C: `run-facts` (report snapshot, app guest read, pure candidate derivation) | **ACCEPTED** (`0e8bd27a`) | §2.3, §4, §5.1 |
| Slice D: `run-journal-memory` (memory journal, record / chain / start validation) | **ACCEPTED** (`d5a93e0f`) | §2.5, §8 |
| Import boundary (A) | **CLOSED** root decision | §2.0 |
| Core integration decisions: same-DB check, ownership, journal emission, per-step bindings | **Resolved as a proposal in this revision** | §12 |
| Slice E: `run-core` + disposable-PG runner test | **ACCEPTED offline** (`dfdbc32c`) | §9.4, §13 |
| File journal (Slice F) | **IMPLEMENTED offline**, pending root CODE review; `claude/e7-connected-file-journal-contract.md` §9 | separate contract |
| File journal, real transports, credentials, Stripe ingress, CLI, read-only provider probes | **CLOSED**, separate slices | §9.4 |

## 1. Present runtime vs accepted foundation vs proposed core

| Layer | Status at `d5a93e0f` |
|---|---|
| Workers | **Accepted code**, used unchanged: `runOrchestratorStep` (`reservation-worker.js:585`), `runCaptureStep` (`capture-worker.js:600`), `runRecordingStep` (`recording-worker.js:598`), `runCleanupStep` (`compensation-worker.js:643`). Each step: (1) checks the `test` marker itself (`pool.js:73`; recording `:606–607`); (2) does its own scoped maintenance, recovery pass, at most one claim, its own provider calls (bounded by its own `setTimeout`, `reservation-worker.js:96–108`) and `releaseWork` SQL (`:171`) on the pool it is given; and (3) may leave a **late tail** (§7.3) |
| Executor adapters | **Accepted** (`scripts/e7-connected/executor-adapters.mjs`, `b757d6b7`) |
| Manifest (A), guard (B), facts (C), memory journal (D) | **Accepted** offline modules under `scripts/e7-connected/` (§2.1–§2.3, §2.5) |
| Core (`run-core.mjs`) | **Implemented offline (Slice E, pending review).** Interface §2.4; integration map §12; implementation record §13 |
| Real transports, credentials, Stripe TEST ingress, file journal, live CLI | **CLOSED**, separate slices |

## 2. Files and exports

All runner files live under `scripts/e7-connected/` (excluded from upload).

**What they may not contain:**
- no `process.env`, `fetch`, file system, SDK, `setTimeout` / `setInterval` / `setImmediate`, scheduler or timer of their own;
- every wait is through the injected `timers` (§7.2);
- none of the identifiers pinned by the accepted containment tests: `hostaway-reservations` (`test/hostaway-reservations.test.mjs:544–569`), `connectedTestAdapterConfig` and `allowRequest:` (`test/e4-connected-path.test.mjs:404–421`).

### 2.0 Import boundary (CLOSED design decision, root)

**Proposed runner modules may import:**
- the four accepted worker entrypoints (`runOrchestratorStep`, `runCaptureStep`, `runRecordingStep`, `runCleanupStep`) and, through them, their normal transitive dependencies;
- the accepted adapters (`createPhaseExecutors`, `ExecutorRefusal`);
- the accepted manifest module;
- the needed pure constants (`direct-pricing.js`, `compensation-proof.js`);
- Node built-ins `node:crypto` and `node:util` (`types.isProxy`, `types.isPromise`).

**Forbidden:**
- a NEW direct importer of the pinned Hostaway module;
- any change to the containment pins, workers, `lib/`, SQL, fixtures, config or packages;
- worker injection: workers are imported, never supplied through `opts`;
- any copied worker implementation.

The full core stays USD / non-pilot, runs on an existing authorized **synthetic** intent only, and has no resume.

### 2.1 `run-manifest.mjs` — Slice A (ACCEPTED at `cc5d877d`)

**Interface.** `validateRunManifest(input) → Object.freeze({ ok:true, manifest, hash }) | Object.freeze({ ok:false, code })`.
- It never throws.
- A refusal is exactly `{ ok, code }`.
- There are no `opts`. Nothing is defaulted.

**Exports:** `validateRunManifest`, `canonicalJson`, `manifestHash`, `isRealDate`, and these constants:

| Constant | Value |
|---|---|
| `RUN_MANIFEST_VERSION` | `"e7-run-manifest-v1"` |
| `HASH_PREFIX` | `"e7-run-manifest-v1\n"` |
| `MAX_AMOUNT_MINOR` | 99 999 999 (= `stripe-test-mode.js:36`) |
| `MAX_GUESTS` | 50 (= the adapter's guest bound, `hostaway-reservations.js:244`) |
| `MAX_NIGHTS` | 90 (= `final-price.js:57`) |
| `PILOT_LISTING_IDS`, `CHECKPOINTS`, `PAYMENT_METHODS`, `TOP_KEYS`, `OWNER_KEYS`, `REFUSAL_PRECEDENCE` | as in §3.1 |

**Imports:** `node:crypto`, `MAX_RATE_BPS` (`direct-pricing.js:28`) and `localDateInZone` (`compensation-proof.js:64`). There is no env, fetch, fs, SDK, timer, credential, pool or transport.

**Snapshot (one pass before validation).** A descriptor snapshot builds a frozen null-prototype copy of own, enumerable **data** properties only.
- **Refused** (`MANIFEST_SHAPE`):
  - accessors, symbols, non-enumerable keys, own `__proto__`;
  - prototypes other than `Object.prototype` / `null`;
  - arrays that are not plain, are sparse, have extra or accessor indices, or have a patched iterator;
  - non-finite numbers and BigInt;
  - values over the size bounds (256-character strings, 32 keys, 8 elements, depth 4, which also bounds cycles).
- Only introspection failure is caught.

**Caller-code guarantee (wording corrected per root).** No caller **getter, iterator or `toJSON`** runs.
- Proxy **inspection traps** (`getOwnPropertyDescriptor`, `ownKeys`, `getPrototypeOf`) necessarily can run during the snapshot. No promise is made about their side effects.
- `Array.isArray` itself does not execute ordinary proxy traps; a revoked proxy can make it throw, and that is caught as `MANIFEST_SHAPE`.
- The guarantee is that the one snapshot taken is the object validated, hashed and returned.

**Hash.** `sha256(HASH_PREFIX + canonicalJson(validatedCopy))`.
- Canonical JSON uses sorted keys and supports strings, safe integers, booleans, `null` and ordered arrays.
- It never calls `JSON.stringify` on a caller object or relies on `toJSON`.
- `intentId` is inside the hash.

**Refusal precedence (first match wins):**
1. `MANIFEST_SHAPE`
2. `VERSION_UNSUPPORTED`
3. `S_LIVE_REFUSED` — live Stripe, whatever `synthetic` is
4. `REAL_RUN_NOT_IN_THIS_SLICE`
5. `PROVIDER_MODE_NOT_IN_THIS_SLICE`
6. `MANIFEST_OWNER_INPUT_MISSING`
7. the field codes in schema order (§3.1)

**TRUST.** `fake` / `mock` is a label. It does not prove that injected transports are fake, and the validator alone never enables provider access.

**Slice A evidence note (classification corrected per root).** Claude's 9-mutant sanity run caught 5. The 4 survivors still end in rejection, but they are **not all behaviourally equivalent**:

| Removed check | Effect |
|---|---|
| Accessor check | Equivalent in effect: the value snapshots as `undefined`, which is refused as `MANIFEST_SHAPE` |
| Own `__proto__` check | Equivalent in effect: refused as an extra key, `MANIFEST_SHAPE` |
| Sparse-array check | Can change the public code from `MANIFEST_SHAPE` to `CHECKPOINTS_INVALID` |
| Depth limit | Loses the bounded-work guarantee: cycles recurse until a caught stack overflow, even though the input is still refused |

The accepted implementation has the correct checks. Root requested no snapshot export and no further mutation campaign.

### 2.2 `run-guard.mjs` — Slice B (ACCEPTED at `86acc274`; exact interface)

**Purity.** Pure helpers over injected dependencies.
- Imports: exactly `node:util` and the accepted adapter's `ExecutorRefusal`.
- No SQL text, no worker import, no client / pool / transport / env / fs / fetch / SDK, and no timer of its own. A source pin checks this.

**Native-promise rule (corrected per root R-B1).**
- Every observed promise must be an **unpatched** native `Promise`:
  - not a proxy, and brand-checked;
  - prototype exactly `Promise.prototype`;
  - **no own string-keyed property**, so no own `then`, `constructor` or species customisation;
  - every own symbol-keyed property a plain **data** property. Node's async_hooks attach own symbol data ids to promises, and those are allowed.
- Inspection uses descriptors and keys only.
- Settlement is read only through the intrinsic `Promise.prototype.then` captured at load.
  - That intrinsic performs `SpeciesConstructor`: a `[[Get]]` of `p.constructor`, then `C[@@species]`.
  - Because own `constructor` is refused, these resolve to the built-ins.
- **Global intrinsic trust.** The module assumes same-process code has not replaced `Promise.prototype.constructor` or the `Promise[@@species]` getter. Before every attachment it re-checks both by **descriptor identity** against the values captured at load, and drift means "not native". It does **not** claim that arbitrary same-process code cannot modify built-ins. It never mutates a caller promise or a global prototype.
- Any attachment that throws anyway is contained and reported as unobservable.
- A caller `then`, getter or thenable is never assimilated.
- **Caller responsibility.** A rejected or patched promise that is "not native" is **never side-handled**: no getter runs merely to attach a handler. Its rejection handling therefore stays the caller's responsibility, and the guard never fabricates its settlement.
- A function that **throws** synchronously counts as a rejection.
- A function that **returns** a non-native value is **unobservable**, never "not started".
  - Initial **timer** promise: refused **before start** (`not_started: GUARD_TIMER_INVALID`).
  - Re-armed timer: post-start `observation_failed: GUARD_TIMER_INVALID`, with the op retained.
  - **Operation** promise: post-start `observation_failed: GUARD_OPERATION_NOT_NATIVE`, with `op:null`, `opState:"unobservable"`, the timer cancelled, and no raw caller error.
  - **Step** / **late** promise: `TAIL` (unobservable), never quiescent and never unlocked.
  - **Unlock** result: destroy-only, never `"unlocked"`.
  - **Executor** result: returned identically and counted in `nonNative`; the ledger never drains.
- Every side handler contains its own exceptions, so no derived promise can leak an unhandled rejection.

**Calling convention.** Every injected callback is called with `this === undefined`, except executor wrappers, which preserve the adapter container (below).

#### 2.2.1 Exports

| Export | Signature → result |
|---|---|
| `RUN_GUARD_VERSION` | `"e7-run-guard-v1"` |
| `MAX_DELAY_MS`, `MAX_EARLY_FIRES` | 1 800 000; 3 |
| `LIMITS` | the frozen §7.2 limits table (`CONNECT_MS` … `ATTEST_MS`) |
| `STEP_PHASES` | `["reservation", "capture", "recording", "cleanup"]` |
| `isNativePromise(x)` | → boolean (the rule above) |
| `validateGuardDeps({ monotonic, timers:{ arm } })` | → frozen `{ ok:true, deps }` / `{ ok:false, code:"GUARD_DEPS_INVALID" }`. Descriptor-only inspection: no getter, proxy, `monotonic` or `arm` call. Null-prototype objects are accepted |
| `createGuard(deps)` | → frozen guard (§2.2.2). Throws `TypeError("GUARD_DEPS_INVALID")` unless `deps` came from `validateGuardDeps` |
| `createLedger()` | → frozen `{ snapshot(), whenDrained() }` (§2.2.4) |
| `wrapExecutors(executors, ledger)` | → frozen `{ ok:true, executors }` / `{ ok:false, code:"EXECUTORS_INVALID" }` (§2.2.4) |
| `trackClient({ subscribe, unsubscribe, destroy, onLoss })` | → frozen `{ ok:true, tracker }` / `{ ok:false, code:"TRACK_INVALID" \| "TRACK_SUBSCRIBE_FAILED" }` (§2.2.5) |
| `createLifecycle({ guard })` | → frozen lifecycle (§2.2.3). Throws `TypeError("LIFECYCLE_INVALID")` unless `guard` came from `createGuard` |

#### 2.2.2 Guard

**`observe(deadline, start) → Promise<frozen ObserveResult>`.**
- `deadline` is an absolute monotonic value.
- `start` is called **at most once**, with no arguments, and **only after the initial timer handle validated** (arm-before-start).

| `kind` | Fields | Meaning |
|---|---|---|
| `not_started` | `started:false`, `code` | `start` was **not** called. Codes: `GUARD_BROKEN`, `GUARD_ARGUMENT_INVALID`, `GUARD_MONOTONIC_INVALID`, `EXPIRED_BEFORE_START`, `GUARD_DELAY_OUT_OF_RANGE` (`ceil(remaining)` > `MAX_DELAY_MS`), `GUARD_TIMER_INVALID` (initial `arm` threw or returned an invalid handle) |
| `fulfilled` | `started:true`, `value`, `op` | settled within the deadline |
| `rejected` | `started:true`, `reason`, `op` (`null` when `sync:true`), `sync` | `reason` is for the runner's own classification only; never journaled or returned by the core |
| `timeout` | `started:true`, `op` | the monotonic deadline was reached at a timer wake. `op` is **retained** (still pending), and its late rejection is side-handled |
| `observation_failed` | `started:true`, `code`, `op`, `opState` ∈ `pending` / `fulfilled` / `rejected` / `unobservable`, plus `value` / `reason` when settled | a **post-start** guard fault. The work is never erased or reclassified as not started, and `op` is retained. Codes: `GUARD_TIMER_INVALID` (re-arm threw or returned an invalid handle, or a 4th early fire), `GUARD_TIMER_FAILED` (timer rejected or fulfilled with a value other than `undefined`), `GUARD_MONOTONIC_INVALID` (fault after a wake), `GUARD_CANCEL_FAILED` (`cancel` threw after the op settled), `GUARD_OPERATION_NOT_NATIVE` (`start` returned a non-native value; `op:null`, `opState:"unobservable"`) |

**Decision point.**
- The guard wakes on either "op settlement recorded" or "current timer settled".
- At that point, an op settlement **already recorded** wins. The guard does not promise to inspect settlements scheduled elsewhere in the same event-loop turn.
- Otherwise the guard reads `monotonic()`:
  - `≥ deadline` → `timeout`;
  - earlier (an early fire) → re-arm `ceil(deadline − now)`, at most `MAX_EARLY_FIRES` times.
- Only observation timers are ever re-armed. `start` is never re-invoked.

**Sticky fault.** Any `GUARD_*` fault after start, an initial-arm failure, or a monotonic fault latches `broken()`. Every later `observe` / `wait` then returns `not_started: GUARD_BROKEN`. Pre-start argument / expiry refusals do not latch.

**Timers.**
- A valid handle's `cancel` is called once when its observation ends without the timer firing.
- A fired timer is never cancelled.
- An **invalid** handle is never used. Its `cancel` is called only if it is an own data property holding a non-proxy function. Getters are never run.

**Other methods:**
- `wait(deadline)` → `{ kind:"elapsed" }` | `not_started` | `{ kind:"observation_failed", started:false, code }`. An already reached deadline is `elapsed` without arming. The caller passes `now + min(delayMs, phaseRemaining)`.
- `now()` → `{ ok:true, value }` | `{ ok:false, code }`.
- `remaining(deadline)` → `{ ok:true, ms }` (fractional, may be ≤ 0) | `{ ok:false, code }`.
- `armedCount()` → the number of live timers.
- `cancelAll()` → `{ cancelled, failures }`.
- `broken()` → code | `null`.
- `cancelFailures()` → number.

#### 2.2.3 Lifecycle

**`observeStep({ phase, deadline, start, ledger })` → `Promise<frozen { kind, code?, value?, reason?, outstanding }>`.**
- The kinds are as in §2.2.2. `not_started` means `start` was never called: `LIFECYCLE_ARGUMENT_INVALID`, `LIFECYCLE_BUSY` (outstanding ≠ NONE), `LIFECYCLE_FINALIZING`, or any guard pre-start code.
- **Ownership begins before `start` runs.** The state becomes `STEP` at the instant `start` is invoked, and the returned native promise is retained, with transitions attached, before the guard observes it.

**Transitions (independent of observation; they continue after a timeout or a fault):**
- **Fulfilled:**
  - an own data `late` holding a native promise → `TAIL` (observable);
  - no `late` → `NONE`;
  - an accessor / non-native `late` → `TAIL` (unobservable).
- **Rejected:** `dbFamily = true`. Ledger `started > 0` → `TAIL` (unobservable, **forever**, even if every executor promise later settles). `started === 0` → `NONE`.
- **Non-native step result:** `TAIL` (unobservable).
- **Tail settles:** `NONE`. A rejecting tail also sets `dbFamily`.

**`observeTail(deadline)`** → `{ kind:"settled" | "unobservable" | "timeout" | "not_started" | "observation_failed", code?, outstanding }`. It observes the **existing** `late`; no work is started.

**`observeConnect(deadline, connect, destroyClient)`** → `{ kind:"fulfilled", client }` or `{ kind, code? }`.
- After a `timeout` / post-start fault, a late client is passed to `destroyClient` **exactly once** and to nothing else: never queried, retried or reused.
- A late rejection is swallowed, and the side promise is fully handled.
- An in-time rejection returns `rejected`; the core maps it to the DB family.

**Lock:**
- `attachLock({ unlock, destroy })` → boolean, once. `unlock()` → native `Promise<boolean>`; `destroy()` is local destruction only.
- `lockLost()`: `exclusion "lost"` and a local destroy **once**. It never unlocks and never implies that a step was cancelled.

**Stop flags:**
- `stop(code)` → `{ stopCode }`: the first valid code (`^[A-Z][A-Z0-9_]{0,47}$`) wins.
- `markDbFamily()`.
- `snapshot()` → `{ stopCode, outstanding, outstandingPhase, tailObservable, dbFamily, exclusion: "not_acquired" | "held" | "lost" | "released", exclusionLost, finalizing }`.

**`finalize()`** → the **same** promise on every call (§7.6). It never rejects. Sequence:
1. Wait for quiescence: `NONE` and every registered ledger drained. There is no deadline, so this may stay pending forever.
2. `cancelAll()`.
3. Release the lock:
   - `"not_acquired"` or `"lost"` → nothing;
   - `dbFamily` **or** `guard.broken()` → `destroy()` only (`"destroyed"`), because a broken guard cannot bound an unlock;
   - otherwise one `observe(now + UNLOCK_MS, unlock)`:
     - `true` → destroy → `"unlocked"`;
     - `timeout` → destroy → `"destroyed_after_unlock_timeout"`;
     - `false` / non-boolean / rejection → destroy → `"destroyed_after_unlock_failure"` (`false` also sets `exclusionLost`);
     - a pre-start refusal → destroy → `"destroyed"`;
     - the lock lost meanwhile → `"lost"`.
4. Resolve:

```js
Object.freeze({ quiescence: "observed", lockRelease, exclusionLost, lateClientsDestroyed, timerCancelFailures, timersCancelledAtDisposal
  /* , internalFault: true — only if an internal error was contained; the lock is then destroyed */ })
```

#### 2.2.4 Ledger and executor wrappers

**Ledger:**
- `snapshot()` → `{ started, settled, nonNative, refusals: [{ key, code }] }`, frozen.
- `whenDrained()` → a native promise that fulfils once `settled === started`. It **never** fulfils if any call returned a non-native value.

**`wrapExecutors(executors, ledger)`:**
- Keeps the same key set, with own enumerable string-keyed data properties only.
- An own `__proto__` key → `EXECUTORS_INVALID` (root R-B3); its value is never executed.
- Non-enumerable, symbol and accessor keys (top level or in `pricing`) are refused.
- The output object is built with `Object.defineProperty`, so no `[[Set]]` / prototype-setter path is used; its prototype stays `Object.prototype` and it is frozen.
- `label` passes through **unchanged** (`===`).
- `pricing` becomes `{ get, post }`, each wrapped with `this` = the original `pricing` object.
- Every other key must be a non-proxy function, wrapped with `this` = the original executors object.
- Each call:
  - increments `started` and calls the adapter with the **identical arguments**, which are never read;
  - a synchronous throw is rethrown **identically**;
  - a native result is returned as **the identical promise**, with side handlers;
  - a non-native result is returned identically and counted in `nonNative`;
  - `settled` is incremented **exactly once** per call.
- **Refusal facts** are recorded code-only, and only when the error is a non-proxy object whose prototype is exactly `ExecutorRefusal.prototype` and whose own **data** property `code` matches `^[A-Z_]{1,40}$`.
  - A forged accessor `code` is never executed.
  - Introspection failure never replaces the primary error.
- The wrappers grant no transport access: they wrap the accepted adapters only.

#### 2.2.5 `trackClient({ subscribe, unsubscribe, destroy, onLoss })`

The core supplies closures over **its** client, for example `subscribe = (ev, h) => client.on(ev, h)` and `destroy = () => client.release(true)`. This module never touches a client object.

- The first `error` or `end` while open → state `"lost"`, `destroy()` **once**, then `onLoss()` once. Later events are ignored.
- `tracker.destroy()` → `true` only for the call that destroyed. The state becomes `"destroyed"` **before** the destroy callback runs (root R-B2), so an `error` / `end` emitted synchronously inside it, or delivered later, is **not** a loss. A destroy callback that throws is counted in `tracker.destroyFailures()` and still never reported as a loss.
- `tracker.dispose()` removes both listeners, once.
- `tracker.state()` → `"open" | "lost" | "destroyed"`.
- A `subscribe` throw → `TRACK_SUBSCRIBE_FAILED`, destroyed once, listeners removed.

#### 2.2.6 Clarifications and deviations from the revision-4 proposal (accepted with Slice B)

**Deviations:**
1. `trackClient` takes closures `{ subscribe, unsubscribe, destroy, onLoss }` rather than `(client, onLoss)`, so the guard never touches a client or relies on an EventEmitter.
2. `observeConnect` (the late-client helper) and `createLedger` are explicit exports / methods.
3. `wait(deadline)` takes an absolute deadline. The caller computes `min(delayMs, phaseRemaining)`.
4. The lifecycle sets `dbFamily` itself on any step rejection or tail rejection. Every other stop cause is recorded by the core via `stop()` / `markDbFamily()`.
5. A latched guard fault makes `finalize` destroy-only, because a broken guard cannot bound the unlock.
6. `Disposal` adds `timersCancelledAtDisposal` (and `internalFault` only on a contained internal error).
7. After `finalize`, `snapshot().exclusion` may be `"released"`.

**Clarifications.** Root clarifications 1–5 are implemented as stated in §2.2.2–§2.2.5. Clarification 6 is in §6.2 and §7.5.

**Errata after root CODE HOLD on `74e8f509` (corrected on the same branch):**

| Item | Gap at `74e8f509` (root probe) | Correction |
|---|---|---|
| R-B1 | A native promise with an own `constructor` getter passed `isNativePromise`. The intrinsic `then` ran that getter once, and the raw caller error escaped `observe` with a timer left armed | The unpatched-native rule above, plus contained attachment failure. Red / green: on `74e8` these regression tests fail; corrected, they pass with 0 getter runs |
| R-B2 | A synchronous `end` emitted inside the destroy callback was reported as a loss (`onLoss` 1, state `"lost"`) | The state is set before the callback runs |
| R-B3 | An own `__proto__` executor key returned `ok:true` with an output that had **no** keys (the prototype setter fired) | Refused; output built with `defineProperty` |
| (shared) | The descriptor helper accepted non-enumerable own data properties | All exact-key inputs (deps, timers, lifecycle / lock / tracker inputs, `pricing`) now require **enumerable** own data properties |

### 2.3 `run-facts.mjs` — Slice C (ACCEPTED at `0e8bd27a`; exact interface)

**Boundary.** Read-only. A pure codec / derivation layer over a **caller-supplied, connected** client. The module never:
- connects or ends a pool, releases or destroys a client, unlocks, or calls a worker / provider;
- has a timer, env, fs, fetch or SDK of its own.

**Imports:**
- `node:util` (`types.isProxy`, for option / client proxy refusal; root R-C2);
- accepted `run-guard` (`createLifecycle`, `LIMITS`);
- the pure `PROTECTED_HOSTAWAY_RESERVATION_IDS` (`lib/checkout/compensation-proof.js:23`);
- no worker, and no new importer of the pinned Hostaway module. Both containment pin suites still pass.

**Guard provenance.** The accepted guard API does not export its provenance check, so the module checks a guard by constructing a throwaway `createLifecycle({ guard })`. That has no side effects, and it throws `LIFECYCLE_INVALID` for anything `createGuard` did not make. No guard edit was needed.

**Deadlines.** Each statement is observed with `guard.observe(min(now + LIMITS.STATEMENT_MS, deadline), …)`. The caller's `deadline` is the absolute whole-snapshot cap (core: `now + LIMITS.SNAPSHOT_MS`).

#### 2.3.1 Exports

| Export | Value / signature |
|---|---|
| `RUN_FACTS_VERSION` | `"e7-run-facts-v1"` |
| `FACT_CAPS` | `{ operations: 200, reservationAttempts: 1, reservationEvidence: 200, cases: 32, transitions: 200 }`. Each query uses `LIMIT cap + 1`, and more than `cap` rows → `FACT_LIMIT_EXCEEDED`. Never a silent truncation. `reservationAttempts` is 1 because the table is `UNIQUE (intent_id)` (`0001:437`) |
| `PAYLOAD_KEYS` | the only `external_operations.payload` keys copied: `amountMinor`, `attempt`, `currency`, `expiresAt`, `listingId`, `paymentAttemptId`, `paymentIntentId`, `providerIdempotencyKey`, `ref`, `reissueDepth`, `reissueOf`, `reservationId`, `sessionId`, `template`. Each is selected as its own `payload -> 'k'` column, with primitive values only; any other key is only **counted** (`payloadUnlistedKeys`), never copied |
| `RESERVATION_PHASE_STATES`, `OP_TYPES` | as in §5.1 |
| `SQL` | the frozen statement texts (below), published so the API is reviewable and testable |
| `readRunSnapshot({ client, intentId, guard, deadline })` | → `Promise<frozen Snapshot>` (§2.3.3) |
| `readGuestBinding({ client, intentId, guard, deadline })` | → `Promise<frozen GuestResult>` (§2.3.4) |
| `deriveRecoveryCandidate(facts)` | → frozen `{ ok:true, id, sources, adopted }` / `{ ok:false, code }` (§5.1) |

**Arguments (corrected per root R-C2).**
- **Options snapshot.** The options object is read through **one own enumerable data-descriptor snapshot**:
  - exactly `client`, `deadline`, `guard`, `intentId`;
  - prototype `Object.prototype` or `null`;
  - refused: accessors, symbols, non-enumerable / extra / missing keys, own `__proto__`, proxies (incl. revoked / throwing), class instances, inherited keys.
- **Values.**
  - `intentId` must be a canonical lowercase UUID, and `deadline` a finite number.
  - `guard` must come from `createGuard`, checked through the accepted `createLifecycle`.
- **Client.** `client` must be a non-proxy object. Its `query` is found by walking the prototype chain with `getOwnPropertyDescriptor` only:
  - the first `query` found must be a **data** property holding a non-proxy function;
  - prototype methods are supported, as on a real `pg` client;
  - an accessor is refused **without being executed**.
  - It must return a native promise; the accepted `pg` driver's does (tested).
- **Failure.** Anything else, or any introspection fault, → `FACTS_ARGUMENT_INVALID` (`not_started`, `unused`, zero statements). No caller getter runs, and no caller error is returned or thrown.
- **DB errors.** A real query / COMMIT error after valid options stays on the `db` / `destroy` path; it is never reclassified as bad input.

#### 2.3.2 Queries (source-checked; every statement parameterized by `$1 = intentId`, explicit columns, deterministic order)

| # | Statement | Source of the columns |
|---|---|---|
| 1 | `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` | — |
| 2 | **Marker + role:** `booking.instance (environment, created_at)` (`0001:15–19`; there is no other column), plus `pg_has_role(current_user, 'mv_booking_report' / 'mv_booking_app', 'MEMBER')` and `rolsuper OR rolbypassrls` from `pg_roles` | The snapshot requires a report member that is neither an app member nor privileged |
| 3 | **Intent:** `id, ref, environment, state, version, listing_id, from_date::text, to_date::text, guests, currency, final_total_minor, rate_bps, policy_version, stripe_payment_intent_id, authorized_minor, captured_minor, hostaway_reservation_id, reservation_confirmed_at, dispatch_at, dispatch_attempt, offline_charge_id, reservation_attempts, reason_code, updated_at` | `0001:47–110`. **Not** selected: `access_token_hash`, `checkout_session_id`, the price snapshot body, lease columns |
| 4 | **Work:** `intent_work (next_action_at, work_worker_id, work_lease_until)` | `0001:252–258` |
| 5 | **Operations:** identity, state, attempts, lease, `dispatched_at`, `completed_at`, `result_ref`, `error_code`, `late_result_status`, `late_result_ref`, `settled_evidence_id` (`0004:26`), `created_at`, plus the allowlisted payload keys, ordered by `created_at, id` | `0001:356–383` |
| 6 | **Attempts:** `hostaway_reservation_attempts (id, operation_id, booking_ref, state, dispatched_at, responded_at, http_status, refusal_code, hostaway_reservation_id, lookup_count, last_lookup_result)` | `0001:435–456` |
| 7 | **Reservation evidence:** `provider_evidence` with `kind = 'hostaway_reservation'` (`0003:52–71`), **LEFT JOIN**ed to its read op for `read_intent_id`, `read_op_type` and the selector `payload ->> 'ref'` / `'reservationId'`. From `observed`, only the scalar sub-values `bookingRef`, `matchCount`, `reservationId`, `listingId`, `from`, `to`, `totalMinor`, `currency` are taken, never the body. Ordered by `observed_at, id` | `0003:52–71`, `recovery.js:104–109` selector rule |
| 8 | **Cases:** `reconciliation_cases (id, kind, status, opened_at, opened_by, resolution, resolved_at)`; the `evidence` jsonb is not selected | `0001:536–549` |
| 9 | **Transitions:** `intent_transitions (version_after, from_state, to_state, event_type, reason_code, actor, at)`, ordered by `version_after` | `0001:207–221` |
| 10 | `COMMIT`. Its acknowledgement is required before `ok:true` | — |

**Guest statement.**
- A single statement: `SELECT g.first_name, g.last_name, g.email` plus the role columns, from `(SELECT 1) LEFT JOIN booking.intent_guests g ON g.intent_id = $1`.
- It runs as the app role only, with no transaction. Phone and terms are never selected.
- **Roles (source-checked):**
  - The report role has `SELECT` + RLS `report_ro` on `instance`, `intents`, `intent_transitions`, `intent_work`, `external_operations`, `hostaway_reservation_attempts` and `reconciliation_cases` (`0002:36–40`, `:51`), and on `provider_evidence` (`0003:709`, `:720`).
  - The report role has no grant or policy on `intent_guests` (`0002:50`). A report login running the guest statement gets permission denied, which is a `DB_FAILURE` (tested).
  - No new grant, function or migration.

#### 2.3.3 `readRunSnapshot` results (frozen; code-only; no error message ever kept or returned)

| `failure` | `code` | `clientDisposition` | Meaning |
|---|---|---|---|
| — (`ok:true`) | — | healthy | `facts` (below) + `statementsIssued` (10). COMMIT acknowledged |
| `refusal` | `ROLE_NOT_REPORT`, `MARKER_INVALID`, `DATABASE_NOT_TEST`, `INTENT_NOT_FOUND`, `INTENT_NOT_TEST`, `FACT_MALFORMED`, `FACT_LIMIT_EXCEEDED` | `healthy` | The facts were **acknowledged** but refused. Reading stops, and the read-only transaction is closed by one guarded `COMMIT`, which was acknowledged |
| `db` | `DB_FAILURE` (a rejected statement or `COMMIT`), `TIMEOUT_DB_READ` (a statement or `COMMIT` not settled in time, or the snapshot cap reached mid-transaction), `DB_RESULT_INVALID`, `GUARD_*` (post-start guard fault) | `destroy` | **No further statement** was issued: no `ROLLBACK`, `COMMIT` or count refresh. The caller must destroy its client (`release(true)`). A timeout does **not** cancel the server-side statement or `COMMIT`. When a refusal was pending and the closing `COMMIT` then failed, it is reported in `refusal` |
| `not_started` | `FACTS_ARGUMENT_INVALID`, `SNAPSHOT_BUDGET_EXHAUSTED`, guard pre-start codes | `unused` | Nothing was sent (`statementsIssued: 0`) |

**`facts` (deep-frozen; every row checked against the intent id):**

```js
{ version: "e7-run-facts-v1", intentId,
  marker: { environment: "test", createdAt },
  intent: { id, ref, environment, state, version, listingId, from, to, guests, currency, finalTotalMinor, rateBps, policyVersion,
            stripePaymentIntentId, authorizedMinor, capturedMinor, hostawayReservationId, reservationConfirmedAt, dispatchAt,
            dispatchAttempt, offlineChargeId, reservationAttempts, reasonCode, updatedAt },
  work: null | { nextActionAt, workerId, leaseUntil },
  operations: [{ id, opType, idempotencyKey, retryClass, state, sourceVersion, attempts, maxAttempts, requiresProviderRead, leaseWorkerId,
                 leaseUntil, nextAttemptAt, dispatchedAt, completedAt, resultRef, errorCode, lateResultStatus, lateResultRef,
                 settledEvidenceId, createdAt, payload: { …PAYLOAD_KEYS }, payloadUnlistedKeys }],
  reservationAttempts: [{ id, operationId, bookingRef, state, dispatchedAt, respondedAt, httpStatus, refusalCode,
                          hostawayReservationId, lookupCount, lastLookupResult }],
  reservationEvidence: [{ id, kind, source, externalRef, status, observedAt, readOperationId, readIntentId, readOpType,
                          selector: { ref, reservationId },
                          observed: { bookingRef, matchCount, reservationId, listingId, from, to, totalMinor, currency } }],
  cases: [{ id, kind, status, openedAt, openedBy, resolution, resolvedAt }],
  transitions: [{ versionAfter, fromState, toState, eventType, reasonCode, actor, at }],
  limits: FACT_CAPS }
```

**Value rules.**
- Timestamps become milliseconds, and dates are `YYYY-MM-DD` text.
- `bigint` values are parsed to safe integers.
- `jsonb` sub-values must be primitives.
- Anything unexpected → `FACT_MALFORMED`. Nothing is ever defaulted.

**No fence.** A frozen snapshot is a **basis, not a fence**: accepted workers may commit new facts concurrently after it (§4).

#### 2.3.4 `readGuestBinding` results

- `{ ok:true, guest: { firstName, lastName, email }, statementsIssued: 1 }`. The values exist only in this frozen object, for the executor binding, and are never journaled or logged.
- `refusal` / `healthy`: `ROLE_NOT_APP` (not an app member, a report member, or privileged), `GUEST_NOT_FOUND`, `FACT_MALFORMED`.
- `db` / `destroy` and `not_started` / `unused`: as above. A report login → `DB_FAILURE`.

#### 2.3.5 Errata after root CODE HOLD on `e081b1e4` (corrected on the same branch)

| Item | Gap at `e081b1e4` (root probe) | Correction | Red / green |
|---|---|---|---|
| R-C1 | Source-b lookup evidence with `observed.reservationId: null` gave `{ ok:true, id:'6100001', sources:['b'] }`; with `external_ref` null too, `{ ok:true, id:null }`. A 17-digit id was accepted | §5.1 (b) above: an observed id is required; strict 16-digit ids; `ok:true` ⇒ a usable id | New synthetic + PG-staged tests fail on `e081`, pass now. The PG test appends incomplete evidence via `requestRead` → `claimNextOperation` → `completeOperation` → `recordProviderEvidence` (accepted APIs, no raw lifecycle writes). The snapshot keeps `observed.reservationId: null`; the derivation → `KNOWN_ID_WITHOUT_CANDIDATE`; the accepted planner on the same rows → `RECONCILIATION_INCONCLUSIVE` (not proven) |
| R-C2 | `deps` destructured the options and read `client.query` outside any catch: a throwing `client` getter ran, and both functions rejected with the raw caller error | One own-data-descriptor snapshot plus a getter-free `query` lookup, faults contained | New test (own client / query getter, prototype getter, revoked / throwing / plain proxies, inherited / extra / symbol / hidden / `__proto__` keys, class instances, proxied guard / query): 0 getter runs, 0 statements, code only. Null-prototype options and genuine report / app `pg` clients pass |

#### 2.3.6 Deviation

`checkSameDatabase` (§7.8, proposed in revision 4 for this module) is **not** part of Slice C: root's Slice C scope named the snapshot, the guest read and the candidate derivation only. It stays a core-slice item. Its exact design is now §12.1 (core-owned SQL in `run-core.mjs`).

### 2.4 `run-core.mjs` — interface (Slice E, §9.4; implemented, §13)

`runConnectedTest(opts) → Promise<frozen RunResult>`

**Options.** `opts` is read through one own-enumerable-data-descriptor snapshot (the Slice C `deps` pattern) before any await. It must have **exactly** these keys:

| Key | Contents / check |
|---|---|
| `manifest` | Passes `validateRunManifest` (A). Its `hash` is the journal identity's `manifestHash` |
| `intentId` | Must equal `manifest.intentId`, else `REFUSED: INTENT_MISMATCH` |
| `pools` | `{ app, report }`: **caller-owned** pools (`connect()` + `query()` data methods; prototype methods supported, accessors refused). The runner never ends them. Same-DB check: §12.1 |
| `transports` | `{ hostaway:{ send }, stripe:{ send } }`. Passed only to `createPhaseExecutors` (adapters) |
| `journal` | `{ append(record), read() }`, the accepted D interface (`createMemoryJournal().journal` in this slice) |
| `trustedHead` | `null` or `{ seq, hash }`, passed to `evaluateStart` (D). `null` ⇒ the result reports `anchored:false` (§8.2 limit) |
| `attest` | `(checkpoint, request, { signal }) → native Promise<{ ok:boolean, evidenceRef?:string }>`. `request` is the frozen `{ checkpoint, runId, intentId, manifestHash }`: no guest or provider data |
| `clock` | `() → wall ms`: the ONE business clock passed to every worker (constraints in §12.4) |
| `monotonic`, `timers` | Validated by `validateGuardDeps` (B) |
| `signal` | A genuine run-level `AbortSignal`, inspected natively at boundaries (R-A2). It is passed to `attest`, never to a worker |

Invalid options → `{ ok:false, code:'OPTIONS_INVALID' }`, with zero DB, transport, journal, attest or timer calls.

**Workers** get `pools.app` and their accepted default timeouts. The runner passes no `monotonic`, `timers`, `timeouts` or `hooks` to workers (§12.4).

**`RunResult` (frozen; never mutated after return):**

```js
{ ok, outcome: null | OUTCOME, stopCode: null | CODE, phase, manifestHash, journalSeq,
  journalTerminal: "acknowledged" | "unknown" | "not_attempted", anchored: boolean,
  writes: { create, capture, record, void, cancel }, countsAsOf: { seq, stale: boolean },
  effectsKnown: boolean,
  outstanding: "NONE" | "STEP" | "TAIL", outstandingPhase: null | "reservation" | "capture" | "recording" | "cleanup",
  tailObservable: boolean,
  exclusion: "held" | "lost" | "not_acquired",
  ownerCleanupRequired: null | "reservedNotConfirmed" | "captured" | "confirmed",
  finalize: () => Promise<Disposal> }   // = lifecycle.finalize() of B: the same memoized promise (§2.2.3)
```

`writes` counts write operations of each type with `dispatched_at` set in the last **acknowledged** snapshot (C `facts.operations`, `dispatchedAt !== null`):
- `create` = `hostaway.create_reservation`;
- `capture` = `stripe.capture_payment_intent`;
- `record` = `hostaway.record_offline_charge`;
- `void` = `stripe.void_payment_intent`;
- `cancel` = `hostaway.cancel_reservation`.

### 2.5 `run-journal-memory.mjs` — Slice D (ACCEPTED at `d5a93e0f`; exact interface)

**What it is not.** An **in-memory** journal plus pure record / chain / start validation:
- **not durable** and **not a file journal**;
- it proves nothing about fsync, filesystem atomicity, disk durability or the absence of a late append (all CLOSED);
- it is never a live gate, an approval or a substitute for the core's DB eligibility check.

**Imports:** `node:crypto`, `node:util`, and the accepted manifest's `canonicalJson` / `CHECKPOINTS`. No timer, env, fs, network, SDK, worker or DB (source-pinned).

**Getter-free inputs.** Every caller value (identity, record, records list, read result, options) is copied through **one** own-enumerable-data-descriptor snapshot before any await:
- refused: accessors, symbols, non-enumerable / extra keys, `__proto__`, proxies (incl. revoked / throwing), exotic prototypes, sparse or patched arrays;
- frozen and null-prototype inputs work;
- bounds: depth 4, 24 keys, 256-element arrays (records lists ≤ `MAX_RECORDS` 1024), 256-character strings.

The validated frozen copy is what is hashed, stored and returned. Callers cannot mutate stored history through their input or through read results.

#### 2.5.1 Exports

| Export | Contract |
|---|---|
| `RUN_JOURNAL_VERSION`, `RECORD_VERSION`, `JOURNAL_HASH_PREFIX`, `GENESIS_HASH` | `"e7-run-journal-v1"`, `1`, `"e7-run-journal-v1\n"`, `"0"×64` |
| `MAX_RECORDS` / `MAX_ACTIONS` / `MAX_RAW_ACTIONS` / `MAX_REFUSALS` / `MAX_STEP` / `MAX_TOKEN_LENGTH` | 1024 / 64 / 256 / 16 / 64 / 160 |
| `INTENT_STATES`, `OPERATION_TYPES`, `OPERATION_STATES`, `ACTION_NAMES`, `RECOVERY_EVENTS`, `READ_OUTCOMES` | The pinned grammar vocabulary (§8.2). Parity tests: intent states vs `intent-state.js STATES` + `0001:27–32`; op types vs the `0003:31–36` constraint; op states vs `0001:365–366`; recovery events ⊇ the planner's `ev("…")` |
| `ACTION_TOKEN_RE`, `isActionToken(t)` | The whole-token grammar (anchored, never a prefix match) |
| `EVENTS`, `TERMINAL_EVENTS`, `STEP_PHASES`, `FACTORY_PHASES`, `STEP_RESULTS`, `OUTCOMES`, `CLEANUP_KEYS`, `WRITE_KEYS`, `IDENTITY_KEYS` | The record vocabulary (§8.2) |
| `validateIdentity(x)` | → `{ ok:true, identity }` / `{ ok:false, code:'IDENTITY_INVALID' }` |
| `projectActions(raw)` | → `{ ok:true, actions, unlistedActions }` / `{ ok:false, code:'ACTIONS_INVALID' }`. A core helper: grammar-matching tokens are kept, at most 64; anything else is **counted, never copied** |
| `validateRecord(x)` | → `{ ok:true, record }` / `{ ok:false, code:'RECORD_SHAPE' \| 'RECORD_FIELD_INVALID' \| 'ACTION_INVALID' }`. One record; no history checks |
| `recordHash(record)` | `sha256(JOURNAL_HASH_PREFIX + canonicalJson(record))` (manifest canonical JSON: sorted keys) |
| `validateJournal(records, identity, { trustedHead }?)` | → `JournalVerdict` (§8.4) |
| `evaluateStart(readResult, identity, { trustedHead }?)` | → `StartVerdict` (§8.4) |
| `createMemoryJournal({ identity, preload?, faults? })` | → `{ ok:true, journal, controls }` / `{ ok:false, code:'JOURNAL_OPTIONS_INVALID' \| 'IDENTITY_INVALID' }` |
| `JournalError` | The **only** rejection reason: frozen, `message` `"JOURNAL_ERROR"`, own keys `name` and `code` only. No caller data |
| `FAULT_MODES`, `READ_FAULT_MODES` | `reject` / `hang` / `late` / `landed_hang`; `reject` / `hang` / `torn` |

**New exports (R-D2):** `PHASE_END_STATES` and `OUTCOME_RULES` (§8.2).

**Errata after root CODE HOLD on `6cdb8ae0` (corrected on the same branch):**

| Item | Gap at `6cdb8ae0` (root probe) | Correction | Red / green |
|---|---|---|---|
| R-D1 | `RUN_STOPPED` from an open logged step was refused unless `outstanding:'STEP'`. A real accepted-lifecycle rejection before any executor start (`NONE`), or after one (`TAIL`), could not be logged truthfully | Any truthful `NONE` / `TAIL` / `STEP` may close an open step. `effectsKnown` must be `false` with an open step or outstanding work. No fabricated `STEP_ENDED`, wait or SQL | New test using the accepted `createLifecycle` / `createLedger` / `wrapExecutors` + fake guard: rejection before a start → `NONE`; after a start → `TAIL` unobservable (`finalize` asserted still pending, never awaited); timeout → `STEP`. All three append and give `RUN_ENDED` at start. Fails on `6cdb`, passes now |
| R-D2 | `RUN_STARTED` → `RUN_ENDED` validated as ENDED, and mismatched outcome / cleanup keys passed the field check | The §8.2 phase / end-state / checkpoint / outcome / exact-key rules, including the three representable released paths | 6 coherent success / release paths accepted; 17 incoherent paths and 5 wrong keys refused; append-time refusal leaves history unchanged. Fails on `6cdb`, passes now. The documented whole-history rewrite limit is still shown with a **structurally coherent** forged history |

#### 2.5.2 `journal` (the interface the core uses) and `controls` (TEST-ONLY)

**`journal.append(record)`** → an unpatched native `Promise<frozen { seq, hash }>`, or a rejection with `JournalError(code)`.
- **Synchronous validation** before any await, in this order:

| # | Check | Code |
|---|---|---|
| 1 | Record shape / fields | `RECORD_INVALID` |
| 2 | Action tokens | `ACTION_INVALID` |
| 3 | An earlier append is unacknowledged (serial appends) | `APPEND_IN_FLIGHT` |
| 4 | Identity ≠ the journal's | `IDENTITY_MISMATCH` |
| 5 | Stored history does not validate | `JOURNAL_HISTORY_INVALID` |
| 6 | `seq` ≠ stored + 1, or `prevHash` ≠ hash of the stored tail | `CHAIN_MISMATCH` |
| 7 | After a terminal | `APPEND_AFTER_TERMINAL` |
| 8 | Other order violation | `ORDER_INVALID` |
| 9 | Store full | `JOURNAL_FULL` |

- **Serial ordering.** While an earlier append is unacknowledged, every new append is refused. A synchronously acknowledged append stores before it returns, so a concurrent caller with the same `seq` gets `CHAIN_MISMATCH`. Two appends therefore can never reuse a `seq` / `prevHash` or bypass the one-terminal rule.
- **No mutation on refusal.** A refusal never changes stored history.
- **No retry, ever.** The journal never appends a terminal record of its own.

**`journal.read()`** → native `Promise<frozen { records: frozen [frozen record], tail:'complete'|'torn' }>`, or a rejection with `JournalError(code)`. It returns records, not durable JSONL bytes.

**Fault plan (TEST-ONLY, deterministic, keyed by call number; no timer):**

| Fault | `append` behaviour |
|---|---|
| `reject` | `INJECTED_APPEND_FAILURE`, before anything is stored |
| `hang` | Never stored, never settles; later appends refuse `APPEND_IN_FLIGHT` |
| `late` | Pending until `controls.release(callNo)`, which then stores **and** acknowledges |
| `landed_hang` | Stored immediately, never acknowledged |

| Fault | `read` behaviour |
|---|---|
| `reject` | `INJECTED_READ_FAILURE` |
| `hang` | Never settles |
| `torn` | `tail: 'torn'`: a **SYNTHETIC representation** of a torn file tail. Memory records are never torn bytes |

An observer whose deadline expires cannot distinguish `hang` / `late` / `landed_hang`. Its timeout is **never** evidence of absence.

**`preload`** is SYNTHETIC test history (≤ 256 records): snapshotted, stored as given and not order-validated, so start / chain / identity refusals can be exercised. `append` refuses while the stored history does not validate.

**`controls`**: `release(callNo) → boolean`, `appendCalls()`, `readCalls()`, `size()`. This is test-only and separate from the journal interface.

## 3. Manifest v1 and the complete worker-input map

### 3.1 Schema (exact keys; no defaults; owner fields absent → `MANIFEST_OWNER_INPUT_MISSING`)

| Key | Rule |
|---|---|
| `version` | `"e7-run-manifest-v1"` |
| `runId` | `^[a-z0-9-]{8,64}$` |
| `intentId` | lowercase canonical uuid (`8-4-4-4-12` hex, lowercase only) of the EXISTING intent; part of the hashed run identity (existence is a core check) |
| `baselineCommit` | exactly 40 lowercase hex |
| `synthetic` | boolean. `true` = offline tests only (both transports are injected fakes; owner fields may hold synthetic values). `false` → refused in this slice (`REAL_RUN_NOT_IN_THIS_SLICE`) |
| `providerMode` | `{ hostaway, stripe }`. This slice accepts only `{ "fake", "mock" }`. `stripe: "live"` → `S_LIVE_REFUSED` (`capture-proof.js:97`, `compensation-proof.js:184`). Any other value → `PROVIDER_MODE_NOT_IN_THIS_SLICE` |
| `listing` | `{ id, currency, refFieldId, timeZone }`, all explicit. `currency` must be `"USD"` (`offline-charge-proof.js:33`, the USD direction). `id` is an int4 (1..2147483647). `refFieldId` is a positive int4 (required by `validateAdapterConfig`, `hostaway-reservations.js:202`, and by the reservation / recording factories). `timeZone` is an IANA name accepted by `localDateInZone` (`compensation-proof.js:64`, which is the check `compensationWorkerGate` uses for `LISTING_TIME_ZONE_INVALID`); numeric offsets are refused. The pilots 603564 / 603566 → `PILOT_NOT_IN_THIS_SLICE` (§3.3). No `pilotException` key |
| `expectedRef` | `^MV-[A-Z0-9]{6,10}$`; must equal the intent's `ref` |
| `stay` | `{ arrival, departure, guests }`: real calendar dates (years 2000–2100, the adapter's `isRealDate` rule), `arrival < departure`, ≤ 90 nights (`final-price.js:57`), guests 1..50 (adapter bound). Equality with the intent is a core check |
| `amountMinor` | safe integer 1..99 999 999. Equality with the intent's `price.finalTotalMinor` is a core check |
| `pricing` | `{ rateBps }`: safe integer **0..`MAX_RATE_BPS` = 5000** (`direct-pricing.js:28`; `readDirectPolicyFromEnv` refuses > 5000, `direct-policy.js:19–31`), so the manifest never validates a rate the worker policy rejects. Negative or non-integer → `RATE_INVALID`; > 5000 → `RATE_OUT_OF_RANGE`. Must equal the intent's `price.rateBps` (`final-price.js:127`; a core check, not Slice A). *Revision 2 wrongly said 0–10000.* |
| `stripeAccountId` | `^acct_[A-Za-z0-9]{1,64}$` (TEST-account check = the workers' `accounts.retrieve` id equality, `capture-worker.js:219`) |
| `hostawayAccountLabel` | `{ accountRef, clientSnapshotId }`, each `^[A-Za-z0-9._:-]{1,100}$`: **TRUST** labels, not ownership |
| `phases` | `{ capture, recording }`, booleans. `recording: true` requires `capture: true` (`PHASE_DEPENDENCY`) |
| `paymentMethod` | **always present.** `"credit_card"` or `"other"` iff `phases.recording`; exactly `null` otherwise (`PAYMENT_METHOD_RULE`). `null` is canonical JSON and is hashed |
| `cleanup` | `{ reservedNotConfirmed, captured, confirmed }`, each an owner-approved procedure reference `^[A-Za-z0-9._:/-]{1,128}$` (no spaces or `@`, so no contact data); a synthetic marker if `synthetic`. There is no `"not-applicable"`: every outcome a run can leave is covered (§6.2) |
| `automationsReviewed` | a reference with the same grammar as `cleanup` |
| `checkpoints` | exactly `["CALENDAR_BASELINE", "AIRBNB_BLOCKED", "AIRBNB_REOPENED"]` |

**Named invariants (fixed; not owner defaults):**
- `channelId = 2000`, the direct channel;
- worker env objects (below);
- workerIds `e7r-res` / `e7r-cap` / `e7r-rec` / `e7r-cln`.

No value is inferred, read from a runtime config or env, or filled by a synthetic fallback.

### 3.2 Worker inputs: every value and its source

*Design rationale (revision 2). The exact per-phase bindings and worker options against the accepted interfaces are §12.4, which governs.*

| Input | Reservation | Capture | Recording | Cleanup |
|---|---|---|---|---|
| `env` (object literal built by run-core, never `process.env`) | `{ VERCEL_ENV:"development", MV_E7_RESERVATION_WORKER:"enabled", DIRECT_DISCOUNT_BPS:String(manifest.pricing.rateBps) }`. The worker derives its pricing policy from this object (`readDirectPolicyFromEnv`, `direct-policy.js:13`, `:19–31`); the value is explicit, never the default | `{ VERCEL_ENV:"development", MV_E7_CAPTURE_WORKER:"enabled" }` | `{ …, MV_E7_RECORDING_WORKER:"enabled" }` | `{ …, MV_E7_COMPENSATION_WORKER:"enabled" }` |
| `adapterConfig` | plain `{ allowedListingIds:[listing.id], refFieldId:listing.refFieldId, channelId:2000, currency:listing.currency }`, validated **by the worker gate itself** (`reservation-worker.js:133`, `capture-worker.js:81`, `compensation-worker.js` gate). run-core does not import the pinned Hostaway adapter module | same | — | same |
| `listings` | `Map([[id, { currency }]])` | same | `Map([[id, { accountRef, channelId:2000, currency, listingId:id, paymentMethod, refFieldId }]])` (`recording-worker.js:78–86`) | `Map([[id, { currency, timeZone }]])` |
| `stripeAccountId` | — | `manifest.stripeAccountId` | — | same |
| `executors` | `createPhaseExecutors`: phase `reservation` or `reservation-recovery` (§5); binding from the intent snapshot + guest row | phase `capture`; binding = intent, adopted reservation id, PI, `amountMinor`, `captureIdempotencyKey` = the open capture op's `payload.providerIdempotencyKey` | phase `recording`; binding = intent, reservation id, `capturedMinor`, `paymentMethod`, labels | phase `cleanup`; reservation id or `null`, PI, `voidIdempotencyKey` = the open void op's payload |
| `clock` | `opts.clock` (one real clock for all four, satisfying the recording skew gate) | same | same | same |
| `intentId` | `manifest.intentId` | same | same | same |
| `workerId` | `e7r-res` | `e7r-cap` | `e7r-rec` | `e7r-cln` |

### 3.3 Pilot listing: a genuine containment blocker (no workaround)

A pilot listing (603566) requires the module-private branded config minted by the pinned adapter module. Workers reject any plain object with those fields (`hostaway-reservations.js:25–28`). Producing it from run-core would add a new importer and a new `connectedTestAdapterConfig` user. Both are pinned by accepted tests:
- `test/hostaway-reservations.test.mjs:566`;
- `test/e4-connected-path.test.mjs:416`.

V1 therefore refuses pilots (`PILOT_NOT_IN_THIS_SLICE`). **Smallest test-pin change, if root ever wants the pilot:** add `scripts/e7-connected/run-core.mjs` to those two pinned lists, in a separately reviewed slice. It is not proposed now.

## 4. Persisted facts: roles, snapshot, race

**Roles.** No owner access is needed:
- Provenance facts are read by the report role (`mv_booking_report`): `intents`, `intent_transitions`, `intent_work`, `external_operations`, `reconciliation_cases` (`0002:36–40`, RLS `report_ro` `0002:51`) and `provider_evidence` (`0003:709`, RLS `0003:720`).
- The report role has no guest data (`0002:35`, `:50`). The guest row is read by the app role (`0002:29–31`, `:49`), as the reservation worker itself does (`reservation-worker.js:179`).
- No new grant or API is proposed.

**Snapshot (implemented in Slice C, §2.3).** One `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` on a report connection supplied by the core:
- it contains every fact listed in §5, plus open cases, the ops of all five provider-write types with their states, and the `booking.instance` marker;
- then `COMMIT` and release, all **before** the step.

No transaction is held across a worker or network call. A failure inside the snapshot destroys that connection (`release(true)`) with no further SQL, and the run ends with `DB_FAILURE` (DB family, §7.1: no further runner SQL).

**Race (documented).** Workers commit new facts during the step, and possibly in a late tail (§7.3) after it. A snapshot is a basis, never a guarantee. Off-scope provider ids are prevented by the adapter's immutable binding **before** invocation. The next snapshot is authoritative.

## 5. Candidate provenance, factory choice and refusal observation

### 5.1 `deriveRecoveryCandidate(facts)` — IMPLEMENTED (Slice C), before every reservation step

**Purity.** It never builds a factory, starts an operation or touches the DB. Its input is `readRunSnapshot().facts`, or, for unit tests, a SYNTHETIC object of the same shape. It matches the accepted planner (`recovery-plan.js:193–269`, `knownIds` `:226–229`) and `loadRecoveryFacts` (`recovery.js:99–135`).

**Collection, all checked before any candidate is trusted:**
- **Shape and identity.** Version, canonical ids and the facts' intent id. At most one `hostaway.create_reservation` op (the DB's unique index), and at most one attempt row, bound to that create op with `booking_ref = intent.ref`.
- **Evidence association** (API sources only):
  - evidence must name a read op that is present in the same facts, for the **same intent**, whose `op_type` equals `readOpType` and is a lookup / retrieve;
  - a lookup's selector must be `intent.ref`;
  - violations → `FACTS_INCONSISTENT`.
  - Attested dashboard evidence is never a candidate source, but it is still protected-scanned.
- **Protected scan.** Over `intent.hostaway_reservation_id`, every op's `result_ref` / `late_result_ref` / `payload.reservationId`, the attempt id, every evidence `external_ref`, observed id and selector.
- **Candidates:**
  - **(a)** a `succeeded` create's canonical `result_ref`;
  - **(b)** API lookup evidence that meets all of (corrected per root R-C1):
    - `found_active`;
    - selector `= intent.ref` and `observed.bookingRef = intent.ref`;
    - `matchCount === 1`;
    - a **present, canonical, non-protected observed `reservationId` equal to `external_ref`**;
    - `listingId` / `from` / `to` / `totalMinor` / `currency` equal to the intent.

    How each failure is treated:
    - A missing / null / empty observed id makes the evidence **incomplete, never a positive source**. That is planner parity: `planCreate` reads `lo.reservationId` and returns not proven when it is missing (`recovery-plan.js:253–254`). `validate_evidence` does not require it for `found_active` (`0003:89–90`), so incomplete evidence is legal in PG (staged and tested).
    - An observed id ≠ `external_ref` → `EVIDENCE_IDENTITY_MISMATCH`.
    - A missing / non-canonical `external_ref` → `FACT_MALFORMED`.
    - An identity-field mismatch refuses.
    - Any missing identity field → no candidate.
    - Incomplete evidence's `external_ref` still joins the known-id conflict set.
  - **Id rule.** Every id must be `^[1-9][0-9]{0,15}$`: 16 digits, no leading zero, equal to the accepted adapter's `RID_RE` (`executor-adapters.mjs:73`) and the worker's by-id selector rule (`reservation-worker.js:235`). Missing / null / empty optional ids are "absent". Any other non-canonical id → `FACT_MALFORMED`. `ok:true` additionally requires the returned id to match that rule and to be non-protected, checked defensively and asserted independently by every test.
  - **(c)** the adopted `intents.hostaway_reservation_id`.
- **Known returned ids** (the planner's `RESERVATION_ID_CONFLICT` set): the create's `result_ref` (any state) and `late_result_ref`, the attempt row's `hostaway_reservation_id`, the adopted id, and every `found_active` API evidence id (lookup **and** by-id).
- **Selectors.** Every `hostaway.retrieve_reservation` op's `payload.reservationId`, marked open when the op is `pending` / `in_flight`.

**Decision (first match wins).** All codes are code-only and frozen:

| # | Condition | Code |
|---|---|---|
| 1 | unexpected shape / non-canonical id | `FACT_MALFORMED` |
| 2 | relationship violation | `FACTS_INCONSISTENT` |
| 3 | a protected id anywhere | `PROTECTED_REFERENCE` |
| 4 | state ∉ `payment_authorized` / `reservation_pending` / `reservation_unknown` | `NOT_RESERVATION_PHASE` |
| 5 | lookup / by-id evidence contradicting the intent or itself | `EVIDENCE_IDENTITY_MISMATCH` |
| 6 | `matchCount > 1` | `DUPLICATE_BOOKING_REF` |
| 7 | > 1 distinct candidate | `CANDIDATE_CONFLICT` |
| 8 | 0 candidates but a known id or by-id selector exists (fail closed) | `KNOWN_ID_WITHOUT_CANDIDATE` |
| 9 | 0 candidates, nothing known | `NO_CANDIDATE` (explicit; never auto-adoption) |
| 10 | a known returned id ≠ the candidate | `RESERVATION_ID_CONFLICT` |
| 11 | a by-id selector ≠ the candidate: open → `OPEN_READ_CONFLICT`; historical → `RESERVATION_ID_CONFLICT` | |
| 12 | a `pending` create plus a candidate | `CANDIDATE_BEFORE_CREATE` |
| — | otherwise | `{ ok:true, id, sources: ['a'\|'b'\|'c'], adopted }` |

**Same-step scheduling.** A pending by-id read does **not** need to exist yet. An open by-id read for the **same** id is fine.

**Factory choice (core, later).** One candidate → `reservation-recovery` bound to it. `NO_CANDIDATE` → `reservation` (unbound). Any other refusal → STOP.

### 5.2 Same-step facts

The worker may queue and claim a by-id read within the step (`reservation-worker.js:603–605`; accepted rehearsal §3.1). A read that needs an id not derivable beforehand meets the unbound factory's `RESERVATION_UNBOUND` refusal, with zero provider calls. The run then **STOPs** (§5.3); it never guesses or reruns blindly.

### 5.3 Executor wrappers: in-flight tracking and refusal observation (runner code only; no worker change)

**Why they are needed:**
- The workers swallow executor rejections. For example, `executeRead` turns a rejected `retrieveReservation` into `READ_REPLY_NOT_USABLE` / `READ:hostaway.retrieve_reservation:error` (`reservation-worker.js:238–239`), so the step result never exposes the adapter's code.
- A worker's late tail waits on `call.raw`, which is the executor's own promise (`reservation-worker.js:101`, `:377`).

**Wrapper shape.** `wrapExecutors` returns an object with the **same exact key set** as the `createPhaseExecutors` output:
- `pricing` is wrapped as an object with `get` / `post`;
- recording's `label` passes through unchanged.

**Each wrapped function:**
1. Increments the step ledger's `started`.
2. Calls the adapter function with the identical arguments.
3. If the call throws synchronously: records `{ key, code }` when the error is an `ExecutorRefusal`, increments `settled`, and rethrows the identical error.
4. Otherwise attaches side handlers with the intrinsic `Promise.prototype.then` (captured at module load): on settle it increments `settled`; on an `ExecutorRefusal` rejection it records `{ key, code }`, with code `^[A-Z_]{1,40}$`.
5. Returns **the identical promise object** the adapter returned.

The wrappers never read arguments, replies or messages, never retry, and never change settlement. A non-refusal rejection is the transport-failure path and is left unrecorded.

**STOP rules after each step:**
- any recorded refusal → `STOPPED: ADAPTER_REFUSED`, journaled with the code;
- `RESERVATION_UNBOUND` → `RECOVERY_BINDING_UNAVAILABLE`;
- conservatively, any `READ:<type>:error` action → `STOPPED: READ_FAILED`. V1 does not try to tell transient errors from refusals.

**In-flight evidence for quiescence (§7.3).** `ledger.started − ledger.settled` is the number of provider calls still in flight for that step. A late tail can exist only after a provider-call timeout:
- reservation `:377`;
- capture `capture-worker.js:447`;
- recording `recording-worker.js:444`;
- cleanup `compensation-worker.js:435`, `:533`.

So `started === 0` proves that a step scheduled no tail.

**Post-step audit (supporting only):** every executed by-id read named the bound id, and write counts are ≤ 1 per accepted op.

## 6. Phases, dependencies, terminal outcomes

### 6.1 Phases

*The exact journal emission per phase is §12.3. Note: the accepted capture worker never emits `CAPTURE_FAILED` (`capture-worker.js:10`), so P5 from `capture_failed` needs another actor (§12.4).*

| # | Phase | Entry gate | Worker, bounds | Exit |
|---|---|---|---|---|
| P0 | Preflight | Options + manifest valid. `opts.intentId = manifest.intentId`. Run lock acquired (§7.4–§7.5). Same-DB consistency check (§7.8). Marker `test`. **Journal empty** (§8.4). Intent `payment_authorized` and identity = manifest (ref, listing, stay, amount, `rateBps`, currency). No op of the five write types beyond the accepted pre-reservation state. No open case. Protected scan clean | none | journal `RUN_STARTED` (acknowledged) |
| P1 | Pre-create gate | Manifest cleanup procedures for **every** outcome + `automationsReviewed`. `attest("CALENDAR_BASELINE")` ok with `evidenceRef` | none | `ATTESTED` |
| P2 | Reservation | Snapshot + §5 before each step | `runOrchestratorStep`: ≤ 12 steps; phase ≤ 15 min monotonic | `reservation_confirmed` → `attest("AIRBNB_BLOCKED")`; `reservation_failed` → P5 |
| P3 | Capture (iff `phases.capture`) | Snapshot: no open case; no unknown / escalated / in-flight op. The capture worker has no open-case check (`capture-worker.js` / `capture-proof.js` contain no `reconciliation_cases` reference); this gate is the runner's | `runCaptureStep`: ≤ 6 steps, ≤ 10 min | `payment_captured` |
| P4 | Recording (iff `phases.recording`) | Same gates | `runRecordingStep`: ≤ 6 steps, ≤ 10 min | `confirmed` |
| P5 | Failure compensation | Only `reservation_failed` / `capture_failed` (`compensation-worker.js:50`), state-specific (`:103–107`) | `runCleanupStep`: ≤ 8 steps, ≤ 15 min | `authorization_released` / `cancelled` → `attest("AIRBNB_REOPENED")` iff a reservation had existed |

### 6.2 Terminal outcomes and the conservative cleanup key

A run never reports success while leaving a standing reservation or captured money unaccounted for:

| Path | `outcome` | `ok` | `ownerCleanupRequired` |
|---|---|---|---|
| P2 → `reservation_confirmed`, `capture: false` | `ENDED_RESERVED_NOT_CAPTURED` | true (plan end) | `reservedNotConfirmed` |
| P3 → `payment_captured`, `recording: false` | `ENDED_CAPTURED_NOT_RECORDED` | true | `captured` |
| P4 → `confirmed` | `ENDED_CONFIRMED` | true | `confirmed` |
| P5 → `authorization_released` / `cancelled` | `ENDED_RELEASED` | true | null, or `reservedNotConfirmed` if the cleanup left one |
| Any STOP / REFUSED | `STOPPED` / `REFUSED` | false | conservative rule below |

**Conservative rule.** On any STOP, `ownerCleanupRequired` is the **highest** of three keys, in the order `null` < `reservedNotConfirmed` < `captured` < `confirmed`:
- **(i) state:** the key implied by the last acknowledged snapshot's state;
- **(ii) possibly applied writes:** the key that any write op could have produced if its actual facts allow an effect. That means `state` ∈ `in_flight` / `succeeded` / `outcome_unknown` / `escalated`, or `dispatched_at IS NOT NULL` in any state other than `failed_definite` / `superseded` (`0001_booking_core.up.sql:365–375`). *"dispatched" is not an `external_operations` state; accounting uses the real `state` and `dispatched_at` facts.* A create gives `reservedNotConfirmed`; a capture gives `captured`; a recording gives `confirmed`;
- **(iii) unfinished work:** the key the outstanding or unobservable work of the current phase could have produced. If `outstanding ≠ NONE`, or the step rejected: in P2 → `reservedNotConfirmed`; in P3 → `captured`; in P4 → `confirmed`; in P5 → the P5 entry key.

**When the key may be null.** Only when all of these hold:
- `effectsKnown`;
- the last acknowledged snapshot shows no create op beyond `pending`;
- no reservation-phase work is outstanding or was rejected.

It is **never** null merely because no adopted reservation id is visible.

**`effectsKnown`.** It is `false` whenever any of these holds:
- `outstanding ≠ NONE`;
- `countsAsOf.stale`;
- a step rejected;
- an unknown write exists.

No automatic cancel / refund exists for a successful reserved / captured / confirmed booking, and none is designed here.

**Authorization fixture vs verified TEST ingress.** V1 starts only from an existing `payment_authorized` intent:
- in offline tests, that intent is produced by labelled synthetic fixture setup with a mocked authorization;
- verified Stripe TEST ingress (`processVerifiedStripeEvent`, `stripe-test-webhook.js:102`) is a separate CLOSED slice.

Attestations are owner statements with evidence references; program state never proves Airbnb behaviour.

## 7. STOP policy, deadlines, outstanding work, ownership, lock, finalize

*Design rationale (revision 4), implemented by B (§2.2). The exact per-boundary calls for the core are §12.2.*

**Boundary of control.** Inside one call to a step function, the accepted worker does its own maintenance, recovery, reads and at most one write, under its own fences and its own provider-call timers. The runner acts only **between** steps. It cannot stop or undo anything inside a step or its tail. Cancelling the run between steps does not cancel a worker that is already running.

### 7.1 STOP codes and the single stop cause

Each code ends the automatic run. Afterwards there is no further worker step, provider call, retry or SQL statement, except the bounded unlock in §7.6. At most one terminal journal append is attempted, and only if the journal has not failed (§7.7).

| Code | Trigger | Family |
|---|---|---|
| `DB_FAILURE` | a rejected snapshot / guest / lock / same-DB statement, or a rejected worker step | DB |
| `TIMEOUT_DB_CONNECT`, `TIMEOUT_DB_READ`, `TIMEOUT_DB_LOCK` | §7.4 | DB |
| `LOCK_LOST` | the run-lock session ended or errored (§7.5) | lock |
| `TIMEOUT_STEP` | §7.3 | outstanding |
| `LATE_TAIL_OUTSTANDING` | §7.3 | outstanding |
| `JOURNAL_FAILURE`, `TIMEOUT_JOURNAL` | §7.4 | journal |
| `TIMEOUT_ATTEST`, `OWNER_DECLINED`, `ATTESTATION_FAILED` | §6.1 checkpoints | owner |
| `PROTECTED_REFERENCE` | a protected id in the run's facts | facts |
| `OPEN_CASE` | any open case after any step. **Scenario C:** `reservation_confirmed` does not clear `HOSTAWAY_CREATE_OUTCOME_UNKNOWN`, so the run stops before capture | facts |
| `UNKNOWN_WRITE` | a write op `outcome_unknown` / `escalated`, or an unknown action | facts |
| `CANDIDATE_CONFLICT`, `OPEN_READ_CONFLICT`, `CANDIDATE_BEFORE_CREATE` | §5.1 | facts |
| `RECOVERY_BINDING_UNAVAILABLE`, `ADAPTER_REFUSED`, `READ_FAILED` | §5.3 | facts |
| `STEP_REFUSED`, `STATE_UNEXPECTED` | the worker result | facts |
| `CANCELLED` | the run-level signal was aborted, seen at a boundary | boundary |
| `BUDGET_EXHAUSTED` | the phase budget cannot cover the next await (§7.2) | boundary |
| `GUARD_TIMER_INVALID`, `GUARD_MONOTONIC_INVALID` | §7.2 | guard |

**One stop cause.** `stopCode` is the **first** terminal cause the runner observes, in program order. Later conditions never replace it. They appear only in the flags `outstanding`, `exclusion`, `journalTerminal`, `effectsKnown`, `countsAsOf.stale` and in the `Disposal` (§7.6). §7.7 defines the tie-breaks.

**DB family rule.** After any DB-family code, the runner issues **no further SQL on any connection**: no snapshot, count refresh, rollback, unlock or `releaseWork`. `releaseWork` is worker SQL inside a step and is never issued by the runner. The runner only destroys the clients it owns, locally (`client.release(true)`). The accepted worker's own SQL inside an outstanding step is not runner SQL and is not controlled by the runner.

### 7.2 Injected deadline API (`monotonic` + `timers`)

**`monotonic: () → number`.**
- Every reading must be a finite number ≥ the previous reading.
- A throw, a non-finite value or a decrease → `GUARD_MONOTONIC_INVALID`, treated as a stop before the next await.
- Monotonic readings **enforce** deadlines. They never wake anything.

**`timers.arm(delayMs) → { promise, cancel }` — the ONE timer API.**

| Part | Contract |
|---|---|
| `delayMs` | a safe integer 1 … 1 800 000, computed by the runner. It is the only argument: the timer never receives booking, provider, journal or owner data, and there is no callback |
| `promise` | a genuine native `Promise`: not a proxy, prototype exactly `Promise.prototype`, no own `then`. It **fulfils with `undefined`** at most once, no earlier than `delayMs` by the timer source. It never rejects |
| `cancel` | a non-proxy function, synchronous and idempotent. After `cancel()` the promise should never settle; a settlement after cancel is ignored |

**Validation:**
- `opts.timers` must be a plain object whose only key is `arm`, an own data property holding a non-proxy function.
- Each handle returned by `arm` is descriptor-snapshotted: exactly the own data keys `promise` and `cancel`, checked as above.
- An `arm` throw or an invalid handle → `GUARD_TIMER_INVALID`. Because the timer is **armed before** the observed operation is started (below), an invalid timer means the operation never starts.
- The runner settles everything through the intrinsic `Promise.prototype.then`, captured at module load, never through a caller's `then`.

**`observe(deadline, start)` — the only way the core awaits:**
1. `remaining = deadline − monotonic()`. If `remaining ≤ 0`, return `EXPIRED_BEFORE_START`, **without calling `start`**. The caller maps this to `BUDGET_EXHAUSTED`.
2. `handle = timers.arm(ceil(remaining))`, then validate it.
3. `op = start()`. A synchronous throw counts as a rejection.
4. Attach intrinsic side handlers to `op`. They record `settled` and the outcome synchronously when `op` settles, and suppress any late unhandled rejection.
5. Wait for the first of "op settled" and "timer fulfilled". This race is between two runner-built promises.
6. **On wake:**
   - If `op` is recorded as settled, **its outcome wins**, even if the timer fired in the same turn, and `handle.cancel()` is called.
   - Otherwise read `monotonic()`. If the deadline has not been reached (an early timer), re-arm for the remainder. After at most **3** early fires → `GUARD_TIMER_INVALID`. If the deadline has been reached → `TIMEOUT`.
7. The result is a frozen `{ kind: "fulfilled" | "rejected" | "timeout", value? }`. A rejection reason is kept **only** for the runner's own classification (a DB error, or an `ExecutorRefusal` code); it is never journaled or returned.

**Deadlines.** An operation outcome observed before expiry is accepted even if `monotonic()` has since passed the deadline. Before every await, `observe` re-checks the remaining time, and every boundary re-checks the phase budget. A step is started only if `phaseRemaining ≥ stepDeadline` (below); otherwise → `BUDGET_EXHAUSTED`.

**Cleanup.**
- Every armed timer is cancelled as soon as its observation ends, whichever way.
- `armedCount()` exposes the number still armed.
- At disposal, any still-armed timer is cancelled. A `cancel` throw is swallowed and counted in `Disposal.timerCancelFailures`.

**Inter-step wait.** `wait(ms)` = `observe(now + min(delayMs, phaseRemaining), () => neverSettlingRunnerPromise)`. The timer **fulfilling** is the normal end of the wait, not a failure.
- `delayMs` is the worker result's `delayMs`, for example reservation `waitMs` 30 s (`reservation-worker.js:58`).
- The signal and the phase budget are checked at the next boundary.
- There is no other wait primitive. Revision 2's `opts.wait` is removed.

**Hidden timers.** None. Runner modules contain no `setTimeout` / `setInterval` / `setImmediate` / `queueMicrotask` timer loop, and a source pin checks this. Accepted workers keep their own timers (`startBounded`), which are not runner code.

**Fixed limits (root's routine technical choice):**

| Name | Value |
|---|---|
| `CONNECT_MS` | 5 000 |
| `STATEMENT_MS` | 5 000 |
| `SNAPSHOT_MS` | 15 000 (whole read-only transaction, COMMIT included) |
| `LOCK_ACQUIRE_MS` | 5 000 |
| `UNLOCK_MS` | 5 000 |
| `STEP_MARGIN_MS` | 30 000. Step deadline = worker `stepBudgetMs` + margin: reservation / capture / cleanup 45 s + 30 s; recording 60 s + 30 s (`*_DEFAULT_TIMEOUTS`) |
| `TAIL_OBSERVE_MS` | 35 000 |
| `JOURNAL_MS` | 5 000 |
| `ATTEST_MS` | 1 800 000 |

**Fake-timer tests.** A test-local fake supplies `monotonic` and `timers`. It advances virtual time, fires due timers in order, and records arm / cancel / fire. It is not a runner module.

### 7.3 Outstanding work: NONE / STEP / TAIL

| State | Meaning | Entered when |
|---|---|---|
| `NONE` | no accepted-worker work is known or possibly pending | the start; a step settled AND its tail settled AND every wrapped executor promise settled; or a step rejected with ledger `started === 0` |
| `STEP` | a step function was called and **has not returned**. It can still reach its **first** provider write, run maintenance / `releaseWork` SQL, and schedule tails | step observation → `timeout` (`TIMEOUT_STEP`) |
| `TAIL` (observable) | the step returned a result with a native `late` promise that is still pending. Accepted late-evidence DB writes may still persist. The tail initiates **no** additional provider invocation (`reservation-worker.js:377`, `capture-worker.js:447`, `compensation-worker.js:435/533`, `recording-worker.js:444`) | tail observation → `timeout` (`LATE_TAIL_OUTSTANDING`) |
| `TAIL` (`tailObservable: false`) | the step **rejected** after the wrappers saw ≥ 1 executor call start. The worker's internal `ctx.late` is lost with the rejection (`reservation-worker.js:614–620`), so any tail exists but cannot be observed | step observation → `rejected` with `started > 0` (`DB_FAILURE`); or a `STEP` that later rejects with `started > 0` |

**Normal flow.** `NONE` → call step → `fulfilled` (within the deadline) → observe `late` (when the result has a native `late` promise; a gate refusal has none) within `TAIL_OBSERVE_MS` → settled → `NONE`.

**On `TIMEOUT_STEP`:**
- the original step promise is **retained**; no new work starts;
- effects are unknown: `effectsKnown: false` and `countsAsOf.stale: true`;
- the run lock is retained;
- disposal observes the step's eventual result and **then** its returned `late` promise (§7.6).

The result never claims evidence-only effects for an unreturned step.

**Transitions after return.** These happen inside disposal and never change the frozen `RunResult`:
- `STEP` → fulfilled → `TAIL` (observable) → settled → quiescent;
- `STEP` → rejected with `started === 0` → quiescent;
- `STEP` → rejected with `started > 0` → `TAIL` (unobservable) → never observed quiescent.

**Quiescent** means all of these hold:
- the state is `NONE`;
- every retained step / late promise has settled;
- every wrapped executor promise of the run has settled (ledger).

### 7.4 Per-await ownership

Each row is observed with `observe` (§7.2). "Late" means a completion after the observation ended.

| Await | Limit | Timeout → code | What the timeout observes | What may still finish | Who disposes, and how | More runner SQL after it? | Run lock may be released |
|---|---|---|---|---|---|---|---|
| `pools.report.connect()` for the lock (P0) | `CONNECT_MS` | `REFUSED: TIMEOUT_DB_CONNECT` | the connect promise | a connect that resolves later | runner: a late client is `release(true)`'d on arrival and **never queried**; a late rejection is ignored | none (refused) | n/a (`not_acquired`) |
| `pg_try_advisory_lock` on the lock client | `LOCK_ACQUIRE_MS` | `REFUSED: TIMEOUT_DB_LOCK`; rejection → `REFUSED: DB_FAILURE`; `false` → `REFUSED: RUN_LOCK_HELD` | the query promise | the server may still grant the lock | runner: the lock client is `release(true)`'d at once, so the server ends the session and any lock with it | none | n/a (`not_acquired`); zero workers started |
| `connect()` for a snapshot / guest / same-DB client | `CONNECT_MS` | `TIMEOUT_DB_CONNECT` (DB family) | the connect promise | a late connect | runner: late client `release(true)`, never queried | **none** | after quiescence, by destroy only (§7.6) |
| a snapshot / guest / same-DB statement, or `COMMIT` | `STATEMENT_MS`, `SNAPSHOT_MS` overall | `TIMEOUT_DB_READ` (DB family); rejection → `DB_FAILURE` | the query promise | the server may finish the READ ONLY statement / COMMIT (no data effect) | runner: that client `release(true)` at once; the in-flight query fails locally, and its rejection is suppressed | **none** | after quiescence, destroy only |
| worker step | `stepBudgetMs` + `STEP_MARGIN_MS` | `TIMEOUT_STEP` | the step promise (**retained**) | the whole step, including its first provider write, `releaseWork` and tail scheduling | the worker owns its work; the runner retains and observes it in disposal | none, except the bounded unlock in disposal | only after quiescence |
| post-result `late` | `TAIL_OBSERVE_MS` | `LATE_TAIL_OUTSTANDING` | the `late` promise (**retained**) | accepted late-evidence DB writes; no new provider invocation | worker; the runner observes it in disposal | none, except the bounded unlock in disposal | only after quiescence |
| `journal.append` / `journal.read` | `JOURNAL_MS` | `TIMEOUT_JOURNAL`; rejection → `JOURNAL_FAILURE` (journal family) | the journal promise | the append may still land later (or fail) | caller-owned; the runner suppresses a late rejection and ignores a late result | not SQL; **no further append**, no later worker | per §7.6 |
| `attest` | `ATTEST_MS` | `TIMEOUT_ATTEST`; `ok:false` → `OWNER_DECLINED`; rejection → `ATTESTATION_FAILED` | the attest promise | the owner may still answer; that answer is ignored | caller-owned; the run signal is passed to it | none further | per §7.6 |
| inter-step wait | `min(delayMs, phaseRemaining)` | none: fulfilment is the normal end | the timer only | nothing | runner (nothing to dispose) | unchanged | n/a |
| `pg_advisory_unlock` (disposal only) | `UNLOCK_MS` | no `RunResult` change; `Disposal.lockRelease` = `destroyed_after_unlock_timeout` / `destroyed_after_unlock_failure` | the query promise | the server may finish the unlock | runner: `release(true)` at once; no retry | none | this **is** the release |

**Ownership rules:**
- **Pools** are caller-owned and are never ended.
- **The runner owns only the clients it acquired:** the lock client and short-lived snapshot / guest / same-DB clients.
  - A healthy short-lived client is returned with `release()` after a COMMIT acknowledged in time.
  - A failed or timed-out one is destroyed with `release(true)`.
  - Destruction is local and is distinct from any SQL, including the worker's `releaseWork`.
  - A failed connection is never reused or queried again.
- **Workers** receive `pools.app` and own their own clients inside the step.

### 7.5 Run lock and exclusion

- **Purpose.** `pg_try_advisory_lock(hashtext('e7-connected-runner'), 0)` on a dedicated `pools.report` client coordinates **compliant runners only**. It is not a worker fence. The workers' own fences remain authoritative.
- **Acquire** (§7.4 rows 1–2). On success, `exclusion: "held"`, and `trackClient` attaches `error` / `end` listeners to the lock client.
- **Loss** (an `error` / `end` event on the lock client, at any time):
  - `exclusion` becomes `"lost"`;
  - the client is `release(true)`'d locally, with no SQL;
  - if no stop has happened yet, the next boundary stops with `LOCK_LOST`;
  - an outstanding STEP / TAIL is still observed, but the run never claims that the advisory lock protects the accepted-worker effects still in progress.
  - Detection is event-based: a silent partition may go unnoticed until the unlock, which then reports `destroyed_after_unlock_failure`.
- **Never premature.** A **healthy** lock session is never destroyed to satisfy a generic cleanup rule while a STEP / TAIL is outstanding or unobservable. It is released only by disposal after quiescence (§7.6), or by process exit.
- **Process exit.** Process exit ends **local** worker execution and the lock session together. It cannot stop a provider request that was already accepted remotely, and it cannot prove that request's outcome. Such writes remain **uncertain**, as the accepted workers record them (`outcome_unknown` / recovery). No resume or retry is authorized.

### 7.6 `finalize()` — one idempotent disposal

`result.finalize()` returns the **same** promise on every call. The runner creates it, and starts it, before `runConnectedTest` returns. Callers may await it or not.

**Sequence:**
1. **Wait for quiescence (§7.3), with no deadline.**
   - `NONE`: immediately.
   - `STEP`: wait for the retained step. If it fulfils, wait for its native `late` (if any) and for the wrapper ledger to drain. If it rejects with `started === 0`: done. If it rejects with `started > 0`: never.
   - `TAIL` (observable): wait for `late` and the ledger.
   - `TAIL` (unobservable): never.
   - **This may remain pending forever.** There is no "abandon and unlock" escape: the lock is then released only by process exit, which ends local execution but not an already-accepted remote request (§7.5).
2. **Cancel** every still-armed timer.
3. **Release the lock.**
   - `exclusion "held"` and the run is **not** on the DB-family path: `observe(monotonic() + UNLOCK_MS, unlock)`.
     - `true` → `release(true)` → `"unlocked"`;
     - `false` → `release(true)` → `"destroyed_after_unlock_failure"` (the lock had already been lost);
     - rejection → `release(true)` → `"destroyed_after_unlock_failure"`;
     - timeout → `release(true)` → `"destroyed_after_unlock_timeout"`.
   - DB-family path: **no unlock SQL**; `release(true)` → `"destroyed"`. The server ends the session and its lock.
   - `"lost"`: nothing to do. `"not_acquired"`: nothing to do.
4. **Resolve** a frozen `Disposal`. It never rejects; internal faults map to codes.

```js
{ quiescence: "observed",
  lockRelease: "unlocked" | "destroyed" | "destroyed_after_unlock_timeout" | "destroyed_after_unlock_failure" | "lost" | "not_acquired",
  exclusionLost: boolean, lateClientsDestroyed: number, timerCancelFailures: number }
```

**What finalize never does:**
- mutate or replace the `RunResult`, or mark the run successful;
- re-snapshot or fetch counts;
- call a worker, retry anything, or append a second terminal (or any) journal record;
- issue SQL other than the single bounded unlock in step 3;
- issue any SQL at all on the DB-family path.

**Eventual rejections during disposal:**
- A retained **step** that rejects later puts disposal on the **DB-family path**: a step rejection may be a DB failure, so step 3 issues no unlock SQL and only destroys. The `RunResult` is unchanged.
- A `late` promise that settles either way counts as settled for quiescence. The reservation / capture / cleanup `late` is `Promise.allSettled(ctx.late)` and does not reject; a recording `late` that rejects also moves disposal to the DB-family path. A non-native `late` is unobservable (pending forever).
- A later DB error inside the worker is the worker's own.
- None of these generates runner SQL. Only when no DB-family condition, step rejection or `late` rejection has occurred does the single bounded unlock run, after quiescence, on the healthy lock session.

### 7.7 Error priority and tie-breaks (deterministic)

1. **One wake, both settled.** An operation's settled outcome beats the timer. So a rejection observed in the same turn as the timer gives `DB_FAILURE` / `JOURNAL_FAILURE`, not `TIMEOUT_*`. A fulfilment in the same turn is accepted.
2. **Boundary checks, before every await,** in this order:
   1. exclusion lost → `LOCK_LOST`;
   2. signal aborted → `CANCELLED`;
   3. remaining phase budget → `BUDGET_EXHAUSTED`;
   4. then the snapshot-derived checks in §6.1 / §7.1 table order: `PROTECTED_REFERENCE`, `OPEN_CASE`, `UNKNOWN_WRITE`, the candidate codes, `STATE_UNEXPECTED`.
3. **First cause wins.** Every later condition becomes a flag only. Examples:
   - `TIMEOUT_STEP` then lock loss → `stopCode TIMEOUT_STEP`, `exclusion "lost"`;
   - `DB_FAILURE` then a terminal-journal timeout → `stopCode DB_FAILURE`, `journalTerminal "unknown"`.
4. **The terminal journal append** is attempted exactly once, only when no journal-family failure has occurred, after the stop cause is fixed and before the result is frozen.
   - Acknowledged → `"acknowledged"`.
   - Timeout → `"unknown"`. A late landing is possible, and either way the next invocation refuses with no worker call: `RUN_ENDED` if the record landed, `RESTART_AMBIGUOUS` if not.
   - Rejection, or no attempt after a journal failure → `"not_attempted"` / `"unknown"`.
   - A terminal-journal problem never changes `stopCode` and never triggers a retry.
5. **Counts.** `writes` are always the last **acknowledged** snapshot's counts. After any uncertainty, `countsAsOf.stale: true`. There is no refresh in a `catch` / `finally`.

### 7.8 Truthful limits

- **Same disposable test DB.** This is a **caller precondition**. The runner adds a weak consistency check at P0, with no new privilege or API. The exact statement, order and limits are §12.1, which supersedes this summary:
  - each pool reads `booking.instance` (`environment = 'test'`, `created_at`) and `current_database()`;
  - the two results must match, else `REFUSED: POOLS_MISMATCH`.
  - This check is not an identity proof. Workers re-check the `test` marker themselves (`pool.js:73`, `recording-worker.js:606–607`).
- **Labels are TRUST.** `fake` / `mock` and the account labels do not prove that the transports are fake or that an account is owned.
- **Late caller work.** Already-started injected journal / attest / connect operations can complete after their observation timed out. No later worker is started, nothing is retried, and late results are ignored. Late clients are destroyed.
- **Cancellation** between steps is not cancellation of an already-running worker.
- **Facts.** The snapshot is a basis, never a guarantee (§4). Only the last acknowledged snapshot counts.

## 8. Journal (V1)

### 8.1 Authority

DB state is authoritative. The journal is an audit / approval binding, never a retry authority:
- no new intent, key or attempt to bypass uncertainty;
- no replay of a possibly-sent write;
- no phase replay because a journal write failed.

A new manifest or runId is never authority to bypass a dispatched / unknown op or an ended run. Later action requires separately reviewed scope.

### 8.2 Record (IMPLEMENTED in Slice D; exact keys per event, no defaults)

**Common keys (every record):**

| Key | Rule |
|---|---|
| `v` | `1` |
| `seq` | 1 … 1024, contiguous |
| `prevHash` | 64 hex: `GENESIS_HASH` for `seq` 1, else `recordHash(previous record)` |
| `runId`, `intentId`, `manifestHash`, `baselineCommit` | Manifest grammar. Must equal the expected identity on **every** record |
| `at` | Safe integer ms, supplied by the caller |
| `event` | One of the events below |

**Additional keys, exactly, per event:**

| `event` | Keys |
|---|---|
| `RUN_STARTED` | — |
| `ATTESTED` | `attestation: { checkpoint ∈ CHECKPOINTS, evidenceRef ^[A-Za-z0-9._:/-]{1,128}$ }` |
| `STEP_STARTED` | `phase ∈ reservation / capture / recording / cleanup`, `step 1…64`, `factory: { phase, reservationId }`. Consistency: the factory phase matches the step phase (`reservation-recovery` counts as `reservation`); `reservation-recovery` ⇒ a `^[1-9][0-9]{0,15}$` id; `reservation` ⇒ `null` |
| `STEP_ENDED` | `phase`, `step`, `result ∈ worked / idle / refused / rejected / timeout / observation_failed`, `state` (intent state or `null`), `actions` (≤ 64 grammar tokens), `unlistedActions` (count), `refusals` (≤ 16 `{ key, code }`, code `^[A-Z_]{1,40}$`), `writes { cancel, capture, create, record, void }` |
| `PHASE_ENDED` | `phase`, `state` |
| `RUN_STOPPED` | `code ^[A-Z][A-Z0-9_]{0,47}$`, `outstanding ∈ NONE / STEP / TAIL`, `effectsKnown`, `exclusion ∈ held / lost`, `ownerCleanupRequired`, `writes` |
| `RUN_ENDED` | `outcome ∈ OUTCOMES`, `outstanding: 'NONE'`, `effectsKnown: true`, `exclusion`, `ownerCleanupRequired`, `writes` |

**Order (journal-level; corrected per root R-D1 / R-D2).** This is structural lifecycle consistency only, never DB or provider attestation.

*Start and steps:*
- `RUN_STARTED` exactly first.
- `CALENDAR_BASELINE` is attested before the first step.
- Steps run `STEP_STARTED` → `STEP_ENDED` with the same `phase` / `step`, numbered 1, 2, … per phase.

*Phases:*
- A phase ends (`PHASE_ENDED`) only after ≥ 1 completed step, with `state` equal to its **last** `STEP_ENDED.state`, and in an allowed end state (`PHASE_END_STATES`):

| Phase | Allowed end states |
|---|---|
| reservation | `reservation_confirmed`, `reservation_failed` |
| capture | `payment_captured`, `capture_failed` |
| recording | `confirmed` |
| cleanup | `authorization_released`, `cancelled` |

- A phase may start only from the previous phase's end state:

| Phase | May start after |
|---|---|
| capture | reservation ended `reservation_confirmed`, **and** `AIRBNB_BLOCKED` attested |
| recording | capture ended `payment_captured` |
| cleanup | reservation ended `reservation_failed`, or capture ended `capture_failed` |

*Checkpoints:*
- `AIRBNB_BLOCKED` needs reservation ended `reservation_confirmed`.
- `AIRBNB_REOPENED` needs a reservation to have existed **and** the cleanup to have ended `cancelled`.
- Each checkpoint appears at most once.

*Terminal records:*
- **`RUN_STOPPED`** (failure) may close an **open logged step** with the **truthful lifecycle status**. No `STEP_ENDED` is invented, nothing is awaited or re-read, and no SQL is issued just to satisfy the log:
  - `NONE`: the step rejected before any executor start;
  - `TAIL`: the step rejected after ≥ 1 start (unobservable tail);
  - `STEP`: the observation timed out.

  With an open step, `effectsKnown` must be `false`. In any terminal record, `outstanding ≠ NONE` ⇒ `effectsKnown: false` (a field rule).
- **`RUN_ENDED`** (success) requires no open step, and the outcome's phase must be the **last** phase, ended:

| Outcome | Last phase, end state | Cleanup key | Checkpoints |
|---|---|---|---|
| `ENDED_RESERVED_NOT_CAPTURED` | reservation, `reservation_confirmed` | `reservedNotConfirmed` | `AIRBNB_BLOCKED` |
| `ENDED_CAPTURED_NOT_RECORDED` | capture, `payment_captured` | `captured` | `AIRBNB_BLOCKED` |
| `ENDED_CONFIRMED` | recording, `confirmed` | `confirmed` | `AIRBNB_BLOCKED` |
| `ENDED_RELEASED`, no reservation existed (reservation failed) | cleanup, `authorization_released` | `null` | no `AIRBNB_REOPENED` |
| `ENDED_RELEASED`, a reservation existed and was cancelled | cleanup, `cancelled` | `null` | `AIRBNB_REOPENED` |
| `ENDED_RELEASED`, a reservation existed and still stands | cleanup, `authorization_released` | `reservedNotConfirmed` | no `AIRBNB_REOPENED` |

  The exact key per outcome is also a field rule (`OUTCOME_RULES`): `ENDED_RELEASED` allows only `null` / `reservedNotConfirmed`.
- Exactly one terminal record, which is last. Nothing after it (`APPEND_AFTER_TERMINAL`).
- An unfinished `STEP_STARTED` without a terminal record is **crash evidence, never permission to resume**.

**Action grammar (pinned from the accepted worker sources; whole-token, anchored).**

```
token := NAME (":" CODE){0,2} ("->" STATE)? | NAME "!" CODE
       | "READ:" OPTYPE (":" OUTCOME)? | "READ:PI" ("!" CODE)? | "READ:" ("ID"|"LIST") ":" CODE ((":"|"!") CODE)?
       | "READ:LEASE!" CODE | "READ!" CODE
       | "RECOVERY:READ:" (OPTYPE | "PI") | "RECOVERY:" REVENT ("!" CODE)? | "RECOVERY:ESCALATE" (":"|"!") CODE
       | "RECOVERY:REISSUE" ("!" CODE)? | "MAINTENANCE:" OPTYPE ":" OPSTATE
CODE  := [A-Za-z0-9_]{1,48}      (lowercase is needed for e.g. "ASSESSED:eligible")      max token length 160
NAME  := ACTION_NAMES (28 worker verbs)      STATE := INTENT_STATES (20)      OPTYPE := OPERATION_TYPES (13)
OPSTATE := OPERATION_STATES (7)      REVENT := RECOVERY_EVENTS (19 planner events)      OUTCOME := found|not_found|conflict|error|lease_lost
```

- **Pinning.** A test extracts every whole literal pushed to `actions` by the accepted workers + `recovery.js` (template substitutions removed) and asserts it is accepted. It also checks the templated forms as built by the workers, and near-miss refusals (suffix / prefix / bad state / extra segment / spaces / length).
- **Unknown tokens.** `projectActions` counts them, never copies them.

**Redaction and its limit.**
- Only bounded ids, codes, counts, states, hashes and `evidenceRef` are representable: there is no free-text, message, reply, guest or contact field.
- The grammar bounds **characters**. It cannot prove that an allowed reference (an `evidenceRef`, a `CODE`) holds no secret: a synthetic alphanumeric marker passes, as a test shows.
- Callers must never put secrets into these fields.

**Integrity.**
- The hash is `sha256(JOURNAL_HASH_PREFIX + canonicalJson(record))`. It is recomputed independently in the tests.
- The chain is integrity evidence **relative to a trusted head** (`{ seq, hash }`), not authentication. An **unanchored** chain proves only internal consistency: a complete consistent rewrite validates without a trusted head (tested and documented).
- Supplying the trusted head detects rewrite, truncation and deletion.

### 8.3 Crash windows (V1: none of them resumes)

| Window | DB | Next invocation |
|---|---|---|
| Before `RUN_STARTED` is acknowledged | unchanged | Journal empty or unacknowledged → see §8.4. The intent is still `payment_authorized` with no dispatched op → a fresh start is allowed only if the journal is empty |
| After `RUN_STARTED`, anywhere until a terminal record | committed or uncertain | `RESTART_AMBIGUOUS`, **no worker invocation**, even if the DB looks successful |
| After `RUN_STOPPED` / `RUN_ENDED` | — | `RUN_ENDED` |
| Journal append fails mid-run | — | `JOURNAL_FAILURE` now: no further step or append |
| Terminal append timed out (§7.7) | — | landed late → `RUN_ENDED`; never landed → `RESTART_AMBIGUOUS`; either way zero worker calls |
| Process exits with a STEP / TAIL outstanding | worker effects may be partial | the journal has `RUN_STARTED` (+ possibly a terminal record) → `RESTART_AMBIGUOUS` / `RUN_ENDED`; no resume |

### 8.4 Start / restart rule (V1) — IMPLEMENTED as pure `validateJournal` / `evaluateStart` (Slice D)

**`validateJournal(records, identity, { trustedHead }?)`.** Priority (first failure wins):
1. `IDENTITY_INVALID` (expected identity);
2. `TRUSTED_HEAD_INVALID` (opts);
3. `JOURNAL_MALFORMED` (any record's shape / fields, first bad `at` = seq position);
4. `MANIFEST_MISMATCH` (any record's identity);
5. `JOURNAL_CHAIN_INVALID` (`seq` contiguity / `prevHash`);
6. `JOURNAL_MALFORMED` (event order);
7. `TRUSTED_HEAD_MISMATCH` (`seq: 0` + `GENESIS_HASH` = "expected empty").

On success: `{ ok:true, status: 'EMPTY' | 'IN_PROGRESS' (openStep) | 'ENDED' (terminal), head, anchored }`.

**`evaluateStart(readResult, …)`** → frozen:

| Journal | Verdict |
|---|---|
| Empty | `{ ok:true, code:'EMPTY_JOURNAL', dbEligibilityRequired:true, anchored }`. The **only** start-permitting verdict, and only subject to the core's separate DB eligibility check (§6.1 P0). An empty journal alone authorizes nothing |
| `RUN_STARTED` without a terminal record | `RESTART_AMBIGUOUS`, with `interruptedStep: true` when a step is open |
| A terminal record | `RUN_ENDED` |
| Torn tail (SYNTHETIC `tail:'torn'`) | `JOURNAL_PARTIAL` |
| Another run / intent / manifest / baseline | `MANIFEST_MISMATCH` |
| Chain or `seq` break | `JOURNAL_CHAIN_INVALID` |
| Shape / grammar / order violation | `JOURNAL_MALFORMED` |
| Trusted head differs | `TRUSTED_HEAD_MISMATCH` |
| Bad expected identity / head / read result | `IDENTITY_INVALID` / `TRUSTED_HEAD_INVALID` / `READ_RESULT_INVALID` |

All refusals happen with **zero** worker, transport or attest calls. Neither function resumes, mints a run id or key, or touches the DB.

## 9. Implementation slices

### 9.1 Slice B: `run-guard` (deadline + lifecycle + wrappers), unit tests only — ACCEPTED at `86acc274`

The design was accepted at `49df87b0`; the code was ACCEPTED at `86acc274` after the R-B1–R-B3 corrections. Root's clarification tests were added beyond G1–W1: post-start faults, tie semantics, fractional readings, `trackClient` event orders, late-client handling, wrapper hostile / forged / late cases, no unhandled rejections, and pending-forever cases asserted after controlled fake progress.

**Allowed files (as authorized):**
- new `scripts/e7-connected/run-guard.mjs` (§2.2);
- new `test/e7-connected-run-guard.test.mjs`;
- a status pointer in this contract.

**Not allowed:**
- `run-facts` / `run-core` / `run-journal-memory`;
- worker imports, SQL text, PG tests or DB runs;
- accepted-module / lib / worker / SQL / fixture / config / package / pin edits.

**Module limits:**
- Pure: imports only `node:util` and the accepted adapter's `ExecutorRefusal`.
- No timers of its own, and no env / fetch / fs / SDK / pool / transport.

**Unit acceptance** (fake `monotonic` / `timers` / clients / lock handle / executor functions; global fetch guard):

| # | Case | Expected |
|---|---|---|
| G1 | `validateGuardDeps`: missing / extra keys; proxy or accessor `arm` / `monotonic`; invalid handles (extra key, non-native or proxied promise, own `then`, accessor `cancel`); `arm` throw | `GUARD_DEPS_INVALID` / `GUARD_TIMER_INVALID`; the guarded `start` is **never called**; no caller getter runs |
| G2 | monotonic throw / NaN / decrease | `GUARD_MONOTONIC_INVALID` before the next start |
| G3 | `remaining ≤ 0` | `EXPIRED_BEFORE_START`; `start` not called; nothing armed |
| G4 | op fulfils / rejects before the timer | outcome returned; timer cancelled; `armedCount() = 0` |
| G5 | hung op; the timer fires at the deadline | `timeout`; op retained; a late fulfilment / rejection is recorded but changes nothing; no unhandled rejection |
| G6 | **simultaneous**: the op rejects and the timer fires in the same turn (both orders) | rejection wins, deterministically |
| G7 | early timer fire (fake fires before the monotonic deadline), up to 3× and then 4× | re-armed for the remainder / `GUARD_TIMER_INVALID` |
| G8 | inter-step `wait` | fulfils at `min(delay, phaseRemaining)`; one arm, no residual timer |
| G9 | the delay argument is a safe integer 1…1 800 000; `arm` receives only that number | argument capture |
| L1 | lifecycle NONE → step fulfilled → tail settled → quiescent | `finalize` resolves `"unlocked"`; unlock called once, then destroy |
| L2 | **STEP → TAIL → quiescent**: step observation times out; later the step fulfils with a pending `late`; later `late` settles | `outstanding STEP` at return; `finalize` pending until `late` settles; then unlock; the result object unchanged |
| L3 | **STEP → rejection** with ledger `started === 0` / `> 0` | the late rejection puts disposal on the DB-family path: quiescent → `destroy()` only, `"destroyed"`, unlock never called / `finalize` **pending forever** (asserted pending after the fake clock advances arbitrarily), with no unlock and no destroy |
| L4 | TAIL timeout → `late` never settles | `finalize` pending forever; lock handle untouched |
| L5 | DB-family path, then quiescence | `destroy()` only; `unlock` **never** called; `"destroyed"` |
| L6 | **lock loss with an outstanding STEP** | `exclusion "lost"`; destroy called exactly once at loss; the step is still awaited; `finalize` → `"lost"` after quiescence; no unlock |
| L7 | unlock times out / returns `false` / rejects | `release(true)` (destroy) once; `destroyed_after_unlock_timeout` / `_failure`; no retry |
| L8 | `finalize()` called N times, concurrently and after resolution | the same promise; disposal steps run once |
| L9 | late-client handling: a connect that timed out, then resolves with a fake client / rejects | the fake client gets `release(true)` exactly once; **zero** `query` calls; rejection ignored |
| L10 | first-cause-wins flag recording (`TIMEOUT_STEP` + later lock loss; `DB_FAILURE` + terminal-journal timeout) | `stopCode` unchanged; flags set |
| W1 | wrappers: exact key set; identical promise object returned; sync throw rethrown identically; `ExecutorRefusal` code recorded; non-refusal not recorded; arguments / replies never read (proxy argument probes); `started` / `settled` ledger | as stated |
| P1 | purity source pin: no `setTimeout` / `setInterval` / `setImmediate` / `queueMicrotask` / `process.` / `fetch` / fs / pinned identifiers; exact import list | as stated |

Run the focused unit suite and `npm test`. No DB run.

### 9.2 Slice C: `run-facts` (snapshot + guest read + candidate derivation) — ACCEPTED at `0e8bd27a`

**Files.** `scripts/e7-connected/run-facts.mjs`, `test/db/e7-connected-run-facts.test.mjs` (disposable local PG), and this contract.

**Labels:**
- **PG enforcement** uses real `mv_booking_report` (`test_report`) and `mv_booking_app` (`test_app`) logins as the functions' clients; the owner is used only for test assertions.
- Real facts come from accepted repo functions and the accepted reservation worker, driven through the accepted adapters into the rehearsal's **synthetic** fake world (copied test-locally, labelled). The authorization is labelled fixture setup.
- **SYNTHETIC** cases are labelled per test: pure derivation on mutated copies, and fake clients for cap+1 / faults / marker.

**Acceptance (all pass):**

| Case | Evidence |
|---|---|
| Successful report snapshot + app guest read | 10 statements; deep-frozen; no guest / token / contact value in the facts; `NO_CANDIDATE` on a fresh booking |
| Roles | Report → guest read is a `DB_FAILURE` (permission denied, no message); app → snapshot `ROLE_NOT_REPORT`; owner → `ROLE_NOT_REPORT` / `ROLE_NOT_APP` |
| Identity / scoping across two intents | Each snapshot's ids equal exactly that intent's rows; an unknown intent → acknowledged `INTENT_NOT_FOUND` |
| RR barrier | A real accepted-worker step committed mid-snapshot is invisible to it (same version / ops / transitions); a later snapshot sees it |
| No-echo candidate (a) | Adopted id NULL; the lane derives each step's factory from run-facts and reaches `reservation_confirmed` with one create; then `NOT_RESERVATION_PHASE` |
| Lookup candidate (b) | Ambiguous create; lookup evidence joined to its read op / selector; open case present as a fact; one create |
| R-C1 / R-C2 corrections | See §2.3.5 (3 tests; red on `e081b1e4`, green now) |
| SYNTHETIC derivation | 27 cases (every `ok:true` asserted to carry a usable id): conflicts, protected refs (result / attempt / evidence / selector), open vs historical by-id selectors, attempt / late ids, pending create, identity mismatches, duplicate ref, association / consistency violations, malformed shapes |
| SYNTHETIC cap+1 | Each capped query → `FACT_LIMIT_EXCEEDED` after an acknowledged COMMIT; exactly `cap` rows accepted |
| SYNTHETIC faults | Rejection at each of the 10 statements (COMMIT included) and timeouts (BEGIN / INTENT / COMMIT): no later statement, no `release` / `end`, no message leak. Mid-sequence cap → destroy. Guard fault before the first statement → zero queries. Marker / role / malformed / foreign-id / non-result refusals |
| Native rule | A real `pg` query promise passes `isNativePromise` |

### 9.3 Slice D: `run-journal-memory` (offline unit) — ACCEPTED at `d5a93e0f`

**Files.** `scripts/e7-connected/run-journal-memory.mjs`, `test/e7-connected-run-journal.test.mjs` (17 unit tests after the R-D1 / R-D2 corrections; no DB, worker or network), and this contract.

**Acceptance (all pass):**
- Happy chain with independently recomputed heads / hashes.
- Caller mutation resistance.
- Every append refusal category with unchanged history.
- Order refusals: step before baseline, second `RUN_STARTED`, capture before `AIRBNB_BLOCKED`, phase skip, `REOPENED` without cleanup, first event not `RUN_STARTED`.
- Terminal rules: after-terminal, duplicate terminal, open step vs `RUN_ENDED` / `RUN_STOPPED` (truthful `NONE` / `TAIL` / `STEP`; never `effectsKnown`).
- R-D1: real accepted guard / lifecycle integration. R-D2: structural success / release paths, at the validator level and at append time (§2.5.1 errata).
- Two concurrent appends: `CHAIN_MISMATCH` / `APPEND_IN_FLIGHT`, no retry.
- Faults through the accepted guard with fake timers: `reject`, `hang` → timeout, `late` → timeout then lands → `RUN_ENDED`, `landed_hang` → timeout while present; read `reject` / `hang` / `torn` → `JOURNAL_PARTIAL`.
- Start verdicts, including empty ⇒ `dbEligibilityRequired` and interrupted step ⇒ `RESTART_AMBIGUOUS`.
- Identity mismatch per field; chain / `seq` edits.
- Complete rewrite: passes unanchored (documented limit); `TRUSTED_HEAD_MISMATCH` anchored; truncation / deletion detected.
- Hostile descriptors: 0 caller getter / iterator / `toJSON` / trap runs. Frozen / null-prototype controls accepted.
- Redaction: planted SYNTHETIC markers counted, never copied; grammar-limit demonstration.
- Grammar pinned to the worker literals and vocabulary parity.
- Purity / import pin; option validation; preload of a broken history.

**Routine pure-module choices (deviations from the revision-4 proposal, accepted with Slice D):**
1. The hash carries the literal `JOURNAL_HASH_PREFIX` (the manifest's convention); §8.2 previously said the plain sha256 of canonical JSON.
2. Added record fields: `STEP_ENDED.result` / `unlistedActions` (counted, never copied), and the terminals' `ownerCleanupRequired` / `writes` / `outcome` (`RUN_ENDED`).
3. The action grammar is broader than the revision-4 draft, because the accepted workers emit `NAME!CODE`, `READ:ID|LIST:…`, `MAINTENANCE:…`, `HOLD:…`, `RECOVERY:REISSUE…`. It stays whole-token and character-bounded.
4. `read()` resolves `{ records, tail }`, not a bare array, so a SYNTHETIC torn tail is expressible.
5. `createMemoryJournal` options are `{ identity, preload, faults }`, replacing revision 4's `{ failAt, hangAt, lateAt, preload }`.
6. `MAX_RECORDS` 1024.

### 9.4 Slice E — `run-core` + disposable-PG runner test (offline); AUTHORIZED at `ea830a62`, implemented (§13)

**Allowed files (proposed):**
- new `scripts/e7-connected/run-core.mjs`: `runConnectedTest`, `checkSameDatabase`, and the lock / same-DB SQL constants (§2.4, §12);
- new `test/db/e7-connected-runner.test.mjs`;
- a status pointer in this contract.

No change to A / B / C / D, adapters, workers, `lib/`, SQL, fixtures, config, packages or containment pins. No new grant, function or trigger.

**Test world.** A disposable local PG (`startMigratedDatabase`, real `test_report` / `test_app` logins), the accepted rehearsal's **synthetic** fake provider world copied test-locally (as in Slice C), and a **synthetic existing authorized intent** produced by accepted repo functions with a labelled mocked authorization (rehearsal `authorizedBooking`). The suite also uses D's memory journal, fake `monotonic` / `timers`, the business clock rule of §12.4, and a global fetch guard.

**Deterministic fault strategy.** No production hooks, no new grants, no trigger bypass, no raw lifecycle writes.

| Fault | How |
|---|---|
| Runner-side DB faults | A test-local pool **wrapper** (a class with prototype `connect` / `query`) whose clients forward to real `pg` clients. It rejects or hangs a statement selected by **exact runner SQL text** (§12.1 / §12.2 constants, C's `SQL.*` incl. `COMMIT`) |
| Worker-side DB faults | The same wrapper on `pools.app`, rejecting a worker statement (e.g. the worker's `releaseWork` UPDATE) after the executor started. This is a realistic DB error surfacing as a step rejection, not a worker hook |
| Provider faults | The fake world's modes: `ok`, `noEcho`, `appliedThen503`, and a create / capture raw that hangs, then resolves under test control |
| Lock faults | Another session holding `pg_advisory_lock(hashtext('e7-connected-runner'),0)` (test owner session) → `RUN_LOCK_HELD`. Lock loss via `pg_terminate_backend(<lock pid>)` from the owner, on the disposable DB only |
| Same-DB mismatch | A second disposable cluster (`startMigratedDatabase` again) behind `pools.app` |
| External actor | `capture_failed` through the accepted `applyEvent` between steps (labelled, as in `e74a-compensation-worker.test.mjs:157`) |
| Journal / attest faults | D's `reject` / `hang` / `late` / `landed_hang` / `torn`; a fake `attest` that declines, rejects, hangs or answers late |

**Focused acceptance matrix** (meaningful cases only; zero real provider calls; protected ids appear only as synthetic negative facts):

| # | Case | Expected |
|---|---|---|
| E1 | Invalid options / manifest / `intentId` mismatch | Refusal; zero DB / transport / journal / attest / timer calls |
| E2 | `checkSameDatabase`: second cluster; wrong role on either pool | `REFUSED: POOLS_MISMATCH` / `ROLE_NOT_REPORT` / `ROLE_NOT_APP`; zero workers; the lock destroyed or unlocked per §12.2 |
| E3 | Journal not empty (`RUN_STARTED` only; terminal; foreign; torn) | `RESTART_AMBIGUOUS` / `RUN_ENDED` / `MANIFEST_MISMATCH` / `JOURNAL_PARTIAL`; zero workers |
| E4 | Eligibility mismatch (ref / stay / amount / `rateBps` / currency) or a pre-existing write op / open case | P0 refusal before `RUN_STARTED` |
| E5 | Happy path, real-time clock | `ENDED_CONFIRMED`, key `confirmed`; exactly one write per type; journal chain valid under D with the exact §12.3 records; `finalize` → `unlocked` |
| E6 | `capture:false` / `recording:false` | `ENDED_RESERVED_NOT_CAPTURED` (key `reservedNotConfirmed`, `AIRBNB_BLOCKED` attested) / `ENDED_CAPTURED_NOT_RECORDED` (key `captured`) |
| E7 | No-echo create, same-step recovery (behind clock, `capture:false`) | Candidate (a) from persisted facts; a `reservation-recovery` factory bound to it; one create; ends reserved |
| E8 | Ambiguous create (`appliedThen503`) | `STOPPED: OPEN_CASE` before any capture call; key `reservedNotConfirmed`; zero capture transport calls |
| E9 | Reservation failed (price change) → void only | `ENDED_RELEASED`, key `null`, no `AIRBNB_REOPENED`, zero Hostaway cancel / create |
| E10 | External `capture_failed` → cleanup → `cancelled` | `AIRBNB_REOPENED` attested; `ENDED_RELEASED`, key `null` |
| E11 | Snapshot statement rejected; `COMMIT` rejected / hangs | `DB_FAILURE` / `TIMEOUT_DB_READ`; that client destroyed; **zero further runner SQL** (unlock included); `finalize` → `destroyed`; `countsAsOf.stale` |
| E12 | Step rejects before any executor start (worker DB fault) | `RUN_STOPPED`, outstanding `NONE`, no `STEP_ENDED`; `destroyed` |
| E13 | Step rejects after an executor start | outstanding `TAIL` (unobservable); `finalize` pending (asserted after fake progress); healthy lock never unlocked |
| E14 | STEP timeout → late fulfilment → tail settles | `TIMEOUT_STEP`, outstanding `STEP`, key ≥ `reservedNotConfirmed`; then quiescence → `unlocked` (waits up to the worker's real step budget) |
| E15 | Post-result tail never settles | `LATE_TAIL_OUTSTANDING` after a logged `STEP_ENDED`; outstanding `TAIL`; `finalize` pending |
| E16 | Lock held by another session; lock lost between steps; lock lost with an outstanding STEP | `RUN_LOCK_HELD`; `LOCK_LOST` at the next boundary; `exclusion: lost`, `finalize` → `lost` |
| E17 | Lock connect late client; try-lock timeout; unlock timeout | Late client destroyed, never queried; `TIMEOUT_DB_LOCK`; `destroyed_after_unlock_timeout` |
| E18 | Journal append fails mid-run (each of `RUN_STARTED`, `STEP_STARTED`, `STEP_ENDED`) | `JOURNAL_FAILURE` / `TIMEOUT_JOURNAL`; no further append (`journalTerminal: not_attempted`); no further step |
| E19 | Terminal append `late` / `landed_hang` | `journalTerminal: unknown`; the next invocation → `RUN_ENDED` (landed) / `RESTART_AMBIGUOUS` (not landed); zero workers |
| E20 | Attest declined / rejected / hangs (`CALENDAR_BASELINE`; `AIRBNB_BLOCKED`) | `OWNER_DECLINED` / `ATTESTATION_FAILED` / `TIMEOUT_ATTEST`; no create (baseline) / no capture (blocked) |
| E21 | Signal aborted during a step | The step is observed to its end, then `CANCELLED`; the worker is never interrupted |
| E22 | Phase budget cannot cover the next step deadline | `BUDGET_EXHAUSTED`; the step not started |
| E23 | Source pins | Exact imports (§2.0 / §12), no runner timers / env / fs / fetch, no pinned identifiers |

**Validation for Slice E.** The focused PG file plus the A / B / C / D unit suites, the containment pins and `npm test`. The full `test:db` only if a focused result reveals a wider concern. Any e74a reproduction → FIRST FULL TAP and STOP, never rerun green.

## 10. Owner decisions (UNSET; not needed for the offline slice)

1. Listing (with its ref field and time zone) and currency.
2. Dates, guest and amount.
3. Pricing rate (must equal the booking's).
4. Verified Stripe TEST account and Hostaway account.
5. `paymentMethod`.
6. Provider mode and phase scope.
7. Hostaway / Airbnb automation scope.
8. The cleanup procedure for every outcome.

Routine technical choices (budgets, journal format, lock key, file layout) are root's.

## 11. Resolution of the root re-review items A–D (`08b107e4`)

These replace the revision-3 OPEN list. Root accepted the design at `49df87b0`, and B / C / D implement it (accepted). The core itself is still **not implemented and not authorized** (§9.4, §12).

| Item | Resolution | Status |
|---|---|---|
| A. Import boundary | §2.0: the four worker entrypoints + transitive dependencies, the adapters, the manifest, pure constants and Node built-ins. No new pinned-Hostaway importer, no pin / worker change, no worker injection, no copied worker code | **CLOSED** (root decision) |
| B. Deadline wake-up | §7.2: one injected `timers.arm(delayMs) → { promise, cancel }` alongside `monotonic`. Exact validation, the arm-before-start rule, operation-beats-timer settlement, early-fire re-arm, cancellation cleanup, the inter-step wait expressed through the same API, no runner timers. Fake-timer tests G1–G9 | design ACCEPTED; implemented in Slice B (§2.2) |
| C. STEP vs TAIL; finalize | §7.3 / §7.6: NONE / STEP / TAIL (observable or not). A retained step promise, then its `late`, then a ledger drain. One memoized, never-rejecting `finalize` that waits for quiescence with no escape and can stay pending forever. It never mutates the result, refreshes counts, retries or appends | design ACCEPTED; implemented in Slice B (§2.2) |
| D. Ownership / late completion / lock | §7.4 table (every await), §7.5 exclusion / loss, §7.6 release paths, §7.7 priority. Late connects destroyed, never queried; bounded acquire / unlock; no runner SQL after the DB family; a healthy lock session kept while work is outstanding; lock loss reported as lost | design ACCEPTED. Guard-side helpers are implemented in Slice B (§2.2); the core's SQL use is not authorized |

Source citations: accepted code (workers, adapters, A at `cc5d877d`, B at `86acc274`, C at `0e8bd27a`, D at `d5a93e0f`) is cited by file:line at `d5a93e0f`. The only unimplemented module is `run-core.mjs` (§2.4, §9.4, §12).

## 12. Core integration map (revision 8; exact accepted interfaces at `d5a93e0f`)

This section is the source-cited plan for `run-core.mjs` (Slice E, §9.4). It uses only the accepted interfaces:
- **A** `validateRunManifest` (`run-manifest.mjs:169`);
- **B** `validateGuardDeps` / `createGuard` / `createLedger` / `wrapExecutors` / `trackClient` / `createLifecycle` (`run-guard.mjs:99`, `:116`, `:281`, `:323`, `:353`, `:386`), the guard's `observe` / `wait` (`:215`, `:244`), and the lifecycle's `observeStep` / `observeTail` / `observeConnect` / `attachLock` / `lockLost` / `finalize` / `stop` / `markDbFamily` (`:431`, `:458`, `:471`, `:485`, `:496`, `:504`, `:540`, `:542`);
- **C** `readRunSnapshot` / `readGuestBinding` / `deriveRecoveryCandidate` (`run-facts.mjs:214`, `:289`, `:315`);
- **D** `projectActions` / `evaluateStart` / `PHASE_END_STATES` / `OUTCOME_RULES` (`run-journal-memory.mjs:170`, `:404`, `:88`, `:94`) and the journal `append` / `read` interface;
- the adapters' `createPhaseExecutors` / `BINDING_KEYS` (`executor-adapters.mjs:418`, `:60`).

**Import notes.**
- `run-core.mjs` imports the four worker entrypoints and the worker timeout constants `DEFAULT_TIMEOUTS` / `CAPTURE_DEFAULT_TIMEOUTS` / `RECORDING_DEFAULT_TIMEOUTS` / `CLEANUP_DEFAULT_TIMEOUTS` (`reservation-worker.js:78`, `capture-worker.js:51`, `recording-worker.js:32`, `compensation-worker.js:51`). That is within the §2.0 import boundary.
- It does **not** import the pinned Hostaway module: each worker gate calls `validateAdapterConfig` itself, and that accepts a plain non-pilot config object (`hostaway-reservations.js:202–214`; gates `reservation-worker.js:133`, `capture-worker.js:81`, `compensation-worker.js:81`).
- The only SQL text in `run-core.mjs` is the same-DB statement (§12.1) and the two advisory-lock statements (§12.2). All other DB access goes through C or through the workers.

### 12.1 `checkSameDatabase` — what can actually be established

**Placement.** In `run-core.mjs`, at P0, after the run lock is held (§12.2) and before the journal read. Both statements are guarded by `guard.observe(min(now + STATEMENT_MS, p0Deadline), …)`.

**Statement (identical on both clients; read-only; no transaction; no new grant, function or schema):**

```sql
SELECT i.environment, i.created_at::text AS created_at, current_database() AS db, pg_postmaster_start_time()::text AS started,
       inet_server_port() AS port,
       pg_has_role(current_user, 'mv_booking_report', 'MEMBER') AS is_report,
       pg_has_role(current_user, 'mv_booking_app', 'MEMBER') AS is_app,
       (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) AS privileged
  FROM booking.instance i
```

**Order:**
1. **S1, on the held lock client** (`pools.report`). Exactly 1 row is required. `environment = 'test'` (else `DATABASE_NOT_TEST`). `is_report AND NOT is_app AND NOT privileged` (else `ROLE_NOT_REPORT`).
2. **S2, on one fresh app client** (`lifecycle.observeConnect(…, () => pools.app.connect(), c => c.release(true))`, tracker installed, §12.2). Exactly 1 row. `environment = 'test'`. `is_app AND NOT is_report AND NOT privileged` (else `ROLE_NOT_APP`).
3. **Compare.** `created_at` (as text, so microseconds are kept), `db`, `started` and `port` must all be equal and non-null, except `port`, which is null on both for a socket connection. Otherwise `REFUSED: POOLS_MISMATCH`.
4. The app client is returned with `release()` after S2 is acknowledged, and `release(true)` on any failure.

**Grants.**
- Both roles can read `booking.instance` (`0002:23`, `:36–40`; RLS `0002:49–51`).
- `current_database()`, `pg_postmaster_start_time()`, `inet_server_port()`, `pg_has_role()` and `pg_roles` are ordinary catalog functions / views available to every role. Slice E's PG test proves this with the real `test_report` / `test_app` logins.

**Limitation (stated, not hidden).**
- The check proves that both pools see **the same marker row, database name, server start time and port**.
- That is **not** a global cluster identity. Two databases restored from one dump share `created_at`. Distinct clusters can coincide in name / port.
- The cluster's `system_identifier` (`pg_control_system()`) is **not used**: this schema grants nothing on it, and its availability depends on server defaults / monitoring roles, which would be a new privilege assumption.
- The check therefore catches **accidental** misconfiguration only. It makes **no security claim** about caller-supplied pools: a caller who controls both pools can make them agree.
- Every worker still re-checks the `test` marker on the pool it is given (`pool.js:73`, `recording-worker.js:606–607`).

**Failure.** Fail closed: any rejection, timeout or guard fault → the DB family (§7.1), with no further runner SQL (§12.2). Any refusal happens before `RUN_STARTED`, with zero worker calls.

### 12.2 Client and lock ownership, end to end (exact per-boundary guard use)

`now` = `guard.now().value`. Every deadline is absolute and also capped by the phase budget at boundaries (§7.2).

| # | Boundary | Exact call | Owner / disposal | On failure |
|---|---|---|---|---|
| 1 | Options, manifest, guard | Snapshot the `opts`; `validateRunManifest(opts.manifest)`; `validateGuardDeps({ monotonic, timers })` → `createGuard` → `createLifecycle({ guard })` | Nothing is acquired | `OPTIONS_INVALID` / manifest code; zero I/O |
| 2 | Lock client connect | `lc.observeConnect(now + CONNECT_MS, () => pools.report.connect(), c => c.release(true))` | A late client is destroyed by B, never queried (`run-guard.mjs:471–482`) | `REFUSED: TIMEOUT_DB_CONNECT` / `DB_FAILURE` |
| 3 | Tracker | Immediately, before any query: `trackClient({ subscribe: (e, h) => c.on(e, h), unsubscribe: (e, h) => c.removeListener(e, h), destroy: () => c.release(true), onLoss: () => lc.lockLost() })` | The tracker owns destruction (once; a deliberate destroy is never a loss) | Subscribe failure → `REFUSED: DB_FAILURE` (B destroyed the client) |
| 4 | Advisory lock | `guard.observe(now + LOCK_ACQUIRE_MS, () => c.query("SELECT pg_try_advisory_lock(hashtext($1), 0) AS ok", ["e7-connected-runner"]))`. `ok === true` → `lc.attachLock({ unlock: () => c.query("SELECT pg_advisory_unlock(hashtext($1), 0) AS ok", ["e7-connected-runner"]).then((r) => r.rows[0].ok === true), destroy: () => tracker.destroy() })`. The `.then` result is an unpatched native promise, as B requires | One **session** lock on this dedicated client, held until `finalize` | `false` → `REFUSED: RUN_LOCK_HELD` + `tracker.destroy()`; rejection / timeout / fault → `tracker.destroy()` (the server releases any granted lock with the session), `REFUSED: DB_FAILURE` / `TIMEOUT_DB_LOCK` |
| 5 | Same-DB check | §12.1 S1 on the lock client, S2 on a fresh app client (boundaries 2–3 pattern, its own tracker with `onLoss: () => {}`) | The app client: `tracker.dispose()` then `release()` when healthy; `tracker.destroy()` on failure | DB family → `lc.markDbFamily()`; `finalize` will **destroy** the lock client, never unlock |
| 6 | Journal read + start rule | `guard.observe(now + JOURNAL_MS, () => journal.read())` → `evaluateStart(result, identity, { trustedHead })` | Caller-owned journal | Not `EMPTY_JOURNAL` → `REFUSED: <D code>` (no resume); read failure → `JOURNAL_FAILURE` / `TIMEOUT_JOURNAL` |
| 7 | Every snapshot | `lc.observeConnect(now + CONNECT_MS, () => pools.report.connect(), …)` + tracker → `readRunSnapshot({ client, intentId, guard, deadline: now + SNAPSHOT_MS })` | Per C's `clientDisposition`: `healthy` → dispose + `release()`; `destroy` → `tracker.destroy()` + `lc.markDbFamily()`; `unused` → dispose + `release()` | `refusal` → STOP with C's code; `db` → STOP with C's DB code. No retry, no refresh |
| 8 | Guest binding (reservation steps only) | The same pattern on `pools.app` → `readGuestBinding(…)` | The same | The same |
| 9 | Worker step | `lc.observeStep({ phase, deadline: now + stepBudgetMs + STEP_MARGIN_MS, ledger, start: () => runX(pools.app, opts) })` | **The worker owns its own `pools.app` queries and `withTx` clients** (`repo.js:33–34`), including maintenance, `releaseWork` and late-evidence writes. The runner never touches them and cannot stop them; after a timeout or rejection they may keep running against `pools.app` | §12.3 open-step stops |
| 10 | Post-result tail | `lc.observeTail(now + TAIL_OBSERVE_MS)` | The worker's evidence writes; the runner only observes | `LATE_TAIL_OUTSTANDING` |
| 11 | Inter-step wait | `guard.wait(now + min(result.delayMs, phaseRemaining))` | Timer only | Guard fault → STOP `GUARD_*` |
| 12 | Attest | `guard.observe(now + ATTEST_MS, () => attest(cp, request, { signal }))` | Caller-owned | `TIMEOUT_ATTEST` / `OWNER_DECLINED` / `ATTESTATION_FAILED` |
| 13 | Journal append | `guard.observe(now + JOURNAL_MS, () => journal.append(record))` | Caller-owned | §12.3 |
| 14 | Disposal | `result.finalize` = `lc.finalize()` | Waits for quiescence. Then: healthy → one bounded unlock + destroy; DB family / broken guard → destroy only; lost → nothing (`run-guard.mjs:504–537`) | Never rejects; may stay pending forever |

**DB-family rule.** After any `DB_FAILURE` / `TIMEOUT_DB_*` / a C `destroy` disposition / a step rejection (B sets `dbFamily` itself), the runner issues **no further SQL**: no snapshot, guest read, same-DB statement, count refresh, rollback or unlock. It starts no worker. Clients it owns are destroyed locally.

**Lock loss.** A lock-client `error` / `end` triggers `lc.lockLost()` through the tracker. The next boundary stops `LOCK_LOST`, and an outstanding STEP / TAIL is still observed. The lock coordinates compliant runners only; it is never a worker fence.

**Pools.** Pools are caller-owned. A caller must not end `pools.app` while `finalize` is pending, because worker work may still be using it.

### 12.3 Journal emission map (exact D records)

**Identity:** `{ runId: manifest.runId, intentId, manifestHash: hash, baselineCommit: manifest.baselineCommit }`. Every record carries `v`, `seq`, `prevHash`, the identity and `at = clock()`. The runner computes `seq` / `prevHash` from its own last **acknowledged** head (`append` resolves `{ seq, hash }`).

**Emission order:**

| When | Record |
|---|---|
| P0 complete: lock + same-DB + `EMPTY_JOURNAL` + eligibility snapshot (§6.1) all acknowledged | `RUN_STARTED` |
| `attest('CALENDAR_BASELINE')` → `ok:true` + `evidenceRef` | `ATTESTED { checkpoint, evidenceRef }` |
| Each step: pre-step snapshot → candidate / gates → guest read → factory → **then** | `STEP_STARTED { phase, step, factory: { phase: 'reservation' \| 'reservation-recovery' \| 'capture' \| 'recording' \| 'cleanup', reservationId } }` |
| The step **fulfilled**, its tail settled, and the post-step snapshot acknowledged (that snapshot is also the next step's pre-step basis) | `STEP_ENDED { phase, step, result: value.status ('worked' \| 'idle' \| 'refused'), state: post.intent.state, ...projectActions(value.actions), refusals: ledger.snapshot().refusals, writes: counts(post) }` |
| The step fulfilled but the post-step snapshot failed, or the tail timed out | `STEP_ENDED { …, state: null, writes: last acknowledged }`, then `RUN_STOPPED` (DB code / `LATE_TAIL_OUTSTANDING`) |
| Post-step state ∈ `PHASE_END_STATES[phase]` and no stop rule fired | `PHASE_ENDED { phase, state }`. D requires `state` = this last `STEP_ENDED.state` |
| Reservation ended `reservation_confirmed` | `attest('AIRBNB_BLOCKED')` → `ATTESTED`, then capture (iff `phases.capture`) or `RUN_ENDED ENDED_RESERVED_NOT_CAPTURED` (key `reservedNotConfirmed`) |
| Capture ended `payment_captured` | Recording (iff `phases.recording`) or `RUN_ENDED ENDED_CAPTURED_NOT_RECORDED` (key `captured`) |
| Recording ended `confirmed` | `RUN_ENDED ENDED_CONFIRMED` (key `confirmed`) |
| Reservation ended `reservation_failed` → cleanup ended `authorization_released` | `RUN_ENDED ENDED_RELEASED`, key `null`, no re-open (no reservation existed) |
| Capture ended `capture_failed` → cleanup ended `cancelled` | `attest('AIRBNB_REOPENED')` → `ATTESTED`, then `RUN_ENDED ENDED_RELEASED`, key `null` |
| A reservation existed and cleanup ended `authorization_released` (D's third released path) | **Not reachable through the E3 machine.** From `capture_failed`, a void or an authorization-gone read only settles one leg (`intent-state.js:505`, `:572`), and `authorization_released` is entered only from `reservation_failed` (`:506`, `:573–574`) or an owner resolution with `noReservation` (`:616–618`). If ever observed, the core stops `STATE_UNEXPECTED` with key `reservedNotConfirmed`. D's structural permission is left unchanged |

**Failure stops (always `RUN_STOPPED`; the first cause wins via `lc.stop`):**
- **Open logged step.** The step's observation ends `rejected`, `timeout` or `observation_failed`. **No `STEP_ENDED` is written.** `outstanding = lc.snapshot().outstanding`:
  - `NONE`: rejected before any executor start;
  - `TAIL`: rejected after ≥ 1 start (unobservable);
  - `STEP`: timeout.

  `effectsKnown:false` (D refuses anything else with an open step).
- **Between steps** (snapshot / gate / attest / lock / signal / budget): `RUN_STOPPED { code, outstanding:'NONE', effectsKnown:false whenever counts are stale, … }`.
- **All stops:** `ownerCleanupRequired` follows the conservative §6.2 rule from the last acknowledged facts plus the open phase. `exclusion` = `lc.snapshot().exclusion` (`held` / `lost`). `writes` = last acknowledged.

**Journal failure.**
- Any append whose observation is not `fulfilled` → `lc.stop(JOURNAL_FAILURE | TIMEOUT_JOURNAL | GUARD_*)`. **No later append, including the terminal record** (`journalTerminal: 'not_attempted'`).
- The terminal record is attempted **exactly once**, only if no journal failure occurred. Acknowledged → `'acknowledged'`. Timeout / rejection / fault → `'unknown'`.
- An unacknowledged append may still land late (D `late` / `landed_hang`). The next invocation sees `RUN_ENDED` or `RESTART_AMBIGUOUS`, either way with zero worker calls.

**No resume.** Any non-`EMPTY_JOURNAL` verdict refuses before `RUN_STARTED`. The core never mints a new run id or key, never skips a recorded step, and never treats an empty journal as authority without the P0 DB eligibility check.

### 12.4 Per-step immutable bindings and worker options

**Fresh per step.** Each step uses that step's frozen pre-step facts (C) to build a new binding, which `createPhaseExecutors` validates and freezes (`executor-adapters.mjs:418`). A new `createLedger()` is wrapped with `wrapExecutors` (B), so there are no mutable bindings across steps.

**Bindings** (`BINDING_KEYS`, `executor-adapters.mjs:60–66`):

| Phase | Binding fields (source) |
|---|---|
| `reservation` / `reservation-recovery` | `listingId` = `facts.intent.listingId`; `arrivalDate` / `departureDate` = `intent.from` / `intent.to`; `ref` = `intent.ref`; `guests`; `totalMinor` = `intent.finalTotalMinor`; `currency` = `intent.currency` (`'USD'`); `refFieldId` = `manifest.listing.refFieldId`; `guest` = `readGuestBinding().guest` (memory only; never journaled); `reservationId` = `deriveRecoveryCandidate(facts)`: `ok` → `id` (factory `reservation-recovery`); `NO_CANDIDATE` → `null` (factory `reservation`); any other code → STOP with that code |
| `capture` | Common fields + `reservationId` = `intent.hostawayReservationId`; `accountId` = `manifest.stripeAccountId`; `paymentIntentId` = `intent.stripePaymentIntentId`; `amountMinor` = `intent.finalTotalMinor`; `captureIdempotencyKey` = the **single** `stripe.capture_payment_intent` op's `payload.providerIdempotencyKey` (C payload allowlist). Zero or > 1 capture ops → `STATE_UNEXPECTED` |
| `recording` | `listingId`, `reservationId`, `intentId`, `amountMinor` = `intent.capturedMinor`, `paymentMethod` = `manifest.paymentMethod`, `accountRef` / `clientSnapshotId` = `manifest.hostawayAccountLabel` |
| `cleanup` | Common fields + `reservationId` = `intent.hostawayReservationId` or `null`; `accountId`; `paymentIntentId`; `voidIdempotencyKey` = the latest `stripe.void_payment_intent` op's `payload.providerIdempotencyKey`. No void op → `STATE_UNEXPECTED` |

**Worker options** (real imported workers; no injection; no copied code):

| Worker | Options |
|---|---|
| Reservation | `runOrchestratorStep(pools.app, { workerId:'e7r-res', env:{ VERCEL_ENV:'development', MV_E7_RESERVATION_WORKER:'enabled', DIRECT_DISCOUNT_BPS:String(manifest.pricing.rateBps) }, adapterConfig:{ allowedListingIds:[id], refFieldId, channelId:2000, currency:'USD' }, listings:new Map([[id, { currency:'USD' }]]), executors, clock, intentId })`. The rate is A's validated 0..5000 (`direct-policy.js:19–31`) and is checked equal to `facts.intent.rateBps` at P0 |
| Capture | `runCaptureStep(pools.app, { workerId:'e7r-cap', env:{ …, MV_E7_CAPTURE_WORKER:'enabled' }, adapterConfig, listings, executors, clock, stripeAccountId, intentId })` |
| Recording | `runRecordingStep(pools.app, { workerId:'e7r-rec', env:{ …, MV_E7_RECORDING_WORKER:'enabled' }, listings:new Map([[id, { accountRef, channelId:2000, currency:'USD', listingId:id, paymentMethod, refFieldId }]]), executors, clock, intentId })`. The gate checks the label against `accountRef` (`recording-worker.js:74–86`) |
| Cleanup | `runCleanupStep(pools.app, { workerId:'e7r-cln', env:{ …, MV_E7_COMPENSATION_WORKER:'enabled' }, adapterConfig, listings:new Map([[id, { currency:'USD', timeZone }]]), executors, clock, stripeAccountId, intentId })` |

**Gates before every capture / recording step** (the runner's, since the capture worker has no open-case check):
- **Stop before capture** on any open case (`OPEN_CASE`).
- Stop on any write op in `outcome_unknown` / `escalated` (`UNKNOWN_WRITE`), or `in_flight` with `dispatched_at` (`UNKNOWN_WRITE`).
- Stop on any protected reference (`PROTECTED_REFERENCE`).

Scenario C's create stays `outcome_unknown` with an open `HOSTAWAY_CREATE_OUTCOME_UNKNOWN` case even after `reservation_confirmed` (rehearsal C). The run therefore stops before any capture call.

**After every step:**
- recorded refusals → `ADAPTER_REFUSED` / `RECOVERY_BINDING_UNAVAILABLE`;
- `READ:<type>:error` → `READ_FAILED`;
- `value.status === 'refused'` → `STEP_REFUSED`;
- state outside the phase's work and end states → `STATE_UNEXPECTED`.

**Waits, tails, finalize.**
- Step deadline = `now + <worker>_DEFAULT_TIMEOUTS.stepBudgetMs + STEP_MARGIN_MS` (45 / 45 / 60 / 45 s + 30 s). A step starts only if the phase budget covers that deadline.
- Inter-step `guard.wait(min(delayMs, phaseRemaining))`.
- Post-result `observeTail(TAIL_OBSERVE_MS)`.
- One `finalize` (B).

**Concurrency limitations (explicit).**
- The pre-step snapshot is a **basis, not a fence**. Inside the step, the worker's own maintenance / recovery pass may queue and claim reads on facts newer than the snapshot (`reservation-worker.js:603–605`).
- A by-id read for an id the binding does not hold is refused by the adapter (`RESERVATION_UNBOUND`) → STOP. A by-id read for the **same** candidate is the accepted same-step path (§5.2).
- Other actors (webhooks, owner tools) are not excluded by the run lock. The post-step snapshot is authoritative for the next decision only.

**One business clock (constraint, not a new decision).**
- `opts.clock` goes to all four workers.
- **Caller precondition:** it never runs ahead of real (DB) time. The accepted rehearsal applies the same rule ("only advanced, never past real time", `e7-connected-adapter-rehearsal.test.mjs:15–16`). The core adopts it as a precondition, not as a claim about a specific DB check.
- Recording refuses unless the clock is within 2 s of the DB clock (`recording-worker.js:35`, `:611–612`).
- Reservation-recovery proofs need evidence observed ≥ 2 min after dispatch (`recovery-plan.js:30`).
- So a run that needs recovery reads **and** reaches recording needs real elapsed time.
- The accepted rehearsal used **two** clocks: an injected behind-real-time clock for reservation / capture / cleanup, and the real clock for recording (`e7-connected-adapter-rehearsal.test.mjs:15–16`). The core keeps the contract's **one** clock (simpler, and one business time per run). Offline tests therefore split scenarios:
  - recovery-read scenarios use a clock that starts behind real time, advanced with the fake timers and capped at real time, and stop before recording;
  - recording scenarios use a real-time clock and no recovery reads.

**`capture_failed` (source fact).** The accepted capture worker never emits `CAPTURE_FAILED`; that is out of its scope (`capture-worker.js:10`). The capture → cleanup path is therefore reachable only if another actor applies it. The core handles it when observed (`PHASE_ENDED capture capture_failed` → cleanup). Slice E tests it by a **labelled external-actor simulation** through the accepted `applyEvent` (as `e74a-compensation-worker.test.mjs:157` does), never by a trigger bypass.

### 12.5 Blockers and routine recommendations

**Genuine blockers for the offline Slice E.** None remain beyond root DESIGN acceptance of this revision and authorization of Slice E.

**Stated limits** (not blockers; each is documented above):
- the same-DB check is not a cluster identity (§12.1);
- `capture_failed` is reachable only by another actor (§12.4);
- D's third released path is unreachable through the E3 machine (§12.3);
- the clock constraints (§12.4);
- worker-internal real timers mean STEP-timeout tests wait up to the worker's own step budget in real time (≤ 60 s) before `finalize` quiesces.

**Routine technical choices (root's; not owner decisions):**
- the lock key `'e7-connected-runner'` (`hashtext`, key2 `0`);
- worker ids `e7r-*`;
- the phase budgets and step caps in §6.1;
- `trustedHead` passed through, `null` in offline tests;
- `attest` request content;
- `writes` counting from `dispatched_at`.

**Before any real run** (all CLOSED): real transports with proven zero automatic retries, a credential loader, Stripe TEST ingress, a file journal, a live CLI, read-only provider probes (cancel / offline-charge mappings remain LIVE-UNVERIFIED), the pilot containment decision (§3.3) and every owner decision (§10).

## 13. Slice E implementation record (revision 9; offline; pending root CODE review)

**Files (exactly three):** new `scripts/e7-connected/run-core.mjs`; new `test/db/e7-connected-runner.test.mjs`; this contract. No change to A / B / C / D, adapters, workers, `lib/`, SQL, grants, fixtures, config, packages or containment pins. No CLI, file journal, real transport, credential loading or ingress.

**Exports:** `runConnectedTest(opts)` (§2.4), `checkSameDatabase(s1Rows, s2Rows)` (the pure §12.1 comparison; the two statements are issued by `runConnectedTest`), `SQL` (`LOCK`, `UNLOCK`, `SAME_DB`, the only SQL text in the module), `LOCK_KEY`, `PHASE_LIMITS`, `IDLE_WAIT_MS`, `P0_BUDGET_MS`, `RUN_CORE_VERSION`. Imports: A, B, C, D, the adapters, the four worker entrypoints + their `*_DEFAULT_TIMEOUTS`, `node:util` (E23 pins the exact list).

### 13.1 Root binding clarifications (ACCEPTED rev 8 → Slice E), as implemented

1. **Absolute deadlines.** Every await is `guard.observe / wait / lc.observeTail / observeConnect / observeStep` with an ABSOLUTE monotonic deadline = `now + bounded duration`, capped by the current phase budget (`deadline(ms)` helper; the step deadline is `min(now + stepBudgetMs + STEP_MARGIN_MS, phaseDeadline)`). A failed `guard.now()` is never used: the helper returns null and the run stops with the guard's code. An invalid business-clock reading at an append stops `CLOCK_INVALID` (no append).
2. **Basis, not fence.** A post-step snapshot is reused as the next pre-step basis only when no wait / attestation / other awaited external boundary happened in between (`delayMs = 0` and not idle). After every wait and every attestation a FRESH C snapshot is taken before deciding to start the next step; after `AIRBNB_BLOCKED` it is gated strictly (open case, any `in_flight` / `outcome_unknown` / `escalated` write, protected refs) before capture — and also on the `capture:false` end path. The strict gate runs before every capture / recording step (the conservative reading of §6.1 vs §12.4: ANY `in_flight` write, not only dispatched ones). No network inside a DB transaction (C's read-only transaction never overlaps a worker or transport call).
3. **Bindings.** Capture / cleanup Common = exactly `listingId, arrivalDate, departureDate, ref`; every binding is built field by field from that step's frozen facts. The journal carries only D's projected action tokens, the unlisted-action COUNT, refusal `{ key, code }` (≤ 16), counts and states: never guest values, raw replies / errors, executor arguments or unlisted actions (E5 asserts no guest value in any record).
4. **finalize.** `result.finalize` is `() => lc.finalize()` (B's same memoized promise; E2/E5 assert identity). It is never called by the core; the bounded RunResult is returned first. The lock client is retained for STEP / TAIL (E13 asserts it is neither unlocked nor released while finalize is pending). Late callbacks never append or mutate the frozen result (E14).
5. **Pre-attach loss.** The lock client's tracker `onLoss` sets a core flag before `attachLock`; after the try-lock the core checks `tracker.state()` and the flag, and on loss destroys once (idempotent tracker) and refuses `LOCK_LOST` with zero further SQL (E16 "lost before attach": the real lock statement succeeded, then the session was terminated before the runner attached it). Losses during P0 setup and after attachment are tested too. Healthy clients: `tracker.dispose()` then `release()` (E2/E5 assert the event order). DB family: local `release(true)`, `markDbFamily`, and no further runner SQL, unlock included (E11). Worker-owned SQL after a step timeout / rejection is outside this rule (labelled in the module header and §12.2 row 9).
6. **Accounting.** The conservative key comes from acknowledged facts + the open phase (+ the cleanup entry key), never from `phases` flags; an unused phase cannot lower it. One fresh `createPhaseExecutors` + `createLedger` + `wrapExecutors` per step; no resume, no new key, no retry. Phase / state success only from acknowledged C snapshots and exact D emission (`validateRecord` before each append; the head advances only on an acknowledgement whose `{seq, hash}` equals the record's). A rejected / timed-out append sets "no later append" (terminal included). The terminal is attempted once; an unacknowledged terminal is reported `journalTerminal:'unknown'`, never repaired.

### 13.2 Deviations / routine choices (for review)

- **D1 `effectsKnown` on STOP** is computed (§6.2 list: false on outstanding / rejected / open step, stale counts, DB family, or an unknown write in the last facts), not hard-coded false; e.g. `OWNER_DECLINED` at `CALENDAR_BASELINE` journals `effectsKnown:true`, key null.
- **D2 Key null only per §6.2:** once a phase has started, a null key is raised to `reservedNotConfirmed` unless effects are known, no create op is beyond `pending`, and no reservation work is outstanding / rejected.
- **D3 P0 eligibility order:** protected / malformed candidate codes first, then state / write ops / open case → `INTENT_NOT_ELIGIBLE`, then any other candidate code. (First full TAP showed the earlier order surfaced C's `NOT_RESERVATION_PHASE` for an ineligible intent; corrected — see §13.3.)
- **D4 Strict gate scope:** reservation and cleanup steps are NOT gated on open cases / unknown writes (the accepted recovery path runs with an `outcome_unknown` create and an open case — rehearsal C); they keep the protected / malformed stop and §12.4 binding codes. Strict gates: before capture / recording steps and after `AIRBNB_BLOCKED` (incl. `capture:false`, where an open case therefore stops `OPEN_CASE` rather than ending reserved).
- **D5 Between phases** (attestations, terminal append) no phase deadline applies; each await keeps its own `LIMITS` bound. P0 has its own 60 s budget.
- **D6 Idle wait:** a worker result `idle` with no `delayMs` waits `IDLE_WAIT_MS` (5 s) before the next fresh snapshot.
- **D7 Pre-step end state:** entering capture with `capture_failed` already set (external actor) runs ONE capture step (it idles) so `PHASE_ENDED capture capture_failed` is legal in D; then cleanup.
- **D8 Tail failure:** `STEP_ENDED { state:null, writes: last acknowledged }`, then `RUN_STOPPED LATE_TAIL_OUTSTANDING` (E15), as §12.3.
- **D9 OPTIONS_INVALID / manifest refusals** return a reduced frozen result `{ ok:false, outcome:'REFUSED', stopCode, phase:'P0', finalize }` (no lifecycle exists yet; zero I/O). All later results have the full §2.4 shape (E2/E5 assert keys).
- **D10 D's third released path** (a reservation existed and cleanup ended `authorization_released`) stops `STATE_UNEXPECTED` with key `reservedNotConfirmed`; D unchanged.

### 13.3 Validation (all CLAUDE-RUN; root cannot run PG)

Commands, from the repository root at the Slice E head:

```
node --test --test-concurrency=1 test/db/e7-connected-runner.test.mjs        # focused PG suite (needs local PG binaries)
node --test test/e7-connected-*.test.mjs test/hostaway-reservations.test.mjs test/e4-connected-path.test.mjs   # A/B/D units + adapters + pins
npm test
```

- **FIRST FULL TAP (preserved, honest):** run 1 — E1–E7 ok; **E8 not ok** (its appended E4 eligibility check on the E8 booking got `NOT_RESERVATION_PHASE`, expected `INTENT_NOT_ELIGIBLE` → core fix D3). That failed assertion skipped the check's `finalize`, so its run lock stayed held and **E9–E15 cascaded as `RUN_LOCK_HELD` (test-setup cascade, not separate defects)**; I interrupted the run after 15 results. Fixes: D3 in the core; test-setup `afterEach` that destroys any client a scenario still holds; finalize before asserting in the E4 add-on.
- **Run 2:** 22/23 — E12 not ok: the first post-`STEP_STARTED` app statement is the worker's own marker check, which the accepted worker converts into a `refused` result (`STEP_REFUSED`, observed and journaled correctly); a **test-design** issue. E12 now rejects the worker's first maintenance statement (`nth: 2`), which propagates as a step rejection.
- **Run 3:** **23/23** (duration ≈ 90 s), same code as run 2 except the E12 fault selector. TAP: E1–E23 all `ok`.
- Units + adapters + pins: 132/132. `npm test`: 797/797. Full `test:db` not run (the focused evidence shows no wider concern). e74a not in scope and not reproduced.

### 13.4 Residuals (stated)

- The `in_flight` branch of the strict gate is covered by the same predicate as `outcome_unknown` / `escalated` but has no separate PG case (an `in_flight` write cannot be produced legitimately between steps without raw lifecycle writes or worker injection).
- Worker-owned SQL / provider calls keep running after a step timeout or rejection (E13 / E14 / E15); `finalize` can stay pending forever for an unobservable tail (E13), and callers must not end `pools.app` meanwhile.
- STEP-timeout and tail tests depend on the workers' own real timers (pricing 8 s, create 20 s): E14 ≈ 8 s, E15 ≈ 30 s real.
- Same-DB check is accidental-misconfiguration detection only (§12.1). The advisory lock is not a worker fence.
- Time in tests is scaled real time (K = 10; K = 3 for E15) plus a test-only `advance` / `jump`; the business clock follows §12.4 (real clock for recording scenarios; behind-real-time, capped, for recovery / cleanup scenarios).
- All live / provider / credential / network / install / shared-DB / merge / deploy / real-message gates remain CLOSED; owner inputs UNSET; protected ids zero action; e74a OPEN.

### 13.5 Root CODE REVIEW HOLD on `6e253977` (R-E1–R-E3) — corrections (same branch, fast-forward)

Scope: `run-core.mjs`, `test/db/e7-connected-runner.test.mjs`, this contract only. A / B / C / D, adapters, workers, `lib/`, SQL, fixtures, config, packages and pins unchanged.

**R-E1 — stop boundaries.** One check, `blocked()` = an existing stop cause, or `boundary()` (lock lost incl. the pre-attach flag, run signal aborted / invalid, guard broken), now runs before EVERY new runner operation: each owned-client acquisition (lock, S2 app client, every snapshot / guest client), each runner statement (S1, S2), the journal read, every attestation, after `prepare` / the guest read and before `STEP_STARTED`, again IMMEDIATELY before `lc.observeStep` invokes the worker, and at the start of every successful end (`ended()`). After a detected stop the only later operation is the single terminal append. Operations already started (a C snapshot in flight, a running worker step) are observed to their end, never interrupted. Consequences:
- loss observed during S1 → `REFUSED LOCK_LOST`, zero app connects / queries;
- cancellation / loss after an acknowledged `STEP_STARTED` → `RUN_STOPPED` (open step, outstanding `NONE`, `effectsKnown:false`), the worker never invoked;
- cancellation / loss during a step → the step runs to its end, but NO new post-step snapshot is started: `STEP_ENDED { state:null }`, stale counts, effects unknown, phase key; a final capture / recording / cleanup step therefore never falls into `RUN_ENDED`;
- cancellation at the last boundary (e.g. during the final `PHASE_ENDED` append, facts already acknowledged) → `STOPPED CANCELLED` with known effects and the state's key;
- an initially aborted signal → `REFUSED CANCELLED` with zero DB / worker / journal / attest calls.

**R-E2 — post-step observation.** Counts become stale the moment the worker is invoked (inside the `observeStep` start callback); only a valid acknowledged C snapshot clears stale, and after `RUN_STARTED` any unsuccessful snapshot (DB failure OR acknowledged refusal: cap / role / marker / malformed …) marks stale. The step's effect uncertainty (`unfinished`) is cleared only by a valid post-step snapshot AND an acknowledged `STEP_ENDED`; logging `STEP_ENDED { state:null }` no longer clears it. So an invoked reservation / capture / recording step without an accepted post snapshot yields `effectsKnown:false` and at least `reservedNotConfirmed` / `captured` / `confirmed` (cleanup keeps its entry key, raised to `reservedNotConfirmed` by the §6.2 null rule), even when the lifecycle reports outstanding `NONE`. No refresh, retry or reconstruction SQL after a failure.

**R-E3 — terminal failure.** A terminal append that is rejected / times out / is unobservable / is acknowledged with a wrong `{seq, hash}` now calls `stop(<JOURNAL_FAILURE | TIMEOUT_JOURNAL | GUARD_*>)` (first cause wins, so an earlier stop code is preserved). On a planned-success path `ended()` then returns a FAILED result:
- `ok:false`, `outcome:'STOPPED'`, `stopCode` = the journal cause, `journalTerminal:'unknown'` (or `'not_attempted'` if the record could not even be built: `CLOCK_INVALID` / `JOURNAL_RECORD_INVALID`);
- `ownerCleanupRequired` = the planned outcome's exact key (the acknowledged designation is kept); `writes` / `countsAsOf` / `effectsKnown` describe the last acknowledged DB facts (the uncertainty is the journal, not the DB);
- exactly one terminal attempt — no replacement `RUN_STOPPED`. Whether the attempted `RUN_ENDED` landed is decided by the next invocation's start rule (`RUN_ENDED` if landed, else `RESTART_AMBIGUOUS`; both zero workers).

`RunResult.outcome` is therefore a planned outcome ONLY when `ok:true` (terminal acknowledged); `'STOPPED'` / `'REFUSED'` otherwise, always with a non-null `stopCode`.

**New / changed regression cases:** E24 (R-E1 a/b + initial abort), E25 (R-E1c: abort during the final recording write, abort during the final `PHASE_ENDED`, lock loss during the final capture step, abort during the final cleanup void), E26 (R-E2: acknowledged `FACT_MALFORMED` post-step refusal after a genuinely applied create / capture / offline-charge write — a TEST-ONLY row mutation on C's exact `INTENT` statement), E27 (R-E3: `reject` / `hang` / `late` / `landed_hang` / invalid ack on the planned `ENDED_RESERVED_NOT_CAPTURED` path, plus the next invocation). Updated: E21 (no new snapshot after cancellation: `state:null`, stale, key), E18 (effects unknown after a failed `STEP_ENDED`), E15 (stale). E19 keeps the earlier-cause case (`OWNER_DECLINED` survives a terminal failure).

**Validation (CLAUDE-RUN):**
- RED on exact `6e253977` (core unchanged, new suite): 22/27 — the 5 correction cases fail (E21, E24, E25, E26, E27): e.g. E24 core invoked the worker after an observed abort, E25 returned `ENDED_CONFIRMED` after cancellation in the final step, E26 `effectsKnown:true` / key null after an acknowledged refusal, E27 `ENDED_RESERVED_NOT_CAPTURED` with `stopCode:null` on a rejected terminal. TAP retained.
- GREEN (first full TAP of the corrected head): **27/27** (≈ 90 s), first full run of the corrected head; TAP retained.
- Units + adapters + pins 132/132; `npm test` 797/797. Full `test:db` not run. e74a not reproduced.

### 13.6 Root CODE RE-REVIEW narrow HOLD on `d16b57ec` (R-E1d acquisition handoff) — resolution

Root closed R-E2 and R-E3 at `d16b57ec` (root reran its four exact-core probes; PG evidence remains CLAUDE-RUN). Remaining gap **R-E1d**: `acquire()` checked the stop condition only BEFORE its awaited connect, so a lock loss / cancellation that became observable WHILE connecting still let `snapshot()` / `guest()` begin a new C snapshot / guest SELECT (root's log: `report:connect → report:release(true) [held lock destroyed] → report:BEGIN → … → INTENT_NOT_FOUND`, the loss masked by the later refusal).

**Fix (only `acquire()`, the common handoff for every owned client: lock, same-DB S2, snapshot, guest).** After the awaited connect AND tracker setup, before any statement or C helper:
1. the acquired client's OWN tracker is checked: if it was lost (`error` / `end`) meanwhile, it has already been destroyed exactly once by its tracker; it is never queried; the caller stops `DB_FAILURE` (DB family: no further runner SQL, destroy-only disposal);
2. `blocked()` is re-checked (existing cause, lock loss incl. the pre-attach flag, signal, broken guard). If stopped, the never-queried client is returned once (`tracker.dispose()` then `release()`) or, on the DB-family path, destroyed once; the observed cause (e.g. `LOCK_LOST`, `CANCELLED`) is recorded by `boundary()` as the first cause, so a later refusal can no longer hide it.

Unchanged: a C snapshot that has ALREADY started is observed to its end; B's late-client rule (`observeConnect` destroys a late client once, never queried) — no duplicate release; DB-family and first-cause semantics; C, D, workers.

**Regression E28** (six independent subtests; red on exact `d16b57ec` for 1–4 and 6, control 5 already green there because the statement-level check covers S1 / S2):
1. lock loss while the P0 eligibility snapshot client connects → `REFUSED LOCK_LOST`, zero BEGIN / SELECT afterwards, the new client never queried and disposed once;
2. lock loss while a mid-run pre-step snapshot client connects → `STOPPED LOCK_LOST` (journaled as the first cause), zero SQL / worker / transport afterwards;
3. abort while a mid-run snapshot client connects → `STOPPED CANCELLED`, zero C SQL, healthy client returned once;
4. abort while the guest-read client connects → `STOPPED CANCELLED`, no guest SELECT, no `STEP_STARTED`, no worker / transport;
5. control: abort while the same-DB app client / the lock client connects → `REFUSED CANCELLED`, no S2 / no try-lock, one release;
6. SYNTHETIC (labelled; the wrapper delivers `error` / `end` to the tracker at subscription): an acquired snapshot / guest client lost before handoff → `STOPPED DB_FAILURE`, zero queries on it, destroyed exactly once (`release(true)`), `finalize` → `destroyed`.

PG wrappers forward to real disposable clients; events in 1–2 are real backend terminations from the owner session.

**Validation (CLAUDE-RUN):** RED on exact `d16b57ec` (`--test-name-pattern=E28`): 1 / 6 subtests pass (control 5). GREEN, first full TAP of the corrected head: 34/34 (the E1–E28 tests plus E28's six subtests), ≈ 90 s. Units + adapters + pins 132/132; `npm test` 797/797. Full `test:db` not run; e74a not reproduced.
