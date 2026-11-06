# E7 connected-test manifest v2 — M2-A (SCHEMA ONLY)

**Status:** M2-A is a pure schema and hash foundation. `scripts/e7-connected/run-manifest-v2.mjs` validates and hashes a v2 manifest, and that is all it does.

**Nothing consumes v2 yet.** `run-core.mjs`, `run-journal-memory.mjs` and `run-journal-file.mjs` still import and execute **manifest v1 only**. A v2 manifest cannot drive any run, journal, launcher, workflow, transport, worker, migration or abort dispatch.

**v1 is unchanged.** The accepted v1 module (`run-manifest.mjs`, SHA-256 `c47f72eb2b9e898bdaca2ca20ffe7cea0befab006079953133810ce5651f6a56`), its fixtures and its hashes are byte-exact, and the v2 suite pins that hash. No existing v1 journal is rewritten, relabelled or migrated.

## Contract

**Version and hash.**
- Version: `e7-run-manifest-v2`.
- Hash: `sha256("e7-run-manifest-v2\n" + canonical JSON)`, computed over the **same** validated, frozen, descriptor-snapshotted copy.
- It uses the accepted v1 `canonicalJson`, so the key order is sorted and only strings, safe integers, booleans and null are allowed.
- The v1 and v2 hash domains never collide.

**No relabel, upgrade or downgrade.**
- v2 refuses every v1 manifest:
  - a v1 shape lacks `connection` and `testAbortAfterReservation`, so it gets `MANIFEST_SHAPE`;
  - a v2 shape labelled v1 gets `VERSION_UNSUPPORTED`.
- v1 refuses every v2 manifest with `MANIFEST_SHAPE`, or with `VERSION_UNSUPPORTED` for a v1 shape labelled v2.
- No accepted historical run is adopted.

**All v1 safeguards are kept**, with the same codes and precedence:
- strict own-data snapshot, bounded, with no getter, `toJSON` or iterator invoked;
- exact key sets;
- owner inputs that are absent or empty are never defaulted (`MANIFEST_OWNER_INPUT_MISSING`);
- `stripe: "live"` gets `S_LIVE_REFUSED`;
- `synthetic: false` gets `REAL_RUN_NOT_IN_THIS_SLICE`;
- only hostaway `fake` and stripe `mock` are accepted;
- the identity formats;
- the pilot listings 603564 and 603566 are refused;
- USD only;
- real calendar dates, arrival before departure, ≤ 90 nights. Invalid, rolled-over and reversed dates refuse **code-only, never throwing**;
- amount, rate (`MAX_RATE_BPS`), account, label, cleanup and automations formats;
- recording ⇒ capture;
- the paymentMethod rule.

A differential test asserts the same refusal code as v1 for shared-field mutations.

**`listing.connection` is REQUIRED.**
- It is exactly `"disconnected"` or `"airbnb"`.
- There is no default and no inference from the listing id. The same listing id may be declared in either mode.
- An absent value gets `MANIFEST_SHAPE`; any other value gets `CONNECTION_INVALID`.

**`checkpoints` are the EXACT ordered list for the connection:**

| connection | checkpoints |
|---|---|
| disconnected | `CALENDAR_BASELINE, CALENDAR_BLOCKED, CALENDAR_REOPENED` |
| airbnb | `CALENDAR_BASELINE, AIRBNB_BLOCKED, AIRBNB_REOPENED` |

- Cross-mode, union/mixed, missing, extra, reordered, duplicated and boxed lists refuse with `CHECKPOINTS_INVALID` or `MANIFEST_SHAPE`.
- This is a **declaration of required evidence**. It is NOT evidence that blocking or reopening happened.

**`phases.testAbortAfterReservation` is a REQUIRED boolean.**
- `true` requires `capture=false` and `recording=false`; otherwise the result is `TEST_ABORT_PHASE_CONFLICT`.
- `recording && !capture` still gets `PHASE_DEPENDENCY` first, and a non-boolean value also gets `PHASE_DEPENDENCY`.
- `false` stays explicit.
- `true` declares the planned intentional TEST abort only. **M2-A sends, applies and dispatches nothing.**

**The hash binds** `connection`, the checkpoint mode, `testAbortAfterReservation` and every other field (test V3).

**Refusal precedence** is the v1 order, with two codes inserted:
- `CONNECTION_INVALID` after `TIME_ZONE_INVALID`;
- `TEST_ABORT_PHASE_CONFLICT` after `PHASE_DEPENDENCY`.

**The module is pure.**
- It imports only `node:crypto`, the accepted `MAX_RATE_BPS`, `localDateInZone` and the v1 module's exported pure primitives.
- It has no env, DB, fs, network, timers, credentials, workers or event application.
- The snapshot routine is a copy of v1's private one, because v1 must stay byte-exact.

## Required for the next consumer integration (NOT in M2-A)

- **Journal validation and identity** must bind `connection` and the checkpoint mode: the run identity and journal header carry the v2 hash, and every journal checkpoint is checked against the **exact mode-specific order**.
- **Trusted-head and hash-chain checks** must be retained.
- **Forbidden:** widening v1 `CHECKPOINTS` to a union, or accepting either mode's names in either mode.
- **No journal migration or relabel:** v1 journals stay v1.
- **Abort execution** (`testAbortAfterReservation`) needs its own reviewed consumer slice and dispatch package.

## Validation (M2-A, offline)

- `test/e7-connected-run-manifest-v2.test.mjs` (V1–V9) and the existing v1 suite `test/e7-connected-run-manifest.test.mjs`.
- No DB, network, provider, hosted or runtime proof is claimed.
