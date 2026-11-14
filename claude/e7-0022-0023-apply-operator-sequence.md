# E7 C46 — 0022 + 0023 SQL-editor apply packet (shared DEV TEST, schema 21 → 23)

Reviewable packet. **ROOT reviews and owns any actual shared apply.** Claude does not run shared queries or applies. Applying 0022 / 0023 enables **no**
notification: the `.invalid` recipient / sender fences, the five runner flags, workers, routes and the queued notify row are unchanged. Refunds stay manual.

## Files (sha256 manifest — verify every byte before use)

| file | sha256 |
|---|---|
| `claude/e7-0022-0023-sqleditor-apply-v1.sql` | `9a8190cfeeec5ea09d1d239b95b582415810fe0c57d939083b1d1f40092ac030` |
| `claude/e7-0022-0023-readback-v1.sql` | `dea64d95bed2917efced332a55bff68654bdd82d94a9ee8bae92ea91757eb45a` |
| `claude/e7-0022-0023-inventory.sql` | `900df66e9d2becba43f36d65c66818cc18d483f4ce48404c17c6fd70481ad778` |
| `claude/e7-0022-0023-pins-v1.json` | `f83913c7c90a3b7768b3b981e122d65540d3d5bac15d2073ac80279e1c105640` |
| `claude/gen-0022-0023-wrapper.py` | `301406b8ed55061bcae310d34078fe64586f53796ce27707097eb952a9b7f78d` |
| `claude/derive-0022-0023-pins.mjs` | `10b4ec8f875915dc7908f43974cb9cd151cf6e5a12120ad4014272a13e0c9a68` |
| `test/db/e7-0022-0023-sqleditor-apply-wrapper.test.mjs` | `9a381fb634db6f6af0ef0371678f847683a0ce6851f32713dd0f79b7fba388c3` |
| `db/migrations/0022_gn_v2_booking_confirmation.up.sql` | `cc878c9473145a7f58dc8ad58b8bb3f198f7a6dab7f7b8f33289ef15c60690b3` |
| `db/migrations/0022_gn_v2_booking_confirmation.down.sql` | `d7fbd06551c1c7d69a398ad75f72a9883ddc31d958898876c946f718d208f348` |
| `db/migrations/0023_gn_v2_resend_receipts.up.sql` | `c551539b164b0da7c34577531fd06ad2465dc24cd493eeda0e699ca6e1ba65cb` |
| `db/migrations/0023_gn_v2_resend_receipts.down.sql` | `fb75b41e05415a3f6f24cfb0f8592402df56dd4751efda54c0cc01d26f09caa0` |

Pins: derived on a disposable cluster (`16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)`) by `claude/derive-0022-0023-pins.mjs` with the accepted migrator. PRE (21) generic identity
equals the accepted 0021 packet's POST pins key for key; history aggregate 0001-0021 `5473ec1de85742ebb2f7a3638b1a6a42ae20be219a8a0e637a425861e6698e51`.
Expected functions sha: PRE `bc3a24df47ec6ffb9937609979e4db45921bdd4093f8cbac2f65c87b35b2c1cb` → MID `53ec05bef25c2459ae7952ecffbfcf05ca7f814e3a63f48f44608361214a5cd0` → POST `50a50a7fbea38e8dd59ddd9f1094bcbd776fd465a2053f0430f0f1a4cb03ea84`; POST aggregate 0001-0023
`7df0b8fe542b7f85f43bdaf7138438c71627b7bc88a48104314eeb1482270ef0`. Catalog deltas (derived): `notification_renders` + `locale`, `copy_contract_version`; new table
`notification_provider_receipts` (must be EMPTY after).

## Immutable source

Take the packet ONLY from the merged commit, never a branch tip or a local edit:
`git show <MERGED_COMMIT>:claude/e7-0022-0023-sqleditor-apply-v1.sql | sha256sum` (same for the readback), or the raw GitHub URL pinned to that
commit SHA. Hashes must equal the manifest. Paste the whole file into ONE SQL-editor run (schema owner `postgres`, TEST project).

## Operator sequence

1. **Readback BEFORE** (pure SELECT): run `claude/e7-0022-0023-readback-v1.sql`. Continue only if `identity` equals `pre` in the pins (all keys),
   `migrations.max = 21`, the aggregate matches, `instance.environment = test`, every `exclusion` count is 0 / false, `renders_non_gn_v1_or_meta = 0` and
   `receipts_rows = null`. Keep the `data` object (counts + hashes only; TEST ids only; no guest contact, no secret).
2. **Apply**: run `claude/e7-0022-0023-sqleditor-apply-v1.sql` once. One atomic statement (SET LOCAL 180 s / lock 5 s). Success = notice `E7_23_APPLIED`
   and status `migrations_max 23, v22 true, v23 true, receipts_rows 0, functions_sha256 = POST`.
3. **Readback AFTER**: `identity` == `post`; `data` byte-identical to BEFORE (every pre-existing booking table count + whole-row fingerprint over the PRE
   column set, the original 12 render columns, the intent id set, whole 0001-0021 history rows); `renders_non_gn_v1_or_meta = 0`; `receipts_rows = 0`;
   `v22` / `v23` rows carry exactly the manifest's up / down checksums.

## Refusals and uncertain issuance

Every `E7_23_*` exception rolls the whole statement back: schema, data and history unchanged. Re-run the readback to confirm before deciding anything.

- After an **uncertain** issuance (lost reply, editor closed), read the actual state with the readback FIRST. Never re-issue blindly.
- A replay is acceptable only when the database is provably at the exact POST state. The wrapper then raises `E7_23_ALREADY_EXACT_NOOP` and writes nothing.
- `E7_23_AT_22_STOP` (schema 22), `E7_23_POST_STATE_MISMATCH_STOP:*` (partial state, different checksum, drift), `E7_23_HISTORY_*`, `E7_23_ENV_MISMATCH`, `E7_23_NOT_TEST`,
  `E7_23_SCHEMA_IDENTITY_DRIFT:*` (function / ACL / relation / RLS drift), `E7_23_NOT_SCHEMA_OWNER` → **STOP**. No repair, no down, no adoption. A
  path forward needs a separately reviewed deliberate intermediate readback.
- Quiescence refusals (`ACTIVE_RUN_LOCK_HELD`, `ACTIVE_WORK_LEASE`, `ACTIVE_INTENT_LEASE`, `OPERATION_LEASED_OR_IN_FLIGHT`, `PREPARED_TRANSACTION_PRESENT`,
  `BOOKING_WRITE_LOCK_HELD`, `55P03`, `57014`) changed nothing. Retry only once the cause is gone, re-reading BEFORE first.
- Forward-only: the operator never runs a shared DOWN. The down comparison in the tests is disposable-only.

## Proof

`test/db/e7-0022-0023-sqleditor-apply-wrapper.test.mjs`, disposable PG, 6 tests:

- C0: assembly, continuity with the 0021 pins, and this manifest.
- C1: healthy apply over realistic schema-21 history (old gn-v1 notify audit, unknown notify + case, queued `.example` notify, released / cancelled, held
  claims incl. reconciliation_required, stopped capture_unknown, captured + refunded), then the exact-POST no-op.
- C2: refusals that leave everything unchanged.
- C3: the STOP states, and a migrator-built 23 equals the exact POST.
- C4: atomic rollback under fault injection (tracking rows 22 / 23, tampered MID / POST pins and bytes) and the real time bound.
- C5: disposable no-evidence down comparison.

Untested branch: `PREPARED_TRANSACTION_PRESENT` (the harness runs `max_prepared_transactions = 0`; the readback reports the count).
