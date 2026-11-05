// test/e7-stripe-authorization-test.test.mjs — OFFLINE tests of scripts/e7-stripe-authorization-test.mjs. Node built-ins only.
// LABELS
//   * REAL: the runner, the ACCEPTED tooling T / X / C1 at d1e20d71 (from E7_TOOLING_DIR, default ../../tooling = the workflow layout),
//     real framed digests over the real accepted checkout and this checkout.
//   * FAKE: every Stripe reply (an in-process fake `exchange`, or a fake node:https-shaped PRIMITIVE under the real X). SYNTHETIC TEST keys
//     (`sk_test_Fake1`, short on purpose). Nothing here is connectivity evidence; no real credential, env inspection, provider or install.
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
const A = await import("../scripts/e7-stripe-authorization-test.mjs");
const T = await tool("scripts/e7-connected/http-transports.mjs");
const X = await tool("scripts/e7-connected/real-exchange.mjs");
const C1 = await tool("scripts/e7-connected/probe-env-preflight.mjs");
https.request = realReq; https.Agent = RealAgent; syncBuiltinESMExports();
const TMP = [];
after(() => { for (const d of TMP) rmSync(d, { recursive: true, force: true }); globalThis.fetch = realFetch; assert.deepEqual([GUARD.request, GUARD.Agent, GUARD.fetch], [0, 0, 0]); });

const C = A.CONSTANTS;
const KEY = "sk_test_Fake1"; const RUN = "e7auth-synthetic-01"; const PI = "pi_FakeAuth1"; const CH = "ch_FakeAuth1";
const CANARY = "CANARYrawProviderText"; const CSECRET = `${PI}_secret_CANARYcs`;
const built = A.buildPlan(C, { runRef: RUN, approvalRef: "synthetic-label-1", runnerDigest: "0".repeat(64) });
const enc = (o) => new TextEncoder().encode(typeof o === "string" ? o : JSON.stringify(o));
const reply = (status, o) => Promise.resolve({ status, contentType: "application/json", bytes: enc(o) });

// ---- fake Stripe (state machine over the exact request forms) --------------------------------------------------------------------
function piObj(over = {}) {
  const lc = { object: "charge", id: CH, livemode: false, payment_intent: PI, captured: false, amount_captured: 0, amount: 100, currency: "usd", amount_refunded: 0,
    paid: true, status: "succeeded", payment_method_details: { type: "card", card: { capture_before: 1790000000, brand: "visa" } } };
  return { object: "payment_intent", id: PI, livemode: false, amount: 100, currency: "usd", capture_method: "manual", status: "requires_capture", amount_capturable: 100,
    amount_received: 0, client_secret: CSECRET, metadata: { e7_purpose: C.purpose, e7_run_ref: RUN }, latest_charge: lc, ...over };
}
const canceled = (o = {}) => piObj({ status: "canceled", amount_capturable: 0, ...o });
/** script: per-op handlers (req, state) → promise; defaults = happy flow */
function fakeStripe(script = {}) {
  const calls = []; const st = { retrieves: 0 };
  const D = {
    account: () => reply(200, { object: "account", id: C.accountId }),
    create: () => reply(200, piObj({ latest_charge: CH })),
    retrieve1: () => reply(200, piObj()),
    cancel: () => reply(200, canceled({ latest_charge: CH })),
    retrieve2: () => reply(200, canceled())
  };
  const h = { ...D, ...script };
  function exchange(req) {
    let op;
    if (req.method === "GET" && req.url === "https://api.stripe.com/v1/account") op = "account";
    else if (req.method === "POST" && req.url === "https://api.stripe.com/v1/payment_intents") op = "create";
    else if (req.method === "GET" && /^https:\/\/api\.stripe\.com\/v1\/payment_intents\/pi_[A-Za-z0-9_]+\?expand%5B%5D=latest_charge$/.test(req.url)) op = (st.retrieves += 1) === 1 ? "retrieve1" : "retrieve2";
    else if (req.method === "POST" && /\/cancel$/.test(req.url)) op = "cancel";
    else op = "UNEXPECTED";
    calls.push({ op, method: req.method, url: req.url, headerKeys: Object.keys(req.headers).sort(), auth: req.headers.Authorization === `Bearer ${KEY}`,
      idem: req.headers["Idempotency-Key"] ?? null, version: req.headers["Stripe-Version"], ctype: req.headers["Content-Type"] ?? null, body: req.body });
    assert.ok(calls.length <= 5, "five-exchange budget");
    return op === "UNEXPECTED" ? Promise.reject(new Error("unexpected")) : h[op](req, st);
  }
  return { exchange, calls };
}
async function run(script, opts = {}) {
  const f = fakeStripe(script);
  const res = await A.runAuthorizationCore({ plan: built.plan, body: built.body, exchange: f.exchange, credential: opts.credential ?? (() => KEY),
    createStripeSend: T.createE7StripeTestSend, runSignal: opts.runSignal, makeCallSignal: opts.makeCallSignal });
  const s = JSON.stringify(res);
  for (const bad of [KEY, "sk_test_", CANARY, CSECRET, "_secret_", "Bearer", "client_secret"]) assert.ok(!s.includes(bad), `no ${bad} in public result`);
  assert.equal(res.exchanges, f.calls.length); assert.ok(res.exchanges <= 5);
  return { res, calls: f.calls, ops: f.calls.map((c) => c.op) };
}
const sendErr = (status) => () => reply(status, { error: { message: CANARY, type: "card_error", payment_intent: { id: PI, client_secret: CSECRET } } });
const netFail = () => Promise.reject(new Error(CANARY));

