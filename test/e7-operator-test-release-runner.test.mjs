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
}
