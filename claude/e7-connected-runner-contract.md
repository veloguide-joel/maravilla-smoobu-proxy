# E7 local connected-test RUNNER — CONTRACT, revision 7 (Slices A–C ACCEPTED; Slice D memory journal implemented; core NOT authorized)

**Branch** `feature/e7-connected-run-journal`, cut from exact `0e8bd27a`. Slice D adds `scripts/e7-connected/run-journal-memory.mjs` and `test/e7-connected-run-journal.test.mjs`, and updates this file.

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
- Revision 6 recorded the implemented Slice C. Root CODE REVIEW **HOLD** on `e081b1e4` (R-C1, R-C2) was corrected at `0e8bd27a`. Root CODE RE-REVIEW **ACCEPTED** offline Slice C at `0e8bd27a`: root reran the probes and the extracted 18-case synthetic regression. Root could not run PG; the focused PG 14/14, units / pins 115/115, `npm test` 780/780 and the red / green are CLAUDE-RUN. `checkSameDatabase` stays a core concern.
- Revision 7 (this file) records the **implemented** Slice D in-memory journal (§2.5, §8.2, §8.4). `run-core` / CLI / file journal and every real connection stay **NOT authorized**.

All source citations are at `cc5d877d`. The runtime is unchanged since `ede4c43c`; the adapters were accepted at `b757d6b7`. Worker paths are under `lib/booking-db/`.

**What this is.** The smallest **offline / injected-fake** orchestration foundation. It is a library that drives ONE existing synthetic booking through the accepted workers, with per-step adapter factories, and then ends.

**What it is not:**
- a CLI, a real transport, a credential loader, Stripe ingress, a file journal or a live approval;
- automatic cancel / refund;
- a notification / owner-alert sender;
- general resume.

Those are independent, CLOSED slices. All owner inputs stay **UNSET**. Live gates stay **CLOSED**. Protected reservations 70636076 / 71045356 / 71072615 / 71081885 stay zero-action. The historical e74a listing-lock failure stays OPEN (FIRST FULL TAP / STOP).

## 0. Status map

| Scope | Status | Where |
|---|---|---|
| Slice A: manifest v1 validation + canonical hash | **ACCEPTED** (root CODE review of `cc5d877d`) | §2.1, §3.1 |
| R-R1 worker-input map, R-R2 no-resume | Accepted design basis. Runtime parts are not implemented | §3.2, §8 |
| A. Import boundary | **CLOSED design decision** (root) | §2.0 |
| B. Injected timer / deadline API | Design ACCEPTED (`49df87b0`); implemented in `run-guard` | §7.2, §2.2.2 |
| C. Outstanding work NONE / STEP / TAIL; one finalize | Design ACCEPTED; lifecycle implemented in `run-guard` | §7.3, §7.6, §2.2.3 |
| D. Per-await ownership, late completions, lock lifecycle, precedence | Design ACCEPTED. Guard-side helpers are implemented (late client, tracker, lock release); the per-await SQL use stays in the NOT-authorized core | §7.4, §7.5, §7.7, §2.2.3, §2.2.5 |
| `run-guard` (deadline + lifecycle + executor wrappers) | **ACCEPTED** (Slice B, root CODE re-review of `86acc274`) | §2.2, §9.1 |
| `run-facts` (snapshot + guest read + candidate derivation) | **ACCEPTED** (Slice C, root CODE re-review of `0e8bd27a`) | §2.3, §4, §5.1, §9.2 |
| `run-journal-memory` (memory journal + record / chain / start validation) | **Implemented** (Slice D) for root CODE review | §2.5, §8, §9.3 |
| `run-core`, PG runner test, file journal | Proposed later; **not authorized** | §9.4 |

## 1. Present runtime vs proposed orchestration vs simulated tests

