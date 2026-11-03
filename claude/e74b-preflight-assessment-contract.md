# E7.4b-D1-0012: preflight assessment persistence and initial-recording claim fence (IMPLEMENTATION CONTRACT, DOCS ONLY)

**Branch.** `feature/e7-offline-charge-preflight-contract`, cut from exact `34f0314`.

**Status.**
- **PRESENT and accepted:** migration 0011 plus the R1 / R2 helper corrections (`cd77088` + `34f0314`); 0010 (`d801b43`); the pure proof module `lib/checkout/offline-charge-proof.js` (`4f6b27f`, unchanged since).
- **PROPOSED (this document):** migration 0012 and its helpers. Nothing here is implemented. Migrations 0001–0011 stay unchanged on disk; 0012 would be a standalone additive / replacement migration.
- **Still blocked:** no worker, adapter, route, UI or schedule; no automatic resend; no automated attempt > 1; no redispatch of any ambiguous write; no ESCALATE, notification, refund, cancel or void; no `paymentMethod` choice assumed; all live gates stay closed.

**Labels.**
- **[PRESENT]** code at `34f0314`, cited as path:line.
- **[PROPOSED]** this design.
- **[TRUST]** input the database cannot attest.
- **[OUTSIDE]** not authorized by this task.
- **[DECIDE]** an open choice for root (§10).

---

## 1. What 0012 adds, in one paragraph

Today the 0011 fence (`db/migrations/0011_recording_owner_cases.up.sql:553–581`) lets the never-dispatched initial recording be claimed with **no** preflight evidence at all. 0012 makes that claim depend on a **persisted, DB-bound, fresh, eligible preflight assessment**: one positive identity read and one complete charge-list read, both API evidence of exactly this intent / reservation, fresh at the database clock **at the claim**, in the current epoch, recorded by the claiming worker under its live work lease.

Three further pieces:
- conflict and exhaustion outcomes open owner-visible `PREFLIGHT_*` holds (reusing the 0011 hold / case machinery);
- the owner may release such a hold for the initial send **only** with a fresh `release_review` assessment taken under that hold;
- a release starts a new epoch, and nothing carries forward.

**Neither an assessment nor a release dispatches, confirms or authorizes a send by itself.** The fence still decides at claim time.

---

## 2. Present baseline relied on (verified at 34f0314)

| Fact | Where |
|---|---|
| Pure preflight: `assessIdentitySnapshot`, `assessChargeList`, `qualifyPreflight` produce a frozen branded eligibility with `sendAuthorization: false` and the full context; brands are a process-local `WeakSet` | `lib/checkout/offline-charge-proof.js:54–57`, 200–232, 244–288, 309–332 |
| Freshness 2 min, inclusive; observed in the future is refused | `offline-charge-proof.js:36`, 87–94 |
| Context = every intent field + every config field | `offline-charge-proof.js:179–184`; config keys 122–136; intent keys 139–156 |
| Initial recording only, `pending`, `attempts 0`, undispatched, payload bound | `offline-charge-proof.js:158–170` |
| Request built PRE-CLAIM from the eligibility; carried observations re-checked for freshness | `offline-charge-proof.js:359–374` |
| Reads: `requestRead` writes the read row with **caller** `created_at` / `next_attempt_at` | `lib/booking-db/operations.js` (`requestRead`) |
| API evidence via `record_provider_evidence`: the read must be succeeded and of the right type, `external_ref` = the read selector, `observed_at := read.completed_at` (caller time); `created_at DEFAULT now()` (writer **transaction start**, DB clock) | 0010:354–390; 0003:52–76 (`created_at` 0003:67) |
| Evidence shapes: `hostaway_reservation` `found_active` needs `listingId` / `from` / `to` / `totalMinor`; `hostaway_offline_charges` needs `listed` + `matchingChargeCount` / `matchingChargeIds` | 0003:85–97 |
| Latest recording; attempt number from the immutable key | 0010:24–37 |
| 0011 holds / decisions / observations / inbox; reserved cases; two-way deferred binding; claim fence; visibility opener; inbox processor; page function; owner decisions | 0011:23–89, 93–217, 222–297, 553–581, 586–637, 654–720, 722–751, 753–832 |
| JS fence mirror in **both** claim stages | `lib/booking-db/operations.js:75–84`, 97, 107 |
| R1 drain re-throws an outer error; R2 optional link hold never replaces the refusal | `operations.js:217–232`, 245, 259–286 |

---

## 3. Objects [PROPOSED 0012]

### 3.1 New table `booking.recording_assessments` (append-only; RLS SELECT-only for app / admin / report; no write grant)

