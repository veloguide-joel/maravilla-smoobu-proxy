// test/e7-resend-sink-probe.test.mjs — C42: Resend SYNTHETIC sink-send probe + its own node:https exchange. FAKE network only: real network
// primitives are replaced by throwing guards BEFORE any import; the real exchange is exercised against an injected FAKE https primitive; child
// processes (CLI) preload a throwing node:https guard and are only run in modes / gates that refuse before any send. No DB, no provider, no key.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, mkdtempSync, rmSync, writeFileSync, cpSync, appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const GUARD = { request: 0, Agent: 0, fetch: 0, httpRequest: 0 };
https.request = () => { GUARD.request += 1; throw new Error("network refused"); };
https.get = () => { GUARD.request += 1; throw new Error("network refused"); };
https.Agent = class { constructor() { GUARD.Agent += 1; throw new Error("network refused"); } };
http.request = () => { GUARD.httpRequest += 1; throw new Error("network refused"); };
globalThis.fetch = async () => { GUARD.fetch += 1; throw new Error("network refused"); };
syncBuiltinESMExports();
after(() => { assert.deepEqual(GUARD, { request: 0, Agent: 0, fetch: 0, httpRequest: 0 }, "no real network primitive was touched"); });

const ROOT = realpathSync(join(dirname(fileURLToPath(import.meta.url)), ".."));
const TOOLING = realpathSync(process.env.E7_TOOLING_DIR || join(ROOT, "..", "tooling"));
const P = await import("../scripts/e7-resend-sink-probe.mjs");
const X = await import("../scripts/e7-resend/resend-exchange.mjs");
const sha = (b) => createHash("sha256").update(b).digest("hex");

const LT = await P.loadTooling(TOOLING);
assert.equal(LT.ok, true, "E7_TOOLING_DIR must be the immutable f05016a7 checkout");
const plan = (locale) => { const r = P.buildPlan({ render: LT.render, locale }); assert.equal(r.ok, true); return r.plan; };
const KEY = "re_SENTINELkey0123456789";
const RUN = "43999000111";
const UUID = "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794";
/** a fake exchange: records requests IN MEMORY; replies via `reply` */
function fakeExchange(reply = () => ({ status: 200, headers: { contentType: "application/json", contentEncoding: null, idempotentReplayed: null }, body: Buffer.from(`{"id":"${UUID}"}`) })) {
  const s = { calls: 0, reqs: [] };
  s.exchange = async (req) => { s.calls += 1; s.reqs.push(req); return reply(req, s.calls); };
  return s;
}
const send = (pl, over = {}) => { const s = over.fx ?? fakeExchange(); const cred = { n: 0 };
  const input = { plan: pl, runId: RUN, runAttempt: "1", expectedPlanHash: pl.planHash, credential: () => { cred.n += 1; return KEY; }, exchange: s.exchange, ...over.input };
  return P.runSend(input).then((r) => ({ r, s, cred })); };

// independently written expected copy (the accepted bcc-v1 wording, with the probe's synthetic facts)
const EN = { subject: "Your maraVilla booking MV-SINKPROBE is confirmed", text: ["Your maraVilla booking MV-SINKPROBE is confirmed.", "Booking reference: MV-SINKPROBE", "Check-in: 2030-01-14",
  "Check-out: 2030-01-16", "Nights: 2", "Guests: 2", "Payment received: $123.45 USD", "", "maraVilla"].join("\n") };
const ES = { subject: "Tu reservación de maraVilla MV-SINKPROBE está confirmada", text: ["Tu reservación de maraVilla MV-SINKPROBE está confirmada.", "Referencia de la reservación: MV-SINKPROBE",
  "Llegada (check-in): 2030-01-14", "Salida (check-out): 2030-01-16", "Noches: 2", "Huéspedes: 2", "Pago recibido: $123.45 USD", "", "maraVilla"].join("\n") };
const PINNED = { en: { bodyHash: "6645ae194d8eff4c992c214baa5eccfcfe53c1a9771d6f73afafbe34408cae32", planHash: "7cb4f50f6e51346685eef120460e2728566304107105d9067d2c8e34a12397b2", bytes: 343 },
  es: { bodyHash: "b59f5703b2aaf53e9c806eaab052867d305626e16c6a5c9a307e91dd123e3705", planHash: "811d7bdbde333a3909895bc94cbf07788584132dc0bc2259803cf69f38fb4814", bytes: 395 } };

// =============================================================================================

