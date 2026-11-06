// scripts/e7-operator-test-release.mjs — E7 OPERATOR TEST release request (lost guest token recovery) for ONE named intent on the TEST DEV
// database. OFFLINE PACKAGING SLICE: code is NOT consent; nothing here authorizes a dispatch, a DB connection or a write.
//   * Inert on import (`import.meta.main` guard at the bottom): no env / fs / network / DB / timer until a mode runs. Node built-ins only here.
//   * Reuses the ACCEPTED operator core at the FIXED tooling commit ab55e709 (checked out separately as "tooling"): scripts/e7-operator/test-release.mjs
//     (classify / executeOperatorRelease), repo.requestTestRelease, the booking pool and the accepted env preflight (C1). Its full transitive
//     import closure (+ package.json / package-lock.json) is digest-verified BEFORE any tooling import; `pg` is installed from that lockfile
//     (verify / execute only) and its version re-checked. None of those files is modified.
//   * NO provider: no Stripe / Hostaway client, key or import; any env key matching STRIPE or HOSTAWAY is refused. The ONLY secret is the DEV
//     runtime-login database URL (verify / execute only), read once and removed from the environment. Never a guest token, URL or DB message out.
//   * Modes: preflight (no secret, no DB: digests + plan + env + the fake test suite) | bindings (no secret, no DB: every pin explicit) |
//     verify (read-only classify) | execute (the accepted core, AT MOST ONE helper invocation, no automatic retry, no cleanup chaining).
//   * Plan: the OUTER runner plan binds tooling / closure / runner / pg / node / DB target / CA / budget AND the full frozen INNER expectation,
//     its own hash (expectationHash = the inner planHash) and the label. runnerPlanHash (outer) != expectationHash (inner); no hash covers itself.
import process from "node:process";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath, appendFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const freeze = Object.freeze;
export const CONSTANTS = freeze({
  toolingCommit: "ab55e7092ff0140a57d2a6eebff1e3adb1c3f039",
  // the scanned transitive import closure of the operator core + pool + C1 at ab55e709, plus the package manifest + lock
  closure: freeze(["package.json", "package-lock.json", "lib/booking-db/codec.js", "lib/booking-db/config.js", "lib/booking-db/pool.js", "lib/booking-db/repo.js",
    "lib/checkout/intent-state.js", "scripts/e7-connected/probe-env-preflight.mjs", "scripts/e7-operator/test-release.mjs"]),
  closureDigest: "49eb56afde380b3120835a366ea0fbf5c3c75027d480e95aa260a8200a0522bd",
  pgVersion: "8.18.0",
  runnerFiles: freeze(["scripts/e7-operator-test-release.mjs", ".github/workflows/e7-operator-test-release.yml", "test/e7-operator-test-release-runner.test.mjs"]),
  nodeVersion: "22.22.0",
  listingId: 606998, currency: "USD",
  db: freeze({ environment: "test", projectRef: "mxotevtiscernhqilyiu", host: "aws-0-us-east-1.pooler.supabase.com", port: "6543",
    user: "mv_booking_app_dev.mxotevtiscernhqilyiu", database: "postgres" }),
  caSha256: "700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7",   // Supabase prod-ca-2021.crt (same pin as the cleanup runner)
  budgets: freeze({ helperInvocations: 1, automaticRetries: 0, cleanupChaining: false, poolMax: 2 }),
  maxExpectationBytes: 2048,
  synthetic: freeze({ intentId: "00000000-0000-4000-8000-000000000000", approvalRef: "SYNTHETIC-preflight-not-for-execute" })
});
export const RUNNER_PLAN_SCHEMA = "e7-operator-test-release-runner-plan-v1";
export const RESULT_SCHEMA = "e7-operator-test-release-hosted-v1";
export const CLOSURE_DIGEST_PREFIX = "e7-operator-test-release-closure-v1\n";
export const RUNNER_DIGEST_PREFIX = "e7-operator-test-release-runner-v1\n";
export const HOSTED_CODES = freeze(["OPR_USAGE", "OPR_SECRET_SCOPE_VIOLATION", "OPR_INPUT_INCOMPLETE", "OPR_EXPECTATION_PARSE", "OPR_EXPECTATION_INVALID",
  "OPR_EXPECTATION_HASH_MISMATCH", "OPR_LABEL_MISMATCH", "OPR_SYNTHETIC_REFUSED", "OPR_REF_NOT_MAIN", "OPR_LAYOUT_INVALID", "OPR_SOURCE_UNREADABLE",
  "OPR_SOURCE_MISMATCH", "OPR_RUNNER_MISMATCH", "OPR_PLAN_HASH_MISMATCH", "OPR_IMPORT_FAILED", "OPR_ENV_REFUSED", "OPR_CHILD_FAILED", "OPR_TESTS_FAILED",
  "OPR_CREDENTIALS_MISSING", "OPR_DEPENDENCY_MISMATCH", "OPR_DB_TARGET_INVALID", "OPR_CA_INVALID", "OPR_INTERNAL",
  "PREFLIGHT_OK_REAL_PLAN", "PREFLIGHT_OK_SYNTHETIC_ONLY", "BINDINGS_OK", "VERIFY_DONE", "EXECUTE_DONE"]);
