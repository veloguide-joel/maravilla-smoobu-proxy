// E7 G3b — the native R1 EXECUTE wiring (run-plan-cli-main execute → run-r1-launcher → accepted runReservationAbortR1) on a DISPOSABLE local
// PG (migrations 0001–0017 incl. the 0017 LOCAL candidate; never a shared DB). Contract claude/e7-g3b-native-execute.md. No network, no
// real provider, no real credential.
// LABELS
//   * REAL: main(proc, hooks) of the native CLI (closure verification over the real repo files, then the accepted adapters + launcher);
//     REAL temp owner files (provider file, app / report login files with SYNTHETIC canary passwords — the cluster uses trust auth),
//     the REAL R1 file + head journal in owner-only temp dirs, the accepted pool, the accepted T transports, the accepted consumer / workers.
//   * FAKE (TEST-ONLY, in-process hook only): the provider exchanges behind T (the labelled http-stack copy) and a time scale K=10 applied to
//     the guard's monotonic / timers; the business clock is the G2b rehearsal clock. Attestations are answered by the test over the
//     launcher's real stdin protocol (never fabricated by the runtime).
//   * The world / booking / exchange / harness / package helpers are the LABELLED COPIES carried by test/db/e7-run-reservation-abort-r1.test.mjs
//     (its lines 56–447, which name their own origins), reproduced verbatim below.
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { readFileSync, mkdtempSync, rmSync, chmodSync, writeFileSync, readdirSync, constants as FS_CONSTANTS } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import pg from "pg";
import { startMigratedDatabase } from "./harness.mjs";
import * as F from "./fixtures.mjs";
import { applyEvent, loadIntent, createIntentRecord, collectGuestDetails, beginPayStep, recordCheckoutSession } from "../../lib/booking-db/repo.js";
import { claimNextOperation, completeOperation } from "../../lib/booking-db/operations.js";
import { PROTECTED_HOSTAWAY_RESERVATION_IDS } from "../../lib/booking-db/reservation-worker.js";
import { priceStay } from "../../lib/checkout/server-pricer.js";
import { readDirectPolicyFromEnv } from "../../lib/direct-policy.js";
import { todayInTimeZone } from "../../lib/public-api.js";
import { createE7HostawaySend, createE7StripeTestSend } from "../../scripts/e7-connected/http-transports.mjs";
import { CHECKPOINTS_BY_CONNECTION } from "../../scripts/e7-connected/run-manifest-v2.mjs";
import { buildRunPackageV1, sourceDigestV1, RUN_PLAN_CLOSURE, HISTORICAL_EXCLUSIONS, ALLOWED_OPS } from "../../scripts/e7-connected/run-plan-v1.mjs";
import { canonicalJson } from "../../scripts/e7-connected/run-manifest.mjs";
import * as R from "../../scripts/e7-connected/run-binding-r1.mjs";
import { readJournalForRecoveryR1 } from "../../scripts/e7-connected/run-journal-file-v2.mjs";
import { bindRunPackageR1Journal } from "../../scripts/e7-connected/run-journal-memory-v2.mjs";
import * as CLI from "../../scripts/e7-connected/run-plan-cli-main.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ABORT_LISTING = 606998;
let netAttempts = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { netAttempts += 1; throw new Error("network refused in the offline G3b suite"); };
let db; let reportPool;
const DIRS = [];
let NATIVE_DIGEST = null;
before(async () => {
  db = await startMigratedDatabase(); reportPool = new pg.Pool({ connectionString: db.reportUrl(), max: 8 });
  const e = await CLI.readNativeClosure(ROOT, FS_CONSTANTS); assert.ok(e, "native closure readable"); NATIVE_DIGEST = await CLI.nativeClosureDigest(e);
});
after(async () => { globalThis.fetch = realFetch; await reportPool.end().catch(() => {}); await db.close(); for (const d of DIRS) rmSync(d, { recursive: true, force: true }); assert.equal(netAttempts, 0); });

