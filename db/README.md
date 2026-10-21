# Booking database (Stage E2B — offline foundation)

Schema `booking` for the new maraVilla direct-booking checkout. Design: project doc
`claude/e2a-booking-database-design-2026-10-21.md`.

**Status**
- **Not connected to anything.** The layer lives in `db/lib/`, outside the deployable `api/` and `lib/` trees, and no route imports it. The E1 containment test (`test/legacy-routes-retired.test.mjs`) still forbids database writes in `api/` and `lib/`. Wiring this layer into a route (E5–E7) must update that test deliberately, with owner approval.
- No hosted database exists yet. Provisioning is stage **E2C** and needs owner approval.
- External dispatch to Stripe and Hostaway is disabled.

## Layout

| Path | Purpose |
|---|---|
| `db/migrations/NNNN_name.{up,down}.sql` | Versioned migrations. `0001` is the schema; `0002` adds roles and grants (no passwords) |
| `db/lib/migrate.js`, `scripts/db-migrate.mjs` | Migration runner, with checksums, an environment marker and an advisory lock |
| `db/lib/repo.js` | E3 persistence: CAS transitions, audit, event de-dup, outbox, claims, payment and Hostaway attempts, cases, guest data |
| `db/lib/operations.js` | Outbox claim, complete and recover, by retry class. `dispatchOperation` refuses without an injected executor |
| `db/lib/webhooks.js` | Permanent Stripe event de-duplication (call only after signature verification) |
| `db/lib/config.js` | Tunables, plus the **provisional** guest-data retention (O6) |
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
