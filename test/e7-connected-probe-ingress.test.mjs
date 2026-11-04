// test/e7-connected-probe-ingress.test.mjs — E7 probe CLI stage C1 (OFFLINE, FAKE-ONLY). Every snapshot / fs / stat / handle / promise /
// body below is an injected fake; no real credential file, temp file, env, owner, account, network or default fs primitive is used.
// Source files are read as TEXT only, for the containment pins.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as ENV from "../scripts/e7-connected/probe-env-preflight.mjs";
import * as CRED from "../scripts/e7-connected/probe-credential-file.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { evaluateProbeEnvironment } = ENV;
const { readProbeCredentialFile } = CRED;

const unhandled = [];
process.on("unhandledRejection", (e) => unhandled.push(e));

// ---- helpers ------------------------------------------------------------------------------------------------------------------------
const deepFrozen = (o) => { if (o === null || typeof o !== "object") return true; if (!Object.isFrozen(o)) return false; return Reflect.ownKeys(o).every((k) => deepFrozen(Object.getOwnPropertyDescriptor(o, k).value)); };
const revoked = () => { const r = Proxy.revocable({}, {}); r.revoke(); return r.proxy; };
const enc = (s) => new TextEncoder().encode(s);

// ===== ENV preflight ===================================================================================================================
const present = (over = {}) => ({ ...Object.fromEntries(ENV.PRESENT_KEYS.map((k) => [k, false])), ...over });
const snap = (over = {}) => ({ schema: ENV.ENV_SNAPSHOT_SCHEMA, nodeVersion: "24.22.1", platform: "linux", execArgvCount: 0, uidAvailable: true, present: present(), ...over });

test("ENV1 positive controls: supported fake versions / platforms → ENV_OK, all checks, deep-frozen, exact keys", () => {
  for (const nodeVersion of ENV.SUPPORTED_NODE_VERSIONS) for (const platform of ENV.SUPPORTED_PLATFORMS) {
    const r = evaluateProbeEnvironment(snap({ nodeVersion, platform }));
    assert.equal(r.ok, true); assert.equal(r.code, "ENV_OK");
    assert.deepEqual(Object.keys(r), ["ok", "code", "checks"]); assert.deepEqual(Object.keys(r.checks), [...ENV.ENV_CHECK_KEYS]);
    assert.deepEqual({ ...r.checks }, { nodeVersionSupported: true, platformSupported: true, execArgvEmpty: true, refusedVariablesAbsent: true, uidAvailable: true, proxyVariablesPresent: false });
    assert.ok(deepFrozen(r));
  }
  // null-prototype snapshot and present objects are accepted controls
  const n = Object.assign(Object.create(null), snap({ present: Object.assign(Object.create(null), present()) }));
  assert.equal(evaluateProbeEnvironment(n).code, "ENV_OK");
});

test("ENV2 refusal precedence NODE → PLATFORM → EXEC_FLAGS → VARIABLE_REFUSED → UID; proxy names report-only", () => {
  const all = { nodeVersion: "20.0.0", platform: "win32", execArgvCount: 2, uidAvailable: false, present: present({ NODE_OPTIONS: true }) };
  assert.equal(evaluateProbeEnvironment(snap(all)).code, "ENV_NODE_UNSUPPORTED");
  assert.equal(evaluateProbeEnvironment(snap({ ...all, nodeVersion: "22.22.0" })).code, "ENV_PLATFORM_UNSUPPORTED");
  assert.equal(evaluateProbeEnvironment(snap({ ...all, nodeVersion: "22.22.0", platform: "darwin" })).code, "ENV_EXEC_FLAGS");
  assert.equal(evaluateProbeEnvironment(snap({ ...all, nodeVersion: "22.22.0", platform: "darwin", execArgvCount: 0 })).code, "ENV_VARIABLE_REFUSED");
  assert.equal(evaluateProbeEnvironment(snap({ uidAvailable: false })).code, "ENV_UID_UNAVAILABLE");
  for (const k of ENV.REFUSED_VARIABLES) { const r = evaluateProbeEnvironment(snap({ present: present({ [k]: true }) })); assert.equal(r.code, "ENV_VARIABLE_REFUSED", k); assert.equal(r.ok, false); assert.equal(r.checks.refusedVariablesAbsent, false); }
  for (const k of ENV.PROXY_VARIABLES) { const r = evaluateProbeEnvironment(snap({ present: present({ [k]: true }) })); assert.equal(r.code, "ENV_OK", k); assert.equal(r.checks.proxyVariablesPresent, true); }
  assert.equal(evaluateProbeEnvironment(snap({ nodeVersion: "24.22.1 " })).code, "ENV_NODE_UNSUPPORTED");     // exact match, no trimming
  for (const r of [evaluateProbeEnvironment(snap(all))]) { assert.ok(deepFrozen(r)); assert.equal(Object.values(r.checks).filter(Boolean).length, 0); }
});

test("ENV3 malformed / hostile snapshots → ENV_SNAPSHOT_INVALID, all-false checks, no getter ever runs", () => {
  let ran = 0;
  const acc = snap(); Object.defineProperty(acc, "platform", { get() { ran++; return "linux"; }, enumerable: true });
  const accP = snap({ present: present() }); Object.defineProperty(accP.present, "NODE_OPTIONS", { get() { ran++; return false; }, enumerable: true });
  const nonEnum = snap(); Object.defineProperty(nonEnum, "uidAvailable", { value: true, enumerable: false });
  const sym = snap(); sym[Symbol("x")] = 1;
  const symP = snap(); symP.present[Symbol.iterator] = 1;
  class K { constructor() { Object.assign(this, snap()); } }
  const bad = [undefined, null, 1, "s", [], new K(), revoked(), new Proxy(snap(), {}), snap({ present: revoked() }), snap({ present: new Proxy(present(), {}) }), acc, accP, nonEnum, sym, symP,
    { ...snap(), extra: 1 }, (() => { const s = snap(); delete s.uidAvailable; return s; })(), snap({ schema: "v0" }), snap({ nodeVersion: 24 }), snap({ nodeVersion: "x".repeat(33) }),
    snap({ platform: "l".repeat(17) }), snap({ execArgvCount: -1 }), snap({ execArgvCount: 1.5 }), snap({ execArgvCount: 1025 }), snap({ execArgvCount: "0" }), snap({ execArgvCount: [] }), (() => { const s = snap(); delete s.execArgvCount; s.execArgv = []; return s; })(), snap({ uidAvailable: 1 }),
    snap({ present: present({ NODE_OPTIONS: "no" }) }), snap({ present: { ...present(), EXTRA: false } }), snap({ present: (() => { const p = present(); delete p.no_proxy; return p; })() }),
    snap({ present: [] })];
  for (const [i, s] of bad.entries()) {
    const r = evaluateProbeEnvironment(s);
    assert.equal(r.code, "ENV_SNAPSHOT_INVALID", `case ${i}`); assert.equal(r.ok, false); assert.ok(deepFrozen(r));
    assert.ok(Object.values(r.checks).every((v) => v === false));
  }
  assert.equal(ran, 0);
});

