# E7.4b-D1 slice B: preflight holds + owner release (migration 0013), refreshed against the ACTUAL 0012 (IMPLEMENTATION CONTRACT, DOCS ONLY)

**Branch.** `feature/e7-offline-charge-preflight-release-contract`, cut from exact `ff07fe81c255aa6154ba66601a522cf2288848bc`.

**Status.**
- **0012 (slice A) is PRESENT and accepted offline** at `ff07fe8` (root ruling on `ff07fe8`; Claude-run local PG only).
- **0013 is PRESENT and accepted offline at `185da0e`** (root ruling on `185da0e`; Claude-run local PG only); the exact map is **§13**. It is not live or payment readiness.
- **Mutation reporting (root):** the original 33-mutant campaign killed 27; 5 survivors are redundant under the enforced writer / hold / epoch invariants (the filters and version checks are retained); G01 survived it. A SEPARATE rerun after splitting the D-13 probe killed G01 and the new G05.
- **D5 (claim-to-confirmation binding, 0014) is ACCEPTED as the implementation basis (root ruling on `cb532dc`, addendum A–E) and IMPLEMENTED offline** on `feature/e7-offline-charge-completion-binding` (pending root code review; map: `claude/e74b-completion-binding-contract.md` §9).
- It **supersedes §8 of `claude/e74b-preflight-assessment-contract.md`**, which predates the real 0012.
- It does not redesign accepted 0011 or 0012.

**Labels.**
- **[0011:n]**, **[0012:n]**: source lines in `db/migrations/0011_recording_owner_cases.up.sql` / `db/migrations/0012_recording_assessments.up.sql` at `ff07fe8`.
- **[JS:n]**: `lib/booking-db/operations.js` at `ff07fe8`.
- **[PROPOSED-0013]**: this design.
- **[TRUST]**: input the database cannot attest.
- **[OUTSIDE]**: not authorized.

**Boundaries.**
- No release, review, hold, assessment or claim authorizes a provider send.
- A release never claims, sends or confirms.
- No automatic resend, no attempt > 1, no redispatch of an ambiguous write.
- No notification, refund, cancel or void.
- No `paymentMethod` choice is assumed. The D5 completion binding (account label + payment method) remains a separate gate before any worker integration.
- All live gates are closed. Future live packages are USD; MXN fixtures are not live authorization.

---

## 1. The defect being fixed, stated against the real code

Simply re-pointing `recording_preflight_block`, `recording_claim_ready` and the fence at a new epoch **cannot** make the first post-release claim work, because 0012 hard-codes epoch 0 / `preflight` in more places:

| # | Actual 0012 / 0011 dependency | Effect if left unchanged after a release |
|---|---|---|
| E1 | `recording_assessments_epoch_check CHECK (epoch = 0)` [0012:133] | a new-epoch row cannot be stored |
| E2 | `recording_assessments_phase_check CHECK (phase = 'preflight')` [0012:132] | a `release_review` row cannot be stored |
| E3 | `record_recording_assessment` INSERTs literal `'preflight', 0` [0012:519–521] | every new preflight lands in epoch 0, which is latched forever |
| E4 | the same writer refuses on `recording_active_hold_id` [0012:440] and on `recording_preflight_block` [0012:443–445] | correct for normal preflight; it must stay, and must not be reused for review |
| E5 | `recording_preflight_block` filters `a.epoch = 0` [0012:213, 215] | the epoch-0 latch outlives the release |
| E6 | `recording_claim_refusal` selects the latest row with `epoch = 0` [0012:338] | the claim keeps judging epoch 0 |
| E7 | `recording_claim_audit` selects `phase = 'preflight' AND epoch = 0` [0012:572] | the audit binds the wrong (old) row, or fails |
| E8 | `recording_claim_assessments_epoch_check CHECK (epoch = 0)` [0012:165] | a post-release claim audit cannot be stored → the claim statement aborts |
| E9 | `recording_claim_assessments_guard` binds `a.epoch = NEW.epoch`, phase `preflight` [0012:193] | must additionally bind NEW.epoch = the CURRENT epoch |
| E10 | `recording_holds.epoch … CHECK (epoch = 0)` (name `recording_holds_epoch_check`) [0011:33] | a hold of epoch ≥ 1 cannot be stored |
| E11 | `recording_holds.reason` CHECK (name `recording_holds_reason_check`) [0011:27] | no `PREFLIGHT_*` reason |
| E12 | `recording_hold_decisions.decision` CHECK (name `recording_hold_decisions_decision_check`) [0011:49] | no `release_for_initial_send` |
| E13 | `recording_holds_guard`: a release must cite `link_full_proof` [0011:113–117] | a preflight release cannot release the hold |
| E14 | `recording_hold_decisions_guard` [0011:123–142] | no binding for a release decision |
| E15 | `reserved_case_guard`: known kinds list [0011:230] | no `OFFLINE_CHARGE_HOLD_PREFLIGHT_*` case |
| E16 | `reserved_case_binding_verify`: resolved only as `recorded`, and every released hold cites `link_full_proof` [0011:273–281] | a preflight case can never resolve; the COMMIT fails |

