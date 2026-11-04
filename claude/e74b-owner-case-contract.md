# E7.4b-D1: durable owner-case contract for Hostaway payment recordings (DESIGN ONLY), revision 2

> **Current status (as of `34f0314`):**
> - **0011 is PRESENT and accepted offline** (`cd77088` + the R1 / R2 helper corrections at `34f0314`). §13 maps the implementation.
> - **0012 (slice A) is PRESENT and accepted offline at `ff07fe8`** (map in the preflight contract §14). **0013 is PRESENT and accepted offline at `185da0e`** (`claude/e74b-preflight-release-contract.md` §13; supersedes preflight contract §8). **D5 / 0014 is IMPLEMENTED offline** on `feature/e7-offline-charge-completion-binding` (pending root code review; map: `claude/e74b-completion-binding-contract.md` §9).
> - **Preflight design, split into two migrations** (`claude/e74b-preflight-assessment-contract.md`, revision 2; root D9): **0012** = assessments + claim fence + conflict / exhaustion latch (epoch 0 only, no holds, no release); **0013** = `PREFLIGHT_*` holds + `release_review` + `admin_release_preflight_hold`. Neither is implemented.
> - **Superseded here by that contract:** every "0012" reference in §0–§12 that concerns preflight holds, `assessment_id` columns, `release_for_initial_send`, the wider reason / decision CHECKs or T-F2–T-F4 now means **0013**; the claim-fence addition means 0012 **plus** the conflict latch (any conflict in the current epoch blocks, not only the latest row). `recorded_manually` is **not** in 0012 / 0013 ([OUTSIDE], preflight contract §8.5). The preflight contract wins where they differ.
> - **Historical baseline.** §0–§12 below are the accepted design text written *before* 0011 existed. Statements such as "Nothing here is implemented" and the "no recording claim fence" baseline in §1 describe `abdcf91` (the design baseline), **not** the current code. Where §0–§12 differ from §13, §13 describes the code.

**Branch.** `feature/e7-offline-charge-owner-case-contract`.
- Revision 1: `f411105`, cut from `abdcf91`.
- **Revision 2** answers root's HOLD on `f411105`. It records root choices O1–O7 and corrections 1–7; the resolution map is §12.

**Base and scope.**
- Migration 0010 is **PRESENT** (accepted offline at `d801b43`).
- The pure offline-charge proof foundation (`lib/checkout/offline-charge-proof.js`) is **accepted** (`4f6b27f`). What is *not* implemented is persisting worker preflight assessments and mapping them to the database (§6).
- This document governs D1. It supersedes the D1 parts of `claude/e74b-db-evidence-case-contract.md` (see the pointer there).

**Nothing here is implemented, applied or authorized.**
- No executable 0011 / 0012, helper, worker, adapter or 0010 change.
- No automatic resend, no automated attempt > 1, and no ESCALATE, cancel, void, refund or real notification.
- Live gates, dispatch and the owner `paymentMethod` choice stay blocked.

**Labels.**
- **[PRESENT]**: code at `abdcf91`, cited as path:line.
- **[PROPOSED]**: this design.
- **[TRUST]**: an input the database cannot attest.
- **[OUTSIDE]**: needs a separate root authorization.

---

## 0. Root choices recorded (HOLD on f411105)

| # | Choice |
|---|---|
| O1 | **0011** = visibility holds + evidence inbox + base claim fence + reserved-case binding. **0012** = preflight assessments / holds. |
| O2 | **No `close_acknowledged`.** `keep_visible` (no release, no closure) and `link_full_proof` (`SUCCEEDED_UNPROVEN` only) are the only 0011 owner decisions. Acknowledging has no purge side effect. Override / manual finalisation stay [OUTSIDE]. |
| O3 | One shared SQL per-evidence core with an **explicit reference**, a private count wrapper, and a narrow granted read-only page function. Exact 0010 parity, result shape and cursor. |
| O4 | `SUCCEEDED_UNPROVEN` may be opened immediately (DB-derived). A racing open can move a later link to owner-only (§5.2). No age delay. |
| O5 | App maintenance may call the bounded DB-only processor. Schedules and live invocation stay [OUTSIDE]. No provider action. |
| O6 | Keep **both** the op-hold check and the fail-closed "no open reserved case for the intent" check in the fence. Legitimate same-kind collisions are handled (§4.5), not declared impossible. |
| O7 | The raw UNIQUE reservation-id conflict stays tracked [OUTSIDE]; no runtime work. |

---

## 1. Present baseline (inspected at abdcf91)

| Fact | Where |
|---|---|
| **Cases.** `reconciliation_cases`: one **open** case per `(intent_id, kind)`; `kind` must satisfy `is_code`; no delete. | 0001:536–551 |
| App case grants: INSERT stays; UPDATE revoked; non-privileged UPDATE refused. | 0002:23–27, 0003:675, 0003:462–470 |
| **Privileged paths that resolve cases today:** | |
| – `intents_safety_guard` resolves **all open cases of the intent** when it leaves `reconciliation_required` (fires for `admin_resolve_intent`, 0003:603) | 0004:114, 0004:178–181 |
| – `admin_resolve_operation` resolves `opened_by = 'op:'||op` | 0005:380 |
| – `settle_operation_from_evidence` resolves `opened_by = 'op:'||op` | 0005:286 |
| – `admin_close_case` resolves any case except `op:%` | 0003:640–656 |
| Open cases block guest-data purge, and appear as `OPEN_CASE:<kind>` in `claim_release_blockers`. | 0005:145, 0005:62–64 |
| **Resolutions.** `reconciliation_resolutions`: `decision` enum; `operation_id` NOT NULL **iff** `operation_succeeded` / `_failed`; `case_id` NOT NULL **iff** `case_closed`; `cardinality(evidence_ids) ≥ 1`. | 0003:104–123 |
| One open recording per intent (`pending`, `in_flight`, `outcome_unknown`, `escalated`). Several *terminal* recordings may exist. | 0001:396–397 |
| Attempt `n+1` is queued after `OFFLINE_CHARGE_FAILED`. | `lib/checkout/intent-state.js:598–603`; key `och:<intent>:<n>` at `lib/booking-db/repo.js:105` |
| **No recording claim fence.** `claimNextOperation` sets `dispatched_at` / `lease_until` from the caller clock. | `lib/booking-db/operations.js:74–108` |
| `applyEvent` locks the intent `FOR NO KEY UPDATE` first. | `repo.js:350` |
| `provider_evidence.created_at DEFAULT now()` = **transaction start**. Writes only through `record_provider_evidence` / `admin_record_evidence`, which INSERT and then take the advisory key. | 0003:52–76, 0003:67; 0010:354–404 (advisory at 386–387, 402–403) |
| **0010:** | |
| – `recording_conflict_refusal(intent, dispatched_at, result_ref, reference)` | 0010:131–162; row condition 141–159 |
| – completion (reference = **candidate** `p_evidence`) | 0010:279 |
| – link (reference = **candidate**) | 0010:316 |
| – finalisation (reference = linked) | 0010:343 |
| – lossless scan | `operations.js:171–224` |

---

## 2. Design in brief

