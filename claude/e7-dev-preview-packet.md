# E7 DEV / preview enablement — execution packet (OFFLINE preparation)

Status: preparation only. **Nothing here is approval.** No database query, Vercel setting, env value, webhook, deploy or provider call was made to write this. Branch `feature/e7-dev-preview-packet` from exact accepted `6d703acdcfa205138d1ce4ba65b2ec58fc9493c9`.

> **Status 2026-11-05 (final preparation; for root review, then ONE ask to Joel).** Infrastructure execution is CLOSED until the §9 package is approved. All earlier provider approvals are consumed. Nothing in this file was executed.
> - **Main** = `5b60d705ddf08e5f5db41cf93483a5988fa80f83`. It contains:
>   - **C**, the cleanup runner (PR23, `460b2879`; closure `ce0a418a…923c8f`, runner `eb3fc63c…6c62`);
>   - **the DEV db-smoke wrapper** (PR24, `58adc5e6`; closure `45b512b0498d82c329e9c05edde165e242a9910fbeac533644cf926f890af5ca`, runner `0d697185a88e91457c285033c7e7dcb6d9a60182820af7baf6a716a420e22ec1`).
>   
>   Both are **merged but NOT activated**: no dispatch, no environment secret, no DB connection. The smoke's `connectivityEvidence` field stays `false` by design; only an actual run's `SMOKE_PASS` / checks count as evidence.
> - **Fixed tooling** for both: `6d703acdcfa205138d1ce4ba65b2ec58fc9493c9`.
> - **P** (`feature/e7-preview-config` `6d00d0d6c7ac63b77d703f8c212381109096723c`) is accepted, but **NOT deployed**. `e7-test` does NOT exist.
> - **Route B** (`feature/e7-routeb-editor-scripts` `fc2f4b914da184a6be9769bd2e6ca8121bf39deb`) is accepted OFFLINE: scripts 06–16, `pre_verify.sql` `14b5126d…5d77`, `post_verify.sql` `ca573041…e6d0`, manifest `d3ee22af…1f06`. It is unmerged and never run.
> - **Target** `mxotevtiscernhqilyiu` is **UNVERIFIED**: its schema, data, logins and the availability of the runtime password are not known now.

**Labels.** **[obs]** observed (date / source). **[hist]** historical report only, not current state. **[repo]** read from the repo at `6d703acd`. **[owner]** needs the owner. **[gap]** needs reviewed code before use.

> **Corrections after root review of `d7476990` (2026-11-05).** Infrastructure execution stays CLOSED. No protection exception is authorized.
> - Gap C is implemented: branch `feature/e7-checkout-test-cleanup-runner` `a522bfc6`, runner `claude/e7-checkout-test-cleanup.md`.
> - Gap P is implemented: branch `feature/e7-preview-config` `6d00d0d6`, 2 files.
> - The deployment branch `e7-test` is NOT created.
> - Hosted schema and the exact Vercel alias stay **unverified until observed**.
> - §2 / §3 now have distinct PRE and POST assertions.
> - A missing auto-preview is a diagnosable deployment issue (a separately authorized manual deploy stays possible).
> - The salt and the CA no longer need Joel.
> - No new restricted Stripe key: the existing approved `sk_test_` credential is owner-entered later.
> - Route B is preferred, so there is no owner terminal; its script generation / review is a separate offline step, and nothing is executed now.

## 0. Fixed inputs

| Item | Value |
|---|---|
| Checkout lineage | commit `6d703acdcfa205138d1ce4ba65b2ec58fc9493c9`, tree `50908f9f890dae69916ced9c5be676262c5253a7` [repo] |
| Supabase DEV | project **maraVilla Booking DEV**, ref `mxotevtiscernhqilyiu`, us-east-1, PG 17.11 [hist 2026-10-21] |
| Hosted schema | **UNKNOWN now.** Dated reports only: 0001–0005 applied 2026-10-21; runtime login `mv_booking_app_dev` Smoke 1 22/22 on 2026-10-22 [hist] |
| Vercel | project `maravilla-smoobu-proxy`, team `joel-goralskis-projects`, region iad1, previews `ssoProtection: all_except_custom_domains`, 0 bypass entries [obs 2026-11-05] |
| Listing | `606998`, USD only (`MV_CHECKOUT_TEST_LISTINGS=606998:USD`) |
| Stripe | TEST account `acct_1TyHE42B9LTneQgw`; checkout / webhook clients pinned to `2026-01-28.clover` [repo] |
| R-REFUND | **CLOSED for the observed profile** (TEST, manual capture, card, clover). Run 42091575058: canceled $1.00 PaymentIntent, charge `captured:false`, `amount_captured` 0, `amount_refunded` 0, `refunded:false`. No proof change. Not universal for all cards / accounts; not live readiness |

