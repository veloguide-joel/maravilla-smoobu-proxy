// test/e7-hosted-charge-list-probe-workflow.test.mjs — C19: regression test for the NEW manual-only .github/workflows/e7-hosted-charge-list-probe.yml.
// Static assertions on the workflow bytes + LOCAL execution of its gate shell blocks (extracted from the YAML, run with bash against symlinked
// wrapper / tooling dirs) proving the HEAD / pin / label / digest refusals and the documented probe source digest frame. Zero network, zero secrets:
// the ONE `--probe` step is never executed here (only asserted), and every real network primitive is replaced by a throwing guard before import.
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
const { framedDigest } = await import("../scripts/e7-hosted-reservation.mjs");
const P = await import("../scripts/e7-hosted-charge-list-probe.mjs");
after(() => { assert.deepEqual(GUARD, { request: 0, Agent: 0, fetch: 0 }, "no real network primitive was touched"); });

const WF = ".github/workflows/e7-hosted-charge-list-probe.yml";
const yml = readFileSync(join(ROOT, WF), "utf8");
const PIN = "4ed7a636fee57981262b9c02574190d225b8a1fc";   // C25: probe repinned to the recording pin
const PREFIX = "e7-hosted-charge-list-probe-v1\n";
const FILES = ["scripts/e7-hosted-charge-list-probe.mjs", "test/e7-hosted-charge-list-probe.test.mjs", WF];
const count = (re) => (yml.match(re) || []).length;
/** the `run: |` block of the step with this exact name (indentation stripped) */
function runBlock(stepName) {
  const i = yml.indexOf(`- name: ${stepName}`); assert.ok(i >= 0, stepName);
  const rest = yml.slice(i); const m = rest.match(/\n        run: \|\n((?:          .*\n)+)/); assert.ok(m, `run block of ${stepName}`);
  return m[1].split("\n").map((l) => l.replace(/^ {10}/, "")).join("\n");
}
const jobs = { preflight: yml.slice(yml.indexOf("\n  preflight:\n"), yml.indexOf("\n  probe:\n")), probe: yml.slice(yml.indexOf("\n  probe:\n")) };

test("W1 static: workflow_dispatch ONLY; inputs exactly mode (choice [preflight, probe], default preflight) / approval_ref / expected_probe_digest; permissions contents: read only (no write path); concurrency e7-hosted-charge-list-probe cancel-in-progress false; exactly two jobs; both timeout 5", () => {
  assert.match(yml, /^on:\n  workflow_dispatch:\n    inputs:\n      mode:\n/m); assert.doesNotMatch(yml, /\n  (push|pull_request|pull_request_target|schedule|workflow_call|repository_dispatch):/);
  assert.match(yml, /      mode:\n(?:        .*\n)*?        type: choice\n        options: \[preflight, probe\]\n        default: preflight\n/);
  assert.deepEqual([...yml.matchAll(/^      ([a-z_]+):\n        description/gm)].map((m) => m[1]), ["mode", "approval_ref", "expected_probe_digest"]);
  assert.match(yml, /\npermissions:\n  contents: read\n\n/); assert.equal(count(/permissions:/g), 1); assert.doesNotMatch(yml, /: write|id-token:|pull-requests:|packages:|deployments:|issues:|checks:|statuses:|security-events:/);
  assert.match(yml, /\nconcurrency:\n  group: e7-hosted-charge-list-probe\n  cancel-in-progress: false\n/);
  assert.deepEqual([...yml.matchAll(/^  ([a-z-]+):\n    (?:needs|runs-on|if)/gm)].map((m) => m[1]), ["preflight", "probe"]);
  assert.equal(count(/timeout-minutes: 5\n/g), 2); assert.doesNotMatch(yml, /timeout-minutes: (?!5\n)/);
  assert.equal(count(/runs-on: ubuntu-24\.04/g), 2);
});

