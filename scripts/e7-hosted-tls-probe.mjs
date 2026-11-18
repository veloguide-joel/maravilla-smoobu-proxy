// scripts/e7-hosted-tls-probe.mjs — Stage E7 C112: READ-ONLY hosted TLS PROBE (both hops) for the DEV booking database.
//
// PURPOSE: before any booking run, prove with the EXISTING app credential and the pinned Supabase CA, through the SAME pooler target the
// hosted runners use, that BOTH TLS hops are protected:
//   (a) CLIENT hop (runner → shared pooler): the merged C112 rule clientTlsRefusal() (scripts/e7-hosted-kickoff.mjs) on EACH acquired
//       client's OWN socket, BEFORE its first statement — authorized TLS 1.2/1.3 handshake, no resumed session, peer certificate re-checked
//       for the reviewed pooler host, rejectUnauthorized:true with the pinned CA bytes;
//   (b) BACKEND hop (pooler → Postgres): the server-reported pg_stat_ssl.ssl of the backend serving that sample's read-only transaction.
// EXACTLY five samples. Each sample is a FRESH connection (a socket never seen before in this run), destroyed after use, never reused:
//   evidence check → BEGIN READ ONLY → ONE fixed read-only SELECT (role / TEST identity / backend ssl / server version / read-only) → ROLLBACK
//   → destroy. PASS only if all five samples prove client hop AND backend hop AND identity AND read-only. The first failing sample STOPs the
//   run (fail closed; no retry, no further sample, no unbounded wait). Missing or unknown evidence is a failure.
// WHAT IT NEVER DOES: no write (read-only transactions, always rolled back), no consumer, no claim, no request / intent access beyond the
// identity row booking.instance, no dispatch, no GitHub token, no provider call / provider secret, no arbitrary SQL / target / credential /
// TLS input (the only workflow input is the expected source digest), no retry. Output = fixed booleans / counts / value-free reason codes
// (never a URL, host, user, pid, certificate field or server text).
//
// MODES (workflow_dispatch only): `preflight` (default; no environment, no secret, no database, no install: digests + the focused FAKE tests,
// which must ALL pass with ZERO skips), `verify` (no secret: main + exact SHA + source digest), `probe` (main only, the existing
// `e7-readonly-probe` environment gate; the existing DB secret NAME + the pinned CA in the FINAL step only).
// GATE: CONSTANTS.probeEnabled. This runner has no write / dispatch capability; the reviewer gate + main-only + exact source digest are the
// execution controls. Booking runners' executeEnabled / dispatchEnabled flags are untouched (all CLOSED).
//
// The ONLY top-level effect is the guarded main() at the bottom.
import process from "node:process";
import { readFile, realpath } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import * as K from "./e7-hosted-kickoff.mjs";

const freeze = Object.freeze;
const deepFreeze = (o) => { for (const v of Object.values(o)) if (v && typeof v === "object" && !Object.isFrozen(v)) deepFreeze(v); return freeze(o); };
const KC = K.CONSTANTS;

export const CONSTANTS = deepFreeze({
  probeEnabled: true,                                                // read-only probe; reviewer gate + main + exact source digest control it
  samples: 5,                                                        // EXACTLY five fresh connections; all five must prove both hops
  toolingCommit: KC.toolingCommit, toolingStatus: KC.toolingStatus,  // C119 S4: 71750f58 DRAFT_HEAD (inherited from the kickoff → this probe refuses until the repin; C116 66133a22 MERGED)
  closure: KC.closure, closureDigest: KC.closureDigest,              // C119 S4: 573dae82… (inherited; C116 e180398f…) (createBookingPool + the pinned pg lockfile are inside it)
  tls: KC.tls,                                                       // { host: aws-0-us-east-1.pooler.supabase.com, caSha256: OFFICIAL_CA_SHA256 }
  dbProjectRef: KC.dbProjectRef, environment: KC.environment, nodeVersion: KC.nodeVersion, pgVersion: KC.pgVersion,
  budgets: { runMs: 60000, teardownMs: 5000, connectMs: 8000, statementMs: 6000, dbQueries: 15 }   // 5 × (BEGIN, SELECT, ROLLBACK)
});
export const SOURCE_PREFIX = "e7-hosted-tls-probe-v1\n";
export const RUNNER_FILES = freeze(["scripts/e7-hosted-tls-probe.mjs", "test/e7-hosted-tls-probe.test.mjs", "test/e7-hosted-tls-probe-workflow.test.mjs",
  ".github/workflows/e7-hosted-tls-probe.yml", "scripts/e7-hosted-kickoff.mjs"]);           // the imported kickoff runner (clientTlsRefusal) is framed too