## 1. Migrations 0006–0016 (order = version; checksums as the runner computes them, SHA-256 of file text) [repo]

| v | name | up SHA-256 | down SHA-256 | built-in precondition |
|---|---|---|---|---|
| 6 | api_rate_limits | `2ab8bd93af1671b5017ab896cb6faf0a78ab0875a3fd2c723ccbefe2a90b0183` | `ae746d4556b9ff0699bfce998805096dc6aa4dcf212641d3153c58f546522658` | unique index on `intents.access_token_hash` (fails on duplicates) |
| 7 | capture_claim_fence | `ef46bdc35d98e9a2b38a1effaf767afa07e4a77eac1cce233c6762ce02c3bd9e` | `512b93ea7c0cf7dfce3900966ef8b0dd333dab523f6cb9f986b21b30533c1273` | — |
| 8 | settled_evidence_immutable | `2ecedc65abc1c51c4967f480df211611d987378caf81ce283b160ff849b6f903` | `301ab430f27710e2a15c5d2d2d39e5c06f2ffe446d43469bdf63f76cfa708cd4` | — |
| 9 | void_cancel_claim_fence | `868adf98dacab345fbcfdf544c09d305f26956b850836a164a3601161011bc8d` | `cffb3d0997ccf37599b29f583d7d4ecb252804d66c292faa5815c67152b46fe5` | — |
| 10 | recording_evidence_link | `55244bf157b527bfbb0119fcb21979996ebbad454c1a154ed926f1a64b67e727` | `232575bca986ef123a6ac95d356ab8f42a671a17711282b30277d6a0046e09d3` | — |
| 11 | recording_owner_cases | `2448821d93093c32c4cb4d5cb58aaf81a633ab5cd64b5c0025213e73fe573762` | `79cb74d8b8345218f8e2fb840207213c59c9ee744826d5b9a2952c3ddf1d565a` | no `OFFLINE_CHARGE_HOLD_*` case exists |
| 12 | recording_assessments | `1b782b2027ed4d71f3714a97ef3f1d71829f7e552ed8da91f30c54c841a93ec1` | `947927e827f9e715f09401bf26b114ae85ebeed0b930f0f89fc919b50c55ca19` | 0011 applied |
| 13 | recording_preflight_release | `d9d8b4c2c677c764a0e6e8e615feb783c37d7c3226ac5b99a2ab8d8a227db239` | `db63c94eadbb9ea2058e1e100153a9c85a18ea4d7844c06082e5f523a3b3feb2` | 0012 applied |
| 14 | recording_completion_binding | `a8b27725fe58719daf61810814e3e98af3e417eb2a1a2956b59e8cccc4c2e633` | `79cee8a954732941abd21bc2ee45c8812ca13955cd3e2aeecb20ed0f59b009bf` | 0013 applied; no linked claimed recording with unbound proof |
| 15 | scoped_recording_inbox | `79e86a3017debee9da43d45a41d313ce8658044a05b40a43f62726f7c8777365` | `45f1b72880873099b8e55a2e726971fa8ad31028be83aca1e9c6bddf26624cb4` | 0014 applied |
| 16 | guest_notification_fence | `085fe788b7cef561bf7504c887347a4705b749b317584ab8ddcea465dd400975` | `8f4def170b0e1733ceefc4ddae4ad6d2d73b504cefb2156951cfc88e5b675665` | 0015 applied; every `guest.notify` row canonical, never attempted, one per intent |

- The 0001–0005 checksums at `6d703acd` equal the values recorded on the hosted history in 2026-10-21 [hist]. Drift would make the runner stop (`CHECKSUM_MISMATCH`).
- **Caveat.** Every 0006–0016 header says "DISPOSABLE LOCAL test databases only". Applying them to hosted DEV is itself the decision this packet asks for. 0006 says it may be "amended in place before any persistent use"; after hosted application, any change must be a NEW migration.
- **Down.**
  - `down` is DEV/test only (refused for `live`) and reverts strictly from the latest version.
  - 0011–0016 downs restore earlier function bodies verbatim; 0006 / 0011 / 0012 / 0016 downs drop their tables and audit rows.
  - It is never part of this package. Any rollback is a separate owner decision, per version, after a read-only status.

## 2. Step D1 — READ-ONLY preflight (first action; STOP on any unexpected value)

Where: the Supabase dashboard SQL editor of `mxotevtiscernhqilyiu`, in the owner's signed-in browser. Before running, check the URL ref and title. It runs as `postgres` in one `READ ONLY` transaction that is always rolled back. It reads aggregates only; no guest data is selected.

