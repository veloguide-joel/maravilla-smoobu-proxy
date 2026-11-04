// E7 connected-test executor adapters — OFFLINE tests with INJECTED FAKE transports only (no network, no SDK, no credentials, no DB).
// Every id / name / address / account is SYNTHETIC. Nothing here proves provider support: fakes prove request MAPPING only.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPhaseExecutors, PHASE_KEYS, BINDING_KEYS, ExecutorRefusal, ExecutorTransportFailure, PILOT_EXCEPTION } from "../scripts/e7-connected/executor-adapters.mjs";
import * as AD from "../scripts/e7-connected/executor-adapters.mjs";
import * as HR from "../lib/hostaway-reservations.js";
import { validateAdapterConfig, buildCreateReservationRequest, classifyCreateResponse, lookupByRef, connectedTestAdapterConfig, assessRefNotEchoed, unwrapEnvelope, normalizeReservation } from "../lib/hostaway-reservations.js";
import { reservationWorkerGate } from "../lib/booking-db/reservation-worker.js";
import { captureWorkerGate } from "../lib/booking-db/capture-worker.js";
import { compensationWorkerGate } from "../lib/booking-db/compensation-worker.js";
import { recordingWorkerGate } from "../lib/booking-db/recording-worker.js";
import { priceStay } from "../lib/checkout/server-pricer.js";
import { readDirectPolicyFromEnv } from "../lib/direct-policy.js";
import { todayInTimeZone } from "../lib/public-api.js";
import { offlineChargeTitle, exactAmount, formatScheduledDate, LIST_LIMIT } from "../lib/checkout/offline-charge-proof.js";

let netAttempts = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { netAttempts += 1; throw new Error("network refused (offline adapter suite)"); };
after(() => { globalThis.fetch = realFetch; assert.equal(netAttempts, 0, "no network attempt"); });

const L = 891001; const RID = "6100001"; const REF = "MV-ADPT0001"; const IN = "2026-12-04"; const OUT = "2026-12-06";
const INTENT = "00000000-0000-4000-8000-0000000000b1";
const ACCT = "acct_1SyntheticAdapter"; const PI = "pi_test_syntheticAdapter1";
const GUEST = Object.freeze({ firstName: "Synthia", lastName: "Fixture", email: "guest.adapter@mv-test.invalid" });
const CFG = validateAdapterConfig({ allowedListingIds: [L], refFieldId: 777016, channelId: 2000, currency: "USD" });
const B = {
  reservation: () => ({ listingId: L, arrivalDate: IN, departureDate: OUT, ref: REF, guests: 2, totalMinor: 50000, currency: "USD", refFieldId: 777016, guest: { ...GUEST }, reservationId: null }),
  capture: () => ({ listingId: L, arrivalDate: IN, departureDate: OUT, ref: REF, reservationId: RID, accountId: ACCT, paymentIntentId: PI, amountMinor: 50000,
    captureIdempotencyKey: `cap:${INTENT}:${PI}` }),
  cleanup: () => ({ listingId: L, arrivalDate: IN, departureDate: OUT, ref: REF, reservationId: RID, accountId: ACCT, paymentIntentId: PI, voidIdempotencyKey: `void:${INTENT}:${PI}` }),
  recording: () => ({ listingId: L, reservationId: RID, intentId: INTENT, amountMinor: 50000, paymentMethod: "credit_card", accountRef: "acct-test-1", clientSnapshotId: "client-AD" })
};
/** spy transports: record every invocation; reply per `reply` */
function spies({ reply = () => ({ httpStatus: 200, json: { status: "success", result: {} } }), sreply = (c) => ({ object: "stub", op: c.op }) } = {}) {
  const s = { h: [], s: [] };
  s.hostaway = { send: (req, x) => { s.h.push({ req, x }); return reply(req, x); } };
  s.stripe = { send: (call, x) => { s.s.push({ call, x }); return sreply(call, x); } };
  return s;
}
const make = (phase, sp, binding = B[phase](), extra = {}) => {
  const o = { phase, binding, hostaway: sp.hostaway, ...extra };
  if (phase === "capture" || phase === "cleanup") o.stripe = sp.stripe;
  const r = createPhaseExecutors(o);
  assert.equal(r.ok, true, `${phase}: ${r.code}`);
  return r.executors;
};
const sig = () => new AbortController().signal;
const plainJSON = (v) => JSON.parse(JSON.stringify(v));
async function refusedZero(fn, sp, code, label) {
  const h0 = sp.h.length; const s0 = sp.s.length;
  await assert.rejects(fn(), (e) => e instanceof ExecutorRefusal && (code === undefined || e.code === code), label);
  assert.equal(sp.h.length, h0, `${label}: zero Hostaway calls`); assert.equal(sp.s.length, s0, `${label}: zero Stripe calls`);
}
const ENV = { VERCEL_ENV: "development", MV_E7_RESERVATION_WORKER: "enabled", MV_E7_CAPTURE_WORKER: "enabled", MV_E7_COMPENSATION_WORKER: "enabled", MV_E7_RECORDING_WORKER: "enabled" };

// ---------------------------------------------------------------------------------------------

test("factories: exactly each accepted worker gate's executor key set; every accepted gate accepts them", () => {
  const sp = spies();
  for (const ph of ["reservation", "capture", "cleanup", "recording"]) assert.deepEqual(Object.keys(make(ph, sp)).sort(), [...PHASE_KEYS[ph]].sort(), ph);
  assert.ok(Object.isFrozen(make("reservation", sp)) && Object.isFrozen(make("reservation", sp).pricing));
  const listings = new Map([[L, { currency: "USD" }]]);
  const okGate = (g, label) => assert.equal(g.ok, true, `${label}: ${g.code}`);
  okGate(reservationWorkerGate({ env: ENV, adapterConfig: CFG, listings, executors: make("reservation", sp), clock: Date.now }), "reservation");
  okGate(captureWorkerGate({ env: ENV, adapterConfig: CFG, listings, executors: make("capture", sp), clock: Date.now, stripeAccountId: ACCT }), "capture");
  okGate(compensationWorkerGate({ env: ENV, adapterConfig: CFG, listings: new Map([[L, { currency: "USD", timeZone: "America/Mazatlan" }]]), executors: make("cleanup", sp), clock: Date.now, stripeAccountId: ACCT }), "cleanup");
  const rec = new Map([[L, { accountRef: "acct-test-1", channelId: 2000, currency: "USD", listingId: L, paymentMethod: "credit_card", refFieldId: 777016 }]]);
  okGate(recordingWorkerGate({ env: ENV, listings: rec, executors: make("recording", sp), clock: Date.now }), "recording");
  assert.equal(sp.h.length + sp.s.length, 0, "constructing / gating invokes nothing");
});

