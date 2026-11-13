// C1 (2026-11-13) — capture compatibility regression: the REAL accepted capture chain (runCaptureStep → createPhaseExecutors(capture) →
// createE7StripeTestSend) against a FAKE Stripe exchange that behaves like the live TEST account did on 2026-11-13 (req_29dKSmY0uOuX26):
// any capture body carrying `final_capture` is rejected with the observed 400 invalid_request_error; a body with exactly
// `amount_to_capture=<full>&expand[]=latest_charge` is captured.
//
// LABELS
//   * REAL: disposable schema-0021 PostgreSQL (harness), the accepted repo seed path (USD intent on 606998 → PAYMENT_AUTHORIZED →
//     RESERVATION_SUCCEEDED, as in test/e7-hosted-capture.test.mjs), the accepted capture worker, executor adapters and Slice T Stripe /
//     Hostaway transports — unchanged except for the C1 fix under test. No worker / adapter / transport replaced or patched.
//   * FAKE: the HTTP exchange only (`{ status, contentType, bytes }` replies), synthetic credentials, synthetic Stripe-Version pin.
//   * NETWORK GUARD: https.request / https.Agent / fetch refuse; asserted zero at the end.
//   * The OLD wire form is replayed here only as BYTES (the historical body string) through the same fake to show it is the shape Stripe
//     refused; the old code path no longer exists in this tree, so "old chain fails" is shown by (a) the regression fake rejecting those
//     bytes and (b) the validator / adapter / transport refusing any request that still carries final_capture.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { startMigratedDatabase } from "./harness.mjs";
import * as F from "./fixtures.mjs";
import * as R from "../../lib/booking-db/repo.js";
import * as O from "../../lib/booking-db/operations.js";
import { runCaptureStep } from "../../lib/booking-db/capture-worker.js";
import { validateAdapterConfig } from "../../lib/hostaway-reservations.js";
import { validateCaptureRequest } from "../../lib/checkout/capture-proof.js";
import { captureKey } from "../../lib/checkout/intent-state.js";
import { priceStay } from "../../lib/checkout/server-pricer.js";
import { readDirectPolicyFromEnv } from "../../lib/direct-policy.js";
import { todayInTimeZone } from "../../lib/public-api.js";
import { createPhaseExecutors } from "../../scripts/e7-connected/executor-adapters.mjs";
import { createE7HostawaySend, createE7StripeTestSend } from "../../scripts/e7-connected/http-transports.mjs";

const GUARD = { request: 0, Agent: 0, fetch: 0 };
https.request = () => { GUARD.request += 1; throw new Error("network refused"); };
https.Agent = class { constructor() { GUARD.Agent += 1; throw new Error("network refused"); } };
globalThis.fetch = async () => { GUARD.fetch += 1; throw new Error("network refused"); };
syncBuiltinESMExports();

let db;
before(async () => { db = await startMigratedDatabase(); });
after(async () => { await db.close(); assert.deepEqual(GUARD, { request: 0, Agent: 0, fetch: 0 }, "no network"); });

const enc = (o) => new TextEncoder().encode(JSON.stringify(o));
const MINUTE = 60000; const DAY = 86400000;
const LIST = 606998; const ACCT = "acct_1TyHE42B9LTneQgw"; const REF_FIELD = 105433; const SVERSION = "2026-01-28.clover";
const SKEY = "sk_test_C1RegressionSyntheticKey000000"; const HTOKEN = "synthetic-hostaway-token";
const ENV = Object.freeze({ VERCEL_ENV: "development", MV_E7_CAPTURE_WORKER: "enabled" });
const POLICY = readDirectPolicyFromEnv({ VERCEL_ENV: "development", MV_E7_RESERVATION_WORKER: "enabled" }).policy;
const NIGHTLY = 1400;
/** the exact Stripe error observed live on 2026-11-13 for a body that carried final_capture (req_29dKSmY0uOuX26) */
const OBSERVED_400 = Object.freeze({ error: { type: "invalid_request_error", message: "PaymentIntent does not support multi-capture; cannot pass final_capture parameter.", param: "final_capture" } });
const OLD_BODY = (amt) => `amount_to_capture=${amt}&final_capture=true&expand%5B%5D=latest_charge`;   // the historical wire form (rejected)
const NEW_BODY = (amt) => `amount_to_capture=${amt}&expand%5B%5D=latest_charge`;                        // C1 wire form (accepted)

