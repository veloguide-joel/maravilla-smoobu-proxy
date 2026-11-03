# E7.4b offline-charge bookkeeping: evidence + contract (PREPARATION ONLY), revision 2

- **Branch:** `feature/e7-offline-charge-contract`, cut from the accepted head `7270d6ac266f5cf44e19b87d47d2852f9e8f2d6c`. Docs only.
- **This document authorizes nothing.** No runtime code, live call, credential, migration, merge or deployment.
- **Revision 2** (2026-11-03) answers root's HOLD on `132202a`, items 1–7; §11 maps each item to where it is addressed.
- **Implementation stays on HOLD** until root re-reviews.
- **The historical contract is unchanged.** `claude/e7-compensation-worker-contract.md` is a record of what was known when it was written. This document is the newer reading of the **current** code and **current** official docs, and does not rewrite it.

Labels used throughout:
- **[DOC]** official documentation text;
- **[EX]** a documented example only;
- **[INF]** inference;
- **[UNV]** account or live behaviour not verified;
- **[CODE]** verified by reading the source at `7270d6a`.

**Standing session policies applied here** (already decided; not reopened):
- No automatic resend or new attempt after any ambiguous dispatch.
- All **future** listings and test or approval packages use **USD**.
- No notification, charge or refund executor exists in this worker's scope.

---

## 1. Purpose and scope

After the Stripe capture succeeds, E3 is in `payment_captured`, which `publicStatus()` maps to **"confirmed"**. E7.4b only **records the payment in Hostaway** (bookkeeping).

- **Success:** `OFFLINE_CHARGE_RECORDED` → `confirmed`. Public status stays "confirmed".
- **Any uncertainty:** a **case-only owner alert**. The booking stays paid and publicly "confirmed".
  - No cancel, void, refund, resend or new attempt.
  - The intent is never moved to `reconciliation_required` / "under_review" by this path.

---

## 2. Current code at 7270d6a [CODE]

| Path | Behaviour today | Consequence |
|---|---|---|
| E3 `CAPTURE_SUCCEEDED` / `RECONCILED_CAPTURE_SUCCEEDED` | → `payment_captured` with effect `hostaway.record_offline_charge {reservationId, amountMinor: capturedMinor}` | E3 queues the recording row; E7.4b only executes it. |
| `repo.js` effect mapping (l.104) | `non_idempotent`, key `och:{intentId}:{offlineChargeAttempts+1}`, payload `{reservationId, amountMinor}` | No currency and no marker in the payload. Both are derived from immutable intent facts (§5). |
| DB unique `one_open_offline_charge` (0001) | At most one recording per intent in pending / in_flight / outcome_unknown / escalated | Intrinsic. |
| DB insert guard (0003/0004) | A new recording is refused unless every earlier one is `failed_definite` with an owner resolution or a catalogued definite code | Intrinsic. |
| `definite_refusal_codes` | **Empty**. The guard refuses `in_flight → failed_definite` for non_idempotent rows without a code | Every non-success is `outcome_unknown`. `OFFLINE_CHARGE_FAILED` and E3 exhaustion are unreachable except after an owner resolution. |
| `markUnknown` (non_idempotent) | Row → `outcome_unknown` + `openCase(OFFLINE_CHARGE_OUTCOME_UNKNOWN, opened_by 'op:<id>')`. Intent untouched. | The existing case-only path, reached by `completeOperation(outcome_unknown)` and by lease-expiry maintenance. **Reusable as is.** |
| `recovery.js` AWAITING (offline branch) | Hides an `outcome_unknown` recording while its `op:<id>` case is open | No planner action while the case is open. |
| `planOfflineCharge` | `succeeded` + resultRef → `OFFLINE_CHARGE_RECORDED`, **trusting `succeeded`/`resultRef` alone**; otherwise operator codes or `OFFLINE_CHARGE_FAILED` | The generic planner is **not** sufficient for E7.4b success (§6.3). |
| `escalateOperatorPlan` | E3 `ESCALATE` → "under_review" | I7 risk. Latent today: no worker scans recordings. E7.4b never calls it for recordings. |
| `applyEvent` guard for `OFFLINE_CHARGE_RECORDED` (repo.js ~286) | Requires the latest recording `succeeded` **and** `result_ref = chargeId`. **Nothing else.** | **Correction of revision 1:** success is **not** evidence-bound in the DB. The DB checks only state and result_ref. Full binding is a worker transaction fence (§6.2), plus a proposed persisted link (§9, D2). |
| `applyEvent` `inTx` / `afterLoad` hooks | `inTx` runs inside the event transaction after the intent UPDATE. The compensation worker uses it to check `before.version`/`status` against the plan. | Lets the success event re-check evidence, lease and planned version atomically, without a new DB entry point. |
| `settle_operation_from_evidence` (0005) | reconcile_first only; it is the only runtime writer of `settled_evidence_id` (immutable per 0008) | A recording cannot be settled by the runtime, and has no persisted link to its evidence today. |
| `admin_resolve_operation` (0005, owner role) | succeeded: cited `hostaway_offline_charges` evidence, `observed_at ≥ dispatch + 15 min`, `matchingChargeCount = 1`, id = result. failed: API and dashboard count 0. | It proves **count and id only**. It does **not** prove the full identity required by this contract (§6.4). |
| `record_provider_evidence` / `validate_evidence` | Evidence only from a succeeded `hostaway.list_offline_charges` read; `external_ref` = the read's reservationId; status `listed`; count = len(ids) | The DB cannot distinguish complete from incomplete, or right-account from wrong-account reads. The worker gates what it records (§7). |
| `claimNextOperation` | Sets `state in_flight`, `attempts + 1`, `dispatched_at = now` at **claim** (operations.js l.97). Fences exist for CAPTURE / VOID / CANCEL only. | A claim is "possibly sent" from that moment. There is no recording fence today (§4.1). |
| `publicStatus` | `payment_captured` / `confirmed` → "confirmed"; `reconciliation_required` → "under_review" | A case-only alert keeps the guest-visible status. |

