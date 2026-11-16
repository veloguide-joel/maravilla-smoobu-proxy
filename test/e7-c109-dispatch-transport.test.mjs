// test/e7-c109-dispatch-transport.test.mjs — Stage E7 C109 (OFFLINE, no DB, no network): the single-use GitHub workflow_dispatch transport.
// FAKE exchange for the adapter; FAKE node:https primitive for the exchange. No live HTTP, no credential (synthetic token strings only).
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as T from "../lib/booking-db/pipeline-dispatch-transport.js";
import { kickoffDispatch, PINNED_REVISION, WORKFLOW_INPUT_KEYS } from "../lib/checkout/pipeline-kickoff-plan.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OPEN = Object.freeze({ ...T.GITHUB_DISPATCH_CONSTANTS, enabled: true });
const TOKEN = ["synthetic", "token", "for", "tests", "only", "0000"].join("_");           // shape-valid, not a credential
const PIN = PINNED_REVISION.wrapperCommit;
const CLOSED_MAIN = "a726d8ca80ec55c4334ba1bc88e4cd7cac8aa4fb";                             // the current CLOSED main (must never match)
const bound = (o = {}) => ({ intentId: "2b7c5a10-0f3e-4d1a-9c2b-7e5f4a3b2c1d", ref: "MV-ABCD1234", authorizedVersion: 4, paymentIntentId: "pi_3TestKickoff0001",
  amountMinor: 14000, currency: "USD", listingId: 606998, notBefore: "2026-11-16T00:00:01.234Z", ...o });
/** exactly what the C108 consumer passes: freeze({ workflow, ref, inputs }) with the frozen inputs of kickoffDispatch */
const goodCall = (o) => Object.freeze({ workflow: "e7-hosted-pipeline.yml", ref: "main", inputs: kickoffDispatch(bound(o)).inputs });
const refJson = (sha = PIN, o = {}) => Buffer.from(JSON.stringify({ ref: "refs/heads/main", node_id: "REF_x", url: "https://api.github.com/repos/x/y/git/refs/heads/main",
  object: { type: "commit", sha, url: `https://api.github.com/repos/x/y/git/commits/${sha}` }, ...o }));
const reply = (status, bytes = Buffer.alloc(0), o = {}) => Object.freeze({ status, contentType: "application/json; charset=utf-8", contentEncoding: null, bytes, complete: true, ...o });
/** fake exchange: records calls (never the token); `script[kind]` answers */
function fakeEx(script = {}) {
  const calls = [];
  const ex = async (spec) => {
    calls.push({ kind: spec.kind, tokenOk: spec.token === TOKEN, timeoutMs: spec.timeoutMs, body: spec.body ? spec.body.toString("utf8") : null, signal: spec.signal });
    const f = script[spec.kind] ?? (spec.kind === "getMain" ? async () => reply(200, refJson()) : async () => reply(204));
    return f(spec);
  };
  ex.calls = calls; return ex;
}
const mk = (o = {}) => { let credCalls = 0; const credential = () => { credCalls += 1; return o.token ?? TOKEN; };
  const ex = o.ex ?? fakeEx(o.script); const d = T.createGithubWorkflowDispatch({ credential: o.credential ?? credential, constants: o.constants ?? OPEN, exchange: ex, now: o.now });
  return { d, ex, creds: () => credCalls }; };
const sig = () => new AbortController().signal;

