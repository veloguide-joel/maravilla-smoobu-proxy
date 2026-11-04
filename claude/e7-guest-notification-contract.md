# E7 guest notification — CONTRACT revision 3 (DOCS ONLY, PROPOSED): the smallest OFFLINE / injected-MOCK notification slice

**Branch.** `feature/e7-guest-notification-contract`.

| Revision | Commit | Root outcome |
|---|---|---|
| 1 | `2e20972ac96bbbf6bfa984be3c84ec3542969e8a` | DESIGN HOLD, findings R1–R6 |
| 2 | `4796b59788e8211c40565c4b15bf3348b8074182` | DESIGN HOLD, findings R7–R9. Accepted: freeze-at-claim, the dedicated claim / presend / completion, both generic-claim exclusions, the markUnknown branch, durable unknowns, narrow error / redaction, and N1 = a, N2 = a, N3 = a as OFFLINE decisions only |
| 3 (this) | `6e3fca5f9177e5fdd34544c974b023c320fc9ce7` | ACCEPTED as OFFLINE design with root addenda A–C (U1 = a, U2 = a). Stage 1 implemented offline on `feature/e7-guest-notification-fence`, pending root CODE review: implementation map **§15** |

The R7–R9 resolution map is §0.4. The R1–R6 resolutions are retained, and any change to them is stated in place.

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
  - **Refined by R8 (revision 3):** protection is re-decided at every notification-owned write. Protection that becomes visible after a claim writes nothing new and undoes nothing (§7.6). A global generic-helper residual remains (U2).
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

### 0.3 Decisions surfaced by revision 2

Root ruling on `4796b597`: **N1 = a, N2 = a, N3 = a**, as OFFLINE decisions only. They are not approval of any live policy. The options are kept below for the record.

- **N1 — how a latch is made visible.**
  - (a) A latch row plus the read-only page, and **no reconciliation case** (recommended). Any open case blocks guest-data purge (`0005:146`).
  - (b) A latch plus a closable case, opened as `notification-latch:{op}`.
- **N2 — the unknown case vs retention.** D1 = A opens `NOTIFICATION_OUTCOME_UNKNOWN` as `op:{id}`. No existing owner function can close it (§7.4), so it blocks purge for that intent indefinitely.
  - (a) Keep the case, and block any live enablement until a deferred owner notification-resolution slice exists (recommended for offline v1).
  - (b) Open no case; the unknown is then visible only through the op state and the page.
- **N3 — recipient hash retention.** `notification_renders.recipient_hash` survives guest purge. It is pseudonymous, guessable personal data (§4.3).
  - (a) Keep it, offline only. Any live retention policy needs an owner decision before enablement (recommended).
  - (b) Omit it and bind the recipient only inside the claim transaction. This loses pre-send detection of a recipient change.

### 0.4 R7–R9 resolution map (revision 3)

| R | Root finding (short) | Resolution in revision 3 | Sections | Key sources |
|---|---|---|---|---|
| R7 | "At most one notify per intent" was not a DB invariant. The INSERT check races, and the existing UNIQUE is per template. | A partial UNIQUE index `external_operations_one_guest_notify ON (intent_id) WHERE op_type = 'guest.notify'`. Exact INSERT requirements. `source_version` and every other column frozen on notify UPDATEs. Upgrade refuses pre-existing duplicates under lock. E3 same-key replay is still absorbed by the `idempotency_key` arbiter. | §6.3, §8.1, §8.2, §8.3, §12.8 | `0001:363`, `0001:393–396` (precedent partial uniques), `repo.js:107–108`, `:118–131`, `:376–390`, `0004:53–56` |
| R8 | Protection can appear after a claim. The generic recovery has no protected exclusion. A pre-send "protected" result led to a write. | Protection is re-decided at every notification-owned write, under a defined lock bundle. That covers work acquisition, maintenance, claim, latch, completion and release. Only the step's own scoped maintenance function is used; generic `recoverExpiredOperations` is not changed and not called. A protected result writes NOTHING, the existing audit is kept, and the row is never re-invoked. The temporal guarantee is stated per protection source; non-serialised sources are named. A new `provider_evidence` AFTER INSERT advisory trigger is offered as choice U1. The generic GLOBAL maintenance residual is explicit. | §6.5, §6.6, §7.1, §7.2, §7.6, §12.9, §14 | `operations.js:426–468`, `0010:354–406` (advisory for `hostaway_offline_charges` only, `:387–389`, `:402–404`), `repo.js:617–627`, `intent-state.js:609–614`, worker callers `recording-worker.js:182`, `reservation-worker.js:601`, `capture-worker.js:622`, `compensation-worker.js:661` |
| R9 | The predicates and API were ambiguous. | C7 narrowed to Stripe references. A2 gets an explicit vacuous floor. A deterministic evidence order (`observed_at, created_at, id`). An allowlist of observed fields with fail-closed `EVIDENCE_MALFORMED`. K3 limited to what the evidence actually records. The version-bump claim corrected and `SNAPSHOT_STALE` retry policy made explicit. An immutable-lookup page cursor. The summary function defined. A complete Stage 1 object / function map. An exact allowed-file scope. | §5.2, §5.3, §6.2, §7.5, §7.7, §13 | `0003:52–103`, `0010:383` (API `observed_at` = read completion), `recovery-plan.js:64–96`, `capture-proof.js:32`, `:54–67`, `0004:56` |

### 0.5 Unresolved choices raised by revision 3 (recommendation first)

- **U1 — serialising evidence with notification decisions.**
  - (a) **Recommended.** A 0016 `AFTER INSERT` row trigger on `booking.provider_evidence` takes `pg_advisory_xact_lock(hashtext('booking.notification_facts'), hashtext(intent_id::text))` for kinds `payment_intent`, `hostaway_reservation` and `hostaway_offline_charges`.
    - It changes no 0001–0015 function body. Its only effect on accepted writers is a possible short wait on the intent's notification decision.
    - Lock-order proof: §6.6.
  - (b) No trigger. Evidence inserts are then **not serialised** with notification decisions; only committed-before-snapshot visibility applies. The guarantee in §7.6 weakens accordingly.
- **U2 — the generic exported `recoverExpiredOperations`.**
  - (a) **Recommended.** Leave it unchanged and document it. A direct call with `opTypes` null, or including `guest.notify`, can mark a protected expired notify row unknown and open a case. No accepted worker makes such a call: they all pass their own `opTypes`.
  - (b) A notify-specific skip inside the generic helper. **Not recommended:** a skipped expired row would be re-selected on every global call, a hot loop.

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

**State-machine production (derived, not a DB invariant).** E3 produces at most ONE `guest.notify` row per intent in its lifetime, because the source states of the four emissions are never reachable again from a terminal state.
- At `2e20972a` the DB does **not** enforce this. `idempotency_key` UNIQUE (`0001:363`) is per template (`notify:{intent}:{template}`, `repo.js:107–108`), so a raw INSERT with a different template key is accepted.
- Revision 3 makes it a DB invariant with a partial UNIQUE index (§6.3, R7).

**Version facts.**
- `source_version = after.version` of the producing transition (`repo.js:121`, `:127`).
- **Every** `intents` UPDATE advances the version by exactly 1 (`0001:159–162`).
- **Correction (R9):** facts outside the `intents` row can change WITHOUT a version bump. Examples: provider evidence, cases, refunds, webhooks, recording holds, guest purge or reinsert, create-attempt results (`repo.js:617–627`). The version latch covers intent-row facts only; the other facts are re-evaluated at every decision (§5.2, §6.2).
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
- **C7 (narrowed, R9):** returns `FOREIGN_PAYMENT_INTENT` if ANY of these holds. Only Stripe PaymentIntent references are compared:
  - a ledger `authorization_rejected` exists for `I`;
  - a ledger row of `I` with `provider = 'stripe'` has `provider_ref <> P`. Hostaway rows (`offline_charge_recorded`, `provider = 'hostaway'`) carry a charge id and are excluded;
  - a `provider_evidence` row of `I` with `kind = 'payment_intent'` has `external_ref <> P`;
  - a `stripe.capture_payment_intent`, `stripe.void_payment_intent` or `stripe.retrieve_payment_intent` op of `I` has `payload ->> 'paymentIntentId'` that is NULL or `<> P`;
  - a `payment_attempts` row of `I` has `payment_intent_id IS NOT NULL AND payment_intent_id <> P`.
  - If `P` is NULL while any of these Stripe references exist → `FOREIGN_PAYMENT_INTENT`.
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
- **K3 (limited to what accepted evidence records, R9):** let `E` = the latest `payment_intent` evidence for `P` in the §5.3 order.
  - **`PI_EVIDENCE_MISSING`** if `E` does not exist.
  - **`PI_EVIDENCE_UNPROVEN`** if `E` is not API-sourced: `E.source <> 'stripe_api'`, or `E.observed ->> 'proofVersion'` ∉ {`'pi-proof-v2'`, `'pi-proof-v3'`} (`recovery-plan.js:72`, `capture-proof.js:32`). Owner dashboard attestations cannot qualify a confirmation in v1.
  - **`PI_EVIDENCE_CONTRADICTS`** unless all hold:
    - `E.status = 'succeeded'`;
    - `E.observed_at ≥` the K2 op's `dispatched_at` (API `observed_at` = the read op's completion, `0010:383`);
    - `amountReceivedMinor` (§5.3) = `I.captured_minor`;
    - `currency` (§5.3) = `I.currency`.
  - **Every** PI evidence row for `P`: if `latestCharge.amountRefundedMinor` is present it must be 0; if `latestCharge.refunded` is present it must be `false`. Absent means "not recorded", which is **not** proof of no refund; refunds are covered by C5 only.
  - **Malformed** → `EVIDENCE_MALFORMED` (§5.3).
  - **What K3 establishes:** only that the reviewed read path recorded these field values at `observed_at`.
  - **What it does not establish:** `accountVerified`, `livemode` and metadata are recorded by the JS read path and are not re-attested by SQL (TRUST). It is not a fresh provider read, and not a DB attestation of current provider state. Currency is bound through the ledger (K1) and the recorded field; both ultimately derive from the price snapshot and the provider response as recorded.
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
  - no PI evidence for `P` has status `succeeded`, or a present `amountReceivedMinor` that is not 0. A present but malformed value → `EVIDENCE_MALFORMED`;
  - **dispatch floor (explicit, R9):** `NOT EXISTS (capture op for P with dispatched_at IS NOT NULL AND dispatched_at > L.observed_at)`, where `L` is the latest canceled PI evidence in the §5.3 order. On the normal reservation-failed / void path no capture was ever dispatched, so the condition is vacuously true. No `MAX(...)` is compared with NULL.
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
  - if a cancel op for `R` was dispatched, the cancelled evidence has `observed_at ≥` its `dispatched_at`. This uses the same explicit `NOT EXISTS` form as A2, so it is vacuous when no cancel op was dispatched (for example, an owner-attested cancellation).
- **X4:** `intent_transitions` for `I` contains, after the entry into `capture_failed`, a `RESERVATION_CANCELLED` and one of `VOID_SUCCEEDED` or `RECONCILED_AUTHORIZATION_GONE`. Else `CANCEL_NOT_PROVEN`.

**Freshness, scope and reference rules.**
- The predicate reads only committed rows: at the statement snapshot (pre-send) or after the locks (claim).
- There is no age requirement on the evidence. The evidence proves a past provider state, accepted by the reviewed transition path.
- It does **not** prove the current provider state. There is no provider read and no general guarantee of fresh provider data.
- Every reference is scoped exactly to `I`, `P` and `R`.

### 5.3 Evidence order and observed-field allowlist (fail-closed, R9)

**Deterministic order.** "Latest" always means `ORDER BY observed_at DESC, created_at DESC, id DESC`. The `id` (uuid) tie-breaker is arbitrary but total and stable, so ties are resolved the same way at claim and at pre-send.

**Allowlisted fields.** Read only through private IMMUTABLE helpers. Nothing else in `observed` is read.

| Field (JSON path) | Accepted type | Helper result |
|---|---|---|
| `amountReceivedMinor` | `jsonb_typeof = 'number'`, text matching `^(0\|[1-9][0-9]{0,14})$` | bigint, or the MALFORMED sentinel |
| `currency` | string matching `^[A-Z]{3}$` | text, or MALFORMED |
| `proofVersion` | string 1–40 chars | text, or MALFORMED |
| `latestCharge.amountRefundedMinor` | as `amountReceivedMinor` | bigint, or MALFORMED |
| `latestCharge.refunded` | `jsonb_typeof = 'boolean'` | boolean, or MALFORMED |

