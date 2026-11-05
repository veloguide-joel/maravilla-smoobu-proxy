# E7 Route B — SQL-editor scripts for migrations 0006–0016 (OFFLINE; for root review only)

Status: generated and tested offline. **Not approval.** Nothing was run on any hosted database. There was no credential, provider, deploy or merge action.

- Branch `feature/e7-routeb-editor-scripts`, from exact `48171a3fb91f2fe49d317ed7dccbdb56a0289c03` (packet; accepted code `6d703acd` underneath).
- Migration files 0001–0016 are byte-identical to the base (`git diff 48171a3f -- db/migrations` is empty).
- Target `mxotevtiscernhqilyiu` stays **UNVERIFIED** until a separately approved read-only D1 preflight. No assumption is made about its live data, roles or credential availability.

## NEW implementation

`scripts/e7-routeb-gen.mjs` is a **new implementation**, not a restoration:

- It uses Node built-ins only (`node:fs`, `node:path`, `node:crypto`, `node:url`).
- It does not import `db/lib/migrate.js`, or any runtime, adapter or pinned module.
- The historical uncommitted 2026-10-21 generator (`e3ea1ffc…c4fb7`) was **not** restored, and its hash is not claimed.

Regenerate with:

```
node scripts/e7-routeb-gen.mjs claude/evidence/e7-routeb-2026-11-05
```

## Semantics reproduced from `db/lib/migrate.js` (line numbers at `6d703acd`)

| runner | script |
|---|---|
| `FILE_RE` :17, `loadMigrations` :27-46 (pairs, no gaps) | same rules, plus refusal of non-exact UTF-8, BOM, NUL, CR, top-level `BEGIN` / `COMMIT` / `ROLLBACK`, or the guard tag inside a body |
| checksum = SHA-256 of the UTF-8 text :20, :35-37 | SHA-256 of the file bytes (identical, because the UTF-8 round trip is required to be exact); test G3 compares against `loadMigrations` |
| `inTx` :78-89: `BEGIN`, `pg_advisory_xact_lock(7302215001)` | `BEGIN;` then `SELECT pg_advisory_xact_lock(7302215001);` (the same key; R4 proves contention with it) |
| `verify` :63-76, `databaseEnvironment` :55-59 | DO guard, under the lock: `booking_migrations.applied` exists; no row at version ≥ N; the FULL JOIN of the applied rows against the exact expected prior rows 1..N-1 (version, name, up/down checksum, environment `test`) has zero mismatches; `booking.instance` has exactly 1 row and it is `test` |
| ORDER :116 | covered by the exact-prior-set check (a missing earlier version is a mismatch) |
| `set_config('booking.migration_environment', env, true)` :117; the up SQL; the history INSERT :119 | identical statements; the migration text is embedded verbatim between two marker lines; the INSERT runs only after the whole body succeeded, in the same transaction, then `COMMIT;` |

**Deliberate differences:**

- The environment is fixed to `test`.
- A row at version ≥ N raises `E7RB_ALREADY_APPLIED_OR_LATER`, where the runner silently no-ops.
- A missing `booking.instance` is refused. The runner tolerates it before 0001, which is not relevant from 06 on.
- `SET LOCAL lock_timeout = '15s'` and `SET LOCAL statement_timeout = '600s'` bound waits inside the single transaction. They apply only to that transaction.
- No down script, schema reset, guest SELECT or repair is generated.
- Only validated literals are interpolated: `[a-z0-9_]` names, 64-hex checksums, and integers.

**Refusal codes:**

- `E7RB_BOOKKEEPING_MISSING`
- `E7RB_ALREADY_APPLIED_OR_LATER`
- `E7RB_HISTORY_MISMATCH` (order, drift, missing, unknown, or a non-`test` row)
- `E7RB_INSTANCE_MISSING`
- `E7RB_ENV_MISMATCH`

Any refusal leaves the session in a failed transaction, and nothing is applied.

## Operator rules (for the later, separately approved run)

1. Run `pre_verify.sql`; every `ok` must be true. `data_counts` and `other_logins_in_booking_groups` are reported, not asserted.
2. Paste each script exactly. Check its SHA-256 against the table below first. Submit it ONCE, in order 06 → 16.
3. On **any** error, or if it is uncertain whether the submission or COMMIT happened:
   - STOP;
   - run `ROLLBACK;` (harmless if nothing is open);
   - inspect history read-only with `post_verify.sql` / `pre_verify.sql`.
   
   **Never re-run blindly.** The SQL editor is **not** assumed to be exactly-once. If a script did commit, re-running it is refused (`E7RB_ALREADY_APPLIED_OR_LATER`), but that refusal is a safety net, not a procedure.