test("G1 SHIPPED CLOSED and config-pinned: default constants → TRANSPORT_CLOSED; any host / path / workflow / ref / API-version / header / pin / bound override → CONFIG_REFUSED; neither the credential nor the exchange is touched", async () => {
  assert.equal(T.GITHUB_DISPATCH_CONSTANTS.enabled, false);
  { const m = mk({ constants: T.GITHUB_DISPATCH_CONSTANTS }); assert.deepEqual(await m.d(goodCall(), { signal: sig() }), { notSent: true, code: "TRANSPORT_CLOSED" }); assert.deepEqual([m.creds(), m.ex.calls.length], [0, 0]); }
  for (const [k, v] of [["host", "evil.example"], ["port", 8443], ["owner", "x"], ["repo", "y"], ["workflowFile", "other.yml"], ["ref", "dev"], ["expectedMainSha", CLOSED_MAIN],
    ["getPath", "/repos/x/y/git/ref/heads/dev"], ["postPath", "/repos/x/y/actions/workflows/1/dispatches"], ["apiVersion", "2026-03-10"], ["accept", "*/*"], ["userAgent", "u"],
    ["getTimeoutMs", 60000], ["maxGetBytes", 1e9]]) {
    const m = mk({ constants: { ...OPEN, [k]: v } });
    assert.deepEqual(await m.d(goodCall(), { signal: sig() }), { notSent: true, code: "CONFIG_REFUSED" }, k); assert.deepEqual([m.creds(), m.ex.calls.length], [0, 0], k);
  }
  { const m = mk({ constants: { ...OPEN, extra: 1 } }); assert.equal((await m.d(goodCall(), { signal: sig() })).code, "CONFIG_REFUSED"); }
  { const m = mk({ credential: "not-a-function" }); assert.equal((await m.d(goodCall(), { signal: sig() })).code, "CREDENTIAL_ABSENT"); assert.equal(m.ex.calls.length, 0); }
});

test("G2 the EXACT frozen C108 call, re-proved by the accepted kickoff builder: workflow / ref / key order / extra / missing / non-string inputs, any binding drift, a bad plan hash, the source / closure pins, excluded / pre-cutoff targets → notSent with 0 network and 0 credential reads", async () => {
  const g = goodCall();
  const variants = [
    ["not frozen", { ...g }],
    ["extra top key", Object.freeze({ ...g, url: "x" })],
    ["key order", Object.freeze({ ref: g.ref, workflow: g.workflow, inputs: g.inputs })],
    ["workflow", Object.freeze({ ...g, workflow: "other.yml" })],
    ["ref", Object.freeze({ ...g, ref: "refs/heads/main" })],
    ["inputs not frozen", Object.freeze({ ...g, inputs: { ...g.inputs } })],
    ["inputs order", Object.freeze({ ...g, inputs: Object.freeze(Object.fromEntries([...WORKFLOW_INPUT_KEYS].reverse().map((k) => [k, g.inputs[k]]))) })],
    ["extra input", Object.freeze({ ...g, inputs: Object.freeze({ ...g.inputs, x: "1" }) })]];
  for (const [k, v] of [["amount_minor", "14001"], ["amount_minor", "014000"], ["expected_version", "5"], ["expected_plan_hash", "0".repeat(64)], ["expected_source_digest", "a".repeat(64)],
    ["expected_closure_digest", "b".repeat(64)], ["approval_ref", "E7-KICKOFF-MV-ABCD1234-v5"], ["mode", "preflight"], ["currency", "MXN"], ["intent_id", "1d6e770f-ba3d-40f7-92c1-ee01be7da532"],
    ["not_before", "2026-11-15T22:58:00.999Z"], ["booking_ref", "MV-ZZZZ9999"]]) {
    variants.push([`${k}=${v}`, Object.freeze({ ...g, inputs: Object.freeze({ ...g.inputs, [k]: v }) })]);
  }
  for (const [label, call] of variants) {
    const m = mk(); const r = await m.d(call, { signal: sig() });
    assert.equal(r.notSent, true, label); assert.ok(typeof r.code === "string" && /^[A-Z0-9_:]{1,96}$/.test(r.code), label);
    assert.deepEqual([m.creds(), m.ex.calls.length], [0, 0], label);
  }
  for (const id of ["1d6e770f-ba3d-40f7-92c1-ee01be7da532", "669da884-02e8-4105-8825-f908e5d22ae9"]) {
    assert.throws(() => goodCall({ intentId: id }));                                 // the builder itself refuses the historical targets
  }
  { const m = mk(); assert.equal((await m.d(goodCall(), {})).code, "SIGNAL_ABSENT"); assert.equal(m.ex.calls.length, 0); }
  { const m = mk(); const ac = new AbortController(); ac.abort(); assert.equal((await m.d(goodCall(), { signal: ac.signal })).code, "ABORTED_BEFORE_GET"); assert.equal(m.ex.calls.length, 0); }
});