test("ENV4 code vocabulary bounded; no snapshot value is echoed", () => {
  const r = evaluateProbeEnvironment(snap({ nodeVersion: "SENTINEL_VER_9" }));
  assert.ok(ENV.ENV_CODES.includes(r.code)); assert.ok(!JSON.stringify(r).includes("SENTINEL"));
});

// ===== credential loader: fake adapter ================================================================================================
const PATH = "/home/fake/.config/e7/creds.json";
const REPO = "/home/fake/repo";
const TOK = "tokSENTINELhost1";
const KEY = "sk_test_Fake1";
const body = (o) => enc(JSON.stringify(o));
const enoent = () => Object.assign(new Error("fake"), { code: "ENOENT" });
const baseStat = (size, over = {}) => ({ dev: "16777220", ino: "4242", kind: "file", mode: 0o100600, nlink: 1, size, uid: 501, mtimeNs: "1730000000000000001", ctimeNs: "1730000000000000002", ...over });

/** a fully fake adapter; `o` hooks override individual behaviours. Returns { fs, log, bufs } */
function fake(o = {}) {
  const content = o.content ?? body({ hostawayToken: TOK });
  const log = []; const bufs = [];
  let pathLstats = 0; let fdStats = 0; let reads = 0; let pos = 0;
  const st = (over) => baseStat(content.length, { ...o.stat, ...over });
  const handle = () => {
    const h = {
      stat: (...a) => { log.push("fstat"); fdStats++; return o.fstat ? o.fstat(fdStats, st) : Promise.resolve(st()); },
      read: (buf, off, len, ...rest) => {
        log.push("read"); reads++; bufs.push(buf);
        if (o.read) return o.read({ buf, off, len, reads, content, rest });
        const n = Math.min(o.chunk ?? len, len, content.length - pos);
        for (let i = 0; i < n; i++) buf[off + i] = content[pos + i];
        pos += n; return Promise.resolve(n);
      },
      close: (...a) => { log.push("close"); return o.close ? o.close() : Promise.resolve(undefined); }
    };
    return o.handle ? o.handle(h) : h;
  };
  const fs = {
    platform: o.platform ?? "linux", uid: o.uid ?? 501,
    realpath: (p) => { log.push(`realpath ${p}`); return o.realpath ? o.realpath(p) : Promise.resolve(p); },
    lstat: (p) => {
      log.push(`lstat ${p}`);
      if (o.lstat) { const r = o.lstat(p); if (r !== undefined) return r; }
      if (p.endsWith("/.git")) return (o.git ?? []).includes(p) ? Promise.resolve(baseStat(64, { kind: "dir", mode: 0o40755 })) : Promise.reject(enoent());
      if (p === PATH) { pathLstats++; return o.pathStat ? o.pathStat(pathLstats, st) : Promise.resolve(st()); }
      return Promise.reject(enoent());
    },
    open: (p, kind) => { log.push(`open ${p} ${kind}`); return o.open ? o.open(handle) : Promise.resolve(handle()); }
  };
  return { fs: o.fs ? o.fs(fs) : fs, log, bufs };
}
const NEED_H = { hostaway: true, stripe: false };
const run = (f, needs = NEED_H, over = {}) => readProbeCredentialFile({ path: PATH, repoRoot: REPO, needs, fs: f.fs, ...over });
const SENTINELS = ["SENTINEL", TOK, KEY, "sk_live", PATH, REPO, "creds.json"];
function assertPublicFailure(r, code, closeState) {
  assert.equal(r.ok, false); assert.equal(r.code, code); assert.equal(r.closeState, closeState);
  assert.deepEqual(Object.keys(r), ["ok", "code", "closeState"]); assert.ok(deepFrozen(r));
  assert.ok(CRED.CREDENTIAL_CODES.includes(r.code)); assert.ok(CRED.CLOSE_STATES.includes(r.closeState));
  const s = JSON.stringify(r) + String(Object.values(r)); for (const x of SENTINELS) assert.ok(!s.includes(x), x);
}
const zeroed = (bufs) => bufs.every((b) => b.every((x) => x === 0));
const count = (log, w) => log.filter((l) => l === w || l.startsWith(`${w} `)).length;

