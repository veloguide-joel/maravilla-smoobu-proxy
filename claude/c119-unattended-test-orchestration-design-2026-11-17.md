# C119 DESIGN: unattended TEST booking orchestration (2026-11-17; rev 2 with ROOT's review corrections, committed with S1)

**Rev 2 (ROOT review, 2026-11-17):** S1 (§8) is implemented as a DRAFT PR, SHIPPED CLOSED. Corrections applied below and in §9:
- 0027 grants the runtime role **no** EXECUTE on `externally_cancelled()` and **no** SELECT on `external_cancellations`. The only permitted runtime read is `booking.external_cancellation_public(uuid)`. An unreadable or unknown result refuses; it never means "no cancellation".
- The ~1 h worst-case latency is a **TEST-only** figure, not a guest-launch SLA.
- Healthy-`PENDING` continuation remains a **functional gap**.
- D-ENV (b) is the preferred technical direction. Nothing is created, removed, copied or cascaded now, and existing environment protections stay as they are.
- Owner decisions (confirmation sender, tax, policy copy) remain **undecided**. Joel's stated preference for native Hostaway emails is not overridden without verification.

**Status:** design only. No implementation PR, no settings / variable / environment change, no shared-DB or provider action. All runners stay CLOSED.
**Basis (read today):** e7-test `a314681b` (tree `e3c249a1`); main `92c1b674` (CLOSED). The main workflows read were kickoff, pipeline, booking-confirmation, readonly-probe and cross-runner regression. Also read: the C115 proposal, the C116 checkpoints, and migrations 0016 / 0024 / 0026 / 0027.
**Goal:** after a guest's Stripe TEST authorization, the TEST booking runs with no human step: kickoff → Hostaway create → capture → offline record → ONE English confirmation. This replaces today's per-booking ENABLE / CLOSE commits and environment approvals. Every existing safeguard stays as it is.

## 1. What already exists (reuse as is)
| stage | existing mechanism | human step today |
|---|---|---|
| authorize → request | `api/checkout/stripe-webhook.js` (preview only, TEST switch) → durable 0024 `pipeline_kickoff_requests` row | none |
| request → pipeline | `e7-hosted-kickoff.yml`: preflight → verify → detect (ONE + fingerprint) → execute = single-winner `claim_pipeline_kickoff`, then `workflow_dispatch` of the pipeline with the job-scoped `github.token` (no PAT). A `schedule` (`13,43 * * * *`) is already drafted CLOSED; its source pin comes from `vars.E7_KICKOFF_EXPECTED_SOURCE` | ENABLE commit (`executeEnabled` / `dispatchEnabled`); 2 approvals (env `e7-readonly-probe`); CLOSE commit |
| pipeline | `e7-hosted-pipeline.yml` → coordinator (≤ 6 steps; ≤ 1 create / capture / record, enforced durably plus an in-run guard); run advisory lock with per-step proof; refund veto; fresh Stripe proof; ≤ 1 bounded wait of ≤ 150 s; `reservation_unknown` / `capture_unknown` → STOP | ENABLE commit (frame `880db5b3`); 1 approval; CLOSE |
| confirmed → notify op | the `confirmed` transition enqueues exactly one `guest.notify` `booking_confirmed` row in the same transaction (unique per intent, 0016) | none |
| confirmation | `e7-hosted-booking-confirmation.yml`: ONE bound `op_id`; gn-v2 `en`; ONE Resend exchange; idempotency key; typed receipt (0023); recipient scope `.invalid` + sink (0025); verified-completion readback; no resend ever | ENABLE commit; manual dispatch with the op id; 1 approval; CLOSE |
| cancellation fences | 0027 claim / op / intent fences; latch for a pristine notify; `sent_preserved` | n/a |

**Conclusion:** the work chain is already automatic between stages. The per-booking human work is (i) source arming via ENABLE / CLOSE commits, (ii) environment approvals, and (iii) dispatching the confirmation with an op id. The design removes exactly those three. No worker, coordinator or SQL function is redesigned.

