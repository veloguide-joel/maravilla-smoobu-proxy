// E7 checkout TEST release — guest Checkout (HTTP intent API) -> verified mock webhook -> step:"release" (REQUEST only) ->
// the ACCEPTED, UNCHANGED compensation worker -> authorization_released, on a throwaway local PostgreSQL.
// LABELS: every Stripe / Hostaway object is an in-memory FAKE built here (no network, SDK client, key or credential; fake key-shaped
// strings come from test/e5a-fixtures.mjs). Webhook events reach processVerifiedStripeEvent as if Stripe's signature check passed
// (covered offline in test/e5a-webhook-http.test.mjs). Runtime code runs as the app role; nothing tampers rows, triggers or fences.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import pg from "pg";
import { startMigratedDatabase } from "./harness.mjs";
import { createIntentApiHandler } from "../../lib/checkout/intent-api-http.js";
import { processVerifiedStripeEvent } from "../../lib/checkout/stripe-test-webhook.js";
import { loadIntent, applyEvent, requestTestRelease } from "../../lib/booking-db/repo.js";
import { requestRead } from "../../lib/booking-db/operations.js";
import { runCleanupStep } from "../../lib/booking-db/compensation-worker.js";
import { _internal as RW, WORK_STATES as RESERVATION_WORK_STATES } from "../../lib/booking-db/reservation-worker.js";
import { validateAdapterConfig } from "../../lib/hostaway-reservations.js";
import { ENV_OK } from "../e5a-fixtures.mjs";
import { addDays } from "../../lib/bookability.js";

let netAttempts = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { netAttempts += 1; throw new Error("network refused"); };

let db, pool2;
before(async () => { db = await startMigratedDatabase(); pool2 = new pg.Pool({ connectionString: db.appUrl(), max: 4 }); });
after(async () => { globalThis.fetch = realFetch; await pool2.end(); await db.close(); assert.equal(netAttempts, 0); });

const LISTING = 606998;
const ORIGIN = "https://preview.example.invalid";
const ENV = Object.freeze({ ...ENV_OK, MV_CHECKOUT_TEST_API: "enabled", MV_CHECKOUT_ALLOWED_ORIGIN: ORIGIN, MV_CHECKOUT_TEST_LISTINGS: `${LISTING}:USD`,
  MV_RATE_LIMIT_SALT: "s".repeat(40), MV_CHECKOUT_TERMS_VERSION: "terms-2026-11", MV_CHECKOUT_TEST_RELEASE: "enabled" });
const ENV_K = Object.freeze({ VERCEL_ENV: "development", MV_E7_COMPENSATION_WORKER: "enabled" });
const ACCT = ENV.STRIPE_TEST_ACCOUNT_ID;
const NOW0 = Date.UTC(2026, 10, 2, 20, 0, 0);
const MIN = 60 * 1000; const DAY = 24 * 60 * MIN;
const TZ = "America/Mazatlan";
const GUEST = { firstName: "Zanabria", lastName: "Quintessa", email: "zq.release.guest@example.test" };
const clone = (o) => JSON.parse(JSON.stringify(o));
const sec = (ms) => Math.floor(ms / 1000);
let seq = 0;

