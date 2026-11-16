# C113 — durable request → gated runner DETECTOR contract (DRAFT, doc-only, not implementation-approved)

**Status: PROPOSAL for ROOT review.**
- **Base:** main `e4fceaec` (tree `96e9f0eb`). Every booking execute / dispatch flag is CLOSED.
- **Not done:** no code, test, workflow, flag or schema change; no hosted run; no DB access; no credential or settings access.
- **Privacy:** this file contains no provider / payment / session / contact identifier.

**ROOT decisions this contract implements:**
- **First stage:** MANUAL `workflow_dispatch` ONLY. No `schedule` / cron is added or enabled. A five-minute cadence may be proposed later as a separately reviewed activation, after the manual detector has proven itself.
- **CLOSED main** returns `CLOSED_NOOP` BEFORE any DB credential access, environment-gate request, SQL or dispatch.
- **Candidate counts:**
  - 0 eligible candidates → `NO_REQUEST`, no effect (the normal case);
  - more than 1 → STOP `AMBIGUOUS`, no selection. **Never pick the oldest.**
- **The one candidate:**
  - is **server-derived**;
  - is independently re-validated at claim;
  - is never supplied or overridden by a guest or by a workflow input.
- **Spent rows:** spent / claimed / refused / uncertain rows are never eligible again. The C112 request (`dispatch_accepted`) is spent and cannot be reused.

**Existing facts this builds on** (merged code, cited by file):
- **Request creation.** The 0024 trigger `booking.pipeline_kickoff_record()` inserts at most ONE `booking.pipeline_kickoff_requests` row per intent, inside the authorizing transaction, and only for scoped facts: TEST instance / intent, listing 606998, USD, `payment_livemode = false`, authorized = final total, `intent_created_at >= 2026-11-15T22:58:01Z`, and not one of the five historical targets in `booking.pipeline_kickoff_excluded()`.
- **Row state machine.**
  - Only `requested` can be claimed, through `booking.claim_pipeline_kickoff()`: a single winner under a row lock, which re-proves every binding against the locked intent.
  - `requested → refused` and `claimed → dispatch_*` are terminal.
  - A row left `claimed` is human-owned and never re-claimed.
  - The guard trigger freezes the bound facts and forbids DELETE / TRUNCATE.
