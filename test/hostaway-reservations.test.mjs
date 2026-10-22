// Offline tests for lib/hostaway-reservations.js — Stage E4 adapter. Run: npm test
// Deterministic: no network, no credentials, no Hostaway, no database. Fixtures are SYNTHETIC
// (test/fixtures/hostaway/README.md); they are not provider evidence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  buildCreateReservationRequest, classifyCreateResponse, normalizeReservation, unwrapEnvelope, lookupByRef, buildLookupQuery,
  sanitizeForEvidence, validateAdapterConfig, amountToMinor, minorToAmount, isRealDate,
  FORBIDDEN_PILOT_LISTING_IDS, DIRECT_CHANNEL_ID, HOSTAWAY_RESERVATION_MAPPING, LOOKUP_PAGE_LIMIT, AdapterError
} from "../lib/hostaway-reservations.js";
import { createIntent, transition } from "../lib/checkout/intent-state.js";

const ROOT = new URL("..", import.meta.url).pathname;
const fixture = (name) => JSON.parse(readFileSync(join(ROOT, "test/fixtures/hostaway", name), "utf8"));

const TEST_LISTING = 990001;                  // invented id, not a real listing
const CFG = Object.freeze({ allowedListingIds: [TEST_LISTING], refFieldId: 105433, channelId: 2000, currency: "USD" });
const PLAN = Object.freeze({
  ref: "MV-E4TEST01", listingId: TEST_LISTING, arrivalDate: "2027-03-10", departureDate: "2027-03-12", guests: 2,
  guest: Object.freeze({ firstName: "Synthetic", lastName: "Tester", email: "e4-synthetic@example.invalid" }),
  totalMinor: 20000, currency: "USD"
});
const plan = (over = {}) => ({ ...PLAN, guest: { ...PLAN.guest }, ...over });
const SUCCESS = fixture("synthetic-create-success.json");
const success = (over = {}) => ({ status: "success", result: { ...SUCCESS.result, ...over } });
const code = (fn) => { try { fn(); } catch (e) { assert.ok(e instanceof AdapterError, `unexpected ${e}`); return e.code; } assert.fail("expected AdapterError"); };

// ---------- configuration ----------
test("config: pilots 603564/603566 are always rejected, alone or mixed with a test listing", () => {
  for (const ids of [[603564], [603566], [TEST_LISTING, 603564], [603566, TEST_LISTING]]) {
    assert.equal(code(() => validateAdapterConfig({ ...CFG, allowedListingIds: ids })), "PILOT_LISTING_FORBIDDEN", String(ids));
  }
  assert.deepEqual(FORBIDDEN_PILOT_LISTING_IDS, [603564, 603566]);
});

test("config: channel must be 2000; field id a positive integer; allowlist non-empty, unique, positive; no unknown keys", () => {
  for (const ch of [2001, 2002, 2020, "2000", null]) assert.equal(code(() => validateAdapterConfig({ ...CFG, channelId: ch })), "CHANNEL_NOT_DIRECT");
  for (const f of [0, -1, 1.5, "105433", null, Number.MAX_SAFE_INTEGER + 1]) assert.equal(code(() => validateAdapterConfig({ ...CFG, refFieldId: f })), "REF_FIELD_ID_INVALID");
  assert.equal(code(() => validateAdapterConfig({ ...CFG, allowedListingIds: [] })), "ALLOWLIST_EMPTY");
  assert.equal(code(() => validateAdapterConfig({ ...CFG, allowedListingIds: [TEST_LISTING, TEST_LISTING] })), "ALLOWLIST_INVALID");
  assert.equal(code(() => validateAdapterConfig({ ...CFG, allowedListingIds: [0] })), "ALLOWLIST_INVALID");
  assert.equal(code(() => validateAdapterConfig({ ...CFG, extra: 1 })), "UNKNOWN_FIELD");
  assert.equal(code(() => validateAdapterConfig({ ...CFG, currency: "EUR" })), "CURRENCY_UNSUPPORTED");
  assert.equal(code(() => validateAdapterConfig({ ...CFG, forceOverbooking: 0 })), "FORCE_OVERBOOKING_REFUSED");
});

// ---------- primitives ----------
test("dates: only real calendar dates in YYYY-MM-DD", () => {
  for (const d of ["2027-03-10", "2028-02-29", "2027-12-31"]) assert.equal(isRealDate(d), true, d);
  for (const d of ["2027-02-29", "2027-02-30", "2027-13-01", "2027-00-10", "2027-04-31", "2027-3-10", "2027-03-10T00:00:00Z", "", null, 20270310, "1999-01-01"]) {
    assert.equal(isRealDate(d), false, String(d));
  }
});

test("amounts: exact minor units both ways; floats beyond 2 decimals, strings, negatives, exponents rejected", () => {
  for (const [n, m] of [[200, 20000], [123.45, 12345], [100.5, 10050], [0.01, 1], [0.1, 10], [5760, 576000], [0, 0]]) assert.equal(amountToMinor(n), m, String(n));
  for (const v of [100.005, 0.1 + 0.2, -1, NaN, Infinity, "100", "100.00", null, undefined, 1e21, 5e-7]) assert.equal(amountToMinor(v), null, String(v));
  for (const m of [1, 10, 99, 100, 12345, 576000, 999999999]) assert.equal(amountToMinor(minorToAmount(m)), m, String(m));
  for (const m of [0, -100, 1.5, "100", Number.MAX_SAFE_INTEGER + 1]) assert.equal(code(() => minorToAmount(m)), "INVALID_AMOUNT_MINOR", String(m));
});

