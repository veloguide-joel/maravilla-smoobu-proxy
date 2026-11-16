// test/e7-hosted-kickoff.test.mjs — C111 hosted KICKOFF runner (scripts/e7-hosted-kickoff.mjs). LABELS
//   * REAL: the runner; from the PINNED tooling (E7_TOOLING_DIR, default ../../tooling = workflow layout): the env preflight, the C108 consumer
//     (runPipelineKickoffOnce / readKickoffFacts / kickoffAdmission), the C110/C111 transport (createGithubWorkflowDispatch with the release binding),
//     the kickoff plan scope / pinned revision. None of these imports pg, so this suite needs NO dependency install (the hosted preflight runs it).
//   * FAKE (always): DB (a tagged-statement fake pool), the GitHub exchange, credentials, timers. Every real network primitive is a throwing guard.
//   * OPT-IN INTEGRATION (E7_HKO_DB_TESTS=1 + PG_BIN + tooling node_modules): the REAL 0024 schema + REAL webhook authorization + REAL consumer +
//     REAL transport on a DISPOSABLE PostgreSQL with a FAKE GitHub exchange. The hosted preflight child never sets it (childEnv allowlist).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { readFileSync, realpathSync, mkdtempSync, mkdirSync, cpSync, rmSync, existsSync } from "node:fs";
import { join, dirname, normalize } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

const GUARD = { request: 0, Agent: 0, fetch: 0 };
https.request = () => { GUARD.request += 1; throw new Error("network refused"); };
https.Agent = class { constructor() { GUARD.Agent += 1; throw new Error("network refused"); } };
globalThis.fetch = async () => { GUARD.fetch += 1; throw new Error("network refused"); };
syncBuiltinESMExports();
const ROOT = realpathSync(join(dirname(fileURLToPath(import.meta.url)), ".."));
const TOOLING = realpathSync(process.env.E7_TOOLING_DIR || join(ROOT, "..", "tooling"));
const tool = (p) => import(pathToFileURL(join(TOOLING, p)).href);
const E = await import("../scripts/e7-hosted-kickoff.mjs");
const [K, T, PL, C1] = await Promise.all([tool("lib/booking-db/pipeline-kickoff.js"), tool("lib/booking-db/pipeline-dispatch-transport.js"),
  tool("lib/checkout/pipeline-kickoff-plan.js"), tool("scripts/e7-connected/probe-env-preflight.mjs")]);
after(() => { assert.deepEqual(GUARD, { request: 0, Agent: 0, fetch: 0 }, "no real network primitive was touched"); });

const C = E.CONSTANTS;
const TOOL_PIN = "c98e8b965a5556b664606110c125bf74166c2903";
const PROC = { versions: { node: "22.22.0" }, platform: "linux", execArgv: [], getuid: () => 1000 };
const SHA_A = "a".repeat(40); const SHA_B = "b".repeat(40);
const IID = "11111111-2222-4333-8444-555555555555"; const PI = "pi_3FakeKickoff0001"; const REF = "MV-FAKE0001";
const okChild = async () => ({ status: 0, signal: null, stdout: "# tests 9\n# pass 9\n# fail 0\n# skipped 0\n", truncated: false, spawnFailed: false });
const sha = (b) => createHash("sha256").update(b).digest("hex");
const OPEN = Object.freeze({ ...C, executeEnabled: true, dispatchEnabled: true, toolingStatus: "MERGED" });
/** an env that throws on ANY value read — only key enumeration is allowed (proves "key names only" gates) */
const namesOnly = (keys) => { const reads = []; const p = new Proxy(Object.fromEntries(keys.map((k) => [k, "x"])), {
  get: (t, k) => { reads.push(k); throw new Error(`value read: ${String(k)}`); }, getOwnPropertyDescriptor: (t, k) => ({ value: "x", enumerable: true, configurable: true, writable: true }) });
  return { env: p, reads }; };
const trap = (name) => async () => { throw new Error(`must not be called: ${name}`); };
const TRAPS = { spawnChild: trap("spawn"), importEnv: trap("importEnv"), importTooling: trap("importTooling"), runCore: trap("runCore"), readHead: trap("readHead"),
  readPgVersion: trap("readPg"), readCa: trap("readCa") };

// ---- a wrapper fixture whose pipeline files are bound by a SEAM constant (the real ENABLE binding is G-tested separately) -------------
function wrapperFixture() {
  const d = mkdtempSync(join(tmpdir(), "hko-w-"));
  for (const f of [...E.RUNNER_FILES, ...C.pipeline.runnerFiles]) { mkdirSync(dirname(join(d, f)), { recursive: true }); cpSync(join(ROOT, f), join(d, f)); }
  return d;
}
const boundConstants = async (wdir, over = {}) => { const b = await E.pipelineBinding(wdir); return Object.freeze({ ...OPEN, pipeline: Object.freeze({ ...C.pipeline, sourceDigest: b.sourceDigest }), ...over }); };
const realEnv = (over = {}) => ({ E7_TOOLING_DIR: TOOLING, E7_INTENT_ID: IID, E7_BOOKING_REF: REF, E7_EXPECTED_VERSION: "6", E7_PAYMENT_INTENT_ID: PI, E7_AMOUNT_MINOR: "56000",
  E7_WORKFLOW_SHA: SHA_A, GITHUB_SHA: SHA_A, GITHUB_REF: "refs/heads/main", E7_RUN_ID: "123456-1", ...over });

test("H1 SHIPPED CLOSED: executeEnabled / dispatchEnabled FALSE; verify and execute refuse HKO_EXECUTE_CLOSED from KEY NAMES only — 0 env value reads, 0 import / spawn / head / pg / CA / core", async () => {
  assert.equal(C.executeEnabled, false); assert.equal(C.dispatchEnabled, false); assert.equal(C.toolingStatus, "DRAFT_UNMERGED"); assert.equal(C.toolingCommit, TOOL_PIN);
  for (const mode of ["verify", "execute"]) {
    const { env, reads } = namesOnly(["E7_TOOLING_DIR", "E7_INTENT_ID", "E7_DEV_BOOKING_DATABASE_URL", "E7_DISPATCH_TOKEN", "GITHUB_SHA"]);
    const r = await E.runHosted({ mode, env, proc: PROC, wrapperDir: ROOT, deps: TRAPS });
    assert.deepEqual([r.exitCode, r.result.code], [1, "HKO_EXECUTE_CLOSED"], mode); assert.deepEqual(reads, [], `${mode}: no env value was read`);
  }
  // an unexpected E7_ key name is refused first, also from names only
  const { env, reads } = namesOnly(["E7_TOOLING_DIR", "E7_RESERVATION_ID"]);
  assert.equal((await E.runHosted({ mode: "preflight", env, proc: PROC, wrapperDir: ROOT, deps: TRAPS })).result.code, "HKO_INPUT_UNEXPECTED"); assert.deepEqual(reads, []);
  assert.equal((await E.runHosted({ mode: "deploy", env: {}, proc: PROC, wrapperDir: ROOT, deps: TRAPS })).result.code, "HKO_USAGE");
});