test("accepted worker call sites match the documented signatures (source pins at the runtime baseline)", () => {
  const src = (f) => readFileSync(new URL(`../lib/booking-db/${f}`, import.meta.url), "utf8");
  const R = src("reservation-worker.js"); const C = src("capture-worker.js"); const K = src("compensation-worker.js"); const W = src("recording-worker.js");
  for (const [s, pin] of [[R, "ctx.executors.pricing.get(path, { ...o, signal })"], [R, "ctx.executors.pricing.post(path, body, { ...o, signal })"],
    [R, "ctx.executors.lookupPage(req, { signal })"], [R, "ctx.executors.retrieveReservation(req, { signal })"], [R, "ctx.executors.createReservation(request, { signal })"],
    [C, "ctx.executors.retrieveAccount({ signal })"], [C, 'ctx.executors.retrievePaymentIntent(pi, { expand: ["latest_charge"] }, { signal })'],
    [C, "{ ...request.params, expand: [...request.params.expand] }, { idempotencyKey: request.options.idempotencyKey, signal }"],
    [C, "ctx.executors.retrieveReservation(req, { signal })"], [C, "ctx.executors.lookupPage(req, { signal })"],
    [K, "ctx.executors.cancelPaymentIntent(req.paymentIntentId, {}, { idempotencyKey: req.options.idempotencyKey, signal })"],
    [K, "ctx.executors.cancelReservation(req, { signal })"], [K, 'ctx.executors.retrievePaymentIntent(pi, { expand: ["latest_charge"] }, { signal })'],
    [W, "ctx.basis.exec[key](request, { signal })"], [W, "ctx.basis.exec.createOfflineCharge(plan.request, { signal })"],
    [W, 'Object.freeze({ method: "GET", path: `/v1/reservations/${rid}`, query: Object.freeze({}) })'],
    [W, 'Object.freeze({ method: "GET", path: "/v1/guestPayments/charges", query: Object.freeze({ reservationId: rid, limit: LIST_LIMIT }) })']]) {
    assert.ok(s.includes(pin), pin);
  }
});

test("positive mapping, every key: exactly ONE invocation with the normalised '/v1' request / exact Stripe call; replies passed through", async () => {
  const sp = spies();
  const r = make("reservation", sp);
  const reply = await r.pricing.get(`/listings/${L}`, { timeoutMs: 8000, signal: sig() });
  assert.deepEqual(plainJSON(reply), { status: 200, json: { status: "success", result: {} } }, "pricing keeps its {status, json} contract");
  await r.pricing.get(`/listings/${L}/calendar`, { query: { startDate: IN, endDate: OUT }, timeoutMs: 8000, signal: sig() });
  await r.pricing.post(`/listings/${L}/calendar/priceDetails`, { startingDate: IN, endingDate: OUT, numberOfGuests: 2, version: 2 }, { timeoutMs: 8000, signal: sig() });
  const plan = { ref: REF, listingId: L, arrivalDate: IN, departureDate: OUT, guests: 2, totalMinor: 50000, currency: "USD", guest: { ...GUEST } };
  const cr = buildCreateReservationRequest(plan, CFG);
  const crep = await r.createReservation(cr, { signal: sig() });
  assert.deepEqual(Object.keys(crep).sort(), ["httpStatus", "json"]);
  await r.lookupPage({ method: "GET", path: "/reservations", query: { listingId: L, channelId: 2000, arrivalStartDate: IN, arrivalEndDate: IN, limit: 100, includeResources: 1 } }, { signal: sig() });
  await r.lookupPage({ method: "GET", path: "/reservations", query: { listingId: L, channelId: 2000, arrivalStartDate: IN, arrivalEndDate: IN, limit: 100, includeResources: 1, afterId: 42 } }, { signal: sig() });
  assert.deepEqual(sp.h.map((x) => [x.req.method, x.req.path]), [["GET", `/v1/listings/${L}`], ["GET", `/v1/listings/${L}/calendar`], ["POST", `/v1/listings/${L}/calendar/priceDetails`],
    ["POST", "/v1/reservations"], ["GET", "/v1/reservations"], ["GET", "/v1/reservations"]]);
  assert.deepEqual(plainJSON(sp.h[3].req), plainJSON({ ...cr, path: "/v1/reservations" }), "create body forwarded exactly");
  assert.ok(sp.h.every((x) => x.x.signal instanceof AbortSignal && Object.keys(x.x).length === 1), "the worker's signal, through the documented injected interface");
  // capture / cleanup / recording
  const c = make("capture", sp);
  await c.retrieveAccount({ signal: sig() });
  await c.retrievePaymentIntent(PI, { expand: ["latest_charge"] }, { signal: sig() });
  await c.capturePaymentIntent(PI, { amount_to_capture: 50000, final_capture: true, expand: ["latest_charge"] }, { idempotencyKey: `cap:${INTENT}:${PI}`, signal: sig() });
  await c.retrieveReservation({ method: "GET", path: `/reservations/${RID}`, query: {} }, { signal: sig() });
  const k = make("cleanup", sp);
  await k.cancelPaymentIntent(PI, {}, { idempotencyKey: `void:${INTENT}:${PI}`, signal: sig() });
  await k.cancelReservation({ method: "PUT", path: `/v1/reservations/${RID}/statuses/cancelled`, query: {}, body: { cancelledBy: "host" } }, { signal: sig() });
  const w = make("recording", sp);
  await w.retrieveReservation({ method: "GET", path: `/v1/reservations/${RID}`, query: {} }, { signal: sig() });
  await w.listOfflineCharges({ method: "GET", path: "/v1/guestPayments/charges", query: { reservationId: RID, limit: LIST_LIMIT } }, { signal: sig() });
  const body = { title: offlineChargeTitle(INTENT), amount: exactAmount(50000), paymentMethod: "credit_card", status: "paid", scheduledDate: formatScheduledDate(Date.UTC(2026, 11, 4, 10)) };
  await w.createOfflineCharge({ method: "POST", path: `/v1/guestPayments/charges/${RID}`, query: {}, body }, { signal: sig() });
  assert.deepEqual(sp.s.map((x) => plainJSON(x.call)), [{ op: "accounts.retrieve" }, { op: "paymentIntents.retrieve", id: PI, params: { expand: ["latest_charge"] } },
    { op: "paymentIntents.capture", id: PI, params: { amount_to_capture: 50000, final_capture: true, expand: ["latest_charge"] }, idempotencyKey: `cap:${INTENT}:${PI}` },
    { op: "paymentIntents.cancel", id: PI, params: {}, idempotencyKey: `void:${INTENT}:${PI}` }]);
  assert.deepEqual(sp.h.slice(6).map((x) => [x.req.method, x.req.path]), [["GET", `/v1/reservations/${RID}`], ["PUT", `/v1/reservations/${RID}/statuses/cancelled`],
    ["GET", `/v1/reservations/${RID}`], ["GET", "/v1/guestPayments/charges"], ["POST", `/v1/guestPayments/charges/${RID}`]]);
  assert.ok(sp.h.every((x) => /^\/v1\/(?!v1\/)/.test(x.req.path)), "exactly ONE /v1 prefix for both worker conventions");
  assert.equal(sp.h.length, 11); assert.equal(sp.s.length, 4, "one invocation per adapter call");
  // Stripe replies are raw objects, unchanged
  const raw = { object: "payment_intent", id: PI, status: "requires_capture" };
  const sp2 = spies({ sreply: () => raw });
  assert.equal(await make("capture", sp2).retrievePaymentIntent(PI, { expand: ["latest_charge"] }, { signal: sig() }), raw);
});

