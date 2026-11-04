# E7.4b recording worker — CONTRACT revision 2 (DOCS ONLY, PROPOSED) for an OFFLINE / INJECTED-MOCK implementation

**Branch.** `feature/e7-offline-charge-worker-contract`. Revision 1 = `c059287` (cut from exact `bc0f93c2000e1f5aa1a3b3954cc75594402ce244`); this revision 2 answers root's HOLD on `c059287` (R1–R4, W-1…W-8, precision items). Where they differ, revision 2 governs.

**Status.**
- **D5 / 0014 is PRESENT and accepted offline at `bc0f93c`**; the 0010–0014 database foundation is accepted OFFLINE. Not live or payment readiness.
- **The recording-worker DESIGN is ACCEPTED offline at `6f5f704`** (root ruling; R2-B `READ_ROWS_MAX = 6` approved; no evidence for refused confirming pages approved; addendum A–E). **The worker is IMPLEMENTED offline / injected-mock** on `feature/e7-offline-charge-worker` (pending root code review); the exact map is **§11**. Not live, provider or payment readiness.

**What this is.** The integration design that wires the ACCEPTED pure proof module (`lib/checkout/offline-charge-proof.js`) and the ACCEPTED 0010–0014 primitives into ONE bounded offline worker step with INJECTED mock reads / write, following the accepted capture / compensation workers. It does not redesign those foundations.

**Boundaries (unchanged).**
- No real Hostaway / Stripe client import, credential, environment access or reachable live entrypoint; executors are injected functions only.
- Provider shapes are DOC-DERIVED, LIVE-UNVERIFIED. Labels (`accountRef`, `clientSnapshotId`) are [TRUST]: they never authenticate a credential or an account.
- `paymentMethod` is explicit configuration with NO default; the owner's choice and every live gate stay closed. Packages are USD; MXN fixtures authorize nothing.
- Never: notification / refund / cancel / void, automatic resend, new key, attempt > 1, redispatch of an ambiguous write, admin release, `link_full_proof`, link maintenance, inbox draining, or mutation of protected reservations 70636076 / 71045356 / 71072615 / 71081885.
- The historical unexplained e74a guard failure stays open (if reproduced in a later authorized suite: keep the FIRST full TAP and stop; never rerun to green).

**Citation form.** `file:line` at `bc0f93c` (re-checked for this revision). `proof` = `lib/checkout/offline-charge-proof.js`; `ops` = `lib/booking-db/operations.js`; `cw` = `lib/booking-db/capture-worker.js`; `rw` = `lib/booking-db/reservation-worker.js`; `00nn` = `db/migrations/00nn_*.up.sql`.

---

## 0. Resolution map (root HOLD on `c059287`)

| Item | Root ruling | Where |
|---|---|---|
| R1 inbox drain scope | DEFER any worker drain entry point; the global helper stays separate offline owner maintenance, never called by the worker or its maintenance / recovery | §7.4, §2 |
| R2 transport read lifecycle | one reused same-selector read per type above an explicit floor; `next_attempt_at` / `max_attempts` obeyed; escalated read cited once as counted `READ_NOT_COMPLETED`; per-epoch row budget | §4 (new), §3 |
| R3 provider vs DB ambiguity | exception / stage matrix; an outer DB failure stops all mutation (incl. `releaseWork`) and re-throws the original error | §6.3 (new), §8 |
| R4 late reply | settle unknown once; late reply observed in memory only; no DB mutation / event | §6.2, §2 (`late`) |
| W-1 | one bounded `runRecordingStep`; drain API deferred | §2 |
| W-2 | additive pure `preflightListObservation`; identity positive evidence from the existing frozen `observed` + labels; refused identity → NO evidence | §1.5, §5.1 |
| W-3 | unique DB-stamped entry transition into `payment_captured` | §1.5 |
| W-4 | acknowledged post-claim pre-write abort → unknown + case | §6.1 |
| W-5 | 2 s skew refusal with a bounded round trip; DB checks stay authoritative | §2 |
| W-6 | fenced `ESCALATE` only for an explicit allowlist of permanent DB facts | §5.2 |
| W-7 | recovery applies only `OFFLINE_CHARGE_RECORDED` | §7.3 |
| W-8 | the queued `guest.notify` row: disposable test DB only, exactly once, never executed | §7.2, §9 |
| Precision | field-by-field recording identity; frozen per-step basis; narrowed "DB-enforced" wording | §3.1, §2, §1.5, §4.5 |

---

## 1. Source inventory at `bc0f93c`

### 1.1 E3 entry and final event

| Fact | Source |
|---|---|
| `CAPTURE_SUCCEEDED` / `RECONCILED_CAPTURE_SUCCEEDED` → `payment_captured` and queue ONE `hostaway.record_offline_charge` effect | `lib/checkout/intent-state.js:523–532`, `:546–551` |
| The effect becomes a `non_idempotent` row, key `och:<intent>:<offlineChargeAttempts+1>` (initial = `:1`), payload `{reservationId, amountMinor}` | `lib/booking-db/repo.js:104–106` |
| `payment_captured` accepts `OFFLINE_CHARGE_RECORDED`, `OFFLINE_CHARGE_FAILED`, `ESCALATE` | `intent-state.js:135` |
| `OFFLINE_CHARGE_RECORDED {chargeId}` → `confirmed` and queues ONE `guest.notify` effect (`booking_confirmed`), key `notify:<intent>:booking_confirmed`, inserted `ON CONFLICT (idempotency_key) DO NOTHING` | `intent-state.js:594–597`; `repo.js:107–108`, `repo.js:128` |
| Event dedupe by `(intent_id, event_id)`; a repeated id returns `duplicate` with no effect | 0001:228–234; `repo.js:346–356`, `repo.js:373`, `repo.js:406` |
| Guards: `OFFLINE_CHARGE_FAILED` needs the latest recording `failed_definite`; `OFFLINE_CHARGE_RECORDED` needs it `succeeded`, `result_ref = chargeId`, LINKED, no active hold | `repo.js:279–298` (authoritative trigger 0010:332–352, 0011:436–455) |
| Planner: succeeded → `OFFLINE_CHARGE_RECORDED`; failed_definite → `OFFLINE_CHARGE_FAILED`; else operator (never re-recorded) | `lib/checkout/recovery-plan.js:370–379`; finder scope `lib/booking-db/recovery.js:65–69` |
| `markUnknown`: `non_idempotent` → `outcome_unknown` + case `OFFLINE_CHARGE_OUTCOME_UNKNOWN`; `read` → `pending` with `next_attempt_at = now + 30 s` while `attempts < max_attempts`, else `escalated` + case `OPERATION_RETRIES_EXHAUSTED` (at most one OPEN case per intent and kind: `ON CONFLICT … DO NOTHING`) | `ops:402–419`, `ops:22–26`, `ops:29–34`; `lib/booking-db/config.js:11`, `:14` (`read: 10`) |
| `EXTERNAL_DISPATCH_ENABLED = false`; `dispatchOperation` throws `DISPATCH_DISABLED` without an injected executor | `ops:20`, `ops:506–514` |

