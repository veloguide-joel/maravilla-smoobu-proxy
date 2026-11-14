// test/e7-resend-notification-executor.test.mjs — C45: the gn-v2 → Resend provider executor (pure adapter) + its composition with the
// reviewed exchange copied byte-identically from main #111. FAKE network only: every real network primitive is replaced by a throwing guard
// BEFORE any import; the real exchange runs against an injected FAKE https primitive. Synthetic `.invalid` addresses only; no key, no provider.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const GUARD = { request: 0, Agent: 0, fetch: 0, http: 0 };
https.request = () => { GUARD.request += 1; throw new Error("network refused"); };
https.get = () => { GUARD.request += 1; throw new Error("network refused"); };
https.Agent = class { constructor() { GUARD.Agent += 1; throw new Error("network refused"); } };
http.request = () => { GUARD.http += 1; throw new Error("network refused"); };
globalThis.fetch = async () => { GUARD.fetch += 1; throw new Error("network refused"); };
syncBuiltinESMExports();
after(() => assert.deepEqual(GUARD, { request: 0, Agent: 0, fetch: 0, http: 0 }, "no real network primitive touched"));

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const E = await import("../lib/notify/resend-notification-executor.js");
const X = await import("../scripts/e7-resend/resend-exchange.mjs");
const { buildBookingConfirmationRequest, contentHashV2 } = await import("../lib/checkout/booking-confirmation-request.js");
const gn = await import("../lib/checkout/guest-notification.js");
const sha = (b) => createHash("sha256").update(b).digest("hex");

const OP = "00000000-0000-4000-8000-0000000000a1";
const FACTS = Object.freeze({ ref: "MV-ABC123", checkIn: "2026-12-04", checkOut: "2026-12-06", nights: 2, guests: 2, totalMinor: 123456, currency: "USD" });
const GUEST = Object.freeze({ email: "guest.v@mv-test.invalid", firstName: "Synthia" });
const SENDER = Object.freeze({ fromAddress: "bookings@sender.mv-test.invalid", fromName: "maraVilla Test" });
const KEY = "re_SENTINELkey0123456789";
const UUID = "4ef9a417-02e9-4d39-ad75-9611e0fa754d";
const built = (locale, over = {}) => { const b = buildBookingConfirmationRequest({ template: "booking_confirmed", locale, facts: { ...FACTS }, guest: { ...GUEST }, sender: { ...SENDER }, opId: OP, ...over }); assert.equal(b.ok, true); return b; };
const ok200 = (h = {}) => ({ status: 200, headers: { contentType: "application/json", contentEncoding: null, idempotentReplayed: null, ...h }, body: Buffer.from(`{"id":"${UUID}"}`) });
function mk(reply = () => ok200(), over = {}) {
  const s = { calls: 0, reqs: [], cred: 0 };
  const r = E.createResendNotificationExecutor({ exchange: (req) => { s.calls += 1; s.reqs.push(req); return reply(req, s.calls); }, credential: () => { s.cred += 1; return KEY; }, sender: { ...SENDER }, ...over });
  assert.equal(r.ok, true); s.ex = r.executor; return s;
}
const EN_SUBJECT = "Your maraVilla booking MV-ABC123 is confirmed";
const ES_SUBJECT = "Tu reservación de maraVilla MV-ABC123 está confirmada";

