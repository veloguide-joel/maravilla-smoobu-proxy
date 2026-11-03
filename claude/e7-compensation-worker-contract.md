# E7.4 compensation and bookkeeping workers — contract (DESIGN ONLY, 2026-11-03)

- **Status:** DESIGN ONLY, for root review. No executor, worker, adapter, schema or E3 change exists for E7.4.
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
| Money truth | no money was taken; the authorization must end and the reservation (if any) must be cancelled | money WAS taken; the booking stays honestly paid whatever happens to the bookkeeping |
| Provider writes | Stripe void (PaymentIntent cancel), Hostaway reservation cancel | Hostaway offline-charge record (non-idempotent bookkeeping) |
| Harm of a duplicate write | a convergent target state ("canceled" / "cancelled"); no money moves | a DOUBLE financial record in Hostaway |
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
- **I4. A succeeded void row alone counts as `authorization_settled_for`.** So the worker must mark a void row `succeeded` ONLY after a confirming PI read with `piGoneProof` (§4).
- **I5. `requires_payment_method` also counts as settled.** That is acceptable for a manual-capture PI, but E7.4a requires `canceled` + `piGoneProof` for its own success and treats `requires_payment_method` as inconclusive → owner case.
- **I6. OFFLINE_CHARGE_FAILED in E3 re-emits a NEW non-idempotent record row** (up to 10). Because the catalogue is empty, no worker can legitimately produce it. E7.4b must keep it so: every failure stays unknown → owner case.

## 3. E7.4a preconditions (all from executed, persisted reads; none from memory or requested fields)

### 3.1 Capture-resolution gate (BLOCKS any void or cancel)

Before the first void or cancel of an intent, every capture row of the intent must be resolved by ONE of these:
- **(a)** fresh PI evidence (v3, account-verified) with `piGoneProof`: status `canceled`, nothing received. A canceled PaymentIntent cannot be captured, so this is definitive.
- **(b)** the only capture row is `failed_definite` from a SEND-TIME definite refusal (`attempts = 1`, not `RECONCILED_NOT_APPLIED`), on attempt 1, with no other capture row.

Not accepted, so they go to an owner case: a pending, in-flight, `outcome_unknown` or escalated capture row; a `RECONCILED_NOT_APPLIED` capture row; any still-authorized or other snapshot while a capture was ever uncertain.

Consequence: in `capture_failed` reached via I1, the void is NOT sent while the PI shows `requires_capture`. Only a later `canceled` read settles it (lapse or owner action).

### 3.2 Void (reservation_failed / capture_failed)

- **Account:** the exact test account, verified.
- **PaymentIntent:** v3 PI evidence fresh (≤ 5 min, after the state was entered, not in the future) showing `requires_capture`, with the full `piStillAuthorizedProof` + v3 charge bindings (`captured: false`, `amount_captured` 0, `paid: true`).
- **Row:** the single current void row: pending, never dispatched, attempt 1, key = `voidKey(intent, pi, 1)`.
- **Request (fixed):** `paymentIntents.cancel(pi, {}, {idempotencyKey})`. No `cancellation_reason` from callers, no other parameters.
- **Already canceled** (`canceled` + `piGoneProof`) → do not send. Apply RECONCILED_AUTHORIZATION_GONE from that evidence (`reservation_failed`), or settle the leg (`capture_failed`).
- **Already captured** (`succeeded`) → never void. ESCALATE `CAPTURED_WHILE_VOIDING` / E3 `CAPTURED_DURING_CANCELLATION`. No refund.

### 3.3 Hostaway cancel (capture_failed only)

- **Identity:** a fresh by-id read with the full identity INCLUDING the ref (by-ref fallback when not echoed), the exact listing, dates, amount and currency, status `new`. Anything else (incl. `modified`) → owner case.
- **Protected ids:** the historical ids 70636076 / 71045356 / 71072615 / 71081885 are refused at every path.
- **Row:** the single current cancel row: pending, never dispatched, attempt 1, payload rid = the intent's immutable reservation id (0001 guard).
- **Stay date (proposed, root to confirm, B4):** `from` must be strictly after today in the listing time zone, otherwise owner case. The guest may already be in the house.
- **Request (fixed, the E4 live-verified shape):** `PUT /v1/reservations/{rid}/statuses/cancelled`, body exactly `{cancelledBy: "host"}`. The pure builder is added in E7.4a. No other path.
- **Ordering:** the cancel runs only after §3.1 holds. It may run before or after the void leg; both legs are independent but share the gate.

## 4. Success requires a confirming read (a reply is never enough)

- **Void:** positive reply → ONE confirming PI read → evidence with `piGoneProof` → complete the row `succeeded` (only now, per I4) → fenced VOID_SUCCEEDED.
  - In `reservation_failed`: → `authorization_released` (DB C4).
  - In `capture_failed`: leg `authorizationSettled`.
