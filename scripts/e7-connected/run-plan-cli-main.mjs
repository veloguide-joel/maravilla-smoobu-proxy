// scripts/e7-connected/run-plan-cli-main.mjs — E7 G3a + G3b: the NATIVE entrypoint for the accepted plan INSPECT (contract
// claude/e7-g3a-native-inspect-and-db-ingress.md §1) and the reviewed R1 EXECUTE (contract claude/e7-g3b-native-execute.md).
//   * INERT ON IMPORT: the only top-level effect is `if (import.meta.main === true) main(...)`. Static imports are Node built-ins only.
//   * The mode is decided from argv FIRST. Every unknown / malformed invocation — including an `execute` whose COMPLETE flag grammar is not
//     exactly satisfied — refuses BEFORE any env / uid / platform read, adapter, import, file, credential, network, pool, transport or journal access.
//   * G3b EXECUTE order: exact grammar (pure) → platform / uid → NATIVE EXECUTION CLOSURE verification with built-ins ONLY (fixed source list
//     below + the lock-declared runtime dependency packages, digest vs --expect-native-digest) → ONLY THEN the fixed-specifier imports of the
//     accepted adapters and the launcher (run-r1-launcher.mjs), which owns every later step. No path / module / injection argument exists.
//   * INSPECT reuses the accepted pieces unchanged: runPlanCommand (run-plan-command.mjs) and the accepted native bounded O_NOFOLLOW
//     regular-file reader / platform check / presence keys (probe-cli-main.mjs), both loaded by FIXED specifier after the mode decision.
//   * Output: ONE stdout line = the command's whitelisted deep-frozen result + exitCode. No path, content, error text or env value is echoed.
import process from "node:process";
import { constants as FS_CONSTANTS } from "node:fs";
import { fileURLToPath } from "node:url";

export const CLI_SCHEMA = "e7-run-plan-native-cli-v1";
export const EXIT_CODES = Object.freeze({ INSPECT_OK: 0, DEPS_INVALID: 1, BOOT_IMPORT_FAILED: 1, BOOT_INTERNAL: 1, USAGE: 2, BOOT_UNSUPPORTED: 3, PLAN_REFUSED: 4,
  EXECUTE_NOT_IMPLEMENTED: 5, OUTPUT_FAILED: 9, EXECUTE_ENDED: 0, EXECUTE_REFUSED: 4, NATIVE_CLOSURE_REFUSED: 4, EXECUTE_STOPPED: 6, EXECUTE_FAILED: 1, SIGNAL_TERMINAL: 130, BOOT_ENV_REFUSED: 4 });
/** G3b root review of 128ac08 (H2): env names whose mere PRESENCE selects an unreviewed module path inside the verified dependency set —
 *  pg@8.18.0 lib/index.js requires ./native → the OPTIONAL peer `pg-native` (outside the native closure) when !!NODE_PG_FORCE_NATIVE */
export const BOOT_REFUSED_ENV = Object.freeze(["NODE_PG_FORCE_NATIVE"]);
/** G3b: the reviewed NATIVE EXECUTION source closure (sorted): the scanned static + dynamic relative import graph of this CLI and the launcher,
 *  ∪ RUN_PLAN_CLOSURE ∪ R1_EXECUTOR_CLOSURE (read as binder data) ∪ the two manifests. Independently re-scanned by the test suite. */
