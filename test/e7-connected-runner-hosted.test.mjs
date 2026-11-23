// E7 hosted connected-runner launcher L1 — PREFLIGHT ONLY (packaging proof). OFFLINE tests: no DB, no network, no provider, no install.
// The pinned tooling (6d00d0d6) is read from E7_TOOLING_DIR (default ../tooling). Every manifest / credential / id below is SYNTHETIC.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync, cpSync, writeFileSync, rmSync, realpathSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import tls from "node:tls";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOOLING = realpathSync(process.env.E7_TOOLING_DIR || join(ROOT, "..", "tooling"));
const E = await import("../scripts/e7-connected-runner-hosted.mjs");
const C = E.CONSTANTS;
const M = await import(join(TOOLING, "scripts/e7-connected/run-manifest.mjs"));

// ---- network trap for the whole file (in-process): every attempt is counted, none is allowed --------------------------------------
const net0 = { fetch: 0, socket: 0, tls: 0, dns: 0, http: 0, https: 0 };
const saved = { fetch: globalThis.fetch, connect: net.Socket.prototype.connect, tlsConnect: tls.connect, lookup: dns.lookup, hreq: http.request, sreq: https.request };
globalThis.fetch = async () => { net0.fetch += 1; throw new Error("network refused"); };
net.Socket.prototype.connect = function () { net0.socket += 1; throw new Error("socket refused"); };
tls.connect = () => { net0.tls += 1; throw new Error("tls refused"); };
dns.lookup = () => { net0.dns += 1; throw new Error("dns refused"); };
http.request = () => { net0.http += 1; throw new Error("http refused"); };
https.request = () => { net0.https += 1; throw new Error("https refused"); };
after(() => {
  globalThis.fetch = saved.fetch; net.Socket.prototype.connect = saved.connect; tls.connect = saved.tlsConnect; dns.lookup = saved.lookup;
  http.request = saved.hreq; https.request = saved.sreq;
  assert.deepEqual(net0, { fetch: 0, socket: 0, tls: 0, dns: 0, http: 0, https: 0 }, "no in-process network attempt of any kind");
});

const PROC = { versions: { node: "22.22.0" }, platform: "linux", execArgv: [], getuid: () => 1001 };
const BASICS = { PATH: "/usr/bin:/bin", HOME: "/home/runner", TMPDIR: "/tmp/r", LANG: "C.UTF-8", TZ: "UTC" };
const tapOk = async () => ({ status: 0, signal: null, stdout: "TAP version 13\n# tests 85\n# pass 85\n# fail 0\n", truncated: false, spawnFailed: false });
function seams(extra = {}) {
  const rec = { imports: [], spawns: [] };
  const importModule = async (p) => { rec.imports.push(relative(TOOLING, p)); return import(p); };
  const spawnChild = async (a, o) => { rec.spawns.push({ a, o }); return tapOk(); };
  return { rec, deps: { importModule, spawnChild, ...extra } };
}
async function host(mode, env = {}, extra = {}, dirs = {}) {
  const { rec, deps } = seams(extra);
  const res = await E.runHosted({ mode, env: { ...BASICS, E7_TOOLING_DIR: dirs.tooling ?? TOOLING, ...env }, proc: extra.proc ?? PROC, wrapperDir: dirs.wrapper ?? ROOT, deps });
  return { res, rec };
}
const RESULT_KEYS = ["closureDigest", "code", "envCode", "imports", "manifestHash", "mode", "planKind", "proof", "runnerDigest", "runnerPlanHash", "schema", "tests",
  "toolingCommit", "workflowSha"];

