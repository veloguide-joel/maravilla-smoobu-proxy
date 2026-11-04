// scripts/e7-connected/probe-cli-main.mjs — E7 probe CLI stage C3: the ONLY process-touching module (contract claude/e7-connected-probe-cli-contract.md
// §13, accepted at 68712630 with clarifications A–F; implementation map §14).
//   * INERT ON IMPORT: the only top-level effect is `if (import.meta.main === true) main(...)`. Importing registers no signal, reads no file,
//     writes nothing. Hooks are a function parameter only — never selectable from argv or env.
//   * Static imports: Node built-ins + the pure digest helper ONLY. The command module (inspect / execute) and P (prepare-plan) are loaded
//     dynamically, by fixed specifier, AFTER the bootstrap; on execute only after the source digest matched.
//   * Native adapters are thin mappings onto the accepted C1 / C2 schemas (no policy here). POSIX linux / darwin only, O_NOFOLLOW required
//     (final path component only — ancestors / namespace remain TRUST). No elapsed-time bound on fs IO.
//   * Implementing or testing `execute` authorizes nothing: a real run needs Joel's explicit approval of ONE exact package, outside the code.
import process from "node:process";
import { open as fspOpen, lstat as fspLstat, realpath as fspRealpath } from "node:fs/promises";
import { constants as FS_CONSTANTS } from "node:fs";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { request as httpsRequest, Agent as HttpsAgent } from "node:https";
import { SOURCE_CLOSURE, computeSourceDigest, MAX_SOURCE_FILE_BYTES, MAX_SOURCE_TOTAL_BYTES } from "./probe-source-digest.mjs";

export const BOOT_SCHEMA = "e7-probe-cli-boot-v1";
export const PREP_SCHEMA = "e7-probe-prepare-v1";
export const BOOT_CODES = Object.freeze({ BOOT_UNSUPPORTED: 3, BOOT_USAGE: 2, BOOT_SOURCE_UNREADABLE: 4, BOOT_SOURCE_MISMATCH: 4, BOOT_IMPORT_FAILED: 1, BOOT_INTERNAL: 1 });
export const PREP_CODES = Object.freeze({ PREP_OK: 0, PREP_USAGE: 2, PREP_UNREADABLE: 4, PREP_INVALID: 4, PREP_OUTPUT_PARENT_INVALID: 4, PREP_INTERRUPTED: 7,
  PREP_EXISTS: 9, PREP_OUTPUT_UNKNOWN: 9 });
