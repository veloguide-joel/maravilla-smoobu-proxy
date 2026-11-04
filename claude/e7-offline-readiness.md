# E7 offline readiness — what exists, what is only mock-proven, and the shortest path to one controlled connected test

**Branch** `feature/e7-offline-readiness`, cut from exact `ede4c43c25f9c025c540ba1f26a766eef5845556`. **DOCS ONLY.** No code, SQL, test, fixture, config or dependency change; no suite was run for this report. All line citations are at `ede4c43`.
**This is not a live approval packet and authorizes no action.** Every live, provider, credential, shared-DB, merge, deploy, schedule and real-message gate stays CLOSED. Protected reservations 70636076 / 71045356 / 71072615 / 71081885 stay zero-action. Future packages are USD by convention; no live `paymentMethod` is selected.

## 0. For Joel — status in plain language

In an offline rehearsal (a throwaway local database, with every Stripe and Hostaway reply simulated in memory), the booking system can now take a priced booking from "payment authorized" through: creating the Hostaway reservation, capturing the card, recording the payment on the reservation, and marking the booking confirmed. When something fails before money is taken, it cleans up (releases the card hold, cancels the reservation). It can also prepare and "send" the guest's confirmation or not-charged email to a **simulated** mailbox exactly once, and it refuses to touch the four protected reservations. That is useful because every step's safety rules (never charge twice, never book twice, never resend an email, stop and tell the owner when an outcome is unclear) are now written down and tested together.

What it has **not** done: talk to the real Stripe or Hostaway through these new workers, run on any server, send any real email, or cancel/refund a booking after it is confirmed (that path does not exist yet). The original end-to-end rehearsal still leaves its guest emails queued and unsent; the email step was proven separately, against simulated sends only. Before a single real test booking you still need to make a few business choices (which listing and currency, how the payment is recorded in Hostaway, whether the guest email is part of the test), and root still needs a reviewed plan that connects the workers to the real services for one supervised run. Nothing here is "live" or "production-ready".

## 1. Accepted baseline and capability matrix

**Accepted code.** Root ACCEPTED Stage 2 (notification worker) at `ede4c43c` OFFLINE; Stage 1 (0016 fence) stays accepted at `35097c56`; the earlier slices (reservation E7.2, capture E7.3b, compensation E7.4a, recording E7.4b + 0010–0014, scoped inbox 0015, lifecycle rehearsal) were accepted offline in their own reviews and are all ancestors of `ede4c43`.

**Test provenance (no new run in this report):**

| Where | Who | Result |
|---|---|---|
| `ede4c43` | root | `test/e7-guest-notification.test.mjs` 26/26 on the exact modules, no stubs; the four R-G1 probes → `OPTIONS_INVALID`, getter/iterator runs 0 |
| `ede4c43` | CLAUDE-RUN | `npm test` 721/721; PG worker file 12/12; focused unit + packaging 34/34 |
| `44e8d0a8` (prior Stage 2) | CLAUDE-RUN | `test:db` 461/461; `npm test` 714/714; regressions 117/117; mutants W01–W25 25/25 |
| `35097c56` (Stage 1) | CLAUDE-RUN | `test:db` 449/449; `npm test` 695/695 |

`test:db` was **not** rerun at `ede4c43` (the R-G1 change touched only the gate). The historical e74a listing-lock failure stays OPEN (`claude/e7-db-suite-reliability.md:94`); any future authorized reproduction → keep the FIRST FULL TAP and STOP, never rerun green.

**Legend.** **Wired** = reachable from an `api/` route. **Library** = internal module only; called by tests, never by a route, runner or scheduler. **Mock-proven** = demonstrated only with synthetic injected executors on disposable local PostgreSQL. **Unverified** = no evidence against the real service.

