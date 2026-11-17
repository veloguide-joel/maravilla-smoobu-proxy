// test/e7-hosted-tls-probe-workflow.test.mjs — C112: regression test for .github/workflows/e7-hosted-tls-probe.yml (READ-ONLY probe). Static
// assertions on the workflow bytes (trigger, inputs, permissions, the ONE environment, secret placement, pins) + LOCAL execution of its gate
// shell blocks against symlinked wrapper / tooling dirs. Zero network, zero secrets: the probe step is only asserted, never executed here.
// Also pins that every booking runner on main stays CLOSED.
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
const P = await import("../scripts/e7-hosted-tls-probe.mjs");
const K = await import("../scripts/e7-hosted-kickoff.mjs");
after(() => { assert.deepEqual(GUARD, { request: 0, Agent: 0, fetch: 0 }, "no real network primitive was touched"); });

const WF = ".github/workflows/e7-hosted-tls-probe.yml";
const yml = readFileSync(join(ROOT, WF), "utf8");
const PIN = "66133a22edca925e6386c4d178c251fa5f11c82e";   // C116: the kickoff's #180 merge tooling (was 4e79f266)
const PREFIX = "e7-hosted-tls-probe-v1\n";
const FILES = ["scripts/e7-hosted-tls-probe.mjs", "test/e7-hosted-tls-probe.test.mjs", "test/e7-hosted-tls-probe-workflow.test.mjs", WF, "scripts/e7-hosted-kickoff.mjs"];
const code = yml.replace(/^#.*\n/gm, "");
const count = (re) => (code.match(re) || []).length;
function runBlock(stepName) {
  const i = yml.indexOf(`- name: ${stepName}`); assert.ok(i >= 0, stepName);
  const m = yml.slice(i).match(/\n        run: \|\n((?:          .*\n)+)/); assert.ok(m, `run block of ${stepName}`);
  return m[1].split("\n").map((l) => l.replace(/^ {10}/, "")).join("\n");
}
const jobs = { preflight: yml.slice(yml.indexOf("\n  preflight:\n"), yml.indexOf("\n  verify:\n")), verify: yml.slice(yml.indexOf("\n  verify:\n"), yml.indexOf("\n  probe:\n")),
  probe: yml.slice(yml.indexOf("\n  probe:\n")) };
const steps = (job) => [...job.matchAll(/\n      - name: ([^\n]+)/g)].map((m) => m[1]);

test("W1 static: workflow_dispatch ONLY; inputs exactly mode (choice preflight|verify|probe, default preflight) + expected_source_digest — no SQL / target / host / credential / TLS / sample-count input; concurrency serialised", () => {
  assert.match(yml, /^on:\n  workflow_dispatch:\n    inputs:\n      mode:\n/m);
  assert.doesNotMatch(code, /\n  (push|pull_request|pull_request_target|schedule|workflow_call|repository_dispatch|workflow_run|issue_comment):|cron:/);
  assert.match(yml, /      mode:\n(?:        .*\n)*?        type: choice\n        options: \[preflight, verify, probe\]\n        default: preflight\n/);
  assert.deepEqual([...yml.matchAll(/^      ([a-z_]+):\n        description/gm)].map((m) => m[1]), ["mode", "expected_source_digest"]);
  assert.match(yml, /\nconcurrency:\n  group: e7-hosted-tls-probe\n  cancel-in-progress: false\n/);
  assert.deepEqual([...yml.matchAll(/^  ([a-z-]+):\n    (?:needs|runs-on|if)/gm)].map((m) => m[1]), ["preflight", "verify", "probe"]);
  assert.deepEqual([...P.RUNNER_FILES], FILES);
});

test("W2 PERMISSIONS: contents: read at the workflow and in EVERY job; NO write permission anywhere (no actions: write, no token use); no PAT / App / id-token", () => {
  assert.match(yml, /\npermissions:\n  contents: read\n\nconcurrency:/);
  for (const j of Object.values(jobs)) assert.match(j, /\n    permissions:\n      contents: read\n    steps:/);
  assert.equal(count(/: write/g), 0); assert.equal(count(/permissions:/g), 4);
  assert.doesNotMatch(code, /github\.token|GITHUB_TOKEN|id-token:|write-all|secrets\.[A-Z_]*PAT|app-id|private-key|create-github-app-token/i);
});

test("W3 static: checkouts at the EXACT dispatch SHA + the tooling pin 66133a22 (persist-credentials false) in all three jobs; the reviewed action pins (== the kickoff workflow); Node 22.22.0; preflight / verify have no environment / secret / npm / curl / CA", () => {
  assert.equal(count(/ref: \$\{\{ github\.sha \}\}\n          path: wrapper\n          persist-credentials: false/g), 3);
  assert.equal(count(new RegExp(`repository: veloguide-joel/maravilla-smoobu-proxy\\n          ref: ${PIN}\\n          path: tooling\\n          persist-credentials: false`, "g")), 3);
  assert.equal(count(/persist-credentials: false/g), 6); assert.doesNotMatch(yml, /ref: main|ref: refs\/heads|ref: \$\{\{ github\.ref/);
  const ko = readFileSync(join(ROOT, ".github/workflows/e7-hosted-kickoff.yml"), "utf8");
  const pins = (s) => [...new Set([...s.matchAll(/uses: (actions\/[a-z-]+@[0-9a-f]{40})/g)].map((m) => m[1]))].sort();
  assert.deepEqual(pins(yml), pins(ko)); assert.equal(count(/uses: /g), 9);
  assert.equal(count(/node-version: "22\.22\.0"\n          package-manager-cache: false/g), 3);
  for (const j of [jobs.preflight, jobs.verify]) assert.doesNotMatch(j, /environment:|secrets\.|E7_DEV_BOOKING_DATABASE_URL|npm |curl |E7_CA_FILE/);
  assert.equal(P.CONSTANTS.toolingCommit, PIN); assert.equal(yml.split(`E7_TOOLING_PIN: ${PIN}`).length - 1, 2);
});

test("W4 static: probe needs [preflight, verify] AND mode == 'probe' && main AND environment e7-readonly-probe (the only environment); step order: checkouts → node → pre-secret re-check → npm ci → CA fetch → the ONE probe step LAST", () => {
  assert.match(jobs.probe, /^\n  probe:\n    needs: \[preflight, verify\]\n    if: inputs\.mode == 'probe' && github\.ref == 'refs\/heads\/main'\n    runs-on: ubuntu-24\.04\n    environment: e7-readonly-probe\n    timeout-minutes: 10\n/);
  assert.match(jobs.verify, /^\n  verify:\n    needs: preflight\n    if: inputs\.mode == 'verify' \|\| inputs\.mode == 'probe'\n/);
  assert.equal(count(/environment: /g), 1);
  assert.deepEqual(steps(jobs.probe).map((s) => s.split(" (")[0]), ["Checkout wrapper", "Checkout E7 tooling", "Set up Node 22.22.0", "Re-check bindings BEFORE any secret",
    "Install the pinned dependency from the verified lockfile", "Fetch the public Supabase CA", "ONE read-only TLS probe"]);
  assert.deepEqual(steps(jobs.verify).map((s) => s.split(" (")[0]), ["Checkout wrapper", "Checkout E7 tooling", "Set up Node 22.22.0", "Verify"]);
  assert.deepEqual(steps(jobs.preflight).map((s) => s.split(" (")[0]), ["Checkout wrapper", "Checkout E7 tooling", "Set up Node 22.22.0", "Verify checkout bindings", "Preflight"]);
  assert.match(jobs.probe, /working-directory: tooling\n        run: npm ci --ignore-scripts --omit=dev --no-audit --no-fund\n/);
  const ko = readFileSync(join(ROOT, ".github/workflows/e7-hosted-kickoff.yml"), "utf8");
  const curl = (s) => s.match(/\n        run: curl [^\n]+\n/)[0]; assert.equal(curl(jobs.probe), curl(ko), "the SAME CA fetch as the merged kickoff");
});

test("W5 static: the ONLY secret (existing NAME E7_DEV_BOOKING_DATABASE_URL) appears exactly once, in the env of the LAST probe step whose run is the one `probe` command; no expression inside any run; every E7_* env name is an admitted runner key; no provider / token / booking-runner name", () => {
  assert.equal(count(/secrets\./g), 1); assert.equal(count(/\$\{\{ secrets\.E7_DEV_BOOKING_DATABASE_URL \}\}/g), 1);
  const last = yml.slice(yml.lastIndexOf("      - name: "));
  assert.match(last, /^      - name: ONE read-only TLS probe[^\n]*\n        env:\n(?:          [A-Z0-9_]+: [^\n]+\n)+        run: node wrapper\/scripts\/e7-hosted-tls-probe\.mjs probe\n$/);
  assert.match(last, /          E7_DEV_BOOKING_DATABASE_URL: \$\{\{ secrets\.E7_DEV_BOOKING_DATABASE_URL \}\}\n        run:/);
  for (const m of ["probe", "verify", "preflight"]) assert.equal(count(new RegExp(`e7-hosted-tls-probe\\.mjs ${m}\\n`, "g")), 1);
  assert.doesNotMatch(code, /E7_DISPATCH_TOKEN|E7_STRIPE|E7_HOSTAWAY|RESEND|api\.stripe\.com|api\.hostaway\.com|E7_TLSP_DB_TESTS|e7-hosted-kickoff\.mjs (preflight|verify|execute)/);
  for (const blk of yml.split(/\n      - name: /).slice(1)) { const r = blk.match(/\n        run: \|\n((?:          .*\n)+)|\n        run: (.*)\n/); if (r) assert.doesNotMatch(r[1] ?? r[2], /\$\{\{/, "no expression inside run"); }
  const envKeys = [...yml.matchAll(/^          (E7_[A-Z0-9_]+):/gm)].map((m) => m[1]);
  for (const k of envKeys) if (!["E7_TOOLING_PIN", "E7_MODE"].includes(k)) assert.ok(P.ALLOWED_E7_KEYS.includes(k), `${k} is an admitted runner key`);
});

// ---- LOCAL execution of the gate blocks ----------------------------------------------------------------------------------------------
const headSha = execFileSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const toolSha = execFileSync("git", ["-C", TOOLING, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
function sandbox() { const d = mkdtempSync(join(tmpdir(), "e7-htp-")); symlinkSync(ROOT, join(d, "wrapper")); symlinkSync(TOOLING, join(d, "tooling")); return d; }
function sh(block, env, cwd) {
  const r = spawnSync("bash", ["-c", block], { cwd, encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME ?? "/tmp", ...env } });
  return { status: r.status, out: (r.stdout || "") + (r.stderr || "") };
}
const expectedDigest = async () => {
  const h = createHash("sha256"); h.update(PREFIX);
  for (const f of FILES) { const b = readFileSync(join(ROOT, f)); h.update(f); h.update(Buffer.from([0])); h.update(String(b.length)); h.update(Buffer.from([0])); h.update(b); h.update(Buffer.from([0])); }
  const mine = h.digest("hex"); assert.equal(mine, await K.framedDigest(ROOT, FILES, PREFIX), "shell frame == the runner's framedDigest"); return mine;
};

test("W6 preflight bindings block executed locally: passes only with HEAD == dispatch SHA, tooling == pin and a known mode (preflight / verify / probe)", () => {
  assert.equal(toolSha, PIN, "E7_TOOLING_DIR must be the pinned 66133a22 checkout");
  const d = sandbox(); try {
    const bind = runBlock("Verify checkout bindings (wrapper HEAD == dispatch SHA; tooling HEAD == pin; no secrets)");
    for (const mode of ["preflight", "verify", "probe"]) { const ok = sh(bind, { E7_WORKFLOW_SHA: headSha, E7_TOOLING_PIN: PIN, E7_MODE: mode }, d); assert.equal(ok.status, 0, ok.out); }
    for (const [env, why] of [[{ E7_WORKFLOW_SHA: "0".repeat(40), E7_TOOLING_PIN: PIN, E7_MODE: "preflight" }, /wrapper HEAD != dispatch SHA/],
      [{ E7_WORKFLOW_SHA: headSha, E7_TOOLING_PIN: "1".repeat(40), E7_MODE: "preflight" }, /tooling HEAD != pin/], [{ E7_WORKFLOW_SHA: headSha, E7_TOOLING_PIN: PIN, E7_MODE: "execute" }, /REFUSED: mode/]]) {
      const r = sh(bind, env, d); assert.deepEqual([r.status, why.test(r.out)], [3, true], r.out);
    }
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("W7 probe re-check block executed locally (BEFORE any secret): HEAD / tooling / 64-hex / the exact probe source digest (5-file frame incl. the imported kickoff runner) — PASSES with the real digest, REFUSES each defect", async () => {
  const d = sandbox(); try {
    const blk = runBlock("Re-check bindings BEFORE any secret (HEAD == dispatch SHA; tooling pin; probe source digest)");
    assert.doesNotMatch(blk, /E7_DEV_BOOKING_DATABASE_URL|github\.token|\.mjs probe|secrets\./);
    const want = await expectedDigest(); assert.equal(want, await K.framedDigest(ROOT, P.RUNNER_FILES, P.SOURCE_PREFIX));
    const base = { E7_WORKFLOW_SHA: headSha, E7_TOOLING_PIN: PIN, E7_EXPECTED_SOURCE_DIGEST: want };
    const ok = sh(blk, base, d); assert.equal(ok.status, 0, ok.out); assert.match(ok.out, new RegExp(`bindings ok: wrapper=${headSha} tooling=${PIN} source=${want}`));
    for (const [over, why] of [[{ E7_WORKFLOW_SHA: "0".repeat(40) }, /wrapper HEAD != dispatch SHA/], [{ E7_TOOLING_PIN: "1".repeat(40) }, /tooling HEAD != pin/],
      [{ E7_EXPECTED_SOURCE_DIGEST: "" }, /not 64-hex/], [{ E7_EXPECTED_SOURCE_DIGEST: "f".repeat(64) }, /expected_source_digest mismatch/]]) {
      const r = sh(blk, { ...base, ...over }, d); assert.deepEqual([r.status, why.test(r.out)], [3, true], JSON.stringify(over) + r.out);
    }
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("W8 booking runners untouched and CLOSED: kickoff executeEnabled / dispatchEnabled false, pipeline executeEnabled false; the probe adds no booking / dispatch capability", async () => {
  assert.deepEqual([K.CONSTANTS.executeEnabled, K.CONSTANTS.dispatchEnabled], [false, false]);
  const PL = await import("../scripts/e7-hosted-pipeline.mjs"); assert.equal(PL.CONSTANTS.executeEnabled, false);
  const src = readFileSync(join(ROOT, "scripts/e7-hosted-tls-probe.mjs"), "utf8");
  assert.doesNotMatch(src, /runKickoffCore|runPipelineKickoffOnce|createGithub|workflow_dispatch\b.*POST|stripe|hostaway|resend/i);
});