test("A1. happy flow: exactly five exchanges in order; exact create request; bound PI; cancel once; cleanup verified; proof fields complete", async () => {
  const { res, calls, ops } = await run();
  assert.deepEqual(ops, ["account", "create", "retrieve1", "cancel", "retrieve2"]);
  const cr = calls[1];
  assert.deepEqual(cr.headerKeys, ["Authorization", "Content-Type", "Idempotency-Key", "Stripe-Version"]);
  assert.equal(cr.auth, true); assert.equal(cr.version, "2026-08-26.dahlia"); assert.equal(cr.ctype, "application/x-www-form-urlencoded");
  assert.equal(cr.idem, `e7-auth-${RUN}-create`);
  assert.equal(cr.body, "amount=100&currency=usd&capture_method=manual&confirm=true&payment_method=pm_card_visa&allowed_payment_method_types%5B%5D=card"
    + `&metadata%5Be7_purpose%5D=e7-authorization-test&metadata%5Be7_run_ref%5D=${RUN}`);
  assert.equal(calls[3].idem, `e7-auth-${RUN}-cancel`); assert.equal(calls[3].body, ""); assert.equal(calls[3].url, `https://api.stripe.com/v1/payment_intents/${PI}/cancel`);
  assert.ok(calls.every((c) => c.auth && c.version === "2026-08-26.dahlia"));
  assert.equal(res.outcome, "AUTH_TEST_COMPLETED_OK"); assert.equal(res.writesSent, 2); assert.equal(res.paymentIntentId, PI);
  assert.deepEqual([res.retrieve.status, res.retrieve.authorization, res.retrieve.proofFields, res.retrieve.captureBefore], ["requires_capture", "VERIFIED", "COMPLETE", 1790000000]);
  assert.deepEqual([res.cancel.step, res.final.status, res.final.amountReceived, res.final.amountCapturable, res.cleanup, res.residual], ["CANCELED", "canceled", 0, 0, "VERIFIED", "NONE"]);
  assert.ok(!readFileSync(join(ROOT, "scripts/e7-stripe-authorization-test.mjs"), "utf8").includes("paymentIntents.capture"), "no capture operation exists");
});

