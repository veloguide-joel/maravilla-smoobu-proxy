# C29/C30 — Operator note: the PREPARED Slice 4 recording enable revision (this PR) and the reviewed exact CLOSE patch — 2026-11-13 (rev 2, ROOT review 5900326136 F1–F2 applied)

**Preparation only.** This PR makes the action proposed in the merged C27/C28 proposal (`c27-first-hosted-test-recording-trial-proposal-2026-11-13.md`, main `b2696a24`) concrete for independent ROOT review and the subsequent owner decision. **ROOT review 5900228555 accepted the proposal only — proposal GO is not execution GO.** Execution would still require the owner decisions **D-a / D-b / D-c (undecided)**, ROOT's fresh pre-GO proofs (DB ≤ 10 min, Stripe raw ≤ 15 min at GO / environment approval, refreshed after any stale gate delay; Hostaway identity `new` + conflict-free LIST; bound planHash / digests / main SHA / run id) and the existing environment gate. Nothing is merged, dispatched, approved, inspected or processed here. Refunds are manual; recording / notification / cleanup remain HELD; both TEST intents, their claims and provider objects are untouched. Closed flags do not mean nothing is pending: the captured TEST funds (USD 140.00 = 14000 minor), the active R71700931 and the HELD claims still await manual, policy-assessed decisions; no fresh observation of any of them is claimed here.

## 1. ENABLE revision (this PR) — runtime scope
- `scripts/e7-hosted-recording.mjs`: `executeEnabled: false → true` plus accurate comments (header: prepared revision, proposal GO ≠ execution GO, D4 original conditions MET, owner-policy hold, the reviewed CLOSE patch is what ROOT would merge after END or STOP — nothing closes automatically; flag line; hosted-wrapper line; refusal-line comment "the flag alone is never consent"). **Nothing else:** tooling pin `4ed7a636`, closure `b02f0a76ae2347badc55ef2daaf27640f7ef80c01d7e69d1e9bdc7d8d38c4109` (30 paths), pg 8.18.0, budgets, admission, transport grammar, stored-refund veto and workflow are byte-identical to main.
- Other four runner flags stay `false`; their runners, workflows and pins are untouched.