test("G3 happy path: ONE GET of refs/heads/main bound to the reviewed ENABLE pin, then ONE POST with the exact body; only 204 + empty completed → {accepted:true}; the adapter is single-use (a second call → notSent, 0 network)", async () => {
  const m = mk(); const call = goodCall();
  assert.deepEqual(await m.d(call, { signal: sig() }), { accepted: true });
  assert.deepEqual(m.ex.calls.map((c) => [c.kind, c.tokenOk]), [["getMain", true], ["dispatch", true]]);
  assert.equal(m.ex.calls[1].body, JSON.stringify({ ref: "main", inputs: { ...call.inputs }, return_run_details: false }));
  assert.deepEqual(Object.keys(JSON.parse(m.ex.calls[1].body).inputs), [...WORKFLOW_INPUT_KEYS]);
  assert.ok(m.ex.calls[0].timeoutMs <= OPEN.getTimeoutMs && m.ex.calls[1].timeoutMs <= OPEN.postTimeoutMs);
  assert.equal(m.creds(), 1);
  assert.deepEqual(await m.d(call, { signal: sig() }), { notSent: true, code: "TRANSPORT_SINGLE_USE" }); assert.equal(m.ex.calls.length, 2);
});

test("G4 the main gate: another SHA (incl. the current CLOSED main), malformed / foreign JSON, a tag / non-commit object, wrong ref, non-JSON type, encoded body, 404 / 409 / 500, a thrown / timed-out GET, a deadline → typed notSent with 0 POST", async () => {
  const cases = [
    ["closed main", async () => reply(200, refJson(CLOSED_MAIN)), "MAIN_NOT_PINNED_ENABLE"],
    ["foreign sha", async () => reply(200, refJson("f".repeat(40))), "MAIN_NOT_PINNED_ENABLE"],
    ["uppercase sha", async () => reply(200, refJson(PIN.toUpperCase())), "MAIN_READ_INVALID"],
    ["tag object", async () => reply(200, refJson(PIN, { object: { type: "tag", sha: PIN } })), "MAIN_READ_INVALID"],
    ["wrong ref", async () => reply(200, refJson(PIN, { ref: "refs/heads/dev" })), "MAIN_READ_INVALID"],
    ["array (matching refs)", async () => reply(200, Buffer.from(JSON.stringify([JSON.parse(refJson().toString())]))), "MAIN_READ_INVALID"],
    ["malformed json", async () => reply(200, Buffer.from("{")), "MAIN_READ_INVALID"],
    ["html type", async () => reply(200, refJson(), { contentType: "text/html" }), "MAIN_READ_INVALID"],
    ["gzip", async () => reply(200, refJson(), { contentEncoding: "gzip" }), "MAIN_READ_INVALID"],
    ["incomplete", async () => reply(200, refJson(), { complete: false }), "MAIN_READ_INVALID"],
    ["404", async () => reply(404, Buffer.from("{}")), "MAIN_READ_STATUS"],
    ["409", async () => reply(409, Buffer.from("{}")), "MAIN_READ_STATUS"],
    ["301", async () => reply(301), "MAIN_READ_STATUS"],
    ["throws", async () => { throw new T.GithubExchangeError("EXCHANGE_NETWORK_ERROR"); }, "MAIN_READ_FAILED"],
    ["timeout", async () => { throw new T.GithubExchangeError("EXCHANGE_TIMEOUT"); }, "MAIN_READ_FAILED"]];
  for (const [label, getMain, code] of cases) {
    const m = mk({ script: { getMain } }); const r = await m.d(goodCall(), { signal: sig() });
    assert.deepEqual(r, { notSent: true, code }, label); assert.deepEqual(m.ex.calls.map((c) => c.kind), ["getMain"], `${label}: 0 POST`);
  }
  { let t = 0; const m = mk({ now: () => t, script: { getMain: async () => { t += OPEN.totalTimeoutMs; return reply(200, refJson()); } } });
    assert.deepEqual(await m.d(goodCall(), { signal: sig() }), { notSent: true, code: "DEADLINE_AFTER_GET" }); assert.equal(m.ex.calls.length, 1); }
});

