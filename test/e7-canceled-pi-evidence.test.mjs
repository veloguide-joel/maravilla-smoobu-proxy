// test/e7-canceled-pi-evidence.test.mjs — OFFLINE tests of scripts/e7-canceled-pi-evidence.mjs. Node built-ins only.
// LABELS
//   * REAL: the runner, the ACCEPTED tooling T / X / C1 at d1e20d71 (from E7_TOOLING_DIR, default ../../tooling = the workflow layout),
//     real framed digests over the real accepted checkout and this checkout.
//   * FAKE: every Stripe reply (an in-process fake `exchange`, or a fake node:https-shaped PRIMITIVE under the real X). SYNTHETIC TEST keys
//     (`sk_test_Fake1`, short on purpose). Nothing here is connectivity evidence; no real credential, provider, network or install.
//   * node:https request / Agent and fetch are guarded in this process and must count ZERO at the end.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { readFileSync, mkdtempSync, cpSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const GUARD = { request: 0, Agent: 0, fetch: 0 };
const realReq = https.request; const RealAgent = https.Agent; const realFetch = globalThis.fetch;
https.request = function g() { GUARD.request += 1; throw new Error("refused"); };
https.Agent = function g() { GUARD.Agent += 1; throw new Error("refused"); };
syncBuiltinESMExports();
globalThis.fetch = async () => { GUARD.fetch += 1; throw new Error("refused"); };
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOOLING = realpathSync(process.env.E7_TOOLING_DIR || join(ROOT, "..", "tooling"));
const tool = (p) => import(pathToFileURL(join(TOOLING, p)).href);
const E = await import("../scripts/e7-canceled-pi-evidence.mjs");
const T = await tool("scripts/e7-connected/http-transports.mjs");
const X = await tool("scripts/e7-connected/real-exchange.mjs");
const C1 = await tool("scripts/e7-connected/probe-env-preflight.mjs");
https.request = realReq; https.Agent = RealAgent; syncBuiltinESMExports();
const TMP = [];
after(() => { for (const d of TMP) rmSync(d, { recursive: true, force: true }); globalThis.fetch = realFetch; assert.deepEqual([GUARD.request, GUARD.Agent, GUARD.fetch], [0, 0, 0]); });

const C = E.CONSTANTS;
const KEY = "sk_test_Fake1"; const PI = C.paymentIntentId; const CH = "ch_FakeCanceled1";
const CANARY = "CANARYrawProviderText"; const CSECRET = `${PI}_secret_CANARYcs`;
const ACCOUNT_URL = "https://api.stripe.com/v1/account";
const PI_URL = `https://api.stripe.com/v1/payment_intents/${PI}?expand%5B%5D=latest_charge`;
const built = E.buildPlan(C, { approvalRef: "synthetic-label-1", runnerDigest: "0".repeat(64) });
const enc = (o) => new TextEncoder().encode(typeof o === "string" ? o : JSON.stringify(o));
const reply = (status, o) => Promise.resolve({ status, contentType: "application/json", bytes: enc(o) });

// ---- fake Stripe: the already-canceled $1.00 (100 minor units) TEST PaymentIntent, with sensitive decoys that must never be published ----
function chargeObj(over = {}) {
  return { object: "charge", id: CH, livemode: false, payment_intent: PI, status: "succeeded", currency: "usd", amount: 100, captured: false, amount_captured: 0,
    amount_refunded: 0, refunded: false, paid: true, billing_details: { email: "guest.canary@example.invalid", name: CANARY }, receipt_url: `https://pay.example.invalid/${CANARY}`,
    payment_method_details: { type: "card", card: { brand: "visa", last4: "4242", fingerprint: CANARY } }, refunds: { object: "list", data: [{ id: "re_CANARY1" }] }, ...over };
}
function piObj(over = {}, chargeOver = {}) {
  return { object: "payment_intent", id: PI, livemode: false, status: "canceled", capture_method: "manual", currency: "usd", amount: 100, amount_received: 0,
    amount_capturable: 0, client_secret: CSECRET, customer: "cus_CANARY1", description: CANARY, metadata: { e7_purpose: "e7-authorization-test", e7_run_ref: "run-CANARY" },
    cancellation_reason: null, latest_charge: chargeObj(chargeOver), ...over };
}
function fakeStripe(script = {}) {
  const calls = [];
  const h = { account: () => reply(200, { object: "account", id: C.accountId, email: "owner.canary@example.invalid" }), pi: () => reply(200, piObj()), ...script };
  function exchange(req) {
    const op = req.method === "GET" && req.url === ACCOUNT_URL ? "account" : req.method === "GET" && req.url === PI_URL ? "pi" : "UNEXPECTED";
    calls.push({ op, method: req.method, url: req.url, headerKeys: Object.keys(req.headers).sort(), auth: req.headers.Authorization === `Bearer ${KEY}`,
      version: req.headers["Stripe-Version"], body: req.body, signal: req.signal });
    assert.ok(calls.length <= 2, "two-exchange budget");
    return op === "UNEXPECTED" ? Promise.reject(new Error("unexpected")) : h[op](req);
  }
  return { exchange, calls };
}
const FORBIDDEN = [KEY, "sk_test_", CANARY, CSECRET, "_secret_", "Bearer", "client_secret", "guest.canary", "owner.canary", "4242", "last4", "cus_", "re_CANARY",
  "billing", "receipt", "metadata", "run-CANARY", "fingerprint", "refunds"];