export const TEST_FILES = freeze(["test/e7-hosted-tls-probe.test.mjs", "test/e7-hosted-tls-probe-workflow.test.mjs"]);
export const SECRET_KEYS = freeze(["E7_DEV_BOOKING_DATABASE_URL"]);
export const ALLOWED_E7_KEYS = freeze(["E7_TOOLING_DIR", "E7_EXPECTED_SOURCE_DIGEST", "E7_WORKFLOW_SHA", "E7_RUN_ID", "E7_CA_FILE", ...SECRET_KEYS]);
export const HOSTED_CODES = freeze(["HTP_USAGE", "HTP_INPUT_UNEXPECTED", "HTP_PROBE_CLOSED", "HTP_SECRET_SCOPE_VIOLATION", "HTP_INPUT_INCOMPLETE", "HTP_INPUT_INVALID",
  "HTP_REF_NOT_MAIN", "HTP_BINDING_MISMATCH", "HTP_CLOSURE_MISMATCH", "HTP_LAYOUT_INVALID", "HTP_SOURCE_UNREADABLE", "HTP_SOURCE_MISMATCH", "HTP_DEPENDENCY_MISMATCH",
  "HTP_IMPORT_FAILED", "HTP_ENV_REFUSED", "HTP_CHILD_FAILED", "HTP_TESTS_FAILED", "HTP_CREDENTIALS_MISSING", "HTP_DB_TARGET_INVALID", "HTP_CA_INVALID"]);
/** the ONLY statements; fixed text, no parameters */
export const QUERIES = freeze({
  begin: "BEGIN READ ONLY",
  probe: `/*e7tlsprobe*/ SELECT pg_has_role(current_user, 'mv_booking_app', 'MEMBER') AS is_app, pg_has_role(current_user, 'mv_booking_admin', 'MEMBER') AS is_admin,
    (SELECT rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb FROM pg_roles WHERE rolname = current_user) AS privileged,
    (SELECT pg_has_role(current_user, n.nspowner, 'MEMBER') FROM pg_namespace n WHERE n.nspname = 'booking') AS owns_schema,
    (SELECT s.ssl FROM pg_stat_ssl s WHERE s.pid = pg_backend_pid()) AS backend_ssl, current_setting('server_version_num')::int AS server_version_num,
    current_setting('transaction_read_only') AS tx_read_only, (SELECT environment FROM booking.instance) AS environment, pg_backend_pid() AS backend_pid`,
  rollback: "ROLLBACK"
});

const HEX64 = /^[0-9a-f]{64}$/; const HEX40 = /^[0-9a-f]{40}$/; const RUN_ID_RE = /^[A-Za-z0-9._:-]{8,64}$/;
const CODE_RE = /^[A-Za-z0-9_:>!.-]{1,96}$/;
const code = (v, fb) => (typeof v === "string" && CODE_RE.test(v) ? v : fb);
const sha = (s) => createHash("sha256").update(s).digest("hex");
class Refusal extends Error { constructor(c) { super("refused"); this.code = c; } }
const refuse = (c) => { throw new Refusal(c); };

