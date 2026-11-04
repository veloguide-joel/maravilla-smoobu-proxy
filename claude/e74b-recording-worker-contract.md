# E7.4b recording worker — CONTRACT (DOCS ONLY, PROPOSED) for an OFFLINE / INJECTED-MOCK implementation

**Branch.** `feature/e7-offline-charge-worker-contract`, cut from exact `bc0f93c2000e1f5aa1a3b3954cc75594402ce244`.

**Status.**
- **D5 / 0014 is PRESENT and accepted offline at `bc0f93c`** (root ruling). The 0010–0014 database foundation is accepted OFFLINE; this is not live or payment readiness.
- **The recording worker is PROPOSED here** and is not implemented. No SQL, helper, worker code, test, adapter, route, UI, config, dependency or schedule changes in this slice.

**What this is.** The integration design that wires the ACCEPTED pure proof module (`lib/checkout/offline-charge-proof.js`) and the ACCEPTED database primitives (0010–0014) into ONE bounded offline worker step with INJECTED mock reads / write, following the accepted capture / compensation workers. It does not redesign those foundations.

**Boundaries (unchanged).**
- No real Hostaway / Stripe client import, credential, environment access or reachable live entrypoint; executors are injected functions only.
- Provider shapes are DOC-DERIVED, LIVE-UNVERIFIED. Labels (`accountRef`, `clientSnapshotId`) are [TRUST]: they never authenticate a credential.
- `paymentMethod` is explicit configuration with NO default; the owner's choice and every live gate stay closed. Packages are USD; MXN fixtures authorize nothing.
- Never: notification / refund / cancel / void, automatic resend, new key, attempt > 1, redispatch of an ambiguous write, admin release, `link_full_proof`, or mutation of protected reservations 70636076 / 71045356 / 71072615 / 71081885.

**Citation form.** `file:line` at `bc0f93c`. `proof` = `lib/checkout/offline-charge-proof.js`; `ops` = `lib/booking-db/operations.js`; `cw` = `lib/booking-db/capture-worker.js`; `rw` = `lib/booking-db/reservation-worker.js`; `00nn` = `db/migrations/00nn_*.up.sql`.

---

## 1. Source inventory at `bc0f93c`

### 1.1 E3 entry and final event

| Fact | Source |
|---|---|
| `CAPTURE_SUCCEEDED` / `RECONCILED_CAPTURE_SUCCEEDED` → `payment_captured` and queue ONE `hostaway.record_offline_charge` effect | `lib/checkout/intent-state.js:523–532`, `:546–551` |
| The effect becomes a `non_idempotent` row, key `och:<intent>:<offlineChargeAttempts+1>` (initial = `:1`), payload `{reservationId, amountMinor}` | `lib/booking-db/repo.js:104–106` |
| `payment_captured` accepts `OFFLINE_CHARGE_RECORDED`, `OFFLINE_CHARGE_FAILED`, `ESCALATE` | `intent-state.js:135` |
| `OFFLINE_CHARGE_RECORDED {chargeId}` → `confirmed` **and queues a `guest.notify` effect** (`booking_confirmed`) | `intent-state.js:594–597`; row type `repo.js:107–108` |
| `OFFLINE_CHARGE_FAILED` → queues attempt `n+1` (attempt > 1) | `intent-state.js:598–604` |
| Event guards: `OFFLINE_CHARGE_FAILED` needs the latest recording `failed_definite`; `OFFLINE_CHARGE_RECORDED` needs the latest recording `succeeded`, `result_ref = chargeId`, LINKED, no active hold | `repo.js:279–298` (DB trigger authoritative: 0010:332–352, 0011:436–455) |
| Planner: succeeded → `OFFLINE_CHARGE_RECORDED`; failed_definite → `OFFLINE_CHARGE_FAILED`; else operator `OFFLINE_CHARGE_OUTCOME_UNKNOWN` (never re-recorded) | `lib/checkout/recovery-plan.js:370–379`; finder scope `lib/booking-db/recovery.js:65–68` |
| `markUnknown` for `non_idempotent`: `outcome_unknown` + case `OFFLINE_CHARGE_OUTCOME_UNKNOWN` (`opened_by = op:<id>`), never re-queued | `ops:402–409`, kinds `ops:22–26` |
| `EXTERNAL_DISPATCH_ENABLED = false`; `dispatchOperation` throws `DISPATCH_DISABLED` without an injected executor | `ops:20`, `ops:506–514` |

### 1.2 Public DB helpers the worker uses (all existing; app role)

