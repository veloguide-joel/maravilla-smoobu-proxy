# E7.4b offline-charge bookkeeping: evidence + contract (PREPARATION ONLY)

- **Branch:** `feature/e7-offline-charge-contract`, cut from the accepted head `7270d6ac266f5cf44e19b87d47d2852f9e8f2d6c`. Docs only.
- **This document authorizes nothing.** No runtime code, live call, credential, migration, merge or deployment.
- **Status:** written by Claude on 2026-11-03 for root review. No implementation starts before root accepts this contract.
- **The historical contract is unchanged.** `claude/e7-compensation-worker-contract.md` (§7 / §8 / I7 / B1) is a record of what was known when it was written. Where this document differs, this document is the newer reading of the **current** code and the **current** official docs. The older text is not rewritten.

Labels used throughout:
- **[DOC]** documented contract text;
- **[EX]** documented example only;
- **[INF]** inference;
- **[UNV]** account/live behaviour not verified;
- **[CODE]** verified at `7270d6a` by reading the source.

---

## 1. What E7.4b is for (scope)

After the Stripe capture succeeds, E3 is in `payment_captured`, which `publicStatus()` maps to **"confirmed"**. The only remaining job is **bookkeeping**: tell Hostaway that this reservation was paid outside Hostaway, so the reservation's balance and the owner's reports reflect it.

- **Success:** `OFFLINE_CHARGE_RECORDED` → `confirmed`. Public status stays "confirmed".
- **Any uncertainty:** a **case-only owner alert**. The booking stays paid and publicly confirmed.
  - Nothing is cancelled, voided, refunded or retried because of bookkeeping uncertainty.
  - The intent is never moved to `reconciliation_required` (public "under_review") by this path.

---

## 2. Current code at 7270d6a (independently inspected) [CODE]

