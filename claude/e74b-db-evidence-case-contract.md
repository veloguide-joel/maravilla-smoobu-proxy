# E7.4b D1 / D2: DB evidence-link and owner-case contract (DESIGN ONLY)

- **Branch:** `feature/e7-offline-charge-db-contract`, cut from the accepted head `4f6b27f6ee4b37b44147adc980ec697677abdb09` (E7.4b-0 pure foundation, accepted offline).
- **This document is a proposal.** Every migration, function, trigger, grant and helper change below is **PROPOSED ONLY**. Nothing here is applied, executable or authorized.
- **Unchanged and still open:** worker / adapter / dispatch stay on **HOLD**; live gates E1–E7 / P1; the explicit `paymentMethod` owner choice; no automatic resend or attempt > 1.

Labels used throughout:
- **[PRESENT]** current behaviour at `4f6b27f`, with exact path:line;
- **[PROPOSED]** design.

---

## 1. Present behaviour at 4f6b27f (inspected)

### 1.1 Cases

- **[PRESENT] `booking.reconciliation_cases`** (`db/migrations/0001_booking_core.up.sql:536–551`):
  - columns `id`, `intent_id`, `kind`, `status open|resolved`, `opened_at`, `opened_by` (free text), `evidence` (jsonb), `resolution`, `resolved_by`, `resolved_at`;
  - **unique open case per `(intent_id, kind)`** (`reconciliation_one_open_case`, l.549);
  - no DELETE.
- **[PRESENT] Grants** (`0002_roles_grants.up.sql:23–27`): `mv_booking_app` has **SELECT, INSERT, UPDATE** on `reconciliation_cases` and **SELECT, INSERT, UPDATE** on `external_operations`.
  - `0003_safety_corrections.up.sql:675` revokes UPDATE on cases.
  - `cases_safety_guard` (0003:462–470) refuses every non-privileged case UPDATE.
- **⇒ The app role can already INSERT any case kind directly.** A general case writer already exists through the table grant. This design does **not** widen it, and it does not rely on cases for fencing (§3.2).
- **[PRESENT] `openCase`** (`lib/booking-db/operations.js:29–34`) inserts with `ON CONFLICT (intent_id, kind) WHERE status='open' DO NOTHING`.
  - If an open case of the same kind already exists for the intent, a **second operation's** case is silently dropped.
  - Today one open recording per intent (0001:396–397) prevents two simultaneous recording cases. This design keeps D1 kinds distinct and makes conflicts **raise**, never silently drop (§3.4).
- **[PRESENT] `admin_close_case`** (0003:640–656) refuses cases with `opened_by LIKE 'op:%'` (`OPERATION_CASE_USE_ADMIN_RESOLVE_OPERATION`). Other cases it closes with `no_action`.

### 1.2 Operations

- **[PRESENT] `external_operations_guard`** (0001:399–428):
  - identity columns are immutable;
  - allowed moves: `pending → in_flight | superseded | escalated`; `in_flight → succeeded | failed_definite | outcome_unknown | escalated`; for non_idempotent, no `in_flight → pending` and no `outcome_unknown → pending`; `outcome_unknown | escalated → succeeded | failed_definite`.
- **[PRESENT] `external_operations_safety_guard`** (0004:74–112):
  - `resolution_id` is set by privileged code only;
  - a recording INSERT is refused unless every earlier recording is owner-resolved or catalogued `failed_definite`;
  - `outcome_unknown | escalated` move only when privileged;
  - a non_idempotent row reaches `in_flight → failed_definite` only with a catalogued code (the catalogue is empty).
  - **No rule on `→ succeeded` for recordings.**
- **[PRESENT] Claim fences:**
  - `capture_claim_fence` (0007:7–21) and `void_cancel_claim_fence` (0009:11–37) are BEFORE UPDATE triggers on `pending → in_flight`. They `SELECT … FROM intents FOR SHARE` and raise on refusal, so **every** claim path is fenced, including a direct UPDATE.
  - **There is no recording fence.**
  - `claimNextOperation` (operations.js:74–108): an unlocked candidate, then intent `FOR SHARE`, then op `FOR UPDATE SKIP LOCKED` with the same fences in SQL; it sets `in_flight`, `attempts + 1`, `dispatched_at`, lease.
- **[PRESENT] `completeOperationOnce`** (operations.js:149–177):
  - op `FOR UPDATE` only (no intent lock); the lease is checked against the **caller's** `now`;
  - `succeeded` sets `result_ref`;
  - `outcome_unknown` → `markUnknown` (l.179–205); for non_idempotent rows that opens `<KIND>_OUTCOME_UNKNOWN` with `opened_by 'op:<id>'`.

