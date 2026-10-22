// E4 payment isolation — lib/payment-rules-check.js + api/hostaway/payment-rules-check.js. Offline: fake global fetch,
// fake credentials, SYNTHETIC responses (shaped like the documented example; not provider evidence).
// One module instance of lib/hostaway.js per file: the auth-mint failure test runs before the first successful mint.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { summarizeAutoPaymentRules, summarizeThrown, VERDICTS, REASONS } from "../lib/payment-rules-check.js";

const ROOT = new URL("..", import.meta.url).pathname;
const DIAG = "test-only-diag-key";
const FAKE_TOKEN = "fake-token-not-a-secret-0123456789";
const RULE = (id, over = {}) => ({ id, accountId: 99999, guestAutoInvoiceId: 1, type: "charge", title: "SYNTHETIC-TITLE-<b>x</b>",
  description: "SYNTHETIC-DESCRIPTION", triggerEvent: "reservation", triggerTimeDelta: 2, paymentMethod: "credit_card_online",
  paymentProvider: "stripe", flatFee: null, percentageFee: 33, isRestOfPay: 0, insertedOn: "2023-07-31 10:17:00", updatedOn: "2023-07-31 10:17:00", ...over });
const LIST = (rules, extra = {}) => ({ status: "success", result: rules, count: rules.length, offset: null, ...extra });

// ---------- summarizer ----------
test("summarizer: empty list => NO_RULES_RETURNED, never 'isolation proven'", () => {
  const s = summarizeAutoPaymentRules(200, LIST([]));
  assert.deepEqual({ ...s }, { verdict: "NO_RULES_RETURNED", reason: null, httpStatus: 200, returnedCount: 0, declaredCount: 0,
    countConsistent: true, listingScopeDocumented: false, isolationProven: false });
});

test("summarizer: rules present => RULES_PRESENT_UNSCOPED with counts only (no rule content)", () => {
  const s = summarizeAutoPaymentRules(200, LIST([RULE(1), RULE(2, { type: "preAuth" }), RULE(3)]));
  assert.deepEqual([s.verdict, s.returnedCount, s.declaredCount, s.countConsistent, s.isolationProven], ["RULES_PRESENT_UNSCOPED", 3, 3, true, false]);
  const text = JSON.stringify(s);
  for (const x of ["SYNTHETIC", "99999", "stripe", "credit_card", "charge", "preAuth", "reservation"]) assert.ok(!text.includes(x), x);
});

test("summarizer: every unknown/malformed/inconsistent case is UNRESOLVED (never treated as no rules)", () => {
  const cases = [
    [[401, LIST([])], "HTTP_NOT_OK"], [[403, LIST([])], "HTTP_NOT_OK"], [[429, LIST([])], "HTTP_NOT_OK"], [[500, null], "HTTP_NOT_OK"],
    [[204, null], "HTTP_NOT_OK"], [["200", LIST([])], "HTTP_NOT_OK"], [[null, LIST([])], "HTTP_NOT_OK"],
    [[200, null], "MALFORMED_ENVELOPE"], [[200, []], "MALFORMED_ENVELOPE"], [[200, { result: [] }], "MALFORMED_ENVELOPE"],
    [[200, { status: "fail", result: "no permission" }], "FAIL_ENVELOPE"], [[200, { status: "success", result: {} , count: 0 }], "MALFORMED_ENVELOPE"],
    [[200, { status: "SUCCESS", result: [], count: 0 }], "MALFORMED_ENVELOPE"], [[200, { status: "success", count: 0 }], "MALFORMED_ENVELOPE"],
    [[200, { status: "success", result: [] }], "COUNT_MISSING"], [[200, { status: "success", result: [], count: null }], "COUNT_MISSING"],
    [[200, { status: "success", result: [], count: "0" }], "COUNT_INVALID"], [[200, { status: "success", result: [], count: -1 }], "COUNT_INVALID"],
    [[200, { status: "success", result: [], count: 1.5 }], "COUNT_INVALID"],
    [[200, { status: "success", result: [], count: 2 }], "COUNT_INCONSISTENT"], [[200, { status: "success", result: [RULE(1)], count: 0 }], "COUNT_INCONSISTENT"],
    [[200, LIST([RULE(1), "x"])], "ITEM_MALFORMED"], [[200, LIST([RULE(0)])], "ITEM_MALFORMED"], [[200, LIST([RULE("1")])], "ITEM_MALFORMED"],
    [[200, LIST([RULE(1), RULE(1)])], "ITEM_MALFORMED"], [[200, LIST([null])], "ITEM_MALFORMED"]
  ];
  for (const [[st, json], reason] of cases) {
    const s = summarizeAutoPaymentRules(st, json);
    assert.deepEqual([s.verdict, s.reason, s.isolationProven], ["UNRESOLVED", reason, false], JSON.stringify([st, json]));
    assert.ok(VERDICTS.includes(s.verdict) && REASONS.includes(s.reason));
  }
  assert.equal(summarizeAutoPaymentRules(200, { status: "success", result: [], count: 2 }).countConsistent, false);
  assert.equal(summarizeAutoPaymentRules(200, { status: "success", result: [] }).countConsistent, "unknown");
});

