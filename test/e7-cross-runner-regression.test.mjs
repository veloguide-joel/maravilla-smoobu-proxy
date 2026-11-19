// test/e7-cross-runner-regression.test.mjs — C116: the ONE cross-runner regression, deliberately OUTSIDE every runtime source frame.
//
// Why it exists: main's pipeline workflow test (W7) and the kickoff workflow test (W8) used to pin the C50 booking-confirmation (notification)
// runner's exact source digest. Both files are inside runtime frames (the pipeline ENABLE frame is bound by the tooling PINNED_REVISION and by the
// 0024/0026 SQL claim literal; the notification runner pins the schema catalog that contains that literal), so any notification repin rewrote the
// pipeline frame → the SQL literal → the catalog → the notification frame: a cycle with no fixed point. The notification runner's exact digest /
// CLOSED assertions live HERE instead, with LITERAL reviewed expectations (never the current source as its own oracle).
//
// This file and its CI workflow (.github/workflows/e7-cross-runner-regression.yml) must never be listed in, imported by or read from any runtime
// frame — asserted below. Read-only: no network, no secret, no database, no provider, nothing installed.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { readFileSync, readdirSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const GUARD = { request: 0, fetch: 0 };
https.request = () => { GUARD.request += 1; throw new Error("network refused"); };
globalThis.fetch = async () => { GUARD.fetch += 1; throw new Error("network refused"); };
syncBuiltinESMExports();
after(() => assert.deepEqual(GUARD, { request: 0, fetch: 0 }, "no network primitive touched"));

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "test/e7-cross-runner-regression.test.mjs";
const WF = ".github/workflows/e7-cross-runner-regression.yml";

/** LITERAL reviewed expectations (update ONLY with a reviewed notification repin; never computed from the current files) */
const NOTIFICATION = Object.freeze({
  prefix: "e7-hosted-booking-confirmation-v1\n",
  runnerFiles: ["scripts/e7-hosted-booking-confirmation.mjs", "test/e7-hosted-booking-confirmation.test.mjs", "test/e7-hosted-booking-confirmation-workflow.test.mjs",
    ".github/workflows/e7-hosted-booking-confirmation.yml"],
  frame: "24fc31b4c1520c3725d17986c1377cec00145e8009df2f8c30001bfcd8a97e96"   // C121 STANDING TEST (DRAFT): + prospective cutoff 2026-11-19T00:00:00Z on detect AND admission (was 60a668f0… at C120d ENABLE). C120d ACTIVATION ENABLE (executeEnabled true; the CLOSE companion restores 5d0cf134…). C120 sink-probe env move: its workflow-test pins (sink 3e16037c / inspector 2950152a) (was a033a893…). C120: + the passive providerHttpStatus observation (was f969791b… at C119 S4). C119 S4: catalog 28 + e7-test-auto + P3 fresh admission (was ccb52e91… at S2). C119 S2: + the TEST arm re-check (labelled copy) + the arm job / draft schedule (was 9c6cf9f2… at S1 rev 2 / main 30d00191; 0cd953a9… at C116)
});

/** every runtime source frame on main: each runner's own runnerFiles, plus the fixed frames the workflow tests pin for the two probes */
async function runtimeFrames() {
  const frames = {};
  for (const f of readdirSync(join(ROOT, "scripts")).filter((x) => /^e7-hosted-.*\.mjs$/.test(x))) {
    const m = await import(`../scripts/${f}`); const rf = m.CONSTANTS?.runnerFiles ?? m.RUNNER_FILES;
    if (Array.isArray(rf)) frames[f] = [...rf];
    if (m.CONSTANTS?.pipeline?.runnerFiles) frames[`${f}#pipeline`] = [...m.CONSTANTS.pipeline.runnerFiles];
  }
  frames["charge-list-probe"] = ["scripts/e7-hosted-charge-list-probe.mjs", "test/e7-hosted-charge-list-probe.test.mjs", ".github/workflows/e7-hosted-charge-list-probe.yml"];
  frames["resend-sink-probe"] = ["scripts/e7-resend-sink-probe.mjs", "scripts/e7-resend/resend-exchange.mjs", "test/e7-resend-sink-probe.test.mjs", ".github/workflows/e7-resend-sink-probe.yml"];
  frames["delta-fixture"] = ["test/fixtures/e7-c102-pipeline-enable-delta.json"];
  return frames;
}