async function run(script, opts = {}) {
  const f = fakeStripe(script);
  const res = await E.runEvidenceCore({ plan: "plan" in opts ? opts.plan : built.plan, exchange: f.exchange, credential: opts.credential ?? (() => KEY), createStripeSend: opts.createStripeSend ?? T.createE7StripeTestSend,
    runSignal: opts.runSignal, makeCallSignal: opts.makeCallSignal });
  const s = JSON.stringify(res);
  for (const bad of FORBIDDEN) assert.ok(!s.includes(bad), `no ${bad} in public result`);
  assert.equal(res.exchanges, f.calls.length); assert.ok(res.exchanges <= 2);
  assert.equal(res.writesSent, 0); assert.equal(res.decision, "NONE");
  assert.ok(f.calls.every((c) => c.method === "GET" && c.body === null), "GET only, no body, ever");
  return { res, calls: f.calls, ops: f.calls.map((c) => c.op) };
}
const netFail = () => Promise.reject(new Error(CANARY));
const STOP_SHAPE = (res) => [res.paymentIntent, res.charge, res.refundedClass, res.chargeBaseline];

test("E1. happy path: exactly two GETs in order (account, exact PI with latest_charge expanded), clover version, TEST key; whitelisted evidence only; no decision", async () => {
  const { res, calls, ops } = await run();
  assert.deepEqual(ops, ["account", "pi"]);
  assert.deepEqual(calls.map((c) => c.url), [ACCOUNT_URL, PI_URL]);
  assert.ok(calls.every((c) => c.auth && c.version === "2026-01-28.clover" && c.headerKeys.join(",") === "Authorization,Stripe-Version"));
  assert.deepEqual(res, {
    schema: E.RESULT_SCHEMA, outcome: "EVIDENCE_CAPTURED", exchanges: 2, writesSent: 0, stripeVersion: "2026-01-28.clover", decision: "NONE", account: "OK",
    paymentIntent: { id: PI, status: "canceled", captureMethod: "manual", currency: "usd", amount: 100, amountReceived: 0, amountCapturable: 0 },
    charge: { id: CH, status: "succeeded", currency: "usd", amount: 100, captured: false, amountCaptured: 0, amountRefunded: 0, refunded: false },
    refundedClass: "ZERO", chargeBaseline: "NEVER_CAPTURED" });
  assert.ok(Object.isFrozen(res));
});

test("E2. amount_refunded is captured TRUTHFULLY whatever it is (0 / full / partial): classified descriptively, never a release decision", async () => {
  for (const [ch, cls] of [[{ amount_refunded: 100, refunded: true }, "FULL"], [{ amount_refunded: 100, refunded: false }, "FULL"], [{ amount_refunded: 40, refunded: false }, "PARTIAL"],
    [{ amount_refunded: 0, refunded: true }, "ZERO"]]) {
    const { res } = await run({ pi: () => reply(200, piObj({}, ch)) });
    assert.deepEqual([res.outcome, res.charge.amountRefunded, res.charge.refunded, res.refundedClass, res.decision], ["EVIDENCE_CAPTURED", ch.amount_refunded, ch.refunded, cls, "NONE"], JSON.stringify(ch));
  }
  // a charge that reports a capture is published as reported, and labelled (still no decision)
  const { res } = await run({ pi: () => reply(200, piObj({}, { captured: true, amount_captured: 100 })) });
  assert.deepEqual([res.outcome, res.charge.captured, res.charge.amountCaptured, res.chargeBaseline], ["EVIDENCE_CAPTURED", true, 100, "CAPTURE_REPORTED"]);
});

