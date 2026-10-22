// Offline tests for scripts/hostaway-readonly-check.mjs — Stage E4 owner-private read-only CLI. Run: npm test
// No network, no credentials: every "Hostaway" response is a SYNTHETIC fixture (test/fixtures/hostaway/README.md)
// served by a stub fetch that records each call. The credential values below are obvious fakes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  parseArgs, buildPlan, assertAllowedRequest, manifest, summarizeCustomFields, summarizeListing, summarizeCalendar,
  summarizePriceDetails, takeCredentials, runReadonlyChecks, main, CheckError, CREDENTIAL_ENV, TEST_LISTING_ID, KNOWN_COMPONENT_NAMES
} from "../scripts/hostaway-readonly-check.mjs";
import { validatePriceDetails } from "../lib/quote-public.js";

const ROOT = new URL("..", import.meta.url).pathname;
const fixture = (n) => JSON.parse(readFileSync(join(ROOT, "test/fixtures/hostaway", n), "utf8"));
const FIELDS = fixture("synthetic-ro-custom-fields.json");
const LISTING = fixture("synthetic-ro-listing.json");
const CALENDAR = fixture("synthetic-ro-calendar.json");
const PRICE = fixture("synthetic-ro-price-details.json");
const ARGS = ["--listing", "606998", "--from", "2027-03-10", "--to", "2027-03-12", "--guests", "2"];
const FAKE_SECRET = "FAKE-SECRET-0123456789abcdef-not-real";
const FAKE_TOKEN = "FAKE.TOKEN.value-not-real";
const CREDS = Object.freeze({ accountId: "12345", clientSecret: FAKE_SECRET });
const code = (fn) => { try { fn(); } catch (e) { assert.ok(e instanceof CheckError, String(e)); return e.code; } assert.fail("expected CheckError"); };
const plan = () => buildPlan(parseArgs(ARGS));
const clone = (o) => structuredClone(o);

/** Stub fetch: answers by "METHOD path" from a table; records every call; never touches the network. */
function stubFetch(table) {
  const calls = [];
  const fn = async (url, init) => {
    const u = new URL(url);
    calls.push({ origin: u.origin, method: init.method, path: u.pathname, query: Object.fromEntries(u.searchParams), headers: { ...init.headers }, body: init.body, redirect: init.redirect, hasSignal: !!init.signal });
    const key = `${init.method} ${u.pathname}`;
    const v = table[key];
    if (v instanceof Error) throw v;
    if (!v) return { status: 404, text: async () => JSON.stringify({ status: "fail", result: "synthetic not found" }) };
    return { status: v.status ?? 200, text: async () => (typeof v.raw === "string" ? v.raw : JSON.stringify(v.json)) };
  };
  return { fn, calls };
}
const HAPPY = () => ({
  "POST /v1/accessTokens": { json: { token_type: "Bearer", expires_in: 3600, access_token: FAKE_TOKEN } },
  "GET /v1/customFields": { json: clone(FIELDS) },
  [`GET /v1/listings/${TEST_LISTING_ID}`]: { json: clone(LISTING) },
  [`GET /v1/listings/${TEST_LISTING_ID}/calendar`]: { json: clone(CALENDAR) },
  [`POST /v1/listings/${TEST_LISTING_ID}/calendar/priceDetails`]: { json: clone(PRICE) }
});
const run = (table, p = plan()) => {
  const s = stubFetch(table); const sleeps = [];
  return runReadonlyChecks(p, CREDS, { fetchImpl: s.fn, sleep: async (ms) => { sleeps.push(ms); }, now: () => new Date("2026-10-22T18:00:00Z") })
    .then((report) => ({ report, calls: s.calls, sleeps }));
};
const FORBIDDEN_TEXT = /FAKE-SECRET|FAKE\.TOKEN|Synthetic street|Synthetic description|example\.invalid|synthetic note|synthetic not found|Base rate|Cleaning fee/;

