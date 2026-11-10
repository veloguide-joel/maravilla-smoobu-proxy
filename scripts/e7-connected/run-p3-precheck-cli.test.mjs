// run-p3-precheck-cli.test.mjs — focused OFFLINE coverage for the report-only P3 CLI (feature/e7-p3-lock-precheck) incl. review fixes R1/R2.
// No network, no real secrets (a dummy fixture login in a temp 0600 file). Proves: the exact DIRECT report-endpoint gate (R1: pooler/port/
// db/user/encoded/ambiguity refuse with makePool & connect NEVER called; the correct report URL passes), the reader↔pool zero-query-param
// compatibility and the exact ?sslmode= conflict refusal, cleanup-separated-from-exit (R2: CLEAN-but-unconfirmed teardown ⇒ nonzero even after
// CLEAR), controlled-timer pool.end pending/reject/throw/late, a subprocess proof that REAL referenced timers emit JSON + exit boundedly with a
// hung pool.end, output sanitization, the host/user drift guard, and no-connect-on-import.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { runP3Precheck, parseArgs, gateDirectReportUrl, endPoolBounded, DIRECT_HOST, REQUIRED_PORT, REQUIRED_DB_PATH, REQUIRED_REPORT_USER, CA_SHA256_PIN, SCHEMA, EXIT,
  instrumentPool, classifyFailure, FAILURE_CLASSES, OBS_PHASES, LATE_CLIENT } from "./run-p3-precheck-cli.mjs";
import { EventEmitter } from "node:events";
import { readOneDbLogin, SLOT_ROLES } from "./db-credential-file.mjs";
import { createBookingPool, resolveBookingTarget } from "../../lib/booking-db/pool.js";
import { createNativeAdapters } from "./probe-cli-main.mjs";
import { constants as FS_CONSTANTS } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");
const CA_PATH = join(HERE, "testdata", "prod-ca-2021.crt");
const CA_BYTES = readFileSync(CA_PATH);
const GOOD = `postgresql://${REQUIRED_REPORT_USER}:pw@${DIRECT_HOST}:5432/postgres`;   // DUMMY fixture login — never a real secret
const bareU = (host = DIRECT_HOST) => `postgresql://u:p@${host}:5432/postgres`;        // user "u" — for reader/pool-only tests

function writeLogin(connectionString, { role = "mv_booking_report", mode = 0o600 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "e7p3-"));
  const path = join(dir, "report.login.json");
  writeFileSync(path, JSON.stringify({ schema: "e7-db-login-v1", role, connectionString }), { mode });
  chmodSync(path, mode);
  return { dir, path };
}
const linuxFs = () => createNativeAdapters({ platform: process.platform, uid: process.getuid(), constants: FS_CONSTANTS, gate: () => {} }).credentialFs;

// ---------- parseArgs ----------
test("parseArgs: valid / invalid", () => {
  assert.equal(parseArgs(["--report-login", "/a", "--ca", "/b", "--repo-root", "/c"]).ok, true);
  assert.equal(parseArgs(["--report-login", "/a", "--ca", "/b", "--repo-root", "/c", "--k", "2", "--confirm-prereqs-met"]).ok, true);
  for (const bad of [[], ["--report-login", "/a"], ["--ca", "/b", "--repo-root", "/c"], ["--report-login", "/a", "--ca", "/b", "--repo-root", "/c", "--k", "0"], ["--bogus"], ["--report-login", "--ca", "/b", "--repo-root", "/c"]])
    assert.equal(parseArgs(bad).ok, false, JSON.stringify(bad));
});

