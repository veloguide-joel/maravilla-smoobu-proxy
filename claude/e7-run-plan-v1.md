# E7 M2-F — plan-only run package for ONE future reservation → TEST abort → host-cancel + authorization-void (OFFLINE, LOCAL, inert)

Contract for `scripts/e7-connected/run-plan-v1.mjs` (pure) and `scripts/e7-connected/run-plan-command.mjs` (inspect only). Written under root review 48d9e328, with corrections 1–6.

**What a package is and is not.**
- A package is SCOPE BINDING. It is never provider evidence, readiness, authorization or cleanup permission.
- Every output carries `executable: false` and all-false `permissions`.
- `execute` is NOT implemented, and is refused before any dependency is touched.
- There is no process entrypoint, no credential access, and no DB, provider, filesystem-write, network or timer access.

## 1. Hash domains (exact byte framing; SHA-256; hex output)

| domain | bytes hashed |
|---|---|
| plan | `UTF8("e7-run-plan-v1\n") ‖ UTF8(canonicalJson(validatedPlan))` |
| source | `UTF8("e7-run-plan-source-v1\n")`, then for each closure entry in pinned order: `UTF8(path) ‖ 0x00 ‖ UTF8(decimal byteLength) ‖ 0x00 ‖ bytes ‖ 0x00` (the accepted probe-digest framing under a NEW prefix) |
| package | `UTF8("e7-run-package-v1\n") ‖ UTF8(canonicalJson(packageBody))` |

- `canonicalJson` is the accepted `run-manifest.mjs` function: sorted keys; strings, safe integers, booleans, null; arrays in order.
- Independent fixed vectors (including embedded NUL source bytes and lengths) are in the unit test.
- No expected digest is a constant in any source file, so nothing hashes itself circularly.
- The package hash binds every validated scope and status field. No secret field exists in any schema.

## 2. Source closure — a REVIEWED FOUNDATION closure, not a future executor's code

`RUN_PLAN_CLOSURE` is an explicit, sorted path list:
- the transitive relative-import closure of the accepted foundation roots: `run-core-abort-v2`, `run-journal-file-v2`, `http-transports`, `real-exchange`, `probe-credential-file`, `probe-env-preflight`, `probe-source-digest`;
- the planner and the command themselves;
- `package.json` and `package-lock.json`.

None of these modules reads a runtime data file.

**How the snapshot is checked.**
- The test re-scans the imports on disk and requires the exact same set.
- The command asks the injected `readSourceFiles` for exactly these paths and refuses any missing, extra, duplicate, reordered, empty or oversized entry.
- Caps: per file ≤ 262 144 bytes (the accepted `ownedBytes`); total ≤ 4 MiB.

**What the source bytes are and are not.**
- They are a CALLER SNAPSHOT, not proof of Git origin.
- `baseline.repoCommit` is a DECLARED pin until a future trusted reader verifies it.
- `baseline.sourceDigest` must equal the digest recomputed from the supplied bytes.
- A future real executor (not written) MUST force a new reviewed closure and digest. Unseen future code is NOT bound by this package.

## 3. Pure import boundary

**The planner imports only pure accepted modules:**
- `run-manifest.mjs` (`canonicalJson`, `isRealDate`, `MAX_AMOUNT_MINOR`, `MAX_GUESTS`);
- `run-manifest-v2.mjs` (`CHECKPOINTS_BY_CONNECTION`);
- `lib/checkout/compensation-proof.js` (`localDateInZone`);
- `probe-env-preflight.mjs` (`evaluateProbeEnvironment`);
- `probe-source-digest.mjs` (`ownedBytes`);
- `node:crypto` and `node:util`.

This graph's only externals are `node:crypto` / `node:util`, and it contains no process / fs / net / timer / pg token (asserted).

**Constants that live in DB or worker modules are COPIED, not imported:**
- `TEST_ABORT_LISTINGS` (606998 / USD; origin `lib/booking-db/test-abort.js`);
- `PROTECTED_HOSTAWAY_RESERVATION_IDS` (origin `lib/booking-db/reservation-worker.js:69`).

Each copy carries its origin file's SHA-256, and a test asserts value parity by parsing the origin source TEXT, not by importing it.

The command imports only the planner.

## 4. Plan schema `e7-run-plan-v1` (exact keys at every level; unknown keys refused)

The file bytes must equal `canonicalJson(plan) + "\n"` exactly, ≤ 16 384 bytes, depth ≤ 8. This rejects non-canonical text and duplicate keys.

A NEW schema, not a manifest version:
- the v1 and v2 manifest validators refuse it, and it refuses v1 and v2 manifests;
- nothing is relabelled or upgraded;
- the synthetic M2-D core is untouched.

### 4.1 Top level and environment