## 2. Tests (narrow, per proposal §3; no assertion removed; labels truthful in the ENABLE revision)
| file | change |
|---|---|
| `test/e7-hosted-recording.test.mjs` | C1: "flag OPEN in the PREPARED enable revision (pending D-a / D-b / D-c)", recording `true`, Slices 1/2/3 `false`, pin label **4ed7a636**; H1: preflight `result.executeEnabled === true`; H2: `HRC_EXECUTE_CLOSED` kept via test-local `const CLOSED = { ...C, executeEnabled: false }` through the existing `deps.constants` seam — described as a local refusal control valid whatever the shipped flag is |
| `test/e7-hosted-recorded-cleanup.test.mjs` | C1 cross-assertion: recording `true` (prepared enable revision), own + Slices 1/2/3 `false` |
| `test/e7-hosted-integrated-rehearsal.test.mjs` | R0 flags `[false, false, false, true, false]` (prepared enable revision) |
| `test/e7-hosted-charge-list-probe-workflow.test.mjs` | W7: flags (recording `true`, others `false`) + the current ENABLE-revision recording / recorded-cleanup digests; wording now says the probe script / test / workflow are the **current repinned bytes (#101)** covered by the probe source digest frame (no claim of equality with #95). This file is OUTSIDE the probe source digest frame |

## 3. Digests at the ENABLE head (`rdig` over each runner's `runnerFiles`)
| runner | flag | digest | vs main `b2696a24` |
|---|---|---|---|
| reservation | false | `5665544de105e4564a57a4434fa32fd2355b9bbd0e756b250d1248e07feb6b19` | unchanged |
| capture | false | `5b547a42200b452055d8a718c84ab70f7f2b5a0cd8343f6174c4a75b0c420ed1` | unchanged |
| test-cleanup | false | `33f2ab18984dccd3915a18ff8a55dd4a6e5b6bf89e3d84ba1e578347e6cebd1e` | unchanged |
| **recording** | **true** | `8296adaeec8389f013af539dbe7c7a203d8debb19f11854d31759be24bc60295` | changed (runner flag + comments; test C1 / H1 / H2) — the `expected_runner_digest` a gated dispatch must carry **if** this PR is merged unchanged |
| recorded-cleanup | false | `e118e1181e961ba6e572273c14b720996d97453c24e11a8197410c582fe4a84b` | changed (its test's cross-assertion only; runner / workflow bytes unchanged) |
Probe source digest (script → test → workflow frame) **unchanged**: `43715872ddb450889286880c848acefd8757da6fe33bc5c6a3a547bd27219cf3`.

## 4. Validation at the ENABLE head (own pins; fake providers; throwing network guards)
Affected suites rerun after the C30 amendment: recording 23/23 @4ed7a636 (non-PG mode) · recorded-cleanup 16/16 @e41b654a · rehearsal R0 1/1 · probe workflow 7/7 @4ed7a636. Reservation 20/20, capture 15/15, test-cleanup 20/20 are unchanged files — ROOT's independent C29 evidence (review 5900326136: 102/102 ENABLE, zero skips) stands for them.

## 5. Reviewed exact CLOSE patch (NOT applied to this PR or main; ROOT would merge it after the ONE gated attempt has ENDED or STOPPED)
Reverses only the flag, the comments and the test-positive expectations back to all FALSE; the test-local CLOSED seam and this note are retained (valid in both revisions). The patch's own comments / titles describe **closure after END or STOP** and assert nothing about whether or how the attempt ran. Built in an isolated scratch worktree on the ENABLE head and verified there: `git apply --check` OK against the final ENABLE head; applied copy == scratch diff; CLOSED-revision suites: recording 23/23 · recorded-cleanup 16/16 · R0 1/1 · probe workflow 7/7 (reservation / capture / test-cleanup files are untouched by the patch).
**CLOSED-revision digests:** reservation / capture / test-cleanup unchanged; recording `49b5516cb69543a6bd4a697a407d2f2a97a84e18a63f18715338f099917e4824` (flag `false`; CLOSE-revision comments + retained seam); recorded-cleanup `9e2021e3ec96bab16869fc194adac672287d559587b2cb7657738ffcd897de1f` (CLOSE-revision C1 title; flag assertions all `false`).
**Patch SHA-256:** `24ee4ba5b7d1e393dec034c6e8f973f3e1b5849869aa71c7dcdcc791cddc8c47` (109 lines). Exact patch:

```diff
diff --git a/scripts/e7-hosted-recording.mjs b/scripts/e7-hosted-recording.mjs
index deabc0d..e2fa7e9 100644
--- a/scripts/e7-hosted-recording.mjs
+++ b/scripts/e7-hosted-recording.mjs
@@ -4,10 +4,9 @@
 // DEV database, with FAKE-free real transports. Bookkeeping only: Hostaway offline charges move no money.
 //
 // HONEST LABEL: MANUAL hosted TEST recording (workflow_dispatch + the existing reviewer gate), NOT automatic customer checkout. Code is NOT
-// consent: this is the PREPARED enable revision (C29) for ONE reviewed, gated hosted TEST recording of the ONE captured intent. ROOT review
-// 5900228555 accepted the C27/C28 PROPOSAL only — proposal GO is NOT execution GO: execution still needs the owner decisions D-a / D-b / D-c, ROOT's
-// fresh pre-GO proofs and the existing environment gate. The reviewed CLOSE patch (c29 operator note) is what ROOT would merge to restore false
-// after the run ENDS or STOPS; nothing closes automatically. D4's original conditions (ROOT 5883328669:
+// consent: executeEnabled is CLOSED again (the reviewed C29 CLOSE patch, merged by ROOT once the ONE gated hosted TEST recording attempt has ENDED or
+// STOPPED — the patch itself asserts nothing about whether or how that attempt ran; verify / execute refuse HRC_EXECUTE_CLOSED). ROOT review 5900228555
+// accepted the C27/C28 PROPOSAL only; execution authority was a separate owner decision (D-a / D-b / D-c) plus the environment gate. D4's original conditions (ROOT 5883328669:
 // recorded-state cleanup contract implemented — 0021 / mirror worker / Slice 5 runner, all CLOSED; migration issuance hold resolved — shared DEV
 // exactly 0001..0021) are MET. The owner policy decisions D-a / D-b / D-c (manual, policy-assessed refund disposition; no automated exit from a
 // recorded TEST state; a recorded TEST intent — confirmed + ONE queued PRISTINE guest.notify + succeeded recording + two unprocessed
@@ -54,7 +53,7 @@ import { CONSTANTS as RES, canonical, framedDigest, childEnv, spawnNode, dbTarge
 export const CONSTANTS = Object.freeze({
   toolingCommit: "4ed7a636fee57981262b9c02574190d225b8a1fc",    // e7-test: #99 merged (C21-F1) on top of #84 (C1 capture) / #81 / #78 / #76 / #75 / PR72; immutable (C24 repin from 5a094b16)
   toolingStatus: "MERGED",
-  executeEnabled: true,                                           // Slice 4: PREPARED enable for the ONE reviewed gated TEST recording (C29; pending D-a / D-b / D-c); the reviewed CLOSE patch restores false after END or STOP
+  executeEnabled: false,                                          // Slice 4: CLOSED again by the reviewed C29 CLOSE patch (after the ONE gated TEST recording attempt ENDED or STOPPED); verify / execute refuse HRC_EXECUTE_CLOSED
   // the INDEPENDENTLY scanned transitive relative imports of the runner's tooling roots at 4ed7a636 (test C2 recomputes this from the pinned tree; SAME 30-path set as at 5a094b16, 8 members changed bytes):
   // = the Slice 1 closure + lib/booking-db/recording-worker.js (executor-adapters + offline-charge-proof are already in the Slice 1 closure)
   closure: Object.freeze(["lib/bookability.js", "lib/booking-db/codec.js", "lib/booking-db/config.js", "lib/booking-db/operations.js", "lib/booking-db/pool.js",
@@ -730,7 +729,7 @@ export async function runRecordingCore(input) {
 }
 
 // =================================================================================================================================
-// hosted wrapper (GitHub Actions): preflight (no secrets) / verify / execute (flag OPEN in this prepared revision for ONE gated run, still behind the environment gate and the owner decision; HRC_EXECUTE_CLOSED whenever executeEnabled is false)
+// hosted wrapper (GitHub Actions): preflight (no secrets) / verify / execute (CLOSED: HRC_EXECUTE_CLOSED whenever executeEnabled is false; reopened only by a reviewed flag PR after an owner decision)
 // LABELLED COPY of the reviewed Slice 3 runHosted, specialised: recording closure / runner files, HRC_ codes, Hostaway-only secrets, two pools (6543 / 5432).
 export const CLOSURE_DIGEST_PREFIX = "e7-hosted-recording-closure-v1\n";
 export const RUNNER_DIGEST_PREFIX = "e7-hosted-recording-runner-v1\n";
diff --git a/test/e7-hosted-charge-list-probe-workflow.test.mjs b/test/e7-hosted-charge-list-probe-workflow.test.mjs
index f757901..aedcf3f 100644
--- a/test/e7-hosted-charge-list-probe-workflow.test.mjs
+++ b/test/e7-hosted-charge-list-probe-workflow.test.mjs
@@ -128,11 +128,11 @@ test("W6 probe re-check block executed locally (BEFORE the one --probe call; no
   } finally { rmSync(d, { recursive: true, force: true }); }
 });
 
-test("W7 the five reviewed runners are untouched: the new workflow is in NO runner's runnerFiles, the shipped flags are [false, false, false, true, false] (C29 prepared enable revision: only the Slice 4 recording flag OPEN, pending D-a / D-b / D-c), and the five runner digests (framedDigest over runnerFiles) are exactly the current ENABLE-revision values (recording / recorded-cleanup re-derived; other three unchanged since C24); the probe script, test and workflow are the current repinned bytes (#101), covered by the probe source digest frame", async () => {
-  const want = { reservation: "5665544de105e4564a57a4434fa32fd2355b9bbd0e756b250d1248e07feb6b19", capture: "5b547a42200b452055d8a718c84ab70f7f2b5a0cd8343f6174c4a75b0c420ed1", "test-cleanup": "33f2ab18984dccd3915a18ff8a55dd4a6e5b6bf89e3d84ba1e578347e6cebd1e", recording: "8296adaeec8389f013af539dbe7c7a203d8debb19f11854d31759be24bc60295", "recorded-cleanup": "e118e1181e961ba6e572273c14b720996d97453c24e11a8197410c582fe4a84b" };   // C29/C30 ENABLE-revision digests: recording (flag / comments + test) and recorded-cleanup (cross-runner test assertion) re-derived; other three unchanged
+test("W7 the five reviewed runners are untouched: the new workflow is in NO runner's runnerFiles, every runner has executeEnabled false again (reviewed C29 CLOSE patch after the ONE gated TEST recording attempt ENDED or STOPPED), and the five runner digests (framedDigest over runnerFiles) are exactly the current CLOSE-revision values (recording / recorded-cleanup re-derived; other three unchanged since C24); the probe script, test and workflow are the current repinned bytes (#101), covered by the probe source digest frame", async () => {
+  const want = { reservation: "5665544de105e4564a57a4434fa32fd2355b9bbd0e756b250d1248e07feb6b19", capture: "5b547a42200b452055d8a718c84ab70f7f2b5a0cd8343f6174c4a75b0c420ed1", "test-cleanup": "33f2ab18984dccd3915a18ff8a55dd4a6e5b6bf89e3d84ba1e578347e6cebd1e", recording: "49b5516cb69543a6bd4a697a407d2f2a97a84e18a63f18715338f099917e4824", "recorded-cleanup": "9e2021e3ec96bab16869fc194adac672287d559587b2cb7657738ffcd897de1f" };   // C29/C30 CLOSE-revision digests: all five flags false again; recording / recorded-cleanup re-derived; other three unchanged
   for (const n of Object.keys(want)) {
     const m = await import(`../scripts/e7-hosted-${n}.mjs`);
-    assert.equal(m.CONSTANTS.executeEnabled, n === "recording", n); assert.ok(!m.CONSTANTS.runnerFiles.includes(WF), n);   // C29 prepared enable revision: recording flag true, the other four false
+    assert.equal(m.CONSTANTS.executeEnabled, false, n); assert.ok(!m.CONSTANTS.runnerFiles.includes(WF), n);
     assert.equal(await framedDigest(ROOT, m.CONSTANTS.runnerFiles, m.RUNNER_DIGEST_PREFIX), want[n], n);
   }
   assert.equal(P.PROBE_VERSION, "e7-hosted-charge-list-probe-v2");
diff --git a/test/e7-hosted-integrated-rehearsal.test.mjs b/test/e7-hosted-integrated-rehearsal.test.mjs
index 5232656..fa689ac 100644
--- a/test/e7-hosted-integrated-rehearsal.test.mjs
+++ b/test/e7-hosted-integrated-rehearsal.test.mjs
@@ -64,8 +64,8 @@ const enc = (o) => new TextEncoder().encode(JSON.stringify(o));
 const MINUTE = 60000; const DAY = 86400000;
 const REAL_WAIT_CAP_MS = 150000;                      // test-harness scheduling: REAL wait up to 150 s per sleep (covers the E7.1 two-minute read freshness window); longer → throw (see header)
 
-test("R0 the five runners declare the expected immutable tooling pins; shipped executeEnabled = [false, false, false, true, false] (C29 prepared enable revision: only the Slice 4 recording flag OPEN, pending D-a / D-b / D-c; Slices 1–3 and 5 CLOSED). The rehearsal itself never reads the flag", () => {
-  assert.deepEqual(RUNNERS.map((r) => r.E.CONSTANTS.executeEnabled), [false, false, false, true, false]);   // C29 prepared enable revision: Slice 4 flag OPEN (pending D-a / D-b / D-c)
+test("R0 the five runners declare the expected immutable tooling pins; shipped executeEnabled = all false again (Slices 1–5 CLOSED; Slice 4 closed by the reviewed C29 CLOSE patch after its ONE gated TEST recording attempt ENDED or STOPPED). The rehearsal itself never reads the flag", () => {
+  assert.deepEqual(RUNNERS.map((r) => r.E.CONSTANTS.executeEnabled), [false, false, false, false, false]);   // all CLOSED again (reviewed C29 CLOSE patch after the ONE gated TEST recording attempt ENDED or STOPPED)
   for (const r of RUNNERS) {
     assert.equal(r.E.CONSTANTS.toolingCommit, r.pin, r.name);
     assert.ok(Array.isArray(r.E.CONSTANTS.closure) && /^[0-9a-f]{64}$/.test(r.E.CONSTANTS.closureDigest), `${r.name} closure`);
diff --git a/test/e7-hosted-recorded-cleanup.test.mjs b/test/e7-hosted-recorded-cleanup.test.mjs
index 244d2fd..c1f4ec2 100644
--- a/test/e7-hosted-recorded-cleanup.test.mjs
+++ b/test/e7-hosted-recorded-cleanup.test.mjs
@@ -602,8 +602,8 @@ test("A10 postcheck + readbacks + residual agreement: a mirror worker that claim
     assert.deepEqual([r.outcome, r.code, posts(w), w.mirrorCalls], ["LINEAGE_MISMATCH", "MIRROR_ROW_NOT_BOUND", [CANCEL_URL, REFUND_URL], 0], JSON.stringify(r)); }
 });
 
-test("C1 code ceiling: Slice 5 recorded cleanup execution CLOSED (executeEnabled false) AND Slices 1–3 CLOSED on THEIR tooling pins; Slice 4 recording flag OPEN in the PREPARED enable revision (C29, pending D-a / D-b / D-c); this runner pins the MERGED e7-test e41b654a; the plan pins pi / reservation / Stripe charge / original offline charge / captured amount / stay / attempt / session and the accepted keys / titles / amount; ZERO capture / void / record / notify / create; the derived expectation is EXACTLY the accepted 18 keys", () => {
-  assert.equal(C.executeEnabled, false); for (const R of [RESRUN, CAPRUN, TCRUN]) assert.equal(R.CONSTANTS.executeEnabled, false); assert.equal(RCRUN.CONSTANTS.executeEnabled, true, "C29 prepared enable revision: Slice 4 recording flag OPEN (pending D-a / D-b / D-c); this runner stays CLOSED");
+test("C1 code ceiling: Slice 5 recorded cleanup execution CLOSED (executeEnabled false) AND the Slice 1–4 runners CLOSED on THEIR tooling pins (Slice 4 closed again by the reviewed C29 CLOSE patch after its ONE gated TEST recording attempt ENDED or STOPPED); this runner pins the MERGED e7-test e41b654a; the plan pins pi / reservation / Stripe charge / original offline charge / captured amount / stay / attempt / session and the accepted keys / titles / amount; ZERO capture / void / record / notify / create; the derived expectation is EXACTLY the accepted 18 keys", () => {
+  assert.equal(C.executeEnabled, false); for (const R of [RESRUN, CAPRUN, TCRUN, RCRUN]) assert.equal(R.CONSTANTS.executeEnabled, false);
   assert.equal(C.toolingCommit, "e41b654a667cb0ba8775b5bd0040c28a3d14fda0"); assert.equal(C.toolingStatus, "MERGED");
   assert.equal(TCRUN.CONSTANTS.toolingCommit, "9d86bfa1e60779b3794de88bbae151670e8fe515", "the reviewed Slice 3 pin is untouched"); assert.equal(RCRUN.CONSTANTS.toolingCommit, "4ed7a636fee57981262b9c02574190d225b8a1fc", "C24: Slice 4 pins the merged C21-F1 fix (recording-only repin); this runner's own pin is untouched");
   assert.equal(CAPRUN.CONSTANTS.toolingCommit, "59178b0468469b6570beab861bbc8e48b3a887d1", "C2: Slice 2 pins the merged C1 fix; this runner's own pin is untouched");
diff --git a/test/e7-hosted-recording.test.mjs b/test/e7-hosted-recording.test.mjs
index f895780..729047f 100644
--- a/test/e7-hosted-recording.test.mjs
+++ b/test/e7-hosted-recording.test.mjs
@@ -509,8 +509,8 @@ test("F2 (ROOT 5883758657) honest statement accounting: reported dbQueries == EV
     assert.equal(r.dbQueries, pool.reads, "counted even when the residual read fails"); }
 });
 
-test("C1 code ceiling: Slice 4 recording flag OPEN in the PREPARED enable revision (executeEnabled true; C29, pending D-a / D-b / D-c) AND Slice 1 / 2 / 3 CLOSED on THEIR tooling (after the ONE reviewed owner-present TEST); this runner pins the MERGED e7-test 4ed7a636; the plan pins pi / reservation / charge / captured amount / stay / attempt / session, the accepted recording key, credit_card / hostaway-e7-test, title / amount wire forms = the accepted module's; ZERO stripe / capture / void / cancel / refund / notify / create", () => {
-  assert.equal(C.executeEnabled, true); assert.equal(RESRUN.CONSTANTS.executeEnabled, false); assert.equal(CAPRUN.CONSTANTS.executeEnabled, false); assert.equal(TCRUN.CONSTANTS.executeEnabled, false);
+test("C1 code ceiling: Slice 4 recording execution CLOSED again (executeEnabled false; reviewed C29 CLOSE patch after the ONE gated TEST recording attempt ENDED or STOPPED) AND Slice 1 / 2 / 3 CLOSED on THEIR tooling (after the ONE reviewed owner-present TEST); this runner pins the MERGED e7-test 4ed7a636; the plan pins pi / reservation / charge / captured amount / stay / attempt / session, the accepted recording key, credit_card / hostaway-e7-test, title / amount wire forms = the accepted module's; ZERO stripe / capture / void / cancel / refund / notify / create", () => {
+  assert.equal(C.executeEnabled, false); assert.equal(RESRUN.CONSTANTS.executeEnabled, false); assert.equal(CAPRUN.CONSTANTS.executeEnabled, false); assert.equal(TCRUN.CONSTANTS.executeEnabled, false);
   assert.equal(C.toolingCommit, "4ed7a636fee57981262b9c02574190d225b8a1fc"); assert.equal(C.toolingStatus, "MERGED");
   // C2: Slice 2 is repinned to the merged C1 fix (59178b04); Slice 1 (40779e34) and Slice 3 (9d86bfa1) keep their own immutable pins
   assert.equal(RESRUN.CONSTANTS.toolingCommit, "40779e34e8c65ac5c4494bc5a18cd4223ef723fa");
@@ -561,7 +561,7 @@ test("H1 hosted: preflight (no secrets) passes on the pinned closure; the Stripe
   const run = (env, deps = {}) => E.runHosted({ mode: "preflight", env: pick(env), proc: PROC, wrapperDir: ROOT, deps: { spawnChild: okChild, ...deps } });
   const a = await run(envOf());
   assert.equal(a.result.code, "PREFLIGHT_OK_SYNTHETIC_ONLY", JSON.stringify(a.result)); assert.equal(a.exitCode, 0);
-  assert.deepEqual([a.result.closureDigest, a.result.planKind, a.result.executeEnabled, a.result.toolingCommit, a.result.tests.pass], [C.closureDigest, "SYNTHETIC", true, C.toolingCommit, 3]);
+  assert.deepEqual([a.result.closureDigest, a.result.planKind, a.result.executeEnabled, a.result.toolingCommit, a.result.tests.pass], [C.closureDigest, "SYNTHETIC", false, C.toolingCommit, 3]);
   assert.equal(a.result.runnerDigest, await RESRUN.framedDigest(ROOT, C.runnerFiles, E.RUNNER_DIGEST_PREFIX));
   const b = await run(envOf(realEnv()));
   assert.deepEqual([b.result.code, b.result.planKind, b.result.planHash], ["PREFLIGHT_OK_REAL_PLAN", "REAL", E.buildPlan(C, { ...planInput({ approvalRef: "label-1" }), runnerDigest: a.result.runnerDigest }).planHash]);
```

## 6. Holds that stay in force
Owner decisions D-a / D-b / D-c undecided (D-a includes ONE pristine queued `guest.notify` row and TWO unprocessed `recording_conflict_inbox` rows with no dispatch / processing authority; START checks precede the session lock; zero recording POST is distinct from zero persisted DB work; the disposable I1 run's 147 DB statements include 15 teardown = 132 body). No gate approval, dispatch, merge, provider / shared-DEV / dashboard / run inspection, operational INSERT, notification or inbox processing, money / booking / cancel / refund / void / claim / cleanup / mirror action is part of this preparation.
