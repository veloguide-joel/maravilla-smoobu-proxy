# E7 connected-test adapter / worker integration rehearsal — TESTS + REPORT ONLY

**Branch** `feature/e7-connected-adapter-rehearsal`, cut from exact `b757d6b72ca37c5a66d07bf31de6e33615c6e847`.

**Files:**
- new `test/db/e7-connected-adapter-rehearsal.test.mjs`;
- this report;
- a status pointer + the G10 erratum in `claude/e7-connected-test-manifest.md`.

**Unchanged:** runtime, the adapter module, `lib/`, workers, migrations, fixtures, config, packages, routes. There is no runner or CLI.

**Status.** OFFLINE / INJECTED-FAKE evidence on a disposable local TEST-marked PostgreSQL, CLAUDE-RUN. **Not** provider, account, payment, deployment or live readiness; nothing here opens a live gate, and every owner input stays UNSET.

## 1. What was rehearsed, and how

**Real accepted code throughout.**
- Workers: `runOrchestratorStep`, `runCaptureStep`, `runRecordingStep` and `runCleanupStep`, called through their public step functions, scoped to one booking.
- Executors: every executor object handed to them is the output of the accepted `createPhaseExecutors` (`scripts/e7-connected/executor-adapters.mjs`, accepted at `b757d6b7`).
- Pricing: the reservation worker's own bounded pricing wrapper calls `priceStay`, which calls `pricing.get` / `pricing.post` **through the adapter**. There is no bypass executor.

**Fake transports.** The adapters' documented envelopes (`hostaway.send(request, {signal})`, `stripe.send(call, {signal})`) route into one coherent synthetic world per booking. That world is the accepted lifecycle rehearsal's, copied test-locally and labelled SYNTHETIC / DOC-DERIVED / LIVE-UNVERIFIED. This file adds two create reply modes:
- `noEcho`: the reservation is stored, and the reply has `customFieldValues: []`;
- `appliedThen503`: the reservation is stored, and the reply is HTTP 503.

Every transport request is recorded. Each request is asserted to carry exactly one `/v1` prefix and the worker's live `AbortSignal`. A global fetch guard recorded 0 network attempts.

**Test-local harness (not a production runner).**
- Before **every** bounded step it builds a **fresh, immutable** factory from the persisted DB facts at that moment: there is no mutable binding and no reply auto-adoption.
- Facts the accepted runtime API does not expose read-only are read with labelled **TEST-ONLY SELECTs** as the schema owner (nothing is written): operation rows (capture / void idempotency keys, create `result_ref`, by-id read payloads), provider evidence, and the guest row (create binding).
- **The manifest §9.2a recovery-candidate check is implemented test-locally** (`recoveryCandidate`). The adapter module itself does **not** enforce DB provenance.

**Setup and limits.**
- Setup up to `payment_authorized` follows the accepted lifecycle rehearsal (synthetic; repo functions plus a mocked authorization). After that, every transition was written by an accepted worker.
- None of these were used: trigger disabling, raw operation INSERT / UPDATE, manual completion, a `due()` helper, new hooks.
- Clocks: an injected clock (20 min behind real time, only advanced, never past it) for reservation / capture / cleanup; the real clock for recording (its skew gate). Every loop is bounded and source-defined freshness / backoff / leases apply.
- Never called: `runNotificationStep`, owner-alert dispatch, inbox drain, global / generic maintenance.

## 2. Results

| # | Scenario | Result (asserted) |
|---|---|---|
| A | Fresh USD booking: reservation → capture → recording | `confirmed`. Ledger `… payment_authorized > reservation_pending > reservation_pending > reservation_confirmed > payment_captured > confirmed`. Writes: world invocations, transport write requests and DB dispatches all = create 1, capture 1, offline charge 1, void 0, cancel 0. Persisted binding: intent ↔ reservation id ↔ capture row (PI, amount, charge) ↔ recording row `och:{intent}:1` ↔ settled evidence (reservation, amount, method, TRUST account label) ↔ assessment → claim audit. `guest.notify`: one row `pending`, never dispatched. Two further rounds of all four workers (fresh factories): idle, zero provider requests. One fresh factory per bounded step (`reservation, reservation, capture, recording`) |
| B | **Missing ref echo** (`noEcho`) | Step 2 → `CREATE_REF_NOT_ECHOED:READS_REQUIRED`. The create row is `succeeded`, attempts 1, `result_ref` = the provider id, and **`intents.hostaway_reservation_id` is still NULL**. §9.2a gives exactly one candidate from source (a), the succeeded create `result_ref`. From then on, each step's fresh factory is `reservation-recovery` bound to that id. The accepted recovery path ran: `RECOVER_INTERRUPTED → reservation_unknown`, then a by-ref lookup (found), then **exactly one** by-id read (`rr:…:hostaway.retrieve_reservation:{id}:1`, succeeded, attempts 1), then `RECONCILED_RESERVATION_FOUND → reservation_confirmed`. Both lookup and by-id evidence are `found_active` for the id / ref. One create in total (world, transport, rows); no owner case |
| B-neg | Conflicting / protected candidate provenance | On the same persisted facts, modified test-locally: a second lookup candidate → `CANDIDATE_CONFLICT`; a protected `result_ref` → `PROTECTED_CANDIDATE`; an open by-id read naming another id → `OPEN_READ_CONFLICT`; a protected id in a recovery binding → `BINDING_INVALID`. No factory built, **zero fake provider invocations** |
| C | **Ambiguous create**: the fake applies it, then returns 503 | `RESERVATION_OUTCOME_UNKNOWN:UPSTREAM_5XX → reservation_unknown`. Create row `outcome_unknown`, attempts 1, no `result_ref`; owner case `HOSTAWAY_CREATE_OUTCOME_UNKNOWN` opened. Factories stay **unbound** until by-ref lookup evidence names ONE candidate, source (b). The next fresh factory is `reservation-recovery`, and the accepted path ran by-id read (found), then `RECONCILED_RESERVATION_FOUND → reservation_confirmed`. **One create** in total; no new create row or key across all steps and two further steps. The create row stays `outcome_unknown` and **the owner case stays OPEN** after reconciliation (accepted behaviour, reported, not changed) |
| D | Failure cleanup, state-specific | A fresh price recheck → `reservation_failed`. The cleanup factory has **no bound reservation**: authorization void only (`paymentIntents.cancel` ×1), then `authorization_released`. **Zero** Hostaway cancel or create requests. The not-charged `guest.notify` is queued, never dispatched. A further idle round: zero requests |

