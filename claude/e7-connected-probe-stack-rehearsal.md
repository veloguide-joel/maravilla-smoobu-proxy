# E7 connected-test runner — P / T / X PROBE-STACK REHEARSAL (TESTS + REPORT ONLY; OFFLINE)

> **Status (pointer):** ACCEPTED OFFLINE by root at `b6603cac` (combined 113/113 root-run; no native / provider / real-readiness claim). The `VOCABULARY` omission noted in §3 is a whitelist / export nuance, not a leak; the canonical consumer whitelist is the union in `claude/e7-connected-readonly-probe-contract.md` §12. Next (docs only): `claude/e7-connected-probe-cli-contract.md` — PROPOSED owner-run CLI / preflight / credential-ingress design; not implemented, not authorized.

**Branch** `feature/e7-connected-probe-stack-rehearsal`, cut from exact `27c0ea11` (Slice P ACCEPTED offline). Files: NEW `test/e7-connected-probe-stack-rehearsal.test.mjs` (R1–R4); this report; an accepted-status / report pointer in `claude/e7-connected-readonly-probe-contract.md` (§11 / §11.1 history kept). **No runtime change** (`git diff 27c0ea11 -- scripts lib db package.json` is empty). No runner, CLI, credential, env, preflight, install, PG, provider, native network, loopback, TLS, DNS, socket, merge, deploy or real message.

**Accepted source heads under test (unchanged):** P `scripts/e7-connected/readonly-probe.mjs` (last changed `27c0ea11`), T `scripts/e7-connected/http-transports.mjs` (`0830f9a4`), X `scripts/e7-connected/real-exchange.mjs` (`af1b4db0`).

## 1. Composition
`P.runReadonlyProbes` → T `createE7HostawaySend` / `createE7StripeTestSend` (`send` objects passed to P directly) → X `createE7RealExchange` (`exchange` passed to T directly) → **FAKE https primitive** (`request` / `Agent` doubles). No wrapper or runtime hook anywhere in the chain.

| Label | Meaning |
|---|---|
| REAL (accepted, unchanged) | P, T, X |
| FAKE (test-only) | `FakeReq` / `FakeRes` / `FakeAgent` — a labelled COPY of the accepted X test doubles, modelled on the DOCUMENTED Node `http.request` event orders (not native ordering); P's `monotonic` + `timers.arm` (fake clock, no sleeps); every reply |
| GUARDS | node:https `request` / `Agent` replaced by counting throwers BEFORE X loads (X's accepted technique, `syncBuiltinESMExports`): **0 / 0**; global `fetch` **0**; unhandled rejections **0**; uncaught errors **0** |
| SYNTHETIC | Hostaway token, `sk_test_` fixture key, account / listing / reservation / PaymentIntent ids, reply sentinels; `Stripe-Version` = the proposed candidate `2026-08-26.dahlia` (a label, no account / webhook setting touched) |

## 2. Scenarios and results (CLAUDE-RUN)
| Case | What crosses which boundary | Observable result |
|---|---|---|
| R1 default approved-inventory-shaped plan (P-H3 excluded): P-H1, P-H2, P-H4, P-H5, P-H6, P-S1, P-S2 | all seven requests built by P from the frozen plan, mapped by T, dispatched by X to the fake primitive | `COMPLETED`; exact GET wire: `/v1/listings/{L}`, `…/calendar?endDate&startDate`, `/v1/reservations/{R1}`, `/v1/guestPayments/charges?limit=500&reservationIds={R1}` and `{R2}` (H8 internal singular → wire plural), `/v1/account`, `/v1/payment_intents/{PI}?expand%5B%5D=latest_charge`. Hostaway headers exactly `Accept, Authorization, Cache-control`; Stripe exactly `Authorization, Stripe-Version` (`2026-08-26.dahlia`); no body / `Content-Length` on GET; `end()` once with no body; port 443, `servername` = host, `rejectUnauthorized:true`, `insecureHTTPParser:false`, `maxHeaderSize 16384`; own Agent `{ keepAlive:false, maxSockets:1, maxCachedSessions:0 }`. **7 requests / 7 Agents**, no retry / follow-up. Gates: `G_AUTH_charges_read`, `G_FILTER` (sample / control non-empty, complete, disjoint), all four read `G_SHAPE_*`, `B4_pi_read` (positive `capture_before` present) and `TEST_mode_pi` OBSERVED; `G_SHAPE_lookup` NOT_PROBED. P-S1 evidence `{ accountIdMatches:true }` from the true Account shape without `livemode`; Stripe `httpStatus: null`. `timerCleanup` 0 / 0. |
| R2a Hostaway 401 on the sample charge list | X resolves 401 → T passes it through → P `PROBE_AUTH_REFUSED` | P-H5 `PROBE_AUTH_REFUSED` (`httpStatus 401`), P-H6 / P-S1 / P-S2 `AFTER_STOP`; `G_AUTH_charges_read` / `G_FILTER` OPEN; **4 requests**; every request carried only `Authorization: Bearer <synthetic>` — no `jwt` switch, re-mint or retry |
| R2b 302 on P-H1 | X resolves an empty 3xx without a body listener / `Location` read → T `REDIRECT_REFUSED` → P | `PROBE_TRANSPORT_FAILED`, `transportCode: REDIRECT_REFUSED`, `httpStatus null`; `G_SHAPE_listing` OPEN; 1 request, never followed |
| R2c `Content-Length` 2 MiB on P-H1 | X `EXCHANGE_BODY_TOO_LARGE` (before body work) → T `EXCHANGE_FAILED` → P | `PROBE_TRANSPORT_FAILED`, `transportCode: EXCHANGE_FAILED`; 1 request |
| R2d protected id 70636076 INSIDE a fake charge-list reply (never dispatched) | X / T pass the bytes; P refuses | P-H5 `PROBE_PROTECTED_SEEN`, evidence `null`, `G_FILTER` OPEN; 3 requests, none targeting the protected id; the id appears nowhere in the summary |
| R3a no response past P's 15 s fake deadline | P aborts ITS controller → the same genuine signal is T's / X's → X destroys the fake request | P-H1 `PROBE_TIMEOUT` (P's own deadline is the recorded cause), P-H2 `AFTER_STOP`; 1 request; request destroyed **once**, Agent destroyed once, no module listener left; X's `EXCHANGE_ABORTED` → T's `ABORTED_IN_FLIGHT` arrives AFTER P stopped and is seen only as `finalize()` tail `LATE_REJECTED` |
| R3b headers received, body held mid-stream past the deadline | same path, response already adopted | request and response each destroyed once, Agent once, zero listeners; tail `LATE_REJECTED` |
| R3c root PC1 through the full stack | injected `monotonic` aborts the caller on its 3rd call (final handoff) | `PROBE_CANCELLED`, **0 fake requests / 0 Agents** |
| R4a `card: {}` (capture_before absent) | full stack | P-S2 INCONCLUSIVE `PROBE_PROOF_FIELDS_INCOMPLETE`, `proofFieldsTyped:false`; `B4_pi_read` OPEN, `TEST_mode_pi` OBSERVED (distinct claims); 2 requests |
| R4b empty / count 500 / `hasMore:true` sample list | full stack | P-H5 `PROBE_EMPTY_SAMPLE` / `PROBE_LIMIT_REACHED` / `PROBE_LIMIT_REACHED`; P-H6 `PREREQ_INCONCLUSIVE` (never sent); `G_FILTER` OPEN; 3 requests each; no `offset` / `afterId` / page request |
| R4c overlapping control ids | full stack | P-H5 OK, P-H6 `PROBE_CONTROL_OVERLAP` (sent once), `G_FILTER` OPEN; 4 requests |

