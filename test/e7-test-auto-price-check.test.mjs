// C124 focused tests for scripts/e7-test-auto-price-check.mjs + its workflow. Fakes only: no network, no secret.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import * as M from "../scripts/e7-test-auto-price-check.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = "scripts/e7-test-auto-price-check.mjs";
const WF = ".github/workflows/e7-test-auto-price-check.yml";
const TODAY = "2026-11-19";
const TOKEN = "tok_SECRET_abc123";
const inputs = (a = "2026-12-22", b = "2026-12-23", g = "1") => { const v = M.validateInputs(a, b, g, TODAY); assert.ok(v.ok, JSON.stringify(v)); return v; };

function fakeRequest(reply) {
  const calls = [];
  const fn = (opts, cb) => {
    const req = new EventEmitter(); req.written = [];
    req.write = (x) => { req.written.push(String(x)); }; req.destroy = () => {};
    req.end = (x) => {
      if (x !== undefined) req.written.push(String(x));
      calls.push({ opts, written: req.written });
      setImmediate(() => {
        if (reply.error) return req.emit("error", reply.error);
        if (reply.timeout) return req.emit("timeout");
        const res = new EventEmitter(); res.statusCode = reply.status; res.headers = reply.headers ?? {}; res.destroy = () => {};
        cb(res);
        setImmediate(() => { for (const c of [].concat(reply.body ?? [])) res.emit("data", Buffer.from(c)); res.emit("end"); });
      });
    };
    return req;
  };
  fn.calls = calls; return fn;
}
// a documented-shape reply (Stage D: type "accommodation", extra undocumented keys, ids, coupons) — only the allowlist may survive
const comp = (o) => ({ id: 987654, listingFeeSettingId: 4321, alias: "x", units: 1, displayInRent: 0, isOverriddenByUser: 0, isDeleted: 0, quantity: 0, ...o });
const GOOD = { status: "success", result: { totalPrice: 150, originalTotalPrice: 0, selectedComponentsAmount: 0,
  components: [comp({ type: "accommodation", name: "baseRate", title: "Base rate", value: 100, total: 100, isIncludedInTotalPrice: 1, isMandatory: 1 }),
    comp({ type: "fee", name: "cleaningFee", title: "Cleaning fee", value: 50, total: 50, isIncludedInTotalPrice: 1, isMandatory: 1 }),
    comp({ type: "fee", name: "petFee", title: "Pet fee", value: 20, total: 20, isIncludedInTotalPrice: 0, isMandatory: 0 })],
  extraComponents: [{ couponCode: "SECRETCOUPON" }], selectedComponents: [{ guestEmail: "jane@example.com" }] } };

test("I1 inputs: strict ISO dates, 1–31 nights half-open, not past, ≤730 days ahead; guests integer 1–10 only", () => {
  assert.deepEqual(inputs(), { ok: true, checkIn: "2026-12-22", checkOut: "2026-12-23", nights: 1, guests: 1 });
  assert.equal(inputs("2026-12-01", "2027-01-01", "10").nights, 31);
  for (const [a, b, g, code] of [["2026-12-01", "2027-01-02", "1", "RANGE_TOO_LONG"], ["2026-12-22", "2026-12-22", "1", "RANGE_EMPTY_OR_REVERSED"],
    ["2026-02-30", "2026-03-01", "1", "CHECK_IN_INVALID"], ["2026-12-22", "2026-12-23x", "1", "CHECK_OUT_INVALID"], ["2026-11-18", "2026-11-20", "1", "CHECK_IN_IN_PAST"],
    ["2028-11-20", "2028-11-21", "1", "CHECK_IN_TOO_FAR"], ["2026-12-22", "2026-12-23", "0", "GUESTS_INVALID"], ["2026-12-22", "2026-12-23", "11", "GUESTS_INVALID"],
    ["2026-12-22", "2026-12-23", "1.5", "GUESTS_INVALID"], ["2026-12-22", "2026-12-23", "01", "GUESTS_INVALID"], ["2026-12-22", "2026-12-23", " 1", "GUESTS_INVALID"],
    ["2026-12-22", "2026-12-23", undefined, "GUESTS_INVALID"]]) assert.deepEqual(M.validateInputs(a, b, g, TODAY), { ok: false, code }, `${a} ${b} ${g}`);
});