/** sample verdict from the ONE row (null = proven; otherwise a value-free reason). Unknown / missing fields fail. */
export function sampleRefusal(row, c = CONSTANTS) {
  if (!row || typeof row !== "object") return "NO_ROW";
  if (row.is_app !== true || row.is_admin !== false || row.privileged !== false || row.owns_schema !== false) return "ROLE_REFUSED";
  if (row.environment !== c.environment) return "NOT_TEST";
  if (!Number.isSafeInteger(row.server_version_num) || row.server_version_num < 160000 || row.server_version_num >= 180000) return "SERVER_VERSION_REFUSED";
  if (row.tx_read_only !== "on") return "NOT_READ_ONLY";
  if (row.backend_ssl !== true) return "BACKEND_NOT_SSL";
  return null;
}

/**
 * runProbeCore({ pool, constants?, timer?, clearTimer?, runSignal? }) → result. Never throws. ONE seal (wall deadline / abort / connect or
 * statement timeout) destroys every tracked client, refuses late statements and destroys late clients unused.
 */
export async function runProbeCore(input) {
  const c = (input && input.constants) ?? CONSTANTS; const B = c.budgets;
  const r = { schema: "e7-hosted-tls-probe-core-v1", outcome: null, code: null, samplesRequired: c.samples, samplesAttempted: 0, samplesProven: 0,
    clientVerified: 0, backendSsl: 0, identityOk: 0, readOnly: 0, rolledBack: 0, freshConnections: 0, distinctBackends: 0, clientsDestroyed: 0,
    lateClientsDestroyed: 0, dbQueries: 0, sealed: false, sealReason: null, failedSample: null };
  let finalized = false;
  const done = (outcome, k) => { if (!finalized) { finalized = true; r.outcome = outcome; r.code = code(String(k), "CODE"); } return r; };
  const setT = input && typeof input.timer === "function" ? input.timer : (fn, ms) => setTimeout(fn, ms);
  const clearT = input && typeof input.clearTimer === "function" ? input.clearTimer : (h) => clearTimeout(h);
  const hooks = new Set(); const tracked = new Set(); let deadlineH = null;
  class Stopped extends Error { constructor() { super("stopped"); this.code = "STOPPED"; } }
  class Timeout extends Error { constructor(k) { super("timeout"); this.code = k; } }
  const destroy = (t) => { if (!t || t.released) return; t.released = true; tracked.delete(t); r.clientsDestroyed += 1; try { t.cl.release(true); } catch { /* contained */ } };
  const seal = (why) => {
    if (r.sealed) return;
    r.sealed = true; r.sealReason = code(String(why), "SEALED");
    for (const fn of [...hooks]) { try { fn(); } catch { /* ignore */ } }
    hooks.clear(); for (const t of [...tracked]) destroy(t);
  };
  const supervise = (p, ms, onTimeout, k) => new Promise((resolve, reject) => {
    const pp = Promise.resolve(p);
    if (r.sealed) { pp.catch(() => {}); reject(new Stopped()); return; }
    let settled = false; let th = null;
    const fin = (fn) => { if (settled) return; settled = true; hooks.delete(onSeal); if (th !== null) { try { clearT(th); } catch { /* ignore */ } } fn(); };
    const onSeal = () => fin(() => reject(new Stopped()));
    hooks.add(onSeal);
    th = setT(() => fin(() => { try { onTimeout(); } catch { /* ignore */ } reject(new Timeout(k)); }), ms);
    pp.then((v) => fin(() => (r.sealed ? reject(new Stopped()) : resolve(v))), (e) => fin(() => reject(r.sealed ? new Stopped() : e)));
  });
  try {
    const pool = input && input.pool;
    if (c.probeEnabled !== true) return done("FAIL", "PROBE_CLOSED");
    if (!pool || typeof pool.connect !== "function" || !Number.isSafeInteger(c.samples) || c.samples !== 5) return done("FAIL", "CORE_INVALID");
    deadlineH = setT(() => seal("DEADLINE"), B.runMs - B.teardownMs);
    if (input.runSignal && typeof input.runSignal.addEventListener === "function") input.runSignal.addEventListener("abort", () => seal("ABORTED"), { once: true });
    if (input.runSignal && input.runSignal.aborted) seal("ABORTED");
    const seen = new Set(); const pids = new Set();
    for (let i = 1; i <= c.samples; i += 1) {
      if (r.sealed) return done("FAIL", `SEALED:${r.sealReason}`);
      r.samplesAttempted = i; r.failedSample = i;
      // ---- acquire: bounded; a late client is destroyed unused ----
      let lost = false; let t = null;
      const pc = Promise.resolve().then(() => pool.connect());
      pc.then((cl) => { if ((lost || r.sealed) && cl && !t) { r.lateClientsDestroyed += 1; try { cl.release(true); } catch { /* contained */ } } }, () => {});
      let cl;
      try { cl = await supervise(pc, B.connectMs, () => seal("DB_CONNECT_TIMEOUT"), "DB_CONNECT_TIMEOUT"); }
      catch (e) { lost = true; return done("FAIL", r.sealed ? `SEALED:${r.sealReason}` : `CONNECT_FAILED:${code(e && e.code, "ERR")}`); }
      if (!cl || typeof cl.query !== "function" || typeof cl.release !== "function") { lost = true; if (cl) { r.clientsDestroyed += 1; try { cl.release(true); } catch { /* contained */ } } return done("FAIL", "CLIENT_INVALID"); }
      t = { cl, released: false }; tracked.add(t);
      // ---- fresh + CLIENT hop BEFORE the first statement ----
      const stream = cl.connection && cl.connection.stream;
      if (!stream || seen.has(stream)) { destroy(t); return done("FAIL", "NOT_FRESH"); }
      seen.add(stream); r.freshConnections += 1;
      const why = K.clientTlsRefusal(cl, c.tls);
      if (why !== null) { destroy(t); return done("FAIL", `CLIENT_${code(why, "EVIDENCE_ERROR")}`); }
      r.clientVerified += 1;
      // ---- ONE bounded read-only transaction, always rolled back ----
      const q = (sql) => {
        if (r.sealed || t.released) return Promise.reject(new Stopped());
        if (r.dbQueries >= B.dbQueries) return Promise.reject(new Refusal("DB_BUDGET"));
        r.dbQueries += 1;
        let qp; try { qp = Promise.resolve(cl.query(sql)); } catch (e) { return Promise.reject(e); }
        return supervise(qp, B.statementMs, () => { destroy(t); seal("DB_STATEMENT_TIMEOUT"); }, "DB_STATEMENT_TIMEOUT");
      };
      let row = null; let began = false;
      try {
        await q(QUERIES.begin); began = true;
        const res = await q(QUERIES.probe);
        row = res && Array.isArray(res.rows) && res.rows.length === 1 ? res.rows[0] : null;
        await q(QUERIES.rollback); began = false; r.rolledBack += 1;
      } catch (e) {
        destroy(t);                                                  // a destroyed session rolls back any open read-only transaction
        return done("FAIL", r.sealed ? `SEALED:${r.sealReason}` : `SQL_FAILED:${code(e && e.code, "ERR")}${began ? ":IN_TX" : ""}`);
      }
      destroy(t);                                                    // never reused: the next sample must open a NEW connection
      const bad = sampleRefusal(row, c);
      if (row && row.tx_read_only === "on") r.readOnly += 1;
      if (row && row.backend_ssl === true) r.backendSsl += 1;
      if (row && sampleRefusal({ ...row, backend_ssl: true, tx_read_only: "on" }, c) === null) r.identityOk += 1;
      if (bad !== null) return done("FAIL", bad);
      if (Number.isSafeInteger(row.backend_pid)) pids.add(row.backend_pid);
      r.distinctBackends = pids.size; r.samplesProven += 1;
    }
    r.failedSample = null;
    const all = [r.clientVerified, r.backendSsl, r.identityOk, r.readOnly, r.rolledBack, r.freshConnections, r.samplesProven].every((n) => n === c.samples);
    return all ? done("PASS", "BOTH_HOPS_PROVEN") : done("FAIL", "INCOMPLETE");
  } catch (e) {
    return done("FAIL", r.sealed ? `SEALED:${r.sealReason}` : `CORE_INTERNAL:${code(e && e.code, "ERR")}`);
  } finally {
    if (deadlineH !== null) { try { clearT(deadlineH); } catch { /* ignore */ } }
    seal("CORE_END"); if (r.sealReason === "CORE_END") { r.sealed = false; r.sealReason = null; }
  }
}

