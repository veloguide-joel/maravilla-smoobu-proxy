# E7.4 compensation and bookkeeping workers — contract (DESIGN ONLY, revised 2026-11-03 after the root review of 727b9f1)

- **Status:** DESIGN ONLY, for root review. No executor, worker, adapter, schema or E3 change exists for E7.4.
- **Root decisions applied in this revision:** both workers accepted in principle; B2 = NO automatic resend; the B4 gate as specified; B5 limitation retained; B1 = doc investigation may proceed offline; B3 verified against the official Stripe docs. Corrections (1)–(4) are applied in §3.1, §3.2, §7 and §1. §10 lists what changed.
- **Base:** `c78bcc308f32c51a23db36d93717e81564fd0f3b` (E7.3b). Root KEPT it OFFLINE ONLY on 2026-11-03, after the HOLD on 479022a.
- **Proposed branches:** this doc on `feature/e7-compensation-contract`. Later, after root acceptance, two implementation slices from the accepted contract commit:
  - `feature/e7-cancel-void-worker` (E7.4a);
  - `feature/e7-offline-charge-worker` (E7.4b, BLOCKED; see §8).
- **Frozen:** all earlier E7 branches, owner checkout, E4 (10cedeb) and historical journals.
- **Source basis:** the actual code at the base commit, cited in §2.

## 1. Two workers, because the truth and the risk differ

| | **E7.4a cancel/void cleanup** | **E7.4b paid-booking offline-charge recording** |
|---|---|---|
| Intent states | `reservation_failed` (void only), `capture_failed` (void + cancel legs) | `payment_captured` only |
| Money truth | no funds were captured; the void RELEASES the held card authorization (it is not a refund), and the reservation (if any) must be cancelled. No captured-funds refund is ever executed | money WAS taken; the booking stays honestly paid whatever happens to the bookkeeping |
| Provider writes | Stripe void (PaymentIntent cancel), Hostaway reservation cancel | Hostaway offline-charge record (non-idempotent bookkeeping) |
| Harm of a duplicate write | a convergent target state ("canceled" / "cancelled"); no captured funds are moved or returned (a void only releases a hold) | a DOUBLE financial record in Hostaway |
| Readiness | adapter shapes partly verified (E4 live cancel PUT); void adapter not built | API shape, dedupe marker and list read are UNVERIFIED: blocked |

Excluded everywhere: refund, create, capture, notifications (`guest.notify`, `alert.owner` rows stay queued), routes, cron, frontend, default SDKs and network adapters. Executors are injected; production is refused.

## 2. Actual E3 / DB behaviour these workers must live with (base c78bcc3)

**E3 routes** (`lib/checkout/intent-state.js`):
- `reservation_failed`: VOID_SUCCEEDED → `authorization_released`; VOID_OUTCOME_UNKNOWN (reads); VOID_FAILED; RECONCILED_STILL_AUTHORIZED; RECONCILED_AUTHORIZATION_GONE.
- `capture_failed`: two legs via `settleLeg`. CANCELLED only when BOTH `reservationCancelled` and `authorizationSettled` are true.
- RECONCILED_CAPTURE_SUCCEEDED in `capture_failed` → ESCALATE `CAPTURED_DURING_CANCELLATION`.

**Rows** (`effectToOperation`):
- void: `reconcile_first`, provider key `voidKey(intent, pi, attempt)`.
- cancel: `reconcile_first`, `hcancel:{intent}:{rid}:{attempt}`, payload `{reservationId, cancelledBy: "host", attempt}`.
- offline charge: `non_idempotent`, `och:{intent}:{n}`.

