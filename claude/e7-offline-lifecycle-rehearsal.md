# E7 offline lifecycle rehearsal — reservation → capture → recording (+ compensation) on ONE disposable booking

**Branch.** `feature/e7-offline-lifecycle-rehearsal`, cut from exact `e0191684d3810062baf0aa4c09c6c70a572a6c47` (clean tree; ancestry of `6f5f704` / `ddda945` checked).
**Scope.** TESTS + REPORT ONLY. Files: `test/db/e7-offline-lifecycle.test.mjs` (new), this report (new), a one-line status pointer in `claude/e74b-recording-worker-contract.md`. Runtime code, pure modules, migrations 0001–0014, fixtures, config, dependencies, routes, UI and the adapter are **unchanged**. No new orchestrator or runnable provider entrypoint.
**Status.** OFFLINE / INJECTED-MOCK evidence, CLAUDE-RUN on a disposable local PostgreSQL 16. **Not** live, provider, account, payment or deployment readiness.

## 1. What was rehearsed, and how

The four ACCEPTED workers were driven in sequence on the same booking, each through its real public step function, scoped to that booking:

| Worker | Step function | Phase states it works |
|---|---|---|
| reservation (E7.2) | `runOrchestratorStep` | `payment_authorized`, `reservation_pending`, `reservation_unknown` |
| capture (E7.3b) | `runCaptureStep` | `reservation_confirmed`, `capture_unknown` |
| recording (E7.4b) | `runRecordingStep` | `payment_captured` |
| compensation (E7.4a) | `runCleanupStep` | `reservation_failed`, `capture_failed` |

**Starting point.** A fresh `payment_authorized` USD booking built with the reviewed repo functions: create intent, `PRICE_CONFIRMED` from a fresh `priceStay` against the mock world, guest details, pay step + recorded Checkout Session, mocked `PAYMENT_AUTHORIZED`. This is the same path the accepted E7.2 suite uses. **No** `F.reserved` / `F.captured` / `F.confirmed`. No success event, evidence row, assessment or claim audit was written directly. Every fact after `payment_authorized` was written by a worker. Test 1 asserts this: every post-authorization transition is a worker event (`RESERVATION_STARTED`, `RESERVATION_DISPATCHED`, `RESERVATION_SUCCEEDED`, `CAPTURE_SUCCEEDED`, `OFFLINE_CHARGE_RECORDED`).

**One coherent mock world per booking (SYNTHETIC, DOC-DERIVED, LIVE-UNVERIFIED).** Hostaway pricing, reservations and offline charges plus one Stripe PaymentIntent live in one in-memory object. A mock only reports what that same world did:
- the reservation it created;
- the capture it applied;
- the charge it stored.

Exact executor key sets per worker. Deterministic id blocks (no random buckets). TRUST labels `acct-test-1` / `client-LC` (never authentication). FIXTURE Stripe account id. FIXTURE `paymentMethod` values `credit_card` and `other`, with no owner default or choice implied. USD everywhere.

**Clocks (test-only, labelled in the file).**
- The reservation, capture and compensation workers take an injected clock that starts 20 min before real time and only moves forward, never past real time. The 2-minute evidence-freshness / recovery-grace windows elapse without sleeping.
- The recording worker uses the real clock, as its W-5 ±2 s DB-skew gate requires.
- TEST SETUP `due()` only makes the work row due and free between bounded recording steps.
- `max_attempts`, backoff, fences and triggers are never changed or bypassed. Every loop is bounded (≤ 8 steps).

**No provider network.** `globalThis.fetch` is trapped for the whole file; 0 attempts.

## 2. Results per scenario (provider WRITE counts are invocations of the mock write functions)

Write columns: create = `createReservation`, capture = `capturePaymentIntent`, record = `createOfflineCharge`, void = `cancelPaymentIntent`, cancel = `cancelReservation`.

