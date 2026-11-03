# E7.3 capture worker — contract (revised after root design review, 2026-11-02)

- **Status:** DESIGN ONLY. No executor, worker code, schema or E3 change exists for E7.3.
- **Base:** `5b06efa` (E7.2, kept offline). The E7.2 branch stays frozen and implementation is paused at this checkpoint.
- **Changes in this round:** the root decisions C1–C7 of 2026-11-02 are applied, and §9 lists the corrections to the first proposal.

## 1. Scope

- **Path:** `reservation_confirmed` → `payment_captured`, or `capture_unknown` → reconciled / `reconciliation_required`.
- **Calls:** only through these injected executors, all of them bounded and given an `AbortSignal`:
  - `stripe.retrieveAccount({signal})`
  - `stripe.retrievePaymentIntent(id, {expand: ['latest_charge']}, {signal})`
  - `stripe.capturePaymentIntent(id, {amount_to_capture, expand: ['latest_charge']}, {idempotencyKey, signal})`
  - `hostaway.retrieveReservation(req, {signal})`
  - `hostaway.lookupPage(req, {signal})`, used only for the ref fallback in §3.1.
- **Never executed** (rows stay queued): void, cancel, refund, offline-charge recording and notifications.
- **Never present:** a default SDK, network adapter, route, cron or production path. Live mode is refused.
- **Currency:** settled. There is only an exact-currency equality check: no FX, and no work on the MXN pilot.

## 2. Gate and scope (E7.2 patterns, reused without a broad refactor)

**Gate** (each refusal has zero effects):
- `VERCEL_ENV` is development or preview (production refused first);
- `MV_E7_CAPTURE_WORKER` = `enabled`;
- a configured Stripe test account id `acct_…` is present;
- the adapter config and listing allowlist are valid;
- the executor keys are exactly the ones in §1 (any void, refund, cancel or notify key is refused);
- a clock is provided;
- the database is marked test.

**Scope:** applied in SQL BEFORE every LIMIT, to the work claim, maintenance, recovery and orphan re-issue:
- intent states `reservation_confirmed` and `capture_unknown`;
- configured listing ids, plus an optional single intent id;
- op types: `stripe.capture_payment_intent`, `stripe.retrieve_payment_intent`, `hostaway.retrieve_reservation` and `hostaway.lookup_reservation`.

**Protected historical reservation ids** (E7.2 fixed set): refused at every adoption or proof point. A match leads to a durable escalation and never a capture.

## 3. Proofs (persisted as immutable API evidence via read rows; plans cite evidence ids and request selectors)

### 3.1 Fresh pre-send reservation proof

The evidence must be observed after `reservation_confirmed_at`, within `PRE_SEND_FRESH_MS` (proposed 5 min) of the claim, and re-checked at the send.

- **By-id read** of `intent.reservation.reservationId`. The request selector is that id, and it equals the recorded externalRef.
- **Required fields:** status `found_active` (the Hostaway status is copied, never interpreted), reservation id, listing, dates, total and currency all equal to the intent, AND the booking ref equals `intent.ref`.
- **If the by-id reply does not echo the ref:** a by-ref lookup is also required. The request selector is `intent.ref`, it must return exactly one match with the same id, and it must carry the full identity. This is the accepted E7.1 pairing.
- **Failure:** any contradiction, missing field, cancelled or not-found result, or protected id leads to a durable escalation before any claim.

### 3.2 Account

`retrieveAccount` must return `{object: 'account', id: <configured acct_>}` (E5a `verifyAccount` semantics). The result is cached for one step at most.

### 3.3 PaymentIntent evidence versions

- **v2 (accepted E7.1, unchanged)** already carries:
  - identity (PI id, `object`, `accountVerified`, `livemode`, metadata intent and attempt, `captureMethod`);
  - `status`, `amountMinor`, `amountReceivedMinor`, `amountCapturableMinor`, `currency`;
  - `latestCharge.{object, id, paymentIntent, status, captured, amountMinor, amountCapturedMinor, amountRefundedMinor, currency, livemode}`.