4. After 16, run `post_verify.sql`; every `ok` must be true, and `data_counts` must equal the PRE counts.

## Files and SHA-256

| file | sha256 |
|---|---|
| `scripts/e7-routeb-gen.mjs` | `e54bec3e64ae33de9309d728cefb77c060e1bed2f7f17398e989a8134dc8230f` |
| `test/e7-routeb-gen.test.mjs` | `1ddcea455ea40ab84938695ca51283ab73c0ff0c8147b679f0b4668d65340e0f` |
| `test/db/e7-routeb-editor-scripts.test.mjs` | `76d8ca94c0f15cafc5a006fb59a4bae967bb35a65c6d622d0548fae05279bfd8` |
| `06_api_rate_limits.sql` | `bc65a1c3a2c42f26e026c773b4062fa14302cc06cd818fe05758f47da3ca5990` |
| `07_capture_claim_fence.sql` | `45fe8b9393792cd5400c996c20e01e607790cbf7e632f1f4e1f68cae75a6784d` |
| `08_settled_evidence_immutable.sql` | `4bdc60c2bfc1fe76dc2aa8ed04e1f7c69bfa12ab72d3c3b763e348789a088145` |
| `09_void_cancel_claim_fence.sql` | `bf7c6ab11d4776e750fb65718dd4810490d2188a9e8b9ceab184854a586057f5` |
| `10_recording_evidence_link.sql` | `9f265a8c170bba583da4012bbdde84541c1d93e02c6e64043e0aa77ba57e7a2f` |
| `11_recording_owner_cases.sql` | `b98cf534bfa1f6058552d96b7419b501dd010a435248b3ad200b28b1cf7e14a6` |
| `12_recording_assessments.sql` | `0961e728e6a07683fc5ea66e70441eeeca20150e85af96a234f006d5c10e172e` |
| `13_recording_preflight_release.sql` | `dc85ae7c94df7480b3466e65500224748bc5cc3b73dd01fa1fd7da79d283305d` |
| `14_recording_completion_binding.sql` | `07a6eecc8bf3d127561a401883b747a2aec4236803b2e9f1a283992df87ea626` |
| `15_scoped_recording_inbox.sql` | `b784eadefd69cce305922474ff6d7af4a9bd8e86719872bc58edffdd2e3a1369` |
| `16_guest_notification_fence.sql` | `cec697fda937932f9e980930dcbf5bddfc00d008bd313679aa5305b66c6c5a0b` |
| `pre_verify.sql` | `14b5126dc4db77fbbfd34b174a131bb0f7d53270c8e669892234cc0da5035d77` |
| `post_verify.sql` | `ca57304182f3aa8e48c97949710535399b7d52d82252f2ec663369350924e6d0` |
| `manifest.json` (per-script up/down checksums, body offsets, lock key, timeouts, history 1–5) | `d3ee22af6a8be7c9b364a41f08a991c6e1b674284f799550ae4cb2e3b6211f06` |

The embedded up/down checksums equal packet §1.

## Verification SQL (read-only: `BEGIN READ ONLY … ROLLBACK`; catalog and aggregates only, never a guest column)

**PRE (1–5), 14 rows:**

- `instance_test`
- `history_exactly_1_to_5`
- `new_tables_absent`
- `pre_tables_present` (17)
- `btree_gist`
- roles:
  - the 3 NOLOGIN groups;
  - `mv_booking_app_dev` LOGIN, not super / bypassrls / createrole / createdb;
  - member of `mv_booking_app` only;
  - other logins reported
- 0006 precondition: no duplicate token hash
- 0011 precondition: no `OFFLINE_CHARGE_HOLD_*` case
- the 0016 up's exact `NOTIFY_UPGRADE_PRECONDITION` predicate, plus one notify row per intent
- `data_counts`

The 0012–0015 preconditions concern objects that do not exist at 5. 0014's binding check is vacuous at 5.

**POST (1–16):**

- instance and history 1–16
- the new tables
- RLS on every booking table
- no PUBLIC / anon / authenticated table grant
- the `mv_booking_app` privilege matrix exactly equal to `scripts/db-smoke.mjs` `EXPECTED_TABLE_PRIVS` (28 tables; test G4 checks the equality from source)
- allowed / denied functions equal db-smoke's `FUNCS_ALLOWED` / `FUNCS_DENIED`
- `btree_gist`
- roles
- `data_counts`