// ---------- arguments and plan ----------
test("plan: only listing 606998; pilots and any other id refused; dates, window and guests validated; tool never picks dates", () => {
  assert.equal(plan().listingId, 606998);
  for (const id of ["603564", "603566"]) assert.equal(code(() => buildPlan(parseArgs(["--listing", id, ...ARGS.slice(2)]))), "PILOT_LISTING_FORBIDDEN");
  for (const id of ["606999", "0", "abc", "606998.0", ""]) assert.equal(code(() => buildPlan(parseArgs(["--listing", id, ...ARGS.slice(2)]))), "LISTING_NOT_ALLOWED", id);
  const with_ = (k, v) => { const a = [...ARGS]; a[a.indexOf(k) + 1] = v; return () => buildPlan(parseArgs(a)); };
  assert.equal(code(with_("--from", "2027-02-30")), "INVALID_DATE");
  assert.equal(code(with_("--to", "2027-03-10")), "DEPARTURE_NOT_AFTER_ARRIVAL");
  assert.equal(code(with_("--to", "2027-04-12")), "WINDOW_TOO_LONG");
  for (const g of ["0", "17", "1.5", "-1", "x"]) assert.equal(code(with_("--guests", g)), "INVALID_GUESTS", g);
  assert.equal(code(() => buildPlan(parseArgs(["--listing", "606998"]))), "INVALID_DATE", "no default dates");
  assert.equal(code(() => parseArgs([...ARGS, "--write"])), "ARG_UNKNOWN");
  assert.equal(code(() => parseArgs([...ARGS, "--secret", "x"])), "ARG_UNKNOWN", "no secrets on the command line");
  assert.equal(code(() => parseArgs(["--from"])), "ARG_MISSING_VALUE");
  assert.equal(parseArgs(ARGS).execute, false, "default is dry run");
  assert.equal(parseArgs([...ARGS, "--execute-readonly"]).execute, true);
});

test("allowlist: only the four documented read/calculation requests for 606998 can be sent", () => {
  for (const r of plan().requests) assert.equal(assertAllowedRequest(r), true);
  const id = TEST_LISTING_ID;
  const refused = [
    { method: "POST", path: "/v1/reservations", query: {}, body: { listingMapId: id } },
    { method: "POST", path: "/v1/reservations", query: { forceOverbooking: 1 } },
    { method: "PUT", path: `/v1/listings/${id}/calendar`, query: {}, body: { isAvailable: 0 } },
    { method: "PUT", path: `/v1/listings/${id}`, query: {}, body: {} },
    { method: "DELETE", path: `/v1/reservations/1`, query: {} },
    { method: "POST", path: "/v1/customFields", query: {}, body: {} },
    { method: "PUT", path: "/v1/reservations/1/statuses/cancelled", query: {} },
    { method: "POST", path: "/v1/guestPayments/charges/1", query: {} },
    { method: "GET", path: "/v1/reservations", query: {} },
    { method: "GET", path: "/v1/listings/603564", query: {} },
    { method: "GET", path: "/v1/listings/603566/calendar", query: { startDate: "2027-03-10", endDate: "2027-03-12" } },
    { method: "GET", path: `/v1/listings/${id}/calendar`, query: { startDate: "2027-03-10", endDate: "2027-03-12", includeResources: 1 } },
    { method: "GET", path: "/v1/customFields", query: { objectType: "listing", limit: 100, offset: 0 } },
    { method: "GET", path: `/v1/listings/${id}`, query: { includeResources: 1 } },
    { method: "POST", path: `/v1/listings/${id}/calendar/priceDetails`, query: {}, body: { startingDate: "2027-03-10", endingDate: "2027-03-12", numberOfGuests: 2, version: 2, reservationCouponId: 1 } },
    { method: "POST", path: `/v1/listings/${id}/calendar/priceDetails`, query: { forceOverbooking: 1 }, body: { startingDate: "2027-03-10", endingDate: "2027-03-12", numberOfGuests: 2, version: 2 } },
    { method: "POST", path: `/v1/listings/${id}/calendar/priceDetails`, query: {}, body: { startingDate: "2027-03-10", endingDate: "2027-03-12", numberOfGuests: 2, version: 1 } },
    { method: "GET", path: `/v1/listings/${id}/calendar/priceDetails`, query: {} }
  ];
  for (const r of refused) assert.throws(() => assertAllowedRequest(r), (e) => ["REQUEST_REFUSED", "PILOT_LISTING_FORBIDDEN"].includes(e.code), `${r.method} ${r.path}`);
});

