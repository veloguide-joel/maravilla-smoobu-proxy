// test/e7-hosted-kickoff-workflow.test.mjs — C111: regression test for .github/workflows/e7-hosted-kickoff.yml (SHIPPED CLOSED). LABELLED ADAPTATION of
// test/e7-hosted-pipeline-workflow.test.mjs. Static assertions on the workflow bytes (triggers, job permissions, the ONE job-scoped token, secret
// placement) + LOCAL execution of its gate shell blocks (extracted from the YAML, run with bash against symlinked wrapper / tooling dirs).
// Zero network, zero secrets: the ONE execute step is never executed here (only asserted); every real network primitive is a throwing guard.
// Also pins that main's eight tracked runners stay CLOSED and byte-unchanged and that no other frame contains a C111 file.
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

const GUARD = { request: 0, Agent: 0, fetch: 0 };
https.request = () => { GUARD.request += 1; throw new Error("network refused"); };
https.Agent = class { constructor() { GUARD.Agent += 1; throw new Error("network refused"); } };
globalThis.fetch = async () => { GUARD.fetch += 1; throw new Error("network refused"); };
syncBuiltinESMExports();
const ROOT = realpathSync(join(dirname(fileURLToPath(import.meta.url)), ".."));
const TOOLING = realpathSync(process.env.E7_TOOLING_DIR || join(ROOT, "..", "tooling"));
const R = await import("../scripts/e7-hosted-kickoff.mjs");
after(() => { assert.deepEqual(GUARD, { request: 0, Agent: 0, fetch: 0 }, "no real network primitive was touched"); });

