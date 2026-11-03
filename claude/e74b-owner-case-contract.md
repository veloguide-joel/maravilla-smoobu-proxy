# E7.4b-D1: durable owner-case contract for Hostaway payment recordings (DESIGN ONLY)

**Branch and base.** `feature/e7-offline-charge-owner-case-contract`, cut from exact `abdcf91`.
- Migration 0010 is **PRESENT**: root accepted it offline at `d801b43`.
- **This document governs D1.** It consolidates and supersedes the still-proposed D1 parts of `claude/e74b-db-evidence-case-contract.md`: §3.11 (later conflict), §4, the D1 rows of §7, the 0011 part of §8, and the D1 tests of §9 / §11.

**Nothing here is implemented, applied or authorized.**
- No executable migration, helper, worker or adapter change is made.
- Dispatch, live gates and the owner `paymentMethod` choice stay blocked.
- There is no automatic resend, no automated attempt > 1, and no ESCALATE, cancel, void, refund or real notification.

**Labels.**
- **[PRESENT]**: code at `abdcf91`, cited as path:line.
- **[PROPOSED]**: this design.
- **[TRUST]**: an input the database cannot attest.
- **[OUTSIDE]**: needs a separate root authorization.

---

## 1. Present baseline (inspected at abdcf91)

| Fact | Where |
|---|---|
| **Cases.** `reconciliation_cases`: one **open** case per `(intent_id, kind)` (unique partial index); no delete. Resolution values: `confirmed`, `released`, `cancelled`, `refunded`, `recorded`, `no_action`. | `db/migrations/0001_booking_core.up.sql:536–551` |
| **App case grants.** The app has SELECT / INSERT on cases; UPDATE was revoked; non-privileged UPDATE is refused. **⇒ the app can INSERT any case kind.** | 0002:23–27, 0003:675, 0003:462–470 |
| `openCase` uses `ON CONFLICT (intent_id, kind) WHERE status='open' DO NOTHING`, which drops silently. It is used by `markUnknown` for `OFFLINE_CHARGE_OUTCOME_UNKNOWN` (case `opened_by = 'op:<id>'`). | `lib/booking-db/operations.js:22–34`, 267–289 |
| `admin_close_case` refuses `opened_by LIKE 'op:%'`; otherwise it resolves `no_action` with a resolution row. | 0003:640–656 |
| Owner resolutions: `reconciliation_resolutions`, append-only. | 0003:104–123 |
| An open case blocks guest-data purge. | 0001:604 |
| At most **one** open recording per intent (`pending`, `in_flight`, `outcome_unknown`, `escalated`). | 0001:396–397 |
| A new recording only after earlier ones are owner-resolved or catalogued failed. | 0004:74–112 |
| E3 queues attempt `n+1` after `OFFLINE_CHARGE_FAILED`, up to `maxOfflineChargeAttempts`. | `lib/checkout/intent-state.js:598–603`; key `och:<intent>:<n>` at `lib/booking-db/repo.js:105` |
| **No recording claim fence.** `claimNextOperation` claims any pending recording, attempt 2 included (the D2 tests claim attempt 2). It sets `dispatched_at` and `lease_until` from the **caller** clock. | `operations.js:74–108`; fences only for capture / create / void / cancel (0007, 0009) |
| `applyEvent` locks the intent `FOR NO KEY UPDATE` first. | `repo.js:350` |
| **Evidence.** `provider_evidence`: append-only; `created_at DEFAULT now()` (**transaction start**, not commit order); `observed_at` = read `completed_at` (caller) or the owner-supplied time. The app has no INSERT; writes go only through `record_provider_evidence` / `admin_record_evidence`. Offline-charge evidence always has `matchingChargeCount` + `matchingChargeIds`. | 0003:52–76, 0003:92–97; 0010:354–404 |
| **0010 (PRESENT):** | |
| – conflict predicate `recording_conflict_refusal(intent, dispatched_at, result_ref, reference)`: reservation-scoped; method / account compared to the reference | 0010:117–162 |
| – `complete_recording_with_evidence` (initial attempt only) | 0010:250–288 |
| – `link_recording_evidence` | 0010:293–322 |
| – finalisation trigger | 0010:332–350 |
| – lifecycle guard | 0010:166–247 |
| – writers take the advisory key `(hashtext('booking.recording_evidence'), hashtext(intent))` after their INSERT | 0010:386–387, 402–403 |
| 0010 read-only scan `listRecordingContradictions`: lossless cursor `{observedAtExact, evidenceId, opId}`, latest linked recording only, ≤ 500 rows. | `operations.js:171–224` |
| `admin_resolve_operation` (recording `succeeded` accepts dashboard count-1 evidence ≥ 15 min; never sets a link). It locks the op, then reads the intent unlocked. | 0005:296–384 (recording branch 327–339) |

