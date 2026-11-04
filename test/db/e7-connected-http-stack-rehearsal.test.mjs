// E7 HTTP-STACK REHEARSAL (TESTS + REPORT ONLY): the ACCEPTED runConnectedTest (run-core.mjs) → ACCEPTED executor adapters →
// ACCEPTED Slice T transports (http-transports.mjs, 0830f9a4) → an INJECTED FAKE HTTP exchange → the synthetic provider world, on a
// DISPOSABLE local PG with the real accepted file journal. Report: claude/e7-connected-http-stack-rehearsal.md.
//
// LABELS
//   * REAL: disposable local PG with the real test_app / test_report logins; the accepted core, guard, facts, journal validators, adapters,
//     the four real imported workers, the accepted T transports and the accepted file journal (owner-only temp dirs), all unchanged.
//   * SYNTHETIC: the provider world and payment_authorized booking setup are COPIED VERBATIM from the accepted file-journal rehearsal
//     (test/db/e7-connected-file-journal-rehearsal.test.mjs:43–192, itself a verbatim copy of the adapter rehearsal). Mocked authorization.
//   * FAKE (labelled, TEST-ONLY): `httpExchange(w)` is the injected `exchange` given to createE7HostawaySend / createE7StripeTestSend. It
//     receives T's private HTTP request { method, url, headers, body, signal, maxBytes }, ENFORCES the exact documented wire form (origin,
//     path, query / form keys + values, header NAMES, Bearer + synthetic credential, Stripe-Version, Idempotency-Key), maps it onto the
//     world, and replies { status, contentType, bytes: genuine Uint8Array }. Wire violations are recorded and answered 400 (never
//     silently accepted). The request log keeps method, path, query KEY names and header NAMES only (Authorization never stored).
//     There is NO send wrapper: run-core receives T's { send } objects directly.
//   * CREDENTIALS: explicit SYNTHETIC fixture strings below (never real); Stripe-Version is a SYNTHETIC pin.
//   * TIME: scaled real timers as in the accepted rehearsal (monotonic = real elapsed × K). H3 uses K = 1 so the accepted worker's own
//     real capture-call timer (CAPTURE_DEFAULT_TIMEOUTS.captureCallMs, 20 s) fires before the runner's step deadline (see H3).
//   * No worker injection / hooks, no trigger bypass, no raw lifecycle writes, no real network / credentials. Guest values never printed.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { startMigratedDatabase } from "./harness.mjs";
import * as F from "./fixtures.mjs";
import { applyEvent, createIntentRecord, collectGuestDetails, beginPayStep, recordCheckoutSession } from "../../lib/booking-db/repo.js";
import { claimNextOperation, completeOperation } from "../../lib/booking-db/operations.js";
import { PROTECTED_HOSTAWAY_RESERVATION_IDS } from "../../lib/booking-db/reservation-worker.js";
import { CAPTURE_DEFAULT_TIMEOUTS } from "../../lib/booking-db/capture-worker.js";
import { priceStay } from "../../lib/checkout/server-pricer.js";
import { readDirectPolicyFromEnv } from "../../lib/direct-policy.js";
import { todayInTimeZone } from "../../lib/public-api.js";
import { validateRunManifest, CHECKPOINTS } from "../../scripts/e7-connected/run-manifest.mjs";
import { validateJournal, evaluateStart, recordHash, GENESIS_HASH } from "../../scripts/e7-connected/run-journal-memory.mjs";
import { runConnectedTest } from "../../scripts/e7-connected/run-core.mjs";
import { openFileJournal, encodeRecordLine, journalFileName } from "../../scripts/e7-connected/run-journal-file.mjs";
import { createE7HostawaySend, createE7StripeTestSend } from "../../scripts/e7-connected/http-transports.mjs";

let netAttempts = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { netAttempts += 1; throw new Error("network refused in the offline HTTP-stack rehearsal"); };
let db; let reportPool;
const DIRS = [];
const RES = { journalsOpened: 0, journalsClosed: 0 };                    // every opened file-journal handle is closed (asserted in after)
before(async () => { db = await startMigratedDatabase(); reportPool = new pg.Pool({ connectionString: db.reportUrl(), max: 8 }); });
after(async () => {
  globalThis.fetch = realFetch; await reportPool.end().catch(() => {}); await db.close();
  for (const d of DIRS) rmSync(d, { recursive: true, force: true });
  assert.equal(netAttempts, 0); assert.equal(RES.journalsOpened, RES.journalsClosed, "every journal handle closed");
});

// ===== SYNTHETIC world + booking setup: COPIED VERBATIM from the accepted file-journal rehearsal (lines 43–192) =====
const SEC = 1000; const MIN = 60 * SEC; const DAY = 24 * 60 * MIN;
const ENV_R = Object.freeze({ VERCEL_ENV: "development", MV_E7_RESERVATION_WORKER: "enabled" });
const ENV_C = Object.freeze({ VERCEL_ENV: "development", MV_E7_CAPTURE_WORKER: "enabled" });
const ENV_W = Object.freeze({ VERCEL_ENV: "development", MV_E7_RECORDING_WORKER: "enabled" });
const ENV_K = Object.freeze({ VERCEL_ENV: "development", MV_E7_COMPENSATION_WORKER: "enabled" });
const POLICY = readDirectPolicyFromEnv(ENV_R).policy;
const ACCT = "acct_1AdapterRehearsal";                            // FIXTURE Stripe account id (mock world)
const LABEL = Object.freeze({ accountRef: "acct-test-1", clientSnapshotId: "client-CAR" });   // TRUST labels, not authentication
const REF_FIELD = 777009;
const TZ = "America/Mazatlan";
const PROTECTED = [...PROTECTED_HOSTAWAY_RESERVATION_IDS];
const WRITE_KEYS = ["createReservation", "capturePaymentIntent", "createOfflineCharge", "cancelPaymentIntent", "cancelReservation"];
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const httpError = (statusCode) => Object.assign(new Error(`provider ${statusCode} (mock)`), { statusCode });

