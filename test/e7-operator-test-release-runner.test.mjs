// E7 operator TEST release RUNNER (scripts/e7-operator-test-release.mjs) — OFFLINE. No secret, no network, no hosted DB, no provider.
//   * REAL: the runner; the accepted operator core / repo / C1 from the pinned tooling (E7_TOOLING_DIR, default ../tooling = workflow layout).
//   * FAKE: the DB (throwing / scripted pools), the child test process, the pool factory, the CA bytes and the pg version (injected seams).
//   * OPT-IN (E7_OPERATOR_DB_TESTS=1, tooling with its pinned pg installed): the REAL core through the runner core on a disposable local PG.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, cpSync, writeFileSync, rmSync, realpathSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve, relative } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOOLING = realpathSync(process.env.E7_TOOLING_DIR || join(ROOT, "..", "tooling"));
const tool = (p) => import(pathToFileURL(join(TOOLING, p)).href);
const E = await import("../scripts/e7-operator-test-release.mjs");
const OP = await tool("scripts/e7-operator/test-release.mjs");
const R = await tool("lib/booking-db/repo.js");
const C = E.CONSTANTS;
const TMP = [];
after(() => { for (const d of TMP) rmSync(d, { recursive: true, force: true }); });

const FIELDS = Object.freeze({ intentId: "3f1d2c4b-5a69-4e7d-8f01-23456789abcd", expectedVersion: 4, listingId: 606998, from: "2027-01-18", to: "2027-01-20", guests: 1,
  currency: "USD", finalTotalMinor: 23000, authorizedMinor: 23000, paymentIntentId: "pi_FakeOperator0001", sessionId: "cs_test_FakeOperatorSession01",
  attemptId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", approvalRef: "joel-e7-guest-test-run2-lost-token-20261106" });
const EXP = OP.buildOperatorExpectation({ ...FIELDS });
const EXP_JSON = E.canonical(EXP);
const DB_URL = "postgresql://mv_booking_app_dev.mxotevtiscernhqilyiu:S3cretPwCANARY@aws-0-us-east-1.pooler.supabase.com:6543/postgres";
const CA = Buffer.from("FAKE-CA-BYTES");
const CA_SHA = createHash("sha256").update(CA).digest("hex");
const proc = (over = {}) => ({ versions: { node: "22.22.0" }, platform: "linux", execArgv: [], getuid: () => 1000, ...over });
const okChild = async () => ({ status: 0, signal: null, stdout: "# tests 3\n# pass 3\n# fail 0\n", truncated: false, spawnFailed: false });

/** a wrapper layout: the three runner files copied into a temp dir (the real bytes; tamperable) */
function wrapperLayout() {
  const d = mkdtempSync(join(tmpdir(), "opr-wrap-")); TMP.push(d);
  for (const f of C.runnerFiles) { mkdirSync(dirname(join(d, f)), { recursive: true }); cpSync(join(ROOT, f), join(d, f)); }
  return d;
}
function toolingCopy() {
  const d = mkdtempSync(join(tmpdir(), "opr-tool-")); TMP.push(d);
  for (const f of C.closure) { mkdirSync(dirname(join(d, f)), { recursive: true }); cpSync(join(TOOLING, f), join(d, f)); }
  return d;
}
const W = wrapperLayout();
const RUNNER_DIGEST = await E.framedDigest(W, [...C.runnerFiles], E.RUNNER_DIGEST_PREFIX);
const PLAN = E.buildRunnerPlan(C, { expectation: EXP, closureDigest: C.closureDigest, runnerDigest: RUNNER_DIGEST });
const CT = Object.freeze({ ...C, caSha256: CA_SHA });                // the constants the hosted tests inject (fake CA bytes -> their pin)
const PLAN_T = E.buildRunnerPlan(CT, { expectation: EXP, closureDigest: C.closureDigest, runnerDigest: RUNNER_DIGEST });
const baseEnv = (over = {}) => ({ E7_TOOLING_DIR: TOOLING, E7_APPROVAL_REF: FIELDS.approvalRef, E7_EXPECTATION_JSON: EXP_JSON, ...over });
const pinnedEnv = (over = {}) => baseEnv({ GITHUB_REF: "refs/heads/main", E7_EXPECTED_RUNNER_PLAN_HASH: PLAN_T.runnerPlanHash, E7_EXPECTED_CLOSURE_DIGEST: C.closureDigest,
  E7_EXPECTED_RUNNER_DIGEST: RUNNER_DIGEST, ...over });
const seams = (over = {}) => ({ spawnChild: okChild, readPgVersion: async () => C.pgVersion, readCa: async () => CA, constants: CT,
  importPool: async () => ({ createBookingPool: () => ({ query: async () => { throw new Error("no"); }, end: async () => {} }) }), clock: () => 1793650000000, ...over });
const host = (mode, env, over = {}) => E.runHosted({ mode, env, proc: proc(), wrapperDir: W, deps: seams(over) });

// ---------------------------------------------------------------------------------------------------------------------------------
test("A1 expectation input: only the CANONICAL JSON of a plain object is accepted (whitespace / order / duplicate keys / size / type -> OPR_EXPECTATION_PARSE)", () => {
  assert.deepEqual(E.parseExpectation(EXP_JSON), EXP);
  const code = (t) => { try { E.parseExpectation(t); return "OK"; } catch (e) { return e.code; } };
  const spaced = JSON.stringify(EXP, null, 1); const unsorted = JSON.stringify({ ...EXP }); const dup = EXP_JSON.replace('{"approvalRef"', '{"guests":2,"approvalRef"');
  for (const t of [spaced, unsorted, dup, "", "{", "[]", "null", "\"x\"", "1", `${EXP_JSON} `, EXP_JSON.replace('"guests":1', '"guests":1.0'), "{}".padEnd(3000, " "),
    E.canonical({ ...EXP, pad: "x".repeat(2100) }), undefined, 42]) assert.equal(code(t), "OPR_EXPECTATION_PARSE", String(t).slice(0, 60));
  assert.equal(unsorted === EXP_JSON, false, "the fixture really is unsorted");
});

test("A2 outer runner plan: binds tooling / closure / runner / pg / node / DB target / CA / one-call budget + the full inner expectation, its hash and label; outer != inner; sensitive to every bound field", () => {
  const p = PLAN.plan;
  assert.equal(p.schema, E.RUNNER_PLAN_SCHEMA);
  assert.deepEqual([p.toolingCommit, p.closureDigest, p.runnerDigest, p.pgVersion, p.nodeVersion, p.caSha256], [C.toolingCommit, C.closureDigest, RUNNER_DIGEST, "8.18.0", "22.22.0", C.caSha256]);
  assert.deepEqual(p.db, { environment: "test", projectRef: "mxotevtiscernhqilyiu", host: "aws-0-us-east-1.pooler.supabase.com", port: "6543", user: "mv_booking_app_dev.mxotevtiscernhqilyiu", database: "postgres" });
  assert.deepEqual(p.budgets, { helperInvocations: 1, automaticRetries: 0, cleanupChaining: false, poolMax: 2 });
  assert.deepEqual(p.writes, { releaseRequestsMax: 1, stripe: 0, hostaway: 0, capture: 0, refund: 0, notify: 0 });
  assert.deepEqual([p.expectation, p.expectationHash, p.approvalRef, p.intentId], [{ ...EXP }, EXP.planHash, FIELDS.approvalRef, FIELDS.intentId]);
  assert.notEqual(PLAN.runnerPlanHash, PLAN.expectationHash);
  assert.equal(PLAN.expectationHash, EXP.planHash);
  assert.equal(E.buildRunnerPlan(C, { expectation: EXP, closureDigest: C.closureDigest, runnerDigest: RUNNER_DIGEST }).runnerPlanHash, PLAN.runnerPlanHash, "stable");
  const seen = new Set([PLAN.runnerPlanHash]);
  const variants = [...Object.keys(FIELDS).filter((k) => !["listingId", "currency", "finalTotalMinor", "authorizedMinor"].includes(k)).map((k) => {
    const v = { ...FIELDS }; v[k] = { intentId: "4f1d2c4b-5a69-4e7d-8f01-23456789abcd", expectedVersion: 5, from: "2027-01-17", to: "2027-01-21", guests: 2,
      paymentIntentId: "pi_FakeOperator0002", sessionId: "cs_test_FakeOperatorSession02", attemptId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeef", approvalRef: "other-label" }[k];
    return OP.buildOperatorExpectation(v);
  }), OP.buildOperatorExpectation({ ...FIELDS, finalTotalMinor: 23001, authorizedMinor: 23001 })];
  for (const x of variants) { assert.ok(x); const h = E.buildRunnerPlan(C, { expectation: x, closureDigest: C.closureDigest, runnerDigest: RUNNER_DIGEST }).runnerPlanHash; assert.ok(!seen.has(h)); seen.add(h); }
  for (const [cd, rd] of [["1".repeat(64), RUNNER_DIGEST], [C.closureDigest, "2".repeat(64)]]) {
    const h = E.buildRunnerPlan(C, { expectation: EXP, closureDigest: cd, runnerDigest: rd }).runnerPlanHash; assert.ok(!seen.has(h)); seen.add(h);
  }
  // no circularity: no runner file carries a plan hash (the expected hash is a dispatch input, never a source byte)
  for (const f of C.runnerFiles) assert.ok(!readFileSync(join(ROOT, f), "utf8").includes(PLAN.runnerPlanHash));
});

test("B1 core verify: read-only classify; projected report only; a read failure is VERIFY_READ_UNAVAILABLE with an error class (never a message)", async () => {
  const pool = { query: async () => ({ rows: [] }) };
  const ok = await E.runOperatorCore({ mode: "verify", expectation: EXP, pool, now: 1, ops: { executeOperatorRelease: async () => { throw new Error("never"); }, requestTestRelease: async () => { throw new Error("never"); },
    classify: async () => ({ class: "ALREADY_REQUESTED", code: null, state: "reservation_failed", version: 5, expectedVersion: 4, releaseVersion: 5, releaseActor: "admin",
      releasedAtExpectedVersion: true, voidState: "pending", voidAttempts: 0, voidDispatched: false, claimReleased: false, claimAnomaly: false, ref: "MV-SECRETREF", price: { quoteHash: "q" } }) } });
  assert.deepEqual([ok.outcome, ok.phase, ok.invocations, ok.reconciled.class, ok.reconciled.releaseActor], ["VERIFIED", "READ_ONLY", 0, "ALREADY_REQUESTED", "admin"]);
  assert.equal(JSON.stringify(ok).includes("SECRETREF") || JSON.stringify(ok).includes("quoteHash"), false, "only whitelisted report fields");
  const bad = await E.runOperatorCore({ mode: "verify", expectation: EXP, pool, now: 1, ops: { executeOperatorRelease: async () => ({}), requestTestRelease: async () => ({}),
    classify: async () => { throw Object.assign(new Error(`connect failed ${DB_URL}`), { code: "08006" }); } } });
  assert.deepEqual([bad.outcome, bad.errorClass], ["VERIFY_READ_UNAVAILABLE", "08006"]);
  assert.equal(JSON.stringify(bad).includes("S3cretPw"), false);
  // the REAL pinned core with a pool whose reads fail: the same read-unavailable outcome
  const dead = { query: async () => { throw Object.assign(new Error("x"), { code: "57P01" }); }, connect: async () => { throw new Error("never"); } };
  const real = await E.runOperatorCore({ mode: "verify", expectation: EXP, pool: dead, now: 1, ops: { classify: OP.classify, executeOperatorRelease: OP.executeOperatorRelease, requestTestRelease: R.requestTestRelease } });
  assert.deepEqual([real.outcome, real.errorClass], ["VERIFY_READ_UNAVAILABLE", "57P01"]);
});

test("B2 core execute: ONE executeOperatorRelease; a precheck read failure is BEFORE_INVOCATION (zero helper calls) — with the REAL pinned core too; NOT_EXECUTED_* stays before invocation", async () => {
  let calls = 0;
  const helper = async () => { calls += 1; return { ok: true }; };
  const pre = await E.runOperatorCore({ mode: "execute", expectation: EXP, pool: { query: async () => ({}) }, now: 1, ops: { classify: async () => ({}), requestTestRelease: helper,
    executeOperatorRelease: async () => { throw Object.assign(new Error("precheck read"), { code: "08006" }); } } });
  assert.deepEqual([pre.phase, pre.outcome, pre.invocations, pre.errorClass, calls], ["BEFORE_INVOCATION", "PRECHECK_READ_UNAVAILABLE", 0, "08006", 0]);
  const dead = { query: async () => { throw Object.assign(new Error("x"), { code: "08006" }); }, connect: async () => { throw new Error("never"); } };
  let realHelper = 0;
  const real = await E.runOperatorCore({ mode: "execute", expectation: EXP, pool: dead, now: 1,
    ops: { classify: OP.classify, executeOperatorRelease: OP.executeOperatorRelease, requestTestRelease: async (...a) => { realHelper += 1; return R.requestTestRelease(...a); } } });
  assert.deepEqual([real.phase, real.outcome, real.invocations, real.errorClass, realHelper], ["BEFORE_INVOCATION", "PRECHECK_READ_UNAVAILABLE", 0, "08006", 0]);
  for (const o of ["NOT_EXECUTED_ALREADY_REQUESTED", "NOT_EXECUTED_ALREADY_RELEASED", "NOT_EXECUTED_NOT_ELIGIBLE", "NOT_EXECUTED_INVALID"]) {
    const x = await E.runOperatorCore({ mode: "execute", expectation: EXP, pool: { query: async () => ({}) }, now: 1, ops: { classify: async () => ({}), requestTestRelease: helper,
      executeOperatorRelease: async () => ({ outcome: o, code: "STALE", precheck: { class: "NOT_ELIGIBLE", code: "STALE" } }) } });
    assert.deepEqual([x.phase, x.outcome, x.invocations, x.precheck.class], ["BEFORE_INVOCATION", o, 0, "NOT_ELIGIBLE"]);
  }
  assert.equal(calls, 0);
});

test("B3 core execute: every post-invocation outcome is preserved as reported (REQUESTED, POSTCHECK_MISMATCH incl. read-unavailable, REFUSED + reconcileError, UNKNOWN, duplicate); a second helper call is refused at the gate; never a retry", async () => {
  const mk = (res, { twice = false } = {}) => {
    let helperCalls = 0; let coreCalls = 0;
    const ops = { classify: async () => ({}), requestTestRelease: async () => { helperCalls += 1; return { ok: true }; },
      executeOperatorRelease: async (pool, e, opts) => { coreCalls += 1; await opts.deps.requestTestRelease(pool, e.intentId, { operator: e });
        if (twice) { try { await opts.deps.requestTestRelease(pool, e.intentId, { operator: e }); } catch (err) { assert.equal(err.code, "OPR_SECOND_INVOCATION_REFUSED"); } }
        return res; } };
    return { ops, counts: () => ({ helperCalls, coreCalls }) };
  };
  const cases = [
    [{ outcome: "REQUESTED", code: null, helper: { ok: true, duplicate: false, error: null }, reconciled: { class: "ALREADY_REQUESTED", releaseActor: "admin", releasedAtExpectedVersion: true } }, "REQUESTED", null],
    [{ outcome: "POSTCHECK_MISMATCH", code: "POSTCHECK_READ_UNAVAILABLE", helper: { ok: true, duplicate: false, error: null }, reconciled: null, errorClass: "08006" }, "POSTCHECK_MISMATCH", "POSTCHECK_READ_UNAVAILABLE"],
    [{ outcome: "POSTCHECK_MISMATCH", code: "DUPLICATE_POSTCHECK_READ_UNAVAILABLE", helper: { ok: true, duplicate: true, error: null }, reconciled: null, errorClass: "08006" }, "POSTCHECK_MISMATCH", "DUPLICATE_POSTCHECK_READ_UNAVAILABLE"],
    [{ outcome: "REFUSED", code: "TEST_RELEASE_WORK_LEASE_HELD", helper: { ok: false, duplicate: false, error: "TEST_RELEASE_WORK_LEASE_HELD" }, reconciled: null, reconcileError: "RECONCILE_READ_UNAVAILABLE", reconcileErrorClass: "08006" }, "REFUSED", "TEST_RELEASE_WORK_LEASE_HELD"],
    [{ outcome: "REQUEST_OUTCOME_UNKNOWN", code: null, helper: null, reconciled: null, errorClass: "Error", reconcileError: "RECONCILE_READ_UNAVAILABLE", reconcileErrorClass: "08006" }, "REQUEST_OUTCOME_UNKNOWN", null],
    [{ outcome: "DUPLICATE_RECONCILED", code: null, helper: { ok: true, duplicate: true, error: null }, reconciled: { class: "ALREADY_REQUESTED" } }, "DUPLICATE_RECONCILED", null],
    [{ outcome: "SOMETHING_NEW", code: "bad code with spaces" }, "REDACTED", "REDACTED"]
  ];
  for (const [res, outcome, code] of cases) {
    const m = mk(res, { twice: true });
    const r = await E.runOperatorCore({ mode: "execute", expectation: EXP, pool: { query: async () => ({}) }, now: 1, ops: m.ops });
    assert.deepEqual([r.phase, r.outcome, r.code, r.invocations, r.refusedInvocations], ["AFTER_INVOCATION", outcome, code, 1, 1], outcome);
    assert.deepEqual(m.counts(), { helperCalls: 1, coreCalls: 1 }, `${outcome}: one helper call, one core call, no retry`);
    if (res.reconcileError) assert.deepEqual([r.reconcileError, r.reconcileErrorClass], ["RECONCILE_READ_UNAVAILABLE", "08006"]);
  }
  // the core throwing AFTER an invocation (the accepted core never does) is UNKNOWN, never success, never a retry
  const t = mk(null); t.ops.executeOperatorRelease = async (pool, e, opts) => { await opts.deps.requestTestRelease(pool, e.intentId, {}); throw new Error("late"); };
  const u = await E.runOperatorCore({ mode: "execute", expectation: EXP, pool: { query: async () => ({}) }, now: 1, ops: t.ops });
  assert.deepEqual([u.phase, u.outcome, u.code, u.invocations], ["AFTER_INVOCATION", "REQUEST_OUTCOME_UNKNOWN", "CORE_THREW_AFTER_INVOCATION", 1]);
  assert.equal((await E.runOperatorCore({ mode: "cleanup", expectation: EXP, pool: { query: async () => ({}) }, now: 1, ops: t.ops })).outcome, "CORE_INVALID");
});

test("C1 preflight: secret-free (DB URL / any STRIPE / HOSTAWAY key refused), synthetic vs real plan, label / parse / shape / inner-hash checks by the PINNED core, env, fake child tests", async () => {
  const syn = await host("preflight", { E7_TOOLING_DIR: TOOLING });
  assert.deepEqual([syn.exitCode, syn.result.code, syn.result.planKind, syn.result.intentId], [0, "PREFLIGHT_OK_SYNTHETIC_ONLY", "SYNTHETIC", C.synthetic.intentId]);
  const real = await host("preflight", baseEnv());
  assert.deepEqual([real.exitCode, real.result.code, real.result.planKind, real.result.runnerPlanHash, real.result.expectationHash, real.result.closureDigest, real.result.runnerDigest],
    [0, "PREFLIGHT_OK_REAL_PLAN", "REAL", PLAN_T.runnerPlanHash, EXP.planHash, C.closureDigest, RUNNER_DIGEST]);
  const code = async (env, mode = "preflight", over = {}) => (await host(mode, env, over)).result.code;
  assert.equal(await code(baseEnv({ E7_DEV_BOOKING_DATABASE_URL: DB_URL })), "OPR_SECRET_SCOPE_VIOLATION");
  assert.equal(await code(baseEnv({ E7_STRIPE_TEST_KEY: "sk_test_x" })), "OPR_SECRET_SCOPE_VIOLATION");
  assert.equal(await code(baseEnv({ STRIPE_SECRET_KEY: "x" })), "OPR_SECRET_SCOPE_VIOLATION");
  assert.equal(await code(baseEnv({ HOSTAWAY_CLIENT_SECRET: "x" })), "OPR_SECRET_SCOPE_VIOLATION");
  assert.equal(await code(baseEnv({ E7_APPROVAL_REF: "" })), "OPR_INPUT_INCOMPLETE");
  assert.equal(await code(baseEnv({ E7_EXPECTATION_JSON: "" })), "OPR_INPUT_INCOMPLETE");
  assert.equal(await code(baseEnv({ E7_APPROVAL_REF: "other-label" })), "OPR_LABEL_MISMATCH");
  assert.equal(await code(baseEnv({ E7_APPROVAL_REF: "bad label!" })), "OPR_EXPECTATION_INVALID");
  assert.equal(await code(baseEnv({ E7_EXPECTATION_JSON: JSON.stringify(EXP, null, 2) })), "OPR_EXPECTATION_PARSE");
  assert.equal(await code(baseEnv({ E7_EXPECTATION_JSON: E.canonical({ ...EXP, guests: 2 }) })), "OPR_EXPECTATION_HASH_MISMATCH", "fields moved under the old inner hash");
  assert.equal(await code(baseEnv({ E7_EXPECTATION_JSON: E.canonical({ ...EXP, planHash: "0".repeat(64) }) })), "OPR_EXPECTATION_HASH_MISMATCH");
  assert.equal(await code(baseEnv({ E7_EXPECTATION_JSON: E.canonical({ ...EXP, from: "2027-13-01" }) })), "OPR_EXPECTATION_INVALID", "the pinned total validator");
  assert.equal(await code(baseEnv({ E7_EXPECTATION_JSON: E.canonical({ ...EXP, extra: 1 }) })), "OPR_EXPECTATION_INVALID");
  const synth = OP.buildOperatorExpectation({ ...FIELDS, intentId: C.synthetic.intentId });
  assert.equal(await code(baseEnv({ E7_EXPECTATION_JSON: E.canonical(synth) })), "OPR_SYNTHETIC_REFUSED");
  assert.equal(await code(baseEnv(), "cleanup"), "OPR_USAGE");
  assert.equal(await code(baseEnv(), "preflight", { spawnChild: async () => ({ status: 1, signal: null, stdout: "# tests 3\n# pass 2\n# fail 1\n", truncated: false, spawnFailed: false }) }), "OPR_TESTS_FAILED");
  assert.equal(await code(baseEnv(), "preflight", { spawnChild: async () => ({ status: null, signal: null, stdout: "", truncated: false, spawnFailed: true }) }), "OPR_CHILD_FAILED");
  assert.equal(await code(baseEnv(), "preflight", { spawnChild: async () => ({ status: 0, signal: null, stdout: "# tests 0\n# pass 0\n# fail 0\n", truncated: false, spawnFailed: false }) }), "OPR_TESTS_FAILED");
  assert.equal((await E.runHosted({ mode: "preflight", env: baseEnv({ NODE_OPTIONS: "--require x" }), proc: proc(), wrapperDir: W, deps: seams() })).result.code, "OPR_ENV_REFUSED");
  assert.equal((await E.runHosted({ mode: "preflight", env: baseEnv(), proc: proc({ versions: { node: "24.22.1" } }), wrapperDir: W, deps: seams() })).result.code, "OPR_ENV_REFUSED");
  // the child sees no E7_ input except the tooling dir
  let seenEnv = null;
  await host("preflight", baseEnv({ E7_WORKFLOW_SHA: "a".repeat(40) }), { spawnChild: async (args, o) => { seenEnv = o.env; return okChild(); } });
  assert.deepEqual(Object.keys(seenEnv).filter((k) => k.startsWith("E7_")), ["E7_TOOLING_DIR"]);
});

test("C4 minimal child environment: only the OS / runtime allowlist + E7_TOOLING_DIR reach the preflight child; credentials, DB URLs, tokens, NODE_* hooks and E7 inputs never do (nor any output)", async () => {
  const CANARIES = { CUSTOM_API_TOKEN: "CANARY_tok_1", DATABASE_URL: "postgresql://u:CANARY_db_2@h/x", GITHUB_TOKEN: "CANARY_gh_3", NODE_PATH: "/CANARY_np_4",
    NODE_LOADER: "CANARY_ld_5", NPM_CONFIG_USERCONFIG: "/CANARY_npm_6", AWS_SECRET_ACCESS_KEY: "CANARY_aws_7" };
  const BASICS = { PATH: "/usr/bin:/bin", HOME: "/home/runner", TMPDIR: "/tmp/r", LANG: "C.UTF-8", TZ: "UTC" };
  // unit: the hooks the parent C1 refuses are ALSO never forwarded, whatever reaches childEnv
  const unit = E.childEnv({ ...BASICS, ...CANARIES, NODE_OPTIONS: "--import=/CANARY_hook_8.mjs", NODE_EXTRA_CA_CERTS: "/CANARY_ca_9", E7_APPROVAL_REF: "lbl",
    E7_EXPECTATION_JSON: "{}", E7_EXPECTED_RUNNER_PLAN_HASH: "0".repeat(64), E7_DEV_BOOKING_DATABASE_URL: DB_URL, E7_TOOLING_DIR: "/attacker" }, "/tooling");
  assert.deepEqual(unit, { ...BASICS, E7_TOOLING_DIR: "/tooling" });
  assert.deepEqual([...E.CHILD_ENV_ALLOWLIST], ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "TZ"]);
  assert.deepEqual(E.childEnv({ PATH: "a\0b", HOME: "x".repeat(5000), TMP: 7 }, "/t"), { E7_TOOLING_DIR: "/t" }, "malformed values are dropped, not passed");
  // through runHosted (real fake plan): the spawned child sees exactly the allowlist; no canary in the child env or any output
  let seen = null; let args = null;
  const res = await host("preflight", baseEnv({ ...BASICS, ...CANARIES, E7_WORKFLOW_SHA: "a".repeat(40) }), { spawnChild: async (a, o) => { args = a; seen = o.env; return okChild(); } });
  assert.equal(res.result.code, "PREFLIGHT_OK_REAL_PLAN");
  assert.deepEqual(seen, { ...BASICS, E7_TOOLING_DIR: TOOLING });
  assert.deepEqual(args, ["--test", "--test-reporter=tap", "test/e7-operator-test-release-runner.test.mjs"]);
  const out = JSON.stringify(res.result) + E.summaryMarkdown(res.result) + JSON.stringify(seen);
  for (const v of Object.values(CANARIES)) assert.equal(out.includes(v.replace(/^.*CANARY/, "CANARY")), false, v);
  // the parent C1 still refuses the hook variables before any child exists (unchanged)
  let spawned = false;
  for (const k of ["NODE_OPTIONS", "NODE_EXTRA_CA_CERTS"]) {
    const r = await host("preflight", baseEnv({ [k]: "/CANARY_x" }), { spawnChild: async () => { spawned = true; return okChild(); } });
    assert.deepEqual([r.result.code, spawned], ["OPR_ENV_REFUSED", false], k);
  }
});

test("C2 the accepted closure is verified BEFORE any tooling import; tampered tooling / runner / layout refused; the closure list is the scanned transitive import closure; digest constant", async () => {
  let imported = false;
  const t = toolingCopy();
  writeFileSync(join(t, "lib/booking-db/repo.js"), `${readFileSync(join(t, "lib/booking-db/repo.js"), "utf8")}\n// tampered\n`);
  const r = await E.runHosted({ mode: "preflight", env: baseEnv({ E7_TOOLING_DIR: t }), proc: proc(), wrapperDir: W, deps: seams({ importCore: async () => { imported = true; return {}; } }) });
  assert.deepEqual([r.result.code, imported], ["OPR_SOURCE_MISMATCH", false]);
  assert.equal((await E.runHosted({ mode: "preflight", env: baseEnv({ E7_TOOLING_DIR: W }), proc: proc(), wrapperDir: W, deps: seams() })).result.code, "OPR_LAYOUT_INVALID");
  assert.equal((await E.runHosted({ mode: "preflight", env: baseEnv({ E7_TOOLING_DIR: join(TOOLING, "does-not-exist") }), proc: proc(), wrapperDir: W, deps: seams() })).result.code, "OPR_LAYOUT_INVALID");
  assert.equal(await E.framedDigest(TOOLING, [...C.closure], E.CLOSURE_DIGEST_PREFIX), C.closureDigest);
  const seen = new Set();
  const walk = (f) => {
    if (seen.has(f)) return; seen.add(f);
    for (const m of readFileSync(join(TOOLING, f), "utf8").matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/g)) {
      if (m[1].startsWith(".")) walk(relative(TOOLING, resolve(dirname(join(TOOLING, f)), m[1])).replace(/\\/g, "/"));
      else assert.match(m[1], /^(node:(crypto|util)|pg)$/, `external import ${m[1]} in ${f}`);
    }
  };
  for (const e of ["scripts/e7-operator/test-release.mjs", "lib/booking-db/pool.js", "scripts/e7-connected/probe-env-preflight.mjs"]) walk(e);
  assert.deepEqual(["package.json", "package-lock.json", ...[...seen].sort()], [...C.closure]);
  assert.equal(JSON.parse(readFileSync(join(TOOLING, "package-lock.json"), "utf8")).packages["node_modules/pg"].version, C.pgVersion);
});

test("C3 bindings / verify / execute: main only, every pin explicit and exact; bindings secret-free; DB secret = the DEV runtime target only, CA + pg pinned; secret removed from env and never output; one core call", async () => {
  const code = async (mode, env, over = {}) => (await host(mode, env, over)).result.code;
  assert.deepEqual([(await host("bindings", pinnedEnv())).exitCode, await code("bindings", pinnedEnv())], [0, "BINDINGS_OK"]);
  for (const mode of ["bindings", "verify", "execute"]) {
    assert.equal(await code(mode, pinnedEnv({ GITHUB_REF: "refs/heads/feature/x" })), "OPR_REF_NOT_MAIN", mode);
    for (const k of ["E7_EXPECTED_RUNNER_PLAN_HASH", "E7_EXPECTED_CLOSURE_DIGEST", "E7_EXPECTED_RUNNER_DIGEST"]) assert.equal(await code(mode, pinnedEnv({ [k]: "" })), "OPR_INPUT_INCOMPLETE", `${mode} ${k}`);
    assert.equal(await code(mode, pinnedEnv({ E7_EXPECTED_CLOSURE_DIGEST: "1".repeat(64) })), "OPR_SOURCE_MISMATCH", mode);
    assert.equal(await code(mode, pinnedEnv({ E7_EXPECTED_RUNNER_DIGEST: "2".repeat(64) })), "OPR_RUNNER_MISMATCH", mode);
    assert.equal(await code(mode, pinnedEnv({ E7_EXPECTED_RUNNER_PLAN_HASH: EXP.planHash })), "OPR_PLAN_HASH_MISMATCH", `${mode}: the INNER hash is not the outer plan hash`);
    assert.equal(await code(mode, pinnedEnv({ E7_APPROVAL_REF: "", E7_EXPECTATION_JSON: "" })), "OPR_INPUT_INCOMPLETE", `${mode}: no synthetic plan past preflight`);
  }
  assert.equal(await code("bindings", pinnedEnv({ E7_DEV_BOOKING_DATABASE_URL: DB_URL })), "OPR_SECRET_SCOPE_VIOLATION");
  assert.equal(await code("verify", pinnedEnv()), "OPR_CREDENTIALS_MISSING");
  assert.equal(await code("verify", pinnedEnv({ E7_DEV_BOOKING_DATABASE_URL: DB_URL }), { readPgVersion: async () => "8.17.0" }), "OPR_DEPENDENCY_MISMATCH");
  for (const bad of [DB_URL.replace("6543", "5432"), DB_URL.replace("aws-0-us-east-1.pooler", "aws-0-us-west-1.pooler"), DB_URL.replace("mv_booking_app_dev.", "postgres."),
    `${DB_URL}?sslmode=disable`, DB_URL.replace("/postgres", "/other"), "not a url", DB_URL.replace("postgresql:", "http:")]) {
    assert.equal(await code("verify", pinnedEnv({ E7_DEV_BOOKING_DATABASE_URL: bad })), "OPR_DB_TARGET_INVALID", bad.replace(/:[^:@/]+@/, ":***@"));
  }
  assert.equal(await code("verify", pinnedEnv({ E7_DEV_BOOKING_DATABASE_URL: DB_URL }), { readCa: async () => Buffer.from("OTHER") }), "OPR_CA_INVALID");
  // verify / execute reach the core exactly once with the pinned ops; exit 0 only for VERIFIED / REQUESTED
  for (const [mode, outcome, exit] of [["verify", "VERIFIED", 0], ["verify", "VERIFY_READ_UNAVAILABLE", 1], ["execute", "REQUESTED", 0], ["execute", "POSTCHECK_MISMATCH", 1],
    ["execute", "REQUEST_OUTCOME_UNKNOWN", 1], ["execute", "PRECHECK_READ_UNAVAILABLE", 1], ["execute", "NOT_EXECUTED_ALREADY_REQUESTED", 1]]) {
    const env = pinnedEnv({ E7_DEV_BOOKING_DATABASE_URL: DB_URL, E7_CA_FILE: "/fake/ca" });
    let coreCalls = 0; let got = null; let ended = 0; let poolArgs = null;
    const res = await host(mode, env, { runCore: async (a) => { coreCalls += 1; got = a; return { outcome, mode }; },
      importPool: async () => ({ createBookingPool: (o) => { poolArgs = o; return { query: async () => ({}), end: async () => { ended += 1; } }; } }) });
    assert.deepEqual([res.exitCode, res.result.code, coreCalls, ended], [exit, mode === "verify" ? "VERIFY_DONE" : "EXECUTE_DONE", 1, 1], `${mode} ${outcome}`);
    assert.deepEqual([got.mode, got.expectation.planHash, typeof got.ops.classify, typeof got.ops.executeOperatorRelease, typeof got.ops.requestTestRelease, got.now], [mode, EXP.planHash, "function", "function", "function", 1793650000000]);
    assert.equal(got.ops.requestTestRelease, R.requestTestRelease, "the pinned helper itself");
    assert.deepEqual([poolArgs.connectionString, poolArgs.max, poolArgs.caPem], [DB_URL, 2, "FAKE-CA-BYTES"]);
    assert.equal(Object.hasOwn(env, "E7_DEV_BOOKING_DATABASE_URL"), false, "the secret is removed from the environment once read");
    const out = JSON.stringify(res.result) + E.summaryMarkdown(res.result);
    for (const s of ["S3cretPw", "CANARY", "pooler.supabase.com:6543"]) assert.equal(out.includes(s), false, s);
  }
  // a pool factory failure is a target refusal; the secret never appears
  const pf = await host("execute", pinnedEnv({ E7_DEV_BOOKING_DATABASE_URL: DB_URL, E7_CA_FILE: "/f" }), { importPool: async () => ({ createBookingPool: () => { throw new Error(`bad ${DB_URL}`); } }) });
  assert.deepEqual([pf.result.code, JSON.stringify(pf.result).includes("S3cretPw")], ["OPR_DB_TARGET_INVALID", false]);
  // an unexpected internal throw is OPR_INTERNAL with no message
  const it = await host("execute", pinnedEnv({ E7_DEV_BOOKING_DATABASE_URL: DB_URL, E7_CA_FILE: "/f" }), { runCore: async () => { throw new Error(`boom ${DB_URL}`); } });
  assert.deepEqual([it.result.code, it.exitCode, JSON.stringify(it.result).includes("S3cretPw")], ["OPR_INTERNAL", 1, false]);
});

test("P1 source pins: runner inert + built-ins only, no provider client / fetch / URL; workflow: manual only, read-only token, fixed tooling commit, pinned actions, ONE DB secret in ONE step, install after bindings, main-only DB job", () => {
  const src = readFileSync(join(ROOT, "scripts/e7-operator-test-release.mjs"), "utf8");
  for (const m of src.matchAll(/(?:^|\n)\s*import\s[^;]*?from\s+["']([^"']+)["']/g)) assert.match(m[1], /^node:(process|child_process|crypto|fs\/promises|url)$/);
  const code = src.replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /fetch\(|https?:\/\/|stripe\.com|createStripe|hostaway\.com|access_token|runCleanup|cancelPaymentIntent/i);
  assert.doesNotMatch(code, /\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/, "no SQL write (case-sensitive: crypto hash .update() is not SQL)");
  assert.equal((code.match(/STRIPE|HOSTAWAY/g) || []).length, 2, "only the refusal pattern names them (upper case)");
  assert.ok(code.includes("if (import.meta.main === true)"));
  const wf = readFileSync(join(ROOT, ".github/workflows/e7-operator-test-release.yml"), "utf8");
  assert.deepEqual([...wf.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]), ["E7_DEV_BOOKING_DATABASE_URL"]);
  assert.equal((wf.match(/ref: ab55e7092ff0140a57d2a6eebff1e3adb1c3f039/g) || []).length, 2);
  assert.equal((wf.match(/environment: e7-readonly-probe/g) || []).length, 1);
  assert.ok(wf.includes("if: (inputs.mode == 'verify' || inputs.mode == 'execute') && github.ref == 'refs/heads/main'"));
  assert.ok(wf.includes("default: preflight") && wf.includes('node-version: "22.22.0"') && wf.includes("permissions:\n  contents: read"));
  assert.equal((wf.match(/persist-credentials: false/g) || []).length, 4);
  assert.equal((wf.match(/npm ci --ignore-scripts --omit=dev --no-audit --no-fund/g) || []).length, 1);
  assert.ok(wf.indexOf("e7-operator-test-release.mjs bindings") < wf.indexOf("npm ci") && wf.indexOf("npm ci") < wf.indexOf("secrets.E7_DEV_BOOKING_DATABASE_URL"));
  assert.ok(wf.includes(C.closureDigest), "the description names the accepted closure digest");
  for (const u of [...wf.matchAll(/uses: (\S+)/g)].map((m) => m[1])) assert.ok(["actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803", "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38"].includes(u), u);
  assert.ok(!/\bpush:|pull_request|schedule:|workflow_run|repository_dispatch/.test(wf));
  assert.doesNotMatch(wf.replace(/^\s*#.*$/gm, ""), /STRIPE|HOSTAWAY|e7-checkout-test-cleanup/i, "no provider secret / step / cleanup chaining (header comments excluded)");
});

// =================================================================================================================================
// OPT-IN: the REAL pinned core through the runner core, on a disposable local PG (tooling with its pinned pg installed)
if (process.env.E7_OPERATOR_DB_TESTS === "1") {
  const { startMigratedDatabase } = await tool("test/db/harness.mjs");
  const P = await tool("lib/booking-db/pool.js");
  const db = await startMigratedDatabase();
  after(async () => { await db.close(); });
  test("D1 REAL core on disposable PG through the runner core: verify of an absent intent -> VERIFIED / NOT_ELIGIBLE:INTENT_NOT_FOUND; execute -> NOT_EXECUTED_NOT_ELIGIBLE with ZERO helper invocations; nothing written", async () => {
    const pool = P.createBookingPool({ connectionString: db.appUrl(), max: 2 });
    try {
      const ops = { classify: OP.classify, executeOperatorRelease: OP.executeOperatorRelease, requestTestRelease: R.requestTestRelease };
      const before = (await db.owner.query("SELECT count(*)::int AS n FROM booking.intent_transitions")).rows[0].n;
      const v = await E.runOperatorCore({ mode: "verify", expectation: EXP, pool, now: Date.now(), ops });
      assert.deepEqual([v.outcome, v.reconciled.class, v.reconciled.code], ["VERIFIED", "NOT_ELIGIBLE", "INTENT_NOT_FOUND"]);
      const x = await E.runOperatorCore({ mode: "execute", expectation: EXP, pool, now: Date.now(), ops });
      assert.deepEqual([x.phase, x.outcome, x.code, x.invocations], ["BEFORE_INVOCATION", "NOT_EXECUTED_NOT_ELIGIBLE", "INTENT_NOT_FOUND", 0]);
      assert.equal((await db.owner.query("SELECT count(*)::int AS n FROM booking.intent_transitions")).rows[0].n, before);
    } finally { await pool.end(); }
  });

  // ---- D2 (LOCAL proof only; NOT hosted CLI / pooler / TLS proof). An ELIGIBLE intent built through the REAL pinned runtime path
  // (HTTP intent API -> pay step -> verified-webhook processing), run through the REAL runner core with the REAL pinned core + helper,
  // as the runtime app role. FIXTURE-ONLY fakes: in-memory SDK-shaped Stripe / Hostaway OBJECTS used solely to construct the
  // fixture (no network, no SDK, no key; fetch is refused and counted). No cleanup / worker / exchange is ever run.
  const { createIntentApiHandler, hashToken } = await tool("lib/checkout/intent-api-http.js");
  const { processVerifiedStripeEvent } = await tool("lib/checkout/stripe-test-webhook.js");
  const { findIntentIdByTokenHash } = await tool("lib/booking-db/intent-access.js");
  const { ENV_OK } = await tool("test/e5a-fixtures.mjs");
  const { addDays } = await tool("lib/bookability.js");
  const IS = await tool("lib/checkout/intent-state.js");
  const { Readable } = await import("node:stream");
  const D2_ACCT = "acct_1TyHE42B9LTneQgw";
  const D2_ORIGIN = "https://preview.example.invalid";
  const D2_ENV = Object.freeze({ ...ENV_OK, STRIPE_TEST_ACCOUNT_ID: D2_ACCT, MV_CHECKOUT_TEST_API: "enabled", MV_CHECKOUT_ALLOWED_ORIGIN: D2_ORIGIN,
    MV_CHECKOUT_TEST_LISTINGS: "606998:USD", MV_RATE_LIMIT_SALT: "s".repeat(40), MV_CHECKOUT_TERMS_VERSION: "terms-2026-11", MV_CHECKOUT_TEST_RELEASE: "enabled" });
  const NOW0 = Date.UTC(2026, 10, 2, 20, 0, 0); const MIN = 60000; const DAY = 1440 * MIN;
  const clone = (o) => JSON.parse(JSON.stringify(o)); const sec = (ms) => Math.floor(ms / 1000); const pad = (n) => String(n).padStart(8, "0");
  let d2seq = 0;
  function fixtureWorld() {
    const w = { calls: [], sessions: new Map(), pis: new Map() };
    const strip = (x) => { const { _pim, ...rest } = x; return clone(rest); };
    w.stripe = { accounts: { retrieve: async () => { w.calls.push("account"); return { object: "account", id: D2_ACCT }; } },
      checkout: { sessions: { create: async (params) => { w.calls.push("session.create"); const sid = `cs_test_D2${pad(++d2seq)}`; const pd = params.line_items[0].price_data;
        const ss = { object: "checkout.session", id: sid, livemode: false, mode: "payment", status: "open", payment_status: "unpaid", amount_total: pd.unit_amount, currency: pd.currency,
          client_reference_id: params.client_reference_id, metadata: { ...params.metadata }, expires_at: params.expires_at, url: `https://checkout.stripe.com/c/pay/${sid}`,
          payment_intent: null, customer_details: null, _pim: params.payment_intent_data }; w.sessions.set(sid, ss); return strip(ss); },
        retrieve: async (sid) => { w.calls.push("session.retrieve"); return strip(w.sessions.get(sid)); } } },
      paymentIntents: { retrieve: async (pid) => { w.calls.push("pi.retrieve"); return clone(w.pis.get(pid)); } } };
    w.hostaway = { get: async (path, opts = {}) => { w.calls.push("hostaway.get"); const m = /^\/listings\/(\d+)(\/calendar)?$/.exec(path);
        if (!m[2]) return { status: 200, json: { result: { id: Number(m[1]), currencyCode: "USD", personCapacity: 4, minNights: 1, maxNights: 90 } } };
        const out = []; for (let d = opts.query.startDate; d <= opts.query.endDate; d = addDays(d, 1)) out.push({ date: d, status: "available", isAvailable: 1, minimumStay: 1, maximumStay: 90, closedOnArrival: 0, closedOnDeparture: 0 });
        return { status: 200, json: { result: out } }; },
      post: async (path, body) => { w.calls.push("hostaway.post"); const nights = Math.round((Date.parse(body.endingDate) - Date.parse(body.startingDate)) / DAY);
        const comps = [{ id: 1, type: "accommodation", name: "baseRate", title: "Base rate", quantity: 1, value: 125, total: 125 * nights, isIncludedInTotalPrice: 1, isMandatory: 1, isOverriddenByUser: 0, isDeleted: 0, units: nights }];
        return { status: 200, json: { status: "success", result: { totalPrice: comps[0].total, components: comps } } }; } };
    w.pay = (sid, authAt) => { const ss = w.sessions.get(sid); const pid = `pi_D2${pad(++d2seq)}`;
      ss.status = "complete"; ss.payment_intent = pid; ss.customer_details = { email: "guest@example.invalid", name: "Guest Person" };
      w.pis.set(pid, { object: "payment_intent", id: pid, livemode: false, status: "requires_capture", capture_method: ss._pim.capture_method, amount: ss.amount_total,
        amount_capturable: ss.amount_total, amount_received: 0, currency: ss.currency, metadata: { ...ss._pim.metadata },
        latest_charge: { object: "charge", id: `ch_D2${pad(d2seq)}`, livemode: false, payment_intent: pid, captured: false, amount: ss.amount_total, amount_captured: 0, amount_refunded: 0,
          currency: ss.currency, status: "succeeded", paid: true, created: sec(authAt), payment_method_details: { type: "card", card: { capture_before: sec(authAt + 7 * DAY), last4: "4242" } } } });
      return pid; };
    w.event = (sid, t) => ({ id: `evt_D2${pad(++d2seq)}`, object: "event", type: "checkout.session.completed", livemode: false, created: sec(t), api_version: "2026-01-28.clover",
      data: { object: strip(w.sessions.get(sid)) } });
    return w;
  }
  const httpCall = (handler, { method = "POST", body, token } = {}) => { const raw = body === undefined ? "" : JSON.stringify(body);
    const req = Readable.from(raw ? [Buffer.from(raw)] : []); req.method = method; req.url = "/api/checkout/x";
    req.headers = { origin: D2_ORIGIN, ...(method === "POST" ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) };
    const res = { statusCode: 0, headers: {}, body: null, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { this.body = b ? JSON.parse(b) : null; } };
    return handler(req, res).then(() => res); };
  /** the ELIGIBLE fixture: payment_authorized through the real pinned runtime path; the guest token is then "lost" (never used again) */
  async function eligibleBooking() {
    const w = fixtureWorld(); const clock = { now: NOW0 };
    const deps = { createPool: () => db.app, loadCore: async () => tool("lib/checkout/intent-api-core.js"), loadAccess: async () => tool("lib/booking-db/intent-access.js"),
      createStripe: () => w.stripe, createHostaway: () => w.hostaway, loadStripe: async () => { throw new Error("no SDK"); }, loadHostaway: async () => { throw new Error("no Hostaway"); },
      now: () => clock.now, log: () => {}, onError: (e) => { throw e; } };
    const h = { intents: createIntentApiHandler({ route: "intents", env: D2_ENV, deps }), step: createIntentApiHandler({ route: "step", env: D2_ENV, deps }) };
    const c = await httpCall(h.intents, { body: { listingId: 606998, from: "2027-03-01", to: "2027-03-04", guests: 2 } });
    assert.equal(c.statusCode, 201, JSON.stringify(c.body));
    const token = c.body.token; const id = await findIntentIdByTokenHash(db.app, hashToken(token));
    clock.now += 1000;
    assert.equal((await httpCall(h.step, { body: { step: "details", firstName: "Zanabria", lastName: "Quintessa", email: "zq.d2@example.test", termsVersion: "terms-2026-11" }, token })).statusCode, 200);
    clock.now += 1000;
    assert.equal((await httpCall(h.step, { body: { step: "pay" }, token })).statusCode, 200);
    const sid = [...w.sessions.keys()][0];
    clock.now = NOW0 + 4 * MIN;
    const pid = w.pay(sid, clock.now - 30000);
    assert.deepEqual(await processVerifiedStripeEvent(db.app, w.event(sid, clock.now), { stripe: w.stripe, now: clock.now, accountId: D2_ACCT, accountCache: {} }),
      { http: 200, code: "APPLIED", state: "payment_authorized" });
    return { w, id, pid, sid };
  }
  const SNAP = [["intents", "id"], ["intent_transitions", "intent_id"], ["intent_applied_events", "intent_id"], ["external_operations", "intent_id"], ["payment_ledger", "intent_id"],
    ["inventory_claims", "intent_id"], ["payment_attempts", "intent_id"], ["stripe_webhook_events", "intent_id"], ["intent_work", "intent_id"],
    ["hostaway_reservation_attempts", "intent_id"], ["reconciliation_cases", "intent_id"]];
  const snap = async (iid) => { const o = {}; for (const [tb, col] of SNAP) o[tb] = (await db.owner.query(`SELECT to_jsonb(x)::text AS j FROM booking.${tb} x WHERE x.${col} = $1 ORDER BY 1`, [iid])).rows.map((r) => r.j); return o; };
  const rows = async (sql, args) => (await db.owner.query(sql, args)).rows;

  test("D2 LOCAL ELIGIBLE fixture through the REAL runner core + pinned core/helper (runtime role): verify ELIGIBLE -> execute (ONE real helper call: one admin TEST_RELEASE_REQUESTED, one pristine void, claim held) -> verify ALREADY_REQUESTED -> repeat execute ZERO calls, rows unchanged; no provider / network / cleanup", async () => {
    const realFetch = globalThis.fetch; let netAttempts = 0;
    globalThis.fetch = async () => { netAttempts += 1; throw new Error("network refused"); };
    const pool = P.createBookingPool({ connectionString: db.appUrl(), max: 2 });
    try {
      const b = await eligibleBooking();
      const i0 = await R.loadIntent(db.app, b.id);
      const att = (await rows("SELECT id::text AS id FROM booking.payment_attempts WHERE intent_id = $1 AND status = 'completed'", [b.id]))[0];
      const e = OP.buildOperatorExpectation({ intentId: b.id, expectedVersion: i0.version, listingId: 606998, from: i0.from, to: i0.to, guests: i0.guests, currency: "USD",
        finalTotalMinor: i0.price.finalTotalMinor, authorizedMinor: i0.payment.amountMinor, paymentIntentId: b.pid, sessionId: b.sid, attemptId: att.id,
        approvalRef: "local-d2-eligible-fixture" });
      assert.ok(e, "the expectation binds the fixture's real identity / payment / session / attempt");
      let helperCalls = 0;
      const ops = { classify: OP.classify, executeOperatorRelease: OP.executeOperatorRelease,
        requestTestRelease: async (...a) => { helperCalls += 1; return R.requestTestRelease(...a); } };   // the REAL pinned helper, counted
      const callsAfterFixture = b.w.calls.length;
      // (1) verify: ELIGIBLE at exactly the expected version
      const v1 = await E.runOperatorCore({ mode: "verify", expectation: e, pool, now: NOW0 + 6 * MIN, ops });
      assert.deepEqual([v1.outcome, v1.reconciled.class, v1.reconciled.code, v1.reconciled.state, v1.reconciled.version, v1.invocations],
        ["VERIFIED", "ELIGIBLE", null, "payment_authorized", e.expectedVersion, 0]);
      const before = await snap(b.id);
      // (2) execute: exactly ONE real helper invocation -> REQUESTED
      const x = await E.runOperatorCore({ mode: "execute", expectation: e, pool, now: NOW0 + 6 * MIN, ops });
      assert.deepEqual([x.phase, x.outcome, x.code, x.invocations, x.refusedInvocations, helperCalls], ["AFTER_INVOCATION", "REQUESTED", null, 1, 0, 1]);
      assert.deepEqual(x.helper, { ok: true, duplicate: false, error: null });
      assert.deepEqual([x.reconciled.class, x.reconciled.releaseActor, x.reconciled.releaseVersion, x.reconciled.releasedAtExpectedVersion, x.reconciled.voidState, x.reconciled.claimReleased],
        ["ALREADY_REQUESTED", "admin", e.expectedVersion + 1, true, "pending", false]);
      // exact DB changes: the intent row, ONE transition, ONE applied event, ONE void op; nothing else in any bound table
      const after = await snap(b.id);
      for (const tb of ["payment_ledger", "inventory_claims", "payment_attempts", "stripe_webhook_events", "hostaway_reservation_attempts", "reconciliation_cases"]) {
        assert.deepEqual(after[tb], before[tb], `${tb} unchanged by the release request`);
      }
      assert.equal(after.intent_transitions.length, before.intent_transitions.length + 1);
      assert.equal(after.intent_applied_events.length, before.intent_applied_events.length + 1);
      assert.equal(after.external_operations.length, before.external_operations.length + 1);
      const i1 = await R.loadIntent(db.app, b.id);
      assert.deepEqual([i1.status, i1.version, i1.reasonCode, i1.payment.capturedMinor], ["reservation_failed", e.expectedVersion + 1, "TEST_RELEASE_REQUESTED", 0]);
      assert.deepEqual(await rows(`SELECT version_after, from_state, to_state, event_type, event_id, reason_code, actor FROM booking.intent_transitions
        WHERE intent_id = $1 AND version_after > $2 ORDER BY version_after`, [b.id, e.expectedVersion]),
        [{ version_after: e.expectedVersion + 1, from_state: "payment_authorized", to_state: "reservation_failed", event_type: "TEST_RELEASE_REQUESTED",
          event_id: IS.testReleaseEventId(b.id, b.pid), reason_code: "TEST_RELEASE_REQUESTED", actor: "admin" }]);
      assert.deepEqual(await rows(`SELECT event_id, event_type, applied_version FROM booking.intent_applied_events WHERE intent_id = $1 AND applied_version > $2`, [b.id, e.expectedVersion]),
        [{ event_id: IS.testReleaseEventId(b.id, b.pid), event_type: "TEST_RELEASE_REQUESTED", applied_version: e.expectedVersion + 1 }]);
      assert.deepEqual(await rows(`SELECT op_type, state, attempts, dispatched_at, idempotency_key, payload ->> 'providerIdempotencyKey' AS pk, payload ->> 'paymentIntentId' AS ppi
        FROM booking.external_operations WHERE intent_id = $1 AND op_type = 'stripe.void_payment_intent'`, [b.id]),
        [{ op_type: "stripe.void_payment_intent", state: "pending", attempts: 0, dispatched_at: null, idempotency_key: `void:${b.id}:v${e.expectedVersion + 1}`,
          pk: IS.voidKey(b.id, b.pid), ppi: b.pid }]);
      assert.deepEqual(await rows("SELECT kind, (released_at IS NULL) AS held FROM booking.inventory_claims WHERE intent_id = $1", [b.id]), [{ kind: "authorized", held: true }],
        "the claim stays held pending the SEPARATE cleanup");
      assert.deepEqual(await rows("SELECT op_type FROM booking.external_operations WHERE intent_id = $1 AND (op_type LIKE 'hostaway.%' OR op_type = 'stripe.capture_payment_intent')", [b.id]), []);
      // (3) verify again: ALREADY_REQUESTED, admin, at expectedVersion + 1, pristine void, claim held (no anomaly)
      const v2 = await E.runOperatorCore({ mode: "verify", expectation: e, pool, now: NOW0 + 7 * MIN, ops });
      assert.deepEqual([v2.outcome, v2.reconciled.class, v2.reconciled.releaseActor, v2.reconciled.releasedAtExpectedVersion, v2.reconciled.voidState, v2.reconciled.voidAttempts,
        v2.reconciled.voidDispatched, v2.reconciled.claimReleased, v2.reconciled.claimAnomaly, v2.invocations],
        ["VERIFIED", "ALREADY_REQUESTED", "admin", true, "pending", 0, false, false, false, 0]);
      // (4) repeat execute: classified ALREADY_REQUESTED before any call -> ZERO helper invocations; every bound row byte-equal
      const s2 = await snap(b.id);
      const x2 = await E.runOperatorCore({ mode: "execute", expectation: e, pool, now: NOW0 + 8 * MIN, ops });
      assert.deepEqual([x2.phase, x2.outcome, x2.invocations, x2.precheck.class, helperCalls], ["BEFORE_INVOCATION", "NOT_EXECUTED_ALREADY_REQUESTED", 0, "ALREADY_REQUESTED", 1]);
      assert.deepEqual(await snap(b.id), s2, "repeat execute changed nothing");
      // no provider object touched after the fixture, no network, no cleanup
      assert.equal(b.w.calls.length, callsAfterFixture, "no SDK-shaped fixture object used by the runner / core");
      assert.equal(netAttempts, 0);
    } finally { globalThis.fetch = realFetch; await pool.end(); }
  });
}