test("C1 positive controls: hostaway-only, stripe-only, both; PRIVATE capability non-enumerable, frozen, never serialized; buffer zeroed", async () => {
  const cases = [[NEED_H, { hostawayToken: TOK }], [{ hostaway: false, stripe: true }, { stripeTestKey: KEY }], [{ hostaway: true, stripe: true }, { hostawayToken: TOK, stripeTestKey: KEY }]];
  for (const [needs, obj] of cases) {
    const f = fake({ content: body(obj) });
    const r = await run(f, needs);
    assert.equal(r.ok, true); assert.equal(r.closeState, "CLOSED"); assert.ok(Object.isFrozen(r)); assert.ok(Object.isFrozen(r.credentials));
    assert.equal(Object.getPrototypeOf(r.credentials), null); assert.deepEqual(Object.keys(r.credentials), []);
    for (const [k, v] of Object.entries(obj)) { assert.equal(r.credentials[k], v); assert.equal(Object.getOwnPropertyDescriptor(r.credentials, k).enumerable, false); }
    assert.deepEqual(Reflect.ownKeys(r.credentials).sort(), Object.keys(obj).sort());
    const s = JSON.stringify(r) + JSON.stringify({ ...r }) + Object.values(r).map((v) => typeof v === "object" ? JSON.stringify(v) : String(v)).join(); for (const x of [TOK, KEY, "SENTINEL"]) assert.ok(!s.includes(x));
    assert.equal(count(f.log, "close"), 1); assert.equal(count(f.log, "open"), 1);
    assert.ok(zeroed(f.bufs)); assert.equal(new Set(f.bufs).size, 1);
    assert.ok(f.bufs[0] instanceof Uint8Array && f.bufs[0].length === CRED.READ_BUFFER_BYTES);
    // exact boundary/call order (counted): 2 realpath, 4 .git lstats (/home/fake/.config/e7, ., /home/fake, /home, /), pre lstat, open, fstat, reads, fstat, post lstat, close
    assert.deepEqual(f.log.filter((l) => l !== "read"), ["realpath /home/fake/.config/e7", `realpath ${REPO}`, "lstat /home/fake/.config/e7/.git", "lstat /home/fake/.config/.git",
      "lstat /home/fake/.git", "lstat /home/.git", "lstat /.git", `lstat ${PATH}`, `open ${PATH} credential-read`, "fstat", "fstat", `lstat ${PATH}`, "close"]);
  }
});

test("C2 inputs: hostile / non-canonical / wrong needs → CRED_INPUT_INVALID with ZERO fs calls; no getter runs", async () => {
  let ran = 0; const f = fake();
  const base = () => ({ path: PATH, repoRoot: REPO, needs: { ...NEED_H }, fs: f.fs });
  const acc = base(); Object.defineProperty(acc, "path", { get() { ran++; return PATH; }, enumerable: true });
  const accN = base(); Object.defineProperty(accN.needs, "stripe", { get() { ran++; return false; }, enumerable: true });
  const bad = [undefined, null, revoked(), new Proxy(base(), {}), acc, accN, { ...base(), extra: 1 }, { ...base(), needs: revoked() }, { ...base(), needs: new Proxy({ ...NEED_H }, {}) },
    { ...base(), needs: { hostaway: false, stripe: false } }, { ...base(), needs: { hostaway: 1, stripe: false } }, { ...base(), needs: { hostaway: true } }, { ...base(), needs: { hostaway: true, stripe: false, x: 1 } },
    ...["rel/creds.json", "", "/", "//creds.json", "/a//b", "/a/./b", "/a/../b", "/a/b/", "/a/\0b", `/${"a".repeat(4096)}`, 5].map((path) => ({ ...base(), path })),
    ...["", "//", "/a/", "/a/..", "rel", "/a\0"].map((repoRoot) => ({ ...base(), repoRoot }))];
  for (const [i, inp] of bad.entries()) assertPublicFailure(await readProbeCredentialFile(inp), "CRED_INPUT_INVALID", "NOT_OPENED"), assert.equal(f.log.length, 0, `case ${i}`);
  assert.equal(ran, 0);
  // null-prototype input / needs are accepted controls
  const ok = Object.assign(Object.create(null), base(), { needs: Object.assign(Object.create(null), NEED_H) });
  assert.equal((await readProbeCredentialFile(ok)).ok, true);
});

test("C3 adapter schema / platform: CRED_ADAPTER_INVALID / CRED_PLATFORM_UNSUPPORTED before any fs call", async () => {
  let ran = 0;
  const mk = (edit) => { const f = fake({ fs: (fs) => edit({ ...fs }) }); return f; };
  const variants = [(fs) => { delete fs.open; return fs; }, (fs) => ({ ...fs, extra: 1 }), (fs) => ({ ...fs, uid: -1 }), (fs) => ({ ...fs, uid: 1.5 }), (fs) => ({ ...fs, uid: "501" }),
    (fs) => ({ ...fs, platform: 1 }), (fs) => ({ ...fs, lstat: new Proxy(fs.lstat, {}) }), (fs) => ({ ...fs, realpath: "fn" }), (fs) => new Proxy(fs, {}),
    (fs) => { const o = { ...fs }; Object.defineProperty(o, "open", { get() { ran++; return fs.open; }, enumerable: true }); return o; }];
  for (const v of variants) { const f = mk(v); assertPublicFailure(await run(f), "CRED_ADAPTER_INVALID", "NOT_OPENED"); assert.equal(f.log.length, 0); }
  for (const platform of ["win32", "freebsd", "Linux"]) { const f = fake({ platform }); assertPublicFailure(await run(f), "CRED_PLATFORM_UNSUPPORTED", "NOT_OPENED"); assert.equal(f.log.length, 0); }
  assert.equal((await run(fake({ platform: "darwin" }))).ok, true);
  assert.equal(ran, 0);
});

test("C4 realpath: non-canonical parent, malformed return schema, rejection, non-native promise / thenable never assimilated", async () => {
  assertPublicFailure(await run(fake({ realpath: (p) => Promise.resolve(p === REPO ? p : "/private/other") })), "CRED_PATH_NOT_CANONICAL", "NOT_OPENED");
  for (const v of ["rel", "", "/a//b", "/a/", 5, null, { p: "/a" }]) assertPublicFailure(await run(fake({ realpath: () => Promise.resolve(v) })), "CRED_ADAPTER_INVALID", "NOT_OPENED");
  assertPublicFailure(await run(fake({ realpath: () => Promise.reject(Object.assign(new Error(PATH), { code: "EACCES" })) })), "CRED_IO", "NOT_OPENED");
  let thenCalls = 0;
  const thenable = { then(r) { thenCalls++; r("/x"); } };
  assertPublicFailure(await run(fake({ realpath: () => thenable })), "CRED_ADAPTER_INVALID", "NOT_OPENED");
  const own = Promise.resolve("/x"); own.then = () => { thenCalls++; };
  assertPublicFailure(await run(fake({ realpath: () => own })), "CRED_ADAPTER_INVALID", "NOT_OPENED");
  class Sub extends Promise {}
  assertPublicFailure(await run(fake({ realpath: (p) => Sub.resolve(p) })), "CRED_ADAPTER_INVALID", "NOT_OPENED");
  assertPublicFailure(await run(fake({ realpath: () => { throw new Error(PATH); } })), "CRED_ADAPTER_INVALID", "NOT_OPENED");
  assert.equal(thenCalls, 0);
});