| Path | What the code does today | Consequence for E7.4b |
|---|---|---|
| E3 `CAPTURE_SUCCEEDED` / `RECONCILED_CAPTURE_SUCCEEDED` (`intent-state.js` ~531/550) | → `payment_captured` with effect `hostaway.record_offline_charge {reservationId, amountMinor: capturedMinor}` | The recording row is queued by E3 at capture time; E7.4b only executes it. |
| `repo.js` effect mapping (l.104) | Row: `retry_class = non_idempotent`, key `och:{intentId}:{offlineChargeAttempts+1}`, payload `{reservationId, amountMinor}` | The payload has **no currency and no marker**. The worker derives both from the intent, as fixed facts. |
| DB `external_operations_one_open_offline_charge` (0001) | At most one recording row per intent in pending / in_flight / outcome_unknown / escalated | One open recording per intent is enforced in the DB. |
| DB insert guard (0003/0004) | A new recording row is refused unless every earlier one is `failed_definite` **with** an owner resolution or a catalogued definite refusal code | A second attempt is impossible while an earlier one is unresolved. |
| `definite_refusal_codes` (0003) | **Empty**. The 0004 guard refuses `in_flight → failed_definite` for non_idempotent rows without a catalogued code | Today **every** non-success of a recording is `outcome_unknown`. `OFFLINE_CHARGE_FAILED` (and the E3 retry and exhaustion loop) is **unreachable** without an owner resolution. E7.4b must not add codes. |
| `operations.js markUnknown` (non_idempotent branch) | Row → `outcome_unknown` + `openCase(OFFLINE_CHARGE_OUTCOME_UNKNOWN, opened_by 'op:<id>')`. **The intent is not touched.** | This **is** the existing case-only path. Both `completeOperation(outcome_unknown)` and lease-expiry maintenance (`recoverExpiredOperations` → `markUnknown`) reach it. |
| `recovery.js` AWAITING (offline branch) | Selects a recording only if the intent is `payment_captured`, the row is the latest recording, and NOT (`outcome_unknown` with an open `op:<id>` case) | While the owner case is open, `findMissedOutcomes` never returns the row, so no planner or operator action follows. |
| `recovery-plan.js planOfflineCharge` | `succeeded` + resultRef → `OFFLINE_CHARGE_RECORDED`; `succeeded` without resultRef → operator `OFFLINE_CHARGE_ID_MISSING`; `failed_definite` → `OFFLINE_CHARGE_FAILED`; otherwise operator `OFFLINE_CHARGE_OUTCOME_UNKNOWN` | Operator plans are dangerous only if a caller **escalates** them (next row). |
| `escalateOperatorPlan` (recovery.js) | Applies E3 `ESCALATE` → `reconciliation_required` (public **under_review**) | **I7 gap.** Today **no caller** runs `findMissedOutcomes` over recordings: the reservation, capture and compensation workers scope it to CREATE / CAPTURE / VOID+CANCEL. The gap is latent; E7.4b must not open it. |
| E3 `OFFLINE_CHARGE_FAILED` | Counter +1, re-queues a recording; at `maxOfflineChargeAttempts` (10) → `escalate("OFFLINE_CHARGE_UNRECORDED")` | Unreachable today (see the definite-codes row). If it were reached, it would escalate a paid booking, so E7.4b never produces it. |
| E3 `ESCALATE` in `payment_captured` | Allowed (ROUTES l.135) → `reconciliation_required`, alert.owner | Only an explicit reconciler or owner action reaches it. E7.4b never sends it. |
| `applyEvent` guards (repo.js ~280–290) | `RECORDED` needs the latest recording `succeeded` with `result_ref == chargeId`. `FAILED` needs it `failed_definite`. | Success is evidence-bound in the DB. |
| `settle_operation_from_evidence` (0005) | Accepts **reconcile_first only** | An unknown recording **cannot** be settled automatically by the runtime. |
| `admin_resolve_operation` (0005, owner role) | Recording `succeeded`: API evidence `hostaway_offline_charges`, ≥15 min after dispatch, `matchingChargeCount = 1`, id = result. `failed_definite`: count 0 from **both** an API read and an owner dashboard check, both ≥15 min after. It resolves the `op:<id>` case. | The existing owner path settles unknowns with evidence. No new DB entry point is needed. |
| `record_provider_evidence` + `validate_evidence` | Only from a **succeeded `hostaway.list_offline_charges` read**, `external_ref` = the read's reservationId, `status 'listed'`, `observed.matchingChargeCount` = `len(matchingChargeIds)` | The DB cannot tell a complete read from an incomplete one. The worker must not record evidence from an incomplete read (§6). |
| `claimNextOperation` fences | CAPTURE (0007), VOID / CANCEL (0009). **No fence for `record_offline_charge`** | A generic or opId claim could take a recording in any intent state. The implementation slice needs a paid-state recording fence (§5.1). |
| `publicStatus` | `payment_captured` and `confirmed` → "confirmed"; `reconciliation_required` → "under_review" | A case-only alert keeps the guest-visible status "confirmed". |

**Conclusion:** the existing case-only path (`markUnknown` → `OFFLINE_CHARGE_OUTCOME_UNKNOWN`, intent untouched, then owner `admin_resolve_operation`) can be reused as is.
- **No new DB, helper, planner or E3 code** is needed for the bookkeeping alert.
- The I7 risk is purely a **routing rule** for the future worker: never call `escalateOperatorPlan` or send `ESCALATE` for a recording, and never produce `OFFLINE_CHARGE_FAILED`.
- That is ordinary internal routing, **not** an owner decision.
- The only DB change the later implementation needs is the claim fence in §5.1.

---

## 3. B1: official public documentation (no credentials)

**Sources, read 2026-11-03.** The API reference is a client-rendered page; it was read in a browser without signing in.
- API reference: `https://api.hostaway.com/documentation`, sections:
  - `#guest-charge-object`
  - `#guest-charge-transaction-object`
  - `#get-guest-charges-list`
  - `#get-charge-object`
  - `#create-offline-charge`
  - `#update-offline-charge`
  - `#refund-offline-charge`
  - `#get-auto-payment-rules`
  - `#authentication`, plus the Introduction (standard response) and the Changelog.