// ---------- create request ----------
test("create request: documented field mapping, channel 2000, ref only in the configured custom field, empty query", () => {
  const req = buildCreateReservationRequest(plan(), CFG);
  assert.equal(req.method, "POST");
  assert.equal(req.path, "/reservations");
  assert.deepEqual(req.query, {});
  assert.deepEqual(req.body, {
    channelId: 2000, listingMapId: TEST_LISTING, arrivalDate: "2027-03-10", departureDate: "2027-03-12", numberOfGuests: 2,
    guestName: "Synthetic Tester", guestFirstName: "Synthetic", guestLastName: "Tester", guestEmail: "e4-synthetic@example.invalid",
    totalPrice: 200, currency: "USD", customFieldValues: [{ customFieldId: 105433, value: "MV-E4TEST01" }]
  });
  assert.equal(JSON.stringify(req).split("MV-E4TEST01").length - 1, 1, "ref appears exactly once");
  assert.ok(Object.isFrozen(req) && Object.isFrozen(req.body) && Object.isFrozen(req.body.customFieldValues[0]));
  assert.equal(JSON.stringify(buildCreateReservationRequest(plan({ totalMinor: 12345 }), CFG).body.totalPrice), "123.45");
});

test("create request: pilots and non-allowlisted listings are refused even with an otherwise valid plan", () => {
  for (const id of FORBIDDEN_PILOT_LISTING_IDS) assert.equal(code(() => buildCreateReservationRequest(plan({ listingId: id }), CFG)), "PILOT_LISTING_FORBIDDEN");
  assert.equal(code(() => buildCreateReservationRequest(plan({ listingId: 990002 }), CFG)), "LISTING_NOT_ALLOWED");
  assert.equal(code(() => buildCreateReservationRequest(plan({ listingId: "990001" }), CFG)), "LISTING_ID_INVALID");
});

test("create request: forceOverbooking is refused at any depth and in any case", () => {
  assert.equal(code(() => buildCreateReservationRequest({ ...plan(), forceOverbooking: 1 }, CFG)), "FORCE_OVERBOOKING_REFUSED");
  assert.equal(code(() => buildCreateReservationRequest({ ...plan(), forceOverbooking: 0 }, CFG)), "FORCE_OVERBOOKING_REFUSED");
  assert.equal(code(() => buildCreateReservationRequest(plan({ guest: { ...PLAN.guest, ForceOverbooking: true } }), CFG)), "FORCE_OVERBOOKING_REFUSED");
  assert.equal(code(() => buildCreateReservationRequest(plan({ guest: { ...PLAN.guest, x: [{ forceoverbooking: 1 }] } }), CFG)), "FORCE_OVERBOOKING_REFUSED");
});

test("create request: unknown or missing fields rejected at top level and nested; no coupon/payment/query passthrough", () => {
  for (const k of ["couponName", "financeField", "ccNumber", "validatePaymentMethod", "provider", "query", "channelId", "totalPrice"]) {
    assert.equal(code(() => buildCreateReservationRequest({ ...plan(), [k]: 1 }, CFG)), "UNKNOWN_FIELD", k);
  }
  assert.equal(code(() => buildCreateReservationRequest(plan({ guest: { ...PLAN.guest, phone: "+1" } }), CFG)), "UNKNOWN_FIELD");
  const { ref, ...noRef } = plan();
  assert.equal(code(() => buildCreateReservationRequest(noRef, CFG)), "MISSING_FIELD");
  assert.equal(code(() => buildCreateReservationRequest(plan({ guest: { firstName: "A", lastName: "B" } }), CFG)), "MISSING_FIELD");
  assert.equal(code(() => buildCreateReservationRequest(JSON.parse('{"__proto__":{"x":1}}'), CFG)), "UNKNOWN_FIELD");
  assert.equal(code(() => buildCreateReservationRequest([], CFG)), "NOT_AN_OBJECT");
});

test("create request: dates, guests, ref, currency, amount and guest fields are validated", () => {
  const cases = [
    [{ arrivalDate: "2027-02-30" }, "INVALID_DATE"], [{ departureDate: "2027-13-01" }, "INVALID_DATE"],
    [{ departureDate: "2027-03-10" }, "DEPARTURE_NOT_AFTER_ARRIVAL"], [{ departureDate: "2027-03-09" }, "DEPARTURE_NOT_AFTER_ARRIVAL"],
    [{ guests: 0 }, "GUESTS_INVALID"], [{ guests: 1.5 }, "GUESTS_INVALID"], [{ guests: "2" }, "GUESTS_INVALID"],
    [{ ref: "E4T-20270310-1-abc123" }, "REF_INVALID"], [{ ref: "mv-e4test01" }, "REF_INVALID"], [{ ref: "MV-E4" }, "REF_INVALID"],
    [{ currency: "MXN" }, "CURRENCY_MISMATCH"], [{ totalMinor: 0 }, "INVALID_AMOUNT_MINOR"], [{ totalMinor: 100.5 }, "INVALID_AMOUNT_MINOR"],
    [{ guest: { ...PLAN.guest, email: "not-an-email" } }, "GUEST_EMAIL_INVALID"], [{ guest: { ...PLAN.guest, firstName: "" } }, "GUEST_NAME_INVALID"],
    [{ guest: { ...PLAN.guest, lastName: "x\ny" } }, "GUEST_NAME_INVALID"]
  ];
  for (const [over, want] of cases) assert.equal(code(() => buildCreateReservationRequest(plan(over), CFG)), want, JSON.stringify(over));
});