test("C5 repo containment: under repo, repoRoot '/' (and realpath → '/') fail CLOSED; sibling prefix is not 'inside'", async () => {
  assertPublicFailure(await run(fake(), NEED_H, { repoRoot: "/home/fake/.config" }), "CRED_IN_REPO", "NOT_OPENED");
  assertPublicFailure(await run(fake(), NEED_H, { repoRoot: "/home/fake/.config/e7" }), "CRED_IN_REPO", "NOT_OPENED");
  const r = fake(); assertPublicFailure(await run(r, NEED_H, { repoRoot: "/" }), "CRED_IN_REPO", "NOT_OPENED"); assert.equal(count(r.log, "lstat"), 0);
  assertPublicFailure(await run(fake({ realpath: (p) => Promise.resolve(p === REPO ? "/" : p) })), "CRED_IN_REPO", "NOT_OPENED");
  assertPublicFailure(await run(fake({ realpath: (p) => Promise.resolve(p === REPO ? "/home/fake/.config" : p) })), "CRED_IN_REPO", "NOT_OPENED");   // realpath'd root decides
  assert.equal((await run(fake(), NEED_H, { repoRoot: "/home/fake/.conf" })).ok, true);                                                       // prefix sibling
  assert.equal((await run(fake(), NEED_H, { repoRoot: "/home/fake/.config/e7x" })).ok, true);
});

test("C6 .git ancestor walk: exact '/.git' at root; any present entry refuses; only ENOENT/ENOTDIR = absent (own-data code, getter-free)", async () => {
  const f = fake(); await run(f);
  assert.ok(f.log.includes("lstat /.git")); assert.ok(!f.log.some((l) => l.includes("//")));
  for (const g of ["/home/fake/.config/e7/.git", "/home/fake/.git", "/.git"]) assertPublicFailure(await run(fake({ git: [g] })), "CRED_IN_GIT_TREE", "NOT_OPENED");
  assertPublicFailure(await run(fake({ lstat: (p) => p === "/home/.git" ? Promise.resolve(baseStat(1, { kind: "symlink" })) : undefined })), "CRED_IN_GIT_TREE", "NOT_OPENED");
  assert.equal((await run(fake({ lstat: (p) => p.endsWith(".git") ? Promise.reject(Object.assign(new Error(), { code: "ENOTDIR" })) : undefined }))).ok, true);
  let ran = 0;
  const getterErr = {}; Object.defineProperty(getterErr, "code", { get() { ran++; return "ENOENT"; } });
  for (const e of [Object.assign(new Error(), { code: "EACCES" }), Object.assign(new Error(), { code: "EIO" }), new Error("ENOENT"), "ENOENT", null, getterErr, revoked(), new Proxy({ code: "ENOENT" }, {})])
    assertPublicFailure(await run(fake({ lstat: (p) => p === "/home/.git" ? Promise.reject(e) : undefined })), "CRED_IO", "NOT_OPENED");
  assertPublicFailure(await run(fake({ lstat: (p) => p === "/home/.git" ? Promise.resolve({ kind: "dir" }) : undefined })), "CRED_ADAPTER_INVALID", "NOT_OPENED");
  assert.equal(ran, 0);
  // depth bound decided from the text, before any fs call
  const deep = `/${Array.from({ length: CRED.MAX_ANCESTORS }, (_, i) => `d${i}`).join("/")}/c.json`;
  const fd = fake(); assertPublicFailure(await readProbeCredentialFile({ path: deep, repoRoot: REPO, needs: NEED_H, fs: fd.fs }), "CRED_PATH_INVALID", "NOT_OPENED"); assert.equal(fd.log.length, 0);
  const okDeep = `/${Array.from({ length: CRED.MAX_ANCESTORS - 1 }, (_, i) => `d${i}`).join("/")}/c.json`;
  const fo = fake({ lstat: (p) => p === okDeep ? Promise.resolve(baseStat(body({ hostawayToken: "t" }).length)) : undefined, content: body({ hostawayToken: "t" }) });
  const ro = await readProbeCredentialFile({ path: okDeep, repoRoot: REPO, needs: NEED_H, fs: fo.fs });
  assert.equal(count(fo.log, "lstat"), CRED.MAX_ANCESTORS + 2); assert.equal(ro.ok, true);
});

