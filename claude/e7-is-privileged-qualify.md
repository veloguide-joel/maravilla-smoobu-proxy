# Migration 0018 — schema-qualify `booking.is_privileged()` (root security-fix approval, 2026-11-07). Contract (LOCAL; disposable PG only)

**Base / branch.** Base e7-test `814a0b9526e2e3e40831bddf905b2d17c285f64e`; isolated branch `feature/e7-is-privileged-qualify`, not pushed. Companion to the finding in `scratchpad/secinv/e7-is-privileged-search-path-finding-2026-11-07.md`.

**Reproduction status (updated by this slice; supersedes the companion report's earlier "STATIC / not reproduced" wording, which is now historical).** The **function-level boolean flip is now reproduced** on a disposable cluster: PostgreSQL permits an app-role `CREATE TEMP TABLE pg_namespace`, and the OLD unqualified `is_privileged()` then returns `true` for the app role, while the fixed function returns `false`. A **full end-to-end protected-write guard bypass was NOT demonstrated** (out of scope by ruling); this slice tests the **boolean contract and caller context only** — no protected booking write.

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
1. **Fixed function (at 18):** `is_privileged()` = `false` as app, `true` as owner, and **permission-denied (SQLSTATE 42501)** as report — report holds **no EXECUTE** on the function (0003 C7 grants EXECUTE to `mv_booking_app` + `mv_booking_admin` only), so the real contract for report is a privilege error, not `false`; the test preserves that ACL and never grants report EXECUTE to make an assertion pass. Correct under BOTH a default session `search_path` and an explicit `SET search_path = pg_catalog, booking`, AND when the calling session additionally holds a same-session temp relation named `pg_namespace` crafted to assert privilege. The fix must stay correct in every combination.
2. **Temp-relation precondition (recorded, not assumed):** the test attempts `CREATE TEMP TABLE pg_namespace(...)` as the app role and records the ACTUAL result. If PostgreSQL refuses a `pg_`-prefixed temp relation, that result is preserved and the finding is reassessed (the specific vector would be blocked; the fix still stands on pattern grounds). No success is invented.
3. **Failing-before control (old function, via `0018 down` → version 17):** with the OLD unqualified definition restored byte-exact, assert the boolean contract to document the difference — i.e. that the old function's result is subvertible under the shadow where the new one is not. Boolean return values only; no guard bypass, no protected state write, nothing persisted.
4. **Clean-session controls:** a fresh connection with no temp relation returns the correct boolean for every role, old and new.
5. **Guard-evaluation control (guard isolated from table ACL):** because the app has **no INSERT** on `booking.reconciliation_resolutions`, an insert there would be refused at the table-ACL layer (42501) *before* the trigger — which would not demonstrate guard evaluation. So the test builds a DISPOSABLE scaffold table `public._e7_guard_probe` (app explicitly granted INSERT) whose BEFORE INSERT trigger runs the EXACT accepted `booking.resolutions_guard()`: an app insert is refused with 42501 FROM THE GUARD (message "owner functions", i.e. `is_privileged()` returned false); an owner insert is admitted (rolled back). The scaffold is dropped; no protected booking table is written. It is test scaffolding, not a claim about production table ACLs.
6. **Caller-context control (current_user-based):** the owner creates two trivial wrappers over `booking.is_privileged()` — one SECURITY DEFINER, one SECURITY INVOKER — both granted to app. Called by the app role, the DEFINER wrapper returns `true` (effective `current_user` becomes the owner — the intended privileged path) and the INVOKER wrapper returns `false`. This is the actual current_user coverage; no `EXPLAIN` or inlining measurement is claimed (none was performed).

## Shared DEV TEST apply — 2026-11-07 (dated annotation; supersedes the historical local-only boundary below)
- The historical stage of this slice was **local / disposable only** (that boundary is kept explicit below as it stood through review).
- Root then authorized ONE shared apply. On **2026-11-07** the reviewed wrapper (`claude/e7-0018-sqleditor-apply-v1.sql`, sha256 `90134dc4…`) was applied **once** to the shared DEV **TEST** database `mxotevtiscernhqilyiu` via the owner `postgres` Supabase SQL editor, with a matching read-only PRE/POST (readback + quiescence). POST was accepted (by this session and independently by root): only `is_privileged` `prosrc` (→ `a14a1dc5…`) and `proconfig` (→ `search_path=pg_catalog, pg_temp`) changed, plus exactly one v18 tracking row; OID 18673, owner, ACL, all other attributes, every other booking function, the 0001–0017 history (`c8b46a43…`), and all 28 booking-table row fingerprints are **identical**. No down/replay; the local branch remains **unpushed**; no public security PR from this session.

## Boundaries (historical — as they stood through review; the shared TEST apply above was the one authorized exception)
- Disposable PG only through review. **No shared DEV apply, no push, no public PR** until the explicit root ruling that authorized the single TEST apply recorded above (the fix was not published ahead of remediation).
- No secrets; no credential/grant/role/TEMP/RLS/search-path **setting** change anywhere; no provider/intent/notification; no machine/network change.
- The other 19 mutable-search-path advisor warnings and `btree_gist` are out of scope — no mass fix.
