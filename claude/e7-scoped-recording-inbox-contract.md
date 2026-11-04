# E7 scoped recording conflict-inbox: visibility + bounded processing — CONTRACT revision 2 (DOCS ONLY, PROPOSED)

**Branch.** `feature/e7-scoped-recording-inbox-contract`. Revision 1 = `6efe48956e894853a26f2f70acb2e8108b7be99c` (cut from exact `4e76227c8a274e2337ad8f1c68a85b13de6ef454`). Revision 2 answers root's HOLD on `6efe4895` (R1–R3, D1–D5); where they differ, revision 2 governs.

**Labels.** Everything in §1 is **PRESENT** at `4e76227c` and cited `file:line`. Everything from §3 on is **PROPOSED**; nothing is implemented. Migrations 0001–0014 stay byte-identical.

**Status (2026-11-03).** Root ACCEPTED revision 2 OFFLINE as the design at `99a78fcf`. **Implemented offline** on `feature/e7-scoped-recording-inbox` (migration 0015 + `lib/booking-db/recording-inbox.js`), pending root CODE review; implementation map **§11**. Not live readiness.

**Boundaries of this document.** Read-only repository inspection only. No SQL / code / test / fixture / migration edit, no suite run, no DB / provider / credential / environment access.

**Trust.** Scope is a **selection boundary, not tenant authentication**. `p_by`, account and client labels stay TRUST. The existing role grants and RLS (`mv_booking_app` / `_admin` / `_report`) remain the actual access boundary. No tenant authority, credential or account check is invented.

**Evidence base.** The accepted rehearsal (`4e76227c`, test 1) left two unprocessed inbox items per successful recording. That is test evidence about item creation only, not a production arrival-rate or latency claim.

## 0. Resolution map (root HOLD on `6efe4895`)

| Item | Resolution | Where |
|---|---|---|
| R1 — protected scope must follow the EVIDENCE reference as well as the intent | One shared predicate excludes an item when EITHER the intent's CURRENT `hostaway_reservation_id` OR the immutable evidence row's `external_ref` is protected (NULL rules explicit; no JSON parsing). Applied in processor selection, the in-lock recheck, the page and the summary; never added to the legacy wrapper. Basic counterexamples tested through ordinary API / dashboard evidence paths with no trigger bypass. | §1.1, §3.2, §3.4, §3.6–§3.7, §8 T-R1* |
| R1 — the NULL→id reservation binding is legal | Revision 1's "recheck fails only through guard bypass" was WRONG. `0001:181` forbids only replacement of a non-NULL id, so NULL→id (including NULL→protected via an accepted `applyEvent` path) can happen between selection and lock. The recheck uses current facts under the intent lock; STALE means zero mutation. The race is stageable with an observed lock wait, no bypass. | §1.6, §4.2, §8 T-R1d |
| R2 — exact internal core result + per-wrapper projections | Internal core result defined. Legacy wrapper projects the exact legacy keys (incl. `message`); the scoped wrapper projects only safe keys (SQLSTATE only, `attempts` from the committed accounting row). Every deliberate change to the formerly verbatim block is listed. | §3.3–§3.5 |
| R2 — validation split, int4 ids, per-function security | Common read-scope validation is separated from processor-only `by` / `maxItems` and page-only `status` / `after` / `limit`. Validation order, defaults, clamping and one marker check per call are fixed. Listing ids are int4 `1..2147483647`. LANGUAGE / volatility / SECURITY / `search_path` / REVOKE / GRANT are declared for every function. The SQL selects a scalar key (no row-variable / alias ambiguity). | §3.1–§3.7, §7 |
| R3 — error truth | The 0011:653 comment "marks nothing at COMMIT" is quoted as a historical COMMENT erratum. An acknowledged server rejection ≠ a transport loss around COMMIT (UNKNOWN, may have committed). The §6 wording governs throughout. 0011 itself is not edited. | §1.4, §6 |
| R3 — precision | `seq` is a canonical decimal string at the JS boundary (no Number / parseInt); `next` is based on the effective clamped limit; values above 2^53 are tested. Summary counts items vs DISTINCT holds / cases. `hold_active` is NULL when there is no hold. Empty result vs invalid input is defined. | §3.6–§3.7, §7, §8 |
| D1–D5 | Root's choices adopted as stated. | §10 |

## 1. Current inventory at `4e76227c` (PRESENT)

### 1.1 Evidence → inbox item binding (what an item does and does not bind)

**API evidence** `record_provider_evidence` (`0010:354–390`):
- requires a SUCCEEDED read of the matching type;
- `external_ref` must equal the read's selector (`coalesce(payload.sessionId, paymentIntentId, reservationId)`, `0010:372–378`);
- `intent_id := op.intent_id`; `observed_at := op.completed_at`;
- takes the advisory lock after the insert (`0010:385–388`).

The read selector is NOT bound to the intent's reservation. `requestRead` (`lib/booking-db/operations.js:472–485`) inserts a read row with `{ reservationId: ref }` for ANY non-empty string `ref`, so an API `hostaway_offline_charges` evidence row can carry ANY `external_ref` on ANY intent.

**Dashboard evidence** `admin_record_evidence` (`0010:392–405`; admin role, `db/lib/admin.js:26`): inserts for any `p_intent` / `p_external_ref` with attestation, with no reservation equality.

**Evidence rows are immutable**: append-only / no-truncate triggers (`0003:73–76`). `external_ref` is `NOT NULL`, 1–200 chars (`0003:57`).

**Inbox enqueue** (`0011:637–647`) and the inbox guard INSERT rule (`0011:176–182`) bind an item to the evidence's own `id`, `intent_id` and kind only.