| Column | Rule |
|---|---|
| `id uuid PK` | |
| `seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE` | deterministic order |
| `operation_id → external_operations NOT NULL`, `intent_id → intents NOT NULL` | guard: the op is a recording of that intent |
| `phase text` | `preflight` \| `release_review` |
| `hold_id → recording_holds` | NOT NULL **iff** `phase = 'release_review'` |
| `epoch integer NOT NULL` | `>= 0` |
| `outcome text` | `eligible` \| `conflict_marker` \| `conflict_lookalike` \| `conflict_same_amount` \| `incomplete` \| `identity_refused` |
| `code text` | the pure module's code (`is_code`), e.g. `LIST_COUNT_INVALID`; NULL iff `eligible` |
| `identity_read_op → external_operations`, `list_read_op → external_operations` | `UNIQUE` each (where not NULL) |
| `identity_evidence → provider_evidence`, `list_evidence → provider_evidence` | |
| `intent_version integer NOT NULL` | |
| `worker text NOT NULL` | |
| `module_version text NOT NULL` | = `OFFLINE_CHARGE_PROOF_VERSION` |
| `client_label text`, `account_ref text` | [TRUST labels]; checked equal to both evidence rows |
| `cfg_payment_method`, `cfg_currency`, `cfg_channel_id`, `cfg_ref_field_id`, `cfg_listing_id` | [TRUST] the worker's configuration snapshot, stored for audit and the later binding (§4.4) |
| `recorded_at timestamptz NOT NULL` | DB `v_t` |

**Outcome / binding CHECKs**, with read / evidence nullability fixed per outcome (§4.2).

### 3.2 New table `booking.recording_claim_assessments` (append-only)

- Columns: `operation_id PK → external_operations`, `assessment_id → recording_assessments NOT NULL`, `claimed_at` (fence `v_t`), `worker`.
- It is written by the fence trigger in the claim's own UPDATE transaction, so there is a durable record of **which** eligible assessment qualified the one claim of the initial attempt.

### 3.3 Replacements of 0011 objects (each restored byte-exact by 0012 down)

| 0011 object (line) | 0012 change |
|---|---|
| `recording_holds.reason` CHECK (0011:27) | + `PREFLIGHT_EXHAUSTED`, `PREFLIGHT_CONFLICT_MARKER`, `PREFLIGHT_CONFLICT_LOOKALIKE`, `PREFLIGHT_CONFLICT_SAME_AMOUNT` |
| `recording_holds.epoch` CHECK `epoch = 0` (0011:33) | `epoch >= 0`, plus `CHECK (reason LIKE 'PREFLIGHT\_%' OR epoch = 0)` |
| *(new column)* `recording_holds.assessment_id → recording_assessments` | NOT NULL **iff** `reason LIKE 'PREFLIGHT\_%'` (conflict: the conflict assessment; exhausted: the third counted one) |
| `recording_hold_decisions.decision` CHECK (0011:49) | + `release_for_initial_send` |
| *(new column)* `recording_hold_decisions.assessment_id` | NOT NULL **iff** `release_for_initial_send` |
| decisions CHECK (0011:57) | unchanged (`link_full_proof` iff `linked_evidence_id`) |
| `recording_holds_guard` release binding (0011:93–120, the decision test at 0011:115) | a release cites its own decision, which is `link_full_proof` (reason `SUCCEEDED_UNPROVEN`) **or** `release_for_initial_send` (reason `PREFLIGHT_*`) |
| `recording_hold_decisions_guard` (0011:123–143, the reason test at 0011:134) | + `release_for_initial_send` only for `PREFLIGHT_*` holds, citing a `release_review` assessment bound to **this** hold |
| `reserved_case_guard` kinds (0011:230) | + the four `OFFLINE_CHARGE_HOLD_PREFLIGHT_*` kinds |
| `reserved_case_binding_verify` (0011:254–282: resolution at 274, release decision at 279) | the case resolution follows its **last** release: `recorded` after `link_full_proof`, `no_action` after `release_for_initial_send`; a released hold cites either decision matching its reason. **The ≥ 1-hold / open-iff-active / intent+kind rules are unchanged.** |
| `recording_claim_fence` (0011:553–581) | the existing checks first and unchanged (state / exact capture, payload, key `:1`, `attempts 0`, undispatched, `offline_charge_attempts 0`, latest, no active hold, no open reserved case); then §5.3 |
| JS `RECORD_FENCE` (`operations.js:75–84`, used at 97 **and** 107) | + `AND booking.recording_claim_ready(o.id)` (a granted read-only function; §5.4) in **both** stages; the trigger stays authoritative |
| `admin_resolve_recording_hold` (0011:753; signature `(uuid, text, uuid[], uuid, text, text, timestamptz)`) | **not replaced** [DECIDE D4: recommended]. `keep_visible` already works for every reason; release goes through a NEW admin function (§6), so existing callers and the R1 / R2 helpers are untouched |

