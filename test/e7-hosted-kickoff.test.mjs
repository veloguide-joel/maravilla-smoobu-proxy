// test/e7-hosted-kickoff.test.mjs — C111 hosted KICKOFF runner (scripts/e7-hosted-kickoff.mjs). LABELS
//   * REAL: the runner; from the PINNED tooling (E7_TOOLING_DIR, default ../../tooling = workflow layout): the env preflight, the C108 consumer
//     (runPipelineKickoffOnce / readKickoffFacts / kickoffAdmission), the C110/C111 transport (createGithubWorkflowDispatch with the release binding),
//     the kickoff plan scope / pinned revision. None of these imports pg, so this suite needs NO dependency install (the hosted preflight runs it).
//   * FAKE (always): DB (a tagged-statement fake pool), the GitHub exchange, credentials, timers. Every real network primitive is a throwing guard.
//   * OPT-IN INTEGRATION (E7_HKO_DB_TESTS=1 + PG_BIN + tooling node_modules): the REAL 0024 schema + REAL webhook authorization + REAL consumer +
//     REAL transport on a DISPOSABLE PostgreSQL with a FAKE GitHub exchange. The hosted preflight child never sets it (childEnv allowlist).
import { test, after } from "node:test";
import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import https from "node:https";
import tls from "node:tls";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";
import { readFileSync, writeFileSync, realpathSync, mkdtempSync, mkdirSync, cpSync, rmSync, existsSync, chownSync } from "node:fs";
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
const TOOL_PIN = "4e79f26619c26954fe89c1b626e7be0e138ef383";
const PROC = { versions: { node: "22.22.0" }, platform: "linux", execArgv: [], getuid: () => 1000 };
const SHA_A = "a".repeat(40); const SHA_B = "b".repeat(40);
const IID = "11111111-2222-4333-8444-555555555555"; const PI = "pi_3FakeKickoff0001"; const REF = "MV-FAKE0001";
const okChild = async () => ({ status: 0, signal: null, stdout: "# tests 9\n# pass 9\n# fail 0\n# skipped 0\n", truncated: false, spawnFailed: false });
const sha = (b) => createHash("sha256").update(b).digest("hex");
const OPEN = Object.freeze({ ...C, executeEnabled: true, dispatchEnabled: true, toolingStatus: "MERGED" });
/** C112b: the shipped constants are the reviewed ENABLE state; CLOSED = exactly the stacked CLOSE PR's constants (seam) — refusals asserted through it */
const CLOSED = Object.freeze({ ...C, executeEnabled: false, dispatchEnabled: false });
/** a STALE pipeline pin (seam): the checkout's pipeline frame does not equal it → not bound */
const STALE = Object.freeze({ ...OPEN, pipeline: Object.freeze({ ...C.pipeline, sourceDigest: "f".repeat(64) }) });
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