test("C7 pre-lstat policy + strict stat schema (before any comparison); open never called", async () => {
  const pol = [[{ kind: "symlink" }, "CRED_NOT_REGULAR"], [{ kind: "dir" }, "CRED_NOT_REGULAR"], [{ kind: "other" }, "CRED_NOT_REGULAR"], [{ uid: 0 }, "CRED_OWNER"],
    [{ mode: 0o100644 }, "CRED_MODE"], [{ mode: 0o100400 }, "CRED_MODE"], [{ mode: 0o100700 }, "CRED_MODE"], [{ mode: 0o100640 }, "CRED_MODE"], [{ mode: 0o104600 }, "CRED_MODE"], [{ mode: 0o101600 }, "CRED_MODE"], [{ nlink: 2 }, "CRED_LINKS"], [{ nlink: 0 }, "CRED_LINKS"],
    [{ size: 0 }, "CRED_SIZE"], [{ size: 4097 }, "CRED_SIZE"]];
  for (const [over, code] of pol) { const f = fake({ pathStat: (n, st) => Promise.resolve(st(over)) }); assertPublicFailure(await run(f), code, "NOT_OPENED"); assert.equal(count(f.log, "open"), 0); }
  // policy order on one stat: kind → owner → mode → links → size
  assertPublicFailure(await run(fake({ pathStat: (n, st) => Promise.resolve(st({ kind: "dir", uid: 0, mode: 0o40755, nlink: 3 })) })), "CRED_NOT_REGULAR", "NOT_OPENED");
  assertPublicFailure(await run(fake({ pathStat: (n, st) => Promise.resolve(st({ uid: 0, mode: 0o100644 })) })), "CRED_OWNER", "NOT_OPENED");
  let ran = 0;
  const malformed = [{ dev: 1 }, { dev: "01" }, { dev: "-1" }, { dev: "1".repeat(41) }, { ino: "4.2" }, { ino: 4242 }, { kind: "File" }, { mode: -1 }, { mode: 0o200000 }, { mode: 1.5 }, { nlink: -1 },
    { nlink: 2 ** 32 }, { uid: -1 }, { uid: "501" }, { size: -1 }, { size: 2 ** 53 }, { size: "25" }, { mtimeNs: "1.5" }, { mtimeNs: 17 }, { ctimeNs: "" }, { ctimeNs: "0x1" }];
  for (const over of malformed) assertPublicFailure(await run(fake({ pathStat: (n, st) => Promise.resolve(st(over)) })), "CRED_ADAPTER_INVALID", "NOT_OPENED");
  const extraKey = (n, st) => Promise.resolve({ ...st(), atimeNs: "1" });
  const missKey = (n, st) => { const s = st(); delete s.ctimeNs; return Promise.resolve(s); };
  const accStat = (n, st) => { const s = st(); Object.defineProperty(s, "uid", { get() { ran++; return 501; }, enumerable: true }); return Promise.resolve(s); };
  for (const ps of [extraKey, missKey, accStat, () => Promise.resolve(new Proxy(baseStat(25), {})), () => Promise.resolve(null)])
    assertPublicFailure(await run(fake({ pathStat: ps })), "CRED_ADAPTER_INVALID", "NOT_OPENED");
  // a revoked proxy cannot even be a fulfilment value: native resolution's `then` lookup throws, so the adapter promise REJECTS → CRED_IO
  assertPublicFailure(await run(fake({ pathStat: () => Promise.resolve(revoked()) })), "CRED_IO", "NOT_OPENED");
  assertPublicFailure(await run(fake({ pathStat: () => Promise.reject(enoent()) })), "CRED_MISSING", "NOT_OPENED");
  assertPublicFailure(await run(fake({ pathStat: () => Promise.reject(Object.assign(new Error(), { code: "EACCES" })) })), "CRED_IO", "NOT_OPENED");
  assert.equal(ran, 0);
  assert.equal((await run(fake({ stat: { dev: "0", ino: "0", mtimeNs: "0", ctimeNs: "0", uid: 0 }, uid: 0 }))).ok, true);   // decimal "0" + uid 0 are valid
});

test("C8 open / handle acquisition: close captured FIRST; malformed-but-closable handles are closed once; unclosable claims no cleanup", async () => {
  assertPublicFailure(await run(fake({ open: () => Promise.reject(Object.assign(new Error(), { code: "ELOOP" })) })), "CRED_IO", "NOT_OPENED");
  assertPublicFailure(await run(fake({ open: () => ({ then() {} }) })), "CRED_ADAPTER_INVALID", "NOT_OPENED");          // residual: caller-owned thenable
  assertPublicFailure(await run(fake({ open: () => { throw new Error(); } })), "CRED_ADAPTER_INVALID", "NOT_OPENED");
  // malformed but closable: extra key / missing read / stat proxy / read accessor → ADAPTER_INVALID, closed once, no read/stat
  let ran = 0;
  const closable = [(h) => ({ ...h, fd: 3 }), (h) => ({ close: h.close, stat: h.stat }), (h) => ({ ...h, stat: new Proxy(h.stat, {}) }),
    (h) => { const o = { close: h.close, stat: h.stat }; Object.defineProperty(o, "read", { get() { ran++; return h.read; }, enumerable: true }); return o; },
    (h) => Object.assign(Object.create({ inherited: 1 }), h)];
  for (const hk of closable) { const f = fake({ handle: hk }); assertPublicFailure(await run(f), "CRED_ADAPTER_INVALID", "CLOSED"); assert.equal(count(f.log, "close"), 1); assert.equal(count(f.log, "read") + count(f.log, "fstat"), 0); }
  // unclosable: proxy handle, revoked, accessor close, missing close, non-function close, null / primitive handle
  const unclosable = [(h) => new Proxy(h, {}), (h) => { const o = { read: h.read, stat: h.stat }; Object.defineProperty(o, "close", { get() { ran++; return h.close; }, enumerable: true }); return o; },
    (h) => ({ read: h.read, stat: h.stat }), (h) => ({ ...h, close: 1 }), (h) => ({ ...h, close: new Proxy(h.close, {}) }), () => null, () => 7];
  for (const hk of unclosable) { const f = fake({ handle: hk }); assertPublicFailure(await run(f), "CRED_ADAPTER_INVALID", "UNCLOSABLE"); assert.equal(count(f.log, "close"), 0); }
  assertPublicFailure(await run(fake({ handle: () => revoked() })), "CRED_IO", "NOT_OPENED");   // revoked proxy: native resolution itself rejects
  assert.equal(ran, 0);
});

test("C9 fd stat s1: policy before identity; any identity/time drift → CRED_CHANGED; close once after", async () => {
  for (const k of ["dev", "ino", "mtimeNs", "ctimeNs"]) { const f = fake({ fstat: (n, st) => Promise.resolve(st({ [k]: "9" })) }); assertPublicFailure(await run(f), "CRED_CHANGED", "CLOSED"); assert.equal(count(f.log, "read"), 0); assert.equal(count(f.log, "close"), 1); }
  assertPublicFailure(await run(fake({ fstat: (n, st) => Promise.resolve(st({ size: 30 })) })), "CRED_CHANGED", "CLOSED");
  assertPublicFailure(await run(fake({ fstat: (n, st) => Promise.resolve(st({ mode: 0o100640, ino: "9" })) })), "CRED_MODE", "CLOSED");      // policy beats identity
  assertPublicFailure(await run(fake({ fstat: (n, st) => Promise.resolve(st({ nlink: 2, mtimeNs: "9" })) })), "CRED_LINKS", "CLOSED");
  assertPublicFailure(await run(fake({ fstat: (n, st) => Promise.resolve(st({ uid: 0 })) })), "CRED_OWNER", "CLOSED");
  assertPublicFailure(await run(fake({ fstat: () => Promise.reject(new Error()) })), "CRED_IO", "CLOSED");
  assertPublicFailure(await run(fake({ fstat: () => Promise.resolve({}) })), "CRED_ADAPTER_INVALID", "CLOSED");
  assertPublicFailure(await run(fake({ fstat: () => ({ then() {} }) })), "CRED_ADAPTER_INVALID", "CLOSED");
});