| Area | What exists (source at `ede4c43`) | State |
|---|---|---|
| Listing feed / calendar / quote | `api/booking/listings.js` (allowlist `PUBLIC_LISTING_IDS = [603564, 603566]`, `lib/listing-public.js:17`; 10-min per-instance cache, `api/booking/listings.js:18–20`); `api/booking/calendar.js` (fresh, `Cache-Control: no-store`, `:15`, `:34`); `api/booking/quote.js` (fresh calendar + `evaluateStay` before any price, `:5–12`) | **Wired, read-only, real Hostaway reads** (pre-E7 stages F1–F3). Deployment status is not inferred here. |
| Frontend → checkout entry | No checkout UI in this repository (tracked top-level files: `README.md`, `package*.json`, `vercel.json`, `public/robots.txt`). `api/checkout/intents.js` / `intent-step.js` → `lib/checkout/intent-api-http.js`; gate `:49–59` (needs `MV_CHECKOUT_TEST_API=enabled`, an allowed origin, TEST listings `"id:MXN|USD"` `:23`, `:32`); production always 404 (`api/checkout/intents.js:3–4`) | **Wired route code, Stripe TEST mode only; platform UNVERIFIED / HOLD, no deployment** (`api/checkout/intents.js:5`). |
| Pricing | `lib/checkout/server-pricer.js:10–11` (listing currency must equal the configured TEST currency; no FX); reservation worker re-prices before create (`lib/booking-db/reservation-worker.js:18–19`) | Library + route; mock-proven in E7. |
| Stripe auth / webhook | `api/checkout/stripe-webhook.js:3–9` → `lib/checkout/stripe-webhook-http.js:69`; `stripeTestGate` refuses production (`lib/checkout/stripe-test-mode.js:47–49`); `livemode !== false` refused (`lib/checkout/stripe-test-webhook.js:108`); DB livemode mismatch refused (`lib/booking-db/webhooks.js:15`) | **Wired route code, TEST mode only; packaging UNVERIFIED, no deployment.** In the E7 rehearsals `PAYMENT_AUTHORIZED` was applied directly with `applyEvent`, not through the webhook. |
| Reservation (Hostaway create / lookup) | `runOrchestratorStep` `lib/booking-db/reservation-worker.js:585`; gate `:126–136` (dev/preview + `MV_E7_RESERVATION_WORKER`; listing currency must equal the adapter currency `:136`); pure adapter `lib/hostaway-reservations.js:1–5` ("not imported by any route … nothing here can send a request") | **Library; mock-proven.** Shapes DOC-DERIVED / LIVE-UNVERIFIED (`hostaway-reservations.js:21–22`, `:45`). |
| Capture | `runCaptureStep` `lib/booking-db/capture-worker.js:600`; gate `:73–78`; proof refuses non-TEST charges (`lib/checkout/capture-proof.js:97`) | **Library; mock-proven; Stripe TEST shapes only.** |
| Compensation (void + host cancel) | `runCleanupStep` `lib/booking-db/compensation-worker.js:643`; works only `reservation_failed` / `capture_failed` (`:50`); proof TEST-only (`lib/checkout/compensation-proof.js:184`) | **Library; mock-proven.** `capture_failed` was reached only by a test-applied `CAPTURE_FAILED` event (the capture worker never emits it; lifecycle rehearsal §3). |
| Cancellation / refund of a CONFIRMED booking | None. E3 never refunds or cancels captured money automatically (`lib/checkout/intent-state.js:547`); the only cancel effect is the compensation host-cancel (`:252`) | **Not implemented.** |
| Recording (Hostaway offline charge) | `runRecordingStep` `lib/booking-db/recording-worker.js:598`; gate `:66–83`; `paymentMethod` explicit, no default (`lib/checkout/offline-charge-proof.js:32`, `:126–128`); `APPROVED_CURRENCIES = ["USD"]` (`:33`, `:129`) | **Library; mock-proven** with FIXTURE methods `credit_card` / `other`. |
| Synchronous contradiction checks / conflict inbox | 0010–0014 recording guards; scoped inbox `processScopedRecordingInbox` `lib/booking-db/recording-inbox.js:82` (gate `:37`); protected list `db/migrations/0015_scoped_recording_inbox.up.sql:20–23` | **Library + SQL; mock-proven.** No scheduled caller. |
| Recovery / maintenance | `lib/booking-db/recovery.js:78–322`; generic `recoverExpiredOperations` `lib/booking-db/operations.js:441` | Library; mock-proven. |
| Guest notification | E3 queues `guest.notify` (`lib/booking-db/repo.js:107–108`); 0016 fence (`db/migrations/0016_guest_notification_fence.up.sql`); pure builder `lib/checkout/guest-notification.js`; step `runNotificationStep` `lib/booking-db/notification-worker.js:183` (gate `:83–96`, injected executor only, `.invalid` recipients + USD only) | **Library. Queued** in the original lifecycle rehearsal (rows never executed). **Mock-accepted** only in the Stage 2 PG chains (`test/db/e7-guest-notification-worker.test.mjs`). No transport, sender identity or delivery exists. |
| Owner reconciliation | SQL `admin_*` functions (`0003:508–659`, `0005:296`, `0010:392`, `0011:530`, `0011:753`, `0013:493`); JS wrappers `db/lib/admin.js:26–69` under `/db`, excluded from upload (`.vercelignore`) | **SQL + owner-only JS; no route, UI or owner view.** |
| Runner / scheduler / deployment | No cron (`vercel.json` = `{"outputDirectory":"public"}`); no `api/` route reaches any worker (`test/packaging-closure.test.mjs:132–139` `OFFLINE_ONLY`); no code constructs a real executor for any E7 worker | **Not implemented.** |
| Prior connected evidence (E4, separate scripts) | Owner-run E4 scripts (`scripts/e4-*`, excluded from upload) created and cancelled reservation 71081885 on listing 603566 (MXN) on 2026-11-02 — **owner-reported** (evidence ledger, 2026-11-02 "E4 CONNECTED AUTOMATED ACCEPTANCE"); that tooling is separate from `lib/` and imports none of the E7 workers | Real-Hostaway create/cancel/calendar evidence **for the E4 runner only**. It does **not** exercise the E7 workers, Stripe, recording or notification. 603566 is MXN (`lib/hostaway-reservations.js:52–53`). |

