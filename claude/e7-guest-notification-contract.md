# E7 guest notification — CONTRACT revision 2 (DOCS ONLY, PROPOSED): the smallest OFFLINE / injected-MOCK notification slice

**Branch.** `feature/e7-guest-notification-contract`. Revision 1 was `2e20972ac96bbbf6bfa984be3c84ec3542969e8a` (root DESIGN HOLD, findings R1–R6). This revision 2 is cut from exact `2e20972a`.

**Labels used in this document.**
- **PRESENT**: true at `2e20972a`, whose code is identical to accepted `7df10c33`. Cited as `file:line`.
- **PROPOSED**: not implemented. Migrations 0001–0015 and every accepted worker stay byte-identical until a separately authorized implementation slice.
- **TRUST**: asserted by reviewed JS or by a caller; SQL cannot re-derive it.
- Provider shapes are DOC-DERIVED / LIVE-UNVERIFIED.

**Boundaries of this document.**
- Read-only inspection only.
- No SQL, code, test, fixture or migration edit, and no suite run.
- No message, credential, provider, environment value or real guest data.
- No guest contact value appears here.

**What stays closed.**
- Live recipient, sender, provider and channel decisions.
- Owner paymentMethod choice.
- Deploy, scheduler, routes, UI, config and deps.
- Every real send.
- Admin resolution, release and link maintenance.
- Retries of uncertain provider writes.
- Protected refs 70636076 / 71045356 / 71072615 / 71081885 get zero action.
- USD only for new worker fixtures and the gate. Legacy MXN fixtures do not authorize a new currency path.

## 0. Root decisions, resolution map, new decisions

### 0.1 Decisions taken by root on revision 1

| # | Decision | Where it is applied |
|---|---|---|
| D1 = A | An explicit `guest.notify` branch in `markUnknown`; no trigger state coercion | §6.5, §8.1 |
| D2 | Visible pending; no automatic override; requalification policy kept consistent | §7: the latch is permanent and there is no requalification in v1 |
| D3 | The §3.2 English copy is for offline mock tests only | §3.2 |
| D4 | The report role gets no access to the render or latch audit | §4.4, §7.3 |
| D5 | Email-shaped injected MOCK only; synthetic `.invalid` sender and recipient; no real transport | §2, §3.3, §9 |

### 0.2 Resolution map

| R | Root finding (short) | Resolution in revision 2 | Sections | Key sources |
|---|---|---|---|---|
| R1 | A one-row immutable render contradicted "fresh render on a new version" | **One mechanism: freeze at claim** (detail below) | §4 | `0001:159–162`, `0001:251`, `repo.js:121–127`, `repo.js:378`, `intent-state.js:136`, `:309`, `:506`, `:574`, `:596`, `:609–625` |
| R2 | Protected rows opened a case; "not sent later" contradicted requalification; the admin-path claim was false | Protected = zero action; four SQL eligibility classes; permanent latch; unknown stays durable and unresolved | §7 | `0005:296–384` (`:363–364`), `0011:530–541`, `0005:134–150` |
| R3 | "Money-related case" was undefined; proofs relied on absence only | Exact per-template SQL predicates with positive proofs; missing proof → latch | §5 | `0001:301–313`, `:435–450`, `:478–533`, `:536–567`, `0003:52–103`, `capture-worker.js:23–25`, `compensation-worker.js:376–460`, `:540–560`, `recovery-plan.js:295–361` |
| R4 | A trigger alone starves other work; claim and locks were unspecified | Generic-claim exclusion in both stages; dedicated claim function; authoritative triggers; full lock order | §6 | `operations.js:89–136` (`:103–108`), `:166–175`, `:353–468`, `repo.js:652–661`, `0010:359`, `:385–388`, `0012:560–580` |
| R5 | Lifecycle, upgrade and down invariants were not mapped | Full change map; race-safe upgrade and down; schema-only down equality | §8 | `0004:45–75`, `0003:440–452`, `0001:356–371` |
| R6 | The redaction promise was too broad; the API notation was loose | Narrowed redaction guarantee; one exact API and reply notation | §3, §9 | `operations.js:506–514`, `0001:240–249` |

**R1 detail (freeze at claim).**
- A render is persisted ONLY inside the claim transaction, exactly once per op (PK `operation_id`).
- It is bound to `intent_version = op.source_version`.
- Nothing is ever re-rendered, revised or re-claimed. Pre-claim renders live in memory only.
- Any drift before the claim produces a permanent, visible latch (§7) and no case.
- Revisions are unnecessary because a qualifying newer version can never exist (§4.1).
- The exact encoding is defined, and fields are split into SQL-derived and TRUST.

**R2 detail.**
- Protected rows get zero action:
  - excluded before LIMIT in every selection and rechecked under lock;
  - no latch, case, render or page row.
- Four eligibility classes are each defined by SQL: ELIGIBLE, WAITING, OUT_OF_V1_SCOPE, LATCHED.
- The latch is permanent, written once and excluded before LIMIT. So there is no hot loop and no repeated owner case.
- An unknown stays durable and unresolved:
  - `admin_resolve_operation` is NOT_SUPPORTED for `guest.notify`;
  - `admin_close_case` refuses `op:` cases.
- Manual resolution design is deferred. There is no owner resend.

**R3 detail.**
- Exact per-template SQL predicates cover every persisted money and reservation table (inventory §5.1).
- The positive proofs for "released" and "cancelled" come from persisted, accepted evidence.
- "Any open case" is the exact case predicate.
- Missing proof → latch. No provider read. TRUST limits are listed.

**R4 detail.**
- `claimNextOperation` excludes `guest.notify` in BOTH stages (a JS advisory mirror).
- A dedicated SECURITY DEFINER `claim_guest_notification` has an exact lock order and reads the DB clock after taking the locks.
- A BEFORE fence trigger and an AFTER binding trigger are authoritative for every path.
- The full lock-order table separates library paths from the direct-UPDATE 40P01 residuals.
- Lease and time budgets are explicit.
- A one-statement pre-send snapshot plus a frozen request; the post-snapshot race is documented.

**R5 detail.**
- A full INSERT / UPDATE / same-state map for notify rows.
- `in_flight→pending` and `outcome_unknown→pending` are refused for everyone, the owner included.
- At most one claim, ever. The DB claim count is kept separate from the worker's invocation count.
- The upgrade precondition and the down gate run under table locks.
- Down equality is schema-only; JS compatibility and rollback order are stated.
- Tests cover raw UPDATEs and generic helpers; down tests preserve the audit.

**R6 detail.**
- Redaction is narrowed to returned projections and persisted codes.
- Outer DB errors are rethrown as the identical object and never logged.
- The provider-error boundary is code-only.
- Exact contracts: one reply notation, the id grammar, function returns and refusals, option validation, a deep-frozen basis.
- `.invalid` is a test-address rule, not transport authentication.

### 0.3 New decisions surfaced by revision 2 (recommendation first)

- **N1 — how a latch is made visible.**
  - (a) A latch row plus the read-only page, and **no reconciliation case** (recommended). Any open case blocks guest-data purge (`0005:146`).
  - (b) A latch plus a closable case, opened as `notification-latch:{op}`.
- **N2 — the unknown case vs retention.** D1 = A opens `NOTIFICATION_OUTCOME_UNKNOWN` as `op:{id}`. No existing owner function can close it (§7.4), so it blocks purge for that intent indefinitely.
  - (a) Keep the case, and block any live enablement until a deferred owner notification-resolution slice exists (recommended for offline v1).
  - (b) Open no case; the unknown is then visible only through the op state and the page.
- **N3 — recipient hash retention.** `notification_renders.recipient_hash` survives guest purge. It is pseudonymous, guessable personal data (§4.3).
  - (a) Keep it, offline only. Any live retention policy needs an owner decision before enablement (recommended).
  - (b) Omit it and bind the recipient only inside the claim transaction. This loses pre-send detection of a recipient change.

## 1. Current inventory (PRESENT)

### 1.1 Producers, and at most one notify row per intent