test("C10 bounded read: one-byte partials, exact max boundary, early EOF, growth/truncation, invalid counts; owned buffer only; zero-filled on every exit", async () => {
  const one = fake({ chunk: 1 }); assert.equal((await run(one)).ok, true); assert.equal(count(one.log, "read"), body({ hostawayToken: TOK }).length + 1); assert.ok(zeroed(one.bufs));
  // exact max: 4096-byte file accepted; offsets handed to read are the exact progress
  const pad = "x".repeat(4096 - JSON.stringify({ hostawayToken: "" }).length);
  const max = body({ hostawayToken: pad }); assert.equal(max.length, 4096);
  const fm = fake({ content: max, chunk: 1000 }); const rm = await run(fm); assert.equal(rm.ok, true); assert.equal(rm.credentials.hostawayToken, pad); assert.ok(zeroed(fm.bufs));
  // growth probe: a file that yields 4097 bytes while stats claim 4096 → CRED_SIZE
  const big = new Uint8Array(4097).fill(0x20);
  const fg = fake({ content: big, stat: { size: 4096 } }); assertPublicFailure(await run(fg), "CRED_SIZE", "CLOSED"); assert.ok(zeroed(fg.bufs));
  // within-bound growth / truncation / zero-early-EOF → CRED_CHANGED
  const c = body({ hostawayToken: TOK });
  assertPublicFailure(await run(fake({ stat: { size: c.length - 3 } })), "CRED_CHANGED", "CLOSED");
  assertPublicFailure(await run(fake({ stat: { size: c.length + 3 } })), "CRED_CHANGED", "CLOSED");
  assertPublicFailure(await run(fake({ read: () => Promise.resolve(0) })), "CRED_CHANGED", "CLOSED");
  // invalid byte counts / rejections / non-native → refusal, still closed once, zeroed
  for (const v of [-1, 1.5, NaN, "3", 3n, null, CRED.READ_BUFFER_BYTES + 1]) {
    const f = fake({ read: () => Promise.resolve(v) }); assertPublicFailure(await run(f), "CRED_IO", "CLOSED"); assert.equal(count(f.log, "close"), 1); assert.ok(zeroed(f.bufs));
  }
  const over = fake({ read: ({ reads, len }) => Promise.resolve(reads === 1 ? 5 : len + 1) }); assertPublicFailure(await run(over), "CRED_IO", "CLOSED");   // beyond remaining length
  assertPublicFailure(await run(fake({ read: () => Promise.reject(new Error(TOK)) })), "CRED_IO", "CLOSED");
  assertPublicFailure(await run(fake({ read: () => ({ then(r) { r(1); } }) })), "CRED_ADAPTER_INVALID", "CLOSED");
  // read args: exactly (owned buffer, offset, remaining), same buffer instance; arbitrary returned buffers ignored
  const seen = [];
  const fa = fake({ read: ({ buf, off, len, rest, content }) => { seen.push([buf, off, len, rest.length]); if (off >= content.length) return Promise.resolve(0); buf.set(content.subarray(off, off + 7), off); return Promise.resolve(Math.min(7, content.length - off)); } });
  assert.equal((await run(fa)).ok, true);
  for (const [b, off, len, extra] of seen) { assert.equal(b, seen[0][0]); assert.equal(len, CRED.READ_BUFFER_BYTES - off); assert.equal(extra, 0); }
  assert.deepEqual(seen.map((s) => s[1]).slice(0, 3), [0, 7, 14]);
  const ignore = fake({ read: ({ buf, off, content, reads }) => { if (reads > 1) return Promise.resolve(0); buf.set(content, off); return Promise.resolve({ bytesRead: content.length, buffer: new Uint8Array(9) }); } });
  assertPublicFailure(await run(ignore), "CRED_IO", "CLOSED");
  // MAX_READ_CALLS exhaustion is UNREACHABLE: every non-final call adds ≥1 byte, so ≤ 4097 progress calls + 1 EOF call (invariant, not manufactured)
  assert.equal(CRED.MAX_READ_CALLS, CRED.READ_BUFFER_BYTES + 1);
});

test("C11/C12 s2 and full post-read PATH lstat: policy, identity, absence → refusal; closed once", async () => {
  assertPublicFailure(await run(fake({ fstat: (n, st) => Promise.resolve(n === 2 ? st({ ctimeNs: "9" }) : st()) })), "CRED_CHANGED", "CLOSED");
  assertPublicFailure(await run(fake({ fstat: (n, st) => Promise.resolve(n === 2 ? st({ nlink: 2, ctimeNs: "9" }) : st()) })), "CRED_LINKS", "CLOSED");
  assertPublicFailure(await run(fake({ fstat: (n, st) => n === 2 ? Promise.reject(new Error()) : Promise.resolve(st()) })), "CRED_IO", "CLOSED");
  const post = (fn) => fake({ pathStat: (n, st) => (n === 2 ? fn(st) : Promise.resolve(st())) });
  assertPublicFailure(await run(post(() => Promise.reject(enoent()))), "CRED_CHANGED", "CLOSED");                     // renamed away
  assertPublicFailure(await run(post((st) => Promise.resolve(st({ ino: "777" })))), "CRED_CHANGED", "CLOSED");          // replaced path
  assertPublicFailure(await run(post((st) => Promise.resolve(st({ mtimeNs: "9" })))), "CRED_CHANGED", "CLOSED");
  assertPublicFailure(await run(post((st) => Promise.resolve(st({ kind: "symlink", ino: "777" })))), "CRED_NOT_REGULAR", "CLOSED");   // policy beats identity
  assertPublicFailure(await run(post((st) => Promise.resolve(st({ mode: 0o100666 })))), "CRED_MODE", "CLOSED");
  assertPublicFailure(await run(post(() => Promise.reject(Object.assign(new Error(), { code: "EACCES" })))), "CRED_IO", "CLOSED");
  assertPublicFailure(await run(post(() => Promise.resolve({ ...baseStat(1), extra: 1 }))), "CRED_ADAPTER_INVALID", "CLOSED");
  const f = post((st) => Promise.resolve(st({ ino: "777" }))); await run(f);
  assert.deepEqual(f.log.slice(-3), ["fstat", `lstat ${PATH}`, "close"]);
});

