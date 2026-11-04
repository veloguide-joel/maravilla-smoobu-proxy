# E7.4b-D1 preflight: assessment persistence (migration 0012) and preflight holds + owner release (migration 0013), revision 2 (IMPLEMENTATION CONTRACT, DOCS ONLY)

**Branch.** `feature/e7-offline-charge-preflight-contract`.
- Revision 1: `44ca7df`, from `34f0314`.
- **Revision 2** answers root's HOLD on `44ca7df`: decisions D1–D9 and corrections R1–R6. The resolution map is §13. This revision **replaces** revision 1 entirely.

**Status (updated on `feature/e7-offline-charge-assessments`).**
- Root ACCEPTED revision 2 (`3967755`) as the **0012 (slice A)** implementation basis, with binding addendum A–F. **0012 is PRESENT and accepted offline at `ff07fe8`** (root ruling on `ff07fe8`; Claude-run local PG only); the exact map is **§14**.
- **0013 (slice B) is PRESENT and accepted offline at `185da0e`**; D5 / 0014 is PROPOSED (`claude/e74b-completion-binding-contract.md`). **§8 below is SUPERSEDED** by `claude/e74b-preflight-release-contract.md` (refreshed against the actual 0012); where they differ, that document governs.
- **PRESENT and accepted:** 0010 (`d801b43`); 0011 + R1 / R2 helpers (`cd77088` + `34f0314`); the pure module `lib/checkout/offline-charge-proof.js` (`4f6b27f`, unchanged).
- **Design (revision 2):** two separate executable migrations, **0012** (slice A: assessments + claim fence + conflict / exhaustion latch) and **0013** (slice B: preflight holds + owner release). Each is independently reviewable and reversible to its predecessor when audit-free. An accepted / applied 0012 is never amended into 0013.
- Migrations 0001–0011 stay byte-identical on disk; historical comment errata are in §12.

**Labels.**
- **[PRESENT]** code at `34f0314`, cited as path:line.
- **[PROPOSED-0012]** / **[PROPOSED-0013]** this design, per migration.
- **[TRUST]** input the database cannot attest.
- **[OUTSIDE]** not authorized.

**Boundaries.**
- Nothing here is implemented.
- **No fence, assessment or release authorizes a provider send by itself.**
- The worker, adapter, routes, UI and schedules stay [OUTSIDE].
- No automatic resend, no automated attempt > 1, no redispatch of any ambiguous write.
- No ESCALATE, notification, refund, cancel or void.
- No `paymentMethod` choice is assumed; every live gate stays closed.

---

## 0. Root decisions recorded (HOLD on 44ca7df)

| # | Decision |
|---|---|
| D1 | Fact / config / context / binding / input-timing refusals stay worker-local, are never persisted, and never count. The exact code families are in §4.1. |
| D2 | Only `incomplete` and `identity_refused` count, with a threshold of 3 per current epoch. **A conflict blocks immediately and persistently** (§5.4 latch), not merely until the next assessment. |
| D3 | The assessing worker is the claimant, with a live work lease checked **under a lock** at the decision clock (§7.2). |
| D4 | A separate `admin_release_preflight_hold` (0013). The `admin_resolve_recording_hold` signature (0011:753) is unchanged. |
| D5 | Yes in principle: a **separate reviewed completion binding before any worker integration**. It covers both the confirming proof's `executorAccountRef` and its `paymentMethod` against the claim assessment's config snapshot. This does **not** select the owner's payment method. It is not part of 0012 / 0013. |
| D6 | The DB checks currency **equality with the intent** only. The USD-only live policy stays in the unchanged pure module / worker ([TRUST]); the DB does not claim to prove every pure config policy. Existing MXN test history is not live authorization. |
| D7 | `incomplete` **requires** a positive identity read; the alternative is removed. |
| D8 | A release after an intent version change is refused strictly; the hold stays visible. No new hold can be opened in that case: one active hold per op, frozen identity, and no other release path in this stage. |
| D9 | Split into **0012** (A) then **0013** (B): distinct versions, separate down gates, no amendment. |

---

## 1. What changes, in brief

**0012 (A).**
- **Gate.** The initial recording can be claimed only with a persisted, DB-bound, fresh, eligible preflight assessment, recorded by the claiming worker, at the current intent version.
- **Latch.** A conflict or exhaustion recorded in the current epoch latches the op as **blocked**, regardless of any later eligible row, until (only in 0013) an owner release starts a new epoch.
- **Scope.** 0012 has no holds and no release, so a latched op stays blocked. It is visible through read-only tables and `recording_claim_ready` (§6.4).

**0013 (B).**
- Conflict / exhaustion get durable owner-visible `PREFLIGHT_*` holds (the 0011 machinery).
- The owner may release such a hold only with a fresh `release_review` assessment taken under that same active hold.
- A release starts a new epoch, with no carry-forward. It never claims, sends or confirms.

---

## 2. Present baseline relied on (verified at 34f0314)

| Fact | Where |
|---|---|
| **Pure identity / list / qualify functions.** Brands are a process-local `WeakSet`; eligibility carries `sendAuthorization: false`. | `lib/checkout/offline-charge-proof.js:54–57`, 200–232, 244–288, 309–332 |
| Freshness 2 min inclusive; future refused; input-timing codes `MAX_AGE_INVALID`, `NOW_INVALID`, `OBSERVED_AT_INVALID`, `OBSERVED_IN_FUTURE`, `STALE` | `offline-charge-proof.js:36`, 87–94 |
| Config keys / codes; approved methods (no default); USD only; direct channel 2000 | `offline-charge-proof.js:32–33`, 122–136; `lib/hostaway-reservations.js:41` |
| Intent facts / codes; initial-recording facts / codes | `offline-charge-proof.js:139–156`, 158–170 |
| Envelope codes `MALFORMED_ENVELOPE`, `FAIL_ENVELOPE`; normalization codes | `lib/hostaway-reservations.js:274–325` |
| Request built PRE-CLAIM with carried freshness re-checked | `offline-charge-proof.js:359–374` |
| `requestRead` writes read rows with **caller** `created_at` | `lib/booking-db/operations.js` (`requestRead`) |
| API evidence: `observed_at := read.completed_at` (caller); `created_at DEFAULT now()` = writer **transaction start** (DB) | 0010:354–390; 0003:67 |
| Evidence shapes (`found_active` keys; offline-charge count / ids equality) | 0003:85–97 |
| `intent_transitions.recorded_at := statement_timestamp()` (DB-stamped) | 0005:24–30; table 0001:207–221 |
| Work leases: `claimIntentWork` (`FOR UPDATE OF w SKIP LOCKED`, then UPDATE); `applyEvent` locks the intent `FOR NO KEY UPDATE`, then updates `intent_work.next_action_at`; existing workers already re-check their lease under `intent_work FOR SHARE` (precedent) | `lib/booking-db/repo.js:642–653`, 358, 271; `capture-worker.js:105–106`; `compensation-worker.js:115–116` |
| Claim helper: intent `FOR SHARE` (101) → op `FOR UPDATE SKIP LOCKED` (108); **no** `intent_work` lock today | `operations.js:88–108` |
| Latest recording / attempt number | 0010:24–37 |
| 0011 claim fence; holds / decisions / binding; owner decisions | 0011:553–581, 23–60, 93–143, 222–297, 753–832 |
| 0011 constraint names (measured on a throwaway local cluster at 34f0314) | `recording_holds_reason_check`, `recording_holds_epoch_check`, `recording_holds_check`; `recording_hold_decisions_decision_check`, `recording_hold_decisions_check`, `recording_hold_decisions_check1` |
| JS fence mirror in both claim stages | `operations.js:75–84`, 97, 107 |
| R1 / R2 helpers | `operations.js:217–232`, 245, 259–286 |

---

