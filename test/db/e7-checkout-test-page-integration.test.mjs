// E7 checkout TEST page — INTEGRATED rehearsal: the page's own controller (public/checkout-test.js, unchanged) -> its own createApi ->
// a fetch adapter -> the REAL createIntentApiHandler + REAL intent-api-core + REAL repo on a disposable TEST-marked local PostgreSQL.
// LABELS
//   * FAKE externals only: Stripe (an in-memory TEST account: account, Checkout Session create/retrieve, PaymentIntent retrieve, and the
//     cleanup executors) and Hostaway pricing reads. No network, SDK client, key or credential (key-shaped strings: test/e5a-fixtures.mjs).
//   * The guest's Stripe Checkout is FAKE: the page's redirect is only recorded; the fake account then "authorizes" and the accepted verified
//     webhook ingress (processVerifiedStripeEvent, as if the signature passed) delivers checkout.session.completed.
//   * The fetch adapter is NOT a browser: it sets the Origin header itself. Browser-generated headers are evidenced separately (loopback run).
//   * Faults are injected ONLY at the reply boundary (the real handler runs; its reply is lost / replaced), never by replacing the core.
//   * The release void is performed by the ACCEPTED, unchanged runCleanupStep with fake Stripe executors. Nothing here proves connected behaviour.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { startMigratedDatabase } from "./harness.mjs";
import { createIntentApiHandler, hashToken } from "../../lib/checkout/intent-api-http.js";
import { processVerifiedStripeEvent } from "../../lib/checkout/stripe-test-webhook.js";
import { findIntentIdByTokenHash } from "../../lib/booking-db/intent-access.js";
import { loadIntent } from "../../lib/booking-db/repo.js";
import { runCleanupStep } from "../../lib/booking-db/compensation-worker.js";
import { validateAdapterConfig } from "../../lib/hostaway-reservations.js";
import { createApi, createController, createStore, STORE_KEY } from "../../public/checkout-test.js";
import { ENV_OK } from "../e5a-fixtures.mjs";
import { addDays } from "../../lib/bookability.js";

let netAttempts = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { netAttempts += 1; throw new Error("network refused"); };
let db;
before(async () => { db = await startMigratedDatabase(); });
after(async () => { globalThis.fetch = realFetch; await db.close(); assert.equal(netAttempts, 0, "no network from this process"); });

const LISTING = 606998;
const ORIGIN = "https://preview.example.invalid";
const TERMS = "terms-2026-11";
const ENV = Object.freeze({ ...ENV_OK, MV_CHECKOUT_TEST_API: "enabled", MV_CHECKOUT_ALLOWED_ORIGIN: ORIGIN, MV_CHECKOUT_TEST_LISTINGS: `${LISTING}:USD`,
  MV_RATE_LIMIT_SALT: "s".repeat(40), MV_CHECKOUT_TERMS_VERSION: TERMS, MV_CHECKOUT_TEST_RELEASE: "enabled" });
const ENV_K = Object.freeze({ VERCEL_ENV: "development", MV_E7_COMPENSATION_WORKER: "enabled" });
const ACCT = ENV.STRIPE_TEST_ACCOUNT_ID;
const NOW0 = Date.UTC(2026, 10, 2, 20, 0, 0);
const MIN = 60 * 1000; const DAY = 24 * 60 * MIN;
const clone = (o) => JSON.parse(JSON.stringify(o));
const sec = (ms) => Math.floor(ms / 1000);
let seq = 0;

