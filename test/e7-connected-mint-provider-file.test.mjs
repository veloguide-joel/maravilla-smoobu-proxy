// H2 (DRAFT rev 2): owner-only provider-file creation with ONE Hostaway token request. SYNTHETIC values only, fake TTY, fake fetch,
// in-memory streams, temp dirs. No network, provider, DB or owner file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as realFs from "node:fs";
import { mkdtempSync, writeFileSync, readFileSync, statSync, existsSync, chmodSync, readdirSync, realpathSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as M from "../scripts/e7-connected/e7-mint-provider-file.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// SYNTHETIC canary key, assembled at runtime so no key-shaped literal sits in source (the global scanner stays unweakened). Value unchanged.
const KEY = ["sk", "test", "CANARYKEY" + "A".repeat(20)].join("_");
const SECRET = "CANARYSECRET" + "f".repeat(52);
const TOKEN = "eyJCANARYTOKEN." + "t".repeat(60);
const uid = process.getuid();

function fakeTty(answers = []) {
  const t = new EventEmitter(); t.isTTY = true; t.raw = []; t.queue = [...answers];
  t.setRawMode = (v) => { t.raw.push(v); return t; }; t.pause = () => {}; t.resume = () => {};
  t.on("newListener", (ev) => { if (ev === "data" && t.queue.length) { const next = t.queue.shift(); setImmediate(() => { if (next && next.event) { t.emit(next.event); return; } t.emit("data", next); }); } });
  return t;
}
const sink = () => { const s = { text: "", write(x) { s.text += String(x); return true; } }; return s; };
const freshDir = () => { const d = realpathSync(mkdtempSync(join(tmpdir(), "h2-"))); chmodSync(d, 0o700); return d; };
const enter = (s) => `${s}\r`;
function fakeFetch(reply) {
  const f = async (url, init) => { f.calls.push({ url, init }); if (reply instanceof Error) throw reply; return typeof reply === "function" ? reply(url, init) : reply; };
  f.calls = []; return f;
}
const okReply = (body = { access_token: TOKEN, token_type: "Bearer", expires_in: 63072000 }) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
/** a fake streamed body: counts produced bytes and cancel calls; `endless` keeps producing; `stall` never produces */
function streamBody({ chunk = 16_384, endless = false, stall = false, cancelRejects = false } = {}) {
  const s = { produced: 0, cancels: 0 };
  s.stream = new ReadableStream({
    pull(c) { if (stall) return new Promise(() => {}); if (!endless && s.produced > 0) { c.close(); return; } s.produced += chunk; c.enqueue(new Uint8Array(chunk).fill(0x41)); },
    cancel() { s.cancels++; if (cancelRejects) return Promise.reject(new Error("cancel rejected")); }
  }, { highWaterMark: 0 });
  return s;
}
async function run(path, answers, fetchImpl, extra = {}) {
  const tty = extra.tty ?? fakeTty(answers); const err = sink(); const signals = new EventEmitter();
  const r = await M.runMint({ argv: [path], stdin: tty, stderr: err, platform: "linux", uid, signals, fetchImpl, repoRoot: ROOT, ...extra.over });
  return { r, tty, err, out: JSON.parse(r.line) };
}
function noLeak(...texts) { for (const t of texts) for (const c of ["CANARY", "eyJ", "ffffffff"]) assert.equal(t.includes(c), false, `leaked ${c}`); }
const ANS = [enter(KEY), enter(KEY), enter(SECRET)];

test("H2 happy path: ONE exact token POST; file 0600 = {hostawayToken, stripeTestKey}; codes-only output; no leak", async () => {
  const d = freshDir(); const p = join(d, "provider.json"); const f = fakeFetch(okReply());
  const { r, out, err, tty } = await run(p, ANS, f);
  assert.deepEqual(out, { schema: "e7-cred-mint-v2", kind: "provider-mint", code: "CREATED_VALIDATED" }); assert.equal(r.exit, 0);
  assert.equal(f.calls.length, 1);
  const c = f.calls[0];
  assert.equal(c.url, "https://api.hostaway.com/v1/accessTokens"); assert.equal(c.init.method, "POST"); assert.equal(c.init.redirect, "error");
  assert.ok(c.init.signal instanceof AbortSignal);
  const body = new URLSearchParams(c.init.body);
  assert.deepEqual([...body.keys()], ["grant_type", "client_id", "client_secret", "scope"]);
  assert.equal(body.get("grant_type"), "client_credentials"); assert.equal(body.get("client_id"), "201434"); assert.equal(body.get("client_secret"), SECRET); assert.equal(body.get("scope"), "general");
  assert.deepEqual(JSON.parse(readFileSync(p, "utf8")), { hostawayToken: TOKEN, stripeTestKey: KEY });
  assert.equal(statSync(p).mode & 0o777, 0o600);
  noLeak(r.line, err.text); assert.equal(tty.raw.at(-1), false);
});

test("H2 no request before every offline check: existing file / path / in-repo / Stripe mismatch / non-test key / Ctrl-C / EOF", async () => {
  const d = freshDir();
  const ex = join(d, "exists.json"); writeFileSync(ex, "{}", { mode: 0o600 });
  const cases = [
    [ex, ANS, "EXISTS"], ["relative.json", ANS, "PATH_INVALID"], [join(ROOT, "x-provider.json"), ANS, "IN_REPO"],
    [join(d, "a.json"), [enter(KEY), enter(KEY + "B"), enter(SECRET)], "ENTRY_MISMATCH"],
    [join(d, "b.json"), [enter("sk_live_" + "A".repeat(20)), enter("sk_live_" + "A".repeat(20)), enter(SECRET)], "KEY_NOT_TEST"],
    [join(d, "c.json"), [enter("rk_test_" + "A".repeat(20)), enter("rk_test_" + "A".repeat(20)), enter(SECRET)], "KEY_NOT_TEST"],
    [join(d, "e.json"), [enter(KEY), enter(KEY), "\x03"], "ABORTED"],
    [join(d, "g.json"), [enter(KEY), enter(KEY), { event: "end" }], "ABORTED"]
  ];
  for (const [p, ans, code] of cases) {
    const f = fakeFetch(okReply()); const { out, r } = await run(p, ans, f);
    assert.equal(out.code, code, p); assert.equal(f.calls.length, 0, `request for ${code}`); noLeak(r.line);
  }
  assert.deepEqual(readdirSync(d).sort(), ["exists.json"]); assert.equal(readFileSync(ex, "utf8"), "{}");
});

test("H2 F3: only 4xx is a refusal (exit 7); 5xx / network / timeout / redirect / invalid reply are OUTCOME_UNKNOWN (exit 9); one request, no file", async () => {
  const d = freshDir(); let i = 0;
  const cases = [
    [new Response("{\"message\":\"CANARY\"}", { status: 401 }), "MINT_REFUSED_HTTP_4XX", 401, 7],
    [new Response("x", { status: 403 }), "MINT_REFUSED_HTTP_4XX", 403, 7],
    [new Response("x", { status: 500 }), "MINT_OUTCOME_UNKNOWN_HTTP", 500, 9],
    [new Response("x", { status: 503 }), "MINT_OUTCOME_UNKNOWN_HTTP", 503, 9],
    [new TypeError("fetch failed CANARY"), "MINT_OUTCOME_UNKNOWN_NETWORK", undefined, 9],
    [new TypeError("redirect mode is set to error"), "MINT_OUTCOME_UNKNOWN_NETWORK", undefined, 9],
    [new Response("not json CANARY", { status: 200 }), "MINT_OUTCOME_UNKNOWN_RESPONSE", 200, 9],
    [okReply({ token_type: "Bearer" }), "MINT_OUTCOME_UNKNOWN_RESPONSE", 200, 9],
    [okReply({ access_token: "short" }), "MINT_OUTCOME_UNKNOWN_RESPONSE", 200, 9]
  ];
  for (const [reply, code, st, exit] of cases) {
    const p = join(d, `f${i++}.json`); const f = fakeFetch(reply);
    const { out, r, err } = await run(p, ANS, f);
    assert.equal(out.code, code); assert.equal(out.httpStatus, st); assert.equal(r.exit, exit); assert.equal(f.calls.length, 1);
    assert.equal(existsSync(p), false); noLeak(r.line, err.text);
  }
});

test("H2 F3: server ISSUED a token but the body stalls past the deadline → OUTCOME_UNKNOWN (exit 9), body cancelled, no file, no second request", async () => {
  const d = freshDir(); const p = join(d, "stall.json"); const s = streamBody({ stall: true }); let issued = false;
  const f = fakeFetch(() => { issued = true; return new Response(s.stream, { status: 200 }); });
  const t0 = Date.now();
  const { out, r } = await run(p, ANS, f, { over: { timeoutMs: 60 } });
  assert.equal(issued, true); assert.equal(out.code, "MINT_OUTCOME_UNKNOWN_NETWORK"); assert.equal(r.exit, 9);
  assert.equal(f.calls.length, 1); assert.equal(existsSync(p), false); assert.ok(s.cancels >= 1); assert.ok(Date.now() - t0 < 5000);
});

test("H2 F1: oversized streamed body is cut at the cap (incremental), cancelled, never drained; result OUTCOME_UNKNOWN_RESPONSE", async () => {
  const s = streamBody({ endless: true, chunk: 16_384 });
  const f = fakeFetch(() => new Response(s.stream, { status: 200 }));
  const r = await M.requestToken({ fetchImpl: f, clientSecret: SECRET, timeoutMs: 5000 });
  assert.equal(r.ok, false); assert.equal(r.code, "MINT_OUTCOME_UNKNOWN_RESPONSE"); assert.equal(r.httpStatus, 200);
  assert.ok(s.cancels >= 1, "cancelled");
  assert.ok(s.produced <= M.LIMITS_H2.bodyBytes + 2 * 16_384, `produced ${s.produced} bytes`);   // bounded production, not drained
  // direct reader: exact boundary — cap bytes accepted, cap+1 refused
  const exact = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(100)); c.close(); } });
  assert.equal((await M.readBounded(exact, 100)).ok, true);
  const over = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(101)); c.close(); } });
  assert.deepEqual(await M.readBounded(over, 100), { ok: false, reason: "OVERFLOW" });
  // pre-aborted signal → ABORTED and cancelled
  const s2 = streamBody({ stall: true }); const ac = new AbortController(); ac.abort();
  assert.deepEqual(await M.readBounded(s2.stream, 100, ac.signal), { ok: false, reason: "ABORTED" }); assert.ok(s2.cancels >= 1);
});

