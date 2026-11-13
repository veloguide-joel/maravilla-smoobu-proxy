// scripts/e7-connected-runner-hosted.mjs — E7 hosted connected-runner LAUNCHER, slice L1: PREFLIGHT ONLY (packaging proof).
// OFFLINE PACKAGING SLICE: code is NOT consent. Nothing here authorizes a dispatch, a DB connection, a provider request or a booking.
//   * Inert on import (`import.meta.main` guard at the bottom): no env / fs / network / timer until runHosted runs. Node built-ins only here.
//   * The ONLY implemented mode is `preflight`. Every other mode (verify / execute / bindings / anything) is refused FIRST, before any env
//     inspection beyond the mode, any filesystem access, any tooling import and any child process.
//   * PACKAGING PROOF ONLY. A preflight proves: the pinned tooling bytes (the full transitive closure of the accepted runner core, transports,
//     real exchange, file journal, env preflight and the child suite, + package.json / package-lock.json) match BEFORE any tooling import; the
//     accepted manifest validator accepts the launcher's SYNTHETIC-labelled manifest; the accepted fake-only suites pass in a child with an
//     explicit OS env allowlist. It proves NOTHING about DB access, credentials, transports, providers, journal durability or a booking.
//   * Imports from tooling (after the closure check) are restricted to EXACTLY two pure modules: scripts/e7-connected/run-manifest.mjs and
//     scripts/e7-connected/probe-env-preflight.mjs. run-core, the workers, the adapters, the transports, the real exchange and the file journal
//     are digest-verified bytes only: never imported, constructed or invoked here. No runConnectedTest, no exchange, no pool, no install.
//   * Credential boundary: any env key naming a database, Postgres, Supabase, Stripe or Hostaway credential is refused at the parent boundary
//     (code only, no value echoed). Any E7_ input other than E7_TOOLING_DIR / E7_WORKFLOW_SHA is refused (no real manifest input exists in L1).
import process from "node:process";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath, appendFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const freeze = Object.freeze;
export const CHILD_TESTS = freeze([          // the accepted FAKE-ONLY offline suites at the pinned tooling (no PG, no network, no install, no provider)
  "test/e7-connected-run-manifest.test.mjs",   // Slice A: pure validator + hash; global fetch trapped
  "test/e7-connected-run-guard.test.mjs",      // Slice B: injected fake monotonic / timers / clients / lock
  "test/e7-connected-run-journal.test.mjs",    // Slice D: in-memory journal; source-grammar parity reads only
  "test/e7-connected-http-transports.test.mjs", // Slice T: injected fake exchange; synthetic credentials; fetch guarded
  "test/e7-connected-real-exchange.test.mjs"   // Slice X: injected fake EventEmitter primitive; no socket / DNS / TLS
]);
export const CONSTANTS = freeze({
  toolingCommit: "6d00d0d6c7ac63b77d703f8c212381109096723c",
  // scanned transitive import closure of: run-core, http-transports, real-exchange, run-journal-file, probe-env-preflight and CHILD_TESTS;
  // + the data files the child suites read (worker grammar sources, migrations 0001 / 0003); + the package manifest + lock
  closure: freeze(["package.json", "package-lock.json",
    "db/migrations/0001_booking_core.up.sql", "db/migrations/0003_safety_corrections.up.sql",
    "lib/bookability.js", "lib/booking-db/capture-worker.js", "lib/booking-db/codec.js", "lib/booking-db/compensation-worker.js", "lib/booking-db/config.js",
    "lib/booking-db/notification-worker.js", "lib/booking-db/operations.js", "lib/booking-db/pool.js", "lib/booking-db/recording-worker.js",
    "lib/booking-db/recovery.js", "lib/booking-db/repo.js", "lib/booking-db/reservation-worker.js",
    "lib/checkout/capture-proof.js", "lib/checkout/compensation-proof.js", "lib/checkout/final-price.js", "lib/checkout/intent-state.js",
    "lib/checkout/offline-charge-proof.js", "lib/checkout/recovery-plan.js", "lib/checkout/server-pricer.js", "lib/checkout/stripe-test-mode.js",
    "lib/direct-policy.js", "lib/direct-pricing.js", "lib/hostaway-calendar.js", "lib/hostaway-reservations.js", "lib/hostaway.js", "lib/public-api.js",
    "lib/quote-public.js",
    "scripts/e7-connected/executor-adapters.mjs", "scripts/e7-connected/http-transports.mjs", "scripts/e7-connected/probe-env-preflight.mjs",
    "scripts/e7-connected/real-exchange.mjs", "scripts/e7-connected/run-core.mjs", "scripts/e7-connected/run-facts.mjs", "scripts/e7-connected/run-guard.mjs",
    "scripts/e7-connected/run-journal-file.mjs", "scripts/e7-connected/run-journal-memory.mjs", "scripts/e7-connected/run-manifest.mjs",
    ...CHILD_TESTS]),
  closureDigest: "677ab877030a030beae8d52ce8450bd74f5249669c1eaab50ca867580573a618",
  allowedImports: freeze(["scripts/e7-connected/run-manifest.mjs", "scripts/e7-connected/probe-env-preflight.mjs"]),
  runnerFiles: freeze(["scripts/e7-connected-runner-hosted.mjs", ".github/workflows/e7-connected-runner.yml", "test/e7-connected-runner-hosted.test.mjs"]),
  nodeVersion: "22.22.0",
  modesImplemented: freeze(["preflight"]),
  // the launcher's own SYNTHETIC manifest (validated by the ACCEPTED Slice A validator; synthetic: true is the only form it accepts).
  // Every value is synthetic; it names no real intent (never run 1 / 2 / 3), listing, account, reservation or guest.
  syntheticManifest: freeze({
    version: "e7-run-manifest-v1", runId: "synthetic-l1-preflight", intentId: "00000000-0000-4000-8000-0000000000a1",
    baselineCommit: "6d00d0d6c7ac63b77d703f8c212381109096723c", synthetic: true, providerMode: freeze({ hostaway: "fake", stripe: "mock" }),
    listing: freeze({ id: 891001, currency: "USD", refFieldId: 777009, timeZone: "America/Mazatlan" }), expectedRef: "MV-SYNTHL1",
    stay: freeze({ arrival: "2026-12-04", departure: "2026-12-06", guests: 2 }), amountMinor: 50000, pricing: freeze({ rateBps: 1000 }),
    stripeAccountId: "acct_1SyntheticLaunchL1", hostawayAccountLabel: freeze({ accountRef: "acct-synthetic-l1", clientSnapshotId: "client-SYNTH-L1" }),
    phases: freeze({ capture: false, recording: false }), paymentMethod: null,
    cleanup: freeze({ reservedNotConfirmed: "synthetic/l1-reserved", captured: "synthetic/l1-captured", confirmed: "synthetic/l1-confirmed" }),
    automationsReviewed: "synthetic/l1-automations", checkpoints: freeze(["CALENDAR_BASELINE", "AIRBNB_BLOCKED", "AIRBNB_REOPENED"])   // the accepted v1 rule (exact list)
  }),
  // real intents that must never be adopted by a synthetic plan (run 1 / run 2 / run 3)
  neverAdopt: freeze(["b312e325-e6b5-498c-80b5-b91ce5bb3df2", "48b59c0d-1c8c-4f32-ad91-08dbab1e8e3c", "cc53bc11-565d-4e9b-8be1-95f3febc8a39"])
});
export const PLAN_SCHEMA = "e7-connected-runner-hosted-plan-v1";
export const PLAN_HASH_PREFIX = `${PLAN_SCHEMA}\n`;
export const RESULT_SCHEMA = "e7-connected-runner-hosted-v1";
export const CLOSURE_DIGEST_PREFIX = "e7-connected-runner-hosted-closure-v1\n";
export const RUNNER_DIGEST_PREFIX = "e7-connected-runner-hosted-runner-v1\n";
export const PROOF = "PACKAGING_ONLY";
export const HOSTED_CODES = freeze(["CRH_MODE_NOT_IMPLEMENTED", "CRH_SECRET_SCOPE_VIOLATION", "CRH_INPUT_NOT_IN_THIS_SLICE", "CRH_LAYOUT_INVALID",
  "CRH_SOURCE_UNREADABLE", "CRH_SOURCE_MISMATCH", "CRH_IMPORT_REFUSED", "CRH_IMPORT_FAILED", "CRH_MANIFEST_REFUSED", "CRH_SYNTHETIC_ADOPTION_REFUSED",
  "CRH_ENV_REFUSED", "CRH_CHILD_FAILED", "CRH_TESTS_FAILED", "CRH_INTERNAL", "PREFLIGHT_OK_PACKAGING_ONLY"]);
