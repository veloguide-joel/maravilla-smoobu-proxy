// E7 N2 reconcile-only runner (R-B, Step A) — real disposable PG + the ACCEPTED worker / repo / operator / cleanup + FAKE provider only.
// The harness below (through the "// ===== end" helpers) is a LABELLED VERBATIM COPY of test/db/e7-run-r1-native-execute.test.mjs lines 1–520 @ a9b5efd6
// (used to produce a REAL stopped native R1 run); everything after "R-B TESTS" is new.
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
import * as L from "../../scripts/e7-connected/run-r1-launcher.mjs";                  // ADDED (de6285b5 P3): exported pre-check SQL for the mapping proofs
import { LOCK_KEY } from "../../scripts/e7-connected/run-core.mjs";

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
  // CHANGED (root review of 128ac08, H1): the owner reply carries the prompt's FRESH token — `ATTEST <runId> <checkpoint> <token> <evidenceRef>`
  const answer = o.answer ?? ((S0, p) => `ATTEST ${p.runId} ${p.checkpoint} ${p.token} synthetic/${p.checkpoint.toLowerCase()}`);
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
  S.hooks = { ...CLI.defaultHooks(), launch: { exchanges: { hostaway: S.t.x.hostaway, stripe: S.t.x.stripe }, timeScale: 10, loopbackEndpointsForTests: true } };   // CHANGED (de6285b5): disposable-PG loopback seam, IN-PROCESS only
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
// T1b integration: validate the separate observation through REAL launcher output, without turning a client event into backend-exit proof.
const assertAcquiredEnds = (line, slots) => {
  const observations = line.result.acquiredClientEnd;
  assert.deepEqual(Object.keys(observations).sort(), ["app", "report"]);
  for (const slot of ["app", "report"]) {
    const o = observations[slot];
    assert.deepEqual(Object.keys(o).sort(), ["acquired", "endObserved", "scope", "status"]);
    assert.equal(o.scope, "ACQUIRED_ONLY");
    assert.ok(Number.isSafeInteger(o.acquired) && o.acquired >= 0);
    assert.ok(Number.isSafeInteger(o.endObserved) && o.endObserved >= 0 && o.endObserved <= o.acquired);
    assert.equal(o.status, o.acquired === 0 ? "NONE_ACQUIRED" : o.endObserved === o.acquired ? "ALL_ACQUIRED_END_OBSERVED" : "SOME_ACQUIRED_END_UNOBSERVED");
    if (slots[slot] === "none") assert.equal(o.acquired, 0, `${slot}: no successful client was acquired`);
    else assert.ok(o.acquired > 0, `${slot}: successful acquisition was observed`);
  }
};

// =================================================================================================================================
// ===== end of the labelled harness copy =====

// =================================================================================================================================
// R-B TESTS (new). The stopped native run is produced by the REAL native path (labelled fault: the confirming by-id read returns 503), exactly
// the PR61 N2 shape. R-B then runs against the SAME disposable PG with the accepted worker and the fake provider (HTTP-level exchange through
// the ACCEPTED Hostaway send). Calendar / attestation answers are synthetic test evidence. Nothing here is live.
import { runReconcileR1, validatePlanR1, nativeStoppedInReservationPhase, OWN_LOCK_SQL, LIMITS as RB } from "../../scripts/e7-connected/reconcile-core-r1.mjs";
import { createReconcileExecutorsR1 } from "../../scripts/e7-connected/reconcile-executors-r1.mjs";
import { readReconcileJournalR1, journalName, openReconcileJournalR1 } from "../../scripts/e7-connected/reconcile-journal-r1.mjs";
import { requestTestAbort } from "../../lib/booking-db/test-abort.js";
import { buildAbortExpectation } from "../../scripts/e7-operator/test-abort.mjs";
import { runCleanupStep } from "../../lib/booking-db/compensation-worker.js";
import { _internal as RW } from "../../lib/booking-db/reservation-worker.js";

const ENV_ABORT = Object.freeze({ VERCEL_ENV: "development", MV_E7_TEST_ABORT: "enabled" });
const tr = async (id) => all("SELECT version_after, event_type, event_id FROM booking.intent_transitions WHERE intent_id = $1 ORDER BY version_after", [id]);
const opsAll = (id) => all("SELECT id::text AS id, op_type, state, attempts, result_ref FROM booking.external_operations WHERE intent_id = $1 ORDER BY created_at, id", [id]);
const dbSnap = async (id) => JSON.stringify({ i: await one("SELECT state, version, updated_at FROM booking.intents WHERE id = $1", [id]), t: await tr(id), o: await opsAll(id),
  e: await all("SELECT e.id, e.status FROM booking.provider_evidence e JOIN booking.external_operations o ON o.id = e.read_operation_id WHERE o.intent_id = $1 ORDER BY e.id", [id]) });
const stripeCalls = (S) => S.t.x.log.filter((e) => e.provider === "stripe").length;
const hostawayWrites = (S) => S.t.x.log.filter((e) => e.provider === "hostaway" && e.method !== "GET").length;
let rbN = 0;

/** a REAL stopped native run in the N2 shape; returns S plus the original retrieve (restored for R-B unless asked) */
async function stoppedRun({ restore = true } = {}) {
  const w = world(); w.mode.create = "noEcho";
  const realRetrieve = w.exec.R.retrieveReservation;
  const S = await launch({ w, afterBooking: (w0) => { w0.exec.R.retrieveReservation = async () => ({ httpStatus: 503, json: { status: "fail" } }); } });   // LABELLED TEST FAULT
  const line = await S.run();
  const r = line.result.run;
  assert.deepEqual([r.outcome, r.stopCode, r.ownerCleanupRequired], ["STOPPED", "READ_FAILED", "reservedNotConfirmed"], JSON.stringify(r));
  if (restore) w.exec.R.retrieveReservation = realRetrieve;
  S.realRetrieve = realRetrieve; S.native = r;
  return S;
}
/** R-B plan derived from persisted facts (what ROOT's read-only facts SQL would supply) */
async function planFor(S, over = {}) {
  rbN += 1;
  const i = await loadIntent(db.app, S.bk.id);
  const c = (await opsAll(S.bk.id)).find((o) => o.op_type === "hostaway.create_reservation");
  const a = await one("SELECT id::text AS id FROM booking.hostaway_reservation_attempts WHERE intent_id = $1", [S.bk.id]);
  return { runId: `rb-test-${String(rbN).padStart(4, "0")}`, nativeRunId: S.pk.plan.runId, nativePackageHash: S.pk.built.packageHash, nativeExecClock: S.bk.base + 10 * SEC,
    intentId: i.id, ref: i.ref, listingId: i.listingId, currency: i.price.currency, from: i.from, to: i.to, guests: i.guests, totalMinor: i.price.finalTotalMinor,
    paymentIntentId: i.payment.paymentIntentId, reservationId: c.result_ref, createOpId: c.id, attemptId: a.id, expectedVersion: i.version, refFieldId: REF_FIELD,
    rateBps: S.bk.price.rateBps, ...over };
}
async function rb(S, o = {}) {
  const plan = o.plan ?? await planFor(S, o.over);
  const jdir = o.journalDir ?? ownerDir("rb-j-");
  const r = await runReconcileR1({ plan, pools: { app: db.app, report: o.report ?? reportPool }, hostawaySend: o.send ?? S.t.hostaway.send, clock: o.clock ?? (() => S.clock()),
    monotonic: o.monotonic, sleep: o.sleep, journalOpen: o.journalOpen, journalDir: jdir, uid: process.getuid(),
    native: o.native ?? { packageInput: S.pk.input, journalDir: S.jd, headDir: S.hd, trustedHead: S.native.trustedHead }, hooks: o.hooks ?? {} });
  return { r, plan, jdir };
}
const assertNoWrite = async (S, before, label) => assert.equal(await dbSnap(S.bk.id), before, `${label}: zero DB writes`);
const advisoryLocks = async () => Number((await one("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'")).n);
/** teardown contract for every non-success: no session lock leaked, cleanup never handed off, journal ends with a terminal record when it can */
const settledLocks = async () => { for (let k = 0; k < 40; k++) { const n = await advisoryLocks(); if (n === 0) return 0; await new Promise((res) => setTimeout(res, 50)); } return advisoryLocks(); };
const assertTeardown = async (r, label) => { assert.equal(await settledLocks(), 0, `${label}: no advisory lock left`); assert.equal(r.cleanup, "NOT_HANDED_OFF", label);
  assert.notEqual(r.outcome, "RECONCILED_CONFIRMED", label); assert.ok(["released", "not_acquired", "unlock_failed_connection_destroyed", "session_error_connection_destroyed"].includes(r.lock), `${label}: ${r.lock}`); };