test("R1 exact request: ONE POST to api.hostaway.com:443 /v1/listings/606998/calendar/priceDetails, no query, 4 headers + length, body EXACTLY the 4 keys with version 2", async () => {
  const req = fakeRequest({ status: 200, body: JSON.stringify(GOOD) });
  const r = await M.readPriceDetails({ token: TOKEN, inputs: inputs(), request: req });
  assert.equal(r.ok, true); assert.equal(req.calls.length, 1);
  const { opts, written } = req.calls[0];
  assert.equal(opts.method, "POST"); assert.equal(opts.host, "api.hostaway.com"); assert.equal(opts.port, 443); assert.equal(opts.timeout, 8000);
  assert.equal(opts.path, "/v1/listings/606998/calendar/priceDetails");
  assert.deepEqual(Object.keys(opts.headers).sort(), ["Accept", "Authorization", "Cache-control", "Content-Length", "Content-Type"]);
  assert.equal(opts.headers.Authorization, `Bearer ${TOKEN}`); assert.equal(opts.headers["Content-Type"], "application/json"); assert.equal(opts.headers["Cache-control"], "no-cache");
  assert.equal(written.length, 1, "the body is written once");
  assert.equal(written[0], '{"startingDate":"2026-12-22","endingDate":"2026-12-23","numberOfGuests":1,"version":2}');
  assert.equal(opts.headers["Content-Length"], Buffer.byteLength(written[0]));
  const parsed = JSON.parse(written[0]);
  assert.deepEqual(Object.keys(parsed), ["startingDate", "endingDate", "numberOfGuests", "version"]);
  for (const k of ["markup", "reservationCouponId", "components", "couponName", "listingId", "price", "totalPrice"]) assert.ok(!(k in parsed), `${k} is never sent`);
});

test("R2 fail closed on transport: 3xx (never followed), 4xx, 5xx, timeout, socket error, invalid JSON, oversize; ONE request, no retry; bad token → no request", async () => {
  for (const [reply, code] of [[{ status: 302, headers: { location: "https://evil.example/" } }, "REDIRECT_REFUSED"], [{ status: 401 }, "HTTP_4XX"], [{ status: 429 }, "HTTP_4XX"],
    [{ status: 500 }, "HTTP_5XX"], [{ timeout: true }, "TIMEOUT"], [{ error: Object.assign(new Error("x"), { code: "ECONNREFUSED" }) }, "REQUEST_ECONNREFUSED"],
    [{ status: 200, body: "nope" }, "JSON_INVALID"], [{ status: 200, body: ["a".repeat(700 * 1024), "b".repeat(700 * 1024)] }, "BODY_TOO_LARGE"]]) {
    const req = fakeRequest(reply); const r = await M.readPriceDetails({ token: TOKEN, inputs: inputs(), request: req });
    assert.equal(r.ok, false); assert.equal(r.code, code); assert.equal(req.calls.length, 1, `${code}: exactly one request`);
    assert.doesNotMatch(JSON.stringify(r), /tok_|evil/);
  }
  for (const [tok, code] of [["", "TOKEN_MISSING"], ["a b", "TOKEN_SHAPE"]]) {
    const req = fakeRequest({ status: 200, body: "{}" });
    assert.equal((await M.readPriceDetails({ token: tok, inputs: inputs(), request: req })).code, code); assert.equal(req.calls.length, 0);
  }
});

