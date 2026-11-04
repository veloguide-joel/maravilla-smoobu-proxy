# E7 guest notification — CONTRACT (DOCS ONLY, PROPOSED) for the smallest OFFLINE / injected-MOCK notification slice

**Branch.** `feature/e7-guest-notification-contract`, cut from exact `7df10c3307011979cbc047261d0213bf550d53db` (0015 accepted OFFLINE).

**Labels.** Everything in §1 is **PRESENT** at `7df10c33` and cited `file:line`. Everything from §2 on is **PROPOSED**; nothing is implemented. Migrations 0001–0015 stay byte-identical.

**Boundaries of this document.**
- Read-only repository inspection.
- No SQL / code / test / fixture / migration edit, no suite run.
- No message, credential, provider, environment or real guest data.
- No guest contact value appears in this document.

**What stays closed.**
- Live recipient / sender / provider / channel decisions, owner paymentMethod choice, deployment, scheduler, routes, UI.
- Every real send.

A synthetic mock sink authorizes nothing live. Provider shapes are DOC-DERIVED / LIVE-UNVERIFIED. Labels are TRUST, not authentication. USD fixture convention.

## 0. Summary of the proposal

| Item | Proposal |
|---|---|
| Slice | ONE bounded offline worker step for `guest.notify` rows. The guest's email is rendered into a fixed template and delivered to an **injected mock sink** only. |
| Delivery semantics | **At most ONE send invocation per notification row**, ever. A timeout, ambiguous reply, lease expiry after the claim, a crash, or a COMMIT loss leaves the row **unknown** with an owner case. Never an automatic resend, new key or new attempt. |
| Content gate | Content is re-qualified on fresh DB facts **before the claim and immediately before the invocation**, by one notification-specific SQL function. `booking_confirmed` reuses the authoritative synchronous recording predicate; "not charged" templates refuse any captured / unknown money. |
| Database | It **cannot** be done safely on the existing generic outbox path (§1.5). The minimum is a function-and-trigger migration **0016** plus ONE append-only render-audit table (§4). |
| Status words | Persisted states mean "invoked + mock acknowledged". Never "delivered" or "read". |

## 1. Current inventory at `7df10c33` (PRESENT)

### 1.1 Producers (E3) and the three templates

All `guest.notify` effects are emitted by the pure E3 machine `lib/checkout/intent-state.js`. Each is the single effect of one transition.

| Template | Transition | Producing event(s) | Where |
|---|---|---|---|
| `booking_confirmed` | `payment_captured` → `confirmed` | `OFFLINE_CHARGE_RECORDED` (with a non-empty chargeId) | `intent-state.js:594–596` |
| `not_charged_authorization_may_show` | `reservation_failed` → `authorization_released` | `VOID_SUCCEEDED` (not in `capture_failed`), `:505–506` | `intent-state.js:505–506`, `:570–574` |
| same | same | `RECONCILED_AUTHORIZATION_GONE` from `reservation_failed`, `:572–574` | same |
| `not_completed_not_charged` | `capture_failed` → `cancelled` | `settleLeg` once BOTH `reservationCancelled` and `authorizationSettled` are true. The legs come from `RESERVATION_CANCELLED`, `VOID_SUCCEEDED` or `RECONCILED_AUTHORIZATION_GONE` in `capture_failed`. | `intent-state.js:304–311`, `:505`, `:572`, `:579–581` |

- `confirmed`, `authorization_released` and `cancelled` are TERMINAL (`intent-state.js:84–86`).
- A terminal state may still move to `reconciliation_required` (the DB guard at `0001:189`, e.g. late money). So **a queued notification can outlive the facts it was queued for.**
- Related: `alert.owner` rows (`repo.js:109–110`, `intent-state.js:276`, `:299`) are owner alerts, **out of scope** here.

### 1.2 Outbox mapping