// ---------------------------------------------------------------------------------------------------------------------------------
test("RB1 happy: stopped N2 shape → R-B (precheck · ≤5 accepted steps (measured 3) · FINAL paired readback after the DB change) → RECONCILED_CONFIRMED with GET-only provider calls; then the SEPARATE accepted cleanup settles both legs once", async () => {
  const S = await stoppedRun();
  const s0 = stripeCalls(S); const w0 = hostawayWrites(S);
  const { r, plan, jdir } = await rb(S);
  assert.deepEqual([r.outcome, r.code, r.violations], ["RECONCILED_CONFIRMED", null, []], JSON.stringify(r));
  assert.equal(r.steps.length <= RB.maxSteps, true); assert.equal(r.steps.length, 3, `measured normal path: ${JSON.stringify(r.steps)}`);
  assert.deepEqual(r.steps.map((x) => x.actions.join("+")), ["RECOVERY:READ:hostaway.retrieve_reservation+WAIT:NO_READ_DUE",
    "RECOVERY:READ:hostaway.retrieve_reservation+READ:hostaway.retrieve_reservation:found", "RECOVERY:RESERVATION_SUCCEEDED"]);
  assert.deepEqual(r.queuedEffects, [{ opType: "stripe.capture_payment_intent", state: "pending", attempts: 0, dispatched: false }], "the accepted capture effect is queued, pristine, REPORTED");
  assert.deepEqual(r.dbEvidence, { byRefSessionFresh: false, byIdSessionFresh: true }, "F-REC1 reported: the worker confirmed on the stopped run's by-ref evidence; R-B's own readbacks are session-fresh");
  assert.ok(r.getLog.every((g) => g.httpStatus === 200), JSON.stringify(r.getLog));
  assert.ok(r.getLog.every((g) => g.path === "/reservations" || g.path === `/reservations/${plan.reservationId}`), "GET allowlist only");
  assert.equal(r.gets, r.getLog.length); assert.ok(r.gets <= RB.maxGets);
  assert.deepEqual([stripeCalls(S) - s0, hostawayWrites(S) - w0, S.w.writes.createReservation], [0, 0, 1], "no Stripe call, no Hostaway write, create stays 1");
  assert.deepEqual([r.dbState, r.exclusionAfter, r.cleanup], ["reservation_confirmed", "equal", "REQUIRES_OWN_PLAN_AND_FRESH_PROOFS"]);
  assert.deepEqual(r.liveEffects, { hostawayReservation: "active_at_final_readback", stripeAuthorization: "held_per_db_not_observed", claim: "held" });
  assert.ok(r.final.lookupObservedAt > Math.max(r.precheck.lookupObservedAt, r.precheck.byIdObservedAt), "final observed after the session floor");
  assert.equal(typeof r.dbEvidence.byRefSessionFresh, "boolean"); assert.equal(typeof r.dbEvidence.byIdSessionFresh, "boolean");
  const t = await tr(S.bk.id); assert.equal(t.at(-1).event_type, "RESERVATION_SUCCEEDED"); assert.equal(t.filter((x) => x.event_type === "RECOVER_INTERRUPTED").length, 0);
  assert.equal((await one("SELECT state FROM booking.hostaway_reservation_attempts WHERE intent_id = $1", [S.bk.id])).state, "succeeded");
  assert.equal(await claimsHeld(S.bk.id), 1, "R-B never releases the claim");
  const j = await readReconcileJournalR1(`${jdir}/${journalName(plan.runId)}`);
  assert.equal(j.ok, true); assert.deepEqual([j.records[0].type, j.records.at(-2).type, j.records.at(-1).type], ["RUN_STARTED", "ENDED", "TEARDOWN"]);
  assert.deepEqual([j.records.at(-2).data.provisional, j.records.at(-1).data.outcome, j.records.at(-1).data.lock], [true, "RECONCILED_CONFIRMED", "released"]);
  assert.deepEqual(r.journalHead, j.head);
  assert.deepEqual(await appPids(), [], "no connection left open");
  // ---- the SEPARATE accepted cleanup (operator abort + compensation worker), its own expectation from fresh persisted facts ----
  const i = await loadIntent(db.app, S.bk.id);
  const co = (await all("SELECT result_ref, payload FROM booking.external_operations WHERE intent_id = $1 AND op_type = 'stripe.create_checkout_session' AND state = 'succeeded'", [S.bk.id]))[0];
  const e = buildAbortExpectation({ intentId: i.id, expectedVersion: i.version, listingId: i.listingId, from: i.from, to: i.to, guests: i.guests, currency: "USD",
    finalTotalMinor: i.price.finalTotalMinor, authorizedMinor: i.payment.amountMinor, paymentIntentId: i.payment.paymentIntentId, sessionId: co.result_ref,
    attemptId: co.payload.paymentAttemptId, reservationId: i.reservation.reservationId, approvalRef: "rb-test-separate-cleanup" });
  const ab = await requestTestAbort(db.app, i.id, { now: S.clock(), env: ENV_ABORT, operator: e });
  assert.equal(ab.ok, true, ab.error);
  for (let k = 0; k < 8 && (await state(S.bk.id)) !== "cancelled"; k++) {
    await runCleanupStep(db.app, { workerId: "rb-test-cln", env: { VERCEL_ENV: "development", MV_E7_COMPENSATION_WORKER: "enabled" },
      adapterConfig: { allowedListingIds: [ABORT_LISTING], refFieldId: REF_FIELD, channelId: 2000, currency: "USD" }, listings: new Map([[ABORT_LISTING, { currency: "USD", timeZone: TZ }]]),
      executors: S.w.exec.K, clock: () => S.clock(), stripeAccountId: ACCT, intentId: S.bk.id });
  }
  assert.deepEqual([await state(S.bk.id), await claimsHeld(S.bk.id), S.w.writes.cancelReservation, S.w.writes.cancelPaymentIntent, S.w.writes.createReservation],
    ["cancelled", 0, 1, 1, 1], "both legs settled exactly once by the separate accepted cleanup");
  await assertNotifyUnsent(S.bk.id, "RB1");
});

test("RB2 duplicate ref present at session start (added AFTER the native stop) → STOPPED at the PRECHECK, zero DB writes, zero worker steps", async () => {
  const S = await stoppedRun();
  const rid = [...S.w.res.keys()][0]; const r0 = S.w.res.get(rid); S.w.res.set(rid + 7, { ...r0, id: rid + 7 });   // a second reservation carrying our ref
  const before = await dbSnap(S.bk.id);
  const { r } = await rb(S);
  assert.deepEqual([r.outcome, r.code, r.steps.length, r.cleanup], ["STOPPED", "DUPLICATE_REF", 0, "NOT_HANDED_OFF"], JSON.stringify(r));
  await assertNoWrite(S, before, "RB2");
});

test("RB3 changes AFTER the precheck: duplicate added before the worker steps / reservation cancelled after the DB reconciliation → the FINAL paired readback STOPS; actual DB state reported, never success or handoff", async () => {
  { const S = await stoppedRun();
    const { r } = await rb(S, { hooks: { afterPrecheck: () => { const rid = [...S.w.res.keys()][0]; S.w.res.set(rid + 9, { ...S.w.res.get(rid), id: rid + 9 }); } } });
    assert.equal(r.outcome, "STOPPED", JSON.stringify(r)); assert.equal(r.cleanup, "NOT_HANDED_OFF");
    // F-REC1: the accepted planner may already have confirmed on older by-ref evidence — reported honestly, not rolled back
    assert.deepEqual([r.code, r.dbState, r.steps.at(-1).actions.join("+")], ["FINAL_DUPLICATE_REF", "reservation_confirmed", "RECOVERY:RESERVATION_SUCCEEDED"],
      "F-REC1 concretely: the accepted planner confirmed on the stopped run's by-ref evidence; only R-B's FINAL readback catches the duplicate");
    assert.equal(r.dbState, await state(S.bk.id), "reported DB state = actual DB state"); }
  { const S = await stoppedRun();
    const { r } = await rb(S, { hooks: { afterReconciled: () => { S.w.res.get([...S.w.res.keys()][0]).status = "cancelled"; } } });
    assert.deepEqual([r.outcome, r.code, r.dbState, r.cleanup], ["STOPPED", "FINAL_LOOKUP_CANCELLED", "reservation_confirmed", "NOT_HANDED_OFF"], JSON.stringify(r));
    assert.equal(r.liveEffects.hostawayReservation, "unverified"); }
});

