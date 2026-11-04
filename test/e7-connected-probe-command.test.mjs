// test/e7-connected-probe-command.test.mjs — E7 probe CLI stage C2 (OFFLINE, FAKE-ONLY). Contract §11 / §12.
// LABELS
//   * REAL (accepted, unchanged): C1 (env + credential modules), P, T, X, and the NEW C2 command + digest helper under test.
//   * FAKE (TEST-ONLY): the C1 credential fs, the output fs + handle, the plan reader, env snapshots, the https primitive (a labelled COPY of
//     the accepted rehearsal doubles, test/e7-connected-probe-stack-rehearsal.test.mjs), P's clock + timers (time moves only when a test
//     advances it; no sleeps), source byte snapshots and every reply. node:https request / Agent are replaced by counting GUARDS before X
//     loads; the guards and a fetch guard must count 0.
//   * SYNTHETIC: short token / `sk_test_Fake1` key / ids. No real credential, temp file, env, owner, account, network, PG or install.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const GUARD = { request: 0, Agent: 0 };
const realRequest = https.request; const RealAgent = https.Agent;
https.request = function guardRequest() { GUARD.request += 1; throw new Error("real https.request refused (offline)"); };
https.Agent = function GuardAgent() { GUARD.Agent += 1; throw new Error("real https.Agent refused (offline)"); };
syncBuiltinESMExports();
const C = await import("../scripts/e7-connected/probe-command.mjs");
https.request = realRequest; https.Agent = RealAgent; syncBuiltinESMExports();
const D = await import("../scripts/e7-connected/probe-source-digest.mjs");
const P = await import("../scripts/e7-connected/readonly-probe.mjs");
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let netAttempts = 0; const realFetch = globalThis.fetch;
globalThis.fetch = async () => { netAttempts += 1; throw new Error("network refused (offline)"); };
let unhandled = 0; const onU = () => { unhandled += 1; }; process.on("unhandledRejection", onU);
after(() => {
  globalThis.fetch = realFetch; process.off("unhandledRejection", onU);
  assert.deepEqual([netAttempts, GUARD.request, GUARD.Agent, unhandled], [0, 0, 0, 0], "no network / native primitive / unhandled rejection");
});

// ---- SYNTHETIC values ---------------------------------------------------------------------------------------------------------------
const HTOKEN = "tokFake1"; const SKEY = "sk_test_Fake1"; const VERSION = "2026-08-26.dahlia";
const L = 871001; const L1 = 871001; const L2 = 871002; const R1 = "6100001"; const R2 = "6100002"; const ACCT = "acct_1SyntheticProbe"; const PI = "pi_test_syntheticProbe1";
const SENT = ["SENTINEL_GUEST_NAME", "sentinel.guest@mv-test.invalid", "SENTINEL_TITLE", "SENTINEL_PROVIDER_TEXT"];
const PLAN_PATH = "/home/fake/plans/plan.json"; const CRED_PATH = "/home/fake/.config/e7/creds.json"; const OUT_DIR = "/home/fake/out"; const OUT = `${OUT_DIR}/summary.json`;
const REPO = "/home/fake/repo"; const DIGEST = "d".repeat(64);
const enc = (s) => new TextEncoder().encode(s); const dec = (b) => new TextDecoder().decode(b);
const tick = () => new Promise((r) => setImmediate(r));
const flush = async (n = 8) => { for (let i = 0; i < n; i++) await tick(); };
const revoked = () => { const r = Proxy.revocable({}, {}); r.revoke(); return r.proxy; };

// ---- FAKE https primitive (labelled COPY of the accepted rehearsal doubles) ------------------------------------------------------------
class FakeRes extends EventEmitter {
  constructor(req, statusCode, rawHeaders) { super(); this.req = req; this.statusCode = statusCode; this.rawHeaders = rawHeaders; this.complete = false; this.closed = false; }
  destroy() { if (this._d) return; this._d = true; process.nextTick(() => { if (!this.closed) { this.closed = true; this.emit("close"); } this.req._closeOnce(); }); }
}
class FakeReq extends EventEmitter {
  constructor(fx, options) { super(); this.fx = fx; this.options = options; this.endArgs = null; this.res = null; this.closed = false; }
  end(...a) { this.endArgs = a; if (this.fx.onEnd) this.fx.onEnd(this); }
  _closeOnce() { if (!this.closed) { this.closed = true; this.emit("close"); } }
  destroy() {
    if (this._d) return; this._d = true;
    process.nextTick(() => {
      const res = this.res;
      if (res === null) { this.emit("error", Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })); this._closeOnce(); return; }
      if (!res.closed) { res.emit("aborted"); this._closeOnce(); res.emit("error", Object.assign(new Error("aborted"), { code: "ECONNRESET" })); res.closed = true; res.emit("close"); }
      else this._closeOnce();
    });
  }
}
function routedPrimitive(route) {
  const fx = { agents: 0, reqs: 0, auth: [] };
  class FakeAgent { constructor() { fx.agents += 1; } destroy() {} }
  fx.Agent = FakeAgent;
  fx.request = (options) => { fx.reqs += 1; const r = new FakeReq(fx, options); if (fx.onRequest) fx.onRequest(r); return r; };
  fx.onEnd = (req) => setImmediate(() => {
    const o = req.options; fx.auth.push(o.headers.Authorization);
    const r = route(o, req); if (r.hold) return;
    const body = Buffer.from(JSON.stringify(r.json ?? {}));
    const res = new FakeRes(req, r.status, ["Content-Type", "application/json"]); req.res = res; req.emit("response", res);
    res.emit("data", body.subarray(0, 7)); res.emit("data", body.subarray(7)); res.complete = true; res.emit("end"); req._closeOnce(); if (!res.closed) { res.closed = true; res.emit("close"); }
  });
  return fx;
}
function fakeTime() {
  const c = { t: 0, timers: [] };
  c.monotonic = () => c.t;
  c.arm = (ms) => { let res; const promise = new Promise((a) => { res = a; }); const e = { at: c.t + ms, res, cancels: 0, fired: false }; c.timers.push(e); return { promise, cancel: () => { e.cancels += 1; } }; };
  c.advance = async (ms) => { c.t += ms; for (const e of c.timers) if (!e.cancels && !e.fired && e.at <= c.t) { e.fired = true; e.res(); } await flush(); };
  return c;
}
// ---- SYNTHETIC replies (labelled copy of the rehearsal's) -----------------------------------------------------------------------------
const listing = { status: "success", result: { id: L, currencyCode: "USD", name: SENT[3] } };
const calendar = (dates = ["2026-12-01", "2026-12-02", "2026-12-03"]) => ({ status: "success", result: dates.map((date) => ({ date, isAvailable: 1, status: "available", minimumStay: 1, maximumStay: 90 })) });
const reservation = { status: "success", result: { id: Number(R1), listingMapId: L1, channelId: 2000, arrivalDate: "2026-12-04", departureDate: "2026-12-06", totalPrice: 500, currency: "USD",
  status: "new", guestName: SENT[0], guestEmail: SENT[1], customFieldValues: [] } };