`capture_failed` cancel coverage was **not** added: no test-applied fixture event was used.

## 3. Findings

1. **The §9.2a order needs one correction (proposed; the manifest is not changed beyond the allowed erratum).** In C, the accepted reservation step **queued and claimed** the by-id read in the **same** step (`RECOVERY:READ:hostaway.retrieve_reservation | READ:hostaway.retrieve_reservation:found`): `recoveryPass` runs before the work claim in `runOrchestratorStep`.
   - So a runner cannot wait for a pending by-id read (§9.2a item 1) before choosing the factory. It must derive the candidate beforehand from the facts that already exist: source (a), (b) or (c), with the conflict, protected and open-read checks.
   - It then relies on the adapter refusing any other id before invocation, and verifies afterwards that every executed by-id read named the bound id. This test does exactly that.
   - Suggested wording for §9.2a item 1: "**any** open by-id read must name the candidate; a read queued during the step is covered by the bound-id refusal and verified afterwards."
2. **A ref-not-echoed create goes through `RECOVER_INTERRUPTED → reservation_unknown`** before reconciliation (B). That is the accepted interrupted-reservation recovery. It is the exact runtime path, not a failure.
3. **The ambiguous-create owner case remains open after a successful reconciliation** (C). The accepted runtime never auto-closes it. A live runbook must expect an open `HOSTAWAY_CREATE_OUTCOME_UNKNOWN` case even when the booking ends `reservation_confirmed`. Whether capture is affected by that open case was not exercised here.
4. No adapter refusal was hit by any legitimate worker request in A–D: every step's actions show successful reads and writes, not `READ_REPLY_NOT_USABLE` or transport-failure unknowns.

## 4. What this proves, and what it does not

**Proves (offline, injected fakes, schema 0001–0016):**
- The accepted workers exercise the accepted adapter outputs end to end: pricing wrapper, lookup, create, by-id recovery, capture, PI reads, void, offline-charge list / create.
- The worker request shapes, the adapter validation and the documented transport envelopes are mutually compatible on the success, ref-not-echoed, ambiguous-create and failure-void paths.
- Immutable per-step factories rebuilt from persisted facts are sufficient for these paths; no binding mutation or reply adoption is needed.
- At most one invocation of each non-idempotent write per booking on every rehearsed path.

**Does not prove:**
- real Hostaway / Stripe behaviour or shapes (all DOC-DERIVED / LIVE-UNVERIFIED), including the cancel and offline-charge endpoints;
- account ownership (labels are TRUST);
- real transports (zero-retry SDK / auth construction);
- runner provenance code;
- real latency or concurrency;
- `capture_failed` cleanup;
- any confirmed / captured booking cleanup (not implemented);
- notification delivery;
- any deployment.

It does not supersede or add to the original lifecycle rehearsal's claims.

## 5. Runs (CLAUDE-RUN; full TAP kept in the session scratchpad `gnf/tap/car-*.tap`)

| Run | Result |
|---|---|
| Focused PG `test/db/e7-connected-adapter-rehearsal.test.mjs` | 5 / 5 |
| Adapter unit `test/e7-connected-executor-adapters.test.mjs` | 17 / 17 |
| Regressions: lifecycle, e72 reservation, e73b capture, e74a compensation, notification worker | 98 / 98 |
| `npm test` | **738 / 738** (unchanged: no unit file added) |
| `test:db`, once, full TAP `car-test-db-FIRST.tap` | **466 / 466** (461 + 5); the e74a listing-lock guard passed (not reproduced) |

The historical e74a listing-lock failure stays OPEN. Rule: FIRST FULL TAP and STOP on any reproduction, never rerun green.

Live gates are CLOSED. Owner inputs are UNSET. Protected 70636076 / 71045356 / 71072615 / 71081885: zero action (negative probes are synthetic only; asserted absent from every fake request and mock reservation).