export const NATIVE_EXEC_SOURCES = Object.freeze([
  "lib/bookability.js", "lib/booking-db/capture-worker.js", "lib/booking-db/codec.js", "lib/booking-db/compensation-worker.js",
  "lib/booking-db/config.js", "lib/booking-db/operations.js", "lib/booking-db/pool.js", "lib/booking-db/recording-worker.js",
  "lib/booking-db/recovery.js", "lib/booking-db/repo.js", "lib/booking-db/reservation-worker.js", "lib/booking-db/test-abort.js",
  "lib/checkout/capture-proof.js", "lib/checkout/compensation-proof.js", "lib/checkout/final-price.js", "lib/checkout/intent-state.js",
  "lib/checkout/offline-charge-proof.js", "lib/checkout/recovery-plan.js", "lib/checkout/server-pricer.js", "lib/direct-policy.js",
  "lib/direct-pricing.js", "lib/hostaway-calendar.js", "lib/hostaway-reservations.js", "lib/hostaway.js", "lib/public-api.js", "lib/quote-public.js",
  "package-lock.json", "package.json", "scripts/e7-connected/db-credential-file.mjs", "scripts/e7-connected/executor-adapters.mjs",
  "scripts/e7-connected/http-transports.mjs", "scripts/e7-connected/probe-cli-main.mjs", "scripts/e7-connected/probe-command.mjs",
  "scripts/e7-connected/probe-credential-file.mjs", "scripts/e7-connected/probe-env-preflight.mjs", "scripts/e7-connected/probe-source-digest.mjs",
  "scripts/e7-connected/readonly-probe.mjs", "scripts/e7-connected/real-exchange.mjs", "scripts/e7-connected/run-binding-r1.mjs",
  "scripts/e7-connected/run-core-abort-v2.mjs", "scripts/e7-connected/run-core.mjs", "scripts/e7-connected/run-facts.mjs",
  "scripts/e7-connected/run-guard.mjs", "scripts/e7-connected/run-journal-file-v2.mjs", "scripts/e7-connected/run-journal-file.mjs",
  "scripts/e7-connected/run-journal-memory-v2.mjs", "scripts/e7-connected/run-journal-memory.mjs", "scripts/e7-connected/run-lock-precheck.mjs", "scripts/e7-connected/run-manifest-v2.mjs",
  "scripts/e7-connected/run-manifest.mjs", "scripts/e7-connected/run-plan-cli-main.mjs", "scripts/e7-connected/run-plan-command.mjs",
  "scripts/e7-connected/run-plan-v1.mjs", "scripts/e7-connected/run-preflight-r1.mjs", "scripts/e7-connected/run-r1-launcher.mjs",
  "scripts/e7-connected/run-test-abort.mjs", "scripts/e7-operator/test-abort.mjs"]);
/** G3b: the bare package specifiers the closure imports; their lock-declared transitive runtime packages are hashed file-by-file */
export const NATIVE_EXTERNALS = Object.freeze(["pg"]);
export const NATIVE_DIGEST_PREFIX = "e7-native-exec-closure-v1\n";
export const NATIVE_CAPS = Object.freeze({ fileBytes: 4 * 1024 * 1024, totalBytes: 24 * 1024 * 1024, files: 4000, depth: 12 });
const HEX64 = /^[0-9a-f]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VERSION_RE = /^\d{4}-\d{2}-\d{2}(\.[a-z]{1,32})?$/;
/** the EXACT execute grammar: each flag exactly once (any order), values typed; anything else → null (USAGE) */
export const EXECUTE_FLAGS = Object.freeze({ "--package": "path", "--plan": "path", "--expect-package-hash": "hex", "--expect-executor-digest": "hex",
  "--expect-native-digest": "hex", "--intent": "uuid", "--provider-credentials": "path", "--db-app": "path", "--db-report": "path", "--db-ca": "pathOrNone",
  "--journal-dir": "path", "--head-dir": "path", "--stripe-api-version": "version" });
const freeze = Object.freeze;

/** canonical absolute POSIX path (no NUL, no empty / '.' / '..' segment, no trailing '/') — the accepted probe CLI rule */
const canonicalPath = (p) => typeof p === "string" && p.length > 1 && p.length <= 4096 && p[0] === "/" && !p.includes("\0")
  && p.slice(1).split("/").every((s) => s !== "" && s !== "." && s !== "..");

