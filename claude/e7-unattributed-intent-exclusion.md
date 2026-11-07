# E7: fourth (unattributed) intent exclusion. Contract / delta (LOCAL; root ruling c251896e C)

**Base and scope.** Base: e7-test `209328763470e137c8128c222cc0850ad62bc117`, on the isolated branch `feature/e7-unattributed-intent-exclusion`. Not pushed.

## Fact (root live evidence, 2026-11-07)

The shared DEV TEST DB holds a FOURTH, pre-existing intent:

| field | value |
|---|---|
| id | `9f42214b-99f4-413a-9f43-d340faeedfd3` |
| ref | `MV-K2CSGCBB` |
| listing / stay | 606998, 2026-11-14 → 20 |
| state | `price_confirmed` v1 |
| created | 2026-11-06T18:16:48.955Z |
| quote expired | 18:46:48.955Z |
| checkout session / payment intent / Hostaway reservation | NULL / NULL / NULL; captured 0 |
| related rows | no payment attempts, ops, claims or ledger rows |

**Its actor / provenance is NOT established.** It is **not a run**; it is not "Run4" and is never adopted, paid, reopened or deleted. No session, PI or reservation is inferred.

## Delta (runtime: exactly two files)

1. **`scripts/e7-connected/run-plan-v1.mjs`**
   - `HISTORICAL_EXCLUSIONS` gains ONE explicit non-run key:
     `unattributedIntents: [{ label: "priced-only-2026-11-06T18:16:48Z", intentId: "9f42214b-…", paymentIntentId: null, reservationId: null }]`
   - Unchanged: `runs` (run1 / run2 / run3), `otherPaymentIntentIds` and `protectedReservationIds`.
   - The exact-equality check (`EXCLUSIONS_NOT_EXACT`) is unchanged, so a plan carrying the stale 3-run list, or any altered fourth record, is refused. There is no optional / fallback shape.
   - `BINDING_EXCLUDED` also refuses a binding whose intent id or PI id equals a non-null id of an `unattributedIntents` entry.
2. **`scripts/e7-connected/run-preflight-r1.mjs` `exclusionIdentifiers`**
   - The non-run entries are folded into the `intentIds` / `paymentIntentIds` / `reservationIds` sets, with nulls filtered exactly as for runs.
   - Every exclusion-baseline family keyed on `intent_id = ANY(I)` therefore fingerprints the fourth intent's rows. It is reported `ABSENT` explicitly when there is no row.

**Not changed:**
- workers, guard, bridge, journal, transports, launcher, schema, phases, migrations, access control;
- snapshot / getter / proxy handling;
- refusal precedence;
- source / package binding.

**Source lists / import graph:** unchanged (`RUN_PLAN_CLOSURE` 50, `R1_EXECUTOR_CLOSURE` 30, `NATIVE_EXEC_SOURCES` 56).

**Digests.** Both changed files are in BOTH pure closures, so the foundation, G1 and native digests all change.
- The new values are recomputed and recorded; the previous ones (`cdb00be0…`, `897d369f…`, `91c6b41c…`) become historical.
- No module embeds its own digest.
- No existing package may be reused; none exists, and none is fresh.