## 2. Target flow (TEST)
```
Stripe TEST authorization ──webhook──▶ 0024 request (requested)
  ▼ kickoff schedule tick (existing cron; armed)            [concurrency group e7-hosted-kickoff]
  verify(arm) → detect ONE → execute: claim (single winner) → dispatch pipeline (github.token, actions:write)
  ▼ pipeline run (existing runner, unchanged bytes; see D1 for its gate)  [group e7-hosted-pipeline]
  create → capture → record → confirmed  (+1 pristine guest.notify row, same tx)
  ▼ confirmation schedule tick (NEW detect mode; armed)      [group e7-hosted-booking-confirmation]
  verify(arm) → detect ONE eligible op (server-side) → execute the existing bound-op path → readback
```
- **Two independent schedules; no new cross-runner dispatch.** The pipeline does not dispatch the confirmation. A dispatch would make the pipeline frame depend on the confirmation runner, which recreates the cycle C116 removed (notification → pipeline → SQL literal → catalog).
- **Cadence (TEST only):** both cron schedules every 30 minutes on off-minutes (confirmation e.g. `28,58`). Worst-case latency from authorization to email is ≈ 1 h plus GitHub schedule delay. That is well inside the ~7-day TEST authorization window, but it is **not** an acceptable guest-launch SLA.

## 3. Components
1. **Entrypoint / scheduler / queue**
   - Queue = the durable tables already there: `pipeline_kickoff_requests` (kickoff) and pristine `guest.notify` rows (confirmation).
   - Scheduler = GitHub `schedule` on main for kickoff (exists) and confirmation (new). Manual `workflow_dispatch` stays as the fallback.
   - Nothing new on Vercel: no cron, no queue service, no route.
2. **Arming (replaces per-booking ENABLE / CLOSE)**
   - Main carries the three runners at a reviewed **armed revision**: the existing `executeEnabled` / `dispatchEnabled` true literals, frozen.
   - Live arming is ONE repository variable, `vars.E7_TEST_AUTO_ARMED`. It must equal the exact reviewed release digest, checked in the workflow `if` and again in verify, before any secret, approval, SQL or HTTP.
   - Absent or mismatched → `CLOSED_NOOP`, exit 0. This generalizes C115's `E7_KICKOFF_EXPECTED_SOURCE` (that variable becomes the kickoff half of the arm).
3. **Authentication**
   - No PAT, App or new credential.
   - Dispatch uses the job-scoped `github.token` (`actions: write`, in that step only), as proven in C116.
   - Secrets keep their existing names (`E7_DEV_BOOKING_DATABASE_URL`, `E7_STRIPE_TEST_KEY`, `E7_HOSTAWAY_TOKEN`, `E7_RESEND_TEST_KEY`), each in its final step only. Claude never sees values.
4. **Environment separation** (unchanged, all fixed in source)
   - Listing 606998.
   - DB instance marker `test`.
   - Stripe `livemode=false`.
   - Resend TEST key with the 0025 sink-only recipient scope, so an unattended TEST run can never email a real guest.
   - Checkout and webhook routes 404 in Vercel production.
   - Production is a separate future stage (B2 / B3), not a flag in this design.
5. **Locks / leases** (unchanged)
   - Kickoff: single-winner claim.
   - Pipeline: session advisory lock, proven before the coordinator and after every step.
   - Coordinator never steals leases; `WORK_LEASED` → STOP.
   - Notify: unique op, latch and receipts.
   - Each workflow has its own concurrency group with `cancel-in-progress: false`. Overlapping ticks queue or are replaced. Duplicate ticks are safe because detect writes nothing and execute re-selects with the same fingerprint.
6. **Bounded retries** (unchanged, deliberately minimal)
   - No automatic re-dispatch of a claimed request.
   - No resend after any provider attempt.
   - The only automatic continuation is the existing ≤ 1 in-run wait of ≤ 150 s.
   - A run that ends `PENDING` (exit 0) or STOP stays human-owned in the first release. A continuation detector is a later, separately reviewed slice (§8, S5), because it needs a new plan / SQL binding (version moves past `authorized_version`).
7. **Ambiguous writes** (unchanged)
   - `reservation_unknown`, `capture_unknown`, `outcome_unknown`, notify `ACCEPTED_UNVERIFIED`, `dispatch_unknown`, `CLAIM_UNCERTAIN` → STOP, never retried.
   - Reconciliation = read-only readback (existing `recovery.js` read paths / readbacks), then a separately authorized step.