---

## 2. Design choices (summary)

1. **One op-bound "hold" record plus one case.** A hold is the op-bound identity. The case is the existing `(intent, kind)` owner-visibility identity.
   - Holds never change intent state, op state or `dispatched_at`, and never queue effects.
2. **Five hold reasons.** Three are derived **entirely from database facts**: `ATTEMPT_GT1`, `SUCCEEDED_UNPROVEN`, `LINKED_CONTRADICTED`. Only the preflight reasons depend on trusted worker classification.
3. **Later conflicts use a durable ingest inbox, not a forward cursor.**
   - An `AFTER INSERT` trigger on offline-charge evidence enqueues the evidence id in the **same transaction**.
   - A bounded processor drains the inbox with `SKIP LOCKED`.
   - So no evidence is missed, whatever its `observed_at` or `created_at`, including late-inserted historical dashboard evidence.
4. **One predicate.** 0011 factors the 0010 predicate into a per-row function. The 0010 count function, the inbox processor and the scan all use it. Nothing forks.
5. **Owner resolution is truthful.** Acknowledging or closing never makes contradictory evidence disappear and never unblocks finalisation. Override or manual finalisation is [OUTSIDE].
6. **Staging.**
   - **0011** = visibility holds (DB-derived) + inbox + base claim fence + reserved-kind guard.
   - **0012** = preflight assessments + preflight holds + the fresh-eligible requirement on the fence.
   - 0011 has no trusted worker input. It closes the open prerequisite and the attempt-2 claim gap.

---

## 3. Hold reasons and targets [PROPOSED]

| Reason (case kind = `OFFLINE_CHARGE_HOLD_<reason>`) | Target row when opened (latest recording of the intent) | Intent state | Opened by | Stage |
|---|---|---|---|---|
| `ATTEMPT_GT1` | `pending`, key attempt > 1, `dispatched_at` NULL | `payment_captured` | `open_recording_visibility_hold` (DB-derived) | 0011 |
| `SUCCEEDED_UNPROVEN` | `succeeded`, `settled_evidence_id` NULL, `result_ref` set | `payment_captured` or `confirmed` (inherited; visibility only) | `open_recording_visibility_hold` | 0011 |
| `LINKED_CONTRADICTED` | `succeeded`, linked; at least one evidence row for which `recording_evidence_contradicts(op, e)` is true | `payment_captured` or `confirmed` | inbox processor only | 0011 |
| `PREFLIGHT_EXHAUSTED` | `pending`, key `:1`, `attempts = 0`, `dispatched_at` NULL; ≥ 3 non-eligible preflight assessments in the current epoch | `payment_captured` | `open_recording_preflight_hold` (worker) | 0012 |
| `PREFLIGHT_CONFLICT_MARKER` / `_LOOKALIKE` / `_SAME_AMOUNT` | same row + a cited current-epoch assessment with that outcome | `payment_captured` | `open_recording_preflight_hold` | 0012 |

**Not holds.**
- **A dispatched send whose outcome is unknown** (`in_flight` past its lease, `outcome_unknown`, `escalated`) stays on the existing owner-only path: `OFFLINE_CHARGE_OUTCOME_UNKNOWN` case → `admin_resolve_operation`.
- D1 never fakes `dispatched_at` or `outcome_unknown` to raise an alert.
- If the owner resolves `succeeded` from count-only or dashboard evidence, the row becomes eligible for `SUCCEEDED_UNPROVEN`.

---

## 4. Objects, guards and grants [PROPOSED]

Every new table:
- has RLS enabled with **no app / admin write policy** (writes only inside schema-owner SECURITY DEFINER functions);
- has SELECT policies for `mv_booking_app`, `mv_booking_admin` and `mv_booking_report`;
- has `reject_change` on DELETE / TRUNCATE.

### 4.1 `booking.recording_holds`