test("H1 preflight (fake child): PREFLIGHT_OK_PACKAGING_ONLY; exact pins; accepted manifest hash; plan binds manifest / tooling / closure / runner / runtime", async () => {
  const { res, rec } = await host("preflight", { E7_WORKFLOW_SHA: "a".repeat(40) });
  const r = res.result;
  assert.equal(res.exitCode, 0, r.code);
  assert.deepEqual([r.code, r.proof, r.mode, r.planKind, r.envCode, r.toolingCommit], ["PREFLIGHT_OK_PACKAGING_ONLY", "PACKAGING_ONLY", "preflight", "SYNTHETIC", "ENV_OK", C.toolingCommit]);
  assert.equal(r.closureDigest, C.closureDigest);
  // the manifest hash is the ACCEPTED validator's framed hash (prefix + canonical JSON), recomputed here independently of the launcher
  const v = M.validateRunManifest(JSON.parse(JSON.stringify(C.syntheticManifest)));
  assert.equal(v.ok, true);
  assert.equal(r.manifestHash, v.hash);
  assert.equal(r.manifestHash, M.manifestHash(v.manifest));
  // the outer plan
  const built = E.buildLaunchPlan(C, { manifestHash: v.hash, closureDigest: r.closureDigest, runnerDigest: r.runnerDigest, nodeVersion: "22.22.0" });
  assert.equal(r.runnerPlanHash, built.runnerPlanHash);
  for (const [k, val] of [["manifestHash", "f".repeat(64)], ["closureDigest", "e".repeat(64)], ["runnerDigest", "d".repeat(64)], ["nodeVersion", "24.22.1"]]) {
    const args = { manifestHash: v.hash, closureDigest: r.closureDigest, runnerDigest: r.runnerDigest, nodeVersion: "22.22.0", [k]: val };
    assert.notEqual(E.buildLaunchPlan(C, args).runnerPlanHash, built.runnerPlanHash, `plan binds ${k}`);
  }
  assert.notEqual(E.buildLaunchPlan({ ...C, toolingCommit: "1".repeat(40) }, { manifestHash: v.hash, closureDigest: r.closureDigest, runnerDigest: r.runnerDigest,
    nodeVersion: "22.22.0" }).runnerPlanHash, built.runnerPlanHash, "plan binds the tooling commit");
  assert.deepEqual(built.plan.effects, { db: 0, providerRequests: 0, exchangesConstructed: 0, coreInvocations: 0, writes: 0, notifications: 0 });
  assert.equal(built.plan.proof, "PACKAGING_ONLY");
  // imports: exactly the two pure modules, in order; one child with the exact fake-only suites at the tooling root
  assert.deepEqual(rec.imports, ["scripts/e7-connected/run-manifest.mjs", "scripts/e7-connected/probe-env-preflight.mjs"]);
  assert.deepEqual(r.imports, rec.imports);
  assert.equal(rec.spawns.length, 1);
  assert.deepEqual(rec.spawns[0].a, ["--test", "--test-reporter=tap", ...E.CHILD_TESTS]);
  assert.equal(rec.spawns[0].o.cwd, TOOLING);
  assert.deepEqual(r.tests, { status: 0, tests: 85, pass: 85, fail: 0, connectivityEvidence: false });
  assert.deepEqual(Object.keys(r).sort(), RESULT_KEYS, "whitelisted result keys only (no manifest / guest / credential dump)");
  // the step summary renders the numeric test fields and every pin; nothing is REDACTED on a clean run
  const md = E.summaryMarkdown(r);
  assert.ok(md.includes("| fake-only suites (NOT connectivity) | status 0, pass 85/85, fail 0 |"), md);
  assert.ok(md.includes(`| closureDigest (computed) | ${C.closureDigest} |`));
  assert.ok(md.includes(`| runnerPlanHash | ${r.runnerPlanHash} |`));
  assert.equal(md.includes("REDACTED"), false, md);
  // hostile values are bounded: non-integer test fields and non-code strings are REDACTED, never rendered
  const hostile = E.summaryMarkdown({ ...r, mode: "x | <script>", envCode: "a\nb", tests: { status: "0; rm", pass: 1.5, tests: -1, fail: "1" } });
  assert.ok(hostile.includes("| fake-only suites (NOT connectivity) | status REDACTED, pass REDACTED/REDACTED, fail REDACTED |"), hostile);
  assert.ok(hostile.includes("| mode | REDACTED |") && hostile.includes("| env | REDACTED |"));
  assert.equal(hostile.includes("<script>") || hostile.includes("rm"), false);
});