## 3. Migration 0012 (slice A) [PROPOSED-0012]

### 3.1 `booking.recording_assessment_codes` (reference data; seeded by 0012 and immutable)

- Columns: `outcome text`, `code text`, `evidence_rule text`, `PRIMARY KEY (outcome, code)`.
- Seeded with exactly the persistable codes of §4.1.
- `evidence_rule` ∈:
  - `none`: no evidence row may exist for the read;
  - `found_active_mismatch`: evidence `found_active` must exist, and the code's mismatch is **re-derived** (§4.2);
  - `not_found_or_cancelled`: evidence with that status.
- SELECT for app / admin / report; **no write grant**; `reject_change` on UPDATE / DELETE / TRUNCATE.

### 3.2 `booking.recording_assessments` (append-only; RLS SELECT-only for app / admin / report; no write grant)

| Column | Rule (0012) |
|---|---|
| `id uuid PK` | |
| `seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE` | deterministic order |
| `operation_id → external_operations`, `intent_id → intents` | the op is the intent's recording (guard) |
| `phase text` | `CONSTRAINT recording_assessments_phase_check CHECK (phase = 'preflight')` (0013 widens) |
| `epoch integer` | `CONSTRAINT recording_assessments_epoch_check CHECK (epoch = 0)` (0013 widens) |
| `outcome text` | `eligible`, `conflict_marker`, `conflict_lookalike`, `conflict_same_amount`, `incomplete`, `identity_refused` |
| `code text` | NULL iff `eligible`; for conflicts the pure code (`PRIOR_RECORDING_MARKER_PRESENT` / `MARKER_LOOKALIKE_CONFLICT` / `SAME_AMOUNT_PAID_UNMARKED_CONFLICT`); otherwise `FOREIGN KEY (outcome, code) → recording_assessment_codes` |
| `identity_read_op`, `list_read_op → external_operations` | `UNIQUE` each where not NULL |
| `identity_evidence`, `list_evidence → provider_evidence` | per-outcome nullability (§4.2), as CHECKs |
| `intent_version integer` | |
| `worker text` | |
| `module_version text` | `CHECK (module_version IN ('offline-charge-proof-v1'))`; the allowlist widens only by migration |
| `cfg jsonb` | §4.4 exact keys |
| `client_label text`, `account_ref text` | label regex `^[A-Za-z0-9._:-]{1,64}$` |
| `recorded_at timestamptz` | DB `v_t` |

No `hold_id` column and no FK to absent objects in 0012.

### 3.3 `booking.recording_claim_assessments` (append-only)

- Columns: `operation_id PK → external_operations`, `assessment_id → recording_assessments`, `worker`, `claimed_at` (fence `v_t`).
- Inserted by the fence **inside the claim UPDATE's transaction**.

### 3.4 Functions (0012)

| Function | Security / volatility / grant | Behaviour |
|---|---|---|
| `record_recording_assessment(p_op uuid, p_worker text, p_outcome text, p_code text, p_identity_read uuid, p_list_read uuid, p_identity_evidence uuid, p_list_evidence uuid, p_expected_version integer, p_module_version text, p_client_label text, p_account_ref text, p_cfg jsonb) RETURNS uuid` | SD, VOLATILE, fixed `search_path`; app EXECUTE | §4–§5; refusals `ASSESSMENT_*` (23514); **phase is fixed to `preflight`**, so the signature stays stable when 0013 adds a separate review function |
| `recording_claim_ready(p_op uuid) RETURNS boolean` | SD, **VOLATILE** (reads `clock_timestamp()`; each inner statement takes a fresh READ COMMITTED snapshot); read-only; takes no locks; app + admin EXECUTE | the fence predicate minus the claimant / lease equality (§6.4). **Advisory only**: the trigger is authoritative |
| `recording_preflight_block(p_op uuid) RETURNS text` | SD, VOLATILE, private | `CONFLICT_LATCHED` / `EXHAUSTED` / NULL for the current epoch (§5.4) |
| `recording_claim_fence()` | CREATE OR REPLACE of 0011:553–578 (SD, VOLATILE, unchanged security and `search_path`) | the 0011 body verbatim first, then §6.3 |

**JS (0012):**
- `RECORD_FENCE` (`operations.js:75–84`) gains `AND booking.recording_claim_ready(o.id)`, used unchanged in **both** stages (97, 107).
- The claim helper adds `SELECT 1 FROM booking.intent_work WHERE intent_id = $1 FOR SHARE` between its intent lock and its op lock (§7.2).
- New `recordRecordingAssessment` → `{ ok, id } | { ok:false, error }`.
- `DB_SAFETY_CODES` additions. **No retries; R1 / R2 unchanged.**

### 3.5 0012 down

1. **Refuse** if any `recording_assessments` or `recording_claim_assessments` row exists.
2. Restore `recording_claim_fence` **verbatim from the 0011 file** (generator, as for 0011).
3. Drop the 0012 functions, tables and seed data.

**Round trip:** equal to a fresh cluster at 11 (bodies md5, ACLs, security, `search_path`, triggers, columns, grants, policies, constraints). The JS helper change is reverted by code, not by SQL.

---

## 4. Pure result → assessment row (exact)

### 4.1 Code families (mutually exclusive)

**Worker-local, NEVER persisted (D1):**
- unprefixed fact codes from `configRefusal` (122–136): `CONFIG_REQUIRED`, `PAYMENT_METHOD_UNSET`, `CONFIG_SHAPE`, `PAYMENT_METHOD_NOT_APPROVED`, `CURRENCY_NOT_APPROVED`, `CHANNEL_NOT_DIRECT`, `ACCOUNT_REF_INVALID`, `CONFIG_IDS_INVALID`, `ADAPTER_CONFIG_*`;
- unprefixed fact codes from `intentRefusal` (141–156) and `recordingOpRefusal` (160–170);
- input shape / label / binding: `IDENTITY_SNAPSHOT_SHAPE`, `IDENTITY_ACCOUNT_REF_MISMATCH`, `IDENTITY_CLIENT_LABEL_INVALID`, `LIST_READ_SHAPE`, `LIST_ACCOUNT_REF_MISMATCH`, `LIST_CLIENT_LABEL_INVALID`, `LIST_REQUEST_NOT_CANONICAL`;
- input timing: `IDENTITY_` / `LIST_` + {`MAX_AGE_INVALID`, `NOW_INVALID`, `OBSERVED_AT_INVALID`, `OBSERVED_IN_FUTURE`, `STALE`};
- `qualifyPreflight` refusals: `POSITIVE_IDENTITY_REQUIRED`, `COMPLETE_LIST_REQUIRED`, `RESERVATION_BINDING_MISMATCH`, `ACCOUNT_REF_BINDING_MISMATCH`, `CLIENT_LABEL_BINDING_MISMATCH`, `IDENTITY_CONTEXT_CHANGED`, `LIST_CONTEXT_CHANGED`, and the freshness codes at 319–321.

**Persistable `identity_refused`** (provider-response observations from `assessIdentitySnapshot`, 208–225):

| Code | `evidence_rule` |
|---|---|
| `IDENTITY_HTTP_STATUS` | `none`, or `not_found_or_cancelled` for a 404 the worker recorded as `not_found` |
| `IDENTITY_MALFORMED_ENVELOPE`, `IDENTITY_FAIL_ENVELOPE`, `IDENTITY_RESULT_NOT_OBJECT`, `IDENTITY_NOT_NORMALIZABLE` | `none` |
| `IDENTITY_` + each normalizer code (`MALFORMED_RESERVATION`, `RESERVATION_ID_INVALID`, `RESERVATION_ID_INCONSISTENT`, `LISTING_ID_INVALID`, `CHANNEL_ID_INVALID`, `DATES_INVALID`, `AMOUNT_NOT_EXACT`, `CURRENCY_INVALID`, `STATUS_INVALID`, `CUSTOM_FIELDS_MALFORMED`, `REF_FIELD_DUPLICATED`, `REF_VALUE_INVALID`) | `none` |
| `IDENTITY_CURRENCY_MISMATCH`, `IDENTITY_RESERVATION_ID_MISMATCH`, `IDENTITY_LISTING_MISMATCH`, `IDENTITY_CHANNEL_MISMATCH`, `IDENTITY_ARRIVAL_MISMATCH`, `IDENTITY_DEPARTURE_MISMATCH`, `IDENTITY_TOTAL_MISMATCH`, `IDENTITY_REF_MISMATCH`, `IDENTITY_STATUS_NOT_ACTIVE` | `found_active_mismatch`, or `none` |