test("X1 the C50 notification runner (moved from pipeline W7 / kickoff W8): SHIPPED CLOSED and its exact frame equals the LITERAL reviewed digest", async () => {
  const N = await import("../scripts/e7-hosted-booking-confirmation.mjs");
  assert.equal(N.CONSTANTS.executeEnabled, true, "C120 ACTIVATION ENABLE (the CLOSE companion restores false / SHIPPED CLOSED)");
  assert.deepEqual([...N.CONSTANTS.runnerFiles], NOTIFICATION.runnerFiles);
  assert.equal(await N.framedDigest(ROOT, NOTIFICATION.runnerFiles, NOTIFICATION.prefix), NOTIFICATION.frame);
});

test("X2 one-byte mutation of ANY notification frame file is refused (the literal no longer matches)", async () => {
  const N = await import("../scripts/e7-hosted-booking-confirmation.mjs");
  for (const victim of NOTIFICATION.runnerFiles) {
    const d = mkdtempSync(join(tmpdir(), "e7-xr-"));
    try {
      for (const f of NOTIFICATION.runnerFiles) { mkdirSync(dirname(join(d, f)), { recursive: true }); writeFileSync(join(d, f), readFileSync(join(ROOT, f))); }
      assert.equal(await N.framedDigest(d, NOTIFICATION.runnerFiles, NOTIFICATION.prefix), NOTIFICATION.frame, "the copy reproduces the literal");
      writeFileSync(join(d, victim), Buffer.concat([readFileSync(join(ROOT, victim)), Buffer.from(" ")]));
      assert.notEqual(await N.framedDigest(d, NOTIFICATION.runnerFiles, NOTIFICATION.prefix), NOTIFICATION.frame, victim);
    } finally { rmSync(d, { recursive: true, force: true }); }
  }
});