// ---------- FAKE external world (Stripe TEST account + Hostaway pricing) ----------
function world() {
  const w = { calls: [], writes: { sessionCreate: 0, cancel: 0, hostaway: 0 }, sessions: new Map(), pis: new Map() };
  const strip = (s) => { const { _pim, ...r } = s; return clone(r); };
  w.stripe = {
    accounts: { retrieve: async () => { w.calls.push("account"); return { object: "account", id: ACCT }; } },
    checkout: { sessions: {
      create: async (params) => {
        w.calls.push("session.create"); w.writes.sessionCreate += 1;
        const id = `cs_test_I${++seq}`; const pd = params.line_items[0].price_data;
        const s = { object: "checkout.session", id, livemode: false, mode: "payment", status: "open", payment_status: "unpaid", amount_total: pd.unit_amount, currency: pd.currency,
          client_reference_id: params.client_reference_id, metadata: { ...params.metadata }, expires_at: params.expires_at, url: `https://checkout.stripe.com/c/pay/${id}`,
          payment_intent: null, customer_details: null, _pim: params.payment_intent_data };
        w.sessions.set(id, s); return strip(s);
      },
      retrieve: async (id) => { w.calls.push("session.retrieve"); return strip(w.sessions.get(id)); } } },
    paymentIntents: { retrieve: async (id) => { w.calls.push("pi.retrieve"); return clone(w.pis.get(id)); } }
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
  /** FAKE Stripe Checkout: the guest pays with a TEST card -> manual-capture authorization on the fake account */
  w.authorize = (sessionId, authAtMs) => {
    const s = w.sessions.get(sessionId); const piId = `pi_I${++seq}`;
    s.status = "complete"; s.payment_intent = piId; s.customer_details = { email: "guest@example.invalid", name: "Guest Person" };
    w.pis.set(piId, { object: "payment_intent", id: piId, livemode: false, status: "requires_capture", capture_method: s._pim.capture_method, amount: s.amount_total,
      amount_capturable: s.amount_total, amount_received: 0, currency: s.currency, metadata: { ...s._pim.metadata },
      latest_charge: { object: "charge", id: `ch_I${seq}`, livemode: false, payment_intent: piId, captured: false, amount: s.amount_total, amount_captured: 0, amount_refunded: 0,
        currency: s.currency, status: "succeeded", paid: true, created: sec(authAtMs), payment_method_details: { type: "card", card: { capture_before: sec(authAtMs + 7 * DAY) } } } });
    return piId;
  };
  w.event = (sessionId, t) => ({ id: `evt_I${++seq}`, object: "event", type: "checkout.session.completed", livemode: false, created: sec(t), api_version: "2026-01-28.clover",
    data: { object: strip(w.sessions.get(sessionId)) } });
  const never = (k) => async () => { w.calls.push(`exec:${k}`); w.writes.hostaway += 1; throw new Error(`${k} must not be called`); };
  w.cleanup = {
    retrieveAccount: async () => { w.calls.push("exec:account"); return { object: "account", id: ACCT }; },
    retrievePaymentIntent: async (id) => { w.calls.push("exec:pi"); return clone(w.pis.get(id)); },
    cancelPaymentIntent: async (id, params) => {
      w.calls.push("exec:cancel"); w.writes.cancel += 1; assert.deepEqual(params, {});
      const p = w.pis.get(id); p.status = "canceled"; p.amount_capturable = 0;   // accepted fixture assumption (R-REFUND unverified; not addressed here)
      return clone(p);
    },
    retrieveReservation: never("retrieveReservation"), lookupPage: never("lookupPage"), cancelReservation: never("cancelReservation")
  };
  return w;
}

// ---------- the REAL handler behind a fetch adapter (sets Origin itself: NOT browser evidence) ----------
function server(w, clock) {
  const deps = { createPool: () => db.app, createStripe: () => w.stripe, createHostaway: () => w.hostaway,
    loadStripe: async () => { throw new Error("SDK must not load"); }, loadHostaway: async () => { throw new Error("real Hostaway must not load"); },
    now: () => clock.now, log: () => {}, onError: (e) => { throw e; } };
  const routes = { "/api/checkout/intents": createIntentApiHandler({ route: "intents", env: ENV, deps }), "/api/checkout/intent-step": createIntentApiHandler({ route: "step", env: ENV, deps }) };
  const log = [];
  /** fault(path, body) -> null | "drop" (the real handler RAN, its reply is lost) | { status, body } (reply replaced after the real handler ran) */
  const fetchFn = (fault = () => null) => async (path, init) => {
    assert.equal(init.method, "POST"); assert.equal(init.credentials, "omit"); assert.equal(init.mode, "same-origin");
    const req = Readable.from([Buffer.from(init.body)]); req.method = "POST"; req.url = path;
    req.headers = { origin: ORIGIN, "content-type": init.headers["Content-Type"], ...(init.headers.Authorization ? { authorization: init.headers.Authorization } : {}) };
    const res = { statusCode: 0, headers: {}, raw: "", setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { this.raw = b || ""; } };
    await routes[path](req, res);
    const step = JSON.parse(init.body).step || "create";
    log.push(`${step}:${res.statusCode}`);
    const f = fault(path, JSON.parse(init.body));
    if (f === "drop") throw new TypeError("Failed to fetch (injected after the real handler ran)");
    if (f) return { status: f.status, json: async () => f.body };
    return { status: res.statusCode, json: async () => JSON.parse(res.raw) };
  };
  return { fetchFn, log };
}
function fakeTimers(clock) {
  const t = { q: [], setTimeout(fn, ms) { const id = Symbol("t"); t.q.push({ id, fn, at: clock.now + ms }); return id; },
    clearTimeout(id) { t.q = t.q.filter((x) => x.id !== id); },
    async tick() { const x = t.q.sort((a, b) => a.at - b.at).shift(); if (!x) return false; clock.now = Math.max(clock.now, x.at); await x.fn(); return true; } };
  return t;
}
function memStorage() { const m = new Map(); return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } }; }
/** one page load: the page's own controller + its own API client over the adapter */
function pageLoad({ srv, storage, clock, timers, search = "", fault }) {
  const views = []; const nav = { assigned: [], assign(u) { this.assigned.push(u); }, search: () => search, stripQuery() {} };
  const c = createController({ api: createApi(srv.fetchFn(fault)), store: createStore(storage), ui: { render: (v) => views.push(v) }, timers, nav,
    config: { listingId: LISTING, currency: "USD", termsVersion: TERMS }, now: () => clock.now });
  return { c, nav, last: () => views[views.length - 1] };
}
const q = async (sql, p = []) => (await db.app.query(sql, p)).rows;
const opsOf = (id, t) => q("SELECT state, dispatched_at FROM booking.external_operations WHERE intent_id = $1 AND op_type = $2 ORDER BY created_at, id", [id, t]);
const claim = async (id) => (await q("SELECT released_at FROM booking.inventory_claims WHERE intent_id = $1", [id]))[0];
const tokenOf = (storage) => JSON.parse(storage.m.get(STORE_KEY)).token;
const intentOf = async (storage) => findIntentIdByTokenHash(db.app, hashToken(tokenOf(storage)));
let stayN = 0;
const stay = () => { const from = addDays("2027-10-01", 5 * stayN++); return { from, to: addDays(from, 3), guests: 2 }; };
const GUEST = { firstName: "Zanabria", lastName: "Quintessa", email: "zq.integrated.guest@example.test", accepted: true };
const cleanup = (w, id, t) => runCleanupStep(db.app, { workerId: "int-cln", env: ENV_K,
  adapterConfig: validateAdapterConfig({ allowedListingIds: [LISTING], refFieldId: 777012, channelId: 2000, currency: "USD" }),
  listings: new Map([[LISTING, { currency: "USD", timeZone: "America/Mazatlan" }]]), executors: w.cleanup, clock: () => t, stripeAccountId: ACCT, intentId: id });

