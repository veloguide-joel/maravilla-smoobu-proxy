// test/e7-hosted-tls-probe.test.mjs — C112: the READ-ONLY hosted TLS probe (scripts/e7-hosted-tls-probe.mjs).
//   * FAKE (default; the hosted preflight spawns this): the core against fake pools whose clients carry FAKE client-hop evidence (a
//     TLSSocket-prototyped object), every refusal / seal / freshness / output rule; the hosted gates with the REAL pinned tooling closure +
//     env preflight and stubbed spawn / pool / head. No pg import, no network (every real network primitive is a throwing guard).
//   * OPT-IN REAL SOCKETS (E7_TLSP_DB_TESTS=1 + PG_BIN + tooling node_modules): a disposable PostgreSQL with server SSL, a throwaway CA and a
//     pooler-shaped proxy whose CLIENT hop and BACKEND hop are each TLS or plain — two-hop positive and negative controls through the core.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import tls from "node:tls";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";
import { readFileSync, writeFileSync, realpathSync, mkdtempSync, mkdirSync, cpSync, rmSync, chownSync } from "node:fs";
import { join, dirname } from "node:path";
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
const P = await import("../scripts/e7-hosted-tls-probe.mjs");
const K = await import("../scripts/e7-hosted-kickoff.mjs");
after(() => { assert.deepEqual(GUARD, { request: 0, Agent: 0, fetch: 0 }, "no real network primitive was touched"); });

const C = P.CONSTANTS;
const sha = (b) => createHash("sha256").update(b).digest("hex");
const PROC = { versions: { node: "22.22.0" }, platform: "linux", execArgv: [], getuid: () => 1000 };
const SHA_A = "a".repeat(40);
const FAKE_CA = "-----BEGIN CERTIFICATE-----\nE7-FAKE-PROBE-CA\n-----END CERTIFICATE-----\n";
const POL = Object.freeze({ host: C.tls.host, caSha256: sha(FAKE_CA) });
const OPEN = Object.freeze({ ...C, tls: POL });
const DRAFT_SEAM = Object.freeze({ ...C, toolingStatus: "DRAFT_HEAD" });   // C116: TEST-LOCAL non-MERGED seam (must refuse HTP_CLOSURE_MISMATCH)
const ROW_OK = Object.freeze({ is_app: true, is_admin: false, privileged: false, owns_schema: false, backend_ssl: true, server_version_num: 170011, tx_read_only: "on",
  environment: "test", backend_pid: 424242 });

function fakeSocket(over = {}, log = null) {
  const s = Object.create(tls.TLSSocket.prototype);
  const d = { encrypted: true, destroyed: false, readyState: "open", authorized: true, authorizationError: null, isSessionReused: () => false, getProtocol: () => "TLSv1.3",
    getPeerCertificate: () => { if (log) log.push("evidence"); return { subject: { CN: C.tls.host }, subjectaltname: `DNS:${C.tls.host}` }; }, ...over };
  for (const [k, v] of Object.entries(d)) Object.defineProperty(s, k, { value: v, enumerable: true });
  return s;
}
/** a fake pool: script.client(i, base) customizes sample i's client; script.row(i) its row; every client logs evidence / statements / release */
function fakePool(script = {}) {
  const st = { connects: 0, log: [], released: [], perClient: [] };
  st.pool = { connect: () => { st.connects += 1; const i = st.connects; if (script.connect) return script.connect(i, st);
    const log = []; st.perClient.push(log);
    const base = { query: (sql) => { log.push(sql.startsWith("/*e7tlsprobe*/") ? "probe" : sql); st.log.push(sql);
      if (script.query) { const x = script.query(i, sql); if (x !== undefined) return x; }
      return Promise.resolve(sql.startsWith("/*e7tlsprobe*/") ? { rows: [script.row ? script.row(i) : { ...ROW_OK, backend_pid: 1000 + i }] } : { rows: [] }); },
      release: (x) => st.released.push(x === true ? "destroy" : "clean") };
    const cl = Object.assign(base, { connection: { stream: fakeSocket({}, log) }, host: C.tls.host, ssl: { rejectUnauthorized: true, ca: FAKE_CA } });
    return Promise.resolve(script.client ? script.client(i, cl) : cl); } };
  return st;
}
function fakeTimers() { const ts = []; return { timer: (fn, ms) => { const h = { fn, ms, cleared: false }; ts.push(h); return h; }, clearTimer: (h) => { h.cleared = true; },
  fire: (ms) => { for (const h of ts.filter((x) => x.ms === ms && !x.cleared)) { h.cleared = true; h.fn(); } } }; }