**Persistable `incomplete`** (from `assessChargeList`, 255–279), always `none`:
- `LIST_HTTP_STATUS`, `LIST_MALFORMED_ENVELOPE`, `LIST_FAIL_ENVELOPE`, `LIST_RESULT_NOT_ARRAY`;
- `LIST_COUNT_INVALID`, `LIST_COUNT_LENGTH_MISMATCH`;
- `LIST_ROW_MALFORMED`, `LIST_ROW_ID_INVALID`, `LIST_DUPLICATE_ID`, `LIST_FOREIGN_RESERVATION_ROW`, `LIST_FOREIGN_LISTING_ROW`;
- `LIST_ROW_TYPE_INVALID`, `LIST_ROW_TITLE_INVALID`, `LIST_ROW_CURRENCY_INVALID`, `LIST_ROW_STATUS_INVALID`, `LIST_ROW_PAYMENTPROVIDER_INVALID`, `LIST_ROW_PAYMENTMETHOD_INVALID` (from `k.toUpperCase()` at 274);
- `LIST_ROW_TYPE_UNKNOWN`, `LIST_ROW_AMOUNT_INVALID`, `LIST_ROW_AMOUNT_NOT_EXACT`.

**Persistable for any outcome, only when no provider response exists:** `READ_NOT_COMPLETED`, meaning the cited read is `escalated` (no response after its retries).

**Rules.**
- Any code not seeded cannot be persisted: the composite FK refuses it, so an arbitrary `p_code` can never count.
- If the pure module gains a code, only a reviewed migration may add it.

### 4.2 Outcome-specific read / evidence rules (DB-checked)

| Outcome | Identity read / evidence | List read / evidence |
|---|---|---|
| `eligible`, `conflict_*` | read `hostaway.retrieve_reservation`, **succeeded**; evidence `hostaway_reservation` / `found_active` of exactly that read; all identity fields **equal** to the intent (§4.3) | read `hostaway.list_offline_charges`, **succeeded**; evidence `hostaway_offline_charges` / `listed` of exactly that read, preflight list shape (§4.3) |
| `incomplete` (D7) | as eligible: a positive, matching identity | read cited; `succeeded` with code ≠ `READ_NOT_COMPLETED`, or `escalated` with `READ_NOT_COMPLETED`; **no evidence row may exist for that read** (`evidence_rule = 'none'`) |
| `identity_refused` | read cited; per the code's `evidence_rule` (below) | NULL (no list read is counted) |

**`identity_refused` evidence rules:**
- `none`: `NOT EXISTS (provider_evidence WHERE read_operation_id = read)`.
- `not_found_or_cancelled`: that read's evidence has status `not_found` / `cancelled`.
- `found_active_mismatch`: that read's evidence is `found_active`, and the DB **re-derives** the code. For example `IDENTITY_TOTAL_MISMATCH` ⇒ `observed.totalMinor ≠ intents.final_total_minor`; `IDENTITY_STATUS_NOT_ACTIVE` ⇒ `observed.status ≠ 'new'`; likewise listing, arrival, departure, reference (`bookingRef ≠ intents.ref`), currency, channel, reservation id.
  - A real refused observation is therefore **retained as real evidence without qualifying**: `found_active` with mismatching fields never satisfies `eligible`, whose rules require equality.

**No fabrication.**
- Malformed / unparseable provider responses cannot be persisted as evidence: `provider_evidence` stores ids / amounts / statuses only, so the raw JSON is not retained. They are cited by read id + code only.
- A list evidence row for a page the worker found incomplete is a worker defect [TRUST]. The DB refuses to count such a read as `incomplete` (`ASSESSMENT_EVIDENCE_PRESENT`), and the read is refused as `eligible` unless the preflight list shape is complete (§4.3).

### 4.3 DB-checkable bindings

**Every cited read:**
- `intent_id` = op intent; the right `op_type`; `retry_class = 'read'`;
- `payload = {"reservationId": intents.hostaway_reservation_id}` exactly (a canonical id);
- used by no other assessment (`UNIQUE`, in either column, across phases).

**Every cited evidence row:** `read_operation_id` = the cited read; `intent_id` = op intent; `source = 'hostaway_api'`; `external_ref = hostaway_reservation_id`.

**Identity evidence `observed`** for eligible / conflict / incomplete. Required keys: `reservationId`, `listingId`, `channelId`, `from`, `to`, `totalMinor`, `currency`, `status`, `bookingRef`, `executorAccountRef`, `clientSnapshotId`. It must equal, respectively:
- `external_ref`, `intents.listing_id`, `2000`, the stay dates, `final_total_minor`, `intents.currency`, `'new'`, `intents.ref`, `account_ref`, `client_label`.

**List evidence `observed`** (preflight shape, count-only, so no `marker` key). Required keys and ranges:
- `matchingChargeCount` integer 0…500, `= jsonb_array_length(matchingChargeIds)`; `matchingChargeIds` distinct canonical-id strings;
- `lookalikeCount` and `sameAmountPaidCount` integers 0…500;
- `rowCount` integer 0…500, `≥ matchingChargeCount + lookalikeCount + sameAmountPaidCount`;
- `readCount = 1`, `requestLimit = 500`, `complete = true`;
- `executorAccountRef = account_ref`, `clientSnapshotId = client_label`.

**Outcome consistency:**
- `eligible` ⇒ the three counts are 0;
- `conflict_marker` ⇒ `matchingChargeCount ≥ 1`;
- `conflict_lookalike` ⇒ `matchingChargeCount = 0 AND lookalikeCount ≥ 1`;
- `conflict_same_amount` ⇒ `matchingChargeCount = 0 AND lookalikeCount = 0 AND sameAmountPaidCount ≥ 1`.

This mirrors the pure precedence (324–326).

**Op:** `pending`; key `och:<intent>:1`; `attempts = 0`; `dispatched_at IS NULL`; latest; no active hold (0011 `recording_active_hold_id`).

**Intent and lease:** `payment_captured`; `captured_minor = final_total_minor`; `offline_charge_attempts = 0`; `version = p_expected_version`; `intent_work.work_worker_id = p_worker AND work_lease_until ≥ v_t`, read under `FOR SHARE` (§7.2).

**Block state:** `recording_preflight_block(op)` IS NULL, i.e. not latched (§5.4).

### 4.4 `p_cfg` (exact)

- Exactly the keys `accountRef`, `channelId`, `currency`, `listingId`, `paymentMethod`, `refFieldId` (the pure `CONFIG_KEYS`, 122), with JSON types:
  - `accountRef`: string, label regex, **= `p_account_ref`**;
  - `channelId`: number = 2000;
  - `currency`: string = `intents.currency`;
  - `listingId`: number = `intents.listing_id`;
  - `paymentMethod`: string ∈ {`credit_card`, `other`}, required, **no default**;
  - `refFieldId`: integer 1…2147483647.
- The DB enforces this **internal consistency of the persisted snapshot**. It cannot know the operational config values or the USD policy (D6) [TRUST].

### 4.5 What stays [TRUST]