// =====================================================================================================================
test("one fresh intent through the page controller + REAL handler/core/repo/PG: create -> details (real awaiting_details) -> Pay -> verified webhook -> processing -> release queued -> accepted cleanup -> verified", async () => {
  const w = world(); const clock = { now: NOW0 }; const timers = fakeTimers(clock); const srv = server(w, clock); const storage = memStorage();
  // load 1: create + details
  let p = pageLoad({ srv, storage, clock, timers }); await p.c.init();
  assert.equal(p.last().screen, "create");
  await p.c.create(stay());
  assert.equal(p.last().screen, "details", JSON.stringify(p.c.state.notice));
  assert.equal(p.last().price.currency, "USD"); assert.equal(p.last().price.totalMinor, 33750, "server-priced: 3 nights x 125 USD (fake Hostaway) minus the accepted 10% direct discount");
  const id = await intentOf(storage);
  assert.equal((await loadIntent(db.app, id)).status, "price_confirmed");
  clock.now += 1000;
  await p.c.details(GUEST);
  assert.equal((await loadIntent(db.app, id)).status, "details_collected");
  assert.deepEqual(srv.log.slice(-1), ["details:200"]);
  assert.equal(p.c.state.last, "awaiting_details", "the REAL success reply keeps the public status awaiting_details");
  assert.deepEqual([p.last().screen, p.last().canPay], ["pay", true], "Pay is actually available after a real details success");
  assert.ok(!storage.m.get(STORE_KEY).includes("example.test"), "no guest data in session storage");
  // load 2: reload after details -> still pay (status read through the POST alias), nothing written
  p = pageLoad({ srv, storage, clock, timers }); await p.c.init();
  assert.deepEqual([p.last().screen, srv.log.slice(-1)[0]], ["pay", "status:200"]);
  clock.now += 1000;
  await p.c.pay();
  assert.equal(w.writes.sessionCreate, 1, "one fake Checkout session prepared");
  assert.equal(p.nav.assigned.length, 1); assert.match(p.nav.assigned[0], /^https:\/\/checkout\.stripe\.com\/c\/pay\/cs_test_I\d+$/);
  assert.equal((await loadIntent(db.app, id)).status, "payment_pending");
  // FAKE Stripe Checkout + accepted verified webhook ingress
  clock.now = NOW0 + 4 * MIN;
  const sessionId = [...w.sessions.keys()][0];
  const piId = w.authorize(sessionId, clock.now - 30000);
  assert.deepEqual(await processVerifiedStripeEvent(db.app, w.event(sessionId, clock.now), { stripe: w.stripe, now: clock.now, accountId: ACCT, accountCache: {} }),
    { http: 200, code: "APPLIED", state: "payment_authorized" });
  // load 3: Stripe return -> neutral processing
  p = pageLoad({ srv, storage, clock, timers, search: "?checkout=complete" }); await p.c.init();
  assert.deepEqual([p.last().screen, p.last().title], ["authorized", "Processing — not a booking"]);
  assert.equal(p.c.state.notice.code, "RETURNED_COMPLETE");
  // release request: queued, claim held, ZERO provider calls in the route
  const callsBefore = w.calls.length;
  clock.now = NOW0 + 6 * MIN;
  await p.c.release();
  assert.equal(w.calls.length, callsBefore, "the release route makes no provider call");
  assert.deepEqual([p.last().screen, p.c.state.notice.code], ["releaseQueued", "RELEASE_REQUESTED"]);
  assert.deepEqual((await loadIntent(db.app, id)).status, "reservation_failed");
  assert.deepEqual((await opsOf(id, "stripe.void_payment_intent")).map((o) => o.state), ["pending"]);
  assert.equal((await claim(id)).released_at, null, "claim held while only queued");
  // load 4: reload while queued -> still honestly queued (one automatic read)
  p = pageLoad({ srv, storage, clock, timers }); await p.c.init();
  assert.deepEqual([p.last().screen, p.c.state.polling], ["releaseQueued", true]);
  await timers.tick(); assert.equal(p.last().screen, "releaseQueued", "repeat status: still queued (no fabricated release)");
  // the ACCEPTED cleanup worker (separately run in a real setup) performs + proves the void
  const s = await cleanup(w, id, NOW0 + 8 * MIN);
  assert.equal(s.status, "worked");
  assert.equal((await loadIntent(db.app, id)).status, "authorization_released");
  await timers.tick();
  assert.deepEqual([p.last().screen, p.last().title, p.c.state.notice], ["released", "Release verified — not charged", null]);
  assert.equal(p.c.state.polling, false);
  // facts
  assert.notEqual((await claim(id)).released_at, null, "claim released only after the verified void");
  assert.deepEqual([w.writes.cancel, w.writes.hostaway, w.writes.sessionCreate], [1, 0, 1]);
  assert.deepEqual((await opsOf(id, "stripe.void_payment_intent")).map((o) => o.state), ["succeeded"]);
  assert.deepEqual((await q("SELECT op_type FROM booking.external_operations WHERE intent_id = $1 AND op_type LIKE 'hostaway.%'", [id])), []);
  const notify = await opsOf(id, "guest.notify");
  assert.ok(notify.every((n) => n.state === "pending" && n.dispatched_at === null), "guest notification queued, never executed");
  // late same-PI completed webhook after the void: the accepted 503 (canceled PI), nothing changes
  const late = await processVerifiedStripeEvent(db.app, w.event(sessionId, NOW0 + 9 * MIN), { stripe: w.stripe, now: NOW0 + 9 * MIN, accountId: ACCT, accountCache: {} });
  assert.deepEqual([late.http, late.code], [503, "AUTHORIZATION_CANCELED"]);
  await p.c.refresh();
  assert.deepEqual([p.last().screen, (await loadIntent(db.app, id)).status], ["released", "authorization_released"]);
  assert.ok(!srv.log.some((l) => /^(create|pay|release|details):5/.test(l)));
  assert.equal(srv.log.filter((l) => l.startsWith("pay:")).length, 1); assert.equal(srv.log.filter((l) => l.startsWith("release:")).length, 1);
});