test("H2 F1: a rejected body cancel on a non-ok reply is awaited and swallowed (no unhandled rejection), code unchanged", async () => {
  const s = streamBody({ cancelRejects: true }); let unhandled = 0; const on = () => { unhandled++; };
  process.on("unhandledRejection", on);
  try {
    const f = fakeFetch(() => new Response(s.stream, { status: 401 }));
    const r = await M.requestToken({ fetchImpl: f, clientSecret: SECRET, timeoutMs: 5000 });
    assert.equal(r.code, "MINT_REFUSED_HTTP_4XX"); assert.equal(s.cancels, 1);
    await new Promise((res) => setTimeout(res, 20)); assert.equal(unhandled, 0);
  } finally { process.off("unhandledRejection", on); }
});

test("H2 ROOT: stalled cancellation respects the same deadline on refusal, overflow and read abort", async () => {
  for (const mode of ["refusal", "overflow", "read-abort", "late-rejection"]) {
    let cancels = 0; let calls = 0; let rejectCancel;
    const stream = new ReadableStream({
      start(c) { if (mode === "overflow") c.enqueue(new Uint8Array(M.LIMITS_H2.bodyBytes + 1)); },
      cancel() { cancels++; return new Promise((_, reject) => { rejectCancel = reject; }); }
    });
    const response = new Response(stream, { status: mode === "refusal" ? 401 : 200 });
    let guard;
    try {
      const result = await Promise.race([
        M.requestToken({ fetchImpl: async () => { calls++; return response; }, clientSecret: SECRET, timeoutMs: 20 }),
        new Promise((_, reject) => { guard = setTimeout(() => reject(new Error(`${mode}: cancellation outlived total deadline`)), 500); })
      ]);
      const expected = mode === "refusal" ? "MINT_REFUSED_HTTP_4XX" : mode === "overflow" ? "MINT_OUTCOME_UNKNOWN_RESPONSE" : "MINT_OUTCOME_UNKNOWN_NETWORK";
      assert.equal(result.code, expected); assert.equal(calls, 1); assert.equal(cancels, 1);
      if (mode === "late-rejection") {
        rejectCancel(new Error("synthetic late cancellation rejection"));
        await new Promise((resolve) => setImmediate(resolve)); // node:test catches any unhandled rejection
      }
    } finally { clearTimeout(guard); }
  }
});

