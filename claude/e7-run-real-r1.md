# E7 M2-G1 — R1 package binder + read-only L-preflight (OFFLINE, LOCAL, inert)

Root ruling 3867b5b7 authorizes **G1 only**, on an isolated local branch from e7-test `58a88f691ac88dcb260cdf407a73785cd96949cd`, with five new paths.

**Not authorized (future designs only, each needing its own exact independent review):**
- G2 (the shared binder-injection extraction and the R1 consumer);
- G3 (the entrypoint, credentials and activation).

This slice adds NO seam into any accepted module.

| path | role |
|---|---|
| `scripts/e7-connected/run-binding-r1.mjs` | PURE package / closure verifier → R1 binding (evidence data only) |
| `scripts/e7-connected/run-preflight-r1.mjs` | read-only L-preflight over INJECTED capabilities → verdict (`executable:false`) |
| `claude/e7-run-real-r1.md` | this contract |
| `test/e7-connected-run-binding-r1.test.mjs` | pure binder suite |
| `test/db/e7-run-preflight-r1.test.mjs` | disposable local PG + fake exchanges |

**Byte-exact:** every accepted module stays byte-exact — planners, validators, journals, cores, bridge, workers, helpers, transports, guards, migrations and workflows.

**What G1 never does:**
- execute a worker;
- write a booking record, event, operation or evidence row;
- send a provider write, or reach a provider network by default;
- read a credential or environment variable;
- produce anything executable.

## 1. Trust model (what a G1 result is and is not)

**What the hashes are.** `expected.packageHash` and `expected.executorDigest` are caller-supplied REVIEWED PINS.
- They are not Git provenance. Source bytes are a caller snapshot; `repoCommit` is a declared pin.
- They are not owner permission.
- They are not authorization to run anything.

**What the binding is.** An R1 binding is EVIDENCE DATA: frozen, plain, with `executable:false` and every permission false.
- A copied binding-shaped object, or the string `e7-run-package-r1`, is never an execution credential.
- The preflight therefore does not accept a binding object from its caller. It re-derives the binding itself, from the binder input, synchronously, before any await.
- A future G2 consumer will need a validated binding / provenance seam: a module-private brand, or a re-derivation inside the consumer. It must not be a publicly forgeable `…ForBinding(binding)` export.
- No G2 seam code exists in this slice.

**Hash-domain separation.** The R1 hash domains are distinct from the v2 manifest / journal domains.
- An R1 identity (`manifestVersion: "e7-run-package-r1"`, `manifestHash = packageHash`) is refused by every v2 binder and record validator (tested).
- An R1 binding cannot feed v2 directly.

## 2. `bindRunPackageR1(input)` — pure, synchronous, never throws

**Input.** Exactly these keys, as own enumerable data properties of a plain object:

| key | constraint |
|---|---|
| `packageBytes` | Uint8Array, 1…65 536 bytes, exact `canonicalJson(package) + "\n"`, depth ≤ 10 |
| `planBytes` | Uint8Array, the exact plan bytes |
| `foundationSources` | exactly `RUN_PLAN_CLOSURE` order, `{path, bytes}` |
| `executorSources` | exactly `R1_EXECUTOR_CLOSURE` order, `{path, bytes}` |
| `envSnapshot` | the probe env-snapshot data |
| `expected` | `{ packageHash, executorDigest }`, 64-hex each |
| `execClock` | safe integer ≥ 1 |

**Input safety:**
- Every value is snapshotted or owned first (`snapshotData` / `ownedBytes` semantics).
- Refused: getters, proxies, boxed values, symbols, own `__proto__` loss, extra / missing keys, coercion.
- The caller's objects are never read again.

**Order (first failure wins; one fixed code each):**
1. Input shape → `R1_INPUT_INVALID`. Expected pins → `R1_EXPECTED_INVALID`. Clock → `R1_CLOCK_INVALID`.
2. **Sources:**
   - each list exact (path order, no missing / extra / duplicate, owned non-shared bytes within the M2-F size caps) → `R1_SOURCES_INVALID`;
   - **overlap rule:** every path present in BOTH lists must have byte-identical owned contents → `R1_SNAPSHOT_OVERLAP_MISMATCH`. Two different snapshots can never support one verdict.