test("scope refusals: wrong listing / reservation / ref / dates / amount / account binding / PI / key / body / query / method → ExecutorRefusal, ZERO calls", async () => {
  const sp = spies();
  const r = make("reservation", sp); const c = make("capture", sp); const k = make("cleanup", sp); const w = make("recording", sp);
  const q = (o = {}) => ({ method: "GET", path: "/reservations", query: { listingId: L, channelId: 2000, arrivalStartDate: IN, arrivalEndDate: IN, limit: 100, includeResources: 1, ...o } });
  const plan = { ref: REF, listingId: L, arrivalDate: IN, departureDate: OUT, guests: 2, totalMinor: 50000, currency: "USD", guest: { ...GUEST } };
  const cr = buildCreateReservationRequest(plan, CFG);
  const crWith = (f) => { const x = plainJSON(cr); f(x); return x; };
  const cases = [
    ["lookup other listing", () => r.lookupPage(q({ listingId: L + 1 }), { signal: sig() }), "QUERY_SCOPE"],
    ["lookup other date", () => r.lookupPage(q({ arrivalStartDate: "2026-12-05" }), { signal: sig() }), "QUERY_SCOPE"],
    ["lookup extra query", () => r.lookupPage(q({ forceOverbooking: true }), { signal: sig() }), "QUERY"],
    ["lookup cursor not an int", () => r.lookupPage(q({ afterId: "1" }), { signal: sig() }), "QUERY_SCOPE"],
    ["retrieve unbound in the creation factory", () => r.retrieveReservation({ method: "GET", path: `/reservations/${RID}`, query: {} }, { signal: sig() }), "RESERVATION_UNBOUND"],
    ["retrieve other id", () => c.retrieveReservation({ method: "GET", path: "/reservations/6100002", query: {} }, { signal: sig() }), "PATH"],
    ["retrieve with query", () => c.retrieveReservation({ method: "GET", path: `/reservations/${RID}`, query: { includeResources: 1 } }, { signal: sig() }), "QUERY"],
    ["pricing other listing", () => r.pricing.get(`/listings/${L + 1}`, { signal: sig() }), "PATH"],
    ["pricing calendar other dates", () => r.pricing.get(`/listings/${L}/calendar`, { query: { startDate: IN, endDate: "2026-12-09" }, signal: sig() }), "QUERY_SCOPE"],
    ["pricing other guests", () => r.pricing.post(`/listings/${L}/calendar/priceDetails`, { startingDate: IN, endingDate: OUT, numberOfGuests: 3, version: 2 }, { signal: sig() }), "BODY_SCOPE"],
    ["create other ref", () => r.createReservation(crWith((x) => { x.body.customFieldValues[0].value = "MV-OTHER001"; }), { signal: sig() }), "BODY_SCOPE"],
    ["create other amount", () => r.createReservation(crWith((x) => { x.body.totalPrice = 500.01; }), { signal: sig() }), "BODY_SCOPE"],
    ["create other dates", () => r.createReservation(crWith((x) => { x.body.departureDate = "2026-12-07"; }), { signal: sig() }), "BODY_SCOPE"],
    ["create other listing", () => r.createReservation(crWith((x) => { x.body.listingMapId = L + 1; }), { signal: sig() }), "BODY_SCOPE"],
    ["create other guest", () => r.createReservation(crWith((x) => { x.body.guestEmail = "other@mv-test.invalid"; }), { signal: sig() }), "BODY_SCOPE"],
    ["create extra body field", () => r.createReservation(crWith((x) => { x.body.status = "new"; }), { signal: sig() }), "BODY_SHAPE"],
    ["create forceOverbooking", () => r.createReservation(crWith((x) => { x.body.forceOverbooking = false; }), { signal: sig() }), "FORCE_OVERBOOKING_REFUSED"],
    ["create query", () => r.createReservation(crWith((x) => { x.query = { forceOverbooking: true }; }), { signal: sig() }), "CREATE_QUERY_REFUSED"],
    ["create query provider", () => r.createReservation(crWith((x) => { x.query = { provider: "x" }; }), { signal: sig() }), "CREATE_QUERY_REFUSED"],
    ["create wrong method", () => r.createReservation(crWith((x) => { x.method = "PUT"; }), { signal: sig() }), "METHOD"],
    ["PI other", () => c.retrievePaymentIntent("pi_test_other", { expand: ["latest_charge"] }, { signal: sig() }), "PAYMENT_INTENT_SCOPE"],
    ["PI params extra", () => c.retrievePaymentIntent(PI, { expand: ["latest_charge"], x: 1 }, { signal: sig() }), "PARAMS"],
    ["capture other amount", () => c.capturePaymentIntent(PI, { amount_to_capture: 49999, final_capture: true, expand: ["latest_charge"] }, { idempotencyKey: `cap:${INTENT}:${PI}`, signal: sig() }), "PARAMS"],
    ["capture new key", () => c.capturePaymentIntent(PI, { amount_to_capture: 50000, final_capture: true, expand: ["latest_charge"] }, { idempotencyKey: `cap:${INTENT}:${PI}:a2`, signal: sig() }), "IDEMPOTENCY_KEY"],
    ["capture no key", () => c.capturePaymentIntent(PI, { amount_to_capture: 50000, final_capture: true, expand: ["latest_charge"] }, { signal: sig() }), "IDEMPOTENCY_KEY"],
    ["void params", () => k.cancelPaymentIntent(PI, { cancellation_reason: "x" }, { idempotencyKey: `void:${INTENT}:${PI}`, signal: sig() }), "PARAMS"],
    ["cancel other id", () => k.cancelReservation({ method: "PUT", path: "/v1/reservations/6100002/statuses/cancelled", query: {}, body: { cancelledBy: "host" } }, { signal: sig() }), "PATH"],
    ["cancel other body", () => k.cancelReservation({ method: "PUT", path: `/v1/reservations/${RID}/statuses/cancelled`, query: {}, body: { cancelledBy: "guest" } }, { signal: sig() }), "BODY_SCOPE"],
    ["list other reservation", () => w.listOfflineCharges({ method: "GET", path: "/v1/guestPayments/charges", query: { reservationId: "6100002", limit: LIST_LIMIT } }, { signal: sig() }), "QUERY_SCOPE"],
    ["list other limit", () => w.listOfflineCharges({ method: "GET", path: "/v1/guestPayments/charges", query: { reservationId: RID, limit: 100 } }, { signal: sig() }), "QUERY_SCOPE"],
    ["charge other amount", () => w.createOfflineCharge({ method: "POST", path: `/v1/guestPayments/charges/${RID}`, query: {}, body: { title: offlineChargeTitle(INTENT), amount: 500.01, paymentMethod: "credit_card", status: "paid", scheduledDate: "2026-12-04 10:00:00" } }, { signal: sig() }), "BODY_SCOPE"],
    ["charge other method", () => w.createOfflineCharge({ method: "POST", path: `/v1/guestPayments/charges/${RID}`, query: {}, body: { title: offlineChargeTitle(INTENT), amount: 500, paymentMethod: "other", status: "paid", scheduledDate: "2026-12-04 10:00:00" } }, { signal: sig() }), "BODY_SCOPE"],
    ["charge extra field", () => w.createOfflineCharge({ method: "POST", path: `/v1/guestPayments/charges/${RID}`, query: {}, body: { title: offlineChargeTitle(INTENT), amount: 500, paymentMethod: "credit_card", status: "paid", scheduledDate: "2026-12-04 10:00:00", currency: "USD" } }, { signal: sig() }), "BODY_SCOPE"],
    ["charge other reservation", () => w.createOfflineCharge({ method: "POST", path: "/v1/guestPayments/charges/6100002", query: {}, body: {} }, { signal: sig() }), "PATH"]
  ];
  for (const [label, fn, code] of cases) await refusedZero(fn, sp, code, label);
});