### 1.3 Evidence and settlement

- **[PRESENT] `settled_evidence_id`** (0004:26; FK → `provider_evidence`).
  - Its only runtime writer is `settle_operation_from_evidence` (0005:239–289), **reconcile_first only**.
  - It is immutable once set (`0008_settled_evidence_immutable.up.sql`: `zz_` trigger; NULL → id allowed once; clear or repoint refused for every role).
- **[PRESENT] `provider_evidence`:**
  - append-only (0003:73–76);
  - `read_operation_id UNIQUE`, so one evidence row per read (0003:61);
  - API evidence only via `record_provider_evidence` (0003:474–506), from a **succeeded** read of the matching type, `external_ref` = the read's selector, `observed_at` = the read's `completed_at`;
  - `validate_evidence` (0005:173–…) requires, for `hostaway_offline_charges`, only `status listed`, `matchingChargeCount` and the ids array.
- **[PRESENT] `admin_resolve_operation`** (0005:296–384, `mv_booking_admin` only):
  - for a recording, `succeeded` needs API evidence ≥ dispatch + 15 min with count 1 and id = result. `failed_definite` needs API **and** dashboard count 0.
  - It sets `state`, `result_ref`, `resolution_id` and resolves the `op:<id>` case.
  - **It never sets `settled_evidence_id`.** It locks the op `FOR UPDATE` first and reads the intent without a lock.
- **[PRESENT] E3 success guard** (`lib/booking-db/repo.js:286–290`): `OFFLINE_CHARGE_RECORDED` needs only the latest recording `succeeded` with `result_ref = chargeId`.
- **[PRESENT] DB:** no intent-row rule ties `payment_captured → confirmed` to evidence (`intents_safety_guard`, 0004:114–…, has no recording rule).
- **[PRESENT] Work lease:** `booking.intent_work` (0001:252–258): `work_worker_id`, `work_lease_until`, checked by workers in application code.
- **[PRESENT] `is_privileged()`** (0003:15–17): true only inside schema-owner SECURITY DEFINER functions or for the owner.

---

## 2. Design principles

1. **Paid truth is never weakened.**
   - Nothing here changes `payment_captured` / `confirmed` / public "confirmed", sends `ESCALATE`, or creates void / cancel / refund / notify rows.
   - **No row is ever moved to "possibly sent" just to raise an alert:** `dispatched_at` is untouched, and there is no fake send and no fake `outcome_unknown`.
2. **Fail closed by construction.** A hold must **block every claim path**, including a generic or direct UPDATE, through a trigger, never only a convention.
3. **Narrow surfaces.** Each new function serves recordings only. No general case writer is added for the app role. No change applies to other op types.
4. **Intent-first lock order** everywhere new: `intents` → `intent_work` → `external_operations` → (read-only) `provider_evidence` → new tables → `reconciliation_cases`.
5. **The DB checks facts; workers are trusted for provenance.** The DB can verify bindings between persisted rows. It **cannot** attest that an external call happened, which real credential served it, or that a pure assessment ran correctly (§5.3).

---

## 3. D1: durable case-only hold for recordings

### 3.1 Reasons (closed set)

| Reason | Target row (state at creation) | Who may create | Blocks |
|---|---|---|---|
| `PREFLIGHT_EXHAUSTED` | initial recording, `pending`, `dispatched_at` NULL, `attempts 0`, key `och:{intent}:1` | app (worker) via function | claim |
| `PREFLIGHT_CONFLICT_MARKER` / `_LOOKALIKE` / `_SAME_AMOUNT` | same | app via function, citing a persisted assessment with that outcome (§3.5) | claim |
| `ATTEMPT_GT1` | a recording `pending`, key suffix > 1 | app via function (and later by the intrinsic fence, §3.3) | claim (always; no automation resend) |
| `SUCCEEDED_UNPROVEN` | a recording `succeeded` with `settled_evidence_id` NULL (an owner resolution with count-only evidence, or a legacy row) | app via function | the E7.4b finalisation path (§4.4); never reverses the owner's resolution |

### 3.2 Representation [PROPOSED]

**New table `booking.recording_holds`** (no app INSERT / UPDATE / DELETE grant; written only through SECURITY DEFINER functions; append-only except for release columns set by the owner function):