/** wrapper outcomes the runner passes through (anything else is reported as REDACTED) */
const CORE_OUTCOMES = freeze(["REQUESTED", "POSTCHECK_MISMATCH", "REFUSED", "DUPLICATE_RECONCILED", "REQUEST_OUTCOME_UNKNOWN",
  "NOT_EXECUTED_ALREADY_REQUESTED", "NOT_EXECUTED_ALREADY_RELEASED", "NOT_EXECUTED_NOT_ELIGIBLE", "NOT_EXECUTED_INVALID"]);
const CLASSES = freeze(["ELIGIBLE", "ALREADY_REQUESTED", "ALREADY_RELEASED", "NOT_ELIGIBLE", "INVALID"]);
const HEX40 = /^[0-9a-f]{40}$/; const HEX64 = /^[0-9a-f]{64}$/;
const CODE_RE = /^[A-Za-z0-9_:.-]{1,80}$/;
const APPROVAL_RE = /^[A-Za-z0-9._:-]{1,80}$/;
const MAX_FILE = 1048576; const MAX_TOTAL = 4194304;
class Refusal extends Error { constructor(code) { super("e7-operator-test-release"); this.code = code; } }
const refuse = (code) => { throw new Refusal(code); };
const sha = (s) => createHash("sha256").update(s).digest("hex");
export function canonical(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
}
function deepFreeze(v) { if (v && typeof v === "object") { for (const k of Object.keys(v)) deepFreeze(v[k]); freeze(v); } return v; }
const safeCode = (x) => (typeof x === "string" && CODE_RE.test(x) ? x : x === null || x === undefined ? null : "REDACTED");
const errClass = (err) => (err && typeof err.code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(err.code) ? err.code : "Error");

// =================================================================================================================================
// inner expectation input (pure): the CANONICAL JSON of the full 14-key expectation (sorted keys, no whitespace, no duplicates)
/** parseExpectation(text, c) -> frozen plain object | throws Refusal(OPR_EXPECTATION_PARSE). Shape / hash are checked later by the pinned core. */
export function parseExpectation(text, c = CONSTANTS) {
  if (typeof text !== "string" || text.length < 2 || Buffer.byteLength(text, "utf8") > c.maxExpectationBytes) refuse("OPR_EXPECTATION_PARSE");
  let v; try { v = JSON.parse(text); } catch { refuse("OPR_EXPECTATION_PARSE"); }
  if (v === null || typeof v !== "object" || Array.isArray(v)) refuse("OPR_EXPECTATION_PARSE");
  // byte-exact canonical form: rejects duplicate keys (JSON.parse keeps the last), reordering, whitespace and any non-canonical number / string form
  if (canonical(v) !== text) refuse("OPR_EXPECTATION_PARSE");
  return deepFreeze(v);
}
/** the synthetic (labelled, never executable) expectation fields for a preflight without a real input */
function syntheticFields(c) {
  return { intentId: c.synthetic.intentId, expectedVersion: 0, listingId: c.listingId, from: "2027-01-18", to: "2027-01-20", guests: 1, currency: c.currency,
    finalTotalMinor: 1, authorizedMinor: 1, paymentIntentId: "pi_SYNTHETICnotForExecute0", sessionId: "cs_test_SYNTHETICnotForExecute0",
    attemptId: "00000000-0000-4000-8000-000000000001", approvalRef: c.synthetic.approvalRef };
}