const dayRows = (from, to) => { const out = []; for (let d = from; d <= to; d = F.addDays(d, 1)) out.push({ date: d, status: "available", isAvailable: 1, minimumStay: 1, maximumStay: 90, closedOnArrival: 0, closedOnDeparture: 0 }); return out; };
const pricing = {
  get: async (path, opts = {}) => { const m = /^\/listings\/(\d+)(\/calendar)?$/.exec(path); if (!m[2]) return { status: 200, json: { result: { id: Number(m[1]), currencyCode: "USD", personCapacity: 4, minNights: 1, maxNights: 90 } } };
    return { status: 200, json: { result: dayRows(opts.query.startDate, opts.query.endDate) } }; },
  post: async (path, body) => { const nights = Math.round((Date.parse(body.endingDate) - Date.parse(body.startingDate)) / DAY);
    return { status: 200, json: { status: "success", result: { totalPrice: NIGHTLY * nights, components: [{ id: 1, type: "accommodation", name: "baseRate", title: "Base rate", quantity: 1, value: NIGHTLY, total: NIGHTLY * nights, isIncludedInTotalPrice: 1, isMandatory: 1, isOverriddenByUser: 0, isDeleted: 0, units: nights }] } } }; }
};

let k = 0;
/** accepted seed path → reservation_confirmed with the capture op queued pristine (same construction as the Slice 2 hosted I-test) */
async function confirmedIntent() {
  k += 1;
  const stay = { listingId: LIST, from: F.addDays("2027-05-01", 3 * k), to: F.addDays("2027-05-01", 3 * k + 1), guests: 1 };
  const base = Date.now() - 10 * MINUTE;
  const priced = await priceStay({ request: { ...stay }, listingConfig: { currency: "USD" }, client: pricing, policy: POLICY, today: todayInTimeZone(undefined, new Date(base)), now: base });
  assert.ok(priced.ok, priced.error);
  const intent = await R.createIntentRecord(db.app, { ref: F.nextRef(), accessTokenHash: F.tokenHash(), environment: "test", now: base, ...stay });
  F.ok(await R.applyEvent(db.app, intent.id, { type: "PRICE_CONFIRMED", price: priced.price }, { now: base, actor: "guest" }));
  F.ok(await R.collectGuestDetails(db.app, intent.id, F.GUEST, { now: base + 1000, termsVersion: "terms-2026-10" }));
  const b = F.ok(await R.beginPayStep(db.app, intent.id, { now: base + 2000 }));
  const pop = await O.claimNextOperation(db.app, { workerId: "w-pay", now: base + 2000, intentId: intent.id, opTypes: ["stripe.create_checkout_session"] });
  const sessionId = `cs_test_c1${String(k).padStart(6, "0")}`;
  F.ok(await O.completeOperation(db.app, pop.id, { workerId: "w-pay", now: base + 2000, outcome: { status: "succeeded", resultRef: sessionId } }));
  F.ok(await R.recordCheckoutSession(db.app, intent.id, b.attempt.id, { sessionId, expiresAt: base + 30 * MINUTE, now: base + 2000 }));
  const piId = `pi_C1REG${String(k).padStart(9, "0")}`;
  const captureBefore = Math.floor((base + 7 * DAY) / 1000) * 1000;
  F.ok(await R.applyEvent(db.app, intent.id, { type: "PAYMENT_AUTHORIZED", id: `evt_auth_${piId}`, paymentIntentId: piId, sessionId, amountMinor: priced.price.finalTotalMinor,
    currency: "usd", livemode: false, authorizationCreatedAt: base + 3000, captureBefore }, { now: base + 4000, actor: "webhook" }));
  const t6 = base + 5000, t7 = base + 6000;
  F.ok(await R.applyEvent(db.app, intent.id, { type: "RESERVATION_STARTED", workerId: "w1", recheck: { bookable: true, priceSame: true } }, { now: t6, actor: "worker", workerId: "w1" }));
  F.ok(await R.applyEvent(db.app, intent.id, { type: "RESERVATION_DISPATCHED", workerId: "w1" }, { now: t6, actor: "worker", workerId: "w1" }));
  const rid = 71700000 + k;
  const cop = await F.claimOp(db.app, intent.id, "hostaway.create_reservation", t6);
  const i0 = await R.loadIntent(db.app, intent.id);
  const reservation = { reservationId: rid, listingId: LIST, from: stay.from, to: stay.to, totalMinor: i0.price.finalTotalMinor, currency: "USD", bookingRef: null };
  await R.recordHostawayCreateResult(db.app, intent.id, { httpStatus: 201, reservation }, { now: t7 });
  F.ok(await O.completeOperation(db.app, cop.id, { workerId: "w1", now: t7, outcome: { status: "succeeded", resultRef: rid } }));
  F.ok(await R.applyEvent(db.app, intent.id, { type: "RESERVATION_SUCCEEDED", reservation }, { now: t7, actor: "worker" }));
  const i = await R.loadIntent(db.app, intent.id);
  assert.equal(i.status, "reservation_confirmed");
  const pa = (await db.app.query("SELECT id::text AS id FROM booking.payment_attempts WHERE intent_id = $1 AND status = 'completed'", [intent.id])).rows[0].id;
  return { id: intent.id, piId, attemptId: pa, stay, ref: i.ref, intent: i, total: i.price.finalTotalMinor, rid: String(rid), captureBefore, chargeId: `ch_C1REG${String(k).padStart(9, "0")}` };
}

