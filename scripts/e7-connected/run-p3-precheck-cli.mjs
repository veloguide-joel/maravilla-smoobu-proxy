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
// O1 — sanitized failure OBSERVABILITY (schema v2): a CLI-local, transparent instrumented pool/client adapter is passed to the UNCHANGED leaf.
//   It only OBSERVES the leaf's own calls (pool.connect, client.on/removeListener("error"), client.query, client.release) and forwards each
//   one with the same receiver, arguments, return value, thrown error and rejection reason. It adds NO SQL, probe, auth attempt, retry,
//   fallback, timer or listener, and changes no bound / release / late-client / error-veto behaviour. The leaf result `code`, the exit and
//   `cleanup` stay authoritative. `connected` is now TRUE ONLY IF a client was actually acquired before the leaf settled (v1 hard-coded true).
//   Failure causes are reported ONLY as closed-enum labels from an allowlist of known own-data `code` strings (SQLSTATE / network / TLS);
//   everything else → "OTHER". Error message / stack / detail / host / user / URL are never read or emitted.
import { readFileSync } from "node:fs";
import { constants as FS_CONSTANTS } from "node:fs";
import process from "node:process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { types as utilTypes } from "node:util";
import { lockPrecheck, LOCK_PRECHECK_CONNECT_MS, LOCK_PRECHECK_QUERY_MS } from "./run-lock-precheck.mjs";
import { readOneDbLogin } from "./db-credential-file.mjs";
import { createNativeAdapters } from "./probe-cli-main.mjs";
import { createBookingPool, resolveBookingTarget } from "../../lib/booking-db/pool.js";

export const SCHEMA = "e7-p3-precheck-cli-v2";
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
const apply = Reflect.apply;

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

// ---- O1: sanitized failure observability (CLI-local; the leaf is unchanged) -------------------------------------------------------------
// Closed allowlist: exact known error `code` strings → safe labels. Anything else (absent, accessor, non-string, unknown) → "OTHER".
const CLASS_BY_CODE = new Map([
  // network / DNS (Node system errors)
  ["ENETUNREACH", "NET_UNREACHABLE"], ["EHOSTUNREACH", "NET_HOST_UNREACHABLE"], ["ECONNREFUSED", "NET_REFUSED"], ["ECONNRESET", "NET_RESET"],
  ["ETIMEDOUT", "NET_TIMEOUT"], ["EPIPE", "NET_BROKEN_PIPE"], ["EADDRNOTAVAIL", "NET_ADDR_UNAVAILABLE"],
  ["ENOTFOUND", "DNS_NOT_FOUND"], ["EAI_AGAIN", "DNS_TEMPORARY"],
  // TLS verification / handshake
  ["SELF_SIGNED_CERT_IN_CHAIN", "TLS_UNTRUSTED_CHAIN"], ["DEPTH_ZERO_SELF_SIGNED_CERT", "TLS_UNTRUSTED_CHAIN"],
  ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "TLS_UNTRUSTED_CHAIN"], ["UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "TLS_UNTRUSTED_CHAIN"],
  ["CERT_HAS_EXPIRED", "TLS_CERT_EXPIRED"], ["CERT_NOT_YET_VALID", "TLS_CERT_NOT_YET_VALID"], ["ERR_TLS_CERT_ALTNAME_INVALID", "TLS_NAME_MISMATCH"],
  ["EPROTO", "TLS_PROTOCOL"], ["ERR_SSL_WRONG_VERSION_NUMBER", "TLS_PROTOCOL"],
  // PostgreSQL SQLSTATE (server-reported)
  ["28P01", "AUTH_CREDENTIAL_REJECTED"], ["28000", "AUTH_NOT_AUTHORIZED"], ["3D000", "DB_NOT_FOUND"],
  ["53300", "SERVER_TOO_MANY_CONNECTIONS"], ["57P03", "SERVER_NOT_ACCEPTING"], ["57P01", "SERVER_ADMIN_SHUTDOWN"],
  ["08006", "SERVER_CONNECTION_FAILURE"], ["08001", "SERVER_UNABLE_TO_CONNECT"], ["08004", "SERVER_REJECTED_CONNECTION"],
  ["08P01", "SERVER_PROTOCOL_VIOLATION"], ["42501", "QUERY_PRIVILEGE_DENIED"], ["57014", "QUERY_CANCELED"]
]);
export const FAILURE_CLASSES = freeze([...new Set(CLASS_BY_CODE.values()), "OTHER"]);
export const OBS_PHASES = freeze(["NOT_ATTEMPTED", "CONNECT_THROWN", "CONNECT_REJECTED", "CONNECT_INVALID_CLIENT", "CONNECT_PENDING", "CLIENT_ERROR",
  "ACQUIRED_NO_QUERY", "QUERY_THROWN", "QUERY_REJECTED", "QUERY_PENDING", "QUERY_RESULT_INVALID", "QUERY_RESULT_IGNORED", "QUERY_OK"]);