---

## 3. Official documentation (B1), read 2026-11-03 without credentials

**Sources.**
- **API reference:** `https://api.hostaway.com/documentation`, a client-rendered page read in a browser without signing in. Sections:
  - `#guest-charge-object`
  - `#guest-charge-transaction-object`
  - `#get-guest-charges-list`
  - `#get-charge-object`
  - `#create-offline-charge`
  - `#update-offline-charge`
  - `#refund-offline-charge`
  - `#get-auto-payment-rules`
  - `#authentication` / "Working with authorization token", plus the Introduction (standard response) and the Changelog.
- **Support (canonical pages, opened in a browser on 2026-11-03):**
  - **S1** "Automating Guest Payments (General Rules)", https://support.hostaway.com/hc/en-us/articles/360036454133-Automating-Guest-Payments-General-Rules. Updated **2026-10-30T10:03:53Z**. Section 4, "External Charges & API Integrations".
  - **S2** "How Auto-payments Work with API Reservations and Offline Charges", https://support.hostaway.com/hc/en-us/articles/54050957523739-How-Auto-payments-Work-with-API-Reservations-and-Offline-Charges. Updated **2026-08-06T09:24:00Z**. Linked from S1 §5.
  - **S3** "Processing Payments Manually (Online & Offline Charges)", https://support.hostaway.com/hc/en-us/articles/360007411294-Processing-Payments-Manually-Online-Offline-Charges. Updated **2026-09-24T08:24:50Z**.

### 3.1 Create offline charge, `#create-offline-charge`

- **[DOC]** `POST /v1/guestPayments/charges/{reservationId}`. Every field except `description` is mandatory: `title`, `amount`, `paymentMethod`, `status`, `scheduledDate`.
  - `status` ∈ {`awaiting`, `paid`}.
  - `paymentMethod` ∈ {`credit_card`, `vcc`, `cash`, `paypal`, `venmo`, `bank_transfer`, `bank_check`, `ota`, `other`}; `credit_card_online` is not accepted.
- **[DOC/EX]** The response is "Created charge object or error response".
  - The example contains `id`, `listingMapId`, `reservationId`, `type "charge"`, `title`, `description`, `currency`, `paymentMethod`, `amount`, `status "paid"`, `paymentProvider "offline"`, `scheduledDate`, `chargeDate`, `isManual`, `transactions []`.
  - The response is **documented by example**.
- **[EX inconsistency]** The request sends a description, but the example response shows `"description": null`. The marker relies on `title` only.
- **[DOC]** There is no currency input. The object reports `currency`. **[INF]** It comes from the reservation; we verify it, never send it.
- **[DOC]** `amount` is a float. **[EX]** Major units. **[INF]** 2-decimal currencies (USD) use the existing `minorToAmount` / `amountToMinor` exact conversion.
- **[DOC]** Times are UTC (Introduction). `scheduledDate` format in the example: `YYYY-MM-DD HH:MM:SS`.
- **[DOC] Auth:** `Authorization: Bearer <token>`.
  - **[EX inconsistency]** The create, update and refund examples show `jwt;`.
  - **[UNV]** Live acceptance of Bearer on create (E1).

### 3.2 Charges vs transactions