test("path bypasses: absolute URLs, double prefix, traversal, encoded separators, query / fragment in the path → refused, zero calls", async () => {
  const sp = spies(); const c = make("capture", sp);
  for (const path of [`https://api.hostaway.com/v1/reservations/${RID}`, `//evil.example/v1/reservations/${RID}`, `/v1/v1/reservations/${RID}`, `/reservations/${RID}/../6100002`,
    `/reservations/..%2F6100002`, `/reservations%2F${RID}`, `/reservations/${RID}?x=1`, `/reservations/${RID}#f`, ` /reservations/${RID}`, `/RESERVATIONS/${RID}`, `/reservations/0${RID}`]) {
    await refusedZero(() => c.retrieveReservation({ method: "GET", path, query: {} }, { signal: sig() }), sp, "PATH", path);
  }
});

test("bindings: protected ids, pilots (603564 never; 603566 only the explicit MXN exception, never recording), malformed values → BINDING_INVALID", () => {
  const sp = spies();
  const fail = (phase, b, label) => { const r = createPhaseExecutors({ phase, binding: b, hostaway: sp.hostaway, ...(phase === "capture" || phase === "cleanup" ? { stripe: sp.stripe } : {}) });
    assert.deepEqual({ ...r }, { ok: false, code: "BINDING_INVALID" }, label); };
  for (const id of ["70636076", "71045356", "71072615", "71081885"]) { fail("capture", { ...B.capture(), reservationId: id }, `protected ${id}`); fail("recording", { ...B.recording(), reservationId: id }, `protected ${id}`); }
  fail("reservation", { ...B.reservation(), listingId: 603564 }, "pilot 603564");
  fail("reservation", { ...B.reservation(), listingId: 603564, pilotException: PILOT_EXCEPTION }, "603564 never");
  fail("reservation", { ...B.reservation(), listingId: 603566, currency: "MXN" }, "603566 without the exception");
  fail("reservation", { ...B.reservation(), listingId: 603566, currency: "USD", pilotException: PILOT_EXCEPTION }, "603566 exception is MXN only");
  fail("recording", { ...B.recording(), listingId: 603566, pilotException: PILOT_EXCEPTION }, "recording never on the pilot (USD-only)");
  fail("reservation", { ...B.reservation(), pilotException: PILOT_EXCEPTION }, "exception flag on a non-pilot");
  assert.equal(createPhaseExecutors({ phase: "reservation", binding: { ...B.reservation(), listingId: 603566, currency: "MXN", pilotException: PILOT_EXCEPTION }, hostaway: sp.hostaway }).ok, true,
    "the one branded E4 form (mirrors connectedTestAdapterConfig)");
  assert.deepEqual([...connectedTestAdapterConfig().allowedListingIds, connectedTestAdapterConfig().currency], [603566, "MXN"]);
  fail("reservation", { ...B.reservation(), reservationId: RID }, "creation factory never has a bound id");
  for (const [ph, over] of [["reservation", { totalMinor: 0 }], ["reservation", { arrivalDate: OUT }], ["reservation", { ref: "XX" }], ["reservation", { guest: { ...GUEST, extra: 1 } }],
    ["capture", { accountId: "acct" }], ["capture", { paymentIntentId: "ch_1" }], ["capture", { reservationId: null }], ["capture", { captureIdempotencyKey: "a b" }],
    ["cleanup", { voidIdempotencyKey: "" }], ["recording", { paymentMethod: "cash" }], ["recording", { intentId: "X" }], ["recording", { amountMinor: 1.5 }],
    ["recording", { extra: 1 }]]) fail(ph, { ...B[ph](), ...over }, `${ph} ${JSON.stringify(over)}`);
  for (const [ph, k] of [["capture", "amountMinor"], ["recording", "accountRef"]]) { const b = B[ph](); delete b[k]; fail(ph, b, `${ph} missing ${k}`); }
  assert.deepEqual(BINDING_KEYS.capture, [...BINDING_KEYS.capture].sort());
});

