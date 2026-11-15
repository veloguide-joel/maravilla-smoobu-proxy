// test/e7-hosted-notify-inspect-workflow.test.mjs — C47: regression test for .github/workflows/e7-hosted-notify-inspect.yml. Static assertions on the
// workflow bytes + LOCAL execution of its gate shell blocks (extracted from the YAML, run with bash against symlinked wrapper / tooling dirs).
// Zero network, zero secrets: the ONE inspect step is never executed here (only asserted); every real network primitive is a throwing guard.
// Also pins that the five reviewed runners, the charge-list probe and the Resend sink probe are byte-unchanged.
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
const R = await import("../scripts/e7-hosted-notify-inspect.mjs");
after(() => { assert.deepEqual(GUARD, { request: 0, Agent: 0, fetch: 0 }, "no real network primitive was touched"); });

const WF = ".github/workflows/e7-hosted-notify-inspect.yml";
const yml = readFileSync(join(ROOT, WF), "utf8");
const PIN = "d322d2192b377d18b6a9280ae06c17eddfe3e73e";
const PREFIX = "e7-hosted-notify-inspect-v1\n";
const FILES = ["scripts/e7-hosted-notify-inspect.mjs", "test/e7-hosted-notify-inspect.test.mjs", "test/e7-hosted-notify-inspect-workflow.test.mjs", WF];
const count = (re) => (yml.match(re) || []).length;
function runBlock(stepName) {
  const i = yml.indexOf(`- name: ${stepName}`); assert.ok(i >= 0, stepName);
  const rest = yml.slice(i); const m = rest.match(/\n        run: \|\n((?:          .*\n)+)/); assert.ok(m, `run block of ${stepName}`);
  return m[1].split("\n").map((l) => l.replace(/^ {10}/, "")).join("\n");
}
const jobs = { preflight: yml.slice(yml.indexOf("\n  preflight:\n"), yml.indexOf("\n  inspect:\n")), inspect: yml.slice(yml.indexOf("\n  inspect:\n")) };
const steps = (job) => [...job.matchAll(/\n      - name: ([^\n]+)/g)].map((m) => m[1]);