## Evidence (CLAUDE-run, local disposable PostgreSQL 16.15; nothing hosted)

**Unit tests** `test/e7-routeb-gen.test.mjs` (G1–G7). First full TAP: 6/7. The G2 failure was a test expectation: the lock statement also appears in a header comment. After counting executable lines only: 7/7.

| test | what it checks |
|---|---|
| G1 | two runs byte-identical, and equal to the committed files |
| G2 | the body is verbatim at its offset, once; one BEGIN / COMMIT / lock; order lock → guard → set_config → body → INSERT |
| G3 | checksums equal `loadMigrations`; every guard carries the exact prior rows |
| G4 | db-smoke parity |
| G5 | the verification SQL is read-only, with no guest column |
| G6 | the source imports built-ins only, with no containment-pinned name |
| G7 | the CR / BOM / NUL / non-UTF-8 / gap / pair / filename / tx-control / guard-tag refusals; an indented PL/pgSQL `BEGIN` is accepted |

**DB tests** `test/db/e7-routeb-editor-scripts.test.mjs` (R1–R7), with every migration run as the NON-superuser owner `sbpostgres` (CREATEROLE, CREATE on the database).

- First full TAP: 0/7. This was a test-setup bug: `CREATE DATABASE` was inside a multi-statement query, and `after` stopped the wrong object.
- Run 2: 4/7. The causes were a wrong row-count expectation (14, not ≥ 15), and a fingerprint key that read a table absent at version 5 (test-only).
- Run 3: **7/7**.

| test | result |
|---|---|
| R1 | PRE passes on the runner-built 1–5 database |
| R2 | the runner builds 1–5, then the generated 06..16 are each submitted ONCE as one simple-protocol query (the editor's shape) → history 1–16 with exact rows; POST all `ok`; the POST rows equal those of a runner-built 1–16 cluster; the **catalog fingerprint** (namespaces, relations + ACL / RLS, columns, constraints, indexes, triggers, function definitions + ACL / owner / secdef, policies, roles, memberships, extensions, default ACLs, history excluding `applied_at`, instance) **equals the runner 1–16 path**; `recording_assessment_codes` = 51 seed rows on both; `migrationStatus` applied 1–16 / pending []; a further `migrateUp` is a no-op; PRE on the finished database fails exactly `history_exactly_1_to_5` + `new_tables_absent` |
| R3 | re-running 06 / 16 → `E7RB_ALREADY_APPLIED_OR_LATER`; the session is in a failed tx (25P02) until ROLLBACK; history and fingerprint unchanged |
| R4 | at 1–5, each refusal followed by ROLLBACK with history and fingerprint unchanged: 07 first and 16 first (order); drifted up checksum; drifted name; a history row with env live; a missing row 2; the instance marker live (`E7RB_ENV_MISMATCH`); a database with no bookkeeping. Lock contention: another session holds `pg_advisory_xact_lock(7302215001)` → the script fails with 55P03 after ≈15 s, nothing applied, and the lock is free after ROLLBACK |
| R5 | a mid-body failure (a pre-created conflicting index name makes 0006's LAST statement fail after its table / index / function were created) → the whole transaction rolls back: no partial object, no history row, fingerprint unchanged; after removing the conflict, the SAME script applies once |
| R6 | a database built with env `live` → `E7RB_HISTORY_MISMATCH` (5 rows), unchanged; PRE flags `instance_test` + history |
| R7 | POST strictness: an extra `DELETE` grant → only `runtime_privilege_matrix_exact_0016` fails; an extra group membership of `mv_booking_app_dev` → only `runtime_login_member_of_app_only` fails |

**Regressions:** `npm test` (all `test/*.test.mjs`, including G1–G7), run once: 927/927. No mutation campaign or full DB suite repetition (not required).

## Limits

- **The local disposable cluster is not Supabase.** Hosted role attributes, `anon` / `authenticated` grants, default ACLs from the platform, pooler behaviour and the editor's own statement handling are unverified. The editor submission shape is modelled as one simple-protocol multi-statement query.
- **The timeouts are bounds, not guarantees.** The 600 s statement timeout is per statement; the editor may impose its own limit.
- **[gap] Missing smoke-test execution mechanism.** The packet's post-upgrade `scripts/db-smoke.mjs` needs the runtime credential (`mv_booking_app_dev`), and there is no reviewed non-owner way to run it. `post_verify.sql` covers its catalog checks read-only from the editor, but it is not a login-path / TLS smoke. Flagged; not broadened.