test("reply-boundary faults across the real stack: Pay applied but its reply lost -> latched (no second Checkout, also after reload); a malformed 200 status keeps the latch and claims nothing", async () => {
  const w = world(); const clock = { now: NOW0 }; const timers = fakeTimers(clock); const srv = server(w, clock); const storage = memStorage();
  let p = pageLoad({ srv, storage, clock, timers }); await p.c.init();
  await p.c.create(stay()); clock.now += 1000; await p.c.details(GUEST);
  assert.equal(p.last().screen, "pay");
  const id = await intentOf(storage);
  // the REAL pay step runs (Checkout prepared on the fake account) but the reply never reaches the page
  p = pageLoad({ srv, storage, clock, timers, fault: (_path, body) => (body.step === "pay" ? "drop" : null) });
  clock.now += 1000; await p.c.pay();
  assert.deepEqual([p.last().latch, p.c.state.notice.code, p.nav.assigned.length], ["pay", "PAY_UNCERTAIN", 0]);
  assert.equal(w.writes.sessionCreate, 1); assert.equal((await loadIntent(db.app, id)).status, "payment_pending");
  await p.c.pay(); await p.c.pay();
  assert.equal(srv.log.filter((l) => l.startsWith("pay:")).length, 1, "repeat clicks send nothing");
  // reload: the real status is awaiting_payment, which proves nothing about the lost pay -> still latched
  p = pageLoad({ srv, storage, clock, timers }); await p.c.init();
  assert.deepEqual([p.c.state.last, p.last().latch, p.last().canPay], ["awaiting_payment", "pay", false]);
  await p.c.pay(); assert.equal(w.writes.sessionCreate, 1, "no second Checkout session");
  // a malformed 200 status reply (the real handler ran) keeps the latch, stops reads and drops the label
  p = pageLoad({ srv, storage, clock, timers, fault: (_path, body) => (body.step === "status" ? { status: 200, body: {} } : null) });
  await p.c.init();
  assert.deepEqual([p.last().screen, p.last().latch, p.c.state.last, p.c.state.stopped], ["unreadable", "pay", null, "UNREADABLE"]);
  await p.c.pay(); assert.equal(srv.log.filter((l) => l.startsWith("pay:")).length, 1);
  assert.equal(JSON.parse(storage.m.get(STORE_KEY)).uncertain, "pay");
  assert.deepEqual(w.writes, { sessionCreate: 1, cancel: 0, hostaway: 0 });
});
