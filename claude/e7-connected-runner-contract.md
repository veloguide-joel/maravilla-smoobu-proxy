# E7 local connected-test RUNNER — CONTRACT, revision 2 (DOCS ONLY; every implementation item PROPOSED)

**Branch** `feature/e7-connected-runner-contract`.
- Revision 1 was `36a6da15`, cut from `9f13c816`. Root DESIGN HOLD R-R1 to R-R4; revision 2 is on the same branch.
- All source citations are at this head. The runtime is unchanged since `ede4c43c`; the adapters were accepted at `b757d6b7`.

**What this is.** The smallest **offline / injected-fake** orchestration foundation. It is a library that drives ONE existing booking through the accepted workers, with per-step adapter factories, and then ends.

**What it is not:**
- a CLI, a real transport, a credential loader, Stripe ingress, a file journal or a live approval;
- automatic cancel / refund;
- a notification / owner-alert sender;
- general resume.

Those are independent, CLOSED slices. All owner inputs stay **UNSET**. Live gates stay **CLOSED**. Protected reservations 70636076 / 71045356 / 71072615 / 71081885 stay zero-action. The historical e74a listing-lock failure stays OPEN (FIRST FULL TAP / STOP).

## 0. Resolution map (root DESIGN HOLD on `36a6da15`)

| Item | Resolution |
|---|---|
| R-R1 worker inputs | §3: explicit `listing.refFieldId`, `listing.timeZone`, `expectedRef`, `intentId` and `pricing.rateBps` in the hashed manifest. Channel 2000 is a named invariant. §3.2 is a complete per-worker input map. §3.3 covers the pilot / containment blocker. §6.2 covers phase dependencies and terminal outcomes. `paymentMethod` is always present (`null` iff no recording) |
| R-R2 restart | §8.4. V1 has **no resume**: only an empty journal plus an eligible `payment_authorized` intent may start. Any acknowledged run → `RESTART_AMBIGUOUS` / `RUN_ENDED`. The full journal identity and chain are validated |
| R-R3 tails / refusals | §7.2: bounded tail observation, `LATE_TAIL_OUTSTANDING`, and late evidence that may still persist. §5.3: a runner-side refusal recorder (exact-key wrappers that record codes and rethrow the identical error). §8.2: an exact action grammar |
| R-R4 awaits / lock | §7.3: an injected monotonic source, per-boundary deadlines, timed-out awaits that end the run (no retry, no continue), and the lock-client lifecycle. Results after a DB failure report the last acknowledged counts, marked stale |

## 1. Present runtime vs proposed orchestration vs simulated tests

| Layer | Status at this head |
|---|---|
| Workers | **Accepted code**, used unchanged: `runOrchestratorStep` (`reservation-worker.js:585`), `runCaptureStep` (`capture-worker.js:600`), `runRecordingStep` (`recording-worker.js:598`), `runCleanupStep` (`compensation-worker.js:643`). Each step does its own scoped maintenance, recovery pass, at most one claim, its own provider calls and budget, and may leave a **late tail** (§7.2) |
| Executor adapters | **Accepted** (`scripts/e7-connected/executor-adapters.mjs`, `b757d6b7`) |
| Recovery-candidate provenance | **Test-local only** (`test/db/e7-connected-adapter-rehearsal.test.mjs`). It does not enforce production provenance or concurrency |
| Runner (this contract) | **PROPOSED**. Nothing exists |
| Real transports, credentials, Stripe TEST ingress, file journal, live CLI | **CLOSED**, separate slices |

## 2. Proposed files and exports (offline foundation)

All files live under `scripts/e7-connected/` (excluded from upload). They are pure orchestration with injected I/O: no `process.env`, `fetch`, file system, SDK, timers or scheduler of their own. They must not contain the identifiers pinned by accepted containment tests: `hostaway-reservations` (`test/hostaway-reservations.test.mjs:544–569`), `connectedTestAdapterConfig` and `allowRequest:` (`test/e4-connected-path.test.mjs:404–421`). The only accepted module they import is the adapter module (`createPhaseExecutors`, `ExecutorRefusal`).

### 2.1 `run-manifest.mjs`

`validateRunManifest(input) → { ok:true, manifest, hash } | { ok:false, code }`
- An R-G1 descriptor snapshot, deep-frozen.
- `hash` = sha256 of `'e7-run-manifest-v1\n' + canonical JSON`: sorted keys, values string / safe integer / boolean / `null`, no other types.

