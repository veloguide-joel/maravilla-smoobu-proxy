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
  for (const [label, credential, code] of [["throws", () => { throw new Error("vault down"); }, "CREDENTIAL_UNAVAILABLE"], ["empty", () => "", "CREDENTIAL_EMPTY"],
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
const body = T.dispatchBodyFor(goodCall().inputs);                                  // the ONE approved body grammar (C110-F3)

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
    const { e, log } = await run(() => {}, spec);
    assert.equal(e.code, spec.kind === "dispatch" ? "EXCHANGE_PHASE_REFUSED" : "EXCHANGE_INPUT_INVALID", JSON.stringify(Object.keys(spec)));   // a POST before the GET is a phase refusal
    assert.equal(log.requests.length + log.agents.length, 0);
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

// ---- C110 regressions -------------------------------------------------------------------------------------------------------------
test("G11 C110-F1 late POST acceptance: an abort or the total deadline reached while the ONE POST is outstanding → UNKNOWN even if a 204 arrives afterwards (immediately or delayed); still exactly ONE POST, never re-sent", async () => {
  { const ac = new AbortController(); const m = mk({ script: { dispatch: async () => { ac.abort(); return reply(204); } } });
    assert.deepEqual(await m.d(goodCall(), { signal: ac.signal }), { unknown: true, code: "POST_ABORTED_BEFORE_REPLY_ACCEPTED" }); assert.equal(m.ex.calls.length, 2); }
  { const ac = new AbortController(); const m = mk({ script: { dispatch: () => new Promise((r) => { setTimeout(() => ac.abort(), 5); setTimeout(() => r(reply(204)), 20); }) } });
    assert.deepEqual(await m.d(goodCall(), { signal: ac.signal }), { unknown: true, code: "POST_ABORTED_BEFORE_REPLY_ACCEPTED" }, "delayed 204 after abort"); }
  { let t = 0; const m = mk({ now: () => t, script: { dispatch: async () => { t += OPEN.totalTimeoutMs; return reply(204); } } });
    assert.deepEqual(await m.d(goodCall(), { signal: sig() }), { unknown: true, code: "POST_DEADLINE_BEFORE_REPLY_ACCEPTED" }); assert.equal(m.ex.calls.length, 2);
    assert.equal((await m.d(goodCall(), { signal: sig() })).code, "TRANSPORT_SINGLE_USE"); assert.equal(m.ex.calls.length, 2); }
  { let t = 0; const m = mk({ now: () => t, script: { dispatch: () => new Promise((r) => setTimeout(() => { t += OPEN.totalTimeoutMs + 1; r(reply(204)); }, 10)) } });
    assert.equal((await m.d(goodCall(), { signal: sig() })).code, "POST_DEADLINE_BEFORE_REPLY_ACCEPTED", "delayed 204 past the deadline"); }
  { const m = mk(); assert.deepEqual(await m.d(goodCall(), { signal: sig() }), { accepted: true }, "the normal 204 path is unchanged"); }
});

test("G12 C110-F2 descriptor-only snapshots: an accessor whose value flips after the GET (ROOT reproducer), accessor / hidden / symbol / extra / same-length-renamed / non-plain-prototype / throwing-proxy inputs or call → notSent with 0 credential reads, 0 network and NO getter invoked; frozen null-proto and transparent-proxy data are accepted; the config is snapshotted once at construction (a getter refuses; a proxy's later [[Get]] values are never used)", async () => {
  const g = goodCall();
  // ROOT reproducer: frozen object, enumerable getter for amount_minor that changes after the GET
  { let changed = false; let getterCalls = 0; const i = { ...g.inputs };
    Object.defineProperty(i, "amount_minor", { enumerable: true, get: () => { getterCalls += 1; return changed ? "14001" : "14000"; } }); Object.freeze(i);
    const call = Object.freeze({ workflow: g.workflow, ref: g.ref, inputs: i });
    const m = mk({ script: { getMain: async () => { changed = true; return reply(200, refJson()); } } });
    assert.deepEqual(await m.d(call, { signal: sig() }), { notSent: true, code: "INPUTS_REFUSED" });
    assert.deepEqual([getterCalls, m.creds(), m.ex.calls.length], [0, 0, 0], "no getter invoked, 0 credential, 0 network"); }
  const withInputs = (i) => Object.freeze({ workflow: g.workflow, ref: g.ref, inputs: i });
  const negatives = [];
  { const i = { ...g.inputs }; Object.defineProperty(i, "zz_hidden", { enumerable: false, value: "x" }); negatives.push(["hidden key", withInputs(Object.freeze(i))]); }
  { const i = { ...g.inputs, [Symbol("s")]: "x" }; negatives.push(["symbol key", withInputs(Object.freeze(i))]); }
  { const i = {}; for (const k of WORKFLOW_INPUT_KEYS) i[k === "currency" ? "currencz" : k] = g.inputs[k]; negatives.push(["same-length rename", withInputs(Object.freeze(i))]); }
  { class Bag {} const i = Object.assign(new Bag(), g.inputs); negatives.push(["class prototype", withInputs(Object.freeze(i))]); }
  { const i = new Proxy(Object.freeze({ ...g.inputs }), { ownKeys() { throw new Error("trap"); } }); negatives.push(["throwing ownKeys trap", withInputs(i)]); }
  { const i = new Proxy(Object.freeze({ ...g.inputs }), { getOwnPropertyDescriptor(t, k) { if (k === "amount_minor") throw new Error("trap"); return Reflect.getOwnPropertyDescriptor(t, k); } });
    negatives.push(["throwing descriptor trap", withInputs(i)]); }
  { let n = 0; const c = { workflow: g.workflow, ref: g.ref }; Object.defineProperty(c, "inputs", { enumerable: true, get: () => { n += 1; return g.inputs; } });
    negatives.push(["accessor on call.inputs", Object.freeze(c)]); }
  { const c = { workflow: g.workflow, ref: g.ref, inputs: g.inputs }; Object.defineProperty(c, "x", { enumerable: false, value: 1 }); negatives.push(["hidden call key", Object.freeze(c)]); }
  for (const [label, call] of negatives) {
    const m = mk(); const r = await m.d(call, { signal: sig() });
    assert.equal(r.notSent, true, label); assert.match(r.code, /^(CALL_CONTRACT_REFUSED|INPUTS_REFUSED)$/, label); assert.deepEqual([m.creds(), m.ex.calls.length], [0, 0], label);
  }
  // a signal behind an accessor is refused too
  { const m = mk(); const o = {}; Object.defineProperty(o, "signal", { enumerable: true, get: () => sig() }); assert.equal((await m.d(goodCall(), o)).code, "SIGNAL_ABSENT"); assert.equal(m.ex.calls.length, 0); }
  // positive controls: null-prototype frozen data, a transparent proxy over frozen data
  { const i = Object.freeze(Object.assign(Object.create(null), g.inputs)); const m = mk(); assert.deepEqual(await m.d(withInputs(i), { signal: sig() }), { accepted: true }, "null-proto data"); }
  { const m = mk(); assert.deepEqual(await m.d(Object.freeze({ workflow: g.workflow, ref: g.ref, inputs: new Proxy(g.inputs, {}) }), { signal: sig() }), { accepted: true }, "transparent proxy"); }
  // the config: a getter → CONFIG_REFUSED, 0 credential VALUE reads; a proxy's [[Get]] is never consulted (only its data descriptors)
  { const c = { ...OPEN }; let n = 0; Object.defineProperty(c, "enabled", { enumerable: true, get: () => { n += 1; return true; } });
    const m = mk({ constants: c }); assert.deepEqual(await m.d(goodCall(), { signal: sig() }), { notSent: true, code: "CONFIG_REFUSED" }); assert.deepEqual([n, m.creds(), m.ex.calls.length], [0, 0, 0]); }
  { let gets = 0; const c = new Proxy({ ...OPEN }, { get(t, k) { gets += 1; return k === "expectedMainSha" ? CLOSED_MAIN : k === "enabled" ? false : Reflect.get(t, k); } });
    const m = mk({ constants: c }); assert.deepEqual(await m.d(goodCall(), { signal: sig() }), { accepted: true }, "the construction snapshot (descriptors) decides"); assert.equal(gets, 0); }
  { const c = { ...T.GITHUB_DISPATCH_CONSTANTS }; const m = mk({ constants: c }); c.enabled = true;   // mutated after construction: the snapshot (closed) holds
    assert.deepEqual(await m.d(goodCall(), { signal: sig() }), { notSent: true, code: "TRANSPORT_CLOSED" }); assert.deepEqual([m.creds(), m.ex.calls.length], [0, 0]); }
});

test("G13 C110-F3 the exchange is a ONE-GET-then-ONE-POST capability: a direct POST, a POST after a failed GET, a second / concurrent POST, a third call and a GET after the POST are refused pre-socket (code only, never reset); the POST body is independently validated (fixed grammar, ref main, return false, exact 12 bound inputs) and the APPROVED private copy is sent even if the caller's Buffer is mutated", async () => {
  const ok204 = (req) => respond(req, req.opts.method === "GET" ? 200 : 204, req.opts.method === "GET" ? { "content-type": "application/json" } : {}, req.opts.method === "GET" ? [refJson()] : []);
  const spec = (o) => ({ kind: "dispatch", token: TOKEN, body, signal: sig(), timeoutMs: 1000, ...o });
  const getSpec = { kind: "getMain", token: TOKEN, signal: sig(), timeoutMs: 1000 };
  const codeOf = (p) => p.then((v) => v.status, (e) => e.code);
  // ROOT reproducer: two direct POSTs on one instance
  { const { primitive, log } = fakePrimitive(ok204); const ex = T.createGithubExchange({ primitive });
    assert.deepEqual([await codeOf(ex(spec())), await codeOf(ex(spec()))], ["EXCHANGE_PHASE_REFUSED", "EXCHANGE_PHASE_REFUSED"]); assert.equal(log.requests.length, 0); }
  // the one allowed sequence, then everything after it is refused
  { const { primitive, log } = fakePrimitive(ok204); const ex = T.createGithubExchange({ primitive });
    assert.equal(await codeOf(ex(getSpec)), 200); assert.equal(await codeOf(ex(spec())), 204);
    assert.deepEqual([await codeOf(ex(spec())), await codeOf(ex(getSpec))], ["EXCHANGE_PHASE_REFUSED", "EXCHANGE_PHASE_REFUSED"]); assert.equal(log.requests.length, 2); }
  // concurrent POSTs after the GET → ONE request
  { const { primitive, log } = fakePrimitive(ok204); const ex = T.createGithubExchange({ primitive }); await ex(getSpec);
    const r = await Promise.all([codeOf(ex(spec())), codeOf(ex(spec()))]); assert.deepEqual(r.sort(), [204, "EXCHANGE_PHASE_REFUSED"].sort()); assert.equal(log.requests.length, 2); }
  // a failed / non-200 GET never unlocks the POST; a second GET is refused
  for (const resp of [(req) => respond(req, 500, {}, ["{}"]), (req) => req.emit("error", new Error("x")), (req) => respond(req, 301, {})]) {
    const { primitive, log } = fakePrimitive(resp); const ex = T.createGithubExchange({ primitive }); await codeOf(ex(getSpec));
    assert.deepEqual([await codeOf(ex(spec())), await codeOf(ex(getSpec))], ["EXCHANGE_PHASE_REFUSED", "EXCHANGE_PHASE_REFUSED"]); assert.equal(log.requests.length, 1); }
  // the body grammar (after a valid GET): every deviation → refused before a socket, and the instance is spent
  const g = goodCall(); const enc = (o) => Buffer.from(JSON.stringify(o));
  for (const [label, b] of [["empty inputs", enc({ ref: "main", inputs: {}, return_run_details: false })], ["ref dev", enc({ ref: "dev", inputs: g.inputs, return_run_details: false })],
    ["return true", enc({ ref: "main", inputs: g.inputs, return_run_details: true })], ["no return flag", enc({ ref: "main", inputs: g.inputs })],
    ["amount drift", enc({ ref: "main", inputs: { ...g.inputs, amount_minor: "14001" }, return_run_details: false })],
    ["plan hash drift", enc({ ref: "main", inputs: { ...g.inputs, expected_plan_hash: "0".repeat(64) }, return_run_details: false })],
    ["extra key", enc({ ref: "main", inputs: g.inputs, return_run_details: false, x: 1 })], ["key order", enc({ inputs: g.inputs, ref: "main", return_run_details: false })],
    ["whitespace", Buffer.from(JSON.stringify({ ref: "main", inputs: g.inputs, return_run_details: false }, null, 1))], ["not a Buffer", JSON.stringify({ ref: "main" })]]) {
    const { primitive, log } = fakePrimitive(ok204); const ex = T.createGithubExchange({ primitive }); await ex(getSpec);
    assert.equal(await codeOf(ex(spec({ body: b }))), "EXCHANGE_INPUT_INVALID", label); assert.equal(log.requests.length, 1, `${label}: no POST socket`);
    assert.equal(await codeOf(ex(spec())), "EXCHANGE_PHASE_REFUSED", `${label}: never reset for a retry`);
  }
  // the approved private copy is what goes on the wire, even if the caller's Buffer is mutated right after the call
  { const { primitive, log } = fakePrimitive(ok204); const ex = T.createGithubExchange({ primitive }); await ex(getSpec);
    const mine = Buffer.from(body); const p = ex(spec({ body: mine })); mine.fill(0x20); assert.equal(await codeOf(p), 204);
    assert.ok(log.requests[1].written.equals(body)); assert.notEqual(log.requests[1].written, mine); }
});

test("G14 C111 explicit construction-time release binding: { expectedMainSha } replaces ONLY the GET pin (descriptor-only snapshot); without it the default 9455 pin holds; malformed / accessor / extra-key / throwing bindings → CONFIG_REFUSED with 0 credential reads and 0 network; the call can never carry a binding", async () => {
  const REL = "0123456789abcdef0123456789abcdef01234567";
  const mkB = (releaseBinding, getSha) => { let credCalls = 0; const ex = fakeEx({ getMain: async () => reply(200, refJson(getSha)) });
    const d = T.createGithubWorkflowDispatch({ credential: () => { credCalls += 1; return TOKEN; }, constants: OPEN, exchange: ex, releaseBinding }); return { d, ex, creds: () => credCalls }; };
  { const m = mkB({ expectedMainSha: REL }, REL); assert.deepEqual(await m.d(goodCall(), { signal: sig() }), { accepted: true }); assert.deepEqual(m.ex.calls.map((c) => c.kind), ["getMain", "dispatch"]); }
  { const m = mkB({ expectedMainSha: REL }, PIN); assert.deepEqual(await m.d(goodCall(), { signal: sig() }), { notSent: true, code: "MAIN_NOT_PINNED_ENABLE" }, "the default pin no longer matches once bound"); assert.equal(m.ex.calls.length, 1); }
  { const m = mkB(Object.freeze(Object.assign(Object.create(null), { expectedMainSha: REL })), REL); assert.deepEqual(await m.d(goodCall(), { signal: sig() }), { accepted: true }, "null-proto data"); }
  { const m = mkB(undefined, PIN); assert.deepEqual(await m.d(goodCall(), { signal: sig() }), { accepted: true }, "no binding → default 9455 pin"); }
  { const m = mkB(undefined, REL); assert.equal((await m.d(goodCall(), { signal: sig() })).code, "MAIN_NOT_PINNED_ENABLE"); }
  const bad = [REL.toUpperCase(), REL.slice(1), `${REL}0`, "", null, 42];
  const getterB = {}; Object.defineProperty(getterB, "expectedMainSha", { enumerable: true, get: () => REL });
  const negatives = [...bad.map((v) => ({ expectedMainSha: v })), { expectedMainSha: REL, extra: 1 }, {}, getterB, null, "sha", new Proxy({ expectedMainSha: REL }, { ownKeys() { throw new Error("t"); } })];
  for (const b of negatives) {
    const m = mkB(b, REL); assert.deepEqual(await m.d(goodCall(), { signal: sig() }), { notSent: true, code: "CONFIG_REFUSED" }, String(b && b.expectedMainSha));
    assert.deepEqual([m.creds(), m.ex.calls.length], [0, 0]);
  }
  { const m = mkB({ expectedMainSha: REL }, REL); const call = Object.freeze({ ...goodCall(), expectedMainSha: REL });
    assert.equal((await m.d(call, { signal: sig() })).code, "CALL_CONTRACT_REFUSED"); assert.equal(m.ex.calls.length, 0); }
  { const m = T.createGithubWorkflowDispatch({ credential: () => TOKEN, constants: T.GITHUB_DISPATCH_CONSTANTS, exchange: fakeEx(), releaseBinding: { expectedMainSha: REL } });
    assert.deepEqual(await m(goodCall(), { signal: sig() }), { notSent: true, code: "TRANSPORT_CLOSED" }, "a binding never opens a closed transport"); }
});

// ---- C112 F1: GitHub built-in token shapes (synthetic, shape-only; never a credential, never decoded) ----
const seg = (n, salt) => Array.from({ length: n }, (_, i) => "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_"[(i * 7 + salt) % 38]).join("");
/** the stateless format: a ghs_-prefixed JWT-shaped string, ~520 chars, two dots, base64url hyphens / underscores (synthetic bytes) */
const NEW_TOKEN = `ghs_${seg(36, 1)}.${seg(380, 3)}.${seg(98, 5)}`;
const CLASSIC_GHS = `ghs_${seg(36, 2).replace(/-/g, "x")}`;
test("G15 C112-F1 token shapes: classic opaque AND the stateless ghs_ JWT-shaped GITHUB_TOKEN are accepted end-to-end through the REAL exchange (fake https) with the exact Bearer header; empty / non-string / whitespace / CR / LF / tab / NUL / unicode / standard-base64 '+' '/' '=' / dots outside ghs_ / oversize → notSent pre-network with a typed code and NO value-derived detail", async () => {
  assert.ok(NEW_TOKEN.length > 500 && NEW_TOKEN.length < 600 && NEW_TOKEN.split(".").length === 3 && /-/.test(NEW_TOKEN) && /_/.test(NEW_TOKEN.slice(4)));
  for (const tok of [TOKEN, CLASSIC_GHS, NEW_TOKEN, `ghs_${"a".repeat(36)}`, `ghs_${"a-b.c_".repeat(340)}`.slice(0, T.TOKEN_MAX_LENGTH)]) {
    assert.equal(T.githubTokenRefusal(tok), null, `accepted (len ${tok.length})`);
    const { primitive, log } = fakePrimitive((req) => respond(req, req.opts.method === "GET" ? 200 : 204, req.opts.method === "GET" ? { "content-type": "application/json" } : {},
      req.opts.method === "GET" ? [refJson()] : []));
    const m = mk({ token: tok, ex: T.createGithubExchange({ primitive }) });
    assert.deepEqual(await m.d(goodCall(), { signal: sig() }), { accepted: true });
    assert.equal(log.requests.length, 2); assert.ok(log.requests.every((r) => r.opts.headers.Authorization === `Bearer ${tok}`), "exact Bearer header, token passed through opaquely");
    assert.equal(m.creds(), 1);
  }
  const bad = [["empty", "", "CREDENTIAL_EMPTY"], ["number", 42, "CREDENTIAL_INVALID"], ["null", null, "CREDENTIAL_INVALID"],
    ["space", `${NEW_TOKEN} `, "CREDENTIAL_INVALID"], ["CRLF", `${NEW_TOKEN}\r\nX-Evil: 1`, "CREDENTIAL_INVALID"], ["LF", `ghs_${seg(40, 1)}\nx`, "CREDENTIAL_INVALID"],
    ["tab", `ghs_${seg(40, 1)}\t`, "CREDENTIAL_INVALID"], ["NUL", `ghs_${seg(40, 1)}\u0000`, "CREDENTIAL_INVALID"], ["unicode", `ghs_${seg(40, 1)}é`, "CREDENTIAL_INVALID"],
    ["plus", `ghs_${seg(40, 1)}+`, "CREDENTIAL_INVALID"], ["slash", `ghs_${seg(40, 1)}/`, "CREDENTIAL_INVALID"], ["equals", `ghs_${seg(40, 1)}=`, "CREDENTIAL_INVALID"],
    ["dots without ghs_", `gho_${seg(40, 1)}.${seg(40, 2)}`, "CREDENTIAL_INVALID"], ["hyphen without ghs_", `abc-${"a".repeat(30)}`, "CREDENTIAL_INVALID"],
    ["ghs_ too short with dot", "ghs_ab.cd", "CREDENTIAL_INVALID"], ["oversize", `ghs_${"a".repeat(T.TOKEN_MAX_LENGTH)}`, "CREDENTIAL_INVALID"],
    ["classic too short", "a".repeat(19), "CREDENTIAL_INVALID"], ["Bearer prefix", `Bearer ${TOKEN}`, "CREDENTIAL_INVALID"]];
  for (const [label, tok, code] of bad) {
    assert.equal(T.githubTokenRefusal(tok), code, label);
    const { primitive, log } = fakePrimitive(() => { throw new Error("no request may be made"); });
    const m = mk({ credential: () => tok, ex: T.createGithubExchange({ primitive }) });
    const r = await m.d(goodCall(), { signal: sig() });
    assert.deepEqual(r, { notSent: true, code }, label); assert.equal(log.requests.length, 0, label);
    assert.deepEqual(Object.keys(r).sort(), ["code", "notSent"]);
  }
  // the exchange layer refuses an unsupported shape on its own (defence in depth), pre-socket, code only
  for (const tok of ["", `${NEW_TOKEN}\r\n`, `ghs_${"a".repeat(T.TOKEN_MAX_LENGTH)}`]) {
    const { primitive, log } = fakePrimitive(() => { throw new Error("no request may be made"); });
    const ex = T.createGithubExchange({ primitive });
    await assert.rejects(ex({ kind: "getMain", token: tok, signal: sig(), timeoutMs: 1000 }), (e) => e.code === "EXCHANGE_INPUT_INVALID" && (tok === "" || !String(e.message).includes(tok.slice(0, 8))));
    assert.equal(log.requests.length, 0);
  }
});