const row = (rid, lid, id) => ({ id, reservationId: Number(rid), listingMapId: lid, type: "charge", title: SENT[2], currency: "USD", status: "paid", paymentProvider: "offline",
  paymentMethod: "credit_card", amount: 500 });
const charges = (rows) => ({ status: "success", result: rows, count: rows.length, offset: null });
const account = { object: "account", id: ACCT, email: SENT[1] };
const piObj = { object: "payment_intent", id: PI, livemode: false, status: "requires_capture", capture_method: "manual", amount: 50000, amount_capturable: 50000, amount_received: 0,
  currency: "usd", metadata: { note: SENT[3] }, latest_charge: { object: "charge", id: "ch_test_1", payment_intent: PI, status: "succeeded", paid: true, captured: false, amount: 50000,
    amount_captured: 0, amount_refunded: 0, currency: "usd", livemode: false, payment_method_details: { card: { capture_before: 1798761600 } } } };
const defaultRoute = (o) => {
  const u = new URL(`https://${o.hostname}${o.path}`); const q = Object.fromEntries(u.searchParams);
  if (o.hostname === "api.stripe.com") return { status: 200, json: u.pathname === "/v1/account" ? account : piObj };
  if (u.pathname === `/v1/listings/${L}`) return { status: 200, json: listing };
  if (u.pathname.endsWith("/calendar")) return { status: 200, json: calendar() };
  if (u.pathname === `/v1/reservations/${R1}`) return { status: 200, json: reservation };
  if (u.pathname === "/v1/guestPayments/charges") return { status: 200, json: q.reservationIds === R1 ? charges([row(R1, L1, 9001)]) : charges([row(R2, L2, 9002)]) };
  return { status: 404, json: { status: "fail" } };
};
const FULL = ["P-H1", "P-H2", "P-H4", "P-H5", "P-H6", "P-S1", "P-S2"];
const planInput = (o = {}) => ({ version: "e7-probe-plan-v1",
  metadata: { reviewedCommit: "27c0ea1152db904f9fdeb285d0682a28cb89ac17", nodeVersion: "22.22.0", stripeVersion: VERSION, approvalRef: "synthetic-c2" },
  hostaway: { listingId: L, calendar: { startDate: "2026-12-01", endDate: "2026-12-03" }, lookup: null, sample: { reservationId: R1, listingId: L1 }, control: { reservationId: R2, listingId: L2 } },
  stripe: { accountId: ACCT, paymentIntentId: PI }, probes: FULL, limits: { perProbeMs: 15000, runMs: 180000, tailMs: 0 }, ...o });
const H_ONLY = { hostaway: { listingId: L, calendar: null, lookup: null, sample: null, control: null }, stripe: null, probes: ["P-H1"] };
const S_ONLY = { hostaway: null, stripe: { accountId: ACCT, paymentIntentId: null }, probes: ["P-S1"] };
const planHashOf = (pi) => P.validateProbePlan(pi).plan.planHash;
const planBytes = (pi) => enc(`${P.canonicalJson(pi)}\n`);