/** the FAKE Stripe + Hostaway exchange: Stripe rejects final_capture exactly as observed live; everything else is a faithful TEST world */
function world(a, { captureMode = "ok" } = {}) {
  const w = { stripeLog: [], bodies: [], captured: false, mode: captureMode };
  const reply = (status, x) => Promise.resolve({ status, contentType: "application/json", bytes: enc(x) });
  const pi = () => ({ object: "payment_intent", id: a.piId, livemode: false, status: w.captured ? "succeeded" : "requires_capture", capture_method: "manual", amount: a.total,
    amount_received: w.captured ? a.total : 0, amount_capturable: w.captured ? 0 : a.total, currency: "usd", metadata: { mv_intent_id: a.id, mv_payment_attempt_id: a.attemptId },
    latest_charge: { object: "charge", id: a.chargeId, payment_intent: a.piId, status: "succeeded", paid: true, captured: w.captured, amount: a.total, amount_captured: w.captured ? a.total : 0,
      amount_refunded: 0, refunded: false, disputed: false, currency: "usd", livemode: false, payment_method_details: { card: { capture_before: a.captureBefore / 1000 } } } });
  w.stripe = (req) => {
    const p = req.url.replace("https://api.stripe.com", ""); w.stripeLog.push(`${req.method} ${p}`);
    if (req.headers["Stripe-Version"] !== SVERSION || req.headers.Authorization !== `Bearer ${SKEY}`) return reply(401, { error: { type: "invalid_request_error", message: "bad auth" } });
    if (p === "/v1/account") return reply(200, { object: "account", id: ACCT });
    if (req.method === "GET" && p === `/v1/payment_intents/${a.piId}?expand%5B%5D=latest_charge`) return reply(200, pi());
    if (req.method === "POST" && p === `/v1/payment_intents/${a.piId}/capture`) {
      w.bodies.push({ body: req.body, headers: Object.keys(req.headers).sort(), key: req.headers["Idempotency-Key"], ct: req.headers["Content-Type"] });
      // THE REGRESSION: Stripe (non-multicapture PaymentIntent) rejects ANY body that carries final_capture — exactly as observed live
      if (/(^|&)final_capture=/.test(req.body)) return reply(400, OBSERVED_400);
      if (w.mode === "reject400") return reply(400, { error: { type: "invalid_request_error", message: "injected rejection (test)" } });
      if (w.mode === "lost") return Promise.reject(Object.assign(new Error("EXCHANGE_PREMATURE_CLOSE"), { code: "EXCHANGE_PREMATURE_CLOSE" }));
      if (req.body !== NEW_BODY(a.total)) return reply(400, { error: { type: "invalid_request_error", message: `unexpected body ${req.body}` } });
      w.captured = true; return reply(200, pi());
    }
    return reply(404, { error: { type: "invalid_request_error", message: `unexpected ${req.method} ${p}` } });
  };
  w.hostaway = (req) => {
    const u = new URL(req.url); const p = u.pathname.replace(/^\/v1/, "");
    if (req.method === "GET" && p === `/reservations/${a.rid}`) return reply(200, { status: "success", result: { id: Number(a.rid), listingMapId: LIST, channelId: 2000, arrivalDate: a.stay.from, departureDate: a.stay.to, totalPrice: a.total / 100, currency: "USD", status: "new", customFieldValues: [{ customFieldId: REF_FIELD, value: a.ref }] } });
    if (req.method === "GET" && p === "/reservations") return reply(200, { status: "success", result: [] });
    return reply(404, { status: "fail", message: `unexpected ${req.method} ${p}` });
  };
  return w;
}

