// scripts/e7-connected/reconcile-cli-main.mjs — E7 N2 reconcile-only runner (R-B, Step B): the LOCAL owner-WSL entrypoint.
// Design: claude/e7-g3/rb-stepB-launch-design-2026-11-12.md (ROOT: option L). Discipline mirrors run-plan-cli-main.mjs:
//   * INERT ON IMPORT: the only top-level effect is `if (import.meta.main === true) main(...)`. Static imports are Node built-ins only.
//   * Order: argv grammar FIRST (exact; each flag once; typed; unknown / duplicate / missing → USAGE before ANY other proc read) → platform /
//     uid → presence-only bootstrap env fence (BOOT_REFUSED_ENV, before anything can load pg) → the RECONCILE EXECUTION CLOSURE verified with
//     built-ins ONLY against --expect-reconcile-digest (the CLI, the launch wiring, the frozen reconcile core / executors / journal and every
//     transitive relative import, package.json + package-lock.json, and the lock-declared runtime packages of `pg`, file by file) → ONLY THEN
//     the fixed-specifier imports of the accepted native adapters / env evaluation → accepted env evaluation → the launch wiring.
//   * The native R1 lists (NATIVE_EXEC_SOURCES / RUN_PLAN_CLOSURE / R1_EXECUTOR_CLOSURE), the stager and every reviewed pin are UNCHANGED; this
//     closure is its OWN list and digest.
//   * Signals: the first SIGINT / SIGTERM is recorded and stops the launch at the next stage boundary BEFORE the core; once the frozen core
//     runs it is bounded by its own hard deadline + teardown grace (it takes no signal). A second signal → terminal exit 130 (tail uncertain).
//   * Output: ONE stdout line = whitelisted result + exitCode. No path, content, error text, credential or env value is echoed.
import process from "node:process";
import { constants as FS_CONSTANTS } from "node:fs";
import { fileURLToPath } from "node:url";

export const RECONCILE_CLI_SCHEMA = "e7-reconcile-cli-v1";
export const EXIT_CODES = Object.freeze({ RECONCILED: 0, USAGE: 2, BOOT_UNSUPPORTED: 3, BOOT_ENV_REFUSED: 4, CLOSURE_REFUSED: 4, REFUSED: 4, STOPPED: 6,
  FAILED: 1, BOOT_IMPORT_FAILED: 1, BOOT_INTERNAL: 1, OUTPUT_FAILED: 9, SIGNAL_TERMINAL: 130 });
/** = run-plan-cli-main.mjs BOOT_REFUSED_ENV (restated: this file may not import repo modules before verification; pinned EQUAL by the unit test) */
export const BOOT_REFUSED_ENV = Object.freeze(["NODE_PG_FORCE_NATIVE"]);
/** the reconcile execution source closure (sorted) — independently re-scanned by test/e7-reconcile-cli.test.mjs */
export const RECONCILE_EXEC_SOURCES = Object.freeze([
  "lib/bookability.js", "lib/booking-db/capture-worker.js", "lib/booking-db/codec.js", "lib/booking-db/compensation-worker.js",
  "lib/booking-db/config.js", "lib/booking-db/operations.js", "lib/booking-db/pool.js", "lib/booking-db/recording-worker.js",
  "lib/booking-db/recovery.js", "lib/booking-db/repo.js", "lib/booking-db/reservation-worker.js", "lib/booking-db/test-abort.js",
  "lib/checkout/capture-proof.js", "lib/checkout/compensation-proof.js", "lib/checkout/final-price.js", "lib/checkout/intent-state.js",
  "lib/checkout/offline-charge-proof.js", "lib/checkout/recovery-plan.js", "lib/checkout/server-pricer.js", "lib/direct-policy.js",
  "lib/direct-pricing.js", "lib/hostaway-calendar.js", "lib/hostaway-reservations.js", "lib/hostaway.js", "lib/public-api.js", "lib/quote-public.js",
  "package-lock.json", "package.json", "scripts/e7-connected/db-credential-file.mjs", "scripts/e7-connected/executor-adapters.mjs",
  "scripts/e7-connected/http-transports.mjs", "scripts/e7-connected/probe-cli-main.mjs", "scripts/e7-connected/probe-command.mjs",
  "scripts/e7-connected/probe-credential-file.mjs", "scripts/e7-connected/probe-env-preflight.mjs", "scripts/e7-connected/probe-source-digest.mjs",
  "scripts/e7-connected/readonly-probe.mjs", "scripts/e7-connected/real-exchange.mjs", "scripts/e7-connected/reconcile-cli-main.mjs",
  "scripts/e7-connected/reconcile-core-r1.mjs", "scripts/e7-connected/reconcile-executors-r1.mjs", "scripts/e7-connected/reconcile-journal-r1.mjs",
  "scripts/e7-connected/reconcile-launch-r1.mjs", "scripts/e7-connected/run-binding-r1.mjs", "scripts/e7-connected/run-core-abort-v2.mjs",
  "scripts/e7-connected/run-core.mjs", "scripts/e7-connected/run-facts.mjs", "scripts/e7-connected/run-guard.mjs",
  "scripts/e7-connected/run-journal-file-v2.mjs", "scripts/e7-connected/run-journal-file.mjs", "scripts/e7-connected/run-journal-memory-v2.mjs",
  "scripts/e7-connected/run-journal-memory.mjs", "scripts/e7-connected/run-lock-precheck.mjs", "scripts/e7-connected/run-manifest-v2.mjs",
  "scripts/e7-connected/run-manifest.mjs", "scripts/e7-connected/run-plan-v1.mjs", "scripts/e7-connected/run-preflight-r1.mjs",
  "scripts/e7-connected/run-r1-launcher.mjs", "scripts/e7-connected/run-test-abort.mjs", "scripts/e7-operator/test-abort.mjs"]);