test("E3. through the REAL accepted X over a fake node:https-shaped primitive: two GET requests to api.stripe.com, exact paths, no body / idempotency / content-type", async () => {
  const seen = [];
  const primitive = { Agent: function Agent() { return { destroy() {} }; }, request(options) {
    const req = new EventEmitter(); seen.push({ method: options.method, path: options.path, hostname: options.hostname, headers: Object.keys(options.headers).sort() });
    req.destroy = () => {};
    req.end = (b) => setImmediate(() => {
      seen[seen.length - 1].bodyWritten = b !== undefined && b !== null && String(b).length > 0;
      const body = seen.length === 1 ? { object: "account", id: C.accountId } : piObj();
      const buf = Buffer.from(JSON.stringify(body)); const res = new EventEmitter();
      Object.assign(res, { statusCode: 200, rawHeaders: ["Content-Type", "application/json", "Content-Length", String(buf.length)], complete: false, destroy() {} });
      req.emit("response", res); res.emit("data", buf); res.complete = true; res.emit("end"); res.emit("close"); req.emit("close");
    });
    return req; } };
  const ex = X.createE7RealExchange({ provider: "stripe", primitive });
  assert.equal(ex.ok, true);
  const r = await E.runEvidenceCore({ plan: built.plan, exchange: ex.exchange, credential: () => KEY, createStripeSend: T.createE7StripeTestSend });
  assert.equal(r.outcome, "EVIDENCE_CAPTURED"); assert.equal(seen.length, 2);
  assert.deepEqual(seen.map((s) => `${s.method} ${s.path}`), ["GET /v1/account", `GET /v1/payment_intents/${PI}?expand%5B%5D=latest_charge`]);
  assert.ok(seen.every((s) => s.hostname === "api.stripe.com" && !s.bodyWritten && !s.headers.includes("Idempotency-Key") && !s.headers.includes("Content-Type")));
});

test("E4. live / restricted / malformed key: ZERO exchanges; foreign account: ONE GET then STOP; unknown account read: ONE GET then STOP (no retry)", async () => {
  for (const k of ["sk_live_Fake1", "rk_test_Fake1", "rk_live_Fake1", "", "pk_test_Fake1"]) {
    const { res, ops } = await run({}, { credential: () => k });
    assert.deepEqual([res.outcome, res.exchanges, ops.length, res.account], ["STOPPED_BEFORE_REQUEST", 0, 0, "NOT_SENT"], k || "empty");
  }
  const m = await run({ account: () => reply(200, { object: "account", id: "acct_ForeignFake1" }) });
  assert.deepEqual([m.res.outcome, m.ops, m.res.account, ...STOP_SHAPE(m.res)], ["ACCOUNT_MISMATCH", ["account"], "MISMATCH", null, null, null, null]);
  for (const account of [netFail, () => reply(500, { error: { message: CANARY } }), () => reply(401, { error: { message: CANARY } }), () => reply(302, {})]) {
    const u = await run({ account });
    assert.deepEqual([u.res.outcome, u.ops, u.res.account], ["ACCOUNT_UNKNOWN", ["account"], "UNKNOWN"]);
  }
});

test("E5. PaymentIntent bindings and the known baseline (canceled, manual, USD, 100 minor units = $1.00, nothing received / capturable): code-only STOP, no third call", async () => {
  const cases = [
    [{ livemode: true }, "PI_LIVEMODE_REFUSED"], [{ id: "pi_OtherFake1" }, "PI_READ_FAILED"], [{ object: "charge" }, "PI_READ_FAILED"],
    [{ capture_method: "automatic" }, "PI_NOT_BOUND"], [{ currency: "mxn" }, "PI_NOT_BOUND"], [{ currency: "USD" }, "PI_NOT_BOUND"],
    [{ amount: 10000 }, "PI_NOT_BOUND"], [{ amount: 1 }, "PI_NOT_BOUND"], [{ amount: "100" }, "PI_NOT_BOUND"],
    [{ metadata: { e7_purpose: "other" } }, "PI_NOT_BOUND"], [{ metadata: null }, "PI_NOT_BOUND"],
    [{ status: "requires_capture", amount_capturable: 100 }, "PI_BASELINE_MISMATCH"], [{ status: "succeeded", amount_received: 100 }, "PI_BASELINE_MISMATCH"],
    [{ status: "requires_capture" }, "PI_BASELINE_MISMATCH"], [{ amount_capturable: 100 }, "PI_BASELINE_MISMATCH"], [{ amount_received: 100 }, "PI_BASELINE_MISMATCH"],
    [{ amount_received: "0" }, "PI_BASELINE_MISMATCH"]
  ];
  for (const [over, code] of cases) {
    const { res, ops } = await run({ pi: () => reply(200, piObj(over)) });
    assert.deepEqual([res.outcome, ops, res.account, ...STOP_SHAPE(res)], [code, ["account", "pi"], "OK", null, null, null, null], JSON.stringify(over));
  }
});

