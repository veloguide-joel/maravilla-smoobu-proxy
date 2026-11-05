// scripts/e7-dev-db-smoke.mjs — hosted wrapper that runs the ACCEPTED read-only scripts/db-smoke.mjs (fixed tooling 6d703acd, UNCHANGED)
// once against the TEST DEV database with the DEV runtime login. Doc: claude/e7-dev-db-smoke.md. Node built-ins + two pure helpers of the
// accepted cleanup runner (dbTargetOk, framedDigest, OFFICIAL_CA_SHA256; that file is inert on import and is part of the runner digest).
// OFFLINE slice: code is NOT consent; nothing here authorizes a dispatch or a DB connection.
//   * Inert on import (`import.meta.main` guard at the bottom).
//   * The smoke's FULL transitive closure (scripts/db-smoke.mjs -> db/lib/pool.js -> lib/booking-db/pool.js -> pg) + package.json /
//     package-lock.json is digest-verified BEFORE anything else; `pg` comes from that lockfile (npm ci --ignore-scripts --omit=dev, workflow)
//     and its version is re-checked before the child starts. No tooling module is imported by this process.
//   * Fixed child argv: db-smoke.mjs --url-env E7_DEV_BOOKING_DATABASE_URL --ca-file <pinned CA> --expect-role mv_booking_app_dev --env test.
//     NEVER --write-probe / --loopback-rehearsal. The child env holds ONLY that one URL (no PATH, no PG*, no provider secret).
//   * Scope before any child: the strict DEV transaction-pooler target (dbTargetOk), the CA's pinned SHA-256, main ref, plan / digest pins.
//   * Bounded: one child, hard kill after CHILD_TIMEOUT_MS -> SMOKE_TIMEOUT_UNKNOWN. No retry, no rerun, no fallback.
//   * Output: whitelisted check names / booleans / safe detail shapes only; the URL, any credential and the child's stderr are never output;
//     malformed or unexpected child output is withheld (SMOKE_OUTPUT_INVALID). Success = exit 0 AND pass:true AND the exact expected
//     non-empty check set, every check passed.
import process from "node:process";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath, appendFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dbTargetOk, framedDigest, OFFICIAL_CA_SHA256 } from "./e7-checkout-test-cleanup.mjs";

export const CONSTANTS = Object.freeze({
  toolingCommit: "6d703acdcfa205138d1ce4ba65b2ec58fc9493c9",
  closure: Object.freeze(["package.json", "package-lock.json", "scripts/db-smoke.mjs", "db/lib/pool.js", "lib/booking-db/pool.js"]),
  closureDigest: "45b512b0498d82c329e9c05edde165e242a9910fbeac533644cf926f890af5ca",   // framed SHA-256 of `closure` at 6d703acd (test S2 recomputes it from the real checkout)
  pgVersion: "8.18.0",
  runnerFiles: Object.freeze(["scripts/e7-dev-db-smoke.mjs", "scripts/e7-checkout-test-cleanup.mjs", ".github/workflows/e7-dev-db-smoke.yml", "test/e7-dev-db-smoke.test.mjs"]),
  dbEnvironment: "test", dbProjectRef: "mxotevtiscernhqilyiu", expectRole: "mv_booking_app_dev", urlEnv: "E7_DEV_BOOKING_DATABASE_URL",
  nodeVersion: "22.22.0",
  childTimeoutMs: 90 * 1000,
  synthetic: Object.freeze({ approvalRef: "SYNTHETIC-preflight-not-for-execute" })
});
export const CLOSURE_DIGEST_PREFIX = "e7-dev-db-smoke-closure-v1\n";
export const RUNNER_DIGEST_PREFIX = "e7-dev-db-smoke-runner-v1\n";
export const PLAN_SCHEMA = "e7-dev-db-smoke-plan-v1";
export const HOSTED_CODES = Object.freeze(["SMK_USAGE", "SMK_SECRET_SCOPE_VIOLATION", "SMK_INPUT_INVALID", "SMK_INPUT_INCOMPLETE", "SMK_REF_NOT_MAIN",
  "SMK_LAYOUT_INVALID", "SMK_SOURCE_UNREADABLE", "SMK_SOURCE_MISMATCH", "SMK_RUNNER_MISMATCH", "SMK_PLAN_HASH_MISMATCH", "SMK_DEPENDENCY_MISMATCH",
  "SMK_ENV_REFUSED", "SMK_TESTS_FAILED", "SMK_CHILD_FAILED", "SMK_CREDENTIALS_MISSING", "SMK_DB_TARGET_INVALID", "SMK_CA_INVALID", "SMK_ARGV_INVALID",
  "SMK_INTERNAL", "PREFLIGHT_OK_REAL_PLAN", "PREFLIGHT_OK_SYNTHETIC_ONLY", "VERIFY_OK", "EXECUTE_DONE"]);
