// test/e7-resend-sink-probe-workflow.test.mjs — C42: regression test for the NEW manual-only .github/workflows/e7-resend-sink-probe.yml.
// Static assertions on the workflow bytes + LOCAL execution of its gate shell blocks (extracted from the YAML, run with bash against symlinked
// wrapper / tooling dirs, every child `node` with a preloaded throwing network guard) proving the HEAD / pin / locale / label / run-attempt /
// source-digest / plan-hash refusals and the documented source digest frame. Zero network, zero secrets: the ONE `--send` step is never executed
// here (only asserted), and every real network primitive in this process is replaced by a throwing guard before import.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, mkdtempSync, symlinkSync, rmSync, writeFileSync, cpSync, appendFileSync } from "node:fs";
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
const { framedDigest } = await import("../scripts/e7-hosted-reservation.mjs");
const P = await import("../scripts/e7-resend-sink-probe.mjs");
after(() => { assert.deepEqual(GUARD, { request: 0, Agent: 0, fetch: 0 }, "no real network primitive was touched"); });

const WF = ".github/workflows/e7-resend-sink-probe.yml";
const yml = readFileSync(join(ROOT, WF), "utf8");
const PIN = "f05016a7af3f866e7e4d46d219a3b95934ca867c";
const PREFIX = "e7-resend-sink-probe-v1\n";
const FILES = ["scripts/e7-resend-sink-probe.mjs", "scripts/e7-resend/resend-exchange.mjs", "test/e7-resend-sink-probe.test.mjs", WF];
const count = (re) => (yml.match(re) || []).length;
function runBlock(stepName) {
  const i = yml.indexOf(`- name: ${stepName}`); assert.ok(i >= 0, stepName);
  const rest = yml.slice(i); const m = rest.match(/\n        run: \|\n((?:          .*\n)+)/); assert.ok(m, `run block of ${stepName}`);
  return m[1].split("\n").map((l) => l.replace(/^ {10}/, "")).join("\n");
}
const jobs = { preflight: yml.slice(yml.indexOf("\n  preflight:\n"), yml.indexOf("\n  send:\n")), send: yml.slice(yml.indexOf("\n  send:\n")) };

test("W1 static: workflow_dispatch ONLY; inputs exactly mode (choice [preflight, send], default preflight) / locale (choice [en, es], required, NO default) / approval_ref / expected_source_digest / expected_plan_hash; permissions contents: read only; concurrency cancel-in-progress false; exactly two jobs; both timeout 5", () => {
  assert.match(yml, /^on:\n  workflow_dispatch:\n    inputs:\n      mode:\n/m); assert.doesNotMatch(yml, /\n  (push|pull_request|pull_request_target|schedule|workflow_call|workflow_run|repository_dispatch):/);
  assert.match(yml, /      mode:\n(?:        .*\n)*?        type: choice\n        options: \[preflight, send\]\n        default: preflight\n/);
  assert.match(yml, /      locale:\n        description: [^\n]*\n        type: choice\n        options: \[en, es\]\n        required: true\n      approval_ref:/, "locale: explicit choice, no default key");
  assert.deepEqual([...yml.matchAll(/^      ([a-z_]+):\n        description/gm)].map((m) => m[1]), ["mode", "locale", "approval_ref", "expected_source_digest", "expected_plan_hash"]);
  assert.match(yml, /\npermissions:\n  contents: read\n\n/); assert.equal(count(/permissions:/g), 1); assert.doesNotMatch(yml, /: write|id-token:|pull-requests:|packages:|deployments:|issues:|checks:|statuses:|security-events:|actions:/);
  assert.match(yml, /\nconcurrency:\n  group: e7-resend-sink-probe\n  cancel-in-progress: false\n/);
  assert.deepEqual([...yml.matchAll(/^  ([a-z-]+):\n    (?:needs|runs-on|if)/gm)].map((m) => m[1]), ["preflight", "send"]);
  assert.equal(count(/timeout-minutes: 5\n/g), 2); assert.doesNotMatch(yml, /timeout-minutes: (?!5\n)/); assert.equal(count(/runs-on: ubuntu-24\.04/g), 2);
});

