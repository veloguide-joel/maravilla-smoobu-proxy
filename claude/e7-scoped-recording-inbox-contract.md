# E7 scoped recording conflict-inbox: visibility + bounded processing — CONTRACT (DOCS ONLY, PROPOSED)

**Branch.** `feature/e7-scoped-recording-inbox-contract`, cut from exact `4e76227c8a274e2337ad8f1c68a85b13de6ef454`. Nothing here is implemented.

**Labels.** Everything in §1 is **PRESENT** at `4e76227c`, with file:line citations. Everything from §2 onward is **PROPOSED**.

**Boundaries of this document.**
- Read-only repository inspection only.
- No SQL, code, test, fixture or migration edit; no suite run.
- No DB, provider, credential or environment access.

**Status and trust.** Offline design; not live readiness. Scope is a selection boundary, **not tenant authentication**. `p_by`, account and client labels stay TRUST. The existing caller-role permissions (`mv_booking_app` / `mv_booking_admin` / `mv_booking_report` grants and RLS) remain the actual access boundary. This contract invents no tenant authority, credential or account check.

**Why.** The accepted rehearsal (`4e76227c`, test 1) showed every successful recording leaves two unprocessed inbox items: preflight list + confirming list. That is **test evidence about item creation**, not a production arrival-rate or latency claim.

---

## 1. Current inventory at `4e76227c` (PRESENT)

### 1.1 Inbox table, enqueue, backfill

| Object | Where | Behaviour |
|---|---|---|
| `booking.recording_conflict_inbox` | `0011:72–88` | One row per offline-charge evidence row, keyed by `evidence_id` (PK); unique identity `seq`. Columns: `intent_id`, `enqueued_at`, `attempts` ≥ 0, `last_error` (1–500 chars), `last_attempt_at`, `processed_at`, `outcome`, `hold_id`. CHECKs: `processed_at`/`outcome` both null or both set; `hold_id` set iff a contradiction outcome; `attempts = 0` ⇔ no `last_error` / `last_attempt_at`. |
| Pending index | `0011:89` | `(attempts, seq) WHERE processed_at IS NULL`. Not scoped by listing or intent. |
| Enqueue trigger `zz1_evidence_enqueue` → `recording_inbox_enqueue()` | `0011:637–647` | `AFTER INSERT ON provider_evidence WHEN kind = 'hostaway_offline_charges'`. Inserts `(evidence_id, intent_id, clock_timestamp())` in the writer's own transaction. Covers API evidence (`record_provider_evidence`, `0010:354–390`) and dashboard evidence (`admin_record_evidence`, `0010:392–405`). |
| Backfill | `0011:840–842` | Atomic with 0011 up: every existing offline-charge evidence row gets an item, ordered `(created_at, id)`. |

### 1.2 Guards, audit immutability, RLS, grants

- **`recording_conflict_inbox_guard`** (`0011:165–208`). Only privileged (schema-owner function) writes are allowed.
  - INSERT must be the fresh entry of one offline-charge evidence row of the same intent.
  - An error attempt changes only `attempts` (+1 exactly), `last_error` and `last_attempt_at`.
  - Success sets `processed_at` + `outcome` (+ `hold_id` iff contradiction, citing a `LINKED_CONTRADICTED` hold that observed this evidence) once. After that the row is frozen.
  - Item identity (`seq`, `evidence_id`, `intent_id`, `enqueued_at`) never changes.
- **No delete / no truncate** (`0011:210–217`) on inbox, holds, decisions and observations.
- **Append-only** decisions and observations (`0011:212–215`).
- **Hold guard** `recording_holds_guard` (`0011:93–121`; replaced by `0013:560`).
- **Reserved-case guards** `reserved_case_guard` / `reserved_case_binding_verify` / deferred binding check (`0011:222–296`; replaced by `0013:626`, `0013:654`).
- **RLS + grants** (`0011:820–832`): RLS enabled on the four tables; `SELECT` only for app / admin / report through `USING (true)` policies; no write privilege for any runtime role.
- **EXECUTE grants** (`0011:834–837`):
  - `process_recording_conflict_inbox_one(text)` → app, admin
  - `recording_contradictions_page(text, uuid, uuid, integer)` → app, admin
  - `open_recording_visibility_hold` → app, admin
  - `admin_resolve_recording_hold` → admin only

### 1.3 The authoritative predicate (one copy, SQL)

