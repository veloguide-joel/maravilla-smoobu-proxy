# PR C4 — DRAFT ENABLE: Slice 1 reservation + Slice 2 capture `executeEnabled=true` (ONE reviewed C3 TEST capture validation)
2026-11-13 · Claude executor · DRAFT for independent ROOT review — **not merged**. Base: main `88dafa1116152d776a22be4956c161eb62936fc6` (tree `967eece7…`, review 5897252439). Implements exactly §2.2 of the merged C3 packet. Main stays all-FALSE until ROOT reviews and completes deployment / provider / database readiness checks. This PR authorizes nothing by itself: no merge, deploy, dispatch, shared query, provider, quote, Pay, checkout, keys or WSL action.

**Governing policy (Joel, 2026-11-13):** cancelling a reservation does NOT imply refunding, voiding or cancelling a payment; refunds are MANUAL and policy-assessed; no automated refunds, not even for TEST. Slices 3 and 5 (cleanup / void paths) remain CLOSED and HELD; Slice 4 remains CLOSED (D4). The old `capture_unknown` intent `c83c1842…` and its HELD claim are untouched.

## 1. Runtime change (the only one)
| File | Change |
|---|---|
| `scripts/e7-hosted-reservation.mjs` | `CONSTANTS.executeEnabled: false → true` + header/inline comments stating OPEN for ONE reviewed C3 validation, reversed by the CLOSE PR |
| `scripts/e7-hosted-capture.mjs` | same |
Untouched: workers, source closures, tooling pins (`40779e34` / `59178b04` / `9d86bfa1` / `5a094b16` / `e41b654a`), workflows, `e7-readonly-probe`, concurrency, schema, admission, budgets, secrets. `scripts/e7-hosted-test-cleanup.mjs`, `-recording.mjs`, `-recorded-cleanup.mjs` unchanged (`false`).