test("summarizer: thrown errors => UNRESOLVED (auth vs transport), nothing from the error is copied", () => {
  assert.deepEqual([summarizeThrown(Object.assign(new Error("secret-ish detail"), { code: "HOSTAWAY_AUTH_FAILED" })).reason,
    summarizeThrown(Object.assign(new Error("x"), { code: "HOSTAWAY_ENV_MISSING" })).reason,
    summarizeThrown(new Error("socket hang up")).reason, summarizeThrown(undefined).reason], ["AUTH_FAILED", "AUTH_FAILED", "TRANSPORT_UNCERTAIN", "TRANSPORT_UNCERTAIN"]);
  assert.ok(!JSON.stringify(summarizeThrown(new Error("secret-ish detail"))).includes("secret"));
});

// ---------- route ----------
const calls = [];
let table = {};
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  calls.push({ origin: u.origin, method: init.method || "GET", path: u.pathname, search: u.search, body: init.body ?? null, hasSignal: !!init.signal });
  const v = table[`${init.method || "GET"} ${u.pathname}`];
  if (v instanceof Error) throw v;
  if (!v) return new Response(JSON.stringify({ status: "fail", result: "synthetic not found" }), { status: 404 });
  return new Response(typeof v.raw === "string" ? v.raw : JSON.stringify(v.json ?? {}), { status: v.status ?? 200 });
};
const MINT = { "POST /v1/accessTokens": { json: { token_type: "Bearer", expires_in: 3600, access_token: FAKE_TOKEN } } };
process.env.HOSTAWAY_ACCOUNT_ID = "12345";
process.env.HOSTAWAY_CLIENT_SECRET = "fake-client-secret-not-real";
const BRANCH = "feature/e4-payment-isolation-readonly";
const GATE = { VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: BRANCH };
const setEnv = (vars) => { for (const k of ["VERCEL_ENV", "VERCEL_GIT_COMMIT_REF", "HOSTAWAY_DIAG_KEY"]) delete process.env[k]; Object.assign(process.env, vars); };
const { default: handler, paymentCheckGateOpen } = await import("../api/hostaway/payment-rules-check.js");
async function run({ method = "GET", headers = { "x-admin-key": DIAG }, query = {}, url = "/api/hostaway/payment-rules-check", body } = {}) {
  const r = { headers: {}, statusCode: null, body: null };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.send = (b) => { r.body = b; return r; };
  r.end = () => r;
  await handler({ method, headers, query, url, body }, r);
  return r;
}
const fresh = (t) => { calls.length = 0; table = t; };
const providerCalls = () => calls.filter((c) => c.path !== "/v1/accessTokens");

test("route gate: 404 before method/auth/provider unless preview AND this exact branch", async () => {
  for (const env of [{}, { VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: BRANCH }, { VERCEL_ENV: "preview" }, { VERCEL_GIT_COMMIT_REF: BRANCH },
    { VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "feature/e4-readonly-route" }, { VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "DEV" },
    { VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "main" }, { VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: `${BRANCH}-x` }]) {
    setEnv({ ...env, HOSTAWAY_DIAG_KEY: DIAG }); fresh({ ...MINT });
    for (const method of ["GET", "POST"]) {
      const r = await run({ method, query: { a: "1" } });
      assert.deepEqual([r.statusCode, r.body], [404, { ok: false, error: "NOT_FOUND" }], JSON.stringify(env));
      assert.equal(r.headers["cache-control"], "no-store");
    }
    assert.equal(calls.length, 0);
  }
  assert.equal(paymentCheckGateOpen(GATE), true);
});

test("route: GET only; any query string or body is rejected; auth required — all with zero provider calls", async () => {
  setEnv({ ...GATE, HOSTAWAY_DIAG_KEY: DIAG }); fresh({ ...MINT });
  for (const method of ["POST", "PUT", "DELETE", "PATCH", "HEAD"]) {
    const r = await run({ method });
    assert.deepEqual([r.statusCode, r.body.error, r.headers.allow], [405, "METHOD_NOT_ALLOWED", "GET"], method);
  }
  for (const req of [{ query: { listingId: "606998" } }, { query: { x: "" } }, { url: "/api/hostaway/payment-rules-check?" },
    { url: "/api/hostaway/payment-rules-check?key=abc" }, { body: { a: 1 } }, { body: "x" }, { headers: { "x-admin-key": DIAG, "content-length": "5" } },
    { headers: { "x-admin-key": DIAG, "transfer-encoding": "chunked" } }]) {
    const r = await run(req);
    assert.deepEqual([r.statusCode, r.body], [400, { ok: false, error: "NO_INPUTS_ACCEPTED" }], JSON.stringify(req));
  }
  for (const headers of [{}, { "x-admin-key": "wrong" }, { "x-admin-key": "" }, { authorization: DIAG }]) {
    const r = await run({ headers });
    assert.deepEqual([r.statusCode, r.body.error], [401, "UNAUTHORIZED"]);
  }
  setEnv({ ...GATE });
  assert.deepEqual([(await run()).statusCode, (await run()).body.error], [503, "DIAGNOSTIC_DISABLED"]);
  assert.equal(calls.length, 0);
});