**Unchanged and preserved:**
- the 0010 / 0011 contradiction core and wrapper;
- completion, link and finalisation (incl. the no-active-hold checks);
- `intents_safety_guard`, `admin_close_case`, the inbox, processor and page function;
- `open_recording_visibility_hold` (its reason list stays `ATTEMPT_GT1` / `SUCCEEDED_UNPROVEN`);
- all existing audit rows: every 0011 hold has `epoch 0`, a non-preflight reason and no `assessment_id`, so the replaced CHECKs accept them.

### 3.4 Functions [PROPOSED]

| Function | Grant | Result / errors |
|---|---|---|
| `record_recording_assessment(p_op uuid, p_worker text, p_phase text, p_hold uuid, p_outcome text, p_code text, p_identity_read uuid, p_list_read uuid, p_identity_evidence uuid, p_list_evidence uuid, p_expected_version integer, p_module_version text, p_client_label text, p_account_ref text, p_cfg jsonb) RETURNS uuid` | app | assessment id; `ASSESSMENT_*` refusals (23514) through `dbSafetyCode` |
| `open_recording_preflight_hold(p_op uuid, p_worker text, p_reason text, p_assessment uuid, p_expected_version integer) RETURNS uuid` | app | hold id (idempotent); `HOLD_*` refusals |
| `admin_release_preflight_hold(p_hold uuid, p_assessment uuid, p_evidence uuid[], p_resolver text, p_justification text, p_at timestamptz) RETURNS uuid` | admin | decision id; `HOLD_*` / `ASSESSMENT_*` refusals |
| `recording_claim_ready(p_op uuid) RETURNS boolean` | app + admin (read-only, SD, `STABLE`; no write) | used by the JS mirror; the fence re-evaluates inside the trigger at its own `v_t` |
| `recording_preflight_epoch(p_op uuid) RETURNS integer` | private | the number of released `PREFLIGHT_*` holds of the op |

**JS helpers [PROPOSED]** (in `lib/booking-db/operations.js`, `db/lib/admin.js`):
- `recordRecordingAssessment`, `openRecordingPreflightHold` → `{ ok:true, id } | { ok:false, error }`;
- `adminReleasePreflightHold`;
- `RECORD_FENCE` + `recording_claim_ready`;
- `DB_SAFETY_CODES` additions.

**No helper retries, and R1 / R2 behaviour is unchanged.**

---

## 4. Mapping the pure result to an assessment row

### 4.1 Which pure results are persisted

| Pure call → result | Persisted `outcome` / `code` | Counts toward exhaustion? |
|---|---|---|
| `qualifyPreflight` ok (`offline-charge-proof.js:327–331`) | `eligible` / NULL | — |
| `qualifyPreflight` → `PRIOR_RECORDING_MARKER_PRESENT` (324, `case_only`) | `conflict_marker` | no: opens `PREFLIGHT_CONFLICT_MARKER` at once |
| → `MARKER_LOOKALIKE_CONFLICT` (325) | `conflict_lookalike` | no: opens `PREFLIGHT_CONFLICT_LOOKALIKE` |
| → `SAME_AMOUNT_PAID_UNMARKED_CONFLICT` (326) | `conflict_same_amount` | no: opens `PREFLIGHT_CONFLICT_SAME_AMOUNT` |
| `assessChargeList` refusal `LIST_*` (247–283), or a list read that did not succeed | `incomplete` / that code (or `LIST_READ_NOT_SUCCEEDED`) | **yes** |
| `assessIdentitySnapshot` refusal `IDENTITY_*` (203–225), or an identity read that did not succeed | `identity_refused` / that code (or `IDENTITY_READ_NOT_SUCCEEDED`) | **yes** |
| fact / context / binding refusals: `configRefusal` codes (`PAYMENT_METHOD_UNSET` …), `intentRefusal`, `recordingOpRefusal`, `*_BINDING_MISMATCH`, `*_CONTEXT_CHANGED`, `qualifyPreflight` freshness `IDENTITY_*` / `LIST_*` at 320–321 | **not persisted** (the worker stops locally) | no |

The last row is [DECIDE D1, recommended]. These describe the worker's own inputs or a race, not the provider. Persisting them would let a misconfiguration exhaust the epoch.

