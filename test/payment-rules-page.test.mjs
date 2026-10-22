// E4 payment isolation — api/hostaway/payment-rules-page.js (static owner page). Offline; the page script is executed
// against a minimal DOM stub and a fake fetch to check its behaviour (one attempt, key cleared, fixed target).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const BRANCH = "feature/e4-payment-isolation-readonly";
const setEnv = (vars) => { for (const k of ["VERCEL_ENV", "VERCEL_GIT_COMMIT_REF"]) delete process.env[k]; Object.assign(process.env, vars); };
const page = await import("../api/hostaway/payment-rules-page.js");
const { PAGE_HTML, PAGE_SCRIPT, PAGE_STYLE, CSP, CHECK_PATH } = page;
function run({ method = "GET", query = {}, url = "/api/hostaway/payment-rules-page", headers = {} } = {}) {
  const r = { headers: {}, statusCode: null, body: null };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.send = (b) => { r.body = b; return r; };
  page.default({ method, query, url, headers }, r);
  return r;
}

test("page gate: 404 unless preview AND this exact branch; GET only; no query (never a key in the URL)", () => {
  for (const env of [{}, { VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: BRANCH }, { VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "DEV" },
    { VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "feature/e4-readonly-route" }]) {
    setEnv(env);
    const r = run();
    assert.deepEqual([r.statusCode, r.body], [404, { ok: false, error: "NOT_FOUND" }]);
    assert.equal(r.headers["cache-control"], "no-store");
  }
  setEnv({ VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: BRANCH });
  assert.deepEqual([run({ method: "POST" }).statusCode, run({ method: "POST" }).headers.allow], [405, "GET"]);
  assert.equal(run({ query: { k: "x" } }).statusCode, 400);
  assert.equal(run({ url: "/api/hostaway/payment-rules-page?k=x" }).statusCode, 400);
});

test("page headers: no-store, strict CSP whose hashes match the exact inline script/style, no CORS, no framing", () => {
  setEnv({ VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: BRANCH });
  const r = run();
  assert.equal(r.statusCode, 200);
  assert.equal(r.headers["content-type"], "text/html; charset=utf-8");
  assert.equal(r.headers["cache-control"], "no-store");
  assert.equal(r.headers["referrer-policy"], "no-referrer");
  assert.equal(r.headers["x-content-type-options"], "nosniff");
  assert.equal(r.headers["x-frame-options"], "DENY");
  assert.ok(!Object.keys(r.headers).some((h) => h.startsWith("access-control-")));
  const csp = r.headers["content-security-policy"];
  assert.equal(csp, CSP);
  const h = (s) => `'sha256-${createHash("sha256").update(s, "utf8").digest("base64")}'`;
  for (const d of ["default-src 'none'", `script-src ${h(PAGE_SCRIPT)}`, `style-src ${h(PAGE_STYLE)}`, "connect-src 'self'", "form-action 'none'",
    "base-uri 'none'", "frame-ancestors 'none'", "img-src 'none'"]) assert.ok(csp.split("; ").includes(d), d);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|https?:|\*/);
  assert.ok(PAGE_HTML.includes(`<script>${PAGE_SCRIPT}</script>`) && PAGE_HTML.includes(`<style>${PAGE_STYLE}</style>`));
  assert.equal((PAGE_HTML.match(/<script/g) || []).length, 1);
});