test("X1 constants + provenance: the exchange is byte-identical to main #111 (49d9a75f / 65a58cbb / 79c9de1b: 19dae6de…); fixed route; executor surface; branded instances only", () => {
  assert.equal(sha(readFileSync(join(ROOT, "scripts/e7-resend/resend-exchange.mjs"))), "19dae6de5657e1d06a41a68c76bbb53abff07948a3536f8a80cff4204f9f0e99");
  assert.deepEqual([E.RESEND_METHOD, E.RESEND_HOST, E.RESEND_PATH], [X.RESEND_METHOD, X.RESEND_HOST, X.RESEND_PATH]);
  assert.deepEqual([E.RESEND_METHOD, E.RESEND_HOST, E.RESEND_PATH], ["POST", "api.resend.com", "/emails"]);
  assert.deepEqual([...E.WIRE_KEYS], ["from", "to", "subject", "text"]);
  assert.deepEqual([...E.HEADER_NAMES], ["Authorization", "Content-Type", "Content-Length", "User-Agent", "Idempotency-Key", "Accept", "Accept-Encoding"]);
  assert.equal(E.RESEND_EXECUTOR_PROTOCOL, "resend-gn2-v1");
  const s = mk();
  assert.deepEqual(Object.keys(s.ex).sort(), ["isSpent", "prepare", "protocol", "send", "sender"]);
  assert.ok(Object.isFrozen(s.ex) && Object.isFrozen(s.ex.sender));
  assert.equal(E.isResendNotificationExecutor(s.ex), true);
  for (const fake of [{ ...s.ex }, Object.create(s.ex), { protocol: "resend-gn2-v1", sender: SENDER, prepare: () => ({ ok: true }), send: async () => ({}), isSpent: () => false }, null, undefined, 1]) {
    assert.equal(E.isResendNotificationExecutor(fake), false, "look-alikes are not executors");
  }
});

test("X2 construction binding: exact option keys; sender inside the EXISTING .invalid scope + SENDER_NAME_RE; exchange / credential functions; nothing else", () => {
  const good = { exchange: () => {}, credential: () => KEY, sender: { ...SENDER } };
  for (const [kind, over, code] of [["extra key", { ...good, recipient: "x" }, "EXECUTOR_OPTIONS_INVALID"], ["no exchange", { ...good, exchange: undefined }, "EXECUTOR_OPTIONS_INVALID"],
    ["credential string", { ...good, credential: KEY }, "EXECUTOR_OPTIONS_INVALID"], ["real sender domain", { ...good, sender: { fromAddress: "bookings@maravillanayarit.com", fromName: "maraVilla" } }, "EXECUTOR_SENDER_INVALID"],
    ["resend onboarding sender", { ...good, sender: { fromAddress: "onboarding@resend.dev", fromName: "maraVilla TEST" } }, "EXECUTOR_SENDER_INVALID"],
    ["name with <>", { ...good, sender: { ...SENDER, fromName: "x <y>" } }, "EXECUTOR_SENDER_INVALID"], ["sender extra", { ...good, sender: { ...SENDER, replyTo: "a@b.invalid" } }, "EXECUTOR_SENDER_INVALID"]]) {
    assert.deepEqual({ ...E.createResendNotificationExecutor(over) }, { ok: false, code }, kind);
  }
  const acc = { ...good }; let n = 0; Object.defineProperty(acc, "exchange", { enumerable: true, get() { n += 1; return () => {}; } });
  assert.equal(E.createResendNotificationExecutor(acc).ok, false); assert.equal(n, 0, "accessor never invoked");
  for (const bad of [null, [], "x", Object.create({ exchange: () => {} })]) assert.equal(E.createResendNotificationExecutor(bad).ok, false);
});