// ---------- envelope and normaliser ----------
test("envelope: success with result only; fail and malformed bodies are not success", () => {
  assert.equal(unwrapEnvelope(SUCCESS).ok, true);
  assert.equal(unwrapEnvelope(fixture("synthetic-fail-envelope.json")).code, "FAIL_ENVELOPE");
  for (const j of [null, "ok", [], {}, { status: "success" }, { status: "ok", result: {} }, { result: {} }]) assert.equal(unwrapEnvelope(j).ok, false, JSON.stringify(j));
});

test("normaliser: returns the E3 reservation shape without guest data", () => {
  const n = normalizeReservation(SUCCESS.result, CFG);
  assert.equal(n.ok, true);
  assert.deepEqual(n.reservation, { reservationId: 70000001, listingId: 990001, from: "2027-03-10", to: "2027-03-12", totalMinor: 20000,
    currency: "USD", channelId: 2000, status: "new", bookingRef: "MV-E4TEST01" });
  assert.ok(!/Synthetic|example\.invalid/.test(JSON.stringify(n)), "no guest data in the output");
});

test("normaliser: malformed or inconsistent reservations fail closed", () => {
  const r = SUCCESS.result;
  const cases = [
    [{ id: 0 }, "RESERVATION_ID_INVALID"], [{ id: "70000001" }, "RESERVATION_ID_INVALID"],
    [{ hostawayReservationId: 70000002 }, "RESERVATION_ID_INCONSISTENT"], [{ listingMapId: "990001" }, "LISTING_ID_INVALID"],
    [{ channelId: "2000" }, "CHANNEL_ID_INVALID"], [{ arrivalDate: "2027-02-30" }, "DATES_INVALID"], [{ departureDate: "2027-03-10" }, "DATES_INVALID"],
    [{ totalPrice: "200" }, "AMOUNT_NOT_EXACT"], [{ totalPrice: 200.001 }, "AMOUNT_NOT_EXACT"], [{ totalPrice: -5 }, "AMOUNT_NOT_EXACT"],
    [{ currency: "US" }, "CURRENCY_INVALID"], [{ status: "" }, "STATUS_INVALID"], [{ customFieldValues: {} }, "CUSTOM_FIELDS_MALFORMED"],
    [{ customFieldValues: [{ customFieldId: 105433, value: "MV-A1B2C3" }, { customFieldId: 105433, value: "MV-A1B2C3" }] }, "REF_FIELD_DUPLICATED"],
    [{ customFieldValues: [{ customFieldId: 105433, value: 7 }] }, "REF_VALUE_INVALID"]
  ];
  for (const [over, want] of cases) assert.equal(normalizeReservation({ ...r, ...over }, CFG).code, want, JSON.stringify(over));
  assert.equal(normalizeReservation(null, CFG).code, "MALFORMED_RESERVATION");
});

test("normaliser: the ref is read ONLY from the configured field id (string ids and other fields do not count)", () => {
  const r = SUCCESS.result;
  assert.equal(normalizeReservation({ ...r, customFieldValues: [{ customFieldId: "105433", value: "MV-E4TEST01" }] }, CFG).reservation.bookingRef, null);
  assert.equal(normalizeReservation({ ...r, customFieldValues: [{ customFieldId: 999, value: "MV-E4TEST01" }] }, CFG).reservation.bookingRef, null);
  assert.equal(normalizeReservation({ ...r, customFieldValues: undefined }, CFG).reservation.bookingRef, null);
  assert.equal(normalizeReservation(r, { ...CFG, refFieldId: 999 }).reservation.bookingRef, "unrelated field");
});

test("contract: a verified 'created' reservation is accepted by the real E3 state machine; a tampered one is escalated", () => {
  const T0 = Date.UTC(2027, 0, 5, 15), MIN = 60000, DAY = 86400000;
  const PRICE = { listingId: TEST_LISTING, from: "2027-03-10", to: "2027-03-12", guests: 2, nights: 2, currency: "USD", standardTotalMinor: 20000,
    eligibleMinor: 20000, discountMinor: 0, finalTotalMinor: 20000, policyVersion: "direct-v1", rateBps: 0, lines: [],
    charge: { currency: "usd", amountMinor: 20000, quantity: 1 }, quoteHash: "a".repeat(64) };
  let i = createIntent({ id: "int_e4", ref: "MV-E4TEST01", listingId: TEST_LISTING, from: "2027-03-10", to: "2027-03-12", guests: 2, now: T0 });
  const steps = [[{ type: "PRICE_CONFIRMED", price: PRICE }, 0], [{ type: "DETAILS_COLLECTED" }, 1], [{ type: "CHECKOUT_PREPARED", sessionId: "cs_test_e4" }, 2],
    [{ type: "PAYMENT_AUTHORIZED", id: "evt_a", paymentIntentId: "pi_test_e4", sessionId: "cs_test_e4", amountMinor: 20000, currency: "usd", livemode: false,
      authorizationCreatedAt: T0 + 4 * MIN, captureBefore: T0 + 4 * MIN + 7 * DAY }, 5],
    [{ type: "RESERVATION_STARTED", workerId: "w", recheck: { bookable: true, priceSame: true } }, 6], [{ type: "RESERVATION_DISPATCHED", workerId: "w" }, 6]];
  for (const [ev, m] of steps) { const r = transition(i, ev, { now: T0 + m * MIN }); assert.equal(r.ok, true, `${ev.type}: ${r.error}`); i = r.intent; }

  const c = classifyCreateResponse({ httpStatus: 200, json: SUCCESS }, plan(), CFG);
  assert.equal(c.outcome, "created");
  const ok = transition(i, { type: "RESERVATION_SUCCEEDED", reservation: c.reservation }, { now: T0 + 7 * MIN });
  assert.equal(ok.ok, true, ok.error);
  assert.equal(ok.intent.status, "reservation_confirmed");
  assert.equal(ok.intent.reservation.reservationId, "70000001");

  const bad = transition(i, { type: "RESERVATION_SUCCEEDED", reservation: { ...c.reservation, totalMinor: 19999 } }, { now: T0 + 7 * MIN });
  assert.equal(bad.intent.status, "reconciliation_required");
});

