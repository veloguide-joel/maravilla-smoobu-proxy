// E7 M2-G2b — runReservationAbortR1 (the THIN R1 consumer: module-minted R1 binding → SAME lock → same DB → empty R1 journal → FRESH G1 preflight
// inside P0 → R1 RUN_STARTED → G fences → reservation → TEST abort → cleanup) on a DISPOSABLE local PG (migrations 0001–0017 incl. the 0017 LOCAL
// candidate; never a shared DB). Contract claude/e7-run-real-r1-g2.md §8–§11. No network, no real provider, no credential file, no env read.
//
// LABELS
//   * REAL: the harness's real mv_booking_app / mv_booking_report logins; the module under test; the accepted G1 binder + preflight; the REAL
//     accepted reservation + compensation workers, operator core / helper and M2-C bridge; the ACCEPTED Slice T transports
//     (createE7HostawaySend / createE7StripeTestSend); the R1 memory journal (createMemoryJournalBound) and the R1 FILE journal (owner-only temp dirs).
//   * SYNTHETIC (TEST-ONLY): world + booking = a LABELLED COPY of test/db/e7-run-core-abort-v2.test.mjs:47–197 (606998 + accepted id formats);
//     the FAKE HTTP exchange + T factories = a LABELLED COPY of test/db/e7-connected-http-stack-rehearsal.test.mjs:207–296 (every write route LOGGED);
//     the harness helpers (timeDriver / FaultPool / FaultClient / terminate / gate) = a LABELLED COPY of test/db/e7-run-core-abort-v2.test.mjs:236–341.
//     The plan / package builder follows test/db/e7-run-preflight-r1.test.mjs bindFor (SYNTHETIC plan, env snapshot, clocks). Credentials are explicit
//     SYNTHETIC strings. Attestations are synthetic (never calendar / Airbnb proof).
//   * HISTORICAL STAND-INS (labelled, disposable DB only): intents created through the accepted repo path with the EXACT ledger Run1 / Run3 intent
//     ids, so the exclusion baseline has rows to fingerprint; Run2 stays ABSENT. DECOYS (labelled): other intents with eligible work.
//   * OUT-OF-BAND MUTATIONS (labelled): the accepted F.ownerManagedHistory / owner UPDATEs (disposable cluster only).
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { readFileSync, mkdtempSync, rmSync, chmodSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
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
import { SQL as FACTS_SQL } from "../../scripts/e7-connected/run-facts.mjs";
import { CHECKPOINTS_BY_CONNECTION } from "../../scripts/e7-connected/run-manifest-v2.mjs";
import { buildRunPackageV1, sourceDigestV1, RUN_PLAN_CLOSURE, HISTORICAL_EXCLUSIONS, ALLOWED_OPS } from "../../scripts/e7-connected/run-plan-v1.mjs";
import { canonicalJson } from "../../scripts/e7-connected/run-manifest.mjs";
import * as R from "../../scripts/e7-connected/run-binding-r1.mjs";
import * as P from "../../scripts/e7-connected/run-preflight-r1.mjs";
import { bindRunPackageR1Journal, createMemoryJournalBound, validateJournalBound, recordHashV2, bindingKindV2 } from "../../scripts/e7-connected/run-journal-memory-v2.mjs";
import { openFileJournalR1, readJournalForRecoveryR1 } from "../../scripts/e7-connected/run-journal-file-v2.mjs";
import { runReservationAbortR1, runAbortRehearsalV2, R1_AFTER_RESERVATION_BUDGET_MS, PHASE_LIMITS } from "../../scripts/e7-connected/run-core-abort-v2.mjs";
import { LIMITS } from "../../scripts/e7-connected/run-guard.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ABORT_LISTING = 606998;
let netAttempts = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { netAttempts += 1; throw new Error("network refused in the offline M2-G2b suite"); };
let db; let reportPool;
const DIRS = [];
before(async () => { db = await startMigratedDatabase(); reportPool = new pg.Pool({ connectionString: db.reportUrl(), max: 8 }); });
after(async () => { globalThis.fetch = realFetch; await reportPool.end().catch(() => {}); await db.close(); for (const d of DIRS) rmSync(d, { recursive: true, force: true }); assert.equal(netAttempts, 0); });

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
/** LABELLED STAND-IN for the FOURTH, non-run exclusion (exact ledger id; actor not established): priced-only through the accepted path
 *  (CREATED → PRICE_CONFIRMED, no session / PI / claim). It is a disposable-DB stand-in, never the shared row. */
const UNATTRIBUTED = HISTORICAL_EXCLUSIONS.unattributedIntents[0];
let unattributedMade = false;
async function ensureUnattributedStandIn(listingId, from, to) {
  if (unattributedMade) return UNATTRIBUTED.intentId;
  const now = Date.now() - 2 * DAY;
  await createIntentRecord(db.app, { id: UNATTRIBUTED.intentId, ref: F.nextRef(), accessTokenHash: F.tokenHash(), environment: "test", now, listingId, from, to, guests: 2 });
  F.ok(await applyEvent(db.app, UNATTRIBUTED.intentId, { type: "PRICE_CONFIRMED", price: F.priceFor({ listingId, from, to, guests: 2, currency: "USD" }) }, { now, actor: "guest" }), "stand-in price");
  unattributedMade = true;
  return UNATTRIBUTED.intentId;
}

let historical = null;
/** labelled historical STAND-INS (exact ledger Run1 / Run3 intent ids) so the exclusion baseline fingerprints real rows; Run2 stays absent */
async function ensureHistorical() {
  if (historical) return historical;
  const base = Date.now() - DAY;
  for (const [id, n] of [[RUN1.intentId, 1], [RUN3.intentId, 3]])
    await createIntentRecord(db.app, { id, ref: F.nextRef(), accessTokenHash: F.tokenHash(), environment: "test", now: base, listingId: ABORT_LISTING,
      from: addDays("2028-01-01", 5 * n), to: addDays("2028-01-01", 5 * n + 2), guests: 2 });
  const u = await ensureUnattributedStandIn(ABORT_LISTING, addDays("2028-01-01", 20), addDays("2028-01-01", 24));   // the fourth (non-run) identity
  historical = { ids: [RUN1.intentId, RUN3.intentId, u] };
  return historical;
}
/** DECOYS (labelled): eligible maintenance work OUTSIDE the run's one intent (same listing, a planted foreign lease, another listing) */
async function decoys() {
  const w = world();
  const d1 = await authorizedBooking(w); const d2 = await authorizedBooking(w); const d3 = await authorizedBooking(w, { listingId: 871777 });
  await db.owner.query("UPDATE booking.intent_work SET work_worker_id = 'decoy-ghost', work_lease_until = now() - interval '1 hour', next_action_at = now() - interval '1 hour' WHERE intent_id = $1", [d2.id]);
  const ids = [d1.id, d2.id, d3.id, ...(await ensureHistorical()).ids];
  const snap = async () => JSON.stringify(await all(`SELECT i.id, i.state, i.version, i.updated_at, w.work_worker_id, w.work_lease_until, w.next_action_at,
      (SELECT json_agg(json_build_array(o.op_type, o.state, o.attempts, o.lease_worker_id, o.dispatched_at) ORDER BY o.created_at, o.id) FROM booking.external_operations o WHERE o.intent_id = i.id) AS ops,
      (SELECT count(*) FROM booking.inventory_claims c WHERE c.intent_id = i.id AND c.released_at IS NULL) AS claims
    FROM booking.intents i LEFT JOIN booking.intent_work w ON w.intent_id = i.id WHERE i.id = ANY($1::uuid[]) ORDER BY i.id`, [ids]));
  return { ids, before: await snap(), snap };
}

const LIVE = [];
afterEach(async () => { for (const S of LIVE.splice(0)) await S.cleanup(); });
/** one R1 scenario: fresh world / booking / R1 package / R1 journal (memory or FILE) / accepted T transports over the fake exchange */
async function r1Scenario(o = {}) {
  await ensureHistorical();
  const w = o.w ?? world();
  if (o.mode) Object.assign(w.mode, o.mode);
  const bk = o.bk ?? await authorizedBooking(w);
  if (o.afterBooking) await o.afterBooking(w, bk);
  const T = timeDriver(o.K ?? 10);
  const connection = o.connection ?? "disconnected";
  const tl = [];
  const S = { w, bk, T, tl, connection, K: CHECKPOINTS_BY_CONNECTION[connection], attestCalls: [], overrideCalls: {}, hooks: o.hooks ?? {}, jump: 0 };
  // the v1 rehearsal's default business clock (behind real time, following virtual time, capped 5 s behind real time) + a TEST-ONLY jump
  S.clock = () => Math.floor(Math.min(bk.base + 10 * SEC + T.now(), Date.now() - 5 * SEC)) + S.jump;
  S.pk = r1InputFor(bk, bk.base + 5 * SEC, { connection, over: o.planOver });
  S.input = o.inputOver ? o.inputOver(S.pk.input) : S.pk.input;
  // the journal's OWN binding, minted by the journal module from the same reviewed input (the core mints its own at its fresh clock)
  const jb = bindRunPackageR1Journal(S.pk.input, S.clock());
  assert.equal(jb.ok, true, JSON.stringify(jb));
  S.jbinding = jb.binding;
  if (o.file) {
    S.jd = mkdtempSync(join(tmpdir(), "g2b-j-")); S.hd = mkdtempSync(join(tmpdir(), "g2b-h-")); chmodSync(S.jd, 0o700); chmodSync(S.hd, 0o700); DIRS.push(S.jd, S.hd);
    S.fj = await openFileJournalR1({ journalDir: S.jd, headDir: S.hd, binding: S.jbinding });
    assert.equal(S.fj.ok, true, JSON.stringify(S.fj));
  } else {
    S.jm = createMemoryJournalBound({ binding: S.jbinding, ...(o.preload ? { preload: o.preload } : {}) });
    assert.equal(S.jm.ok, true);
  }
  const base = o.file ? S.fj.journal : S.jm.journal;
  S.app = new FaultPool(o.appPool ?? db.app, "app", tl);
  S.report = new FaultPool(o.reportPool ?? reportPool, "report", tl);
  S.t = httpTransports(w, o.exchange);
  S.ac = new AbortController();
  const attest = (cp, request, x) => {
    S.attestCalls.push({ cp, request: { ...request }, signalIsRun: x.signal === S.ac.signal }); tl.push(`A:${cp}`);
    const f = o.attest && o.attest[cp];
    return f ? f(S, request) : Promise.resolve({ ok: true, evidenceRef: `synthetic/${cp.toLowerCase()}` });
  };
  S.journal = {
    append: (rec) => {
      S.overrideCalls[rec.event] = (S.overrideCalls[rec.event] ?? 0) + 1;
      tl.push(`J:${rec.event}${rec.phase ? `:${rec.phase}` : ""}`);
      if (o.override && o.override[rec.event]) return o.override[rec.event](S, rec, () => base.append(rec));        // TEST-ONLY ACK override
      const h = S.hooks[rec.event];
      return h ? (async () => { await h(S, rec); return base.append(rec); })() : base.append(rec);
    },
    read: () => (S.hooks.read ? (async () => { await S.hooks.read(S); return base.read(); })() : base.read())
  };
  S.opts = { r1: S.input, intentId: bk.id, pools: { app: S.app, report: S.report }, transports: { hostaway: S.t.hostaway, stripe: S.t.stripe }, journal: S.journal,
    trustedHead: null, attest, clock: () => S.clock(), monotonic: T.deps.monotonic, timers: T.deps.timers, signal: S.ac.signal };
  if (o.optsOver) Object.assign(S.opts, o.optsOver);
  S.run = async () => { S.result = await runReservationAbortR1(S.opts); return S.result; };
  S.records = async () => (await base.read()).records;
  S.events = async () => (await S.records()).map((r) => `${r.event}${r.phase ? `:${r.phase}` : ""}${r.attestation ? `:${r.attestation.checkpoint}` : ""}${r.state ? `:${r.state}` : ""}`);
  S.cleanup = async () => { if (S.fj) await S.fj.close(); await S.app.cleanup(); await S.report.cleanup(); };
  LIVE.push(S);
  return S;
}
const plainResult = (r) => JSON.parse(JSON.stringify({ ...r, finalize: undefined }));
const state = async (id) => (await loadIntent(db.app, id)).status;
const capRow = async (id) => one("SELECT state, attempts, dispatched_at, lease_worker_id, lease_until FROM booking.external_operations WHERE intent_id = $1 AND op_type = 'stripe.capture_payment_intent'", [id]);
const claimsHeld = async (id) => Number((await one("SELECT count(*)::int AS n FROM booking.inventory_claims WHERE intent_id = $1 AND released_at IS NULL", [id])).n);
const appliedAborts = async (id) => Number((await one("SELECT count(*)::int AS n FROM booking.intent_applied_events WHERE intent_id = $1 AND event_type = 'TEST_ABORT_REQUESTED'", [id])).n);
const notifyOps = (id) => all(`SELECT op_type, state, attempts, dispatched_at FROM booking.external_operations WHERE intent_id = $1
  AND (op_type LIKE 'alert.%' OR op_type LIKE 'guest.%' OR op_type LIKE '%notif%') ORDER BY op_type, created_at`, [id]);
const assertNotifyUnsent = async (id, label) => { for (const n of await notifyOps(id)) assert.deepEqual([n.state, n.attempts, n.dispatched_at], ["pending", 0, null], `${label}: ${n.op_type} unsent`); };
const cleanupSteps = async (S) => (await S.records()).filter((x) => x.event === "STEP_STARTED" && x.phase === "cleanup").length;
/** scoped provider WRITE counts at the fake exchange: [create, host-cancel, PI cancel (void), capture, offline charge] */
const writesAt = (S) => [S.t.x.count("hostaway", "POST", /^\/v1\/reservations$/), S.t.x.count("hostaway", "PUT", /\/statuses\/cancelled$/),
  S.t.x.count("stripe", "POST", /\/cancel$/), S.t.x.count("stripe", "POST", /\/capture$/), S.t.x.count("hostaway", "POST", /^\/v1\/guestPayments\/charges/)];
const PREFLIGHT_FORMS = (L) => ["stripe GET /v1/account", "stripe GET /v1/payment_intents/{pi}", `hostaway GET /v1/listings/${L}`, `hostaway GET /v1/listings/${L}/calendar`,
  `hostaway POST /v1/listings/${L}/calendar/priceDetails`, "hostaway GET /v1/reservations"];
const exch = (S) => S.t.x.log.map((e) => `${e.provider} ${e.method} ${e.path}`);
const noProtectedTraffic = (S) => assert.ok(S.t.x.log.every((e) => !PROTECTED.some((id) => e.path.includes(String(id)) || e.search.includes(String(id)))));
const r1h = (r) => createHash("sha256").update(`e7-run-journal-r1\n${canonicalJson(r)}`, "utf8").digest("hex");
/** OUT-OF-BAND (owner, labelled): the authorization deadline set relative to the run's BUSINESS clock */
const setDeadline = (S, deltaMs) => F.ownerManagedHistory(db.owner, "UPDATE booking.intents SET authorization_deadline = to_timestamp($2::double precision / 1000) WHERE id = $1",
  [S.bk.id, S.clock() + deltaMs]);
/** OUT-OF-BAND (owner, labelled): a fingerprinted column of a historical stand-in really changes */
const touchStandIn = (id) => F.ownerManagedHistory(db.owner, "UPDATE booking.intents SET updated_at = updated_at + interval '1 second' WHERE id = $1", [id]);
/** a REFUSED-in-P0 result: no RUN_STARTED, no write, lock released */
async function assertRefusedP0(S, r, code, label) {
  assert.deepEqual([r.ok, r.outcome, r.stopCode, r.phase], [false, "REFUSED", code, "P0"], `${label}: ${JSON.stringify(plainResult(r))}`);
  assert.deepEqual(await S.events(), [], `${label}: no record`);
  assert.deepEqual(writesAt(S), [0, 0, 0, 0, 0], `${label}: no provider write`);
  assert.equal(await state(S.bk.id), "payment_authorized", label);
  await r.finalize();
}

// =================================================================================================================================
test("G1 the whole R1 lifecycle in BOTH modes with decoys + stand-ins: module-minted R1 binding → lock → same DB → empty journal → FRESH preflight in P0 → R1 RUN_STARTED → baseline → post-attest preflight fence → reservation (fenced) → blocked → bridge ONCE → ACKed receipt → gate → cleanup → release (LOCAL 0017) → exclusion re-read EQUAL → reopened → ENDED_RELEASED (fully clean)", async () => {
  const dz = await decoys();
  for (const connection of ["disconnected", "airbnb"]) {
    let cap0 = null;
    const S = await r1Scenario({ connection, attest: { [CHECKPOINTS_BY_CONNECTION[connection][1]]: async (S0, req) => { cap0 = await capRow(S0.bk.id); return { ok: true, evidenceRef: `synthetic/${req.checkpoint.toLowerCase()}` }; } } });
    const r = await S.run();
    const ev = await S.events(); const recs = await S.records();
    console.log(`# G1 ${connection} journal: ${JSON.stringify(ev)}`);
    console.log(`# G1 ${connection} exchanges: ${JSON.stringify(exch(S))}`);
    assert.deepEqual([r.ok, r.outcome, r.stopCode, r.ownerCleanupRequired, r.effectsKnown, r.journalTerminal, r.journalTail, r.bridgeCalls, r.connection],
      [true, "ENDED_RELEASED", null, null, true, "acknowledged", "KNOWN", 1, connection], JSON.stringify(plainResult(r)));
    // R1 identity everywhere: every record is R1-labelled, hashed in the R1 domain, and the final journal validates anchored to the run's head
    assert.ok(recs.every((x) => x.manifestVersion === "e7-run-package-r1" && x.manifestHash === S.pk.built.packageHash));
    assert.deepEqual(Object.keys(recs[0]).filter((k) => !["v", "seq", "prevHash", "manifestVersion", "connection", "runId", "intentId", "manifestHash", "baselineCommit", "at", "event"].includes(k)).sort(),
      ["executorDigest", "preflightDigest"], "R1 RUN_STARTED carries EXACTLY the two digests");
    assert.equal(recs[0].executorDigest, S.pk.input.expected.executorDigest); assert.equal(recs[0].preflightDigest, r.r1.preflight.preflightDigest);
    for (let i = 1; i < recs.length; i++) assert.equal(recs[i].prevHash, r1h(recs[i - 1]), `R1-domain chain at ${i + 1}`);
    assert.deepEqual(r.trustedHead, { seq: recs.length, hash: r1h(recs.at(-1)) });
    const fin = validateJournalBound(recs, S.jbinding, { trustedHead: { ...r.trustedHead } });
    assert.deepEqual([fin.ok, fin.status, fin.anchored], [true, "ENDED", true]);
    // the R1 diagnostics: fresh preflight in P0, a second (post-attestation) preflight fence, fences before each step / the bridge, re-read equal
    assert.deepEqual([r.r1.kind, r.r1.packageHash, r.r1.executorDigest, r.r1.preflight.code, r.r1.refence.code, r.r1.refence.baselineDigest, r.r1.exclusionAfter, r.r1.fullyClean, r.r1.expiredAtCleanup],
      ["r1", S.pk.built.packageHash, S.pk.input.expected.executorDigest, "PREFLIGHT_OK", "PREFLIGHT_OK", r.r1.preflight.baselineDigest, "equal", true, false]);
    assert.ok(r.r1.fences >= 3, `fences ${r.r1.fences}`);
    assert.notEqual(r.r1.preflight.preflightDigest, r.r1.refence.preflightDigest, "two FRESH preflights (time-bound digests), never a copied verdict");
    // ordering: RUN_STARTED only after the preflight's six reads; the post-attestation fence's six reads come BEFORE the first create
    const X = exch(S); const L = ABORT_LISTING;
    assert.deepEqual(X.slice(0, 6), PREFLIGHT_FORMS(L)); assert.deepEqual(X.slice(6, 12), PREFLIGHT_FORMS(L));
    assert.ok(X.indexOf("hostaway POST /v1/reservations") > 11, "the create follows both preflights");
    // exact scoped provider writes: ONE create, ONE host-cancel, ONE authorization void; capture / offline charge / refund ZERO
    assert.deepEqual(writesAt(S), [1, 1, 1, 0, 0]);
    assert.deepEqual({ ...r.writes }, { ...W0, create: 1, cancel: 1, void: 1 });
    assert.equal(S.t.x.log.filter((e) => /refund/i.test(e.path)).length, 0); assert.deepEqual(S.t.x.violations, []);
    noProtectedTraffic(S);
    assert.deepEqual(S.attestCalls.map((a) => a.cp), [...S.K]);
    const iB = ev.indexOf(`ATTESTED:${S.K[1]}`);
    assert.deepEqual(ev.slice(iB - 1, iB + 3), ["PHASE_ENDED:reservation:reservation_confirmed", `ATTESTED:${S.K[1]}`, "ABORT_REQUEST_STARTED", "ABORT_ACCEPTED"]);
    assert.deepEqual(ev.slice(-3), ["PHASE_ENDED:cleanup:cancelled", `ATTESTED:${S.K[2]}`, "RUN_ENDED"]);
    assert.deepEqual([r.bridge.outcome, r.bridge.receiptLanding, r.bridge.operatorCoreInvocations, r.bridge.requestHelperInvocations, r.bridge.dbAbortApplied],
      ["ABORT_ACCEPTED_JOURNALED", "ACKED", 1, 1, true]);
    assert.deepEqual({ ...r.release }, { state: "cancelled", reason: "TEST_ABORT_REQUESTED", legs: "true/true", claimsHeld: 0 });
    assert.equal(await state(S.bk.id), "cancelled"); assert.equal(await claimsHeld(S.bk.id), 0); assert.equal(await appliedAborts(S.bk.id), 1);
    assert.deepEqual(await capRow(S.bk.id), cap0); assert.deepEqual([cap0.state, cap0.attempts, cap0.dispatched_at], ["pending", 0, null], "capture row pristine");
    await assertNotifyUnsent(S.bk.id, connection);
    assert.equal((await r.finalize()).lockRelease, "unlocked");
  }
  assert.equal(await dz.snap(), dz.before, "decoys + historical stand-ins byte-identical (no adoption, no maintenance, no protected / historical change)");
});

test("G2 refusals BEFORE any DB / journal / transport / attest work: tampered / stale / unbound package, tampered closure, wrong pins, v2 manifest / mixed options, copied binding, phase plan", async () => {
  const S0 = await r1Scenario();
  const t = new Uint8Array(S0.pk.input.packageBytes); t[t.length - 3] ^= 1;
  const tamper = (arr, i) => arr.map((e, j) => (j === i ? { path: e.path, bytes: (() => { const b = new Uint8Array(e.bytes); b[0] ^= 1; return b; })() } : e));
  const fOnly = RUN_PLAN_CLOSURE.findIndex((p) => !R.R1_EXECUTOR_CLOSURE.includes(p));
  const cases = [
    ["package tamper", (i) => ({ ...i, packageBytes: t }), (c) => ["R1_PACKAGE_BYTES_INVALID", "R1_PACKAGE_MISMATCH", "R1_PACKAGE_INVALID"].includes(c)],
    ["package hash pin", (i) => ({ ...i, expected: { ...i.expected, packageHash: "0".repeat(64) } }), (c) => c === "R1_PACKAGE_HASH_MISMATCH"],
    ["executor pin (unbound executor)", (i) => ({ ...i, expected: { ...i.expected, executorDigest: "0".repeat(64) } }), (c) => c === "R1_EXECUTOR_DIGEST_MISMATCH"],
    ["foundation closure tamper", (i) => ({ ...i, foundationSources: tamper(i.foundationSources, fOnly) }), (c) => c === "R1_RECOMPUTE_REFUSED"],
    ["executor closure tamper", (i) => ({ ...i, executorSources: tamper(i.executorSources, 0) }), (c) => c === "R1_SNAPSHOT_OVERLAP_MISMATCH"],
    ["closure missing file", (i) => ({ ...i, executorSources: i.executorSources.slice(1) }), (c) => c === "R1_SOURCES_INVALID"],
    ["env snapshot", (i) => ({ ...i, envSnapshot: { ...ENV(), nodeVersion: "20.0.0" } }), (c) => c === "R1_RECOMPUTE_REFUSED"]
  ];
  for (const [label, mut, ok] of cases) {
    const S = await r1Scenario({ inputOver: mut });
    const r = await S.run();
    assert.deepEqual([r.ok, r.outcome, r.phase], [false, "REFUSED", "P0"], label); assert.ok(ok(r.stopCode), `${label}: ${r.stopCode}`);
    assert.deepEqual([S.app.connects, S.report.connects, S.t.x.log.length, S.attestCalls.length, (await S.events()).length], [0, 0, 0, 0, 0], `${label}: zero starts`);
    assert.equal(r.r1, undefined, `${label}: no R1 run state`);
  }
  // STALE: the package's quote cap elapsed at the run's fresh clock (re-measured at exec, not at build)
  { const S = await r1Scenario(); S.jump = 40 * MIN; const r = await S.run();
    assert.deepEqual([r.outcome, r.stopCode, S.app.connects + S.report.connects + S.t.x.log.length], ["REFUSED", "R1_STALE_AT_EXEC", 0], JSON.stringify(plainResult(r))); }
  // UNBOUND plan (binding null) → the binder's R1_UNBOUND
  { const S = await r1Scenario(); S.opts.r1 = r1InputFor(S.bk, S.bk.base + 5 * SEC, { over: (p) => { p.binding = null; } }).input;
    const r = await S.run(); assert.equal(r.stopCode, "R1_UNBOUND"); assert.equal(S.app.connects + S.report.connects + S.t.x.log.length, 0); }
  // option hygiene: a v2 manifest, a mixed R1+manifest option set, a COPIED binding in place of the input, a G1 PASS verdict object → refused, never a fallback
  const v2opts = { ...S0.opts }; delete v2opts.r1;
  for (const [label, opts] of [["v2 manifest key", { ...v2opts, manifest: {} }], ["mixed", { ...S0.opts, manifest: {} }], ["copied binding", { ...S0.opts, r1: { ...S0.jbinding } }],
    ["binding itself", { ...S0.opts, r1: S0.jbinding }], ["pass verdict", { ...S0.opts, r1: { code: "PREFLIGHT_OK", ok: true, packageHash: S0.pk.built.packageHash } }]]) {
    const r = await runReservationAbortR1(opts);
    assert.deepEqual([r.ok, r.outcome], [false, "REFUSED"], label); assert.ok(["OPTIONS_INVALID", "R1_INPUT_INVALID"].includes(r.stopCode), `${label}: ${r.stopCode}`);
  }
  assert.equal(S0.app.connects + S0.report.connects + S0.t.x.log.length, 0);
  // the v2 entrypoint never accepts an R1 input (no relabel / downgrade): options refused before any start
  const rv = await runAbortRehearsalV2({ ...v2opts, manifest: S0.pk.input });
  assert.deepEqual([rv.ok, rv.outcome, rv.phase], [false, "REFUSED", "P0"]); assert.notEqual(rv.stopCode, null);
  assert.equal(bindingKindV2(S0.jbinding), "r1"); assert.equal(bindingKindV2({ ...S0.jbinding }), null);
});

test("G3 P0 preflight / account / proof / quote / margin failures, a non-empty or v2 journal, and an intent mismatch → REFUSED in P0: no RUN_STARTED, zero writes, lock released", async () => {
  const cases = [
    ["account", (S) => { S.w.exec.C.retrieveAccount = async () => ({ object: "account", id: "acct_1OtherAccount0" }); }, ["PREFLIGHT_ACCOUNT_MISMATCH", "PREFLIGHT_PROVIDER_FAILURE"]],
    ["pi proof", (S) => { S.w.pis.get(S.bk.piId).status = "canceled"; }, ["PREFLIGHT_PAYMENT_INTENT_PROOF_FAILED"]],
    ["quote", (S) => { S.w.nightly += 25; }, ["PREFLIGHT_QUOTE_CHANGED"]],
    ["margin", (S) => setDeadline(S, P.AUTOMATIC_WORK_BUDGET_MS - MIN), ["PREFLIGHT_AUTHORIZATION_MARGIN_INSUFFICIENT"]]
  ];
  for (const [label, mut, codes] of cases) {
    const S = await r1Scenario();
    await mut(S);
    const r = await S.run();
    assert.ok(codes.includes(r.stopCode), `${label}: ${r.stopCode} ${JSON.stringify(plainResult(r))}`);
    assert.deepEqual([r.r1.preflight.code, r.r1.refence], [r.stopCode.replace(/^PREFLIGHT_/, ""), null], label);
    await assertRefusedP0(S, r, r.stopCode, label);
  }
  // a prior R1 history (a landed RUN_STARTED) refuses — only an EMPTY journal starts; nothing read from the providers
  { const S = await r1Scenario();
    await S.journal.append({ v: 2, seq: 1, prevHash: "0".repeat(64), ...S.jbinding.identity, at: S.clock(), event: "RUN_STARTED", preflightDigest: "1".repeat(64), executorDigest: S.jbinding.r1.executorDigest });
    const r = await S.run(); assert.deepEqual([r.outcome, r.stopCode, S.t.x.log.length], ["REFUSED", "RESTART_AMBIGUOUS", 0], JSON.stringify(plainResult(r))); await r.finalize(); }
  // a v2-labelled preload in the R1 journal → malformed history refused (no relabel / adoption)
  { const pre = [{ v: 2, seq: 1, prevHash: "0".repeat(64), manifestVersion: "e7-run-manifest-v2", connection: "disconnected", runId: "synthetic-v2-0001", intentId: "00000000-0000-4000-8000-000000000001",
      manifestHash: "3".repeat(64), baselineCommit: BASE_COMMIT, at: 1, event: "RUN_STARTED" }];
    const S = await r1Scenario({ preload: pre }); const r = await S.run();
    assert.equal(r.outcome, "REFUSED"); assert.notEqual(r.stopCode, null); assert.equal(S.t.x.log.length, 0); assert.deepEqual(writesAt(S), [0, 0, 0, 0, 0]); await r.finalize(); }
  // intent mismatch (the options' intent ≠ the package's) → refused before any start
  { const S = await r1Scenario(); S.opts.intentId = "00000000-0000-4000-8000-0000000000ab"; const r = await S.run();
    assert.deepEqual([r.stopCode, S.app.connects + S.report.connects], ["INTENT_MISMATCH", 0]); }
});

test("G4 changes AFTER attestation and BEFORE the worker: quote / authorization / exclusion changed during the baseline attestation (post-attest preflight fence); authorization / price moved between that fence and STEP_STARTED (DB fence); clock past the margin at the ACTUAL worker start", async () => {
  const stopAt = async (S, r, code, label, { stepStarted = false } = {}) => {
    const ev = await S.events();
    assert.deepEqual([r.outcome, r.stopCode], ["STOPPED", code], `${label}: ${JSON.stringify(plainResult(r))}`);
    assert.deepEqual(writesAt(S), [0, 0, 0, 0, 0], `${label}: the create never sent`);
    assert.equal(ev.includes("STEP_STARTED:reservation"), stepStarted, `${label}: STEP_STARTED ${stepStarted}`);
    assert.equal(ev.at(-1), "RUN_STOPPED", `${label}: one terminal over the KNOWN tail`);
    assert.equal(r.ownerCleanupRequired, stepStarted ? "reservedNotConfirmed" : null, `${label}: conservative key`);
    assert.equal(await state(S.bk.id), "payment_authorized");
    await r.finalize();
  };
  const during = (fn) => ({ attest: { CALENDAR_BASELINE: async (S0, req) => { await fn(S0); return { ok: true, evidenceRef: "synthetic/calendar_baseline" }; } } });
  { const S = await r1Scenario(during(async (S0) => { S0.w.nightly += 25; })); const r = await S.run();
    await stopAt(S, r, "PREFLIGHT_QUOTE_CHANGED", "quote during attestation"); assert.equal(r.r1.refence.code, "QUOTE_CHANGED"); }
  { const S = await r1Scenario(during(async (S0) => { await setDeadline(S0, P.AUTOMATIC_WORK_BUDGET_MS - MIN); }));
    const r = await S.run(); await stopAt(S, r, "PREFLIGHT_AUTHORIZATION_MARGIN_INSUFFICIENT", "authorization during attestation"); }
  { const S = await r1Scenario(during(async (S0) => { S0.w.pis.get(S0.bk.piId).status = "canceled"; })); const r = await S.run();
    await stopAt(S, r, "PREFLIGHT_PAYMENT_INTENT_PROOF_FAILED", "PI voided outside during attestation"); }
  { const S = await r1Scenario(during(async () => { await touchStandIn(RUN1.intentId); }));
    const r = await S.run(); await stopAt(S, r, "EXCLUSION_BASELINE_CHANGED", "exclusion row touched during attestation");
    assert.notEqual(r.r1.refence.baselineDigest, r.r1.preflight.baselineDigest); }
  { const S = await r1Scenario(during(async () => { await touchStandIn(UNATTRIBUTED.intentId); }));   // the FOURTH (non-run) identity drifts after attestation
    const r = await S.run(); await stopAt(S, r, "EXCLUSION_BASELINE_CHANGED", "fourth (unattributed) intent touched during attestation");
    assert.notEqual(r.r1.refence.baselineDigest, r.r1.preflight.baselineDigest); }
  // between the post-attest preflight fence and STEP_STARTED (after the guest read of the first reservation step): the DB fence
  // the third guest read = the first reservation step's prepare (after P0 preflight #1 and the post-attest preflight #2)
  // (the price_snapshot_matches CHECK binds quoteHash to the quote_hash column: both move together)
  const PRICE_SQL = "UPDATE booking.intents SET price_snapshot = jsonb_set(price_snapshot, '{quoteHash}', to_jsonb(repeat('0', 64))), quote_hash = repeat('0', 64) WHERE id = $1";
  for (const [label, mut, code] of [
    ["authorization moved", (S) => setDeadline(S, PHASE_LIMITS.reservation.stepBudgetMs + LIMITS.STEP_MARGIN_MS + R1_AFTER_RESERVATION_BUDGET_MS), "AUTHORIZATION_MARGIN_INSUFFICIENT"],
    ["price snapshot moved", (S) => F.ownerManagedHistory(db.owner, PRICE_SQL, [S.bk.id]), "QUOTE_CHANGED"]
  ]) {
    const S = await r1Scenario();
    S.app.addFault({ kind: "query", sql: FACTS_SQL.GUEST, nth: 3, mode: "after", fn: async () => { await mut(S); } });
    const r = await S.run(); await stopAt(S, r, code, `DB fence: ${label}`);
  }
  // the business clock passes the margin AFTER STEP_STARTED landed and before the worker is invoked → stop at the ACTUAL start (create never sent)
  { const S = await r1Scenario({ hooks: { STEP_STARTED: async (S0, rec) => { if (rec.phase === "reservation") S0.jump = 7 * DAY; } } });
    const r = await S.run(); await stopAt(S, r, "AUTHORIZATION_MARGIN_INSUFFICIENT", "clock at the actual worker start", { stepStarted: true }); }
});

test("G5 lock / signal at the actual starts: during the P0 preflight (provider start), during the baseline attestation, at the bridge's start ACK (M8 facade) — no operator, no cleanup, no send", async () => {
  // signal aborted at the preflight's FIRST provider exchange → the preflight's own blocked() refuses every later start; REFUSED in P0
  { const S = await r1Scenario();
    const f = S.w.exec.C.retrieveAccount; S.w.exec.C.retrieveAccount = async () => { S.ac.abort(); return f(); };
    const r = await S.run();
    assert.deepEqual([r.outcome, r.stopCode], ["REFUSED", "CANCELLED"], JSON.stringify(plainResult(r)));
    assert.deepEqual(exch(S), ["stripe GET /v1/account"], "no later provider start"); assert.deepEqual(await S.events(), []); await r.finalize(); }
  // lock lost during the baseline attestation → no post-attest preflight, no reservation
  { const S = await r1Scenario({ attest: { CALENDAR_BASELINE: async (S0) => { await terminate(S0.report.clients[0]); return { ok: true, evidenceRef: "synthetic/calendar_baseline" }; } } });
    const r = await S.run();
    assert.deepEqual([r.outcome, r.stopCode, r.exclusion], ["STOPPED", "LOCK_LOST", "lost"], JSON.stringify(plainResult(r)));
    assert.equal(S.t.x.log.length, 6, "only the P0 preflight's reads"); assert.deepEqual(writesAt(S), [0, 0, 0, 0, 0]); await r.finalize(); }
  // signal aborted right after the bridge's start record is ACKed → STOPPED_BEFORE_OPERATOR, operator core 0, no helper write, no cleanup
  for (const how of ["signal", "lock"]) {
    const S = await r1Scenario({ connection: how === "lock" ? "airbnb" : "disconnected", override: { ABORT_REQUEST_STARTED: async (S0, rec, real) => {
      const ack = await real(); if (how === "signal") S0.ac.abort(); else await terminate(S0.report.clients[0]); return ack; } } });
    const r = await S.run();
    assert.deepEqual([r.outcome, r.stopCode, r.bridge.outcome, r.bridge.operatorCoreInvocations, r.journalTail], ["STOPPED", how === "signal" ? "CANCELLED" : "LOCK_LOST", "STOPPED_BEFORE_OPERATOR", 0, "KNOWN"],
      `${how}: ${JSON.stringify(plainResult(r))}`);
    assert.deepEqual([await appliedAborts(S.bk.id), await state(S.bk.id), await cleanupSteps(S), ...writesAt(S)], [0, "reservation_confirmed", 0, 1, 0, 0, 0, 0]);
    assert.deepEqual((await S.events()).slice(-2), ["ABORT_REQUEST_STARTED", "RUN_STOPPED"]);
    assert.equal(r.r1.fullyClean, false);
    await assertNotifyUnsent(S.bk.id, how); await r.finalize().catch(() => {});
  }
});

test("G6 unknown create → reads / stop, never a second create, bridge never called; unknown host-cancel / void → accepted resolution only: exactly ONE send each, no new key, no adoption", async () => {
  { const S = await r1Scenario({ connection: "airbnb", mode: { create: "appliedThen503" } });
    const r = await S.run();
    console.log(`# G6a journal: ${JSON.stringify(await S.events())}`);
    assert.equal(r.outcome, "STOPPED"); assert.ok(["OPEN_CASE", "UNKNOWN_WRITE"].includes(r.stopCode), r.stopCode);
    assert.deepEqual([S.w.writes.createReservation, r.bridgeCalls, await appliedAborts(S.bk.id), ...writesAt(S).slice(1)], [1, 0, 0, 0, 0, 0, 0]);
    assert.equal(r.ownerCleanupRequired, "reservedNotConfirmed"); assert.equal(r.r1.fullyClean, false); await r.finalize(); }
  for (const which of ["cancelReservation", "cancelPaymentIntent"]) {
    const S = await r1Scenario({ afterBooking: (w) => {
      const f = w.exec.K[which];
      w.exec.K[which] = async (...a) => { const out = await f(...a); if (which === "cancelReservation") return { httpStatus: 503, json: { status: "fail", result: "applied then 503 (mock)" } }; throw httpError(500); };
    } });
    const r = await S.run();
    const keys = S.t.x.log.filter((e) => e.provider === "stripe" && e.method === "POST").map((e) => e.idempotencyKey);
    console.log(`# G6 ${which}: ${JSON.stringify([r.outcome, r.stopCode, writesAt(S), await state(S.bk.id)])}`);
    const [, hc, v] = writesAt(S);
    assert.equal(which === "cancelReservation" ? hc : v, 1, `${which}: exactly ONE send of the unknown write`);
    assert.ok(hc <= 1 && v <= 1, `${which}: never resent`); assert.equal(new Set(keys).size, keys.length, `${which}: no new idempotency key for a resend`);
    assert.deepEqual(writesAt(S).slice(3), [0, 0]);
    if (r.outcome === "ENDED_RELEASED") assert.deepEqual({ ...r.release }, { state: "cancelled", reason: "TEST_ABORT_REQUESTED", legs: "true/true", claimsHeld: 0 }, `${which}: release only with proof`);
    else assert.equal(r.r1.fullyClean, false);
    await assertNotifyUnsent(S.bk.id, which); await r.finalize().catch(() => {});
  }
});

test("G7 start / receipt ACK faults (reject / hang / late / landed_hang / lost): cleanup 0, no resend, tail UNKNOWN → no terminal; DB outcome preserved; never fully clean", async () => {
  const fault = (mode) => async (S0, rec, real) => {
    if (mode === "reject") throw new Error("synthetic journal fault");
    if (mode === "hang") { setTimeout(() => S0.T.advance(6_000), 50); return new Promise(() => {}); }
    if (mode === "late") { setTimeout(() => S0.T.advance(6_000), 50); await sleep(400); return real(); }
    if (mode === "landed_hang") { await real(); setTimeout(() => S0.T.advance(6_000), 50); return new Promise(() => {}); }
    await real(); return undefined;                                          // lost ACK: landed, no ACK value
  };
  for (const [event, wantStop] of [["ABORT_REQUEST_STARTED", "ABORT_START_UNACKED"], ["ABORT_ACCEPTED", "ABORT_RECEIPT_UNACKED"]]) {
    for (const mode of ["reject", "hang", "late", "landed_hang", "lost"]) {
      const label = `${event}/${mode}`;
      const S = await r1Scenario({ connection: mode.length % 2 ? "airbnb" : "disconnected", override: { [event]: fault(mode) } });
      const r = await S.run();
      if (mode === "late") await sleep(600);
      const ev = (await S.records()).map((x) => x.event);
      assert.deepEqual([r.outcome, r.stopCode, r.journalTail, r.bridgeCalls], ["STOPPED", wantStop, "UNKNOWN", 1], `${label}: ${JSON.stringify(plainResult(r))}`);
      assert.equal(ev.includes("RUN_STOPPED"), false, `${label}: no terminal over an unknown tail`);
      assert.equal(S.overrideCalls[event], 1, `${label}: never resent`);
      assert.deepEqual([await cleanupSteps(S), ...writesAt(S).slice(1)], [0, 0, 0, 0, 0], `${label}: no cleanup / settlement`);
      if (event === "ABORT_REQUEST_STARTED") assert.deepEqual([r.bridge.operatorCoreInvocations, await appliedAborts(S.bk.id), await state(S.bk.id)], [0, 0, "reservation_confirmed"], label);
      else assert.deepEqual([r.bridge.dbAbortApplied, await appliedAborts(S.bk.id), await state(S.bk.id), r.bridge.postcheck.intentState], [true, 1, "capture_failed", "capture_failed"], `${label}: DB outcome preserved`);
      assert.equal(r.r1.fullyClean, false);
      await assertNotifyUnsent(S.bk.id, label); await r.finalize().catch(() => {});
    }
  }
});

test("G8 expiry during cleanup: authorization past its deadline after the abort → cleanup NOT blocked by expiry (reads + the accepted worker's own proof / state / idempotency fences decide), recorded, never presumed harmless", async () => {
  const S = await r1Scenario({ hooks: { ABORT_ACCEPTED: async (S0) => { await setDeadline(S0, -MIN); } } });
  const r = await S.run();
  console.log(`# G8 ${JSON.stringify([r.outcome, r.stopCode, writesAt(S), r.r1 && r.r1.expiredAtCleanup, await state(S.bk.id)])}`);
  assert.notEqual(r.stopCode, "AUTHORIZATION_MARGIN_INSUFFICIENT", "expiry never blocks cleanup");
  assert.ok((await cleanupSteps(S)) >= 1, "cleanup ran");
  assert.equal(r.r1.expiredAtCleanup, true, "expiry at cleanup recorded");
  const [, hc, v, cap, rec] = writesAt(S);
  assert.ok(hc <= 1 && v <= 1, "at most one host-cancel / void"); assert.deepEqual([cap, rec], [0, 0]);
  if (r.outcome === "ENDED_RELEASED") assert.equal(r.release.legs, "true/true");
  await assertNotifyUnsent(S.bk.id, "expiry"); await r.finalize().catch(() => {});
});

test("G9 release + exclusion re-read: CHANGED (a stand-in row touched after cleanup) and UNREAD (the re-read's statement fails) are ENDED_RELEASED but NEVER fully clean; reservation_failed void-only route kept (no bridge), re-read equal", async () => {
  { const S = await r1Scenario({ hooks: { PHASE_ENDED: async (S0, rec) => { if (rec.phase === "cleanup") await touchStandIn(RUN3.intentId); } } });
    const r = await S.run();
    assert.deepEqual([r.ok, r.outcome, r.r1.exclusionAfter, r.r1.fullyClean, r.release.legs], [true, "ENDED_RELEASED", "changed", false, "true/true"], JSON.stringify(plainResult(r)));
    await r.finalize(); }
  { const S = await r1Scenario();
    S.report.addFault({ kind: "query", sql: P.BASELINE_FAMILIES[0].sql, nth: 3, mode: "reject" });
    const r = await S.run();
    assert.deepEqual([r.ok, r.outcome, r.r1.exclusionAfter, r.r1.fullyClean, r.release.legs], [true, "ENDED_RELEASED", "unread", false, "true/true"], JSON.stringify(plainResult(r)));
    await r.finalize(); }
  // reservation_failed: the price moves AFTER both preflights (inside the worker's own pricing) → the accepted void-only route
  { const S = await r1Scenario();
    S.app.addFault({ kind: "query", sql: FACTS_SQL.GUEST, nth: 3, mode: "after", fn: async () => { S.w.nightly += 25; } });
    const r = await S.run();
    console.log(`# G9c journal: ${JSON.stringify(await S.events())}`);
    assert.deepEqual([r.ok, r.outcome, r.bridgeCalls, r.r1.exclusionAfter, r.r1.fullyClean], [true, "ENDED_RELEASED", 0, "equal", true], JSON.stringify(plainResult(r)));
    assert.deepEqual(writesAt(S), [0, 0, 1, 0, 0]);
    assert.deepEqual(S.attestCalls.map((a) => a.cp), [S.K[0]]);
    await r.finalize(); }
});

test("G10 the R1 FILE journal under the real consumer: full lifecycle round-trip, R1 head lines, diagnostic recovery with NO permission; a second open refuses (creation only)", async () => {
  const S = await r1Scenario({ file: true });
  const r = await S.run();
  assert.deepEqual([r.ok, r.outcome, r.r1.fullyClean], [true, "ENDED_RELEASED", true], JSON.stringify(plainResult(r)));
  await r.finalize();
  const n = (await S.records()).length;
  await S.fj.close(); S.fj = null;
  const rc = await readJournalForRecoveryR1({ journalDir: S.jd, headDir: S.hd, binding: S.jbinding, trustedHead: { ...r.trustedHead } });
  assert.deepEqual([rc.ok, rc.version, rc.relation, rc.records, rc.suppliedHead, rc.chain.status], [true, "e7-run-journal-file-r1", "AT_ESCROW_HEAD", n, "MATCH_TIP", "ENDED"], JSON.stringify(rc));
  assert.ok(Object.values(rc.permission).every((x) => x === false));
  assert.ok(rc.unresolved.includes("TERMINAL_RECORDED"));
  const again = await openFileJournalR1({ journalDir: S.jd, headDir: S.hd, binding: S.jbinding });
  assert.equal(again.code, "JOURNAL_EXISTS");
  const first = JSON.parse(readFileSync(join(S.jd, `e7-journal-r1-${S.jbinding.identity.runId}.jsonl`), "utf8").split("\n")[0]);
  assert.deepEqual([first.event, first.manifestVersion, recordHashV2(first)], ["RUN_STARTED", "e7-run-package-r1", r1h(first)]);
  const heads = readFileSync(join(S.hd, `e7-head-r1-${S.jbinding.identity.runId}.jsonl`), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(heads.length, n); assert.ok(heads.every((h, i) => h.v === "r1" && h.seq === i + 1));
});

// ---------------------------------------------------------------------------------------------------------------------------------
// root review of cc5e6cf: the POST-CLEANUP exclusion re-read's client ownership. Faults are ARMED at the cleanup PHASE_ENDED append (after the
// last report snapshot of the run; the release proof uses the app pool), so the FIRST report client acquired after arming is the re-read's.
const FAM = P.BASELINE_FAMILIES.map((f) => f.sql);
async function rereadScenario(arm) {
  const S = await r1Scenario({ hooks: { PHASE_ENDED: async (S0, rec) => { if (rec.phase === "cleanup") { S0.armIdx = S0.report.clients.length; await arm(S0); } } } });
  const r = await S.run();
  const c = S.report.clients[S.armIdx];
  assert.ok(c, "the re-read acquired a client");
  const sql = S.report.log.filter((x) => x.via === c.id).map((x) => x.sql);
  const rel = c.events.filter((e) => e.startsWith("release"));
  return { S, r, c, sql, rel };
}
/** the booking result is the run's own: release proved, claim released, no resend, ENDED_RELEASED kept (unless the run itself was stopped) */
async function bookingKept(S, r, label, outcome = "ENDED_RELEASED") {
  assert.equal(r.outcome, outcome, `${label}: ${JSON.stringify(plainResult(r))}`);
  assert.deepEqual({ ...r.release }, { state: "cancelled", reason: "TEST_ABORT_REQUESTED", legs: "true/true", claimsHeld: 0 }, `${label}: release proof kept`);
  assert.deepEqual([await state(S.bk.id), await claimsHeld(S.bk.id), await appliedAborts(S.bk.id)], ["cancelled", 0, 1], `${label}: DB outcome kept`);
  assert.deepEqual(writesAt(S), [1, 1, 1, 0, 0], `${label}: no resend`);
  await assertNotifyUnsent(S.bk.id, label);
}
const BEGIN = P.SQL_BEGIN; const COMMIT = P.SQL_COMMIT;

test("G11 post-cleanup exclusion re-read ownership: reject / hang / late / loss / stop mid-transaction, BEGIN reject, COMMIT hang → destroyed ONCE, NO further SQL, never released; unread + not fully clean; booking outcome kept. Controls: healthy equal → COMMIT + release(); acknowledged refusal → COMMIT + release()", async (t) => {
  const destroyedOnly = (x, label) => { assert.deepEqual(x.rel, ["release(true)"], `${label}: exactly one destroy, no release(): ${JSON.stringify(x.c.events)}`); };
  const unread = (x, label, at, uncertainty = "none") => {
    assert.deepEqual([x.r.r1.exclusionAfter, x.r.r1.fullyClean, x.r.r1.exclusionRead.disposition, x.r.r1.exclusionRead.at, x.r.r1.exclusionRead.uncertainty],
      ["unread", false, "destroyed", at, uncertainty], `${label}: ${JSON.stringify(x.r.r1.exclusionRead)}`);
  };
  // (1) a baseline statement REJECTED → [BEGIN, F0] only
  await t.test("G11.1 a baseline statement REJECTED → [BEGIN, F0] only", async () => { const x = await rereadScenario((S0) => { S0.report.addFault({ kind: "query", sql: FAM[0], mode: "reject" }); });
    assert.deepEqual(x.sql, [BEGIN, FAM[0]], "reject: no COMMIT / ROLLBACK / SELECT after the failure"); destroyedOnly(x, "reject"); unread(x, "reject", "baseline");
    await bookingKept(x.S, x.r, "reject"); await x.r.finalize(); });
  // (2) a baseline statement HANGS → the bounded observation times out; destroyed, statement may still run
  await t.test("G11.2 a baseline statement HANGS → the bounded observation times out; destro", async () => { const x = await rereadScenario((S0) => { S0.report.addFault({ kind: "query", sql: FAM[3], mode: "hang" }); });
    assert.deepEqual(x.sql, [BEGIN, ...FAM.slice(0, 4)], "hang: nothing after the hung statement"); destroyedOnly(x, "hang");
    unread(x, "hang", "baseline", "statement_may_still_run"); assert.equal(x.r.r1.exclusionRead.code, "TIMEOUT_DB_READ");
    await bookingKept(x.S, x.r, "hang"); await x.r.finalize(); });
  // (3) a baseline statement settles LATE (after the bound) → same as a timeout; its late reply changes nothing
  await t.test("G11.3 a baseline statement settles LATE (after the bound) → same as a timeou", async () => { const x = await rereadScenario((S0) => { S0.report.addFault({ kind: "query", sql: FAM[5], mode: "after", fn: async () => { await sleep(LIMITS.STATEMENT_MS / 10 + 400); } }); });
    await sleep(600);
    assert.deepEqual(x.sql, [BEGIN, ...FAM.slice(0, 6)]); destroyedOnly(x, "late"); unread(x, "late", "baseline", "statement_may_still_run");
    await bookingKept(x.S, x.r, "late"); await x.r.finalize(); });
  // (4) the re-read client is LOST mid-transaction (backend terminated by the owner after F1) → the tracker's one destroy; no further SQL
  await t.test("G11.4 the re-read client is LOST mid-transaction (backend terminated by the ", async () => { const x = await rereadScenario((S0) => { S0.report.addFault({ kind: "query", sql: FAM[1], mode: "after", fn: async (client) => { await terminate(client); } }); });
    assert.deepEqual(x.sql, [BEGIN, FAM[0], FAM[1]], "loss: nothing issued on the lost client"); destroyedOnly(x, "loss"); unread(x, "loss", "baseline");
    await bookingKept(x.S, x.r, "loss"); await x.r.finalize(); });
  // (5) the run is STOPPED (native signal) mid-transaction → no further SQL, destroyed; the run reports the stop, the booking outcome stays proved
  await t.test("G11.5 the run is STOPPED (native signal) mid-transaction → no further SQL, d", async () => { const x = await rereadScenario((S0) => { S0.report.addFault({ kind: "query", sql: FAM[1], mode: "after", fn: async () => { S0.ac.abort(); } }); });
    assert.deepEqual(x.sql, [BEGIN, FAM[0], FAM[1]], "stop: nothing after the stop"); destroyedOnly(x, "stop"); unread(x, "stop", "baseline");
    assert.equal(x.r.stopCode, "CANCELLED"); await bookingKept(x.S, x.r, "stop", "STOPPED"); assert.equal(x.r.r1.fullyClean, false); await x.r.finalize(); });
  // (6) BEGIN itself rejected → destroyed, nothing else
  await t.test("G11.6 BEGIN itself rejected → destroyed, nothing else", async () => { const x = await rereadScenario((S0) => { S0.report.addFault({ kind: "query", sql: BEGIN, mode: "reject" }); });
    assert.deepEqual(x.sql, [BEGIN]); destroyedOnly(x, "begin"); unread(x, "begin", "begin"); await bookingKept(x.S, x.r, "begin"); await x.r.finalize(); });
  // (7) COMMIT hangs → a COMMIT timeout is itself uncertain: destroyed, no ROLLBACK, unread
  await t.test("G11.7 COMMIT hangs → a COMMIT timeout is itself uncertain: destroyed, no ROL", async () => { const x = await rereadScenario((S0) => { S0.report.addFault({ kind: "query", sql: COMMIT, mode: "hang" }); });
    assert.deepEqual(x.sql, [BEGIN, ...FAM, COMMIT]); destroyedOnly(x, "commit"); unread(x, "commit", "commit", "statement_may_still_run");
    await bookingKept(x.S, x.r, "commit"); await x.r.finalize(); });
  // CONTROL (8) healthy → [BEGIN, every family, COMMIT], released ONCE for reuse, equal, fully clean
  await t.test("G11.8 healthy → [BEGIN, every family, COMMIT], released ONCE for reuse, equa", async () => { const x = await rereadScenario(() => {});
    assert.deepEqual(x.sql, [BEGIN, ...FAM, COMMIT]); assert.deepEqual(x.rel, ["release()"], "healthy: released once, never destroyed");
    assert.deepEqual([x.r.r1.exclusionAfter, x.r.r1.fullyClean, x.r.r1.exclusionRead.disposition, x.r.r1.exclusionRead.code], ["equal", true, "released", null]);
    await bookingKept(x.S, x.r, "healthy"); await x.r.finalize(); });
  // CONTROL (9) ACKNOWLEDGED refusal (a settled statement whose rows the accepted reader refuses) → its read-only transaction is closed with COMMIT
  await t.test("G11.9 ACKNOWLEDGED refusal (a settled statement whose rows the accepted read", async () => { const x = await rereadScenario((S0) => { S0.report.addFault({ kind: "query", sql: FAM[0], mode: "mutate", fn: (res) => ({ ...res, rows: [{ key: "k", intent_id: null, fingerprint: "nothex" }] }) }); });
    assert.deepEqual(x.sql, [BEGIN, FAM[0], COMMIT]); assert.deepEqual(x.rel, ["release()"]);
    assert.deepEqual([x.r.r1.exclusionAfter, x.r.r1.fullyClean, x.r.r1.exclusionRead.disposition, x.r.r1.exclusionRead.code], ["unread", false, "released", "DB_RESULT_INVALID"]);
    await bookingKept(x.S, x.r, "acknowledged refusal"); await x.r.finalize(); });
});
