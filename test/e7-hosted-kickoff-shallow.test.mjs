// test/e7-hosted-kickoff-shallow.test.mjs — C112d: regression for the hosted DEPTH-1 checkout layout of .github/workflows/e7-hosted-kickoff.yml.
// NOT one of the runner's TEST_FILES (the hosted preflight never spawns it, so there is no recursion) and outside the kickoff source frame.
// It rebuilds the workflow layout in a disposable workspace exactly as actions/checkout does by default (fetch-depth 1, one commit, no history):
//   <ws>/wrapper = this repository at its committed HEAD, <ws>/tooling = the pinned tooling commit — both shallow, nothing installed —
// (main tracks its own node_modules; the e7-test tooling tracks none and nothing is installed),
// then runs the REAL runner (`node wrapper/scripts/e7-hosted-kickoff.mjs preflight`) with a sanitized environment, the way the preflight step does.
// The real spawn path (childEnv allowlist → node --test TEST_FILES) must report every test PASSED with ZERO skips (C112: H5 used to skip when the
// 9455bc9e objects were absent, and runHosted correctly refuses pass !== tests). Zero network: file:// fetches of local repositories only.
// Requires the working tree's runner files to be committed (the shallow wrapper is HEAD). Run: E7_TOOLING_DIR=<tooling checkout> node --test <this file>
import { test } from "node:test";
import assert from "node:assert/strict";
import { realpathSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = realpathSync(join(dirname(fileURLToPath(import.meta.url)), ".."));
const TOOLING = realpathSync(process.env.E7_TOOLING_DIR || join(ROOT, "..", "tooling"));
const R = await import("../scripts/e7-hosted-kickoff.mjs");
const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function shallow(dest, src, sha) {
  mkdirSync(dest, { recursive: true }); git(dest, "init", "-q");
  git(dest, "-c", "protocol.version=2", "fetch", "-q", "--depth", "1", `file://${src}`, sha); git(dest, "checkout", "-q", "FETCH_HEAD");
  assert.equal(git(dest, "rev-parse", "HEAD"), sha); assert.equal(git(dest, "rev-parse", "--is-shallow-repository"), "true");
  assert.equal(git(dest, "rev-list", "--count", "HEAD"), "1", "exactly one commit, no history");
  assert.equal(git(dest, "status", "--porcelain", "--ignored"), "", "exactly the committed tree: nothing installed (only node_modules the repository itself tracks, as in the hosted checkout)");
}

test("S1 hosted depth-1 layout: the REAL runner preflight passes every spawned test with ZERO skips (no git history, nothing installed, sanitized env); the 9455bc9e objects are absent", async () => {
  const head = git(ROOT, "rev-parse", "HEAD"); const pin = R.CONSTANTS.toolingCommit;
  assert.equal(git(TOOLING, "rev-parse", "HEAD"), pin, "E7_TOOLING_DIR is the pinned tooling commit");
  assert.equal(git(ROOT, "status", "--porcelain", "--", ...R.RUNNER_FILES, "test/fixtures"), "", "the runner files / fixtures are committed (the shallow wrapper is HEAD)");
  const ws = mkdtempSync(join(tmpdir(), "hko-shallow-"));
  try {
    shallow(join(ws, "wrapper"), ROOT, head); shallow(join(ws, "tooling"), TOOLING, pin);
    let has = true; try { git(join(ws, "wrapper"), "cat-file", "-e", "9455bc9ee15370b5321b7a04a96e893e9e80080b^{commit}"); } catch { has = false; }
    assert.equal(has, false, "the historical ENABLE commit is NOT available, exactly as in the hosted checkout");
    const env = { PATH: process.env.PATH, HOME: ws, E7_TOOLING_DIR: join(ws, "tooling"), E7_WORKFLOW_SHA: head };
    const r = spawnSync(process.execPath, ["wrapper/scripts/e7-hosted-kickoff.mjs", "preflight"], { cwd: ws, env, encoding: "utf8", timeout: 240000 });
    const line = (r.stdout || "").trim().split("\n").pop(); const out = JSON.parse(line);
    assert.equal(r.status, 0, line);
    assert.match(out.code, /^PREFLIGHT_OK_PIPELINE_(NOT_)?BOUND$/);
    assert.equal(out.tests.fail, 0); assert.equal(out.tests.skipped, 0, "ZERO skips"); assert.equal(out.tests.pass, out.tests.tests); assert.ok(out.tests.tests >= 22);
    assert.equal(out.closureDigest, R.CONSTANTS.closureDigest);
    assert.equal(out.sourceDigest, await R.framedDigest(ROOT, R.RUNNER_FILES, R.SOURCE_PREFIX));
    assert.equal(out.pipeline.bound, out.pipeline.sourceDigest === R.CONSTANTS.pipeline.sourceDigest);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});