test("C13 close: exactly once, never retried, only after the last owned op settled; failure withholds success; primary refusal preserved", async () => {
  for (const close of [() => Promise.reject(new Error(TOK)), () => { throw new Error(); }, () => ({ then(r) { r(); } }), () => undefined]) {
    const f = fake({ close }); const r = await run(f);
    assertPublicFailure(r, "CRED_CLOSE_FAILED", "CLOSE_FAILED"); assert.equal(count(f.log, "close"), 1); assert.ok(zeroed(f.bufs));
    assert.ok(!("credentials" in r));
  }
  assertPublicFailure(await run(fake({ close: () => Promise.reject(new Error()), stat: { size: 3 } })), "CRED_CHANGED", "CLOSE_FAILED");     // primary refusal kept
  assertPublicFailure(await run(fake({ close: () => Promise.reject(new Error()), handle: (h) => ({ ...h, x: 1 }) })), "CRED_ADAPTER_INVALID", "CLOSE_FAILED");
  // ordering: close is not called while a read is still pending
  let releaseRead; const order = [];
  const f = fake({ read: ({ buf, off, content, reads }) => { if (reads === 1) return new Promise((res) => { releaseRead = () => { buf.set(content, off); order.push("read-settled"); res(content.length); }; }); return Promise.resolve(0); },
    close: () => { order.push("close"); return Promise.resolve(); } });
  const p = run(f); await new Promise((r) => setImmediate(r));
  assert.equal(count(f.log, "close"), 0); releaseRead();
  assert.equal((await p).ok, true); assert.deepEqual(order, ["read-settled", "close"]);
});

test("C13b R-C1A close acknowledgment schema: ONLY a native fulfilment with exactly undefined counts as CLOSED", async () => {
  // valid control
  const okF = fake({ close: () => Promise.resolve(undefined) }); const okR = await run(okF);
  assert.equal(okR.ok, true); assert.equal(okR.closeState, "CLOSED"); assert.equal(count(okF.log, "close"), 1);
  // malformed fulfilled close replies: never an acknowledged close, never a released secret, close attempted exactly once
  const malformed = [false, null, 0, 17, NaN, "", "ok", "undefined", {}, { status: "not-acknowledged" }, [], () => {}, Symbol("ack"), 0n];
  for (const v of malformed) {
    const f = fake({ close: () => Promise.resolve(v) }); const r = await run(f);
    assertPublicFailure(r, "CRED_CLOSE_FAILED", "CLOSE_FAILED"); assert.ok(!("credentials" in r), String(typeof v));
    assert.equal(count(f.log, "close"), 1); assert.ok(zeroed(f.bufs));
  }
  // prior refusal keeps primary; malformed close only changes closeState
  for (const v of [false, 17, { status: "not-acknowledged" }]) {
    const f = fake({ close: () => Promise.resolve(v), stat: { size: 3 } });
    assertPublicFailure(await run(f), "CRED_CHANGED", "CLOSE_FAILED"); assert.equal(count(f.log, "close"), 1);
    const g = fake({ close: () => Promise.resolve(v), handle: (h) => ({ ...h, x: 1 }) });
    assertPublicFailure(await run(g), "CRED_ADAPTER_INVALID", "CLOSE_FAILED"); assert.equal(count(g.log, "close"), 1);
  }
  // with a prior refusal, a valid undefined close still reports CLOSED
  assertPublicFailure(await run(fake({ close: () => Promise.resolve(undefined), stat: { size: 3 } })), "CRED_CHANGED", "CLOSED");
});

test("C14 strict object-of-strings JSON: fatal UTF-8, BOM, duplicates incl. escaped aliases, __proto__/toJSON, type confusion, live/restricted keys", async () => {
  const S = (s) => enc(s);
  const cases = [
    [new Uint8Array([0x7b, 0xff, 0x7d]), "CRED_PARSE"], [S("\uFEFF{\"hostawayToken\":\"t\"}"), "CRED_PARSE"], [S("[\"t\"]"), "CRED_PARSE"], [S("\"t\""), "CRED_PARSE"],
    [S("{\"hostawayToken\":\"t\"} x"), "CRED_PARSE"], [S("{\"hostawayToken\":\"t\",}"), "CRED_PARSE"], [S("{hostawayToken:\"t\"}"), "CRED_PARSE"], [S("{\"hostawayToken\":\"t\""), "CRED_PARSE"],
    [S("{\"hostawayToken\":\"t\\x\"}"), "CRED_PARSE"], [S("{\"hostawayToken\":\"t\\u12\"}"), "CRED_PARSE"], [S("{\"hostawayToken\":\"a\tb\"}"), "CRED_PARSE"], [S("{\"hostawayToken\":"), "CRED_PARSE"],
    [S("{}"), "CRED_SHAPE"], [S("{\"hostawayToken\":1}"), "CRED_SHAPE"], [S("{\"hostawayToken\":true}"), "CRED_SHAPE"], [S("{\"hostawayToken\":null}"), "CRED_SHAPE"],
    [S("{\"hostawayToken\":[\"t\"]}"), "CRED_SHAPE"], [S("{\"hostawayToken\":{\"a\":\"t\"}}"), "CRED_SHAPE"], [S("{\"hostawayToken\":\"t\",\"x\":\"y\"}"), "CRED_SHAPE"],
    [S("{\"hostawayToken\":\"t\",\"hostawayToken\":\"u\"}"), "CRED_SHAPE"], [S("{\"hostaway\\u0054oken\":\"t\",\"hostawayToken\":\"u\"}"), "CRED_SHAPE"],
    [S("{\"hostawayToken\":\"t\",\"__proto__\":\"x\"}"), "CRED_SHAPE"], [S("{\"__proto__\":{\"hostawayToken\":\"t\"}}"), "CRED_SHAPE"], [S("{\"hostawayToken\":\"t\",\"toJSON\":\"x\"}"), "CRED_SHAPE"],
    [S("{\"hostawayToken\":\"\"}"), "CRED_SHAPE"], [S("{\"hostawayToken\":\"a b\"}"), "CRED_SHAPE"], [S("{\"hostawayToken\":\"\\u00e9\"}"), "CRED_SHAPE"], [S("{\"stripeTestKey\":\"sk_test_A1\"}"), "CRED_SHAPE"]
  ];
  for (const [content, code] of cases) { const f = fake({ content }); assertPublicFailure(await run(f), code, "CLOSED"); assert.ok(zeroed(f.bufs)); }
  const ST = { hostaway: false, stripe: true };
  for (const k of ["sk_live_Fake1", "rk_test_Fake1", "rk_live_Fake1", "pk_test_SENTINEL1", "sk_test_", "sk_test_a-b", `sk_test_${"a".repeat(248)}`, "SK_TEST_a1"])
    assertPublicFailure(await run(fake({ content: body({ stripeTestKey: k }) }), ST), "CRED_KEY_NOT_TEST", "CLOSED");
  assertPublicFailure(await run(fake({ content: body({ stripeTestKey: KEY }) }), { hostaway: true, stripe: true }), "CRED_SHAPE", "CLOSED");       // missing needed key
  assertPublicFailure(await run(fake({ content: body({ hostawayToken: TOK, stripeTestKey: KEY }) }), NEED_H), "CRED_SHAPE", "CLOSED");             // unneeded key
  // positives: whitespace, escapes, max key length, order independence
  const ok1 = await run(fake({ content: S(" \n{ \"stripeTestKey\" : \"sk_test_A\\u0031\" ,\r\n\t\"hostawayToken\":\"t\\/\\\\\\\"x\" }\n") }), { hostaway: true, stripe: true });
  assert.equal(ok1.ok, true); assert.equal(ok1.credentials.stripeTestKey, "sk_test_A1"); assert.equal(ok1.credentials.hostawayToken, "t/\\\"x");
  assert.equal((await run(fake({ content: body({ stripeTestKey: `sk_test_${"a".repeat(247)}` }) }), ST)).ok, true);
});