```sql
BEGIN READ ONLY;
SELECT current_database() AS db, current_setting('server_version') AS pg,
       (SELECT count(*) FROM booking.instance) AS instance_rows, (SELECT environment FROM booking.instance) AS env;
SELECT version, name, up_checksum, down_checksum, environment FROM booking_migrations.applied ORDER BY version;
SELECT rolname, rolcanlogin, rolsuper, rolbypassrls, rolcreaterole FROM pg_roles WHERE rolname LIKE 'mv\_booking%' ORDER BY 1;
SELECT r.rolname AS member, g.rolname AS member_of FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member
  JOIN pg_roles g ON g.oid = m.roleid WHERE r.rolname LIKE 'mv\_booking%' ORDER BY 1, 2;
SELECT to_regclass('booking.api_rate_limits') AS t0006, to_regclass('booking.recording_holds') AS t0011,
       to_regclass('booking.notification_renders') AS t0016, (SELECT extversion FROM pg_extension WHERE extname = 'btree_gist') AS btree_gist;
SELECT (SELECT count(*) FROM booking.intents) AS intents, (SELECT count(*) FROM booking.intent_guests) AS guests,
       (SELECT count(*) FROM booking.payment_attempts) AS attempts, (SELECT count(*) FROM booking.external_operations) AS ops,
       (SELECT count(*) FROM booking.external_operations WHERE op_type = 'guest.notify') AS notify_ops,
       (SELECT count(*) FROM booking.reconciliation_cases) AS cases,
       (SELECT count(*) FROM booking.reconciliation_cases WHERE starts_with(kind, 'OFFLINE_CHARGE_HOLD_')) AS reserved_cases,
       (SELECT count(*) FROM booking.stripe_webhook_events) AS webhook_events, (SELECT count(*) FROM booking.inventory_claims) AS claims,
       (SELECT count(*) - count(DISTINCT access_token_hash) FROM booking.intents) AS duplicate_token_hashes;
ROLLBACK;
```

**PRE (before any upgrade) expected baseline, all of these or STOP:**
- `env = test`, 1 instance row, PG 17.x, `btree_gist` present;
- applied history is exactly 1–5, with the five recorded checksums and environment `test` each;
- `t0006` / `t0011` / `t0016` are NULL;
- roles `mv_booking_admin` / `mv_booking_app` / `mv_booking_report` are NOLOGIN, and `mv_booking_app_dev` is LOGIN and a member of `mv_booking_app` only; none is superuser, BYPASSRLS or CREATEROLE;
- **data counts: the hosted data is UNVERIFIED.** The counts are reported and recorded as the before-baseline; nothing assumes them to be 0. An unexpected data row (anything the approved run did not foresee) STOPS here for review.
- **other logins:** `other_logins_in_booking_groups` (`pre_verify.sql`) is REPORTED. Any value other than empty needs explicit human / root review. It is never treated as an automatic all-ok authorization.

Anything else (a version > 5, an unexpected data row, an unreviewed other login, a different checksum) stops here. The finding is reported; there is no replay and no repair.

## 3. Step D2 — conditional DEV upgrade (only after D1 matched; reuses the existing tooling)

Two routes; the package picks ONE.

- **Route A (fallback only; owner terminal).** The reviewed runner itself, run in a private terminal with the migration credential, the same way as Smoke 1:
  ```
  # from a clean checkout of 6d703acdcfa205138d1ce4ba65b2ec58fc9493c9, Node 22, CA file prod-ca-2021.crt (SHA-256 700723…f3b7)
  node scripts/db-migrate.mjs status --env test --url-env MV_DEV_DB_URL --allow-remote --ca-file prod-ca-2021.crt   # expect applied [1..5], pending [6..16]
  node scripts/db-migrate.mjs up     --env test --url-env MV_DEV_DB_URL --allow-remote --ca-file prod-ca-2021.crt   # expect {"applied":[6,...,16]}
  node scripts/db-migrate.mjs status --env test --url-env MV_DEV_DB_URL --allow-remote --ca-file prod-ca-2021.crt   # expect applied [1..16], pending []
  ```
  - The runner re-verifies the history and checksums under an advisory lock before every version. It applies one transaction per migration and stops at the first error, leaving the earlier versions committed.
  - `status` runs `CREATE SCHEMA/TABLE IF NOT EXISTS` and `REVOKE ... FROM PUBLIC` on the existing bookkeeping. These are no-ops, but not strictly read-only, which is why D1 is plain SQL.
  - **[owner]** This needs the owner's migration credential (`MV_DEV_DB_URL`) in his own terminal. It is never given to Claude.
