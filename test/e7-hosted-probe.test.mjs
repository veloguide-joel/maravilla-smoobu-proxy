// test/e7-hosted-probe.test.mjs — OFFLINE tests of the hosted wrapper (scripts/e7-hosted-probe.mjs). Node built-ins only.
// LABELS
//   * REAL: the wrapper, its real child-process runner (plain `node`, no shell) and real native fs over DISPOSABLE synthetic temp dirs.
//   * FAKE: the "tooling" checkout is a SYNTHETIC 13-file tree whose CLI is a FAKE script (prints canned C2-shaped lines, records what it
//     saw WITHOUT secret values) and whose E1 test is a trivial synthetic test. Its digest is computed independently here (test seam
//     `constants`); the accepted digest/tooling are NOT present on this branch. Nothing here is connectivity evidence.
//   * SYNTHETIC secrets `tokFakeHosted1` / `sk_test_FakeH1`. No real credential, env inspection, provider, network, install.
//   * node:https request / Agent and fetch are guarded in this process; the fake CLI children import no network module.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, realpathSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const GUARD = { request: 0, Agent: 0 };
const realReq = https.request; const RealAgent = https.Agent;
https.request = function g() { GUARD.request += 1; throw new Error("refused"); };
https.Agent = function g() { GUARD.Agent += 1; throw new Error("refused"); };
syncBuiltinESMExports();
const W = await import("../scripts/e7-hosted-probe.mjs");
https.request = realReq; https.Agent = RealAgent; syncBuiltinESMExports();
let fetches = 0; const realFetch = globalThis.fetch; globalThis.fetch = async () => { fetches += 1; throw new Error("refused"); };
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = []; const tmp = (p) => { const d = realpathSync(mkdtempSync(join(tmpdir(), p))); TMP.push(d); return d; };
after(() => { for (const d of TMP) rmSync(d, { recursive: true, force: true }); globalThis.fetch = realFetch; assert.deepEqual([GUARD.request, GUARD.Agent, fetches], [0, 0, 0]); });

const TOKEN = "tokFakeHosted1"; const KEY = "sk_test_FakeH1"; const ACCT = "acct_SyntheticOwner1"; const REF = "synthetic-label-1";
const sha = (s) => createHash("sha256").update(s).digest("hex");