/** the mode from the argv tokens ONLY (pure; no other input is read) → { mode:"INSPECT", planPath } | { mode:"EXECUTE" } | { mode:"USAGE" } */
export function modeOf(tokens) {
  if (!Array.isArray(tokens) || tokens.length < 1 || tokens.length > 32 || !tokens.every((t) => typeof t === "string")) return freeze({ mode: "USAGE" });
  if (tokens[0] === "execute") { const f = executeFlagsOf(tokens); return freeze(f ? { mode: "EXECUTE", flags: f } : { mode: "USAGE" }); }
  if (tokens[0] !== "inspect" || tokens.length !== 3 || tokens[1] !== "--plan" || !canonicalPath(tokens[2])) return freeze({ mode: "USAGE" });
  return freeze({ mode: "INSPECT", planPath: tokens[2] });
}

const typed = (t, v) => (t === "path" ? canonicalPath(v) : t === "pathOrNone" ? v === "none" || canonicalPath(v) : t === "hex" ? HEX64.test(v)
  : t === "uuid" ? UUID_RE.test(v) : t === "version" ? VERSION_RE.test(v) : false);
const camel = (k) => k.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
/** pure: `execute` + the 13 flags each exactly once with typed values; distinct paths; else null */
export function executeFlagsOf(tokens) {
  const keys = Object.keys(EXECUTE_FLAGS);
  if (tokens.length !== 1 + 2 * keys.length || tokens[0] !== "execute") return null;
  const f = {};
  for (let i = 1; i < tokens.length; i += 2) {
    const k = tokens[i]; const v = tokens[i + 1];
    if (!Object.hasOwn(EXECUTE_FLAGS, k) || Object.hasOwn(f, camel(k)) || !typed(EXECUTE_FLAGS[k], v)) return null;
    f[camel(k)] = v;
  }
  const paths = keys.filter((k) => EXECUTE_FLAGS[k] !== "hex" && EXECUTE_FLAGS[k] !== "uuid" && EXECUTE_FLAGS[k] !== "version").map((k) => f[camel(k)]).filter((v) => v !== "none");
  if (new Set(paths).size !== paths.length) return null;
  return freeze(f);
}

const REPO_ROOT = (() => { const p = fileURLToPath(new URL("../../", import.meta.url)); return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p; })();
export function defaultHooks() {
  return freeze({ importCommand: () => import("./run-plan-command.mjs"), importNative: () => import("./probe-cli-main.mjs"),
    importLimits: () => import("./run-plan-v1.mjs"), importLauncher: () => import("./run-r1-launcher.mjs"), importEnvPreflight: () => import("./probe-env-preflight.mjs"), repoRoot: REPO_ROOT });
}

/**
 * main(proc, hooks) → native Promise<void>; never rejects. `proc`: { argv, platform, versions, execArgv, env, getuid, fsConstants, stdout, exit,
 * setExitCode, now }. `hooks`: { importCommand, importNative, importLimits, repoRoot }.
 */
export function main(proc, hooks) { return run(proc, hooks).catch(() => {}); }