**Read-only users of the same state** (unchanged in 0013, but re-verified):
- `recording_claim_fence` [0012:529–561] calls `recording_claim_refusal`.
- `recording_claim_ready` [0012:361–364].
- `RECORD_FENCE` in both helper stages [JS:78, 101, 116].
- `recording_active_hold_id` [0011:355–358].
- the 0011 fence's open-reserved-case check [0012:549–552 (0011 text)].
- `intents_safety_guard` / `admin_close_case` exclusions of `OFFLINE_CHARGE_HOLD_*` [0011:524, 536].
- `open_recording_visibility_hold` (reasons limited to ATTEMPT_GT1 / SUCCEEDED_UNPROVEN) [0011:586–633].
- `admin_resolve_recording_hold` (keep_visible / link_full_proof) [0011:753–817].
- the inbox processor [0011:654–718].

---

## 2. Definitions [PROPOSED-0013]

- **Preflight hold reasons (closed list):** `PREFLIGHT_CONFLICT_MARKER`, `PREFLIGHT_CONFLICT_LOOKALIKE`, `PREFLIGHT_CONFLICT_SAME_AMOUNT`, `PREFLIGHT_EXHAUSTED`. Case kind = `'OFFLINE_CHARGE_HOLD_' || reason`.
- **Release decision (closed list):** `release_for_initial_send`. No `recorded_manually`, override, manual finalisation or ATTEMPT_GT1 release exists, even as a placeholder.
- **Current epoch:**
  - `recording_preflight_epoch(op) := count(*)` of `recording_holds` rows of that op with a preflight reason and `released_at IS NOT NULL`. It is monotonic and changes only inside `admin_release_preflight_hold`, which holds the op row `FOR UPDATE` (§6).
  - Any reader holding the op row (SHARE or UPDATE) therefore sees a stable epoch.
  - Lock-free readers (the advisory mirror) may see a just-committed newer epoch. That is harmless, because the trigger re-checks.
- **Latch (current epoch E):**
  - `CONFLICT_LATCHED` if **any** `phase = 'preflight'` row of epoch E has a conflict outcome.
  - Otherwise `EXHAUSTED` if ≥ 3 `phase = 'preflight'` rows of epoch E are `incomplete` / `identity_refused`.
  - `release_review` rows never count.
- **Latest qualifying preflight:** the max `seq` among `phase = 'preflight'` rows of epoch E. `seq` is assigned at INSERT, after the writer's last lock (identity column) [0012:102].
- **Latest review of a hold H:** the max `seq` among `phase = 'release_review'` rows with `hold_id = H`.
- **Latch reason → hold reason:**
  - `CONFLICT_LATCHED` → the `conflict_*` outcome of the **earliest** (min `seq`) conflict row of E, mapped to `PREFLIGHT_CONFLICT_MARKER` / `_LOOKALIKE` / `_SAME_AMOUNT`.
  - `EXHAUSTED` → `PREFLIGHT_EXHAUSTED`, citing the counted row of rank 3 (by `seq`) in E.
  - Conflict takes precedence, exactly as `recording_preflight_block` [0012:212–217].

---

## 3. Table / constraint / index changes [PROPOSED-0013]

Existing rows are preserved. All four tables stay SELECT-only with RLS for app / admin / report; no write grant is added.

| Table | Change (exact name) | NULL-safety / binding |
|---|---|---|
| `recording_assessments` | **ADD** `hold_id uuid` with FK `recording_assessments_hold_fk → recording_holds(id)` | |
| | **REPLACE** `recording_assessments_phase_check` → `CHECK (phase IN ('preflight','release_review'))` | `phase` is NOT NULL |
| | **ADD** `recording_assessments_hold_check CHECK ((phase = 'release_review') = (hold_id IS NOT NULL))` | both sides non-NULL booleans |
| | **REPLACE** `recording_assessments_epoch_check` → `CHECK (epoch >= 0)` | `epoch` is NOT NULL |
| `recording_holds` | **REPLACE** `recording_holds_reason_check` → the 3 0011 reasons + the 4 preflight reasons | |
| | **REPLACE** `recording_holds_epoch_check` → `CHECK (epoch >= 0 AND (reason IN (<4 preflight>) OR epoch = 0))` | `epoch` is NOT NULL, DEFAULT 0 kept |
| | **ADD** `assessment_id uuid` with FK `recording_holds_assessment_fk → recording_assessments(id)` | |
| | **ADD** `recording_holds_assessment_check CHECK ((reason IN (<4 preflight>)) = (assessment_id IS NOT NULL))` | |
| | **ADD** unique index `recording_holds_one_preflight_per_epoch ON (operation_id, epoch) WHERE reason IN (<4>)` | one preflight hold per op per epoch |
| | `recording_holds_one_active` [0011:40] unchanged | one active hold per op |
| `recording_hold_decisions` | **REPLACE** `recording_hold_decisions_decision_check` → `IN ('keep_visible','link_full_proof','release_for_initial_send')` | |
| | **ADD** `assessment_id uuid` with FK `recording_hold_decisions_assessment_fk` | |
| | **ADD** `recording_hold_decisions_assessment_check CHECK ((decision = 'release_for_initial_send') = (assessment_id IS NOT NULL))` | |
| | `recording_hold_decisions_check` (link ⇔ linked evidence) and `_check1` unchanged | |
| | **ADD** unique index `recording_hold_decisions_one_release ON (hold_id) WHERE decision IN ('link_full_proof','release_for_initial_send')` | at most one releasing decision per hold |
| `recording_claim_assessments` | **REPLACE** `recording_claim_assessments_epoch_check` → `CHECK (epoch >= 0)` | |
| | PK (operation_id), `_assessment_key`, `_binding_fk` unchanged | one claim audit per op ever; an assessment is never reused |
| `recording_assessment_codes` | unchanged (frozen seed) | |

