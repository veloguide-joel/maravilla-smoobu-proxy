// H1 (root ruling P-B + F-A): guided hidden-entry credential-file helper. SYNTHETIC values only (canaries), temp dirs outside the repo,
// fake TTYs. No network, DB, provider or owner file. Real accepted readers are exercised through the helper's round-trip.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, existsSync, symlinkSync, chmodSync, readdirSync, unlinkSync, realpathSync } from "node:fs";
import * as realFs from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readHiddenLine } from "../scripts/e4-transport/credential-prompt.mjs";
import * as H from "../scripts/e7-connected/e7-fill-credential-file.mjs";
import { createNativeAdapters } from "../scripts/e7-connected/probe-cli-main.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CANARY_PW = "Pw@:/?#%[] ö€😀'\"\\%41-CANARY";
const CANARY_TOK = "tok\"\\{CANARY}" + "x".repeat(40);
const CANARY_KEY = "sk_test_CANARY" + "A".repeat(20);
const sha = (b) => createHash("sha256").update(b).digest("hex");
const tick = () => new Promise((r) => setImmediate(r));

/** fake TTY: answers are fed one per 'data' listener attachment (each prompt), as Buffers or strings; records raw-mode history */
function fakeTty(answers = []) {
  const t = new EventEmitter(); t.isTTY = true; t.raw = []; t.paused = 0; t.queue = [...answers];
  t.setRawMode = (v) => { t.raw.push(v); return t; };
  t.pause = () => { t.paused++; }; t.resume = () => {};
  t.on("newListener", (ev) => { if (ev === "data" && t.queue.length) { const next = t.queue.shift(); setImmediate(() => { if (next && next.event) { t.emit(next.event); return; } for (const c of [].concat(next)) t.emit("data", c); }); } });
  return t;
}
const sink = () => { const s = { text: "", write(x) { s.text += String(x); return true; } }; return s; };
function freshDir() { const d = realpathSync(mkdtempSync(join(tmpdir(), "h1-"))); chmodSync(d, 0o700); return d; }
const uid = process.getuid();
async function fill(kind, path, answers, extra = {}) {
  const tty = extra.tty ?? fakeTty(answers); const err = sink(); const signals = extra.signals ?? new EventEmitter();
  const r = await H.runFill({ argv: [kind, path], stdin: tty, stderr: err, platform: "linux", uid, signals, repoRoot: ROOT, ...extra.over });
  return { r, tty, err, signals, out: JSON.parse(r.line) };
}
// values only: fixed prompt LABELS legitimately name the expected key prefix ("sk_test_..."), so the check looks for canary values / URL text
function noLeak(...texts) { for (const t of texts) for (const c of ["CANARY", "postgresql://", "mv_booking_app_dev:", "tok\"", "AAAAAAAAAA"]) assert.equal(t.includes(c), false, `leaked ${c}`); }
const enter = (s) => `${s}\r`;

// ---------------------------------------------------------------------------------------------------------------- prompt reader
test("H1 P-B parity: H1 reader == accepted E4 readHiddenLine on the shared subset (ASCII, escapes, backspace, CR/LF, leading skip, Ctrl-C/D, 512)", async () => {
  const seqs = [["abc\r"], ["a\x1b[200~bc\x1b[201~d\r"], ["ab\x7fc\bd\r"], ["\r\nxyz\n"], ["x\x1bOPy\x1b[1;5Cz\r"], ["ab\x03"], ["\x04"], ["a\tb\x01c\r"],
    ["q".repeat(512) + "\r"], ["q".repeat(513) + "\r"], ["ab", "c\r"]];
  for (const skip of [false, true]) for (const seq of seqs) {
    const run = async (fn, extra) => { const t = fakeTty([seq]); try { return { v: await fn({ input: t, output: sink(), label: "L", skipLeadingTerminators: skip, ...extra }) }; } catch (e) { return { e: e.code }; } };
    const a = await run(readHiddenLine, {}); const b = await run(H.readHiddenLineH1, { maxLength: 512 });
    assert.deepEqual(b, a, `${JSON.stringify(seq)} skip=${skip}`);
  }
});