test("route: token mint failure => UNRESOLVED/AUTH_FAILED, the data path is never called", async () => {
  setEnv({ ...GATE, HOSTAWAY_DIAG_KEY: DIAG });
  fresh({ "POST /v1/accessTokens": { status: 401, json: { status: "fail" } } });
  const r = await run();
  assert.deepEqual([r.statusCode, r.body.verdict, r.body.reason], [200, "UNRESOLVED", "AUTH_FAILED"]);
  assert.equal(providerCalls().length, 0);
});

test("route: exactly one fixed GET /v1/guestPayments/autoPayment, no query, with timeout; sanitized output keys only", async () => {
  setEnv({ ...GATE, HOSTAWAY_DIAG_KEY: DIAG });
  fresh({ ...MINT, "GET /v1/guestPayments/autoPayment": { json: LIST([RULE(1), RULE(2)]) } });
  const r = await run();
  assert.equal(r.statusCode, 200);
  assert.deepEqual(providerCalls().map((c) => [c.origin, c.method, c.path, c.search, c.body, c.hasSignal]),
    [["https://api.hostaway.com", "GET", "/v1/guestPayments/autoPayment", "", null, true]]);
  assert.deepEqual(Object.keys(r.body).sort(), ["countConsistent", "declaredCount", "finishedAt", "httpStatus", "isolationProven",
    "listingScopeDocumented", "mode", "ok", "reason", "returnedCount", "startedAt", "tool", "verdict", "version", "writes"].sort());
  assert.deepEqual([r.body.verdict, r.body.returnedCount, r.body.declaredCount, r.body.isolationProven], ["RULES_PRESENT_UNSCOPED", 2, 2, false]);
  const text = JSON.stringify(r.body);
  for (const x of ["SYNTHETIC", "99999", "stripe", FAKE_TOKEN, "fake-client-secret", DIAG, "12345"]) assert.ok(!text.includes(x), x);
  assert.equal(r.headers["cache-control"], "no-store");
  assert.ok(!Object.keys(r.headers).some((h) => h.startsWith("access-control-")), "no CORS");
});

test("route: empty list => NO_RULES_RETURNED; 401/403 => UNRESOLVED with ONE attempt (no re-mint retry)", async () => {
  setEnv({ ...GATE, HOSTAWAY_DIAG_KEY: DIAG });
  fresh({ ...MINT, "GET /v1/guestPayments/autoPayment": { json: LIST([]) } });
  assert.deepEqual([(await run()).body.verdict, providerCalls().length], ["NO_RULES_RETURNED", 1]);
  for (const s of [401, 403, 429, 500]) {
    fresh({ ...MINT, "GET /v1/guestPayments/autoPayment": { status: s, json: { status: "fail", result: "synthetic" } } });
    const r = await run();
    assert.deepEqual([r.body.verdict, r.body.reason, r.body.httpStatus], ["UNRESOLVED", "HTTP_NOT_OK", s], String(s));
    assert.equal(providerCalls().length, 1, `${s}: single attempt`);
    assert.equal(calls.filter((c) => c.path === "/v1/accessTokens").length, 0, `${s}: no re-mint`);
  }
  fresh({ ...MINT, "GET /v1/guestPayments/autoPayment": { raw: "<html>not json</html>" } });
  assert.deepEqual([(await run()).body.verdict, (await run()).body.reason], ["UNRESOLVED", "MALFORMED_ENVELOPE"]);
  fresh({ ...MINT, "GET /v1/guestPayments/autoPayment": Object.assign(new Error("timeout"), { name: "TimeoutError" }) });
  const t = await run();
  assert.deepEqual([t.body.verdict, t.body.reason, providerCalls().length], ["UNRESOLVED", "TRANSPORT_UNCERTAIN", 1]);
});

test("containment: the route source has no logging, CORS, other paths, writes or broadened gate", () => {
  const src = readFileSync(join(ROOT, "api/hostaway/payment-rules-check.js"), "utf8");
  const code = src.replace(/\/\/.*$/gm, "");
  for (const re of [/console\./, /Access-Control/i, /hostawayPost|hostawayPut|hostawayDelete/, /method:\s*"(POST|PUT|DELETE|PATCH)"/]) assert.doesNotMatch(code, re, String(re));
  assert.match(code, /retryOnAuth: false/);
  assert.equal((code.match(/hostawayGet\(/g) || []).length, 1);
  const lib = readFileSync(join(ROOT, "lib/payment-rules-check.js"), "utf8");
  assert.match(lib, /export const PAYMENT_RULES_PATH = "\/guestPayments\/autoPayment";/);
  const old = readFileSync(join(ROOT, "api/hostaway/e4-check.js"), "utf8");
  assert.match(old, /export const E4_ROUTE_BRANCH = "feature\/e4-readonly-route";/, "the old route keeps its own gate (404 on this branch)");
});