| Column | Notes |
|---|---|
| `id uuid PK` | pre-allocated by the opening function |
| `operation_id uuid NOT NULL → external_operations`, `intent_id uuid NOT NULL → intents` | the intent must equal the op's intent (guard) |
| `reason text NOT NULL` | CHECK in the §3 set |
| `case_id uuid NOT NULL UNIQUE → reconciliation_cases` | immediate FK; the case is inserted first |
| `op_state_at_hold`, `op_key_at_hold`, `intent_state_at_hold`, `intent_version_at_hold` | snapshot at `v_t` |
| `epoch int NOT NULL` | 0011 reasons: 0 |
| `assessment_id uuid NULL → recording_assessments` | 0012 preflight conflict reasons only |
| `created_at timestamptz NOT NULL` | the function's post-lock `v_t` |
| `created_by text NOT NULL` | worker label or `'inbox'` [TRUST label] |
| `released_at`, `release_decision`, `release_resolution_id → reconciliation_resolutions` | NULL → value **once** |

Constraints and guard:
- `UNIQUE (operation_id) WHERE released_at IS NULL` (one active hold per op).
- Guard (BEFORE UPDATE, INVOKER): every identity column frozen; release columns NULL → non-NULL once, only when `is_privileged()`. **Never un-released.**

### 4.2 `booking.recording_hold_observations` (append-only)

- Columns: `id`, `hold_id → recording_holds`, `evidence_id → provider_evidence`, `observed_kind` (`contradiction` | `acknowledged`), `resolution_id` NULL, `recorded_at` (`v_t`).
- `UNIQUE (hold_id, evidence_id) WHERE observed_kind = 'contradiction'`.
- One row per contradictory evidence row per hold. New contradictions append here; nothing overwrites case `evidence`.

### 4.3 `booking.recording_conflict_inbox`

- Columns: `seq bigint GENERATED ALWAYS AS IDENTITY`, `evidence_id uuid PK → provider_evidence`, `intent_id`, `enqueued_at` (`clock_timestamp()` in the trigger), `processed_at` NULL, `outcome` NULL, `hold_id` NULL, `attempts int DEFAULT 0`, `last_error text`.
- `outcome` ∈ `not_latest_linked`, `consistent`, `contradiction_opened`, `contradiction_appended`, `contradiction_duplicate`.
- Guard: only `processed_at`, `outcome`, `hold_id`, `attempts`, `last_error` may change, privileged only; `processed_at` is set once.
- **Trigger:** `zz1_evidence_enqueue_offline_charge`, `AFTER INSERT ON provider_evidence FOR EACH ROW WHEN (NEW.kind = 'hostaway_offline_charges')`, SECURITY DEFINER. It inserts the inbox row.
  - Both evidence writers are already schema-owner functions (0010:354–404), so the enqueue is atomic with the evidence: either both commit or neither does.

### 4.4 `booking.recording_assessments` (0012)

The columns and rules are in §6.

### 4.5 Reserved case kinds (0011)

- `OFFLINE_CHARGE_HOLD_%` is **reserved**. The broad app INSERT grant (0002:23–27) stays.
- **BEFORE INSERT trigger** on cases: a reserved kind requires `is_privileged()` and `opened_by = 'recording-hold:' || id`.
- **DEFERRABLE INITIALLY DEFERRED constraint trigger** on cases, AFTER INSERT: at commit, a reserved-kind case must be referenced by exactly one `recording_holds.case_id`.
  - `is_privileged()` is also true inside *other* granted owner functions (contract §1.2), so the deferred binding is what actually proves the hold function wrote it.
- `admin_close_case` (CREATE OR REPLACE): refuse `opened_by LIKE 'recording-hold:%'` → `HOLD_CASE_USE_ADMIN_RESOLVE_RECORDING_HOLD`.
- `openCase`, and its silent `ON CONFLICT DO NOTHING`, is **unchanged**. No D1 function uses it.

### 4.6 Grants

| Function | App | Admin |
|---|---|---|
| `open_recording_visibility_hold` (0011) | EXECUTE | EXECUTE |
| `process_recording_conflict_inbox` (0011) | EXECUTE | EXECUTE |
| `admin_resolve_recording_hold` (0011) | — | EXECUTE |
| `record_recording_assessment`, `open_recording_preflight_hold` (0012) | EXECUTE | — |
| private helpers (`recording_evidence_contradicts`, the fence, the guards) | — | — |

All functions have `REVOKE ALL FROM PUBLIC`. There is no general app case writer.

---

## 5. Functions (0011) [PROPOSED]

Every function follows the same uniform lock order (§9):

> intent → (intent_work) → recording op → advisory evidence key → hold rows → case

It samples `v_t := clock_timestamp()` **after the last lock** and uses only `v_t` for time decisions. Refusals raise with no partial write: one transaction, case and hold inserted together or not at all.