test("H2 every mode except preflight is refused FIRST: no env read, no fs, no import, no child", async () => {
  for (const mode of ["verify", "execute", "bindings", "cleanup", "", "PREFLIGHT", undefined, null, 1]) {
    const { res, rec } = await host(mode, { STRIPE_SECRET_KEY: "CANARY_sk_x", E7_MANIFEST_JSON: "{}" }, {}, { tooling: "/nonexistent/tooling", wrapper: "/nonexistent/wrapper" });
    const m = mode === undefined ? "preflight" : mode;     // undefined takes the default (preflight) and is then refused by the boundary below
    if (m === "preflight") { assert.equal(res.result.code, "CRH_SECRET_SCOPE_VIOLATION"); continue; }
    assert.deepEqual([res.exitCode, res.result.code, res.result.mode], [1, "CRH_MODE_NOT_IMPLEMENTED", null], String(mode));
    assert.deepEqual([rec.imports.length, rec.spawns.length], [0, 0]);
    assert.equal(res.result.closureDigest, null, "no filesystem read before the mode check");
  }
});

test("H3 credential boundary: DB / Postgres / Supabase / Stripe / Hostaway keys refused at the parent, values never echoed; nothing imported or spawned", async () => {
  const keys = ["E7_DEV_BOOKING_DATABASE_URL", "DATABASE_URL", "PGPASSWORD", "PGHOST", "SUPABASE_SERVICE_ROLE_KEY", "STRIPE_SECRET_KEY", "E7_STRIPE_TEST_KEY",
    "STRIPE_TEST_SECRET_KEY", "E7_HOSTAWAY_TOKEN", "HOSTAWAY_CLIENT_SECRET", "hostaway_account_id", "PG_SERVICE_FILE", "PG_URL", "PG1", "pgpassword",
    "POSTGRES_URL", "POSTGRES_PRISMA_URL", "E7_POSTGRES_DSN"];
  for (const k of keys) {
    const { res, rec } = await host("preflight", { [k]: `CANARY_${k}_value` });
    assert.deepEqual([res.exitCode, res.result.code], [1, "CRH_SECRET_SCOPE_VIOLATION"], k);
    assert.deepEqual([rec.imports.length, rec.spawns.length, res.result.closureDigest], [0, 0, null], k);
    assert.equal(JSON.stringify(res.result).includes("CANARY"), false, k);
    assert.equal(E.summaryMarkdown(res.result).includes("CANARY"), false, k);
  }
  // the boundary is name-based and does not over-match the OS basics or the two allowed E7_ inputs
  for (const k of [...E.CHILD_ENV_ALLOWLIST, ...E.E7_INPUTS_ALLOWED, "GITHUB_SHA", "RUNNER_TEMP"]) assert.equal(E.CREDENTIAL_KEY_RE.test(k), false, k);
});

test("H4 no real input exists in L1: any other E7_ input is refused before fs / import / child", async () => {
  for (const k of ["E7_MANIFEST_JSON", "E7_APPROVAL_REF", "E7_EXPECTATION_JSON", "E7_EXPECTED_RUNNER_PLAN_HASH", "E7_INTENT_ID", "E7_MODE", "E7_CA_FILE"]) {
    const { res, rec } = await host("preflight", { [k]: "x" });
    assert.deepEqual([res.result.code, rec.imports.length, rec.spawns.length, res.result.closureDigest], ["CRH_INPUT_NOT_IN_THIS_SLICE", 0, 0, null], k);
  }
});

// ---- independent closure scan (relative static + dynamic string imports), done here without the launcher's help --------------------------
function scan(root, starts) {
  const RE = /(?:^|[^\w$.])(?:import|export)\s*(?:[\w*{}\s,$]*from\s*)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
  const seen = new Set(); const bare = new Set(); const stack = starts.map((s) => resolve(root, s));
  while (stack.length) {
    const f = stack.pop(); const rel = relative(root, f); if (seen.has(rel)) continue; seen.add(rel);
    const src = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    for (const m of src.matchAll(RE)) { const s = m[1] ?? m[2]; if (s.startsWith(".")) { const p = resolve(dirname(f), s); assert.ok(existsSync(p), p); stack.push(p); } else if (!s.startsWith("node:")) bare.add(s); }
  }
  return { files: [...seen].sort(), bare: [...bare].sort() };
}