test("G5 every POST fault is UNKNOWN and never re-posted: thrown / timeout / abort / network, 200 (+run details), 202, 500, 422, 401, 302, 204 with a body, incomplete, malformed reply", async () => {
  const cases = [
    ["throw", async () => { throw new Error("x"); }, "POST_THREW"],
    ["timeout", async () => { throw new T.GithubExchangeError("EXCHANGE_TIMEOUT"); }, "POST_EXCHANGE_TIMEOUT"],
    ["network", async () => { throw new T.GithubExchangeError("EXCHANGE_NETWORK_ERROR"); }, "POST_EXCHANGE_NETWORK_ERROR"],
    ["premature", async () => { throw new T.GithubExchangeError("EXCHANGE_PREMATURE_CLOSE"); }, "POST_EXCHANGE_PREMATURE_CLOSE"],
    ["200 run details", async () => reply(200, Buffer.from(JSON.stringify({ workflow_run_id: 1, run_url: "u", html_url: "h" }))), "POST_200_NOT_ACCEPTED"],
    ["202", async () => reply(202), "POST_STATUS_NOT_204"], ["500", async () => reply(500, Buffer.from("{}")), "POST_STATUS_NOT_204"],
    ["422", async () => reply(422, Buffer.from("{}")), "POST_STATUS_NOT_204"], ["401", async () => reply(401, Buffer.from("{}")), "POST_STATUS_NOT_204"],
    ["302", async () => reply(302), "POST_REDIRECT"], ["204 with body", async () => reply(204, Buffer.from(" ")), "POST_STATUS_NOT_204"],
    ["incomplete", async () => reply(204, Buffer.alloc(0), { complete: false }), "POST_REPLY_MALFORMED"], ["null", async () => null, "POST_REPLY_MALFORMED"]];
  for (const [label, dispatch, code] of cases) {
    const m = mk({ script: { dispatch } }); const r = await m.d(goodCall(), { signal: sig() });
    assert.deepEqual(r, { unknown: true, code }, label); assert.deepEqual(m.ex.calls.map((c) => c.kind), ["getMain", "dispatch"], `${label}: exactly one POST`);
    assert.equal((await m.d(goodCall(), { signal: sig() })).code, "TRANSPORT_SINGLE_USE"); assert.equal(m.ex.calls.length, 2, `${label}: never re-posted`);
  }
});

test("G6 cancellation: aborted DURING the GET whose result arrives LATE → notSent, 0 POST; aborted between GET and POST → notSent; aborted DURING the POST → UNKNOWN; two concurrent calls → ONE winner", async () => {
  { const ac = new AbortController(); let release; const m = mk({ script: { getMain: () => new Promise((r) => { release = () => r(reply(200, refJson())); }) } });
    const p = m.d(goodCall(), { signal: ac.signal }); await new Promise((r) => setImmediate(r)); ac.abort(); release();
    assert.deepEqual(await p, { notSent: true, code: "ABORTED_AFTER_GET" }); assert.deepEqual(m.ex.calls.map((c) => c.kind), ["getMain"]); }
  { const ac = new AbortController(); const m = mk({ script: { getMain: async () => { ac.abort(); return reply(200, refJson()); } } });
    assert.deepEqual(await m.d(goodCall(), { signal: ac.signal }), { notSent: true, code: "ABORTED_AFTER_GET" }); assert.equal(m.ex.calls.length, 1); }
  { const ac = new AbortController(); const m = mk({ script: { dispatch: async () => { ac.abort(); throw new T.GithubExchangeError("EXCHANGE_ABORTED"); } } });
    assert.deepEqual(await m.d(goodCall(), { signal: ac.signal }), { unknown: true, code: "POST_EXCHANGE_ABORTED" }); assert.equal(m.ex.calls.length, 2); }
  { const m = mk(); const [a, b] = await Promise.all([m.d(goodCall(), { signal: sig() }), m.d(goodCall(), { signal: sig() })]);
    assert.deepEqual([a, b], [{ accepted: true }, { notSent: true, code: "TRANSPORT_SINGLE_USE" }]); assert.equal(m.ex.calls.filter((c) => c.kind === "dispatch").length, 1); }
});