const core = (st, over = {}) => P.runProbeCore({ pool: st.pool, constants: OPEN, ...over });

test("P1 contract: EXACTLY five samples; the client-hop identity / tooling / closure are the merged kickoff's; ONLY three fixed parameterless statements (BEGIN READ ONLY, one read-only SELECT, ROLLBACK) — no write, no request / intent / claim access; source frame includes the imported kickoff runner", () => {
  assert.equal(C.samples, 5); assert.equal(C.probeEnabled, true);
  assert.deepEqual({ ...C.tls }, { ...K.CONSTANTS.tls }); assert.equal(C.tls.caSha256, K.OFFICIAL_CA_SHA256);
  assert.deepEqual([C.toolingCommit, C.toolingStatus, C.closureDigest, C.pgVersion, C.nodeVersion], [K.CONSTANTS.toolingCommit, "MERGED", K.CONSTANTS.closureDigest, "8.18.0", "22.22.0"]);
  assert.deepEqual(Object.keys(P.QUERIES), ["begin", "probe", "rollback"]);
  assert.equal(P.QUERIES.begin, "BEGIN READ ONLY"); assert.equal(P.QUERIES.rollback, "ROLLBACK");
  assert.doesNotMatch(P.QUERIES.probe, /\$\d|\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|CALL|COPY|ALTER|CREATE|DROP|GRANT|SET\s|DO\b)|nextval|pg_advisory|claim|kickoff|intents|reservation|payment/i);
  assert.match(P.QUERIES.probe, /pg_stat_ssl s WHERE s\.pid = pg_backend_pid\(\)/); assert.match(P.QUERIES.probe, /transaction_read_only/);
  assert.equal(C.budgets.dbQueries, 15); assert.deepEqual([...P.RUNNER_FILES].at(-1), "scripts/e7-hosted-kickoff.mjs");
  assert.deepEqual([...P.SECRET_KEYS], ["E7_DEV_BOOKING_DATABASE_URL"]); assert.ok(!P.ALLOWED_E7_KEYS.some((k) => /TOKEN|STRIPE|HOSTAWAY|RESEND|SQL|HOST|SSL|TLS/.test(k)));
  for (const f of ["executeEnabled", "dispatchEnabled"]) assert.equal(K.CONSTANTS[f], true, `C116 ENABLE A: booking kickoff ${f} open (the stacked CLOSE A restores false); the probe itself never dispatches`);
});

test("P2 PASS needs all five: each sample a FRESH verified socket checked BEFORE its first statement, BEGIN READ ONLY → SELECT → ROLLBACK, then destroyed; counts 5/5; the backend pid is counted, never output", async () => {
  const st = fakePool(); const r = await core(st);
  assert.deepEqual([r.outcome, r.code, r.samplesProven, r.clientVerified, r.backendSsl, r.identityOk, r.readOnly, r.rolledBack, r.freshConnections, r.distinctBackends, r.dbQueries, r.failedSample],
    ["PASS", "BOTH_HOPS_PROVEN", 5, 5, 5, 5, 5, 5, 5, 5, 15, null]);
  assert.equal(st.connects, 5); assert.deepEqual(st.released, ["destroy", "destroy", "destroy", "destroy", "destroy"], "every connection destroyed, never returned for reuse");
  for (const log of st.perClient) assert.deepEqual(log, ["evidence", "BEGIN READ ONLY", "probe", "ROLLBACK"], "evidence strictly before the first statement");
  const out = JSON.stringify(r) + P.summaryMarkdown({ mode: "probe", code: "PROBE_PASS", probeEnabled: true, core: r });
  for (const v of ["1001", "1005", "424242", C.tls.host, "postgres"]) assert.ok(!out.includes(v), `no value in the output: ${v}`);
});

