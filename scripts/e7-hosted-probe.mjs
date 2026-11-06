// scripts/e7-hosted-probe.mjs — thin HOSTED wrapper around the ACCEPTED E7 read-only probe CLI (tooling commit below), for a manually
// dispatched GitHub-hosted Ubuntu runner. Node built-ins only. Doc: claude/e7-hosted-probe.md.
//   * Modes: `preflight` (DEFAULT; no secrets, no provider request), `verify` (execute job, no secrets), `execute` (at most THREE read-only
//     GETs P-H2 calendar + P-S1 TEST account + P-S2 TEST PaymentIntent, in that order; P-S2 only after P-S1; G6B scope; Stripe-Version
//     2026-01-28.clover; NOT AUTHORIZED until Joel approves the exact filled package — this code is not consent).
//   * The accepted tooling is checked out separately; this wrapper verifies its 13-path closure bytes against the FIXED accepted
//     sourceDigest BEFORE invoking it, and compares planHash / approvalRef / env preflight BEFORE any credential file or network.
//   * The accepted CLI runs as separate plain `node` children (no Node flags); argv is a fixed token list (no shell); the children's env is
//     the job env MINUS every E7_* key (so the two secrets never reach a child); refused security variables are NOT unset or bypassed.
//   * Public output is a whitelisted projection only: never a secret, path, raw child stdout / stderr or error text.
//   * This wrapper's own bytes and the workflow are a SEPARATE review boundary — not covered by the accepted C3 sourceDigest.
import process from "node:process";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { open, mkdtemp, realpath, lstat, readFile, rm, appendFile } from "node:fs/promises";

export const CONSTANTS = Object.freeze({
  toolingCommit: "43ef79cab2c928e2aad19e77258b4b31116ff7c0",           // G6B Clover tooling (d1e20d71 + version constant + tests)
  sourceDigest: "19b99e6f97cff5d8e405b3b52feff99f441445796b9651a719ffca046d8069f0",
  sourceClosure: Object.freeze(["package.json", "scripts/e7-connected/probe-cli-main.mjs", "scripts/e7-connected/probe-source-digest.mjs",
    "scripts/e7-connected/probe-command.mjs", "scripts/e7-connected/probe-env-preflight.mjs", "scripts/e7-connected/probe-credential-file.mjs",
    "scripts/e7-connected/readonly-probe.mjs", "scripts/e7-connected/http-transports.mjs", "scripts/e7-connected/real-exchange.mjs",
    "lib/checkout/compensation-proof.js", "lib/checkout/recovery-plan.js", "lib/checkout/capture-proof.js", "lib/checkout/intent-state.js"]),
  listingId: 606998,                                                  // "maraVilla TEST - DO NOT BOOK." — USD, root-verified in the Hostaway UI
  protectedIds: Object.freeze(["70636076", "71045356", "71072615", "71081885"]),
  probes: Object.freeze(["P-H2", "P-S1", "P-S2"]),
  maxRequests: 3,
  calendar: Object.freeze({ startDate: "2027-01-18", endDate: "2027-01-20" }),   // the Run-3 TEST stay on 606998
  paymentIntentId: "pi_3UYqhH2B9LTneQgw1Q0IoYtz",                      // the canceled Run-3 TEST PaymentIntent (read only)
  nodeVersion: "22.22.0",
  stripeVersion: "2026-01-28.clover",
  limits: Object.freeze({ perProbeMs: 10000, runMs: 30000, tailMs: 5000 }),
  synthetic: Object.freeze({ accountId: "acct_SyntheticPreflightOnly", approvalRef: "SYNTHETIC-preflight-not-for-execute" })
});
export const RESULT_SCHEMA = "e7-hosted-probe-result-v1";
/** exact public vocabularies COPIED from the accepted tooling (readonly-probe / probe-command / probe-env-preflight / probe-credential-file at
 *  d1e20d71 = unchanged at 43ef79ca); a parity test compares them with the accepted exports wherever that checkout is available. Every published child string must be
 *  a member of its field's set (or an exact 64-hex digest / hash) — anything else is published as REDACTED. */