test("R1 constants: fixed sender / singleton sink recipient / synthetic facts (no real booking ref) / route / budgets / pin / 2-file copy closure + node:crypto", () => {
  assert.equal(P.SENDER, "maraVilla TEST <onboarding@resend.dev>");
  assert.deepEqual([...P.RECIPIENTS], ["delivered@resend.dev"]);
  assert.deepEqual([...P.LOCALES], ["en", "es"]);
  assert.deepEqual({ ...P.SYNTHETIC_FACTS }, { ref: "MV-SINKPROBE", checkIn: "2030-01-14", checkOut: "2030-01-16", nights: 2, guests: 2, totalMinor: 12345, currency: "USD" });
  for (const real of ["MV-8L79DEJ7", "MV-5RBRW6CM", "71700931", "abede8b1", "c83c1842", "70636076", "71045356", "71072615", "71081885"]) assert.ok(!JSON.stringify(P.SYNTHETIC_FACTS).includes(real), real);
  assert.deepEqual([X.RESEND_METHOD, X.RESEND_HOST, X.RESEND_PORT, X.RESEND_PATH], ["POST", "api.resend.com", 443, "/emails"]);
  assert.deepEqual({ ...P.BUDGETS }, { maxBytes: 65536, deadlineMs: 10000, attempts: 1 });
  assert.equal(P.TOOLING_COMMIT, "f05016a7af3f866e7e4d46d219a3b95934ca867c");
  assert.deepEqual(Object.keys(P.MANIFEST).sort(), ["lib/checkout/booking-confirmation-copy.js", "lib/checkout/guest-notification.js"]);
  assert.deepEqual([...P.BUILTIN_IMPORTS], ["node:crypto"]);
  assert.deepEqual([...P.HEADER_NAMES], ["Authorization", "Content-Type", "Content-Length", "User-Agent", "Idempotency-Key", "Accept", "Accept-Encoding"]);
  assert.match(P.USER_AGENT, /^[\x21-\x7E]+\/1$/, "a User-Agent is REQUIRED by the API introduction (403 without one)");
  for (const o of [P.RECIPIENTS, P.SYNTHETIC_FACTS, P.MANIFEST, P.HEADER_NAMES, P.BUDGETS]) assert.ok(Object.isFrozen(o));
});