- **v2 proofs:** the accepted `piCapturedProof`, `piGoneProof` and `piStillAuthorizedProof` stay exactly as accepted, for all existing callers. Frozen branches are not mutated, and v2 evidence is not invalidated in general.
- **v3 (explicit, additive):** adds the actually missing `latestCharge.paid` and `latestCharge.captureBefore`, taken from `payment_method_details.card.capture_before` × 1000. Both are copied from the provider; a missing or mistyped value stays null.
- **`piStillAuthorizedProofV3`** (new, used ONLY by the E7.3 send and retry paths). It requires everything in v2 identity, plus:
  - `requires_capture`, `amountReceivedMinor` 0, `amountCapturableMinor` = `finalTotalMinor`, `amountMinor` = `finalTotalMinor`, exact currency;
  - an expanded Charge bound to the PI: `object` charge, id `^(ch|py)_`, `paymentIntent` = PI, status succeeded;
  - `paid` true, `captured` false, `amountMinor` = price, `amountCapturedMinor` 0, `amountRefundedMinor` 0, exact currency, `livemode` false;
  - `captureBefore` = the stored `intent.payment.captureBefore`.
- **Tests:** v2-only evidence, missing fields and malformed fields all fail this proof.

### 3.4 Captured proof

Every capture-success path requires the full accepted `piCapturedProof` (PI and Charge) on a READ:
- PI succeeded, `amount_received` = price;
- Charge bound, `captured`, `amount_captured` = price, 0 refunded, currency, test mode.

`status = succeeded` alone is never enough.

### 3.5 Deadline

- The stored `intent.payment.authorizationDeadline` (fixed at authorization) is authoritative; it is never recomputed upward.
- E3 itself compares against Stripe's `captureBefore` in `afterReservation` and in the E3 branch of `RECONCILED_STILL_AUTHORIZED`. The accepted E7.1 `planCapture` ALREADY escalates `AUTHORIZATION_DEADLINE_PASSED` before planning `RECONCILED_STILL_AUTHORIZED` once now ≥ `authorizationDeadline` (`lib/checkout/recovery-plan.js`, the requires_capture branch). E7.3 keeps that and adds the whole-call margin (§4).

## 4. Fencing and claim / send rules

**One capture in flight per intent:** the 0004 unique open-write index, the 0007 claim fence (`reservation_confirmed` and current attempt), and a claim by exact `opId`.

**Pre-claim** (deterministic plan, nothing claimed on failure):
- the intent version, `reservation_confirmed`, `payload.attempt` = `captureAttempts`, and `payload.paymentIntentId` = `intent.payment.paymentIntentId`;
- §3.1, §3.2 and the v3 still-authorized proof are present and fresh;
- `authorizationDeadline` − now > `captureCallMs` + `sendMarginMs`.

Any anomaly leads to a durable ESCALATE with no write claimed (decision C1).

**Pre-send** (after the claim; the clock is read after these DB reads; no await between the check and starting the call):
- the op row is `in_flight` and leased to this worker;
- op lease, work lease and deadline each leave room for the call + margin, and the step budget covers the call;
- the intent is still `reservation_confirmed` with the same version-relevant fields and the same `captureAttempts`;
- the cited evidence ids are unchanged and still fresh.

**On a pre-send failure:** zero sends. The claimed row is possibly sent, so it becomes `outcome_unknown` and goes to authoritative read recovery. Time passing alone NEVER queues compensation (decision C1).

**Bounded calls:** account / PI / reservation reads 10 s, capture 20 s, step 45 s; callers may only shorten them.

## 5. Sequencing (all through accepted E3 events only; no E3 change)

### 5.1 Direct reply path (decision C3(b))

1. Send the claimed capture once, with key `captureKey(intent, PI, attempt)`.
2. Whatever the reply, it does NOT advance to `payment_captured`. Useful reply facts (charge id, status) are kept only as operation evidence (`result_ref` / `late_result_*`).
3. If the reply looks successful, then while the op is still `in_flight` and this worker's:
   - queue and claim ONE confirming PI read row (`expand latest_charge`, bounded);
   - complete the read and record its v3 observation as immutable evidence.
4. If that evidence passes `piCapturedProof`:
   - `completeOperation(capture, succeeded, resultRef = charge id)`; this must return ok. LEASE_LOST means no event, and recovery takes over with the same evidence.
   - Then apply `CAPTURE_SUCCEEDED` (id `op-outcome:{op}`; amount and currency FROM THE EVIDENCE) through `applyEvent`.
   - In-transaction fences: work lease, intent version unchanged since the plan, `reservation_confirmed`, `captureAttempts` = `payload.attempt`, and the cited evidence row exists for this intent and read.
   - The E3 ledger row and the queued `record_offline_charge` are written in that same transaction.