test("H2 secrets are scoped to execute: a secret NAME in preflight / verify → HKO_SECRET_SCOPE_VIOLATION before any value / import (open constants for verify)", async () => {
  for (const [mode, constants] of [["preflight", C], ["verify", OPEN]]) for (const k of E.SECRET_KEYS) {
    const { env, reads } = namesOnly(["E7_TOOLING_DIR", k]);
    const r = await E.runHosted({ mode, env, proc: PROC, wrapperDir: ROOT, deps: { ...TRAPS, constants } });
    assert.equal(r.result.code, "HKO_SECRET_SCOPE_VIOLATION", `${mode}/${k}`); assert.deepEqual(reads, []);
  }
});

test("H3 preflight (default, no env / secret / DB / install): closure digest of the PINNED tooling, pg 8.18.0 from the lockfile, own source digest, env preflight, spawned focused tests; the CLOSED main pipeline is reported NOT bound", async () => {
  const seen = {};
  const r = await E.runHosted({ mode: "preflight", env: { E7_TOOLING_DIR: TOOLING, PATH: "/usr/bin" }, proc: PROC, wrapperDir: ROOT,
    deps: { ...TRAPS, importEnv: (d) => tool("scripts/e7-connected/probe-env-preflight.mjs"), spawnChild: async (args, o) => { seen.args = args; seen.env = o.env; return okChild(); } } }).catch((e) => e);
  assert.equal(r.exitCode, 0, JSON.stringify(r.result)); assert.equal(r.result.code, "PREFLIGHT_OK_PIPELINE_NOT_BOUND");
  assert.equal(r.result.closureDigest, C.closureDigest); assert.equal(r.result.pipeline.bound, false); assert.equal(r.result.pipeline.closureDigest, C.pipeline.closureDigest);
  assert.deepEqual(seen.args, ["--test", "--test-reporter=tap", ...E.TEST_FILES]); assert.deepEqual(Object.keys(seen.env).sort(), ["E7_TOOLING_DIR", "PATH"]);
  const bad = await E.runHosted({ mode: "preflight", env: { E7_TOOLING_DIR: TOOLING }, proc: PROC, wrapperDir: ROOT,
    deps: { ...TRAPS, importEnv: () => C1, spawnChild: async () => ({ status: 1, signal: null, stdout: "# tests 3\n# pass 2\n# fail 1\n", truncated: false, spawnFailed: false }) } });
  assert.equal(bad.result.code, "HKO_TESTS_FAILED");
  const wn = await E.runHosted({ mode: "preflight", env: { E7_TOOLING_DIR: TOOLING }, proc: { ...PROC, versions: { node: "22.21.0" } }, wrapperDir: ROOT, deps: { ...TRAPS, importEnv: () => C1 } });
  assert.equal(wn.result.code, "HKO_ENV_REFUSED");
  // a tampered closure byte → refused BEFORE any tooling import
  const tdir = mkdtempSync(join(tmpdir(), "hko-t-"));
  try {
    for (const f of C.closure) { mkdirSync(dirname(join(tdir, f)), { recursive: true }); cpSync(join(TOOLING, f), join(tdir, f)); }
    const p = join(tdir, "lib/booking-db/pipeline-dispatch-transport.js"); cpSync(p, `${p}.o`); execFileSync("sh", ["-c", `printf '\\n' >> '${p}'`]);
    const t = await E.runHosted({ mode: "preflight", env: { E7_TOOLING_DIR: tdir }, proc: PROC, wrapperDir: ROOT, deps: TRAPS });
    assert.equal(t.result.code, "HKO_CLOSURE_MISMATCH");
  } finally { rmSync(tdir, { recursive: true, force: true }); }
});

test("H4 INDEPENDENT closure: a fresh import scan from the four tooling roots (consumer, transport, pool, env preflight) + package.json / package-lock.json equals CONSTANTS.closure; recomputed digest; lock pins pg 8.18.0; bare imports are node: builtins + pg only", async () => {
  const seen = new Set(); const bare = new Set(); const stack = ["lib/booking-db/pipeline-kickoff.js", "lib/booking-db/pipeline-dispatch-transport.js", "lib/booking-db/pool.js", "scripts/e7-connected/probe-env-preflight.mjs"];
  while (stack.length) {
    const f = stack.pop(); if (seen.has(f)) continue; seen.add(f);
    const src = readFileSync(join(TOOLING, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)) {
      const s = m[1] ?? m[2]; if (s.startsWith(".")) stack.push(normalize(join(dirname(f), s))); else bare.add(s);
    }
  }
  assert.deepEqual([...seen, "package.json", "package-lock.json"].sort(), [...C.closure].sort());
  assert.deepEqual([...bare].sort(), ["node:crypto", "node:https", "node:util", "pg"]);
  assert.equal(await E.framedDigest(TOOLING, C.closure, E.CLOSURE_PREFIX), C.closureDigest);
  assert.equal(E.lockedPgVersion(readFileSync(join(TOOLING, "package-lock.json"), "utf8")), "8.18.0");
  // the imported consumer scope equals the runner's reviewed scope exactly (incl. the C103 exclusion); the pinned revision is the ENABLE source
  assert.deepEqual({ cutoff: PL.KICKOFF_SCOPE.cutoff, listingId: PL.KICKOFF_SCOPE.listingId, currency: PL.KICKOFF_SCOPE.currency, excludedIntentIds: [...PL.KICKOFF_SCOPE.excludedIntentIds] },
    JSON.parse(JSON.stringify(C.scope)));
  assert.ok(C.scope.excludedIntentIds.includes("1d6e770f-ba3d-40f7-92c1-ee01be7da532"));
  assert.deepEqual([PL.PINNED_REVISION.sourceDigest, PL.PINNED_REVISION.closureDigest], [C.pipeline.sourceDigest, C.pipeline.closureDigest]);
  assert.equal(K.KICKOFF_CONSTANTS.dispatchEnabled, false); assert.equal(T.GITHUB_DISPATCH_CONSTANTS.enabled, false);
  assert.equal(typeof T.releaseBindingSnapshot, "function", "the tooling pin carries the C111 release binding");
});