export const OUTCOMES = Object.freeze(["SMOKE_PASS", "SMOKE_FAIL", "SMOKE_OUTPUT_INVALID", "SMOKE_TIMEOUT_UNKNOWN", "SMOKE_CHILD_FAILED"]);
/** db-smoke.mjs at 6d703acd, read-only remote path with --env test: exactly these checks run when everything passes */
export const EXPECTED_PASS_CHECKS = Object.freeze(["ca_file_is_official_supabase_prod_ca_2021", "connect_authenticated", "tls_encrypted", "tls_authorized",
  "tls_protocol", "tls_peer_cn_present", "identity_is_expected_runtime_login", "not_superuser_bypassrls_createrole_createdb_replication",
  "member_of_mv_booking_app_only", "no_access_to_migration_bookkeeping", "no_ddl_in_booking_schema", "environment_marker_is_test", "statement_timeout_5s",
  "idle_in_transaction_session_timeout_10s", "smoke_transaction_is_read_only", "table_privilege_matrix_exact", "no_delete_or_truncate_anywhere",
  "runtime_functions_executable", "admin_functions_not_executable", "data_only_instance_row", "db_clock_function_callable", "migration_table_denied"]);
/** names that may appear in a FAILED read-only run (reported, never a pass) */
const FAILURE_ONLY_CHECKS = Object.freeze(["data_and_function_reads", "environment_marker_is_live", "fatal"]);
/** the smoke's static UsageError texts (its `fatal` detail); anything else is withheld */
const USAGE_TEXTS = Object.freeze(["unknown or incomplete argument", "--env must be test or live", "--url-env and --expect-role are required",
  "--url-env must be an environment variable name", "DATABASE_URL is the retired legacy variable", "the named environment variable is not set",
  "connection string rejected by the booking pool guard", "loopback URL: use --loopback-rehearsal (local clusters only)",
  "--loopback-rehearsal refuses non-loopback hosts", "--ca-file is required for a remote database", "CA file could not be read"]);

const APPROVAL_RE = /^[A-Za-z0-9._:-]{1,80}$/;
const HEX64 = /^[0-9a-f]{64}$/; const HEX40 = /^[0-9a-f]{40}$/;
const CA_PATH_RE = /^\/[A-Za-z0-9._/-]{1,200}\/prod-ca-2021\.crt$/;
const MAX_STDOUT = 65536;
const freeze = Object.freeze;
class Refusal extends Error { constructor(code) { super("e7-dev-db-smoke"); this.code = code; } }
const refuse = (code) => { throw new Refusal(code); };
const sha = (s) => createHash("sha256").update(s).digest("hex");
export function canonical(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
}

