# Production launch: working plan and state

Owner decisions (Joel, 2026-11-20): domain micasadirect.com; English, USD; 16% IVA + 5% state lodging tax added to every
total; full payment at booking for launch (50% deposit with the balance 60 days before arrival is the first post-launch
upgrade); all catalog listings sell direct; cancellation and refunds are manual (Hostaway, then the Stripe dashboard).
Cancellation policy: 90+ days before arrival, refund less a $250 fee; 89 to 0 days, no refund but a credit (less $250)
toward a stay in the same unit within one year. Claude merges and deploys test work; ChatGPT reviews sprint reports.

## Proven on TEST (2026-11-20)
One booking ran end to end with no human step after payment: kickoff run 44786323065, pipeline 44786599480
(reservation 72064398, capture, record: once each), confirmation 44789242238 (one email, delivered), status OK.

## Design rule for going live
TEST and LIVE are never mixed. Every safety check compares against the CONFIGURED mode ("test" by default) instead of the
literal "test": the database marker (`booking.instance`), the intent's environment, and Stripe's `livemode`. Production
gets its own database (marker `live`), its own GitHub environment and arm variable, and its own keys.

## Slices
| # | Slice | State |
|---|---|---|
| P1 | Taxes (`lib/checkout/tax-policy.js`, migration 0029). Off until `MV_CHECKOUT_TAX_POLICY=mx-iva16-ish5-v1` and 0029 are applied | merged (#237) |
| P2a | Checkout API + webhook take the mode from the gate; LIVE needs the full contract AND `MV_CHECKOUT_LIVE_ACTIVATION=live-payments-approved` | merged (#238) |
| P2b-1 | Reservation, capture, recording and compensation workers: `mode` option ("test" default); database marker, intent environment and payment livemode fences compare against it | merged (#239) |
| P2b-2 | Proofs (`capture-proof`, `compensation-proof`, `recovery-plan`) bind evidence to the intent's own recorded `payment.livemode` (a boolean) instead of the literal `false`; the workers' fences decide which mode may act. Cleanup and mirror stay TEST-only | merged (#240) |
| P2c-1 | Pipeline coordinator: `mode` + one explicit live listing (`coordinatorScope`). A full LIVE happy path passes on the throwaway cluster | merged (#242) |
| P2c-2 | `scripts/mv-pipeline.mjs` core `runPipelineOnce` (config check, marker check, advisory lock, selection by mode / allowlist / state / `notBefore`, per-booking coordinator call) | merged (#243) |
| P2c-3 | `scripts/mv-pipeline-wiring.mjs`, CLI env parsing (`MV_PIPELINE_*`), session-mode database only, `.github/workflows/mv-pipeline.yml` (manual dispatch only; takes effect only once on `main`). TEST wiring complete; not yet run against real providers | merged (#244) |
| P2c-4 | `createE7StripeLiveSend` (restricted live key only, `livemode` true on replies; TEST send unchanged) and LIVE provider wiring in `mv-pipeline-wiring`. No live key exists anywhere and nothing passes mode `live` | this PR |
| P2d-1 | Recipient scope by environment: migration 0030 (`booking.gn_recipient_in_scope` admits a real address only when the marker is exactly `live`; TEST scope unchanged), `isRecipientInScopeFor`, `buildLiveBookingConfirmationRequest`, Resend executor and notification worker take `mode` | merged (#245) |
| P2d-2 | Confirmation step in `mv-pipeline` (bookings in `confirmed` with a queued, never-attempted `guest.notify`) and its Resend wiring | todo |
| P2d-3 | Email text: tax line and the owner's cancellation policy (check 0022 for pinned template hashes first) | todo |
| P3 | Production database (schema at marker `live`, backups), production Vercel env, GitHub environment `mv-live` + secrets | todo |
| P4 | Production checkout page (today only `public/checkout-test.html`), guest-site "Book now", micasadirect.com DNS to Vercel | todo |
| P5 | TEST proof of the new runner with taxes on ($169.40), retire the old armed chain, then one owner-approved live booking | todo |

## P2c design: the unattended chain for production

**What exists (TEST).** Four runner scripts on `main` (kickoff 799 lines, pipeline 1351, confirmation 808, status 476) driven by
GitHub Actions schedules in the `e7-test-auto` environment. Each is bound to the one TEST booking shape:
- `listingId: 606998`, `currency: "USD"`, `dbEnvironment: "test"`, the TEST Stripe account id and the Supabase project ref are constants
  in the pipeline runner and in `lib/checkout/pipeline-kickoff-plan.js` (`PINNED_PLAN_CONSTANTS`, `KICKOFF_SCOPE`, `buildPlan`);
- Hostaway URL allowlists are built from that one listing id; the dispatch transport hard-codes `listingId: 606998`;
- the kickoff request row is written by the 0024 trigger only for TEST / 606998 / USD, and `claim_pipeline_kickoff` carries the
  runner's source and closure digests as SQL literals (0026, 0028), so any runner change needs a migration;
- each runner pins one tooling commit; the arm variable is a digest over the runner files (`scripts/e7-test-arm/manifest.json`);
- the pipeline calls `runTestPipelineCoordinator` (fixed to 606998 / 'test' / livemode false);
- confirmations go only to `.invalid` addresses or the sink `delivered@resend.dev` (`booking.gn_recipient_in_scope`, 0025).

**Decision: do not convert that chain. Add one small runner that reuses the proven parts.**
The safety that matters lives in the workers, proofs, SQL claims and fences (now mode-aware: P2a, P2b). The chain around them
(kickoff request table, per-booking workflow dispatch, plan hashes, digest literals in SQL, arm digest) was built to supervise
one TEST booking at a time and is the part that cannot scale to 28 listings without a migration per change.

`scripts/mv-pipeline.mjs`, one scheduled job per environment:
1. Config from the job's environment: run mode (`test` | `live`), listing allowlist (`id:USD,...`, the same value the checkout uses),
   Stripe account id, Hostaway custom-field id, time zone. Refuses unless the database marker equals the mode.
2. Selects intents in `payment_authorized` (and the in-flight states) for allowlisted listings, oldest first, a bounded number per run;
   one database advisory lock so two runs never overlap.
3. For each: the mode-aware coordinator (P2c-1) runs reservation -> capture -> recording with the existing workers and
   `createPhaseExecutors` (`scripts/e7-connected/executor-adapters.mjs`), write budget 1 / 1 / 1 per intent, the existing protected
   reservation ids refused. Anything ambiguous stops that intent and the job exits non-zero (GitHub emails the owner).
4. Then the confirmation send for bookings that reached `confirmed` (P2d), and a status summary line.
Production: workflow `mv-live.yml`, GitHub environment `mv-live` (main only, its own secrets), schedule every 10 minutes.
TEST: the same script with mode `test` replaces the four armed runners once P5 proves it (then the arm variable is deleted).

**Slices and size.** P2c-1 small (coordinator ~340 lines, mostly constants to config). P2c-2 medium (new ~400-line script, workflow,
DB tests on the throwaway cluster with fake providers). P2d medium (one migration, worker gate, email text). P3 and P4 need the owner
for secrets and are otherwise small to medium. P5 is one TEST payment by the owner.

**Owner actions (Joel), each a form the agent opens, values typed by Joel only.**
- Stripe: create a restricted live key and a live webhook endpoint for the production URL; enter key, signing secret and account id in Vercel Production.
- Production database: choose the project (a separate Supabase project from TEST); enter its connection string where asked (Vercel Production, GitHub environment `mv-live`).
- GitHub environment `mv-live`: enter the Stripe live key, Hostaway token, database URL and Resend key.
- One TEST payment for P5 and one real booking for the final check.

## Known constraints
- The armed TEST runners on `main` pin tooling commits and a release digest (`scripts/e7-test-arm/manifest.json`). Changes on
  `e7-test` do not reach them until the pins are updated; that re-pin is part of P2c / P3.
- The CI job `c119-s4-tooling` has been red since the C136 worker fences (a frozen-`lib` assertion in a one-off 0027 packet test).
- Fenced, never touched: the C120 `outcome_unknown` notification op, the historic notification rows, and reservations
  70636076 / 71045356 / 71072615 / 71081885.