/** parent-boundary credential refusal: any key naming a DB / Postgres / Supabase / Stripe / Hostaway credential (values never read or echoed) */
export const CREDENTIAL_KEY_RE = /DATABASE|^PG|POSTGRES|SUPABASE|STRIPE|HOSTAWAY/i;   // ^PG: every PG-prefixed key (PGHOST, PG_URL, PG_SERVICE_FILE, PG1 …)
export const E7_INPUTS_ALLOWED = freeze(["E7_TOOLING_DIR", "E7_WORKFLOW_SHA"]);
const HEX40 = /^[0-9a-f]{40}$/; const HEX64 = /^[0-9a-f]{64}$/; const CODE_RE = /^[A-Za-z0-9_:.-]{1,80}$/;
const MAX_FILE = 1048576; const MAX_TOTAL = 8388608;
class Refusal extends Error { constructor(code) { super("e7-connected-runner-hosted"); this.code = code; } }
const refuse = (code) => { throw new Refusal(code); };
const sha = (s) => createHash("sha256").update(s).digest("hex");
export function canonical(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
}
function deepFreeze(v) { if (v && typeof v === "object") { for (const k of Object.keys(v)) deepFreeze(v[k]); freeze(v); } return v; }
function plainCopy(v) { return v === null || typeof v !== "object" ? v : Array.isArray(v) ? v.map(plainCopy) : Object.fromEntries(Object.keys(v).map((k) => [k, plainCopy(v[k])])); }

