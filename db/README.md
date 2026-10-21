# Booking database (Stage E2B — offline foundation, with E2B.1 safety corrections)

Schema `booking` for the new maraVilla direct-booking checkout. Design: project doc
`claude/e2a-booking-database-design-2026-10-21.md`.

**Status**
- **Not connected to anything.** The layer lives in `db/lib/`, outside the deployable `api/` and `lib/` trees, and no route imports it. The E1 containment test (`test/legacy-routes-retired.test.mjs`) still forbids database writes in `api/` and `lib/`. Wiring this layer into a route (E5–E7) must update that test deliberately, with owner approval.
- No hosted database exists yet. Provisioning is stage **E2C** and needs owner approval.
- External dispatch to Stripe and Hostaway is disabled.

## Layout

| Path | Purpose |
|---|---|
| `db/migrations/NNNN_name.{up,down}.sql` | Versioned migrations. `0001` is the schema; `0002` adds roles and grants (no passwords); `0003` adds the E2B.1 evidence, settlement and privilege rules |
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
  - A confirmed booking releases on check-out day, computed in Mexico City time.
- **Payment end and void**
  - A payment attempt ends (`expired`/`failed`) only with Checkout Session evidence showing `expired`. A declined card ends nothing.
  - `authorization_released` after a refusal requires the void operation to have succeeded.
- **Cancellation:** `capture_failed → cancelled` requires the Hostaway cancel operation to have succeeded **and** a read showing the reservation cancelled. A definite capture failure also schedules a void, which the E3 state machine doesn't emit (E3.2 candidate).
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
