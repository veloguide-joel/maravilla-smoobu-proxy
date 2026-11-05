// test/e7-dev-db-smoke.test.mjs — OFFLINE tests of scripts/e7-dev-db-smoke.mjs. LABELS
//   * REAL: the wrapper; framed digests over the REAL accepted tooling checkout at 6d703acd (E7_TOOLING_DIR, default ../../tooling = workflow
//     layout); a real bounded node child (S8) that is NOT the smoke.
//   * FAKE: every smoke child result (S3–S7); the preflight tests child. Nothing here is connectivity evidence; no credential, DB or network.
//   * S10 (opt-in, E7_SMOKE_DB_TESTS=1 only; the hosted preflight never sets it): the REAL tooling db-smoke on a disposable LOOPBACK cluster
//     (tooling test/db/harness.mjs) with a TEST-ONLY loopback argv the wrapper itself never uses — parser compatibility with real output only.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, cpSync, writeFileSync, rmSync, realpathSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import * as E from "../scripts/e7-dev-db-smoke.mjs";
import { dbTargetOk as cleanupDbTargetOk } from "../scripts/e7-checkout-test-cleanup.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOOLING = realpathSync(process.env.E7_TOOLING_DIR || join(ROOT, "..", "tooling"));
const C = E.CONSTANTS;
const TMP = [];
after(() => { for (const d of TMP) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "e7-smk-")); TMP.push(d); return d; };
const PROC = { versions: { node: C.nodeVersion } };
const PW = "Pw4testOnly9";                                      // synthetic, short on purpose
const GOOD_URL = `postgresql://mv_booking_app_dev.mxotevtiscernhqilyiu:${PW}@aws-0-us-east-1.pooler.supabase.com:6543/postgres`;
const CA_FILE = "/runner/temp/prod-ca-2021.crt";
const CA_BYTES = Buffer.from("-----BEGIN CERTIFICATE-----\nFAKE\n-----END CERTIFICATE-----\n");
const tapOk = async () => ({ status: 0, signal: null, stdout: "TAP version 13\n# tests 3\n# pass 3\n# fail 0\n", truncated: false, spawnFailed: false });
const smokeJson = (checks, pass = checks.every((c) => c.pass)) => JSON.stringify({ at: "2026-11-05T00:00:00.000Z", pass, checks }, null, 1) + "\n";
const allPass = () => E.EXPECTED_PASS_CHECKS.map((n) => (n === "tls_protocol" ? { check: n, pass: true, detail: "TLSv1.3" } : n === "statement_timeout_5s" ? { check: n, pass: true, detail: "5s" }
  : n === "table_privilege_matrix_exact" || n === "data_only_instance_row" ? { check: n, pass: true, detail: "28 tables" } : { check: n, pass: true }));

function harness({ smoke, pgVersion = C.pgVersion, ca = CA_BYTES } = {}) {
  const calls = { smoke: [], tests: 0, ca: 0, pg: 0 };
  const deps = {
    spawnChild: async (...a) => { calls.tests += 1; return tapOk(...a); },
    runSmoke: async (argv, opts) => { calls.smoke.push({ argv, opts: { cwd: opts.cwd, envKeys: Object.keys(opts.env), envUrl: opts.env[C.urlEnv], timeoutMs: opts.timeoutMs } });
      return typeof smoke === "function" ? smoke(argv, opts) : smoke ?? { status: 0, signal: null, stdout: smokeJson(allPass()), truncated: false, timedOut: false, spawnFailed: false }; },
    readPgVersion: async () => { calls.pg += 1; return pgVersion; },
    readCa: async () => { calls.ca += 1; if (ca === null) throw new Error("ENOENT"); return ca; },
    caSha256: createHash("sha256").update(CA_BYTES).digest("hex")
  };
  return { calls, deps };
}
let PINS = null;
async function pins() {
  if (PINS) return PINS;
  const { deps } = harness();
  const r = (await E.runHosted({ mode: "preflight", env: { E7_TOOLING_DIR: TOOLING, E7_APPROVAL_REF: "ROOT-APPROVAL-SMOKE-1" }, proc: PROC, wrapperDir: ROOT, deps })).result;
  assert.equal(r.code, "PREFLIGHT_OK_REAL_PLAN");
  PINS = { E7_APPROVAL_REF: "ROOT-APPROVAL-SMOKE-1", E7_EXPECTED_PLAN_HASH: r.planHash, E7_EXPECTED_CLOSURE_DIGEST: r.closureDigest, E7_EXPECTED_RUNNER_DIGEST: r.runnerDigest };
  return PINS;
}
async function execute(over = {}, h = harness(), constants) {
  const env = { E7_TOOLING_DIR: TOOLING, GITHUB_REF: "refs/heads/main", ...(await pins()), E7_CA_FILE: CA_FILE, [C.urlEnv]: GOOD_URL, ...over };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const res = await E.runHosted({ mode: "execute", env, proc: PROC, wrapperDir: ROOT, deps: constants ? { ...h.deps, constants } : h.deps });
  return { ...res, env, calls: h.calls };
}