**Totals:** 33 fake requests and 33 fake Agents across R1–R4; every dispatched request had exactly one Agent, destroyed exactly once; every request / response destroyed at most once; zero module listeners left on any request / response after its modelled close; the one foreign listener (R1) preserved. Every summary is deep-frozen, contains only whitelisted strings (P `VOCABULARY` ∪ P `T_ERROR_CODES` ∪ `planHash` ∪ the four metadata labels) and none of the planted sentinels, credentials, hosts or plan ids. The fake primitive's own request log records the Authorization header only as `<redacted>`.

## 3. Validation (CLAUDE-RUN; root-runnable — no PG / install / network)
- **FIRST FULL TAP** `scratchpad/gnf/tap/PS-first-full.tap`: **3/4**. R2 failed in the TEST's redaction whitelist: it used P's `VOCABULARY` alone, which does not contain T's `ERROR_CODES`, while `transportCode` legitimately carries them (here `REDIRECT_REFUSED`). Fix (test only, labelled): whitelist `P.VOCABULARY ∪ P.T_ERROR_CODES`, the convention the accepted P test already uses. Run 2: 4/4.
- **Observation for root (not patched):** P's exported `VOCABULARY` omits T codes, so a consumer relying on `VOCABULARY` alone to whitelist a summary would reject valid `transportCode` values. A documentation / export nuance of accepted P, not a leak (the values are fixed T codes). No runtime change was made, per the rule against expanding files for a discovered gap.
- Units + pins (`test/e7-connected-*.test.mjs`, `hostaway-reservations`, `e4-connected-path`): 186/186. `npm test` first run: 851/851. e74a not reproduced. Secret-scanner pattern: no match.

## 4. Limits (stated honestly)
- The fake primitive does NOT establish native Node 22 / 24 event ordering, real TLS / DNS / sockets, real account ownership, auth, filter semantics, provider reply shapes or any live readiness.
- R3 shows the abort path P → T → X → fake request and the late-tail mapping; **no differential proof of R-TC1** is claimed (no pre-fix transport was run against this suite).
- Plan labels (`approvalRef`, metadata, `planHash`) are not credentials and imply no approval. No real request, booking or money movement happened or is authorized.
- Accepted residuals stand: X's one-listener residual; P's `uncancellable` / throwing-`cancel` timers; `UNSETTLED` / `UNOBSERVABLE` tails; synchronous blocking injected code unbounded.

All live gates, owner environment, credentials and the ONE consolidated exact approval package remain CLOSED; owner inputs UNSET; protected reservations 70636076 / 71045356 / 71072615 / 71081885 zero-action; e74a historical failure OPEN.