- **Classification.** That the outcome is the true pure classification of the actual response. The DB re-derives identity mismatches and count consistency, never the raw JSON.
- **Provenance and timing.** That reads were executed against Hostaway with the stated request (limit 500, single page); that labels name the real client / credential / account; that `observed_at` / read `completed_at` / `updated_at` are true times.
- **In-memory results.** Process-local brands and in-memory results are not DB attestation.

---

## 5. Freshness, floors, epochs, latch

### 5.1 Decision clock

Every 0012 / 0013 function and the fence sample `v_t := clock_timestamp()` **after their last potentially blocking lock**, and use only `v_t`.

### 5.2 Freshness (inclusive, no future), per existing row

**At assessment:**
- **for each evidence row that exists:** `v_t − 2 min ≤ observed_at ≤ v_t`;
- **for a cited read without evidence** (refusal rows): `succeeded` reads use `completed_at`, and `escalated` reads use `updated_at`, with the same window. Both are caller-written [TRUST]; the DB refuses only implausible values.

**At claim** (the qualifying eligible row) **and at release** (0013, its `release_review` row): both evidence rows again at that function's `v_t`.

### 5.3 Floors (DB-assigned lower bounds; never used alone)

| Floor | Rule |
|---|---|
| **Initial / current version** | each cited evidence `created_at` (writer transaction start, DB clock) > the `recorded_at` (DB `statement_timestamp()`) of the `intent_transitions` row with `(intent_id, version_after = p_expected_version)`. The evidence write began after the current intent version was recorded; in the first epoch this also places it after the recording was created (the same E3 transition). |
| **After hold** (0013 `release_review`) | evidence `created_at` > `hold.created_at`. |
| **After release** (0013 new epoch) | evidence `created_at` > the release decision's `recorded_at`. |

For evidence-less refusal rows, the only floors are once-only read counting and the caller-time freshness: no DB-stamped instant exists for a read without evidence [TRUST]. All floors are *anti-replay* bounds; none proves when the provider call happened.

### 5.4 Epoch, latest, latch

- **Epoch.** 0012: always 0. 0013: the count of the op's released `PREFLIGHT_*` holds. Every rule uses **only the current epoch**.
- **Latest qualifying row.** The max `seq` among the current epoch's `phase = 'preflight'` rows.
- **Latch.** `recording_preflight_block(op)` is computed from **the existence** of rows, never from the latest row (R1):
  - `CONFLICT_LATCHED` if **any** current-epoch `preflight` row has a `conflict_*` outcome;
  - `EXHAUSTED` if ≥ 3 current-epoch `preflight` rows have `incomplete` / `identity_refused`;
  - otherwise NULL.
- **Effects of the latch:**
  - `record_recording_assessment` **refuses further preflight rows** once latched (`ASSESSMENT_EPOCH_CONFLICTED` / `ASSESSMENT_EPOCH_EXHAUSTED`).
  - The fence **and** `recording_claim_ready` refuse independently of whether any hold-opening helper ran.
  - A newer zero-match list can never erase the history: rows are append-only, and later rows are refused.
- **Clearing.** Only an authorized 0013 release starts a new epoch. Nothing clears automatically.

---

## 6. Claim (0012)

### 6.1 Linearization point

The claim's UPDATE of the op row (`pending → in_flight`), evaluated inside `recording_claim_fence` at its `v_t`, while holding:
- intent `FOR SHARE`;
- `intent_work` `FOR SHARE`;
- the op row lock.

All three are held, together with the claim-audit INSERT, **until COMMIT**.

### 6.2 Snapshots

After each wait, every subsequent plpgsql statement takes a fresh READ COMMITTED snapshot (VOLATILE functions), so committed assessments, holds and leases are seen.

### 6.3 Fence addition (after the unchanged 0011 checks)

1. Take `intent_work` `FOR SHARE` (a no-op re-lock on the helper path); then `v_t`.
2. `recording_preflight_block(NEW.id)` IS NULL.
3. `a` = the latest current-epoch `preflight` row, with:
   - `a.outcome = 'eligible'`;
   - `a.intent_version = intents.version`;
   - `a.cfg ->> 'listingId' = intents.listing_id` and `a.cfg ->> 'currency' = intents.currency`, re-checked;
   - both evidence rows still fresh at `v_t` (§5.2);
   - `a.worker = NEW.lease_worker_id = intent_work.work_worker_id` and `work_lease_until ≥ v_t` (D3).
4. INSERT `recording_claim_assessments (NEW.id, a.id, NEW.lease_worker_id, v_t)`.

**Only this initial recording row is ever claimed, at most once** (`attempts 0` / undispatched / key `:1`, unchanged). A successful claim is a DB state change, **not** a send authorization.

### 6.4 `recording_claim_ready` and the mirror

- It evaluates steps 2–3 without the claimant equality, at its own `clock_timestamp()`, without locks.
- A row the mirror passes but the trigger refuses (ageing, lease or version change in between) raises `RECORDING_CLAIM_FENCED` in the claim transaction. That transaction rolls back, and the helper surfaces it; **no retry**.

---

## 7. Locks and races

### 7.1 Order (one intent)

> intent (SHARE; NO KEY UPDATE for `applyEvent`) → `intent_work` (SHARE; UPDATE for lease writers) → recording op (SHARE / UPDATE) → cited read rows (SHARE) → active hold (0013: SHARE / UPDATE) → advisory evidence key → reserved case (UPDATE) → `clock_timestamp()`

### 7.2 Paths

| Path | Locks, in order (actual strength) | Notes |
|---|---|---|
| claim helper (0012 change) | intent `FOR SHARE` → **`intent_work FOR SHARE`** → op `FOR UPDATE SKIP LOCKED` → (trigger) intent `FOR SHARE`, `intent_work FOR SHARE` (re-lock), reads → `v_t` → claim-audit INSERT | serialized |
| direct app `UPDATE … in_flight` (authoritative trigger) | **op row first** → (trigger) intent `FOR SHARE` → `intent_work FOR SHARE` | the unavoidable op-first inversion: the direct UPDATE waits on the intent while holding the op; if the intent holder then waits on that op row, a **40P01** results. Whether `applyEvent`'s path (intent NO KEY UPDATE, repo.js:358 → … → `intent_work` UPDATE, 271) ever touches the op row is **to be measured** (A-15), not asserted. Bounded; never a bypass; no automatic retry |
| `record_recording_assessment` | intent `FOR SHARE` → `intent_work FOR SHARE` → op `FOR SHARE` → reads `FOR SHARE` → advisory → `v_t` | |
| `claimIntentWork` (lease writer) | `intent_work FOR UPDATE SKIP LOCKED` → UPDATE | vs claim / assessment (holding work SHARE): the writer **skips**; if the writer is first (uncommitted), the claim / assessment waits on work SHARE, then reads the new lease → refuse (`RECORDING_CLAIM_FENCED` / `ASSESSMENT_WORK_LEASE_LOST`) |
| `applyEvent` | intent `FOR NO KEY UPDATE` (repo.js:358) → intent-row trigger work → `intent_work` UPDATE (271) | vs claim helper / assessment: serialized at the intent lock (SHARE conflicts with NO KEY UPDATE); a claim that already holds work SHARE makes `applyEvent` wait at its `intent_work` UPDATE only if it got the intent first, which the shared intent→work order prevents |
| 0013 `record_release_review_assessment` | intent SHARE → work SHARE → op SHARE → **hold `FOR SHARE`** → reads SHARE → advisory → `v_t` | |
| 0013 `admin_release_preflight_hold` | intent SHARE → op `FOR UPDATE` → **hold `FOR UPDATE`** → advisory → case `FOR UPDATE` → `v_t` | vs review: op lock serializes (SHARE vs UPDATE). Release first → the review waits, re-reads the hold → released → `HOLD_NOT_ACTIVE`. Review first → the release waits, then sees the committed review |
| 0013 `open_recording_preflight_hold` | intent SHARE → work SHARE → op `FOR UPDATE` → hold `FOR UPDATE` → advisory → case `FOR UPDATE` → `v_t` | vs claim: op lock |
| evidence writers + inbox trigger (0010 / 0011) | read op UPDATE → evidence INSERT → **inbox INSERT** → advisory | never the recording op |
| inbox processor (0011) | inbox row SKIP LOCKED → intent SHARE → op SHARE → advisory | preflight evidence → `not_latest_linked` |

