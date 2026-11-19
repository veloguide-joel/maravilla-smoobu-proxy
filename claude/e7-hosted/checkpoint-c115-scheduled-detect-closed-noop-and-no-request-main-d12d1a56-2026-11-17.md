# Checkpoint C115: scheduled detect entry point, CLOSED no-op + ONE supervised scheduled NO_REQUEST, CLOSED on main d12d1a56 (DRAFT)

**Status: CLOSED. DRAFT for ROOT review (doc-only).**

**What it shows.** The C115 schedule trigger on the existing kickoff workflow works on GitHub in both states:
- **CLOSED main (Proof A):** a real `event=schedule` run is a pure no-op. Verify returns `CLOSED_NOOP`; detect and execute are skipped; there are 0 approvals, no secret job, no SQL.
- **ENABLE window (Proof B):** ONE real scheduled run used the reviewed source pin. ROOT approved **gate #1 only (read-only)**. Detect returned `NO_REQUEST` with 0 candidates, and execute (gate #2) was skipped.
- CLOSE then restored the exact pre-ENABLE tree.

**This is NOT unattended booking.** Every scheduled run still needs ROOT's two reviewer approvals before anything executes. The schedule only removes the manual dispatch step.

**Open housekeeping (see §5):** ROOT's attempt to invalidate the source variable after CLOSE was intercepted by GitHub's owner reauthentication dialog. It is **not confirmed saved**, so the reviewed ENABLE digest may still be stored. CLOSED code makes every tick `CLOSED_NOOP` regardless (no gate, no SQL). This is configuration housekeeping, not an open booking flow.

**Financial status:** no checkout, payment, provider call or booking. Nothing settles any obligation.

**Privacy:** no intent, ref, payment, session, reservation or contact identifier; no private DB value.

**Attribution (all times UTC, 2026-11-17):**
- `[GitHub]` = public Actions run / job / approval data, read by Claude with read-only tools.
- `[ROOT-obs]` = ROOT's own observations or actions.
- `[ROOT-held]` = facts ROOT holds privately.

**Roles:**
- **Claude** authored #174 / #175 / #176 and observed GitHub read-only.
- **ROOT** reviewed and merged, set the source variable, approved gate #1 and attempted the variable invalidation.
- Claude performed no merge, run, approval, variable, settings, DB or provider action.

---

## 1. Code provenance [GitHub]

| item | value |
|---|---|
| C115 implementation | #174 → **`3a10918e7e6ab2f8261a2b501f2cc1815bef3004`**, tree `dc5bb0d0`. Changes: `on.schedule` cron `13,43 * * * *` on the existing `e7-hosted-kickoff.yml`; a schedule is always the detect flow with empty bindings and can never route to manual execute; scheduled source pin = `vars.E7_KICKOFF_EXPECTED_SOURCE` or the literal `'MISSING'` (verify refuses), never a computed digest; manual dispatch unchanged. Kickoff source `4d64e571…`, closure `07fedfca…`, probe `01eca842…`; flags FALSE. Runner script byte-identical to #170 |
| ENABLE | #175 → **X = `c550fa2e8ff2c7213f6c4ac353a540355068a527`**, tree `457f3e8b`. The accepted #165 / #171 flag / state-assertion delta, plus ONE H11 CLOSED-constants line. Four pipeline files byte-identical to `9455bc9e` (frame `f09bcbbd`, bound). **Kickoff source `bd7d202266453bdf58f24123b611bd5919b74603dcbf205670d797799ddded37`**; tooling `4e79f266`; probe `11b1c55f…` (closed-only by contract) |
| CLOSE | #176 → **`d12d1a56b8474bf383e7a9e1fdb412415eb2b96f`**, tree **`dc5bb0d02d9d1ab17d8585339e6e83c933982480`** == the pre-ENABLE closed tree (`3a10918e`). ROOT independently verified the tree |

## 2. Proof A: scheduled CLOSED no-op on `3a10918e` [GitHub; ROOT verified PASS]
- **Run 44016752674:** `event=schedule`, `main`, attempt 1, **success**.
- **Timing:** created 04:22:40Z, which is 9m40s after the nominal 04:13 tick.