test("RB4 cancelled / gone (404 / not found) / 503 at session start → STOPPED before any worker step, zero DB writes, no Hostaway write", async () => {
  for (const [label, mut, code] of [["cancelled", (w, rid) => { w.res.get(rid).status = "cancelled"; }, "LOOKUP_CANCELLED"],
    ["gone", (w, rid) => { w.res.delete(rid); }, "LOOKUP_NOT_FOUND"],
    ["503", (w) => { w.exec.R.lookupPage = async () => ({ httpStatus: 503, json: { status: "fail" } }); }, "PROVIDER_UNAVAILABLE"]]) {
    const S = await stoppedRun(); mut(S.w, [...S.w.res.keys()][0]);
    const before = await dbSnap(S.bk.id); const w0 = hostawayWrites(S);
    const { r } = await rb(S);
    assert.deepEqual([r.outcome, r.code, r.steps.length], ["STOPPED", code, 0], `${label}: ${JSON.stringify(r)}`);
    await assertNoWrite(S, before, label); assert.equal(hostawayWrites(S), w0);
  }
  // 503 on the worker's own read (after a good precheck) → stop at the FIRST error (no 30-minute retry loop)
  { const S = await stoppedRun();
    const { r } = await rb(S, { hooks: { afterPrecheck: () => { S.w.exec.R.retrieveReservation = async () => ({ httpStatus: 503, json: { status: "fail" } }); } } });
    assert.deepEqual([r.outcome, r.code, r.steps.length], ["STOPPED", "PROVIDER_UNAVAILABLE", 2], JSON.stringify(r));   // step 1 requests the read; step 2 runs it → first error stops
    assert.equal(r.getLog.filter((g) => g.httpStatus === 503).length, 1, "exactly one failing GET, then stop");
    assert.equal(r.dbState, "reservation_pending"); }
});

test("RB5 plan / identity refusals: other id, protected id, amount, listing, version, create op, PI → REFUSED in preflight with ZERO DB writes and ZERO provider calls; wrong ref field and provider identity mismatch → STOPPED at the precheck with zero DB writes", async () => {
  const S = await stoppedRun();
  const before = await dbSnap(S.bk.id); const g0 = S.t.x.log.length;
  for (const [over, code] of [[{ reservationId: "999999991" }, "CREATE_RESULT_REF_MISMATCH"], [{ reservationId: "71072615" }, "PLAN_RESERVATION_PROTECTED"],
    [{ totalMinor: 1 }, "INTENT_AMOUNT_MISMATCH"], [{ listingId: 603566 }, "PLAN_LISTING_NOT_ALLOWED"], [{ expectedVersion: 1 }, "VERSION_MOVED"],
    [{ createOpId: "00000000-0000-4000-8000-000000000001" }, "CREATE_OP_MISMATCH"], [{ paymentIntentId: "pi_otherOTHER1" }, "NATIVE_BINDING_MISMATCH"]]) {
    const { r } = await rb(S, { over });
    assert.deepEqual([r.outcome, r.code], ["REFUSED", code], JSON.stringify(over));
  }
  assert.equal(S.t.x.log.length, g0, "no provider call on any refusal"); await assertNoWrite(S, before, "RB5");
  // wrong ref custom-field id in the plan → the lookup cannot see our ref on the reservation → STOPPED at the precheck, zero DB writes
  { const { r } = await rb(S, { over: { refFieldId: REF_FIELD + 1 } });
    assert.deepEqual([r.outcome, r.code, r.steps.length], ["STOPPED", "LOOKUP_NOT_FOUND", 0], JSON.stringify(r)); await assertNoWrite(S, before, "RB5 wrong ref field"); }
  // provider total differs from the intent → STOPPED at the precheck (never adopted)
  const rid = [...S.w.res.keys()][0]; S.w.res.get(rid).totalPrice += 1;
  const { r } = await rb(S);
  assert.deepEqual([r.outcome, r.code, r.steps.length], ["STOPPED", "LOOKUP_IDENTITY_MISMATCH", 0], JSON.stringify(r)); await assertNoWrite(S, before, "RB5 provider mismatch");
  assert.equal(validatePlanR1({}), "PLAN_SHAPE");
});

test("RB6 other lineages are REFUSED with ZERO writes: ambiguous create (applied then 503 → unknown / no result_ref), a run that ENDED normally", async () => {
  { const w = world(); w.mode.create = "appliedThen503";
    const S = await launch({ w }); const line = await S.run(); S.native = line.result.run;
    const before = await dbSnap(S.bk.id);
    assert.equal(validatePlanR1(await planFor(S)), "PLAN_RESERVATION_ID", "no persisted result_ref: no bound id can even be planned");
    // even with the provider's real id supplied, the DB shape (unknown / ambiguous create) is refused with zero writes
    const { r } = await rb(S, { over: { reservationId: String([...S.w.res.keys()][0]) } });
    assert.equal(r.outcome, "REFUSED", JSON.stringify(r));
    assert.ok(["NATIVE_RUN_NOT_PROVEN_STOPPED", "STATE_NOT_V1", "CREATE_OUTCOME_AMBIGUOUS", "HISTORY_NOT_V1"].includes(r.code), r.code);
    S.rb6code = r.code;
    await assertNoWrite(S, before, "ambiguous"); }
  { const S = await launch(); const line = await S.run(); S.native = line.result.run;            // ENDED_RELEASED (echo path): not a stopped run
    assert.equal(S.native.outcome, "ENDED_RELEASED");
    const before = await dbSnap(S.bk.id);
    const { r } = await rb(S);                                                   // no catch-all: a thrown error fails the test
    assert.deepEqual([r.outcome, r.code, r.gets], ["REFUSED", "NATIVE_RUN_NOT_PROVEN_STOPPED", 0], JSON.stringify(r)); await assertNoWrite(S, before, "ended"); }
});

test("RB7 native journal is validated READ-ONLY from disk (never a caller boolean): wrong trusted head / wrong native run id / missing dirs → REFUSED, zero writes", async () => {
  const S = await stoppedRun();
  const before = await dbSnap(S.bk.id);
  for (const [label, o, code] of [["head", { native: { packageInput: S.pk.input, journalDir: S.jd, headDir: S.hd, trustedHead: { seq: 1, hash: "a".repeat(64) } } }, "NATIVE_RUN_NOT_PROVEN_STOPPED"],
    ["dirs", { native: { packageInput: S.pk.input, journalDir: ownerDir("rb-empty-"), headDir: ownerDir("rb-empty2-"), trustedHead: S.native.trustedHead } }, "NATIVE_RUN_NOT_PROVEN_STOPPED"],
    ["runid", { over: { nativeRunId: "synthetic-other-9999" } }, "NATIVE_BINDING_MISMATCH"]]) {
    const { r } = await rb(S, o);
    assert.deepEqual([r.outcome, r.code], ["REFUSED", code], label);
  }
  await assertNoWrite(S, before, "RB7");
});

test("RB8 exclusion: native-run lock held → REFUSED; two concurrent R-B sessions → exactly one proceeds; same runId twice → JOURNAL_EXISTS; a live accepted work lease → REFUSED; all zero-write refusals", async () => {
  const S = await stoppedRun();
  const before = await dbSnap(S.bk.id);
  { const c = await reportPool.connect(); await c.query("SELECT pg_advisory_lock(hashtext($1), 0)", [LOCK_KEY]);
    const { r } = await rb(S); assert.deepEqual([r.outcome, r.code], ["REFUSED", "RUN_LOCK_HELD"]);
    await c.query("SELECT pg_advisory_unlock(hashtext($1), 0)", [LOCK_KEY]); c.release(); }
  await assertNoWrite(S, before, "lock");
  { const p = await planFor(S); const jd = ownerDir("rb-same-");
    const a = await rb(S, { plan: p, journalDir: jd }); const b = await rb(S, { plan: p, journalDir: jd });
    assert.equal(b.r.code, "JOURNAL_EXISTS"); assert.equal(a.r.outcome, "RECONCILED_CONFIRMED", JSON.stringify(a.r)); }
  // two sessions racing for a FRESH stopped run: one wins the lock, the other is refused before any DB / provider effect
  { const T = await stoppedRun();
    let release; const gate = new Promise((res) => { release = res; });
    const first = rb(T, { hooks: { afterLock: () => gate } });
    await new Promise((res) => setTimeout(res, 200));
    const second = await rb(T); release();
    const f = await first;
    assert.deepEqual([second.r.outcome, second.r.code, f.r.outcome], ["REFUSED", "RUN_LOCK_HELD", "RECONCILED_CONFIRMED"], JSON.stringify([second.r, f.r])); }
  // a live accepted work lease (another worker holds the intent) → REFUSED, zero writes
  { const U = await stoppedRun(); const b4 = await dbSnap(U.bk.id);
    const now = U.clock();
    const got = await RW.claimWork(db.app, { workerId: "other-worker", now, leaseMs: 10 * MIN, states: ["reservation_pending"], intentId: U.bk.id, listingIds: [ABORT_LISTING] });
    assert.equal(got, U.bk.id);
    const { r } = await rb(U); assert.deepEqual([r.outcome, r.code], ["REFUSED", "WORK_LEASE_LIVE"]);
    assert.equal(JSON.parse(await dbSnap(U.bk.id)).i.version, JSON.parse(b4).i.version); }
});