**Rules.**
- Values are never cast unvalidated: no `::bigint` on text, so a 22P02 crash loop is impossible.
- Each helper returns **ABSENT** (key missing or JSON null) or **MALFORMED** (present with a wrong type or format) as distinct sentinel results.
- A rule that **requires** a field (K3: `amountReceivedMinor`, `currency`, `proofVersion`) treats ABSENT as `PI_EVIDENCE_UNPROVEN`, and MALFORMED as `EVIDENCE_MALFORMED`.
- A rule that only **forbids** a value (A2's `amountReceivedMinor ≠ 0`; K3's refund fields) treats ABSENT as "not recorded" and MALFORMED as `EVIDENCE_MALFORMED`.
- Hostaway reservation evidence is read only through its `status` column, which is CHECK-constrained (`0003:85–88`). No `observed` field participates.
- `EVIDENCE_MALFORMED` is a latching code (§7.3). Malformed accepted evidence therefore refuses once and permanently, and never qualifies via SQL NULL.

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
3. **Lock, in this order.** The two row locks plus the `notification_facts` advisory form the **protection lock bundle** (§6.6), which every notification-owned writer takes in the same relative order.
   - `intents` `FOR SHARE`;
   - `hostaway_reservation_attempts` `FOR SHARE`, when the row exists;
   - `intent_work` `FOR SHARE`;
   - the op in `external_operations` `FOR UPDATE`;
   - `intent_guests` `FOR KEY SHARE`, when the row exists;
   - the advisory `('booking.notification_facts', intent)` (U1);
   - the advisory `('booking.recording_evidence', intent)`, the 0010/0011 key.
4. **Set** `v_t := clock_timestamp()` **after all locks**. This is the decision clock.
5. **Re-check protection** (§7.2) in a NEW statement, which sees every commit that preceded it. If the intent is protected → `{status:'protected'}`, with **no write of any kind**.

**Phase 2 — decide.**
6. **Not claimable** if either:
   - `O.state <> 'pending'`, `attempts <> 0`, `dispatched_at IS NOT NULL`, a render row exists, or a latch exists → `{status:'not_claimable', code}`;
   - `p_worker` does not hold the work lease with `work_lease_until ≥ v_t + OP_LEASE_MS` → `{status:'not_claimable', code:'WORK_LEASE'}`.
7. **Qualify** with `r := guest_notification_refusal(p_op)`:
    - a WAITING or OUT_OF_V1_SCOPE code → `{status:'waiting', code}`, with no write;
    - any other code → INSERT the latch (§7.3) → `{status:'latched', code}`.
8. **Compare the snapshot.** If the current `facts_hash` or `recipient_hash` differs from the caller's expected value → `{status:'not_claimable', code:'SNAPSHOT_STALE'}`, with no write.
    - **Corrected policy (R9):** facts can change without a version bump (§1.1). So `SNAPSHOT_STALE` is **not** a latch.
    - The row stays ELIGIBLE, and a later step may retry it pre-claim, under the unchanged version, with a fresh snapshot.
    - Each retry requires a concurrent commit that changed the facts, so retries are bounded by external writes.
    - If the changed facts no longer qualify, the retry's step 7 latches permanently, as an explicit decision.

**Phase 3 — write.**
9. INSERT the render row (§4.4) with `claimed_at = v_t`. Then `UPDATE … SET state='in_flight', attempts=1, dispatched_at=v_t, lease_worker_id=p_worker, lease_until=v_t + OP_LEASE_MS, updated_at=v_t`.
10. Return `{status:'claimed', leaseUntil, dbNow:v_t}`.

### 6.3 Authoritative triggers

These apply to every path, including raw UPDATEs and privileged sessions.

**`external_operations_one_guest_notify`** — a partial UNIQUE index `ON booking.external_operations (intent_id) WHERE op_type = 'guest.notify'` (R7).
- This is the **concurrency-proof** one-row invariant. It follows the precedent partial uniques at `0001:393–396`.
- Two concurrent INSERTs for the same intent, with different template keys: the second blocks on the first's uncommitted index entry. When the first commits, the second fails with `23505` on this index. When the first aborts, the second proceeds. No check-then-insert race exists.
- **E3 interaction (`repo.js:118–131`).** `insertOperations` uses `ON CONFLICT (idempotency_key) DO NOTHING`.
  - A same-key replay conflicts on the arbiter index and is absorbed, with no error, exactly as today.
  - A different-template INSERT for an intent that already has a notify row conflicts only on the new index (not the arbiter), so it raises `23505` and aborts the whole transition.
  - This never happens on accepted E3 paths (§1.1). If it did, `applyEvent` does not map this constraint (`repo.js:395–402`), so it would throw, deterministically.

**`notify_op_fence`** — BEFORE INSERT OR UPDATE, for `op_type = 'guest.notify'` only.
- **INSERT** is accepted only when all of the following hold. They are checked against the intent row, which in the E3 transaction was already updated before `insertOperations` (`repo.js:376–388`).
  - `idempotency_key = 'notify:' || intent_id || ':' || template`;
  - the payload is exactly `{template}`, with a template in TEMPLATES;
  - `retry_class = 'idempotent'`;
  - `state = 'pending'` and `attempts = 0` (already enforced by `0004:47–51`);
  - `dispatched_at`, `completed_at`, `lease_worker_id`, `lease_until`, `result_ref`, `error_code`, `late_result_*`, `settled_evidence_id` and `resolution_id` are all NULL;
  - `requires_provider_read = false`;
  - `source_version = intents.version`;
  - `intents.state` is the template's target state.
  - The uniqueness itself is the index, not this trigger.
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
- **`source_version` is frozen on every notify UPDATE** (R7). The op guard does not include it in its identity list (`0004:53–56`), so this fence adds it.
- **Same-state UPDATEs** are refused when they change any of: `attempts`, `dispatched_at`, `lease_worker_id`, `lease_until`, `result_ref`, `completed_at`, `next_attempt_at`, `requires_provider_read`, `late_result_status`, `late_result_ref`, `settled_evidence_id`, `resolution_id`, `error_code`, `source_version`.
- **Allowed changes.** On a state-changing UPDATE, the only columns that may change are those the allowed transition sets:
  - claim: state, attempts, dispatched_at, lease, updated_at;
  - completion: state, result_ref or error_code, completed_at, lease cleared, updated_at.
  - Only `updated_at` may change freely.

**`notify_claim_binding`** — AFTER UPDATE `WHEN (OLD.state='pending' AND NEW.state='in_flight' AND NEW.op_type='guest.notify')`.
- It re-checks, at its own instant, that a render row exists with `worker = NEW.lease_worker_id`, `intent_version = source_version` and `claimed_at = NEW.dispatched_at`.
- A refusal aborts the statement. This is the 0012 claim-audit pattern (`0012:560–580`).

### 6.4 Pre-send snapshot `booking.guest_notification_presend(p_op, p_worker) RETURNS jsonb`

> **Corrected by R-C1 (§15.9; supersedes the STABLE wording below).** `guest_notification_snapshot` and `guest_notification_presend` run ONLY inside an explicit, caller-created `READ ONLY REPEATABLE READ` transaction; any other context is refused with `25000 NOTIFY_SNAPSHOT_CONTEXT`. The caller does: BEGIN RR READ ONLY → ONE observation SELECT → COMMIT → the final frozen-request / clock / skew / elapsed / margin checks → invoke. There is never any network inside a DB transaction, and an error stops the step with no retry. `dbNow` is captured at the END of the checks, and both leases are re-validated at that instant. The snapshot's recipient hash is the hash of the exact guest row it returns. This is a bounded snapshot: later commits are the documented race.

- SECURITY DEFINER and declared **STABLE**, so every read sees the single snapshot of the calling statement.
- **Returns:** `{ok, code, dbNow, opLeaseUntil, workLeaseUntil, contentHash, templateVersion, messageRef}`.
- **`ok` requires:**
  - the op is `in_flight`, with `attempts = 1`, `lease_worker_id = p_worker`, and render `worker = p_worker`;
  - `I.version = render.intent_version`;
  - `guest_notification_refusal IS NULL`;
  - the current `facts_hash` and `recipient_hash` equal the render's;
  - the intent is not protected. A protected intent returns `{ok:false, code:'PROTECTED'}`, and the worker then makes **no** write (§7.6). Any other refusal leads to `complete_guest_notification(unknown, PRESEND_ABORTED_NOT_INVOKED)`.
- It takes **no locks**.

**JS then checks the following, with no `await` in between:**
- `contentHash(frozenRequest) = contentHash`, with the same `templateVersion` and `messageRef`;
- `opLeaseUntil − dbNow ≥ SEND_TIMEOUT_MS + PRESEND_MARGIN_MS`, and the same for the work lease;
- |JS clock − `dbNow`| ≤ `MAX_SKEW_MS`.

It then starts `sendMessage(frozenRequest, { signal })` synchronously.

**What this guarantees:** the request equals what was bound at claim, and every fact qualified at ONE consistent snapshot taken immediately before the call.

**What it does not guarantee:** that the facts are still true when the mock, or a future provider, processes the request (§6.6).

### 6.5 Settlement and notification-scoped maintenance

**`booking.complete_guest_notification(p_op, p_worker, p_kind text, p_ref text, p_code text) RETURNS text`** — SECURITY DEFINER.
- **Locks:** the protection lock bundle (§6.6), then op `FOR UPDATE`, then `v_t`.
- **Protected re-check** in a new statement (§7.2). If protected → `'PROTECTED'`, with **no write**: the row stays as it is (§7.6).
- **With a live lease** (owner `p_worker`, `v_t ≤ lease_until`):
  - `accepted` → `succeeded`, `result_ref = p_ref`, `completed_at = v_t`;
  - `unknown` → `outcome_unknown`, `error_code = p_code`, plus the case below.
  - It returns the new state.
- **Without a live lease** it returns `'LEASE_LOST'` and writes **nothing**. A late reply is observed in memory only, within `LATE_WINDOW_MS`.
- **Pre-send that returned `PROTECTED`** (§6.4): the worker does **not** call `complete_guest_notification`. It makes no write at all (§7.6).

**JS changes in `operations.js` (D1 = A; retained)**
- **(i)** `markUnknown` gets a first branch for `op.op_type === 'guest.notify'`:
  - → `outcome_unknown` plus `openCase('NOTIFICATION_OUTCOME_UNKNOWN', 'op:'+id, {operationId, opType, errorCode})`;
  - independent of `retry_class` and `attempts`.
  - It is reached only through the GENERIC helpers (`completeOperation(outcome_unknown)` and `recoverExpiredOperations`). The notification worker uses neither.
  - It has **no** protected check: see U2 and residual §14.
- **(ii)** `completeOperation(succeeded)` on a notify row returns `{ok:false, error:'NOTIFY_SUCCESS_REQUIRES_DEDICATED_COMPLETION'}`. The decision is made from the immutable `op_type` before any transaction (the recording pattern, `:169–171`).