| job | window | result |
|---|---|---|
| preflight | 04:22:42–04:23:04 | success. Bindings `mode=detect` (schedule routing proven hosted); `PREFLIGHT_OK_PIPELINE_NOT_BOUND`; source `4d64e571`; child tests 39/39, 0 skipped |
| verify | 04:23:07–04:23:19 | success: **`CLOSED_NOOP`**, flow detect, flags false |
| detect / execute | — | **skipped** |

- **Approvals:** 0; `pending_deployments=[]`. No secret job ran.

## 3. Proof B: ONE supervised scheduled NO_REQUEST at X `c550fa2e`
- **Before ENABLE [ROOT-obs]:**
  - fresh quiescence: zero eligible requests and no active runs;
  - ROOT set the non-secret variable `vars.E7_KICKOFF_EXPECTED_SOURCE` to the reviewed ENABLE source `bd7d2022…`.
- **Synthetic preflight at X:** run **44103041845** (`workflow_dispatch`): `PREFLIGHT_OK_PIPELINE_BOUND`; verify / detect / execute skipped [GitHub / ROOT-obs].
- **The scheduled run:** **44106644568**, `event=schedule`, SHA X, attempt 1, **success**.
  - **Timing:** created 14:45:40Z, about 2m40s after the nominal 14:43 tick.

| job | window | result |
|---|---|---|
| preflight | 14:45:44–14:46:09 | success. Bindings `mode=detect`; `PREFLIGHT_OK_PIPELINE_BOUND`; source `bd7d2022…`; flags true; child tests 39/39, 0 skipped |
| verify | 14:46:11–14:46:24 | success: `VERIFY_OK`, flow detect, source `bd7d2022…` (**the scheduled pin matched**) |
| **detect (gate #1)** | 14:47:24–14:47:37 | ROOT approved **read-only only** on `e7-readonly-probe`. `DETECT_DONE`; core `DETECTED / NO_REQUEST`, **candidates 0**, no `candidateFingerprint`; consumer absent; **GET 0 / POST 0**; 13 DB statements; POOL_ENDED |
| **execute (gate #2)** | — | **skipped**; no gate #2 approval; `pending_deployments=[]` |

- **Runs at X [GitHub]:** exactly two:
  - the synthetic preflight 44103041845;
  - the scheduled run 44106644568.

  There was **no pipeline dispatch**.
- **Post-run DB proof:** `[ROOT-held]`, not reproduced here.

## 4. Scheduler timing (observed, best effort)
- The two observed ticks ran 9m40s and about 2m40s after nominal.
- These are observations, **not a bound**: GitHub may delay or drop scheduled runs.
- The cron is a nominal 30-minute polling cadence. Manual dispatch remains the fallback.

## 5. Source variable housekeeping (OPEN)
- After CLOSE, ROOT tried to change `vars.E7_KICKOFF_EXPECTED_SOURCE` to `MISSING`. **GitHub intercepted the update with an owner reauthentication ("Confirm access") dialog.**
- The change is **not confirmed saved**. The reviewed ENABLE digest `bd7d2022…` **may remain stored**.
- **Effect while main is CLOSED:** none on booking. Every scheduled tick is `CLOSED_NOOP` at verify, before any gate, secret or SQL. A stale pin also cannot match the closed source `4d64e571…`.
- **To finish it:** the owner completes the reauthentication, after which the variable is invalidated. That needs the owner's own credential step; Claude takes no settings or credential action.

## 6. Not proven / remaining
1. **A scheduled ONE → gate #2 → selected execute has not been exercised.** The ONE path is proven only via the manual detect dispatch (C114, checkpoint #173).
2. **Unattended operation is not claimed.** Both reviewer gates remain mandatory for every scheduled run.
3. **Scheduler reliability is best effort** (§4).
4. **The variable invalidation** is pending the owner's reauthentication (§5).
5. **Separate and parked:** notification (`guest.notify`) and the API test-payment helper.
