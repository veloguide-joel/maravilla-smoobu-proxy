# C29 — Operator note: Slice 4 recording ENABLE (this PR) and the prepared exact CLOSE patch — 2026-11-13

**Preparation only.** This PR makes the proposed action of the merged C27/C28 proposal (`c27-first-hosted-test-recording-trial-proposal-2026-11-13.md`, main `b2696a24`) concrete for independent ROOT review and the subsequent owner decision. It is a DRAFT; nothing is merged, dispatched, approved, inspected or processed. Owner decisions **D-a / D-b / D-c remain undecided**; refunds are manual; recording / notification / cleanup remain HELD; both TEST intents, their claims and provider objects are untouched. ROOT qualifications on the proposal apply: D-a includes ONE pristine queued `guest.notify` row and TWO unprocessed `recording_conflict_inbox` rows (no dispatch / processing authority); DB proof ≤ 10 min and Stripe raw proof ≤ 15 min at GO / environment approval, refreshed after any stale gate delay; START checks precede the session lock; zero recording POST is distinct from zero persisted DB work; 147 total DB statements on the disposable I1 run include 15 teardown (132 body).

## 1. ENABLE (this PR) — runtime scope
- `scripts/e7-hosted-recording.mjs`: `executeEnabled: false → true` plus accurate comments (header, line 52, hosted-wrapper line, refusal line). **Nothing else:** tooling pin `4ed7a636`, closure `b02f0a76ae2347badc55ef2daaf27640f7ef80c01d7e69d1e9bdc7d8d38c4109` (30 paths), pg 8.18.0, budgets, admission (`checkStart` / `checkCommon`), transport grammar, stored-refund veto (`refundObservationRefusal`) and workflow are byte-identical to main.
- Other four runner flags stay `false`; their runners, workflows and pins are untouched.

## 2. Tests (narrow, per proposal §3; no assertion removed)
| file | change |
|---|---|
| `test/e7-hosted-recording.test.mjs` | C1: recording `true`, Slices 1/2/3 `false`; H1: preflight `result.executeEnabled === true`; H2: `HRC_EXECUTE_CLOSED` kept via test-local `const CLOSED = { ...C, executeEnabled: false }` through the existing `deps.constants` seam (the `opened` seam checks are unchanged) |
| `test/e7-hosted-recorded-cleanup.test.mjs` | C1 cross-assertion: recording `true`, own + Slices 1/2/3 `false` |
| `test/e7-hosted-integrated-rehearsal.test.mjs` | R0 flags `[false, false, false, true, false]` (title) |
| `test/e7-hosted-charge-list-probe-workflow.test.mjs` | W7: flags (recording `true`, others `false`) + recording / recorded-cleanup digest expectations — this file is OUTSIDE the probe source digest frame |