**Exhaustion** [DECIDE D2, recommended]:
- Three counted outcomes (`incomplete` / `identity_refused`) of the **current epoch, `phase = 'preflight'`**.
- After that, `record_recording_assessment` refuses further preflight rows in that epoch (`ASSESSMENT_EPOCH_EXHAUSTED`), the fence refuses, and the worker may only open `PREFLIGHT_EXHAUSTED`.
- `release_review` rows never count.

### 4.2 Required reads and evidence per outcome (DB-checked)

| Outcome | identity read / evidence | list read / evidence |
|---|---|---|
| `eligible` | read `hostaway.retrieve_reservation`, `succeeded`; evidence kind `hostaway_reservation`, status `found_active`, `read_operation_id` = that read | read `hostaway.list_offline_charges`, `succeeded`; evidence `hostaway_offline_charges` / `listed`, `read_operation_id` = that read |
| `conflict_*` | as eligible (a positive identity is required by `qualifyPreflight` before partitioning) | as eligible |
| `incomplete` | as eligible (positive identity), **or** NULL if the list was attempted first [DECIDE D7: recommended "as eligible"] | read cited, terminal (`succeeded` or `escalated`); **no evidence row for that read may exist** (`NOT EXISTS provider_evidence WHERE read_operation_id = list_read_op`) |
| `identity_refused` | read cited, terminal; no evidence for it, or evidence that is not `found_active` | NULL (no list read is counted) |

No evidence is invented for failed or incomplete reads.
- A failed read is cited by id only.
- Evidence recorded for that read later can never be used: the read is already counted (`UNIQUE`).

### 4.3 DB-checkable bindings (checked in `record_recording_assessment`, and again for eligible rows in the fence)

**Every cited read row:**
- `intent_id = p_op.intent_id`; the right `op_type`; `retry_class = 'read'`;
- payload `reservationId = intents.hostaway_reservation_id` (identity via `payload ->> 'reservationId'`, list the same);
- not cited by any other assessment (`UNIQUE`);
- not the read of the recording's completion proof (that read must be after dispatch; 0010 `EVIDENCE_READ_BEFORE_SEND`, 0010:72–74).

**Every cited evidence row:**
- `intent_id` matches; source `hostaway_api`; `external_ref = hostaway_reservation_id`.

**Identity `observed`, DB-compared with the intent:**
- `listingId = listing_id`, `from` / `to` = the stay, `totalMinor = final_total_minor`;
- `currency = intents.currency`, `bookingRef = intents.ref`, `channelId = 2000`, `status = 'new'`;
- `reservationId = external_ref`.

**List `observed`** [PROPOSED preflight keys, still the count-only shape, so no `marker` key]:
- `matchingChargeCount` / `matchingChargeIds` (exact-title rows), `lookalikeCount`, `sameAmountPaidCount`, `rowCount`, `readCount = 1`, `executorAccountRef`, `clientSnapshotId`;
- consistency: `eligible` ⇒ all three counts 0; `conflict_marker` ⇒ `matchingChargeCount ≥ 1`; `conflict_lookalike` ⇒ `lookalikeCount ≥ 1`; `conflict_same_amount` ⇒ `sameAmountPaidCount ≥ 1`.

**Labels:** `client_label` = both evidence rows' `clientSnapshotId`, and `account_ref` = both rows' `executorAccountRef` (label equality only).

**Op:**
- `pending`, key `och:<intent>:1`, `attempts = 0`, `dispatched_at IS NULL`, latest;
- `preflight`: **no active hold**; `release_review`: its `p_hold` is the op's active `PREFLIGHT_*` hold.

**Intent and lease:**
- `payment_captured`, `captured_minor = final_total_minor`, `offline_charge_attempts = 0`, `version = p_expected_version`;
- `intent_work.work_worker_id = p_worker` and `work_lease_until ≥ v_t`.

**`recordedPaymentAt`** (pure input, 139–154) should be the DB-stamped transition into `payment_captured`; the assessment does not need to persist it (it only feeds the request). Its correctness at request-build time stays worker-side [TRUST].

### 4.4 What remains [TRUST], honestly