test("H2 F2: post-request dispositions are truthful (removed / left in place / no file), foreign files preserved", async () => {
  const d = freshDir();
  // (a) a file appeared after the request → NO_FILE_CREATED, foreign file untouched
  const pa = join(d, "race.json");
  const a = await run(pa, ANS, fakeFetch(() => { writeFileSync(pa, "{\"foreign\":1}", { mode: 0o600 }); return okReply(); }));
  assert.equal(a.out.code, "TOKEN_MINTED_NO_FILE_CREATED"); assert.equal(a.r.exit, 8); assert.equal(readFileSync(pa, "utf8"), "{\"foreign\":1}");
  // (b) round-trip false + unlink FAILS → LEFT_IN_PLACE, file still present
  const pb = join(d, "unlinkfail.json");
  const fsNoUnlink = { ...realFs, unlinkSync: () => { throw Object.assign(new Error("EPERM"), { code: "EPERM" }); } };
  const b = await run(pb, ANS, fakeFetch(okReply()), { over: { fs: fsNoUnlink, roundTripImpl: async () => false } });
  assert.equal(b.out.code, "TOKEN_MINTED_FILE_LEFT_IN_PLACE"); assert.equal(existsSync(pb), true);
  // (c) inode swap before cleanup → identity mismatch → LEFT_IN_PLACE; the foreign replacement is preserved
  const pc = join(d, "swap.json");
  const c = await run(pc, ANS, fakeFetch(okReply()), { over: { roundTripImpl: async () => { unlinkSync(pc); writeFileSync(pc, "{\"foreign\":2}", { mode: 0o600 }); return false; } } });
  assert.equal(c.out.code, "TOKEN_MINTED_FILE_LEFT_IN_PLACE"); assert.equal(readFileSync(pc, "utf8"), "{\"foreign\":2}");
  // (d) round-trip THROWS → disposition still evaluated: own file removed
  const pd = join(d, "throw.json");
  const dd = await run(pd, ANS, fakeFetch(okReply()), { over: { roundTripImpl: async () => { throw new Error("boom"); } } });
  assert.equal(dd.out.code, "TOKEN_MINTED_FILE_REMOVED"); assert.equal(existsSync(pd), false);
  // (e) abort AFTER the write (EOF during round-trip) even though round-trip passes → REMOVED, never CREATED_VALIDATED
  const pe = join(d, "abort.json"); const tty = fakeTty(ANS);
  const e = await run(pe, null, fakeFetch(okReply()), { tty, over: { roundTripImpl: async () => { tty.emit("end"); return true; } } });
  assert.equal(e.out.code, "TOKEN_MINTED_FILE_REMOVED"); assert.equal(existsSync(pe), false);
  // (f) adapters throw → REMOVED
  const pf = join(d, "adapt.json");
  const ff = await run(pf, ANS, fakeFetch(okReply()), { over: { adapters: () => { throw new Error("x"); } } });
  assert.equal(ff.out.code, "TOKEN_MINTED_FILE_REMOVED"); assert.equal(existsSync(pf), false);
  for (const x of [a, b, c, dd, e, ff]) { assert.equal(x.r.exit, 8); noLeak(x.r.line, x.err.text); }
});