| # | Start → end | Worker invocations that acted (idle probes excluded) | create | capture | record | void | cancel | Queued vs executed |
|---|---|---|---|---|---|---|---|---|
| 1 ×2 (`credit_card`, `other`) | `payment_authorized` → **`confirmed`** | R: `RESERVATION_STARTED->reservation_pending`; R: `RESERVATION_DISPATCHED`, `CREATE_CLAIMED`, `RESERVATION_SUCCEEDED->reservation_confirmed`; C: `CAPTURE_CLAIMED`, `CAPTURE_SUCCEEDED->payment_captured`; W: `READ:ID:OK`, `READ:LIST:OK`, `ASSESSED:eligible`, `CLAIMED`, `COMPLETED`, `RECORDED->confirmed` | 1 | 1 | 1 | 0 | 0 | 1 `guest.notify` **pending, never dispatched**; 2 conflict-inbox items **unprocessed** |
| 2 | `payment_authorized` → **`confirmed`** | R ×2; C with `afterComplete` hook fault (capture applied, row `succeeded`, event missing, state still `reservation_confirmed`); W / K idle; C ×4 (recovery: `CAPTURE_OUTCOME_UNKNOWN`, fresh PI read, `RECONCILED_CAPTURE_SUCCEEDED`); then W ×1 | 1 | 1 | 1 | 0 | 0 | 1 `guest.notify` pending; `CAPTURE_SUCCEEDED` 0, `CAPTURE_OUTCOME_UNKNOWN` 1, `RECONCILED_CAPTURE_SUCCEEDED` 1 |
| 3 | `payment_authorized` → **`confirmed`** | R ×2, C ×1; W with `afterComplete` hook fault (recording `succeeded` + LINKED, still `payment_captured`, 0 notify); R / C / K idle; W ×1 (recovery pass `RECORDED->confirmed`); W ×2 idle | 1 | 1 | 1 | 0 | 0 | `OFFLINE_CHARGE_RECORDED` exactly 1; 1 `guest.notify` pending |
| 4a | `payment_authorized` → `capture_unknown` → **`payment_captured`** | R ×2; C (mock APPLIED, reply 500) → `CAPTURE_OUTCOME_UNKNOWN:CAPTURE_CALL_FAILED`; R / W / K idle while unknown; C ×4 → `RECONCILED_CAPTURE_SUCCEEDED` | 1 | 1 | 0 | 0 | 0 | recording row QUEUED only (not run in this scenario); 0 notify |
| 4b | `payment_authorized` → `capture_unknown` → **`reconciliation_required`** | R ×2; C (positive-looking reply, NOTHING applied) → `CAPTURE_OUTCOME_UNKNOWN:CONFIRM_READ_NOT_CAPTURED`; C until intercepted → owner case `CAPTURE_STILL_AUTHORIZED_UNRESOLVED`; all four workers then idle | 1 | 1 | 0 | 0 | 0 | 1 capture row ever; no recording row; no void; 0 notify |
| 5 | `payment_authorized` → **`payment_captured`** (unknown recording) | R ×2, C ×1; W (mock APPLIED the charge, reply 503) → `UNKNOWN:REPLY_REPLY_HTTP_STATUS`; W ×3 → `STOP:RECORDING_OUTCOME_UNKNOWN`, 0 writes; R / C / K idle | 1 | 1 | 1 | 0 | 0 | open case `OFFLINE_CHARGE_OUTCOME_UNKNOWN`; mock holds 1 charge; `OFFLINE_CHARGE_RECORDED` 0; 0 notify |
| 6 | `payment_authorized` → `reservation_failed` (`PRICE_CHANGED`) → **`authorization_released`** | R ×1 (fresh recheck: price changed → `RESERVATION_STARTED->reservation_failed`, void QUEUED by E3); R / C / W idle; K ×1: fresh PI proof, void, confirming strict-canceled read, `VOID_SUCCEEDED->authorization_released`; all idle afterwards | 0 | 0 | 0 | 1 | 0 | 1 `guest.notify` (E3 template `not_charged_authorization_may_show`) **pending, never dispatched**; no create / capture / recording row; mock holds no reservation |

**Ledger (test 1, both methods, asserted exactly).** `created > price_confirmed > details_collected > payment_pending > payment_authorized > reservation_pending > reservation_pending > reservation_confirmed > payment_captured > confirmed`.
- Test 2 adds `capture_unknown` between `reservation_confirmed` and `payment_captured`.
- Test 6 is `… > payment_authorized > reservation_failed > authorization_released`.

