# E7 native runner: endpoint policy (P1 / P2), report-lock pre-check (P3), lock-lifetime notes (P4). Contract (LOCAL; root ruling de6285b5 B)

**Base and status.** Base: e7-test `814a0b9526e2e3e40831bddf905b2d17c285f64e`. Isolated branch `feature/e7-native-endpoint-policy`, not pushed.
- This slice IMPLEMENTS two candidate endpoints. It does **not** select the owner's machine, activate either endpoint, or connect to Supabase.

## Why

- The accepted run lock is a SESSION advisory lock, `pg_try_advisory_lock(hashtext('e7-connected-runner'), 0)`. P0 takes it on one report client, and that client keeps it across separate statements and transactions.
- Supabase's transaction pooler (port 6543) loses session-level advisory locks between transactions. The docs advise session mode or a direct connection instead ([Connect to your database](https://supabase.com/docs/guides/database/connecting-to-postgres)).
- **So 6543 is withdrawn for the native runner.**

## P1 / P2: endpoint policy (launcher only)

**Where.** `scripts/e7-connected/run-r1-launcher.mjs`, immediately after the accepted DB login reader (`readDbLoginFiles`) succeeds and BEFORE the CA read and ANY pool construction. Pure: WHATWG `URL`, no DNS, no connect.

**Exactly two accepted shapes,** both on port `5432` and database `postgres`:

| mode | host | username |
|---|---|---|
| `direct` | `db.mxotevtiscernhqilyiu.supabase.co` | a plain role name `^[a-z_][a-z0-9_]{0,62}$` (no project suffix) |
| `session-pooler` | `aws-0-us-east-1.pooler.supabase.com` | `<role>.mxotevtiscernhqilyiu`, where role matches the same rule |

**Both login files must use the SAME mode, host, port and database** (in addition to the accepted reader's text rule).

**Refused** with `ENDPOINT_MODE_REFUSED` (stage `db-endpoint`), before any pool exists:
- port 6543, 6432 or any other port;
- any other host, including other Supabase projects and regions and IPv4 / IPv6 literals;
- mixed endpoints;
- a missing or wrong pooler suffix;
- a suffix on the direct host;
- any other database;
- an unparsable URL.

**Kept as before:** the accepted reader's no-query / sslmode rules, the verified TLS + CA pool, and the credential invariants.
- No URL, user, host or password appears in any result or error.

**Test-only seam** (in-process only): `hooks.launch.loopbackEndpointsForTests === true` additionally admits loopback hosts (`127.0.0.1`, `localhost`, `[::1]`) for the disposable-PG suites.
- `hooks.launch` is supplied only by in-process callers. The native boot passes `defaultHooks()`, which has no `launch`.
- So the seam cannot be selected through argv or env.

## P3: report-lock pre-check (launcher only; read-only; mandatory for BOTH modes)

**Where.** After pool construction, BEFORE the journal is created and before `runReservationAbortR1`.

**How.** On ONE separate report client (connect bounded 10 s, query bounded 5 s, both scaled only by the in-process `timeScale` seam), run exactly:

```sql
SELECT count(*)::int AS n FROM pg_catalog.pg_locks l
 WHERE l.locktype = 'advisory' AND l.granted
   AND l.database = (SELECT d.oid FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database())
   AND l.classid = ((pg_catalog.hashtext($1)::bigint + 4294967296) % 4294967296)::oid
   AND l.objid = 0::oid AND l.objsubid = 2
```

with `$1 = LOCK_KEY` (imported from the accepted `run-core.mjs`).

**Mapping.**
- The two-int4 form `pg_try_advisory_lock(k1, k2)` stores `classid = k1`, reinterpreted as an unsigned 32-bit oid (a negative `hashtext` becomes `2^32 + h`), with `objid = k2` (0) and `objsubid = 2`.
- The bigint form stores `objsubid = 1`, so it never matches.
- Locks held in another database of the cluster never match, because of the `l.database` filter.

**Outcomes:**
- `n = 0` → continue to the accepted P0, which stays decisive and atomic.
- `n > 0` → refuse with `RUN_LOCK_PRESENT_BEFORE_START`.
- Connect / query rejected or timed out, malformed rows, or interrupted (the run signal aborted before or during it) → refuse with `LOCK_PRECHECK_UNAVAILABLE` / `LOCK_PRECHECK_INTERRUPTED`.

**Safety rules:**
- Exactly one statement. No SQL after a failed or unknown read.
- The client is destroyed exactly once (`release(true)`). A client that arrives after a connect timeout or interrupt is destroyed on arrival.
- It never unlocks, terminates, adopts or deletes anything, and never echoes an error.

**P3 is a snapshot diagnostic only.**
- It is not evidence that grants execution, and it is not a cure for pooler lock retention.
- The accepted lock algorithm, core and guard are unchanged.

## P4: lock-lifetime notes (documentation only)

- **Direct:** a session advisory lock disappears WHEN the backend session ends. `client.destroy` / `release(true)` is not instant proof that the remote backend has gone (network delay, and the open native E2 backend-PID observation, remain).
- **Session pooler:** disconnect / reset semantics are UNKNOWN. Whether a pooled backend keeps a session lock after the client disconnects is not documented, so the guard's "destroyed ⇒ released" label is only meaningful for direct connections.
- **Not closed by this slice:** neither P3 nor the local tests close that live hold.
  - No pooled execution-readiness claim until the actual endpoint behaviour, CA chain and network have been separately reviewed.
  - A live lock-acquisition / reset probe would itself change lock state. It is not a read-only SELECT probe and is not run here.

## Scope and digests

- **Runtime:** `run-r1-launcher.mjs` only.
- **Unchanged:** core, guard, lock algorithm, journal, transports, pool, reader, schema, grants, Vercel URL and settings, secrets.
- **Source lists:** `NATIVE_EXEC_SOURCES` (56), `RUN_PLAN_CLOSURE` (50) and `R1_EXECUTOR_CLOSURE` (30) are unchanged; the new import is from `run-core.mjs`, which is already in the closure.
- **Digests:** the native digest changes; foundation and G1 are unchanged, since the launcher is outside both.