### 5.1 Shared predicate (no fork)

`recording_evidence_contradicts(p_op uuid, p_evidence uuid) RETURNS boolean` (VOLATILE, SD, private):
- the exact 0010 per-row condition (0010:141–159), with reference = the op's `settled_evidence_id`;
- `dispatched_at` and `result_ref` taken from the op row.

`recording_conflict_refusal` is redefined (same signature and result) as a count over the same row condition, with an explicit reference argument.
- An equivalence test pins identical results on the 0010 test fixtures.
- The JS scan (`operations.js:182–224`) is replaced by a granted read-only SQL function, `recording_contradictions_page(after…, limit)`, built on the same predicate. Same lossless cursor and result shape. This is a helper change in the same stage.

### 5.2 `open_recording_visibility_hold(p_op uuid, p_reason text, p_by text) RETURNS uuid`

`p_reason` ∈ {`ATTEMPT_GT1`, `SUCCEEDED_UNPROVEN`}. There is no worker lease, version or caller time: the result is derived from facts and touches nothing but the hold and case.

1. Pre-allocate `hold_id` and `case_id`.
2. Locks: intent `FOR SHARE` → op `FOR UPDATE` → advisory → active hold for op `FOR UPDATE` → `v_t`.
3. Checks:
   - op is a recording, and is `recording_latest_id(intent)`;
   - `ATTEMPT_GT1`: `pending`, key attempt > 1, `dispatched_at` NULL, intent `payment_captured`;
   - `SUCCEEDED_UNPROVEN`: `succeeded`, `result_ref` set, link NULL, intent ∈ {`payment_captured`, `confirmed`}.
4. **Idempotence:** an active hold for op with the same reason → return its id (no write). A different reason → `HOLD_ALREADY_ACTIVE`.
5. INSERT the case (`kind 'OFFLINE_CHARGE_HOLD_'||reason`, `opened_by 'recording-hold:'||hold_id`, `opened_at v_t`; evidence `{operationId, reason, opKey, opState, intentVersion}`), then INSERT the hold. A unique violation on the open case → **raise `CASE_KIND_OCCUPIED`**; the transaction rolls back (never `DO NOTHING`).
   - This is impossible by design: reserved kinds are only written here, one open recording per intent (0001:396), and one active hold per op.

### 5.3 `process_recording_conflict_inbox(p_by text, p_limit int) RETURNS jsonb`

`p_limit` is clamped to 1…100. It returns counts per outcome. It loops over `SELECT … FROM recording_conflict_inbox WHERE processed_at IS NULL ORDER BY attempts, seq FOR UPDATE SKIP LOCKED LIMIT p_limit`. **Each row runs in its own subtransaction** (plpgsql `BEGIN … EXCEPTION`):

1. Locks: intent `FOR SHARE` → latest recording `FOR SHARE` → advisory → active hold for op `FOR UPDATE` → `v_t`.
2. If the latest recording is not `succeeded` + linked → `not_latest_linked`.
   - Such evidence is still judged by 0010 at completion, link or finalisation, because it is committed before its inbox row is visible.
3. Else, if `NOT recording_evidence_contradicts(op, e)` → `consistent`.
4. Else, contradiction:
   - an active `LINKED_CONTRADICTED` hold for op → append an observation (`contradiction_appended`; a unique hit → `contradiction_duplicate`, no new row);
   - an active hold with another reason → impossible for a linked row; raise `HOLD_STATE_UNEXPECTED` (row error, see below);
   - none → pre-allocate ids; case first, hold, first observation → `contradiction_opened`.
5. Set `processed_at = v_t`, `outcome`, `hold_id`.
6. **Row error:** the subtransaction rolls back; `attempts + 1` and `last_error = SQLSTATE` are written. The row stays **unprocessed**. It is never dropped, and it is retried in later calls, ordered behind fresh rows.

**Delivery semantics.**
- Effects happen at least once (the row is marked in the same transaction as its effects).
- Re-processing is idempotent (observation uniqueness, one active hold per op).
- No exactly-once *observation* is claimed.

### 5.4 Finalisation, link, completion and fence additions (0011)