test("RB9 cross-runner (hosted runner A's REAL operator path, requestTestAbort): NOT excluded by the native lock (runner A takes none). Before reconciliation its state fence refuses; after it, an abort racing the FINAL check is detected → STOPPED FINAL_STATE_CHANGED, never success", async () => {
  { const S = await stoppedRun();
    let refused = null; let snapBefore = null; let snapAfter = null;
    const { r, plan } = await rb(S, { hooks: { afterPrecheck: async () => {
      const i = await loadIntent(db.app, S.bk.id);
      const co = (await all("SELECT result_ref, payload FROM booking.external_operations WHERE intent_id = $1 AND op_type = 'stripe.create_checkout_session' AND state = 'succeeded'", [S.bk.id]))[0];
      const c = (await opsAll(S.bk.id)).find((o) => o.op_type === "hostaway.create_reservation");
      // a FULLY VALID bound expectation (all 15 keys, validated by bindAbortExpectation) — so only the operator's STATE fence can refuse
      const e = buildAbortExpectation({ intentId: i.id, expectedVersion: i.version, listingId: i.listingId, from: i.from, to: i.to, guests: i.guests, currency: "USD",
        finalTotalMinor: i.price.finalTotalMinor, authorizedMinor: i.payment.amountMinor, paymentIntentId: i.payment.paymentIntentId, sessionId: co.result_ref,
        attemptId: co.payload.paymentAttemptId, reservationId: c.result_ref, approvalRef: "rb-test-pending" });
      snapBefore = await dbSnap(S.bk.id);
      refused = await requestTestAbort(db.app, i.id, { now: S.clock(), env: ENV_ABORT, operator: e });
      snapAfter = await dbSnap(S.bk.id); } } });
    assert.equal(refused.ok, false); assert.notEqual(refused.error, "TEST_ABORT_EXPECTATION_INVALID", "the expectation itself was valid");
    S.rb9Refusal = refused.error;
    assert.ok(/STALE|STATE|RESERVATION|NOT_CONFIRMED|IDENTITY|ILLEGAL_TRANSITION/.test(refused.error), `a genuine state refusal: ${refused.error}`);
    assert.equal(snapAfter, snapBefore, "the refused operator call changed nothing");
    assert.equal(r.outcome, "RECONCILED_CONFIRMED", JSON.stringify(r)); assert.ok(plan); }
  { const S = await stoppedRun();
    let ab = null;
    const { r } = await rb(S, { hooks: { afterReconciled: async () => {
      const i = await loadIntent(db.app, S.bk.id);
      const co = (await all("SELECT result_ref, payload FROM booking.external_operations WHERE intent_id = $1 AND op_type = 'stripe.create_checkout_session' AND state = 'succeeded'", [S.bk.id]))[0];
      ab = await requestTestAbort(db.app, i.id, { now: S.clock(), env: ENV_ABORT, operator: buildAbortExpectation({ intentId: i.id, expectedVersion: i.version, listingId: i.listingId,
        from: i.from, to: i.to, guests: i.guests, currency: "USD", finalTotalMinor: i.price.finalTotalMinor, authorizedMinor: i.payment.amountMinor, paymentIntentId: i.payment.paymentIntentId,
        sessionId: co.result_ref, attemptId: co.payload.paymentAttemptId, reservationId: i.reservation.reservationId, approvalRef: "rb-test-race" }) }); } } });
    assert.equal(ab.ok, true, ab.error);
    assert.deepEqual([r.outcome, r.code, r.dbState, r.cleanup], ["STOPPED", "FINAL_STATE_CHANGED", "capture_failed", "NOT_HANDED_OFF"], JSON.stringify(r)); }
});

test("RB10 lost / failed postcheck and budgets: final by-id 503 → STOPPED, no success / handoff; 401 / 403 / 429 at the first GET → STOPPED after ONE GET, zero DB writes; session budget exhausted → STOPPED", async () => {
  { const S = await stoppedRun();
    const { r } = await rb(S, { hooks: { afterReconciled: () => { S.w.exec.R.retrieveReservation = async () => ({ httpStatus: 503, json: { status: "fail" } }); } } });
    assert.deepEqual([r.outcome, r.code, r.dbState, r.cleanup], ["STOPPED", "FINAL_PROVIDER_UNAVAILABLE", "reservation_confirmed", "NOT_HANDED_OFF"], JSON.stringify(r)); }
  for (const [s, code] of [[401, "AUTH_REFUSED"], [403, "AUTH_REFUSED"], [429, "RATE_LIMITED"]]) {
    const S = await stoppedRun(); S.w.exec.R.lookupPage = async () => ({ httpStatus: s, json: { status: "fail" } });
    const before = await dbSnap(S.bk.id);
    const { r } = await rb(S);
    assert.deepEqual([r.outcome, r.code, r.gets, r.steps.length], ["STOPPED", code, 1, 0], `${s}: ${JSON.stringify(r)}`);
    await assertNoWrite(S, before, String(s));
  }
  { const S = await stoppedRun(); let m = 0;
    const { r } = await rb(S, { monotonic: () => (m += 100_000) });
    assert.deepEqual([r.outcome, r.code], ["STOPPED", "SESSION_DEADLINE"], JSON.stringify(r)); await assertTeardown(r, "budget"); }
});

test("RB11 executor containment (unit): create / pricing / any other path, query, method or cursor shape refuses BEFORE the transport; GET cap; first non-200 sets stop", async () => {
  const AD = await import("../../lib/hostaway-reservations.js"); const EX = await import("../../scripts/e7-connected/reconcile-executors-r1.mjs");
  assert.deepEqual([EX.LOOKUP_PAGE_LIMIT, EX.DIRECT_CHANNEL_ID], [AD.LOOKUP_PAGE_LIMIT, AD.DIRECT_CHANNEL_ID], "restated constants equal the adapter's");
  const calls = [];
  const send = async (req) => { calls.push(req); return { httpStatus: 200, json: { status: "success", result: [] } }; };
  const mk = (maxGets = 5) => createReconcileExecutorsR1({ binding: { listingId: ABORT_LISTING, arrivalDate: "2027-03-07", reservationId: "5100123" }, send, maxGets, remainingMs: () => 60_000 });
  const q = { listingId: ABORT_LISTING, channelId: 2000, arrivalStartDate: "2027-03-07", arrivalEndDate: "2027-03-07", limit: 100, includeResources: 1 };
  { const x = mk().executors;
    await assert.rejects(x.createReservation({ method: "POST", path: "/reservations", query: {}, body: {} }), { code: "CREATE_NOT_ALLOWED" });
    await assert.rejects(x.pricing.get("/listings/606998", {}), { code: "PRICING_NOT_ALLOWED" });
    await assert.rejects(x.pricing.post("/listings/606998/calendar/priceDetails", {}, {}), { code: "PRICING_NOT_ALLOWED" }); }
  for (const [label, f] of [
    ["other id", (x) => x.retrieveReservation({ method: "GET", path: "/reservations/5100124", query: {} }, {})],
    ["id query", (x) => x.retrieveReservation({ method: "GET", path: "/reservations/5100123", query: { a: 1 } }, {})],
    ["method", (x) => x.lookupPage({ method: "POST", path: "/reservations", query: q }, {})],
    ["path", (x) => x.lookupPage({ method: "GET", path: "/v1/reservations?x=1", query: q }, {})],
    ["listing", (x) => x.lookupPage({ method: "GET", path: "/reservations", query: { ...q, listingId: 603566 } }, {})],
    ["date", (x) => x.lookupPage({ method: "GET", path: "/reservations", query: { ...q, arrivalStartDate: "2027-03-08" } }, {})],
    ["extra key", (x) => x.lookupPage({ method: "GET", path: "/reservations", query: { ...q, forceOverbooking: 1 } }, {})],
    ["bad cursor", (x) => x.lookupPage({ method: "GET", path: "/reservations", query: { ...q, afterId: "5" } }, {})],
    ["options", (x) => x.lookupPage({ method: "GET", path: "/reservations", query: q }, { signal: undefined, extra: 1 })]]) {
    await assert.rejects(f(mk().executors), (e) => e.name === "ReconcileRefusal", label);
  }
  assert.equal(calls.length, 0, "nothing reached the transport");
  { const m = mk(); await m.executors.lookupPage({ method: "GET", path: "/reservations", query: { ...q, afterId: 77 } }, {});
    assert.deepEqual(calls.at(-1), { method: "GET", path: "/v1/reservations", query: { ...q, afterId: 77 } }, "exact accepted wire form, cursor kept"); }
  { const m = mk(2); await m.executors.lookupPage({ method: "GET", path: "/reservations", query: q }, {}); await m.executors.retrieveReservation({ method: "GET", path: "/reservations/5100123", query: {} }, {});
    await assert.rejects(m.executors.lookupPage({ method: "GET", path: "/reservations", query: q }, {}), { code: "GET_BUDGET_EXHAUSTED" }); assert.equal(m.observe.gets, 2); }
  { const m = createReconcileExecutorsR1({ binding: { listingId: ABORT_LISTING, arrivalDate: "2027-03-07", reservationId: "5100123" }, send: async () => ({ httpStatus: 429, json: {} }), maxGets: 5, remainingMs: () => 60_000 });
    await m.executors.lookupPage({ method: "GET", path: "/reservations", query: q }, {}); assert.deepEqual(m.observe.stop, { code: "RATE_LIMITED", httpStatus: 429 });
    await assert.rejects(m.executors.lookupPage({ method: "GET", path: "/reservations", query: q }, {}), { code: "SESSION_STOPPED" }); }
});