test("R2 copy closure: an INDEPENDENT scan of the pinned checkout is exactly the manifest (files + digests + builtins); git HEAD of the tooling dir is the pin", async () => {
  const s = await P.scanClosure(TOOLING);
  assert.deepEqual({ ...s.files }, { ...P.MANIFEST });
  assert.deepEqual([...s.builtins], ["node:crypto"]);
  for (const f of Object.keys(P.MANIFEST)) assert.equal(sha(readFileSync(join(TOOLING, f))), P.MANIFEST[f], f);
  const head = spawnSync("git", ["-C", TOOLING, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  assert.equal(head, P.TOOLING_COMMIT);
});

test("R3 EN / ES exact JSON body bytes (accepted bcc-v1 copy unchanged), body / plan hashes pinned and content-derived; locale is the ONLY content choice", () => {
  for (const [locale, c] of [["en", EN], ["es", ES]]) {
    const pl = plan(locale);
    const want = `{"from":"maraVilla TEST <onboarding@resend.dev>","to":["delivered@resend.dev"],"subject":${JSON.stringify(c.subject)},"text":${JSON.stringify(c.text)}}`;
    assert.ok(pl.body.equals(Buffer.from(want, "utf8")), `${locale}: exact body bytes (boolean compare)`);
    assert.deepEqual([pl.bodyHash, pl.planHash, pl.bodyBytes], [PINNED[locale].bodyHash, PINNED[locale].planHash, PINNED[locale].bytes], locale);
    assert.equal(pl.bodyHash, sha(Buffer.from(want, "utf8")));
    assert.deepEqual(Object.keys(JSON.parse(pl.body.toString("utf8"))), ["from", "to", "subject", "text"], "no html / cc / bcc / reply_to / tags / headers / attachments / scheduled_at / template");
    assert.deepEqual({ ...pl.fixedHeaders }, { "Content-Type": "application/json", "Content-Length": String(PINNED[locale].bytes), "User-Agent": P.USER_AGENT, Accept: "application/json", "Accept-Encoding": "identity" });
    assert.ok(Object.isFrozen(pl));
  }
  assert.notEqual(plan("en").planHash, plan("es").planHash, "the locale is bound into the plan hash");
  assert.equal(plan("es").planHash, plan("es").planHash, "deterministic");
  for (const l of ["EN", "es-MX", "fr", "", null, undefined, ["en"]]) assert.deepEqual({ ...P.buildPlan({ render: LT.render, locale: l }) }, { ok: false, code: "LOCALE_INVALID" });
  // a renderer that changes the copy (contract / locale / shape) is refused
  for (const bad of [() => ({ ok: true, copy: { contractVersion: "bcc-v2", locale: "en", subject: "x", text: "y" } }), () => ({ ok: true, copy: { contractVersion: "bcc-v1", locale: "es", subject: "x", text: "y" } }),
    () => ({ ok: false, code: "X" }), () => { throw new Error("SENTINEL"); }]) assert.deepEqual({ ...P.buildPlan({ render: bad, locale: "en" }) }, { ok: false, code: "COPY_REFUSED" });
});

test("R4 ONE fake POST, exact request bytes: route, header object (names / order / values), Authorization only from the key seam, Idempotency-Key = probe/run/attempt-1/planHash (≤ 256); happy → PROVIDER_ACCEPTED with the allowlisted UUID", async () => {
  for (const locale of ["en", "es"]) {
    const pl = plan(locale);
    const { r, s, cred } = await send(pl);
    assert.deepEqual([s.calls, cred.n, r.outcome, r.stop, r.attempts, r.httpStatus, r.emailId], [1, 1, "PROVIDER_ACCEPTED", null, 1, 200, UUID], locale);
    const q = s.reqs[0];
    assert.deepEqual(Object.keys(q).sort(), ["body", "headers", "host", "method", "path"]);
    assert.deepEqual([q.method, q.host, q.path], ["POST", "api.resend.com", "/emails"]);
    assert.ok(Buffer.from(q.body).equals(pl.body));
    const key = `e7-resend-sink-probe-v1/run-${RUN}/attempt-1/${pl.planHash}`;
    assert.ok(key.length <= 256);
    assert.ok(JSON.stringify(Object.entries(q.headers)) === JSON.stringify([["Authorization", `Bearer ${KEY}`], ["Content-Type", "application/json"], ["Content-Length", String(pl.bodyBytes)],
      ["User-Agent", P.USER_AGENT], ["Idempotency-Key", key], ["Accept", "application/json"], ["Accept-Encoding", "identity"]]), "exact header bytes (boolean compare)");
    assert.equal(P.idempotencyKey(pl.planHash, RUN), key);
    assert.deepEqual([r.locale, r.planHash, r.bodyHash], [locale, pl.planHash, pl.bodyHash]);
    assert.ok(Object.isFrozen(r));
  }
  // replay header true (same key + same payload within 24 h, per the docs) → distinct outcome, still exactly one call
  const { r } = await send(plan("en"), { fx: fakeExchange(() => ({ status: 200, headers: { contentType: "application/json; charset=utf-8", contentEncoding: null, idempotentReplayed: "true" }, body: Buffer.from(`{"id":"${UUID}"}`) })) });
  assert.deepEqual([r.outcome, r.attempts, r.emailId], ["PROVIDER_ACCEPTED_REPLAY", 1, UUID]);
});

test("R5 refused BEFORE the exchange: wrong recipient / sender / extra body params / path / host / method / headers / body drift / third-party input (zero exchange calls)", async () => {
  const pl = plan("en");
  const good = { method: "POST", host: "api.resend.com", path: "/emails", body: pl.body,
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", "Content-Length": String(pl.bodyBytes), "User-Agent": P.USER_AGENT,
      "Idempotency-Key": P.idempotencyKey(pl.planHash, RUN), Accept: "application/json", "Accept-Encoding": "identity" } };
  assert.equal(P.guardRequest(good, pl), null);
  const body = (o) => Buffer.from(JSON.stringify({ ...JSON.parse(pl.body.toString("utf8")), ...o }), "utf8");
  const bad = {
    "recipient +label": { body: body({ to: ["delivered+x@resend.dev"] }) }, "recipient other": { body: body({ to: ["guest@example.com"] }) }, "two recipients": { body: body({ to: ["delivered@resend.dev", "a@resend.dev"] }) },
    "recipient string": { body: body({ to: "delivered@resend.dev" }) }, ".invalid recipient": { body: body({ to: ["guest.v@mv-test.invalid"] }) }, "sender": { body: body({ from: "maraVilla <bookings@maravillanayarit.com>" }) },
    "cc": { body: body({ cc: ["x@resend.dev"] }) }, "bcc": { body: body({ bcc: ["x@resend.dev"] }) }, "reply_to": { body: body({ reply_to: "x@resend.dev" }) }, "html": { body: body({ html: "<p>x</p>" }) },
    "attachments": { body: body({ attachments: [] }) }, "tags": { body: body({ tags: [] }) }, "headers param": { body: body({ headers: {} }) }, "scheduled_at": { body: body({ scheduled_at: "in 1 min" }) },
    "template": { body: body({ template: { id: "x" } }) }, "subject drift": { body: body({ subject: "x" }) }, "path": { path: "/emails/batch" }, "host": { host: "api.resend.com.evil.test" }, "method": { method: "PUT" },
    "extra request key": { url: "https://api.resend.com/emails" }, "header extra": { headers: { ...good.headers, "X-Extra": "1" } }, "header order": { headers: Object.fromEntries(Object.entries(good.headers).reverse()) },
    "content-length lie": { headers: { ...good.headers, "Content-Length": "1" } }, "encoding": { headers: { ...good.headers, "Accept-Encoding": "gzip" } }, "user-agent": { headers: { ...good.headers, "User-Agent": "curl/8" } },
    "idempotency key other plan": { headers: { ...good.headers, "Idempotency-Key": `e7-resend-sink-probe-v1/run-${RUN}/attempt-1/${"f".repeat(64)}` } }, "auth": { headers: { ...good.headers, Authorization: `Basic ${KEY}` } }
  };
  for (const [kind, over] of Object.entries(bad)) assert.equal(P.guardRequest({ ...good, ...over }, pl), "GUARD_REFUSED", kind);
  // runSend: third-party input keys / missing seams → INPUT_INVALID; the key is never read, the exchange never called
  for (const extra of [{ to: ["x@y.z"] }, { recipient: "x" }, { sender: "x" }, { body: "x" }, { headers: {} }, { idempotencyKey: "x" }, { maxBytes: 1 }]) {
    const { r, s, cred } = await send(pl, { input: extra });
    assert.deepEqual([r.outcome, r.stop, s.calls, cred.n], ["REFUSED_BEFORE_NETWORK", "INPUT_INVALID", 0, 0], JSON.stringify(extra));
  }
  // a plan whose bytes were altered after hashing (e.g. a recipient rewrite) is refused by the guard before the exchange
  const tampered = Object.freeze({ ...pl, body: body({ to: ["guest@example.com"] }) });
  const { r: rt, s: st } = await send(tampered, { input: { expectedPlanHash: pl.planHash } });
  assert.deepEqual([rt.outcome, rt.stop, st.calls], ["REFUSED_BEFORE_NETWORK", "GUARD_REFUSED", 0]);
});

test("R6 gates before the key: run attempt must be exactly '1', run id digits, expected plan hash 64-hex and EQUAL; key grammar; all refused with ZERO exchange calls (attempts>1 never reaches the key)", async () => {
  const pl = plan("es");
  for (const [over, code] of [[{ runAttempt: "2" }, "RUN_ATTEMPT_NOT_1"], [{ runAttempt: "01" }, "RUN_ATTEMPT_NOT_1"], [{ runAttempt: undefined }, "RUN_ATTEMPT_NOT_1"], [{ runAttempt: 1 }, "RUN_ATTEMPT_NOT_1"],
    [{ runId: "" }, "RUN_ID_INVALID"], [{ runId: "0123" }, "RUN_ID_INVALID"], [{ runId: "12a" }, "RUN_ID_INVALID"], [{ runId: undefined }, "RUN_ID_INVALID"],
    [{ expectedPlanHash: "" }, "PLAN_HASH_INVALID"], [{ expectedPlanHash: pl.planHash.toUpperCase() }, "PLAN_HASH_INVALID"], [{ expectedPlanHash: plan("en").planHash }, "PLAN_HASH_MISMATCH"],
    [{ expectedPlanHash: "f".repeat(64) }, "PLAN_HASH_MISMATCH"]]) {
    const { r, s, cred } = await send(pl, { input: over });
    assert.deepEqual([r.outcome, r.stop, s.calls, cred.n, r.attempts], ["REFUSED_BEFORE_NETWORK", code, 0, 0, 0], JSON.stringify(over));
  }
  for (const k of [undefined, "", "re_short", "sk_test_0123456789abcdef", `re_${"a".repeat(300)}`, "re_abc def0123", "re_abc\r\nX-Evil: 1", null]) {
    const s = fakeExchange();
    const r = await P.runSend({ plan: pl, runId: RUN, runAttempt: "1", expectedPlanHash: pl.planHash, credential: () => k, exchange: s.exchange });
    assert.deepEqual([r.outcome, r.stop, s.calls], ["REFUSED_BEFORE_NETWORK", "KEY_INVALID", 0], String(k).slice(0, 12));
  }
  const s = fakeExchange();
  const r = await P.runSend({ plan: pl, runId: RUN, runAttempt: "1", expectedPlanHash: pl.planHash, credential: () => { throw new Error(`SENTINEL ${KEY}`); }, exchange: s.exchange });
  assert.deepEqual([r.stop, s.calls], ["KEY_INVALID", 0]);
});

test("R7 source / pin / closure drift → refused with ZERO import (and so zero plan, zero network): altered dependency, extra relative import, extra builtin import, missing file, missing dir", async () => {
  const mk = () => { const d = mkdtempSync(join(tmpdir(), "e7-c42-drift-")); cpSync(join(TOOLING, "lib"), join(d, "lib"), { recursive: true }); return d; };
  const cases = [
    ["altered dependency", (d) => appendFileSync(join(d, "lib/checkout/guest-notification.js"), "\n// drift\n"), "TOOLING_CLOSURE_MISMATCH"],
    ["altered root", (d) => appendFileSync(join(d, "lib/checkout/booking-confirmation-copy.js"), "\n// drift\n"), "TOOLING_CLOSURE_MISMATCH"],
    ["extra relative import", (d) => { writeFileSync(join(d, "lib/checkout/extra.js"), "export const x = 1;\n"); appendFileSync(join(d, "lib/checkout/booking-confirmation-copy.js"), '\nimport "./extra.js";\n'); }, "TOOLING_CLOSURE_MISMATCH"],
    ["missing dependency", (d) => rmSync(join(d, "lib/checkout/guest-notification.js")), "TOOLING_INVALID"]];
  for (const [kind, mut, code] of cases) {
    const d = mk(); let imports = 0;
    try { mut(d); const r = await P.loadTooling(d, { importModule: async () => { imports += 1; return {}; } }); assert.deepEqual([r.ok, r.code, imports], [false, code, 0], kind); }
    finally { rmSync(d, { recursive: true, force: true }); }
  }
  // builtin set drift: the same two files but with an extra builtin import (digest drift is caught first — prove the builtin check on its own)
  const d = mk(); try {
    appendFileSync(join(d, "lib/checkout/guest-notification.js"), '\nimport "node:fs";\n');
    const s = await P.scanClosure(realpathSync(d)); assert.deepEqual([...s.builtins], ["node:crypto", "node:fs"]);
    const r = await P.loadTooling(d, { importModule: async () => { assert.fail("no import on drift"); } }); assert.equal(r.ok, false);
  } finally { rmSync(d, { recursive: true, force: true }); }
  assert.deepEqual({ ...(await P.loadTooling(join(tmpdir(), "no-such-tooling-c42"))) }, { ok: false, code: "TOOLING_INVALID" });
});

test("R8 reply faults are FINAL (exactly one exchange call, never a retry): non-200 incl. 3xx / 201 / 4xx / 409 / 429 / 5xx, wrong content type, malformed / extra / PII-shaped JSON, bad id, bad replay header, exchange throws (lost reply / deadline / oversize / compressed / spent)", async () => {
  const pl = plan("en");
  const H = (o = {}) => ({ contentType: "application/json", contentEncoding: null, idempotentReplayed: null, ...o });
  const rep = (status, body, h) => () => ({ status, headers: H(h), body: Buffer.from(body) });
  const cases = [
    ...[201, 202, 204, 301, 302, 307, 308, 400, 401, 403, 404, 409, 422, 429, 500, 502, 503].map((st) => [`status ${st}`, rep(st, `{"id":"${UUID}"}`), "HTTP_STATUS"]),
    ["content-type html", rep(200, `{"id":"${UUID}"}`, { contentType: "text/html" }), "REPLY_CONTENT_TYPE"], ["content-type absent", rep(200, `{"id":"${UUID}"}`, { contentType: null }), "REPLY_CONTENT_TYPE"],
    ["not json", rep(200, "SENTINEL-REPLY ok"), "REPLY_JSON_INVALID"], ["invalid utf-8", () => ({ status: 200, headers: H(), body: Buffer.from([0x7b, 0xff, 0x7d]) }), "REPLY_JSON_INVALID"],
    ["array", rep(200, `[{"id":"${UUID}"}]`), "REPLY_SHAPE"], ["extra key", rep(200, `{"id":"${UUID}","object":"email"}`), "REPLY_SHAPE"],
    ["PII-shaped extra", rep(200, `{"id":"${UUID}","to":"SENTINEL-guest@example.com"}`), "REPLY_SHAPE"], ["empty", rep(200, "{}"), "REPLY_SHAPE"],
    ["id email", rep(200, '{"id":"SENTINEL-guest@example.com"}'), "REPLY_ID_INVALID"], ["id uppercase", rep(200, `{"id":"${UUID.toUpperCase()}"}`), "REPLY_ID_INVALID"],
    ["id number", rep(200, '{"id":42}'), "REPLY_ID_INVALID"], ["replay header junk", rep(200, `{"id":"${UUID}"}`, { idempotentReplayed: "yes" }), "REPLAY_HEADER_INVALID"],
    ["no status", () => ({ headers: H(), body: Buffer.from("{}") }), "REPLY_SHAPE"], ["null reply", () => null, "REPLY_SHAPE"]];
  for (const [kind, reply, code] of cases) {
    const { r, s } = await send(pl, { fx: fakeExchange(reply) });
    assert.deepEqual([r.outcome, r.stop, r.attempts, s.calls, r.emailId], ["UNKNOWN_STOP", code, 1, 1, null], kind);
  }
  for (const code of ["EXCHANGE_NETWORK_ERROR", "EXCHANGE_DEADLINE", "EXCHANGE_BODY_TOO_LARGE", "EXCHANGE_ENCODING_REFUSED", "EXCHANGE_PREMATURE_CLOSE", "EXCHANGE_SPENT", "EXCHANGE_SETUP_FAILED"]) {
    const s = { calls: 0 }; s.exchange = async () => { s.calls += 1; throw Object.assign(new Error(`SENTINEL ${KEY} guest@example.com`), { code }); };
    const { r } = await send(pl, { fx: s });
    assert.deepEqual([r.outcome, r.stop, r.attempts, s.calls], ["UNKNOWN_STOP", code, 1, 1], code);
  }
  const s = { calls: 0 }; s.exchange = async () => { s.calls += 1; throw new Error("SENTINEL no code"); };
  const { r } = await send(pl, { fx: s });
  assert.deepEqual([r.outcome, r.stop, s.calls], ["UNKNOWN_STOP", "UNKNOWN_CODE", 1]);
});

// ---------------------------------------------------------------------------------------------
// the REAL node:https exchange against an injected FAKE https primitive

function fakeHttps(onEnd) {
  const log = { requests: 0, opts: null, written: null, agents: [], reqs: [], ress: [] };
  class Agent { constructor(o) { this.o = o; this.destroyed = false; log.agents.push(this); } destroy() { this.destroyed = true; } }
  const request = (opts, cb) => {
    log.requests += 1; log.opts = opts;
    if (onEnd === "throw") throw new Error(`SENTINEL setup ${KEY}`);
    const req = new EventEmitter(); req.destroyed = false; req.destroy = () => { req.destroyed = true; };
    req.end = (b) => { log.written = Buffer.from(b); setImmediate(() => onEnd({ req, cb, log })); };
    log.reqs.push(req);
    return req;
  };
  return { https: { request, Agent }, log };
}
function respond(log, cb, { status = 200, headers = { "content-type": "application/json" }, chunks = [`{"id":"${UUID}"}`], mode = "end", complete = true } = {}) {
  const res = new EventEmitter(); res.statusCode = status; res.headers = headers; res.complete = false; res.destroyed = false; res.destroy = () => { res.destroyed = true; };
  log.ress.push(res);
  cb(res);
  setImmediate(() => {
    for (const c of chunks) res.emit("data", Buffer.from(c));
    if (mode === "end") { res.complete = complete; res.emit("end"); res.emit("close"); }
    else if (mode === "close") res.emit("close");
    else if (mode === "aborted") res.emit("aborted");
    else if (mode === "error") res.emit("error", new Error(`SENTINEL res ${KEY}`));
  });
}
function countingTimers() {
  const t = { set: 0, cleared: 0, live: new Set() };
  t.setTimeout = (fn, ms) => { t.set += 1; const h = setTimeout(() => { t.live.delete(h); fn(); }, ms); t.live.add(h); return h; };
  t.clearTimeout = (h) => { t.cleared += 1; t.live.delete(h); clearTimeout(h); };
  return t;
}
const goodInput = (pl = plan("en")) => ({ method: "POST", host: "api.resend.com", path: "/emails", body: pl.body,
  headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", "Content-Length": String(pl.bodyBytes), "User-Agent": P.USER_AGENT,
    "Idempotency-Key": P.idempotencyKey(pl.planHash, RUN), Accept: "application/json", "Accept-Encoding": "identity" } });