// ---- plan + fixed argv (pure) ---------------------------------------------------------------------------------------------------
export function smokeArgv(c, caFile) {
  if (typeof caFile !== "string" || !CA_PATH_RE.test(caFile) || caFile.includes("..")) refuse("SMK_ARGV_INVALID");
  return ["scripts/db-smoke.mjs", "--url-env", c.urlEnv, "--ca-file", caFile, "--expect-role", c.expectRole, "--env", c.dbEnvironment];
}
/** the argv template is fixed: exactly 9 entries, the read-only flags only, never --write-probe / --loopback-rehearsal */
export function argvOk(argv, c = CONSTANTS) {
  return Array.isArray(argv) && argv.length === 9 && argv[0] === "scripts/db-smoke.mjs" && argv[1] === "--url-env" && argv[2] === "E7_DEV_BOOKING_DATABASE_URL"
    && argv[3] === "--ca-file" && CA_PATH_RE.test(argv[4]) && !argv[4].includes("..") && argv[5] === "--expect-role" && argv[6] === "mv_booking_app_dev"
    && argv[7] === "--env" && argv[8] === "test" && c.urlEnv === argv[2] && c.expectRole === argv[6] && c.dbEnvironment === argv[8]
    && !argv.some((a) => a === "--write-probe" || a === "--loopback-rehearsal");
}
export function buildPlan(c, { approvalRef, runnerDigest }) {
  if (typeof approvalRef !== "string" || !APPROVAL_RE.test(approvalRef)) refuse("SMK_INPUT_INVALID");
  if (c.dbEnvironment !== "test" || c.expectRole !== "mv_booking_app_dev" || c.urlEnv !== "E7_DEV_BOOKING_DATABASE_URL" || c.dbProjectRef !== "mxotevtiscernhqilyiu") refuse("SMK_INPUT_INVALID");
  const plan = { schema: PLAN_SCHEMA, toolingCommit: c.toolingCommit, closureDigest: c.closureDigest, runnerDigest, pgVersion: c.pgVersion,
    smoke: { script: "scripts/db-smoke.mjs", urlEnv: c.urlEnv, expectRole: c.expectRole, env: c.dbEnvironment, writeProbe: false, loopbackRehearsal: false },
    target: { host: "aws-0-us-east-1.pooler.supabase.com", port: 6543, user: `${c.expectRole}.${c.dbProjectRef}`, database: "postgres", projectRef: c.dbProjectRef },
    caSha256: OFFICIAL_CA_SHA256, childTimeoutMs: c.childTimeoutMs, runs: 1, retries: 0, approvalRef };
  return freeze({ plan: JSON.parse(JSON.stringify(plan)), planHash: sha(canonical(plan)) });
}

// ---- child output whitelist (pure) ------------------------------------------------------------------------------------------------
const TABLE = /^[a-z_]{1,64}$/;
const DIFF = /^[a-z_]{1,64}: expected (none|[A-Z,]{1,80}) got (none|[A-Z,]{1,80})$/;
const FUNC_SIG = /^booking\.[a-z_]{1,64}\([a-z,\[\]]{0,120}\)$/;
function safeDetail(name, d) {
  if (d === undefined) return undefined;
  if (typeof d === "string") {
    if (/^[A-Z0-9_]{2,40}$/.test(d)) return d;                                        // SQLSTATE / Node code
    if (name === "tls_protocol" && /^(TLSv1(\.[0-3])?|none)$/.test(d)) return d;
    if (/^(statement_timeout_5s|idle_in_transaction_session_timeout_10s)$/.test(name) && /^[0-9]{1,7}(ms|s|min|h|d)?$/.test(d)) return d;
    if (/^\d{1,3} tables$/.test(d)) return d;
    if (name === "migration_table_denied" && d === "readable") return d;
    if (name === "fatal" && USAGE_TEXTS.includes(d)) return d;
    return "REDACTED";
  }
  if (Array.isArray(d) && d.length <= 64 && d.every((x) => typeof x === "string" && (TABLE.test(x) || DIFF.test(x) || FUNC_SIG.test(x)))) return [...d];
  return "REDACTED";
}
/**
 * parseSmokeOutput({ status, signal, stdout, truncated, timedOut, spawnFailed }, secrets[]) → frozen { outcome, exitStatus, pass, checks, failed, code }
 * never returns raw stdout; a stdout containing any secret value is withheld entirely
 */
