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
import { runP3Precheck, parseArgs, gateDirectReportUrl, endPoolBounded, DIRECT_HOST, REQUIRED_PORT, REQUIRED_DB_PATH, REQUIRED_REPORT_USER, CA_SHA256_PIN, SCHEMA, EXIT } from "./run-p3-precheck-cli.mjs";
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
