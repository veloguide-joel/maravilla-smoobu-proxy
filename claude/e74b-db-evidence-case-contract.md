# E7.4b D1 / D2: DB evidence-link and owner-case contract (DESIGN ONLY), revision 2

- **Branch:** `feature/e7-offline-charge-db-contract`.
  - Revision 1: `e772987`, cut from the accepted `4f6b27f`.
  - **Revision 2** answers root's HOLD on `e772987`, items 1–8. The resolution map is in §10.
- **Every migration, function, trigger, grant and helper change below is PROPOSED ONLY.** Nothing is applied, executable or authorized.
- Worker / adapter / dispatch stay on **HOLD**. Live gates E1–E7 / P1 stay open. The explicit `paymentMethod` owner choice and owner manual finalisation stay **outside** authorization. There is no automatic resend and no attempt > 1.

Labels used throughout:
- **[PRESENT]** current behaviour at `4f6b27f` / `e772987` (no code differs);
- **[PROPOSED]** design;
- **[TRUST]** an input the DB cannot attest.

**Root decisions recorded:**
- **D2 first, then D1.**
- Owner-linked proof keeps the **≥ 15 min after dispatch** requirement, with no historical maximum age.

---

## 1. Present behaviour (inspected; path:line)

### 1.1 Cases

- `booking.reconciliation_cases` (0001:536–551): a unique open case per `(intent_id, kind)` (l.549); no DELETE.
- App grants (0002:23–27): SELECT / INSERT / UPDATE on `reconciliation_cases` and on `external_operations`. UPDATE on cases is revoked (0003:675); `cases_safety_guard` (0003:462–470) refuses non-privileged case UPDATEs.
- **⇒ The app can INSERT any case directly.** Cases are not a trustworthy fence.
- `openCase` (operations.js:29–34) uses `ON CONFLICT (intent_id, kind) WHERE status='open' DO NOTHING`, which drops silently.
- `admin_close_case` (0003:640–656) refuses `opened_by LIKE 'op:%'`.

### 1.2 Operations

- **Operation guard.** `external_operations_guard` is **redefined in 0004:45–72**:
  - it freezes **only** `id`, `intent_id`, `op_type`, `idempotency_key`, `retry_class`, `payload`, `max_attempts`, `created_at`, plus `attempts` (non-decreasing);
  - it does **not** freeze `result_ref`, `dispatched_at`, `completed_at`, `source_version`, `settled_evidence_id`, `late_result_*`, `error_code`, lease fields or `next_attempt_at`;
  - moves: `pending → in_flight | superseded | escalated`; `in_flight → succeeded | failed_definite | outcome_unknown | escalated`; `→ pending` only for read / idempotent; `outcome_unknown → succeeded | failed_definite | escalated`; `escalated → succeeded | failed_definite`; nothing leaves `succeeded`.
  - The trigger is plpgsql, **SECURITY INVOKER**.
- **Safety guard.** `external_operations_safety_guard` (0004:74–112; INVOKER):
  - `resolution_id` is set by privileged code only;
  - a recording INSERT is refused unless every earlier recording is owner-resolved or catalogued `failed_definite`;
  - leaving `outcome_unknown | escalated` requires privilege;
  - non_idempotent `→ failed_definite` requires a catalogued code (the catalogue is empty);
  - **no rule on recordings `→ succeeded`, and none on `result_ref` / `settled_evidence_id`.**