| Column | Meaning |
|---|---|
| `id uuid PK` | |
| `operation_id uuid NOT NULL → external_operations(id)` | target recording |
| `intent_id uuid NOT NULL` | must equal the operation's intent (checked) |
| `reason text NOT NULL CHECK (reason IN (…§3.1…))` | |
| `op_state_at_hold text NOT NULL`, `op_key_at_hold text NOT NULL`, `intent_version_at_hold int NOT NULL`, `source_version int NOT NULL` | immutable binding |
| `assessment_id uuid NULL → recording_assessments(id)` | required for the conflict reasons |
| `case_id uuid NOT NULL → reconciliation_cases(id)` | |
| `created_at timestamptz NOT NULL DEFAULT statement_timestamp()` | DB clock |
| `released_at`, `release_decision`, `release_resolution_id` | owner function only |

- Unique **one active hold per operation**: `UNIQUE (operation_id) WHERE released_at IS NULL`.
- Guard trigger: identity columns are immutable; release only by privileged code; no delete.

**Why a table and not the case alone:** the app can already INSERT cases (§1.1), so a case cannot be a trustworthy claim fence. The hold row is the fence; the case is the **visibility**.

**Why not `pending → escalated`** (the existing guard already allows it for the app):
- it would discard the "never dispatched, still pending" truth;
- from `escalated` only `→ succeeded | failed_definite` remain, so an owner could never release an attempt-1 row back to automation;
- `admin_resolve_operation(failed_definite)` would then demand API + dashboard absence for a row that provably was never sent.
- **Rejected.**

### 3.3 Claim fence [PROPOSED; future migration 0010]

`booking.recording_claim_fence()` is a BEFORE UPDATE trigger, `WHEN (OLD.state='pending' AND NEW.state='in_flight' AND NEW.op_type='hostaway.record_offline_charge')`, SECURITY DEFINER, VOLATILE, `REVOKE … FROM PUBLIC`, like 0007/0009. It raises `RECORDING_CLAIM_FENCED:<reason>` unless **all** of the following hold:

| Check | Kind |
|---|---|
| intent `FOR SHARE`: `state = 'payment_captured'`, `captured_minor = final_total_minor` | intrinsic (the §4.1 items of the R2 contract) |
| `NEW.payload->>'reservationId' = hostaway_reservation_id`; `(NEW.payload->>'amountMinor')::bigint = captured_minor` | intrinsic |
| key = `'och:'||intent_id||':1'` and `offline_charge_attempts = 0` (initial attempt only) | intrinsic |
| the row is the latest recording of the intent | intrinsic |
| `OLD.attempts = 0`, `OLD.dispatched_at IS NULL` | intrinsic |
| **NOT EXISTS active `recording_holds` for `NEW.id`** | D1 |

Notes:
- Each check is evaluated in a fresh READ COMMITTED snapshot inside the trigger (VOLATILE plpgsql), so a hold committed before the claim's row lock is granted is seen.
- `claimNextOperation` gets a matching SQL `RECORD_FENCE` in both stages, to skip fenced rows instead of raising. That is a helper change, **PROPOSED**.
- Worker-specific checks (scope, work lease, planned version, evidence freshness) stay in the worker (R2 §4.2). The trigger does not pretend to know them.

### 3.4 Hold creation [PROPOSED]

```
booking.open_recording_hold(p_op uuid, p_reason text, p_expected_version int,
                            p_assessment uuid DEFAULT NULL, p_detail jsonb DEFAULT '{}') RETURNS uuid
  SECURITY DEFINER; EXECUTE granted to mv_booking_app only.
```

All-or-nothing, in one transaction:
1. `SELECT … FROM intents WHERE id = (SELECT intent_id FROM external_operations WHERE id = p_op) FOR SHARE`. The op's `intent_id` is immutable (0001 guard).
2. `SELECT … FROM external_operations WHERE id = p_op FOR UPDATE`. This waits for any in-progress claim of this row.
3. Re-check **current** state under the locks:
   - op type is recording; `intent_id` matches; intent state `payment_captured`; `intent.version = p_expected_version`;
   - per-reason row state (§3.1):
     - PREFLIGHT_* rows: still `pending`, `dispatched_at` NULL, `attempts 0`, key `:1`, latest recording;
     - `ATTEMPT_GT1`: `pending` with key suffix > 1;
     - `SUCCEEDED_UNPROVEN`: `succeeded` with `settled_evidence_id` NULL;
   - `PREFLIGHT_EXHAUSTED`: the persisted non-eligible assessment count for this op ≥ `MAX_PREFLIGHT_ATTEMPTS` (§3.5);
   - conflict reasons: `p_assessment` belongs to this op and intent, phase `preflight`, with the matching outcome;
   - `p_detail`: a small jsonb of codes and ids only (size-checked; no free text).
4. **Idempotency:**
   - an active hold for `p_op` with the **same reason** returns its id (no new rows);
   - an active hold with a **different reason** raises `HOLD_ALREADY_ACTIVE`.