test("G7 the credential: read once, only after the gate / config / contract / signal pass; a throwing getter or a malformed value → notSent, 0 network; it is never echoed in any result", async () => {
  for (const [label, credential, code] of [["throws", () => { throw new Error("vault down"); }, "CREDENTIAL_UNAVAILABLE"], ["empty", () => "", "CREDENTIAL_INVALID"],
    ["whitespace", () => `${TOKEN} `, "CREDENTIAL_INVALID"], ["newline", () => `${TOKEN}\nX-Evil: 1`, "CREDENTIAL_INVALID"], ["number", () => 42, "CREDENTIAL_INVALID"]]) {
    const m = mk({ credential }); assert.deepEqual(await m.d(goodCall(), { signal: sig() }), { notSent: true, code }, label); assert.equal(m.ex.calls.length, 0, label);
  }
  const m = mk({ script: { dispatch: async () => reply(500, Buffer.from(JSON.stringify({ message: `Bad credentials ${TOKEN}` }))) } });
  const r = await m.d(goodCall(), { signal: sig() });
  assert.doesNotMatch(JSON.stringify(r), /synthetic_token|Bad credentials/);
});

// ---- the narrow node:https exchange (FAKE primitive) --------------------------------------------------------------------------------
function fakePrimitive(responder) {
  const log = { agents: [], requests: [] };
  class Agent { constructor(opts) { this.opts = opts; this.destroyed = false; log.agents.push(this); } destroy() { this.destroyed = true; } }
  const request = (opts) => {
    const req = new EventEmitter(); req.opts = opts; req.written = null; req.destroyed = false;
    req.end = (b) => { req.written = b ?? null; setImmediate(() => responder(req)); };
    req.destroy = () => { req.destroyed = true; };
    log.requests.push(req); return req;
  };
  return { primitive: { request, Agent }, log };
}
const respond = (req, status, headers = {}, chunks = [], o = {}) => {
  const res = new EventEmitter(); res.statusCode = status; res.headers = headers; res.destroyed = false; res.destroy = () => { res.destroyed = true; };
  req.res = res; req.emit("response", res);
  if (o.stall) return;
  for (const c of chunks) res.emit("data", Buffer.from(c));
  if (o.closeEarly) { res.emit("close"); return; }
  res.emit("end"); res.emit("close");
};
const body = Buffer.from(JSON.stringify({ ref: "main", inputs: {}, return_run_details: false }));