// =================================================================================================================================
// outer runner plan (pure)
/** buildRunnerPlan(c, { expectation, closureDigest, runnerDigest }) -> frozen { plan, runnerPlanHash, expectationHash } */
export function buildRunnerPlan(c, { expectation, closureDigest, runnerDigest }) {
  if (!expectation || typeof expectation.planHash !== "string" || !HEX64.test(expectation.planHash)) refuse("OPR_EXPECTATION_INVALID");
  if (!HEX64.test(String(closureDigest)) || !HEX64.test(String(runnerDigest))) refuse("OPR_INTERNAL");
  const plan = { schema: RUNNER_PLAN_SCHEMA, toolingCommit: c.toolingCommit, closureDigest, runnerDigest, pgVersion: c.pgVersion, nodeVersion: c.nodeVersion,
    db: { ...c.db }, caSha256: c.caSha256, scope: { listingId: c.listingId, currency: c.currency }, budgets: { ...c.budgets },
    writes: { releaseRequestsMax: 1, stripe: 0, hostaway: 0, capture: 0, refund: 0, notify: 0 },
    approvalRef: expectation.approvalRef, intentId: expectation.intentId, expectation: { ...expectation }, expectationHash: expectation.planHash };
  return freeze({ plan: deepFreeze(plan), runnerPlanHash: sha(canonical(plan)), expectationHash: expectation.planHash });
}

// =================================================================================================================================
// core (injected; no native I/O of its own). Never throws.
/** the classify report, whitelisted */
function projectClass(v) {
  if (!v || typeof v !== "object") return null;
  const o = { class: CLASSES.includes(v.class) ? v.class : "REDACTED", code: safeCode(v.code), state: safeCode(v.state) };
  for (const k of ["version", "expectedVersion", "releaseVersion", "voidAttempts"]) if (Number.isSafeInteger(v[k])) o[k] = v[k];
  for (const k of ["releasedAtExpectedVersion", "voidDispatched", "claimReleased", "claimAnomaly"]) if (typeof v[k] === "boolean") o[k] = v[k];
  if (v.releaseActor !== undefined) o.releaseActor = safeCode(v.releaseActor);
  if (v.voidState !== undefined) o.voidState = safeCode(v.voidState);
  return o;
}
function projectHelper(h) { return h && typeof h === "object" ? { ok: h.ok === true, duplicate: h.duplicate === true, error: safeCode(h.error) } : null; }
/**
 * runOperatorCore({ mode, expectation, pool, ops, now }) -> frozen result
 *   ops = { classify, executeOperatorRelease, requestTestRelease } from the PINNED tooling.
 *   execute: ONE executeOperatorRelease call; the helper is passed through a counting gate (the core's deps.requestTestRelease seam) that admits
 *   at most ONE helper invocation. A throw with ZERO invocations = BEFORE_INVOCATION (precheck read failed, nothing invoked). After an
 *   invocation every core outcome (incl. read-unavailable / unknown) is preserved as reported. No retry, no cleanup.
 */