test("H5 closure = the scanned transitive closure (+ child-suite data files + package files); bytes verified BEFORE any import; tamper / layout refused", async () => {
  const starts = ["scripts/e7-connected/run-core.mjs", "scripts/e7-connected/http-transports.mjs", "scripts/e7-connected/real-exchange.mjs",
    "scripts/e7-connected/run-journal-file.mjs", "scripts/e7-connected/probe-env-preflight.mjs", ...E.CHILD_TESTS];
  const s = scan(TOOLING, starts);
  assert.deepEqual(s.bare, ["pg"], "the only bare dependency of the closure (never imported by the launcher; no install in L1)");
  const data = ["db/migrations/0001_booking_core.up.sql", "db/migrations/0003_safety_corrections.up.sql", "lib/booking-db/notification-worker.js"];
  assert.deepEqual([...C.closure].sort(), [...new Set([...s.files, ...data, "package.json", "package-lock.json"])].sort());
  // the run-journal suite reads every lib/booking-db/*-worker.js + recovery.js: all of them are in the closure
  const workers = ["capture", "compensation", "notification", "recording", "reservation"];
  for (const w of workers) assert.ok(C.closure.includes(`lib/booking-db/${w}-worker.js`), w);
  // the run-core import of all four workers is in the scanned closure (the digest covers what a later execute would load)
  for (const f of ["lib/booking-db/reservation-worker.js", "lib/booking-db/capture-worker.js", "lib/booking-db/recording-worker.js", "lib/booking-db/compensation-worker.js"])
    assert.ok(s.files.includes(f), f);
  // tamper: one byte in a closure file → SOURCE_MISMATCH with ZERO imports and no child
  const t = mkdtempSync(join(tmpdir(), "crh-tooling-"));
  try {
    for (const rel of C.closure) { const dst = join(t, rel); mkdirSync(dirname(dst), { recursive: true }); cpSync(join(TOOLING, rel), dst); }
    const good = await host("preflight", {}, {}, { tooling: t });
    assert.equal(good.res.result.code, "PREFLIGHT_OK_PACKAGING_ONLY", "an exact copy of the closure passes");
    for (const rel of ["scripts/e7-connected/run-core.mjs", "lib/booking-db/capture-worker.js", "package-lock.json", "test/e7-connected-run-guard.test.mjs"]) {
      const p = join(t, rel); const orig = readFileSync(p); writeFileSync(p, Buffer.concat([orig, Buffer.from(" ")]));
      const bad = await host("preflight", {}, {}, { tooling: t });
      assert.deepEqual([bad.res.result.code, bad.rec.imports.length, bad.rec.spawns.length], ["CRH_SOURCE_MISMATCH", 0, 0], rel);
      writeFileSync(p, orig);
    }
    rmSync(join(t, "scripts/e7-connected/run-manifest.mjs"));
    const gone = await host("preflight", {}, {}, { tooling: t });
    assert.deepEqual([gone.res.result.code, gone.rec.imports.length], ["CRH_SOURCE_UNREADABLE", 0]);
  } finally { rmSync(t, { recursive: true, force: true }); }
  for (const dirs of [{ tooling: ROOT }, { tooling: join(ROOT, "scripts") }, { tooling: "/nonexistent/tooling" }]) {
    const { res, rec } = await host("preflight", {}, {}, dirs);
    assert.deepEqual([res.result.code, rec.imports.length], ["CRH_LAYOUT_INVALID", 0], JSON.stringify(dirs));
  }
});