async function run(proc, hooks) {
  let exited = false;
  const exitOnce = (code) => { if (exited) return; exited = true; try { proc.setExitCode(code); } catch { /* contained */ } try { proc.exit(code); } catch { /* contained */ } };
  /** the ONE stdout attempt; normal exit only after a successful write callback */
  const emit = async (obj, code) => {
    const line = JSON.stringify({ schema: CLI_SCHEMA, ...obj, exitCode: code });
    const ok = await new Promise((resolve) => {
      let settled = false; const fin = (v) => { if (settled) return; settled = true; resolve(v); };
      try { const s = proc.stdout; (typeof s.once === "function" ? s.once : s.on).call(s, "error", () => fin(false)); } catch { fin(false); return; }
      try { proc.stdout.write(`${line}\n`, (err) => fin(err == null)); } catch { fin(false); }
    });
    exitOnce(ok ? code : EXIT_CODES.OUTPUT_FAILED);
  };
  const refuse = (outcome) => emit({ outcome, executable: false }, EXIT_CODES[outcome]);
  try {
    // ---- argv FIRST (the only proc member read before the mode is known) ----------------------------------------------------------
    let tokens;
    try { tokens = Array.from(proc.argv).slice(2); } catch { return refuse("USAGE"); }
    const m = modeOf(tokens);
    if (m.mode === "EXECUTE") return execute(proc, hooks, m.flags, emit, exitOnce);
    if (m.mode !== "INSPECT") return refuse("USAGE");
    // ---- INSPECT: accepted adapters / platform check, presence-only env snapshot, accepted command ---------------------------------
    let N; let C; let L;
    try { N = await hooks.importNative(); C = await hooks.importCommand(); L = await hooks.importLimits(); } catch { return refuse("BOOT_IMPORT_FAILED"); }
    if (typeof N.nativeSupported !== "function" || typeof N.createNativeAdapters !== "function" || typeof C.runPlanCommand !== "function") return refuse("BOOT_IMPORT_FAILED");
    const platform = proc.platform;
    if (!N.nativeSupported(platform, proc.fsConstants)) return refuse("BOOT_UNSUPPORTED");
    let uid = null;
    try { if (typeof proc.getuid === "function") { const u = proc.getuid(); if (Number.isSafeInteger(u) && u >= 0) uid = u; } } catch { uid = null; }
    const nat = N.createNativeAdapters({ platform, uid: uid ?? 0, constants: proc.fsConstants, gate: () => {} });
    const env = proc.env;
    const present = freeze(Object.fromEntries(N.PRESENT_KEYS.map((k) => [k, Object.hasOwn(env, k)])));
    const envSnapshot = freeze({ schema: "e7-probe-env-snapshot-v1", nodeVersion: String(proc.versions.node), platform, execArgvCount: proc.execArgv.length,
      uidAvailable: uid !== null, present });
    const root = hooks.repoRoot;
    const readPlanFile = () => nat.readBounded(m.planPath, L.MAX_PLAN_BYTES);
    const readSourceFiles = async (closure) => {
      const out = []; let total = 0;
      for (const rel of closure) {
        const bytes = await nat.readBounded(`${root}/${rel}`, L.MAX_SOURCE_FILE_BYTES);
        total += bytes.length; if (total > L.MAX_SOURCE_TOTAL_BYTES) throw new Error("e7-native");
        out.push({ path: rel, bytes });
      }
      return out;
    };
    const r = await C.runPlanCommand({ argv: ["inspect"], deps: { envSnapshot, planClock: () => proc.now(), readPlanFile, readSourceFiles } });
    const code = r.outcome === "INSPECT_OK" ? EXIT_CODES.INSPECT_OK : r.outcome === "DEPS_INVALID" ? EXIT_CODES.DEPS_INVALID : EXIT_CODES.PLAN_REFUSED;
    return emit({ result: r }, code);
  } catch {
    return refuse("BOOT_INTERNAL");
  }
}