export const RECONCILE_EXTERNALS = Object.freeze(["pg"]);
export const RECONCILE_DIGEST_PREFIX = "e7-reconcile-exec-closure-v1\n";
export const RECONCILE_CAPS = Object.freeze({ fileBytes: 4 * 1024 * 1024, totalBytes: 24 * 1024 * 1024, files: 4000, depth: 12 });
const HEX64 = /^[0-9a-f]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const B64_RE = /^[A-Za-z0-9+/]{4,8192}={0,2}$/;
const HEAD_RE = /^[1-9][0-9]{0,8}:[0-9a-f]{64}$/;
/** the EXACT grammar: `reconcile` + each flag exactly once (any order), values typed; anything else → null (USAGE) */
export const RECONCILE_FLAGS = Object.freeze({ "--native-run-dir": "path", "--reconcile-run-dir": "path", "--recovery-plan-b64": "b64",
  "--expect-recovery-plan-sha256": "hex", "--expect-native-package-hash": "hex", "--expect-executor-digest": "hex", "--expect-trusted-head": "head",
  "--expect-reconcile-digest": "hex", "--intent": "uuid", "--provider-credentials": "path", "--db-app": "path", "--db-report": "path", "--db-ca": "pathOrNone" });
const freeze = Object.freeze;
const canonicalPath = (p) => typeof p === "string" && p.length > 1 && p.length <= 4096 && p[0] === "/" && !p.includes("\0")
  && p.slice(1).split("/").every((s) => s !== "" && s !== "." && s !== "..");
const typed = (t, v) => (t === "path" ? canonicalPath(v) : t === "pathOrNone" ? v === "none" || canonicalPath(v) : t === "hex" ? HEX64.test(v)
  : t === "uuid" ? UUID_RE.test(v) : t === "b64" ? B64_RE.test(v) && v.length % 4 === 0 : t === "head" ? HEAD_RE.test(v) : false);
const camel = (k) => k.slice(2).replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
/** PURE: tokens (argv after the script) → frozen flags | null */
export function reconcileFlagsOf(tokens) {
  if (!Array.isArray(tokens) || !tokens.every((t) => typeof t === "string")) return null;
  const keys = Object.keys(RECONCILE_FLAGS);
  if (tokens.length !== 1 + 2 * keys.length || tokens[0] !== "reconcile") return null;
  const f = {};
  for (let i = 1; i < tokens.length; i += 2) {
    const k = tokens[i]; const v = tokens[i + 1];
    if (!Object.hasOwn(RECONCILE_FLAGS, k) || Object.hasOwn(f, camel(k)) || !typed(RECONCILE_FLAGS[k], v)) return null;
    f[camel(k)] = v;
  }
  const paths = keys.filter((k) => ["path", "pathOrNone"].includes(RECONCILE_FLAGS[k])).map((k) => f[camel(k)]).filter((v) => v !== "none");
  if (new Set(paths).size !== paths.length) return null;
  return freeze(f);
}

const REPO_ROOT = (() => { const p = fileURLToPath(new URL("../../", import.meta.url)); return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p; })();
export function defaultHooks() {
  return freeze({ importNative: () => import("./probe-cli-main.mjs"), importEnvPreflight: () => import("./probe-env-preflight.mjs"),
    importLaunch: () => import("./reconcile-launch-r1.mjs"), repoRoot: REPO_ROOT });
}