5. **Otherwise** (the reply is not a success, the confirming read fails or times out, the proof fails, or the PI is still `requires_capture`):
   - `completeOperation(capture, outcome_unknown, <code>)`, then `CAPTURE_OUTCOME_UNKNOWN` (`op-unknown:{op}`), then §5.2.
   - A positive proof may be read immediately. Negative or ambiguous observations are never used to settle before the 2-minute rule.

### 5.2 Unknown / timeout path

1. A capture timeout, a lost reply, or any non-success: `completeOperation(outcome_unknown)` commits first, then `CAPTURE_OUTCOME_UNKNOWN`.
2. A reply arriving after the timeout is recorded ONLY as `late_result_*` (and nowhere else) after the unknown settlement committed. It never leads to an event.
3. E3 queues a PI read. The worker executes it no earlier than `dispatched_at` + 2 min (no sleeping; it reschedules), bounded.
4. **Planner:**
   - **Captured:** full accepted captured proof → `settle_operation_from_evidence` → `RECONCILED_CAPTURE_SUCCEEDED`.
   - **Still authorized:** v3 still-authorized proof AND §6 → settle (`failed_definite` / `RECONCILED_NOT_APPLIED`, evidence-based, by the database) → `RECONCILED_STILL_AUTHORIZED` (new attempt row).
   - **Gone:** canceled with full identity (accepted `piGoneProof`) → settle → `RECONCILED_AUTHORIZATION_GONE` → `capture_failed`. Cancel and void are queued but not executed in E7.3.
   - **Other status:** bounded `RECONCILIATION_INCONCLUSIVE` keyed on the evidence.
   - **Mismatch, or deadline passed:** ESCALATE.
   - A "still authorized" plan built on v2-only evidence is not accepted on this path: it needs a fresh read, bounded, and exhaustion leads to escalation.
5. **Absence is never proof.** A capture whose outcome is unknown blocks cancel and void: `capture_unknown` emits neither, and the unique open-write index applies.

### 5.3 No `CAPTURE_FAILED`

E7.3 never applies `CAPTURE_FAILED`: every non-success reconciles first (decision C5).
- **Reachable `capture_failed`:** only through `RECONCILED_AUTHORIZATION_GONE`, after an authoritative canceled read with full identity.
- **Unreachable here:** E3's "still authorized after `captureBefore`" branch, because `authorizationDeadline` = min(`captureBefore` − 12 h, created + 5 d) comes first and the stricter policy escalates at it.

### 5.4 Captured after a failure

If the money turns out to have been captured after a failure (`capture_failed` + captured evidence), E3 escalates `CAPTURED_DURING_CANCELLATION`. That is an operator decision; there is no automatic compensation.

## 6. Retry and idempotency

> **SUPERSEDED for E7.3 by §11 (root amendment, 2026-11-02).** The automatic new-key capture retry described below,
> driven by a still-authorized snapshot after an uncertain send, is NOT adopted. It is kept only as the record of the
> earlier proposal.


**A new attempt is allowed only when ALL of these hold:**
1. The intent is `capture_unknown`, and the previous row is `outcome_unknown`.
2. A PI read observed at least 2 min after that row's `dispatched_at` passes `piStillAuthorizedProofV3`.
3. The database settles the old row from that evidence (the evidence link is immutable under 0008).
4. `authorizationDeadline` − now > `captureCallMs` + `sendMarginMs` + 60 s of provisional processing slack.
5. E3 `captureAttempts` + 1 ≤ `maxCaptureAttempts` (3).

**At the claim and again at the send:** evidence freshness and the whole-call margin are RE-CHECKED (§4), not only when the retry is scheduled.