| Template | Producing transition | Emission site |
|---|---|---|
| `booking_confirmed` | `payment_captured` → `confirmed` on `OFFLINE_CHARGE_RECORDED` | `intent-state.js:596` (case `:594–596`) |
| `not_charged_authorization_may_show` | `reservation_failed` → `authorization_released` on `VOID_SUCCEEDED` | `intent-state.js:506` |
| `not_charged_authorization_may_show` | `reservation_failed` → `authorization_released` on `RECONCILED_AUTHORIZATION_GONE` | `intent-state.js:574` |
| `not_completed_not_charged` | `capture_failed` → `cancelled` via `settleLeg` once both legs are settled (legs at `:505`, `:572`, `:579–581`) | `intent-state.js:309` |

**What the state machine guarantees today.**
- A grep finds **exactly four** `guest.notify` emission sites, the ones in the table.
- The three targets are terminal (`intent-state.js:84–86`).
- The DB lets a terminal state move only to `reconciliation_required` (`0001:188–190`).
- From `reconciliation_required`, only `PAYMENT_AUTHORIZED` (late money, recorded as ledger `authorization_rejected`, `repo.js:192–197`) and `RESOLVE` are accepted (`intent-state.js:136`). Neither emits `guest.notify`; RESOLVE is at `:609–625`.

**Derived invariant (PROPOSED, enforced by a test).** Each intent gets at most ONE `guest.notify` row in its lifetime.
- The source states of the four emissions are never reachable again from a terminal state.
- The key `notify:{intent}:{template}` is UNIQUE and is inserted with `ON CONFLICT DO NOTHING` (`repo.js:107–108`, `:118–131`).

**Version facts.**
- `source_version = after.version` of the producing transition (`repo.js:121`, `:127`).
- **Every** `intents` UPDATE advances the version by exactly 1 (`0001:159–162`).
- Scheduling lives in `intent_work`, "so scheduling never bumps the E3 version" (`0001:251`).
- A grep for `UPDATE booking.intents` finds one site, `repo.js:378` (applyEvent). The implementation must re-verify this. An unconsidered bump fails safe as a `VERSION_DRIFT` latch.

**Out of scope.** `alert.owner` rows (`repo.js:109–110`) have the same generic resend exposure (residual §14).

### 1.2 Generic outbox behaviour, and why it is unsafe for messages

- **Mapping.** `guest.notify` → `retry_class 'idempotent'`, payload `{template}` only (`repo.js:107–108`). `max_attempts` 5 (`config.js:14`), backoff 60 s (`:11`), op lease 60 s (`:9`).
- **`claimNextOperation`** (`operations.js:91–136`):
  - It has no notify fence in the candidate stage (`:97–101`) or the locked stage (`:112–121`).
  - The work row is locked FOR SHARE only for recordings (`:103–108`).
  - It uses the caller's clock `now` (`:92`, `:118`).
  - The candidate stage is `ORDER BY next_attempt_at, created_at LIMIT 1`, with at most `CLAIM_MAX_CANDIDATES = 10` skips (`:89`, `:101`).
- **`markUnknown`** (`:385–419`) moves an idempotent row `in_flight → pending` with `requires_provider_read = true` and +60 s (`:414–418`). It is reached from:
  - `completeOperation(outcome_unknown)` (`:378–379`);
  - `recoverExpiredOperations`, through both its global op-first path (`:448–455`) and its phase-guarded intent-first path (`:428–447`).
- **The op guard:**
  - allows `in_flight → pending` and `outcome_unknown → pending` for idempotent rows (`0004:63`, `:65`);
  - allows any same-state change except identity columns (`0004:53–58`);
  - lets `attempts` grow but never shrink (`0004:55`).
- **The safety guard** refuses runtime moves out of `outcome_unknown` / `escalated` unless privileged (`0003:446–450`).
  - `is_privileged()` means current_user is the schema owner (`0003:15–17`), so it is true inside any SECURITY DEFINER function.
- **The runtime role** has raw `UPDATE` on `external_operations` (`0002:24–28`), so any fence must be a trigger.
- **Completion:**
  - `completeOperation` tests the lease with the caller's clock (`:356–359`);
  - it blocks success only for recordings (`:169–171`);
  - `failed_definite` is checked against the catalogue only for `non_idempotent` rows (`0003:451–452`).
- **Dispatch.** `dispatchOperation` has no fences (`:506–514`), and `EXTERNAL_DISPATCH_ENABLED = false` (`:20`).
- **Nothing else exists.** No notification worker, executor, renderer, sender config or channel adapter.

### 1.3 Owner paths (correction of revision 1)

- **`admin_resolve_operation` cannot settle a `guest.notify` row.**
  - It was defined at `0003:533` and replaced at `0005:296–384`. It is not replaced later; `0008:9` mentions it only in a comment.
  - It supports checkout create, recording, create, cancel, capture and void. Any other type raises `NOT_SUPPORTED` (`0005:363–364`).
- **An `op:` notification case has no existing closing path.**
  - `admin_close_case` was defined at `0003:640` and replaced at `0011:530`.
  - It refuses any case with `opened_by LIKE 'op:%'` (`0011:539–541`).
  - `markUnknown` opens its cases as `op:{id}` (`operations.js:397`, `:405`).

### 1.4 Guest data and retention

- **`intent_guests`** (`0001:240–249`):
  - PK `intent_id`; columns `first_name`, `last_name`, `email` (CHECK on the shape, `:244`), optional `phone`.
  - There is no locale, channel, consent or opt-out column.
- **Grants on guest data:**
  - the app role has SELECT and INSERT, but no UPDATE (`0002:29–31`);
  - the report role has no grant and no policy (`0002:35–39`, `:50–52`).
- **`purge_guest_data`** (`0005:134–150`; DELETE at `:142`) deletes guest rows:
  - for `authorization_released`, `cancelled` and the other no-booking states, after the failed-attempt period;
  - for `confirmed`, after check-out;
  - **unless the intent has ANY open case** (`0005:146`).
  - It takes no intent lock.

### 1.5 Precedents reused

- Claim fences as BEFORE UPDATE triggers: `0007:19`, `0009:34`, `0011:579–581`.
- An AFTER UPDATE claim-audit binding, written by the claim statement itself and re-checked at its own instant: `0012:560–580`.

## 2. Offline v1 scope (PROPOSED)

- **One bounded library step:** `runNotificationStep(pool, opts)` in `lib/booking-db/notification-worker.js`.
  - Invoked by tests only.
  - No schedule, route, UI or default executor.
- **Gate:** pure, before any query (§9.3). Then:
  - one test-marker SELECT (only an acknowledged non-test or absent marker → `DATABASE_NOT_TEST`);
  - the clock-skew check against the DB clock: |JS clock − DB clock| ≤ 2 000 ms.
- **Channel:** an email-shaped request to the injected MOCK `executors.sendMessage` only.
  - No SDK, SMTP, HTTP client, credential or environment secret.
  - Recipients are synthetic `*.invalid` addresses on test-local guest rows.
  - The existing fixture domain `example.test` is out of v1 scope (§7.1).
- **Currency:** USD only. This is an SQL scope class (§7.1), so a non-USD intent is never claimed and causes no hot loop.

## 3. Pure module `lib/checkout/guest-notification.js` (PROPOSED)

### 3.1 Frozen constants

| Constant | Value |
|---|---|
| `TEMPLATE_VERSION` | `'gn-v1'` |
| `TEMPLATES` | `['booking_confirmed', 'not_charged_authorization_may_show', 'not_completed_not_charged']` |
| `OP_LEASE_MS` | 60 000 (= `config.js:9`) |
| `WORK_LEASE_MS` | 120 000 |
| `SEND_TIMEOUT_MS` | 10 000 |
| `PRESEND_MARGIN_MS` | 5 000 |
| `LATE_WINDOW_MS` | 2 000 (in memory only) |
| `MAX_SKEW_MS` | 2 000 |

None of these can be set through options.

### 3.2 Templates

Per D3, this copy is for offline mock tests only. Final copy and language remain an owner choice.

**Inputs** come only from the SQL facts object (§4.2) and the guest's `first_name`.
- Amounts use a USD-only formatter: integer minor units → `"$1,234.56 USD"`.
- Dates are ISO `YYYY-MM-DD`.