3. Package bytes canonical / bounded → `R1_PACKAGE_BYTES_INVALID`. The schema must be `e7-run-package-v1` with `executable:false`, `nature: "SCOPE_BINDING_ONLY"` and all permissions false → `R1_PACKAGE_INVALID`.
4. `execClock ≥ package.evaluatedAt` → else `R1_CLOCK_BEFORE_PACKAGE`.
5. **Re-computation at `package.evaluatedAt`:**
   - the accepted pure `buildRunPackageV1({ planBytes, sourceEntries: foundationSources, envSnapshot, planClock: package.evaluatedAt })` must be ok → else `R1_RECOMPUTE_REFUSED`;
   - its canonical bytes must equal `packageBytes` EXACTLY, so the supplied plan bytes and package match → `R1_PACKAGE_MISMATCH`;
   - its `packageHash` must equal `expected.packageHash` → `R1_PACKAGE_HASH_MISMATCH`.
6. `binding === "BOUND"` → else `R1_UNBOUND` (UNBOUND is never executable).
7. **Separate freshness at `execClock`:** `validateRunPlanV1(plan, { planClock: execClock })` → else `R1_STALE_AT_EXEC` (plan, quote and authorization caps re-measured at execution).
8. **Stricter accepted rules:**
   - `expectedRef` must match `^MV-[A-Z0-9]{6,10}$` (= the v2 manifest / adapters / facts) → `R1_REF_NOT_ACCEPTED`;
   - `rateBps ≤ MAX_RATE_BPS` (pure `lib/direct-pricing.js`) → `R1_RATE_NOT_ACCEPTED`.
9. **Executor closure:**
   - digest `"e7-run-executor-source-r1\n"` + per entry `path ‖ 0x00 ‖ decimal length ‖ 0x00 ‖ bytes ‖ 0x00` (the M2-F framing under a new domain);
   - must equal `expected.executorDigest` → `R1_EXECUTOR_DIGEST_MISMATCH`.

**Output.** Frozen `{ ok:true, binding }`:

```
binding = { schema:"e7-run-binding-r1", nature:"R1_BINDING_EVIDENCE_ONLY", executable:false, permissions:NONE,
            identity:{ manifestVersion:"e7-run-package-r1", connection, runId, intentId, baselineCommit, manifestHash: packageHash },
            packageHash, foundationDigest, executorDigest, execClock, evaluatedAt,
            scope:{ intentId, paymentIntentId, expectedRef, listing:{ id, currency, refFieldId, timeZone, connection }, stay:{ arrival, departure, guests },
                    amountMinor, rateBps, stripeAccountId, quote:{ totalMinor, currency, quotedAt }, authorizedAt },
            checkpoints, phases, exclusions (the planner's exact HISTORICAL_EXCLUSIONS) }
```

**Executor closure scope.** `R1_EXECUTOR_CLOSURE` is an explicit sorted list: the scanned transitive relative imports of `run-binding-r1.mjs` and `run-preflight-r1.mjs` (G1 code ONLY) plus `package.json` / `package-lock.json`.
- No runtime data file is read by any closure module.
- Every later slice must re-pin its own list and digest. This list claims nothing about G2 / G3 code.

## 3. `readExclusionBaselineR1({ statement, ids, currentIntentId })` — ONE `REPEATABLE READ READ ONLY` snapshot

`statement(sql, params)` is the preflight's GATED runner, inside the one transaction that it opens and closes. Each family binds ONLY the identifier arrays it references, numbered `$1…$n` in first-use order (`uses`).

**Identifiers (`ids`).** The exact sets come from the binding:
- `intentIds`: Run1/2/3;
- `paymentIntentIds`: Run3 PI + `otherPaymentIntentIds`;
- `reservationIds`: the four protected ids.

A Run1/Run2 PI and every run's reservation id are explicit `null` in the planner constant, so they are not identifiers.

**Row families and match rules.** One bounded statement per family, `ORDER BY` row key, `LIMIT cap+1`. More than `cap` rows → `BASELINE_LIMIT_EXCEEDED` (fail closed).