test("E6. latest charge: missing / unexpanded / wrong-bound / not TEST / malformed fields → code-only STOP; nothing published", async () => {
  const cases = [
    [{ latest_charge: null }, {}, "CHARGE_MISSING"], [{ latest_charge: undefined }, {}, "CHARGE_MISSING"], [{ latest_charge: CH }, {}, "CHARGE_NOT_EXPANDED"],
    [{}, { payment_intent: "pi_OtherFake1" }, "CHARGE_NOT_BOUND"], [{}, { livemode: true }, "CHARGE_NOT_BOUND"], [{}, { livemode: undefined }, "CHARGE_NOT_BOUND"],
    [{}, { object: "refund" }, "CHARGE_NOT_BOUND"], [{}, { id: "py_Fake1" }, "CHARGE_NOT_BOUND"], [{}, { id: 7 }, "CHARGE_NOT_BOUND"],
    [{}, { amount: 10000 }, "CHARGE_FIELDS_INVALID"], [{}, { currency: "mxn" }, "CHARGE_FIELDS_INVALID"], [{}, { status: "weird" }, "CHARGE_FIELDS_INVALID"],
    [{}, { captured: "false" }, "CHARGE_FIELDS_INVALID"], [{}, { amount_captured: -1 }, "CHARGE_FIELDS_INVALID"], [{}, { amount_refunded: 101 }, "CHARGE_FIELDS_INVALID"],
    [{}, { amount_refunded: "0" }, "CHARGE_FIELDS_INVALID"], [{}, { amount_refunded: undefined }, "CHARGE_FIELDS_INVALID"], [{}, { amount_refunded: 0.5 }, "CHARGE_FIELDS_INVALID"],
    [{}, { refunded: undefined }, "CHARGE_FIELDS_INVALID"], [{}, { refunded: "true" }, "CHARGE_FIELDS_INVALID"]
  ];
  for (const [piOver, chOver, code] of cases) {
    const p = piObj(piOver, chOver); if (Object.hasOwn(piOver, "latest_charge") && piOver.latest_charge === undefined) delete p.latest_charge;
    const { res, ops } = await run({ pi: () => reply(200, p) });
    assert.deepEqual([res.outcome, ops, ...STOP_SHAPE(res)], [code, ["account", "pi"], null, null, null, null], JSON.stringify([piOver, chOver]));
  }
});

test("E7. PaymentIntent transport / body errors (network, 5xx, 4xx, 3xx, non-JSON, oversized, empty): PI_READ_FAILED, exactly two exchanges, no retry", async () => {
  const big = () => Promise.resolve({ status: 200, contentType: "application/json", bytes: new Uint8Array(256 * 1024 + 1) });
  for (const pi of [netFail, () => reply(500, { error: { message: CANARY } }), () => reply(404, { error: { message: CANARY } }), () => reply(301, {}),
    () => reply(200, `not json ${CANARY}`), big, () => reply(200, ""), () => reply(200, "[]")]) {
    const { res, ops } = await run({ pi });
    assert.deepEqual([res.outcome, ops, ...STOP_SHAPE(res)], ["PI_READ_FAILED", ["account", "pi"], null, null, null, null]);
  }
});