**Never in a message:** addresses, door codes, tokens, links, labels, provider ids, or any id other than the booking ref.

| Template | Subject | Body essentials |
|---|---|---|
| `booking_confirmed` | "Your maraVilla booking {ref} is confirmed" | Dates, nights, guests; "We have charged {amount} to your card." |
| `not_charged_authorization_may_show` | "Your maraVilla booking {ref} could not be completed — you were not charged" | Not completed; **not charged**; the temporary authorization **has been released**; banks may show it as pending for a few days (no number of days is promised). |
| `not_completed_not_charged` | "Your maraVilla booking {ref} was not completed — you were not charged" | Not completed; the reservation **has been cancelled**; **not charged**; the same neutral pending sentence. |

Every factual claim in the copy maps to a positive SQL proof in §5. The "released" and "cancelled" sentences rest on persisted evidence, not on the absence of a capture.

### 3.3 Function contracts

Nothing here throws on data. Only programming errors throw.

**`buildMessageRequest({ facts, guest, sender, opId })`**
- **Returns** `{ ok:true, request }` or `{ ok:false, code }`.
  - Codes: `RENDER_FACTS_INVALID | RECIPIENT_INVALID | SENDER_INVALID | CURRENCY_NOT_SUPPORTED`.
- **`request`** is deep-frozen, with exactly these own keys: `{ channel:'email', to, from, fromName, subject, text, template, templateVersion, messageRef }`.
  - `messageRef = 'gn1-' + opId`. It is a correlation marker, NOT an idempotency guarantee.
  - No HTML, attachment, CC/BCC or reply-to.
- **Recipient.** `to = guest.email`.
  - It must match `^[a-z0-9._+-]{1,64}@([a-z0-9-]{1,63}\.)+invalid$` and be ≤ 254 characters.
  - This is a test-address restriction, **not** transport authentication.
- **Sender.** `sender` must be exactly `{ fromAddress, fromName }`.
  - `fromAddress` follows the same `.invalid` grammar.
  - `fromName` matches `^[A-Za-z0-9 .'-]{1,64}$`.

**`contentHash(request)`**
- The value is the sha256 hex of the UTF-8 bytes of `'gn-v1-content\n' + canonical(request)`.
- **`canonical`** is a JSON object:
  - keys sorted by code unit (the JS default sort), no whitespace;
  - strings encoded with `JSON.stringify`;
  - only strings and safe integers allowed (no floats, null, arrays or nested objects);
  - no Unicode normalisation; the text is hashed as given.
- **TRUST:** the DB stores this digest. It cannot re-derive or validate the rendered text from it (§4.3).

**`classifyReply(reply)`** — the ONE reply notation.
- It returns `{ kind:'accepted', providerMessageId }` only when all of these hold:
  - `reply` is a plain object (prototype `Object.prototype` or `null`);
  - its own enumerable string keys are exactly `accepted` and `providerMessageId`, both data properties, read with `Object.getOwnPropertyDescriptors` inside a try (no getters);
  - `accepted === true`;
  - `providerMessageId` is a string matching `^mock-[A-Za-z0-9._:-]{1,95}$` (the synthetic rule for offline v1).
- Anything else returns `{ kind:'unknown', code }`, with `code` either `REPLY_SHAPE` or `REPLY_UNREADABLE`.
- v1 has **no** definite-refusal class (§8.1). Every reply that is not accepted is unknown.

`accepted` means "invoked, and the mock said accepted". It never means delivered or read.

## 4. Render binding: freeze at claim (R1)

### 4.1 Why one immutable render per op is enough

- A notification qualifies only while `intents.version = op.source_version` (§5.2, rule C1). That means the intent has not changed since the producing transition.
- Every change to an intent bumps its version (`0001:159–162`).
- From a terminal state the only move is to `reconciliation_required` (`0001:188–190`). From there, no accepted event emits `guest.notify` (§1.1).
- **So once the version drifts, no later version can legitimately qualify that row.** A render bound to the producing version is the only render that could ever be valid.
- Revisions would add state and buy nothing. **Chosen mechanism: freeze.**

### 4.2 The SQL facts object

Produced by `booking.guest_notification_facts(p_op)`: private, SQL-derived, non-PII. It is a `jsonb` object with:
- **Common keys:** `v:1`, `template`, `ref`, `checkIn`, `checkOut`, `nights`, `guests`, `totalMinor`, `currency`.
- **Proof ids for `booking_confirmed`:** `piId`, `captureLedgerId`, `captureOpId`, `piEvidenceId`, `offlineChargeId`, `recordingOpId`, `settledEvidenceId`, `reservationId`.
- **Proof ids for `not_charged_authorization_may_show`:** `piId`, `piCanceledEvidenceId`, `legEvent`.
- **Proof ids for `not_completed_not_charged`:** the released keys plus `reservationId` and `cancelEvidenceId`.

**`facts_hash`** = `encode(sha256(convert_to('gn-v1-facts\n' || facts::text, 'UTF8')), 'hex')`.
- The `jsonb` text form is deterministic for a given value.
- JS never computes `facts_hash`; it only echoes the value SQL returned.

### 4.3 What SQL re-derives, and what stays TRUST

| Field | Origin | Re-derived by SQL at claim and pre-send? |
|---|---|---|
| `intent_version`, `template`, `facts`, `facts_hash` | SQL | Yes |
| `recipient_hash` = sha256 hex of `'gn-v1-recipient\n' \|\| email \|\| '\n' \|\| first_name`, from the CURRENT guest row | SQL | Yes |
| `content_hash`, `template_version`, `message_ref` | Caller (JS, §3.3) | **No — TRUST.** Stored and echoed only. |
| `worker` | Caller's `p_worker` | Equality only: it must equal the op lease owner and the work-lease owner |

What the hashes do and do not prove:
- They are **pseudonymous attestations**. They are not proof of content and not anonymous data.
- `recipient_hash` (email plus first name) can be guessed with a dictionary, so it is personal data. See N3; per D4 the report role cannot read it.
- `content_hash` proves only that the JS presented the same bytes at claim and at pre-send.

### 4.4 Table `booking.notification_renders` (PROPOSED in 0016)

| Column | Notes |
|---|---|
| `operation_id` | uuid PK → `external_operations`; one per op, ever |
| `intent_id` | |
| `template`, `template_version`, `intent_version` | `template_version` is `'gn-v1'`; `intent_version` = `source_version` |
| `facts` (jsonb), `facts_hash`, `recipient_hash`, `content_hash` | Each hash is 64-char hex, CHECKed |
| `message_ref` | `'gn1-' \|\| operation_id`, CHECKed |
| `worker` | 1–100 chars |
| `claimed_at` | DB `clock_timestamp()` |

- **Writer:** only `claim_guest_notification`, in the same transaction as the claim UPDATE.
- **Append-only:** UPDATE, DELETE and TRUNCATE are refused by `reject_change`.
- **Access:** RLS SELECT for app and admin; **no report grant** (D4); no write grant to any role.

**Replay equality.** Here "replay" means the pre-send comparison (§6.4). Every field except `claimed_at` must match:

| Render fields | Must equal |
|---|---|
| `intent_version`, `facts_hash`, `recipient_hash` | the current SQL facts |
| `template`, `template_version`, `content_hash`, `message_ref` | the frozen request |
| `worker` | the caller |

Matching hashes alone are never enough.

### 4.5 The cases root listed

