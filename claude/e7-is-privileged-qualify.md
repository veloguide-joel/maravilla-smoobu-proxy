# Migration 0018 — schema-qualify `booking.is_privileged()` (root security-fix approval, 2026-11-07). Contract (LOCAL; disposable PG only)

**Base / branch.** Base e7-test `814a0b9526e2e3e40831bddf905b2d17c285f64e`; isolated branch `feature/e7-is-privileged-qualify`, not pushed. Companion to the static finding in `scratchpad/secinv/e7-is-privileged-search-path-finding-2026-11-07.md` (status: STATIC, the bypass was NOT reproduced by me; no exploit executed). This slice implements the approved fix and tests the **boolean contract only** — no protected booking write and no guard-bypass demonstration.

## The weakness (recap, one line)
`booking.is_privileged()` (0003) reads `pg_namespace` **unqualified** and has **no** `SET search_path`. Per PostgreSQL, `pg_temp` (when unlisted) is searched first for relation names, so a session temp relation named `pg_namespace` can be resolved before `pg_catalog.pg_namespace`. `pg_get_userbyid` is a function name and is never searched in `pg_temp`.

## 0018 up — replaces ONLY `booking.is_privileged()`
- `CREATE OR REPLACE FUNCTION booking.is_privileged()` — **signature, `RETURNS boolean`, `LANGUAGE sql`, `STABLE`, and SECURITY INVOKER (default) all unchanged**. `CREATE OR REPLACE` keeps the owner and the ACL.
- Body change: both catalog references **fully schema-qualified** — `pg_catalog.pg_namespace`, `pg_catalog.pg_get_userbyid`. Qualification is the real fix: it is immune to any `search_path` / `pg_temp` manipulation.
- Adds a function-local `SET search_path = pg_catalog, pg_temp` (pg_temp explicit and LAST) — defense in depth, and it clears the Supabase "mutable search_path" advisor warning for this function.
- Semantics are identical to the intended 0003 behaviour: `true` iff `current_user` is the owner of schema `booking` (i.e. running as the owner, or inside a schema-owner SECURITY DEFINER function); `false` for the runtime roles.

## 0018 down — restores the prior definition **exactly**
- `CREATE OR REPLACE` back to the 0003 body verbatim: `SELECT current_user::text = (SELECT pg_get_userbyid(nspowner)::text FROM pg_namespace WHERE nspname = 'booking')`, `LANGUAGE sql STABLE`, no proconfig. Owner/ACL unchanged by `CREATE OR REPLACE`. Byte-for-byte the 0003 text.

## Invariants (asserted by the test; disposable 1→18 cluster)
- **Applied 1–17 byte-exact** — not edited. 0018 is additive and contiguous (version 18).
- **Catalog compare** across the 0018 up: `proname`, `pronargs`/`proargtypes` (signature), `prorettype`, `prolang`, `provolatile` (`s`), `prosecdef` (`false`), `proowner`, and `proacl` are **identical** before and after; only `prosrc` and `proconfig` change (proconfig gains `search_path=pg_catalog,pg_temp`).
- **No other change**: no grants/role/TEMP/RLS/extension changes, no booking-row DML, no other function touched.

## Boolean-contract tests (what is asserted; NO protected write, NO bypass demo)
Fresh disposable cluster from migrations 1–18, realistic app/report LOGIN memberships (`test_app ∈ mv_booking_app`, `test_report ∈ mv_booking_report`, owner = migrator):
1. **Fixed function (at 18):** `is_privileged()` = `false` as app and as report, `true` as owner — under BOTH a default session `search_path` and an explicit `SET search_path = pg_catalog, booking`, AND when the calling session additionally holds a same-session temp relation named `pg_namespace` crafted to assert privilege. The fix must stay correct in every combination.
2. **Temp-relation precondition (recorded, not assumed):** the test attempts `CREATE TEMP TABLE pg_namespace(...)` as the app role and records the ACTUAL result. If PostgreSQL refuses a `pg_`-prefixed temp relation, that result is preserved and the finding is reassessed (the specific vector would be blocked; the fix still stands on pattern grounds). No success is invented.
3. **Failing-before control (old function, via `0018 down` → version 17):** with the OLD unqualified definition restored byte-exact, assert the boolean contract to document the difference — i.e. that the old function's result is subvertible under the shadow where the new one is not. Boolean return values only; no guard bypass, no protected state write, nothing persisted.
4. **Clean-session controls:** a fresh connection with no temp relation returns the correct boolean for every role, old and new.
5. **Caller regression:** a representative `is_privileged()`-gated guard still refuses an ordinary app-role write and still admits the owner path — asserting the callers remain correct after the body change. (Assertion on the guard's accept/refuse outcome, using existing suites' patterns; no new protected-write exploit.)
6. **current_user / inlining evidence** captured where relevant (the function is a trivial SQL STABLE that the planner may inline; `EXPLAIN`/`current_user` observations recorded).

## Boundaries
- Disposable PG only. **No shared DEV apply, no push, no public PR** until root review (the fix must not be published ahead of remediation).
- No secrets; no credential/grant/role/TEMP/RLS/search-path **setting** change anywhere; no provider/intent/notification; no machine/network change.
- The other 19 mutable-search-path advisor warnings and `btree_gist` are out of scope — no mass fix.