### 1.2 Public DB helpers the worker uses (all existing; app role)

| Helper | DB function / lock order | Source |
|---|---|---|
| `requestRead(pool, intentId, type, reservationId, {now})` — ALWAYS inserts a NEW row (`read:<type>:<random uuid>`), `max_attempts = 10`, `created_at = next_attempt_at = now` (caller clock) | none | `ops:472–485` |
| `claimNextOperation(pool, {workerId, now, opId, opTypes, leaseMs})` — only `state = 'pending' AND next_attempt_at <= now`; increments `attempts`, stamps `dispatched_at` | intent SHARE → (recordings) work SHARE → op UPDATE (SKIP LOCKED); `RECORD_FENCE`; recording triggers: 0011 fence + 0012/0013 refusal, AFTER audit | `ops:78–88`, `ops:91–133` (UPDATE `ops:113–120`); 0012:529–564; 0013:104–135, 137–149 |
| `completeOperation(pool, opId, {workerId, now, outcome})` — refuses `succeeded` for ANY recording before its transaction (`RECORDING_SUCCESS_REQUIRES_EVIDENCE`); `succeeded` / `failed_definite` store `error_code = outcome.errorCode`; `outcome_unknown` → `markUnknown`; a lost lease records a first late result only for `outcome_unknown` / `escalated` rows | `ops:166–175`, `ops:353–383` (late `ops:358–367`, `error_code` `ops:369–371`) |
| `recordProviderEvidence(pool, {readOpId, kind, externalRef, status, observed})` — `observed_at := read.completed_at`; one evidence row per read; inbox enqueue | read op FOR UPDATE → INSERT (FK share intent) → advisory (charge lists) | `ops:492–503`; 0010:354–390; 0011:639–650 |
| `recordRecordingAssessment(pool, opId, {...})` | intent SHARE → work SHARE → op SHARE → reads SHARE → advisory, then `v_t` | `ops:250–263`; 0013:200–242, 243–333, 335–389 |
| `openRecordingPreflightHold(pool, opId, {by})` | DB-derived latch citation; visibility only | `ops:291–295`; 0013:447–491 |
| `openRecordingVisibilityHold(pool, opId, {reason: 'ATTEMPT_GT1' \| 'SUCCEEDED_UNPROVEN', by})` | intent SHARE → op UPDATE → advisory; idempotent | `ops:301–305`; 0011:586–637 |
| `completeRecordingWithEvidence(pool, opId, {workerId, evidenceId, resultRef, expectedVersion})` | intent SHARE → work SHARE → op UPDATE → advisory, then DB clock; version, both leases, latest, no hold, attempt 1, `worker_fresh` 2-min proof, no positive contradiction, D5 | `ops:188–192`; 0011:363–402; 0010:42–129; 0014:23–53, 69–153 |
| `applyEvent(pool, intentId, event, {inTx, ...})` | intent FOR NO KEY UPDATE; `guardEvent`; inTx fences | `repo.js`; pattern `cw:100–114` |
| `recoverExpiredOperations(pool, {..., intentStates})` | phase-guarded (intent SHARE first) | `ops:426–458` |
| SELECT (RLS `app_ro`): `recording_assessments`, `recording_claim_assessments`, `recording_holds`, `recording_hold_decisions`, `intent_transitions` | | 0012:582–594; 0011:825–830 |

**Not used by the worker:** `drainRecordingConflictInbox` (R1), `listRecordingContradictions`, `linkRecordingEvidence`, `recordReleaseReviewAssessment`, every admin function (`db/lib/admin.js`), `settleOperationFromEvidence`, `dispatchOperation`.

### 1.3 Pure functions (`proof`)

| Function | Use | Lines |
|---|---|---|
| `configRefusal(cfg)` — exact keys, USD, channel 2000, approved method, **no default** | gate | 122–136 |
| `intentRefusal(intent, cfg)` — 12 exact fact keys incl. `recordedPaymentAt` | every assessment | 139–156 |
| `recordingOpRefusal(op, intent)` — pending, `attempts 0`, `dispatchedAt null`, key `och:<intent>:1` | PRE-CLAIM only | 158–170 |
| `recordingIdentity(op)` (private) → `{opId, opType, idempotencyKey, payloadReservationId, payloadAmountMinor}`, carried in the eligibility | S9 mapping | 185–189 |
| `assessIdentitySnapshot` / `assessChargeList` — branded, fresh ≤ 2 min, labels; identity carries a frozen 9-field `observed` | preflight + confirm | 200–232, 244–288 |
| `qualifyPreflight` → branded eligibility (`sendAuthorization:false`), frozen context, recording identity, canonical request | PRE-CLAIM | 309–332 |
| `buildOfflineChargeRequest` — PRE-CLAIM: carried freshness, context + recording identity equality | PRE-CLAIM | 359–375 |
| `validateOfflineChargeRequest(request, {intent, config})` (WITHOUT `recordingOp` once claimed) | S9 | 377–382 |
| `assessCreateReply` → branded candidate, `sufficient:false` | post-write | 392–425 |
| `assessConfirmingRead` → 15-key `observed` (= the 0010:82–83 key set), `observedAt` | post-write | 430–473 |
| `freshnessRefusal`, `formatScheduledDate`, `classifyTitle` | helpers | 78–117 |

Persist-vs-local classification is fixed in `claude/e74b-preflight-assessment-contract.md` §4.1–4.4 and the frozen catalogue (0012:21–92); the worker adds no code.

### 1.4 Accepted worker patterns reused

Explicit `env` OBJECT gate (`cw:73–91`, `rw:126–147`); `assertEnvironment(pool, 'test')` (`cw:606`); `claimWork` / `releaseWork` (`rw:562–574`, `rw:171–176`); bounded executor calls with `AbortSignal` + `ProviderCallTimeout` (`rw:91–106`); protected ids (`rw:69–71`); claim → re-check → send with no await between decision and call start (`cw:394–440`); fenced E3 event `op-outcome:<opId>` (`cw:464–479`, `recovery-plan.js:47–51`); fenced escalation (`cw:124–131`). **Not reused:** the capture worker's late-success persistence (`cw:444–448`, `cw:496–501`) — impossible for recordings (R4).

### 1.5 Missing pieces (no migration) and what the DB does / does not enforce