**Consequence (root's counterexample):** an allowed-listing intent with a NULL or a different reservation id can have a pending inbox item whose evidence `external_ref` is a protected id. The legacy global processor selects, locks and marks such an item.

The contradiction predicate requires `e.external_ref = i.hostaway_reservation_id` (`0011:316`). So such an item can only resolve as `not_latest_linked` or `consistent`, but it is still locked and marked.

### 1.2 Inbox table, index, backfill

| Object | Where | Behaviour |
|---|---|---|
| `booking.recording_conflict_inbox` | `0011:72–88` | PK `evidence_id`; unique identity `seq bigint`; `intent_id`, `enqueued_at`, `attempts` ≥ 0, `last_error` (1–500), `last_attempt_at`, `processed_at`, `outcome` (6 values), `hold_id`. CHECKs: `processed_at`/`outcome` both null or both set; `hold_id` set iff a contradiction outcome; `attempts = 0` ⇔ no error fields. |
| Pending index | `0011:89` | `(attempts, seq) WHERE processed_at IS NULL`. No listing / intent column. |
| Backfill | `0011:840–842` | Atomic in 0011 up. |

### 1.3 Guards, RLS, grants

- **Inbox guard** (`0011:165–208`): only privileged (inside a schema-owner function, `booking.is_privileged()` `0003:15`) writes. An error attempt is exactly `attempts + 1` + `last_error` + `last_attempt_at`. Success is set once, then frozen; identity is frozen. A contradiction outcome must cite a `LINKED_CONTRADICTED` hold that observed this evidence.
- **No delete / truncate** on the four tables (`0011:210–217`).
- **Hold / decision / observation guards** (`0011:93–163`; holds and decisions replaced by `0013:560`, `0013:595`).
- **Reserved-case guards** (`0011:222–296`; replaced by `0013:626`, `0013:654`).
- **RLS + SELECT** for app / admin / report with `USING (true)` (`0011:820–832`).
- **EXECUTE grants** (`0011:834–837`): processor and contradictions page → app, admin; `open_recording_visibility_hold` → app, admin; `admin_resolve_recording_hold` → admin.

### 1.4 The global one-item processor `process_recording_conflict_inbox_one(p_by text) RETURNS jsonb` (`0011:654–718`)

`LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, booking`. Grant at `0011:835`.

1. `p_by` must be 1–200 chars after trim, else thrown `INBOX_BY_INVALID` (22023).
2. **Selection** (`0011:661`): `SELECT * INTO q … WHERE processed_at IS NULL ORDER BY attempts, seq LIMIT 1 FOR UPDATE SKIP LOCKED`. **Global**: no listing, intent, state or protected filter on either the intent or the evidence. Nothing found → `NULL`.
3. **Subtransaction** `BEGIN … EXCEPTION` (`0011:663–717`). Lock order: intent `FOR SHARE` → latest recording op `FOR SHARE` → advisory `('booking.recording_evidence', intent)` → `v_t`.
4. **Outcome:**
   - `not_latest_linked`, or `consistent` via the core (`0011:672`);
   - otherwise: active hold `FOR UPDATE` → open `OFFLINE_CHARGE_HOLD_LINKED_CONTRADICTED` case `FOR UPDATE` → `v_t`, then `contradiction_duplicate` / `_appended` / `_opened` / `_joined_case`;
   - an active hold with another reason → `HOLD_STATE_UNEXPECTED`.
5. **Success** marks `processed_at`, `outcome`, `hold_id` and returns `{evidenceId, outcome, holdId}` (`0011:709–710`).
6. **Error in the block** rolls back the subtransaction and its locks. It writes `attempts + 1`, `last_error = left(SQLSTATE || ': ' || message, 500)`, `last_attempt_at`, and returns `{evidenceId, error: SQLSTATE, message: left(message, 300)}` (`0011:711–716`).
7. **COMMENT erratum (historical, not a guarantee).** `0011:653` says "An error outside the block (or at COMMIT) marks nothing." The precise truth:
   - an error the server **acknowledges** (statement rejected, or COMMIT refused and reported) rolls the statement back and marks nothing;
   - a **transport loss around COMMIT** leaves the outcome UNKNOWN to the caller: it may have committed. `operations.js:318–320` already states this correctly.

   0011 is not edited; this contract's §6 governs.
8. **Caller contract** (`0011:649–652`): one top-level autocommit statement per call. Wrapping several calls in one transaction accumulates locks; interleaved intents deadlock (40P01, test T-H2).
9. It never changes intent or operation state, and never releases, finalises, links, resends or notifies.

### 1.5 Authoritative predicate and synchronous checks

- **`recording_evidence_contradicts(p_intent, p_dispatched_at, p_result_ref, p_reference, p_evidence)`** (`0011:299–338`): the explicit-reference core (scope / marker / field rules as written there).
- **`recording_conflict_refusal`** (`0011:340–353`): the count wrapper. Called synchronously by:
  - completion (`0011:363–402`; lock order intent SHARE → work SHARE → op UPDATE → advisory, `0011:370–373`);
  - link (`0011:404–434`; `0011:410–412`);
  - the finalisation trigger (`0011:436–454`; advisory `0011:446`).

  These checks are authoritative regardless of inbox progress.
- **`recording_latest_id`** (`0010:30–37`) and **`recording_active_hold_id`** (`0011:355–359`).

### 1.6 Intent facts used by scope

- **Immutable after insert:** `id`, `ref`, `listing_id`, stay, `environment` (`0001:163–167`).
- **`hostaway_reservation_id text UNIQUE`** (`0001:86`) is guarded only as "never REPLACED once set" (`0001:180–183`). **NULL → id is legal, once per id.**
- Reachable accepted DB paths that set it:
  - `applyEvent` `RESERVATION_SUCCEEDED` / reconciliation (`lib/booking-db/repo.js:226`, `:229`, `:621`, `coalesce(...)`);
  - the protected-id fixtures in `test/db/e74b-recording-worker.test.mjs:133–138` build exactly NULL → protected through ordinary repo paths (the workers refuse protected ids; the DB does not).

### 1.7 JS callers and admin maintenance

- **`drainRecordingConflictInbox`** (`operations.js:307–351`, bound 100 at `:310`):
  - requires a real `pg.Pool`; makes independent autocommit calls; no retry;
  - the same item erroring twice stops the run;
  - a thrown call re-throws the ORIGINAL error with no follow-up query, and attaches non-enumerable `drainProgress` (replied calls only);
  - COMMIT loss is UNKNOWN.
- **`listRecordingContradictions`** (`operations.js:196–219`) calls the read-only **global** `recording_contradictions_page` (`0011:721–744`; keyset full-µs `observed_at`, evidence id, op id; limit 1–500).
- **No runtime caller** of either: grep finds only `operations.js` and the tests. The recording worker never drains (`recording-worker.js:11–12`).
- **Admin:**
  - `admin_resolve_recording_hold` (`0011:746–818`; locks `0011:766–770`; JS `admin.js:58`);
  - `admin_release_preflight_hold` (`0013:493`; `admin.js:69`);
  - `admin_close_case` (`0011:530`; `admin.js:50`);
  - `admin_resolve_operation` / `_intent` / `admin_record_evidence` (`admin.js:26–38`);
  - hold openers `0011:586–634` and `0013:447`.
- **Protected ids exist only in JS** (`reservation-worker.js:69`, `compensation-proof.js`, `hostaway-reservations.js`); none in `db/`.

**Exists vs missing.**
- Exists: read-only DB inspection (table SELECT for app / admin / report; the global contradictions page) and the global processor and drain.
- Missing: a scoped processor, a scoped read-only page and summary, protected-reference exclusion, and a gated bounded scoped JS step.
- Owner UI: none exists, and none is proposed.

## 2. Why scope must live inside the DB selection and recheck

Choosing an allowed id elsewhere and then calling the global function processes whatever **it** selects (`0011:661`; no item parameter). Scope, including protected exclusion on both the intent and the evidence, must therefore be part of the selection predicate (before `LIMIT` and before any lock) and re-checked under the intent lock. The scoped API never falls back to the global function: no NULL / empty scope, and no JS path to `process_recording_conflict_inbox_one` / `drainRecordingConflictInbox`.

## 3. Proposed migration `0015_scoped_recording_inbox` (functions + grants only; no table / column / index)

Every function: `SET search_path = pg_catalog, booking`, `REVOKE ALL ON FUNCTION … FROM PUBLIC`, owner = schema owner. "No grant" means no runtime role may EXECUTE it; the definer functions below call these private helpers as the owner.

### 3.1 `booking.recording_protected_reservation_ids() RETURNS text[]` — private

`LANGUAGE sql IMMUTABLE SECURITY INVOKER`. Body: `SELECT ARRAY['70636076','71045356','71072615','71081885']::text[]`. **No grant.** Parity with JS `PROTECTED_HOSTAWAY_RESERVATION_IDS` is pinned by a test (D2).

### 3.2 `booking.recording_inbox_ref_protected(p_intent_reservation text, p_evidence_ref text) RETURNS boolean` — private, the ONE protected predicate

`LANGUAGE sql IMMUTABLE SECURITY INVOKER` (not STRICT). Returns `true` / `false`, never NULL:
```
coalesce(p_intent_reservation = ANY(booking.recording_protected_reservation_ids()), false)
OR p_evidence_ref IS NULL
OR p_evidence_ref = ANY(booking.recording_protected_reservation_ids())
```

**NULL rules:**
- an intent with no reservation yet is not protected by the intent half;
- an evidence ref that is NULL fails closed (protected). This is impossible under `0003:57 NOT NULL`, but defensive.

**Inputs** are always the CURRENT `booking.intents.hostaway_reservation_id` and the immutable `booking.provider_evidence.external_ref` of the item's own evidence row. `observed` JSON is never consulted. **No grant.**

Why only these two fields: a hold or contradiction can arise only when `e.external_ref = i.hostaway_reservation_id` (`0011:316`), so no other field can make a non-protected-ref item act on a protected reservation.

### 3.3 Shared private core `booking.recording_inbox_process_locked(p_evidence uuid, p_by text, p_scope integer[], p_scope_intent uuid) RETURNS jsonb`

`LANGUAGE plpgsql VOLATILE SECURITY DEFINER`. **No grant.**

**Precondition:** the caller (a wrapper, §3.4 / §3.5) has, in the SAME statement, locked the pending inbox row `p_evidence` `FOR UPDATE`. The core is never granted, so no runtime role can call it with an unlocked or out-of-scope id.

**`p_scope IS NULL` ⇔ the legacy wrapper.** The scoped wrapper validates a non-NULL, non-empty scope before calling, and nothing else calls the core.

**Internal result** (consumed only by the two wrappers):

| `kind` | Keys |
|---|---|
| `processed` | `evidenceId`, `intentId`, `outcome`, `holdId` (uuid or null) |
| `error` | `evidenceId`, `intentId`, `sqlstate`, `message` (= `left(MESSAGE_TEXT, 300)`), `attempts` (the committed new value) |
| `stale` | `evidenceId`, `intentId`. Only possible when `p_scope IS NOT NULL`. |

**Deliberate changes to the formerly verbatim block `0011:659–717`** (nothing else changes):

1. **Boundary and signature.** It becomes this private function. The selection stays in the wrappers. `RETURNS jsonb` carries the internal shape above instead of the legacy keys.
2. **Item re-read before the subtransaction**, outside it as the legacy selection is: `SELECT * INTO q FROM booking.recording_conflict_inbox WHERE evidence_id = p_evidence AND processed_at IS NULL FOR UPDATE`. This re-locks a row the same transaction already holds, which is a no-op. If not found, it raises `INBOX_ITEM_NOT_LOCKED` (an outer error; a programming fault, unreachable from the wrappers).
3. **Scoped recheck**, only when `p_scope IS NOT NULL`, as the first statements inside the subtransaction, after `SELECT * INTO i FROM booking.intents WHERE id = q.intent_id FOR SHARE`:
   - `SELECT external_ref, intent_id, kind INTO e FROM booking.provider_evidence WHERE id = q.evidence_id`;
   - **STALE** (return `kind:'stale'`, no write) unless all of:
     - `e.intent_id = q.intent_id`;
     - `e.kind = 'hostaway_offline_charges'`;
     - `i.listing_id = ANY(p_scope)`;
     - `(p_scope_intent IS NULL OR i.id = p_scope_intent)`;
     - `NOT booking.recording_inbox_ref_protected(i.hostaway_reservation_id, e.external_ref)`.

   The intent SHARE lock blocks any concurrent `UPDATE` of that intent until this statement ends, so the rechecked reservation id is authoritative for everything the item then writes.
4. **Success:** return `{kind:'processed', …}`, including `intentId`.
5. **Error branch:** the same `UPDATE … SET attempts = attempts + 1, last_error = left(st || ': ' || msg, 500), last_attempt_at = clock_timestamp()` **plus `RETURNING attempts INTO v_attempts`**, then return `{kind:'error', …}`.

**Unchanged:** the locks and their order, `v_t` placement, the outcome logic, hold / case / observation inserts and their columns (`created_by = p_by`), the success mark, the `last_error` format and the guard interaction.

### 3.4 Legacy `booking.process_recording_conflict_inbox_one(p_by text) RETURNS jsonb` — `CREATE OR REPLACE`, same signature / owner / SECURITY DEFINER / `search_path` / VOLATILE / grant (`0011:835` app, admin)

**Body:**
1. The same `p_by` validation (`0011:660`).
2. `SELECT q.evidence_id INTO v_ev FROM booking.recording_conflict_inbox AS q WHERE q.processed_at IS NULL ORDER BY q.attempts, q.seq LIMIT 1 FOR UPDATE SKIP LOCKED` — the same global predicate and order as `0011:661`, selecting the key only.
3. `IF NOT FOUND THEN RETURN NULL`.
4. `r := core(v_ev, p_by, NULL, NULL)`.
5. **Projection** (exact legacy keys, including `message`):
   - `processed` → `{evidenceId, outcome, holdId}`;
   - `error` → `{evidenceId, error: sqlstate, message}`;
   - `stale` is unreachable with a NULL scope; if it ever occurs, the wrapper raises `INBOX_CORE_STALE_UNSCOPED` (an outer error).

**Parity expectation:** for the same DB state and calls, return values, inbox / hold / observation / case rows and lock waits are identical to the 0011 body, except for uuid / timestamp values. The only observable differences are `pg_get_functiondef` text and the existence of the core function.

### 3.5 Scoped `booking.process_recording_conflict_inbox_scoped_one(p_by text, p_listing_ids integer[], p_intent uuid) RETURNS jsonb`

A **distinct name**, so it can never resolve to the global function. `p_intent` has **no default**; the caller passes NULL explicitly. `LANGUAGE plpgsql VOLATILE SECURITY DEFINER`. **GRANT EXECUTE TO mv_booking_app, mv_booking_admin.**

**1. Validation** (thrown 22023 before any lock or write):
- `INBOX_BY_INVALID`: `p_by` as legacy.
- `INBOX_SCOPE_INVALID` unless `p_listing_ids` is non-NULL, `array_ndims = 1`, has 1–50 elements, no NULL element, every element `> 0`, and no duplicates.
- `p_intent` NULL or any uuid (well-formedness is enforced by the type).

**2. Selection** (scope and both protected halves before `LIMIT`, before any lock; scalar key):
```sql
SELECT q.evidence_id INTO v_ev
  FROM booking.recording_conflict_inbox AS q
  JOIN booking.provider_evidence AS ev ON ev.id = q.evidence_id
  JOIN booking.intents AS it ON it.id = q.intent_id
 WHERE q.processed_at IS NULL
   AND ev.intent_id = q.intent_id AND ev.kind = 'hostaway_offline_charges'
   AND it.listing_id = ANY (p_listing_ids)
   AND (p_intent IS NULL OR q.intent_id = p_intent)
   AND NOT booking.recording_inbox_ref_protected(it.hostaway_reservation_id, ev.external_ref)
 ORDER BY q.attempts, q.seq
 LIMIT 1
 FOR UPDATE OF q SKIP LOCKED;
```
- Only the inbox row is locked; intents and evidence are read as current committed facts.
- **No intent-state filter**: every state is served. A contradiction after `confirmed` is visibility-only.

**3. Nothing found → `NULL`.** Valid input that matches nothing (unknown listing, intent outside the listings, all excluded) is `NULL`, not an error.

**4.** `r := core(v_ev, p_by, p_listing_ids, p_intent)`.

**5. Projection** (no `message`, no `last_error` text, no labels):

| Core result | Returned |
|---|---|
| `processed` | `{evidenceId, intentId, outcome, holdId}` |
| `error` | `{evidenceId, intentId, error: sqlstate, attempts}`. **SQLSTATE only** (root preference); no message-derived code. |
| `stale` | `{evidenceId, intentId, skipped: 'STALE_OUT_OF_SCOPE'}` |

### 3.6 Read-only scoped page `booking.recording_inbox_page(p_listing_ids integer[], p_intent uuid, p_status text, p_after_seq bigint, p_limit integer)`

`RETURNS TABLE (...)`. `LANGUAGE plpgsql VOLATILE SECURITY DEFINER` (VOLATILE as `recording_contradictions_page`; it calls the VOLATILE `recording_latest_id`). It performs no write. **GRANT EXECUTE TO mv_booking_app, mv_booking_admin, mv_booking_report** (D4).

**Validation (22023):**
- `INBOX_SCOPE_INVALID`: as §3.5.
- `INBOX_STATUS_INVALID` unless `p_status ∈ {'pending','processed','all'}` (no default).
- `INBOX_CURSOR_INVALID` unless `p_after_seq` is NULL or `> 0`.
- `p_limit` NULL → 50; otherwise clamped to 1–200.

**Rows:** the SAME scope, protected and evidence-binding predicate as §3.5, plus the status filter, then `WHERE (p_after_seq IS NULL OR q.seq > p_after_seq) ORDER BY q.seq LIMIT n`. `seq` is a unique identity, so it is its own tie-break.

**Columns (exact):**

| Group | Columns |
|---|---|
| Item | `seq bigint`, `evidence_id`, `intent_id`, `listing_id`, `intent_state` |
| Timing | `enqueued_at_exact` (`YYYY-MM-DDTHH:MM:SS.ffffffZ` UTC); `db_now_exact` (one `statement_timestamp()` for the whole page) |
| Attempts | `attempts`, `last_attempt_at_exact`, `last_error_code text` (`left(last_error, 5)` = the SQLSTATE the accounting wrote first; never message text) |
| Result | `processed_at_exact`, `outcome` |
| Hold / case | `hold_id`; `hold_reason`, `hold_active`, `case_id`, `case_status` via `LEFT JOIN booking.recording_holds h ON h.id = q.hold_id` and `LEFT JOIN booking.reconciliation_cases c ON c.id = h.case_id`. `hold_active = CASE WHEN h.id IS NULL THEN NULL ELSE h.released_at IS NULL END`. With no hold, all four are **NULL** (explicit choice), never `true` from a missing row. |
| Latest recording | `latest_op_id`, `latest_op_state`, `latest_op_linked` (`settled_evidence_id IS NOT NULL`), via `booking.recording_latest_id(q.intent_id)`; NULL when the intent has no recording |
| Proof provenance | `evidence_source` (`hostaway_api` / `hostaway_dashboard`), `evidence_observed_at_exact`, `evidence_read_operation_id` (NULL for dashboard) |

Never exposed: `observed`, raw provider bodies, `last_error` beyond its SQLSTATE, `p_by` / `created_by`, labels, attestation text.

**Concurrency caveat:** identity values may commit out of `seq` order. An item with a lower `seq` can become visible after a page has passed it, and is seen by a fresh scan from `p_after_seq = NULL`. Counts are a per-statement snapshot.

### 3.7 Read-only scoped summary `booking.recording_inbox_summary(p_listing_ids integer[], p_intent uuid) RETURNS jsonb`

Same LANGUAGE / volatility / SECURITY / grants as §3.6. Validation as §3.5 (scope).

**Units are explicit:**
- **Items** (inbox rows passing the §3.5 scope / protected / binding predicate): `pendingItems`, `pendingItemsWithErrors` (attempts > 0), `maxPendingAttempts` (NULL if none), `oldestPendingEnqueuedAtExact` (NULL if none), `processedItemsByOutcome` (an object of the 6 outcomes → item counts; missing outcomes 0).
- **DISTINCT holds:** `activeLinkedContradictedHolds = count(DISTINCT h.id)` over `booking.recording_holds h JOIN booking.intents it ON it.id = h.intent_id`, with in-scope `it` (listing / intent), `NOT recording_inbox_ref_protected(it.hostaway_reservation_id, it.hostaway_reservation_id)` (intent half), `h.reason = 'LINKED_CONTRADICTED'` and `h.released_at IS NULL`. Computed **from holds, not by joining items**, so items never multiply a hold.
- **DISTINCT cases:** `openHoldCases = count(DISTINCT c.id)` over `booking.reconciliation_cases c` for in-scope, intent-non-protected intents, with `c.kind LIKE 'OFFLINE\_CHARGE\_HOLD\_%'` and `c.status = 'open'`.
- `dbNowExact`.

**Empty scope result** (valid input, nothing matches) → all counts 0, timestamps NULL. Invalid input → 22023.

### 3.8 Up / down

**Up**, in order, one transaction:
1. §3.1, then §3.2;
2. §3.3 core;
3. §3.4 `CREATE OR REPLACE` (owner, ACL, SECURITY DEFINER and `search_path` preserved);
4. §3.5, §3.6, §3.7;
5. `REVOKE ALL … FROM PUBLIC` on every new function;
6. the grants listed above.

**Down**, in order, one transaction:
1. **Restore the legacy body FIRST**: `CREATE OR REPLACE` `process_recording_conflict_inbox_one` verbatim from `0011:654–718`, so nothing still calls the core;
2. `DROP FUNCTION` §3.7, §3.6, §3.5, §3.3, §3.2, §3.1, with exact signatures.

plpgsql bodies are not dependency-tracked, so this order is what keeps every intermediate state callable.

**No down gate.** Down removes functions only. Rows written through the scoped API are ordinary 0011 audit (inbox mark / attempts / hold / observation / case), valid and interpreted identically under 0011–0014, and **never deleted or rewritten**. The 0011 down gate (`0011.down:5–13`) is unchanged.

**Equality obligations:** after `0014 → 0015 → 0014`,
- `pg_get_functiondef`, `proacl`, `prosecdef` and `proconfig` (search_path) of `process_recording_conflict_inbox_one` equal the 0014 state;
- no new function remains;
- all audit row counts and contents are unchanged.

## 4. Transactions and locks

### 4.1 Sequence

One item is one top-level autocommit statement:
1. `[wrapper]` select the key + lock the inbox row `FOR UPDATE … SKIP LOCKED` (intent / evidence read unlocked);
2. `[core, outside the subtransaction]` re-read the item (own lock);
3. `[subtransaction]` intent `FOR SHARE` → (scoped) recheck incl. evidence read → latest op `FOR SHARE` → advisory → `v_t` → (contradiction) hold `FOR UPDATE` → case `FOR UPDATE` → `v_t` → writes → inbox mark.

This is the **existing 0011 ordering** with the recheck inserted. It shares its ordering with:
- completion (`0011:370–373`), link (`0011:410–412`), finalisation (E3 intent UPDATE → advisory, `0011:446`);
- owner resolve (`0011:766–770`);
- the evidence writers (read op UPDATE → evidence INSERT, which enqueues a NEW inbox row → advisory; `0010:359`, `:385–388`).

**Known deadlock limits (test obligations, not a new universal guarantee):**
- (a) several calls wrapped in one caller transaction with interleaved intents → 40P01 (T-H2);
- (b) a direct runtime `UPDATE` racing an ordered transaction → bounded 40P01 (T-B3).

A 40P01 **inside** the subtransaction becomes a recorded item error (attempts + 1). One **outside** it (selection / item re-read / COMMIT) is an outer failure (§6).

No table lock, global advisory key or cross-intent lock is introduced; advisory keys are per intent (hash collisions can only cause waiting). No provider or network call exists in any of these functions.

### 4.2 Races

- **Overlapping scoped processors.** SKIP LOCKED: distinct items, or `NULL`. Items of the same intent serialize on the advisory lock.
- **Disjoint scopes.** Disjoint listings mean disjoint intents and no row contention.
- **Same item.** At most one locks it. A loser that saw it pending re-evaluates the row after the winner commits (READ COMMITTED), sees `processed_at`, and skips it.
- **Scoped vs legacy.** Same SKIP LOCKED semantics. D5: the legacy processor may still take a protected-ref item, as today.
- **Completion / link / finalisation / owner paths.** Serialized per intent by the advisory lock. 0011 semantics hold:
  - a contradiction committed before a link makes the link refuse (T-C5);
  - after a link, the processor opens the hold;
  - an active hold blocks completion / link / finalisation (T-B4).
- **The legal NULL → id binding (R1).** Selection may read `hostaway_reservation_id IS NULL` (or see an E3 transaction in progress) and then block on intent `FOR SHARE` until that `UPDATE` commits. The recheck reads the committed new value. If it is protected → `stale` with zero writes; a later call excludes the item at selection. If not protected → normal processing on current facts.
  - **Stageable without any trigger bypass:** hold the intent's E3 transaction open with `applyEvent(..., { inTx: barrier })` on an ordinary `RESERVATION_SUCCEEDED` path. Prove the processor waits (an observed lock wait in `pg_stat_activity` / `pg_locks`, as in the e74a "overlap PROVEN" pattern). Then release.
  - Listing / intent id / evidence ref cannot change (`0001:163–167`, `0003:73–76`).
  - A protected id can be bound to at most one intent (UNIQUE, `0001:86`).
- **Intent state changes during a wait.** State is not a scope input; outcomes are computed after the locks from current rows.

**Not promised:** exactly-once processing, any wall-clock latency, or that bounded calls drain a backlog. Once-only *semantic* effects rest on the frozen item (guard), `UNIQUE (hold_id, evidence_id)` and one active hold per op.

## 5. Semantics preserved (not new)

- Same predicate (linked proof as the reference); same idempotent hold / case binding.
- No reversal, finalisation, release, link, resend, notification, intent transition or operation change.
- **Late historical evidence:** selected by `seq`, so it is judged (T-C4). Evidence observed at or before dispatch never contradicts.
- **Pre-link:** `not_latest_linked`; the 0010 synchronous checks decide. **Post-link:** judged against the linked proof.
- **A clean item (`consistent` / `not_latest_linked`) is final for that item only and never means later evidence is clear.** Completion and finalisation re-check synchronously regardless of drain progress.
- **Already held / resolved:** an active `LINKED_CONTRADICTED` hold receives an observation. Released holds / resolved cases are not reopened; a new hold + new or joined open case per the existing branches.
- **Protected-ref items** on a non-protected intent can never yield a contradiction (`0011:316`). Under the scoped API they are excluded entirely and their audit stays byte-identical.

## 6. Errors (this section governs everywhere)

- **Recorded item error** (returned data): the DB committed `attempts + 1`, `last_error` and `last_attempt_at`; the item stays queued. JS lists it under `errors` with `{evidenceId, intentId, error, attempts}`, never as processed. The same item twice in one step → stop (`stoppedOnRepeatedError`).
- **Starvation and fairness (D3):**
  - `ORDER BY attempts, seq`: fresh (attempts 0) items precede erroring ones in the same scope;
  - erroring items rotate by attempts;
  - out-of-scope and protected items are excluded before `LIMIT` and can never occupy a scoped call;
  - **no attempt ceiling**, and **no claim that poison items eventually clear**: they stay visible (attempts, SQLSTATE) on the page / summary.
- **Stale:** `skipped`, zero writes. The JS step records it under `skipped` and stops (current facts changed under it); the next independent step re-selects on current facts.
- **Thrown outer failure** (validation 22023, connection / transport, any SQL error outside the subtransaction, COMMIT):
  - the step stops immediately;
  - it re-throws the **original** error object (identity, `code`, `message`) with **no follow-up query and no retry**;
  - it attaches non-enumerable `err.scopedInboxProgress = {calls, processed, errors, skipped}` (replied calls only), when the object is extensible.
- **Acknowledged vs unknown:**
  - a server-**acknowledged** rejection rolled that statement back (nothing marked);
  - a **transport loss around COMMIT** is **UNKNOWN**: it may have committed.

  Never claim "rolled back" or exactly-once. The only safe follow-up is read-only scoped inspection (§3.6 / §3.7). No automatic retry of the ambiguous call.
- **Later independent step:** works purely from persisted facts. A committed item is frozen and never re-selected; an uncommitted one is pending and selected normally. The guards and unique keys prevent a duplicate hold or observation either way.
- **Pool vs client:**
  - processing requires a real `pg.Pool` (each call its own autocommit statement), never a client inside an open transaction (T-H2);
  - the page / summary accept a `pg.Pool` or a client (read-only).

## 7. Proposed JS (new offline-only module `lib/booking-db/recording-inbox.js`; manual / injected; no default executor)

### 7.1 Validation order (pure, zero queries; first failure wins)

1. **Options shape:** a plain object; only the documented keys → else `OPTIONS_INVALID`.
2. **Environment** (common):
   - `env` must be a plain object (never read implicitly) → `ENV_REQUIRED`;
   - `VERCEL_ENV === 'production'` → `PRODUCTION_REFUSED`;
   - not `development` / `preview` → `ENVIRONMENT_NOT_ALLOWED`;
   - `MV_E7_RECORDING_INBOX !== 'enabled'` → `NOT_ENABLED`.
3. **Read scope** (common):
   - `listingIds`: an Array of 1–50 elements, each `Number.isInteger`, 1 ≤ x ≤ 2147483647 (PostgreSQL int4), no duplicates → `SCOPE_INVALID`;
   - `intentId`: `null` (default when omitted) or `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$` → `INTENT_ID_INVALID`.
4. **API-specific:**
   - **processor:**
     - `by` matches `^[A-Za-z0-9._:-]{1,80}$` → else `BY_INVALID`;
     - `maxItems`: omitted → 10; a safe integer → clamped 1–25; anything else → `MAX_ITEMS_INVALID`.
   - **page:**
     - `status ∈ {'pending','processed','all'}`, required → else `STATUS_INVALID`;
     - `after`: `null` or `{ afterSeq }` where `afterSeq` is a canonical decimal string `^[1-9][0-9]{0,18}$` with `BigInt(afterSeq) ≤ 9223372036854775807n` → else `CURSOR_INVALID`;
     - `limit`: omitted → 50; a safe integer → clamped 1–200; anything else → `LIMIT_INVALID`.
   - **summary:** none.
5. **Pool:**
   - processor: a real `pg.Pool` (`query`, `connect`, numeric `totalCount`) → else `POOL_REQUIRED`;
   - page / summary: any object with `query`.

A refusal is `Object.freeze({ status: 'refused', code })` with **zero queries**.

### 7.2 One marker check per invocation

`SELECT environment FROM booking.instance` (explicit, no catch):
- a marker read and ≠ `'test'`, or absent → `{status:'refused', code:'DATABASE_NOT_TEST'}`;
- a thrown error → the original error, with no follow-up query (R-C1 pattern).

### 7.3 Calls and results

**`processScopedRecordingInbox(pool, { env, by, listingIds, intentId, maxItems })`**
- Makes ≤ effective `maxItems` calls of `process_recording_conflict_inbox_scoped_one($1, $2::int[], $3::uuid)`.
- Returns `{status:'worked'|'idle', calls, processed:[{evidenceId,intentId,outcome,holdId}], errors:[{evidenceId,intentId,error,attempts}], skipped:[{evidenceId,intentId}], drained, stoppedOnRepeatedError}`.
- `idle` iff the first call returned `NULL`. `drained` iff some call returned `NULL`. `attempts` arrives as a JSON number (int4 attempts).

**`listScopedRecordingInbox(pool, { env, listingIds, intentId, status, after, limit })`**
- `afterSeq` is passed as **text** and cast `::bigint` in SQL.
- `seq` comes back as node-pg's bigint string, kept as a string (no `Number()` / `parseInt`).
- Returns `{status:'ok', rows, next}`, where `next = { afterSeq: lastRow.seq }` **iff `rows.length === effectiveLimit`** (the clamped value), else `null`.
- An empty page is `{status:'ok', rows:[], next:null}`.

**`scopedRecordingInboxSummary(pool, { env, listingIds, intentId })`** → `{status:'ok', summary}` (§3.7 fields).

### 7.4 Explicitly none

No schedule, cron, periodic task, route, UI, deployment, live dispatch, notification, provider call, or production cadence / latency promise. Invocation is manual / injected (tests, or a separately approved future runner). The module goes in `OFFLINE_ONLY`.

## 8. Test matrix (future slice; disposable PG; `test/db/e7-scoped-recording-inbox.test.mjs`)

| # | Test | Expected |
|---|---|---|
| T-R1a | Allowed-listing intent with **NULL** reservation (`payment_authorized`, accepted repo path). Ordinary API evidence: `requestRead(list_offline_charges, '70636076')` → claim → complete → `recordProviderEvidence(external_ref '70636076')`. Plus non-protected control items in the same listing. | The scoped processor never selects / locks / marks it: byte-identical inbox / hold / case snapshot, attempts 0. Excluded from page and summary. Controls are processed. |
| T-R1b | Allowed intent with a non-protected reservation. **Dashboard** evidence `adminRecordEvidence(external_ref protected)`. | Same as T-R1a. |
| T-R1c | Intent bound to a protected id through the accepted repo path (as the `e74b-recording-worker.test.mjs:133–138` fixtures), with ordinary evidence. | Excluded everywhere. |
| T-R1d | Legal NULL → protected race: `applyEvent RESERVATION_SUCCEEDED` held open by an `inTx` barrier; scoped call issued; lock wait observed; release. | `skipped STALE_OUT_OF_SCOPE`, zero writes; the next call excludes the item at selection. Non-protected NULL → id control: processed normally. **No trigger bypass.** |
| T-R1e | Starvation: protected items with the lowest `seq` / attempts 0 ahead of a control; `maxItems = 1`. | The control is processed on the first call. |
| T-S1 | Late contradiction after `confirmed` (rehearsal chain re-declared test-locally), API + dashboard. | Exactly one `LINKED_CONTRADICTED` hold + one open case + one observation per item; intent state / version unchanged; a repeat call → `NULL`. |
| T-S2 | The rehearsal's two happy items. | Both `consistent`; nothing else written. |
| T-S3 | Unrelated listing + 100 noise items; optional `intentId` narrowing; an intent outside the listings. | Untouched (snapshots); narrowing exact; outside → `NULL` / empty page / zero counts. |
| T-V1 | Bad input: absent / empty / NULL element / duplicate / 0 / 2147483648 / non-integer listing ids; malformed intent id; bad `by` / `maxItems` / `status` / cursor / `limit`. | JS refusal codes with **zero queries** (trap pool). Direct SQL → 22023 with zero writes. No path to the global function (grep + trap). |
| T-C1 | Overlapping / disjoint concurrent processors (barriers); same item; scoped vs legacy. | Each item processed once; no extra rows. |
| T-C2 | Races with completion / link / finalisation / owner resolve in both orders. | T-C5 / T-B4 parity. |
| T-C3 | Wrapped-transaction deadlock (T-H2 pattern) on the scoped function. | 40P01 inside → recorded error; outside → thrown. |
| T-H1 | Historical evidence inserted later with an old `observed_at`; evidence at or before dispatch. | Judged; `consistent`. |
| T-E1 | Poison item (T-C7 probe). | Attempts / `last_error` recorded; returned shape `{error: SQLSTATE, attempts}` with **no message**; fresh items first; repeated error stops the step; the page shows `last_error_code` only. |
| T-E2 | Fault-injecting pool: throw before any reply, after a processed item, and connection loss after a committed outcome. | Exact query counts; original error identity / code / message; `scopedInboxProgress` covers replied calls only; read-only inspection afterwards; a later step processes the rest without duplicates. |
| T-P1 | Page / summary: scope before `LIMIT`; `seq` keyset at limits 1 / 2 / 3 and clamped limits (`next` only when `rows === effectiveLimit`). | Exact rows / cursor; full-µs `_exact` fields; NULL `hold_active` / `case_*` without a hold; summary units (two items, one hold → holds = 1). |
| T-P2 | **TEST SETUP:** `setval` on the identity sequence to `9007199254740993` (labelled; disposable DB). | `seq` / `afterSeq` round-trip as exact strings; a lower-`seq` late-commit arrival is visible on a fresh scan. |
| T-G1 | Grants / roles. | Scoped processor → app / admin. Page / summary → app / admin / report. Core / protected / predicate functions: no runtime EXECUTE. Legacy ACL unchanged; no write privilege added. |
| T-M1 | Up / down. | `0014 → 0015 → 0014` function-def / ACL / secdef / config equality; audit preserved across down / up; 0011 down gate unchanged. |
| T-L1 | Legacy parity. | Legacy wrapper vs the 0011 body on the T-C / T-H fixtures: identical results / rows. Protected-id SQL ↔ JS parity. |
| T-REG | Regression. | Rehearsal file, `e74b-d1-owner-cases`, `e74b-d2-recording-evidence`, `e74b-recording-worker`, the migrations test, `npm test`, `test:db`. Targeted mutants only (scope-before-LIMIT, evidence-half protected, intent-half protected, recheck, projection message leak). |

**Not stageable / not claimed:** a change to `listing_id`, intent id or `external_ref` between selection and recheck. These are impossible under `0001:163–167` / `0003:73–76` and would require disabling triggers, which the tests will not do. The recheck still covers them, by inspection only.

## 9. Smallest executable implementation slice (when authorized)

**Allowed files:**
- `db/migrations/0015_scoped_recording_inbox.up.sql` / `.down.sql` (§3);
- `lib/booking-db/recording-inbox.js` (new; §7);
- `test/db/e7-scoped-recording-inbox.test.mjs` (new; §8);
- `test/packaging-closure.test.mjs` (the `BOOKING_DB_FILES` pin + `OFFLINE_ONLY` entry);
- `test/db/migrations.test.mjs` (only its pinned function / ACL counts for 0015);
- this contract's implementation map.

**No change to:** 0001–0014; workers; `operations.js` (the legacy drain and contradictions caller); fixtures; config; dependencies; routes; UI.

## 10. Root choices (adopted)

- **D1 — shared private core** (§3.3) with the exact internal / legacy / scoped mapping (§3.4 / §3.5) and legacy parity tests (T-L1).
- **D2 — private SQL protected-id constant** (§3.1), pinned to JS, not caller-omittable.
- **D3 — no attempt ceiling** in this slice. Returned item errors stay queued and visible; there is a bounded repeated-error rule and a fresh-work preference; no claim that poison items clear.
- **D4 — read-only page + summary** granted to app / admin / report. Private core / protected / predicate functions have no runtime EXECUTE.
- **D5 — legacy global processor** kept with unchanged semantics and grants. An explicit residual: not protected-aware; never called as a scoped fallback.

No change to tenant / auth / worker scope, and no production cadence or latency promise.

**Remaining blocker:** none for a docs-level review. Open residuals: D5 (the legacy processor can still mark protected-ref items, exactly as today), and the historical e74a guard failure (unrelated; stays open).

## 11. Implementation map (offline; `feature/e7-scoped-recording-inbox` from exact `99a78fcf`) — pending root code review

### 11.1 Files

| File | Content |
|---|---|
| `db/migrations/0015_scoped_recording_inbox.up.sql` | §3.1–§3.7 |
| `db/migrations/0015_scoped_recording_inbox.down.sql` | §3.8 |
| `lib/booking-db/recording-inbox.js` | §7 |
| `test/db/e7-scoped-recording-inbox.test.mjs` | §8 matrix; disposable PG |
| `test/e7-scoped-recording-inbox.test.mjs` | no-PG validation / marker / outer-failure / copy tests |
| `test/packaging-closure.test.mjs` | `BOOKING_DB_FILES` pin + `OFFLINE_ONLY` entry only |
| `test/db/migrations.test.mjs` and the 0011–0014 migration tests | mechanical pins, §11.4 |

0001–0014, workers, `operations.js`, `pool.js`, pure modules, fixtures, config, dependencies, routes and UI are unchanged.

### 11.2 SQL map

| Function | LANGUAGE / volatility | Security | `search_path` | Grants |
|---|---|---|---|---|
| `recording_protected_reservation_ids()` | sql IMMUTABLE | INVOKER | fixed | none (REVOKE PUBLIC) |
| `recording_inbox_ref_protected(text, text)` | sql IMMUTABLE | INVOKER | fixed | none |
| `recording_inbox_process_locked(uuid, text, integer[], uuid)` (core) | plpgsql VOLATILE | DEFINER | fixed | none |
| `process_recording_conflict_inbox_one(text)` (legacy, `CREATE OR REPLACE`) | plpgsql VOLATILE | DEFINER | fixed | unchanged: app, admin |
| `process_recording_conflict_inbox_scoped_one(text, integer[], uuid)` | plpgsql VOLATILE | DEFINER | fixed | app, admin |
| `recording_inbox_page(integer[], uuid, text, bigint, integer)` | plpgsql VOLATILE | DEFINER | fixed | app, admin, report |
| `recording_inbox_summary(integer[], uuid)` | plpgsql VOLATILE | DEFINER | fixed | app, admin, report |

No table, column, index, trigger, policy or write privilege is added.

**Core.** The 0011:663–717 block, generated mechanically from the 0011 file, with exactly the marked changes (a)–(d):
- (a) the item re-read `FOR UPDATE`, outside the subtransaction;
- (b) the scoped recheck after intent `FOR SHARE`;
- (c) the internal success result;
- (d) `RETURNING attempts` + the internal error result.

Lock order and all hold / case / observation logic are unchanged.

**Selection and recheck.** Scope (listing, optional intent), evidence binding (`ev.intent_id = q.intent_id`, kind) and BOTH protected halves are in the WHERE clause before `LIMIT` / `FOR UPDATE OF q SKIP LOCKED`. The same predicate text is used by the page and summary CTEs. The recheck uses CURRENT facts under the intent SHARE lock.

**Results.**

| Function | Processed | Error | Stale |
|---|---|---|---|
| Legacy | `{evidenceId, outcome, holdId}` | `{evidenceId, error, message}` | raises `INBOX_CORE_STALE_UNSCOPED` (XX000); unreachable |
| Scoped | `{evidenceId, intentId, outcome, holdId}` | `{evidenceId, intentId, error: SQLSTATE, attempts}` | `{evidenceId, intentId, skipped: 'STALE_OUT_OF_SCOPE'}` |

An unknown core kind in the scoped function raises `INBOX_CORE_RESULT_INVALID` (XX000).

**Down.**
1. The 0011:654–718 text restored first, with only `CREATE` → `CREATE OR REPLACE`.
2. `DROP` in dependency order: summary, page, scoped, core, predicate, constant.

**Implementation choices within the contract (labelled):**
- (i) The page's latest-recording columns use the `recording_latest_id` ordering (0010:30–37) inline in a `LATERAL` subquery, so the whole page is ONE statement snapshot (root's consistency request) instead of a VOLATILE per-row function call. The summary is likewise one statement of CTEs.
- (ii) Scope validation is inline, identical text, in the three public functions (no extra private helper).
- (iii) The summary's hold / case set treats an intent with a NULL reservation as protected (fail closed). Such an intent cannot have a recording hold.

