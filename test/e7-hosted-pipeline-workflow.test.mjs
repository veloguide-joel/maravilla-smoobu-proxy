// test/e7-hosted-pipeline-workflow.test.mjs — C90: regression test for .github/workflows/e7-hosted-pipeline.yml (SHIPPED CLOSED). LABELLED ADAPTATION of the C50
// test/e7-hosted-booking-confirmation-workflow.test.mjs. Static assertions on the
// workflow bytes + LOCAL execution of its gate shell blocks (extracted from the YAML, run with bash against symlinked wrapper / tooling dirs).
// Zero network, zero secrets: the ONE execute step is never executed here (only asserted); every real network primitive is a throwing guard.
// Also pins that the five reviewed runners, the C47 inspection runner, the charge-list probe and the Resend sink probe are byte-unchanged and that
// none of their frames (nor the C50 booking-confirmation runner's) contains a C90 file. C116: the C50 runner's exact digest lives in
// test/e7-cross-runner-regression.test.mjs, outside every runtime frame.
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
const R = await import("../scripts/e7-hosted-pipeline.mjs");
after(() => { assert.deepEqual(GUARD, { request: 0, Agent: 0, fetch: 0 }, "no real network primitive was touched"); });

const WF = ".github/workflows/e7-hosted-pipeline.yml";
const yml = readFileSync(join(ROOT, WF), "utf8");
const PIN = "71c3dcf83c6b78a2cb0c6a7e829b5ecb23d37af5";   // e7-test merge #129 on top of #128 (coordinator 07011a79)
const PREFIX = "e7-hosted-pipeline-v1\n";
const FILES = ["scripts/e7-hosted-pipeline.mjs", "test/e7-hosted-pipeline.test.mjs", "test/e7-hosted-pipeline-workflow.test.mjs", WF];
const count = (re) => (yml.match(re) || []).length;
function runBlock(stepName) {
  const i = yml.indexOf(`- name: ${stepName}`); assert.ok(i >= 0, stepName);
  const rest = yml.slice(i); const m = rest.match(/\n        run: \|\n((?:          .*\n)+)/); assert.ok(m, `run block of ${stepName}`);
  return m[1].split("\n").map((l) => l.replace(/^ {10}/, "")).join("\n");
}
const jobs = { preflight: yml.slice(yml.indexOf("\n  preflight:\n"), yml.indexOf("\n  execute:\n")), execute: yml.slice(yml.indexOf("\n  execute:\n")) };
const steps = (job) => [...job.matchAll(/\n      - name: ([^\n]+)/g)].map((m) => m[1]);