- Support: "Processing Payments Manually (Online & Offline Charges)", https://support.hostaway.com/hc/en-us/articles/360007411294-Guest-Payments-Taking-Payments-Manually.
- Support: "Automating Guest Payments (General Rules)", https://support.hostaway.com/hc/en-us/articles/360036454133-Guest-Payments-Auto-payments.
- Neither support article shows an updated date in its fetched text.

### 3.1 Create offline charge, `#create-offline-charge`

- **[DOC]** `POST https://api.hostaway.com/v1/guestPayments/charges/{reservationId}`, with a charge object in the body.
  - Every field except `description` is mandatory: `title`, `amount`, `paymentMethod`, `status`, **`scheduledDate`**.
  - `status` ∈ {`awaiting`, `paid`}.
  - `paymentMethod` ∈ {`credit_card`, `vcc`, `cash`, `paypal`, `venmo`, `bank_transfer`, `bank_check`, `ota`, `other`}. **`credit_card_online` is not accepted here.**
- **[DOC + EX]** The response is "Created charge object or error response".
  - The documented example response includes: `id`, `listingMapId`, `reservationId`, `autopaymentId: null`, `type: "charge"`, `title`, `description`, `currency: "USD"`, `paymentMethod`, `amount`, `capturedAmount: 0`, `status: "paid"`, `paymentProvider: "offline"`, `scheduledDate`, `chargeDate`, `isManual`, `transactions: []`.
  - So the response shape **is documented by example**. The earlier blanket "response undocumented" claim is withdrawn.
- **[EX inconsistency]** The example request sends `"description": "optional field"`, but the example response shows `"description": null`. **The marker must not depend on `description` persisting** (§4.4).
- **[DOC]** `scheduledDate` is a datetime ("YYYY-MM-DD HH:MM:SS" in the example). The Introduction says all time values are UTC.
- **[INF]** For a record with status `paid`, the capture instant in UTC is the natural value.
- **[DOC] Currency.** The request has **no currency field**. The charge object reports `currency`.
  - **[INF]** The currency is taken from the reservation (or account). E7.4b **must not invent a currency input.** It sends none and verifies the response currency against `intent.price.currency`.
- **[DOC] Monetary units.** `amount` is a float ("Amount of charge"). The example uses major units (100; the reservation example `totalPrice: 267`).
  - **[INF]** Major units with 2 decimals for MXN/USD, the same convention our accepted reservation adapter already uses (`minorToAmount` / `amountToMinor`, at most 2 fraction digits, exact round trip).
  - **[UNV]** Exact echo of non-integer amounts live.
- **[DOC] Auth.** `#authentication` and the "Working with authorization token" section use `Authorization: Bearer <token>` for all endpoints.
  - **[EX inconsistency]** The create, update and refund cURL examples show a header `jwt;` instead; the list and get examples show Bearer.
  - **[INF]** Bearer is the documented scheme; `jwt;` looks like an example artefact.
  - **[UNV]** Whether the create endpoint accepts Bearer live (§8, E1).

### 3.2 Charge vs transaction objects

- **[DOC]** A **guest charge** (`#guest-charge-object`) is the per-reservation ledger item. It has `type` charge / preAuth / refund, `paymentProvider` stripe / braintree / authorizeNet / **offline**, `paymentMethod`, `status`, `isManual` and a `transactions` array.
- **[DOC]** A **guest charge transaction** (`#guest-charge-transaction-object`) is a provider payment record. Its `paymentProvider` is stripe / braintree / authorizeNet, it has `balanceTransactionId`, and it exists for online charges.
- **[EX]** An offline charge has `transactions: []`.
- **Rule:** E7.4b matches **charges only, never transactions**.

### 3.3 Get guest charges list, `#get-guest-charges-list`

- **[DOC] Query parameters**
  - `reservationId` (single int) and `reservationIds` (int list) combine as **AND**. Ids from another account match nothing and look identical to non-existent ids.
  - `statuses[]` and `types[]` are **bracket-only**: a single value without brackets **is ignored**.
  - `paymentMethods` (list).
  - `limit`: default 100, **cap 500**.
  - `offset`, `sortBy` / `sortOrder`.
  - Date pairs may span at most 60 days.