test("P1 sanitized allowlist: only type / name / title / value / total / included / mandatory + totalPrice + sum check; ids, coupons, extras and guest data dropped", () => {
  const p = M.sanitizePriceDetails(GOOD);
  assert.equal(p.ok, true); assert.equal(p.totalPrice, 150); assert.equal(p.sumIncluded, 150); assert.equal(p.sumMatches, true);
  for (const c of p.components) assert.deepEqual(Object.keys(c), ["type", "name", "title", "value", "total", "isIncludedInTotalPrice", "isMandatory"]);
  const lines = M.report(inputs(), { ok: true, http: 200, price: p }).join("\n");
  assert.match(lines, /component type=accommodation name=baseRate title=Base rate value=100\.00 total=100\.00 included=1 mandatory=1/);
  assert.match(lines, /component type=fee name=cleaningFee title=Cleaning fee value=50\.00 total=50\.00 included=1 mandatory=1/);
  assert.match(lines, /totalPrice=150\.00 sumIncluded=150\.00 sumMatches=true/);
  assert.match(lines, /currency=NOT_IN_RESPONSE/); assert.match(lines, /RESULT PASS code=PRICE_CALCULATED http=200/);
  assert.doesNotMatch(lines, /987654|4321|SECRETCOUPON|jane@|alias|units|displayInRent/);
  const evil = structuredClone(GOOD); evil.result.components[0].title = "<script>alert(1)</script>";
  assert.match(M.report(inputs(), { ok: true, http: 200, price: M.sanitizePriceDetails(evil) }).join("\n"), /title=null/, "unsafe text is never echoed");
});

test("P2 malformed replies fail closed: fail envelope, wrong status, no result, bad total, no / malformed components, sum mismatch → FAIL", () => {
  const bad = (f) => { const j = structuredClone(GOOD); f(j); return M.sanitizePriceDetails(j); };
  assert.deepEqual(M.sanitizePriceDetails({ status: "fail", result: "Listing not found" }), { ok: false, code: "HOSTAWAY_FAIL" });
  assert.deepEqual(M.sanitizePriceDetails([GOOD.result]), { ok: false, code: "SHAPE_NOT_OBJECT" });
  assert.deepEqual(bad((j) => { delete j.status; }), { ok: false, code: "SHAPE_STATUS_NOT_SUCCESS" });
  assert.deepEqual(bad((j) => { j.result = []; }), { ok: false, code: "SHAPE_NO_RESULT_OBJECT" });
  assert.deepEqual(bad((j) => { j.result.totalPrice = "150"; }), { ok: false, code: "TOTAL_INVALID" });
  assert.deepEqual(bad((j) => { j.result.totalPrice = -1; }), { ok: false, code: "TOTAL_INVALID" });
  assert.deepEqual(bad((j) => { j.result.components = []; }), { ok: false, code: "COMPONENTS_MISSING" });
  assert.deepEqual(bad((j) => { j.result.components[1].total = null; }), { ok: false, code: "COMPONENT_MALFORMED" });
  assert.deepEqual(bad((j) => { j.result.components[1].isIncludedInTotalPrice = "1"; }), { ok: false, code: "COMPONENT_MALFORMED" });
  assert.deepEqual(bad((j) => { j.result.components = Array(51).fill(GOOD.result.components[0]); }), { ok: false, code: "COMPONENTS_TOO_MANY" });
  const mism = bad((j) => { j.result.totalPrice = 140; });
  assert.equal(mism.sumMatches, false);
  assert.match(M.report(inputs(), { ok: true, http: 200, price: mism }).at(-1), /RESULT FAIL code=SUM_MISMATCH/);
});

test("O1 CLI: invalid inputs fail before any request and never print the token", () => {
  const run = (env) => spawnSync(process.execPath, [join(ROOT, SCRIPT)], { env: { PATH: process.env.PATH, ...env }, encoding: "utf8" });
  const r = run({ E7_CHECK_IN: "2026-12-22", E7_CHECK_OUT: "2026-12-23", E7_GUESTS: "1; curl x", E7_HOSTAWAY_TOKEN: TOKEN });
  assert.equal(r.status, 3); assert.match(r.stdout, /RESULT FAIL code=GUESTS_INVALID http=none/); assert.doesNotMatch(r.stdout + r.stderr, /tok_/);
});