test("RB12 native stop proof (pure, on the ACCEPTED reader's real output): the N2 stopped run is accepted; a real ENDED_RELEASED run, a mismatched head and a tampered result are not", async () => {
  const S = await stoppedRun();
  const bind = (T) => bindRunPackageR1Journal(T.pk.input, T.bk.base + 10 * SEC).binding;
  const rcS = await readJournalForRecoveryR1({ journalDir: S.jd, headDir: S.hd, binding: bind(S), trustedHead: S.native.trustedHead });
  assert.equal(nativeStoppedInReservationPhase(rcS), true, JSON.stringify(rcS.chain));
  const E = await launch(); const line = await E.run(); assert.equal(line.result.run.outcome, "ENDED_RELEASED");
  const rcE = await readJournalForRecoveryR1({ journalDir: E.jd, headDir: E.hd, binding: bind(E), trustedHead: line.result.run.trustedHead });
  assert.equal(rcE.chain.status, "ENDED"); assert.equal(nativeStoppedInReservationPhase(rcE), false, `ENDED_RELEASED facts: ${JSON.stringify(rcE.chain.facts)}`);
  const rcH = await readJournalForRecoveryR1({ journalDir: S.jd, headDir: S.hd, binding: bind(S), trustedHead: { seq: 1, hash: "b".repeat(64) } });
  assert.equal(nativeStoppedInReservationPhase(rcH), false);
  for (const tweak of [(x) => { x.permission.resume = true; }, (x) => { x.chain.facts.openStep = true; }, (x) => { x.relation = "JOURNAL_AHEAD"; }]) {
    const x = structuredClone(rcS); tweak(x); assert.equal(nativeStoppedInReservationPhase(x), false);
  }
});

// =================================================================================================================================
// ROOT HOLD (5016df0a) F1 — the audit journal is FAIL-CLOSED at EVERY boundary
/** wraps the REAL journal: the append of `failType` (n-th occurrence) returns a failure; the real journal then latches (we close it) */
const failingJournal = (failType, nth = 1) => async (o) => {
  const jo = await openReconcileJournalR1(o); if (!jo.ok) return jo;
  let seen = 0; let dead = false;
  return { ok: true, journal: { file: jo.journal.file, head: jo.journal.head, close: jo.journal.close,
    async append(type, at, data) { if (dead) return { ok: false, code: "INJECTED_LATCHED" };
      if (type === failType && ++seen === nth) { dead = true; return { ok: false, code: "INJECTED_FAILURE" }; }
      return jo.journal.append(type, at, data); } } };
};
test("RB13 journal fail-closed at each boundary: RUN_STARTED / NATIVE_VALIDATED / PREFLIGHT_OK / PRECHECK stop BEFORE any worker step with zero DB writes; STEP / FINAL_READ / terminal never yield success; audit reported incomplete; lock released", async () => {
  for (const [type, outcome, code, steps0] of [["RUN_STARTED", "REFUSED", "AUDIT_RUN_STARTED_FAILED", true], ["NATIVE_VALIDATED", "REFUSED", "AUDIT_NATIVE_VALIDATED_FAILED", true],
    ["PREFLIGHT_OK", "STOPPED", "AUDIT_PREFLIGHT_FAILED", true], ["PRECHECK", "STOPPED", "AUDIT_PRECHECK_FAILED", true]]) {
    const S = await stoppedRun(); const before = await dbSnap(S.bk.id);
    const { r } = await rb(S, { journalOpen: failingJournal(type) });
    assert.deepEqual([r.outcome, r.code, r.steps.length], [outcome, code, 0], `${type}: ${JSON.stringify(r)}`);
    assert.ok(r.audit.startsWith(`incomplete:${type}:`), r.audit); await assertNoWrite(S, before, type); await assertTeardown(r, type);
  }
  { const S = await stoppedRun(); const { r } = await rb(S, { journalOpen: failingJournal("STEP") });
    assert.deepEqual([r.outcome, r.code, r.steps.length], ["STOPPED", "AUDIT_STEP_FAILED", 1], JSON.stringify(r)); assert.equal(r.dbState, await state(S.bk.id)); await assertTeardown(r, "STEP"); }
  { const S = await stoppedRun(); const { r } = await rb(S, { journalOpen: failingJournal("FINAL_READ") });
    assert.deepEqual([r.outcome, r.code, r.dbState], ["STOPPED", "AUDIT_FINAL_FAILED", "reservation_confirmed"], JSON.stringify(r)); await assertTeardown(r, "FINAL"); }
  { const S = await stoppedRun(); const { r } = await rb(S, { journalOpen: failingJournal("ENDED") });
    assert.deepEqual([r.outcome, r.code, r.dbState, r.cleanup], ["STOPPED", "TERMINAL_JOURNAL_FAILED", "reservation_confirmed", "NOT_HANDED_OFF"], JSON.stringify(r));
    assert.ok(r.audit.startsWith("incomplete:ENDED:")); await assertTeardown(r, "terminal"); }
});

test("RB13b ROOT's exact fault: fsync throws on PREFLIGHT_OK (after RUN_STARTED / NATIVE_VALIDATED) → STOPPED before any worker step, zero DB writes; pure journal: zero-progress write / throwing fsync never acknowledged, partial writes complete correctly", async () => {
  { const S = await stoppedRun(); const before = await dbSnap(S.bk.id);
    let syncs = 0;
    const journalOpen = (o) => openReconcileJournalR1({ ...o, openHandle: async (...a) => { const fh = await (await import("node:fs/promises")).open(...a);
      return { write: (...w) => fh.write(...w), stat: () => fh.stat(), close: () => fh.close(), sync: async () => { syncs += 1; if (syncs === 3) throw new Error("EIO (injected)"); return fh.sync(); } }; } });
    const { r } = await rb(S, { journalOpen });
    assert.deepEqual([r.outcome, r.code, r.steps.length], ["STOPPED", "AUDIT_PREFLIGHT_FAILED", 0], JSON.stringify(r));
    assert.ok(r.audit.startsWith("incomplete:PREFLIGHT_OK:JOURNAL_SYNC_FAILED"), r.audit); await assertNoWrite(S, before, "fsync"); await assertTeardown(r, "fsync"); }
  const fsp = await import("node:fs/promises");
  const mkJ = async (wrap) => { const d = ownerDir("rb-pj-"); return openReconcileJournalR1({ dir: d, runId: `pure-${Math.random().toString(36).slice(2, 10)}`, uid: process.getuid(),
    openHandle: async (...a) => { const fh = await fsp.open(...a); return wrap(fh); } }); };
  { const jo = await mkJ((fh) => ({ write: async () => ({ bytesWritten: 0 }), sync: () => fh.sync(), stat: () => fh.stat(), close: () => fh.close() }));
    const a = await jo.journal.append("X", 1, {});
    assert.deepEqual([a.ok, a.code, jo.journal.head().seq], [false, "JOURNAL_WRITE_NO_PROGRESS", 0], "zero progress is never acknowledged");
    assert.equal((await jo.journal.append("Y", 2, {})).code, "JOURNAL_WRITE_NO_PROGRESS", "latched");
    assert.equal((await fsp.stat(jo.journal.file)).size, 0); await jo.journal.close(); }
  { const jo = await mkJ((fh) => ({ write: async () => { throw new Error("EIO"); }, sync: () => fh.sync(), stat: () => fh.stat(), close: () => fh.close() }));
    assert.deepEqual([(await jo.journal.append("X", 1, {})).code, jo.journal.head().seq], ["JOURNAL_WRITE_FAILED", 0]); await jo.journal.close(); }
  { const jo = await mkJ((fh) => ({ write: (b, off, len) => fh.write(b, off, Math.min(len, 7)), sync: () => fh.sync(), stat: () => fh.stat(), close: () => fh.close() }));
    for (let i = 0; i < 3; i++) assert.equal((await jo.journal.append("P", i, { i, pad: "x".repeat(50) })).ok, true);
    await jo.journal.close(); const rj = await readReconcileJournalR1(jo.journal.file);
    assert.deepEqual([rj.ok, rj.records.length], [true, 3], "7-byte partial writes still produce the full chained lines"); }
  { const jo = await mkJ((fh) => ({ write: (b, off, len) => fh.write(b, off, len), sync: async () => { throw new Error("EIO"); }, stat: () => fh.stat(), close: () => fh.close() }));
    assert.deepEqual([(await jo.journal.append("X", 1, {})).code, jo.journal.head().seq], ["JOURNAL_SYNC_FAILED", 0]); await jo.journal.close(); }
  { const jo = await mkJ((fh) => ({ write: async (b, off, len) => ({ bytesWritten: len + 5 }), sync: () => fh.sync(), stat: () => fh.stat(), close: () => fh.close() }));
    assert.equal((await jo.journal.append("X", 1, {})).code, "JOURNAL_WRITE_OVER_PROGRESS"); await jo.journal.close(); }
});