- **[DOC] Response:** `count` = total matching, ignoring limit and offset.
- **[DOC] Default order:** without `sortBy`, upcoming charges come first ascending, then past charges descending (**not** newest-first). `sortBy=chargeDate&sortOrder=desc` is suggested for history.
- **[DOC] Changelog 2026-10-02:** `reservationIds` "now filters". Before, it was **silently ignored** and returned the account's whole charge history with HTTP 200. Malformed ids now fail with 400.
  - **[INF]** Old behaviour shows that filters can fail silently. A worker must **verify every returned row's `reservationId`** and must not trust the filter.
- **[EX] Envelope:** the list example envelope shows `status`, `result`, `count`, `offset`. The Introduction's standard envelope also lists `limit`, `page`, `totalPages`.
- **[UNV]** List ordering stability under concurrent writes, read-after-write lag after a create, and whether `count` is exact under concurrent inserts.

### 3.4 No recording operation can collect money

- **[DOC]** Create offline charge accepts only offline methods; `credit_card_online` is excluded.
- **[EX]** The response shows `paymentProvider: "offline"` and `transactions: []`.
- **[DOC]** The refund endpoint states that offline charges and their refunds are records of money moved **outside** Hostaway.
- **Support (Processing Payments Manually), [DOC-support]:** offline methods are ones where "you have locally managed the transactions". `Due` offline charges are marked `Paid` manually.
- **[INF]** Creating an offline charge with `status: "paid"` records a payment and does not move money.
- **E7.4b rule:** always `status: "paid"`, never `awaiting`.
  - An `awaiting` record would show a due balance.
  - E7.4b never calls Update or Refund offline charge.

### 3.5 Auto-payment interaction: duplicate-collection risk (integration prerequisite)

- **[DOC-support] Automating Guest Payments:** auto-payment templates schedule charges **per channel and listing** for **new** reservations. Amounts can be "the remaining unpaid balance of the reservation". Templates exist for "Hostaway Direct and/or Booking Engine".
  - The article also says: if a reservation is created via the Public API **with offline charges on it**, "our system will not automatically generate any charges".
- **[CODE]** Our reservation create (`hostaway-reservations.js`) uses `channelId 2000` (direct) and sends **no** offline charge. The recording happens later, after capture.
- **[INF] Risk:** if an auto-payment template applies to channel 2000 or our listings, Hostaway may schedule charges for our API-created reservation in the window before recording, or on a remaining-balance basis.
  - An online auto-charge would need a guest card on the reservation; we send none [UNV].
  - The guest-facing balance or payment link could still show money due before the recording exists [UNV].
- **[DOC]** `remainingBalance` on the Reservation object is the "difference between reservation total price and amount already paid by guest" (with `includePayments=1`). **[INF]** A paid offline record reduces it.
- **Prerequisite, before any live recording:** the owner confirms that **no auto-payment template applies** to the direct channel / our listings, or removes that scope.
  - Evidence route: documented read-only `GET /v1/guestPayments/autoPayment`, or a dashboard check.
  - **No account or config change is made now.**

---

## 4. Contract design (for a later, separately authorized implementation)

### 4.1 Fences, checked in the claim transaction, intent first

A recording row may be claimed only if **all** of these hold at claim time:
1. The intent is `payment_captured` (paid state), and its `captured_minor = final_total_minor` (the DB already enforces `captured_exact`).
2. The intent is in the configured scope (listing allow-list; optional intentId) and `hostaway_reservation_id` = `payload.reservationId`.
3. The row is the **latest** recording, and its key attempt = `offlineChargeAttempts + 1` = **1**. E7.4b dispatches **only attempt 1** (§4.2).
4. The row is `pending` and was never dispatched (`dispatched_at IS NULL`).
5. The worker holds the intent work lease (`intent_work`), as the other E7 workers do.
6. The intent version decided at plan time is re-checked inside the claim (version fence).