## 2. Test changes (expectations only; no assertion removed or commented)
| File | Change |
|---|---|
| `test/e7-hosted-reservation.test.mjs` | C1 ceiling `C.executeEnabled` → `true`; preflight positive `result.executeEnabled` → `true`; H2 title wording; test-local `CLOSED = { ...C, executeEnabled: false }` control retained and still asserts `HRS_EXECUTE_CLOSED` |
| `test/e7-hosted-capture.test.mjs` | C1 ceiling `C` + `RESRUN` → `true`; preflight positive → `true`; H2 title; `CLOSED` control retained (`HCP_EXECUTE_CLOSED`) |
| `test/e7-hosted-test-cleanup.test.mjs` | own flag stays `false`; cross-assertions RESRUN/CAPRUN → `true` |
| `test/e7-hosted-recording.test.mjs` | own `false`; RESRUN/CAPRUN → `true`; TCRUN stays `false` |
| `test/e7-hosted-recorded-cleanup.test.mjs` | own `false`; `[RESRUN, CAPRUN, TCRUN, RCRUN]` → `[true, true, false, false]` |
| `test/e7-hosted-integrated-rehearsal.test.mjs` | R0 shipped flags → `[true, true, false, false, false]` |
All digest / pin / closure assertions preserved verbatim (C1 pin assertions for 59178b04, TCRUN pin assertion restored in #85, R0 pins, N2 tampers).

## 3. Results — five focused suites at THEIR OWN pins + R0 (Node 22.22.0; `E7_TOOLING_DIR=/tmp/reh/<pin>`)
| Suite | Pin | Result |
|---|---|---|
| `test/e7-hosted-reservation.test.mjs` | 40779e34 | 20/20 |
| `test/e7-hosted-capture.test.mjs` | 59178b04 | 15/15 |
| `test/e7-hosted-test-cleanup.test.mjs` | 9d86bfa1 | 20/20 |
| `test/e7-hosted-recording.test.mjs` | 5a094b16 | 19/19 |
| `test/e7-hosted-recorded-cleanup.test.mjs` | e41b654a | 16/16 |
| `test/e7-hosted-integrated-rehearsal.test.mjs` (R0; DB rehearsal not repeated — flag-only change, proven at #79) | — | 1/1 |
| **Total** | | **91/91** |

## 4. Digests (derived with the runner's own `runnerFiles` rule, `/tmp/reh/rdig.mjs`)
| Runner | runnerDigest @ main 88dafa11 (all false) | **runnerDigest @ this PR head** | closureDigest (unchanged) |
|---|---|---|---|
| reservation (S1) | `5665544de105e4564a57a4434fa32fd2355b9bbd0e756b250d1248e07feb6b19` | **`a3e0994d0171ddf60d379704a7f1928f947ff8ae5deff631e4e92601f83f0bbe`** | `0ffc0b9c84fc83ca8de663ea0a88f90b1fa40bfba1a65498e311309b3ac4b631` |
| capture (S2) | `5b547a42200b452055d8a718c84ab70f7f2b5a0cd8343f6174c4a75b0c420ed1` | **`0b83183bf87a718b30e7b53b8c90d6019d20f5200e0ea90ae98771966f4eae16`** | `adaed04409012a233abcfb0a7aa748c0f8bc9e21afbd4e13adb94c064a97fd8f` |
| test-cleanup (S3, false) | `33f2ab18984dccd3915a18ff8a55dd4a6e5b6bf89e3d84ba1e578347e6cebd1e` | `970ee68056d8319a3f33a32d38a3806c3d217a5d81f7744f76f05e494979e213` | `f84b4157d88c4d4a3756c61040daa30e19323d7ba17b75a7764b0b22b3740ee7` |
| recording (S4, false) | `dafcc415dd2a5b2bfcfa163bcf2c116d99e82c83ee8611353bd1cd395252b683` | `e06df94f8bc2d683b2b8a236bfb466c70926eed5a607c2b89ede3d53c8206bbf` | `ef9341dc16d0fc112203ce7dd074bbdece846821c33cdd8b26186eaa415e2358` |
| recorded-cleanup (S5, false) | `3e0eba4204d7dc8c688d8ddeb2afc0d057fe31b99258848b2538934e4c685d16` | `2f0cca2cf077ce9976f5426824b14a24ee877527bdabd06e051b07261738cb24` | `85c72bf661a7ad52b690227642c85a6f73d32639352c91d9f06fe02ccf72bee4` |
All five runner digests change because Slices 2–5 include the shared reservation runner in their `runnerFiles` and each suite file is part of its runner's digest. The baseline column was re-derived from a detached checkout of `88dafa11` and equals the previously pinned values. ROOT re-pins `expected_runner_digest` for S1/S2 from the **merged** enable commit (this PR's head digest is valid only if merged without further change; a squash/rebase that alters any `runnerFiles` content changes it — re-derive after merge).

## 5. Prepared CLOSE patch (reverses ONLY the runtime + test change; keeps this doc) — NOT applied
Derived as `git diff <C4 head>~1 -R -- scripts test`; `git apply --check` passes against the C4 head. sha256 `001e0075bd93e405c4b27467e782505c7c316d7631b9c3ebaadd4d7c7564e7af`. To be opened as its own DRAFT PR after the validation (as #82 was), never applied to main by Claude.
```diff
diff --git b/scripts/e7-hosted-capture.mjs a/scripts/e7-hosted-capture.mjs
index 481823c..86f2a69 100644
--- b/scripts/e7-hosted-capture.mjs
+++ a/scripts/e7-hosted-capture.mjs
@@ -5,8 +5,7 @@
 // HONEST LABEL: MANUAL hosted TEST processing (workflow_dispatch + the existing reviewer gate), NOT automatic customer checkout.
 // `payment_captured` is an INTERMEDIATE state: nothing is recorded (Hostaway offline charge) or notified by this runner; the recording row the
 // accepted state machine queues is reported PRISTINE and never dispatched. publicStatus is NOT changed here (alignment issue retained for
-// customer acceptance). Code is NOT consent: executeEnabled is OPEN here (and in the reservation runner) for ONE reviewed C3 TEST capture validation
-// only; Slices 3-5 stay CLOSED; the prepared CLOSE PR reverses both flags to false immediately after.
+// customer acceptance). Code is NOT consent: executeEnabled is CLOSED here, and the reservation runner's execution stays CLOSED too.
 //   * Inert on import (`import.meta.main` guard): no env / fs / network / DB / timer until a mode runs.
 //   * Smallest delta over the reviewed Slice 1 runner: the hosted boot / pinning / session-lock (5432) / stop / teardown patterns are REUSED
 //     (pure helpers imported from ./e7-hosted-reservation.mjs; the lock / fence / step / teardown sections are LABELLED COPIES of its reviewed
@@ -33,7 +32,7 @@ import { CONSTANTS as RES, canonical, framedDigest, childEnv, spawnNode, dbTarge
 export const CONSTANTS = Object.freeze({
   toolingCommit: "59178b0468469b6570beab861bbc8e48b3a887d1",                                  // C2 (2026-11-13): Slice 2 repinned to the MERGED e7-test C1 fix (#84, omits final_capture); DISTINCT from Slice 1 (40779e34)
   toolingStatus: "MERGED",
-  executeEnabled: true,                                    // Slice 2: OPEN for ONE reviewed C3 TEST capture validation (ROOT review 5897252439; C4 enable PR); CLOSE PR reverses this to false
+  executeEnabled: false,                                   // Slice 2: capture execution default CLOSED (verify / execute refuse HCP_EXECUTE_CLOSED)
   // the Slice 1 closure PATH SET + the accepted capture worker, at THIS runner's own pin 59178b04 (test C2 recomputes the set from an INDEPENDENT import scan
   // of the pinned tree — the set is unchanged by C1; the BYTES of capture-proof.js / executor-adapters.mjs / http-transports.mjs changed, hence the new digest)
   closure: Object.freeze([...RES.closure, "lib/booking-db/capture-worker.js"].sort()),
diff --git b/scripts/e7-hosted-reservation.mjs a/scripts/e7-hosted-reservation.mjs
index f7c72e3..9c7a90e 100644
--- b/scripts/e7-hosted-reservation.mjs
+++ a/scripts/e7-hosted-reservation.mjs
@@ -3,8 +3,7 @@
 //
 // HONEST LABEL: this is MANUAL hosted TEST processing (workflow_dispatch + the existing reviewer gate), NOT automatic customer checkout.
 // `reservation_confirmed` is an INTERMEDIATE state: nothing is captured, recorded or notified by this runner; a capture row may be
-// QUEUED PRISTINE by the accepted state machine and is reported, never dispatched. Code is NOT consent; executeEnabled is OPEN here for ONE reviewed
-// C3 TEST capture validation (reservation + capture only) and is reversed to CLOSED by the prepared CLOSE PR immediately after.
+// QUEUED PRISTINE by the accepted state machine and is reported, never dispatched. Code is NOT consent; executeEnabled is CLOSED here.
 //   * Inert on import (`import.meta.main` guard): no env / fs / network / DB / timer until a mode runs.
 //   * Reuses the accepted lineage at ONE fixed tooling commit (checked out separately): runOrchestratorStep (E7.2 + PR56), createPhaseExecutors
 //     ('reservation' | 'reservation-recovery'), createE7HostawaySend / createE7StripeTestSend / createE7RealExchange, pool, repo.loadIntent,
@@ -31,7 +30,7 @@ export const CONSTANTS = Object.freeze({
   // the MERGED e7-test integration head (PR58–63; tree 004316db) — immutable tooling for this runner
   toolingCommit: "40779e34e8c65ac5c4494bc5a18cd4223ef723fa",
   toolingStatus: "MERGED",
-  executeEnabled: true,                                    // Slice 1: OPEN for ONE reviewed C3 TEST capture validation (ROOT review 5897252439; C4 enable PR); CLOSE PR reverses this to false
+  executeEnabled: false,                                   // Slice 1: execution default CLOSED (verify / execute refuse ATC_EXECUTE_CLOSED)
   closure: Object.freeze(["package.json", "package-lock.json", "lib/bookability.js", "lib/booking-db/codec.js", "lib/booking-db/config.js",
     "lib/booking-db/operations.js", "lib/booking-db/pool.js", "lib/booking-db/recovery.js", "lib/booking-db/repo.js",
     "lib/booking-db/reservation-worker.js", "lib/checkout/capture-proof.js", "lib/checkout/compensation-proof.js", "lib/checkout/final-price.js",
diff --git b/test/e7-hosted-capture.test.mjs a/test/e7-hosted-capture.test.mjs
index 1e2b499..bc08eaa 100644
--- b/test/e7-hosted-capture.test.mjs
+++ a/test/e7-hosted-capture.test.mjs
@@ -319,8 +319,8 @@ test("A9 postcheck + residual agreement: a worker that claims payment_captured w
     assert.deepEqual([r.outcome, r.code, r.lock, w.lockReleased, r.finalState, r.chargeId, r.recordingQueuedPristine], ["NOT_CONFIRMED", "UNLOCK_NOT_PROVEN", "unlock_failed_connection_destroyed", "destroyed", "payment_captured", CH, true], JSON.stringify(r)); }
 });
 
-test("C1 code ceiling: Slice 2 capture execution OPEN (executeEnabled true) AND the Slice 1 reservation runner OPEN — the ONE reviewed C3 TEST capture validation (C4 enable PR); Slice 2 pins the MERGED e7-test C1 fix 59178b04 (DISTINCT from Slice 1's immutable 40779e34); plan pins pi / reservation / amount / accepted key and ZERO refund / record / notify / cancel / void / create", () => {
-  assert.equal(C.executeEnabled, true); assert.equal(RESRUN.CONSTANTS.executeEnabled, true);
+test("C1 code ceiling: Slice 2 capture execution CLOSED (executeEnabled false) AND the Slice 1 reservation runner CLOSED; Slice 2 pins the MERGED e7-test C1 fix 59178b04 (DISTINCT from Slice 1's immutable 40779e34); plan pins pi / reservation / amount / accepted key and ZERO refund / record / notify / cancel / void / create", () => {
+  assert.equal(C.executeEnabled, false); assert.equal(RESRUN.CONSTANTS.executeEnabled, false);
   assert.equal(C.toolingCommit, "59178b0468469b6570beab861bbc8e48b3a887d1"); assert.equal(C.toolingStatus, "MERGED");
   assert.equal(RESRUN.CONSTANTS.toolingCommit, "40779e34e8c65ac5c4494bc5a18cd4223ef723fa", "Slice 1 keeps its own immutable pin"); assert.notEqual(C.toolingCommit, RESRUN.CONSTANTS.toolingCommit, "C2: distinct pins");
   const p = plan(); assert.deepEqual(p.writes, { captureMax: 1, hostawayCreate: 0, refund: 0, record: 0, notify: 0, cancel: 0, void: 0, account: 0, keys: 0 });
@@ -352,7 +352,7 @@ const realEnv = (over = {}) => ({ E7_TOOLING_DIR: TOOLING, E7_APPROVAL_REF: "lab
 
 test("H1 hosted: preflight (no secrets) passes on the pinned closure; any secret outside execute is refused; partial / invalid inputs refused; the runner digest covers the imported Slice 1 runner", async () => {
   let x = await E.runHosted({ mode: "preflight", env: { E7_TOOLING_DIR: TOOLING }, proc: PROC, wrapperDir: ROOT, deps: { spawnChild: okChild } });
-  assert.deepEqual([x.exitCode, x.result.code, x.result.planKind, x.result.closureDigest, x.result.executeEnabled, x.result.schema], [0, "PREFLIGHT_OK_SYNTHETIC_ONLY", "SYNTHETIC", C.closureDigest, true, "e7-hosted-capture-hosted-v1"], JSON.stringify(x.result));
+  assert.deepEqual([x.exitCode, x.result.code, x.result.planKind, x.result.closureDigest, x.result.executeEnabled, x.result.schema], [0, "PREFLIGHT_OK_SYNTHETIC_ONLY", "SYNTHETIC", C.closureDigest, false, "e7-hosted-capture-hosted-v1"], JSON.stringify(x.result));
   assert.equal(x.result.runnerDigest, await RESRUN.framedDigest(ROOT, C.runnerFiles, E.RUNNER_DIGEST_PREFIX)); assert.ok(C.runnerFiles.includes("scripts/e7-hosted-reservation.mjs"));
   x = await E.runHosted({ mode: "preflight", env: realEnv(), proc: PROC, wrapperDir: ROOT, deps: { spawnChild: okChild } });
   assert.deepEqual([x.exitCode, x.result.code, x.result.planKind], [0, "PREFLIGHT_OK_REAL_PLAN", "REAL"]);
@@ -367,7 +367,7 @@ test("H1 hosted: preflight (no secrets) passes on the pinned closure; any secret
   assert.equal(bad.result.code, "HCP_TESTS_FAILED");
 });
 
-test("H2 hosted: verify / execute refuse HCP_EXECUTE_CLOSED under a test-local executeEnabled=false config before any pin, ref or import check (the shipped constant is OPEN for the C3 validation; the test-local control keeps the refusal path exercised in either state); an opened constants seam still refuses off main / wrong digests / secrets missing / wrong DB target, and wires TWO pools (6543 max 3 worker, 5432 max 1 lock)", async () => {
+test("H2 hosted: verify / execute refuse HCP_EXECUTE_CLOSED under a test-local executeEnabled=false config before any pin, ref or import check (the shipped constant is CLOSED again; the test-local control is kept so the refusal path is exercised in either state); an opened constants seam still refuses off main / wrong digests / secrets missing / wrong DB target, and wires TWO pools (6543 max 3 worker, 5432 max 1 lock)", async () => {
   const CLOSED = { ...C, executeEnabled: false };   // test-local CLOSED control: the refusal path stays exercised while the shipped constant is OPEN
   const x = await E.runHosted({ mode: "verify", env: { ...realEnv(), E7_EXPECTED_PLAN_HASH: "0".repeat(64), E7_EXPECTED_CLOSURE_DIGEST: C.closureDigest, E7_EXPECTED_RUNNER_DIGEST: "0".repeat(64), GITHUB_REF: "refs/heads/main" }, proc: PROC, wrapperDir: ROOT, deps: { constants: CLOSED } });
   assert.deepEqual([x.exitCode, x.result.code, x.result.closureDigest], [1, "HCP_EXECUTE_CLOSED", null]);
diff --git b/test/e7-hosted-integrated-rehearsal.test.mjs a/test/e7-hosted-integrated-rehearsal.test.mjs
index a893850..70f1cab 100644
--- b/test/e7-hosted-integrated-rehearsal.test.mjs
+++ a/test/e7-hosted-integrated-rehearsal.test.mjs
@@ -64,8 +64,8 @@ const enc = (o) => new TextEncoder().encode(JSON.stringify(o));
 const MINUTE = 60000; const DAY = 86400000;
 const REAL_WAIT_CAP_MS = 150000;                      // test-harness scheduling: REAL wait up to 150 s per sleep (covers the E7.1 two-minute read freshness window); longer → throw (see header)
 
-test("R0 the five runners declare the expected immutable tooling pins; shipped executeEnabled = [true, true, false, false, false] (Slices 1 + 2 OPEN for the ONE reviewed C3 TEST capture validation; 3–5 CLOSED). The rehearsal itself never reads the flag", () => {
-  assert.deepEqual(RUNNERS.map((r) => r.E.CONSTANTS.executeEnabled), [true, true, false, false, false]);
+test("R0 the five runners declare the expected immutable tooling pins; shipped executeEnabled = all false again (Slices 1–3 CLOSED after the ONE reviewed owner-present TEST). The rehearsal itself never reads the flag", () => {
+  assert.deepEqual(RUNNERS.map((r) => r.E.CONSTANTS.executeEnabled), [false, false, false, false, false]);
   for (const r of RUNNERS) {
     assert.equal(r.E.CONSTANTS.toolingCommit, r.pin, r.name);
     assert.ok(Array.isArray(r.E.CONSTANTS.closure) && /^[0-9a-f]{64}$/.test(r.E.CONSTANTS.closureDigest), `${r.name} closure`);
diff --git b/test/e7-hosted-recorded-cleanup.test.mjs a/test/e7-hosted-recorded-cleanup.test.mjs
index 4ebdefc..da01e05 100644
--- b/test/e7-hosted-recorded-cleanup.test.mjs
+++ a/test/e7-hosted-recorded-cleanup.test.mjs
@@ -602,8 +602,8 @@ test("A10 postcheck + readbacks + residual agreement: a mirror worker that claim
     assert.deepEqual([r.outcome, r.code, posts(w), w.mirrorCalls], ["LINEAGE_MISMATCH", "MIRROR_ROW_NOT_BOUND", [CANCEL_URL, REFUND_URL], 0], JSON.stringify(r)); }
 });
 
-test("C1 code ceiling: Slice 5 recorded cleanup execution CLOSED (executeEnabled false), Slices 3 / 4 CLOSED, Slices 1 / 2 OPEN on THEIR tooling pins for the ONE reviewed C3 TEST capture validation; this runner pins the MERGED e7-test e41b654a; the plan pins pi / reservation / Stripe charge / original offline charge / captured amount / stay / attempt / session and the accepted keys / titles / amount; ZERO capture / void / record / notify / create; the derived expectation is EXACTLY the accepted 18 keys", () => {
-  assert.equal(C.executeEnabled, false); assert.deepEqual([RESRUN, CAPRUN, TCRUN, RCRUN].map((R) => R.CONSTANTS.executeEnabled), [true, true, false, false]);
+test("C1 code ceiling: Slice 5 recorded cleanup execution CLOSED (executeEnabled false) AND the Slice 1–4 runners CLOSED again on THEIR tooling pins (after the ONE reviewed owner-present TEST); this runner pins the MERGED e7-test e41b654a; the plan pins pi / reservation / Stripe charge / original offline charge / captured amount / stay / attempt / session and the accepted keys / titles / amount; ZERO capture / void / record / notify / create; the derived expectation is EXACTLY the accepted 18 keys", () => {
+  assert.equal(C.executeEnabled, false); for (const R of [RESRUN, CAPRUN, TCRUN, RCRUN]) assert.equal(R.CONSTANTS.executeEnabled, false);
   assert.equal(C.toolingCommit, "e41b654a667cb0ba8775b5bd0040c28a3d14fda0"); assert.equal(C.toolingStatus, "MERGED");
   assert.equal(TCRUN.CONSTANTS.toolingCommit, "9d86bfa1e60779b3794de88bbae151670e8fe515", "the reviewed Slice 3 pin is untouched"); assert.equal(RCRUN.CONSTANTS.toolingCommit, "5a094b16c1f84690a738a98ab89140caa69c1e1f", "the reviewed Slice 4 pin is untouched");
   assert.equal(CAPRUN.CONSTANTS.toolingCommit, "59178b0468469b6570beab861bbc8e48b3a887d1", "C2: Slice 2 pins the merged C1 fix; this runner's own pin is untouched");
diff --git b/test/e7-hosted-recording.test.mjs a/test/e7-hosted-recording.test.mjs
index 0347334..4b8496c 100644
--- b/test/e7-hosted-recording.test.mjs
+++ a/test/e7-hosted-recording.test.mjs
@@ -433,8 +433,8 @@ test("F2 (ROOT 5883758657) honest statement accounting: reported dbQueries == EV
     assert.equal(r.dbQueries, pool.reads, "counted even when the residual read fails"); }
 });
 
-test("C1 code ceiling: Slice 4 recording execution CLOSED (executeEnabled false; D4 blocker), Slice 3 CLOSED (HELD), Slices 1 / 2 OPEN on THEIR tooling for the ONE reviewed C3 TEST capture validation; this runner pins the MERGED e7-test 5a094b16; the plan pins pi / reservation / charge / captured amount / stay / attempt / session, the accepted recording key, credit_card / hostaway-e7-test, title / amount wire forms = the accepted module's; ZERO stripe / capture / void / cancel / refund / notify / create", () => {
-  assert.equal(C.executeEnabled, false); assert.equal(RESRUN.CONSTANTS.executeEnabled, true); assert.equal(CAPRUN.CONSTANTS.executeEnabled, true); assert.equal(TCRUN.CONSTANTS.executeEnabled, false);
+test("C1 code ceiling: Slice 4 recording execution CLOSED (executeEnabled false; D4 blocker) AND Slice 1 / 2 / 3 CLOSED again on THEIR tooling (after the ONE reviewed owner-present TEST); this runner pins the MERGED e7-test 5a094b16; the plan pins pi / reservation / charge / captured amount / stay / attempt / session, the accepted recording key, credit_card / hostaway-e7-test, title / amount wire forms = the accepted module's; ZERO stripe / capture / void / cancel / refund / notify / create", () => {
+  assert.equal(C.executeEnabled, false); assert.equal(RESRUN.CONSTANTS.executeEnabled, false); assert.equal(CAPRUN.CONSTANTS.executeEnabled, false); assert.equal(TCRUN.CONSTANTS.executeEnabled, false);
   assert.equal(C.toolingCommit, "5a094b16c1f84690a738a98ab89140caa69c1e1f"); assert.equal(C.toolingStatus, "MERGED");
   // C2: Slice 2 is repinned to the merged C1 fix (59178b04); Slice 1 (40779e34) and Slice 3 (9d86bfa1) keep their own immutable pins
   assert.equal(RESRUN.CONSTANTS.toolingCommit, "40779e34e8c65ac5c4494bc5a18cd4223ef723fa");
diff --git b/test/e7-hosted-reservation.test.mjs a/test/e7-hosted-reservation.test.mjs
index 654c955..fbd974b 100644
--- b/test/e7-hosted-reservation.test.mjs
+++ a/test/e7-hosted-reservation.test.mjs
@@ -255,8 +255,8 @@ test("A9 postcheck agreement: a worker that claims confirmation while the captur
   assert.deepEqual([r.outcome, r.code], ["POSTCHECK_MISMATCH", "CAPTURE_NOT_PRISTINE"]);
 });
 
-test("C1 code ceiling: Slice 1 execution OPEN (executeEnabled true) for the ONE reviewed C3 TEST capture validation (C4 enable PR), tooling 40779e34 MERGED; plan pins exact scope and ZERO capture / refund / record / notify / cancel / void", () => {
-  assert.equal(C.executeEnabled, true); assert.equal(C.toolingCommit, "40779e34e8c65ac5c4494bc5a18cd4223ef723fa"); assert.equal(C.toolingStatus, "MERGED");
+test("C1 code ceiling: Slice 1 execution CLOSED again (executeEnabled false after the ONE reviewed owner-present hosted TEST), tooling 40779e34 MERGED; plan pins exact scope and ZERO capture / refund / record / notify / cancel / void", () => {
+  assert.equal(C.executeEnabled, false); assert.equal(C.toolingCommit, "40779e34e8c65ac5c4494bc5a18cd4223ef723fa"); assert.equal(C.toolingStatus, "MERGED");
   const p = plan(); assert.deepEqual(p.writes, { hostawayCreateMax: 1, capture: 0, refund: 0, record: 0, notify: 0, cancel: 0, void: 0, account: 0, keys: 0 });
   assert.deepEqual(plan({ admission: "pending", reservationId: RID }).writes.hostawayCreateMax, 0);
   for (const bad of [{ admission: "authorized", reservationId: RID }, { admission: "pending", reservationId: "" }, { admission: "pending", reservationId: C.protectedReservationIds[0] },
@@ -285,7 +285,7 @@ const realEnv = (over = {}) => ({ E7_TOOLING_DIR: TOOLING, E7_APPROVAL_REF: "lab
 
 test("H1 hosted: preflight (no secrets) passes on the pinned closure; any secret outside execute is refused; partial / invalid inputs refused", async () => {
   let x = await E.runHosted({ mode: "preflight", env: { E7_TOOLING_DIR: TOOLING }, proc: PROC, wrapperDir: ROOT, deps: { spawnChild: okChild } });
-  assert.deepEqual([x.exitCode, x.result.code, x.result.planKind, x.result.closureDigest, x.result.executeEnabled], [0, "PREFLIGHT_OK_SYNTHETIC_ONLY", "SYNTHETIC", C.closureDigest, true], JSON.stringify(x.result));
+  assert.deepEqual([x.exitCode, x.result.code, x.result.planKind, x.result.closureDigest, x.result.executeEnabled], [0, "PREFLIGHT_OK_SYNTHETIC_ONLY", "SYNTHETIC", C.closureDigest, false], JSON.stringify(x.result));
   x = await E.runHosted({ mode: "preflight", env: realEnv(), proc: PROC, wrapperDir: ROOT, deps: { spawnChild: okChild } });
   assert.deepEqual([x.exitCode, x.result.code, x.result.planKind], [0, "PREFLIGHT_OK_REAL_PLAN", "REAL"]);
   assert.equal(x.result.planHash, E.buildPlan(C, { approvalRef: "label-1", intentId: IID, expectedVersion: VER, notBefore: NB, admission: "authorized", reservationId: "", runnerDigest: x.result.runnerDigest }).planHash);
@@ -299,7 +299,7 @@ test("H1 hosted: preflight (no secrets) passes on the pinned closure; any secret
   assert.equal(bad.result.code, "HRS_TESTS_FAILED");
 });
 
-test("H2 hosted: verify / execute refuse HRS_EXECUTE_CLOSED under a test-local executeEnabled=false config before any pin, ref or import check (the shipped constant is OPEN for the C3 validation; the test-local control keeps the refusal path exercised in either state); an opened constants seam still refuses off main / wrong digests / secrets missing", async () => {
+test("H2 hosted: verify / execute refuse HRS_EXECUTE_CLOSED under a test-local executeEnabled=false config before any pin, ref or import check (the shipped constant is CLOSED again; the test-local control is kept so the refusal path is exercised in either state); an opened constants seam still refuses off main / wrong digests / secrets missing", async () => {
   const CLOSED = { ...C, executeEnabled: false };   // test-local CLOSED control: the refusal path stays exercised while the shipped constant is OPEN
   const x = await E.runHosted({ mode: "verify", env: { ...realEnv(), E7_EXPECTED_PLAN_HASH: "0".repeat(64), E7_EXPECTED_CLOSURE_DIGEST: C.closureDigest, E7_EXPECTED_RUNNER_DIGEST: "0".repeat(64), GITHUB_REF: "refs/heads/main" }, proc: PROC, wrapperDir: ROOT, deps: { constants: CLOSED } });
   assert.deepEqual([x.exitCode, x.result.code, x.result.closureDigest], [1, "HRS_EXECUTE_CLOSED", null]);
diff --git b/test/e7-hosted-test-cleanup.test.mjs a/test/e7-hosted-test-cleanup.test.mjs
index 3ac1e31..05df873 100644
--- b/test/e7-hosted-test-cleanup.test.mjs
+++ a/test/e7-hosted-test-cleanup.test.mjs
@@ -628,8 +628,8 @@ test("A10 postcheck + readbacks + residual agreement: a worker that claims cance
     assert.deepEqual([r.outcome, r.code, r.steps, r.cancelInvocations, r.refundInvocations, r.finalState], ["CLEANUP_ESCALATED", "OWNER_CASE", 1, 1, 0, "reconciliation_required"], JSON.stringify(r)); }
 });
 
-test("C1 code ceiling: Slice 3 cleanup execution CLOSED (executeEnabled false; HELD by policy) while the Slice 1 / Slice 2 runners are OPEN on THEIR own pins (40779e34 / 59178b04) for the ONE reviewed C3 TEST capture validation; this runner pins the MERGED e7-test 9d86bfa1; the plan pins pi / reservation / charge / captured amount / stay / attempt / session and the accepted refund key; ZERO capture / void / record / notify / create; the derived expectation is EXACTLY the accepted 17 keys", () => {
-  assert.equal(C.executeEnabled, false); assert.equal(RESRUN.CONSTANTS.executeEnabled, true); assert.equal(CAPRUN.CONSTANTS.executeEnabled, true);
+test("C1 code ceiling: Slice 3 cleanup execution CLOSED again (executeEnabled false) AND the Slice 1 / Slice 2 runners CLOSED on THEIR own pins (40779e34 / 59178b04) — after the ONE reviewed owner-present hosted TEST; this runner pins the MERGED e7-test 9d86bfa1; the plan pins pi / reservation / charge / captured amount / stay / attempt / session and the accepted refund key; ZERO capture / void / record / notify / create; the derived expectation is EXACTLY the accepted 17 keys", () => {
+  assert.equal(C.executeEnabled, false); assert.equal(RESRUN.CONSTANTS.executeEnabled, false); assert.equal(CAPRUN.CONSTANTS.executeEnabled, false);
   assert.equal(C.toolingCommit, "9d86bfa1e60779b3794de88bbae151670e8fe515"); assert.equal(C.toolingStatus, "MERGED");
   assert.equal(CAPRUN.CONSTANTS.toolingCommit, "59178b0468469b6570beab861bbc8e48b3a887d1", "C2: Slice 2 pins the merged C1 fix; this runner's own pin is untouched");
   const { plan, planHash } = built();
```

## 6. Not in this PR
PR #81 (page-integration test maintenance) is separate and not mixed in. No doc-only changes to other packets. No workflow input, environment or secret change.