**Immutable identity.**
- Hold identity stays frozen by the existing `to_jsonb(NEW) - released fields` comparison [0011:108–110], so the new `assessment_id` is covered automatically.
- Assessments, decisions and claim audits stay append-only through the existing `reject_change` triggers [0011:212–213; 0012:180–181, 202–203].

---

## 4. Function map [PROPOSED-0013] — every replacement and every new function

All functions keep `SET search_path = pg_catalog, booking` and `REVOKE ALL FROM PUBLIC`.
- **Replacements** keep their exact signature, security mode, volatility and grants (`CREATE OR REPLACE`).
- **Down** restores each replaced body **verbatim** from the cited source file range (generator, as for 0011 / 0012 downs).

### 4.1 Replaced 0012 functions

| Function | 0013 change | Down source |
|---|---|---|
| `recording_preflight_block(uuid)` — SQL, SD, VOLATILE, private | `epoch = 0` → `epoch = recording_preflight_epoch(p_op)` (E5) | [0012:210–218] |
| `recording_claim_refusal(uuid,text,timestamptz)` — SD, VOLATILE, private | latest row of `phase='preflight' AND epoch = <current>` (E6). Everything else unchanged: latch, eligible, version, cfg listing / currency, the assessor's live work lease, claimant equality, both evidence rows fresh at `p_t` | [0012:326–356] |
| `record_recording_assessment(…13…)` — SD, VOLATILE, app | computes `v_epoch := recording_preflight_epoch(p_op)` **after** the advisory lock and INSERTs it (E3). Adds the **release floor** for epoch ≥ 1 (§5.3). Keeps the active-hold and latch refusals (E4). `phase` stays `'preflight'`; `hold_id` stays NULL | [0012:370–524] |
| `recording_claim_audit()` — SD, private | selects the latest `phase='preflight'` row of the **current** epoch (E7) | [0012:565–576] |
| `recording_claim_assessments_guard()` — INVOKER | additionally `NEW.epoch = recording_preflight_epoch(NEW.operation_id)` (E9) | [0012:183–199] |
| `recording_assessments_guard()` — INVOKER | additionally (defense in depth): `preflight` ⇒ `hold_id IS NULL`; `release_review` ⇒ the hold is the **active** preflight hold of the same op / intent, with `hold.epoch = NEW.epoch = recording_preflight_epoch(op)` | [0012:170–177] |
| `recording_claim_fence()`, `recording_claim_ready(uuid,text)` | **unchanged** (they call the replaced refusal) | — |

### 4.2 Replaced 0011 functions

| Function | 0013 change | Down source |
|---|---|---|
| `recording_holds_guard()` — INVOKER | **INSERT** of a preflight hold: `assessment_id` is the latch citation of §2 for the op's current epoch; `NEW.epoch` = that epoch; the reason matches the latch. **Release** (E13): `SUCCEEDED_UNPROVEN` ⇒ `link_full_proof`; preflight ⇒ `release_for_initial_send` citing this hold | [0011:93–119] |
| `recording_hold_decisions_guard()` — INVOKER | `release_for_initial_send` only for preflight holds. It cites a `release_review` assessment with `hold_id = NEW.hold_id`, same op / intent, `outcome = 'eligible'`, `epoch = hold.epoch`. Its `evidence_ids` equal exactly `{identity_evidence, list_evidence}` of that review (E14) | [0011:123–142] |
| `reserved_case_guard()` — INVOKER | the kinds list + the 4 `OFFLINE_CHARGE_HOLD_PREFLIGHT_*` (E15) | [0011:222–246] |
| `reserved_case_binding_verify(uuid)` — SD | the resolution follows the kind: `PREFLIGHT_*` cases resolve only as `no_action`, others only as `recorded`. Every released hold cites its own releasing decision of the kind-matching type. **Kept unchanged:** ≥ 1 hold, intent / kind match, open iff an active hold (E16) | [0011:254–282] |
| `admin_resolve_recording_hold(…)`, `open_recording_visibility_hold(…)`, `recording_active_hold_id`, inbox / page / completion / link / finalisation / `intents_safety_guard` / `admin_close_case` | **unchanged** (keep_visible works for preflight holds; link_full_proof and the visibility opener refuse preflight reasons by their existing reason checks) | — |

### 4.3 New functions

| Function | Security / grant |
|---|---|
| `recording_preflight_epoch(p_op uuid) RETURNS integer` | SQL, SD, VOLATILE, private |
| `open_recording_preflight_hold(p_op uuid, p_by text) RETURNS uuid` | SD, VOLATILE; app + admin |
| `record_release_review_assessment(p_hold uuid, p_worker text, p_outcome text, p_code text, p_identity_read uuid, p_list_read uuid, p_identity_evidence uuid, p_list_evidence uuid, p_expected_version integer, p_module_version text, p_client_label text, p_account_ref text, p_cfg jsonb) RETURNS uuid` | SD, VOLATILE; app only |
| `admin_release_preflight_hold(p_hold uuid, p_review uuid, p_resolver text, p_justification text, p_at timestamptz) RETURNS uuid` | SD, VOLATILE; admin only |