**Keys:** each attempt row has its own key `cap:{intent}:{pi}[:a{n}]`. Each claimed row is sent once; a key is never reused across attempts (Stripe replays a key's stored result).

**What a still-authorized observation does not prove:** it is a snapshot. It cannot guarantee that an earlier, uncertain capture request will never complete later at the provider. Safety rests on three things together:
- Stripe's manual full capture of one PaymentIntent (no multicapture is ever requested; single-capture behaviour is LIVE-UNVERIFIED against current docs until confirmed);
- per-attempt idempotency keys;
- confirming every outcome with a subsequent proof.

This is NOT exactly-once provider delivery, and must never be described as such.

**Budgets:** 3 capture attempts and 5 inconclusive reconciliations (both E3); 3 recovery reads per selector and re-issue depth 3 (E7.1). Every exhaustion leads to a durable ESCALATE with an open case.

## 7. Crash matrix (never a blind second capture; no stale-worker event; no event from a late callback)

| Point | Recovery |
|---|---|
| after the proof reads, before the claim | the next step re-reads (freshness) |
| after the claim, before or after the send, or the reply lost | op lease expiry → `recoverExpiredOperations` (scoped) → unknown → planner `CAPTURE_OUTCOME_UNKNOWN` → read (≥ 2 min) → reconcile |
| after a success reply, before the confirming read | same (the reply alone never advances) |
| confirming read done, evidence missing | bounded re-issue → exhaustion escalation; the capture op itself expires to unknown → recovery |
| evidence recorded, before the capture completion | op lease expiry → unknown → recovery reuses or reads evidence → settle → `RECONCILED_CAPTURE_SUCCEEDED` |
| capture completed (`succeeded`), event missing | planner (errata): `CAPTURE_OUTCOME_UNKNOWN` first → read → `RECONCILED_CAPTURE_SUCCEEDED` |
| settled, event missing | `applyRecoveryPlan` with the same evidence applies; a different evidence id → STALE_PLAN |
| timeout, then a late reply | unknown; the late reply is `late_result_*` only |
| deadline crossed between proof and send | claimed → unknown → read → deadline passed → ESCALATE |
| two workers / a state race | work lease, SKIP LOCKED, 0007 fence, unique open write, version CAS |

## 8. Offline tests (existing local PG + fake Stripe/Hostaway; controlled clock; short timers; no installs)

- **Gate:** zero effects, including when executor keys for void, refund, cancel or notify are offered.
- **Full path:** one capture call, one confirming read, `payment_captured`, one `record_offline_charge` pending and never claimed, the ledger capture row written once.
- **Reply alone:** a success reply without a confirming read never reaches `payment_captured`.
- **Pre-send proofs:** each v3 / reservation / ref / account field missing, mismatched or stale → durable escalation, zero claims. Protected ids are refused.
- **Post-claim refusals:** each one on its own → zero sends and an unknown row.
- **Replies:** 402 / 400 / 409 / 5xx / 429 / timeout / malformed / partial / late → unknown. A late reply is `late_result_*` only.
- **Reconciliation:**
  - captured → captured;
  - still authorized (v3) → exactly one new attempt with a new key, the old row never re-claimed;
  - a v2-only still-authorized observation → not accepted;
  - canceled → `capture_failed`, with cancel and void queued and zero executed;
  - processing → bounded inconclusive;
  - refunded / other amount / other currency / no charge id → ESCALATE.
- **Budgets:** 3-attempt exhaustion; the deadline arriving between attempts → ESCALATE.
- **Crash matrix:** every row of §7.
- **Concurrency and scope:** concurrent workers; a state change racing the claim; more than 100 unrelated rows not starving the worker; unrelated rows unchanged.
- **Integrity:** a settled-evidence swap refused (0008); no event from a stale worker or a late callback.

## 9. Decisions and corrections recorded (root review, 2026-11-02)

- **C1.** The stricter stored `authorizationDeadline` is kept (never recomputed upward).
  - A pre-claim anomaly leads to a durable ESCALATE, with no write claimed.
  - Once claimed: unknown, then authoritative read recovery. Compensation is never queued merely because time passed.
  - No E3 event changes.
  - **Correction:** the accepted E7.1 `planCapture` already checks `authorizationDeadline` before `RECONCILED_STILL_AUTHORIZED`. It is not absent from the accepted system.
- **C2.** A pending-row anomaly leads to escalation.
  - **Documented limitation:** a never-dispatched pending capture row left behind when the intent leaves `reservation_confirmed` stays "open" in the 0004 index. That is unresolved manual work for the owner.
  - No automatic supersede migration now, and no unproven `NOT_APPLIED` settlement.
- **C3 (b).** A confirming authoritative PI read (with `latest_charge` expanded) is required before any capture-success event. A capture reply alone cannot advance to `payment_captured`. The sequencing is in §5.1 and §5.2.
- **C4.** **Correction:** v2 already has `amountCapturableMinor`, and `piStillAuthorizedProof` already requires it to equal `finalTotalMinor`. v3 adds only `paid` and `captureBefore`. The full v3 still-authorized requirements are in §3.3; v2 captured and gone proofs are unchanged for other callers.
- **C5.** Reconcile-first on every non-success; no `CAPTURE_FAILED` from bare HTTP or error labels.
  - **Correction:** "still authorized after `captureBefore` → `capture_failed`" is not reachable here, because the deadline policy escalates first.
- **C6.** 60 s of processing slack, provisional, as a bounded cushion only. Freshness and the whole-call margin are re-checked at the claim AND at the send. At most 3 attempts, a unique key per attempt, each row sent once. This is not exactly-once delivery (§6).
- **C7.** Settled.

## 10. Not in this slice

- No implementation, executor, schema, migration or E3 change.
- No void, cancel, refund, offline-charge or notification execution.
- No credentials, provider calls, hosted DB, env flags, installs, merge, deploy, activation, owner checkout or E4 journal changes.


## 11. Amendment — capture retry restriction (root, 2026-11-02 America/Mazatlan; official docs checked 2026-11-03 UTC)

**Sources** (official Stripe documentation, as checked by root):
- https://docs.stripe.com/api/payment_intents/capture:
  - capture is allowed only from `requires_capture`;
  - `amount_to_capture` must be ≤ the original amount;
  - `final_capture` defaults to true;
  - a successful capture returns `succeeded`;
  - a PaymentIntent that is not capturable returns an error.
- https://docs.stripe.com/api/idempotent_requests:
  - in API v1, the same key with the same parameters replays the cached result (a 500 included);
  - keys are retained for at least 24 h;
  - a fresh key does NOT deduplicate an earlier request.
- https://docs.stripe.com/error-low-level:
  - network errors are retried with the same key and the same parameters inside the window;
  - a 409 for the same key can mean that the original request is still executing;
  - a 500 is indeterminate;
  - do NOT use a new key until the original outcome is resolved.

**Consequences for E7.3 (binding):**
1. **No automatic new-key retry.** E7.3 has no automatic new-key capture retry after an uncertain capture send (timeout, lost reply, 5xx, 409, 429, a malformed reply, a lost lease, a crash after the claim).
   - A still-authorized snapshot, even two or more minutes after the send, does NOT establish that the original request has stopped executing, and the docs give no such guarantee.
   - Stripe's single/full manual capture behaviour is NOT a substitute for resolving the original request.
2. **Read reconciliation** may still PROVE `captured` (the accepted full PI + Charge captured proof) or `canceled` (the accepted gone proof).
   - A still-authorized observation for an unresolved original uncertain capture becomes a DURABLE OPERATOR DECISION (ESCALATE with a case).
   - It never leads to `RECONCILED_STILL_AUTHORIZED` or a new capture write.
3. **No shared change.** E3 events and the shared E7.1 planner stay unchanged. The later E7.3 worker must BLOCK `RECONCILED_STILL_AUTHORIZED` for an uncertain capture, unless separately reviewed, definitive no-execution evidence exists (none is defined today).
4. **Capture-proof eligibility** (`initialCaptureSendEligibility`, E7.3a) is issued ONLY for the initial planned send:
   - attempt 1, the row pending and never dispatched;
   - NO other capture row for the intent;
   - `reservation_confirmed`;
   - a strict v3 still-authorized proof.
   It is a data gate, not a naming convention: it cannot be produced for any retry, and a capture request can be built only from an eligibility object minted for that exact operation and intent version.
5. **Not adopted:** re-sending the SAME key with the SAME parameters to resolve a network error is documented by Stripe, but it is not adopted here. It would need its own review (whether a once-only row may be re-sent, the replay window and cached-500 semantics).
6. **Entry gates retained** (root, 2026-11-02 21:25):
   - (1) a full captured proof is evidence of money captured even after the deadline; the deadline only blocks NEW sends;
   - (2) `capture_failed` is out of this worker's scope; captured-during-cancellation is an existing E3 invariant;
   - (3) multicapture stays disabled (`final_capture: true` is always sent); per-attempt idempotency is not deduplication across attempts.

**Not built in E7.3a:** worker, executor, DB, schema, E3 and planner changes. The protected historical reservation ids remain a worker-level rule for the later slice.