### 11.3 JS map

- **Validation:** per call, options are copied once (listingIds element by element) and validated with zero queries:
  - common: options shape → env → scope (int4 `1..2147483647`, 1–50, distinct) → intentId;
  - processor-only: `by` / `maxItems` (default 10, clamp 1–25);
  - page-only: `status` / `after.afterSeq` decimal string ≤ 2^63−1 / `limit` (default 50, clamp 1–200).

  Then the pool shape is checked, then ONE marker `SELECT`. Read APIs refuse processor keys (`OPTIONS_INVALID`).
- **`calls`** = attempted calls (a thrown one counts); the arrays hold acknowledged replies only.
- **Outer failure:** the original error is re-thrown with non-enumerable `scopedInboxProgress`. An unexpected reply shape is a thrown TypeError with progress.
- **Page:** the column list selects `seq::text`; `next` is set iff `rows.length === effectiveLimit`.

### 11.4 Mechanical adaptations of existing regression tests (version / down-prefix pins only; assertion and data gates preserved)

| File | Assertion | Adaptation |
|---|---|---|
| `test/db/migrations.test.mjs` | migration file list | `+ 15_scoped_recording_inbox` |
| same | the four full `[1..14]` up / status / CLI-`applied` arrays | `+ 15` |
| same | every down-from-latest array | `15` prefix |
| same | every up-to-latest array | `15` suffix |
| `test/db/e74b-d1-assessments.test.mjs` | A-16 down to 12 / up; D-1..D-3 down to 12 | `[15, 14, 13]`; `[13, 14, 15]` |
| `test/db/e74b-d1-release.test.mjs` | D-13 down to 13 / final up | `[15, 14]`; `[14, 15]` |
| `test/db/e74b-d1-completion-binding.test.mjs` | U-1 / U-2 / U-3 down to 13 | `[15, 14]` |
| same | U-2 "installs exactly a fresh 14" | explicit `to: 14` for both clusters |
| same | D-1 / D-2 premise "schema at 14" | explicit down to 14 (`[15]`) first; D-1 re-up `to: 14` |
| `test/db/e74b-d1-owner-cases.test.mjs` | T-C9 up from 10 | `+ 15`; comment |
| same | T-G2 "the 0014 gate is the LATEST step; nothing rolled back" | explicit down to 14 first; "nothing rolled back" asserted with `to: 14`; then up `[15]` |
| `test/db/e74b-d2-recording-evidence.test.mjs` | the same "latest refuses; nothing rolled back" | the same adaptation |