### 2.2 `run-facts.mjs`

- `readRunSnapshot(reportPool, intentId, deadline) → frozen facts` (§4).
- `readGuestBinding(appPool, intentId, deadline) → { firstName, lastName, email } | null`. The values are never journaled.
- `deriveRecoveryCandidate(facts) → { ok:true, id, sources } | { ok:false, code }` (§5).

### 2.3 `run-core.mjs`

`runConnectedTest(opts) → Promise<frozen RunResult>`

`opts` must have exactly these keys:

| Key | Contents |
|---|---|
| `manifest` | an object that passes `validateRunManifest` |
| `intentId` | must equal `manifest.intentId`, else `REFUSED: INTENT_MISMATCH` |
| `pools` | `{ app, report }`: injected pools to ONE disposable TEST DB |
| `transports` | `{ hostaway:{send}, stripe:{send} }` |
| `journal` | `{ append(record), read() }` (§8) |
| `attest` | `(checkpoint, request, { signal }) → Promise<{ ok:boolean, evidenceRef?:string }>` |
| `clock` | `() → wall ms`: the ONE business clock passed to every worker |
| `monotonic` | `() → ms`: the deadlines source, never moves backwards |
| `wait` | `(ms, signal) → Promise`: an injected timer for the inter-step `delayMs` only |
| `signal` | a genuine run-level `AbortSignal`, inspected natively (R-A2) |

Rules:
- Validation and freezing happen before any await. Invalid options → `{ ok:false, code:'OPTIONS_INVALID' }`, with zero DB, transport, journal or attest calls.
- `RunResult` (frozen):

```js
{ ok, outcome, stopCode?, phase, manifestHash, journalSeq,
  writes: { create, capture, record, void, cancel }, countsAsOf: { seq, stale:boolean },
  tailOutstanding:boolean, ownerCleanupRequired: null | "reservedNotConfirmed" | "captured" | "confirmed",
  finalize?: () => Promise<void> }
```

- `finalize` is present only when a tail is outstanding (§7.2).

### 2.4 `run-guard.mjs`

The runner's own wrappers (§5.3) and the deadline helper (§7.3).

### 2.5 `run-journal-memory.mjs`

`createMemoryJournal({ failAt?, preload? })`: an in-memory journal for offline tests, with failure injection and preload of partial / foreign journals. A file journal is a later, CLOSED slice.

## 3. Manifest v1 and the complete worker-input map

### 3.1 Schema (exact keys; no defaults; owner fields absent → `MANIFEST_OWNER_INPUT_MISSING`)

