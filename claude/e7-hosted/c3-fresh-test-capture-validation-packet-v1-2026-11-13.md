# C3 — FRESH TEST CAPTURE VALIDATION PACKET v1 (source-only; for ROOT review)
2026-11-13 · Claude executor · doc-only. Both SQL artifacts in §3 were syntax-checked (owner role) against a disposable schema-21 database at 59178b04 (no shared query). Works from merged main `2920959542087cf9dd744c0e9e30b6626df061fc` (tree `e968f845…`) and tooling `59178b0468469b6570beab861bbc8e48b3a887d1` (e7-test, PR #84). Nothing here is implemented, enabled, dispatched or queried; no owner action or approval is requested by this document.

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

## 3. ROOT pure-SELECT artifacts (narrow; ROOT runs them, Claude never does)
Parameters: `__T0__` (UTC ISO recorded immediately before O1), `__INTENT__` once known. All read-only, single statements, no guest data beyond what identity needs (ref, ids, amounts, dates).

### 3.1 T0 baseline (before O1) — foreign fingerprints + quiescence
```sql
-- C3-A  baseline: every existing intent (expect SIX ids) with a full-row + all-children fingerprint, plus quiescence
WITH ids AS (SELECT id FROM booking.intents),
fp AS (
  SELECT i.id,
         md5(i::text) AS intents_fp,
         (SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) FROM booking.intent_transitions t WHERE t.intent_id = i.id) AS transitions_fp,
         (SELECT md5(coalesce(string_agg(o::text, '|' ORDER BY o::text), '')) FROM booking.external_operations o WHERE o.intent_id = i.id) AS ops_fp,
         (SELECT md5(coalesce(string_agg(c::text, '|' ORDER BY c::text), '')) FROM booking.inventory_claims c WHERE c.intent_id = i.id) AS claims_fp,
         (SELECT md5(coalesce(string_agg(p::text, '|' ORDER BY p::text), '')) FROM booking.payment_attempts p WHERE p.intent_id = i.id) AS attempts_fp,
         (SELECT md5(coalesce(string_agg(l::text, '|' ORDER BY l::text), '')) FROM booking.payment_ledger l WHERE l.intent_id = i.id) AS ledger_fp,
         (SELECT md5(coalesce(string_agg(r::text, '|' ORDER BY r::text), '')) FROM booking.payment_refunds r WHERE r.intent_id = i.id) AS refunds_fp,
         (SELECT md5(coalesce(w::text, '')) FROM booking.intent_work w WHERE w.intent_id = i.id) AS work_fp
  FROM booking.intents i)
SELECT json_build_object(
  'schema', 'e7-c3-baseline-v1',
  'intent_count', (SELECT count(*) FROM ids),
  'intents', (SELECT json_agg(fp ORDER BY id) FROM fp),
  'held_claims', (SELECT json_agg(json_build_object('intent', c.intent_id, 'listing', c.listing_id, 'stay', c.stay::text, 'kind', c.kind) ORDER BY c.id)
                  FROM booking.inventory_claims c WHERE c.released_at IS NULL),
  'work_leases', (SELECT count(*) FROM booking.intent_work WHERE work_worker_id IS NOT NULL),
  'op_leases', (SELECT count(*) FROM booking.external_operations WHERE lease_worker_id IS NOT NULL),
  'intent_leases', (SELECT count(*) FROM booking.intents WHERE lease_worker_id IS NOT NULL),
  'inflight_ops', (SELECT count(*) FROM booking.external_operations WHERE state IN ('in_flight')),
  'advisory_locks', (SELECT count(*) FROM pg_locks WHERE locktype = 'advisory'),
  'prepared_tx', (SELECT count(*) FROM pg_prepared_xacts),
  'migrations', (SELECT json_build_object('n', count(*), 'min', min(version), 'max', max(version)) FROM booking_migrations.applied),
  'db_now', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) AS baseline;
```
Acceptance at T0: `intent_count` = 6 (ROOT's inventory), `held_claims` contains the Nov 21–22 claim of `c83c1842…` on 606998 (and nothing else unexpected), all lease / in-flight / lock / prepared counts 0, migrations n=21 min=1 max=21. The same query at the END must return identical `intents[]` entries for the six baseline ids (compare per id), exactly one new id, and the same `held_claims` plus the new intent's claim.

### 3.2 R1 — the fresh target after O1 (exactly ONE new intent since T0)
```sql
-- C3-B  the ONE new TEST intent since T0 on listing 606998; refuses to pick when 0 or >1 match
WITH c AS (SELECT * FROM booking.intents WHERE listing_id = 606998 AND environment = 'test' AND created_at >= '__T0__'::timestamptz),
one AS (SELECT * FROM c WHERE (SELECT count(*) FROM c) = 1)
SELECT json_build_object(
  'schema', 'e7-c3-target-v1', 'matched', (SELECT count(*) FROM c),
  'target', (SELECT json_build_object(
     'intentId', one.id, 'ref', one.ref, 'state', one.state, 'version', one.version, 'reason', one.reason_code,
     'listingId', one.listing_id, 'arrival', to_char(one.from_date,'YYYY-MM-DD'), 'departure', to_char(one.to_date,'YYYY-MM-DD'), 'guests', one.guests,
     'currency', one.currency, 'finalTotalMinor', one.final_total_minor, 'authorizedMinor', one.authorized_minor, 'capturedMinor', one.captured_minor,
     'paymentIntentId', one.stripe_payment_intent_id, 'livemode', one.payment_livemode, 'checkoutSessionId', one.checkout_session_id,
     'attemptId', (SELECT id FROM booking.payment_attempts a WHERE a.intent_id = one.id AND a.status = 'completed'),
     'createdAt', to_char(one.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
     'captureBefore', to_char(one.capture_before AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),                 -- STORED provider value; never assumed
     'authorizationDeadline', to_char(one.authorization_deadline AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
     'reservationId', one.hostaway_reservation_id,
     'claim', (SELECT json_build_object('stay', c2.stay::text, 'released', c2.released_at IS NOT NULL) FROM booking.inventory_claims c2 WHERE c2.intent_id = one.id),
     'ops', (SELECT json_agg(json_build_object('type', o.op_type, 'state', o.state, 'attempts', o.attempts, 'dispatched', o.dispatched_at IS NOT NULL, 'ref', o.result_ref) ORDER BY o.id) FROM booking.external_operations o WHERE o.intent_id = one.id),
     'work', (SELECT json_build_object('nextActionAt', to_char(w.next_action_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'leased', w.work_worker_id IS NOT NULL) FROM booking.intent_work w WHERE w.intent_id = one.id),
     'webhookEvents', (SELECT count(*) FROM booking.stripe_webhook_events e WHERE e.intent_id = one.id),
     'cases', (SELECT count(*) FROM booking.reconciliation_cases r WHERE r.intent_id = one.id AND r.status = 'open'),
     'dbNow', to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) FROM one)) AS target;
```
R1 acceptance (pre-S1-A): `matched` 1; `state` `payment_authorized`, `version` 4; `livemode` false; `authorizedMinor` = `finalTotalMinor` ≤ 14000; `capturedMinor` 0; `paymentIntentId` `pi_…`; **`captureBefore` present** (the stored provider value — if NULL/unusable → STOP before S1); `reservationId` NULL; `claim.released` false and `claim.stay` NOT overlapping `[2026-11-21,2026-11-22)` on 606998 (the HELD claim of `c83c1842…` — the DB exclusion constraint would have refused the checkout anyway; the owner must pick a different stay); ops only `stripe.create_checkout_session` / `retrieve_*` succeeded; `work.leased` false; `webhookEvents` 1; `cases` 0.
Re-run C3-B (same T0) before S1-B and before S2: S1-B expects `state reservation_pending`, create op `succeeded` with `ref` = R, `work.nextActionAt` ≤ dbNow; S2 expects `state reservation_confirmed`, `reservationId` = R, capture op `pending/0`, no lease.

### 3.3 End readback (after S2) — target + baseline isolation + Stripe cross-check
Run C3-B for the target (expect `payment_captured`, `capturedMinor` = total, capture op `succeeded/1` with `ref` = `ch_…`, `hostaway.record_offline_charge` `pending/0`, `claim.released` false, `cases` 0, no lease) and C3-A for the baseline (six entries identical to T0; `held_claims` = T0 set + the target's claim; leases / locks / prepared 0; migrations 1..21). Provider cross-check (read-only dashboards, ROOT): Stripe TEST PI `succeeded`, `amount_received` = total, charge `captured: true`, `refunded: false`; Hostaway R status active with the ref in custom field 105433. Stripe Developers → Logs: exactly one `POST …/capture` 200 for the PI (body without `final_capture`).

## 4. Blockers, STOP handoffs and the HELD claim
- **Never the old intent.** `c83c1842-d342-4e27-9ab7-dc3d50b7a309` (`capture_unknown` v8, PI `pi_3UbO8K…` `requires_capture`, HELD claim `[2026-11-21,2026-11-22)` on 606998) is excluded from every input; no repair, no claim release, no retry; its presence is part of the baseline fingerprint and must stay byte-identical.
- **Stay selection for the NEW intent:** chosen only from fresh evidence at T0 — ROOT reads the HELD claims (C3-A) and the owner picks a 1-night stay ≥ 7 days out that does NOT overlap any held claim; the quoted total is read on the page at T0 and must be ≤ USD 140.00; availability/price are never assumed from this document.
- **Pre-T0 ROOT read-only refresh required (stale/unknown facts — not inferred):** (a) e7-test alias → deployment `dpl_…` / sha (last confirmed `dpl_7V17jjpM…` @ 63adbc59; e7-test has since advanced to `59178b04` — a new Preview deployment is likely; the served checkout surface delta 63adbc59→59178b04 is the C1 files only, which the checkout API does not call, but the identity must be read, not assumed); (b) env NAMES/targets (STRIPE_TEST_SECRET_KEY, STRIPE_TEST_WEBHOOK_SECRET, BOOKING_DATABASE_URL (C2-rotated), MV_CHECKOUT_* flags, STRIPE_TEST_ACCOUNT_ID) — values never read; (c) Stripe webhook endpoint = the alias `/api/checkout/stripe-webhook`, enabled; (d) Hostaway token validity and listing 606998 still disconnected / Draft; (e) GitHub `e7-readonly-probe` reviewers ON, deployment branch main, admin bypass OFF, no queued/in-progress e7 runs; (f) protection exception for the alias still present.
- **STOP handoffs (Class E — no hosted rerun, no automation):** S1 create unknown/failed → reconciliation by ref 105433; if a reservation exists, owner cancel in Hostaway as a reviewed action; the TEST authorization is left as observed (no void). S1-B still pending after ONE session → STOP. S2 `CAPTURE_OUTCOME_UNKNOWN` → ROOT reads the PI: `succeeded` ⇒ funds captured → §5 disposition; `requires_capture` ⇒ nothing captured, authorization observed only. Any foreign intent / lease appearing → STOP everything. Lock/DB/deadline outcomes default to Class E unless complete unchanged-evidence (version / ops / lease / fingerprints / uninterrupted run) proves Class P.
- **What the runners never do here:** record an offline charge, mirror, notify, cancel a reservation, refund, void. Slice 4 / 5 remain `false`; Slice 3 remains `false` and HELD.

## 5. Reservation cancellation ≠ payment disposition (explicit)
- A Hostaway reservation cancellation (by the owner, or by any future reviewed step) carries **no authority** over the Stripe payment. The payment's disposition — leave captured, refund in full, refund in part, or (for an uncaptured authorization) let the provider's own handling run — is a **manual, cancellation-policy-assessed owner decision**, executed as a reviewed action naming identity (intent id, R, `pi_`, `ch_`) and the observed Stripe state, in the Stripe TEST dashboard. No hosted runner, worker or script performs it; the Slice 3 / Slice 5 request → cancel → refund code is historical/HELD and is not reopened by this packet.
- After a successful validation the TEST funds **remain captured** until that decision; the checkpoint records "captured, awaiting manual disposition", never "settled". Any later disposition is recorded as its own owner-reported, provider-observed event (DB rows untouched unless a separately reviewed path exists for recording it).
- Existing reconciliation cases, journals, transitions and operation history are preserved as evidence throughout; no DB repair.

## 6. Remaining decisions for ROOT (nothing proceeds without them)
1. Approve this packet as the validation scope (reservation + capture only; stop at `payment_captured`).
2. Authorize the ENABLE DRAFT PR (§2.2; Slices 1 + 2 only) for review; then re-pin `expected_runner_digest` from the merged commit.
3. Complete the pre-T0 read-only refresh (§4) and the T0 baseline (C3-A).
4. Lift the quote/Pay hold for exactly ONE owner DEV checkout; set T0; request Joel's presence only then.
5. Decide how the eventual manual disposition of the captured TEST funds (and of the still-open `pi_3UbO8K…` authorization) will be reviewed and recorded — outside this packet.