**Persisted handoff facts asserted in test 1 (both methods).**
- **Reservation → capture.** `intents.hostaway_reservation_id` is the id the mock created. The mock reservation carries the exact listing, stay dates, booking ref, USD and total. E3 queued exactly one capture row (`pending`, undispatched) and no recording row.
- **Capture → recording.**
  - Capture row: `succeeded`, attempts 1, `result_ref` is the mock charge id, `payload.paymentIntentId` is the authorized PI, `payload.amountMinor` is the price total.
  - Intent: `payment.capturedMinor` is the total.
  - E3 queued exactly one recording row: `och:{intent}:1`, payload `{ amountMinor: total, reservationId: <created id> }`.
- **Recording → confirmed.**
  - Eligible assessment: `cfg.paymentMethod` is the fixture method, USD, the listing, the TRUST labels.
  - The claim audit binds that assessment.
  - The identity evidence re-proves the reservation the reservation worker created: id, ref, listing, dates, USD, total.
  - The recording row is `succeeded`, attempts 1, linked (`settled_evidence_id`) to confirming charge-list evidence. That evidence carries the reservation, listing, amount, USD, method, `executorAccountRef` and charge id.
  - `intents.offline_charge_id` equals the mock charge id. The mock charge carries the same reservation, listing, amount, method and marker title `maraVilla payment mvoch1-{intent}`.
- **DB view of writes.** Dispatched rows per write type: create 1, capture 1, record 1, void 0, cancel 0.
- **No duplicates.** Two further rounds of all four workers (recording made due by TEST SETUP) were all idle with zero provider calls. There was no second write of any kind, still exactly one `guest.notify` row and no open case.

**Cross-phase nonaction (asserted with zero provider calls, at every phase boundary).**
- Recording cannot run before capture: the recording worker is idle in `payment_authorized`, `reservation_confirmed`, the interrupted-capture state and `capture_unknown`.
- Capture cannot run in the recording phase: the capture worker is idle in `payment_captured` and `confirmed`.
- Compensation cannot void or cancel a captured or confirmed booking: the compensation worker is idle in `payment_captured`, `confirmed`, `capture_unknown` and `reconciliation_required`.
- The reservation worker is idle after `reservation_confirmed`.
- No provider call path or mock reservation id names a protected id (70636076 / 71045356 / 71072615 / 71081885). The disposable DB holds no intent or operation payload with a protected id.

## 3. What this proves offline, and what it cannot prove

**Proves (offline, injected mocks, this DB schema 0001–0014):**
- The accepted workers hand off through persisted E3 state and outbox rows alone. Each next worker picks up from what the previous one wrote, with no prebuilt end-state fixture.
- Identity, ref, listing, stay, amount, currency, PaymentIntent and method bindings survive every handoff and are re-proved by fresh reads.
- Each non-idempotent write is invoked at most once per booking on every rehearsed path, including two interrupted events and two ambiguous writes.
- The supported crash seams (`afterComplete` hooks) recover on persisted facts through the accepted planner or recovery pass. There is no resend.
- Phase scoping keeps every worker out of other phases.
- Both fixture `paymentMethod` values flow end to end.
- Notifications stay queued.

**Cannot prove:**
- Real provider behaviour. Every shape is DOC-DERIVED / LIVE-UNVERIFIED: Hostaway create, retrieve and lookup; the offline-charge list and create (`/v1/guestPayments/charges`); Stripe PaymentIntent v3 fields.
- Account identity: the labels are TRUST, not authentication.
- Real latency, timeouts, rate limits or concurrency between separately deployed workers.
- Owner decisions.
- Any notification delivery.
- Any deployment, scheduler or dispatch wiring.
- That the 20-min-past injected clock matches production timing. This is a test convenience: a real runner would use one real clock for all workers.
- `capture_failed` (void + host-cancel legs). This path is **not** rehearsed: the accepted capture worker never emits `CAPTURE_FAILED` (refusals become unknown). Reaching it needs a provider-side cancelled authorization or an expired deadline, which this slice did not request.

## 4. Integration gaps found

**No runtime integration gap.** All seven tests pass against the unchanged runtime, so no runtime / pure / migration / fixture edit was needed or made.