| Key | Rule |
|---|---|
| `version` | `"e7-run-manifest-v1"` |
| `runId` | `^[a-z0-9-]{8,64}$` |
| `intentId` | lowercase canonical uuid of the EXISTING intent; part of the hashed run identity |
| `baselineCommit` | 40 hex |
| `synthetic` | boolean. `true` = offline tests only (both transports are injected fakes; owner fields may hold synthetic values). `false` → refused in this slice (`REAL_RUN_NOT_IN_THIS_SLICE`) |
| `providerMode` | `{ hostaway, stripe }`. This slice accepts only `{ "fake", "mock" }`. `stripe: "live"` → `S_LIVE_REFUSED` (`capture-proof.js:97`, `compensation-proof.js:184`). Any other value → `PROVIDER_MODE_NOT_IN_THIS_SLICE` |
| `listing` | `{ id, currency, refFieldId, timeZone }`, all explicit. `currency` must be `"USD"` (`offline-charge-proof.js:33`, the USD direction). `refFieldId` is a positive integer (required by `validateAdapterConfig`, `hostaway-reservations.js:202`, and by the reservation / recording factories). `timeZone` is an IANA name, required by `compensationWorkerGate` (`LISTING_TIME_ZONE_INVALID`). The pilots 603564 / 603566 → `PILOT_NOT_IN_THIS_SLICE` (§3.3). No `pilotException` key |
| `expectedRef` | `^MV-[A-Z0-9]{6,10}$`; must equal the intent's `ref` |
| `stay` | `{ arrival, departure, guests }`; must equal the intent |
| `amountMinor` | must equal the intent's `price.finalTotalMinor` |
| `pricing` | `{ rateBps }`: integer 0–10000; must equal the intent's `price.rateBps` (`final-price.js:127`) |
| `stripeAccountId` | `acct_…` (TEST-account check = the workers' `accounts.retrieve` id equality, `capture-worker.js:219`) |
| `hostawayAccountLabel` | `{ accountRef, clientSnapshotId }`: **TRUST** labels, not ownership |
| `phases` | `{ capture, recording }`, booleans. `recording: true` requires `capture: true` (`PHASE_DEPENDENCY`) |
| `paymentMethod` | **always present.** `"credit_card"` or `"other"` iff `phases.recording`; exactly `null` otherwise (`PAYMENT_METHOD_RULE`). `null` is canonical JSON and is hashed |
| `cleanup` | `{ reservedNotConfirmed, captured, confirmed }`, each a non-empty owner-approved procedure reference (synthetic marker if `synthetic`). There is no `"not-applicable"`: every outcome a run can leave is covered (§6.2) |
| `automationsReviewed` | non-empty reference |
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

**Snapshot.** One `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` on a fresh report connection:
- it contains every fact listed in §5, plus open cases, the ops of all five provider-write types with their states, and the `booking.instance` marker;
- then `COMMIT` and release, all **before** the step.

No transaction is held across a worker or network call. A failure inside the snapshot destroys that connection (`release(true)`) with no further SQL, and the run ends with `DB_FAILURE` (§7).

**Race (documented).** Workers commit new facts during the step, and possibly in a late tail (§7.2) after it. A snapshot is a basis, never a guarantee. Off-scope provider ids are prevented by the adapter's immutable binding **before** invocation. The next snapshot is authoritative.

## 5. Candidate provenance, factory choice and refusal observation

### 5.1 `deriveRecoveryCandidate`, before every reservation step

1. **Phase.** State ∈ `payment_authorized`, `reservation_pending`, `reservation_unknown` (`reservation-worker.js:54`).
2. **Candidates:**
   - **(a)** a `hostaway.create_reservation` op with `state = succeeded` and a `result_ref`;
   - **(b)** lookup-read evidence with `found_active`, `observed.bookingRef = expectedRef` and `matchCount = 1` (its `external_ref`);
   - **(c)** `intents.hostaway_reservation_id`.
3. More than one distinct id → `CANDIDATE_CONFLICT`. Any protected id anywhere in the intent's ops / evidence → `PROTECTED_REFERENCE`.
4. An open `hostaway.retrieve_reservation` naming another id → `OPEN_READ_CONFLICT`.
5. A `pending` (undispatched) create and a candidate together → `CANDIDATE_BEFORE_CREATE`.
6. **Factory:** one candidate → `reservation-recovery` bound to it; none → `reservation` (unbound).

### 5.2 Same-step facts

The worker may queue and claim a by-id read within the step (`reservation-worker.js:603–605`; accepted rehearsal §3.1). A read that needs an id not derivable beforehand meets the unbound factory's `RESERVATION_UNBOUND` refusal, with zero provider calls. The run then **STOPs** (§5.3); it never guesses or reruns blindly.

### 5.3 Observing refusals (runner code only; no worker change)

The workers swallow executor rejections. For example, `executeRead` turns a rejected `retrieveReservation` into `READ_REPLY_NOT_USABLE` / `READ:hostaway.retrieve_reservation:error` (`reservation-worker.js:238–239`). The step result never exposes the adapter's code.

`run-guard.mjs` therefore wraps the factory output in **exact-key wrappers** with the same key set:
- `pricing` is wrapped as an object with `get` / `post`;
- recording's `label` is passed through unchanged.

Each wrapper calls the adapter function with the identical arguments. If it rejects with an `ExecutorRefusal`, the wrapper records **only** `{ key, code }` (code `^[A-Z_]{1,40}$`) in a per-step list and rethrows **the identical error object**. Any other rejection is rethrown identically, unrecorded; that is the transport-failure path. The wrappers never read arguments, replies or messages, and never retry.

**STOP rules after each step:**
- any recorded refusal → `STOPPED: ADAPTER_REFUSED`, journaled with the code; `RESERVATION_UNBOUND` → `RECOVERY_BINDING_UNAVAILABLE`;
- in addition, conservatively, any `READ:<type>:error` action → `STOPPED: READ_FAILED`. V1 does not try to tell transient errors from refusals.

**Post-step audit (supporting only):** every executed by-id read named the bound id, and write counts ≤ 1 per accepted op.

## 6. Phases, dependencies, terminal outcomes

### 6.1 Phases

| # | Phase | Entry gate | Worker, bounds | Exit |
|---|---|---|---|---|
| P0 | Preflight | Options + manifest valid. `opts.intentId = manifest.intentId`. Run lock acquired (§7.4). Marker `test`. **Journal empty** (§8.4). Intent `payment_authorized` and identity = manifest (ref, listing, stay, amount, `rateBps`, currency). No op of the five write types beyond the accepted pre-reservation state. No open case. Protected scan clean | none | journal `RUN_STARTED` (acknowledged) |
| P1 | Pre-create gate | Manifest cleanup procedures for **every** outcome + `automationsReviewed`. `attest("CALENDAR_BASELINE")` ok with `evidenceRef` | none | `ATTESTED` |
| P2 | Reservation | Snapshot + §5 before each step | `runOrchestratorStep`: ≤ 12 steps; phase ≤ 15 min monotonic | `reservation_confirmed` → `attest("AIRBNB_BLOCKED")`; `reservation_failed` → P5 |
| P3 | Capture (iff `phases.capture`) | Snapshot: no open case; no unknown / escalated / in-flight op. The capture worker has no open-case check (`capture-worker.js` / `capture-proof.js` contain no `reconciliation_cases` reference); this gate is the runner's | `runCaptureStep`: ≤ 6 steps, ≤ 10 min | `payment_captured` |
| P4 | Recording (iff `phases.recording`) | Same gates | `runRecordingStep`: ≤ 6 steps, ≤ 10 min | `confirmed` |
| P5 | Failure compensation | Only `reservation_failed` / `capture_failed` (`compensation-worker.js:50`), state-specific (`:103–107`) | `runCleanupStep`: ≤ 8 steps, ≤ 15 min | `authorization_released` / `cancelled` → `attest("AIRBNB_REOPENED")` iff a reservation had existed |

### 6.2 Terminal outcomes

A run never reports success while leaving a standing reservation or captured money unaccounted for:

| Path | `outcome` | `ok` | `ownerCleanupRequired` |
|---|---|---|---|
| P2 → `reservation_confirmed`, `capture: false` | `ENDED_RESERVED_NOT_CAPTURED` | true (plan end) | `reservedNotConfirmed` (a real reservation with no capture) |
| P3 → `payment_captured`, `recording: false` | `ENDED_CAPTURED_NOT_RECORDED` | true | `captured` |
| P4 → `confirmed` | `ENDED_CONFIRMED` | true | `confirmed` |
| P5 → `authorization_released` / `cancelled` | `ENDED_RELEASED` | true | null (no reservation standing), or `reservedNotConfirmed` if the cleanup left one |
| Any STOP after a reservation exists | `STOPPED` | false | the matching key by state |
| Any STOP before a create was dispatched | `STOPPED` | false | null |

No automatic cancel / refund exists for a successful reserved / captured / confirmed booking, and none is designed here.

**Authorization fixture vs verified TEST ingress.** V1 starts only from an existing `payment_authorized` intent:
- in offline tests, that intent is produced by labelled synthetic fixture setup with a mocked authorization;
- verified Stripe TEST ingress (`processVerifiedStripeEvent`, `stripe-test-webhook.js:102`) is a separate CLOSED slice.

Attestations are owner statements with evidence references; program state never proves Airbnb behaviour.

## 7. STOP policy, tails, bounded awaits, lock lifecycle

### 7.1 STOP codes

Each code ends the automatic run. Afterwards: no further worker step, provider call, release or retry. At most one final journal append is attempted, and only if the journal itself has not failed.

| Code | Trigger |
|---|---|
| `DB_FAILURE` | any thrown DB / worker error (outer failure / COMMIT uncertainty); code only, the error is not kept |
| `PROTECTED_REFERENCE` | a protected id appears in the run's facts |
| `CANDIDATE_CONFLICT`, `OPEN_READ_CONFLICT`, `CANDIDATE_BEFORE_CREATE` | §5.1 |
| `RECOVERY_BINDING_UNAVAILABLE`, `ADAPTER_REFUSED`, `READ_FAILED` | §5.3 |
| `UNKNOWN_WRITE` | a write op `outcome_unknown` / `escalated`, or an unknown action |
| `OPEN_CASE` | any open case, checked after every step. **Scenario C:** `reservation_confirmed` does not clear `HOSTAWAY_CREATE_OUTCOME_UNKNOWN`, so the run stops before capture. Any later read-only recovery or review needs a separately approved, bounded phase. The runner never closes cases and never resumes |
| `STEP_REFUSED` | a worker returned `refused` |
| `STATE_UNEXPECTED` | — |
| `BUDGET_EXHAUSTED` | — |
| `JOURNAL_FAILURE` | — |
| `CANCELLED`, `OWNER_DECLINED`, `ATTESTATION_FAILED` | — |
| `LATE_TAIL_OUTSTANDING` | §7.2 |
| `TIMEOUT_<BOUNDARY>` | §7.3 |

**Boundary.** Inside one call to a step function, the accepted worker does its own maintenance, recovery, reads and at most one write, under its own fences. The runner acts only between steps and cannot stop or undo anything inside a step or its tail.

### 7.2 Asynchronous worker tails (accepted behaviour, observed only)

After a timeout, the workers record a late provider result as late evidence and **never** as another provider write:
- reservation: `reservation-worker.js:76`, `:374–377`, `lateCreateResult` `:454`;
- capture: `capture-worker.js:447`;
- cleanup: `compensation-worker.js:435`, `:533`;
- recording: `observeLate`, `recording-worker.js:485–494`.

The reservation, capture and cleanup tails wait on `call.raw`, which an unresolved provider promise can keep pending **forever**. Recording's tail is bounded by `lateWindowMs` 30 s (`recording-worker.js:32`). Each step result returns `late` (`Promise.allSettled(ctx.late)`).

**Runner behaviour:**
- After every step, `late` is observed with a deadline of `TAIL_OBSERVE_MS` = 35 s, monotonic. It is never awaited without bound.
- **Settled** within the deadline → continue to the next snapshot.
- **Not settled** → `STOPPED: LATE_TAIL_OUTSTANDING`, journaled, with `tailOutstanding: true`. The runner starts no next worker, does not reuse the step's resources as if the tail had vanished, and does **not** release the run lock.
  - The result carries `finalize()`. The caller may call it after it decides the tail is settled or abandoned: it waits for `late` (no runner timeout; the caller owns the process lifetime), then performs the normal lock release (§7.4).
  - The injected pools are caller-owned and never closed by the runner.
  - The result states plainly that the tail **may still write late evidence to the DB after `runConnectedTest` returns** (never another provider write), and that the runner provides no cancellation or DB-silence guarantee the accepted worker does not provide.

### 7.3 Bounded awaits

All deadlines use `opts.monotonic`. There is no timer loop or scheduler outside this invocation. A timed-out await **ends the run with `TIMEOUT_<BOUNDARY>`**. It never retries and never continues after an uncertain operation. The timed-out underlying work is **not** cancelled by the timeout (observation bound ≠ work bound).

| Boundary | Limit | On timeout |
|---|---|---|
| pool connect | 5 s | `TIMEOUT_DB_CONNECT` |
| snapshot / guest read (per statement + txn) | 5 s | `TIMEOUT_DB_READ`; the connection is destroyed, no further SQL |
| worker step | worker `stepBudgetMs` (45–60 s, `*_DEFAULT_TIMEOUTS`) + 30 s observation margin | `TIMEOUT_STEP`: treated like an outstanding tail; no next step, lock retained, `finalize` offered |
| late tail | 35 s | `LATE_TAIL_OUTSTANDING` |
| journal append / read | 5 s | `TIMEOUT_JOURNAL` → also `JOURNAL_FAILURE` semantics (no further append) |
| attest | 30 min per checkpoint (fixed) | `TIMEOUT_ATTEST` |
| inter-step wait | `min(delayMs, remaining phase budget)` | phase budget exhausted → `BUDGET_EXHAUSTED` |
| phase | §6.1 | `BUDGET_EXHAUSTED` |

**Run-level signal.** Checked natively before every boundary. Aborted → `CANCELLED` between steps; it is never forced into a step.

### 7.4 Run lock lifecycle

- **Acquire.** A dedicated client from `pools.report`. `SELECT pg_try_advisory_lock(hashtext('e7-connected-runner'), 0)`; false → `REFUSED: RUN_LOCK_HELD`, and the client is destroyed. The lock coordinates runners only; it is not a worker fence.
- **Normal end.** `SELECT pg_advisory_unlock(…)`, then `client.release(true)`: the connection is **destroyed**, never returned to the pool with or without the lock.
- **DB failure on the lock client, or any `DB_FAILURE` / `TIMEOUT_DB_*`.** No further SQL on that client (no unlock, rollback or release work): `client.release(true)` destroys it, and the server ends the session and its lock.
- **Outstanding tail / step timeout.** The lock is retained until `finalize()`.

### 7.5 Results after a failure

There is no re-snapshot after `DB_FAILURE` or any timeout just to fill the result. `writes` are the **last acknowledged snapshot's** committed counts, with `countsAsOf: { seq, stale: true }`.

## 8. Journal (V1)

### 8.1 Authority

DB state is authoritative. The journal is an audit / approval binding, never a retry authority:
- no new intent, key or attempt to bypass uncertainty;
- no replay of a possibly-sent write;
- no phase replay because a journal write failed.

A new manifest or runId is never authority to bypass a dispatched / unknown op or an ended run. Later action requires separately reviewed scope.

### 8.2 Record

```
{ v:1, seq, prevHash, runId, intentId, manifestHash, baselineCommit, at, event, phase?, step?,
  state?, actions?: [token], refusals?: [{key, code}], writes?, factory?: {phase, reservationId|null}, attestation?: {checkpoint, evidenceRef}, code? }
```

- `event` ∈ `RUN_STARTED`, `STEP_STARTED`, `STEP_ENDED`, `PHASE_ENDED`, `ATTESTED`, `RUN_STOPPED`, `RUN_ENDED`.
- `prevHash` = sha256 of the previous record's canonical JSON, `"0"×64` for `seq` 1.

**Action grammar (exact; anything else is counted as `unlistedActions: n`, with no content):**

```
token    := NAME ( ":" CODE )? ( "->" STATE )?  |  "READ:" OPTYPE ":" OUTCOME  |  "RECOVERY:READ:" OPTYPE  |  "RECOVERY:" EVENT
NAME     := RESERVATION_STARTED | RESERVATION_DISPATCHED | CREATE_CLAIMED | RESERVATION_SUCCEEDED | CREATE_REF_NOT_ECHOED
            | RESERVATION_OUTCOME_UNKNOWN | CAPTURE_CLAIMED | CAPTURE_SUCCEEDED | CAPTURE_OUTCOME_UNKNOWN | ASSESSED | CLAIMED
            | COMPLETED | RECORDED | VOID_SUCCEEDED | ESCALATE | WAIT | STOP | UNKNOWN | SEND_ABORTED | LEASE_LOST
CODE     := [A-Z0-9_]{1,40}
STATE    := one of the 0001 intent states
OPTYPE   := hostaway.lookup_reservation | hostaway.retrieve_reservation | stripe.retrieve_payment_intent | hostaway.list_offline_charges
OUTCOME  := found | not_found | conflict | error | lease_lost
EVENT    := RECONCILED_RESERVATION_FOUND | RECONCILED_CAPTURE_SUCCEEDED | RECONCILIATION_INCONCLUSIVE | ESCALATE:CODE
```

The final grammar is taken from the worker sources at implementation time and pinned by a test. Tokens are matched whole, never by prefix.

**Redaction.** Allowed: ids, codes, counts, states, hashes, `evidenceRef`. Never: secrets, tokens, raw replies, error messages, guest name / e-mail / phone, card data.

**Integrity.** The hash chain is integrity evidence **relative to a trusted head** (e.g. the owner records the final `seq` + hash). It is not authentication: someone who can rewrite the whole chain can forge it.

### 8.3 Crash windows (V1: none of them resumes)

| Window | DB | Next invocation |
|---|---|---|
| Before `RUN_STARTED` is acknowledged | unchanged | Journal empty or unacknowledged → see §8.4. The intent is still `payment_authorized` with no dispatched op → a fresh start is allowed only if the journal is empty |
| After `RUN_STARTED`, anywhere until a terminal record | committed or uncertain | `RESTART_AMBIGUOUS`, **no worker invocation**, even if the DB looks successful |
| After `RUN_STOPPED` / `RUN_ENDED` | — | `RUN_ENDED` |
| Journal append fails mid-run | — | `JOURNAL_FAILURE` now: no further step or append |

### 8.4 Start / restart rule (V1)

Before P0 work, the runner reads the journal and validates **all** records:
- shape; `v`;
- `seq` contiguity;
- `prevHash` chain;
- identical `runId`, `intentId`, `manifestHash` and `baselineCommit` throughout, equal to this manifest;
- the event grammar and order (`RUN_STARTED` first; at most one terminal record, and it is last).

| Journal | Result |
|---|---|
| Empty, and the intent is eligible (§6.1 P0) | Start |
| Any acknowledged `RUN_STARTED` without a terminal record | `REFUSED: RESTART_AMBIGUOUS` |
| A terminal record | `REFUSED: RUN_ENDED` |
| A record for another run / intent / manifest / baseline | `REFUSED: MANIFEST_MISMATCH` |
| Torn / unparsable last record | `REFUSED: JOURNAL_PARTIAL` |
| Chain or seq break | `REFUSED: JOURNAL_CHAIN_INVALID` |
| A grammar violation | `REFUSED: JOURNAL_MALFORMED` |

All refusals happen with **zero** worker, transport or attest calls. No general resume exists in V1.

## 9. Smallest OFFLINE implementation slice (for root approval; not started)

**Proposed allowed files:**
- `scripts/e7-connected/run-manifest.mjs`, `run-facts.mjs`, `run-guard.mjs`, `run-core.mjs`, `run-journal-memory.mjs`;
- `test/e7-connected-run-manifest.test.mjs` (unit);
- `test/db/e7-connected-runner.test.mjs` (disposable PG, fakes, fixture authorization, fake monotonic / wait);
- status pointers.

No worker, `lib/`, SQL, fixture, config, package or containment-pin change.

**Acceptance matrix (all synthetic; fetch guard):**

| # | Case | Expected |
|---|---|---|
| 1 | Manifest: each owner field missing; S-LIVE; recording without capture; `paymentMethod` rule; pilots; non-USD; `synthetic:false`; non-fake modes; descriptor / proxy probes; stable hash | Refusal codes; zero calls |
| 2 | `opts.intentId` ≠ manifest; identity mismatch (ref / stay / amount / `rateBps`) | `INTENT_MISMATCH` / P0 refusal; zero worker calls |
| 3 | Happy chain with capture + recording | `ENDED_CONFIRMED`, `ownerCleanupRequired: confirmed`; one write each; notify queued; journal chain + redaction (no guest values) |
| 4 | `capture:false`; `recording:false` | `ENDED_RESERVED_NOT_CAPTURED` / `ENDED_CAPTURED_NOT_RECORDED` with the matching cleanup key; never "success" without it |
| 5 | Same-step recovery binding (no echo) | Candidate (a) before the next step; by-id read executed in-step; one create; continues |
| 6 | Unbound-factory by-id refusal (a planted fixture that queues a by-id read with no derivable candidate) | `RECOVERY_BINDING_UNAVAILABLE` via the run-guard recorder; zero provider calls for it; identical error rethrown to the worker |
| 7 | Applied-then-503 create (C) | `STOPPED: UNKNOWN_WRITE` / `OPEN_CASE` before any capture call; case left open |
| 8 | Failure void-only (D) | `ENDED_RELEASED`; zero Hostaway cancel / create |
| 9 | Thrown worker / DB error; COMMIT-loss simulation on the snapshot; lock-client failure | `DB_FAILURE`; zero follow-up step / provider call / SQL on the failed client; lock client destroyed; `countsAsOf.stale` |
| 10 | Unresolved fake create / capture raw promise (worker timeout path) | `LATE_TAIL_OUTSTANDING`; no next step; lock retained; `finalize()` releases after the tail; a late-evidence write after return is allowed and asserted to be evidence only |
| 11 | Hanging journal / attest / pool connect (fake monotonic) | `TIMEOUT_*`; no retry, no continue |
| 12 | Journal failure at each event | `JOURNAL_FAILURE`; no further step or append |
| 13 | Restart: acknowledged `RUN_STARTED` without a terminal record (even with the DB at `reservation_confirmed`); terminal record; foreign / partial / chain-broken / malformed journals | `RESTART_AMBIGUOUS` / `RUN_ENDED` / respective refusal; zero worker calls |
| 14 | Protected id planted in synthetic evidence | `PROTECTED_REFERENCE` |
| 15 | Run lock held | `RUN_LOCK_HELD` |
| 16 | Step / phase budget | `BUDGET_EXHAUSTED` |
| 17 | Run-level signal aborted between steps | `CANCELLED` |
| 18 | Attestation declined | `OWNER_DECLINED` |

**Remaining true blockers.** None for this offline slice.
- **Pilot listing:** a containment blocker (§3.3); V1 refuses it.
- **A real run** needs the CLOSED slices:
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
