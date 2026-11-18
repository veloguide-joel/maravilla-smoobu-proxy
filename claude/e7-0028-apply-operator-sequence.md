# E7 C119 S4 — 0028 SQL-editor apply / readback packet (shared TEST, schema 27 → 28)

Reviewable DRAFT packet. **ROOT reviews and owns any actual shared apply.** Claude does not run shared queries or applies. Nothing here has been applied.

0028 (`pipeline_kickoff_source_rebind_s4`) replaces ONE function body: `booking.claim_pipeline_kickoff` binds the S4 ENABLE frame. Only its `expected_source_digest` literal changes, from the C116 frame `880db5b3…` to the merged S4 frame `5294b6b4…`. The signature, owner, ACL, definer, volatility and search_path stay the same. It adds no table, column, function, trigger, policy or grant, and it touches no row.

Applying 0028 enables **nothing**:
- Every hosted runner on main `a86437a8` ships `executeEnabled` / `dispatchEnabled` / `readEnabled` **FALSE**.
- No worker, flag, variable, environment, reviewer, secret or workflow changes.
- There is no provider call, no send, no dispatch and no Stripe action.

Settled model (unchanged): cancellations are manual in Hostaway; refunds are manual in the Stripe dashboard; English only; USD. The recorded C116 external cancellation and its pending refund attestation are fingerprinted with every other row and must be byte-identical afterwards.

## Base references