test("page content: no external assets, storage, cookies, logging, innerHTML, eval, URL params or analytics", () => {
  for (const re of [/https?:\/\//, /src=/, /<link/i, /localStorage|sessionStorage|indexedDB|document\.cookie|caches\./, /console\./, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/,
    /\beval\b|new Function|setTimeout|setInterval/, /location\.|URLSearchParams|history\./, /analytics|gtag|sendBeacon/]) {
    assert.doesNotMatch(PAGE_HTML, re, String(re));
  }
  assert.match(PAGE_HTML, /<input id="k" type="password" autocomplete="off"/);
  assert.doesNotMatch(PAGE_HTML, /<input[^>]*\bname=/, "the key field has no name, so a form can never submit it");
  assert.doesNotMatch(PAGE_HTML, /<form[^>]*\b(action|method)=/);
  assert.match(PAGE_HTML, /cannot guarantee/, "no claim of absolute browser-memory secrecy");
  assert.equal((PAGE_SCRIPT.match(/fetch\(/g) || []).length, 1);
  assert.ok(PAGE_SCRIPT.includes(`fetch("${CHECK_PATH}", {`) && CHECK_PATH === "/api/hostaway/payment-rules-check");
});

// ---------- behaviour: run the inline script against a minimal DOM stub ----------
function makeDom() {
  const el = (id) => ({ id, value: "", disabled: false, hidden: id === "out", _text: "", listeners: {},
    set textContent(v) { this._text = String(v); }, get textContent() { return this._text; },
    set innerHTML(v) { throw new Error("innerHTML used"); },
    addEventListener(t, fn) { this.listeners[t] = fn; } });
  const ids = ["f", "k", "run", "status", "out", "o-http", "o-verdict", "o-reason", "o-error", "o-provider", "o-returned", "o-declared", "o-consistent", "o-isolation"];
  const els = Object.fromEntries(ids.map((i) => [i, el(i)]));
  return { els, document: { getElementById: (i) => { if (!els[i]) throw new Error(`unknown id ${i}`); return els[i]; } } };
}
function load(fetchImpl) {
  const { els, document } = makeDom();
  const fetchCalls = [];
  const fetch = (url, init) => { fetchCalls.push({ url, init, keyFieldAtSend: els.k.value, disabledAtSend: els.run.disabled }); return fetchImpl(url, init); };
  // eslint-disable-next-line no-new-func -- test harness only: executes the exact inline page script
  new Function("document", "fetch", "Headers", PAGE_SCRIPT)(document, fetch, Headers);
  const submit = () => { let prevented = false; els.f.listeners.submit({ preventDefault: () => { prevented = true; } }); return prevented; };
  return { els, fetchCalls, submit };
}
const flush = () => new Promise((r) => setImmediate(r));
const response = (status, body) => Promise.resolve({ status, json: () => (body instanceof Error ? Promise.reject(body) : Promise.resolve(body)) });

test("behaviour: no auto-run; empty key sends nothing; one user-triggered fixed request; key only in header; field cleared first", async () => {
  const { els, fetchCalls, submit } = load(() => response(200, { verdict: "NO_RULES_RETURNED", reason: null, httpStatus: 200, returnedCount: 0,
    declaredCount: 0, countConsistent: true, isolationProven: false }));
  await flush();
  assert.equal(fetchCalls.length, 0, "no auto-run");
  assert.equal(submit(), true);
  assert.equal(fetchCalls.length, 0, "no key, no request");
  els.k.value = "owner-typed-key";
  assert.equal(submit(), true, "navigation/form submission prevented");
  await flush();
  assert.equal(fetchCalls.length, 1);
  const c = fetchCalls[0];
  assert.equal(c.url, "/api/hostaway/payment-rules-check");
  assert.deepEqual([c.init.method, c.init.cache, c.init.credentials, c.init.redirect, c.init.referrerPolicy], ["GET", "no-store", "same-origin", "error", "no-referrer"]);
  assert.equal(c.init.headers.get("x-admin-key"), "owner-typed-key");
  assert.equal([...c.init.headers.keys()].length, 1);
  assert.equal(c.init.body, undefined);
  assert.equal(c.keyFieldAtSend, "", "input cleared before the request is sent");
  assert.equal(c.disabledAtSend, true);
  assert.equal(els["o-verdict"].textContent, "NO_RULES_RETURNED");
  assert.equal(els["o-isolation"].textContent, "no (this check cannot prove isolation)");
  assert.equal(els.out.hidden, false);
  assert.ok(!JSON.stringify(Object.values(els).map((e) => e.textContent)).includes("owner-typed-key"), "key never displayed");
});

test("behaviour: locked after one attempt — a second submit sends nothing (reload to retry)", async () => {
  const { els, fetchCalls, submit } = load(() => response(401, { ok: false, error: "UNAUTHORIZED" }));
  els.k.value = "k1"; submit(); await flush();
  els.k.disabled = false; els.k.value = "k2"; submit(); submit(); await flush();
  assert.equal(fetchCalls.length, 1);
  assert.deepEqual([els["o-http"].textContent, els["o-error"].textContent, els["o-verdict"].textContent], ["401", "UNAUTHORIZED", "NOT_AVAILABLE"]);
  assert.match(els.status.textContent, /Reload/);
});

test("behaviour: hostile or malformed responses are rendered only as fixed codes via textContent", async () => {
  const hostile = { verdict: "<img src=x onerror=alert(1)>", reason: "<script>", error: "x".repeat(50), httpStatus: "200", returnedCount: -1,
    declaredCount: 1.5, countConsistent: "maybe", isolationProven: true, title: "SYNTHETIC-TITLE" };
  let { els, submit } = load(() => response(200, hostile));
  els.k.value = "k"; submit(); await flush();
  assert.deepEqual(["o-verdict", "o-reason", "o-error", "o-provider", "o-returned", "o-declared", "o-consistent", "o-isolation"].map((i) => els[i].textContent),
    ["NOT_AVAILABLE", "-", "-", "-", "-", "-", "-", "-"]);
  ({ els, submit } = load(() => response(502, new Error("not json"))));
  els.k.value = "k"; submit(); await flush();
  assert.deepEqual([els["o-http"].textContent, els["o-verdict"].textContent], ["502", "NOT_AVAILABLE"]);
  ({ els, submit } = load(() => Promise.reject(new Error("network"))));
  els.k.value = "k"; submit(); await flush();
  assert.deepEqual([els["o-http"].textContent, els["o-error"].textContent], ["-", "REQUEST_FAILED"]);
});