// ---------- create classification ----------
test("classify: only a fully verified 2xx body is 'created'", () => {
  const c = classifyCreateResponse({ httpStatus: 201, json: SUCCESS }, plan(), CFG);
  assert.equal(c.outcome, "created");
  assert.equal(c.definiteRefusal, false);
  assert.equal(c.reservation.reservationId, 70000001);
});

test("classify: a success envelope alone is never 'created' — mismatches are conflicts, malformed bodies ambiguous", () => {
  const mm = [
    [{ listingMapId: 990002 }, ["listingId"]], [{ arrivalDate: "2027-03-11", departureDate: "2027-03-13" }, ["from", "to"]],
    [{ totalPrice: 199.99 }, ["totalMinor"]], [{ currency: "MXN" }, ["currency"]], [{ channelId: 2002 }, ["channelId"]],
    [{ customFieldValues: [{ customFieldId: 105433, value: "MV-OTHER01" }] }, ["bookingRef"]], [{ customFieldValues: [] }, ["bookingRef"]],
    [{ listingMapId: 603564 }, ["listingId"]]
  ];
  for (const [over, fields] of mm) {
    const c = classifyCreateResponse({ httpStatus: 200, json: success(over) }, plan(), CFG);
    assert.equal(c.outcome, "conflict", JSON.stringify(over));
    assert.deepEqual(c.mismatches, fields);
  }
  for (const st of ["cancelled", "pending", "awaitingPayment", "inquiry"]) {
    const c = classifyCreateResponse({ httpStatus: 200, json: success({ status: st }) }, plan(), CFG);
    assert.equal(c.outcome, "conflict");
    assert.equal(c.code, "UNEXPECTED_RESERVATION_STATUS");
  }
  const amb = [
    [{ status: "success" }, "MALFORMED_ENVELOPE"], [{ status: "success", result: null }, "MALFORMED_RESERVATION"],
    [{ status: "success", result: [] }, "MALFORMED_RESERVATION"], [fixture("synthetic-fail-envelope.json"), "FAIL_ENVELOPE"],
    [null, "MALFORMED_ENVELOPE"], [success({ id: undefined }), "RESERVATION_ID_INVALID"], [success({ totalPrice: 200.004 }), "AMOUNT_NOT_EXACT"],
    [success({ customFieldValues: [{ customFieldId: 105433, value: "MV-E4TEST01" }, { customFieldId: 105433, value: "MV-E4TEST01" }] }), "REF_FIELD_DUPLICATED"]
  ];
  for (const [json, want] of amb) {
    const c = classifyCreateResponse({ httpStatus: 200, json }, plan(), CFG);
    assert.equal(c.outcome, "ambiguous", JSON.stringify(json));
    assert.equal(c.code, want);
  }
});

test("classify: 401/403/429/5xx/network/timeouts are ambiguous; any 4xx is only an uncatalogued candidate; nothing is ever 'refused'", () => {
  const want = [
    [{ httpStatus: 401 }, "AUTH_UNCERTAIN"], [{ httpStatus: 403 }, "AUTH_UNCERTAIN"],
    [{ httpStatus: 429, json: fixture("synthetic-rate-limited.json") }, "RATE_LIMITED"],
    [{ httpStatus: 500 }, "UPSTREAM_5XX"], [{ httpStatus: 502 }, "UPSTREAM_5XX"], [{ httpStatus: 504 }, "UPSTREAM_5XX"],
    [{ transportError: "timeout" }, "TRANSPORT_UNCERTAIN"], [{ transportError: true, httpStatus: 200, json: SUCCESS }, "TRANSPORT_UNCERTAIN"],
    [{}, "NO_HTTP_STATUS"], [{ httpStatus: "200", json: SUCCESS }, "NO_HTTP_STATUS"], [null, "NO_RESPONSE"],
    [{ httpStatus: 302 }, "UNEXPECTED_HTTP_STATUS"], [{ httpStatus: 100 }, "UNEXPECTED_HTTP_STATUS"]
  ];
  for (const [resp, c] of want) {
    const r = classifyCreateResponse(resp, plan(), CFG);
    assert.equal(r.outcome, "ambiguous", JSON.stringify(resp));
    assert.equal(r.code, c);
    assert.equal(r.definiteRefusal, false);
  }
  for (const s of [400, 404, 409, 410, 422]) {
    const r = classifyCreateResponse({ httpStatus: s, json: fixture("synthetic-fail-envelope.json") }, plan(), CFG);
    assert.deepEqual([r.outcome, r.code, r.candidateCode, r.definiteRefusal], ["ambiguous", "UNCATALOGUED_REFUSAL_CANDIDATE", `HTTP_${s}`, false]);
  }
  // Exhaustive: no HTTP status, with any body, ever yields a refusal.
  for (let s = 100; s <= 599; s++) {
    for (const json of [SUCCESS, fixture("synthetic-fail-envelope.json"), null]) {
      const r = classifyCreateResponse({ httpStatus: s, json }, plan(), CFG);
      assert.notEqual(r.outcome, "refused");
      assert.equal(r.definiteRefusal, false);
      if (r.outcome === "created") assert.ok(s >= 200 && s <= 299 && json === SUCCESS);
    }
  }
});