**Shared validation (recommended).**
- The 0012 writer body splits into a private `recording_assessment_check(…)` that validates inputs, reads, evidence, freshness and floors exactly as [0012:378–517], parameterised by phase and floor instant. The two public writers call it.
- Because the replaced `record_recording_assessment` body then differs textually from 0012, its down source is still [0012:370–524] verbatim.
- **Alternative (no helper):** duplicate the checks in the review writer; the mutation tests in §10 then cover both copies.
- **Recommendation:** the helper, to avoid drift.

**JS.**
- New `openRecordingPreflightHold` and `recordReleaseReviewAssessment` in `operations.js`; new `adminReleasePreflightHold` in `db/lib/admin.js` (beside `adminResolveRecordingHold` [db/lib/admin.js:58]).
- New `DB_SAFETY_CODES`.
- **Unchanged:** `claimNextOperation`, the claimant-aware `RECORD_FENCE` in both stages [JS:78, 101, 116], the recording-only work lock [JS:107–109], `recordRecordingAssessment`, R1 / R2 helpers.

---

## 5. Writers

### 5.1 Normal preflight (`record_recording_assessment`)

- **Unchanged 0012 rules:** inputs, code allowlist and evidence rules, cfg, read binding / once-only, freshness, both floors.
- **Plus:**
  - **Epoch:** `v_epoch` is computed after the advisory lock (stable: the op is SHARE-locked; a release needs op UPDATE).
  - **Refusals:** active hold (`ASSESSMENT_HOLD_ACTIVE`); latch of `v_epoch` (`ASSESSMENT_EPOCH_CONFLICTED` / `_EXHAUSTED`).
  - **Release floor (epoch ≥ 1):** every cited evidence row has `created_at > <recorded_at of the releasing decision of the epoch-(v_epoch−1) hold>` (DB clock vs DB clock). Every cited read has `created_at > that recorded_at`; this compares caller time with DB time, so it is [TRUST] and only blocks or counts, never qualifies alone.
- Old-epoch reads cannot be reused anyway (global once-only, `UNIQUE` [0012:123–124]).

### 5.2 Release review (`record_release_review_assessment`)

1. Lock order (§7): intent SHARE → `intent_work` SHARE → op SHARE → cited reads SHARE → advisory → **hold `FOR SHARE`** → `v_t`.
2. The hold is **active**, has a preflight reason, belongs to the op / intent, and `hold.epoch = recording_preflight_epoch(op)`. Otherwise `HOLD_NOT_ACTIVE` / `HOLD_TARGET_STATE`.
3. The op is the pending, `:1`, attempts 0, undispatched, latest recording.
4. The intent is `payment_captured`, has an exact capture and a reservation, and `i.version = p_expected_version = hold.intent_version_at_hold`. Otherwise `ASSESSMENT_VERSION_CHANGED`; D8: the hold stays visible.
5. `p_worker` holds the live work lease at `v_t`.
6. **The latch and the active-hold refusal of §5.1 are NOT applied** (the hold is the point).
7. The same shared validation applies (codes, evidence, cfg, freshness, once-only reads, version-transition and recording floors), **plus the hold floor:** every cited evidence row has `created_at > hold.created_at` (DB vs DB), and every cited read has `created_at > hold.created_at` [TRUST].
8. INSERT `phase = 'release_review'`, `hold_id = p_hold`, `epoch = hold.epoch`.

**Any outcome** may be recorded, for the owner's audit; **only `eligible` can qualify a release** (§6).
- Reviews **never** count toward exhaustion (the latch reads `phase = 'preflight'` only).
- Reviews **never** satisfy a claim (the refusal and the audit read `phase = 'preflight'` only).
- Reviews never carry into a later epoch (they are bound to a hold of a past epoch).

### 5.3 Floors summary

