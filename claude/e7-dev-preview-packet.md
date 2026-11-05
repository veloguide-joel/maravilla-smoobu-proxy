# E7 DEV / preview enablement — execution packet (OFFLINE preparation)

Status: preparation only. **Nothing here is approval.** No database query, Vercel setting, env value, webhook, deploy or provider call was made to write this. Branch `feature/e7-dev-preview-packet` from exact accepted `6d703acdcfa205138d1ce4ba65b2ec58fc9493c9`.

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
- **every data count is 0.**

Anything else (a version > 5, any data row, another login, a different checksum) stops here. The finding is reported; there is no replay and no repair.

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
- **Route B (PREFERRED: no owner terminal, no credential handling; the 0001–0005 precedent).** SQL-editor scripts are generated offline at `6d703acd` with the recorded generator recipe (`e2c-tools/gen-editor-scripts.mjs`, SHA-256 `e3ea1ffc…c4fb7`; evidence `claude/evidence/e2c-preflight-evidence-2026-10-21.txt`). Each script wraps one migration verbatim with the same advisory lock, prior-version checksum / environment / order guard and history INSERT.
  - Before any Run, root reviews each script's SHA-256, and the editor content is hash-checked.
  - One Run per script, 06 → 16. Stop at the first error; never re-run.
  - **[gap]** The generator is not committed, so its regeneration and hash review are an offline step before this route.

**POST (after D2) expected, all of these or STOP** (re-run the §2 SELECTs; the PRE expectations for history and new tables do NOT apply):
- `env = test`, 1 instance row;
- applied history exactly 1–16, with the §1 checksums (1–5 unchanged) and environment `test` each;
- `t0006` / `t0011` / `t0016` are NOT NULL;
- roles unchanged (same NOLOGIN groups; `mv_booking_app_dev` LOGIN, member of `mv_booking_app` only);
- every data count is still 0.

**Then:**
- the D1 SELECTs again (history 1–16 with the table above, `env = test`, 0 data rows);
- then the existing read-only smoke from `6d703acd`, whose privilege matrix covers through 0016, run by the owner as before:
  ```
  node scripts/db-smoke.mjs --url-env BOOKING_DATABASE_URL --ca-file prod-ca-2021.crt --expect-role mv_booking_app_dev --env test   # read-only; never --write-probe
  ```
  It must pass every check, exit 0.

## 4. Preview: branch, alias, env

- **Branch.** `e7-test`, a new branch at the exact reviewed checkout head plus ONE reviewed preview-config commit (§7, [gap] P). No merge to main.
  - The alias stays short, so it is not truncated: `https://maravilla-smoobu-proxy-git-e7-test-joel-goralskis-projects.vercel.app` (58-character label). Name free [obs 2026-11-05].
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
| `MV_RATE_LIMIT_SALT` | 48 random bytes, base64 (CSPRNG) | secret, **not Joel**: generated and written by the approved infra step without display (mechanism in §9 step 5) |

- **Already present and reused** [obs]: `HOSTAWAY_ACCOUNT_ID`, `HOSTAWAY_CLIENT_SECRET` (Preview + Development) for the read-only pricing of 606998; `HOSTAWAY_DIAG_KEY`, `BOOKING_UI_ORIGINS`. **Left unset:** `MV_CLIENT_ADDRESS_SOURCE` (default `none`), `BOOKING_RETENTION_*` (code defaults).
- **Secrets, reuse vs new.**
  - The GitHub environment secret `E7_STRIPE_TEST_KEY` cannot be copied into Vercel by anyone but the owner. Its value is never read or moved.
  - The DB password of `mv_booking_app_dev` exists (set by the owner on 2026-10-22) and is reused as is; no new role.
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
  1. **Recommended: a Deployment Protection Exception for exactly the `e7-test` alias** (all plans).
     - **Scope:** that one domain becomes public; every other preview and every per-deployment URL stays protected; production is not touched; removing the exception reverts it.
     - **Side effect:** anyone with the URL can open the TEST page and API.
     - **Mitigations already in code:** production 404 before anything runs; exact-origin CORS; per-token and global rate limits; TEST key and account binding; listing allowlist 606998 only; DEV database only; no Hostaway write route; no notification sender; `noindex`.
  2. **Alternative: Protection Bypass for Automation**, with the secret as the `?x-vercel-protection-bypass=` query parameter of the Stripe endpoint URL.
     - **Scope:** project-wide (all deployments), and the secret sits in the Stripe dashboard. Broader, so not recommended.
