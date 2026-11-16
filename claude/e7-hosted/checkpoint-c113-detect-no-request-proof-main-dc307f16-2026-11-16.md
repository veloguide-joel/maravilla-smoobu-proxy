# Checkpoint C113: first hosted DETECT-mode proof (NO_REQUEST), CLOSED on main dc307f16 (DRAFT)

**Status: CLOSED. DRAFT for ROOT review (doc-only).**
- ONE hosted `detect`-mode kickoff run, with all binding inputs empty, ran on the reviewed ENABLE merge X (`4a635012`).
- ROOT approved ONLY gate #1, the read-only detect job. Detect ended `NO_REQUEST` with 0 candidates. Execute (gate #2) was SKIPPED by the workflow conditions, and ROOT never approved it.
- CLOSE (#166) was merged right after the detector was terminal. Final main is `dc307f16`, with tree `e7e5b502`. That tree is identical to the pre-ENABLE closed main `cbde707e`.
- Every booking runner's execute / dispatch flag is false.

**What it validates (observed):**
- The C113 two-gate wiring on GitHub:
  - a CLOSED main is a no-op (`CLOSED_NOOP`; detect and execute skipped; 0 approvals);
  - an ENABLE main reaches gate #1;
  - the detect step holds the DB secret only;
  - one rolled-back read-only snapshot was taken;
  - outcome `NO_REQUEST` → execute SKIPPED;
  - 0 claim / GET / POST.
- The #164 fix: the preflight checkout-bindings step admits `mode=detect`.

**What it does NOT validate (remaining gaps, §6):**
- detect `ONE` → the fingerprint reviewer check → gate #2 → a selected execute → a pipeline handoff;
- any outcome other than `NO_REQUEST` on GitHub;
- a scheduled / automatic trigger (manual `workflow_dispatch` only, by design);
- guest notification;
- production readiness.

**Financial status:** no checkout, payment, capture, refund or provider call was part of this proof. The spent C112 request, payment and reservation were not touched (§4). Refunds stay MANUAL. No obligation is settled.

**Privacy:** no intent, ref, payment, session, reservation or contact identifier is recorded here. No name, e-mail, guest detail or screenshot is recorded either.

**Attribution (all times UTC):**
- `[ROOT-obs]` = ROOT's GitHub / DB observations, relayed to Claude.
- `[Claude-obs]` = Claude's read-only GitHub API reads.
- `[Claude-code]` = git facts reproduced by Claude.

Claude authored #163 / #164 / #165 / #166. Claude ran no workflow, gate approval, DB query, merge, checkout, payment or provider call.

---

## 1. Code provenance [Claude-code]

| item | value |
|---|---|
| C113 contract | #162 → `c6489ef1` (doc-only, rev 2) |
| C113 implementation (CLOSED) | #163 → `12e18e86`, tree `213673cb`. Kickoff source `2ecb8b1b91c829b0d981b86e29f980e6264b7baf2d2fed753412abcbe5e5ccbd`; probe source `e6d6151b5a234337639e8fec71f84f04ea5fca3ddf065f35e3dec2ec4267bd8e` |
| Preflight mode fix (CLOSED) | #164 → `cbde707e`, tree `e7e5b50219b234e65724e671eb3ace0afaab7e3a`. Kickoff source `749468dc47c765966a666d90abbc71d16dc4eabce12587ba20f56ff8a18793c1`; probe source unchanged `e6d6151b…` |
| ENABLE | #165 → **X = `4a6350129b0fe9be32310fc42696bfbae82e5dbb`**, tree `3c93b028265e28a6fb365f8f197b038f15421696`. Same 7 paths as C112f #155: four pipeline files byte-identical to `9455bc9e` (frame `f09bcbbd…0999`, bound); kickoff `executeEnabled` / `dispatchEnabled` true. Kickoff source `e89b20c9aa162d90bd1a0b26a51fddd2ba09505e5b6ac9997d99fcc3255ea7ce`; closure `07fedfca…e87b`; tooling `4e79f266` |
| CLOSE | #166 → **`dc307f162d3dd9d150e148174cfbb64851b33ea6`**, tree **`e7e5b502`** == `cbde707e` (exact `git revert`; `diff(main→ENABLE) == diff(CLOSE→ENABLE)`) |

**Selection note:** the reviewed contract's SQL called `booking.pipeline_kickoff_excluded()`. The app role has no EXECUTE on that function, which the real-PG tests found (42501). The selection therefore binds the runner's reviewed exclusion list as `$4::uuid[]`. ROOT compared that list to the pinned consumer scope and accepted it. No ACL or schema change was made.

**The TLS probe is closed-main-only by contract** (#159 / #160). Its tests are expected to fail on ENABLE and were not modified.

## 2. Closed-main proofs [Claude-obs / ROOT-obs]

| run | SHA | result |
|---|---|---|
| 43929404455 | `12e18e86` | preflight step "Verify checkout bindings" → `REFUSED: mode` (exit 3); verify / detect / execute skipped; 0 approvals, secrets, DB access or dispatches. This is the defect fixed by #164 |
| 43930451616 | `cbde707e` | completed **success**: preflight success (`PREFLIGHT_OK_PIPELINE_NOT_BOUND`, closure `07fedfca`, source `749468dc`, child tests 37/37, 0 skipped, ENV_OK; bindings checked with `mode=detect`); verify success (`CLOSED_NOOP`, flow detect, flags false, core null); **detect and execute skipped** |

The `open=false` step output is not printed in the log; outputs are deliberately stripped from the JSON line. It follows from `CLOSED_NOOP` (unit test H9) and from detect being skipped.

## 3. Readiness before ENABLE [ROOT-obs]

- Fresh shared DEV at 19:41:43Z:
  - schema 1..24 exact;
  - kickoff requests `requested` = eligible = 0;
  - intent / work / operation leases 0;
  - in-flight 0; advisory locks 0.
- All six Actions run filters were empty (also confirmed [Claude-obs] at ~19:42Z: queued / in_progress / waiting / requested / pending / action_required all 0).

## 4. The proof at X [ROOT-obs]

| item | value |
|---|---|
| Synthetic preflight at X | run 43942231695 SUCCESS, `PREFLIGHT_OK_PIPELINE_BOUND`, source `e89b20c9`, pipeline bound true |
| Detect run | **43942369875** at X, mode `detect`, all binding inputs empty: preflight success, verify success, detect success (gate #1 approved by ROOT, the only approval), **execute SKIPPED** |
| Summary | `DETECT_DONE detect=NO_REQUEST candidates=0 cleanup=POOL_ENDED`; core `DETECTED/NO_REQUEST`; consumer -; gets 0; posts 0; verified false; sealed false |
| Runs at X | exactly 2 kickoff runs (the preflight and the detect); 0 pipeline runs |

- **Post-run shared DEV at 19:46:56Z:**
  - environment test; schema 1..24;
  - requested 0; eligible 0;
  - all leases and in-flight 0; advisory locks 0.
- **Request-table fingerprint** unchanged at `09c2e9a95298b854c8571a5f7046a1bf`, so the detect wrote nothing.
- The spent C112 request / payment / reservation were not touched.

## 5. CLOSE [ROOT-obs / Claude-code]

- #166 was retargeted to main and merged once the detector was terminal.
- Main is `dc307f16`, tree `e7e5b502`. That equals the pre-ENABLE closed tree.
- All booking flags are false.

## 6. Not proven / remaining gaps

1. **The ONE path end to end.** Detect `ONE` → reviewer fingerprint recompute → gate #2 → selected execute (re-selection + fingerprint equality) → one pipeline handoff. Unit / real-PG tests cover it offline; it has not run on GitHub. This needs ONE fresh TEST request; a separate package is proposed.
2. **Other hosted outcomes.** `AMBIGUOUS` / `INELIGIBLE` / `STOP` and the selected-path uncertainty outcomes are proven offline only.
3. **Snapshot scope.** `NO_REQUEST` is the result of ONE snapshot. It is not a claim about global cardinality over time.
4. **Trigger.** Manual dispatch only; there is no schedule, by design. An automatic trigger remains a separate decision.
5. **Notification.** `guest.notify` remains a separate contract.
