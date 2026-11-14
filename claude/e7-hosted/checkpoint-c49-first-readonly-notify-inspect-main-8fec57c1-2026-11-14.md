# Checkpoint C49 — first hosted READ-ONLY notification admission inspection: INSPECTED, class OUT_OF_V1_SCOPE (main 8fec57c1, run 43622207310)

**Status: CLOSED — ONE read-only inspection, one transaction, ROLLBACK.** No send, write, claim, latch, recover or release, no provider call and no inbox action.

**What it proves:** how the reviewed 0016 classification, read by the **runtime app role**, sees ONE bound TEST `guest.notify` operation on the shared DEV TEST database at schema 21. It is **not** delivery readiness, **not** a current provider or payment status, and **not** a DB-wide fingerprint.

**Attribution:** every run, job, timestamp and result fact below is a ROOT observation (`[ROOT-obs 2026-11-14 UTC]`, durable hosted readback review `5906127986`). Claude made no credential, provider, shared-DB, run, dispatch, merge, send or operational write action for this checkpoint.

---

## 1. Source and review provenance (C47 / C48 technical acceptance)
| item | value | source |
|---|---|---|
| Implementation | #116 (C47 Slice 6-P runner + C48 amendment), exact reviewed head `778c85089eed744adad66bb9f66d315b1fbb3406` | — |
| C48 amendment | F1: PostgreSQL 17 owner-default MAINTAIN canonicalisation in the catalog `rel` section. F2: wrapper-bounded `pool.connect` 10 s / `pool.end` 5 s / ROLLBACK 2 s | ROOT review `5906054280` (HOLD on `50a40a2d`) → amended |
| Final GO + merge | main **`8fec57c1682e81c99cf06beb95b5e6df87b16e95`** (tree `2fb1a68a02efb8c80c56ec32029e0a0f0c88cf32`) | ROOT final GO `5906113291` |
| Independent test run | ROOT, Node 22 / PostgreSQL 17: 20/20, zero skips | ROOT final GO `5906113291` |
| Immutable tooling | e7-test `d322d2192b377d18b6a9280ae06c17eddfe3e73e` | — |
| Source digest (frame `e7-hosted-notify-inspect-v1`) | `e822a4d61810a9366fe949339a212d85c1849aa1007a5efa0aa3e5d7887060a3` | — |
| Closure digest | `a703b0130f93a18fc86336d4904f1908d3146665d41cff1d4eabbd7a90da12e0` | — |
| Catalog identities (PG16 = PG17) | 21 `b214be27…4d50`, 22 `42da3bd5…8bac`, 23 `84b3e96f…49d6`; read path `b65eddc1…ea42` | — |

## 2. Bound inputs (non-secret; TEST identifiers)
- `approval_ref` = `ROOT-C49-READONLY-NOTIFY-20261114`
- intent `abede8b1-8ef6-44f2-876e-6a02fc056a96`, operation `1f6a1409-d568-4e67-b689-1a44e1327293`, expected version `9`
- Plan hash (independent and hosted, equal): `857cc282be675e60269a977073af4ac3e7dceb914ae96027828afa8b291723f9`

## 3. Runs (ROOT-obs)
| run / job | fact | timestamp (UTC) |
|---|---|---|
| no-secret REAL preflight run `43622104355`, job `132529843919` — **SUCCESS** | tests 17/17 | — |
| | plan **MATCH** | 2026-11-14T17:37:30.4688145Z |
| | source **MATCH** | 2026-11-14T17:37:30.4931466Z |
| | inspect job skipped (preflight dispatch) | — |
| **ONE inspect dispatch** run `43622207310`, attempt **1** (same SHA, same inputs) | preflight job `132530169731`: 17/17, **MATCH** | 2026-11-14T17:38:45Z |
| environment gate `e7-readonly-probe` | approved normally by ROOT under Joel's standing authority; no bypass, no settings change | ~2026-11-14T17:39Z |
| inspect job `132530242418` — **SUCCESS** | bindings re-check | 2026-11-14T17:39:44.8815279Z |
| | `VERIFY_OK` | 2026-11-14T17:39:44.9210596Z |
| | `INSPECT_DONE` | 2026-11-14T17:39:46.9719652Z |

## 4. Result (sanitized allowlisted fields only; the exact JSON is in ROOT review `5906127986`)
| field | value |
|---|---|
| core | **`INSPECTED`** / stage `done`, **11 statements**, catalog schema **21**, cleanup `POOL_ENDED` |
| transaction | REPEATABLE READ READ ONLY, then ROLLBACK |
| intent | state `confirmed`, version 9, listing 606998, USD, hasReservation `true` |
| operation | `pending`, attempts 0, sourceVersionMatchesIntent `true`, dispatched `false`, leased `false`, completed `false`, hasResultRef `false`, errorCode `null`, template `booking_confirmed` |
| **notifyClass** | **`OUT_OF_V1_SCOPE`**; eligibleBy0016Class `false` |
| render / latch / latchCode | `null` / `null` / `null` |
| refusalDetail | `UNAVAILABLE_TO_RUNTIME_ROLE` (the refusal detail function is owner-only in 0016; not re-derived) |
| receipts | `UNAVAILABLE_AT_SCHEMA_21` |

## 5. Reconciliation
- The plan hash, source digest and closure digest at preflight, verify and inspect all equal the independently derived values in §1–§2.
- The catalog identity resolved to exactly the reviewed schema **21**, consistent with the shared DEV history (1..21).
- The queued real-address row is reported **truthfully as not eligible** (`OUT_OF_V1_SCOPE`) under the unchanged `.invalid` recipient scope. It stays pending and untouched, with no render and no latch.
- Exactly one inspect dispatch, attempt 1; no rerun.

## 6. Limitations (stated, not inferred)
- **Class and runtime-role access only.** This is the reviewed 0016 classification as the runtime role reads it. It is not delivery readiness, not a sending-domain or recipient decision, not a current Stripe or Hostaway status, and not a DB-wide fingerprint.
- The detailed refusal code is owner-only, so it is reported as unavailable rather than inferred.
- Receipts do not exist at schema 21; 0022 / 0023 are not applied.

## 7. State unchanged
- The five booking runner flags remain **FALSE**; the five runner digests and both probe digests (charge-list `43715872…9cf3`, Resend sink `10c988a3…5464`) are unchanged.
- **Shared DEV 0022 / 0023 NOT APPLIED**; still exactly 1..21. The two expired connector confirmations remain a separate issuance blocker (durable checkpoint `5905950453`).
- Both protected TEST objects are preserved. The queued notify row and the inbox are untouched. Refunds remain **manual** and policy-assessed.

## 8. Current concrete next milestone
Resolve the separate 0022 / 0023 issuance blocker first (ROOT). Real-recipient scope and the sending domain stay separately gated decisions. This checkpoint authorizes no new live action.