test("classify: an invalid or pilot plan is a programming error (throws), never a classification", () => {
  assert.equal(code(() => classifyCreateResponse({ httpStatus: 200, json: SUCCESS }, plan({ listingId: 603566 }), CFG)), "PILOT_LISTING_FORBIDDEN");
  assert.equal(code(() => classifyCreateResponse({ httpStatus: 200, json: SUCCESS }, plan(), { ...CFG, allowedListingIds: [603564] })), "PILOT_LISTING_FORBIDDEN");
});

// ---------- lookup ----------
const SPEC = Object.freeze({ ref: "MV-E4TEST01", listingId: TEST_LISTING, arrivalDate: "2027-03-10", departureDate: "2027-03-12" });
const item = (id, over = {}) => ({ ...SUCCESS.result, id, hostawayReservationId: id, customFieldValues: [{ customFieldId: 105433, value: `MV-OTHER${String(id % 100).padStart(2, "0")}` }], ...over });
const page = (items) => ({ httpStatus: 200, json: { status: "success", result: items, count: items.length } });
const fullPage = (start) => Array.from({ length: LOOKUP_PAGE_LIMIT }, (_, k) => item(start + k));
function pager(pages) {
  const calls = [];
  const fn = async (req) => { calls.push(req); const p = pages[calls.length - 1]; if (p instanceof Error) throw p; return p; };
  return { fn, calls };
}

test("lookup query: documented parameters, channel 2000, exact arrival, no forceOverbooking, pilots refused", () => {
  const q = buildLookupQuery(SPEC, CFG);
  assert.deepEqual(q, { method: "GET", path: "/reservations", query: { listingId: TEST_LISTING, channelId: 2000, arrivalStartDate: "2027-03-10",
    arrivalEndDate: "2027-03-10", limit: 100, includeResources: 1 } });
  assert.equal(buildLookupQuery(SPEC, CFG, { afterId: 5 }).query.afterId, 5);
  assert.equal(code(() => buildLookupQuery({ ...SPEC, listingId: 603564 }, CFG)), "PILOT_LISTING_FORBIDDEN");
  assert.equal(code(() => buildLookupQuery({ ...SPEC, forceOverbooking: 1 }, CFG)), "FORCE_OVERBOOKING_REFUSED");
  assert.equal(code(() => buildLookupQuery({ ...SPEC, extra: 1 }, CFG)), "UNKNOWN_FIELD");
  assert.equal(code(() => buildLookupQuery(SPEC, CFG, { afterId: 0 })), "CURSOR_INVALID");
});

const MINE = Object.freeze({ customFieldValues: [{ customFieldId: 105433, value: "MV-E4TEST01" }] });
const EMPTY = () => page([]);
const afterIds = (calls) => calls.map((c) => c.query.afterId);

test("lookup: one verified match is found only after the documented EMPTY terminal page; not found is never authoritative", async () => {
  const p1 = pager([page([item(10), item(11, MINE)]), EMPTY()]);
  const f = await lookupByRef(SPEC, CFG, p1.fn);
  assert.deepEqual([f.outcome, f.reservation.reservationId, f.authoritative, f.pagesRead], ["found", 11, false, 2]);
  assert.deepEqual(afterIds(p1.calls), [undefined, 11]);

  const p2 = pager([page([item(10), item(12)]), EMPTY()]);
  const n = await lookupByRef(SPEC, CFG, p2.fn);
  assert.deepEqual([n.outcome, n.authoritative, n.code, p2.calls.length], ["not_found", false, "NOT_FOUND_NON_AUTHORITATIVE", 2]);
  const p3 = pager([EMPTY()]);
  const e = await lookupByRef(SPEC, CFG, p3.fn);
  assert.deepEqual([e.outcome, e.authoritative, p3.calls.length], ["not_found", false, 1]);
});

test("lookup: a short NON-empty page is not the end — paging continues to an empty page", async () => {
  const p = pager([page([item(10)]), page([item(20, MINE)]), EMPTY()]);
  const r = await lookupByRef(SPEC, CFG, p.fn);
  assert.deepEqual([r.outcome, r.reservation.reservationId, p.calls.length], ["found", 20, 3]);
  assert.deepEqual(afterIds(p.calls), [undefined, 10, 20]);
  // Had the lookup stopped at the first short page, it would have reported "not_found": it must not.
  const miss = pager([page([item(10)]), page([item(20, MINE)])]);       // provider stops answering after page 2
  const r2 = await lookupByRef(SPEC, CFG, miss.fn);
  assert.notEqual(r2.outcome, "not_found");
  assert.equal(r2.code, "TRANSPORT_UNCERTAIN");
});

test("lookup: documented descending ids (updatedOn DESC, id DESC) page correctly with the opaque last-item cursor", async () => {
  const p = pager([page([item(500), item(400), item(300, MINE)]), page([item(200), item(100)]), EMPTY()]);
  const r = await lookupByRef(SPEC, CFG, p.fn);
  assert.deepEqual([r.outcome, r.reservation.reservationId], ["found", 300]);
  assert.deepEqual(afterIds(p.calls), [undefined, 300, 100]);
  const full = Array.from({ length: LOOKUP_PAGE_LIMIT }, (_, k) => item(1000 - k));       // 1000..901, descending
  const p2 = pager([page(full), page([item(900, MINE)]), EMPTY()]);
  const r2 = await lookupByRef(SPEC, CFG, p2.fn);
  assert.deepEqual([r2.outcome, afterIds(p2.calls)], ["found", [undefined, 901, 900]]);
});