// ---------- R1: the lexical DIRECT report-endpoint gate ----------
test("gate accepts ONLY the exact direct report URL", () => {
  assert.equal(gateDirectReportUrl(GOOD), null);
});
test("gate refuses pooler / port / db / user / encoded-user / host-ambiguity / query / fragment", () => {
  const cases = {
    "postgresql://mv_booking_report.mxotevtiscernhqilyiu:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres": "ENDPOINT_HOST_REFUSED", // pooler refused
    [`postgresql://${REQUIRED_REPORT_USER}:pw@${DIRECT_HOST}:6543/postgres`]: "ENDPOINT_PORT_REFUSED",
    [`postgresql://${REQUIRED_REPORT_USER}:pw@${DIRECT_HOST}:5432/postgres2`]: "ENDPOINT_DB_REFUSED",
    [`postgresql://postgres:pw@${DIRECT_HOST}:5432/postgres`]: "ENDPOINT_USER_REFUSED",
    [`postgresql://mv_booking_app:pw@${DIRECT_HOST}:5432/postgres`]: "ENDPOINT_USER_REFUSED",
    [`postgresql://mv_booking_report:pw@${DIRECT_HOST}:5432/postgres`]: "ENDPOINT_USER_REFUSED", // permission role is NOLOGIN, not the DEV login
    [`postgresql://mv_booking_app_dev:pw@${DIRECT_HOST}:5432/postgres`]: "ENDPOINT_USER_REFUSED",
    [`postgresql://mv%5Fbooking%5Freport%5Fdev:pw@${DIRECT_HOST}:5432/postgres`]: "ENDPOINT_USER_REFUSED", // percent-encoded user refused
    [`postgresql://${REQUIRED_REPORT_USER}:pw@${DIRECT_HOST}:5432/postgres?sslmode=require`]: "CONNSTRING_REJECTED",
    [`postgresql://${REQUIRED_REPORT_USER}:pw@${DIRECT_HOST}:5432/postgres#x`]: "CONNSTRING_REJECTED",
    [`postgresql://${REQUIRED_REPORT_USER}:pw@${DIRECT_HOST}@evil.example.com:5432/postgres`]: "ENDPOINT_HOST_REFUSED", // userinfo @ ambiguity
    [`postgresql://${REQUIRED_REPORT_USER}@${DIRECT_HOST}:5432/postgres`]: "ENDPOINT_USER_REFUSED" // empty password
  };
  for (const [cs, code] of Object.entries(cases)) assert.equal(gateDirectReportUrl(cs), code, cs);
});
test("every gate refusal in the CLI means makePool and connect are NEVER called", async () => {
  const bad = [
    "postgresql://mv_booking_report.mxotevtiscernhqilyiu:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres",
    `postgresql://${REQUIRED_REPORT_USER}:pw@${DIRECT_HOST}:6543/postgres`,
    `postgresql://postgres:pw@${DIRECT_HOST}:5432/postgres`,
    `postgresql://mv_booking_report:pw@${DIRECT_HOST}:5432/postgres`,
    `postgresql://mv_booking_app_dev:pw@${DIRECT_HOST}:5432/postgres`,
    `postgresql://mv%5Fbooking%5Freport%5Fdev:pw@${DIRECT_HOST}:5432/postgres`,
    `postgresql://${REQUIRED_REPORT_USER}:pw@${DIRECT_HOST}:5432/postgres?sslmode=require`
  ];
  for (const cs of bad) {
    let madePool = false; let connected = false;
    const r = await runP3Precheck({ argv: args(["--confirm-prereqs-met"]), deps: deps({
      readReportLogin: async () => ({ ok: true, slot: "report", login: { role: "mv_booking_report", connectionString: cs } }),
      makePool: () => { madePool = true; return { connect: () => { connected = true; return Promise.resolve(fakeClient(0)); }, end: () => Promise.resolve() }; }
    }) });
    assert.notEqual(r.exit, EXIT.CLEAR, cs);
    assert.equal(madePool, false, `makePool called for ${cs}`);
    assert.equal(connected, false, `connect called for ${cs}`);
  }
});
test("a correct report URL passes the gate and runs the precheck", async () => {
  const r = await runP3Precheck({ argv: args(["--confirm-prereqs-met"]), deps: deps({ makePool: () => fakePool({ n: 0 }) }) });
  assert.equal(r.result.code, "LOCK_PRECHECK_CLEAR"); assert.equal(r.exit, EXIT.CLEAR);
});