const torn = (log) => log.agents.every((a) => a.destroyed) && log.reqs.every((r) => r.destroyed) && log.ress.every((r) => r.destroyed);

test("R9 real exchange (fake https primitive): fixed host / port / method / path, strict TLS options, own non-keep-alive Agent, exact headers + body written once; success returns status / 3 allowlisted headers / body; req, res and Agent destroyed; the timer cleared", async () => {
  const f = fakeHttps(({ cb, log }) => respond(log, cb, { headers: { "content-type": "application/json", "idempotent-replayed": "false", "set-cookie": "SENTINEL" } }));
  const tm = countingTimers();
  const rx = X.createResendExchange({ https: f.https, timers: tm });
  assert.equal(rx.ok, true);
  assert.deepEqual([f.log.requests, f.log.agents.length, tm.set], [0, 0, 0], "inert on creation");
  const v = await rx.exchange(goodInput());
  const o = f.log.opts;
  assert.deepEqual([o.protocol, o.hostname, o.port, o.method, o.path, o.servername, o.rejectUnauthorized, o.minVersion], ["https:", "api.resend.com", 443, "POST", "/emails", "api.resend.com", true, "TLSv1.2"]);
  assert.ok(!("ca" in o) && !("host" in o) && !("lookup" in o) && !("checkServerIdentity" in o), "system CAs / default identity check only");
  assert.ok(o.signal instanceof AbortSignal);
  assert.deepEqual({ ...f.log.agents[0].o }, { keepAlive: false, maxSockets: 1 }); assert.equal(o.agent, f.log.agents[0]);
  assert.ok(JSON.stringify(o.headers) === JSON.stringify(goodInput().headers), "exact headers handed to node:https");
  assert.ok(f.log.written.equals(plan("en").body), "exact body written");
  assert.deepEqual([v.status, v.headers.contentType, v.headers.contentEncoding, v.headers.idempotentReplayed, v.body.toString()], [200, "application/json", null, "false", `{"id":"${UUID}"}`]);
  assert.deepEqual(Object.keys(v.headers).sort(), ["contentEncoding", "contentType", "idempotentReplayed"], "only three allowlisted response headers");
  assert.ok(torn(f.log), "request, response and Agent destroyed");
  assert.deepEqual([tm.set, tm.cleared, tm.live.size, f.log.requests], [1, 1, 0, 1]);
  // single use: a second call never touches the primitive
  await assert.rejects(rx.exchange(goodInput()), (e) => e.code === "EXCHANGE_SPENT" && e.message === "EXCHANGE_SPENT");
  assert.equal(f.log.requests, 1);
});