test("descriptor / mutation probes (R-G1 lessons): factory options and every call argument; no getter / iterator runs; zero calls", async () => {
  let runs = 0;
  const sp = spies();
  const opt = (over) => ({ phase: "capture", binding: B.capture(), hostaway: sp.hostaway, stripe: sp.stripe, ...over });
  const proto = (o) => Object.defineProperty(o, "__proto__", { enumerable: true, value: { x: 1 } });
  const getter = (o, k, v) => Object.defineProperty(o, k, { enumerable: true, get() { runs += 1; return v; } });
  const revoked = (t) => { const r = Proxy.revocable(t, {}); r.revoke(); return r.proxy; };
  const throwing = (t) => new Proxy(t, { ownKeys() { throw new Error("hostile"); } });
  const bad = [undefined, null, [], proto(opt({})), getter(opt({}), "phase", "capture"), opt({ extra: 1 }), revoked(opt({})), throwing(opt({})),
    opt({ binding: proto(B.capture()) }), opt({ binding: getter(B.capture(), "listingId", L) }), opt({ binding: revoked(B.capture()) }), opt({ binding: throwing(B.capture()) }),
    opt({ hostaway: { send: sp.hostaway.send, extra: 1 } }), opt({ hostaway: getter({}, "send", sp.hostaway.send) }), opt({ hostaway: revoked({ send: () => {} }) }),
    opt({ stripe: undefined }), opt({ hostaway: { send: "x" } }), opt({ phase: "other" }),
    { phase: "reservation", binding: B.reservation(), hostaway: sp.hostaway, stripe: sp.stripe }];
  for (const o of bad) {
    let r; assert.doesNotThrow(() => { r = createPhaseExecutors(o); });
    assert.equal(r.ok, false); assert.ok(["OPTIONS_INVALID", "BINDING_INVALID", "TRANSPORT_INVALID", "PHASE_INVALID"].includes(r.code), r.code);
  }
  // binding is a frozen copy: caller mutation after the factory changes nothing
  const b = B.capture(); const ex = make("capture", sp, b);
  b.reservationId = "6100002"; b.amountMinor = 1;
  await ex.retrieveReservation({ method: "GET", path: `/reservations/${RID}`, query: {} }, { signal: sig() });
  assert.equal(sp.h.at(-1).req.path, `/v1/reservations/${RID}`);
  // call arguments: accessor / __proto__ / proxies / iterator tricks → refused before invocation
  const c = make("capture", sp);
  const reqOk = () => ({ method: "GET", path: `/reservations/${RID}`, query: {} });
  const expandIter = () => { const a = ["latest_charge"]; a[Symbol.iterator] = function* () { runs += 1; yield "x"; }; return a; };
  const argCases = [
    () => c.retrieveReservation(getter(reqOk(), "path", `/reservations/${RID}`), { signal: sig() }),
    () => c.retrieveReservation(proto(reqOk()), { signal: sig() }),
    () => c.retrieveReservation(revoked(reqOk()), { signal: sig() }),
    () => c.retrieveReservation(throwing(reqOk()), { signal: sig() }),
    () => c.retrieveReservation({ ...reqOk(), query: getter({}, "a", 1) }, { signal: sig() }),
    () => c.retrieveReservation(reqOk(), getter({}, "signal", sig())),
    () => c.retrieveReservation(reqOk(), revoked({ signal: sig() })),
    () => c.retrievePaymentIntent(PI, { expand: expandIter() }, { signal: sig() }),
    () => c.retrievePaymentIntent(PI, Object.assign(Object.create({ expand: ["latest_charge"] })), { signal: sig() }),
    () => c.capturePaymentIntent(PI, { amount_to_capture: 50000, final_capture: true, expand: [, "latest_charge"] }, { idempotencyKey: `cap:${INTENT}:${PI}`, signal: sig() }),   // eslint-disable-line no-sparse-arrays
    () => c.retrieveReservation({ ...reqOk(), extra: 1 }, { signal: sig() }),
    () => c.retrieveReservation(reqOk(), { signal: sig(), extra: 1 })];
  for (const [i, fn] of argCases.entries()) await refusedZero(fn, sp, undefined, `arg case ${i}`);
  assert.equal(runs, 0, "no getter / iterator ran");
});

test("signals: missing / non-AbortSignal / already-aborted → refused before invocation", async () => {
  const sp = spies(); const c = make("capture", sp);
  const ac = new AbortController(); ac.abort();
  await refusedZero(() => c.retrieveAccount({ signal: ac.signal }), sp, "ABORTED", "aborted");
  await refusedZero(() => c.retrieveAccount({}), sp, "SIGNAL_REQUIRED", "missing");
  await refusedZero(() => c.retrieveAccount({ signal: { aborted: false } }), sp, "SIGNAL_REQUIRED", "fake signal");
  await refusedZero(() => c.retrieveAccount(undefined), sp, "OPTIONS_INVALID", "no options");
});