// ---- G3b EXECUTE ----------------------------------------------------------------------------------------------------------------
/** the native execution closure entries (built-ins ONLY; bounded O_NOFOLLOW reads; no symlink / special file); null on any refusal */
export async function readNativeClosure(root, fsConstants) {
  const fsp = await import("node:fs/promises");
  let total = 0; let count = 0;
  const RO = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;
  async function readOne(rel) {
    count += 1; if (count > NATIVE_CAPS.files) throw new Error("e7");
    const fh = await fsp.open(`${root}/${rel}`, RO);
    try {
      const st = await fh.stat();
      if (!st.isFile() || st.size > NATIVE_CAPS.fileBytes) throw new Error("e7");
      const buf = Buffer.alloc(st.size + 1); let off = 0;
      for (;;) { const r = await fh.read(buf, off, buf.length - off, null); if (r.bytesRead === 0) break; off += r.bytesRead; if (off > st.size) throw new Error("e7"); }
      if (off !== st.size) throw new Error("e7");
      total += off; if (total > NATIVE_CAPS.totalBytes) throw new Error("e7");
      return { path: rel, bytes: buf.subarray(0, off) };
    } finally { await fh.close(); }
  }
  try {
    const entries = [];
    for (const rel of NATIVE_EXEC_SOURCES) entries.push(await readOne(rel));
    // the runtime dependency packages: from the VERIFIED-BY-DIGEST lock bytes (package-lock.json is itself a closure entry)
    const lock = JSON.parse(entries.find((e) => e.path === "package-lock.json").bytes.toString("utf8"));
    const pk = lock && lock.packages; if (!pk || typeof pk !== "object") return null;
    const pkgs = new Set(); const q = NATIVE_EXTERNALS.map((n) => `node_modules/${n}`);
    while (q.length) {
      const k = q.pop(); if (pkgs.has(k)) continue;
      const e = pk[k]; if (!e || typeof e !== "object" || e.dev === true) return null;
      pkgs.add(k);
      for (const d of Object.keys({ ...(e.dependencies || {}), ...(e.optionalDependencies || {}) })) if (pk[`node_modules/${d}`]) q.push(`node_modules/${d}`);
    }
    async function walk(rel, depth) {
      if (depth > NATIVE_CAPS.depth) throw new Error("e7");
      const ds = (await fsp.readdir(`${root}/${rel}`, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const d of ds) {
        const p = `${rel}/${d.name}`;
        if (d.isDirectory()) await walk(p, depth + 1);
        else if (d.isFile()) entries.push(await readOne(p));
        else throw new Error("e7");                                      // symlink / special entry inside a dependency package: refused
      }
    }
    for (const k of [...pkgs].sort()) await walk(k, 1);
    entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return entries;
  } catch { return null; }
}
/** digest framing: SHA-256( prefix ‖ for each entry sorted by path: path NUL len NUL bytes NUL ) — no module embeds its own value */
export async function nativeClosureDigest(entries) {
  const { createHash } = await import("node:crypto");
  const h = createHash("sha256"); h.update(NATIVE_DIGEST_PREFIX);
  for (const e of entries) { h.update(`${e.path}\0${e.bytes.length}\0`); h.update(e.bytes); h.update("\0"); }
  return h.digest("hex");
}

async function execute(proc, hooks, flags, emit, exitOnce) {
  const say = (outcome, extra = {}) => emit({ outcome, executable: false, ...extra }, EXIT_CODES[outcome]);
  // ---- platform / uid (lazy native reads, AFTER the grammar) --------------------------------------------------------------------
  const platform = proc.platform; const fsc = proc.fsConstants;
  if ((platform !== "linux" && platform !== "darwin") || !fsc || !Number.isSafeInteger(fsc.O_NOFOLLOW)) return say("BOOT_UNSUPPORTED");
  let uid = null;
  try { if (typeof proc.getuid === "function") { const u = proc.getuid(); if (Number.isSafeInteger(u) && u >= 0) uid = u; } } catch { uid = null; }
  if (uid === null) return say("BOOT_UNSUPPORTED");
  // ---- (H2) presence-only bootstrap env fence, BEFORE any import that can load pg (regardless of the value: pg's truthiness is not the policy)
  let envObj;
  try { envObj = proc.env; if (BOOT_REFUSED_ENV.some((k) => Object.hasOwn(envObj, k))) return say("BOOT_ENV_REFUSED", { code: "PG_NATIVE_SELECTOR_PRESENT" }); }
  catch { return say("BOOT_ENV_REFUSED", { code: "ENV_UNREADABLE" }); }
  // ---- NATIVE EXECUTION CLOSURE verification BEFORE any non-built-in import ----------------------------------------------------
  const entries = await readNativeClosure(hooks.repoRoot, fsc);
  if (entries === null) return say("NATIVE_CLOSURE_REFUSED", { code: "NATIVE_CLOSURE_UNREADABLE" });
  const digest = await nativeClosureDigest(entries);
  if (digest !== flags.expectNativeDigest) return say("NATIVE_CLOSURE_REFUSED", { code: "NATIVE_DIGEST_MISMATCH", nativeDigest: digest });
  // ---- verified: fixed-specifier imports of the accepted adapters and the launcher ---------------------------------------------
  // (H2) the ACCEPTED env evaluation (verified, node:util only) now runs BEFORE the launcher import — i.e. before pg can load — so the accepted
  // refused variables (NODE_OPTIONS, …) and exec flags stop the run before the dependency graph is evaluated
  let N; let E; let L;
  try { N = await hooks.importNative(); E = await hooks.importEnvPreflight(); } catch { return say("BOOT_IMPORT_FAILED"); }
  if (typeof N.createNativeAdapters !== "function" || typeof E.evaluateProbeEnvironment !== "function") return say("BOOT_IMPORT_FAILED");
  const present = freeze(Object.fromEntries(N.PRESENT_KEYS.map((k) => [k, Object.hasOwn(envObj, k)])));
  const envSnapshot = freeze({ schema: "e7-probe-env-snapshot-v1", nodeVersion: String(proc.versions.node), platform, execArgvCount: proc.execArgv.length, uidAvailable: true, present });
  const ev = E.evaluateProbeEnvironment(envSnapshot);
  if (!ev.ok) return say("BOOT_ENV_REFUSED", { code: ev.code, nativeDigest: digest });
  try { L = await hooks.importLauncher(); } catch { return say("BOOT_IMPORT_FAILED"); }
  if (typeof L.runR1Launch !== "function") return say("BOOT_IMPORT_FAILED");
  // ---- signals: first SIGINT / SIGTERM → the run's AbortSignal (accepted boundary); second → terminal exit 130 (tail uncertain) --------
  const ac = new AbortController(); let signals = 0;
  const onSig = () => { signals += 1; if (signals === 1) { try { ac.abort(); } catch { /* contained */ } return; } exitOnce(EXIT_CODES.SIGNAL_TERMINAL); };
  try { proc.onSignal("SIGINT", onSig); proc.onSignal("SIGTERM", onSig); } catch { return say("EXECUTE_FAILED"); }
  const nat = N.createNativeAdapters({ platform, uid, constants: fsc, gate: () => {} });
  const { attest } = L.createStdinAttest({ stdin: proc.stdin, stderr: proc.stderr });
  let out;
  try { out = await L.runR1Launch({ flags, nat, proc, hooks: hooks.launch || null, signal: ac.signal, attest, repoRoot: hooks.repoRoot, envSnapshot }); }
  catch { return say("EXECUTE_FAILED"); }
  try { proc.stdin.pause && proc.stdin.pause(); } catch { /* contained */ }
  const o = out.stage !== "run" ? "EXECUTE_REFUSED" : out.code === "ENDED_RELEASED" ? "EXECUTE_ENDED" : out.code === "REFUSED" ? "EXECUTE_REFUSED" : out.code === "STOPPED" ? "EXECUTE_STOPPED" : "EXECUTE_FAILED";
  return emit({ outcome: o, nativeDigest: digest, interrupted: signals > 0, result: out.result }, EXIT_CODES[o]);
}

/**
 * the native `proc` for main(): ONLY argv / stdout / exit / setExitCode are plain fields (what a refusal needs); every INSPECT-only
 * capability (platform, versions, execArgv, env, getuid, fsConstants, now) is a LAZY getter, so `execute` / unknown / malformed modes —
 * decided from argv first — never touch those process properties (root review of 079e8da).
 */
export function nativeProc() {
  return Object.freeze({
    argv: process.argv,
    get platform() { return process.platform; },
    get versions() { return process.versions; },
    get execArgv() { return process.execArgv; },
    get env() { return process.env; },
    get getuid() { return typeof process.getuid === "function" ? () => process.getuid() : undefined; },
    get fsConstants() { return FS_CONSTANTS; },
    get stdin() { return process.stdin; },
    get stderr() { return process.stderr; },
    onSignal: (name, fn) => { process.on(name, fn); },
    monotonic: () => performance.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (id) => clearTimeout(id),
    stdout: process.stdout,
    exit: (c) => process.exit(c),
    setExitCode: (c) => { process.exitCode = c; },
    now: () => Date.now()
  });
}

// ---- the ONLY top-level effect -----------------------------------------------------------------------------------------------------
if (import.meta.main === true) main(nativeProc(), defaultHooks());