test("R10 real exchange faults (fake primitive), each FINAL with teardown: 3xx returned (never followed), Content-Length oversize, streamed oversize, gzip / br encoding, premature close / aborted / response error, request error (lost reply), stall → deadline, setup throw; errors are code-only", async () => {
  const big = "x".repeat(40000);
  const cases = [
    ["redirect 307 (no follow)", (c) => respond(c.log, c.cb, { status: 307, headers: { location: "https://evil.test/", "content-type": "text/html" }, chunks: [] }), { status: 307 }],
    ["content-length oversize", (c) => respond(c.log, c.cb, { headers: { "content-type": "application/json", "content-length": "65537" } }), "EXCHANGE_BODY_TOO_LARGE"],
    ["content-length malformed", (c) => respond(c.log, c.cb, { headers: { "content-type": "application/json", "content-length": "1e9" } }), "EXCHANGE_BODY_TOO_LARGE"],
    ["streamed oversize", (c) => respond(c.log, c.cb, { chunks: [big, big] }), "EXCHANGE_BODY_TOO_LARGE"],
    ["gzip", (c) => respond(c.log, c.cb, { headers: { "content-type": "application/json", "content-encoding": "gzip" } }), "EXCHANGE_ENCODING_REFUSED"],
    ["br", (c) => respond(c.log, c.cb, { headers: { "content-type": "application/json", "content-encoding": "br" } }), "EXCHANGE_ENCODING_REFUSED"],
    ["incomplete end", (c) => respond(c.log, c.cb, { complete: false }), "EXCHANGE_PREMATURE_CLOSE"],
    ["close without end", (c) => respond(c.log, c.cb, { mode: "close" }), "EXCHANGE_PREMATURE_CLOSE"],
    ["aborted", (c) => respond(c.log, c.cb, { mode: "aborted" }), "EXCHANGE_PREMATURE_CLOSE"],
    ["response error", (c) => respond(c.log, c.cb, { mode: "error" }), "EXCHANGE_NETWORK_ERROR"],
    ["status invalid", (c) => respond(c.log, c.cb, { status: 999 }), "EXCHANGE_STATUS_INVALID"],
    ["lost reply (request error after write)", (c) => c.req.emit("error", Object.assign(new Error(`SENTINEL ${KEY}`), { code: "ECONNRESET" })), "EXCHANGE_NETWORK_ERROR"],
    ["stall → deadline", () => {}, "EXCHANGE_DEADLINE"]];
  for (const [kind, onEnd, want] of cases) {
    const f = fakeHttps(onEnd); const tm = countingTimers();
    const rx = X.createResendExchange({ https: f.https, timers: tm, budgets: { maxBytes: 65536, deadlineMs: 150, attempts: 1 } });
    if (typeof want === "string") {
      await assert.rejects(rx.exchange(goodInput()), (e) => e.code === want && e.message === want && !String(e.stack).includes(KEY), kind);
    } else {
      const v = await rx.exchange(goodInput());
      assert.equal(v.status, want.status, kind);
    }
    assert.equal(f.log.requests, 1, `${kind}: exactly one request, never a second (no redirect follow / retry)`);
    assert.ok(torn(f.log), `${kind}: teardown`);
    assert.deepEqual([tm.set, tm.cleared, tm.live.size], [1, 1, 0], `${kind}: the one timer is cleared`);
  }
  // setup throw (request() throws synchronously)
  const f = fakeHttps("throw"); const tm = countingTimers();
  const rx = X.createResendExchange({ https: f.https, timers: tm });
  await assert.rejects(rx.exchange(goodInput()), (e) => e.code === "EXCHANGE_SETUP_FAILED" && !e.message.includes("SENTINEL"));
  assert.ok(f.log.agents.every((a) => a.destroyed)); assert.equal(tm.live.size, 0);
});

