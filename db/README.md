# Booking database (Stage E2B — offline foundation, with E2B.1, E3.2 and E2B.2 corrections)

Schema `booking` for the new maraVilla direct-booking checkout. Design: project doc
`claude/e2a-booking-database-design-2026-10-21.md`.

**Status**
- **Not connected to anything.** The layer lives in `db/lib/`, outside the deployable `api/` and `lib/` trees, and no route imports it. The E1 containment test (`test/legacy-routes-retired.test.mjs`) still forbids database writes in `api/` and `lib/`. Wiring this layer into a route (E5–E7) must update that test deliberately, with owner approval.
- No hosted database exists yet. Provisioning is stage **E2C** and needs owner approval.
- External dispatch to Stripe and Hostaway is disabled.

## Layout

| Path | Purpose |
|---|---|
| `db/migrations/NNNN_name.{up,down}.sql` | Versioned migrations. `0001` is the schema; `0002` adds roles and grants (no passwords); `0003` adds the E2B.1 evidence, settlement and privilege rules; `0004` the E3.2 capture recovery; `0005` the E2B.2 database clock and Checkout-create reconciliation |
| `db/lib/migrate.js`, `scripts/db-migrate.mjs` | Migration runner, with checksums, an environment marker and an advisory lock |
| `db/lib/repo.js` | E3 persistence: CAS transitions, audit, event de-dup, outbox, claims, payment and Hostaway attempts, cases, guest data |
| `db/lib/operations.js` | Outbox claim, complete and recover, by retry class. `dispatchOperation` refuses without an injected executor |
| `db/lib/webhooks.js` | Permanent Stripe event de-duplication (call only after signature verification) |
| `db/lib/config.js` | Tunables, plus the **provisional** guest-data retention (O6) |
| `db/lib/admin.js` | **Owner-only** reconciliation (needs a login holding `mv_booking_admin`, never the runtime credential) |
| `db/lib/codec.js`, `db/lib/pool.js`, `db/lib/index.js` | Row ↔ E3 intent mapping; verified-TLS pool (no default URL); public surface |
| `test/db/` | Throwaway local PostgreSQL harness and integration tests |

## Running the tests (offline)

```
npm test          # existing suite (unchanged)
npm run test:db   # starts a throwaway local PostgreSQL per test file, deletes it afterwards
```

**Requirements**
- PostgreSQL 15+ server binaries (`initdb`, `pg_ctl`) and the `btree_gist` contrib extension.
- Set `PG_BIN` if the binaries aren't found automatically.
- If run as root, the harness starts the server as the `postgres` OS user.

**The harness:**
- listens on 127.0.0.1 only, on a random port;
- uses trust authentication, with no credentials;
- runs all repository code as the least-privilege runtime role.

## Migration runner

```
node scripts/db-migrate.mjs status|up|down --env test --url-env MY_LOCAL_DB_URL [--to N]
```

**Rules**
- **Connection string:** read from the variable *named* by `--url-env`. It's never printed and never `DATABASE_URL` (the retired Smoobu database).
- **Loopback only by default.** `--allow-remote --ca-file <provider CA>` is for E2C, and only with owner approval.
- **Down migrations are refused for `--env live`** (forward-only policy). For DEV, down drops schema `booking`, which only ever holds test data.
- **Checksum drift is refused.** A file changed after it was applied stops the runner. Never edit an applied migration; add a new one.

## Safety properties enforced by PostgreSQL (not only by code)

**Intents**
- Exactly one version step per update.
- Price, stay and identity are immutable.
- Terminal states can only escalate.
- No capture without a reservation; captured amount equals the confirmed price.
- No DELETE on any booking table; audit and ledger tables are append-only.

**Claims and payments**
- No two active claims overlap on the same listing and nights (GiST exclusion; half-open ranges).
- A released claim can't be reactivated.
- A payment attempt's amount equals the confirmed price, and its Stripe idempotency key format is fixed.

**Outbox**
- One Hostaway create per intent, ever.
- Non-idempotent operations (Hostaway create, Hostaway payment recording) have exactly one attempt and can't be re-queued.
- At most one open Hostaway payment recording per intent.
- Refunds can't exceed the captured amount.

**Access**
- Row-level security on every table.
- `PUBLIC` has no access. The report role can't read guest data.

**Not claimed**
- A unique row bounds what *this system* may send. It isn't exactly-once delivery to Stripe or Hostaway.
- A Hostaway "not found" lookup is never treated as proof of non-creation until E4 establishes it.

## E2B.1: evidence, settlement and privileges (migration `0003`)

**Roles**