test("X2b C54 exact approved real sender: construction accepts ONLY the exact pair; wire `from` uses it; recipient scope unchanged (.example refused at prepare / send); variants refused", async () => {
  const { APPROVED_REAL_SENDER } = await import("../lib/notify/sender-identity.js");
  const REAL = { ...APPROVED_REAL_SENDER };
  const good = { exchange: () => {}, credential: () => KEY };
  for (const sender of [{ ...REAL, fromAddress: "Bookings@mail.micasadirect.com" }, { ...REAL, fromAddress: "bookings@micasadirect.com" }, { ...REAL, fromAddress: "bookings@x.mail.micasadirect.com" },
    { ...REAL, fromAddress: "bookings@mail.micasadirect.com." }, { ...REAL, fromName: "micasadirect" }, { ...REAL, fromName: "MiCasaDirect Test" }, { ...REAL, fromName: "maraVilla" }, { ...REAL, replyTo: "a@b.invalid" }, Object.create(REAL), { fromAddress: "bookings@mail.maravillanayarit.com", fromName: "maraVilla" } /* superseded 2026-11-14 */]) {
    assert.deepEqual({ ...E.createResendNotificationExecutor({ ...good, sender }) }, { ok: false, code: "EXECUTOR_SENDER_INVALID" }, JSON.stringify(sender));
  }
  const s = mk(() => ok200(), { sender: { ...REAL } });
  assert.deepEqual({ ...s.ex.sender }, REAL);
  const b = built("en", { sender: { ...REAL } });
  const out = await s.ex.send({ request: b.request, opId: OP, contentHash: b.contentHash });
  assert.equal(out.kind, "accepted"); assert.equal(s.calls, 1);
  assert.equal(JSON.parse(s.reqs[0].body.toString("utf8")).from, "MiCasaDirect <bookings@mail.micasadirect.com>");
  assert.deepEqual(JSON.parse(s.reqs[0].body.toString("utf8")).to, [GUEST.email]);
  // a synthetic-sender request is NOT accepted by a real-sender executor (sender binding unchanged)
  const s2 = mk(() => ok200(), { sender: { ...REAL } }); const syn = built("en");
  const o2 = await s2.ex.send({ request: syn.request, opId: OP, contentHash: syn.contentHash });
  assert.notEqual(o2.kind, "accepted"); assert.equal(s2.calls, 0, "sender mismatch refused pre-exchange");
  // a real recipient never gets in: the builder refuses it, and a hand-forged request with an .example recipient is refused before the exchange
  const s3 = mk(() => ok200(), { sender: { ...REAL } });
  const forged = { ...b.request, to: "guest@example.com" };
  const o3 = await s3.ex.send({ request: forged, opId: OP, contentHash: contentHashV2(forged) });
  assert.notEqual(o3.kind, "accepted"); assert.equal(s3.calls, 0, "real recipient refused pre-exchange");
});

test("X3 EN / ES exact wire bytes: body is exactly {from:'<name> <addr>', to:[guest], subject, text} from the frozen gn-v2 request (no rewrite); headers / idempotency key exact; ONE exchange; accepted", async () => {
  for (const [locale, subj] of [["en", EN_SUBJECT], ["es", ES_SUBJECT]]) {
    const b = built(locale); const s = mk();
    const out = await s.ex.send({ request: b.request, opId: OP, contentHash: b.contentHash });
    assert.deepEqual({ ...out }, { kind: "accepted", provider: "resend", providerMessageId: UUID, replayed: false }, locale);
    assert.ok(Object.isFrozen(out)); assert.deepEqual([s.calls, s.cred], [1, 1]);
    const q = s.reqs[0];
    assert.deepEqual(Object.keys(q).sort(), ["body", "headers", "host", "method", "path"]);
    assert.deepEqual([q.method, q.host, q.path], ["POST", "api.resend.com", "/emails"]);
    const want = `{"from":"maraVilla Test <bookings@sender.mv-test.invalid>","to":["guest.v@mv-test.invalid"],"subject":${JSON.stringify(subj)},"text":${JSON.stringify(b.request.text)}}`;
    assert.ok(Buffer.from(q.body).equals(Buffer.from(want, "utf8")), `${locale}: exact body bytes (boolean compare)`);
    const parsed = JSON.parse(Buffer.from(q.body).toString("utf8"));
    assert.deepEqual(Object.keys(parsed), ["from", "to", "subject", "text"], "no cc / bcc / reply_to / html / attachments / tags / headers / scheduled_at");
    assert.ok(parsed.to.length === 1 && parsed.to[0] === b.request.to && parsed.subject === b.request.subject && parsed.text === b.request.text, "recipient / subject / text unchanged");
    const key = `mv-gn2-resend-v1/${OP}/${b.contentHash}`;
    assert.ok(key.length <= 256);
    assert.ok(JSON.stringify(Object.entries(q.headers)) === JSON.stringify([["Authorization", `Bearer ${KEY}`], ["Content-Type", "application/json"], ["Content-Length", String(Buffer.byteLength(want, "utf8"))],
      ["User-Agent", E.RESEND_USER_AGENT], ["Idempotency-Key", key], ["Accept", "application/json"], ["Accept-Encoding", "identity"]]), `${locale}: exact header bytes`);
    const p = s.ex.prepare({ request: b.request, opId: OP, contentHash: b.contentHash }); // prepare is pure and repeatable (no credential, no exchange)
    assert.ok(p.ok && p.plan.idempotencyKey === key && p.plan.bodyHash === sha(Buffer.from(want, "utf8")));
    assert.deepEqual([s.calls, s.cred], [1, 1]);
  }
  // the content hash binds every one of the 11 request fields; the key binds op + content
  assert.notEqual(built("en").contentHash, built("es").contentHash);
});