### 7.3 Races (both orders)

| Race | Outcome |
|---|---|
| Assessment vs claim | assessment first: the claim helper skips (op SHARE vs UPDATE SKIP LOCKED), a direct claim waits, then sees it. Claim first: the assessment waits, then sees `in_flight` → `ASSESSMENT_TARGET_STATE` |
| Conflict A then eligible B (R1) | B is refused (latched); and if B somehow exists (e.g. A and B concurrent), the fence still refuses because A exists |
| Concurrent assessments for one op | serialized by op SHARE + advisory; `UNIQUE` reads refuse reuse; a latch set by the first is seen by the second's fresh snapshot after the wait |
| Lease reassignment / expiry | see `claimIntentWork` above; expiry while waiting → refused at the post-wait `v_t` |
| `release_review` vs release; duplicate release; old-epoch replay | §7.2; the replayed release returns the earlier decision id; old reads are already counted and fail the floors |
| Delayed / crashed hold opener (0013) | the latch already blocks the claim; any worker holding the work lease can later open the matching hold, citing the **earliest** current-epoch conflict (or the third counted failure). Idempotent |
| Inbox before / after link | 0011 unchanged |

**Not claimed:** universal deadlock freedom. Tests must observe actual waits (`pg_locks`).

---

## 8. Migration 0013 (slice B) [PROPOSED-0013] — SUPERSEDED by `claude/e74b-preflight-release-contract.md`

### 8.1 Table and column changes

| Change | Detail |
|---|---|
| `recording_assessments` | **add** `hold_id uuid → recording_holds`; replace `recording_assessments_phase_check` with `phase IN ('preflight','release_review')`; add `recording_assessments_hold_check` (`(phase = 'release_review') = (hold_id IS NOT NULL)`); replace `recording_assessments_epoch_check` with `epoch >= 0` |
| `recording_holds` | replace `recording_holds_reason_check` (+ `PREFLIGHT_EXHAUSTED`, `PREFLIGHT_CONFLICT_MARKER`, `PREFLIGHT_CONFLICT_LOOKALIKE`, `PREFLIGHT_CONFLICT_SAME_AMOUNT`); replace `recording_holds_epoch_check` with `epoch >= 0 AND (reason LIKE 'PREFLIGHT\_%' OR epoch = 0)`; **add** `assessment_id → recording_assessments`, plus `recording_holds_assessment_check` (`(reason LIKE 'PREFLIGHT\_%') = (assessment_id IS NOT NULL)`) |
| `recording_hold_decisions` | replace `recording_hold_decisions_decision_check` (+ `release_for_initial_send`); **add** `assessment_id → recording_assessments`, plus `recording_hold_decisions_assessment_check` (`(decision = 'release_for_initial_send') = (assessment_id IS NOT NULL)`); `recording_hold_decisions_check` / `_check1` unchanged |

All existing 0011 / 0012 rows satisfy the replaced CHECKs: `epoch 0`, non-preflight reasons, no preflight decisions, `phase = 'preflight'` with `hold_id` NULL.

### 8.2 Function replacements (CREATE OR REPLACE; security / volatility / `search_path` unchanged)

| Function | 0013 change |
|---|---|
| `recording_holds_guard` (0011:93–120, INVOKER) | a release cites its own decision: `link_full_proof` for `SUCCEEDED_UNPROVEN`, or `release_for_initial_send` for `PREFLIGHT_*` (the test at 0011:115 widened) |
| `recording_hold_decisions_guard` (0011:123–143, INVOKER) | + `release_for_initial_send` only for `PREFLIGHT_*` holds, citing a `release_review` assessment with `hold_id` = the hold (the test at 0011:134 widened) |
| `reserved_case_guard` (0011:222–247, INVOKER) | + the four `OFFLINE_CHARGE_HOLD_PREFLIGHT_*` kinds (0011:230) |
| `reserved_case_binding_verify` (0011:254–282, SD) | the resolution follows the **last** release: `recorded` after `link_full_proof`, `no_action` after `release_for_initial_send` (0011:274); a released hold cites a decision matching its reason (0011:279). **≥ 1 hold per reserved case, open iff an active hold, intent / kind match: unchanged** |
| `recording_preflight_block`, `recording_claim_ready`, `recording_claim_fence` (0012 bodies) | the epoch becomes `recording_preflight_epoch(op)`; otherwise unchanged |

### 8.3 New functions

| Function | Grant | Behaviour |
|---|---|---|
| `recording_preflight_epoch(p_op) RETURNS integer` | private, VOLATILE | |
| `record_release_review_assessment(p_hold uuid, p_worker text, p_outcome text, p_code text, p_identity_read uuid, p_list_read uuid, p_identity_evidence uuid, p_list_evidence uuid, p_expected_version integer, p_module_version text, p_client_label text, p_account_ref text, p_cfg jsonb) RETURNS uuid` | app | §4 rules, `phase = 'release_review'`, the hold active (`FOR SHARE`) and `PREFLIGHT_*`, the floor after the hold. **Never counts toward exhaustion and never qualifies a claim** (the latch and fence read only `phase = 'preflight'`) |
| `open_recording_preflight_hold(p_op uuid, p_worker text, p_reason text, p_assessment uuid) RETURNS uuid` | app | live work lease of `p_worker` at `v_t`; the op is the latched initial recording; `p_assessment` = the earliest current-epoch conflict of the matching outcome, or the third counted failure (`EXHAUSTED`). Idempotent for the same reason; a different active reason → `HOLD_ALREADY_ACTIVE`. Joins an open same-kind case (0011 rules); never `DO NOTHING`. **No intent-version equality** (visibility after interruption); `intent_version_at_hold` = the current version |
| `admin_release_preflight_hold(p_hold uuid, p_assessment uuid, p_evidence uuid[], p_resolver text, p_justification text, p_at timestamptz) RETURNS uuid` | admin | below |

**`admin_release_preflight_hold` checks:**
- the hold is active and `PREFLIGHT_*`;
- op `pending` / `:1` / `attempts 0` / undispatched / latest;
- intent `payment_captured` with `version = hold.intent_version_at_hold = review.intent_version` (D8: strict; otherwise `HOLD_CONTEXT_CHANGED`, and the hold stays visible);
- the review: `phase = 'release_review'`, `hold_id = p_hold`, `outcome = 'eligible'`, both evidence rows fresh at `v_t`, created after the hold.

**`admin_release_preflight_hold` effects:**
- a decision row (`release_for_initial_send`, `assessment_id`), then the hold is released;
- the case is resolved `no_action` only when no other bound hold stays active;
- a same-review replay on the released hold → the earlier id; otherwise `HOLD_NOT_ACTIVE`.

**What a release does not do:** it never claims, sends or confirms. The next claim needs a **new** preflight with **new** reads in the new epoch (§5.3 floor after release). An unrelated open reserved case on the intent still fences (0011:572–575).

### 8.4 0013 down

1. **Refuse** if any `PREFLIGHT_*` hold, `release_for_initial_send` decision, `release_review` assessment, or non-NULL `assessment_id` / `hold_id` exists.
2. Restore the four 0011 function bodies and the three 0012 bodies **verbatim from their files**.
3. Restore the replaced CHECKs with their exact names and definitions; drop the added columns / constraints and the 0013 functions.

