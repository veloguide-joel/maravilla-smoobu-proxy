// api/hostaway/e4-check.js — Stage E4 feature-preview-only read-only route. Offline: fake global fetch, fake
// credentials, SYNTHETIC fixtures (test/fixtures/hostaway/README.md). Run: npm test
// Test ORDER matters for the token cache of lib/hostaway.js (one module instance per test file):
// the auth-mint failure tests run before the first successful mint.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const fixture = (n) => JSON.parse(readFileSync(join(ROOT, "test/fixtures/hostaway", n), "utf8"));
const FIELDS = fixture("synthetic-ro-custom-fields.json");
const LISTING = fixture("synthetic-ro-listing.json");
const CALENDAR = fixture("synthetic-ro-calendar.json");
const PRICE = fixture("synthetic-ro-price-details.json");
const FAKE_TOKEN = "fake-token-not-a-secret-0123456789";
const FAKE_SECRET = "fake-client-secret-not-real";
const DIAG = "test-only-diag-key";

// ---- fake provider ----
const calls = [];
let table = {};
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  calls.push({ origin: u.origin, method: init.method || "GET", path: u.pathname, query: Object.fromEntries(u.searchParams), body: init.body ?? null, headers: { ...(init.headers || {}) } });
  const key = `${init.method || "GET"} ${u.pathname}`;
  const v = table[key];
  if (v instanceof Error) throw v;
  if (!v) return new Response(JSON.stringify({ status: "fail", result: "synthetic not found" }), { status: 404 });
  return new Response(JSON.stringify(v.json ?? {}), { status: v.status ?? 200 });
};
const HAPPY = () => ({
  "POST /v1/accessTokens": { json: { token_type: "Bearer", expires_in: 3600, access_token: FAKE_TOKEN } },
  "GET /v1/customFields": { json: structuredClone(FIELDS) },
  "GET /v1/listings/606998": { json: structuredClone(LISTING) },
  "GET /v1/listings/606998/calendar": { json: structuredClone(CALENDAR) },
  "POST /v1/listings/606998/calendar/priceDetails": { json: structuredClone(PRICE) }
});

process.env.HOSTAWAY_ACCOUNT_ID = "12345";
process.env.HOSTAWAY_CLIENT_SECRET = FAKE_SECRET;
const GATE = { VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "feature/e4-readonly-route" };
const setEnv = (vars) => { for (const k of ["VERCEL_ENV", "VERCEL_GIT_COMMIT_REF", "HOSTAWAY_DIAG_KEY"]) delete process.env[k]; Object.assign(process.env, vars); };

const mod = await import("../api/hostaway/e4-check.js");
const handler = mod.default;
const QUERY = { from: "2027-03-10", to: "2027-03-12", guests: "2" };
async function run({ method = "GET", headers = { "x-admin-key": DIAG }, query = QUERY } = {}) {
  const r = { headers: {}, statusCode: null, body: null };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.end = () => r;
  await handler({ method, headers, query }, r);
  return r;
}
const fresh = (t = HAPPY()) => { calls.length = 0; table = t; };

// ---------- gate, method, auth, parameters: zero provider calls ----------
test("deployment gate: 404 before auth/method/provider unless preview AND exact branch (fail-closed)", async () => {
  const cases = [
    {}, { VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "feature/e4-readonly-route" }, { VERCEL_ENV: "development", VERCEL_GIT_COMMIT_REF: "feature/e4-readonly-route" },
    { VERCEL_ENV: "preview" }, { VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "DEV" }, { VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "main" },
    { VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "feature/e4-readonly-route-x" }, { VERCEL_ENV: "Preview", VERCEL_GIT_COMMIT_REF: "feature/e4-readonly-route" }
  ];
  for (const env of cases) {
    setEnv({ ...env, HOSTAWAY_DIAG_KEY: DIAG }); fresh();
    for (const method of ["GET", "POST"]) {
      const r = await run({ method });
      assert.deepEqual([r.statusCode, r.body], [404, { ok: false, error: "NOT_FOUND" }], JSON.stringify(env));
      assert.equal(r.headers["cache-control"], "no-store");
    }
    assert.equal(calls.length, 0, "no provider call while the gate is closed");
  }
  assert.equal(mod.e4GateOpen(GATE), true);
});