// ---------------------------------------------------------------------------------------------
// ONE coherent synthetic provider world per booking: Hostaway (pricing, reservations, offline charges) + Stripe (one PaymentIntent).
// Deterministic ids: each world owns a disjoint block (no random buckets).
let block = 5100000;
function world({ nightly = 250 } = {}) {
  block += 1000;
  const w = { nightly, calls: [], paths: [], writes: Object.fromEntries(WRITE_KEYS.map((k) => [k, 0])), res: new Map(), pis: new Map(), charges: [],
    nextRes: block, nextCharge: block * 10, mode: { create: "ok", capture: "ok", record: "ok", void: "ok" } };
  const days = (from, to) => { const out = []; for (let d = from; d <= to; d = addDays(d, 1)) out.push({ date: d, status: "available", isAvailable: 1, minimumStay: 1, maximumStay: 90, closedOnArrival: 0, closedOnDeparture: 0 }); return out; };
  const full = (r) => ({ id: r.id, listingMapId: r.listingMapId, channelId: 2000, arrivalDate: r.arrivalDate, departureDate: r.departureDate, totalPrice: r.totalPrice,
    currency: r.currency, status: r.status, customFieldValues: [{ customFieldId: REF_FIELD, value: r.ref }] });
  const ridOf = (path) => Number(/\/reservations\/(\d+)/.exec(path)[1]);
  w.piObj = (p) => {
    const cap = p.status === "succeeded";
    return { object: "payment_intent", id: p.id, livemode: false, status: p.status, capture_method: "manual", amount: p.amount,
      amount_received: cap ? p.received : 0, amount_capturable: p.status === "requires_capture" ? p.amount : 0, currency: "usd",
      metadata: { mv_intent_id: p.intentId, mv_payment_attempt_id: p.attemptId },
      latest_charge: { object: "charge", id: p.chargeId, payment_intent: p.id, status: "succeeded", paid: true, captured: cap, amount: p.amount,
        amount_captured: cap ? p.received : 0, amount_refunded: 0, currency: "usd", livemode: false, payment_method_details: { card: { capture_before: p.captureBeforeSec } } } };
  };
  const doCapture = (p, amount) => { p.status = "succeeded"; p.received = amount; };
  w.pricing = {
    get: async (path, opts = {}) => {
      w.calls.push(`pricing GET ${path}`);
      const m = /^\/listings\/(\d+)(\/calendar)?$/.exec(path); const id = Number(m[1]);
      if (!m[2]) return { status: 200, json: { result: { id, currencyCode: "USD", personCapacity: 4, minNights: 1, maxNights: 90 } } };
      return { status: 200, json: { result: days(opts.query.startDate, opts.query.endDate) } };
    },
    post: async (path, body) => {
      w.calls.push(`pricing POST ${path}`);
      const nights = Math.round((Date.parse(body.endingDate) - Date.parse(body.startingDate)) / DAY);
      const comps = [{ id: 1, type: "accommodation", name: "baseRate", title: "Base rate", quantity: 1, value: w.nightly, total: w.nightly * nights, isIncludedInTotalPrice: 1,
        isMandatory: 1, isOverriddenByUser: 0, isDeleted: 0, units: nights }];
      return { status: 200, json: { status: "success", result: { totalPrice: comps[0].total, components: comps } } };
    }
  };
  const hostaway = {
    lookupPage: async (req) => {
      w.calls.push("lookupPage"); w.paths.push(`lookup ${req.query.listingId}`);
      if (req.query.afterId) return { httpStatus: 200, json: { status: "success", result: [] } };
      const items = [...w.res.values()].filter((r) => r.listingMapId === req.query.listingId && r.arrivalDate === req.query.arrivalStartDate).map(full);
      return { httpStatus: 200, json: { status: "success", result: items } };
    },
    retrieveReservation: async (req) => {
      w.calls.push("retrieveReservation"); w.paths.push(req.path);
      const r = w.res.get(ridOf(req.path));
      return r ? { httpStatus: 200, json: { status: "success", result: full(r) } } : { httpStatus: 404, json: { status: "fail" } };
    },
    createReservation: async (req) => {
      w.calls.push("createReservation"); w.writes.createReservation += 1; w.paths.push(`create ${req.body.listingMapId}`);
      assert.deepEqual(req.query, {}, "never forceOverbooking");
      const r = { id: w.nextRes++, listingMapId: req.body.listingMapId, arrivalDate: req.body.arrivalDate, departureDate: req.body.departureDate,
        totalPrice: req.body.totalPrice, currency: req.body.currency, status: "new", ref: req.body.customFieldValues[0].value };
      w.res.set(r.id, r);                                                    // the mock APPLIES the create in every mode below
      if (w.mode.create === "noEcho") return { httpStatus: 201, json: { status: "success", result: { ...full(r), customFieldValues: [] } } };   // ref stored, not echoed
      if (w.mode.create === "appliedThen503") return { httpStatus: 503, json: { status: "fail", result: "upstream unavailable (mock)" } };
      return { httpStatus: 201, json: { status: "success", result: full(r) } };
    },
    cancelReservation: async (req) => {
      w.calls.push("cancelReservation"); w.writes.cancelReservation += 1; w.paths.push(req.path);
      const r = w.res.get(ridOf(req.path)); r.status = "cancelled";
      return { httpStatus: 200, json: { status: "success", result: full(r) } };
    },
    listOfflineCharges: async (req) => {
      w.calls.push("listOfflineCharges"); w.paths.push(`${req.path}?${req.query.reservationId}`);
      const rows = w.charges.filter((c) => String(c.reservationId) === String(req.query.reservationId)).map((c) => ({ ...c }));
      return { httpStatus: 200, json: { status: "success", result: rows, count: rows.length, offset: null } };
    },
    createOfflineCharge: async (req) => {
      w.calls.push("createOfflineCharge"); w.writes.createOfflineCharge += 1; w.paths.push(req.path);
      const rid = Number(/^\/v1\/guestPayments\/charges\/(\d+)$/.exec(req.path)[1]);
      const ch = { id: w.nextCharge++, listingMapId: w.res.get(rid).listingMapId, reservationId: rid, type: "charge", title: req.body.title, currency: "USD",
        paymentMethod: req.body.paymentMethod, amount: req.body.amount, status: "paid", paymentProvider: "offline" };
      w.charges.push(ch);                                                     // the mock APPLIES the write in every mode below
      if (w.mode.record === "appliedThen503") return { httpStatus: 503, json: { status: "fail", result: "upstream unavailable (mock)" } };
      return { httpStatus: 201, json: { status: "success", result: { ...ch } } };
    }
  };
  const stripe = {
    retrieveAccount: async () => { w.calls.push("retrieveAccount"); return { object: "account", id: ACCT }; },
    retrievePaymentIntent: async (id, params) => { w.calls.push("retrievePaymentIntent"); assert.deepEqual(params, { expand: ["latest_charge"] }); return w.piObj(w.pis.get(id)); },
    capturePaymentIntent: async (id, params) => {
      w.calls.push("capturePaymentIntent"); w.writes.capturePaymentIntent += 1;
      const p = w.pis.get(id);
      switch (w.mode.capture) {
        case "ok": doCapture(p, params.amount_to_capture); return w.piObj(p);
        case "500Captured": doCapture(p, params.amount_to_capture); throw httpError(500);    // APPLIED, reply lost / failed
        case "replyOnly": return { ...w.piObj(p), status: "succeeded" };                      // positive-looking reply, NOTHING applied
        default: throw new Error(w.mode.capture);
      }
    },
    cancelPaymentIntent: async (id) => { w.calls.push("cancelPaymentIntent"); w.writes.cancelPaymentIntent += 1; const p = w.pis.get(id); p.status = "canceled"; return w.piObj(p); }
  };
  w.exec = {
    R: { pricing: w.pricing, lookupPage: hostaway.lookupPage, retrieveReservation: hostaway.retrieveReservation, createReservation: hostaway.createReservation },
    C: { retrieveAccount: stripe.retrieveAccount, retrievePaymentIntent: stripe.retrievePaymentIntent, capturePaymentIntent: stripe.capturePaymentIntent,
      retrieveReservation: hostaway.retrieveReservation, lookupPage: hostaway.lookupPage },
    W: { label: LABEL, retrieveReservation: hostaway.retrieveReservation, listOfflineCharges: hostaway.listOfflineCharges, createOfflineCharge: hostaway.createOfflineCharge },
    K: { retrieveAccount: stripe.retrieveAccount, retrievePaymentIntent: stripe.retrievePaymentIntent, cancelPaymentIntent: stripe.cancelPaymentIntent,
      retrieveReservation: hostaway.retrieveReservation, lookupPage: hostaway.lookupPage, cancelReservation: hostaway.cancelReservation }
  };
  w.count = (k) => w.calls.filter((c) => c === k).length;
  return w;
}