test("dry run: prints the manifest, makes no network call, needs and keeps no credentials", async () => {
  const env = { [CREDENTIAL_ENV.accountId]: "12345", [CREDENTIAL_ENV.clientSecret]: FAKE_SECRET };
  let fetched = 0; let printed = "";
  const rc = await main(ARGS, { env, fetchImpl: async () => { fetched += 1; throw new Error("network"); }, out: (s) => { printed += s; } });
  assert.equal(rc, 0);
  assert.equal(fetched, 0);
  const m = JSON.parse(printed);
  assert.deepEqual([m.mode, m.network, m.listingId, m.calls.length], ["dry-run", false, 606998, 5]);
  assert.deepEqual(m.calls.map((c) => `${c.method} ${c.path}`), ["POST /v1/accessTokens", "GET /v1/customFields", "GET /v1/listings/606998",
    "GET /v1/listings/606998/calendar", "POST /v1/listings/606998/calendar/priceDetails"]);
  assert.deepEqual(manifest(plan()).calls[4].body, { startingDate: "2027-03-10", endingDate: "2027-03-12", numberOfGuests: 2, version: 2 });
  assert.doesNotMatch(printed, /FAKE-SECRET|12345/);
  assert.deepEqual(Object.keys(env), [], "credential variables removed even in a dry run");
});

// ---------- credentials ----------
test("credentials: read once from the two env variables, removed from env, validated; failures print only a code", async () => {
  const env = { [CREDENTIAL_ENV.accountId]: "12345", [CREDENTIAL_ENV.clientSecret]: FAKE_SECRET, OTHER: "x" };
  assert.deepEqual(takeCredentials(env), CREDS);
  assert.deepEqual(Object.keys(env), ["OTHER"]);
  assert.equal(code(() => takeCredentials({})), "CREDENTIAL_ACCOUNT_ID_MISSING");
  assert.equal(code(() => takeCredentials({ [CREDENTIAL_ENV.accountId]: "12345", [CREDENTIAL_ENV.clientSecret]: "short" })), "CREDENTIAL_SECRET_MISSING");
  assert.equal(code(() => takeCredentials({ [CREDENTIAL_ENV.accountId]: "12345", [CREDENTIAL_ENV.clientSecret]: `${FAKE_SECRET} x` })), "CREDENTIAL_SECRET_MISSING");
  const env2 = { [CREDENTIAL_ENV.clientSecret]: FAKE_SECRET };
  let printed = ""; let fetched = 0;
  const rc = await main([...ARGS, "--execute-readonly"], { env: env2, fetchImpl: async () => { fetched += 1; }, out: (s) => { printed += s; } });
  assert.equal(rc, 1);
  assert.equal(fetched, 0);
  assert.deepEqual(JSON.parse(printed), { tool: "hostaway-readonly-check", version: "e4-ro-v1", ok: false, code: "CREDENTIAL_ACCOUNT_ID_MISSING" });
  assert.deepEqual(Object.keys(env2), [], "secret removed from env even when the account id is missing");
});

// ---------- execution with a stub transport ----------
test("execute: exactly five sequential calls, in order, to api.hostaway.com only, each once, documented shapes", async () => {
  const { report, calls, sleeps } = await run(HAPPY());
  assert.equal(report.outcome, "READ_ONLY_CHECKS_PASSED");
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ["POST /v1/accessTokens", "GET /v1/customFields", "GET /v1/listings/606998",
    "GET /v1/listings/606998/calendar", "POST /v1/listings/606998/calendar/priceDetails"]);
  assert.ok(calls.every((c) => c.origin === "https://api.hostaway.com" && c.redirect === "error" && c.hasSignal));
  assert.deepEqual(Object.fromEntries(new URLSearchParams(calls[0].body)), { grant_type: "client_credentials", client_id: "12345", client_secret: FAKE_SECRET, scope: "general" });
  assert.equal(calls[0].headers.Authorization, undefined);
  assert.ok(calls.slice(1).every((c) => c.headers.Authorization === `Bearer ${FAKE_TOKEN}`));
  assert.deepEqual(calls[1].query, { objectType: "reservation", limit: "100", offset: "0" });
  assert.deepEqual(calls[3].query, { startDate: "2027-03-10", endDate: "2027-03-12" });
  assert.deepEqual(JSON.parse(calls[4].body), { startingDate: "2027-03-10", endingDate: "2027-03-12", numberOfGuests: 2, version: 2 });
  assert.ok(!calls.slice(1).some((c) => c.body && c.body.includes(FAKE_SECRET)), "secret only in the token request");
  assert.deepEqual(sleeps, [1100], "documented token activation delay, once");
});