5. INSERT the hold, then INSERT the case:
   - `kind = 'OFFLINE_CHARGE_HOLD_' || p_reason`;
   - `opened_by = 'recording-hold:' || hold_id`;
   - `evidence = {operationId, reason, opKey, intentVersion, assessmentId}`.
6. If an **open case of the same kind** already exists for the intent (necessarily for another hold or an app-inserted fake): **raise** `CASE_KIND_OCCUPIED` (no `ON CONFLICT DO NOTHING`), so it rolls back. D1 kinds never collide with `OFFLINE_CHARGE_OUTCOME_UNKNOWN`, so a hold cannot suppress an unknown case and vice versa.
7. Any refusal raises and the whole transaction rolls back: no hold, no case.

**Spoofing:** a proposed INSERT guard on `reconciliation_cases` refuses kinds `OFFLINE_CHARGE_HOLD_%` from non-privileged inserts. An app-inserted fake case could not fence anyway (the fence reads `recording_holds`); this only stops misleading visibility.

**Race: hold vs claim** (same row):
- **Claim first.** The claim holds the intent share lock and the op row lock. The hold's step 2 waits. After the claim commits, the hold re-reads `in_flight` → `HOLD_TARGET_NOT_PENDING` → rollback. The worker then has a normal in-flight row, governed by `outcome_unknown` / case.
- **Hold first.** The hold commits while holding the op row. The claim's stage 2 `SKIP LOCKED` skips it, or after the commit the trigger sees the hold and raises; the claim transaction rolls back. A direct `UPDATE … SET state='in_flight'` is refused by the same trigger.
- Both take the intent `FOR SHARE` (compatible) before the op row lock. No lock-order inversion; no deadlock between the two.

**Race: hold vs E3 transition** (`applyEvent` takes intent `FOR NO KEY UPDATE`): the hold waits on, or blocks, the transition. The version re-check refuses a stale hold.

### 3.5 Durable preflight / confirm bounds [PROPOSED]

Raw read-row counts cannot tell *why* a read was not eligible. The worker therefore persists its **classified pure-assessment outcome**.

**`booking.recording_assessments`** (insert-only; no app UPDATE / DELETE; written only through the function below):
- `id uuid PK`, `operation_id`, `intent_id`;
- `phase text CHECK (phase IN ('preflight','confirm'))`;
- `outcome text CHECK (outcome IN ('eligible','incomplete','identity_refused','conflict_marker','conflict_lookalike','conflict_same_amount','confirm_ok','confirm_zero','confirm_multiple','confirm_mismatch','confirm_incomplete'))`;
- `code text CHECK (booking.is_code(code))`: the pure module's refusal code;
- `identity_read_op uuid NULL`, `list_read_op uuid NULL`, `evidence_id uuid NULL`;
- `intent_version int`, `module_version text` (e.g. `offline-charge-proof-v1`);
- `recorded_at timestamptz DEFAULT statement_timestamp()`.

**Function** `booking.record_recording_assessment(p_op, p_phase, p_outcome, p_code, p_identity_read, p_list_read, p_evidence, p_expected_version, p_module_version) RETURNS uuid`:
- SECURITY DEFINER; app EXECUTE;
- locks intent `FOR SHARE`, then op `FOR SHARE`;
- checks the op is a recording of this intent at `p_expected_version`;
- cited read ops belong to the intent, have the right types (`hostaway.retrieve_reservation` / `hostaway.list_offline_charges`) and were created after the recording row;
- `p_evidence`, if given, is `hostaway_offline_charges` evidence of `p_list_read`;
- phase `preflight` only while the row is `pending` and undispatched; phase `confirm` only while it is `in_flight` under this lease, or after.

**Trust:** the DB verifies these **bindings**. It **cannot** verify that the outcome is the correct classification of the read. That is the worker's trusted pure assessment, recorded with its module version for audit.

**Bounds** (inspectable, durable):
- preflight: `count(*) WHERE operation_id = op AND phase='preflight' AND outcome <> 'eligible'` ≥ `MAX_PREFLIGHT_ATTEMPTS` (3) → `PREFLIGHT_EXHAUSTED` hold;
- confirm: the analogous count bounds the confirm reads; exhaustion ends in `outcome_unknown` → the existing unknown case.

### 3.6 Owner resolution of holds [PROPOSED]

```
booking.admin_resolve_recording_hold(p_hold uuid, p_decision text, p_evidence uuid[], p_result_ref text,
                                     p_resolver text, p_justification text, p_at timestamptz) RETURNS uuid
  SECURITY DEFINER; EXECUTE mv_booking_admin only.
```