- **Route B (PREFERRED: no owner terminal, no credential handling; the 0001–0005 precedent).** SQL-editor scripts are generated offline by the committed NEW generator `scripts/e7-routeb-gen.mjs` (built-ins only; SHA-256 and every output hash in `claude/evidence/e7-routeb-editor-scripts-2026-11-05.md`). Each script wraps one migration verbatim in ONE transaction with the runner's advisory lock (`7302215001`), an exact prior-history guard (versions, names, up/down checksums, environment `test`), the `booking.instance = test` check, `set_config`, and the history INSERT.
  - Before any Run, root reviews each script's SHA-256, and the editor content is hash-checked.
  - `pre_verify.sql` (expects 1–5) before 06; one Run per script, 06 → 16; `post_verify.sql` (expects 1–16) after 16. All verification is read-only.
  - **Stop at the first error, or whenever the submission / COMMIT outcome is uncertain:** run `ROLLBACK;`, then inspect history read-only. Never re-run blindly. The editor is not exactly-once.
  - The historical generator `e3ea1ffc…` was not restored and is not claimed.

**POST (after D2) expected, all of these or STOP** (re-run the §2 SELECTs; the PRE expectations for history and new tables do NOT apply):
- `env = test`, 1 instance row;
- applied history exactly 1–16, with the §1 checksums (1–5 unchanged) and environment `test` each;
- `t0006` / `t0011` / `t0016` are NOT NULL;
- roles unchanged (same NOLOGIN groups; `mv_booking_app_dev` LOGIN, member of `mv_booking_app` only);
- the `data_counts` row is reported and compared before / after: it must equal the D1 counts (no data volume is assumed); any difference STOPS;
- `other_logins_in_booking_groups` is unchanged from D1 and stays a human / root review item;
- the `post_verify.sql` privilege matrix, function grants and RLS checks are all `ok`.

**Then:**
- the D1 SELECTs again (history 1–16 with the table above, `env = test`, the same data counts as D1);
- then the existing read-only smoke from `6d703acd`, UNCHANGED, whose privilege matrix covers through 0016. It runs through the hosted read-only wrapper `e7-dev-db-smoke` (merged to main `5b60d705` via PR24; **not dispatched**; doc `claude/e7-dev-db-smoke.md` on main). The wrapper runs exactly:
  ```
  scripts/db-smoke.mjs --url-env E7_DEV_BOOKING_DATABASE_URL --ca-file <pinned CA> --expect-role mv_booking_app_dev --env test   # read-only; never --write-probe
  ```
  It uses the runtime-login secret `E7_DEV_BOOKING_DATABASE_URL` only (no owner terminal or credential). It reports `SMOKE_PASS` only for exit 0 and every one of the 22 expected checks passed.
  - **The smoke is stricter than POST.** It requires empty data (only the instance row and the 51-row assessment seed). A non-empty DEV database therefore FAILS the smoke; data is never cleared or relaxed to make it pass.
  - The catalog-only `post_verify.sql` is not proof of the runtime login or TLS. The wrapper is not proof until it is separately approved and dispatched.

## 4. Preview: branch, alias, env

- **Branch.** `e7-test` (NOT created yet). **Intended source = `6d00d0d6c7ac63b77d703f8c212381109096723c` exactly** = accepted code `6d703acd` + docs-only `d7476990` + P. No new commit is needed. The Route B / packet doc commits are not deployed. Root confirms this source at approval time, and if it changes, the hash is restated. No merge to main.
  - The alias (and so every origin / return / webhook URL below) is **PROVISIONAL until observed** after the push. It stays short, so it is not truncated: `https://maravilla-smoobu-proxy-git-e7-test-joel-goralskis-projects.vercel.app` (58-character label). Name free [obs 2026-11-05].
  - Verify after the push that Vercel built a READY preview for exactly that sha, and observe the real alias before entering any origin / return URL. The alias above is the expected form, **unverified**.
  - Recent accepted heads had no auto-preview [obs]. A missing build is a diagnosable deployment issue: report it. A manual deploy of that exact sha needs its own approval; it is not banned.
- **Env** (Vercel → Settings → Environment Variables, **Preview, Git branch = `e7-test` only**). Production and Development are untouched.