| Case | Behaviour |
|---|---|
| Concurrent renderers | No pre-claim render is ever persisted. Two claimers serialise on the op `FOR UPDATE` lock (§6.2); the second sees `attempts = 1` or an existing render row → `NOT_CLAIMABLE`. |
| Re-render | Never happens. No revision table, replacement op, new key or attempts reset (§8). |
| Revision limit or selection | There is exactly one row, so there is nothing to select. |
| Recipient purged before claim | Latch `RECIPIENT_MISSING`. |
| Recipient purged after claim | The claim holds the guest row `FOR KEY SHARE`, which blocks the purge DELETE until the claim commits. After commit, a purge makes pre-send fail with `RECIPIENT_CHANGED` → **no invocation**, and the row → unknown (§6.5). |
| Recipient reinserted | The app can only INSERT (`0002:29–31`). Same email and first name → same hash → the row proceeds (same addressee). If either differs, a latch before the claim or an abort at pre-send, as above. |
| Sender or template drift | The request is built once per step and deep-frozen; its `content_hash` is bound at claim. A process with different config can never act on a claimed row, because there is no re-claim. Before the claim nothing persisted can drift. |
| Crash after render, before claim | Cannot occur as a persisted state: the render INSERT and the claim UPDATE commit together or not at all. A crash after building the in-memory request leaves nothing behind. |
| Claim COMMIT ambiguous | The worker stops: no send, no further query. The lease expires and maintenance marks the row unknown (§6.5). sends = 0. |

## 5. Qualification predicates (R3)

### 5.1 Persisted facts and existing enforcement (PRESENT)

| Fact | Table and source | Existing enforcement relied on |
|---|---|---|
| Money ledger | `payment_ledger` (`0001:478–493`); entries written in `sideRecords` (`repo.js:173–212`) | Append-only (`:490–493`). `UNIQUE(entry, provider, provider_ref)` (`:489`) allows at most one `capture_succeeded` per PI. The same ref on another intent aborts the transition (`repo.js:178–181`). |
| Intent PI | `intents.stripe_payment_intent_id`, UNIQUE (`0001:77`); `captured_minor` (`:84`); `currency` ∈ {MXN, USD} (`:63`) | One PI per intent row |
| Money on a second PI | Ledger `authorization_rejected` (`repo.js:192–197`) | Recorded on a mismatch or a closed intent |
| Capture rows | `external_operations` of type `stripe.capture_payment_intent` | 0007 claim fence. The capture worker does a confirming read before success (`capture-worker.js:23–25`, `:454–464`). |
| PI evidence | `provider_evidence` of kind `payment_intent` (`0003:52–75`); allowed statuses at `0003:82–83` | Append-only (`:73–76`). Strict v3 checks (`capture-proof.js:54–94`, `compensation-proof.js:171`) run **in JS at transition time — TRUST**. |
| Void and authorization-gone | Events `VOID_SUCCEEDED` (`compensation-worker.js:452`, `recovery-plan.js:327`) and `RECONCILED_AUTHORIZATION_GONE` (`compensation-worker.js:376`, `recovery-plan.js:307`). Ledger `authorization_voided` is written on VOID only (`repo.js:208–210`). | The JS re-checks the canceled evidence inside the transition transaction (`compensation-worker.js:376–380`, `:452–460`) — TRUST |
| Reservation cancel | Event `RESERVATION_CANCELLED` (`compensation-worker.js:555`, `recovery-plan.js:361`). Evidence of kind `hostaway_reservation`, status ∈ {found_active, cancelled, not_found} (`0003:85–91`). | Identity checks in JS (`compensation-worker.js:540–560`, `recovery-plan.js:350–361`) — TRUST |
| Create attempts | `hostaway_reservation_attempts` (`0001:435–450`); state set at `:440–441` | UNIQUE per intent |
| Recording | `recording_latest_id` (`0010:30–37`), `recording_active_hold_id` (`0011:355–359`), `recording_conflict_refusal` (`0011:340–353`, private) | Completion, link and finalisation (`0011:363–454`) |
| Refunds | `payment_refunds` (`0001:497–533`) | The guard caps the non-failed total at `captured_minor` (`:515–531`). With captured 0, only `failed` rows can exist. |
| Payment attempts | `payment_attempts`; status set at `0001:305` | |
| Webhooks | `stripe_webhook_events` (`0001:555–567`); `intent_id` is nullable | |
| Cases | `reconciliation_cases` (`0001:536–549`); one open case per (intent, kind) | |
| Transitions | `intent_transitions` (`0001:207–221`: `event_type`, `event_id`, `version_after`) and `intent_applied_events` (`0001:228–235`) | Append-only |

### 5.2 The predicate `booking.guest_notification_refusal(p_op) RETURNS text`

- Private. NULL means the row qualifies.
- Rules are evaluated in order; the first failing rule returns its code.
- Notation: `I` = the intent row, `O` = the op, `P` = `I.stripe_payment_intent_id`, `R` = `I.hostaway_reservation_id`.

**Common rules C1–C10 (every template)**

- **C1:**
  - `O.op_type = 'guest.notify'`;
  - `O.payload ->> 'template'` ∈ TEMPLATES;
  - `I.version = O.source_version`.
  - Else `VERSION_DRIFT`.
- **C2:** `I.state` is the template's target state (confirmed / authorization_released / cancelled). Else `STATE_MISMATCH`.
- **C3:** the guest row exists. Else `RECIPIENT_MISSING`.
- **C4:** **no open reconciliation case of ANY kind** for `I`: `NOT EXISTS (SELECT 1 FROM reconciliation_cases WHERE intent_id = I.id AND status = 'open')`. Else `OPEN_CASE`. This is the exact case predicate; no case category is involved.
- **C5:** no `payment_refunds` row for `I`, in any state. Else `REFUND_PRESENT`.
- **C6:** no `payment_attempts` row for `I` in `creating`, `open` or `outcome_unknown`. Else `PAYMENT_ATTEMPT_OPEN`.
- **C7:** returns `FOREIGN_PAYMENT_INTENT` if either:
  - a ledger `authorization_rejected` exists for `I`; or
  - a ledger row, PI evidence or capture op of `I` references a PI other than `P`.
- **C8:** `I.currency = 'USD'`. This is the v1 scope; it is also a scope class (§7.1).
- **C9:** no capture, void, cancel, create or recording op of `I` in `in_flight`, `outcome_unknown` or `escalated`. Else `OPERATION_UNSETTLED`.
- **C10 (`booking_confirmed` only):** no active recording hold (checked via `recording_active_hold_id`) and no open `OFFLINE_CHARGE_HOLD_%` case (already covered by C4).

**`booking_confirmed`** — the copy says "confirmed" and "we have charged {amount}".

- **K1:** `CAPTURE_NOT_PROVEN` unless both hold:
  - `P` is not NULL;
  - there is exactly one ledger `capture_succeeded` for `I` with `provider_ref = P`, `amount_minor = I.final_total_minor = I.captured_minor` and `currency = I.currency`.
- **K2:** `CAPTURE_HISTORY` unless both hold:
  - exactly one capture op with `payload ->> 'paymentIntentId' = P` is `succeeded`;
  - every other capture op of `I` is `failed_definite`, or is `superseded` or `pending` with `dispatched_at IS NULL`.
- **K3:** the latest `payment_intent` evidence for `P` (by `observed_at DESC, created_at DESC`) must:
  - have status `succeeded`;
  - have `observed_at ≥` the `dispatched_at` of the K2 op;
  - have `observed ->> 'amountReceivedMinor' = I.captured_minor`.
  - In addition, no PI evidence for `P` may show a positive `amountRefundedMinor` or `refunded = true`.
  - Codes: `PI_EVIDENCE_MISSING` when no such evidence exists, `PI_EVIDENCE_CONTRADICTS` when it fails a condition.
- **K4:** `RECORDING_NOT_PROVEN` unless all hold:
  - `I.offline_charge_id` is not NULL;
  - there is exactly one ledger `offline_charge_recorded` for `I` with `provider_ref = offline_charge_id` and the same amount and currency;
  - `recording_latest_id(I)` is `succeeded`, linked (`settled_evidence_id` not NULL), with `result_ref = offline_charge_id`;
  - `recording_conflict_refusal(...) IS NULL`.
- **K5:** `RESERVATION_CONTRADICTED` unless all hold:
  - `R` is not NULL;
  - the latest `hostaway_reservation` evidence for `R`, if any, is not `cancelled` or `not_found`;
  - no cancel op is `succeeded`.

**`not_charged_authorization_may_show`** — the copy says "not charged", "authorization released" and that the booking was not made.

