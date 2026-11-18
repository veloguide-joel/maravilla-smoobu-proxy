// test/e7-hosted-booking-confirmation-workflow.test.mjs — C50: regression test for .github/workflows/e7-hosted-booking-confirmation.yml (SHIPPED CLOSED). Static assertions on the
// workflow bytes + LOCAL execution of its gate shell blocks (extracted from the YAML, run with bash against symlinked wrapper / tooling dirs).
// Zero network, zero secrets: the ONE execute step is never executed here (only asserted); every real network primitive is a throwing guard.
// C119 S1: + the manual `detect` job (approval #1, the DB secret only, declared outputs outcome + fingerprint) and the detect-flow execute routing.
// Also pins that the five reviewed runners, the C47 inspection runner, the charge-list probe and the Resend sink probe are byte-unchanged.
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
const R = await import("../scripts/e7-hosted-booking-confirmation.mjs");
after(() => { assert.deepEqual(GUARD, { request: 0, Agent: 0, fetch: 0 }, "no real network primitive was touched"); });

const WF = ".github/workflows/e7-hosted-booking-confirmation.yml";
const yml = readFileSync(join(ROOT, WF), "utf8");
const PIN = "66133a22edca925e6386c4d178c251fa5f11c82e";   // C116 repin (#180 merge; tree ade3e084); was 46b3eaf8 (C55)
const OLD_PIN = "d322d2192b377d18b6a9280ae06c17eddfe3e73e";
const PREFIX = "e7-hosted-booking-confirmation-v1\n";
const FILES = ["scripts/e7-hosted-booking-confirmation.mjs", "test/e7-hosted-booking-confirmation.test.mjs", "test/e7-hosted-booking-confirmation-workflow.test.mjs", WF];
const count = (re) => (yml.match(re) || []).length;
function runBlock(stepName) {
  const i = yml.indexOf(`- name: ${stepName}`); assert.ok(i >= 0, stepName);
  const rest = yml.slice(i); const m = rest.match(/\n        run: \|\n((?:          .*\n)+)/); assert.ok(m, `run block of ${stepName}`);
  return m[1].split("\n").map((l) => l.replace(/^ {10}/, "")).join("\n");
}
const jobs = { preflight: yml.slice(yml.indexOf("\n  preflight:\n"), yml.indexOf("\n  arm:\n")), arm: yml.slice(yml.indexOf("\n  arm:\n"), yml.indexOf("\n  detect:\n")), detect: yml.slice(yml.indexOf("\n  detect:\n"), yml.indexOf("\n  execute:\n")),
  execute: yml.slice(yml.indexOf("\n  execute:\n")) };
const steps = (job) => [...job.matchAll(/\n      - name: ([^\n]+)/g)].map((m) => m[1]);