**Why the explicit down to 14:** 0015 is ungated and each migration step is its own transaction, so a refused down from 15 would otherwise roll back 0015 before the measured gate answered.

### 11.5 Results (CLAUDE-RUN, disposable local PG 16; full TAP in `scratchpad/tap-sib/`, mutants in `scratchpad/mut-sib/`)

| Suite | Result |
|---|---|
| Scoped PG matrix `test/db/e7-scoped-recording-inbox.test.mjs` | 17/17 |
| No-PG unit file + packaging closure | 14/14 |
| Regressions: lifecycle rehearsal, all e74b-d1-*, e74b-d2, e74b-recording-worker, migrations, offline-charge | 160/160 |
| `npm test` | 690/690 |
| `npm run test:db` | 433/433 |

- **Pre-adaptation run:** a full `test:db` before §11.4 had 411/433. The 22 failures were all the version pins listed there; TAP kept as `test-db-pre-adapt.tap`.
- **e74a listing-lock guard:** passed in both runs (`ok 190`). The historical failure stays OPEN and unexplained.
- **Targeted mutants:** 7/7 killed; the file was restored and hash-verified after each.

| Mutant | Killed by |
|---|---|
| M1 scope-before-LIMIT removed | 9 tests |
| M2 evidence half dropped from selection | T-R1a |
| M3 intent half dropped from selection | T-R1d |
| M4 in-lock recheck removed | T-R1d |
| M5 message added to scoped projection | T-C3, T-E1 |
| M6 page evidence half | T-R1a |
| M7 summary evidence half | T-R1a |

No surviving or redundant mutant; no broader campaign.

**Probe / TEST SETUP used** (all labelled in the file):
- the T-C7-pattern impossible-hold probe (triggers bypassed) to create a poison item;
- `setval` above 2^53 on the disposable identity sequence;

The legacy global processor is called only in the isolated parity / concurrency clusters, which hold no protected-reference item.

**Residuals:**
- D5: the legacy global processor still marks protected-reference items, exactly as before; it is never a scoped fallback.
- No production cadence, scheduler, route or UI.
- No exactly-once or wall-latency claim; the known wrapped-transaction / direct-UPDATE deadlock limits remain (T-C3).
- The e74a historical failure stays open.