- **`recording_evidence_contradicts(p_intent, p_dispatched_at, p_result_ref, p_reference, p_evidence)`** (`0011:299–338`).
  - This is the 0010 row condition bound to one evidence row with an EXPLICIT reference.
  - Scope: same intent, kind `hostaway_offline_charges`, `external_ref` = the reservation, `observed_at > dispatched_at`, not the reference, `matchingChargeCount >= 1`, and marker absent or equal.
  - It contradicts when: two or more matches; first id ≠ result; or (marker present) any PRESENT field differs. The fields are amount, currency, status, type, provider, title, listing, reservation, chargeId, and paymentMethod / executorAccountRef against the reference.
  - Missing input raises `CONFLICT_CHECK_INPUT`.
- **`recording_conflict_refusal`** (`0011:340–353`): a count wrapper over the core. Used synchronously by:
  - completion `complete_recording_with_evidence` (`0011:363–402`);
  - owner link `link_recording_evidence` (`0011:404–434`);
  - finalisation trigger `recording_finalisation_guard` (`0011:436–454`).

  These synchronous checks are **authoritative regardless of inbox progress**.
- **`recording_latest_id`** (`0010:30–37`): highest attempt number, then `created_at`, then `id`.
- **`recording_active_hold_id`** (`0011:355–359`).

### 1.4 The one-item processor (global, unscoped)

**`process_recording_conflict_inbox_one(p_by text) RETURNS jsonb`** (`0011:649–719`), `SECURITY DEFINER`.

1. `p_by` must be 1–200 chars, else `INBOX_BY_INVALID` (22023, thrown, nothing marked).
2. **Selection** (`0011:661`): `SELECT * … WHERE processed_at IS NULL ORDER BY attempts, seq LIMIT 1 FOR UPDATE SKIP LOCKED`. **Global**: no listing, intent, state or protected-id filter. No item → `NULL`.
3. **Subtransaction** (`BEGIN … EXCEPTION`, `0011:663–717`). Locks in this order: intent `FOR SHARE` → latest recording op `FOR SHARE` → advisory `('booking.recording_evidence', intent)` → `v_t := clock_timestamp()`.
4. **Outcome**:
   - `not_latest_linked` when the latest op is not succeeded + linked + with result (judged synchronously by 0010 at completion / link / finalisation);
   - else `consistent` when the core is false;
   - else contradiction: active hold `FOR UPDATE` → open `OFFLINE_CHARGE_HOLD_LINKED_CONTRADICTED` case `FOR UPDATE` → fresh `v_t`.
5. **Contradiction branches**:
   - An active hold with another reason → `HOLD_STATE_UNEXPECTED` (recorded item error).
   - The same hold already observed this evidence → `contradiction_duplicate`.
   - An active `LINKED_CONTRADICTED` hold → observation `contradiction_appended`.
   - No hold → new hold + observation, plus a new case (`contradiction_opened`) or joining the open case (`contradiction_joined_case`).
6. **Success**: marks `processed_at = v_t, outcome, hold_id`. Returns `{evidenceId, outcome, holdId}`.
7. **Error inside the block**: the subtransaction (and its locks) rolls back. Only `attempts + 1`, `last_error = left(SQLSTATE || ': ' || message, 500)` and `last_attempt_at` are written. Returns `{evidenceId, error: SQLSTATE, message: left(message, 300)}`. The item stays queued.
8. An error outside the block, or at COMMIT, marks nothing.
9. **Caller contract** (comment `0011:649–653`): its own top-level autocommit statement. Wrapping several calls in one transaction accumulates locks and can deadlock (40P01; test T-H2).

**The processor never changes intent or operation state, never releases, finalises, links, resends or notifies.** It only writes inbox / hold / observation / case rows.

### 1.5 JS callers (`lib/booking-db/operations.js`)

**`drainRecordingConflictInbox(pool, { by, maxCalls })`** (`:307–351`, bound `RECORDING_INBOX_DRAIN_MAX_CALLS = 100` at `:310`).
- Requires a real `pg.Pool` (`query` + `connect` + `totalCount`), else `TypeError` before any query.
- Makes ≤ `maxCalls` independent autocommit calls of the global processor, with no retry.
- A returned item error is accumulated; the same item erroring twice in one run stops the run (`stoppedOnRepeatedError`).
- A **thrown** call stops immediately and re-throws the **original** error object, with no further query. `err.drainProgress = {calls, processed, errors}` is non-enumerable and covers only replied calls. A COMMIT-lost call is UNKNOWN.