test("S1 inert on import + built-ins only: the wrapper imports node: modules and the cleanup runner's pure helpers, nothing from tooling", () => {
  const src = readFileSync(join(ROOT, "scripts/e7-dev-db-smoke.mjs"), "utf8");
  const imports = [...src.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]).sort();
  assert.deepEqual(imports, ["./e7-checkout-test-cleanup.mjs", "node:child_process", "node:crypto", "node:fs/promises", "node:process", "node:url"]);
  assert.doesNotMatch(src, /import\(/);
  assert.match(src, /\nif \(import\.meta\.main === true\) \{\n/);
  assert.deepEqual(E.argvOk(["scripts/db-smoke.mjs", "--url-env", C.urlEnv, "--ca-file", CA_FILE, "--expect-role", C.expectRole, "--env", "test"]), true);
  // the reused helper IS the accepted cleanup runner's (same function object), not a copy
  assert.equal(typeof cleanupDbTargetOk, "function"); assert.equal(cleanupDbTargetOk(GOOD_URL, C), true);
});

test("S2 the smoke's FULL transitive closure (relative imports) + package files = the pinned list and digest; pg 8.18.0 in the lock", async () => {
  const seen = new Set(); const visit = (rel) => { if (seen.has(rel)) return; seen.add(rel);
    const src = readFileSync(join(TOOLING, rel), "utf8");
    for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+"(\.{1,2}\/[^"]+)"/g)) visit(normalize(join(dirname(rel), m[1])));
    for (const m of src.matchAll(/import\(\s*"(\.{1,2}\/[^"]+)"\s*\)/g)) visit(normalize(join(dirname(rel), m[1]))); };
  visit("scripts/db-smoke.mjs");
  assert.deepEqual([...seen].sort(), C.closure.filter((f) => !f.startsWith("package")).sort());
  const bare = new Set(); for (const f of seen) for (const m of readFileSync(join(TOOLING, f), "utf8").matchAll(/from\s+"([^."][^"]*)"/g)) bare.add(m[1]);
  assert.deepEqual([...bare].sort(), ["node:crypto", "node:fs", "pg"]);
  assert.equal(await (await import("../scripts/e7-checkout-test-cleanup.mjs")).framedDigest(TOOLING, C.closure, E.CLOSURE_DIGEST_PREFIX), C.closureDigest);
  assert.equal(JSON.parse(readFileSync(join(TOOLING, "package-lock.json"), "utf8")).packages["node_modules/pg"].version, C.pgVersion);
  assert.match(readFileSync(join(TOOLING, "scripts/db-smoke.mjs"), "utf8"), /const OFFICIAL_CA_SHA256 = "700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7"/);
  // tamper one byte of the smoke, then the lock: refused before the tests child or anything else
  const d = tmp(); for (const rel of C.closure) { mkdirSync(dirname(join(d, rel)), { recursive: true }); cpSync(join(TOOLING, rel), join(d, rel)); }
  writeFileSync(join(d, "scripts/db-smoke.mjs"), readFileSync(join(TOOLING, "scripts/db-smoke.mjs"), "utf8").replace("--write-probe (separate", "--write-probe (Separate"));
  let h = harness(); let r = await E.runHosted({ mode: "preflight", env: { E7_TOOLING_DIR: d }, proc: PROC, wrapperDir: ROOT, deps: h.deps });
  assert.equal(r.result.code, "SMK_SOURCE_MISMATCH"); assert.equal(h.calls.tests, 0);
  cpSync(join(TOOLING, "scripts/db-smoke.mjs"), join(d, "scripts/db-smoke.mjs"));
  writeFileSync(join(d, "package-lock.json"), readFileSync(join(TOOLING, "package-lock.json"), "utf8").replace('"version": "8.18.0"', '"version": "8.18.1"'));
  h = harness(); r = await E.runHosted({ mode: "preflight", env: { E7_TOOLING_DIR: d }, proc: PROC, wrapperDir: ROOT, deps: h.deps });
  assert.equal(r.result.code, "SMK_SOURCE_MISMATCH"); assert.equal(h.calls.tests, 0);
});

test("S3 default preflight: zero effects (no smoke child, no CA / pg read, no secret), synthetic label, child env scoped; secrets refused", async () => {
  const h = harness(); let seenEnv = null;
  h.deps.spawnChild = async (args, o) => { h.calls.tests += 1; seenEnv = o.env; assert.deepEqual(args, ["--test", "--test-reporter=tap", "test/e7-dev-db-smoke.test.mjs"]); return tapOk(); };
  const res = await E.runHosted({ mode: "preflight", env: { E7_TOOLING_DIR: TOOLING, E7_WORKFLOW_SHA: "a".repeat(40) }, proc: PROC, wrapperDir: ROOT, deps: h.deps });
  assert.equal(res.exitCode, 0); assert.equal(res.result.code, "PREFLIGHT_OK_SYNTHETIC_ONLY"); assert.equal(res.result.connectivityEvidence, false);
  assert.deepEqual([h.calls.smoke.length, h.calls.ca, h.calls.pg, h.calls.tests], [0, 0, 0, 1]);
  assert.deepEqual(Object.keys(seenEnv).filter((k) => k.startsWith("E7_")), ["E7_TOOLING_DIR"]);
  assert.equal(res.result.smoke, null);
  for (const extra of [{ [C.urlEnv]: GOOD_URL }, { STRIPE_TEST_SECRET_KEY: "x" }, { E7_STRIPE_TEST_KEY: "x" }, { HOSTAWAY_CLIENT_SECRET: "x" }, { MV_DEV_DB_URL: "x" }]) {
    const h2 = harness();
    const r2 = await E.runHosted({ mode: "preflight", env: { E7_TOOLING_DIR: TOOLING, ...extra }, proc: PROC, wrapperDir: ROOT, deps: h2.deps });
    assert.equal(r2.result.code, "SMK_SECRET_SCOPE_VIOLATION", Object.keys(extra)[0]); assert.equal(h2.calls.tests, 0);
  }
  const h3 = harness(); h3.deps.spawnChild = async () => ({ status: 1, signal: null, stdout: "# tests 3\n# pass 2\n# fail 1\n", truncated: false, spawnFailed: false });
  assert.equal((await E.runHosted({ mode: "preflight", env: { E7_TOOLING_DIR: TOOLING }, proc: PROC, wrapperDir: ROOT, deps: h3.deps })).result.code, "SMK_TESTS_FAILED");
  assert.equal((await E.runHosted({ mode: "preflight", env: { E7_TOOLING_DIR: TOOLING }, proc: { versions: { node: "22.21.0" } }, wrapperDir: ROOT, deps: harness().deps })).result.code, "SMK_ENV_REFUSED");
});

test("S4 execute scope: every refusal happens BEFORE the smoke child (ref, pins, digests, pg, target, CA, argv)", async () => {
  const cases = [
    [{ GITHUB_REF: "refs/heads/feature/x" }, "SMK_REF_NOT_MAIN"],
    [{ E7_EXPECTED_PLAN_HASH: undefined }, "SMK_INPUT_INCOMPLETE"],
    [{ E7_APPROVAL_REF: undefined }, "SMK_INPUT_INCOMPLETE"],
    [{ E7_EXPECTED_CLOSURE_DIGEST: "0".repeat(64) }, "SMK_SOURCE_MISMATCH"],
    [{ E7_EXPECTED_RUNNER_DIGEST: "0".repeat(64) }, "SMK_RUNNER_MISMATCH"],
    [{ E7_EXPECTED_PLAN_HASH: "0".repeat(64) }, "SMK_PLAN_HASH_MISMATCH"],
    [{ E7_APPROVAL_REF: "ANOTHER-LABEL" }, "SMK_PLAN_HASH_MISMATCH"],
    [{ [C.urlEnv]: undefined }, "SMK_CREDENTIALS_MISSING"],
    [{ [C.urlEnv]: GOOD_URL.replace("mv_booking_app_dev.", "postgres.") }, "SMK_DB_TARGET_INVALID"],                        // owner credential
    [{ [C.urlEnv]: GOOD_URL.replace("mv_booking_app_dev.mxotevtiscernhqilyiu", "postgres") }, "SMK_DB_TARGET_INVALID"],
    [{ [C.urlEnv]: GOOD_URL.replace("mxotevtiscernhqilyiu", "zzzzzzzzzzzzzzzzzzzz") }, "SMK_DB_TARGET_INVALID"],            // other (e.g. prod) ref
    [{ [C.urlEnv]: GOOD_URL.replace(":6543", ":5432") }, "SMK_DB_TARGET_INVALID"],                                          // session port
    [{ [C.urlEnv]: GOOD_URL.replace("aws-0-us-east-1", "aws-0-eu-west-1") }, "SMK_DB_TARGET_INVALID"],
    [{ [C.urlEnv]: GOOD_URL.replace("aws-0-us-east-1.pooler.supabase.com:6543", "db.mxotevtiscernhqilyiu.supabase.co:5432") }, "SMK_DB_TARGET_INVALID"],
    [{ [C.urlEnv]: `${GOOD_URL}?sslmode=disable` }, "SMK_DB_TARGET_INVALID"],
    [{ [C.urlEnv]: `${GOOD_URL}#x` }, "SMK_DB_TARGET_INVALID"],
    [{ [C.urlEnv]: GOOD_URL.replace("/postgres", "/other") }, "SMK_DB_TARGET_INVALID"],
    [{ [C.urlEnv]: GOOD_URL.replace("postgresql:", "http:") }, "SMK_DB_TARGET_INVALID"],
    [{ [C.urlEnv]: "not a url" }, "SMK_DB_TARGET_INVALID"],
    [{ E7_CA_FILE: "relative/prod-ca-2021.crt" }, "SMK_ARGV_INVALID"],
    [{ E7_CA_FILE: "/runner/../etc/prod-ca-2021.crt" }, "SMK_ARGV_INVALID"],
    [{ E7_STRIPE_TEST_KEY: "sk_test_Fake1" }, "SMK_SECRET_SCOPE_VIOLATION"]];
  for (const [over, code] of cases) {
    const r = await execute(over);
    assert.equal(r.result.code, code, JSON.stringify(Object.keys(over))); assert.equal(r.calls.smoke.length, 0, code); assert.equal(r.exitCode, 1);
    assert.ok(!JSON.stringify(r.result).includes(PW), "no credential in the result");
  }
  const pgBad = harness({ pgVersion: "8.18.1" }); assert.equal((await execute({}, pgBad)).result.code, "SMK_DEPENDENCY_MISMATCH"); assert.equal(pgBad.calls.smoke.length, 0);
  const caBad = harness({ ca: Buffer.from("other") }); assert.equal((await execute({}, caBad)).result.code, "SMK_CA_INVALID"); assert.equal(caBad.calls.smoke.length, 0);
  const caGone = harness({ ca: null }); assert.equal((await execute({}, caGone)).result.code, "SMK_CA_INVALID"); assert.equal(caGone.calls.smoke.length, 0);
  // tampered constants: argv / role / env changes are refused (plan or argv gate), never reach the child
  for (const t of [{ expectRole: "postgres" }, { dbEnvironment: "live" }, { urlEnv: "BOOKING_DATABASE_URL" }]) {
    const h = harness(); const r = await execute({}, h, { ...C, ...t });
    assert.ok(["SMK_INPUT_INVALID", "SMK_PLAN_HASH_MISMATCH", "SMK_CREDENTIALS_MISSING", "SMK_SECRET_SCOPE_VIOLATION"].includes(r.result.code), r.result.code); assert.equal(h.calls.smoke.length, 0);
  }
  const base = E.smokeArgv(C, CA_FILE);
  for (const bad of [[...base, "--write-probe"], [...base.slice(0, 8), "live"], [...base.slice(0, 7), "--loopback-rehearsal", "test"], base.slice(1), ["scripts/other.mjs", ...base.slice(1)]]) assert.equal(E.argvOk(bad), false);
  // parity of the reused target helper with the cleanup runner's (it is the same function; checked here against the same cases)
  for (const u of [GOOD_URL, GOOD_URL.replace(":6543", ":5432"), `${GOOD_URL}?x=1`]) assert.equal(cleanupDbTargetOk(u, C), u === GOOD_URL);
});

test("S5 success: exactly ONE smoke child, fixed argv / cwd / minimal env / timeout; SMOKE_PASS only for the exact all-pass set; the secret leaves env", async () => {
  const r = await execute();
  assert.equal(r.exitCode, 0); assert.equal(r.result.code, "EXECUTE_DONE"); assert.equal(r.result.smoke.outcome, "SMOKE_PASS");
  assert.equal(r.calls.smoke.length, 1);
  const s = r.calls.smoke[0];
  assert.deepEqual(s.argv, ["scripts/db-smoke.mjs", "--url-env", "E7_DEV_BOOKING_DATABASE_URL", "--ca-file", CA_FILE, "--expect-role", "mv_booking_app_dev", "--env", "test"]);
  assert.equal(s.opts.cwd, TOOLING); assert.deepEqual(s.opts.envKeys, ["E7_DEV_BOOKING_DATABASE_URL"]); assert.equal(s.opts.envUrl, GOOD_URL); assert.equal(s.opts.timeoutMs, 90000);
  assert.equal(Object.hasOwn(r.env, C.urlEnv), false, "the secret is removed from the process env object");
  assert.equal(r.result.smoke.checks.length, E.EXPECTED_PASS_CHECKS.length); assert.deepEqual(r.result.smoke.failed, []);
  const out = JSON.stringify(r.result) + E.summaryMarkdown(r.result);
  assert.ok(!out.includes(PW) && !out.includes("pooler.supabase.com:6543") && !out.includes("2026-11-05T00:00:00"), "no URL / credential / child timestamp");
  assert.match(E.summaryMarkdown(r.result), /SMOKE_PASS/);
});

test("S6 child failure shapes: DEV not empty, nonzero, malformed, empty, partial, unknown check, inconsistent, truncated, signal, spawn; never retried", async () => {
  const fail = allPass().map((c) => (c.check === "data_only_instance_row" ? { check: c.check, pass: false, detail: ["intents", "intent_guests"] } : c));
  const cases = [
    [{ status: 1, stdout: smokeJson(fail) }, "SMOKE_FAIL", "CHECKS_FAILED"],
    [{ status: 1, stdout: smokeJson([{ check: "ca_file_is_official_supabase_prod_ca_2021", pass: false }]) }, "SMOKE_FAIL", "CHECKS_FAILED"],
    [{ status: 1, stdout: smokeJson([{ check: "connect_authenticated", pass: false, detail: "28P01" }]) }, "SMOKE_FAIL", "CHECKS_FAILED"],
    [{ status: 0, stdout: "{not json" }, "SMOKE_OUTPUT_INVALID", "NOT_JSON"],
    [{ status: 0, stdout: "" }, "SMOKE_OUTPUT_INVALID", "EMPTY_OUTPUT"],
    [{ status: 0, stdout: smokeJson(allPass().slice(0, 10)) }, "SMOKE_OUTPUT_INVALID", "PARTIAL_CHECK_SET"],
    [{ status: 0, stdout: smokeJson([]) }, "SMOKE_OUTPUT_INVALID", "PASS_FLAG_INCONSISTENT"],
    [{ status: 0, stdout: smokeJson(fail) }, "SMOKE_OUTPUT_INVALID", "EXIT0_BUT_FAILED"],
    [{ status: 1, stdout: smokeJson(allPass()) }, "SMOKE_OUTPUT_INVALID", "EXIT_STATUS_INCONSISTENT"],
    [{ status: 2, stdout: smokeJson(fail) }, "SMOKE_OUTPUT_INVALID", "EXIT_STATUS_INCONSISTENT"],
    [{ status: 0, stdout: smokeJson([...allPass(), { check: "write_probe_delete_denied", pass: true }]) }, "SMOKE_OUTPUT_INVALID", "UNEXPECTED_CHECK"],
    [{ status: 0, stdout: smokeJson([...allPass(), allPass()[0]]) }, "SMOKE_OUTPUT_INVALID", "UNEXPECTED_CHECK"],
    [{ status: 0, stdout: smokeJson(allPass().map((c, i) => (i === 0 ? { ...c, extra: 1 } : c))) }, "SMOKE_OUTPUT_INVALID", "UNEXPECTED_CHECK"],
    [{ status: 0, stdout: JSON.stringify({ pass: true, checks: allPass() }) }, "SMOKE_OUTPUT_INVALID", "UNEXPECTED_SHAPE"],
    [{ status: 0, stdout: smokeJson(allPass(), false) }, "SMOKE_OUTPUT_INVALID", "PASS_FLAG_INCONSISTENT"],
    [{ status: 0, stdout: smokeJson(allPass()), truncated: true }, "SMOKE_OUTPUT_INVALID", "OUTPUT_TRUNCATED"],
    [{ status: null, signal: "SIGSEGV", stdout: "" }, "SMOKE_CHILD_FAILED", "CHILD_SIGNALLED"],
    [{ spawnFailed: true }, "SMOKE_CHILD_FAILED", "SPAWN_FAILED"],
    [{ timedOut: true, status: null, signal: "SIGKILL", stdout: "" }, "SMOKE_TIMEOUT_UNKNOWN", "CHILD_TIMEOUT_KILLED"]];
  for (const [child, outcome, code] of cases) {
    const h = harness({ smoke: { status: 0, signal: null, truncated: false, timedOut: false, spawnFailed: false, ...child } });
    const r = await execute({}, h);
    assert.equal(r.result.smoke.outcome, outcome, code); assert.equal(r.result.smoke.code, code); assert.equal(r.exitCode, 1, code);
    assert.equal(h.calls.smoke.length, 1, `${code}: one child, no retry / rerun / fallback`);
    if (outcome === "SMOKE_OUTPUT_INVALID") assert.deepEqual(r.result.smoke.failed.filter((n) => !E.EXPECTED_PASS_CHECKS.includes(n)), []);
  }
  const notEmpty = await execute({}, harness({ smoke: { status: 1, signal: null, stdout: smokeJson(fail), truncated: false, timedOut: false, spawnFailed: false } }));
  assert.deepEqual(notEmpty.result.smoke.failed, ["data_only_instance_row"], "a non-empty DEV FAILS (the empty-data / 51-seed rule is the smoke's, unchanged)");
  assert.deepEqual(notEmpty.result.smoke.checks.find((c) => c.check === "data_only_instance_row").detail, ["intents", "intent_guests"]);
});

test("S7 redaction: a credential anywhere in child stdout withholds everything; free-text details are REDACTED; only safe shapes survive", async () => {
  const leak = allPass().map((c) => (c.check === "fatal" ? c : c)); leak.push({ check: "fatal", pass: false, detail: `boom ${PW}` });
  for (const stdout of [smokeJson(leak), `${smokeJson(allPass())}${GOOD_URL}`, smokeJson([{ check: "connect_authenticated", pass: false, detail: GOOD_URL }])]) {
    const r = await execute({}, harness({ smoke: { status: 1, signal: null, stdout, truncated: false, timedOut: false, spawnFailed: false } }));
    assert.equal(r.result.smoke.outcome, "SMOKE_OUTPUT_INVALID"); assert.equal(r.result.smoke.code, "SECRET_IN_OUTPUT_WITHHELD");
    assert.deepEqual(r.result.smoke.checks, []); assert.ok(!JSON.stringify(r.result).includes(PW));
  }
  const p = E.parseSmokeOutput({ status: 1, signal: null, stdout: smokeJson([
    { check: "connect_authenticated", pass: false, detail: "connection to server at 10.0.0.1 (host), port 6543 failed: password authentication failed for user x" },
    { check: "fatal", pass: false, detail: "the named environment variable is not set" },
    { check: "tls_protocol", pass: false, detail: "TLSv1.1" },
    { check: "statement_timeout_5s", pass: false, detail: "0" },
    { check: "runtime_functions_executable", pass: false, detail: ["booking.rate_limit_hit(text,integer,integer)"] },
    { check: "table_privilege_matrix_exact", pass: false, detail: ["intents: expected INSERT,SELECT,UPDATE got DELETE,INSERT,SELECT,UPDATE"] },
    { check: "data_only_instance_row", pass: false, detail: { nested: "object" } },
    { check: "migration_table_denied", pass: false, detail: "readable" }]), truncated: false, timedOut: false, spawnFailed: false }, [PW]);
  assert.equal(p.outcome, "SMOKE_FAIL");
  assert.deepEqual(p.checks.map((c) => c.detail), ["REDACTED", "the named environment variable is not set", "TLSv1.1", "0", ["booking.rate_limit_hit(text,integer,integer)"],
    ["intents: expected INSERT,SELECT,UPDATE got DELETE,INSERT,SELECT,UPDATE"], "REDACTED", "readable"]);
});

test("S8 real bounded child (NOT the smoke): hard kill at the timeout, stderr never read, stdout capped; one spawn", async () => {
  const d = tmp();
  writeFileSync(join(d, "hang.mjs"), "process.stderr.write('SECRET-ON-STDERR\\n'); setInterval(() => {}, 1000);\n");
  writeFileSync(join(d, "big.mjs"), "process.stdout.write('x'.repeat(200000)); process.stderr.write('SECRET-ON-STDERR');\n");
  writeFileSync(join(d, "ok.mjs"), "process.stderr.write('SECRET-ON-STDERR'); process.stdout.write(JSON.stringify({ env: Object.keys(process.env).sort() }));\n");
  const t0 = Date.now();
  const hang = await E.spawnBounded(["hang.mjs"], { cwd: d, env: {}, timeoutMs: 400 });
  assert.equal(hang.timedOut, true); assert.equal(hang.signal, "SIGKILL"); assert.ok(Date.now() - t0 < 5000); assert.ok(!hang.stdout.includes("SECRET"));
  assert.equal(E.parseSmokeOutput(hang).outcome, "SMOKE_TIMEOUT_UNKNOWN");
  const big = await E.spawnBounded(["big.mjs"], { cwd: d, env: {}, timeoutMs: 5000 });
  assert.equal(big.truncated, true); assert.ok(big.stdout.length <= 65536); assert.ok(!big.stdout.includes("SECRET"));
  const ok = await E.spawnBounded(["ok.mjs"], { cwd: d, env: { [C.urlEnv]: "x" }, timeoutMs: 5000 });
  assert.equal(ok.status, 0); assert.ok(!ok.stdout.includes("SECRET"));
  assert.deepEqual(JSON.parse(ok.stdout).env.filter((k) => !/^(NODE_|__CF|LANG$|LC_)/.test(k)), [C.urlEnv], "the child sees only the one URL variable");
});

test("S9 workflow: manual only; preflight has no secret; execute = main + e7-readonly-probe; the ONE secret only in the final step; no write flags", () => {
  const y = readFileSync(join(ROOT, ".github/workflows/e7-dev-db-smoke.yml"), "utf8");
  assert.match(y, /^on:\n {2}workflow_dispatch:\n/m); assert.doesNotMatch(y, /^\s+(push|pull_request|schedule|workflow_run):/m);
  const [pre, exe] = [y.slice(y.indexOf("  preflight:"), y.indexOf("  execute:")), y.slice(y.indexOf("  execute:"))];
  assert.doesNotMatch(pre, /secrets\./); assert.doesNotMatch(pre, /npm ci|curl/);
  assert.match(exe, /if: inputs\.mode == 'execute' && github\.ref == 'refs\/heads\/main'/); assert.match(exe, /environment: e7-readonly-probe/);
  assert.deepEqual([...y.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]), ["E7_DEV_BOOKING_DATABASE_URL"]);
  const steps = exe.split("\n      - name: ");
  assert.match(steps.at(-1), /E7_DEV_BOOKING_DATABASE_URL: \$\{\{ secrets\.E7_DEV_BOOKING_DATABASE_URL \}\}/);
  assert.match(steps.at(-1), /run: node wrapper\/scripts\/e7-dev-db-smoke\.mjs execute\n?$/);
  assert.ok(exe.indexOf("e7-dev-db-smoke.mjs verify") < exe.indexOf("npm ci --ignore-scripts --omit=dev") && exe.indexOf("npm ci") < exe.indexOf("curl --fail"));
  for (const run of [...y.matchAll(/run: (.*)/g)].map((m) => m[1])) assert.doesNotMatch(run, /\$\{\{\s*(secrets|inputs)\./, "no expression expansion inside a shell line");
  assert.doesNotMatch(y, /--write-probe"|--loopback-rehearsal"|db-smoke\.mjs --/);
  assert.match(y, /ref: 6d703acdcfa205138d1ce4ba65b2ec58fc9493c9/);
  assert.match(y, new RegExp(C.closureDigest));
});

// registered ONLY when opted in (not a skip), so the hosted preflight counts pass === tests over the fake section alone
if (process.env.E7_SMOKE_DB_TESTS === "1") test("S10 (opt-in E7_SMOKE_DB_TESTS=1) REAL tooling db-smoke on a disposable LOOPBACK cluster: its real output parses as an all-pass set", async () => {
  const H = await import(pathToFileURL(join(TOOLING, "test/db/harness.mjs")).href);
  const db = await H.startMigratedDatabase();
  try {
    // TEST-ONLY argv (loopback rehearsal, no TLS): the hosted wrapper never builds this; argvOk refuses it
    const argv = ["scripts/db-smoke.mjs", "--url-env", C.urlEnv, "--expect-role", "test_app", "--env", "test", "--loopback-rehearsal"];
    assert.equal(E.argvOk(argv), false);
    const o = await E.spawnBounded(argv, { cwd: TOOLING, env: { [C.urlEnv]: db.appUrl() }, timeoutMs: 60000 });
    const loopbackSet = E.EXPECTED_PASS_CHECKS.filter((n) => !n.startsWith("tls_") && n !== "ca_file_is_official_supabase_prod_ca_2021");
    const p = E.parseSmokeOutput(o, [db.appUrl()], loopbackSet);
    assert.equal(p.outcome, "SMOKE_PASS", JSON.stringify(p)); assert.equal(p.checks.length, 17);
    // and against the REMOTE expected set the same real output is NOT a pass (TLS / CA checks absent): the full set is required
    assert.equal(E.parseSmokeOutput(o, [], E.EXPECTED_PASS_CHECKS).outcome, "SMOKE_OUTPUT_INVALID");
    // a non-empty database FAILS the real smoke (data_only_instance_row), parsed as SMOKE_FAIL
    const id = "00000000-0000-4000-8000-0000000000aa";
    await db.owner.query(`INSERT INTO booking.intents (id, ref, access_token_hash, machine_version, environment, state, version, listing_id, from_date, to_date, guests, created_at, updated_at)
      VALUES ($1, 'MV-SMK0A1B2', sha256('x'::bytea), 'intent-state-v1', 'test', 'created', 0, 999999, '2099-01-10', '2099-01-12', 1, now(), now())`, [id]);
    {
      const o2 = await E.spawnBounded(argv, { cwd: TOOLING, env: { [C.urlEnv]: db.appUrl() }, timeoutMs: 60000 });
      const p2 = E.parseSmokeOutput(o2, [], loopbackSet);
      assert.equal(p2.outcome, "SMOKE_FAIL"); assert.deepEqual(p2.failed, ["data_only_instance_row"]);
    }
  } finally { await db.close(); }
});