test("G8 exchange wire: fixed host api.github.com:443 + SNI, rejectUnauthorized true, no ca / proxy / lookup override, own non-keep-alive Agent (destroyed every time), exact method / path / headers per kind, body written once", async () => {
  const { primitive, log } = fakePrimitive((req) => respond(req, req.opts.method === "GET" ? 200 : 204, req.opts.method === "GET" ? { "content-type": "application/json" } : {},
    req.opts.method === "GET" ? [refJson()] : []));
  const ex = T.createGithubExchange({ primitive });
  const g = await ex({ kind: "getMain", token: TOKEN, signal: sig(), timeoutMs: 1000 });
  const p = await ex({ kind: "dispatch", token: TOKEN, body, signal: sig(), timeoutMs: 1000 });
  assert.equal(g.status, 200); assert.deepEqual(JSON.parse(g.bytes.toString()).object.sha, PIN); assert.deepEqual([p.status, p.bytes.length, p.complete], [204, 0, true]);
  const [rg, rp] = log.requests;
  for (const r of [rg, rp]) {
    assert.deepEqual(Object.keys(r.opts).sort(), ["agent", "headers", "host", "method", "path", "port", "protocol", "rejectUnauthorized", "servername"]);
    assert.deepEqual([r.opts.protocol, r.opts.host, r.opts.port, r.opts.servername, r.opts.rejectUnauthorized], ["https:", "api.github.com", 443, "api.github.com", true]);
    assert.ok(log.agents.includes(r.opts.agent)); assert.deepEqual(r.opts.agent.opts, { keepAlive: false, maxSockets: 1, maxCachedSessions: 0 });
  }
  assert.deepEqual([rg.opts.method, rg.opts.path, rp.opts.method, rp.opts.path], ["GET", "/repos/veloguide-joel/maravilla-smoobu-proxy/git/ref/heads/main",
    "POST", "/repos/veloguide-joel/maravilla-smoobu-proxy/actions/workflows/e7-hosted-pipeline.yml/dispatches"]);
  const base = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "maravilla-e7-pipeline-kickoff/1", Authorization: `Bearer ${TOKEN}`, "Accept-Encoding": "identity" };
  assert.deepEqual(rg.opts.headers, base); assert.deepEqual(rp.opts.headers, { ...base, "Content-Type": "application/json", "Content-Length": String(body.length) });
  assert.equal(rg.written, null); assert.ok(rp.written.equals(body));
  assert.ok(log.agents.every((a) => a.destroyed), "every Agent destroyed"); assert.equal(log.agents.length, 2, "one fresh Agent per exchange");
});

test("G9 exchange faults: oversize (header and streamed), gzip, a 3xx is never followed (body unread), premature close, request error, timeout (headers or body never arrive) and abort destroy req / res / Agent, clear the timer, and a LATE response is never processed; invalid inputs are refused before any request", async () => {
  const run = async (responder, spec = {}) => { const { primitive, log } = fakePrimitive(responder); const ex = T.createGithubExchange({ primitive });
    try { const v = await ex({ kind: "getMain", token: TOKEN, signal: sig(), timeoutMs: 50, ...spec }); return { v, log }; } catch (e) { return { e, log }; } };
  const code = async (responder, spec) => { const r = await run(responder, spec); return [r.e ? r.e.code : r.v.status, r.log]; };
  assert.equal((await code((req) => respond(req, 200, { "content-length": "999999" }, [])))[0], "EXCHANGE_BODY_TOO_LARGE");
  assert.equal((await code((req) => respond(req, 200, {}, ["x".repeat(T.GITHUB_DISPATCH_CONSTANTS.maxGetBytes + 1)])))[0], "EXCHANGE_BODY_TOO_LARGE");
  assert.equal((await code((req) => respond(req, 200, { "content-encoding": "gzip" }, ["\x1f\x8b"])))[0], "EXCHANGE_ENCODING_REFUSED");
  { const [s, log] = await code((req) => respond(req, 302, { location: "https://evil.example/" }, ["redirect body"])); assert.equal(s, 302);
    assert.equal(log.requests.length, 1, "no redirect follow"); assert.ok(log.requests[0].res.destroyed); }
  assert.equal((await code((req) => respond(req, 200, {}, ["{"], { closeEarly: true })))[0], "EXCHANGE_PREMATURE_CLOSE");
  assert.equal((await code((req) => req.emit("error", new Error("ECONNRESET token=" + TOKEN))))[0], "EXCHANGE_NETWORK_ERROR");
  { const [c, log] = await code(() => {}); assert.equal(c, "EXCHANGE_TIMEOUT"); assert.ok(log.requests[0].destroyed && log.agents[0].destroyed); }
  { let lateReq; const [c, log] = await code((req) => { lateReq = req; respond(req, 200, {}, [], { stall: true }); }); assert.equal(c, "EXCHANGE_TIMEOUT");
    assert.ok(lateReq.res.destroyed && log.agents[0].destroyed, "body never arriving is bounded too"); }
  { let late; const { primitive, log } = fakePrimitive((req) => { late = req; }); const ex = T.createGithubExchange({ primitive });
    await assert.rejects(ex({ kind: "getMain", token: TOKEN, signal: sig(), timeoutMs: 20 }), (e) => e.code === "EXCHANGE_TIMEOUT");
    const res = new EventEmitter(); res.statusCode = 200; res.headers = {}; let d = false; res.destroy = () => { d = true; }; late.emit("response", res);
    assert.ok(d, "a late response is destroyed, never processed"); assert.ok(log.agents[0].destroyed); }
  { const ac = new AbortController(); const { primitive, log } = fakePrimitive(() => { ac.abort(); }); const ex = T.createGithubExchange({ primitive });
    await assert.rejects(ex({ kind: "getMain", token: TOKEN, signal: ac.signal, timeoutMs: 1000 }), (e) => e.code === "EXCHANGE_ABORTED"); assert.ok(log.requests[0].destroyed && log.agents[0].destroyed); }
  for (const spec of [{ kind: "delete" }, { token: "bad token" }, { timeoutMs: 999999 }, { body }, { kind: "dispatch", body: Buffer.alloc(T.GITHUB_DISPATCH_CONSTANTS.maxPostBodyBytes + 1) },
    { kind: "dispatch", body: "string" }, { signal: null }]) {
    const { e, log } = await run(() => {}, spec); assert.equal(e.code, "EXCHANGE_INPUT_INVALID", JSON.stringify(Object.keys(spec))); assert.equal(log.requests.length + log.agents.length, 0);
  }
});