test("execute: the report verifies field 105433, listing 606998, calendar and the cleaning-fee price calculation", async () => {
  const { report } = await run(HAPPY());
  const r = report.results;
  assert.deepEqual([r.customFields.ok, r.customFields.matchesForId, r.customFields.objectType, r.customFields.type, r.customFields.isPublic],
    [true, 1, "reservation", "text", false]);
  assert.equal(r.customFields.varName, undefined, "provider varName text is compared, never copied");
  assert.deepEqual(r.customFields.checks, { fieldFoundOnce: "pass", nameExact: "pass", objectTypeReservation: "pass", typeText: "pass", private: "pass", uniqueName: "pass" });
  assert.deepEqual(r.customFields.comparisons, { varNameMatchesExpected: "pass" });
  assert.deepEqual(r.listing.checks, { nameExpected: "pass", currencyUSD: "pass", notArchived: "pass", bookingEngineInactive: "pass" });
  assert.deepEqual(r.listing.comparisons, { nightlyPriceMatchesTestValue: "pass", cleaningFeeMatchesOwnerBaseline: "pass" });
  assert.equal(report.readiness.verdict, "PASSED");
  assert.deepEqual(report.readiness.reads, { customFields: "ok", listing: "ok", calendar: "ok", priceDetails: "ok" });
  assert.equal(Object.keys(report.readiness.checks).length, 11);
  assert.deepEqual(report.comparisons, { "customFields.varNameMatchesExpected": "pass", "listing.nightlyPriceMatchesTestValue": "pass",
    "listing.cleaningFeeMatchesOwnerBaseline": "pass", "priceDetails.cleaningFeeMatchesOwnerBaseline": "pass" });
  assert.match(report.scope, /never authorizes a booking/);
  assert.match(report.scope, /does not establish full isolation/);
  assert.deepEqual([r.listing.listingId, r.listing.nameStatus, r.listing.archived, r.listing.priceMinor, r.listing.cleaningFeeMinor, r.listing.currencyCode, r.listing.isBookingEngineActive],
    [606998, "TRAILING_PERIOD", false, 10000, 5000, "USD", false]);
  assert.deepEqual([r.calendar.ok, r.calendar.daysRequested, r.calendar.complete, r.calendar.unavailableNights, r.calendar.nightlyPriceMinor],
    [true, 3, true, 0, { min: 10000, max: 10000, nightsWithPrice: 2, nightsWithoutPrice: 0 }]);
  assert.deepEqual([r.priceDetails.ok, r.priceDetails.totalMinor, r.priceDetails.cleaningFeeMinor], [true, 25000, 5000]);
  assert.deepEqual(r.priceDetails.components, [
    { index: 0, type: "price", name: "baseRate", totalMinor: 20000, included: true, mandatory: null },
    { index: 1, type: "fee", name: "cleaningFee", totalMinor: 5000, included: true, mandatory: null }
  ]);
});

test("execute: the report never contains secrets, tokens, addresses, descriptions, notes, titles or raw provider messages", async () => {
  for (const table of [HAPPY(), { ...HAPPY(), "GET /v1/listings/606998": { status: 500, json: { status: "fail", result: "synthetic not found" } } }]) {
    const { report } = await run(table);
    assert.doesNotMatch(JSON.stringify(report), FORBIDDEN_TEXT);
  }
  const hostileTitles = clone(PRICE);
  hostileTitles.result.components[1].title = "Call a@example.invalid";
  hostileTitles.result.components[1].name = "cleaning fee by a@example.invalid";
  const { report } = await run({ ...HAPPY(), "POST /v1/listings/606998/calendar/priceDetails": { json: hostileTitles } });
  assert.doesNotMatch(JSON.stringify(report), /example\.invalid|Call a/);
  assert.equal(report.results.priceDetails.components[1].name, null);
});