test("transport outcomes: throw / reject → code-only TRANSPORT_FAILED (nothing leaked); bad envelope → TRANSPORT_REPLY_SHAPE; 404 / 429 / 5xx passed through unchanged; one invocation, no retry", async () => {
  const secret = "sk_test_SHOULD_NEVER_APPEAR guest.adapter@mv-test.invalid";
  for (const reply of [() => { throw new Error(secret); }, () => Promise.reject(Object.assign(new Error(secret), { body: secret }))]) {
    const sp = spies({ reply, sreply: reply }); const c = make("capture", sp);
    for (const fn of [() => c.retrieveReservation({ method: "GET", path: `/reservations/${RID}`, query: {} }, { signal: sig() }), () => c.retrieveAccount({ signal: sig() })]) {
      const e = await fn().then(() => null, (x) => x);
      assert.ok(e instanceof ExecutorTransportFailure && e.code === "TRANSPORT_FAILED");
      assert.ok(!JSON.stringify({ m: e.message, s: String(e), k: Object.keys(e) }).includes("SHOULD_NEVER"), "no message / body / credential leak");
    }
    assert.equal(sp.h.length, 1); assert.equal(sp.s.length, 1, "exactly one invocation each, never retried");
  }
  for (const bad of [null, "x", { httpStatus: "200", json: {} }, { httpStatus: 200 }, { httpStatus: 200, json: {}, extra: 1 }, { status: 200, json: {} }, { httpStatus: 99, json: {} }]) {
    const sp = spies({ reply: () => bad });
    const e = await make("capture", sp).retrieveReservation({ method: "GET", path: `/reservations/${RID}`, query: {} }, { signal: sig() }).then(() => null, (x) => x);
    assert.ok(e instanceof ExecutorTransportFailure && e.code === "TRANSPORT_REPLY_SHAPE", JSON.stringify(bad));
    assert.equal(sp.h.length, 1);
  }
  for (const status of [404, 429, 500, 503, 201]) {
    const json = { status: "fail", detail: "x" };
    const sp = spies({ reply: () => ({ httpStatus: status, json }) });
    const out = await make("capture", sp).retrieveReservation({ method: "GET", path: `/reservations/${RID}`, query: {} }, { signal: sig() });
    assert.equal(out.httpStatus, status); assert.equal(out.json, json, "provider facts untouched");
    const sp2 = spies({ reply: () => ({ httpStatus: status, json }) });
    assert.equal((await make("reservation", sp2).pricing.get(`/listings/${L}`, { signal: sig() })).status, status, "pricing keeps the status");
  }
  // an ambiguous WRITE (create) is never turned into a definite failure: the reply envelope is returned as is
  const sp3 = spies({ reply: () => ({ httpStatus: 500, json: null }) });
  const plan = { ref: REF, listingId: L, arrivalDate: IN, departureDate: OUT, guests: 2, totalMinor: 50000, currency: "USD", guest: { ...GUEST } };
  const reply = await make("reservation", sp3).createReservation(buildCreateReservationRequest(plan, CFG), { signal: sig() });
  assert.notEqual(classifyCreateResponse(reply, plan, CFG).outcome, "refused", "the accepted classifier decides; never a definite refusal");
});