| Row | DB clock vs DB clock | Mixed / [TRUST] (a caller-written time on one side) |
|---|---|---|
| Preflight, epoch 0 | evidence `created_at` > version-transition `recorded_at` | evidence `created_at` > recording `created_at` (the recording row's `created_at` is caller-written: root correction E); read `created_at` > recording `created_at` |
| Preflight, epoch ≥ 1 | the above + evidence `created_at` > releasing decision `recorded_at` | + read `created_at` > that `recorded_at` |
| Release review | the 0012 floors + evidence `created_at` > `hold.created_at` | + read `created_at` > `hold.created_at` |

Freshness everywhere: inclusive 2 minutes, no future, at the writer's / release's post-lock `clock_timestamp()`.

---

## 6. Hold opener and owner release

### 6.1 `open_recording_preflight_hold(p_op, p_by)` (DB-derived; crash / delay recovery)

1. Lock order: intent SHARE → op `FOR UPDATE` → advisory → active hold `FOR UPDATE` → open same-kind case `FOR UPDATE` → `v_t`. This is identical to the 0011 opener [0011:597–603].
2. Derive `E = recording_preflight_epoch(op)`, the latch of E, and the citation (§2). No caller-chosen reason or assessment.
   - No latch → `HOLD_TARGET_STATE` (nothing to show).
   - An active hold with the same derived reason → return its id (idempotent, no write).
   - Any other active hold → `HOLD_ALREADY_ACTIVE`.
3. The op must still be the pending, `:1`, attempts 0, undispatched, latest initial recording. A preflight hold never targets a claimed / dispatched row.
4. **Version and state, recommended:**
   - **No** intent-state, version, worker or lease requirement for *opening*. Visibility must survive a crashed worker and an intent that moved on (e.g. ESCALATE → `reconciliation_required`).
   - `intent_state_at_hold` / `intent_version_at_hold` freeze what was seen.
   - `p_by` is a provenance label [TRUST], as in the 0011 opener.
   - Grant: app + admin.
5. **Case:** join an open case of the same kind for the intent, else create one (`opened_by = 'recording-hold:<case id>'`). The ≥ 1 hold / open-iff-active / kind-match invariants are verified at COMMIT (§4.2).
6. **The DB latch remains the safety backstop.** With no hold at all, the fence, the mirror and the preflight writer refuse (0012, epoch-aware in 0013).

### 6.2 `admin_release_preflight_hold(p_hold, p_review, p_resolver, p_justification, p_at)`

1. Inputs: resolver 1..200 chars; justification `is_code`; `p_at` NOT NULL (`HOLD_DECISION_INVALID`).
2. Lock order: intent SHARE → op `FOR UPDATE` → advisory → hold `FOR UPDATE` → case `FOR UPDATE` → `v_t` (identical to [0011:766–770]).
3. **Replay / conflict:**
   - If the hold is already released and its releasing decision is a `release_for_initial_send` citing `p_review`, return that decision id (read-only).
   - Otherwise `HOLD_NOT_ACTIVE`.
4. The hold is active with a preflight reason (`HOLD_DECISION_NOT_ALLOWED` otherwise), and `hold.epoch = recording_preflight_epoch(op)`.
5. The op is the pending, `:1`, attempts 0, undispatched, latest recording (`HOLD_TARGET_STATE` / `HOLD_TARGET_NOT_LATEST`).
6. The intent is `payment_captured` with an exact capture, and **`i.version = hold.intent_version_at_hold = review.intent_version`**. Otherwise `HOLD_CONTEXT_CHANGED`: refused permanently for this hold, which stays visible. There is no reopen path (D8).
7. `p_review` must be:
   - `phase = 'release_review'`, `hold_id = p_hold`, same op / intent, `epoch = hold.epoch`, `outcome = 'eligible'`;
   - **the latest review of this hold** (a later non-eligible review supersedes it).
8. **Freshness:** both review evidence rows have `observed_at ∈ [v_t − 2 min, v_t]` at the post-lock DB time. The review's write already enforced evidence > `hold.created_at`.
9. **Effects, in one transaction:**
   - INSERT the decision (`release_for_initial_send`, `assessment_id = p_review`, `evidence_ids = {identity, list}`, `resolver_session_user = session_user`, `decided_at = p_at`, `recorded_at = v_t`);
   - UPDATE the hold `released_at = v_t, release_decision_id = d`;
   - if no other hold of the case is active, UPDATE the case to `resolved` with resolution `no_action`, `resolved_by = p_resolver`, `resolved_at = v_t`.
10. **Never:** claim, op-state, intent-state or version change, or any effect.

**After a release:**
- The epoch is E + 1, with an empty latch.
- The claim refuses (`NO_ASSESSMENT`) until a **new normal preflight**, with **new** reads and evidence written after the release, qualifies.
- All epoch-E rows (conflicts, counted refusals, reviews, the hold, the decision) remain unchanged.
- An **unrelated** open `OFFLINE_CHARGE_HOLD_*` case of the intent still fences the claim through the unchanged 0011 check.

**Remains blocked / unreleasable in 0013:**
- version-changed holds;
- holds on an intent that is not `payment_captured`;
- `ATTEMPT_GT1`, `SUCCEEDED_UNPROVEN` (except `link_full_proof`) and `LINKED_CONTRADICTED`;
- any attempt > 1.

---

## 7. Locks (one intent; no global lock; short transactions)

> intent (SHARE; NO KEY UPDATE for `applyEvent`) → `intent_work` (SHARE; UPDATE for lease writers) → recording op (SHARE / UPDATE) → cited read ops (SHARE) → **advisory evidence key** → hold (SHARE / UPDATE) → reserved case (UPDATE) → `clock_timestamp()`

**Resolution of the old ordering inconsistency.** The superseded §8 / §7.2 placed "hold before advisory". 0013 adopts **advisory before hold** everywhere, matching both 0011 functions [0011:597–603, 766–770].

| Path | Order (strength) | Notes |
|---|---|---|
| normal preflight (0012 writer) | intent S → work S → op S → reads S → advisory → (reads hold state, no lock) | the opener / release take op UPDATE, so they serialize |
| release review | intent S → work S → op S → reads S → advisory → hold **S** | vs release: op S vs UPDATE serializes. Release first: the review waits, then sees the released hold → `HOLD_NOT_ACTIVE`. Review first: the release waits, then reads the committed review as the latest |
| opener | intent S → op UPDATE → advisory → hold UPDATE → case UPDATE | duplicate openers serialize on op UPDATE; the second returns the same id |
| owner release | intent S → op UPDATE → advisory → hold UPDATE → case UPDATE | duplicate releases serialize; the second gets the replay id or `HOLD_NOT_ACTIVE` |
| `admin_resolve_recording_hold` (0011) | intent S → op UPDATE → advisory → hold UPDATE → case UPDATE | unchanged |
| claim helper | intent S → work S → op UPDATE SKIP LOCKED → trigger: intent S, work S → `v_t` | unchanged; reads the epoch under the op lock |
| direct app UPDATE claim | op UPDATE → trigger intent S → work S | unchanged op-first inversion; 40P01 possible, never a bypass, no retry |
| evidence writer + inbox enqueue | read op UPDATE → evidence INSERT (FK key-share on intent) → inbox INSERT → advisory | unchanged; no cycle (it never waits on what the writers hold before advisory) |
| inbox processor | inbox item SKIP LOCKED → intent S → op S → advisory | unchanged; preflight evidence → `not_latest_linked` |
| lease writers (`claimIntentWork`) | work `FOR UPDATE SKIP LOCKED` → UPDATE | unchanged |

- **Snapshots:** every function is VOLATILE plpgsql / SQL, so each statement after a wait reads a fresh READ COMMITTED snapshot.
- **Clock:** `v_t` is taken after the final lock.
- **No universal deadlock-freedom claim:** the direct-UPDATE inversion and caller-composed transactions can still produce 40P01.

---

## 8. Claim audit after release

- `recording_claim_audit` binds the latest preflight row of the **current** epoch.
- `recording_claim_assessments_guard` enforces `NEW.epoch = a.epoch = recording_preflight_epoch(op)`, `phase = 'preflight'`, eligible, same op / intent / worker, op in flight, leased to that worker.
- The PK (operation_id) and `UNIQUE (assessment_id)` refuse a second claim of the op and any reuse of an assessment.
- **Pre-release history:** a preflight hold exists only on a pending, never-claimed op, so no claim audit can predate a release on the same op. Earlier-epoch assessments remain as audit and are never cited.
- **Unchanged:** the claimant-aware mirror in both helper stages; completion / link / finalisation / core / inbox / page; R1 / R2.

---

## 9. 0013 up / down and compatibility

**Up:**
1. The precondition is 0012 applied.
2. Then: the columns / FKs / CHECK replacements / indexes of §3, `recording_preflight_epoch`, the replaced functions of §4.1–4.2, the new functions of §4.3, grants.
3. Existing rows satisfy every replaced CHECK. All existing assessments are `preflight` / epoch 0 with `hold_id` NULL; all holds are non-preflight with epoch 0; decisions are keep_visible / link_full_proof; claim audits are epoch 0.

**Down** — refuses (`DOWNGRADE_REFUSED_RECORDING_PREFLIGHT_RELEASE_AUDIT`) if any of these exist:
- a preflight-reason hold;
- a `release_for_initial_send` decision;
- a `release_review` assessment;
- an assessment, hold or claim audit with `epoch > 0`;
- a non-NULL `assessment_id` / `hold_id`.

0012-era audit (epoch-0 preflight assessments and claim audits) is **allowed and preserved**.

**Restore order:**
1. Every replaced body, verbatim from §4.1 / §4.2 sources.
2. The replaced CHECKs, with their exact names and 0011 / 0012 definitions.
3. Drop the added indexes, constraints and columns, then the new functions.

**Round trip:** equal to a fresh cluster at 12 (function bodies md5, ACLs, security, volatility, search_path, triggers, columns, grants, policies, constraints, indexes, RLS). Re-up is identical.

**Compatibility.**

| Combination | Result |
|---|---|
| Code at `ff07fe8` on schema 13 | works: no signature changes, same claim helper |
| Code at 0013 on schema 12 | the claim / assessment paths work; the new helpers fail with an undefined-function error, since they need 13 |
| Schema 13 with no preflight holds | behaves exactly as 12 (epoch 0 everywhere) |

Migrations 0001–0012 stay byte-identical on disk.

---

## 10. Planned local-PG tests and mutation targets (PLANNED; full TAP)

**Planned tests:**

| # | Scenario |
|---|---|
| B-1 | end to end: conflict → hold (DB-derived reason / citation) → eligible review → release → new preflight with new reads → claim + audit with `epoch = 1`; the same through exhaustion (rank-3 citation) |
| B-2 | after release with **no** new preflight: helper null, direct `NO_ASSESSMENT`; old-epoch eligible / review / reads replayed → refused (`READ_REUSED`, floor) |
| B-3 | opener: no latch refused; crash / delay (another caller, no lease); idempotent; intent moved on (still opens); a different active hold → `HOLD_ALREADY_ACTIVE`; same-kind case join; second epoch's hold on a resolved case → new case |
| B-4 | review: only under the active hold of the current epoch; lease / version / stale / future / pre-hold evidence refused; non-eligible review recorded but never counts or qualifies; reviews never satisfy a claim |
| B-5 | release: happy path; version changed (D8, hold stays, no reopen); stale review at release; non-latest review; review of another hold; wrong reason; app caller refused; replay vs conflicting replay |
| B-6 | case handling: last-hold resolution `no_action`; an open unrelated reserved case still fences the claim after release; binding probes (≥ 1 hold, open iff active, kind match, release decision kind) |
| B-7 | races with observed waits, both orders: review vs release; opener vs preflight writer; duplicate openers / reviews / releases; claim vs release; release vs lease reassignment; expiry after waits |
| B-8 | constraint probes with triggers bypassed (NULL / bad values for every new CHECK); FK probes with triggers active |
| B-9 | down: only 0012 audit → allowed, equals fresh 12, identical re-up; any 0013 audit → refused, unchanged |
| B-10 | no effects: no state / version / op / effect / notification change from opener / review / release |

All 0010–0012 suites are preserved (incl. R1 / R2, T-C10, predicate / page microseconds, A-1…A-16, D-1…D-3).

**Mutation targets:**
- the epoch function; each epoch filter in block / refusal / writer / audit / guard;
- the release floor; the hold floor;
- review exclusion from the latch / claim; latest-review selection;
- version triple equality; freshness at release;
- the decision binding; case resolution by kind;
- the one-preflight-hold-per-epoch index; the opener citation; the down audit gate.

---

## 11. Choices for root (recommended first) and genuine blockers

| # | Choice | Recommendation |
|---|---|---|
| C1 | opener requirements | no lease / version / state requirement for opening (§6.1). Alternative: require the work lease (loses visibility after a crash) |
| C2 | review outcomes | record any outcome; only `eligible` qualifies. Alternative: `eligible` only |
| C3 | release citation | the **latest** review of the hold must be the cited eligible one |
| C4 | shared validation | a private helper used by both writers (§4.3) |
| C5 | read floors after hold / release | caller vs DB time, labelled [TRUST]; evidence floors are DB vs DB |

**Genuine blockers:** none for writing 0013 offline. These remain before any worker integration or live use:
- D5 completion binding;
- the owner `paymentMethod` choice;
- live-unverified provider shapes;
- all live gates;
- the unexplained historical e74a guard failure.

## 12. Implementation sequence (after root acceptance)

1. 0013 up / down with the generator for verbatim down bodies.
2. JS helpers + safety codes.
3. Focused `e74b-d1-release.test.mjs` + fixture helpers (real holds / reviews / releases; no skip switch).
4. Fault injection.
5. Full suites; docs map; commit / push; one ping; stop.

---

## 13. Implementation map — 0013 (slice B), offline, pending root code review

Branch `feature/e7-offline-charge-preflight-release`, cut from exact `6204619`. Migrations 0001–0012 are byte-identical. No D5, worker, adapter, route, UI, config, dependency, schedule or live action.

**Files.**
- `db/migrations/0013_recording_preflight_release.{up,down}.sql`; the down file is generated, with every restored body copied verbatim from the cited 0011 / 0012 line ranges.
- `lib/booking-db/operations.js`: only `recordReleaseReviewAssessment` and `openRecordingPreflightHold` were added.
- `db/lib/admin.js`: `adminReleasePreflightHold`.
- `lib/booking-db/repo.js`: safety codes.
- New `test/db/e74b-d1-release.test.mjs`.
- Adapted tests, listed in §13.5.
- These four docs.

### 13.1 E1–E16 → implementation

| Item | 0013 |
|---|---|
| E1 / E2 | `recording_assessments_epoch_check` → `epoch >= 0`; `recording_assessments_phase_check` → `IN ('preflight','release_review')`; added `hold_id` + `recording_assessments_hold_fk` + `recording_assessments_hold_check`; index `recording_assessments_hold` |
| E3 / E4 | `record_recording_assessment` (same signature / grant) INSERTs the **current** epoch, computed after the advisory lock. It keeps the active-hold and latch refusals. In epoch ≥ 1 it applies the release floor (the `recorded_at` of the `release_for_initial_send` decision of the epoch-(E−1) hold; missing → `ASSESSMENT_FLOOR`) |
| E5 / E6 / E7 | `recording_preflight_block`, `recording_claim_refusal`, `recording_claim_audit` use `recording_preflight_epoch(op)` |
| E8 / E9 | `recording_claim_assessments_epoch_check` → `epoch >= 0`; the guard adds `NEW.epoch = recording_preflight_epoch(op)` |
| E10 / E11 / E12 | `recording_holds_epoch_check` (≥ 0; 0 for non-preflight); `recording_holds_reason_check` (+4 preflight); `recording_hold_decisions_decision_check` (+`release_for_initial_send`); added `assessment_id` on holds / decisions with FKs and the `*_assessment_check` CHECKs; unique indexes `recording_holds_one_preflight_per_epoch`, `recording_hold_decisions_one_release` |
| E13 / E14 | `recording_holds_guard`: a preflight INSERT must equal `recording_preflight_latch_citation` (reason, assessment, epoch); a release cites a decision of the kind-matching type. `recording_hold_decisions_guard`: `release_for_initial_send` binds the hold's eligible review (same op / intent / hold / epoch) and `evidence_ids = ARRAY[identity, list]` exactly, with no linked evidence |
| E15 / E16 | `reserved_case_guard` (+4 kinds); `reserved_case_binding_verify`: resolution and releasing decision follow the kind (`no_action` / `release_for_initial_send` for preflight kinds). Kept: ≥ 1 hold, intent / kind match, open iff active |

**New functions.**
- `recording_preflight_epoch` and `recording_preflight_latch_citation`: private.
- The private shared validator, in two parts (`recording_assessment_input_rule` before locks; `recording_assessment_validate` after locks): private, no app / admin / report execute.
- `record_release_review_assessment`: app.
- `open_recording_preflight_hold`: app + admin.
- `admin_release_preflight_hold`: admin.

All are SD, VOLATILE, with a fixed `search_path` and no PUBLIC execute. **Unchanged:** `recording_claim_fence`, `recording_claim_ready`, the claimant-aware mirror in both helper stages, the recording-only work lock, the AFTER audit trigger, `admin_resolve_recording_hold` (keep_visible works on preflight holds), the inbox / page / completion / link / finalisation functions.

### 13.2 Addendum map (root ruling on `6204619`)

| Item | Where / tests |
|---|---|
| C1 opener | DB-derived; no lease / state / version requirement; always the latest pending never-claimed initial recording + current-epoch latch + exact citation (B-3) |
| C2 / C3 | any allowlisted review outcome is recorded; release requires the **latest review across all outcomes** to be the cited eligible one (B-4, B-5, B-7) |
| C4 | one private validator (two explicit parts so the 0012 refusal order stays identical) |
| C5 | caller-time floors labelled [TRUST]; the recording `created_at` floor relabelled as mixed (§5.3) |
| A | validator signatures typed; each writer owns its locks, phase / hold / epoch / state / lease / version checks and post-lock clock; the guard rejects wrong bindings (B-4b) |
| B | every E1–E16 dependency changed; one preflight hold per op per epoch; no claim on old-epoch rows (B-1, B-2, B-8) |
| C | exact decision binding and evidence pair; release-time freshness / latest review / version triple / latest pending op; replay read-only; new epoch empty (B-1, B-2, B-5, B-5b, B-6) |
| D | the down gate tests only 0013 columns / rows; 0012 epoch-0 audit preserved; fresh-12 equivalence with that audit present; identical re-up; each 0013 audit class refuses unchanged (D-13) |
| E | lock order advisory before hold everywhere; waits observed (B-7) |
| F | 0010–0012 suites unchanged and passing; no new release types; version-changed / non-captured holds stay visible (B-5b) |

### 13.3 Deviations for root review

- **C4 is implemented as two private functions** (input part before locks, content part after locks), not one, so that every 0012 refusal keeps its exact order.
- The release decision's `evidence_ids` are the canonical ordered pair `[identity, list]`; any other order, a missing row or an extra row is refused.
- **Equivalent by construction (not separately testable):**
  - Review-version vs hold-version: the review writer already forces review version = hold version.
  - "Latest vs earliest conflict" in the citation: a second conflict cannot be recorded in the same epoch.
  - Review exclusion from the latest-row selection: reviews are bound to an active hold, which blocks every claim.
  - The audit's latest-row epoch filter: the latest preflight row of an op is always in the current epoch whenever a claim can pass.

### 13.4 Residual limits

- Read creation times and the recording `created_at` are caller-written [TRUST].
- Classification, provider timing and account labels remain [TRUST].
- The direct-UPDATE inversion can still produce 40P01.
- A version-changed or non-`payment_captured` preflight hold stays visible and unreleasable (no reopen path).
- Multiple bound holds on one preflight case cannot arise naturally (one initial recording per intent); they were exercised only with labelled test setup.

### 13.5 Adapted existing tests (why)

- `migrations.test.mjs`: version lists +13; the 0011 equivalence test measures at 11 via `[13, 12]`.
- `e74b-d1-assessments.test.mjs`:
  - A-2b: `release_review` now answers `recording_assessments_hold_check`; the phase probe uses an unknown phase; the epoch probe uses −1.
  - A-16 and D-1..D-3: measure 0012 itself at schema 12 (0013 rolled back first, re-applied after).
- `e74b-d1-owner-cases.test.mjs`:
  - T-C9: version lists.
  - T-G2: 0013 (no 0013 audit in that file) rolls back, 0012 refuses, then 13 is re-applied.
- `e74b-d2-recording-evidence.test.mjs` (downgrade test): 0013 rolls back first and is re-applied.
- No table count changed (no new table); `scripts/db-smoke.mjs` is unchanged.

### 13.6 Tests and fault injection (CLAUDE-RUN on disposable local PostgreSQL 16; full TAP retained)

- New `e74b-d1-release.test.mjs` (14 tests):
  - B-1: two complete release cycles (epoch 0 conflict → … → epoch 2 claim + audit), with all older audit kept.
  - B-2: old-epoch replay; used reads refused by UNIQUE, unused pre-hold / pre-release reads refused by the floors.
  - B-3: opener (no latch, crash / no lease, idempotent, moved-on intent, a different active hold, a claimed row).
  - B-4: review rules incl. stale identity / list, future, pre-hold proof, lease, version, any outcome, no counting.
  - B-4b: guard bindings.
  - B-5: latest review across outcomes, replay, conflicting replay, app / report refused.
  - B-5b: stale EACH row at release, version change (visible, no reopen), moved-on intent, keep_visible.
  - B-6: multiple bound holds / last release; an unrelated open case; decision / case / hold-guard probes.
  - B-7: observed waits, both orders, for review vs release, concurrent reviews, openers, releases, opener vs writer, lease expiry after a wait.
  - B-7b: a killed release leaves nothing.
  - B-8: constraint probes incl. the claim audit against an old-epoch row.
  - B-9: privilege matrix and private helpers.
  - B-10: no effects.
  - D-13: fresh-12 equivalence with 0012 audit present, identical re-up, and each 0013 audit class refusing alone.
- **Final runs:**

| Run | Result |
|---|---|
| focused + migrations + offline-charge + D1 owner-cases + D2 + 0012 assessments | **111 / 111** |
| `npm test` | **674 / 674** |
| `npm run test:db` | **367 / 367** |

  The e74a listing-lock guard passed in this run; its historical failure stays unexplained.
- **Fault injection:** 33 targeted mutants, each in an isolated copy against the focused file. **27 killed.**
  - Five survivors are equivalent by construction (§13.3): N05, N10, N13, N13b, N30.
  - The down-gate holds-clause mutant (G01) survived the first pass because the probe combined a hold and its case. The probe was split into two classes, and G01 and the new case-clause mutant G05 were both killed on rerun.
- **Observed:** waits in every B-7 race. The T-B3 / A-15 inversion produced `["ok","40P01"]` (never a bypass).