// ---------------------------------------------------------------------------------------------
// fresh payment_authorized USD booking (reviewed repo functions, the E7.2 suite's own path); the mock Stripe world holds the PaymentIntent
let laneN = 0;
async function authorizedBooking(w) {
  laneN += 1;
  const listingId = 871000 + laneN;
  const stay = { from: addDays("2026-12-01", 7 * laneN), to: addDays("2026-12-01", 7 * laneN + 4), guests: 2 };
  const base = Date.now() - 20 * MIN;                                      // injected-clock origin (see header)
  const priced = await priceStay({ request: { listingId, ...stay }, listingConfig: { currency: "USD" }, client: w.pricing, policy: POLICY,
    today: todayInTimeZone(undefined, new Date(base)), now: base });
  assert.ok(priced.ok, priced.error);
  w.calls.length = 0;                                                       // setup pricing is not a worker call
  const intent = await createIntentRecord(db.app, { ref: F.nextRef(), accessTokenHash: F.tokenHash(), environment: "test", now: base, listingId, ...stay });
  F.ok(await applyEvent(db.app, intent.id, { type: "PRICE_CONFIRMED", price: priced.price }, { now: base, actor: "guest" }));
  F.ok(await collectGuestDetails(db.app, intent.id, F.GUEST, { now: base + SEC, termsVersion: "terms-2026-10" }));
  const b = F.ok(await beginPayStep(db.app, intent.id, { now: base + 2 * SEC }));
  const op = await claimNextOperation(db.app, { workerId: "w-pay", now: base + 2 * SEC, intentId: intent.id, opTypes: ["stripe.create_checkout_session"] });
  const sessionId = `cs_test_car${laneN}`;
  F.ok(await completeOperation(db.app, op.id, { workerId: "w-pay", now: base + 2 * SEC, outcome: { status: "succeeded", resultRef: sessionId } }));
  F.ok(await recordCheckoutSession(db.app, intent.id, b.attempt.id, { sessionId, expiresAt: base + 30 * MIN, now: base + 2 * SEC }));
  const piId = `pi_test_car${laneN}`;
  const captureBefore = Math.floor((base + 7 * DAY) / 1000) * 1000;
  F.ok(await applyEvent(db.app, intent.id, { type: "PAYMENT_AUTHORIZED", id: `evt_auth_${piId}`, paymentIntentId: piId, sessionId, amountMinor: priced.price.finalTotalMinor,
    currency: "usd", livemode: false, authorizationCreatedAt: base + 3 * SEC, captureBefore }, { now: base + 4 * SEC, actor: "webhook" }));
  const pa = (await db.app.query("SELECT id FROM booking.payment_attempts WHERE intent_id = $1 AND status = 'completed'", [intent.id])).rows[0].id;
  // the mock Stripe world authorized exactly this PaymentIntent (what the mock "did")
  w.pis.set(piId, { id: piId, intentId: intent.id, attemptId: pa, status: "requires_capture", amount: priced.price.finalTotalMinor, received: 0,
    chargeId: `ch_test_car${laneN}`, captureBeforeSec: captureBefore / 1000 });
  return { id: intent.id, ref: intent.ref, listingId, stay, piId, price: priced.price, total: priced.price.finalTotalMinor, paymentAttemptId: pa, base };
}
// ===== end of the verbatim copy =====