async function readGitHead(wdir) { const t = (await readFile(`${wdir}/.git/HEAD`, "utf8")).trim(); return HEX40.test(t) ? t : null; }

/** runHosted({ mode, env, proc, wrapperDir, deps }) → { exitCode, result }. deps are TEST SEAMS only. */
export async function runHosted({ mode = "preflight", env, proc, wrapperDir, deps = {} }) {
  const c = deps.constants ?? CONSTANTS;
  const r = { schema: "e7-hosted-tls-probe-hosted-v1", mode: null, code: null, workflowSha: null, toolingCommit: c.toolingCommit, probeEnabled: c.probeEnabled,
    closureDigest: null, sourceDigest: null, envCode: null, tests: null, runId: null, core: null, cleanup: null };
  let pool = null;
  try {
    if (!["preflight", "verify", "probe"].includes(mode)) refuse("HTP_USAGE");
    r.mode = mode;
    const keys = Object.keys(env);                                                  // key NAMES only before the next gates
    if (keys.some((k) => k.startsWith("E7_") && !ALLOWED_E7_KEYS.includes(k))) refuse("HTP_INPUT_UNEXPECTED");
    if (mode !== "preflight" && c.probeEnabled !== true) refuse("HTP_PROBE_CLOSED");
    if (mode !== "probe" && SECRET_KEYS.some((k) => keys.includes(k))) refuse("HTP_SECRET_SCOPE_VIOLATION");
    const spawnChild = deps.spawnChild ?? K.spawnNode;
    const importEnv = deps.importEnv ?? ((dir) => import(pathToFileURL(`${dir}/scripts/e7-connected/probe-env-preflight.mjs`).href));
    const importPool = deps.importPool ?? ((dir) => import(pathToFileURL(`${dir}/lib/booking-db/pool.js`).href));
    const runCore = deps.runCore ?? runProbeCore;
    const readHead = deps.readHead ?? readGitHead;
    const readPgVersion = deps.readPgVersion ?? (async (dir) => JSON.parse(await readFile(`${dir}/node_modules/pg/package.json`, "utf8")).version);
    const readCa = deps.readCa ?? ((p) => readFile(p));
    r.workflowSha = HEX40.test(env.E7_WORKFLOW_SHA ?? "") ? env.E7_WORKFLOW_SHA : null;
    const expSrc = env.E7_EXPECTED_SOURCE_DIGEST ?? ""; const runId = env.E7_RUN_ID ?? "";
    if (mode !== "preflight") {
      if (c.toolingStatus !== "MERGED" || !HEX64.test(String(c.closureDigest))) refuse("HTP_CLOSURE_MISMATCH");
      if (!HEX64.test(expSrc)) refuse("HTP_INPUT_INCOMPLETE");
      if (!RUN_ID_RE.test(runId)) refuse("HTP_INPUT_INVALID");
      if (env.GITHUB_REF !== "refs/heads/main") refuse("HTP_REF_NOT_MAIN");
      if (r.workflowSha === null || env.GITHUB_SHA !== r.workflowSha) refuse("HTP_BINDING_MISMATCH");
    }
    const tooling = await realpath(env.E7_TOOLING_DIR ?? "").catch(() => refuse("HTP_LAYOUT_INVALID"));
    const wdir = await realpath(wrapperDir).catch(() => refuse("HTP_LAYOUT_INVALID"));
    if (tooling === wdir || tooling.startsWith(`${wdir}/`) || wdir.startsWith(`${tooling}/`)) refuse("HTP_LAYOUT_INVALID");
    r.closureDigest = await K.framedDigest(tooling, c.closure, K.CLOSURE_PREFIX).catch(() => refuse("HTP_SOURCE_UNREADABLE"));
    if (r.closureDigest !== c.closureDigest) refuse("HTP_CLOSURE_MISMATCH");
    if (K.lockedPgVersion(await readFile(`${tooling}/package-lock.json`, "utf8").catch(() => "")) !== c.pgVersion) refuse("HTP_DEPENDENCY_MISMATCH");
    r.sourceDigest = await K.framedDigest(wdir, RUNNER_FILES, SOURCE_PREFIX).catch(() => refuse("HTP_SOURCE_UNREADABLE"));
    if (mode !== "preflight") {
      if (r.sourceDigest !== expSrc) refuse("HTP_SOURCE_MISMATCH");
      let head = null; try { head = await readHead(wdir); } catch { head = null; }
      if (head !== r.workflowSha) refuse("HTP_BINDING_MISMATCH");
    }
    let C1; try { C1 = await importEnv(tooling); } catch { refuse("HTP_IMPORT_FAILED"); }
    const present = Object.fromEntries(C1.PRESENT_KEYS.map((k) => [k, Object.hasOwn(env, k)]));
    let uid = null; try { if (typeof proc.getuid === "function") { const u = proc.getuid(); if (Number.isSafeInteger(u) && u >= 0) uid = u; } } catch { uid = null; }
    const ev = C1.evaluateProbeEnvironment({ schema: C1.ENV_SNAPSHOT_SCHEMA, nodeVersion: String(proc.versions.node), platform: proc.platform,
      execArgvCount: proc.execArgv.length, uidAvailable: uid !== null, present });
    r.envCode = typeof ev.code === "string" && C1.ENV_CODES.includes(ev.code) ? ev.code : "REDACTED";
    if (ev.ok !== true || proc.versions.node !== c.nodeVersion) refuse("HTP_ENV_REFUSED");
    if (mode === "preflight") {
      const o = await spawnChild(["--test", "--test-reporter=tap", ...TEST_FILES], { cwd: wdir, env: K.childEnv(env, tooling) });
      if (!o || o.spawnFailed || (o.signal !== null && o.signal !== undefined) || !Number.isSafeInteger(o.status) || o.truncated) refuse("HTP_CHILD_FAILED");
      const num = (re) => { const m = re.exec(o.stdout); return m ? Number(m[1]) : null; };
      r.tests = { status: o.status, tests: num(/^# tests (\d+)$/m), pass: num(/^# pass (\d+)$/m), fail: num(/^# fail (\d+)$/m), skipped: num(/^# skipped (\d+)$/m) };
      if (o.status !== 0 || !(r.tests.tests > 0) || r.tests.pass !== r.tests.tests || r.tests.fail !== 0 || r.tests.skipped !== 0) refuse("HTP_TESTS_FAILED");
      r.code = "PREFLIGHT_OK"; return { exitCode: 0, result: r };
    }
    if (mode === "verify") { r.code = "VERIFY_OK"; return { exitCode: 0, result: r }; }
    // ---- probe: the ONLY step with the DB secret ----
    r.runId = runId;
    if (typeof env.E7_DEV_BOOKING_DATABASE_URL !== "string" || env.E7_DEV_BOOKING_DATABASE_URL.length === 0) refuse("HTP_CREDENTIALS_MISSING");
    let dbUrl = env.E7_DEV_BOOKING_DATABASE_URL; delete env.E7_DEV_BOOKING_DATABASE_URL;
    try {
      let pgv; try { pgv = await readPgVersion(tooling); } catch { pgv = null; }
      if (pgv !== c.pgVersion) refuse("HTP_DEPENDENCY_MISMATCH");
      if (!K.dbTargetOk(dbUrl, KC)) refuse("HTP_DB_TARGET_INVALID");
      let caPem = null;
      try { const b = await readCa(env.E7_CA_FILE ?? ""); if (b.length < 16384 && sha(b) === c.tls.caSha256) caPem = b.toString("utf8"); } catch { caPem = null; }
      if (caPem === null) refuse("HTP_CA_INVALID");
      let P; try { P = await importPool(tooling); } catch { refuse("HTP_IMPORT_FAILED"); }
      if (!P || typeof P.createBookingPool !== "function") refuse("HTP_IMPORT_FAILED");
      try { pool = P.createBookingPool({ connectionString: dbUrl, caPem, max: 1 }); } catch { refuse("HTP_DB_TARGET_INVALID"); }
      dbUrl = null;
      const ac = new AbortController(); const onSig = () => ac.abort(); proc.once?.("SIGINT", onSig); proc.once?.("SIGTERM", onSig);
      try { r.core = await runCore({ pool, constants: c, runSignal: ac.signal }); } finally { proc.off?.("SIGINT", onSig); proc.off?.("SIGTERM", onSig); }
    } finally { dbUrl = null; }
    r.code = r.core && r.core.outcome === "PASS" ? "PROBE_PASS" : "PROBE_FAIL";
    return { exitCode: r.code === "PROBE_PASS" ? 0 : 1, result: r };
  } catch (e) {
    r.code = e instanceof Refusal && HOSTED_CODES.includes(e.code) ? e.code : "HTP_INTERNAL";
    return { exitCode: 1, result: r };
  } finally {
    if (pool) { try { await Promise.race([pool.end(), new Promise((_, rej) => setTimeout(() => rej(new Error("t")), 5000))]); r.cleanup = "POOL_ENDED"; } catch { r.cleanup = "POOL_END_FAILED"; } }
  }
}

export function summaryMarkdown(r) {
  const k = r.core ? ` core=${r.core.outcome}/${r.core.code} samples=${r.core.samplesProven}/${r.core.samplesRequired} client=${r.core.clientVerified} backendSsl=${r.core.backendSsl} identity=${r.core.identityOk} readOnly=${r.core.readOnly} rolledBack=${r.core.rolledBack} fresh=${r.core.freshConnections} distinctBackends=${r.core.distinctBackends} failedSample=${r.core.failedSample ?? "-"} sealed=${r.core.sealed}` : "";
  return `e7-hosted-tls-probe ${r.mode} ${r.code} probeEnabled=${r.probeEnabled} runId=${r.runId ?? "-"} closure=${r.closureDigest ?? "-"} source=${r.sourceDigest ?? "-"} cleanup=${r.cleanup ?? "-"}${k}\n`;
}

// ---- the ONLY top-level effect -----------------------------------------------------------------------------------------------------
if (import.meta.main === true) {
  const mode = process.argv[2] ?? "preflight";
  const wrapperDir = fileURLToPath(new URL("../", import.meta.url));
  runHosted({ mode, env: process.env, proc: process, wrapperDir }).then(({ exitCode, result }) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (typeof process.env.GITHUB_STEP_SUMMARY === "string" && process.env.GITHUB_STEP_SUMMARY.length > 0) {
      import("node:fs/promises").then((fs) => fs.appendFile(process.env.GITHUB_STEP_SUMMARY, summaryMarkdown(result))).catch(() => {}).finally(() => process.exit(exitCode));
    } else process.exit(exitCode);
  }).catch(() => process.exit(1));
}
