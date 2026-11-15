# Checkpoint C65 — MiCasaDirect sender, synthetic Resend sink send: PROVIDER_ACCEPTED (main a979dbae, run 43737420183)

**Status: CLOSED — ONE synthetic transport send from the approved MiCasaDirect sender, accepted by the provider.** Exactly one attempt; no replay, no UNKNOWN, no rerun, no second send, no ES send.

**What it proves:** **provider acceptance only.** Resend's API accepted ONE fixed synthetic message, sent from `MiCasaDirect <bookings@mail.micasadirect.com>`, to its documented delivery-**simulation** sink.

**What it does NOT prove:**
- that a real inbox received mail;
- DKIM or DMARC results at a receiver;
- the gn-v2 worker or the DB lifecycle;
- real-guest readiness.

**Attribution:** run, job, timestamp and result facts are ROOT observations (`[ROOT-obs 2026-11-15]`). Claude authored the source (#123) and this checkpoint. Claude ran no dispatch and took no provider, DB, DNS, credential or send action.

---

## 1. Source and review provenance
| item | value | source |
|---|---|---|
| Source PR | #123, exact reviewed head `9635c621b7037071802b67d8e7244b07a58995a0` | — |
| Merge | main **`a979dbaed99f32529635f44eec0a8a4e1dcbff30`**, tree `2557e93ee2b6b929ec19b036ebae4ae27109bf2e` | ROOT GO review `5911772945` |
| ROOT independent tests | Node 22, narrow suites 56/56, zero skips (sink 22, inspect 17, booking-confirmation 17); every source / plan / body digest re-derived and matched | ROOT `5911772945` |
| Sink tooling pin | e7-test `46b3eaf801fd3c85e268e3bbdc7d20b7078cdd89` (was `f05016a7`; both copy files byte-identical across the pins) | — |
| Sink closure | copy `b393f9b6…`, guest-notification `0bea6251…`, **sender-identity `1430b2a6…` (new)**; builtins `node:crypto` only | — |
| Fixed sender | `MiCasaDirect <bookings@mail.micasadirect.com>`, asserted equal to the pinned frozen `APPROVED_REAL_SENDER` before any plan | — |
| Fixed recipient | singleton `delivered@resend.dev` (Resend delivery-simulation sink), unchanged | — |
| Sink source digest | **`aef26da954d986dc2d922b607d391be404dd73f1145ece0ae66ea0d80673ade4`** (C42 / C44: `10c988a3…`) | — |
| EN plan / body | plan **`9f57efeac07955990999dbfecaf703ca10a03fc2674aae51b856a0cce0f9a796`**, body `47b16d4ca8ba303f79c846d8e566f86ea4855ce9e07198369d0624632f0437aa`, 350 B | — |
| ES plan / body (not sent) | plan `62d5750ed7ea386a74452e1cb16dfe8221f3f3d24ca3553f976d44de7b0e1c8d`, body `d18c85cd…1929`, 402 B | — |
| Exchange | `scripts/e7-resend/resend-exchange.mjs` byte-unchanged | — |

The old C42 / C44 sender (`onboarding@resend.dev`), plans and tooling shape are refused before any network call (source test R3b).

**Cross-pin maintenance in #123** (ROOT decision A). These runners stay CLOSED, and their closure digests are unchanged:

| runner | source digest | synthetic plan | closure |
|---|---|---|---|
| notify-inspect | `e822a4d6…` → **`889d6a31af4249cede0bf8b64360b5ca0e7ca2d994c4c882f0348e5f57c2c8e7`** | → **`af56dee10e72f2adb27adb93060f415cb3037794b3cbe95e6ddb03d09a919067`** | `a703b013…` unchanged |
| booking-confirmation | `22effa8d…` → **`aff728cf8b3867a2580c8159f73081bccf2fd1659b4e07075822e14a7c4c16a0`** | `e5a90130…` → **`6f5bdd7872b5107c35b2c64fbeb2529b610f96dc2063af89c7cb5284ae8258b4`** | `4203b451…` unchanged |

Unchanged:
- the five booking runners: `5665544d` / `5b547a42` / `33f2ab18` / `49b5516c` / `9e2021e3`;
- charge-list `43715872`;
- every `executeEnabled` = false.

## 2. Hosted no-secret preflights on main a979dbae (ROOT follow-up review `5911790667`)
All three runs were attempt 1, SUCCESS. Their send / execute / inspect jobs were **skipped**.

| path | run / job | tests | plan | source MATCH |
|---|---|---|---|---|
| sink probe | `43737225063` / `132882390890` | 15/15 | 16:45:23.6669663Z | 16:45:23.6934435Z |
| notify-inspect | `43737269432` / `132882523485` | 17/17 | synthetic 16:45:50.6423253Z | 16:45:50.6632084Z |
| booking-confirmation | `43737298466` / `132882614021` | 17/17 | synthetic 16:46:06.3517324Z | 16:46:06.3784511Z |

## 3. The ONE EN send (ROOT-obs; final review `5911792379`)
- **Run `43737420183`**, attempt **1**, created **2026-11-15T16:47:12Z**, main `a979dbae`, `approval_ref=ROOT-C65-MICASADIRECT-SYNTHETIC-SINK-20261115`.

| job / step | fact | timestamp (UTC) |
|---|---|---|
| preflight `132882989549` — SUCCESS | tests 15/15; bindings | 2026-11-15T16:47:27.2405251Z |
| | PLAN `en` (exact reviewed values) | 16:47:28.2836053Z |
| | source digest MATCH | 16:47:28.3043483Z |
| environment gate `e7-readonly-probe` | approved normally by ROOT under Joel's standing authority; no bypass, no settings change | ~16:48Z |
| send `132883067012` — SUCCESS | re-check PLAN MATCH | 16:48:33.0974371Z |
| | re-check bindings / source MATCH | 16:48:33.0989800Z |
| | **result line** (below) | 16:48:33.2101487Z |

**Result (verbatim sanitized output line):**
```
e7-resend-sink-probe-result-v1 outcome=PROVIDER_ACCEPTED stop=- attempts=1 httpStatus=200 emailId=01a1e01c-4b9a-7b42-9e7a-5cdb5593c953 locale=en planHash=9f57efeac07955990999dbfecaf703ca10a03fc2674aae51b856a0cce0f9a796 bodyHash=47b16d4ca8ba303f79c846d8e566f86ea4855ce9e07198369d0624632f0437aa elapsedMs=73 note=provider-accepted-for-the-resend-delivery-simulation-sink;not-real-inbox-proof;not-a-booking-notification
```

**Reconciliation:**
- Plan and body hash equal the reviewed EN values; body 350 B.
- HTTP 200 with an allowlisted `{"id": UUID}` reply.
- Outcome `PROVIDER_ACCEPTED`, not a replay. Exactly 1 attempt.
- No replay, UNKNOWN, rerun, second send or ES send.

## 4. Limitations (stated, not inferred)
- **Provider acceptance only.** `delivered@resend.dev` is a simulation sink. There is no real-inbox receipt, and no DKIM / DMARC evaluation at a receiver is claimed.
- **Not a booking notification.** The gn-v2 worker, the DB lifecycle and the SQL fences were not used. No DB-wide, provider-wide or dashboard inspection is claimed.
- **Domain status is from C60.** `mail.micasadirect.com` was reported VERIFIED by ROOT on 2026-11-15; no new DNS action was taken here.
- **No real-guest readiness** and **no new authority** for any live action follow from this checkpoint.

## 5. State unchanged
- The five booking runner flags and the notification runner `executeEnabled` stay **false**; the runtimes stay CLOSED.
- Shared DEV is at schema 23, already verified in the C63 checkpoint. No apply here.
- The recipient fences stay `.invalid` only for the booking path.
- Preserved and untouched by construction:
  - the queued notify row;
  - the inbox;
  - claims;
  - historical intents and objects.
- **Refunds remain manual** and policy-assessed; no automated refunds are enabled or authorized.
- The C42 / C44 checkpoint stays historically accurate: that send used the onboarding sender.

## 6. Next
ROOT reviews this checkpoint and defines the next substantive real-recipient integration boundary, under its own review, fences and gates. This test is not to be re-run.