test("E8. deadline / abort (existing primitives): run aborted before any GET → zero; abort after the account GET → no PI GET; per-call deadline → STOP, no retry", async () => {
  const ac = new AbortController(); ac.abort();
  const a = await run({}, { runSignal: ac.signal });
  assert.deepEqual([a.res.outcome, a.res.exchanges], ["STOPPED_BEFORE_REQUEST", 0]);
  const ac2 = new AbortController();
  const b = await run({ account: () => { ac2.abort(); return reply(200, { object: "account", id: C.accountId }); } }, { runSignal: ac2.signal });
  assert.deepEqual([b.res.outcome, b.ops], ["STOPPED_BEFORE_REQUEST", ["account"]]);
  // a call signal that is already aborted: T refuses before the exchange is invoked
  const pre = await run({}, { makeCallSignal: () => AbortSignal.abort() });
  assert.deepEqual([pre.res.outcome, pre.res.exchanges, pre.res.account], ["STOPPED_BEFORE_REQUEST", 0, "NOT_SENT"]);
  // the per-call deadline reaches the request: a hanging PI exchange that honours req.signal ends the run, once
  const hang = (req) => new Promise((_, rej) => { req.signal.addEventListener("abort", () => rej(new Error("aborted")), { once: true }); });
  let n = 0;
  // (AbortSignal.timeout's timer is unref'd and would let this fake-only process exit; a ref'd timer stands in for the live socket)
  const deadline = (ms) => { const c2 = new AbortController(); setTimeout(() => c2.abort(), ms); return c2.signal; };
  const d = await run({ pi: hang }, { makeCallSignal: () => (++n === 1 ? AbortSignal.timeout(5000) : deadline(20)) });
  assert.deepEqual([d.res.outcome, d.ops, ...STOP_SHAPE(d.res)], ["PI_READ_FAILED", ["account", "pi"], null, null, null, null]);
  assert.ok(d.calls.every((c) => c.signal && typeof c.signal.aborted === "boolean"), "every request carries a signal");
});

test("E9. the GET-only gate: a transport that tries a POST, a different URL, a body, other headers or a THIRD request never reaches the exchange", async () => {
  const hostile = (attempts) => ({ exchange, credential, accountId, apiVersion }) => ({ ok: true, transport: { send: async () => {
    for (const req of attempts) { try { await exchange(req); } catch { /* refused by the gate */ } }
    const e = new Error("x"); e.code = "EXCHANGE_FAILED"; throw e;
  } } });
  const H = { Authorization: `Bearer ${KEY}`, "Stripe-Version": "2026-01-28.clover" };
  const bad = [
    { method: "POST", url: ACCOUNT_URL, headers: H, body: null }, { method: "POST", url: `https://api.stripe.com/v1/payment_intents/${PI}/cancel`, headers: H, body: "" },
    { method: "GET", url: PI_URL, headers: H, body: null },                                    // out of order (PI before account)
    { method: "GET", url: `${ACCOUNT_URL}?x=1`, headers: H, body: null }, { method: "GET", url: ACCOUNT_URL, headers: H, body: "x" },
    { method: "GET", url: ACCOUNT_URL, headers: { ...H, "Idempotency-Key": "k" }, body: null }, { method: "GET", url: ACCOUNT_URL, headers: { ...H, "Stripe-Version": "2026-08-26.dahlia" }, body: null }
  ];
  const { res, calls } = await run({}, { createStripeSend: hostile(bad) });
  assert.deepEqual([calls.length, res.exchanges, res.outcome], [0, 0, "STOPPED_BEFORE_REQUEST"]);
  // the planned two pass; any third request is refused without reaching the exchange
  const ok2 = [{ method: "GET", url: ACCOUNT_URL, headers: H, body: null }, { method: "GET", url: PI_URL, headers: H, body: null }, { method: "GET", url: PI_URL, headers: H, body: null }];
  const t = await run({}, { createStripeSend: hostile(ok2) });
  assert.deepEqual([t.calls.length, t.res.exchanges], [2, 2]);
});

test("E10. plan: fixed code ceiling (account, PI, version, 2 GETs, zero writes); hash stable and label-sensitive; core refuses a tampered plan", async () => {
  const p = E.buildPlan(C, { approvalRef: "synthetic-label-1", runnerDigest: "0".repeat(64) });
  assert.equal(p.planHash, built.planHash);
  assert.notEqual(E.buildPlan(C, { approvalRef: "synthetic-label-2", runnerDigest: "0".repeat(64) }).planHash, p.planHash);
  assert.notEqual(E.buildPlan(C, { approvalRef: "synthetic-label-1", runnerDigest: "1".repeat(64) }).planHash, p.planHash);
  assert.deepEqual(p.plan.requests, [`GET ${ACCOUNT_URL}`, `GET ${PI_URL}`]);
  assert.deepEqual([p.plan.writes, p.plan.decision, p.plan.maxExchanges, p.plan.baseline.amount, p.plan.baseline.currency, p.plan.stripeVersion], [0, "NONE", 2, 100, "usd", "2026-01-28.clover"]);
  for (const over of [{ maxExchanges: 3 }, { paymentIntentId: "pi_OtherFake1" }, { accountId: "acct_OtherFake1" }, { stripeVersion: "2026-08-26.dahlia" },
    { baseline: { ...C.baseline, amount: 10000 } }]) assert.throws(() => E.buildPlan({ ...C, ...over }, { approvalRef: "x-label", runnerDigest: "0".repeat(64) }), { code: "EVID_INPUT_INVALID" });
  for (const a of ["", "has space", "x".repeat(81), null]) assert.throws(() => E.buildPlan(C, { approvalRef: a, runnerDigest: "0".repeat(64) }), { code: "EVID_INPUT_INVALID" });
  for (const tampered of [{ ...built.plan, writes: 1 }, { ...built.plan, paymentIntentId: "pi_OtherFake1" }, { ...built.plan, maxExchanges: 3 }, { ...built.plan, schema: "x" }, null]) {
    const { res } = await run({}, { plan: tampered });
    assert.deepEqual([res.outcome, res.exchanges], ["CORE_INVALID", 0]);
  }
});