- **Finalisation trigger** (0010:332–350, CREATE OR REPLACE): additionally refuse if an **active hold** exists on the latest recording → `RECORDING_HOLD_ACTIVE`. Defence in depth: for `SUCCEEDED_UNPROVEN` and `LINKED_CONTRADICTED`, 0010 already refuses.
- **`link_recording_evidence`:** refuse while a hold is active (`RECORDING_HOLD_ACTIVE`). Only the owner's `link_full_proof` (§7) can attach proof to a held row.
- **`complete_recording_with_evidence`:** refuse while a hold is active. A held op is `pending`, so it is not reachable anyway.
- **Recording claim fence** `recording_claim_fence()`: SECURITY DEFINER trigger, `BEFORE UPDATE … WHEN (OLD.state='pending' AND NEW.state='in_flight' AND NEW.op_type='hostaway.record_offline_charge')`. This is the **only** gate for every claim path: helper generic / `opId` / `intentId`, and direct app UPDATE. Under intent `FOR SHARE` it refuses unless:
  - the intent is `payment_captured` and `captured_minor = final_total_minor`;
  - payload `reservationId` = `hostaway_reservation_id`, and payload `amountMinor` = `captured_minor`;
  - key `och:<intent>:1`, `OLD.attempts = 0`, `OLD.dispatched_at IS NULL`, and intent `offline_charge_attempts = 0`;
  - the op is `recording_latest_id`;
  - there is **no active hold** for the op, and **no open `OFFLINE_CHARGE_HOLD_%` case** for the intent (fail closed);
  - 0012 adds: a fresh eligible preflight assessment (§6).
- `claimNextOperation` gets a mirroring `RECORD_FENCE` SQL fragment in its candidate and re-check queries, so fenced rows are skipped instead of raising. This is a helper change in the same stage.

---

## 6. Assessments (0012) [PROPOSED]

`recording_assessments` columns:
- `id`, `operation_id`, `intent_id`, `phase` (`preflight` only in 0012), `outcome`, `code`;
- `identity_read_op`, `list_read_op`, `identity_evidence`, `list_evidence`;
- `epoch`, `intent_version`, `worker`, `module_version`, `recorded_at = v_t`.

**One read opportunity is counted once:**
- `UNIQUE (identity_read_op) WHERE NOT NULL`;
- `UNIQUE (list_read_op) WHERE NOT NULL`.

So repeating without a new read is refused. An incomplete read counts as a read: it cites the read with no evidence.

| Outcome | Required bindings | DB consistency check |
|---|---|---|
| `eligible` | identity read `hostaway.retrieve_reservation` `succeeded` + its `hostaway_reservation` evidence; list read `hostaway.list_offline_charges` `succeeded` + its evidence; both evidence `observed_at` in `[v_t − 2 min, v_t]` | list evidence `matchingChargeCount = 0`; identity evidence `external_ref` = reservation |
| `conflict_marker` | list read `succeeded` + evidence | `matchingChargeCount ≥ 1` |
| `conflict_lookalike`, `conflict_same_amount` | list read `succeeded` + evidence | none possible [TRUST classification] |
| `incomplete` | list read terminal, **no** list evidence | read is terminal |
| `identity_refused` | identity read terminal; no list read | read is terminal |

**Every read must be:**
- on the same intent, of the right op type;
- `created_at` ≥ the recording's `created_at`, and ≥ the current epoch start (the latest release `released_at`, else the recording's `created_at`);
- terminal;
- cited evidence must have `read_operation_id` = that read.

**`record_recording_assessment(p_op, p_worker, p_phase, p_outcome, p_code, p_identity_read, p_list_read, p_identity_evidence, p_list_evidence, p_expected_version, p_module_version)`**
- Locks: intent `FOR SHARE` → `intent_work FOR SHARE` → op `FOR SHARE` → the cited read rows `FOR SHARE` → `v_t`.
- Checks:
  - intent `payment_captured`, and `version = p_expected_version`;
  - `work_worker_id = p_worker` and `work_lease_until ≥ v_t`;
  - op `pending`, undispatched, key `:1`, `attempts 0`, latest, **no active hold**.
- **[TRUST]:** the classification, the client and account provenance, and `module_version`.

**Epochs.**
- `epoch` = the number of released preflight holds for the op, computed under the op lock.
- Exhaustion counts non-eligible preflight assessments **in the current epoch** only (≥ 3).

**Fence addition (0012).** The claim also requires the op's latest assessment (by `recorded_at`, then `id`) in the current epoch to be `eligible`, with both evidence `observed_at` in `[v_t − 2 min, v_t]` at the fence's `v_t`.
- A worker cannot skip preflight by not recording it.
- Attempt 1 is claimed at most once (`attempts = 0`), so no assessment is reused across claims.