test("H1 reader: EOF / close / error / AbortSignal → ABORTED; own listeners removed, foreign kept, raw mode restored; setup failure contained", async () => {
  for (const ev of ["end", "close", "error"]) {
    const t = fakeTty(); const foreign = () => {}; t.on("data", foreign);
    const p = H.readHiddenLineH1({ input: t, output: sink(), label: "L", maxLength: 8 });
    await tick(); t.emit(ev, new Error("synthetic"));
    await assert.rejects(p, (e) => e.code === "ABORTED");
    assert.deepEqual(t.raw, [true, false]); assert.deepEqual(t.listeners("data"), [foreign]);
    for (const x of ["end", "close", "error"]) assert.equal(t.listenerCount(x), 0);
  }
  const ac = new AbortController(); const t = fakeTty();
  const p = H.readHiddenLineH1({ input: t, output: sink(), label: "L", maxLength: 8, signal: ac.signal });
  await tick(); ac.abort();
  await assert.rejects(p, (e) => e.code === "ABORTED"); assert.deepEqual(t.raw, [true, false]); assert.equal(t.listenerCount("data"), 0);
  const pre = new AbortController(); pre.abort();
  await assert.rejects(H.readHiddenLineH1({ input: fakeTty(), output: sink(), label: "L", maxLength: 8, signal: pre.signal }), (e) => e.code === "ABORTED");
  const bad = fakeTty(); bad.setRawMode = () => { throw new Error("tty"); };
  await assert.rejects(H.readHiddenLineH1({ input: bad, output: sink(), label: "L", maxLength: 8 }), (e) => e.code === "TTY_SETUP_FAILED");
  for (const x of ["data", "end", "close", "error"]) assert.equal(bad.listenerCount(x), 0);
  await assert.rejects(H.readHiddenLineH1({ input: { isTTY: false }, output: sink(), label: "L", maxLength: 8 }), (e) => e.code === "TTY_REQUIRED");
});

test("H1 reader: per-prompt maxLength (4096 ok / 4097 too long), split 2/3/4-byte UTF-8 across chunks, oversize chunk refused", async () => {
  const rd = (chunks, maxLength) => H.readHiddenLineH1({ input: fakeTty([chunks]), output: sink(), label: "L", maxLength });
  assert.equal((await rd(["t".repeat(4096) + "\r"], 4096)).length, 4096);
  await assert.rejects(rd(["t".repeat(4097) + "\r"], 4096), (e) => e.code === "INPUT_TOO_LONG");
  for (const ch of ["ö", "€", "😀"]) {
    const b = Buffer.from(`a${ch}b\r`, "utf8");
    for (let cut = 1; cut < b.length - 1; cut++) assert.equal(await rd([b.subarray(0, cut), b.subarray(cut)], 64), `a${ch}b`, `${ch} cut ${cut}`);
  }
  await assert.rejects(rd([Buffer.alloc(65_537, 0x61)], 100_000), (e) => e.code === "INPUT_TOO_LONG");
});

// ---------------------------------------------------------------------------------------------------------------- builders
test("H1 builders: percent-encoded app login decodes exactly; fixed direct endpoint; provider shapes; refusals", () => {
  for (const pw of [CANARY_PW, "%41", "a b", "@@::", "'()*!~", "x".repeat(512)]) {
    const b = H.buildAppLogin(pw); assert.equal(b.ok, true, pw);
    const o = JSON.parse(b.bytes.toString("utf8")); const u = new URL(o.connectionString);
    assert.deepEqual([o.schema, o.role, u.username, u.hostname, u.port, u.pathname, u.search, u.hash], ["e7-db-login-v1", "mv_booking_app", "mv_booking_app_dev", H.DIRECT.host, "5432", "/postgres", "", ""]);
    assert.equal(decodeURIComponent(u.password), pw); assert.match(o.connectionString, /^[\x21-\x7e]+$/);
  }
  for (const pw of ["", "x".repeat(513), "\ud800", 7]) assert.equal(H.buildAppLogin(pw).ok, false);
  assert.equal(H.buildProvider(CANARY_TOK, CANARY_KEY).ok, true);
  for (const k of ["sk_live_abc", "rk_test_abc", "sk_test_", "sk_test_a-b"]) assert.equal(H.buildProvider(CANARY_TOK, k).code, "KEY_NOT_TEST");
  assert.equal(H.buildProvider("has space", CANARY_KEY).code, "ENTRY_INVALID");
  assert.equal(H.buildProvider("t".repeat(4096), CANARY_KEY).code, "TOO_LARGE", "the 4096-byte FILE cap binds before the token cap");
});

