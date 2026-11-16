# E7 C112a — 0024-only SQL-editor apply packet (shared DEV TEST, schema 23 → 24)

Reviewable packet. **ROOT reviews and owns any actual shared apply.** Claude does not run shared queries or applies.

Applying 0024 enables **no** dispatch and **no** booking flow:
- The hosted kickoff runner on main ships `executeEnabled` / `dispatchEnabled` **FALSE**, alongside the 8 pre-existing execute flags (all FALSE).
- No worker, flag, workflow or route changes.
- The new trigger only RECORDS future in-scope `payment_pending → payment_authorized` transitions as `requested` rows. A request is not a booking, not an execution and not a completion.

Refunds stay manual. Protected reservations and the historical intents are untouched; the packet fingerprints them, sanitized.

## Files (sha256 manifest — verify every byte before use)

| file | sha256 |
|---|---|
| `claude/e7-0024-sqleditor-apply-v1.sql` | `e91b77cb10e7a82cf3982e00c04d1b1cde14f96c2b00f919f9d376097c6c6918` |
| `claude/e7-0024-readback-v1.sql` | `823374a9cf58c665a1a597e22b63543df9afdeacc2ceef62388f5170d147592d` |
| `claude/e7-0024-inventory.sql` | `be5ef04b8a0972cebee4a404972156eb917cf05ce98886013b8bb4cddcc4853f` |
| `claude/e7-0024-pins-v1.json` | `8cc07744b62457b6debb163239250e3c2c8f19c03c32e3d2b7e5a1a0f002685e` |
| `claude/gen-0024-wrapper.py` | `7908faa0a2d198e6895a20c905260f0c5f6e1aa4ef53d083958598465eaded0a` |
| `claude/derive-0024-pins.mjs` | `15cf65ac432941ebef634df0adc3e566b45e968f923bb94b298edca66f0999d8` |
| `test/db/e7-0024-sqleditor-apply-wrapper.test.mjs` | `34bcfdb821c56f2d4a5c1c328d8bc7f00b5057f7bd02dcca637843d7994bb8a6` |
| `db/migrations/0024_pipeline_kickoff_requests.up.sql` | `f5c97d010eae9c83d0b798064b6491cffe73e01a03f130e8281b38e763f287fc` |
| `db/migrations/0024_pipeline_kickoff_requests.down.sql` | `3bfe7d8952b7fc9a3178418dc1842d054e845fb8cedc3225920f9b1b72bc6aa9` |

## Pins

- Derived on a disposable cluster (`16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)`) by `claude/derive-0024-pins.mjs` with the accepted migrator. Re-derivation on PG 17.11 is identical except `derivedOnPg`.
- PRE (23) generic identity equals the accepted 0022 / 0023 packet's POST pins key for key.
- History aggregate 0001-0023 `7df0b8fe542b7f85f43bdaf7138438c71627b7bc88a48104314eeb1482270ef0` = the shared-DEV exact post-23 state (C63).
- Expected functions sha: PRE `50a50a7fbea38e8dd59ddd9f1094bcbd776fd465a2053f0430f0f1a4cb03ea84` → POST `8e73bb25c38f0a6e32566483c9a6cf57a6faa9f5feebdee34ec381564265304d`.
- POST aggregate 0001-0024: `bcd453f800c037e978138d5d6bf979baaa00b46cbe807fb7aca8281a9cacc7f2`.
- Catalog delta (derived): new table `pipeline_kickoff_requests` (must be EMPTY after); NO column added to any pre-existing table. +4 triggers: 3 on the new table, plus `intents_pipeline_kickoff` on `booking.intents`, enabled. +1 policy (`app_admin_read`).

**Kickoff catalog parity:** `pins.kickoffCatalogPins` equals `scripts/e7-hosted-kickoff.mjs` `CATALOG_PINS` on main `8503716bbe0eca27197b59818487a7200895f603` (runner sha256 `66f3001424c2adf85026e89bb3eb9d20c73275c7493e41fc81f18276bddeb60b`). That covers the 7 functions (source md5 / SECURITY DEFINER / volatility / search_path / non-owner ACL), and RLS on, with app SELECT only, plus the intents trigger. The wrapper re-checks this in-transaction for `mv_booking_app`.

## Immutable source

Take the packet ONLY from the merged commit, never from a branch tip or a local edit:

`git show <MERGED_COMMIT>:claude/e7-0024-sqleditor-apply-v1.sql | sha256sum`

Do the same for the readback, or use the raw GitHub URL pinned to that commit SHA. Hashes must equal the manifest. Paste the whole file into ONE SQL-editor run (schema owner `postgres`, TEST project `mxotevtiscernhqilyiu`).

## Operator sequence