8. **Cancellation fences**
   - Admission reads only the granted projection `booking.external_cancellation_public(intent)`: exactly SQL NULL means not cancelled, a cancelled object refuses, and an error or any other value refuses as unreadable. Detect re-runs that admission for its ONE candidate.
   - This is defence in depth: the 0027 triggers already refuse claims, ops and intent moves, and latch a pristine notify.
9. **Observability / read-only reconciliation**
   - Every run prints codes, hashes and counts only. A STOP exits non-zero, so GitHub's failed-run email to the owner is the alert.
   - **Gap:** `PENDING` exits 0 and would be silent. A new read-only scheduled **status** job (codes and counts, no identifiers) covers it, and also covers M3. It reports:
     - requests by state and age;
     - intents per pipeline state older than N minutes;
     - authorizations older than 5 days not captured;
     - ops `outcome_unknown` / `escalated`;
     - open cases;
     - confirmed intents without a succeeded notify;
     - `pending` refund attestations.
   - Any non-zero "stuck" count exits non-zero, which raises an alert.
10. **Emergency stop** (each layer is independent; most are settings-only and instant)
    1. Clear or alter `E7_TEST_AUTO_ARMED` → every next tick is `CLOSED_NOOP` before any secret.
    2. `gh workflow disable` the kickoff and confirmation workflows.
    3. Add a required reviewer to, or remove the secrets from, the execution environment.
    4. Turn off the Vercel preview TEST webhook switch, so no new requests arrive.
    5. Reviewed CLOSE commit (`executeEnabled` false), the existing permanent stop.

    There is no mid-write cancellation. A stop takes effect at the next admission, and in-flight work completes or stops under its own fences.
11. **Failure recovery**
| failure point | durable state | automatic action | owner |
|---|---|---|---|
| kickoff refused (scope / version / lease) | request `refused` | none | ROOT review |
| dispatch refused / unknown | `dispatch_refused` / `dispatch_unknown` | none (never re-dispatched) | ROOT readback |
| pipeline STOP before any write | intent unchanged; request `dispatch_accepted` | none | ROOT; authorization may lapse → manual void (Stripe dashboard) |
| `reservation_unknown` / `capture_unknown` | STOP | none | read-only reconciliation, then a separately authorized step |
| pipeline PENDING beyond the in-run wait | mid-pipeline | none (S5 later) | status job flags it |
| notify unknown / unverified | durable UNKNOWN; no resend | none | readback only |
| Hostaway cancel after confirm | sent notify preserved | none | C118 parameterized record (manual model) |

## 4. Owner decisions (Joel), separate from implementation
None of these blocks TEST orchestration, because TEST email goes only to the sink. All are needed for live.
| decision | proposed default (for Joel to accept or reject; no policy invented) |
|---|---|
| D-ENV: how unattended runs pass the GitHub environment gate | **(b)** a new environment `e7-test-auto` (main-only deployment branch, no required reviewers, TEST secrets duplicated by Joel). The alternative **(a)** removes reviewers from `e7-readonly-probe`: zero bytes and no cascade, but it un-gates all 19 workflows that use that environment, leaving only their CLOSED source as the gate. Not recommended |
| Confirmation sender | Our gn-v2 email (built, tested, dedupe-guaranteed), with Hostaway direct-booking guest automations kept OFF. Joel said on 2026-11-15 he prefers Hostaway native if it covers direct bookings, and that is still unverified. Whichever is chosen, exactly one sender is on |
| Sender identity / reply-to | No default: the verified domain and reply-to address are Joel's choice |
| Tax line in checkout / confirmation | No default. Accountant decision; the code keeps failing closed (`TAX_POLICY_UNRESOLVED`) |
| Cancellation-policy copy | "moderate" is named; proposed default is to quote the policy text Joel sets on the Hostaway listing, verbatim. Wording to be approved by Joel |
| Live automation level | TEST unattended first; live is a separate decision after the TEST acceptance (§7) |

## 5. Source-digest cascade (why D-ENV matters)
- The pipeline frame `880db5b3` is pinned in four places:
  - the kickoff runner (`pipeline.sourceDigest`);
  - tooling `lib/checkout/pipeline-kickoff-plan.js` (`PINNED_REVISION`);
  - the kickoff workflow's shell check;
  - **SQL**: 0026 binds the literal inside `booking.claim_pipeline_kickoff`.