test("W2 static: both jobs check out the wrapper at the EXACT dispatch SHA and the tooling at the immutable pin f05016a7, persist-credentials false; the same reviewed action pins as the existing hosted workflows; Node 22.22.0 without cache; no dependency install / curl / SDK anywhere", () => {
  assert.equal(count(/ref: \$\{\{ github\.sha \}\}\n          path: wrapper\n          persist-credentials: false/g), 2);
  assert.equal(count(new RegExp(`repository: veloguide-joel/maravilla-smoobu-proxy\\n          ref: ${PIN}\\n          path: tooling\\n          persist-credentials: false`, "g")), 2);
  assert.equal(count(/persist-credentials: false/g), 4); assert.doesNotMatch(yml, /ref: main|ref: refs\/heads|ref: \$\{\{ github\.ref/);
  const pins = (s) => [...new Set([...s.matchAll(/uses: (actions\/[a-z-]+@[0-9a-f]{40})/g)].map((m) => m[1]))].sort();
  for (const other of [".github/workflows/e7-hosted-recording.yml", ".github/workflows/e7-hosted-charge-list-probe.yml"]) assert.deepEqual(pins(yml), pins(readFileSync(join(ROOT, other), "utf8")), other);
  assert.equal(count(/uses: /g), 6);
  assert.equal(count(/node-version: "22\.22\.0"\n          package-manager-cache: false/g), 2);
  assert.doesNotMatch(yml, /npm (ci|install|i )|npx|yarn|pnpm|curl|wget|resend-node|from 'resend'|supabase|DATABASE|STRIPE|HOSTAWAY|E7_CA_FILE|prod-ca/);
});

test("W3 static: send job needs preflight AND if mode == 'send' && github.ref == 'refs/heads/main' AND the EXISTING environment e7-readonly-probe (the only environment); preflight has no environment / secret / needs", () => {
  assert.match(jobs.send, /^\n  send:\n    needs: preflight\n    if: inputs\.mode == 'send' && github\.ref == 'refs\/heads\/main'\n    runs-on: ubuntu-24\.04\n    environment: e7-readonly-probe\n    timeout-minutes: 5\n/);
  assert.equal(count(/environment: /g), 1); assert.doesNotMatch(jobs.preflight, /environment:|secrets\.|needs:/);
  assert.match(jobs.preflight, /^\n  preflight:\n    runs-on: ubuntu-24\.04\n    timeout-minutes: 5\n    steps:/);
});

test("W4 static: the SOLE secret (E7_RESEND_TEST_KEY) appears exactly once, in the env of the LAST step of the send job, whose run is exactly the one --send command; no other secret; expressions reach shell only through env (no `${{` inside any run block); --send is a command once; preflight runs the focused fake tests + --dry; the re-check step has no secret", () => {
  assert.equal(count(/secrets\./g), 1); assert.equal(count(/\$\{\{ secrets\.E7_RESEND_TEST_KEY \}\}/g), 1);
  const last = yml.slice(yml.lastIndexOf("      - name: "));
  assert.match(last, /^      - name: ONE synthetic Resend sink send[^\n]*\n        env:\n          E7_TOOLING_DIR: \$\{\{ github\.workspace \}\}\/tooling\n          E7_LOCALE: \$\{\{ inputs\.locale \}\}\n          E7_EXPECTED_PLAN_HASH: \$\{\{ inputs\.expected_plan_hash \}\}\n          E7_RESEND_TEST_KEY: \$\{\{ secrets\.E7_RESEND_TEST_KEY \}\}\n        run: node wrapper\/scripts\/e7-resend-sink-probe\.mjs --send\n$/);
  assert.equal(count(/e7-resend-sink-probe\.mjs --send/g), 1);
  for (const blk of yml.split(/\n      - name: /).slice(1)) { const r = blk.match(/\n        run: \|\n((?:          .*\n)+)|\n        run: (.*)\n/); if (r) assert.doesNotMatch(r[1] ?? r[2], /\$\{\{/, "no expression interpolation inside run"); }
  assert.match(runBlock("Focused FAKE probe tests + --dry (no environment, no secrets, no network, no dependency install)"), /^set -eu\nnode --test wrapper\/test\/e7-resend-sink-probe\.test\.mjs\nnode wrapper\/scripts\/e7-resend-sink-probe\.mjs --dry\n$/);
  const recheck = runBlock("Re-check bindings BEFORE the send (HEAD == dispatch SHA; tooling pin + copy closure; source digest; plan hash; label; run attempt 1; no secrets)");
  assert.doesNotMatch(recheck, /E7_RESEND_TEST_KEY|--send/);
  assert.equal(count(new RegExp(FILES.map((f) => f.replace(/[.\/]/g, "\\$&")).join(" "), "g")), 2, "digest file list identical in both jobs, documented order");
});

// ---------------------------------------------------------------------------------------------------------------------------------
const headSha = execFileSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const toolSha = execFileSync("git", ["-C", TOOLING, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const guardDir = mkdtempSync(join(tmpdir(), "e7-c42w-guard-")); const guardFile = join(guardDir, "guard.mjs");
writeFileSync(guardFile, 'import https from "node:https"; import { syncBuiltinESMExports } from "node:module";\nconst no = () => { process.stdout.write("CHILD_NETWORK_ATTEMPT\\n"); process.exit(97); };\nhttps.request = no; https.Agent = function () { no(); }; globalThis.fetch = no; syncBuiltinESMExports();\n');
function sandbox() { const d = mkdtempSync(join(tmpdir(), "e7-c42w-")); symlinkSync(ROOT, join(d, "wrapper")); symlinkSync(TOOLING, join(d, "tooling")); return d; }
function sh(block, env, cwd) {
  const r = spawnSync("bash", ["-c", block], { cwd, encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME ?? "/tmp", NODE_OPTIONS: `--import=${guardFile}`, ...env } });
  return { status: r.status, out: (r.stdout || "") + (r.stderr || "") };
}
const expectedDigest = async () => {
  const h = createHash("sha256"); h.update(PREFIX);
  for (const f of FILES) { const b = readFileSync(join(ROOT, f)); h.update(f); h.update(Buffer.from([0])); h.update(String(b.length)); h.update(Buffer.from([0])); h.update(b); h.update(Buffer.from([0])); }
  const mine = h.digest("hex"); assert.equal(mine, await framedDigest(ROOT, FILES, PREFIX), "frame == the reviewed runners' framedDigest convention"); return mine;
};
const planHash = async (locale) => { const lt = await P.loadTooling(TOOLING); return P.buildPlan({ render: lt.render, locale }).plan.planHash; };

test("W5 preflight gate blocks executed locally: bindings pass with HEAD == dispatch SHA, tooling == pin, a known mode and locale; REFUSE (exit 3) on a foreign SHA / pin, unknown mode or locale; the digest block prints the documented framed SHA-256 and refuses a non-matching expected_source_digest", async () => {
  assert.equal(toolSha, PIN, "E7_TOOLING_DIR must be the pinned f05016a7 checkout");
  const d = sandbox(); try {
    const bind = runBlock("Verify checkout bindings (wrapper HEAD == dispatch SHA; tooling HEAD == pin; mode; locale; no secrets)");
    for (const [mode, locale] of [["preflight", "en"], ["send", "es"]]) { const ok = sh(bind, { E7_WORKFLOW_SHA: headSha, E7_TOOLING_PIN: PIN, E7_MODE: mode, E7_LOCALE: locale }, d); assert.equal(ok.status, 0, ok.out); assert.match(ok.out, /bindings ok/); }
    for (const [env, why] of [[{ E7_WORKFLOW_SHA: "0".repeat(40) }, /wrapper HEAD != dispatch SHA/], [{ E7_TOOLING_PIN: "1".repeat(40) }, /tooling HEAD != pin/], [{ E7_MODE: "probe" }, /REFUSED: mode/],
      [{ E7_LOCALE: "fr" }, /REFUSED: locale/], [{ E7_LOCALE: "" }, /REFUSED: locale/], [{ E7_LOCALE: "EN" }, /REFUSED: locale/]]) {
      const r = sh(bind, { E7_WORKFLOW_SHA: headSha, E7_TOOLING_PIN: PIN, E7_MODE: "preflight", E7_LOCALE: "en", ...env }, d); assert.deepEqual([r.status, why.test(r.out)], [3, true], r.out);
    }
    const dig = runBlock("Source digest (deterministic framed SHA-256; documented order and prefix)"); const want = await expectedDigest();
    const r1 = sh(dig, { E7_EXPECTED_SOURCE_DIGEST: "" }, d); assert.equal(r1.status, 0, r1.out); assert.match(r1.out, new RegExp(`sourceDigest=${want}`));
    assert.equal(sh(dig, { E7_EXPECTED_SOURCE_DIGEST: want }, d).status, 0);
    const r3 = sh(dig, { E7_EXPECTED_SOURCE_DIGEST: "f".repeat(64) }, d); assert.deepEqual([r3.status, /expected_source_digest mismatch/.test(r3.out)], [3, true], r3.out);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("W6 send re-check block executed locally (BEFORE the one --send call; no key in scope): passes only with HEAD, pin, locale, non-empty label, run attempt 1, a 64-hex source digest EQUAL to the actual one, and a 64-hex plan hash that the probe's own --preflight accepts (copy closure + plan + run gates); refuses (exit 3) on each violation incl. a rerun, the other locale's plan hash and a drifted tooling copy; zero network", async () => {
  const d = sandbox(); try {
    const blk = runBlock("Re-check bindings BEFORE the send (HEAD == dispatch SHA; tooling pin + copy closure; source digest; plan hash; label; run attempt 1; no secrets)");
    const want = await expectedDigest(); const en = await planHash("en"); const es = await planHash("es");
    const base = { E7_WORKFLOW_SHA: headSha, E7_TOOLING_PIN: PIN, E7_TOOLING_DIR: join(d, "tooling"), E7_LOCALE: "en", E7_APPROVAL_REF: "ROOT-C42-label", E7_EXPECTED_SOURCE_DIGEST: want,
      E7_EXPECTED_PLAN_HASH: en, GITHUB_RUN_ID: "43999000111", GITHUB_RUN_ATTEMPT: "1" };
    const ok = sh(blk, base, d); assert.equal(ok.status, 0, ok.out);
    assert.match(ok.out, /PREFLIGHT ok: PLAN locale=en /); assert.match(ok.out, new RegExp(`bindings ok: wrapper=${headSha} tooling=${PIN} digest=${want}`));
    assert.equal(sh(blk, { ...base, E7_LOCALE: "es", E7_EXPECTED_PLAN_HASH: es }, d).status, 0);
    for (const [over, why] of [[{ E7_WORKFLOW_SHA: "0".repeat(40) }, /wrapper HEAD != dispatch SHA/], [{ E7_TOOLING_PIN: "1".repeat(40) }, /tooling HEAD != pin/], [{ E7_LOCALE: "fr" }, /REFUSED: locale/],
      [{ E7_APPROVAL_REF: "" }, /approval_ref empty/], [{ GITHUB_RUN_ATTEMPT: "2" }, /run attempt is not 1/], [{ GITHUB_RUN_ATTEMPT: "" }, /run attempt is not 1/],
      [{ E7_EXPECTED_SOURCE_DIGEST: "" }, /expected_source_digest not 64-hex/], [{ E7_EXPECTED_SOURCE_DIGEST: want.toUpperCase() }, /not 64-hex/], [{ E7_EXPECTED_SOURCE_DIGEST: "f".repeat(64) }, /expected_source_digest mismatch/],
      [{ E7_EXPECTED_PLAN_HASH: "" }, /expected_plan_hash not 64-hex/], [{ E7_EXPECTED_PLAN_HASH: es }, /PLAN_HASH_MISMATCH[\s\S]*REFUSED: probe preflight/], [{ E7_EXPECTED_PLAN_HASH: "f".repeat(64) }, /REFUSED: probe preflight/],
      [{ GITHUB_RUN_ID: "x" }, /RUN_ID_INVALID[\s\S]*REFUSED: probe preflight/]]) {
      const r = sh(blk, { ...base, ...over }, d); assert.deepEqual([r.status, why.test(r.out), r.out.includes("CHILD_NETWORK_ATTEMPT")], [3, true, false], JSON.stringify(over) + r.out);
    }
    const drift = mkdtempSync(join(tmpdir(), "e7-c42w-drift-")); try {
      cpSync(join(TOOLING, "lib"), join(drift, "lib"), { recursive: true }); appendFileSync(join(drift, "lib/checkout/guest-notification.js"), "\n// drift\n");
      const r = sh(blk, { ...base, E7_TOOLING_DIR: drift }, d); assert.deepEqual([r.status, /TOOLING_CLOSURE_MISMATCH lib\/checkout\/guest-notification\.js[\s\S]*REFUSED: probe preflight/.test(r.out)], [3, true], r.out);
    } finally { rmSync(drift, { recursive: true, force: true }); }
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("W7 nothing else moves: the five reviewed runners keep executeEnabled false and their exact digests, none lists a C42 file; the charge-list probe source digest is unchanged; the new workflow uses the EXISTING environment name only", async () => {
  const want = { reservation: "5665544de105e4564a57a4434fa32fd2355b9bbd0e756b250d1248e07feb6b19", capture: "5b547a42200b452055d8a718c84ab70f7f2b5a0cd8343f6174c4a75b0c420ed1", "test-cleanup": "33f2ab18984dccd3915a18ff8a55dd4a6e5b6bf89e3d84ba1e578347e6cebd1e", recording: "49b5516cb69543a6bd4a697a407d2f2a97a84e18a63f18715338f099917e4824", "recorded-cleanup": "9e2021e3ec96bab16869fc194adac672287d559587b2cb7657738ffcd897de1f" };
  for (const n of Object.keys(want)) {
    const m = await import(`../scripts/e7-hosted-${n}.mjs`);
    assert.equal(m.CONSTANTS.executeEnabled, false, n);
    for (const f of [...FILES, "test/e7-resend-sink-probe-workflow.test.mjs"]) assert.ok(!m.CONSTANTS.runnerFiles.includes(f), `${n}: ${f}`);
    assert.equal(await framedDigest(ROOT, m.CONSTANTS.runnerFiles, m.RUNNER_DIGEST_PREFIX), want[n], n);
  }
  const probeFiles = ["scripts/e7-hosted-charge-list-probe.mjs", "test/e7-hosted-charge-list-probe.test.mjs", ".github/workflows/e7-hosted-charge-list-probe.yml"];
  assert.equal(await framedDigest(ROOT, probeFiles, "e7-hosted-charge-list-probe-v1\n"), "43715872ddb450889286880c848acefd8757da6fe33bc5c6a3a547bd27219cf3", "charge-list probe unchanged");
  assert.match(readFileSync(join(ROOT, ".github/workflows/e7-hosted-charge-list-probe.yml"), "utf8"), /environment: e7-readonly-probe\n/, "the same existing environment");
  assert.deepEqual([P.PROBE_VERSION, P.TOOLING_COMMIT], ["e7-resend-sink-probe-v1", PIN]);
});