Lock order is intent FOR SHARE, then the row FOR UPDATE, as in `claimNextOperation`. No lock is held across provider I/O.

### 4.2 At most one non-idempotent dispatch; no resend

- Exactly **one** POST per intent, ever, by automation.
- After a claim, any of the following leads to `completeOperation(outcome_unknown)`, i.e. `markUnknown` → case. **Never a resend, never a new attempt row.**
  - a send whose outcome is not proven;
  - a timeout, network error or 5xx;
  - a malformed or mismatched reply;
  - a confirming read that disagrees.
- Lease expiry reaches the same state through `recoverExpiredOperations`.
- The worker **never** claims a recording with attempt > 1, including one E3 might queue after an owner-resolved `failed_definite`.
  - Such a row stays pending for the owner. Recording again after a verified absence is the owner's manual action (§7, Q2).

### 4.3 Preflight (BEFORE the claim; the row is still pending)

[CODE] `claimNextOperation` sets `dispatched_at` at claim time (operations.js l.97), and no API returns a claimed row to pending. So the preflight runs **before** the claim, under the intent work lease, while the recording row is still `pending` and undispatched.

Run a **complete** list read for the reservation (§6). Then:
- **Complete, zero charges carrying our marker:** proceed to dispatch.
- **Any charge with our marker:** do **not** dispatch → `outcome_unknown` → case. A prior recording exists; the owner reconciles.
- **Any paid charge of the same amount without our marker** (for example, the owner already recorded it by hand): do **not** dispatch → case.
- **Incomplete or untrusted read:** do not claim. The row stays pending and undispatched; retry the preflight later, bounded.
  - After N failed preflights → case-only alert (§5 item 5).

**Crash window:** the preflight does not remove the window between the POST and its recorded result. That window is covered only by `outcome_unknown` + case.

### 4.4 Request binding and marker

- **Body:**
  - `title` = `"maraVilla direct payment " + marker`, with `marker = "mv-och:" + intentId + ":1"`. The title is the only documented, example-persisted text field.
  - `description` = same marker. Optional, and **not relied upon** (the example shows it as null).
  - `amount` = `minorToAmount(capturedMinor)`.
  - `paymentMethod` = owner choice (§7, Q1).
  - `status: "paid"`.
  - `scheduledDate` = the capture instant in UTC.
- No currency field.
- Title length limit [UNV]: the marker is ≤ 60 characters and the title ≤ 100 characters as a conservative cap.

### 4.5 Reply validation (success candidate)

The reply must satisfy all of the following:
- `status: "success"`;
- `result.id` is a positive integer;
- `result.reservationId` = our reservation;
- `type = "charge"`;
- `paymentProvider = "offline"`;
- `status = "paid"`;
- `amountToMinor(result.amount) = capturedMinor` exactly;
- `result.currency.toUpperCase() = intent.price.currency`;
- `paymentMethod` = the configured value;
- `title` contains the marker.

Any failure → `outcome_unknown` (case). **A reply alone is not success** (next section).

### 4.6 Confirming read (still under the recording lease)

1. Queue and execute a `hostaway.list_offline_charges` read for the reservation.
2. Require a **complete** read (§6).
3. Exactly **one** charge must carry the marker, and it must match the reply's `id`, amount, currency, `status paid`, `type charge` and `paymentProvider offline`.
4. Only then:
   - record evidence (`matchingChargeCount 1`, `matchingChargeIds [id]`, plus amount, currency, status and marker in `observed`);
   - `completeOperation(succeeded, resultRef = id)`;
   - apply `OFFLINE_CHARGE_RECORDED {chargeId: id}`, which the `applyEvent` guard checks against `result_ref`;
   - → `confirmed`.