// ---------------------------------------------------------------------------------------------------------------- end-to-end
test("H1 end-to-end app-login + provider: CREATED_VALIDATED via the ACCEPTED readers; 0600; exact bytes; codes-only output; raw mode restored", async () => {
  const d = freshDir();
  const a = await fill("app-login", join(d, "app.login.json"), [enter(CANARY_PW), enter(CANARY_PW)]);
  assert.deepEqual([a.r.exit, a.out], [0, { schema: H.SCHEMA, kind: "app-login", code: "CREATED_VALIDATED" }]);
  const st = statSync(join(d, "app.login.json")); assert.equal(st.mode & 0o777, 0o600); assert.equal(st.nlink, 1);
  assert.deepEqual(readFileSync(join(d, "app.login.json")), H.buildAppLogin(CANARY_PW).bytes);
  assert.equal(a.tty.raw.at(-1), false); assert.equal(a.signals.listenerCount("SIGINT") + a.signals.listenerCount("SIGTERM") + a.signals.listenerCount("SIGHUP"), 0);
  noLeak(a.r.line, a.err.text); assert.ok(a.err.text.includes(H.LABELS.pw1) && a.err.text.includes("REUSE"));
  const p = await fill("provider", join(d, "provider.json"), [enter(CANARY_TOK), enter(CANARY_TOK), enter(CANARY_KEY), enter(CANARY_KEY)]);
  assert.deepEqual([p.r.exit, p.out.code], [0, "CREATED_VALIDATED"]); noLeak(p.r.line, p.err.text);
});

test("H1 refusals BEFORE any write: usage, platform, non-TTY, existing (incl. a report file, byte/mtime identical), symlink, unsafe / symlinked parent, in repo, .git ancestor", async () => {
  const d = freshDir(); const report = join(d, "report.login.json"); writeFileSync(report, "PRE-EXISTING-REPORT", { mode: 0o600 });
  const before = [sha(readFileSync(report)), statSync(report).mtimeMs];
  const usage = [[], ["report", join(d, "x")], ["app-login"], ["app-login", "rel/x"], ["app-login", join(d, "x"), "extra"]];
  for (const argv of usage) { const r = await H.runFill({ argv, stdin: fakeTty(), stderr: sink(), platform: "linux", uid, signals: new EventEmitter(), repoRoot: ROOT }); assert.equal(JSON.parse(r.line).code, argv.length === 2 && H.KINDS.includes(argv[0]) ? "PATH_INVALID" : "USAGE", JSON.stringify(argv)); }
  assert.equal((await fill("app-login", join(d, "w"), [], { over: { platform: "win32" } })).out.code, "PLATFORM_UNSUPPORTED");
  assert.equal((await fill("app-login", join(d, "n"), [], { tty: { isTTY: false } })).out.code, "TTY_REQUIRED");
  assert.equal((await fill("app-login", report, [enter("would-be"), enter("would-be")])).out.code, "EXISTS");
  symlinkSync(join(d, "nowhere"), join(d, "link")); assert.equal((await fill("app-login", join(d, "link"), [enter("would-be"), enter("would-be")])).out.code, "SYMLINK");
  const gw = join(d, "gw"); mkdirSync(gw); chmodSync(gw, 0o770); assert.equal((await fill("app-login", join(gw, "f"), [enter("would-be"), enter("would-be")])).out.code, "PARENT_UNSAFE");
  const real = join(d, "real"); mkdirSync(real, { mode: 0o700 }); symlinkSync(real, join(d, "alias")); assert.equal((await fill("app-login", join(d, "alias", "f"), [enter("would-be"), enter("would-be")])).out.code, "PARENT_UNSAFE");
  mkdirSync(join(real, "inner"), { mode: 0o700 });                                    // symlink ABOVE the parent: lstat(parent) is a dir, realpath differs
  assert.equal((await fill("app-login", join(d, "alias", "inner", "f"), [enter("would-be"), enter("would-be")])).out.code, "PARENT_UNSAFE");
  const inRepo = join(ROOT, ".h1-test-dir"); mkdirSync(inRepo, { mode: 0o700, recursive: true });
  try { assert.equal((await fill("app-login", join(inRepo, "f"), [enter("would-be"), enter("would-be")])).out.code, "IN_REPO"); } finally { realFs.rmdirSync(inRepo); }
  const g = join(d, "g"); mkdirSync(join(g, ".git"), { recursive: true }); mkdirSync(join(g, "sub"), { mode: 0o700 }); chmodSync(g, 0o700);
  assert.equal((await fill("app-login", join(g, "sub", "f"), [enter("would-be"), enter("would-be")])).out.code, "IN_GIT_TREE");
  assert.deepEqual([sha(readFileSync(report)), statSync(report).mtimeMs], before, "existing report file byte- and mtime-identical");
  assert.deepEqual(readdirSync(d).sort(), ["alias", "g", "gw", "link", "real", "report.login.json"]);
});