| family | matched when |
|---|---|
| intents | id ∈ intentIds, or `stripe_payment_intent_id` ∈ PIs, or `hostaway_reservation_id` ∈ reservationIds |
| intent_transitions / intent_applied_events / intent_work / inventory_claims / payment_refunds / reconciliation_cases | `intent_id` ∈ intentIds |
| external_operations | intent ∈, or `payload->>'paymentIntentId'` ∈ PIs, or `payload->>'reservationId'` / `result_ref` / `late_result_ref` ∈ PIs ∪ reservationIds |
| provider_evidence | intent ∈, or `external_ref` ∈ PIs ∪ reservationIds, or `observed->>'reservationId'` ∈ reservationIds, or `observed->>'paymentIntentId'` ∈ PIs |
| hostaway_reservation_attempts | intent ∈, or `hostaway_reservation_id` ∈ reservationIds |
| payment_attempts | intent ∈, or `payment_intent_id` ∈ PIs |
| payment_ledger | intent ∈, or `provider_ref` ∈ PIs |
| stripe_webhook_events | intent ∈, or `object_id` ∈ PIs |
| reconciliation_resolutions | intent ∈, or `result_ref` ∈ PIs ∪ reservationIds |

**Per row returned:** `{ family, key, intentId, fingerprint }`.
- `fingerprint` = SQL `sha256` over `jsonb_build_object(...)::text` of an EXPLICIT whitelisted projection.
- The projection covers identity, state / version / timestamps and the full content columns, including `payload`, `observed`, `evidence` and `price_snapshot`.
- No projection includes `intents.access_token_hash`.
- Content is hashed inside the database and NEVER returned. No guest or secret data appears in any verdict or log.

**Per identifier:** `PRESENT` / `ABSENT` for each historical intent id (explicit ABSENT).

**Digest.** `baselineDigest` = sha256 domain `"e7-exclusion-baseline-r1\n"` + `canonicalJson({ identifiers, rows })`. It is deterministic for fixed DB content.

**Refusal.** Any row of these families that belongs to `currentIntentId` → `PROTECTED_REFERENCE_IN_RUN_INTENT`. A protected or historical reference inside the run's own intent is refused.

**Covers:** the rows and projections listed above, as of ONE read-only snapshot. That includes mutation of existing rows when counts are unchanged.

**Does not cover:**
- other tables (guests, notifications, recording, rate limits);
- identifiers inside unlisted JSON keys or free text;
- provider-side state;
- any change before or after the snapshot.

A later G2 before / after equality would be DIAGNOSTIC evidence only. It is not a fence against transient changes and not an atomic guarantee.

## 4. `runPreflightR1(input)` → native Promise of a frozen verdict; never rejects

**Input.** Exact keys: `{ bind, pools:{ app, report }, transports:{ hostaway:{send}, stripe:{send} }, guard, blocked, clock }`.
- `guard`: a genuine accepted run-guard (`createGuard`).
- `blocked()`: a synchronous stop predicate.
- `clock()`: synchronous business ms.
- Everything is bound once, before any await. `bind` goes to `bindRunPackageR1` with `execClock = clock()`, read once.

**Stop / resource ownership:**
- Every ACTUAL start is gated by the blocked-aware rule: `blocked()` is checked immediately before the guard observes the start, AND again inside the start function itself. Starts covered:
  - each `pool.connect`;
  - each SQL statement, including the nested ones inside the accepted `readRunSnapshot` / `readGuestBinding` / `loadIntent`;
  - each provider exchange, including the three inside the accepted `priceStay`.
- Nested statements are reached through a read-capability client wrapper whose `query` refuses (a rejected native promise, nothing sent) once `blocked()` is true or the preflight has stopped. Accepted helpers still use the genuine guard.
- **Connect.** Connects go through the accepted `createLifecycle(...).observeConnect`. A late client after a connect timeout is destroyed once and never queried.
- **Client tracking.** Each acquired client is tracked with the accepted `trackClient`: an `error` / `end` event means it is lost and destroyed once.
- **Release vs destroy:**
  - a client is RELEASED for reuse only after every statement on it settled within its bound and any transaction was closed by an acknowledged `COMMIT` / `ROLLBACK`;
  - on a timeout, rejection, loss, unobservable result or stop mid-transaction it is DESTROYED, never released;
  - a timed-out statement may still be running server-side, and that is reported (`dbUncertainty`).