// ---- hosted wiring --------------------------------------------------------------------------------------------------------------------
const PROC = { versions: { node: "22.22.0" }, platform: "linux", execArgv: [], getuid: () => 1001 };
const tapOk = async () => ({ status: 0, signal: null, stdout: "TAP version 13\n# tests 13\n# pass 13\n# fail 0\n", truncated: false, spawnFailed: false });
const realMods = { T, X, C1 };
async function hosted(mode, env, deps = {}) {
  const res = await E.runHosted({ mode, env: { E7_TOOLING_DIR: TOOLING, ...env }, proc: PROC, wrapperDir: ROOT, deps: { spawnChild: tapOk, importTooling: async () => realMods, ...deps } });
  const s = JSON.stringify(res) + E.summaryMarkdown(res.result);
  for (const bad of FORBIDDEN) assert.ok(!s.includes(bad), `no ${bad} in hosted output`);
  return res;
}

test("H1. preflight (default): no secret allowed; real accepted digest + runner digest computed; synthetic vs real plan; fake tests via child seam", async () => {
  const s = await hosted("preflight", {});
  assert.deepEqual([s.exitCode, s.result.code, s.result.sourceDigest, s.result.planKind, s.result.envCode, s.result.core], [0, "PREFLIGHT_OK_SYNTHETIC_ONLY", C.sourceDigest, "SYNTHETIC", "ENV_OK", null]);
  assert.match(s.result.runnerDigest, /^[0-9a-f]{64}$/);
  const r = await hosted("preflight", { E7_APPROVAL_REF: "synthetic-label-1" });
  assert.deepEqual([r.result.code, r.result.planKind], ["PREFLIGHT_OK_REAL_PLAN", "REAL"]);
  assert.equal(r.result.planHash, E.buildPlan(C, { approvalRef: "synthetic-label-1", runnerDigest: r.result.runnerDigest }).planHash);
  let childEnvSeen = null; let childArgs = null;
  await hosted("preflight", {}, { spawnChild: async (args, o) => { childEnvSeen = o.env; childArgs = args; return tapOk(); } });
  assert.deepEqual(Object.keys(childEnvSeen).filter((k) => k.startsWith("E7_")), ["E7_TOOLING_DIR"]);
  assert.deepEqual(childArgs, ["--test", "--test-reporter=tap", "test/e7-canceled-pi-evidence.test.mjs"]);
  for (const env of [{ E7_STRIPE_TEST_KEY: KEY }, { E7_HOSTAWAY_TOKEN: "tokFake1" }]) assert.equal((await hosted("preflight", env)).result.code, "EVID_SECRET_SCOPE_VIOLATION");
  assert.equal((await hosted("preflight", { E7_APPROVAL_REF: C.synthetic.approvalRef })).result.code, "EVID_INPUT_INVALID");
  assert.equal((await hosted("preflight", { E7_APPROVAL_REF: "bad label" })).result.code, "EVID_INPUT_INVALID");
  assert.equal((await hosted("preflight", {}, { spawnChild: async () => ({ ...(await tapOk()), stdout: "# tests 13\n# pass 12\n# fail 1\n", status: 1 }) })).result.code, "EVID_TESTS_FAILED");
  assert.equal((await hosted("preflight", {}, { spawnChild: async () => ({ ...(await tapOk()), truncated: true }) })).result.code, "EVID_CHILD_FAILED");
  const envBad = await E.runHosted({ mode: "preflight", env: { E7_TOOLING_DIR: TOOLING, NODE_OPTIONS: "--x" }, proc: PROC, wrapperDir: ROOT, deps: { spawnChild: tapOk, importTooling: async () => realMods } });
  assert.deepEqual([envBad.result.code, envBad.result.envCode], ["EVID_ENV_REFUSED", "ENV_VARIABLE_REFUSED"]);
});