export const VOCAB = Object.freeze({
  probeIds: Object.freeze(["P-H1", "P-H2", "P-H3", "P-H4", "P-H5", "P-H6", "P-S1", "P-S2"]),
  probeOutcomes: Object.freeze(["OK", "INCONCLUSIVE", "STOP", "NOT_RUN"]),
  runOutcomes: Object.freeze(["COMPLETED", "STOPPED"]),
  probeCodes: Object.freeze(["PROBE_OK", "PROBE_AUTH_REFUSED", "PROBE_HTTP_STATUS", "PROBE_SHAPE_MISMATCH", "PROBE_LISTING_MISMATCH", "PROBE_RESERVATION_MISMATCH",
    "PROBE_FOREIGN_ROW", "PROBE_PROTECTED_SEEN", "PROBE_ACCOUNT_MISMATCH", "PROBE_LIVEMODE_REFUSED", "PROBE_INCOMPLETE", "PROBE_PAGE_FULL", "PROBE_LIMIT_REACHED",
    "PROBE_EMPTY_SAMPLE", "PROBE_CONTROL_OVERLAP", "PROBE_CHARGE_ABSENT", "PROBE_PROOF_FIELDS_INCOMPLETE", "PROBE_TRANSPORT_FAILED", "PROBE_TIMEOUT", "PROBE_CANCELLED",
    "PROBE_BUDGET_EXHAUSTED", "PROBE_DEPENDENCY_FAILED", "AFTER_STOP", "PREREQ_INCONCLUSIVE"]),
  transportCodes: Object.freeze(["OPTIONS_INVALID", "REQUEST_NOT_ALLOWED", "ABORTED", "ABORTED_IN_FLIGHT", "CREDENTIAL_INVALID", "KEY_NOT_TEST", "EXCHANGE_FAILED",
    "REDIRECT_REFUSED", "ACCOUNT_MISMATCH", "REPLY_INVALID", "BODY_TOO_LARGE", "JSON_INVALID", "LIVEMODE_REFUSED", "STRIPE_HTTP_4XX", "STRIPE_HTTP_5XX"]),
  gateNames: Object.freeze(["G_AUTH_charges_read", "G_FILTER", "G_SHAPE_listing", "G_SHAPE_calendar", "G_SHAPE_lookup", "G_SHAPE_reservation", "G_SHAPE_charges",
    "B4_pi_read", "TEST_mode_pi"]),
  gateValues: Object.freeze(["OBSERVED", "SINGLE_SAMPLE", "INCONCLUSIVE", "OPEN", "NOT_PROBED"]),
  tail: Object.freeze(["NONE", "LATE_FULFILLED", "LATE_REJECTED", "UNSETTLED", "UNOBSERVABLE"]),
  primaryOutcomes: Object.freeze(["CLI_INSPECT_OK", "CLI_COMPLETED_OK", "CLI_COMPLETED_INCONCLUSIVE", "CLI_PROBE_STOPPED", "CLI_USAGE", "CLI_DEPS_INVALID",
    "CLI_ENV_REFUSED", "CLI_SOURCE_UNREADABLE", "CLI_SOURCE_MISMATCH", "CLI_PLAN_UNREADABLE", "CLI_PLAN_INVALID", "CLI_BINDING_MISMATCH", "CLI_OUTPUT_PARENT_INVALID",
    "CLI_OUTPUT_EXISTS", "CLI_CREDENTIAL_REFUSED", "CLI_INTERRUPTED", "CLI_INTERNAL"]),
  summaryFile: Object.freeze(["NOT_ATTEMPTED", "RACE_EXISTS", "UNKNOWN", "CLOSED_ACK"]),
  closeStates: Object.freeze(["CLOSED", "CLOSE_FAILED", "UNCLOSABLE", "NOT_OPENED"]),
  envCodes: Object.freeze(["ENV_OK", "ENV_SNAPSHOT_INVALID", "ENV_NODE_UNSUPPORTED", "ENV_PLATFORM_UNSUPPORTED", "ENV_EXEC_FLAGS", "ENV_VARIABLE_REFUSED", "ENV_UID_UNAVAILABLE"]),
  credCodes: Object.freeze(["CRED_OK", "CRED_INPUT_INVALID", "CRED_ADAPTER_INVALID", "CRED_PLATFORM_UNSUPPORTED", "CRED_PATH_INVALID", "CRED_PATH_NOT_CANONICAL",
    "CRED_IN_REPO", "CRED_IN_GIT_TREE", "CRED_MISSING", "CRED_NOT_REGULAR", "CRED_OWNER", "CRED_MODE", "CRED_LINKS", "CRED_SIZE", "CRED_CHANGED", "CRED_IO", "CRED_CLOSE_FAILED",
    "CRED_PARSE", "CRED_SHAPE", "CRED_KEY_NOT_TEST"])
});
const PREP_SCHEMA = "e7-probe-prepare-v1"; const STDOUT_SCHEMA = "e7-probe-cli-stdout-v1";
const MAX_FILE = 262144; const MAX_TOTAL = 2097152; const MAX_STDOUT = 262144;
const HEX64 = /^[0-9a-f]{64}$/; const HEX40 = /^[0-9a-f]{40}$/;
const ACCT_RE = /^acct_[A-Za-z0-9]{1,64}$/; const REF_RE = /^[A-Za-z0-9._:-]{1,80}$/;
const CLI = "scripts/e7-connected/probe-cli-main.mjs";
const E1_TEST = "test/e7-connected-probe-cli-main.test.mjs";