test("execute: failures are reported per step, never retried; auth failure stops before any data request", async () => {
  const fail = await run({ "POST /v1/accessTokens": { status: 401, json: { status: "fail" } } });
  assert.deepEqual([fail.report.outcome, fail.calls.length], ["AUTH_FAILED", 1]);
  const noTok = await run({ "POST /v1/accessTokens": { json: { token_type: "Bearer" } } });
  assert.deepEqual([noTok.report.outcome, noTok.calls.length], ["AUTH_FAILED", 1]);
  const transport = await run({ "POST /v1/accessTokens": new Error("ECONNRESET") });
  assert.deepEqual([transport.report.outcome, transport.calls.length], ["AUTH_FAILED", 1]);

  for (const status of [401, 403, 429, 500, 503, 404]) {
    const t = HAPPY(); t["GET /v1/listings/606998"] = { status, json: { status: "fail", result: "x" } };
    const { report, calls } = await run(t);
    assert.equal(calls.length, 5, `${status}: each step called once, no retry`);
    assert.deepEqual([report.outcome, report.results.listing.code, report.readiness.reads.listing], ["READ_ONLY_CHECKS_UNRESOLVED", `HTTP_${status}`, `HTTP_${status}`]);
    assert.equal(report.readiness.checks["listing.currencyUSD"], "unknown", "a failed read leaves its checks unresolved, never passed");
    assert.equal(report.results.priceDetails.ok, true, "independent read steps still reported");
  }
  const t = HAPPY(); t["GET /v1/listings/606998/calendar"] = new Error("timeout");
  const { report, calls } = await run(t);
  assert.deepEqual([report.results.calendar.code, calls.length], ["TRANSPORT_UNCERTAIN", 5]);
  const tokOn500 = await run({ ...HAPPY(), "POST /v1/accessTokens": { status: 500, json: { access_token: FAKE_TOKEN } } });
  assert.deepEqual([tokOn500.report.outcome, tokOn500.calls.length], ["AUTH_FAILED", 1], "a token in a non-200 response is not used");
  const bad = HAPPY(); bad["GET /v1/customFields"] = { raw: "<html>not json</html>" };
  assert.equal((await run(bad)).report.results.customFields.code, "UNEXPECTED_SHAPE");
});

test("execute: a forged or altered plan is refused before the token request — zero network calls", async () => {
  const p = plan();
  const forged = [
    { ...p, requests: [...p.requests.slice(0, 3), { step: "priceDetails", method: "POST", path: "/v1/reservations", query: {}, body: {} }] },
    { ...p, requests: [...p.requests.slice(0, 1), { step: "listing", method: "GET", path: "/v1/listings/603564", query: {} }, ...p.requests.slice(2)] },
    { ...p, requests: [...p.requests, { step: "extra", method: "GET", path: "/v1/listings/606998", query: {} }] },
    { ...p, requests: p.requests.slice(1) },
    { ...p, requests: [p.requests[1], p.requests[0], p.requests[2], p.requests[3]] },
    { ...p, requests: [p.requests[0], p.requests[1], { ...p.requests[2], query: { ...p.requests[2].query, includeResources: 1 } }, p.requests[3]] },
    null
  ];
  for (const f of forged) {
    const s = stubFetch(HAPPY());
    await assert.rejects(runReadonlyChecks(f, CREDS, { fetchImpl: s.fn, sleep: async () => {} }), (e) => ["PLAN_REFUSED", "REQUEST_REFUSED", "PILOT_LISTING_FORBIDDEN"].includes(e.code));
    assert.equal(s.calls.length, 0, "no call, not even the token request");
  }
});