- **`effectToOperation`** (`lib/booking-db/repo.js:107–108`): `guest.notify` → `retry_class 'idempotent'`, idempotency key `notify:{intentId}:{template}`, payload exactly `{ template }`.
- **`insertOperations`** (`repo.js:118–131`) inserts with `ON CONFLICT (idempotency_key) DO NOTHING`. So there is at most ONE row per (intent, template), but the key is **our de-duplication key only**; nothing is sent with it.
- **Defaults:** `max_attempts` comes from `DB_CONFIG.maxAttempts.idempotent = 5` (`lib/booking-db/config.js:14`), and the idempotent retry backoff is 60 s (`config.js:11`). The operation lease is 60 s (`config.js:9`).
- **Schema:**
  - `guest.notify` is an allowed `op_type` (`0001:362`, `0003:36`);
  - `retry_class` ∈ read / idempotent / non_idempotent (+ reconcile_first in 0003/0004);
  - there is a `requires_provider_read` column (`0001:371`).
- **The payload carries no recipient, no content, no version and no facts.** `retry_class`, `payload` and `max_attempts` are immutable after insert (op guard, `0004:53–56`).

### 1.3 Generic outbox behaviour for an `idempotent` row (why it is unsafe for messages)

- **Comment** `lib/booking-db/operations.js:14–15`: notification rows "stay idempotent: a retry after an ambiguous send can deliver a DUPLICATE message … Accepted for E2B; revisit with E8."
- **`claimNextOperation`** (`operations.js:91–136`) claims ANY pending, due row of the requested types. For `guest.notify` there is **no notify-specific claim fence**. The capture / create / void / cancel / record fences do not apply to this type. It sets `in_flight`, `attempts + 1` and `dispatched_at`.
- **`markUnknown`** (`operations.js:385–419`), reached from `completeOperation(... outcome_unknown)` (`:353–383`) and from lease-expiry maintenance `recoverExpiredOperations` (`:426–468`):
  - an `idempotent` row with `attempts < max_attempts` goes **`in_flight` → `pending`**, with `requires_provider_read = true` and `next_attempt_at = now + 60 s` (`:409–418`), and is **re-claimable**;
  - nothing in the claim reads `requires_provider_read`;
  - at `max_attempts` it becomes `escalated` + `OPERATION_RETRIES_EXHAUSTED`.
- **The DB op guard** (`0004:58–66`) **allows** `in_flight → pending` for every class except non_idempotent / reconcile_first. The 0003 safety guard (`0003:446–450`) refuses any runtime move out of `outcome_unknown` / `escalated` (owner only). So the automatic resend path is exactly: **in_flight → pending → in_flight … up to 5 times.**
- **`dispatchOperation`** (`operations.js:506–514`) only calls an injected executor and has no fences; `EXTERNAL_DISPATCH_ENABLED = false` (`:20`).
- **No notification worker, executor, template renderer, sender configuration or channel adapter exists** anywhere in `lib/`, `api/` or `db/lib` (grep). Rows are only queued; the accepted lifecycle rehearsal asserts they stay `pending`, undispatched.

### 1.4 Guest contact data

- **`booking.intent_guests`** (`0001:240–249`) has one row per intent (PK `intent_id`) holding a first and last name, a required email (CHECK-validated shape), an optional phone, `terms_version` and `terms_accepted_at`. It is written once by `collectGuestDetails` (`repo.js:430–443`; email trimmed + lower-cased).
- **There is NO language / locale / channel / consent / preference / opt-out column** and no guest notification preference anywhere.
- **Grants:**
  - `mv_booking_app` has `SELECT, INSERT` on `intent_guests`, **no UPDATE** (`0002:29–31`), so contact data is effectively immutable after insert;
  - `mv_booking_report` has **no** access (no grant `0002:35–39`; no policy `0002:50–52`).
- **Retention purge** `purge_guest_data` (`0001:593`, replaced at `0005:134–150`) DELETES guest rows on a schedule, except for intents with an open reconciliation case. So **a queued row can lose its recipient.**
- **Exposure:** API responses carry no guest data (`lib/checkout/intent-api-core.js:4`). There is **no owner UI** for guest data or notifications; only role-scoped DB inspection exists (app SELECT; report none).

### 1.5 Facts a notification must re-check (all PRESENT)