test("A2. happy flow through the REAL accepted X over a fake node:https-shaped primitive: the fixed create request is X-valid; 5 primitive requests", async () => {
  const seen = [];
  const primitive = { Agent: function Agent() { return { destroy() {} }; }, request(options) {
    const req = new EventEmitter(); seen.push({ method: options.method, path: options.path, hostname: options.hostname, headers: Object.keys(options.headers).sort() });
    req.destroy = () => {};
    req.end = () => setImmediate(() => {
      const n = seen.length; const body = n === 1 ? { object: "account", id: C.accountId } : n === 2 ? piObj({ latest_charge: CH }) : n === 3 ? piObj() : n === 4 ? canceled({ latest_charge: CH }) : canceled();
      const b = Buffer.from(JSON.stringify(body)); const res = new EventEmitter();
      Object.assign(res, { statusCode: 200, rawHeaders: ["Content-Type", "application/json", "Content-Length", String(b.length)], complete: false, destroy() {} });
      req.emit("response", res); res.emit("data", b); res.complete = true; res.emit("end"); res.emit("close"); req.emit("close");
    });
    return req; } };
  const ex = X.createE7RealExchange({ provider: "stripe", primitive });
  assert.equal(ex.ok, true);
  const r = await A.runAuthorizationCore({ plan: built.plan, body: built.body, exchange: ex.exchange, credential: () => KEY, createStripeSend: T.createE7StripeTestSend });
  assert.equal(r.outcome, "AUTH_TEST_COMPLETED_OK"); assert.equal(seen.length, 5);
  assert.deepEqual(seen.map((s) => `${s.method} ${s.path}`), ["GET /v1/account", "POST /v1/payment_intents", `GET /v1/payment_intents/${PI}?expand%5B%5D=latest_charge`,
    `POST /v1/payment_intents/${PI}/cancel`, `GET /v1/payment_intents/${PI}?expand%5B%5D=latest_charge`]);
  assert.ok(seen.every((s) => s.hostname === "api.stripe.com"));
  assert.deepEqual(seen[1].headers, ["Authorization", "Content-Length", "Content-Type", "Idempotency-Key", "Stripe-Version"]);
});

test("A3. live / restricted / malformed key and foreign account: ZERO writes (key refusals: zero exchanges)", async () => {
  for (const k of ["sk_live_Fake1", "rk_test_Fake1", "rk_live_Fake1", "", "pk_test_Fake1"]) {
    const { res, ops } = await run({}, { credential: () => k });
    assert.deepEqual([res.outcome, res.exchanges, res.writesSent, ops.length, res.account], ["STOPPED_BEFORE_CREATE", 0, 0, 0, "NOT_SENT"], k || "empty");
  }
  const { res, ops } = await run({ account: () => reply(200, { object: "account", id: "acct_ForeignFake1" }) });
  assert.deepEqual([res.outcome, ops, res.writesSent, res.account], ["STOPPED_BEFORE_CREATE", ["account"], 0, "MISMATCH"]);
  const u = await run({ account: netFail });
  assert.deepEqual([u.res.outcome, u.ops, u.res.writesSent, u.res.account], ["STOPPED_BEFORE_CREATE", ["account"], 0, "UNKNOWN"]);
});

test("A4. create reply not bound to this run (amount / currency / metadata / livemode / capture_method / id / object / JSON): NO cancel, NO PI id published", async () => {
  const bad = [{ amount: 200 }, { currency: "mxn" }, { metadata: { e7_purpose: C.purpose, e7_run_ref: "other-run-0001" } }, { metadata: { e7_purpose: C.purpose, e7_run_ref: RUN, x: "1" } },
    { livemode: true }, { capture_method: "automatic" }, { id: "pi_" }, { id: "ch_Nope1" }, { object: "charge" }, { status: "weird" }];
  for (const over of bad) {
    const { res, ops } = await run({ create: () => reply(200, piObj({ latest_charge: CH, ...over })) });
    assert.deepEqual([res.outcome, ops, res.paymentIntentId, res.create.step, res.writesSent], ["CREATE_UNBOUND", ["account", "create"], null, "UNBOUND", 1], JSON.stringify(over));
  }
  const j = await run({ create: () => Promise.resolve({ status: 200, contentType: "application/json", bytes: enc("{not json") }) });
  assert.deepEqual([j.res.outcome, j.ops.length], ["CREATE_UNBOUND", 2]);
});