test("H2 F2: removeOwnStrict removes only the exact own bytes at the own dev/ino; same-size different content, swapped file or symlink are left", () => {
  const d = freshDir(); const p = join(d, "own.json"); const bytes = Buffer.from("{\"a\":1}\n");
  const w = (b) => { try { unlinkSync(p); } catch { /* none */ } realFs.writeFileSync(p, b, { mode: 0o600 }); const st = realFs.lstatSync(p, { bigint: true }); return { dev: st.dev, ino: st.ino }; };
  let id = w(bytes); assert.equal(M.removeOwnStrict(p, id, bytes), true); assert.equal(existsSync(p), false);
  id = w(Buffer.from("{\"b\":2}\n")); assert.equal(M.removeOwnStrict(p, id, bytes), false); assert.equal(existsSync(p), true);   // same size, other bytes
  id = w(bytes); assert.equal(M.removeOwnStrict(p, { dev: id.dev, ino: id.ino + 1n }, bytes), false); assert.equal(existsSync(p), true);
  unlinkSync(p); realFs.symlinkSync("/etc/hostname", p); assert.equal(M.removeOwnStrict(p, id, bytes), false); assert.equal(realFs.lstatSync(p).isSymbolicLink(), true);
  assert.equal(M.removeOwnStrict(p, null, bytes), false);
});