// ---------- one fake provider world per booking (Stripe TEST account + Hostaway pricing / cleanup keys) ----------
function world() {
  const w = { calls: [], writes: { cancelPaymentIntent: 0, hostaway: 0 }, sessions: new Map(), pis: new Map() };
  const strip = (s) => { const { _pim, ...r } = s; return clone(r); };
  const piView = (p) => clone(p);
  w.stripe = {
    accounts: { retrieve: async () => { w.calls.push("sdk:account"); return { object: "account", id: ACCT }; } },
    checkout: { sessions: {
      create: async (params, opts) => {
        w.calls.push("sdk:session.create");
        const id = `cs_test_R${++seq}`; const pd = params.line_items[0].price_data;
        const s = { object: "checkout.session", id, livemode: false, mode: "payment", status: "open", payment_status: "unpaid", amount_total: pd.unit_amount, currency: pd.currency,
          client_reference_id: params.client_reference_id, metadata: { ...params.metadata }, expires_at: params.expires_at, url: `https://checkout.stripe.com/c/pay/${id}`,
          payment_intent: null, customer_details: null, _pim: params.payment_intent_data, _opts: opts };
        w.sessions.set(id, s); return strip(s);
      },
      retrieve: async (id) => { w.calls.push("sdk:session.retrieve"); return strip(w.sessions.get(id)); } } },
    paymentIntents: { retrieve: async (id, opts) => { w.calls.push("sdk:pi.retrieve"); assert.deepEqual(opts, { expand: ["latest_charge"] }); return piView(w.pis.get(id)); } }
  };
  w.hostaway = {
    get: async (path, opts = {}) => {
      w.calls.push(`hostaway GET ${path}`);
      const m = /^\/listings\/(\d+)(\/calendar)?$/.exec(path);
      if (!m[2]) return { status: 200, json: { result: { id: Number(m[1]), currencyCode: "USD", personCapacity: 4, minNights: 1, maxNights: 90 } } };
      const out = []; for (let d = opts.query.startDate; d <= opts.query.endDate; d = addDays(d, 1)) out.push({ date: d, status: "available", isAvailable: 1, minimumStay: 1, maximumStay: 90, closedOnArrival: 0, closedOnDeparture: 0 });
      return { status: 200, json: { result: out } };
    },
    post: async (path, body) => {
      w.calls.push(`hostaway POST ${path}`);
      const nights = Math.round((Date.parse(body.endingDate) - Date.parse(body.startingDate)) / DAY);
      const comps = [{ id: 1, type: "accommodation", name: "baseRate", title: "Base rate", quantity: 1, value: 125, total: 125 * nights, isIncludedInTotalPrice: 1, isMandatory: 1, isOverriddenByUser: 0, isDeleted: 0, units: nights }];
      return { status: 200, json: { status: "success", result: { totalPrice: comps[0].total, components: comps } } };
    }
  };
  /** The guest completes Checkout: Stripe authorizes (manual capture). */
  w.pay = (sessionId, authAtMs) => {
    const s = w.sessions.get(sessionId); const piId = `pi_R${++seq}`;
    s.status = "complete"; s.payment_intent = piId; s.customer_details = { email: "guest@example.invalid", name: "Guest Person" };
    w.pis.set(piId, { object: "payment_intent", id: piId, livemode: false, status: "requires_capture", capture_method: s._pim.capture_method, amount: s.amount_total,
      amount_capturable: s.amount_total, amount_received: 0, currency: s.currency, metadata: { ...s._pim.metadata },
      latest_charge: { object: "charge", id: `ch_R${seq}`, livemode: false, payment_intent: piId, captured: false, amount: s.amount_total, amount_captured: 0, amount_refunded: 0,
        currency: s.currency, status: "succeeded", paid: true, created: sec(authAtMs), payment_method_details: { type: "card", card: { capture_before: sec(authAtMs + 7 * DAY), last4: "4242" } } } });
    return piId;
  };
  w.event = (sessionId, t) => ({ id: `evt_R${++seq}`, object: "event", type: "checkout.session.completed", livemode: false, created: sec(t), api_version: "2026-01-28.clover",
    data: { object: strip(w.sessions.get(sessionId)) } });
  // the accepted cleanup worker's exact executor keys: Stripe calls act on the SAME PaymentIntent; Hostaway keys must never be called
  const hostawayNever = (k) => async () => { w.calls.push(`exec:${k}`); w.writes.hostaway += 1; throw new Error(`${k} must not be called`); };
  w.cleanup = {
    retrieveAccount: async () => { w.calls.push("exec:retrieveAccount"); return { object: "account", id: ACCT }; },
    retrievePaymentIntent: async (id, params) => { w.calls.push("exec:retrievePaymentIntent"); assert.deepEqual(params, { expand: ["latest_charge"] }); return piView(w.pis.get(id)); },
    cancelPaymentIntent: async (id, params, opts) => {
      w.calls.push("exec:cancelPaymentIntent"); w.writes.cancelPaymentIntent += 1; w.voidKeys = [...(w.voidKeys || []), opts && opts.idempotencyKey];
      assert.deepEqual(params, {});
      const p = w.pis.get(id); p.status = "canceled"; p.amount_capturable = 0;
      // accepted fixture assumption (e74a default): the canceled charge keeps amount_refunded 0. R-REFUND (a real cancel MAY report the
      // released amount as refunded) is UNVERIFIED; `w.refundOnCancel` models it and the accepted strict proof then refuses (test below).
      if (w.refundOnCancel) p.latest_charge.amount_refunded = p.amount;
      return piView(p);
    },
    retrieveReservation: hostawayNever("retrieveReservation"), lookupPage: hostawayNever("lookupPage"), cancelReservation: hostawayNever("cancelReservation")
  };
  return w;
}