test("H1 entry failures create NOTHING: mismatch, Ctrl-C, EOF, live key, signal during a prompt", async () => {
  const d = freshDir(); const t = join(d, "f");
  assert.equal((await fill("app-login", t, [enter("one"), enter("two")])).out.code, "ENTRY_MISMATCH");
  assert.equal((await fill("app-login", t, [enter("one"), "\x03"])).out.code, "ABORTED");
  assert.equal((await fill("app-login", t, [enter("one"), { event: "end" }])).out.code, "ABORTED", "EOF at the confirm prompt");
  assert.equal((await fill("provider", t, [enter(CANARY_TOK), enter(CANARY_TOK), enter("sk_live_X"), enter("sk_live_X")])).out.code, "KEY_NOT_TEST");
  const sig = new EventEmitter(); const pending = fill("app-login", t, [], { signals: sig, tty: fakeTty() });
  await tick(); sig.emit("SIGTERM"); const s = await pending; assert.equal(s.out.code, "ABORTED"); assert.equal(s.tty.raw.at(-1), false);
  assert.equal(existsSync(t), false); assert.deepEqual(readdirSync(d), []);
});

test("H1 ownership: fstat failure → LEFT_IN_PLACE (no unlink); write fault first/mid/last → REMOVED; inode swap → LEFT_IN_PLACE, foreign file untouched", async () => {
  const d = freshDir(); const ans = () => [enter(CANARY_PW), enter(CANARY_PW)];
  const fsWith = (o) => ({ ...realFs, constants: realFs.constants, ...o });
  let r = await fill("app-login", join(d, "a"), ans(), { over: { fs: fsWith({ fstatSync: () => { throw new Error("fstat"); } }) } });
  assert.equal(r.out.code, "OWNERSHIP_UNPROVEN_LEFT_IN_PLACE"); assert.equal(existsSync(join(d, "a")), true, "never unlinked without identity");
  for (const failAt of [0, 1, 2]) {
    let n = 0; const p = join(d, `w${failAt}`);
    const writeSync = (fd, b, off, len) => { if (n++ === failAt) throw new Error("write"); return realFs.writeSync(fd, b, off, Math.min(len, 16)); };
    r = await fill("app-login", p, ans(), { over: { fs: fsWith({ writeSync }) } });
    assert.equal(r.out.code, "WRITE_FAILED_REMOVED", `failAt ${failAt}`); assert.equal(existsSync(p), false);
  }
  const p = join(d, "swap");
  const writeSync = () => { unlinkSync(p); writeFileSync(p, "FOREIGN", { mode: 0o600 }); throw new Error("write"); };
  r = await fill("app-login", p, ans(), { over: { fs: fsWith({ writeSync }) } });
  assert.equal(r.out.code, "WRITE_FAILED_LEFT_IN_PLACE"); assert.equal(readFileSync(p, "utf8"), "FOREIGN");
  r = await fill("app-login", join(d, "fs"), ans(), { over: { fs: fsWith({ fsyncSync: () => { throw new Error("fsync"); } }) } });
  assert.equal(r.out.code, "WRITE_FAILED_REMOVED"); assert.equal(existsSync(join(d, "fs")), false);
});

