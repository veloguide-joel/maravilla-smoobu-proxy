// test/e7-connected-probe-cli-main.test.mjs — E7 probe CLI stage C3 (OFFLINE). Contract §13 / §14.
// LABELS
//   * REAL (accepted, unchanged): C1, C2 (command + digest helper), P, T, X; NEW C3 entrypoint under test.
//   * NATIVE fs ONLY over DISPOSABLE SYNTHETIC files in fresh 0700 mkdtemp dirs (removed after); public repo source is read for the digest.
//   * FAKE: a process shim (argv / versions / env / stdout / signals / exit), the https primitive (a labelled COPY of the accepted rehearsal
//     doubles), replies. node:https request / Agent are replaced by counting GUARDS before the entrypoint (and X) load; guards + fetch = 0.
//   * SYNTHETIC: `tokFake1` / `sk_test_Fake1` / ids. No owner credential, env, account, provider, TLS, loopback, install or real execute.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, statSync, realpathSync, existsSync, constants as FSC } from "node:fs";
import { lstat as pLstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const GUARD = { request: 0, Agent: 0 };
const realRequest = https.request; const RealAgent = https.Agent;
https.request = function guardRequest() { GUARD.request += 1; throw new Error("real https.request refused (offline)"); };
https.Agent = function GuardAgent() { GUARD.Agent += 1; throw new Error("real https.Agent refused (offline)"); };
syncBuiltinESMExports();
const sigBefore = process.listenerCount("SIGINT");
const M = await import("../scripts/e7-connected/probe-cli-main.mjs");
const sigAfterImport = process.listenerCount("SIGINT");
const C2 = await import("../scripts/e7-connected/probe-command.mjs");
https.request = realRequest; https.Agent = RealAgent; syncBuiltinESMExports();
const D = await import("../scripts/e7-connected/probe-source-digest.mjs");
const P = await import("../scripts/e7-connected/readonly-probe.mjs");
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let netAttempts = 0; const realFetch = globalThis.fetch;
globalThis.fetch = async () => { netAttempts += 1; throw new Error("network refused (offline)"); };
let unhandled = 0; const onU = () => { unhandled += 1; }; process.on("unhandledRejection", onU);
const TMP = []; const tmp = () => { const d = realpathSync(mkdtempSync(join(tmpdir(), "e7c3-"))); chmodSync(d, 0o700); TMP.push(d); return d; };
after(() => {
  for (const d of TMP) rmSync(d, { recursive: true, force: true });
  globalThis.fetch = realFetch; process.off("unhandledRejection", onU);
  assert.deepEqual([netAttempts, unhandled], [0, 0], "no fetch / unhandled rejection");
});
const tick = () => new Promise((r) => setImmediate(r));
const flush = async (n = 20) => { for (let i = 0; i < n; i++) await tick(); };

// ---- SYNTHETIC values / plan ------------------------------------------------------------------------------------------------------
const HTOKEN = "tokFake1"; const SKEY = "sk_test_Fake1"; const VERSION = "2026-08-26.dahlia";
const L = 871001; const ACCT = "acct_1SyntheticProbe";
const planInput = (o = {}) => ({ version: "e7-probe-plan-v1",
  metadata: { reviewedCommit: "27c0ea1152db904f9fdeb285d0682a28cb89ac17", nodeVersion: "22.22.0", stripeVersion: VERSION, approvalRef: "synthetic-c3" },
  hostaway: { listingId: L, calendar: null, lookup: null, sample: null, control: null }, stripe: { accountId: ACCT, paymentIntentId: null }, probes: ["P-H1", "P-S1"],
  limits: { perProbeMs: 15000, runMs: 180000, tailMs: 0 }, ...o });
const canonicalFile = (pi) => `${P.canonicalJson(pi)}\n`;
const planHashOf = (pi) => P.validateProbePlan(pi).plan.planHash;
/** independent digest of the real repo closure (source text read only) */
const repoDigest = () => D.computeSourceDigest(D.SOURCE_CLOSURE.map((p) => ({ path: p, bytes: new Uint8Array(readFileSync(join(ROOT, p))) }))).digest;

// ---- FAKE https primitive (labelled COPY of the accepted rehearsal doubles) -----------------------------------------------------------
class FakeRes extends EventEmitter {
  constructor(req, statusCode) { super(); this.req = req; this.statusCode = statusCode; this.rawHeaders = ["Content-Type", "application/json"]; this.complete = false; this.closed = false; }
  destroy() { if (this._d) return; this._d = true; process.nextTick(() => { if (!this.closed) { this.closed = true; this.emit("close"); } this.req._closeOnce(); }); }
}
class FakeReq extends EventEmitter {
  constructor(fx, options) { super(); this.fx = fx; this.options = options; this.res = null; this.closed = false; }
  end() { this.fx.onEnd(this); }
  _closeOnce() { if (!this.closed) { this.closed = true; this.emit("close"); } }
  destroy() { if (this._d) return; this._d = true; process.nextTick(() => { if (this.res === null) { this.emit("error", Object.assign(new Error("x"), { code: "ECONNRESET" })); } this._closeOnce(); }); }
}
const account = { object: "account", id: ACCT };
const listing = { status: "success", result: { id: L, currencyCode: "USD" } };
function fakePrimitive(o = {}) {
  const fx = { reqs: 0, agents: 0, auth: [] };
  class FakeAgent { constructor() { fx.agents += 1; } destroy() {} }
  fx.Agent = FakeAgent;
  fx.request = (options) => { fx.reqs += 1; if (o.onRequest) o.onRequest(); return new FakeReq(fx, options); };
  fx.onEnd = (req) => setImmediate(() => {
    fx.auth.push(req.options.headers.Authorization);
    const json = req.options.hostname === "api.stripe.com" ? account : listing;
    const body = Buffer.from(JSON.stringify(json)); const res = new FakeRes(req, 200); req.res = res; req.emit("response", res);
    res.emit("data", body); res.complete = true; res.emit("end"); req._closeOnce(); if (!res.closed) { res.closed = true; res.emit("close"); }
  });
  return fx;
}

// ---- FAKE process shim ------------------------------------------------------------------------------------------------------------
function fakeStdout(mode = "ok") {
  const s = new EventEmitter(); s.writes = [];
  s.write = (chunk, cb) => {
    s.writes.push(chunk);
    if (mode === "throw") throw new Error("stdout");
    if (mode === "ok") setImmediate(() => cb());
    if (mode === "backpressure") { setImmediate(() => cb()); return false; }
    if (mode === "cbError") setImmediate(() => cb(new Error("EPIPE")));
    if (mode === "event") setImmediate(() => s.emit("error", new Error("EPIPE")));
    if (mode === "race") setImmediate(() => { cb(new Error("EPIPE")); s.emit("error", new Error("EPIPE")); cb(); });
    return true;                                                      // mode "never": no acknowledgment at all
  };
  return s;
}
function fakeProc(args, o = {}) {
  const p = { argv: ["node", "/fake/probe-cli-main.mjs", ...args], platform: o.platform ?? "linux", versions: { node: "22.22.0" }, execArgv: o.execArgv ?? [],
    env: o.env ?? {}, getuid: o.noUid ? undefined : () => process.getuid(), fsConstants: o.constants ?? FSC, stdout: fakeStdout(o.stdout),
    exits: [], codes: [], sig: null };
  p.onSigint = (fn) => { p.sig = fn; }; p.exit = (c) => { p.exits.push(c); }; p.setExitCode = (c) => { p.codes.push(c); };
  return p;
}
function hooks(o = {}) {
  const h = { imports: 0, planImports: 0 };
  const base = M.defaultHooks();
  h.value = { primitive: o.primitive ?? base.primitive, readSource: o.readSource ?? null, repoRoot: base.repoRoot,
    importCommand: o.importCommand ?? (() => { h.imports += 1; return base.importCommand(); }), importPlanModule: () => { h.planImports += 1; return base.importPlanModule(); } };
  return h;
}
const lineOf = (p) => { assert.equal(p.stdout.writes.length, 1, "exactly one stdout write"); return JSON.parse(p.stdout.writes[0]); };
/** a synthetic world: plan / creds / out dir in fresh 0700 temp dirs */
function files(o = {}) {
  const base = tmp(); const pi = planInput(o.plan);
  const planPath = join(base, "plan.json"); writeFileSync(planPath, o.planText ?? canonicalFile(pi), { mode: 0o600 });
  const credDir = join(base, "cred"); mkdirSync(credDir, { mode: 0o700 }); const credPath = join(credDir, "c.json");
  writeFileSync(credPath, JSON.stringify(o.creds ?? { hostawayToken: HTOKEN, stripeTestKey: SKEY }), { mode: 0o600 }); chmodSync(credPath, 0o600);
  const outDir = join(base, "out"); mkdirSync(outDir, { mode: 0o700 }); chmodSync(outDir, 0o700);
  const out = join(outDir, "summary.json");
  const exec = (digest = repoDigest()) => ["execute", "--plan", planPath, "--credentials", credPath, "--summary-out", out, "--expect-plan-hash", planHashOf(pi),
    "--expect-source-digest", digest, "--expect-requests", String(pi.probes.length), "--approval-ref", pi.metadata.approvalRef];
  return { base, pi, planPath, credPath, outDir, out, exec };
}

// ===== B1 inert import ===================================================================================================================
test("B1 importing the entrypoint runs nothing: no SIGINT listener, no stdout, main not invoked; exact static imports / fixed dynamic specifiers", () => {
  assert.equal(sigAfterImport, sigBefore);
  const src = readFileSync(join(ROOT, "scripts/e7-connected/probe-cli-main.mjs"), "utf8");
  assert.deepEqual(src.match(/^import .*$/gm), ["import process from \"node:process\";",
    "import { open as fspOpen, lstat as fspLstat, realpath as fspRealpath } from \"node:fs/promises\";", "import { constants as FS_CONSTANTS } from \"node:fs\";",
    "import { fileURLToPath } from \"node:url\";", "import { performance } from \"node:perf_hooks\";", "import { request as httpsRequest, Agent as HttpsAgent } from \"node:https\";",
    "import { SOURCE_CLOSURE, computeSourceDigest, MAX_SOURCE_FILE_BYTES, MAX_SOURCE_TOTAL_BYTES } from \"./probe-source-digest.mjs\";"]);
  assert.deepEqual(src.match(/import\("[^"]*"\)/g), ["import(\"./probe-command.mjs\")", "import(\"./readonly-probe.mjs\")"]);
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  for (const re of [/child_process/, /\bfetch\b/, /\beval\b|\bFunction\s*\(/, /process\.env\[|process\.env\./, /hostaway-reservations/, /booking-db|lib\//, /\brequire\s*\(/])
    assert.doesNotMatch(code, re, String(re));
  assert.equal((code.match(/import\.meta\.main/g) || []).length, 1);
  assert.equal(D.SOURCE_CLOSURE[1], "scripts/e7-connected/probe-cli-main.mjs"); assert.equal(D.SOURCE_CLOSURE.length, 13);
});

// ===== B2 inspect ========================================================================================================================
test("B2 inspect (default grammar): real repo digest reported; zero credential read, output, primitive or native https", async () => {
  const f = files(); const h = hooks(); const p = fakeProc(["--plan", f.planPath]);
  await M.main(p, h.value);
  const e = lineOf(p); assert.equal(e.schema, C2.CLI_STDOUT_SCHEMA); assert.equal(e.exitCode, 10); assert.deepEqual(p.exits, [10]); assert.deepEqual(p.codes, [10]);
  assert.equal(e.payload.source.sourceDigest, repoDigest()); assert.equal(e.payload.plan.planHash, planHashOf(f.pi)); assert.equal(e.payload.preflight.code, "ENV_OK");
  assert.equal(h.imports, 1); assert.equal(GUARD.request + GUARD.Agent, 0); assert.ok(!existsSync(f.out));
  // presence-only env snapshot: values are never read or printed
  const pe = fakeProc(["--plan", f.planPath], { env: { NODE_OPTIONS: "SENTINEL_VALUE", HTTPS_PROXY: "SENTINEL_PROXY" } });
  await M.main(pe, hooks().value); const ee = lineOf(pe);
  assert.equal(ee.payload.preflight.code, "ENV_VARIABLE_REFUSED"); assert.equal(ee.payload.preflight.checks.proxyVariablesPresent, true);
  assert.ok(!pe.stdout.writes[0].includes("SENTINEL"));
});

// ===== B3 prepare-plan ===================================================================================================================
test("B3 prepare-plan: P only; duplicate-key draft canonicalizes last-key-wins (ruling A); 0600 O_EXCL output; refusals; inspect accepts the result", async () => {
  const f = files(); const pi = f.pi;
  const draft = JSON.stringify(pi, null, 2).replace("\"approvalRef\": \"synthetic-c3\"", "\"approvalRef\": \"first-value\", \"approvalRef\": \"synthetic-c3\"");
  assert.ok(draft.includes("first-value"));
  const draftPath = join(f.base, "draft.json"); writeFileSync(draftPath, draft, { mode: 0o600 });
  const outPlan = join(f.outDir, "plan.canonical.json");
  const h = hooks(); const p = fakeProc(["prepare-plan", "--in", draftPath, "--out", outPlan]);
  await M.main(p, h.value);
  const e = lineOf(p); assert.equal(e.code, "PREP_OK"); assert.equal(e.file, "CLOSED_ACK"); assert.deepEqual(p.exits, [0]);
  assert.equal(readFileSync(outPlan, "utf8"), canonicalFile(pi)); assert.equal(e.planHash, planHashOf(pi));      // effective (last) value
  assert.equal(statSync(outPlan).mode & 0o777, 0o600); assert.equal(h.imports, 0); assert.equal(h.planImports, 1);
  // inspect accepts the produced file
  const pi2 = fakeProc(["--plan", outPlan]); await M.main(pi2, hooks().value); assert.equal(lineOf(pi2).exitCode, 10);
  // existing output: no overwrite
  const before = readFileSync(outPlan, "utf8"); const px = fakeProc(["prepare-plan", "--in", draftPath, "--out", outPlan]); await M.main(px, hooks().value);
  assert.equal(lineOf(px).code, "PREP_EXISTS"); assert.deepEqual(px.exits, [9]); assert.equal(readFileSync(outPlan, "utf8"), before);
  // refusals (code-only)
  const w = (name, text) => { const q = join(f.base, name); writeFileSync(q, text, { mode: 0o600 }); return q; };
  const cases = [[w("shape.json", JSON.stringify({ ...pi, version: "v0" })), "PREP_INVALID", "PLAN_SHAPE"], [w("deep.json", `${"[".repeat(3000)}${"]".repeat(3000)}`), "PREP_INVALID", "PLAN_TOO_DEEP"],
    [w("bad.json", "{"), "PREP_INVALID", "PLAN_NOT_JSON"], [w("bom.json", `﻿${JSON.stringify(pi)}`), "PREP_INVALID", "PLAN_NOT_JSON"],
    [w("prot.json", JSON.stringify({ ...pi, hostaway: { ...pi.hostaway, sample: { reservationId: "70636076", listingId: L } }, probes: ["P-H1", "P-H4", "P-S1"] })), "PREP_INVALID", "PLAN_PROTECTED"],
    [join(f.base, "missing.json"), "PREP_UNREADABLE", null], [w("big.json", "x".repeat(16385)), "PREP_UNREADABLE", null]];
  for (const [i, [inp, code, planCode]] of cases.entries()) {
    const pc = fakeProc(["prepare-plan", "--in", inp, "--out", join(f.outDir, `o${i}.json`)]); const hc = hooks(); await M.main(pc, hc.value);
    const ec = lineOf(pc); assert.equal(ec.code, code, `case ${i}`); assert.equal(ec.planCode, planCode, `case ${i}`); assert.equal(hc.imports, 0); assert.ok(!existsSync(join(f.outDir, `o${i}.json`)));
    assert.ok(!pc.stdout.writes[0].includes(f.base));
  }
  for (const args of [["prepare-plan"], ["prepare-plan", "--in", draftPath], ["prepare-plan", "--in", draftPath, "--out", draftPath], ["prepare-plan", "--in", "rel", "--out", outPlan],
    ["prepare-plan", "--in", draftPath, "--in", draftPath]]) { const pu = fakeProc(args); await M.main(pu, hooks().value); assert.equal(lineOf(pu).code, "PREP_USAGE"); assert.deepEqual(pu.exits, [2]); }
  // non-owner-controlled parent (group / world writable) refuses
  const loose = join(f.base, "loose"); mkdirSync(loose); chmodSync(loose, 0o777);
  const pl = fakeProc(["prepare-plan", "--in", draftPath, "--out", join(loose, "p.json")]); await M.main(pl, hooks().value);
  assert.equal(lineOf(pl).code, "PREP_OUTPUT_PARENT_INVALID"); assert.ok(!existsSync(join(loose, "p.json")));
});

// ===== B4 pre-import digest =============================================================================================================
test("B4 execute digest is checked BEFORE the command import: missing / repeated / malformed / mismatched / unreadable / import failure → code only", async () => {
  const f = files(); const a = f.exec();
  const i = a.indexOf("--expect-source-digest");
  const variants = [[[...a.slice(0, i), ...a.slice(i + 2)], "BOOT_USAGE", 2], [[...a, "--expect-source-digest", repoDigest()], "BOOT_USAGE", 2],
    [a.map((x, k) => (k === i + 1 ? x.toUpperCase() : x)), "BOOT_USAGE", 2], [f.exec("e".repeat(64)), "BOOT_SOURCE_MISMATCH", 4]];
  for (const [args, code, exit] of variants) {
    const h = hooks(); const p = fakeProc(args); await M.main(p, h.value);
    const e = lineOf(p); assert.equal(e.schema, M.BOOT_SCHEMA); assert.equal(e.code, code); assert.deepEqual(p.exits, [exit]); assert.equal(h.imports, 0);
  }
  const hu = hooks({ readSource: async () => null }); const pu = fakeProc(a); await M.main(pu, hu.value);
  assert.equal(lineOf(pu).code, "BOOT_SOURCE_UNREADABLE"); assert.equal(hu.imports, 0);
  const fx = fakePrimitive();
  const hf = hooks({ primitive: { request: fx.request, Agent: fx.Agent }, importCommand: () => Promise.reject(new Error(f.base)) }); const pf = fakeProc(a); await M.main(pf, hf.value);
  const ef = lineOf(pf); assert.equal(ef.code, "BOOT_IMPORT_FAILED"); assert.deepEqual(pf.exits, [1]); assert.equal(fx.reqs, 0); assert.ok(!pf.stdout.writes[0].includes(f.base));
  // inspect needs no expected digest and reports the actual one (or null)
  const pn = fakeProc(["--plan", f.planPath]); await M.main(pn, hooks({ readSource: async () => null }).value);
  assert.equal(lineOf(pn).payload.source.sourceDigest, null); assert.deepEqual(pn.exits, [10]);
});

// ===== B5 execute through a FAKE primitive =================================================================================================
test("B5 execute composition: synthetic 0600 credentials, FAKE primitive, 0600 summary via native O_EXCL; one stdout write, exit after the callback", async () => {
  const f = files(); const fx = fakePrimitive(); const h = hooks({ primitive: { request: fx.request, Agent: fx.Agent } });
  const p = fakeProc(f.exec()); await M.main(p, h.value);
  const e = lineOf(p); assert.equal(e.exitCode, 0, JSON.stringify(e.output)); assert.equal(e.primaryOutcome, "CLI_COMPLETED_OK"); assert.deepEqual(p.exits, [0]);
  assert.deepEqual(e.output, { summaryFile: "CLOSED_ACK", summaryCloseState: "CLOSED" }); assert.deepEqual(e.payload.credential, { code: "CRED_OK", closeState: "CLOSED" });
  assert.equal(fx.reqs, 2); assert.equal(GUARD.request + GUARD.Agent, 0);
  assert.equal(readFileSync(f.out, "utf8"), `${P.canonicalJson(e.payload)}\n`); assert.equal(statSync(f.out).mode & 0o777, 0o600);
  for (const x of [HTOKEN, SKEY, f.base]) { assert.ok(!p.stdout.writes[0].includes(x)); assert.ok(!readFileSync(f.out, "utf8").includes(x)); }
  // the second run hits the existing summary: pre-run refusal, zero requests
  const fx2 = fakePrimitive(); const p2 = fakeProc(f.exec()); await M.main(p2, hooks({ primitive: { request: fx2.request, Agent: fx2.Agent } }).value);
  assert.equal(lineOf(p2).primaryOutcome, "CLI_OUTPUT_EXISTS"); assert.equal(fx2.reqs, 0);
  // a synthetic live-looking key is refused by C1 before any request
  const g = files({ creds: { hostawayToken: HTOKEN, stripeTestKey: "sk_live_Fake1" } }); const fx3 = fakePrimitive(); const p3 = fakeProc(g.exec());
  await M.main(p3, hooks({ primitive: { request: fx3.request, Agent: fx3.Agent } }).value);
  assert.equal(lineOf(p3).primaryOutcome, "CLI_CREDENTIAL_REFUSED"); assert.deepEqual(p3.exits, [5]); assert.equal(fx3.reqs, 0);
});

// ===== B6 signals ===========================================================================================================================
test("B6 SIGINT: first aborts (pre-run → 7, zero requests); second latches BEFORE exit(130) — no import, file, request, stdout or exit overwrite after it", async () => {
  { const f = files(); const fx = fakePrimitive(); const h = hooks({ primitive: { request: fx.request, Agent: fx.Agent } }); const p = fakeProc(f.exec());
    const m = M.main(p, h.value); p.sig(); await m;
    const e = lineOf(p); assert.equal(e.primaryOutcome, "CLI_INTERRUPTED"); assert.deepEqual(p.exits, [7]); assert.equal(fx.reqs, 0); assert.ok(!existsSync(f.out)); }
  { const f = files(); const fx = fakePrimitive(); const h = hooks({ primitive: { request: fx.request, Agent: fx.Agent } }); const p = fakeProc(f.exec());
    const m = M.main(p, h.value); p.sig(); p.sig(); await m; await flush();
    assert.deepEqual(p.exits, [130]); assert.deepEqual(p.codes, [130]); assert.equal(p.stdout.writes.length, 0); assert.equal(h.imports, 0); assert.equal(fx.reqs, 0); }
  // second SIGINT during the run (fake exit RETURNS): no further request, no summary create, no stdout, exit stays 130
  { const f = files(); const box = {}; const fx = fakePrimitive({ onRequest: () => { box.p.sig(); box.p.sig(); } });
    const h = hooks({ primitive: { request: fx.request, Agent: fx.Agent } }); const p = fakeProc(f.exec()); box.p = p;
    await M.main(p, h.value); await flush();
    assert.deepEqual(p.exits, [130]); assert.equal(p.stdout.writes.length, 0); assert.equal(fx.reqs, 1); assert.ok(!existsSync(f.out)); }
});

// ===== B7 stdout / platform ==================================================================================================================
test("B7 stdout: one attempt; callback error / error event / sync throw → 9; backpressure is not failure; races settle once; no ack → no exit; unsupported platform", async () => {
  const f = files();
  for (const [mode, exit] of [["ok", 10], ["backpressure", 10], ["cbError", 9], ["event", 9], ["throw", 9], ["race", 9]]) {
    const p = fakeProc(["--plan", f.planPath], { stdout: mode }); await M.main(p, hooks().value); await flush();
    assert.equal(p.stdout.writes.length, 1, mode); assert.deepEqual(p.exits, [exit], mode);
  }
  { const p = fakeProc(["--plan", f.planPath], { stdout: "never" }); const m = M.main(p, hooks().value);
    for (let i = 0; i < 20000 && p.stdout.writes.length === 0; i++) await tick();             // real fs IO: poll (bounded) for the single write
    await flush(60);
    assert.equal(p.stdout.writes.length, 1); assert.deepEqual(p.exits, []); p.sig(); p.sig(); assert.deepEqual(p.exits, [130]); void m; }
  for (const o of [{ platform: "win32" }, { constants: { ...FSC, O_NOFOLLOW: undefined } }, { constants: { O_RDONLY: 0 } }]) {
    const h = hooks({ readSource: async () => { throw new Error("must not read"); } }); const p = fakeProc(["--plan", f.planPath], o);
    await M.main(p, h.value); const e = lineOf(p); assert.equal(e.code, "BOOT_UNSUPPORTED"); assert.deepEqual(p.exits, [3]); assert.equal(h.imports, 0);
  }
  { const p = fakeProc(f.exec(), { noUid: true }); const h = hooks(); await M.main(p, h.value); assert.equal(lineOf(p).code, "BOOT_UNSUPPORTED"); assert.equal(h.imports, 0); }
  { const p = fakeProc(["--plan", f.planPath], { noUid: true }); await M.main(p, hooks().value); assert.equal(lineOf(p).payload.preflight.code, "ENV_UID_UNAVAILABLE"); }
});

// ===== N native adapter mappings (synthetic files only) ======================================================================================
const nat = (gate = () => {}) => M.createNativeAdapters({ platform: process.platform, uid: process.getuid(), constants: FSC, gate });
test("N1–N6 native mappings: bigint stat strings, O_NOFOLLOW / ENOENT / EEXIST own-data codes, counts, undefined acks, exact Uint8Array, bounds, closure digest", async () => {
  const d = tmp(); const file = join(d, "f.bin"); writeFileSync(file, "hello", { mode: 0o600 }); const link = join(d, "l.bin"); symlinkSync(file, link); mkdirSync(join(d, "dir"));
  const a = nat();
  // N1
  const s = await a.credentialFs.lstat(file); assert.equal(s.kind, "file"); assert.equal(s.size, 5); assert.match(s.dev, /^[0-9]+$/); assert.match(s.ino, /^[0-9]+$/); assert.match(s.mtimeNs, /^[0-9]+$/);
  assert.equal(s.mtimeNs, String((await pLstat(file, { bigint: true })).mtimeNs)); assert.equal((await a.credentialFs.lstat(link)).kind, "symlink"); assert.equal((await a.credentialFs.lstat(join(d, "dir"))).kind, "dir");
  const fake = { dev: -1n, ino: 1n, mode: 1n, nlink: 1n, size: 1n, uid: 1n, mtimeNs: 1n, ctimeNs: 1n, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false };
  for (const bad of [fake, { ...fake, dev: 1n, size: 2n ** 60n }, { ...fake, dev: 1n, mode: 5 }]) assert.throws(() => M.mapStat(bad), (e) => e.code === "E7_STAT_RANGE");
  // N2
  const code = async (pr) => { try { await pr; return "RESOLVED"; } catch (e) { const dsc = Object.getOwnPropertyDescriptor(e, "code"); return dsc && "value" in dsc ? dsc.value : "NO_OWN_CODE"; } };
  assert.equal(await code(a.credentialFs.open(link, "credential-read")), "ELOOP"); assert.equal(await code(a.credentialFs.lstat(join(d, "nope"))), "ENOENT");
  // N3 — raw handle + the full accepted C1 loader over a synthetic 0600 file
  const h = await a.credentialFs.open(file, "credential-read"); const buf = new Uint8Array(4097);
  assert.equal(await h.read(buf, 0, 4097), 5); assert.equal(await h.read(buf, 5, 4092), 0); assert.equal(await h.close(), undefined);
  const C1 = await import("../scripts/e7-connected/probe-credential-file.mjs");
  const cd = join(d, "cred"); mkdirSync(cd, { mode: 0o700 }); const cp = join(cd, "c.json"); writeFileSync(cp, JSON.stringify({ hostawayToken: HTOKEN }), { mode: 0o600 }); chmodSync(cp, 0o600);
  const r = await C1.readProbeCredentialFile({ path: cp, repoRoot: ROOT, needs: { hostaway: true, stripe: false }, fs: a.credentialFs });
  assert.equal(r.ok, true); assert.equal(r.closeState, "CLOSED"); assert.equal(r.credentials.hostawayToken, HTOKEN);
  const rl = await C1.readProbeCredentialFile({ path: join(cd, "lnk.json"), repoRoot: ROOT, needs: { hostaway: true, stripe: false }, fs: a.credentialFs });
  assert.equal(rl.code, "CRED_MISSING");
  symlinkSync(cp, join(cd, "lnk.json"));
  assert.equal((await C1.readProbeCredentialFile({ path: join(cd, "lnk.json"), repoRoot: ROOT, needs: { hostaway: true, stripe: false }, fs: a.credentialFs })).code, "CRED_NOT_REGULAR");
  // N4
  const out = join(d, "out.json"); const w = await a.outputFs.create(out, "summary-create"); const bytes = new TextEncoder().encode("abc\n");
  assert.equal(await w.write(bytes, 0, 4), 4); assert.equal(await w.sync(), undefined); assert.equal(await w.close(), undefined);
  assert.equal(statSync(out).mode & 0o777, 0o600); assert.equal(readFileSync(out, "utf8"), "abc\n"); assert.equal(await code(a.outputFs.create(out, "summary-create")), "EEXIST");
  assert.equal(await code(a.outputFs.create(join(d, "x"), "other-kind")), "E7_KIND");
  // N5
  const pb = await a.readPlanFile(file); assert.equal(Object.getPrototypeOf(pb), Uint8Array.prototype); assert.equal(new TextDecoder().decode(pb), "hello");
  const big = join(d, "big"); writeFileSync(big, "x".repeat(16385)); assert.equal(await code(a.readPlanFile(big)), "E7_SIZE");
  const empty = join(d, "empty"); writeFileSync(empty, ""); assert.equal(await code(a.readPlanFile(empty)), "E7_SIZE");
  assert.equal(await code(a.readPlanFile(join(d, "dir"))), "E7_NOT_REGULAR"); assert.equal(await code(a.readPlanFile(link)), "ELOOP");
  // terminal latch gate: nothing new starts
  const g = nat(() => { throw Object.assign(new Error(), { code: "E7_TERMINAL" }); });
  for (const pr of [g.readPlanFile(file), g.credentialFs.lstat(file), g.outputFs.create(join(d, "g"), "summary-create")]) assert.equal(await code(pr), "E7_TERMINAL");
  assert.ok(!existsSync(join(d, "g")));
  // N6 — real repo closure (source text) twice; a synthetic mirror with one changed byte differs
  const s1 = await a.readSource(ROOT); const s2 = await a.readSource(ROOT);
  assert.equal(D.computeSourceDigest(s1).digest, repoDigest()); assert.equal(D.computeSourceDigest(s2).digest, repoDigest());
  const mirror = tmp(); for (const p of D.SOURCE_CLOSURE) { mkdirSync(join(mirror, dirname(p)), { recursive: true }); writeFileSync(join(mirror, p), readFileSync(join(ROOT, p))); }
  assert.equal(D.computeSourceDigest(await a.readSource(mirror)).digest, repoDigest());
  const target = join(mirror, "lib/checkout/compensation-proof.js"); const b = readFileSync(target); b[0] ^= 1; writeFileSync(target, b);
  assert.notEqual(D.computeSourceDigest(await a.readSource(mirror)).digest, repoDigest());
  rmSync(join(mirror, "package.json")); assert.equal(await a.readSource(mirror), null);
});