test("lookup: non-monotonic unique ids are accepted (updatedOn order need not follow ids)", async () => {
  const p = pager([page([item(7), item(900), item(3)]), page([item(55, MINE), item(2), item(4000)]), EMPTY()]);
  const r = await lookupByRef(SPEC, CFG, p.fn);
  assert.deepEqual([r.outcome, r.reservation.reservationId], ["found", 55]);
  assert.deepEqual(afterIds(p.calls), [undefined, 3, 4000]);
  const n = await lookupByRef(SPEC, CFG, pager([page([item(9), item(1), item(5)]), page([item(8)]), EMPTY()]).fn);
  assert.deepEqual([n.outcome, n.authoritative], ["not_found", false]);
});

test("lookup: duplicate refs are conflicts, including a second match after a short non-empty page", async () => {
  const d = await lookupByRef(SPEC, CFG, pager([page([item(10, MINE), item(11, MINE)])]).fn);
  assert.deepEqual([d.outcome, d.code, d.matchCount], ["conflict", "DUPLICATE_REF", 2]);
  const p2 = pager([page([item(10, MINE)]), page([item(20, MINE)]), EMPTY()]);
  const d2 = await lookupByRef(SPEC, CFG, p2.fn);
  assert.deepEqual([d2.outcome, d2.code, d2.matchCount, p2.calls.length], ["conflict", "DUPLICATE_REF", 2, 2], "stops at the second match");
  const p3 = pager([page([item(10, MINE)]), page([item(20)]), page([item(30, MINE)]), EMPTY()]);
  const d3 = await lookupByRef(SPEC, CFG, p3.fn);
  assert.deepEqual([d3.outcome, d3.code, p3.calls.length], ["conflict", "DUPLICATE_REF", 3]);
  const w = await lookupByRef(SPEC, CFG, pager([page([item(10, { ...MINE, departureDate: "2027-03-13" })]), EMPTY()]).fn);
  assert.deepEqual([w.outcome, w.code, w.mismatches], ["conflict", "MATCH_DISAGREES", ["to"]]);
});

test("lookup: the five-page cap (terminal empty page included) gives 'incomplete', never absence", async () => {
  const fivePages = [page([item(1)]), page([item(2)]), page([item(3)]), page([item(4)]), page([item(5)]), EMPTY()];
  const p = pager(fivePages);
  const r = await lookupByRef(SPEC, CFG, p.fn);
  assert.deepEqual([r.outcome, r.code, r.authoritative, p.calls.length], ["incomplete", "PAGE_CAP_REACHED", false, 5]);
  const four = await lookupByRef(SPEC, CFG, pager([page([item(1)]), page([item(2)]), page([item(3)]), page([item(4, MINE)]), EMPTY()]).fn);
  assert.deepEqual([four.outcome, four.pagesRead], ["found", 5]);
  const fullCap = pager([page(fullPage(1)), page(fullPage(101)), page(fullPage(201)), page(fullPage(301)), page(fullPage(401)), EMPTY()]);
  assert.equal((await lookupByRef(SPEC, CFG, fullCap.fn)).outcome, "incomplete");
  assert.equal(fullCap.calls.length, 5);
  const r2 = await lookupByRef(SPEC, CFG, pager([page([item(6, MINE)]), EMPTY()]).fn, { maxPages: 1 });
  assert.deepEqual([r2.outcome, r2.matchCount], ["incomplete", 1]);
  await assert.rejects(lookupByRef(SPEC, CFG, p.fn, { maxPages: 6 }), (e) => e.code === "MAX_PAGES_INVALID");
  await assert.rejects(lookupByRef(SPEC, CFG, p.fn, { maxPages: 0 }), (e) => e.code === "MAX_PAGES_INVALID");
});

test("lookup: errors, transport failures, cursor overlap and malformed pages stop at once, without retries", async () => {
  const cases = [
    [[new Error("socket hang up")], "TRANSPORT_UNCERTAIN"], [[{ transportError: "timeout" }], "TRANSPORT_UNCERTAIN"], [[null], "TRANSPORT_UNCERTAIN"],
    [[{ httpStatus: 429, json: fixture("synthetic-rate-limited.json") }], "HTTP_NOT_OK"], [[{ httpStatus: 401 }], "HTTP_NOT_OK"],
    [[{ httpStatus: 500 }], "HTTP_NOT_OK"], [[{ httpStatus: 201, json: { status: "success", result: [] } }], "HTTP_NOT_OK"],
    [[page([item(1)]), { httpStatus: 503 }], "HTTP_NOT_OK"],
    [[{ httpStatus: 200, json: fixture("synthetic-fail-envelope.json") }], "FAIL_ENVELOPE"],
    [[{ httpStatus: 200, json: { status: "success", result: {} } }], "MALFORMED_PAGE"],
    [[page([item(10, { totalPrice: "x" })])], "ITEM_AMOUNT_NOT_EXACT"],
    [[page([item(10, { status: "booked by a@example.invalid" })])], "ITEM_STATUS_INVALID"],
    [[page([item(10, { customFieldValues: [{ customFieldId: 105433, value: "a" }, { customFieldId: 105433, value: "b" }] })])], "ITEM_REF_FIELD_DUPLICATED"],
    [[page([item(10), item(10)])], "CURSOR_OVERLAP"],                                  // repeat within a page
    [[page([item(10)]), page([item(10)])], "CURSOR_OVERLAP"],                          // cursor item returned again
    [[page(fullPage(1)), page([item(50)])], "CURSOR_OVERLAP"],                         // earlier item shifted into a later page
    [[page([item(30), item(20)]), page([item(5), item(30)])], "CURSOR_OVERLAP"],
    [[page([...fullPage(1), item(101)])], "PAGE_OVER_LIMIT"],
    [[page([item(10, { listingMapId: 603564 })])], "FILTER_NOT_APPLIED"], [[page([item(10, { channelId: 2001 })])], "FILTER_NOT_APPLIED"],
    [[page([item(10, { arrivalDate: "2027-03-09" })])], "FILTER_NOT_APPLIED"]
  ];
  for (const [pages, want] of cases) {
    const p = pager([...pages, EMPTY()]);
    const r = await lookupByRef(SPEC, CFG, p.fn);
    assert.equal(r.outcome, "error", want);
    assert.equal(r.code, want);
    assert.equal(r.authoritative, false);
    assert.equal(p.calls.length, pages.length, `${want}: one call per page, no retry, nothing after the stop`);
  }
  await assert.rejects(lookupByRef(SPEC, CFG, null), (e) => e.code === "FETCH_PAGE_REQUIRED");
  await assert.rejects(lookupByRef({ ...SPEC, listingId: 603566 }, CFG, async () => page([])), (e) => e.code === "PILOT_LISTING_FORBIDDEN");
});