/** the REAL chain: Slice T transports over the fake exchange → accepted executor adapters (capture binding) → accepted worker */
function realChain(a, w) {
  const stripe = createE7StripeTestSend({ exchange: w.stripe, credential: () => SKEY, accountId: ACCT, apiVersion: SVERSION });
  const hostaway = createE7HostawaySend({ exchange: w.hostaway, credential: () => HTOKEN });
  assert.equal(stripe.ok, true); assert.equal(hostaway.ok, true);
  const executors = createPhaseExecutors({ phase: "capture", binding: { listingId: LIST, arrivalDate: a.stay.from, departureDate: a.stay.to, ref: a.ref, reservationId: a.rid, accountId: ACCT,
    paymentIntentId: a.piId, amountMinor: a.total, captureIdempotencyKey: captureKey(a.id, a.piId) }, stripe: { send: stripe.transport.send }, hostaway: { send: hostaway.transport.send } });
  assert.equal(executors.ok, true, executors.code);
  const adapterConfig = validateAdapterConfig({ allowedListingIds: [LIST], refFieldId: REF_FIELD, channelId: 2000, currency: "USD" });
  return { stripe: stripe.transport, hostaway: hostaway.transport, executors: executors.executors, step: (clock = () => Date.now()) => runCaptureStep(db.app, { workerId: "c1-reg", env: ENV, adapterConfig, listings: new Map([[LIST, { currency: "USD" }]]), executors: executors.executors, clock, stripeAccountId: ACCT, intentId: a.id }) };
}
const codeIs = (code) => (e) => { assert.equal(e && e.code, code); return true; };
const opRow = async (id) => (await db.app.query("SELECT state, attempts, (dispatched_at IS NOT NULL) AS d, result_ref, error_code FROM booking.external_operations WHERE intent_id = $1 AND op_type = 'stripe.capture_payment_intent'", [id])).rows;