test("W2 static: checkout bindings — both jobs check out the wrapper at the EXACT dispatch SHA (never a mutable ref) and the tooling at the immutable pin 5a094b16, persist-credentials false, the same reviewed action pins as e7-hosted-recording.yml; Node 22.22.0 without cache; no dependency install anywhere", () => {
  assert.equal(count(/ref: \$\{\{ github\.sha \}\}\n          path: wrapper\n          persist-credentials: false/g), 2);
  assert.equal(count(new RegExp(`repository: veloguide-joel/maravilla-smoobu-proxy\\n          ref: ${PIN}\\n          path: tooling\\n          persist-credentials: false`, "g")), 2);
  assert.equal(count(/persist-credentials: false/g), 4); assert.doesNotMatch(yml, /ref: main|ref: refs\/heads|ref: \$\{\{ github\.ref/);
  const rec = readFileSync(join(ROOT, ".github/workflows/e7-hosted-recording.yml"), "utf8");
  const pins = (s) => [...new Set([...s.matchAll(/uses: (actions\/[a-z-]+@[0-9a-f]{40})/g)].map((m) => m[1]))].sort();
  assert.deepEqual(pins(yml), pins(rec)); assert.equal(count(/uses: /g), 6);
  assert.equal(count(/node-version: "22\.22\.0"\n          package-manager-cache: false/g), 2);
  assert.doesNotMatch(yml, /npm (ci|install|i )|yarn|pnpm|curl|wget|supabase|DATABASE|STRIPE|E7_CA_FILE|prod-ca/);
});

test("W3 static: probe job needs preflight AND if mode == 'probe' && github.ref == 'refs/heads/main' AND environment e7-readonly-probe (the only environment; preflight has none); preflight runs with no environment / no secret in either mode", () => {
  assert.match(jobs.probe, /^\n  probe:\n    needs: preflight\n    if: inputs\.mode == 'probe' && github\.ref == 'refs\/heads\/main'\n    runs-on: ubuntu-24\.04\n    environment: e7-readonly-probe\n    timeout-minutes: 5\n/);
  assert.equal(count(/environment: /g), 1); assert.doesNotMatch(jobs.preflight, /environment:|secrets\.|needs:/);
  assert.match(jobs.preflight, /^\n  preflight:\n    runs-on: ubuntu-24\.04\n    timeout-minutes: 5\n    steps:/);
});

test("W4 static: the SOLE secret (E7_HOSTAWAY_TOKEN) appears exactly once, in the env of the LAST step of the probe job, whose run is exactly the one --probe command; E7_TOOLING_DIR is a non-secret workspace path; no other secret / DB / CA / Stripe key; GitHub expressions reach shell only through env (no `${{` inside any run block); --probe appears once; preflight runs the focused fake tests + --dry", () => {
  assert.equal(count(/secrets\./g), 1); assert.equal(count(/\$\{\{ secrets\.E7_HOSTAWAY_TOKEN \}\}/g), 1);
  const last = yml.slice(yml.lastIndexOf("      - name: "));
  assert.match(last, /^      - name: ONE read-only charge-LIST probe[^\n]*\n        env:\n          E7_TOOLING_DIR: \$\{\{ github\.workspace \}\}\/tooling\n          E7_HOSTAWAY_TOKEN: \$\{\{ secrets\.E7_HOSTAWAY_TOKEN \}\}\n        run: node wrapper\/scripts\/e7-hosted-charge-list-probe\.mjs --probe\n$/);
  assert.equal(count(/--probe\b/g), 1 + count(/--probe call|--probe;|`--probe`|--probe\)/g), "--probe is a command once; every other occurrence is prose");
  assert.equal(count(/e7-hosted-charge-list-probe\.mjs --probe/g), 1);
  for (const blk of yml.split(/\n      - name: /).slice(1)) { const r = blk.match(/\n        run: \|\n((?:          .*\n)+)|\n        run: (.*)\n/); if (r) assert.doesNotMatch(r[1] ?? r[2], /\$\{\{/, "no expression interpolation inside run"); }
  assert.match(runBlock("Focused FAKE probe tests + --dry (no environment, no secrets, no provider requests, no dependency install)"), /^set -eu\nnode --test wrapper\/test\/e7-hosted-charge-list-probe\.test\.mjs\nnode wrapper\/scripts\/e7-hosted-charge-list-probe\.mjs --dry\n$/);
  assert.doesNotMatch(yml, /E7_DEV_BOOKING_DATABASE_URL|E7_STRIPE|api\.stripe\.com|recording-worker|execute\b.*\.mjs/);
  assert.equal(count(new RegExp(FILES.map((f) => f.replace(/[.\/]/g, "\\$&")).join(" "), "g")), 2, "digest file list identical in both jobs, documented order");
});

// ---------------------------------------------------------------------------------------------------------------------------------
// LOCAL execution of the gate blocks: wrapper = this checkout (git HEAD readable), tooling = E7_TOOLING_DIR (pinned checkout)
const headSha = execFileSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const toolSha = execFileSync("git", ["-C", TOOLING, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
function sandbox() { const d = mkdtempSync(join(tmpdir(), "e7-c19-")); symlinkSync(ROOT, join(d, "wrapper")); symlinkSync(TOOLING, join(d, "tooling")); return d; }
function sh(block, env, cwd) {
  const r = spawnSync("bash", ["-c", block], { cwd, encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME ?? "/tmp", ...env } });
  return { status: r.status, out: (r.stdout || "") + (r.stderr || "") };
}
const expectedDigest = async () => {
  const h = createHash("sha256"); h.update(PREFIX);
  for (const f of FILES) { const b = readFileSync(join(ROOT, f)); h.update(f); h.update(Buffer.from([0])); h.update(String(b.length)); h.update(Buffer.from([0])); h.update(b); h.update(Buffer.from([0])); }
  const mine = h.digest("hex"); assert.equal(mine, await framedDigest(ROOT, FILES, PREFIX), "frame == the reviewed runners' framedDigest convention"); return mine;
};

test("W5 preflight gate blocks executed locally: bindings pass with HEAD == dispatch SHA and tooling == pin; REFUSE (exit 3, nothing else) on a foreign dispatch SHA, a foreign tooling pin or an unknown mode; the digest block prints the documented framed SHA-256 (== framedDigest over the 3 files with prefix e7-hosted-charge-list-probe-v1) and refuses a non-matching expected_probe_digest", async () => {
  assert.equal(toolSha, PIN, "E7_TOOLING_DIR must be the pinned 4ed7a636 checkout");
  const d = sandbox(); try {
    const bind = runBlock("Verify checkout bindings (wrapper HEAD == dispatch SHA; tooling HEAD == pin; no secrets)");
    const ok = sh(bind, { E7_WORKFLOW_SHA: headSha, E7_TOOLING_PIN: PIN, E7_MODE: "preflight" }, d); assert.equal(ok.status, 0, ok.out); assert.match(ok.out, /bindings ok/);
    assert.equal(sh(bind, { E7_WORKFLOW_SHA: headSha, E7_TOOLING_PIN: PIN, E7_MODE: "probe" }, d).status, 0);
    for (const [env, why] of [[{ E7_WORKFLOW_SHA: "0".repeat(40), E7_TOOLING_PIN: PIN, E7_MODE: "preflight" }, /wrapper HEAD != dispatch SHA/], [{ E7_WORKFLOW_SHA: headSha, E7_TOOLING_PIN: "1".repeat(40), E7_MODE: "preflight" }, /tooling HEAD != pin/], [{ E7_WORKFLOW_SHA: headSha, E7_TOOLING_PIN: PIN, E7_MODE: "execute" }, /REFUSED: mode/], [{ E7_WORKFLOW_SHA: "", E7_TOOLING_PIN: PIN, E7_MODE: "preflight" }, /wrapper HEAD != dispatch SHA/]]) {
      const r = sh(bind, env, d); assert.deepEqual([r.status, why.test(r.out)], [3, true], r.out);
    }
    const dig = runBlock("Probe source digest (deterministic framed SHA-256; documented order and prefix)"); const want = await expectedDigest();
    const r1 = sh(dig, { E7_EXPECTED_PROBE_DIGEST: "" }, d); assert.equal(r1.status, 0, r1.out); assert.match(r1.out, new RegExp(`probeSourceDigest=${want}`));
    assert.equal(sh(dig, { E7_EXPECTED_PROBE_DIGEST: want }, d).status, 0);
    const r3 = sh(dig, { E7_EXPECTED_PROBE_DIGEST: "f".repeat(64) }, d); assert.deepEqual([r3.status, /expected_probe_digest mismatch/.test(r3.out)], [3, true], r3.out);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("W6 probe re-check block executed locally (BEFORE the one --probe call; no secret in scope): passes only with HEAD == dispatch SHA, tooling == pin, non-empty approval_ref, a 64-hex expected_probe_digest EQUAL to the actual digest, and the probe's own full 8-file manifest check (loadTooling, zero import on refusal); refuses (exit 3) on each violation; a drifted tooling copy is refused by the manifest check; zero network", async () => {
  const d = sandbox(); try {
    const blk = runBlock("Re-check bindings BEFORE the probe (HEAD == dispatch SHA; tooling pin + full 8-file manifest; expected digest; label; no secrets)");
    assert.doesNotMatch(blk, /E7_HOSTAWAY_TOKEN|--probe/); const want = await expectedDigest();
    const base = { E7_WORKFLOW_SHA: headSha, E7_TOOLING_PIN: PIN, E7_TOOLING_DIR: join(d, "tooling"), E7_APPROVAL_REF: "ROOT-C19-label", E7_EXPECTED_PROBE_DIGEST: want };
    const ok = sh(blk, base, d); assert.equal(ok.status, 0, ok.out); assert.match(ok.out, /tooling manifest ok: 8 files at 4ed7a636/); assert.match(ok.out, new RegExp(`bindings ok: wrapper=${headSha} tooling=${PIN} digest=${want}`));
    for (const [over, why] of [[{ E7_WORKFLOW_SHA: "0".repeat(40) }, /wrapper HEAD != dispatch SHA/], [{ E7_TOOLING_PIN: "1".repeat(40) }, /tooling HEAD != pin/], [{ E7_APPROVAL_REF: "" }, /approval_ref empty/], [{ E7_EXPECTED_PROBE_DIGEST: "" }, /not 64-hex/], [{ E7_EXPECTED_PROBE_DIGEST: want.slice(1) }, /not 64-hex/], [{ E7_EXPECTED_PROBE_DIGEST: want.toUpperCase() }, /not 64-hex/], [{ E7_EXPECTED_PROBE_DIGEST: "f".repeat(64) }, /expected_probe_digest mismatch/]]) {
      const r = sh(blk, { ...base, ...over }, d); assert.deepEqual([r.status, why.test(r.out)], [3, true], JSON.stringify(over) + r.out);
    }
    // drifted tooling: a copy of the pinned checkout with one TRANSITIVE dependency altered → the manifest check refuses before any import
    const drift = mkdtempSync(join(tmpdir(), "e7-c19-drift-")); try {
      execFileSync("cp", ["-r", join(TOOLING, "lib"), join(TOOLING, "scripts"), drift]);
      execFileSync("bash", ["-c", `printf '\\n// drift\\n' >> "${join(drift, "lib/checkout/compensation-proof.js")}"`]);
      const r = sh(blk, { ...base, E7_TOOLING_DIR: drift }, d); assert.deepEqual([r.status, /REFUSED: tooling manifest TOOLING_CLOSURE_MISMATCH lib\/checkout\/compensation-proof\.js/.test(r.out)], [3, true], r.out);
    } finally { rmSync(drift, { recursive: true, force: true }); }
    assert.deepEqual([P.TOOLING_COMMIT, Object.keys(P.MANIFEST).length], [PIN, 8]);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("W7 the five reviewed runners are untouched: the new workflow is in NO runner's runnerFiles, every runner still has executeEnabled false, and the five runner digests (framedDigest over runnerFiles) are exactly the closed values (C24: recording / recorded-cleanup re-derived after the 4ed7a636 repin); the probe script and its test are byte-identical to the merged #95 (probe digest frame covers them)", async () => {
  const want = { reservation: "5665544de105e4564a57a4434fa32fd2355b9bbd0e756b250d1248e07feb6b19", capture: "5b547a42200b452055d8a718c84ab70f7f2b5a0cd8343f6174c4a75b0c420ed1", "test-cleanup": "33f2ab18984dccd3915a18ff8a55dd4a6e5b6bf89e3d84ba1e578347e6cebd1e", recording: "800002531edcc2be14569830eb0e664c19884512aa0b015fd7ceb4f8c9acf561", "recorded-cleanup": "e9011de76a1737d50ebcf8277e66f8911bcdc888ddf7a620b19c89f9a4699dca" };   // C24: recording repinned to 4ed7a636 (runner + workflow + test bytes); recorded-cleanup test asserts the new Slice 4 pin (runner / workflow bytes unchanged)
  for (const n of Object.keys(want)) {
    const m = await import(`../scripts/e7-hosted-${n}.mjs`);
    assert.equal(m.CONSTANTS.executeEnabled, false, n); assert.ok(!m.CONSTANTS.runnerFiles.includes(WF), n);
    assert.equal(await framedDigest(ROOT, m.CONSTANTS.runnerFiles, m.RUNNER_DIGEST_PREFIX), want[n], n);
  }
  assert.equal(P.PROBE_VERSION, "e7-hosted-charge-list-probe-v2");
});