test("A5. create transport unknown / 5xx / 3xx: CREATE_UNKNOWN, never resent, no new key, no further call; 4xx: CREATE_REFUSED, no cancel, raw error unpublished", async () => {
  for (const h of [netFail, sendErr(500), sendErr(503), () => reply(302, {})]) {
    const { res, ops, calls } = await run({ create: h });
    assert.deepEqual([res.outcome, ops, res.residual, res.paymentIntentId], ["CREATE_UNKNOWN", ["account", "create"], "POSSIBLE_PI_UNKNOWN_IDENTITY", null]);
    assert.equal(calls.filter((c) => c.op === "create").length, 1); assert.equal(res.createIdempotencyKey, `e7-auth-${RUN}-create`);
  }
  for (const s of [400, 402]) {
    const { res, ops } = await run({ create: sendErr(s) });
    assert.deepEqual([res.outcome, ops, res.create.httpStatus, res.paymentIntentId, res.residual], ["CREATE_REFUSED", ["account", "create"], s, null, "POSSIBLE_UNAUTHORIZED_PI_NO_HOLD"]);
  }
  // an in-flight per-call deadline on the create = unknown (no claim it was not sent)
  let n = 0; const ac = [];
  const { res } = await run({ create: (req) => new Promise((_, rej) => { req.signal.addEventListener("abort", () => rej(new Error("aborted"))); ac[1].abort(); }) },
    { makeCallSignal: () => { const a = new AbortController(); ac[n++] = a; return a.signal; } });
  assert.equal(res.outcome, "CREATE_UNKNOWN");
});

test("A6. retrieve after create: identity conflict / livemode → NO cancel; unknown readback with bound identity → cancel still runs (create-bound), 5 calls", async () => {
  for (const over of [{ amount: 101 }, { metadata: {} }, { capture_method: "automatic" }]) {
    const { res, ops } = await run({ retrieve1: () => reply(200, piObj(over)) });
    assert.deepEqual([res.outcome, ops.length, res.cancel.step, res.residual], ["IDENTITY_CONFLICT", 3, "NOT_RUN", "BOUND_PI_NOT_CANCELLED"], JSON.stringify(over));
  }
  const lm = await run({ retrieve1: () => reply(200, piObj({ livemode: true })) });
  assert.deepEqual([lm.res.outcome, lm.ops.length], ["IDENTITY_CONFLICT", 3]);
  const lc = await run({ retrieve1: () => reply(200, piObj({ latest_charge: { ...piObj().latest_charge, livemode: true } })) });
  assert.deepEqual([lc.res.outcome, lc.ops.length], ["IDENTITY_CONFLICT", 3]);
  for (const h of [netFail, sendErr(500), sendErr(404)]) {
    const { res, ops } = await run({ retrieve1: h });
    assert.deepEqual(ops, ["account", "create", "retrieve1", "cancel", "retrieve2"]);
    assert.deepEqual([res.outcome, res.cleanup, res.retrieve.authorization], ["AUTH_TEST_AUTHORIZATION_NOT_VERIFIED", "VERIFIED", "NOT_CHECKED"]);
  }
});

test("A7. authorization proof fields: capture_before absent → PROOF_INCOMPLETE (honest); invalid / captured / wrong charge → NOT_VERIFIED; cleanup still verified", async () => {
  const lc0 = piObj().latest_charge;
  const inc = await run({ retrieve1: () => reply(200, piObj({ latest_charge: { ...lc0, payment_method_details: { type: "card", card: { brand: "visa" } } } })) });
  assert.deepEqual([inc.res.outcome, inc.res.retrieve.proofFields, inc.res.cleanup, inc.ops.length], ["AUTH_TEST_COMPLETED_PROOF_INCOMPLETE", "INCOMPLETE", "VERIFIED", 5]);
  for (const lc of [{ ...lc0, payment_method_details: { card: { capture_before: "soon" } } }, { ...lc0, payment_method_details: "x" }, { ...lc0, captured: true },
    { ...lc0, amount_captured: 100 }, { ...lc0, payment_intent: "pi_Other1" }, CH, null]) {
    const { res, ops } = await run({ retrieve1: () => reply(200, piObj({ latest_charge: lc })) });
    assert.deepEqual([res.outcome, res.retrieve.authorization, res.cleanup, ops.length], ["AUTH_TEST_AUTHORIZATION_NOT_VERIFIED", "NOT_VERIFIED", "VERIFIED", 5], JSON.stringify(lc));
  }
  const cap = await run({ retrieve1: () => reply(200, piObj({ amount_capturable: 0 })) });
  assert.equal(cap.res.retrieve.authorization, "NOT_VERIFIED");
});