- **W-2 (pure, additive).** `preflightListObservation({ list, intent, config })` in `proof`: requires `LISTS.has(list)`, `factsRefusal({intent, config})` null and `list.context` equal to `assessmentContext(intent, config)`; reuses the private `partition` (`proof:290–299`); returns a frozen `{ clientSnapshotId, complete: true, executorAccountRef, lookalikeCount, matchingChargeCount, matchingChargeIds (sorted canonical strings), readCount: 1, requestLimit: 500, rowCount: list.count, sameAmountPaidCount }` (the 0012:284–325 key set). No existing export changes. Positive identity evidence needs no helper: `{ ...identity.observed, executorAccountRef: identity.accountRef, clientSnapshotId: identity.clientSnapshotId }` (the 11 keys of 0012:222–240). A refused identity snapshot is NEVER turned into evidence (§5.1).
- **W-3 (worker query).** `recordedPaymentAt` = `intent_transitions.recorded_at` (DB-stamped, 0001:207–221) of the UNIQUE row with `to_state = 'payment_captured' AND from_state IS DISTINCT FROM 'payment_captured'`; zero or several → `RECORDED_PAYMENT_TIME_AMBIGUOUS` (W-6 allowlist). Explicitly NOT Stripe's capture instant [TRUST].
- **No new DB invariant is proposed.** The DB enforces the claim facts (0011 / 0012 / 0013) and the completion facts (0010 / 0011 / 0014). It does NOT attest local brands, the request body or `scheduledDate`, labels, provider authenticity, the classification of a response, or the honesty of worker-stamped times; those stay worker-enforced [TRUST] (§4.5).

---

## 2. Worker API, gate, executors, scope

**Planned files (implementation slice, after acceptance):** new `lib/booking-db/recording-worker.js`; additive W-2 helper in `lib/checkout/offline-charge-proof.js`; new `test/e74b-recording-worker.test.mjs` (unit, no DB) and `test/db/e74b-recording-worker.test.mjs` (disposable PG); minimal USD fixture helper in `test/db/fixtures.mjs`; status pointers. **No migration, no drain entry point.**

**API.**
```
recordingWorkerGate({ env, listings, executors, clock }) -> { ok:true, basis } | { ok:false, code }      // pure
runRecordingStep(pool, { workerId, env, listings, executors, clock, intentId?, timeouts?, monotonic?, hooks? })
  -> Object.freeze({ status: 'refused' | 'idle' | 'worked', code?, intentId?, actions: string[], calls: string[],
                     writes: 0 | 1, delayMs?, workReleased: boolean, late: Promise<LateObservation> })
  throws: the ORIGINAL error object of an outer DB failure (§6.3), never wrapped
LateObservation = Object.freeze({ kind: 'none' }) | Object.freeze({ kind: 'late_reply', settled: 'fulfilled' | 'rejected', httpStatus: integer | null })
```

**Gate (pure; nothing touched before it passes).**
- `env` is a caller OBJECT: `VERCEL_ENV ∈ {development, preview}`, `MV_E7_RECORDING_WORKER === 'enabled'`;
- `listings: Map<listingId, cfg>`; each `cfg` passes `configRefusal` with `paymentMethod` explicitly present, and `cfg.listingId === key`;
- `executors` has EXACTLY `retrieveReservation`, `listOfflineCharges`, `createOfflineCharge` (functions) and `label: { accountRef, clientSnapshotId }` (label regex); `label.accountRef` equals every `cfg.accountRef`;
- `clock()` finite; `workerId` matches `/^[A-Za-z0-9._:-]{1,80}$/` and SHOULD carry a per-process nonce (F-3).
- **Frozen basis.** On success the gate returns `basis`: a deep-frozen COPY of each `cfg`, the three executor function references and the two label strings. The step uses only `basis`; mutating the caller's objects (or an injected callback doing so) cannot change the request basis; S9 re-checks the intent's listing against `basis`.

**Then (DB):** `assertEnvironment(pool, 'test')` (`DATABASE_NOT_TEST`); **skew (W-5):** `t0 = clock()`, `SELECT clock_timestamp()` → `db`, `t1 = clock()`; refuse `CLOCK_SKEW_UNCERTAIN` if `t1 − t0 > 1 s`, and `CLOCK_SKEW` unless `t0 − 2 s ≤ db ≤ t1 + 2 s`. This only avoids doomed work; the DB's own no-future / freshness / floor checks remain authoritative.

**Dispatch-disabled.** A refused gate touches nothing beyond the environment check: no claim, read, assessment or send. The worker never calls `dispatchOperation`, never changes `EXTERNAL_DISPATCH_ENABLED`, imports no provider client.

**Executor contract (injected; DOC-DERIVED, LIVE-UNVERIFIED):**
- `retrieveReservation({ method:'GET', path:'/v1/reservations/<id>', query:{} }, { signal }) -> { httpStatus, json }`;
- `listOfflineCharges({ method:'GET', path:'/v1/guestPayments/charges', query:{ reservationId, limit: 500 } }, { signal }) -> { httpStatus, json }`;
- `createOfflineCharge(request, { signal }) -> { httpStatus, json }` (the frozen canonical POST from the eligibility).
The worker stamps the labels from `basis` and `observedAt` from its clock; an executor never supplies proof fields.

**Scope.** `claimWork(states = ['payment_captured'], listingIds = keys(basis), intentId?)`; maintenance / recovery in SQL before any LIMIT to the same listings, `payment_captured`, and op types `{record_offline_charge, retrieve_reservation, list_offline_charges}`. Protected reservation id → W-6 escalation before any read.

**Limits.** `readCallMs 10 s`, `writeCallMs 20 s`, `stepBudgetMs 60 s`, `workLeaseMs 120 s`, recording `opLeaseMs 90 s`, `sendMarginMs 15 s`, `waitMs 30 s`; `SNAPSHOT_MAX_AGE_MS = 2 min` (proof:36 = the 0013 claim refusal = 0010 `worker_fresh`). Per step: ≤ 1 intent, ≤ 1 identity read execution, ≤ 1 list read execution, ≤ 1 write, ≤ 1 confirming read.

---

## 3. State / step table (one `runRecordingStep`)

No DB transaction or row lock is held across a provider call; every DB step is its own helper transaction. "Stop" = no further mutation in this step except `releaseWork` on ordinary paths (§6.3).