**`open_recording_preflight_hold(p_op, p_worker, p_reason, p_expected_version, p_assessment)`**
- Same as §5.2, plus the work lease and version checks at `v_t`.
- `EXHAUSTED`: current-epoch count ≥ 3.
- Conflict reasons: the cited assessment is for this op, in the current epoch, with the matching outcome, and recorded after the latest release.

---

## 7. Owner resolution (0011; preflight decisions 0012) [PROPOSED]

`admin_resolve_recording_hold(p_hold, p_decision, p_evidence uuid[], p_assessment uuid, p_resolver, p_justification, p_at)`:
- admin only;
- locks: intent `FOR SHARE` → op `FOR UPDATE` → advisory → hold `FOR UPDATE` → case `FOR UPDATE` → `v_t`;
- always inserts a `reconciliation_resolutions` row citing evidence (needs a decision value `recording_hold`, added to the 0003:107–108 CHECK by 0011);
- `p_at` is the owner-asserted decision time [TRUST]; `v_t` is stored for ordering.

| Decision | Allowed reasons | Hold / case | Truthful effect |
|---|---|---|---|
| `keep_visible` | all | hold **active**, case **open**; adds an `acknowledged` observation | nothing unblocked; later contradictions keep appending |
| `close_acknowledged` | `LINKED_CONTRADICTED`, `SUCCEEDED_UNPROVEN`, `ATTEMPT_GT1` | hold released (`acknowledged`); case resolved `no_action` | **unblocks nothing.** The 0010 predicate still refuses finalisation (the evidence is immutable); an unlinked row still cannot finalise. A *new* contradiction opens a new hold and case. |
| `link_full_proof` | `SUCCEEDED_UNPROVEN` | released; case resolved `recorded` | attaches the link through the 0010 validator (`owner_historical`) and the predicate in the same transaction. Finalisation is then E3's normal event. |
| `release_for_initial_send` (0012) | `PREFLIGHT_*` | released; case resolved `no_action`; **new epoch** | `p_assessment` must be preflight `eligible`, for this op, at `intent_version = hold.intent_version_at_hold = current version`; reads created after `hold.created_at`; both evidence `observed_at` in `[v_t − 2 min, v_t]`. It does not claim; the fence still decides. |
| `recorded_manually` (0012) | `PREFLIGHT_*`, `ATTEMPT_GT1` | released; case resolved `recorded` | op `pending → superseded` (an existing move, 0004:45–72). The intent stays `payment_captured`. |

Never offered: `ATTEMPT_GT1` release for sending; any decision on `LINKED_CONTRADICTED` that reverses or repoints the link or changes intent state.

**[OUTSIDE]:**
- an owner override of the contradiction guard;
- owner manual finalisation (after `recorded_manually` or `close_acknowledged`);
- any refund, cancel or notification.

---

## 8. Later-conflict detection: why an inbox, and what it does not promise

- **Why not a forward cursor.** A forward `observed_at` cursor misses historical owner evidence inserted later with an old `observed_at`. A `created_at` cursor misses rows from long transactions, because `created_at` is the **transaction start** (0003:67), not commit order.
  - The trigger-fed inbox avoids both: every offline-charge evidence row gets its inbox row in the same transaction, and the processor selects unprocessed rows, not a range.
- **Ordering with the link.**
  - Evidence committed **before** a link is seen by the link's post-advisory predicate (0010), so it refuses.
  - Evidence committed **after** the link is enqueued, and judged against the immutable linked proof.
  - There is no gap in which a linked row's contradiction is never judged (inferred from the 0010 lock order; to be tested in T-C5).
- **Backfill.** 0011 up enqueues every existing offline-charge evidence row (plain INSERT … SELECT in the migration, on a disposable local DB only). The first drains therefore cover rows linked under 0010.
- **Cross-check.** `recording_contradictions_page` (the reused lossless 0010 cursor) stays a read-only audit query. A finding without a `LINKED_CONTRADICTED` hold observation is a defect signal for the owner, not a writer.
- **Scope and backlog.**
  - The processor is unscoped by listing: it is DB-only and touches only holds, cases and observations.
  - Bounded at 100 rows per call; concurrent callers are safe (SKIP LOCKED).
  - Backlog = `count(*) WHERE processed_at IS NULL` (owner-visible). Failing rows persist with `attempts` and `last_error`.
  - Restart or crash: the uncommitted row rolls back and is redone.
  - **No schedule is created.** Running it live is [OUTSIDE].