test("S1 script static boundary: node:https + node:url only, POST priceDetails is the only request, one host, no other endpoint / optional field, listing never from env", () => {
  const full = readFileSync(join(ROOT, SCRIPT), "utf8");
  const s = full.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n").replace(/\/\/ [^\n]*/g, "");
  assert.deepEqual([...s.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]).sort(), ["node:https", "node:url"]);
  assert.doesNotMatch(s, /import\(|require\(/);
  assert.deepEqual([...s.matchAll(/method: "([A-Z]+)"/g)].map((m) => m[1]), ["POST"]);
  assert.deepEqual([...s.matchAll(/path: `([^`]+)`/g)].map((m) => m[1]), ["/v1/listings/${CONSTANTS.listingId}/calendar/priceDetails"]);
  assert.deepEqual([...new Set([...s.matchAll(/"([a-z0-9.-]+\.(?:com|net|io))"/g)].map((m) => m[1]))], ["api.hostaway.com"]);
  assert.doesNotMatch(s, /markup|reservationCouponId|couponName|accessTokens|\/v1\/reservations|\/api\/|intent|supabase|stripe|\bpg\b|inventory/i);
  assert.doesNotMatch(s.replace(/checkIn|checkOut/g, ""), /checkout/i, "no checkout route (the checkIn / checkOut date fields aside)");
  assert.doesNotMatch(s, /env\.[A-Z0-9_]*LISTING/); assert.doesNotMatch(s, /dispatches|api\.github\.com/);
});

test("W1 workflow contract: workflow_dispatch only (dates + guests), main only, contents:read, the existing environment once, ONE secret in ONE step, inputs via env only", () => {
  const t = readFileSync(join(ROOT, WF), "utf8");
  assert.match(t, /\non:\n  workflow_dispatch:\n    inputs:\n      check_in:\n[\s\S]*?\n      check_out:\n[\s\S]*?\n      guests:\n[\s\S]*?\n\npermissions:\n  contents: read\n/);
  assert.doesNotMatch(t, /\n  (schedule|push|pull_request|pull_request_target|repository_dispatch|workflow_call|workflow_run):/);
  assert.deepEqual(t.match(/environment: [a-z0-9-]+/g), ["environment: e7-test-auto"]);
  assert.match(t, /\n  check:\n    if: github\.ref == 'refs\/heads\/main'\n    runs-on: ubuntu-24\.04\n    environment: e7-test-auto\n/);
  assert.deepEqual(t.match(/secrets\.[A-Z0-9_]+/g), ["secrets.E7_HOSTAWAY_TOKEN"]);
  assert.doesNotMatch(t, /vars\.|github\.token|GITHUB_TOKEN|actions: write|contents: write|id-token|gh workflow|dispatches|E7_DEV_BOOKING|E7_STRIPE|E7_RESEND|E7_DISPATCH|E7_TEST_AUTO_ARMED|tooling|npm /);
  const steps = t.split("\n      - name: ").slice(1);
  const withSecret = steps.filter((x) => /secrets\./.test(x));
  assert.equal(withSecret.length, 1);
  assert.match(withSecret[0], /E7_HOSTAWAY_TOKEN: \$\{\{ secrets\.E7_HOSTAWAY_TOKEN \}\}\n        run: node wrapper\/scripts\/e7-test-auto-price-check\.mjs 2>\/dev\/null(\n|$)/);
  for (const x of steps) { const run = x.split("\n        run:")[1] ?? ""; assert.doesNotMatch(run, /\$\{\{/, "no expression inside a run script"); }
  assert.equal((t.match(/persist-credentials: false/g) || []).length, 1);
});