| # | Step | DB / locks | Check | Persisted | Refusal → result |
|---|---|---|---|---|---|
| S0 | gate, env, skew | none / one SELECT | §2 | — | `refused:<code>` |
| S1 | scoped maintenance + recovery | `recoverExpiredOperations` (intent SHARE → ops); recovery: only `OFFLINE_CHARGE_RECORDED` (§7.3) | planner | unknown + case for expired leases | — |
| S2 | `claimWork` | intent_work UPDATE (SKIP LOCKED) | — | work lease | none due → `idle` |
| S3 | load + classify | SELECTs | §5 routing; W-3; floor `F` (§4.1) | — | §5 |
| S4 | identity read | §4 selection → claim that row → **call** → `completeOperation(read, …, now = T₁)` → evidence only if positive | `assessIdentitySnapshot` | read row; positive evidence | transport → uncounted (§4.2) |
| S5 | list read | §4 selection (list-first rule §4.3) → claim → **call** → complete at `T₂` → count-only evidence (W-2) only for a complete page | `assessChargeList` | read row; evidence | transport → uncounted |
| S6 | classify + persist | `recordRecordingAssessment` | `qualifyPreflight` on fresh facts + pending op | ONE assessment (`A`) | local → stop; DB refusals → §5 |
| S7 | build PRE-CLAIM | none | `buildOfflineChargeRequest` | — | stop (assessment kept) |
| S8 | claim | `claimNextOperation({opId, opTypes:[record], leaseMs: opLeaseMs})` | DB fence + audit | `in_flight`, `attempts 1`, `dispatched_at` (**claimed, not invoked**), audit | `null` → `WAIT` |
| S9 | binding + final re-check | SELECTs, then clock | §3.1 | — | §6.1 abort |
| S10 | **write** (≤ 1) | none | — | `writes = 1` set before awaiting | — |
| S11 | reply | none | `assessCreateReply` | — | §6.2 |
| S12 | confirming read | NEW row (`requestRead` after the claim) → claim → **call** → complete at `T₃` → full 15-key evidence only if `assessConfirmingRead` ok | `assessChargeList` + `assessConfirmingRead({candidate, eligibility, list, intent, config, dispatchedAt, now: T₃})` | read row; proof evidence | §6.2 |
| S13 | complete | `completeRecordingWithEvidence(op, workerId, evidenceId, chargeId, version)` | DB checks + D5 | `succeeded` + link | §6.2 / §6.3 |
| S14 | finalise | `applyEvent(OFFLINE_CHARGE_RECORDED {chargeId}, id = op-outcome:<opId>)`, inTx: work lease, op `succeeded` + same `result_ref` + linked, no hold | `guardEvent` + trigger | `confirmed`, ledger, ONE queued `guest.notify` row (never executed) | known refusal → action; outer failure → §6.3 |

### 3.1 S9 final checks (fresh rows; clock read AFTER the reads; no hook and no await between the decision and the executor call)
1. **Recording identity, field by field** (`eligibility.recording`, `proof:185–189`): `opId === op.id`; `opType === op.op_type`; `idempotencyKey === op.idempotency_key` (= `och:<intent>:1`); `payloadReservationId === op.payload.reservationId`; `payloadAmountMinor === op.payload.amountMinor`; and `op.payload` has exactly the keys `amountMinor`, `reservationId`. Plus: `state 'in_flight'`, `lease_worker_id = workerId`, `attempts = 1`, `dispatched_at` not null, `lease_until − now > writeCallMs + readCallMs + sendMarginMs`, latest recording, no active hold.
2. **Claim audit:** `assessment_id = A`, `worker = workerId`, `epoch` = count of released preflight holds (SELECT; mirrors 0013:59–64).
3. **Assessment `A`:** `preflight`, `eligible`, `worker = workerId`, `cfg` deep-equal to the `basis` cfg, `account_ref = basis.label.accountRef`, `client_label = eligibility.clientSnapshotId`, `intent_version = eligibility.context.version`, `module_version = OFFLINE_CHARGE_PROOF_VERSION`, cited reads / evidence = those of this step.
4. **Intent:** `payment_captured`; every `eligibility.context` field equal (`proof:179–184`) incl. version and the W-3 time; `offline_charge_attempts = 0`; listing ∈ `basis`; not protected.
5. **Work lease:** `workerId`, room > `writeCallMs + readCallMs + sendMarginMs`.
6. **Carried freshness:** `freshnessRefusal(identityObservedAt | listObservedAt, now)` null.
7. **Request:** `validateOfflineChargeRequest(request, {intent, config})` ok and `request === eligibility.request`.
8. **Budget:** step budget > `writeCallMs`.

**Residual race (candid).** After check 8 the provider may change, another actor may write to Hostaway, and the call may land after a lease expires. This is no provider atomicity: it guarantees only that no write starts on a stale or mismatched local basis; everything after the call start is treated as possibly applied.

---

## 4. Read lifecycle across steps (R2)

### 4.1 Floor and candidacy
Per read type `t ∈ {hostaway.retrieve_reservation, hostaway.list_offline_charges}`, `F = max(recording.created_at, recorded_at of the current version's transition, recorded_at of the release decision that opened the current epoch (epoch > 0))`. A row is a **candidate** only if: same intent, `op_type = t`, `retry_class 'read'`, `payload = {"reservationId": <hostaway id>}` exactly, `created_at > F`, and cited by no assessment (either column). Rows at or below `F` are never reused or cited; they remain as diagnostics.

DB checks mirrored (authoritative): read binding, terminal state, once-only and caller-time floors (0013:261–278; UNIQUE 0012:123–124); freshness ≤ 2 min at the DB decision — evidence `observed_at`, or for an evidence-less read its terminal time (`completed_at`, or `updated_at` when escalated) (0013:304–317); evidence floors after the version transition / recording / release (0013:319–328). The worker's version floor for evidence-less reads is STRICTER than the DB (which checks only the recording / release floors for them).

### 4.2 Selection algorithm (per type, per step; at most ONE execution)
1. **Escalated candidate** with `updated_at ≥ now − 2 min` and no evidence → **cite it** as `READ_NOT_COMPLETED` (identity: `identity_refused` alone; list: `incomplete` with a fresh positive identity of this step). Counted. Older than 2 min → never citable (stale); ignored.
2. Else **exactly one open candidate** (`pending` or `in_flight`): `pending` and `next_attempt_at ≤ now` → `claimNextOperation({opId})` and execute it; `pending` but not due → `WAIT(next_attempt_at − now)`; `in_flight` → `WAIT` (S1 maintenance marks an expired one). **No new row while an open candidate exists.**
3. Else (no open candidate) → `requestRead` ONE new row, then claim and execute it.
4. **Budget (R2-B):** rows created per `(intent, t, epoch, version)` ≤ `READ_ROWS_MAX = 6` (3 counted rows + slack). At the cap → `PREFLIGHT_READ_BUDGET_EXHAUSTED` (§5.2), no read.
More than one open candidate (another writer or a defect) → local stop `READ_ROWS_AMBIGUOUS`; never a guess.

**Outcome of one execution.**
- **Transport failure** (timeout, throw, abort, missing `{httpStatus, json}`): `completeOperation(read, outcome_unknown, errorCode 'READ_TRANSPORT_<TIMEOUT|THROW|SHAPE>')` → `markUnknown` → `pending` (+30 s), or at `attempts = 10` → `escalated` + an open `OPERATION_RETRIES_EXHAUSTED` case (`ops:409–414`). **Uncounted** until escalated; then counted once via rule 1, in the same step whenever possible.
- **A response** (any HTTP status, any body): `completeOperation(read, succeeded, errorCode = <pure refusal code or null>)` — the honest raw diagnostic is the bounded code on the row (`ops:369–371`); evidence only per §5.1. A non-2xx is a response, never transport: `IDENTITY_HTTP_STATUS` / `LIST_HTTP_STATUS` are counted (`identity_absent_or_not_found` / `list_absent_response`).
- No path re-executes a `succeeded` or `escalated` read or reuses an assessed read. Every new `eligible` decision — the only path to a write — needs two reads that responded **in this step**; no prior-epoch or stale evidence is ever reused.

