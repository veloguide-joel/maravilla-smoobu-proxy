# Checkpoint C44 — first Resend synthetic sink send: PROVIDER_ACCEPTED (main 65a58cbb, run 43602744497)

**Status: CLOSED — ONE synthetic transport send, accepted by the provider.** Exactly one attempt; no replay, no UNKNOWN, no second send, no second locale.

**What it proves:** synthetic transport acceptance only. Resend's API accepted ONE fixed synthetic message to its documented delivery-**simulation** sink. It is **not** proof that a real inbox received mail, **not** a guest or booking notification, and **not** a production-readiness claim.

**Attribution:** every run, job and timestamp fact below is a ROOT observation (`[ROOT-obs 2026-11-14]`, C44 handoff). Claude made no network, provider, dashboard, credential, dispatch or DB action for this checkpoint.

---

## 1. Source and review provenance
| item | value | source |
|---|---|---|
| Harness PR | #111, exact reviewed head `49d9a75f2b50b746bf14cffc3951814ddec1b93a` | — |
| Source GO + merge | main **`65a58cbb3b8df57265ee2657bba4f2f806dc3eec`** (tree `4e99961e082d360021514e33d8816526aedd4673`) | ROOT review `5901617133` |
| Hosted no-secret preflight + secret/environment-name evidence (before setup) | run `43556998013`, attempt 1, preflight-only, send job skipped; `E7_RESEND_TEST_KEY` then absent | ROOT follow-up review `5901641645` |
| Test maintenance (C43) | #112 merged to e7-test `31e4e407e2a324413fa6a099f33c5c039fd94484` | ROOT final GO `5901674259` |
| Copy tooling pin | `f05016a7af3f866e7e4d46d219a3b95934ca867c` (accepted bcc-v1; 2-file closure + `node:crypto`) | — |
| Source digest (frame `e7-resend-sink-probe-v1`) | `10c988a3faf7f91c57832f40f1db1aa18bd39ba487e91cc7624318c3dac65464` | — |
| Plan hash (`en`) | `7cb4f50f6e51346685eef120460e2728566304107105d9067d2c8e34a12397b2` | — |

Run `43556998013` was preflight-only and was **not** rerun.

## 2. Secure setup (ROOT-obs; sanitized)
- Joel completed the provider setup himself. It is a Resend account/team **distinct from the Pilates Bucerías project**; that separate-project boundary is deliberate. Before setup the plan was Free (transactional), with no sent emails and no API keys.
- One dedicated key with sending access was created by Joel and saved by Joel as a GitHub **environment** secret.
- ROOT verified only that the Environment secrets table lists the name `E7_RESEND_TEST_KEY`; **no key value was read** by ROOT or Claude.
- The existing `e7-readonly-probe` environment is unchanged: required reviewer, main-only, no admin bypass.
- No account email, key, key value or contact is recorded here.

## 3. The ONE send dispatch (ROOT-obs)
- **Run `43602744497`**, attempt **1**: `mode=send`, `locale=en`, main `65a58cbb…`, `approval_ref=ROOT-C44-RESEND-SINK-20261114`, created **2026-11-14T14:02:13Z**.
- ROOT checked the queue before dispatch: no duplicate.
- Run: https://github.com/veloguide-joel/maravilla-smoobu-proxy/actions/runs/43602744497

| job | step / fact | timestamp (UTC) |
|---|---|---|
| preflight `132470811990` — **SUCCESS** | bindings: wrapper `65a58cbb` + tooling `f05016a7af3f866e7e4d46d219a3b95934ca867c`, mode=send, locale=en | 2026-11-14T14:02:29.6597822Z |
| | probe fake tests **14/14 PASS** | — |
| | PLAN `en`: body 343 B, bodyHash `6645ae194d8eff4c992c214baa5eccfcfe53c1a9771d6f73afafbe34408cae32`, planHash `7cb4f50f…97b2` | 2026-11-14T14:02:30.6520561Z |
| | source digest `10c988a3…5464` **MATCH** | 2026-11-14T14:02:30.7025282Z |
| environment gate `e7-readonly-probe` | approved normally by ROOT under Joel's standing authority; no bypass, no settings change | ~2026-11-14T14:03Z |
| send `132470885456` — **SUCCESS** | re-check: probe `--preflight` **PLAN MATCH** | 2026-11-14T14:03:38.2408650Z |
| | re-check: exact bindings / source digest **MATCH** | 2026-11-14T14:03:38.2420030Z |
| | **result line** (below) | 2026-11-14T14:03:38.3579224Z |