class Refusal extends Error { constructor(code) { super("e7-hosted"); this.code = code; } }
const refuse = (code) => { throw new Refusal(code); };
const within = (p, root) => root === "/" || p === root || p.startsWith(`${root}/`);

/** framed SHA-256 over the fixed closure (same recipe as the accepted helper): regular files only, no symlink, bounded */
export async function closureDigest(dir, closure) {
  const h = createHash("sha256"); h.update("e7-probe-source-v1\n"); let total = 0;
  for (const rel of closure) {
    const p = `${dir}/${rel}`; const st = await lstat(p);
    if (!st.isFile() || st.size < 1 || st.size > MAX_FILE) refuse("HOSTED_SOURCE_UNREADABLE");
    const b = await readFile(p); if (b.length !== st.size) refuse("HOSTED_SOURCE_UNREADABLE");
    total += b.length; if (total > MAX_TOTAL) refuse("HOSTED_SOURCE_UNREADABLE");
    h.update(rel); h.update(Buffer.from([0])); h.update(String(b.length)); h.update(Buffer.from([0])); h.update(b); h.update(Buffer.from([0]));
  }
  return h.digest("hex");
}
const G6B_PROBES = Object.freeze(["P-H2", "P-S1", "P-S2"]);
const sameList = (a, b) => Array.isArray(a) && a.length === b.length && a.every((x, i) => x === b[i]);
/** the plan object for this package: fixed listing / calendar / PaymentIntent / probes / limits / versions; account + label from inputs (or the labelled synthetic) */
export function buildPlan(c, accountId, approvalRef) {
  if (!Number.isSafeInteger(c.listingId) || c.listingId < 1 || c.protectedIds.includes(String(c.listingId))) refuse("HOSTED_SCOPE_INVALID");
  if (!sameList(c.probes, G6B_PROBES) || c.maxRequests !== 3) refuse("HOSTED_SCOPE_INVALID");
  if (!c.calendar || c.calendar.startDate !== "2027-01-18" || c.calendar.endDate !== "2027-01-20" || c.paymentIntentId !== "pi_3UYqhH2B9LTneQgw1Q0IoYtz"
      || c.stripeVersion !== "2026-01-28.clover") refuse("HOSTED_SCOPE_INVALID");
  return { version: "e7-probe-plan-v1", metadata: { reviewedCommit: c.toolingCommit, nodeVersion: c.nodeVersion, stripeVersion: c.stripeVersion, approvalRef },
    hostaway: { listingId: c.listingId, calendar: { startDate: c.calendar.startDate, endDate: c.calendar.endDate }, lookup: null, sample: null, control: null },
    stripe: { accountId, paymentIntentId: c.paymentIntentId }, probes: [...c.probes], limits: { ...c.limits } };
}
const parseLine = (s) => { try { const t = s.trim(); if (!t || t.includes("\n")) return null; const v = JSON.parse(t); return v && typeof v === "object" ? v : null; } catch { return null; } };
/** exact membership, never a syntax rule: null / undefined → null; a member → itself; anything else → "REDACTED" */
const inSet = (set) => (v) => (v === null || v === undefined ? null : typeof v === "string" && set.includes(v) ? v : "REDACTED");
const hex64 = (v) => (v === null || v === undefined ? null : typeof v === "string" && HEX64.test(v) ? v : "REDACTED");
const safeNum = (v) => (Number.isSafeInteger(v) ? v : null);
const safeBool = (v) => (typeof v === "boolean" ? v : null);
const httpStatus = (v) => (Number.isSafeInteger(v) && v >= 100 && v <= 599 ? v : null);
/** reviewed projection of the accepted C2 stdout envelope — nothing else from the child is ever published */
export function projectEnvelope(e) {
  const p = e && e.payload && typeof e.payload === "object" ? e.payload : null;
  const s = p && p.summary && typeof p.summary === "object" ? p.summary : null;
  const V = VOCAB;
  const probes = s && Array.isArray(s.probes) ? s.probes.slice(0, 8).map((x) => ({ id: inSet(V.probeIds)(x && x.id), outcome: inSet(V.probeOutcomes)(x && x.outcome),
    code: inSet(V.probeCodes)(x && x.code), httpStatus: httpStatus(x && x.httpStatus), transportCode: inSet(V.transportCodes)(x && x.transportCode) })) : null;
  let gates = null; let gatesRedacted = 0;
  if (s && s.gates && typeof s.gates === "object") {
    gates = {};
    for (const k of Object.keys(s.gates)) { if (V.gateNames.includes(k)) gates[k] = inSet(V.gateValues)(s.gates[k]); else gatesRedacted += 1; }   // unknown gate NAMES are dropped, only counted
  }
  return { exitCode: safeNum(e && e.exitCode), primaryOutcome: inSet(V.primaryOutcomes)(e && e.primaryOutcome), tailUncertain: safeBool(e && e.tailUncertain),
    summaryFile: inSet(V.summaryFile)(e && e.output && e.output.summaryFile), summaryCloseState: inSet(V.closeStates)(e && e.output && e.output.summaryCloseState),
    preflightCode: inSet(V.envCodes)(p && p.preflight && p.preflight.code), sourceDigest: hex64(p && p.source && p.source.sourceDigest), planHash: hex64(p && p.plan && p.plan.planHash),
    credentialCode: inSet(V.credCodes)(p && p.credential && p.credential.code), credentialCloseState: inSet(V.closeStates)(p && p.credential && p.credential.closeState),
    requestsAttempted: safeNum(p && p.requestsAttempted), runOutcome: inSet(V.runOutcomes)(s && s.outcome), tail: inSet(V.tail)(p && p.finalize && p.finalize.tail),
    probes, gates, gatesRedacted };
}
/** the children's env: the job env minus every E7_* key (the secrets and wrapper inputs never reach the accepted CLI); nothing else is altered */
export function childEnv(env) { const out = {}; for (const k of Object.keys(env)) if (!k.startsWith("E7_")) out[k] = env[k]; return out; }