test("A8. unexpected statuses: succeeded → CAPTURED_UNEXPECTED (no cancel); processing → NOT_CANCELLABLE; canceled → no cancel; requires_action → cancelled", async () => {
  const s = await run({ retrieve1: () => reply(200, piObj({ status: "succeeded", amount_capturable: 0, amount_received: 100 })) });
  assert.deepEqual([s.res.outcome, s.ops.length, s.res.writesSent, s.res.residual], ["CAPTURED_UNEXPECTED", 3, 1, "TEST_CHARGE_CAPTURED_NEEDS_OPERATOR"]);
  const p = await run({ retrieve1: () => reply(200, piObj({ status: "processing" })) });
  assert.deepEqual([p.res.outcome, p.ops.length], ["NOT_CANCELLABLE", 3]);
  const c = await run({ retrieve1: () => reply(200, canceled()) });
  assert.deepEqual([c.res.outcome, c.ops.length, c.res.cancel.step, c.res.cleanup], ["AUTH_TEST_AUTHORIZATION_NOT_VERIFIED", 3, "SKIPPED_ALREADY_CANCELED", "VERIFIED"]);
  const a = await run({ retrieve1: () => reply(200, piObj({ status: "requires_action", amount_capturable: 0 })) });
  assert.deepEqual([a.res.outcome, a.ops.length, a.res.cancel.step], ["AUTH_TEST_AUTHORIZATION_NOT_VERIFIED", 5, "CANCELED"]);
});

test("A9. cancel transport unknown / decline and readback: ONE cancel only, ONE final retrieve, explicit cleanup outcome; readback unknown is explicit", async () => {
  const u1 = await run({ cancel: netFail });
  assert.deepEqual([u1.ops, u1.res.cancel.step, u1.res.cleanup, u1.res.outcome], [["account", "create", "retrieve1", "cancel", "retrieve2"], "UNKNOWN", "VERIFIED", "AUTH_TEST_COMPLETED_OK"]);
  const u2 = await run({ cancel: netFail, retrieve2: () => reply(200, piObj()) });
  assert.deepEqual([u2.res.cancel.step, u2.res.outcome, u2.res.cleanup, u2.res.residual], ["UNKNOWN", "CLEANUP_NOT_DONE", "NOT_DONE", "AUTHORIZATION_HELD_UNTIL_EXPIRY"]);
  const d = await run({ cancel: sendErr(400), retrieve2: () => reply(200, piObj()) });
  assert.deepEqual([d.res.cancel.step, d.res.outcome, d.calls.filter((c) => c.op === "cancel").length], ["REFUSED", "CLEANUP_NOT_DONE", 1]);
  const ru = await run({ retrieve2: netFail });
  assert.deepEqual([ru.res.cancel.step, ru.res.outcome, ru.res.cleanup, ru.res.residual, ru.ops.length], ["CANCELED", "CLEANUP_UNKNOWN", "UNKNOWN", "CANCEL_ACKED_READBACK_UNKNOWN", 5]);
  const both = await run({ cancel: sendErr(503), retrieve2: sendErr(500) });
  assert.deepEqual([both.res.outcome, both.res.residual, both.ops.length], ["CLEANUP_UNKNOWN", "BOUND_PI_STATE_UNKNOWN", 5]);
  const cu = await run({ cancel: () => reply(200, piObj()), retrieve2: () => reply(200, piObj({ amount: 999 })) });
  assert.deepEqual([cu.res.cancel.step, cu.res.final.step, cu.res.outcome], ["UNEXPECTED_STATUS", "MISMATCH", "CLEANUP_UNKNOWN"]);
});

test("A10. abort before create: zero writes (before account: zero exchanges; after account: one GET only)", async () => {
  const ac = new AbortController(); ac.abort();
  const a = await run({}, { runSignal: ac.signal });
  assert.deepEqual([a.res.outcome, a.res.exchanges, a.res.writesSent], ["STOPPED_BEFORE_CREATE", 0, 0]);
  const ac2 = new AbortController();
  const b = await run({ account: () => { ac2.abort(); return reply(200, { object: "account", id: C.accountId }); } }, { runSignal: ac2.signal });
  assert.deepEqual([b.res.outcome, b.ops, b.res.writesSent], ["STOPPED_BEFORE_CREATE", ["account"], 0]);
});