- **Not used:** Shareable Links (redirect plus cookie, which Stripe won't follow); weakening production; disabling protection.

## 6. Owner cleanup execution (so a TEST release does not strand a hold)

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

## 7. Preview-config commit P (implemented: `feature/e7-preview-config` `6d00d0d6`, from `d7476990`; root reviews separately)

- `public/checkout-test.html`: `<meta name="mv-test-terms-version" content="test-terms-2026-11">`.
- `test/e7-checkout-test-page.test.mjs:210`: the pin changes from `content=""` to exactly that value, i.e. the TEST label, documented as a deployment input.
- No other change. Containment and packaging allowlists are unchanged.

## 8. Ordered finish list

1. Root review of this packet → scope decision on gaps **P** and **C** (and Route A vs B; if B, the generator regeneration).
2. Offline: implement C (+ tests, preflight locally); commit P on `e7-test`; root code review.
3. Infrastructure package (below), executed once, in order, stopping at the first mismatch.
4. Only then: one guest TEST run (authorize → release → cleanup runner → verified release), as a separate approval.

## 9. ONE approval package for infrastructure (DRAFT; all CLOSED)

| # | action | who | stop condition |
|---|---|---|---|
| 1 | D1 read-only SQL on `mxotevtiscernhqilyiu` | Claude (owner's signed-in dashboard) | any value ≠ §2 baseline |
| 2 | D2 upgrade 6 → 16 by Route B (reviewed editor scripts), then the POST assertions plus the read-only smoke | Claude (editor scripts); smoke run needs the runtime credential, so it is an open item | first error; any POST assertion fails; smoke not all PASS |
| 3 | Push `e7-test` = reviewed head + P; confirm one READY preview for that sha | Claude (root-reviewed push) | no build / wrong sha |
| 4 | Branch-scoped Preview env: the 9 non-secret names (§4) | Claude | — |
| 5 | Branch-scoped Preview env secrets: `BOOKING_DATABASE_URL`, `STRIPE_TEST_SECRET_KEY` (existing approved `sk_test_`), `STRIPE_TEST_WEBHOOK_SECRET` (**owner**); `MV_RATE_LIMIT_SALT` generated without display by the approved step (concrete mechanism to be fixed in review: Claude's browser rules bar typing secret values into fields) | owner / approved step | — |
| 6 | Stripe TEST webhook endpoint (§5) → owner enters its secret (step 5) | **owner** | — |
| 7 | Protection path for the webhook (exception for exactly the observed `e7-test` alias, or the bypass alternative); **NOT authorized**, separate decision | per decision | any other domain listed |
| 8 | Redeploy the `e7-test` preview once, so the env applies; read-only checks: `/checkout-test.html` 200 with the meta; `GET /api/checkout/stripe-webhook` unauthenticated → `405 METHOD_NOT_ALLOWED` (gate passed and the domain is reachable; `404 NOT_FOUND` = gate not satisfied; a Vercel login page = protection still on); `GET /api/checkout/intents` without a token → any code but `404 NOT_FOUND`. No POST, so no intent is created | Claude | 404, a login page, or a 5xx |
| 9 | GitHub env secret for the cleanup runner's DB URL (needs C merged) | **owner** | — |

Not in this package: any guest hold, Checkout session, void, Hostaway write, notification, production change, merge of E7 lineage to main, or removal / rotation of existing credentials.