// ROOT HOLD F2 — EXACT own-lock proof
test("RB14 exact lock: ROOT's case (own LOCK_KEY unlocked then an UNRELATED lock taken on the SAME session) → STOPPED LOCK_LOST before any worker step; wrong form / key / other session never prove it; hook / connection / query exceptions leak no lock", async () => {
  { const S = await stoppedRun(); const before = await dbSnap(S.bk.id);
    const { r } = await rb(S, { hooks: { afterPrecheck: async (h) => {
      await h.lockQuery("SELECT pg_advisory_unlock(pg_catalog.hashtext($1), 0)", [LOCK_KEY]); await h.lockQuery("SELECT pg_advisory_lock(123, 456)"); } } });
    assert.deepEqual([r.outcome, r.code, r.steps.length, r.lock], ["STOPPED", "LOCK_LOST", 0, "unlock_failed_connection_destroyed"], JSON.stringify(r));
    await assertNoWrite(S, before, "lock lost"); await assertTeardown(r, "lost+unrelated"); }
  // the predicate itself: only THIS session's exact two-int4 (hashtext(key), 0) lock in THIS database counts
  { const a = await reportPool.connect(); const b = await reportPool.connect();
    const n = async (c) => (await c.query(OWN_LOCK_SQL, [LOCK_KEY])).rows[0].n;
    await a.query("SELECT pg_advisory_lock(pg_catalog.hashtext($1)::bigint)", [LOCK_KEY]); assert.equal(await n(a), 0, "single-int8 form is not it");
    await a.query("SELECT pg_advisory_unlock(pg_catalog.hashtext($1)::bigint)", [LOCK_KEY]);
    await a.query("SELECT pg_advisory_lock(pg_catalog.hashtext('other-key'), 0)"); assert.equal(await n(a), 0, "another key is not it");
    await a.query("SELECT pg_advisory_unlock(pg_catalog.hashtext('other-key'), 0)");
    await a.query("SELECT pg_advisory_lock(pg_catalog.hashtext($1), 1)", [LOCK_KEY]); assert.equal(await n(a), 0, "objid ≠ 0 is not it");
    await a.query("SELECT pg_advisory_unlock(pg_catalog.hashtext($1), 1)", [LOCK_KEY]);
    await a.query("SELECT pg_advisory_lock(pg_catalog.hashtext($1), 0)", [LOCK_KEY]); assert.equal(await n(a), 1, "the exact lock on THIS session");
    assert.equal(await n(b), 0, "another session holding it does not prove it for this one");
    await a.query("SELECT pg_advisory_unlock(pg_catalog.hashtext($1), 0)", [LOCK_KEY]); a.release(); b.release(); }
  // another DATABASE on the same cluster holding the exact key does not count
  { await db.owner.query("DROP DATABASE IF EXISTS rb_otherdb"); await db.owner.query("CREATE DATABASE rb_otherdb");
    const u = new URL(db.reportUrl()); const o = new URL(db.reportUrl()); o.pathname = "/rb_otherdb";
    const ownerUrl = new URL(o.href); const other = new pg.Client({ connectionString: (() => { const x = new URL(db.reportUrl()); x.pathname = "/rb_otherdb"; return x.href; })() });
    let otherOk = true; try { await other.connect(); await other.query("SELECT pg_advisory_lock(pg_catalog.hashtext($1), 0)", [LOCK_KEY]); } catch { otherOk = false; }
    if (otherOk) { const a = await reportPool.connect(); assert.equal((await a.query(OWN_LOCK_SQL, [LOCK_KEY])).rows[0].n, 0, "another database's lock is not it"); a.release(); await other.end(); }
    await db.owner.query("DROP DATABASE IF EXISTS rb_otherdb WITH (FORCE)"); void u; void ownerUrl;
    assert.equal(otherOk, true, "the other-database case actually ran"); }
  // exceptions: a throwing hook / a killed lock session / a failing connect — no leaked lock, never success
  { const S = await stoppedRun(); const { r } = await rb(S, { hooks: { afterPrecheck: () => { throw new Error("hook boom"); } } });
    assert.deepEqual([r.outcome, r.code], ["STOPPED", "INTERNAL_EXCEPTION"]); await assertTeardown(r, "hook"); }
  { const S = await stoppedRun(); const { r } = await rb(S, { hooks: { afterPrecheck: async (h) => { const pid = (await h.lockQuery("SELECT pg_backend_pid() AS p")).rows[0].p;
      await db.owner.query("SELECT pg_terminate_backend($1)", [pid]); } } });
    assert.equal(r.outcome, "STOPPED"); assert.ok(["LOCK_LOST", "LOCK_SESSION_ERROR", "INTERNAL_EXCEPTION"].includes(r.code), r.code); await assertTeardown(r, "killed session"); }
  { const S = await stoppedRun(); const before = await dbSnap(S.bk.id);
    const r = await runReconcileR1({ plan: await planFor(S), pools: { app: db.app, report: { connect: async () => { throw new Error("no connection"); } } }, hostawaySend: S.t.hostaway.send,
      clock: () => S.clock(), journalDir: ownerDir("rb-j-"), uid: process.getuid(), native: { packageInput: S.pk.input, journalDir: S.jd, headDir: S.hd, trustedHead: S.native.trustedHead } });
    assert.deepEqual([r.outcome, r.code, r.lock], ["REFUSED", "DB_CONNECT_FAILED", "not_acquired"]); await assertNoWrite(S, before, "connect"); await assertTeardown(r, "connect"); }
});

// ROOT HOLD F3 — HARD session deadline; teardown grace is never success
test("RB15 deadline: late FINAL completion / a never-settling, abort-ignoring reply / expiry during a wait, inside a worker step, during the final DB work → STOPPED, never success; no new call after expiry; teardown clean", async () => {
  // (a) the final read resolves but advances the monotonic clock past the session budget → no success
  { const S = await stoppedRun(); let m = 0; let jump = false;
    const send = async (req, o) => { const rep = await S.t.hostaway.send(req, o); if (jump) m = RB.sessionBudgetMs + 60_000; return rep; };
    const { r } = await rb(S, { send, monotonic: () => m, hooks: { afterReconciled: () => { jump = true; } } });
    assert.deepEqual([r.outcome, r.code, r.dbState], ["STOPPED", "SESSION_DEADLINE_AFTER_FINAL_READ", "reservation_confirmed"], JSON.stringify(r));
    assert.ok(r.final === null || r.final.ok === false || r.elapsedMs > RB.sessionBudgetMs); await assertTeardown(r, "late final"); }
  // (b) a reply that never settles and ignores the abort → bounded by the per-call bound; dropped; STOPPED before any worker step
  { const S = await stoppedRun(); const before = await dbSnap(S.bk.id); let n = 0;
    const send = (req, o) => { n += 1; if (/\/reservations\/\d+$/.test(req.path)) return new Promise(() => {}); return S.t.hostaway.send(req, o); };
    const t0 = Date.now(); const { r } = await rb(S, { send });
    assert.deepEqual([r.outcome, r.code, r.steps.length], ["STOPPED", "CALL_TIMEOUT", 0], JSON.stringify(r));
    assert.ok(Date.now() - t0 < RB.callTimeoutMs + 5_000, "bounded by the per-call bound"); await assertNoWrite(S, before, "never settles"); await assertTeardown(r, "never settles"); void n; }
  // (c) expiry during the wait between worker steps → STOPPED, no further step
  { const S = await stoppedRun(); let m = 0;
    const { r } = await rb(S, { monotonic: () => m, sleep: async () => { m = RB.sessionBudgetMs + 1; } });
    assert.deepEqual([r.outcome, r.code, r.steps.length], ["STOPPED", "SESSION_DEADLINE", 1], JSON.stringify(r)); await assertTeardown(r, "wait"); }
  // (d) expiry inside a worker step (during its provider read) → that step is awaited (teardown grace), then STOPPED; no new call / step
  { const S = await stoppedRun(); let m = 0; let inStep = false; const calls = [];
    const send = async (req, o) => { calls.push({ path: req.path, inStep, m }); if (inStep && /\/reservations\/\d+$/.test(req.path)) m = RB.sessionBudgetMs + 1; return S.t.hostaway.send(req, o); };
    const { r } = await rb(S, { send, monotonic: () => m, hooks: { beforeStep: (i) => { inStep = i === 2; } } });
    assert.deepEqual([r.outcome, r.code], ["STOPPED", "SESSION_DEADLINE"], JSON.stringify(r));
    assert.equal(calls.filter((c) => c.m > RB.sessionBudgetMs).length, 0, "no GET started after expiry"); await assertTeardown(r, "in step"); }
  // (e) expiry during the final DB work → STOPPED
  { const S = await stoppedRun(); let m = 0;
    const { r } = await rb(S, { monotonic: () => m, hooks: { afterFinalDb: () => { m = RB.sessionBudgetMs + 1; } } });
    assert.deepEqual([r.outcome, r.code, r.dbState], ["STOPPED", "SESSION_DEADLINE_AFTER_FINAL_DB", "reservation_confirmed"], JSON.stringify(r)); await assertTeardown(r, "final db"); }
});