export function parseSmokeOutput(o, secrets = [], expected = EXPECTED_PASS_CHECKS) {
  const out = { outcome: null, exitStatus: null, pass: null, checks: [], failed: [], code: null };
  const done = (outcome, code = null) => { out.outcome = outcome; out.code = code; return freeze(JSON.parse(JSON.stringify(out))); };
  if (!o || o.spawnFailed) return done("SMOKE_CHILD_FAILED", "SPAWN_FAILED");
  if (o.timedOut) return done("SMOKE_TIMEOUT_UNKNOWN", "CHILD_TIMEOUT_KILLED");
  out.exitStatus = Number.isSafeInteger(o.status) ? o.status : null;
  if (o.signal) return done("SMOKE_CHILD_FAILED", "CHILD_SIGNALLED");
  const s = typeof o.stdout === "string" ? o.stdout : "";
  if (secrets.some((x) => typeof x === "string" && x.length >= 4 && s.includes(x))) return done("SMOKE_OUTPUT_INVALID", "SECRET_IN_OUTPUT_WITHHELD");
  if (o.truncated || s.length === 0) return done("SMOKE_OUTPUT_INVALID", s.length === 0 ? "EMPTY_OUTPUT" : "OUTPUT_TRUNCATED");
  let j; try { j = JSON.parse(s); } catch { return done("SMOKE_OUTPUT_INVALID", "NOT_JSON"); }
  if (!j || typeof j !== "object" || Array.isArray(j) || Object.keys(j).sort().join(",") !== "at,checks,pass" || typeof j.pass !== "boolean" || !Array.isArray(j.checks)
      || typeof j.at !== "string") return done("SMOKE_OUTPUT_INVALID", "UNEXPECTED_SHAPE");
  const known = new Set([...expected, ...FAILURE_ONLY_CHECKS]); const seen = new Set();
  for (const c of j.checks) {
    if (!c || typeof c !== "object" || Array.isArray(c) || typeof c.check !== "string" || typeof c.pass !== "boolean"
        || Object.keys(c).some((k) => !["check", "pass", "detail"].includes(k)) || !known.has(c.check) || seen.has(c.check)) return done("SMOKE_OUTPUT_INVALID", "UNEXPECTED_CHECK");
    seen.add(c.check);
    const d = safeDetail(c.check, c.detail);
    out.checks.push(d === undefined ? { check: c.check, pass: c.pass } : { check: c.check, pass: c.pass, detail: d });
    if (!c.pass) out.failed.push(c.check);
  }
  out.pass = j.pass;
  const allPass = out.checks.length > 0 && out.failed.length === 0;
  if (j.pass !== allPass) return done("SMOKE_OUTPUT_INVALID", "PASS_FLAG_INCONSISTENT");
  if (out.exitStatus === 0 && j.pass === true && allPass && out.checks.length === expected.length && expected.every((n) => seen.has(n))) return done("SMOKE_PASS");
  if (out.exitStatus === 0) return done("SMOKE_OUTPUT_INVALID", j.pass ? "PARTIAL_CHECK_SET" : "EXIT0_BUT_FAILED");
  if (out.exitStatus === 1 && !j.pass) return done("SMOKE_FAIL", "CHECKS_FAILED");
  return done("SMOKE_OUTPUT_INVALID", "EXIT_STATUS_INCONSISTENT");
}

// ---- real child (bounded) ----------------------------------------------------------------------------------------------------------
/** spawnBounded(args, { cwd, env, timeoutMs }) → { status, signal, stdout, truncated, timedOut, spawnFailed }; stderr is ignored (never read) */
export function spawnBounded(args, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    let out = ""; let bytes = 0; let truncated = false; let timedOut = false; let child; let settled = false;
    const fin = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
    try { child = spawn(process.execPath, args, { cwd, env, shell: false, stdio: ["ignore", "pipe", "ignore"] }); }
    catch { resolve({ status: null, signal: null, stdout: "", truncated: false, timedOut: false, spawnFailed: true }); return; }
    const timer = setTimeout(() => { timedOut = true; try { child.kill("SIGKILL"); } catch { /* gone */ } }, timeoutMs);
    child.stdout.on("data", (d) => { bytes += d.length; if (bytes <= MAX_STDOUT) out += d.toString("utf8"); else truncated = true; });
    child.on("error", () => fin({ status: null, signal: null, stdout: "", truncated, timedOut, spawnFailed: true }));
    child.on("close", (status, signal) => fin({ status, signal, stdout: out, truncated, timedOut, spawnFailed: false }));
  });
}
export function childEnv(env, toolingDir) { const out = {}; for (const k of Object.keys(env)) if (!k.startsWith("E7_")) out[k] = env[k]; out.E7_TOOLING_DIR = toolingDir; return out; }
const TEST_FILE = "test/e7-dev-db-smoke.test.mjs";
const FORBIDDEN_ENV = /HOSTAWAY|STRIPE|SUPABASE_SERVICE|SERVICE_ROLE|^MV_DEV_DB_URL$|^BOOKING_DATABASE_URL$|^DATABASE_URL$/i;

/**
 * runHosted({ mode, env, proc, wrapperDir, deps }) → { exitCode, result }. Never throws.
 *   deps (TEST SEAMS): spawnChild (tests child), runSmoke(argv, opts) (smoke child), readPgVersion, readCa, constants, caSha256
 */