- **Consumer and runner.**
  - The consumer `runPipelineKickoffOnce` (tooling `4e79f266`) and `kickoffAdmission` are accepted and are not changed here.
  - The kickoff runner `scripts/e7-hosted-kickoff.mjs` (#157 both-hop TLS) is the only executable path to a dispatch.

---

## F1 — credential / gate order (recommended: TWO approvals on the SAME environment)

The DB secret `E7_DEV_BOOKING_DATABASE_URL` is an `e7-readonly-probe` environment secret. A job can read it only after a reviewer approves that job's deployment to `e7-readonly-probe`, so a detector cannot read it silently.

**Recommended order** (one workflow run, all jobs on the exact dispatched SHA):

| # | job | environment / approval | secret | what it does |
|---|---|---|---|---|
| 1 | `preflight` | none | none | Unchanged: bindings (HEAD == SHA, tooling pin) + focused fake tests, zero skips |
| 2 | `verify` | none | none | **Mode `detect`:** with the CLOSED flags it returns **`CLOSED_NOOP` with exit 0** and output `open=false`, so jobs 3–4 are SKIPPED. No approval is requested; nothing reads a credential. With open flags it checks main + exact SHA + source digest and sets `open=true` |
| 3 | `detect` | **`e7-readonly-probe` — APPROVAL #1** (read-only detection) | DB secret + pinned CA in its final step only | Admission (role / env / catalog / both-hop TLS) → ONE read-only transaction → outcome enum, count and **candidate fingerprint** (§F4); no lock, no DML, no dispatch |
| 4 | `execute` | **`e7-readonly-probe` — APPROVAL #2** (the existing execution decision, now candidate-specific) | DB secret + job token, final step only (as today) | Only if `detect` returned `ONE`. Re-selects server-side, requires an identical fingerprint, then runs the EXISTING kickoff core unchanged |

**Approval rules:**
- **Approval #1** authorizes a read-only scan only.
- **Approval #2** is given after the reviewer has seen job 3's outcome, count and fingerprint, and has independently recomputed the fingerprint from their own DB readback. Recompute instructions are in the private note; the fingerprint is not reversible in practice.
- Both approvals use the same existing environment and reviewer list. There is **no bypass, relocated or copied secret, PAT, App, new credential, broadened permission or settings change.**

**One-gate alternative (not recommended):** detect and execute merged into one gated job. The reviewer would then approve before the candidate is known: an "execute whatever single candidate exists" approval. That is a real change in approval semantics compared with today, where ROOT approves a known, bound request. So it is not "unchanged approval behavior", and it is rejected for the manual stage.

## F2 — reuse mechanism and SHA binding (recommended: extend the EXISTING kickoff workflow + runner)

### Options compared
- **(A, recommended)** Add a mode `detect` to `.github/workflows/e7-hosted-kickoff.yml` and `scripts/e7-hosted-kickoff.mjs`. The jobs `detect` + `execute` live in the SAME workflow file, under the SAME workflow-level concurrency group. The execute step calls the SAME `runKickoffCore` (unchanged module function) with a binding produced by an in-runner selector, not by inputs. There is no copied consumer or transport: the accepted tooling modules stay imported from the pinned `4e79f266`.
- **(B)** A new workflow calling `e7-hosted-kickoff.yml` via `workflow_call`. This adds a second trigger surface to the accepted workflow, splits source frames across two files, and risks a parent/child concurrency deadlock if caller and called workflows both claim the `e7-hosted-kickoff` group (a known GitHub Actions pitfall; exact semantics would need verification before relying on it). It also needs input plumbing that reintroduces input-borne bindings. Rejected.
- **(C)** A copied runner module for detection. Rejected: it would diverge from the accepted consumer / transport.

### Changes (A) would require (implementation stage; none made now)
- **Workflow (`e7-hosted-kickoff.yml`):**
  - `mode` options become `[preflight, verify, execute, detect]`.
  - In `detect` mode the five binding inputs MUST be empty (refused otherwise) and `expected_source_digest` is required.
  - `verify` emits `open` as a job output.
  - New job `detect` (needs verify, `if: inputs.mode == 'detect' && needs.verify.outputs.open == 'true' && github.ref == 'refs/heads/main'`, environment `e7-readonly-probe`, `contents: read` only).
  - The existing `execute` job condition is extended for `detect` → ONE; its token / secret placement and step order are unchanged.
  - The pre-secret shell re-checks (HEAD, tooling pin, kickoff source digest, pipeline release binding `f09bcbbd`) run in BOTH `detect` and `execute`.
  - No `schedule`.
- **Runner (`scripts/e7-hosted-kickoff.mjs`):**
  - new mode `detect`;
  - a fixed `QUERIES.detect` (§F4);
  - `selectKickoffCandidate()`, which uses the same supervised pool, the same seal and the same `clientTlsRefusal` + backend-hop check;
  - `candidateFingerprint()`;
  - in execute-after-detect: re-select, fingerprint equality, then `runKickoffCore` with that binding.
  - The existing manual execute (bindings from inputs) stays as is, for ROOT's explicit use.
- **Tests:**
  - `test/e7-hosted-kickoff.test.mjs` gains detect cases (fake + opt-in PG16/17 + real two-hop TLS);
  - `test/e7-hosted-kickoff-workflow.test.mjs` gains the static and local-gate assertions for the new jobs.
- **Pins and frames:**
  - The kickoff **source digest changes** (all four framed files).
  - The #158 probe source digest changes too, because its frame includes the kickoff runner (expected; the probe stays CLOSED-main-only).
  - The tooling pin `4e79f266`, closure `07fedfca…e87b`, pipeline pins (`f09bcbbd` / `f7d7cad6` / `71c3dcf8`) and schema 0024 are **unchanged**.
  - CATALOG_PINS are unchanged: the detection uses only SELECT on the existing table / functions.
  - The shallow S1 tests are extended.

### SHA binding
- `detect` and `execute` each check out `github.sha` and the tooling pin, and re-check HEAD == `github.sha` and the source digest BEFORE the secret.
- The selector, the imported `clientTlsRefusal` and the executable core all come from that exact checkout.
- The transport's release binding (GET main == `github.sha`) is unchanged.
- There is no ref / SQL / target / sample / binding input.

## F3 — concurrency, lock ownership and races

- **Lock.** The workflow-level `concurrency: { group: e7-hosted-kickoff, cancel-in-progress: false }` is held by the WHOLE run, from start until its last job ends. That includes the time `detect` and `execute` wait for approval.
- **No deadlock.** There is no child workflow; the detector does NOT dispatch the pipeline or another kickoff. The pipeline is a different workflow with its own group, created only by the one transport POST.
- **Queued runs.** A second kickoff run (manual or detect) queues behind the first. GitHub keeps at most one pending run per group, and a newer pending run replaces (cancels) an older *pending* one. That is harmless because a pending run has done nothing.
- **Active-run listing** is advisory only. The **durable claim is the authority.**

**Races:**
- **Two simultaneous scans:** serialized by the group. Even across groups, at most one `claim_pipeline_kickoff()` wins the row lock, and the loser sees `NOT_REQUESTED:*`.
- **A new candidate appears between `detect` and `execute`:** execute re-selects. If the count is not 1 or the fingerprint differs → STOP `CANDIDATE_CHANGED` / `AMBIGUOUS`, no claim.
- **Stale version or binding:** the fingerprint covers the version, and `claim_pipeline_kickoff()` re-proves it against the locked intent row → refused, terminal.
- **Main moves:**
  - before a secret: HEAD / source re-check → refuse;
  - after the claim: the transport GET main != `github.sha` → `notSent` (`dispatch_refused`), 0 POST.
- **Waiting too long for approval #2:** the reviewer rejects, or execute re-validates (as above). There are no timers or auto-approvals.
- **Lost replies / timeouts:** unchanged C111 / #157 rules — `CLAIM_UNCERTAIN`, `UNKNOWN`, `ACCEPTED_UNVERIFIED` are human-owned. No automatic retry, and no re-claim of `claimed` / `dispatch_unknown`.
- **Cancellation:** `cancel-in-progress: false`; ROOT does not cancel an `execute` job after its claim. The job timeout (10 min) is larger than the core's 90 s wall time, and the core seals itself first.

## F4 — fixed SQL, budgets and output

**Admission before the scan** (the existing `QUERIES.session` / `environment` / `fn` / `table`, unchanged):
- app role, not admin or privileged or schema owner;
- server 16–17;
- `booking.instance = 'test'`;
- the exact 0024 catalog;
- client hop verified on every acquired socket;
- backend `pg_stat_ssl.ssl = true`.

**Detection, ONE read-only transaction** (`BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` … `ROLLBACK`, always rolled back), one fixed statement, parameters bound from runner constants only:

```sql
/*e7hko:detect*/ SELECT r.intent_id::text AS intent_id, r.ref, r.authorized_version, r.payment_intent_id, r.amount_minor::text AS amount_minor
FROM booking.pipeline_kickoff_requests r JOIN booking.intents i ON i.id = r.intent_id
WHERE r.state = 'requested' AND r.listing_id = $1 AND r.currency = $2 AND r.intent_created_at >= $3::timestamptz
  AND NOT booking.pipeline_kickoff_excluded(r.intent_id)
  AND i.environment = 'test' AND i.payment_livemode = false AND i.state = 'payment_authorized' AND i.version = r.authorized_version
ORDER BY r.intent_id LIMIT 2          -- $1 606998, $2 'USD', $3 '2026-11-15T22:58:01Z' (constants); LIMIT 2 only distinguishes 0 / 1 / >1
```

**Rules:**
- No `FOR UPDATE`, no advisory lock, no DML.
- Outcome by count: 0 rows → `NO_REQUEST`; 2 rows → `AMBIGUOUS` (nothing selected or reported); 1 row → that row only.
- For a single row, the SAME read-only transaction then runs the accepted `readKickoffFacts` (0024 row + intent + open cases + unsettled ops) and the accepted `kickoffAdmission`. Any refusal → `INELIGIBLE:<code>`.
- The transaction ends (ROLLBACK) and every client is released BEFORE the job outputs anything.

**Budgets (detect job):**
- wall 60 s;
- connect 8 s, statement 6 s;
- ≤ 24 statements (admission ≈ 12 + detect 1 + facts ≤ 4 + BEGIN / ROLLBACK);
- pool max 1; HTTP 0; no token.

The execute job keeps the existing kickoff budgets (90 s, 48 statements, 1 GET + 1 POST) plus re-select + fingerprint, both inside the same seal. Cleanup: pool end ≤ 5 s; late clients destroyed under the seal.

**Output:** allowlisted enums and counts only.
- `outcome ∈ {CLOSED_NOOP, NO_REQUEST, ONE, AMBIGUOUS, INELIGIBLE:<accepted code>, STOP:<admission / TLS / seal code>}`;
- `candidates ∈ {0, 1, 2}`;
- `tlsClientVerified`, `backendSsl`.

**Candidate fingerprint:** the ONLY job output toward `execute` is `fingerprint = sha256("e7-kickoff-candidate-v1\n" ‖ intent_id ‖ "\n" ‖ ref ‖ "\n" ‖ version ‖ "\n" ‖ payment_intent_id ‖ "\n" ‖ amount_minor)` (64-hex).
- No identifier is emitted, logged or summarized.
- `execute` re-derives the binding from the DB itself and requires equality.
- No guest / contact data, URL, credential or raw error appears anywhere; errors map to fixed codes.

## F5 — acceptance matrix (for the future implementation PR)

| # | case | expected |
|---|---|---|
| 1 | CLOSED main, mode `detect` | `verify` → `CLOSED_NOOP` exit 0; `detect` / `execute` skipped; **0 approval prompts, 0 secret reads, 0 SQL, 0 dispatch** (static + local-gate + key-names-only tests) |
| 2 | Open, 0 candidates | `NO_REQUEST`; `execute` skipped; 0 claim / GET / POST; read-only (table fingerprints unchanged) |
| 3 | Open, 1 candidate | `ONE` + fingerprint; after approval #2: re-select equal → existing core → one handoff (fake GitHub); rerun → `NO_REQUEST` (row spent) |
| 4 | Open, 2+ candidates | `AMBIGUOUS`; nothing selected or output; `execute` skipped |
| 5 | Invalid scope (listing / currency / livemode / cutoff / excluded / not test) | not selected; or `INELIGIBLE:*` |
| 6 | Catalog drift / schema 23 / foreign, admin or owner role | STOP before the scan |
| 7 | TLS: plaintext / unverified client hop; backend `ssl=false` / NULL | STOP `TLS_REQUIRED:CLIENT_*` / `BACKEND_HOP`, 0 scan statements (real two-hop fixtures as in #157 / #158) |
| 8 | Stale bindings between detect and execute (version bump, new candidate, row claimed / refused elsewhere) | `CANDIDATE_CHANGED` / `AMBIGUOUS` / `NOT_REQUESTED:*`; 0 claim |
| 9 | Competing consumer claims first | the loser gets `NOT_REQUESTED:CLAIMED`; exactly one handoff overall |
| 10 | Main moves after detect | pre-secret refuse, or transport `notSent`; 0 POST |
| 11 | Timeout / abort / late client during detect or execute | sealed; late clients destroyed unused; no statement after the seal |
| 12 | Uncertain claim COMMIT / POST / readback | `CLAIM_UNCERTAIN` / `UNKNOWN` / `ACCEPTED_UNVERIFIED`; human-owned; no retry |
| 13 | No duplicate kickoff / pipeline | at most one claim per row, one POST per run, one pipeline run per accepted handoff |
| 14 | Inputs | detect with any binding input non-empty → refused; no SQL / ref / target / TLS input exists |
| 15 | Permissions / gates | `contents: read` default; `detect` adds no write; `execute` unchanged (`actions: write` + token in its final step only); exactly one environment name; secret only in final steps |
| 16 | Depth-1 hosted layout | real shallow preflight with zero skips (kickoff S1, extended) |

**Future hosted TEST proofs** (separate authorization; NO new checkout now):
- **(i)** `detect` on CLOSED main → `CLOSED_NOOP` (no approvals).
- **(ii)** `detect` inside a reviewed ENABLE window with zero eligible requests → `NO_REQUEST`. The spent C112 row must not be selected.
- **(iii)** An end-to-end ONE-candidate run needs a NEW authorized TEST request from a separately authorized future checkout. Not now.

## Remaining decisions for ROOT
1. Accept the two approvals on `e7-readonly-probe` (recommended), or define a different candidate-specific review.
2. Accept the fingerprint-only handoff (the reviewer recomputes it from the DB), or allow a private, non-logged binding channel.
3. Whether `verify` returning `CLOSED_NOOP` with exit 0 (instead of today's `HKO_EXECUTE_CLOSED` failure) is acceptable for `detect` only.
4. The later cadence (schedule) proposal; `guest.notify` stays a separate contract.