1. **Readback BEFORE** (pure SELECT): run `claude/e7-0024-readback-v1.sql`. Continue only if:
   - `identity` equals `pre` in the pins (all keys);
   - `migrations.max = 23` and the aggregate matches;
   - `instance.environment = test`;
   - every `exclusion` count is 0 / false;
   - `kickoff_rows = null` and `kickoff_catalog = null`.

   Keep the `data` object: counts and hashes only, TEST ids only, no guest contact, no secret.
2. **Apply**: run `claude/e7-0024-sqleditor-apply-v1.sql` once. It is one atomic statement (SET LOCAL 180 s / lock 5 s). Success means:
   - notice `E7_24_APPLIED`;
   - status `migrations_max 24, v24 true, pipeline_kickoff_requests true, claim_pipeline_kickoff true, kickoff_rows 0, functions_sha256 = POST`.
3. **Readback AFTER**:
   - `identity` == `post`;
   - `data` byte-identical to BEFORE: every pre-existing booking table count + whole-row fingerprint, the intent id set, whole 0001-0023 history rows, and the protected-reservation / historical-intent fingerprints;
   - `kickoff_rows = 0`;
   - `kickoff_catalog` == `pins.kickoffCatalogPins`;
   - the `v24` row carries exactly the manifest's up / down checksums.

## Refusals, rollback and uncertain issuance

Every `E7_24_*` exception rolls the whole statement back: schema, data and history unchanged. Re-run the readback to confirm before deciding anything.

- **Uncertain issuance** (lost reply, editor closed, timeout): read the actual state with the readback FIRST. Never re-issue blindly.
  - If it shows the exact POST state, the apply landed. A re-issue would only raise `E7_24_ALREADY_EXACT_NOOP` and write nothing.
  - If it shows the exact PRE state, nothing landed.
  - Anything else → **STOP** for review.
- **STOP, no repair, no down, no adoption:**
  - `E7_24_POST_STATE_MISMATCH_STOP:*` (partial state, foreign checksum, function / ACL / kickoff-catalog drift at 24);
  - `E7_24_HISTORY_*`, `E7_24_ENV_MISMATCH`, `E7_24_NOT_TEST`;
  - `E7_24_SCHEMA_IDENTITY_DRIFT:*`, `E7_24_VOCABULARY_ALREADY_PRESENT` (a 0024 object already present is never adopted), `E7_24_0023_PREREQUISITE_MISSING`;
  - `E7_24_NOT_SCHEMA_OWNER`.

  A path forward needs a separately reviewed deliberate intermediate readback.
- **Quiescence refusals changed nothing:** `ACTIVE_RUN_LOCK_HELD`, `ACTIVE_WORK_LEASE`, `ACTIVE_INTENT_LEASE`, `OPERATION_LEASED_OR_IN_FLIGHT`, `PREPARED_TRANSACTION_PRESENT`, `BOOKING_WRITE_LOCK_HELD`, `55P03`, `57014`. Retry only once the cause is gone, re-reading BEFORE first.
- **Rollback after a successful apply:** forward-only. The operator never runs a shared DOWN.
  - The merged `0024 down` refuses once any request was ever claimed (dispatch evidence is kept).
  - Even with zero rows, it would be a separate reviewed decision, never part of this packet.
  - Populated kickoff data is never destroyed to roll back.

## Proof

`test/db/e7-0024-sqleditor-apply-wrapper.test.mjs` runs 5 tests on disposable PG 16.15 and PG 17.11:

- **P0:** assembly; continuity with the 0022 / 0023 POST pins; parity with the runner's CATALOG_PINS (with `E7_MAIN_DIR`, also against the runner module itself); this manifest; accepted artifacts untouched.
- **P1:** one atomic apply over schema-23 data (authorized 606998 USD, reserved, captured, confirmed). Then:
  - POST identity, and kickoff catalog parity from the wrapper and from the runner's own probe as the app role;
  - every preservation fingerprint identical, and ZERO kickoff rows;
  - a migrator-built 24 == POST;
  - the second apply is a provable no-op.
- **P2:** refusals with no write:
  - wrong environment, history drift, foreign env row;
  - wrong role (admin, app);
  - a 0024 table / function / intents trigger pre-created;
  - extra function, revoked ACL, extra table, RLS off;
  - run lock, write lock, held migrator lock (55P03);
  - schema 22.
- **P3:** STOP at 24 for an extra function, a widened kickoff ACL and a foreign checksum.
- **P4:** atomic rollback for an injected failure after the tracking row, a tampered POST / kickoff pin and tampered bytes, then a clean apply.

Untested branch: `PREPARED_TRANSACTION_PRESENT` (the harness runs `max_prepared_transactions = 0`; the readback reports the count).