// ---------- sanitizers ----------
test("custom field: exact id, name, objectType reservation, type text, private, unique name — tri-state, unknown never passes", () => {
  const f = (over, extra = []) => { const j = clone(FIELDS); Object.assign(j.result[0], over); j.result.push(...extra); return summarizeCustomFields(j); };
  assert.equal(f({}).ok, true);
  assert.equal(f({ isPublic: 1 }).checks.private, "fail");
  assert.equal(f({ isPublic: true }).checks.private, "fail");
  assert.equal(f({ isPublic: false }).checks.private, "pass");
  assert.equal(f({ isPublic: "0" }).checks.private, "unknown");
  assert.equal(f({ isPublic: undefined }).checks.private, "unknown");
  assert.equal(f({ objectType: "listing" }).checks.objectTypeReservation, "fail");
  assert.equal(f({ type: "textarea" }).checks.typeText, "fail");
  assert.equal(f({ name: "maraVilla booking ref " }).checks.nameExact, "fail");
  assert.equal(f({}, [{ id: 7, name: "maraVilla booking ref", type: "text", objectType: "reservation", isPublic: 0 }]).checks.uniqueName, "fail");
  assert.equal(f({ id: 105434 }).checks.fieldFoundOnce, "fail");
  assert.equal(f({ id: 105434 }).checks.private, "unknown");
  assert.equal(f({}, [{ id: 105433, name: "dup" }]).checks.fieldFoundOnce, "fail");
  assert.equal(f({ id: "105433" }).checks.fieldFoundOnce, "fail", "string id is not the configured numeric id");
  assert.equal(f({ varName: "reservation_other" }).comparisons.varNameMatchesExpected, "fail");
  assert.equal(f({ varName: undefined }).comparisons.varNameMatchesExpected, "unknown");
  const many = clone(FIELDS); many.result = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, name: `f${i}` }));
  assert.equal(summarizeCustomFields(many).code, "LIST_POSSIBLY_TRUNCATED");
  for (const j of [null, {}, { status: "fail", result: [] }, { status: "success", result: {} }]) assert.equal(summarizeCustomFields(j).code, "UNEXPECTED_SHAPE");
});

test("adversarial: secret-shaped alphanumeric varName and component names are never echoed", async () => {
  const SECRET = "sk4f9Qz7Lm2Xp8Rt6Wv1Yb3Nc5Hd0Jk";            // alphanumeric, would have matched the old SAFE_* patterns
  const fields = clone(FIELDS); fields.result[0].varName = SECRET.toLowerCase(); fields.result[1].varName = `reservation_${SECRET.toLowerCase()}`;
  const price = clone(PRICE); price.result.components[0].name = SECRET; price.result.components.push({ type: "fee", name: `${SECRET}Fee`, title: SECRET, total: 0, isIncludedInTotalPrice: 1 });
  const listing = clone(LISTING); listing.result.name = SECRET;
  const { report } = await run({ ...HAPPY(), "GET /v1/customFields": { json: fields }, "GET /v1/listings/606998": { json: listing },
    "POST /v1/listings/606998/calendar/priceDetails": { json: price } });
  const text = JSON.stringify(report);
  assert.ok(!text.toLowerCase().includes(SECRET.toLowerCase()), "no secret-shaped provider text in the report");
  assert.equal(report.results.customFields.comparisons.varNameMatchesExpected, "fail");
  assert.deepEqual(report.results.priceDetails.components.map((c) => c.name), [null, "cleaningFee", null]);
  assert.equal(report.results.priceDetails.unknownComponentNames, 2);
  assert.deepEqual([report.results.listing.nameStatus, report.results.listing.checks.nameExpected, report.readiness.verdict], ["OTHER", "fail", "FAILED"]);
});

test("listing: constraints are tri-state — unknown or wrong currency, archive state, booking engine or name never pass", () => {
  const l = (over) => { const j = clone(LISTING); Object.assign(j.result, over); return summarizeListing(j); };
  assert.equal(l({ id: 603564 }).code, "LISTING_ID_MISMATCH");
  assert.equal(l({ specialStatus: "archived" }).checks.notArchived, "fail");
  assert.equal(l({ specialStatus: undefined }).checks.notArchived, "unknown", "absent specialStatus is unknown, not 'not archived'");
  assert.equal(l({ specialStatus: "active" }).checks.notArchived, "unknown");
  assert.equal(l({ name: "maraVilla TEST - DO NOT BOOK" }).checks.nameExpected, "pass");
  assert.equal(l({ name: "maraVilla TEST - DO NOT BOOK." }).checks.nameExpected, "pass", "trailing period accepted");
  assert.equal(l({ name: "Hacienda" }).checks.nameExpected, "fail");
  assert.equal(l({ name: undefined }).checks.nameExpected, "unknown");
  assert.equal(l({ currencyCode: "MXN" }).checks.currencyUSD, "fail", "MXN is reported as a mismatch, never converted or accepted");
  assert.equal(l({ currencyCode: "usd" }).checks.currencyUSD, "unknown");
  assert.equal(l({ currencyCode: undefined }).checks.currencyUSD, "unknown");
  assert.equal(l({ isBookingEngineActive: 1 }).checks.bookingEngineInactive, "fail");
  assert.equal(l({ isBookingEngineActive: undefined }).checks.bookingEngineInactive, "unknown");
  assert.equal(l({ cleaningFee: 40 }).comparisons.cleaningFeeMatchesOwnerBaseline, "fail");
  assert.equal(l({ cleaningFee: 50.005 }).comparisons.cleaningFeeMatchesOwnerBaseline, "unknown");
  assert.equal(l({ price: "100" }).comparisons.nightlyPriceMatchesTestValue, "unknown");
  assert.equal(l({ checkOutTime: 24 }).checkOutTime, null);
  assert.equal(summarizeListing(LISTING).name, undefined, "listing name text is never copied");
});