| key | rule |
|---|---|
| `version` | `"e7-run-plan-v1"` |
| `kind` | `"reservation-test-abort-v1"` |
| `runId` | `^[a-z0-9-]{8,64}$` |
| `createdAt` | canonical ISO (`new Date(x).toISOString() === x`); ≤ planClock; age ≤ 24 h |
| `baseline` | `{ repoCommit: 40 hex, sourceDigest: 64 hex }` |
| `environment.stripe` | `{ mode: "test", accountId: ^acct_[A-Za-z0-9]{8,32}$ }` |
| `environment.hostaway` | `{ accountRef, clientSnapshotId }` (labels `^[A-Za-z0-9._:-]{1,100}$`) |
| `environment.db` | `{ instanceEnvironment: "test", appRole: "mv_booking_app", reportRole: "mv_booking_report" }` — names only |
| `listing` | `{ id, currency, refFieldId (1..10^9), timeZone (an IANA name accepted by localDateInZone), connection: disconnected \| airbnb }`; `{ id, currency }` ∈ copied `TEST_ABORT_LISTINGS` |
| `phases` | exactly `{ capture: false, recording: false, testAbortAfterReservation: true }` |
| `allowedOps` | EXACTLY the ordered, unique `ALLOWED_OPS` list (below). Not a subset: an omission, addition, reorder or duplicate is refused. |
| `checkpoints` | EXACTLY `CHECKPOINTS_BY_CONNECTION[connection]`, in order |
| `deadlines` | `{ quoteMaxAgeMinutes: 1..30, authorizationMaxAgeHours: 1..24 }`. These are maximum POLICY ages only. They say nothing about actual Stripe authorization validity, which the future L preflight must prove from the PI. |
| `stayRules` | `{ minLeadDays: 7..365, maxNights: 1..7 }` |
| `exclusions` | must equal `HISTORICAL_EXCLUSIONS` exactly (§5). The caller cannot omit or alter it. |
| `binding` | `null` (UNBOUND) or the object in §4.2 |

`ALLOWED_OPS`, in this order:
1. `hostaway.lookup_by_ref` (H1)
2. `hostaway.get_reservation_created` (H2, only the id this run created)
3. `hostaway.get_listing` (H3)
4. `hostaway.get_calendar` (H4)
5. `hostaway.price_details` (H5)
6. `hostaway.create_reservation` (H6, once)
7. `hostaway.cancel_reservation_created` (H7, once, the created id only)
8. `stripe.accounts.retrieve`
9. `stripe.paymentIntents.retrieve_bound`
10. `stripe.paymentIntents.cancel_bound` (once)

Capture, H8 / H9 (offline charges), refunds and notifications are never listed. The two settlement legs are host-cancel and authorization-void, not refunds.

### 4.2 `binding` (optional)

`{ intentId (uuid), expectedRef (^[A-Z0-9-]{4,32}$), stay: { arrival, departure, guests }, amountMinor, rateBps, paymentIntentId (^pi_[A-Za-z0-9]{8,64}$), quote: { totalMinor, currency, quotedAt }, authorizedAt }`

**Pure checks, against the injected planClock:**
- real dates (`isRealDate`; rollovers refused);
- `departure > arrival`; nights between 1 and `maxNights`;
- lead days = arrival − the listing-LOCAL date of planClock (`localDateInZone`, never UTC), and ≥ `minLeadDays`;
- `guests` 1..`MAX_GUESTS`; `amountMinor` 1..`MAX_AMOUNT_MINOR`; `rateBps` 0..10 000;
- `quote.totalMinor === amountMinor`; `quote.currency === listing.currency`;
- canonical ISO timestamps with `quotedAt ≤ authorizedAt ≤ createdAt ≤ planClock`. Future values are refused;
- quote age ≤ `quoteMaxAgeMinutes`; authorization age ≤ `authorizationMaxAgeHours`.
  - With `quotedAt ≤ authorizedAt` and the quote cap ≤ 30 min, `AUTHORIZATION_TOO_OLD` is dominated today (an authorization older than its cap is refused earlier by `TIMESTAMP_ORDER` or `QUOTE_TOO_OLD`); the check is kept as defence in depth. Both caps are policy maxima only, NOT a claim about the actual Stripe authorization validity (that is the future L proof).

There is NO reservation id in a binding: this is a create-only plan.

## 5. Historical exclusions (exact, from the accepted ledger; absence is explicit)

| label | intentId | paymentIntentId | reservationId |
|---|---|---|---|
| run1 | `b312e325-e6b5-498c-80b5-b91ce5bb3df2` | `null` (PI unset) | `null` |
| run2 | `48b59c0d-1c8c-4f32-ad91-08dbab1e8e3c` | `null` (no session / PI) | `null` |
| run3 | `cc53bc11-565d-4e9b-8be1-95f3febc8a39` | `pi_3UYqhH2B9LTneQgw1Q0IoYtz` | `null` (hostaway null; 0 Hostaway calls) |