test("H6 child: only the OS allowlist + E7_TOOLING_DIR; canaries never cross; malformed values dropped; child failures refused", async () => {
  const CANARIES = { CUSTOM_API_TOKEN: "CANARY_tok_1", GITHUB_TOKEN: "CANARY_gh_3", NODE_PATH: "/CANARY_np_4", NODE_LOADER: "CANARY_ld_5",
    NPM_CONFIG_USERCONFIG: "/CANARY_npm_6", AWS_SECRET_ACCESS_KEY: "CANARY_aws_7", ACTIONS_RUNTIME_TOKEN: "CANARY_act_8" };
  const { res, rec } = await host("preflight", { ...CANARIES, E7_WORKFLOW_SHA: "b".repeat(40) });
  assert.equal(res.result.code, "PREFLIGHT_OK_PACKAGING_ONLY");
  assert.deepEqual(rec.spawns[0].o.env, { ...BASICS, E7_TOOLING_DIR: TOOLING });
  const out = JSON.stringify(res.result) + E.summaryMarkdown(res.result) + JSON.stringify(rec.spawns[0].o.env);
  for (const v of Object.values(CANARIES)) assert.equal(out.includes(v.replace(/^.*CANARY/, "CANARY")), false, v);
  assert.deepEqual([...E.CHILD_ENV_ALLOWLIST], ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "TZ"]);
  assert.deepEqual(E.childEnv({ PATH: "a\0b", HOME: "x".repeat(5000), TMP: 7, TZ: "UTC", E7_TOOLING_DIR: "/attacker" }, "/t"), { TZ: "UTC", E7_TOOLING_DIR: "/t" });
  const bad = [
    [{ status: 1, signal: null, stdout: "# tests 3\n# pass 2\n# fail 1\n", truncated: false, spawnFailed: false }, "CRH_TESTS_FAILED"],
    [{ status: 0, signal: null, stdout: "# tests 0\n# pass 0\n# fail 0\n", truncated: false, spawnFailed: false }, "CRH_TESTS_FAILED"],
    [{ status: 0, signal: null, stdout: "no tap", truncated: false, spawnFailed: false }, "CRH_TESTS_FAILED"],
    [{ status: null, signal: null, stdout: "", truncated: false, spawnFailed: true }, "CRH_CHILD_FAILED"],
    [{ status: 0, signal: "SIGKILL", stdout: "# tests 1\n# pass 1\n# fail 0\n", truncated: false, spawnFailed: false }, "CRH_CHILD_FAILED"],
    [{ status: 0, signal: null, stdout: "# tests 1\n# pass 1\n# fail 0\n", truncated: true, spawnFailed: false }, "CRH_CHILD_FAILED"]];
  for (const [o, code] of bad) assert.equal((await host("preflight", {}, { spawnChild: async () => o })).res.result.code, code, JSON.stringify(o));
  const envBad = await host("preflight", { NODE_OPTIONS: "--require x" });
  assert.deepEqual([envBad.res.result.code, envBad.rec.spawns.length], ["CRH_ENV_REFUSED", 0]);
  const nodeBad = await host("preflight", {}, { proc: { ...PROC, versions: { node: "24.22.1" } } });
  assert.deepEqual([nodeBad.res.result.code, nodeBad.rec.spawns.length], ["CRH_ENV_REFUSED", 0]);
});