- **Cancel:** positive reply → confirming by-id read (plus ref lookup if not echoed) with the full identity and status `cancelled` → evidence → complete the row `succeeded` → fenced RESERVATION_CANCELLED. The DB requires both the row and the evidence.
- **"cancelled"** only via E3 `settleLeg` with BOTH legs, which the DB enforces. Neither leg alone ever labels the intent.
- **Late callbacks** are late evidence only, recorded after the unknown settlement commits. Never an event.

## 5. Ambiguity policy (irreversible writes)

- **Unknown outcome.** Timeout, 5xx, 409, 429, 4xx, malformed, partial or an unusable confirming read → row `outcome_unknown` + VOID_OUTCOME_UNKNOWN / RESERVATION_CANCEL_OUTCOME_UNKNOWN (legal E3 events) → read-only reconciliation at ≥ dispatch + 2 min.
- **Reconciled from fresh reads:**
  - `canceled` / `cancelled` with full proof → settle through the accepted planner (VOID_SUCCEEDED / RESERVATION_CANCELLED).
  - **Still authorized / still active after an uncertain void or cancel → INTERCEPT** RECONCILED_STILL_AUTHORIZED / RECONCILED_RESERVATION_STILL_ACTIVE → fenced durable owner case (`VOID_UNRESOLVED_STILL_AUTHORIZED`, `CANCEL_UNRESOLVED_STILL_ACTIVE`). Never a new key, a same-key resend or a new attempt row. Intercepted BEFORE any settlement.
  - Other or unproven statuses → bounded inconclusive → owner case.
- **Rationale and open decision (B2).** Both writes converge to the same target state and move no money. A re-send after a fresh read is therefore *plausibly* safe, but that is not proven:
  - Stripe 409/in-flight semantics apply to void too;
  - a Hostaway reservation may have been legitimately re-activated or modified by the owner meanwhile.
  - Default: owner case. Any automatic re-send needs a separately reviewed proof.

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
- **Deadlines:** a void has no deadline. After Stripe's `capture_before` the authorization lapses, and a `canceled` read settles the leg. A cancel has the stay-date rule (B4).
- **Bounds:** fixed per-call timeouts (callers may only shorten them), `AbortSignal`s, bounded read retries, durable exhaustion → owner case.
- **Evidence:** evidence is immutable (0008). Every event names the exact evidence id it rests on: a PI evidence id for the void, reservation evidence id(s) for the cancel. The in-transaction check confirms that evidence belongs to the intent and the read type, and was observed after the dispatch.

## 7. Paid booking (E7.4b) rules

- `payment_captured` stays paid whatever happens to the bookkeeping. A failed or unknown recording never triggers a cancel, void or refund.
- One recording per intent. Before ANY send, an executed list read (`hostaway.list_offline_charges`) must show NO existing charge carrying this intent's dedupe marker. Any match, or an unparsable list → owner case.
- A reply alone is not success. A confirming list read must show exactly one charge with the marker and the exact amount/currency → row `succeeded` with the charge id → fenced OFFLINE_CHARGE_RECORDED → `confirmed`.
- Unknown → owner case (the planner already does this). OFFLINE_CHARGE_FAILED is never produced (I6). No second row is ever executed.

## 8. Blockers and decisions for root

- **B1 (blocks E7.4b).** The Hostaway offline-charge API is unverified: the endpoint, the body, whether a reference/description field can carry a dedupe marker, and the list read shape and paging. It needs official-doc verification and an owner-run read-only shape check. Until then E7.4b stays a contract stub with no adapter.
- **B2.** Re-send policy for void/cancel after an uncertain write (§5). The default is an owner case. Decide whether a separately proven convergent re-send is ever wanted.
- **B3.** The void adapter is not built. It needs official Stripe documentation confirmation of `paymentIntents.cancel`: allowed from `requires_capture`, idempotency key behaviour, and the reply / error shapes. The Hostaway cancel shape is live-verified only from the E4 runner (PUT statuses/cancelled, host body). A pure builder needs adding.
- **B4.** Stay-date rule for the cancel (proposed: arrival must be in the future, otherwise owner case).
- **B5.** I1 makes `capture_failed` via `AUTHORIZATION_EXPIRED` mostly an owner path, until a `canceled` read. Root may prefer this to stay an explicit documented limitation rather than an E3 change (recommended).

## 9. Executable offline test plan (E7.4a; fake Stripe/Hostaway, existing disposable local PG, node only)

- **Gate:** production refused; exact executor keys only (retrieveAccount, retrievePaymentIntent, cancelPaymentIntent, retrieveReservation, lookupPage, cancelReservation); create, capture, refund, offline-charge and notify executors rejected.
- **Happy paths:**
  - `reservation_failed` void → confirming read → `authorization_released`;
  - `capture_failed` void + cancel → both legs → `cancelled`;
  - either leg alone never labels the intent `cancelled`.
- **Capture gate:** every unresolved capture shape blocks: unknown, in-flight, pending, escalated, and `RECONCILED_NOT_APPLIED` with a `requires_capture` read. Only `canceled` evidence or a send-time definite refusal unblocks.
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