test("W1 static: workflow_dispatch ONLY (C119 S1: still no schedule); inputs exactly mode (choice [preflight, detect, execute], default preflight) / approval_ref / intent_id / op_id / expected_version / locale / three expected digests — NO contact / sender / recipient / subject / body input; permissions contents: read; concurrency cancel-in-progress false; runner FILES = the documented frame", () => {
  assert.match(yml, /^on:\n  schedule:\n    - cron: '28,58 \* \* \* \*'\n  workflow_dispatch:\n    inputs:\n      mode:\n/m, "C119 S2: ONE draft TEST-only schedule + manual dispatch");
  assert.doesNotMatch(yml, /\n  (push|pull_request|pull_request_target|workflow_call|repository_dispatch|workflow_run):/); assert.equal((yml.replace(/^#.*$/gm, "").match(/cron:/g) || []).length, 1);
  assert.match(yml, /      mode:\n(?:        .*\n)*?        type: choice\n        options: \[preflight, detect, execute\]\n        default: preflight\n/);
  assert.deepEqual([...yml.matchAll(/^      ([a-z_]+):\n        description/gm)].map((m) => m[1]),
    ["mode", "approval_ref", "intent_id", "op_id", "expected_version", "locale", "expected_plan_hash", "expected_source_digest", "expected_closure_digest"]);
  assert.doesNotMatch(yml.slice(0, yml.indexOf("\npermissions:")).replace(/^#.*$/gm, ""), /recipient|sender|email|subject|body|to_address|from_address/i);
  assert.match(yml, /\npermissions:\n  contents: read\n\n/); assert.equal(count(/permissions:/g), 1); assert.doesNotMatch(yml, /: write|id-token:|pull-requests:|packages:|deployments:|issues:|checks:|statuses:/);
  assert.match(yml, /\nconcurrency:\n  group: e7-hosted-booking-confirmation\n  cancel-in-progress: false\n/);
  assert.deepEqual([...yml.matchAll(/^  ([a-z-]+):\n    (?:needs|runs-on|if)/gm)].map((m) => m[1]), ["preflight", "arm", "detect", "execute"]);
  assert.equal(count(/runs-on: ubuntu-24\.04/g), 4); assert.equal(count(/timeout-minutes: 10\n/g), 3); assert.equal(count(/timeout-minutes: 5\n/g), 1);
  assert.deepEqual([...R.CONSTANTS.runnerFiles], FILES);
});

test("W2 static: checkouts at the EXACT dispatch SHA + the tooling pin 66133a22 (persist-credentials false), the same reviewed action pins as e7-hosted-recording.yml, Node 22.22.0; the preflight job has no environment / secret / npm / curl", () => {
  assert.equal(count(/ref: \$\{\{ github\.sha \}\}\n          path: wrapper\n          persist-credentials: false/g), 4);
  assert.equal(count(new RegExp(`repository: veloguide-joel/maravilla-smoobu-proxy\\n          ref: ${PIN}\\n          path: tooling\\n          persist-credentials: false`, "g")), 3);
  assert.equal(count(/persist-credentials: false/g), 7); assert.doesNotMatch(yml, /ref: main|ref: refs\/heads|ref: \$\{\{ github\.ref/);
  const rec = readFileSync(join(ROOT, ".github/workflows/e7-hosted-recording.yml"), "utf8");
  const pins = (s) => [...new Set([...s.matchAll(/uses: (actions\/[a-z-]+@[0-9a-f]{40})/g)].map((m) => m[1]))].sort();
  assert.deepEqual(pins(yml), pins(rec)); assert.equal(count(/uses: /g), 11);
  assert.equal(count(/node-version: "22\.22\.0"\n          package-manager-cache: false/g), 4);
  assert.doesNotMatch(jobs.arm, /environment:|secrets\.|tooling|npm |curl |: write/, "the arm job: no environment, no secret, no tooling");
  assert.doesNotMatch(jobs.preflight, /environment:|secrets\.|needs:|npm |curl |E7_CA_FILE/);
  assert.equal(R.CONSTANTS.toolingCommit, PIN);
  assert.ok(!yml.includes(OLD_PIN) && !yml.includes("d322d219"), "C55: the old tooling pin appears nowhere in the workflow");
  assert.equal(yml.split(`ref: ${PIN}`).length - 1, 3, "every tooling checkout uses the exact immutable ref");
  assert.equal(yml.split(`E7_TOOLING_PIN: ${PIN}`).length - 1, 3, "every tooling-pin binding is the exact ref");
});

test("W3 static: execute job needs preflight (+ detect) AND (manual execute with detect SKIPPED | detect flow with detect outcome ONE) && main AND (C119 S4) the isolated environment e7-test-auto + fresh admission; step order: checkouts → node → bindings re-check → runner verify (SHIPPED CLOSED refuses HERE, before any secret step) → npm ci → CA fetch → the ONE execute step LAST", () => {
  assert.ok(jobs.execute.startsWith("\n  execute:\n    needs: [preflight, arm, detect]\n    if: ${{ !cancelled() && github.ref == 'refs/heads/main' && needs.preflight.result == 'success' && needs.arm.result == 'success' && needs.arm.outputs.armed == 'true' && ((github.event_name == 'workflow_dispatch' && inputs.mode == 'execute' && needs.detect.result == 'skipped') || ((inputs.mode == 'detect' || github.event_name == 'schedule') && needs.detect.result == 'success' && needs.detect.outputs.outcome == 'ONE')) }}\n    runs-on: ubuntu-24.04\n    environment: e7-test-auto\n    timeout-minutes: 10\n"), "execute routing");
  // C119 S4: both gated jobs use the ISOLATED TEST environment e7-test-auto (owner-created before any armed run; arm-gated, so never auto-created
  // while unarmed); the existing reviewer-gated e7-readonly-probe is no longer referenced here
  assert.equal(count(/environment: /g), 2); assert.equal(count(/environment: e7-test-auto\n/g), 2); assert.doesNotMatch(yml, /e7-readonly-probe/);
  const p3e = jobs.execute.slice(jobs.execute.indexOf("- name: Fresh admission"), jobs.execute.indexOf("- name: Verify (runner"));
  assert.match(p3e, /\n        env:\n          FRESH_SHA: \$\{\{ github\.sha \}\}\n          FRESH_TOKEN: \$\{\{ github\.token \}\}\n        run: \|\n/); assert.doesNotMatch(p3e, /secrets\.|E7_/);
  assert.equal(count(/github\.token/g), 2, "the built-in token ONLY in the two fresh-admission steps (never in a provider-secret step)");
  assert.deepEqual(steps(jobs.execute).map((s) => s.split(" (")[0]), ["Checkout wrapper", "Checkout merged E7 tooling", "Set up Node 22.22.0", "Re-check bindings BEFORE any secret",
    "Fresh admission", "Verify", "Install the pinned dependency from the verified lockfile", "Fetch the public Supabase CA", "ONE bound gn-v2 booking confirmation"]);
  assert.match(jobs.execute, /working-directory: tooling\n        run: npm ci --ignore-scripts --omit=dev --no-audit --no-fund\n/);
  assert.equal(count(/curl --fail --silent --show-error --proto '=https' --max-time 20 -o "\$RUNNER_TEMP\/prod-ca-2021\.crt" https:\/\/supabase-downloads\.s3-ap-southeast-1\.amazonaws\.com\/prod\/ssl\/prod-ca-2021\.crt\n/g), 2, "detect + execute");
  assert.deepEqual(steps(jobs.preflight).map((s) => s.split(" (")[0]), ["Checkout wrapper", "Checkout merged E7 tooling", "Set up Node 22.22.0", "Verify checkout bindings", "Preflight", "Source digest"]);
});

test("W4 static: the ONLY secrets (existing NAMES E7_DEV_BOOKING_DATABASE_URL and E7_RESEND_TEST_KEY) appear exactly once each, in the env of the LAST execute step, whose run is exactly the one `execute` command; no Hostaway / Stripe secret; no expression interpolation inside any run; every E7_* env name is an admitted runner key", () => {
  assert.equal(count(/secrets\./g), 3); assert.equal(count(/\$\{\{ secrets\.E7_DEV_BOOKING_DATABASE_URL \}\}/g), 2); assert.equal(count(/\$\{\{ secrets\.E7_RESEND_TEST_KEY \}\}/g), 1);
  assert.doesNotMatch(jobs.detect, /E7_RESEND_TEST_KEY|createResendExchange/, "C119 S1: the detect job never sees the Resend key");
  const dlast = jobs.detect.slice(jobs.detect.lastIndexOf("      - name: "));
  assert.match(dlast, /^      - name: ONE read-only detection[^\n]*\n        id: detect\n        env:\n(?:          [A-Z0-9_]+: [^\n]+\n)+        run: node wrapper\/scripts\/e7-hosted-booking-confirmation\.mjs detect\n$/);
  assert.match(dlast, /          E7_DEV_BOOKING_DATABASE_URL: \$\{\{ secrets\.E7_DEV_BOOKING_DATABASE_URL \}\}\n        run:/);
  const last = yml.slice(yml.lastIndexOf("      - name: "));
  assert.match(last, /^      - name: ONE bound gn-v2 booking confirmation[^\n]*\n        env:\n(?:          [A-Z0-9_]+: [^\n]+\n)+        run: node wrapper\/scripts\/e7-hosted-booking-confirmation\.mjs execute\n$/);
  assert.match(last, /          E7_DEV_BOOKING_DATABASE_URL: \$\{\{ secrets\.E7_DEV_BOOKING_DATABASE_URL \}\}\n          E7_RESEND_TEST_KEY: \$\{\{ secrets\.E7_RESEND_TEST_KEY \}\}\n        run:/);
  assert.equal(count(/e7-hosted-booking-confirmation\.mjs execute\n/g), 1); assert.equal(count(/e7-hosted-booking-confirmation\.mjs verify\n/g), 2); assert.equal(count(/e7-hosted-booking-confirmation\.mjs preflight\n/g), 1);
  assert.equal(count(/e7-hosted-booking-confirmation\.mjs detect\n/g), 1);
  assert.doesNotMatch(yml, /E7_HOSTAWAY_TOKEN|E7_STRIPE|api\.stripe\.com|api\.hostaway\.com|delivered@resend\.dev|E7_RECIPIENT|E7_SENDER/);
  for (const blk of yml.split(/\n      - name: /).slice(1)) { const r = blk.match(/\n        run: \|\n((?:          .*\n)+)|\n        run: (.*)\n/); if (r) assert.doesNotMatch(r[1] ?? r[2], /\$\{\{/, "no expression interpolation inside run"); }
  const envKeys = [...yml.matchAll(/^          (E7_[A-Z0-9_]+):/gm)].map((m) => m[1]);
  for (const k of envKeys) if (k !== "E7_TOOLING_PIN" && k !== "E7_MODE" && k !== "E7_BINDINGS") assert.ok(R.ALLOWED_E7_KEYS.includes(k), `${k} is an admitted runner key`);
  assert.equal(count(new RegExp(FILES.map((f) => f.replace(/[.\/]/g, "\\$&")).join(" "), "g")), 3, "digest file list identical in all three jobs, documented order");
  assert.equal(R.CONSTANTS.executeEnabled, true, "C120 ACTIVATION ENABLE: verify proceeds to the exact bindings (the CLOSE companion restores false)");
});

// ---- LOCAL execution of the gate blocks ----------------------------------------------------------------------------------------------
const headSha = execFileSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const toolSha = execFileSync("git", ["-C", TOOLING, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
function sandbox() { const d = mkdtempSync(join(tmpdir(), "e7-c50-")); symlinkSync(ROOT, join(d, "wrapper")); symlinkSync(TOOLING, join(d, "tooling")); return d; }
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
  assert.equal(toolSha, PIN, "E7_TOOLING_DIR must be the pinned 66133a22 checkout");
  const d = sandbox(); try {
    const bind = runBlock("Verify checkout bindings (wrapper HEAD == dispatch SHA; tooling HEAD == pin; no secrets)");
    for (const mode of ["preflight", "detect", "execute"]) { const ok = sh(bind, { E7_WORKFLOW_SHA: headSha, E7_TOOLING_PIN: PIN, E7_MODE: mode }, d); assert.equal(ok.status, 0, ok.out); }
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
    const blk = runBlock("Re-check bindings BEFORE any secret (HEAD == dispatch SHA; tooling pin; flow bindings; expected digests 64-hex; source digest)");
    assert.doesNotMatch(blk, /E7_DEV_BOOKING_DATABASE_URL|E7_RESEND_TEST_KEY|\.mjs execute|secrets\./); const want = await expectedDigest();
    const base = { E7_WORKFLOW_SHA: headSha, E7_TOOLING_PIN: PIN, E7_INPUT_MODE: "manual", E7_APPROVAL_REF: "ROOT-C50-label", E7_EXPECTED_PLAN_HASH: "a".repeat(64), E7_EXPECTED_CANDIDATE_FINGERPRINT: "",
      E7_EXPECTED_SOURCE_DIGEST: want, E7_EXPECTED_CLOSURE_DIGEST: R.CONSTANTS.closureDigest };
    const ok = sh(blk, base, d); assert.equal(ok.status, 0, ok.out); assert.match(ok.out, new RegExp(`bindings ok: wrapper=${headSha} tooling=${PIN} source=${want}`));
    for (const [over, why] of [[{ E7_WORKFLOW_SHA: "0".repeat(40) }, /wrapper HEAD != dispatch SHA/], [{ E7_TOOLING_PIN: "1".repeat(40) }, /tooling HEAD != pin/], [{ E7_APPROVAL_REF: "" }, /approval_ref empty/],
      [{ E7_EXPECTED_PLAN_HASH: "" }, /not 64-hex/], [{ E7_EXPECTED_CLOSURE_DIGEST: "XYZ" }, /not 64-hex/], [{ E7_EXPECTED_SOURCE_DIGEST: "f".repeat(64) }, /expected_source_digest mismatch/],
      [{ E7_EXPECTED_CANDIDATE_FINGERPRINT: "a".repeat(64) }, /fingerprint in a manual flow/], [{ E7_INPUT_MODE: "auto" }, /REFUSED: flow/]]) {
      const r = sh(blk, { ...base, ...over }, d); assert.deepEqual([r.status, why.test(r.out)], [3, true], JSON.stringify(over) + r.out);
    }
    // C119 S1 detect flow: no label / plan hash; the detect job's fingerprint must be 64-hex
    const dflow = { ...base, E7_INPUT_MODE: "detect", E7_APPROVAL_REF: "", E7_EXPECTED_PLAN_HASH: "", E7_EXPECTED_CANDIDATE_FINGERPRINT: "b".repeat(64) };
    const okd = sh(blk, dflow, d); assert.equal(okd.status, 0, okd.out);
    for (const [over, why] of [[{ E7_APPROVAL_REF: "x" }, /takes no label/], [{ E7_EXPECTED_PLAN_HASH: "a".repeat(64) }, /takes no label/], [{ E7_EXPECTED_CANDIDATE_FINGERPRINT: "" }, /not 64-hex/],
      [{ E7_EXPECTED_CANDIDATE_FINGERPRINT: "B".repeat(64) }, /not 64-hex/]]) {
      const r = sh(blk, { ...dflow, ...over }, d); assert.deepEqual([r.status, why.test(r.out)], [3, true], JSON.stringify(over) + r.out);
    }
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("W7 untouched: the five reviewed runners (executeEnabled false, digests unchanged), the C47 inspection runner (889d6a31… since C65; was e822a4d6…), the charge-list probe (43715872…) and the Resend sink probe (aef26da9… since C65; was 10c988a3…) source digests; the new files are in no other frame", async () => {
  const want = { reservation: "5665544de105e4564a57a4434fa32fd2355b9bbd0e756b250d1248e07feb6b19", capture: "5b547a42200b452055d8a718c84ab70f7f2b5a0cd8343f6174c4a75b0c420ed1",
    "test-cleanup": "33f2ab18984dccd3915a18ff8a55dd4a6e5b6bf89e3d84ba1e578347e6cebd1e", recording: "49b5516cb69543a6bd4a697a407d2f2a97a84e18a63f18715338f099917e4824",
    "recorded-cleanup": "9e2021e3ec96bab16869fc194adac672287d559587b2cb7657738ffcd897de1f" };
  for (const n of Object.keys(want)) {
    const m = await import(`../scripts/e7-hosted-${n}.mjs`);
    assert.equal(m.CONSTANTS.executeEnabled, false, n); assert.ok(!m.CONSTANTS.runnerFiles.some((f) => FILES.includes(f)), n);
    assert.equal(await R.framedDigest(ROOT, m.CONSTANTS.runnerFiles, m.RUNNER_DIGEST_PREFIX), want[n], n);
  }
  const I = await import("../scripts/e7-hosted-notify-inspect.mjs");
  assert.equal(await R.framedDigest(ROOT, I.CONSTANTS.runnerFiles, I.SOURCE_DIGEST_PREFIX), "889d6a31af4249cede0bf8b64360b5ca0e7ca2d994c4c882f0348e5f57c2c8e7", "C47/C48 inspection runner unchanged (889d6a31… since C65 cross-pin maintenance; was e822a4d6…)");
  assert.ok(!I.CONSTANTS.runnerFiles.some((f) => FILES.includes(f)));
  assert.equal(await R.framedDigest(ROOT, ["scripts/e7-hosted-charge-list-probe.mjs", "test/e7-hosted-charge-list-probe.test.mjs", ".github/workflows/e7-hosted-charge-list-probe.yml"], "e7-hosted-charge-list-probe-v1\n"), "43715872ddb450889286880c848acefd8757da6fe33bc5c6a3a547bd27219cf3");
  assert.equal(await R.framedDigest(ROOT, ["scripts/e7-resend-sink-probe.mjs", "scripts/e7-resend/resend-exchange.mjs", "test/e7-resend-sink-probe.test.mjs", ".github/workflows/e7-resend-sink-probe.yml"], "e7-resend-sink-probe-v1\n"), "aef26da954d986dc2d922b607d391be404dd73f1145ece0ae66ea0d80673ade4");
});

test("W8 C119 S1 detect job: needs preflight, mode == 'detect' && main, environment e7-test-auto + fresh admission (C119 S4); steps checkouts → node → the pre-secret re-check (executed locally: no binding input, 64-hex digests, exact source) → runner verify of the detect flow (SHIPPED CLOSED refuses HERE) → npm ci → CA → the ONE read-only detection LAST (DB secret only); declared outputs outcome + fingerprint ONLY; the execute steps receive the flow + fingerprint", async () => {
  assert.match(jobs.detect, /^\n  detect:\n    needs: \[preflight, arm\]\n    if: \(inputs\.mode == 'detect' \|\| github\.event_name == 'schedule'\) && github\.ref == 'refs\/heads\/main' && needs\.arm\.outputs\.armed == 'true'\n    runs-on: ubuntu-24\.04\n    environment: e7-test-auto\n    timeout-minutes: 10\n    outputs:\n      outcome: \$\{\{ steps\.detect\.outputs\.outcome \}\}\n      fingerprint: \$\{\{ steps\.detect\.outputs\.fingerprint \}\}\n    steps:\n/);
  assert.deepEqual(steps(jobs.detect).map((s) => s.split(" (")[0].split(",")[0]), ["Checkout wrapper", "Checkout merged E7 tooling", "Set up Node 22.22.0", "Re-check bindings BEFORE the DB secret",
    "Fresh admission", "Verify", "Install the pinned dependency from the verified lockfile", "Fetch the public Supabase CA", "ONE read-only detection"]);
  // C119 S4: the built-in token appears ONLY in the fresh-admission step (contents: read; never with the DB secret); nothing else in detect holds it
  const p3d = jobs.detect.slice(jobs.detect.indexOf("- name: Fresh admission"), jobs.detect.indexOf("- name: Verify, detect flow"));
  assert.match(p3d, /\n        env:\n          FRESH_SHA: \$\{\{ github\.sha \}\}\n          FRESH_TOKEN: \$\{\{ github\.token \}\}\n        run: \|\n/); assert.doesNotMatch(p3d, /secrets\.|E7_/);
  assert.doesNotMatch(jobs.detect.replace(p3d, ""), /E7_INTENT_ID|E7_OP_ID|E7_EXPECTED_VERSION|E7_LOCALE|E7_APPROVAL_REF|E7_EXPECTED_PLAN_HASH|github\.token|: write/, "no binding input reaches the runner, no token outside the fresh-admission step");
  const vstep = jobs.detect.slice(jobs.detect.indexOf("      - name: Verify, detect flow"), jobs.detect.indexOf("      - name: Install"));
  assert.match(vstep, /          E7_INPUT_MODE: detect\n/); assert.doesNotMatch(vstep, /secrets\./);
  assert.ok(jobs.detect.indexOf("mjs verify") < jobs.detect.indexOf("secrets."), "the runner's CLOSED verify runs before the only secret step");
  for (const step of ["      - name: Verify (runner;", "      - name: ONE bound gn-v2 booking confirmation"]) {
    const blk = jobs.execute.slice(jobs.execute.indexOf(step)); assert.match(blk, /\n          E7_INPUT_MODE: \$\{\{ \(inputs\.mode == 'detect' \|\| github\.event_name == 'schedule'\) && 'detect' \|\| 'manual' \}\}\n          E7_EXPECTED_CANDIDATE_FINGERPRINT: \$\{\{ needs\.detect\.outputs\.fingerprint \}\}\n/, step);
  }
  const d = sandbox(); try {
    const blk = runBlock("Re-check bindings BEFORE the DB secret, detect (HEAD == dispatch SHA; tooling pin; no binding input; expected digests 64-hex; source digest)");
    assert.doesNotMatch(blk, /E7_DEV_BOOKING_DATABASE_URL|E7_RESEND_TEST_KEY|\.mjs detect|secrets\./); const want = await expectedDigest();
    const base = { E7_WORKFLOW_SHA: headSha, E7_TOOLING_PIN: PIN, E7_BINDINGS: "", E7_EXPECTED_SOURCE_DIGEST: want, E7_EXPECTED_CLOSURE_DIGEST: R.CONSTANTS.closureDigest };
    const ok = sh(blk, base, d); assert.equal(ok.status, 0, ok.out); assert.match(ok.out, new RegExp(`bindings ok: wrapper=${headSha} tooling=${PIN} source=${want}`));
    for (const [over, why] of [[{ E7_WORKFLOW_SHA: "0".repeat(40) }, /wrapper HEAD != dispatch SHA/], [{ E7_TOOLING_PIN: "1".repeat(40) }, /tooling HEAD != pin/], [{ E7_BINDINGS: "x" }, /takes no binding input/],
      [{ E7_EXPECTED_CLOSURE_DIGEST: "" }, /not 64-hex/], [{ E7_EXPECTED_SOURCE_DIGEST: "f".repeat(64) }, /expected_source_digest mismatch/]]) {
      const r = sh(blk, { ...base, ...over }, d); assert.deepEqual([r.status, why.test(r.out)], [3, true], JSON.stringify(over) + r.out);
    }
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- C119 S2: the TEST arm + the draft schedule (REAL expressions) ---------------------------------------------------------------------------
function jobIf(job) {
  const m = job.match(/\n    if: (.*)\n/); assert.ok(m, "job has if"); let e = m[1].trim();
  if (e.startsWith("${{")) e = e.replace(/^\$\{\{\s*/, "").replace(/\s*\}\}$/, "");
  assert.match(e, /^[a-zA-Z0-9_.'()!&|= \/-]+$/, "only the reviewed operators / literals");
  const js = e.replace(/==/g, "===").replace(/!===/g, "!==").replace(/\bcancelled\(\)/g, "ctx.cancelled()").replace(/\b(inputs|github|needs)\./g, "ctx.$1.");
  const explicit = /\b(cancelled|always|success|failure)\(\)/.test(e);
  const fn = new Function("ctx", `return (${js});`);
  return (ctx, needs) => (explicit ? true : needs.every((n) => ctx.needs[n].result === "success")) && fn(ctx) === true;
}
function evalExpr(raw, ctx) {
  const e = raw.replace(/^\$\{\{\s*/, "").replace(/\s*\}\}$/, "");
  assert.match(e, /^[a-zA-Z0-9_.'()|&= -]+$/, "only the reviewed operators / literals");
  return new Function("ctx", `return (${e.replace(/==/g, "===").replace(/\b(github|inputs|vars|needs)\./g, "ctx.$1.")});`)(ctx);
}
const stepEnv = (key, text = yml) => [...new Set([...text.matchAll(new RegExp(`^          ${key}: (.*)$`, "gm"))].map((m) => m[1]))];

test("W9 C119 S2 arm job + routing truth table (REAL expressions): every non-preflight route (schedule, manual detect, manual execute) needs the arm job's armed == 'true'; NOT armed / arm failed / skipped / cancelled reaches NO environment job (CLOSED_NOOP, no manual bypass); manual preflight needs no arm; a schedule is ALWAYS the detect flow and never the manual execute path", () => {
  assert.match(jobs.arm, /^\n  arm:\n    needs: preflight\n    if: github\.event_name == 'schedule' \|\| inputs\.mode == 'detect' \|\| inputs\.mode == 'execute'\n    runs-on: ubuntu-24\.04\n    timeout-minutes: 5\n    outputs:\n      armed: \$\{\{ steps\.arm\.outputs\.armed \}\}\n      confirmation: \$\{\{ steps\.arm\.outputs\.confirmation \}\}\n    steps:\n/);
  assert.deepEqual(steps(jobs.arm).map((s) => s.split(" (")[0]), ["Checkout wrapper", "Set up Node 22.22.0", "TEST arm gate"]);
  assert.match(jobs.arm, /        id: arm\n        env:\n          E7_TEST_ARM: \$\{\{ vars\.E7_TEST_AUTO_ARMED \}\}\n        run: node wrapper\/scripts\/e7-test-arm\.mjs check\n/);
  const ifArm = jobIf(jobs.arm); const ifDetect = jobIf(jobs.detect); const ifExec = jobIf(jobs.execute);
  const ctx = ({ mode, ev = "workflow_dispatch", ref = "refs/heads/main", pre = "success", arm = "success", armed = "true", det = "skipped", outcome = "", cancelled = false }) =>
    ({ inputs: ev === "schedule" ? {} : { mode }, github: { ref, event_name: ev }, cancelled: () => cancelled,
      needs: { preflight: { result: pre }, arm: { result: arm, outputs: { armed } }, detect: { result: det, outputs: { outcome } } } });
  const run = (o) => { const c = ctx(o); return { arm: ifArm(c, ["preflight"]), detect: ifDetect(c, ["preflight", "arm"]), execute: ifExec(c, ["preflight", "arm", "detect"]) }; };
  const cases = [
    [{ mode: "preflight", arm: "skipped", armed: "" }, { arm: false, detect: false, execute: false }],
    [{ mode: "execute" }, { arm: true, detect: false, execute: true }],
    [{ mode: "execute", armed: "false" }, { arm: true, detect: false, execute: false }],                         // no manual bypass
    [{ mode: "execute", arm: "failure", armed: "" }, { arm: true, detect: false, execute: false }],
    [{ mode: "execute", ref: "refs/heads/x" }, { arm: true, detect: false, execute: false }],
    [{ mode: "detect" }, { arm: true, detect: true, execute: false }],
    [{ mode: "detect", det: "success", outcome: "ONE" }, { arm: true, detect: true, execute: true }],
    [{ mode: "detect", det: "success", outcome: "NONE" }, { arm: true, detect: true, execute: false }],
    [{ mode: "detect", det: "failure", outcome: "STOP" }, { arm: true, detect: true, execute: false }],
    [{ mode: "detect", armed: "false" }, { arm: true, detect: false, execute: false }],
    [{ mode: "detect", det: "skipped" }, { arm: true, detect: true, execute: false }],
    [{ ev: "schedule" }, { arm: true, detect: true, execute: false }],
    [{ ev: "schedule", det: "success", outcome: "ONE" }, { arm: true, detect: true, execute: true }],
    [{ ev: "schedule", det: "success", outcome: "ONE", cancelled: true }, { arm: true, detect: true, execute: false }],
    [{ ev: "schedule", armed: "false" }, { arm: true, detect: false, execute: false }],                          // CLOSED_NOOP tick: 0 approvals
    [{ ev: "schedule", armed: "", arm: "failure" }, { arm: true, detect: false, execute: false }],
    [{ ev: "schedule", armed: "true", arm: "cancelled", det: "success", outcome: "ONE" }, { arm: true, detect: false, execute: false }],
    [{ ev: "schedule", det: "skipped" }, { arm: true, detect: true, execute: false }],                            // never the manual path
    [{ ev: "schedule", ref: "refs/heads/x", det: "success", outcome: "ONE" }, { arm: true, detect: false, execute: false }],
    [{ ev: "schedule", pre: "failure" }, { arm: false, detect: false, execute: false }]];
  for (const [o, want] of cases) assert.deepEqual(run(o), want, JSON.stringify(o));
});

test("W10 C119 S2 schedule routing (REAL expressions): schedule → mode / flow 'detect', source = the arm job's RECOMPUTED confirmation frame, closure = the pinned literal; manual inputs unchanged; the ONLY variable is vars.E7_TEST_AUTO_ARMED (arm job + every runner step in the environment jobs); E7_TEST_ARM is an admitted runner key (the runners check the SUPPLIED value; GitHub's refresh timing for queued jobs is not asserted)", () => {
  assert.deepEqual(stepEnv("E7_MODE"), ["${{ github.event_name == 'schedule' && 'detect' || inputs.mode }}"]);
  assert.deepEqual(stepEnv("E7_INPUT_MODE"), ["detect", "${{ (inputs.mode == 'detect' || github.event_name == 'schedule') && 'detect' || 'manual' }}"]);
  assert.deepEqual(stepEnv("E7_EXPECTED_SOURCE_DIGEST", jobs.preflight), ["${{ inputs.expected_source_digest }}"], "the manual preflight digest check is unchanged (a schedule passes none: printed only)");
  const gated = jobs.detect + jobs.execute; const src = stepEnv("E7_EXPECTED_SOURCE_DIGEST", gated); const clo = stepEnv("E7_EXPECTED_CLOSURE_DIGEST", gated);
  assert.deepEqual(src, ["${{ github.event_name == 'schedule' && needs.arm.outputs.confirmation || inputs.expected_source_digest }}"]);
  assert.deepEqual(clo, [`\${{ github.event_name == 'schedule' && '${R.CONSTANTS.closureDigest}' || inputs.expected_closure_digest }}`]);
  assert.deepEqual(stepEnv("E7_TEST_ARM"), ["${{ vars.E7_TEST_AUTO_ARMED }}"]);
  const nc = yml.replace(/^#.*$/gm, ""); assert.equal((nc.match(/vars\./g) || []).length, 5, "arm job + detect verify / detect + execute verify / execute");
  assert.doesNotMatch(nc, /vars\.(?!E7_TEST_AUTO_ARMED\b)|secrets\.E7_TEST/);
  assert.ok(R.ALLOWED_E7_KEYS.includes("E7_TEST_ARM"));
  const frame = "c".repeat(64); const man = "d".repeat(64);
  const sched = { github: { event_name: "schedule" }, inputs: {}, needs: { arm: { outputs: { confirmation: frame } } } };
  const manual = (mode) => ({ github: { event_name: "workflow_dispatch" }, inputs: { mode, expected_source_digest: man, expected_closure_digest: "e".repeat(64) }, needs: { arm: { outputs: { confirmation: frame } } } });
  assert.equal(evalExpr(stepEnv("E7_MODE")[0], sched), "detect"); assert.equal(evalExpr(stepEnv("E7_INPUT_MODE")[1], sched), "detect");
  assert.equal(evalExpr(src[0], sched), frame); assert.equal(evalExpr(clo[0], sched), R.CONSTANTS.closureDigest);
  assert.equal(evalExpr(src[0], { ...sched, needs: { arm: { outputs: { confirmation: "" } } } }), undefined, "not armed → no frame (and the environment jobs are skipped anyway)");
  for (const m of ["detect", "execute"]) { assert.equal(evalExpr(src[0], manual(m)), man); assert.equal(evalExpr(clo[0], manual(m)), "e".repeat(64)); }
  assert.equal(evalExpr(stepEnv("E7_INPUT_MODE")[1], manual("execute")), "manual"); assert.equal(evalExpr(stepEnv("E7_INPUT_MODE")[1], manual("detect")), "detect");
  for (const job of [jobs.detect, jobs.execute]) for (const step of job.split("\n      - name: ").slice(1)) if (/e7-hosted-booking-confirmation\.mjs (verify|detect|execute)\n/.test(step))
    assert.match(step, /\n          E7_TEST_ARM: \$\{\{ vars\.E7_TEST_AUTO_ARMED \}\}\n/, "every runner step re-checks the arm value it is SUPPLIED (the vars refresh timing for queued jobs is UNVERIFIED, not relied on)");
});