- **[DOC]** A guest **charge** (type charge / preAuth / refund; provider stripe / braintree / authorizeNet / **offline**) is the ledger item.
- A guest charge **transaction** is a provider payment record (`balanceTransactionId`).
- **[EX]** Offline charges have `transactions []`.
- E7.4b matches **charges only**.

### 3.3 Get guest charges list, `#get-guest-charges-list`

- **[DOC] Filters:** `reservationId` (single) and `reservationIds` (list) combine as AND. "Ids belonging to another account match nothing. A real id from another account and an id that exists nowhere are indistinguishable in the response."
- **[DOC]** `statuses[]` / `types[]` are bracket-only; a single value without brackets is ignored.
- **[DOC]** `limit` defaults to 100, cap 500. `count` = total matching, ignoring limit and offset.
- **[DOC]** Without `sortBy`, the order is "not newest-first": upcoming charges ascending, then past descending.
- **[DOC] Changelog 2026-10-02:** `reservationIds` was previously **silently ignored** and returned the whole account with HTTP 200. **[INF]** Filters can fail silently, so every returned row is verified.
- **[DOC]** `listingMapId` on a charge is copied at creation and is not updated after a listing move.
- **[UNV]** Snapshot consistency, read-after-write lag, `count` exactness under concurrent writes.

### 3.4 Recording cannot collect money

- **S3 [DOC-support]:** offline charges "are records for your accounting and reporting only". The table states money is not moved through Hostaway for "CC (Offline)" and other offline methods.
- **S3 caution:** a **Due** charge offers "Charge Now to process it online".
- **Rule:** E7.4b sends **`status: "paid"` only**, never `awaiting`, and never calls Update, Refund or Charge Now.

### 3.5 Auto-payments: duplicate-collection risk. **Correction of revision 1.**

Revision 1 cited an older text, fetched on 2026-11-03 with a web-fetch tool from the legacy URL slug `…/360036454133-Guest-Payments-Auto-payments`. That text said that a Public-API reservation created "with offline charges on it" gets no automatic charges.
- **It is superseded and withdrawn.** The canonical pages contradict it.
- The fetch tool's copy appears stale or cached [INF]. The same article id now serves S1.

**Current canonical text:**
- **S1 §4 [DOC-support]:** reservations created via the Public API **with an auto-payment template assigned "will always generate their scheduled payment calendar"**.
  - The system skips creation only when it detects charges already generated **by a template**.
  - Offline charges added by an API partner or OTA payments "do not block the process"; their amounts are subtracted and the **remaining balance** is scheduled.
- **S2 [DOC-support]:** the engine does not treat external offline charges as a reason to skip the schedule.
  - Remaining balance = total minus external charges. It is 0 only if external charges cover 100%.
  - The schedule is recalculated on reservation modification.
  - S2 also warns that Hostaway "will still schedule its own automated collections for any remaining unpaid amount".
- **S1 §2:** templates are selected **per channel** (e.g. Hostaway Direct, Booking Engine) **and listing**, with an option to apply to new listings automatically.

**Consequences:**
- Adding our offline record **does not protect** against auto-collection. No protection is inferred from it.
- If a template applies to our channel (`2000`, direct [CODE]) or listing, Hostaway may schedule or attempt collections (e.g. "at reservation creation") **before** our record exists. It could also act on any shortfall afterwards, e.g. an amount, currency or price mismatch.
- **Live prerequisite (P1):** verified absence of any auto-payment template covering the direct channel and our listings, through the documented read-only `GET /v1/guestPayments/autoPayment` (E6) and/or an owner dashboard check, before any live recording.
- **No support message and no account or config change is authorized or made.**

---

## 4. Fences

### 4.1 Intrinsic DB fences, enforced on every claim path (a later migration, like 0007/0009)

Only facts the database can know without worker configuration:
1. The intent state is `payment_captured`, and `captured_minor = final_total_minor` (the latter already enforced by `captured_exact`).
2. The row is the **latest** recording of its intent, with key `och:{intent}:1` and attempt 1 (`offline_charge_attempts = 0`).
3. `payload.reservationId = intents.hostaway_reservation_id`, and `payload.amountMinor = captured_minor = final_total_minor`.
4. Pending → in_flight only from `attempts = 0` and `dispatched_at IS NULL`.

The migration **cannot** enforce worker-specific items (listing scope, work lease, planned version, evidence freshness, executor config). Those are §4.2.

### 4.2 Worker-enforced checks (configurable)

- Listing allow-list and optional intent scope.
- The intent work lease (`intent_work`) owned by this worker, with remaining lease time.
- The planned intent version and status, re-checked under the intent lock (the compensation-worker `before.version` pattern).
- Preflight account and reservation verification (§5.1) and complete-read assessment (§7), both fresh.
- Explicit configuration: `paymentMethod` (§5.3), executors, environment gates (§8).