test("X4 refusals BEFORE the exchange (kind 'refused', zero exchange calls, zero credential calls): spoofed hash, rewritten recipient / sender / subject / locale, wrong op / messageRef, gn-v1 request, non-frozen / extra / accessor / Proxy shapes, out-of-scope recipient even with a recomputed hash", async () => {
  const b = built("en"); const r = b.request;
  const rehash = (req) => contentHashV2(req);
  const mut = (o) => Object.freeze({ ...r, ...o });
  const v1 = gn.buildMessageRequest({ template: "booking_confirmed", facts: { v: 1, template: "booking_confirmed", ...FACTS }, guest: { ...GUEST }, sender: { ...SENDER }, opId: OP });
  const acc = { ...r }; Object.defineProperty(acc, "to", { enumerable: true, get() { throw new Error("SENTINEL"); } }); Object.freeze(acc);
  const cases = [
    ["spoofed hash", { request: r, opId: OP, contentHash: "f".repeat(64) }, "CONTENT_HASH_MISMATCH"],
    ["recipient rewrite (stale hash)", { request: mut({ to: "other@mv-test.invalid" }), opId: OP, contentHash: b.contentHash }, "CONTENT_HASH_MISMATCH"],
    ["recipient real domain (hash recomputed)", { request: mut({ to: "guest@gmail.com" }), opId: OP, contentHash: rehash(mut({ to: "guest@gmail.com" })) }, "RECIPIENT_SCOPE"],
    ["recipient Resend sink (hash recomputed)", { request: mut({ to: "delivered@resend.dev" }), opId: OP, contentHash: rehash(mut({ to: "delivered@resend.dev" })) }, "RECIPIENT_SCOPE"],
    ["sender rewrite (hash recomputed)", { request: mut({ from: "x@other.invalid" }), opId: OP, contentHash: rehash(mut({ from: "x@other.invalid" })) }, "SENDER_BINDING"],
    ["sender name rewrite (hash recomputed)", { request: mut({ fromName: "Other" }), opId: OP, contentHash: rehash(mut({ fromName: "Other" })) }, "SENDER_BINDING"],
    ["subject rewrite (stale hash)", { request: mut({ subject: "x" }), opId: OP, contentHash: b.contentHash }, "CONTENT_HASH_MISMATCH"],
    ["locale rewrite (stale hash)", { request: mut({ locale: "es" }), opId: OP, contentHash: b.contentHash }, "CONTENT_HASH_MISMATCH"],
    ["subject CRLF (hash recomputed)", { request: mut({ subject: "a\r\nBcc: x" }), opId: OP, contentHash: rehash(mut({ subject: "a\r\nBcc: x" })) }, "CONTENT_INVALID"],
    ["other op", { request: r, opId: "00000000-0000-4000-8000-0000000000a2", contentHash: b.contentHash }, "OP_REF_MISMATCH"],
    ["messageRef gn1 (hash recomputed)", { request: mut({ messageRef: `gn1-${OP}` }), opId: OP, contentHash: rehash(mut({ messageRef: `gn1-${OP}` })) }, "OP_REF_MISMATCH"],
    ["gn-v1 request", { request: v1.request, opId: OP, contentHash: gn.contentHash(v1.request) }, "REQUEST_SHAPE"],
    ["version swap (hash recomputed)", { request: mut({ templateVersion: "gn-v1" }), opId: OP, contentHash: rehash(mut({ templateVersion: "gn-v1" })) }, "REQUEST_VERSION"],
    ["copy swap", { request: mut({ copyContractVersion: "bcc-v0" }), opId: OP, contentHash: rehash(mut({ copyContractVersion: "bcc-v0" })) }, "REQUEST_VERSION"],
    ["non-frozen", { request: { ...r }, opId: OP, contentHash: b.contentHash }, "REQUEST_SHAPE"],
    ["extra cc", { request: Object.freeze({ ...r, cc: "x@y.invalid" }), opId: OP, contentHash: b.contentHash }, "REQUEST_SHAPE"],
    ["html", { request: Object.freeze({ ...r, html: "<p>" }), opId: OP, contentHash: b.contentHash }, "REQUEST_SHAPE"],
    ["accessor", { request: acc, opId: OP, contentHash: b.contentHash }, "REQUEST_SHAPE"],
    ["proxy throws (frozen target)", { request: new Proxy(Object.freeze({ ...r }), { ownKeys: () => { throw new Error("SENTINEL"); } }), opId: OP, contentHash: b.contentHash }, "REQUEST_SHAPE"],
    ["proxy lies about keys", { request: new Proxy(Object.freeze({ ...r }), { getOwnPropertyDescriptor: (t, k) => (k === "to" ? { value: "x@gmail.com", enumerable: true, configurable: false, writable: false } : Reflect.getOwnPropertyDescriptor(t, k)) }), opId: OP, contentHash: b.contentHash }, "REQUEST_SHAPE"],
    ["extra input key", { request: r, opId: OP, contentHash: b.contentHash, to: "x@y.z" }, "INPUT_INVALID"],
    ["bad hash grammar", { request: r, opId: OP, contentHash: b.contentHash.toUpperCase() }, "INPUT_INVALID"]];
  for (const [kind, arg, code] of cases) {
    const s = mk();
    assert.deepEqual({ ...s.ex.prepare(arg) }, { ok: false, code }, `prepare: ${kind}`);
    const out = await s.ex.send(arg);
    assert.deepEqual([{ ...out }, s.calls, s.cred], [{ kind: "refused", code }, 0, 0], `send: ${kind}`);
    assert.ok(!JSON.stringify(out).includes("SENTINEL"));
  }
  // key grammar refusal: the credential is read, the exchange is not called
  for (const k of [undefined, "", "sk_live_x", "re_abc def0123", "re_abc\r\nX: 1"]) {
    const s = { calls: 0 };
    const ex = E.createResendNotificationExecutor({ exchange: () => { s.calls += 1; }, credential: () => k, sender: { ...SENDER } }).executor;
    assert.deepEqual([{ ...(await ex.send({ request: r, opId: OP, contentHash: b.contentHash })) }, s.calls], [{ kind: "refused", code: "KEY_INVALID" }, 0]);
  }
});

