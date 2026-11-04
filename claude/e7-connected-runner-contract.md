# E7 local connected-test RUNNER — CONTRACT (DOCS ONLY; every implementation item PROPOSED)

**Branch** `feature/e7-connected-runner-contract`, cut from exact `9f13c816b2e744565539f209c6b14f57bdc5987a`. All source citations are at that head; the runtime code is unchanged since `ede4c43c`, and the adapters were accepted at `b757d6b7`.

**What this is.** One concrete, reviewable design for the smallest **offline / injected-fake** orchestration foundation: a library that drives ONE booking through the accepted workers with per-step adapter factories, then stops.

**What it is not:**
- a CLI, a real transport, a credential loader, Stripe ingress or a live approval;
- automatic cancel / refund;
- a notification / owner-alert sender.

Those are independent, CLOSED slices. All owner inputs stay **UNSET**. Live gates stay **CLOSED**. Protected reservations 70636076 / 71045356 / 71072615 / 71081885 stay zero-action. The historical e74a listing-lock failure stays OPEN (FIRST FULL TAP / STOP).

## 1. Present runtime vs proposed orchestration vs simulated tests

| Layer | Status at this head |
|---|---|
| Workers | **Accepted code**, used unchanged: `runOrchestratorStep` (`reservation-worker.js:585`), `runCaptureStep` (`capture-worker.js:600`), `runRecordingStep` (`recording-worker.js:598`), `runCleanupStep` (`compensation-worker.js:643`). Each step does its own scoped maintenance, recovery pass, at most one claim, its own provider calls and its own bounded budget |
| Executor adapters | **Accepted** (`scripts/e7-connected/executor-adapters.mjs`, `b757d6b7`): immutable per-factory binding, bound-id refusal, one invocation, no retry |
| Recovery-candidate provenance | Exists **only test-locally** (`recoveryCandidate` in `test/db/e7-connected-adapter-rehearsal.test.mjs`). It does not enforce production provenance or concurrency |
| Runner (this contract) | **PROPOSED**. Nothing exists |
| Real transports, credentials, Stripe TEST ingress, live CLI, file journal | **CLOSED**, separate slices |

## 2. Proposed files and exports (offline foundation only)

All files live under `scripts/` (excluded from upload, `.vercelignore`). They are pure orchestration with injected I/O: there is no `process.env`, no `fetch`, no file system and no SDK. The names avoid the identifiers that accepted containment tests pin (`hostaway-reservations`, `connectedTestAdapterConfig`, `allowRequest:`).

### 2.1 `scripts/e7-connected/run-manifest.mjs`

`validateRunManifest(input) → { ok:true, manifest, hash } | { ok:false, code }`
- The manifest is a deep-frozen R-G1 descriptor snapshot.
- `hash` = sha256 of `'e7-run-manifest-v1\n' + canonical JSON` (sorted keys; strings, safe integers and booleans only).

### 2.2 `scripts/e7-connected/run-facts.mjs`

`readRunSnapshot(reportPool, intentId) → frozen facts`
- One READ ONLY REPEATABLE READ transaction, as the report role; see §4.

`readGuestBinding(appPool, intentId) → { firstName, lastName, email } | null`
- One statement, as the app role. The values are never journaled.

`deriveRecoveryCandidate(facts) → { ok:true, id, sources } | { ok:false, code }`
- See §5.

### 2.3 `scripts/e7-connected/run-core.mjs`

`runConnectedTest(opts) → Promise<frozen RunResult>`

`opts` must have **exactly** these keys:

| Key | Contents |
|---|---|
| `manifest` | an object that passes `validateRunManifest` |
| `intentId` | the existing booking intent (see §6 P0) |
| `pools` | `{ app, report }`: injected `pg` pools to the ONE disposable test DB |
| `transports` | `{ hostaway:{send}, stripe:{send} }`: injected, passed straight to `createPhaseExecutors` |
| `journal` | `{ append(record) → Promise<void>, read() → Promise<record[]> }`: injected, see §8 |
| `attest` | `(checkpoint, request) → Promise<{ ok:boolean, evidenceRef?:string }>`: injected owner attestation, see §6 |
| `clock` | `() → ms`: one real clock for all workers (recording's skew gate) |
| `sleep` | `(ms, signal) → Promise`: injected |
| `signal` | a genuine run-level `AbortSignal` (checked natively, as in R-A2) |

Rules:
- The options basis is validated and frozen before any await (R-G1 rules).
- Invalid options → `{ ok:false, code:'OPTIONS_INVALID' }`, with **zero** DB, transport, journal or attest calls.

`RunResult`, frozen:

```js
{ ok, outcome, stopCode?, phase, steps, writes: { create, capture, record, void, cancel }, manifestHash, journalSeq }
```

| Field | Values |
|---|---|
| `outcome` | `COMPLETED_CONFIRMED`, `COMPLETED_RELEASED`, `STOPPED` or `REFUSED` |
| `writes` | write counts as seen in committed DB rows |

### 2.4 `scripts/e7-connected/run-journal-memory.mjs`

`createMemoryJournal({ failAt? })` returns an in-memory journal for offline tests only, with failure injection. A real atomic file journal is a later reviewed slice (§8.4).

## 3. Manifest (one immutable manifest per run; stable hash)

Schema `e7-run-manifest-v1`, exact keys, **no defaults anywhere**:

| Key | Rule |
|---|---|
| `version` | `"e7-run-manifest-v1"` |
| `runId` | `^[a-z0-9-]{8,64}$` |
| `baselineCommit` | 40-hex commit the run was reviewed at |
| `synthetic` | boolean. `true` only for offline tests: then every owner field may hold synthetic values, and both transports must be the injected fakes. `false` → every owner field below must be an explicit owner value, and this foundation refuses (`REAL_RUN_NOT_IN_THIS_SLICE`) |
| `providerMode` | `{ hostaway: "fake" \| "real", stripe: "mock" \| "test" }`. **`"live"` → `S_LIVE_REFUSED`** (the accepted proofs refuse LIVE money: `capture-proof.js:97`, `compensation-proof.js:184`). This foundation accepts only `{hostaway:"fake", stripe:"mock"}` with `synthetic: true` |
| `listing` | `{ id, currency }` (+ `pilotException` only in the E4 MXN form). USD direction: recording requires USD (`offline-charge-proof.js:33`); `603564` refused; `603566` only as the adapter's pilot exception, never with recording |
| `stay` | `{ arrival, departure, guests }` |
| `amountMinor` | positive integer; must equal the intent's `price.finalTotalMinor` |
| `guest` | `"bound-from-db"`, the only value. The runner never accepts contact data in the manifest; the binding comes from the guest row (§4) |
| `stripeAccountId` | `acct_…`. TEST-account verification is the capture / cleanup workers' own `accounts.retrieve` id equality (`capture-worker.js:219`); this is not Hostaway ownership |
| `hostawayAccountLabel` | `{ accountRef, clientSnapshotId }`: **TRUST labels**, not verified account ownership |
| `paymentMethod` | `"credit_card"` or `"other"`. Required iff recording is in scope |
| `phases` | `{ capture: boolean, recording: boolean }`. If `providerMode.stripe === "mock"` and Hostaway is real, `recording` must be `false` (`MOCK_MONEY_RECORDING_REFUSED`) |
| `cleanup` | `{ reservedNotConfirmed, captured, confirmed }`: each a non-empty procedure reference (owner-approved document id), or `"not-applicable"` only when the phase flags make that outcome impossible |
| `automationsReviewed` | non-empty reference to the Hostaway / Airbnb automation check (their own guest messages / payment requests), or a synthetic marker if `synthetic` |
| `checkpoints` | exactly `["CALENDAR_BASELINE", "AIRBNB_BLOCKED", "AIRBNB_REOPENED"]` |

Refusal codes:
- `MANIFEST_SHAPE`;
- `MANIFEST_OWNER_INPUT_MISSING` (any owner field absent, empty or defaulted);
- `S_LIVE_REFUSED`, `MOCK_MONEY_RECORDING_REFUSED`, `PILOT_RULE`, `CURRENCY_RULE`;
- `REAL_RUN_NOT_IN_THIS_SLICE`.

A transport labelled "fake" does not make a real transport available, and a real transport is never constructed here.

## 4. Persisted facts: roles, snapshot, race, exclusive run

**Roles.** No owner / schema-owner access is needed:
- The report role (`mv_booking_report`) may SELECT `intents`, `intent_transitions`, `intent_work`, `external_operations`, `reconciliation_cases`, `provider_evidence` (`0002:36–40`, `0003:709`; RLS `report_ro`, `0002:51`, `0003:720`). It has **no** guest data (`0002:35`, `:50`).
- The guest row (`intent_guests`) is readable by the app role only (`0002:29–31`, `:49`). The reservation worker itself reads it that way (`reservation-worker.js:179`).

No new API or grant is proposed. The rehearsal's owner-role SELECTs are test-only and are replaced by these roles.

**Snapshot.** `readRunSnapshot` uses ONE short `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` transaction on a fresh report connection. Every fact below comes from one snapshot, and the transaction is committed and released **before** any worker step. No DB transaction is held across a worker or network call. Facts read:
- the intent (state, version, ref, listing, dates, guests, price, payment, `hostaway_reservation_id`);
- its operations by type (state, attempts, `result_ref`, `payload`, `dispatched_at`, error code);
- `hostaway_reservation` evidence, joined to its read-operation type;
- open reconciliation cases;
- the `booking.instance` marker.

**Documented race.** The snapshot is only a basis: workers may commit new facts after it, and inside the step. The runner relies on:
- **(a)** the adapter's immutable binding, which refuses any off-scope id **before** invocation;
- **(b)** the next snapshot, after the step, as authoritative.

It never acts on a fact it has not observed in a committed snapshot.

**Exclusive run (proposed, enforceable).**
- **One runner per disposable test DB.** At start the runner takes a session-level `pg_try_advisory_lock(hashtext('e7-connected-runner'), 0)` on a dedicated report-role connection held for the whole run. Not acquired → `REFUSED: RUN_LOCK_HELD`.
  - This lock coordinates **runners only**. It is not a DB transaction and does not fence workers.
  - The DB must report `booking.instance = 'test'` (also asserted by every worker).
- **Scope narrowing.** Every step passes `intentId`, a one-listing `listings` map and the phase's adapter factory. Workers' own scoped maintenance applies. The runner never calls generic or global maintenance, inbox drain, `runNotificationStep` or any owner-alert dispatch.
- **Not claimed.** The test-local `recoveryCandidate` and this contract do not make production provenance or concurrency safe. Other writers to the same DB are out of scope by construction (disposable DB, one run).

## 5. Candidate provenance before a reservation step

`deriveRecoveryCandidate(snapshot)`, evaluated **before** every reservation step:
1. **Phase.** The intent state must be `payment_authorized`, `reservation_pending` or `reservation_unknown` (`reservation-worker.js:54`). Anything else → no reservation step.
2. **Candidates** from committed facts only:
   - **(a)** a `hostaway.create_reservation` op with `state = succeeded` and a `result_ref`;
   - **(b)** `hostaway_reservation` evidence from a `hostaway.lookup_reservation` read with status `found_active`, `observed.bookingRef` = the intent ref, `matchCount = 1`; its id is `external_ref`;
   - **(c)** `intents.hostaway_reservation_id`.
3. Distinct ids `> 1` → `STOP: CANDIDATE_CONFLICT`. Any protected id among them, or in any evidence or op payload of the intent → `STOP: PROTECTED_REFERENCE`.
4. **Open reads.** Any open (`pending` / `in_flight`) `hostaway.retrieve_reservation` naming another id → `STOP: OPEN_READ_CONFLICT`.
5. **Pending create.** If the create op is still `pending` (undispatched) and a candidate exists → `STOP: CANDIDATE_BEFORE_CREATE`. If it is `pending` with no candidate → creation factory (`reservation`, unbound).
6. **One candidate** → `reservation-recovery` factory bound to it. Creation is impossible; only that id is readable.

Facts first created **during** a step cannot be used beforehand. A step that needs an id not yet derivable runs with the unbound factory: its by-id read refuses with zero provider calls, and the worker records that read as a read failure, the accepted handling of executor rejections.

The runner treats any such refused read in the step result as `STOP: RECOVERY_BINDING_UNAVAILABLE`. It never reruns blindly or guesses. In the accepted rehearsal this never occurred: the candidate was always derivable from facts committed by the previous step (§3 there).

**Post-step audit (supporting evidence only).** Every by-id read executed in the step named the bound id, and the write counts did not exceed one per accepted op.

## 6. Phases, gates and pauses

The foundation starts from an **existing** intent in `payment_authorized`, whose listing / dates / guests / amount / ref match the manifest.
- **Authorization fixture.** For offline tests, the booking up to `payment_authorized` is produced by synthetic setup with a mocked authorization, as in the accepted rehearsals. It is labelled a fixture and proves nothing about a real card.
- **Verified TEST ingress.** A verified Stripe TEST checkout + webhook (`processVerifiedStripeEvent`, `stripe-test-webhook.js:102`) is a separate CLOSED slice.

The two are never conflated: `manifest.synthetic === true` ⇒ fixture only.

| # | Phase | Entry gate | Worker / bound | Exit |
|---|---|---|---|---|
| P0 | Preflight | Options + manifest valid; run lock; marker `test`; intent identity = manifest; no open case; no op `outcome_unknown` / `escalated` / `in_flight`; protected-reference scan clean; journal head consistent (§8) | none | journal `RUN_STARTED` |
| P1 | Pre-create gate | **All** cleanup procedures present for every possible outcome: reserved-not-confirmed (incl. a real reservation with no capture), captured, confirmed. `automationsReviewed` present. `attest("CALENDAR_BASELINE")` ok with an `evidenceRef` | none | — |
| P2 | Reservation | Fresh snapshot + §5 before **each** step | `runOrchestratorStep`; ≤ 12 steps, ≤ 15 min elapsed (covers `FRESH_AFTER_DISPATCH_MS` 2 min, `recovery-plan.js:30`, and grace 2 min, `recovery.js:28`) | `reservation_confirmed` → `attest("AIRBNB_BLOCKED")`; `reservation_failed` → P5 |
| P3 | Capture (if `phases.capture`) | Fresh snapshot: **no open case**, no unknown / escalated op. The capture worker has no open-case check of its own (no `reconciliation_cases` reference in `capture-worker.js` / `capture-proof.js`), so this gate is the runner's | `runCaptureStep`; ≤ 6 steps, ≤ 10 min | `payment_captured` |
| P4 | Recording (if `phases.recording`) | Same gates + USD + method | `runRecordingStep`; ≤ 6 steps, ≤ 10 min | `confirmed` → `COMPLETED_CONFIRMED` |
| P5 | Failure compensation | Only `reservation_failed` / `capture_failed` (`compensation-worker.js:50`), state-specific (`:103–107`) | `runCleanupStep`; ≤ 8 steps, ≤ 15 min | `authorization_released` / `cancelled` → `attest("AIRBNB_REOPENED")` if a reservation had existed → `COMPLETED_RELEASED` |

Rules for every phase:
- **Between steps** the runner sleeps the worker's returned `delayMs`, capped by the phase budget, and awaits the step's `late` promise (bounded by the phase budget) before the next snapshot.
- **Run-level signal.** If it is aborted, the runner stops **between** steps (`STOPPED: CANCELLED`). It never aborts a step from outside; the step's own budgets apply.
- **Attestations** are owner statements with evidence references. Program state is never proof of Airbnb behaviour. A declined or failed attestation → `STOPPED: OWNER_DECLINED` / `ATTESTATION_FAILED`, with no further action.
- **A successfully reserved booking that cannot reach `confirmed`** (stop, mock money, P branch) is never "cleaned up" by the runner. It ends `STOPPED`, and the owner procedure in `manifest.cleanup.reservedNotConfirmed` applies. No automatic cancel / refund exists for a successful reserved / captured / confirmed booking, and none is designed here.

## 7. STOP policy

Any of the following **ends the automatic run**. After it, the runner makes no further worker step, provider call, release or retry, and writes only a final journal record (if possible).

| Code | Trigger |
|---|---|
| `DB_FAILURE` | any thrown error from a DB call or a worker step (outer DB failure / COMMIT uncertainty); the original error is not kept or journaled, code only |
| `PROTECTED_REFERENCE` | a protected id anywhere in snapshot facts or step results |
| `CANDIDATE_CONFLICT`, `OPEN_READ_CONFLICT`, `CANDIDATE_BEFORE_CREATE`, `RECOVERY_BINDING_UNAVAILABLE` | §5 |
| `UNKNOWN_WRITE` | any provider-write op `outcome_unknown` / `escalated`, or an `UNKNOWN:` / `*_OUTCOME_UNKNOWN` action |
| `OPEN_CASE` | any open reconciliation case for the intent, checked after every step. **Scenario C:** `reservation_confirmed` does **not** clear `HOSTAWAY_CREATE_OUTCOME_UNKNOWN`, so the run stops before capture. A later read-only recovery or review needs a separate, explicitly approved, bounded phase in a later approval. An ended run is never resumed silently, and the runner never closes cases |
| `STEP_REFUSED` | a worker returned `status: "refused"` (gate) |
| `STATE_UNEXPECTED` | a state outside the phase's allowed set |
| `BUDGET_EXHAUSTED` | step count / elapsed budget reached |
| `JOURNAL_FAILURE` | an append failed (§8) |
| `CANCELLED`, `OWNER_DECLINED`, `ATTESTATION_FAILED` | §6 |

**Boundary (what the runner cannot prevent).** Inside one call to an accepted step function, the worker performs its own maintenance, recovery pass, reads and at most one write, under its own fences. The runner acts only **between** steps: it cannot stop a write already inside a step, and it cannot undo one.

B's `RECOVER_INTERRUPTED → reservation_unknown` is the worker's accepted behaviour. That path has no unknown write and no open case, so P2 may continue its bounded read-only recovery steps (the recovery factory makes creation impossible). C's path stops at `UNKNOWN_WRITE` / `OPEN_CASE` immediately after the create step.

## 8. Journal and restart

### 8.1 Authority

Committed DB operation state is **authoritative**. The journal is an audit / approval binding, never a retry authority. The runner never mints a new intent, key or attempt to get around uncertainty. It never replays a possibly-sent write, and never replays a phase because a journal write failed.

### 8.2 Record format (JSONL; one record per event)

```
{ v:1, seq, prevHash, runId, manifestHash, baselineCommit, at, event, phase?, step?, intentId,
  state?, codes?: [..], writes?: {create,capture,record,void,cancel}, factory?: {phase, reservationId|null}, attestation?: {checkpoint, evidenceRef} }
```

- Events: `RUN_STARTED`, `STEP_STARTED`, `STEP_ENDED`, `PHASE_ENDED`, `ATTESTED`, `RUN_STOPPED`, `RUN_COMPLETED`.
- `prevHash` is the sha256 of the previous record line, so a gap or edit is detectable.
- **Redaction.**
  - Allowed: codes, ids, counts, states, hashes.
  - Never: secrets, tokens, raw provider replies, error messages, guest name / e-mail / phone, card data.
  - Worker `actions` are reduced to the allowlisted code prefixes (`RESERVATION_*`, `CAPTURE_*`, `READ:*`, `RECOVERY:*`, `WAIT:*`, `STOP:*`, `UNKNOWN:*`).

### 8.3 Crash windows

| Window | Persisted | Restart behaviour |
|---|---|---|
| Before `STEP_STARTED` is acknowledged | DB unchanged by this step | Re-snapshot; may continue only via §8.5 |
| After `STEP_STARTED`, during / after the worker commit, before `STEP_ENDED` | Worker effects committed (or uncertain) | DB snapshot decides. Any in-flight / unknown op or open case → `STOPPED`, never re-sent |
| After `STEP_ENDED` | Both | Normal |
| Journal append fails | — | `STOPPED: JOURNAL_FAILURE` immediately: no next step, no "replay to fix the journal" |

### 8.4 Persistence (later slice, CLOSED here)

- The file journal will be local filesystem only, append + fsync per record, in a directory chosen by the owner.
- The first record must be the manifest hash; an existing journal for another hash → `REFUSED: MANIFEST_MISMATCH`.
- A partial / torn last line → `REFUSED: JOURNAL_PARTIAL`, owner review.

### 8.5 Restart

A new invocation with the same manifest hash and journal:
- It runs P0 (§6) plus a journal-vs-DB comparison: last journal state vs DB state, and journal write counts vs committed DB counts.
- The run continues **only** if the journal ends without `RUN_STOPPED` / `RUN_COMPLETED`, the DB shows no in-flight / unknown / escalated op, there is no open case, and the counts are consistent.
- Otherwise → `REFUSED: RESTART_AMBIGUOUS` or `RUN_ENDED`.
- A stopped or completed run is **never** resumed. Any later action needs a new reviewed manifest and approval.

## 9. Smallest OFFLINE implementation slice (for root approval; not started)

**Proposed allowed files:**
- the four `scripts/e7-connected/run-*.mjs` above;
- `test/e7-connected-run-manifest.test.mjs` (unit);
- `test/db/e7-connected-runner.test.mjs` (disposable PG, injected fakes, memory journal);
- status pointers.

No change to workers, `lib/`, SQL, fixtures, config or packages.

**Acceptance tests (synthetic, fetch guard, fake transports):**
1. Manifest:
   - every owner field missing → refused;
   - `S-LIVE`, mock-money recording, pilot / currency rules refused;
   - `synthetic: false` → `REAL_RUN_NOT_IN_THIS_SLICE`;
   - stable hash; descriptor / proxy probes;
   - zero calls on refusal.
2. Happy chain (A) → `COMPLETED_CONFIRMED`: one write each, notify queued, journal sequence + hash chain, redaction (no guest values in the journal).
3. Same-step recovery binding (B): no-echo → candidate (a) before the next step → recovery factory → the by-id read executed in-step → `reservation_confirmed` → capture → recording; exactly one by-id read; no second create.
4. Open-case stop (C): `STOPPED: UNKNOWN_WRITE` / `OPEN_CASE` before any capture call (capture transport count 0); the case is left open; the run cannot be resumed.
5. Failure void-only (D) → `COMPLETED_RELEASED`, zero Hostaway cancel / create.
6. Thrown DB / worker error → `STOPPED: DB_FAILURE`, with no follow-up step / provider call / journal step record (asserted via counters).
7. Restart: crash after a worker commit before `STEP_ENDED` with an unknown op → `RESTART_AMBIGUOUS`, no resend. Clean restart continues. A completed / stopped run → `RUN_ENDED`.
8. Manifest mismatch → refused; partial journal → refused (memory-journal simulation).
9. Protected id planted in synthetic evidence → `STOPPED: PROTECTED_REFERENCE`, zero provider calls after.
10. Bounded steps → `BUDGET_EXHAUSTED`; run lock held → `RUN_LOCK_HELD`; run-level signal aborted between steps → `CANCELLED` (no step started).
11. Journal append failure → `JOURNAL_FAILURE`, no next step.

**Blockers and minimal proposed changes.** None to the accepted workers.
- The runner uses only existing step functions, the adapters, and role-appropriate SELECTs.
- A real run additionally needs closed slices:
  - real transports with proven zero automatic retries;
  - a credential loader;
  - Stripe TEST ingress;
  - the file journal;
  - a live CLI;
  - the read-only provider probes (cancel / offline-charge endpoints remain LIVE-UNVERIFIED);
  - the owner decisions below.

## 10. Owner decisions (UNSET; for the later consolidated approval, not needed for the offline slice)

1. Listing and currency.
2. Dates, guest and amount.
3. Verified Stripe TEST account and Hostaway account.
4. `paymentMethod`.
5. Provider mode and phase scope.
6. Hostaway / Airbnb automation scope.
7. The cleanup procedure for every possible outcome.

Routine technical choices (budgets, journal format, lock key, file layout) are root's.