### 4.3 Pre-send fence (after the claim, on a fresh clock)

The claim commits `in_flight`, `attempts = 1`, `dispatched_at`. **From then on, the row is "possibly sent".** Immediately before the POST, using `clock()` read **now** rather than the plan time, **all** of the following must hold:
1. The recording lease is still owned by this worker, with at least `minSendMarginMs` left (≥ the bounded call timeout plus the confirm-read budget). The intent work lease is still owned, with margin.
2. A fresh re-read of the intent shows `payment_captured`, the planned version and an in-scope listing.
3. The row is the exact claimed row, with this worker as `lease_worker_id`, `state in_flight`, `attempts = 1`, `och:{intent}:1`, attempt 1.
   - Before the claim the worker observed `attempts = 0` and `dispatched_at` NULL.
4. `payload.reservationId = hostaway_reservation_id` and `payload.amountMinor = captured_minor = final_total_minor` (re-read).
5. The preflight evidence (§5.1, §5.2) is bound to this reservation and client and is younger than `preflightMaxAgeMs`.
6. The request body was built **before** the claim from immutable facts and frozen: marker, title, amount, method, `scheduledDate`, no currency field. The fence compares it to the facts re-read in steps 2 and 4.

Then:
- The final decision and the provider call happen with **no `await` between them** other than the call itself.
- The call is bounded by `sendTimeoutMs`, and there is a per-step budget.
- If any check fails, nothing is sent. The row is still **possibly sent by definition**, so it goes to `completeOperation(outcome_unknown)` → `markUnknown` → case. No retry, no new attempt.
  - The error code (e.g. `PRESEND_FENCE_<reason>`) is **diagnostic only**. It is never evidence of "not sent".

---

## 5. Request, identity and preflight

### 5.1 Account / reservation identity (item 1)

**Problem.** A syntactically complete zero-row list is **not** proof of anything. A wrong-account token reads a foreign reservation id as "nothing" [DOC §3.3].

**Documented capabilities.** The docs offer **no account-identity endpoint** for an access token in the sections read. None is invented here.

**Trust contract (explicit configured client + positive read):**
- **Provenance and binding.** One injected executor instance is constructed from one configured credential reference, `{accountRef, credentialRef}`.
  - It serves **all three** calls of one attempt: the identity read, the preflight list and the create.
  - The executor exposes its configured `accountRef`.
  - [CODE] Today **no account ref is persisted** with a reservation create. The worker therefore refuses unless its `accountRef` equals the reservation worker's configured `accountRef`, a configuration-level binding that is weaker than a persisted one.
  - Persisting the ref at create time would need a later reviewed change (noted, not proposed now).
- **Positive identity read.** The same executor runs the documented "Retrieve a reservation" (`GET /v1/reservations/{id}`). It must return **exactly** our reservation:
  - id;
  - the configured `listingMapId`;
  - `channelId 2000`;
  - arrival / departure = intent stay;
  - the booking-ref custom field = intent ref;
  - `totalPrice` → minor = `final_total_minor`;
  - `currency` = intent currency;
  - status active (not cancelled).