test("H1 C112b ENABLE: executeEnabled / dispatchEnabled TRUE (one supervised run); the CLOSED constants (= the stacked CLOSE PR) still refuse verify and execute HKO_EXECUTE_CLOSED from KEY NAMES only — 0 env value reads, 0 import / spawn / head / pg / CA / core", async () => {
  assert.equal(C.executeEnabled, true); assert.equal(C.dispatchEnabled, true); assert.equal(C.toolingStatus, "MERGED"); assert.equal(C.toolingCommit, TOOL_PIN);
  for (const mode of ["verify", "execute"]) {
    const { env, reads } = namesOnly(["E7_TOOLING_DIR", "E7_INTENT_ID", "E7_DEV_BOOKING_DATABASE_URL", "E7_DISPATCH_TOKEN", "GITHUB_SHA"]);
    const r = await E.runHosted({ mode, env, proc: PROC, wrapperDir: ROOT, deps: { ...TRAPS, constants: CLOSED } });
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
  assert.equal(r.exitCode, 0, JSON.stringify(r.result)); assert.equal(r.result.code, "PREFLIGHT_OK_PIPELINE_BOUND", "C112b: this main carries the reviewed ENABLE pipeline source");
  assert.equal(r.result.closureDigest, C.closureDigest); assert.equal(r.result.pipeline.bound, true); assert.equal(r.result.pipeline.sourceDigest, C.pipeline.sourceDigest); assert.equal(r.result.pipeline.closureDigest, C.pipeline.closureDigest);
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

test("H5 release binding from BYTES (never imported; NO git history — runs in the hosted depth-1 checkout): the reviewed C102 ENABLE delta (fixture) maps this checkout's pipeline bytes between the CLOSED frame ce13841b and the ENABLE frame f09bcbbd exactly; the ENABLE bytes bind (closure f7d7cad6, tooling 71c3dcf8); a one-byte change does not; this checkout binds iff it carries the ENABLE source", async () => {
  const DELTA = JSON.parse(readFileSync(join(ROOT, "test/fixtures/e7-c102-pipeline-enable-delta.json"), "utf8"));
  assert.equal(DELTA.schema, "e7-c102-pipeline-enable-delta-v1"); assert.equal(DELTA.enableFrame, C.pipeline.sourceDigest);
  assert.equal(DELTA.enableCommit, "9455bc9ee15370b5321b7a04a96e893e9e80080b"); assert.ok(DELTA.ops.length > 0);
  for (const op of DELTA.ops) assert.ok(C.pipeline.runnerFiles.includes(op.file), op.file);
  const write = (dir, files) => { for (const [f, text] of Object.entries(files)) { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), text); } };
  const apply = (files, from, to) => { const out = { ...files };
    for (const op of DELTA.ops) { const t = out[op.file]; assert.equal(t.split(op[from]).length, 2, `the ${from} side occurs exactly once in ${op.file}`); out[op.file] = t.replace(op[from], () => op[to]); }
    return out; };
  const here = Object.fromEntries(C.pipeline.runnerFiles.map((f) => [f, readFileSync(join(ROOT, f), "utf8")]));
  const hereFrame = (await E.pipelineBinding(ROOT)).sourceDigest;
  assert.ok([DELTA.closedFrame, DELTA.enableFrame].includes(hereFrame), `this checkout's pipeline is the CLOSED or the ENABLE reviewed source (got ${hereFrame})`);
  const closed = hereFrame === DELTA.closedFrame ? here : apply(here, "enable", "closed");
  const enable = hereFrame === DELTA.enableFrame ? here : apply(here, "closed", "enable");
  const d = mkdtempSync(join(tmpdir(), "hko-e-")); const dc = mkdtempSync(join(tmpdir(), "hko-c-"));
  try {
    write(d, enable); write(dc, closed);
    const b = await E.pipelineBinding(d);
    assert.deepEqual([b.sourceDigest, b.closureDigest, b.toolingCommit, b.bound], [C.pipeline.sourceDigest, C.pipeline.closureDigest, C.pipeline.toolingCommit, true], "ENABLE bytes reproduce f09bcbbd and bind");
    const bc = await E.pipelineBinding(dc);
    assert.deepEqual([bc.sourceDigest, bc.bound], [DELTA.closedFrame, false], "CLOSED bytes reproduce ce13841b and do not bind");
    assert.deepEqual(apply(enable, "enable", "closed"), closed); assert.deepEqual(apply(closed, "closed", "enable"), enable);
    writeFileSync(join(d, C.pipeline.runnerFiles[3]), `${enable[C.pipeline.runnerFiles[3]]} `);
    assert.equal((await E.pipelineBinding(d)).bound, false, "a one-byte change does not bind");
    assert.equal((await E.pipelineBinding(ROOT)).bound, hereFrame === DELTA.enableFrame, "this checkout binds iff it carries the ENABLE source");
  } finally { rmSync(d, { recursive: true, force: true }); rmSync(dc, { recursive: true, force: true }); }
});

test("H6 verify / execute ORDER (open seam constants): not MERGED / no inputs / ref / GITHUB_SHA / own source / pipeline NOT bound / foreign HEAD each refuse BEFORE any secret value read, import, pg read, CA or core", async () => {
  const w = wrapperFixture();
  try {
    const bc = await boundConstants(w);
    const src = await E.framedDigest(w, E.RUNNER_FILES, E.SOURCE_PREFIX);
    const base = (over = {}) => realEnv({ E7_EXPECTED_SOURCE_DIGEST: src, ...over });
    const head = async () => SHA_A;
    const cases = [
      ["not merged (seam)", "verify", base(), { ...C, executeEnabled: true, toolingStatus: "DRAFT_UNMERGED" }, "HKO_CLOSURE_MISMATCH"],
      ["no inputs", "verify", { E7_TOOLING_DIR: TOOLING, E7_EXPECTED_SOURCE_DIGEST: src, E7_RUN_ID: "123456-1", GITHUB_REF: "refs/heads/main" }, bc, "HKO_INPUT_INCOMPLETE"],
      ["partial", "verify", base({ E7_AMOUNT_MINOR: "" }), bc, "HKO_INPUT_INCOMPLETE"],
      ["bad PI", "verify", base({ E7_PAYMENT_INTENT_ID: "ch_x" }), bc, "HKO_INPUT_INVALID"],
      ["C103 target", "verify", base({ E7_INTENT_ID: "1d6e770f-ba3d-40f7-92c1-ee01be7da532" }), bc, "HKO_INTENT_EXCLUDED"],
      ["historic", "verify", base({ E7_INTENT_ID: "669da884-02e8-4105-8825-f908e5d22ae9" }), bc, "HKO_INTENT_EXCLUDED"],
      ["not main", "verify", base({ GITHUB_REF: "refs/heads/feature" }), bc, "HKO_REF_NOT_MAIN"],
      ["GITHUB_SHA != E7_WORKFLOW_SHA", "verify", base({ GITHUB_SHA: SHA_B }), bc, "HKO_BINDING_MISMATCH"],
      ["own source", "verify", base({ E7_EXPECTED_SOURCE_DIGEST: "c".repeat(64) }), bc, "HKO_SOURCE_MISMATCH"],
      ["pipeline not bound (stale pin seam)", "verify", base(), STALE, "HKO_PIPELINE_NOT_BOUND"]];
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
      deps: { ...TRAPS, readHead: head, constants: STALE } });
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
      ["token shape", env({ E7_DISPATCH_TOKEN: "bad token" }), deps, "HKO_CREDENTIAL_FORMAT_UNSUPPORTED"],
      ["token CRLF", env({ E7_DISPATCH_TOKEN: `ghs_${"a".repeat(40)}\r\nX-Evil: 1` }), deps, "HKO_CREDENTIAL_FORMAT_UNSUPPORTED"],
      ["token oversize", env({ E7_DISPATCH_TOKEN: `ghs_${"a".repeat(2048)}` }), deps, "HKO_CREDENTIAL_FORMAT_UNSUPPORTED"],
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

// ---- C112 F1: GitHub stateless ghs_ GITHUB_TOKEN shape through the hosted credential gate + the REAL tooling transport (fake https) ----
const seg = (n, salt) => Array.from({ length: n }, (_, i) => "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_"[(i * 7 + salt) % 38]).join("");
const NEW_TOKEN = `ghs_${seg(36, 1)}.${seg(380, 3)}.${seg(98, 5)}`;                     // synthetic, shape-only (~520 chars, 2 dots); never a credential
function fakeHttps(sha) {
  const log = { requests: [] };
  class Agent { constructor() { this.destroyed = false; } destroy() { this.destroyed = true; } }
  const request = (opts) => { const req = new EventEmitter(); req.opts = opts; req.end = () => setImmediate(() => {
      const res = new EventEmitter(); res.statusCode = opts.method === "GET" ? 200 : 204; res.headers = opts.method === "GET" ? { "content-type": "application/json; charset=utf-8" } : {};
      res.destroy = () => {}; req.emit("response", res);
      if (opts.method === "GET") res.emit("data", Buffer.from(JSON.stringify({ ref: "refs/heads/main", node_id: "REF_x", url: "u", object: { type: "commit", sha, url: "u" } })));
      res.emit("end"); res.emit("close"); });
    req.destroy = () => {}; log.requests.push(req); return req; };
  return { primitive: { request, Agent }, log };
}

test("H8 C112-F1 credential gate: the runner's token rule == the tooling transport's githubTokenRefusal on every sample; a stateless ghs_ token (~520 chars, dots, hyphens) passes the hosted execute gate and the REAL transport sends it opaquely as the exact Bearer header (fake https); missing → HKO_CREDENTIALS_MISSING, unsupported → HKO_CREDENTIAL_FORMAT_UNSUPPORTED; no token-derived byte in any result", async () => {
  const samples = ["", "a".repeat(19), "a".repeat(20), "synthetic_token_for_tests_only_0000", `ghs_${"a".repeat(36)}`, NEW_TOKEN, `${NEW_TOKEN} `, `${NEW_TOKEN}\r\n`, `ghs_${"a".repeat(2044)}`,
    `ghs_${"a".repeat(2045)}`, `gho_${seg(40, 1)}.${seg(40, 2)}`, `ghs_${seg(40, 1)}+`, `ghs_${seg(40, 1)}=`, "ghs_ab.cd", `Bearer ${NEW_TOKEN}`, `ghs_${seg(40, 1)}é`];
  for (const t of samples) assert.equal(E.tokenShapeOk(t), T.githubTokenRefusal(t) === null, `parity: ${t.length}`);
  assert.equal(E.TOKEN_MAX_LENGTH, T.TOKEN_MAX_LENGTH);
  const w = wrapperFixture();
  try {
    const bc = await boundConstants(w);
    const src = await E.framedDigest(w, E.RUNNER_FILES, E.SOURCE_PREFIX);
    const GOOD_DB = `postgresql://${encodeURIComponent("mv_booking_app_dev.mxotevtiscernhqilyiu")}:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres`;
    const CA = Buffer.from("-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n");
    const base = { ...TRAPS, readHead: async () => SHA_A, importEnv: () => C1, readPgVersion: async () => "8.18.0", readCa: async () => CA, caSha256: sha(CA), constants: bc };
    const env = (tok) => realEnv({ E7_EXPECTED_SOURCE_DIGEST: src, E7_DEV_BOOKING_DATABASE_URL: GOOD_DB, E7_DISPATCH_TOKEN: tok, E7_CA_FILE: "/ca" });
    let seen = null;
    const https = fakeHttps(SHA_A);
    const r = await E.runHosted({ mode: "execute", env: env(NEW_TOKEN), proc: PROC, wrapperDir: w, deps: { ...base,
      importTooling: async () => ({ PINNED_REVISION: PL.PINNED_REVISION, createBookingPool: () => ({ end: async () => {} }) }),
      runCore: async (inp) => {
        const d = T.createGithubWorkflowDispatch({ credential: inp.credential, constants: Object.freeze({ ...T.GITHUB_DISPATCH_CONSTANTS, enabled: true }),
          exchange: T.createGithubExchange({ primitive: https.primitive }), releaseBinding: { expectedMainSha: inp.binding.releaseSha } });
        const call = Object.freeze({ workflow: "e7-hosted-pipeline.yml", ref: "main", inputs: PL.kickoffDispatch({ intentId: inp.binding.intentId, ref: inp.binding.ref,
          authorizedVersion: inp.binding.expectedVersion, paymentIntentId: inp.binding.paymentIntentId, amountMinor: inp.binding.amountMinor, currency: "USD", listingId: 606998,
          notBefore: "2026-11-16T13:55:15.000Z" }).inputs });
        seen = await d(call, { signal: new AbortController().signal });
        return { outcome: seen.accepted ? "ACCEPTED_VERIFIED" : "STOP", verified: seen.accepted === true, code: "SYNTHETIC" };
      } } });
    assert.deepEqual(seen, { accepted: true }); assert.equal(r.exitCode, 0);
    assert.equal(https.log.requests.length, 2); assert.ok(https.log.requests.every((q) => q.opts.headers.Authorization === `Bearer ${NEW_TOKEN}`), "opaque pass-through");
    const out = JSON.stringify(r.result) + E.summaryMarkdown(r.result);
    for (const piece of [NEW_TOKEN, NEW_TOKEN.slice(4, 24), NEW_TOKEN.split(".")[1].slice(0, 16), String(NEW_TOKEN.length)]) assert.ok(!out.includes(piece), "no token-derived bytes / length in the result");
    for (const [tok, code] of [["", "HKO_CREDENTIALS_MISSING"], [`${NEW_TOKEN}\n`, "HKO_CREDENTIAL_FORMAT_UNSUPPORTED"], [`ghs_${"Q".repeat(2048)}`, "HKO_CREDENTIAL_FORMAT_UNSUPPORTED"],
      [`ghs_${seg(40, 1)}=`, "HKO_CREDENTIAL_FORMAT_UNSUPPORTED"]]) {
      const x = await E.runHosted({ mode: "execute", env: env(tok), proc: PROC, wrapperDir: w, deps: base });
      assert.equal(x.result.code, code); assert.ok(tok === "" || !JSON.stringify(x.result).includes(tok.slice(4, 20)));
    }
  } finally { rmSync(w, { recursive: true, force: true }); }
});

// ---- the CORE against a FAKE pool (tagged statements) + the REAL consumer / transport ---------------------------------------------------
const MODS = Object.freeze({ runPipelineKickoffOnce: K.runPipelineKickoffOnce, readKickoffFacts: K.readKickoffFacts, kickoffAdmission: K.kickoffAdmission, KICKOFF_CONSTANTS: K.KICKOFF_CONSTANTS,
  KICKOFF_SCOPE: PL.KICKOFF_SCOPE, createGithubWorkflowDispatch: T.createGithubWorkflowDispatch, GITHUB_DISPATCH_CONSTANTS: T.GITHUB_DISPATCH_CONSTANTS, GithubExchangeError: T.GithubExchangeError,
  createGithubExchange: () => async () => { throw new Error("no exchange in the fake-pool suite"); } });
const BIND = Object.freeze({ intentId: IID, ref: REF, expectedVersion: 6, paymentIntentId: PI, amountMinor: 56000, releaseSha: SHA_A });
const SESSION_OK = { is_app: true, is_admin: false, privileged: false, owns_schema: false, tls: true, server_version_num: 160015 };
/** C112: FAKE client-hop evidence (test-only shape of a pg client: connection.stream is a node:tls TLSSocket-prototyped object; host; ssl config) */
const FAKE_CA = "-----BEGIN CERTIFICATE-----\nE7-FAKE-FIXTURE-CA\n-----END CERTIFICATE-----\n";
const TLS_POL = Object.freeze({ host: C.tls.host, caSha256: sha(FAKE_CA) });
function fakeTlsSocket(over = {}) {
  const s = Object.create(tls.TLSSocket.prototype);
  const d = { encrypted: true, destroyed: false, readyState: "open", authorized: true, authorizationError: null, isSessionReused: () => false, getProtocol: () => "TLSv1.3",
    getPeerCertificate: () => ({ subject: { CN: C.tls.host }, subjectaltname: `DNS:${C.tls.host}` }), ...over };
  for (const [k, v] of Object.entries(d)) Object.defineProperty(s, k, { value: v, enumerable: true });
  return s;
}
const withTls = (base, sock = {}, cfg = {}, host = C.tls.host) => Object.assign(base, { connection: { stream: fakeTlsSocket(sock) }, host, ssl: { rejectUnauthorized: true, ca: FAKE_CA, ...cfg } });
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
    const base = { query: (sql, params) => Promise.resolve(answer(sql, params)), release: (x) => st.released.push(x === true ? "destroy" : "clean") };
    return Promise.resolve(script.client ? script.client(base, st) : withTls(base)); } };
  return st;
}
function fakeTimers() { const ts = []; return { ts, timer: (fn, ms) => { const h = { fn, ms, cleared: false }; ts.push(h); return h; }, clearTimer: (h) => { h.cleared = true; },
  fire: (ms) => { for (const h of ts.filter((x) => x.ms === ms && !x.cleared)) { h.cleared = true; h.fn(); } } }; }
