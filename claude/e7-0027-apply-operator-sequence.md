# E7 C118 — 0027 SQL-editor apply / readback / reconciliation packet (shared DEV TEST, schema 26 → 27)

Reviewable DRAFT packet. **ROOT reviews and owns any actual shared apply.** Claude does not run shared queries or applies. Nothing here has been applied, and nothing here records a cancellation.

Applying 0027 enables **nothing**:
- Every hosted runner on main `92c1b674` ships `executeEnabled` / `dispatchEnabled` **FALSE**. No worker, flag, variable, workflow or route changes.
- 0027 adds two append-only tables (`external_cancellations`, `external_refund_attestations`), the admin-only recording functions, the runtime guest projection `external_cancellation_public`, three fence triggers (claims, operations, intents) and one extra branch in `claim_release_blockers` that is reachable **only** once a cancellation record exists. With no record, every existing booking behaves exactly as before; the wrapper proves it (blockers, latches, projection, rows).
- No column is added to a pre-existing table.

Settled model (unchanged): cancellations are manual in Hostaway; refunds are manual in the Stripe dashboard; English only. This packet makes **no** disposition, evidence or refund write. Protected reservations, historical intents and every existing row are untouched; the packet fingerprints them, sanitized.

## Base references

- Tooling e7-test `22ba3e463bc5a77ff2e491f2394a762a93a3da0d` (PR #188 merge, tree `e42a3901`). It contains 0027.
- main `92c1b6748a719654bf324063242afd3c07ccb9d3` (tree `601fb091`, CLOSED). Its kickoff runner `CATALOG_PINS` must still be satisfied at 27 (verified). Its notification runner `catalogPin26` (`47b1d904…`) will **not** be satisfied at 27 (see Runner map).
- Shared DEV must currently be at **exactly 0001-0026**, the accepted C116 0025 + 0026 packet's POST state. Readback BEFORE proves this; anything else stops.

## Files (sha256 manifest — verify every byte before use)

| file | sha256 |
|---|---|
| `claude/e7-0027-sqleditor-apply-v1.sql` | `b1b842d24647fea9df419af32c27df44f2910d23272e05bfd383f52174de1ef2` |
| `claude/e7-0027-readback-v1.sql` | `27abbe2d2bc652634d2eaf5dc1ba8963c26e2e39b399da1aa542a8b81d2f3021` |
| `claude/e7-0027-inventory.sql` | `78d96c770205776f16a1bf38bbdee17ebeab639ce07223914b646fea03f50b2c` |
| `claude/e7-0027-pins-v1.json` | `430b98313a7ee25837bf757241629983d9e8d0fe03d6a9710e0a7c46af1c71c7` |
| `claude/gen-0027-wrapper.py` | `4ce8c4747c82627d72b13a1f484b750ca2bec9102ab6c36f7595c80a60ec5cfb` |
| `claude/derive-0027-pins.mjs` | `5b4bb2414c159ee9f4356605bf33592b0da86f865e3cd056493213987363dbe5` |
| `test/db/e7-0027-sqleditor-apply-wrapper.test.mjs` | `a28213b049ab2a6e8e74c516f3eb34ce219af87b0863ef0b2522117181e444c1` |
| `db/migrations/0027_external_cancellation_disposition.up.sql` | `ae949bf42450cf1af2632212f2cc2c2704b66ca314f4fc4f2744e6130f9c8ecf` |
| `db/migrations/0027_external_cancellation_disposition.down.sql` | `8e3810678bc788df6915a4be9c728296a89f0b040ae0df245ceef7583fc6ba6c` |

The test file's own hash is listed for reference only. Its bytes are covered by the PR head.

## Pins

- Derived on disposable clusters by `claude/derive-0027-pins.mjs` with the accepted migrator and a local checkout of main `92c1b674`. PG 16.15 and PG 17.11 give identical results except `derivedOnPg`.
- PRE (26) equals the accepted 0025 + 0026 packet's POST pins on every identity key; `acls` / `objects` additionally list the 0027 functions / objects (absent at PRE).
- PRE: functions `bf0085e31e7cd75feefd20ea930bb4220d895c2a1135bd587e94ca9ad502d3b5`, history aggregate `3dae7c0df75f4f51c4acdec3d79af4bb35050ee1d49c23c47e36b05f3d469ab1`.
- POST: functions `137ea3dae9fb20cd8486598cc6ae71a4a619a34df51a096df501cdda07c15e82`, history aggregate `f6f3b20b6be4a603a9fbc6472743dfa9e4d8af62c78156e90c13d34894147980`, row 27 up `ae949bf42450cf1af2632212f2cc2c2704b66ca314f4fc4f2744e6130f9c8ecf`, down `8e3810678bc788df6915a4be9c728296a89f0b040ae0df245ceef7583fc6ba6c`.
- Kickoff catalog PRE == POST == main `CATALOG_PINS` (0027 does not touch it).
- Notification catalog PRE == main `catalogPin26`; POST = `bcc116319adfa7c2e0c2f42d32d48b67fdc53ab35cd4058e777e5de5376c6d16` (sections `col con fn pol rel trg` change).

## Dependency order

1. ROOT runtime acceptance of the hosted CI evidence for this packet PR.
2. Merge of this packet PR (doc / tooling only; no runtime file) — a separate ROOT decision.
3. Readback BEFORE on shared DEV (read-only): must equal the PRE pins, `exclusion` all zero / false, `x27` all null except `externally_cancelled_latches` = 0. Record `data` and `kickoff_catalog`.
4. Confirm every hosted runner on main is CLOSED and no run is queued or in progress.
5. Apply: paste `claude/e7-0027-sqleditor-apply-v1.sql` as ONE batch in the SQL editor as the schema owner (Joel present). Expect notice `E7_27_APPLIED` and the status line `migrations_max 27, v27 true, 0 / 0 / 0`.
6. Readback AFTER: identity == POST pins; `data` byte-identical to step 3; `x27` = 0 / 0 / 0 / 0 with the ACL matrix below; `kickoff_catalog` unchanged.
7. Only afterwards, as a **SEPARATE reviewed step**: the single C116 record (below).
8. Any notification-runner repin is a later, separate reviewed change, only if a future send is needed. Not part of this packet.

## Fail-closed PRE checks (the wrapper refuses with nothing written)

TEST instance (`E7_27_NOT_TEST`), every history row `test` (`E7_27_ENV_MISMATCH`), schema-owner role (`E7_27_NOT_SCHEMA_OWNER`), history exactly 1..26 (`E7_27_HISTORY_NOT_1_TO_26`) with the pinned aggregate (`E7_27_HISTORY_DRIFT`), full schema identity (`E7_27_SCHEMA_IDENTITY_DRIFT:<keys>`), kickoff catalog (`E7_27_KICKOFF_CATALOG_PRE_DRIFT`), quiescence: hosted-run lock (`E7_27_ACTIVE_RUN_LOCK_HELD`), work / intent leases, leased or in-flight operations, unsettled kickoff requests (`requested` / `claimed` / `dispatch_unknown`), prepared transactions, other sessions' write locks on booking relations; the migrator lock (`lock_timeout` 5 s → 55P03); embedded bytes (`E7_27_UP27_BYTES_MISMATCH`).

## POST checks (same transaction; any failure rolls everything back)

Full POST identity; kickoff catalog unchanged; ACL / RLS matrix exactly:

| object | mv_booking_app | mv_booking_admin | mv_booking_report | PUBLIC |
|---|---|---|---|---|
| `admin_record_external_cancellation` EXECUTE | no | yes | no | no |
| `admin_attest_external_refund` EXECUTE | no | yes | no | no |
| `external_cancellation_public` EXECUTE | yes | no | no | no |
| both new tables SELECT / INSERT / UPDATE / DELETE | none | SELECT only | SELECT only | — |

RLS on both new tables. History rows 1..26 unchanged; exactly one row 27 with the migrator checksums; every pre-existing booking table's count + whole-row fingerprint unchanged; both new tables empty; intent set, protected / historical fingerprints unchanged; `claim_release_blockers` output of every intent unchanged; zero `EXTERNALLY_CANCELLED` latches; `external_cancellation_public` null for every intent.

## Runner / frame map (main 92c1b674, all CLOSED)

| runner | binds the schema by | effect of 0027 |
|---|---|---|
| booking-confirmation (gn-v2 send) | whole-schema `catalogPin26` | **refuses** on 27 (fail-closed) until a separately reviewed repin; no send is possible meanwhile |
| notify-inspect (read-only) | schemas 21 / 22 / 23 only | already refuses 24+; unchanged |
| kickoff | named 0024 functions / ACLs / triggers | **unchanged**: verified on disposable 27 clusters (PG16 + PG17) with its own probe as the runtime app role |
| pipeline / reservation / capture / recording / cleanup runners, probes | pinned tooling commits, no catalog pin | identical for every booking without a record; for an externally cancelled booking the new triggers refuse new provider-write / notify operations, new claims and TEST-cleanup entry |
| source frames / digests | — | unaffected: 0027 changes no runtime source file on main |

## Rollback limitations (honest)

- While **no** cancellation record exists: the reviewed 0027 down restores schema 26 exactly (`claim_release_blockers` definition byte-identical; objects dropped). Run only by a separately reviewed step.
- Once **any** record exists: the down is **refused** by design; a released claim is not re-taken; attestations are append-only. Corrections are forward-only.
- The notification runner stays refused on 27; restoring its pin needs either the down (only with no record) or a reviewed repin.

## The later single C116 record — a SEPARATE reviewed step (placeholders only; ROOT holds the private bindings)

Not part of this packet; described so ROOT can review the plan. Target: the C116 replacement booking that was cancelled by host in Hostaway (2026-11-17 22:21:51Z). The first C116 attempt has no reservation and is **not** recorded.

1. Fresh read-only checks: intent `<C116_INTENT_ID>` is `confirmed` at `<EXPECTED_VERSION>`; no lease; its confirmation operation is `succeeded` (sent); its claim is active; no open case.
2. A new dashboard read of reservation `<C116_RESERVATION_ID>` (still cancelled) → ONE owner-attested `hostaway_reservation` evidence row via `admin_record_evidence` with status `cancelled` and `observed_at` = that read's time (so it is the latest evidence for that reservation) → `<EVIDENCE_ID>`.
3. ONE call `admin_record_external_cancellation('<C116_INTENT_ID>', <EXPECTED_VERSION>, ARRAY['<EVIDENCE_ID>'], '<EVIDENCE_ID>', 'pending', NULL, NULL, 'owner', '<SHORT_REF>', 'OWNER_CANCELLED_IN_HOSTAWAY', '<FRESH_KEY_MAX_116>')`. Refund status **'pending'**: no Stripe refund has been issued; the refund stays manual in the dashboard.
4. Expected result: `notify` = `[sent_preserved]`, no latch written; `releasedClaimId` = that intent's own claim only.
5. Post-checks: only its own claim released (every other active claim identical); intent row, operations, render, typed receipt, ledger (captured USD 140.00) and transitions identical; one cancellation row + one refund row (`pending`); no provider call.
6. Any refusal writes nothing: read back, re-plan, never retry blindly.