## 3. Digests at the ENABLE head (`rdig` over each runner's `runnerFiles`)
| runner | flag | digest | vs main `b2696a24` |
|---|---|---|---|
| reservation | false | `5665544de105e4564a57a4434fa32fd2355b9bbd0e756b250d1248e07feb6b19` | unchanged |
| capture | false | `5b547a42200b452055d8a718c84ab70f7f2b5a0cd8343f6174c4a75b0c420ed1` | unchanged |
| test-cleanup | false | `33f2ab18984dccd3915a18ff8a55dd4a6e5b6bf89e3d84ba1e578347e6cebd1e` | unchanged |
| **recording** | **true** | `47d2134e9bfd1971ccbd9b719cd34a3ed0f69fb5ce4d5bc91fa2d1789053423e` | changed (runner flag + comments; test C1 / H1 / H2) — this is the `expected_runner_digest` the gated dispatch must carry **if** the PR is merged unchanged |
| recorded-cleanup | false | `278a9f4ff82180b276152bfc63fac94f6323777cfddf10c05fe450e9c2e470da` | changed (its test's cross-assertion only; runner / workflow bytes unchanged) |
Probe source digest (script → test → workflow frame) **unchanged**: `43715872ddb450889286880c848acefd8757da6fe33bc5c6a3a547bd27219cf3`.

## 4. Validation at the ENABLE head (own pins; fake providers, throwing network guards)
reservation 20/20 @40779e34 · capture 15/15 @59178b04 · test-cleanup 20/20 @9d86bfa1 · recording 23/23 @4ed7a636 (non-PG mode) · recorded-cleanup 16/16 @e41b654a · rehearsal R0 1/1 · probe workflow 7/7 @4ed7a636. No broad or mixed-PG rerun (flag-only maintenance; ROOT's recording PG 30 / mixed 7 remain prior evidence).

## 5. Prepared exact CLOSE patch (NOT applied to this PR or main)
Reverses only the flag, the comments and the test-positive expectations back to all FALSE; the test-local CLOSED seam and this note are retained (valid in both states). Built in an isolated scratch worktree on the ENABLE head and verified there: `git apply --check` OK against the ENABLE head; applied copy == scratch diff; focused suites in the CLOSED state: reservation 20/20 · capture 15/15 · test-cleanup 20/20 · recording 23/23 · recorded-cleanup 16/16 · R0 1/1 · probe workflow 7/7.
**CLOSED-state digests:** reservation / capture / test-cleanup unchanged; recorded-cleanup back to `e9011de76a1737d50ebcf8277e66f8911bcdc888ddf7a620b19c89f9a4699dca` (byte-identical test line restored); recording `647b7808ac381b73d0ea3c5886a47b4f2e16d5ada5224eb1017227fbdb84fedc` (differs from the pre-enable `80000253…` only by the CLOSE-state comments and the retained CLOSED seam; flag `false`).
**Patch SHA-256:** `3be383b26fb910fe1f50b8e36a32abb7881d786247b5d5ee2b0746d90121fe0e` (127 lines). Exact patch:

```diff
diff --git a/scripts/e7-hosted-recording.mjs b/scripts/e7-hosted-recording.mjs
index 0fc2740..ca6c331 100644
--- a/scripts/e7-hosted-recording.mjs
+++ b/scripts/e7-hosted-recording.mjs
@@ -4,8 +4,8 @@
 // DEV database, with FAKE-free real transports. Bookkeeping only: Hostaway offline charges move no money.
 //
 // HONEST LABEL: MANUAL hosted TEST recording (workflow_dispatch + the existing reviewer gate), NOT automatic customer checkout. Code is NOT
-// consent: executeEnabled is OPEN in this revision (C29, ROOT GO 5900228555 on the C27/C28 proposal) for ONE reviewed, gated hosted TEST recording of
-// the ONE captured intent; it is closed again by the prepared CLOSE patch immediately after that run. D4's original conditions (ROOT 5883328669:
+// consent: executeEnabled is CLOSED again (C29 CLOSE patch applied after the ONE reviewed, gated hosted TEST recording of the ONE captured intent;
+// verify / execute refuse HRC_EXECUTE_CLOSED). D4's original conditions (ROOT 5883328669:
 // recorded-state cleanup contract implemented — 0021 / mirror worker / Slice 5 runner, all CLOSED; migration issuance hold resolved — shared DEV
 // exactly 0001..0021) are MET. The owner policy decisions D-a / D-b / D-c (manual, policy-assessed refund disposition; no automated exit from a
 // recorded TEST state; a recorded TEST intent — confirmed + ONE queued PRISTINE guest.notify + succeeded recording + two unprocessed
@@ -52,7 +52,7 @@ import { CONSTANTS as RES, canonical, framedDigest, childEnv, spawnNode, dbTarge
 export const CONSTANTS = Object.freeze({
   toolingCommit: "4ed7a636fee57981262b9c02574190d225b8a1fc",    // e7-test: #99 merged (C21-F1) on top of #84 (C1 capture) / #81 / #78 / #76 / #75 / PR72; immutable (C24 repin from 5a094b16)
   toolingStatus: "MERGED",
-  executeEnabled: true,                                           // Slice 4: OPEN for the ONE reviewed gated TEST recording (C29); CLOSE patch restores false right after
+  executeEnabled: false,                                          // Slice 4: recording execution CLOSED again (verify / execute refuse HRC_EXECUTE_CLOSED) after the ONE reviewed gated TEST recording (C29)
   // the INDEPENDENTLY scanned transitive relative imports of the runner's tooling roots at 4ed7a636 (test C2 recomputes this from the pinned tree; SAME 30-path set as at 5a094b16, 8 members changed bytes):
   // = the Slice 1 closure + lib/booking-db/recording-worker.js (executor-adapters + offline-charge-proof are already in the Slice 1 closure)
   closure: Object.freeze(["lib/bookability.js", "lib/booking-db/codec.js", "lib/booking-db/config.js", "lib/booking-db/operations.js", "lib/booking-db/pool.js",
@@ -728,7 +728,7 @@ export async function runRecordingCore(input) {
 }
 
 // =================================================================================================================================
-// hosted wrapper (GitHub Actions): preflight (no secrets) / verify / execute (OPEN in this revision for ONE gated run; HRC_EXECUTE_CLOSED whenever executeEnabled is false)
+// hosted wrapper (GitHub Actions): preflight (no secrets) / verify / execute (CLOSED: HRC_EXECUTE_CLOSED whenever executeEnabled is false; reopened only by a reviewed flag PR)
 // LABELLED COPY of the reviewed Slice 3 runHosted, specialised: recording closure / runner files, HRC_ codes, Hostaway-only secrets, two pools (6543 / 5432).
 export const CLOSURE_DIGEST_PREFIX = "e7-hosted-recording-closure-v1\n";
 export const RUNNER_DIGEST_PREFIX = "e7-hosted-recording-runner-v1\n";
@@ -768,7 +768,7 @@ export async function runHosted({ mode = "preflight", env, proc, wrapperDir, dep
     if (inp.approvalRef === c.synthetic.approvalRef || inp.intentId === c.synthetic.intentId) refuse("HRC_INPUT_INVALID");
     const runId = env[RUN_ID_ENV] ?? "";
     if (mode !== "preflight") {
-      if (c.executeEnabled !== true || c.toolingStatus !== "MERGED" || !HEX64.test(String(c.closureDigest))) refuse("HRC_EXECUTE_CLOSED");   // Slice 4: refuses whenever the flag is false (CLOSED state); OPEN in this revision (C29)
+      if (c.executeEnabled !== true || c.toolingStatus !== "MERGED" || !HEX64.test(String(c.closureDigest))) refuse("HRC_EXECUTE_CLOSED");   // Slice 4: CLOSED (flag false; reopened only by a reviewed flag PR)
       if (!anyReal || !HEX64.test(expPlan) || !HEX64.test(expClo) || !HEX64.test(expRun)) refuse("HRC_INPUT_INCOMPLETE");
       if (!RUN_ID_RE.test(runId)) refuse("HRC_INPUT_INVALID");
       if (env.GITHUB_REF !== "refs/heads/main") refuse("HRC_REF_NOT_MAIN");
diff --git a/test/e7-hosted-charge-list-probe-workflow.test.mjs b/test/e7-hosted-charge-list-probe-workflow.test.mjs
index f0ec59d..36af716 100644
--- a/test/e7-hosted-charge-list-probe-workflow.test.mjs
+++ b/test/e7-hosted-charge-list-probe-workflow.test.mjs
@@ -128,11 +128,11 @@ test("W6 probe re-check block executed locally (BEFORE the one --probe call; no
   } finally { rmSync(d, { recursive: true, force: true }); }
 });
 
-test("W7 the five reviewed runners are untouched: the new workflow is in NO runner's runnerFiles, the shipped flags are [false, false, false, true, false] (C29: only Slice 4 recording OPEN), and the five runner digests (framedDigest over runnerFiles) are exactly the closed values (C24: recording / recorded-cleanup re-derived after the 4ed7a636 repin); the probe script and its test are byte-identical to the merged #95 (probe digest frame covers them)", async () => {
-  const want = { reservation: "5665544de105e4564a57a4434fa32fd2355b9bbd0e756b250d1248e07feb6b19", capture: "5b547a42200b452055d8a718c84ab70f7f2b5a0cd8343f6174c4a75b0c420ed1", "test-cleanup": "33f2ab18984dccd3915a18ff8a55dd4a6e5b6bf89e3d84ba1e578347e6cebd1e", recording: "47d2134e9bfd1971ccbd9b719cd34a3ed0f69fb5ce4d5bc91fa2d1789053423e", "recorded-cleanup": "278a9f4ff82180b276152bfc63fac94f6323777cfddf10c05fe450e9c2e470da" };   // C29 enable: recording (runner flag/comments + test) and recorded-cleanup (cross-runner test assertion) re-derived; other three unchanged
+test("W7 the five reviewed runners are untouched: the new workflow is in NO runner's runnerFiles, every runner still has executeEnabled false (all CLOSED again after the C29 run), and the five runner digests (framedDigest over runnerFiles) are exactly the closed values (C24: recording / recorded-cleanup re-derived after the 4ed7a636 repin); the probe script and its test are byte-identical to the merged #95 (probe digest frame covers them)", async () => {
+  const want = { reservation: "5665544de105e4564a57a4434fa32fd2355b9bbd0e756b250d1248e07feb6b19", capture: "5b547a42200b452055d8a718c84ab70f7f2b5a0cd8343f6174c4a75b0c420ed1", "test-cleanup": "33f2ab18984dccd3915a18ff8a55dd4a6e5b6bf89e3d84ba1e578347e6cebd1e", recording: "647b7808ac381b73d0ea3c5886a47b4f2e16d5ada5224eb1017227fbdb84fedc", "recorded-cleanup": "e9011de76a1737d50ebcf8277e66f8911bcdc888ddf7a620b19c89f9a4699dca" };   // C29 CLOSE: all five FALSE again; recording / recorded-cleanup re-derived
   for (const n of Object.keys(want)) {
     const m = await import(`../scripts/e7-hosted-${n}.mjs`);
-    assert.equal(m.CONSTANTS.executeEnabled, n === "recording", n); assert.ok(!m.CONSTANTS.runnerFiles.includes(WF), n);   // C29: recording OPEN for the ONE gated run; the other four FALSE
+    assert.equal(m.CONSTANTS.executeEnabled, false, n); assert.ok(!m.CONSTANTS.runnerFiles.includes(WF), n);
     assert.equal(await framedDigest(ROOT, m.CONSTANTS.runnerFiles, m.RUNNER_DIGEST_PREFIX), want[n], n);
   }
   assert.equal(P.PROBE_VERSION, "e7-hosted-charge-list-probe-v2");
diff --git a/test/e7-hosted-integrated-rehearsal.test.mjs b/test/e7-hosted-integrated-rehearsal.test.mjs
index bbff9fb..d9d2195 100644
--- a/test/e7-hosted-integrated-rehearsal.test.mjs
+++ b/test/e7-hosted-integrated-rehearsal.test.mjs
@@ -64,8 +64,8 @@ const enc = (o) => new TextEncoder().encode(JSON.stringify(o));
 const MINUTE = 60000; const DAY = 86400000;
 const REAL_WAIT_CAP_MS = 150000;                      // test-harness scheduling: REAL wait up to 150 s per sleep (covers the E7.1 two-minute read freshness window); longer → throw (see header)
 
-test("R0 the five runners declare the expected immutable tooling pins; shipped executeEnabled = [false, false, false, true, false] (C29: only Slice 4 recording OPEN; Slices 1–3 and 5 CLOSED). The rehearsal itself never reads the flag", () => {
-  assert.deepEqual(RUNNERS.map((r) => r.E.CONSTANTS.executeEnabled), [false, false, false, true, false]);   // C29: Slice 4 OPEN for the ONE reviewed gated TEST recording
+test("R0 the five runners declare the expected immutable tooling pins; shipped executeEnabled = all false again (Slices 1–5 CLOSED after the ONE reviewed gated TEST recording; C29 CLOSE). The rehearsal itself never reads the flag", () => {
+  assert.deepEqual(RUNNERS.map((r) => r.E.CONSTANTS.executeEnabled), [false, false, false, false, false]);   // all CLOSED again after the ONE reviewed gated TEST recording (C29 CLOSE)
   for (const r of RUNNERS) {
     assert.equal(r.E.CONSTANTS.toolingCommit, r.pin, r.name);
     assert.ok(Array.isArray(r.E.CONSTANTS.closure) && /^[0-9a-f]{64}$/.test(r.E.CONSTANTS.closureDigest), `${r.name} closure`);
diff --git a/test/e7-hosted-recorded-cleanup.test.mjs b/test/e7-hosted-recorded-cleanup.test.mjs
index 85415bf..d044173 100644
--- a/test/e7-hosted-recorded-cleanup.test.mjs
+++ b/test/e7-hosted-recorded-cleanup.test.mjs
@@ -603,7 +603,7 @@ test("A10 postcheck + readbacks + residual agreement: a mirror worker that claim
 });
 
 test("C1 code ceiling: Slice 5 recorded cleanup execution CLOSED (executeEnabled false) AND the Slice 1–4 runners CLOSED again on THEIR tooling pins (after the ONE reviewed owner-present TEST); this runner pins the MERGED e7-test e41b654a; the plan pins pi / reservation / Stripe charge / original offline charge / captured amount / stay / attempt / session and the accepted keys / titles / amount; ZERO capture / void / record / notify / create; the derived expectation is EXACTLY the accepted 18 keys", () => {
-  assert.equal(C.executeEnabled, false); for (const R of [RESRUN, CAPRUN, TCRUN]) assert.equal(R.CONSTANTS.executeEnabled, false); assert.equal(RCRUN.CONSTANTS.executeEnabled, true, "C29: Slice 4 recording is OPEN for the ONE reviewed gated TEST recording; this runner stays CLOSED");
+  assert.equal(C.executeEnabled, false); for (const R of [RESRUN, CAPRUN, TCRUN, RCRUN]) assert.equal(R.CONSTANTS.executeEnabled, false);
   assert.equal(C.toolingCommit, "e41b654a667cb0ba8775b5bd0040c28a3d14fda0"); assert.equal(C.toolingStatus, "MERGED");
   assert.equal(TCRUN.CONSTANTS.toolingCommit, "9d86bfa1e60779b3794de88bbae151670e8fe515", "the reviewed Slice 3 pin is untouched"); assert.equal(RCRUN.CONSTANTS.toolingCommit, "4ed7a636fee57981262b9c02574190d225b8a1fc", "C24: Slice 4 pins the merged C21-F1 fix (recording-only repin); this runner's own pin is untouched");
   assert.equal(CAPRUN.CONSTANTS.toolingCommit, "59178b0468469b6570beab861bbc8e48b3a887d1", "C2: Slice 2 pins the merged C1 fix; this runner's own pin is untouched");
diff --git a/test/e7-hosted-recording.test.mjs b/test/e7-hosted-recording.test.mjs
index 521cdb2..1463f04 100644
--- a/test/e7-hosted-recording.test.mjs
+++ b/test/e7-hosted-recording.test.mjs
@@ -509,8 +509,8 @@ test("F2 (ROOT 5883758657) honest statement accounting: reported dbQueries == EV
     assert.equal(r.dbQueries, pool.reads, "counted even when the residual read fails"); }
 });
 
-test("C1 code ceiling: Slice 4 recording execution OPEN for the ONE reviewed gated TEST recording (executeEnabled true; C29) AND Slice 1 / 2 / 3 CLOSED on THEIR tooling (after the ONE reviewed owner-present TEST); this runner pins the MERGED e7-test 5a094b16; the plan pins pi / reservation / charge / captured amount / stay / attempt / session, the accepted recording key, credit_card / hostaway-e7-test, title / amount wire forms = the accepted module's; ZERO stripe / capture / void / cancel / refund / notify / create", () => {
-  assert.equal(C.executeEnabled, true); assert.equal(RESRUN.CONSTANTS.executeEnabled, false); assert.equal(CAPRUN.CONSTANTS.executeEnabled, false); assert.equal(TCRUN.CONSTANTS.executeEnabled, false);
+test("C1 code ceiling: Slice 4 recording execution CLOSED again (executeEnabled false after the ONE reviewed gated TEST recording; C29 CLOSE) AND Slice 1 / 2 / 3 CLOSED on THEIR tooling (after the ONE reviewed owner-present TEST); this runner pins the MERGED e7-test 5a094b16; the plan pins pi / reservation / charge / captured amount / stay / attempt / session, the accepted recording key, credit_card / hostaway-e7-test, title / amount wire forms = the accepted module's; ZERO stripe / capture / void / cancel / refund / notify / create", () => {
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
@@ -577,11 +577,11 @@ test("H1 hosted: preflight (no secrets) passes on the pinned closure; the Stripe
   assert.equal((await E.runHosted({ mode: "nope", env: {}, proc: PROC, wrapperDir: ROOT })).result.code, "HRC_USAGE");
 });
 
-test("H2 hosted: verify / execute refuse HRC_EXECUTE_CLOSED under a test-local executeEnabled=false config (deps.constants seam) before any pin, ref or import check — the refusal path stays exercised while the shipped constant is OPEN (C29); the shipped constants still refuse off main / wrong digests / missing run id / secrets missing / wrong DB target, wipes secrets, and wires TWO pools (6543 max 3 worker, 5432 max 1 lock) with a Hostaway-only exchange", async () => {
+test("H2 hosted: verify / execute refuse HRC_EXECUTE_CLOSED under a test-local executeEnabled=false config (deps.constants seam) before any pin, ref or import check — the refusal path is exercised independently of the shipped constant (CLOSED again after C29); the shipped constants still refuse off main / wrong digests / missing run id / secrets missing / wrong DB target, wipes secrets, and wires TWO pools (6543 max 3 worker, 5432 max 1 lock) with a Hostaway-only exchange", async () => {
   const pre = await E.runHosted({ mode: "preflight", env: pick(envOf()), proc: PROC, wrapperDir: ROOT, deps: { spawnChild: okChild } });
   const plan = E.buildPlan(C, { ...planInput({ approvalRef: "label-1" }), runnerDigest: pre.result.runnerDigest });
   const full = (over = {}) => pick(envOf(realEnv({ E7_EXPECTED_PLAN_HASH: plan.planHash, E7_EXPECTED_CLOSURE_DIGEST: C.closureDigest, E7_EXPECTED_RUNNER_DIGEST: pre.result.runnerDigest, GITHUB_REF: "refs/heads/main", ...over })));
-  const CLOSED = { ...C, executeEnabled: false };   // test-local CLOSED control: the refusal path stays exercised while the shipped constant is OPEN (C29)
+  const CLOSED = { ...C, executeEnabled: false };   // test-local CLOSED control: valid in both shipped states (OPEN during the C29 run, CLOSED after)
   for (const mode of ["verify", "execute"]) {
     const r = await E.runHosted({ mode, env: full({ E7_TOOLING_DIR: "/nonexistent", GITHUB_REF: "refs/heads/other" }), proc: PROC, wrapperDir: ROOT, deps: { constants: CLOSED, importEnv: () => { throw new Error("never"); } } });
     assert.deepEqual([r.result.code, r.exitCode, r.result.closureDigest], ["HRC_EXECUTE_CLOSED", 1, null], mode);
```

## 6. Holds that stay in force
Policy decisions D-a / D-b / D-c undecided; no gate approval, dispatch, merge, provider / shared-DEV / dashboard / run inspection, operational INSERT, notification or inbox processing, money / booking / cancel / refund / void / cleanup / mirror action is part of this preparation. The fresh-proof requirements of proposal §2 (DB ≤ 10 min, Stripe raw ≤ 15 min at GO, Hostaway identity `new` + conflict-free LIST, bound planHash / digests / main SHA / run id) are prerequisites that ROOT gathers only after an owner decision.