**Notification-scoped maintenance (R8; replaces revision 2's reuse of the generic helper).**

`booking.recover_expired_notifications(p_listing_ids int[], p_intent uuid, p_limit int) RETURNS jsonb` — SECURITY DEFINER, app.
- **Candidates** (no locks): notify ops that are `in_flight`, with `lease_until < clock_timestamp()` and the intent in scope. **Currently protected intents are excluded before `ORDER BY lease_until, id LIMIT p_limit`.**
- **For each candidate:**
  - take the protection lock bundle with `SKIP LOCKED` on the two row locks (skip the intent if it is locked);
  - lock the op `FOR UPDATE SKIP LOCKED`;
  - set `v_t`;
  - re-check, in a new statement: not protected, still `in_flight`, `lease_until < v_t`.
  - Only then: → `outcome_unknown` (`LEASE_EXPIRED`), plus the case `NOTIFICATION_OUTCOME_UNKNOWN` (`op:{id}`, `ON CONFLICT DO NOTHING`).
  - A protected or changed row is skipped with no write.
- **Returns** `{processed, skippedLocked, skippedProtected}` (counts only).
- **Hot-loop bound.** A protected expired row is excluded before LIMIT, so it never occupies a batch slot.

The generic `recoverExpiredOperations` (`operations.js:426–468`) is **not changed and not called** by the notification worker. Every accepted worker passes its own `opTypes`: `recording-worker.js:182`, `reservation-worker.js:601`, `capture-worker.js:622`, `compensation-worker.js:661`. A direct generic call that includes `guest.notify` remains the residual named in U2 and §14.

**Work release.** `booking.release_notification_work(p_intent uuid, p_worker text) RETURNS text` — SECURITY DEFINER, app.
- Takes the protection lock bundle, then `intent_work FOR UPDATE`, then re-checks protection.
- Protected → `'PROTECTED'`, with no write: the lease simply expires.
- Otherwise it clears the lease only if `p_worker` holds it → `'RELEASED'`, or else `'NOT_HELD'`.

**Persisted error codes (codes only):**

| Code | Meaning |
|---|---|
| `SEND_TIMEOUT` | The bounded call timed out |
| `SEND_THREW` | The executor threw or rejected |
| `REPLY_SHAPE` | The reply did not match the grammar |
| `REPLY_UNREADABLE` | The reply could not be read safely |
| `PRESEND_ABORTED_NOT_INVOKED` | Claimed, but pre-send refused for a reason other than protection; `sendMessage` was NOT called |
| `LEASE_EXPIRED` | Set by notification-scoped maintenance |

### 6.6 Lock order, the protection lock bundle, and what is (not) serialised

**Protection lock bundle** (taken first by every notification-owned writer):
1. `intents FOR SHARE`;
2. `hostaway_reservation_attempts FOR SHARE`, when the row exists;
3. later in each path, after any op / guest row locks: the advisory `('booking.notification_facts', intent)`. This is U1 = a; it is absent under U1 = b.

The ordering between the advisories is fixed: `notification_facts` before `recording_evidence`.

| Path | Order |
|---|---|
| `claim_notification_work` | intents SHARE SKIP LOCKED → attempts SHARE SKIP LOCKED → `intent_work` UPDATE SKIP LOCKED → `notification_facts` advisory → re-check |
| `claim_guest_notification` | intent SHARE → attempts SHARE → work SHARE → op UPDATE → guest KEY SHARE → `notification_facts` advisory → `recording_evidence` advisory → `v_t` → re-check |
| `latch_guest_notification` | as `claim_guest_notification` |
| `complete_guest_notification` | intent SHARE → attempts SHARE → op UPDATE → `notification_facts` advisory → `v_t` → re-check → case INSERT (FK KEY SHARE on intent) |
| `recover_expired_notifications` | per row: intent SHARE SKIP LOCKED → attempts SHARE SKIP LOCKED → op UPDATE SKIP LOCKED → `notification_facts` advisory → re-check → case INSERT |
| `release_notification_work` | intent SHARE → attempts SHARE → work UPDATE → `notification_facts` advisory → re-check |
| `complete_recording_with_evidence` | intent SHARE → work SHARE → op UPDATE → `recording_evidence` advisory (`operations.js:184`). Same prefix order; never takes `notification_facts`. |
| Evidence writers (API `0010:354–390`, dashboard `0010:392–406`) | read-op UPDATE (API only) → evidence INSERT (FK KEY SHARE on intent; compatible with SHARE) → **U1 trigger:** `notification_facts` advisory → `recording_evidence` advisory (0010, `hostaway_offline_charges` only, `:387–389`, `:402–404`) |
| `recordHostawayCreateResult` | one statement: attempts row UPDATE (`repo.js:617–627`). Conflicts with attempts SHARE. |
| E3 transition / case opening (`applyEvent`) | intent UPDATE (`repo.js:378`). Conflicts with SHARE. |
| Generic `claimNextOperation` | intent SHARE → work SHARE (recordings only) → op UPDATE SKIP LOCKED. **Never a notify op.** |
| Generic maintenance (unchanged) | phase-guarded: intents SHARE → ops UPDATE SKIP LOCKED; global: op UPDATE SKIP LOCKED → case INSERT |
| `purge_guest_data` | guest-row DELETE, no intent lock (`0005:141–150`). Waits on the claim's KEY SHARE. |

**No-cycle argument.**
- Every party takes row locks in the order intent → attempts → work → op → guest, and advisories after its row locks, in the order `notification_facts` → `recording_evidence`.
- An evidence writer holds only its read-op row and an intent KEY SHARE (compatible with SHARE) while it waits for `notification_facts`. No notification writer waits on a read-op row.
- So no wait-for cycle exists among library paths.

**What is serialised with a notification decision, and what is not:**

| Protection / fact source | Serialised? | Reason |
|---|---|---|
| `intents.hostaway_reservation_id`, E3-inserted op payloads | Yes | Intent UPDATE vs intent SHARE |
| `hostaway_reservation_attempts.hostaway_reservation_id` (`recordHostawayCreateResult`) | Yes | Row UPDATE vs attempts SHARE |
| `provider_evidence` rows, kinds `payment_intent` / `hostaway_reservation` / `hostaway_offline_charges` | **Only under U1 = a** | Via the trigger advisory. Without U1, 0010 takes an advisory only for `hostaway_offline_charges` and only on the `recording_evidence` key (`0010:386–388`). A `payment_intent` or `hostaway_reservation` insert then holds only KEY SHARE on the intent, which does **not** conflict, so it is **not** serialised. |
| Raw app INSERT of a non-notify op with a protected `payload.reservationId` outside E3 | **No** | Visible only if committed before the decision statement's snapshot (READ COMMITTED) |
| Cases, refunds, webhooks, holds | **No** | No conflicting lock. Committed-before-statement visibility only. |

**Snapshot timing.**
- In each SECURITY DEFINER (VOLATILE plpgsql) function, the re-check statement runs after the locks and the advisory are granted. Under READ COMMITTED it therefore sees every transaction that committed before it, including any holder that just released a conflicting lock.
- `guest_notification_presend` is STABLE and takes **no** locks. It sees only commits that preceded its statement.

**Direct-UPDATE residual (not a library path).** A raw UPDATE of a notify op locks the op row first, and the BEFORE trigger then reads intent and guest facts. It can therefore yield `40P01` against intent-first paths, as with the 0007, 0009 and 0011 fences. The deadlock aborts one transaction and never claims.

**Unavoidable races.**
- A contradiction, late money, a hold, a case, or newly visible protection can be committed:
  - after the pre-send snapshot and before or while the mock processes the request; or
  - in an unserialised source after a decision statement.
- Such a commit can coincide with a sent message.
- It is visible afterwards. It is never "un-sent", and no claim is made that a message cannot become stale after that snapshot.

## 7. Visibility, eligibility, latches and unknowns (R2, R8)

### 7.1 Eligibility classes

Computed by SQL `booking.guest_notification_class(p_op)` and evaluated before LIMIT in every notification selection.

| Class | Exact condition | Action |
|---|---|---|
| PROTECTED | §7.2, evaluated now (whatever the op state) | **No notification-owned write** (§7.6). Not a candidate for work / claim / maintenance; not in the page; counted only in the summary. |
| SUCCEEDED / IN_FLIGHT / UNKNOWN | The op state | None. Notification-scoped maintenance handles expired `in_flight` rows only. |
| LATCHED | A latch row exists | None, ever, in v1 |
| OUT_OF_V1_SCOPE | `I.currency <> 'USD'`, OR the guest email does not match the `.invalid` grammar | Not a candidate; no write; listed with its code |
| WAITING | A `stripe_webhook_events` row exists with `intent_id = I.id AND status IN ('received','failed_retryable')` | Not a candidate; no write; listed. Becomes a candidate once the event row is processed or ignored. This is not an owner override. |
| ELIGIBLE | Pending, attempts 0, and none of the above | A candidate |

**Work acquisition.** `booking.claim_notification_work(p_worker text, p_listing_ids int[], p_intent uuid) RETURNS jsonb` — SECURITY DEFINER, app.
- **Candidates** (no locks): ELIGIBLE notify ops whose intent is in scope, with currently protected intents excluded, `ORDER BY created_at, id`.
- At most 10 candidates per call, with skip-on-lock as in `operations.js:89`.
- **For each candidate:**
  - lock `intents FOR SHARE SKIP LOCKED` and `hostaway_reservation_attempts FOR SHARE SKIP LOCKED`;
  - lock `intent_work FOR UPDATE SKIP LOCKED`, requiring no live lease;
  - take the `notification_facts` advisory;
  - re-check protection and class in a new statement.
- **Outcome of the re-check:**
  - protected or no longer ELIGIBLE → skip, **no write**;
  - otherwise set `work_worker_id = p_worker` and `work_lease_until = clock_timestamp() + WORK_LEASE_MS` → `{status:'acquired', opId, intentId}`.
- **No candidate** → `{status:'idle'}`.
- **A legal NULL → protected transition during acquisition.** For example, `RESOLVE confirmed` setting `reservation.reservationId` (`intent-state.js:609–614`).
  - If the transition holds the intent row, `SKIP LOCKED` skips the candidate.
  - If it committed before the lock, the re-check sees the protected id and skips.
  - In both cases no lease is written. Such a row is version-drifted anyway.

**Progress argument.**
- Every acquired row leaves ELIGIBLE after one step (claimed or latched).
- The exception is `SNAPSHOT_STALE`, which requires a concurrent fact change and is retried (§6.2 step 8).
- Protected, latched, waiting and out-of-scope rows are excluded before LIMIT.
- So there is no hot loop and no starvation.

### 7.2 The protected predicate

Evaluated at intent level, following every reservation reference. The intent is protected if ANY of these values is in {70636076, 71045356, 71072615, 71081885}:
- `I.hostaway_reservation_id`;
- any `hostaway_reservation_attempts.hostaway_reservation_id` for `I`;
- any `provider_evidence.external_ref` of kind `hostaway_reservation` or `hostaway_offline_charges` for `I`, from API or dashboard source. API refs bind to the read selector, not to the intent's current reservation (`0010:371–378`); dashboard refs are free (`0010:392–401`);
- any op payload `reservationId` for `I`.

It is evaluated:
- in every notification selection **before LIMIT**: work acquisition, maintenance, the page and the summary;
- **again in a new statement under the protection lock bundle** immediately before every notification-owned write: work acquisition, claim, latch, completion, maintenance and release;
- in pre-send, which is a snapshot with no lock.

### 7.3 Table `booking.notification_latches`

| Column | Notes |
|---|---|
| `operation_id` | PK |
| `intent_id` | |
| `code` | A `booking.is_code` value from §5.2 / §5.3, or `RENDER_FAILED` |
| `intent_version_seen` | |
| `latched_at` | DB clock |
| `worker` | |

**Writers.** The table is append-only, and each row is written once, by one of:
- `claim_guest_notification`, with an SQL-derived code;
- `booking.latch_guest_notification(p_op, p_worker, 'RENDER_FAILED')`. This takes the same locks as the claim, re-checks protection and ELIGIBLE, and returns `'PROTECTED'` / `'NOT_ELIGIBLE'` with no write. The code is TRUST: it records that the JS could not render.

**Latching codes.** Every non-WAITING, non-OUT_OF_V1_SCOPE code of §5.2, plus `EVIDENCE_MALFORMED` and `RENDER_FAILED`. `SNAPSHOT_STALE` never latches.

**Policy.** No requalification, override or case in v1 (D2, N1 = a). A latched row stays `pending` forever and stays visible.

**Grants.** SELECT for app and admin; no report grant (D4).

### 7.4 Unknown

- An unknown row is `outcome_unknown` plus a `NOTIFICATION_OUTCOME_UNKNOWN` case opened as `op:{id}`. In v1 it stays **durable and unresolved** (N2 = a), because no closing path exists today:
  - `admin_resolve_operation` → `NOT_SUPPORTED` (`0005:363–364`);
  - `admin_close_case` → `OPERATION_CASE_USE_ADMIN_RESOLVE_OPERATION` (`0011:539–541`).
- The case blocks guest purge for that intent (`0005:146`). Live use stays blocked on a future owner-resolution / retention design.
- No owner resend capability exists or is proposed. A future slice must keep the no-second-claim invariant (§8.1).

### 7.5 Read-only page `booking.list_guest_notifications(p_listing_ids int[], p_after_op uuid, p_limit int) RETURNS SETOF record`

- SECURITY DEFINER, STABLE. App and admin.
- **Rows:** `{opId, intentId, template, state, class, code, createdAt}`, `ORDER BY created_at, id`.
- No hashes and no guest data. Currently protected rows are excluded.
- **Cursor (precision-safe immutable lookup, R9).** `p_after_op` is the `opId` of the last row the caller saw.
  - The function looks up that op's `(created_at, id)` server-side. `created_at` is immutable (`0004:56`), so microsecond precision never passes through JS.
  - It returns rows with `(created_at, id) > (c.created_at, c.id)`.
  - `p_after_op IS NULL` → start from the beginning.
  - A cursor that does not exist, is not a `guest.notify` op, or whose intent is outside `p_listing_ids` → `22023 NOTIFY_CURSOR_INVALID`. This reveals nothing about other scopes.
  - A cursor whose intent has since become protected is still accepted for positioning. The row itself is not returned.
- **Validation:** `p_listing_ids` must be 1–50 distinct positive values, and `p_limit` 1–100. Otherwise `22023`.

### 7.6 Protection appearing after a claim (R8 temporal guarantee)

**Guarantee.** No NEW notification-owned write, and no claim, occurs once protection is visible at the relevant locked decision statement. Notification-owned writes are: work lease, latch, render / claim, completion, maintenance unknown or case, and release. For pre-send, the guarantee holds once protection is visible in its snapshot; there is then no invocation and no write.

Protection that becomes visible after a claim:
- **does not** retroactively undo anything. The render row, `attempts = 1`, `dispatched_at` and any earlier completion stay byte-identical;
- **never** leads to a re-claim or re-invocation. The row cannot return to `pending` (§8.1).

Visibility of such rows comes from `guest_notification_summary` (§7.7) as counts only. No new case, latch or page row is written for them.

**Per-phase behaviour when protection is visible at that phase:**

| Phase | Behaviour |
|---|---|
| Work acquisition | Skip; no lease |
| Claim | `{status:'protected'}`; no write |
| Pre-send | `{ok:false, code:'PROTECTED'}`; the worker does NOT invoke, does NOT complete and does NOT release. Step result `protected`, sends 0. The row stays `in_flight` until its lease expires. |
| Completion after invocation | `'PROTECTED'`; no write. The row stays `in_flight` with its render. The step result is `protected` with `sends: 1`; the persisted state cannot record the reply. |
| Notification-scoped maintenance | Excluded before LIMIT and re-checked; the row stays `in_flight` with an expired lease indefinitely |
| Release | `'PROTECTED'`; no write |

**Residual (U2 = a, explicit).** The generic exported `recoverExpiredOperations` is unchanged. If called directly with `opTypes` null or including `guest.notify`, it **will** mark such a protected expired notify row `outcome_unknown` and open a case: the D1 = A markUnknown branch has no protected check. No accepted worker makes such a call (§6.5). **This contract does not claim the whole DB enforces protected zero action; only the notification functions do.**

### 7.7 Summary `booking.guest_notification_summary(p_listing_ids int[]) RETURNS jsonb`

- SECURITY DEFINER, STABLE. App and admin.
- **Returns counts only, by class and state:**
  - `{eligible, waiting, outOfScope, latched, inFlight, inFlightExpired, unknown, succeeded, protectedPending, protectedClaimed}`;
  - `protectedClaimed` = protected intents whose notify row is `in_flight`, `outcome_unknown` or `succeeded`.
- No ids, hashes or guest data.
- The same `p_listing_ids` validation as the page.

## 8. Lifecycle, upgrade and down invariant map (R5)

### 8.1 Changes to a notify row after 0016

| Change | Allowed? | Enforced by |
|---|---|---|
| INSERT pending, attempts 0 | Only with the canonical key and payload, every lifecycle column NULL / default, `source_version` = intent version, intent in the target state (§6.3) | `0004:47–51` + `notify_op_fence` |
| A second notify row for the same intent (any template, concurrent or not) | **Refused** (`23505`) | Partial UNIQUE `external_operations_one_guest_notify` (R7) |
| Same-key E3 replay | Absorbed (`DO NOTHING`), no error | Arbiter `idempotency_key` (`repo.js:118–131`) |
| `pending → in_flight` (attempts 0 → 1, `dispatched_at`, lease) | Only through `claim_guest_notification`, with the render binding | Fence + binding trigger |
| `pending → superseded` or `pending → escalated` | **Refused** | Fence |
| `in_flight → succeeded` | Only through `complete_guest_notification` (live lease, DB clock) | Fence + `operations.js` change (ii) |
| `in_flight → outcome_unknown` | Any role (markUnknown or the dedicated completion) | Fence allows it |
| `in_flight → pending`, `in_flight → failed_definite`, `in_flight → escalated` | **Refused** | Fence |
| `outcome_unknown → pending`, even when privileged | **Refused** | Fence (`0003:446–450` already blocks the runtime role) |
| `outcome_unknown → succeeded`, `→ failed_definite`, `→ escalated` | Owner only, but no current owner function supports notify (§7.4) | `0003:446–450`, `0005:363–364` |
| Same-state change to attempts, dispatched_at, lease, result, completion, next_attempt_at, requires_provider_read, late_result_*, settled_evidence_id, resolution_id or error_code | **Refused** | Fence |
| Any change to `source_version` | **Refused** | Fence (not in the 0004 identity list) |
| Render row UPDATE, DELETE or TRUNCATE | **Refused** | `reject_change` |
| A new key or a replacement op | Impossible: the key is immutable (`0004:53–56`) and the partial UNIQUE index allows one notify row per intent | Index + `0004` guard |

**What the DB counts vs what the worker counts.**
- The DB guarantees at most ONE **claim** per notify row, ever: attempts go 0 → 1 once, and the row never returns to pending.
- The partial UNIQUE index guarantees at most one notify row per intent, against raw and concurrent INSERTs as well (R7).
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
   - or is a second notify row for the same intent (`NOTIFY_UPGRADE_DUPLICATE`, reported before the index build, which would otherwise fail with an unnamed `23505`).
3. Create the partial UNIQUE index `external_operations_one_guest_notify`, the tables, functions, triggers (including the U1 `provider_evidence` trigger, if chosen) and grants. All of this runs in the same transaction and under the same lock, so no concurrent INSERT can slip in between the check and the index.

At `2e20972a` no code claims notify rows, so the precondition holds on any database produced by the accepted code. A database touched by an ad-hoc generic dispatch is refused and left for owner review.

### 8.3 Down: 0016 down, race-safe and audit-preserving

**Procedure.**
1. Take `LOCK TABLE external_operations, provider_evidence, notification_renders, notification_latches IN ACCESS EXCLUSIVE MODE`.
2. Refuse if any render or latch row exists, or any notify row has `attempts > 0` or `state <> 'pending'`.
3. Otherwise drop the triggers (`notify_op_fence`, `notify_claim_binding`, the U1 evidence trigger), the partial UNIQUE index, the functions and the tables, in dependency order.

**Equality.** Down equality is schema-only: `pg_get_functiondef`, ACLs, trigger lists and the index list on `external_operations` / `provider_evidence` equal a fresh 0015.

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
  - the precondition refuses pre-existing attempted, in_flight or duplicate rows (two templates for one intent → `NOTIFY_UPGRADE_DUPLICATE`, with the rows unchanged);
  - a concurrent writer blocks on the lock;
  - after up, the index exists with the exact partial predicate.
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

## 10. The step, end to end (PROPOSED, Stage 2)

1. **Gate**, then the test marker, then the skew check.
2. **`recover_expired_notifications`** (§6.5) for this scope.
3. **`claim_notification_work`** → `idle`, or `acquired {opId, intentId}`.
4. **Snapshot** with `guest_notification_snapshot(op)`: ONE SECURITY DEFINER, STABLE statement returning `{class, code, facts, factsHash, recipientHash, email, firstName}` to the app role.
   - Class `PROTECTED` → **no write at all**; the work lease is left to expire → `protected`.
   - Any other non-ELIGIBLE class → `release_notification_work` → `waiting` / `latched` / `not_claimable`, with no other write.
5. **`buildMessageRequest`.** On failure → `latch_guest_notification(RENDER_FAILED)` → `latched`, or `protected` if it returns `'PROTECTED'`.
6. **`claim_guest_notification(…, contentHash(request), factsHash, recipientHash)`** → `claimed`, `latched`, `waiting`, `protected` or `not_claimable` (`SNAPSHOT_STALE` is retried by a later step).
7. **Pre-send** (SQL snapshot plus the JS checks).
   - `PROTECTED` → **no write, no invocation** → `protected`, sends 0.
   - Any other failure → `complete_guest_notification(unknown, PRESEND_ABORTED_NOT_INVOKED)`, sends 0.
8. **ONE bounded `sendMessage`** within `SEND_TIMEOUT_MS`; `sends = 1`. Then `classifyReply`.
9. **`complete_guest_notification(accepted | unknown)`.**
   - `'LEASE_LOST'` → kept in memory only.
   - `'PROTECTED'` → `protected`, sends 1, no write.
10. **`release_notification_work`**, skipped when any earlier phase returned `protected`.

On every path, an outer DB error stops the step at once and is rethrown as the identical object (§9.1).

**Crash matrix.** Recovery uses persisted facts only and never resends.

| Crash point | Persisted state | Next |
|---|---|---|
| Before the claim commits | Nothing (or a latch) | Re-evaluated by class |
| Claim commit ambiguous | Pending, or in_flight plus a render | Pending → re-evaluated. In_flight → lease expiry → unknown (`LEASE_EXPIRED`), sends 0, unless protected by then (§7.6). |
| After the claim, before or after invocation, before completion | In_flight plus a render | Lease expiry → unknown plus a case, unless protected by then (§7.6); never re-invoked |
| Completion commit ambiguous | Succeeded or in_flight | Either is safe; never resent |

## 11. Relation to the 0015 scoped inbox

- The two are invoked separately. The step never uses the inbox `drained` flag, which is not proof.
- `booking_confirmed` relies on the synchronous `recording_conflict_refusal` (K4) and on the hold and case checks (C4, C10).
- The claim takes the `recording_evidence` advisory, which 0010 evidence writers take only for `hostaway_offline_charges` (`0010:386–388`, `:402–404`). Other evidence kinds are serialised only under U1 = a (§6.6).
- A hold that the inbox opens later latches any confirmation not yet claimed (C4, C10).

## 12. Planned deterministic tests (future; unit + disposable PG + mock; no network)

1. **Unit (Stage 2):**
   - templates, with USD formatting and the exact copy;
   - the request grammar, the canonical encoding and `contentHash` test vectors;
   - `classifyReply` against getters, proxies, extra keys, `accepted: 'true'` and bad ids;
   - option validation with zero queries, and deep-freeze;
   - no PII in return values.
2. **Predicates (Stage 1).** Every code in §5.2 / §5.3, positive and negative, including:
   - a second PI;
   - a refund in each state, and a failed refund with captured 0;
   - an unknown capture op;
   - PI evidence `succeeded` on a "not charged" intent;
   - canceled evidence older than a capture dispatch;
   - a `found_active` after a `cancelled`;
   - a missing leg event;
   - a legacy MXN intent → OUT_OF_V1_SCOPE.
3. **Classes (Stage 1):**
   - protected via each of the four references → zero writes (row digests unchanged);
   - WAITING clears only after the webhook row is processed;
   - a latch is written once;
   - no hot loop: 100 latched / waiting / protected rows do not block an eligible one.
4. **At most once (Stage 1 for the DB claim; Stage 2 for invocation):**
   - a timeout, a throw, a bad reply, accepted-but-completion-lost, lease expiry after the claim, an ambiguous claim commit → unknown, `sends ≤ 1`, repeated steps 0;
   - the whole §8.4 map.
5. **Races (hooks):**
   - two workers at once;
   - an E3 drift between snapshot and claim → latch;
   - a non-version fact change (new PI evidence, a case) between snapshot and claim → `SNAPSHOT_STALE`, no write; the retry then claims or latches;
   - a contradiction between claim and pre-send → `PRESEND_ABORTED_NOT_INVOKED`, sends 0;
   - a purge during the claim (blocked) and after the claim (abort);
   - the documented post-snapshot race.
6. **Migration (Stage 1):**
   - grants: the report role sees neither table, nor the page or summary;
   - append-only behaviour;
   - the up precondition and the down gate;
   - fresh-0015 equality after an allowed down, including the index and trigger lists.
7. **Regressions:**
   - the lifecycle rehearsal (rows stay pending unless a reviewed slice changes that);
   - the 0010–0015 suites, `npm test` and `test:db`;
   - mechanical 0016 version pins only, each reported.
   - If the e74a listing-lock failure reproduces: keep the FIRST FULL TAP and STOP. Never rerun to green.
8. **R7 — the one-row invariant (Stage 1):**
   - two concurrent raw INSERTs for one intent with different template keys (two sessions; the second blocks, then `23505` on `external_operations_one_guest_notify` after the first commits; proceeds if the first aborts);
   - a deterministic sequential duplicate → `23505`, and no row change;
   - an E3 same-key replay (applyEvent replay of a producing transition) → absorbed, one row, no error;
   - a raw INSERT with a wrong key, payload, `source_version`, state, non-NULL lifecycle columns or a non-target intent state → refused;
   - a raw UPDATE of `source_version` (same state and with a state change) → refused;
   - pre-existing duplicates at upgrade → `NOTIFY_UPGRADE_DUPLICATE`, with the rows unchanged.
9. **R8 — protection after claim (Stage 1, hooks between phases):**
   - protection appearing through each source:
     - a `provider_evidence` API row (read selector = protected ref);
     - an owner dashboard row;
     - a `recordHostawayCreateResult` id;
     - a `RESOLVE` transition setting the reservation id;
   - each source tested in each window: after claim / before pre-send → `PROTECTED`, no complete, no release; after invocation / before completion → `'PROTECTED'`, no write; after lease expiry / before maintenance → excluded and re-checked, no write;
   - in every case: render, op and case rows byte-equal before and after; summary `protectedClaimed` incremented; never re-claimed;
   - 100 protected expired rows ahead in `lease_until` order do not consume the maintenance LIMIT;
   - a NULL → protected transition holding the intent lock during work acquisition → skipped; committed just before the lock → the re-check skips; no lease written;
   - U1 = a: an evidence insert that holds the `notification_facts` advisory makes the claim wait, and the claim then sees it; a claim holding the advisory makes the evidence trigger wait; no deadlock against `complete_recording_with_evidence` or the 0010 writers (lock-order probe);
   - U1 = b (only if chosen): the documented non-serialisation is demonstrated, not hidden;
   - U2 = a: a direct generic `recoverExpiredOperations` with `opTypes` null DOES mark a protected expired notify row unknown. The test pins the residual.
10. **R9 — predicate precision and API (Stage 1):**
    - C7: a Hostaway `offline_charge_recorded` does not trip `FOREIGN_PAYMENT_INTENT`; each Stripe reference kind does;
    - A2 with no capture op ever dispatched → qualifies, with no NULL comparison;
    - an evidence tie on `observed_at` and `created_at` → resolved by `id` identically at claim and at pre-send;
    - each allowlisted field: absent, JSON null, wrong type, a string number, negative, float, overflow → the exact code (§5.3); never a SQL error, never qualifies;
    - a K3 dashboard-only evidence row → `PI_EVIDENCE_UNPROVEN`;
    - page cursor: NULL start; an exact continuation with no duplicates or gaps on equal `created_at`; an unknown / non-notify / out-of-scope cursor → `22023`; a cursor intent that became protected → positioning only;
    - summary counts against fixtures;
    - every Stage 1 function's return-code set (§13.1) exercised.

## 13. Smallest justified staging (each stage authorized separately)

### 13.1 Stage 1 — DB fence + narrow `operations.js` helpers + disposable-PG tests (no renderer, worker or executor)

**Schema objects (migration 0016):**

| Object | Kind | Notes |
|---|---|---|
| `external_operations_one_guest_notify` | partial UNIQUE index on `external_operations (intent_id) WHERE op_type = 'guest.notify'` | R7 |
| `notification_renders` | table, append-only (`reject_change` UPDATE / DELETE / TRUNCATE), RLS | SELECT app + admin; no report; no write grant |
| `notification_latches` | table, same guards | same grants |
| `notify_op_fence` | BEFORE INSERT OR UPDATE trigger on `external_operations`, `WHEN (NEW.op_type = 'guest.notify')` | §6.3 |
| `notify_claim_binding` | AFTER UPDATE trigger on `external_operations` (pending → in_flight, notify) | §6.3 |
| `notification_evidence_lock` | AFTER INSERT row trigger on `provider_evidence`, kinds `payment_intent` / `hostaway_reservation` / `hostaway_offline_charges` | **U1 = a only** |

**Functions.** All use `search_path = pg_catalog, booking` and `REVOKE ALL FROM PUBLIC`.

| Function | Volatility / security | Grant | Writes | Returns / codes |
|---|---|---|---|---|
| `guest_notification_protected(p_intent)` | STABLE, DEFINER | none (private) | — | boolean |
| `guest_notification_facts(p_op)` | STABLE, DEFINER | none | — | jsonb (§4.2) |
| `guest_notification_refusal(p_op)` | STABLE, DEFINER | none | — | text: a §5.2 / §5.3 code, or NULL |
| `guest_notification_class(p_op)` | STABLE, DEFINER | none | — | text: §7.1 class |
| `gn_obs_int / gn_obs_text / gn_obs_bool(jsonb, text[])` | IMMUTABLE, INVOKER | none | — | value, or ABSENT / MALFORMED sentinel |
| `claim_notification_work(p_worker, p_listing_ids, p_intent)` | VOLATILE, DEFINER | app | `intent_work` lease | `{status: acquired \| idle}`; `22023` on bad args |
| `release_notification_work(p_intent, p_worker)` | VOLATILE, DEFINER | app | `intent_work` lease cleared | `RELEASED \| NOT_HELD \| PROTECTED` |
| `guest_notification_snapshot(p_op)` | STABLE, DEFINER | app | — | `{class, code, facts, factsHash, recipientHash, email, firstName}` |
| `claim_guest_notification(p_op, p_worker, p_template_version, p_content_hash, p_expected_facts_hash, p_expected_recipient_hash)` | VOLATILE, DEFINER | app | render + op claim, or latch | `{status: claimed \| latched \| waiting \| protected \| not_claimable, code}` |
| `latch_guest_notification(p_op, p_worker, p_code)` | VOLATILE, DEFINER | app | latch | `LATCHED \| NOT_ELIGIBLE \| PROTECTED`; only `p_code = 'RENDER_FAILED'` (`22023` otherwise) |
| `guest_notification_presend(p_op, p_worker)` | STABLE, DEFINER | app | — | `{ok, code, dbNow, opLeaseUntil, workLeaseUntil, contentHash, templateVersion, messageRef}`; codes `PROTECTED \| NOT_IN_FLIGHT \| LEASE_NOT_HELD \| VERSION_DRIFT \| FACTS_CHANGED \| RECIPIENT_CHANGED` or a §5.2 code |
| `complete_guest_notification(p_op, p_worker, p_kind, p_ref, p_code)` | VOLATILE, DEFINER | app | op settle + unknown case | `succeeded \| outcome_unknown \| LEASE_LOST \| PROTECTED`; `22023` on bad kind / ref / code |
| `recover_expired_notifications(p_listing_ids, p_intent, p_limit)` | VOLATILE, DEFINER | app | op → unknown + case | `{processed, skippedLocked, skippedProtected}` |
| `list_guest_notifications(p_listing_ids, p_after_op, p_limit)` | STABLE, DEFINER | app, admin | — | rows (§7.5); `22023 NOTIFY_CURSOR_INVALID` |
| `guest_notification_summary(p_listing_ids)` | STABLE, DEFINER | app, admin | — | jsonb counts (§7.7) |
| trigger functions for `notify_op_fence` / `notify_claim_binding` / `notification_evidence_lock` | DEFINER where they read private predicates | none | — | raise `check_violation` with a `NOTIFY_*` message |

**Error policy for these functions.**
- A malformed argument raises `22023`. This is a programming error and is rethrown unchanged by the JS caller.
- A fact or state refusal is returned as a code. It never raises.
- `40P01` / `40001` propagate unchanged; the caller stops.

**Narrow `operations.js` changes (Stage 1):**
1. `NOTIFY_FENCE` in both stages of `claimNextOperation` (§6.1);
2. the `markUnknown` `guest.notify` branch (§6.5 i);
3. the `completeOperation(succeeded)` guard (§6.5 ii).

No other JS changes. No renderer, worker or executor.

**Allowed files for the Stage 1 implementation (exact):**

| File | Change |
|---|---|
| `db/migrations/0016_guest_notification_fence.up.sql` | new |
| `db/migrations/0016_guest_notification_fence.down.sql` | new |
| `lib/booking-db/operations.js` | only the three changes above |
| `test/db/e7-guest-notification-fence.test.mjs` | new; disposable PG only |
| `test/e7-guest-notification-operations.test.mjs` | new; unit checks of the JS fences, with no DB |
| `claude/e7-guest-notification-contract.md` | implementation map section only |
| Existing tests that pin the latest migration version or db-smoke object counts (e.g. `test/db/migrations.test.mjs` and the e74b-d1 / d2 version pins) | **mechanical pins only, where necessary**, each listed in the report |

No other file. 0001–0015, accepted workers, routes, UI, config, deps and fixtures stay unchanged.

### 13.2 Stage 2 — pure module, worker and mock tests (after Stage 1 is accepted)

- `lib/checkout/guest-notification.js` and `lib/booking-db/notification-worker.js`.
- Unit and PG worker tests.
- The packaging pin `OFFLINE_ONLY`.

Neither stage changes E3 producers, other workers, routes, UI, config or deps.

## 14. Residuals (open, not resolved here)

1. `alert.owner` rows keep the generic resend exposure (`repo.js:109–110`, `operations.js:414–418`). This needs a separate slice.
2. N2 = a: notification unknown cases have no closing path and block guest purge. Live use is blocked on a future owner-resolution / retention design.
3. N3 = a: `recipient_hash` survives guest purge. This is OFFLINE only; live retention stays closed.
4. False latches are possible, from a benign open case (C4), malformed evidence or a code change (`RENDER_FAILED`). They are permanent in v1; owner requalification design is deferred.
5. A row can stay WAITING indefinitely if a webhook row never leaves `received` or `failed_retryable`. It stays visible on the page.
6. "Every intent-row change bumps the version" is DB-enforced (`0001:159–162`). Non-intent facts change without a bump and are re-evaluated (§1.1, §6.2 step 8). E3's at-most-one-notify production is now also a DB invariant (R7).
7. **U2 = a (generic GLOBAL / phase-guarded maintenance).** If the exported generic `recoverExpiredOperations` is called directly with notify in scope, it writes to protected expired notify rows (`outcome_unknown` + case). No accepted worker does this (§6.5). The protected guarantee covers notification functions only (§7.6).
8. **Not serialised with notification decisions:** raw non-E3 op INSERTs carrying a protected `reservationId`; cases, refunds, webhooks and holds; and, under U1 = b, `payment_intent` / `hostaway_reservation` evidence. These are committed-before-statement visibility only (§6.6).
9. A raw UPDATE racing an intent-first path can deadlock (`40P01`). The generic global maintenance path is op-first, with SKIP LOCKED.
10. The post-snapshot race (§6.6), including newly visible protection between pre-send and invocation, and TRUST in the strict v3 and identity proofs that run in JS at transition time (§5.2, §5.3).
11. A protected row claimed before protection became visible stays `in_flight` with an expired lease indefinitely under notification functions; it is visible only as a summary count.
12. A trusted executor can do arbitrary work. Labels and `.invalid` do not prove a mock.
13. The historical e74a listing-lock failure stays OPEN.

**Live provider, sender identity, recipient policy, retention and copy: CLOSED.**

## 15. Stage 1 implementation map (OFFLINE; root ACCEPT of `6e3fca5f` as design + addenda A–C; root CODE HOLD on `01c6f036` → corrections R-C1 to R-C3 in §15.9; root ACCEPTED `35097c56` OFFLINE as Stage 1)

**Branch** `feature/e7-guest-notification-fence`, cut from exact `6e3fca5f9177e5fdd34544c974b023c320fc9ce7`.

**Status.** Implemented OFFLINE on disposable local PostgreSQL only. This is not live readiness. There is no renderer, notification worker, executor, provider adapter, SDK, route, UI, scheduler or send. Root decisions U1 = a and U2 = a are applied. N1 = a, N2 = a and N3 = a apply OFFLINE only.

### 15.1 Files (the §13.1 allowed set)

| File | Change |
|---|---|
| `db/migrations/0016_guest_notification_fence.up.sql` | new |
| `db/migrations/0016_guest_notification_fence.down.sql` | new |
| `lib/booking-db/operations.js` | only: two-stage `NOTIFY_FENCE`; the `markUnknown` `guest.notify` branch; the generic `completeOperation(succeeded)` refusal |
| `test/db/e7-guest-notification-fence.test.mjs` | new; disposable PG |
| `test/e7-guest-notification-operations.test.mjs` | new; unit, no DB |
| `claude/e7-guest-notification-contract.md` | this map + status line |
| `claude/e7-offline-lifecycle-rehearsal.md` | status pointer |
| mechanical migration-version pins | mechanical pins only (migration version arrays / the migration name list gain 16; table counts 25 → 28; two privilege-matrix rows + the empty token-table row). The exact diff is in this commit: `test/db/migrations.test.mjs`, `e7-scoped-recording-inbox`, `e74b-d1-assessments`, `e74b-d1-completion-binding`, `e74b-d1-owner-cases`, `e74b-d1-release`, `e74b-d2-recording-evidence`; table-count pins in `guests.test.mjs`, `intents.test.mjs`, `migrations.test.mjs`; `scripts/db-smoke.mjs` (privilege matrix rows + table count) |

Migrations 0001–0015, every accepted worker, fixtures, config and dependencies are byte-identical.

### 15.2 SQL object / security map (as implemented)

All functions use `search_path = pg_catalog, booking` and have `REVOKE ALL … FROM PUBLIC`. The ACLs below were read from the catalog by the focused suite.

**Objects**

| Object | Kind | Notes |
|---|---|---|
| `external_operations_one_guest_notify` | partial UNIQUE index `(intent_id) WHERE op_type = 'guest.notify'` | R7 |
| `notification_renders` | table; append-only (`reject_change` UPDATE / DELETE / TRUNCATE); RLS | SELECT + policy for app and admin; no report access; no write grant |
| `notification_latches` | table; same guards and grants | |
| `notification_write_authority (txid xid8, operation_id, action)` | **private** table; RLS, no policy, no grant | Addendum A token; see §15.3 |
| `notify_op_fence` | BEFORE INSERT OR UPDATE on `external_operations` `WHEN (NEW.op_type = 'guest.notify')` | **SECURITY INVOKER** |
| `notify_claim_binding` | AFTER UPDATE (pending → in_flight, notify) | **SECURITY INVOKER** |
| `notification_evidence_lock` | AFTER INSERT on `provider_evidence`, kinds `payment_intent` / `hostaway_reservation` / `hostaway_offline_charges` | **SECURITY INVOKER** (U1 = a) |

**Functions granted to the runtime role (all SECURITY DEFINER, VOLATILE unless stated)**

| Function | Grant | Returns / codes |
|---|---|---|
| `claim_notification_work(text, integer[], uuid)` | app | `{status: acquired, opId, intentId, workLeaseUntil}` or `{status: idle}` |
| `release_notification_work(uuid, text)` | app | `RELEASED` / `NOT_HELD` / `PROTECTED` |
| `guest_notification_snapshot(uuid)` | app | `{class, code, template, facts, factsHash, recipientHash, email, firstName}`, or `{class}` only when not ELIGIBLE (PROTECTED included) |
| `claim_guest_notification(uuid, text, text, text, text, text)` | app | `{status: claimed \| latched \| waiting \| protected \| not_claimable, code}` |
| `latch_guest_notification(uuid, text, text)` | app | `LATCHED` / `NOT_ELIGIBLE` / `PROTECTED` / `WORK_LEASE`; only `RENDER_FAILED` accepted |
| `guest_notification_presend(uuid, text)` | app | `{ok, code, dbNow, opLeaseUntil, workLeaseUntil, contentHash, templateVersion, messageRef}` |
| `complete_guest_notification(uuid, text, text, text, text)` | app | `succeeded` / `outcome_unknown` / `LEASE_LOST` / `PROTECTED` |
| `recover_expired_notifications(integer[], uuid, integer)` | app | `{processed, skippedLocked, skippedProtected}` |
| `list_guest_notifications(integer[], uuid, integer)` | app, admin; STABLE | rows |
| `guest_notification_summary(integer[])` | app, admin; STABLE | counts |

**Private helpers (no grant)**
- DEFINER: `guest_notification_protected` (STABLE), `guest_notification_class` (STABLE), `guest_notification_facts`, `guest_notification_recipient_hash` (STABLE), `guest_notification_refusal`, `gn_latest_evidence` (STABLE), `gn_lock_bundle`, `gn_facts_advisory`.
- INVOKER, IMMUTABLE: `gn_templates`, `gn_target_state`, `gn_recipient_in_scope`, `gn_obs`, `gn_obs_int`, `gn_obs_text`, `gn_obs_bool`, `gn_hash_facts`, `gn_non_latching`, `gn_check_worker`, `gn_check_scope`.

**Error policy**
- A malformed argument raises `22023`.
- A fact or state refusal is returned as a code and never raises.
- `40P01` / `40001` propagate unchanged. The new APIs have no retry loop.

### 15.3 Addendum A — caller authority

**The mechanism.** The fence is **SECURITY INVOKER**, so `current_user` inside it is the caller.
- For a raw runtime-role UPDATE, `current_user` = `test_app`, so `is_privileged()` is false and the fence refuses with `NOTIFY_CLAIM_AUTHORITY` or `NOTIFY_COMPLETE_AUTHORITY` (`42501`).
- Inside the dedicated SECURITY DEFINER APIs, `current_user` is the schema owner.

**The binding to the dedicated API.** It does **not** rest on `is_privileged()` alone. The API inserts a row `(pg_current_xact_id(), op, 'claim' | 'complete')` into the private `notification_write_authority` immediately before its UPDATE, and deletes it immediately after. The fence requires that exact row.
- No role except the schema owner can read or write that table.
- So other booking SECURITY DEFINER functions, and a session-settable value, cannot authorise a notify claim or success.
- `in_flight → outcome_unknown` is allowed for any role. It is the fail-safe direction used by the generic `markUnknown` branch.

**Proven as the actual app role.**
- Raw `pending → in_flight`: refused.
- Raw `in_flight → succeeded` with a valid render present: refused.
- Wrong-worker completion: `LEASE_LOST`, no write.
- Expired-lease completion: `LEASE_LOST`.
- The dedicated APIs work for the legitimate lease holder.
- The generic success helper refuses with `NOTIFY_SUCCESS_REQUIRES_DEDICATED_COMPLETION`.
- Generic `claimNextOperation` returns null, with and without `opId`.
- The token table is unreadable and unwritable for the app role.

**Not a security boundary.** The schema-owner or superuser session: it can write the token itself. The suite only shows that the owner without a token is refused. Inside the APIs, lifecycle, lease, payload and render are still validated after the locks, and the AFTER binding trigger re-checks the render.

### 15.4 Addendum B — concurrency as implemented

- **Call contract.** Every writer entrypoint is ONE top-level AUTOCOMMIT call per transaction. No universal deadlock-freedom claim is made for arbitrary multi-call transactions.
- **Lock bundle.**
  1. intent `FOR SHARE`;
  2. create attempt `FOR SHARE`;
  3. work / op / guest rows as the path needs;
  4. the `booking.notification_facts` advisory;
  5. the `booking.recording_evidence` advisory (claim and latch only).
- **Fresh re-check.** Protection and class are re-checked in a fresh READ COMMITTED statement after the locks, before every scoped write.
- **SKIP LOCKED variants.** `gn_lock_bundle(…, true)` is used by work acquisition and maintenance.
- **Maintenance order.** `recover_expired_notifications` chooses candidates with protected intents excluded before `ORDER BY lease_until, id LIMIT`, then processes them in ONE deterministic `ORDER BY intent_id, id`.
- **U1 trigger timing.** The trigger fires INSIDE the evidence INSERT statement. That is before the 0010 writers' `recording_evidence` advisory (`0010:386–388`, `:402–404`) on both the API and dashboard paths. `zz1_evidence_enqueue` takes no lock. So every party takes `notification_facts` before `recording_evidence`.

**Observed waits (CLAUDE-RUN, both commit orders where applicable)**

| Pair | Result |
|---|---|
| Evidence insert (dashboard; each of the 3 kinds) vs claim | Claim waits; evidence waits on a held claim |
| API `record_provider_evidence` vs a held completion | Evidence waits |
| Evidence vs work acquisition and release | Both wait |
| Evidence vs scoped maintenance | Maintenance waits, then a fresh re-check sees PROTECTED evidence committed meanwhile and skips (`skippedProtected: 1`, no write) |
| Guest purge vs a held claim | Purge waits on the guest-row KEY SHARE |
| Accepted attempt-row write vs a held claim / held completion | Waits in both orders |
| An E3 transition holding the intent row during work acquisition | SKIP LOCKED → idle, no write |

- **Impact on accepted evidence paths.** At most these waits, only while a notification decision on the same intent is in flight. Every accepted-worker chain in the suite runs through the trigger unchanged.
- **Legal NULL → protected.** The only notify-bearing route is RESOLVE confirmed. It needs `found_active` evidence for the result ref (`0003:603–630`), and that evidence is itself a protection source, so protection becomes visible at the evidence insert. The intent-row lock interplay of a transition is tested separately: SKIP LOCKED during work acquisition.
- **Late protected create id.** Not reachable for a notify-bearing intent: create results are recorded before any terminal state, and `recordHostawayCreateResult` only updates `responded_at IS NULL` rows (`repo.js:617–627`). The test pins `{ recorded: false }`.

### 15.5 Addendum C — replay, facts and failure

**Replay paths, kept distinct:**
- E3 same-event replay: `applyEvent` returns `duplicate` before any INSERT.
- Same-key direct `ON CONFLICT` INSERT that is canonical and current: the BEFORE fence passes and the arbiter absorbs it.
- Stale same-key direct replay: refused by the BEFORE fence, which runs before the arbiter. This is documented, not relaxed.
- Different template: refused by the fence's state binding; the unique index is proven in isolation.

**Evidence ordering.** `observed_at, created_at, id` with the uuid tie-break, identical at claim and pre-send.

**Fail-closed observed fields.** Absent, JSON null, wrong type, string numbers, negative, float, overflow and non-object intermediates are tested. ABSENT is accepted only for explicitly optional refund fields.

**Hashes.** Snapshot hashes are SQL-derived and were re-derived independently in the test. The content hash is one synthetic TRUST constant; no message is rendered.

**Original-error rule.** Original outer JS errors propagate as the identical object with no follow-up query. Generic helper semantics changed only as authorized.

### 15.6 Deviations from the contract text (each deliberate; for root review)

1. **VOLATILE instead of STABLE.** `guest_notification_presend`, `guest_notification_snapshot` and `guest_notification_refusal` are VOLATILE plpgsql, not "STABLE single snapshot".
   - The refusal reuses VOLATILE 0010 / 0011 predicates (`recording_latest_id`, `recording_active_hold_id`, `recording_conflict_refusal`).
   - Each statement therefore reads all commits that precede it (statement-level READ COMMITTED), not one snapshot.
   - No single-snapshot claim is made.
2. **`claim_notification_work` arguments.** It has no `p_lease_ms`; the work lease is fixed at 120 s. It returns `workLeaseUntil`.
3. **`latch_guest_notification`.** It also returns `WORK_LEASE`, and requires the caller's live work lease.
4. **Extra refusal codes.** `NOT_NOTIFY`, `TEMPLATE_UNKNOWN` and `RECORDING_HOLD_ACTIVE` (C10). Their order: scope / waiting codes come before C1 / C2 (non-latching first); `RECIPIENT_MISSING` comes before scope.
5. **X4 "entry into capture_failed".** It is the first transition into `capture_failed` from another state. The leg events are themselves `capture_failed → capture_failed` transitions. Found by the positive chain; mutant M11.
6. **Class `OTHER`.** Used for non-pending / non-claimed states, and for a pending row with a render or attempts.
7. **The fence refuses `late_result_*` writes on notify rows.** A generic late completion therefore raises an unmapped `23514` (`repo.js` `DB_SAFETY_CODES` is outside the allowed files). No accepted path does this.

### 15.7 Tests and results (CLAUDE-RUN)

**Focused suites.** `test/db/e7-guest-notification-fence.test.mjs` (13 tests) plus `test/e7-guest-notification-operations.test.mjs` (5 tests): **18 / 18 pass**. They include one real 61 s wait; no lease is manipulated. What they cover:
- the positive lifecycle for all 3 templates, on accepted-worker USD chains;
- addendum A, tested as the actual app role;
- R7: E3 replay, direct same-key and stale-replay INSERTs, the index in isolation under both concurrent commit orders;
- R9 predicate codes, including fail-closed field values, the id tie-break, and scope / waiting rows that never latch;
- latch / `SNAPSHOT_STALE`;
- addendum B lock waits;
- R8 protection after a claim;
- the expiry batch: scoped maintenance, protected noise before LIMIT, protection during maintenance, `LEASE_LOST`, the generic `markUnknown` branch on a non-protected row, durable unknown;
- page / summary / cursor;
- attempt-row serialisation;
- migration up precondition / refused down / exact down / identical re-up / JS compatibility;
- unit checks of the `operations.js` branches, and identical-error propagation.

**Mutation probes: 27 targeted, 27 caught.** Each mutant was restored and hash-checked (sha256 of `0016.up` `1902d3ff…`, `0016.down` `37c20976…`, `operations.js` `f3520f20…`).
- M19 (claim latching a non-latching code) first SURVIVED.
- That was a coverage gap: no test claimed a WAITING row while holding the work lease. A test was added, and M19 is now caught.
- No equivalent survivors remain.

| Mutants | What each removes or changes |
|---|---|
| M01–M04 | claim / success authority; fence made DEFINER |
| M05–M06 | `→ pending` allowed; `source_version` not frozen |
| M07–M08 | the unique index; the INSERT binding |
| M09–M12 | C4; the K3 source check; X4 entry; int type check |
| M13–M17 | protected re-checks: claim / complete / maintenance before LIMIT / maintenance post-lock; work class re-check |
| M18 | the U1 trigger |
| M19 | latch on a non-latching code |
| M20–M21 | the up duplicate check; the down gate |
| M22 | report grant |
| M23 | cursor `>=` |
| M24–M27 | the JS fence (each stage), the `markUnknown` branch, the success guard |

**Regressions.**
- `npm test`: **695 / 695**.
- `test:db` before the pins: 416 / 446. The 30 failures were 29 mechanical version / count / privilege pins plus the e72 item below.
- `test:db` final: **445 / 446**, ONE failure, kept as the first full TAP. The e74a listing-lock guard PASSED. The historical e74a failure stays OPEN; it was not reproduced.

**The one open failure is not mechanical and was not edited (outside the allowed files): `e72-reservation-worker.test.mjs:381`.**
- The test plants a NON-canonical `guest.notify` row with a raw runtime INSERT: template `"t"`, key `test-notify:…`, on a `reservation_unknown` intent. It does this to show the reservation worker never touches notifications.
- The authorized 0016 INSERT fence (§6.3, R7) now refuses that row with `NOTIFY_INSERT_REFUSED`. That premise can no longer be constructed.
- **Root decision needed:** (a) authorize a fixture-only adaptation (recommended): plant the row as labelled TEST SETUP with triggers bypassed, or assert the refusal plus the worker's non-touch of a canonical row; or (b) relax the fence (not recommended).

All TAP files are kept in the session scratchpad (`gnf/tap/`): `focused-final.tap`, `npm-test-final.tap`, `test-db-run1-preadapt.tap`, `test-db-run2-postpins.tap`, `test-db-final.tap`, and per-mutant `gnf/mut/M*.tap`.

### 15.8 Residuals (unchanged from §14, plus)

- **U2 = a.** The generic exported `recoverExpiredOperations` (global and phase-guarded) writes `outcome_unknown` plus a case to an expired notify row whatever its protection. No accepted worker calls it for `guest.notify`. Not exercised on a protected row; the residual is pinned on a non-protected row.
- **Raw non-E3 INSERTs.** Raw INSERTs of other op types with a protected payload are outside the scoped guarantee.
- **The post-snapshot race.**
- **Unresolvable unknown cases.** Unknown cases block purge (N2 = a).
- **No catalogued refusal mapping.** The new `NOTIFY_*` fence codes are not in `DB_SAFETY_CODES`, so a generic helper surfaces them as raw errors.
- **e74a.** The historical listing-lock failure stays OPEN.

### 15.9 Root CODE HOLD on `01c6f036` — corrections R-C1 to R-C3 (same branch, corrections only; ACCEPTED at `35097c56` OFFLINE as Stage 1)

#### R-C1 — consistent observation snapshots and end-of-check timing

**Mechanism.** The shared 0010 / 0011 predicates are left unmodified. The two observation functions, `guest_notification_snapshot` and `guest_notification_presend`, now REQUIRE an explicit, caller-created `READ ONLY REPEATABLE READ` transaction.
- The first statement of each function is the private guard `gn_require_observation_context()`.
- That guard raises `25000 NOTIFY_SNAPSHOT_CONTEXT` for anything else: autocommit, read-write RR, read-only RC, or SERIALIZABLE.
- Under RR, every statement in the transaction reads ONE snapshot. This includes the VOLATILE shared predicates. So nothing is relabelled STABLE.

**Recipient binding.** It is direct.
- The snapshot's `recipientHash` is now `gn_recipient_hash_of(email, first_name)` of the exact guest row whose `email` / `firstName` it returns.
- The pre-send compares the hash of the guest row it read in the same snapshot.
- The claim still re-derives the hash from the current, KEY-SHARE-locked row. A stale observation therefore gets `SNAPSHOT_STALE`.

**Pre-send timing.** `dbNow` is captured at the END of all checks. Both leases (op and work) are then re-validated against that instant (`lease_until > dbNow`). A delayed check can only shrink the reported margin, or refuse.

**Caller contract** (Stage 1 PG helpers now; Stage 2 worker later):
1. `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`.
2. ONE observation `SELECT`.
3. `COMMIT`.
4. The final frozen-request, JS-clock skew, elapsed-time and margin checks.
5. Invoke.

There is never any network inside a DB transaction. A query or COMMIT error stops the step with no invocation, no follow-up mutation and no retry.

**The guarantee is bounded.** The observation is one consistent snapshot. Commits after it (protection, evidence, state, a work-lease release) are the documented later race; they are caught only by the next locked decision. For example, completion refuses with `PROTECTED`. This is not current-provider truth.

**Claim argument.** `claim_guest_notification` accepts a NULL expected recipient hash (a missing recipient): the refusal then latches `RECIPIENT_MISSING`. A non-NULL current hash gives `SNAPSHOT_STALE`.

#### R-C2 — work selection cannot be starved

`claim_notification_work` now filters out, in SQL BEFORE `ORDER BY created_at, id LIMIT 1`:
- rows whose `intent_work` lease is still live;
- rows not yet due (`next_attempt_at > clock_timestamp()`);

This is in addition to the existing scope, class and protection filters. The locked SKIP LOCKED re-check stays authoritative, and now also re-checks dueness. No other worker or generic helper changed.

**Not claimed.** Absolute fairness under row locks held indefinitely by other transactions: such a row costs one of the 10 skips per call.

#### R-C3 — the authorized e72 adaptation (only the test at `e72-reservation-worker.test.mjs:375`)
- The old raw non-canonical INSERT is now a negative assertion: it rejects with `NOTIFY_INSERT_REFUSED`.
- The worker-isolation assertion is preserved with a REAL canonical notification. E3 queues it on a separate synthetic terminal booking, built by the accepted `F.confirmed` repo-path fixture on listing `L(70)`.
- The reservation worker then runs 8 steps over a listing scope covering both bookings, with no intent narrowing. Reservation work proceeds, and the canonical row stays pending, undispatched and byte-identical.
- No triggers are disabled, and no shared fixture or runtime file changed.

#### Red / green evidence (CLAUDE-RUN; narrow test probes only)

The `gn_probe_*_01c6` probe functions are the exact `01c6` bodies under another name. They are dropped after use; the suite asserts that none remains. Barrier injection into a real function is restored and its `md5(pg_get_functiondef)` checked identical.

| Control | RED on the 01c6 body | GREEN now |
|---|---|---|
| Snapshot under a purge + reinsert barrier | Returns guest A's email together with guest B's recipient hash | Returns guest A consistently, with the hash of that row; the claim with it gives `SNAPSHOT_STALE`, no write; the non-racing control (reinsert before the observation) gives guest B and is claimable |
| Pre-send delayed 1.5 s | `dbNow` more than 1 s before the delay ended (overstated margin) | `dbNow` after the delay |
| Pre-send delayed across the op-lease expiry (inside the real 61 s expiry wait) | `ok:true`, with `dbNow` before the expiry, while returning after it | `LEASE_NOT_HELD` |
| Pre-send drift: protection / evidence / state / work-lease release committed before the observation | — | `PROTECTED` / `FACTS_CHANGED` / `VERSION_DRIFT` / `LEASE_NOT_HELD` |
| The same drift committed during the observation | — | `ok:true` (one snapshot, the bounded race). For protection, the next completion returns `PROTECTED` with no write |
| Work selection: 100 older live-leased rows + older WAITING / PROTECTED / LATCHED / not-yet-due rows + one free row | `idle` | Acquires the free row; all 114 other rows (100 leased + WAITING + PROTECTED + LATCHED + 11 not-yet-due) byte-unchanged; intent narrowing honours leases and dueness; another scope is idle |
| Wrong observation context (×4) | — | Refused (`25000`) |

The token table is empty after all success, refusal and error paths.

**Targeted mutants on the changed paths only.** 8 probes, each restored and hash-checked. The earlier 27 were not rerun.

| Mutant | What it changes | Result |
|---|---|---|
| M28 / M29 | snapshot / pre-send context guard removed | caught |
| M30 | snapshot recipient hash from an independent read (the 01c6 style) | **survived — equivalent** (see below) |
| M31 | `dbNow` captured before the checks | caught |
| M32 | end-of-check lease re-validation removed | caught |
| M33 | live-lease filter before `LIMIT` removed | caught |
| M34 | due filter before `LIMIT` removed | first survived (only 1 not-yet-due row); test strengthened to 11; now caught |
| M35 | post-lock due re-check removed | **survived — equivalent** (see below) |

Why the two survivors are equivalent:
- **M30.** Inside the enforced READ ONLY REPEATABLE READ context, an independent read sees the same snapshot. The context guard itself is covered by M28.
- **M35.** The not-yet-due filter already runs before `LIMIT`, and the notify fence freezes `next_attempt_at` after insert, so a row cannot become not-yet-due between selection and lock. The re-check is defence in depth.

**Runs (CLAUDE-RUN)**

| Run | Result |
|---|---|
| Focused (`e7-guest-notification-fence` + operations unit) | 21 / 21 |
| `e72-reservation-worker.test.mjs` | 31 / 31 |
| `npm test` | 695 / 695 |
| `test:db` | **449 / 449**; the e74a listing-lock guard passed (the historical failure stays OPEN, not reproduced) |

- No new mechanical pins were needed for these corrections.
- TAP is in the session scratchpad: `gnf/tap/rc-*.tap`, `e72-adapt-*.tap`; per-mutant `gnf/mut/M28–M35.tap`.
- **Deviation 1 of §15.6 is superseded.** The observation functions stay VOLATILE, and consistency now comes from the enforced READ ONLY REPEATABLE READ caller transaction, not from a STABLE label.

## 16. Stage 2 implementation map (OFFLINE / INJECTED MOCK; root ACCEPT of `35097c56` as Stage 1 + Stage 2 authorization; root CODE HOLD on `44e8d0a8` → gate correction R-G1 in §16.6; root ACCEPTED `ede4c43c` OFFLINE as Stage 2)

**Status pointer (2026-11-04):** readiness consolidation in `claude/e7-offline-readiness.md` on `feature/e7-offline-readiness` (DOCS ONLY, pending root readiness review).

**Branch** `feature/e7-guest-notification-worker`, cut from exact `35097c56518ff6ca922d8698ff93a5b7248cfce9`. Stage 1 code acceptance is not merge / deploy / live authorization; this stage adds no route, scheduler, runner, adapter, config, dependency or UI.

### 16.1 Files (the authorized set)

| File | Change |
|---|---|
| `lib/checkout/guest-notification.js` | NEW. Pure: no I/O, clock, network or environment |
| `lib/booking-db/notification-worker.js` | NEW. ONE bounded notification step; injected executor only |
| `test/e7-guest-notification.test.mjs` | NEW. Pure vectors + the step against a scripted in-memory pool |
| `test/db/e7-guest-notification-worker.test.mjs` | NEW. Disposable local PG, accepted-worker chains |
| `test/packaging-closure.test.mjs` | `BOOKING_DB_FILES` + `notification-worker`; both new modules in `OFFLINE_ONLY` |
| this contract §15 wording, §16; lifecycle status pointer | docs |

Unchanged: 0001–0016, `operations.js`, `repo.js`, `pool.js`, every accepted worker, shared fixtures (`test/db/fixtures.mjs`, `harness.mjs`), e72 and the lifecycle rehearsal (its `guest.notify` rows stay queued). The optional e72 title clarification was not taken (the file is untouched).

### 16.2 Pure module (`guest-notification.js`)

| Export | Contract |
|---|---|
| `buildMessageRequest({template, facts, guest, sender, opId})` | `{ok:true, request}` deep-frozen with EXACTLY `channel, from, fromName, messageRef, subject, template, templateVersion, text, to`; or `{ok:false, code}` with `TEMPLATE_INVALID / OP_ID_INVALID / RENDER_FACTS_INVALID / CURRENCY_NOT_SUPPORTED / RECIPIENT_INVALID / SENDER_INVALID` |
| recipient | always the bound guest row's email (`.invalid` grammar = the SQL `gn_recipient_in_scope`); no override, CC, BCC, reply-to, attachment, HTML, link, token or access instruction exists |
| sender | explicit synthetic `{fromAddress (.invalid), fromName}`, exact keys; no default |
| copy | English MOCK copy, plain text, per template; amounts USD only (`$1,234.56 USD`); not-charged templates carry the pending-authorization sentence and no amount |
| `canonical(request)` / `contentHash(request)` | sorted keys, strings / safe integers only; `sha256('gn-v1-content\n' + canonical)`; TRUST field stored by 0016 |
| `recipientHash(email, firstName)` | JS mirror of `gn_recipient_hash_of`; used ONLY to cross-check that an observation is self-consistent |
| `classifyReply(reply)` | `accepted` only for EXACTLY `{accepted:true, providerMessageId:/^mock-[A-Za-z0-9._:-]{1,95}$/}` (plain or null prototype, two enumerable data properties); everything else `unknown` `REPLY_SHAPE`, a hostile object `REPLY_UNREADABLE`; never throws. `accepted` means mock-accepted, never delivered or read |

### 16.3 Step (`runNotificationStep(pool, opts)`) — caller / error map

Fixed budgets (`NOTIFICATION_LIMITS`, not configurable): maintenance batch 5; ONE send ≤ 10 000 ms (AbortController); pre-send margin 5 000 ms (both leases need ≥ 15 000 ms room); |JS − DB| ≤ 2 000 ms; skew probe round trip ≤ 1 000 ms; each observation ≤ 2 000 ms monotonic from BEFORE `BEGIN` through `COMMIT`; step ≤ 30 000 ms monotonic from step start to the invocation decision (including the send timeout); late-reply window 2 000 ms (memory only). Monotonic = `performance.now()`; the injected wall clock is used only for skew, so a regressing wall clock can only refuse.

| # | Phase | Calls | Outcome / error |
|---|---|---|---|
| 0 | gate (pure) | none — **zero queries** | `OPTIONS_INVALID` (exact keys; own, string-keyed, enumerable DATA properties from ONE descriptor snapshot per object into a null-prototype copy; `__proto__` keys refused; `listingIds` copied from its descriptors as a dense ordinary array, see §16.6; no ordinary getter / iterator / caller method invoked; introspection errors caught at the gate only; workerId / scope / intent / sender / executor label / clock / hooks) or `ENV_REFUSED`. Basis deep-frozen copy before any await |
| 1 | marker | `SELECT environment FROM booking.instance` (ONE) | wrong / absent → `DATABASE_NOT_TEST`; a thrown error propagates as the same object, nothing follows |
| 2 | skew | `SELECT clock_timestamp()` | `CLOCK_SKEW` |
| 3 | maintenance | `recover_expired_notifications(scope, intent, 5)` | scoped, notification-only; never a generic helper or inbox drain |
| 4 | work | `claim_notification_work` | `idle` → `{outcome:'idle', sends:0}`; non-`acquired` / malformed → `TypeError` |
| 5 | initial observation | fresh connection → `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` → ONE `guest_notification_snapshot` → `COMMIT` → release | `PROTECTED` → zero writes (work lease expires) → `protected`; `LATCHED` → release → `latched`; `WAITING` / `OUT_OF_V1_SCOPE` → release → `waiting`; `SUCCEEDED / IN_FLIGHT / UNKNOWN / OTHER / NOT_NOTIFY` → release → `not_claimable`; unknown class → `TypeError`. Error: ROLLBACK + connection discarded, the same object rethrown, no release |
| 6 | render | pure `buildMessageRequest` after `recipientHash(email, firstName) === snapshot.recipientHash` | failure → `latch_guest_notification(RENDER_FAILED)`: `LATCHED` → release → `latched` (+ `renderCode`); `PROTECTED` → no further write; `NOT_ELIGIBLE` / `WORK_LEASE` → release → `not_claimable`. Never a fabricated recipient / message |
| 7 | claim | `claim_guest_notification(op, worker, 'gn-v1', contentHash, factsHash, recipientHash)` | `protected` → no write; `latched` / `waiting` / `not_claimable` (incl. `SNAPSHOT_STALE`) → release; an ELIGIBLE row whose snapshot already carried a refusal code is still claimed so SQL records its exact latch / waiting code |
| 8 | pre-send observation | same wrapper, ONE `guest_notification_presend` | `PROTECTED` → zero writes → `protected`; other refusal → abort (below) |
| 9 | final synchronous checks | none (no await / hook / query until the invocation) | `REQUEST_MISMATCH` (hash / version / messageRef vs the audit), `OBSERVATION_SLOW`, `PRESEND_SHAPE`, `CLOCK_SKEW`, `LEASE_ROOM` (`leaseUntil − dbNow − monotonic since BEFORE the observation ≥ 15 000` for op AND work), `STEP_BUDGET`. Abort → `complete_guest_notification(unknown, PRESEND_ABORTED_NOT_INVOKED)`: `outcome_unknown` → release → `unknown`; `LEASE_LOST` → release → `lease_lost`; `PROTECTED` → no release |
| 10 | invocation | `executors.sendMessage(request, {signal})` ONCE, synchronously | `sends = 1`; throw / reject → `SEND_THREW`; non-exact reply → `REPLY_SHAPE` / `REPLY_UNREADABLE`; timeout → abort + `SEND_TIMEOUT`, late reply observed in memory only (`late`). Never retried |
| 11 | settlement | `complete_guest_notification(accepted | unknown)` | `succeeded` → release → `accepted` (`contentHashPrefix`); `outcome_unknown` → release → `unknown`; `LEASE_LOST` → release → `lease_lost`; `PROTECTED` → **no release**. A thrown error propagates unchanged with NO further query (no try / finally release); a release failure after an acknowledged settlement propagates and never reclassifies it |

Results are deep-frozen and carry ids, codes and counts only. Deviation from §9.3 (additive, codes only): `release` (`RELEASED / NOT_HELD / PROTECTED`), `abort` (the local / SQL pre-send code), `renderCode` and `late` (a promise resolving to `{kind:'none'}` or `{kind:'late_reply', classified}`); `hooks` (`afterInitialObservation`, `afterClaim`, `inObservation`, `afterSend`) are test-only and never run between the final decision and the invocation.

**Accepted race (unchanged, honest):** a contradiction / money / protection committed after the pre-send snapshot (or while the mock processes) can coincide with an invocation; it becomes visible to the next locked decision (settlement `PROTECTED`, no write). No freshness, provider, delivery or exactly-once claim. At-most-one INVOCATION per row is a property of this reviewed worker; the DB enforces at-most-one claim.

### 16.4 Tests and results (CLAUDE-RUN)

| Run | Result |
|---|---|
| Focused unit `test/e7-guest-notification.test.mjs` + packaging | 27 / 27 (19 + 8) |
| Focused PG `test/db/e7-guest-notification-worker.test.mjs` | 12 / 12 (≈ 85 s; one real 61 s op-lease wait, one real 10 s send timeout) |
| Regressions: Stage 1 fence, migrations, scoped inbox (unit + PG), lifecycle rehearsal, e72, recording worker, notify operations | 117 / 117 |
| `npm test` | **714 / 714** (695 + 19) |
| `test:db` | **461 / 461** (449 + 12); the e74a listing-lock guard passed (historical failure stays OPEN, not reproduced) |

Evidence (PG, accepted-worker USD chains, synthetic `.invalid` guests, global fetch guard: 0 network attempts):
- All 3 templates: one step → `accepted`, invocation count 1 (asserted on the sink, separately from claim / audit rows); the render's `content_hash` equals `contentHash` of the invoked request; 3 further steps (other worker ids) + scoped maintenance → `idle`, row digests unchanged, sends 1 total.
- Real-DB statement order: marker → clock → maintenance → work → [connect, RR READ ONLY BEGIN, snapshot, COMMIT, release] → claim → [connect, BEGIN, presend, COMMIT, release] → **invocation** (nothing in between) → completion → release.
- Drift snapshot → claim: open case → `latched OPEN_CASE`; purge + reinsert → `SNAPSHOT_STALE`, released, next step sends ONCE to the new row; protection → `protected`, digest unchanged.
- Drift claim → pre-send: API and historical (dashboard, past `observed_at`) evidence contradictions, open case, state → `PRESEND_ABORTED_NOT_INVOKED`, sends 0, never re-claimed; protection after claim / after invocation → zero writes, no release, digests unchanged through the final expiry.
- Latched (historical contradiction), WAITING, out-of-scope (`.example`, never sent) and protected rows in one scope: byte-unchanged, the free row is still served; WAITING becomes eligible after its webhook is processed and is sent once.
- 4 parallel workers × 4 rounds over overlapping scopes: 4 rows → exactly 4 invocations, distinct `messageRef`s.
- Leases / timing (TEST SETUP lease shortening labelled): work or op lease room < 15 s → `LEASE_ROOM`; expired work lease → `LEASE_NOT_HELD`; slow RR observation and slow COMMIT → `OBSERVATION_SLOW`; wall-clock regression → `CLOCK_SKEW`; initial skew → refused after 2 statements. All sends 0.
- Executor faults: throw, applied-then-rejected, non-exact accepted, non-mock id → code-only unknown + one case (`{errorCode, opType, operationId}` only), invocations 1, no resend; timeout → aborted at 10 s, `SEND_TIMEOUT`, late accepted reply observed in memory with no DB change.
- Outer DB faults (identity-checked): marker error; initial observation COMMIT loss → ROLLBACK + discard, 0 sends, no claim; pre-send read error / COMMIT loss → 0 sends; completion acknowledgement lost with the completion COMMITTED → durable `succeeded`, no further query, no release, never resent; NOT committed → `in_flight`, never resent, later `LEASE_EXPIRED`; release failure after success → error propagates, success durable, no unknown case. Crash before claim → pending, no render; crash after claim → in_flight, 0 sends.
- Render failure (recipient cross-check) → `RENDER_FAILED` latch, no claim.
- Final real expiry: every crashed / lost row → `outcome_unknown LEASE_EXPIRED` by the scoped maintenance inside a step; protected rows untouched; invocation counts unchanged.

Unit (scripted pool): deterministic copy / USD format / canonical / content-hash / recipient-hash vectors; adversarial request, reply (getters, non-enumerable, symbol keys, class instances, hostile proxies) and option shapes (28 gate refusals, each with **zero queries**, accessors never invoked); basis copy; marker / observation / COMMIT / settlement / release error identity with no follow-up; no PII in any result; microtask boundary between the pre-send COMMIT and the invocation; every local abort; every SQL status; unexpected shapes → `TypeError`.

**Targeted mutants (worker decision boundaries only):** 25 probes W01–W25 (RR context, lease room, monotonic elapsed, observation budget, skew, request recheck, step budget, protected at each phase, try / finally release, resend, absent marker, recipient cross-check, swallowed error, connection reuse, basis copy, enable flag, reply classifier, query / await before the invocation, maintenance, unbounded timeout, late-reply write). **25 / 25 caught**, file restored and sha256-checked after each. After the run two result fields were aligned with §9.3 (no ids on `protected`, 8-hex prefix) and the focused + full suites above were run on the final code.

TAP (session scratchpad): `gnf/tap/s2-*.tap`; per-mutant `gnf/mut2/W01–W25.tap`.

### 16.5 Residuals (in addition to §14 / §15.8)

1. A crash between work acquisition and the claim leaves the row pending under a live work lease for up to 120 s (no release after an outer failure); it is then re-evaluated and can be sent at most once (it never was).
2. `afterSend` / settlement-time protection means a mock invocation already happened; the DB stays unchanged (`PROTECTED`), the row stays `in_flight` and is summary-visible only (§14 item 11).
3. The executor is trusted injected code; `mock-` labels / ids and `.invalid` addresses are restrictions and correlation, not authentication.
4. Copy, sender, recipient policy, retention, provider and every live gate remain CLOSED. The historical e74a listing-lock failure stays OPEN.

### 16.6 Root CODE HOLD on `44e8d0a8` — R-G1 gate validation correction (same branch, gate / data-copy helpers only; pending root CODE re-review)

**Change (`notification-worker.js`, gate helpers only).** Invocation, observation, settlement, the pure message module, SQL and every other file are unchanged.
- `dataProps`: ONE `Object.getOwnPropertyDescriptors` read; only own, string-keyed, enumerable DATA properties qualify; a `__proto__` key refuses; values go into an `Object.create(null)` accumulator, so no key can vanish into, or be served from, a scratch prototype. `hooks` is kept as a frozen null-prototype copy.
- `denseArrayCopy(listingIds, 50)`: ordinary `Array.prototype` array; ONE descriptor snapshot; data `length` 1–50; exactly the keys `0…length-1` plus `length`; every index an enumerable DATA descriptor. Values are copied from the descriptors into a fresh frozen array; range (positive int4) and distinctness are then checked on that copy, which is exactly what the basis keeps. No element access, iterator or caller method runs.
- `notificationWorkerGate` wraps ONLY the option introspection / validation (`gateUnsafe`) in a catch → `OPTIONS_INVALID`. The caller's error is never returned or rethrown. Nothing inside touches the pool; marker / observation / settlement / release errors are outside it and still propagate as the identical object (asserted).
- Proxy traps necessarily run when inspected; ordinary getters / iterators do not.

**Root probes (`gnf/rg1/probe.mjs`, the same probes against the exact `44e8` module and the fix):**

| Probe | `44e8d0a8` | Fix |
|---|---|---|
| 1. `listingIds=[1]` with an enumerable accessor at `'0'` | ACCEPTED; getter ran 3 times | `OPTIONS_INVALID`; 0 runs |
| 2. own `Symbol.iterator` yielding 2 | ACCEPTED; `basis.listingIds = [2]` (validated `[1]`) | `OPTIONS_INVALID`; 0 runs |
| 3. own enumerable DATA `__proto__` on opts | ACCEPTED (key disappeared) | `OPTIONS_INVALID` |
| 4. Proxy whose `getPrototypeOf` throws | threw the caller's error object | `OPTIONS_INVALID` |

**Tests (`test/e7-guest-notification.test.mjs`, +7).** Every hostile case asserts `OPTIONS_INVALID` from the gate (which never throws, code-only) AND from the step, with zero pool / connect / executor calls and zero getter / iterator runs:
- the four probes; `__proto__` on opts, env, sender, executors, hooks, plus required keys supplied only through `__proto__`;
- throwing `getPrototypeOf` / `ownKeys` / `getOwnPropertyDescriptor` traps and revoked proxies at opts, env, sender, executors, hooks and listingIds (24 cases);
- listingIds: changing getter, holes, trailing hole via `length`, non-enumerable index, non-enumerable accessor index, custom `.some` (enumerable and not), non-enumerable iterator, symbol key, extra string key, Array subclass, null-prototype array, array-like object, length 51, empty;
- valid controls: dense frozen array, null-prototype config at every level (both run a full step to `accepted`); copied basis equals the validated data; mutation after the gate changes nothing;
- boundary control: a marker error after a valid gate still propagates as the identical object with no follow-up.

**Red / green (CLAUDE-RUN).** The new unit file against the exact `44e8` worker: 20 pass / 6 fail (the 5 hostile groups, plus the valid-control test, which also asserts the new null-prototype `hooks` copy). Against the fix: 26 / 26.

| Run | Result |
|---|---|
| Focused unit + packaging | 34 / 34 |
| `npm test` | **721 / 721** (714 + 7) |
| PG worker `test/db/e7-guest-notification-worker.test.mjs` (valid-caller compatibility) | 12 / 12 |

`test:db`, Stage 1 / SQL regressions and W01–W25 were not rerun (not affected; root said no repeat campaign). TAP: `gnf/tap/rg1-*.tap`; probes `gnf/rg1/probe-out.txt`.