`admin_close_case` additionally refuses `opened_by LIKE 'recording-hold:%'` (PROPOSED change).

Locking: intent `FOR SHARE` → op `FOR UPDATE` → hold `FOR UPDATE`. Each decision inserts a `reconciliation_resolutions` row, sets the release columns and resolves the case.

| Decision | Allowed reasons | Effect | Never |
|---|---|---|---|
| `release_for_initial_send` | PREFLIGHT_* only; row still `pending`, undispatched, key `:1` | hold released → the fence allows the claim again. Requires a fresh **eligible** preflight assessment recorded after the hold. | allowed for `ATTEMPT_GT1` / `SUCCEEDED_UNPROVEN` |
| `recorded_manually` | PREFLIGHT_*, `ATTEMPT_GT1` | owner states they recorded it in Hostaway, citing API **full-identity** evidence; the row moves `pending → superseded` (an existing allowed move); intent remains `payment_captured` / public confirmed. Finalising to `confirmed` uses a separately reviewed owner path (`admin_resolve_intent`), out of this scope. | resend; `dispatched_at` change |
| `link_full_proof` | `SUCCEEDED_UNPROVEN` | sets `settled_evidence_id` through the D2 validator (§4.2); the hold is released; the E7.4b finalisation then proceeds | reversal of the owner's earlier resolution |
| `keep_visible` | any | records the owner's acknowledgement; the hold stays active (claim blocked) | — |

**`ATTEMPT_GT1` has no automation decision.** Policy: no automatic resend or new attempt.

---

## 4. D2: atomic, immutable success ↔ full-evidence link

### 4.1 Choice: narrowly extend `settled_evidence_id` (not a new link table)

The existing column already gives:
- the FK to append-only evidence;
- immutability for **every** role (0008: NULL → id once; clear or repoint refused);
- recovery code that knows the field.

A dedicated link table would duplicate all of that and add a second source of truth. The extension is **scoped to `op_type = 'hostaway.record_offline_charge'`**:
- no other op type's semantics change;
- `settle_operation_from_evidence` stays reconcile_first-only.

### 4.2 Validator [PROPOSED]

`booking.recording_evidence_refusal(p_op uuid, p_evidence uuid, p_result_ref text) RETURNS text` (NULL = acceptable). STABLE, SECURITY DEFINER, not granted to the app directly; used by the trigger and the functions below.

The evidence `e` must satisfy **all** of these, each with its own refusal code:
- `e.kind = 'hostaway_offline_charges'`, `e.source = 'hostaway_api'`, `e.status = 'listed'`, `e.intent_id = op.intent_id`;
- `e.read_operation_id` → a read with `op_type = 'hostaway.list_offline_charges'`, `state = 'succeeded'`, `retry_class = 'read'`, created after the recording row;
- `e.external_ref = op.payload->>'reservationId' = intents.hostaway_reservation_id`;
- `e.observed_at > op.dispatched_at` (strict). For owner-linked rows: `≥ dispatched_at + 15 min`, consistent with 0005;
- `observed` has **exactly** the R2 / E7.4b-0 key set (`EVIDENCE_OBSERVED_KEYS`), with:
  - `matchingChargeCount = 1`, `matchingChargeIds = [p_result_ref]`, `chargeId = p_result_ref` (canonical decimal string);
  - `reservationId` = reservation; `listingMapId = intents.listing_id`;
  - `amountMinor = (op.payload->>'amountMinor')::bigint = intents.captured_minor = intents.final_total_minor`;
  - `currency = intents.currency`;
  - `status = 'paid'`, `type = 'charge'`, `paymentProvider = 'offline'`;
  - `paymentMethod IN ('credit_card','other')` (the approved set. The **configured** value is worker config; see §5.3);
  - `title = 'maraVilla payment mvoch1-' || intent_id`, `marker = 'mvoch1-' || intent_id`;
  - `readCount` an integer in 1..500; `executorAccountRef` a label (format only).
- **No other evidence row** for this intent and op window may cite a **different** `chargeId` with this marker. If one does → `EVIDENCE_CONFLICT`, and the result is a hold, not a link.

### 4.3 Atomic completion [PROPOSED]

```
booking.complete_recording_with_evidence(p_op uuid, p_worker text, p_evidence uuid, p_result_ref text,
                                         p_expected_version int) RETURNS text   -- 'succeeded'
  SECURITY DEFINER; EXECUTE mv_booking_app.
```