// =================================================================================================================================
// ROOT rev2 review (c80ca424) R1 — the deadline is re-checked AFTER terminal persistence and through every teardown step; teardown grace never succeeds
/** wraps the REAL journal: `onType(type)` runs after the real append of that type returns (or instead, when it returns a promise to await first) */
const tapJournal = (tap) => async (o) => {
  const jo = await openReconcileJournalR1(o); if (!jo.ok) return jo; const j = jo.journal;
  return { ok: true, journal: { file: j.file, head: j.head, close: async () => { await tap.beforeClose?.(); return j.close(); },
    async append(type, at, data) { if (tap.before) { const x = await tap.before(type); if (x === "HANG") return new Promise(() => {}); }
      const r = await j.append(type, at, data); await tap.after?.(type); return r; } } };
};
/** ROOT-U contract: the audit is complete ONLY if the journal's last durable outcome record equals the returned outcome + code */
const assertAuditAgrees = async (r, jdir, plan, label) => {
  const j = await readReconcileJournalR1(`${jdir}/${journalName(plan.runId)}`); assert.equal(j.ok, true, `${label}: journal chain intact`);
  const last = [...j.records].reverse().find((x) => x.type === "TEARDOWN" || x.type === "DOWNGRADED");
  assert.ok(r.audit !== "complete" || (last && last.data.outcome === r.outcome && last.data.code === r.code),
    `${label}: audit ${r.audit} vs last durable outcome ${JSON.stringify(last && last.data)} / result ${r.outcome} ${r.code}`);
  return j;
};
const journalText = async (jdir, plan) => (await import("node:fs/promises")).readFile(`${jdir}/${journalName(plan.runId)}`, "utf8");
test("RB16 terminal / teardown deadline: expiry when ENDED returns (ROOT's repro) / during a delayed terminal fsync / at the TEARDOWN record / at close / a HUNG terminal append → STOPPED, history kept (ENDED is provisional, TEARDOWN records the real outcome), lock released, bounded", async () => {
  // (a) ROOT's exact repro: all monotonic values 0 until the REAL ENDED append returns, then 300000
  { const S = await stoppedRun(); let m = 0;
    const { r, plan, jdir } = await rb(S, { monotonic: () => m, journalOpen: tapJournal({ after: (t) => { if (t === "ENDED") m = 300_000; } }) });
    assert.deepEqual([r.outcome, r.code, r.audit, r.cleanup], ["STOPPED", "SESSION_DEADLINE_AT_TERMINAL", "complete", "NOT_HANDED_OFF"], JSON.stringify(r));
    const j = await readReconcileJournalR1(`${jdir}/${journalName(plan.runId)}`); assert.equal(j.ok, true);
    assert.deepEqual(j.records.slice(-2).map((x) => [x.type, x.data.provisional ?? null, x.data.outcome ?? null, x.data.code ?? null]),
      [["ENDED", true, null, null], ["TEARDOWN", null, "STOPPED", "SESSION_DEADLINE_AT_TERMINAL"]], "history kept; the provisional ENDED is followed by the honest outcome");
    await assertAuditAgrees(r, jdir, plan, "at terminal");
    await assertTeardown(r, "at terminal"); }
  // (b) the terminal fsync is DELAYED (1.5 s real) and the deadline passes during it
  { const S = await stoppedRun(); let m = 0; const fsp = await import("node:fs/promises"); let armed = false;
    const journalOpen = (o) => tapJournal({ before: (t) => { if (t === "ENDED") armed = true; } })({ ...o, openHandle: async (...a) => { const fh = await fsp.open(...a);
      return { write: (...w) => fh.write(...w), stat: () => fh.stat(), close: () => fh.close(), sync: async () => { if (armed) { armed = false; await new Promise((res) => setTimeout(res, 1500)); m = 300_000; } return fh.sync(); } }; } });
    const { r } = await rb(S, { monotonic: () => m, journalOpen });
    assert.deepEqual([r.outcome, r.code], ["STOPPED", "SESSION_DEADLINE_AT_TERMINAL"], JSON.stringify(r)); await assertTeardown(r, "delayed fsync"); }
  // (c) expiry at the TEARDOWN record and (d) at close — after close there is nowhere to journal: an HONEST unjournalled downgrade
  // (c) ROOT-U: expiry after a SUCCESSFUL TEARDOWN append → ONE corrective DOWNGRADED record; result and journal agree; history kept
  { const S = await stoppedRun(); let m = 0;
    const { r, plan, jdir } = await rb(S, { monotonic: () => m, journalOpen: tapJournal({ after: (t) => { if (t === "TEARDOWN") m = 300_000; } }) });
    assert.deepEqual([r.outcome, r.code, r.audit], ["STOPPED", "SESSION_DEADLINE_AT_TEARDOWN_RECORD", "complete"], JSON.stringify(r));
    const j = await assertAuditAgrees(r, jdir, plan, "teardown record");
    assert.deepEqual(j.records.slice(-3).map((x) => [x.type, x.data.outcome ?? null]), [["ENDED", null], ["TEARDOWN", "RECONCILED_CONFIRMED"], ["DOWNGRADED", "STOPPED"]]);
    assert.equal(j.records.at(-1).data.supersedes, "RECONCILED_CONFIRMED"); await assertTeardown(r, "teardown record"); }
  // (c2) the corrective append itself fails → explicit incomplete; old TEARDOWN kept
  { const S = await stoppedRun(); let m = 0;
    const { r, plan, jdir } = await rb(S, { monotonic: () => m, journalOpen: tapJournal({ after: (t) => { if (t === "TEARDOWN") m = 300_000; }, before: (t) => (t === "DOWNGRADED" ? "HANG" : null) }) });
    assert.deepEqual([r.outcome, r.code, r.audit], ["STOPPED", "SESSION_DEADLINE_AT_TEARDOWN_RECORD", "incomplete:DOWNGRADED:JOURNAL_APPEND_TIMEOUT"], JSON.stringify(r));
    await assertAuditAgrees(r, jdir, plan, "corrective hung"); await assertTeardown(r, "corrective hung"); }
  // (d) expiry at close / close THROWS / close HANGS after a successful TEARDOWN → nothing more can be journalled: explicit DOWNGRADE_NOT_JOURNALED
  for (const [label, tap, codeX] of [["close deadline", (S, set) => ({ beforeClose: () => set() }), "SESSION_DEADLINE_AFTER_CLOSE"],
      ["close throws", () => ({ beforeClose: () => { throw new Error("EIO close"); } }), "JOURNAL_CLOSE_FAILED"],
      ["close hangs", () => ({ beforeClose: () => new Promise(() => {}) }), "JOURNAL_CLOSE_FAILED"]]) {
    const S = await stoppedRun(); let m = 0;
    const { r, plan, jdir } = await rb(S, { monotonic: () => m, journalOpen: tapJournal(tap(S, () => { m = 300_000; })) });
    assert.deepEqual([r.outcome, r.code, r.audit], ["STOPPED", codeX, "incomplete:FINAL:DOWNGRADE_NOT_JOURNALED"], `${label}: ${JSON.stringify(r)}`);
    const j = await assertAuditAgrees(r, jdir, plan, label);
    assert.deepEqual([j.records.at(-1).type, j.records.at(-1).data.outcome], ["TEARDOWN", "RECONCILED_CONFIRMED"], `${label}: old history kept, not edited`);
    await assertTeardown(r, label); }
  // (e) expiry during the UNLOCK query (the report session wrapped) → STOPPED at release
  { const S = await stoppedRun(); let m = 0;
    const report = { connect: async () => { const c = await reportPool.connect(); const q = c.query.bind(c);
      c.query = async (...a) => { const res = await q(...a); if (typeof a[0] === "string" && a[0].includes("pg_advisory_unlock")) m = 300_000; return res; }; return c; } };
    const { r } = await rb(S, { monotonic: () => m, report });
    assert.deepEqual([r.outcome, r.code, r.lock], ["STOPPED", "SESSION_DEADLINE_AT_RELEASE", "released"], JSON.stringify(r)); await assertTeardown(r, "release"); }
  // (f) a HUNG terminal append (never settles) → bounded by teardownGraceMs; STOPPED TERMINAL_JOURNAL_FAILED; journal dead, no interleaved TEARDOWN
  { const S = await stoppedRun(); const t0 = Date.now();
    const { r, plan, jdir } = await rb(S, { journalOpen: tapJournal({ before: (t) => (t === "ENDED" ? "HANG" : null) }) });
    assert.deepEqual([r.outcome, r.code, r.audit], ["STOPPED", "TERMINAL_JOURNAL_FAILED", "incomplete:ENDED:JOURNAL_APPEND_TIMEOUT"], JSON.stringify(r));
    assert.ok(Date.now() - t0 < 120_000); const txt = await journalText(jdir, plan); assert.ok(!txt.includes('"TEARDOWN"'), "no record after a timed-out append");
    await assertTeardown(r, "hung terminal"); }
});

