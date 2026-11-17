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
  frame: "58e9ac0be65b4f32bb9eae6c29afd630d274f97a9403724b9d6ebedaad5b69c4"   // C116: tooling 5ba7f793 (#180 draft head) + catalog 26 (was aff728cf on main)
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
  assert.equal(N.CONSTANTS.executeEnabled, false, "SHIPPED CLOSED");
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