**`listRecordingContradictions(pool, { after, limit })`** (`:196–219`). A thin caller of the read-only `recording_contradictions_page` (`0011:721–744`):
- latest-linked succeeded recordings × contradicting evidence;
- keyset on `(observed_at at full µs, evidence_id, op_id)`;
- `observed_at_exact` as `YYYY-MM-DDTHH:MM:SS.ffffffZ`;
- limit clamped 1–500;
- **global** (no listing / intent scope);
- returns `op_id, intent_id, result_ref, evidence_id, source, observed_at, observed_at_exact`.

No runtime caller outside tests uses either function: grep finds only `operations.js` and the tests `e74b-d1-owner-cases`, `e74b-d2-recording-evidence`, `e74b-recording-worker`. The recording worker never drains (`recording-worker.js:11–12`).

### 1.6 Owner maintenance that already exists (admin role, DB functions + `db/lib/admin.js`)

- `admin_resolve_recording_hold` (`0011:746–818`; JS `admin.js:58`): `keep_visible` / `link_full_proof`. Lock order: intent SHARE → op UPDATE → advisory → hold UPDATE → case UPDATE.
- `admin_release_preflight_hold` (`0013:493`; JS `admin.js:69`).
- `admin_close_case` (`0011:530`, which excludes owner-hold cases; JS `admin.js:50`).
- `admin_resolve_operation` / `_intent` / `admin_record_evidence` (`admin.js:26–38`).
- Visibility hold openers: `open_recording_visibility_hold` (`0011:586–634`) and `open_recording_preflight_hold` (`0013:447`).

### 1.7 What exists vs what is missing

**Exists (read-only inspection):**
- `SELECT` on the inbox / holds / observations / decisions for app, admin and report (RLS true);
- the global read-only `recording_contradictions_page` + `listRecordingContradictions`;
- the global one-item processor and global JS drain.

**Missing:**
- a **scoped** processor (listing allowlist required, intent narrowing, protected exclusion before selection, scope recheck at the lock point);
- a **scoped** read-only backlog / visibility page and summary;
- a gated, bounded scoped JS entrypoint;
- any owner-facing UI.

There is a DB page; there is no owner UI, and none is proposed here.

**Protected ids exist only in JS** (`reservation-worker.js:69`, `compensation-proof.js`, `hostaway-reservations.js`); grep finds no SQL copy in `db/`.

---

## 2. Why scope cannot be layered on the existing function

Selecting an allowed item id in JS (or in another statement) and then calling `process_recording_conflict_inbox_one` does **not** process that item. The global function selects its own item (`0011:661`), which may be out of scope or protected. There is no item-id parameter, so this route cannot be made safe. Scope must therefore live **inside the database selection and the in-lock recheck** of a new function.

The scoped API must never fall back to the global function:
- no `NULL` / empty scope meaning "global";
- no JS path from the scoped helper to `process_recording_conflict_inbox_one` or `drainRecordingConflictInbox`.

---

## 3. Proposed DB objects (migration `0015_scoped_recording_inbox`, PROPOSED, not implemented)

A migration is genuinely needed: new SECURITY DEFINER functions + grants. **No new table, column or index**. The existing audit columns (`attempts`, `last_error`, `last_attempt_at`, `processed_at`, `outcome`, `hold_id`; holds `created_by = p_by`) represent every invariant below.

### 3.1 `booking.recording_protected_reservation_ids() RETURNS text[]` (private)

`LANGUAGE sql IMMUTABLE`, returns `ARRAY['70636076','71045356','71072615','71081885']`, `REVOKE ALL FROM PUBLIC`, no grant. A test pins parity with the JS constant `PROTECTED_HOSTAWAY_RESERVATION_IDS` (decision D2).

### 3.2 Shared private core `booking.recording_inbox_process_locked(q booking.recording_conflict_inbox, p_by text, p_scope integer[], p_scope_intent uuid) RETURNS jsonb`

- `SECURITY DEFINER`, `REVOKE ALL FROM PUBLIC`, **no grant**.
- The body is the current `0011:663–717` block **verbatim**: subtransaction, locks, outcome, hold / case / observation, success mark, error accounting.
- It adds ONE step after the intent `FOR SHARE` lock and before anything else: the **authoritative scope recheck**, applied when `p_scope IS NOT NULL`. The recheck requires all of:
  - `i.listing_id = ANY(p_scope)`;
  - `p_scope_intent IS NULL OR i.id = p_scope_intent`;
  - `i.hostaway_reservation_id IS NULL OR NOT (i.hostaway_reservation_id = ANY(recording_protected_reservation_ids()))`.

  If the recheck fails, it returns `{evidenceId, skipped: 'STALE_OUT_OF_SCOPE'}` with **zero writes** (no attempts++, no mark). The subtransaction's only lock was the intent SHARE, released at statement end.