- **A1:** `MONEY_PRESENT` unless all hold:
  - `I.captured_minor = 0`;
  - no ledger `capture_succeeded`, `offline_charge_recorded` or `refund_succeeded` for `I`;
  - no capture op is `succeeded`.
- **A2 (positive release proof):** `RELEASE_NOT_PROVEN` unless all hold:
  - at least one `payment_intent` evidence for `P` has status `canceled`;
  - the latest PI evidence for `P` is `canceled`;
  - no PI evidence for `P` has status `succeeded` or `amountReceivedMinor > 0`;
  - the canceled evidence has `observed_at ≥` the latest `dispatched_at` of any capture op for `P`.
- **A3:** the transition with `version_after = I.version` has `event_type` ∈ {`VOID_SUCCEEDED`, `RECONCILED_AUTHORIZATION_GONE`}. Else `RELEASE_NOT_PROVEN`. This binds the copy to the leg event that was actually applied.
- **A4 (no booking):** `RESERVATION_PRESENT` unless both hold:
  - `R` is NULL;
  - the create attempt is absent, or is `refused` with `hostaway_reservation_id IS NULL`.

**`not_completed_not_charged`** — the copy says "not charged", "reservation cancelled", plus the pending sentence.

- **X1:** same as A1.
- **X2:** same as A2. This is the authorization leg, because a `capture_failed` intent held an authorization.
- **X3 (positive cancel proof):** `CANCEL_NOT_PROVEN` unless all hold:
  - `R` is not NULL;
  - the latest `hostaway_reservation` evidence with `external_ref = R` is `cancelled`;
  - no `found_active` for `R` was observed after it;
  - if a cancel op for `R` was dispatched, the cancelled evidence has `observed_at ≥` its `dispatched_at`.
- **X4:** `intent_transitions` for `I` contains, after the entry into `capture_failed`, a `RESERVATION_CANCELLED` and one of `VOID_SUCCEEDED` or `RECONCILED_AUTHORIZATION_GONE`. Else `CANCEL_NOT_PROVEN`.

**Freshness, scope and reference rules.**
- The predicate reads only committed rows: at the statement snapshot (pre-send) or after the locks (claim).
- There is no age requirement on the evidence. The evidence proves a past provider state, accepted by the reviewed transition path.
- It does **not** prove the current provider state. There is no provider read and no general guarantee of fresh provider data.
- Every reference is scoped exactly to `I`, `P` and `R`.

**TRUST limits.**
- The SQL shadow checks status, reference, amount and ordering. The strict v3 shape (`accountVerified`, `livemode`, `captureBefore`, full reservation identity) is enforced only by the reviewed JS, at transition time.
- `recording_conflict_refusal` is authoritative only over committed evidence.
- Evidence committed after the decision instant is out of reach (§6.6).

## 6. Claim and concurrency (R4)

### 6.1 Generic claim exclusion (a JS advisory mirror in `operations.js`)

- Add `NOTIFY_FENCE = "o.op_type <> 'guest.notify'"` to BOTH the candidate stage and the locked stage of `claimNextOperation`, as with the existing fences.
- No generic caller can then select a notify row, skip-loop on one, or starve behind one, with or without `opId`.
- Callers at `2e20972a`: recording-worker, reservation-worker, capture-worker, compensation-worker, stripe-test-webhook, compensation-proof. None claims notify rows today.

### 6.2 `booking.claim_guest_notification`

**Signature.** `booking.claim_guest_notification(p_op uuid, p_worker text, p_template_version text, p_content_hash text, p_expected_facts_hash text, p_expected_recipient_hash text) RETURNS jsonb`.
- SECURITY DEFINER, with `search_path = pg_catalog, booking`.
- EXECUTE is granted to `mv_booking_app` only.

**Phase 1 — validate and lock.**
1. **Validate arguments.** A malformed uuid, worker, hash or version raises `22023`. These are programming errors and throw.
2. **Read** `O.intent_id` and `O.op_type` without a lock. If the op is not a notify op → `{status:'not_claimable', code:'NOT_NOTIFY'}`.
3. **Lock** `intents` `FOR SHARE`. If the intent is protected (§7.2) → `{status:'protected'}`, with **no write of any kind**.
4. **Lock** `intent_work` `FOR SHARE`.
5. **Lock** the op in `external_operations` `FOR UPDATE`.
6. **Lock** `intent_guests` `FOR KEY SHARE` (when the row exists).
7. **Take** `pg_advisory_xact_lock(hashtext('booking.recording_evidence'), hashtext(intent::text))`. This is the 0010/0011 key, so the claim serialises with evidence writers, link and finalisation.
8. **Set** `v_t := clock_timestamp()` **after all locks**. This is the decision clock.

**Phase 2 — decide.**
9. **Not claimable** if either:
   - `O.state <> 'pending'`, `attempts <> 0`, `dispatched_at IS NOT NULL`, a render row exists, or a latch exists → `{status:'not_claimable', code}`;
   - `p_worker` does not hold the work lease with `work_lease_until ≥ v_t + OP_LEASE_MS` → `{status:'not_claimable', code:'WORK_LEASE'}`.
10. **Qualify** with `r := guest_notification_refusal(p_op)`:
    - a WAITING or OUT_OF_V1_SCOPE code → `{status:'waiting', code}`, with no write;
    - any other code → INSERT the latch (§7.3) → `{status:'latched', code}`.
11. **Compare the snapshot.** If the current `facts_hash` or `recipient_hash` differs from the expected value → `{status:'not_claimable', code:'SNAPSHOT_STALE'}`, with no write. The next step takes a new snapshot; a real fact change bumps the version and latches.

**Phase 3 — write.**
12. INSERT the render row (§4.4) with `claimed_at = v_t`. Then `UPDATE … SET state='in_flight', attempts=1, dispatched_at=v_t, lease_worker_id=p_worker, lease_until=v_t + OP_LEASE_MS, updated_at=v_t`.
13. Return `{status:'claimed', leaseUntil, dbNow:v_t}`.

### 6.3 Authoritative triggers

These apply to every path, including raw UPDATEs and privileged sessions.

**`notify_op_fence`** — BEFORE INSERT OR UPDATE, for `op_type = 'guest.notify'` only.
- **INSERT** is accepted only when:
  - `idempotency_key = 'notify:' || intent_id || ':' || template`;
  - the payload is exactly `{template}`, with a template in TEMPLATES;
  - `retry_class = 'idempotent'`;
  - no other notify row exists for the intent.
- **`pending → in_flight`** is accepted only when:
  - `is_privileged()` holds, i.e. it comes through §6.2 (the app role cannot claim by raw UPDATE);
  - `OLD.attempts = 0`, `OLD.dispatched_at IS NULL` and `NEW.attempts = 1`;
  - the intent is not protected and the row is not latched;
  - `guest_notification_refusal IS NULL` at `clock_timestamp()`.
- **`in_flight → succeeded`** is accepted only when:
  - `is_privileged()` holds (the dedicated completion, §6.5);
  - `result_ref` matches the mock id grammar;
  - a render row exists.
- **`in_flight → outcome_unknown`** is allowed for any role. It is the fail-safe direction, used by `markUnknown`.
- **Refused for everyone, the owner included:**
  - `→ pending` from any state;
  - `in_flight → failed_definite`;
  - `in_flight → escalated`;
  - `pending → superseded` and `pending → escalated` (no writer exists today; `repo.js:234–247` touches other op types only).
- **Same-state UPDATEs** are refused when they change any of: `attempts`, `dispatched_at`, `lease_worker_id`, `lease_until`, `result_ref`, `completed_at`, `next_attempt_at`, `requires_provider_read`, `late_result_status`, `late_result_ref`.

**`notify_claim_binding`** — AFTER UPDATE `WHEN (OLD.state='pending' AND NEW.state='in_flight' AND NEW.op_type='guest.notify')`.
- It re-checks, at its own instant, that a render row exists with `worker = NEW.lease_worker_id`, `intent_version = source_version` and `claimed_at = NEW.dispatched_at`.
- A refusal aborts the statement. This is the 0012 claim-audit pattern (`0012:560–580`).