test("readiness verdict: reads OK but unresolved or failed constraints are never PASSED; comparisons never change the verdict", async () => {
  const withListing = (over) => { const j = clone(LISTING); Object.assign(j.result, over); return { ...HAPPY(), "GET /v1/listings/606998": { json: j } }; };
  const cases = [
    [{ currencyCode: "MXN" }, "FAILED"], [{ isBookingEngineActive: 1 }, "FAILED"], [{ specialStatus: "archived" }, "FAILED"],
    [{ currencyCode: undefined }, "UNRESOLVED"], [{ isBookingEngineActive: undefined }, "UNRESOLVED"], [{ specialStatus: undefined }, "UNRESOLVED"],
    [{ cleaningFee: 40, price: 90 }, "PASSED"]
  ];
  for (const [over, verdict] of cases) {
    const { report } = await run(withListing(over));
    assert.equal(report.readiness.verdict, verdict, JSON.stringify(over));
    assert.deepEqual(report.readiness.reads, { customFields: "ok", listing: "ok", calendar: "ok", priceDetails: "ok" }, "reads succeeded in every case");
    assert.equal(report.outcome, `READ_ONLY_CHECKS_${verdict}`);
  }
  const pdFail = await run({ ...HAPPY(), "POST /v1/listings/606998/calendar/priceDetails": { status: 500, json: { status: "fail" } } });
  assert.deepEqual([pdFail.report.readiness.reads.priceDetails, pdFail.report.readiness.verdict], ["HTTP_500", "UNRESOLVED"],
    "a failed calculation (no readiness checks of its own) still prevents PASSED");
  const { report } = await run(withListing({ cleaningFee: 40 }));
  assert.equal(report.comparisons["listing.cleaningFeeMatchesOwnerBaseline"], "fail", "fee difference reported, no forced change");
  let printed = "";
  const env = { [CREDENTIAL_ENV.accountId]: "12345", [CREDENTIAL_ENV.clientSecret]: FAKE_SECRET };
  const s = stubFetch(withListing({ currencyCode: "MXN" }));
  const rc = await main([...ARGS, "--execute-readonly"], { env, fetchImpl: s.fn, out: (x) => { printed += x; } });
  assert.equal(rc, 2, "non-zero exit unless PASSED");
  assert.equal(JSON.parse(printed).readiness.verdict, "FAILED");
});

test("calendar: notes/reservations dropped; gaps and unavailable nights reported; malformed shapes fail closed", () => {
  const p = plan();
  const c = clone(CALENDAR); c.result[1].isAvailable = 0; c.result[1].status = "blocked";
  const s = summarizeCalendar(c, p);
  assert.equal(s.unavailableNights, 1);
  assert.deepEqual(s.unavailable, [{ arrival: "2027-03-11", departure: "2027-03-12", nights: 1 }]);
  const gap = clone(CALENDAR); gap.result.splice(1, 1);
  assert.equal(summarizeCalendar(gap, p).complete, false);
  const dup = clone(CALENDAR); dup.result.push(clone(CALENDAR.result[0]));
  assert.equal(summarizeCalendar(dup, p).code, "CALENDAR_INCONSISTENT");
  assert.equal(summarizeCalendar({ status: "success", result: {} }, p).code, "UNEXPECTED_SHAPE");
  assert.doesNotMatch(JSON.stringify(summarizeCalendar(CALENDAR, p)), /synthetic note|reservations/);
});