- Read-only transaction control (`BEGIN … READ ONLY`, `COMMIT`, `ROLLBACK`) is the ONLY non-SELECT SQL.
- **No retry.** The first refusal or stop short-circuits every later read.
- **Provider reads.** Each is bounded by a guard deadline and an `AbortController` signal. On timeout the signal is aborted; an in-flight read may still complete at the provider, and that is reported (`transportUncertainty`).
- **G1 has no run lock.** In a future G2, the P0 lifecycle owns the run lock. G1 neither claims its snapshots are fenced nor dispatches anything.

**Steps (in order):**

| step | what | accepted parts |
|---|---|---|
| L1 | report and app `SAME_DB` + `checkSameDatabase` (TEST marker, exact roles, same instance) | SQL and checker COPIED from `run-core.mjs` with origin pin + parity test (run-core imports `pg` and the workers) |
| L2 | `readRunSnapshot` (report): eligibility exactly as accepted P0 (`payment_authorized`, no write op, no open case, no recovery candidate, no protected / malformed facts); binding = DB intent exactly: ref, listing, from/to, guests, `final_total_minor`, `rate_bps`, currency, `stripe_payment_intent_id` | `run-facts.mjs`; the P0 predicates COPIED with pin |
| L2g | `readGuestBinding` (app): guest row present; values in memory only, used solely to construct the accepted reservation-phase executors | `run-facts.mjs` |
| L3 | ONE `REPEATABLE READ READ ONLY` transaction on the report client: `loadIntent` (version = the snapshot's version; `payment_authorized`; payment PI / livemode false / amount / currency; price total and rate), the authoritative payment attempt `SELECT id FROM booking.payment_attempts WHERE intent_id = $1 AND payment_intent_id = $2 AND status = 'completed'` (exactly one; SQL copied from `recovery.js` with pin), then §3 | `repo.js` `loadIntent` |
| L4 | Stripe through the injected transport only, account FIRST: `{op:"accounts.retrieve"}` → `object === "account"` and `id === scope.stripeAccountId`; then `{op:"paymentIntents.retrieve", id, params:{expand:["latest_charge"]}}` → `paymentIntentProofObservationV3(pi, { accountVerified:true })` → `stillAuthorizedV3Refusal({ kind:"payment_intent", requestRef: PI, externalRef: PI, status, observed }, loadIntent, paymentAttemptId) === null` (metadata intent + attempt, manual capture, `requires_capture`, amount / capturable / received, currency, livemode false, charge bound / paid / uncaptured / unrefunded, `captureBefore === intent.payment.captureBefore`) | `capture-proof.js`, `recovery-plan.js` |
| L5 | margin, at a FRESH `clock()` read immediately before the verdict: `authorizationDeadline − verdictClock > AUTOMATIC_WORK_BUDGET_MS`, safe-integer arithmetic only, strict. `authorizationDeadline` is the DB value (E3 already applies its capture safety margin); never re-derived from the plan's 24 h cap | §5 |
| L6 | Hostaway: the accepted `createPhaseExecutors({ phase:"reservation", binding:{…scope, guest, reservationId:null} })`; ONLY `pricing` and `lookupPage` are retained, and the write executors are dropped before any await. The injected Hostaway send is wrapped by an allowlist of exactly H3 / H4 / H5 / H1 for this listing; anything else is refused with zero sends | `executor-adapters.mjs`, `server-pricer.js`, `final-price.js`, `direct-policy.js`, `public-api.js` |

**What L6 proves.** `priceStay` with the policy the accepted core gives the worker (`DIRECT_DISCOUNT_BPS = rateBps`) and the worker's `today` rule must:
- return ok;
- have made EXACTLY three exchanges, in order: H3 listing (identity + currency), H4 calendar for the exact stay (availability via `evaluateStay`), H5 priceDetails for the exact stay and guests (complete quote via `computeFinalPrice`);
- satisfy `compareFinalPrice(intent.price, fresh).same`, and `fresh.finalTotalMinor === amountMinor`.

A missing or partial proof refuses. `lookupPage` for the listing, the exact arrival, channel 2000 and limit 100 must be HTTP 200 / `success` with ZERO results; any result refuses. Any protected id in any reply → `PROTECTED_REFERENCE`, and later reads stop.

**Verdict.** Frozen, whitelisted, code-only:

```
{ schema:"e7-run-preflight-r1-verdict", ok, code, step, executable:false, permissions:NONE,
  packageHash?, executorDigest?, baselineDigest?, preflightDigest?, marginMs?, automaticBudgetMs,
  dbUncertainty: "none"|"destroyed_client"|"statement_may_still_run",
  transportUncertainty: "none"|"aborted_in_flight",
  counts:{ connects, statements, exchanges } }
```

On a binder refusal the verdict is `INPUT_INVALID` plus `binderCode` (one of the binder's fixed codes). On a margin refusal it also carries `marginMs`.

**Provider methods, stated precisely.** The only non-GET provider request is H5 `POST /v1/listings/{id}/calendar/priceDetails`: the accepted pricing calculation, which creates nothing. There is no Stripe POST, no Hostaway PUT and no reservation / charge write; tests log any such route and assert it absent.

`preflightDigest` = domain `"e7-run-preflight-r1\n"` + `canonicalJson`. It covers: package / executor / baseline digests, intent id / version, payment attempt id, PI status / amount / currency / captureBefore, authorizationDeadline, account id, fresh `finalTotalMinor` / `quoteHash`, the zero lookup count, `execClock` and `verdictClock`. It holds no guest data and is deterministic for fixed facts and time.

## 5. Time budget — AUTOMATIC work only, not completion

`AUTOMATIC_WORK_BUDGET_MS` is computed in code from accepted constants. They are COPIED with origin pins and parity tests; the heavy core / bridge are not imported.

```
P0_BUDGET_MS + JOURNAL_MS                                  (P0, RUN_STARTED)
+ PHASE.reservation.budgetMs                               (reservation phase cap)
+ CONNECT_MS + SNAPSHOT_MS + 3×JOURNAL_MS + STEP_MARGIN_MS + SNAPSHOT_MS + JOURNAL_MS   (abort: fresh snapshot, bridge read/start/abort/postcheck/receipt, gate read)
+ PHASE.cleanup.budgetMs                                   (cleanup phase cap)
+ CONNECT_MS + 2×STATEMENT_MS                              (release proof)
+ 4×JOURNAL_MS                                             (3 attestation records + RUN_ENDED)
```

**Omitted and unbounded (explicitly NOT covered):**
- owner attestation waits (≤ ATTEST_MS each by policy, owner-dependent);
- file-journal fsync beyond its observation bound (a timeout stops the run);
- late server-side statement and provider tails after a timeout;
- lifecycle finalize quiescence;
- process scheduling.

**What it is.** A conservative automatic-work policy, NOT proof of whole-run completion.
- A future G2 must re-check fresh authorization after EVERY attestation or wait.
- Expiry must never prevent recovery or cleanup reads.
- Whether any future void or cancel may be sent is governed only by the accepted cleanup proof / state / idempotency rules. Voiding an expired authorization is NOT asserted harmless or always sendable.
- No cleanup exists in G1.

## 6. Import boundaries

- **Binder:** imports only pure modules (`run-plan-v1.mjs` and its accepted pure graph; `lib/direct-pricing.js`). Externals `node:crypto` / `node:util`.
- **Preflight:** imports read helpers (`run-guard`, `run-facts`, `repo.js` `loadIntent`, `executor-adapters`, `server-pricer`, `final-price`, `capture-proof`, `recovery-plan` via those, `direct-policy`, `public-api`).
  - No `pg`, no `node:fs` / `net` / `http(s)` / `child_process`, no worker / core / bridge / operator / journal / transport / exchange / credential module.
  - Zero import-time DB, env, provider or timer effect, checked by a child-process import test with trapped `process.env`, `fetch` and timers.
- **Runtime:** reads only injected transports. Transport factories, fake exchanges and synthetic TEST key callbacks exist only in TEST construction.

## 7. Limits

- G1 is offline proof only. It is not activation, not readiness, not website full-booking readiness and not owner permission.
- No entrypoint, credentials, real exchange or POSIX runner / dirs (owner-parked).
- Shared 0017 stays unapplied.
- Real Hostaway create / cancel stays excluded by session scope; no approval is sought. Stripe TEST delegation is not Hostaway permission.
- Run1's truncated checkout session id stays parked and unguessed.
- Capture, recording, refund and notification stay excluded.