**Round trip:** equal to a fresh cluster at 12.

### 8.5 [OUTSIDE], isolated

`recorded_manually`, manual finalisation, overrides, and `ATTEMPT_GT1` release are **not** in 0012 / 0013, with no placeholders. `keep_visible` (0011) already applies to `PREFLIGHT_*` holds.

---

## 9. Guarantees, precisely

**Proposed DB guarantees:**
- The **initial recording row** of an intent is claimed at most once, only with a current-epoch, current-version, fresh, eligible assessment recorded by the claimant under its live lease.
- No claim while the epoch is conflict- or exhaustion-latched, while any hold is active, or while any open reserved case exists.
- Assessments, decisions and claim-audit rows are append-only.

**Not guaranteed:**
- That the provider send is authorized: a claim is not send authorization.
- That the provider state stays unchanged between the preflight reads and the POST: the read / write race is unavoidable, and the 2-minute window only narrows it.
- **Detecting a later duplicate** requires (a) relevant evidence actually inserted (a confirming read or owner evidence) **and** (b) the 0011 processor actually being invoked. There is no schedule, no latency bound and no provenance guarantee.
- Exactly-once transport: a connection lost around COMMIT leaves an outcome unknown to the caller (see the owner-case contract §5.3 step 5).

---

## 10. Planned local-PG tests (PLANNED; full TAP retained)

**0012 (A):**

| # | Scenario | Expect |
|---|---|---|
| A-1 | direct writes to the three new tables (app / admin / report; owner DELETE / UPDATE / TRUNCATE); seed-table writes | refused |
| A-2 | every §4.1 worker-local code as `p_code`; an unseeded code; a seeded code under the wrong outcome | refused (FK) |
| A-3 | each identity mismatch code with matching / non-matching `found_active` evidence (re-derivation); `none`-rule codes with evidence present; `READ_NOT_COMPLETED` on a succeeded read | accepted / refused exactly per §4.2 |
| A-4 | list shape: counts out of range, ids length ≠ count, duplicate ids, `rowCount` too small, missing labels, `complete ≠ true`, `requestLimit ≠ 500`; outcome-count inconsistency | refused |
| A-5 | `p_cfg`: missing / extra key, wrong types, `paymentMethod` NULL / unapproved, channel ≠ 2000, listing / currency ≠ intent, `accountRef ≠ account_ref`, unknown `module_version` | refused |
| A-6 | read reuse (both columns), foreign intent / reservation / payload, wrong read type, dashboard evidence, evidence of another read | refused |
| A-7 | freshness at `v_t − 2 min` / `v_t` / `v_t + 1 µs`, for evidence rows and for evidence-less refusal reads (`completed_at` / `updated_at`) | accepted / accepted / refused |
| A-8 | floor: evidence written before the current version's transition; after a version bump | refused |
| A-9 | **R1:** conflict A, then fresh eligible B | B refused (`ASSESSMENT_EPOCH_CONFLICTED`); fence and mirror refuse |
| A-10 | **R1:** conflict and eligible concurrently (observed waits) | the second is refused, or the fence refuses; never a claim |
| A-11 | **R1:** a crashed / delayed opener (0012 has none) | blocked; visible via the tables / `recording_claim_ready = false` |
| A-12 | exhaustion: 3 counted rows → further preflight refused, fence refuses; conflicts are not counted; worker-local codes are never persisted | asserted |
| A-13 | fence: latest not eligible; version changed; other worker; lease expired **while waiting** on the work lock; lease reassigned (both orders vs `claimIntentWork`); evidence aged between assessment and claim | refused at the post-wait `v_t` |
| A-14 | happy path: claim + claim-audit row; then completion / link / finalisation (0010 suites unchanged) | as 0010 |
| A-15 | assessment vs claim, both orders; direct UPDATE inversion vs `applyEvent` | observed waits; 40P01 or serialized; never a bypass |
| A-16 | **slice A alone:** 0012 applied without 0013; every A test passes; down 0012 → a fresh cluster at 11; down refuses with any assessment / claim-audit row | asserted |

**0013 (B):**

| # | Scenario | Expect |
|---|---|---|
| B-1 | preflight holds cite the earliest conflict / the third failure; the opener after a crash (another worker); idempotent; different reason; same-kind case join; binding probes (≥ 1 hold, open iff active, resolution follows the last release) | 0011-style |
| B-2 | `release_review` only under the active `PREFLIGHT_*` hold, its floor and freshness; it never counts or qualifies a claim | asserted |
| B-3 | release: happy path; version changed (D8); stale review; review of another hold; wrong reason; app caller; replay; review vs release (both orders, observed) | asserted |
| B-4 | after release: the old review / old preflight cannot qualify; the conflict history is still present but in the old epoch; a new preflight with new reads qualifies; release never claims; an unrelated reserved case still fences | asserted |
| B-5 | down 0013 → a fresh cluster at 12; down refuses with any preflight hold / release / review | asserted |

**Regressions kept:**
- every 0010 / 0011 suite;
- predicate / page parity and the microsecond cursor;
- the owner-history fixtures;
- inbox error / R1 / R2;
- T-C10.

**Fault-injection targets:**
- the latch (conflict existence, not latest), in the fence **and** the mirror;
- exhaustion count and outcome set;
- the code-allowlist FK and per-code evidence rule; identity re-derivation; list count consistency;
- `p_cfg` checks;
- the floors (version transition / hold / release); freshness at claim / release;
- the work-lock read and the worker equality;
- version equality;
- unique read counting;
- the review-bound-to-hold rule; review exclusion from the latch / fence;
- last-hold case resolution;
- the claim-audit insert;
- the JS mirror in both stages.

---

## 11. Slices, dependencies, blockers

