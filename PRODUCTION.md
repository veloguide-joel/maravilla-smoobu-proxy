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
| P2c-4 | `createE7StripeLiveSend` (restricted live key only, `livemode` true on replies) and LIVE provider wiring. No live key exists anywhere | merged (#246) |
| P2d-1 | Recipient scope by environment: migration 0030 (`booking.gn_recipient_in_scope` admits a real address only when the marker is exactly `live`; TEST scope unchanged), `isRecipientInScopeFor`, `buildLiveBookingConfirmationRequest`, Resend executor and notification worker take `mode` | merged (#245) |
| P2d-2 | Confirmation step in `mv-pipeline` (confirmed bookings with one queued, never-attempted `guest.notify`; at most 3 per run; one worker invocation each) and `createConfirmationWiring` (accepted Resend executor / exchange, sender bookings@mail.micasadirect.com). Optional `MV_PIPELINE_RESEND_KEY` | merged (#247) |
| P2d-3 | Email text: tax line and the owner's cancellation policy (check 0022 for pinned template hashes first) | todo |
| P3 | Production database (schema at marker `live`, backups), production Vercel env, GitHub environment `mv-live` + secrets | P3-1 database done (#253); P3-2 todo |
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

## P5 plan: TEST booking with taxes through the new runner (Mon 2026-11-23, 10:00 Mexico City = 16:00Z)

Read-only checks, 2026-11-20 21:40Z:
- Shared TEST database (Supabase `maraVilla Booking DEV`, ref `mxotevtiscernhqilyiu`): marker `test`, applied versions exactly 1..28.
- Open claims on 606998 from today on: Nov 21, 23, 28, 30; Dec 1, 8, 15, 21, 22 (`reserved`); Dec 17 (`authorized`, the fenced C120 row,
  older than any `notBefore` we set, so never selected). Free in the database: Dec 2-7, Dec 9-14. Proposed night: **Dec 10** (re-check
  Hostaway on the morning; the dashboard calendar did not render in the pane today).
- Vercel: the e7-test preview is served by project `maravilla-smoobu-proxy` (it holds every `MV_*` variable, all scoped Preview / `e7-test`).
  `-fia6` and `-eww2` are duplicates of the same repository. `MV_CHECKOUT_TAX_POLICY` is not set anywhere.
- `main` 0244e61c: the old kickoff runs on schedule (`13,43 * * * *`), last four runs green. `main` and `e7-test` are far apart
  (520 commits one way, 44 the other), so a merge is not a small step.

**A. Making the workflow dispatchable.** A `workflow_dispatch` workflow must be on the default branch. Chosen: one small PR to `main` that
adds only `.github/workflows/mv-pipeline.yml`, with an extra required input `ref` (40-hex commit of `e7-test`) used by the checkout step.
Nothing else on `main` changes. The arm digest covers only the files in `scripts/e7-test-arm/manifest.json` (arm gate, kickoff, pipeline,
confirmation: script + tests + workflow each); none of them is touched. Not chosen: merging `e7-test` into `main` (too large for this step;
it happens when the old chain is retired).

**B. One processor per booking.** The old chain picks up every new TEST / 606998 booking, and it re-prices without tax, so a taxed
booking would be refused by it. Before the test the old chain is disarmed: delete repository variable `E7_TEST_AUTO_ARMED` (GitHub web UI).
Its scheduled runs then end `CLOSED_NOOP` (0 SQL, 0 HTTP). Re-arm = re-create the variable with the release digest
(b1d6bb63...22b6 on record; re-read it from the latest armed run log before deleting).

**C. Schema.** Apply 0029 (tax) and 0030 (recipient scope by environment) to the shared TEST database through the SQL editor as the
owner, one transaction, mirroring `db/lib/migrate.js` `migrateUp`: refuse unless marker `test` and versions exactly 1..28;
`set_config('booking.migration_environment','test',true)`; the migration bytes; one `booking_migrations.applied` row each (version,
name, up / down sha256, environment); then a readback (versions 1..30). Both are additive: untaxed prices stay valid, TEST recipient
scope is unchanged. The old runners pin the schema-28 catalog and will refuse on schema 30 (fail-closed), which is consistent with B.
Order: B first, then C, so the old chain does not raise alarms.

**D. Vercel** (after C): `MV_CHECKOUT_TAX_POLICY=mx-iva16-ish5-v1`, Preview, branch `e7-test`, project `maravilla-smoobu-proxy`; redeploy.
Check: the checkout quote for one night on 606998 shows $140.00 + $29.40 tax = **$169.40**.

**E. GitHub repository variables** (not secrets): `MV_TEST_PIPELINE_LISTINGS=606998:USD`, `_NOT_BEFORE=<instant of B>`,
`_STRIPE_ACCOUNT=acct_1TyHE42B9LTneQgw`, `_REF_FIELD_ID=105433`, `_TIME_ZONE=America/Mexico_City`, `_ACCOUNT_REF=hostaway-e7-test`.
Secrets already exist in environment `e7-test-auto`. Then one empty dispatch (no bookings): expected `OK`, all counts 0. That is the
runner's first contact with the real database.

**F. Monday.** Owner: open the TEST checkout, night Dec 10, confirm the page shows $169.40, pay with the Stripe TEST card, guest
email the sink address. Claude: check the stored booking and the Stripe authorization are $169.40, dispatch `mv-pipeline` (mode test),
then verify one Hostaway reservation, one capture of $169.40, one recording, one confirmation to the sink, and a second dispatch that
does nothing.

**G. Going back.** Remove the Vercel variable and redeploy (prices return to untaxed). The old chain cannot simply be re-armed at
schema 30: it would need the 0030 and 0029 down migrations (TEST only, and 0029 down fails once a taxed price row exists). In practice the
fallback is fixing the new runner; the workers, proofs and fences under it are the ones proven on 2026-11-20.

Owner go-ahead for B and C: given 2026-11-20 ("Go").

**Done 2026-11-20:**
- B: repository variable `E7_TEST_AUTO_ARMED` deleted (owner confirmed GitHub access with his passkey), between 21:57Z and 22:26Z.
  Value before deletion: b1d6bb6395205f59f4c6dc7a0629edc6b3c6aaada7a0415a155745a3b84822b6 (equal to the recorded digest).
- C: 0029 + 0030 applied 22:28Z in one transaction through the SQL editor (script sha256 00c9833c...7485, checked in the page before
  running; precheck marker `test` and versions exactly 1..28). Readback: versions 1..30, rows 29 `price_tax` (up c7bf74acd99c...) and
  30 `gn_live_recipient_scope` (up 6ed5c3325f63...), environment `test`; 20 intents, 0 taxed; `gn_recipient_in_scope` is STABLE, refuses a
  real address and admits the sink; column `tax_minor` exists.
- A: PR #249 merged to `main` (cc210027): only `.github/workflows/mv-pipeline.yml`, inputs `mode` and `ref`.
- D: `MV_CHECKOUT_TAX_POLICY=mx-iva16-ish5-v1` created (Preview, branch `e7-test`, project `maravilla-smoobu-proxy`).
- E: the six `MV_TEST_PIPELINE_*` repository variables created (`_NOT_BEFORE` = 2026-11-20T22:30:00.000Z).
- First run of `mv-pipeline` against the real TEST database: run 44829950271 (main cc210027, ref bf254e92), success,
  `{"mode":"test","outcome":"OK","code":"NOTHING_TO_DO"}`, all counts 0.
- Quote check on the redeployed e7-test preview (Dec 12-13, 1 guest, unpaid intent that expires on its own): Accommodation $100.00,
  Cleaning $50.00, discount -$10.00, Taxes $29.40, total **$169.40**.

Remaining for Monday: step F only.

## P3-1: production database

Supabase project **MiCasaDirect Production**, ref `ewfkrzuwdkbkjeeztzsv` (created by the owner 2026-11-20). TEST stays
`mxotevtiscernhqilyiu`; `scripts/mv-db-setup.mjs` refuses that ref.

`scripts/mv-db-setup.mjs` + `.github/workflows/mv-db-setup.yml` (manual dispatch, environment `mv-live-admin`), one run as the schema
owner over the session pooler with the pinned CA:
1. every migration with environment `live` (`db/lib/migrate.js`; repeatable, forward only);
2. runtime login `mv_booking_app_live` (member of `mv_booking_app` only, no elevated attribute, role timeouts 5s / 10s);
3. its password is set by sending the SCRAM-SHA-256 verifier computed in the job (checked in tests against PostgreSQL's own hashing);
4. a login as that role proves identity, marker `live`, the timeout, and that the migration table is denied.

Owner inputs (pasted by the owner into GitHub, never seen by Claude): secrets `MV_LIVE_DB_OWNER_PASSWORD` (the database password
from project creation) and `MV_LIVE_DB_APP_PASSWORD` (a new one, 32 letters and digits). Variables: `MV_LIVE_DB_HOST`,
`MV_LIVE_DB_PROJECT_REF`. The runtime URL for Vercel production and for `mv-pipeline` live is
`postgresql://mv_booking_app_live.<ref>:<app password>@<host>:6543/postgres` (P3-2).

**Done 2026-11-20 23:0xZ:** run 44833976104 (`mv-db-setup`, action setup, ref 0cc6774d, main dea22865), host
`aws-0-us-east-2.pooler.supabase.com`: `{"outcome":"OK","code":"READY","migrationsRun":30,"applied":30,"roleCreated":true,
"checks":{"identity":true,"marker":true,"statementTimeout":true,"migrationTableDenied":true}}`. Environment `mv-live-admin` holds the
two secrets (entered by the owner).

