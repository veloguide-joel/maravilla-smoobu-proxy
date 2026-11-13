# C17 — Read-only Hostaway charge-LIST shape probe — operator packet (OFFLINE DRAFT; no workflow, no dispatch) — 2026-11-13
Claude executor. Base: closed main `89c0e3e7` (all five flags FALSE). Deliverables in this PR: `scripts/e7-hosted-charge-list-probe.mjs` (new, not in any runner's `runnerFiles`), `test/e7-hosted-charge-list-probe.test.mjs` (fake exchange only), this packet. Nothing was run live; no credential, browser session or network was used; both TEST intents and their provider objects are untouched.

**Policy frame:** refunds manual; recording / notification / cleanup HELD (D4); this probe proves (or refutes) only that the Hostaway charge-LIST reply shape for the one approved TEST reservation is what the accepted recording proofs expect. **An empty or well-formed LIST does not prove that `POST /v1/guestPayments/charges/{id}` exists or would be accepted; UI "Add transaction" is not API proof.**

## 1. Fixed target (the only thing it can look at)
| | |
|---|---|
| listing | 606998 (Draft, no channel mapping) |
| reservation R | **71700931** (status `New` at C12; ref field 105433 = `MV-8L79DEJ7`) |
| stay / guests | 2026-11-23 → 2026-11-24 (1 night) |
| money | USD 140.00 = 14000 minor (captured, `pi_3UbR9W…`) |
| intent facts (constants) | `abede8b1-8ef6-44f2-876e-6a02fc056a96`, `payment_captured` v8, `recordedPaymentAt` = capture instant 2026-11-13T20:57:10Z (presence only) |
| config (recording runner's) | `accountRef hostaway-e7-test`, `channelId 2000`, `currency USD`, `listingId 606998`, `paymentMethod credit_card`, `refFieldId 105433` |
These are frozen constants in the script; no input, env or argument can retarget it.

## 2. Exactly what it sends
| # | Request (accepted transport form) | Query / wire | Gate |
|---|---|---|---|
| 1 | `GET https://api.hostaway.com/v1/reservations/71700931` (form **H2**) | none | always first |
| 2 | `GET https://api.hostaway.com/v1/guestPayments/charges?limit=500&reservationIds=71700931` (form **H8**; internal selector `{ limit: 500, reservationId: "71700931" }`, the exact selector the recording worker uses) | `limit=500` (= `offline-charge-proof LIST_LIMIT` = `CHARGE_LIST_LIMIT`, asserted at load) | only if #1 passes the accepted identity proof |
Hard budget 2 calls; GET only; this origin only; these two URLs only; no body; no retry (a thrown/rejected exchange is final); redirects (3xx) are refused by the accepted transport and never followed; `Authorization: Bearer <token>` is set by the accepted transport and never surfaces in output. Headers: `Accept: application/json`, `Cache-control: no-cache` (transport defaults). Max body 1 MiB (transport default).

## 3. What decides (accepted proofs, reused unchanged; tooling pin = the recording runner's `5a094b16`)
- Tooling is digest-pinned at load: `lib/checkout/offline-charge-proof.js` `2469ee96…`, `lib/hostaway-reservations.js` `d86827cc…`, `scripts/e7-connected/http-transports.mjs` `2c41847f…` (any drift → `TOOLING_DIGEST_MISMATCH`, nothing sent). These three files are inside the Slice 4 closure (`ef9341dc…`); the probe adds no closure member and changes none.
- Identity: `assessIdentitySnapshot` — HTTP 200, success envelope, `normalizeReservation` (adapter config listing/ref field/channel/currency), **id = 71700931, listingId 606998, channelId 2000, arrival/departure = stay, totalMinor 14000, currency USD, bookingRef = MV-8L79DEJ7, status ∈ {"new"}**, ≤ 2 min fresh. Any mismatch → `IDENTITY_REFUSED/<code>` and **no list call**.
- List: `assessChargeList` — 200, success envelope, `result` array, `count` safe int ≤ 500 and = length, every row: canonical id, unique, `reservationId` = R, `listingMapId` = 606998, string `type/title/currency/status/paymentProvider/paymentMethod`, `type ∈ {charge, preAuth, refund}`, exact money (refund rows negative). Then `preflightListObservation` (count-only: `matchingChargeCount/Ids`, `sameAmountPaidCount`, `lookalikeCount`, `rowCount`).
- Probe-specific fail-closed additions: `count ≥ 500` → `LIST_PAGE_FULL_AMBIGUOUS`; truthy `hasMore`/`nextPage` → `LIST_PAGINATION_FIELDS_AMBIGUOUS` (`limit`/`offset` presence is reported, not ambiguous).

## 4. Output (allowlisted; stdout one line + the frozen result object)
`stop` (null or a code), `outcome` (`SHAPE_COMPATIBLE`), `calls`, `urls`, `guardRefusals`, `identity { httpStatus, envelope, ok, code, reservation { reservationId, listingId, channelId, from, to, totalMinor, currency, status, bookingRefMatches } }`, `list { httpStatus, envelope, count, paginationFields, ok, code, rowCount, typesSeen, matchingChargeCount, matchingChargeIds, sameAmountPaidCount, lookalikeCount, rows[{ chargeId, type, status, amountMinor, currency, paymentProvider, paymentMethod }] }`, `transportCode`. **Never** raw bodies, titles, guest names/emails/phones, headers, tokens. Unknown = absent + a code; nothing is inferred.

## 5. Tests (fake exchange; `E7_TOOLING_DIR=<5a094b16 checkout>`; zero network — every real primitive throws): **8/8**
P0 pin/digest drift refusal · P1 happy path (2 GETs, exact URLs, identity bound, empty list → `SHAPE_COMPATIBLE`, token only on the wire) · P2 non-empty list summarised (ids/type/status/amount; refund negative amount; same-amount and lookalike COUNTED only) · P3 12 identity refusals → exactly 1 call, no list · P4 10 list refusals/ambiguities (fail envelope, non-200, count mismatch, foreign reservation/listing rows, duplicate, malformed, full page 500, hasMore/nextPage) → 2 calls max, same selector · P5 redirects refused, thrown exchange final (no retry), credential never on the wire if invalid · P6 own guard (POST / other host / other reservation / extra or wrong query / body / third call) · P7 static (node built-ins only; no POST/PUT/DELETE/DB/worker/record/cancel/refund/notify/Stripe text; no executor phase; env/fetch only after the main guard; frozen constants).
`--dry` prints the plan with zero network; `--probe` without `E7_TOOLING_DIR` + `E7_HOSTAWAY_TOKEN` refuses (exit 2). Runner digests unchanged (five values as at `89c0e3e7`; recording `31c0ca93…`).

## 6. How ROOT could run it later under the EXISTING gate (proposal only; nothing implemented or dispatched)
The probe needs exactly what the recording runner's **execute** step already has: the pinned tooling checkout (`ref: 5a094b16…`, `npm ci` in `tooling/`), Node 22.22.0, `E7_TOOLING_DIR`, and `E7_HOSTAWAY_TOKEN` from environment `e7-readonly-probe` (required reviewer, main-only, admin bypass OFF — C5). **No new secret, environment, permission or security setting.** It does **not** need the DB URL, the Supabase CA, Stripe, or any `E7_*` plan input. Minimal workflow diff (NOT in this PR): a new `.github/workflows/e7-hosted-charge-list-probe.yml` = a copy of the recording workflow's `execute` job skeleton with (a) `workflow_dispatch` input `approval_ref` only, (b) the same two checkouts + setup-node + `npm ci`, (c) one step `env: { E7_TOOLING_DIR, E7_HOSTAWAY_TOKEN }` running `node wrapper/scripts/e7-hosted-charge-list-probe.mjs --probe`, (d) `if: github.ref == 'refs/heads/main'` + `environment: e7-readonly-probe`, concurrency `e7-hosted-charge-list-probe`, `timeout-minutes: 5`; no DB/CA/Stripe steps. Alternatively (even smaller) a `mode: probe-list` input on the recording workflow — rejected here because it would touch a reviewed workflow file and the recording runner's digest story. The script's own guard means even a mis-wired step cannot POST or reach another host.

## 7. Limitations (explicit)
- Proves the LIST **read** shape only; says nothing about `POST …/charges/{R}` availability/acceptance on a Draft listing, nor about the create reply shape (`offline-charge-proof.js:354-422` remain LIVE-UNVERIFIED).
- Identity requires status `new`; if the owner has since touched R71700931 in the UI, the probe stops at `IDENTITY_REFUSED` by design (no broader search).
- Hostaway's `limit`/`offset` semantics for this endpoint are doc-derived; a full page or a pagination marker is treated as ambiguous and stops.
- One run = one snapshot; it records nothing (no DB), so its evidence lives only in the run log / report ROOT retains.
- The result object echoes the fixed target constants and config labels (ids only); `accountRef`/`clientSnapshotId` are TRUST labels, not authentication.