// ---- FAKE CLI (closure entry 2 of the synthetic tree) ------------------------------------------------------------------------------
const FAKE_CLI = `import { readFileSync, writeFileSync, statSync, appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
const ctl = JSON.parse(readFileSync(new URL("../../control.json", import.meta.url), "utf8"));
const a = process.argv.slice(2); const sha = (s) => createHash("sha256").update(s).digest("hex");
const rec = { argv0: a[0], execArgvLen: process.execArgv.length, envHasE7: Object.keys(process.env).some((k) => k.startsWith("E7_")) };
const end = (stage, dflt) => { if (ctl.flood === stage) process.stdout.write("x".repeat(300000));
  if (ctl.signal === stage) { process.kill(process.pid, "SIGKILL"); return; }
  process.exitCode = (ctl.exit && stage in ctl.exit) ? ctl.exit[stage] : dflt; };
const H = ctl.hostile;
if (a[0] === "prepare-plan") { const t = readFileSync(a[2], "utf8"); writeFileSync(a[4], t + "\\n", { mode: 0o600 }); rec.plan = JSON.parse(t);
  appendFileSync(ctl.record, JSON.stringify(rec) + "\\n"); process.stdout.write(JSON.stringify({ schema: "e7-probe-prepare-v1", code: "PREP_OK", planCode: null, planHash: sha(t + "\\n"), file: "CLOSED_ACK", exitCode: 0 }) + "\\n"); end("prepare", 0); }
else if (a[0] === "inspect") { const t = readFileSync(a[2], "utf8"); const p = JSON.parse(t); const probes = ctl.probes ?? p.probes;
  appendFileSync(ctl.record, JSON.stringify(rec) + "\\n");
  process.stdout.write(JSON.stringify({ schema: "e7-probe-cli-stdout-v1", exitCode: ctl.inspectExit ?? 10, primaryOutcome: "CLI_INSPECT_OK", tailUncertain: false,
    output: { summaryFile: "NOT_ATTEMPTED", summaryCloseState: "NOT_OPENED" }, payload: { preflight: { code: ctl.inspectHostile ?? ctl.envCode ?? "ENV_OK" }, source: { sourceDigest: ctl.digest },
    plan: { planHash: sha(t), probes, maxRequests: probes.length } } }) + "\\n"); end("inspect", ctl.inspectExit ?? 10); }
else if (a[0] === "execute") { const cp = a[a.indexOf("--credentials") + 1]; const st = statSync(cp); const dirSt = statSync(cp.slice(0, cp.lastIndexOf("/")));
  const c = JSON.parse(readFileSync(cp, "utf8"));
  Object.assign(rec, { args: a.map((x, i) => (["--plan", "--credentials", "--summary-out"].includes(a[i - 1]) ? "<path>" : x)), credMode: st.mode & 0o777, credDirMode: dirSt.mode & 0o777,
    credKeys: Object.keys(c).sort(), credMatches: sha(c.hostawayToken + "|" + c.stripeTestKey) === ctl.credSha, credPath: cp });
  appendFileSync(ctl.record, JSON.stringify(rec) + "\\n");
  if (ctl.stderr) process.stderr.write(ctl.stderr);
  if (ctl.rawStdout !== undefined) { process.stdout.write(ctl.rawStdout); process.exit(0); }
  const probe = (id) => ({ id: H ?? id, outcome: H ?? "OK", code: H ?? ctl.probeCode ?? "PROBE_OK", httpStatus: id === "P-H1" ? 200 : null, transportCode: H ?? null, evidence: { secret: "x" } });
  const ex = ctl.execEnvelope ?? {};
  const exitCode = ex.exitCode ?? 0;
  process.stdout.write(JSON.stringify({ schema: "e7-probe-cli-stdout-v1", exitCode, primaryOutcome: H ?? ex.primaryOutcome ?? "CLI_COMPLETED_OK", tailUncertain: ex.tailUncertain ?? false,
    output: { summaryFile: H ?? ex.summaryFile ?? "CLOSED_ACK", summaryCloseState: H ?? "CLOSED" }, payload: { preflight: { code: H ?? "ENV_OK" }, source: { sourceDigest: H ?? ctl.digest },
    plan: { planHash: H ?? a[a.indexOf("--expect-plan-hash") + 1] }, credential: { code: H ?? "CRED_OK", closeState: H ?? "CLOSED" }, requestsAttempted: 2,
    summary: { outcome: H ?? "COMPLETED", probes: [probe("P-H1"), probe("P-S1")], gates: H ? { [H]: H, G_FILTER: H } : { G_SHAPE_listing: "OBSERVED", G_FILTER: "NOT_PROBED" } },
    finalize: { tail: H ?? "NONE" } } }) + "\\n");
  end("execute", exitCode); }
else process.exit(2);
`;
/** a synthetic "tooling" tree: the 13 closure paths (entry 2 = FAKE CLI), a trivial E1 test, control.json; plus runner temp + workspace */
function world(ctl = {}) {
  const tooling = tmp("e7hw-tool-"); const runnerTemp = tmp("e7hw-temp-"); const workspace = tmp("e7hw-ws-"); const recDir = tmp("e7hw-rec-");
  for (const [i, rel] of W.CONSTANTS.sourceClosure.entries()) { mkdirSync(join(tooling, dirname(rel)), { recursive: true }); writeFileSync(join(tooling, rel), rel.endsWith("probe-cli-main.mjs") ? FAKE_CLI : `// synthetic closure entry ${i}\n`); }
  mkdirSync(join(tooling, "test"), { recursive: true });
  writeFileSync(join(tooling, "test/e7-connected-probe-cli-main.test.mjs"), ctl.e1Fail ? "import { test } from 'node:test'; test('synthetic', () => { throw new Error('x'); });\n" : "import { test } from 'node:test'; test('synthetic', () => {});\n");
  const digest = independentDigest(tooling);
  const record = join(recDir, "record.jsonl"); writeFileSync(record, "");
  writeFileSync(join(tooling, "control.json"), JSON.stringify({ digest, record, credSha: sha(`${TOKEN}|${KEY}`), ...ctl }));
  const constants = { ...W.CONSTANTS, sourceDigest: digest };
  const env = (o = {}) => ({ PATH: process.env.PATH, E7_TOOLING_DIR: tooling, RUNNER_TEMP: runnerTemp, GITHUB_WORKSPACE: workspace, E7_WORKFLOW_SHA: "a".repeat(40), ...o });
  const records = () => readFileSync(record, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { tooling, runnerTemp, workspace, digest, constants, env, records };
}
/** independent framing (accepted recipe) — not the wrapper's function */
function independentDigest(dir) {
  const h = createHash("sha256"); h.update("e7-probe-source-v1\n");
  for (const rel of W.CONSTANTS.sourceClosure) { const b = readFileSync(join(dir, rel)); h.update(rel); h.update(Buffer.from([0])); h.update(String(b.length)); h.update(Buffer.from([0])); h.update(b); h.update(Buffer.from([0])); }
  return h.digest("hex");
}
const run = (w, mode, envOver, extra = {}) => W.runWrapper({ mode, env: w.env(envOver), spawnChild: W.spawnNode, constants: w.constants, ...extra });
const realPlanHash = async (w) => { const r = await run(w, "preflight", { E7_STRIPE_ACCOUNT_ID: ACCT, E7_APPROVAL_REF: REF }); assert.equal(r.result.code, "PREFLIGHT_OK_REAL_PLAN"); return r.result.planHash; };
const execEnv = (w, h, o = {}) => ({ E7_STRIPE_ACCOUNT_ID: ACCT, E7_APPROVAL_REF: REF, E7_EXPECTED_PLAN_HASH: h, E7_EXPECTED_SOURCE_DIGEST: w.digest, E7_HOSTAWAY_TOKEN: TOKEN, E7_STRIPE_TEST_KEY: KEY, ...o });
const leftovers = (w) => readdirSync(w.runnerTemp);
const clean = (r, extra = []) => { const s = JSON.stringify(r.result) + W.summaryMarkdown(r.result); for (const x of [TOKEN, KEY, "/tmp", ...extra]) assert.ok(!s.includes(x), `leak ${x}`); };

test("H1 mode defaults / usage; import is inert; accepted constants are the fixed reviewed values", async () => {
  assert.equal(W.CONSTANTS.sourceDigest, "23212caabf508f0aa929a2c3beb9f6f216b0cc3bc697cd783ba7ed203e21ce3d");
  assert.equal(W.CONSTANTS.toolingCommit, "d1e20d71ecf15f82d2d3b74fd22eb562eaa310f8"); assert.equal(W.CONSTANTS.listingId, 606998);
  assert.equal(W.CONSTANTS.sourceClosure.length, 13); assert.deepEqual([...W.CONSTANTS.probes], ["P-H1", "P-S1"]);
  assert.deepEqual({ ...W.CONSTANTS.limits }, { perProbeMs: 10000, runMs: 30000, tailMs: 5000 }); assert.equal(W.CONSTANTS.stripeVersion, "2026-08-26.dahlia");
  const w = world(); const d = await W.runWrapper({ env: w.env(), spawnChild: W.spawnNode, constants: w.constants });
  assert.equal(d.result.mode, "preflight");
  const u = await run(w, "bogus"); assert.equal(u.result.code, "HOSTED_USAGE"); assert.equal(u.exitCode, 1);
});

test("H2 preflight without an account: labelled SYNTHETIC plan only (listing 606998, P-H1 + P-S1, fixed limits); E1 run; no execute; children get no E7_* env and no Node flags", async () => {
  const w = world(); const r = await run(w, "preflight");
  assert.equal(r.result.code, "PREFLIGHT_OK_SYNTHETIC_ONLY"); assert.equal(r.exitCode, 0); assert.equal(r.result.planKind, "SYNTHETIC");
  assert.equal(r.result.sourceDigest, w.digest); assert.deepEqual({ ...r.result.e1, connectivityEvidence: false }, r.result.e1); assert.equal(r.result.e1.status, 0); assert.equal(r.result.e1.pass, 1);
  const recs = w.records(); assert.deepEqual(recs.map((x) => x.argv0), ["prepare-plan", "inspect"]);
  assert.ok(recs.every((x) => x.envHasE7 === false && x.execArgvLen === 0));
  const p = recs[0].plan; assert.equal(p.hostaway.listingId, 606998); assert.deepEqual(p.probes, ["P-H1", "P-S1"]); assert.equal(p.stripe.accountId, W.CONSTANTS.synthetic.accountId);
  assert.equal(p.metadata.approvalRef, W.CONSTANTS.synthetic.approvalRef); assert.deepEqual(p.limits, { perProbeMs: 10000, runMs: 30000, tailMs: 5000 });
  assert.deepEqual([p.hostaway.calendar, p.hostaway.lookup, p.hostaway.sample, p.hostaway.control, p.stripe.paymentIntentId], [null, null, null, null, null]);
  assert.equal(p.metadata.stripeVersion, "2026-08-26.dahlia"); assert.equal(p.metadata.nodeVersion, "22.22.0");
  assert.deepEqual(leftovers(w), []); clean(r);
  const f = world({ e1Fail: true }); const rf = await run(f, "preflight"); assert.equal(rf.result.code, "HOSTED_E1_FAILED"); assert.deepEqual(f.records(), []);
});

test("H3 preflight with account + label: REAL plan hash reported separately; incomplete / invalid inputs refuse code-only before any child", async () => {
  const w = world(); const r = await run(w, "preflight", { E7_STRIPE_ACCOUNT_ID: ACCT, E7_APPROVAL_REF: REF });
  assert.equal(r.result.code, "PREFLIGHT_OK_REAL_PLAN"); assert.equal(r.result.planKind, "REAL"); assert.match(r.result.planHash, /^[0-9a-f]{64}$/);
  assert.equal(w.records()[0].plan.stripe.accountId, ACCT);
  const syn = await run(w, "preflight"); assert.notEqual(syn.result.planHash, r.result.planHash);                     // never substituted
  for (const [o, code] of [[{ E7_STRIPE_ACCOUNT_ID: ACCT }, "HOSTED_INPUT_INCOMPLETE"], [{ E7_APPROVAL_REF: REF }, "HOSTED_INPUT_INCOMPLETE"],
    [{ E7_STRIPE_ACCOUNT_ID: "acct_bad-VALUE9", E7_APPROVAL_REF: REF }, "HOSTED_INPUT_INVALID"], [{ E7_STRIPE_ACCOUNT_ID: ACCT, E7_APPROVAL_REF: "bad label;rm" }, "HOSTED_INPUT_INVALID"]]) {
    const x = world(); const rr = await run(x, "preflight", o); assert.equal(rr.result.code, code); assert.deepEqual(x.records(), []); clean(rr, ["bad-VALUE9", "rm"]);
  }
});

test("H4 accepted closure bytes are verified BEFORE any tooling child: one changed byte / symlink / missing file refuse", async () => {
  const w = world(); writeFileSync(join(w.tooling, "lib/checkout/compensation-proof.js"), "// synthetic closure entry 9 CHANGED\n");
  const r = await run(w, "preflight"); assert.equal(r.result.code, "HOSTED_SOURCE_MISMATCH"); assert.deepEqual(w.records(), []);
  const s = world(); const t = join(s.tooling, "lib/checkout/intent-state.js"); const real = join(s.tooling, "real.js"); writeFileSync(real, readFileSync(t)); rmSync(t); symlinkSync(real, t);
  assert.equal((await run(s, "preflight")).result.code, "HOSTED_SOURCE_UNREADABLE"); assert.deepEqual(s.records(), []);
  const m = world(); rmSync(join(m.tooling, "package.json")); assert.equal((await run(m, "preflight")).result.code, "HOSTED_SOURCE_UNREADABLE");
  // the wrapper's own framing equals an independent implementation
  assert.equal(await W.closureDigest(w.tooling, W.CONSTANTS.sourceClosure), independentDigest(w.tooling));
  // layout: runner temp inside the workspace / tooling refuses
  const l = world(); assert.equal((await run(l, "preflight", { RUNNER_TEMP: l.tooling })).result.code, "HOSTED_LAYOUT_INVALID");
  const l2 = world(); mkdirSync(join(l2.workspace, "t")); assert.equal((await run(l2, "preflight", { RUNNER_TEMP: join(l2.workspace, "t") })).result.code, "HOSTED_LAYOUT_INVALID");
});

test("H5 verify / execute need every explicit input (no defaults); wrong digest refuses; verify refuses if secrets are in scope", async () => {
  const w = world(); const h = "b".repeat(64);
  for (const drop of ["E7_STRIPE_ACCOUNT_ID", "E7_APPROVAL_REF", "E7_EXPECTED_PLAN_HASH", "E7_EXPECTED_SOURCE_DIGEST"]) for (const mode of ["verify", "execute"]) {
    const x = world(); const e = execEnv(x, h); delete e[drop]; if (mode === "verify") { delete e.E7_HOSTAWAY_TOKEN; delete e.E7_STRIPE_TEST_KEY; }
    const r = await run(x, mode, e); assert.equal(r.result.code, "HOSTED_INPUT_INCOMPLETE", `${mode} ${drop}`); assert.deepEqual(x.records(), []); assert.deepEqual(leftovers(x), []);
  }
  const r2 = await run(w, "execute", execEnv(w, h, { E7_EXPECTED_SOURCE_DIGEST: "c".repeat(64) })); assert.equal(r2.result.code, "HOSTED_SOURCE_MISMATCH"); assert.deepEqual(w.records(), []);
  const r3 = await run(w, "verify", execEnv(w, h)); assert.equal(r3.result.code, "HOSTED_SECRET_SCOPE_VIOLATION"); assert.deepEqual(w.records(), []);
  const r4 = await run(w, "preflight", { E7_HOSTAWAY_TOKEN: TOKEN }); assert.equal(r4.result.code, "HOSTED_SECRET_SCOPE_VIOLATION"); clean(r4);
});

test("H6 planHash / env / scope mismatches refuse AFTER inspect but BEFORE any credential file or execute child", async () => {
  const w = world(); const r = await run(w, "execute", execEnv(w, "e".repeat(64)));
  assert.equal(r.result.code, "HOSTED_PLAN_HASH_MISMATCH"); assert.deepEqual(w.records().map((x) => x.argv0), ["prepare-plan", "inspect"]); assert.deepEqual(leftovers(w), []);
  const e = world({ envCode: "ENV_VARIABLE_REFUSED" }); const h = (await (async () => { const t = world(); return realPlanHash(t); })());
  const re = await run(e, "execute", execEnv(e, h)); assert.equal(re.result.code, "HOSTED_ENV_REFUSED"); assert.ok(!e.records().some((x) => x.argv0 === "execute"));
  const s = world({ probes: ["P-H1", "P-H2", "P-S1"] }); const rs = await run(s, "preflight"); assert.equal(rs.result.code, "HOSTED_SCOPE_INVALID");
  const d = world({ digest: "f".repeat(64) }); const rd = await run(d, "preflight"); assert.equal(rd.result.code, "HOSTED_SOURCE_MISMATCH");     // inspect-reported digest must match too
  const i = world({ inspectExit: 4 }); assert.equal((await run(i, "preflight")).result.code, "HOSTED_INSPECT_FAILED");
  // fixed scope: a protected or changed listing / probe list refuses in the plan builder
  for (const over of [{ listingId: 70636076 }, { probes: ["P-H1", "P-H2"] }, { probes: ["P-H1"] }])
    assert.throws(() => W.buildPlan({ ...W.CONSTANTS, ...over }, ACCT, REF), (x) => x.code === "HOSTED_SCOPE_INVALID");
});

test("H7 execute (FAKE CLI child): private 0600 credential file in a fresh 0700 dir outside both checkouts; exact argv; secrets never in child env or output; cleanup", async () => {
  const w = world(); const h = await realPlanHash(w);
  const r = await run(w, "execute", execEnv(w, h));
  assert.equal(r.result.code, "EXECUTE_COMPLETED_OK"); assert.equal(r.exitCode, 0);
  const ex = w.records().find((x) => x.argv0 === "execute");
  assert.equal(ex.credMode, 0o600); assert.equal(ex.credDirMode, 0o700); assert.deepEqual(ex.credKeys, ["hostawayToken", "stripeTestKey"]); assert.equal(ex.credMatches, true);
  assert.equal(ex.envHasE7, false); assert.equal(ex.execArgvLen, 0);
  assert.ok(ex.credPath.startsWith(`${w.runnerTemp}/`) && !ex.credPath.startsWith(w.tooling) && !ex.credPath.startsWith(w.workspace));
  assert.deepEqual(ex.args, ["execute", "--plan", "<path>", "--credentials", "<path>", "--summary-out", "<path>", "--expect-plan-hash", h, "--expect-source-digest", w.digest,
    "--expect-requests", "2", "--approval-ref", REF]);
  assert.ok(!existsSync(ex.credPath)); assert.deepEqual(leftovers(w), []);                                              // job-owned temp removed
  const e = r.result.execute; assert.equal(e.primaryOutcome, "CLI_COMPLETED_OK"); assert.equal(e.summaryFile, "CLOSED_ACK"); assert.equal(e.requestsAttempted, 2);
  assert.deepEqual(e.probes.map((p) => p.id), ["P-H1", "P-S1"]); assert.ok(!JSON.stringify(e).includes("evidence"));     // only the reviewed projection
  clean(r, [ACCT]);
});

test("H8 missing credentials fail closed; hostile / malformed child output is projected or UNKNOWN; stderr content never published", async () => {
  const w = world(); const h = await realPlanHash(w);
  for (const drop of ["E7_HOSTAWAY_TOKEN", "E7_STRIPE_TEST_KEY"]) {
    const x = world(); const hh = await realPlanHash(x); const e = execEnv(x, hh); e[drop] = "";
    const r = await run(x, "execute", e); assert.equal(r.result.code, "HOSTED_CREDENTIALS_MISSING"); assert.ok(!x.records().some((y) => y.argv0 === "execute")); assert.deepEqual(leftovers(x), []);
  }
  const hostile = world({ probeCode: `/home/runner/${TOKEN}`, stderr: `boom ${KEY} /tmp/secret-path\n` }); const hh = await realPlanHash(hostile);
  const r = await run(hostile, "execute", execEnv(hostile, hh));
  assert.ok(r.result.execute.probes.every((p) => p.code === "REDACTED")); assert.ok(r.result.childStderrBytes > 0); clean(r, ["boom", "secret-path"]);
  const bad = world({ rawStdout: `not json ${TOKEN}\n` }); const hb = await realPlanHash(bad);
  const rb = await run(bad, "execute", execEnv(bad, hb)); assert.equal(rb.result.code, "HOSTED_CHILD_OUTPUT_UNKNOWN"); assert.equal(rb.result.execute.output, "UNKNOWN"); clean(rb);
  assert.deepEqual(leftovers(bad), []);
  void w; void h;
});

test("H9 workflow static pins: manual dispatch only, contents:read, pinned official SHAs, no persisted credentials, fixed tooling commit, secrets only in the final step", () => {
  const y = readFileSync(join(ROOT, ".github/workflows/e7-readonly-probe.yml"), "utf8");
  const onBlock = y.slice(y.indexOf("\non:"), y.indexOf("\npermissions:"));
  assert.match(onBlock, /^\s{2}workflow_dispatch:/m);
  for (const t of ["push:", "pull_request", "schedule:", "workflow_run", "repository_dispatch", "issue_comment", "workflow_call"]) assert.ok(!y.includes(t), t);
  assert.match(y, /\npermissions:\n {2}contents: read\n\n/); assert.match(y, /cancel-in-progress: false/);
  const uses = y.match(/uses: \S+/g); assert.deepEqual([...new Set(uses)].sort(), ["uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803", "uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38"]);
  assert.equal((y.match(/persist-credentials: false/g) || []).length, (y.match(/actions\/checkout@/g) || []).length);
  assert.equal((y.match(/ref: d1e20d71ecf15f82d2d3b74fd22eb562eaa310f8/g) || []).length, 2);
  assert.equal((y.match(/node-version: "22\.22\.0"/g) || []).length, 2); assert.equal((y.match(/runs-on: ubuntu-24\.04/g) || []).length, 2);
  assert.match(y, /environment: e7-readonly-probe/); assert.match(y, /if: inputs\.mode == 'execute' && github\.ref == 'refs\/heads\/main'/);
  // secrets appear only in the last step's env block
  const lastStep = y.slice(y.lastIndexOf("      - name:"));
  assert.equal((y.match(/secrets\./g) || []).length, 2); assert.equal((lastStep.match(/secrets\./g) || []).length, 2);
  assert.ok(!/secrets\.GITHUB_TOKEN|toJSON\(secrets\)|github\.token/.test(y));
  // inputs only through env (never interpolated into run: lines); every run line is a fixed command
  for (const line of y.split("\n").filter((l) => /^\s+run:/.test(l))) assert.match(line, /^\s+run: node wrapper\/scripts\/e7-hosted-probe\.mjs (preflight|verify|execute)$/);
  assert.ok(!/upload-artifact|actions\/cache/.test(y));
});

test("H10 wrapper source pins: Node built-ins only; no network module, shell, eval or console; single inert entry guard", () => {
  const src = readFileSync(join(ROOT, "scripts/e7-hosted-probe.mjs"), "utf8");
  assert.deepEqual(src.match(/^import .* from "([^"]+)";$/gm).map((l) => l.replace(/^.* from "|";$/g, "")), ["node:process", "node:child_process", "node:crypto", "node:fs/promises"]);
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  for (const re of [/node:https?\b|node:net|node:tls|node:dns/, /\bfetch\b/, /shell: true/, /\beval\b|new Function/, /\bconsole\b/, /\bimport\s*\(/, /\brequire\s*\(/, /JSON\.stringify\(env\)|JSON\.stringify\(process\.env\)/])
    assert.doesNotMatch(code, re, String(re));
  assert.equal((code.match(/import\.meta\.main/g) || []).length, 1); assert.match(code, /shell: false/);
});

// ===== root CODE HOLD corrections (R-H1 / R-H2 / R-H3) ==================================================================================
const failedSpawn = (stage) => (args, o) => (args[1] === stage || (stage === "prepare" && args[1] === "prepare-plan") || (stage === "e1" && args[0] === "--test")
  ? Promise.resolve({ status: null, signal: null, stdout: "", truncated: false, stderrBytes: 0, spawnFailed: true }) : W.spawnNode(args, o));
const statusOverride = (stage, status) => async (args, o) => { const r = await W.spawnNode(args, o); return args[1] === stage ? { ...r, status } : r; };
test("R-H1 true child status: nonzero / signal / spawn failure / truncation at any pre-secret stage → zero credential file, zero execute; execute status must agree", async () => {
  const pre = [["prepare", { exit: { prepare: 3 } }], ["prepare", { signal: "prepare" }], ["prepare", { flood: "prepare" }], ["inspect", { exit: { inspect: 0 } }],
    ["inspect", { exit: { inspect: 4 } }], ["inspect", { signal: "inspect" }], ["inspect", { flood: "inspect" }]];
  for (const [stage, ctl] of pre) for (const mode of ["preflight", "execute"]) {
    const w = world(ctl); const h = "a".repeat(64);
    const r = await W.runWrapper({ mode, env: w.env(mode === "execute" ? execEnv(w, h) : {}), spawnChild: W.spawnNode, constants: w.constants });
    assert.equal(r.exitCode, 1, `${stage} ${JSON.stringify(ctl)} ${mode}`); assert.ok(!/OK/.test(r.result.code), r.result.code);
    assert.ok(!w.records().some((x) => x.argv0 === "execute")); assert.deepEqual(leftovers(w), []);
  }
  for (const stage of ["e1", "prepare", "inspect"]) {
    const w = world(); const r = await W.runWrapper({ mode: "preflight", env: w.env(), spawnChild: failedSpawn(stage), constants: w.constants });
    assert.equal(r.result.code, "HOSTED_CHILD_FAILED", stage); assert.equal(r.exitCode, 1);
  }
  // E1: status 0 is not enough without an acknowledged meaningful TAP
  { const w = world(); const r = await W.runWrapper({ mode: "preflight", env: w.env(), constants: w.constants,
      spawnChild: async (args, o) => (args[0] === "--test" ? { status: 0, signal: null, stdout: "", truncated: false, stderrBytes: 0, spawnFailed: false } : W.spawnNode(args, o)) });
    assert.equal(r.result.code, "HOSTED_E1_FAILED"); }
  // execute: root repro — child status 17 while stdout claims exit 0 → never success
  { const w = world(); const h = await realPlanHash(w);
    const r = await W.runWrapper({ mode: "execute", env: w.env(execEnv(w, h)), spawnChild: statusOverride("execute", 17), constants: w.constants });
    assert.equal(r.exitCode, 1); assert.equal(r.result.code, "HOSTED_CHILD_OUTPUT_UNKNOWN"); }
  for (const ctl of [{ signal: "execute" }, { flood: "execute" }]) {
    const w = world(ctl); const h = await realPlanHash(w); const r = await run(w, "execute", execEnv(w, h));
    assert.equal(r.exitCode, 1); assert.ok(["HOSTED_CHILD_FAILED", "HOSTED_CHILD_OUTPUT_UNKNOWN"].includes(r.result.code), r.result.code); assert.deepEqual(leftovers(w), []);
  }
  // a known nonzero accepted outcome stays a failure WITH evidence (status agrees with the envelope)
  { const w = world({ execEnvelope: { exitCode: 6, primaryOutcome: "CLI_PROBE_STOPPED" } }); const h = await realPlanHash(w); const r = await run(w, "execute", execEnv(w, h));
    assert.equal(r.exitCode, 1); assert.equal(r.result.code, "EXECUTE_NOT_OK"); assert.equal(r.result.execute.exitCode, 6); assert.equal(r.result.execute.primaryOutcome, "CLI_PROBE_STOPPED"); }
  // success requires every accepted success field to agree
  for (const env of [{ summaryFile: "UNKNOWN" }, { tailUncertain: true }, { primaryOutcome: "CLI_COMPLETED_INCONCLUSIVE" }]) {
    const w = world({ execEnvelope: env }); const h = await realPlanHash(w); const r = await run(w, "execute", execEnv(w, h));
    assert.equal(r.exitCode, 1, JSON.stringify(env)); assert.notEqual(r.result.code, "EXECUTE_COMPLETED_OK");
  }
});
test("R-H2 exact vocabularies: a plain-ASCII token / key planted in EVERY published child field never reaches stdout JSON or the Markdown summary", async () => {
  for (const S of [TOKEN, KEY, "PROBE_OK_BUT_NOT_REALLY"]) {
    const w = world({ hostile: S }); const h = await realPlanHash(w); const r = await run(w, "execute", execEnv(w, h));
    const out = JSON.stringify(r.result) + W.summaryMarkdown(r.result);
    assert.ok(!out.includes(S), `leak ${S}`); assert.notEqual(r.result.code, "EXECUTE_COMPLETED_OK");
    assert.ok(r.result.execute.probes.every((p) => p.id === "REDACTED" && p.code === "REDACTED" && p.outcome === "REDACTED" && p.transportCode === "REDACTED"));
  }
  const wi = world({ inspectHostile: TOKEN }); const ri = await run(wi, "preflight");
  assert.equal(ri.result.code, "HOSTED_ENV_REFUSED"); assert.ok(!(JSON.stringify(ri.result) + W.summaryMarkdown(ri.result)).includes(TOKEN));
  // valid evidence stays useful
  const ok = world(); const h = await realPlanHash(ok); const r = await run(ok, "execute", execEnv(ok, h));
  assert.equal(r.result.code, "EXECUTE_COMPLETED_OK"); assert.deepEqual(r.result.execute.probes.map((p) => [p.id, p.outcome, p.code]), [["P-H1", "OK", "PROBE_OK"], ["P-S1", "OK", "PROBE_OK"]]);
  assert.deepEqual(r.result.execute.gates, { G_SHAPE_listing: "OBSERVED", G_FILTER: "NOT_PROBED" }); assert.equal(r.result.execute.planHash, h);
});
test("R-H2 parity: the copied vocabularies equal the accepted tooling exports (runs only where the accepted tooling checkout is available)", { skip: !process.env.E7_PARITY_TOOLING_DIR }, async () => {
  const d = process.env.E7_PARITY_TOOLING_DIR;
  const P = await import(`${d}/scripts/e7-connected/readonly-probe.mjs`); const C2 = await import(`${d}/scripts/e7-connected/probe-command.mjs`);
  const E = await import(`${d}/scripts/e7-connected/probe-env-preflight.mjs`); const C1 = await import(`${d}/scripts/e7-connected/probe-credential-file.mjs`);
  const V = W.VOCAB;
  assert.deepEqual([...V.probeIds], [...P.PROBE_IDS]); assert.deepEqual([...V.probeCodes], [...P.CODES.probe]); assert.deepEqual([...V.transportCodes], [...P.T_ERROR_CODES]);
  assert.deepEqual([...V.gateValues], [...P.CODES.gate]); assert.deepEqual([...V.tail], [...P.CODES.tail]); assert.deepEqual([...V.primaryOutcomes], [...C2.PRIMARY_OUTCOMES]);
  assert.deepEqual([...V.summaryFile], [...C2.SUMMARY_FILE_STATES]); assert.deepEqual([...V.envCodes], [...E.ENV_CODES]); assert.deepEqual([...V.credCodes], [...C1.CREDENTIAL_CODES]);
  assert.deepEqual([...V.closeStates], [...C1.CLOSE_STATES]);
});
test("R-H3 the reserved SYNTHETIC account or label can never qualify a REAL plan: refused in verify / execute and as explicit preflight inputs, before any tooling child", async () => {
  const w0 = world(); const syn = await run(w0, "preflight"); assert.equal(syn.result.planKind, "SYNTHETIC"); const sh = syn.result.planHash;
  const S = W.CONSTANTS.synthetic;
  for (const [acct, ref] of [[S.accountId, S.approvalRef], [S.accountId, REF], [ACCT, S.approvalRef]]) {
    for (const mode of ["verify", "execute"]) {
      const w = world(); const e = execEnv(w, sh, { E7_STRIPE_ACCOUNT_ID: acct, E7_APPROVAL_REF: ref }); if (mode === "verify") { delete e.E7_HOSTAWAY_TOKEN; delete e.E7_STRIPE_TEST_KEY; }
      const r = await run(w, mode, e); assert.equal(r.result.code, "HOSTED_INPUT_INVALID", `${mode} ${acct} ${ref}`); assert.deepEqual(w.records(), []); assert.equal(r.result.sourceDigest, null);
    }
    const wp = world(); const rp = await run(wp, "preflight", { E7_STRIPE_ACCOUNT_ID: acct, E7_APPROVAL_REF: ref }); assert.equal(rp.result.code, "HOSTED_INPUT_INVALID"); assert.deepEqual(wp.records(), []);
  }
});