const OPEN_CORE = Object.freeze({ ...C, dispatchEnabled: true, tls: TLS_POL });
const core = (st, over = {}) => E.runKickoffCore({ mods: MODS, pool: st.pool, binding: BIND, credential: () => { throw new Error("credential must not be read"); }, workerId: "hko:test-0001",
  constants: OPEN_CORE, ...over });

test("K1 the core is CLOSED with the CLOSED constants (= the stacked CLOSE PR; C112b ships dispatchEnabled TRUE): HKO_DISPATCH_CLOSED before ANY pool acquisition; invalid inputs / scope drift / historical binding also refuse with 0 connect", async () => {
  const st = fakePool();
  assert.equal(C.dispatchEnabled, true);
  assert.deepEqual([(await core(st, { constants: CLOSED })).code, st.connects], ["HKO_DISPATCH_CLOSED", 0]);
  assert.equal((await core(st, { binding: { ...BIND, releaseSha: "main" } })).code, "CORE_INVALID");
  assert.equal((await core(st, { binding: { ...BIND, intentId: "1d6e770f-ba3d-40f7-92c1-ee01be7da532" } })).code, "HISTORICAL_TARGET");
  assert.equal((await core(st, { mods: { ...MODS, KICKOFF_SCOPE: { ...PL.KICKOFF_SCOPE, cutoff: "2026-11-01T00:00:00.000Z" } } })).code, "SCOPE_DRIFT");
  assert.equal((await core(st, { mods: { ...MODS, KICKOFF_SCOPE: { ...PL.KICKOFF_SCOPE, excludedIntentIds: PL.KICKOFF_SCOPE.excludedIntentIds.slice(0, 4) } } })).code, "SCOPE_DRIFT");
  assert.equal(st.connects, 0);
});