### 6.4 Pre-send snapshot `booking.guest_notification_presend(p_op, p_worker) RETURNS jsonb`

- SECURITY DEFINER and declared **STABLE**, so every read sees the single snapshot of the calling statement.
- **Returns:** `{ok, code, dbNow, opLeaseUntil, workLeaseUntil, contentHash, templateVersion, messageRef}`.
- **`ok` requires:**
  - the op is `in_flight`, with `attempts = 1`, `lease_worker_id = p_worker`, and render `worker = p_worker`;
  - `I.version = render.intent_version`;
  - `guest_notification_refusal IS NULL`;
  - the current `facts_hash` and `recipient_hash` equal the render's;
  - the intent is not protected.
- It takes **no locks**.

**JS then checks the following, with no `await` in between:**
- `contentHash(frozenRequest) = contentHash`, with the same `templateVersion` and `messageRef`;
- `opLeaseUntil − dbNow ≥ SEND_TIMEOUT_MS + PRESEND_MARGIN_MS`, and the same for the work lease;
- |JS clock − `dbNow`| ≤ `MAX_SKEW_MS`.

It then starts `sendMessage(frozenRequest, { signal })` synchronously.

**What this guarantees:** the request equals what was bound at claim, and every fact qualified at ONE consistent snapshot taken immediately before the call.

**What it does not guarantee:** that the facts are still true when the mock, or a future provider, processes the request (§6.6).

### 6.5 Settlement

**`booking.complete_guest_notification(p_op, p_worker, p_kind text, p_ref text, p_code text) RETURNS text`** (SECURITY DEFINER)
- **Locks:** intent SHARE → op FOR UPDATE, then reads `v_t`.
- **With a live lease** (owner `p_worker`, `v_t ≤ lease_until`) it returns the new state:
  - `accepted` → `succeeded`, `result_ref = p_ref`, `completed_at = v_t`;
  - `unknown` → `outcome_unknown`, `error_code = p_code`, plus the case below.
- **Without a live lease** it returns `'LEASE_LOST'` and writes **nothing**. A late reply is observed in memory only, within `LATE_WINDOW_MS`.

**JS changes in `operations.js` (D1 = A)**
- **(i)** `markUnknown` gets a first branch for `op.op_type === 'guest.notify'`:
  - → `outcome_unknown` plus `openCase('NOTIFICATION_OUTCOME_UNKNOWN', 'op:'+id, {operationId, opType, errorCode})`;
  - independent of `retry_class` and `attempts`;
  - covers completion and both maintenance paths.
- **(ii)** `completeOperation(succeeded)` on a notify row returns `{ok:false, error:'NOTIFY_SUCCESS_REQUIRES_DEDICATED_COMPLETION'}`. The decision is made from the immutable `op_type` before any transaction, following the recording pattern (`:169–171`).

**Scoped maintenance.** The step calls the existing phase-guarded `recoverExpiredOperations({opTypes:['guest.notify'], listingIds, intentId, intentStates:[confirmed, authorization_released, cancelled, reconciliation_required]})`.
- This path is intent-first (`operations.js:428–447`).
- Protected rows can never be `in_flight` (§6.3), so maintenance never touches them.

**Persisted error codes (codes only):**

| Code | Meaning |
|---|---|
| `SEND_TIMEOUT` | The bounded call timed out |
| `SEND_THREW` | The executor threw or rejected |
| `REPLY_SHAPE` | The reply did not match the grammar |
| `REPLY_UNREADABLE` | The reply could not be read safely |
| `PRESEND_ABORTED_NOT_INVOKED` | Claimed, but the pre-send check failed; `sendMessage` was NOT called |
| `LEASE_EXPIRED` | Set by maintenance |

### 6.6 Lock order (library paths)

| Path | Order |
|---|---|
| `claim_guest_notification` | intent SHARE → work SHARE → op UPDATE → guest KEY SHARE → advisory evidence key → `v_t` |
| `complete_guest_notification` | intent SHARE → op UPDATE → case INSERT (FK KEY SHARE on intent) |
| `complete_recording_with_evidence` | intent SHARE → work SHARE → op UPDATE → advisory (`operations.js:184`). Same prefix order as the claim. |
| Generic `claimNextOperation` | intent SHARE → work SHARE (recordings only) → op UPDATE SKIP LOCKED. **Never a notify op.** |
| Phase-guarded maintenance | intents SHARE (ordered by id) → ops UPDATE SKIP LOCKED → case INSERT |
| Global maintenance (op-first) | op UPDATE SKIP LOCKED → case INSERT. SKIP LOCKED never waits on a claimed op, and no intent lock is taken. |
| Evidence writers | read-op UPDATE → evidence INSERT (FK KEY SHARE on intent) → advisory (`0010:359`, `:385–388`). They hold no intent or notify-op lock that the claim waits for in reverse, so there is no cycle. |
| E3 transition or case opening (`applyEvent`) | intent UPDATE, which conflicts with SHARE. Serialised with claim and pre-send: if it commits first, the claim sees drift and latches; if it commits after, see the race note below. |
| `purge_guest_data` | guest-row DELETE, no intent lock (`0005:141–150`). It waits on the claim's KEY SHARE; the claim never waits on purge-held locks in reverse. |
| Work claim (§7.1) | `intent_work` UPDATE SKIP LOCKED only, as in `repo.js:652–661` |

**Direct-UPDATE residual (not a library path).** A raw UPDATE of a notify op locks the op row first; the BEFORE trigger then reads intent and guest facts. A raw UPDATE racing an intent-first path can therefore yield `40P01`, exactly as with the 0007, 0009 and 0011 fences. The deadlock aborts one transaction and never claims.

**Unavoidable race.**
- A contradiction, late money, hold or case can be committed after the pre-send snapshot, or while the mock is processing the request, and so coincide with a sent message.
- It is visible afterwards (case, hold or ledger). It is never "un-sent".
- This contract does **not** claim that a message cannot become stale after that snapshot.

## 7. Visibility, eligibility, latches and unknowns (R2)

### 7.1 Eligibility classes

Computed by SQL `booking.guest_notification_class(p_op)` and evaluated before LIMIT everywhere.

| Class | Exact condition | Action |
|---|---|---|
| PROTECTED | §7.2 | **Zero action:** not a candidate, never latched, no case, no render, not in the page |
| SUCCEEDED / IN_FLIGHT / UNKNOWN | The op state | None. Maintenance handles expired `in_flight` rows only. |
| LATCHED | A latch row exists | None, ever, in v1 |
| OUT_OF_V1_SCOPE | `I.currency <> 'USD'`, OR the guest email does not match the `.invalid` grammar | Not a candidate; no write; listed with its code |
| WAITING | A `stripe_webhook_events` row exists with `intent_id = I.id AND status IN ('received','failed_retryable')` | Not a candidate; no write; listed. Becomes a candidate only once the event row is processed or ignored. This is not an owner override. |
| ELIGIBLE | Pending, attempts 0, and none of the above | A candidate: claimed or latched in one step |

**Work claim.** `booking.claim_notification_work(p_worker, p_listing_ids int[], p_intent uuid, p_lease_ms int) RETURNS uuid`:
- selects the oldest ELIGIBLE op (`ORDER BY created_at, id`) whose intent is in scope;
- locks its `intent_work` row `FOR UPDATE SKIP LOCKED`, only when no lease is live;
- sets `work_worker_id` and `work_lease_until = clock_timestamp() + WORK_LEASE_MS`.

**Progress argument.**
- Every selected row leaves ELIGIBLE after one step: it is either claimed or latched.
- The only exception is `SNAPSHOT_STALE`, which requires a concurrent fact change.
- So there is no hot loop and no starvation of other notify rows.

### 7.2 The protected predicate

It is evaluated at intent level and follows every reservation reference. The intent is protected if ANY of these values is in {70636076, 71045356, 71072615, 71081885}:
- `I.hostaway_reservation_id`;
- any `hostaway_reservation_attempts.hostaway_reservation_id` for `I`;
- any `provider_evidence.external_ref` of kind `hostaway_reservation` or `hostaway_offline_charges` for `I`;
- any op payload `reservationId` for `I`.