function handlers(w, { env = ENV, clock } = {}) {
  const deps = {
    createPool: () => db.app, loadCore: async () => import("../../lib/checkout/intent-api-core.js"), loadAccess: async () => import("../../lib/booking-db/intent-access.js"),
    createStripe: () => w.stripe, createHostaway: () => w.hostaway,
    loadStripe: async () => { throw new Error("SDK must not load"); }, loadHostaway: async () => { throw new Error("real Hostaway must not load"); },
    now: () => clock.now, log: () => {}, onError: (e) => { throw e; }
  };
  return { intents: createIntentApiHandler({ route: "intents", env, deps }), step: createIntentApiHandler({ route: "step", env, deps }) };
}
function call(handler, { method = "POST", body, token } = {}) {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const req = Readable.from(raw ? [Buffer.from(raw)] : []);
  req.method = method; req.url = "/api/checkout/x";
  req.headers = { origin: ORIGIN, ...(method === "POST" ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) };
  const res = { statusCode: 0, headers: {}, body: null, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { this.body = b ? JSON.parse(b) : null; } };
  return handler(req, res).then(() => res);
}
const q = async (sql, p = []) => (await db.app.query(sql, p)).rows;
const ops = (id) => q("SELECT op_type, state, dispatched_at FROM booking.external_operations WHERE intent_id = $1 ORDER BY created_at, id", [id]);
const opsOf = async (id, t) => (await ops(id)).filter((o) => o.op_type === t);
const claim = async (id) => (await q("SELECT released_at FROM booking.inventory_claims WHERE intent_id = $1", [id]))[0];
const transitions = async (id, t) => Number((await q("SELECT count(*) AS n FROM booking.intent_transitions WHERE intent_id = $1 AND event_type = $2", [id, t]))[0].n);
const idOfToken = async (token) => (await import("../../lib/booking-db/intent-access.js")).findIntentIdByTokenHash(db.app, (await import("../../lib/checkout/intent-api-http.js")).hashToken(token));
let stayN = 0;

/** HTTP create -> details -> pay; then (unless pending) the guest pays and the verified completed webhook authorizes. */
async function booking({ authorize = true } = {}) {
  const w = world(); const clock = { now: NOW0 }; const h = handlers(w, { clock });
  const from = addDays("2027-09-01", 4 * stayN++);
  const c = await call(h.intents, { body: { listingId: LISTING, from, to: addDays(from, 3), guests: 2 } });
  assert.equal(c.statusCode, 201, JSON.stringify(c.body));
  const token = c.body.token; const id = await idOfToken(token);
  clock.now += 1000;
  assert.equal((await call(h.step, { body: { step: "details", ...GUEST, termsVersion: "terms-2026-11" }, token })).statusCode, 200);
  clock.now += 1000;
  const p = await call(h.step, { body: { step: "pay" }, token });
  assert.equal(p.statusCode, 200, JSON.stringify(p.body));
  const sessionId = [...w.sessions.keys()][0];
  let piId = null;
  if (authorize) {
    clock.now = NOW0 + 4 * MIN;
    piId = w.pay(sessionId, clock.now - 30 * 1000);
    const r = await processVerifiedStripeEvent(db.app, w.event(sessionId, clock.now), { stripe: w.stripe, now: clock.now, accountId: ACCT, accountCache: {} });
    assert.deepEqual(r, { http: 200, code: "APPLIED", state: "payment_authorized" });
  }
  return { w, h, clock, token, id, sessionId, piId };
}
const cleanup = (b, t) => runCleanupStep(db.app, { workerId: "rel-cln", env: ENV_K,
  adapterConfig: validateAdapterConfig({ allowedListingIds: [LISTING], refFieldId: 777011, channelId: 2000, currency: "USD" }),
  listings: new Map([[LISTING, { currency: "USD", timeZone: TZ }]]), executors: b.w.cleanup, clock: () => t, stripeAccountId: ACCT, intentId: b.id });