1. **Op-bound holds plus bound cases.** A hold is the op-level identity. A case is the `(intent, kind)` owner-visibility identity. One case may carry **several** holds of the same reason (§4.5).
   - Holds never change intent state, op state, `dispatched_at`, public status or effects.
2. **Reasons.**
   - **0011** (all derived from database facts): `ATTEMPT_GT1`, `SUCCEEDED_UNPROVEN`, `LINKED_CONTRADICTED`.
   - **0012**: `PREFLIGHT_*`.
3. **Later contradictions use a trigger-fed inbox**, drained one item per top-level transaction (§5.3).
4. **One per-evidence predicate with an explicit reference**, shared by completion, link, finalisation, inbox and page (§5.1).
5. **Owner decisions live in a dedicated hold-decision table.** `reconciliation_resolutions` is not reused, so no provider evidence is invented (§7).

---

## 3. Hold reasons [PROPOSED]

| Reason → case kind `OFFLINE_CHARGE_HOLD_<reason>` | Target op when opened | Intent | Opened by | Stage |
|---|---|---|---|---|
| `ATTEMPT_GT1` | latest recording; `pending`; key attempt > 1; `dispatched_at` NULL | `payment_captured` | `open_recording_visibility_hold` | 0011 |
| `SUCCEEDED_UNPROVEN` | latest; `succeeded`; `result_ref` set; link NULL | `payment_captured` or `confirmed` | `open_recording_visibility_hold` | 0011 |
| `LINKED_CONTRADICTED` | latest; `succeeded`; linked; the inbox item's evidence contradicts it (exact shared predicate) | **any current intent state** (root-accepted extension at `cd77088` review; visibility only, e.g. a linked booking later moved to `reconciliation_required`) | inbox processor only | 0011 |
| `PREFLIGHT_EXHAUSTED`, `PREFLIGHT_CONFLICT_MARKER` / `_LOOKALIKE` / `_SAME_AMOUNT` | latest; `pending`; key `:1`; `attempts 0`; undispatched | `payment_captured` | `open_recording_preflight_hold` (worker) | 0012 |

**Dispatched unknown sends** stay on the existing owner-only path (`OFFLINE_CHARGE_OUTCOME_UNKNOWN` → `admin_resolve_operation`). Nothing fakes `dispatched_at` or `outcome_unknown`.

---

## 4. Tables, guards, grants (0011 unless marked) [PROPOSED]

**Common rules.**
- RLS enabled; **SELECT-only** policies for `mv_booking_app`, `mv_booking_admin`, `mv_booking_report`. No write policy or grant for any role; writes happen only inside schema-owner SECURITY DEFINER functions.
- `reject_change` on DELETE and TRUNCATE.
- Guard triggers are SECURITY INVOKER and use `is_privileged()` only as "inside a schema-owner function".
- Binding (constraint) triggers are SECURITY DEFINER, owned by the schema owner and `REVOKE ALL FROM PUBLIC`. They read the protected tables without any app grant.

### 4.1 `recording_holds`

| Column | Rule |
|---|---|
| `id uuid PK` | pre-allocated |
| `operation_id → external_operations`, `intent_id → intents` | `intent_id` = the op's intent (guard) |
| `reason` | CHECK: 0011 set; 0012 widens the CHECK |
| `case_id → reconciliation_cases NOT NULL` | **not unique**: several holds may share one case (§4.5) |
| `op_state_at_hold`, `op_key_at_hold`, `intent_state_at_hold`, `intent_version_at_hold` | snapshot |
| `epoch int NOT NULL DEFAULT 0` | |
| `created_at` | = `v_t` |
| `created_by` | [TRUST label] |
| `released_at`, `release_decision_id → recording_hold_decisions` | set together, NULL → value once |

Constraints:
- `UNIQUE (operation_id) WHERE released_at IS NULL`.
- Identity columns frozen.
- **There is no `assessment_id` column in 0011.** 0012 adds it with its FK, once `recording_assessments` exists.

### 4.2 `recording_hold_observations` (append-only contradictions only)

- Columns: `id`, `hold_id → recording_holds NOT NULL`, `evidence_id → provider_evidence NOT NULL`, `recorded_at = v_t`.
- `UNIQUE (hold_id, evidence_id)`.
- Acknowledgements are **not** observations; they are decisions (§4.3).

### 4.3 `recording_hold_decisions` (append-only owner decisions)

| Column | Rule |
|---|---|
| `id`, `hold_id NOT NULL`, `operation_id NOT NULL`, `case_id NOT NULL`, `intent_id NOT NULL` | must equal the hold's (guard) |
| `decision` | 0011: `keep_visible`, `link_full_proof`; 0012 adds `release_for_initial_send`, `recorded_manually` |
| `evidence_ids uuid[] NOT NULL DEFAULT '{}'` | **may be empty.** Every cited id must belong to the intent (`cited_evidence`, 0003:522) |
| `linked_evidence_id` | NOT NULL **iff** `decision = 'link_full_proof'` |
| `assessment_id` | 0012 only; NOT NULL iff `release_for_initial_send` |
| `resolver`, `justification_code` (`is_code`), `resolver_session_user` | |
| `decided_at` | owner `p_at` [TRUST] |
| `recorded_at` | `v_t` |

`reconciliation_resolutions` (0003:104–123) is **unchanged**. No enum or CHECK change, and no provider evidence is invented for `ATTEMPT_GT1` / `keep_visible`.

### 4.4 `recording_conflict_inbox`

| Column | Rule |
|---|---|
| `seq bigint GENERATED ALWAYS AS IDENTITY` | |
| `evidence_id uuid PK → provider_evidence`, `intent_id` | |
| `enqueued_at` | `clock_timestamp()` in the trigger |
| `attempts int NOT NULL DEFAULT 0`, `last_error text`, `last_attempt_at` | |
| `processed_at`, `outcome`, `hold_id` | |

**Mutation rules** (guard, privileged only):
- (a) While `processed_at IS NULL`: `attempts` may change only to `attempts + 1`, together with `last_error` and `last_attempt_at`.
- (b) `processed_at`, `outcome` and `hold_id` change NULL → value **together, once**, and the row is then fully frozen.
- (c) Nothing else changes.

Outcomes: `not_latest_linked`, `consistent`, `contradiction_opened`, `contradiction_joined_case`, `contradiction_appended`, `contradiction_duplicate`.

**Enqueue trigger** `zz1_evidence_enqueue`: `AFTER INSERT ON provider_evidence FOR EACH ROW WHEN (NEW.kind = 'hostaway_offline_charges')`, SECURITY DEFINER.
- It runs inside the writer's INSERT statement, i.e. **before** the writer's advisory lock (0010:386–387, 402–403).
- It takes no lock beyond the new inbox row and the FK key-share locks (evidence row, intent).

### 4.5 Reserved cases: identity, binding, collisions

**Identity.** A hold case has `kind = 'OFFLINE_CHARGE_HOLD_'||reason` and `opened_by = 'recording-hold:'||<case.id>`, i.e. the **case** id. Each hold binds through `hold.case_id = case.id`.

**INSERT guard** (BEFORE INSERT on cases, INVOKER). A reserved kind (`OFFLINE_CHARGE_HOLD_%`) requires `is_privileged()` and `opened_by = 'recording-hold:'||NEW.id`. The broad app INSERT grant stays; app inserts of reserved kinds are refused.