/** real child runner: plain `node <args>` (no shell), bounded stdout capture, stderr counted only, NO kill / timeout (a provider step is never cancelled here) */
export function spawnNode(args, { cwd, env }) {
  return new Promise((resolve) => {
    let out = ""; let outBytes = 0; let errBytes = 0; let truncated = false;
    let child;
    try { child = spawn(process.execPath, args, { cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"] }); } catch { resolve({ status: null, signal: null, stdout: "", truncated: false, stderrBytes: 0, spawnFailed: true }); return; }
    child.stdout.on("data", (d) => { outBytes += d.length; if (outBytes <= MAX_STDOUT) out += d.toString("utf8"); else truncated = true; });
    child.stderr.on("data", (d) => { errBytes += d.length; });
    child.on("error", () => resolve({ status: null, signal: null, stdout: "", truncated, stderrBytes: errBytes, spawnFailed: true }));
    child.on("close", (status, signal) => resolve({ status, signal, stdout: out, truncated, stderrBytes: errBytes, spawnFailed: false }));
  });
}

/**
 * runWrapper({ mode, env, spawnChild, constants }) → { exitCode, result } (result = the public projection). Never throws.
 * `spawnChild` / `constants` are TEST SEAMS; the real entry passes spawnNode and the frozen CONSTANTS (never from argv / env).
 */
export async function runWrapper({ mode = "preflight", env, spawnChild, constants = CONSTANTS }) {
  const c = constants;
  const r = { schema: RESULT_SCHEMA, mode: null, code: null, workflowSha: null, toolingCommit: c.toolingCommit, sourceDigest: null, planKind: null, planHash: null,
    e1: null, inspect: null, execute: null, childStderrBytes: 0 };
  const cleanup = [];
  try {
    if (!["preflight", "verify", "execute"].includes(mode)) refuse("HOSTED_USAGE");
    r.mode = mode;
    r.workflowSha = HEX40.test(env.E7_WORKFLOW_SHA ?? "") ? env.E7_WORKFLOW_SHA : null;
    const hasSecret = (k) => typeof env[k] === "string" && env[k].length > 0;
    if (mode !== "execute" && (hasSecret("E7_HOSTAWAY_TOKEN") || hasSecret("E7_STRIPE_TEST_KEY"))) refuse("HOSTED_SECRET_SCOPE_VIOLATION");
    // ---- inputs (structured; validated; never echoed) ----------------------------------------------------------------------------
    const acct = env.E7_STRIPE_ACCOUNT_ID ?? ""; const ref = env.E7_APPROVAL_REF ?? "";
    const expPlan = env.E7_EXPECTED_PLAN_HASH ?? ""; const expDigest = env.E7_EXPECTED_SOURCE_DIGEST ?? "";
    if (acct !== "" && !ACCT_RE.test(acct)) refuse("HOSTED_INPUT_INVALID");
    if (ref !== "" && !REF_RE.test(ref)) refuse("HOSTED_INPUT_INVALID");
    if (acct === c.synthetic.accountId || ref === c.synthetic.approvalRef) refuse("HOSTED_INPUT_INVALID");   // a SYNTHETIC plan can never qualify a REAL package
    let real;
    if (mode === "preflight") { if ((acct === "") !== (ref === "")) refuse("HOSTED_INPUT_INCOMPLETE"); real = acct !== ""; }
    else {                                                              // verify / execute: everything explicit, no defaults
      if (acct === "" || ref === "" || !HEX64.test(expPlan) || !HEX64.test(expDigest)) refuse("HOSTED_INPUT_INCOMPLETE");
      if (expDigest !== c.sourceDigest) refuse("HOSTED_SOURCE_MISMATCH");
      real = true;
    }
    // ---- directories ------------------------------------------------------------------------------------------------------------
    const tooling = await realpath(env.E7_TOOLING_DIR ?? "").catch(() => refuse("HOSTED_LAYOUT_INVALID"));
    const tempRoot = await realpath(env.RUNNER_TEMP ?? "").catch(() => refuse("HOSTED_LAYOUT_INVALID"));
    const workspace = env.GITHUB_WORKSPACE ? await realpath(env.GITHUB_WORKSPACE).catch(() => refuse("HOSTED_LAYOUT_INVALID")) : null;
    if (within(tempRoot, tooling) || (workspace !== null && within(tempRoot, workspace))) refuse("HOSTED_LAYOUT_INVALID");
    // ---- (1) accepted closure bytes BEFORE invoking any tooling code ---------------------------------------------------------------
    r.sourceDigest = await closureDigest(tooling, c.sourceClosure).catch((e) => refuse(e instanceof Refusal ? e.code : "HOSTED_SOURCE_UNREADABLE"));
    if (r.sourceDigest !== c.sourceDigest) refuse("HOSTED_SOURCE_MISMATCH");
    const cenv = childEnv(env);
    const run = async (args, cwd = tooling) => { const o = await spawnChild(args, { cwd, env: cenv }); r.childStderrBytes += (o && Number.isSafeInteger(o.stderrBytes)) ? o.stderrBytes : 0; return o; };
    /** transport / process acknowledgment: spawned, not signalled, a safe integer status, stdout not truncated */
    const acked = (o) => !!o && o.spawnFailed !== true && (o.signal === null || o.signal === undefined) && Number.isSafeInteger(o.status) && o.truncated !== true;
    // ---- (2) E1 (preflight only): accepted native-mapping + bootstrap tests; FAKE / synthetic — NOT connectivity evidence ----------
    if (mode === "preflight") {
      const o = await run(["--test", "--test-reporter=tap", E1_TEST]);
      if (!acked(o)) refuse("HOSTED_CHILD_FAILED");
      const num = (re) => { const m = re.exec(o.stdout); return m ? Number(m[1]) : null; };
      r.e1 = { status: safeNum(o.status), tests: num(/^# tests (\d+)$/m), pass: num(/^# pass (\d+)$/m), fail: num(/^# fail (\d+)$/m), connectivityEvidence: false };
      // status 0 AND an acknowledged, meaningful TAP: tests > 0, pass === tests, fail === 0
      if (o.status !== 0 || !(r.e1.tests > 0) || r.e1.pass !== r.e1.tests || r.e1.fail !== 0) refuse("HOSTED_E1_FAILED");
    }
    // ---- (3) plan: prepare + inspect via the accepted CLI (no secrets, no network) -------------------------------------------------
    r.planKind = real ? "REAL" : "SYNTHETIC";
    const plan = buildPlan(c, real ? acct : c.synthetic.accountId, real ? ref : c.synthetic.approvalRef);
    const work = await mkdtemp(`${tempRoot}/e7-plan-`); cleanup.push(work);
    const draft = `${work}/draft.json`; const planPath = `${work}/plan.json`;
    { const fh = await open(draft, "wx", 0o600); try { await fh.writeFile(JSON.stringify(plan)); } finally { await fh.close(); } }
    const prep = await run([CLI, "prepare-plan", "--in", draft, "--out", planPath]);
    if (!acked(prep)) refuse("HOSTED_CHILD_FAILED");
    const pj = parseLine(prep.stdout);
    if (prep.status !== 0 || !pj || pj.schema !== PREP_SCHEMA || pj.code !== "PREP_OK" || pj.file !== "CLOSED_ACK" || pj.exitCode !== 0 || !HEX64.test(pj.planHash ?? "")) refuse("HOSTED_PREPARE_FAILED");
    const ins = await run([CLI, "inspect", "--plan", planPath]);
    if (!acked(ins)) refuse("HOSTED_CHILD_FAILED");
    const ie = parseLine(ins.stdout); if (!ie || ie.schema !== STDOUT_SCHEMA) refuse("HOSTED_CHILD_OUTPUT_UNKNOWN");
    const ip = projectEnvelope(ie);
    if (ins.status !== 10 || ie.exitCode !== 10) { r.inspect = { exitCode: ip.exitCode, preflightCode: ip.preflightCode, sourceDigest: ip.sourceDigest, planHash: ip.planHash }; refuse("HOSTED_INSPECT_FAILED"); }
    const probes = ie.payload && ie.payload.plan && Array.isArray(ie.payload.plan.probes) ? ie.payload.plan.probes : null;
    r.inspect = { exitCode: ip.exitCode, preflightCode: ip.preflightCode, sourceDigest: ip.sourceDigest, planHash: ip.planHash };
    r.planHash = ip.planHash;
    if (ip.exitCode !== 10) refuse("HOSTED_INSPECT_FAILED");
    if (ip.sourceDigest !== c.sourceDigest) refuse("HOSTED_SOURCE_MISMATCH");
    if (ip.planHash !== pj.planHash) refuse("HOSTED_PLAN_HASH_MISMATCH");
    if (!sameList(probes, G6B_PROBES) || ie.payload.plan.maxRequests !== c.maxRequests) refuse("HOSTED_SCOPE_INVALID");
    if (ip.preflightCode !== "ENV_OK") refuse("HOSTED_ENV_REFUSED");
    if (mode === "preflight") { r.code = real ? "PREFLIGHT_OK_REAL_PLAN" : "PREFLIGHT_OK_SYNTHETIC_ONLY"; return finish(0); }
    if (ip.planHash !== expPlan) refuse("HOSTED_PLAN_HASH_MISMATCH");     // binding checked BEFORE any credential file or network
    if (mode === "verify") { r.code = "VERIFY_OK"; return finish(0); }
    // ---- (4) execute: private 0600 credential file in a fresh 0700 dir OUTSIDE both checkouts; secrets never reach a child env -----
    if (!hasSecret("E7_HOSTAWAY_TOKEN") || !hasSecret("E7_STRIPE_TEST_KEY")) refuse("HOSTED_CREDENTIALS_MISSING");
    const credDir = await mkdtemp(`${tempRoot}/e7-cred-`); cleanup.push(credDir);
    const outDir = await mkdtemp(`${tempRoot}/e7-out-`); cleanup.push(outDir);
    const credPath = `${credDir}/credentials.json`;
    { const fh = await open(credPath, "wx", 0o600);
      try { await fh.writeFile(JSON.stringify({ hostawayToken: env.E7_HOSTAWAY_TOKEN, stripeTestKey: env.E7_STRIPE_TEST_KEY })); } finally { await fh.close(); } }
    const ex = await run([CLI, "execute", "--plan", planPath, "--credentials", credPath, "--summary-out", `${outDir}/summary.json`, "--expect-plan-hash", expPlan,
      "--expect-source-digest", c.sourceDigest, "--expect-requests", String(c.maxRequests), "--approval-ref", ref]);
    await rm(credPath, { force: true }).catch(() => {});                  // job-owned file only
    if (!acked(ex)) { r.execute = { childExit: safeNum(ex && ex.status), output: "UNKNOWN" }; refuse("HOSTED_CHILD_FAILED"); }
    const ee = parseLine(ex.stdout);
    // the real process status must equal the envelope's own exitCode; otherwise nothing the envelope says is trusted
    if (!ee || ee.schema !== STDOUT_SCHEMA || ee.exitCode !== ex.status) { r.execute = { childExit: safeNum(ex.status), output: "UNKNOWN" }; refuse("HOSTED_CHILD_OUTPUT_UNKNOWN"); }
    r.execute = { childExit: safeNum(ex.status), ...projectEnvelope(ee) };
    // success only when EVERY accepted success field agrees; known nonzero accepted outcomes stay failures, reported with their evidence (no retry)
    const success = ex.status === 0 && ee.exitCode === 0 && ee.primaryOutcome === "CLI_COMPLETED_OK" && ee.tailUncertain === false
      && ee.output && ee.output.summaryFile === "CLOSED_ACK" && ee.output.summaryCloseState === "CLOSED";
    r.code = success ? "EXECUTE_COMPLETED_OK" : "EXECUTE_NOT_OK";
    return finish(success ? 0 : 1);
  } catch (e) {
    r.code = e instanceof Refusal ? e.code : "HOSTED_INTERNAL";
    return finish(1);
  }
  async function finish(exitCode) {
    for (const d of cleanup.reverse()) await rm(d, { recursive: true, force: true }).catch(() => {});   // job-owned temp dirs only
    return { exitCode, result: r };
  }
}

/** markdown job summary from the projection only */
export function summaryMarkdown(r) {
  const rows = [["mode", r.mode], ["code", r.code], ["workflow commit", r.workflowSha], ["tooling commit", r.toolingCommit], ["sourceDigest (computed)", r.sourceDigest],
    ["plan kind", r.planKind], ["planHash", r.planHash], ["E1 (fake/synthetic tests; NOT connectivity)", r.e1 ? `status ${r.e1.status}, pass ${r.e1.pass}, fail ${r.e1.fail}` : null],
    ["inspect", r.inspect ? `exit ${r.inspect.exitCode}, ${r.inspect.preflightCode}` : null],
    ["execute", r.execute ? `exit ${r.execute.exitCode ?? r.execute.output}, ${r.execute.primaryOutcome ?? ""}, summary ${r.execute.summaryFile ?? ""}, tailUncertain ${r.execute.tailUncertain}` : null]];
  return `### E7 hosted read-only probe\n\n| field | value |\n|---|---|\n${rows.map(([k, v]) => `| ${k} | ${v === null || v === undefined ? "—" : String(v)} |`).join("\n")}\n\n\`\`\`json\n${JSON.stringify(r)}\n\`\`\`\n`;
}

if (import.meta.main === true) {
  const mode = process.argv[2] ?? "preflight";
  const { exitCode, result } = await runWrapper({ mode, env: process.env, spawnChild: spawnNode });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summaryMarkdown(result)).catch(() => {});
  process.exitCode = exitCode;
}