// =====================================================================================================================
test("happy chain: Checkout -> verified webhook -> release REQUEST (one queued void, zero provider calls, claim held) -> UNCHANGED compensation worker -> authorization_released", async () => {
  const b = await booking();
  assert.equal((await call(b.h.intents, { method: "GET", token: b.token })).body.status, "processing");
  const callsBefore = b.w.calls.length;
  b.clock.now = NOW0 + 6 * MIN;
  const r = await call(b.h.step, { body: { step: "release" }, token: b.token });
  assert.deepEqual([r.statusCode, r.body], [202, { status: "release_requested", release: "REQUESTED" }], "a request, never 'released'");
  assert.equal(b.w.calls.length, callsBefore, "the request makes ZERO provider calls");
  const i = await loadIntent(db.app, b.id);
  assert.deepEqual([i.status, i.reasonCode], ["reservation_failed", "TEST_RELEASE_REQUESTED"]);
  const voids = await opsOf(b.id, "stripe.void_payment_intent");
  assert.deepEqual(voids.map((o) => [o.state, o.dispatched_at]), [["pending", null]], "exactly one queued, unsent void");
  assert.equal(await claim(b.id).then((c) => c.released_at), null, "claim held until a verified release");
  assert.deepEqual((await ops(b.id)).filter((o) => o.op_type.startsWith("hostaway.")), []);
  // replay: idempotent, no second void
  const again = await call(b.h.step, { body: { step: "release" }, token: b.token });
  assert.deepEqual([again.statusCode, again.body.status], [202, "release_requested"]);
  assert.equal((await opsOf(b.id, "stripe.void_payment_intent")).length, 1);
  assert.equal(await transitions(b.id, "TEST_RELEASE_REQUESTED"), 1);
  // the reservation worker can no longer claim it (not a reservation work state)
  assert.equal(await RW.claimWork(db.app, { workerId: "res-x", now: NOW0 + 7 * MIN, leaseMs: 60000, states: [...RESERVATION_WORK_STATES], intentId: b.id, listingIds: [LISTING] }), null);
  // the accepted compensation worker performs + proves the void
  const s = await cleanup(b, NOW0 + 8 * MIN);
  assert.equal(s.status, "worked", JSON.stringify(s));
  assert.equal((await loadIntent(db.app, b.id)).status, "authorization_released", JSON.stringify(s.actions));
  assert.equal(b.w.writes.cancelPaymentIntent, 1); assert.equal(b.w.writes.hostaway, 0);
  assert.deepEqual(b.w.calls.filter((c) => c.startsWith("exec:")), ["exec:retrieveAccount", "exec:retrievePaymentIntent", "exec:cancelPaymentIntent", "exec:retrievePaymentIntent"]);
  assert.deepEqual(b.w.voidKeys, [`void:${b.id}:${b.piId}`]);
  assert.deepEqual((await opsOf(b.id, "stripe.void_payment_intent")).map((o) => o.state), ["succeeded"]);
  assert.notEqual((await claim(b.id)).released_at, null, "claim released only after the verified void");
  assert.equal((await call(b.h.intents, { method: "GET", token: b.token })).body.status, "unavailable_not_charged");
  // late same-PI completed webhook: duplicate, nothing queued
  const nonRead = async () => (await ops(b.id)).filter((o) => !o.op_type.startsWith("stripe.retrieve_")).map((o) => `${o.op_type}:${o.state}`);
  const before = await nonRead();
  const late = await processVerifiedStripeEvent(db.app, b.w.event(b.sessionId, NOW0 + 9 * MIN), { stripe: b.w.stripe, now: NOW0 + 9 * MIN, accountId: ACCT, accountCache: {} });
  // EXISTING webhook binding (unchanged): after the void, its fresh PaymentIntent read shows "canceled", so it refuses BEFORE E3
  // (503 AUTHORIZATION_CANCELED, retryable) — no state change, nothing queued. A same-PI completion that is read while the PI is still
  // authorized resolves as an E3 DUPLICATE (race test below). Residual: Stripe would redeliver this event until it gives up.
  assert.deepEqual([late.http, late.code], [503, "AUTHORIZATION_CANCELED"]);
  assert.equal((await loadIntent(db.app, b.id)).status, "authorization_released");
  assert.deepEqual(await nonRead(), before, "the late webhook queues nothing but its own verified reads");
  assert.equal((await opsOf(b.id, "stripe.void_payment_intent")).length, 1);
  // a further release request after the release: duplicate, still one void, idle worker
  assert.equal((await call(b.h.step, { body: { step: "release" }, token: b.token })).statusCode, 202);
  assert.equal((await opsOf(b.id, "stripe.void_payment_intent")).length, 1);
  assert.equal((await cleanup(b, NOW0 + 10 * MIN)).status, "idle");
});