export async function runOperatorCore({ mode, expectation, pool, ops, now }) {
  const r = { mode, phase: null, outcome: null, code: null, invocations: 0, refusedInvocations: 0, precheck: null, helper: null, reconciled: null,
    errorClass: null, reconcileError: null, reconcileErrorClass: null };
  const done = () => freeze(JSON.parse(JSON.stringify(r)));
  try {
    if (!ops || typeof ops.classify !== "function" || typeof ops.executeOperatorRelease !== "function" || typeof ops.requestTestRelease !== "function"
        || !pool || typeof pool.query !== "function" || !Number.isFinite(now)) { r.outcome = "CORE_INVALID"; return done(); }
    if (mode === "verify") {
      r.phase = "READ_ONLY";
      let v;
      try { v = await ops.classify(pool, expectation); } catch (err) { r.outcome = "VERIFY_READ_UNAVAILABLE"; r.errorClass = errClass(err); return done(); }
      r.outcome = "VERIFIED"; r.reconciled = projectClass(v); return done();
    }
    if (mode !== "execute") { r.outcome = "CORE_INVALID"; return done(); }
    const gate = async (...args) => {
      if (r.invocations >= 1) { r.refusedInvocations += 1; throw Object.assign(new Error("budget"), { code: "OPR_SECOND_INVOCATION_REFUSED" }); }
      r.invocations += 1;
      return ops.requestTestRelease(...args);
    };
    let res;
    try { res = await ops.executeOperatorRelease(pool, expectation, { now, deps: { requestTestRelease: gate } }); }
    catch (err) {
      r.errorClass = errClass(err);
      if (r.invocations === 0) { r.phase = "BEFORE_INVOCATION"; r.outcome = "PRECHECK_READ_UNAVAILABLE"; return done(); }
      r.phase = "AFTER_INVOCATION"; r.outcome = "REQUEST_OUTCOME_UNKNOWN"; r.code = "CORE_THREW_AFTER_INVOCATION"; return done();   // the accepted core never does this
    }
    r.phase = r.invocations === 0 ? "BEFORE_INVOCATION" : "AFTER_INVOCATION";
    r.outcome = res && CORE_OUTCOMES.includes(res.outcome) ? res.outcome : "REDACTED";
    r.code = safeCode(res && res.code);
    r.precheck = projectClass(res && res.precheck);
    r.helper = projectHelper(res && res.helper);
    r.reconciled = projectClass(res && res.reconciled);
    r.errorClass = res && res.errorClass !== undefined ? safeCode(res.errorClass) : r.errorClass;
    if (res && res.reconcileError !== undefined) { r.reconcileError = safeCode(res.reconcileError); r.reconcileErrorClass = safeCode(res.reconcileErrorClass); }
    return done();
  } catch { r.outcome = r.invocations ? "REQUEST_OUTCOME_UNKNOWN" : "CORE_INVALID"; return done(); }
}

// =================================================================================================================================
// hosted wiring (gated; real fs / child / DB only inside runHosted with the real deps)
export async function framedDigest(dir, files, prefix) {
  const h = createHash("sha256"); h.update(prefix); let total = 0;
  for (const rel of files) {
    const p = `${dir}/${rel}`; const st = await lstat(p);
    if (!st.isFile() || st.size < 1 || st.size > MAX_FILE) refuse("OPR_SOURCE_UNREADABLE");
    const b = await readFile(p); if (b.length !== st.size) refuse("OPR_SOURCE_UNREADABLE");
    total += b.length; if (total > MAX_TOTAL) refuse("OPR_SOURCE_UNREADABLE");
    h.update(rel); h.update(Buffer.from([0])); h.update(String(b.length)); h.update(Buffer.from([0])); h.update(b); h.update(Buffer.from([0]));
  }
  return h.digest("hex");
}
export function childEnv(env, toolingDir) { const out = {}; for (const k of Object.keys(env)) if (!k.startsWith("E7_")) out[k] = env[k]; out.E7_TOOLING_DIR = toolingDir; return out; }
export function spawnNode(args, { cwd, env }) {
  return new Promise((resolve) => {
    let out = ""; let outBytes = 0; let truncated = false; let child;
    try { child = spawn(process.execPath, args, { cwd, env, shell: false, stdio: ["ignore", "pipe", "ignore"] }); } catch { resolve({ status: null, signal: null, stdout: "", truncated: false, spawnFailed: true }); return; }
    child.stdout.on("data", (d) => { outBytes += d.length; if (outBytes <= 262144) out += d.toString("utf8"); else truncated = true; });
    child.on("error", () => resolve({ status: null, signal: null, stdout: "", truncated, spawnFailed: true }));
    child.on("close", (status, signal) => resolve({ status, signal, stdout: out, truncated, spawnFailed: false }));
  });
}
const TEST_FILE = "test/e7-operator-test-release-runner.test.mjs";
/** the DEV runtime login only (transaction pooler user mv_booking_app_dev.<ref>); anything else refused before a pool exists */
export function dbTargetOk(url, c = CONSTANTS) {
  let u; try { u = new URL(url); } catch { return false; }
  return (u.protocol === "postgresql:" || u.protocol === "postgres:") && u.hostname === c.db.host && u.port === c.db.port
    && decodeURIComponent(u.username) === c.db.user && u.pathname === `/${c.db.database}` && u.search === "" && u.hash === "";
}

