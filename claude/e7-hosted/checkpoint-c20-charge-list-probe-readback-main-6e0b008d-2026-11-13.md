# Checkpoint C20 — Hosted READ-ONLY charge-LIST shape probe: run readback — PASS (`SHAPE_COMPATIBLE`, empty list) — 2026-11-13

Doc-only checkpoint from merged main `6e0b008d950e3045a7c73447405da413a75c9a8a` (no runner, workflow or script change). Every live fact in §3–§5 is **ROOT-attributed** (ROOT final C20 readback; durable review 5899425855 on #96); Claude performed no provider, DB, browser or run action and did not poll or read any run log. Supersedes `checkpoint-c20-charge-list-probe-readback-SKELETON-2026-11-13.md`.

**Policy frame (unchanged):** refunds MANUAL and policy-assessed; recording / notification / cleanup paths HELD (D4); manual disposition pending; both TEST intents immutable (`abede8b1…` captured, `c83c1842…` capture_unknown) and their provider objects untouched; all five runner `executeEnabled=false`. A compatible EMPTY list read proves the read shape only — it does NOT prove that `POST /v1/guestPayments/charges/{id}` exists or would be accepted, says nothing about NON-EMPTY row shapes, and authorises nothing.

## 1. Merged identity
| | |
|---|---|
| probe script | `scripts/e7-hosted-charge-list-probe.mjs` `e7-hosted-charge-list-probe-v2` (#95 C17/C18, GO review 5899273450 (superseding HOLD 5899125821) → main `20136805`, exact reviewed `6d5d9124` / tree `6e2af5b1`) |
| workflow + test | `.github/workflows/e7-hosted-charge-list-probe.yml`, `test/e7-hosted-charge-list-probe-workflow.test.mjs` (#96 C19, review 5899378420 → **main `6e0b008d`**, exact reviewed `5fee7a2e` / tree `278d0789`; ROOT independent 18/18) |
| probe source digest | `b98931bc4d30f0fa0a8f475c4acbbd2ed2392472cf3fc70bec0ec7cfb36a765b` (prefix `e7-hosted-charge-list-probe-v1\n`; script → test → workflow; `framedDigest` frame; independently reproduced by ROOT) |
| tooling pin / manifest | `5a094b16c1f84690a738a98ab89140caa69c1e1f`; 8 files (capture-proof `9a3c7948…`, compensation-proof `03645839…`, intent-state `ef132f4e…`, offline-charge-proof `2469ee96…`, recovery-plan `4ffd8dd4…`, hostaway-reservations `d86827cc…`, http-transports `2c41847f…`, real-exchange `bc584758…`) verified before any import |
| fixed target | listing 606998 · reservation **71700931** · ref 105433 = `MV-8L79DEJ7` · stay 2026-11-23 → 2026-11-24 · USD 140.00 (= 14000 minor) · intent `abede8b1-8ef6-44f2-876e-6a02fc056a96` `payment_captured` v8 · config `hostaway-e7-test / 2000 / USD / 606998 / credit_card / 105433` |
| allowance / budgets | ≤ 2 GETs (identity, then list `limit=500&reservationIds=71700931`), GET only, `api.hostaway.com` only, no body / retry / redirect; `{ maxBytes: 262144, callMs: 15000, totalMs: 30000, calls: 2 }` |
| gate | `workflow_dispatch` only; probe job `needs: preflight` && `mode == 'probe'` && `github.ref == 'refs/heads/main'`; `environment: e7-readonly-probe` (existing reviewers/settings, untouched); sole secret `E7_HOSTAWAY_TOKEN` in the one `--probe` step; `contents: read`; 5-min timeout |
| five closed runner digests (re-asserted at `6e0b008d`, this PR base) | reservation `5665544de105e4564a57a4434fa32fd2355b9bbd0e756b250d1248e07feb6b19` · capture `5b547a42200b452055d8a718c84ab70f7f2b5a0cd8343f6174c4a75b0c420ed1` · test-cleanup `33f2ab18984dccd3915a18ff8a55dd4a6e5b6bf89e3d84ba1e578347e6cebd1e` · recording `31c0ca93c0a5440b8cccf8cdeb475e4f6f08a73421bab76460b958d13f810075` · recorded-cleanup `3e0eba4204d7dc8c688d8ddeb2afc0d057fe31b99258848b2538934e4c685d16`; all `executeEnabled=false` |

## 2. What a run can and cannot say
Exit 0 = `SHAPE_COMPATIBLE` / `SHAPE_COMPATIBLE_WITH_UNKNOWN_VALUES`; 1 = probe STOP (allowlisted code); 2 = refused before any call; gate step exit 3 = binding / digest / manifest re-check failed. The single output line carries only sanitized fields (ids, dates, minor units, enums, counts, allowlisted codes) — never raw bodies, titles, guest data, headers, tokens or exception text. The accepted identity proof passing implies the fixed listing / stay / total / ref / channel binding matched; **no raw reservation fields were logged beyond that summary, and none are claimed here.**

## 3. No-secret hosted preflight (ROOT-attributed)
| | |
|---|---|
| run | `43526009606` — https://github.com/veloguide-joel/maravilla-smoobu-proxy/actions/runs/43526009606 |
| commit / mode | main `6e0b008d950e3045a7c73447405da413a75c9a8a` · `preflight` |
| window | 2026-11-13 23:17:35Z → 23:17:50Z |
| result | SUCCESS — bindings PASS, focused fake probe tests 11/11, `--dry`, digest printed; probe job SKIPPED (mode gate) |

## 4. ONE bounded read-only probe (ROOT-attributed)
| | |
|---|---|
| run | `43526171355` — https://github.com/veloguide-joel/maravilla-smoobu-proxy/actions/runs/43526171355 (same SHA `6e0b008d…`) |
| preflight job | `132232367365` SUCCESS — 11/11; printed `probeSourceDigest` = `b98931bc…a765b` **MATCH** |
| environment gate | ROOT approved the normal `e7-readonly-probe` gate at ~23:20Z under Joel's standing authority; **no bypass**; pending-environment record `26275358302`, reviewer `veloguide-joel` verified |
| probe job | `132232463075` COMPLETED SUCCESS |
| re-check step | 23:20:21.902Z full 8-file manifest ok at `5a094b16`; 23:20:21.904Z wrapper HEAD / tooling pin / digest bindings PASS (before the call) |
| **exact sanitized result** (23:20:22.7106108Z) | `e7-charge-list-probe-result-v2` · `stop=-` · **`outcome=SHAPE_COMPATIBLE`** · `calls=2` · `urls=["GET /v1/reservations/71700931","GET /v1/guestPayments/charges?limit=500&reservationIds=71700931"]` · `identity=200/success/ok status=new currency=USD` · `list=200/success/ok count=0 types=[] matching=0 unknown=0 offset=null limit=absent` · `transport=-` · `guard=[]` · `elapsedMs=762` |
| what was NOT done | exactly 2 GETs; no pagination, redirect, retry, write, DB, Stripe, record, notify, cancel, refund or void; no operational INSERT anywhere |

## 5. Consequences (from §3–§4 only)
- The Hostaway charge-LIST **empty-envelope** read for R71700931 matched the accepted proofs (`assessChargeList` + `preflightListObservation`): 200 / `success` / `result: []`, `count 0`, `offset null` and `limit absent` = the defined defaults, no continuation marker, no `UNKNOWN` enum value. Identity re-proven live: status `new`, USD, fixed binding matched. At this observation, the bounded selector returned no charge rows (matching 0, rowCount 0); this does not establish historical absence of charges through every path.
- **Still LIVE-UNVERIFIED:** non-empty row shapes (`type/status/paymentProvider/paymentMethod/currency` values Hostaway actually emits), the `POST /v1/guestPayments/charges/{id}` create path and its reply shape (`offline-charge-proof.js` create branch), and pagination behaviour on a non-empty list.
- **No fresh DB / Stripe / old-intent / protected-reservation / provider-wide check was performed in C20.** Earlier live observations (C3 closure and C12 provider end check) stand only with their own timestamps; they are NOT restated here as current claims. C15 dashboard-evidence tests used a disposable database and provide no live provider observation.
- Recording / notification / cleanup remain HELD; manual disposition of the captured TEST payment is pending and is a policy decision, not a technical one; manual-refund policy unchanged; both intents immutable; all five flags FALSE and digests unchanged. **This checkpoint authorises nothing and implies no follow-up action.**

## 6. Closure
- [x] §3–§4 from ROOT's final readback verbatim (run ids, job ids, timestamps, printed digest, sanitized result line)
- [x] §5 written from §3–§4 only
- [x] five runner digests + `executeEnabled=false` re-asserted at the PR base `6e0b008d` (`rdig`)
- [x] PR = this document only; DRAFT; skeleton marked superseded in the project; ROOT reviews