- **Intent:** state, version, price snapshot (currency, `final_total_minor`), `captured_minor`, `hostaway_reservation_id`, `offline_charge_id`, ref, stay.
- **Ledger:** `booking.payment_ledger` entries (`0001:478–488`; e.g. `capture_succeeded`, `offline_charge_recorded`, `authorization_voided`).
- **Capture / void / cancel rows** and their states.
- **The latest recording** (`recording_latest_id` `0010:30–37`): succeeded, linked (`settled_evidence_id`), result_ref = `offline_charge_id`.
- **Recording holds** (`recording_active_hold_id` `0011:355–359`) and open `OFFLINE_CHARGE_HOLD_%` cases.
- **The authoritative synchronous contradiction predicate** `recording_conflict_refusal` (`0011:340–353`, core `0011:299–338`). It is private (owner only), so the runtime role cannot call it directly. It is used by completion / link / finalisation (`0011:363–454`).
- **The 0015 scoped inbox** (`process_recording_conflict_inbox_scoped_one`, page, summary) gives visibility and holds only. **Its `drained` result proves nothing** about later or concurrently locked evidence (SKIP LOCKED, late commits).

## 2. Offline v1 scope (PROPOSED)

- **One bounded library step** `runNotificationStep(pool, opts)` in a new offline-only module, invoked manually / by tests only.
- **No schedule, route, UI or default executor.** Gate (pure, before any query):
  - an `env` OBJECT with `VERCEL_ENV ∈ {development, preview}` (production refused) and `MV_E7_NOTIFICATION_WORKER === 'enabled'`;
  - a `workerId`;
  - `listingIds` (1–50 distinct int4), optional `intentId`;
  - an explicit `sender` config;
  - an explicit `executors` object with exactly `{ sendMessage, label }`;
  - an injected `clock`.

  Then ONE explicit marker `SELECT` (only an acknowledged non-test / absent marker → `DATABASE_NOT_TEST`; a thrown error propagates unchanged), and the R-C1 clock-skew check pattern.
- **Scope and protected exclusion** are inside the SQL selection before `LIMIT` and rechecked under the intent lock. They use the 0015 two-reference predicate idea at the intent level: the intent's current reservation id must not be protected (70636076 / 71045356 / 71072615 / 71081885). An intent without a reservation is not protected by that half. **Protected intents: zero action.**
- **Channel: email-shaped message to the injected MOCK SINK only.** Reason: email is the only required contact field (`0001:244`); phone is optional, and there is no consent / channel preference.
  - No SDK, SMTP, HTTP client, credentials or environment secret.
  - Test recipients are synthetic `*.invalid` addresses on test-local guest rows. The existing fixture guest uses `example.test` and would therefore be **refused** by the gate below.
  - No vendor is chosen.

## 3. Templates, recipient, sender, rendering (pure, PROPOSED)

### 3.1 Template registry

A frozen registry `NOTIFICATION_TEMPLATES` with `templateVersion = 'gn-v1'`. All copy is PROPOSED and owner-reviewable. All three are plain text, English only (no locale data exists, §1.4).

**Inputs** come only from the facts snapshot: booking ref, check-in / check-out dates, nights, guests, total in minor units + currency formatted by a fixed `USD` / `MXN` formatter, and the guest first name.

**Never in a message:** listing addresses, door codes, the bearer token (a hash only in the DB anyway), links carrying tokens, labels, ids other than the booking ref, or provider ids.

| Template | Subject (proposed) | Body essentials (proposed) |
|---|---|---|
| `booking_confirmed` | "Your maraVilla booking {ref} is confirmed" | Confirmed stay dates, nights, guests; "We have charged {amount} {currency} to your card." No promise beyond what the facts prove. |
| `not_charged_authorization_may_show` | "Your maraVilla booking {ref} could not be completed — you were not charged" | "We could not complete this booking and **you were not charged**. We have released the temporary authorization on your card. Some banks may still show it as **pending** for a few days until it disappears; it is not a charge." No specific number of days is promised (issuer-dependent). |
| `not_completed_not_charged` | "Your maraVilla booking {ref} was not completed — you were not charged" | "We could not complete this booking, the reservation has been cancelled and **you were not charged**." Plus the same neutral pending-hold sentence, because an authorization existed. |