// ---------- evidence ----------
test("evidence: only allowlisted keys survive; guest data is dropped", () => {
  const c = classifyCreateResponse({ httpStatus: 200, json: SUCCESS }, plan(), CFG);
  const ev = sanitizeForEvidence({ ...c, guestEmail: "x@example.invalid", token: "secret", reservation: { ...c.reservation, guestName: "Synthetic Tester" } });
  assert.deepEqual(Object.keys(ev).sort(), ["code", "definiteRefusal", "httpStatus", "outcome", "reservation"]);
  assert.deepEqual(ev.reservation, { reservationId: 70000001, listingId: 990001, from: "2027-03-10", to: "2027-03-12", totalMinor: 20000,
    currency: "USD", channelId: 2000, status: "new", bookingRef: "MV-E4TEST01" });
  assert.ok(!/example\.invalid|secret|Synthetic/.test(JSON.stringify(ev)));
  assert.deepEqual(sanitizeForEvidence(null), {});
  assert.deepEqual(sanitizeForEvidence([{ outcome: "created" }]), {});
});

test("evidence (adversarial): allowlisted key NAMES with hostile VALUES are omitted, never copied", () => {
  const SECRET = /secret|tok_|@|example|Synthetic|\+52|http/i;
  const hostile = {
    outcome: "created; guest=a@example.invalid", code: "VERIFIED_CREATED\nguestEmail: a@example.invalid", httpStatus: "200",
    candidateCode: "HTTP_409 contact a@example.invalid", definiteRefusal: true, authoritative: true,
    matchCount: -1, pagesRead: 6, reservationId: { token: "secret" },
    status: { token: "secret" },
    mismatches: [{ guestEmail: "a@example.invalid" }, "listingId", "guestEmail", "listingId", ["from"], "to"],
    reservation: {
      reservationId: "70000001", listingId: 0, from: "2027-02-30", to: { secret: "x" }, totalMinor: 100.5, currency: "usd ",
      channelId: -2000, status: "new — call +52 555 0100", bookingRef: { secret: "tok_abc" }, guestName: "Synthetic Tester"
    },
    extra: { nested: { token: "secret" } }
  };
  const ev = sanitizeForEvidence(hostile);
  assert.deepEqual(ev, { mismatches: ["listingId", "to"] });
  assert.doesNotMatch(JSON.stringify(ev), SECRET);

  // Each example from the review, one at a time.
  assert.deepEqual(sanitizeForEvidence({ outcome: "conflict", status: { token: "secret" } }), { outcome: "conflict" });
  assert.deepEqual(sanitizeForEvidence({ outcome: "conflict", mismatches: [{ guestEmail: "a@example.invalid" }] }), { outcome: "conflict" });
  assert.deepEqual(sanitizeForEvidence({ outcome: "found", reservation: { bookingRef: { secret: "tok_abc" } } }), { outcome: "found" });
  assert.deepEqual(sanitizeForEvidence({ reservation: { bookingRef: "MV-E4TEST01 a@example.invalid" } }), {});
  assert.deepEqual(sanitizeForEvidence({ code: "SOMETHING_NEW" }), {});
  assert.deepEqual(sanitizeForEvidence({ candidateCode: "HTTP_999" }), {});
  assert.deepEqual(sanitizeForEvidence({ matchCount: 501, pagesRead: 1.5 }), {});
});

test("evidence (adversarial): arbitrary provider status strings never reach a result or evidence", () => {
  const raw = ["confirmed by a@example.invalid", "new ", "NEW", "call +52 555 0100", "x".repeat(5000), ""];
  for (const s of raw) {
    assert.equal(normalizeReservation({ ...SUCCESS.result, status: s }, CFG).code, "STATUS_INVALID");
    const c = classifyCreateResponse({ httpStatus: 200, json: success({ status: s }) }, plan(), CFG);
    assert.deepEqual([c.outcome, c.code], ["ambiguous", "STATUS_INVALID"]);
    assert.ok(!JSON.stringify(c).includes(s || "\u0000"), "no raw status in the result");
    assert.equal(sanitizeForEvidence({ status: s, reservation: { status: s } }).status, undefined);
  }
  for (const s of ["cancelled", "pending", "inquiry"]) {   // documented enum values only
    const c = classifyCreateResponse({ httpStatus: 200, json: success({ status: s }) }, plan(), CFG);
    assert.equal(sanitizeForEvidence(c).status, s, "a documented enum value is kept as evidence");
    assert.equal(c.code, "UNEXPECTED_RESERVATION_STATUS");
  }
});