export const MAX_PLAN_BYTES = 16384;
export const MAX_PLAN_DEPTH = 8;
export const PRESENT_KEYS = Object.freeze(["NODE_OPTIONS", "NODE_TLS_REJECT_UNAUTHORIZED", "NODE_EXTRA_CA_CERTS", "NODE_USE_ENV_PROXY", "NODE_DEBUG", "NODE_DEBUG_NATIVE",
  "SSLKEYLOGFILE", "OPENSSL_CONF", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy"]);
const HEX64 = /^[0-9a-f]{64}$/;
const freeze = Object.freeze;
const U8 = Uint8Array;

/** a fixed-code error: no path, no message content beyond a constant */
const codeErr = (code) => { const e = new Error("e7-native"); Object.defineProperty(e, "code", { value: code, enumerable: true }); return e; };
const canonicalPath = (p, allowRoot) => {
  if (typeof p !== "string" || p.length < 1 || p.length > 4096 || p[0] !== "/" || p.includes("\0")) return false;
  if (p === "/") return allowRoot;
  return p.slice(1).split("/").every((s) => s !== "" && s !== "." && s !== "..");
};
const dirname = (p) => { const i = p.lastIndexOf("/"); return i === 0 ? "/" : p.slice(0, i); };

// ---- native adapters --------------------------------------------------------------------------------------------------------------
/** bigint fs.Stats → the accepted C1 / C2 stat record; unsafe / negative / non-bigint values reject with a fixed code */
export function mapStat(st) {
  const num = (b) => { if (typeof b !== "bigint" || b < 0n || b > BigInt(Number.MAX_SAFE_INTEGER)) throw codeErr("E7_STAT_RANGE"); return Number(b); };
  const dec = (b) => { if (typeof b !== "bigint" || b < 0n) throw codeErr("E7_STAT_RANGE"); return String(b); };
  const kind = st.isFile() ? "file" : st.isDirectory() ? "dir" : st.isSymbolicLink() ? "symlink" : "other";
  return { dev: dec(st.dev), ino: dec(st.ino), kind, mode: num(st.mode), nlink: num(st.nlink), size: num(st.size), uid: num(st.uid), mtimeNs: dec(st.mtimeNs), ctimeNs: dec(st.ctimeNs) };
}
/** platform + open constants check: true only for linux / darwin with every needed constant a non-negative safe integer */
export function nativeSupported(platform, constants) {
  if (platform !== "linux" && platform !== "darwin") return false;
  try { return ["O_RDONLY", "O_WRONLY", "O_CREAT", "O_EXCL", "O_NOFOLLOW"].every((k) => Number.isSafeInteger(constants[k]) && constants[k] >= 0); } catch { return false; }
}
/**
 * createNativeAdapters({ platform, uid, constants, gate }) — call ONLY after nativeSupported(...) is true. `gate()` throws once the terminal
 * (second-SIGINT) latch is set, so no NEW open / read / create / write / stat / lstat / realpath starts after it; close is never gated.
 */
export function createNativeAdapters({ platform, uid, constants, gate }) {
  const RO = constants.O_RDONLY | constants.O_NOFOLLOW;
  const CREATE = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
  const lstat = async (p) => { gate(); return mapStat(await fspLstat(p, { bigint: true })); };
  const realpath = async (p) => { gate(); return fspRealpath(p); };
  /** bounded read of one regular file into an OWNED Uint8Array; the acquired handle is owned immediately and closed once on every outcome */
  async function readBounded(p, cap) {
    gate();
    const fh = await fspOpen(p, RO);
    let primary = null; let out = null;
    const buf = new U8(cap + 1);
    try {
      gate();
      const st = mapStat(await fh.stat({ bigint: true }));
      if (st.kind !== "file") primary = "E7_NOT_REGULAR";
      else if (st.size < 1 || st.size > cap) primary = "E7_SIZE";
      else {
        let off = 0; let calls = 0;
        while (off < cap + 1) {
          gate(); calls += 1; if (calls > cap + 2) { primary = "E7_IO"; break; }          // unreachable under strict positive progress
          const r = await fh.read(buf, off, cap + 1 - off, null);
          const n = r.bytesRead;
          if (!Number.isSafeInteger(n) || n < 0 || n > cap + 1 - off) { primary = "E7_IO"; break; }
          if (n === 0) break;
          off += n;
        }
        if (primary === null) { if (off > cap) primary = "E7_SIZE"; else if (off !== st.size) primary = "E7_CHANGED"; else { out = new U8(off); out.set(buf.subarray(0, off)); } }
      }
    } catch { if (primary === null) primary = "E7_IO"; }
    finally { buf.fill(0); }
    let closed = false;
    try { closed = (await fh.close()) === undefined; } catch { closed = false; }
    if (primary !== null) throw codeErr(primary);                                         // the earlier refusal stays primary
    if (!closed) throw codeErr("E7_CLOSE");
    return out;
  }
  const credentialFs = freeze({ platform, uid, lstat, realpath,
    async open(p, kind) {
      if (kind !== "credential-read") throw codeErr("E7_KIND");
      gate();
      const fh = await fspOpen(p, RO);
      return { stat: async () => { gate(); return mapStat(await fh.stat({ bigint: true })); },
        read: async (b, o, l) => { gate(); const r = await fh.read(b, o, l, null); return r.bytesRead; },
        close: () => fh.close() };
    } });
  const outputFs = freeze({ platform, uid, lstat, realpath,
    async create(p, kind) {
      if (kind !== "summary-create") throw codeErr("E7_KIND");
      gate();
      const fh = await fspOpen(p, CREATE, 0o600);
      return { write: async (b, o, l) => { gate(); const r = await fh.write(b, o, l, null); return r.bytesWritten; }, sync: () => fh.sync(), close: () => fh.close() };
    } });
  const readPlanFile = (p) => readBounded(p, MAX_PLAN_BYTES);
  /** the fixed closure, in order, under `root`; any failure or the total cap → null */
  async function readSource(root) {
    try {
      const snap = []; let total = 0;
      for (const rel of SOURCE_CLOSURE) {
        const bytes = await readBounded(`${root}/${rel}`, MAX_SOURCE_FILE_BYTES);
        total += bytes.length; if (total > MAX_SOURCE_TOTAL_BYTES) return null;
        snap.push({ path: rel, bytes });
      }
      return snap;
    } catch { return null; }
  }
  return freeze({ credentialFs, outputFs, readPlanFile, readSource, readBounded });
}

// ---- small pure helpers -----------------------------------------------------------------------------------------------------------
function depthOk(v) {
  const stack = [[v, 1]]; let nodes = 0;
  while (stack.length) {
    const [x, d] = stack.pop(); nodes += 1; if (nodes > MAX_PLAN_BYTES) return false;
    if (x === null || typeof x !== "object") continue;
    if (d > MAX_PLAN_DEPTH) return false;
    for (const c of Array.isArray(x) ? x : Object.keys(x).map((k) => x[k])) stack.push([c, d + 1]);
  }
  return true;
}
/** execute's expected digest from the EXACT argv tokens: exactly one `--expect-source-digest` followed by 64 lowercase hex → value, else null */
export function expectedDigestOf(argv) {
  const idx = []; for (let i = 0; i < argv.length; i++) if (argv[i] === "--expect-source-digest") idx.push(i);
  if (idx.length !== 1) return null;
  const v = argv[idx[0] + 1];
  return typeof v === "string" && HEX64.test(v) ? v : null;
}
const REPO_ROOT = (() => { const p = fileURLToPath(new URL("../../", import.meta.url)); return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p; })();

export function defaultHooks() {
  return freeze({ primitive: freeze({ request: httpsRequest, Agent: HttpsAgent }), importCommand: () => import("./probe-command.mjs"),
    importPlanModule: () => import("./readonly-probe.mjs"), readSource: null, repoRoot: REPO_ROOT });
}

// ---- main ---------------------------------------------------------------------------------------------------------------------------
/**
 * main(proc, hooks) → native Promise<void>; never rejects. `proc`: { argv, platform, versions, execArgv, env, getuid, fsConstants, stdout,
 * onSigint, exit, setExitCode }. `hooks`: { primitive, importCommand, importPlanModule, readSource (null = native), repoRoot }.
 */
export function main(proc, hooks) {
  return run(proc, hooks).catch(() => {});
}

async function run(proc, hooks) {
  // ---- terminal latch, signals, single exit -----------------------------------------------------------------------------------------
  const latch = { terminal: false, exited: false };
  const exitOnce = (code) => {
    if (latch.exited) return; latch.exited = true; latch.terminal = true;
    try { proc.setExitCode(code); } catch { /* contained */ }
    try { proc.exit(code); } catch { /* contained */ }
  };
  const ac = new AbortController();
  let sigints = 0;
  try {
    proc.onSigint(() => {
      sigints += 1;
      if (sigints === 1) { try { ac.abort(); } catch { /* contained */ } return; }
      latch.terminal = true;                                       // latched BEFORE the forced exit; no continuation may act after this
      exitOnce(130);
    });
  } catch { exitOnce(1); return; }
  const dead = () => latch.terminal;
  const gate = () => { if (latch.terminal) throw codeErr("E7_TERMINAL"); };

  /** the ONE stdout attempt; settles once on callback / error event / sync throw; normal exit only after a successful callback */
  const emitAndExit = async (line, code) => {
    if (dead()) return;
    const ok = await new Promise((resolve) => {
      let settled = false; const fin = (v) => { if (settled) return; settled = true; resolve(v); };
      try { const s = proc.stdout; (typeof s.once === "function" ? s.once : s.on).call(s, "error", () => fin(false)); } catch { fin(false); return; }
      try { proc.stdout.write(`${line}\n`, (err) => fin(err == null)); } catch { fin(false); }   // a false return value is backpressure only
    });
    if (dead()) return;
    exitOnce(ok ? code : 9);
  };
  const boot = (code, sourceDigest = null) => emitAndExit(JSON.stringify({ schema: BOOT_SCHEMA, code, sourceDigest, exitCode: BOOT_CODES[code] }), BOOT_CODES[code]);

  try {
    // ---- argv copy + platform / constants (before ANY adapter or file read) -------------------------------------------------------
    let argv;
    try { argv = Array.from(proc.argv).slice(2).map((x) => { if (typeof x !== "string") throw 0; return x; }); } catch { return boot("BOOT_USAGE"); }
    const platform = proc.platform;
    if (!nativeSupported(platform, proc.fsConstants)) return boot("BOOT_UNSUPPORTED");
    let uid = null;
    try { if (typeof proc.getuid === "function") { const u = proc.getuid(); if (Number.isSafeInteger(u) && u >= 0) uid = u; } } catch { uid = null; }
    const mode = argv[0] === "prepare-plan" ? "prepare" : argv[0] === "execute" ? "execute" : "inspect";
    if ((mode === "execute" || mode === "prepare") && uid === null) return boot("BOOT_UNSUPPORTED");
    const nat = createNativeAdapters({ platform, uid: uid ?? 0, constants: proc.fsConstants, gate });

    if (mode === "prepare") return prepare(argv, nat, hooks, { uid, ac, dead, gate, emitAndExit, boot });

    // ---- pre-import source bootstrap ----------------------------------------------------------------------------------------------
    let expected = null;
    if (mode === "execute") { expected = expectedDigestOf(argv); if (expected === null) return boot("BOOT_USAGE"); }
    let snapshot = null;
    try { snapshot = await (hooks.readSource ? hooks.readSource(hooks.repoRoot) : nat.readSource(hooks.repoRoot)); } catch { snapshot = null; }
    if (dead()) return;
    const dg = snapshot ? computeSourceDigest(snapshot) : null;
    const digest = dg && dg.ok ? dg.digest : null;
    if (mode === "execute") {
      if (digest === null) return boot("BOOT_SOURCE_UNREADABLE");
      if (digest !== expected) return boot("BOOT_SOURCE_MISMATCH", digest);
    }
    // ---- command import (fixed specifier, after the digest check) -------------------------------------------------------------------
    let runProbeCommand;
    try { const m = await hooks.importCommand(); runProbeCommand = m.runProbeCommand; if (typeof runProbeCommand !== "function") throw 0; } catch { if (dead()) return; return boot("BOOT_IMPORT_FAILED", digest); }
    if (dead()) return;
    // ---- deps: env snapshot built ONCE here (presence only), real clock / timers, gated adapters / primitive -----------------------
    const env = proc.env;
    const present = freeze(Object.fromEntries(PRESENT_KEYS.map((k) => [k, Object.hasOwn(env, k)])));
    const envSnapshot = freeze({ schema: "e7-probe-env-snapshot-v1", nodeVersion: String(proc.versions.node), platform, execArgvCount: proc.execArgv.length,
      uidAvailable: uid !== null, present });
    const inspectDeps = { envSnapshot, repoRoot: hooks.repoRoot, sourceDigest: digest, readPlanFile: nat.readPlanFile, interrupt: ac.signal };
    let deps = inspectDeps;
    if (mode === "execute") {
      const P = hooks.primitive; const ReqFn = P.request; const AgentCtor = P.Agent;
      const primitive = freeze({
        request(options) { gate(); return Reflect.apply(ReqFn, undefined, [options]); },          // no request after the terminal latch
        Agent: function GatedAgent(opts) { gate(); return new AgentCtor(opts); }
      });
      const timers = freeze({ arm(ms) { let id; const promise = new Promise((res) => { id = setTimeout(res, ms); }); return { promise, cancel: () => clearTimeout(id) }; } });
      deps = { ...inspectDeps, credentialFs: nat.credentialFs, outputFs: nat.outputFs, primitive, monotonic: () => performance.now(), timers };
    }
    const disposition = await runProbeCommand({ argv, deps });
    if (dead()) return;
    return emitAndExit(disposition.stdoutLine, disposition.exitCode);
  } catch {
    if (dead()) return;
    return boot("BOOT_INTERNAL");
  }
}

// ---- prepare-plan (offline; P only; never C2 / T / X / credentials / network) -------------------------------------------------------
async function prepare(argv, nat, hooks, ctx) {
  const { uid, ac, dead, emitAndExit } = ctx;
  const line = (code, extra = {}) => emitAndExit(JSON.stringify({ schema: PREP_SCHEMA, code, planCode: null, planHash: null, file: "NOT_ATTEMPTED", ...extra, exitCode: PREP_CODES[code] }), PREP_CODES[code]);
  // grammar: prepare-plan --in <abs> --out <abs> (either order, each once, distinct canonical paths)
  const f = {};
  if (argv.length !== 5) return line("PREP_USAGE");
  for (let i = 1; i < 5; i += 2) { const k = argv[i]; const v = argv[i + 1]; if ((k !== "--in" && k !== "--out") || k in f || !canonicalPath(v, false)) return line("PREP_USAGE"); f[k] = v; }
  if (f["--in"] === f["--out"]) return line("PREP_USAGE");
  if (ac.signal.aborted) return line("PREP_INTERRUPTED");
  let bytes;
  try { bytes = await nat.readPlanFile(f["--in"]); } catch { if (dead()) return; return line("PREP_UNREADABLE"); }
  if (dead()) return;
  let text; try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return line("PREP_INVALID", { planCode: "PLAN_NOT_JSON" }); }
  // ONE JSON.parse: duplicate keys follow ordinary last-key-wins in THIS draft-conversion mode only (ruling A); the output is canonical
  let parsed; try { parsed = JSON.parse(text); } catch { return line("PREP_INVALID", { planCode: "PLAN_NOT_JSON" }); }
  if (!depthOk(parsed)) return line("PREP_INVALID", { planCode: "PLAN_TOO_DEEP" });
  let P; try { P = await hooks.importPlanModule(); } catch { if (dead()) return; return ctx.boot("BOOT_IMPORT_FAILED"); }
  if (dead()) return;
  const v = P.validateProbePlan(parsed);
  if (!v.ok) return line("PREP_INVALID", { planCode: v.code });
  const plan = v.plan;
  const body = Object.fromEntries(Object.keys(plan).filter((k) => k !== "planHash").map((k) => [k, plan[k]]));
  const out = new TextEncoder().encode(`${P.canonicalJson(body)}\n`);
  // owner-controlled canonical parent, target absent (no overwrite)
  const target = f["--out"]; const parent = dirname(target);
  try {
    const rp = await nat.credentialFs.realpath(parent); if (dead()) return;
    const ps = await nat.credentialFs.lstat(parent); if (dead()) return;
    if (rp !== parent || ps.kind !== "dir" || ps.uid !== uid || (ps.mode & 0o022) !== 0) return line("PREP_OUTPUT_PARENT_INVALID", { planHash: plan.planHash });
  } catch { if (dead()) return; return line("PREP_OUTPUT_PARENT_INVALID", { planHash: plan.planHash }); }
  try { await nat.credentialFs.lstat(target); if (dead()) return; return line("PREP_EXISTS", { planHash: plan.planHash }); }
  catch (e) { if (dead()) return; if (!(e && e.code === "ENOENT")) return line("PREP_OUTPUT_PARENT_INVALID", { planHash: plan.planHash }); }
  if (ac.signal.aborted) return line("PREP_INTERRUPTED", { planHash: plan.planHash });
  // single O_EXCL create; close owned once; write / sync / close acknowledged by exact schema
  let h;
  try { h = await nat.outputFs.create(target, "summary-create"); }
  catch (e) { if (dead()) return; return line(e && e.code === "EEXIST" ? "PREP_EXISTS" : "PREP_OUTPUT_UNKNOWN", { planHash: plan.planHash, file: e && e.code === "EEXIST" ? "RACE_EXISTS" : "UNKNOWN" }); }
  let ok = false;
  try {
    let off = 0;
    while (off < out.length) { const n = await h.write(out, off, out.length - off); if (!Number.isSafeInteger(n) || n < 1 || n > out.length - off) throw 0; off += n; }
    ok = (await h.sync()) === undefined;
  } catch { ok = false; }
  let closed = false; try { closed = (await h.close()) === undefined; } catch { closed = false; }
  if (dead()) return;
  if (ok && closed) return line("PREP_OK", { planHash: plan.planHash, file: "CLOSED_ACK" });
  return line("PREP_OUTPUT_UNKNOWN", { planHash: plan.planHash, file: "UNKNOWN" });
}

// ---- the ONLY top-level effect -----------------------------------------------------------------------------------------------------
if (import.meta.main === true) {
  main({ argv: process.argv, platform: process.platform, versions: process.versions, execArgv: process.execArgv, env: process.env,
    getuid: typeof process.getuid === "function" ? () => process.getuid() : undefined, fsConstants: FS_CONSTANTS, stdout: process.stdout,
    onSigint: (fn) => { process.on("SIGINT", fn); }, exit: (c) => process.exit(c), setExitCode: (c) => { process.exitCode = c; } }, defaultHooks());
}