test("X3 acyclic: this file and its workflow are in NO runtime frame, and no runtime frame file names them or carries the notification frame literal", async () => {
  const frames = await runtimeFrames(); assert.ok(Object.keys(frames).length >= 12, "every runner frame discovered");
  for (const [name, files] of Object.entries(frames)) {
    assert.ok(!files.includes(SELF) && !files.includes(WF), `${name} must not frame the cross-runner regression`);
    for (const f of files) {
      if (!existsSync(join(ROOT, f))) continue;
      const t = readFileSync(join(ROOT, f), "utf8");
      assert.doesNotMatch(t, /(?:\bimport\s*\(|\bfrom\s+|\brequire\s*\(|\breadFile(?:Sync)?\s*\(|\bcreateReadStream\s*\()[^\n;]*e7-cross-runner-regression/, `${name}: ${f} must not import / read the cross-runner regression`);
      assert.ok(!t.includes(NOTIFICATION.frame), `${name}: ${f} must not pin the notification frame (that recreates the C116 cycle)`);
    }
  }
  const pipe = frames["e7-hosted-pipeline.mjs"]; assert.ok(!pipe.some((f) => NOTIFICATION.runnerFiles.includes(f)), "the pipeline frame excludes the notification files");
});

test("X4 CI wiring: the regression runs on every pull request / push to main (and manually), read-only, no secrets / environment / install, reviewed action pins", () => {
  const y = readFileSync(join(ROOT, WF), "utf8");
  assert.match(y, /^on:\n  pull_request:\n  push:\n    branches: \[main\]\n  workflow_dispatch:\n/m);
  assert.match(y, /^permissions:\n  contents: read\n/m);
  assert.doesNotMatch(y, /secrets\.|environment:|npm (ci|install)|id-token|: *write\b/);
  assert.ok(y.includes("actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803") && y.includes("actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38"));
  assert.ok(y.includes("persist-credentials: false") && y.includes('node-version: "22.22.0"'));
  assert.ok(y.includes(`node --test ${SELF}`));
});

/** C119 S2: the LITERAL reviewed TEST-arm release of this tree (outside every component, so the release never embeds itself). It is NOT an
 *  arm and sets nothing: ROOT sets the repository variable out-of-band at a separately authorized activation, never from this file. */
// C121 STANDING TEST (DRAFT): b1d6bb63… (only the booking-confirmation frame changes vs 2dfceb27…; kickoff 47d309ce / pipeline 5294b6b4 / arm-gate 7af70f3e unchanged). C120d ACTIVATION ENABLE: 2dfceb27… (the CLOSE companion restores 9e14224d…). C120: 9e14224d… after the sink-probe env move pin cascade (kickoff + notification frames; was 9e87d5f2… after the passive providerHttpStatus; was 7a407d45… at C119 S4 after the pipeline admission cascade + the MERGED tooling repin)
const ARM_RELEASE = Object.freeze({ release: "b1d6bb6395205f59f4c6dc7a0629edc6b3c6aaada7a0415a155745a3b84822b6", components: ["arm-gate", "kickoff", "booking-confirmation", "pipeline"] });

test("X5 C119 S2 the TEST-arm release recomputed from this checkout equals the LITERAL reviewed release; this file is outside every arm component; no component file carries the release", async () => {
  const A = await import("../scripts/e7-test-arm.mjs");
  const r = await A.armRelease(ROOT); assert.equal(r.ok, true);
  assert.equal(r.release, ARM_RELEASE.release);
  const m = JSON.parse(readFileSync(join(ROOT, A.ARM_MANIFEST_PATH), "utf8"));
  assert.deepEqual(m.components.map((x) => x.name), ARM_RELEASE.components);
  for (const x of m.components) { assert.ok(!x.files.includes(SELF) && !x.files.includes(WF), x.name); for (const f of x.files) assert.ok(!readFileSync(join(ROOT, f), "utf8").includes(ARM_RELEASE.release), f); }
  assert.equal(r.frames["booking-confirmation"], NOTIFICATION.frame, "the release frames the reviewed notification runner bytes");
});

/** C119 S4: the FOREIGN runner digest literals MOVED here from the pipeline workflow test W7 (outside every runtime frame), checks unchanged */
const FOREIGN = Object.freeze({
  runners: { reservation: "5665544de105e4564a57a4434fa32fd2355b9bbd0e756b250d1248e07feb6b19", capture: "5b547a42200b452055d8a718c84ab70f7f2b5a0cd8343f6174c4a75b0c420ed1",
    "test-cleanup": "33f2ab18984dccd3915a18ff8a55dd4a6e5b6bf89e3d84ba1e578347e6cebd1e", recording: "49b5516cb69543a6bd4a697a407d2f2a97a84e18a63f18715338f099917e4824",
    "recorded-cleanup": "9e2021e3ec96bab16869fc194adac672287d559587b2cb7657738ffcd897de1f" },
  inspector: "2950152aac0c8d06a4bc48b32539d0ea0d7140c7a6c1dc3f949314f748452715",
  chargeList: "43715872ddb450889286880c848acefd8757da6fe33bc5c6a3a547bd27219cf3",
  resendSink: "3e16037c3b1a68f60dc32fcb4a2654abebd3a39f2dce55c9e860d91eb642ad42"
});

test("X6 C119 S4 (moved from pipeline W7, checks unchanged): the five reviewed runners SHIPPED CLOSED with their exact reviewed digests; the C47 inspection runner (889d6a31…) CLOSED + exact; the charge-list probe (43715872…) and the Resend sink probe (aef26da9…) exact; none of these literals appears in the (SQL-bound) pipeline frame", async () => {
  const P = await import("../scripts/e7-hosted-pipeline.mjs");
  for (const n of Object.keys(FOREIGN.runners)) {
    const m = await import(`../scripts/e7-hosted-${n}.mjs`);
    assert.equal(m.CONSTANTS.executeEnabled, false, n); assert.ok(!m.CONSTANTS.runnerFiles.some((f) => P.CONSTANTS.runnerFiles.includes(f)), n);
    assert.equal(await P.framedDigest(ROOT, m.CONSTANTS.runnerFiles, m.RUNNER_DIGEST_PREFIX), FOREIGN.runners[n], n);
  }
  const I = await import("../scripts/e7-hosted-notify-inspect.mjs");
  assert.equal(I.CONSTANTS.executeEnabled, false);
  assert.equal(await P.framedDigest(ROOT, I.CONSTANTS.runnerFiles, I.SOURCE_DIGEST_PREFIX), FOREIGN.inspector, "C47/C48 inspection runner unchanged");
  assert.equal(await P.framedDigest(ROOT, ["scripts/e7-hosted-charge-list-probe.mjs", "test/e7-hosted-charge-list-probe.test.mjs", ".github/workflows/e7-hosted-charge-list-probe.yml"], "e7-hosted-charge-list-probe-v1\n"), FOREIGN.chargeList);
  assert.equal(await P.framedDigest(ROOT, ["scripts/e7-resend-sink-probe.mjs", "scripts/e7-resend/resend-exchange.mjs", "test/e7-resend-sink-probe.test.mjs", ".github/workflows/e7-resend-sink-probe.yml"], "e7-resend-sink-probe-v1\n"), FOREIGN.resendSink);
  const lits = [...Object.values(FOREIGN.runners), FOREIGN.inspector, FOREIGN.chargeList, FOREIGN.resendSink];
  for (const f of P.CONSTANTS.runnerFiles) { const t = readFileSync(join(ROOT, f), "utf8"); for (const l of lits) assert.ok(!t.includes(l), `${f} carries ${l.slice(0, 8)}…`); }
});