- **Time.**
  - `processed_at` and hold `created_at` = `v_t`.
  - Evidence `observed_at` remains caller- or owner-supplied [TRUST].
  - The window test `observed_at > dispatched_at` compares two caller-written times, as in 0010.

---

## 9. Lock order and contention

| Path | Order | Contention outcome |
|---|---|---|
| `claimNextOperation` + fence | intent SHARE → op UPDATE SKIP LOCKED → (trigger) intent SHARE (held), holds / cases / assessments read → `v_t` | serialized; a fenced row is skipped by the mirrored fragment |
| direct app `UPDATE … in_flight` | op UPDATE → (trigger) intent SHARE | vs `applyEvent` (intent NO KEY UPDATE → op): a possible **40P01** on one side. Bounded and retryable, never a bypass (the accepted 0007 / 0009 stance). |
| `complete_recording_with_evidence`, `link_recording_evidence` (0010) | intent SHARE → (work SHARE) → op UPDATE → advisory → `v_t`, + hold read | serialized with the D1 functions via op and advisory |
| `open_recording_visibility_hold`, `open_recording_preflight_hold` | intent SHARE → (work SHARE) → op UPDATE → advisory → hold → case INSERT | same order as link; the loser waits, then re-checks and refuses or returns the existing hold |
| `process_recording_conflict_inbox` | inbox UPDATE SKIP LOCKED → intent SHARE → op SHARE → advisory → hold → case | inbox rows are touched only by the trigger INSERT and this function; no cycle |
| `admin_resolve_recording_hold` | intent SHARE → op UPDATE → advisory → hold → case | uniform order (an advisory-before-hold violation would cycle with the processor) |
| evidence writers (0010) | read op UPDATE → evidence INSERT → inbox INSERT (trigger) → advisory | no recording op lock, so no inversion |
| finalisation (`applyEvent`) | intent NO KEY UPDATE → (trigger) advisory → hold read | D1 functions holding intent SHARE make it wait, or wait for it; no cycle |
| `admin_resolve_operation` | op UPDATE → intent unlocked | acts only on `outcome_unknown` / `escalated` rows; holds never target these |
| `admin_close_case` | case FOR UPDATE → raise for reserved kinds | takes no further lock |
| `recoverExpiredOperations` | op UPDATE SKIP LOCKED → `openCase` | recordings → `outcome_unknown` (the existing path); never touches holds |

- **Race outcomes:**
  - Hold vs claim on the same row: hold first → the claim is fenced (skipped, or refused by the trigger); claim first → the hold waits, then sees `in_flight` and returns `HOLD_TARGET_NOT_PENDING`.
  - Two openers: the second waits, then returns the same hold id.
  - Link vs visibility hold: link first → `SUCCEEDED_UNPROVEN` refused (linked); hold first → the link is refused (`RECORDING_HOLD_ACTIVE`).
- Every refusal is a raise inside one transaction, so there is no partial write.
- **Observed vs inferred:** all of the above is inferred from the source. The tests must observe the actual waits (`pg_locks`) and must not claim lock-mode universality.

---

## 10. Planned tests (PLANNED; not written or run)

Full TAP logs are kept for every run.