test("X5 single use: a second send (even after a refusal) is EXECUTOR_SPENT with no exchange; isSpent reflects it", async () => {
  const b = built("es"); const s = mk();
  assert.equal(s.ex.isSpent(), false);
  await s.ex.send({ request: b.request, opId: OP, contentHash: b.contentHash });
  assert.equal(s.ex.isSpent(), true);
  assert.deepEqual({ ...(await s.ex.send({ request: b.request, opId: OP, contentHash: b.contentHash })) }, { kind: "refused", code: "EXECUTOR_SPENT" });
  assert.equal(s.calls, 1);
  const s2 = mk(); await s2.ex.send({ request: b.request, opId: OP, contentHash: "0".repeat(64) });
  assert.deepEqual([{ ...(await s2.ex.send({ request: b.request, opId: OP, contentHash: b.contentHash })) }, s2.calls], [{ kind: "refused", code: "EXECUTOR_SPENT" }, 0]);
});

test("X6 reply classification: 200 exact UUID → accepted (replay flagged honestly); 201 / 3xx / 409 / 429 / 5xx, content type, malformed / extra / PII-shaped JSON, bad id, bad replay header, exchange throws (lost reply / deadline / spent / unknown) → code-only unknown; ONE exchange call each", async () => {
  const b = built("en"); const arg = { request: b.request, opId: OP, contentHash: b.contentHash };
  const H = (o = {}) => ({ contentType: "application/json", contentEncoding: null, idempotentReplayed: null, ...o });
  const rep = (status, body, h) => () => ({ status, headers: H(h), body: Buffer.from(body) });
  const s0 = mk(() => ok200({ idempotentReplayed: "true" }));
  assert.deepEqual({ ...(await s0.ex.send(arg)) }, { kind: "accepted", provider: "resend", providerMessageId: UUID, replayed: true });
  const cases = [...[201, 202, 301, 307, 308, 400, 401, 403, 409, 422, 429, 500, 503].map((st) => [`status ${st}`, rep(st, `{"id":"${UUID}"}`), "HTTP_STATUS"]),
    ["text/html", rep(200, `{"id":"${UUID}"}`, { contentType: "text/html" }), "REPLY_CONTENT_TYPE"], ["not json", rep(200, "SENTINEL ok"), "REPLY_JSON_INVALID"],
    ["extra key", rep(200, `{"id":"${UUID}","object":"email"}`), "REPLY_SHAPE"], ["PII-shaped", rep(200, `{"id":"${UUID}","to":"SENTINEL-guest@example.com"}`), "REPLY_SHAPE"],
    ["id email", rep(200, '{"id":"SENTINEL-guest@example.com"}'), "REPLY_ID_INVALID"], ["id upper", rep(200, `{"id":"${UUID.toUpperCase()}"}`), "REPLY_ID_INVALID"],
    ["replay junk", rep(200, `{"id":"${UUID}"}`, { idempotentReplayed: "yes" }), "REPLAY_HEADER_INVALID"], ["null reply", () => null, "REPLY_SHAPE"],
    ["lost reply", () => Promise.reject(Object.assign(new Error(`SENTINEL ${KEY}`), { code: "EXCHANGE_NETWORK_ERROR" })), "EXCHANGE_NETWORK_ERROR"],
    ["deadline", () => Promise.reject(Object.assign(new Error("x"), { code: "EXCHANGE_DEADLINE" })), "EXCHANGE_DEADLINE"],
    ["sync throw", () => { throw Object.assign(new Error("SENTINEL"), { code: "EXCHANGE_SETUP_FAILED" }); }, "EXCHANGE_SETUP_FAILED"],
    ["foreign code", () => Promise.reject(Object.assign(new Error("SENTINEL"), { code: "ECONNRESET" })), "EXCHANGE_UNKNOWN"], ["no code", () => Promise.reject(new Error("SENTINEL")), "EXCHANGE_UNKNOWN"]];
  for (const [kind, reply, code] of cases) {
    const s = mk(reply); const out = await s.ex.send(arg);
    assert.equal(out.kind, "unknown", kind); assert.equal(out.code, code, kind); assert.equal(s.calls, 1, kind);
    assert.ok(!JSON.stringify(out).includes("SENTINEL") && !JSON.stringify(out).includes(KEY) && !JSON.stringify(out).includes("@"), kind);
  }
});