**Deferred two-way binding** (DEFERRABLE INITIALLY DEFERRED constraint triggers AFTER INSERT OR UPDATE on **both** `reconciliation_cases` and `recording_holds`). At commit, for every touched reserved-kind case `c`:
- every hold with `case_id = c.id` has `intent_id = c.intent_id` and `'OFFLINE_CHARGE_HOLD_'||reason = c.kind`;
- `c.opened_by = 'recording-hold:'||c.id`;
- **`c.status = 'open'` iff at least one bound hold is active.**

For every touched hold, its case is reserved-kind and satisfies the above. Any violation raises and the whole transaction rolls back. So **no privileged function can resolve or repurpose a hold case** without releasing every bound hold in the same transaction, and only `admin_resolve_recording_hold` releases holds.

**Case UPDATE guard** (BEFORE UPDATE on cases, INVOKER). On a reserved-kind case, `id`, `intent_id`, `kind`, `opened_by`, `opened_at` and `evidence` are frozen; only status and resolution columns may change.

**Existing paths that touch cases (0011 changes):**

| Path | Today | 0011 |
|---|---|---|
| `intents_safety_guard` bulk resolve on leaving `reconciliation_required` (0004:178–181) | resolves every open case of the intent | CREATE OR REPLACE with `AND kind NOT LIKE 'OFFLINE_CHARGE_HOLD_%'`. The hold case stays **open and visible**; the owner's intent resolution is not blocked. Without this change, the deferred binding would make `admin_resolve_intent` fail closed for any intent with an active hold. |
| `admin_close_case` (0003:640–656) | closes any non-`op:%` case | CREATE OR REPLACE: refuse `opened_by LIKE 'recording-hold:%'` (`HOLD_CASE_USE_ADMIN_RESOLVE_RECORDING_HOLD`) before any write |
| `admin_resolve_operation` (0005:380), `settle_operation_from_evidence` (0005:286) | resolve `opened_by = 'op:'||op` | unchanged; these cannot match `recording-hold:` cases, and the deferred binding is the backstop |