**Result (verbatim sanitized output line):**
```
e7-resend-sink-probe-result-v1 outcome=PROVIDER_ACCEPTED stop=- attempts=1 httpStatus=200 emailId=01a1da5e-f3d6-719e-8cb2-b04b669c35f4 locale=en planHash=7cb4f50f6e51346685eef120460e2728566304107105d9067d2c8e34a12397b2 bodyHash=6645ae194d8eff4c992c214baa5eccfcfe53c1a9771d6f73afafbe34408cae32 elapsedMs=81 note=provider-accepted-for-the-resend-delivery-simulation-sink;not-real-inbox-proof;not-a-booking-notification
```

## 4. Reconciliation
| check | result |
|---|---|
| Source digest at preflight and at send re-check | equal to the reviewed `10c988a3…5464` (both MATCH) |
| Plan hash at preflight, send re-check and result line | equal to the reviewed `en` hash `7cb4f50f…97b2` |
| Body hash (preflight PLAN and result line) | `6645ae19…ae32` |
| HTTP status | `200`: the documented success status (Resend API introduction) |
| Outcome | **`PROVIDER_ACCEPTED`**: not `PROVIDER_ACCEPTED_REPLAY` (no `idempotent-replayed: true`), not `UNKNOWN_STOP` |
| Provider email id | `01a1da5e-f3d6-719e-8cb2-b04b669c35f4` (the only allowlisted reply field: an exact `{"id": UUID}` JSON object) |
| Attempts | **exactly 1**; run attempt 1; no rerun, no second dispatch, no `es` send |

The probe's own construction meant:
- sender fixed to `maraVilla TEST <onboarding@resend.dev>`;
- recipient the exact singleton `delivered@resend.dev`, Resend's documented delivery-simulation sink;
- body = accepted bcc-v1 English copy with fixed synthetic facts (`MV-SINKPROBE`, 2030 dates, USD 123.45); no real booking, intent or reservation;
- one fixed `POST https://api.resend.com/emails`, no retry, no redirect follow;
- the key present only in the last send step.

## 5. Limitations (stated, not inferred)
- **Simulation, not delivery.** Acceptance for the `delivered@resend.dev` simulation sink is not real-inbox receipt. Resend's own docs describe it as simulated delivery.
- **Not a booking or guest notification.** The gn-v2 builder, notification worker, 0022 and the SQL fences were **not** used and remain unwired to Resend.
- **Idempotency key scope.** The key covered this one request for the provider's 24 h window. It is not a cross-dispatch or forever dedupe; reruns are refused by the workflow instead.
- **No inspection beyond the probe.** No fresh DB-wide or provider-wide inspection is claimed. Booking objects are unaffected by construction: the probe has no DB, Stripe or Hostaway access.
- **No production-readiness claim** of any kind.

## 6. State unchanged
- Five booking runner flags remain **FALSE**; runner digests unchanged.
- Migration 0022 remains disposable / local only; shared DEV stays 1..21.
- No action on: the queued real-address `guest.notify`, notification inbox, money, refund, cancel, void, claim or cleanup; Stripe; Hostaway / provider bookings; shared DB.
- Protected TEST objects are untouched. Refunds remain **manual** and policy-assessed.

## 7. Current concrete next milestone
**Integrate the reviewed gn-v2 request with a real sender, a reviewed real-recipient policy and this transport**, under a **separate, bounded implementation** with its own review, fences and gates. Real-recipient delivery stays separately gated. This checkpoint authorizes no new live action.

Prerequisites already in place:
- gn-v2 builder;
- worker `confirmationLocale` opt-in;
- 0022 offline;
- this transport's accepted POST shape.

Still to do:
- a verified sending domain / sender;
- the reviewed real-recipient scope;
- wiring the worker's single send to a provider executor;
- the hosted runner / gate for it;
- the 0022 apply path.