test("release before authorization: 409 NOT_AUTHORIZED_YET, nothing fabricated; the later webhook authorizes normally; flag off -> UNKNOWN_STEP before any mutation", async () => {
  const b = await booking({ authorize: false });
  const v0 = (await loadIntent(db.app, b.id)).version;
  const r = await call(b.h.step, { body: { step: "release" }, token: b.token });
  assert.deepEqual([r.statusCode, r.body.code], [409, "NOT_AUTHORIZED_YET"]);
  const i = await loadIntent(db.app, b.id);
  assert.deepEqual([i.status, i.version, i.payment], ["payment_pending", v0, null]);
  assert.deepEqual(await opsOf(b.id, "stripe.void_payment_intent"), []);
  b.clock.now = NOW0 + 4 * MIN;
  b.w.pay(b.sessionId, b.clock.now - 30000);
  assert.equal((await processVerifiedStripeEvent(db.app, b.w.event(b.sessionId, b.clock.now), { stripe: b.w.stripe, now: b.clock.now, accountId: ACCT, accountCache: {} })).state, "payment_authorized");
  // the same deployment WITHOUT the release flag: the step does not exist; the authorized intent is untouched
  const off = handlers(b.w, { env: { ...ENV, MV_CHECKOUT_TEST_RELEASE: "disabled" }, clock: b.clock });
  const o = await call(off.step, { body: { step: "release" }, token: b.token });
  assert.deepEqual([o.statusCode, o.body.code], [400, "UNKNOWN_STEP"]);
  assert.equal((await loadIntent(db.app, b.id)).status, "payment_authorized");
  assert.deepEqual(await opsOf(b.id, "stripe.void_payment_intent"), []);
});

test("in-transaction DB guards: acquired work lease, unresolved provider operation, reservation history -> refused, zero void rows; guards read INSIDE the locked transaction", async () => {
  // (a) the reservation worker acquired the work lease first
  const a = await booking();
  const got = await RW.claimWork(db.app, { workerId: "res-1", now: NOW0 + 5 * MIN, leaseMs: 60000, states: [...RESERVATION_WORK_STATES], intentId: a.id, listingIds: [LISTING] });
  assert.equal(got, a.id);
  assert.deepEqual(await requestTestRelease(db.app, a.id, { now: NOW0 + 5 * MIN }), { ok: false, error: "TEST_RELEASE_WORK_LEASE_HELD" });
  assert.equal((await loadIntent(db.app, a.id)).status, "payment_authorized");
  assert.deepEqual(await opsOf(a.id, "stripe.void_payment_intent"), []);
  await RW.releaseWork({ pool: db.app, workerId: "res-1", clock: () => NOW0 + 5 * MIN }, a.id, 0);
  F_ok(await requestTestRelease(db.app, a.id, { now: NOW0 + 6 * MIN }), "released lease -> request allowed");
  // (b) an unresolved provider operation for the intent (a queued, unsettled PaymentIntent read)
  const b = await booking();
  await requestRead(db.app, b.id, "stripe.retrieve_payment_intent", b.piId, { now: NOW0 + 5 * MIN });
  assert.deepEqual(await requestTestRelease(db.app, b.id, { now: NOW0 + 6 * MIN }), { ok: false, error: "TEST_RELEASE_OPERATION_HISTORY" });
  assert.deepEqual(await opsOf(b.id, "stripe.void_payment_intent"), []);
  // (c) a reservation attempt that was started and recovered back to payment_authorized (history persisted): refused
  const c = await booking();
  F_ok(await applyEvent(db.app, c.id, { type: "RESERVATION_STARTED", workerId: "w1", recheck: { bookable: true, priceSame: true } }, { now: NOW0 + 5 * MIN, actor: "worker", workerId: "w1" }));
  F_ok(await applyEvent(db.app, c.id, { type: "RECOVER_INTERRUPTED", id: "rec-1" }, { now: NOW0 + 9 * MIN, actor: "reconciler" }));
  assert.equal((await loadIntent(db.app, c.id)).status, "payment_authorized");
  const rc = await requestTestRelease(db.app, c.id, { now: NOW0 + 10 * MIN });
  assert.equal(rc.ok, false); assert.equal(rc.error, "TEST_RELEASE_HISTORY");
  assert.deepEqual(await opsOf(c.id, "stripe.void_payment_intent"), []);
});