test("gate open: method 405, missing/wrong key 401, unset diag key 503 — all with zero provider calls", async () => {
  setEnv({ ...GATE, HOSTAWAY_DIAG_KEY: DIAG }); fresh();
  for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"]) assert.equal((await run({ method })).statusCode, 405, method);
  assert.deepEqual([(await run({ headers: {} })).statusCode, (await run({ headers: {} })).body], [401, { ok: false, error: "UNAUTHORIZED" }]);
  assert.equal((await run({ headers: { "x-admin-key": "wrong" } })).statusCode, 401);
  assert.equal((await run({ headers: { "x-admin-key": `${DIAG} ` } })).statusCode, 401);
  assert.equal((await run({ headers: { authorization: DIAG } })).statusCode, 401);
  setEnv({ ...GATE });
  assert.deepEqual([(await run()).statusCode, (await run()).body], [503, { ok: false, error: "DIAGNOSTIC_DISABLED" }]);
  assert.equal(calls.length, 0);
});

test("strict parameters: anything but from/to/guests (valid) is 400 with zero provider calls", async () => {
  setEnv({ ...GATE, HOSTAWAY_DIAG_KEY: DIAG }); fresh();
  const bad = [
    [{ ...QUERY, id: "603564" }, "UNKNOWN_PARAMETER"], [{ ...QUERY, listingId: "606998" }, "UNKNOWN_PARAMETER"], [{ ...QUERY, path: "/reservations" }, "UNKNOWN_PARAMETER"],
    [{ ...QUERY, forceOverbooking: "1" }, "UNKNOWN_PARAMETER"], [{ from: "2027-03-10", to: "2027-03-12" }, "MISSING_OR_REPEATED_PARAMETER"],
    [{ ...QUERY, from: ["2027-03-10", "2027-03-11"] }, "MISSING_OR_REPEATED_PARAMETER"], [{ ...QUERY, from: "2027-02-30" }, "INVALID_DATE"],
    [{ ...QUERY, to: "2027-03-10" }, "DEPARTURE_NOT_AFTER_ARRIVAL"], [{ ...QUERY, to: "2027-04-12" }, "WINDOW_TOO_LONG"],
    [{ ...QUERY, guests: "0" }, "INVALID_GUESTS"], [{ ...QUERY, guests: "17" }, "INVALID_GUESTS"], [{ ...QUERY, guests: "2.5" }, "INVALID_GUESTS"], [{ ...QUERY, guests: "-1" }, "INVALID_GUESTS"]
  ];
  for (const [query, error] of bad) assert.deepEqual([(await run({ query })).statusCode, (await run({ query })).body.error], [400, error], JSON.stringify(query));
  assert.equal(calls.length, 0);
});

// ---------- provider calls (order matters: auth failures before the first successful mint) ----------
test("auth mint failure stops the run: one mint attempt, zero business calls, no retry", async () => {
  setEnv({ ...GATE, HOSTAWAY_DIAG_KEY: DIAG });
  for (const t of [{ "POST /v1/accessTokens": { status: 500, json: {} } }, { "POST /v1/accessTokens": new Error("ECONNRESET") }]) {
    fresh(t);
    const r = await run();
    assert.equal(r.statusCode, 200);
    assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ["POST /v1/accessTokens"]);
    assert.equal(r.body.stoppedEarly, true);
    assert.ok(["AUTH_FAILED", "TRANSPORT_UNCERTAIN"].includes(r.body.results.customFields.code));
    assert.equal(r.body.readiness.verdict, "UNRESOLVED");
    assert.deepEqual(r.body.readiness.reads, { customFields: r.body.results.customFields.code, listing: "NOT_RUN", calendar: "NOT_RUN", priceDetails: "NOT_RUN" });
  }
});

