// scripts/e7-connected/run-p3-precheck-cli.mjs — E7: STANDALONE, REPORT-ONLY, DIRECT-endpoint P3 advisory-lock precheck CLI
// (feature/e7-p3-lock-precheck). Review fixes R1 (endpoint gate) + R2 (cleanup/exit + timers) applied.
//
// *** HELD *** Performs the bounded READ-ONLY P3 precheck (a single pg_locks count). It acquires NO advisory lock and makes NO persistent
// application mutation — but a catalog SELECT still takes ordinary transient internal DB locks and opens a real connection, so it does NOT
// connect unless the operator passes --confirm-prereqs-met (and root has reviewed). Default = OFFLINE config-validate; never pool.connect().
//
// Closure (verified by run-p3-precheck-cli.test.mjs + the import-closure walk): this file → run-lock-precheck.mjs (leaf, zero imports),
// db-credential-file.mjs (reader; node:util only), probe-cli-main.mjs (node builtins + probe-source-digest.mjs), lib/booking-db/pool.js (pg).
// NONE of the execution closure (run-core, run-core-abort-v2, transports, exchange, journals) is reachable. Report-only: reads ONLY the
// report login (mv_booking_report); never requires/reads an app login. Nothing secret is ever printed.
//
// R1 — endpoint gate is a LEXICAL URL-text gate, NOT proof of server role/auth: it pins the DIRECT DEV endpoint and the exact URL username
//   before any pool is built. The session-pooler is REFUSED by this CLI pending separate pooler-reset review. Actual role / privilege is
//   enforced server-side (Postgres) and by the merged live preflight L1 — this gate does not replace that.
// R2 — the precheck result and the teardown are reported SEPARATELY; a cleanup that is not confirmed yields a NONZERO terminal exit even
//   after LOCK_PRECHECK_CLEAR. pool.end runs exactly once (no retry). Timers are REFERENCED until the CLI has emitted, so a hung connect /
//   query / pool.end cannot let the event loop drain before a result is printed. The overall deadline bounds ONLY the precheck + teardown;
//   it is armed AFTER the synchronous CA read and the (size-bounded, not time-bounded) credential read, which it does not bound.
import { readFileSync } from "node:fs";
import { constants as FS_CONSTANTS } from "node:fs";
import process from "node:process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { lockPrecheck, LOCK_PRECHECK_CONNECT_MS, LOCK_PRECHECK_QUERY_MS } from "./run-lock-precheck.mjs";
import { readOneDbLogin } from "./db-credential-file.mjs";
import { createNativeAdapters } from "./probe-cli-main.mjs";
import { createBookingPool, resolveBookingTarget } from "../../lib/booking-db/pool.js";

export const SCHEMA = "e7-p3-precheck-cli-v1";
export const CA_SHA256_PIN = "700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7"; // Supabase Root 2021 CA (run3 anchor, ledger §16)
export const MAX_CA_BYTES = 65_536;
export const POOL_END_BOUND_MS = 10_000;
export const OVERALL_DEADLINE_MS = LOCK_PRECHECK_CONNECT_MS + LOCK_PRECHECK_QUERY_MS + 2_000;
export const POOL_MAX = 1;
export const STATEMENT_TIMEOUT_MS = LOCK_PRECHECK_QUERY_MS;
// The file's role label is mv_booking_report (a NOLOGIN permission role). The existing DEV login below inherits only that role;
// its LOGIN/INHERIT flags, membership, and absence of administrative flags were verified from DEV catalogs on 2026-11-10.
// The endpoint remains drift-guarded against the launcher. The pooler host is intentionally NOT accepted here.
export const DIRECT_HOST = "db.mxotevtiscernhqilyiu.supabase.co";
export const REQUIRED_PORT = "5432";
export const REQUIRED_DB_PATH = "/postgres";
export const REQUIRED_REPORT_USER = "mv_booking_report_dev";
export const EXIT = Object.freeze({
  CLEAR: 0, INTERNAL: 1, USAGE: 2, PLATFORM_OR_CA: 3, CRED_OR_CONNSTRING: 4, PRECHECK_UNAVAILABLE: 6, INTERRUPTED: 7, RUN_LOCK_PRESENT: 8, HELD: 9, CLEANUP_UNCONFIRMED: 10
});

const freeze = Object.freeze;

/** strict argument parse → { ok:true, flags } | { ok:false }. Required: --report-login, --ca, --repo-root. Optional: --k <int≥1>, --confirm-prereqs-met. */
export function parseArgs(argv) {
  const flags = { reportLogin: null, ca: null, repoRoot: null, k: 1, confirm: false };
  const need = new Map([["--report-login", "reportLogin"], ["--ca", "ca"], ["--repo-root", "repoRoot"]]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--confirm-prereqs-met") { flags.confirm = true; continue; }
    if (a === "--k") { const v = argv[++i]; const n = Number(v); if (!Number.isSafeInteger(n) || n < 1 || n > 1000) return { ok: false }; flags.k = n; continue; }
    if (need.has(a)) { const v = argv[++i]; if (typeof v !== "string" || v === "" || v.startsWith("--")) return { ok: false }; flags[need.get(a)] = v; continue; }
    return { ok: false };
  }
  if (!flags.reportLogin || !flags.ca || !flags.repoRoot) return { ok: false };
  return { ok: true, flags };
}