test("R11 real exchange input / option refusals happen BEFORE any socket: wrong method / host / path, CRLF header value, bad header name, Content-Length mismatch, compression allowed, non-bytes body; budgets above the caps or attempts ≠ 1", async () => {
  const g = goodInput();
  const bad = { method: { ...g, method: "GET" }, host: { ...g, host: "api.resend.com.evil.test" }, path: { ...g, path: "/emails/batch" }, crlf: { ...g, headers: { ...g.headers, "User-Agent": "x\r\nX-Evil: 1" } },
    name: { ...g, headers: { ...g.headers, "Bad Name": "1" } }, length: { ...g, headers: { ...g.headers, "Content-Length": "1" } }, encoding: { ...g, headers: { ...g.headers, "Accept-Encoding": "gzip" } },
    "string body": { ...g, body: "x" }, "no headers": { ...g, headers: null }, "not object": null };
  for (const [kind, input] of Object.entries(bad)) {
    const f = fakeHttps(() => assert.fail("no request")); const tm = countingTimers();
    const rx = X.createResendExchange({ https: f.https, timers: tm });
    await assert.rejects(rx.exchange(input), (e) => e.code === "EXCHANGE_INPUT_INVALID", kind);
    assert.deepEqual([f.log.requests, f.log.agents.length, tm.set], [0, 0, 0], kind);
    await assert.rejects(rx.exchange(goodInput()), (e) => e.code === "EXCHANGE_SPENT", `${kind}: spent even after a refused call`);
  }
  for (const budgets of [{ maxBytes: 65537, deadlineMs: 10000, attempts: 1 }, { maxBytes: 65536, deadlineMs: 10001, attempts: 1 }, { maxBytes: 65536, deadlineMs: 10000, attempts: 2 }, { maxBytes: 0, deadlineMs: 1, attempts: 1 }, null]) {
    assert.deepEqual({ ...X.createResendExchange({ https: fakeHttps(() => {}).https, budgets }) }, { ok: false, code: "EXCHANGE_OPTIONS_INVALID" });
  }
  assert.deepEqual({ ...X.createResendExchange({ https: {} }) }, { ok: false, code: "EXCHANGE_OPTIONS_INVALID" });
});