test("price details: exact minor units; sum must match; discounts negative; malformed or inexact totals fail closed", () => {
  const pd = (fn) => { const j = clone(PRICE); fn(j.result); return summarizePriceDetails(j); };
  assert.equal(pd(() => {}).totalMinor, 25000);
  assert.equal(pd((r) => { r.totalPrice = 260; }).ok, false);
  assert.equal(pd((r) => { r.totalPrice = 250.004; r.components[0].total = 200.004; }).code, "PRICE_TOTAL_NOT_EXACT");
  const disc = pd((r) => { r.components.push({ type: "discount", name: "weeklyDiscount", total: -20, isIncludedInTotalPrice: 1 }); r.totalPrice = 230; });
  assert.deepEqual([disc.ok, disc.totalMinor, disc.components[2].totalMinor], [true, 23000, -2000]);
  assert.equal(pd((r) => { r.components[1].isIncludedInTotalPrice = 0; r.totalPrice = 200; }).cleaningFeeMinor, 5000);
  assert.equal(pd((r) => { r.components = []; }).code, "PRICE_NO_COMPONENTS");
  assert.equal(summarizePriceDetails({ status: "fail", result: "x" }).code, "PRICE_UPSTREAM_REJECTED");
  assert.equal(pd((r) => { r.components[1].total = 40; r.totalPrice = 240; }).comparisons.cleaningFeeMatchesOwnerBaseline, "fail");
  assert.equal(pd((r) => { r.components[1].name = "cleaningFeeX"; }).comparisons.cleaningFeeMatchesOwnerBaseline, "unknown");
});

test("component-name allowlist = exactly the names lib/quote-public.js labels explicitly", () => {
  const LABELS = { baseRate: "Accommodation", weeklyDiscount: "Weekly discount", monthlyDiscount: "Monthly discount", cleaningFee: "Cleaning fee", lengthOfStayDiscount: "Length-of-stay discount" };
  assert.deepEqual([...KNOWN_COMPONENT_NAMES].sort(), Object.keys(LABELS).sort());
  for (const name of KNOWN_COMPONENT_NAMES) {
    const type = /Discount$/.test(name) ? "discount" : "fee";
    const total = type === "discount" ? -1 : 1;
    const v = validatePriceDetails({ status: "success", result: { totalPrice: 10 + total, components: [
      { type: "price", name: "zzzBase", title: "zzz", total: 10, isIncludedInTotalPrice: 1 },
      { type, name, title: "zzz", total, isIncludedInTotalPrice: 1 }] } });
    assert.equal(v.ok, true, name);
    assert.equal(v.breakdown[1].label, LABELS[name], `${name} is labelled by the existing validator, not by its title`);
  }
});

// ---------- containment ----------
test("containment: CLI is local-only — allowed imports only, no writes/files/env loaders, excluded from deployment, unreachable from api/lib", () => {
  const src = readFileSync(join(ROOT, "scripts/hostaway-readonly-check.mjs"), "utf8");
  const srcNoComments = src.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const imports = [...src.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]).sort();
  assert.deepEqual(imports, ["../lib/calendar-public.js", "../lib/hostaway-reservations.js", "../lib/quote-public.js", "node:url"]);
  for (const re of [/dotenv/, /node:fs|writeFile|appendFile|createWriteStream/, /child_process|spawn|exec\(/, /["'`][./]*lib\/hostaway\.js["'`]/, /HOSTAWAY_CLIENT_SECRET|HOSTAWAY_ACCOUNT_ID/,
    /"\/v1\/reservations/, /statuses\/cancelled|guestPayments|forceOverbooking":/, /console\.(log|error|warn)\(/, /\beval\(|new Function/]) {
    assert.doesNotMatch(srcNoComments, re, String(re));
  }
  assert.match(readFileSync(join(ROOT, ".vercelignore"), "utf8"), /^\/scripts$/m);
  const refs = [];
  for (const dir of ["api", "lib", "db"]) {
    const walk = (d) => { for (const e of readdirSync(join(ROOT, d), { withFileTypes: true })) { const p = `${d}/${e.name}`; if (e.isDirectory()) walk(p); else if (readFileSync(join(ROOT, p), "utf8").includes("hostaway-readonly-check")) refs.push(p); } };
    walk(dir);
  }
  assert.deepEqual(refs, []);
});