| Helper | DB function / lock order | Source |
|---|---|---|
| `requestRead(pool, intentId, 'hostaway.retrieve_reservation' \| 'hostaway.list_offline_charges', reservationId, {now})` | INSERT pending `read` row, payload `{reservationId}` | `ops:472–485` |
| `claimNextOperation(pool, {workerId, now, opId, opTypes, leaseMs})` | intent SHARE → (recordings) work SHARE → op UPDATE (SKIP LOCKED); `RECORD_FENCE` mirror with `recording_claim_ready(o.id, claimant)`; triggers: 0011 fence + 0012/0013 refusal, AFTER audit | `ops:78–88`, `ops:91–133`; 0012:529–564; 0013:104–135, 137–149 |
| `completeOperation(pool, opId, {workerId, now, outcome})` | refuses `succeeded` for a recording (`RECORDING_SUCCESS_REQUIRES_EVIDENCE`); `outcome_unknown` → `markUnknown` | `ops:166–175`, `ops:353–383` |
| `recordProviderEvidence(pool, {readOpId, kind, externalRef, status, observed})` | read op FOR UPDATE → INSERT (FK share intent) → advisory (charge lists); `observed_at := read.completed_at`; inbox enqueue trigger | `ops:492–503`; 0010:354–390; 0011:639–650 |
| `recordRecordingAssessment(pool, opId, {...})` | intent SHARE → work SHARE → op SHARE → reads SHARE → advisory, then `v_t`; pending initial, latest, version, work lease, no hold, no latch, release floor, validator | `ops:250–263`; 0013:200–242, 243–333, 335–389 |
| `openRecordingPreflightHold(pool, opId, {by})` | DB-derived reason / citation from the current-epoch latch; visibility only | `ops:291–295`; 0013:447–491 |
| `openRecordingVisibilityHold(pool, opId, {reason: 'ATTEMPT_GT1' \| 'SUCCEEDED_UNPROVEN', by})` | intent SHARE → op UPDATE → advisory; idempotent | `ops:301–305`; 0011:586–637 |
| `completeRecordingWithEvidence(pool, opId, {workerId, evidenceId, resultRef, expectedVersion})` | intent SHARE → work SHARE → op UPDATE → advisory, then `v_t`; version, work lease, op lease, latest, no hold, attempt 1, `worker_fresh` proof (2 min), positive-contradiction refusal, D5 guard | `ops:188–192`; 0011:363–402; 0010:42–129; 0014:23–53, 69–153 |
| `applyEvent(pool, intentId, event, {inTx, ...})` | intent FOR NO KEY UPDATE; `guardEvent`; inTx fences | `repo.js`; pattern `cw:100–114` |
| `recoverExpiredOperations(pool, {..., intentStates})` | phase-guarded maintenance (intent SHARE first) | `ops:426–458` |
| `drainRecordingConflictInbox(pool, {by, maxCalls})` | ≤ 100 independent calls; thrown error re-thrown unchanged (R1) | `ops:324–351` |
| SELECT only (RLS `app_ro`): `recording_assessments`, `recording_claim_assessments`, `recording_holds`, `recording_conflict_inbox` | | 0012:582–594; 0011:825–830 |

Not used by the worker: `linkRecordingEvidence` (maintenance), `recordReleaseReviewAssessment` (maintenance), every admin function (`db/lib/admin.js`), `settleOperationFromEvidence` (reconcile-first only), `dispatchOperation`.

### 1.3 Pure functions available (`proof`)

| Function | Use | Lines |
|---|---|---|
| `configRefusal(cfg)` — exact keys `accountRef, channelId, currency, listingId, paymentMethod, refFieldId`; USD; channel 2000; **no default** | gate | 122–136 |
| `intentRefusal(intent, cfg)` — exact 12 intent fact keys incl. `recordedPaymentAt` | every assessment | 139–156 |
| `recordingOpRefusal(op, intent)` — pending, `attempts 0`, `dispatchedAt null`, key `och:<intent>:1` | PRE-CLAIM only | 158–170 |
| `assessIdentitySnapshot` / `assessChargeList` — branded, fresh ≤ 2 min, labels | preflight + confirm | 200–232, 244–288 |
| `qualifyPreflight` — branded eligibility (`sendAuthorization:false`), frozen context, recording identity, canonical request | PRE-CLAIM | 309–332 |
| `buildOfflineChargeRequest` — PRE-CLAIM: carried freshness, context + recording identity equality | PRE-CLAIM | 359–375 |
| `validateOfflineChargeRequest(request, {intent, config})` — shape / binding (call WITHOUT `recordingOp` post-claim) | pre-write | 377–382 |
| `assessCreateReply` → branded candidate, `sufficient:false` | post-write | 392–425 |
| `assessConfirmingRead` → `observed` (15 keys = 0010 proof keys), `observedAt` | post-write | 430–473 |
| `classifyTitle`, `offlineChargeMarker`, `formatScheduledDate`, `freshnessRefusal` | helpers | 78–117 |