- **Classification.** That the outcome is the correct pure classification of the actual provider response. The DB cross-checks the counts the worker reports; it never sees the raw JSON.
- **Provenance.** That the reads were really executed against Hostaway; that labels name the real client / credential / account; that `observed_at` (= read `completed_at`, caller time) is the real observation time.
- **Brands.** The process-local brands (`WeakSet`, 54–57) and an in-memory `ok: true` are **not** DB attestation. The DB accepts only its own bound rows.
- **Configuration.** `paymentMethod` / `currency` / `refFieldId` / `accountRef` are stored and compared for equality between rows, but **the DB cannot know the configured values**. Changing config between assessment and request build is detected only by the pure module's context equality in the same process (`buildOfflineChargeRequest`, 359–374).
- **Proposed binding** [DECIDE D5, recommended, later slice]: completion's confirming proof `executorAccountRef` = the claim assessment's `account_ref`.
- **Currency policy.** The pure module approves USD only (33); the DB checks equality with `intents.currency`, not USD [DECIDE D6].

---

## 5. Freshness, epochs, claim

### 5.1 Clocks

- Every 0012 function samples `v_t := clock_timestamp()` **after its last potentially blocking lock**, and uses only `v_t` for leases and freshness. This includes the fence trigger and the admin release.
- **Freshness is checked on both evidence rows**, inclusive, with no future: `v_t − 2 min ≤ observed_at ≤ v_t`. It is checked three times:
  1. at assessment (`record_recording_assessment`);
  2. again at claim (the fence, for the qualifying eligible row);
  3. again at owner release (for its `release_review` row).
- **What is caller time.** `observed_at` is the caller's read completion time [TRUST]; the DB only refuses implausible values against its own clock.

### 5.2 Ordering floors ("after the hold", "after the release")