It is evaluated in:
- the work-claim selection, before LIMIT;
- the claim, under the intent lock;
- pre-send, the page and the summary.

### 7.3 Table `booking.notification_latches`

| Column | Notes |
|---|---|
| `operation_id` | PK |
| `intent_id` | |
| `code` | A `booking.is_code` value from §5.2, or `RENDER_FAILED` |
| `intent_version_seen` | |
| `latched_at` | DB clock |
| `worker` | |

**Writers.** The table is append-only, and each row is written once, by one of:
- `claim_guest_notification`, with an SQL-derived code;
- `booking.latch_guest_notification(p_op, p_worker, 'RENDER_FAILED')`. This takes the same locks and refuses if the row is not ELIGIBLE. The code is TRUST: it records that the JS could not render.

**Policy.** No requalification, override or case in v1 (D2, N1). A latched row stays `pending` forever and stays visible.

**Grants.** SELECT for app and admin; no report grant (D4).

### 7.4 Unknown

- An unknown row is `outcome_unknown` plus a `NOTIFICATION_OUTCOME_UNKNOWN` case opened as `op:{id}`. In v1 it stays **durable and unresolved**, because no closing path exists today:
  - `admin_resolve_operation` → `NOT_SUPPORTED` (`0005:363–364`);
  - `admin_close_case` → `OPERATION_CASE_USE_ADMIN_RESOLVE_OPERATION` (`0011:539–541`).
- The case blocks guest purge for that intent (`0005:146`; see N2).
- No owner resend capability exists or is proposed. A future owner notification-resolution slice would need its own evidence, audit and permission design, and must keep the no-second-claim invariant (§8.1).

### 7.5 Read-only page `booking.list_guest_notifications(p_listing_ids, p_after uuid, p_limit int)`

- App and admin only.
- Rows: `{opId, intentId, template, state, class, code, createdAt}`.
- No hashes and no guest data. Protected rows are excluded.
- Keyset paging by `(created_at, id)`. LIMIT is between 1 and 100.

## 8. Lifecycle, upgrade and down invariant map (R5)

### 8.1 Changes to a notify row after 0016

| Change | Allowed? | Enforced by |
|---|---|---|
| INSERT pending, attempts 0 | Only with the canonical key and payload, and at most 1 per intent | `0004:47–51` + `notify_op_fence` |
| `pending → in_flight` (attempts 0 → 1, `dispatched_at`, lease) | Only through `claim_guest_notification`, with the render binding | Fence + binding trigger |
| `pending → superseded` or `pending → escalated` | **Refused** | Fence |
| `in_flight → succeeded` | Only through `complete_guest_notification` (live lease, DB clock) | Fence + `operations.js` change (ii) |
| `in_flight → outcome_unknown` | Any role (markUnknown or the dedicated completion) | Fence allows it |
| `in_flight → pending`, `in_flight → failed_definite`, `in_flight → escalated` | **Refused** | Fence |
| `outcome_unknown → pending`, even when privileged | **Refused** | Fence (`0003:446–450` already blocks the runtime role) |
| `outcome_unknown → succeeded`, `→ failed_definite`, `→ escalated` | Owner only, but no current owner function supports notify (§7.4) | `0003:446–450`, `0005:363–364` |
| Same-state change to attempts, dispatched_at, lease, result, completion, next_attempt_at, requires_provider_read or late_result_* | **Refused** | Fence |
| Render row UPDATE, DELETE or TRUNCATE | **Refused** | `reject_change` |
| A new key or a replacement op | Impossible: the key is immutable (`0004:53–56`), and the INSERT fence allows at most 1 notify per intent | |

**What the DB counts vs what the worker counts.**
- The DB guarantees at most ONE **claim** per notify row, ever: attempts go 0 → 1 once, the row never returns to pending, and no second row can exist.
- The DB **cannot count injected calls.** At most one **invocation** per claim is a property of the reviewed worker:
  - one call site, reached only after the pre-send check;
  - never retried;
  - `ctx.sends` is asserted in tests.
- A trusted executor can do arbitrary work. A `mock-` label or a `.invalid` address does not prove the executor is a mock.

### 8.2 Upgrade: 0016 up, race-safe

1. Take `LOCK TABLE booking.external_operations IN SHARE ROW EXCLUSIVE MODE`.
2. Refuse with `NOTIFY_UPGRADE_PRECONDITION` if ANY `guest.notify` row:
   - has `state <> 'pending'`, `attempts > 0`, `dispatched_at IS NOT NULL` or `lease_worker_id IS NOT NULL`;
   - has a non-canonical key or payload;
   - or is a second notify row for the same intent.
3. Create the tables, functions, triggers and grants.

At `2e20972a` no code claims notify rows, so the precondition holds on any database produced by the accepted code. A database touched by an ad-hoc generic dispatch is refused and left for owner review.

### 8.3 Down: 0016 down, race-safe and audit-preserving

**Procedure.**
1. Take `LOCK TABLE external_operations, notification_renders, notification_latches IN ACCESS EXCLUSIVE MODE`.
2. Refuse if any render or latch row exists, or any notify row has `attempts > 0` or `state <> 'pending'`.
3. Otherwise drop the triggers, functions and tables in dependency order.

**Equality.** Down equality is schema-only: `pg_get_functiondef`, ACLs and trigger lists equal a fresh 0015.

**JS compatibility.** The `operations.js` changes (NOTIFY_FENCE, the markUnknown notify branch, the success guard) **survive an SQL down**. They are safe against a fresh 0015:
- notify rows stay pending and cannot be claimed by generic code;
- the markUnknown branch never fires, because no notify row can be `in_flight` after an allowed down.

**Rollback order.** SQL down first, gated as above. Reverting the JS on its own would re-expose the generic resend path (§1.2). So revert the JS only together with the SQL, and never while a notify row could be claimed.

### 8.4 Tests for this map (future; disposable PG only)

- **Raw-UPDATE probes (app and privileged):** every refused change in §8.1, including `outcome_unknown → pending` as the owner.
- **Generic helpers:**
  - `claimNextOperation` returns null for notify rows, with and without `opId`, and is not starved by 100 notify rows;
  - `completeOperation(succeeded)` is refused;
  - `completeOperation(outcome_unknown)`, and both the global and phase-guarded `recoverExpiredOperations`, give `outcome_unknown` plus exactly one case — never pending;
  - `admin_resolve_operation` → `NOT_SUPPORTED`, and `admin_close_case` refuses.
- **Upgrade:**
  - the precondition refuses pre-existing attempted, in_flight or duplicate rows;
  - a concurrent writer blocks on the lock.
- **Down:**
  - a refused down leaves render, latch and op rows byte-equal (counts and row digests compared before and after);
  - an allowed down gives fresh-0015 equality.

## 9. Errors, redaction and the API surface (R6)

### 9.1 Outer DB errors

- Any error thrown by `pool.query` or by a transaction stops the step, with no further query or mutation.
- It is rethrown as the **identical object**; tests check `assert.equal(thrown, original)`.
- Such objects may contain query text, parameters or details with personal data. **They are not sanitized.**
  - The worker never logs, stringifies or wraps them.
  - Tests assert identity and never print `message` or `detail`.

### 9.2 Provider-error boundary

- An executor throw, rejection, timeout or abort becomes `unknown`, with a code from §6.5 only.
- The error object, message, stack and reply are **never read beyond `classifyReply`** (no `String(e)`). They are never persisted and never returned.
- Only a grammar-checked `providerMessageId` is persisted.

### 9.3 `runNotificationStep(pool, opts)` contract

**Options.** `opts` must be a plain object with exactly these own keys:

| Key | Rule |
|---|---|
| `env` | Plain object; `VERCEL_ENV` ∈ {development, preview}; `MV_E7_NOTIFICATION_WORKER === 'enabled'` |
| `workerId` | `^[A-Za-z0-9._:-]{1,100}$` |
| `listingIds` | 1–50 distinct positive int4 values |
| `intentId` (optional) | Lowercase canonical uuid |
| `sender` | As in §3.3 |
| `executors` | Exactly `{sendMessage: function, label: /^mock-[a-z0-9-]{1,40}$/}` |
| `clock` | Function returning a finite number |
| `hooks` (optional) | Test-only; frozen; functions only |