// ---------------------------------------------------------------------------------------------------------------------------------
// SYNTHETIC credentials + the FAKE HTTP exchange (TEST-ONLY; see header)
const HTOKEN = "synthetic-hostaway-token";                 // SYNTHETIC
const SKEY = "sk_test_Fake1";                              // SYNTHETIC test-prefix key (short: never a real key shape)
const SVERSION = "2099-01-01.synthetic";                   // SYNTHETIC Stripe-Version pin (the real version is B4, CLOSED)
const HOST_H = "https://api.hostaway.com"; const STRIPE_H = "https://api.stripe.com";
const enc = (v) => new TextEncoder().encode(JSON.stringify(v));
const reply = (status, json) => ({ status, contentType: "application/json", bytes: enc(json) });
const sortedKeys = (o) => Object.keys(o).sort();
function httpExchange(w, { holdCapture = false } = {}) {
  const x = { log: [], violations: [], held: [] };
  const violation = (why, req) => { x.violations.push(`${why}: ${req.method} ${new URL(req.url).pathname}`); return reply(400, { status: "fail", result: "wire violation (fake)" }); };
  const hdrs = (req, names) => JSON.stringify(sortedKeys(req.headers)) === JSON.stringify([...names].sort());
  const hostaway = async (req) => {
    const u = new URL(req.url); const p = u.pathname; const q = Object.fromEntries(u.searchParams); const m = req.method;
    const body = req.body === null ? undefined : JSON.parse(req.body);
    if (u.origin !== HOST_H || u.hash !== "" || u.username || u.port) return violation("origin", req);
    if (!hdrs(req, body === undefined ? ["Accept", "Authorization", "Cache-control"] : ["Accept", "Authorization", "Cache-control", "Content-Type"])) return violation("header names", req);
    if (req.headers.Authorization !== `Bearer ${HTOKEN}` || req.headers.Accept !== "application/json" || req.headers["Cache-control"] !== "no-cache") return violation("header values", req);
    if (body !== undefined && req.headers["Content-Type"] !== "application/json") return violation("content-type", req);
    const keys = sortedKeys(q).join(",");
    const qk = (want) => keys === want;
    const wrap = (r) => reply(r.httpStatus ?? r.status, r.json);
    let route = null;
    if (m === "GET" && /^\/v1\/listings\/\d+$/.test(p) && qk("")) route = async () => wrap(await w.pricing.get(p.slice(3)));
    else if (m === "GET" && /^\/v1\/listings\/\d+\/calendar$/.test(p) && qk("endDate,startDate")) route = async () => wrap(await w.pricing.get(p.slice(3), { query: q }));
    else if (m === "POST" && /^\/v1\/listings\/\d+\/calendar\/priceDetails$/.test(p) && qk("")) route = async () => wrap(await w.pricing.post(p.slice(3), body));
    else if (m === "GET" && p === "/v1/reservations" && (qk("arrivalEndDate,arrivalStartDate,channelId,includeResources,limit,listingId") || qk("afterId,arrivalEndDate,arrivalStartDate,channelId,includeResources,limit,listingId"))
      && q.channelId === "2000" && q.limit === "100" && q.includeResources === "1") {
      const query = { ...q, listingId: Number(q.listingId), channelId: 2000, limit: 100, includeResources: 1, ...(q.afterId ? { afterId: Number(q.afterId) } : {}) };
      route = async () => wrap(await w.exec.R.lookupPage({ method: m, path: p, query }));
    } else if (m === "GET" && /^\/v1\/reservations\/\d+$/.test(p) && qk("")) route = async () => wrap(await w.exec.R.retrieveReservation({ method: m, path: p, query: {} }));
    else if (m === "POST" && p === "/v1/reservations" && qk("")) route = async () => wrap(await w.exec.R.createReservation({ method: m, path: p, query: {}, body }));
    else if (m === "PUT" && /^\/v1\/reservations\/\d+\/statuses\/cancelled$/.test(p) && qk("")) route = async () => wrap(await w.exec.K.cancelReservation({ method: m, path: p, query: {}, body }));
    else if (m === "GET" && p === "/v1/guestPayments/charges") {
      // the DOCUMENTED wire selector only: exactly limit=500 & reservationIds=<one canonical id>; singular / both / unfiltered → violation
      if (!qk("limit,reservationIds") || q.limit !== "500" || !/^[1-9][0-9]{0,15}$/.test(q.reservationIds) || u.search !== `?limit=500&reservationIds=${q.reservationIds}`) return violation("charge-list selector", req);
      route = async () => wrap(await w.exec.W.listOfflineCharges({ method: m, path: p, query: { reservationId: q.reservationIds, limit: 500 } }));
    } else if (m === "POST" && /^\/v1\/guestPayments\/charges\/\d+$/.test(p) && qk("")) route = async () => wrap(await w.exec.W.createOfflineCharge({ method: m, path: p, query: {}, body }));
    if (!route) return violation("unmapped route", req);
    x.log.push({ provider: "hostaway", method: m, path: p, queryKeys: keys, search: u.search, headerNames: sortedKeys(req.headers).join(",") });
    return route();
  };
  const stripe = async (req) => {
    const u = new URL(req.url); const p = u.pathname; const m = req.method;
    if (u.origin !== STRIPE_H || u.hash !== "" || u.username || u.port) return violation("origin", req);
    if (!hdrs(req, m === "POST" ? ["Authorization", "Content-Type", "Idempotency-Key", "Stripe-Version"] : ["Authorization", "Stripe-Version"])) return violation("header names", req);
    if (req.headers.Authorization !== `Bearer ${SKEY}` || req.headers["Stripe-Version"] !== SVERSION) return violation("header values", req);
    if (m === "POST" && (req.headers["Content-Type"] !== "application/x-www-form-urlencoded" || !/^[A-Za-z0-9:_-]{1,255}$/.test(req.headers["Idempotency-Key"]))) return violation("post headers", req);
    const piRoute = /^\/v1\/payment_intents\/(pi_[A-Za-z0-9_]+)(\/capture|\/cancel)?$/.exec(p);
    const entry = { provider: "stripe", method: m, path: p.replace(/pi_[A-Za-z0-9_]+/, "{pi}"), queryKeys: [...u.searchParams.keys()].join(","), search: u.search,
      headerNames: sortedKeys(req.headers).join(","), idempotencyKey: m === "POST" ? req.headers["Idempotency-Key"] : null };
    const call = async (fn) => { try { return reply(200, await fn()); } catch (e) { if (e && e.statusCode) return reply(e.statusCode, { error: { type: "api_error" } }); throw e; } };
    if (m === "GET" && p === "/v1/account" && u.search === "" && req.body === null) { x.log.push(entry); return call(() => w.exec.C.retrieveAccount()); }
    if (m === "GET" && piRoute && !piRoute[2] && u.search === "?expand%5B%5D=latest_charge" && req.body === null) {
      x.log.push(entry); return call(() => w.exec.C.retrievePaymentIntent(piRoute[1], { expand: ["latest_charge"] }));
    }
    if (m === "POST" && piRoute && piRoute[2] === "/capture" && u.search === "") {
      const f = /^amount_to_capture=([1-9][0-9]*)&final_capture=true&expand%5B%5D=latest_charge$/.exec(req.body);
      if (!f) return violation("capture form", req);
      x.log.push(entry);
      if (!holdCapture) return call(() => w.exec.C.capturePaymentIntent(piRoute[1], { amount_to_capture: Number(f[1]), final_capture: true, expand: ["latest_charge"] }));
      // H3 TEST CONTROL (labelled): the capture is genuinely APPLIED in the world now; the reply is HELD until the supplied (worker-owned,
      // genuine) signal aborts by the worker's own call timer, and only then fulfilled — a fulfilled reply after an in-flight abort.
      const r = await call(() => w.exec.C.capturePaymentIntent(piRoute[1], { amount_to_capture: Number(f[1]), final_capture: true, expand: ["latest_charge"] }));
      const t0 = performance.now();
      await new Promise((res) => { if (req.signal.aborted) res(); else req.signal.addEventListener("abort", res, { once: true }); });
      x.held.push({ heldMs: Math.round(performance.now() - t0), signalAbortedAtFulfil: req.signal.aborted });
      return r;
    }
    if (m === "POST" && piRoute && piRoute[2] === "/cancel" && u.search === "") {
      if (req.body !== "") return violation("cancel form", req);
      x.log.push(entry); return call(() => w.exec.K.cancelPaymentIntent(piRoute[1]));
    }
    return violation("unmapped route", req);
  };
  x.hostaway = hostaway; x.stripe = stripe;
  x.count = (provider, method, re) => x.log.filter((e) => e.provider === provider && e.method === method && re.test(e.path)).length;
  return x;
}
/** the ACCEPTED T factories over the fake exchange: run-core gets T's { send } objects directly (no wrapper) */
function httpTransports(w, opts) {
  const x = httpExchange(w, opts);
  const creds = { hostaway: 0, stripe: 0 };
  const h = createE7HostawaySend({ exchange: x.hostaway, credential: () => { creds.hostaway += 1; return HTOKEN; } });
  const s = createE7StripeTestSend({ exchange: x.stripe, credential: () => { creds.stripe += 1; return SKEY; }, accountId: ACCT, apiVersion: SVERSION });
  assert.deepEqual([h.ok, s.ok], [true, true]);
  return { x, creds, hostaway: h.transport, stripe: s.transport };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// rehearsal harness (TEST-ONLY; the accepted file-journal rehearsal's harness, with T + the fake exchange in place of the fake sends)
const BASE_COMMIT = "0830f9a4e387038768a38e6e9a5482928636b071";
const one = async (sql, p = []) => (await db.owner.query(sql, p)).rows[0];
const all = async (sql, p = []) => (await db.owner.query(sql, p)).rows;
const W0 = Object.freeze({ cancel: 0, capture: 0, create: 0, record: 0, void: 0 });
const PROVIDER_WRITE_OPS = ["hostaway.create_reservation", "stripe.capture_payment_intent", "hostaway.record_offline_charge", "stripe.void_payment_intent", "hostaway.cancel_reservation"];
async function dbFacts(id) {
  const w = {};
  for (const t of PROVIDER_WRITE_OPS) w[t] = Number((await one("SELECT count(*) AS n FROM booking.external_operations WHERE intent_id = $1 AND op_type = $2 AND dispatched_at IS NOT NULL", [id, t])).n);
  return {
    state: (await one("SELECT state FROM booking.intents WHERE id = $1", [id])).state,
    writes: w,
    ops: Number((await one("SELECT count(*) AS n FROM booking.external_operations WHERE intent_id = $1", [id])).n),
    transitions: Number((await one("SELECT count(*) AS n FROM booking.intent_transitions WHERE intent_id = $1", [id])).n),
    cases: (await all("SELECT kind FROM booking.reconciliation_cases WHERE intent_id = $1 AND status = 'open' ORDER BY kind", [id])).map((c) => c.kind),
    notify: (await all("SELECT state, dispatched_at, attempts FROM booking.external_operations WHERE intent_id = $1 AND op_type = 'guest.notify'", [id])).map((n) => [n.state, n.dispatched_at, n.attempts])
  };
}
function timeDriver(K) {
  const t0 = performance.now();
  const now = () => (performance.now() - t0) * K;
  const arm = (ms) => { let h; const promise = new Promise((r) => { h = setTimeout(r, Math.max(0, ms / K)); }); return { promise, cancel: () => clearTimeout(h) }; };
  return { monotonic: now, timers: { arm }, now };
}
let runN = 0;
async function manifestFor(bk, phases) {
  const i = await one("SELECT rate_bps FROM booking.intents WHERE id = $1", [bk.id]);
  runN += 1;
  return { version: "e7-run-manifest-v1", runId: `synthetic-hsr-${String(runN).padStart(4, "0")}`, intentId: bk.id, baselineCommit: BASE_COMMIT, synthetic: true,
    providerMode: { hostaway: "fake", stripe: "mock" }, listing: { id: bk.listingId, currency: "USD", refFieldId: REF_FIELD, timeZone: TZ }, expectedRef: bk.ref,
    stay: { arrival: bk.stay.from, departure: bk.stay.to, guests: bk.stay.guests }, amountMinor: bk.total, pricing: { rateBps: Number(i.rate_bps) },
    stripeAccountId: ACCT, hostawayAccountLabel: { ...LABEL }, phases, paymentMethod: phases.recording ? "credit_card" : null,
    cleanup: { reservedNotConfirmed: "synthetic/cleanup-reserved", captured: "synthetic/cleanup-captured", confirmed: "synthetic/cleanup-confirmed" },
    automationsReviewed: "synthetic/automations", checkpoints: [...CHECKPOINTS] };
}
async function lane({ phases = { capture: true, recording: true }, clock = "real", K = 10, exchange = {} } = {}) {
  const w = world(); const b = await authorizedBooking(w);
  const manifest = await manifestFor(b, phases);
  const mv = validateRunManifest(manifest);
  assert.equal(mv.ok, true, mv.code);
  const dir = mkdtempSync(join(tmpdir(), "e7hsr-")); DIRS.push(dir);
  assert.equal(statSync(dir).mode & 0o777, 0o700, "owner-only temp dir");
  const L = { w, bk: b, manifest, dir, identity: { runId: manifest.runId, intentId: b.id, manifestHash: mv.hash, baselineCommit: BASE_COMMIT }, t: httpTransports(w, exchange) };
  L.file = join(dir, journalFileName(manifest.runId));
  L.openJournal = async () => { const j = await openFileJournal({ dir, identity: L.identity }); assert.equal(j.ok, true, j.code); RES.journalsOpened += 1;
    const close = j.close; return { ...j, close: async () => { const c = await close(); RES.journalsClosed += 1; return c; } }; };
  L.run = async (fj) => {
    const T = timeDriver(K);
    const clk = clock === "real" ? () => Date.now() : () => Math.floor(Math.min(b.base + 10 * SEC + T.now(), Date.now() - 5 * SEC));
    const ac = new AbortController();
    const att = (cp) => Promise.resolve({ ok: true, evidenceRef: `synthetic/${cp.toLowerCase()}` });
    return runConnectedTest({ manifest, intentId: b.id, pools: { app: db.app, report: reportPool }, transports: { hostaway: L.t.hostaway, stripe: L.t.stripe }, journal: fj.journal,
      trustedHead: null, attest: att, clock: clk, monotonic: T.monotonic, timers: T.timers, signal: ac.signal });
  };
  L.verifyFile = async () => {
    const j = await L.openJournal();
    try {
      const rr = await j.journal.read();
      assert.deepEqual(readFileSync(L.file), Buffer.concat(rr.records.map(encodeRecordLine)), "stored bytes = canonical lines of exactly these records");
      let prev = GENESIS_HASH;
      for (const [i, r] of rr.records.entries()) { assert.equal(r.seq, i + 1); assert.equal(r.prevHash, prev); prev = recordHash(r); }
      return { records: rr.records, tail: rr.tail, verdict: evaluateStart(rr, L.identity), validated: validateJournal(rr.records, L.identity) };
    } finally { assert.deepEqual({ ...(await j.close()) }, { fileClose: "closed", lock: "released" }); }
  };
  L.events = (recs) => recs.map((r) => `${r.event}${r.phase ? `:${r.phase}` : ""}${r.attestation ? `:${r.attestation.checkpoint}` : ""}${r.state ? `:${r.state}` : ""}`);
  L.exchanges = () => L.t.x.log.length + L.t.x.violations.length;
  L.wire = () => L.t.x.log.map((e) => `${e.provider} ${e.method} ${e.path}${e.queryKeys ? `?[${e.queryKeys}]` : ""}`);
  return L;
}
async function reinvoke(L, code) {
  const before = { x: L.exchanges(), creds: { ...L.t.creds }, w: { ...L.w.writes }, db: await dbFacts(L.bk.id) };
  const j = await L.openJournal();
  const r = await L.run(j);
  assert.deepEqual([r.ok, r.outcome, r.stopCode, r.journalSeq], [false, "REFUSED", code, 0], `re-invoke: ${code}`);
  assert.equal((await r.finalize()).lockRelease, "unlocked");
  assert.deepEqual({ ...(await j.close()) }, { fileClose: "closed", lock: "released" });
  assert.deepEqual([L.exchanges(), { ...L.t.creds }, { ...L.w.writes }, await dbFacts(L.bk.id)], [before.x, before.creds, before.w, before.db], "zero additional exchange / credential / provider / DB effect");
}
const plain = (r) => JSON.stringify({ ...r, finalize: undefined });
const noProtected = (L) => assert.ok(L.t.x.log.every((e) => !PROTECTED.some((id) => e.path.includes(String(id)) || e.search.includes(String(id)))));

// =================================================================================================================================
test("H1. fresh USD booking through core → adapters → T → fake HTTP → world: confirmed; one create / capture / offline charge; documented wire forms; D journal; re-invoke refuses", async () => {
  const L = await lane({ clock: "real" });
  const fj = await L.openJournal();
  const r = await L.run(fj);
  assert.deepEqual([r.ok, r.outcome, r.stopCode, r.ownerCleanupRequired, r.journalTerminal, r.effectsKnown], [true, "ENDED_CONFIRMED", null, "confirmed", "acknowledged", true], plain(r));
  assert.deepEqual({ ...r.writes }, { ...W0, create: 1, capture: 1, record: 1 });
  assert.equal((await r.finalize()).lockRelease, "unlocked");
  assert.deepEqual({ ...(await fj.close()) }, { fileClose: "closed", lock: "released" });
  const x = L.t.x;
  assert.deepEqual(x.violations, [], "every request matched a documented wire form");
  // WORLD, HTTP log and DB dispatches agree: exactly one write of each kind
  assert.deepEqual([L.w.writes.createReservation, L.w.writes.capturePaymentIntent, L.w.writes.createOfflineCharge, L.w.writes.cancelPaymentIntent, L.w.writes.cancelReservation], [1, 1, 1, 0, 0]);
  assert.deepEqual([x.count("hostaway", "POST", /^\/v1\/reservations$/), x.count("stripe", "POST", /\/capture$/), x.count("hostaway", "POST", /^\/v1\/guestPayments\/charges\/\d+$/),
    x.count("stripe", "POST", /\/cancel$/), x.count("hostaway", "PUT", /./)], [1, 1, 1, 0, 0]);
  const f = await dbFacts(L.bk.id);
  assert.deepEqual([f.state, f.writes, f.cases], ["confirmed", { "hostaway.create_reservation": 1, "stripe.capture_payment_intent": 1, "hostaway.record_offline_charge": 1,
    "stripe.void_payment_intent": 0, "hostaway.cancel_reservation": 0 }, []]);
  assert.deepEqual(f.notify, [["pending", null, 0]], "guest.notify queued, never invoked");
  // S1 = GET /v1/account; the Account fixture has NO livemode; PaymentIntent / charge replies stay strict (livemode:false) and the proofs passed
  const acct = x.log.filter((e) => e.provider === "stripe" && e.path === "/v1/account");
  assert.ok(acct.length >= 1 && acct.every((e) => e.method === "GET" && e.search === "" && e.headerNames === "Authorization,Stripe-Version"));
  assert.equal("livemode" in (await L.w.exec.C.retrieveAccount()), false, "the Account fixture carries no livemode");
  const pi = L.w.piObj(L.w.pis.get(L.bk.piId));
  assert.deepEqual([pi.livemode, pi.latest_charge.livemode, pi.status], [false, false, "succeeded"]);
  const capEv = await all("SELECT observed FROM booking.provider_evidence WHERE intent_id = $1 AND kind = 'payment_intent' ORDER BY observed_at", [L.bk.id]);
  assert.ok(capEv.length >= 1, "PaymentIntent evidence persisted by the accepted worker through T");
  // the capture request: exact form + the DB operation's own idempotency key on the wire
  const capOp = (await all("SELECT payload, state, attempts FROM booking.external_operations WHERE intent_id = $1 AND op_type = 'stripe.capture_payment_intent'", [L.bk.id]))[0];
  const capWire = x.log.filter((e) => e.provider === "stripe" && e.method === "POST" && e.path.endsWith("/capture"));
  assert.deepEqual([capOp.state, capOp.attempts, capWire.length, capWire[0].idempotencyKey], ["succeeded", 1, 1, capOp.payload.providerIdempotencyKey]);
  // H8: the WIRE used only the documented plural selector for the bound id; the INTERNAL evidence keeps the accepted singular reservationId
  const rid = String([...L.w.res.keys()][0]);
  const lists = x.log.filter((e) => e.provider === "hostaway" && e.path === "/v1/guestPayments/charges");
  assert.ok(lists.length >= 1 && lists.every((e) => e.search === `?limit=500&reservationIds=${rid}`), "wire: limit=500&reservationIds=<bound id> only");
  // INTERNAL side (unchanged accepted code): the recording worker's LIST_REQUEST is { reservationId, limit } (recording-worker.js:223), and
  // assessChargeList only yields a COMPLETE list when its internal request is exactly { limit: 500, reservationId: <bound id> }
  // (offline-charge-proof.js:250). The persisted evidence binds the same singular id via external_ref; it never carries the wire key.
  // [FIRST-RUN FIX, labelled: run 1 expected observed.reservationId on every list row; the preflight row stores counts only (run 2 showed
  //  two rows: preflight list + post-write settled charge row).]
  const listEv = await all("SELECT id, external_ref, status, observed FROM booking.provider_evidence WHERE intent_id = $1 AND kind = 'hostaway_offline_charges' ORDER BY observed_at", [L.bk.id]);
  assert.ok(listEv.every((e) => e.external_ref === rid && !JSON.stringify(e.observed).includes("reservationIds")), "every list evidence row bound to the singular id; never the wire key");
  const pre = listEv.filter((e) => e.observed.complete === true);
  assert.ok(pre.length >= 1 && pre.every((e) => e.observed.requestLimit === 500), "COMPLETE preflight list (the internal singular { limit:500, reservationId } request passed the accepted proof)");
  const och = (await all("SELECT id, state, attempts, settled_evidence_id FROM booking.external_operations WHERE intent_id = $1 AND op_type = 'hostaway.record_offline_charge'", [L.bk.id]))[0];
  assert.deepEqual([och.state, och.attempts], ["succeeded", 1]);
  const settled = listEv.find((e) => e.id === och.settled_evidence_id);
  assert.ok(settled && settled.observed.reservationId === rid, "the settled evidence row keeps the accepted SINGULAR reservationId");
  assert.equal((await one("SELECT booking.recording_completion_binding_refusal($1, $2, NULL) AS r", [och.id, och.settled_evidence_id])).r, null, "completion binding: bound (no refusal)");
  // credentials: one synthetic callback per permitted send; Authorization never stored in the test log
  assert.deepEqual([L.t.creds.hostaway, L.t.creds.stripe], [x.log.filter((e) => e.provider === "hostaway").length, x.log.filter((e) => e.provider === "stripe").length]);
  assert.ok(!JSON.stringify(x.log).includes(HTOKEN) && !JSON.stringify(x.log).includes(SKEY), "no credential in the request log");
  // persisted D journal
  const v = await L.verifyFile();
  console.log(`# H1 journal: ${JSON.stringify(L.events(v.records))}`);
  console.log(`# H1 wire: ${JSON.stringify(L.wire())}`);
  assert.deepEqual([v.tail, v.validated.status, v.verdict.code, v.records.at(-1).event, v.records.at(-1).outcome], ["complete", "ENDED", "RUN_ENDED", "RUN_ENDED", "ENDED_CONFIRMED"]);
  const g = await one("SELECT first_name, last_name, email FROM booking.intent_guests WHERE intent_id = $1", [L.bk.id]);
  const txt = readFileSync(L.file, "utf8");
  assert.ok(![g.first_name, g.last_name, g.email, HTOKEN, SKEY].some((s) => s && txt.includes(s)), "no guest value / credential in the journal file");
  await reinvoke(L, "RUN_ENDED");
  noProtected(L); assert.equal(netAttempts, 0);
});

test("H2. applied-then-503 reservation create via a FAKE HTTP reply: create stays outcome_unknown / open case; stop before capture; one create / key; no-resume", async () => {
  const L = await lane({ clock: "behind", phases: { capture: true, recording: false } });
  L.w.mode.create = "appliedThen503";
  const fj = await L.openJournal();
  const r = await L.run(fj);
  assert.deepEqual([r.outcome, r.stopCode, r.ownerCleanupRequired], ["STOPPED", "OPEN_CASE", "reservedNotConfirmed"], plain(r));
  assert.equal((await r.finalize()).lockRelease, "unlocked");
  assert.deepEqual({ ...(await fj.close()) }, { fileClose: "closed", lock: "released" });
  const x = L.t.x;
  assert.deepEqual(x.violations, []);
  assert.deepEqual([L.w.writes.createReservation, x.count("hostaway", "POST", /^\/v1\/reservations$/)], [1, 1], "one applied create, one create request");
  assert.deepEqual([x.count("stripe", "POST", /\/capture$/), x.log.filter((e) => e.provider === "stripe").length, L.t.creds.stripe], [0, 0, 0], "no capture request; Stripe never reached");
  const f = await dbFacts(L.bk.id);
  assert.deepEqual([f.writes["hostaway.create_reservation"], f.writes["stripe.capture_payment_intent"], f.cases], [1, 0, ["HOSTAWAY_CREATE_OUTCOME_UNKNOWN"]], "the case stays OPEN");
  const createOps = await all("SELECT idempotency_key, state FROM booking.external_operations WHERE intent_id = $1 AND op_type = 'hostaway.create_reservation'", [L.bk.id]);
  assert.deepEqual(createOps.map((o) => o.state), ["outcome_unknown"], "one create row, a durable unknown");
  const v = await L.verifyFile();
  console.log(`# H2 journal: ${JSON.stringify(L.events(v.records))} state=${f.state}`);
  console.log(`# H2 wire: ${JSON.stringify(L.wire())}`);
  assert.deepEqual([v.records.at(-1).event, v.records.at(-1).code, v.verdict.code], ["RUN_STOPPED", "OPEN_CASE", "RUN_ENDED"]);
  await reinvoke(L, "RUN_ENDED");
  assert.deepEqual((await all("SELECT idempotency_key FROM booking.external_operations WHERE intent_id = $1 AND op_type = 'hostaway.create_reservation'", [L.bk.id])).map((o) => o.idempotency_key),
    createOps.map((o) => o.idempotency_key), "no second create / key");
  noProtected(L);
});

// H3 LIMIT (labelled, see report §4): the exchange cannot abort the worker-owned signal (no controller; no worker hook allowed), so the
// accepted worker's OWN capture-call timer aborts it. That timer also settles the worker's call first (ProviderCallTimeout →
// CAPTURE_TIMEOUT unknown); T's post-settlement ABORTED_IN_FLIGHT → adapter TRANSPORT_FAILED then reaches only the worker's late-result
// path, which leaves the unknown row unchanged. A labelled differential run with the pre-fix T (b4150809) passed H3 identically, so this
// case proves the accepted conservative policy over the full stack, NOT R-TC1 itself (that stays proven by unit T11).
test("H3. applied capture whose reply is HELD until the worker's own call timer aborts the genuine signal, then FULFILLED: CAPTURE_TIMEOUT unknown, UNKNOWN_WRITE stop, no resend / new key / recording", { timeout: 180_000 }, async () => {
  assert.equal(CAPTURE_DEFAULT_TIMEOUTS.captureCallMs, 20_000, "the accepted worker's real capture-call timer");
  const L = await lane({ clock: "real", K: 1, phases: { capture: true, recording: true }, exchange: { holdCapture: true } });
  const fj = await L.openJournal();
  const r = await L.run(fj);
  const fin = await r.finalize();
  assert.deepEqual({ ...(await fj.close()) }, { fileClose: "closed", lock: "released" });
  const x = L.t.x;
  assert.deepEqual(x.violations, []);
  assert.equal(x.held.length, 1, "exactly one held capture reply");
  assert.equal(x.held[0].signalAbortedAtFulfil, true, "the reply was fulfilled AFTER the genuine signal aborted");
  assert.ok(x.held[0].heldMs >= CAPTURE_DEFAULT_TIMEOUTS.captureCallMs - 1000, `held ${x.held[0].heldMs} ms until the worker timer`);
  assert.deepEqual([L.w.writes.capturePaymentIntent, x.count("stripe", "POST", /\/capture$/)], [1, 1], "the capture was applied once; one capture request; no resend");
  assert.equal(L.w.pis.get(L.bk.piId).status, "succeeded", "the world really captured (the run must not treat it as not applied)");
  const capOps = await all("SELECT state, attempts, error_code, payload FROM booking.external_operations WHERE intent_id = $1 AND op_type = 'stripe.capture_payment_intent'", [L.bk.id]);
  assert.equal(capOps.length, 1, "one capture operation, no new key");
  assert.equal(capOps[0].attempts, 1);
  assert.notEqual(capOps[0].state, "succeeded", "never a positive capture from an aborted call");
  const capWire = x.log.filter((e) => e.provider === "stripe" && e.method === "POST" && e.path.endsWith("/capture"));
  assert.deepEqual(capWire.map((e) => e.idempotencyKey), [capOps[0].payload.providerIdempotencyKey]);
  assert.deepEqual([x.count("hostaway", "POST", /^\/v1\/guestPayments\/charges\/\d+$/), x.log.filter((e) => e.path === "/v1/guestPayments/charges").length, L.w.writes.createOfflineCharge],
    [0, 0, 0], "no recording phase / provider request");
  assert.notEqual(r.outcome, "ENDED_CONFIRMED");
  const f = await dbFacts(L.bk.id);
  const v = await L.verifyFile();
  console.log(`# H3 result: ${plain(r)} finalize=${JSON.stringify(fin)}`);
  console.log(`# H3 capture op: ${JSON.stringify(capOps.map((o) => [o.state, o.attempts, o.error_code]))} intent=${f.state} cases=${JSON.stringify(f.cases)} writes=${JSON.stringify(f.writes)}`);
  console.log(`# H3 journal: ${JSON.stringify(L.events(v.records))} verdict=${v.verdict.code}`);
  console.log(`# H3 wire: ${JSON.stringify(L.wire())}`);
  // pinned from FIRST FULL TAP run 1 (labelled): the accepted unknown policy's actual persisted outcome
  assert.deepEqual([r.ok, r.outcome, r.stopCode, r.phase, r.effectsKnown, r.ownerCleanupRequired, r.journalTerminal], [false, "STOPPED", "UNKNOWN_WRITE", "capture", false, "captured", "acknowledged"]);
  assert.deepEqual([capOps[0].state, capOps[0].error_code, f.state, f.cases, f.writes["hostaway.record_offline_charge"], f.writes["stripe.void_payment_intent"], f.writes["hostaway.cancel_reservation"]],
    ["outcome_unknown", "CAPTURE_TIMEOUT", "capture_unknown", [], 0, 0, 0], "effects unknown; no automatic cleanup write; owner cleanup required = captured");
  assert.deepEqual([v.records.at(-1).event, v.records.at(-1).code, v.verdict.code], ["RUN_STOPPED", "UNKNOWN_WRITE", "RUN_ENDED"]);
  await reinvoke(L, "RUN_ENDED");
  noProtected(L); assert.equal(netAttempts, 0);
});