- `provider_evidence.created_at` (`DEFAULT now()`, 0003:67) is the evidence writer's **transaction start** on the DB clock: a DB-assigned **lower bound**, not the commit time and not the provider read time. The read row's own `created_at` is caller-written (`requestRead`) and is **not** used as a floor.
- Floors used:
  - `release_review`: both evidence `created_at > hold.created_at` (the hold function's `v_t`);
  - a new-epoch `preflight`: both evidence `created_at > the release decision's recorded_at` (`v_t`).
- **Never relied on alone.** Each floor is combined with the 2-minute freshness at the deciding instant and the once-only read use. The floor rules out *replaying* evidence that existed before the hold or release; it cannot prove the provider call happened after it [TRUST].

### 5.3 Fence addition (in `recording_claim_fence`, after the unchanged 0011 checks)

- **The qualifying assessment.** `a` is the op's latest (max `seq`) `preflight` assessment of the **current epoch**, and:
  - `a.outcome = 'eligible'`;
  - `a.intent_version = intents.version`: any intent transition since the assessment invalidates it;
  - `a.worker = NEW.lease_worker_id`, and that worker holds `intent_work` with `work_lease_until ≥ v_t` [DECIDE D3, recommended];
  - both evidence rows fresh at the fence's `v_t` (§5.1);
  - the epoch is not exhausted.
- **Audit.** It inserts `recording_claim_assessments (op, a.id, v_t, worker)`.
- **No automated attempt > 1.** Keys other than `:1` stay fenced by the unchanged 0011 rule, and an ambiguous write is never redispatched: `attempts 0` / `dispatched_at IS NULL` are unchanged.

### 5.4 `recording_claim_ready(op)` and the JS mirror

- It is the same predicate as the fence minus the lease-worker equality (the claimant is not known before the claim), evaluated at `clock_timestamp()`.
- The mirror only **skips**. A row that passes the mirror and fails the trigger (for example, evidence ageing between the two statements) raises `RECORDING_CLAIM_FENCED` inside the claim transaction. That transaction rolls back with no claim, and the helper surfaces it; there is no retry.

### 5.5 Epochs

- `epoch(op)` = the count of released `PREFLIGHT_*` holds of the op (computed under the op lock). The exhaustion count, the latest-assessment selection and the fence all use **only the current epoch**.
- `release_for_initial_send` releases the hold and thereby starts epoch `n + 1`.
  - The old epoch's `release_review` (and any old preflight) **does not qualify** the new-epoch fence.
  - A new `preflight` eligible assessment, with evidence whose `created_at` > the release `recorded_at`, is required. Nothing carries forward.

---

## 6. Preflight holds and owner release

### 6.1 `open_recording_preflight_hold`

- **Locks:** intent SHARE → `intent_work` SHARE → op UPDATE → advisory evidence key → active hold of op UPDATE → open same-kind case UPDATE → `v_t`.
- **Checks:**
  - the work lease of `p_worker` at `v_t` and the version;
  - op `pending` / `:1` / `attempts 0` / undispatched / latest;
  - `PREFLIGHT_CONFLICT_*` cites a current-epoch `preflight` assessment of this op with the matching outcome;
  - `PREFLIGHT_EXHAUSTED` cites the third counted current-epoch assessment.
- **Idempotent** for the same reason; a different active reason → `HOLD_ALREADY_ACTIVE`.
- **Case:** joins an open same-kind case or inserts a new one (0011 rules: `opened_by = 'recording-hold:'||case.id`, two-way deferred binding, ≥ 1 hold per case, open iff an active hold).
  - A legitimate same-kind collision (history with another op) joins the case. It is never `DO NOTHING`, never an overwrite.
- **Effect.** No state, version, op or effect change. While the hold is active the fence refuses: both the op hold and, fail-closed, any open reserved case of the intent (0011:572–575).

### 6.2 `admin_release_preflight_hold(p_hold, p_assessment, p_evidence[], resolver, justification, at)` (admin only)

- **Locks:** intent SHARE → op UPDATE → advisory → hold UPDATE → case UPDATE → `v_t`.
- **The hold:** active, reason `PREFLIGHT_*`.
- **The op:** still `pending` / `:1` / `attempts 0` / undispatched / latest.
- **The intent:** `payment_captured`, and `version = hold.intent_version_at_hold = assessment.intent_version`. If the version changed since the hold, the release is refused (`HOLD_CONTEXT_CHANGED`); the owner must keep it visible, or obtain a new review after a new hold is opened in the new context [DECIDE D8].
- **`p_assessment`:** `phase = 'release_review'`, `hold_id = p_hold`, `outcome = 'eligible'`, both evidence rows fresh at `v_t` and created after the hold (§5.2). Cited evidence is validated (`cited_evidence`); it may be empty besides the assessment's own two rows.
- **Writes** a `recording_hold_decisions` row (`release_for_initial_send`, `assessment_id`), sets `released_at` / `release_decision_id`, and resolves the case `no_action` **only when no other bound hold stays active**. A same-assessment replay on the released hold returns the earlier decision id; anything else on a released hold → `HOLD_NOT_ACTIVE`.
- **What a release is not.** It is **not** a claim, a send or a confirmation. An unrelated open reserved case on the intent still fences. The new epoch requires a new preflight (§5.5), and the claim must still pass every fence check.

### 6.3 What the DB guarantees, and what it cannot

**Guaranteed (proposed):**
- No claim of the initial recording without a current-epoch, current-version, fresh eligible assessment by the claiming worker.
- No claim while any hold or open reserved case exists.
- One claim ever: `attempts 0` / undispatched / key `:1`.
- Every decision and assessment is append-only.

**Not guaranteed:**
- **Provider-side read / write race.** Between the preflight reads and the POST, the provider state can change (an owner or another system records a charge). The 2-minute window narrows this but cannot close it.
- **Detection afterwards.** The confirming read and the 0011 inbox / `LINKED_CONTRADICTED` path detect a duplicate **afterwards**. Nothing reverses or retries.
- **Context changes after the claim** (configuration, label meaning) are the worker's responsibility.

### 6.4 [OUTSIDE] isolated

These are not part of 0012 and not authorized. 0012 must not add placeholders for them:
- `recorded_manually` (op `pending → superseded`);
- owner manual finalisation;
- any contradiction override;
- `ATTEMPT_GT1` release.

`keep_visible` (0011) already applies to `PREFLIGHT_*` holds unchanged.

---

## 7. Lock order and contention

**Uniform order (one intent only):**

> intent (SHARE, or NO KEY UPDATE for `applyEvent`) → `intent_work` (SHARE) → recording op (SHARE / UPDATE) → read rows (SHARE) → advisory evidence key `(hashtext('booking.recording_evidence'), hashtext(intent))` → hold (UPDATE) → reserved case (UPDATE) → `clock_timestamp()`

| Path | Locks (actual strength) | Contention outcome |
|---|---|---|
| `record_recording_assessment` | intent `FOR SHARE` → work `FOR SHARE` → op `FOR SHARE` → reads `FOR SHARE` → advisory → `v_t` | vs claim (op `FOR UPDATE SKIP LOCKED`): the helper skips while the assessment holds op SHARE; a direct UPDATE waits, then the fence sees the committed assessment. Claim first: the assessment waits on op SHARE, then sees `in_flight` → `ASSESSMENT_TARGET_STATE` |
| claim helper + fence | intent `FOR SHARE` → op `FOR UPDATE SKIP LOCKED` → (trigger) intent `FOR SHARE`, reads of assessments / evidence / holds / cases (no lock; immutable or read-only) → `v_t` → claim-audit INSERT | serialized with the openers via the op lock |
| direct app `UPDATE … in_flight` | op row lock → (trigger) intent `FOR SHARE` | vs `applyEvent` (intent `FOR NO KEY UPDATE` → op): a possible **40P01** on one side (observed for 0011 in T-B3). Bounded and retryable by the caller; never a bypass; no automatic retry in our helpers |
| `open_recording_preflight_hold` / `open_recording_visibility_hold` | intent SHARE → (work SHARE) → op UPDATE → advisory → hold → case | vs claim: op lock; hold first → claim fenced; claim first → `HOLD_TARGET_STATE` |
| `admin_release_preflight_hold` | intent SHARE → op UPDATE → advisory → hold → case | vs a new preflight of the same op: op lock (UPDATE vs SHARE) serializes; vs claim: op lock |
| evidence writers (0010 + 0011 trigger) | read op UPDATE → evidence INSERT → **inbox INSERT** → advisory | they never lock the recording op; no inversion |
| inbox processor (0011, one item per call) | inbox row SKIP LOCKED → intent SHARE → op SHARE → advisory → hold / case | preflight evidence → `not_latest_linked` (the op is pending); unchanged |
| finalisation | intent NO KEY UPDATE → (trigger) advisory | unchanged |

**Race outcomes:**

| Race | Outcome |
|---|---|
| Simultaneous assessment vs claim | above: one waits or skips; the loser re-checks and refuses. No claim on an uncommitted assessment |
| Hold vs claim | the op lock decides; hold first → claim fenced (skip / raise); claim first → hold refused |
| Stale lease after waiting | every check is at the post-wait `v_t` (the 0010 T-28 pattern): an assessment or claim whose work lease expired while waiting is refused |
| Duplicate assessment (same read twice) | `UNIQUE` violation → `ASSESSMENT_READ_ALREADY_COUNTED` (mapped); a duplicate concurrent call: the second waits on advisory, then hits the unique read |
| Duplicate release | second → same decision id (replay) or `HOLD_NOT_ACTIVE` |
| Old-epoch replay | refused by the epoch and the evidence `created_at` floor; old reads are already counted |
| `release_review` vs new epoch | a `release_review` needs the hold **active**; after the release it is refused (`HOLD_NOT_ACTIVE`); a review never qualifies the fence |
| Inbox items before / after the link | preflight evidence is processed as `not_latest_linked`; completion-proof contradictions after the link follow 0011 unchanged |

**SQL role privileges:**
- app: EXECUTE `record_recording_assessment`, `open_recording_preflight_hold`, `recording_claim_ready`;
- admin: EXECUTE `admin_release_preflight_hold`, `recording_claim_ready`;
- tables: SELECT-only for all three roles;
- private: the epoch helper, the guards, the fence.

**Not claimed:** universal deadlock freedom. Each path takes one intent's locks in the order above. The direct-UPDATE inversion is the one known 40P01 shape; tests must observe actual waits (`pg_locks`).

---

## 8. Up / down

**0012 up**, one transaction:
1. **Precondition:** no `OFFLINE_CHARGE_HOLD_PREFLIGHT_*` case exists.
2. Create `recording_assessments` and `recording_claim_assessments`, with guards, RLS SELECT policies, `reject_change`.
3. `ALTER TABLE` to add the two `assessment_id` columns and FKs.
4. Drop and re-add the four named CHECK constraints with the widened definitions.
5. CREATE OR REPLACE: `recording_holds_guard`, `recording_hold_decisions_guard`, `reserved_case_guard`, `reserved_case_binding_verify`, `recording_claim_fence`.
6. Create the new functions; grants.

**0012 down:**
1. **Refuse** if any assessment, claim-assessment row, `PREFLIGHT_*` hold or `release_for_initial_send` decision exists (no audit loss).
2. Otherwise restore the five 0011 function bodies **verbatim from the 0011 file** (generator, as for 0011).
3. Restore the four CHECKs with the original names and definitions; drop the two columns, the two tables and the new functions.

**Round trip measured like 0011.** Bodies (md5), ACLs, security, `search_path`, triggers, columns, grants, policies and constraints must equal a fresh cluster at 11. Migrations 0001–0011 are byte-identical.

---

## 9. Planned local-PG tests (PLANNED; full TAP retained; nothing run for this docs task)

| # | Scenario | Expect |
|---|---|---|
| P-A1 | app / admin / report direct writes to both new tables; owner DELETE / UPDATE / TRUNCATE | refused |
| P-A2 | assessment bindings: foreign intent read, wrong read type, read of another reservation, payload mismatch, evidence of another read, dashboard evidence, unsucceeded read cited as eligible, incomplete with existing evidence, reused read (both columns, across phases), the completion-proof read | refused |
| P-A3 | identity `observed` mismatches (listing, dates, total, currency, `bookingRef`, channel, status) and list-count inconsistency per outcome | refused |
| P-A4 | op not pending / `attempts > 0` / dispatched / `:2` / not latest / held; intent version stale; foreign / expired work lease (incl. expiry **while waiting** on each lock) | refused at the post-wait `v_t` |
| P-F1 | freshness at exactly `v_t − 2 min` / `v_t` / `v_t + 1 µs`; ageing between assessment and claim | accepted / accepted / refused; claim refused |
| P-F2 | fence: no assessment; latest not eligible; eligible but older than a later non-eligible one; version changed after the assessment; other worker; exhausted epoch | refused (both JS stages skip; direct UPDATE raises) |
| P-F3 | the happy path: eligible → claim → claim-audit row → completion / link / finalisation unchanged (0010 tests) | as 0010 |
| P-E1 | exhaustion: 3 counted outcomes → further preflight refused, the fence refuses, `EXHAUSTED` hold opens; conflict outcomes do not count; `release_review` never counts | asserted |
| P-H1 | conflict holds (each kind) cite their assessment; duplicate opener; different reason; same-kind collision joins the case; binding probes (≥ 1 hold, open iff active, resolution by last release) | 0011-style |
| P-R1 | release: `release_review` under the active hold, fresh, created after the hold → released; new epoch | accepted |
| P-R2 | release refused: review of another hold / op, stale review, review evidence created before the hold, version changed, wrong reason, `ATTEMPT_GT1` hold, an app caller | refused |
| P-R3 | after release: the old review / old preflight does not qualify; a new preflight with new reads does; replay of the release; `release_review` after the release | asserted |
| P-R4 | release does not claim or dispatch; an unrelated open reserved case still fences | asserted |
| P-L1 | locks: assessment vs claim, hold vs claim, release vs preflight (both orders, observed waits); direct UPDATE inversion (40P01 or serialized; never a bypass) | asserted with `pg_locks` |
| P-G1 | 0012 down → equals a fresh cluster at 11; up again identical; down refuses with any assessment / preflight hold / release | asserted |
| P-G2 | regressions kept: all 0010 / 0011 suites, predicate / page parity, the microsecond cursor, the owner-history fixtures, inbox error / R1 / R2 tests | unchanged |

**Fault-injection targets:**
- the eligible requirement in the fence and in `recording_claim_ready`;
- the version equality;
- the worker / lease binding;
- the fence-time freshness;
- the epoch filter;
- the exhaustion count;
- unique-read counting;
- the `created_at` floors;
- the review-bound-to-hold rule;
- the release freshness;
- last-hold case resolution;
- the JS mirror (both stages);
- the claim-audit insert.

---

## 10. Implementation slices and open decisions

**Recommended slices:**
1. **0012a:** `recording_assessments` + `record_recording_assessment` + `recording_claim_ready` + fence addition + claim audit + JS mirror. Safe alone: a claim then needs an eligible assessment, and non-eligible outcomes simply never qualify.
2. **0012b:** preflight holds + `admin_release_preflight_hold` + the five replaced 0011 objects / CHECKs.
3. **Later and separate:** the worker / adapter integration and D5 (account-label binding at completion).

| # | Open decision | Recommendation |
|---|---|---|
| D1 | Persist fact / context / binding refusals? | No (worker-local; they must not exhaust the epoch) |
| D2 | Exhaustion counts only `incomplete` / `identity_refused`; after 3 the epoch refuses more preflight | Yes |
| D3 | Claimant = assessing worker with a live work lease at the fence | Yes |
| D4 | A new admin release function instead of widening `admin_resolve_recording_hold` | New function (signature compatibility, R1 / R2 untouched) |
| D5 | Bind the completion proof's `executorAccountRef` to the claim assessment's `account_ref` | Yes, but in a separate reviewed replacement of the 0010 completion function |
| D6 | DB enforcement of the USD policy | No in 0012 (config policy stays worker-side; equality with `intents.currency` only) |
| D7 | `incomplete` requires a positive identity read | Yes |
| D8 | A release after an intent version change | Refuse; the owner keeps it visible |
| D9 | Slice split 0012a / 0012b vs one 0012 | Split |

**Blockers before the worker:**
- the D5 binding;
- live-unverified provider shapes (pure module header, `offline-charge-proof.js:17`);
- the `paymentMethod` owner choice;
- all live gates;
- the unexplained e74a guard failure (release-readiness).