// R2 — an `error` emitted on the lock session LATCHES failure; no private text is ever returned or journalled
const ERR_CANARY = "SYNTHETIC_PRIVATE_ERROR_CANARY";
const capturingReport = () => { const box = { c: null }; return { box, report: { connect: async () => { box.c = await reportPool.connect(); return box.c; } } }; };
test("RB17 lock-session client error (backend NOT killed): emitted after the precheck / during a worker step (delayed race) / after the final DB work / at the terminal append → STOPPED LOCK_SESSION_ERROR, never success; session destroyed, no lock left; the error text never appears in the result or the journal", async () => {
  const cases = [
    ["afterPrecheck", (box) => ({ hooks: { afterPrecheck: () => { box.c.emit("error", new Error(ERR_CANARY)); } } }), 0],
    ["in-step race", (box) => ({ hooks: { beforeStep: (i) => { if (i === 2) setTimeout(() => box.c.emit("error", new Error(ERR_CANARY)), 0); } } }), null],
    ["afterFinalDb", (box) => ({ hooks: { afterFinalDb: () => { box.c.emit("error", new Error(ERR_CANARY)); } } }), null],
    ["terminal", (box) => ({ journalOpen: tapJournal({ after: (t) => { if (t === "ENDED") box.c.emit("error", new Error(ERR_CANARY)); } }) }), null]];
  for (const [label, mk, steps] of cases) {
    const S = await stoppedRun(); const { box, report } = capturingReport(); const before = await dbSnap(S.bk.id);
    const { r, plan, jdir } = await rb(S, { report, ...mk(box) });
    assert.deepEqual([r.outcome, r.code, r.lock, r.lockSession], ["STOPPED", "LOCK_SESSION_ERROR", "session_error_connection_destroyed", "error_observed"], `${label}: ${JSON.stringify(r)}`);
    if (steps === 0) { assert.equal(r.steps.length, 0, label); await assertNoWrite(S, before, label); }
    assert.ok(!JSON.stringify(r).includes(ERR_CANARY), `${label}: canary not in the result`);
    assert.ok(!(await journalText(jdir, plan)).includes(ERR_CANARY), `${label}: canary not in the journal`);
    await assertTeardown(r, label);
  }
});

// R3 — executor: no reply accepted after abort / bound / deadline — not even inside the backstop grace
test("RB18 executor deadline / abort (pure): ROOT's repro (callTimeout 15, reply 10 ms AFTER the abort) rejected; pre-aborted outer signal → zero transport calls; outer abort then reply → rejected; session expires while a resolving read completes → rejected; late rejections handled", async () => {
  const binding = { listingId: ABORT_LISTING, arrivalDate: "2027-03-07", reservationId: "5100123" };
  const req = { method: "GET", path: "/reservations/5100123", query: {} };
  const unhandled = []; const onU = (e) => unhandled.push(e); process.on("unhandledRejection", onU);
  try {
    { const send = (rq, { signal }) => new Promise((res) => signal.addEventListener("abort", () => setTimeout(() => res({ httpStatus: 200, json: {} }), 10), { once: true }));
      const m = createReconcileExecutorsR1({ binding, send, maxGets: 5, remainingMs: () => 10_000, callTimeoutMs: 15 });
      await assert.rejects(m.executors.retrieveReservation(req, {}), (e) => e.code === "CALL_TIMEOUT");
      await new Promise((res) => setTimeout(res, 40)); assert.equal(m.observe.stop.code, "CALL_TIMEOUT", "ROOT repro: the in-grace reply is dropped"); }
    { let calls = 0; const m = createReconcileExecutorsR1({ binding, send: async () => { calls += 1; return { httpStatus: 200, json: {} }; }, maxGets: 5, remainingMs: () => 10_000 });
      const ac = new AbortController(); ac.abort();
      await assert.rejects(m.executors.retrieveReservation(req, { signal: ac.signal }), (e) => e.code === "CALL_ABORTED");
      assert.deepEqual([calls, m.observe.gets, m.observe.stop.code], [0, 0, "CALL_ABORTED"], "pre-aborted: zero transport calls"); }
    { const ac = new AbortController();
      const send = () => new Promise((res) => { setTimeout(() => ac.abort(), 5); setTimeout(() => res({ httpStatus: 200, json: {} }), 8); });
      const m = createReconcileExecutorsR1({ binding, send, maxGets: 5, remainingMs: () => 10_000 });
      await assert.rejects(m.executors.retrieveReservation(req, { signal: ac.signal }), (e) => e.code === "CALL_ABORTED"); assert.equal(m.observe.stop.code, "CALL_ABORTED"); }
    { let left = 10_000; const send = async () => { left = 0; return { httpStatus: 200, json: {} }; };   // the read completes exactly as the session expires
      const m = createReconcileExecutorsR1({ binding, send, maxGets: 5, remainingMs: () => left });
      await assert.rejects(m.executors.retrieveReservation(req, {}), (e) => e.code === "SESSION_DEADLINE"); assert.equal(m.observe.stop.code, "SESSION_DEADLINE"); }
    { const send = (rq, { signal }) => new Promise((_, rej) => signal.addEventListener("abort", () => setTimeout(() => rej(new Error("late")), 5), { once: true }));
      const m = createReconcileExecutorsR1({ binding, send, maxGets: 5, remainingMs: () => 10_000, callTimeoutMs: 15 });
      await assert.rejects(m.executors.retrieveReservation(req, {}), (e) => e.code === "CALL_TIMEOUT"); await new Promise((res) => setTimeout(res, 50)); }
    assert.equal(unhandled.length, 0, "no unhandled late rejection");
  } finally { process.off("unhandledRejection", onU); }
});

// R3 on PG — the session expires WHILE a worker step's read resolves: that reply never reaches the worker → no new evidence row from it
test("RB18b session expiry while a worker step's provider read resolves → the reply is dropped (no accepted evidence / DB result from it); STOPPED, never success", async () => {
  const S = await stoppedRun(); let m = 0; let inStep = false; let evidAtCall = null;
  const evidCount = async () => Number((await one("SELECT count(*)::int AS n FROM booking.provider_evidence e JOIN booking.external_operations o ON o.id = e.read_operation_id WHERE o.intent_id = $1", [S.bk.id])).n);
  const send = async (req, o) => { const rep = await S.t.hostaway.send(req, o); if (inStep && evidAtCall === null && /\/reservations\/\d+$/.test(req.path)) { evidAtCall = await evidCount(); m = RB.sessionBudgetMs + 1; } return rep; };
  const { r } = await rb(S, { send, monotonic: () => m, hooks: { beforeStep: (i) => { inStep = i === 2; } } });
  assert.equal(r.outcome, "STOPPED", JSON.stringify(r)); assert.ok(evidAtCall !== null, "the in-step read happened");
  const found = Number((await one(`SELECT count(*)::int AS n FROM booking.provider_evidence e JOIN booking.external_operations o ON o.id = e.read_operation_id
    WHERE o.intent_id = $1 AND e.status = 'found_active' AND o.op_type = 'hostaway.retrieve_reservation'`, [S.bk.id])).n);
  assert.equal(await state(S.bk.id), "reservation_pending", "the dropped reply did not confirm the reservation");
  assert.equal(await evidCount(), evidAtCall, "no evidence row was recorded from the reply that resolved as the session expired"); void found;
  await assertTeardown(r, "rb18b");
});
