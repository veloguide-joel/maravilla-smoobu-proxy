// test/e7-hosted-tls-probe-shallow.test.mjs — C112: regression for the hosted DEPTH-1 checkout layout of .github/workflows/e7-hosted-tls-probe.yml.
// NOT one of the probe's TEST_FILES (the hosted preflight never spawns it) and outside the probe source frame. It rebuilds the workflow layout
// exactly as actions/checkout does by default (fetch-depth 1, one commit, nothing installed): <ws>/wrapper = this repository at its committed
// HEAD, <ws>/tooling = the pinned tooling commit, then runs the REAL runner `node wrapper/scripts/e7-hosted-tls-probe.mjs preflight` with a
// sanitized environment. Every spawned test must PASS with ZERO skips. Zero network: file:// fetches of local repositories only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { realpathSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = realpathSync(join(dirname(fileURLToPath(import.meta.url)), ".."));
const TOOLING = realpathSync(process.env.E7_TOOLING_DIR || join(ROOT, "..", "tooling"));
const P = await import("../scripts/e7-hosted-tls-probe.mjs");
const K = await import("../scripts/e7-hosted-kickoff.mjs");
const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function shallow(dest, src, sha) {
  mkdirSync(dest, { recursive: true }); git(dest, "init", "-q");
  git(dest, "-c", "protocol.version=2", "fetch", "-q", "--depth", "1", `file://${src}`, sha); git(dest, "checkout", "-q", "FETCH_HEAD");
  assert.equal(git(dest, "rev-parse", "HEAD"), sha); assert.equal(git(dest, "rev-parse", "--is-shallow-repository"), "true");
  assert.equal(git(dest, "rev-list", "--count", "HEAD"), "1", "exactly one commit, no history");
  assert.equal(git(dest, "status", "--porcelain", "--ignored"), "", "exactly the committed tree, nothing installed");
}

test("S1 hosted depth-1 layout: the REAL probe preflight passes every spawned test with ZERO skips (no git history, nothing installed, sanitized env)", async () => {
  const head = git(ROOT, "rev-parse", "HEAD"); const pin = P.CONSTANTS.toolingCommit;
  assert.equal(git(TOOLING, "rev-parse", "HEAD"), pin, "E7_TOOLING_DIR is the pinned tooling commit");
  assert.equal(git(ROOT, "status", "--porcelain", "--", ...P.RUNNER_FILES), "", "the probe source files are committed (the shallow wrapper is HEAD)");
  const ws = mkdtempSync(join(tmpdir(), "htp-shallow-"));
  try {
    shallow(join(ws, "wrapper"), ROOT, head); shallow(join(ws, "tooling"), TOOLING, pin);
    const env = { PATH: process.env.PATH, HOME: ws, E7_TOOLING_DIR: join(ws, "tooling"), E7_WORKFLOW_SHA: head };
    const r = spawnSync(process.execPath, ["wrapper/scripts/e7-hosted-tls-probe.mjs", "preflight"], { cwd: ws, env, encoding: "utf8", timeout: 240000 });
    const line = (r.stdout || "").trim().split("\n").pop(); const out = JSON.parse(line);
    assert.equal(r.status, 0, line); assert.equal(out.code, "PREFLIGHT_OK");
    assert.equal(out.tests.fail, 0); assert.equal(out.tests.skipped, 0, "ZERO skips"); assert.equal(out.tests.pass, out.tests.tests); assert.ok(out.tests.tests >= 18);
    assert.equal(out.closureDigest, P.CONSTANTS.closureDigest);
    assert.equal(out.sourceDigest, await K.framedDigest(ROOT, P.RUNNER_FILES, P.SOURCE_PREFIX));
  } finally { rmSync(ws, { recursive: true, force: true }); }
});