**DB guards:**
- 0004 `intents_safety_guard`: `settlement_reservation_cancelled` needs a succeeded cancel row AND evidence `kind = hostaway_reservation`, `external_ref` = the reservation id, `status = cancelled`.
- 0004 `intents_safety_guard`: `settlement_authorization_settled` needs `authorization_settled_for()`.
- `reservation_failed` → `authorization_released` requires `authorization_settled_for()`.
- `capture_failed` → `cancelled` requires both legs.
- 0004 `authorization_settled_for(intent, pi)` is TRUE if a void row is `succeeded`, OR the latest PI evidence status ∈ {canceled, requires_payment_method}.
- 0004 `settle_operation_from_evidence`:
  - void → `succeeded` on canceled; `failed_definite` (`RECONCILED_NOT_APPLIED`) on requires_capture or succeeded;
  - cancel → `succeeded` on cancelled; `failed_definite` on found_active;
  - capture → `failed_definite` on requires_capture / canceled / requires_payment_method.
- 0004 `AMBIGUOUS_RESULT_NOT_DEFINITE`: a reconcile_first write cannot be set `failed_definite` with a timeout/5xx/429/lease code.
- 0003 `definite_refusal_codes`: the CHECK allows only create / offline-charge op types, and NO rows are inserted. A void or cancel can never be catalogued as definitely refused, and no offline-charge refusal is catalogued.

**Planner** (`recovery-plan.js`):
- planVoid / planCancel as written.
- planOfflineCharge: unknown → operator `OFFLINE_CHARGE_OUTCOME_UNKNOWN`; never re-recorded.

### 2.1 Incompatibilities flagged (no shared change proposed here)

- **I1. A still-authorized snapshot is not proof that the capture stopped.** The capture-unknown branch of RECONCILED_STILL_AUTHORIZED, at or after `captureBefore`, enters `capture_failed` (`AUTHORIZATION_EXPIRED`) and queues void + cancel. Also, `settle_operation_from_evidence` marks an unknown capture `failed_definite` from a `requires_capture` snapshot. Both treat a snapshot as "capture stopped", which root ruled insufficient.
  - E7.3b never feeds this, because it intercepts first. Another actor could.
  - E7.4a therefore runs its own capture-resolution gate (§3.1) and never trusts a capture row's `failed_definite`/`RECONCILED_NOT_APPLIED` as resolution.
- **I2. E3 re-emits blind void and cancel retries.** RECONCILED_STILL_AUTHORIZED in `reservation_failed`/`capture_failed` re-emits a void with a NEW key. RECONCILED_RESERVATION_STILL_ACTIVE re-emits a cancel with a new attempt.
  - E7.4a intercepts both into a durable owner case by default (§5). It never applies those planner events.
- **I3. VOID_FAILED in `reservation_failed` re-emits the void with the SAME provider key** (attempt 1 default). Per Stripe's idempotency rules this replays the cached result. It is useless rather than harmful.
  - Moot in practice: a definite void refusal cannot be produced (no catalogue, I-DB above).
- **I4. A succeeded void row alone counts as `authorization_settled_for`.** So the worker must mark a void row `succeeded` ONLY after a confirming PI read with the full `piCanceledProofV3` (§3.1, §4).
- **I5. `requires_payment_method` also counts as settled.** That is acceptable for a manual-capture PI, but E7.4a requires the full `piCanceledProofV3` (exactly `canceled`) for its own success and treats `requires_payment_method` as inconclusive → owner case.
- **I6. OFFLINE_CHARGE_FAILED in E3 re-emits a NEW non-idempotent record row** (up to 10). Because the catalogue is empty, no worker can legitimately produce it. E7.4b must keep it so: every failure stays unknown → owner case.

## 3. E7.4a preconditions (all from executed, persisted reads; none from memory or requested fields)

### 3.1 Capture-resolution gate (BLOCKS any void or cancel), v1

The gate classifies the intent's COMPLETE capture history: every `stripe.capture_payment_intent` row of the intent, in any state, together with `intents.capture_attempts`. It is never an "every row is fine" loop over a possibly empty set. Each class is explicit, and anything not listed is refused (owner case).

