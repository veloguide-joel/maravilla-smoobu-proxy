# C113 — durable request → gated runner DETECTOR contract (DRAFT rev 2, doc-only, not implementation-approved)

**Status: PROPOSAL for ROOT review (rev 2).**
- **Base:** main `e4fceaec` (tree `96e9f0eb`). Every booking execute / dispatch flag is CLOSED.
- **Not done:** no code, test, workflow, flag or schema change; no hosted run; no DB access; no credential or settings access.
- **Privacy:** this file contains no provider / payment / session / contact identifier.

**Rev 2:** applies ROOT's review of rev 1. Decisions accepted; findings F1–F3 and the routing / trust clarifications are fixed. Dispositions are in §R.

**ROOT decisions (accepted):**
- MANUAL `workflow_dispatch` ONLY; no `schedule` / cron in this stage. A cadence is future work, proposed separately.
- TWO sequential approvals on `e7-readonly-probe`.
- Fingerprint-only handoff, with independent ROOT recomputation.
- `CLOSED_NOOP` (exit 0, `open=false`) for mode `detect` ONLY. The existing manual `verify` / `execute` closed refusals (`HKO_EXECUTE_CLOSED`) stay failures.
- Architecture A (extend the existing workflow + runner) accepted in principle, subject to the bounded supervision in §F2.
- Notification stays a separate contract.
- **Candidate counts:**
  - 0 eligible → `NO_REQUEST`, no effect;
  - more than 1 → STOP `AMBIGUOUS`, no selection. **Never the oldest.**
- **The one candidate:** server-derived, re-validated at claim, never supplied or overridden by a guest or by detect-mode inputs.
- **Spent rows:** spent / claimed / refused / uncertain rows never become eligible again. The C112 request is spent.