**Validation.**
- Unknown keys, wrong types or inherited properties → `{ok:false, code:'OPTIONS_INVALID'}`, with **zero queries**.
- The basis is a deep-frozen copy taken once: data values are copied, and function references are bound once.

**Return values.** Every return is deep-frozen.
- **On a completed step:** `{ok:true, outcome, sends}`, where `sends` is 0 or 1, and `outcome` is one of:

| Outcome | Extra fields |
|---|---|
| `idle` | — |
| `accepted` | `opId`, `template`, `contentHashPrefix` (8 hex) |
| `unknown` | `opId`, `template`, `code` |
| `latched` | `opId`, `code` |
| `waiting` | `opId`, `code` |
| `protected` | none (no ids) |
| `not_claimable` | `code` |
| `lease_lost` | `opId` |

- **On a gate refusal:** `{ok:false, code}`, where `code` is `OPTIONS_INVALID`, `ENV_REFUSED`, `DATABASE_NOT_TEST` or `CLOCK_SKEW`.

**Throws** only the identical outer DB error (§9.1), or a `TypeError` for an internal invariant break.

### 9.4 Redaction (narrowed guarantee)

**Guaranteed PII-free:**
- step return values;
- persisted `error_code`;
- case evidence (`{operationId, opType, errorCode}`);
- latch codes;
- page rows.

**Not guaranteed:**
- raw DB error objects (§9.1);
- the executor's own behaviour.

**Test and tool logs** never print a recipient, name, subject, body or request. Assertions compare hashes or use synthetic constants.

## 10. The step, end to end (PROPOSED)

1. **Gate**, then the test marker, then the skew check.
2. **Scoped maintenance** (§6.5).
3. **`claim_notification_work`.** If nothing is claimed → `idle`.
4. **Snapshot** with `guest_notification_snapshot(op)`: ONE SECURITY DEFINER, STABLE statement returning `{class, code, facts, factsHash, recipientHash, email, firstName}` to the app role. If the class is not ELIGIBLE → release the work lease → `waiting` or `protected`, with no write.
5. **`buildMessageRequest`.** On failure → `latch_guest_notification(RENDER_FAILED)` → `latched`.
6. **`claim_guest_notification(…, contentHash(request), factsHash, recipientHash)`** → `claimed`, `latched`, `waiting`, `protected` or `not_claimable`.
7. **Pre-send** (SQL snapshot plus the JS checks). On failure → `complete_guest_notification(unknown, PRESEND_ABORTED_NOT_INVOKED)`, with sends 0.
8. **ONE bounded `sendMessage`** within `SEND_TIMEOUT_MS`; `sends = 1`. Then `classifyReply`.
9. **`complete_guest_notification(accepted | unknown)`.** `LEASE_LOST` → kept in memory only.
10. **Release** the work lease.

**Crash matrix.** Recovery uses persisted facts only and never resends.

| Crash point | Persisted state | Next |
|---|---|---|
| Before the claim commits | Nothing (or a latch) | Re-evaluated by class |
| Claim commit ambiguous | Pending, or in_flight plus a render | Pending → re-evaluated. In_flight → lease expiry → unknown (`LEASE_EXPIRED`), sends 0. |
| After the claim, before or after invocation, before completion | In_flight plus a render | Lease expiry → unknown plus a case; never re-invoked |
| Completion commit ambiguous | Succeeded or in_flight | Either is safe; never resent |

## 11. Relation to the 0015 scoped inbox

- The two are invoked separately. The step never uses the inbox `drained` flag, which is not proof.
- `booking_confirmed` relies on the synchronous `recording_conflict_refusal` (K4) and on the hold and case checks (C4, C10). These run under the same advisory key as the evidence writers.
- A hold that the inbox opens later latches any confirmation not yet claimed (C4, C10).

## 12. Planned deterministic tests (future slice; unit + disposable PG + mock; no network)

1. **Unit:**
   - templates, with USD formatting and the exact copy;
   - the request grammar, the canonical encoding and `contentHash` test vectors;
   - `classifyReply` against getters, proxies, extra keys, `accepted: 'true'` and bad ids;
   - option validation with zero queries, and deep-freeze;
   - no PII in return values.
2. **Predicates.** Every code in §5.2, positive and negative, including:
   - a second PI;
   - a refund in each state, and a failed refund with captured 0;
   - an unknown capture op;
   - PI evidence `succeeded` on a "not charged" intent;
   - canceled evidence older than a capture dispatch;
   - a `found_active` after a `cancelled`;
   - a missing leg event;
   - a legacy MXN intent → OUT_OF_V1_SCOPE.
3. **Classes:**
   - protected via each of the four references → zero writes (row digests unchanged);
   - WAITING clears only after the webhook row is processed;
   - a latch is written once;
   - no hot loop: 100 latched or waiting rows do not block an eligible one.
4. **At most once:**
   - each of these ends unknown, with `sends ≤ 1` and repeated steps sending 0: a timeout, a throw, a bad reply, accepted-but-completion-lost, lease expiry after the claim, an ambiguous claim commit;
   - the whole §8.4 map.
5. **Races (using hooks):**
   - two workers at once;
   - an E3 drift between snapshot and claim → latch;
   - a contradiction between claim and pre-send → `PRESEND_ABORTED_NOT_INVOKED`, sends 0;
   - a purge during the claim (blocked) and after the claim (abort);
   - the documented post-snapshot race.
6. **Migration:**
   - grants: the report role sees neither table;
   - append-only behaviour;
   - the up precondition and the down gate;
   - fresh-0015 equality after an allowed down.
7. **Regressions:**
   - the lifecycle rehearsal (rows stay pending unless a reviewed slice changes that);
   - the 0010–0015 suites, `npm test` and `test:db`;
   - mechanical 0016 version pins only.
   - If the e74a listing-lock failure reproduces: keep the FIRST FULL TAP and STOP. Never rerun to green.

## 13. Smallest justified staging (each stage authorized separately)

**Stage 1 — the DB fence only.**
- `0016_guest_notification_fence.up/.down.sql`, containing:
  - the refusal, class, facts, snapshot, presend, claim, work-claim, latch, complete and page functions;
  - two tables, two triggers and the grants.
- The three `operations.js` changes (§6.1, §6.5 i–ii).
- `test/db/e7-guest-notification-fence.test.mjs`: predicates, classes, the §8 map, and races without an executor.
- No worker or executor exists yet, so nothing can invoke anything.

**Stage 2 — the pure module, the worker and mock tests.**
- `lib/checkout/guest-notification.js` and `lib/booking-db/notification-worker.js`.
- Unit and PG worker tests.
- The packaging pin `OFFLINE_ONLY`.

Neither stage changes E3 producers, other workers, routes, UI, config or deps.

## 14. Residuals (open, not resolved here)

1. `alert.owner` rows keep the generic resend exposure (`repo.js:109–110`, `operations.js:414–418`). This needs a separate slice.
2. N2: notification unknown cases have no closing path, and they block guest purge.
3. N3: `recipient_hash` survives guest purge.
4. False latches are possible, from a benign open case (C4) or a code change (`RENDER_FAILED`). They are permanent in v1; owner requalification design is deferred.
5. A row can stay WAITING indefinitely if a webhook row never leaves `received` or `failed_retryable`. It stays visible on the page.
6. Two properties are derived from current code (§1.1): at most one notify per intent, and every version bump being a transition. An unconsidered intent UPDATE would cause a fail-safe `VERSION_DRIFT` latch.
7. A raw UPDATE racing an intent-first path can deadlock (`40P01`). The global maintenance path is op-first, with SKIP LOCKED.
8. The post-snapshot race (§6.6), and TRUST in the strict v3 and identity proofs that run in JS at transition time (§5.2).
9. A trusted executor can do arbitrary work. Labels and `.invalid` do not prove a mock.
10. The historical e74a listing-lock failure stays OPEN.

**Live provider, sender identity, recipient policy, retention and copy: CLOSED.**