test("R1 RED (historical shape): the fake Stripe rejects the OLD wire body with the observed 400; the C1 validator / adapter / transport refuse any request that still carries final_capture", async () => {
  const a = await confirmedIntent(); const w = world(a);
  // (a) the exact historical bytes, replayed through the fake as the old transport would have sent them
  const old = await w.stripe({ method: "POST", url: `https://api.stripe.com/v1/payment_intents/${a.piId}/capture`, headers: { Authorization: `Bearer ${SKEY}`, "Stripe-Version": SVERSION, "Content-Type": "application/x-www-form-urlencoded", "Idempotency-Key": captureKey(a.id, a.piId) }, body: OLD_BODY(a.total), signal: null, maxBytes: 262144 });
  assert.equal(old.status, 400); assert.deepEqual(JSON.parse(new TextDecoder().decode(old.bytes)), OBSERVED_400); assert.equal(w.captured, false);
  // (b) the validator accepts exactly { amount_to_capture, expand } for this row and refuses final_capture in ANY form (builder covered in e73a)
  const op = (await db.app.query("SELECT * FROM booking.external_operations WHERE intent_id = $1 AND op_type = 'stripe.capture_payment_intent'", [a.id])).rows[0];
  const captureOp = { id: op.id, intentId: a.id, opType: op.op_type, state: op.state, attempts: op.attempts, dispatchedAt: op.dispatched_at, payload: op.payload };
  const good = { paymentIntentId: a.piId, params: { amount_to_capture: a.total, expand: ["latest_charge"] }, options: { idempotencyKey: op.payload.providerIdempotencyKey } };
  assert.equal(validateCaptureRequest(good, { intent: a.intent, captureOp }).ok, true);
  for (const v of [true, false, "true"]) assert.equal(validateCaptureRequest({ ...good, params: { ...good.params, final_capture: v } }, { intent: a.intent, captureOp }).code, "MULTICAPTURE_REFUSED", String(v));
  // (c) the adapter and the transport refuse it before any exchange
  const c = realChain(a, w);
  await assert.rejects(c.executors.capturePaymentIntent(a.piId, { amount_to_capture: a.total, final_capture: true, expand: ["latest_charge"] }, { idempotencyKey: captureKey(a.id, a.piId), signal: new AbortController().signal }), codeIs("PARAMS"));
  await assert.rejects(c.stripe.send({ op: "paymentIntents.capture", id: a.piId, params: { amount_to_capture: a.total, final_capture: true, expand: ["latest_charge"] }, idempotencyKey: captureKey(a.id, a.piId) }, { signal: new AbortController().signal }), codeIs("REQUEST_NOT_ALLOWED"));
  assert.deepEqual(w.bodies.length, 1, "only the replayed historical bytes reached the fake; the C1 chain sent nothing");
});

test("R2 GREEN: the REAL worker → adapter → transport chain emits exactly `amount_to_capture=<full>&expand[]=latest_charge` (no final_capture) with the accepted key / headers, Stripe accepts, payment_captured, ONE send", async () => {
  const a = await confirmedIntent(); const w = world(a); const c = realChain(a, w);
  const s = await c.step();
  assert.equal(s.status, "worked", JSON.stringify(s));
  const i = await R.loadIntent(db.app, a.id);
  assert.equal(i.status, "payment_captured");
  assert.deepEqual(w.bodies, [{ body: NEW_BODY(a.total), headers: ["Authorization", "Content-Type", "Idempotency-Key", "Stripe-Version"], key: `cap:${a.id}:${a.piId}`, ct: "application/x-www-form-urlencoded" }]);
  assert.ok(!/final_capture/.test(w.bodies[0].body), "C1: no final_capture on the wire");
  assert.equal(w.stripeLog.filter((x) => x.startsWith("POST")).length, 1, "ONE capture POST");
  assert.deepEqual((await opRow(a.id)).map((o) => [o.state, o.attempts, o.d, o.result_ref]), [["succeeded", 1, true, a.chargeId]]);
  assert.equal(i.payment.capturedMinor, a.total, "codec-owned captured amount == the stored full amount (strict, no fallback)");
  assert.equal((await db.app.query("SELECT captured_minor::text AS c FROM booking.intents WHERE id = $1", [a.id])).rows[0].c, String(a.total), "independent persistence proof: booking.intents.captured_minor");
});