test("A11. plan: fixed scope / code ceiling; identity is the reviewed run_ref (never generated); hash stable and identity-sensitive; core refuses a tampered plan", async () => {
  const p2 = A.buildPlan(C, { runRef: RUN, approvalRef: "synthetic-label-1", runnerDigest: "0".repeat(64) });
  assert.equal(p2.planHash, built.planHash);
  assert.notEqual(A.buildPlan(C, { runRef: "e7auth-synthetic-02", approvalRef: "synthetic-label-1", runnerDigest: "0".repeat(64) }).planHash, built.planHash);
  assert.notEqual(A.buildPlan(C, { runRef: RUN, approvalRef: "synthetic-label-1", runnerDigest: "1".repeat(64) }).planHash, built.planHash);
  for (const runRef of ["short", "has space x", "a&b=c-12345", "x".repeat(65), undefined]) assert.throws(() => A.buildPlan(C, { runRef, approvalRef: "l", runnerDigest: "0".repeat(64) }));
  for (const over of [{ amount: 200 }, { currency: "mxn" }, { paymentMethod: "pm_card_mastercard" }, { maxExchanges: 6 }]) assert.throws(() => A.buildPlan({ ...C, ...over }, { runRef: RUN, approvalRef: "l", runnerDigest: "0".repeat(64) }));
  assert.deepEqual([built.plan.amount, built.plan.currency, built.plan.accountId, built.plan.captureMethod, built.plan.maxExchanges], [100, "usd", "acct_1TyHE42B9LTneQgw", "manual", 5]);
  const f = fakeStripe();
  const r = await A.runAuthorizationCore({ plan: { ...built.plan, amount: 200 }, body: built.body, exchange: f.exchange, credential: () => KEY, createStripeSend: T.createE7StripeTestSend });
  assert.deepEqual([r.outcome, f.calls.length], ["CORE_INVALID", 0]);
  const r2 = await A.runAuthorizationCore({ plan: built.plan, body: built.body.replace("amount=100", "amount=1000"), exchange: f.exchange, credential: () => KEY, createStripeSend: T.createE7StripeTestSend });
  assert.deepEqual([r2.outcome, f.calls.length], ["CORE_INVALID", 0]);
});

// ---- hosted wiring --------------------------------------------------------------------------------------------------------------------
const PROC = { versions: { node: "22.22.0" }, platform: "linux", execArgv: [], getuid: () => 1001 };
const tapOk = async () => ({ status: 0, signal: null, stdout: "TAP version 13\n# tests 11\n# pass 11\n# fail 0\n", truncated: false, spawnFailed: false });
const realMods = { T, X, C1 };
async function hosted(mode, env, deps = {}) {
  const res = await A.runHosted({ mode, env: { E7_TOOLING_DIR: TOOLING, ...env }, proc: PROC, wrapperDir: ROOT, deps: { spawnChild: tapOk, importTooling: async () => realMods, ...deps } });
  const s = JSON.stringify(res) + A.summaryMarkdown(res.result);
  for (const bad of [KEY, "sk_test_", CANARY, CSECRET, "_secret_"]) assert.ok(!s.includes(bad), `no ${bad} in hosted output`);
  return res;
}