/**
 * R1 LEXICAL gate on the connection-string URL → null if it is the exact DIRECT report endpoint, else a refusal code. Uses the WHATWG URL
 * parser; the username comparison is RAW (not decoded), so any percent-encoding, the app/postgres user, or the JSON role label all refuse.
 * A single bare host match defeats userinfo "@" ambiguity (a second host makes u.hostname differ). This is URL text only — NOT server auth.
 */
export function gateDirectReportUrl(cs) {
  let u; try { u = new URL(cs); } catch { return "CONNSTRING_REJECTED"; }
  if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") return "ENDPOINT_REFUSED";
  if (u.hostname !== DIRECT_HOST) return "ENDPOINT_HOST_REFUSED";          // pooler and everything else refused for this P3 CLI
  if (u.port !== REQUIRED_PORT) return "ENDPOINT_PORT_REFUSED";
  if (u.pathname !== REQUIRED_DB_PATH) return "ENDPOINT_DB_REFUSED";
  if (u.username !== REQUIRED_REPORT_USER) return "ENDPOINT_USER_REFUSED"; // raw exact: rejects app/postgres/encoded user and the JSON label
  if (u.password === "") return "ENDPOINT_USER_REFUSED";
  if (u.search !== "" || u.hash !== "") return "CONNSTRING_REJECTED";      // no query (ssl.* etc.), no fragment
  return null;
}

/** real timer seam for lockPrecheck. R2: timers are REFERENCED so a hung connect/query keeps the loop alive until the bound fires and we emit. */
export function realProc() {
  return { setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (t) => clearTimeout(t) };
}
/** R2: bounded, single-shot pool teardown; NEVER retried. Resolves "POOL_ENDED" | "POOL_END_UNCONFIRMED" (uncertainty is explicit). Default
 *  timers are REFERENCED so an unresolved pool.end still fires the bound and lets the CLI emit; the timer is cleared the moment end settles. */
export function endPoolBounded(pool, { setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = clearTimeout } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const settle = (v) => { if (!done) { done = true; try { clearTimer(t); } catch { /* */ } resolve(v); } };
    const t = setTimer(() => { if (!done) { done = true; resolve("POOL_END_UNCONFIRMED"); } }, POOL_END_BOUND_MS);
    let p; try { p = Promise.resolve(pool && typeof pool.end === "function" ? pool.end() : undefined); } catch { settle("POOL_END_UNCONFIRMED"); return; }
    p.then(() => settle("POOL_ENDED"), () => settle("POOL_END_UNCONFIRMED"));
  });
}

/**
 * runP3Precheck({ argv, deps }) → Promise<{ exit, result }>, never rejects. deps injectable for OFFLINE tests; production defaults wire the
 * reviewed infrastructure. `result` is the ONLY thing printed: whitelisted fields, never a secret (connection strings are non-enumerable).
 */