// ---------------------------------------------------------------------------------------------
// the REAL reviewed exchange (copied from main) against a FAKE https primitive, composed with the executor

function fakeHttps(onEnd) {
  const log = { requests: 0, opts: null, written: null, agents: [], reqs: [], ress: [] };
  class Agent { constructor(o) { this.o = o; this.destroyed = false; log.agents.push(this); } destroy() { this.destroyed = true; } }
  const request = (opts, cb) => {
    log.requests += 1; log.opts = opts;
    const req = new EventEmitter(); req.destroyed = false; req.destroy = () => { req.destroyed = true; };
    req.end = (b) => { log.written = Buffer.from(b); setImmediate(() => onEnd({ req, cb, log })); };
    log.reqs.push(req); return req;
  };
  return { https: { request, Agent }, log };
}
function respond(log, cb, { status = 200, headers = { "content-type": "application/json" }, chunks = [`{"id":"${UUID}"}`] } = {}) {
  const res = new EventEmitter(); res.statusCode = status; res.headers = headers; res.complete = false; res.destroyed = false; res.destroy = () => { res.destroyed = true; };
  log.ress.push(res); cb(res);
  setImmediate(() => { for (const c of chunks) res.emit("data", Buffer.from(c)); res.complete = true; res.emit("end"); res.emit("close"); });
}