test("H1 after create: round-trip failure → REMOVED; signal before round-trip / during it → ABORTED_REMOVED; nothing left", async () => {
  const d = freshDir(); const ans = () => [enter(CANARY_PW), enter(CANARY_PW)];
  const badFs = () => ({ credentialFs: { platform: "linux", uid, lstat: async () => { throw new Error("x"); }, realpath: async (p) => p, open: async () => { throw new Error("x"); } } });
  let r = await fill("app-login", join(d, "rt"), ans(), { over: { adapters: badFs } });
  assert.equal(r.out.code, "ROUNDTRIP_FAILED_REMOVED"); assert.equal(existsSync(join(d, "rt")), false);
  const sig = new EventEmitter();
  r = await fill("app-login", join(d, "s1"), ans(), { signals: sig, over: { adapters: (o) => { sig.emit("SIGINT"); return createNativeAdapters(o); } } });
  assert.equal(r.out.code, "ABORTED_REMOVED"); assert.equal(existsSync(join(d, "s1")), false);
  // a signal DURING the synchronous block (here: inside closeSync) is only flagged; it is honoured right AFTER the block, BEFORE any reader
  const sig2 = new EventEmitter(); let adapterCalls = 0;
  const closeSync = (fd) => { realFs.closeSync(fd); sig2.emit("SIGTERM"); };
  r = await fill("app-login", join(d, "s2"), ans(), { signals: sig2, over: { fs: { ...realFs, constants: realFs.constants, closeSync }, adapters: (o) => { adapterCalls++; return createNativeAdapters(o); } } });
  assert.equal(r.out.code, "ABORTED_REMOVED"); assert.equal(adapterCalls, 0, "no reader round-trip after a signal"); assert.equal(existsSync(join(d, "s2")), false);
  assert.deepEqual(readdirSync(d), []);
});

test("H1 network tripwires (child process): ZERO net / tls / http(s) / dns / fetch invocations on a full success; no pg module loaded", () => {
  const script = `
    import { syncBuiltinESMExports, createRequire } from "node:module";
    import net from "node:net"; import tls from "node:tls"; import http from "node:http"; import https from "node:https"; import dns from "node:dns";
    import { EventEmitter } from "node:events"; import { mkdtempSync, realpathSync, chmodSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
    let calls = 0; const trip = (o, k) => { const f = o[k]; if (typeof f === "function") o[k] = function (...a) { calls++; return f.apply(this, a); }; };
    for (const k of ["connect", "createConnection"]) trip(net, k); trip(net.Socket.prototype, "connect"); trip(tls, "connect");
    for (const m of [http, https]) for (const k of ["request", "get"]) trip(m, k);
    for (const k of Object.keys(dns)) if (/^(lookup|resolve)/.test(k)) trip(dns, k); for (const k of Object.keys(dns.promises)) if (/^(lookup|resolve)/.test(k)) trip(dns.promises, k);
    if (typeof globalThis.fetch === "function") { const f = globalThis.fetch; globalThis.fetch = (...a) => { calls++; return f(...a); }; }
    syncBuiltinESMExports();
    const H = await import(${JSON.stringify(join(ROOT, "scripts/e7-connected/e7-fill-credential-file.mjs"))});
    const d = realpathSync(mkdtempSync(join(tmpdir(), "h1c-"))); chmodSync(d, 0o700);
    const t = new EventEmitter(); t.isTTY = true; t.setRawMode = () => t; t.pause = () => {}; t.resume = () => {}; const q = ["PwCANARY\\r", "PwCANARY\\r"];
    t.on("newListener", (ev) => { if (ev === "data" && q.length) { const n = q.shift(); setImmediate(() => t.emit("data", Buffer.from(n))); } });
    const r = await H.runFill({ argv: ["app-login", join(d, "app.json")], stdin: t, stderr: { write() { return true; } }, platform: process.platform, uid: process.getuid(), signals: new EventEmitter(), repoRoot: ${JSON.stringify(ROOT)} });
    const cache = Object.keys(createRequire(import.meta.url).cache);
    process.stdout.write(JSON.stringify({ code: JSON.parse(r.line).code, calls, pg: cache.filter((k) => /[\\\\/]node_modules[\\\\/]pg/.test(k)).length }));`;
  const c = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", cwd: ROOT });
  assert.equal(c.status, 0, c.stderr);
  assert.deepEqual(JSON.parse(c.stdout), { code: "CREATED_VALIDATED", calls: 0, pg: 0 });
});