- **`is_privileged()`** (0003:15–17) is `current_user = schema owner`. It is **true inside any schema-owner SECURITY DEFINER function, including those the app is granted** (`record_provider_evidence`, `settle_operation_from_evidence`). An INVOKER trigger therefore sees "privileged" whenever the UPDATE runs inside such a function.
- **Claim fences.** `capture_claim_fence` (0007) and `void_cancel_claim_fence` (0009) are SECURITY DEFINER triggers on `pending → in_flight` that share-lock the intent. There is **no recording fence**.
- **`claimNextOperation`** (operations.js:74–108) is intent-first (`FOR SHARE`), then op `FOR UPDATE SKIP LOCKED`. It sets `in_flight`, `attempts + 1`, **`dispatched_at = $2` (the caller's `now`)**, and `lease_until = caller now + leaseMs`.
- **`completeOperationOnce`** (operations.js:149–177) locks the op `FOR UPDATE` only. It checks the lease against the **caller's** `now` and sets `result_ref` and **`completed_at = caller now`**.

### 1.3 Evidence and settlement

- **`settled_evidence_id`** (0004:26): an FK to `provider_evidence`. Its only runtime writer is `settle_operation_from_evidence` (0005:239–289, reconcile_first only).
  - 0008 refuses clearing or repointing a **non-null** value on UPDATE, for every role. It does not constrain INSERT, and does not constrain the first NULL → id.
- **`provider_evidence`:** append-only (0003:73–76); `read_operation_id UNIQUE` (0003:61).
  - API evidence comes only via `record_provider_evidence` (0003:474–506), from a succeeded read of the matching type, with `external_ref` = the read selector and **`observed_at := read.completed_at` (a caller-supplied time)**.
  - Dashboard evidence comes via `admin_record_evidence` (0003:508–519), with an owner-supplied `observed_at`.
- **`admin_resolve_operation`** (0005:296–384, admin only):
  - **Correction of revision 1:** for a recording, `succeeded` (0005:327–331) requires cited evidence of kind `hostaway_offline_charges` with `external_ref` = reservation, `observed_at ≥ dispatch + 15 min`, count 1 and id = result. **It does not require `source = 'hostaway_api'`**, so matching **dashboard** evidence is accepted.
  - It sets `state`, `result_ref`, `completed_at`, `resolution_id`, and resolves the `op:<id>` case. **It never sets `settled_evidence_id`.**
  - It locks the op first and reads the intent without a lock.
- **E3 success guard** (repo.js:286–290): only `succeeded` + `result_ref`. There is no DB intent rule for `payment_captured → confirmed`.
- **`intent_work`** (0001:252–258) leases are checked in application code.

---

## 2. Principles

1. Paid truth is never weakened.
   - No ESCALATE, void, cancel, refund or notify.
   - No `dispatched_at` change to raise an alert; no fake send or unknown result.
2. Every guarantee is enforced **on the prospective `NEW` row** by INVOKER triggers, for **every** writer (app INSERT / UPDATE, SECURITY DEFINER functions, owner functions), scoped to `op_type = 'hostaway.record_offline_charge'`. Other op types keep their semantics.
3. **Authorization ≠ validation.**
   - Authorization guards are SECURITY INVOKER and use `is_privileged()` only to mean "inside a schema-owner function".
   - **Which** function is enforced by grants (the app may EXECUTE only the named recording functions) plus function-internal checks.
   - SECURITY DEFINER validators may read rows but never stand in for caller authorization.
4. The DB attests **persisted bindings**. Times written by callers stay caller times. Provenance, the real account and configured-method agreement stay **[TRUST]**.

---

## 3. D2 (first): recording success lifecycle

### 3.1 Recording lifecycle invariants [PROPOSED; INVOKER trigger `zz0_recording_lifecycle_guard`, BEFORE INSERT OR UPDATE, `op_type = 'hostaway.record_offline_charge'`]

The trigger runs after the existing guards (name order) and before 0008's `zz_` trigger. It **validates `NEW` field values** and never re-SELECTs the row by `NEW.id`, which would read the OLD tuple in a BEFORE trigger.

**On INSERT:**
- `settled_evidence_id`, `result_ref`, `completed_at`, `dispatched_at`, `lease_*`, `late_result_*`, `resolution_id` are all NULL;
- `attempts = 0`; `state = 'pending'`;
- the key matches `^och:<intent_id>:[1-9][0-9]*$` with `<intent_id> = NEW.intent_id`.

So proof cannot be pre-seeded.

**On every UPDATE:**

| Field | Rule |
|---|---|
| `source_version`, `created_at`, key, payload | frozen (the key and payload are already frozen by 0004) |
| `dispatched_at` | NULL → value **only** with `OLD.state='pending' AND NEW.state='in_flight'`; then frozen |
| `completed_at` | NULL → value only on a transition **into** `succeeded \| failed_definite`; then frozen |
| `result_ref` | NULL → value only on a transition into `succeeded`; frozen afterwards (also while staying `succeeded`) |
| `state → succeeded` | requires `is_privileged()` (inside an owner function, or a granted recording function), **and** either (a) `NEW.settled_evidence_id` is non-null and valid for `NEW` (§3.2), or (b) `NEW.resolution_id IS NOT NULL` (owner resolution; owner-only by 0004) |
| `settled_evidence_id` NULL → id | requires `is_privileged()`, `NEW.state = 'succeeded'`, and `recording_proof_refusal(NEW…) IS NULL`; never on a non-succeeded row |
| `late_result_*` | NULL → value only while `NEW.state IN ('outcome_unknown','escalated')` (present use); frozen once set. Today a second late result overwrites the first. For recordings it would be refused instead; the PROPOSED helper keeps returning `LEASE_LOST` (first late evidence kept) |
| after `succeeded` | every column frozen except `updated_at` |

- A direct app UPDATE (`current_user = mv_booking_app`) can therefore never set `succeeded`, attach a link, or relabel `result_ref`, `dispatched_at` or `completed_at` once set.
- Inside the granted functions, `is_privileged()` is true, so the **function** enforces leases and version (§3.3) and the **trigger** still validates `NEW`.

### 3.2 Proof validator [PROPOSED]

```
booking.recording_proof_refusal(p_intent uuid, p_payload jsonb, p_result_ref text, p_dispatched_at timestamptz,
                                p_created_at timestamptz, p_evidence uuid, p_mode text)
  RETURNS text   -- NULL = acceptable
  -- p_mode IN ('worker_fresh', 'owner_historical')
```

STABLE, SECURITY DEFINER (reads rows only), EXECUTE revoked from PUBLIC; called by the trigger and functions with **`NEW` values**. It returns a refusal unless **all** of the following hold.

**Evidence row `e`:**
- `kind 'hostaway_offline_charges'`, `source 'hostaway_api'`, `status 'listed'`;
- `e.intent_id = p_intent`.

**Read binding:**
- `r = e.read_operation_id`;
- `r.intent_id = p_intent`, `r.op_type = 'hostaway.list_offline_charges'`, `r.retry_class = 'read'`, `r.state = 'succeeded'`;
- `r.payload->>'reservationId' = e.external_ref = p_payload->>'reservationId' = intents.hostaway_reservation_id`;
- `e.observed_at = r.completed_at` (equality, as `record_provider_evidence` sets it).

**Operation window:**
- `p_dispatched_at IS NOT NULL`;
- `r.created_at ≥ p_created_at`;
- `r.dispatched_at ≥ p_dispatched_at` (the read was claimed at or after the recording send);
- `e.observed_at > p_dispatched_at`.

**No future** (DB clock): `p_dispatched_at ≤ statement_timestamp()` and `e.observed_at ≤ statement_timestamp()`.

**Mode:**
- `worker_fresh`: `e.observed_at ≥ statement_timestamp() − interval '10 minutes'`. The confirm must be fresh at completion.
- `owner_historical`: `e.observed_at ≥ p_dispatched_at + interval '15 minutes'`, with **no** maximum age.

**`e.observed`:**
- has exactly `EVIDENCE_OBSERVED_KEYS` (E7.4b-0);
- `matchingChargeCount = 1`; `matchingChargeIds = [p_result_ref]`; `chargeId = p_result_ref`, a canonical decimal string;
- `reservationId` = reservation; `listingMapId = intents.listing_id`;
- `amountMinor = (p_payload->>'amountMinor')::bigint = intents.captured_minor = intents.final_total_minor`;
- `currency = intents.currency`;
- `status 'paid'`, `type 'charge'`, `paymentProvider 'offline'`;
- `paymentMethod IN ('credit_card','other')` (the approved set);
- `title = 'maraVilla payment mvoch1-' || p_intent`; `marker = 'mvoch1-' || p_intent`;
- `readCount` an integer in 1..500.

**Conflict:** no other `hostaway_offline_charges` evidence for `p_intent` observed after `p_dispatched_at` lists this marker with a different charge id. This is **serialized** by §3.5.

**[TRUST]:**
- that the read happened against Hostaway and `observed` is its true content;
- that `executorAccountRef` is the same real account and credential;
- that `paymentMethod` equals the **configured** owner choice;
- that `dispatched_at` / `completed_at` reflect real times. They are **caller-supplied** (claim and complete use the caller's `now`). The DB checks only their mutual consistency and that none is in the DB-clock future.

### 3.3 Functions [PROPOSED]

**`complete_recording_with_evidence`**

```
booking.complete_recording_with_evidence(p_op uuid, p_worker text, p_evidence uuid, p_result_ref text, p_expected_version int)
  RETURNS text      -- SECURITY DEFINER; EXECUTE: mv_booking_app
```

1. `intents FOR SHARE` (the intent id is looked up first without a lock; it is immutable), then `intent_work FOR SHARE`, then the op `FOR UPDATE`.
2. Under those locks:
   - intent `payment_captured`, `version = p_expected_version`;
   - `work_worker_id = p_worker` and `work_lease_until ≥ statement_timestamp()`;
   - op `in_flight`, `lease_worker_id = p_worker` and `lease_until ≥ statement_timestamp()`;
   - the op is the deterministic latest recording (§3.6), key attempt 1, `attempts = 1`;
   - (D1 era) no active hold.
   - **[TRUST]** `lease_until` was computed from the caller's clock at claim time.
3. Take the per-intent recording-evidence lock (§3.5).
4. `UPDATE … SET state='succeeded', result_ref=p_result_ref, settled_evidence_id=p_evidence, completed_at=statement_timestamp(), lease cleared`. The trigger validates `NEW` in `worker_fresh` mode.
5. Any refusal raises and the whole transaction rolls back.

**`link_recording_evidence`**

```
booking.link_recording_evidence(p_op uuid, p_evidence uuid)          -- SECURITY DEFINER; EXECUTE: mv_booking_app
```

- For a recording already `succeeded` with a NULL link (owner-resolved or inherited).
- Locks: intent `FOR SHARE` → op `FOR UPDATE` → evidence lock (§3.5).
- Mode `owner_historical`.
- Requires `result_ref` non-null (the link binds the **existing** `result_ref`; it never sets one).
- (D1 era) **refuses while an active hold exists** (§4.6).
- Sets NULL → id; 0008 then freezes it.

**`completeOperation` routing** [PROPOSED helper]:
- before taking any lock, `SELECT op_type` (immutable) without a lock;
- recordings with `succeeded` → call the function (intent-first);
- recordings with `outcome_unknown` → the existing path (op lock, then the case).
- So the generic op-first lock is never held when the intent-first function runs.

### 3.4 Finalisation rule [PROPOSED addition to `intents_safety_guard`; INVOKER]

An intent moves `payment_captured → confirmed` only if:
- the deterministic latest recording (§3.6) is `succeeded`;
- its `settled_evidence_id IS NOT NULL`;
- its `result_ref = NEW.offline_charge_id`;
- (D1 era) no active hold for it.

The `repo.js` event guard mirrors this [PROPOSED helper]. The generic planner (`succeeded` / `resultRef`) can therefore never finalise an unproven row.

### 3.5 Serialising evidence writers [PROPOSED]

A `NOT EXISTS` conflict check alone cannot see a concurrent, uncommitted evidence insert. Both writers therefore take `pg_advisory_xact_lock(hashtext('booking.recording_evidence'), hashtext(intent_id::text))`:
- `record_provider_evidence` for kind `hostaway_offline_charges` (a **modification**, scoped to that kind);
- the link and completion functions.

The conflict check then runs after the lock, so a conflicting evidence row either committed before (and is seen, giving a refusal) or waits until the link commits. A later conflicting evidence row cannot change an existing link (0008). That evidence surfaces through D1 (§4) as a conflict for the owner, not as an automatic reversal.

Key space: a distinct first key from the accepted per-listing claim lock (`hashtext('booking.inventory_claims')`).

### 3.6 Deterministic latest recording [PROPOSED]

- "Latest" = the maximum attempt number parsed from the **immutable** `idempotency_key` (`och:<intent>:<n>`), then `created_at`, then `id`.
- `source_version` is mutable today (0004 guard). It is frozen for recordings by §3.1 but not used for ordering.

### 3.7 D2-only refusal surfacing

There is no hold table in the D2 era. Refusals surface through existing paths only:
- a completion refusal → the worker calls `completeOperation(outcome_unknown)` → the existing `OFFLINE_CHARGE_OUTCOME_UNKNOWN` case;
- a link refusal on an owner-resolved row → the row stays `succeeded` without a link, finalisation stays blocked by §3.4, and the owner sees it through the documented read-only query (latest recording `succeeded` with a NULL link).

There is **no** hold function in the D2 era, and no dispatch worker exists in it (still HOLD).

### 3.8 Inherited rows

- **`payment_captured` + succeeded without a link:** blocked from finalisation until linked or owner-handled.
- **Already `confirmed` + succeeded without a link** (finalised before the migration): §3.4 does not revisit them. Paid and confirmed truth is kept.
  - `link_recording_evidence` may still attach proof later (`owner_historical`).
  - D1 adds visibility-only holds for them (§4.1). Nothing reverses the state.

### 3.9 Migration 0010 rollback contract [PROPOSED]

**Down precondition, checked first; RAISE if violated:** no recording row has `settled_evidence_id IS NOT NULL`, and none is in `in_flight | succeeded | outcome_unknown | escalated` (no progress beyond `pending`).

- Only then drop the trigger rules, then the functions, then restore `record_provider_evidence`.
- So a downgrade can never silently re-enable unproven finalisation after linked or completed recordings exist.
- Disposable local DBs only; no live rollback.

---

## 4. D1 (second): durable case-only holds

### 4.1 Reasons

| Reason | Target row at creation | Intent states |
|---|---|---|
| `PREFLIGHT_EXHAUSTED` | key attempt 1, `pending`, `dispatched_at` NULL, `attempts 0` | `payment_captured` |
| `PREFLIGHT_CONFLICT_MARKER` / `_LOOKALIKE` / `_SAME_AMOUNT` | same + a cited assessment with that outcome | `payment_captured` |
| `ATTEMPT_GT1` | key attempt > 1, `pending` | `payment_captured` |
| `SUCCEEDED_UNPROVEN` | `succeeded`, NULL link | `payment_captured` **or `confirmed`** (inherited; visibility only, §3.8) |

### 4.2 Tables [PROPOSED; no app INSERT / UPDATE / DELETE; RLS deny by default; app + admin SELECT]

**`recording_holds`:**
- `id` (PK, pre-allocated by the function);
- `operation_id`, `intent_id`, `reason`;
- `op_state_at_hold`, `op_key_at_hold`, `intent_version_at_hold`;
- `assessment_id` (nullable), `case_id NOT NULL → reconciliation_cases(id)`;
- `epoch int`, `created_at DEFAULT statement_timestamp()`, `created_by_worker text`;
- `released_at`, `release_decision`, `release_resolution_id`.

Constraints and guard:
- `UNIQUE (operation_id) WHERE released_at IS NULL`;
- guard: identity frozen; release columns set NULL → value once, by privileged code only; no delete.

**`recording_assessments`:** see §4.4.

### 4.3 Claim fence [PROPOSED; SECURITY DEFINER trigger on `pending → in_flight` for recordings, like 0007 / 0009]

It refuses unless all of these hold:
- intent `FOR SHARE` in `payment_captured`, `captured_minor = final_total_minor`;
- payload reservation = `hostaway_reservation_id`; payload amount = `captured_minor`;
- key attempt 1 and `offline_charge_attempts = 0`;
- deterministic latest recording;
- `OLD.attempts = 0`, `OLD.dispatched_at IS NULL`;
- **no active hold for the op**, and (fail-closed, §4.5) **no open `OFFLINE_CHARGE_HOLD_%` case for the intent**.

`claimNextOperation` mirrors this as `RECORD_FENCE` in both stages [PROPOSED helper].

Lock behaviour:
- The **helper path is intent-first and serialized**.
- A **direct app UPDATE** takes the op row lock first and then the trigger's intent share lock (op → intent). Against `applyEvent` (intent NO KEY UPDATE, then op SHARE in `inTx`), that can deadlock. PostgreSQL aborts one side with **40P01: a bounded, retryable failure, never a fence bypass** (the accepted 0007 stance).

### 4.4 Assessments: identity, deduplication, epochs [PROPOSED]

**`recording_assessments`** columns:
- `id`, `operation_id`, `intent_id`;
- `phase`, `outcome`, `code`;
- `identity_read_op`, `list_read_op`, `identity_evidence`, `list_evidence`;
- `epoch`, `intent_version`, `worker`, `module_version`, `recorded_at DEFAULT statement_timestamp()`.

**One assessment = one read opportunity:**
- `UNIQUE (identity_read_op) WHERE identity_read_op IS NOT NULL`;
- `UNIQUE (list_read_op) WHERE list_read_op IS NOT NULL`.
- A read row can be counted in **at most one** assessment, so repeating an assessment without a new read is refused (unique violation). An incomplete read is still a read row: it cites `list_read_op` with no `list_evidence`.

**Allowed combinations** (CHECK):

| Phase | Outcome | Required |
|---|---|---|
| preflight | `eligible` | both reads `succeeded`; `identity_evidence` (kind `hostaway_reservation`) and `list_evidence` (`hostaway_offline_charges`) of exactly those reads |
| preflight | `conflict_marker` / `conflict_lookalike` / `conflict_same_amount` | list read `succeeded` + `list_evidence` |
| preflight | `incomplete` | list read terminal; **no** `list_evidence` |
| preflight | `identity_refused` | identity read terminal; no list read |
| confirm | `confirm_ok` | list read `succeeded` + `list_evidence` |
| confirm | `confirm_zero` / `confirm_multiple` / `confirm_mismatch` | list read `succeeded` + `list_evidence` |
| confirm | `confirm_incomplete` | list read terminal; no `list_evidence` |

**`record_recording_assessment(p_op, p_worker, p_phase, p_outcome, p_code, p_identity_read, p_list_read, p_identity_evidence, p_list_evidence, p_expected_version, p_module_version)`** (SECURITY DEFINER; app EXECUTE). Locks: intent `FOR SHARE` → `intent_work FOR SHARE` → op `FOR SHARE`. Checks:
- the version;
- `work_worker_id = p_worker` with a live work lease (DB clock);
- reads: same intent, the right types, `created_at ≥` the recording's `created_at`, terminal;
- for preflight, also `created_at ≥` the current epoch start;
- preflight only while the op is `pending` and undispatched;
- confirm only while the op is `in_flight` with `lease_worker_id = p_worker` and a live op lease.

**[TRUST]** that the outcome is the correct pure classification. It is recorded with the module version for audit.

**Epochs and bounds:**
- `epoch` = the number of **released** PREFLIGHT_* holds for the op at insert time (computed under the op lock).
- The exhaustion bound counts **only the current epoch**: non-eligible preflight assessments ≥ 3.
- An owner `release_for_initial_send` starts a new epoch (§4.6), so a lifetime count never re-trips immediately.

### 4.5 Hold creation [PROPOSED]

```
booking.open_recording_hold(p_op uuid, p_worker text, p_reason text, p_expected_version int,
                            p_assessment uuid DEFAULT NULL) RETURNS uuid   -- SECURITY DEFINER; EXECUTE: mv_booking_app
```

**Order (all-or-nothing):**
1. Pre-allocate `hold_id` and `case_id` (`gen_random_uuid()`).
2. Locks: intent `FOR SHARE` → `intent_work FOR SHARE` → op `FOR UPDATE`.
3. Re-check **current** state under the locks:
   - op type and intent binding;
   - the intent state allowed for the reason (§4.1), and `version = p_expected_version`;
   - work lease owned by `p_worker` (DB clock), **except** `SUCCEEDED_UNPROVEN` on a `confirmed` intent, where no work lease exists;
   - the per-reason row state;
   - `EXHAUSTED`: the current-epoch count ≥ 3;
   - conflict reasons: `p_assessment` belongs to this op, current epoch, matching outcome.
   - **[TRUST]** listing scope config is worker-side; the DB checks only that the intent belongs to the row.
4. Idempotency:
   - an active hold for `p_op` with the same reason → return its id;
   - a different reason → `HOLD_ALREADY_ACTIVE`.
5. **INSERT the case first**: `id = case_id`, `kind 'OFFLINE_CHARGE_HOLD_'||reason`, `opened_by 'recording-hold:'||hold_id`, evidence `{operationId, reason, opKey, intentVersion, assessmentId, epoch}`. Then **INSERT the hold** with `case_id`. The immediate FK is satisfied.
6. A **pre-existing open case of the same kind** for the intent → raise `CASE_KIND_OCCUPIED`; the whole transaction rolls back.
   - This should be impossible by design. Hold kinds can only be inserted by these functions (a cases INSERT guard refuses `OFFLINE_CHARGE_HOLD_%` from non-privileged inserts). A migration precondition requires no such open cases. At most one non-terminal recording exists per intent.
   - **The claim block is still preserved:** the fence (§4.3) also refuses while **any** open `OFFLINE_CHARGE_HOLD_%` case exists for the intent. The operational outcome is "blocked and visible through the existing case", and the worker reports the raise.

**Race: hold vs claim** (same row):
- claim first: the hold waits on the op lock, then sees `in_flight` → `HOLD_TARGET_NOT_PENDING`, rollback;
- hold first: the claim skips (SKIP LOCKED) or the trigger refuses after the hold commits.

### 4.6 Owner resolution [PROPOSED]

```
booking.admin_resolve_recording_hold(p_hold uuid, p_decision text, p_evidence uuid[], p_assessment uuid,
                                     p_resolver text, p_justification text, p_at timestamptz)
  RETURNS uuid      -- SECURITY DEFINER; EXECUTE: mv_booking_admin only
```

Also proposed: `admin_close_case` refuses `opened_by LIKE 'recording-hold:%'`.

Locks: intent `FOR SHARE` → op `FOR UPDATE` → hold `FOR UPDATE` → case.

| Decision | Allowed | Effect on hold / case | Other effect |
|---|---|---|---|
| `release_for_initial_send` | PREFLIGHT_* only; row `pending`, undispatched, attempt 1 | hold released; case resolved; **new epoch starts** | `p_assessment` must be preflight `eligible` in the **held** epoch, for **this op**, at `intent_version = hold.intent_version_at_hold = current version`, with both reads `created_at > hold.created_at` and `list_evidence.observed_at ≥ statement_timestamp() − 10 min`. Stale reads recorded after the hold are refused. |
| `recorded_manually` | PREFLIGHT_*, `ATTEMPT_GT1` | released; case resolved `recorded` | row `pending → superseded` (an existing move). The intent stays `payment_captured`. Owner finalisation is **outside authorization**. |
| `link_full_proof` | `SUCCEEDED_UNPROVEN` | released; case resolved `recorded` | attaches the link through §3.2 (`owner_historical`) in the same transaction |
| `keep_visible` | any | **hold stays active; case stays open** | inserts only a resolution row (owner acknowledgement) |

**Hold release gates finalisation as well as claiming:**
- §3.4 and the claim fence both require no active hold.
- `link_recording_evidence` (app) **refuses while a hold is active**. While held, only the owner's `link_full_proof` can attach proof.

**Serial outcomes, link vs owner resolution** (no "exactly one ever"):
- owner `admin_resolve_operation(succeeded)` first → the row is `succeeded` without a link → the app link may then attach full proof (intended), unless a `SUCCEEDED_UNPROVEN` hold is active;
- an app link before the owner → refused (the row is not `succeeded`).

**`ATTEMPT_GT1`:** no automation release, ever.

---

## 5. Locks: summary

| Path | Order | Contention outcome |
|---|---|---|
| `claimNextOperation` + fence | intent SHARE → op UPDATE (SKIP LOCKED) | serialized |
| direct app `UPDATE … in_flight` | op UPDATE → (trigger) intent SHARE | vs `applyEvent`: possible 40P01 (bounded, retryable, no bypass) |
| complete / link / hold / assessment functions | intent SHARE → intent_work SHARE → op → advisory evidence lock → tables | serialized among themselves and with the helper claim |
| `record_provider_evidence` (offline kind) | read op UPDATE → advisory evidence lock | the advisory lock serializes with link / complete only. Read rows are distinct from recording rows, so there is no op-lock inversion. |
| `applyEvent` (`inTx`) | intent NO KEY UPDATE → op SHARE | serialized with the share-lockers (waits) |
| `admin_resolve_operation` | op UPDATE → intent (no lock) | no deadlock with the share-lockers; the proposed INVOKER trigger reads the intent **without** a lock on this path |
| `completeOperation(outcome_unknown)` / `markUnknown` | op UPDATE → case INSERT | unchanged |
| `recoverExpiredOperations` | (phase-guarded) intent SHARE → op | vs completion: the op lock serializes; the loser sees a changed state and refuses |

**Post-wait lease expiry:** every function re-checks leases with `statement_timestamp()` **after** acquiring its locks, so a lease that expired while waiting is refused.

---

## 6. DB-attested vs trusted

| DB-attested (persisted bindings; DB clock where stated) | [TRUST] |
|---|---|
| evidence kind / source / status; read type / state / intent / selector; `observed_at = read.completed_at` (equality) | that the read ran against Hostaway, and `observed` is its true content |
| operation window: read created / dispatched ≥ recording; observed > dispatched | that the caller-supplied `dispatched_at` / `completed_at` / `lease_until` reflect real time (only consistency and no-future-vs-DB-clock are checked) |
| amount = payload = captured = total; currency; listing; exact title / marker; count 1; ids = result | that `executorAccountRef` / client labels are the same real credential and account |
| method ∈ approved set | that the method equals the configured owner choice |
| lease ownership and version under locks (DB clock compared with stored caller-computed leases) | the pure assessment's classification (stored with its module version) |

---

## 7. Phase / owner-case table

| Situation | Row | D2-only era | D1 era | Public |
|---|---|---|---|---|
| preflight non-eligible < 3 (epoch) | pending | — (no worker) | record assessment | confirmed |
| preflight bound / conflict | pending | — | hold PREFLIGHT_* | confirmed |
| attempt > 1 | pending | — | hold ATTEMPT_GT1 (claim already fenced) | confirmed |
| claimed, any failure | in_flight | `outcome_unknown` + existing case | same | confirmed |
| confirm OK | in_flight | `complete_recording_with_evidence` → `RECORDED` | same, plus no active hold | confirmed |
| owner-resolved count-only / dashboard | succeeded, no link | finalisation blocked; owner sees it through a read-only query | link or hold `SUCCEEDED_UNPROVEN` | confirmed |
| inherited, already confirmed, no link | succeeded | unchanged | visibility hold `SUCCEEDED_UNPROVEN` (no state change) | confirmed |

---

## 8. Change map and rollback [PROPOSED; not applied]

**Migration 0010 (D2), up:**
1. `recording_proof_refusal`;
2. `zz0_recording_lifecycle_guard` (INVOKER);
3. `complete_recording_with_evidence`, `link_recording_evidence`;
4. the `record_provider_evidence` advisory lock for kind `hostaway_offline_charges`;
5. the `intents_safety_guard` finalisation rule;
6. app EXECUTE on 3 only; `REVOKE FROM PUBLIC` on all.

Down: §3.9 precondition, then the reverse order.

**Migration 0011 (D1), up:**
1. the tables + guards + RLS;
2. `record_recording_assessment`, `open_recording_hold`, `admin_resolve_recording_hold`;
3. the claim fence;
4. the cases INSERT guard;
5. `admin_close_case` refusal;
6. the finalisation and link "no active hold" additions;
7. grants.

Precondition (up): no open `OFFLINE_CHARGE_HOLD_%` cases. Down: precondition no holds and no assessments; else RAISE.

**Helpers:**
- `completeOperation` routing (op_type looked up before locks);
- `RECORD_FENCE` in the claim helper;
- the `repo.js` finalisation mirror.

---

## 9. Planned test matrix (PLANNED; not implemented or run)

| # | Scenario | Expect |
|---|---|---|
| T1 | app INSERT of a recording with `settled_evidence_id` / `result_ref` / `completed_at` / `dispatched_at` pre-set | refused (pre-seed) |
| T2 | app UPDATE on a pending recording setting `settled_evidence_id` | refused |
| T3 | linked row: app UPDATE of `result_ref` / `completed_at` / `dispatched_at` / `source_version` / `late_result_*` (same state) | refused |
| T4 | the trigger validates `NEW`: an UPDATE changing `result_ref` and attaching a link in one statement is validated against NEW (a test where OLD would pass and NEW fails, and vice versa) | NEW governs |
| T5 | app direct UPDATE `→ succeeded` with a valid link; inside an unrelated granted SD function (`record_provider_evidence` context) | refused / not reachable |
| T6 | `completeOperation(succeeded)` for a recording | routed; no generic success |
| T7 | `complete_recording_with_evidence` happy path; each §3.2 field wrong individually; another intent / op / reservation; one read reused | succeeded + link atomically / refused, nothing changed |
| T8 | future evidence (`observed_at > statement_timestamp()`), future `dispatched_at`, `observed_at ≤ dispatched_at`, stale for `worker_fresh` (> 10 min), owner proof < 15 min | refused; owner proof years old: accepted |
| T9 | `observed_at ≠ read.completed_at` (crafted); read created before the recording | refused |
| T10 | post-wait lease expiry (the lock is held, the lease expires while waiting) | refused under the DB clock |
| T11 | concurrent conflicting evidence insert vs link (observed advisory-lock wait, both orders) | conflict seen → refused, or link first then conflict surfaced later; never a silent link |
| T12 | `payment_captured → confirmed` without a link / with a mismatched id / with an active hold | refused by the DB |
| T13 | owner `admin_resolve_operation(succeeded)` with **dashboard** count-1 evidence, then app link with full API proof ≥ 15 min / count-only | linked → finalise / stays unlinked (D1: hold) |
| T14 | already-confirmed legacy row without a link | no state change; D1 visibility hold allowed; link allowed |
| T15 | every claim path with an active hold: helper generic / `opId` / intent / direct UPDATE | refused or skipped |
| T16 | direct UPDATE claim vs `applyEvent` contention | 40P01 on one side; the fence never bypassed |
| T17 | concurrent hold vs claim (both orders, observed lock waits) | §4.5 outcomes |
| T18 | hold-before-case FK: function order (case first) succeeds; a simulated reversed order fails | as designed |
| T19 | `CASE_KIND_OCCUPIED` (a fake pre-existing case inserted as the owner) | raise; the claim stays fenced by the intent-level case check |
| T20 | duplicate assessment (same read twice); repeat without a new read; disallowed phase / outcome combinations | refused |
| T21 | epoch: 3 non-eligible → hold; release with a fresh eligible assessment → new epoch, count 0; release citing stale reads (created before the hold) or another op / version | accepted / refused |
| T22 | `keep_visible` | hold active, case open, claim still fenced |
| T23 | active hold + app `link_recording_evidence` / finalise | refused; only `link_full_proof` attaches |
| T24 | `ATTEMPT_GT1` `release_for_initial_send` | refused |
| T25 | app INSERT of an `OFFLINE_CHARGE_HOLD_%` case; app writes to the hold / assessment tables; `admin_close_case` on a hold case | refused |
| T26 | 0010 down with linked or progressed recordings; 0011 down with holds | RAISE; empty → reverse order OK |
| T27 | every test: no public-state change, no ESCALATE / notify / void / cancel / refund rows; `dispatched_at` untouched by holds | asserted |

---

## 10. Resolution map (root HOLD on e772987)

| # | Item | Where |
|---|---|---|
| 1 | Full lifecycle invariants (INSERT pre-seed, every UPDATE, relabel); NEW-row validation; INVOKER authorization; SD validators read only | §1.2, §2, §3.1–§3.3 |
| 2 | Caller-supplied times corrected; non-null dispatch; no future vs the DB clock; worker-fresh vs owner-historical; read intent / selector / completion-time equality; operation window; trust limits | §1.2, §1.3, §3.2, §6 |
| 3 | Assessment uniqueness per read; allowed combinations; worker / lease / version checks; epochs and reset; fresh release evidence bound to held op / version / epoch | §4.4, §4.6 |
| 4 | Pre-allocated ids, case first; `keep_visible` stays active; D1 lease / version / scope limits; occupied-kind outcome with the claim block preserved | §4.5, §4.6 |
| 5 | Hold gates finalisation and app link; honest serial link-vs-owner outcomes; already-confirmed inherited rows | §3.4, §3.8, §4.1, §4.6 |
| 6 | Direct UPDATE inversion → bounded 40P01; routing before locks; deterministic latest; advisory serialization of evidence writers; D2-only surfacing | §3.3, §3.5–§3.7, §4.3, §5 |
| 7 | Rollback preconditions (no silent re-enable) | §3.9, §8 |
| 8 | Admin succeeded accepts dashboard evidence (present) vs the stricter proposed API link; D2 first; ≥ 15 min owner proof | §1.3, header |

**Unresolved and outside authorization:**
- owner manual finalisation after `recorded_manually`;
- the configured `paymentMethod`;
- persisting an account ref at create;
- live gates E1–E7 / P1.

**Minimal next slice after re-review: D2 only.** That is migration 0010, the `completeOperation` routing helper, the `repo.js` mirror, and tests T1–T13, T26 (0010 part) and T27.