test("races (barriers): release vs work acquisition, release vs reservation start (both orders), release vs a late completed webhook", async () => {
  // (1) work acquisition attempted while the release transaction holds its locks: the claim skips the row; after commit nothing to claim
  const a = await booking();
  let during = "unset";
  F_ok(await requestTestRelease(db.app, a.id, { now: NOW0 + 6 * MIN, hooks: { beforeCommit: async () => {
    during = await RW.claimWork(pool2, { workerId: "res-race", now: NOW0 + 6 * MIN, leaseMs: 60000, states: [...RESERVATION_WORK_STATES], intentId: a.id, listingIds: [LISTING] });
  } } }));
  assert.equal(during, null, "the row is share-locked by the release: SKIP LOCKED claim gets nothing");
  assert.equal(await RW.claimWork(pool2, { workerId: "res-race", now: NOW0 + 7 * MIN, leaseMs: 60000, states: [...RESERVATION_WORK_STATES], intentId: a.id, listingIds: [LISTING] }), null);
  // (2) reservation start commits after the release loaded the intent: the release loses the version race and is refused (no void)
  const b = await booking();
  let once = false;
  const rb = await requestTestRelease(db.app, b.id, { now: NOW0 + 6 * MIN, hooks: { afterLoad: async () => {
    if (once) return; once = true;
    F_ok(await applyEvent(pool2, b.id, { type: "RESERVATION_STARTED", workerId: "w1", recheck: { bookable: true, priceSame: true } }, { now: NOW0 + 6 * MIN, actor: "worker", workerId: "w1" }));
  } } });
  assert.deepEqual([rb.ok, rb.error], [false, "ILLEGAL_TRANSITION"]);
  assert.equal((await loadIntent(db.app, b.id)).status, "reservation_pending");
  assert.deepEqual(await opsOf(b.id, "stripe.void_payment_intent"), []);
  // (3) reverse order: release first, then a reservation start is refused (no Hostaway effect is ever queued)
  const c = await booking();
  F_ok(await requestTestRelease(db.app, c.id, { now: NOW0 + 6 * MIN }));
  const rs = await applyEvent(db.app, c.id, { type: "RESERVATION_STARTED", workerId: "w1", recheck: { bookable: true, priceSame: true } }, { now: NOW0 + 7 * MIN, actor: "worker", workerId: "w1" });
  assert.deepEqual([rs.ok, rs.error], [false, "ILLEGAL_TRANSITION"]);
  assert.deepEqual((await ops(c.id)).filter((o) => o.op_type.startsWith("hostaway.")), []);
  // (4) a late completed webhook for the same session delivered while the release transaction is open: duplicate either way
  const d = await booking();
  let wh = null;
  F_ok(await requestTestRelease(db.app, d.id, { now: NOW0 + 6 * MIN, hooks: { beforeCommit: async () => {
    wh = processVerifiedStripeEvent(pool2, d.w.event(d.sessionId, NOW0 + 6 * MIN), { stripe: d.w.stripe, now: NOW0 + 6 * MIN, accountId: ACCT, accountCache: {} });
    await new Promise((r) => setTimeout(r, 50));
  } } }));
  const lr = await wh;
  assert.deepEqual([lr.http, lr.code], [200, "DUPLICATE"]);
  assert.equal((await loadIntent(db.app, d.id)).status, "reservation_failed");
  assert.equal((await opsOf(d.id, "stripe.void_payment_intent")).length, 1);
  assert.equal(await transitions(d.id, "PAYMENT_AUTHORIZED"), 1);
});

function F_ok(r, msg) { assert.equal(r && r.ok, true, `${msg || ""} ${JSON.stringify(r && (r.error || r))}`); return r; }

test("R-REFUND residual (accepted strict proof, unchanged): if the canceled charge reports the released amount as refunded, the release is NOT claimed — owner case, claim held", async () => {
  const b = await booking();
  b.w.refundOnCancel = true;
  F_ok(await requestTestRelease(db.app, b.id, { now: NOW0 + 6 * MIN }));
  let t = NOW0 + 8 * MIN;
  for (let k = 0; k < 12 && !["authorization_released", "reconciliation_required"].includes((await loadIntent(db.app, b.id)).status); k++) { await cleanup(b, t); t += MIN; }
  const i = await loadIntent(db.app, b.id);
  assert.deepEqual([i.status, i.reasonCode], ["reconciliation_required", "VOID_PROOF_NOT_STRICT"]);
  assert.equal(b.w.writes.cancelPaymentIntent, 1, "one void, never resent"); assert.equal(b.w.writes.hostaway, 0);
  assert.equal((await claim(b.id)).released_at, null, "an unproven release never frees the dates");
});