test("C15 hostile promise shapes on every adapter boundary are refused without assimilation; the loader never rejects", async () => {
  let touched = 0;
  const own = () => { const p = Promise.resolve(baseStat(25)); Object.defineProperty(p, "then", { value: () => { touched++; } }); return p; };
  const regSym = () => { const p = Promise.resolve(baseStat(25)); p[Symbol.for("x")] = 1; return p; };
  const wellKnown = () => { const p = Promise.resolve(baseStat(25)); p[Symbol.toStringTag] = "x"; return p; };
  for (const mk of [own, regSym, wellKnown]) {
    assertPublicFailure(await run(fake({ pathStat: () => mk() })), "CRED_ADAPTER_INVALID", "NOT_OPENED");
    assertPublicFailure(await run(fake({ fstat: () => mk() })), "CRED_ADAPTER_INVALID", "CLOSED");
  }
  assert.equal(touched, 0);
  // unregistered-symbol data props (async_hooks style) on a native promise are tolerated
  const asyncHooks = () => { const p = Promise.resolve(baseStat(body({ hostawayToken: TOK }).length)); p[Symbol("async_id")] = 1; return p; };
  assert.equal((await run(fake({ pathStat: asyncHooks }))).ok, true);
  // never rejects, even with an input whose introspection throws
  const r = await readProbeCredentialFile(revoked()); assertPublicFailure(r, "CRED_INPUT_INVALID", "NOT_OPENED");
});

test("C17 hanging injected fs: the promise stays PENDING (no timer, retry or fallback — finite operation bounds only, no elapsed bound)", async () => {
  for (const hook of [{ realpath: () => new Promise(() => {}) }, { read: () => new Promise(() => {}) }, { close: () => new Promise(() => {}) }]) {
    const f = fake(hook); let settled = false; run(f).then(() => { settled = true; });
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    assert.equal(settled, false);
    if (hook.read) assert.equal(count(f.log, "close"), 0);                    // close is not issued while the owned read is unsettled
  }
});

test("C16 sentinels absent from every public output; exported constants frozen and exact", () => {
  assert.equal(unhandled.length, 0);
  assert.ok(Object.isFrozen(CRED.CREDENTIAL_CODES) && Object.isFrozen(CRED.CLOSE_STATES) && Object.isFrozen(CRED.STAT_KEYS) && Object.isFrozen(ENV.ENV_CODES) && Object.isFrozen(ENV.PRESENT_KEYS));
  assert.equal(CRED.READ_BUFFER_BYTES, 4097); assert.equal(CRED.MAX_CREDENTIAL_BYTES, 4096); assert.equal(CRED.OPEN_KIND, "credential-read");
  assert.deepEqual([...CRED.STAT_KEYS], ["dev", "ino", "kind", "mode", "nlink", "size", "uid", "mtimeNs", "ctimeNs"]);
  assert.equal(ENV.PRESENT_KEYS.length, 14);
});

test("PIN containment: both modules import ONLY node:util; no process/env/fs/timers/console/network/dynamic import; no F/P/T/X; no pinned adapter name", () => {
  for (const f of ["scripts/e7-connected/probe-env-preflight.mjs", "scripts/e7-connected/probe-credential-file.mjs"]) {
    const src = readFileSync(join(ROOT, f), "utf8");
    assert.deepEqual(src.match(/^import .*$/gm), ["import { types } from \"node:util\";"], f);
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const re of [/\bprocess\b/, /\brequire\s*\(/, /\bimport\s*\(/, /node:fs/, /\bfetch\b/, /setTimeout|setInterval|setImmediate|queueMicrotask/, /\bconsole\b/, /\bDate\b/, /\beval\b|\bFunction\s*\(/,
      /https?:/, /\bJSON\.parse\b/, /\bexport\s+default\b/])
      assert.doesNotMatch(code, re, `${f} ${re}`);
    assert.ok(!src.includes("hostaway-" + "reservations"), f);
    for (const dep of ["run-journal-file", "readonly-probe", "http-transports", "real-exchange", "booking-db", "lib/"]) assert.ok(!src.includes(dep), `${f} ${dep}`);
  }
});