| Class | Exact condition | Decision |
|---|---|---|
| **Z: no capture ever** | zero capture rows AND `capture_attempts = 0` | PASS. The normal `reservation_failed` void path, and `capture_failed` entered by `afterReservation` when `captureBefore` had already passed. No capture request can exist: one is only emitted together with `capture_attempts + 1` (E3 `afterReservation` / `RECONCILED_STILL_AUTHORIZED`). |
| **P: initial row never sent** | exactly ONE capture row AND `capture_attempts = 1` AND row `state = pending` AND `attempts = 0` AND `dispatched_at IS NULL` | PASS. The DB proves it never left the outbox:<br>• 0004 `external_operations_guard` creates rows `pending` with `attempts = 0`;<br>• `attempts` may never decrease;<br>• a `reconcile_first` row may never move `in_flight` → `pending`;<br>• the only sender path (`claimNextOperation`) sets `in_flight`, `attempts + 1` and `dispatched_at` atomically.<br>The 0007 `CAPTURE_FENCE` makes the row unclaimable outside `reservation_confirmed`, and E3 has no route from `reservation_failed` / `capture_failed` back to `reservation_confirmed`. The row stays pending as audit; this worker never claims it. |
| **D: sent or uncertain** | any capture row with `attempts > 0` or `dispatched_at` set, in ANY state, including `failed_definite`, `succeeded`, `outcome_unknown`, `escalated`, `in_flight`, and `RECONCILED_NOT_APPLIED` | PASS only with a fresh **canceled proof** (below); otherwise owner case. Pending / in-flight / unknown while the PI shows `requires_capture` can never pass. |
| **M: more than one capture row, or `capture_attempts > 1`, or `capture_attempts` disagreeing with the rows** | | OWNER CASE in v1, even with canceled evidence. History reconciliation is deferred. |