| Layer | Status at this head |
|---|---|
| Workers | **Accepted code**, used unchanged: `runOrchestratorStep` (`reservation-worker.js:585`), `runCaptureStep` (`capture-worker.js:600`), `runRecordingStep` (`recording-worker.js:598`), `runCleanupStep` (`compensation-worker.js:643`). Each step: (1) checks the `test` marker itself; (2) does its own scoped maintenance, recovery pass, at most one claim, its own provider calls (bounded by its own `setTimeout`, `reservation-worker.js:96–108`) and `releaseWork` SQL (`:171`); and (3) may leave a **late tail** (§7.3) |
| Executor adapters | **Accepted** (`scripts/e7-connected/executor-adapters.mjs`, `b757d6b7`) |
| Manifest | **Accepted** (`scripts/e7-connected/run-manifest.mjs`, `cc5d877d`) |
| Recovery-candidate provenance | **Test-local only** (`test/db/e7-connected-adapter-rehearsal.test.mjs`). It does not enforce production provenance or concurrency |
| Runner guard / facts / core / memory journal | **PROPOSED** (§2.2–§2.5). Nothing exists |
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

### 2.2 `run-guard.mjs` — Slice B (IMPLEMENTED at this head, for root CODE review)

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

#### 2.2.6 Clarifications and deviations from the revision-4 proposal (for root review)

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

### 2.3 `run-facts.mjs` — Slice C (IMPLEMENTED at this head, for root CODE review)

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

`checkSameDatabase` (§7.8, proposed in revision 4 for this module) is **not** part of Slice C: root's Slice C scope named the snapshot, the guest read and the candidate derivation only. It stays a core-slice item.

### 2.4 `run-core.mjs` — PROPOSED later

`runConnectedTest(opts) → Promise<frozen RunResult>`

`opts` must have exactly these keys, validated by descriptor snapshot before any await:

| Key | Contents |
|---|---|
| `manifest` | passes `validateRunManifest` |
| `intentId` | must equal `manifest.intentId`, else `REFUSED: INTENT_MISMATCH` |
| `pools` | `{ app, report }`: **caller-owned** pools to ONE disposable TEST DB (§7.8). The runner never ends or closes them |
| `transports` | `{ hostaway:{send}, stripe:{send} }` |
| `journal` | `{ append(record), read() }` (§8) |
| `attest` | `(checkpoint, request, { signal }) → Promise<{ ok:boolean, evidenceRef?:string }>` |
| `clock` | `() → wall ms`: the ONE business clock passed to every worker |
| `monotonic` | `() → ms`, non-decreasing (§7.2) |
| `timers` | `{ arm(delayMs) → { promise, cancel } }` (§7.2). This replaces revision 2's `wait` |
| `signal` | a genuine run-level `AbortSignal`, inspected natively (R-A2) |

Invalid options → `{ ok:false, code:'OPTIONS_INVALID' }`, with zero DB, transport, journal, attest or timer calls.

Workers get `pools.app` and their accepted default timeouts. The runner does not pass `monotonic`, `timers` or `timeouts` to workers, so the underlying work is governed by the accepted worker bounds.

**`RunResult` (frozen; never mutated after return):**

```js
{ ok, outcome, stopCode: null | CODE, phase, manifestHash, journalSeq,
  journalTerminal: "acknowledged" | "unknown" | "not_attempted",
  writes: { create, capture, record, void, cancel }, countsAsOf: { seq, stale: boolean },
  effectsKnown: boolean,
  outstanding: "NONE" | "STEP" | "TAIL", outstandingPhase: null | "reservation" | "capture" | "recording" | "cleanup",
  tailObservable: boolean,              // false only for TAIL after a rejected step (§7.3)
  exclusion: "held" | "lost" | "not_acquired",
  ownerCleanupRequired: null | "reservedNotConfirmed" | "captured" | "confirmed",
  finalize: () => Promise<Disposal> }   // ALWAYS present; idempotent (§7.6)
```

### 2.5 `run-journal-memory.mjs` — Slice D (IMPLEMENTED at this head, for root CODE review)

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

- **Same disposable test DB.** This is a **caller precondition**. The runner adds a weak consistency check at P0, with no new privilege or API:
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

