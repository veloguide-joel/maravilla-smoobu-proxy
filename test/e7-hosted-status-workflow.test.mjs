// test/e7-hosted-status-workflow.test.mjs — C119 S3: regression test for .github/workflows/e7-hosted-status.yml (SHIPPED CLOSED; MANUAL only). Static assertions
// on the workflow bytes + LOCAL execution of its pre-secret shell block (extracted from the YAML, run with bash against symlinked wrapper / tooling dirs).
// Also pins that S3 leaves the C119 S2 arm release, its manifest and every component frame byte-unchanged (the status runner is OUTSIDE the release).
// Zero network, zero secrets: the ONE status step is never executed here (only asserted).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, mkdtempSync, symlinkSync, rmSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const GUARD = { request: 0, fetch: 0 };
https.request = () => { GUARD.request += 1; throw new Error("network refused"); };
globalThis.fetch = async () => { GUARD.fetch += 1; throw new Error("network refused"); };
syncBuiltinESMExports();
after(() => { assert.deepEqual(GUARD, { request: 0, fetch: 0 }, "no real network primitive was touched"); });
const ROOT = realpathSync(join(dirname(fileURLToPath(import.meta.url)), ".."));
const TOOLING = realpathSync(process.env.E7_TOOLING_DIR || join(ROOT, "..", "tooling"));
const S = await import("../scripts/e7-hosted-status.mjs");
const WF = ".github/workflows/e7-hosted-status.yml";
const yml = readFileSync(join(ROOT, WF), "utf8");
const code = yml.replace(/^#.*\n/gm, "");
const count = (re) => (code.match(re) || []).length;
const PIN = "66133a22edca925e6386c4d178c251fa5f11c82e";
const FILES = ["scripts/e7-hosted-status.mjs", "test/e7-hosted-status.test.mjs", "test/e7-hosted-status-workflow.test.mjs", WF];
const jobs = { preflight: yml.slice(yml.indexOf("\n  preflight:\n"), yml.indexOf("\n  status:\n")), status: yml.slice(yml.indexOf("\n  status:\n")) };
const steps = (job) => [...job.matchAll(/\n      - name: ([^\n]+)/g)].map((m) => m[1]);
function runBlock(stepName) {
  const i = yml.indexOf(`- name: ${stepName}`); assert.ok(i >= 0, stepName);
  const m = yml.slice(i).match(/\n        run: \|\n((?:          .*\n)+)/); assert.ok(m); return m[1].split("\n").map((l) => l.replace(/^ {10}/, "")).join("\n");
}

test("W1 static: MANUAL workflow_dispatch ONLY (no schedule / push / pull_request / workflow_run / repository_dispatch / workflow_call — no activation wiring); inputs exactly mode (choice [preflight, status], default preflight) + two expected digests — no identifier / SQL / scope / threshold input; contents: read; serialised", () => {
  assert.match(yml, /^on:\n  workflow_dispatch:\n    inputs:\n      mode:\n/m);
  assert.doesNotMatch(code, /\n  (schedule|push|pull_request|pull_request_target|workflow_call|repository_dispatch|workflow_run):|cron:/);
  assert.match(yml, /      mode:\n(?:        .*\n)*?        type: choice\n        options: \[preflight, status\]\n        default: preflight\n/);
  assert.deepEqual([...yml.matchAll(/^      ([a-z_]+):\n        description/gm)].map((m) => m[1]), ["mode", "expected_source_digest", "expected_closure_digest"]);
  assert.match(yml, /\npermissions:\n  contents: read\n\n/); assert.equal(count(/permissions:/g), 1); assert.doesNotMatch(code, /: write|id-token:/);
  assert.match(yml, /\nconcurrency:\n  group: e7-hosted-status\n  cancel-in-progress: false\n/);
  assert.deepEqual([...yml.matchAll(/^  ([a-z-]+):\n    (?:needs|runs-on|if)/gm)].map((m) => m[1]), ["preflight", "status"]);
  assert.deepEqual([...S.CONSTANTS.runnerFiles], FILES);
  assert.doesNotMatch(code, /vars\.|E7_TEST_ARM|e7-test-arm/, "no arm wiring (future, separately reviewed)");
});

test("W2 static: exact-SHA wrapper + the tooling pin 66133a22 checkouts (persist-credentials false), the reviewed action pins (== the C50 workflow), Node 22.22.0; the preflight job has no environment / secret / npm / curl", () => {
  assert.equal(count(/ref: \$\{\{ github\.sha \}\}\n          path: wrapper\n          persist-credentials: false/g), 2);
  assert.equal(count(new RegExp(`repository: veloguide-joel/maravilla-smoobu-proxy\\n          ref: ${PIN}\\n          path: tooling\\n          persist-credentials: false`, "g")), 2);
  const n = readFileSync(join(ROOT, ".github/workflows/e7-hosted-booking-confirmation.yml"), "utf8");
  const pins = (s) => [...new Set([...s.matchAll(/uses: (actions\/[a-z-]+@[0-9a-f]{40})/g)].map((m) => m[1]))].sort();
  assert.deepEqual(pins(yml), pins(n)); assert.equal(count(/uses: /g), 6);
  assert.doesNotMatch(jobs.preflight, /environment:|secrets\.|npm |curl |E7_CA_FILE/);
  assert.equal(S.CONSTANTS.toolingCommit, PIN);
});

test("W3 static: status job needs preflight AND mode == 'status' && main AND the EXISTING environment e7-readonly-probe; order: checkouts → node → pre-secret re-check → runner verify (SHIPPED CLOSED refuses HERE) → npm ci → CA → the ONE status step LAST; the ONLY secret (existing NAME E7_DEV_BOOKING_DATABASE_URL) once, in that last step; no provider secret / token; no expression inside any run; every E7_* key admitted", () => {
  assert.match(jobs.status, /^\n  status:\n    needs: preflight\n    if: inputs\.mode == 'status' && github\.ref == 'refs\/heads\/main'\n    runs-on: ubuntu-24\.04\n    environment: e7-readonly-probe\n    timeout-minutes: 10\n/);
  assert.equal(count(/environment: /g), 1);
  assert.deepEqual(steps(jobs.status).map((s) => s.split(" (")[0]), ["Checkout wrapper", "Checkout merged E7 tooling", "Set up Node 22.22.0", "Re-check bindings BEFORE the secret", "Verify",
    "Install the pinned dependency from the verified lockfile", "Fetch the public Supabase CA", "ONE read-only status snapshot"]);
  assert.equal(count(/secrets\./g), 1);
  const last = yml.slice(yml.lastIndexOf("      - name: "));
  assert.match(last, /^      - name: ONE read-only status snapshot[^\n]*\n        env:\n(?:          [A-Z0-9_]+: [^\n]+\n)+        run: node wrapper\/scripts\/e7-hosted-status\.mjs status\n$/);
  assert.match(last, /          E7_DEV_BOOKING_DATABASE_URL: \$\{\{ secrets\.E7_DEV_BOOKING_DATABASE_URL \}\}\n        run:/);
  assert.doesNotMatch(yml, /E7_RESEND|E7_STRIPE|E7_HOSTAWAY|E7_DISPATCH_TOKEN|github\.token|api\.stripe\.com|api\.hostaway\.com/);
  for (const blk of yml.split(/\n      - name: /).slice(1)) { const r = blk.match(/\n        run: \|\n((?:          .*\n)+)|\n        run: (.*)\n/); if (r) assert.doesNotMatch(r[1] ?? r[2], /\$\{\{/); }
  for (const k of [...yml.matchAll(/^          (E7_[A-Z0-9_]+):/gm)].map((m) => m[1])) if (k !== "E7_TOOLING_PIN") assert.ok(S.ALLOWED_E7_KEYS.includes(k), k);
  assert.equal(count(/e7-hosted-status\.mjs (preflight|verify|status)\n/g), 3);
  assert.equal(S.CONSTANTS.readEnabled, false, "SHIPPED CLOSED: the verify step refuses STS_READ_CLOSED, so the secret step never runs");
});

const headSha = execFileSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
function sandbox() { const d = mkdtempSync(join(tmpdir(), "e7-s3-")); symlinkSync(ROOT, join(d, "wrapper")); symlinkSync(TOOLING, join(d, "tooling")); return d; }
function sh(block, env, cwd) { const r = spawnSync("bash", ["-c", block], { cwd, encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME ?? "/tmp", ...env } }); return { status: r.status, out: (r.stdout || "") + (r.stderr || "") }; }

test("W4 the pre-secret re-check block executed locally: passes only with HEAD == dispatch SHA, tooling == pin, two 64-hex digests and the expected source digest EQUAL to the documented frame (== the runner's framedDigest)", async () => {
  const want = await S.framedDigest(ROOT, FILES, S.SOURCE_DIGEST_PREFIX);
  const h = createHash("sha256"); h.update(S.SOURCE_DIGEST_PREFIX); for (const f of FILES) { const b = readFileSync(join(ROOT, f)); h.update(f); h.update(Buffer.from([0])); h.update(String(b.length)); h.update(Buffer.from([0])); h.update(b); h.update(Buffer.from([0])); }
  assert.equal(h.digest("hex"), want);
  const d = sandbox(); try {
    const blk = runBlock("Re-check bindings BEFORE the secret (HEAD == dispatch SHA; tooling pin; expected digests 64-hex; source digest)");
    assert.doesNotMatch(blk, /E7_DEV_BOOKING_DATABASE_URL|secrets\.|\.mjs status/);
    const base = { E7_WORKFLOW_SHA: headSha, E7_TOOLING_PIN: PIN, E7_EXPECTED_SOURCE_DIGEST: want, E7_EXPECTED_CLOSURE_DIGEST: S.CONSTANTS.closureDigest };
    const ok = sh(blk, base, d); assert.equal(ok.status, 0, ok.out);
    for (const [over, why] of [[{ E7_WORKFLOW_SHA: "0".repeat(40) }, /wrapper HEAD != dispatch SHA/], [{ E7_TOOLING_PIN: "1".repeat(40) }, /tooling HEAD != pin/], [{ E7_EXPECTED_CLOSURE_DIGEST: "" }, /not 64-hex/],
      [{ E7_EXPECTED_SOURCE_DIGEST: "f".repeat(64) }, /expected_source_digest mismatch/]]) {
      const r = sh(blk, { ...base, ...over }, d); assert.deepEqual([r.status, why.test(r.out)], [3, true], JSON.stringify(over));
    }
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("W5 S3 leaves the C119 S2 arm release EXACTLY as merged: release 12a8f416… (which binds the manifest + all four component frames); the status runner frame is in NO arm component and in no other runner's frame", async () => {
  const A = await import("../scripts/e7-test-arm.mjs");
  const r = await A.armRelease(ROOT);
  assert.deepEqual([r.ok, r.release], [true, "12a8f416b542bc2d6afc93d8925906df68d6b5efb6e47ac7ea32491e8ae7f3ed"]);
  // the release binds the manifest bytes + every component frame, so an unchanged release proves all of them unchanged (no frame literal pinned here:
  // the notification frame literal lives ONLY in the cross-runner regression, outside every runtime frame)
  assert.equal(Object.keys(r.frames).length, 4);
  const m = JSON.parse(readFileSync(join(ROOT, A.ARM_MANIFEST_PATH), "utf8"));
  for (const x of m.components) assert.ok(!x.files.some((f) => FILES.includes(f)), x.name);
  for (const f of ["e7-hosted-kickoff.mjs", "e7-hosted-booking-confirmation.mjs", "e7-hosted-pipeline.mjs", "e7-hosted-notify-inspect.mjs", "e7-hosted-tls-probe.mjs"]) {
    const X = await import(`../scripts/${f}`); const rf = X.CONSTANTS?.runnerFiles ?? X.RUNNER_FILES; assert.ok(!rf.some((g) => FILES.includes(g)), f);
  }
});