export async function runHosted({ mode = "preflight", env, proc, wrapperDir, deps = {} }) {
  const c = deps.constants ?? CONSTANTS;
  const spawnChild = deps.spawnChild ?? ((args, o) => spawnBounded(args, { ...o, timeoutMs: 10 * 60 * 1000 }));
  const runSmoke = deps.runSmoke ?? spawnBounded;
  const readPgVersion = deps.readPgVersion ?? (async (dir) => JSON.parse(await readFile(`${dir}/node_modules/pg/package.json`, "utf8")).version);
  const readCa = deps.readCa ?? ((p) => readFile(p));
  const r = { schema: "e7-dev-db-smoke-hosted-v1", mode: null, code: null, workflowSha: null, toolingCommit: c.toolingCommit, closureDigest: null, runnerDigest: null,
    planKind: null, planHash: null, tests: null, smoke: null, connectivityEvidence: false };
  try {
    if (!["preflight", "verify", "execute"].includes(mode)) refuse("SMK_USAGE");
    r.mode = mode;
    r.workflowSha = HEX40.test(env.E7_WORKFLOW_SHA ?? "") ? env.E7_WORKFLOW_SHA : null;
    const hasDb = typeof env[c.urlEnv] === "string" && env[c.urlEnv].length > 0;
    if (mode !== "execute" && hasDb) refuse("SMK_SECRET_SCOPE_VIOLATION");
    if (Object.keys(env).some((k) => FORBIDDEN_ENV.test(k) && env[k] !== undefined && env[k] !== "")) refuse("SMK_SECRET_SCOPE_VIOLATION");
    const ref = env.E7_APPROVAL_REF ?? "";
    const expPlan = env.E7_EXPECTED_PLAN_HASH ?? ""; const expClo = env.E7_EXPECTED_CLOSURE_DIGEST ?? ""; const expRun = env.E7_EXPECTED_RUNNER_DIGEST ?? "";
    if (ref !== "" && !APPROVAL_RE.test(ref)) refuse("SMK_INPUT_INVALID");
    if (ref === c.synthetic.approvalRef) refuse("SMK_INPUT_INVALID");
    if (mode !== "preflight") {
      if (ref === "" || !HEX64.test(expPlan) || !HEX64.test(expClo) || !HEX64.test(expRun)) refuse("SMK_INPUT_INCOMPLETE");
      if (env.GITHUB_REF !== "refs/heads/main") refuse("SMK_REF_NOT_MAIN");
      if (expClo !== c.closureDigest) refuse("SMK_SOURCE_MISMATCH");
    }
    if (proc.versions.node !== c.nodeVersion) refuse("SMK_ENV_REFUSED");
    // ---- layout + the accepted closure BEFORE anything else -----------------------------------------------------------------------
    const tooling = await realpath(env.E7_TOOLING_DIR ?? "").catch(() => refuse("SMK_LAYOUT_INVALID"));
    const wdir = await realpath(wrapperDir).catch(() => refuse("SMK_LAYOUT_INVALID"));
    if (tooling === wdir || tooling.startsWith(`${wdir}/`) || wdir.startsWith(`${tooling}/`)) refuse("SMK_LAYOUT_INVALID");
    r.closureDigest = await framedDigest(tooling, c.closure, CLOSURE_DIGEST_PREFIX).catch(() => refuse("SMK_SOURCE_UNREADABLE"));
    if (r.closureDigest !== c.closureDigest) refuse("SMK_SOURCE_MISMATCH");
    r.runnerDigest = await framedDigest(wdir, c.runnerFiles, RUNNER_DIGEST_PREFIX).catch(() => refuse("SMK_SOURCE_UNREADABLE"));
    if (mode !== "preflight" && r.runnerDigest !== expRun) refuse("SMK_RUNNER_MISMATCH");
    r.planKind = ref === "" ? "SYNTHETIC" : "REAL";
    const built = buildPlan(c, { approvalRef: ref === "" ? c.synthetic.approvalRef : ref, runnerDigest: r.runnerDigest });
    r.planHash = built.planHash;
    if (mode !== "preflight" && built.planHash !== expPlan) refuse("SMK_PLAN_HASH_MISMATCH");
    // ---- preflight: the FAKE test suite as a plain child (no secret, no DB, no network, no dependency) -------------------------------
    if (mode === "preflight") {
      const o = await spawnChild(["--test", "--test-reporter=tap", TEST_FILE], { cwd: wdir, env: childEnv(env, tooling) });
      if (!o || o.spawnFailed || o.timedOut || (o.signal !== null && o.signal !== undefined) || !Number.isSafeInteger(o.status) || o.truncated) refuse("SMK_CHILD_FAILED");
      const num = (re) => { const m = re.exec(o.stdout); return m ? Number(m[1]) : null; };
      r.tests = { status: o.status, tests: num(/^# tests (\d+)$/m), pass: num(/^# pass (\d+)$/m), fail: num(/^# fail (\d+)$/m) };
      if (o.status !== 0 || !(r.tests.tests > 0) || r.tests.pass !== r.tests.tests || r.tests.fail !== 0) refuse("SMK_TESTS_FAILED");
      r.code = r.planKind === "REAL" ? "PREFLIGHT_OK_REAL_PLAN" : "PREFLIGHT_OK_SYNTHETIC_ONLY"; return { exitCode: 0, result: r };
    }
    if (mode === "verify") { r.code = "VERIFY_OK"; return { exitCode: 0, result: r }; }
    // ---- execute: dependency pin, ONE secret (read once, removed from env), target scope, CA pin, ONE bounded child ------------------
    if (!hasDb) refuse("SMK_CREDENTIALS_MISSING");
    let pgv; try { pgv = await readPgVersion(tooling); } catch { pgv = null; }
    if (pgv !== c.pgVersion) refuse("SMK_DEPENDENCY_MISMATCH");
    let dbUrl = env[c.urlEnv]; delete env[c.urlEnv];
    if (!dbTargetOk(dbUrl, c)) { dbUrl = null; refuse("SMK_DB_TARGET_INVALID"); }
    const caFile = env.E7_CA_FILE ?? "";
    let caOk = false;
    try { const b = await readCa(caFile); caOk = b.length > 0 && b.length < 16384 && sha(b) === (deps.caSha256 ?? OFFICIAL_CA_SHA256); } catch { caOk = false; }
    if (!caOk) { dbUrl = null; refuse("SMK_CA_INVALID"); }
    let argv; try { argv = smokeArgv(c, caFile); } catch { dbUrl = null; refuse("SMK_ARGV_INVALID"); }
    if (!argvOk(argv, c)) { dbUrl = null; refuse("SMK_ARGV_INVALID"); }
    let password = null; try { password = decodeURIComponent(new URL(dbUrl).password); } catch { password = null; }
    const secrets = [dbUrl, password].filter((x) => typeof x === "string" && x.length >= 4);
    const childOut = await runSmoke(argv, { cwd: tooling, env: { [c.urlEnv]: dbUrl }, timeoutMs: c.childTimeoutMs });   // exactly one run
    dbUrl = null;
    r.smoke = parseSmokeOutput(childOut, secrets);
    secrets.length = 0; password = null;
    r.code = "EXECUTE_DONE";
    return { exitCode: r.smoke.outcome === "SMOKE_PASS" ? 0 : 1, result: r };
  } catch (e) {
    r.code = e instanceof Refusal && HOSTED_CODES.includes(e.code) ? e.code : "SMK_INTERNAL";
    return { exitCode: 1, result: r };
  }
}

export function summaryMarkdown(r) {
  const s = r.smoke;
  const rows = [["mode", r.mode], ["code", r.code], ["workflow commit", r.workflowSha], ["tooling commit", r.toolingCommit], ["closureDigest (computed)", r.closureDigest],
    ["runnerDigest (computed)", r.runnerDigest], ["plan kind", r.planKind], ["planHash", r.planHash],
    ["fake tests (NOT connectivity)", r.tests ? `status ${r.tests.status}, pass ${r.tests.pass}/${r.tests.tests}, fail ${r.tests.fail}` : null],
    ["smoke outcome / code", s ? `${s.outcome} / ${s.code ?? "—"}` : null], ["smoke exit status", s ? s.exitStatus : null],
    ["checks passed", s ? `${s.checks.length - s.failed.length}/${s.checks.length}` : null], ["failed checks", s ? s.failed.join(" ") || "none" : null]];
  return `### E7 DEV read-only DB smoke (runtime login)\n\n| field | value |\n|---|---|\n${rows.map(([a, b]) => `| ${a} | ${b === null || b === undefined ? "—" : String(b)} |`).join("\n")}\n\n\`\`\`json\n${JSON.stringify(r)}\n\`\`\`\n`;
}

if (import.meta.main === true) {
  const mode = process.argv[2] ?? "preflight";
  const wrapperDir = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
  const { exitCode, result } = await runHosted({ mode, env: process.env, proc: process, wrapperDir });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summaryMarkdown(result)).catch(() => {});
  process.exitCode = exitCode;
}