**Order (journal-level).**
- `RUN_STARTED` exactly first.
- `CALENDAR_BASELINE` is attested before the first step.
- Steps run strictly `STEP_STARTED` → `STEP_ENDED` with the same `phase` / `step`, numbered 1, 2, … per phase. No other event while a step is open, except `RUN_STOPPED` with `outstanding:'STEP'`.
- Phases are `reservation → capture → recording`, or `reservation | capture → cleanup`. A phase change needs `PHASE_ENDED` of the current phase.
- `AIRBNB_BLOCKED` needs reservation ended, and capture needs `AIRBNB_BLOCKED`. `AIRBNB_REOPENED` needs cleanup ended. Each checkpoint appears at most once.
- Exactly one terminal record, which is last. Nothing after it (`APPEND_AFTER_TERMINAL`).
- An unfinished `STEP_STARTED` is **crash evidence, never permission to resume**.

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

The design was accepted at `49df87b0`; the code awaits root CODE review. Root's clarification tests were added beyond G1–W1: post-start faults, tie semantics, fractional readings, `trackClient` event orders, late-client handling, wrapper hostile / forged / late cases, no unhandled rejections, and pending-forever cases asserted after controlled fake progress.

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

### 9.3 Slice D: `run-journal-memory` (offline unit) — IMPLEMENTED at this head, for root CODE review

**Files.** `scripts/e7-connected/run-journal-memory.mjs`, `test/e7-connected-run-journal.test.mjs` (14 unit tests; no DB, worker or network), and this contract.

**Acceptance (all pass):**
- Happy chain with independently recomputed heads / hashes.
- Caller mutation resistance.
- Every append refusal category with unchanged history.
- Order refusals: step before baseline, second `RUN_STARTED`, capture before `AIRBNB_BLOCKED`, phase skip, `REOPENED` without cleanup, first event not `RUN_STARTED`.
- Terminal rules: after-terminal, duplicate terminal, open step vs `RUN_ENDED` / `RUN_STOPPED`.
- Two concurrent appends: `CHAIN_MISMATCH` / `APPEND_IN_FLIGHT`, no retry.
- Faults through the accepted guard with fake timers: `reject`, `hang` → timeout, `late` → timeout then lands → `RUN_ENDED`, `landed_hang` → timeout while present; read `reject` / `hang` / `torn` → `JOURNAL_PARTIAL`.
- Start verdicts, including empty ⇒ `dbEligibilityRequired` and interrupted step ⇒ `RESTART_AMBIGUOUS`.
- Identity mismatch per field; chain / `seq` edits.
- Complete rewrite: passes unanchored (documented limit); `TRUSTED_HEAD_MISMATCH` anchored; truncation / deletion detected.
- Hostile descriptors: 0 caller getter / iterator / `toJSON` / trap runs. Frozen / null-prototype controls accepted.
- Redaction: planted SYNTHETIC markers counted, never copied; grammar-limit demonstration.
- Grammar pinned to the worker literals and vocabulary parity.
- Purity / import pin; option validation; preload of a broken history.