test("H2. accepted closure verified BEFORE any tooling import (tampered copy → mismatch, importTooling never called); runner identity independent", async () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "e7evid-tool-"))); TMP.push(d);
  cpSync(join(TOOLING, "package.json"), join(d, "package.json")); cpSync(join(TOOLING, "scripts"), join(d, "scripts"), { recursive: true }); cpSync(join(TOOLING, "lib"), join(d, "lib"), { recursive: true });
  assert.equal(await E.framedDigest(d, C.sourceClosure), C.sourceDigest, "faithful copy has the accepted digest");
  writeFileSync(join(d, "scripts/e7-connected/http-transports.mjs"), readFileSync(join(TOOLING, "scripts/e7-connected/http-transports.mjs"), "utf8") + "\n// tamper\n");
  let imported = 0;
  const r = await E.runHosted({ mode: "preflight", env: { E7_TOOLING_DIR: d }, proc: PROC, wrapperDir: ROOT, deps: { spawnChild: tapOk, importTooling: async () => { imported += 1; return realMods; } } });
  assert.deepEqual([r.result.code, imported], ["EVID_SOURCE_MISMATCH", 0]);
  const rd = await E.framedDigest(ROOT, C.runnerFiles, E.RUNNER_DIGEST_PREFIX);
  assert.notEqual(rd, C.sourceDigest);
  assert.notEqual(await E.framedDigest(ROOT, C.runnerFiles), rd, "runner digest is domain-separated from the accepted recipe");
  assert.equal((await E.runHosted({ mode: "preflight", env: { E7_TOOLING_DIR: ROOT }, proc: PROC, wrapperDir: ROOT, deps: { spawnChild: tapOk } })).result.code, "EVID_LAYOUT_INVALID");
});

test("H3. verify / execute: main only, every binding explicit; execute maps ONLY the TEST key into the core; key removed from env; real T/C1 + fake X end to end (2 GETs)", async () => {
  const rd = await E.framedDigest(ROOT, C.runnerFiles, E.RUNNER_DIGEST_PREFIX);
  const ph = E.buildPlan(C, { approvalRef: "synthetic-label-1", runnerDigest: rd }).planHash;
  const B = { E7_APPROVAL_REF: "synthetic-label-1", E7_EXPECTED_PLAN_HASH: ph, E7_EXPECTED_SOURCE_DIGEST: C.sourceDigest, E7_EXPECTED_RUNNER_DIGEST: rd, GITHUB_REF: "refs/heads/main" };
  assert.equal((await hosted("verify", B)).result.code, "VERIFY_OK");
  assert.equal((await hosted("verify", { ...B, GITHUB_REF: "refs/heads/feature/x" })).result.code, "EVID_REF_NOT_MAIN");
  assert.equal((await hosted("verify", { ...B, E7_EXPECTED_RUNNER_DIGEST: "a".repeat(64) })).result.code, "EVID_RUNNER_MISMATCH");
  assert.equal((await hosted("verify", { ...B, E7_EXPECTED_PLAN_HASH: "b".repeat(64) })).result.code, "EVID_PLAN_HASH_MISMATCH");
  assert.equal((await hosted("verify", { ...B, E7_EXPECTED_SOURCE_DIGEST: "c".repeat(64) })).result.code, "EVID_SOURCE_MISMATCH");
  assert.equal((await hosted("verify", { ...B, E7_EXPECTED_PLAN_HASH: "" })).result.code, "EVID_INPUT_INCOMPLETE");
  assert.equal((await hosted("verify", { ...B, E7_APPROVAL_REF: "" })).result.code, "EVID_INPUT_INCOMPLETE");
  assert.equal((await hosted("verify", { ...B, E7_STRIPE_TEST_KEY: KEY })).result.code, "EVID_SECRET_SCOPE_VIOLATION");
  assert.equal((await hosted("execute", B)).result.code, "EVID_CREDENTIALS_MISSING");
  let coreSeen = null;
  const fakeCore = async (i) => { coreSeen = { key: i.credential(), keys: Object.keys(i).sort(), plan: i.plan }; return { outcome: "EVIDENCE_CAPTURED" }; };
  const env = { ...B, E7_STRIPE_TEST_KEY: KEY };
  const e = await E.runHosted({ mode: "execute", env: { E7_TOOLING_DIR: TOOLING, ...env }, proc: PROC, wrapperDir: ROOT, deps: { importTooling: async () => realMods, runCore: fakeCore,
    spawnChild: async () => { throw new Error("no child in execute"); } } });
  assert.deepEqual([e.exitCode, e.result.code, coreSeen.key, E.buildPlan(C, coreSeen.plan).planHash], [0, "EXECUTE_DONE", KEY, ph]);
  assert.deepEqual(coreSeen.keys, ["createStripeSend", "credential", "exchange", "plan", "runSignal"]);
  // full wiring with the REAL core, real T / C1 and a FAKE X exchange
  const f = fakeStripe(); const env2 = { E7_TOOLING_DIR: TOOLING, ...env };
  const w = await E.runHosted({ mode: "execute", env: env2, proc: PROC, wrapperDir: ROOT,
    deps: { importTooling: async () => ({ T, C1, X: { createE7RealExchange: () => ({ ok: true, exchange: f.exchange }) } }) } });
  assert.deepEqual([w.exitCode, w.result.core.outcome, f.calls.map((c) => c.op), "E7_STRIPE_TEST_KEY" in env2], [0, "EVIDENCE_CAPTURED", ["account", "pi"], false]);
  const out = JSON.stringify(w) + E.summaryMarkdown(w.result);
  for (const bad of FORBIDDEN) assert.ok(!out.includes(bad), bad);
  // a STOP outcome exits nonzero (the job is red; nothing is retried)
  const f2 = fakeStripe({ pi: () => reply(200, piObj({ status: "requires_capture" })) });
  const w2 = await E.runHosted({ mode: "execute", env: { E7_TOOLING_DIR: TOOLING, ...env }, proc: PROC, wrapperDir: ROOT,
    deps: { importTooling: async () => ({ T, C1, X: { createE7RealExchange: () => ({ ok: true, exchange: f2.exchange }) } }) } });
  assert.deepEqual([w2.exitCode, w2.result.core.outcome, f2.calls.length], [1, "PI_BASELINE_MISMATCH", 2]);
});