test("H1 scope pins: reused prompt / readers / adapter module byte-unchanged; helper is outside the native closure", async () => {
  const pins = { "scripts/e4-transport/credential-prompt.mjs": "0a39d7e3810984841e93a0965fe0985a43beb71c18ba878bd696440d4d5c9207",
    "scripts/e7-connected/probe-cli-main.mjs": "1d358a1a865d9149e91c29189bc32cbb5e85c2de2958b105f3667d25ee9a530a",
    "scripts/e7-connected/db-credential-file.mjs": "f7f79dbc1b59507893f0bf9e518faf511d1ae8189d47fac94377e3a6fb81643a",
    "scripts/e7-connected/probe-credential-file.mjs": "991d339d2de830bf69c875ff6dddd336564c1e94240781130262607a70a4dfd6",
    "scripts/e7-connected/run-r1-launcher.mjs": "14c6ecbb8a48dca14c4bf2e061d957eead39a8a799735008faef614495b46d81" };
  for (const [rel, h] of Object.entries(pins)) assert.equal(sha(readFileSync(join(ROOT, rel))), h, rel);
  const CLI = await import("../scripts/e7-connected/run-plan-cli-main.mjs");
  assert.equal(CLI.NATIVE_EXEC_SOURCES.includes("scripts/e7-connected/e7-fill-credential-file.mjs"), false);
});

// ------------------------------------------------------------------------- ROOT H1 review: RUN-WIDE input lifecycle (RED on 083c07e8)
const settledWithin = (p, ms) => Promise.race([p.then((v) => ({ v }), (e) => ({ e })), new Promise((r) => setTimeout(() => r("PENDING"), ms))]);
/** stderr sink that runs `hook(label)` synchronously inside the write of the first prompt label */
const hookedErr = (hook) => { const s = { text: "", n: 0, write(x) { s.text += String(x); if (/: $/.test(String(x)) && s.n++ === 0) hook(); return true; } }; return s; };
const runWith = (path, { tty, stderr, signals = new EventEmitter(), over = {} }) =>
  H.runFill({ argv: ["app-login", path], stdin: tty, stderr, platform: "linux", uid, signals, repoRoot: ROOT, ...over });

test("H1 lifecycle: EOF BETWEEN prompts (after the first value settles, before the confirm prompt attaches) → ABORTED, nothing written", async () => {
  const d = freshDir(); const p = join(d, "f"); const tty = fakeTty();
  const err = hookedErr(() => queueMicrotask(() => { tty.emit("data", Buffer.from("synthetic-password\r")); tty.readableEnded = true; tty.emit("end"); }));
  const r = await settledWithin(runWith(p, { tty, stderr: err }), 500);
  assert.notEqual(r, "PENDING", "must not wait forever after EOF");
  assert.equal(JSON.parse(r.v.line).code, "ABORTED"); assert.equal(existsSync(p), false); assert.equal(tty.raw.at(-1), false);
  for (const ev of ["data", "end", "close", "error"]) assert.equal(tty.listenerCount(ev), 0, `${ev} listeners cleaned`);
});