### 4.3 Identity vs list exhaustion
- `identity_refused READ_NOT_COMPLETED` (`identity_absent_escalated`): an escalated identity read, NO evidence, NO list read (input shape 0013:221–227; state 0013:267–270; evidence absence 0013:296–299).
- `incomplete READ_NOT_COMPLETED` (`list_absent_escalated`): a positive identity read + evidence fresh at the DB decision AND the escalated list read with no evidence, all above the floors (0013:221–227, 0013:282–286, 0013:292–295).
- **List-first rule:** when the list candidate is open with `attempts ≥ 1` (it failed before), the step executes the LIST row first and executes a new identity read only after the list responded or escalated, so identity rows are not consumed by list transport failures. Otherwise identity first.

### 4.4 Deterministic example (repeated identity timeouts; read backoff 30 s)
Identity executor always times out; recording pending, epoch 0, version v.
- Step 1: no candidate → new row I₁ → attempt 1 → timeout → `pending`, due +30 s. `WAIT 30 s`.
- Steps 2–9: I₁ reused (attempts 2…9); no new row.
- Step 10: I₁ attempt 10 → timeout → `escalated` + `OPERATION_RETRIES_EXHAUSTED` case (durable visibility from here) → rule 1 in the same step → `identity_refused READ_NOT_COMPLETED` citing I₁ (count 1).
- Steps 11–20: I₂ likewise → count 2. Steps 21–30: I₃ → count 3 → latch `EXHAUSTED` → `openRecordingPreflightHold` (`PREFLIGHT_EXHAUSTED`, citing rank 3; 0013:69–90).
- **Bounds:** exactly 3 read rows, 30 executions, ≥ 27 × 30 s ≈ 13.5 min wall time, 0 writes, an open retries-exhausted case from step 10, a preflight hold at step 30. A list-only failure is symmetric (3 list rows; identity rows only after a list response / escalation).
- A crash between escalation and citation leaves that escalated row uncitable after 2 min; the next row starts; `READ_ROWS_MAX` bounds repetitions, and each escalation already left the retries-exhausted case.

### 4.5 What the DB does NOT attest here
That a transport failure was real, that a response was really received, its classification, and the worker-stamped `created_at` / `completed_at` / `updated_at` (caller clock; W-5 limits skew).

---

## 5. Outcome mapping and visibility

### 5.1 Evidence rules
- Positive identity → `found_active` evidence (11 keys). **Refused identity → NO evidence** (every `identity_refused` rule permits absence: 0012:244–282; `identity_absent*`); the code goes on the read row only. Nothing is copied from the intent into evidence to make a refusal look positive.
- Complete preflight page → count-only evidence from W-2 (eligible and conflicts; counts re-derived by 0012:284–325). Incomplete page → NO evidence (`list_absent_*` forbids it, 0013:292–295).
- Confirming read → full 15-key evidence ONLY when `assessConfirmingRead` succeeded; otherwise NO evidence, code on the read row.

### 5.2 Routing (S3 / S6)

| Situation | Worker action |
|---|---|
| Config / label / binding / shape / clock problem, or a pure-module input refusal (preflight contract §4.1 "worker-local") | local stop; nothing persisted or escalated |
| **Permanent DB fact refusal** — explicit allowlist, applied only after scope / version / work-lease checks: `CAPTURED_NOT_EXACT_TOTAL`, `AMOUNT_NOT_EXACT`, `CURRENCY_MISMATCH`, `STAY_INVALID`, `REF_INVALID`, `RESERVATION_ID_INVALID`, `PROTECTED_RESERVATION_ID`, `RECORDED_PAYMENT_TIME_AMBIGUOUS`, `RECORDING_PAYLOAD_SHAPE`, `PAYLOAD_RESERVATION_MISMATCH`, `PAYLOAD_AMOUNT_MISMATCH`; and (root choice R2-B) `PREFLIGHT_READ_BUDGET_EXHAUSTED` | fenced `ESCALATE` `RECORDING_<CODE>`, bound to the planned version / state / scope / work lease (`cw:124–131` pattern); any other code → local stop |
| Persistable `incomplete` / `identity_refused` | persist (counted); the 3rd in the epoch → latch → `openRecordingPreflightHold` |
| `conflict_*` | persist → latch → `openRecordingPreflightHold` |
| Writer refuses `ASSESSMENT_EPOCH_CONFLICTED` / `_EXHAUSTED` | `openRecordingPreflightHold` (idempotent), stop |
| Active hold / `ASSESSMENT_HOLD_ACTIVE` | stop |
| Latest recording = pending attempt > 1 | `openRecordingVisibilityHold('ATTEMPT_GT1')`, stop |
| Latest `succeeded`, unlinked | `openRecordingVisibilityHold('SUCCEEDED_UNPROVEN')`, stop |
| Latest `succeeded`, linked, no hold | S14 only |
| `in_flight` (any lease) | `WAIT`; never resumed by a new step |
| `outcome_unknown` / `escalated` / `failed_definite` | stop; existing case; never `OFFLINE_CHARGE_FAILED` |

Never in the worker: release review, owner release, `admin_resolve_*`, `link_full_proof`, link maintenance, inbox draining.

---

## 6. Claimed, invoked, and ambiguous

`claimNextOperation` stamps `dispatched_at` / `attempts = 1` at the claim (`ops:113–120`): from S8 the row is "possibly sent" for every other actor, though only S10 invokes the writer.

### 6.1 Acknowledged abort after the claim, before invoking (S9) — W-4
ONE `completeOperation(outcome_unknown, 'SEND_ABORTED_<REASON>')` → unknown + `OFFLINE_CHARGE_OUTCOME_UNKNOWN` case. The code is the worker's in-process assertion that the writer was not invoked [TRUST]; a claim proves nothing about invocation. Never `pending` / `failed_definite` / a new attempt / a retry. Recovery: owner resolution only.

### 6.2 Provider uncertainty after invoking (S10–S12) and late replies — R4
- Timeout / throw / malformed / non-2xx / refused candidate / refused or failed confirming read → ONE `completeOperation(outcome_unknown, '<STEP>_<CODE>')`. HTTP status alone never yields `failed_definite`.
- **Late reply (R4).** `completeOperation(succeeded)` refuses every recording (`ops:166–175`), and a reply is not API proof, so no late result is persisted. After a timeout the worker attaches `.then/.catch` handlers to the executor's raw promise (no unhandled rejection) and exposes `result.late`, resolving to a frozen `{kind:'late_reply', settled, httpStatus}` (bounded; no body) or `{kind:'none'}`. **No DB mutation and no event** ever come from the late path; the recording stays `outcome_unknown`.