test("happy path: one mint + exactly four fixed business calls, in order, documented shapes, sanitized PASSED report", async () => {
  setEnv({ ...GATE, HOSTAWAY_DIAG_KEY: DIAG }); fresh();
  const r = await run();
  assert.equal(r.statusCode, 200);
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ["POST /v1/accessTokens", "GET /v1/customFields", "GET /v1/listings/606998",
    "GET /v1/listings/606998/calendar", "POST /v1/listings/606998/calendar/priceDetails"]);
  assert.ok(calls.every((c) => c.origin === "https://api.hostaway.com"));
  assert.deepEqual(calls[1].query, { objectType: "reservation", limit: "100", offset: "0" });
  assert.deepEqual(calls[2].query, {});
  assert.deepEqual(calls[3].query, { startDate: "2027-03-10", endDate: "2027-03-12" });
  assert.deepEqual(JSON.parse(calls[4].body), { startingDate: "2027-03-10", endingDate: "2027-03-12", numberOfGuests: 2, version: 2 });
  assert.equal(r.body.outcome, "READ_ONLY_CHECKS_PASSED");
  assert.deepEqual(r.body.readiness.reads, { customFields: "ok", listing: "ok", calendar: "ok", priceDetails: "ok" });
  assert.deepEqual([r.body.results.priceDetails.totalMinor, r.body.results.priceDetails.cleaningFeeMinor, r.body.results.listing.currencyCode], [25000, 5000, "USD"]);
  assert.match(r.body.scope, /never authorizes a booking/);
  assert.equal(r.headers["cache-control"], "no-store");
  assert.ok(!Object.keys(r.headers).some((h) => h.startsWith("access-control-")), "no CORS headers");
  assert.doesNotMatch(JSON.stringify(r.body), /fake-token|fake-client-secret|test-only-diag-key|12345|Synthetic street|Synthetic description|example\.invalid|synthetic note|Base rate|Cleaning fee/);
});

test("no retries: 401/403/429/5xx are recorded once each; the cached token is never re-minted", async () => {
  setEnv({ ...GATE, HOSTAWAY_DIAG_KEY: DIAG });
  for (const s of [401, 403, 429, 500, 503]) {
    const t = HAPPY(); t["GET /v1/listings/606998"] = { status: s, json: { status: "fail", result: "synthetic message" } };
    fresh(t);
    const r = await run();
    assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ["GET /v1/customFields", "GET /v1/listings/606998", "GET /v1/listings/606998/calendar",
      "POST /v1/listings/606998/calendar/priceDetails"], `${s}: four business calls, no mint, no retry`);
    assert.deepEqual([r.body.results.listing.code, r.body.readiness.verdict], [`HTTP_${s}`, "UNRESOLVED"]);
    assert.doesNotMatch(JSON.stringify(r.body), /synthetic message/);
  }
});

test("a network/timeout error on a business call stops the run immediately (no later calls)", async () => {
  setEnv({ ...GATE, HOSTAWAY_DIAG_KEY: DIAG });
  const t = HAPPY(); t["GET /v1/listings/606998/calendar"] = new Error("socket hang up");
  fresh(t);
  const r = await run();
  assert.deepEqual(calls.map((c) => c.path), ["/v1/customFields", "/v1/listings/606998", "/v1/listings/606998/calendar"]);
  assert.deepEqual([r.body.results.calendar.code, r.body.stoppedEarly, r.body.readiness.reads.priceDetails], ["TRANSPORT_UNCERTAIN", true, "NOT_RUN"]);
});

test("unconfigured provider credentials: 503 with a generic code, no env names, zero calls", async () => {
  setEnv({ ...GATE, HOSTAWAY_DIAG_KEY: DIAG }); fresh();
  const saved = process.env.HOSTAWAY_CLIENT_SECRET; delete process.env.HOSTAWAY_CLIENT_SECRET;
  const r = await run();
  process.env.HOSTAWAY_CLIENT_SECRET = saved;
  assert.deepEqual([r.statusCode, r.body], [503, { ok: false, error: "UPSTREAM_NOT_CONFIGURED" }]);
  assert.equal(calls.length, 0);
});