test("X7 composed with the REAL reviewed exchange (fake https primitive): fixed host / port / path / TLS options, own non-keep-alive Agent, exact bytes written once; 200 → accepted; 307 → HTTP_STATUS (never followed); gzip → EXCHANGE_ENCODING_REFUSED; stall → EXCHANGE_DEADLINE; teardown on every path", async () => {
  const b = built("es"); const arg = { request: b.request, opId: OP, contentHash: b.contentHash };
  for (const [kind, onEnd, want] of [["200", (c) => respond(c.log, c.cb, { headers: { "content-type": "application/json", "idempotent-replayed": "false" } }), "accepted"],
    ["307", (c) => respond(c.log, c.cb, { status: 307, headers: { location: "https://evil.test/" }, chunks: [] }), "HTTP_STATUS"],
    ["gzip", (c) => respond(c.log, c.cb, { headers: { "content-type": "application/json", "content-encoding": "gzip" } }), "EXCHANGE_ENCODING_REFUSED"],
    ["stall", () => {}, "EXCHANGE_DEADLINE"]]) {
    const f = fakeHttps(onEnd);
    const rx = X.createResendExchange({ https: f.https, budgets: { maxBytes: 65536, deadlineMs: 150, attempts: 1 } });
    const ex = E.createResendNotificationExecutor({ exchange: rx.exchange, credential: () => KEY, sender: { ...SENDER } }).executor;
    const out = await ex.send(arg);
    assert.equal(out.kind === "accepted" ? "accepted" : out.code, want, kind);
    const o = f.log.opts;
    assert.deepEqual([o.hostname, o.port, o.method, o.path, o.servername, o.rejectUnauthorized, o.minVersion], ["api.resend.com", 443, "POST", "/emails", "api.resend.com", true, "TLSv1.2"], kind);
    assert.deepEqual({ ...f.log.agents[0].o }, { keepAlive: false, maxSockets: 1 });
    assert.ok(f.log.written.equals(ex.prepare(arg).plan.body), `${kind}: exact body written`);
    assert.equal(f.log.requests, 1, `${kind}: one request, no follow / retry`);
    assert.ok(f.log.agents.every((a) => a.destroyed) && f.log.reqs.every((r) => r.destroyed) && f.log.ress.every((r) => r.destroyed), `${kind}: teardown`);
  }
});

test("X8 source surface: the executor imports only node:crypto + the two accepted pure modules; no network / env / fs / SDK; no fixed real sender / recipient", () => {
  const src = readFileSync(join(ROOT, "lib/notify/resend-notification-executor.js"), "utf8");
  assert.deepEqual([...src.matchAll(/^import\s[\s\S]*?from\s+"([^"]+)";?$/gm)].map((m) => m[1]), ["node:crypto", "../checkout/guest-notification.js", "../checkout/booking-confirmation-request.js"]);
  const code = src.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(!/process\.|fetch\(|require\(|node:https|node:http|node:fs|setTimeout|console\.|resend\.dev|maravillanayarit|@gmail/.test(code));
});