test("W1 static: workflow_dispatch ONLY; inputs exactly mode (choice [preflight, execute], default preflight) / approval_ref / the seven bound plan inputs / three expected digests — NO contact / guest / recipient input; permissions contents: read; concurrency cancel-in-progress false; runner FILES = the documented frame", () => {
  assert.match(yml, /^on:\n  workflow_dispatch:\n    inputs:\n      mode:\n/m); assert.doesNotMatch(yml, /\n  (push|pull_request|pull_request_target|schedule|workflow_call|repository_dispatch|workflow_run|issue_comment):/);
  assert.match(yml, /      mode:\n(?:        .*\n)*?        type: choice\n        options: \[preflight, execute\]\n        default: preflight\n/);
  assert.deepEqual([...yml.matchAll(/^      ([a-z_]+):\n        description/gm)].map((m) => m[1]),
    ["mode", "approval_ref", "intent_id", "booking_ref", "expected_version", "not_before", "payment_intent_id", "amount_minor", "currency", "expected_plan_hash", "expected_source_digest", "expected_closure_digest"]);
  assert.doesNotMatch(yml.slice(0, yml.indexOf("\npermissions:")).replace(/^#.*$/gm, ""), /recipient|sender|email|subject|guest_name|to_address|from_address|reservation_id|listing_id/i);
  assert.match(yml, /\npermissions:\n  contents: read\n\n/); assert.equal(count(/permissions:/g), 1); assert.doesNotMatch(yml, /: write|id-token:|pull-requests:|packages:|deployments:|issues:|checks:|statuses:/);
  assert.match(yml, /\nconcurrency:\n  group: e7-hosted-pipeline\n  cancel-in-progress: false\n/);
  assert.deepEqual([...yml.matchAll(/^  ([a-z-]+):\n    (?:needs|runs-on|if)/gm)].map((m) => m[1]), ["preflight", "execute"]);
  assert.equal(count(/runs-on: ubuntu-24\.04/g), 2); assert.equal(count(/timeout-minutes: 10\n/g), 1); assert.equal(count(/timeout-minutes: 20\n/g), 1);
  assert.deepEqual([...R.CONSTANTS.runnerFiles], FILES);
});

test("W2 static: checkouts at the EXACT dispatch SHA + the immutable tooling pin 71c3dcf8 (persist-credentials false), the same reviewed action pins as e7-hosted-recording.yml, Node 22.22.0; the preflight job has no environment / secret / npm / curl", () => {
  assert.equal(count(/ref: \$\{\{ github\.sha \}\}\n          path: wrapper\n          persist-credentials: false/g), 2);
  assert.equal(count(new RegExp(`repository: veloguide-joel/maravilla-smoobu-proxy\\n          ref: ${PIN}\\n          path: tooling\\n          persist-credentials: false`, "g")), 2);
  assert.equal(count(/persist-credentials: false/g), 4); assert.doesNotMatch(yml, /ref: main|ref: refs\/heads|ref: \$\{\{ github\.ref/);
  const rec = readFileSync(join(ROOT, ".github/workflows/e7-hosted-recording.yml"), "utf8");
  const pins = (s) => [...new Set([...s.matchAll(/uses: (actions\/[a-z-]+@[0-9a-f]{40})/g)].map((m) => m[1]))].sort();
  assert.deepEqual(pins(yml), pins(rec)); assert.equal(count(/uses: /g), 6);
  assert.equal(count(/node-version: "22\.22\.0"\n          package-manager-cache: false/g), 2);
  assert.doesNotMatch(jobs.preflight, /environment:|secrets\.|needs:|npm |curl |E7_CA_FILE/);
  assert.equal(R.CONSTANTS.toolingCommit, PIN);
  assert.equal(yml.split(`ref: ${PIN}`).length - 1, 2, "both workflow checkouts use the exact immutable ref");
  assert.equal(yml.split(`E7_TOOLING_PIN: ${PIN}`).length - 1, 2, "both tooling-pin bindings are the exact ref");
});

test("W3 static: execute job needs preflight AND mode == 'execute' && main AND environment e7-readonly-probe (the only environment); step order: checkouts → node → bindings re-check → runner verify (SHIPPED CLOSED refuses HERE, before any secret step) → npm ci → CA fetch → the ONE execute step LAST", () => {
  assert.match(jobs.execute, /^\n  execute:\n    needs: preflight\n    if: inputs\.mode == 'execute' && github\.ref == 'refs\/heads\/main'\n    runs-on: ubuntu-24\.04\n    environment: e7-readonly-probe\n    timeout-minutes: 20\n/);
  assert.equal(count(/environment: /g), 1);
  assert.deepEqual(steps(jobs.execute).map((s) => s.split(" (")[0]), ["Checkout wrapper", "Checkout merged E7 tooling", "Set up Node 22.22.0", "Re-check bindings BEFORE any secret",
    "Verify", "Install the pinned dependency from the verified lockfile", "Fetch the public Supabase CA", "ONE gated TEST pipeline run"]);
  assert.match(jobs.execute, /working-directory: tooling\n        run: npm ci --ignore-scripts --omit=dev --no-audit --no-fund\n/);
  assert.equal(count(/curl --fail --silent --show-error --proto '=https' --max-time 20 -o "\$RUNNER_TEMP\/prod-ca-2021\.crt" https:\/\/supabase-downloads\.s3-ap-southeast-1\.amazonaws\.com\/prod\/ssl\/prod-ca-2021\.crt\n/g), 1);
  assert.deepEqual(steps(jobs.preflight).map((s) => s.split(" (")[0]), ["Checkout wrapper", "Checkout merged E7 tooling", "Set up Node 22.22.0", "Verify checkout bindings", "Preflight", "Source digest"]);
});

test("W4 static: the ONLY secrets (existing NAMES E7_STRIPE_TEST_KEY, E7_HOSTAWAY_TOKEN, E7_DEV_BOOKING_DATABASE_URL) appear exactly once each, in the env of the LAST execute step, whose run is exactly the one `execute` command; no other secret; no expression interpolation inside any run; every E7_* env name is an admitted runner key", () => {
  assert.equal(count(/secrets\./g), 3);
  for (const k of ["E7_STRIPE_TEST_KEY", "E7_HOSTAWAY_TOKEN", "E7_DEV_BOOKING_DATABASE_URL"]) assert.equal(count(new RegExp(`\\$\\{\\{ secrets\\.${k} \\}\\}`, "g")), 1, k);
  const last = yml.slice(yml.lastIndexOf("      - name: "));
  assert.match(last, /^      - name: ONE gated TEST pipeline run[^\n]*\n        env:\n(?:          [A-Z0-9_]+: [^\n]+\n)+        run: node wrapper\/scripts\/e7-hosted-pipeline\.mjs execute\n$/);
  assert.match(last, /          E7_STRIPE_TEST_KEY: \$\{\{ secrets\.E7_STRIPE_TEST_KEY \}\}\n          E7_HOSTAWAY_TOKEN: \$\{\{ secrets\.E7_HOSTAWAY_TOKEN \}\}\n          E7_DEV_BOOKING_DATABASE_URL: \$\{\{ secrets\.E7_DEV_BOOKING_DATABASE_URL \}\}\n        run:/);
  assert.equal(count(/e7-hosted-pipeline\.mjs execute\n/g), 1); assert.equal(count(/e7-hosted-pipeline\.mjs verify\n/g), 1); assert.equal(count(/e7-hosted-pipeline\.mjs preflight\n/g), 1);
  assert.doesNotMatch(yml, /E7_RESEND|RESEND|api\.stripe\.com|api\.hostaway\.com|E7_RECIPIENT|E7_SENDER|E7_HPL_DB_TESTS/);
  for (const blk of yml.split(/\n      - name: /).slice(1)) { const r = blk.match(/\n        run: \|\n((?:          .*\n)+)|\n        run: (.*)\n/); if (r) assert.doesNotMatch(r[1] ?? r[2], /\$\{\{/, "no expression interpolation inside run"); }
  const envKeys = [...yml.matchAll(/^          (E7_[A-Z0-9_]+):/gm)].map((m) => m[1]);
  for (const k of envKeys) if (k !== "E7_TOOLING_PIN" && k !== "E7_MODE") assert.ok(R.ALLOWED_E7_KEYS.includes(k), `${k} is an admitted runner key`);
  assert.equal(count(new RegExp(FILES.map((f) => f.replace(/[.\/]/g, "\\$&")).join(" "), "g")), 2, "digest file list identical in both jobs, documented order");
  assert.equal(R.CONSTANTS.executeEnabled, true, "C102 ENABLE: ONE gated TEST run (main only, e7-readonly-probe reviewers, exact bindings); the reverse CLOSE patch restores false");
});

// ---- LOCAL execution of the gate blocks ----------------------------------------------------------------------------------------------
const headSha = execFileSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const toolSha = execFileSync("git", ["-C", TOOLING, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
function sandbox() { const d = mkdtempSync(join(tmpdir(), "e7-c90-")); symlinkSync(ROOT, join(d, "wrapper")); symlinkSync(TOOLING, join(d, "tooling")); return d; }
function sh(block, env, cwd) {
  const r = spawnSync("bash", ["-c", block], { cwd, encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME ?? "/tmp", ...env } });
  return { status: r.status, out: (r.stdout || "") + (r.stderr || "") };
}
const expectedDigest = async () => {
  const h = createHash("sha256"); h.update(PREFIX);
  for (const f of FILES) { const b = readFileSync(join(ROOT, f)); h.update(f); h.update(Buffer.from([0])); h.update(String(b.length)); h.update(Buffer.from([0])); h.update(b); h.update(Buffer.from([0])); }
  const mine = h.digest("hex"); assert.equal(mine, await R.framedDigest(ROOT, FILES, PREFIX), "shell frame == the runner's framedDigest"); return mine;
};

test("W5 preflight gate blocks executed locally: bindings pass only with HEAD == dispatch SHA, tooling == pin and a known mode; the digest block prints the documented frame and refuses a mismatching expected digest", async () => {
  assert.equal(toolSha, PIN, "E7_TOOLING_DIR must be the pinned 71c3dcf8 checkout");
  const d = sandbox(); try {
    const bind = runBlock("Verify checkout bindings (wrapper HEAD == dispatch SHA; tooling HEAD == pin; no secrets)");
    for (const mode of ["preflight", "execute"]) { const ok = sh(bind, { E7_WORKFLOW_SHA: headSha, E7_TOOLING_PIN: PIN, E7_MODE: mode }, d); assert.equal(ok.status, 0, ok.out); }
    for (const [env, why] of [[{ E7_WORKFLOW_SHA: "0".repeat(40), E7_TOOLING_PIN: PIN, E7_MODE: "preflight" }, /wrapper HEAD != dispatch SHA/],
      [{ E7_WORKFLOW_SHA: headSha, E7_TOOLING_PIN: "1".repeat(40), E7_MODE: "preflight" }, /tooling HEAD != pin/], [{ E7_WORKFLOW_SHA: headSha, E7_TOOLING_PIN: PIN, E7_MODE: "inspect" }, /REFUSED: mode/]]) {
      const r = sh(bind, env, d); assert.deepEqual([r.status, why.test(r.out)], [3, true], r.out);
    }
    const dig = runBlock("Source digest (deterministic framed SHA-256; documented order and prefix)"); const want = await expectedDigest();
    const r1 = sh(dig, { E7_EXPECTED_SOURCE_DIGEST: "" }, d); assert.equal(r1.status, 0, r1.out); assert.match(r1.out, new RegExp(`sourceDigest=${want}`));
    assert.equal(sh(dig, { E7_EXPECTED_SOURCE_DIGEST: want }, d).status, 0);
    const r3 = sh(dig, { E7_EXPECTED_SOURCE_DIGEST: "f".repeat(64) }, d); assert.deepEqual([r3.status, /expected_source_digest mismatch/.test(r3.out)], [3, true], r3.out);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("W6 execute re-check block executed locally (BEFORE any secret): passes only with HEAD == dispatch SHA, tooling == pin, a non-empty approval label, three 64-hex expected digests and the expected source digest EQUAL to the actual one", async () => {
  const d = sandbox(); try {
    const blk = runBlock("Re-check bindings BEFORE any secret (HEAD == dispatch SHA; tooling pin; label; expected digests 64-hex; source digest)");
    assert.doesNotMatch(blk, /E7_DEV_BOOKING_DATABASE_URL|E7_STRIPE_TEST_KEY|E7_HOSTAWAY_TOKEN|\.mjs execute|secrets\./); const want = await expectedDigest();
    const base = { E7_WORKFLOW_SHA: headSha, E7_TOOLING_PIN: PIN, E7_APPROVAL_REF: "ROOT-C90-label", E7_EXPECTED_PLAN_HASH: "a".repeat(64), E7_EXPECTED_SOURCE_DIGEST: want, E7_EXPECTED_CLOSURE_DIGEST: R.CONSTANTS.closureDigest };
    const ok = sh(blk, base, d); assert.equal(ok.status, 0, ok.out); assert.match(ok.out, new RegExp(`bindings ok: wrapper=${headSha} tooling=${PIN} source=${want}`));
    for (const [over, why] of [[{ E7_WORKFLOW_SHA: "0".repeat(40) }, /wrapper HEAD != dispatch SHA/], [{ E7_TOOLING_PIN: "1".repeat(40) }, /tooling HEAD != pin/], [{ E7_APPROVAL_REF: "" }, /approval_ref empty/],
      [{ E7_EXPECTED_PLAN_HASH: "" }, /not 64-hex/], [{ E7_EXPECTED_CLOSURE_DIGEST: "XYZ" }, /not 64-hex/], [{ E7_EXPECTED_SOURCE_DIGEST: "f".repeat(64) }, /expected_source_digest mismatch/]]) {
      const r = sh(blk, { ...base, ...over }, d); assert.deepEqual([r.status, why.test(r.out)], [3, true], JSON.stringify(over) + r.out);
    }
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("W7 untouched: the five reviewed runners (executeEnabled false, digests unchanged), the C47 inspection runner (889d6a31…), the C50 booking-confirmation runner frame-disjoint only (exact digest: cross-runner regression), the charge-list probe (43715872…) and the Resend sink probe (aef26da9…) source digests; the new files are in no other frame", async () => {
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
  assert.equal(await R.framedDigest(ROOT, I.CONSTANTS.runnerFiles, I.SOURCE_DIGEST_PREFIX), "889d6a31af4249cede0bf8b64360b5ca0e7ca2d994c4c882f0348e5f57c2c8e7", "C47/C48 inspection runner unchanged");
  assert.ok(!I.CONSTANTS.runnerFiles.some((f) => FILES.includes(f)));
  // C116: the C50 booking-confirmation runner's exact digest / CLOSED assertions moved to test/e7-cross-runner-regression.test.mjs
  // (OUTSIDE every runtime frame) — pinning it here made the pipeline ENABLE frame depend on the notification frame (C116 cycle).
  const N = await import("../scripts/e7-hosted-booking-confirmation.mjs");
  assert.ok(!N.CONSTANTS.runnerFiles.some((f) => FILES.includes(f)));
  assert.equal(await R.framedDigest(ROOT, ["scripts/e7-hosted-charge-list-probe.mjs", "test/e7-hosted-charge-list-probe.test.mjs", ".github/workflows/e7-hosted-charge-list-probe.yml"], "e7-hosted-charge-list-probe-v1\n"), "43715872ddb450889286880c848acefd8757da6fe33bc5c6a3a547bd27219cf3");
  assert.equal(await R.framedDigest(ROOT, ["scripts/e7-resend-sink-probe.mjs", "scripts/e7-resend/resend-exchange.mjs", "test/e7-resend-sink-probe.test.mjs", ".github/workflows/e7-resend-sink-probe.yml"], "e7-resend-sink-probe-v1\n"), "aef26da954d986dc2d922b607d391be404dd73f1145ece0ae66ea0d80673ade4");
});