1. **0012 (A):** §3 + the JS changes (§3.4). It depends only on 0011.
2. **0013 (B):** §8. It depends on 0012.
3. **Separate, before any worker:** the D5 completion binding (account label + payment method vs the claim assessment's config).

**Blockers before worker integration:**
- D5;
- live-unverified provider shapes (`offline-charge-proof.js:17`);
- the owner `paymentMethod` choice;
- all live gates;
- the unexplained e74a guard failure (release-readiness item).

---

## 12. Errata for historical comments (0001–0011 are not edited)

| Location | Erratum |
|---|---|
| `db/migrations/0011_recording_owner_cases.up.sql:653` ("An error outside the block (or at COMMIT) marks nothing") | A server-rejected statement / rolled-back transaction marks nothing. A transport loss around COMMIT can leave the outcome unknown to the caller. The file is **not** edited. |
| `lib/booking-db/operations.js:254` ("the database marked nothing for it") | Same erratum. It may be corrected in the next permitted helper edit (e.g. the 0012 JS change). |

---

## 13. Resolution map (root HOLD on 44ca7df)

| # | Item | Where |
|---|---|---|
| D1–D9 | decisions recorded and applied | §0; §4.1 (D1, D7); §5.4 (D2); §6.3 / §7.2 (D3); §8.3 (D4, D8); §0 / §11 (D5); §4.4 (D6); §3 / §8 (D9) |
| R1 | conflict / exhaustion **latch** by existence in the current epoch; further preflight refused; fence + mirror independent of the opener; crash / delay, conflict→eligible, concurrent, slice-A traces | §5.4, §6.3–§6.4, §7.3, §8.3; tests A-9–A-12, A-16, B-1 |
| R2 | exact code families; seeded code allowlist (composite FK); per-code evidence rules incl. retained real `found_active` mismatches; `incomplete` without evidence; evidence-less freshness timestamps | §3.1, §4.1–§4.2, §5.2; tests A-2–A-3, A-7 |
| R3 | exact `p_cfg` keys / types / cross-checks; module allowlist; list / identity shapes and ranges; labels; the initial / version floor; claim-time snapshot comparisons | §3.2, §4.3–§4.4, §5.3, §6.3; tests A-4–A-8, A-13 |
| R4 | helper intent → work → op; trigger work lock; direct-UPDATE inversion; linearization point; lease reassignment / expiry both orders; review / release hold locking and re-check | §6.1–§6.2, §7; tests A-13, A-15, B-3 |
| R5 | exact 0012 vs 0013 objects, constraint names, columns, functions, volatility (`recording_claim_ready` VOLATILE), grants, separate down gates, no phantom FKs | §3, §8; tests A-16, B-5 |
| R6 | initial-row-only claim wording; no send authorization; conditional later-duplicate detection; transport-ambiguous COMMIT; errata, not edits | §6.3, §9, §12 |

---

## 14. Implementation map — 0012 (slice A), offline, pending root code review

Branch `feature/e7-offline-charge-assessments`, cut from exact `3967755`. Files: `db/migrations/0012_recording_assessments.{up,down}.sql`; `lib/booking-db/operations.js`; `lib/booking-db/repo.js` (safety codes); `test/db/fixtures.mjs`; `test/db/e74b-d1-assessments.test.mjs` (new); adapted tests listed in §14.6; `scripts/db-smoke.mjs`; these three docs. Migrations 0001–0011 are byte-identical. No 0013 object, worker, adapter, route, UI, config, dependency or live action.

### 14.1 Objects (exact)

| Object | Kind | Security / volatility / grant |
|---|---|---|
| `recording_assessment_codes (outcome, code, evidence_rule)` | table, PK `recording_assessment_codes_pkey`, CHECKs `_outcome_check` (no `eligible`), `_code_check`, `_rule_check` (8 closed rule names) | 51 seed rows; **frozen**: `reject_change` BEFORE INSERT / UPDATE / DELETE (owner included) + TRUNCATE; RLS; SELECT app / admin / report |
| `recording_assessments` | table; every column NOT NULL except `code`, `list_read_op`, `identity_evidence`, `list_evidence`; named constraints `_pkey`, `_seq_key`, `_claim_binding_key`, `_identity_read_key`, `_list_read_key`, `_operation_fk`, `_intent_fk`, `_identity_read_fk`, `_list_read_fk`, `_identity_evidence_fk`, `_list_evidence_fk`, `_code_fk` (composite → seed), `_phase_check` (`= 'preflight'`), `_epoch_check` (`= 0`), `_outcome_check`, `_code_check` (eligible iff NULL), `_shape_check` (per outcome, `ELSE false`), `_distinct_reads_check`, `_version_check`, `_worker_check`, `_module_check`, `_cfg_check`, `_label_check`; index `recording_assessments_op` | guard `recording_assessments_guard` (INVOKER: INSERT only inside a schema-owner function), `reject_change` UPDATE / DELETE / TRUNCATE; RLS; SELECT app / admin / report |
| `recording_claim_assessments (operation_id PK, intent_id, assessment_id UNIQUE, worker, epoch, claimed_at)` | table; composite FK `_binding_fk (assessment_id, operation_id, intent_id, worker)` → `recording_assessments_claim_binding_key`; `_epoch_check` | guard `recording_claim_assessments_guard` (INVOKER: privileged only, AND the assessment is the eligible preflight row of THIS op / intent / worker, the op is an in-flight recording leased to that worker), append-only; RLS; SELECT app / admin / report |
| `recording_preflight_block(uuid)` | latch by **existence** (any conflict → `CONFLICT_LATCHED`; ≥ 3 incomplete / identity_refused → `EXHAUSTED`), epoch 0 | SQL, SD, VOLATILE, owner only |
| `recording_identity_positive`, `recording_identity_refused_evidence_ok`, `recording_list_evidence_ok` | evidence predicates (§14.2) | plpgsql, SD, VOLATILE, owner only |
| `recording_claim_refusal(uuid, text, timestamptz)` | the single claim-time 0012 check (latch, latest eligible, version, cfg listing / currency, live work lease of the assessor, claimant equality when given, both evidence rows fresh at the given instant); **takes no lock, reads no clock** | plpgsql, SD, VOLATILE, owner only |
| `recording_claim_ready(uuid, text)` | advisory mirror: `recording_claim_refusal(op, claimant, clock_timestamp()) IS NULL` | SQL, SD, **VOLATILE** (moving clock, fresh snapshot per call), no lock; EXECUTE app + admin |
| `record_recording_assessment(uuid, text, text, text, uuid, uuid, uuid, uuid, integer, text, text, text, jsonb)` | the only writer (§14.2) | plpgsql, SD, VOLATILE; EXECUTE app only |
| `recording_claim_fence()` | **replaced**: the 0011 body verbatim, then (marked `-- 0012`) `intent_work FOR SHARE` → `v_t := clock_timestamp()` → `recording_claim_refusal(NEW.id, NEW.lease_worker_id, v_t)` | header / SD / search_path unchanged |
| `recording_claim_audit()` + trigger `external_operations_recording_claim_audit` | **AFTER UPDATE** row trigger, same WHEN as the fence: re-checks at its own instant (locks still held) and INSERTs the claim-audit row; it runs only if the row was actually updated, so a skipped / failed / rolled-back UPDATE leaves no audit | SD, owner only |

All functions: fixed `search_path = pg_catalog, booking`, `REVOKE ALL FROM PUBLIC`.

**JS.** `RECORD_FENCE` is now a fragment builder used in **both** claim stages with the claimant (`$6` in the candidate stage, `$1` in the recheck stage): `… AND booking.recording_claim_ready(o.id, <claimant>)`. `claimNextOperation` share-locks `intent_work` between the intent and the op **only** for `hostaway.record_offline_charge` candidates (other op types unchanged). New `recordRecordingAssessment` (no retries; known refusals → `{ ok:false, error }`). The `operations.js` "marked nothing" comment is corrected (erratum §12 resolved for JS; the 0011 SQL comment stays an erratum). **Compatibility:** code at this branch requires schema 12 (the claim helper references `recording_claim_ready`).

### 14.2 Writer checks, in order

1. Inputs without locks: required values; module `offline-charge-proof-v1`; labels; `(outcome, code)` → its seeded rule (`eligible` ⇔ code NULL); exact read / evidence nullability per rule; `p_cfg` as ONE positive conjunction under `coalesce(…, false)` (exact six keys, JSON types, channel 2000, `paymentMethod ∈ {credit_card, other}` with no default, `accountRef = p_account_ref`, `listingId` / `refFieldId` text-checked before any cast, `refFieldId ≤ 2147483647`).
2. Locks: intent SHARE → `intent_work` SHARE → op SHARE → identity read SHARE → list read SHARE → per-intent advisory key → `v_t`.
3. Target (pending / `:1` / attempts 0 / undispatched / latest), intent (payment_captured, exact capture, reservation, attempts 0), version, live work lease of `p_worker`, no active hold, **latch** (`ASSESSMENT_EPOCH_CONFLICTED` / `_EXHAUSTED`), cfg listing / currency = intent (D6: equality only; USD policy stays [TRUST] in the pure module).
4. Reads: intent, op type, `retry_class = 'read'`, payload exactly `{"reservationId": hostaway_reservation_id}`, terminal state per rule (`escalated` only for `READ_NOT_COMPLETED`), never cited before (either column; `UNIQUE` backstops), caller-time floor `read.created_at > recording.created_at` [TRUST].
5. Evidence per rule: positive identity (eligible / conflict / incomplete — D7); preflight list shape + outcome counts (eligible / conflict); **no** list evidence on an incomplete list read; identity_refused: cited evidence must be the real observation of that read and is **re-derived** (`found_active` with that field mismatching, `cancelled` / non-`new` status, `not_found` for `IDENTITY_HTTP_STATUS` only); an uncited evidence row on the read refuses (`ASSESSMENT_EVIDENCE_PRESENT`).
6. Freshness at `v_t` (inclusive 2 min, no future): evidence `observed_at`; for evidence-less reads `completed_at` (succeeded) or `updated_at` (escalated) — caller times [TRUST]; such rows only block / count, never qualify.
7. DB floors for every cited evidence row: `created_at > intent_transitions.recorded_at` of `version_after = current version` (missing row → `ASSESSMENT_FLOOR`) **and** `created_at > recording.created_at` (addendum C; the latter is a caller time).
8. INSERT (`seq` allocated after serialization).

### 14.3 Addendum map (root ruling on `3967755`)

| Item | Where |
|---|---|
| A — seed: eligible separate; 3 conflict pairs; `READ_NOT_COMPLETED` only incomplete / identity_refused with the escalated read; one closed rule name per pair; real `not_found` / `cancelled` / `found_active` mismatch retained + re-derived; no blanket equality on refused evidence; incomplete = positive identity + no list evidence; late evidence on a counted read never qualifies | up.sql seed + `record_recording_assessment` + `recording_identity_refused_evidence_ok`; tests A-2, A-3, A-4, A-6b |
| B — NOT NULL / exact nullability, eligible iff code NULL, shape per outcome, NULL never passes, frozen seed, append-only, SELECT-only RLS, private helpers | table DDL, guards, cfg conjunction; tests A-1, A-2b |
| C — both floors, missing floor refused, caller-time limits, 2-minute window, once-only reads, evidence-less weaker floors | writer steps 4, 6, 7; tests A-6, A-7, A-8 |
| D — work lock on the recording path only, trigger re-lock for direct UPDATE, clock after the last lock, missing lease refused, no retries (40P01 included), observed waits, T-B3 kept | JS + fence; tests A-13, A-13b, A-14b, A-15; T-B3 (0011 file) unchanged and passing |
| E — locks then advisory, fresh post-wait latch, seq after serialization, latch survives rollback / connection loss / injected newer eligible, exact audit binding, no audit for a failed / rolled-back UPDATE | tests A-9, A-10, A-11, A-14 |
| F — no grandfathering; fixtures obtain real assessments; labelled owner history only for inherited history; no skip switch | `F.preflight`, `F.claimRecording`, `F.claimHealthyRecording`; test A-13 (no assessment → unclaimable) |

### 14.4 Deviations from the revision-2 text (for root review)

- `recording_claim_ready` takes the claimant (`(uuid, text)`, NULL = none) because the helper knows it in both stages; the trigger remains authoritative. A wrong-worker row is therefore SKIPPED by the helper instead of raising.
- The claim audit is written by a separate **AFTER** trigger (re-check + insert) rather than inside the BEFORE fence, so a row that is not actually updated can never leave an audit row.
- Two outcome rules are slightly more specific than §4.1: an `IDENTITY_HTTP_STATUS` `not_found` observation must have exactly the keys `reservationId`, `executorAccountRef`, `clientSnapshotId`; a retained `found_active` / `cancelled` observation must have the full identity key set and matching labels.
- The `paymentMethod` values in fixtures are fixture data only; no owner choice is implied.

### 14.5 Residual limits

- Classification of evidence-less refusals, read execution, request limit / single page, labels' real-world meaning and caller-written times remain [TRUST]; the code allowlist is not proof of provider contents.
- `session_replication_role = replica` (superuser only) bypasses guards **and** FK checks; tests use it only for labelled probes / history.
- The direct-UPDATE op-first inversion can deadlock (40P01) against an intent-first transaction that then needs the op row: observed in A-15 (attempt 1 with an eligible assessment) and T-B3 (attempt 2) as `["ok","40P01"]`, both sides rolled back, never a bypass or an audit row; no retry.
- The provider-side read / write race is unchanged; a claim is not send authorization.

### 14.6 Adapted existing tests (why)

- `fixtures.mjs`: `claimRecording` (used by `confirmed`) now records a real eligible assessment first; new labelled `claimHealthyRecording` wrapper (same arguments as `claimNextOperation`) for existing **healthy** attempt-1 claims.
- `e2b1-safety` (2 sites), `e32-capture-recovery` (1), `offline-charge` (6), `e74b-d2-recording-evidence` (8), `e74b-d1-owner-cases` (4): healthy attempt-1 claims switched to the wrapper. Fenced expectations (attempt > 1, holds) are untouched.
- `e74b-d1-owner-cases` T-B1/B2: a real assessment is created first so the 0011 hold / payload refusals are shown to fence on their own; T-C7: its own items now include the 0012 preflight list evidence (drain 2, not 1); T-C9: the 0012 down refusal is asserted first, then the 0012 audit is removed as labelled test setup in its throwaway cluster to measure the 0011 backfill; T-G2: the 0012 gate answers first, and no 0013 object exists.
- `e74b-d2-recording-evidence` downgrade test: 0012 refuses first (its 0010 gate is exercised in D-1..D-3).
- `migrations.test.mjs`: version lists / table count; the 0011 equivalence test measures at 11.
- `intents.test.mjs`, `guests.test.mjs`: table counts 22 → 25. `scripts/db-smoke.mjs`: the three new tables are SELECT-only; count 25; the frozen seed's 51 rows are expected data.

### 14.7 Tests and fault injection (CLAUDE-RUN on disposable local PostgreSQL 16; full TAP retained)

- New `test/db/e74b-d1-assessments.test.mjs` (23 tests): A-1 privileges / frozen seed / audit binding / grants; A-2 codes; A-2b constraint probes (NOT NULL, CHECKs, composite FK, seed CHECKs); A-3 identity rules and re-derivation incl. escalated `READ_NOT_COMPLETED`; A-4 list shape incl. duplicates under `conflict_marker`; A-5 config; A-6 read binding / reuse / caller-time floor; A-6b late real evidence on a counted read; A-7 freshness (each row on its own); A-8 DB floors + missing transition (labelled state fault); A-9 conflict → eligible and an INJECTED newer eligible row; A-10 concurrent writers both orders (observed waits); A-11 rollback / killed connection; A-12 exhaustion; A-13 fence paths and no grandfathering; A-13b lease expiry after waits and reassignment both orders (claimIntentWork's SKIP LOCKED statement skips, a plain writer waits); A-14 claim audit, rollback leaves none, completion unchanged; A-14b recording-only helper work lock; A-14c recheck-stage mirror; A-14d candidate-stage mirror liveness (> 10 fenced rows ahead); A-15 assessment vs claim both orders + inversion; A-16 no 0013 object; D-1..D-3 down 0012 = fresh 11 (bodies / ACLs / security / volatility / search_path / triggers / constraints / indexes / policies / RLS), identical re-up, audit refusal, then the 0011 / 0010 gates.
- Final runs: focused + migrations + offline-charge + D1 owner-cases + D2 = **97/97**; `npm test` **674/674**; `npm run test:db` **353/353** (the e74a listing-lock guard passed in this run; its historical failure stays unexplained). R1 / R2 helper tests (T-H3, T-L1), T-C10 and the predicate / page microsecond tests are in those runs, unchanged and passing.
- Fault injection: 39 mutants (33 SQL, 6 JS), each in an isolated copy against the focused file: **39 killed**. The first pass left M13 / M16 / M28 / J01 / J02 masked by a second check and J06 hanging a test; the tests were strengthened (BEFORE-fence message, per-row staleness, duplicates under a valid positive count, A-14c / A-14d, non-hanging A-14b) and the set re-run. Three JS mutants of the first pass were invalid (an unused `$6`) and were redefined.
- Observed: A-14b waiting lock `transactionid` (row lock) while the recording helper held `RowShareLock` on `intent_work`; A-15 / T-B3 `["ok","40P01"]`.