| Role | Can | Cannot |
|---|---|---|
| `mv_booking_app` (runtime) | Drive E3 transitions; queue and complete operations; record API evidence from a **succeeded read operation** of the matching type | Update or delete claims; resolve cases; settle `outcome_unknown`/`escalated` operations; mark a non-idempotent write "definitely failed" without a catalogued code; write evidence or resolutions directly; call `admin_*` |
| `mv_booking_admin` (owner reconciliation) | Record attested dashboard evidence; resolve operations and intents, and close cases, **citing evidence ids**; re-acquire a claim for a confirmation | Write any table directly; read guest data |
| `mv_booking_report` | Read everything except guest data | Write anything |

`PUBLIC` executes no `booking` function. RLS is on for every table, including `booking_migrations.applied`.

**Rules enforced by PostgreSQL** (whoever issues the SQL):
- **Date claims**
  - A claim is taken only at the Pay step. Checkout preparation (payment attempt, `payment_pending`) and every later state require the intent's own active claim.
  - A claim is released only through `booking.release_claim_if_safe` / `release_completed_stays`, and only when `booking.claim_release_blockers()` is empty:
    - the intent is in a safe final state;
    - no payment attempt is unresolved;
    - every PaymentIntent is voided or verified as holding no funds;
    - every possible reservation is verified cancelled, or the create was refused with a catalogued code;
    - no Stripe/Hostaway operation is pending, in flight, unknown or escalated;
    - no reconciliation case is open.
  - A confirmed booking releases on check-out day, computed in Mexico City time **by the database clock** (E2B.2).
- **Payment end and void**
  - A payment attempt ends (`expired`/`failed`) only with Checkout Session evidence showing `expired`. A declined card ends nothing.
  - `authorization_released` after a refusal requires the void operation to have succeeded.
- **Cancellation:** `capture_failed → cancelled` requires both recovery legs verified (E3.2, migration `0004`): the Hostaway cancel succeeded **and** a read shows the reservation cancelled; and the card authorization voided or verified gone. E3 emits the void itself; there is no database-side workaround any more.
- **Owner decisions**
  - Leaving `reconciliation_required` consumes an unconsumed owner resolution for exactly that outcome (one use). The E3 `RESOLVE` evidence is derived from that resolution, never from caller booleans.
  - Re-recording a Hostaway payment after an ambiguous outcome needs every earlier recording settled as failed: by a catalogued definite refusal, or by an owner resolution citing **both** an API read **and** an attested dashboard check showing no matching charge, each observed at least 15 minutes after the call.
- **Not before E4:** an owner cannot settle a reservation create as failed. Absence isn't proof until E4.
- **Catalogue:** `booking.definite_refusal_codes` is **empty until E4**. Until then every non-success of a non-idempotent write is `outcome_unknown`.

**Trust boundaries that SQL cannot enforce**
1. **Provider responses are not verifiable by the database.** It binds API evidence and operation results to the recorded read or operation, the role and session user, and the time. It can't verify that the observed values are what Stripe or Hostaway returned. Only verified provider calls may be recorded (E5/E7 executors). Provider request ids are stored when available.
2. **Dashboard evidence is an attested human observation.** It's recorded with who attested it, when, and an external reference. For a re-recording, it's never sufficient on its own.
3. **The runtime role is trusted for the success path.** It can still drive ordinary E3 transitions and report provider successes. The database guarantees that uncertainty is never resolved toward releasing dates or re-sending a non-idempotent write without evidence; it doesn't prevent a compromised runtime from reporting a false success.
4. **The schema owner bypasses everything.** The migration/owner credential must stay out of Vercel and be used only for migrations.
5. **Catalogue changes are code changes.** Entries in the definite-refusal catalogue change what counts as "definite". They must come through an owner-approved migration after E4.

## E3.2: failed-capture recovery (migration `0004`)

**Definite vs ambiguous**
- A capture, void or cancel is a `reconcile_first` operation: one attempt per row.
- **Definite:** an explicit provider error. `failed_definite` needs a real error code; `TIMEOUT`, `NETWORK_ERROR`, `HTTP_5XX`, `RATE_LIMITED`, `LEASE_EXPIRED` and `OUTCOME_UNKNOWN` are refused.
- **Ambiguous:** timeout, 5xx, lost worker. The row becomes `outcome_unknown` and is **never re-queued**. E3 is told (`*_OUTCOME_UNKNOWN`, or `reportUnknownOutcome()` after a crash) and schedules a provider **read**.
- **Settling an ambiguous row:** only `booking.settle_operation_from_evidence()` (runtime, API evidence observed ≥ 2 minutes after the call) or an owner resolution.
- **Retries:** only then may E3 emit another attempt, as a **new row with its own provider key**. A partial unique index allows at most one open capture or void per PaymentIntent, and one open cancel per reservation.

**Recovery sequence after a capture failure**