- `p_scope IS NULL` is reachable only from the legacy wrapper (§3.3); the scoped wrapper rejects `NULL` before calling.

Listing ids are immutable after creation and the reservation id is never replaced (`capture-worker.js:390–392` cites the 0001 intents guard). So the recheck can fail only through a guard bypass. It is defence in depth, with a deterministic, zero-mutation result.

### 3.3 Legacy `process_recording_conflict_inbox_one(text)`: same signature, grant and selection (`CREATE OR REPLACE`)

- The body becomes `0011:659–662` (validation + the same global SKIP LOCKED selection), then `RETURN recording_inbox_process_locked(q, p_by, NULL, NULL)`.
- The return shape, including `message`, and the global behaviour are unchanged for existing authorized callers (app, admin).
- A parity test proves identical outcomes and rows against the 0011 body on the T-C / T-H fixtures.

The **alternative (decision D1)** leaves the legacy body byte-identical and duplicates the block into the scoped function. That gives zero risk to the legacy function, but two copies of the hold / case binding logic. The predicate itself stays single either way.

### 3.4 Scoped one-item: `booking.process_recording_conflict_inbox_scoped_one(p_by text, p_listing_ids integer[], p_intent uuid DEFAULT NULL) RETURNS jsonb`

A **distinct name**, not an overload, so a missing argument can never resolve to the global function. `SECURITY DEFINER`, `VOLATILE`, `search_path = pg_catalog, booking`.

**1. Validation.** Thrown 22023 (`INBOX_SCOPE_INVALID` / `INBOX_BY_INVALID`) before any lock or write when any of these fails:
- `p_by` is 1–200 chars;
- `p_listing_ids` is non-null and one-dimensional with 1–50 elements, no nulls, all > 0, no duplicates;
- `p_intent` is null or any uuid.

**2. Selection** (scope + protected exclusion **before** `LIMIT` and before any lock):
```sql
SELECT q.* INTO q
  FROM booking.recording_conflict_inbox q JOIN booking.intents i ON i.id = q.intent_id
 WHERE q.processed_at IS NULL
   AND i.listing_id = ANY(p_listing_ids)
   AND (p_intent IS NULL OR q.intent_id = p_intent)
   AND (i.hostaway_reservation_id IS NULL OR NOT (i.hostaway_reservation_id = ANY(booking.recording_protected_reservation_ids())))
 ORDER BY q.attempts, q.seq
 LIMIT 1
 FOR UPDATE OF q SKIP LOCKED;
```
- Intents are read **unlocked** here (`FOR UPDATE OF q` locks only the inbox row).
- **No intent-state filter**: items of `payment_captured`, `confirmed`, `reconciliation_required` and every other state are processed. A later contradiction after confirmation is **visibility-only** (hold + case); state is never changed.
- No item → `NULL`.

**3. Processing.** `RETURN recording_inbox_process_locked(q, p_by, p_listing_ids, p_intent)`.

**4. Result shape** (jsonb; never `message`, never `last_error` text):

| Case | Result |
|---|---|
| Processed | `{evidenceId, outcome ∈ {not_latest_linked, consistent, contradiction_opened, contradiction_joined_case, contradiction_appended, contradiction_duplicate}, holdId|null, intentId, scope:'listing'|'intent'}` |
| Recorded item error | `{evidenceId, intentId, error: <SQLSTATE>, code: <leading token of the RAISE text when it matches ^[A-Z][A-Z0-9_]{2,63}$, else null>, attempts: <new value>}` |
| Recheck failed | `{evidenceId, intentId, skipped: 'STALE_OUT_OF_SCOPE'}` |
| Nothing due in scope | `NULL` |

The recorded `last_error` keeps the existing 0011 format (guard-enforced); only the returned shape is narrowed.

**Grants.** `EXECUTE` to `mv_booking_app, mv_booking_admin` (same as the legacy function, `0011:835`). Not `mv_booking_report`.

### 3.5 Read-only scoped page: `booking.recording_inbox_page(p_listing_ids integer[], p_intent uuid, p_status text, p_after_seq bigint, p_limit integer)`