/** the reconcile closure entries (built-ins ONLY; bounded O_NOFOLLOW reads; no symlink / special file); null on any refusal */
export async function readReconcileClosure(root, fsConstants, list = RECONCILE_EXEC_SOURCES) {
  const fsp = await import("node:fs/promises");
  let total = 0; let count = 0;
  const RO = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;
  async function readOne(rel) {
    count += 1; if (count > RECONCILE_CAPS.files) throw new Error("e7");
    const fh = await fsp.open(`${root}/${rel}`, RO);
    try {
      const st = await fh.stat();
      if (!st.isFile() || st.size > RECONCILE_CAPS.fileBytes) throw new Error("e7");
      const buf = Buffer.alloc(st.size + 1); let off = 0;
      for (;;) { const r = await fh.read(buf, off, buf.length - off, null); if (r.bytesRead === 0) break; off += r.bytesRead; if (off > st.size) throw new Error("e7"); }
      if (off !== st.size) throw new Error("e7");
      total += off; if (total > RECONCILE_CAPS.totalBytes) throw new Error("e7");
      return { path: rel, bytes: buf.subarray(0, off) };
    } finally { await fh.close(); }
  }
  try {
    if (!Array.isArray(list) || list.length === 0) return null;
    const entries = [];
    for (const rel of list) entries.push(await readOne(rel));
    const lockE = entries.find((e) => e.path === "package-lock.json"); if (!lockE) return null;
    const lock = JSON.parse(lockE.bytes.toString("utf8"));
    const pk = lock && lock.packages; if (!pk || typeof pk !== "object") return null;
    const pkgs = new Set(); const q = RECONCILE_EXTERNALS.map((n) => `node_modules/${n}`);
    while (q.length) {
      const k = q.pop(); if (pkgs.has(k)) continue;
      const e = pk[k]; if (!e || typeof e !== "object" || e.dev === true) return null;
      pkgs.add(k);
      for (const d of Object.keys({ ...(e.dependencies || {}), ...(e.optionalDependencies || {}) })) if (pk[`node_modules/${d}`]) q.push(`node_modules/${d}`);
    }
    async function walk(rel, depth) {
      if (depth > RECONCILE_CAPS.depth) throw new Error("e7");
      const ds = (await fsp.readdir(`${root}/${rel}`, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const d of ds) {
        const p = `${rel}/${d.name}`;
        if (d.isDirectory()) await walk(p, depth + 1);
        else if (d.isFile()) entries.push(await readOne(p));
        else throw new Error("e7");
      }
    }
    for (const k of [...pkgs].sort()) await walk(k, 1);
    entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return entries;
  } catch { return null; }
}
/** SHA-256( prefix ‖ for each entry sorted by path: path NUL len NUL bytes NUL ) — no module embeds its own value */
export async function reconcileClosureDigest(entries) {
  const { createHash } = await import("node:crypto");
  const h = createHash("sha256"); h.update(RECONCILE_DIGEST_PREFIX);
  for (const e of entries) { h.update(`${e.path}\0${e.bytes.length}\0`); h.update(e.bytes); h.update("\0"); }
  return h.digest("hex");
}

/** main(proc, hooks) → native Promise<void>; never rejects */
export function main(proc, hooks) { return run(proc, hooks).catch(() => {}); }

async function run(proc, hooks) {
  let exited = false;
  const exitOnce = (code) => { if (exited) return; exited = true; try { proc.setExitCode(code); } catch { /* contained */ } try { proc.exit(code); } catch { /* contained */ } };
  const emit = async (obj, code) => {
    if (exited) return;
    const line = JSON.stringify({ schema: RECONCILE_CLI_SCHEMA, ...obj, exitCode: code });
    const ok = await new Promise((resolve) => {
      let settled = false; const fin = (v) => { if (settled) return; settled = true; resolve(v); };
      try { const s = proc.stdout; (typeof s.once === "function" ? s.once : s.on).call(s, "error", () => fin(false)); } catch { fin(false); return; }
      try { proc.stdout.write(`${line}\n`, (err) => fin(err == null)); } catch { fin(false); }
    });
    exitOnce(ok ? code : EXIT_CODES.OUTPUT_FAILED);
  };
  const say = (outcome, extra = {}) => emit({ outcome, ...extra }, EXIT_CODES[outcome]);
  try {
    // ---- argv FIRST (the only proc member read before the grammar is decided) --------------------------------------------------------
    let tokens;
    try { tokens = Array.from(proc.argv).slice(2); } catch { return say("USAGE"); }
    const flags = reconcileFlagsOf(tokens);
    if (!flags) return say("USAGE");
    // ---- platform / uid -----------------------------------------------------------------------------------------------------------
    const platform = proc.platform; const fsc = proc.fsConstants;
    if ((platform !== "linux" && platform !== "darwin") || !fsc || !Number.isSafeInteger(fsc.O_NOFOLLOW)) return say("BOOT_UNSUPPORTED");
    let uid = null;
    try { if (typeof proc.getuid === "function") { const u = proc.getuid(); if (Number.isSafeInteger(u) && u >= 0) uid = u; } } catch { uid = null; }
    if (uid === null) return say("BOOT_UNSUPPORTED");
    // ---- presence-only bootstrap env fence BEFORE any import that can load pg ----------------------------------------------------------
    let envObj;
    try { envObj = proc.env; if (BOOT_REFUSED_ENV.some((k) => Object.hasOwn(envObj, k))) return say("BOOT_ENV_REFUSED", { code: "PG_NATIVE_SELECTOR_PRESENT" }); }
    catch { return say("BOOT_ENV_REFUSED", { code: "ENV_UNREADABLE" }); }
    // ---- RECONCILE CLOSURE verification BEFORE any non-built-in import --------------------------------------------------------------
    const entries = await readReconcileClosure(hooks.repoRoot, fsc);
    if (entries === null) return say("CLOSURE_REFUSED", { code: "RECONCILE_CLOSURE_UNREADABLE" });
    const digest = await reconcileClosureDigest(entries);
    if (digest !== flags.expectReconcileDigest) return say("CLOSURE_REFUSED", { code: "RECONCILE_DIGEST_MISMATCH", reconcileDigest: digest });
    // ---- verified: accepted adapters + env evaluation (node:util only), THEN the launch wiring (which loads pg) -------------------------
    let N; let E; let L;
    try { N = await hooks.importNative(); E = await hooks.importEnvPreflight(); } catch { return say("BOOT_IMPORT_FAILED"); }
    if (typeof N.createNativeAdapters !== "function" || typeof E.evaluateProbeEnvironment !== "function") return say("BOOT_IMPORT_FAILED");
    const present = freeze(Object.fromEntries(N.PRESENT_KEYS.map((k) => [k, Object.hasOwn(envObj, k)])));
    const envSnapshot = freeze({ schema: "e7-probe-env-snapshot-v1", nodeVersion: String(proc.versions.node), platform, execArgvCount: proc.execArgv.length, uidAvailable: true, present });
    const ev = E.evaluateProbeEnvironment(envSnapshot);
    if (!ev.ok) return say("BOOT_ENV_REFUSED", { code: ev.code, reconcileDigest: digest });
    try { L = await hooks.importLaunch(); } catch { return say("BOOT_IMPORT_FAILED"); }
    if (typeof L.runReconcileLaunch !== "function") return say("BOOT_IMPORT_FAILED");
    // ---- signals --------------------------------------------------------------------------------------------------------------------
    let signals = 0;
    const onSig = () => { signals += 1; if (signals >= 2) exitOnce(EXIT_CODES.SIGNAL_TERMINAL); };
    try { proc.onSignal("SIGINT", onSig); proc.onSignal("SIGTERM", onSig); } catch { return say("FAILED"); }
    const nat = N.createNativeAdapters({ platform, uid, constants: fsc, gate: () => { if (signals >= 2) throw new Error("e7-terminal"); } });
    let out;
    try { out = await L.runReconcileLaunch({ flags, nat, proc, hooks: hooks.launch || null, repoRoot: hooks.repoRoot, envSnapshot, interrupted: () => signals > 0 }); }
    catch { return say("FAILED", { reconcileDigest: digest }); }
    const o = out.stage !== "run" ? "REFUSED" : out.code === "RECONCILED_CONFIRMED" ? "RECONCILED" : out.code === "REFUSED" ? "REFUSED" : out.code === "STOPPED" ? "STOPPED" : "FAILED";
    return emit({ outcome: o, stage: out.stage, code: out.code, reconcileDigest: digest, interrupted: signals > 0, result: out.result }, EXIT_CODES[o]);
  } catch {
    return say("BOOT_INTERNAL");
  }
}

/** the native `proc`: argv / stdout / exit / setExitCode are plain fields; every other capability is a LAZY getter (read only after the grammar) */
export function nativeProc() {
  return Object.freeze({
    argv: process.argv,
    get platform() { return process.platform; },
    get versions() { return process.versions; },
    get execArgv() { return process.execArgv; },
    get env() { return process.env; },
    get getuid() { return typeof process.getuid === "function" ? () => process.getuid() : undefined; },
    get fsConstants() { return FS_CONSTANTS; },
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