```
reservation_confirmed --capture--> definite refusal (1st attempt, card-level) -> capture_failed
                                   refusal on a retry / "unexpected state"   -> capture_unknown (read first)
                                   timeout / 5xx / worker lost               -> capture_unknown (read first)
capture_unknown --read--> captured (exact amount) -> payment_captured (paid booking)
                          still authorized        -> capture again (new key, bounded) | past deadline -> capture_failed
                          authorization gone      -> capture_failed (authorization leg already settled)
capture_failed: leg 1 cancel reservation (ambiguous -> read; still active -> cancel again, bounded; refused -> owner)
                leg 2 void authorization (ambiguous/refused -> read; still held -> void again, new key, bounded;
                                          gone -> settled; captured after all -> owner review, no auto refund)
both legs verified -> cancelled (guest told "not charged") -> dates released in the same transaction
```

**Unchanged:** a captured payment whose Hostaway accounting update fails or is ambiguous stays a valid paid booking (`payment_captured`). It goes to accounting reconciliation, never to automatic cancellation or refund.

## E2B.2: database clock and Checkout Session create (migration `0005`)

**A. Time for safety decisions comes from PostgreSQL**
- `release_completed_stays()`, `release_claim_if_safe(intent, reason)`, `claim_release_blockers(intent)` and `purge_guest_data(failedDays, postCheckoutDays)` take **no time argument**. They use `statement_timestamp()`. The old caller-time signatures were dropped, so no role can ask for a decision "as of" 2099.
- `released_at` is stamped by the claims trigger with the database time, whoever issues the UPDATE (the schema owner included), and every blocker is re-checked on that clock.
- `intent_transitions.recorded_at` is stamped by the database on insert. The failed-attempt retention period runs from the last database-stamped transition, not from the caller's `updated_at`. The post-checkout period runs from the immutable check-out date.
- The repository functions `tryReleaseClaim`, `claimReleaseBlockers`, `releaseCompletedStayClaims` and `purgeGuestData` refuse a `now` option (`TIME_IS_DATABASE_CONTROLLED`).
- Tests use genuinely historical fixtures: stays dated before the database's today, and, for failed-attempt retention, transition rows aged by the cluster superuser in the throwaway test cluster (`F.ageIntent`).
- **Still caller time (not safety decisions):** review scheduling (`review_after`, `listClaimsDueForReview`), lease and backoff times, and the evidence `observed_at` used by the 2-minute and 15-minute settle windows (review Finding C, before E5).

**B. An uncertain Checkout Session create is reconciled first**
- `stripe.create_checkout_session` is `reconcile_first`: one attempt per row. A timeout, 5xx or lost worker makes it `outcome_unknown`; it is **never re-queued**, whatever the delay. Stripe's 24-hour idempotency-key retention is not relied on.
- The payment attempt becomes `outcome_unknown`, a `CHECKOUT_CREATE_OUTCOME_UNKNOWN` case is opened, and the Pay step returns `CHECKOUT_CREATE_UNRESOLVED` instead of preparing another session.
- **Database-enforced:** at most one open create per intent; at most one unresolved payment attempt per intent; an attempt becomes `open` only for the session id that a **succeeded** create returned.
- **Preserved for reconciliation:** the operation row, its error code, and any late response from the interrupted worker (`late_result_status`, `late_result_ref`).

**How an unknown create is settled**

| Situation | Who | How |
|---|---|---|
| Session id known (late response, or a Stripe event carrying it) | Runtime | Read the session by id; `settle_operation_from_evidence` accepts it only if the read shows the session belongs to this payment attempt (`observed.paymentAttemptId`) and was taken ≥ 2 minutes after the call. The result is always "applied"; then `recordCheckoutSession` |
| Session found in the Stripe dashboard | Owner | `admin_resolve_operation(…, 'succeeded', [dashboard evidence], sessionId)`, then as above |
| No session id, none found | **Owner, manual until E5** | `admin_resolve_operation(…, 'failed_definite', [none_found evidence])`, only after the `expires_at` sent to Stripe + 15 minutes has passed **by the database clock**, citing a dashboard search for this payment attempt that found no session. The attempt becomes `not_created`; a new Pay creates attempt n+1 with a new Stripe key |
| Explicit Stripe refusal (error object with a code) | Runtime | `failed_definite` with that code; the attempt becomes `not_created`. Timeouts, 5xx, 429 and lease expiry are refused as "definite" |

E5 must confirm which Stripe lookup can find a session when its id is unknown, e.g. listing Checkout Sessions and matching our metadata. It must also confirm that the create request sets `metadata.paymentAttemptId`, which reads are matched on. Until then, the no-id case is manual.

**Notifications (documented, not changed):** `guest.notify` and `alert.owner` remain `idempotent` operations. A retry after an ambiguous send can deliver a **duplicate message** to the guest or owner. This is accepted until the notification stage defines provider-side de-duplication.
