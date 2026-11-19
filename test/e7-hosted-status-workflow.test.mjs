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

test("W1 static (C122): workflow_dispatch + ONE bounded TEST schedule (:07 / :37) ONLY (no push / pull_request / workflow_run / repository_dispatch / workflow_call); inputs exactly mode (choice [preflight, status], default preflight) + two expected digests — no identifier / SQL / scope / threshold input; contents: read; serialised; the ONLY variable read is the arm PRESENCE in the status job's if (no digest check, no arm script, no E7_TEST_ARM)", () => {
  assert.match(yml, /^on:\n  schedule:\n    - cron: '7,37 \* \* \* \*'\n  workflow_dispatch:\n    inputs:\n      mode:\n/m);
  assert.equal(count(/cron:/g), 1);
  assert.doesNotMatch(code, /\n  (push|pull_request|pull_request_target|workflow_call|repository_dispatch|workflow_run):/);
  assert.match(yml, /      mode:\n(?:        .*\n)*?        type: choice\n        options: \[preflight, status\]\n        default: preflight\n/);
  assert.deepEqual([...yml.matchAll(/^      ([a-z_]+):\n        description/gm)].map((m) => m[1]), ["mode", "expected_source_digest", "expected_closure_digest"]);
  assert.match(yml, /\npermissions:\n  contents: read\n\n/); assert.equal(count(/permissions:/g), 1); assert.doesNotMatch(code, /: write|id-token:/);
  assert.match(yml, /\nconcurrency:\n  group: e7-hosted-status\n  cancel-in-progress: false\n/);
  assert.deepEqual([...yml.matchAll(/^  ([a-z-]+):\n    (?:needs|runs-on|if)/gm)].map((m) => m[1]), ["preflight", "status"]);
  assert.deepEqual([...S.CONSTANTS.runnerFiles], FILES);
  assert.deepEqual(code.match(/vars\.[A-Za-z0-9_]+[^)\n]*/g), ["vars.E7_TEST_AUTO_ARMED != ''"], "ONE variable read: the arm PRESENCE gate");
  assert.doesNotMatch(code, /E7_TEST_ARM:|e7-test-arm/, "no arm digest check (the runner stays outside the release)");
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

test("W3 static (C122): status job needs preflight AND main AND (manual mode == 'status' OR a schedule while the arm is PRESENT) AND the isolated EXISTING environment e7-test-auto (moved from e7-readonly-probe; the SAME existing secret NAME); order: checkouts → node → pre-secret re-check → runner verify (SHIPPED CLOSED refuses HERE) → npm ci → CA → the ONE status step LAST; the ONLY secret (existing NAME E7_DEV_BOOKING_DATABASE_URL) once, in that last step; no provider secret / token; no expression inside any run; every E7_* key admitted", () => {
  assert.match(jobs.status, /^\n  status:\n    needs: preflight\n    if: github\.ref == 'refs\/heads\/main' && \(\(github\.event_name == 'workflow_dispatch' && inputs\.mode == 'status'\) \|\| \(github\.event_name == 'schedule' && vars\.E7_TEST_AUTO_ARMED != ''\)\)\n    runs-on: ubuntu-24\.04\n    environment: e7-test-auto\n    timeout-minutes: 10\n/);
  // scheduled runs: the source digest = the preflight job's computation of the SAME commit (consistency, not an independent review binding); closure = the pinned literal
  assert.equal(count(/E7_EXPECTED_SOURCE_DIGEST: \$\{\{ github\.event_name == 'schedule' && needs\.preflight\.outputs\.source \|\| inputs\.expected_source_digest \}\}/g), 3);
  assert.equal(count(new RegExp(`E7_EXPECTED_CLOSURE_DIGEST: \\$\\{\\{ github\\.event_name == 'schedule' && '${S.CONSTANTS.closureDigest}' \\|\\| inputs\\.expected_closure_digest \\}\\}`, "g")), 3);
  assert.match(jobs.preflight, /\n    outputs:\n      source: \$\{\{ steps\.pf\.outputs\.source \}\}\n/);
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
  assert.equal(count(/e7-hosted-status\.mjs (verify|status)\n/g), 2); assert.equal(count(/e7-hosted-status\.mjs preflight > "\$RUNNER_TEMP\/pf\.json"\n/g), 1);
  assert.equal(S.CONSTANTS.readEnabled, true, "C122: opened (read-only); a CLOSED constant would refuse at verify before the secret step");
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

test("W5 the status runner is OUTSIDE the TEST arm release: the release recomputes (four components; its exact literal lives ONLY in the cross-runner regression X5 — C119 S4 moved the S3-era 12a8f416 pin out, so no status byte depends on the release); the status runner frame is in NO arm component and in no other runner's frame", async () => {
  const A = await import("../scripts/e7-test-arm.mjs");
  const r = await A.armRelease(ROOT);
  assert.equal(r.ok, true); assert.match(r.release, /^[0-9a-f]{64}$/);
  for (const f of FILES) assert.ok(!readFileSync(join(ROOT, f), "utf8").includes(r.release), `${f} carries no release literal`);
  assert.equal(Object.keys(r.frames).length, 4);
  const m = JSON.parse(readFileSync(join(ROOT, A.ARM_MANIFEST_PATH), "utf8"));
  for (const x of m.components) assert.ok(!x.files.some((f) => FILES.includes(f)), x.name);
  for (const f of ["e7-hosted-kickoff.mjs", "e7-hosted-booking-confirmation.mjs", "e7-hosted-pipeline.mjs", "e7-hosted-notify-inspect.mjs", "e7-hosted-tls-probe.mjs"]) {
    const X = await import(`../scripts/${f}`); const rf = X.CONSTANTS?.runnerFiles ?? X.RUNNER_FILES; assert.ok(!rf.some((g) => FILES.includes(g)), f);
  }
});

test("W6 C122 the preflight output block executed locally: it runs the runner's preflight (no secret / DB) and publishes ONLY a 64-hex source digest EQUAL to the runner's framedDigest; a refused / malformed preflight publishes nothing and fails", async () => {
  const want = await S.framedDigest(ROOT, FILES, S.SOURCE_DIGEST_PREFIX);
  const blk = runBlock("Preflight (runner; digests + layout; no environment, no secret, no database, no dependency install)");
  assert.doesNotMatch(blk, /E7_DEV_BOOKING_DATABASE_URL|secrets\.|\.mjs (verify|status)/);
  const d = sandbox(); try {
    const rt = mkdtempSync(join(tmpdir(), "e7-s3-rt-")); const out = join(rt, "out");
    const r = sh(blk, { E7_TOOLING_DIR: join(d, "tooling"), E7_WORKFLOW_SHA: headSha, RUNNER_TEMP: rt, GITHUB_OUTPUT: out }, d);
    assert.equal(r.status, 0, r.out); assert.equal(readFileSync(out, "utf8"), `source=${want}\n`);
    const out2 = join(rt, "out2");
    const bad = sh(blk, { E7_TOOLING_DIR: join(d, "nope"), E7_WORKFLOW_SHA: headSha, RUNNER_TEMP: rt, GITHUB_OUTPUT: out2 }, d);
    assert.notEqual(bad.status, 0); assert.throws(() => readFileSync(out2, "utf8"), "nothing published");
    rmSync(rt, { recursive: true, force: true });
  } finally { rmSync(d, { recursive: true, force: true }); }
});