export const LATE_CLIENT = freeze(["NONE", "RELEASED", "NOT_RELEASED"]);

/** classifyFailure(e) → a FAILURE_CLASSES label. Reads ONLY an own DATA property `code` (no getter, no proxy trap, no message/stack). */
export function classifyFailure(e) {
  try {
    if (e === null || (typeof e !== "object" && typeof e !== "function") || utilTypes.isProxy(e)) return "OTHER";
    const d = Object.getOwnPropertyDescriptor(e, "code");
    if (!d || !("value" in d) || typeof d.value !== "string") return "OTHER";
    return CLASS_BY_CODE.get(d.value) ?? "OTHER";
  } catch { return "OTHER"; }
}

/**
 * instrumentPool(pool) → { pool, snapshot(code), lateClient() }. `pool` is a transparent stand-in exposing ONLY connect(); each acquired
 * client is wrapped exposing ONLY the methods the real client has among on / removeListener / query / release (mirroring the leaf's optional
 * calls). Observations are recorded only until snapshot() (taken immediately after the leaf settles), then frozen; afterwards only late-client
 * disposal is tracked. Errors are re-thrown / re-rejected as the SAME object; resolved values are the SAME object.
 */
export function instrumentPool(pool) {
  const st = { connectAttempted: false, connectSettled: false, acquired: false, queryAttempted: false, querySettled: false,
    queryResolved: false, queryResolvedWhileHeld: false, failure: null, snap: null };
  const late = [];
  const open = () => st.snap === null;
  const fail = (phase, e) => { if (open() && st.failure === null) st.failure = freeze({ phase, failureClass: classifyFailure(e) }); };
  function wrapClient(c, isLate) {
    // releaseCalled: the leaf has started disposal (its settle / stop signal; used for held-state semantics).
    // disposed: release RETURNED without throwing (the only thing that confirms a late client's disposal).
    const rec = { releaseCalled: false, disposed: false };
    if (isLate) late.push(rec);
    const errWrappers = new Map();                                      // leaf listener → our forwarding wrapper (same count, same timing)
    const w = {};
    if (typeof c.on === "function") w.on = function (ev, fn) {
      let f = fn;
      if (ev === "error" && typeof fn === "function") {
        f = errWrappers.get(fn);
        if (!f) { f = function (...a) { if (!isLate && !rec.releaseCalled) fail("CLIENT_ERROR", a[0]); return apply(fn, this, a); }; errWrappers.set(fn, f); }
      }
      const r = c.on(ev, f); return r === c ? w : r;
    };
    if (typeof c.removeListener === "function") w.removeListener = function (ev, fn) {
      const f = ev === "error" && errWrappers.has(fn) ? errWrappers.get(fn) : fn;
      const r = c.removeListener(ev, f); return r === c ? w : r;
    };
    if (typeof c.release === "function") w.release = function (...a) { rec.releaseCalled = true; const r = c.release(...a); rec.disposed = true; return r; };
    if (typeof c.query === "function") w.query = function (...a) {
      if (!isLate && open()) st.queryAttempted = true;
      let r;
      try { r = c.query(...a); }
      catch (e) { if (!isLate && open()) { st.querySettled = true; fail("QUERY_THROWN", e); } throw e; }
      return Promise.resolve(r).then(
        (res) => { if (!isLate && open()) { st.querySettled = true; st.queryResolved = true; st.queryResolvedWhileHeld = !rec.releaseCalled; } return res; },
        (e) => { if (!isLate && open()) { st.querySettled = true; fail("QUERY_REJECTED", e); } throw e; });
    };
    return w;
  }
  const wrapped = freeze({
    connect() {
      if (open()) st.connectAttempted = true;
      let p;
      try { p = pool.connect(); }
      catch (e) { if (open()) { st.connectSettled = true; fail("CONNECT_THROWN", e); } throw e; }
      return Promise.resolve(p).then((c) => {
        const isLate = !open();
        if (c === null || typeof c !== "object") {                     // not a client: pass through unwrapped (leaf behaviour unchanged)
          if (!isLate) { st.connectSettled = true; fail("CONNECT_INVALID_CLIENT", null); }
          return c;
        }
        if (!isLate) { st.connectSettled = true; st.acquired = true; }
        return wrapClient(c, isLate);
      }, (e) => { if (open()) { st.connectSettled = true; fail("CONNECT_REJECTED", e); } throw e; });
    }
  });
  function phaseOf(code) {
    if (st.failure) return st.failure;
    const p = (phase) => freeze({ phase, failureClass: null });
    if (!st.connectAttempted) return p("NOT_ATTEMPTED");
    if (!st.connectSettled) return p("CONNECT_PENDING");
    if (!st.queryAttempted) return p("ACQUIRED_NO_QUERY");
    if (!st.querySettled) return p("QUERY_PENDING");
    if (code === "LOCK_PRECHECK_CLEAR" || code === "RUN_LOCK_PRESENT_BEFORE_START") return p("QUERY_OK");
    return p(st.queryResolvedWhileHeld ? "QUERY_RESULT_INVALID" : "QUERY_RESULT_IGNORED");
  }
  return {
    pool: wrapped,
    snapshot(code) {
      if (st.snap === null) {
        const { phase, failureClass } = phaseOf(code);
        st.snap = freeze({ connectionAttempted: st.connectAttempted, clientAcquired: st.acquired, queryAttempted: st.queryAttempted,
          queryCompleted: st.queryResolved, phase, failureClass });
      }
      return st.snap;
    },
    lateClient: () => (late.length === 0 ? "NONE" : late.every((r) => r.disposed) ? "RELEASED" : "NOT_RELEASED")
  };
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
  const inst = instrumentPool(pool);                                               // O1: transparent observation only
  let code;
  try { ({ code } = await lockPrecheck(inst.pool, { proc, K: flags.k, signal })); }
  catch { code = "LOCK_PRECHECK_UNAVAILABLE"; }                                     // lockPrecheck never rejects; defensive only
  finally { try { cancel(); } catch { /* */ } }
  const obs = inst.snapshot(code);                                                 // frozen at leaf settlement
  const cleanup = await endPoolBounded(pool, d.poolEndTimers);                     // the REAL pool is ended (unchanged)
  const precheckExit = code === "LOCK_PRECHECK_CLEAR" ? EXIT.CLEAR
    : code === "RUN_LOCK_PRESENT_BEFORE_START" ? EXIT.RUN_LOCK_PRESENT
    : code === "LOCK_PRECHECK_INTERRUPTED" ? EXIT.INTERRUPTED
    : EXIT.PRECHECK_UNAVAILABLE;
  // R2: a teardown that is not confirmed is a terminal failure that OVERRIDES a CLEAR precheck's exit 0.
  const exit = cleanup === "POOL_ENDED" ? precheckExit : EXIT.CLEANUP_UNCONFIRMED;
  return emit(exit, { code, caPinned: true, connected: obs.clientAcquired, observation: freeze({ ...obs, lateClient: inst.lateClient() }), cleanup });
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