test("H1. preflight (default): no secret allowed; real accepted digest + runner digest computed; synthetic vs real plan; fake tests via child seam", async () => {
  const s = await hosted("preflight", {});
  assert.deepEqual([s.exitCode, s.result.code, s.result.sourceDigest, s.result.planKind, s.result.envCode], [0, "PREFLIGHT_OK_SYNTHETIC_ONLY", C.sourceDigest, "SYNTHETIC", "ENV_OK"]);
  assert.match(s.result.runnerDigest, /^[0-9a-f]{64}$/);
  const r = await hosted("preflight", { E7_RUN_REF: RUN, E7_APPROVAL_REF: "synthetic-label-1" });
  assert.deepEqual([r.result.code, r.result.planKind], ["PREFLIGHT_OK_REAL_PLAN", "REAL"]);
  assert.equal(r.result.planHash, A.buildPlan(C, { runRef: RUN, approvalRef: "synthetic-label-1", runnerDigest: r.result.runnerDigest }).planHash);
  let childEnvSeen = null;
  await hosted("preflight", {}, { spawnChild: async (args, o) => { childEnvSeen = o.env; return tapOk(); } });
  assert.deepEqual(Object.keys(childEnvSeen).filter((k) => k.startsWith("E7_")), ["E7_TOOLING_DIR"]);
  for (const env of [{ E7_STRIPE_TEST_KEY: KEY }, { E7_HOSTAWAY_TOKEN: "tokFake1" }]) assert.equal((await hosted("preflight", env)).result.code, "AUTH_SECRET_SCOPE_VIOLATION");
  assert.equal((await hosted("preflight", { E7_RUN_REF: RUN })).result.code, "AUTH_INPUT_INCOMPLETE");
  assert.equal((await hosted("preflight", { E7_RUN_REF: C.synthetic.runRef, E7_APPROVAL_REF: "x-label" })).result.code, "AUTH_INPUT_INVALID");
  assert.equal((await hosted("preflight", {}, { spawnChild: async () => ({ ...(await tapOk()), stdout: "# tests 11\n# pass 10\n# fail 1\n", status: 1 }) })).result.code, "AUTH_TESTS_FAILED");
  const envBad = await A.runHosted({ mode: "preflight", env: { E7_TOOLING_DIR: TOOLING, NODE_OPTIONS: "--x" }, proc: PROC, wrapperDir: ROOT, deps: { spawnChild: tapOk, importTooling: async () => realMods } });
  assert.deepEqual([envBad.result.code, envBad.result.envCode], ["AUTH_ENV_REFUSED", "ENV_VARIABLE_REFUSED"]);
});

test("H2. accepted closure verified BEFORE any tooling import (tampered copy → mismatch, importTooling never called); runner identity independent", async () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "e7auth-tool-"))); TMP.push(d);
  cpSync(join(TOOLING, "package.json"), join(d, "package.json")); cpSync(join(TOOLING, "scripts"), join(d, "scripts"), { recursive: true }); cpSync(join(TOOLING, "lib"), join(d, "lib"), { recursive: true });
  assert.equal(await A.framedDigest(d, C.sourceClosure), C.sourceDigest, "faithful copy has the accepted digest");
  writeFileSync(join(d, "scripts/e7-connected/http-transports.mjs"), readFileSync(join(TOOLING, "scripts/e7-connected/http-transports.mjs"), "utf8") + "\n// tamper\n");
  let imported = 0;
  const r = await A.runHosted({ mode: "preflight", env: { E7_TOOLING_DIR: d }, proc: PROC, wrapperDir: ROOT, deps: { spawnChild: tapOk, importTooling: async () => { imported += 1; return realMods; } } });
  assert.deepEqual([r.result.code, imported], ["AUTH_SOURCE_MISMATCH", 0]);
  const rd = await A.framedDigest(ROOT, C.runnerFiles, A.RUNNER_DIGEST_PREFIX);
  assert.notEqual(rd, C.sourceDigest);
  assert.notEqual(await A.framedDigest(ROOT, C.runnerFiles), rd, "runner digest is domain-separated from the accepted recipe");
});