const WF = ".github/workflows/e7-hosted-kickoff.yml";
const yml = readFileSync(join(ROOT, WF), "utf8");
const PIN = "66133a22edca925e6386c4d178c251fa5f11c82e";   // C116: e7-test #180 merge (was 4e79f266 #153)
const PIPE_PIN = "880db5b33024edbf0879fbaf5a3826e3622db12fd1808e8c2047238da507fe1b";   // C116 (was f09bcbbd)
const PREFIX = "e7-hosted-kickoff-v1\n";
const FILES = ["scripts/e7-hosted-kickoff.mjs", "test/e7-hosted-kickoff.test.mjs", "test/e7-hosted-kickoff-workflow.test.mjs", WF];
const code = yml.replace(/^#.*\n/gm, "");                      // counts ignore the header comment block
const count = (re) => (code.match(re) || []).length;
function runBlock(stepName) {
  const i = yml.indexOf(`- name: ${stepName}`); assert.ok(i >= 0, stepName);
  const rest = yml.slice(i); const m = rest.match(/\n        run: \|\n((?:          .*\n)+)/); assert.ok(m, `run block of ${stepName}`);
  return m[1].split("\n").map((l) => l.replace(/^ {10}/, "")).join("\n");
}
const jobs = { preflight: yml.slice(yml.indexOf("\n  preflight:\n"), yml.indexOf("\n  verify:\n")), verify: yml.slice(yml.indexOf("\n  verify:\n"), yml.indexOf("\n  detect:\n")),
  detect: yml.slice(yml.indexOf("\n  detect:\n"), yml.indexOf("\n  execute:\n")), execute: yml.slice(yml.indexOf("\n  execute:\n")) };
const steps = (job) => [...job.matchAll(/\n      - name: ([^\n]+)/g)].map((m) => m[1]);

test("W1 static: C115 triggers = ONE schedule (cron 13,43 * * * *) + workflow_dispatch ONLY (no webhook / repository_dispatch / push / workflow_run / pull_request); inputs exactly mode (choice, default preflight) + the five bindings + expected_source_digest — no contact / guest input; concurrency serialised", () => {
  assert.match(yml, /^on:\n  schedule:\n    - cron: '13,43 \* \* \* \*'\n  workflow_dispatch:\n    inputs:\n      mode:\n/m);
  assert.doesNotMatch(yml.replace(/^#.*$/gm, ""), /\n  (push|pull_request|pull_request_target|workflow_call|repository_dispatch|workflow_run|issue_comment):/);
  assert.equal((yml.replace(/^#.*$/gm, "").match(/cron:/g) || []).length, 1, "exactly ONE cron");
  assert.match(yml, /      mode:\n(?:        .*\n)*?        type: choice\n        options: \[preflight, verify, execute, detect\]\n        default: preflight\n/);
  assert.deepEqual([...yml.matchAll(/^      ([a-z_]+):\n        description/gm)].map((m) => m[1]),
    ["mode", "intent_id", "booking_ref", "expected_version", "payment_intent_id", "amount_minor", "expected_source_digest"]);
  assert.doesNotMatch(yml.slice(0, yml.indexOf("\npermissions:")).replace(/^#.*$/gm, ""), /recipient|sender|email|subject|guest_name|to_address|reservation_id|listing_id|token|sha:/i);
  assert.match(yml, /\nconcurrency:\n  group: e7-hosted-kickoff\n  cancel-in-progress: false\n/);
  assert.deepEqual([...yml.matchAll(/^  ([a-z-]+):\n    (?:needs|runs-on|if)/gm)].map((m) => m[1]), ["preflight", "verify", "detect", "execute"]);
  assert.equal((code.match(/\n  schedule:\n/g) || []).length, 1, "C115: exactly one schedule trigger");
  assert.deepEqual([...R.RUNNER_FILES], FILES);
});

test("W2 PERMISSIONS (for ROOT security review): workflow default contents: read; preflight + verify contents: read ONLY; ONLY the gated execute job adds `actions: write` (+ contents: read); no other write / id-token / PAT / App", () => {
  assert.match(yml, /\npermissions:\n  contents: read\n\nconcurrency:/);
  assert.match(jobs.preflight, /\n    permissions:\n      contents: read\n    steps:/); assert.doesNotMatch(jobs.preflight, /: write/);
  assert.match(jobs.verify, /\n    permissions:\n      contents: read\n    outputs:\n      open: \$\{\{ steps\.verify\.outputs\.open \}\}\n    steps:/); assert.doesNotMatch(jobs.verify, /: write/);
  assert.match(jobs.detect, /\n    permissions:\n      contents: read\n    outputs:\n/); assert.doesNotMatch(jobs.detect, /: write|github\.token|E7_DISPATCH_TOKEN/);
  assert.match(jobs.execute, /\n    permissions:\n      contents: read\n      actions: write\n    steps:/);
  assert.equal(count(/: write/g), 1, "exactly ONE write permission in the file"); assert.equal(count(/actions: write/g), 1);
  assert.doesNotMatch(yml, /id-token:|pull-requests:|packages:|deployments:|issues:|checks:|statuses:|contents: write|permissions: write-all|write-all/);
  assert.doesNotMatch(yml.replace(/^#.*$/gm, ""), /secrets\.GITHUB_TOKEN|secrets\.[A-Z_]*PAT|secrets\.[A-Z_]*APP|app-id|private-key|create-github-app-token/i);
});

test("W3 static: checkouts at the EXACT dispatch SHA + the tooling pin 66133a22 (persist-credentials false) in all three jobs; the reviewed action pins; Node 22.22.0; preflight / verify have no environment / secret / token / npm / curl", () => {
  assert.equal(count(/ref: \$\{\{ github\.sha \}\}\n          path: wrapper\n          persist-credentials: false/g), 4);
  assert.equal(count(new RegExp(`repository: veloguide-joel/maravilla-smoobu-proxy\\n          ref: ${PIN}\\n          path: tooling\\n          persist-credentials: false`, "g")), 4);
  assert.equal(count(/persist-credentials: false/g), 8); assert.doesNotMatch(yml, /ref: main|ref: refs\/heads|ref: \$\{\{ github\.ref/);
  const rec = readFileSync(join(ROOT, ".github/workflows/e7-hosted-pipeline.yml"), "utf8");
  const pins = (s) => [...new Set([...s.matchAll(/uses: (actions\/[a-z-]+@[0-9a-f]{40})/g)].map((m) => m[1]))].sort();
  assert.deepEqual(pins(yml), pins(rec)); assert.equal(count(/uses: /g), 12);
  assert.equal(count(/node-version: "22\.22\.0"\n          package-manager-cache: false/g), 4);
  for (const j of [jobs.preflight, jobs.verify]) assert.doesNotMatch(j, /environment:|secrets\.|github\.token|E7_DISPATCH_TOKEN|E7_DEV_BOOKING_DATABASE_URL|npm |curl |E7_CA_FILE/);
  assert.equal(R.CONSTANTS.toolingCommit, PIN); assert.equal(yml.split(`E7_TOOLING_PIN: ${PIN}`).length - 1, 3);
});

test("W4 static: execute needs [preflight, verify] AND mode == 'execute' && main AND environment e7-readonly-probe (the only environment); step order: checkouts → node → pre-secret re-check (incl. the pipeline release binding) → npm ci → CA fetch → the ONE execute step LAST", () => {
  assert.match(jobs.execute, /^\n  execute:\n    needs: \[preflight, verify, detect\]\n    if: \$\{\{ !cancelled\(\) && github\.ref == 'refs\/heads\/main' && needs\.preflight\.result == 'success' && needs\.verify\.result == 'success' && \(\(github\.event_name == 'workflow_dispatch' && inputs\.mode == 'execute' && needs\.detect\.result == 'skipped'\) \|\| \(\(inputs\.mode == 'detect' \|\| github\.event_name == 'schedule'\) && needs\.detect\.result == 'success' && needs\.detect\.outputs\.outcome == 'ONE'\)\) \}\}\n    runs-on: ubuntu-24\.04\n    environment: e7-readonly-probe\n    timeout-minutes: 10\n/);
  assert.match(jobs.verify, /^\n  verify:\n    needs: preflight\n    if: inputs\.mode == 'verify' \|\| inputs\.mode == 'execute' \|\| inputs\.mode == 'detect' \|\| github\.event_name == 'schedule'\n/);
  assert.match(jobs.detect, /^\n  detect:\n    needs: \[preflight, verify\]\n    if: \(inputs\.mode == 'detect' \|\| github\.event_name == 'schedule'\) && needs\.verify\.outputs\.open == 'true' && github\.ref == 'refs\/heads\/main'\n    runs-on: ubuntu-24\.04\n    environment: e7-readonly-probe\n    timeout-minutes: 10\n/);
  assert.equal(count(/environment: /g), 2, "two jobs, ONE environment name (two sequential approvals)"); assert.equal(count(/environment: e7-readonly-probe\n/g), 2);
  assert.doesNotMatch(code, /always\(\)/, "no unconditional always() path");
  assert.deepEqual(steps(jobs.execute).map((s) => s.split(" (")[0]), ["Checkout wrapper", "Checkout E7 kickoff tooling", "Set up Node 22.22.0", "Re-check bindings BEFORE any secret",
    "Install the pinned dependency from the verified lockfile", "Fetch the public Supabase CA", "ONE gated kickoff handoff"]);
  assert.deepEqual(steps(jobs.verify).map((s) => s.split(" (")[0]), ["Checkout wrapper", "Checkout E7 kickoff tooling", "Set up Node 22.22.0", "Verify"]);
  assert.deepEqual(steps(jobs.preflight).map((s) => s.split(" (")[0]), ["Checkout wrapper", "Checkout E7 kickoff tooling", "Set up Node 22.22.0", "Verify checkout bindings", "Preflight"]);
  assert.match(jobs.execute, /working-directory: tooling\n        run: npm ci --ignore-scripts --omit=dev --no-audit --no-fund\n/);
});

test("W5 static: the ONLY secret (existing NAME E7_DEV_BOOKING_DATABASE_URL) and the built-in job-scoped github.token (as E7_DISPATCH_TOKEN) appear exactly once each, in the env of the LAST execute step whose run is the one `execute` command; no expression inside any run; every E7_* env name is an admitted runner key", () => {
  assert.equal(count(/secrets\./g), 2); assert.equal(count(/\$\{\{ secrets\.E7_DEV_BOOKING_DATABASE_URL \}\}/g), 2);
  const lastDetect = jobs.detect.slice(jobs.detect.lastIndexOf("      - name: "));
  assert.match(lastDetect, /^      - name: ONE gated read-only detection[^\n]*\n        id: detect\n        env:\n(?:          [A-Z0-9_]+: [^\n]+\n)+        run: node wrapper\/scripts\/e7-hosted-kickoff\.mjs detect\n\n?$/);
  assert.match(lastDetect, /          E7_DEV_BOOKING_DATABASE_URL: \$\{\{ secrets\.E7_DEV_BOOKING_DATABASE_URL \}\}\n        run:/);
  assert.doesNotMatch(jobs.detect.slice(0, jobs.detect.lastIndexOf("      - name: ")), /secrets\./, "the DB secret only in the detect job's FINAL step");
  assert.equal(count(/github\.token/g), 1); assert.equal(count(/GITHUB_TOKEN/g), 0);
  const last = yml.slice(yml.lastIndexOf("      - name: "));
  assert.match(last, /^      - name: ONE gated kickoff handoff[^\n]*\n        env:\n(?:          [A-Z0-9_]+: [^\n]+\n)+        run: node wrapper\/scripts\/e7-hosted-kickoff\.mjs execute\n$/);
  assert.match(last, /          E7_INPUT_MODE: \$\{\{ github\.event_name == 'schedule' && 'detect' \|\| inputs\.mode \}\}\n          E7_EXPECTED_CANDIDATE_FINGERPRINT: \$\{\{ needs\.detect\.outputs\.fingerprint \}\}\n          E7_DEV_BOOKING_DATABASE_URL: \$\{\{ secrets\.E7_DEV_BOOKING_DATABASE_URL \}\}\n          E7_DISPATCH_TOKEN: \$\{\{ github\.token \}\}\n        run:/);
  assert.equal(count(/e7-hosted-kickoff\.mjs execute\n/g), 1); assert.equal(count(/e7-hosted-kickoff\.mjs detect\n/g), 1);
  assert.equal(count(/needs\.detect\.outputs\.fingerprint/g), 1, "the fingerprint reaches ONLY the execute step"); assert.equal(count(/e7-hosted-kickoff\.mjs verify\n/g), 1); assert.equal(count(/e7-hosted-kickoff\.mjs preflight\n/g), 1);
  assert.doesNotMatch(yml, /E7_STRIPE|E7_HOSTAWAY|RESEND|api\.stripe\.com|api\.hostaway\.com|E7_HKO_DB_TESTS/);
  for (const blk of yml.split(/\n      - name: /).slice(1)) { const r = blk.match(/\n        run: \|\n((?:          .*\n)+)|\n        run: (.*)\n/); if (r) assert.doesNotMatch(r[1] ?? r[2], /\$\{\{/, "no expression interpolation inside run"); }
  const envKeys = [...yml.matchAll(/^          (E7_[A-Z0-9_]+):/gm)].map((m) => m[1]);
  for (const k of envKeys) if (!["E7_TOOLING_PIN", "E7_MODE", "E7_PIPELINE_SOURCE_PIN"].includes(k)) assert.ok(R.ALLOWED_E7_KEYS.includes(k), `${k} is an admitted runner key`);
  assert.deepEqual([...R.SECRET_KEYS], ["E7_DEV_BOOKING_DATABASE_URL", "E7_DISPATCH_TOKEN"]);
  assert.equal(R.CONSTANTS.executeEnabled, true, "C112b ENABLE: verify proceeds to the bindings (the stacked CLOSE PR restores false)");
  assert.equal(R.CONSTANTS.dispatchEnabled, true);
});

// ---- LOCAL execution of the gate blocks ----------------------------------------------------------------------------------------------
const headSha = execFileSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const toolSha = execFileSync("git", ["-C", TOOLING, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
function sandbox() { const d = mkdtempSync(join(tmpdir(), "e7-c111-")); symlinkSync(ROOT, join(d, "wrapper")); symlinkSync(TOOLING, join(d, "tooling")); return d; }
function sh(block, env, cwd) {
  const r = spawnSync("bash", ["-c", block], { cwd, encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME ?? "/tmp", ...env } });
  return { status: r.status, out: (r.stdout || "") + (r.stderr || "") };
}
const expectedDigest = async () => {
  const h = createHash("sha256"); h.update(PREFIX);
  for (const f of FILES) { const b = readFileSync(join(ROOT, f)); h.update(f); h.update(Buffer.from([0])); h.update(String(b.length)); h.update(Buffer.from([0])); h.update(b); h.update(Buffer.from([0])); }
  const mine = h.digest("hex"); assert.equal(mine, await R.framedDigest(ROOT, FILES, PREFIX), "shell frame == the runner's framedDigest"); return mine;
};

test("W6 preflight bindings block executed locally: passes only with HEAD == dispatch SHA, tooling == pin and a known mode (C113: incl. detect — run 43929404455 refused it); unknown / empty modes refuse", () => {
  assert.equal(toolSha, PIN, "E7_TOOLING_DIR must be the pinned 66133a22 checkout");
  const d = sandbox(); try {
    const bind = runBlock("Verify checkout bindings (wrapper HEAD == dispatch SHA; tooling HEAD == pin; no secrets)");
    for (const mode of ["preflight", "verify", "execute", "detect"]) { const ok = sh(bind, { E7_WORKFLOW_SHA: headSha, E7_TOOLING_PIN: PIN, E7_MODE: mode }, d); assert.equal(ok.status, 0, ok.out); }
    for (const [env, why] of [[{ E7_WORKFLOW_SHA: "0".repeat(40), E7_TOOLING_PIN: PIN, E7_MODE: "preflight" }, /wrapper HEAD != dispatch SHA/],
      [{ E7_WORKFLOW_SHA: headSha, E7_TOOLING_PIN: "1".repeat(40), E7_MODE: "preflight" }, /tooling HEAD != pin/], [{ E7_WORKFLOW_SHA: headSha, E7_TOOLING_PIN: PIN, E7_MODE: "dispatch" }, /REFUSED: mode/],
      [{ E7_WORKFLOW_SHA: headSha, E7_TOOLING_PIN: PIN, E7_MODE: "" }, /REFUSED: mode/], [{ E7_WORKFLOW_SHA: headSha, E7_TOOLING_PIN: PIN, E7_MODE: "detect;true" }, /REFUSED: mode/]]) {
      const r = sh(bind, env, d); assert.deepEqual([r.status, why.test(r.out)], [3, true], r.out);
    }
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("W7 execute re-check block executed locally (BEFORE any secret): HEAD / tooling / 64-hex / own source digest, then the PIPELINE release binding — C112b: this main's ENABLE pipeline PASSES with the reviewed pin f09bcbbd; a stale pin (seam) is REFUSED; the shell frame equals the runner's pipelineBinding", async () => {
  const d = sandbox(); try {
    const blk = runBlock("Re-check bindings BEFORE any secret (HEAD == dispatch SHA; tooling pin; kickoff source digest; pipeline release binding 880db5b3)");
    assert.doesNotMatch(blk, /E7_DEV_BOOKING_DATABASE_URL|E7_DISPATCH_TOKEN|github\.token|\.mjs execute|secrets\./);
    assert.match(jobs.execute, new RegExp(`E7_PIPELINE_SOURCE_PIN: ${PIPE_PIN}\\n`)); assert.equal(R.CONSTANTS.pipeline.sourceDigest, PIPE_PIN);
    const want = await expectedDigest(); const pipe = await R.pipelineBinding(ROOT);
    const base = { E7_WORKFLOW_SHA: headSha, E7_TOOLING_PIN: PIN, E7_EXPECTED_SOURCE_DIGEST: want, E7_PIPELINE_SOURCE_PIN: PIPE_PIN };
    assert.equal(pipe.sourceDigest, PIPE_PIN, "C112b: this checkout's pipeline frames to the reviewed ENABLE source");
    const real = sh(blk, base, d);
    assert.equal(real.status, 0, real.out); assert.match(real.out, new RegExp(`bindings ok: wrapper=${headSha} tooling=${PIN} source=${want} pipeline=${PIPE_PIN}`));
    // LABELLED SEAM: a stale pin proves the refusal path of the same block (and that the shell frame == the runner's pipelineBinding)
    const stale = sh(blk, { ...base, E7_PIPELINE_SOURCE_PIN: "f".repeat(64) }, d);
    assert.deepEqual([stale.status, /pipeline at this commit is not the reviewed ENABLE source \(actual ([0-9a-f]{64})\)/.test(stale.out)], [3, true], stale.out);
    assert.match(stale.out, new RegExp(`actual ${pipe.sourceDigest}`), "the shell pipeline frame == the runner's pipelineBinding");
    for (const [over, why] of [[{ E7_WORKFLOW_SHA: "0".repeat(40) }, /wrapper HEAD != dispatch SHA/], [{ E7_TOOLING_PIN: "1".repeat(40) }, /tooling HEAD != pin/],
      [{ E7_EXPECTED_SOURCE_DIGEST: "" }, /not 64-hex/], [{ E7_EXPECTED_SOURCE_DIGEST: "f".repeat(64) }, /expected_source_digest mismatch/]]) {
      const r = sh(blk, { ...base, E7_PIPELINE_SOURCE_PIN: pipe.sourceDigest, ...over }, d); assert.deepEqual([r.status, why.test(r.out)], [3, true], JSON.stringify(over) + r.out);
    }
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("W8 C116 ENABLE A: the pipeline is EXACTLY the reviewed ENABLE source (executeEnabled TRUE, frame 880db5b3 = PIPE_PIN = the 0026 claim literal = tooling PINNED_REVISION); the six other tracked runners stay CLOSED and byte-unchanged (five reviewed runners, C47 inspection; the C50 booking-confirmation exact pin lives in the cross-runner regression); the new files are in no other frame", async () => {
  const P = await import("../scripts/e7-hosted-pipeline.mjs");
  assert.equal(P.CONSTANTS.executeEnabled, true, "pipeline (C102 ENABLE source restored)");
  assert.equal(await R.framedDigest(ROOT, P.CONSTANTS.runnerFiles, "e7-hosted-pipeline-v1\n"), PIPE_PIN, "the reviewed ENABLE pipeline source (880db5b3)");
  assert.ok(!P.CONSTANTS.runnerFiles.some((f) => FILES.includes(f)));
  const want = { reservation: "5665544de105e4564a57a4434fa32fd2355b9bbd0e756b250d1248e07feb6b19", capture: "5b547a42200b452055d8a718c84ab70f7f2b5a0cd8343f6174c4a75b0c420ed1",
    "test-cleanup": "33f2ab18984dccd3915a18ff8a55dd4a6e5b6bf89e3d84ba1e578347e6cebd1e", recording: "49b5516cb69543a6bd4a697a407d2f2a97a84e18a63f18715338f099917e4824",
    "recorded-cleanup": "9e2021e3ec96bab16869fc194adac672287d559587b2cb7657738ffcd897de1f" };
  for (const n of Object.keys(want)) {
    const m = await import(`../scripts/e7-hosted-${n}.mjs`);
    assert.equal(m.CONSTANTS.executeEnabled, false, n); assert.ok(!m.CONSTANTS.runnerFiles.some((f) => FILES.includes(f)), n);
    assert.equal(await R.framedDigest(ROOT, m.CONSTANTS.runnerFiles, m.RUNNER_DIGEST_PREFIX), want[n], n);
  }
  const I = await import("../scripts/e7-hosted-notify-inspect.mjs");
  assert.equal(I.CONSTANTS.executeEnabled, false);
  assert.equal(await R.framedDigest(ROOT, I.CONSTANTS.runnerFiles, I.SOURCE_DIGEST_PREFIX), "889d6a31af4249cede0bf8b64360b5ca0e7ca2d994c4c882f0348e5f57c2c8e7");
  // C116: the C50 booking-confirmation runner's exact digest / CLOSED assertions moved to the dedicated C116 cross-runner regression (outside every
  // runtime frame); only frame disjointness stays here
  const N = await import("../scripts/e7-hosted-booking-confirmation.mjs");
  assert.ok(!N.CONSTANTS.runnerFiles.some((f) => FILES.includes(f)));
});

// ---- C113: the detect job + the trusted job-output routing --------------------------------------------------------------------------
test("W9 C113 detect job: checkouts → node → the SAME pre-secret re-check block as execute (byte-identical; executed locally) → npm ci → CA → the ONE detect step LAST; declared outputs outcome + fingerprint only; no token", async () => {
  assert.deepEqual(steps(jobs.detect).map((s) => s.split(" (")[0].split(",")[0]), ["Checkout wrapper", "Checkout E7 kickoff tooling", "Set up Node 22.22.0", "Re-check bindings BEFORE the DB secret",
    "Install the pinned dependency from the verified lockfile", "Fetch the public Supabase CA", "ONE gated read-only detection"]);
  const det = runBlock("Re-check bindings BEFORE the DB secret, detect (HEAD == dispatch SHA; tooling pin; kickoff source digest; pipeline release binding 880db5b3)");
  const exe = runBlock("Re-check bindings BEFORE any secret (HEAD == dispatch SHA; tooling pin; kickoff source digest; pipeline release binding 880db5b3)");
  assert.equal(det, exe, "identical pre-secret checks in both secret-bearing jobs");
  assert.match(jobs.detect, /\n    outputs:\n      outcome: \$\{\{ steps\.detect\.outputs\.outcome \}\}\n      fingerprint: \$\{\{ steps\.detect\.outputs\.fingerprint \}\}\n    steps:/);
  assert.doesNotMatch(jobs.detect, /E7_INTENT_ID|E7_BOOKING_REF|E7_EXPECTED_VERSION|E7_PAYMENT_INTENT_ID|E7_AMOUNT_MINOR|github\.token|E7_DISPATCH_TOKEN|actions: write/, "no binding input, no token");
  const d = sandbox(); try {
    const want = await expectedDigest(); const pipe = await R.pipelineBinding(ROOT);
    const r = sh(det, { E7_WORKFLOW_SHA: headSha, E7_TOOLING_PIN: PIN, E7_EXPECTED_SOURCE_DIGEST: want, E7_PIPELINE_SOURCE_PIN: pipe.sourceDigest }, d);
    assert.equal(r.status, 0, r.out);
    const bad = sh(det, { E7_WORKFLOW_SHA: headSha, E7_TOOLING_PIN: PIN, E7_EXPECTED_SOURCE_DIGEST: "f".repeat(64), E7_PIPELINE_SOURCE_PIN: pipe.sourceDigest }, d);
    assert.deepEqual([bad.status, /expected_source_digest mismatch/.test(bad.out)], [3, true]);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

/** evaluate a job's `if:` exactly as written (GitHub expression subset used here) against a run context; jobs without a status function get the implicit success() */
function jobIf(job) {
  const m = job.match(/\n    if: (.*)\n/); assert.ok(m, "job has if"); let e = m[1].trim();
  if (e.startsWith("${{")) e = e.replace(/^\$\{\{\s*/, "").replace(/\s*\}\}$/, "");
  assert.match(e, /^[a-zA-Z0-9_.'()!&|= \/-]+$/, "only the reviewed operators / literals");
  const js = e.replace(/==/g, "===").replace(/!===/g, "!==").replace(/\bcancelled\(\)/g, "ctx.cancelled()").replace(/\b(inputs|github|needs)\./g, "ctx.$1.");
  const explicit = /\b(cancelled|always|success|failure)\(\)/.test(e);
  const fn = new Function("ctx", `return (${js});`);
  return (ctx, needs) => (explicit ? true : needs.every((n) => ctx.needs[n].result === "success")) && fn(ctx) === true;
}
test("W10 C113 needs / if truth table (the REAL expressions): manual execute stays reachable when detect is SKIPPED; detect mode reaches execute ONLY via detect success + outcome ONE; any failed / cancelled / skipped preflight, verify or detect, a CLOSED verify (open=false) or a non-main ref reaches NEITHER secret job; no always()", () => {
  const ifDetect = jobIf(jobs.detect); const ifExec = jobIf(jobs.execute);
  const ctx = ({ mode, ev = "workflow_dispatch", ref = "refs/heads/main", pre = "success", ver = "success", open = "", det = "skipped", outcome = "", cancelled = false }) =>
    ({ inputs: ev === "schedule" ? {} : { mode }, github: { ref, event_name: ev }, cancelled: () => cancelled, needs: { preflight: { result: pre }, verify: { result: ver, outputs: { open } }, detect: { result: det, outputs: { outcome } } } });
  const run = (o) => { const c = ctx(o); const d = ifDetect(c, ["preflight", "verify"]); return { detect: d, execute: ifExec(c, ["preflight", "verify", "detect"]) }; };
  const cases = [
    [{ mode: "execute" }, { detect: false, execute: true }],                                              // manual: detect skipped → execute reachable
    [{ mode: "execute", ver: "failure" }, { detect: false, execute: false }],                              // CLOSED manual verify fails
    [{ mode: "execute", pre: "failure", ver: "skipped" }, { detect: false, execute: false }],
    [{ mode: "execute", ref: "refs/heads/feature" }, { detect: false, execute: false }],
    [{ mode: "execute", cancelled: true }, { detect: false, execute: false }],
    [{ mode: "verify" }, { detect: false, execute: false }],
    [{ mode: "detect", open: "false" }, { detect: false, execute: false }],                               // CLOSED_NOOP: both gated jobs skipped
    [{ mode: "detect", open: "true", det: "success", outcome: "ONE" }, { detect: true, execute: true }],
    [{ mode: "detect", open: "true", det: "success", outcome: "NO_REQUEST" }, { detect: true, execute: false }],
    [{ mode: "detect", open: "true", det: "success", outcome: "AMBIGUOUS" }, { detect: true, execute: false }],
    [{ mode: "detect", open: "true", det: "success", outcome: "INELIGIBLE:OPEN_CASE" }, { detect: true, execute: false }],
    [{ mode: "detect", open: "true", det: "failure", outcome: "ONE" }, { detect: true, execute: false }],
    [{ mode: "detect", open: "true", det: "cancelled", outcome: "ONE" }, { detect: true, execute: false }],
    [{ mode: "detect", open: "true", det: "skipped" }, { detect: true, execute: false }],                 // detect skipped in detect mode ≠ manual path
    [{ mode: "detect", open: "true", det: "success", outcome: "ONE", cancelled: true }, { detect: true, execute: false }],
    [{ mode: "detect", ver: "failure", det: "success", outcome: "ONE" }, { detect: false, execute: false }],
    [{ mode: "detect", open: "true", ref: "refs/heads/feature", det: "success", outcome: "ONE" }, { detect: false, execute: false }],
    [{ mode: "detect", pre: "failure", open: "true", det: "success", outcome: "ONE" }, { detect: false, execute: false }],
    // C115 schedule: inputs are EMPTY; always the detect flow; never the manual execute path
    [{ ev: "schedule", open: "false" }, { detect: false, execute: false }],                                // CLOSED scheduled tick: CLOSED_NOOP, 0 approvals
    [{ ev: "schedule", ver: "failure" }, { detect: false, execute: false }],                               // missing / wrong pin → verify refuses
    [{ ev: "schedule", open: "true" }, { detect: true, execute: false }],                                  // gate #1 only (detect not yet ONE)
    [{ ev: "schedule", open: "true", det: "success", outcome: "ONE" }, { detect: true, execute: true }],   // gate #2 only after detect ONE
    [{ ev: "schedule", open: "true", det: "success", outcome: "NO_REQUEST" }, { detect: true, execute: false }],
    [{ ev: "schedule", open: "true", det: "skipped" }, { detect: true, execute: false }],                  // a skipped detect NEVER routes a schedule to manual execute
    [{ ev: "schedule", open: "true", det: "failure", outcome: "ONE" }, { detect: true, execute: false }],
    [{ ev: "schedule", open: "true", det: "success", outcome: "ONE", cancelled: true }, { detect: true, execute: false }],
    [{ ev: "schedule", pre: "failure", ver: "skipped" }, { detect: false, execute: false }],
    [{ ev: "schedule", open: "true", ref: "refs/heads/feature", det: "success", outcome: "ONE" }, { detect: false, execute: false }]];
  for (const [o, want] of cases) assert.deepEqual(run(o), want, JSON.stringify(o));
});

test("W11 C113 trusted outputs: the runner writes ONLY allowlisted $GITHUB_OUTPUT lines (open true/false; outcome enum; fingerprint 64-hex or empty) — anything else writes NOTHING", () => {
  const fp = "a".repeat(64);
  assert.equal(R.outputLines({ outputs: { open: "false" } }), "open=false\n");
  assert.equal(R.outputLines({ outputs: { outcome: "ONE", fingerprint: fp } }), `outcome=ONE\nfingerprint=${fp}\n`);
  assert.equal(R.outputLines({ outputs: { outcome: "NO_REQUEST", fingerprint: "" } }), "outcome=NO_REQUEST\nfingerprint=\n");
  assert.equal(R.outputLines({ outputs: { outcome: "INELIGIBLE:OPEN_CASE", fingerprint: "" } }), "outcome=INELIGIBLE:OPEN_CASE\nfingerprint=\n");
  for (const bad of [{ open: "yes" }, { outcome: "ONE\nfingerprint=x" }, { outcome: "one" }, { fingerprint: "A".repeat(64) }, { fingerprint: "a".repeat(63) }, { intent: "x" }, { outcome: "MV-ABC123" }])
    assert.equal(R.outputLines({ outputs: bad }), "", JSON.stringify(bad));
  assert.equal(R.outputLines({}), ""); assert.equal(R.outputLines({ outputs: null }), "");
});

// ---- C115: scheduled detect routing (the REAL step expressions) -------------------------------------------------------------------
/** evaluate a `${{ … }}` value expression exactly as written (the subset used here: ==, &&, ||, (), 'literals', github / inputs / vars) */
function evalExpr(raw, ctx) {
  const e = raw.replace(/^\$\{\{\s*/, "").replace(/\s*\}\}$/, "");
  assert.match(e, /^[a-zA-Z0-9_.'()|&= -]+$/, "only the reviewed operators / literals");
  const js = e.replace(/==/g, "===").replace(/\b(github|inputs|vars)\./g, "ctx.$1.");
  return new Function("ctx", `return (${js});`)(ctx);
}
const stepEnv = (key) => [...new Set([...yml.matchAll(new RegExp(`^          ${key}: (.*)$`, "gm"))].map((m) => m[1]))];
test("W12 C115 event routing (REAL expressions + REAL shell): every E7_MODE / E7_INPUT_MODE is ONE expression → schedule ALWAYS 'detect' (empty bindings), manual = inputs.mode unchanged; every E7_EXPECTED_SOURCE_DIGEST is ONE expression → schedule = vars.E7_KICKOFF_EXPECTED_SOURCE or the literal 'MISSING' (never a computed digest), manual = inputs.expected_source_digest unchanged; verify runs for every schedule tick; the preflight shell admits the scheduled mode", () => {
  const modes = [...new Set([...stepEnv("E7_MODE"), ...stepEnv("E7_INPUT_MODE")])];
  assert.deepEqual(modes, ["${{ github.event_name == 'schedule' && 'detect' || inputs.mode }}"]);
  assert.equal(yml.split("E7_INPUT_MODE: ").length - 1, 3); assert.equal(yml.split("E7_MODE: ").length - 1, 1);
  const digs = stepEnv("E7_EXPECTED_SOURCE_DIGEST");
  assert.deepEqual(digs, ["${{ github.event_name == 'schedule' && (vars.E7_KICKOFF_EXPECTED_SOURCE || 'MISSING') || inputs.expected_source_digest }}"]);
  assert.equal(yml.split("E7_EXPECTED_SOURCE_DIGEST: ").length - 1, 5, "verify + both pre-secret re-checks + detect + execute steps");
  assert.equal((yml.replace(/^#.*$/gm, "").match(/vars\./g) || []).length, 5, "the variable is read ONLY in the digest expression");
  assert.doesNotMatch(yml.replace(/^#.*$/gm, ""), /secrets\.E7_KICKOFF|vars\.(?!E7_KICKOFF_EXPECTED_SOURCE\b)/, "one variable name, never a secret");
  const pin = "a".repeat(64); const man = "b".repeat(64);
  const sched = (v) => ({ github: { event_name: "schedule" }, inputs: {}, vars: v === undefined ? {} : { E7_KICKOFF_EXPECTED_SOURCE: v } });
  const manual = (mode, d = "") => ({ github: { event_name: "workflow_dispatch" }, inputs: { mode, expected_source_digest: d }, vars: { E7_KICKOFF_EXPECTED_SOURCE: pin } });
  assert.equal(evalExpr(modes[0], sched(pin)), "detect");
  for (const m of ["preflight", "verify", "execute", "detect"]) assert.equal(evalExpr(modes[0], manual(m)), m, `manual ${m} unchanged`);
  assert.equal(evalExpr(digs[0], sched(pin)), pin, "schedule: the exact reviewed pin");
  assert.equal(evalExpr(digs[0], sched(undefined)), "MISSING"); assert.equal(evalExpr(digs[0], sched("")), "MISSING");
  assert.equal(evalExpr(digs[0], manual("execute", man)), man, "manual input wins even when a variable exists");
  assert.equal(evalExpr(digs[0], manual("detect", "")), "", "manual detect without a digest stays empty (refused by verify as before)");
  // binding inputs on a schedule are empty: every E7_<binding> env is a bare inputs.* reference → "" (undefined) on schedule
  for (const k of ["E7_INTENT_ID", "E7_BOOKING_REF", "E7_EXPECTED_VERSION", "E7_PAYMENT_INTENT_ID", "E7_AMOUNT_MINOR"])
    for (const v of stepEnv(k)) { assert.match(v, /^\$\{\{ inputs\.[a-z_]+ \}\}$/); assert.equal(evalExpr(v, sched(pin)) ?? "", ""); }
  // verify's if: every schedule tick runs verify (that is where CLOSED_NOOP / a missing or wrong pin stops it); manual preflight does not
  const ifVerify = jobIf(jobs.verify);
  const vctx = (ev, mode) => ({ inputs: ev === "schedule" ? {} : { mode }, github: { event_name: ev, ref: "refs/heads/main" }, cancelled: () => false, needs: { preflight: { result: "success" } } });
  assert.equal(ifVerify(vctx("schedule"), ["preflight"]), true);
  assert.deepEqual(["preflight", "verify", "execute", "detect"].map((m) => ifVerify(vctx("workflow_dispatch", m), ["preflight"])), [false, true, true, true]);
  // the REAL preflight shell block with the evaluated scheduled mode
  const bind = runBlock("Verify checkout bindings (wrapper HEAD == dispatch SHA; tooling HEAD == pin; no secrets)");
  const d = sandbox(); try {
    const ok = sh(bind, { E7_WORKFLOW_SHA: headSha, E7_TOOLING_PIN: PIN, E7_MODE: evalExpr(modes[0], sched(undefined)) }, d);
    assert.deepEqual([ok.status, /mode=detect/.test(ok.out)], [0, true], ok.out);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