- **No error-string route in v1 (correction 2).** A `failed_definite` capture row is NOT trusted as a send-time definite refusal on its labels (`attempts = 1`, `error_code ≠ RECONCILED_NOT_APPLIED`). The 0003 `definite_refusal_codes` CHECK does not even allow the capture op type and contains no rows. The 0004 guard only rejects a few ambiguous codes; it does not prove that a refusal was definite. So class D applies, and only canceled evidence unblocks it.
- **Canceled proof** (`piCanceledProofV3`, narrower than the shared `piGoneProof`, which accepts any `canceled` with nothing received). All of the following must hold:
  - a v3 PI evidence row from an executed, account-verified read: the exact configured test account, `livemode false`;
  - read selector = `externalRef` = the intent's (immutable) PaymentIntent;
  - `status` exactly `canceled`; `capture_method manual`; metadata intent and payment attempt equal to the intent's completed bound attempt;
  - `amount` = price, `currency` = price currency;
  - `amount_received = 0`, `amount_capturable = 0`;
  - latest charge expanded and bound to the same PI, `captured false`, `amount_captured 0`, `amount_refunded 0`, `livemode false`;
  - observed ≥ the latest capture row's `dispatched_at` (when one exists) AND ≥ 2 min after it (the 0004 settle rule), not in the future, ≤ 5 min old at use.
  
  `requires_payment_method` is never accepted, even though the DB's `authorization_settled_for` accepts it (I5).
  - **Why it is definitive:** a canceled PaymentIntent cannot be captured afterwards (the root-checked Stripe capture contract for E7.3: capture requires `requires_capture`, https://docs.stripe.com/api/payment_intents/capture), and `amount_received 0` with an uncaptured charge shows nothing was taken before.
- **What the canceled proof authorizes, and its exact linkage:**
  - **No capture row is touched by this worker.** An `outcome_unknown` capture row stays for the accepted planner and the owner; this worker never settles or completes it, and never applies a capture event.
  - **Void leg:** NO void is sent (the authorization is already gone). In `capture_failed`, this worker applies `RECONCILED_AUTHORIZATION_GONE`, which E3 maps to `settleLeg("authorizationSettled")`. The DB guard requires `authorization_settled_for()`, which the same evidence satisfies.
    - The event id is `cw4-authgone:{intentId}:{evidenceId}`.
    - The in-transaction fence re-checks: the evidence id belongs to the intent; the read type is PI read; the PI is right; status `canceled`; it was observed after the latest capture `dispatched_at`; plus version, state and leg not yet settled.
    - In `reservation_failed`, `RECONCILED_AUTHORIZATION_GONE` → `authorization_released` under the same fence.
    - The pending void row (never dispatched) stays as audit and is never sent once the leg is settled.
  - **Cancel leg:** may proceed. The canceled-evidence id is part of the cancel plan's snapshot and is re-checked in the pre-send check and in the `RESERVATION_CANCELLED` event transaction (same conditions).
- **In class Z / P with the PI `requires_capture`:** the void (§3.2) is the only way to settle the authorization, and the cancel may proceed under the same gate.

### 3.2 Void (reservation_failed / capture_failed)

- **Account:** the exact test account, verified.
- **PaymentIntent:** v3 PI evidence fresh (≤ 5 min, after the state was entered, not in the future) showing `requires_capture`, with the full `piStillAuthorizedProof` + v3 charge bindings (`captured: false`, `amount_captured` 0, `paid: true`).
- **Row:** the single current void row: pending, never dispatched, attempt 1, key = `voidKey(intent, pi, 1)`.
- **Request (fixed):** `paymentIntents.cancel(pi, {}, {idempotencyKey})`. No `cancellation_reason` from callers, no other parameters.
- **Already canceled** (the full `piCanceledProofV3`, NOT bare `piGoneProof`) → do not send; apply the linked event of §3.1.
- **Official Stripe contract** (root-verified 2026-11-03: https://docs.stripe.com/api/payment_intents/cancel, https://docs.stripe.com/api/idempotent_requests):
  - a PaymentIntent in `requires_capture` is cancelable (including Checkout-created ones), and the reply is a PaymentIntent;
  - an already-canceled or non-cancelable PaymentIntent returns an error;
  - POST accepts an `Idempotency-Key`. v1 caches the result once execution has begun, even a 500. Keys may be pruned after at least 24 h. A concurrent conflict is not cached.
  
  Empty params are a conservative subset. An error reply is never success or definite failure: it means unknown → reads.
- **Already captured** (`succeeded`) → never void. ESCALATE `CAPTURED_WHILE_VOIDING` / E3 `CAPTURED_DURING_CANCELLATION`. No refund.

### 3.3 Hostaway cancel (capture_failed only)

- **Identity:** a fresh by-id read with the full identity INCLUDING the ref (by-ref fallback when not echoed), the exact listing, dates, amount and currency, status `new`. Anything else (incl. `modified`) → owner case.
- **Protected ids:** the historical ids 70636076 / 71045356 / 71072615 / 71081885 are refused at every path.
- **Row:** the single current cancel row: pending, never dispatched, attempt 1, payload rid = the intent's immutable reservation id (0001 guard).
- **Stay date (proposed, root to confirm, B4):** `from` must be strictly after today in the listing time zone, otherwise owner case. The guest may already be in the house.
- **Request (fixed, the E4 live-verified shape):** `PUT /v1/reservations/{rid}/statuses/cancelled`, body exactly `{cancelledBy: "host"}`. The pure builder is added in E7.4a. No other path.
- **Ordering:** the cancel runs only after §3.1 holds. It may run before or after the void leg; both legs are independent but share the gate.

## 4. Success requires a confirming read (a reply is never enough)

- **Void:** positive reply → ONE confirming PI read → evidence with the full `piCanceledProofV3` → complete the row `succeeded` (only now, per I4) → fenced VOID_SUCCEEDED.
  - In `reservation_failed`: → `authorization_released` (DB C4).
  - In `capture_failed`: leg `authorizationSettled`.
- **Cancel:** positive reply → confirming by-id read (plus ref lookup if not echoed) with the full identity and status `cancelled` → evidence → complete the row `succeeded` → fenced RESERVATION_CANCELLED. The DB requires both the row and the evidence.
- **"cancelled"** only via E3 `settleLeg` with BOTH legs, which the DB enforces. Neither leg alone ever labels the intent.
- **Late callbacks** are late evidence only, recorded after the unknown settlement commits. Never an event.

## 5. Ambiguity policy (irreversible writes)

- **Unknown outcome.** Timeout, 5xx, 409, 429, 4xx, malformed, partial or an unusable confirming read → row `outcome_unknown` + VOID_OUTCOME_UNKNOWN / RESERVATION_CANCEL_OUTCOME_UNKNOWN (legal E3 events) → read-only reconciliation at ≥ dispatch + 2 min.
- **No automatic resend, ever (root B2 decision):** neither a new key nor the same key, nor a new attempt row, after an uncertain void or cancel. Only reads.
- **Reconciled from fresh reads:**
  - `canceled` / `cancelled` with full proof → settle through the accepted planner (VOID_SUCCEEDED / RESERVATION_CANCELLED).
  - **Still authorized / still active after an uncertain void or cancel → INTERCEPT** RECONCILED_STILL_AUTHORIZED / RECONCILED_RESERVATION_STILL_ACTIVE → fenced durable owner case (`VOID_UNRESOLVED_STILL_AUTHORIZED`, `CANCEL_UNRESOLVED_STILL_ACTIVE`). Never a new key, a same-key resend or a new attempt row. Intercepted BEFORE any settlement.
  - Other or unproven statuses → bounded inconclusive → owner case.
- **Rationale:** both writes converge, but re-sending is not proven safe (Stripe in-flight / 409 behaviour; owner edits on Hostaway). Root decided: owner case, with no policy expansion.

## 6. Fences (the E7.3b patterns, reused)

- **Claims:** work claims, maintenance, recovery and orphan handling are SQL-scoped before every LIMIT to: the configured listings, the optional intentId, the E7.4a states {reservation_failed, capture_failed} and the op types {void, cancel, PI read, reservation read, lookup}.
- **Expired leases:** `recoverExpiredOperations` with `intentStates` on the claimed intent only.
- **Exact row claim:** E3 rows have no 0007-style fence for void/cancel, so the worker claims by exact opId and re-checks the state, legs and capture gate immediately before the send.
- **Pre-send check:** re-read immediately before the send:
  - the current op: in_flight, ours, live lease;
  - the work lease: ours, live lease;
  - the intent: version, state, leg not yet settled;
  - the PI / reservation evidence: fresh, and the ids still the ones proven;
  - the protected ids;
  - the stay date.
  
  Then a fresh clock read after those reads; the whole bounded call + 15 s margin must fit on both leases; the step budget must cover the call. No await between that decision and the start of the call. The fixed request is validated against the CURRENT rows.
- **Event and escalation fences:** every worker event and escalation checks, inside its transaction, the planned version + state + legs + scope + operation state (the E7.3b `scopeFence` / `escalateRecovery`). An intent moved by another actor (e.g. a late `RECONCILED_CAPTURE_SUCCEEDED`) → do nothing.
- **Deadlines:** a void has no deadline. After Stripe's `capture_before` the authorization lapses, and a `canceled` read (§3.1 proof) settles the leg.
- **Cancel arrival gate (root B4 decision):**
  - the listing configuration carries an explicit, trusted IANA time zone; it is validated with `Intl.DateTimeFormat(..., {timeZone})`;
  - the fresh injected clock is converted to that zone's local calendar date;
  - the intent's arrival date (`from`, a real YYYY-MM-DD) must be STRICTLY after that local date;
  - an absent or invalid zone, an invalid date, or an arrival that is today or past → refuse (owner case). There is NO UTC or server-time-zone fallback.
  - Checked before the claim AND in the pre-send check with the fresh clock.
- **Bounds:** fixed per-call timeouts (callers may only shorten them), `AbortSignal`s, bounded read retries, durable exhaustion → owner case.
- **Evidence:** evidence is immutable (0008). Every event names the exact evidence id it rests on: a PI evidence id for the void, reservation evidence id(s) for the cancel. The in-transaction check confirms that evidence belongs to the intent and the read type, and was observed after the dispatch.

## 7. Paid booking (E7.4b) rules

- `payment_captured` stays paid whatever happens to the bookkeeping. A failed or unknown recording never triggers a cancel, void or refund.
- One recording per intent. Before ANY send, an executed list read (`hostaway.list_offline_charges`) must show NO existing charge carrying this intent's dedupe marker. Any match, or an unparsable list → owner case.
- A reply alone is not success. A confirming list read must show exactly one charge with the marker and the exact amount/currency → row `succeeded` with the charge id → fenced OFFLINE_CHARGE_RECORDED → `confirmed`.
- Unknown → owner case. OFFLINE_CHARGE_FAILED is never produced (I6). No second row is ever executed.
- **Compatibility gap I7 (correction 3; no shared change proposed yet).** The only durable owner-case mechanism today is ESCALATE, which moves `payment_captured` → `reconciliation_required`. Through `publicStatus` (intent-state.js) that shows the guest `under_review` instead of `confirmed`, although the money is captured and the reservation exists.
  - This applies to the planner's `OFFLINE_CHARGE_OUTCOME_UNKNOWN` operator plan and to E3's `OFFLINE_CHARGE_UNRECORDED` exhaustion.
  - Proposed for a later reviewed change: a **case-only bookkeeping alert**, i.e. a reconciliation case (`reconciliation_cases`, kind e.g. `OFFLINE_CHARGE_UNRECORDED`) opened WITHOUT an intent state change, so the public status stays `confirmed`/paid. This needs a new DB-level entry point (the existing `openCase` helpers are internal to repo.js / operations.js) and root review.
  - Until then E7.4b must NOT escalate a paid intent for bookkeeping. It leaves the row unknown and reports that.

## 8. Blockers and decisions

- **B1 (blocks E7.4b implementation, not independent work):** Hostaway offline-charge API facts. Next: an offline investigation of the official public docs (no credentials), recording only documented facts. The owner read-only shape check remains a later gate. No response formats are invented.
- **B2: decided.** No automatic resend (§5).
- **B3: decided** as to the Stripe contract (§3.2). The adapter is not built: it comes in the pure foundation (§11), with no SDK and no client. The Hostaway cancel shape is live-verified only through the E4 runner (`PUT /v1/reservations/{rid}/statuses/cancelled`, body `{cancelledBy: "host"}`).
- **B4: decided** (§6 arrival gate).
- **B5: decided.** The I1 limitation is retained: an expired-authorization `capture_failed` with a dispatched capture is an owner path until a canceled proof exists. No shared E3 change.
- **I7:** the case-only bookkeeping alert (§7) is an open compatibility gap for a later review.

## 9. Executable offline test plan (E7.4a; fake Stripe/Hostaway, existing disposable local PG, node only)

- **Gate:** production refused; exact executor keys only (retrieveAccount, retrievePaymentIntent, cancelPaymentIntent, retrieveReservation, lookupPage, cancelReservation); create, capture, refund, offline-charge and notify executors rejected.
- **Happy paths:**
  - `reservation_failed` void → confirming read → `authorization_released`;
  - `capture_failed` void + cancel → both legs → `cancelled`;
  - either leg alone never labels the intent `cancelled`.
- **Capture gate (§3.1):**
  - class Z passes;
  - class P passes, and each P condition is broken in turn (`attempts > 0`, `dispatched_at` set, state ≠ pending, `capture_attempts ≠ 1`);
  - class D blocks in every state while the PI shows `requires_capture`, including `failed_definite` with any error code, and passes only with the full canceled proof (each binding broken in turn, incl. `requires_payment_method`, evidence older than the dispatch, < 2 min after it, stale, future);
  - class M blocks;
  - no vacuous pass for a rows/counter mismatch.
- **Proof bindings:** each binding malformed, missing or stale; `modified` and other statuses; ref not echoed → lookup; duplicate ref; all protected ids; stay date past/today.
- **Reply alone insufficient:** the void reply says canceled but the read shows requires_capture → unknown → intercept → owner case, with zero further sends under repeated delivery.
- **Already canceled / already cancelled** → no send, settled from the evidence.
- **Captured while voiding / during cancellation** → escalate, zero refund, no void.
- **Error modes:** timeout / 5xx / 409 / 429 / 4xx / malformed / partial / unusable confirming read → unknown, never VOID_FAILED or RESERVATION_CANCEL_FAILED from bare labels.
- **Pre-send guards, each independently:** op/work ownership, lease room, step budget, version change, a stale cached plan.
- **Crash windows:** after claim, after send, after confirming evidence, after completion (before event), before unknown settlement.
- **Races:** two workers on one intent; a late callback racing the unknown settlement; another actor moving the intent (e.g. RECONCILED_CAPTURE_SUCCEEDED) during reads, between decision and escalation, and between work claim and maintenance → no action.
- **Bounds and scope:** hang bounding per call; durable exhaustion; > 100 noise rows and out-of-scope snapshots unchanged (incl. `payment_captured` offline-charge rows).
- **Closure:** no route/deploy closure (packaging and importer allowlists).
- **Mutations:** targeted mutations of each meaningful guard; survivors reported honestly.

## 10. Changes in this revision (root review of 727b9f1)

1. §3.1 is rewritten as an explicit history classifier (Z / P / D / M), with no vacuous all-rows check and an exact canceled-proof linkage (which event, which id, which in-transaction checks; no capture row is touched).
2. The "send-time definite refusal" route is removed from v1: no write-authorizing predicate rests on an error string.
3. I7 is added: a bookkeeping owner case must not flip a paid booking to under_review. A case-only alert is proposed, with no shared change.
4. Wording: a void releases a held authorization; no captured-funds refund is ever executed.
5. The root decisions on B2 / B3 / B4 / B5 are recorded; B1 is an offline doc investigation.

## 11. Recommended next slice: E7.4a-0 pure proof / request foundation (no worker yet)

- **New file:** `lib/checkout/compensation-proof.js`.
  - Pure: no DB, network, SDK or clock reads (the time is a parameter).
  - Depends only on accepted pure modules: `recovery-plan.js` (`piIdentityOk`, `reservationIdentity`), `capture-proof.js` (the v3 observation). The protected-id list is a duplicated frozen constant, asserted equal to `reservation-worker`'s export in tests, so nothing in booking-db is imported and `intent-state.js` (`STATES`, `voidKey`).
- **Contents:**
  - `captureHistoryClass({ intent, captureRows })` → Z | P | D | M (§3.1), with frozen reasons;
  - `piCanceledProofV3(ev, intent, paymentAttemptId, { latestCaptureDispatchedAt, now })`;
  - `voidSendEligibility(...)`: a strict still-authorized v3 proof + class Z/P + the single pending, never-dispatched void row (attempt 1, `voidKey`) → a frozen branded eligibility with a proof snapshot;
  - `buildVoidRequest` / `validateVoidRequest` → `{ paymentIntentId, params: {}, options: { idempotencyKey } }`, pre-claim only, with snapshot equality;
  - `localDateInZone(now, timeZone)` + `arrivalStrictlyFuture(intent, timeZone, now)`, with no fallback;
  - `cancelSendEligibility(...)`: full reservation identity incl. ref (by-id, or by-id + by-ref evidence), status `new` only, protected ids refused, the arrival gate, class Z/P or the linked canceled proof, and the single pending, never-dispatched cancel row → a branded eligibility + snapshot;
  - `buildCancelRequest` / `validateCancelRequest` → `{ method: "PUT", path: "/v1/reservations/{rid}/statuses/cancelled", query: {}, body: { cancelledBy: "host" } }`.
- **Tests:**
  - every identity, money, status and history guard broken in turn;
  - every protected id;
  - time zones (valid IANA; invalid, absent and non-string zones; DST boundaries; arrival today, yesterday and tomorrow across a UTC date boundary; an invalid date);
  - builders refuse unissued or stale eligibilities and changed snapshots;
  - validators refuse extra keys and parameters;
  - the packaging OFFLINE_ONLY list and no route closure;
  - targeted mutations.
