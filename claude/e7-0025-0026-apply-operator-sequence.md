# E7 C116 — 0025 + 0026 SQL-editor apply packet (shared DEV TEST, schema 24 → 26)

Reviewable packet. **ROOT reviews and owns any actual shared apply.** Claude does not run shared queries or applies. Nothing here has been applied.

Applying 0025 + 0026 enables **no** send, **no** dispatch and **no** booking flow:
- Every hosted runner on main `adacbdad` ships `executeEnabled` / `dispatchEnabled` **FALSE**. No worker, flag, variable, workflow or route changes.
- 0025 replaces `booking.gn_recipient_in_scope(text)` in place: the `.invalid` scope OR exactly `delivered@resend.dev` (Resend's delivery-simulation address). Being in scope is not a send permission, and provider acceptance at the sink is not inbox delivery.
- 0026 replaces `booking.claim_pipeline_kickoff(uuid,text,text,jsonb)` in place. Only the `expected_source_digest` literal changes, from `f09bcbbd…` to `880db5b3…` (the C116 pipeline ENABLE frame). Every other condition, the closure literal, owner and ACL are unchanged.
- Neither migration adds or drops a table or column.

Refunds stay manual. Protected reservations, historical intents and every existing row (including kickoff requests, notification ops, receipts and journals) are untouched; the packet fingerprints them, sanitized.

## Base references (final merges)

- Tooling e7-test `66133a22edca925e6386c4d178c251fa5f11c82e` (#180 merge, tree `ade3e084`). It contains 0025 (#178 merge `9b7a96bf`) and 0026.
- main `adacbdad5aad0f28c7d1ce4e6ac10a0abe657eb1` (#179 merge, tree `601fb091`). Its kickoff runner `CATALOG_PINS` (claim src `fb103173`) and notification runner `catalogPin26` (`47b1d904…`) are exactly what the POST state must satisfy.
- Shared DEV must currently be at **exactly 0001-0024**, the accepted C112a 0024 packet's POST state. Readback BEFORE proves this; anything else stops.

## Files (sha256 manifest — verify every byte before use)

| file | sha256 |
|---|---|
| `claude/e7-0025-0026-sqleditor-apply-v1.sql` | `0bb6a67dba8a8ffe863d07284ad500c9ed8fed15899cf6d87423d2be6e111678` |
| `claude/e7-0025-0026-readback-v1.sql` | `a7143aeff9d36f7e95434907973eeb9cf0932010610573a032d14d225885024e` |
| `claude/e7-0025-0026-inventory.sql` | `b911b4d543dcf180136b3da791a69c16154e137bd0fe40c6589f4a65402d91ed` |
| `claude/e7-0025-0026-pins-v1.json` | `4bb261b2f21f9a4d4429dd58e7a5a8ab1c468abe62c9bef20bede4be38926463` |
| `claude/gen-0025-0026-wrapper.py` | `dbadb6d7191c60dd4647f53584544b9362bcdd569d46d2328b883781f8ba041d` |
| `claude/derive-0025-0026-pins.mjs` | `cb6a0bb7ba3252624cbea7b8fcb9f0ca5dd0be3ad3f4b1001145bceecff0b3d1` |
| `test/db/e7-0025-0026-sqleditor-apply-wrapper.test.mjs` | `6ca48d2416b67b1e7285179917a393c0d32a1aad45802d02f9a1b9b2ca8828ac` |
| `db/migrations/0025_gn_sink_recipient_scope.up.sql` | `160127cf57c65a7d370515c3a5a48384fa4061b03358d3c2ec5d8c72ca4612c3` |
| `db/migrations/0025_gn_sink_recipient_scope.down.sql` | `16b392c60b53a95bca5fba39219fe86991eaa498ae0fab10ebdefd7914cfde6f` |
| `db/migrations/0026_pipeline_kickoff_source_rebind.up.sql` | `4ad443e635b716a73bd22bd99c3e04cd5781d8a8aeef4fb2fa596e380fc58528` |
| `db/migrations/0026_pipeline_kickoff_source_rebind.down.sql` | `5d3f5219fb561d242c6119794d0cb43883e38da07c89945325bfa724f980ece0` |

The test file's own hash is listed for reference only. Its bytes are covered by the PR head.

## Pins

- Derived on disposable clusters by `claude/derive-0025-0026-pins.mjs` with the accepted migrator and a local checkout of main `adacbdad`. PG 16.15 and PG 17.11 give identical results except `derivedOnPg`.
- PRE (24) equals the accepted 0024 packet's POST pins on every identity key. `acls` additionally lists `gn_recipient_in_scope`.
- History aggregate 0001-0024: `bcd453f800c037e978138d5d6bf979baaa00b46cbe807fb7aca8281a9cacc7f2`, the shared-DEV exact post-24 state.
- Functions sha:
  - PRE `8e73bb25c38f0a6e32566483c9a6cf57a6faa9f5feebdee34ec381564265304d`
  - MID `706baa77108525f0e150a586189f76420321fe73f261b4468a3d55085b5c2a70`
  - POST `bf0085e31e7cd75feefd20ea930bb4220d895c2a1135bd587e94ca9ad502d3b5`
- Aggregates: MID 0001-0025 `1708843710edab29a5e7bb5d2afd6d444c9fcbe1b3ca74c22b4978d416c36706`; POST 0001-0026 `3dae7c0df75f4f51c4acdec3d79af4bb35050ee1d49c23c47e36b05f3d469ab1`.
- Catalog delta: function bodies only. Every other identity key is identical PRE = MID = POST; no table, column, trigger, policy, index or table ACL changes.
- Kickoff catalog: PRE equals the 0024 packet's pins (claim src `ede022a8`). POST equals main `CATALOG_PINS` (claim src `fb103173`). Only the claim entry differs.
- Notification catalog at POST, as the runtime app role, equals main `catalogPin26` `47b1d904a25cde0f4f9f85b8554b93cd914364d70ef1091cb273ce68043379da`.

## Immutable source

Take the packet ONLY from the merged commit, never from a branch tip or a local edit:

`git show <MERGED_COMMIT>:claude/e7-0025-0026-sqleditor-apply-v1.sql | sha256sum`

Do the same for the readback, or use the raw GitHub URL pinned to that commit SHA. Hashes must equal the manifest. Paste the whole file into ONE SQL-editor run: schema owner `postgres`, TEST project only.

## Operator sequence

1. **Readback BEFORE** (pure SELECT): run `claude/e7-0025-0026-readback-v1.sql`. Continue only if:
   - `identity` equals `pre` in the pins (all keys);
   - `migrations.max = 24` and `aggregate = bcd453f800c037e978138d5d6bf979baaa00b46cbe807fb7aca8281a9cacc7f2`;
   - `instance.environment = test`;
   - every `exclusion` count is 0 / false;
   - `kickoff_catalog` == `pins.kickoffCatalogPre`;
   - `claim_literal = original`;
   - `sink_scope = {sink: false, lookalike: false, invalid_scope: true}`.

   Keep the whole `data` object (counts and hashes only, TEST ids only, no guest contact, no secret) and `kickoff_rows`.
2. **Apply**: run `claude/e7-0025-0026-sqleditor-apply-v1.sql` once. It is one atomic statement (SET LOCAL 180 s / lock 5 s). Success means:
   - notice `E7_2526_APPLIED`;
   - status `migrations_max 26, v25 true, v26 true, claim_literal rebound, sink_scope {sink: true, lookalike: false, invalid_scope: true}`;
   - `kickoff_rows` equal to BEFORE;
   - `functions_sha256 = bf0085e31e7cd75feefd20ea930bb4220d895c2a1135bd587e94ca9ad502d3b5`.
3. **Readback AFTER**:
   - `identity` == `post`;
   - `data` byte-identical to BEFORE: every booking table count + whole-row fingerprint (kickoff requests, notification ops / renders / receipts, intents, all journals), the intent id set, whole 0001-0024 history rows, and the protected-reservation / historical-intent fingerprints;
   - `kickoff_rows` unchanged;
   - `kickoff_catalog` == `pins.kickoffCatalogPins`;
   - `claim_literal = rebound`, `sink_scope.sink = true`;
   - the `v25` / `v26` rows carry exactly the manifest's up / down checksums.
4. **Report**: post BEFORE / AFTER as hashes only, into the C116 checkpoint. The hosted notification and kickoff runners then admit DEV by their exact catalog pins. Their execute flags are still FALSE: any send or dispatch test is a separate, reviewed step.

## Refusals, rollback and uncertain issuance

Every `E7_2526_*` exception rolls the whole statement back: schema, data and history unchanged. Re-run the readback to confirm before deciding anything.

- **Uncertain issuance** (lost reply, editor closed, timeout): read the actual state with the readback FIRST. Never re-issue blindly.
  - If it shows the exact POST state, the apply landed. A re-issue would only raise `E7_2526_ALREADY_EXACT_NOOP` and write nothing.
  - If it shows the exact PRE state, nothing landed.
  - Anything else → **STOP** for review.
- **STOP, no repair, no down, no adoption:**
  - `E7_2526_POST_STATE_MISMATCH_STOP:*` (a 0025-only database, partial state, foreign checksum, function / ACL / kickoff-catalog drift at 26);
  - `E7_2526_HISTORY_*`, `E7_2526_ENV_MISMATCH`, `E7_2526_NOT_TEST`;
  - `E7_2526_SCHEMA_IDENTITY_DRIFT:*` (incl. a pre-applied 0025 / 0026 body at recorded 24), `E7_2526_KICKOFF_CATALOG_PRE_DRIFT`;
  - `E7_2526_NOT_SCHEMA_OWNER`.

  A path forward needs a separately reviewed deliberate intermediate readback.
- **Quiescence refusals changed nothing:** `ACTIVE_RUN_LOCK_HELD`, `ACTIVE_WORK_LEASE`, `ACTIVE_INTENT_LEASE`, `OPERATION_LEASED_OR_IN_FLIGHT`, `PREPARED_TRANSACTION_PRESENT`, `BOOKING_WRITE_LOCK_HELD`, `55P03`, `57014`.
- **Rollback after a successful apply:** forward-only. The operator never runs a shared DOWN.
  - The merged downs restore the exact 0016 / 0024 bodies.
  - Any reversal would be a separate reviewed decision, never part of this packet.

## Proof

`test/db/e7-0025-0026-sqleditor-apply-wrapper.test.mjs` runs 5 tests on disposable PG 16.15 and PG 17.11 (with `E7_MAIN_DIR` = a main `adacbdad` checkout):

- **P0:** assembly; continuity with the 0024 POST pins; kickoff / notification catalog parity with the main runner modules themselves; this manifest; accepted artifacts and merged migrations untouched vs `66133a22`.
- **P1:** one atomic apply over schema-24 data (authorized 606998 USD with its kickoff request row, reserved, captured, confirmed). Then:
  - MID / POST identity, and kickoff and notification catalog parity from the runners' own probes as the app role;
  - claim literal rebound, sink in scope;
  - every preservation fingerprint identical;
  - a migrator-built 26 == POST;
  - the second apply is a provable no-op.
- **P2:** refusals with no write:
  - wrong environment, history drift (10, 24), foreign env row;
  - wrong role (admin, app);
  - a pre-applied 0025 body, extra function, revoked claim ACL, extra table, RLS off;
  - run lock, write lock, held migrator lock (55P03);
  - schema 23.
- **P3:** STOP for a 0025-only database. At 26: STOP for an extra function, a widened claim ACL and a foreign checksum.
- **P4:** atomic rollback for an injected failure after both tracking rows, a tampered MID / POST / kickoff pin and tampered 0025 / 0026 bytes, then a clean apply.

Untested branch: `PREPARED_TRANSACTION_PRESENT` (the harness runs `max_prepared_transactions = 0`; the readback reports the count).