## 2. Remaining gates (smallest order)

Kinds: **B** business decision (Joel) · **E** offline engineering (Claude, reviewed by root) · **R** live read-only verification (owner-run, separately approved) · **M** separately authorized live mutation (owner approval each time).

| # | Gate | Kind | Depends on | Missing input / who | Exit criterion |
|---|---|---|---|---|---|
| G1 | Test listing and currency | B | — | Joel: which listing, and whether it is USD. Today recording and notification accept USD only (`offline-charge-proof.js:33`; 0016 `OUT_OF_V1_SCOPE`), while the only connected-test listing is MXN (`hostaway-reservations.js:52–53`) | A named listing + currency, or a decision to extend scope (then an E contract first) |
| G2 | How the payment is recorded in Hostaway | B | G1 | Joel: `paymentMethod` (`credit_card` / `other`, no default) and the account label | Written owner choice |
| G3 | Scope of the test: notification in or out; what "cancellation" means | B | — | Joel. A confirmed booking has no automated cancel/refund (`intent-state.js:547`) | Written scope; if post-confirmation cleanup is in scope, it is a manual owner step or a new E slice |
| G4 | Orchestration / live-gate manifest | E | G1–G3 | Claude drafts, root reviews | Reviewed doc naming the worker sequence, every executor key → its real call, env flags, DB target, stop conditions, protected-ref checks, and what is excluded |
| G5 | Real executor adapters + runner for that manifest | E | G4 | Claude, root review | Offline tests: adapters build exactly the documented requests, refuse anything else, no default transport; runner bounded, one booking |
| G6 | Real shapes and credentials | R | G5 | Joel supplies keys locally (never to Claude); owner-run read-only probes: Stripe account / PaymentIntent fields used by the proofs, Hostaway reservation read, offline-charge list (`/v1/guestPayments/charges`) | Sanitized read-only evidence that every LIVE-UNVERIFIED field the proofs rely on matches, or a reviewed correction |
| G7 | DB / runtime / route deployment | E then M | G5, G6 | Root decision on where workers run; the route packaging HOLD stays until validated | Validated packaging; a test-marked DB (`assertEnvironment`, `lib/booking-db/pool.js:73–77`); no production env |
| G8 | Freshness before the run | R | G1 | Owner-run read-only calendar + quote of the chosen dates, close to the run | Available, no existing reservation on those arrival dates, quote matches |
| G9 | Airbnb blocking / reopening | R (+ owner attestation) | G8 | Joel observes the channel, as in E4 | Block after create, reopen after cancel, attested |
| G10 | The controlled connected booking (+ agreed cleanup) | M | G1–G9 | Joel: an explicit approval naming listing, dates, amount, method and guest identity | Run journal reviewed; every side effect (reservation, charge record, card state, notification) matches the manifest |
| G11 | Live use | B + M | G10, plus §3 blockers | Owner sender / recipient / copy / retention policy; owner resolution paths | Separate decision |