test("H1 lifecycle: an already ended / destroyed / closed stdin → ABORTED before any prompt; no raw mode, no file", async () => {
  for (const k of ["readableEnded", "destroyed", "closed"]) {
    const d = freshDir(); const p = join(d, "f"); const tty = fakeTty([enter("x"), enter("x")]); tty[k] = true; const err = sink();
    const r = await settledWithin(runWith(p, { tty, stderr: err }), 500);
    assert.notEqual(r, "PENDING", k); assert.equal(JSON.parse(r.v.line).code, "ABORTED", k);
    assert.equal(existsSync(p), false, k); assert.equal(err.text, "", `${k}: no prompt shown`); assert.equal(tty.raw.includes(true), false, `${k}: raw mode never enabled`);
  }
});

test("H1 lifecycle: end / abort DURING prompt setup (label write, setRawMode) → ABORTED; raw mode restored; nothing written", async () => {
  const d = freshDir();
  { const tty = fakeTty(); const r = await settledWithin(runWith(join(d, "a"), { tty, stderr: hookedErr(() => tty.emit("end")) }), 500);
    assert.notEqual(r, "PENDING", "end inside label write"); assert.equal(JSON.parse(r.v.line).code, "ABORTED"); assert.equal(tty.raw.includes(true), false, "no raw after end"); }
  { const tty = fakeTty(); const sig = new EventEmitter(); const r = await settledWithin(runWith(join(d, "b"), { tty, signals: sig, stderr: hookedErr(() => sig.emit("SIGTERM")) }), 500);
    assert.notEqual(r, "PENDING", "abort inside label write"); assert.equal(JSON.parse(r.v.line).code, "ABORTED"); assert.equal(tty.raw.includes(true), false, "no raw after abort"); }
  { const tty = fakeTty(); const sig = new EventEmitter(); const setRaw = tty.setRawMode;
    tty.setRawMode = (v) => { setRaw(v); if (v === true) sig.emit("SIGTERM"); return tty; };
    const r = await settledWithin(runWith(join(d, "c"), { tty, signals: sig, stderr: sink() }), 500);
    assert.notEqual(r, "PENDING", "abort inside setRawMode"); assert.equal(JSON.parse(r.v.line).code, "ABORTED"); assert.equal(tty.raw.at(-1), false, "raw restored"); }
  { const tty = fakeTty(); const setRaw = tty.setRawMode; tty.setRawMode = (v) => { setRaw(v); if (v === true) { tty.readableEnded = true; tty.emit("end"); } return tty; };
    const r = await settledWithin(runWith(join(d, "e"), { tty, stderr: sink() }), 500);
    assert.notEqual(r, "PENDING", "end inside setRawMode"); assert.equal(JSON.parse(r.v.line).code, "ABORTED"); assert.equal(tty.raw.at(-1), false); }
  assert.deepEqual(readdirSync(d), []);
});

test("H1 lifecycle: end DURING path prevalidation → ABORTED with no prompt, no input read, no file", async () => {
  const d = freshDir(); const p = join(d, "f"); const tty = fakeTty([enter("x"), enter("x")]); const err = sink(); let fired = false;
  const lstat = async (q) => { if (!fired) { fired = true; tty.readableEnded = true; tty.emit("end"); } return realFs.promises.lstat(q); };
  const r = await settledWithin(runWith(p, { tty, stderr: err, over: { lstat } }), 500);
  assert.notEqual(r, "PENDING"); assert.equal(JSON.parse(r.v.line).code, "ABORTED");
  assert.equal(err.text, "", "no prompt"); assert.equal(existsSync(p), false); assert.equal(tty.listenerCount("data"), 0);
});