**Routine pure-module choices (deviations from the revision-4 proposal, for root review):**
1. The hash carries the literal `JOURNAL_HASH_PREFIX` (the manifest's convention); §8.2 previously said the plain sha256 of canonical JSON.
2. Added record fields: `STEP_ENDED.result` / `unlistedActions` (counted, never copied), and the terminals' `ownerCleanupRequired` / `writes` / `outcome` (`RUN_ENDED`).
3. The action grammar is broader than the revision-4 draft, because the accepted workers emit `NAME!CODE`, `READ:ID|LIST:…`, `MAINTENANCE:…`, `HOLD:…`, `RECOVERY:REISSUE…`. It stays whole-token and character-bounded.
4. `read()` resolves `{ records, tail }`, not a bare array, so a SYNTHETIC torn tail is expressible.
5. `createMemoryJournal` options are `{ identity, preload, faults }`, replacing revision 4's `{ failAt, hangAt, lateAt, preload }`.
6. `MAX_RECORDS` 1024.

### 9.4 Later core slice (`run-core`, disposable-PG runner test) — NOT authorized

**Proposed files:**
- `scripts/e7-connected/run-facts.mjs`, `run-core.mjs`, `run-journal-memory.mjs`;
- `test/db/e7-connected-runner.test.mjs` (disposable PG, fakes, labelled synthetic authorization fixture, fake `monotonic` / `timers`).

No worker, `lib/`, SQL, fixture, config, package or containment-pin change.

**Acceptance matrix (all synthetic; fetch guard; zero real provider calls):**

| # | Case | Expected |
|---|---|---|
| 1 | Invalid options / manifest (delegated to Slice A codes) | refusal; zero DB / transport / journal / attest / timer calls |
| 2 | `opts.intentId` ≠ manifest; identity mismatch (ref / stay / amount / `rateBps`); pools on different DBs | `INTENT_MISMATCH` / P0 refusal / `POOLS_MISMATCH`; zero worker calls |
| 3 | Happy chain with capture + recording | `ENDED_CONFIRMED`, `ownerCleanupRequired: confirmed`; one write each; journal chain + redaction; `finalize` → `"unlocked"` |
| 4 | `capture:false`; `recording:false` | `ENDED_RESERVED_NOT_CAPTURED` / `ENDED_CAPTURED_NOT_RECORDED` with the matching key |
| 5 | Same-step recovery binding (no echo) | candidate (a) before the next step; one create; continues |
| 6 | Unbound-factory by-id refusal | `RECOVERY_BINDING_UNAVAILABLE`; zero provider calls for it; identical promise / error back to the worker |
| 7 | Applied-then-503 create (C) | `STOPPED: UNKNOWN_WRITE` / `OPEN_CASE` before any capture call; key ≥ `reservedNotConfirmed` |
| 8 | Failure void-only (D) | `ENDED_RELEASED`; zero Hostaway cancel / create |
| 9 | Snapshot statement rejects; COMMIT-loss / COMMIT timeout | `DB_FAILURE` / `TIMEOUT_DB_READ`; that client destroyed; **zero** further runner SQL (unlock included); `finalize` → `"destroyed"`; `countsAsOf.stale` |
| 10 | **STEP timeout → late fulfil → TAIL → quiescent** (fake create raw resolved after the step deadline) | `TIMEOUT_STEP`, `outstanding STEP`, `effectsKnown false`, key `reservedNotConfirmed`; no next step; lock held until quiescence; a late-evidence write after return is evidence only; then `"unlocked"` |
| 11 | **STEP timeout → later step rejection** (a worker DB error injected after the deadline) | `stopCode TIMEOUT_STEP` unchanged; disposal moves to the DB-family path. `finalize` pending forever when executor calls started (asserted with the fake clock); when none started, quiescent → `destroy()` only (`"destroyed"`). Zero runner SQL, unlock included |
| 12 | Post-result tail never settles | `LATE_TAIL_OUTSTANDING`, `tailObservable true`; `finalize` pending; no provider invocation by the runner after return |
| 13 | Step rejects within its deadline after ≥ 1 executor call | `DB_FAILURE`, `outstanding TAIL`, `tailObservable false`; no unlock / destroy of the healthy lock session; `finalize` pending |
| 14 | **Late acquired client**: lock connect timeout, then the client resolves | `REFUSED: TIMEOUT_DB_CONNECT`; the late client destroyed, zero queries; zero workers |
| 15 | **Acquire timeout / unlock timeout** | `REFUSED: TIMEOUT_DB_LOCK` (lock client destroyed) / `Disposal.lockRelease destroyed_after_unlock_timeout`, `RunResult` unchanged |
| 16 | **Lock loss with an outstanding STEP** (lock client `end` emitted) | `TIMEOUT_STEP` + `exclusion "lost"`; no claim of protection; `finalize` → `"lost"` after quiescence |
| 17 | Lock loss between steps | `STOPPED: LOCK_LOST` at the next boundary; zero further workers |
| 18 | **Simultaneous timeout / rejection** on a snapshot statement and on a journal append | rejection code wins (`DB_FAILURE` / `JOURNAL_FAILURE`) |
| 19 | **Terminal journal timeout, then late append** / no late append | `journalTerminal "unknown"`; `stopCode` unchanged; the next invocation → `RUN_ENDED` / `RESTART_AMBIGUOUS`, zero worker calls |
| 20 | Mid-run journal rejection / timeout at each event | `JOURNAL_FAILURE` / `TIMEOUT_JOURNAL`; no further step or append |
| 21 | Hanging attest; attest answers after the timeout | `TIMEOUT_ATTEST`; the late answer ignored; no later worker |
| 22 | Restart: acknowledged `RUN_STARTED` without a terminal record (even at `reservation_confirmed`); terminal record; foreign / partial / chain-broken / malformed journals | `RESTART_AMBIGUOUS` / `RUN_ENDED` / respective refusal; zero worker calls |
| 23 | Protected id in synthetic evidence; run lock held | `PROTECTED_REFERENCE` / `RUN_LOCK_HELD` |
| 24 | Phase budget cannot cover the next step deadline | `BUDGET_EXHAUSTED`; the step is not started |
| 25 | Signal aborted during a step | the step is observed to its end; then `CANCELLED` at the boundary; the worker is never interrupted |
| 26 | Attestation declined | `OWNER_DECLINED` |
| 27 | Source pins | no runner timers; exact import boundary (§2.0); no pinned identifiers |

**Remaining blockers.**

*Before core authorization:*
- root DESIGN acceptance of this revision;
- root CODE acceptance of Slice B (§9.1).

*Before any real run* (all CLOSED slices):
- **Pilot listing:** a containment blocker (§3.3); V1 refuses it;
- real transports with proven zero automatic retries;
- a credential loader;
- Stripe TEST ingress;
- the file journal;
- a live CLI;
- read-only provider probes (cancel / offline-charge mappings remain LIVE-UNVERIFIED);
- owner decisions.

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

These replace the revision-3 OPEN list. Root accepted the design at `49df87b0`; the core itself is still **not authorized**.

| Item | Resolution | Status |
|---|---|---|
| A. Import boundary | §2.0: the four worker entrypoints + transitive dependencies, the adapters, the manifest, pure constants and Node built-ins. No new pinned-Hostaway importer, no pin / worker change, no worker injection, no copied worker code | **CLOSED** (root decision) |
| B. Deadline wake-up | §7.2: one injected `timers.arm(delayMs) → { promise, cancel }` alongside `monotonic`. Exact validation, the arm-before-start rule, operation-beats-timer settlement, early-fire re-arm, cancellation cleanup, the inter-step wait expressed through the same API, no runner timers. Fake-timer tests G1–G9 | design ACCEPTED; implemented in Slice B (§2.2) |
| C. STEP vs TAIL; finalize | §7.3 / §7.6: NONE / STEP / TAIL (observable or not). A retained step promise, then its `late`, then a ledger drain. One memoized, never-rejecting `finalize` that waits for quiescence with no escape and can stay pending forever. It never mutates the result, refreshes counts, retries or appends | design ACCEPTED; implemented in Slice B (§2.2) |
| D. Ownership / late completion / lock | §7.4 table (every await), §7.5 exclusion / loss, §7.6 release paths, §7.7 priority. Late connects destroyed, never queried; bounded acquire / unlock; no runner SQL after the DB family; a healthy lock session kept while work is outstanding; lock loss reported as lost | design ACCEPTED. Guard-side helpers are implemented in Slice B (§2.2); the core's SQL use is not authorized |

Source citations above distinguish **accepted** code (workers, adapters, Slice A at `cc5d877d`) from Slice B `run-guard` (§2.2, implemented, awaiting CODE review) and the **proposed** modules (§2.3–§2.5), none of which exist.