test("K2 admission refusals (read-only; the consumer is never invoked): foreign / admin / privileged role, backend hop not SSL, schema 23 (0024 absent), catalog / ACL drift, not test, no bound request", async () => {
  const fnMissing = (p) => ({ rows: p[0].includes("claim_pipeline_kickoff") ? [] : [{ ...E.CATALOG_PINS.functions.find((f) => f.sig === p[0]) }] });
  for (const [label, script, k] of [
    ["foreign role", { session: () => ({ rows: [{ ...SESSION_OK, is_app: false }] }) }, "ROLE_REFUSED"],
    ["admin role", { session: () => ({ rows: [{ ...SESSION_OK, is_admin: true }] }) }, "ROLE_REFUSED"],
    ["owner", { session: () => ({ rows: [{ ...SESSION_OK, owns_schema: true }] }) }, "ROLE_REFUSED"],
    ["superuser / bypassrls", { session: () => ({ rows: [{ ...SESSION_OK, privileged: true }] }) }, "ROLE_REFUSED"],
    ["backend hop not SSL (server-reported)", { session: () => ({ rows: [{ ...SESSION_OK, tls: false }] }) }, "TLS_REQUIRED:BACKEND_HOP"],
    ["backend hop unknown (NULL)", { session: () => ({ rows: [{ ...SESSION_OK, tls: null }] }) }, "TLS_REQUIRED:BACKEND_HOP"],
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

test("K8 C112 CLIENT hop: EVERY acquired client needs its OWN live, authorized TLS socket (pinned CA, rejectUnauthorized, hostname re-checked) BEFORE its first statement — each defect → STOP TLS_REQUIRED:CLIENT_<reason>, client destroyed unused, sealed, 0 statements / consumer / credential / GET / POST; there is no opt-out", async () => {
  assert.deepEqual({ ...C.tls }, { host: "aws-0-us-east-1.pooler.supabase.com", caSha256: E.OFFICIAL_CA_SHA256 }, "client-hop identity == the reviewed pooler host + OFFICIAL CA");
  assert.ok(E.dbTargetOk(`postgresql://mv_booking_app_dev.${C.dbProjectRef}:x@${C.tls.host}:6543/postgres`), "the TLS host is the only admitted DB target host");
  const plainSock = new net.Socket();
  const cases = [
    ["no evidence", (b) => b, "NO_EVIDENCE"],
    ["plain net.Socket", (b) => Object.assign(withTls(b), { connection: { stream: plainSock } }), "NOT_TLS"],
    ["not encrypted", (b) => withTls(b, { encrypted: false }), "NOT_TLS"],
    ["destroyed", (b) => withTls(b, { destroyed: true }), "DISCONNECTED"],
    ["not open", (b) => withTls(b, { readyState: "readOnly" }), "DISCONNECTED"],
    ["unauthorized", (b) => withTls(b, { authorized: false, authorizationError: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" }), "UNAUTHORIZED"],
    ["authorized with an error", (b) => withTls(b, { authorizationError: "X" }), "UNAUTHORIZED"],
    ["resumed session (identity check skipped)", (b) => withTls(b, { isSessionReused: () => true }), "SESSION_REUSED"],
    ["TLSv1.1", (b) => withTls(b, { getProtocol: () => "TLSv1.1" }), "PROTOCOL"],
    ["no peer certificate", (b) => withTls(b, { getPeerCertificate: () => ({}) }), "NO_PEER_CERT"],
    ["certificate for another host", (b) => withTls(b, { getPeerCertificate: () => ({ subject: { CN: "evil.example" }, subjectaltname: "DNS:evil.example" }) }), "HOSTNAME_MISMATCH"],
    ["client host differs", (b) => withTls(b, {}, {}, "db.other.example"), "HOST_MISMATCH"],
    ["rejectUnauthorized false", (b) => withTls(b, {}, { rejectUnauthorized: false }), "CONFIG_NOT_PINNED"],
    ["CA not pinned", (b) => withTls(b, {}, { ca: FAKE_CA + "x" }), "CONFIG_NOT_PINNED"],
    ["custom identity callback", (b) => withTls(b, {}, { checkServerIdentity: () => undefined }), "CONFIG_NOT_PINNED"],
    ["evidence getter throws", (b) => withTls(b, { getPeerCertificate: () => { throw new Error("x"); } }), "EVIDENCE_ERROR"]];
  for (const [label, mk, why] of cases) {
    const st = fakePool({ client: (b) => mk(b) });
    const r = await core(st, { tlsRequired: false });                                   // a stray opt-out key has NO effect
    assert.deepEqual([r.outcome, r.code, r.tlsClientRefusal, r.tlsClientChecks, r.tlsClientVerified, r.dbQueries, r.sealed, r.sealReason],
      ["STOP", `TLS_REQUIRED:CLIENT_${why}`, why, 1, 0, 0, true, "TLS_CLIENT_UNVERIFIED"], label);
    assert.deepEqual([st.queries, st.released, r.backendSsl, r.claimed, r.gets, r.posts, r.credentialReads], [[], ["destroy"], null, false, 0, 0, 0], label);
    assert.equal(E.clientTlsRefusal(mk({ query() {}, release() {} }), TLS_POL), why, `${label}: exported predicate`);
  }
  assert.equal(E.clientTlsRefusal(withTls({}), TLS_POL), null);
  assert.equal(E.clientTlsRefusal(withTls({}), { host: C.tls.host }), "POLICY_INVALID");
});

test("K9 C112 BACKEND hop is still REQUIRED and labelled separately: a VERIFIED client whose server-reported pg_stat_ssl.ssl is false (the shared pooler's pooler→Postgres hop) → STOP TLS_REQUIRED:BACKEND_HOP after exactly the session statement; the client evidence never substitutes for it", async () => {
  const st = fakePool({ session: () => ({ rows: [{ ...SESSION_OK, tls: false }] }) });
  const r = await core(st);
  assert.deepEqual([r.outcome, r.code, r.backendSsl, r.tlsClientChecks, r.tlsClientVerified, r.tlsClientRefusal, r.dbQueries, st.queries],
    ["STOP", "TLS_REQUIRED:BACKEND_HOP", false, 1, 1, null, 1, ["session"]]);
  const ok = fakePool(); const r2 = await core(ok);
  assert.deepEqual([r2.code, r2.backendSsl, r2.tlsClientChecks === r2.tlsClientVerified, r2.tlsClientChecks, r2.tlsClientRefusal], ["NO_BOUND_REQUEST", true, true, r2.dbQueries, null],
    "one verified client per acquisition; admission proceeds only with BOTH hops");
});

test("K10 C112 the CONSUMER's own acquisition is checked too: an unverified client handed to the consumer before its claim → STOP TLS_REQUIRED:CLIENT_<reason>; sealed; no claim / credential / GET / POST; the client destroyed unused", async () => {
  const FACTS = { request: { state: "requested", intent_id: IID, ref: REF, authorized_version: 6, payment_intent_id: PI, amount_minor: 56000, currency: "USD", listing_id: 606998 },
    intent: { version: 6, status: "payment_authorized", payment: { paymentIntentId: PI, amountMinor: 56000 } } };
  let consumerPhase = false; let consumerSaw = null; let calls = 0;
  const st = fakePool({ client: (b) => (consumerPhase ? withTls(b, { authorized: false, authorizationError: "CERT_HAS_EXPIRED" }) : withTls(b)) });
  const mods = { ...MODS, readKickoffFacts: async () => FACTS, kickoffAdmission: () => { consumerPhase = true; return null; },
    runPipelineKickoffOnce: async (pool, o) => { calls += 1;
      try { const c = await pool.connect(); await o.hooks.beforeClaim(); c.release(); } catch (e) { consumerSaw = e && e.code; }
      return Object.freeze({ code: "CONNECT_FAILED", intentId: IID, claimed: false, dispatchAttempted: false, outcome: null, settled: false }); } };
  const r = await core(st, { mods });
  await new Promise((res) => setImmediate(res));                                           // the core returned at the seal; the consumer's connect then rejected
  assert.deepEqual([r.outcome, r.code, calls, consumerSaw, r.claimed, r.sealed, r.gets, r.posts, r.credentialReads, r.tlsClientRefusal],
    ["STOP", "TLS_REQUIRED:CLIENT_UNAUTHORIZED", 1, "TLS_REQUIRED:CLIENT_UNAUTHORIZED", false, true, 0, 0, 0, "UNAUTHORIZED"]);
  assert.equal(st.released.at(-1), "destroy"); assert.ok(!st.queries.includes("consumer"));
});

// ---------------------------------------------------------------------------------------------------------------------------------
// OPT-IN INTEGRATION (E7_HKO_DB_TESTS=1; tooling with its pinned pg; PG_BIN): REAL 0024 + webhook authorization + consumer + transport on a
// disposable PostgreSQL, a FAKE GitHub exchange. The hosted preflight child never sets it.
if (process.env.E7_HKO_DB_TESTS === "1") {
  const [{ startMigratedDatabase }, F, R, W, IA, FX] = await Promise.all([tool("test/db/harness.mjs"), tool("test/db/fixtures.mjs"), tool("lib/booking-db/repo.js"),
    tool("lib/checkout/stripe-test-webhook.js"), tool("lib/checkout/intent-api-core.js"), tool("test/e5a-fixtures.mjs")]);
  const db = await startMigratedDatabase();
  after(async () => { await db.close(); });
  // ---- C112 REAL TLS fixtures (disposable): a throwaway CA + leaf certificates (openssl), server SSL on the disposable cluster, and a
  // pooler-shaped proxy (accepts the PG SSLRequest, terminates the CLIENT hop with its own certificate, then opens the BACKEND hop to
  // Postgres either over verified TLS — the shared pooler with "Enforce SSL" ON — or in plaintext — the pooler with it OFF).
  // built LAZILY inside the first DB test (ready()): a long top-level await would let the root test finish and run the after() hooks early
  let pg, fx, proxies, itApp, itOwner, OPEN_IT, VERIFIED; const pools = []; let readyP = null;
  const buildFx = () => {
    const d = mkdtempSync(join(tmpdir(), "hko-tls-"));
    const ossl = (...a) => execFileSync("openssl", a, { cwd: d, stdio: ["ignore", "ignore", "pipe"] });
    const ca = (n) => { ossl("req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", `${n}.key`, "-out", `${n}.pem`, "-days", "2",
      "-subj", `/CN=e7-hko-${n}`, "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"); };
    const leaf = (n, cn, issuer) => {
      ossl("req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", `${n}.key`, "-out", `${n}.csr`, "-subj", `/CN=${cn}`);
      writeFileSync(join(d, `${n}.ext`), `subjectAltName=DNS:${cn}\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n`);
      ossl("x509", "-req", "-in", `${n}.csr`, "-CA", `${issuer}.pem`, "-CAkey", `${issuer}.key`, "-CAcreateserial", "-out", `${n}.pem`, "-days", "2", "-extfile", `${n}.ext`); };
    ca("ca1"); ca("ca2"); leaf("good", "localhost", "ca1"); leaf("wronghost", "wronghost.invalid", "ca1"); leaf("foreign", "localhost", "ca2");
    const rd = (f) => readFileSync(join(d, f), "utf8");
    return { dir: d, ca1: rd("ca1.pem"), ca2: rd("ca2.pem"), good: { key: rd("good.key"), cert: rd("good.pem") },
      wronghost: { key: rd("wronghost.key"), cert: rd("wronghost.pem") }, foreign: { key: rd("foreign.key"), cert: rd("foreign.pem") } };
  };
  after(() => { if (fx) rmSync(fx.dir, { recursive: true, force: true }); });
  const serverSsl = async () => { // server SSL on the disposable cluster (key readable by its OS user only), reloaded — the BACKEND hop can now be verified TLS
    const sd = mkdtempSync(join(tmpdir(), "hko-pgssl-"));
    writeFileSync(join(sd, "server.crt"), fx.good.cert); writeFileSync(join(sd, "server.key"), fx.good.key, { mode: 0o600 });
    if (process.getuid && process.getuid() === 0) { const u = Number(execFileSync("id", ["-u", "postgres"]).toString()); const g = Number(execFileSync("id", ["-g", "postgres"]).toString());
      for (const f of ["", "server.crt", "server.key"]) chownSync(join(sd, f), u, g); }
    await db.owner.query(`ALTER SYSTEM SET ssl_cert_file = '${join(sd, "server.crt")}'`); await db.owner.query(`ALTER SYSTEM SET ssl_key_file = '${join(sd, "server.key")}'`);
    await db.owner.query("ALTER SYSTEM SET ssl = on"); await db.owner.query("SELECT pg_reload_conf()"); await new Promise((res) => setTimeout(res, 300));
    after(() => { rmSync(sd, { recursive: true, force: true }); });
  };
  const SSL_REQUEST = Buffer.from([0, 0, 0, 8, 0x04, 0xd2, 0x16, 0x2f]);
  /** pooler-shaped proxy: front "tls" (SSLRequest → 'S' → TLS with `cert`) | "plain"; back "tls" (SSLRequest → verified TLS to PG) | "plain" */
  async function startProxy({ front, back, cert = fx.good }) {
    const socks = new Set();
    const backLeg = () => new Promise((resolve, reject) => {
      const up = net.connect(db.port, "127.0.0.1"); socks.add(up); up.once("error", reject);
      if (back === "plain") { up.once("connect", () => resolve(up)); return; }
      up.once("connect", () => up.write(SSL_REQUEST));
      up.once("data", (b) => { if (b.toString() !== "S") { reject(new Error("backend refused SSL")); return; }
        const t = tls.connect({ socket: up, ca: fx.ca1, servername: "localhost", rejectUnauthorized: true }); socks.add(t);
        t.once("secureConnect", () => resolve(t)); t.once("error", reject); });
    });
    const server = net.createServer((sock) => {
      socks.add(sock); sock.on("error", () => {});
      const wire = (fr) => { fr.pause(); backLeg().then((up) => { up.on("error", () => fr.destroy()); fr.on("error", () => up.destroy());
        fr.pipe(up); up.pipe(fr); fr.resume(); }, () => fr.destroy()); };
      if (front === "plain") { wire(sock); return; }
      sock.once("data", (b) => {
        if (!b.equals(SSL_REQUEST)) { sock.destroy(); return; }
        const t = new tls.TLSSocket(sock, { isServer: true, key: cert.key, cert: cert.cert }); socks.add(t); t.on("error", () => {});
        sock.write("S"); t.once("secure", () => wire(t));
      });
    });
    await new Promise((res) => server.listen(0, "127.0.0.1", res));
    return { port: server.address().port, close: () => new Promise((res) => { for (const x of socks) x.destroy(); server.close(() => res()); }) };
  }
  const tlsPool = (port, user = "test_app", ssl = undefined, host = "localhost") => { const p = new pg.Pool({ host, port, user, database: "postgres", ssl: ssl === undefined ? VERIFIED : ssl, max: 8 }); pools.push(p); return p; };
  after(async () => { for (const p of pools) await p.end().catch(() => {}); for (const x of Object.values(proxies ?? {})) await x.close(); });
  const ready = () => (readyP ??= (async () => {
    pg = (await tool("node_modules/pg/lib/index.js")).default; fx = buildFx(); await serverSsl();
    proxies = { both: await startProxy({ front: "tls", back: "tls" }), offBack: await startProxy({ front: "tls", back: "plain" }),
      plainFront: await startProxy({ front: "plain", back: "tls" }), wronghost: await startProxy({ front: "tls", back: "tls", cert: fx.wronghost }),
      foreign: await startProxy({ front: "tls", back: "tls", cert: fx.foreign }) };
    VERIFIED = Object.freeze({ rejectUnauthorized: true, ca: fx.ca1 });
    itApp = tlsPool(proxies.both.port); itOwner = tlsPool(proxies.both.port, "postgres");
    OPEN_IT = Object.freeze({ ...OPEN_CORE, tls: Object.freeze({ host: "localhost", caSha256: sha(fx.ca1) }) });
  })());
  /** every DB test first awaits the lazily built TLS fixtures */
  const itest = (name, fn) => test(name, async () => { await ready(); return fn(); });
  /** a test wrapper exposes the REAL acquired client's evidence (its own socket, host, ssl config) — never synthesized */
  const ev = (cl, w) => Object.assign(w, { connection: cl.connection, host: cl.host, ssl: cl.ssl });
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
  const appPool = (hang = null) => ({ connect: async () => { const cl = await itApp.connect();
    return ev(cl, { query: (sql, p) => (hang && hang(sql) ? new Promise(() => {}) : cl.query(sql, p)), release: (x) => cl.release(x) }); } });
  const mods = (ex) => ({ ...MODS, createGithubExchange: () => ex });
  const credCount = { n: 0 };
  const run = (k, ex, over = {}) => E.runKickoffCore({ mods: mods(ex), pool: appPool(), binding: k.bind, credential: () => { credCount.n += 1; return TOKEN; }, workerId: "hko:it-0001",
    constants: OPEN_IT, ...over });
  /** fingerprint EVERY booking table except the kickoff table (row count + md5 of the ordered row text), as the owner */
  const fingerprint = async () => {
    const ts = (await db.owner.query("SELECT tablename FROM pg_tables WHERE schemaname = 'booking' AND tablename <> 'pipeline_kickoff_requests' ORDER BY tablename")).rows.map((x) => x.tablename);
    const out = {};
    for (const t of ts) out[t] = (await db.owner.query(`SELECT count(*)::int AS n, md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM booking.${t} x`)).rows[0];
    return out;
  };

  itest("I1 REAL path: ONE bound request → admission (role / exact 0024 catalog / bindings) → owned claim COMMIT (durable 'claimed' at the GET and the POST) → release-bound GET == github.sha → ONE POST 204 → ACCEPTED_VERIFIED readback; every non-kickoff booking table unchanged; a re-run posts nothing", async () => {
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

  itest("I2 release binding: main moved (GET != github.sha) or today's CLOSED main → NOT_SENT, 0 POST; failures / late POST / timeout → UNKNOWN, exactly ONE POST, never re-posted", async () => {
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

  itest("I3 seal around the POST: a POST that never replies → deadline seal → UNKNOWN (SEALED_AFTER_POST); a late 204 never upgrades it; the row stays claimed (human-owned), 0 retry", async () => {
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

  itest("I4 COMMIT uncertainty: the claim COMMIT never replies → statement seal → CLAIM_UNCERTAIN, 0 GET / POST / credential; late connections destroyed", async () => {
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

  itest("I5 readback failure after a 204 → ACCEPTED_UNVERIFIED (STOP), no extra POST", async () => {
    const k = await authorizedFresh(); const ex = fakeGithub(k.id);
    const pool = appPool((sql) => /e7hko:readback/.test(sql) && false);
    const pool2 = { connect: async () => { const c = await pool.connect(); return ev(c, { query: (sql, p) => (/e7hko:readback/.test(sql) ? Promise.reject(new Error("readback lost")) : c.query(sql, p)), release: c.release }); } };
    const r = await run(k, ex, { pool: pool2 });
    assert.deepEqual([r.outcome, r.code, r.posts, r.verified, r.readback], ["ACCEPTED_UNVERIFIED", "READBACK_MISSING_OR_CONTRADICTORY", 1, false, null]);
    assert.equal((await row(k.id)).state, "dispatch_accepted");
  });

  itest("I6 admission refusals on the REAL schema: wrong ref / version / PI / amount binding, an open case, a foreign role (report role), the owner role, and schema 23 (the claim function absent from the catalog read) → STOP with 0 GET / POST and the request untouched", async () => {
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
      const rep = { connect: async () => { const cl = await itOwner.connect(); await cl.query("SET ROLE test_report"); return ev(cl, { query: (s, p) => cl.query(s, p), release: (x) => { cl.query("RESET ROLE").finally(() => cl.release(x)); } }); } };
      const r = await run(k, ex, { pool: rep }); assert.deepEqual([r.code, ex.calls.length], ["ROLE_REFUSED", 0]); }
    { const k = await authorizedFresh(); const ex = fakeGithub(k.id);
      const own = { connect: async () => { const cl = await itOwner.connect(); return ev(cl, { query: (s, p) => cl.query(s, p), release: (x) => cl.release(x) }); } };
      const r = await run(k, ex, { pool: own }); assert.deepEqual([r.code, ex.calls.length], ["ROLE_REFUSED", 0], "owner never admitted"); }
    { const k = await authorizedFresh(); const ex = fakeGithub(k.id);
      const s23 = { connect: async () => { const cl = await itApp.connect();
        return ev(cl, { query: (s, p) => (/e7hko:fn/.test(s) && /claim_pipeline_kickoff/.test(String(p && p[0])) ? cl.query("SELECT NULL::text AS sig WHERE false") : cl.query(s, p)), release: (x) => cl.release(x) }); } };
      const r = await run(k, ex, { pool: s23 }); assert.deepEqual([r.code, ex.calls.length], ["SCHEMA_NOT_0024", 0]); }
  });

  itest("I7 C111 F1 — REAL consumer, claim COMMIT acknowledgement LOST after the server committed: CLAIM_UNCERTAIN, 0 credential / GET / POST, ONE claim statement (no retry); the durable row is 'claimed' (human-owned) and a rerun posts nothing", async () => {
    const k = await authorizedFresh(); const ex = fakeGithub(k.id); const c0 = credCount.n; let claims = 0; let armed = false;
    const pool = { connect: async () => { const cl = await itApp.connect();
      return ev(cl, { query: async (sql, p) => {
        if (/claim_pipeline_kickoff/.test(sql)) { claims += 1; armed = true; }
        if (armed && sql === "COMMIT") { armed = false; await cl.query("COMMIT"); const e = new Error("Connection terminated unexpectedly"); e.code = "ECONNRESET"; throw e; }
        return cl.query(sql, p); }, release: (x) => cl.release(x) }); } };
    const r = await run(k, ex, { pool });
    assert.deepEqual([r.outcome, r.code, r.claimed, r.gets, r.posts, credCount.n - c0, claims, ex.calls.length], ["CLAIM_UNCERTAIN", "CLAIM_UNCERTAIN", false, 0, 0, 0, 1, 0], JSON.stringify(r));
    const durable = await row(k.id);
    assert.deepEqual([durable.state, durable.claim_worker], ["claimed", "hko:it-0001"], "the COMMIT landed: durable, human-owned claim");
    const ex2 = fakeGithub(k.id); const r2 = await run(k, ex2);
    assert.deepEqual([r2.code, ex2.calls.length, r2.credentialReads], ["NOT_PRISTINE:CLAIMED", 0, 0], "no automatic retry / recovery");
  });

  itest("I8 C111 F1 — REAL consumer, claim COMMIT REJECTED before the server committed: CLAIM_UNCERTAIN (never STOP), 0 credential / GET / POST, ONE claim statement; the destroyed session rolls back so the row stays 'requested'", async () => {
    const k = await authorizedFresh(); const ex = fakeGithub(k.id); const c0 = credCount.n; let claims = 0; let armed = false;
    const pool = { connect: async () => { const cl = await itApp.connect();
      return ev(cl, { query: async (sql, p) => {
        if (/claim_pipeline_kickoff/.test(sql)) { claims += 1; armed = true; }
        if (armed && sql === "COMMIT") { armed = false; const e = new Error("write ECONNRESET"); e.code = "ECONNRESET"; throw e; }
        return cl.query(sql, p); }, release: (x) => cl.release(x) }); } };
    const r = await run(k, ex, { pool });
    assert.deepEqual([r.outcome, r.code, r.gets, r.posts, credCount.n - c0, claims, ex.calls.length], ["CLAIM_UNCERTAIN", "CLAIM_UNCERTAIN", 0, 0, 0, 1, 0], JSON.stringify(r));
    for (let i = 0; i < 50 && (await row(k.id)).state !== "requested"; i += 1) await new Promise((res) => setTimeout(res, 10));
    assert.equal((await row(k.id)).state, "requested");
  });

  itest("I9 C111 F1 — REAL consumer, its owned connection is not clean (TX_NOT_CLEAN) → CLAIM_UNCERTAIN, never STOP; 0 credential / GET / POST; nothing written", async () => {
    const k = await authorizedFresh(); const ex = fakeGithub(k.id); const c0 = credCount.n;
    const pool = { connect: async () => { const cl = await itApp.connect();
      return ev(cl, { query: (sql, p) => (/AS clean/.test(sql) ? Promise.resolve({ rows: [{ clean: false }] }) : cl.query(sql, p)), release: (x) => cl.release(x) }); } };
    const r = await run(k, ex, { pool });
    assert.deepEqual([r.outcome, r.code, r.gets, r.posts, credCount.n - c0], ["CLAIM_UNCERTAIN", "TX_NOT_CLEAN", 0, 0, 0], JSON.stringify(r));
    assert.equal((await row(k.id)).state, "requested");
  });

  itest("I10 C112-F1 the stateless ghs_ token shape through the REAL consumer + transport (fake GitHub exchange): ACCEPTED_VERIFIED, the exchange receives exactly that token, ONE GET + ONE POST", async () => {
    const k = await authorizedFresh(); const seenTok = []; const base = fakeGithub(k.id);
    const ex = async (spec) => { seenTok.push(spec.token === NEW_TOKEN); return base(spec); };
    const r = await run(k, ex, { credential: () => NEW_TOKEN });
    assert.deepEqual([r.outcome, r.gets, r.posts, r.verified], ["ACCEPTED_VERIFIED", 1, 1, true], JSON.stringify(r)); assert.deepEqual(seenTok, [true, true]);
    assert.ok(!JSON.stringify(r).includes(NEW_TOKEN.slice(4, 24)));
  });

  // ---- C112 TLS on BOTH hops, against REAL sockets (disposable CA / proxy / server SSL) -------------------------------------------------
  const wrapPool = (P, onConnect = null) => ({ connect: async () => { const cl = await P.connect(); if (onConnect) onConnect(cl);
    return ev(cl, { query: (s, p) => cl.query(s, p), release: (x) => cl.release(x) }); } });
  const backendSsl = async (P) => { const cl = await P.connect(); try { return (await cl.query("SELECT coalesce((SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()), false) AS s")).rows[0].s; } finally { cl.release(); } };

  itest("I11 C112 BOTH hops verified (pooler-shaped proxy, verified TLS to the client AND to Postgres): every acquired client's own socket is authorized for the reviewed host + pinned CA, the server reports ssl=true, and the REAL path reaches ACCEPTED_VERIFIED", async () => {
    assert.equal(await backendSsl(itApp), true, "server-reported backend hop");
    const k = await authorizedFresh(); const ex = fakeGithub(k.id);
    const r = await run(k, ex);
    assert.deepEqual([r.outcome, r.code, r.backendSsl, r.tlsClientRefusal, r.tlsClientChecks === r.tlsClientVerified, r.tlsClientChecks >= 2, r.gets, r.posts],
      ["ACCEPTED_VERIFIED", "HANDOFF_ACCEPTED", true, null, true, true, 1, 1], JSON.stringify(r));
  });

  itest("I12 C112 the OBSERVED hosted discrepancy, reproduced: the CLIENT hop is verified TLS but the pooler→Postgres hop is plaintext (server pg_stat_ssl.ssl=false, the shared pooler with Enforce SSL OFF) → STOP TLS_REQUIRED:BACKEND_HOP after ONE statement; the request untouched; 0 credential / GET / POST — client evidence never waives the backend hop", async () => {
    const P = tlsPool(proxies.offBack.port);
    assert.equal(await backendSsl(P), false, "server-reported: backend hop plaintext");
    let sock = null; const k = await authorizedFresh(); const ex = fakeGithub(k.id); const c0 = credCount.n;
    const r = await run(k, ex, { pool: wrapPool(P, (cl) => { sock = cl.connection.stream; }) });
    assert.ok(sock instanceof tls.TLSSocket && sock.authorized === true, "the client socket itself was an authorized TLS socket");
    assert.deepEqual([r.outcome, r.code, r.backendSsl, r.tlsClientVerified, r.tlsClientRefusal, r.dbQueries, r.gets, r.posts, credCount.n - c0, ex.calls.length],
      ["STOP", "TLS_REQUIRED:BACKEND_HOP", false, 1, null, 1, 0, 0, 0, 0], JSON.stringify(r));
    assert.equal((await row(k.id)).state, "requested");
  });

  itest("I13 C112 server text is NOT client-hop proof: a PLAINTEXT client behind a proxy whose backend hop is TLS (the server reports ssl=true) and a client that does not verify the chain (rejectUnauthorized:false) would both pass a pg_stat_ssl-only gate — the runner refuses each BEFORE its first statement", async () => {
    const plain = tlsPool(proxies.plainFront.port, "test_app", false);
    const noVerify = tlsPool(db.port, "test_app", { rejectUnauthorized: false });                       // direct TLS to Postgres, chain NOT verified
    const noVerifyWrongHost = tlsPool(proxies.wronghost.port, "test_app", { rejectUnauthorized: false, ca: fx.ca1 });
    for (const [label, P, why] of [["plaintext client, TLS backend", plain, "NOT_TLS"], ["unverified chain", noVerify, "UNAUTHORIZED"],
      ["wrong-host certificate accepted unverified", noVerifyWrongHost, "UNAUTHORIZED"]]) {
      assert.equal(await backendSsl(P), true, `${label}: a server-text-only gate (the pre-C112 rule) would admit this`);
      const k = await authorizedFresh(); const ex = fakeGithub(k.id); const c0 = credCount.n;
      const r = await run(k, ex, { pool: wrapPool(P) });
      assert.deepEqual([r.outcome, r.code, r.tlsClientRefusal, r.dbQueries, r.backendSsl, r.gets, r.posts, credCount.n - c0, ex.calls.length],
        ["STOP", `TLS_REQUIRED:CLIENT_${why}`, why, 0, null, 0, 0, 0, 0], `${label}: ${JSON.stringify(r)}`);
      assert.equal((await row(k.id)).state, "requested", label);
    }
  });

  itest("I14 C112 REAL handshake negatives with rejectUnauthorized:true: a certificate for another host, a certificate from a foreign CA → the connection itself fails (0 evidence checks, 0 statements); the policy host / CA pin also bind a valid socket (HOSTNAME_MISMATCH / CONFIG_NOT_PINNED); a socket destroyed before use → DISCONNECTED", async () => {
    for (const [label, port] of [["wrong host", proxies.wronghost.port], ["foreign CA", proxies.foreign.port]]) {
      const k = await authorizedFresh(); const ex = fakeGithub(k.id);
      const r = await run(k, ex, { pool: wrapPool(tlsPool(port)) });
      assert.deepEqual([r.outcome, r.code.startsWith("ADMISSION_READ_FAILED:"), r.tlsClientChecks, r.dbQueries, ex.calls.length], ["STOP", true, 0, 0, 0], `${label}: ${r.code}`);
    }
    for (const [label, tlsPol, why] of [["policy host", { host: "db.other.invalid", caSha256: sha(fx.ca1) }, "HOSTNAME_MISMATCH"], ["CA pin", { host: "localhost", caSha256: sha(fx.ca2) }, "CONFIG_NOT_PINNED"]]) {
      const k = await authorizedFresh(); const ex = fakeGithub(k.id);
      const r = await run(k, ex, { constants: { ...OPEN_IT, tls: tlsPol } });
      assert.deepEqual([r.code, r.dbQueries, ex.calls.length], [`TLS_REQUIRED:CLIENT_${why}`, 0, 0], label);
    }
    const k = await authorizedFresh(); const ex = fakeGithub(k.id);
    const r = await run(k, ex, { pool: wrapPool(itApp, (cl) => cl.connection.stream.destroy()) });
    assert.deepEqual([r.code, r.dbQueries, ex.calls.length], ["TLS_REQUIRED:CLIENT_DISCONNECTED", 0, 0]);
  });

  itest("I15 C112 the CONSUMER's acquisition is checked on its own socket: admission on verified clients, then a PLAINTEXT client handed to the REAL consumer → STOP TLS_REQUIRED:CLIENT_NOT_TLS before any claim; the row stays requested; 0 credential / GET / POST", async () => {
    const plain = tlsPool(proxies.plainFront.port, "test_app", false);
    const admission = E.CATALOG_PINS.functions.length + 4; let n = 0;
    const pool = { connect: async () => { n += 1; const P = n <= admission ? itApp : plain; const cl = await P.connect();
      return ev(cl, { query: (s, p) => cl.query(s, p), release: (x) => cl.release(x) }); } };
    const k = await authorizedFresh(); const ex = fakeGithub(k.id); const c0 = credCount.n;
    const r = await run(k, ex, { pool });
    assert.deepEqual([r.outcome, r.code, r.claimed, r.backendSsl, r.tlsClientVerified, r.gets, r.posts, credCount.n - c0, ex.calls.length],
      ["STOP", "TLS_REQUIRED:CLIENT_NOT_TLS", false, true, admission, 0, 0, 0, 0], JSON.stringify(r));
    assert.equal(n, admission + 1); assert.equal((await row(k.id)).state, "requested");
  });
}
