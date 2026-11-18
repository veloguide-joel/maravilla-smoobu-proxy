# C119 S3 — read-only TEST status / reconciliation runner: design + operator notes (DRAFT, SHIPPED CLOSED), 2026-11-17

**What it is.** `scripts/e7-hosted-status.mjs` plus the manual workflow `.github/workflows/e7-hosted-status.yml`. It **reports** counts and codes and **never repairs** anything.
- `CONSTANTS.readEnabled = false`: `verify` / `status` refuse `STS_READ_CLOSED` from key names only, before any value, import, secret, DB or network.
- Manual `workflow_dispatch` only: modes `preflight` (digests, no secret) and `status`.
- No schedule, no arm. The runner is **outside** the C119 S2 arm release: its frame is in no arm component and the release `12a8f416…` is unchanged.
- Activation wiring (a schedule, arm membership, alerting) is **future, separately reviewed** work.

**How it reads (only existing permissions).**
- The existing runtime secret name `E7_DEV_BOOKING_DATABASE_URL`, the pinned DEV pooler target (runtime app user only), the pinned CA, and the tooling `66133a22` `pool.js` (closure `20e8a125…`).
- ONE `REPEATABLE READ READ ONLY` transaction, always `ROLLBACK`, with session bounds.
- Before any metric: role proof (the runtime app role only; admin / report / owner / superuser refused), the exact schema-27 catalog identity (a labelled copy of the C50 probe + pin), and the TEST instance.
- Fixed SQL only: no input selects an identifier, scope or threshold. Bounded: ≤ 60 statements, ≤ 500 intents in scope (otherwise UNKNOWN, never a partial OK), ≤ 20 × 100 notification pages.
- No grant, migration, secret or provider credential added.

**Scope.** TEST listing 606998; the reviewed kickoff cutoff `2026-11-15T22:58:01Z` and its 3 excluded historical intents.
- Intents are scoped by `created_at`, kickoff requests by `intent_created_at`, notifications by op `created_at`.

**Metrics** (source → statuses):

| metric | authoritative source | WAIT (healthy) | ACTION (stalled / unknown) | INFO |
|---|---|---|---|---|
| kickoff | `pipeline_kickoff_requests` ⨝ `intents` | requested / claimed, recent | requested > 90 min; claimed > 15 min; `dispatch_unknown`; accepted but intent still authorized > 30 min; refused but still authorized; orphan | refused, intent closed |
| pipeline | `intents.state`, `updated_at` | in pipeline or compensating, < 30 min | in pipeline or compensating ≥ 30 min (silent PENDING); `reservation_unknown` / `capture_unknown` / `reconciliation_required` | — |
| authorization | `intents.capture_before` (stored; Stripe unobserved) | authorized, uncaptured | `capture_before` within 48 h; missing → UNKNOWN | — |
| operations | `external_operations` | live `in_flight`; pending < 60 min | `outcome_unknown`; `escalated`; expired `in_flight` lease; non-notify pending ≥ 60 min | — |
| cases | `reconciliation_cases` | — | any open | — |
| work | `intent_work` | live lease | expired lease; work due > 30 min overdue | — |
| notifications | `list_guest_notifications` (class + latch code) + missing-op check | ELIGIBLE < 90 min; WAITING / IN_FLIGHT < 30 min | ELIGIBLE ≥ 90 min (confirmed but unsent); other latch codes; WAITING / IN_FLIGHT ≥ 30 min; UNKNOWN / OTHER / OUT_OF_V1_SCOPE; a confirmed intent with no notify op | latched `EXTERNALLY_CANCELLED` |
| refunds | `external_cancellation_public` (0027 minimal projection) | — | — | pending manual refund (expected owner work; never paged) |

- `SUCCEEDED` confirmations and closed intents are OK.
- **Thresholds are technical, TEST-only heuristics**, not a guest SLA.
- **Overall:** UNKNOWN > ATTENTION (any ACTION) > WAIT > OK. INFO never pages, so the intentionally pending C116 refund does not raise attention.
- **Exit codes:** 1 on ATTENTION / UNKNOWN; 0 on OK / WAIT.
- **Missing / unreadable / malformed data → UNKNOWN**, never zero or healthy. A thrown statement voids all metrics.

**Unobserved (explicit, never inferred).**
- Live Stripe authorization status.
- Live Hostaway reservation status.
- Refund execution in the Stripe dashboard.
- Refund attestation details (admin / report-only tables).
- GitHub run / queue / approval state.
- Anything outside the scope.

**Operator use (later, when separately enabled).**
1. Dispatch `preflight` and note the printed source / closure digests.
2. Dispatch `status` with those digests and approve the `e7-readonly-probe` environment.
3. Read the step summary: per-metric statuses and counts only.
4. ACTION / UNKNOWN items are **investigated manually** with the existing read-only readbacks. Nothing here repairs, releases, refunds or resends.

**Not done / limitations.**
- No hosted run yet; the runner is CLOSED.
- The C119 S2 activation blockers (pipeline admission gap; unverified queued `vars` refresh) are unchanged and unrelated.