// ---- FAKE fs doubles -------------------------------------------------------------------------------------------------------------------
const enoent = () => Object.assign(new Error("fake"), { code: "ENOENT" });
const stat = (o = {}) => ({ dev: "1", ino: "42", kind: "file", mode: 0o100600, nlink: 1, size: 1, uid: 501, mtimeNs: "1", ctimeNs: "2", ...o });
function credFs(o = {}) {
  const content = enc(JSON.stringify(o.body ?? { hostawayToken: HTOKEN, stripeTestKey: SKEY }));
  const log = []; let pos = 0;
  const st = () => stat({ size: content.length });
  const fs = { platform: "linux", uid: 501,
    realpath: (p) => { log.push("realpath"); return Promise.resolve(p); },
    lstat: (p) => { log.push("lstat"); if (p === CRED_PATH) return Promise.resolve(st()); return Promise.reject(enoent()); },
    open: () => { log.push("open"); if (o.onOpen) o.onOpen();
      return o.openP ?? Promise.resolve({ stat: () => Promise.resolve(st()), read: (buf, off, len) => { const n = Math.min(len, content.length - pos); buf.set(content.subarray(pos, pos + n), off); pos += n; return Promise.resolve(n); },
        close: () => { log.push("close"); return Promise.resolve(undefined); } }); } };
  return { fs, log };
}
function outFs(o = {}) {
  const log = []; const written = [];
  const handle = () => {
    const h = { write: (b, off, len) => { log.push("write"); if (o.write) return o.write(b, off, len, written); written.push(...b.subarray(off, off + len)); return Promise.resolve(len); },
      sync: () => { log.push("sync"); return o.sync ? o.sync() : Promise.resolve(undefined); },
      close: () => { log.push("close"); return o.close ? o.close() : Promise.resolve(undefined); } };
    return o.handle ? o.handle(h) : h;
  };
  const fs = { platform: "linux", uid: 501,
    realpath: (p) => { log.push("realpath"); return Promise.resolve(o.realpath ? o.realpath(p) : p); },
    lstat: (p) => { log.push(`lstat ${p}`);
      if (o.lstat) { const r = o.lstat(p); if (r !== undefined) return r; }
      if (p === OUT_DIR) return Promise.resolve(stat({ kind: "dir", mode: 0o40700, size: 64, ...o.dirStat }));
      if (p === OUT && o.exists) return Promise.resolve(stat());
      return Promise.reject(enoent()); },
    create: (p, kind) => { log.push(`create ${kind}`); return o.create ? o.create(handle) : Promise.resolve(handle()); } };
  return { fs, log, written: () => new Uint8Array(written) };
}
const present = () => Object.freeze(Object.fromEntries(["NODE_OPTIONS", "NODE_TLS_REJECT_UNAUTHORIZED", "NODE_EXTRA_CA_CERTS", "NODE_USE_ENV_PROXY", "NODE_DEBUG", "NODE_DEBUG_NATIVE",
  "SSLKEYLOGFILE", "OPENSSL_CONF", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy"].map((k) => [k, false])));
const envSnap = (o = {}) => Object.freeze({ schema: "e7-probe-env-snapshot-v1", nodeVersion: "22.22.0", platform: "linux", execArgvCount: 0, uidAvailable: true, present: present(), ...o });

/** one complete fake world; `w.calls` counts every injected boundary */
function world(o = {}) {
  const pi = planInput(o.plan);
  const fx = routedPrimitive(o.route ?? defaultRoute);
  const time = o.time ?? fakeTime();
  const cf = credFs(o.cred); const of = outFs(o.out);
  const ac = new AbortController();
  const planReads = [];
  const readPlanFile = o.readPlanFile ?? ((p) => { planReads.push(p); return Promise.resolve(o.planBytes ?? planBytes(pi)); });
  const inspectDeps = { envSnapshot: o.env ?? envSnap(), repoRoot: REPO, sourceDigest: o.sourceDigest === undefined ? DIGEST : o.sourceDigest, readPlanFile, interrupt: ac.signal };
  const deps = { ...inspectDeps, credentialFs: cf.fs, outputFs: of.fs, primitive: { request: fx.request, Agent: fx.Agent }, monotonic: time.monotonic, timers: { arm: time.arm } };
  const execArgv = ["execute", "--plan", PLAN_PATH, "--credentials", CRED_PATH, "--summary-out", OUT, "--expect-plan-hash", planHashOf(pi), "--expect-source-digest", DIGEST,
    "--expect-requests", String(pi.probes.length), "--approval-ref", pi.metadata.approvalRef];
  return { pi, fx, time, cf, of, ac, planReads, inspectDeps, deps, execArgv };
}
const runE = (w, argv = w.execArgv) => C.runProbeCommand({ argv, deps: w.deps });
const runI = (w, argv = ["--plan", PLAN_PATH]) => C.runProbeCommand({ argv, deps: w.inspectDeps });
const parseLine = (d) => JSON.parse(d.stdoutLine);
const zeroSecretSide = (w) => { assert.equal(w.cf.log.length, 0, "credential fs untouched"); assert.equal(w.fx.reqs + w.fx.agents, 0, "no primitive use"); };
const OUTPUT_SENTINELS = [HTOKEN, SKEY, PLAN_PATH, CRED_PATH, OUT, REPO, "/home/fake", String(L), R1, R2, ACCT, PI, ...SENT, "fake"];
function assertClean(d, w) {
  assert.ok(Object.isFrozen(d)); const s = d.stdoutLine + (w ? dec(w.of.written()) : "");
  for (const x of OUTPUT_SENTINELS) assert.ok(!s.includes(x), `leak: ${x}`);
  assert.ok(new TextEncoder().encode(d.stdoutLine).length <= C.MAX_STDOUT_BYTES);
}

// ===== 1. inspect ======================================================================================================================
test("C2-1 inspect (default and explicit): reports only; ZERO credential / output / primitive / clock / timer deps or calls; refuses secret flags", async () => {
  for (const argv of [["--plan", PLAN_PATH], ["inspect", "--plan", PLAN_PATH]]) {
    const w = world(); const d = await runI(w, argv);
    assert.equal(d.exitCode, 10); assert.equal(d.primaryOutcome, "CLI_INSPECT_OK"); assert.equal(d.summaryFile, "NOT_ATTEMPTED"); assert.equal(d.summaryCloseState, "NOT_OPENED");
    const e = parseLine(d); assert.equal(e.schema, C.CLI_STDOUT_SCHEMA); assert.equal(e.payload.mode, "inspect");
    assert.deepEqual(e.payload.bindings, { planHash: null, requests: null, nodeVersion: true, approvalRef: null });
    assert.deepEqual(e.payload.source, { sourceDigest: DIGEST, matches: null });
    assert.deepEqual([e.payload.credential, e.payload.summary, e.payload.finalize, e.payload.requestsAttempted], [null, null, null, null]);
    assert.equal(e.payload.plan.planHash, planHashOf(w.pi)); assert.equal(e.payload.plan.maxRequests, 7);
    zeroSecretSide(w); assert.equal(w.of.log.length, 0); assert.deepEqual(w.planReads, [PLAN_PATH]); assertClean(d);
  }
  // optional expect flags compared and reported
  const w = world();
  const d = await runI(w, ["--plan", PLAN_PATH, "--expect-plan-hash", "0".repeat(64), "--expect-source-digest", DIGEST, "--expect-requests", "7", "--approval-ref", "other"]);
  assert.equal(d.exitCode, 10); const b = parseLine(d).payload;
  assert.deepEqual(b.bindings, { planHash: false, requests: true, nodeVersion: true, approvalRef: false }); assert.equal(b.source.matches, true);
  // env refusals are REPORTED in inspect, not refused
  const we = world({ env: envSnap({ execArgvCount: 1 }) }); const de = await runI(we); assert.equal(de.exitCode, 10); assert.equal(parseLine(de).payload.preflight.code, "ENV_EXEC_FLAGS");
  // secret flags refused in inspect; execute-only deps refused in inspect
  for (const argv of [["--plan", PLAN_PATH, "--credentials", CRED_PATH], ["inspect", "--plan", PLAN_PATH, "--summary-out", OUT]]) {
    const wx = world(); const dx = await runI(wx, argv); assert.equal(dx.exitCode, 2); assert.equal(wx.planReads.length, 0);
  }
  const wd = world(); const dd = await C.runProbeCommand({ argv: ["--plan", PLAN_PATH], deps: wd.deps });
  assert.equal(dd.primaryOutcome, "CLI_DEPS_INVALID"); assert.equal(dd.exitCode, 1); zeroSecretSide(wd); assert.equal(wd.planReads.length, 0);
});

// ===== 2. usage / deps =================================================================================================================
test("C2-2 usage and deps matrices: fixed codes, zero injected calls, no caller getter / iterator", async () => {
  const w = world(); const a = w.execArgv;
  const drop = (f) => { const i = a.indexOf(f); return [...a.slice(0, i), ...a.slice(i + 2)]; };
  const usage = [["bogus"], ["execute"], ["inspect"], drop("--summary-out"), drop("--approval-ref"), [...a, "--plan", PLAN_PATH], ["--plan=/x"], ["--plan", "rel/p.json"], ["--plan", PLAN_PATH, "extra"],
    a.map((x) => (x === "7" ? "9" : x)), a.map((x) => (x === "7" ? "07" : x)), a.map((x) => (x === DIGEST ? DIGEST.toUpperCase() : x)), ["--plan", "--plan"], ["--plan", PLAN_PATH, "--approval-ref", "--x"],
    a.map((x) => (x === OUT ? CRED_PATH : x)), ["--plan", "/"], new Array(33).fill("x")];
  for (const [i, argv] of usage.entries()) { const wx = world(); const d = await runE(wx, argv); assert.equal(d.primaryOutcome, "CLI_USAGE", `usage ${i}`); assert.equal(d.exitCode, 2); zeroSecretSide(wx); assert.equal(wx.planReads.length, 0); assertClean(d); }
  let ran = 0;
  const hostileArgv = []; Object.defineProperty(hostileArgv, "0", { get() { ran++; return "--plan"; }, enumerable: true });
  const iterArgv = ["--plan", PLAN_PATH]; iterArgv[Symbol.iterator] = function* () { ran++; yield "x"; };
  for (const argv of [hostileArgv, new Proxy(["--plan", PLAN_PATH], {}), revoked(), "--plan", [1, 2], ["--plan", "/a\0b"]]) {
    const wx = world(); const d = await C.runProbeCommand({ argv, deps: wx.inspectDeps }); assert.equal(d.exitCode, 2); assert.equal(wx.planReads.length, 0);
  }
  { const wx = world(); const d = await C.runProbeCommand({ argv: iterArgv, deps: wx.inspectDeps }); assert.equal(d.exitCode, 2); }   // extra own symbol key → not a plain argv snapshot
  assert.equal(ran, 0);
  const mk = (edit) => { const wx = world(); const deps = edit({ ...wx.deps }, wx); return { wx, deps }; };
  const bad = [(d) => ({ ...d, extra: 1 }), (d) => { delete d.timers; return d; }, (d) => ({ ...d, envSnapshot: { ...envSnap() } }),
    (d) => ({ ...d, envSnapshot: Object.freeze({ ...envSnap(), present: { ...present() } }) }), (d) => ({ ...d, envSnapshot: new Proxy(envSnap(), {}) }), (d) => ({ ...d, interrupt: { aborted: false } }),
    (d) => ({ ...d, interrupt: new AbortController() }), (d) => ({ ...d, sourceDigest: "x" }), (d) => ({ ...d, repoRoot: "rel" }), (d) => ({ ...d, readPlanFile: new Proxy(() => {}, {}) }),
    (d) => ({ ...d, primitive: { request: () => {} } }), (d, wx) => ({ ...d, outputFs: { ...wx.of.fs, uid: 0 } }), (d, wx) => ({ ...d, outputFs: { ...wx.of.fs, platform: "darwin" } }),
    (d) => ({ ...d, credentialFs: revoked() }), (d) => ({ ...d, monotonic: 0 }), (d) => new Proxy(d, {})];
  for (const [i, edit] of bad.entries()) { const { wx, deps } = mk(edit); const d = await C.runProbeCommand({ argv: wx.execArgv, deps }); assert.equal(d.primaryOutcome, "CLI_DEPS_INVALID", `deps ${i}`); zeroSecretSide(wx); assert.equal(wx.planReads.length, 0); }
  for (const inp of [null, revoked(), { argv: [] }, { argv: [], deps: {}, x: 1 }]) assert.equal((await C.runProbeCommand(inp)).primaryOutcome, "CLI_DEPS_INVALID");
});

// ===== 3. refusals before any secret ===================================================================================================
test("C2-3 env / source / plan / bindings / output-parent refusals happen BEFORE any credential read or primitive use", async () => {
  const cases = [
    [{ env: envSnap({ nodeVersion: "20.0.0" }) }, null, "CLI_ENV_REFUSED", 3], [{ env: envSnap({ present: Object.freeze({ ...present(), NODE_OPTIONS: true }) }) }, null, "CLI_ENV_REFUSED", 3],
    [{ sourceDigest: null }, null, "CLI_SOURCE_UNREADABLE", 4], [{}, (a) => a.map((x) => (x === DIGEST ? "e".repeat(64) : x)), "CLI_SOURCE_MISMATCH", 4],
    [{ readPlanFile: () => Promise.reject(new Error(PLAN_PATH)) }, null, "CLI_PLAN_UNREADABLE", 4], [{ readPlanFile: () => ({ then() {} }) }, null, "CLI_PLAN_UNREADABLE", 4],
    [{ readPlanFile: () => { throw new Error(); } }, null, "CLI_PLAN_UNREADABLE", 4], [{ readPlanFile: () => Promise.resolve(Buffer.from("{}")) }, null, "CLI_PLAN_UNREADABLE", 4],
    [{ readPlanFile: () => Promise.resolve(new Uint8Array(16385)) }, null, "CLI_PLAN_UNREADABLE", 4], [{ readPlanFile: () => Promise.resolve(new Uint8Array(new SharedArrayBuffer(4))) }, null, "CLI_PLAN_UNREADABLE", 4],
    [{ planBytes: new Uint8Array(0) }, null, "CLI_PLAN_UNREADABLE", 4],
    [{}, (a) => a.map((x) => (x === "synthetic-c2" ? "other-ref" : x)), "CLI_BINDING_MISMATCH", 4], [{}, (a) => a.map((x, i) => (a[i - 1] === "--expect-plan-hash" ? "0".repeat(64) : x)), "CLI_BINDING_MISMATCH", 4],
    [{}, (a) => a.map((x) => (x === "7" ? "6" : x)), "CLI_BINDING_MISMATCH", 4], [{ env: envSnap({ nodeVersion: "24.22.1" }) }, null, "CLI_BINDING_MISMATCH", 4],
    [{ out: { exists: true } }, null, "CLI_OUTPUT_EXISTS", 4], [{ out: { dirStat: { mode: 0o40777 } } }, null, "CLI_OUTPUT_PARENT_INVALID", 4], [{ out: { dirStat: { uid: 0 } } }, null, "CLI_OUTPUT_PARENT_INVALID", 4],
    [{ out: { dirStat: { kind: "symlink" } } }, null, "CLI_OUTPUT_PARENT_INVALID", 4], [{ out: { realpath: (p) => (p === OUT_DIR ? "/private/out" : p) } }, null, "CLI_OUTPUT_PARENT_INVALID", 4],
    [{ out: { realpath: (p) => (p === REPO ? "/home" : p) } }, null, "CLI_OUTPUT_PARENT_INVALID", 4], [{ out: { lstat: (p) => (p === "/home/.git" ? Promise.resolve(stat({ kind: "dir" })) : undefined) } }, null, "CLI_OUTPUT_PARENT_INVALID", 4],
    [{ out: { lstat: (p) => (p === "/.git" ? Promise.reject(Object.assign(new Error(), { code: "EACCES" })) : undefined) } }, null, "CLI_OUTPUT_PARENT_INVALID", 4],
    [{ out: { lstat: (p) => (p === OUT ? Promise.reject(Object.assign(new Error(), { code: "EACCES" })) : undefined) } }, null, "CLI_OUTPUT_PARENT_INVALID", 4],
    [{ out: { lstat: (p) => (p === OUT_DIR ? Promise.resolve({ kind: "dir" }) : undefined) } }, null, "CLI_OUTPUT_PARENT_INVALID", 4]
  ];
  for (const [i, [o, argvEdit, code, exit]] of cases.entries()) {
    const w = world(o); const d = await runE(w, argvEdit ? argvEdit(w.execArgv) : w.execArgv);
    assert.equal(d.primaryOutcome, code, `case ${i}`); assert.equal(d.exitCode, exit); zeroSecretSide(w); assert.equal(d.summaryFile, "NOT_ATTEMPTED");
    assert.equal(w.of.log.filter((l) => l.startsWith("create")).length, 0); assertClean(d);
  }
  // pre-run fallback payload: every unreached stage is exactly null
  const w = world({ env: envSnap({ nodeVersion: "20.0.0" }) }); const p = parseLine(await runE(w)).payload;
  assert.deepEqual([p.source, p.plan, p.bindings, p.credential, p.summary, p.finalize, p.planCode, p.internalCode, p.requestsAttempted], [null, null, null, null, null, null, null, null, null]);
  assert.equal(p.preflight.code, "ENV_NODE_UNSUPPORTED"); assert.equal(p.runExitCode, 3);
});

test("C2-3b plan file: canonical-only (duplicate keys, whitespace, BOM, deep / non-JSON refused code-only); hash binds the SAME validated content", async () => {
  const pi = planInput(); const c = P.canonicalJson(pi);
  const dup = c.replace("\"version\":\"e7-probe-plan-v1\"", "\"version\":\"e7-probe-plan-v1\",\"version\":\"e7-probe-plan-v1\"");
  const variants = [[enc(c), null], [enc(`${c}\n`), null], [enc(`${c}\n\n`), "PLAN_NOT_CANONICAL"], [enc(JSON.stringify(pi)), "PLAN_NOT_CANONICAL"], [enc(` ${c}`), "PLAN_NOT_CANONICAL"],
    [enc(dup), "PLAN_NOT_CANONICAL"], [enc(`﻿${c}`), "PLAN_NOT_JSON"], [new Uint8Array([0x7b, 0xff]), "PLAN_NOT_JSON"], [enc("{"), "PLAN_NOT_JSON"],
    [enc(`${"[".repeat(5000)}${"]".repeat(5000)}`), "PLAN_TOO_DEEP"], [enc(P.canonicalJson({ ...pi, limits: { a: { b: { c: { d: { e: { f: { g: {} } } } } } } } })), "PLAN_TOO_DEEP"],
    [enc(P.canonicalJson({ ...pi, version: "v0" })), "PLAN_SHAPE"], [enc(P.canonicalJson({ ...pi, hostaway: { ...pi.hostaway, sample: { reservationId: "70636076", listingId: L1 } } })), "PLAN_PROTECTED"]];
  for (const [i, [bytes, code]] of variants.entries()) {
    const w = world({ planBytes: bytes }); const d = await runI(w); const e = parseLine(d);
    if (code === null) { assert.equal(d.exitCode, 10, `v ${i}`); assert.equal(e.payload.plan.planHash, planHashOf(pi)); continue; }
    assert.equal(d.primaryOutcome, "CLI_PLAN_INVALID", `v ${i}`); assert.equal(e.payload.planCode, code, `v ${i}`); assert.equal(d.exitCode, 4); assert.equal(e.payload.plan, null); assertClean(d);
  }
});

// ===== 4. full C1 → X → T → P chain =====================================================================================================
test("C2-4 execute over a FAKE primitive: both providers and single-provider plans; one file, identical payload in file and stdout envelope", async () => {
  for (const [label, po, n, needH, needS] of [["both", {}, 7, true, true], ["hostaway-only", H_ONLY, 1, true, false], ["stripe-only", S_ONLY, 1, false, true]]) {
    const body = { ...(needH ? { hostawayToken: HTOKEN } : {}), ...(needS ? { stripeTestKey: SKEY } : {}) };
    const w = world({ plan: po, cred: { body } }); const d = await runE(w);
    assert.equal(d.primaryOutcome, "CLI_COMPLETED_OK", label); assert.equal(d.exitCode, 0); assert.equal(d.summaryFile, "CLOSED_ACK"); assert.equal(d.summaryCloseState, "CLOSED");
    assert.equal(w.fx.reqs, n); assert.equal(w.fx.agents, n);
    assert.equal(w.fx.auth.filter((x) => x === `Bearer ${HTOKEN}`).length, needH ? n - (needS ? 2 : 0) : 0);           // the private capability reached T only
    const e = parseLine(d); const fileText = dec(w.of.written());
    assert.equal(fileText, `${P.canonicalJson(e.payload)}\n`);                                                      // same payload bytes in both places
    assert.equal(e.payload.requestsAttempted, n); assert.deepEqual(e.payload.credential, { code: "CRED_OK", closeState: "CLOSED" });
    assert.deepEqual(e.output, { summaryFile: "CLOSED_ACK", summaryCloseState: "CLOSED" }); assert.equal(e.exitCode, 0);
    assert.ok(!fileText.includes("summaryFile"), "the file never describes its own later status");
    assert.equal(e.payload.summary.outcome, "COMPLETED"); assert.equal(e.payload.finalize.tail, "NONE");
    assert.deepEqual(w.of.log.filter((l) => !l.startsWith("lstat") && l !== "realpath" && l !== "write"), [`create ${C.OUTPUT_CREATE_KIND}`, "sync", "close"]);
    assert.equal(w.cf.log.filter((l) => l === "close").length, 1); assertClean(d, w);
    assert.ok(Buffer.byteLength(fileText) <= C.MAX_PAYLOAD_BYTES);
  }
  // C1 refusal → 5, zero primitive use, no file
  const w = world({ cred: { body: { hostawayToken: HTOKEN, stripeTestKey: "sk_live_Fake1" } } }); const d = await runE(w);
  assert.equal(d.primaryOutcome, "CLI_CREDENTIAL_REFUSED"); assert.equal(d.exitCode, 5); assert.equal(w.fx.reqs + w.fx.agents, 0);
  assert.deepEqual(parseLine(d).payload.credential, { code: "CRED_KEY_NOT_TEST", closeState: "CLOSED" }); assert.equal(d.summaryFile, "NOT_ATTEMPTED"); assertClean(d, w);
});

// ===== 5. accepted P semantics ===========================================================================================================
test("C2-5 P semantics unchanged: STOP → CLI_PROBE_STOPPED / 6; INCONCLUSIVE continues independent probes → CLI_COMPLETED_INCONCLUSIVE / 11", async () => {
  const stopRoute = (o) => (o.path === `/v1/listings/${L}` ? { status: 401, json: { status: "fail" } } : defaultRoute(o));
  const ws = world({ route: stopRoute }); const ds = await runE(ws);
  assert.equal(ds.primaryOutcome, "CLI_PROBE_STOPPED"); assert.equal(ds.exitCode, 6); assert.equal(ds.summaryFile, "CLOSED_ACK");
  const ps = parseLine(ds).payload.summary; assert.equal(ps.outcome, "STOPPED"); assert.ok(ps.probes.slice(1).every((p) => p.code === "AFTER_STOP")); assert.equal(ws.fx.reqs, 1);
  const incRoute = (o) => (o.path.includes("/calendar") ? { status: 200, json: calendar(["2026-12-01", "2026-12-02"]) } : defaultRoute(o));
  const wi = world({ route: incRoute }); const di = await runE(wi);
  assert.equal(di.primaryOutcome, "CLI_COMPLETED_INCONCLUSIVE"); assert.equal(di.exitCode, 11);
  const pi = parseLine(di).payload.summary; assert.equal(pi.outcome, "COMPLETED"); assert.equal(pi.probes[1].outcome, "INCONCLUSIVE"); assert.equal(wi.fx.reqs, 7);
});

// ===== 6. interrupts ======================================================================================================================
test("C2-6 interrupt: pre-run aborts at every handoff stop before network (capability discarded, C1 handle closed); a started run is reported, never replaced", async () => {
  // already aborted → 7 before env
  { const w = world(); w.ac.abort(); const d = await runE(w); assert.equal(d.primaryOutcome, "CLI_INTERRUPTED"); assert.equal(d.exitCode, 7); assert.equal(w.planReads.length, 0); zeroSecretSide(w); }
  // during the plan read (re-entrant: aborted inside the injected call)
  { const w = world(); w.deps.readPlanFile = () => { w.ac.abort(); return Promise.resolve(planBytes(w.pi)); }; const d = await runE(w); assert.equal(d.exitCode, 7); zeroSecretSide(w); assert.equal(w.of.log.length, 0); }
  // during the output-parent preflight
  { const w = world({ out: { lstat: (p) => { if (p === "/.git") w2.ac.abort(); return undefined; } } }); var w2 = w; const d = await runE(w); assert.equal(d.exitCode, 7); zeroSecretSide(w); }
  // during the C1 load (abort inside the credential open): C1 still closes its handle; capability discarded; zero primitive use
  { const w = world({ cred: { onOpen: () => w3.ac.abort() } }); var w3 = w; const d = await runE(w);
    assert.equal(d.primaryOutcome, "CLI_INTERRUPTED"); assert.equal(d.exitCode, 7); assert.equal(w.fx.reqs + w.fx.agents, 0);
    assert.equal(w.cf.log.filter((l) => l === "close").length, 1); assert.deepEqual(parseLine(d).payload.credential, { code: "CRED_OK", closeState: "CLOSED" }); assert.equal(d.summaryFile, "NOT_ATTEMPTED"); assertClean(d); }
  // once P is invoked: an abort during the first request is P's signal; result + finalize observed; evidence written; never a pre-run refusal
  { const w = world(); w.fx.onRequest = () => w.ac.abort(); const d = await runE(w);
    assert.notEqual(d.primaryOutcome, "CLI_INTERRUPTED"); assert.equal(d.summaryFile, "CLOSED_ACK");
    const p = parseLine(d).payload; assert.equal(p.interruptObserved, true); assert.ok(p.summary.probes.some((x) => x.code === "PROBE_CANCELLED"));
    assert.equal(d.primaryOutcome, p.summary.outcome === "STOPPED" ? "CLI_PROBE_STOPPED" : "CLI_COMPLETED_INCONCLUSIVE"); assert.equal(w.fx.reqs, 1); assertClean(d, w); }
});

// ===== 7. output faults ====================================================================================================================
test("C2-7 output: EEXIST race vs UNKNOWN; partial / zero writes, sync and close acknowledgment exactly undefined; one create, one close, no retry", async () => {
  const cases = [
    [{ create: () => Promise.reject(Object.assign(new Error(), { code: "EEXIST" })) }, "RACE_EXISTS", "NOT_OPENED", 0],
    [{ create: () => Promise.reject(Object.assign(new Error(), { code: "EIO" })) }, "UNKNOWN", "NOT_OPENED", 0],
    [{ create: () => ({ then() {} }) }, "UNKNOWN", "NOT_OPENED", 0],
    [{ write: (b, off, len, acc) => { if (off === 0) { acc.push(...b.subarray(0, 10)); return Promise.resolve(10); } return Promise.reject(new Error(OUT)); } }, "UNKNOWN", "CLOSED", 1],
    [{ write: () => Promise.resolve(0) }, "UNKNOWN", "CLOSED", 1], [{ write: (b, off, len) => Promise.resolve(len + 1) }, "UNKNOWN", "CLOSED", 1],
    [{ write: () => Promise.resolve(1.5) }, "UNKNOWN", "CLOSED", 1], [{ sync: () => Promise.resolve(1) }, "UNKNOWN", "CLOSED", 1], [{ sync: () => Promise.reject(new Error()) }, "UNKNOWN", "CLOSED", 1],
    [{ close: () => Promise.resolve(false) }, "UNKNOWN", "CLOSE_FAILED", 1], [{ close: () => Promise.reject(new Error()) }, "UNKNOWN", "CLOSE_FAILED", 1],
    [{ handle: (h) => ({ ...h, fd: 3 }) }, "UNKNOWN", "CLOSED", 1], [{ handle: (h) => ({ write: h.write, sync: h.sync }) }, "UNKNOWN", "UNCLOSABLE", 0],
    [{ handle: (h) => new Proxy(h, {}) }, "UNKNOWN", "UNCLOSABLE", 0]
  ];
  for (const [i, [o, file, cs, closes]] of cases.entries()) {
    const w = world({ out: o }); const d = await runE(w);
    assert.equal(d.summaryFile, file, `case ${i}`); assert.equal(d.summaryCloseState, cs, `case ${i}`); assert.equal(d.exitCode, 9);
    assert.equal(d.primaryOutcome, "CLI_COMPLETED_OK"); assert.equal(w.of.log.filter((l) => l.startsWith("create")).length, 1);
    assert.equal(w.of.log.filter((l) => l === "close").length, closes);
    const e = parseLine(d); assert.equal(e.output.summaryFile, file); assert.equal(e.payload.runExitCode, 0); assert.equal(e.exitCode, 9); assertClean(d, w);
  }
});

// ===== 8. tail / precedence ===================================================================================================================
test("C2-8 tail uncertainty and exit precedence: 8, 9 + 8 → 9, 6 + 8 → 8, 11 + 9 → 9; primaryOutcome and tailUncertain preserved", async () => {
  // Tail uncertainty through P's accepted cleanup report: a timer handle without a callable cancel is counted `uncancellable` (P R-PC2).
  // (An UNSETTLED transport tail is NOT reachable through accepted X here: X settles promptly when P aborts it, so P observes LATE_*;
  //  it is not manufactured — P's own suite covers UNSETTLED / UNOBSERVABLE.)
  const badTimers = { monotonic: () => 0, arm: () => ({ promise: new Promise(() => {}), cancel: 5 }) };
  const one = { ...H_ONLY, limits: { perProbeMs: 1000, runMs: 1000, tailMs: 0 } };
  const w8 = world({ plan: one, time: badTimers, cred: { body: { hostawayToken: HTOKEN } } }); const d8 = await runE(w8); const p8 = parseLine(d8).payload;
  assert.equal(d8.exitCode, 8); assert.equal(d8.tailUncertain, true); assert.equal(d8.summaryFile, "CLOSED_ACK"); assert.ok(p8.finalize.timerCleanup.uncancellable > 0);
  assert.equal(d8.primaryOutcome, "CLI_PROBE_STOPPED"); assert.equal(p8.runExitCode, 8);                                    // 6 + 8 → 8, primary kept
  const w98 = world({ plan: one, time: badTimers, cred: { body: { hostawayToken: HTOKEN } }, out: { create: () => Promise.reject(Object.assign(new Error(), { code: "EEXIST" })) } });
  const d98 = await runE(w98); assert.equal(d98.exitCode, 9); assert.equal(d98.tailUncertain, true); assert.equal(parseLine(d98).payload.runExitCode, 8);
  assert.equal(parseLine(d98).tailUncertain, true); assert.equal(d98.primaryOutcome, "CLI_PROBE_STOPPED");
  const incRoute = (o) => (o.path.includes("/calendar") ? { status: 200, json: calendar(["2026-12-01"]) } : defaultRoute(o));
  const w119 = world({ route: incRoute, out: { sync: () => Promise.resolve(null) } }); const d119 = await runE(w119);
  assert.equal(d119.exitCode, 9); assert.equal(d119.primaryOutcome, "CLI_COMPLETED_INCONCLUSIVE"); assert.equal(parseLine(d119).payload.runExitCode, 11);
  // exitFor table (the single precedence function)
  const f = (primaryOutcome, ran, tailUncertain, summaryFile) => C.exitFor({ primaryOutcome, ran, tailUncertain, summaryFile });
  assert.deepEqual([f("CLI_COMPLETED_OK", true, false, "CLOSED_ACK"), f("CLI_COMPLETED_INCONCLUSIVE", true, false, "CLOSED_ACK"), f("CLI_PROBE_STOPPED", true, false, "CLOSED_ACK"),
    f("CLI_PROBE_STOPPED", true, true, "CLOSED_ACK"), f("CLI_COMPLETED_OK", true, true, "UNKNOWN"), f("CLI_COMPLETED_INCONCLUSIVE", true, false, "RACE_EXISTS"),
    f("CLI_COMPLETED_OK", true, true, null), f("CLI_PROBE_STOPPED", true, false, null)], [0, 11, 6, 8, 9, 9, 8, 6]);
  assert.deepEqual(["CLI_USAGE", "CLI_DEPS_INVALID", "CLI_ENV_REFUSED", "CLI_SOURCE_MISMATCH", "CLI_PLAN_INVALID", "CLI_OUTPUT_EXISTS", "CLI_CREDENTIAL_REFUSED", "CLI_INTERRUPTED", "CLI_INSPECT_OK", "CLI_INTERNAL"]
    .map((c) => f(c, false, false, null)), [2, 1, 3, 4, 4, 4, 5, 7, 10, 1]);
});

// ===== 9. source digest helper =================================================================================================================
const snap = (over = {}) => D.SOURCE_CLOSURE.map((path, i) => ({ path, bytes: over[path] ?? enc(`synthetic-${i}:${path}`) }));
const expected = (s) => { const h = createHash("sha256"); h.update(D.SOURCE_DIGEST_PREFIX); for (const { path, bytes } of s) { h.update(path); h.update(Buffer.from([0])); h.update(String(bytes.length)); h.update(Buffer.from([0])); h.update(bytes); h.update(Buffer.from([0])); } return h.digest("hex"); };
test("C2-9 source digest helper: exact framing vector, protected-constant / package.json byte changes, closure order / shape / bounds; synthetic entrypoint placeholder", () => {
  assert.equal(D.SOURCE_CLOSURE.length, 13); assert.equal(D.SOURCE_CLOSURE[1], "scripts/e7-connected/probe-cli-main.mjs");     // FUTURE entrypoint: synthetic bytes only; no enforcement today
  const base = snap(); const r = D.computeSourceDigest(base); assert.equal(r.ok, true); assert.equal(r.digest, expected(base)); assert.match(r.digest, /^[0-9a-f]{64}$/);
  for (const p of ["lib/checkout/compensation-proof.js", "package.json", "scripts/e7-connected/probe-cli-main.mjs"]) {
    const b = enc(`synthetic:${p}`); const c = new Uint8Array(b); c[0] ^= 1;
    assert.notEqual(D.computeSourceDigest(snap({ [p]: b })).digest, D.computeSourceDigest(snap({ [p]: c })).digest, p);
  }
  // framing: moving a byte between adjacent entries changes the digest (no concatenation ambiguity)
  const a1 = snap({ "package.json": enc("ab"), "scripts/e7-connected/probe-cli-main.mjs": enc("c") }); const a2 = snap({ "package.json": enc("a"), "scripts/e7-connected/probe-cli-main.mjs": enc("bc") });
  assert.notEqual(D.computeSourceDigest(a1).digest, D.computeSourceDigest(a2).digest);
  const bad = (s) => assert.deepEqual({ ...D.computeSourceDigest(s) }, { ok: false, code: "SOURCE_SNAPSHOT_INVALID" });
  bad([base[1], base[0], ...base.slice(2)]); bad(base.slice(1)); bad([...base, base[0]]); bad(snap({ "package.json": new Uint8Array(D.MAX_SOURCE_FILE_BYTES + 1) }));
  bad(snap({ "package.json": new Uint8Array(0) })); bad(snap({ "package.json": Buffer.from("x") })); bad(snap({ "package.json": new Uint8Array(new SharedArrayBuffer(2)) }));
  bad(snap({ "package.json": new Proxy(enc("x"), {}) })); bad(base.map((e, i) => (i === 3 ? { ...e, extra: 1 } : e))); bad(new Proxy(base, {})); bad(null);
  const big = new Uint8Array(D.MAX_SOURCE_FILE_BYTES); bad(snap(Object.fromEntries(D.SOURCE_CLOSURE.slice(0, 9).map((p) => [p, big]))));    // > 2 MiB total
  let ran = 0; const acc = snap(); Object.defineProperty(acc[0], "bytes", { get() { ran++; return enc("x"); }, enumerable: true }); bad(acc); assert.equal(ran, 0);
  // the bytes are copied once: mutating the caller array afterwards cannot change an already computed digest; same input → same digest
  const m = snap(); const d1 = D.computeSourceDigest(m).digest; m[4].bytes[0] ^= 1; assert.notEqual(D.computeSourceDigest(m).digest, d1); m[4].bytes[0] ^= 1; assert.equal(D.computeSourceDigest(m).digest, d1);
});

// ===== 10. redaction / pins ===================================================================================================================
test("C2-10 containment pins: exact imports (§11.1); no process / fs / timers / console / https / default primitive / booking-core text", () => {
  const read = (f) => readFileSync(join(ROOT, f), "utf8");
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const cmd = read("scripts/e7-connected/probe-command.mjs");
  assert.deepEqual(cmd.match(/^import .*$/gm), ["import { types } from \"node:util\";",
    "import { validateProbePlan, canonicalJson, runReadonlyProbes, VOCABULARY, T_ERROR_CODES, CODES } from \"./readonly-probe.mjs\";",
    "import { createE7HostawaySend, createE7StripeTestSend } from \"./http-transports.mjs\";", "import { createE7RealExchange } from \"./real-exchange.mjs\";",
    "import { evaluateProbeEnvironment, ENV_CODES, ENV_CHECK_KEYS } from \"./probe-env-preflight.mjs\";",
    "import { readProbeCredentialFile, CREDENTIAL_CODES, CLOSE_STATES } from \"./probe-credential-file.mjs\";"]);
  const dig = read("scripts/e7-connected/probe-source-digest.mjs");
  assert.deepEqual(dig.match(/^import .*$/gm), ["import { createHash } from \"node:crypto\";", "import { types } from \"node:util\";"]);
  for (const [f, src] of [["cmd", cmd], ["dig", dig]]) {
    const code = strip(src);
    for (const re of [/\bprocess\b/, /\brequire\s*\(/, /\bimport\s*\(/, /node:fs/, /node:https?\b/, /node:net|node:tls|node:dns/, /\bfetch\b/, /setTimeout|setInterval|setImmediate|queueMicrotask/,
      /\bconsole\b/, /NODE_HTTPS_PRIMITIVE/, /\bDate\b/, /\beval\b|\bFunction\s*\(/, /https?:\/\//, /\bexport\s+default\b/]) assert.doesNotMatch(code, re, `${f} ${re}`);
    assert.ok(!src.includes("hostaway-" + "reservations"), f);
    // the helper legitimately NAMES the closure paths (incl. lib/checkout/*) as data; the command module names no lib/ path at all
    for (const dep of ["booking-db", ...(f === "cmd" ? ["lib/"] : []), "run-core", "run-journal", "run-guard", "executor-adapters", "worker", "stripe-node", "@supabase"]) assert.ok(!src.includes(dep), `${f} ${dep}`);
  }
});