### 6.3 Exception / stage matrix — R3

| Stage | Provider timeout / throw / unusable reply | Acknowledged known DB refusal (`{ok:false, error}`) | Outer DB failure (thrown: connection loss, `40P01`, unknown SQLSTATE, COMMIT ambiguity) |
|---|---|---|---|
| S1 maintenance / recovery | — | action only | stop; re-throw original |
| S2 `claimWork` | — | `idle` | stop; re-throw; no release |
| S4/S5 read claim / complete / evidence | ONE `completeOperation(read, outcome_unknown, READ_TRANSPORT_*)` | stop (`WAIT`) | stop; re-throw (claim / complete / evidence may or may not have committed) |
| S6 assessment | — | §5.2 | stop; re-throw (the row may exist; it is never used later: S9-2 binds the `A` of the same step) |
| S8 claim | — | `WAIT` | stop; re-throw (if committed: `in_flight` → lease expiry → unknown + case; writer not invoked) |
| S9 checks (SELECTs) | — | ONE §6.1 unknown settlement | stop; re-throw (`in_flight` → lease expiry) |
| S10–S12 | ONE unknown settlement | a read refusal → ONE unknown settlement | stop; re-throw (→ lease expiry → unknown) |
| S13 complete | — | ONE unknown settlement only if the refusal is not `RECORDING_LEASE_LOST` / `RECORDING_WORK_LEASE_LOST` / `RECORDING_STATE` (the row must still be ours and `in_flight`); else none (maintenance) | stop; re-throw. Success + link MAY have committed: never settle unknown, never call again |
| S14 event | — | action; success stays success; recovery applies the event later | stop; re-throw. `confirmed` + outbox MAY have committed: never re-apply in this step (event-id + outbox-key dedupe protect the next step) |
| unknown settlement itself | — | `LEASE_LOST` → action only | stop; re-throw THAT error unchanged (lease expiry settles later) |

**Rules.**
- At most ONE unknown settlement per op per step.
- After any outer DB failure the step performs **no further DB call — including `releaseWork`**; the work lease expires on its own (120 s). `releaseWork` runs in `finally` only when no outer DB failure occurred (`workReleased` reports it). Releasing could never cause a write anyway (a claimed row is never pending again), but no blanket `finally` mutation follows an ambiguous DB error.
- The original error object is re-thrown (same identity, code, message), never wrapped or masked by a later error.
- A completed (S13 ok) recording is never reclassified because S14 or a hook failed.
- Recovery from ambiguity is read-only inspection at the next step: `succeeded` + linked → S14 (deduped); `in_flight` → `WAIT` → lease expiry → unknown + case; `pending` → a new preflight. No path reaches the writer twice for one op.