- **What it proves:** the client can read **our** reservation now, a positive fact, unlike an empty list.
- **Freshness:** taken in the same worker step, `observedAt ≥ now − preflightMaxAgeMs` (proposed 120 s), and before the claim.
- **Refusal:** any mismatch, missing field, non-success or a stale or different client means no claim. The attempt counts toward the preflight bound (§5.4).
- **Distinction.** The **prior accepted create identity** (E3's evidence-verified `hostaway_reservation_id`) proves the reservation was created. It does **not** prove that the **current** client reads and writes that account. Only the positive identity read under the same executor does.
- **Limitations:**
  - **[UNV]** whether one token can read reservations of one account and write charges to another;
  - **[UNV]** that Retrieve a reservation is account-scoped like the charges list;
  - a positive read proves read access, not write authorization.
  - Live gate **E7** (§10) validates these.

### 5.2 Preflight list (qualified result, BEFORE the claim)

The preflight list runs only after a passing §5.1 identity read, under the same executor. Its result is a **qualified preflight result**, never proof about any write:

| Complete read (§7) | Our exact marker | Same-amount paid charge without marker | Result |
|---|---|---|---|
| yes | absent | absent | **eligible to claim** (qualified: "no marker seen by this client at this time") |
| yes | present (any count) | — | **do not send** → case-only (prior recording exists) |
| yes | absent | present | **conservative conflict** → do not send → case-only. Not proof of duplicate identity. |
| no / untrusted | — | — | not eligible. Counts toward the preflight bound. |

"Complete absence" is **only** a precondition for the single first send. It is never used to settle an unknown write (§6.4).

### 5.3 Request binding (frozen before the claim)

- **Marker** = `mvoch1-` + the intent UUID in lower-case canonical form (36 chars). ASCII only, 43 chars, fixed.
- **Title** = exactly `"maraVilla payment " + marker` (61 chars). Equality is **exact string equality** after JSON decoding. No `contains`, no case folding, no trimming.
- **Description:** omitted. It is not relied on.
- **Amount** = `minorToAmount(capturedMinor)`. It must round-trip `amountToMinor(amount) = capturedMinor` exactly before sending.
- **paymentMethod:** an explicit config value, required.
  - Absent, or not in the approved set {`credit_card`, `other`}, → **fail closed**; the worker refuses to start.
  - No default. `credit_card` stays the recommendation for the later consolidated owner decision (§10).
- **status:** `"paid"`.
- **scheduledDate:** the **DB-stamped** `intent_transitions.recorded_at` (0005 trigger, statement clock) of the transition that entered `payment_captured` (`CAPTURE_SUCCEEDED` / `RECONCILED_CAPTURE_SUCCEEDED`), formatted in UTC as `YYYY-MM-DD HH:MM:SS`.
  - It is never `now()`, and never caller-supplied.
  - If that transition row is missing, refuse.
- **Currency:** no currency field. The **expected** currency = `intent.price.currency`.
  - Future packages are **USD** (policy). The worker refuses if the intent currency is not in the configured set (USD for future packages).
  - The response currency must equal it **exactly** (`"USD"`).

### 5.4 Durable bounds

These come from durable rows only, with no in-memory counters:
- **Preflight failures** = the number of `hostaway.list_offline_charges` read rows for the intent created after the recording row's `created_at` that did not yield a complete, eligible result, plus failed identity reads (`hostaway.retrieve_reservation` rows in the same window).
  - Bound `MAX_PREFLIGHT_ATTEMPTS = 3`, then a case-only alert.
- **Confirm-read exhaustion:** the confirming read gets at most `MAX_CONFIRM_READS = 3` attempts inside the send step's budget. Then `outcome_unknown` → case.
- **Read-row retry class:** `read`, `max_attempts 10` (existing), bounded by the step budget above.

**Design blocker D1.** A case-only alert for a recording that was **never claimed** (preflight exhausted or conflict) has no existing entry point.
- `markUnknown` / `openCase` run only inside `completeOperation` for a **claimed** row.
- Claiming just to open a case stamps `dispatched_at` and makes the row "possibly sent", which loses the real "not sent" truth.
- **Proposal:** a reviewed helper/DB function `open_recording_case(opId, kind, evidence)` for a **pending, undispatched** recording. It opens a non-escalating case (`OFFLINE_CHARGE_NOT_SENT_<reason>`), leaves the row pending (claimable later only by owner action), and never changes the intent.
- **Until D1 is accepted, the dispatch worker is blocked.**

---

## 6. Success, recovery and owner resolution (item 3)

### 6.1 Reply validation (necessary, not sufficient)

- Envelope `status = "success"`.
- `result.id`: a JSON integer that is `Number.isSafeInteger` and > 0. Stored as a decimal string. **Reject** non-integers, strings with leading zeros, and unsafe magnitudes.
- `result.reservationId` (safe integer) = our id, compared as a decimal string.
- `result.listingMapId` = the configured listing.
- `type = "charge"`, `paymentProvider = "offline"`, `status = "paid"`, `paymentMethod` = the configured value.
- `title` = the exact frozen title.
- `currency` = the expected value exactly.
- `amount`: a finite number with `amountToMinor(amount) = capturedMinor`.
- **Any failure** → `outcome_unknown` → case.

### 6.2 Confirming evidence BEFORE completion; the success-event fence

1. Still under the recording lease and before `completeOperation`, run a **complete** list read (§7) under the same executor.
2. Record **immutable** evidence via `record_provider_evidence`: `status listed`, `matchingChargeCount 1`, `matchingChargeIds [id]`, and `observed` carrying
   - `chargeId`, `reservationId`, `listingMapId`, `amountMinor`, `currency`, `status`, `type`, `paymentProvider`, `paymentMethod`, `title`, `marker`;
   - `readCount` and `executorAccountRef`.
3. Only if exactly one row has the exact title and it equals the reply in every field, call `completeOperation(succeeded, resultRef = chargeId)`.
4. **Success event:** `applyEvent(OFFLINE_CHARGE_RECORDED {chargeId})` with an `inTx` fence that, inside the event transaction:
   - re-reads the recording row `FOR SHARE`: `state succeeded`, `result_ref = chargeId`, latest recording, attempt 1;
   - re-reads the **exact evidence id** captured in step 2: its `read_operation_id` is a succeeded `hostaway.list_offline_charges` row, `external_ref` = reservation, `observed_at ≥ dispatched_at`, and every observed field equals the expected full identity;
   - checks that `before.version` / `status` equal the planned values (`payment_captured`);
   - checks that the intent work lease is still owned by this worker.
5. Any mismatch → throw (rollback). No event is applied. The row stays succeeded-but-unconfirmed (§6.3).

### 6.3 Recovery when `succeeded` exists without the event

- **Never** through the generic `planRecovery` → `planOfflineCharge`, which trusts `succeeded` / `resultRef` alone.
- The E7.4b recovery pass, scoped to recordings and `payment_captured`:
  - independently locates the **persisted bound evidence**: exactly one evidence row satisfying the full §6.2 predicate for this row's `result_ref`, observed after `dispatched_at`;
  - then applies the event through the same `inTx` fence.
- Zero qualifying evidence rows, more than one, or any mismatch → **no event, no provider write, no escalation**. It needs a case-only alert for a **succeeded** row, which has no existing entry point (`markUnknown` handles only in-flight rows).
- **Design proposal D2:**
  - (a) persist the evidence link on success (`settled_evidence_id` for non_idempotent recordings, set atomically with `completeOperation`; immutable per 0008); and
  - (b) a non-escalating case opener for "succeeded but unproven".
- **Until D2 is accepted, the dispatch worker is blocked.** Deriving evidence without a persisted link is documented above as a fallback but not proposed as sufficient.

### 6.4 Owner-resolved unknowns

- `admin_resolve_operation(succeeded)` proves only `matchingChargeCount = 1`, the id and the time [CODE]. **It does not prove the full identity of this contract.**
- E7.4b recovery applies `OFFLINE_CHARGE_RECORDED` after an owner resolution **only if** the resolution's cited evidence is:
  - an API source (`hostaway_api`) from a succeeded list read;
  - `observed_at ≥ dispatch + 15 min`;
  - carrying the full §6.2 observed fields, all matching.
- Otherwise it stops **case-only**: the owner's resolution stands and no event is applied by automation. Visibility needs the D2(b) opener.
- **Zero, incomplete or mismatched evidence:** no provider write, no escalation of the paid state, case only.

---

## 7. Complete-read assessment (item 6)

A list read is **complete and trusted for this assessment** only if **all** of these hold:
- HTTP 200, a JSON object, `status === "success"`, `result` an array.
- `count`: an integer, `0 ≤ count ≤ 500`; otherwise refuse (no speculation about why).
- Request: `reservationId=<id>` (singular), `limit=500`, no offset, no status or type filters.
- `result.length === count`.
- Every row:
  - `id` and `reservationId` are safe positive JSON integers;
  - `reservationId` = ours (as a decimal string);
  - `listingMapId` = ours;
  - it has `type`, `title`, `amount`, `currency`, `status`, `paymentProvider` with the expected JSON types.
- Ids are unique; **duplicates mean refuse**.
- The read ran under the same executor that passed §5.1, within the step budget.

**Limits.** These checks prove internal consistency of one page only. They do **not** prove:
- snapshot consistency;
- account correctness (that is §5.1);
- absence of read-after-write lag.

An incomplete or untrusted read:
- records **no evidence**;
- never infers absence;
- counts toward its bound (§5.4).

Live gate **E4** (§10) validates lag and count behaviour.

---

## 8. Executor and environment safety

- Production refusal: the worker refuses unless the environment gate is explicitly enabled (as with the E7 workers). In tests, **fake executors only**.
- The executor set is exactly `{retrieveReservation, listCharges, createOfflineCharge}`. **No** update, refund, Charge-Now, auto-payment write, notification, Stripe or charge executor exists.
- `guest.notify` effects are not dispatched by this worker.
- The protected E4 ids (70636076 / 71045356 / 71072615 / 71081885) are refused with the existing `isProtectedReservationId` [CODE reservation-worker.js l.71; compensation-proof.js l.24]. That means no read, no claim, no send.

---

## 9. Crash windows and visibility

| Point | Persisted state | Outcome |
|---|---|---|
| Before the claim (identity / preflight) | pending, undispatched | Re-run later within the bound. Exhaustion or conflict → D1 case (blocked until D1). |
| After the claim, pre-send fence fails | in_flight, possibly sent | `outcome_unknown` → case (diagnostic code only) |
| After the POST, before validation, or a timeout | in_flight | `outcome_unknown` → case; lease expiry gives the same |
| During the confirming read | in_flight (+ maybe evidence) | `outcome_unknown` → case. Evidence helps the owner. |
| After `succeeded`, before the event | succeeded | E7.4b recovery with bound evidence (§6.3); unproven → D2 case |
| After the event | `confirmed` | done |

**Attempt > 1 (item 5).** E3 queues `och:{intent}:2` after an owner-resolved `failed_definite`.
- The intrinsic fence (§4.1 item 2) makes it **unclaimable**.
- It must not sit silently pending. It needs **durable case-only visibility** via the same D1 opener (`OFFLINE_CHARGE_ATTEMPT_GT1_MANUAL`), without claiming it.
- **This is a design blocker, not an owner question.** No automatic resend or new attempt is already decided policy.

---

## 10. Remaining live evidence and prerequisites

These belong to one later consolidated, owner-approved live package. **USD listing; non-protected test reservation; not requested now.**

| # | Evidence |
|---|---|
| E1 | Create accepts `Authorization: Bearer` |
| E2 | The live create reply matches §6.1 (id type, listingMapId, title persisted exactly, description behaviour) |
| E3 | USD amount echo for 2-decimal values; currency = reservation currency |
| E4 | List-by-`reservationId` read-after-write lag; `count` exactness |
| E5 | Title length limit; exact title round-trip |
| E6 / P1 | No auto-payment template covers channel 2000 or our listings (`GET /v1/guestPayments/autoPayment`, read-only), and/or an owner dashboard check; `remainingBalance` after recording |
| E7 | One credential's read and write account binding; Retrieve-a-reservation account scoping (§5.1 limits) |

**Owner decision, deferred to that package:** `paymentMethod`. Recommend `credit_card`, which S3 labels as "CC (Offline)"; the alternative is `other`. Joel is not being asked now.

---

## 11. Root HOLD items → where addressed

1. **Identity and authorization:** §5.1, §5.2, §7 limits.
2. **Pre-send fence; intrinsic vs worker checks:** §4.1–§4.3.
3. **Success not DB-evidence-bound; the event fence; recovery; owner resolution:** §2, §6.2–§6.4, D2.
4. **Auto-payment evidence correction:** §3.5 (S1 / S2 / S3 with dates; the legacy fetch is withdrawn).
5. **USD, no attempt-2 invitation, attempt > 1 visibility, fail-closed method:** policies header, §5.3, §9, D1.
6. **Strictness, timestamp, bounds, executors, diagnostic codes:** §4.3, §5.3, §5.4, §6.1, §7, §8.
7. **Narrow next step and extended matrix:** §12, §13.

---

## 12. Test matrix (for the later pure module and, separately, the worker)

**Pure request / proof / read-assessment module.** Fake fixtures, explicitly labelled doc-derived.

| # | Case | Expected |
|---|---|---|
| P1 | Marker / title builder: exact format, ASCII, lower-case UUID, length | exact |
| P2 | Title equality: an exact match passes; substring, prefix/suffix, case change, whitespace, unicode look-alike | refuse |
| P3 | Ids: safe integers pass; float, string, leading zero, negative, zero, > 2^53, missing | refuse |
| P4 | count: non-integer, negative, > 500, ≠ length; duplicate ids | incomplete |
| P5 | Foreign `reservationId` or `listingMapId` row (silent-filter failure) | untrusted |
| P6 | Currency exact `"USD"`; `"usd"`, `"MXN"`, missing → mismatch. Amount round-trip x.x0, x.05, large, non-finite | exact / refuse |
| P7 | `scheduledDate` from a supplied DB-stamped transition time; missing transition → refuse; never `now` | exact |
| P8 | Unset or unapproved `paymentMethod` | fail closed |
| P9 | Identity read: every field mismatched individually; cancelled status; stale `observedAt`; different executor `accountRef` | refuse |
| P10 | **Wrong account: an empty list with a valid envelope but no positive identity read** | not eligible |
| P11 | Preflight table: marker present / same-amount unmarked paid charge / complete-absent | per §5.2 |
| P12 | Reply validation: each §6.1 field broken individually | unknown |
| P13 | Confirm assessment: 0 / 2 / 1-mismatched / incomplete / exact-1 | per §6.2 |
| P14 | Owner-resolution evidence: count-1 evidence lacking the full fields / dashboard source / too early | stop case-only |

**Worker (blocked until D1, D2 and the live gates; listed for completeness).**

| # | Case | Expected |
|---|---|---|
| W1 | Happy path (USD) | 1 POST; evidence; succeeded; `RECORDED` via the fence → confirmed |
| W2 | Intrinsic fence on every claim path: wrong state, attempt > 1, payload reservation or amount changed, already dispatched | not claimable |
| W3 | Stale preflight (age > max) at the pre-send fence; expired recording lease; expired work lease; a concurrent version change between claim and send (observed lock wait) | 0 POST; `outcome_unknown` + case; no retry |
| W4 | `amountMinor` changed in the payload after the plan | intrinsic refuse / pre-send refuse |
| W5 | Event lease or version lost between completion and event | no event; recovery path |
| W6 | Forged or missing confirming evidence; evidence for another reservation or charge; `observed_at` before dispatch | no event; D2 case |
| W7 | Succeeded row with only `resultRef` (no full evidence), presented to recovery | no event; never via the generic planner |
| W8 | Owner resolution with insufficient fields | no event; case-only |
| W9 | Attempt-2 row after an owner `failed_definite` | not claimed; D1 visible case |
| W10 | Timeouts / 5xx / malformed reply | unknown + case; exactly 1 POST ever |
| W11 | Protected ids | 0 calls |
| W12 | `publicStatus` "confirmed" throughout; no ESCALATE / void / cancel / refund / notify rows | asserted |

---

## 13. Go / no-go

| Item | Status |
|---|---|
| Docs: create fields, response example, list filters, `count`, order, no money movement | **resolved [DOC/EX]** |
| Auto-payment interaction | **corrected**: an offline record does not prevent schedules; P1 / E6 is a **live prerequisite** |
| Identity / authorization | **contract defined** (§5.1); live gate E7 |
| Pre-send fence; intrinsic vs worker split | **defined** (§4) |
| Success binding / recovery / owner resolution | **defined**; **D2 blocker** (persisted evidence link + succeeded-unproven case) |
| Never-claimed and attempt > 1 visibility | **D1 blocker** (pending-row case opener) |
| `paymentMethod` | config fail-closed; owner decision deferred to the live package (recommend `credit_card`) |
| Currency | USD for future packages; exact match |

**Verdict.**
- **NO-GO** for the dispatch worker, its adapter, its migration and any live call. Trust, evidence and alert design gaps D1 and D2, plus live gates E1–E7 / P1, remain.
- **Narrow next step (after root accepts this contract):** a **pure** request / proof / read-assessment module with fake, doc-derived fixtures and tests P1–P14. No DB, worker, migration, adapter or I/O.
- D1 / D2 are separate reviewed proposals afterwards.

---

## 14. E7.4b-0 pure foundation: mapping note (added with `lib/checkout/offline-charge-proof.js`)

Root accepted revision 2 as the design basis for the **pure foundation only**.
- D1, D2, E1–E7 / P1 and the `paymentMethod` owner choice stay **open**.
- The module implements §5–§7 / P1–P14 with **every fact and time as an input**. It never reads a clock, the environment, the network or the DB.

Tightenings made while implementing; where they differ from earlier text, these govern:
- **Ids:** provider ids must be safe positive JSON **integers**, held internally as canonical decimal strings. String ids and unsafe numbers are refused, with no precision recovery. Intent and op ids are lower-case canonical UUIDs.
- **Times:** finite positive integers; `observedAt ≤ now`; at most `SNAPSHOT_MAX_AGE_MS` (120 s) old, **inclusive**. Confirming evidence must be strictly after `dispatchedAt`.
- **`scheduledDate`:** formatted from `recordedPaymentAt`, the **trusted recorded-payment timestamp** (e.g. the DB-stamped `payment_captured` transition). That is **not** proof of Stripe's capture instant. Loading it and proving its provenance belongs to a later runtime slice. Sub-second precision is truncated.
- **Identity:** every field is required individually, including the booking ref (absent counts as a mismatch). The status must be in `ACCEPTED_ACTIVE_STATUSES = ["new"]` (conservative v1).
- **Currency:** exact `"USD"`, checked on the raw provider string before any case folding.
- **Account / client binding:** `accountRef` / `clientSnapshotId` are **worker-supplied labels**. Equal labels do **not** prove the same actual client or credential; that remains trusted worker input (§5.1 limits).
- **Titles:** exact equality authorizes a match. Any other title carrying the marker loosely is **suspicious**, i.e. a conflict (preflight) or unknown (confirm), never "absent". Loose means a substring, a case change, NFKC look-alikes, zero-width characters or a dash-less UUID.
- **Request:** exactly the five documented fields, with `status "paid"`; no currency or description.
- **Create reply:** HTTP **200 or 201** are accepted pending E2 [UNV].
- **Owner-resolution evidence:** the pure check requires the **full** observed identity plus API source, a succeeded list-read binding, settle time and the dispatch binding.
  - A count-only fixture fails.
  - The existing `admin_resolve_operation` does **not** enforce this shape.
- **Outputs:** every output carries `sendAuthorization: false` where relevant. None authorizes a send.