test("H3. verify / execute: main only, every binding explicit; then execute maps ONLY the TEST key into the core; key removed from env; real T/C1 + fake X end to end", async () => {
  const rd = await A.framedDigest(ROOT, C.runnerFiles, A.RUNNER_DIGEST_PREFIX);
  const ph = A.buildPlan(C, { runRef: RUN, approvalRef: "synthetic-label-1", runnerDigest: rd }).planHash;
  const B = { E7_RUN_REF: RUN, E7_APPROVAL_REF: "synthetic-label-1", E7_EXPECTED_PLAN_HASH: ph, E7_EXPECTED_SOURCE_DIGEST: C.sourceDigest, E7_EXPECTED_RUNNER_DIGEST: rd, GITHUB_REF: "refs/heads/main" };
  assert.equal((await hosted("verify", B)).result.code, "VERIFY_OK");
  assert.equal((await hosted("verify", { ...B, GITHUB_REF: "refs/heads/feature/x" })).result.code, "AUTH_REF_NOT_MAIN");
  assert.equal((await hosted("verify", { ...B, E7_EXPECTED_RUNNER_DIGEST: "a".repeat(64) })).result.code, "AUTH_RUNNER_MISMATCH");
  assert.equal((await hosted("verify", { ...B, E7_EXPECTED_PLAN_HASH: "b".repeat(64) })).result.code, "AUTH_PLAN_HASH_MISMATCH");
  assert.equal((await hosted("verify", { ...B, E7_EXPECTED_SOURCE_DIGEST: "c".repeat(64) })).result.code, "AUTH_SOURCE_MISMATCH");
  assert.equal((await hosted("verify", { ...B, E7_EXPECTED_PLAN_HASH: "" })).result.code, "AUTH_INPUT_INCOMPLETE");
  assert.equal((await hosted("verify", { ...B, E7_STRIPE_TEST_KEY: KEY })).result.code, "AUTH_SECRET_SCOPE_VIOLATION");
  assert.equal((await hosted("execute", B)).result.code, "AUTH_CREDENTIALS_MISSING");
  let coreSeen = null;
  const fakeCore = async (i) => { coreSeen = { key: i.credential(), keys: Object.keys(i).sort(), planHash: A.buildPlan(C, i.plan).planHash }; return { outcome: "AUTH_TEST_COMPLETED_OK" }; };
  const env = { ...B, E7_STRIPE_TEST_KEY: KEY };
  const e = await A.runHosted({ mode: "execute", env: { E7_TOOLING_DIR: TOOLING, ...env }, proc: PROC, wrapperDir: ROOT, deps: { importTooling: async () => realMods, runCore: fakeCore,
    spawnChild: async () => { throw new Error("no child in execute"); } } });
  assert.deepEqual([e.exitCode, e.result.code, coreSeen.key, coreSeen.planHash], [0, "EXECUTE_DONE", KEY, ph]);
  assert.deepEqual(coreSeen.keys, ["body", "createStripeSend", "credential", "exchange", "plan", "runSignal"]);
  // full wiring with the REAL core, real T / C1 and a FAKE X exchange
  const f = fakeStripe(); const env2 = { E7_TOOLING_DIR: TOOLING, ...env };
  const w = await A.runHosted({ mode: "execute", env: env2, proc: PROC, wrapperDir: ROOT,
    deps: { importTooling: async () => ({ T, C1, X: { createE7RealExchange: () => ({ ok: true, exchange: f.exchange }) } }) } });
  assert.deepEqual([w.exitCode, w.result.core.outcome, f.calls.length, "E7_STRIPE_TEST_KEY" in env2], [0, "AUTH_TEST_COMPLETED_OK", 5, false]);
  assert.ok(!JSON.stringify(w).includes(KEY) && !A.summaryMarkdown(w.result).includes(KEY));
});

test("P1. source pins: inert on import, built-ins only, Stripe origin only, no capture / refund / Hostaway / DB / fetch; workflow scope", () => {
  const src = readFileSync(join(ROOT, "scripts/e7-stripe-authorization-test.mjs"), "utf8");
  const imports = [...src.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ["node:process", "node:child_process", "node:crypto", "node:fs/promises", "node:url"]);
  for (const re of [/paymentIntents\.capture/, /\/capture(?![-_a-z])/, /\brefunds?\b/i, /hostaway\.com|createE7HostawaySend/i, /\bfetch\s*\(/, /node:(https?|net|tls|dns)"/, /\bpg\b|supabase|webhook|vercel|sendgrid|resend/i,
    /https:\/\/(?!api\.stripe\.com)[a-z]/, /hostaway-reservations/]) assert.ok(!re.test(src.replace(/^\/\/.*$/gm, "")), String(re));
  assert.ok(/if \(import\.meta\.main === true\)/.test(src));
  const wf = readFileSync(join(ROOT, ".github/workflows/e7-stripe-authorization-test.yml"), "utf8");
  assert.deepEqual([...wf.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]), ["E7_STRIPE_TEST_KEY"]);
  assert.equal((wf.match(/environment: e7-readonly-probe/g) || []).length, 1);
  assert.ok(wf.includes("if: inputs.mode == 'execute' && github.ref == 'refs/heads/main'"));
  assert.ok(wf.includes("default: preflight") && wf.includes("ref: d1e20d71ecf15f82d2d3b74fd22eb562eaa310f8") && wf.includes('node-version: "22.22.0"'));
  for (const u of [...wf.matchAll(/uses: (\S+)/g)].map((m) => m[1])) assert.ok(["actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803", "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38"].includes(u), u);
  assert.ok(!/^on:\s*\n\s+(push|pull_request|schedule)/m.test(wf) && !/\bpush:|pull_request|schedule:/.test(wf));
});