### 3.2 Pure functions

**`buildNotificationSnapshot({ template, facts, guest, sender })`**
- → `{ ok, snapshot }`, a deep-frozen object holding `template`, `templateVersion`, `recipient` (lower-cased email), `subject`, `bodyText`, `factsDigest` (the non-PII facts used) and `contentHash` (sha256 of the canonical JSON of subject + body + recipient + sender + template + version).
- → or `{ ok:false, code }`.

**Recipient validation:**
- the email must exist (the guest row may have been purged → `RECIPIENT_MISSING`);
- it must match the DB shape;
- **offline v1: the domain must end with `.invalid`** (`RECIPIENT_NOT_SYNTHETIC`);
- the recipient is ALWAYS the bound guest row of THAT intent; no payload or option can override it.

**`sender`:** an explicit `{ fromAddress, fromName }`, no default. Offline v1 requires `fromAddress` to end with `.invalid` (`SENDER_NOT_APPROVED`).

**Message request** (the executor input, frozen): `{ channel:'email', to, from, fromName, subject, text, messageRef }`, where `messageRef = 'gn1-' + opId`.
- `messageRef` is our correlation marker. It is **not** an idempotency guarantee: no provider idempotency is assumed.
- There is no HTML, attachment, CC/BCC or reply-to override.

**`assessSendReply(reply)`** classifies the mock reply:
- `{ status:'accepted', providerMessageId }` only for an exact synthetic shape (an object, `accepted === true`, a string id 1–100 chars);
- `{ status:'refused', code }` only for an exact synthetic definite-refusal shape with a catalogued code (initially empty → none);
- everything else is `unknown`.

**`accepted` ≠ delivered ≠ read**, and no current evidence can prove delivery or reading.

### 3.3 Logging / output redaction

Step results, errors, progress and pages carry op id, intent id, template, codes, counts and `contentHash` prefixes only. They never carry the recipient, names, subject or body. The persisted render row stores a **recipient hash**, not the address (§4.2).

## 4. Database gaps and the minimum migration 0016 (PROPOSED; not implemented)

### 4.1 Concrete gaps (each blocks a safe v1)

| # | Gap at `7df10c33` | Consequence |
|---|---|---|
| G1 | No notify-specific claim fence; `attempts ≤ 5` and `in_flight → pending` are allowed for `guest.notify` (§1.3) | An interrupted send is automatically resent up to 5 times, by any caller of the generic claim / maintenance. |
| G2 | `markUnknown` / `recoverExpiredOperations` send `guest.notify` back to `pending` | Lease expiry after an invocation becomes a resend. |
| G3 | Payload = `{template}` only, immutable; nothing binds the recipient, content, version or facts | A stale or changed content could be sent; there is no audit of what was sent. |
| G4 | No app-callable notification qualification. The authoritative contradiction predicate is private; there is no single check of state / money / hold / proof | The worker would have to restate predicates in JS (drift risk). |
| G5 | No outcome / case kind for an uncertain notification | An unknown send is invisible. |

### 4.2 The minimum 0016 objects

**(a) `booking.notification_renders`** — append-only, one row per `guest.notify` op (PK `operation_id`).

| Columns | Notes |
|---|---|
| `operation_id`, `intent_id`, `template`, `template_version`, `intent_version` | binding |
| `content_hash` (sha256 hex), `recipient_hash` (sha256 hex of the lower-cased address), `facts_digest jsonb` | non-PII: ref, dates, nights, guests, amount, currency, reservation id, charge id, recording op id, settled evidence id |
| `rendered_at` (`clock_timestamp`), `worker` | |

- **No raw recipient, subject or body is stored.**
- Guards: append-only / no delete / no truncate; INSERT only via the SECURITY DEFINER recorder below; RLS SELECT for app / admin; report gets no recipient hash (or no access, decision D4).
- **Why a table is genuinely needed:** the op payload is immutable (`0004:53–56`), and no existing audit can bind recipient + content + version to the op.

