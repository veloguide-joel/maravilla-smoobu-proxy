// scripts/e7-connected/run-plan-cli-main.mjs — E7 G3a: the NATIVE entrypoint for the accepted plan INSPECT (contract
// claude/e7-g3a-native-inspect-and-db-ingress.md §1). OFFLINE; inspect ONLY.
//   * INERT ON IMPORT: the only top-level effect is `if (import.meta.main === true) main(...)`. Static imports are Node built-ins only.
//   * The mode is decided from argv FIRST. `execute` and every unknown / malformed invocation refuse BEFORE any env / uid / platform read,
//     adapter, import, file, credential, network, pool, transport or journal access. Execute is NOT implemented (no runReservationAbortR1).
//   * INSPECT reuses the accepted pieces unchanged: runPlanCommand (run-plan-command.mjs) and the accepted native bounded O_NOFOLLOW
//     regular-file reader / platform check / presence keys (probe-cli-main.mjs), both loaded by FIXED specifier after the mode decision.
//   * Output: ONE stdout line = the command's whitelisted deep-frozen result + exitCode. No path, content, error text or env value is echoed.
import process from "node:process";
import { constants as FS_CONSTANTS } from "node:fs";
import { fileURLToPath } from "node:url";

export const CLI_SCHEMA = "e7-run-plan-native-cli-v1";
export const EXIT_CODES = Object.freeze({ INSPECT_OK: 0, DEPS_INVALID: 1, BOOT_IMPORT_FAILED: 1, BOOT_INTERNAL: 1, USAGE: 2, BOOT_UNSUPPORTED: 3, PLAN_REFUSED: 4,
  EXECUTE_NOT_IMPLEMENTED: 5, OUTPUT_FAILED: 9 });
const freeze = Object.freeze;

/** canonical absolute POSIX path (no NUL, no empty / '.' / '..' segment, no trailing '/') — the accepted probe CLI rule */
const canonicalPath = (p) => typeof p === "string" && p.length > 1 && p.length <= 4096 && p[0] === "/" && !p.includes("\0")
  && p.slice(1).split("/").every((s) => s !== "" && s !== "." && s !== "..");

/** the mode from the argv tokens ONLY (pure; no other input is read) → { mode:"INSPECT", planPath } | { mode:"EXECUTE" } | { mode:"USAGE" } */
export function modeOf(tokens) {
  if (!Array.isArray(tokens) || tokens.length < 1 || tokens.length > 8 || !tokens.every((t) => typeof t === "string")) return freeze({ mode: "USAGE" });
  if (tokens[0] === "execute") return freeze({ mode: "EXECUTE" });
  if (tokens[0] !== "inspect" || tokens.length !== 3 || tokens[1] !== "--plan" || !canonicalPath(tokens[2])) return freeze({ mode: "USAGE" });
  return freeze({ mode: "INSPECT", planPath: tokens[2] });
}

const REPO_ROOT = (() => { const p = fileURLToPath(new URL("../../", import.meta.url)); return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p; })();
export function defaultHooks() {
  return freeze({ importCommand: () => import("./run-plan-command.mjs"), importNative: () => import("./probe-cli-main.mjs"),
    importLimits: () => import("./run-plan-v1.mjs"), repoRoot: REPO_ROOT });
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
    if (m.mode === "EXECUTE") return refuse("EXECUTE_NOT_IMPLEMENTED");
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
    stdout: process.stdout,
    exit: (c) => process.exit(c),
    setExitCode: (c) => { process.exitCode = c; },
    now: () => Date.now()
  });
}

// ---- the ONLY top-level effect -----------------------------------------------------------------------------------------------------
if (import.meta.main === true) main(nativeProc(), defaultHooks());