| # | Scenario | Expect |
|---|---|---|
| T-A1 | app INSERT / UPDATE / DELETE on holds, observations, inbox, assessments | refused (RLS / grants / guards) |
| T-A2 | app INSERT of an `OFFLINE_CHARGE_HOLD_%` case (any `opened_by`); privileged INSERT without a hold row (inside an unrelated owner function context) | refused at insert / at commit (deferred binding) |
| T-A3 | `admin_close_case` on a hold case | refused |
| T-A4 | hold identity / release tamper (owner role direct UPDATE: un-release, re-release, change reason) | refused |
| T-B1 | every claim path with an active hold or an open reserved case: helper generic / `opId` / `intentId` / direct UPDATE | skipped or `RECORDING_CLAIM_FENCED` |
| T-B2 | the fence refuses attempt 2 pending, `attempts > 0`, dispatched, not latest, amount / reservation mismatch, intent not `payment_captured` | refused; attempt 1 healthy → allowed (0011) |
| T-B3 | direct UPDATE claim vs `applyEvent` contention | 40P01 or serialized; never a bypass |
| T-B4 | active hold + `link_recording_evidence` / completion / finalisation | `RECORDING_HOLD_ACTIVE`; state unchanged |
| T-C1 | contradiction after link (API and dashboard; same reservation) | inbox → hold + case + observation; link and state unchanged |
| T-C2 | evidence for another reservation; same id; count 0; another marker; method / account labels different vs equal | not / not / not / not / contradiction vs consistent; equal to the 0010 predicate (equivalence) |
| T-C3 | a second and third contradiction while the case is open; the same evidence re-processed | appended once each; duplicate → no row |
| T-C4 | historical dashboard evidence inserted **later** with an old `observed_at` (before earlier-processed rows); microsecond `observed_at` ties | processed (inbox, not cursor) |
| T-C5 | evidence writer vs link vs processor, both orders, observed waits | link refused, or link stands + contradiction opened; never missed |
| T-C6 | crash mid-processing (exception in the hook / connection killed) | rolled back; reprocessed; no duplicate hold or observation |
| T-C7 | poison row | `attempts` / `last_error` recorded, row kept, others processed |
| T-C8 | concurrent processors | SKIP LOCKED; each row's effects once |
| T-C9 | backfill on up with existing linked contradicted rows (incl. already `confirmed`) | holds opened by the first drains; visibility only |
| T-C10 | scan cross-check (`recording_contradictions_page`) agrees with holds | no orphan finding |
| T-D1 | `SUCCEEDED_UNPROVEN` on `payment_captured` and on inherited `confirmed`; `ATTEMPT_GT1` | hold + case; no state / version / effect change |
| T-D2 | duplicate openers, different reason, collision with a pre-existing reserved case inserted by the schema owner | same id / `HOLD_ALREADY_ACTIVE` / `CASE_KIND_OCCUPIED` + rollback |
| T-E1 | `keep_visible` | hold and case stay; new contradictions append |
| T-E2 | `close_acknowledged` on `LINKED_CONTRADICTED` | case resolved; finalisation still refused; a new contradiction opens a new hold |
| T-E3 | `link_full_proof` (valid; < 15 min; contradicted) | linked + released / refused / refused |
| T-F1 (0012) | duplicate assessment, same read twice, disallowed outcome combinations, eligible with count ≠ 0, stale reads, wrong lease / version / worker | refused |
| T-F2 (0012) | 3 non-eligible → `EXHAUSTED`; release with a fresh eligible assessment → new epoch; identity or list evidence > 2 min, reads before the hold, another op / version | accepted / refused |
| T-F3 (0012) | claim without a fresh eligible assessment / with one aged past 2 min while waiting on the fence lock | refused at `v_t` |
| T-G1 | 0011 down with holds / observations / assessments | RAISE (audit kept); empty → OK; inbox dropped (derivable) |
| T-G2 | scoped effects: every hold / processor / owner path leaves intent state, version, public status, `dispatched_at` and op state unchanged (except the documented `link_full_proof` / `recorded_manually` moves); no ESCALATE / notify / void / cancel / refund rows | asserted |

---

## 11. Stages, open decisions and dependencies

**Stage D1-0011 (smallest; recommended first).** §4.1–4.3, §4.5–4.6, §5, §7 (`keep_visible`, `close_acknowledged`, `link_full_proof`), and the helper mirror for the fence and the scan function. Tests T-A*, T-B1–B4, T-C*, T-D*, T-E*, T-G*.

**Stage D1-0012.** Assessments, preflight holds, the fence's fresh-eligible requirement, `release_for_initial_send` and `recorded_manually`. Tests T-F*.
- It depends on the worker's pure preflight classification module, which is not yet accepted.

**Open decisions for root:**

| # | Decision |
|---|---|
| O1 | The two-migration split vs a single 0011 |
| O2 | Whether `close_acknowledged` is offered at all (it ends the case, so guest-data purge may proceed, 0001:604), or `keep_visible` only |
| O3 | Replace the JS scan with the SQL page function (recommended: removes the restated predicate) vs keep both with an equivalence test |
| O4 | Whether the app may open `SUCCEEDED_UNPROVEN` holds immediately or only after a minimum age (it blocks automated link until the owner acts) |
| O5 | The inbox processor's caller (app maintenance vs admin only) and any future schedule ([OUTSIDE] now) |
| O6 | The fence's "no open reserved case for the intent" fail-closed rule vs op-only |
| O7 | Typed handling of a raw UNIQUE reservation-id conflict (abdcf91 note): **not** in D1 |

**Still open and unchanged:** live gates E1–E7 / P1; the owner `paymentMethod` choice; dispatch-worker authorization; the e74a-claim-listing-lock guard failure (release-readiness item).