Test-side corrections while writing the file:
- my mock's charge-create path regex (the real request path is `/v1/guestPayments/charges/{reservationId}`);
- my ledger expectation (`reservation_pending` appears twice: STARTED, then DISPATCHED);
- my test-6 assumption: E3 *does* queue one `guest.notify` on `authorization_released`, never dispatched.

Observations for a future runner (not gaps, no action taken):
- **Two clock rules coexist.** The recording worker refuses a clock more than 2 s from the DB clock; the other three accept any trusted injected clock. A single real clock satisfies all four.
- **Interrupted capture events recover slowly.** Recovery (test 2) goes through `CAPTURE_OUTCOME_UNKNOWN` then a fresh read after ≥ 2 min grace, i.e. 4 bounded capture steps. It is not a direct `CAPTURE_SUCCEEDED`.
- **The conflict inbox fills and nothing empties it.** Every charge-list evidence row enqueues a 0011 conflict-inbox item: 2 per successful recording here. No worker drains it, so items accumulate unprocessed.

## 5. Remaining readiness inventory (grounded in the code at `e0191684`)

| Area | Current code | State |
|---|---|---|
| Provider shape / account / method verification | All Hostaway / Stripe shapes in `hostaway-reservations.js`, `capture-proof.js`, `compensation-proof.js`, `offline-charge-proof.js` are DOC-DERIVED. Workers take injected executors only, and nothing in the runtime injects real provider executors into them (no caller outside tests). The `acct-test-1` / client labels are TRUST. | **Not started (live-gated).** Needs owner-approved live/test-account evidence. |
| Owner `paymentMethod` choice | `APPROVED_PAYMENT_METHODS = ["credit_card", "other"]`, no default (`PAYMENT_METHOD_UNSET` refusal). | **Open owner decision.** Both values rehearsed as fixtures only. |
| Scoped inbox visibility / maintenance | `booking.recording_conflict_inbox` + `process_recording_conflict_inbox_one` (0011). Owner functions in `db/lib/admin.js` (resolve operation / intent / recording hold, release preflight hold, close case). No scoped caller, listing or owner view; inbox draining is out of every worker's scope. | **Not implemented** beyond DB primitives. |
| Notification stage | E3 queues `guest.notify` rows (`booking_confirmed`, `not_charged_authorization_may_show`, `not_completed_not_charged`). No notification worker / executor exists; the generic `dispatchOperation` refuses without an injected executor. | **Not implemented.** Rows only queue. |
| Dispatch / deployment / live approval | Workers are invoked only by tests. `test/packaging-closure.test.mjs` `OFFLINE_ONLY` proves no `api/` route reaches the worker modules. There is no runner, cron or scheduler. | **Not implemented; live gates closed.** |

## 6. Recommended single smallest next slice (NOT begun)

A **docs-only contract for a scoped conflict-inbox visibility + bounded processing step**. It would decide who calls `process_recording_conflict_inbox_one`, scoped how (listing / intent / protected exclusion before any LIMIT), how often and with what bounds, and what the owner sees. The reason: this rehearsal shows every successful recording leaves unprocessed inbox items, and post-confirmation contradiction detection depends on them. It needs no provider, credential, notification or deployment decision.

## 7. Validation (CLAUDE-RUN, disposable local PG 16; full TAP in `scratchpad/tap-lc/`)

| Suite | Result | TAP |
|---|---|---|
| Focused `test/db/e7-offline-lifecycle.test.mjs` (final file) | 7/7 | `focused.tap` |
| Worker + 0010–0014 + migration regressions: e72, e73b, all e74a-*, all e74b-* (D1 / D2 / worker), migrations, offline-charge, e7-recovery, e71a, rehearsal | 292/292 | `regress.tap` |
| `npm test` | 684/684 | `npm-test.tap` |
| `npm run test:db` | 416/416 (409 + the 7 new) | `test-db.tap` |

- The historical e74a listing-lock guard passed (`ok 173`). The failure is still open and unexplained; this run is not evidence that it is fixed.
- An earlier regression run, stopped to add the conflict-inbox assertion, had 83 passes and 0 failures; it is kept as `regress-STOPPED-partial.tap`.
- No mutant campaign was run (none was required).
- No installs.
- `git diff e0191684 -- db/migrations lib test/db/fixtures.mjs package.json api` is empty.