test("G10 static: no process.env / no other host / only the two fixed paths / no redirect-follow or retry code; the transport is imported by NO route or other module (unwired); the shipped consumer stays closed", async () => {
  const src = readFileSync(join(ROOT, "lib/booking-db/pipeline-dispatch-transport.js"), "utf8");
  assert.doesNotMatch(src, /process\.env|fetch\(|octokit|follow-redirects|retry\s*\(|maxRedirects/);
  const hosts = [...src.matchAll(/[a-z0-9.-]+\.(com|net|io|org|example)\b/g)].map((m) => m[0]).filter((h) => !/^(api\.github\.com|github\.blog)$/.test(h) && h !== "docs.github.com");
  assert.deepEqual([...new Set(hosts)], [], "no other host literal");
  const walk = (d) => readdirSync(join(ROOT, d)).flatMap((n) => (statSync(join(ROOT, d, n)).isDirectory() ? (n === "node_modules" ? [] : walk(`${d}/${n}`)) : [`${d}/${n}`]));
  const importers = [...walk("lib"), ...walk("api"), ...walk("scripts")].filter((f) => /\.(m?js)$/.test(f) && f !== "lib/booking-db/pipeline-dispatch-transport.js")
    .filter((f) => /pipeline-dispatch-transport/.test(readFileSync(join(ROOT, f), "utf8")));
  assert.deepEqual(importers, [], "nothing imports the transport");
  const { KICKOFF_CONSTANTS } = await import("../lib/booking-db/pipeline-kickoff.js");
  assert.equal(KICKOFF_CONSTANTS.dispatchEnabled, false); assert.equal(T.GITHUB_DISPATCH_CONSTANTS.enabled, false);
  assert.equal(T.GITHUB_DISPATCH_CONSTANTS.expectedMainSha, "9455bc9ee15370b5321b7a04a96e893e9e80080b");
  assert.ok(T.GITHUB_DISPATCH_CONSTANTS.totalTimeoutMs < KICKOFF_CONSTANTS.dispatchTimeoutMs, "the transport settles before the consumer's own bound");
});