test("compatibility with accepted pure helpers: priceStay, lookupByRef, buildCreateReservationRequest → classifyCreateResponse through the adapters", async () => {
  const days = (from, to) => { const out = []; for (let d = from; d <= to; d = new Date(Date.parse(`${d}T00:00:00Z`) + 86400000).toISOString().slice(0, 10))
    out.push({ date: d, status: "available", isAvailable: 1, minimumStay: 1, maximumStay: 90, closedOnArrival: 0, closedOnDeparture: 0 }); return out; };
  const created = { id: Number(RID), listingMapId: L, channelId: 2000, arrivalDate: IN, departureDate: OUT, totalPrice: 500, currency: "USD", status: "new",
    customFieldValues: [{ customFieldId: 777016, value: REF }] };
  const world = (req) => {
    if (req.method === "GET" && req.path === `/v1/listings/${L}`) return { httpStatus: 200, json: { result: { id: L, currencyCode: "USD", personCapacity: 4, minNights: 1, maxNights: 90 } } };
    if (req.method === "GET" && req.path === `/v1/listings/${L}/calendar`) return { httpStatus: 200, json: { result: days(req.query.startDate, req.query.endDate) } };
    if (req.method === "POST" && req.path.endsWith("/priceDetails")) return { httpStatus: 200, json: { status: "success", result: { totalPrice: 500,
      components: [{ id: 1, type: "accommodation", name: "baseRate", title: "Base rate", quantity: 1, value: 250, total: 500, isIncludedInTotalPrice: 1, isMandatory: 1, isOverriddenByUser: 0, isDeleted: 0, units: 2 }] } } };
    if (req.method === "POST" && req.path === "/v1/reservations") return { httpStatus: 201, json: { status: "success", result: created } };
    if (req.method === "GET" && req.path === "/v1/reservations") return { httpStatus: 200, json: { status: "success", result: req.query.afterId ? [] : [created] } };
    return { httpStatus: 404, json: { status: "fail" } };
  };
  const sp = spies({ reply: world });
  const r = make("reservation", sp);
  const policy = readDirectPolicyFromEnv({ VERCEL_ENV: "development" }).policy;
  const now = Date.parse("2026-11-04T12:00:00Z");
  const client = { get: (p, o = {}) => r.pricing.get(p, { ...o, signal: sig() }), post: (p, b, o = {}) => r.pricing.post(p, b, { ...o, signal: sig() }) };   // = boundedPricing
  const priced = await priceStay({ request: { listingId: L, from: IN, to: OUT, guests: 2 }, listingConfig: { currency: "USD" }, client, policy, today: todayInTimeZone(undefined, new Date(now)), now });
  assert.equal(priced.ok, true, priced.error);
  const plan = { ref: REF, listingId: L, arrivalDate: IN, departureDate: OUT, guests: 2, totalMinor: 50000, currency: "USD", guest: { ...GUEST } };
  const reply = await r.createReservation(buildCreateReservationRequest(plan, CFG), { signal: sig() });
  assert.equal(classifyCreateResponse(reply, plan, CFG).outcome, "created");
  const lk = await lookupByRef({ ref: REF, listingId: L, arrivalDate: IN, departureDate: OUT }, CFG, (req) => r.lookupPage(req, { signal: sig() }));
  assert.equal(lk.outcome, "found");
  assert.ok(sp.h.every((x) => /^\/v1\//.test(x.req.path)));
  assert.equal(netAttempts, 0);
});

test("cleanup factory without a bound reservation (reservation_failed: authorization void only): void maps; host cancel / id reads refuse, zero calls", async () => {
  const sp = spies(); const k = make("cleanup", sp, { ...B.cleanup(), reservationId: null });
  await k.cancelPaymentIntent(PI, {}, { idempotencyKey: `void:${INTENT}:${PI}`, signal: sig() });
  assert.equal(sp.s.length, 1);
  await refusedZero(() => k.cancelReservation({ method: "PUT", path: `/v1/reservations/${RID}/statuses/cancelled`, query: {}, body: { cancelledBy: "host" } }, { signal: sig() }), sp, "RESERVATION_UNBOUND", "cancel unbound");
  await refusedZero(() => k.retrieveReservation({ method: "GET", path: `/reservations/${RID}`, query: {} }, { signal: sig() }), sp, "RESERVATION_UNBOUND", "read unbound");
});

test("local adapter constants equal the pure Hostaway adapter's exports (no import there: its importer set is pinned by accepted containment tests)", () => {
  for (const k of ["DIRECT_CHANNEL_ID", "LOOKUP_PAGE_LIMIT", "CONNECTED_TEST_LISTING_ID", "CONNECTED_TEST_CURRENCY"]) assert.equal(AD[k], HR[k], k);
  assert.deepEqual([...AD.FORBIDDEN_PILOT_LISTING_IDS], [...HR.FORBIDDEN_PILOT_LISTING_IDS]);
  assert.equal(String(AD.REF_RE), String(HR.REF_RE));
  for (const d of ["2026-12-04", "2026-02-29", "2028-02-29", "1999-12-31", "2101-01-01", "2026-13-01", "2026-1-01", "x", null, 20261204, "2026-12-04T00:00"]) {
    assert.equal(AD.isRealDate(d), HR.isRealDate(d), String(d));
  }
  const src = readFileSync(new URL("../scripts/e7-connected/executor-adapters.mjs", import.meta.url), "utf8");
  for (const re of [/hostaway-reservations/, /connectedTestAdapterConfig/, /from\s+["'][^"']*lib\/hostaway\.js["']/, /\bfetch\s*\(/, /process\./, /from\s+["']stripe["']/, /node:(https?|net|fs|child_process)/]) {
    assert.doesNotMatch(src, re, String(re));
  }
});

// ---------------------------------------------------------------------------------------------
// R-A1 (root CODE HOLD on 2aeac7e1): reservation by-id RECOVERY factory

const recoveryBinding = (rid = RID) => ({ ...B.reservation(), reservationId: rid });
const byIdRequest = (id) => Object.freeze({ method: "GET", path: `/reservations/${id}`, query: {} });   // = reservation-worker.js:237 (pinned in test 2)

test("R-A1: the id-bound reservation-recovery factory is accepted by the real reservation gate; maps the accepted by-id request once", async () => {
  const sp = spies();
  const r = createPhaseExecutors({ phase: "reservation-recovery", binding: recoveryBinding(), hostaway: sp.hostaway });
  assert.equal(r.ok, true, `recovery factory: ${r.code}`);
  assert.deepEqual(Object.keys(r.executors).sort(), [...PHASE_KEYS.reservation].sort());
  const g = reservationWorkerGate({ env: ENV, adapterConfig: CFG, listings: new Map([[L, { currency: "USD" }]]), executors: r.executors, clock: Date.now });
  assert.equal(g.ok, true, g.code);
  await r.executors.retrieveReservation(byIdRequest(RID), { signal: sig() });
  assert.equal(sp.h.length, 1);
  assert.deepEqual(plainJSON(sp.h[0].req), { method: "GET", path: `/v1/reservations/${RID}`, query: {} });
  // the unbound creation factory is unchanged: by-id still refuses, create still maps
  const sp2 = spies(); const c = make("reservation", sp2);
  await refusedZero(() => c.retrieveReservation(byIdRequest(RID), { signal: sig() }), sp2, "RESERVATION_UNBOUND", "creation factory by-id");
  const plan = { ref: REF, listingId: L, arrivalDate: IN, departureDate: OUT, guests: 2, totalMinor: 50000, currency: "USD", guest: { ...GUEST } };
  await c.createReservation(buildCreateReservationRequest(plan, CFG), { signal: sig() });
  assert.equal(sp2.h.length, 1);
});

test("R-A1: recovery mode refuses every create, other / protected ids, and an unbound or malformed recovery binding (zero calls)", async () => {
  const sp = spies();
  const r = createPhaseExecutors({ phase: "reservation-recovery", binding: recoveryBinding(), hostaway: sp.hostaway });
  assert.equal(r.ok, true, r.code);
  const plan = { ref: REF, listingId: L, arrivalDate: IN, departureDate: OUT, guests: 2, totalMinor: 50000, currency: "USD", guest: { ...GUEST } };
  await refusedZero(() => r.executors.createReservation(buildCreateReservationRequest(plan, CFG), { signal: sig() }), sp, "RECOVERY_MODE_NO_CREATE", "create in recovery");
  await refusedZero(() => r.executors.createReservation(undefined, undefined), sp, "RECOVERY_MODE_NO_CREATE", "any create in recovery");
  await refusedZero(() => r.executors.retrieveReservation(byIdRequest("6100002"), { signal: sig() }), sp, "PATH", "other id");
  for (const id of ["70636076", "71045356", "71072615", "71081885"]) {
    await refusedZero(() => r.executors.retrieveReservation(byIdRequest(id), { signal: sig() }), sp, "PATH", `protected ${id} via request`);
    assert.deepEqual({ ...createPhaseExecutors({ phase: "reservation-recovery", binding: recoveryBinding(id), hostaway: sp.hostaway }) }, { ok: false, code: "BINDING_INVALID" }, `protected ${id} binding`);
  }
  for (const bad of [null, "0", "abc", 6100001, "61000011234567890"]) {
    assert.deepEqual({ ...createPhaseExecutors({ phase: "reservation-recovery", binding: recoveryBinding(bad), hostaway: sp.hostaway }) }, { ok: false, code: "BINDING_INVALID" }, String(bad));
  }
  assert.equal(createPhaseExecutors({ phase: "reservation-recovery", binding: { ...recoveryBinding(), listingId: 603564, pilotException: PILOT_EXCEPTION }, hostaway: sp.hostaway }).ok, false);
});

test("R-A1: a missing-ref-echo create reply → assessRefNotEchoed candidate → recovery factory bound to it → by-id read normalises to the same identity", async () => {
  const plan = { ref: REF, listingId: L, arrivalDate: IN, departureDate: OUT, guests: 2, totalMinor: 50000, currency: "USD", guest: { ...GUEST } };
  const noEcho = { id: Number(RID), listingMapId: L, channelId: 2000, arrivalDate: IN, departureDate: OUT, totalPrice: 500, currency: "USD", status: "new", customFieldValues: [] };
  const create = await make("reservation", spies({ reply: () => ({ httpStatus: 201, json: { status: "success", result: noEcho } }) }))
    .createReservation(buildCreateReservationRequest(plan, CFG), { signal: sig() });
  const gap = assessRefNotEchoed(create, plan, CFG);
  assert.equal(gap.eligible, true, gap.code);                                 // the worker's CREATE_REF_NOT_ECHOED:READS_REQUIRED path
  assert.equal(String(gap.reservationId), RID);
  // the later runner binds THIS persisted candidate (create op result_ref / the queued by-id read's payload), never a raw reply alone
  const sp = spies({ reply: () => ({ httpStatus: 200, json: { status: "success", result: { ...noEcho, customFieldValues: [{ customFieldId: 777016, value: REF }] } } }) });
  const r = createPhaseExecutors({ phase: "reservation-recovery", binding: recoveryBinding(String(gap.reservationId)), hostaway: sp.hostaway });
  assert.equal(r.ok, true, r.code);
  const reply = await r.executors.retrieveReservation(byIdRequest(String(gap.reservationId)), { signal: sig() });
  const env = unwrapEnvelope(reply.json); assert.equal(env.ok, true);
  const n = normalizeReservation(env.result, CFG);
  assert.equal(n.ok, true, n.code);
  assert.deepEqual([String(n.reservation.reservationId), n.reservation.bookingRef, n.reservation.listingId, n.reservation.from, n.reservation.to], [RID, REF, L, IN, OUT]);
  assert.equal(sp.h.length, 1, "one by-id read");
});

// ---------------------------------------------------------------------------------------------
// R-A2 (root CODE HOLD on 2aeac7e1): native branded signal inspection

test("R-A2: hostile signals — own aborted getter / data shadow, prototype fake, proxies, revoked — refused with zero caller getter runs and zero calls; no raw error", async () => {
  let runs = 0;
  const sp = spies(); const c = make("capture", sp);
  const shadowGetter = () => { const s = new AbortController().signal; Object.defineProperty(s, "aborted", { get() { runs += 1; return false; } }); return s; };
  const abortedShadow = () => { const ac = new AbortController(); ac.abort(); Object.defineProperty(ac.signal, "aborted", { value: false }); return ac.signal; };
  const throwingGetter = () => { const ac = new AbortController(); ac.abort(); Object.defineProperty(ac.signal, "aborted", { get() { runs += 1; throw new Error("hostile"); } }); return ac.signal; };
  const fake = () => Object.create(AbortSignal.prototype);
  const proxied = () => new Proxy(new AbortController().signal, {});
  const revoked = () => { const r = Proxy.revocable(new AbortController().signal, {}); r.revoke(); return r.proxy; };
  // a genuine signal with an own (non-aborted) getter is still GENUINE and live: the native getter ignores the shadow → mapped, getter not run
  await c.retrieveAccount({ signal: shadowGetter() });
  assert.equal(sp.s.length, 1, "genuine live signal dispatched"); assert.equal(runs, 0, "own aborted getter never ran");
  for (const [label, mk, code] of [["aborted + false data shadow", abortedShadow, "ABORTED"], ["aborted + throwing getter", throwingGetter, "ABORTED"],
    ["prototype fake", fake, "SIGNAL_REQUIRED"], ["proxy", proxied, "SIGNAL_REQUIRED"], ["revoked proxy", revoked, "SIGNAL_REQUIRED"],
    ["plain object", () => ({ aborted: false }), "SIGNAL_REQUIRED"], ["function", () => () => {}, "SIGNAL_REQUIRED"]]) {
    const e = await c.retrieveAccount({ signal: mk() }).then(() => null, (x) => x);
    assert.ok(e instanceof ExecutorRefusal && e.code === code, `${label}: ${e && (e.code || e.name)}`);
  }
  assert.equal(sp.s.length, 1, "no hostile signal reached the transport"); assert.equal(runs, 0, "no caller getter ran");
  // ordinary controls
  const ac = new AbortController(); ac.abort();
  await refusedZero(() => c.retrieveAccount({ signal: ac.signal }), sp, "ABORTED", "ordinary aborted");
  const live = new AbortController().signal;
  await c.retrieveAccount({ signal: live });
  assert.equal(sp.s.at(-1).x.signal, live, "the original genuine signal is passed through");
});

test("R-A2: a signal aborted DURING argument introspection (proxy trap) is re-checked natively right before the invocation → refused, zero calls", async () => {
  const sp = spies(); const c = make("capture", sp); const k = make("cleanup", sp);
  const mk = () => {
    const ac = new AbortController();
    const req = new Proxy({ method: "GET", path: `/reservations/${RID}`, query: {} }, { ownKeys(t) { ac.abort(); return Reflect.ownKeys(t); } });
    return { ac, req };
  };
  const a = mk();
  await refusedZero(() => c.retrieveReservation(a.req, { signal: a.ac.signal }), sp, "ABORTED", "hostaway");
  const ac2 = new AbortController();
  const params = new Proxy({ expand: ["latest_charge"] }, { ownKeys(t) { ac2.abort(); return Reflect.ownKeys(t); } });
  await refusedZero(() => c.retrievePaymentIntent(PI, params, { signal: ac2.signal }), sp, "ABORTED", "stripe");
  const ac3 = new AbortController();
  const body = new Proxy({ cancelledBy: "host" }, { ownKeys(t) { ac3.abort(); return Reflect.ownKeys(t); } });
  await refusedZero(() => k.cancelReservation({ method: "PUT", path: `/v1/reservations/${RID}/statuses/cancelled`, query: {}, body }, { signal: ac3.signal }), sp, "ABORTED", "write");
});