test("H5 release binding from BYTES (never imported): the reviewed ENABLE revision 9455bc9e binds (source f09bcbbd…0999, closure f7d7cad6, tooling 71c3dcf8) when its objects are present; a one-byte change or the CLOSED main pipeline does not", async (t) => {
  const d = mkdtempSync(join(tmpdir(), "hko-e-"));
  try {
    let ok = true;
    try { execFileSync("git", ["-C", ROOT, "cat-file", "-e", "9455bc9ee15370b5321b7a04a96e893e9e80080b^{commit}"], { stdio: "ignore" }); } catch { ok = false; }
    if (!ok) { t.skip("ENABLE revision objects not present in this clone (shallow) — the binding logic is still covered by H6 with a seam constant"); return; }
    for (const f of C.pipeline.runnerFiles) { mkdirSync(dirname(join(d, f)), { recursive: true }); execFileSync("sh", ["-c", `git -C '${ROOT}' show 9455bc9ee15370b5321b7a04a96e893e9e80080b:'${f}' > '${join(d, f)}'`]); }
    const b = await E.pipelineBinding(d);
    assert.deepEqual([b.sourceDigest, b.closureDigest, b.toolingCommit, b.bound], [C.pipeline.sourceDigest, C.pipeline.closureDigest, C.pipeline.toolingCommit, true]);
    execFileSync("sh", ["-c", `printf ' ' >> '${join(d, C.pipeline.runnerFiles[3])}'`]);
    assert.equal((await E.pipelineBinding(d)).bound, false);
    assert.equal((await E.pipelineBinding(ROOT)).bound, false, "today's CLOSED main pipeline is not the ENABLE source");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("H6 verify / execute ORDER (open seam constants): not MERGED / no inputs / ref / GITHUB_SHA / own source / pipeline NOT bound / foreign HEAD each refuse BEFORE any secret value read, import, pg read, CA or core", async () => {
  const w = wrapperFixture();
  try {
    const bc = await boundConstants(w);
    const src = await E.framedDigest(w, E.RUNNER_FILES, E.SOURCE_PREFIX);
    const base = (over = {}) => realEnv({ E7_EXPECTED_SOURCE_DIGEST: src, ...over });
    const head = async () => SHA_A;
    const cases = [
      ["not merged", "verify", base(), { ...C, executeEnabled: true }, "HKO_CLOSURE_MISMATCH"],
      ["no inputs", "verify", { E7_TOOLING_DIR: TOOLING, E7_EXPECTED_SOURCE_DIGEST: src, E7_RUN_ID: "123456-1", GITHUB_REF: "refs/heads/main" }, bc, "HKO_INPUT_INCOMPLETE"],
      ["partial", "verify", base({ E7_AMOUNT_MINOR: "" }), bc, "HKO_INPUT_INCOMPLETE"],
      ["bad PI", "verify", base({ E7_PAYMENT_INTENT_ID: "ch_x" }), bc, "HKO_INPUT_INVALID"],
      ["C103 target", "verify", base({ E7_INTENT_ID: "1d6e770f-ba3d-40f7-92c1-ee01be7da532" }), bc, "HKO_INTENT_EXCLUDED"],
      ["historic", "verify", base({ E7_INTENT_ID: "669da884-02e8-4105-8825-f908e5d22ae9" }), bc, "HKO_INTENT_EXCLUDED"],
      ["not main", "verify", base({ GITHUB_REF: "refs/heads/feature" }), bc, "HKO_REF_NOT_MAIN"],
      ["GITHUB_SHA != E7_WORKFLOW_SHA", "verify", base({ GITHUB_SHA: SHA_B }), bc, "HKO_BINDING_MISMATCH"],
      ["own source", "verify", base({ E7_EXPECTED_SOURCE_DIGEST: "c".repeat(64) }), bc, "HKO_SOURCE_MISMATCH"],
      ["pipeline not bound (stale / closed)", "verify", base(), OPEN, "HKO_PIPELINE_NOT_BOUND"]];
    for (const [label, mode, env, constants, k] of cases) {
      const r = await E.runHosted({ mode, env, proc: PROC, wrapperDir: w, deps: { ...TRAPS, readHead: head, constants } });
      assert.equal(r.result.code, k, label);
    }
    // a foreign HEAD (checkout != github.sha) → refused before the env import; then the bound case reaches VERIFY_OK
    const fh = await E.runHosted({ mode: "verify", env: base(), proc: PROC, wrapperDir: w, deps: { ...TRAPS, readHead: async () => SHA_B, constants: bc } });
    assert.equal(fh.result.code, "HKO_BINDING_MISMATCH");
    const ok = await E.runHosted({ mode: "verify", env: base(), proc: PROC, wrapperDir: w, deps: { ...TRAPS, readHead: head, importEnv: () => C1, constants: bc } });
    assert.deepEqual([ok.exitCode, ok.result.code, ok.result.pipeline.bound], [0, "VERIFY_OK", true]);
    // execute: the secret values are read only after every binding above; a pipeline-not-bound execute reads 0 secrets
    let secretReads = 0;
    const counted = (o) => new Proxy(o, { get: (t2, k) => { if (E.SECRET_KEYS.includes(k)) secretReads += 1; return t2[k]; } });
    const nb = await E.runHosted({ mode: "execute", env: counted(base({ E7_DEV_BOOKING_DATABASE_URL: "postgresql://x", E7_DISPATCH_TOKEN: "t".repeat(40) })), proc: PROC, wrapperDir: w,
      deps: { ...TRAPS, readHead: head, constants: OPEN } });
    assert.deepEqual([nb.result.code, secretReads], ["HKO_PIPELINE_NOT_BOUND", 0]);
  } finally { rmSync(w, { recursive: true, force: true }); }
});

test("H7 execute target checks (seam constants, bound): token shape, pg version, DB target (pooler 6543 + app user only), pinned CA — each refused before any tooling import / pool / core; secrets deleted from env", async () => {
  const w = wrapperFixture();
  try {
    const bc = await boundConstants(w);
    const src = await E.framedDigest(w, E.RUNNER_FILES, E.SOURCE_PREFIX);
    const GOOD_DB = `postgresql://${encodeURIComponent("mv_booking_app_dev.mxotevtiscernhqilyiu")}:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres`;
    const CA = Buffer.from("-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n");
    const deps = { ...TRAPS, readHead: async () => SHA_A, importEnv: () => C1, readPgVersion: async () => "8.18.0", readCa: async () => CA, caSha256: sha(CA), constants: bc };
    const env = (over) => realEnv({ E7_EXPECTED_SOURCE_DIGEST: src, E7_DEV_BOOKING_DATABASE_URL: GOOD_DB, E7_DISPATCH_TOKEN: "t".repeat(40), E7_CA_FILE: "/ca", ...over });
    for (const [label, e, d, k] of [
      ["token shape", env({ E7_DISPATCH_TOKEN: "bad token" }), deps, "HKO_CREDENTIALS_MISSING"],
      ["token missing", env({ E7_DISPATCH_TOKEN: "" }), deps, "HKO_CREDENTIALS_MISSING"],
      ["pg version", env(), { ...deps, readPgVersion: async () => "8.17.0" }, "HKO_DEPENDENCY_MISMATCH"],
      ["owner user", env({ E7_DEV_BOOKING_DATABASE_URL: GOOD_DB.replace("mv_booking_app_dev", "postgres") }), deps, "HKO_DB_TARGET_INVALID"],
      ["session port", env({ E7_DEV_BOOKING_DATABASE_URL: GOOD_DB.replace(":6543/", ":5432/") }), deps, "HKO_DB_TARGET_INVALID"],
      ["foreign host", env({ E7_DEV_BOOKING_DATABASE_URL: GOOD_DB.replace("aws-0-us-east-1", "aws-0-eu-west-1") }), deps, "HKO_DB_TARGET_INVALID"],
      ["CA hash", env(), { ...deps, caSha256: "0".repeat(64) }, "HKO_CA_INVALID"]]) {
      const r = await E.runHosted({ mode: "execute", env: e, proc: PROC, wrapperDir: w, deps: d });
      assert.equal(r.result.code, k, label);
      if (label !== "token missing") assert.ok(!Object.hasOwn(e, "E7_DEV_BOOKING_DATABASE_URL") && !Object.hasOwn(e, "E7_DISPATCH_TOKEN"), `${label}: secrets removed from env`);
    }
    // all checks pass → the core receives ONLY the release binding = github.sha, the bound request, a credential FUNCTION; pool ended after
    let seen = null; let ended = 0;
    const r = await E.runHosted({ mode: "execute", env: env(), proc: PROC, wrapperDir: w, deps: { ...deps,
      importTooling: async () => ({ PINNED_REVISION: PL.PINNED_REVISION, createBookingPool: (o) => { seen = { poolOpts: { max: o.max, ca: o.caPem === CA.toString() } }; return { end: async () => { ended += 1; } }; } }),
      runCore: async (inp) => { seen.binding = inp.binding; seen.cred = typeof inp.credential; seen.worker = inp.workerId; return { outcome: "ACCEPTED_VERIFIED", verified: true }; } } });
    assert.deepEqual([r.exitCode, r.result.code, r.result.cleanup, ended], [0, "EXECUTE_DONE", "POOL_ENDED", 1]);
    assert.deepEqual(seen, { poolOpts: { max: 2, ca: true }, binding: { intentId: IID, ref: REF, expectedVersion: 6, paymentIntentId: PI, amountMinor: 56000, releaseSha: SHA_A }, cred: "function", worker: "hko:123456-1" });
    // the imported tooling must carry the ENABLE pin
    const pm = await E.runHosted({ mode: "execute", env: env(), proc: PROC, wrapperDir: w, deps: { ...deps, importTooling: async () => ({ PINNED_REVISION: { ...PL.PINNED_REVISION, sourceDigest: "f".repeat(64) } }) } });
    assert.equal(pm.result.code, "HKO_TOOLING_PIN_MISMATCH");
    // accepted-but-unverified / unknown → exit 1
    const uv = await E.runHosted({ mode: "execute", env: env(), proc: PROC, wrapperDir: w, deps: { ...deps,
      importTooling: async () => ({ PINNED_REVISION: PL.PINNED_REVISION, createBookingPool: () => ({ end: async () => {} }) }), runCore: async () => ({ outcome: "ACCEPTED_UNVERIFIED", verified: false }) } });
    assert.equal(uv.exitCode, 1);
  } finally { rmSync(w, { recursive: true, force: true }); }
});

// ---- the CORE against a FAKE pool (tagged statements) + the REAL consumer / transport ---------------------------------------------------
const MODS = Object.freeze({ runPipelineKickoffOnce: K.runPipelineKickoffOnce, readKickoffFacts: K.readKickoffFacts, kickoffAdmission: K.kickoffAdmission, KICKOFF_CONSTANTS: K.KICKOFF_CONSTANTS,
  KICKOFF_SCOPE: PL.KICKOFF_SCOPE, createGithubWorkflowDispatch: T.createGithubWorkflowDispatch, GITHUB_DISPATCH_CONSTANTS: T.GITHUB_DISPATCH_CONSTANTS, GithubExchangeError: T.GithubExchangeError,
  createGithubExchange: () => async () => { throw new Error("no exchange in the fake-pool suite"); } });
const BIND = Object.freeze({ intentId: IID, ref: REF, expectedVersion: 6, paymentIntentId: PI, amountMinor: 56000, releaseSha: SHA_A });
const SESSION_OK = { is_app: true, is_admin: false, privileged: false, owns_schema: false, tls: true, server_version_num: 160015 };
function fakePool(script = {}) {
  const st = { connects: 0, queries: [], released: [], pending: [] };
  const answer = (sql, params) => {
    const tag = (sql.match(/\/\*e7hko:([a-z]+)\*\//) || [])[1] ?? "consumer";
    st.queries.push(tag);
    if (script[tag]) return script[tag](params);
    if (tag === "session") return { rows: [SESSION_OK] };
    if (tag === "env") return { rows: [{ environment: "test" }] };
    if (tag === "fn") { const p = E.CATALOG_PINS.functions.find((f) => f.sig === params[0]); return { rows: [{ ...p }] }; }
    if (tag === "table") return { rows: [{ ...E.CATALOG_PINS.table }] };
    return { rows: [] };                                                                     // readKickoffFacts → no request
  };
  st.pool = { connect: () => { st.connects += 1; if (script.connect) return script.connect(st);
    return Promise.resolve({ query: (sql, params) => Promise.resolve(answer(sql, params)), release: (x) => st.released.push(x === true ? "destroy" : "clean") }); } };
  return st;
}
function fakeTimers() { const ts = []; return { ts, timer: (fn, ms) => { const h = { fn, ms, cleared: false }; ts.push(h); return h; }, clearTimer: (h) => { h.cleared = true; },
  fire: (ms) => { for (const h of ts.filter((x) => x.ms === ms && !x.cleared)) { h.cleared = true; h.fn(); } } }; }
const OPEN_CORE = Object.freeze({ ...C, dispatchEnabled: true });
const core = (st, over = {}) => E.runKickoffCore({ mods: MODS, pool: st.pool, binding: BIND, credential: () => { throw new Error("credential must not be read"); }, workerId: "hko:test-0001",
  constants: OPEN_CORE, tlsRequired: true, ...over });

test("K1 the core is CLOSED with the shipped constants: HKO_DISPATCH_CLOSED before ANY pool acquisition; invalid inputs / scope drift / historical binding also refuse with 0 connect", async () => {
  const st = fakePool();
  assert.deepEqual([(await core(st, { constants: C })).code, st.connects], ["HKO_DISPATCH_CLOSED", 0]);
  assert.equal((await core(st, { binding: { ...BIND, releaseSha: "main" } })).code, "CORE_INVALID");
  assert.equal((await core(st, { binding: { ...BIND, intentId: "1d6e770f-ba3d-40f7-92c1-ee01be7da532" } })).code, "HISTORICAL_TARGET");
  assert.equal((await core(st, { mods: { ...MODS, KICKOFF_SCOPE: { ...PL.KICKOFF_SCOPE, cutoff: "2026-11-01T00:00:00.000Z" } } })).code, "SCOPE_DRIFT");
  assert.equal((await core(st, { mods: { ...MODS, KICKOFF_SCOPE: { ...PL.KICKOFF_SCOPE, excludedIntentIds: PL.KICKOFF_SCOPE.excludedIntentIds.slice(0, 4) } } })).code, "SCOPE_DRIFT");
  assert.equal(st.connects, 0);
});

test("K2 admission refusals (read-only; the consumer is never invoked): foreign / admin / privileged role, no TLS, schema 23 (0024 absent), catalog / ACL drift, not test, no bound request", async () => {
  const fnMissing = (p) => ({ rows: p[0].includes("claim_pipeline_kickoff") ? [] : [{ ...E.CATALOG_PINS.functions.find((f) => f.sig === p[0]) }] });
  for (const [label, script, k] of [
    ["foreign role", { session: () => ({ rows: [{ ...SESSION_OK, is_app: false }] }) }, "ROLE_REFUSED"],
    ["admin role", { session: () => ({ rows: [{ ...SESSION_OK, is_admin: true }] }) }, "ROLE_REFUSED"],
    ["owner", { session: () => ({ rows: [{ ...SESSION_OK, owns_schema: true }] }) }, "ROLE_REFUSED"],
    ["superuser / bypassrls", { session: () => ({ rows: [{ ...SESSION_OK, privileged: true }] }) }, "ROLE_REFUSED"],
    ["no TLS", { session: () => ({ rows: [{ ...SESSION_OK, tls: false }] }) }, "TLS_REQUIRED"],
    ["PG15", { session: () => ({ rows: [{ ...SESSION_OK, server_version_num: 150010 }] }) }, "SERVER_VERSION_REFUSED"],
    ["not test", { env: () => ({ rows: [{ environment: "production" }] }) }, "NOT_TEST"],
    ["schema 23", { fn: fnMissing }, "SCHEMA_NOT_0024"],
    ["src drift", { fn: (p) => ({ rows: [{ ...E.CATALOG_PINS.functions.find((f) => f.sig === p[0]), src: "0".repeat(32) }] }) }, "CATALOG_DRIFT:0"],
    ["ACL widened", { fn: (p) => { const f = { ...E.CATALOG_PINS.functions.find((x) => x.sig === p[0]) }; if (f.sig.includes("record")) f.acl = "PUBLIC:EXECUTE"; return { rows: [f] }; } }, "CATALOG_DRIFT:3"],
    ["table writable", { table: () => ({ rows: [{ ...E.CATALOG_PINS.table, upd: true }] }) }, "CATALOG_DRIFT:TABLE"],
    ["no table", { table: () => ({ rows: [] }) }, "SCHEMA_NOT_0024"],
    ["no request", {}, "NO_BOUND_REQUEST"]]) {
    const st = fakePool(script); const r = await core(st);
    assert.deepEqual([r.outcome, r.code, r.claimed, r.gets, r.posts, r.credentialReads], ["STOP", k, false, 0, 0, 0], label);
    assert.ok(!st.queries.includes("consumer") || label === "no request", `${label}: no consumer statement`);
    assert.ok(st.released.every((x) => x === "clean"), `${label}: clients released clean`);
  }
});

test("K3 SEAL: a DB connect that never resolves → sealed at connectMs; the LATE client is destroyed unused; 0 statements, 0 credential, 0 GET / POST", async () => {
  const tm = fakeTimers(); let resolveLate;
  const st = fakePool({ connect: () => new Promise((res) => { resolveLate = res; }) });
  const p = core(st, { timer: tm.timer, clearTimer: tm.clearTimer });
  await new Promise((r) => setImmediate(r)); tm.fire(C.budgets.connectMs);
  const r = await p;
  assert.deepEqual([r.outcome, r.code, r.sealed, r.sealReason], ["STOP", "SEALED_ADMISSION:DB_CONNECT_TIMEOUT", true, "DB_CONNECT_TIMEOUT"]);
  let late = null; resolveLate({ query: () => { throw new Error("late client used"); }, release: (x) => { late = x; } });
  await new Promise((res) => setImmediate(res));
  assert.equal(late, true, "the late client was destroyed (release(true)) without any use");
  assert.deepEqual([r.dbQueries, r.gets, r.posts, r.credentialReads], [0, 0, 0, 0]);
});

test("K4 SEAL: a statement that never resolves → that client destroyed + sealed at statementMs; a later statement is refused; the wall deadline and a run abort seal the same way", async () => {
  { const tm = fakeTimers(); const st = fakePool({ session: () => new Promise(() => {}) });
    const p = core(st, { timer: tm.timer, clearTimer: tm.clearTimer }); await new Promise((r) => setImmediate(r)); tm.fire(C.budgets.statementMs);
    const r = await p; assert.deepEqual([r.code, r.sealed, r.clientsDestroyed >= 1, r.dbInFlightAtSeal], ["SEALED_ADMISSION:DB_STATEMENT_TIMEOUT", true, true, 1]);
    assert.deepEqual(st.released, ["destroy"]); }
  { const tm = fakeTimers(); const st = fakePool({ env: () => new Promise(() => {}) });
    const p = core(st, { timer: tm.timer, clearTimer: tm.clearTimer }); await new Promise((r) => setImmediate(r));
    tm.fire(C.budgets.runMs - C.budgets.teardownMs); const r = await p;
    assert.deepEqual([r.code, r.sealReason], ["SEALED_ADMISSION:DEADLINE", "DEADLINE"]); }
  { const ac = new AbortController(); ac.abort(); const st = fakePool();
    const r = await core(st, { runSignal: ac.signal }); assert.deepEqual([r.code, st.connects], ["SEALED_ADMISSION:ABORTED", 0]); }
});

test("K5 DB budget: the statement cap is enforced at the supervised boundary (a budget of 3 refuses the 4th admission statement)", async () => {
  const st = fakePool(); const r = await core(st, { constants: { ...OPEN_CORE, budgets: { ...C.budgets, dbQueries: 3 } } });
  assert.deepEqual([r.outcome, r.code.startsWith("ADMISSION_READ_FAILED"), r.dbQueries, r.dbBudgetRefused], ["STOP", true, 3, 1]);
});

test("K6 catalogRefusal + readback / summary shapes: exact pins only; summaryMarkdown carries no secret, no contact field", () => {
  const fns = E.CATALOG_PINS.functions.map((f) => ({ ...f }));
  assert.equal(E.catalogRefusal(fns, { ...E.CATALOG_PINS.table }), null);
  assert.equal(E.catalogRefusal(fns.slice(0, 6), { ...E.CATALOG_PINS.table }), "SCHEMA_NOT_0024");
  assert.equal(E.catalogRefusal(fns.map((f, i) => (i === 1 ? { ...f, secdef: false } : f)), { ...E.CATALOG_PINS.table }), "CATALOG_DRIFT:1");
  const md = E.summaryMarkdown({ mode: "execute", code: "EXECUTE_DONE", executeEnabled: false, dispatchEnabled: false, pipeline: { bound: true }, runId: "1-1", closureDigest: "c", sourceDigest: "s", cleanup: "POOL_ENDED",
    core: { outcome: "ACCEPTED_VERIFIED", code: "HANDOFF_ACCEPTED", consumerCode: "HANDOFF_ACCEPTED", gets: 1, posts: 1, verified: true, sealed: false } });
  assert.match(md, /core=ACCEPTED_VERIFIED\/HANDOFF_ACCEPTED .* gets=1 posts=1 verified=true/); assert.doesNotMatch(md, /token|postgres|@|email/i);
});

test("K7 C111 F1: a consumer result with claimed:false but an UNCERTAIN code (CLAIM_UNCERTAIN / TX_NOT_CLEAN / REFUSE_UNCERTAIN) is classified human-owned BEFORE the unclaimed STOP; 0 credential / GET / POST; the consumer is invoked exactly once", async () => {
  const FACTS = { request: { state: "requested", intent_id: IID, ref: REF, authorized_version: 6, payment_intent_id: PI, amount_minor: 56000, currency: "USD", listing_id: 606998 },
    intent: { version: 6, status: "payment_authorized", payment: { paymentIntentId: PI, amountMinor: 56000 } } };
  for (const [consumerCode, outcome] of [["CLAIM_UNCERTAIN", "CLAIM_UNCERTAIN"], ["TX_NOT_CLEAN", "CLAIM_UNCERTAIN"], ["REFUSE_UNCERTAIN", "REFUSE_UNCERTAIN"], ["REFUSED:OPEN_CASE", "REFUSED"], ["NO_REQUEST", "STOP"]]) {
    let calls = 0; const st = fakePool();
    const mods = { ...MODS, readKickoffFacts: async () => FACTS, kickoffAdmission: () => null,
      runPipelineKickoffOnce: async () => { calls += 1; return Object.freeze({ code: consumerCode, intentId: IID, claimed: false, dispatchAttempted: false, outcome: null, settled: false }); } };
    const r = await core(st, { mods });
    assert.deepEqual([r.outcome, r.code, r.claimed, calls, r.gets, r.posts, r.credentialReads], [outcome, consumerCode, false, 1, 0, 0, 0], consumerCode);
  }
  assert.deepEqual(Object.keys(E.UNCERTAIN_CONSUMER_CODES).sort(), ["CLAIM_UNCERTAIN", "REFUSE_UNCERTAIN", "TX_NOT_CLEAN"]);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// OPT-IN INTEGRATION (E7_HKO_DB_TESTS=1; tooling with its pinned pg; PG_BIN): REAL 0024 + webhook authorization + consumer + transport on a
// disposable PostgreSQL, a FAKE GitHub exchange. The hosted preflight child never sets it.
if (process.env.E7_HKO_DB_TESTS === "1") {
  const [{ startMigratedDatabase }, F, R, W, IA, FX] = await Promise.all([tool("test/db/harness.mjs"), tool("test/db/fixtures.mjs"), tool("lib/booking-db/repo.js"),
    tool("lib/checkout/stripe-test-webhook.js"), tool("lib/checkout/intent-api-core.js"), tool("test/e5a-fixtures.mjs")]);
  const db = await startMigratedDatabase();
  after(async () => { await db.close(); });
  const ACCT = FX.ENV_OK.STRIPE_TEST_ACCOUNT_ID;
  const clone = (o) => JSON.parse(JSON.stringify(o)); const sec = (ms) => Math.floor(ms / 1000);
  let seq = 0; let stayN = 0;
  const q1 = async (sql, p) => (await db.app.query(sql, p)).rows;
  const row = async (id) => (await q1("SELECT state, claim_worker, outcome_code FROM booking.pipeline_kickoff_requests WHERE intent_id = $1", [id]))[0];
  function world(now) {
    const w = { sessions: new Map(), pis: new Map() };
    const strip = (s) => { const { _pim, ...rest } = s; return clone(rest); };
    w.stripe = { accounts: { retrieve: async () => ({ object: "account", id: ACCT }) },
      checkout: { sessions: {
        create: async (params) => { const id = `cs_test_H${++seq}`; const pd = params.line_items[0].price_data;
          const s = { object: "checkout.session", id, livemode: false, mode: "payment", status: "open", payment_status: "unpaid", amount_total: pd.unit_amount, currency: pd.currency,
            client_reference_id: params.client_reference_id, metadata: { ...params.metadata }, expires_at: params.expires_at, url: `https://checkout.stripe.com/c/pay/${id}`,
            payment_intent: null, customer_details: null, _pim: params.payment_intent_data };
          w.sessions.set(id, s); return strip(s); },
        retrieve: async (id) => strip(w.sessions.get(id)) } },
      paymentIntents: { retrieve: async (id) => clone(w.pis.get(id)) } };
    w.pay = (sessionId) => { const s = w.sessions.get(sessionId); const piId = `pi_H${++seq}x`;
      s.status = "complete"; s.payment_intent = piId; s.customer_details = { email: "guest@example.invalid", name: "Guest Person" };
      w.pis.set(piId, { object: "payment_intent", id: piId, livemode: false, status: "requires_capture", capture_method: s._pim.capture_method, amount: s.amount_total,
        amount_capturable: s.amount_total, currency: s.currency, metadata: { ...s._pim.metadata },
        latest_charge: { object: "charge", id: `ch_H${seq}`, livemode: false, payment_intent: piId, captured: false, amount_captured: 0, amount_refunded: 0, status: "succeeded",
          paid: true, created: sec(now - 60000), payment_method_details: { card: { capture_before: sec(now + 6 * F.DAY), last4: "4242" } }, billing_details: { email: "guest@example.invalid" } } });
      return piId; };
    w.event = (sessionId) => ({ id: `evt_H${++seq}`, object: "event", type: "checkout.session.completed", livemode: false, created: sec(now), api_version: "2026-01-28.clover",
      data: { object: strip(w.sessions.get(sessionId)) } });
    return w;
  }
  async function authorizedFresh() {
    const created = Date.now(); const w = world(created);
    const d0 = Date.UTC(2027, 3, 4) + (++stayN) * 5 * F.DAY; const ymd = (t) => new Date(t).toISOString().slice(0, 10);
    const stay = { listingId: 606998, from: ymd(d0), to: ymd(d0 + 4 * F.DAY), guests: 2 };
    const intent = await R.createIntentRecord(db.app, { ref: F.nextRef(), accessTokenHash: F.tokenHash(), environment: "test", now: created, ...stay });
    F.ok(await R.applyEvent(db.app, intent.id, { type: "PRICE_CONFIRMED", id: `price:${intent.id}`, price: F.priceFor({ ...stay, currency: "USD" }) }, { now: created + 1000, actor: "guest" }));
    F.ok(await R.collectGuestDetails(db.app, intent.id, F.GUEST, { now: created + 2000, termsVersion: "terms-2026-10" }));
    const s = F.ok(await W.startTestCheckout(db.app, intent.id, { env: FX.ENV_OK, stripe: w.stripe, now: created + 3000, workerId: "w-pay" }));
    w.pay(s.sessionId);
    const r = await W.processVerifiedStripeEvent(db.app, w.event(s.sessionId), { stripe: w.stripe, now: created, accountId: ACCT, accountCache: {} });
    assert.equal(r.code, "APPLIED", JSON.stringify(r));
    const i = await R.loadIntent(db.app, intent.id);
    return { id: intent.id, i, bind: { intentId: intent.id, ref: i.ref, expectedVersion: i.version, paymentIntentId: i.payment.paymentIntentId, amountMinor: i.payment.amountMinor, releaseSha: SHA_A } };
  }
  const reply = (status, bytes = Buffer.alloc(0)) => Object.freeze({ status, contentType: "application/json; charset=utf-8", contentEncoding: null, bytes, complete: true });
  const refJson = (s) => Buffer.from(JSON.stringify({ ref: "refs/heads/main", node_id: "REF_x", url: "u", object: { type: "commit", sha: s, url: "u" } }));
  const TOKEN = ["synthetic", "token", "for", "tests", "only", "0000"].join("_");
  function fakeGithub(intentId, script = {}) {
    const calls = [];
    const ex = async (spec) => { calls.push({ kind: spec.kind, rowAtCall: (await row(intentId)).state, body: spec.body ? JSON.parse(spec.body.toString()) : null });
      const f = script[spec.kind] ?? (spec.kind === "getMain" ? async () => reply(200, refJson(SHA_A)) : async () => reply(204)); return f(spec); };
    ex.calls = calls; return ex;
  }
  // a pool that wraps db.app (the runtime app role) and can be scripted to hang specific statements
  const appPool = (hang = null) => ({ connect: async () => { const cl = await db.app.connect();
    return { query: (sql, p) => (hang && hang(sql) ? new Promise(() => {}) : cl.query(sql, p)), release: (x) => cl.release(x) }; } });
  const mods = (ex) => ({ ...MODS, createGithubExchange: () => ex });
  const credCount = { n: 0 };
  const run = (k, ex, over = {}) => E.runKickoffCore({ mods: mods(ex), pool: appPool(), binding: k.bind, credential: () => { credCount.n += 1; return TOKEN; }, workerId: "hko:it-0001",
    constants: OPEN_CORE, tlsRequired: false, ...over });
  /** fingerprint EVERY booking table except the kickoff table (row count + md5 of the ordered row text), as the owner */
  const fingerprint = async () => {
    const ts = (await db.owner.query("SELECT tablename FROM pg_tables WHERE schemaname = 'booking' AND tablename <> 'pipeline_kickoff_requests' ORDER BY tablename")).rows.map((x) => x.tablename);
    const out = {};
    for (const t of ts) out[t] = (await db.owner.query(`SELECT count(*)::int AS n, md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM booking.${t} x`)).rows[0];
    return out;
  };

  test("I1 REAL path: ONE bound request → admission (role / exact 0024 catalog / bindings) → owned claim COMMIT (durable 'claimed' at the GET and the POST) → release-bound GET == github.sha → ONE POST 204 → ACCEPTED_VERIFIED readback; every non-kickoff booking table unchanged; a re-run posts nothing", async () => {
    const k = await authorizedFresh(); const fp0 = await fingerprint(); const ex = fakeGithub(k.id);
    const r = await run(k, ex);
    assert.deepEqual([r.outcome, r.code, r.verified, r.claimed, r.gets, r.posts, r.credentialReads], ["ACCEPTED_VERIFIED", "HANDOFF_ACCEPTED", true, true, 1, 1, 1], JSON.stringify(r));
    assert.deepEqual(ex.calls.map((c) => [c.kind, c.rowAtCall]), [["getMain", "claimed"], ["dispatch", "claimed"]]);
    assert.deepEqual([ex.calls[1].body.ref, ex.calls[1].body.inputs.intent_id, ex.calls[1].body.inputs.payment_intent_id], ["main", k.id, k.bind.paymentIntentId]);
    assert.deepEqual(r.readback, { state: "dispatch_accepted", outcomeCode: "HANDOFF_ACCEPTED", workerMatches: true, planHashPresent: true, hasInputs: true, settled: true,
      intentStatus: "payment_authorized", intentVersion: k.bind.expectedVersion });
    assert.deepEqual(await fingerprint(), fp0, "the handoff changed no booking table except pipeline_kickoff_requests (the consumer cannot create a booking)");
    const i1 = await R.loadIntent(db.app, k.id); assert.deepEqual([i1.status, i1.reservation, i1.payment.capturedMinor], ["payment_authorized", null, 0]);
    const s = await IA.intentStatus({ pool: db.app }, k.id); assert.equal(s.body.status, "processing");
    const ex2 = fakeGithub(k.id); const r2 = await run(k, ex2);
    assert.deepEqual([r2.code, ex2.calls.length], ["NOT_PRISTINE:DISPATCH_ACCEPTED", 0], "rerun: 0 GET / POST");
  });

  test("I2 release binding: main moved (GET != github.sha) or today's CLOSED main → NOT_SENT, 0 POST; failures / late POST / timeout → UNKNOWN, exactly ONE POST, never re-posted", async () => {
    for (const [label, script, outcome, posts] of [
      ["main moved", { getMain: async () => reply(200, refJson(SHA_B)) }, "NOT_SENT", 0],
      ["closed main", { getMain: async () => reply(200, refJson("a726d8ca80ec55c4334ba1bc88e4cd7cac8aa4fb")) }, "NOT_SENT", 0],
      ["500", { dispatch: async () => reply(500, Buffer.from("{}")) }, "UNKNOWN", 1],
      ["lost reply", { dispatch: async () => { throw new T.GithubExchangeError("EXCHANGE_PREMATURE_CLOSE"); } }, "UNKNOWN", 1]]) {
      const k = await authorizedFresh(); const ex = fakeGithub(k.id, script);
      const r = await run(k, ex);
      assert.deepEqual([r.outcome, r.posts, r.verified], [outcome, posts, false], `${label}: ${JSON.stringify(r)}`);
      const ex2 = fakeGithub(k.id); const r2 = await run(k, ex2); assert.equal(ex2.calls.length, 0, `${label}: rerun 0`); assert.match(r2.code, /^NOT_PRISTINE:/);
    }
  });

  test("I3 seal around the POST: a POST that never replies → deadline seal → UNKNOWN (SEALED_AFTER_POST); a late 204 never upgrades it; the row stays claimed (human-owned), 0 retry", async () => {
    const k = await authorizedFresh(); let late204; const tm = fakeTimers();
    const ex = fakeGithub(k.id, { dispatch: () => new Promise((res) => { late204 = () => res(reply(204)); }) });
    const p = run(k, ex, { timer: tm.timer, clearTimer: tm.clearTimer });
    for (let i = 0; i < 200 && ex.calls.length < 2; i += 1) await new Promise((res) => setTimeout(res, 5));
    assert.equal(ex.calls.length, 2, "the POST started");
    tm.fire(C.budgets.runMs - C.budgets.teardownMs);
    const r = await p; late204(); await new Promise((res) => setTimeout(res, 20));
    assert.deepEqual([r.outcome, r.code.startsWith("SEALED_AFTER_POST"), r.posts, r.verified], ["UNKNOWN", true, 1, false]);
    assert.equal((await row(k.id)).state, "claimed", "never settled by a late reply; human-owned");
    const ex2 = fakeGithub(k.id); await run(k, ex2); assert.equal(ex2.calls.length, 0);
  });

  test("I4 COMMIT uncertainty: the claim COMMIT never replies → statement seal → CLAIM_UNCERTAIN, 0 GET / POST / credential; late connections destroyed", async () => {
    const k = await authorizedFresh(); const tm = fakeTimers(); const ex = fakeGithub(k.id); const c0 = credCount.n;
    let armed = false;
    const pool = appPool((sql) => { if (/claim_pipeline_kickoff/.test(sql)) armed = true; return armed && sql === "COMMIT"; });
    const p = run(k, ex, { pool, timer: tm.timer, clearTimer: tm.clearTimer });
    for (let i = 0; i < 200 && !armed; i += 1) await new Promise((res) => setTimeout(res, 5));
    await new Promise((res) => setTimeout(res, 30)); tm.fire(C.budgets.statementMs);
    const r = await p;
    assert.deepEqual([r.outcome, r.gets, r.posts, credCount.n - c0], ["CLAIM_UNCERTAIN", 0, 0, 0], JSON.stringify(r));
    assert.ok(r.clientsDestroyed >= 1);
    const st = (await row(k.id)).state; assert.ok(["requested", "claimed"].includes(st), st);
  });

  test("I5 readback failure after a 204 → ACCEPTED_UNVERIFIED (STOP), no extra POST", async () => {
    const k = await authorizedFresh(); const ex = fakeGithub(k.id);
    const pool = appPool((sql) => /e7hko:readback/.test(sql) && false);
    const pool2 = { connect: async () => { const c = await pool.connect(); return { query: (sql, p) => (/e7hko:readback/.test(sql) ? Promise.reject(new Error("readback lost")) : c.query(sql, p)), release: c.release }; } };
    const r = await run(k, ex, { pool: pool2 });
    assert.deepEqual([r.outcome, r.code, r.posts, r.verified, r.readback], ["ACCEPTED_UNVERIFIED", "READBACK_MISSING_OR_CONTRADICTORY", 1, false, null]);
    assert.equal((await row(k.id)).state, "dispatch_accepted");
  });

  test("I6 admission refusals on the REAL schema: wrong ref / version / PI / amount binding, an open case, a foreign role (report role), the owner role, and schema 23 (the claim function absent from the catalog read) → STOP with 0 GET / POST and the request untouched", async () => {
    for (const [label, mut] of [["ref", { ref: "MV-OTHER0001" }], ["version", { expectedVersion: 99 }], ["PI", { paymentIntentId: "pi_other" }], ["amount", { amountMinor: 1 }]]) {
      const k = await authorizedFresh(); const ex = fakeGithub(k.id);
      const r = await run({ ...k, bind: { ...k.bind, ...mut } }, ex);
      assert.deepEqual([r.outcome, r.code, ex.calls.length], ["STOP", "BINDING_MISMATCH", 0], label); assert.equal((await row(k.id)).state, "requested", label);
    }
    { const k = await authorizedFresh();
      await db.owner.query("INSERT INTO booking.reconciliation_cases (id, intent_id, kind, status, opened_at, opened_by) VALUES (gen_random_uuid(), $1, 'MANUAL_REVIEW', 'open', now(), 'c111-test')", [k.id]);
      assert.equal((await db.owner.query("SELECT count(*)::int AS n FROM booking.reconciliation_cases WHERE intent_id = $1 AND status = 'open'", [k.id])).rows[0].n, 1);
      const ex = fakeGithub(k.id); const r = await run(k, ex);
      assert.deepEqual([r.code, ex.calls.length, (await row(k.id)).state], ["ADMISSION:OPEN_CASE", 0, "requested"]); }
    { const k = await authorizedFresh(); const ex = fakeGithub(k.id);
      const rep = { connect: async () => { const cl = await db.owner.connect(); await cl.query("SET ROLE test_report"); return { query: (s, p) => cl.query(s, p), release: (x) => { cl.query("RESET ROLE").finally(() => cl.release(x)); } }; } };
      const r = await run(k, ex, { pool: rep }); assert.deepEqual([r.code, ex.calls.length], ["ROLE_REFUSED", 0]); }
    { const k = await authorizedFresh(); const ex = fakeGithub(k.id);
      const own = { connect: async () => { const cl = await db.owner.connect(); return { query: (s, p) => cl.query(s, p), release: (x) => cl.release(x) }; } };
      const r = await run(k, ex, { pool: own }); assert.deepEqual([r.code, ex.calls.length], ["ROLE_REFUSED", 0], "owner never admitted"); }
    { const k = await authorizedFresh(); const ex = fakeGithub(k.id);
      const s23 = { connect: async () => { const cl = await db.app.connect();
        return { query: (s, p) => (/e7hko:fn/.test(s) && /claim_pipeline_kickoff/.test(String(p && p[0])) ? cl.query("SELECT NULL::text AS sig WHERE false") : cl.query(s, p)), release: (x) => cl.release(x) }; } };
      const r = await run(k, ex, { pool: s23 }); assert.deepEqual([r.code, ex.calls.length], ["SCHEMA_NOT_0024", 0]); }
  });

  test("I7 C111 F1 — REAL consumer, claim COMMIT acknowledgement LOST after the server committed: CLAIM_UNCERTAIN, 0 credential / GET / POST, ONE claim statement (no retry); the durable row is 'claimed' (human-owned) and a rerun posts nothing", async () => {
    const k = await authorizedFresh(); const ex = fakeGithub(k.id); const c0 = credCount.n; let claims = 0; let armed = false;
    const pool = { connect: async () => { const cl = await db.app.connect();
      return { query: async (sql, p) => {
        if (/claim_pipeline_kickoff/.test(sql)) { claims += 1; armed = true; }
        if (armed && sql === "COMMIT") { armed = false; await cl.query("COMMIT"); const e = new Error("Connection terminated unexpectedly"); e.code = "ECONNRESET"; throw e; }
        return cl.query(sql, p); }, release: (x) => cl.release(x) }; } };
    const r = await run(k, ex, { pool });
    assert.deepEqual([r.outcome, r.code, r.claimed, r.gets, r.posts, credCount.n - c0, claims, ex.calls.length], ["CLAIM_UNCERTAIN", "CLAIM_UNCERTAIN", false, 0, 0, 0, 1, 0], JSON.stringify(r));
    const durable = await row(k.id);
    assert.deepEqual([durable.state, durable.claim_worker], ["claimed", "hko:it-0001"], "the COMMIT landed: durable, human-owned claim");
    const ex2 = fakeGithub(k.id); const r2 = await run(k, ex2);
    assert.deepEqual([r2.code, ex2.calls.length, r2.credentialReads], ["NOT_PRISTINE:CLAIMED", 0, 0], "no automatic retry / recovery");
  });

  test("I8 C111 F1 — REAL consumer, claim COMMIT REJECTED before the server committed: CLAIM_UNCERTAIN (never STOP), 0 credential / GET / POST, ONE claim statement; the destroyed session rolls back so the row stays 'requested'", async () => {
    const k = await authorizedFresh(); const ex = fakeGithub(k.id); const c0 = credCount.n; let claims = 0; let armed = false;
    const pool = { connect: async () => { const cl = await db.app.connect();
      return { query: async (sql, p) => {
        if (/claim_pipeline_kickoff/.test(sql)) { claims += 1; armed = true; }
        if (armed && sql === "COMMIT") { armed = false; const e = new Error("write ECONNRESET"); e.code = "ECONNRESET"; throw e; }
        return cl.query(sql, p); }, release: (x) => cl.release(x) }; } };
    const r = await run(k, ex, { pool });
    assert.deepEqual([r.outcome, r.code, r.gets, r.posts, credCount.n - c0, claims, ex.calls.length], ["CLAIM_UNCERTAIN", "CLAIM_UNCERTAIN", 0, 0, 0, 1, 0], JSON.stringify(r));
    for (let i = 0; i < 50 && (await row(k.id)).state !== "requested"; i += 1) await new Promise((res) => setTimeout(res, 10));
    assert.equal((await row(k.id)).state, "requested");
  });

  test("I9 C111 F1 — REAL consumer, its owned connection is not clean (TX_NOT_CLEAN) → CLAIM_UNCERTAIN, never STOP; 0 credential / GET / POST; nothing written", async () => {
    const k = await authorizedFresh(); const ex = fakeGithub(k.id); const c0 = credCount.n;
    const pool = { connect: async () => { const cl = await db.app.connect();
      return { query: (sql, p) => (/AS clean/.test(sql) ? Promise.resolve({ rows: [{ clean: false }] }) : cl.query(sql, p)), release: (x) => cl.release(x) }; } };
    const r = await run(k, ex, { pool });
    assert.deepEqual([r.outcome, r.code, r.gets, r.posts, credCount.n - c0], ["CLAIM_UNCERTAIN", "TX_NOT_CLEAN", 0, 0, 0], JSON.stringify(r));
    assert.equal((await row(k.id)).state, "requested");
  });
}