test("evidence: output is freshly allocated; the caller's input stays mutable and unmodified", () => {
  const input = {
    outcome: "conflict", code: "RESERVATION_MISMATCH", mismatches: ["totalMinor"], extra: { a: 1 },
    reservation: { reservationId: 5, listingId: 990001, from: "2027-03-10", to: "2027-03-12", totalMinor: 1, currency: "USD", channelId: 2000,
      status: "new", bookingRef: "MV-E4TEST01", nested: { b: 2 } }
  };
  const snapshot = structuredClone(input);
  const ev = sanitizeForEvidence(input);
  assert.deepEqual(input, snapshot, "input unmodified");
  for (const o of [input, input.mismatches, input.reservation, input.reservation.nested, input.extra]) assert.equal(Object.isFrozen(o), false);
  assert.notEqual(ev.reservation, input.reservation);
  assert.notEqual(ev.mismatches, input.mismatches);
  input.reservation.totalMinor = 2; input.mismatches.push("to"); input.extra.a = 3;   // still mutable
  assert.equal(ev.reservation.totalMinor, 1);
  assert.deepEqual(ev.mismatches, ["totalMinor"]);
  assert.ok(Object.isFrozen(ev) && Object.isFrozen(ev.reservation) && Object.isFrozen(ev.mismatches));

  // Classification and lookup do not freeze caller-owned response bodies either.
  const json = structuredClone(SUCCESS);
  classifyCreateResponse({ httpStatus: 200, json }, plan(), CFG);
  assert.equal(Object.isFrozen(json) || Object.isFrozen(json.result) || Object.isFrozen(json.result.customFieldValues), false);
  assert.deepEqual(json, SUCCESS);
});

test("evidence: every code and outcome the module actually emits survives sanitisation unchanged", async () => {
  const results = [];
  for (let s = 100; s <= 599; s += 1) for (const json of [SUCCESS, fixture("synthetic-fail-envelope.json"), null]) {
    results.push(classifyCreateResponse({ httpStatus: s, json }, plan(), CFG));
  }
  for (const over of [{ listingMapId: 990002 }, { status: "cancelled" }, { status: "bogus" }, { totalPrice: 1.001 }, { id: 0 }]) {
    results.push(classifyCreateResponse({ httpStatus: 200, json: success(over) }, plan(), CFG));
  }
  results.push(classifyCreateResponse({ transportError: true }, plan(), CFG), classifyCreateResponse(null, plan(), CFG));
  const mine = { customFieldValues: [{ customFieldId: 105433, value: "MV-E4TEST01" }] };
  for (const pages of [[page([item(10, mine)]), page([])], [page([item(10)]), page([])], [page([item(10, mine), item(11, mine)])],
    [page([item(10, { status: "zzz" })])], [page([item(10), item(10)])], [{ httpStatus: 500 }],
    [page([item(10, { ...mine, departureDate: "2027-03-13" })]), page([])], [page([item(1)]), page([item(2)]), page([item(3)]), page([item(4)]), page([item(5)])]]) {
    results.push(await lookupByRef(SPEC, CFG, pager(pages).fn));
  }
  for (const r of results) {
    const ev = sanitizeForEvidence(r);
    assert.equal(ev.outcome, r.outcome, JSON.stringify(r));
    assert.equal(ev.code, r.code, JSON.stringify(r));
    if (r.mismatches) assert.deepEqual(ev.mismatches, r.mismatches);
    if (r.reservation) assert.deepEqual(ev.reservation, { ...r.reservation });
  }
});

// ---------- provenance and containment ----------
test("mapping: every response/lookup assumption not stated in the docs is labelled LIVE-UNVERIFIED; the field id is provisional", () => {
  const s = JSON.stringify(HOSTAWAY_RESERVATION_MAPPING);
  for (const k of ["envelope", "totalMinor", "status", "bookingRef"]) assert.match(HOSTAWAY_RESERVATION_MAPPING.response[k], /LIVE-UNVERIFIED/, k);
  assert.match(HOSTAWAY_RESERVATION_MAPPING.request.customFieldValues, /PROVISIONAL/);
  assert.match(HOSTAWAY_RESERVATION_MAPPING.errors.refusal, /never classified as definite/);
  assert.match(HOSTAWAY_RESERVATION_MAPPING.lookup.pagination, /EMPTY page/);
  assert.match(HOSTAWAY_RESERVATION_MAPPING.lookup.pagination, /updatedOn DESC, id DESC/);
  assert.doesNotMatch(HOSTAWAY_RESERVATION_MAPPING.lookup.pagination, /short page|increasing/);
  assert.ok(s.includes("financeField") && s.includes("not built"));
  assert.equal(DIRECT_CHANNEL_ID, 2000);
});

test("containment: the adapter is pure and unreachable — no imports, network, env, timers or callers", () => {
  const src = readFileSync(join(ROOT, "lib/hostaway-reservations.js"), "utf8");
  const code = src.replace(/\/\/.*$/gm, "").replace(/"(?:[^"\\]|\\.)*"/g, '""');
  for (const re of [/\bimport\b/, /\brequire\s*\(/, /\bfetch\s*\(/, /process\./, /setTimeout|setInterval/, /Date\.now|new Date\(\)/, /XMLHttpRequest|WebSocket/, /\beval\s*\(|new Function/]) {
    assert.doesNotMatch(code, re, String(re));
  }
  const importers = [];
  const walk = (dir) => {
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else if (/\.(m?js|cjs)$/.test(e.name) && p !== "lib/hostaway-reservations.js" &&
        readFileSync(join(ROOT, p), "utf8").includes("hostaway-reservations")) importers.push(p);
    }
  };
  for (const d of ["api", "lib", "db", "scripts"]) walk(d);
  // The only importer is the offline E4 write runner under scripts/ (excluded from Vercel; no transport, no env).
  assert.deepEqual(importers.sort(), ["scripts/e4-write-runner/happy-path.mjs", "scripts/e4-write-runner/runner.mjs"], "nothing deployable references the adapter");
});