`RETURNS TABLE`. `SECURITY DEFINER`, `VOLATILE` like `recording_contradictions_page` (it calls the VOLATILE `recording_latest_id`); performs no write.

**Validation.** As in §3.4; `p_status ∈ {'pending','processed','all'}` (required, no default); `p_after_seq` null or > 0; limit clamped 1–200 (default 50).

**Keyset: `seq` only.** `seq` is a unique bigint identity, so the tie-break is inherent and no timestamp cursor is needed: `WHERE (p_after_seq IS NULL OR q.seq > p_after_seq) ORDER BY q.seq LIMIT n`. Scope, status and protected exclusion apply **before** `LIMIT`. Timestamps are exposed only as full-µs `…_exact` strings for display.

**Columns.**

| Group | Columns |
|---|---|
| Item | `seq`, `evidence_id`, `intent_id`, `listing_id`, `intent_state` |
| Timing | `enqueued_at_exact`; `db_now_exact` (one `statement_timestamp()` per page, so age = now − enqueued is computed by the caller from the same instant for every row) |
| Attempts | `attempts`, `last_attempt_at_exact`, `last_error_code` (`left(last_error, 5)`: the SQLSTATE only; **no message text**) |
| Result | `processed_at_exact`, `outcome` |
| Hold / case | `hold_id`, `hold_reason`, `hold_active` (`released_at IS NULL`), `case_id`, `case_status` (via `hold.case_id`) |
| Latest recording | `latest_op_id`, `latest_op_state`, `latest_op_linked` (`settled_evidence_id IS NOT NULL`) |
| Proof provenance | `evidence_source` (`hostaway_api` / `hostaway_dashboard`), `evidence_observed_at_exact`, `evidence_read_operation_id` |

Never exposed: `observed` JSON, raw provider body, the `last_error` message, `p_by` / `created_by`, labels.

**Concurrency caveat.** Identity values may commit out of order, so an item with a lower `seq` can become visible after a page already passed it. A full re-scan from `p_after_seq = NULL` sees it. Counts are a snapshot per statement.

**Grants.** `EXECUTE` to `mv_booking_app, mv_booking_admin, mv_booking_report` (decision D4).

### 3.6 Read-only scoped summary: `booking.recording_inbox_summary(p_listing_ids integer[], p_intent uuid) RETURNS jsonb`

Same validation and scope (protected excluded). Returns:
- `pending`, `pendingWithErrors` (attempts > 0), `maxAttempts`;
- `oldestPendingEnqueuedAtExact`, `dbNowExact`;
- `processedByOutcome: {outcome: n}`;
- `activeLinkedContradictedHolds`, `openHoldCases`.

Same grants as §3.5.

### 3.7 Unchanged

The enqueue trigger, backfill, guards, RLS, the predicate core and wrapper, completion / link / finalisation, the contradictions page and the admin functions are all unchanged. So are the legacy JS drain and `listRecordingContradictions`.

**Residual (decision D5):** the global legacy processor stays callable by app / admin and is not protected-aware, exactly as today.

### 3.8 Up / down map

**Up** creates, in order:
1. §3.1;
2. §3.2 core;
3. §3.3 `CREATE OR REPLACE` (signature, owner, `SECURITY DEFINER`, `search_path` and the `0011:835` grant all kept);
4. §3.4, §3.5, §3.6 with `REVOKE ALL FROM PUBLIC` + the grants above.

**Down:**
- drops §3.6, §3.5, §3.4, §3.2, §3.1;
- restores `process_recording_conflict_inbox_one` **verbatim from 0011:654–718**;
- grants are unchanged by `CREATE OR REPLACE`.

**Down gate: none needed.** Down removes functions only. Every row written through the scoped API is ordinary 0011 audit (inbox mark / hold / observation / case), valid and interpreted identically under 0011–0014, and **never deleted**.

Tests to prove this:
- `up → down` yields `pg_get_functiondef` equal to the 0014 state for every touched function, and the same ACLs;
- audit row counts and contents are unchanged across `down → up`;
- the 0011 down gate still refuses while audit exists.

---

## 4. Transaction, lock and snapshot sequence (one item = one top-level autocommit statement)

**Lock order:**
1. `[selection]` the inbox row `FOR UPDATE SKIP LOCKED` (intents read unlocked);
2. `[subtransaction]` intent `FOR SHARE`;
3. scope recheck;
4. latest recording op `FOR SHARE`;
5. advisory `('booking.recording_evidence', intent)`;
6. `v_t`;
7. (contradiction only) active hold `FOR UPDATE` → open hold case `FOR UPDATE` → `v_t`;
8. writes;
9. inbox mark.