**(b) `booking.notification_send_refusal(p_op uuid) RETURNS text`** — SECURITY DEFINER, `search_path` fixed; NULL = qualifies.

- **Common:** the op is `guest.notify`, its template is in the registry set, the intent is not protected, and the guest row exists.
- **`booking_confirmed`:**
  - intent state `confirmed`;
  - `offline_charge_id` is non-NULL and equals the latest recording's `result_ref`;
  - the latest recording is `succeeded` and linked;
  - **no active recording hold** and **no open `OFFLINE_CHARGE_HOLD_%` case**;
  - `recording_conflict_refusal(intent, dispatched_at, result_ref, settled_evidence_id) IS NULL` (the authoritative predicate, synchronous over ALL committed evidence, independent of inbox progress);
  - `captured_minor` = `final_total_minor` and there is a `capture_succeeded` ledger entry of that amount / currency;
  - currency = the price currency;
  - the capture row `succeeded`;
  - the reservation id is set.
- **"Not charged" templates:**
  - `not_charged_authorization_may_show`: state `authorization_released`;
  - `not_completed_not_charged`: state `cancelled`;
  - and for both: `captured_minor = 0`; **no `capture_succeeded` / `offline_charge_recorded` ledger entry**; no capture row in `succeeded`, `in_flight`, `outcome_unknown` or `escalated` (only never-dispatched `pending` / `superseded`, or `failed_definite`, may exist); no open money-related reconciliation case.
- **Any** other state (incl. `reconciliation_required`) → refusal code.

**(c) `booking.record_notification_render(p_op, p_worker, p_template_version, p_content_hash, p_recipient_hash, p_facts_digest, p_expected_version)`** — SECURITY DEFINER, app.
- **Lock order:** intent SHARE → op FOR UPDATE → advisory `('booking.recording_evidence', intent)` (the 0010/0011 key, so it serialises with evidence writers, link and finalisation).
- Requires the op `pending`, `attempts = 0`, the version = expected, a held work lease, `notification_send_refusal IS NULL` at the post-lock instant, and the facts digest equal to the SQL-computed digest. Then it inserts the render row (once; a duplicate with the identical hash is a no-op, a different one is refused).

**(d) The notify claim fence** — a `BEFORE UPDATE` trigger on `external_operations`, guest.notify only, in the 0007 / 0009 / 0011 style:
- `pending → in_flight` only if `OLD.attempts = 0`;
- the render row exists with `intent_version` = the current intent version;
- `notification_send_refusal IS NULL` (re-evaluated in the claim transaction, after the intent lock that `claimNextOperation` already takes);
- the work lease is held by the claimer;
- `in_flight → pending` is **refused for guest.notify** (closes G1 / G2 at the DB, for every caller).

**(e) Uncertain settlement**
- **Option A (recommended, decision D1):** an operations.js change: `markUnknown` treats `guest.notify` like `non_idempotent` → `outcome_unknown` + case `NOTIFICATION_OUTCOME_UNKNOWN`. Without it, the fence in (d) would make GLOBAL lease-expiry maintenance raise for a notify row.
- **Option B:** a 0016 trigger-side rewrite. Not recommended: silent state coercion.

**Grants.** EXECUTE on (b) and (c) → `mv_booking_app` (+ admin for b). No new write privilege on any table.

**0016 down.** Refuses while any `notification_renders` row exists or any `guest.notify` row has `attempts > 0` (audit and the at-most-once history are never discarded). Otherwise it drops (d), (c), (b), (a) in dependency order and restores the fresh-0015 functions exactly. Tests prove `pg_get_functiondef` / ACL equality and the gate.

## 5. The step (PROPOSED)

**One bounded step:** gate → marker → skew → scoped maintenance of THIS worker's expired `guest.notify` leases (→ unknown + case, never pending) → claim ONE intent's work row (scope, protected and due in SQL) → handle ONE due `guest.notify` row → release work. A thrown error propagates unchanged with no further query (the recording-worker §6.3 rule).