export async function runP3Precheck({ argv, deps }) {
  const d = withDefaults(deps);
  const emit = (exit, result) => ({ exit, result: freeze({ schema: SCHEMA, ...result }) });
  const parsed = parseArgs(argv);
  if (!parsed.ok) return emit(EXIT.USAGE, { code: "USAGE", usage: "run-p3-precheck-cli --report-login <path> --ca <path> --repo-root <path> [--k <int>] [--confirm-prereqs-met]" });
  const { flags } = parsed;

  const platform = d.platform;
  if (platform !== "linux" && platform !== "darwin") return emit(EXIT.PLATFORM_OR_CA, { code: "PLATFORM_UNSUPPORTED", platform });

  // CA: bounded read + raw-byte sha256 pin BEFORE any pool. (This read is size-bounded, not bounded by the precheck deadline below.)
  let caBytes; try { caBytes = d.readCaBytes(flags.ca); } catch { return emit(EXIT.CRED_OR_CONNSTRING, { code: "CA_UNREADABLE" }); }
  if (!caBytes || caBytes.length === 0 || caBytes.length > MAX_CA_BYTES) return emit(EXIT.CRED_OR_CONNSTRING, { code: "CA_UNREADABLE" });
  if (createHash("sha256").update(caBytes).digest("hex") !== CA_SHA256_PIN) return emit(EXIT.PLATFORM_OR_CA, { code: "CA_PIN_MISMATCH" });
  const caPem = caBytes.toString("utf8");

  // report login: ONE slot, reviewed reader; no app credential. (The reader's read is size-bounded, not time-bounded by the deadline below.)
  let uid; try { uid = d.getuid(); } catch { return emit(EXIT.INTERNAL, { code: "NO_UID" }); }
  if (!Number.isSafeInteger(uid) || uid < 0) return emit(EXIT.INTERNAL, { code: "NO_UID" });
  const fs = d.makeCredentialFs({ platform, uid });
  const dbr = await d.readReportLogin({ path: flags.reportLogin, repoRoot: flags.repoRoot, fs, slot: "report" });
  if (!dbr.ok) return emit(EXIT.CRED_OR_CONNSTRING, { code: dbr.code });           // DB_/CRED_ code — no secret
  const cs = dbr.login.connectionString;                                           // non-enumerable; used only to gate + build the pool

  // R1: exact DIRECT report-endpoint gate (lexical), then the reviewed resolver as defense-in-depth (rejects ssl.* / ambiguous ?host=).
  const gate = gateDirectReportUrl(cs);
  if (gate) return emit(gate === "CONNSTRING_REJECTED" ? EXIT.CRED_OR_CONNSTRING : EXIT.PLATFORM_OR_CA, { code: gate });
  let target; try { target = resolveBookingTarget(cs); } catch { return emit(EXIT.CRED_OR_CONNSTRING, { code: "CONNSTRING_REJECTED" }); }
  if (target.host !== DIRECT_HOST || target.local) return emit(EXIT.PLATFORM_OR_CA, { code: "ENDPOINT_HOST_REFUSED" });

  // build the pool (construction does NOT connect): remote→caPem enforced; ssl={rejectUnauthorized:true, ca}.
  let pool; try { pool = d.makePool({ connectionString: cs, caPem, max: POOL_MAX, statementTimeoutMs: STATEMENT_TIMEOUT_MS }); }
  catch { return emit(EXIT.CRED_OR_CONNSTRING, { code: "POOL_CONFIG_REJECTED" }); }

  // HELD gate: without confirmation we DO NOT connect; tear the (unconnected) pool down and report validation only.
  if (!flags.confirm) {
    const cleanup = await endPoolBounded(pool, d.poolEndTimers);
    const exit = cleanup === "POOL_ENDED" ? EXIT.HELD : EXIT.CLEANUP_UNCONFIRMED;
    return emit(exit, { code: "VALIDATED_HELD", caPinned: true, poolConfigAccepted: true, connected: false, cleanup });
  }

  // confirmed: bounded read-only precheck (CONNECTS), then teardown. Precheck result and cleanup are reported SEPARATELY (R2).
  const proc = d.makeProc();
  const { signal, cancel } = d.makeSignal(OVERALL_DEADLINE_MS);
  let code;
  try { ({ code } = await lockPrecheck(pool, { proc, K: flags.k, signal })); }
  catch { code = "LOCK_PRECHECK_UNAVAILABLE"; }                                     // lockPrecheck never rejects; defensive only
  finally { try { cancel(); } catch { /* */ } }
  const cleanup = await endPoolBounded(pool, d.poolEndTimers);
  const precheckExit = code === "LOCK_PRECHECK_CLEAR" ? EXIT.CLEAR
    : code === "RUN_LOCK_PRESENT_BEFORE_START" ? EXIT.RUN_LOCK_PRESENT
    : code === "LOCK_PRECHECK_INTERRUPTED" ? EXIT.INTERRUPTED
    : EXIT.PRECHECK_UNAVAILABLE;
  // R2: a teardown that is not confirmed is a terminal failure that OVERRIDES a CLEAR precheck's exit 0.
  const exit = cleanup === "POOL_ENDED" ? precheckExit : EXIT.CLEANUP_UNCONFIRMED;
  return emit(exit, { code, caPinned: true, connected: true, cleanup });
}

function withDefaults(deps) {
  const base = {
    platform: process.platform,
    getuid: () => (typeof process.getuid === "function" ? process.getuid() : -1),
    now: () => Date.now(),
    readCaBytes: (p) => readFileSync(p),
    makeCredentialFs: ({ platform, uid }) => createNativeAdapters({ platform, uid, constants: FS_CONSTANTS, gate: () => {} }).credentialFs,
    readReportLogin: (args) => readOneDbLogin(args),
    makePool: (cfg) => createBookingPool(cfg),
    makeProc: () => realProc(),
    // R2: the deadline timer is REFERENCED so the process stays alive to emit even if the precheck hangs; cancel() clears it after settle.
    makeSignal: (ms) => { const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms); return { signal: ac.signal, cancel: () => clearTimeout(t) }; },
    poolEndTimers: undefined
  };
  return { ...base, ...(deps || {}) };
}

// ---- direct-run entry: print exactly one whitelisted JSON line, then exit explicitly (R2: emit precedes exit) --------------------------
async function main() {
  const { exit, result } = await runP3Precheck({ argv: process.argv.slice(2), deps: null });
  process.stdout.write(JSON.stringify(result) + "\n");
  process.exit(exit);
}
if (process.argv[1]) { try { if (import.meta.url === pathToFileURL(process.argv[1]).href) main(); } catch { /* not a direct run */ } }