This is exactly the 0011 order with only the recheck inserted. It is compatible with:
- completion: intent SHARE → work SHARE → op UPDATE → advisory (`0011:370–373`);
- link: intent SHARE → op UPDATE → advisory (`0011:410–412`);
- finalisation: intent UPDATE (E3) → advisory (`0011:436–446`);
- owner resolve: intent SHARE → op UPDATE → advisory → hold → case (`0011:766–770`);
- evidence writer: read op UPDATE → evidence INSERT (enqueues a NEW inbox row) → advisory (`0010:354–390`).

No other party waits on inbox rows, and every party takes intent before advisory, so the order introduces no cycle. **No global serialization**: no table lock, no global advisory key, no cross-intent lock. Each item locks only its own intent's rows plus that intent's advisory key. **No provider or network call** exists in any of these functions.

**Concurrency cases:**
- **Two scoped processors, overlapping scopes.** SKIP LOCKED: each takes a different unlocked item, or one returns `NULL`. They contend only if their items share an intent (intent SHARE is compatible; the advisory lock serialises them).
- **Disjoint scopes.** Disjoint listings mean disjoint intents and no row contention. An advisory hash collision can only cause waiting.
- **Same item.** At most one locks it. A loser whose snapshot saw it pending re-evaluates the row after the winner commits (READ COMMITTED EvalPlanQual), sees `processed_at` set, and skips.
- **Scoped vs legacy global processor.** Same SKIP LOCKED semantics on the same rows.
- **Competing completion / link / finalisation / owner paths.** These are serialised by the intent's advisory lock in either order. The 0011 guarantees still hold:
  - a contradiction committed before a link makes the link refuse (T-C5);
  - after a link, the processor opens the hold;
  - an active hold blocks completion / link / finalisation (T-B4).
- **Intent changes state during a wait.** The outcome is computed after the locks from current rows. State is not an input of the predicate; the latest-op checks are re-read under lock (`0011:669`).
- **A direct `UPDATE` racing a transition** (the 0009-style deadlock victim): a 40P01 raised inside the item's subtransaction becomes a recorded item error (attempts + 1); one raised outside it is an outer failure.

**Re-readable afterwards:** inbox row, holds, observations, cases, page, summary.

**Not promised:** exactly-once processing, any bounded wall latency, or that a bounded number of calls drains a backlog. Once-only *semantic* effects come from the guard-frozen item, `UNIQUE (hold_id, evidence_id)` observations and one active hold per op.

---

## 5. Semantics that must stay identical (preserved, not new)

- **Same predicate.** The authoritative linked-reference check is `recording_evidence_contradicts` with the linked proof as reference.
- **Same bindings.** Idempotent hold / case binding (duplicate → `contradiction_duplicate`); a case is joined, not duplicated.
- **No automatic action.** No reversal, finalisation, release, link, resend, notification, intent transition or operation change.
- **Late historical evidence.** Items are selected by `seq`, not `observed_at`, so evidence inserted later with an old `observed_at` is judged (T-C4). Evidence observed at or before dispatch can never contradict (`observed_at > p_dispatched_at`).
- **Pre-link vs post-link.**
  - Before link the outcome is `not_latest_linked`, and the synchronous 0010 checks at link / completion / finalisation decide.
  - After link, the item is judged against the linked proof.
  - A `not_latest_linked` or `consistent` mark is final **for that item only**. **A clean item never means later evidence is clear.** Every later evidence row is its own item, and completion / finalisation re-check synchronously regardless of inbox progress.
- **Unmatched or non-contradicting evidence** → `consistent`.
- **Already held or resolved.** An active `LINKED_CONTRADICTED` hold receives an appended observation. A released hold, or a closed / resolved case, is not reopened by the core: a new hold + a new or joined open case is created per the existing branches. Any other active hold reason → recorded `HOLD_STATE_UNEXPECTED` error (existing).
- **Repeated calls on a processed item are impossible** (frozen by the guard). Repeated calls on an erroring item only increase `attempts`.

---

## 6. Errors: recorded item errors vs outer failures (exact)

### 6.1 Recorded item error (returned data)

- The DB wrote `attempts + 1`, `last_error` and `last_attempt_at`; the item stays queued.
- The JS step reports it under `errors` and **never** as processed or success.
- The same item twice in one step → stop (`stoppedOnRepeatedError: true`; the existing drain rule).