test("H1 lifecycle (guard isolation): event-only EOF between prompts (no state flag) is caught by the RUN-WIDE listener", async () => {
  const d = freshDir(); const p = join(d, "f"); const tty = fakeTty();
  const err = hookedErr(() => queueMicrotask(() => { tty.emit("data", Buffer.from("synthetic-password\r")); tty.emit("end"); }));   // no readableEnded
  const r = await settledWithin(runWith(p, { tty, stderr: err }), 500);
  assert.notEqual(r, "PENDING"); assert.equal(JSON.parse(r.v.line).code, "ABORTED"); assert.equal(existsSync(p), false);
});

test("H1 lifecycle (guard isolation): reader alone — dead stream at entry, and event-only end/close/error or abort DURING the label write", async () => {
  for (const k of ["readableEnded", "destroyed", "closed"]) {
    const t = fakeTty(); t[k] = true; const out = sink();
    await assert.rejects(H.readHiddenLineH1({ input: t, output: out, label: "L", maxLength: 8 }), (e) => e.code === "ABORTED", k);
    assert.equal(out.text, "", `${k}: label never written`); assert.equal(t.raw.length, 0);
  }
  for (const ev of ["end", "close", "error"]) {
    const t = fakeTty(); const out = { write() { t.emit(ev, new Error("synthetic")); return true; } };
    const r = await settledWithin(H.readHiddenLineH1({ input: t, output: out, label: "L", maxLength: 8 }), 300);
    assert.notEqual(r, "PENDING", ev); assert.equal(r.e && r.e.code, "ABORTED", ev); assert.equal(t.raw.includes(true), false, `${ev}: raw never enabled`);
  }
  const ac = new AbortController(); const t = fakeTty(); const out = { write() { ac.abort(); return true; } };
  const r = await settledWithin(H.readHiddenLineH1({ input: t, output: out, label: "L", maxLength: 8, signal: ac.signal }), 300);
  assert.notEqual(r, "PENDING"); assert.equal(r.e && r.e.code, "ABORTED"); assert.equal(t.raw.includes(true), false);
});

test("H1 reader alone: raw setup abort / EOF / failure restores terminal mode without runFill finally", async () => {
  for (const mode of ["end", "close", "error", "abort", "throw-after-enable"]) {
    const t = fakeTty(); const ac = new AbortController(); const setRaw = t.setRawMode;
    t.setRawMode = (v) => {
      setRaw(v);
      if (v) {
        if (mode === "abort") ac.abort();
        else if (mode === "throw-after-enable") throw new Error("synthetic setup failure");
        else t.emit(mode, new Error("synthetic input termination"));
      }
      return t;
    };
    const r = await settledWithin(H.readHiddenLineH1({ input: t, output: sink(), label: "L", maxLength: 8, signal: ac.signal }), 300);
    assert.notEqual(r, "PENDING", mode);
    assert.equal(r.e && r.e.code, mode === "throw-after-enable" ? "TTY_SETUP_FAILED" : "ABORTED", mode);
    assert.equal(t.raw.at(-1), false, `${mode}: reader restores raw mode itself`);
    for (const ev of ["data", "end", "close", "error"]) assert.equal(t.listenerCount(ev), 0, `${mode}: ${ev} listener removed`);
  }
});

test("H1 lifecycle (guard isolation): dead stdin → NO prevalidation fs access; abort during prevalidation wins over its result (existing target)", async () => {
  const d = freshDir(); let calls = 0; const tty = fakeTty(); tty.readableEnded = true;
  const lstat = async (q) => { calls++; return realFs.promises.lstat(q); };
  let r = await runWith(join(d, "f"), { tty, stderr: sink(), over: { lstat } });
  assert.equal(JSON.parse(r.line).code, "ABORTED"); assert.equal(calls, 0, "no fs access once stdin is dead");
  const existing = join(d, "exists"); writeFileSync(existing, "X", { mode: 0o600 }); const t2 = fakeTty(); let fired = false;
  const lstat2 = async (q) => { if (!fired) { fired = true; t2.emit("end"); } return realFs.promises.lstat(q); };   // event-only, during prevalidation
  r = await runWith(existing, { tty: t2, stderr: sink(), over: { lstat: lstat2 } });
  assert.equal(JSON.parse(r.line).code, "ABORTED"); assert.equal(readFileSync(existing, "utf8"), "X");
});