test("R12 end to end through the REAL exchange (fake primitive): runSend → ONE request with the exact plan bytes → PROVIDER_ACCEPTED; a stall → UNKNOWN_STOP EXCHANGE_DEADLINE with exactly one request; sanitized output carries no key / contact / subject / body / exception / provider text", async () => {
  const outs = [];
  for (const [locale, onEnd, want] of [["en", (c) => respond(c.log, c.cb), "PROVIDER_ACCEPTED"], ["es", () => {}, "UNKNOWN_STOP"],
    ["en", (c) => respond(c.log, c.cb, { status: 422, chunks: ['{"name":"validation_error","message":"SENTINEL-REPLY guest@example.com"}'] }), "UNKNOWN_STOP"]]) {
    const f = fakeHttps(onEnd);
    const rx = X.createResendExchange({ https: f.https, budgets: { maxBytes: 65536, deadlineMs: 150, attempts: 1 } });
    const pl = plan(locale);
    const r = await P.runSend({ plan: pl, runId: RUN, runAttempt: "1", expectedPlanHash: pl.planHash, credential: () => KEY, exchange: rx.exchange });
    assert.equal(r.outcome, want, locale); assert.equal(f.log.requests, 1); assert.ok(f.log.written.equals(pl.body)); assert.ok(torn(f.log));
    outs.push(JSON.stringify(r), P.formatResult(r));
  }
  for (const o of outs) {
    for (const bad of [KEY, "Bearer", "SENTINEL", "guest@example.com", "delivered@resend.dev", "onboarding@resend.dev", "maraVilla booking", "reservaci", "Payment received", "Pago recibido", "validation_error"]) {
      assert.ok(!o.includes(bad), `sanitized output excludes ${bad.slice(0, 12)}`);
    }
  }
  assert.match(outs[1], /outcome=PROVIDER_ACCEPTED stop=- attempts=1 httpStatus=200 emailId=49a3999c-0ce1-4ea6-ab68-afcd6dc2e794 locale=en /);
  assert.match(outs[1], /not-real-inbox-proof;not-a-booking-notification/);
});

// ---------------------------------------------------------------------------------------------
// CLI in child processes (a preloaded throwing node:https / fetch guard; only modes / gates that refuse before any send)

const guardFile = (() => { const d = mkdtempSync(join(tmpdir(), "e7-c42-guard-")); const f = join(d, "guard.mjs");
  writeFileSync(f, 'import https from "node:https"; import http from "node:http"; import { syncBuiltinESMExports } from "node:module";\n'
    + 'const no = () => { process.stdout.write("CHILD_NETWORK_ATTEMPT\\n"); process.exit(97); };\nhttps.request = no; https.get = no; https.Agent = function () { no(); }; http.request = no; globalThis.fetch = no; syncBuiltinESMExports();\n');
  return f; })();