test("P3 CLIENT hop: a defective socket at sample k → FAIL CLIENT_<reason> at k, 0 statements on it, destroyed, NO further sample (fail closed, no retry)", async () => {
  for (const [k, mk, why] of [[1, (cl) => ({ ...cl, connection: { stream: new net.Socket() } }), "NOT_TLS"],
    [3, (cl) => Object.assign(cl, { connection: { stream: fakeSocket({ authorized: false, authorizationError: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" }) } }), "UNAUTHORIZED"],
    [5, (cl) => Object.assign(cl, { ssl: { rejectUnauthorized: false, ca: FAKE_CA } }), "CONFIG_NOT_PINNED"],
    [2, (cl) => Object.assign(cl, { connection: { stream: fakeSocket({ getPeerCertificate: () => ({ subject: { CN: "x.invalid" }, subjectaltname: "DNS:x.invalid" }) }) } }), "HOSTNAME_MISMATCH"],
    [4, (cl) => Object.assign(cl, { connection: { stream: fakeSocket({ destroyed: true }) } }), "DISCONNECTED"], [1, (cl) => { delete cl.connection; return cl; }, "NOT_FRESH"]]) {
    const st = fakePool({ client: (i, cl) => (i === k ? mk(cl) : cl) }); const r = await core(st);
    assert.deepEqual([r.outcome, r.code, r.failedSample, r.samplesProven, st.connects, r.dbQueries], ["FAIL", why === "NOT_FRESH" ? why : `CLIENT_${why}`, k, k - 1, k, 3 * (k - 1)], `${why}@${k}`);
    assert.equal(st.released.at(-1), "destroy");
  }
});

test("P4 BACKEND hop / identity / read-only: any non-proof row fails at that sample after its ROLLBACK (missing pg_stat_ssl row and NULL count as failure); no further sample", async () => {
  for (const [k, row, why] of [[4, { backend_ssl: false }, "BACKEND_NOT_SSL"], [1, { backend_ssl: null }, "BACKEND_NOT_SSL"], [2, { backend_ssl: undefined }, "BACKEND_NOT_SSL"],
    [1, { is_app: false }, "ROLE_REFUSED"], [3, { is_admin: true }, "ROLE_REFUSED"], [2, { privileged: true }, "ROLE_REFUSED"], [5, { owns_schema: true }, "ROLE_REFUSED"],
    [1, { environment: "production" }, "NOT_TEST"], [1, { environment: null }, "NOT_TEST"], [2, { server_version_num: 150010 }, "SERVER_VERSION_REFUSED"], [1, { tx_read_only: "off" }, "NOT_READ_ONLY"]]) {
    const st = fakePool({ row: (i) => (i === k ? { ...ROW_OK, ...row } : ROW_OK) }); const r = await core(st);
    assert.deepEqual([r.outcome, r.code, r.failedSample, r.samplesProven, st.connects, r.rolledBack], ["FAIL", why, k, k - 1, k, k], `${why}@${k}`);
  }
  for (const rows of [[], [ROW_OK, ROW_OK]]) { const st = fakePool({ query: (i, sql) => (sql.startsWith("/*e7tlsprobe*/") ? Promise.resolve({ rows }) : undefined) });
    assert.equal((await core(st)).code, "NO_ROW"); }
});

test("P5 freshness: the SAME socket handed out twice → FAIL NOT_FRESH at the second sample (a pooled / reused connection is never counted)", async () => {
  let first = null; const st = fakePool({ client: (i, cl) => { if (i === 1) first = cl.connection.stream; else cl.connection = { stream: first }; return cl; } });
  const r = await core(st); assert.deepEqual([r.code, r.failedSample, r.freshConnections, st.connects], ["NOT_FRESH", 2, 1, 2]);
});

test("P6 SEAL + errors: a connect that never resolves → SEALED:DB_CONNECT_TIMEOUT and the LATE client destroyed unused; a statement that never resolves → that client destroyed + SEALED:DB_STATEMENT_TIMEOUT; a SQL error → SQL_FAILED (destroyed); the wall deadline seals; probeEnabled false → PROBE_CLOSED with 0 connects", async () => {
  { const tm = fakeTimers(); let late; const st = fakePool({ connect: () => new Promise((res) => { late = res; }) });
    const p = core(st, { timer: tm.timer, clearTimer: tm.clearTimer }); await new Promise((r) => setImmediate(r)); tm.fire(C.budgets.connectMs);
    const r = await p; assert.deepEqual([r.outcome, r.code, r.dbQueries], ["FAIL", "SEALED:DB_CONNECT_TIMEOUT", 0]);
    let rel = null; late({ query: () => { throw new Error("late client used"); }, release: (x) => { rel = x; } }); await new Promise((res) => setImmediate(res));
    assert.equal(rel, true); assert.equal(r.lateClientsDestroyed, 1); }
  { const tm = fakeTimers(); const st = fakePool({ query: (i, sql) => (sql.startsWith("/*e7tlsprobe*/") && i === 2 ? new Promise(() => {}) : undefined) });
    const p = core(st, { timer: tm.timer, clearTimer: tm.clearTimer }); for (let n = 0; n < 20; n += 1) await new Promise((r) => setImmediate(r)); tm.fire(C.budgets.statementMs);
    const r = await p; assert.deepEqual([r.code, r.failedSample, st.released.at(-1)], ["SEALED:DB_STATEMENT_TIMEOUT", 2, "destroy"]); }
  { const st = fakePool({ query: (i, sql) => (sql === "BEGIN READ ONLY" && i === 3 ? Promise.reject(Object.assign(new Error("x"), { code: "57P01" })) : undefined) });
    const r = await core(st); assert.deepEqual([r.code, r.failedSample, st.released.at(-1)], ["SQL_FAILED:57P01", 3, "destroy"]); }
  { const st = fakePool({ query: (i, sql) => (sql.startsWith("/*e7tlsprobe*/") ? Promise.reject(Object.assign(new Error("x"), { code: "42501" })) : undefined) });
    const r = await core(st); assert.equal(r.code, "SQL_FAILED:42501:IN_TX"); }
  { const tm = fakeTimers(); const st = fakePool({ connect: () => new Promise(() => {}) }); const p = core(st, { timer: tm.timer, clearTimer: tm.clearTimer });
    await new Promise((r) => setImmediate(r)); tm.fire(C.budgets.runMs - C.budgets.teardownMs); assert.equal((await p).code, "SEALED:DEADLINE"); }
  { const st = fakePool(); const r = await core(st, { constants: { ...OPEN, probeEnabled: false } }); assert.deepEqual([r.code, st.connects], ["PROBE_CLOSED", 0]); }
});

// ---- the HOSTED runner against the REAL pinned tooling closure + env preflight (spawn / pool / head stubbed) ----------------------------
function wrapperFixture() {
  const d = mkdtempSync(join(tmpdir(), "htp-w-"));
  for (const f of P.RUNNER_FILES) { mkdirSync(dirname(join(d, f)), { recursive: true }); cpSync(join(ROOT, f), join(d, f)); }
  return d;
}
const trap = (n) => async () => { throw new Error(`must not be called: ${n}`); };
const TRAPS = { spawnChild: trap("spawn"), importPool: trap("importPool"), runCore: trap("runCore"), readHead: trap("readHead"), readPgVersion: trap("readPg"), readCa: trap("readCa") };
const namesOnly = (keys) => { const reads = []; const p = new Proxy(Object.fromEntries(keys.map((k) => [k, "x"])), {
  get: (t, k) => { reads.push(k); throw new Error(`value read: ${String(k)}`); }, getOwnPropertyDescriptor: () => ({ value: "x", enumerable: true, configurable: true, writable: true }) });
  return { env: p, reads }; };
const URL_OK = `postgresql://mv_booking_app_dev.${C.dbProjectRef}:not-a-secret@${C.tls.host}:6543/postgres`;

test("H1 key-name gates before any value: an unexpected E7_ key → HTP_INPUT_UNEXPECTED; the DB secret NAME in preflight / verify → HTP_SECRET_SCOPE_VIOLATION; a closed probe → HTP_PROBE_CLOSED — 0 env value reads, 0 import / spawn / pool", async () => {
  for (const [mode, keys, k, cst] of [["preflight", ["E7_TOOLING_DIR", "E7_SQL"], "HTP_INPUT_UNEXPECTED", C], ["preflight", ["E7_DEV_BOOKING_DATABASE_URL"], "HTP_SECRET_SCOPE_VIOLATION", C],
    ["verify", ["E7_DEV_BOOKING_DATABASE_URL"], "HTP_SECRET_SCOPE_VIOLATION", C], ["probe", ["E7_DISPATCH_TOKEN"], "HTP_INPUT_UNEXPECTED", C],
    ["probe", ["E7_DEV_BOOKING_DATABASE_URL"], "HTP_PROBE_CLOSED", { ...C, probeEnabled: false }], ["execute", [], "HTP_USAGE", C]]) {
    const { env, reads } = namesOnly(keys);
    const r = await P.runHosted({ mode, env, proc: PROC, wrapperDir: ROOT, deps: { ...TRAPS, constants: cst } });
    assert.deepEqual([r.exitCode, r.result.code, reads], [1, k, []], `${mode} ${keys}`);
  }
});

test("H2 preflight: REAL closure / lockfile / env preflight; the spawned focused tests must ALL pass with ZERO skips (a skip or a failure → HTP_TESTS_FAILED); no secret, no pool", async () => {
  const w = wrapperFixture(); try {
    const tap = (t, p, f, s) => async () => ({ status: f ? 1 : 0, signal: null, stdout: `# tests ${t}\n# pass ${p}\n# fail ${f}\n# skipped ${s}\n`, truncated: false, spawnFailed: false });
    const ok = await P.runHosted({ mode: "preflight", env: { E7_TOOLING_DIR: TOOLING, PATH: "/usr/bin" }, proc: PROC, wrapperDir: w, deps: { ...TRAPS, spawnChild: tap(9, 9, 0, 0) } });
    assert.deepEqual([ok.exitCode, ok.result.code, ok.result.closureDigest], [0, "PREFLIGHT_OK", C.closureDigest]);
    assert.equal(ok.result.sourceDigest, await K.framedDigest(w, P.RUNNER_FILES, P.SOURCE_PREFIX));
    for (const s of [tap(9, 8, 0, 1), tap(9, 8, 1, 0), tap(0, 0, 0, 0)]) assert.equal((await P.runHosted({ mode: "preflight", env: { E7_TOOLING_DIR: TOOLING }, proc: PROC, wrapperDir: w, deps: { ...TRAPS, spawnChild: s } })).result.code, "HTP_TESTS_FAILED");
    assert.equal((await P.runHosted({ mode: "preflight", env: { E7_TOOLING_DIR: TOOLING }, proc: { ...PROC, versions: { node: "22.21.0" } }, wrapperDir: w, deps: { ...TRAPS, spawnChild: tap(9, 9, 0, 0) } })).result.code, "HTP_ENV_REFUSED");
  } finally { rmSync(w, { recursive: true, force: true }); }
});

test("H3 verify / probe ORDER (no secret before every binding): main only, GITHUB_SHA == E7_WORKFLOW_SHA, 64-hex digest == this checkout's source, HEAD == dispatch SHA, run id; then VERIFY_OK", async () => {
  const w = wrapperFixture(); try {
    const src = await K.framedDigest(w, P.RUNNER_FILES, P.SOURCE_PREFIX);
    const base = (o = {}) => ({ E7_TOOLING_DIR: TOOLING, E7_EXPECTED_SOURCE_DIGEST: src, E7_WORKFLOW_SHA: SHA_A, GITHUB_SHA: SHA_A, GITHUB_REF: "refs/heads/main", E7_RUN_ID: "123456-1", ...o });
    const head = async () => SHA_A;
    for (const [env, k] of [[base({ GITHUB_REF: "refs/heads/feature" }), "HTP_REF_NOT_MAIN"], [base({ GITHUB_SHA: "b".repeat(40) }), "HTP_BINDING_MISMATCH"],
      [base({ E7_EXPECTED_SOURCE_DIGEST: "" }), "HTP_INPUT_INCOMPLETE"], [base({ E7_EXPECTED_SOURCE_DIGEST: "c".repeat(64) }), "HTP_SOURCE_MISMATCH"], [base({ E7_RUN_ID: "x" }), "HTP_INPUT_INVALID"]]) {
      assert.equal((await P.runHosted({ mode: "verify", env, proc: PROC, wrapperDir: w, deps: { ...TRAPS, readHead: head } })).result.code, k);
    }
    assert.equal((await P.runHosted({ mode: "verify", env: base(), proc: PROC, wrapperDir: w, deps: { ...TRAPS, readHead: async () => "d".repeat(40) } })).result.code, "HTP_BINDING_MISMATCH");
    const v = await P.runHosted({ mode: "verify", env: base(), proc: PROC, wrapperDir: w, deps: { ...TRAPS, readHead: head } });
    assert.deepEqual([v.exitCode, v.result.code], [0, "VERIFY_OK"]);
    const draft = await P.runHosted({ mode: "verify", env: base(), proc: PROC, wrapperDir: w, deps: { ...TRAPS, constants: DRAFT_SEAM, readHead: head } });
    assert.deepEqual([draft.exitCode, draft.result.code], [1, "HTP_CLOSURE_MISMATCH"], "C116: a non-MERGED tooling pin never verifies");
  } finally { rmSync(w, { recursive: true, force: true }); }
});

test("H4 probe step: secret present → pg 8.18.0 → the ONLY admitted target (pooler 6543, app role, project) → the PINNED CA bytes → the tooling's createBookingPool({connectionString, caPem, max:1}) → the core; exit 0 ONLY on PASS; the secret is removed from env; the output carries no URL / credential", async () => {
  const w = wrapperFixture(); try {
    const src = await K.framedDigest(w, P.RUNNER_FILES, P.SOURCE_PREFIX); const CA = readFileSync(join(TOOLING, "package.json")); // stand-in bytes, pinned via a seam constant
    const cst = Object.freeze({ ...C, tls: Object.freeze({ ...C.tls, caSha256: sha(CA) }) });
    const env = (o = {}) => ({ E7_TOOLING_DIR: TOOLING, E7_EXPECTED_SOURCE_DIGEST: src, E7_WORKFLOW_SHA: SHA_A, GITHUB_SHA: SHA_A, GITHUB_REF: "refs/heads/main", E7_RUN_ID: "123456-1",
      E7_CA_FILE: "/ca.crt", E7_DEV_BOOKING_DATABASE_URL: URL_OK, ...o });
    let made = null; const ended = { n: 0 };
    const deps = (coreOut) => ({ ...TRAPS, constants: cst, readHead: async () => SHA_A, readPgVersion: async () => "8.18.0", readCa: async () => CA,
      importPool: async () => ({ createBookingPool: (cfg) => { made = cfg; return { connect: trap("connect"), end: async () => { ended.n += 1; } }; } }),
      runCore: async (i) => { assert.equal(i.constants, cst); return coreOut; } });
    const e = env(); const r = await P.runHosted({ mode: "probe", env: e, proc: PROC, wrapperDir: w, deps: deps({ outcome: "PASS", code: "BOTH_HOPS_PROVEN" }) });
    assert.deepEqual([r.exitCode, r.result.code, r.result.cleanup, ended.n], [0, "PROBE_PASS", "POOL_ENDED", 1]);
    assert.deepEqual([made.connectionString, made.caPem, made.max], [URL_OK, CA.toString("utf8"), 1]); assert.ok(!("E7_DEV_BOOKING_DATABASE_URL" in e), "secret removed from env");
    assert.ok(!JSON.stringify(r.result).includes("not-a-secret") && !P.summaryMarkdown(r.result).includes("not-a-secret"));
    const f = await P.runHosted({ mode: "probe", env: env(), proc: PROC, wrapperDir: w, deps: deps({ outcome: "FAIL", code: "BACKEND_NOT_SSL" }) });
    assert.deepEqual([f.exitCode, f.result.code], [1, "PROBE_FAIL"]);
    for (const [o, d, k] of [[{ E7_DEV_BOOKING_DATABASE_URL: "" }, {}, "HTP_CREDENTIALS_MISSING"], [{}, { readPgVersion: async () => "8.17.0" }, "HTP_DEPENDENCY_MISMATCH"],
      [{ E7_DEV_BOOKING_DATABASE_URL: URL_OK.replace(":6543", ":5432") }, {}, "HTP_DB_TARGET_INVALID"], [{ E7_DEV_BOOKING_DATABASE_URL: `${URL_OK}?sslmode=disable` }, {}, "HTP_DB_TARGET_INVALID"],
      [{ E7_DEV_BOOKING_DATABASE_URL: URL_OK.replace("mv_booking_app_dev", "postgres") }, {}, "HTP_DB_TARGET_INVALID"], [{}, { readCa: async () => Buffer.from("other") }, "HTP_CA_INVALID"]]) {
      made = null; const x = await P.runHosted({ mode: "probe", env: env(o), proc: PROC, wrapperDir: w, deps: { ...deps({ outcome: "PASS" }), ...d } });
      assert.deepEqual([x.exitCode, x.result.code, made], [1, k, null], k);
    }
  } finally { rmSync(w, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// OPT-IN REAL SOCKETS (E7_TLSP_DB_TESTS=1): disposable PostgreSQL + server SSL + throwaway CA + pooler-shaped two-hop proxy.
if (process.env.E7_TLSP_DB_TESTS === "1") {
  const [{ startMigratedDatabase }] = await Promise.all([tool("test/db/harness.mjs")]);
  const db = await startMigratedDatabase();
  after(async () => { await db.close(); });
  // built LAZILY inside the first DB test: a long top-level await would let the root test finish and run the after() hooks early
  let pg, fx, proxies, VERIFIED, OPEN_IT; const pools = []; let readyP = null;
  const buildFx = () => {
    const d = mkdtempSync(join(tmpdir(), "htp-tls-"));
    const ossl = (...a) => execFileSync("openssl", a, { cwd: d, stdio: ["ignore", "ignore", "pipe"] });
    const ca = (n) => { ossl("req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", `${n}.key`, "-out", `${n}.pem`, "-days", "2",
      "-subj", `/CN=e7-htp-${n}`, "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"); };
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
  const serverSsl = async () => {
    const sd = mkdtempSync(join(tmpdir(), "htp-pgssl-"));
    writeFileSync(join(sd, "server.crt"), fx.good.cert); writeFileSync(join(sd, "server.key"), fx.good.key, { mode: 0o600 });
    if (process.getuid && process.getuid() === 0) { const u = Number(execFileSync("id", ["-u", "postgres"]).toString()); const g = Number(execFileSync("id", ["-g", "postgres"]).toString());
      for (const f of ["", "server.crt", "server.key"]) chownSync(join(sd, f), u, g); }
    await db.owner.query(`ALTER SYSTEM SET ssl_cert_file = '${join(sd, "server.crt")}'`); await db.owner.query(`ALTER SYSTEM SET ssl_key_file = '${join(sd, "server.key")}'`);
    await db.owner.query("ALTER SYSTEM SET ssl = on"); await db.owner.query("SELECT pg_reload_conf()"); await new Promise((res) => setTimeout(res, 300));
    after(() => { rmSync(sd, { recursive: true, force: true }); });
  };
  const SSL_REQUEST = Buffer.from([0, 0, 0, 8, 0x04, 0xd2, 0x16, 0x2f]);
  async function startProxy({ front, back, cert }) {
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
      const wire = (fr) => { fr.pause(); backLeg().then((up) => { up.on("error", () => fr.destroy()); fr.on("error", () => up.destroy()); fr.pipe(up); up.pipe(fr); fr.resume(); }, () => fr.destroy()); };
      if (front === "plain") { wire(sock); return; }
      sock.once("data", (b) => {
        if (!b.equals(SSL_REQUEST)) { sock.destroy(); return; }
        const t = new tls.TLSSocket(sock, { isServer: true, key: (cert ?? fx.good).key, cert: (cert ?? fx.good).cert }); socks.add(t); t.on("error", () => {});
        sock.write("S"); t.once("secure", () => wire(t));
      });
    });
    await new Promise((res) => server.listen(0, "127.0.0.1", res));
    return { port: server.address().port, close: () => new Promise((res) => { for (const x of socks) x.destroy(); server.close(() => res()); }) };
  }
  const tlsPool = (port, user = "test_app", ssl = undefined) => { const p = new pg.Pool({ host: "localhost", port, user, database: "postgres", ssl: ssl === undefined ? VERIFIED : ssl, max: 1 }); pools.push(p); return p; };
  after(async () => { for (const p of pools) await p.end().catch(() => {}); for (const x of Object.values(proxies ?? {})) await x.close(); });
  const ready = () => (readyP ??= (async () => {
    pg = (await tool("node_modules/pg/lib/index.js")).default; fx = buildFx(); await serverSsl();
    proxies = { both: await startProxy({ front: "tls", back: "tls" }), offBack: await startProxy({ front: "tls", back: "plain" }), plainFront: await startProxy({ front: "plain", back: "tls" }),
      wronghost: await startProxy({ front: "tls", back: "tls", cert: fx.wronghost }), foreign: await startProxy({ front: "tls", back: "tls", cert: fx.foreign }) };
    VERIFIED = Object.freeze({ rejectUnauthorized: true, ca: fx.ca1 });
    OPEN_IT = Object.freeze({ ...C, tls: Object.freeze({ host: "localhost", caSha256: sha(fx.ca1) }) });
  })());
  const itest = (name, fn) => test(name, async () => { await ready(); return fn(); });
  const run = (pool, over = {}) => P.runProbeCore({ pool, constants: OPEN_IT, ...over });
  const fingerprint = async () => {
    const ts = (await db.owner.query("SELECT tablename FROM pg_tables WHERE schemaname = 'booking' ORDER BY tablename")).rows.map((x) => x.tablename);
    const out = {}; for (const t of ts) out[t] = (await db.owner.query(`SELECT count(*)::int AS n, md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM booking.${t} x`)).rows[0];
    return out; };

  itest("I1 BOTH hops verified (pooler-shaped proxy: verified TLS to the client AND to Postgres) → PASS 5/5: five fresh authorized sockets, server ssl=true each time, app role / TEST identity, read-only, rolled back; every booking table unchanged", async () => {
    const before = await fingerprint();
    const r = await run(tlsPool(proxies.both.port));
    assert.deepEqual([r.outcome, r.code, r.samplesProven, r.clientVerified, r.backendSsl, r.identityOk, r.readOnly, r.rolledBack, r.freshConnections, r.dbQueries],
      ["PASS", "BOTH_HOPS_PROVEN", 5, 5, 5, 5, 5, 5, 5, 15], JSON.stringify(r));
    assert.equal(r.distinctBackends, 5, "every sample a NEW server backend (fresh connection through the proxy)");
    assert.deepEqual(await fingerprint(), before, "no write");
  });

  itest("I2 the observed hosted state, reproduced: verified CLIENT hop, PLAINTEXT backend hop (the shared pooler with Enforce SSL OFF) → FAIL BACKEND_NOT_SSL at sample 1, after its ROLLBACK; no further sample", async () => {
    const r = await run(tlsPool(proxies.offBack.port));
    assert.deepEqual([r.outcome, r.code, r.failedSample, r.clientVerified, r.backendSsl, r.identityOk, r.rolledBack, r.dbQueries], ["FAIL", "BACKEND_NOT_SSL", 1, 1, 0, 1, 1, 3], JSON.stringify(r));
  });

  itest("I3 server text is never client-hop proof: a PLAINTEXT client behind a TLS backend, an unverified chain, a wrong-host certificate accepted unverified → FAIL CLIENT_<reason> at sample 1 with 0 statements", async () => {
    for (const [P2, why] of [[tlsPool(proxies.plainFront.port, "test_app", false), "NOT_TLS"], [tlsPool(db.port, "test_app", { rejectUnauthorized: false }), "UNAUTHORIZED"],
      [tlsPool(proxies.wronghost.port, "test_app", { rejectUnauthorized: false, ca: fx.ca1 }), "UNAUTHORIZED"]]) {
      const r = await run(P2); assert.deepEqual([r.outcome, r.code, r.failedSample, r.dbQueries], ["FAIL", `CLIENT_${why}`, 1, 0], why);
    }
  });

  itest("I4 REAL handshake negatives with rejectUnauthorized:true (wrong host, foreign CA) → CONNECT_FAILED, 0 statements; a policy host / CA pin mismatch on a valid socket → CLIENT_HOSTNAME_MISMATCH / CLIENT_CONFIG_NOT_PINNED", async () => {
    for (const port of [proxies.wronghost.port, proxies.foreign.port]) { const r = await run(tlsPool(port)); assert.deepEqual([r.outcome, r.code.startsWith("CONNECT_FAILED:"), r.dbQueries, r.clientVerified], ["FAIL", true, 0, 0], r.code); }
    for (const [pol, why] of [[{ host: "db.other.invalid", caSha256: sha(fx.ca1) }, "HOSTNAME_MISMATCH"], [{ host: "localhost", caSha256: sha(fx.ca2) }, "CONFIG_NOT_PINNED"]]) {
      const r = await run(tlsPool(proxies.both.port), { constants: { ...OPEN_IT, tls: pol } }); assert.deepEqual([r.code, r.dbQueries], [`CLIENT_${why}`, 0]);
    }
  });

  itest("I5 mixed: samples 1-2 verified both hops, sample 3 a PLAINTEXT client → FAIL CLIENT_NOT_TLS at sample 3 (2 proven, no sample 4); the OWNER role through verified TLS → ROLE_REFUSED at sample 1", async () => {
    const good = tlsPool(proxies.both.port); const plain = tlsPool(proxies.plainFront.port, "test_app", false); let n = 0;
    const r = await run({ connect: () => { n += 1; return (n === 3 ? plain : good).connect(); } });
    assert.deepEqual([r.code, r.failedSample, r.samplesProven, n], ["CLIENT_NOT_TLS", 3, 2, 3]);
    const o = await run(tlsPool(proxies.both.port, "postgres")); assert.deepEqual([o.code, o.failedSample, o.clientVerified, o.rolledBack], ["ROLE_REFUSED", 1, 1, 1]);
  });
}