- Any byte change to the pipeline runner, its tests or its workflow therefore cascades:

  new frame → new tooling pin → migration 0028 (literal rebind, as 0026 did) → schema 28 → new kickoff catalog pin (claim fn src) → confirmation catalog repin (28).
- **Rule of this design: the pipeline bytes are not edited**, except for the one environment-name line D-ENV (b) needs. That one change is done as a single bundled, mechanical cascade, the same shape as C116.
- Kickoff and confirmation frames are not SQL-bound. Their changes (schedule, arm, detect) do not cascade beyond their own frames. The confirmation runner's digest is pinned only in `test/e7-cross-runner-regression.test.mjs`, which is outside every runtime frame (C116).

## 6. Catalog-27 repin of the confirmation runner: required
- `scripts/e7-hosted-booking-confirmation.mjs` admits **exactly schema 26** (`CATALOG_PIN_26`; "21 / 22 / 23 / 24 / 25 / drift refused"). Shared TEST is now at schema 27, so the next confirmation, manual or automatic, is refused at admission. (The POST-27 catalog derived in #189 is `bcc11631…`.)
- **Isolated scope:**
  - add `CATALOG_PIN_27`, derived with the runner's own `CATALOG_SQL` as the runtime app role on PG16 and PG17, and refuse 26;
  - update its runner / workflow tests;
  - update the cross-runner regression frame `0cd953a9…`.
- **Tooling commit `66133a22` and closure digest `6f02ce24…` stay unchanged.** Between `66133a22` and `a314681b` the only lib change is `lib/checkout/intent-api-core.js`, which is in none of the three runner closures.
- **Not affected:**
  - the kickoff catalog: 0027 touches no `pipeline_kickoff` function, and #189's readback reported it unchanged; the slice re-derives it to confirm;
  - the pipeline, which has no catalog pin; 0027 fences act in the DB;
  - the C47 notify-inspect runner, which pins 21–23 only, is read-only and stays stale (noted, not touched).
- If D-ENV (b) is chosen, schema 28 follows. The 28 pin is then one more derived entry made with the same tooling. Repinning 27 now is still useful: it unblocks any manual TEST confirmation in between and puts the derivation in place.

## 7. Evidence-based acceptance
**Offline** (disposable PG16 + PG17, fake providers, real runner cores; no suite churn):
- **A1** schedule × arm variable × mode truth tables: unarmed / mismatched → `CLOSED_NOOP` with 0 secret / SQL / HTTP.
- **A2** confirmation detect: ONE eligible op → fingerprint; NONE; >1 → STOP. Refusals: externally-cancelled, latched, rendered, receipted or leased op. The execute fingerprint must match.
- **A3** catalog: 27 exact; 26 / drift refused.
- **A4** duplicate ticks and races: two detect / execute pairs → one claim, one send.
- **A5** a full chain over fakes: request → dispatch input → pipeline core → confirmed → notify detect → one send → readback.
- **A6** every ambiguous / unknown path → STOP with no further write.
- **A7** digests: frames recomputed. Pipeline `880db5b3` unchanged (under D-ENV (a) / slice 1). Kickoff and confirmation frames exact.

**Hosted TEST** (each a later, separately ROOT-authorized window):
- **H1** armed with zero requests: ≥ 4 ticks per workflow → `NONE`, zero writes; status job clean.
- **H2** ONE fresh TEST checkout (a human enters the Stripe test card), then **zero human clicks**. Readback: 1 create, 1 capture, 1 record, `confirmed`, 1 notify succeeded / attempts 1, 1 receipt, sink only.
- **H3** emergency-stop drill: clear the variable → next ticks `CLOSED_NOOP`.
- **H4** duplicate webhook delivery → one request.
- **H5** a deliberate refusal (an out-of-scope request) → durable `refused` and an alert.

## 8. Slices (smallest first; each its own draft PR, CLOSED, ROOT review)
| slice | content | cascade |
|---|---|---|
| **S1 (proposed first)** | Confirmation runner: catalog-27 repin + a `detect` mode (server-side selection of ONE eligible `booking_confirmed` op, fingerprint, an execute job requiring it), mirroring kickoff C113. Admission also refuses externally-cancelled. **No schedule, no arm variable, no environment change.** Tests A2 / A3 / A4-notify / A7. | Confirmation frame + cross-runner regression only |
| S2 | Arm variable gate + confirmation `schedule` (CLOSED) + kickoff migrated from `E7_KICKOFF_EXPECTED_SOURCE` to the arm | Kickoff + confirmation frames |
| S3 | Read-only status job (observability / M3) | New frame only |
| S4 | D-ENV (b) bundle: environment-name line in the 3 workflows + pipeline cascade (tooling pin, 0028 literal rebind, kickoff pins, confirmation 28) | Full, once, mechanical |
| S5 | Pipeline continuation detector for healthy `PENDING` (new request kind or plan binding) | Needs its own design |

**Why S1 first:** it is required for any next confirmation whatever D-ENV decides. It is self-contained (one runner frame plus one regression test). It touches no SQL and no pipeline bytes. And it removes the last hand-bound identifier (the op id).

## 9. S1 as implemented (DRAFT PR on main; SHIPPED CLOSED)
- **Catalog 27.** The runner admits exactly schema 27; 21–26 and drift are refused (`CATALOG_NOT_27`).
  - The pin is derived with the runner's own `CATALOG_SQL` as the runtime app role on disposable PG16 and PG17 (identical).
  - The same derivation reproduces the schema-23 inspector pin and the C116 schema-26 pin.
  - The catalog equals the #189 POST-27 notification catalog `bcc11631…`.
  - The read path now includes `external_cancellation_public`; the read-path count is 7.
- **Tooling and closure unchanged:** `66133a22` and `6f02ce24…`, recomputed by the existing H3 test.
- **Detect (manual `workflow_dispatch` mode `detect`).**
  - ONE read-only snapshot pages the reviewed `list_guest_notifications`, bounded at 20 × 100 rows (`DETECT_BUDGET` beyond that).
  - Scope: the reviewed kickoff cutoff and exclusions.
  - Classification:
    - **terminal:** SUCCEEDED, LATCHED;
    - **historic** (before the cutoff): counted only;
    - **STOP on:** any other in-scope class, and in-flight or unknown rows of another template;
    - **more than one eligible:** STOP `DETECT_MORE_THAN_ONE`. This is a deliberate **capacity limitation of this TEST slice**, not queue draining.
  - The ONE candidate then passes the unchanged admission in a second read-only snapshot.
  - Outputs: outcome and fingerprint only (fingerprint = the planHash of the server-derived plan).
- **Detect-flow execute.** No hand-bound identifier.
  - It re-selects and requires the same fingerprint; otherwise `NBC_CANDIDATE_CHANGED`.
  - Then the unchanged admission and ONE accepted worker invocation run under the existing claim / lease / latch / receipt / sink-scope fences. Detect is not authority to send.
- **Not in S1:** schedule, arm variable, environment change, pipeline / kickoff / SQL change, activation.
- **Rev 2 (ROOT F1, review comment 6964982942): fact binding.**
  - The fingerprint now also binds the candidate's recipient and render facts. It equals H(planHash, H(factsHash, recipientHash)).
  - Both hashes come from the existing runtime read path `booking.guest_notification_snapshot(op)`: the accepted worker's own observation, granted to the runtime role since 0016, read-only. Its definition is pinned by the catalog-27 `fn` section.
  - Raw recipient, name and facts are discarded immediately and never output or logged.
  - Not ELIGIBLE or a pending SQL refusal → `DETECT_FACTS_REFUSED`; missing or malformed → `DETECT_FACTS_UNREADABLE`.
  - Execute recomputes the binding three times: (a) in the re-selection, (b) right before the ONE worker invocation, and (c) in the worker's existing `afterInitialObservation` hook, after its own snapshot and before any claim.
  - A difference → `NBC_BOUND_FACTS_MISMATCH` with zero sends. When it trips in the hook, the work lease is left to expire (the documented hook-throw residual).
- **Residual window (not closed by S1).** A change committed after (c) is governed only by the accepted worker's existing fences:
  - its claim binds the hashes of its own snapshot;
  - its pre-send observation refuses `FACTS_CHANGED` / `RECIPIENT_CHANGED`;
  - the remaining window is the worker's minimal synchronous section between that pre-send observation and the provider call.