test("P1. source pins: inert on import, built-ins only, Stripe origin only, GET-only (no POST / cancel / capture / refund / idempotency), no Hostaway / DB / fetch; workflow scope", () => {
  const src = readFileSync(join(ROOT, "scripts/e7-canceled-pi-evidence.mjs"), "utf8");
  const code = src.replace(/^\s*\/\/.*$/gm, "").replace(/\/\/ .*$/gm, "");
  const imports = [...src.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ["node:process", "node:child_process", "node:crypto", "node:fs/promises", "node:url"]);
  for (const re of [/POST/, /\/cancel/, /paymentIntents\.(capture|cancel|create|update|confirm)/, /\/capture(?![-_a-z])/, /\brefund(s)?\b/i, /Idempotency/i, /hostaway\.com|createE7HostawaySend/i,
    /\bfetch\s*\(/, /node:(https?|net|tls|dns)"/, /\bpg\b|supabase|webhook|vercel/i, /https:\/\/(?!api\.stripe\.com)[a-z]/, /hostaway-reservations/, /client_secret/,
    /billing|customer|payment_method_details|receipt/]) assert.ok(!re.test(code), String(re));
  assert.ok(/if \(import\.meta\.main === true\)/.test(src));
  const wf = readFileSync(join(ROOT, ".github/workflows/e7-canceled-pi-evidence.yml"), "utf8");
  assert.deepEqual([...wf.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]), ["E7_STRIPE_TEST_KEY"]);
  assert.equal((wf.match(/environment: e7-readonly-probe/g) || []).length, 1);
  assert.ok(wf.includes("if: inputs.mode == 'execute' && github.ref == 'refs/heads/main'"));
  assert.ok(wf.includes("default: preflight") && wf.includes("ref: d1e20d71ecf15f82d2d3b74fd22eb562eaa310f8") && wf.includes('node-version: "22.22.0"'));
  assert.ok(wf.includes("permissions:\n  contents: read") && (wf.match(/persist-credentials: false/g) || []).length === 4);
  for (const u of [...wf.matchAll(/uses: (\S+)/g)].map((m) => m[1])) assert.ok(["actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803", "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38"].includes(u), u);
  assert.ok(!/\bpush:|pull_request|schedule:/.test(wf));
  assert.ok(!/run_ref|E7_RUN_REF/.test(wf), "no run identity input: nothing is created");
  // the secret appears in exactly ONE step (execute's final step)
  assert.equal((wf.match(/E7_STRIPE_TEST_KEY: \$\{\{ secrets\.E7_STRIPE_TEST_KEY \}\}/g) || []).length, 1, "the key is mapped in exactly one step");
});
