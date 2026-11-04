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
if (a[0] === "prepare-plan") { const t = readFileSync(a[2], "utf8"); writeFileSync(a[4], t + "\\n", { mode: 0o600 }); rec.plan = JSON.parse(t);
  appendFileSync(ctl.record, JSON.stringify(rec) + "\\n"); process.stdout.write(JSON.stringify({ schema: "e7-probe-prepare-v1", code: "PREP_OK", planCode: null, planHash: sha(t + "\\n"), file: "CLOSED_ACK", exitCode: 0 }) + "\\n"); }
else if (a[0] === "inspect") { const t = readFileSync(a[2], "utf8"); const p = JSON.parse(t); const probes = ctl.probes ?? p.probes;
  appendFileSync(ctl.record, JSON.stringify(rec) + "\\n");
  process.stdout.write(JSON.stringify({ schema: "e7-probe-cli-stdout-v1", exitCode: ctl.inspectExit ?? 10, primaryOutcome: "CLI_INSPECT_OK", tailUncertain: false,
    output: { summaryFile: "NOT_ATTEMPTED", summaryCloseState: "NOT_OPENED" }, payload: { preflight: { code: ctl.envCode ?? "ENV_OK" }, source: { sourceDigest: ctl.digest },
    plan: { planHash: sha(t), probes, maxRequests: probes.length } } }) + "\\n"); }
else if (a[0] === "execute") { const cp = a[a.indexOf("--credentials") + 1]; const st = statSync(cp); const dirSt = statSync(cp.slice(0, cp.lastIndexOf("/")));
  const c = JSON.parse(readFileSync(cp, "utf8"));
  Object.assign(rec, { args: a.map((x, i) => (["--plan", "--credentials", "--summary-out"].includes(a[i - 1]) ? "<path>" : x)), credMode: st.mode & 0o777, credDirMode: dirSt.mode & 0o777,
    credKeys: Object.keys(c).sort(), credMatches: sha(c.hostawayToken + "|" + c.stripeTestKey) === ctl.credSha, credPath: cp });
  appendFileSync(ctl.record, JSON.stringify(rec) + "\\n");
  if (ctl.stderr) process.stderr.write(ctl.stderr);
  if (ctl.rawStdout !== undefined) { process.stdout.write(ctl.rawStdout); process.exit(0); }
  const probe = (id) => ({ id, outcome: "OK", code: ctl.probeCode ?? "PROBE_OK", httpStatus: id === "P-H1" ? 200 : null, transportCode: null, evidence: { secret: "x" } });
  process.stdout.write(JSON.stringify({ schema: "e7-probe-cli-stdout-v1", exitCode: 0, primaryOutcome: "CLI_COMPLETED_OK", tailUncertain: false,
    output: { summaryFile: "CLOSED_ACK", summaryCloseState: "CLOSED" }, payload: { preflight: { code: "ENV_OK" }, source: { sourceDigest: ctl.digest },
    plan: { planHash: a[a.indexOf("--expect-plan-hash") + 1] }, credential: { code: "CRED_OK", closeState: "CLOSED" }, requestsAttempted: 2,
    summary: { outcome: "COMPLETED", probes: [probe("P-H1"), probe("P-S1")], gates: { G_SHAPE_listing: "OBSERVED", G_FILTER: "NOT_PROBED" } }, finalize: { tail: "NONE" } } }) + "\\n"); }
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