**Existing facts this builds on** (merged code):
- **0024.** `pipeline_kickoff_record()` inserts at most one row per intent, inside the authorizing transaction, for scoped facts only. `claim_pipeline_kickoff()` is a single winner under a row lock, re-proves the bindings of THAT row / intent, and is terminal on failure. A `claimed` row is never re-claimed. The guard freezes facts and forbids DELETE / TRUNCATE.
- **Kickoff runner** (`scripts/e7-hosted-kickoff.mjs`, #157). `runKickoffCore` owns ONE seal, ONE wall deadline (`runMs − teardownMs` = 85 s) and ONE statement counter (`dbQueries` 48), all started when it is called. It covers both-hop TLS per acquired client and phase-sensitive outcome classification.
- **Pinned consumer / transport** (tooling `4e79f266`): unchanged by this contract.

---

## F1 — credential / gate order (TWO approvals on `e7-readonly-probe`)

| # | job | approval | DB secret | role |
|---|---|---|---|---|
| 1 | `preflight` | none | none | unchanged |
| 2 | `verify` | none | **none** | Mode `detect`, CLOSED flags → `CLOSED_NOOP`, exit 0, job output `open=false`, so jobs 3–4 are skipped. **0 DB-secret reads, 0 approval prompts, 0 SQL, 0 dispatch.** Public mode / input values are read; detect-mode binding inputs must be empty (non-empty → refused). Open flags → main + exact SHA + source digest checks → `open=true` |
| 3 | `detect` | **#1** | final step only | read-only detection (§F4) |
| 4 | `execute` | **#2** (candidate-specific) | final step only (+ job token, unchanged) | execute-after-detect (§F2) |

- No bypass, relocated or copied secret, PAT, App, broadened permission or settings change.
- The reviewer gives #2 only after recomputing the fingerprint from their own read-only readback (private note).

## F2 — bounded supervision: ONE authoritative owner per job

### Mechanism (Architecture A)
- **Workflow:**
  - `e7-hosted-kickoff.yml` gets mode `detect`;
  - job `detect` (needs verify; `if: inputs.mode == 'detect' && needs.verify.outputs.open == 'true' && github.ref == 'refs/heads/main'`; environment `e7-readonly-probe`; `contents: read`);
  - the existing `execute` job's condition is extended to `(inputs.mode == 'execute') || (inputs.mode == 'detect' && needs.detect.outputs.outcome == 'ONE')`;
  - `outcome` and `fingerprint` are **declared job outputs** of `detect`, written by the runner step, not taken from inputs.
- **Runner:** the same file. There is **no copied consumer / transport**; the tooling `4e79f266` modules stay imported as today.

### Honest seam change to `runKickoffCore` (narrow; consumer / transport / tooling unchanged)
Today `runKickoffCore` takes a pre-validated `binding`. A selector running in `runHosted` before it would NOT be inside its seal. So rev 2 proposes ONE narrow, additive input:

**`binding` becomes `{ source: "manual", …existing fields }` OR `{ source: "selected", expectedFingerprint, releaseSha }` OR `{ source: "detect" }`.**

Changes inside `runKickoffCore`:
1. The pre-acquisition `CORE_INVALID` check validates `releaseSha` and `expectedFingerprint` (64-hex) for `selected`. The per-field checks move to step 3.
2. After the EXISTING session / env / catalog admission (phase `admission`, same seal, same counter), `selected` runs **re-selection**:
   - `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`;
   - the detect SELECT (§F4);
   - `ROLLBACK`;
   - all three statements on ONE tracked client, counted by the SAME `dbQueries` counter.
3. Then: count ≠ 1 → STOP `CANDIDATE_CHANGED` / `AMBIGUOUS` / `NO_REQUEST`. Otherwise derive the binding from the row, compute the fingerprint, and require equality, else STOP `CANDIDATE_CHANGED`. Then validate the derived fields exactly like a manual binding.
4. From here the code path is **byte-for-byte the existing one**: `readKickoffFacts`, the bound-row equality checks, `kickoffAdmission`, the guarded exchange, ONE consumer invocation, readback.

Everything else in the core is unchanged: seal, phases, uncertainty classification, late-client destruction, exchange guards.

### Ownership, budgets and propagation
- **Execute job:** the **authoritative owner is `runKickoffCore`**. Its deadline and statement counter start at its call, and re-selection happens inside them.
  - There is **no outer supervisor** and no second budget.
  - `runHosted` builds the pool and the credential closure exactly as today; the credential function is invoked only by the transport inside the core (`credentialReads` counted).
  - The total stays **85 s wall (90 s − 5 s teardown) / 48 statements / 1 GET / 1 POST**. There is no fresh budget after a slow selector, because the selector IS inside it.
- **Abort / seal propagation:** unchanged. Run abort (SIGINT / SIGTERM → `runSignal`), the deadline, and connect / statement timeouts seal the core. After that, every tracked client is destroyed, late clients are destroyed unused, statements are refused, and the exchange refuses GET / POST.
- **No flattening or upgrading:** the core's outcome is passed through unchanged as `r.core`.
  - `runHosted` never re-classifies `CLAIM_UNCERTAIN` / `REFUSE_UNCERTAIN` / `UNKNOWN` / `ACCEPTED_UNVERIFIED`.
  - The exit code stays 0 only for `ACCEPTED_VERIFIED` + verified.
  - Re-selection runs only in phase `admission`, so any failure there is STOP-class: `SEALED_ADMISSION:*` / `ADMISSION_READ_FAILED:*` / `CANDIDATE_CHANGED`.
- **Detect job:** owned by the detect-only path of the SAME core function, `binding: { source: "detect" }`. It returns right after selection + facts + admission, with detect constants: **wall 60 s − 5 s, ≤ 24 statements, pool max 1, 0 GET / POST, credential closure absent.**

### Exact worst-case statement accounting
Catalog admission is 7 function rows + 1 table row. `readKickoffFacts` is **FIVE** queries (request, `loadIntent`, environment, open cases, unsettled ops).

**Detect job (≤ 24):**

| part | statements |
|---|---|
| session | 1 |
| environment | 1 |
| catalog functions | 7 |
| catalog table | 1 |
| BEGIN | 1 |
| detect SELECT | 1 |
| `readKickoffFacts` (inside the read-only transaction, only when 1 row) | 5 |
| ROLLBACK | 1 |
| **total** | **18** |

**Execute-after-detect (≤ 48):**

| part | statements |
|---|---|
| core admission (session, env, catalog 7, table) | 10 |
| re-selection (BEGIN, SELECT, ROLLBACK) | 3 |
| core `readKickoffFacts` | 5 |
| consumer read: owned connection (CLEAN check + `readKickoffFacts`) | 6 |
| consumer claim: CLEAN + BEGIN + claim + COMMIT, + ROLLBACK on error | 5 |
| consumer settle (same shape), or the mutually exclusive refuse path (same shape) | 5 |
| readback | 1 |
| **total** | **35** |

- Headroom is 13 under 48, so **no budget increase is proposed**.
- Today's manual execute worst case is 32: the same without the 3 re-selection statements.

### Timeout boundary cases (all inside the core's single seal)
- **Before handoff** (admission, re-selection or facts): STOP `SEALED_ADMISSION:<reason>`; 0 claim, 0 credential, 0 GET / POST.
- **During the claim COMMIT:** `CLAIM_UNCERTAIN`; human-owned, never retried. The row may be `claimed` and is never re-claimed.
- **After a possible POST:** `UNKNOWN` (`SEALED_AFTER_POST`); never upgraded by a late 204; the row stays `claimed` / `dispatch_unknown`; human-owned.

## F3 — concurrency, snapshot boundary and races (corrected)

- **Lock:** the workflow-level `concurrency: e7-hosted-kickoff` (`cancel-in-progress: false`) is held by the whole run, approval waits included. There is no child workflow, so no deadlock. A newer *pending* run may replace an older pending one; that is harmless, since pending runs have done nothing.
- **Authority:** the durable claim. Listing active runs is advisory only.

**Selection snapshot (precise boundary):**
- The 0 / 1 / >1 decision is evaluated ONLY at the re-selection snapshot inside execute.
- A row committed BEFORE that snapshot is counted: a second candidate → `AMBIGUOUS`, no selection.
- A row committed AFTER the snapshot but before the claim is **not seen**. It stays `requested`, untouched, for a later separately reviewed run.
- The unchanged claim locks and re-proves ONLY the selected row / intent. It does **not** serialize candidate creation or enforce global cardinality.
- **The invariant is per-row exactly-once:** single-winner claim + revalidation of the selected row; never global uniqueness.
- No selector lock, migration, backfill or global writer fence is proposed.

**Main movement (corrected; rev 1 overclaimed):**
- Both jobs check out the fixed `github.sha`. After live `main` moves, HEAD == `github.sha` and the source digest STILL pass, so **no pre-secret check detects a live-main move**.
- The existing authority stays as it is: the transport's reviewed `GET refs/heads/main == releaseSha` before the POST.
  - A move can therefore be discovered only AFTER the claim. Result: `notSent`, the row settles `dispatch_refused` (terminal, human-owned), 0 POST.
  - No extra authenticated API / credential / network step is added. No earlier live-main proof is claimed.
- **Retained limit:** a GET → POST time-of-check / time-of-use window remains. A move between the GET and the POST is caught only by the dispatched pipeline's OWN checks: its checked-out source digest / release binding, and its separate reviewer gate.

**Other races:**
- **Stale version:** the claim re-proves → terminal refusal.
- **Competing consumer:** one winner; the loser gets `NOT_REQUESTED:CLAIMED`.
- **Approval #2 delayed:** re-selection handles the drift.
- **Lost replies:** human-owned, no retry.
- **Cancellation:** ROOT does not cancel an execute job after its claim. The job timeout (10 min) exceeds the core's wall time, and the core seals itself first.

## F4 — fixed SQL, output and trust routing

**Detect SELECT** (detect job and execute re-selection; constants only, from runner literals):

```sql
/*e7hko:detect*/ SELECT r.intent_id::text AS intent_id, r.ref, r.authorized_version, r.payment_intent_id, r.amount_minor::text AS amount_minor
FROM booking.pipeline_kickoff_requests r JOIN booking.intents i ON i.id = r.intent_id
WHERE r.state = 'requested' AND r.listing_id = $1 AND r.currency = $2 AND r.intent_created_at >= $3::timestamptz
  AND NOT booking.pipeline_kickoff_excluded(r.intent_id)
  AND i.environment = 'test' AND i.payment_livemode = false AND i.state = 'payment_authorized' AND i.version = r.authorized_version
ORDER BY r.intent_id LIMIT 2          -- $1 606998, $2 'USD', $3 '2026-11-15T22:58:01Z'; LIMIT 2 only distinguishes 0 / 1 / >1
```

- It runs inside `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` … `ROLLBACK`; no `FOR UPDATE`, advisory lock or DML.
- In the detect job, the accepted `readKickoffFacts` + `kickoffAdmission` run in the same read-only transaction when there is 1 row. Any refusal → `INELIGIBLE:<code>`.
- The transaction ends and clients are released before any output.

**Outputs (detect job):**
- `outcome ∈ {CLOSED_NOOP, NO_REQUEST, ONE, AMBIGUOUS, INELIGIBLE:<accepted code>, STOP:<admission / TLS / seal code>}`;
- `candidates ∈ {0, 1, 2}`;
- TLS counts;
- `fingerprint` (64-hex), only when `ONE`.

No identifier, URL, credential, guest data or raw error appears in logs or summaries.

**Trust routing:**
- Mode `detect` uses ONLY `needs.detect.outputs.outcome` / `fingerprint` (declared job outputs written by the runner) for the execute condition and for `E7_EXPECTED_CANDIDATE_FINGERPRINT`.
- **Detect mode accepts NO binding input.** Non-empty binding inputs → refused. The legacy manual `execute` keeps its existing binding inputs, so every "no binding input" statement here applies to detect mode only.
- SHA / run identity stays bound independently by job context (`github.sha`, checkout HEAD) and the pre-secret source proofs.

**Fingerprint canonicalization (fixed field order, UTF-8, `\n` separators, no trailing newline):**
`sha256("e7-kickoff-candidate-v1" \n intent_id \n ref \n authorized_version \n payment_intent_id \n amount_minor)`
- `intent_id`: lowercase canonical UUID text (`uuid::text`; JS lowercases);
- `ref`: as stored;
- `authorized_version`: base-10 integer, no sign, no leading zeros (`integer::text` / `String(Number)`);
- `payment_intent_id`: as stored;
- `amount_minor`: base-10 integer minor units, no sign / leading zeros / decimals (`bigint::text`, JS from a safe integer).

**Synthetic cross-language test vector** (not real data): intent `00000000-0000-4000-8000-000000000001`, ref `MV-TEST0001`, version `4`, PI `pi_SYNTHETIC0001`, amount `14000` → `13e93ba6950bf74d5b1931cb4d95ad69ad4f90faf6c649878052d3347db905ea`. Computed offline identically by Node 22 `crypto`, Python `hashlib` and PostgreSQL 16 `sha256(convert_to(…))`.

## F5 — acceptance matrix (rev 2)

| # | case | expected |
|---|---|---|
| 1 | CLOSED main, mode `detect` | `CLOSED_NOOP` exit 0; jobs 3–4 skipped; **0 DB-secret reads, 0 approval prompts, 0 SQL, 0 dispatch** |
| 1b | CLOSED main, manual `verify` / `execute` | unchanged `HKO_EXECUTE_CLOSED` failure |
| 2 | Open, 0 candidates | `NO_REQUEST`; execute skipped; read-only (table fingerprints unchanged) |
| 3 | Open, 1 candidate | `ONE` + fingerprint → #2 → re-select equal → existing path → one handoff (fake GitHub); rerun → `NO_REQUEST` |
| 4 | Open, ≥ 2 | `AMBIGUOUS`; nothing selected; execute skipped |
| 5 | Out of scope (listing / currency / livemode / cutoff / excluded / not test) | not selected, or `INELIGIBLE:*` |
| 6 | Catalog drift / schema 23 / foreign, admin or owner role | STOP before the scan |
| 7 | TLS: plaintext / unverified client hop; backend `ssl=false` / NULL | `TLS_REQUIRED:*`, 0 scan statements |
| 8a | A second candidate committed BEFORE the execute re-selection snapshot | `AMBIGUOUS`; 0 claim |
| 8b | A second candidate committed AFTER the snapshot, before the claim | not seen; the selected row proceeds; the new row stays `requested` (untouched) |
| 8c | The selected row's version bumped / claimed / refused after detect | `CANDIDATE_CHANGED`, or claim `NOT_REQUESTED:*` / terminal refusal; 0 POST |
| 9 | Competing consumer | exactly one claim overall |
| 10 | Live main moves after detect | pre-secret checks PASS (fixed SHA); after the claim the transport GET mismatches → `notSent` / `dispatch_refused`, 0 POST, human-owned |
| 10b | Main moves between GET and POST | a POST may occur; the pipeline's own source / gate checks are the remaining defence (documented limit) |
| 11 | Timeout before handoff / during claim COMMIT / after possible POST | `SEALED_ADMISSION` / `CLAIM_UNCERTAIN` / `UNKNOWN`; never flattened or upgraded |
| 12 | Slow re-selection | consumes the SAME 85 s / 48-statement budget; no reset |
| 13 | Abort / late client | sealed; late clients destroyed; 0 statements after the seal |
| 14 | No duplicate kickoff / pipeline | ≤ 1 claim per row, ≤ 1 POST per run |
| 15 | Detect-mode binding inputs non-empty | refused before any secret |
| 16 | Fingerprint | the JS implementation equals the synthetic vector above; SQL recompute equal (PG16 + PG17) |
| 17 | Permissions / gates | `contents: read` default; detect has no write; execute unchanged; one environment name; secrets in final steps only |
| 18 | Depth-1 layout | real shallow preflight, zero skips |

**Future hosted TEST proofs** (separately authorized; NO new checkout now):
- **(i)** `CLOSED_NOOP`.
- **(ii)** `NO_REQUEST` in a reviewed ENABLE window; the spent C112 row must not be selected.
- **(iii)** End-to-end with a NEW authorized TEST request from a future, separately authorized checkout.

## R — disposition of ROOT's rev-1 review

| finding | disposition |
|---|---|
| F1 live-main guarantee | **Fixed.** Pre-secret checks do not detect live-main moves. The authority stays the transport GET before POST (post-claim discovery → `notSent` / `dispatch_refused`, human-owned). GET → POST TOCTOU and the downstream pipeline checks retained. Matrix rows 10 / 10b |
| F2 supervision / budgets | **Fixed.** A narrow additive `binding.source` seam lets re-selection run INSIDE `runKickoffCore`'s existing seal / deadline / counter. No outer supervisor; budgets unchanged at 85 s / 48, worst case 35. `readKickoffFacts` corrected to 5. Detect worst case 18 ≤ 24. Timeout boundaries listed. Consumer / transport / tooling unchanged |
| F3 snapshot / cardinality | **Fixed.** The snapshot is the 0 / 1 / >1 boundary. Post-snapshot rows stay `requested` for a later run. The invariant is per-row exactly-once. No selector lock / migration / fence. Matrix rows 8a / 8b / 8c |
| Routing / trust | **Fixed.** Declared job outputs only; detect-mode-only "no binding input"; canonicalization + synthetic vector; CLOSED path = 0 DB-secret reads |

## Remaining decisions for ROOT
1. Accept the narrow `binding.source` seam in `runKickoffCore` (rev 2 §F2), or prefer an alternative.
2. Detect-job constants: 60 s / 24 statements.
3. Cadence later; notification separate.