// ===== reproduced labelled copies (verbatim from test/db/e7-run-reservation-abort-r1.test.mjs lines 56–447) =====
// ===== LABELLED COPY of test/db/e7-run-core-abort-v2.test.mjs:47–197 (world + booking; itself a labelled copy of the runner suite) =====
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
async function authorizedBooking(w, o = {}) {
  laneN += 1;
  const listingId = o.listingId ?? ABORT_LISTING;                          // M2-D CHANGE: the accepted helper allowlists ONLY 606998 / USD
  const stay = { from: addDays("2027-03-01", 6 * laneN), to: addDays("2027-03-01", 6 * laneN + 4), guests: 2 };
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
  const sessionId = `cs_test_m2dLane${String(laneN).padStart(4, "0")}`;       // M2-D CHANGE 2: the accepted helper's id formats
  F.ok(await completeOperation(db.app, op.id, { workerId: "w-pay", now: base + 2 * SEC, outcome: { status: "succeeded", resultRef: sessionId } }));
  F.ok(await recordCheckoutSession(db.app, intent.id, b.attempt.id, { sessionId, expiresAt: base + 30 * MIN, now: base + 2 * SEC }));
  const piId = `pi_M2DLane${String(laneN).padStart(4, "0")}`;
  const captureBefore = Math.floor((base + 7 * DAY) / 1000) * 1000;
  F.ok(await applyEvent(db.app, intent.id, { type: "PAYMENT_AUTHORIZED", id: `evt_auth_${piId}`, paymentIntentId: piId, sessionId, amountMinor: priced.price.finalTotalMinor,
    currency: "usd", livemode: false, authorizationCreatedAt: base + 3 * SEC, captureBefore }, { now: base + 4 * SEC, actor: "webhook" }));
  const pa = (await db.app.query("SELECT id FROM booking.payment_attempts WHERE intent_id = $1 AND status = 'completed'", [intent.id])).rows[0].id;
  // the mock Stripe world authorized exactly this PaymentIntent (what the mock "did")
  w.pis.set(piId, { id: piId, intentId: intent.id, attemptId: pa, status: "requires_capture", amount: priced.price.finalTotalMinor, received: 0,
    chargeId: `ch_test_car${laneN}`, captureBeforeSec: captureBefore / 1000 });
  return { id: intent.id, ref: intent.ref, listingId, stay, piId, price: priced.price, total: priced.price.finalTotalMinor, paymentAttemptId: pa, base };
}
// ===== end of the world / booking copy =====

// ===== LABELLED COPY of test/db/e7-connected-http-stack-rehearsal.test.mjs:207–296 (SYNTHETIC credentials + FAKE exchange + accepted T factories) =====
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
// ===== end of the exchange copy =====