test("H2 F3: a valid-looking but oversized / escape-heavy token cannot fit H1's 4096-byte provider file → NO_FILE_CREATED (exit 8), nothing written", async () => {
  const d = freshDir();
  for (const tok of ["t".repeat(4096), ("\"\\").repeat(1500) + "CANARY"]) {
    const p = join(d, `big${tok.length}.json`);
    const { out, r } = await run(p, ANS, fakeFetch(okReply({ access_token: tok })));
    assert.equal(out.code, "TOKEN_MINTED_NO_FILE_CREATED"); assert.equal(r.exit, 8); assert.equal(existsSync(p), false); noLeak(r.line);
  }
});

test("H2 grammar / platform / TTY refusals happen before any prompt or request", async () => {
  const f = fakeFetch(okReply());
  const g = async (over) => JSON.parse((await M.runMint({ argv: ["/tmp/x.json"], stdin: fakeTty(), stderr: sink(), platform: "linux", uid, signals: new EventEmitter(), fetchImpl: f, repoRoot: ROOT, ...over })).line).code;
  assert.equal(await g({ argv: [] }), "USAGE"); assert.equal(await g({ argv: ["a", "b"] }), "USAGE");
  assert.equal(await g({ platform: "win32" }), "PLATFORM_UNSUPPORTED"); assert.equal(await g({ stdin: { isTTY: false } }), "TTY_REQUIRED");
  assert.equal(f.calls.length, 0);
});

test("H2 source containment: only the fixed token URL; no console / env reads / file writers / arrayBuffer / retry loop", () => {
  const src = readFileSync(join(ROOT, "scripts/e7-connected/e7-mint-provider-file.mjs"), "utf8");
  assert.equal((src.match(/https:\/\//g) || []).length, 1);
  for (const re of [/console\./, /process\.env/, /writeFile|appendFile|createWriteStream/, /arrayBuffer\(/, /\.text\(\)/, /\.json\(\)/]) assert.equal(re.test(src), false, String(re));
  assert.equal((src.match(/fetchImpl\(/g) || []).length, 1);
});