### 6.2 Starvation policy

- The order is `attempts, seq`, so a fresh item (attempts 0) always precedes an erroring one in the same scope. Poison items rotate behind fresh work and among themselves by attempts.
- Out-of-scope and protected items are excluded before `LIMIT`, so they can never occupy a scoped processor.
- **No attempt ceiling** in this slice (decision D3): no new column, and the page shows `attempts` / `last_error_code` for owner attention.

### 6.3 Stale scope result

`skipped: 'STALE_OUT_OF_SCOPE'` means zero writes. The JS step counts it under `skipped` and stops (the in-lock recheck disagreed with selection, which only a guard bypass can cause).

### 6.4 Thrown outer failure (connection, transport, query, validation, serialization outside the block, COMMIT)

- The JS step stops **immediately**.
- It re-throws the **original** error object (same identity, `code`, `message`) with **no follow-up query and no retry**.
- Partial progress is attached non-enumerably as `err.scopedInboxProgress = {calls, processed, errors, skipped}`, covering **only calls whose replies arrived**.
- A connection lost around COMMIT leaves that call **UNKNOWN**: it may have committed. The contract never claims rolled-back or exactly-once. The only safe follow-up is the **read-only** scoped page / summary.
- A later, independently invoked step works purely from persisted facts:
  - a committed item is frozen and is never re-selected;
  - an uncommitted one is still pending and is selected normally.

  Its effects are identical either way, with no duplicate hold or observation, because the guards and unique keys apply.

### 6.5 Caller requirements

- **Processing** requires a real `pg.Pool`: each call is its own autocommit statement on a pooled connection. Never a client inside an open transaction (T-H2 deadlock risk).
- **Page / summary** accept a pool or a client (read-only).

---

## 7. Proposed JS (new offline-only module `lib/booking-db/recording-inbox.js`, injected / manual)

### 7.1 Gate (pure, before any query)

- an `env` OBJECT (never read implicitly);
- `VERCEL_ENV ∈ {development, preview}` (production refused);
- `MV_E7_RECORDING_INBOX === 'enabled'`;
- `by` matches `^[A-Za-z0-9._:-]{1,80}$`;
- `listingIds` is an Array of 1–50 distinct safe positive integers;
- `intentId` is null or a canonical lowercase uuid;
- `maxItems` is a safe integer clamped 1–25, default 10.

Any failure → `{status:'refused', code}` with **zero queries**.

### 7.2 DB marker

An explicit `SELECT environment FROM booking.instance`:
- marker read and ≠ `'test'` (or absent) → `refused DATABASE_NOT_TEST`;
- a thrown error propagates unchanged with no follow-up (the R-C1 pattern).

### 7.3 Functions

**`processScopedRecordingInbox(pool, { env, by, listingIds, intentId = null, maxItems = 10 })`**
- After the marker: ≤ `maxItems` calls of `process_recording_conflict_inbox_scoped_one`.
- Returns `{status:'worked'|'idle', calls, processed:[…], errors:[…], skipped:[…], drained, stoppedOnRepeatedError}`.
- Outer failure as in §6.4.

**`listScopedRecordingInbox(pool, { env, listingIds, intentId, status, after = null, limit = 50 })`**
- Returns `{rows, next: {afterSeq} | null}`.
- `next` is set only when `rows.length === limit`.

**`scopedRecordingInboxSummary(pool, { env, listingIds, intentId })`** → jsonb as in §3.6.

### 7.4 Explicitly none

No schedule, cron, periodic task, route, UI, deployment, live dispatch, notification or provider call. Invocation is manual / injected (tests, or a future separately approved runner). Bounded call counts promise **nothing** about wall-clock latency or backlog drain.

---

## 8. Planned deterministic tests (future slice; disposable PG; `test/db/e7-scoped-recording-inbox.test.mjs`)

1. **Late contradiction after `confirmed`.** Built by the accepted chain (rehearsal helpers re-declared test-locally), then contradicting API and dashboard evidence. Expect exactly one `LINKED_CONTRADICTED` hold + one open case + one observation per item, and intent state / version unchanged. A repeat call returns `NULL`, with no duplicate rows.
2. **No-conflict drain** of the two happy-path items → both `consistent`, nothing else written.
3. **Scope isolation.**
   - Unrelated-listing items and protected-reservation items (protected rows built by TEST SETUP) stay untouched: byte-identical snapshots, attempts 0.
   - 100+ out-of-scope pending items cannot starve allowed items.
   - Optional `intentId` narrows to that intent only.