// ===== LABELLED COPY of test/db/e7-run-core-abort-v2.test.mjs:236–341 (harness helpers) =====
const BASE_COMMIT = "ea830a628995dae6285a4a35ae9e14bf39ccfabe";
const one = async (sql, p = []) => (await db.owner.query(sql, p)).rows[0];
const all = async (sql, p = []) => (await db.owner.query(sql, p)).rows;
const openCases = (id) => all("SELECT kind FROM booking.reconciliation_cases WHERE intent_id = $1 AND status = 'open' ORDER BY kind", [id]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const synthErr = () => Object.assign(new Error("synthetic test fault"), { code: "XX000" });
const W0 = Object.freeze({ cancel: 0, capture: 0, create: 0, record: 0, void: 0 });
const RELEASE_WORK_SQL = `UPDATE booking.intent_work SET work_worker_id = NULL, work_lease_until = NULL,
            next_action_at = CASE WHEN next_action_at IS NULL THEN NULL ELSE $3::timestamptz END
      WHERE intent_id = $1 AND work_worker_id = $2`;            // EXACT text of reservation-worker.js releaseWork (worker-owned SQL)
assert.ok(readFileSync(join(ROOT, "lib/booking-db/reservation-worker.js"), "utf8").includes(RELEASE_WORK_SQL), "fault selector = the worker's exact text");

/** scaled real timers; advance(ms) moves virtual time forward and fires every due timer (TEST-ONLY) */
function timeDriver(K) {
  const t0 = performance.now(); let offset = 0; let arms = 0; let reads = 0;
  const now = () => (performance.now() - t0) * K + offset;
  const armed = new Set();
  const arm = (ms) => {
    arms += 1;
    let h; let res;
    const promise = new Promise((r) => { res = r; });
    const e = { due: now() + ms, fire: () => { clearTimeout(h); armed.delete(e); res(); } };
    h = setTimeout(e.fire, Math.max(0, ms / K));
    armed.add(e);
    return { promise, cancel: () => { clearTimeout(h); armed.delete(e); } };
  };
  return { deps: { monotonic: () => { reads += 1; return now(); }, timers: { arm } }, now,
    advance: (ms) => { offset += ms; const n = now(); for (const e of [...armed]) if (e.due <= n) e.fire(); },
    jump: (ms) => { offset += ms; },                           // moves virtual time WITHOUT firing timers (a settled op still wins)
    counts: () => ({ arms, reads }) };
}

let clientSeq = 0;
/** TEST-ONLY pool wrapper: forwards to a real pg pool; faults selected by exact SQL text (or the next op after arming) */
class FaultPool {
  constructor(pool, name, tl) { this.pool = pool; this.name = name; this.tl = tl; this.log = []; this.faults = []; this.clients = []; this.connects = 0; }
  addFault(f) { this.faults.push({ seen: 0, used: false, ...f }); }
  match(kind, sql) {
    for (const f of this.faults) {
      if (f.used || (f.kind !== "any" && f.kind !== kind) || (f.sql !== undefined && f.sql !== sql)) continue;
      f.seen += 1;
      if (f.nth && f.seen !== f.nth) continue;
      f.used = true; f.at = this.log.length; return f;
    }
    return null;
  }
  apply(f, real, client) {
    if (f.mode === "reject") return Promise.reject(synthErr());
    if (f.mode === "hang") return new Promise(() => {});
    if (f.mode === "mutate") return (async () => f.fn(await real()))();                            // real statement, TEST-ONLY altered rows
    return (async () => { const r = await real(); await f.fn(client, this); return r; })();     // "after": real statement, then the hook
  }
  async connect() {
    this.connects += 1;
    const f = this.match("connect");
    if (f && f.mode === "reject") throw synthErr();
    const c = await this.pool.connect();
    const w = new FaultClient(this, c);
    this.clients.push(w);
    if (f && f.mode === "late") await sleep(f.ms);
    if (f && f.mode === "beforeHandoff") await f.fn(this, w);         // TEST-ONLY: an event while connecting, before the client is handed back
    if (f && f.mode === "inject") w.injectOn = f.event;               // TEST-ONLY: synthetic error / end delivered to the tracker on subscribe
    return w;
  }
  query(sql, params) {
    this.log.push({ via: "pool", sql }); this.tl.push(`${this.name}:pool`);
    const f = this.match("query", sql);
    return f ? this.apply(f, () => this.pool.query(sql, params), null) : this.pool.query(sql, params);
  }
  sqlLog() { return this.log.map((x) => x.sql); }
  async cleanup() { for (const c of this.clients) if (!c.released) { c.released = true; try { c.c.release(true); } catch { /* already gone */ } } }
}
class FaultClient {
  constructor(p, c) { this.p = p; this.c = c; this.id = ++clientSeq; this.events = []; this.released = false; }
  query(sql, params) {
    this.p.log.push({ via: this.id, sql }); this.events.push("query");
    if (sql === FACTS_SQL.BEGIN) this.p.tl.push(`${this.p.name}:BEGIN`);
    const f = this.p.match("query", sql);
    return f ? this.p.apply(f, () => this.c.query(sql, params), this) : this.c.query(sql, params);
  }
  release(x) { this.events.push(x === true ? "release(true)" : "release()"); if (this.released) return undefined; this.released = true; return this.c.release(x); }
  on(e, h) {
    this.events.push(`on:${e}`); this.c.on(e, h);
    if (this.injectOn === e) { this.injectOn = null; this.events.push(`inject:${e}`); h(); }   // SYNTHETIC event to the subscriber only
    return this;
  }
  removeListener(e, h) { this.events.push(`off:${e}`); this.c.removeListener(e, h); return this; }
  pid() { return this.c.processID; }
}
/** terminate a wrapped client's backend from the owner and wait for the client to observe it (disposable DB only) */
async function terminate(fc) {
  const ended = new Promise((r) => { fc.c.once("end", r); });
  await db.owner.query("SELECT pg_terminate_backend($1)", [fc.pid()]);
  await Promise.race([ended, sleep(2000)]);
}

/** a controllable hang around ONE fake-world function (test-controlled gate; the fake applies only after release) */
function gate(obj, key) {
  const orig = obj[key]; let release; let hit;
  const g = { released: false, hit: new Promise((r) => { hit = r; }) };
  const opened = new Promise((r) => { release = r; });
  g.release = () => { g.released = true; release(); };
  obj[key] = async (...a) => { hit(); obj[key] = orig; await opened; return orig(...a); };
  return g;
}
// ===== end of the labelled copies; M2-G2b harness below =====
const u8 = (p) => new Uint8Array(readFileSync(join(ROOT, p)));
const FOUND = RUN_PLAN_CLOSURE.map((path) => ({ path, bytes: u8(path) }));
const EXEC = R.R1_EXECUTOR_CLOSURE.map((path) => ({ path, bytes: u8(path) }));
const ENV = () => ({ schema: "e7-probe-env-snapshot-v1", nodeVersion: "22.22.0", platform: "linux", execArgvCount: 0, uidAvailable: true,
  present: Object.fromEntries(["NODE_OPTIONS", "NODE_TLS_REJECT_UNAUTHORIZED", "NODE_EXTRA_CA_CERTS", "NODE_USE_ENV_PROXY", "NODE_DEBUG", "NODE_DEBUG_NATIVE", "SSLKEYLOGFILE",
    "OPENSSL_CONF", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy"].map((k) => [k, false])) });
const iso = (t) => new Date(t).toISOString();
const RUN1 = HISTORICAL_EXCLUSIONS.runs[0]; const RUN3 = HISTORICAL_EXCLUSIONS.runs[2];
let planN = 0;
/** SYNTHETIC plan → accepted package → the reviewed R1 input (the bindRunPackageR1 input minus execClock) for ONE booking */
function r1InputFor(bk, planClock, { connection = "disconnected", over = () => {} } = {}) {
  planN += 1;
  const plan = { version: "e7-run-plan-v1", kind: "reservation-test-abort-v1", runId: `synthetic-g2b-${String(planN).padStart(4, "0")}`, createdAt: iso(planClock - MIN),
    baseline: { repoCommit: BASE_COMMIT, sourceDigest: sourceDigestV1(FOUND) },
    environment: { stripe: { mode: "test", accountId: ACCT }, hostaway: { accountRef: LABEL.accountRef, clientSnapshotId: LABEL.clientSnapshotId },
      db: { instanceEnvironment: "test", appRole: "mv_booking_app", reportRole: "mv_booking_report" } },
    listing: { id: ABORT_LISTING, currency: "USD", refFieldId: REF_FIELD, connection, timeZone: TZ },
    phases: { capture: false, recording: false, testAbortAfterReservation: true }, allowedOps: [...ALLOWED_OPS],
    checkpoints: [...CHECKPOINTS_BY_CONNECTION[connection]], deadlines: { quoteMaxAgeMinutes: 30, authorizationMaxAgeHours: 24 },
    stayRules: { minLeadDays: 7, maxNights: 7 }, exclusions: JSON.parse(JSON.stringify(HISTORICAL_EXCLUSIONS)),
    binding: { intentId: bk.id, expectedRef: bk.ref, paymentIntentId: bk.piId, stay: { arrival: bk.stay.from, departure: bk.stay.to, guests: bk.stay.guests },
      amountMinor: bk.total, rateBps: bk.price.rateBps, quote: { totalMinor: bk.total, currency: "USD", quotedAt: iso(planClock - 10 * MIN) }, authorizedAt: iso(planClock - 5 * MIN) } };
  over(plan);
  const planBytes = new TextEncoder().encode(`${canonicalJson(plan)}\n`);
  const built = buildRunPackageV1({ planBytes, sourceEntries: FOUND, envSnapshot: ENV(), planClock });
  assert.ok(built.ok, `package build ${built.code}`);
  return { plan, built, input: { packageBytes: new TextEncoder().encode(`${canonicalJson(built.package)}\n`), planBytes, foundationSources: FOUND, executorSources: EXEC,
    envSnapshot: ENV(), expected: { packageHash: built.packageHash, executorDigest: R.executorDigestR1(EXEC) } } };
}
let historical = null;
/** labelled historical STAND-INS (exact ledger Run1 / Run3 intent ids) so the exclusion baseline fingerprints real rows; Run2 stays absent */
async function ensureHistorical() {
  if (historical) return historical;
  const base = Date.now() - DAY;
  for (const [id, n] of [[RUN1.intentId, 1], [RUN3.intentId, 3]])
    await createIntentRecord(db.app, { id, ref: F.nextRef(), accessTokenHash: F.tokenHash(), environment: "test", now: base, listingId: ABORT_LISTING,
      from: addDays("2028-01-01", 5 * n), to: addDays("2028-01-01", 5 * n + 2), guests: 2 });
  historical = { ids: [RUN1.intentId, RUN3.intentId] };
  return historical;
}
// ===== end of the reproduced labelled copies; G3b harness below =====
const CANARY = "CANARYpw7f3e9Q";                                  // SYNTHETIC password in the login URLs (trust auth ignores it)
const ownerDir = (p) => { const d = mkdtempSync(join(tmpdir(), p)); chmodSync(d, 0o700); DIRS.push(d); return d; };
const put = (d, name, text) => { const f = join(d, name); writeFileSync(f, text); chmodSync(f, 0o600); return f; };
const portOf = () => Number(new URL(db.appUrl()).port);
const loginUrl = (user, o = {}) => `postgresql://${user}:${CANARY}@127.0.0.1:${portOf()}/postgres${o.q ?? ""}`;
const loginFile = (d, name, role, user, o) => put(d, name, JSON.stringify({ schema: "e7-db-login-v1", role, connectionString: loginUrl(user, o) }));
const scrub = (s) => { for (const bad of [CANARY, HTOKEN, SKEY, "test_app:", "test_report:"]) if (s.includes(bad)) return bad; return null; };
const LIVE = [];
afterEach(async () => { for (const S of LIVE.splice(0)) await S.cleanup(); });
/** one native execute run: fresh world / booking / reviewed package files / owner files / owner dirs; main(proc, hooks) IN-PROCESS */
async function launch(o = {}) {
  await ensureHistorical();
  const w = o.w ?? world();
  const bk = await authorizedBooking(w);
  if (o.afterBooking) await o.afterBooking(w, bk);
  const connection = o.connection ?? "disconnected";
  const pk = r1InputFor(bk, bk.base + 5 * SEC, { connection });
  const files = ownerDir("g3b-files-");
  const S = { w, bk, pk, connection, K: CHECKPOINTS_BY_CONNECTION[connection], out: [], err: [], code: null, sig: {}, prompts: [] };
  S.packagePath = put(files, "package.json", Buffer.from(pk.input.packageBytes)); S.planPath = put(files, "plan.json", Buffer.from(pk.input.planBytes));
  S.provider = o.provider ?? put(files, "provider.json", JSON.stringify({ hostawayToken: HTOKEN, stripeTestKey: SKEY }));
  S.app = loginFile(files, "app.json", "mv_booking_app", o.appUser ?? "test_app"); S.report = loginFile(files, "report.json", "mv_booking_report", o.reportUser ?? "test_report", o.reportLogin);
  S.jd = ownerDir("g3b-j-"); S.hd = ownerDir("g3b-h-");
  S.t = httpTransports(w, o.exchange);
  const t0 = performance.now();
  S.clock = () => Math.floor(Math.min(bk.base + 10 * SEC + (performance.now() - t0) * 10, Date.now() - 5 * SEC)) + (S.jump ?? 0);
  S.stdin = new PassThrough(); const stderr = new PassThrough(); stderr.setEncoding("utf8");
  const answer = o.answer ?? ((S0, p) => `ATTEST ${p.runId} ${p.checkpoint} synthetic/${p.checkpoint.toLowerCase()}`);
  stderr.on("data", (c) => { S.err.push(c); for (const l of String(c).split("\n")) { const m = /^E7ATTEST (.*)$/.exec(l); if (!m) continue; const p = JSON.parse(m[1]); S.prompts.push(p);
    Promise.resolve(o.onPrompt ? o.onPrompt(S, p) : null).then((x) => { if (x === "NO_ANSWER") return; const a = answer(S, p); if (a !== null) for (const line of [].concat(a)) S.stdin.write(`${line}\n`); }); } });
  S.flags = o.flags ?? ["execute", "--package", S.packagePath, "--plan", S.planPath, "--expect-package-hash", pk.input.expected.packageHash,
    "--expect-executor-digest", pk.input.expected.executorDigest, "--expect-native-digest", o.nativeDigest ?? NATIVE_DIGEST, "--intent", bk.id,
    "--provider-credentials", S.provider, "--db-app", S.app, "--db-report", S.report, "--db-ca", "none", "--journal-dir", S.jd, "--head-dir", S.hd,
    "--stripe-api-version", SVERSION];
  S.proc = { argv: ["node", "cli", ...S.flags], platform: process.platform, versions: process.versions, execArgv: [], env: {}, getuid: () => process.getuid(),
    fsConstants: FS_CONSTANTS, stdin: S.stdin, stderr, onSignal: (n, fn) => { S.sig[n] = fn; }, monotonic: () => performance.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (id) => clearTimeout(id),
    stdout: { once: () => {}, write: (s, cb) => { S.out.push(s); cb(); return true; } }, exit: (c) => { if (S.code === null) S.code = c; }, setExitCode: () => {}, now: () => S.clock() };
  S.hooks = { ...CLI.defaultHooks(), launch: { exchanges: { hostaway: S.t.x.hostaway, stripe: S.t.x.stripe }, timeScale: 10 } };
  S.run = async () => { await CLI.main(S.proc, S.hooks); S.line = S.out.length === 1 ? JSON.parse(S.out[0]) : null; return S.line; };
  S.cleanup = async () => {};
  LIVE.push(S);
  return S;
}
const state = async (id) => (await loadIntent(db.app, id)).status;
const claimsHeld = async (id) => Number((await one("SELECT count(*)::int AS n FROM booking.inventory_claims WHERE intent_id = $1 AND released_at IS NULL", [id])).n);
const notifyOps = (id) => all(`SELECT op_type, state, attempts, dispatched_at FROM booking.external_operations WHERE intent_id = $1
  AND (op_type LIKE 'alert.%' OR op_type LIKE 'guest.%' OR op_type LIKE '%notif%') ORDER BY op_type, created_at`, [id]);
const assertNotifyUnsent = async (id, label) => { for (const n of await notifyOps(id)) assert.deepEqual([n.state, n.attempts, n.dispatched_at], ["pending", 0, null], `${label}: ${n.op_type} unsent`); };
const writesAt = (S) => [S.t.x.count("hostaway", "POST", /^\/v1\/reservations$/), S.t.x.count("hostaway", "PUT", /\/statuses\/cancelled$/),
  S.t.x.count("stripe", "POST", /\/cancel$/), S.t.x.count("stripe", "POST", /\/capture$/), S.t.x.count("hostaway", "POST", /^\/v1\/guestPayments\/charges/)];
const appPids = async () => (await all("SELECT pid FROM pg_stat_activity WHERE application_name = 'maravilla-booking'")).map((r) => r.pid);
const noLeak = (S, label) => { const all = [...S.out, ...S.err].join(""); assert.equal(scrub(all), null, `${label}: no secret / login text in stdout / stderr`); };

// =================================================================================================================================
test("E1 the native execute wiring end-to-end in BOTH modes: verified native closure → bound package → owner files → accepted pools / T / creation-only R1 file journal → runReservationAbortR1 → ENDED_RELEASED fully clean; exact sends; honest teardown; no secret in output", async () => {
  for (const connection of ["disconnected", "airbnb"]) {
    const S = await launch({ connection });
    const line = await S.run();
    noLeak(S, connection);
    assert.equal(S.code, 0, `${connection}: ${S.out.join("")}`);
    assert.deepEqual([line.outcome, line.nativeDigest, line.result.schema, line.result.executable], ["EXECUTE_ENDED", NATIVE_DIGEST, "e7-r1-launch-result-v1", true]);
    const r = line.result.run;
    assert.deepEqual([r.ok, r.outcome, r.stopCode, r.journalTerminal, r.journalTail, r.bridgeCalls, r.connection], [true, "ENDED_RELEASED", null, "acknowledged", "KNOWN", 1, connection], JSON.stringify(r));
    assert.deepEqual(r.writes, { cancel: 1, capture: 0, create: 1, record: 0, void: 1 });
    assert.deepEqual(writesAt(S), [1, 1, 1, 0, 0], "create 1 / host-cancel 1 / void 1 / capture 0 / record 0");
    assert.equal(S.t.x.log.filter((e) => /refund/i.test(e.path)).length, 0); assert.deepEqual(S.t.x.violations, []);
    assert.deepEqual(r.release, { state: "cancelled", reason: "TEST_ABORT_REQUESTED", legs: "true/true", claimsHeld: 0 });
    assert.deepEqual([r.r1.kind, r.r1.packageHash, r.r1.exclusionAfter, r.r1.fullyClean, r.r1.preflight.code, r.r1.refence.code], ["r1", S.pk.built.packageHash, "equal", true, "PREFLIGHT_OK", "PREFLIGHT_OK"]);
    assert.deepEqual(S.prompts.map((p) => p.checkpoint), [...S.K], "the owner was asked exactly the mode's three checkpoints");
    assert.ok(S.prompts.every((p) => p.intentId === S.bk.id && p.manifestHash === S.pk.built.packageHash && p.connection === connection));
    assert.deepEqual(line.result.teardown, { finalize: { quiescence: "observed", lockRelease: "unlocked" }, journal: { fileClose: "closed", headLock: "released", journalLock: "released" },
      pools: { app: "ended", report: "ended" } });
    assert.deepEqual([await state(S.bk.id), await claimsHeld(S.bk.id)], ["cancelled", 0]); await assertNotifyUnsent(S.bk.id, connection);
    assert.deepEqual(await appPids(), [], "no launcher connection left open");
    // the creation-only R1 journal on disk: R1 names, diagnostic recovery = the run's head, no permission
    const runId = S.pk.plan.runId;
    assert.deepEqual([readdirSync(S.jd), readdirSync(S.hd)], [[`e7-journal-r1-${runId}.jsonl`], [`e7-head-r1-${runId}.jsonl`]]);
    const b = bindRunPackageR1Journal(S.pk.input, S.clock()).binding;
    const rc = await readJournalForRecoveryR1({ journalDir: S.jd, headDir: S.hd, binding: b, trustedHead: r.trustedHead });
    assert.deepEqual([rc.relation, rc.suppliedHead, rc.chain.status], ["AT_ESCROW_HEAD", "MATCH_TIP", "ENDED"]); assert.ok(Object.values(rc.permission).every((x) => x === false));
  }
});

test("E2 accepted live gates still decide (URL text is not privilege evidence): app login = a REPORT user → refused in P0; PI / quote failures → refused; zero writes; journal created but empty; honest teardown", async () => {
  const cases = [
    // (the two logins must differ textually — G3a refuses identical strings at ingress — so EXTRA labelled disposable-cluster logins are used)
    ["app login is a report user", { appUser: "g3b_report2" }, (c) => ["ROLE_NOT_APP", "POOLS_MISMATCH"].includes(c)],
    ["report login is an app user", { reportUser: "g3b_app2" }, (c) => ["ROLE_NOT_REPORT", "POOLS_MISMATCH"].includes(c)],
    ["PI canceled", { afterBooking: (w, bk) => { w.pis.get(bk.piId).status = "canceled"; } }, (c) => c === "PREFLIGHT_PAYMENT_INTENT_PROOF_FAILED"],
    ["quote moved", { afterBooking: (w) => { w.nightly += 25; } }, (c) => c === "PREFLIGHT_QUOTE_CHANGED"]
  ];
  // OUT-OF-BAND (owner, labelled, disposable cluster only): two extra logins, members of the report / app roles respectively
  for (const [u, r] of [["g3b_report2", "mv_booking_report"], ["g3b_app2", "mv_booking_app"]]) await db.owner.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${u}') THEN CREATE ROLE ${u} LOGIN IN ROLE ${r}; END IF; END $$`);
  for (const [label, o, okCode] of cases) {
    const S = await launch(o);
    const line = await S.run(); noLeak(S, label);
    const r = line.result.run;
    assert.ok(["EXECUTE_REFUSED", "EXECUTE_STOPPED"].includes(line.outcome), `${label}: ${S.out.join("")}`);
    assert.equal(r.ok, false, label); assert.ok(okCode(r.stopCode), `${label}: ${r.stopCode}`);
    assert.deepEqual(writesAt(S), [0, 0, 0, 0, 0], `${label}: no provider write`);
    assert.equal(await state(S.bk.id), "payment_authorized", label);
    assert.deepEqual(line.result.teardown.pools, { app: "ended", report: "ended" }, label);
    assert.deepEqual(await appPids(), [], `${label}: no connection left open`);
  }
});

test("E3 stop / lock loss at the actual boundaries: first SIGINT during the baseline attestation → STOPPED CANCELLED, create never sent; SIGTERM likewise; report lock backend terminated during the attestation → LOCK_LOST; second signal → terminal exit 130", async () => {
  for (const sig of ["SIGINT", "SIGTERM"]) {
    const S = await launch({ onPrompt: (S0, p) => { if (p.checkpoint === "CALENDAR_BASELINE") { S0.sig[sig](); return "NO_ANSWER"; } return null; } });
    const line = await S.run(); noLeak(S, sig);
    // the signal aborts the run's AbortSignal; the native attestation honours it by REJECTING (never a fabricated answer / decline), which the
    // ACCEPTED core records as ATTESTATION_FAILED (first cause) — the launcher reports the interrupt separately (FIRST TAP diagnosis)
    assert.deepEqual([S.code, line.outcome, line.result.run.stopCode, line.interrupted], [6, "EXECUTE_STOPPED", "ATTESTATION_FAILED", true], `${sig}: ${S.out.join("")}`);
    assert.deepEqual(writesAt(S), [0, 0, 0, 0, 0]); assert.equal(await state(S.bk.id), "payment_authorized");
    assert.equal(line.result.teardown.finalize.lockRelease, "unlocked");
  }
  { const S = await launch({ onPrompt: async (S0, p) => {
      if (p.checkpoint !== "CALENDAR_BASELINE") return null;
      const locks = await all("SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND granted");
      for (const l of locks) await db.owner.query("SELECT pg_terminate_backend($1)", [l.pid]);
      await sleep(300); return null; } });
    const line = await S.run(); noLeak(S, "lock");
    assert.deepEqual([line.outcome, line.result.run.stopCode, line.result.run.exclusion], ["EXECUTE_STOPPED", "LOCK_LOST", "lost"], S.out.join(""));
    assert.deepEqual(writesAt(S), [0, 0, 0, 0, 0]); }
  { const S = await launch({ onPrompt: (S0, p) => { if (p.checkpoint === "CALENDAR_BASELINE") { S0.sig.SIGINT(); S0.sig.SIGINT(); return "NO_ANSWER"; } return null; } });
    await S.run();
    assert.equal(S.code, 130, "second signal = terminal exit (tail uncertain, nothing repaired)"); }
});

test("E4 attestation binds the exact run / checkpoint: other-run / other-checkpoint / malformed lines are ignored, DECLINE → OWNER_DECLINED; unknown host-cancel / void send → exactly ONE send, never resent", async () => {
  { const S = await launch({ answer: (S0, p) => [`ATTEST synthetic-other-run ${p.checkpoint} synthetic/x`, `ATTEST ${p.runId} SOME_OTHER synthetic/x`, `ATTEST ${p.runId} ${p.checkpoint} bad ref`,
      `ATTEST ${p.runId} ${p.checkpoint} synthetic/${p.checkpoint.toLowerCase()}`] });
    const line = await S.run(); assert.equal(line.outcome, "EXECUTE_ENDED", S.out.join("")); }
  { const S = await launch({ answer: (S0, p) => (p.checkpoint === "CALENDAR_BLOCKED" ? `DECLINE ${p.runId} ${p.checkpoint}` : `ATTEST ${p.runId} ${p.checkpoint} synthetic/ok`) });
    const line = await S.run();
    assert.deepEqual([line.outcome, line.result.run.stopCode, line.result.run.bridgeCalls], ["EXECUTE_STOPPED", "OWNER_DECLINED", 0], S.out.join(""));
    assert.deepEqual(writesAt(S), [1, 0, 0, 0, 0], "one create; declined before the abort → nothing else"); }
  for (const which of ["cancelReservation", "cancelPaymentIntent"]) {
    const S = await launch({ afterBooking: (w) => { const f = w.exec.K[which];
      w.exec.K[which] = async (...a) => { await f(...a); if (which === "cancelReservation") return { httpStatus: 503, json: { status: "fail" } }; throw httpError(500); }; } });
    const line = await S.run(); noLeak(S, which);
    const [, hc, v] = writesAt(S);
    assert.equal(which === "cancelReservation" ? hc : v, 1, `${which}: one send`); assert.ok(hc <= 1 && v <= 1, `${which}: never resent`);
    assert.ok(["EXECUTE_ENDED", "EXECUTE_STOPPED"].includes(line.outcome), S.out.join(""));
  }
});

test("E5 refusals BEFORE sensitive access (in-process native path): wrong native digest → no launcher import, no file read beyond the closure; wrong package hash / intent → no owner file read (missing files never reported); remote DB without CA and sslmode login → POOL_CONFIG_REFUSED with no connection; existing journal → refused before the run; nothing secret echoed", async () => {
  const missing = join(ownerDir("g3b-missing-"), "missing-owner-file.json");   // existing owner dir (a missing PARENT is CRED_IO — FIRST TAP diagnosis in the boot suite)
  { const S = await launch({ nativeDigest: "0".repeat(64), provider: missing });
    let launcherImported = false; S.hooks = { ...S.hooks, importLauncher: () => { launcherImported = true; return import("../../scripts/e7-connected/run-r1-launcher.mjs"); } };
    const line = await S.run();
    assert.deepEqual([S.code, line.outcome, line.code, line.nativeDigest], [4, "NATIVE_CLOSURE_REFUSED", "NATIVE_DIGEST_MISMATCH", NATIVE_DIGEST]); assert.equal(launcherImported, false); }
  { const S = await launch({ provider: missing }); S.flags[S.flags.indexOf("--expect-package-hash") + 1] = "1".repeat(64); S.proc.argv = ["node", "cli", ...S.flags];
    const line = await S.run();
    assert.deepEqual([line.outcome, line.result.refused], ["EXECUTE_REFUSED", { stage: "package", code: "R1_PACKAGE_HASH_MISMATCH" }], "refused before the (missing) owner files are read"); }
  { const S = await launch({ provider: missing }); S.flags[S.flags.indexOf("--intent") + 1] = "00000000-0000-4000-8000-0000000000ab"; S.proc.argv = ["node", "cli", ...S.flags];
    const line = await S.run(); assert.deepEqual(line.result.refused, { stage: "package", code: "INTENT_MISMATCH" }); }
  { const S = await launch({ provider: missing }); const line = await S.run(); assert.deepEqual(line.result.refused, { stage: "provider-credentials", code: "CRED_MISSING" }); }
  { const S = await launch({ reportLogin: { q: "?sslmode=require" } }); const pids0 = await appPids();
    const line = await S.run(); noLeak(S, "sslmode");
    assert.deepEqual(line.result.refused, { stage: "pool", code: "POOL_CONFIG_REFUSED" }, "the accepted pool refuses URL TLS overrides (owner files must omit sslmode)");
    assert.deepEqual(await appPids(), pids0); assert.deepEqual(writesAt(S), [0, 0, 0, 0, 0]); }
  { const S = await launch(); const files = ownerDir("g3b-remote-");
    const remote = (role, user) => put(files, `${role}.json`, JSON.stringify({ schema: "e7-db-login-v1", role, connectionString: `postgresql://${user}:${CANARY}@db.synthetic.invalid:5432/postgres` }));
    S.flags[S.flags.indexOf("--db-app") + 1] = remote("mv_booking_app", "u_app"); S.flags[S.flags.indexOf("--db-report") + 1] = remote("mv_booking_report", "u_rep"); S.proc.argv = ["node", "cli", ...S.flags];
    const line = await S.run(); noLeak(S, "remote");
    assert.deepEqual(line.result.refused, { stage: "pool", code: "POOL_CONFIG_REFUSED" }, "remote without --db-ca refused at construction (no DNS / connect)"); }
  { const S = await launch(); writeFileSync(join(S.jd, `e7-journal-r1-${S.pk.plan.runId}.jsonl`), ""); chmodSync(join(S.jd, `e7-journal-r1-${S.pk.plan.runId}.jsonl`), 0o600);
    const line = await S.run();
    assert.deepEqual([line.outcome, line.result.refused], ["EXECUTE_REFUSED", { stage: "journal", code: "JOURNAL_EXISTS" }], "creation-only: never reopen / resume");
    assert.deepEqual(line.result.teardown.pools, { app: "ended", report: "ended" }); assert.deepEqual(writesAt(S), [0, 0, 0, 0, 0]); }
});