test("real report-file ingress accepts the distinct DEV login and report permission-role label without network", async () => {
  const cs = `postgresql://mv_booking_report_dev:dummy@${DIRECT_HOST}:5432/postgres`;
  const { dir, path } = writeLogin(cs);
  let pools = 0;
  try {
    const r = await runP3Precheck({
      argv: ["--report-login", path, "--ca", CA_PATH, "--repo-root", REPO_ROOT, "--confirm-prereqs-met"],
      deps: { makePool: (cfg) => { pools++; assert.equal(cfg.connectionString, cs); return fakePool(); } }
    });
    assert.equal(r.exit, EXIT.CLEAR);
    assert.equal(r.result.cleanup, "POOL_ENDED");
    assert.equal(pools, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------- REAL reader → REAL pool config flow (zero-param compatibility; the TLS conflict) ----------
test("end-to-end: a ZERO-param report login is accepted by the reader AND builds a verified-TLS pool", async () => {
  const { dir, path } = writeLogin(bareU());
  try {
    const r = await readOneDbLogin({ path, repoRoot: REPO_ROOT, fs: linuxFs(), slot: "report" });
    assert.equal(r.ok, true, JSON.stringify(r));
    const pool = createBookingPool({ connectionString: r.login.connectionString, caPem: CA_BYTES.toString("utf8"), max: 1, statementTimeoutMs: 5000 });
    assert.ok(pool); await pool.end();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("conflict: a ?sslmode= login is accepted by the reader but REFUSED by the pool (exact message)", async () => {
  const { dir, path } = writeLogin(`${bareU()}?sslmode=require`);
  try {
    const r = await readOneDbLogin({ path, repoRoot: REPO_ROOT, fs: linuxFs(), slot: "report" });
    assert.equal(r.ok, true);
    assert.throws(() => createBookingPool({ connectionString: r.login.connectionString, caPem: "x" }), /would override the verified TLS configuration/);
    assert.throws(() => resolveBookingTarget(r.login.connectionString), /would override the verified TLS configuration/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("pool refuses a remote target with no caPem", () => { assert.throws(() => createBookingPool({ connectionString: bareU() }), /require caPem/); });
test("reader refuses >1 param / fragment / bad sslmode / role mismatch / non-0600", async () => {
  for (const cs of [`${bareU()}?sslmode=require&foo=bar`, `${bareU()}#frag`, `${bareU()}?sslmode=bogus`, `${bareU()}?foo=bar`]) {
    const { dir, path } = writeLogin(cs);
    try { const r = await readOneDbLogin({ path, repoRoot: REPO_ROOT, fs: linuxFs(), slot: "report" }); assert.equal(r.ok, false, cs); assert.equal(r.code, "DB_URL_PARAMS"); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  }
  let { dir, path } = writeLogin(bareU(), { role: "mv_booking_app" });
  try { const r = await readOneDbLogin({ path, repoRoot: REPO_ROOT, fs: linuxFs(), slot: "report" }); assert.equal(r.code, "DB_ROLE_MISMATCH"); } finally { rmSync(dir, { recursive: true, force: true }); }
  ({ dir, path } = writeLogin(bareU(), { mode: 0o644 }));
  try { const r = await readOneDbLogin({ path, repoRoot: REPO_ROOT, fs: linuxFs(), slot: "report" }); assert.equal(r.code, "CRED_MODE"); } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------- CLI behaviour (injected deps; no fs / no network) ----------
const fakeClient = (n) => ({ on() {}, removeListener() {}, query: () => Promise.resolve({ rows: [{ n }] }), release() {} });
const fakePool = ({ n = 0, connectReject = false, end = () => Promise.resolve() } = {}) => ({ connect: () => (connectReject ? Promise.reject(new Error("x")) : Promise.resolve(fakeClient(n))), end });
function deps(over = {}) {
  return {
    platform: "linux", getuid: () => 1000, now: () => 0,
    readCaBytes: () => CA_BYTES, makeCredentialFs: () => ({}),
    readReportLogin: async () => ({ ok: true, slot: "report", login: { role: "mv_booking_report", connectionString: GOOD } }),
    makePool: () => fakePool(),
    makeProc: () => ({ setTimer: () => ({}), clearTimer: () => {} }),
    makeSignal: () => ({ signal: undefined, cancel: () => {} }),
    poolEndTimers: { setTimer: () => ({}), clearTimer: () => {} },
    ...over
  };
}
const args = (extra = []) => ["--report-login", "/x/report.json", "--ca", CA_PATH, "--repo-root", "/x", ...extra];

test("HELD default validates config and does NOT connect", async () => {
  let connected = false;
  const d = deps({ makePool: () => ({ connect: () => { connected = true; return Promise.resolve(fakeClient(0)); }, end: () => Promise.resolve() }) });
  const { exit, result } = await runP3Precheck({ argv: args(), deps: d });
  assert.equal(result.code, "VALIDATED_HELD"); assert.equal(result.connected, false); assert.equal(result.poolConfigAccepted, true);
  assert.equal(exit, EXIT.HELD); assert.equal(connected, false);
});
test("--confirm CLEAR / PRESENT / UNAVAILABLE map to codes and exits with confirmed cleanup", async () => {
  let r = await runP3Precheck({ argv: args(["--confirm-prereqs-met"]), deps: deps({ makePool: () => fakePool({ n: 0 }) }) });
  assert.equal(r.result.code, "LOCK_PRECHECK_CLEAR"); assert.equal(r.result.cleanup, "POOL_ENDED"); assert.equal(r.exit, EXIT.CLEAR);
  r = await runP3Precheck({ argv: args(["--confirm-prereqs-met"]), deps: deps({ makePool: () => fakePool({ n: 2 }) }) });
  assert.equal(r.result.code, "RUN_LOCK_PRESENT_BEFORE_START"); assert.equal(r.exit, EXIT.RUN_LOCK_PRESENT);
  r = await runP3Precheck({ argv: args(["--confirm-prereqs-met"]), deps: deps({ makePool: () => fakePool({ connectReject: true }) }) });
  assert.equal(r.result.code, "LOCK_PRECHECK_UNAVAILABLE"); assert.equal(r.exit, EXIT.PRECHECK_UNAVAILABLE);
});

// ---------- R2: cleanup separated from the precheck result ----------
test("R2: CLEAR precheck but UNCONFIRMED cleanup ⇒ nonzero exit, code preserved", async () => {
  // pool.end never resolves; inject poolEndTimers that fire the bound immediately → UNCONFIRMED
  const d = deps({ makePool: () => fakePool({ n: 0, end: () => new Promise(() => {}) }),
    poolEndTimers: { setTimer: (fn) => { fn(); return {}; }, clearTimer: () => {} } });
  const { exit, result } = await runP3Precheck({ argv: args(["--confirm-prereqs-met"]), deps: d });
  assert.equal(result.code, "LOCK_PRECHECK_CLEAR");        // precheck result preserved
  assert.equal(result.cleanup, "POOL_END_UNCONFIRMED");
  assert.equal(exit, EXIT.CLEANUP_UNCONFIRMED);            // NOT 0
  assert.notEqual(exit, EXIT.CLEAR);
});
test("endPoolBounded: pending/reject/throw ⇒ UNCONFIRMED; resolve ⇒ ENDED; late resolve stays UNCONFIRMED", async () => {
  const fireNow = { setTimer: (fn) => { fn(); return {}; }, clearTimer: () => {} };
  const never = { setTimer: () => ({}), clearTimer: () => {} };
  assert.equal(await endPoolBounded({ end: () => new Promise(() => {}) }, fireNow), "POOL_END_UNCONFIRMED");
  assert.equal(await endPoolBounded({ end: () => Promise.reject(new Error("x")) }, never), "POOL_END_UNCONFIRMED");
  assert.equal(await endPoolBounded({ end: () => { throw new Error("x"); } }, never), "POOL_END_UNCONFIRMED");
  assert.equal(await endPoolBounded({ end: () => Promise.resolve() }, never), "POOL_ENDED");
  // late resolution after the bound already fired must NOT flip the result
  let release; const p = endPoolBounded({ end: () => new Promise((res) => { release = res; }) }, fireNow);
  assert.equal(await p, "POOL_END_UNCONFIRMED"); release(); // resolving now is a no-op
});
test("R2 subprocess: REAL referenced timers emit JSON and exit boundedly even when pool.end hangs", () => {
  const driver = `
    import { runP3Precheck } from ${JSON.stringify(join(HERE, "run-p3-precheck-cli.mjs"))};
    import { readFileSync } from "node:fs";
    const CA = readFileSync(${JSON.stringify(CA_PATH)});
    const fakeClient = { on(){}, removeListener(){}, query: async () => ({ rows: [{ n: 0 }] }), release(){} };
    const pool = { connect: async () => fakeClient, end: () => new Promise(() => {}) }; // never resolves
    const deps = {
      platform: "linux", getuid: () => 1000, readCaBytes: () => CA, makeCredentialFs: () => ({}),
      readReportLogin: async () => ({ ok: true, slot: "report", login: { role: "mv_booking_report", connectionString: ${JSON.stringify(GOOD)} } }),
      makePool: () => pool,
      makeProc: () => ({ setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: clearTimeout }),      // REAL, referenced
      makeSignal: (ms) => { const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms); return { signal: ac.signal, cancel: () => clearTimeout(t) }; },
      poolEndTimers: { setTimer: (fn, ms) => setTimeout(fn, Math.min(ms, 400)), clearTimer: clearTimeout } // REAL referenced, short bound for the test
    };
    const { exit, result } = await runP3Precheck({ argv: ["--report-login","/x","--ca","/c","--repo-root","/r","--confirm-prereqs-met"], deps });
    process.stdout.write(JSON.stringify(result) + "\\n"); process.exit(exit);
  `;
  let out, code = 0;
  try { out = execFileSync(process.execPath, ["--input-type=module", "-e", driver], { encoding: "utf8", timeout: 8000 }); }
  catch (e) { out = (e.stdout || "").toString(); code = e.status; }
  assert.match(out, /"code":"LOCK_PRECHECK_CLEAR"/);
  assert.match(out, /"cleanup":"POOL_END_UNCONFIRMED"/);
  assert.equal(code, EXIT.CLEANUP_UNCONFIRMED);
});

// ---------- refusals, sanitization, drift, no-connect-on-import ----------
test("CA pin mismatch / platform / credential-fail refusals", async () => {
  let r = await runP3Precheck({ argv: args(), deps: deps({ readCaBytes: () => Buffer.from("not the CA") }) });
  assert.equal(r.result.code, "CA_PIN_MISMATCH"); assert.equal(r.exit, EXIT.PLATFORM_OR_CA);
  r = await runP3Precheck({ argv: args(), deps: deps({ platform: "win32" }) });
  assert.equal(r.result.code, "PLATFORM_UNSUPPORTED"); assert.equal(r.exit, EXIT.PLATFORM_OR_CA);
  r = await runP3Precheck({ argv: args(), deps: deps({ readReportLogin: async () => ({ ok: false, code: "CRED_MISSING", slot: "report" }) }) });
  assert.equal(r.result.code, "CRED_MISSING"); assert.equal(r.exit, EXIT.CRED_OR_CONNSTRING);
});
test("output is sanitized: no connection string / host / password / role ever emitted", async () => {
  const { result } = await runP3Precheck({ argv: args(["--confirm-prereqs-met"]), deps: deps({ makePool: () => fakePool({ n: 0 }) }) });
  const s = JSON.stringify(result);
  for (const secretish of ["postgresql://", "mv_booking_report", "pw@", DIRECT_HOST, "password"]) assert.equal(s.includes(secretish), false, `must not leak ${secretish}`);
  assert.equal(result.schema, SCHEMA);
});
test("R1 drift guard: direct endpoint is pinned; the DEV login is distinct from the report permission-role label", () => {
  const src = readFileSync(join(HERE, "run-r1-launcher.mjs"), "utf8");
  const direct = src.match(/direct:\s*\{\s*host:\s*"([^"]+)",\s*port:\s*"([^"]+)",\s*database:\s*"([^"]+)"/);
  assert.ok(direct, "could not find ENDPOINTS.direct");
  assert.equal(DIRECT_HOST, direct[1]);
  assert.equal(REQUIRED_PORT, direct[2]);
  assert.equal(REQUIRED_DB_PATH, "/" + direct[3]);
  assert.equal(SLOT_ROLES.report, "mv_booking_report");
  assert.equal(REQUIRED_REPORT_USER, "mv_booking_report_dev");
  assert.notEqual(REQUIRED_REPORT_USER, SLOT_ROLES.report);
});
test("CA fixture digest equals the pinned value", () => { assert.equal(createHash("sha256").update(CA_BYTES).digest("hex"), CA_SHA256_PIN); });
test("importing the CLI opens no socket (no-connect-on-import)", () => {
  const probe = `
    const net = require("node:net"); const tls = require("node:tls");
    const trap = (n) => { throw new Error("CONNECT_ON_IMPORT:" + n); };
    net.Socket.prototype.connect = () => trap("net.Socket.connect"); net.connect = () => trap("net.connect"); net.createConnection = () => trap("net.createConnection"); tls.connect = () => trap("tls.connect");
    import(${JSON.stringify(join(HERE, "run-p3-precheck-cli.mjs"))}).then(() => console.log("IMPORT_OK")).catch((e) => { console.error(String(e)); process.exit(1); });
  `;
  assert.match(execFileSync(process.execPath, ["--input-type=commonjs", "-e", probe], { encoding: "utf8" }), /IMPORT_OK/);
});

// ---------- R4: launcher digest closure transitively covers the new leaf ----------
test("R4: NATIVE_EXEC_SOURCES lists the leaf, and the launcher's relative imports are all closure members", () => {
  const cli = readFileSync(join(HERE, "run-plan-cli-main.mjs"), "utf8");
  const block = cli.slice(cli.indexOf("NATIVE_EXEC_SOURCES"));
  const members = new Set([...block.slice(0, block.indexOf("]);")).matchAll(/"([^"]+)"/g)].map((m) => m[1]));
  assert.ok(members.has("scripts/e7-connected/run-lock-precheck.mjs"), "leaf must be in NATIVE_EXEC_SOURCES");
  assert.ok(members.has("scripts/e7-connected/run-r1-launcher.mjs"));
  const launcher = readFileSync(join(HERE, "run-r1-launcher.mjs"), "utf8");
  const rels = [...launcher.matchAll(/^\s*(?:import|export)\b[^"'\n]*?["'](\.[^"']+)["']/gm)].map((m) => m[1]);
  for (const rel of rels) {
    const resolved = join("scripts/e7-connected", rel);             // normalizes ./ and ../../ → repo-relative path
    assert.ok(members.has(resolved), `launcher import ${rel} (→ ${resolved}) must be a closure member`);
  }
});

// ---------- O1: sanitized failure observability (transparent adapter; leaf unchanged) ----------
const OBS_KEYS = ["clientAcquired", "connectionAttempted", "failureClass", "lateClient", "phase", "queryAttempted", "queryCompleted"];
const SECRETISH = ["postgresql://", "mv_booking_report", "pw@", DIRECT_HOST, "password", "SECRET", "stack", "Error"];
const tick = () => new Promise((r) => setImmediate(r));
function ctlProc() {
  const timers = new Set(); let throwOn = -1; let calls = 0;
  return {
    proc: { setTimer(fn, ms) { if (calls++ === throwOn) throw new Error("timer setup"); const t = { fn, ms }; timers.add(t); return t; }, clearTimer(t) { timers.delete(t); } },
    fire() { const [t] = [...timers]; assert.ok(t, "a timer must be armed"); timers.delete(t); t.fn(); },
    throwOnCall(i) { throwOn = i; }, armed: () => timers.size
  };
}
const secretErr = (code) => { const e = new Error("SECRET postgresql://mv_booking_report_dev:pw@" + DIRECT_HOST + " password"); if (code !== undefined) e.code = code; return e; };
function emClient(query) {
  const c = new EventEmitter(); c.queries = []; c.releases = [];
  c.query = function (...a) { c.queries.push({ self: this, a }); return query(...a); };
  c.release = function (...a) { c.releases.push({ self: this, a }); };
  return c;
}
function poolOf(connect, end = () => Promise.resolve()) { const p = { connects: 0, end }; p.connect = function () { p.connects++; p.self = this; return connect(); }; return p; }
const confirmedRun = (pool, over = {}) => runP3Precheck({ argv: args(["--confirm-prereqs-met"]), deps: deps({ makePool: () => pool, ...over }) });
function assertObs(result, want) {
  const o = result.observation;
  assert.deepEqual(Object.keys(o).sort(), OBS_KEYS);
  assert.ok(OBS_PHASES.includes(o.phase), o.phase);
  assert.ok(o.failureClass === null || FAILURE_CLASSES.includes(o.failureClass), String(o.failureClass));
  assert.ok(LATE_CLIENT.includes(o.lateClient));
  assert.equal(result.connected, o.clientAcquired, "connected is truthful (== actual acquisition)");
  for (const [k, v] of Object.entries(want)) assert.equal(o[k], v, k);
  const s = JSON.stringify(result);
  for (const x of SECRETISH) assert.equal(s.includes(x), false, `must not leak ${x}`);
  assert.equal(result.schema, SCHEMA);
}

test("O1 classifyFailure: exact allowlist → labels; unknown / non-string / accessor / proxy / primitive → OTHER; no getter or trap runs", () => {
  const known = { "28P01": "AUTH_CREDENTIAL_REJECTED", "28000": "AUTH_NOT_AUTHORIZED", "3D000": "DB_NOT_FOUND", "42501": "QUERY_PRIVILEGE_DENIED",
    "57014": "QUERY_CANCELED", "57P01": "SERVER_ADMIN_SHUTDOWN", ENETUNREACH: "NET_UNREACHABLE", ECONNREFUSED: "NET_REFUSED", ENOTFOUND: "DNS_NOT_FOUND",
    SELF_SIGNED_CERT_IN_CHAIN: "TLS_UNTRUSTED_CHAIN", ERR_TLS_CERT_ALTNAME_INVALID: "TLS_NAME_MISMATCH", CERT_HAS_EXPIRED: "TLS_CERT_EXPIRED" };
  for (const [code, label] of Object.entries(known)) assert.equal(classifyFailure(secretErr(code)), label, code);
  for (const v of [undefined, null, 0, "28P01", Symbol("x"), secretErr(), secretErr("28p01"), secretErr("XX000"), secretErr("postgresql://mv_booking_report_dev:pw@h"),
    Object.assign(new Error("m"), { code: 28 }), Object.assign(new Error("m"), { code: { toString: () => "28P01" } }), Object.create({ code: "28P01" })])
    assert.equal(classifyFailure(v), "OTHER");
  let touched = 0;
  const getterErr = new Error("m"); Object.defineProperty(getterErr, "code", { get() { touched++; return "28P01"; } });
  Object.defineProperty(getterErr, "message", { get() { touched++; return "SECRET"; } });
  assert.equal(classifyFailure(getterErr), "OTHER");
  const prox = new Proxy({ code: "28P01" }, { get() { touched++; return "28P01"; }, getOwnPropertyDescriptor() { touched++; return undefined; } });
  assert.equal(classifyFailure(prox), "OTHER");
  assert.equal(touched, 0, "no getter / proxy trap may run");
  for (const l of FAILURE_CLASSES) assert.match(l, /^[A-Z][A-Z_]*$/);
});

test("O1 instrumentPool is transparent: same receivers, args, results, thrown and rejected objects; invalid client passes through", async () => {
  const e1 = secretErr("28P01"); const res = { rows: [{ n: 0 }] }; const e2 = secretErr("42501");
  let i = instrumentPool(poolOf(() => { throw e1; }));
  assert.throws(() => i.pool.connect(), (e) => e === e1);
  const rp = poolOf(() => Promise.reject(e1)); i = instrumentPool(rp);
  await assert.rejects(i.pool.connect(), (e) => e === e1); assert.equal(rp.self, rp, "pool.connect called with the real pool as this");
  const c = emClient((...a) => (a[0] === "bad" ? Promise.reject(e2) : Promise.resolve(res)));
  i = instrumentPool(poolOf(() => Promise.resolve(c)));
  const w = await i.pool.connect();
  assert.notEqual(w, c); assert.deepEqual(Object.keys(w).sort(), ["on", "query", "release", "removeListener"]);
  assert.equal(await w.query("sql", ["k"]), res); assert.equal(c.queries[0].self, c); assert.deepEqual(c.queries[0].a, ["sql", ["k"]]);
  await assert.rejects(w.query("bad"), (e) => e === e2);
  const sync = emClient(() => { throw e2; }); i = instrumentPool(poolOf(() => Promise.resolve(sync)));
  const ws = await i.pool.connect(); assert.throws(() => ws.query("x"), (e) => e === e2);
  const r0 = w.release(true, 7); assert.equal(r0, undefined); assert.deepEqual(c.releases[0].a, [true, 7]); assert.equal(c.releases[0].self, c);
  i = instrumentPool(poolOf(() => Promise.resolve(null))); assert.equal(await i.pool.connect(), null);
  const bare = { query: () => Promise.resolve(res) }; i = instrumentPool(poolOf(() => Promise.resolve(bare)));
  assert.deepEqual(Object.keys(await i.pool.connect()), ["query"], "only methods the real client has are exposed (mirrors the leaf's optional calls)");
});

test("O1 connect THROW (sync) / REJECT: classified, connected false, code+exit+cleanup unchanged", async () => {
  let r = await confirmedRun(poolOf(() => { throw secretErr("28P01"); }));
  assert.equal(r.result.code, "LOCK_PRECHECK_UNAVAILABLE"); assert.equal(r.exit, EXIT.PRECHECK_UNAVAILABLE); assert.equal(r.result.cleanup, "POOL_ENDED");
  assertObs(r.result, { phase: "CONNECT_THROWN", failureClass: "AUTH_CREDENTIAL_REJECTED", connectionAttempted: true, clientAcquired: false, queryAttempted: false, lateClient: "NONE" });
  for (const [code, label] of [["28P01", "AUTH_CREDENTIAL_REJECTED"], ["ENETUNREACH", "NET_UNREACHABLE"], ["SELF_SIGNED_CERT_IN_CHAIN", "TLS_UNTRUSTED_CHAIN"], ["XX999", "OTHER"], [undefined, "OTHER"]]) {
    r = await confirmedRun(poolOf(() => Promise.reject(secretErr(code))));
    assert.equal(r.result.code, "LOCK_PRECHECK_UNAVAILABLE"); assert.equal(r.exit, EXIT.PRECHECK_UNAVAILABLE);
    assertObs(r.result, { phase: "CONNECT_REJECTED", failureClass: label, clientAcquired: false, queryAttempted: false, queryCompleted: false });
  }
  r = await confirmedRun(poolOf(() => Promise.resolve(null)));
  assertObs(r.result, { phase: "CONNECT_INVALID_CLIENT", failureClass: "OTHER", clientAcquired: false });
});

test("O1 connect PENDING → leaf connect bound fires → CONNECT_PENDING; a LATE client is released on arrival and never queried", async () => {
  const ctl = ctlProc(); let arrive; const late = emClient(() => Promise.resolve({ rows: [{ n: 0 }] }));
  const pool = poolOf(() => new Promise((res) => { arrive = res; }), () => { arrive(late); return Promise.resolve(); });
  const run = confirmedRun(pool, { makeProc: () => ctl.proc });
  await tick(); ctl.fire();                                          // the leaf's 10s connect bound
  const r = await run;
  assert.equal(r.result.code, "LOCK_PRECHECK_UNAVAILABLE"); assert.equal(r.exit, EXIT.PRECHECK_UNAVAILABLE);
  assertObs(r.result, { phase: "CONNECT_PENDING", failureClass: null, connectionAttempted: true, clientAcquired: false, lateClient: "RELEASED" });
  assert.equal(late.queries.length, 0); assert.equal(late.releases.length, 1); assert.deepEqual(late.releases[0].a, [true]);
  assert.equal(late.listenerCount("error"), 0);
});

test("O1 NOT_ATTEMPTED (pre-aborted) and ACQUIRED_NO_QUERY (query-bound setup throws): client released exactly once", async () => {
  const ac = new AbortController(); ac.abort();
  let r = await confirmedRun(poolOf(() => Promise.resolve(emClient(() => Promise.resolve({ rows: [{ n: 0 }] })))), { makeSignal: () => ({ signal: ac.signal, cancel: () => {} }) });
  assert.equal(r.result.code, "LOCK_PRECHECK_INTERRUPTED"); assert.equal(r.exit, EXIT.INTERRUPTED);
  assertObs(r.result, { phase: "NOT_ATTEMPTED", connectionAttempted: false, clientAcquired: false });
  const ctl = ctlProc(); ctl.throwOnCall(1); const c = emClient(() => Promise.resolve({ rows: [{ n: 0 }] }));
  r = await confirmedRun(poolOf(() => Promise.resolve(c)), { makeProc: () => ctl.proc });
  assert.equal(r.result.code, "LOCK_PRECHECK_UNAVAILABLE");
  assertObs(r.result, { phase: "ACQUIRED_NO_QUERY", clientAcquired: true, queryAttempted: false });
  assert.equal(c.queries.length, 0); assert.equal(c.releases.length, 1); assert.equal(c.listenerCount("error"), 0);
});

test("O1 acquired + query REJECT / THROW: classified; connected true only because a client was acquired", async () => {
  for (const [code, label] of [["42501", "QUERY_PRIVILEGE_DENIED"], ["57014", "QUERY_CANCELED"], ["nope", "OTHER"]]) {
    const c = emClient(() => Promise.reject(secretErr(code)));
    const r = await confirmedRun(poolOf(() => Promise.resolve(c)));
    assert.equal(r.result.code, "LOCK_PRECHECK_UNAVAILABLE"); assert.equal(r.exit, EXIT.PRECHECK_UNAVAILABLE);
    assertObs(r.result, { phase: "QUERY_REJECTED", failureClass: label, clientAcquired: true, queryAttempted: true, queryCompleted: false });
    assert.equal(c.releases.length, 1); assert.deepEqual(c.releases[0].a, [true]); assert.equal(c.listenerCount("error"), 0);
  }
  const c = emClient(() => { throw secretErr("42501"); });
  const r = await confirmedRun(poolOf(() => Promise.resolve(c)));
  assertObs(r.result, { phase: "QUERY_THROWN", failureClass: "QUERY_PRIVILEGE_DENIED", clientAcquired: true, queryAttempted: true });
  assert.equal(c.releases.length, 1);
});

test("O1 query PENDING → leaf query bound fires → QUERY_PENDING; listener attached once while held and removed with a single release", async () => {
  const ctl = ctlProc(); const c = emClient(() => new Promise(() => {}));
  const run = confirmedRun(poolOf(() => Promise.resolve(c)), { makeProc: () => ctl.proc });
  await tick(); assert.equal(c.listenerCount("error"), 1, "exactly one (forwarding) listener while held");
  ctl.fire();                                                        // the leaf's 5s query bound
  const r = await run;
  assert.equal(r.result.code, "LOCK_PRECHECK_UNAVAILABLE");
  assertObs(r.result, { phase: "QUERY_PENDING", failureClass: null, clientAcquired: true, queryAttempted: true, queryCompleted: false });
  assert.equal(c.releases.length, 1); assert.equal(c.listenerCount("error"), 0); assert.equal(ctl.armed(), 0);
});

test("O1 BAD SHAPE result → QUERY_RESULT_INVALID; success → QUERY_OK with code/exit unchanged (CLEAR 0 / PRESENT 8)", async () => {
  for (const rows of [[{ n: "0" }], [{ n: -1 }], [], [{ n: 0 }, { n: 0 }], null]) {
    const r = await confirmedRun(poolOf(() => Promise.resolve(emClient(() => Promise.resolve(rows === null ? {} : { rows })))));
    assert.equal(r.result.code, "LOCK_PRECHECK_UNAVAILABLE");
    assertObs(r.result, { phase: "QUERY_RESULT_INVALID", failureClass: null, clientAcquired: true, queryAttempted: true, queryCompleted: true });
  }
  for (const [n, code, exit] of [[0, "LOCK_PRECHECK_CLEAR", EXIT.CLEAR], [2, "RUN_LOCK_PRESENT_BEFORE_START", EXIT.RUN_LOCK_PRESENT]]) {
    const c = emClient(() => Promise.resolve({ rows: [{ n }] }));
    const r = await confirmedRun(poolOf(() => Promise.resolve(c)));
    assert.equal(r.result.code, code); assert.equal(r.exit, exit); assert.equal(r.result.cleanup, "POOL_ENDED");
    assertObs(r.result, { phase: "QUERY_OK", failureClass: null, connectionAttempted: true, clientAcquired: true, queryAttempted: true, queryCompleted: true, lateClient: "NONE" });
    assert.equal(c.queries.length, 1); assert.equal(c.queries[0].self, c); assert.equal(c.releases.length, 1); assert.deepEqual(c.releases[0].a, [true]);
  }
});

test("O1 client async ERROR while held → CLIENT_ERROR; the leaf's error veto still wins over a later clean result", async () => {
  let answer; const c = emClient(() => new Promise((res) => { answer = res; }));
  const run = confirmedRun(poolOf(() => Promise.resolve(c)));
  await tick();
  c.emit("error", secretErr("57P01"));                               // forwarded to the leaf's onErr through our wrapper
  answer({ rows: [{ n: 0 }] });                                      // a queued clean result afterwards must NOT clear
  const r = await run;
  assert.equal(r.result.code, "LOCK_PRECHECK_UNAVAILABLE"); assert.equal(r.exit, EXIT.PRECHECK_UNAVAILABLE);
  assertObs(r.result, { phase: "CLIENT_ERROR", failureClass: "SERVER_ADMIN_SHUTDOWN", clientAcquired: true, queryAttempted: true });
  assert.equal(c.releases.length, 1); assert.equal(c.listenerCount("error"), 0);
});

test("O1 malicious errors: accessor code / proxy / secret-bearing code+message → OTHER, nothing leaked, no getter or trap runs", async () => {
  let touched = 0;
  const g = secretErr(); Object.defineProperty(g, "code", { get() { touched++; return "28P01"; } });
  const px = new Proxy(secretErr("28P01"), { get() { touched++; return "x"; }, getOwnPropertyDescriptor() { touched++; return undefined; }, ownKeys() { touched++; return []; } });
  for (const e of [g, px, secretErr("postgresql://mv_booking_report_dev:pw@" + DIRECT_HOST + "/postgres"), secretErr("password")]) {
    const r = await confirmedRun(poolOf(() => Promise.reject(e)));
    assertObs(r.result, { phase: "CONNECT_REJECTED", failureClass: "OTHER" });
    const c = emClient(() => Promise.reject(e));
    const q = await confirmedRun(poolOf(() => Promise.resolve(c)));
    assertObs(q.result, { phase: "QUERY_REJECTED", failureClass: "OTHER" });
  }
  assert.equal(touched, 0);
});

test("O1 cleanup UNCONFIRMED still overrides a CLEAR exit; observation unaffected", async () => {
  const pool = poolOf(() => Promise.resolve(emClient(() => Promise.resolve({ rows: [{ n: 0 }] }))), () => new Promise(() => {}));
  const r = await confirmedRun(pool, { poolEndTimers: { setTimer: (fn) => { fn(); return {}; }, clearTimer: () => {} } });
  assert.equal(r.result.code, "LOCK_PRECHECK_CLEAR"); assert.equal(r.result.cleanup, "POOL_END_UNCONFIRMED"); assert.equal(r.exit, EXIT.CLEANUP_UNCONFIRMED);
  assertObs(r.result, { phase: "QUERY_OK", clientAcquired: true });
});

test("O1 offline HELD path is unchanged: connected false, no observation, connect never called", async () => {
  const pool = poolOf(() => Promise.resolve(emClient(() => Promise.resolve({ rows: [{ n: 0 }] }))));
  const r = await runP3Precheck({ argv: args(), deps: deps({ makePool: () => pool }) });
  assert.deepEqual(Object.keys(r.result).sort(), ["caPinned", "cleanup", "code", "connected", "poolConfigAccepted", "schema"]);
  assert.equal(r.result.code, "VALIDATED_HELD"); assert.equal(r.result.connected, false); assert.equal(r.exit, EXIT.HELD); assert.equal(pool.connects, 0);
});

test("O1 scope pin: leaf / launcher / pool / reader bytes are unchanged from merged cc37fad4", () => {
  const pins = { "scripts/e7-connected/run-lock-precheck.mjs": "579f619d4580481a1ec5f8c524832b72cd1ce0e0fc2503e7d6a839ebab20416d",
    "scripts/e7-connected/run-r1-launcher.mjs": "40aad5537340457dd21e7020d42b8a03cd05db28a2938ca1bc46574d88cfee67",
    "lib/booking-db/pool.js": "c8b615d98f85602b42d5bc722395cb25cc51e36d4fd1eeb272fa7bce9b5dabeb",
    "scripts/e7-connected/db-credential-file.mjs": "f7f79dbc1b59507893f0bf9e518faf511d1ae8189d47fac94377e3a6fb81643a" };
  for (const [rel, h] of Object.entries(pins)) assert.equal(createHash("sha256").update(readFileSync(join(REPO_ROOT, rel))).digest("hex"), h, rel);
});

test("O1 late-client disposal is confirmed ONLY after release returns: throw → NOT_RELEASED (same object), return → RELEASED, missing → NOT_RELEASED", async () => {
  async function lateWith(client) {
    let arrive; const i = instrumentPool(poolOf(() => new Promise((res) => { arrive = res; })));
    const pending = i.pool.connect();
    i.snapshot("LOCK_PRECHECK_UNAVAILABLE");                         // the leaf settled before the client arrived
    arrive(client);
    return { i, w: await pending };
  }
  // release throws → disposal NOT confirmed; the SAME thrown object propagates with the same receiver and args
  const boom = secretErr("XX000"); const seen = [];
  const thrower = { release(...a) { seen.push({ self: this, a }); throw boom; } };
  let { i, w } = await lateWith(thrower);
  assert.throws(() => w.release(true), (e) => e === boom);
  assert.equal(seen.length, 1); assert.equal(seen[0].self, thrower); assert.deepEqual(seen[0].a, [true]);
  assert.equal(i.lateClient(), "NOT_RELEASED");
  // release returns → RELEASED, and the SAME return value is passed through
  const token = { ok: 1 }; const good = { release(...a) { seen.push({ self: this, a }); return token; } };
  ({ i, w } = await lateWith(good));
  assert.equal(i.lateClient(), "NOT_RELEASED", "not confirmed before release is called");
  assert.equal(w.release(true), token); assert.equal(seen[1].self, good);
  assert.equal(i.lateClient(), "RELEASED");
  // no release method → not exposed (mirrors the leaf's call) and never confirmed
  ({ i, w } = await lateWith({ query: () => Promise.resolve({ rows: [{ n: 0 }] }) }));
  assert.equal("release" in w, false);
  assert.equal(i.lateClient(), "NOT_RELEASED");
  // end-to-end through the UNCHANGED leaf: a late client whose release throws is reported NOT_RELEASED; leaf still calls it exactly once
  const ctl = ctlProc(); let arrive2; const calls = [];
  const late = { on() {}, removeListener() {}, query: () => Promise.resolve({ rows: [{ n: 0 }] }), release(...a) { calls.push(a); throw secretErr("XX000"); } };
  const pool = poolOf(() => new Promise((res) => { arrive2 = res; }), () => { arrive2(late); return Promise.resolve(); });
  const run = confirmedRun(pool, { makeProc: () => ctl.proc });
  await tick(); ctl.fire();
  const r = await run;
  assertObs(r.result, { phase: "CONNECT_PENDING", clientAcquired: false, lateClient: "NOT_RELEASED" });
  assert.equal(calls.length, 1); assert.deepEqual(calls[0], [true]);
  assert.equal(r.result.code, "LOCK_PRECHECK_UNAVAILABLE"); assert.equal(r.result.cleanup, "POOL_ENDED");
});

test("O1 query settled during a throwing release is ignored after the leaf stopped, even before snapshot", async () => {
  const ctl = ctlProc(); let answer;
  const c = emClient(() => new Promise((resolve) => { answer = resolve; }));
  c.release = function (...a) {
    c.releases.push({ self: this, a });
    answer({ rows: [{ n: 0 }] });
    throw secretErr("XX000");
  };
  const run = confirmedRun(poolOf(() => Promise.resolve(c)), { makeProc: () => ctl.proc });
  await tick(); ctl.fire();
  const r = await run;
  assert.equal(r.result.code, "LOCK_PRECHECK_UNAVAILABLE");
  assert.equal(r.exit, EXIT.PRECHECK_UNAVAILABLE);
  assertObs(r.result, { phase: "QUERY_RESULT_IGNORED", clientAcquired: true, queryAttempted: true, queryCompleted: true });
  assert.equal(c.releases.length, 1);
  assert.deepEqual(c.releases[0].a, [true]);
  assert.equal(c.listenerCount("error"), 0);
});