test("R3 injected provider rejection (400 on a correct body): the worker persists outcome_unknown / capture_unknown, ONE send, and a further step never sends again", async () => {
  const a = await confirmedIntent(); const w = world(a, { captureMode: "reject400" }); const c = realChain(a, w);
  const s = await c.step();
  assert.ok(Array.isArray(s.actions) && s.actions.some((x) => /^CAPTURE_OUTCOME_UNKNOWN:CAPTURE_CALL_FAILED/.test(x)), JSON.stringify(s));
  assert.equal((await R.loadIntent(db.app, a.id)).status, "capture_unknown");
  assert.deepEqual((await opRow(a.id)).map((o) => [o.state, o.attempts, o.d, o.error_code]), [["outcome_unknown", 1, true, "CAPTURE_CALL_FAILED"]]);
  assert.equal(w.bodies.length, 1);
  w.mode = "ok";                                                           // even if Stripe would now accept, the worker must not resend
  const s2 = await c.step();
  assert.equal(w.bodies.length, 1, "never a second capture send: " + JSON.stringify(s2));
  assert.equal(w.captured, false);
});

test("R4 lost reply (exchange rejects before any response): outcome_unknown / capture_unknown, ONE send, no resend; wrong PI / amount / key refusals still hold", async () => {
  const a = await confirmedIntent(); const w = world(a, { captureMode: "lost" }); const c = realChain(a, w);
  const s = await c.step();
  assert.ok(s.actions.some((x) => /^CAPTURE_OUTCOME_UNKNOWN:CAPTURE_CALL_FAILED/.test(x)), JSON.stringify(s));
  assert.equal((await R.loadIntent(db.app, a.id)).status, "capture_unknown");
  assert.equal(w.bodies.length, 1); assert.equal(w.bodies[0].body, NEW_BODY(a.total));
  w.mode = "ok"; await c.step(); assert.equal(w.bodies.length, 1, "no resend after a lost reply");
  // scope refusals (adapter) and transport refusals are unchanged by C1
  const sig = () => new AbortController().signal; const key = captureKey(a.id, a.piId);
  await assert.rejects(c.executors.capturePaymentIntent("pi_other000000000000000", { amount_to_capture: a.total, expand: ["latest_charge"] }, { idempotencyKey: key, signal: sig() }), codeIs("PAYMENT_INTENT_SCOPE"));
  await assert.rejects(c.executors.capturePaymentIntent(a.piId, { amount_to_capture: a.total - 1, expand: ["latest_charge"] }, { idempotencyKey: key, signal: sig() }), codeIs("PARAMS"));
  await assert.rejects(c.executors.capturePaymentIntent(a.piId, { amount_to_capture: a.total, expand: ["latest_charge"] }, { idempotencyKey: `${key}:2`, signal: sig() }), codeIs("IDEMPOTENCY_KEY"));
  await assert.rejects(c.stripe.send({ op: "paymentIntents.capture", id: a.piId, params: { amount_to_capture: a.total, expand: ["latest_charge"], metadata: {} }, idempotencyKey: key }, { signal: sig() }), codeIs("REQUEST_NOT_ALLOWED"));
  assert.equal(w.bodies.length, 1, "refusals never reach the exchange");
});

test("R5 livemode refusal: a TEST transport that receives a livemode=true PaymentIntent reply refuses it (unchanged by C1)", async () => {
  const a = await confirmedIntent(); const w = world(a);
  const live = (req) => w.stripe(req).then((r) => { const o = JSON.parse(new TextDecoder().decode(r.bytes)); if (o.object === "payment_intent") o.livemode = true; return { ...r, bytes: enc(o) }; });
  const s = createE7StripeTestSend({ exchange: live, credential: () => SKEY, accountId: ACCT, apiVersion: SVERSION });
  await assert.rejects(s.transport.send({ op: "paymentIntents.capture", id: a.piId, params: { amount_to_capture: a.total, expand: ["latest_charge"] }, idempotencyKey: captureKey(a.id, a.piId) }, { signal: new AbortController().signal }), codeIs("LIVEMODE_REFUSED"));
});