| Read outcome | Action |
|---|---|
| Complete, exactly 1 match, all fields match the reply | success, as above |
| Complete, **0** matches (the reply said created) | `outcome_unknown` → case. Possible lag [UNV]; never treated as absence. |
| Complete, ≥2 matches | `outcome_unknown` → case (duplicate) |
| Complete, 1 match but with a different id, amount, currency or status | `outcome_unknown` → case (mismatch) |
| Incomplete or untrusted | `outcome_unknown` → case. **No evidence row is recorded from an incomplete read.** |

If the lease expires before completion, `recoverExpiredOperations` produces `outcome_unknown` → case.

### 4.7 Account / binding verification

- The reservation id comes only from the intent's DB-recorded Hostaway reservation id (set from an evidence-verified create). Never from a request or the guest.
- Every returned charge must carry that `reservationId` and the intent's `listingMapId` [DOC: listingMapId is copied at charge creation and not updated after a listing move]. Treat a listing mismatch as untrusted.
- Ids from another account match nothing [DOC], so a wrong-account token reads as "zero matches". **This is why zero matches is never proof of absence by automation.**
- The protected E4 ids (70636076 / 71045356 / 71072615 / 71081885) are refused with the existing `isProtectedReservationId` guard [CODE: reservation-worker.js l.71, compensation-proof.js l.24].

### 4.8 Crash windows

| Crash point | Persisted state | Result |
|---|---|---|
| Before claim (including during preflight) | pending, undispatched | Later preflight + claim; nothing was sent |
| After claim, before POST | in_flight, `dispatched_at` set at claim [CODE operations.js l.97] | Lease expiry → `outcome_unknown` → case. Conservative: the send may or may not have happened. |
| After POST, before reply validation | in_flight | Same → case |
| After reply, during the confirming read | in_flight + possibly a succeeded read | Same → case. Evidence already recorded helps the owner resolve (`admin_resolve_operation` succeeded with API count 1). |
| After `completeOperation(succeeded)`, before `RECORDED` | row succeeded | A future scoped recovery pass (recordings only, paid state only): `planOfflineCharge` → `OFFLINE_CHARGE_RECORDED`. **Never escalate on operator plans.** |
| After `RECORDED` | `confirmed` | Done |

### 4.9 Exhaustion preserves paid truth

- E3's `OFFLINE_CHARGE_UNRECORDED` (10 failed_definite) is unreachable while `definite_refusal_codes` is empty. E7.4b adds no codes.
- Bounded preflight failures and read exhaustion end in a **case-only** alert, never `ESCALATE`.
- The intent stays `payment_captured` and public "confirmed".

---

## 5. Changes the later implementation slice would need (proposal only)

1. **DB claim fence for `hostaway.record_offline_charge`**, like 0007 / 0009. A migration enforces §4.1 items 1–4 on every claim path. This is the only schema change.
2. **A new worker module** (offline-charge worker) with an injected Hostaway executor (fake in tests), scoped recovery (recordings only, `payment_captured` only), and maintenance phase-guarded with `intentStates: ['payment_captured']`.
3. **An adapter** for create / list with doc-labelled request and response validation, Bearer auth (pending E1), and amount conversion via the existing helpers.
4. **No E3, planner, recovery-helper or admin-function change.**
   - The worker intercepts operator plans for recordings (no `escalateOperatorPlan`).
   - The case-only alert reuses `markUnknown`.
5. **Open design point:** a case-only alert for an **undispatched** row whose preflight is exhausted. `markUnknown` applies only to claimed rows.
   - Options:
     - (a) claim, then immediately `completeOperation(outcome_unknown, errorCode "PREFLIGHT_NOT_SENT")` without sending. The case evidence carries `errorCode`. Note that the claim stamps `dispatched_at` even though nothing was sent, so "not sent" lives only in the error code and the worker's own record.
     - (b) leave the row pending and rely on monitoring.
   - **Recommendation:** (a). It reuses existing entry points and yields a durable owner case. The owner's later `failed_definite` resolution still needs the API + dashboard absence evidence.
   - The same route covers the preflight "marker found / same-amount paid charge found" outcomes in §4.3.

---

## 6. Complete-read definition (shared by preflight, confirm and evidence)