**Smallest order:** G1 → G2 → G3 (Joel) → G4 → G5 (offline) → G6 → G8 (read-only) → G7 → G10 (with G9 observed) → G11. No dates or estimates are implied.

## 3. Unresolved issues and what they block

| Issue | Source | Blocks G10? | Blocks live use (G11)? |
|---|---|---|---|
| N2: notification unknowns open an `op:` case that no owner path can close (`admin_resolve_operation` NOT_SUPPORTED, `0005:364`; `admin_close_case` refuses `op:` cases, `0011:540`), and any open case blocks guest purge (`0005:145`) | contract §14.2 | Only if the notification is in scope (G3) | **Yes** — a single unknown keeps that guest's personal data indefinitely |
| N3: `recipient_hash` survives purge; sender / recipient / copy policy; no transport | contract §14.3; `notification-worker.js` injected executor only | Only if notification is in scope (then no real send exists anyway) | **Yes** (owner policy) |
| `alert.owner` generic resend: idempotent rows return to `pending` on lease expiry (`repo.js:109–110`, `operations.js:430–432`) | contract §14.1 | No — nothing sends `alert.owner` today | Yes, before any owner-alert transport |
| U2: the generic `recoverExpiredOperations` has no protected check for notify rows (`operations.js:391–399`, `markUnknown` notify branch) | contract §14.7 | No if the runner uses only the scoped functions (G4 must say so) | Accepted offline limitation; a runner rule |
| Raw non-E3 INSERT / non-serialised writes (cases, refunds, webhooks, holds) | contract §14.8 | No (no such writer in the run) | Accepted limitation |
| Bounded snapshot / post-snapshot race; TRUST proofs (`.invalid`, `mock-`, account labels) | contract §14.10–12, §16.3 | No, documented | Accepted limitation; not "exactly once" |
| Retention is provisional (`lib/booking-db/config.js:20–24`, "pending legal/privacy review") | — | No | Yes (owner/legal) |
| Historical e74a listing-lock failure | `claude/e7-db-suite-reliability.md:94` | No (test-reliability issue) | Keep OPEN; first-full-TAP/STOP rule |

None of these is made production-safe by green suites.

## 4. Recommended next offline task (not started)

**G4: a docs-only "connected-test orchestration and live-gate manifest" contract.**

Why this before an N2 acknowledgement/retention contract: the next gate is one controlled booking, and the code shows its real blockers are wiring, not notification policy. No caller constructs a real executor for any E7 worker, nothing runs the workers outside tests (`packaging-closure.test.mjs:132–139`), and the currency / method / cancellation scope (G1–G3) decides which workers even run. The notification can be kept out of that test (its rows simply stay queued, as the original rehearsal already shows), which makes N2 irrelevant to G10. N2 is still **required before live notification use** and should follow as its own contract.

**Proposed file scope:** new `claude/e7-connected-test-manifest.md` + status pointers only.

**Acceptance criteria:**
- One booking, one listing; the worker sequence and phase stops, citing the accepted step functions.
- Every executor key of every worker in scope, mapped to the exact documented request, with its LIVE-UNVERIFIED fields listed and the read-only probe (G6) that would verify each.
- Env flags, DB target and environment marker, scoped maintenance only (U2), protected-ref zero action, budgets, stop/escalation rules, journal content.
- Explicit placeholders for owner inputs (listing, currency, method, dates, amount, guest identity, notification in/out, cleanup method). Claude fills none of them.
- What stays excluded (notification transport, refunds, any production env).

**Owner decisions vs root technical choices:**
- Owner (Joel): G1 listing / currency, G2 `paymentMethod` + account label, G3 notification in/out and cleanup meaning, later the live approval, sender / recipient / copy / retention.
- Root: worker sequencing, where the runner lives, adapter boundaries, DB target, packaging validation, evidence format.