| name | value | kind |
|---|---|---|
| `MV_STRIPE_TEST_WEBHOOK` | `enabled` | non-secret |
| `MV_CHECKOUT_TEST_API` | `enabled` | non-secret |
| `MV_CHECKOUT_TEST_RELEASE` | `enabled` | non-secret |
| `MV_CHECKOUT_ALLOWED_ORIGIN` | `https://maravilla-smoobu-proxy-git-e7-test-joel-goralskis-projects.vercel.app` | non-secret |
| `MV_CHECKOUT_RETURN_URL` | `https://maravilla-smoobu-proxy-git-e7-test-joel-goralskis-projects.vercel.app/checkout-test.html` | non-secret |
| `MV_CHECKOUT_TEST_LISTINGS` | `606998:USD` | non-secret |
| `MV_CHECKOUT_TERMS_VERSION` | `test-terms-2026-11` (TEST label only; it matches the page meta after commit P and is **not** real booking terms) | non-secret |
| `STRIPE_TEST_ACCOUNT_ID` | `acct_1TyHE42B9LTneQgw` | non-secret |
| `BOOKING_DATABASE_CA_PEM` | full text of Supabase `prod-ca-2021.crt` (SHA-256 `700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7`) | public CA |
| `BOOKING_DATABASE_URL` | `postgresql://mv_booking_app_dev.mxotevtiscernhqilyiu:<owner>@aws-0-us-east-1.pooler.supabase.com:6543/postgres` (runtime login only, transaction pooler) | **secret, [owner]** |
| `STRIPE_TEST_SECRET_KEY` | a TEST key of `acct_1TyHE42B9LTneQgw` (`sk_test_…` or a restricted `rk_test_…`) | **secret, [owner]** |
| `STRIPE_TEST_WEBHOOK_SECRET` | the signing secret of the §5 endpoint (`whsec_…`) | **secret, [owner]** |
| `MV_RATE_LIMIT_SALT` | 48 random bytes, base64 (CSPRNG) | secret (not a credential); generated and stored without display. **The mechanism is OPEN: execution handoff §9 0.3** |

- **Already present and reused** [obs]: `HOSTAWAY_ACCOUNT_ID`, `HOSTAWAY_CLIENT_SECRET` (Preview + Development) for the read-only pricing of 606998; `HOSTAWAY_DIAG_KEY`, `BOOKING_UI_ORIGINS`. **Left unset:** `MV_CLIENT_ADDRESS_SOURCE` (default `none`), `BOOKING_RETENTION_*` (code defaults).
- **Secrets, reuse vs new.**
  - The GitHub environment secret `E7_STRIPE_TEST_KEY` cannot be copied into Vercel by anyone but the owner. Its value is never read or moved.
  - The DB password of `mv_booking_app_dev` was set by the owner on 2026-10-22 [hist] and would be reused as is; no new role. Whether Joel still holds it is **not assumed**: if not, the run stops at §9 2.1, and a reset is a separate ask.
  - The webhook secret only exists once §5 is done.
  - `STRIPE_TEST_SECRET_KEY`: the existing approved `sk_test_` credential of `acct_1TyHE42B9LTneQgw`, owner-entered later (no new restricted key, no account test).
  - The CA is public and pinned by SHA-256, so Claude enters it after the hash check.
  - No value is entered or shown by Claude.

## 5. Stripe TEST webhook and the protection path

- **Endpoint** (Stripe dashboard, TEST mode, account `acct_1TyHE42B9LTneQgw`) **[owner]** (reveals a signing secret):
  - URL `https://maravilla-smoobu-proxy-git-e7-test-joel-goralskis-projects.vercel.app/api/checkout/stripe-webhook`;
  - API version `2026-01-28.clover`;
  - events **exactly** `checkout.session.completed` and `checkout.session.expired`.
  - Not `payment_intent.payment_failed` (ignored as informational) and not the async events, which the handler treats as unexpected (503).
- **Protection (production unchanged).** Stripe cannot log in to Vercel, and Stripe does not follow redirects. Two narrow options:
  1. **Recommended: a Deployment Protection Exception for exactly the OBSERVED `e7-test` alias** (provisional until observed; plan availability and behaviour must be re-checked in the current official Vercel docs before execution, §9 0.1). This is a real security decision and needs action-time consent.
     - **Scope:** that one domain becomes public; every other preview and every per-deployment URL stays protected; production is not touched; removing the exception reverts it.
     - **Side effect:** anyone with the URL can open the TEST page and API.
     - **Mitigations already in code:** production 404 before anything runs; exact-origin CORS; per-token and global rate limits; TEST key and account binding; listing allowlist 606998 only; DEV database only; no Hostaway write route; no notification sender; `noindex`.
  2. **Alternative: Protection Bypass for Automation**, with the secret as the `?x-vercel-protection-bypass=` query parameter of the Stripe endpoint URL.
     - **Scope:** project-wide (all deployments), and the secret sits in the Stripe dashboard. Broader, so not recommended.