All or nothing:
1. intent `FOR SHARE`, then `intent_work FOR SHARE`, then op `FOR UPDATE`.
2. Under those locks:
   - intent `payment_captured`, version = `p_expected_version`;
   - `intent_work.work_worker_id = p_worker` and `work_lease_until ≥ statement_timestamp()`;
   - op `in_flight`, `lease_worker_id = p_worker`, `lease_until ≥ statement_timestamp()` (**DB clock**, unlike today's caller clock);
   - key `:1`, `attempts = 1`.
3. `recording_evidence_refusal(...) IS NULL`.
4. `UPDATE … SET state='succeeded', result_ref=p_result_ref, settled_evidence_id=p_evidence, completed_at=e.observed_at, lease cleared`.
5. Any refusal raises, so nothing changes. The worker then calls `completeOperation(outcome_unknown)` → the existing unknown case (never a retry).

**Trigger rule** (PROPOSED addition to `external_operations_safety_guard`, or a new `zz0_recording_success_guard` that runs before 0008's `zz_` trigger). For `op_type = 'hostaway.record_offline_charge'`:
- `OLD.state <> 'succeeded' AND NEW.state = 'succeeded' AND NOT is_privileged()` → **refuse** (`RECORDING_SUCCESS_REQUIRES_FUNCTION`). The supported app path cannot create succeeded-without-link: a direct UPDATE, or the generic `completeOperation(succeeded)`, is refused.
- `OLD.settled_evidence_id IS NULL AND NEW.settled_evidence_id IS NOT NULL` → `recording_evidence_refusal(NEW.id, NEW.settled_evidence_id, NEW.result_ref)` must be NULL, for every role.
- The privileged owner path (`admin_resolve_operation`) may still set `succeeded` **without** a link. The owner's resolution stands, and the row is treated as `SUCCEEDED_UNPROVEN` (§4.4).

**`completeOperation` change** (PROPOSED helper): for recordings, `succeeded` routes to the function. `outcome_unknown` is unchanged.

### 4.4 Finalisation and recovery [PROPOSED]

- **DB rule** (PROPOSED `intents_safety_guard` addition): an intent may move `payment_captured → confirmed` only if
  - the latest recording is `succeeded`;
  - `settled_evidence_id IS NOT NULL`;
  - `result_ref = NEW.offline_charge_id`.

  This makes the generic planner's `OFFLINE_CHARGE_RECORDED` (which trusts `succeeded` / `resultRef`) **unable** to finalise unproven rows. The `repo.js` event guard mirrors it (PROPOSED helper).
- **E7.4b recovery** (worker, later):
  - for `succeeded` + link: apply `OFFLINE_CHARGE_RECORDED` through the R2 §6.2 `inTx` fence. It re-reads the **same** `settled_evidence_id` row and the full binding, plus the planned version and the work lease;
  - for `succeeded` without a link: try `booking.link_recording_evidence(p_op, p_evidence)` (app EXECUTE; same validator; NULL → id only; `state` unchanged; owner-resolved rows also need ≥ 15 min).
    - Success → finalise as above.
    - Refusal, or no qualifying evidence → `open_recording_hold(SUCCEEDED_UNPROVEN)`. The case is visible and the owner's resolution is **not** reversed.
- **Paid state:** in no branch is it escalated. There is no provider write and no generic-planner finalisation.
- **Inherited rows** (`succeeded` without a link from before the migration): the same path; finalisation is blocked by the DB rule until linked or owner-handled.
- **Unknown dispatched recordings** stay owner-only (`admin_resolve_operation`). They are never auto-retried, and never settled by `settle_operation_from_evidence`.

---

## 5. Locks, races and trust

### 5.1 Lock order

| Path | Order | Note |
|---|---|---|
| `claimNextOperation` (+ fences) | intent SHARE → op UPDATE (SKIP LOCKED) | present |
| `open_recording_hold` | intent SHARE → op UPDATE → hold / case INSERT | proposed |
| `record_recording_assessment` | intent SHARE → op SHARE → INSERT | proposed |
| `complete_recording_with_evidence` / `link_recording_evidence` | intent SHARE → intent_work SHARE → op UPDATE → evidence (read) | proposed |
| `admin_resolve_recording_hold` | intent SHARE → op UPDATE → hold UPDATE → case UPDATE | proposed |
| `applyEvent` (`inTx`) | intent NO KEY UPDATE → op SHARE / evidence read | present + proposed `inTx` |
| `admin_resolve_operation` | op UPDATE → intent (plain read, no lock) | **present (op first)** |
| `completeOperation(outcome_unknown)` / `markUnknown` | op UPDATE → case INSERT | present |

**`admin_resolve_operation` is op-first.** It holds the op row and reads the intent without a lock, so it cannot deadlock with the share-lockers.

The proposed guard trigger must also read the intent **without** a lock on the privileged path. If a future change made it lock the intent, `admin_resolve_operation` vs `applyEvent` could deadlock. PostgreSQL then aborts one side with 40P01, a **retryable failure, never a fence bypass** (the same accepted stance as 0007).

### 5.2 Races

| Race | Outcome |
|---|---|
| hold vs claim | §3.4: whichever commits first wins; the loser re-checks under locks and rolls back. |
| claim vs E3 transition | the fence trigger share-locks the intent: either the transition commits first (claim refused: `payment_captured` / version mismatch) or it waits. |
| completion vs lease expiry (`recoverExpiredOperations` → `markUnknown`) | both take the op `FOR UPDATE`. If maintenance wins: the row is `outcome_unknown` and the completion's state check refuses → owner path. If completion wins: maintenance's `in_flight` filter skips the row. |
| completion vs E3 transition | the completion holds the intent SHARE; the transition waits, or the completion's version check refuses. |
| link vs owner `admin_resolve_operation` | op `FOR UPDATE` serialises them. The link requires `state = succeeded`; the owner requires `outcome_unknown | escalated`. Exactly one applies. |
| two holds, same op | the op `FOR UPDATE` serialises; same reason → idempotent; other reason → `HOLD_ALREADY_ACTIVE`. |
| duplicate completion | the second call sees `succeeded` → `NOT_IN_FLIGHT` raise (no change); 0008 forbids repointing. |
| evidence for another op / intent / reservation | validator refusal. `read_operation_id UNIQUE` prevents reusing one read for two rows' evidence. |

### 5.3 What the DB can and cannot attest

| DB-verifiable (persisted rows) | Worker / pure-proof trust (not DB-attestable) |
|---|---|
| evidence kind / source / status; read op type, state and timing; `external_ref`; the intent and op binding | that the read was really executed against Hostaway, and its response is what was recorded |
| observed amount = payload = captured = total; currency = intent; listing; title / marker string equality; count = 1; id = result | that `executorAccountRef` / client labels correspond to the same real credential and account (labels only) |
| method ∈ approved set | that the method equals the **configured** owner choice (config is outside the DB) |
| `observed_at` vs `dispatched_at` (DB times); lease and version by the DB clock | snapshot completeness of the provider list; correct classification of an assessment outcome |

---

## 6. Phase / owner-case decision table

| Phase / fact | Row | Action | Case kind | Public |
|---|---|---|---|---|
| preflight not eligible (< bound) | pending | record assessment; retry later | — | confirmed |
| preflight bound reached | pending | `open_recording_hold(PREFLIGHT_EXHAUSTED)` | `OFFLINE_CHARGE_HOLD_PREFLIGHT_EXHAUSTED` | confirmed |
| preflight conflict (marker / look-alike / same amount) | pending | hold (`CONFLICT_*`) with the assessment | `…_HOLD_PREFLIGHT_CONFLICT_*` | confirmed |
| attempt > 1 pending | pending | hold (`ATTEMPT_GT1`); never claimable | `…_HOLD_ATTEMPT_GT1` | confirmed |
| claimed; pre-send fence, send, reply or confirm fails | in_flight | `completeOperation(outcome_unknown)` (existing) | `OFFLINE_CHARGE_OUTCOME_UNKNOWN` (`op:<id>`) | confirmed |
| confirm OK | in_flight | `complete_recording_with_evidence` → `RECORDED` | — | confirmed |
| owner resolved succeeded, count-only | succeeded, no link | try link → else hold `SUCCEEDED_UNPROVEN` | `…_HOLD_SUCCEEDED_UNPROVEN` | confirmed |
| owner resolved failed_definite | failed_definite → E3 queues `:2` | hold `ATTEMPT_GT1` | `…_HOLD_ATTEMPT_GT1` | confirmed |

---

## 7. Proposed change map, dependency and rollback order (NOT applied)

**Migration `0010_recording_evidence_link` (D2), up:**
1. `recording_evidence_refusal()`;
2. `complete_recording_with_evidence()`, `link_recording_evidence()`;
3. the recording success rule (guard addition or a `zz0_` trigger);
4. the `intents_safety_guard` finalisation rule;
5. grants: app EXECUTE on 2; `REVOKE … FROM PUBLIC` on all.

Down: the reverse order (drop triggers / rules → functions). No table or data change.

**Migration `0011_recording_holds` (D1), up:**
1. tables `recording_assessments`, `recording_holds` + guards + RLS (deny by default; app SELECT; admin SELECT);
2. `record_recording_assessment()`, `open_recording_hold()`, `admin_resolve_recording_hold()`;
3. `recording_claim_fence()` + trigger;
4. the `reconciliation_cases` INSERT guard for `OFFLINE_CHARGE_HOLD_%`;
5. `admin_close_case` refusal for `recording-hold:%`;
6. grants.

Down: drop the trigger / guards → functions → tables. Disposable local DBs only; a down step with rows present refuses rather than discarding audit data.

**Helpers (PROPOSED):**
- `operations.js`: `RECORD_FENCE` in both `claimNextOperation` stages; recording success routed to the function;
- `repo.js`: the event-guard mirror;
- E7.4b worker (later): calls only these functions.

**Dependency:** D1's `link_full_proof` decision uses D2's validator, so **D2 first, then D1**. The dispatch worker needs **both**, plus live gates E1–E7 / P1.

---

## 8. Test matrix (disposable local PG, fake providers, for each later slice)

| # | Case | Expect |
|---|---|---|
| T1 | app role direct `UPDATE … SET state='succeeded'` on a recording (with or without `settled_evidence_id`) | refused |
| T2 | `completeOperation(succeeded)` on a recording | refused (routed or raised); no state change |
| T3 | `complete_recording_with_evidence` happy path | succeeded + link in one commit; 0008 forbids a later clear or repoint |
| T4 | each validator field wrong individually (kind, source, status, read type / state / time, reservation, listing, amount vs payload / captured / total, currency, status, type, provider, method outside the set, title, marker, count ≠ 1, ids ≠ [result], extra / missing keys, `chargeId` ≠ result) | refused; nothing changed |
| T5 | evidence from another intent / op / reservation; evidence observed ≤ dispatch; one read reused for two ops | refused |
| T6 | stale version / lost op lease / lost work lease / expired (DB clock) at completion | refused, rolled back → the worker's `outcome_unknown` |
| T7 | concurrent completion vs `recoverExpiredOperations` | exactly one wins; no succeeded-without-link |
| T8 | `payment_captured → confirmed` via `applyEvent` without a link (generic planner) | refused by the DB |
| T9 | owner `admin_resolve_operation(succeeded)` count-only → later link with full evidence | link OK → confirmed; with count-only evidence → `SUCCEEDED_UNPROVEN` hold, resolution intact |
| T10 | every claim path (`claimNextOperation` generic, by `opId`, by intent; direct UPDATE) with an active hold | refused / skipped |
| T11 | concurrent hold vs claim (observed lock wait, both orders) | §3.4 outcomes; never both |
| T12 | duplicate `open_recording_hold` same reason / other reason | idempotent / `HOLD_ALREADY_ACTIVE` |
| T13 | hold when an open case of the same kind exists (app-inserted fake) | `CASE_KIND_OCCUPIED`; rollback |
| T14 | app INSERT of `OFFLINE_CHARGE_HOLD_%` case; app INSERT / UPDATE on `recording_holds` / `recording_assessments` | refused |
| T15 | `admin_close_case` on a hold case | refused |
| T16 | `release_for_initial_send` on `ATTEMPT_GT1` / `SUCCEEDED_UNPROVEN`; without a fresh eligible assessment | refused |
| T17 | an unknown case of a different op stays visible when a hold opens (no suppression) | both open |
| T18 | assessment binding: wrong op / intent / read types / reads before the recording row / confirm phase on a pending row | refused |
| T19 | bound: 2 non-eligible preflights → `PREFLIGHT_EXHAUSTED` refused; 3 → accepted | exact |
| T20 | every test: intent state / version / public status unchanged by D1 / D2; no ESCALATE, notify, void, cancel or refund rows; `dispatched_at` untouched for holds | asserted |
| T21 | migrations up → down → up on a disposable DB; down refuses when holds or links exist | exact |

---

## 9. Unresolved choices (for root)

1. **D2 first** (recommended): the smallest change that makes success fail-closed. It adds no tables, only functions and triggers.
2. The `recorded_manually` owner decision: finalising the intent to `confirmed` needs a separately reviewed owner path (`admin_resolve_intent` extension or a new function). Left open.
3. Whether `link_recording_evidence` for owner-resolved rows should also require the 15-minute settle. The proposal requires it, for consistency with 0005.
4. `paymentMethod`: the DB checks the approved **set** only. The exact configured value stays worker trust until the owner decides (open).
5. Whether to persist an account ref with the reservation create (R2 §5.1). Not proposed here.

**Minimal next implementation slice (after root review): D2 only.**
- Migration 0010 (validator, `complete_recording_with_evidence`, `link_recording_evidence`, the success-requires-link rule, the finalisation rule);
- the `completeOperation` routing helper and the `repo.js` mirror;
- tests T1–T9, T20, T21.

No worker, adapter, holds or dispatch.