test("H7 inert production path: the launcher source imports only node built-ins; no core / exchange / pool / journal construction exists; import gate refuses all else", async () => {
  const src = readFileSync(join(ROOT, "scripts/e7-connected-runner-hosted.mjs"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const statics = [...code.matchAll(/^import\s[^;]*?from\s+"([^"]+)";/gm)].map((m) => m[1]);
  assert.deepEqual(statics, ["node:process", "node:child_process", "node:crypto", "node:fs/promises", "node:url"]);
  assert.equal([...code.matchAll(/\bimport\(/g)].length, 1, "exactly one dynamic import: the restricted default importModule");
  for (const bad of ["runConnectedTest", "createE7HostawaySend", "createE7StripeTestSend", "createRealExchange", "createPhaseExecutors", "createBookingPool",
    "createFileJournal", "openFileJournal", "fetch(", "node:http", "node:https", "node:net", "node:tls", "node:dns", "\"pg\"", "npm ci", "secrets."])
    assert.equal(code.includes(bad), false, bad);
  // the gate: a constants variant that asks for a non-allowlisted module is refused before it is loaded (zero imports of run-core)
  const asked = [];
  const r = await E.runHosted({ mode: "preflight", env: { ...BASICS, E7_TOOLING_DIR: TOOLING }, proc: PROC, wrapperDir: ROOT,
    deps: { constants: { ...C, allowedImports: ["scripts/e7-connected/probe-env-preflight.mjs"] }, importModule: async (p) => { asked.push(p); return import(p); },
      spawnChild: tapOk } });
  assert.deepEqual([r.result.code, asked.length], ["CRH_IMPORT_REFUSED", 0], "run-manifest refused when not allowlisted; nothing loaded");
  // full real preflight in-process (fake child): the module graph loaded by the launcher contains no runner core / transport / exchange / pool
  const loaded = [];
  await E.runHosted({ mode: "preflight", env: { ...BASICS, E7_TOOLING_DIR: TOOLING }, proc: PROC, wrapperDir: ROOT,
    deps: { importModule: async (p) => { loaded.push(relative(TOOLING, p)); return import(p); }, spawnChild: tapOk } });
  assert.deepEqual(loaded, ["scripts/e7-connected/run-manifest.mjs", "scripts/e7-connected/probe-env-preflight.mjs"]);
  for (const m of ["run-core", "http-transports", "real-exchange", "run-journal-file", "executor-adapters", "pool.js", "-worker.js"]) assert.equal(loaded.join(" ").includes(m), false, m);
});

test("H8 synthetic manifest: accepted by the accepted validator; labelled synthetic; never a real intent (runs 1 / 2 / 3 refused)", async () => {
  const v = M.validateRunManifest(JSON.parse(JSON.stringify(C.syntheticManifest)));
  assert.equal(v.ok, true);
  assert.deepEqual([v.manifest.synthetic, v.manifest.providerMode.hostaway, v.manifest.providerMode.stripe], [true, "fake", "mock"]);
  assert.equal(C.neverAdopt.includes(C.syntheticManifest.intentId), false);
  assert.equal(M.validateRunManifest({ ...JSON.parse(JSON.stringify(C.syntheticManifest)), synthetic: false }).code, "REAL_RUN_NOT_IN_THIS_SLICE");
  for (const id of C.neverAdopt) {
    const sm = { ...C.syntheticManifest, intentId: id };
    const { res, rec } = await host("preflight", {}, { constants: { ...C, syntheticManifest: sm } });
    assert.deepEqual([res.result.code, rec.spawns.length], ["CRH_SYNTHETIC_ADOPTION_REFUSED", 0], id);
  }
  const broken = await host("preflight", {}, { constants: { ...C, syntheticManifest: { ...C.syntheticManifest, providerMode: { hostaway: "real", stripe: "test" } } } });
  assert.deepEqual([broken.res.result.code, broken.rec.spawns.length], ["CRH_MANIFEST_REFUSED", 0]);
});

test("P1 runner pins: workflow is preflight-only, no environment / secret / install, exact tooling commit + Node; runner digest covers the three files", async () => {
  const wf = readFileSync(join(ROOT, ".github/workflows/e7-connected-runner.yml"), "utf8");
  assert.ok(wf.includes(`ref: ${C.toolingCommit}`));
  assert.ok(/options: \[preflight\]\n/.test(wf));
  assert.ok(wf.includes('node-version: "22.22.0"'));
  for (const bad of ["secrets.", "environment:", "npm ci", "npm install", "E7_DEV_BOOKING", "STRIPE", "HOSTAWAY", "E7_MANIFEST", "E7_APPROVAL"]) assert.equal(wf.includes(bad), false, bad);
  assert.equal((wf.match(/persist-credentials: false/g) || []).length, 2);
  const d1 = await E.framedDigest(ROOT, C.runnerFiles, E.RUNNER_DIGEST_PREFIX);
  const { res } = await host("preflight");
  assert.equal(res.result.runnerDigest, d1);
  // .vercelignore on this branch excludes every new path from Vercel uploads
  const vi = readFileSync(join(ROOT, ".vercelignore"), "utf8").split("\n").map((l) => l.trim());
  for (const p of ["/scripts", "/test", "/.github", "/claude"]) assert.ok(vi.includes(p), p);
});

test("H9 REAL child: the five accepted fake-only suites run at the pinned tooling with the allowlisted env and pass (packaging proof only)", async () => {
  const { res } = await host("preflight", { TMPDIR: tmpdir(), HOME: process.env.HOME ?? tmpdir() }, { spawnChild: E.spawnNode });
  const r = res.result;
  assert.equal(r.code, "PREFLIGHT_OK_PACKAGING_ONLY", JSON.stringify(r.tests));
  assert.ok(r.tests.tests > 0 && r.tests.pass === r.tests.tests && r.tests.fail === 0, JSON.stringify(r.tests));
  assert.equal(r.tests.connectivityEvidence, false);
});