test("W1 static: workflow_dispatch ONLY; inputs exactly mode (choice [preflight, inspect], default preflight) / approval_ref / intent_id / op_id / expected_version / three expected digests — NO contact / sender / recipient / body / locale input; permissions contents: read; concurrency cancel-in-progress false; runner FILES = the documented frame", () => {
  assert.match(yml, /^on:\n  workflow_dispatch:\n    inputs:\n      mode:\n/m); assert.doesNotMatch(yml, /\n  (push|pull_request|pull_request_target|schedule|workflow_call|repository_dispatch):/);
  assert.match(yml, /      mode:\n(?:        .*\n)*?        type: choice\n        options: \[preflight, inspect\]\n        default: preflight\n/);
  assert.deepEqual([...yml.matchAll(/^      ([a-z_]+):\n        description/gm)].map((m) => m[1]),
    ["mode", "approval_ref", "intent_id", "op_id", "expected_version", "expected_plan_hash", "expected_source_digest", "expected_closure_digest"]);
  assert.doesNotMatch(yml.slice(0, yml.indexOf("\npermissions:")).replace(/^#.*$/gm, ""), /recipient|sender|email|subject|body|locale|to_address/i);
  assert.match(yml, /\npermissions:\n  contents: read\n\n/); assert.equal(count(/permissions:/g), 1); assert.doesNotMatch(yml, /: write|id-token:|pull-requests:|packages:|deployments:|issues:|checks:|statuses:/);
  assert.match(yml, /\nconcurrency:\n  group: e7-hosted-notify-inspect\n  cancel-in-progress: false\n/);
  assert.deepEqual([...yml.matchAll(/^  ([a-z-]+):\n    (?:needs|runs-on|if)/gm)].map((m) => m[1]), ["preflight", "inspect"]);
  assert.equal(count(/runs-on: ubuntu-24\.04/g), 2); assert.equal(count(/timeout-minutes: 10\n/g), 2);
  assert.deepEqual([...R.CONSTANTS.runnerFiles], FILES);
});

test("W2 static: checkouts at the EXACT dispatch SHA + the immutable tooling pin d322d219 (persist-credentials false), the same reviewed action pins as e7-hosted-recording.yml, Node 22.22.0; the preflight job has no environment / secret / npm / curl", () => {
  assert.equal(count(/ref: \$\{\{ github\.sha \}\}\n          path: wrapper\n          persist-credentials: false/g), 2);
  assert.equal(count(new RegExp(`repository: veloguide-joel/maravilla-smoobu-proxy\\n          ref: ${PIN}\\n          path: tooling\\n          persist-credentials: false`, "g")), 2);
  assert.equal(count(/persist-credentials: false/g), 4); assert.doesNotMatch(yml, /ref: main|ref: refs\/heads|ref: \$\{\{ github\.ref/);
  const rec = readFileSync(join(ROOT, ".github/workflows/e7-hosted-recording.yml"), "utf8");
  const pins = (s) => [...new Set([...s.matchAll(/uses: (actions\/[a-z-]+@[0-9a-f]{40})/g)].map((m) => m[1]))].sort();
  assert.deepEqual(pins(yml), pins(rec)); assert.equal(count(/uses: /g), 6);
  assert.equal(count(/node-version: "22\.22\.0"\n          package-manager-cache: false/g), 2);
  assert.doesNotMatch(jobs.preflight, /environment:|secrets\.|needs:|npm |curl |E7_CA_FILE/);
  assert.equal(R.CONSTANTS.toolingCommit, PIN);
});

test("W3 static: inspect job needs preflight AND mode == 'inspect' && main AND environment e7-readonly-probe (the only environment); step order: checkouts → node → bindings re-check → runner verify → npm ci (lockfile, no scripts) → CA fetch → the ONE inspect step LAST", () => {
  assert.match(jobs.inspect, /^\n  inspect:\n    needs: preflight\n    if: inputs\.mode == 'inspect' && github\.ref == 'refs\/heads\/main'\n    runs-on: ubuntu-24\.04\n    environment: e7-readonly-probe\n    timeout-minutes: 10\n/);
  assert.equal(count(/environment: /g), 1);
  assert.deepEqual(steps(jobs.inspect).map((s) => s.split(" (")[0]), ["Checkout wrapper", "Checkout merged E7 tooling", "Set up Node 22.22.0", "Re-check bindings BEFORE any secret",
    "Verify", "Install the pinned dependency from the verified lockfile", "Fetch the public Supabase CA", "ONE read-only notification admission inspection"]);
  assert.match(jobs.inspect, /working-directory: tooling\n        run: npm ci --ignore-scripts --omit=dev --no-audit --no-fund\n/);
  assert.equal(count(/curl --fail --silent --show-error --proto '=https' --max-time 20 -o "\$RUNNER_TEMP\/prod-ca-2021\.crt" https:\/\/supabase-downloads\.s3-ap-southeast-1\.amazonaws\.com\/prod\/ssl\/prod-ca-2021\.crt\n/g), 1);
  assert.deepEqual(steps(jobs.preflight).map((s) => s.split(" (")[0]), ["Checkout wrapper", "Checkout merged E7 tooling", "Set up Node 22.22.0", "Verify checkout bindings", "Preflight", "Source digest"]);
});

test("W4 static: the SOLE secret E7_DEV_BOOKING_DATABASE_URL appears exactly once, in the env of the LAST inspect step, whose run is exactly the one `inspect` command; no Hostaway / Stripe / Resend secret; no expression interpolation inside any run", () => {
  assert.equal(count(/secrets\./g), 1); assert.equal(count(/\$\{\{ secrets\.E7_DEV_BOOKING_DATABASE_URL \}\}/g), 1);
  const last = yml.slice(yml.lastIndexOf("      - name: "));
  assert.match(last, /^      - name: ONE read-only notification admission inspection[^\n]*\n        env:\n(?:          [A-Z0-9_]+: [^\n]+\n)+        run: node wrapper\/scripts\/e7-hosted-notify-inspect\.mjs inspect\n$/);
  assert.match(last, /          E7_DEV_BOOKING_DATABASE_URL: \$\{\{ secrets\.E7_DEV_BOOKING_DATABASE_URL \}\}\n        run:/);
  assert.equal(count(/e7-hosted-notify-inspect\.mjs inspect\n/g), 1); assert.equal(count(/e7-hosted-notify-inspect\.mjs verify\n/g), 1); assert.equal(count(/e7-hosted-notify-inspect\.mjs preflight\n/g), 1);
  assert.doesNotMatch(yml, /E7_HOSTAWAY_TOKEN|E7_STRIPE|E7_RESEND|api\.stripe\.com|api\.resend\.com|api\.hostaway\.com|mode=send|\bsend\b:/);
  for (const blk of yml.split(/\n      - name: /).slice(1)) { const r = blk.match(/\n        run: \|\n((?:          .*\n)+)|\n        run: (.*)\n/); if (r) assert.doesNotMatch(r[1] ?? r[2], /\$\{\{/, "no expression interpolation inside run"); }
  const envKeys = [...yml.matchAll(/^          (E7_[A-Z0-9_]+):/gm)].map((m) => m[1]);
  for (const k of envKeys) if (k !== "E7_TOOLING_PIN" && k !== "E7_MODE") assert.ok(R.ALLOWED_E7_KEYS.includes(k), `${k} is an admitted runner key`);
  assert.equal(count(new RegExp(FILES.map((f) => f.replace(/[.\/]/g, "\\$&")).join(" "), "g")), 2, "digest file list identical in both jobs, documented order");
});

// ---- LOCAL execution of the gate blocks ----------------------------------------------------------------------------------------------
const headSha = execFileSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const toolSha = execFileSync("git", ["-C", TOOLING, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
function sandbox() { const d = mkdtempSync(join(tmpdir(), "e7-c47-")); symlinkSync(ROOT, join(d, "wrapper")); symlinkSync(TOOLING, join(d, "tooling")); return d; }
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
  assert.equal(toolSha, PIN, "E7_TOOLING_DIR must be the pinned d322d219 checkout");
  const d = sandbox(); try {
    const bind = runBlock("Verify checkout bindings (wrapper HEAD == dispatch SHA; tooling HEAD == pin; no secrets)");
    for (const mode of ["preflight", "inspect"]) { const ok = sh(bind, { E7_WORKFLOW_SHA: headSha, E7_TOOLING_PIN: PIN, E7_MODE: mode }, d); assert.equal(ok.status, 0, ok.out); }
    for (const [env, why] of [[{ E7_WORKFLOW_SHA: "0".repeat(40), E7_TOOLING_PIN: PIN, E7_MODE: "preflight" }, /wrapper HEAD != dispatch SHA/],
      [{ E7_WORKFLOW_SHA: headSha, E7_TOOLING_PIN: "1".repeat(40), E7_MODE: "preflight" }, /tooling HEAD != pin/], [{ E7_WORKFLOW_SHA: headSha, E7_TOOLING_PIN: PIN, E7_MODE: "send" }, /REFUSED: mode/]]) {
      const r = sh(bind, env, d); assert.deepEqual([r.status, why.test(r.out)], [3, true], r.out);
    }
    const dig = runBlock("Source digest (deterministic framed SHA-256; documented order and prefix)"); const want = await expectedDigest();
    const r1 = sh(dig, { E7_EXPECTED_SOURCE_DIGEST: "" }, d); assert.equal(r1.status, 0, r1.out); assert.match(r1.out, new RegExp(`sourceDigest=${want}`));
    assert.equal(sh(dig, { E7_EXPECTED_SOURCE_DIGEST: want }, d).status, 0);
    const r3 = sh(dig, { E7_EXPECTED_SOURCE_DIGEST: "f".repeat(64) }, d); assert.deepEqual([r3.status, /expected_source_digest mismatch/.test(r3.out)], [3, true], r3.out);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("W6 inspect re-check block executed locally (BEFORE any secret): passes only with HEAD == dispatch SHA, tooling == pin, a non-empty approval label, three 64-hex expected digests and the expected source digest EQUAL to the actual one", async () => {
  const d = sandbox(); try {
    const blk = runBlock("Re-check bindings BEFORE any secret (HEAD == dispatch SHA; tooling pin; label; expected digests 64-hex; source digest)");
    assert.doesNotMatch(blk, /E7_DEV_BOOKING_DATABASE_URL|\.mjs inspect|secrets\./); const want = await expectedDigest();
    const base = { E7_WORKFLOW_SHA: headSha, E7_TOOLING_PIN: PIN, E7_APPROVAL_REF: "ROOT-C47-label", E7_EXPECTED_PLAN_HASH: "a".repeat(64), E7_EXPECTED_SOURCE_DIGEST: want, E7_EXPECTED_CLOSURE_DIGEST: R.CONSTANTS.closureDigest };
    const ok = sh(blk, base, d); assert.equal(ok.status, 0, ok.out); assert.match(ok.out, new RegExp(`bindings ok: wrapper=${headSha} tooling=${PIN} source=${want}`));
    for (const [over, why] of [[{ E7_WORKFLOW_SHA: "0".repeat(40) }, /wrapper HEAD != dispatch SHA/], [{ E7_TOOLING_PIN: "1".repeat(40) }, /tooling HEAD != pin/], [{ E7_APPROVAL_REF: "" }, /approval_ref empty/],
      [{ E7_EXPECTED_PLAN_HASH: "" }, /not 64-hex/], [{ E7_EXPECTED_CLOSURE_DIGEST: "XYZ" }, /not 64-hex/], [{ E7_EXPECTED_SOURCE_DIGEST: "f".repeat(64) }, /expected_source_digest mismatch/]]) {
      const r = sh(blk, { ...base, ...over }, d); assert.deepEqual([r.status, why.test(r.out)], [3, true], JSON.stringify(over) + r.out);
    }
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("W7 untouched: the five reviewed runners (executeEnabled false, digests unchanged), the charge-list probe (43715872…) and the Resend sink probe (aef26da9… since C65; was 10c988a3…) source digests; the new workflow is in no other frame", async () => {
  const want = { reservation: "5665544de105e4564a57a4434fa32fd2355b9bbd0e756b250d1248e07feb6b19", capture: "5b547a42200b452055d8a718c84ab70f7f2b5a0cd8343f6174c4a75b0c420ed1",
    "test-cleanup": "33f2ab18984dccd3915a18ff8a55dd4a6e5b6bf89e3d84ba1e578347e6cebd1e", recording: "49b5516cb69543a6bd4a697a407d2f2a97a84e18a63f18715338f099917e4824",
    "recorded-cleanup": "9e2021e3ec96bab16869fc194adac672287d559587b2cb7657738ffcd897de1f" };
  for (const n of Object.keys(want)) {
    const m = await import(`../scripts/e7-hosted-${n}.mjs`);
    assert.equal(m.CONSTANTS.executeEnabled, false, n); assert.ok(!m.CONSTANTS.runnerFiles.some((f) => FILES.includes(f)), n);
    assert.equal(await R.framedDigest(ROOT, m.CONSTANTS.runnerFiles, m.RUNNER_DIGEST_PREFIX), want[n], n);
  }
  assert.equal(await R.framedDigest(ROOT, ["scripts/e7-hosted-charge-list-probe.mjs", "test/e7-hosted-charge-list-probe.test.mjs", ".github/workflows/e7-hosted-charge-list-probe.yml"], "e7-hosted-charge-list-probe-v1\n"), "43715872ddb450889286880c848acefd8757da6fe33bc5c6a3a547bd27219cf3");
  assert.equal(await R.framedDigest(ROOT, ["scripts/e7-resend-sink-probe.mjs", "scripts/e7-resend/resend-exchange.mjs", "test/e7-resend-sink-probe.test.mjs", ".github/workflows/e7-resend-sink-probe.yml"], "e7-resend-sink-probe-v1\n"), "aef26da954d986dc2d922b607d391be404dd73f1145ece0ae66ea0d80673ade4");
});