**Same-kind collision (legitimate).** Example: op 2 keeps an active `ATTEMPT_GT1` hold (no release exists in 0011) after the owner moves it on, and op 3 later becomes pending attempt > 1. Its hold would need the same `(intent, kind)` open case.
- Rule: under the locks of §9, the opener locks the existing open reserved case of that kind `FOR UPDATE`.
- If present, the new hold **joins** it (`hold.case_id = existing case`); the processor outcome is `contradiction_joined_case`.
- The case row is not modified (its `evidence` stays the first op's snapshot). Every joined hold is visible in `recording_holds`.
- Only if none exists is a new case inserted.
- No `ON CONFLICT DO NOTHING`, no overwrite and no silent loss. A unique violation can still occur if an *unbound* case of that kind appeared (impossible after the INSERT guard; possible from pre-0011 data). It raises `CASE_KIND_OCCUPIED` and rolls back. The 0011 up precondition refuses if any reserved-kind case exists.

**Side effects accepted and documented.** An open hold case keeps blocking guest-data purge (0005:145) and appears in `claim_release_blockers` (0005:62–64). With O2, `keep_visible` never closes it.

### 4.6 Grants

| Function | App | Admin |
|---|---|---|
| `open_recording_visibility_hold` | EXECUTE | EXECUTE |
| `process_recording_conflict_inbox_one` | EXECUTE | EXECUTE |
| `recording_contradictions_page` (read-only) | EXECUTE | EXECUTE |
| `admin_resolve_recording_hold` | — | EXECUTE |
| `record_recording_assessment`, `open_recording_preflight_hold` (0012) | EXECUTE | — |
| private: `recording_evidence_contradicts`, the count wrapper, the fence, guards, binding triggers | — | — |

`REVOKE ALL FROM PUBLIC` on all of them. There is no general app case writer.

---

## 5. Functions (0011) [PROPOSED]

### 5.1 Shared predicate with an explicit reference (correction 1)

```
booking.recording_evidence_contradicts(p_intent uuid, p_dispatched_at timestamptz, p_result_ref text,
                                       p_reference uuid, p_evidence uuid) RETURNS boolean   -- VOLATILE, SD, private
```

- It is the 0010 row condition (0010:141–159) applied to the single evidence row `p_evidence`:
  - same intent, kind, `external_ref` = the reservation;
  - `observed_at > p_dispatched_at`, `id <> p_reference`, count ≥ 1, marker rule;
  - the id / count / present-field comparisons, with `paymentMethod` / `executorAccountRef` compared against `p_reference.observed`.
- Input handling: the wrapper first checks its inputs exactly as 0010 does (0010:135–138) and **returns** `'CONFLICT_CHECK_INPUT'` (not a raise), preserving 0010's result. The core is only called with validated inputs; called directly with a NULL or missing reference / intent, it raises `CONFLICT_CHECK_INPUT`.
- **`recording_conflict_refusal(p_intent, p_dispatched_at, p_result_ref, p_reference)`** (0011 CREATE OR REPLACE; same signature, same result) = `'POSITIVE_CONTRADICTION'` if `EXISTS` evidence of the intent for which the core is true, else NULL. Its input-error behaviour stays as in 0010.

**Call map** (the reference is always explicit):

| Caller | `p_dispatched_at` | `p_result_ref` | `p_reference` |
|---|---|---|---|
| `complete_recording_with_evidence` (0010:279, unchanged call) | `o.dispatched_at` | `p_result_ref` | **candidate** `p_evidence` (row not yet linked) |
| `link_recording_evidence` (0010:316, unchanged call) | `o.dispatched_at` | `o.result_ref` | **candidate** `p_evidence` |
| finalisation trigger (0010:343, unchanged call) | `o.dispatched_at` | `o.result_ref` | `o.settled_evidence_id` |
| inbox processor | latest op `dispatched_at` | `result_ref` | `o.settled_evidence_id` (linked only), evidence = the inbox item |
| `recording_contradictions_page` | `o.dispatched_at` | `o.result_ref` | `o.settled_evidence_id` |

`recording_contradictions_page(p_after_exact text, p_after_evidence uuid, p_after_op uuid, p_limit int)` returns the current JS result shape:
- columns `opId`, `intentId`, `resultRef`, `evidenceId`, `source`, `observedAt` (ms), `observedAtExact`, plus `next`;
- the same lossless keyset `(observed_at, evidence id, op id)`, the same latest-linked restriction, limit 1…500;
- cursor validation in SQL, mirroring `operations.js:182–188`.

`listRecordingContradictions` becomes a thin caller (a helper change in the same stage). The executable 0010 file is not modified.

### 5.2 `open_recording_visibility_hold(p_op uuid, p_reason text, p_by text) RETURNS uuid`

`p_reason` ∈ {`ATTEMPT_GT1`, `SUCCEEDED_UNPROVEN`}. No lease, version or caller time.
1. Pre-allocate `hold_id` and `case_id`.
2. Locks: intent `FOR SHARE` → op `FOR UPDATE` → advisory → active hold of op `FOR UPDATE` → existing open case `(intent, kind)` `FOR UPDATE` → **`v_t`**.
3. Checks (§3), including `recording_latest_id`.
4. Idempotence: an active hold of op with the same reason → return its id. A different reason → `HOLD_ALREADY_ACTIVE`.
5. Write: join the existing case or INSERT a new case; then INSERT the hold. The deferred binding is checked at commit.

**O4 race (documented).** `SUCCEEDED_UNPROVEN` opened while an automated link is in progress:
- link first → the opener sees the link and refuses (`HOLD_TARGET_LINKED`);
- opener first → the link is refused (`RECORDING_HOLD_ACTIVE`), and only the owner's `link_full_proof` can link afterwards.

### 5.3 Inbox processing: one item per top-level transaction (correction 5)

```
booking.process_recording_conflict_inbox_one(p_by text) RETURNS jsonb   -- {evidenceId, outcome} | {evidenceId, error} | null
```

**One call = one statement = one top-level transaction** (the caller uses autocommit). It touches **at most one** inbox item. Batching is done by the app helper, as ≤ 100 **independent** calls; no PL/pgSQL loop holds locks across items.

1. `SELECT … FROM recording_conflict_inbox WHERE processed_at IS NULL ORDER BY attempts, seq LIMIT 1 FOR UPDATE SKIP LOCKED`. Nothing → return `null`.
2. `BEGIN … EXCEPTION WHEN OTHERS` block (a subtransaction). Inside it, the locks are taken in §9 order:
   - intent `FOR SHARE` → latest recording `FOR SHARE` → advisory → active hold of op `FOR UPDATE` → existing open case `FOR UPDATE` → `v_t`;
   - then decide (step 3) and write the hold / case / observation and the inbox `processed_at`, `outcome`, `hold_id`.
3. Decision, using the §5.1 core with the linked reference:
   - the latest recording is not `succeeded` + linked → `not_latest_linked`;
   - the core is false → `consistent`;
   - the core is true and an active `LINKED_CONTRADICTED` hold exists → append an observation (`contradiction_appended`; already present → `contradiction_duplicate`);
   - no such hold → join the open case or insert one, insert the hold and its first observation (`contradiction_opened` / `contradiction_joined_case`).
4. On any error inside the block (incl. 40P01, unique violations, raised refusals):
   - PostgreSQL rolls back the subtransaction **and releases the locks it acquired**;
   - the function then updates only the inbox row: `attempts + 1`, `last_error = SQLSTATE`, `last_attempt_at`;
   - it returns `{error}`. The item stays **unprocessed**.
5. Errors **outside** the block (the initial SELECT, or the attempt-accounting UPDATE) abort the statement.
   - **A rejected statement or rolled-back transaction marks nothing.**
   - But a thrown *transport* error (connection loss around `COMMIT`, e.g. `ECONNRESET`) can leave the outcome **unknown to the caller**: the server may have committed the item's processing before the reply was lost.
   - The drain helper **stops immediately** and re-throws the original error, with no further query and no retry (root R1 at `cd77088`).
   - The caller may later inspect `recording_conflict_inbox` read-only (`processed_at`, `outcome`, `attempts`, `last_error` of the item) to learn what happened.
   - **There is no exactly-once transport guarantee**, and there is never an automatic retry.

**Why this cannot cycle (inferred; tested in T-H2).**
- The only lock held across the block is the single inbox row, which no other party waits for (`SKIP LOCKED`; the trigger only inserts new rows).
- Inside the block, one transaction locks objects of **one intent**, in the uniform §9 order.
- The A→B vs B→A batch deadlock is therefore impossible, because no transaction ever holds locks of two intents.
- Contention with link, finalisation and writers is in §9. Any residual 40P01 is caught by step 4 and retried by a later call.

**Fairness and latency.**
- `ORDER BY attempts, seq` serves fresh items before repeatedly failing ones.
- A failing item is never dropped. It stays visible with `attempts`, `last_error` and `last_attempt_at`, and the backlog (`processed_at IS NULL`) is queryable.
- Under sustained inflow, a high-attempt item can wait indefinitely behind fresh items; this is visible, not hidden.
- **No alert latency is guaranteed.** Processing happens only when something calls it, and no schedule exists ([OUTSIDE]).

### 5.4 Fence and "no active hold" additions (0011)

- **`recording_claim_fence()`**: SECURITY DEFINER; `BEFORE UPDATE … WHEN (OLD.state='pending' AND NEW.state='in_flight' AND NEW.op_type='hostaway.record_offline_charge')`. It is the single gate for helper generic / `opId` / `intentId` claims and direct app UPDATEs. Under intent `FOR SHARE` it requires:
  - intent `payment_captured`, `captured_minor = final_total_minor`;
  - payload `reservationId` / `amountMinor` bound to the intent;
  - key `:1`, `OLD.attempts = 0`, `OLD.dispatched_at IS NULL`, `offline_charge_attempts = 0`, latest recording;
  - **no active hold for the op and no open reserved case for the intent** (O6).
  - `claimNextOperation` gets a mirroring SQL fragment, so fenced rows are skipped.
- **No active hold on the latest recording** is additionally required by:
  - the finalisation trigger (CREATE OR REPLACE of 0010:332–347; same 0010 checks first);
  - `link_recording_evidence`;
  - `complete_recording_with_evidence`.
  
  These are 0011 replacements, not 0010 edits.

---

## 6. Assessments and preflight (0012) [PROPOSED] (correction 2)

**Status.** Pure classification is accepted (`4f6b27f`). Persisting it (the worker's mapping of the pure result to these rows) is **not implemented** and is the 0012 dependency.

**Table `recording_assessments`.**
- Columns: `id`, `operation_id`, `intent_id`, `phase` (`preflight` | `release_review`), `hold_id` (NOT NULL **iff** `release_review`), `outcome`, `code`, `identity_read_op`, `list_read_op`, `identity_evidence`, `list_evidence`, `epoch`, `intent_version`, `worker`, `module_version`, `recorded_at = v_t`.
- `UNIQUE (identity_read_op)` / `UNIQUE (list_read_op)` where not NULL: each read is counted once, in either phase.
- 0012 also adds `recording_holds.assessment_id` and `recording_hold_decisions.assessment_id` with their FKs.

**Outcome bindings** (both phases):

| Outcome | Required | DB consistency check |
|---|---|---|
| `eligible` | identity read `hostaway.retrieve_reservation` `succeeded` + its evidence (`external_ref` = reservation); list read `hostaway.list_offline_charges` `succeeded` + its evidence; both `observed_at` in `[v_t − 2 min, v_t]` | list `matchingChargeCount = 0` |
| `conflict_marker` | list read + evidence | count ≥ 1 |
| `conflict_lookalike`, `conflict_same_amount` | list read + evidence | [TRUST] |
| `incomplete` | list read terminal, no list evidence | terminal |
| `identity_refused` | identity read terminal, no list read | terminal |

**Every cited read must be:**
- on the same intent, of the right type, terminal; cited evidence `read_operation_id` = that read;
- `created_at` ≥ the recording's `created_at`;
- for `preflight`: ≥ the **current epoch start** (the last release decision's `recorded_at`, else the recording's `created_at`);
- for `release_review`: > the cited hold's `created_at`.

**`record_recording_assessment(p_op, p_worker, p_phase, p_hold, …, p_expected_version, p_module_version)`**
- Locks: intent SHARE → work SHARE → op SHARE → (`release_review`: hold SHARE) → read rows SHARE → `v_t`.
- Common checks: intent `payment_captured`, `version = p_expected_version`, live work lease of `p_worker` at `v_t`; op `pending`, undispatched, key `:1`, `attempts 0`, latest.
- `preflight`: **no active hold** for the op.
- `release_review`: `p_hold` is the op's **active `PREFLIGHT_*` hold**. A `release_review` assessment can never qualify a claim (the fence ignores that phase) or count towards exhaustion.

**Epochs.**
- `epoch` = the number of released `PREFLIGHT_*` holds of the op.
- Exhaustion counts non-eligible `preflight` assessments **of the current epoch only**, so an old epoch never re-trips after a release.

**0012 fence addition.** The op's latest `preflight` assessment of the **current** epoch is `eligible`, with both evidence rows `observed_at` within `[v_t − 2 min, v_t]` at the fence's `v_t`.
- After a release, the old-epoch `release_review` does **not** carry forward. A new `preflight` eligible assessment, with reads created after the release, is required (no carry-forward rule).

**`open_recording_preflight_hold`**: §5.2 plus lease and version checks; exhaustion count ≥ 3, or a cited current-epoch `preflight` assessment of the matching conflict outcome.

**Owner `release_for_initial_send`.**
- It requires an `eligible` `release_review` assessment bound to **this hold**, at `intent_version = hold.intent_version_at_hold = current version`, with both evidence rows `observed_at` in `[v_t − 2 min, v_t]` at the owner function's `v_t`.
- It releases the hold, starting a new epoch. It does not claim.

`recorded_manually` (`PREFLIGHT_*`, `ATTEMPT_GT1`) is 0012, and moves op `pending → superseded` (0004:45–72).

---

## 7. Owner decisions (correction 4)

`admin_resolve_recording_hold(p_hold, p_decision, p_evidence uuid[], p_linked_evidence uuid, p_assessment uuid, p_resolver, p_justification, p_at)`:
- admin only;
- locks: intent SHARE → op UPDATE → advisory → hold UPDATE → case UPDATE → `v_t`;
- always inserts **one** `recording_hold_decisions` row.

| Decision | Reasons | Hold / case | Record | Effect |
|---|---|---|---|---|
| `keep_visible` | all | hold **active**, case **open**; nothing released | `evidence_ids` may be **empty** (e.g. `ATTEMPT_GT1`); any cited ids are validated | acknowledgement only; later contradictions keep appending; finalisation / claim stay blocked; no purge effect |
| `link_full_proof` | `SUCCEEDED_UNPROVEN` | this hold released; the case is resolved `recorded` only if it has no other active bound hold | `linked_evidence_id` = the proof; `evidence_ids` ⊇ {it} | attaches the link via the 0010 validator (`owner_historical`) and the §5.1 core with the **candidate** reference. Refused if contradicted or < 15 min. |

0012 adds `release_for_initial_send` and `recorded_manually` (§6).

[OUTSIDE]: closing or acknowledging a contradiction so as to allow finalisation; manual finalisation; overriding the guard; refund, cancel or notify.

---

## 8. Detection guarantees, exactly (correction 7)

**Proposed DB guarantee.**
- Every offline-charge evidence row committed after 0011 gets an inbox row in its own transaction (trigger atomicity).
- Once that row is processed, a contradiction against the **then-latest linked** recording opens or joins a `LINKED_CONTRADICTED` hold.
- Old `observed_at` or `created_at` values do not matter: the processor selects rows, not a cursor range.

**Not a later-conflict hold, but safely blocked.**
- Evidence committed **before** a link is judged by 0010's post-advisory predicate at completion or link time (candidate reference). A contradiction **refuses** the completion or link.
  - If its inbox item was processed earlier, the outcome is `not_latest_linked`. That is correct: the row is blocked, not linked.
- Visibility for blocked rows:
  - Refused **completion**: the op stays `in_flight` until its lease expires, then becomes `outcome_unknown` with the existing owner case (`operations.js:267–289`).
  - Refused **link** on an owner-resolved row: the row stays `succeeded` unlinked (finalisation blocked). It gets `SUCCEEDED_UNPROVEN` visibility **only if** a caller invokes `open_recording_visibility_hold`.
  - The proposed helper rule is that the link helper does so on `RECORDING_EVIDENCE_CONFLICT`. That is a **helper-level** behaviour, not a DB guarantee.

**Backfill.**
- 0011 up enqueues every existing offline-charge evidence row (INSERT … SELECT; disposable local DB).
- Completeness relies on the migration's single transaction (PROPOSED; tested in T-C9).

**Cross-check.** `recording_contradictions_page` remains a read-only audit. A finding with no `LINKED_CONTRADICTED` observation signals a defect.

**Not promised.**
- Exactly-once observation: processing is at least once and idempotent.
- Any processing latency or schedule.

---

## 9. Lock order and contention

**Uniform order for D1 functions.** Objects of **one** intent only:

> intent → (intent_work) → recording op → advisory evidence key → hold → reserved case → `v_t`

The writes (case / hold / observation / decision / inbox) follow. A reserved-case unique-index wait could only come from another transaction holding the same advisory key, so none is expected after `v_t` (inferred).

| Path | Order | Outcome |
|---|---|---|
| claim helper + fence | intent SHARE → op UPDATE SKIP LOCKED → (trigger) holds / cases read | serialized; fenced rows skipped |
| direct app `UPDATE … in_flight` | op UPDATE → (trigger) intent SHARE | vs `applyEvent` (intent NO KEY UPDATE → op): possible **40P01**, bounded and retryable, never a bypass |
| completion / link (0010 + 0011 hold read) | intent SHARE → (work) → op UPDATE → advisory | vs D1 openers: op lock serializes; the loser re-checks and refuses |
| visibility / preflight opener | intent SHARE → (work) → op UPDATE → advisory → hold → case | as above |
| inbox processor (one item) | inbox row UPDATE (SKIP LOCKED) → intent SHARE → op SHARE → advisory → hold → case | vs link: waits on op, or link waits; vs finalisation: intent SHARE vs NO KEY UPDATE, one waits; vs a writer of the same intent: the writer waits on the advisory key held by the processor (or vice versa); the processor never waits for the writer's read-op row |
| evidence writer | read op UPDATE → evidence INSERT → **inbox INSERT (trigger)** → advisory | the inbox INSERT takes only new-row and FK key-share locks |
| finalisation | intent NO KEY UPDATE → (trigger) advisory → hold read | serialized with share-lockers |
| `admin_resolve_recording_hold` | intent SHARE → op UPDATE → advisory → hold → case | uniform |
| `admin_close_case` | case FOR UPDATE → raise (reserved) | no further lock |
| `admin_resolve_intent` → `intents_safety_guard` | intent FOR UPDATE → resolutions → cases (non-reserved only after 0011) | reserved cases untouched |

- **Time.** `v_t = clock_timestamp()` after the last potentially blocking lock, for hold / decision / observation / processed times and all freshness checks. `p_at` / `decided_at` are owner-asserted [TRUST]; `dispatched_at` and `observed_at` remain caller-written [TRUST].
- Every refusal is a raise inside one transaction (or subtransaction for inbox items): no partial write.
- Lock waits stated here are **inferred**. Tests must observe actual waits (`pg_locks`) and not claim universality.

---

## 10. Exact 0011 change map

**0011 up**, one transaction. Precondition: no reserved-kind case exists; else RAISE.
1. Tables §4.1–§4.4 with guards, RLS (SELECT policies for app, admin, report), no write grants.
2. Case INSERT / UPDATE guards; deferred binding triggers on cases and holds (SD, private).
3. `recording_evidence_contradicts`; CREATE OR REPLACE `recording_conflict_refusal` (same signature).
4. `open_recording_visibility_hold`, `process_recording_conflict_inbox_one`, `recording_contradictions_page`, `admin_resolve_recording_hold` (0011 decisions only).
5. CREATE OR REPLACE: `complete_recording_with_evidence`, `link_recording_evidence`, `recording_finalisation_guard` (+ no active hold); `intents_safety_guard` (exclude reserved kinds from the bulk resolve); `admin_close_case` (refuse hold cases).
6. `recording_claim_fence` + trigger.
7. Enqueue trigger; backfill INSERT … SELECT.
8. Grants (§4.6).

**0011 down.** Refuse (RAISE) if any hold, observation or decision exists, or any inbox row has `attempts > 0` or `processed_at` set. Processing history and failures are kept, not silently dropped.
- Otherwise drop in reverse order and restore the replaced 0003 / 0004 / 0010 bodies verbatim.

**0012** adds:
- `recording_assessments`;
- `assessment_id` columns and FKs;
- the reason / decision CHECK widening;
- the preflight functions and the fence's eligible requirement.

Its down refuses if any assessment or preflight hold exists. 0011 is complete and testable without 0012.

**Helpers (same stages):**
- `RECORD_FENCE` in `claimNextOperation`;
- `listRecordingContradictions` → page function;
- an inbox-drain helper (≤ 100 independent calls);
- link helper → visibility opener on conflict;
- `DB_SAFETY_CODES` additions.

---

## 11. Planned tests (PLANNED; not written or run; full TAP retained)

| # | Scenario | Expect |
|---|---|---|
| T-A1 | app writes to holds / observations / decisions / inbox / assessments | refused |
| T-A2 | app INSERT of a reserved case; privileged insert without a hold; a hold bound to a case of another intent / kind / opened_by | refused (insert guard / deferred binding) |
| T-A3 | **unrelated owner resolution**: `admin_close_case` on a hold case; `admin_resolve_intent` on an intent with an active hold; `admin_resolve_operation` / `settle_operation_from_evidence` on the same intent | refused / succeeds with the hold case still **open** / unaffected |
| T-A4 | owner-role direct UPDATE: un-release, re-release, change reason, case resolved while a hold is active | refused (guard / deferred binding) |
| T-A5 | deferred binding privileges: the binding trigger reads protected tables while the app has no grant | works; app SELECT-only |
| T-B1 | every claim path with an active hold or an open reserved case | skipped / `RECORDING_CLAIM_FENCED` |
| T-B2 | fence: attempt 2, `attempts > 0`, dispatched, not latest, amount / reservation mismatch, intent state | refused; healthy attempt 1 allowed |
| T-B3 | direct UPDATE claim vs `applyEvent` | 40P01 or serialized; no bypass |
| T-B4 | active hold + link / completion / finalisation | `RECORDING_HOLD_ACTIVE` |
| T-P1 | **predicate parity, candidate-unlinked context**: completion and link with candidate references whose method / account differ from earlier rows; the 0010 fixtures | identical to 0010 |
| T-P2 | predicate parity, linked context (finalisation, page, inbox) | identical to 0010 and to each other |
| T-P3 | page function vs the 0010 JS scan: shape, microsecond cursor, validation, cap | identical |
| T-C1 | contradiction after link (API / dashboard, same reservation) | hold + case + observation; link and state unchanged |
| T-C2 | other reservation, count 0, other marker, equal labels | `consistent` |
| T-C3 | more contradictions while the case is open; reprocessing the same evidence | appended once / duplicate |
| T-C4 | historical dashboard evidence inserted later with an old `observed_at`; microsecond ties | processed |
| T-C5 | writer vs link vs processor, both orders, observed waits | link refused (blocked; `not_latest_linked`), or link stands + contradiction opened |
| T-C6 | crash / connection kill mid-item | rolled back; reprocessed; no duplicates |
| T-C7 | poison item | `attempts` / `last_error` / `last_attempt_at`; stays unprocessed; others proceed; ordering by attempts |
| T-C8 | outer-statement error (simulated; server-rejected) | nothing marked or recorded (a transport loss around COMMIT would instead leave the outcome unknown to the caller; see §5.3 step 5) |
| T-C9 | backfill with existing linked contradicted rows (incl. `confirmed`) | holds opened by the drain; visibility only |
| T-H1 | one item per transaction: a helper's 100 calls are independent; locks released per call | asserted via `pg_locks` between calls |
| T-H2 | **two processors on interleaved intents** (A, B vs B, A) | no deadlock (single-intent transactions); injected 40P01 caught → attempts + 1, item retried |
| T-D1 | `SUCCEEDED_UNPROVEN` (`payment_captured` / inherited `confirmed`), `ATTEMPT_GT1` | hold + case; no state / version / effect change |
| T-D2 | duplicate openers; different reason; the O4 race with a link (both orders) | same id / `HOLD_ALREADY_ACTIVE` / §5.2 outcomes |
| T-D3 | **operation-history same-kind collision** (op 2 `ATTEMPT_GT1` hold active, op 3 pending attempt > 1) | op 3's hold joins the open case; both visible; claim fenced; nothing overwritten |
| T-E1 | `keep_visible` with **no provider evidence** (`ATTEMPT_GT1`) and with cited evidence | decision row; hold and case stay; no purge or claim-release change |
| T-E2 | `link_full_proof` valid / < 15 min / contradicted / with a second active hold on the same case | linked + released / refused / refused / case stays open |
| T-F1 (0012) | assessment bindings, duplicates, stale reads, lease / version / worker | refused |
| T-F2 (0012) | **held eligible**: `release_review` while the `PREFLIGHT_*` hold is active; release; new epoch | release accepted |
| T-F3 (0012) | the old-epoch `release_review` does not satisfy the new-epoch fence; a new `preflight` eligible does | refused / allowed |
| T-F4 (0012) | exhaustion counts only the current epoch; `release_review` never counts | asserted |
| T-G1 | **0011 up without 0012**; the full 0011 suite passes; 0012 objects absent | OK |
| T-G2 | 0011 down with holds / observations / decisions / processed or attempted inbox rows | RAISE; untouched backfill only → OK |
| T-G3 | scoped effects: no intent state / version / public / `dispatched_at` / op-state change outside `link_full_proof` (and 0012 `recorded_manually`); no ESCALATE / notify / void / cancel / refund rows; no provider call | asserted |

---

## 12. Resolution map (root HOLD on f411105)

| # | Root item | Where |
|---|---|---|
| O1–O7 | choices recorded | §0 |
| 1 | explicit-reference core; candidate vs linked; call map; parity tests | §5.1, T-P1–P3 |
| 2 | `release_review` phase under an active hold; no carry-forward; current-epoch counters; pure module accepted at `4f6b27f` vs persistence not implemented | §6, T-F2–F4 |
| 3 | case-id identity; two-way deferred binding incl. UPDATE / resolve; `intents_safety_guard` bulk resolve; `admin_close_case`; same-kind collision joins the case | §4.5, T-A2–A5, T-D3 |
| 4 | dedicated `recording_hold_decisions`; no change to `reconciliation_resolutions`; empty evidence allowed; observations are contradictions only | §4.2, §4.3, §7, T-E1 |
| 5 | one item per top-level transaction; subtransaction lock release; error accounting; outer errors mark nothing; fairness; inbox-first-then-advisory for writers | §5.3, §9, T-H1–H2, T-C7–C8 |
| 6 | no `assessment_id` in 0011; exact up / down map; RLS / grants; binding-trigger context; down keeps processing history; inbox mutation rules | §4.1, §4.4, §10, T-G1–G2 |
| 7 | blocked-before-link vs `LINKED_CONTRADICTED`; helper-level `SUCCEEDED_UNPROVEN` after a refused link; backfill / trigger / processing PROPOSED; no latency claim | §8 |

**Still open:**
- the e74a-claim-listing-lock guard failure (release-readiness item; keep full TAP logs);
- live gates E1–E7 / P1;
- the owner `paymentMethod` choice;
- dispatch-worker authorization;
- O7.

---

## 13. E7.4b-D1-0011 implementation mapping (root acceptance of `68f30ca` + addendum A–D)

**Status.** Implemented **offline** on `feature/e7-offline-charge-owner-cases`, for disposable local PostgreSQL only.
- 0012 (assessments / preflight), the worker, the adapter, entrypoints and any schedule are **not** implemented.
- Where this section and §0–§12 differ, this section describes the code.

### Objects (`db/migrations/0011_recording_owner_cases.{up,down}.sql`)

| Object | Notes |
|---|---|
| **Tables** `recording_holds`, `recording_hold_decisions`, `recording_hold_observations`, `recording_conflict_inbox` | RLS on; SELECT-only for `mv_booking_app` / `_admin` / `_report`; no write grant to any role; `reject_change` on DELETE / TRUNCATE (UPDATE too for decisions / observations); INVOKER guards (`*_guard`) on INSERT / UPDATE. No `assessment_id` column / FK and no preflight reason (0012). |
| **Inbox constraints** (addendum B) | `processed_at` iff `outcome`; `hold_id` NOT NULL **iff** a contradiction outcome; `attempts = 0` iff `last_error` / `last_attempt_at` NULL. Guard: an error attempt changes only `attempts + 1`, `last_error` and `last_attempt_at`; success sets `processed_at` / `outcome` / `hold_id` once and freezes the row. A contradiction outcome must cite the hold that observed that evidence. |
| `reserved_case_guard` (INVOKER, cases INSERT / UPDATE) | Reserved `OFFLINE_CHARGE_HOLD_*` kinds: only privileged INSERT, only the three 0011 kinds, opened `open`, `opened_by = 'recording-hold:'||<case id>`. On UPDATE, identity (`id`, `intent_id`, `kind`, `opened_by`, `opened_at`, `evidence`) is frozen, a normal kind cannot become reserved, and a resolved hold case is final. |
| `reserved_case_binding_verify` / `_check` (SD, private) + DEFERRABLE INITIALLY DEFERRED constraint triggers on **cases and holds** (addendum A) | At COMMIT, for every touched reserved case: **≥ 1 bound hold** (open *or* resolved); every bound hold matches intent and kind; open **iff** some bound hold is active; resolved only as `recorded`; every released hold cites its own `link_full_proof` decision (same hold / case / op). |
| `recording_evidence_contradicts(intent, dispatched_at, result_ref, reference, evidence)` (SD, private) | The 0010 row condition (0010:141–159), copied verbatim from the 0010 file by the generator and bound to one row. Inputs are validated; it **raises** `CONFLICT_CHECK_INPUT`. |
| `recording_conflict_refusal` (CREATE OR REPLACE; same signature) | Count over the core. 0010's input handling is kept: it **returns** `'CONFLICT_CHECK_INPUT'`. Completion / link (candidate reference), finalisation (linked) and the admin `link_full_proof` (candidate) all call it. |
| `complete_recording_with_evidence`, `link_recording_evidence`, `recording_finalisation_guard` (CREATE OR REPLACE) | The 0010 bodies verbatim + one `-- 0011` "no active hold" check (`RECORDING_HOLD_ACTIVE`). In the link it comes **after** the read-only `already_linked` return (a replay never mutates) and before the proof check; in finalisation, after the advisory lock. |
| `intents_safety_guard` (CREATE OR REPLACE of the 0004 body) | One change: the bulk resolution on leaving `reconciliation_required` adds `AND NOT starts_with(kind, 'OFFLINE_CHARGE_HOLD_')`. |
| `admin_close_case` (CREATE OR REPLACE of the 0003 body) | Refuses hold cases (`HOLD_CASE_USE_ADMIN_RESOLVE_RECORDING_HOLD`) before any write. |
| `recording_claim_fence` (SD trigger, `pending → in_flight` recordings) | The §5.4 conditions, incl. **no active hold and no open reserved case** (O6). |
| `open_recording_visibility_hold(op, reason, by)` (app + admin) | `ATTEMPT_GT1` / `SUCCEEDED_UNPROVEN`. Lock order intent SHARE → op UPDATE → advisory → active hold → open same-kind case, then `v_t`. Idempotent; joins an open same-kind case. |
| `recording_inbox_enqueue` + `zz1_evidence_enqueue` (AFTER INSERT, offline kind) | Enqueues inside the writer's INSERT (before the writer's advisory lock). Backfill: `INSERT … SELECT` at the end of up (same transaction). |
| `process_recording_conflict_inbox_one(by)` (app + admin) | §5.3; one item; subtransaction; error accounting. |
| `recording_contradictions_page(after_exact, after_evidence, after_op, limit)` (app + admin; read-only) | The JS caller keeps its validation / clamp / `next` (`lib/booking-db/operations.js`). The SQL also validates the cursor (`RECORDING_SCAN_CURSOR_INVALID`). It additionally requires `result_ref` / `dispatched_at` NOT NULL on the linked row; a linked row always has both, so the rows are unchanged (T-P3 parity). |
| `admin_resolve_recording_hold(hold, decision, evidence[], linked_evidence, resolver, justification, at)` (admin only) | `keep_visible`: evidence may be empty; an identical resubmission returns the earlier id. `link_full_proof` (`SUCCEEDED_UNPROVEN` only): proof validator (`owner_historical`) at `v_t` + candidate-reference conflict check; decision + link + release + (last-hold) case resolution in one transaction; does not call `link_recording_evidence`; no bypass input. A same-proof replay on the released hold returns the earlier decision id. The case `resolved_at` is `v_t` (DB time). |
| Down | Precondition: no hold / observation / decision, and no inbox item with `attempts > 0` or `processed_at`. Then the replaced 0010 / 0004 / 0003 bodies are restored verbatim. Measured: the schema equals a fresh cluster at 10 (bodies, ACLs, triggers, columns, grants, policies, constraints). |

### Deviations from R2 (all three accepted by root at the `cd77088` review)

| # | Deviation |
|---|---|
| 1 | `LINKED_CONTRADICTED` opens for **any** intent state of a linked latest recording; §3 is updated. Accepted as a conservative extension: it still requires the latest succeeded linked recording and the exact shared positive predicate, and changes no intent / version / effect / link. Regression T-C10 covers a linked booking moved to `reconciliation_required` through the supported ESCALATE path. |
| 2 | The drain helper stops a run when the **same SQL-recorded item error** happens twice in that run (`stoppedOnRepeatedError`). The item stays queued with its attempts and audit; this is not a complete drain and carries no latency claim. Accepted. |
| 3 | `scripts/db-smoke.mjs`: the 4 tables `[SELECT]` in its exact privilege matrix and the table count 18 → 22. Accepted as necessary validation maintenance; no role grant is widened. |
| 4 | The admin helper is `db/lib/admin.js` → `adminResolveRecordingHold` (the existing admin module). |

### Helpers

`lib/booking-db/operations.js`:
- `RECORD_FENCE` in **both** claim stages;
- `listRecordingContradictions` is a thin caller of the page function;
- `openRecordingVisibilityHold`;
- `drainRecordingConflictInbox(pool, { by, maxCalls ≤ 100 })`: requires a `pg.Pool`; independent autocommit calls; no retries.
  - SQL-recorded item errors are returned data, accumulated in `errors` under the bound.
  - A **thrown** call (outer failure) stops the run at once and **re-throws the original error object** unchanged. Bounded partial progress is attached as a non-enumerable `err.drainProgress = { calls, processed, errors }`, and no further query is issued. (Root R1 at `cd77088`; the earlier `failures` accumulation is removed.)
  - **Precision (root, at the `34f0314` review).** A server-rejected statement marks nothing. A connection lost around `COMMIT` leaves that call's processing outcome **unknown** to the caller (it may have committed), so `drainProgress` covers only calls whose replies arrived. Safe follow-up is a read-only inspection of the inbox row; there is no exactly-once transport guarantee and no automatic retry.
  - **Erratum (root R6 at the `44ca7df` review).** The SQL comment at `db/migrations/0011_recording_owner_cases.up.sql:653` still uses the categorical "marked nothing" wording; read it with the precision above. Migrations 0001–0011 are **never edited**, not even comments, so it stays an erratum. The `operations.js` comment was corrected by the 0012 helper change (`feature/e7-offline-charge-assessments`). See the preflight contract §12 / §14.
  - T-H3 covers a first-call failure and a failure after one processed item, with exact query counts and the remaining items untouched;
- `linkRecordingEvidence(…, { openVisibilityHoldOnConflict })`: an optional **separate** best-effort hold, exactly one attempt, never retried. The original `RECORDING_EVIDENCE_CONFLICT` result is always returned, with `visibilityHold` beside it:
  - the opener's result;
  - its known refusal code;
  - for any other failure of that optional call, `{ ok:false, error:'VISIBILITY_HOLD_CALL_FAILED', code }`, where `code` is a SQLSTATE / errno only, with no server or connection message.

  Errors of the primary link call are not caught. This is not DB-atomic with the link. (Root R2 at `cd77088`; T-L1 covers success, a known refusal, an outer error, the option disabled, and a primary outer error.)

`lib/booking-db/repo.js`:
- `DB_SAFETY_CODES` additions;
- the `OFFLINE_CHARGE_RECORDED` mirror returns `RECORDING_HOLD_ACTIVE`.

### Caller contract (addendum C)

`process_recording_conflict_inbox_one` is a top-level transaction **only in autocommit**. The database cannot stop a caller from wrapping several calls in one `BEGIN`. Locks then accumulate, and T-H2 shows the resulting A,B / B,A 40P01, which is caught in the item's subtransaction and recorded as an attempt. The supported helper uses a real pool.

### Existing tests adapted (and why)

| File | Change |
|---|---|
| `offline-charge.test.mjs` "definite failure … bounded retry" | Attempts 2–3 can no longer be claimed automatically (fenced). They are settled as **owner-managed history** via `F.ownerManagedHistory` (schema owner, triggers bypassed, labelled TEST SETUP). The test still proves E3 creates a new single-attempt row each time. |
| `e74b-d2` "policy … attempt 2" | Attempt 2 is written as inherited / owner-managed in-flight history instead of dispatched through the fenced path; the fence refusal is asserted first. |
| `e74b-d2` downgrade test | 0011 rolls back first (that file holds no owner-hold audit), then 0010 refuses; 0011 is re-applied. |
| `migrations.test.mjs` | Lists extended to 11; table count 22; new 0011 round-trip test. |
| `guests` / `intents` table counts | 22. |

### Tests

`test/db/e74b-d1-owner-cases.test.mjs`, 26 tests: T-A1–A3, T-B1–B4, T-P1–P3, T-C1–C10, T-H1–H3, T-L1, T-D1–D3, T-E1–E2, T-G2–G3. Plus the 0011 round trip in `migrations.test.mjs` (T-G1).

**Observed lock behaviour (measured in these tests; not a universal claim):**

| Test | Observed |
|---|---|
| T-C5 / T-D2 | a waiter on `transactionid` / `tuple` (op row lock) |
| T-H1 | a same-intent processor waits on `advisory` only; another intent's item is processed without waiting (SKIP LOCKED) |
| T-H2 | the explicit-transaction A,B / B,A interleaving produced a 40P01 that was caught and recorded (`attempts 1`, `last_error 40P01…`); autocommit drains in parallel had no error |
| T-B3 | the direct-UPDATE inversion produced one 40P01 (`["ok","40P01:deadlock detected"]` in both runs); the fenced row never went `in_flight` |

**Fault injection** (each protection removed in turn, then the focused tests re-run): 15 of 15 detected. These are the ≥1-hold rule, the open-iff-active rule, the guard exclusion, the `admin_close_case` refusal, the fence hold check, the whole fence attempt rule, the link hold check, the core method comparison, the enqueue trigger, `SKIP LOCKED`, the `link_full_proof` conflict check, last-hold case resolution, `keep_visible` idempotence, and the JS mirror in both stages.

Two partial mutations survived, each because a second, independent check also refuses:
- the fence key / attempts clause alone (`offline_charge_attempts` still refuses);
- the JS mirror in one stage only (the re-check stage still skips).

### Residual limits

- **Not guaranteed:**
  - no processing latency is guaranteed, and nothing is scheduled;
  - an item that fails repeatedly waits behind fresh ones indefinitely (visible through `attempts` / `last_error`);
  - visibility for a link refused **before** linking depends on a helper calling the opener; it is not a DB guarantee.
- **Not attested:** classification / client / account provenance stays [TRUST].
- **Not built:** owner release or close of `ATTEMPT_GT1` / `LINKED_CONTRADICTED` does not exist (O2). Their cases stay open and keep blocking guest-data purge and claim release.
- **Still open:** O7, 0012, the worker, live gates, the `paymentMethod` choice, and the unexplained e74a guard failure.