- **Not used:** Shareable Links (redirect plus cookie, which Stripe won't follow); weakening production; disabling protection.

## 6. Owner cleanup execution (so a TEST release does not strand a hold)

> **Superseded:** C is implemented, accepted and merged (main `91e20666`, now in `5b60d705`); see `claude/e7-checkout-test-cleanup.md`. It is NOT activated. Using it belongs to the later guest TEST package, not to §9. The text below is the original proposal.

- **Finding: no reviewed hosted mechanism exists.**
  - The accepted `runCleanupStep` (compensation worker) and the executor adapters exist [repo].
  - `scripts/e7-connected/run-core.mjs` is an offline core: no CLI, transport, credential or journal.
  - Nothing runs the worker against DEV / Stripe today.
  - Without it, a released TEST authorization stays `reservation_failed`, with the void queued and the claim held, until Stripe expires the hold (about 7 days). **Not ready.**
- **Implemented offline as `a522bfc6` (awaiting root code review); the design below is as proposed.** Smallest slice C (main-side runner, the evidence-runner pattern; no E7 merge to main):
  - `scripts/e7-checkout-test-cleanup.mjs` + `test/…` + DRAFT `.github/workflows/e7-checkout-test-cleanup.yml` + note.
  - The workflow checks out the accepted E7 lineage (`6d703acd` or its reviewed successor) as fixed "tooling", verifies a framed digest of the cleanup closure before import, and runs **`runCleanupStep` for ONE named intent id**, bounded to ≤ 8 steps, which is at most ONE void plus reads.
  - Executors: Stripe via accepted T (`accounts.retrieve`, `paymentIntents.retrieve` with expanded charge, `paymentIntents.cancel` with the worker's `void:` idempotency key). The Hostaway keys are refusing stubs; a release has no reservation, and a call fails closed.
  - Gate env label `VERCEL_ENV=development` with `MV_E7_COMPENSATION_WORKER=enabled`; listing map `606998 → USD, America/Mazatlan`.
  - Preflight / verify / execute and the hashes are as in `e7-canceled-pi-evidence`; execute is main-only, in environment `e7-readonly-probe`, once per approval.
  - **Secrets:** existing `E7_STRIPE_TEST_KEY` (reused, `sk_test_`) plus **one new GitHub environment secret** for the DEV runtime DB URL, which is the same login as the preview **[owner]**.
  - **Output:** whitelisted codes, intent status, void op state, claim released yes/no, sends count.
- Scope estimate: 4 new files on a new branch from main. Implementation awaits root scope approval.

## 7. Preview-config commit P (accepted: `feature/e7-preview-config` `6d00d0d6`, from `d7476990`; not deployed)

- `public/checkout-test.html`: `<meta name="mv-test-terms-version" content="test-terms-2026-11">`.
- `test/e7-checkout-test-page.test.mjs:210`: the pin changes from `content=""` to exactly that value, i.e. the TEST label, documented as a deployment input.
- No other change. Containment and packaging allowlists are unchanged.

## 8. Order of work

1. ~~Root scope decisions on P / C / Route A vs B~~ — done: C and the smoke are merged; P is accepted; Route B is chosen and accepted offline.
2. **Now:** root reviews §9 and presents ONE ask to Joel.
3. After the approval: §9 runs once, in order, and stops at the first stop point.
4. Only after the infrastructure is ready: a separately named **guest TEST package** (authorize → release → cleanup runner → verified release). It is NOT part of §9.

## 9. Infrastructure approval package — run sheet (DRAFT; CLOSED until approved)

**Scope ceiling.**

- Allowed: the DEV database `mxotevtiscernhqilyiu`; the Vercel project `maravilla-smoobu-proxy` (Preview, branch `e7-test` only); GitHub environment `e7-readonly-probe`; Stripe TEST account `acct_1TyHE42B9LTneQgw` (one webhook endpoint, `2026-01-28.clover`).
- **Not in scope:**
  - any guest authorization, Checkout session, release, cancel / void, cleanup execution, capture, refund or payment write;
  - any Hostaway reservation or write, protected refs `70636076` / `71045356` / `71072615` / `71081885`, email / notification;
  - any production env or deploy;
  - merging E7 into main;
  - any down / reset / repair;
  - rotating or removing a credential.
- **Hostaway:** no call is included. The existing Hostaway Preview env stays as is, and no listing / calendar / price connectivity is claimed. Pricing reads happen only later, inside the guest TEST package.
- **Stop rule:** at any stop point, Claude reports and does nothing further. There is no retry, rerun, fallback or second dispatch.

**Who.**

- **Root** confirms the hashes at each gate.
- **Claude** acts in the signed-in browser sessions. Claude never views, types or prints a secret value.
- **Joel** enters secrets only, and approves the GitHub environment gate when the step comes. If a site needs a login, Claude tells Joel what to log into; Claude does not log in for him.

### Phase 0 — before anything runs (no execution)

| # | action | who | stop if |
|---|---|---|---|
| 0.1 | Re-read the current official Vercel docs for: branch-scoped Preview variables (including whether a not-yet-existing branch can be targeted); the Deployment Protection Exception (scope, plan, removal); redeploy semantics. **Docs only; no dashboard probing** | Claude → root | the docs contradict §5 / this sheet; the sheet is then corrected before anything runs |
| 0.2 | Confirm the preview source `6d00d0d6` and the Route B hashes (evidence note on `fc2f4b91`) | root | any hash differs |
| 0.3 | **Salt mechanism (execution handoff, NOT solved).** `MV_RATE_LIMIT_SALT` (≥ 32 characters; the intent API refuses without it) must be generated and stored without display. No Vercel connector or CLI with a token is verified for Claude in this session, and Claude may not type secrets into fields. The options are listed under the owner handoff. Root picks one before step 3.4 | root (+ Joel if option b) | no mechanism chosen: step 3.4 waits; nothing else is affected |

### Phase 1 — DEV database (read-only first; conditional upgrade)

| # | action | who | stop if |
|---|---|---|---|
| 1.1 | Open the Supabase SQL editor of **`mxotevtiscernhqilyiu`** (check the ref in the URL and the project title). Run `pre_verify.sql` (read-only, 14 rows), then the §2 D1 SELECTs | Claude (Joel's signed-in Supabase dashboard in the built-in browser) | any `ok` ≠ true; history ≠ exactly 1–5 with the recorded checksums; env ≠ `test`; roles differ; `other_logins_in_booking_groups` non-empty (it needs human / root review, never auto-OK); **any data count ≠ 0** (unexpected data STOPS: the hosted data was never assumed empty, and the smoke would fail anyway). No repair, no credential change |
| 1.2 | Record the D1 counts as the before-baseline | Claude | — |
| 1.3 | Only if 1.1 matched: paste scripts **06 → 16**, each after checking its SHA-256 against the evidence note. Each script goes in as ONE submission, once, in order | Claude | any error, or an uncertain submission / COMMIT: run `ROLLBACK;`, inspect history read-only (`post_verify.sql` / `pre_verify.sql`), report. **Never re-run blindly**, never run down / reset |
| 1.4 | Run `post_verify.sql` and the D1 SELECTs again | Claude | any `ok` ≠ true; history ≠ exactly 1–16; counts ≠ the 1.2 baseline; other logins changed |

### Phase 2 — runtime-login smoke (needs the owner secret FIRST)

| # | action | who | stop if |
|---|---|---|---|
| 2.1 | **Owner secret:** GitHub → repo → Settings → Environments → `e7-readonly-probe` → secret `E7_DEV_BOOKING_DATABASE_URL` = `postgresql://mv_booking_app_dev.mxotevtiscernhqilyiu:<password>@aws-0-us-east-1.pooler.supabase.com:6543/postgres` (no query string) | **Joel** | Joel does not have the runtime password: STOP and report. A password reset is credential rotation and needs its own approval; it is not done here |
| 2.2 | Dispatch `e7-dev-db-smoke` on `main` with mode **preflight**, `approval_ref` = the approval label. It is secret-free. Record `planHash`, `closureDigest` (must = `45b512b0…af5ca`) and `runnerDigest` (must = `0d697185…22ec1`) from its summary | Claude (signed-in GitHub browser) | not `PREFLIGHT_OK_REAL_PLAN`; any digest differs |
| 2.3 | Dispatch ONE **execute** on `main` with the same label and the three recorded pins. The `e7-readonly-probe` gate needs approval | Claude dispatches; **Joel** approves the environment gate (or Claude clicks it only if the approval wording names this run) | anything but `SMOKE_PASS` (22/22); `SMOKE_TIMEOUT_UNKNOWN` = unknown, inspect read-only, **no second dispatch** |

### Phase 3 — branch-scoped preview

| # | action | who | stop if |
|---|---|---|---|
| 3.1 | Create and push **`e7-test` = `6d00d0d6c7ac63b77d703f8c212381109096723c`** (no new commit). Confirm one READY Preview build for exactly that sha. **Observe the real branch alias** (expected `maravilla-smoobu-proxy-git-e7-test-joel-goralskis-projects.vercel.app`, **provisional**). The first build is inert: without the gate env, the checkout routes return 404 | Claude (root-reviewed push) | no build or wrong sha (report; a manual deploy needs its own approval); alias ≠ expected (every alias value below then uses the observed one, after root confirms) |
| 3.2 | Preview env, **Git branch `e7-test` only**, the 9 non-secret names of §4, using the OBSERVED alias for `MV_CHECKOUT_ALLOWED_ORIGIN` / `MV_CHECKOUT_RETURN_URL`; plus `BOOKING_DATABASE_CA_PEM` (the public CA, after its SHA-256 `700723…f3b7` is checked). Production / Development untouched | Claude | any other scope offered or selected |
| 3.3 | **Owner secrets** (Preview, branch `e7-test` only): `BOOKING_DATABASE_URL` (the same runtime URL as 2.1); `STRIPE_TEST_SECRET_KEY` (the existing approved `sk_test_` of `acct_1TyHE42B9LTneQgw`, no new key) | **Joel** | value unavailable: STOP and report; don't generate a new key without a separate ask |
| 3.4 | `MV_RATE_LIMIT_SALT` via the mechanism chosen in 0.3 | per 0.3 | no mechanism: wait |
| 3.5 | Stripe TEST dashboard (`acct_1TyHE42B9LTneQgw`): create ONE endpoint `https://<observed alias>/api/checkout/stripe-webhook`, version `2026-01-28.clover`, events exactly `checkout.session.completed` + `checkout.session.expired`. Claude does not reveal the signing secret | Claude (Joel's signed-in Stripe in TEST mode) | wrong account / mode / version / events |
| 3.6 | **Owner secret:** reveal that endpoint's `whsec_…` and enter `STRIPE_TEST_WEBHOOK_SECRET` (Preview, branch `e7-test` only) | **Joel** | — |
| 3.7 | **Security decision (action-time consent required):** add ONE Deployment Protection Exception for exactly the observed `e7-test` alias. It makes that one preview domain public; TEST flags, TEST keys and the DEV database stay. No project-wide bypass, no other domain, production unchanged | Claude, only after Joel's explicit consent at that moment | any other domain listed or required; the docs (0.1) say otherwise |
| 3.8 | **ONE redeploy** of the `e7-test` deployment (so all env applies). Then GET only, no POST: `/checkout-test.html` 200 with `test-terms-2026-11`; `GET /api/checkout/stripe-webhook` → 405 (404 = gate env missing; a login page = protection still on); `GET /api/checkout/intents` without a token → any code but 404 | Claude | 404, a login page, a 5xx, or a wrong sha |

**Done means:** the DEV database is at 1–16 and its smoke passed; one branch-scoped preview is up with env + webhook + exception; the read-only GETs behave as expected.

**What is NOT proven:**
- the preview's own DB / Stripe / Hostaway connectivity;
- the signature path;
- any booking flow.

Those are proven only by the later guest TEST package.

### Owner secret handoff (only what is genuinely missing; no value is ever seen, printed or rotated by Claude)

1. `E7_DEV_BOOKING_DATABASE_URL` → GitHub environment `e7-readonly-probe` (step 2.1).
2. `BOOKING_DATABASE_URL` → Vercel Preview, branch `e7-test` (3.3). It is the SAME runtime URL as item 1.
3. `STRIPE_TEST_SECRET_KEY` → Vercel Preview, branch `e7-test` (3.3). It is the EXISTING approved `sk_test_` key.
4. `STRIPE_TEST_WEBHOOK_SECRET` → Vercel Preview, branch `e7-test` (3.6), after the endpoint exists (3.5).
5. `MV_RATE_LIMIT_SALT` (open; 0.3). It is not a credential: any random ≥ 32-character string that nobody needs to know. Options:
   - **(a)** an approved connector or CLI that stores a generated value without display, IF one is verified at execution time;
   - **(b)** Joel generates it (for example a password manager's random generator) and pastes it once;
   - **(c)** a reviewed one-off workflow with a Vercel token. This is new scope and not proposed.
   
   Until one is chosen, 3.4 is a named execution handoff.

The runtime password was set by Joel on 2026-10-22 [hist]; whether he still holds it is **not assumed**. If he doesn't, Claude reports at 2.1 and the run stops. A reset is a separate ask.

### Proposed approval wording (plain language; root presents it)

> I approve the E7 **infrastructure** setup exactly as in §9 of `claude/e7-dev-preview-packet.md` at `<final packet commit>`:
> 1. On the DEV database `mxotevtiscernhqilyiu`: run the read-only checks first. Only if everything matches, apply the reviewed scripts 06–16 once each, then the read-only checks again. Stop on anything unexpected, with no repair and no re-run.
> 2. One preflight and ONE read-only smoke of the DEV runtime login from main `5b60d705`, using the secret I enter.
> 3. Create branch `e7-test` at `6d00d0d6`, set Preview variables for that branch only, create one Stripe TEST webhook, and redeploy that preview once with GET-only checks.
>
> I will enter the secrets myself.
>
> The protection exception for the one observed `e7-test` preview domain needs my separate yes at that moment.
>
> No guest booking, payment, Hostaway write, email, production change or merge to main is included.

**Execution stop points** (each ends the run with a report):

- 0.1 docs mismatch;
- 1.1 baseline mismatch / data / logins;
- 1.3 error or uncertainty;
- 1.4 POST mismatch;
- 2.1 password unavailable;
- 2.2 / 2.3 not PASS;
- 3.1 build / sha / alias;
- 3.3 secret unavailable;
- 3.5 wrong Stripe scope;
- 3.7 consent withheld, or a different domain needed;
- 3.8 unexpected response.