/** buildLaunchPlan(c, { manifestHash, closureDigest, runnerDigest, nodeVersion }) -> frozen { plan, runnerPlanHash }. Pure. */
export function buildLaunchPlan(c, { manifestHash, closureDigest, runnerDigest, nodeVersion }) {
  if (![manifestHash, closureDigest, runnerDigest].every((h) => HEX64.test(String(h)))) refuse("CRH_INTERNAL");
  const plan = { schema: PLAN_SCHEMA, proof: PROOF, planKind: "SYNTHETIC", toolingCommit: c.toolingCommit, closureDigest, runnerDigest,
    runtime: { node: String(nodeVersion) }, manifest: { version: c.syntheticManifest.version, hash: manifestHash, synthetic: true },
    modesImplemented: [...c.modesImplemented], childTests: [...CHILD_TESTS],
    effects: { db: 0, providerRequests: 0, exchangesConstructed: 0, coreInvocations: 0, writes: 0, notifications: 0 } };
  return freeze({ plan: deepFreeze(plan), runnerPlanHash: sha(PLAN_HASH_PREFIX + canonical(plan)) });
}

export async function framedDigest(dir, files, prefix) {
  const h = createHash("sha256"); h.update(prefix); let total = 0;
  for (const rel of files) {
    const p = `${dir}/${rel}`; const st = await lstat(p);
    if (!st.isFile() || st.size < 1 || st.size > MAX_FILE) refuse("CRH_SOURCE_UNREADABLE");
    const b = await readFile(p); if (b.length !== st.size) refuse("CRH_SOURCE_UNREADABLE");
    total += b.length; if (total > MAX_TOTAL) refuse("CRH_SOURCE_UNREADABLE");
    h.update(rel); h.update(Buffer.from([0])); h.update(String(b.length)); h.update(Buffer.from([0])); h.update(b); h.update(Buffer.from([0]));
  }
  return h.digest("hex");
}
/** the child's environment: the explicit OS / runtime allowlist of the accepted operator / cleanup runners + E7_TOOLING_DIR. Nothing else. */
export const CHILD_ENV_ALLOWLIST = freeze(["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "TZ"]);
export function childEnv(env, toolingDir) {
  const out = {};
  for (const k of CHILD_ENV_ALLOWLIST) if (Object.hasOwn(env, k) && typeof env[k] === "string" && env[k].length <= 4096 && !env[k].includes("\0")) out[k] = env[k];
  out.E7_TOOLING_DIR = toolingDir;
  return out;
}
export function spawnNode(args, { cwd, env }) {
  return new Promise((resolve) => {
    let out = ""; let outBytes = 0; let truncated = false; let child;
    try { child = spawn(process.execPath, args, { cwd, env, shell: false, stdio: ["ignore", "pipe", "ignore"] }); } catch { resolve({ status: null, signal: null, stdout: "", truncated: false, spawnFailed: true }); return; }
    child.stdout.on("data", (d) => { outBytes += d.length; if (outBytes <= 1048576) out += d.toString("utf8"); else truncated = true; });
    child.on("error", () => resolve({ status: null, signal: null, stdout: "", truncated, spawnFailed: true }));
    child.on("close", (status, signal) => resolve({ status, signal, stdout: out, truncated, spawnFailed: false }));
  });
}

/**
 * runHosted({ mode, env, proc, wrapperDir, deps }) -> { exitCode, result }. Never throws.
 *   deps (TEST SEAMS): spawnChild, importModule(absPath) (default: dynamic import), constants
 */
export async function runHosted({ mode = "preflight", env, proc, wrapperDir, deps = {} }) {
  const c = deps.constants ?? CONSTANTS;
  const spawnChild = deps.spawnChild ?? spawnNode;
  const importModule = deps.importModule ?? ((p) => import(pathToFileURL(p).href));
  const r = { schema: RESULT_SCHEMA, proof: PROOF, mode: null, code: null, workflowSha: null, toolingCommit: c.toolingCommit, closureDigest: null,
    runnerDigest: null, manifestHash: null, runnerPlanHash: null, planKind: null, envCode: null, tests: null, imports: [] };
  try {
    // (0) mode FIRST: nothing but preflight exists in L1 (no env, fs, import or child before this check)
    if (!c.modesImplemented.includes(mode)) refuse("CRH_MODE_NOT_IMPLEMENTED");
    r.mode = mode;
    // (1) parent credential / input boundary (key names only; no value is read into the result)
    const keys = Object.keys(env);
    if (keys.some((k) => CREDENTIAL_KEY_RE.test(k))) refuse("CRH_SECRET_SCOPE_VIOLATION");
    if (keys.some((k) => /^E7_/.test(k) && !E7_INPUTS_ALLOWED.includes(k))) refuse("CRH_INPUT_NOT_IN_THIS_SLICE");
    r.workflowSha = HEX40.test(env.E7_WORKFLOW_SHA ?? "") ? env.E7_WORKFLOW_SHA : null;
    // (2) layout + the pinned closure BEFORE any tooling import
    const tooling = await realpath(env.E7_TOOLING_DIR ?? "").catch(() => refuse("CRH_LAYOUT_INVALID"));
    const wdir = await realpath(wrapperDir).catch(() => refuse("CRH_LAYOUT_INVALID"));
    if (tooling === wdir || tooling.startsWith(`${wdir}/`) || wdir.startsWith(`${tooling}/`)) refuse("CRH_LAYOUT_INVALID");
    r.closureDigest = await framedDigest(tooling, c.closure, CLOSURE_DIGEST_PREFIX).catch((e) => refuse(e instanceof Refusal ? e.code : "CRH_SOURCE_UNREADABLE"));
    if (r.closureDigest !== c.closureDigest) refuse("CRH_SOURCE_MISMATCH");
    r.runnerDigest = await framedDigest(wdir, c.runnerFiles, RUNNER_DIGEST_PREFIX).catch((e) => refuse(e instanceof Refusal ? e.code : "CRH_SOURCE_UNREADABLE"));
    // (3) the only two tooling imports (pure modules), through one restricted gate
    const load = async (rel) => {
      if (!c.allowedImports.includes(rel)) refuse("CRH_IMPORT_REFUSED");
      r.imports.push(rel);
      try { return await importModule(`${tooling}/${rel}`); } catch { refuse("CRH_IMPORT_FAILED"); }
    };
    const M = await load("scripts/e7-connected/run-manifest.mjs");
    const synthetic = plainCopy(c.syntheticManifest);
    if (c.neverAdopt.includes(synthetic.intentId)) refuse("CRH_SYNTHETIC_ADOPTION_REFUSED");
    const v = M.validateRunManifest(synthetic);
    if (!v || v.ok !== true || v.manifest.synthetic !== true || !HEX64.test(String(v.hash))) refuse("CRH_MANIFEST_REFUSED");
    if (v.hash !== M.manifestHash(v.manifest)) refuse("CRH_MANIFEST_REFUSED");                 // the accepted framing (prefix + canonical JSON)
    r.manifestHash = v.hash; r.planKind = "SYNTHETIC";
    // (4) env evaluation (accepted C1) + exact Node
    const C1 = await load("scripts/e7-connected/probe-env-preflight.mjs");
    const present = Object.fromEntries(C1.PRESENT_KEYS.map((k) => [k, Object.hasOwn(env, k)]));
    let uid = null; try { if (typeof proc.getuid === "function") { const u = proc.getuid(); if (Number.isSafeInteger(u) && u >= 0) uid = u; } } catch { uid = null; }
    const ev = C1.evaluateProbeEnvironment({ schema: C1.ENV_SNAPSHOT_SCHEMA, nodeVersion: String(proc.versions.node), platform: proc.platform,
      execArgvCount: proc.execArgv.length, uidAvailable: uid !== null, present });
    r.envCode = typeof ev.code === "string" && C1.ENV_CODES.includes(ev.code) ? ev.code : "REDACTED";
    if (ev.ok !== true || proc.versions.node !== c.nodeVersion) refuse("CRH_ENV_REFUSED");
    // (5) the plan (binds manifest hash, tooling, closure, runner digest, runtime)
    r.runnerPlanHash = buildLaunchPlan(c, { manifestHash: r.manifestHash, closureDigest: r.closureDigest, runnerDigest: r.runnerDigest,
      nodeVersion: proc.versions.node }).runnerPlanHash;
    // (6) the accepted FAKE-ONLY suites, in a plain child at the tooling root (allowlisted env; no secret, DB, network or dependency)
    const o = await spawnChild(["--test", "--test-reporter=tap", ...CHILD_TESTS], { cwd: tooling, env: childEnv(env, tooling) });
    if (!o || o.spawnFailed || (o.signal !== null && o.signal !== undefined) || !Number.isSafeInteger(o.status) || o.truncated) refuse("CRH_CHILD_FAILED");
    const num = (re) => { const m = re.exec(o.stdout); return m ? Number(m[1]) : null; };
    r.tests = { status: o.status, tests: num(/^# tests (\d+)$/m), pass: num(/^# pass (\d+)$/m), fail: num(/^# fail (\d+)$/m), connectivityEvidence: false };
    if (o.status !== 0 || !(r.tests.tests > 0) || r.tests.pass !== r.tests.tests || r.tests.fail !== 0) refuse("CRH_TESTS_FAILED");
    r.code = "PREFLIGHT_OK_PACKAGING_ONLY";
    return { exitCode: 0, result: r };
  } catch (e) {
    r.code = e instanceof Refusal && HOSTED_CODES.includes(e.code) ? e.code : "CRH_INTERNAL";
    return { exitCode: 1, result: r };
  }
}

export function summaryMarkdown(r) {
  const s = (x) => (typeof x === "string" && CODE_RE.test(x) ? x : x === null || x === undefined ? "—" : HEX64.test(String(x)) || HEX40.test(String(x)) ? String(x) : "REDACTED");
  const n = (x) => (Number.isSafeInteger(x) && x >= 0 ? String(x) : "REDACTED");           // bounded numeric test fields, rendered as numbers only
  const tests = r.tests && typeof r.tests === "object" ? `status ${n(r.tests.status)}, pass ${n(r.tests.pass)}/${n(r.tests.tests)}, fail ${n(r.tests.fail)}` : null;
  const rows = [["proof", r.proof], ["mode", r.mode], ["code", r.code], ["workflow commit", r.workflowSha], ["tooling commit", r.toolingCommit],
    ["closureDigest (computed)", r.closureDigest], ["runnerDigest (computed)", r.runnerDigest], ["manifestHash (synthetic)", r.manifestHash],
    ["runnerPlanHash", r.runnerPlanHash], ["env", r.envCode],
    ["fake-only suites (NOT connectivity)", { tests }]];
  return `### E7 connected-runner launcher L1 — PREFLIGHT (packaging proof only)\n\n| field | value |\n|---|---|\n${rows.map(([a, b]) => `| ${a} | ${b && typeof b === "object" ? (b.tests ?? "—") : s(b)} |`).join("\n")}\n`;
}

if (import.meta.main === true) {
  const mode = process.argv[2] ?? "preflight";
  const wrapperDir = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
  const { exitCode, result } = await runHosted({ mode, env: process.env, proc: process, wrapperDir });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summaryMarkdown(result)).catch(() => {});
  process.exitCode = exitCode;
}