- Tooling e7-test `bbf12aa22446807df7b63a55e38a464f4be88763` (PR #194 merge, tree `3057af31`). It contains 0028 and the S4 kickoff tooling.
- main `a86437a8738b176f132e1661cabffaa82c2515c2` (PR #195 merge, tree `7c2ebc99`, CLOSED). Its runners must admit 28: the kickoff `CATALOG_PINS`, notification `catalogPin28` and status `catalogPin28` are verified on disposable 28 clusters as the runtime app role.
- PRE-S4 main `5b9c06774757c9b84036fbc91773c3a098835d8f`. Its runners admit 27 (kickoff `CATALOG_PINS`, notification `catalogPin27`) and refuse 28.
- Shared TEST must currently be at **exactly 0001-0027**, the accepted C118 0027 packet's POST state (C116 cancellation recorded). Readback BEFORE proves this; anything else stops.

## Files (sha256 manifest — verify every byte before use)

| file | sha256 |
|---|---|
| `claude/e7-0028-sqleditor-apply-v1.sql` | `10a4dc62eafd5c1682d97240b0ab7011caf28cce428a33c8559e9611bc7f25f9` |
| `claude/e7-0028-readback-v1.sql` | `c0b753aeb4f96079cf28f7bfe481572d75df3df3bd88d4ff4231b2341d420e37` |
| `claude/e7-0028-inventory.sql` | `109904a1f24246fd0413d4490e567954ed2350b508c6c6fecb0689d2df7f9818` |
| `claude/e7-0028-pins-v1.json` | `590bb02635b244fa3d9d42f3186d2e4c483a65eff2cfa2b33a7a8f59a28aff31` |
| `claude/gen-0028-wrapper.py` | `3148f2db1115e13c7e3e4248e8b0eaefc706d699fad1a936873c087d02eac7ec` |
| `claude/derive-0028-pins.mjs` | `a068aac79812f78e91f14c1c03ccdd21601d1d475cf52a633492b4ed4a577a17` |
| `test/db/e7-0028-sqleditor-apply-wrapper.test.mjs` | `cc6f7dcafeaac85fa905299e3dc2828b121fff6d6995661c4b19132c8708ecc7` |
| `db/migrations/0028_pipeline_kickoff_source_rebind_s4.up.sql` | `a72d2ce911cac924b728525f1af43b547c7e908a96bdecbf84f41ca3ebfa3642` |
| `db/migrations/0028_pipeline_kickoff_source_rebind_s4.down.sql` | `c247b17883b23ecdba1eb0ec2a94e5e0e9caa558724ee29c4b0500fb7b77806f` |

The test file's own hash is listed for reference only. Its bytes are covered by the PR head.

## Pins

- Derived on disposable clusters by `claude/derive-0028-pins.mjs` with the accepted migrator and local checkouts of main `5b9c0677` (PRE) and `a86437a8` (POST). PG 16 and PG 17 give identical results except `derivedOnPg`.
- PRE (27) equals the accepted 0027 packet's POST pins on **every** identity key and the history aggregate.
- Only `functions` changes between PRE and POST.
- PRE: functions `137ea3dae9fb20cd8486598cc6ae71a4a619a34df51a096df501cdda07c15e82`, history aggregate `f6f3b20b6be4a603a9fbc6472743dfa9e4d8af62c78156e90c13d34894147980`, claim src md5 `fb103173762c5dc6565338d2a15dd067`.
- POST: functions `f13b2055771bd616cf394d78adcbc4533967ebda2d251c160b43807c76969ae8`, history aggregate `4a503aa579148f81165dc2815592208bcb4b6d1bc0f922fe374f1195ee5e8afc` (aggregate 1..27 unchanged), row 28 up `a72d2ce911cac924b728525f1af43b547c7e908a96bdecbf84f41ca3ebfa3642`, down `c247b17883b23ecdba1eb0ec2a94e5e0e9caa558724ee29c4b0500fb7b77806f`, claim src md5 `98ffe6c804377b46b0d3d8907ac7d284`.
- Kickoff catalog: PRE == main `5b9c0677` `CATALOG_PINS`; POST == main `a86437a8` `CATALOG_PINS`. Only function 0 (`claim_pipeline_kickoff`) `src` differs.
- Notification catalog: PRE == `5b9c0677` `catalogPin27` (`bcc116319adfa7c2e0c2f42d32d48b67fdc53ab35cd4058e777e5de5376c6d16`); POST == `a86437a8` `catalogPin28` == status `catalogPin28` (`96d74ab10cdf7bdd99e125eb6825284e9b57cacec33478fb1a666746e8f91b1b`). Only the `fn` section changes.

## Dependency order

1. ROOT runtime acceptance of the hosted CI evidence for this packet PR.
2. Merge of this packet PR (doc / tooling only; no runtime file) is a separate ROOT decision.
3. Readback BEFORE on shared TEST (read-only).
   - It must equal the PRE pins, and `exclusion` must be all zero / false.
   - `claim` must read: `src_md5` fb103173762c5dc6565338d2a15dd067, `old_literal` 1, `new_literal` 0, and the ACL below.
   - Record `data`, `kickoff_rows` and `kickoff_catalog`. `data` includes `externally_cancelled_latches` and `projection_not_null` as they are now (not assumed zero).
4. Confirm every hosted runner on main is CLOSED and no run is queued or in progress.
5. Apply: paste `claude/e7-0028-sqleditor-apply-v1.sql` as ONE batch in the SQL editor as the schema owner (Joel present).
   - Expect notice `E7_28_APPLIED`.
   - Expect the status line `migrations_max 28, v28 true, claim_src_md5 98ffe6c804377b46b0d3d8907ac7d284`, functions = POST.
6. Readback AFTER:
   - identity == POST pins;
   - `data` byte-identical to step 3;
   - `claim` = `src_md5` 98ffe6c804377b46b0d3d8907ac7d284, `old_literal` 0, `new_literal` 1, same ACL;
   - `kickoff_catalog` == POST.
7. After an **uncertain** issuance (timeout, lost connection) run `claude/e7-0028-readback-v1.sql FIRST` and never re-issue blindly. The wrapper is safe to re-issue only after a readback:
   - at the exact POST state it is a no-op (`E7_28_ALREADY_EXACT_NOOP`);
   - at any other state at or above 28 it stops (`E7_28_POST_STATE_MISMATCH_STOP`).

## Fail-closed PRE checks (the wrapper refuses with nothing written)

- Instance and role:
  - TEST instance (`E7_28_NOT_TEST`);
  - every history row `test` (`E7_28_ENV_MISMATCH`);
  - schema-owner role (`E7_28_NOT_SCHEMA_OWNER`).
- History: exactly 1..27 (`E7_28_HISTORY_NOT_1_TO_27`) with the pinned aggregate (`E7_28_HISTORY_DRIFT`).
- Schema identity:
  - full schema identity (`E7_28_SCHEMA_IDENTITY_DRIFT:<keys>`). A claim body already rebound out-of-band is drift, never adopted.
  - kickoff catalog PRE (`E7_28_KICKOFF_CATALOG_PRE_DRIFT`);
  - claim ACL (`E7_28_CLAIM_ACL_PRE_DRIFT`);
  - the claim body carries the old literal exactly once and the new one never (`E7_28_CLAIM_PRE_LITERAL_DRIFT`).
- Quiescence:
  - hosted-run lock (`E7_28_ACTIVE_RUN_LOCK_HELD`);
  - work / intent leases;
  - leased or in-flight operations;
  - unsettled kickoff requests (`requested` / `claimed` / `dispatch_unknown`);
  - prepared transactions;
  - other sessions' write locks on booking relations;
  - the migrator lock (`lock_timeout` 5 s → 55P03).
- Embedded bytes (`E7_28_UP28_BYTES_MISMATCH`).

## POST checks (same transaction; any failure rolls everything back)

- Full POST identity (`E7_28_POST_SCHEMA_IDENTITY_UNEXPECTED`).
- The claim body == the PRE body with exactly the one literal replaced (`E7_28_CLAIM_BODY_UNEXPECTED`).
- Claim ACL unchanged (`E7_28_CLAIM_ACL_UNEXPECTED`):

  | object | mv_booking_app | mv_booking_admin | mv_booking_report | PUBLIC |
  |---|---|---|---|---|
  | `claim_pipeline_kickoff` EXECUTE | yes | no | no | no |

- Kickoff catalog == merged main (`E7_28_KICKOFF_CATALOG_UNEXPECTED`).
- History:
  - history rows 1..27 unchanged as whole rows (`E7_28_POST_HISTORY_1_TO_27_CHANGED`);
  - exactly one row 28 with the migrator checksums (`E7_28_POST_TRACKING_ROW_UNEXPECTED`).
- Row data:
  - every booking table's count + whole-row fingerprint unchanged (`E7_28_BOOKING_ROWS_CHANGED`). This includes the cancellation, refund attestation, claims, notify operations, receipts, payment attempts, evidence and ledger.
  - intent set (`E7_28_INTENT_SET_CHANGED`);
  - protected / historical fingerprints (`E7_28_PROTECTED_OR_HISTORICAL_CHANGED`);
  - `claim_release_blockers` of every intent (`E7_28_CLAIM_RELEASE_BLOCKERS_CHANGED`);
  - `EXTERNALLY_CANCELLED` latch count and guest-projection count (`E7_28_CANCELLATION_STATE_CHANGED`).

## Runner / frame map

| runner | at 27 (now) | at 28 (after apply) |
|---|---|---|
| main `a86437a8` kickoff / booking-confirmation / status (MERGED S4) | **refuse** (pins are 28) | admit their catalog checks; still CLOSED (all flags false) |
| PRE-S4 main `5b9c0677` and earlier | admit | **refuse** (fail-closed) |
| claim function vs S4 dispatch frame | binds `880db5b3` (C116 frame) → the S4 kickoff refuses at claim | binds `5294b6b4` == `PINNED_PLAN_CONSTANTS.sourceDigest` of the merged tooling |

## Rollback limitations (honest)

- The reviewed 0028 down restores the 0026 claim body (the `880db5b3` literal) and schema 27 exactly. This was verified on a disposable cluster with realistic schema-27 data, including a recorded cancellation; rows were unchanged. It touches no row and is not blocked by the cancellation record.
- The down is a **separately reviewed** owner step. This packet never runs a down.
- After a down, the merged-main runners **refuse** again (their pins are 28) and the PRE-S4 runners admit. Neither enables anything.
- No provider effect is involved in either direction. There is nothing to reverse at Hostaway or Stripe.
- A future frame change needs a new migration plus a new packet; this one is single-use for 27 → 28.