4. **Bad scope.** Absent / empty / null element / duplicate / non-integer / > 50 listing ids, a malformed intent id, and a bad `by`:
   - JS refusal with zero queries;
   - direct SQL raises 22023 with zero writes;
   - no scoped call can ever reach the global function (grep + a trap pool).
5. **Concurrency.**
   - Overlapping / disjoint scoped processors under deterministic barriers.
   - The same item processed once (SKIP LOCKED + post-commit re-evaluation).
   - Scoped vs legacy on the same item.
   - Wait / recheck races with completion, link, finalisation and owner resolve in both orders (T-C5 / T-B4 parity).
   - The STALE recheck exercised only through a labelled owner-session guard bypass.
6. **Historical evidence** inserted later with an old `observed_at` → judged; evidence at or before dispatch → `consistent`.
7. **Poison items.** Recorded attempts / `last_error`, the item stays queued, fresh items are served first, a repeated error stops the step, and the returned shape carries no message.
8. **Outer failures** via a fault-injecting pool, before and after a committed outcome:
   - exact query counts;
   - the original error identity / code / message;
   - `scopedInboxProgress` covers only replied calls;
   - read-only inspection afterwards;
   - a later step processes remaining facts without duplicates.
9. **Read-only page / summary.**
   - Scope before `LIMIT`; exact `seq` keyset at page sizes 1 / 2 / 3.
   - Full-µs `_exact` fields; no message or `observed` leakage.
   - Parity of processed outcomes with inbox rows.
   - The concurrent lower-`seq` arrival caveat demonstrated.
10. **Grants and roles.** EXECUTE for app / admin (processor) and app / admin / report (page / summary); the core and protected function are not executable by any runtime role; legacy grants unchanged; no write privilege added.
11. **Migrations.** Up / down `pg_get_functiondef` + ACL equality with 0014; audit preserved across down / up; the 0011 down gate unchanged.
12. **Parity.** The legacy wrapper (§3.3) equals the 0011 body on the existing T-C / T-H fixtures, and protected-id parity holds between SQL and JS.
13. **Regression.** The rehearsal file, `e74b-d1-owner-cases`, `e74b-d2-recording-evidence`, `e74b-recording-worker`, the migrations test, `npm test` and `test:db`. No broad mutation campaign; targeted mutants only for scope-before-LIMIT, protected exclusion and recheck.

## 9. Smallest executable implementation slice (when authorized)

**Allowed files:**
- `db/migrations/0015_scoped_recording_inbox.up.sql` / `.down.sql` (§3);
- `lib/booking-db/recording-inbox.js` (new; §7);
- `test/db/e7-scoped-recording-inbox.test.mjs` (new; §8);
- `test/packaging-closure.test.mjs`: the `BOOKING_DB_FILES` pin and the new module in `OFFLINE_ONLY`;
- `test/db/migrations.test.mjs`: only its pinned function / ACL counts for 0015;
- this contract's implementation map.

No change to:
- 0001–0014;
- the recording / capture / reservation / compensation workers;
- `operations.js` (the legacy drain and contradictions caller stay as they are);
- fixtures, config, dependencies, routes or UI.

**Slice content:** §3.1–§3.6 + §7.1–§7.3, with the legacy wrapper per D1.

## 10. Decisions (only real ones; recommendation first)

- **D1 — shared private core** (§3.2/§3.3, legacy body `CREATE OR REPLACE`d to wrapper + core, parity-tested) **vs** a duplicate block (legacy byte-identical). *Recommend the shared core*: one copy of the hold / case binding logic.
- **D2 — protected ids in SQL** as a private immutable function, parity-tested with JS, **vs** a caller-passed list. *Recommend SQL*: a caller cannot omit it.
- **D3 — no attempt ceiling** for poison items (visibility through the page) **vs** a selection ceiling parameter. *Recommend no ceiling* this slice; revisit with real owner workflow.
- **D4 — read-only page / summary grants** to app + admin + report **vs** app + admin only (as `recording_contradictions_page`). *Recommend including report*: it already has `SELECT` on the inbox tables under RLS (`0011:828–831`).
- **D5 — legacy global processor** left unchanged (callable by app / admin, not protected-aware) **vs** revoking it from `mv_booking_app` in 0015. *Recommend leaving it unchanged* this slice (no runtime caller), and recording it as a residual for root.