Also:
- `otherPaymentIntentIds`: `pi_3UYUIm2B9LTneQgw0mGFQdwG` (the path-A TEST authorization/void).
- `protectedReservationIds`: 70636076, 71045356, 71072615, 71081885 (always zero-action).

Run1's checkout session id appears in the ledger only truncated, so it is not listed and not guessed.

**Refused:**
- a binding whose intent id or PI id is any listed id;
- duplicate or ambiguous entries in the constant (checked).

Run3's old quote and evidence are never adopted. But the same dates or amount (2027-01-18 → 20, 23000) alone are NOT a historical identity: a later, genuinely fresh, valid quote may coincide. Freshness comes ONLY from the quote and authorization age checks here and from the future L/G proofs, never from ID exclusion.

## 6. Check classes (in every package; statuses bound by the package hash)

**P — pure.** These are the only checks that run here, and on success every one is `PASS`:
- `schema`
- `hashDomains`
- `sourceClosure`
- `sourceDigest`
- `environmentSnapshot` (`evaluateProbeEnvironment` → `ENV_OK`)
- `stripeTestMode`
- `listingAllowed`
- `phasesExact`
- `allowedOpsExact`
- `checkpointsExact`
- `deadlineCaps`
- `stayRules`
- `exclusionsExact`
- `binding` (`PASS` or `UNBOUND`)

**L — future live read-only preflight.** Always `NOT_RUN` here:
- DB S1/S2 same-instance + TEST marker with BOTH the app and report logins;
- the intent is `payment_authorized` with the exact binding identity, no write op, no open case;
- the exclusion rows are unchanged;
- Stripe account = `accountId` in test mode;
- the PI is `requires_capture` with the exact amount and currency, `livemode:false`, and an actual `capture_before` / authorization expiry beyond the required margin;
- H3 listing identity; H4 calendar availability; H5 fresh quote = amount, within its cap; H1 empty lookup for the ref.

**G — gates immediately before each send.** Always `NOT_RUN` here:
- DB lock held; native signal not aborted; fresh step deadline;
- quote and authorization still within policy and PI proof;
- file-v2 combined ACK of STEP_STARTED / ABORT_REQUEST_STARTED; the required owner attestation recorded;
- the M8 boundary;
- the H7 target = this run's created id, not protected or excluded; the Stripe cancel target = the bound PI;
- all accepted protected, state, lock and ACK gates.

## 7. The command `runPlanCommand({ argv, deps })` — never throws, never rejects

**Mode first.** `argv` is snapshotted first, as a dense array of primitive strings.
- `["inspect"]` is the only accepted form.
- `["execute", …]` → `EXECUTE_NOT_IMPLEMENTED`; anything else → `USAGE`.
- Both refusals happen BEFORE `deps` is read at all. Not even its descriptor is read.

**`deps`.** A plain non-proxy object with EXACTLY `envSnapshot` (data), `planClock`, `readPlanFile` and `readSourceFiles` (non-proxy functions). It is bound once.
- `envSnapshot` is evaluated synchronously, and `planClock()` is called once synchronously; it must return a safe positive integer of ms.
- Then `await readPlanFile()` (Uint8Array) and `await readSourceFiles(frozenClosurePaths)` (an array of `{ path, bytes }` in closure order).
- All bytes are copied with `ownedBytes` immediately (the plan bytes right after `readPlanFile` resolves, before the second await; the source bytes inside the synchronous builder), so later caller mutation is irrelevant.
- Plan bytes that cannot be owned (not a genuine non-shared Uint8Array, empty, or > 4 × 16 384 bytes) → `PLAN_BYTES_INVALID`; owned but > 16 384 bytes → `PLAN_TOO_LARGE`.
- No getter, coerced value, symbol, proxy or boxed primitive is executed or accepted.

**Output.** Mechanically whitelisted: `{ schema: "e7-run-plan-cli-result-v1", outcome, code, executable: false, permissions }`. On success it adds `planHash`, `sourceDigest`, `packageHash` and the validated `package`.
- `outcome` ∈ `INSPECT_OK | PLAN_REFUSED | EXECUTE_NOT_IMPLEMENTED | USAGE | DEPS_INVALID`.
- `code` comes from the fixed code list.
- Error text, raw plan, raw source and raw env are never echoed.

## 8. Authorization boundary (unchanged)

- Stripe TEST cancel of a bound TEST PI is within Joel's delegation, inside a reviewed package.
- REAL Hostaway create / cancel writes are excluded from the current session scope. A future concrete owner scope package is required: listing 606998, ONE H6, ONE H7 of the created id, zero other writes, abort criteria, attestations, recovery read.
- None of this is sought by this slice.

## 9. Limits

This slice does not cover:
- a process entrypoint;
- credentials or DB-login ingress;
- a real-mode consumer;
- shared 0017 (still unapplied);
- the L/G implementation.

Owner environment and credentials remain parked.