/**
 * runHosted({ mode, env, proc, wrapperDir, deps }) -> { exitCode, result }. Never throws.
 *   deps (TEST SEAMS): spawnChild, importEnv(dir) -> C1, importCore(dir) -> { OP, R }, importPool(dir) -> { createBookingPool }, runCore,
 *   constants, readPgVersion, readCa, clock
 */
export async function runHosted({ mode = "preflight", env, proc, wrapperDir, deps = {} }) {
  const c = deps.constants ?? CONSTANTS;
  const spawnChild = deps.spawnChild ?? spawnNode;
  const importEnv = deps.importEnv ?? ((dir) => import(pathToFileURL(`${dir}/scripts/e7-connected/probe-env-preflight.mjs`).href));
  const importCore = deps.importCore ?? (async (dir) => ({ OP: await import(pathToFileURL(`${dir}/scripts/e7-operator/test-release.mjs`).href),
    R: await import(pathToFileURL(`${dir}/lib/booking-db/repo.js`).href) }));
  const importPool = deps.importPool ?? ((dir) => import(pathToFileURL(`${dir}/lib/booking-db/pool.js`).href));
  const runCore = deps.runCore ?? runOperatorCore;
  const readPgVersion = deps.readPgVersion ?? (async (dir) => JSON.parse(await readFile(`${dir}/node_modules/pg/package.json`, "utf8")).version);
  const readCa = deps.readCa ?? ((p) => readFile(p));
  const clock = deps.clock ?? (() => Date.now());
  const r = { schema: RESULT_SCHEMA, mode: null, code: null, workflowSha: null, toolingCommit: c.toolingCommit, closureDigest: null, runnerDigest: null,
    planKind: null, runnerPlanHash: null, expectationHash: null, intentId: null, approvalRef: null, envCode: null, tests: null, core: null };
  let pool = null;
  try {
    if (!["preflight", "bindings", "verify", "execute"].includes(mode)) refuse("OPR_USAGE");
    r.mode = mode;
    r.workflowSha = HEX40.test(env.E7_WORKFLOW_SHA ?? "") ? env.E7_WORKFLOW_SHA : null;
    const hasDb = typeof env.E7_DEV_BOOKING_DATABASE_URL === "string" && env.E7_DEV_BOOKING_DATABASE_URL.length > 0;
    if (Object.keys(env).some((k) => /STRIPE|HOSTAWAY/i.test(k))) refuse("OPR_SECRET_SCOPE_VIOLATION");             // no provider credential at all
    if ((mode === "preflight" || mode === "bindings") && hasDb) refuse("OPR_SECRET_SCOPE_VIOLATION");
    const label = env.E7_APPROVAL_REF ?? ""; const expText = env.E7_EXPECTATION_JSON ?? "";
    const expPlan = env.E7_EXPECTED_RUNNER_PLAN_HASH ?? ""; const expClo = env.E7_EXPECTED_CLOSURE_DIGEST ?? ""; const expRun = env.E7_EXPECTED_RUNNER_DIGEST ?? "";
    const anyReal = label !== "" || expText !== "";
    if (anyReal && (label === "" || expText === "")) refuse("OPR_INPUT_INCOMPLETE");
    if (anyReal && !APPROVAL_RE.test(label)) refuse("OPR_EXPECTATION_INVALID");
    const parsed = anyReal ? parseExpectation(expText, c) : null;
    if (parsed && parsed.approvalRef !== label) refuse("OPR_LABEL_MISMATCH");
    if (parsed && (parsed.intentId === c.synthetic.intentId || parsed.approvalRef === c.synthetic.approvalRef)) refuse("OPR_SYNTHETIC_REFUSED");
    if (mode !== "preflight") {
      if (!anyReal || !HEX64.test(expPlan) || !HEX64.test(expClo) || !HEX64.test(expRun)) refuse("OPR_INPUT_INCOMPLETE");
      if (env.GITHUB_REF !== "refs/heads/main") refuse("OPR_REF_NOT_MAIN");
      if (expClo !== c.closureDigest) refuse("OPR_SOURCE_MISMATCH");
    }
    // ---- layout + (1) the accepted closure BEFORE any tooling import ---------------------------------------------------------------
    const tooling = await realpath(env.E7_TOOLING_DIR ?? "").catch(() => refuse("OPR_LAYOUT_INVALID"));
    const wdir = await realpath(wrapperDir).catch(() => refuse("OPR_LAYOUT_INVALID"));
    if (tooling === wdir || tooling.startsWith(`${wdir}/`) || wdir.startsWith(`${tooling}/`)) refuse("OPR_LAYOUT_INVALID");
    r.closureDigest = await framedDigest(tooling, c.closure, CLOSURE_DIGEST_PREFIX).catch((e) => refuse(e instanceof Refusal ? e.code : "OPR_SOURCE_UNREADABLE"));
    if (r.closureDigest !== c.closureDigest) refuse("OPR_SOURCE_MISMATCH");
    r.runnerDigest = await framedDigest(wdir, c.runnerFiles, RUNNER_DIGEST_PREFIX).catch((e) => refuse(e instanceof Refusal ? e.code : "OPR_SOURCE_UNREADABLE"));
    if (mode !== "preflight" && r.runnerDigest !== expRun) refuse("OPR_RUNNER_MISMATCH");
    // ---- (2) the inner expectation, re-derived by the PINNED core (shape + its own hash), then the outer plan ------------------------
    let core; try { core = await importCore(tooling); } catch { refuse("OPR_IMPORT_FAILED"); }   // pure modules (no pg) — safe before install
    let expectation;
    if (parsed) {
      if (!core.R.validOperatorExpectation(parsed, parsed.intentId)) refuse("OPR_EXPECTATION_INVALID");
      const { planHash, ...fields } = parsed;
      const rebuilt = core.OP.buildOperatorExpectation(fields);
      if (!rebuilt || canonical(rebuilt) !== canonical(parsed) || rebuilt.planHash !== planHash) refuse("OPR_EXPECTATION_HASH_MISMATCH");
      expectation = rebuilt;
    } else {
      expectation = core.OP.buildOperatorExpectation(syntheticFields(c));
      if (!expectation) refuse("OPR_INTERNAL");
    }
    r.planKind = parsed ? "REAL" : "SYNTHETIC";
    const built = buildRunnerPlan(c, { expectation, closureDigest: r.closureDigest, runnerDigest: r.runnerDigest });
    r.runnerPlanHash = built.runnerPlanHash; r.expectationHash = built.expectationHash;
    r.intentId = expectation.intentId; r.approvalRef = expectation.approvalRef;
    if (mode !== "preflight" && built.runnerPlanHash !== expPlan) refuse("OPR_PLAN_HASH_MISMATCH");
    // ---- (3) env evaluation (accepted C1) --------------------------------------------------------------------------------------------
    let C1; try { C1 = await importEnv(tooling); } catch { refuse("OPR_IMPORT_FAILED"); }
    const present = Object.fromEntries(C1.PRESENT_KEYS.map((k) => [k, Object.hasOwn(env, k)]));
    let uid = null; try { if (typeof proc.getuid === "function") { const u = proc.getuid(); if (Number.isSafeInteger(u) && u >= 0) uid = u; } } catch { uid = null; }
    const ev = C1.evaluateProbeEnvironment({ schema: C1.ENV_SNAPSHOT_SCHEMA, nodeVersion: String(proc.versions.node), platform: proc.platform,
      execArgvCount: proc.execArgv.length, uidAvailable: uid !== null, present });
    r.envCode = typeof ev.code === "string" && C1.ENV_CODES.includes(ev.code) ? ev.code : "REDACTED";
    if (ev.ok !== true || proc.versions.node !== c.nodeVersion) refuse("OPR_ENV_REFUSED");
    // ---- (4) preflight: the FAKE test suite as a plain child (no secret, no DB, no network, no dependency) ----------------------------
    if (mode === "preflight") {
      const o = await spawnChild(["--test", "--test-reporter=tap", TEST_FILE], { cwd: wdir, env: childEnv(env, tooling) });
      if (!o || o.spawnFailed || (o.signal !== null && o.signal !== undefined) || !Number.isSafeInteger(o.status) || o.truncated) refuse("OPR_CHILD_FAILED");
      const num = (re) => { const m = re.exec(o.stdout); return m ? Number(m[1]) : null; };
      r.tests = { status: o.status, tests: num(/^# tests (\d+)$/m), pass: num(/^# pass (\d+)$/m), fail: num(/^# fail (\d+)$/m), connectivityEvidence: false };
      if (o.status !== 0 || !(r.tests.tests > 0) || r.tests.pass !== r.tests.tests || r.tests.fail !== 0) refuse("OPR_TESTS_FAILED");
      r.code = parsed ? "PREFLIGHT_OK_REAL_PLAN" : "PREFLIGHT_OK_SYNTHETIC_ONLY"; return { exitCode: 0, result: r };
    }
    if (mode === "bindings") { r.code = "BINDINGS_OK"; return { exitCode: 0, result: r }; }
    // ---- (5) verify / execute: the pinned dependency, the ONE secret (read once, removed from env), the CA pin, the core --------------
    if (!hasDb) refuse("OPR_CREDENTIALS_MISSING");
    let pgv; try { pgv = await readPgVersion(tooling); } catch { pgv = null; }
    if (pgv !== c.pgVersion) refuse("OPR_DEPENDENCY_MISMATCH");
    let dbUrl = env.E7_DEV_BOOKING_DATABASE_URL; delete env.E7_DEV_BOOKING_DATABASE_URL;
    if (!dbTargetOk(dbUrl, c)) { dbUrl = null; refuse("OPR_DB_TARGET_INVALID"); }
    let caPem = null;
    try { const b = await readCa(env.E7_CA_FILE ?? ""); if (sha(b) === c.caSha256 && b.length < 16384) caPem = b.toString("utf8"); } catch { caPem = null; }
    if (caPem === null) { dbUrl = null; refuse("OPR_CA_INVALID"); }
    let P; try { P = await importPool(tooling); } catch { dbUrl = null; refuse("OPR_IMPORT_FAILED"); }
    try { pool = P.createBookingPool({ connectionString: dbUrl, caPem, max: c.budgets.poolMax }); } catch { refuse("OPR_DB_TARGET_INVALID"); } finally { dbUrl = null; }
    r.core = await runCore({ mode, expectation, pool, now: clock(),
      ops: { classify: core.OP.classify, executeOperatorRelease: core.OP.executeOperatorRelease, requestTestRelease: core.R.requestTestRelease } });
    r.code = mode === "verify" ? "VERIFY_DONE" : "EXECUTE_DONE";
    const ok = mode === "verify" ? r.core && r.core.outcome === "VERIFIED" : r.core && r.core.outcome === "REQUESTED";
    return { exitCode: ok ? 0 : 1, result: r };
  } catch (e) {
    r.code = e instanceof Refusal && HOSTED_CODES.includes(e.code) ? e.code : "OPR_INTERNAL";
    return { exitCode: 1, result: r };
  } finally {
    if (pool) await pool.end().catch(() => {});
  }
}

export function summaryMarkdown(r) {
  const k = r.core;
  const rows = [["mode", r.mode], ["code", r.code], ["workflow commit", r.workflowSha], ["tooling commit", r.toolingCommit], ["closureDigest (computed)", r.closureDigest],
    ["runnerDigest (computed)", r.runnerDigest], ["plan kind", r.planKind], ["runnerPlanHash (outer)", r.runnerPlanHash], ["expectationHash (inner)", r.expectationHash],
    ["intent / label", r.intentId ? `${r.intentId} / ${r.approvalRef}` : null], ["env", r.envCode],
    ["fake tests (NOT connectivity)", r.tests ? `status ${r.tests.status}, pass ${r.tests.pass}/${r.tests.tests}, fail ${r.tests.fail}` : null],
    ["phase / outcome / code", k ? `${k.phase ?? "—"} / ${k.outcome} / ${k.code ?? "—"}` : null], ["helper invocations (refused)", k ? `${k.invocations} (${k.refusedInvocations})` : null],
    ["class (reconciled)", k && k.reconciled ? `${k.reconciled.class} / ${k.reconciled.code ?? "—"}` : null]];
  return `### E7 operator TEST release request — one named intent\n\n| field | value |\n|---|---|\n${rows.map(([a, b]) => `| ${a} | ${b === null || b === undefined ? "—" : String(b)} |`).join("\n")}\n\n\`\`\`json\n${JSON.stringify(r)}\n\`\`\`\n`;
}

if (import.meta.main === true) {
  const mode = process.argv[2] ?? "preflight";
  const wrapperDir = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
  const { exitCode, result } = await runHosted({ mode, env: process.env, proc: process, wrapperDir });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summaryMarkdown(result)).catch(() => {});
  process.exitCode = exitCode;
}