const cli = (args, env) => { const r = spawnSync(process.execPath, ["--import", guardFile, join(ROOT, "scripts/e7-resend-sink-probe.mjs"), ...args], { encoding: "utf8",
  env: { PATH: process.env.PATH, E7_TOOLING_DIR: TOOLING, ...env } }); return { status: r.status, out: (r.stdout || "") + (r.stderr || "") }; };

test("R13 CLI (child process, network guard preloaded): --dry / --preflight print the plan with ZERO network and never read the key; --send with attempt > 1, a wrong / missing plan hash, or no key refuses before any socket; inert on import", async () => {
  for (const locale of ["en", "es"]) {
    const d = cli(["--dry"], { E7_LOCALE: locale, E7_RESEND_TEST_KEY: KEY });
    assert.equal(d.status, 0, d.out);
    assert.match(d.out, new RegExp(`PLAN locale=${locale} method=POST host=api\\.resend\\.com path=/emails bodyBytes=${PINNED[locale].bytes} bodyHash=${PINNED[locale].bodyHash} planHash=${PINNED[locale].planHash} .*network=none`));
    const p = cli(["--preflight"], { E7_LOCALE: locale, GITHUB_RUN_ID: RUN, GITHUB_RUN_ATTEMPT: "1", E7_EXPECTED_PLAN_HASH: PINNED[locale].planHash });
    assert.equal(p.status, 0, p.out); assert.match(p.out, /PREFLIGHT ok: PLAN/);
    for (const o of [d.out, p.out]) assert.ok(!o.includes(KEY) && !o.includes("CHILD_NETWORK_ATTEMPT") && !o.includes("maraVilla booking") && !o.includes("delivered@"));
  }
  for (const [env, why] of [[{ GITHUB_RUN_ATTEMPT: "2" }, /RUN_ATTEMPT_NOT_1 \(no key read, no network\)/], [{ GITHUB_RUN_ATTEMPT: "" }, /RUN_ATTEMPT_NOT_1/],
    [{ E7_EXPECTED_PLAN_HASH: PINNED.es.planHash }, /PLAN_HASH_MISMATCH/], [{ E7_EXPECTED_PLAN_HASH: "" }, /PLAN_HASH_INVALID/], [{ GITHUB_RUN_ID: "x" }, /RUN_ID_INVALID/],
    [{ E7_RESEND_TEST_KEY: "" }, /outcome=REFUSED_BEFORE_NETWORK stop=KEY_INVALID attempts=0/], [{ E7_LOCALE: "fr" }, /LOCALE_INVALID/], [{ E7_TOOLING_DIR: "/nonexistent" }, /TOOLING_INVALID/]]) {
    const r = cli(["--send"], { E7_LOCALE: "en", GITHUB_RUN_ID: RUN, GITHUB_RUN_ATTEMPT: "1", E7_EXPECTED_PLAN_HASH: PINNED.en.planHash, E7_RESEND_TEST_KEY: KEY, ...env });
    assert.ok(r.status === 2 || r.status === 1, r.out); assert.match(r.out, why); assert.ok(!r.out.includes("CHILD_NETWORK_ATTEMPT") && !r.out.includes(KEY), r.out);
  }
  assert.match(cli(["--bogus"], {}).out, /usage: --dry \| --preflight \| --send/);
  // inert on import: importing the probe in a guarded child prints nothing and opens nothing
  const imp = spawnSync(process.execPath, ["--import", guardFile, "--input-type=module", "-e", `await import(${JSON.stringify(join(ROOT, "scripts/e7-resend-sink-probe.mjs"))}); process.stdout.write("IMPORTED\\n");`], { encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.equal(imp.stdout, "IMPORTED\n");
});

test("R14 source surface: probe imports only node built-ins + its own exchange; the exchange imports only node:https; no SDK / fetch / child_process / DB / worker / gn-v2 builder / frozen transports; process.env read only inside the CLI block", () => {
  const probe = readFileSync(join(ROOT, "scripts/e7-resend-sink-probe.mjs"), "utf8"); const ex = readFileSync(join(ROOT, "scripts/e7-resend/resend-exchange.mjs"), "utf8");
  const imports = (s) => [...s.matchAll(/^import\s[\s\S]*?from\s+"([^"]+)";?$/gm)].map((m) => m[1]);
  assert.deepEqual(imports(probe), ["node:crypto", "node:fs/promises", "node:path", "node:url", "./e7-resend/resend-exchange.mjs"]);
  assert.deepEqual(imports(ex), ["node:https"]);
  const code = (s) => s.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const s of [code(probe), code(ex)]) assert.ok(!/fetch\(|child_process|require\(|resend["']\)|from "resend"|booking-db|notification-worker|booking-confirmation-request|real-exchange|http-transports|DATABASE|pg\b/.test(s));
  const cliAt = probe.indexOf("if (import.meta.main === true)");
  assert.ok(cliAt > 0 && !code(probe.slice(0, cliAt)).includes("process.env") && !code(ex).includes("process.env"), "env read only in the CLI block");
  assert.ok(!code(probe).includes("http://") && (code(probe) + code(ex)).match(/api\.resend\.com/g).length === 1, "one host literal (the exchange constant)");
  assert.ok(probe.includes("delivered@resend.dev") && !/delivered\+/.test(code(probe)), "no +label recipient in code");
});