Pure→row classification (which codes persist, which stay local) is already fixed in `claude/e74b-preflight-assessment-contract.md` §4.1–4.4 and the frozen catalogue (0012:21–92). The worker applies it; it adds no code.

### 1.4 Accepted worker patterns reused (not changed)

Gate on an explicit `env` OBJECT (`cw:73–91`, `rw:126–147`); `assertEnvironment(pool, 'test')` (`cw:606`); `claimWork` / `releaseWork` scoped by states + listings + optional intent (`rw:562–574`, `rw:171–176`); bounded executor calls with `AbortSignal` + `ProviderCallTimeout` (`rw:91–106`); protected ids (`rw:69–71`); claim-then-recheck-then-send with **no await between the final decision and the call start** (`cw:394–440`); positive reply → ONE confirming read; anything else → `outcome_unknown` (`cw:441–455`, `cw:483–493`); fenced E3 event with `op-outcome:<opId>` (`cw:464–479`, `recovery-plan.js:47–51`); scoped recovery pass (`cw:533–591`).

### 1.5 Genuinely missing pieces (no migration needed)

- **W-a (pure, additive).** The preflight list evidence must carry `matchingChargeCount / matchingChargeIds / lookalikeCount / sameAmountPaidCount / rowCount` re-derivable by 0012:284–325, but the pure partition is private (`proof:290–299`). Recommended: one additive exported pure helper `preflightListObservation(list, intent)` (branded list in, frozen counts out; reuses `partition`), plus `identityEvidenceObservation(identity)`. No existing export changes. Alternative: duplicate the 4-line partition in the worker using the exported `classifyTitle` (risk: drift).
- **W-b (worker query).** `recordedPaymentAt` (source of `scheduledDate`) has no loader yet (`claude/e74b-evidence-contract.md:463` defers it). Recommended: the DB-stamped `intent_transitions.recorded_at` of the UNIQUE row with `to_state = 'payment_captured' AND from_state IS DISTINCT FROM 'payment_captured'`; zero or several → local refusal `RECORDED_PAYMENT_TIME_AMBIGUOUS`. [TRUST: not Stripe's capture instant.]
- **No new DB invariant is needed.** Every send-relevant fact is already enforced by 0010–0014; the worker only reads and re-checks.

---

## 2. Worker API, configuration, executors, scope

**Planned files (implementation slice, after acceptance):**
- new `lib/booking-db/recording-worker.js` (internal library; no route / cron / default executor);
- additive pure helpers in `lib/checkout/offline-charge-proof.js` (W-a, if chosen);
- new `test/e74b-recording-worker.test.mjs` (pure / gate / mock-executor unit, no DB) and `test/db/e74b-recording-worker.test.mjs` (disposable PG);
- minimal USD fixture helper in `test/db/fixtures.mjs`;
- status pointers in this contract and the D5 contract. **No migration.**

**API.**
```
runRecordingStep(pool, { workerId, env, listings, executors, clock, intentId?, timeouts?, monotonic?, hooks? })
  -> Object.freeze({ status: 'refused' | 'idle' | 'worked', code?, intentId?, actions: string[], calls: string[], writes: 0 | 1, delayMs?, late: Promise })
runRecordingInboxDrain(pool, { workerId, env, listings, maxCalls<=10 })   // separate entry point (§7.4)
recordingWorkerGate({ env, listings, executors, clock }) -> { ok:true } | { ok:false, code }   // pure
```

**Gate (pure; nothing is touched before it passes):**
- `env` is a caller OBJECT (never `process.env`): `VERCEL_ENV ∈ {development, preview}` (production refused) and `MV_E7_RECORDING_WORKER === 'enabled'`;
- `listings: Map<listingId, cfg>`; each `cfg` passes `configRefusal` (USD, channel 2000, approved `paymentMethod` **explicitly present**, label regex) and `cfg.listingId === key`; missing `paymentMethod` → `PAYMENT_METHOD_UNSET`;
- `executors` has EXACTLY `retrieveReservation`, `listOfflineCharges`, `createOfflineCharge` (functions) plus a frozen `label: { accountRef, clientSnapshotId }`; `label.accountRef` must equal every configured `cfg.accountRef`; nothing else allowed (`EXECUTOR_NOT_ALLOWED`);
- `clock()` finite; `workerId` matches `/^[A-Za-z0-9._:-]{1,80}$/` and SHOULD carry a per-process nonce (§8, F-3);
- then `assertEnvironment(pool, 'test')` (`DATABASE_NOT_TEST`) and a clock-skew check `|clock() − DB clock_timestamp()| ≤ 2 s` (`CLOCK_SKEW`) — the DB compares worker-stamped read times with its own clock (open choice W-5).

**Dispatch-disabled behaviour.** Without a passing gate the result is `refused` with no query beyond the environment check: nothing claimed, read, assessed or sent. The worker never calls `dispatchOperation`, never flips `EXTERNAL_DISPATCH_ENABLED`, and imports no provider client.

**Executor contract (injected; DOC-DERIVED, LIVE-UNVERIFIED shapes):**
- `retrieveReservation({ method:'GET', path:'/v1/reservations/<id>', query:{} }, { signal }) -> { httpStatus, json }`;
- `listOfflineCharges({ method:'GET', path:'/v1/guestPayments/charges', query:{ reservationId:<id>, limit:500 } }, { signal }) -> { httpStatus, json }`;
- `createOfflineCharge(request /* frozen canonical POST from the eligibility */, { signal }) -> { httpStatus, json }`.
The worker stamps `{ accountRef, clientSnapshotId }` from `executors.label` and `observedAt` from its clock; an executor never supplies proof fields.

**Scope.** `claimWork(states = ['payment_captured'], listingIds = keys(listings), intentId?)`; maintenance / recovery scoped in SQL before any LIMIT to the same listings, `payment_captured`, and op types `{record_offline_charge, retrieve_reservation, list_offline_charges}`. Protected reservation ids → local refusal before any read.

**Limits (proposed constants).** `readCallMs 10 s`, `writeCallMs 20 s`, `stepBudgetMs 60 s`, `workLeaseMs 120 s`, recording `opLeaseMs 90 s`, `sendMarginMs 15 s`, `waitMs 30 s`; `SNAPSHOT_MAX_AGE_MS = 2 min` (proof:36, 0013 claim refusal, 0010 `worker_fresh`). At most ONE intent, ONE identity read, ONE list read, ONE write and ONE confirming read per step.

---

## 3. State / step table (one `runRecordingStep`, one intent)

No step holds a DB transaction or row lock across a provider call: every DB step below is its own helper transaction; provider calls happen between them.

| # | Step | DB transaction / locks | Inputs → pure check | Persisted | Refusal → result | Next permitted |
|---|---|---|---|---|---|---|
| S0 | gate, env, skew | none / one SELECT | §2 | — | `refused:<code>` | none |
| S1 | scoped maintenance + recovery pass | `recoverExpiredOperations` (intent SHARE → ops); recovery: only `OFFLINE_CHARGE_RECORDED` for a succeeded LINKED latest recording (§7.3) | planner `recovery-plan.js:370–379` | unknown + case for expired leases | — | S2 |
| S2 | `claimWork` | intent_work UPDATE (SKIP LOCKED) | — | work lease (no version bump) | none due → `idle` | S3 |
| S3 | load + classify | `loadIntent`, recording rows, holds, claim audit, assessments (SELECT) | `intentRefusal` (+W-b), protected id, listing in config, single initial row | — | see §5 routing table | S4 or stop |
| S4 | identity read | `requestRead` → `claimNextOperation(opId)` → **call** → `completeOperation(read, succeeded, now=T₁)` → `recordProviderEvidence` (positive / mismatch / 404 only) | `assessIdentitySnapshot({accountRef, clientSnapshotId, httpStatus, json, observedAt:T₁})` | read row; evidence (0012 shapes) | transport error → read `outcome_unknown` (re-queued, uncounted) → `WAIT` | S5 or S6 (refused) |
| S5 | list read | same, `hostaway.list_offline_charges`, `{reservationId, limit:500}`, `T₂` | `assessChargeList`; complete page → count-only evidence (W-a); incomplete → NO evidence | read row; evidence | transport → `WAIT` | S6 |
| S6 | classify + persist | `recordRecordingAssessment` (intent → work → op → reads → advisory) | `qualifyPreflight` on fresh `loadIntent` facts + pending op; §4.1 of the preflight contract decides persist vs local | ONE assessment row (eligible / conflict / incomplete / identity_refused) | local code → `STOP` (nothing counted); DB refusal codes → §5 | eligible → S7; conflict / 3rd count → open preflight hold, stop |
| S7 | build request PRE-CLAIM | none (pure; fresh `loadIntent` + pending op) | `buildOfflineChargeRequest({eligibility, intent, recordingOp, config, now})` | — | refusal → `STOP` (assessment kept; claim not attempted) | S8 |
| S8 | claim | `claimNextOperation({opId, opTypes:[record], leaseMs: opLeaseMs})`: intent SHARE → work SHARE → op UPDATE; fence + audit triggers | DB re-checks latest current-epoch eligible assessment by this worker, ≤ 2 min, version, cfg listing / currency, work lease | `in_flight`, `attempts 1`, `dispatched_at = now` (**claimed, not sent**), claim audit | `null` → `WAIT` (nothing sent) | S9 |
| S9 | binding + pre-write re-check | SELECTs only, then clock | §4.2 list | — | any mismatch → §6.1 pre-write abort | S10 |
| S10 | **write** (once) | none | — | `writes = 1` before awaiting | — | S11 |
| S11 | reply | none | `assessCreateReply` → candidate (`sufficient:false`) | — | not a candidate / timeout / throw → §6.2 unknown | S12 |
| S12 | confirming read | NEW `requestRead` + claim (created / dispatched after the recording) → call → complete at `T₃` → evidence | `assessChargeList` + `assessConfirmingRead({candidate, eligibility, list, intent, config, dispatchedAt, now:T₃})` | full 15-key proof evidence (ok) or count-only (complete page, refused) or none | refused / transport → §6.2 unknown | S13 |
| S13 | complete | `completeRecordingWithEvidence(op, workerId, evidenceId, chargeId, expectedVersion)` (intent → work → op UPDATE → advisory, then DB clock) | DB: version, both leases, latest, no hold, attempt 1, 2-min proof, no contradiction, **D5** | `succeeded` + `settled_evidence_id` | known refusal → §6.2 unknown (if lease still held) | S14 |
| S14 | finalise | `applyEvent(OFFLINE_CHARGE_RECORDED {chargeId}, id = op-outcome:<opId>)`, inTx: work lease, op `succeeded` + same `result_ref` + linked, no active hold | `guardEvent` + 0010 trigger | `confirmed`; ledger; **`guest.notify` outbox row queued (not executed)** | refusal → action only; recovery repeats S14 later | release work |

`releaseWork(delayMs)` always runs in `finally` (`rw:171–176`).

---

## 4. In-memory brands ↔ the persisted assessment that qualified the claim

### 4.1 Why a binding check is needed
The branded eligibility lives in a process-local `WeakSet` (`proof:54–58`); the DB cannot recreate it, and the claim audit binds the **latest current-epoch eligible assessment by the claimant** (0013:137–149), not "the one this process computed". The worker therefore carries `A = recordRecordingAssessment(...).id` together with its eligibility / request, and proves they coincide after the claim.

### 4.2 Pre-write checks (S9; fresh rows, clock read AFTER the reads; no await between the decision and the call start)
1. op: `in_flight`, `lease_worker_id = workerId`, `lease_until − now > writeCallMs + readCallMs + sendMarginMs`, `attempts = 1`, key `och:<intent>:1`, payload equal to `eligibility.recording`, latest recording, no active hold (SELECT `recording_holds`);
2. claim audit: exists, `assessment_id = A`, `worker = workerId`, `epoch` = number of released preflight holds (SELECT; mirrors 0013:59–64);
3. assessment `A`: `phase 'preflight'`, `outcome 'eligible'`, `worker = workerId`, `cfg` deep-equal to the in-memory `config`, `account_ref = cfg.accountRef = executors.label.accountRef`, `client_label = eligibility.clientSnapshotId`, `intent_version = eligibility.context.version`, `module_version = OFFLINE_CHARGE_PROOF_VERSION`, identity / list evidence ids = the ones this step recorded;
4. intent: `payment_captured`, `version` and every context field equal to `eligibility.context` (`proof:179–184`), `offline_charge_attempts = 0`, protected id refused;
5. work lease: `workerId`, room > `writeCallMs + readCallMs + sendMarginMs`;
6. carried freshness: `freshnessRefusal(identityObservedAt / listObservedAt, now)` null (same 2 min);
7. `validateOfflineChargeRequest(request, { intent, config })` (no `recordingOp`: it is no longer pending) and `request === eligibility.request`;
8. step budget > `writeCallMs`.

A newer different assessment cannot be used (2); a cached proof from an earlier step cannot be used (the request / eligibility exist only in this step's memory, and S4–S6 always run in the same step as S10).

### 4.3 Pre-completion checks
The DB re-checks version, both leases, latest, no hold, attempt 1, the 2-minute proof window, positive contradictions and D5 (claim-snapshot account / method) at its own clock (0011:363–402, 0014). The worker additionally requires `assessConfirmingRead` on fresh intent facts (context equality) and that the confirming read id ≠ any preflight read (it is created after the claim; the DB enforces read-after-recording / dispatch, 0010:69–77).

### 4.4 The unavoidable gap
After the last check in S9 the provider may still change, another actor may still act on Hostaway, and the call may land after a lease expires. Nothing here is provider atomicity: the guarantee is only "no write is started on a stale or mismatched local basis", and everything after the call start is treated as possibly applied.

---

## 5. Outcome mapping (S3 / S6 routing)

| Situation | Worker action |
|---|---|
| Fact / config / binding / timing refusal (preflight contract §4.1 "worker-local") | stop locally; nothing persisted or counted. Permanent fact refusal → fenced `ESCALATE` `RECORDING_<CODE>` on the planned version (open choice W-6); transient (stale / skew) → `WAIT` |
| Persistable `incomplete` / `identity_refused` (distinct fresh reads, each counted once: 0013:271–273 + UNIQUE read keys 0012:123–124) | persist; the DB counts; the 3rd in the epoch latches `EXHAUSTED` → `openRecordingPreflightHold` |
| `conflict_marker` / `conflict_lookalike` / `conflict_same_amount` | persist (list evidence counts re-derived) → latch → `openRecordingPreflightHold` (DB-derived reason / citation) |
| Writer refuses `ASSESSMENT_EPOCH_CONFLICTED` / `ASSESSMENT_EPOCH_EXHAUSTED` | `openRecordingPreflightHold` (idempotent), stop |
| Active hold (any reason) / `ASSESSMENT_HOLD_ACTIVE` | stop; no read, no write |
| Latest recording is a pending attempt > 1 | `openRecordingVisibilityHold('ATTEMPT_GT1')`, stop (never claimed: 0011 fence) |
| Latest recording `succeeded`, unlinked | `openRecordingVisibilityHold('SUCCEEDED_UNPROVEN')`, stop (never `link_full_proof`, never `linkRecordingEvidence`) |
| Latest recording `succeeded`, linked, no hold | S14 only (idempotent finalisation; no provider call) |
| Linked + contradicted (inbox / `LINKED_CONTRADICTED` hold) | stop; owner path only |
| `in_flight` (any lease) | `WAIT`; never resumed by a new step (§6) |
| `outcome_unknown` / `escalated` / `failed_definite` | stop; existing owner case; worker never applies `OFFLINE_CHARGE_FAILED` |

**Never in the send worker:** `recordReleaseReviewAssessment`, `adminReleasePreflightHold`, `adminResolveRecordingHold`, `adminResolveOperation`, `linkRecordingEvidence`. Release review + owner release stay owner maintenance (`claude/e74b-preflight-release-contract.md`); a separate read-only review runner can be proposed later only if root asks.

---

## 6. Claimed versus written

`claimNextOperation` stamps `dispatched_at` and `attempts = 1` at the claim (`ops:113–120`): from S8 the row is "possibly sent" for every other actor, even though only S10 invokes the writer.

### 6.1 After the claim, before the write (S8–S9)
| Event | Outcome under the current schema |
|---|---|
| Binding / drift / budget / lease-room refusal in S9 | `completeOperation(outcome_unknown, errorCode 'SEND_ABORTED_<REASON>')` → `markUnknown` → owner case `OFFLINE_CHARGE_OUTCOME_UNKNOWN`. The code records the worker's in-process assertion that the writer was NOT invoked; it is [TRUST], not proof of non-creation |
| Crash / lease loss before the write | op stays `in_flight` until its lease expires → `recoverExpiredOperations` → `outcome_unknown` `LEASE_EXPIRED` + case |
| Never | reset to `pending`, `failed_definite`, a new attempt / key, or "definitely not sent" inferred from a missing local result |
Recoverability: owner resolution only (`admin_resolve_operation`, ≥ 15-min evidence rules, 0005 / `proof:37`), then owner link maintenance. No automated path sends again.

### 6.2 After the write was invoked (S10–S13)
Timeout, throw, malformed / non-2xx / partial reply, a candidate that fails confirmation (zero, multiple, look-alike, id / field / method mismatch, not after dispatch, stale, future), a transport failure of the confirming read, or a known completion refusal → `completeOperation(outcome_unknown, '<STEP>_<CODE>')` + case; retained: the read rows and, for a COMPLETE confirming page, its count-only evidence (a full-shape proof row only when `assessConfirmingRead` succeeded). A late reply after a timeout is recorded only after the unknown settlement commits, as late evidence, never as an event (`cw:444–448`, `ops:358–367`). Any exception after the call start is caught once to attempt the unknown settlement, then re-thrown unchanged; if that settlement fails, lease expiry produces it. **Definite failure:** none in v1 — HTTP status alone never yields `failed_definite`; only owner resolution with catalogued facts can.

**No-live semantics.** With mock executors "sent" means "the injected function was invoked once"; nothing reaches Hostaway. `writes ≤ 1` per op is asserted in tests.

---

## 7. Success, finalisation, recovery, later evidence

### 7.1 Success requires (all mandatory)
A candidate reply (necessary, not sufficient) AND a confirming list read created and dispatched after the recording, observed strictly after `dispatched_at` and ≤ 2 min before the DB decision, complete single page, same client label as the eligibility, exactly ONE exact-title match equal to the candidate on id / reservation / listing / type / title / amount / currency / status / provider / method, persisted as the 15-key proof (`proof:430–436` = the 0010:82–83 key set), then `completeRecordingWithEvidence` passing D5 (claim-snapshot account + method), version, both leases, latest, no hold and no positive contradiction.

### 7.2 Order and idempotent recovery
Complete FIRST (S13), then the E3 event (S14). If interrupted between them, the op is `succeeded` + linked; the next step (or the S1 recovery pass via the planner) applies `OFFLINE_CHARGE_RECORDED` with the same event id (`op-outcome:<opId>`); a duplicate is a no-op. No path reaches the writer again (the row is not pending; the fence forbids attempt > 1).

### 7.3 Recovery pass scope
Only plans of kind `event` with `OFFLINE_CHARGE_RECORDED` are applied (guard requires linked + no hold). Operator plans (`OFFLINE_CHARGE_OUTCOME_UNKNOWN`) and `OFFLINE_CHARGE_FAILED` are NOT applied by this worker (open choice W-7); the owner case already exists.

### 7.4 Later contradictory evidence
Every offline-charge evidence row enqueues an inbox item in its own writer transaction (0011:639–650). Draining is a SEPARATE entry point `runRecordingInboxDrain` (same gate; `maxCalls ≤ 10`): it calls `drainRecordingConflictInbox` and lets a thrown error propagate UNCHANGED (R1: no catch, no retry; a connection lost around COMMIT is reported as unknown by the caller). Item errors stay queued with their attempts. Positive contradiction never reverses `confirmed`; it opens owner visibility only (0011). No schedule or latency is promised.

---

## 8. Deterministic fault / recovery table

| # | Fault | Re-readable facts | Unknown write outcome? | Result |
|---|---|---|---|---|
| F-1 | work lease reassigned / expired during waits | lease rows | no (pre-write) / yes (post-write) | pre-claim: `recordRecordingAssessment` / claim refuse (`WORK_LEASE`); S9 abort → unknown; post-write: completion `RECORDING_WORK_LEASE_LOST` → unknown |
| F-2 | op lease expires after the write | op row | yes | completion `RECORDING_LEASE_LOST`; maintenance marks unknown + case |
| F-3 | two processes, SAME `workerId` | assessments, audit | — | audit binds the latest assessment; S9 check 2 (`assessment_id = A`) aborts the other → unknown (hence the per-process nonce) |
| F-4 | competing workers, different ids | work lease | — | `claimWork` SKIP LOCKED; claim fence requires assessor = claimant = lease holder |
| F-5 | direct `UPDATE` claim vs helper → `40P01` | everything | no | one side aborted, nothing committed; the step throws (no retry inside); next step re-derives |
| F-6 | assessment committed, crash before claim | assessment | no | next step: new reads (assessment ≤ 2 min stale → claim refuses `STALE`); the old eligible row is never reused |
| F-7 | claim committed, crash before the write | op, audit | owner-only | §6.1 (lease expiry → unknown + case) |
| F-8 | reply obtained, crash before confirm / complete | op | yes | lease expiry → unknown + case; no resend |
| F-9 | completion committed, event not | op succeeded + linked | no | S14 / recovery pass applies the event once |
| F-10 | connection lost around COMMIT of completion / event | re-read op / intent | completion: re-read decides | next step classifies from rows; never a second write |
| F-11 | migration / refusal around COMMIT (e.g. 0014 down gate) | schema version | — | worker refuses on missing helpers (thrown); 0014 down refuses while a claimed recording is unlinked |
| F-12 | optional hold open fails | holds | no | action recorded; the claim fence still blocks; the next step retries the idempotent opener |
| F-13 | inbox drain throws | inbox | drain call: maybe committed | §7.4; send step unaffected |
| F-14 | capture / cleanup workers on the same intent | intent state | — | disjoint states (`reservation_confirmed`/`capture_*` vs `payment_captured`); a state change fails the fenced S14 / maintenance; lock order intent-first everywhere |

Lock order (unchanged): intent → work → op → reads → advisory (assessment); intent → work → op (claim); intent → work → op → advisory (completion); read op → intent (FK) → advisory (evidence). **No exactly-once claim**: at most one writer invocation per op, outcome possibly unknown.

---

## 9. Planned tests (implementation slice)

**Unit (no DB; mock executors; USD; LIVE-UNVERIFIED shapes):** gate matrix (env, enable flag, production, executors exact keys, label vs cfg, `paymentMethod` missing / unapproved, non-USD, clock); request built only from a branded eligibility; reply / confirm classifiers per refusal; `writes` counter; abort-signal timeouts.

**Disposable PG (real 0001–0014; injected mocks):**
1. happy path: eligible → claim → one write → confirm → complete (D5) → `confirmed`; exactly 1 write, 2 preflight reads, 1 confirming read; `guest.notify` row queued and NOT executed;
2. no action: wrong listing, protected id, attempt > 1 (ATTEMPT_GT1 hold), active hold, succeeded-unproven (SUCCEEDED_UNPROVEN hold), non-USD / missing method (gate refused);
3. conflict marker / look-alike / same-amount → hold opened, 0 writes; three counted refusals → EXHAUSTED hold; transport failures uncounted until `READ_NOT_COMPLETED`;
4. epoch 2 (two owner releases in setup) → fresh assessment → claim → audit binds epoch 2;
5. D5 mismatch (proof method / account) → completion refused → unknown, 1 write, no second;
6. every §6.1 abort reason → unknown + case, 0 writes; every §6.2 post-write branch → unknown, 1 write, never a second (assert across 3 further steps);
7. F-1…F-14 with hooks (`afterClaim`, `beforeWrite`, `afterWrite`, `afterComplete`, `beforeEvent`), incl. same-`workerId` race and 40P01 path;
8. recovery after completion-without-event → event once, 0 extra writes;
9. no notification / refund / cancel / void call is reachable (executor key set); all 0010–0014 suites unchanged; `npm test`, `test:db`; targeted mutants on S9 checks, write-count guard and outcome mapping.

---

## 10. Smallest slice and open decisions (recommended first)

**Slice:** `recording-worker.js` + W-a pure helpers + two test files + USD fixture helper + status docs. No migration, no adapter, no route.

| # | Decision | Recommendation |
|---|---|---|
| W-1 | entry point | one bounded `runRecordingStep`; drain as a separate `runRecordingInboxDrain` |
| W-2 | list counts / identity observation | additive pure helpers in `proof` (W-a) |
| W-3 | `recordedPaymentAt` | unique DB-stamped `payment_captured` entry transition (W-b); else local refusal |
| W-4 | post-claim pre-write abort | `outcome_unknown` `SEND_ABORTED_*` + case (no other safe state exists today) |
| W-5 | clock skew | refuse > 2 s against `clock_timestamp()` |
| W-6 | permanent local fact refusal | fenced `ESCALATE RECORDING_<CODE>` (capture-worker pattern); transient → `WAIT` |
| W-7 | recovery pass | apply only `OFFLINE_CHARGE_RECORDED`; never `OFFLINE_CHARGE_FAILED` / operator escalation |
| W-8 | `guest.notify` effect from `OFFLINE_CHARGE_RECORDED` | accepted E3 behaviour: queued, never executed here (no notification stage exists); flag for root |

Still closed: owner `paymentMethod`, live shapes / credentials / gates, provider adapter, notification stage, the historical e74a guard failure.