// ---------- parity with the reviewed CLI ----------
test("parity: lib/e4-readonly-checks.js behaves exactly like the reviewed CLI summarizers on the same inputs", async () => {
  const lib = await import("../lib/e4-readonly-checks.js");
  const cli = await import("../scripts/hostaway-readonly-check.mjs");
  const plan = { from: "2027-03-10", to: "2027-03-12" };
  const variants = (base, edits) => [structuredClone(base), ...edits.map((e) => { const j = structuredClone(base); e(j); return j; })];
  const fields = variants(FIELDS, [(j) => { j.result[0].isPublic = 1; }, (j) => { j.result[0].varName = "sk4f9Qz7Lm2Xp8Rt"; }, (j) => { j.result = []; }, (j) => { j.status = "fail"; }]);
  const listings = variants(LISTING, [(j) => { j.result.currencyCode = "MXN"; }, (j) => { delete j.result.specialStatus; }, (j) => { j.result.isBookingEngineActive = 1; }, (j) => { j.result.name = "Other"; }, (j) => { j.result.id = 603564; }]);
  const cals = variants(CALENDAR, [(j) => { j.result[1].isAvailable = 0; j.result[1].status = "blocked"; }, (j) => { j.result.splice(1, 1); }, (j) => { j.result = {}; }]);
  const prices = variants(PRICE, [(j) => { j.result.components[0].name = "secretShapedName123"; }, (j) => { j.result.totalPrice = 260; }, (j) => { j.result.components[1].total = 40; j.result.totalPrice = 240; }]);
  for (const j of fields) assert.deepEqual(lib.summarizeCustomFields(j), cli.summarizeCustomFields(j));
  for (const j of listings) assert.deepEqual(lib.summarizeListing(j), cli.summarizeListing(j));
  for (const j of cals) assert.deepEqual(lib.summarizeCalendar(j, plan), cli.summarizeCalendar(j, plan));
  for (const j of prices) assert.deepEqual(lib.summarizePriceDetails(j), cli.summarizePriceDetails(j));
  for (const k of ["TEST_LISTING_ID", "FORBIDDEN_PILOT_LISTING_IDS", "EXPECTED_FIELD", "EXPECTED_LISTING", "SCOPE_STATEMENT", "MAX_NIGHTS", "MAX_GUESTS", "KNOWN_COMPONENT_NAMES"]) {
    assert.deepEqual(lib[k], cli[k], k);
  }
  const results = { customFields: lib.summarizeCustomFields(fields[1]), listing: lib.summarizeListing(listings[1]), calendar: lib.summarizeCalendar(cals[0], plan), priceDetails: lib.summarizePriceDetails(prices[0]) };
  assert.deepEqual(lib.evaluate({ results: structuredClone(results) }), cli.evaluate({ results: structuredClone(results) }));
});

// ---------- containment ----------
test("containment: fixed route, pure checks module, no scripts/ import, no write paths, no CORS, no logs", () => {
  const strip = (s) => s.replace(/^\s*\/\/.*$/gm, "");
  const route = strip(readFileSync(join(ROOT, "api/hostaway/e4-check.js"), "utf8"));
  const lib = strip(readFileSync(join(ROOT, "lib/e4-readonly-checks.js"), "utf8"));
  for (const src of [route, lib]) {
    assert.doesNotMatch(src, /scripts\//, "never imports the non-deployed CLI");
    assert.doesNotMatch(src, /console\.|Access-Control|\/reservations|statuses|guestPayments|forceOverbooking|includeResources|PUT|DELETE|PATCH/);
  }
  assert.doesNotMatch(lib, /process\.|fetch\(|hostaway\.js/);
  const paths = [...route.matchAll(/path: [`"]([^`"]+)[`"]/g)].map((m) => m[1]);
  assert.deepEqual(paths, ["/customFields", "/listings/${id}", "/listings/${id}/calendar", "/listings/${id}/calendar/priceDetails"]);
  assert.match(route, /retryOnAuth: false[\s\S]*retryOnAuth: false/);
  assert.match(readFileSync(join(ROOT, ".vercelignore"), "utf8"), /^\/scripts$/m);
});
