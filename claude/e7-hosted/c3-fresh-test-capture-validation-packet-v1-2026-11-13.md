# C3 — FRESH TEST CAPTURE VALIDATION PACKET v1 (source-only; for ROOT review)
2026-11-13 · Claude executor · doc-only · **rev2** (review 5897051037 F1–F3 applied). The three SQL artifacts in §3 were generated from the schema-21 catalog and validated with the four controls ROOT required on a disposable schema-21 database at 59178b04 (§3.4; no shared query). Works from merged main `2920959542087cf9dd744c0e9e30b6626df061fc` (tree `e968f845…`) and tooling `59178b0468469b6570beab861bbc8e48b3a887d1` (e7-test, PR #84). Nothing here is implemented, enabled, dispatched or queried; no owner action or approval is requested by this document.

**Governing policy (Joel, 2026-11-13):** cancelling a reservation does NOT imply refunding, voiding or cancelling a payment. Refunds and any other payment disposition are MANUAL, assessed against the cancellation policy, and performed only as a reviewed owner action with identity + observed state. No automated refunds — not even for TEST. The Slice 3 / Slice 5 cleanup runners and the historical void path are HELD and are not part of this packet.

## 1. Merged checkpoint — what is proven and what is not
| Item | Value |
|---|---|
| main | `29209595` (tree `e968f845`), parents `c4b9cd5a` + `6f6fe71c`; review 5896950009 |
| Slice 1 reservation | pin `40779e34`, closure `0ffc0b9c…`, runnerDigest `5665544de105e4564a57a4434fa32fd2355b9bbd0e756b250d1248e07feb6b19`, `executeEnabled=false` |
| **Slice 2 capture** | **pin `59178b04`** (C1 fix: no `final_capture`), closure `adaed04409012a233abcfb0a7aa748c0f8bc9e21afbd4e13adb94c064a97fd8f`, runnerDigest `5b547a42200b452055d8a718c84ab70f7f2b5a0cd8343f6174c4a75b0c420ed1`, `executeEnabled=false` |
| Slice 3 test-cleanup | pin `9d86bfa1`, runnerDigest `33f2ab18…bd1e`, `false` — **HELD (policy)** |
| Slice 4 recording | pin `5a094b16`, runnerDigest `dafcc415dd2a5b2bfcfa163bcf2c116d99e82c83ee8611353bd1cd395252b683`, `false` — HOLD (D4) |
| Slice 5 recorded-cleanup | pin `e41b654a`, runnerDigest `3e0eba42…5d16`, `false` — HOLD / HELD |
| PR #81 | separate draft (page-integration test maintenance), not merged |

**Proven OFFLINE (fake providers, disposable schema-21 PG, Node 22.22.0 / PG 16.15 local, PG 17.11 ROOT):** the corrected capture chain emits `amount_to_capture=<full>&expand[]=latest_charge` and nothing else (C1 regression 5/5; baseline 1/5); the main capture runner at pin 59178b04 fences exactly that body (capture suite 15/15 + real-worker 18/18); mixed-pin composition reservation(40779e34) → capture(59178b04) → downstream workers (rehearsal 7/7, 100/100 ROOT).
**Proven LIVE (2026-11-13 owner-present test):** Slice 1 reservation on real Hostaway incl. the not-echoed two-session continuation (F1); Slice 2 pre-capture proofs (account + STRICT still-authorized PI read) over the real exchange; exactly one fenced capture send; fail-closed `capture_unknown` on a provider 400 with zero retry; foreign-intent isolation; gates / plan-hash / digest pins.
**NOT proven live:** a successful Stripe TEST capture through the hosted path. The only live capture attempt was rejected (400 `final_capture`, req_29dKSmY0uOuX26). **The C1/C2 fix is offline-verified only.** That is the single thing this packet aims to validate, and nothing more.

## 2. The validation path (smallest; reservation + capture ONLY)
Sequence per NEW TEST intent: O1 owner DEV checkout (HELD until ROOT GO) → R1 proof → S1-A reservation (authorized) → [S1-B reservation (pending), if not echoed] → S2 capture → **STOP. Captured. Awaiting manual disposition.** No S3, no cleanup runner, no refund, no void.

### 2.1 Exact existing workflow inputs (unchanged on main; `workflow_dispatch` only)
`e7-hosted-reservation.yml`: `mode` (preflight|execute), `approval_ref`, `intent_id`, `expected_version`, `not_before`, `admission` ("" | authorized | pending), `reservation_id`, `expected_plan_hash`, `expected_closure_digest`, `expected_runner_digest`. Execute job: `inputs.mode == 'execute' && github.ref == 'refs/heads/main'`, environment `e7-readonly-probe` (required reviewer), concurrency `e7-hosted-reservation`, tooling checkout `40779e34`.
`e7-hosted-capture.yml`: `mode`, `approval_ref`, `intent_id`, `expected_version`, `not_before`, `payment_intent_id`, `reservation_id`, `amount_minor`, `expected_plan_hash`, `expected_closure_digest`, `expected_runner_digest`. Same gates; concurrency `e7-hosted-capture`; tooling checkout `59178b04`.

### 2.2 Flag / test-only ENABLE diff proposal (NOT implemented here) — reservation + capture ONLY
| File | Change |
|---|---|
| `scripts/e7-hosted-reservation.mjs` | `CONSTANTS.executeEnabled: false → true` (comment: ONE reviewed C3 validation) |
| `scripts/e7-hosted-capture.mjs` | same |
| `test/e7-hosted-reservation.test.mjs`, `test/e7-hosted-capture.test.mjs` | C1 + preflight-result positive expectations → `true`; the existing test-local `CLOSED = { ...C, executeEnabled: false }` controls keep the `H*_EXECUTE_CLOSED` refusals exercised |
| `test/e7-hosted-test-cleanup.test.mjs`, `test/e7-hosted-recording.test.mjs`, `test/e7-hosted-recorded-cleanup.test.mjs` | cross-assertions on Slices 1/2 → `true`; **own flags stay `false`** (Slice 3 is NOT enabled: policy) |
| `test/e7-hosted-integrated-rehearsal.test.mjs` | R0 shipped flags → `[true, true, false, false, false]` |
Untouched: workflows, secrets, `e7-readonly-probe`, concurrency, closures, pins, admission, budgets. Consequence: runner digests of all five change (shared reservation runner + test files); ROOT re-pins `expected_runner_digest` from the merged enable commit. The CLOSE diff is the exact reverse (as PR #82 was), prepared after the validation, docs retained.

### 2.3 Fresh preflight → GO bindings (ROOT drives; Claude prepares input sheets only from ROOT's SELECT output)
For each session: (a) **fresh proof** = ROOT pure SELECT (§3) ≤ 10 min before dispatch; (b) `mode=preflight` with REAL inputs → `planHash`, `closureDigest`, `runnerDigest` in the run log; ROOT compares `closureDigest` with the pins above and `runnerDigest` with the merged-enable-commit values; (c) `mode=execute` with identical inputs + the three `expected_*` → `H*_PLAN_HASH_MISMATCH` / `SOURCE_MISMATCH` / `RUNNER_MISMATCH` refuse any drift; the required reviewer approves the job. `expectedVersion` = version from the fresh proof; `notBefore` = intent `created_at` − 1 min (ISO UTC); `approvalRef` = ROOT label, never the synthetic one.

### 2.4 Expected outcomes
- **S1-A (authorized):** ref echoed → `RESERVATION_CONFIRMED_INTERMEDIATE` (`reservation_confirmed`, capture op pristine) → S2. Ref NOT echoed (observed live) → `STEP_BUDGET_EXHAUSTED` at `reservation_pending`, `createOps=["succeeded"]`, `result_ref` = R, actions incl. `CREATE_REF_NOT_ECHOED:READS_REQUIRED` — EXPECTED; → wait until the worker's own `intent_work.next_action_at` (ROOT SELECT), then **S1-B (pending; same bound id, pinned R, fresh version)** → `RESERVATION_CONFIRMED_INTERMEDIATE`, `createInvocations 0`. Never a second create.
- **S2 (capture @ 59178b04):** ONE `POST /v1/payment_intents/<pi>/capture` with body `amount_to_capture=<total>&expand[]=latest_charge`, key `cap:<intent>:<pi>` → `PAYMENT_CAPTURED_INTERMEDIATE`, `payment_captured`, `captured_minor` = total, capture op `succeeded/1` (`result_ref` = `ch_…`), recording op queued pristine (never dispatched: Slice 4 `false`). Stripe TEST: PI `succeeded`, charge captured. **This is the validation target.**
- **End state of a SUCCESSFUL validation:** intent `payment_captured`; Hostaway reservation R active (not cancelled by any runner); Stripe TEST charge CAPTURED, NOT refunded; DB claim HELD. **Closure statement for the checkpoint: "TEST capture validated; funds captured on the TEST account and awaiting manual, policy-assessed disposition by the owner; reservation R active pending the owner's decision; no financial obligation is settled by this test."** Never report "all obligations settled".
- Any Class-P/Class-E outcome (proposal v3 §6 rules): STOP; read-only reconciliation; human-owned decisions; no hosted rerun.

## 3. ROOT pure-SELECT artifacts (ROOT runs them, Claude never does) — rev2 per review 5897051037
Parameters: `__T0__` (UTC ISO recorded immediately before O1), `__T0_IDS__` (the exact `intent_ids` JSON array returned by C3-A at T0 — the **authority** for the baseline set), `__INTENT__` (the `accepted_id` returned by C3-B — the only way a target is ever bound). All three are single read-only statements. Every row is hashed whole (`md5(row::text)`); no guest/contact field is ever output. The artifacts are generated from the catalog (`/tmp/reh/c3/gen.mjs`) and were validated with controls on a disposable schema-21 database at 59178b04 (§3.4). ROOT's own records (not this packet) say what T0 will hold; the expectation below is SEVEN intents (six historical + the stopped `c83c1842…`), but **the T0 `intent_ids` set as returned is the authority**, and every later statement is checked against that set, never against a remembered count.

### 3.1 C3-A — fingerprint snapshot (run at T0 and again at the END, identical statement)
Coverage: the full `booking.intents` row **and** row count + whole-row digest for **every catalog table carrying `intent_id`** at schema 0021 — 22 tables: external_operations, hostaway_reservation_attempts, intent_applied_events, intent_guests, intent_transitions, intent_work, inventory_claims, notification_latches, notification_renders, notification_suppressions, payment_attempts, payment_ledger, payment_refunds, provider_evidence, reconciliation_cases, reconciliation_resolutions, recording_assessments, recording_claim_assessments, recording_conflict_inbox, recording_hold_decisions, recording_holds, stripe_webhook_events. The statement re-reads the catalog and returns `child_catalog_matches`; if it is `false` the artifact is stale against the live schema → STOP (nothing is accepted from a partial fingerprint). Global non-intent tables are fingerprinted whole (api_rate_limits, definite_refusal_codes, instance, notification_write_authority, recording_assessment_codes, recording_hold_observations, booking_migrations.applied), plus quiescence (work / intent / op leases, in-flight ops, open cases, advisory locks, prepared transactions), HELD claims, migrations n/min/max and the 0021 vocabulary objects.
```sql
-- C3-A  FINGERPRINT SNAPSHOT (pure SELECT; run at T0 and again at the END with the same statement). Hashes FULL rows (md5 of row text) — never
-- outputs guest / contact fields. Per intent: the full booking.intents row + row count and whole-row digest for EVERY catalog child table that
-- carries intent_id (22 at schema 0021; 'child_catalog_matches' must be true or the artifact is stale → STOP). Plus global (non-intent) tables,
-- quiescence, held claims, migrations, 0021 vocabulary objects.
SELECT json_build_object(
  'schema', 'e7-c3-snapshot-v2',
  'child_tables_catalog', (SELECT json_agg(table_name ORDER BY table_name) FROM information_schema.columns WHERE table_schema = 'booking' AND column_name = 'intent_id'),
  'child_tables_hashed', '["external_operations","hostaway_reservation_attempts","intent_applied_events","intent_guests","intent_transitions","intent_work","inventory_claims","notification_latches","notification_renders","notification_suppressions","payment_attempts","payment_ledger","payment_refunds","provider_evidence","reconciliation_cases","reconciliation_resolutions","recording_assessments","recording_claim_assessments","recording_conflict_inbox","recording_hold_decisions","recording_holds","stripe_webhook_events"]'::json,
  'child_catalog_matches', ((SELECT jsonb_agg(table_name ORDER BY table_name) FROM information_schema.columns WHERE table_schema = 'booking' AND column_name = 'intent_id') = '["external_operations","hostaway_reservation_attempts","intent_applied_events","intent_guests","intent_transitions","intent_work","inventory_claims","notification_latches","notification_renders","notification_suppressions","payment_attempts","payment_ledger","payment_refunds","provider_evidence","reconciliation_cases","reconciliation_resolutions","recording_assessments","recording_claim_assessments","recording_conflict_inbox","recording_hold_decisions","recording_holds","stripe_webhook_events"]'::jsonb),
  'intent_ids', (SELECT json_agg(id ORDER BY id) FROM booking.intents),
  'intent_count', (SELECT count(*) FROM booking.intents),
  'intents', (SELECT json_agg(json_build_object('id', i.id, 'state', i.state, 'version', i.version, 'row_fp', md5(i::text), 'children',
        json_build_object(
          'external_operations', (SELECT json_build_object('n', count(*), 'fp', md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), ''))) FROM booking.external_operations x WHERE x.intent_id = i.id),
          'hostaway_reservation_attempts', (SELECT json_build_object('n', count(*), 'fp', md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), ''))) FROM booking.hostaway_reservation_attempts x WHERE x.intent_id = i.id),
          'intent_applied_events', (SELECT json_build_object('n', count(*), 'fp', md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), ''))) FROM booking.intent_applied_events x WHERE x.intent_id = i.id),
          'intent_guests', (SELECT json_build_object('n', count(*), 'fp', md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), ''))) FROM booking.intent_guests x WHERE x.intent_id = i.id),
          'intent_transitions', (SELECT json_build_object('n', count(*), 'fp', md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), ''))) FROM booking.intent_transitions x WHERE x.intent_id = i.id),
          'intent_work', (SELECT json_build_object('n', count(*), 'fp', md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), ''))) FROM booking.intent_work x WHERE x.intent_id = i.id),
          'inventory_claims', (SELECT json_build_object('n', count(*), 'fp', md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), ''))) FROM booking.inventory_claims x WHERE x.intent_id = i.id),
          'notification_latches', (SELECT json_build_object('n', count(*), 'fp', md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), ''))) FROM booking.notification_latches x WHERE x.intent_id = i.id),
          'notification_renders', (SELECT json_build_object('n', count(*), 'fp', md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), ''))) FROM booking.notification_renders x WHERE x.intent_id = i.id),
          'notification_suppressions', (SELECT json_build_object('n', count(*), 'fp', md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), ''))) FROM booking.notification_suppressions x WHERE x.intent_id = i.id),
          'payment_attempts', (SELECT json_build_object('n', count(*), 'fp', md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), ''))) FROM booking.payment_attempts x WHERE x.intent_id = i.id),
          'payment_ledger', (SELECT json_build_object('n', count(*), 'fp', md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), ''))) FROM booking.payment_ledger x WHERE x.intent_id = i.id),
          'payment_refunds', (SELECT json_build_object('n', count(*), 'fp', md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), ''))) FROM booking.payment_refunds x WHERE x.intent_id = i.id),
          'provider_evidence', (SELECT json_build_object('n', count(*), 'fp', md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), ''))) FROM booking.provider_evidence x WHERE x.intent_id = i.id),
          'reconciliation_cases', (SELECT json_build_object('n', count(*), 'fp', md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), ''))) FROM booking.reconciliation_cases x WHERE x.intent_id = i.id),
          'reconciliation_resolutions', (SELECT json_build_object('n', count(*), 'fp', md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), ''))) FROM booking.reconciliation_resolutions x WHERE x.intent_id = i.id),
          'recording_assessments', (SELECT json_build_object('n', count(*), 'fp', md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), ''))) FROM booking.recording_assessments x WHERE x.intent_id = i.id),
          'recording_claim_assessments', (SELECT json_build_object('n', count(*), 'fp', md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), ''))) FROM booking.recording_claim_assessments x WHERE x.intent_id = i.id),
          'recording_conflict_inbox', (SELECT json_build_object('n', count(*), 'fp', md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), ''))) FROM booking.recording_conflict_inbox x WHERE x.intent_id = i.id),
          'recording_hold_decisions', (SELECT json_build_object('n', count(*), 'fp', md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), ''))) FROM booking.recording_hold_decisions x WHERE x.intent_id = i.id),
          'recording_holds', (SELECT json_build_object('n', count(*), 'fp', md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), ''))) FROM booking.recording_holds x WHERE x.intent_id = i.id),
          'stripe_webhook_events', (SELECT json_build_object('n', count(*), 'fp', md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), ''))) FROM booking.stripe_webhook_events x WHERE x.intent_id = i.id))) ORDER BY i.id) FROM booking.intents i),
  'global', json_build_object(
    'booking.api_rate_limits', (SELECT json_build_object('n', count(*), 'fp', md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), ''))) FROM booking.api_rate_limits x),
    'booking.definite_refusal_codes', (SELECT json_build_object('n', count(*), 'fp', md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), ''))) FROM booking.definite_refusal_codes x),
    'booking.instance', (SELECT json_build_object('n', count(*), 'fp', md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), ''))) FROM booking.instance x),
    'booking.notification_write_authority', (SELECT json_build_object('n', count(*), 'fp', md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), ''))) FROM booking.notification_write_authority x),
    'booking.recording_assessment_codes', (SELECT json_build_object('n', count(*), 'fp', md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), ''))) FROM booking.recording_assessment_codes x),
    'booking.recording_hold_observations', (SELECT json_build_object('n', count(*), 'fp', md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), ''))) FROM booking.recording_hold_observations x),
    'booking_migrations.applied', (SELECT json_build_object('n', count(*), 'fp', md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), ''))) FROM booking_migrations.applied x)),
  'leases', json_build_object('work', (SELECT count(*) FROM booking.intent_work WHERE work_worker_id IS NOT NULL), 'intent', (SELECT count(*) FROM booking.intents WHERE lease_worker_id IS NOT NULL),
                             'op', (SELECT count(*) FROM booking.external_operations WHERE lease_worker_id IS NOT NULL), 'in_flight_ops', (SELECT count(*) FROM booking.external_operations WHERE state = 'in_flight')),
  'open_cases', (SELECT count(*) FROM booking.reconciliation_cases WHERE status = 'open'),
  'held_claims', (SELECT coalesce(json_agg(json_build_object('intent', c.intent_id, 'listing', c.listing_id, 'stay', c.stay::text, 'kind', c.kind) ORDER BY c.id), '[]'::json) FROM booking.inventory_claims c WHERE c.released_at IS NULL),
  'advisory_locks', (SELECT count(*) FROM pg_locks WHERE locktype = 'advisory'),
  'prepared_tx', (SELECT count(*) FROM pg_prepared_xacts),
  'migrations', (SELECT json_build_object('n', count(*), 'min', min(version), 'max', max(version)) FROM booking_migrations.applied),
  'vocabulary_objects', (SELECT (to_regclass('booking.notification_suppressions') IS NOT NULL)::int + (EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'booking' AND table_name = 'intents' AND column_name = 'settlement_recording_mirrored'))::int),
  'db_now', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) AS snapshot;
```
**Acceptance at T0:** `child_catalog_matches=true`; `intent_count` = length of `intent_ids` (expected 7; ROOT confirms against its records, the returned set is recorded verbatim as `__T0_IDS__`); `held_claims` contains the Nov 21–22 claim of `c83c1842…` on 606998 and nothing unexpected; `leases` all 0, `in_flight_ops` 0, `advisory_locks` 0, `prepared_tx` 0; `migrations` = {n 21, min 1, max 21}; `vocabulary_objects` = 2.
**Acceptance at END (same statement):** `intent_ids` = `__T0_IDS__` ∪ {`__INTENT__`} **exactly** (set equality; any missing, replaced or extra id → STOP); for every id in `__T0_IDS__` the `row_fp` and every one of the 22 `children[table].{n,fp}` entries byte-identical to T0; `global` identical for every table **except** `booking.api_rate_limits` (the only allowed global delta: counters/windows); `migrations` and `vocabulary_objects` unchanged; `held_claims` = T0 set + the target's claim; leases / in-flight / locks / prepared 0; `open_cases` = T0 value (the target opens none on success).
**Allowed deltas for the NEW target only (anything else → STOP):** intents row (state → `payment_captured`, version advances, `captured_minor` = total, timestamps/attempt counters); intent_work (next_action_at); intent_transitions (append only: created → … → `reservation_confirmed` → `payment_captured`); intent_guests (checkout); payment_attempts (one row); payment_ledger (`authorization_accepted`, `capture_succeeded`); external_operations (create-reservation op `succeeded`, capture op `succeeded`/attempts 1/`result_ref`, recording op queued `pending`/0, never dispatched); hostaway_reservation_attempts (create attempt rows); inventory_claims (one HELD claim); stripe_webhook_events (TEST events for the target's PI, `processed`); provider_evidence / intent_applied_events as the workers write them for this id. **Never allowed for the target:** payment_refunds, reconciliation_cases (open), recording_*, notification_* rows, any release of its claim.

### 3.2 C3-B — discovery of the ONE accepted new TEST intent (exact set difference)
```sql
-- C3-B  DISCOVERY of the ONE accepted new TEST intent = exact set difference against the T0 id set (ROOT pastes the T0 'intent_ids' array),
-- bounded to listing 606998 / environment test / created_at >= T0. 'accept' is true ONLY when exactly one id is new AND it satisfies the bound;
-- any other cardinality (0, >1) or an out-of-bound new id → accept=false → STOP (never pick a row).
WITH t0 AS (SELECT jsonb_array_elements_text('__T0_IDS__'::jsonb)::uuid AS id),
new_ids AS (SELECT i.id FROM booking.intents i WHERE NOT EXISTS (SELECT 1 FROM t0 WHERE t0.id = i.id)),
missing AS (SELECT t0.id FROM t0 WHERE NOT EXISTS (SELECT 1 FROM booking.intents i WHERE i.id = t0.id)),
bound AS (SELECT n.id FROM new_ids n JOIN booking.intents i ON i.id = n.id WHERE i.listing_id = 606998 AND i.environment = 'test' AND i.created_at >= '__T0__'::timestamptz)
SELECT json_build_object(
  'schema', 'e7-c3-discovery-v2',
  't0_count', (SELECT count(*) FROM t0),
  'current_count', (SELECT count(*) FROM booking.intents),
  'new_ids', (SELECT coalesce(json_agg(id ORDER BY id), '[]'::json) FROM new_ids),
  'missing_t0_ids', (SELECT coalesce(json_agg(id ORDER BY id), '[]'::json) FROM missing),
  'new_in_bound', (SELECT coalesce(json_agg(id ORDER BY id), '[]'::json) FROM bound),
  'accept', ((SELECT count(*) FROM new_ids) = 1 AND (SELECT count(*) FROM bound) = 1 AND (SELECT count(*) FROM missing) = 0),
  'accepted_id', (SELECT CASE WHEN (SELECT count(*) FROM new_ids) = 1 AND (SELECT count(*) FROM bound) = 1 AND (SELECT count(*) FROM missing) = 0 THEN (SELECT id FROM bound) END),
  'db_now', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) AS discovery;
```
`accept=true` ⇔ exactly one id not in `__T0_IDS__` **and** that id is bound (listing 606998, `environment='test'`, `created_at ≥ __T0__`) **and** no T0 id is missing. Cardinality 0 (nothing created yet), 2+ (unexpected added id), an out-of-bound new id, or a missing/replaced T0 id ⇒ `accept=false`, `accepted_id=null` ⇒ STOP — a target is never picked by hand from a list. `accepted_id` becomes `__INTENT__` for every later statement and for the workflow `intent_id` input.

### 3.3 C3-C — bound proof / readback of `__INTENT__` (R1 before S1-A, before S1-B, before S2, and END)
```sql
-- C3-C  BOUND PROOF / READBACK of the accepted target __INTENT__ (ROOT pastes the accepted_id from C3-B and the T0 'intent_ids' array).
-- Re-proves the global id-set rule on every run: current ids must equal T0 ids ∪ {__INTENT__} exactly ('binding_ok'), else STOP.
-- Admission evidence: state/version/reason, stay, amounts, PI identity, STORED captureBefore / authorizationDeadline, reservation id, claim,
-- leases (work / intent / op), open cases, suppressions, completed webhook event status, operations with idempotency key / attempts /
-- dispatch / result / lease. No guest fields.
WITH t0 AS (SELECT jsonb_array_elements_text('__T0_IDS__'::jsonb)::uuid AS id),
cur AS (SELECT id FROM booking.intents),
one AS (SELECT * FROM booking.intents WHERE id = '__INTENT__'::uuid)
SELECT json_build_object(
  'schema', 'e7-c3-bound-proof-v2',
  'intent', '__INTENT__',
  'binding_ok', ((SELECT count(*) FROM one) = 1
                 AND NOT EXISTS (SELECT 1 FROM t0 WHERE t0.id = '__INTENT__'::uuid)
                 AND NOT EXISTS (SELECT 1 FROM cur WHERE cur.id <> '__INTENT__'::uuid AND NOT EXISTS (SELECT 1 FROM t0 WHERE t0.id = cur.id))
                 AND NOT EXISTS (SELECT 1 FROM t0 WHERE NOT EXISTS (SELECT 1 FROM cur WHERE cur.id = t0.id))),
  'target', (SELECT json_build_object(
     'ref', one.ref, 'environment', one.environment, 'state', one.state, 'version', one.version, 'reason', one.reason_code,
     'listingId', one.listing_id, 'arrival', to_char(one.from_date, 'YYYY-MM-DD'), 'departure', to_char(one.to_date, 'YYYY-MM-DD'), 'guests', one.guests,
     'currency', one.currency, 'finalTotalMinor', one.final_total_minor, 'authorizedMinor', one.authorized_minor, 'capturedMinor', one.captured_minor,
     'paymentIntentId', one.stripe_payment_intent_id, 'livemode', one.payment_livemode, 'checkoutSessionId', one.checkout_session_id,
     'createdAt', to_char(one.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
     'captureBefore', to_char(one.capture_before AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
     'authorizationDeadline', to_char(one.authorization_deadline AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
     'reservationId', one.hostaway_reservation_id, 'offlineChargeId', one.offline_charge_id,
     'settlement', json_build_object('cancelled', one.settlement_reservation_cancelled, 'settled', one.settlement_authorization_settled, 'mirrored', one.settlement_recording_mirrored),
     'intentLease', one.lease_worker_id IS NOT NULL,
     'work', (SELECT json_build_object('nextActionAt', to_char(w.next_action_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'leased', w.work_worker_id IS NOT NULL) FROM booking.intent_work w WHERE w.intent_id = one.id),
     'attempts', (SELECT coalesce(json_agg(json_build_object('id', a.id, 'attempt', a.attempt, 'status', a.status, 'pi', a.payment_intent_id, 'livemode', a.livemode) ORDER BY a.attempt), '[]'::json) FROM booking.payment_attempts a WHERE a.intent_id = one.id),
     'claims', (SELECT coalesce(json_agg(json_build_object('stay', c.stay::text, 'kind', c.kind, 'released', c.released_at IS NOT NULL) ORDER BY c.id), '[]'::json) FROM booking.inventory_claims c WHERE c.intent_id = one.id),
     'ops', (SELECT coalesce(json_agg(json_build_object('type', o.op_type, 'state', o.state, 'key', o.idempotency_key, 'attempts', o.attempts, 'dispatched', o.dispatched_at IS NOT NULL,
                 'completed', o.completed_at IS NOT NULL, 'leased', o.lease_worker_id IS NOT NULL, 'resultRef', o.result_ref, 'error', o.error_code) ORDER BY o.id), '[]'::json) FROM booking.external_operations o WHERE o.intent_id = one.id),
     'webhooks', (SELECT coalesce(json_agg(json_build_object('type', e.event_type, 'status', e.status, 'attempts', e.attempts, 'livemode', e.livemode, 'error', e.error_code) ORDER BY e.received_at), '[]'::json) FROM booking.stripe_webhook_events e WHERE e.intent_id = one.id),
     'ledger', (SELECT coalesce(json_agg(l.entry ORDER BY l.id), '[]'::json) FROM booking.payment_ledger l WHERE l.intent_id = one.id),
     'refunds', (SELECT count(*) FROM booking.payment_refunds r WHERE r.intent_id = one.id),
     'openCases', (SELECT count(*) FROM booking.reconciliation_cases r WHERE r.intent_id = one.id AND r.status = 'open'),
     'suppressions', (SELECT count(*) FROM booking.notification_suppressions s WHERE s.intent_id = one.id),
     'hostawayAttempts', (SELECT count(*) FROM booking.hostaway_reservation_attempts h WHERE h.intent_id = one.id),
     'transitions', (SELECT coalesce(json_agg(t.to_state ORDER BY t.at, t.id), '[]'::json) FROM booking.intent_transitions t WHERE t.intent_id = one.id)) FROM one),
  'db_now', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) AS proof;
```
Every run re-proves the global id-set rule (`binding_ok`: `__INTENT__` exists, is not in `__T0_IDS__`, and current ids = `__T0_IDS__` ∪ {`__INTENT__`}); `binding_ok=false` ⇒ STOP regardless of what the target looks like. Session gates read from `target`: **R1** state `payment_authorized`, `authorizedMinor` = `finalTotalMinor`, `paymentIntentId` = `pi_…` (TEST, `livemode=false`), stored `captureBefore` / `authorizationDeadline` present (the capture runner's deadline check binds to the stored values, never to a provider-side inference), `intentLease=false`, `work.leased=false`, `openCases=0`, `suppressions=0`, `refunds=0`, `webhooks` all `processed` (any `received`/`failed_retryable` ⇒ not quiescent ⇒ wait, then re-run; never proceed), `ops` = create-reservation op `pending`/attempts 0/`dispatched=false`. **Before S1-B:** state `reservation_pending`, create op `succeeded`/1/`resultRef` = R, `reservationId` = R, `work.nextActionAt` ≤ now. **Before S2:** state `reservation_confirmed`, `reservationId` = R, capture op `pending`/0/`dispatched=false`/`key` = `cap:<intent>:<pi>`, `capturedMinor` 0, one HELD claim. **END:** `payment_captured`, `capturedMinor` = `finalTotalMinor`, capture op `succeeded`/1/`dispatched=true`/`completed=true`/`resultRef` carrying `ch_…`, recording op `pending`/0 never dispatched, `ledger` ends with `capture_succeeded`, `refunds=0`, `openCases=0`, claim HELD (`released=false`), no lease anywhere. `expectedVersion` for each dispatch = `target.version` from the proof run ≤ 10 min before.

**Provider readback (ROOT, read-only dashboards; END and on any unknown outcome):** Stripe TEST PI — `status`, `amount`, **`amount_received`**, **`amount_capturable`**, and on `latest_charge`: **`captured`**, **`refunded`**, `amount_refunded`, `amount_captured`. Success = PI `succeeded`, `amount_received` = total, `amount_capturable` = 0, charge `captured=true`, `refunded=false`. The capture state is **never inferred from `requires_capture` alone**: `requires_capture` with `amount_received=0` and charge `captured=false` is the only reading that means "nothing captured"; any other combination is read as-is and recorded verbatim. Stripe Developers → Logs: exactly one `POST …/capture` 200 for the PI (body without `final_capture`). Hostaway: R status active with the ref in custom field 105433.

### 3.4 Validation of the three statements on a disposable schema-21 database (controls; no shared/live query)
Harness: `startMigratedDatabase()` from `test/db/harness.mjs` at tooling pin `59178b04` (migrations 0001..0021, owner role), Node 22.22.0, PG 16. Script `/tmp/reh/c3/validate.mjs` (sha256 `8eb12bdc869a0acf…`); artifacts `c3-a-snapshot.sql` `f15418d87d06c753…`, `c3-b-discovery.sql` `e18de34d5a9b6cb0…`, `c3-c-bound-proof.sql` `17a9da6383b76ccc…` (identical to the blocks above). Seeding of synthetic rows uses `ALTER TABLE … DISABLE TRIGGER USER` on the disposable DB only (same technique as `test/db/e7-claim-release-0017.test.mjs`); the statements under test are pure SELECT and unaffected. Seven pre-existing intents were planted (each with intent_work, a processed webhook event, an open reconciliation case, a pending capture op, a ledger row), then the controls ROOT asked for:
| Control | Result |
|---|---|
| Catalog | `child_catalog_matches=true`, 22 child tables |
| Baseline | 7 ids at T0; discovery with nothing new → `accept=false` (cardinality 0 rejected) |
| **1. Foreign mutation in a previously omitted table changes the fingerprint** | UPDATE of a foreign intent's `stripe_webhook_events` row (`status`, `attempts`) → that intent's webhook `fp` changed `d2d9989b→6c799e84` and the foreign-set digest changed, while its `intents` `row_fp` stayed equal (the old intents-only fingerprint would have missed it); same for a `reconciliation_cases` resolve; after reverting both, the whole foreign fingerprint set returned byte-identical to T0 |
| **2. Unexpected added id is rejected** | one new bound intent → `accept=true`, `accepted_id` = it; a second new intent → `accept=false`, `new_ids` length 2, `accepted_id=null`; C3-C bound to the first target with the second present → `binding_ok=false`; a new id with `created_at` < T0 → `accept=false`, `new_in_bound` empty |
| **3. Legitimate target changes leave foreign fingerprints identical** | target → `payment_captured`, version +1, `captured_minor` = total, capture op `succeeded`/1/dispatched/completed/`result_ref`, transition + ledger appended → target `row_fp` changed; the foreign-set digest was identical at T0 / before / after; `intent_ids` = T0 ∪ {target}; every global table fingerprint identical (api_rate_limits is the only allowed delta); migrations {21,1,21}, `vocabulary_objects` 2 |
| **4. Incorrect target binding rejected** | C3-C bound to a T0 id → `binding_ok=false`; bound to an absent uuid → `binding_ok=false`, `target=null`; correct binding → `binding_ok=true` with `capturedMinor`, op key/state, webhook status, stored `captureBefore` read back |
| Missing / replaced T0 id | deleting a T0 intent → discovery `accept=false`, `missing_t0_ids` 1; bound proof `binding_ok=false` |
Exact script output (16/16):
```
PASS  catalog  child_catalog_matches=true tables=22
PASS  baseline-seven  intent_count=7
PASS  discovery-zero-rejected  accept=false new=0
PASS  control-1a-webhook-mutation-detected  webhook fp d2d9989b→6c799e84; intents row_fp unchanged=true
PASS  control-1b-case-mutation-detected  case fp changed; webhook fp restored-equal
PASS  control-1c-restored-equal  foreign fingerprint set restored to T0 (43db8eedaf1e05eb)
PASS  discovery-one-accepted  accept=true accepted=00000000-0000-4000-8000-000000000008
PASS  control-2a-extra-id-rejected  accept=false new=["00000000-0000-4000-8000-000000000008","00000000-0000-4000-8000-000000000009"]
PASS  control-2b-bound-proof-rejects-extra-id  binding_ok=false (current ≠ T0 ∪ {target})
PASS  control-2c-out-of-bound-new-id-rejected  accept=false new_in_bound=0
PASS  control-3-target-changes-foreign-identical  target row_fp changed=true; foreign set digest 43db8eedaf1e05eb identical at T0/before/after; id set = T0 ∪ {target}
PASS  global-non-intent-unchanged  global tables identical except allowed api_rate_limits: true; migrations={"n":21,"min":1,"max":21} vocabulary_objects=2
PASS  bound-proof-correct-accepted  binding_ok=true capturedMinor=14000 op.key=cap:00000000-0000-4000-8000-000000000008 op.state=succeeded webhook=processed captureBefore=2026-11-20T00:00:00.000Z
PASS  control-4a-bind-to-T0-id-rejected  binding_ok=false (id is in T0 set)
PASS  control-4b-bind-to-absent-id-rejected  binding_ok=false target=null
PASS  control-missing-T0-id-rejected  discovery accept=false missing=1; bound-proof binding_ok=false

SUMMARY 16 / 16 pass
```

## 4. Blockers, STOP handoffs and the HELD claim
- **Never the old intent.** `c83c1842-d342-4e27-9ab7-dc3d50b7a309` (`capture_unknown` v8, PI `pi_3UbO8K…` `requires_capture`, HELD claim `[2026-11-21,2026-11-22)` on 606998) is excluded from every input; no repair, no claim release, no retry; it is one of the SEVEN T0 intents (six historical + this one), part of `__T0_IDS__`, and its `row_fp` and all 22 child fingerprints must stay byte-identical from T0 to END.
- **Stay selection for the NEW intent:** chosen only from fresh evidence at T0 — ROOT reads the HELD claims (C3-A) and the owner picks a 1-night stay ≥ 7 days out that does NOT overlap any held claim; the quoted total is read on the page at T0 and must be ≤ USD 140.00; availability/price are never assumed from this document.
- **Pre-T0 ROOT read-only refresh required (stale/unknown facts — not inferred):** (a) e7-test alias → deployment `dpl_…` / sha (last confirmed `dpl_7V17jjpM…` @ 63adbc59; e7-test has since advanced to `59178b04` — a new Preview deployment is likely; the served checkout surface delta 63adbc59→59178b04 is the C1 files only, which the checkout API does not call, but the identity must be read, not assumed); (b) env NAMES/targets (STRIPE_TEST_SECRET_KEY, STRIPE_TEST_WEBHOOK_SECRET, BOOKING_DATABASE_URL (C2-rotated), MV_CHECKOUT_* flags, STRIPE_TEST_ACCOUNT_ID) — values never read; (c) Stripe webhook endpoint = the alias `/api/checkout/stripe-webhook`, enabled; (d) Hostaway token validity and listing 606998 still disconnected / Draft; (e) GitHub `e7-readonly-probe` reviewers ON, deployment branch main, admin bypass OFF, no queued/in-progress e7 runs; (f) protection exception for the alias still present.
- **Outcome classes (corrected):**
  - **Class P (provably pre-effect):** a refusal or stop that occurred **before any provider write could have been sent** and is proven so by complete unchanged evidence — C3-C `target` unchanged (same version, every op still `pending`/attempts 0/`dispatched=false`, no lease, no new webhook events), C3-A foreign fingerprints identical, and the run log showing the refusal at a gate (`H*_PLAN_HASH_MISMATCH`, `SOURCE_MISMATCH`, `RUNNER_MISMATCH`, `EXECUTE_CLOSED`, preflight-only, lock not acquired before dispatch, deadline check before dispatch). For Class P a **correction + fresh preflight + fresh C3-B/C3-C proof remains possible** within the same validation, as a new reviewed GO (new `expectedVersion`, re-read pins); it is not a rerun of a spent package. Default when evidence is incomplete: Class E.
  - **Class E (effect possible or observed):** anything after a dispatch may have happened — `CAPTURE_OUTCOME_UNKNOWN` / `CAPTURE_CALL_FAILED`, create unknown/failed, `STEP_BUDGET_EXHAUSTED` after a provider call, lease observed, any state the proofs cannot explain, any foreign-intent or global drift. **Always STOP; never a hosted rerun; no automation.** Handoff: S1 create unknown/failed → read-only reconciliation by ref 105433; if a reservation exists, owner cancel in Hostaway as a reviewed action; the TEST authorization is left as observed (no void). S1-B still pending after ONE session → STOP. S2 unknown → ROOT provider readback (§3.3: PI `status`, `amount_received`, `amount_capturable`, charge `captured`/`refunded`): captured ⇒ §5 disposition; provably nothing captured ⇒ authorization observed only, left as is. Any foreign intent, lease, missing/replaced id or cardinality drift ⇒ STOP everything.
- **What the runners never do here:** record an offline charge, mirror, notify, cancel a reservation, refund, void. Slice 4 / 5 remain `false`; Slice 3 remains `false` and HELD.

## 5. Reservation cancellation ≠ payment disposition (explicit)
- A Hostaway reservation cancellation (by the owner, or by any future reviewed step) carries **no authority** over the Stripe payment. The payment's disposition — leave captured, refund in full, refund in part, or (for an uncaptured authorization) let the provider's own handling run — is a **manual, cancellation-policy-assessed owner decision**, executed as a reviewed action naming identity (intent id, R, `pi_`, `ch_`) and the observed Stripe state, in the Stripe TEST dashboard. No hosted runner, worker or script performs it; the Slice 3 / Slice 5 request → cancel → refund code is historical/HELD and is not reopened by this packet.
- After a successful validation the TEST funds **remain captured** until that decision; the checkpoint records "captured, awaiting manual disposition", never "settled". Any later disposition is recorded as its own owner-reported, provider-observed event (DB rows untouched unless a separately reviewed path exists for recording it).
- Existing reconciliation cases, journals, transitions and operation history are preserved as evidence throughout; no DB repair.

## 6. Remaining decisions for ROOT (nothing proceeds without them)
1. Approve this packet as the validation scope (reservation + capture only; stop at `payment_captured`).
2. Authorize the ENABLE DRAFT PR (§2.2; Slices 1 + 2 only) for review; then re-pin `expected_runner_digest` from the merged commit.
3. Complete the pre-T0 read-only refresh (§4) and the T0 baseline (C3-A); record `__T0__` and the returned `intent_ids` verbatim as `__T0_IDS__`.
4. Lift the quote/Pay hold for exactly ONE owner DEV checkout; set T0; request Joel's presence only then.
5. Decide how the eventual manual disposition of the captured TEST funds (and of the still-open `pi_3UbO8K…` authorization) will be reviewed and recorded — outside this packet.