A list read is **complete and trusted** only if **all** of these hold:
- HTTP 200 and `status = "success"`;
- `result` is an array and `count` is an integer;
- request: `reservationId=<id>` (singular, documented), `limit=500`, no offset, no status or type filters (filter client-side);
- `count ≤ 500` and `result.length = count` (a single page holds every matching row);
- every row has `reservationId` = ours and `listingMapId` = ours;
- ids are unique positive integers (no duplicates);
- every row has the documented fields used for matching (`id`, `type`, `title`, `amount`, `currency`, `status`, `paymentProvider`).

Anything else is **incomplete or untrusted**:
- record no evidence;
- never infer absence;
- the read row is completed as a read failure (retryable, bounded by the read retry class).

`count > 500` → untrusted (it cannot happen for one stay [INF]; the cap exists anyway). Paging with offset is not used, because the default order is not stable newest-first [DOC] and concurrent inserts could shift pages [UNV].

**Absence by automation:** a complete zero-match read is recorded as evidence **only** for the owner. The DB's `failed_definite` resolution additionally requires an owner dashboard check [CODE 0005]. Automation never declares a recording failed.

---

## 7. Owner questions (only those genuinely needed)

- **Q1. `paymentMethod` for a Stripe-collected payment** (this affects how payments appear in the owner's Hostaway reports).
  - Options: `credit_card` (offline card) or `other`. Not `credit_card_online`: it is not accepted by the endpoint and implies Hostaway's own processor.
  - **Recommendation: `credit_card`.** The guest paid by card; the processor was external (Stripe, outside Hostaway).
  - Choose `other` if the owner's finance reports should not mix these with locally swiped cards.
- **Q2. After the owner proves a recording absent** (`admin_resolve_operation` failed_definite), E3 queues attempt 2.
  - **Recommendation:** automation never sends attempt > 1. The owner records manually in the dashboard and resolves.
  - Confirm, or authorize automatic attempt 2 **only** after an owner-verified absence.
- **Q3 (prerequisite, not a design choice):** confirm that no auto-payment template covers the direct channel (2000) / our listings (§3.5), before any live recording.

The following are **internal routing, not owner decisions**:
- case-only alert vs escalation;
- no retry on ambiguity;
- the marker format;
- the complete-read rules.

---

## 8. Remaining evidence (live / account), for a later consolidated live approval package; not requested now

| # | Evidence | Why |
|---|---|---|
| E1 | Create offline charge accepts `Authorization: Bearer` (the docs show `jwt;` in examples) | Auth scheme for the write |
| E2 | Live create reply shape matches the doc example (`id`, `reservationId`, `currency`, `status`, `paymentProvider offline`, title persisted, description persisted or not) | Reply validation §4.5 |
| E3 | Amount echo for 2-decimal values; currency = reservation currency (MXN) | Exact money binding |
| E4 | List by `reservationId` returns the new charge immediately (read-after-write lag), `count` exact | Confirming read §4.6 |
| E5 | Title length limit / marker persistence | Marker §4.4 |
| E6 | Auto-payment templates in scope for channel 2000 / listings (`GET /v1/guestPayments/autoPayment`, read-only), and reservation `remainingBalance` after recording | Duplicate-collection prerequisite §3.5 |

Each item would be gathered in one owner-approved, bounded live step on a non-protected test reservation. That step is not requested here.

---

## 9. Test matrix for the later implementation (fake provider + disposable local PG)

| # | Scenario | Expected |
|---|---|---|
| T1 | Happy path: complete preflight with 0 matches; valid reply; confirming read with exactly 1 match | row succeeded, evidence count 1, `OFFLINE_CHARGE_RECORDED` → confirmed; exactly 1 POST |
| T2 | Fence: intent not `payment_captured` (each other state, including `reconciliation_required`) | not claimed, 0 POST |
| T3 | Fence: reservation id mismatch / listing out of scope / attempt > 1 / row already dispatched | not claimed, 0 POST |
| T4 | Version fence: concurrent ESCALATE commits between plan and claim (observed lock wait) | not claimed |
| T5 | Preflight finds our marker / a same-amount paid charge | no POST; case-only (claim + `outcome_unknown` with error code `PREFLIGHT_NOT_SENT`, §5 item 5); intent `payment_captured` |
| T6 | Preflight incomplete (`count` ≠ length, foreign `reservationId` row, duplicate ids, `count > 500`, non-success envelope) | no claim, no POST, no evidence, row stays pending; after the bound → case-only (`PREFLIGHT_NOT_SENT`) |
| T7 | POST timeout / 5xx / network error | `outcome_unknown` + `OFFLINE_CHARGE_OUTCOME_UNKNOWN` case; intent unchanged ("confirmed"); no 2nd POST on any later step |
| T8 | Reply mismatch: amount, currency, type, provider, status, missing id, missing marker | case; no RECORDED |
| T9 | Confirming read: 0 / ≥2 / 1-mismatched / incomplete | case; evidence only for complete reads; no RECORDED |
| T10 | Crash after claim and after POST (lease expiry via phase-guarded maintenance) | case; no resend |
| T11 | Crash after succeeded, before RECORDED → scoped recovery | RECORDED once; operator plans (`ID_MISSING` / `OUTCOME_UNKNOWN`) **never** escalate |
| T12 | Owner resolves unknown as succeeded (existing admin function, API evidence count 1) | recovery applies RECORDED → confirmed |
| T13 | Owner resolves failed_definite → E3 queues attempt 2 | worker does not claim it (pending Q2) |
| T14 | `publicStatus` remains "confirmed" through every case path; no ESCALATE / void / cancel / refund rows created | asserted per test |
| T15 | Protected reservation ids | refused, 0 POST |
| T16 | Amount conversion edge cases (x.x0, x.05, large) round-trip exactly | exact |
| T17 | Request body: no currency field, `status "paid"`, the configured `paymentMethod`, UTC `scheduledDate`, marker in the title | asserted on the fake |

---

## 10. Go / no-go

| Blocker | Resolved by docs? | Remaining |
|---|---|---|
| B1 endpoint + body fields | **Yes [DOC]**: path, mandatory fields (incl. `scheduledDate`), status / paymentMethod values | live echo E2 / E3 |
| B1 response shape | **Documented by example [EX]** (`id`, `reservationId`, `currency`, `status`, `paymentProvider offline`) | live confirmation E2 |
| B1 currency | **Yes**: no currency input; verify the response currency [DOC + INF] | E3 |
| B1 units / precision | Float major units [DOC / EX]; the existing 2-decimal conversion | E3 |
| B1 auth | Bearer documented; examples inconsistent | E1 |
| B1 list / filter / pagination | **Yes [DOC]**: `reservationId` filter, `count`, `limit` cap 500, order rules, past silent-filter bug | read-after-write E4; complete-read rule §6 handles the rest |
| B1 marker persistence | Title persists in the example; description unclear | E5 |
| No money collection by recording | **Yes [DOC + INF]**: offline-only methods, provider offline, status paid | — |
| Duplicate-collection (auto-payments) | Risk identified [DOC-support + INF] | **Q3 / E6, prerequisite** |
| I7 bookkeeping escalation | **Resolved by design**: reuse `markUnknown` case-only; the worker never escalates recordings | — (internal routing) |
| paymentMethod label | — | **Owner Q1** (recommend `credit_card`) |
| Attempt > 1 policy | — | **Owner Q2** (recommend: never automatic) |

**Verdict: GO for a minimal offline implementation slice. NO-GO for any live recording.** The implementation slice requires separate root authorization; the live recording requires Q1–Q3 and E1–E6 in one consolidated owner-approved live package.

**Minimal next implementation slice** (offline, fake provider, disposable PG):
- migration: the recording claim fence (§5.1);
- the offline-charge worker + adapter with doc-labelled validation;
- the complete-read helper;
- tests T1–T17.

It has no live calls and no E3, planner or admin changes. `paymentMethod` is a config value, defaulting to `credit_card` pending Q1.