1. **Load facts** (fresh), template, guest row → `notification_send_refusal(op)`.
   - Non-NULL → see §6 (no claim, no send).
2. **Render pre-claim.** `buildNotificationSnapshot` → `record_notification_render` (binds hashes + digest at the current version; refuses if facts drifted). There is no network in any transaction.
3. **Claim exactly that row** (`claimNextOperation` by `opId`, op type `guest.notify`). The fence (d) re-runs the refusal and binding in the claim transaction. From here the row is "possibly sent" to every other actor.
4. **Immediately before invocation:** fresh rows (op `in_flight` held by me with lease room > call timeout + margin; work lease; render row; intent version = the render's; `notification_send_refusal IS NULL`; recipient hash = hash of the CURRENT guest row; request `contentHash` = render), the clock read after them, and no await between this decision and the call start.
5. **ONE bounded invocation** `executors.sendMessage(request, { signal })`. `ctx.sends += 1`.
6. **Reply handling:**
   - `accepted` → `completeOperation(succeeded, resultRef = providerMessageId)`. Persisted meaning: **invoked + mock-accepted**, not delivered.
   - Timeout / throw / unknown shape / lease lost → `outcome_unknown` + `NOTIFICATION_OUTCOME_UNKNOWN` case (once; never re-invoked). A late reply is observed in memory only, within a finite window, with no DB write (the recording-worker R4 pattern).
   - A catalogued definite refusal → `failed_definite` (catalogue initially EMPTY, so in v1 every non-accepted reply is unknown).

**Crash matrix (recovery uses persisted facts only; never resurrects a stale payload, never resends):**

| Crash point | Persisted state | Next step |
|---|---|---|
| Before render | nothing | re-qualifies on current facts |
| After render, before claim | render row, op pending | re-render refused if facts / version drifted, so the render no longer binds the current version → claim fence refuses → §6. Else claim. |
| After claim, before invocation | in_flight, attempts 1 | lease expiry → **unknown + case, no send** (a claim is "possibly sent" by contract) |
| After invocation, before reply | same | the same; the mock may have accepted |
| After an accepted reply, before completion | same | the same: **unknown** (accepted-but-reply-lost) |
| After completion | succeeded | nothing to do |
| COMMIT loss of the completion | succeeded or in_flight | either is safe: in_flight expires → unknown; never resent |

**Guarantees vs not:**
- At most one invocation per row: enforced by `attempts = 0` + the claim fence + no `in_flight → pending`.
- Content qualified twice on DB facts within milliseconds of the call.
- **No exactly-once** and **no delivery guarantee**.
- **Unavoidable race:** a contradiction / late money / hold committed after the pre-invocation check, or during provider processing, can still coincide with a sent confirmation. That post-hoc state is visible (hold / case / page); it is never "un-sent".

## 6. Stale, inapplicable and unknown rows (visibility, no blanket suppression)

**Inapplicable** — current facts no longer justify the template (state moved to `reconciliation_required`, an active hold / contradiction, money present or unknown for a "not charged" template, guest purged, protected).
- The row stays `pending` and unclaimed.
- The step records nothing to the provider and opens ONE `NOTIFICATION_NOT_APPLICABLE` reconciliation case (de-duplicated by the existing unique open (intent, kind)) with `{opId, template, code}` evidence.
- It is not deleted, superseded or sent later automatically. If the facts return to qualifying (e.g. an owner resolves a hold), a later step may send it **only** with a fresh render on the then-current version.
- No owner override, release or link maintenance happens inside the worker.

**Unknown** (§5): `outcome_unknown` + case. Settled only by an owner resolution with evidence (existing admin path). No resend.

**Already succeeded:** idle.

## 7. Relation to the 0015 scoped inbox

- **Separately invoked:** the notification step never calls the inbox processor and never uses its `drained` flag.
- `booking_confirmed` relies on the synchronous `recording_conflict_refusal` over all committed evidence, plus "no active hold / open hold case", inside `notification_send_refusal`. The inbox only adds holds / cases (visibility) asynchronously, and a hold it opens later blocks any not-yet-claimed confirmation through the same function.
- **Missing invariants listed:**
  - no DB-level link between a guest.notify row and the recording proof it relies on (closed by the render `facts_digest` binding + the fence);
  - no notification audit (closed by `notification_renders`);
  - no notification-specific owner case kinds (two new codes; `reconciliation_cases.kind` is a free code, `0001:539`).

## 8. Planned deterministic tests (future slice; unit + disposable PG + mock sink; no network)

1. **Unit:**
   - template rendering for all three templates (exact proposed copy, amounts / currency / dates);
   - recipient / sender validation (`.invalid` only, missing, malformed);
   - no PII in results / errors / progress;
   - reply classification;
   - zero-query gate refusals; marker / outer-error propagation; per-call frozen options.
2. **PG facts:**
   - each template qualifies only in its state;
   - `booking_confirmed` refused for: an active hold, an open hold case, a contradiction committed after queueing (API and historical dashboard), an unlinked / mismatched recording, a wrong amount / currency;
   - "not charged" refused for captured money, an in_flight / unknown / escalated capture, and ledger capture entries;
   - state drift (confirmed → reconciliation_required);
   - guest purged → `NOTIFICATION_NOT_APPLICABLE`.
3. **At most once:**
   - mock timeout, accepted-but-reply-lost, a throw, and lease expiry after the claim → unknown + case, `sendMessage` count 1, repeated steps 0;
   - generic `claimNextOperation` and global `recoverExpiredOperations` cannot re-queue or re-claim a notify row (fence);
   - COMMIT ambiguity of the completion in both outcomes (committed / not).
4. **Races:**
   - same / different worker, overlapping scope;
   - a hold / contradiction committed between render and claim (claim refused), and between claim and the pre-invocation check (send aborted → unknown, 0 sends);
   - the known unavoidable window documented.
5. **Scope:** protected intents zero action; out-of-scope 100+ noise cannot starve; optional intent narrowing; bad scope zero queries.
6. **Migration 0016:** grants / roles (report sees no hashes / guest data); append-only; down gate refuses with any render / attempted notify; fresh-15 equality after an allowed down.
7. **Regressions:** the lifecycle rehearsal unchanged (rows stay pending until a separately reviewed slice extends it), 0010–0015 suites, `npm test`, `test:db`. **Never mark a queued row as delivered.**

## 9. Smallest implementation slice (when authorized)

**Files:**
- `db/migrations/0016_guest_notification_fence.up.sql` / `.down.sql` (§4.2 a–d);
- `lib/checkout/guest-notification.js` (pure §3);
- `lib/booking-db/notification-worker.js` (§5);
- `lib/booking-db/operations.js`: ONLY the `markUnknown` guest.notify branch (§4.2 e, if D1 = A);
- tests: `test/e7-guest-notification.test.mjs`, `test/db/e7-guest-notification.test.mjs`;
- packaging closure pin + `OFFLINE_ONLY`; mechanical 0016 migration-version pins;
- this contract's map.

**No change to:** E3 producers, templates' trigger points, other workers, routes, UI, config / deps.

## 10. Decisions for root / owner (recommendation first)

- **D1 — uncertain-settlement path:** (A) a one-branch `markUnknown` change in `operations.js` (guest.notify → `outcome_unknown` + case), **recommended**; vs (B) a trigger-side coercion.
- **D2 — "not applicable" handling:** a visible owner case with the row left pending, **recommended**; vs `superseded`, which loses re-qualification.
- **D3 — copy:** adopt the §3.1 proposed English copy for offline tests; final wording / language and the pending-hold sentence remain an **owner** choice before any live use.
- **D4 — report role:** no access to `notification_renders`, **recommended**; vs a hash-free view.
- **D5 — channel for offline v1:** an email-shaped mock sink, **recommended**; SMS / other channels stay out (no consent / phone requirement exists).

**Live provider, sender identity and recipient policy: CLOSED** (not decided here).

**Remaining blocker:** none for design review. Residuals:
- `alert.owner` rows have the same generic resend exposure (§1.3) and are out of this scope;
- the historical e74a guard failure stays open.