**Hooks** (test fault boundaries; each sits before or after a whole DB / provider step): `afterRead`, `afterEvidence`, `afterAssessment`, `afterClaim`, `beforeFinalCheck` (before S9's SELECTs), `afterWrite`, `afterConfirmEvidence`, `afterComplete`, `beforeEvent`. **No hook exists between the S9 decision and the executor call.**

---

## 7. Success, finalisation, recovery, later evidence

### 7.1 Success requires
A candidate reply (necessary, not sufficient) AND a confirming read created / claimed after the recording claim (0010:72–74), observed strictly after `dispatched_at` and ≤ 2 min before the DB decision (0010:75–77), a complete single page, the same client label as the eligibility, exactly ONE exact-title match equal to the candidate on every returned field, persisted as the 15-key proof, then `completeRecordingWithEvidence` passing D5, version, both leases, latest, no hold and no positive contradiction.

### 7.2 Order and idempotent recovery
Complete first (S13), then the E3 event (S14). Interrupted between them → the op is `succeeded` + linked; the next step (or the S1 recovery pass) applies `OFFLINE_CHARGE_RECORDED` with the same event id; a duplicate is a no-op, and the `guest.notify` row key `notify:<intent>:booking_confirmed` is inserted at most once (`repo.js:128`). **W-8:** that queued row is accepted in the DISPOSABLE TEST DB only, exactly once, never executed; this authorizes no live notification and no notification stage.

### 7.3 Recovery pass (W-7)
Only `kind: 'event'` plans of type `OFFLINE_CHARGE_RECORDED`, fenced as S14 and scoped as S1. Never `OFFLINE_CHARGE_FAILED`; never operator escalation.

### 7.4 Later contradictory evidence (R1)
**Deferred.** The existing `drainRecordingConflictInbox` (`ops:324–351`) calls the GLOBAL `process_recording_conflict_inbox_one` and cannot enforce listing / intent / protected-id scope before selection or locks; the worker therefore never calls it (not in the step, maintenance or recovery) and offers no drain API. Global inbox draining stays a separately authorized offline owner-maintenance facility, not represented as scoped.
**Consequence:** evidence the worker writes is enqueued (0011:639–650) and reaches owner visibility only when that facility runs; no drain schedule or latency is promised. Finalisation is NOT weakened: completion, link and the E3 trigger still evaluate the synchronous positive-contradiction predicate at their own decision (0010:131–164 via 0011:341–353; 0011:436–455).

---

## 8. Deterministic fault / recovery table

| # | Fault | Re-readable | Write outcome unknown? | Result |
|---|---|---|---|---|
| F-1 | work lease reassigned / expired | lease rows | pre-write no / post-write yes | assessment / claim refuse; S9 → §6.1; S13 `RECORDING_WORK_LEASE_LOST` → maintenance |
| F-2 | op lease expires after the write | op | yes | S13 `RECORDING_LEASE_LOST`; maintenance → unknown + case |
| F-3 | two processes, SAME `workerId` | assessments, audit | — | the audit binds the latest; S9-2 (`assessment_id = A`) aborts the other → §6.1 |
| F-4 | competing workers | work lease | — | `claimWork` SKIP LOCKED; fence: assessor = claimant = lease holder |
| F-5 | direct `UPDATE` vs helper → `40P01` | everything | no | §6.3 outer failure; the victim committed nothing; the next step re-derives |
| F-6 | assessment committed, crash | assessment | no | next step: new reads + new `A`; the old row is never used (claim `STALE` after 2 min; S9-2) |
| F-7 | claim committed, crash before the write | op, audit | owner-only | lease expiry → unknown + case |
| F-8 | reply obtained, crash | op | yes | lease expiry → unknown + case; no resend; the late path is in memory only |
| F-9 | completion committed, event not | op | no | S14 / recovery once (deduped) |
| F-10 | connection loss around COMMIT of claim / assessment / evidence / completion / event | rows | per stage | §6.3: stop, re-throw, no mutation; the next step classifies either commit outcome |
| F-11 | migration / schema change mid-run (0014 down refuses while a claim is unlinked) | schema version | — | helper errors are outer failures (§6.3) |
| F-12 | hold opener fails | holds | no | known refusal → action; the claim fence still blocks; the next step re-calls the idempotent opener |
| F-13 | read transport failures repeat | read rows | no | §4.4 bounded path to a counted refusal and visibility |
| F-14 | capture / cleanup workers on the same intent | intent state | — | disjoint states; fenced S14 / maintenance; intent-first lock order |

Lock orders (unchanged): intent → work → op → reads → advisory (assessment); intent → work → op (claim); intent → work → op → advisory (completion); read op → intent (FK) → advisory (evidence). **No exactly-once claim:** at most one writer invocation per op; its outcome may stay unknown.

---

## 9. Planned tests (future implementation slice)

**Unit (no DB; mock executors; USD; LIVE-UNVERIFIED shapes):** gate matrix (env, flag, production, exact executor keys, label vs cfg, missing / unapproved method, non-USD, clock, frozen basis vs later caller mutation); W-2 helper (brand, context equality, canonical sorted ids, frozen output); reply / confirm classifiers; late observation (no unhandled rejection; bounded fields).

**Disposable PG (0001–0014; injected mocks; call and query counting):**
1. happy path → `confirmed`: exactly 1 write, 2 preflight reads, 1 confirming read; exactly ONE queued `guest.notify` row, never executed;
2. no action: wrong listing, protected id, attempt > 1 (ATTEMPT_GT1), active hold, succeeded-unproven, gate refusals;
3. conflicts → hold, 0 writes; counted refusals → EXHAUSTED hold;
4. **§4.4 as a test:** 30 identity timeouts → exactly 3 rows, 30 executions, counted `READ_NOT_COMPLETED` ×3, the retries-exhausted case, preflight hold; the list-first symmetric case; a stale escalated row is not cited; the row budget → W-6 escalation; no unbounded row creation;
5. epoch 2: the claim binds the epoch-2 assessment; the floor excludes pre-release rows;
6. D5 mismatch → unknown, 1 write;
7. every §6.1 / §6.2 branch → unknown once, ≤ 1 write, none in 3 further steps; late reply → no DB change;
8. **§6.3 matrix:** injected outer failures (closed connection / thrown error) at claim, assessment, evidence, completion, event and the unknown settlement, each with BOTH commit outcomes simulated: the original error identity / code / message re-thrown, no further query (no `releaseWork`), no resend, no duplicate outbox, completion success never reclassified;
9. F-1…F-14 via hooks; same-`workerId` race; `40P01`;
10. no notify / refund / cancel / void executor reachable; all 0010–0014 suites, `npm test`, `test:db`; targeted mutants on S9, the §4 selection, the write-count guard and the §6.3 stop rule.

---

## 10. Smallest implementation slice and remaining decisions

**Slice:** `recording-worker.js` + the W-2 helper + two test files + a USD fixture helper + status docs. No migration, adapter, route, drain API or notification stage.

**Root choices recorded:** W-1…W-8 as in §0.

**Open for root (small):**
- **R2-B** row budget: `READ_ROWS_MAX = 6` per `(intent, type, epoch, version)` with `PREFLIGHT_READ_BUDGET_EXHAUSTED` on the W-6 allowlist (recommended), versus a local stop without escalation (then invisible until an owner check).
- Count-only diagnostic evidence for a REFUSED but complete confirming page is deliberately NOT written in v1 (code on the read row only); it can be proposed later if owners need it.

**Remaining real blockers (outside this offline slice):** owner `paymentMethod`; live provider shapes, credentials and gates; a scoped inbox-drain design; a notification stage; the historical e74a guard failure.

---

## 11. Implementation map (offline / injected mock; `feature/e7-offline-charge-worker` from exact `6f5f704`) — pending root code review

**Files.**
- new `lib/booking-db/recording-worker.js` (internal library; no route / cron / entrypoint / provider client / env read);
- `lib/checkout/offline-charge-proof.js`: ONE additive export `preflightListObservation` (`:307`); no existing export changed;
- new `test/e74b-recording-worker.test.mjs` (unit, no DB, 7 tests) and `test/db/e74b-recording-worker.test.mjs` (disposable PG, 21 tests);
- `test/db/fixtures.mjs`: optional `stay.currency` (default `MXN`, unchanged) threaded through `priceFor` / auth / reservation / capture, and an optional test-only `stay.reservationId`;
- **deviation for root:** `test/packaging-closure.test.mjs` — one token: `"recording-worker"` added to the pinned `lib/booking-db` file list (necessarily changed by the authorized new file; same pin the E7.4a slice extended at `8c9dfe0`; its route-reachability checks are unchanged and pass);
- this §11 and the D5 status pointer. Migrations 0001–0014 byte-identical; no migration, config, dependency, route, UI, adapter, entrypoint or drain API.

**Mapping (contract rev 2 → code).**

| Item | Code |
|---|---|
| Gate, frozen basis (C) | `recordingWorkerGate` `:67` — plain deep-frozen objects only (no `Map`), copied cfgs / executor refs / labels; `paymentMethod` explicit, USD; step uses only `basis` |
| W-5 skew | `runRecordingStep` `:598` (round trip ≤ 1 s, skew ≤ 2 s) |
| Scope + protected (A) | `SCOPE_SQL` `:173` excludes protected ids BEFORE `LIMIT` in `maintenance` `:177`, `recoveryPass` `:189`, `claimWork` `:200`; accepted helpers then run per selected allowed intent; explicit protected `intentId` refused after a read-only lookup, before maintenance; `PROTECTED_RESERVATION_ID` is NOT in `ESCALATE_ALLOWLIST` `:39` |
| W-3 | `recordedPaymentAt` `:110` (unique DB-stamped entry transition) |
| R2 floor / selection / budget (B) | `floorSql` `:242` (full DB precision, compared IN SQL), `readRows` `:249`, `selectRead` `:263` (fresh escalated cited once; exactly one open candidate reused; `next_attempt_at` obeyed; > 1 open → `READ_ROWS_AMBIGUOUS`; ≥ 6 rows → budget; caller clock not past F → `TIMING_FLOOR` WAIT, never a manufactured time) |
| Read phase + evidence (§5.1) | `readPhase` `:290` (transport → `READ_TRANSPORT_*` uncounted until escalated; response → bounded pure code on the read row; evidence only for a positive identity / complete page) |
| List-first | `listFirst` `:327` — **deviation:** also list-first when the latest list row is escalated AND already cited (rev 2 §4.3 said "open with attempts ≥ 1"); this keeps identity reads from being burnt between list-exhaustion cycles (test: 4 identity reads, not 6) |
| S6 / latch / W-6 | `preflightAndSend` `:539`, `escalate` `:150` (allowlist only; fenced on planned version, scope, work lease) |
| S7–S9 | PRE-CLAIM `buildOfflineChargeRequest`; claim; `finalCheck` `:384` (field-by-field recording identity, audit `assessment_id = A`, assessment binding, intent facts, leases, carried freshness, request, budget) |
| S10–S13 | `sendAndConfirm` `:434` — no await between the decision and the executor call; ≤ 1 `createOfflineCharge` per op; reply never sufficient; ONE new confirming read; no evidence for a refused page (code on the row) |
| Late reply (R4 / D) | `observeLate` `:485` — finite `lateWindowMs` (default 30 s; not `unref()`ed so it resolves even in an idle process), handlers attached, bounded `{kind, settled, httpStatus}`, no DB call / event |
| §6.3 (E) | no `try/finally`: any thrown error (outer DB failure, hook fault) propagates unchanged with no further query, not even `releaseWork`; `settleUnknown` `:374` at most once per op; known refusals are data; completion success never reclassified |
| S14 / W-7 / W-8 | `finalise` `:158` (fenced; event id `op-outcome:<opId>`; recovery applies only `OFFLINE_CHARGE_RECORDED`); the queued `guest.notify` row is created once, never executed |

**Tests (CLAUDE-RUN, disposable local PostgreSQL 16; full TAP in `scratchpad/tap-rw/`).** Focused worker 28/28 (unit 7 + DB 21); worker + 0010–0014 + migrations + offline-charge suites 152/152; `npm test` 681/681; `test:db` 408/408 (387 + 21). The historical e74a guard did not fail in these runs (still unexplained, open).
Covered: both fixture methods; gate refusals with zero queries; protected zero-action (explicit refusal + unscoped step skipping a protected expired op and a protected linked missed outcome while serving an allowed intent); out of scope, ATTEMPT_GT1, SUCCEEDED_UNPROVEN, active hold, outcome_unknown; three conflict kinds; 3 counted HTTP refusals; 30 identity timeouts (3 rows, 30 executions, retries-exhausted case, hold); list-first (3 list rows, 4 identity reads, hold); budget escalation; escalated-row citation, stale escalated not cited, two open candidates; epoch 2 incl. a pre-release open row never reused; D5 refusal at completion; S9 aborts (op lease, work lease, hold, budget, same-worker newer assessment, identity changed, op not held, assessment binding, stale preflight, intent changed); post-write branches (timeout, throw, non-2xx, zero, multiple, id mismatch, future, backwards clock); late observation (never settles / fulfilled / rejected); lease loss; competing workers; crash after completion and after claim; the §6.3 matrix (claim / assessment / evidence / completion / event / settlement × rolled back / committed-reply-lost) with error identity, no further statement, persisted rows and ≤ 1 write / ≤ 1 outbox row.
Not stageable: `NOT_LATEST` at S9 (the 0001 `external_operations_one_open_offline_charge` index forbids a second open recording); `REQUEST_INVALID` (the request is frozen from the eligibility); a confirming read that is after dispatch yet older than 2 min (its observation time is the read's own completion).

**Mutants (reported separately).**
- Campaign 1 (31 targeted, both worker test files): 22 killed, 9 survived.
- Strengthening: escalated-row citation / stale / two-open test, a pre-release open row in the epoch-2 test, and a unit test of the `escalate` allowlist policy.
- Campaign 2 (the 9 survivors): R02 (escalated never cited), R03 (freshness filter), R06 (floor), R09 (multiple open) and P03 (allowlist bypass) KILLED; 4 survive, all redundant under enforced invariants: S02 (audit worker — the 0012/0013 audit guard forces audit worker = claimant = lease holder), S09 (`lf.code` — the field-by-field facts comparison catches the same change), S13 (one-settlement guard — a single call path), R07 (not-due row — the claim helper itself requires `next_attempt_at <= now`). They are kept.

**Residual limits.** Labels TRUST; mock shapes DOC-DERIVED / LIVE-UNVERIFIED; worker-stamped times are caller clock (W-5 bounds skew); a same-`workerId` process pair is caught only at S9 (use a per-process nonce); only 4 protected ids exist (fewer than the batch sizes), so "protected cannot starve allowed" is shown by exclusion-before-LIMIT and the P01 mutant, not by exhausting a batch; the late window keeps a timer alive up to `lateWindowMs`; inbox draining stays outside the worker; owner `paymentMethod`, live shapes / credentials / gates and a notification stage stay closed.


### 11.1 Root code review of `ddda945` — HOLD corrections (same branch, from exact `ddda945`)

| Item | Correction | Regression controls (red on `ddda945`, green after) |
|---|---|---|
| R-C1 environment check masked an outer DB failure | `runRecordingStep` now issues an explicit `SELECT environment FROM booking.instance`; only a SUCCESSFULLY read marker that is not `'test'` (or an absent marker) returns `refused / DATABASE_NOT_TEST`; any thrown query / transport / SQL error propagates as the ORIGINAL object with no follow-up query, provider call, release or mutation. No text-based discrimination; shared `pool.js` unchanged (the worker no longer imports `assertEnvironment`). Gate refusals still issue zero queries. | STUB-pool function-level (no real DB): thrown `57P01` / `42P01` / an `ECONNRESET` error with mismatch-like text → the same object rejected, exactly 1 query, 0 connects / writes / provider calls (RED on `ddda945`: refused `DATABASE_NOT_TEST`); acknowledged `live` / `staging` / absent marker → `DATABASE_NOT_TEST` after exactly 1 query (control; passes on both) |
| R-C2 exhausted-row citation preceded the ambiguity check | `selectRead`: more than one open candidate stops (`READ_ROWS_AMBIGUOUS`) FIRST, before any exhausted row is cited or anything is claimed / created; single-open / exhausted precedence, once-only counting, freshness, budget and floors unchanged | STUB-pool `selectRead`: `[fresh uncited exhausted, pending, pending]` → stop after exactly 1 query (RED: `cite`); controls: exhausted alone and exhausted + ONE open still cite. REAL disposable PG: the same mixed history → `STOP:READ_ROWS_AMBIGUOUS`, 0 provider calls / writes, no read / evidence / assessment / hold / case row created or changed, exhausted row uncited (RED: `ASSESSED:identity_refused:READ_NOT_COMPLETED`) |
| Scope ruling | `test/packaging-closure.test.mjs`: `lib/booking-db/recording-worker.js` added to the explicit `OFFLINE_ONLY` list (no api/ route closure reaches it; passes); the earlier file-list pin and the list-first extension are approved | — |

**Targeted mutants (this correction only):** C1a (thrown marker error masked again), C1b (non-test marker accepted), C2a (pre-fix order), C2b (ambiguity stop removed) — 4/4 killed.
**Suites (CLAUDE-RUN, disposable local PG 16; TAP in `scratchpad/tap-rc/`):** red run on the unchanged worker 3 expected failures; focused worker + packaging 40/40; worker + 0010–0014 + migrations + offline-charge 153/153; `npm test` 684/684; `test:db` 409/409. The historical e74a guard did not fail (still open). Migrations 0001–0014, the pure module and fixtures unchanged in this correction.
