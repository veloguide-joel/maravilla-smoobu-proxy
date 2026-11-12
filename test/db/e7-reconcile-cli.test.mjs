// E7 N2 reconcile LOCAL CLI (R-B Step B) — real disposable PG + the REAL native run (stopped, N2 shape) + the reconcile CLI main(proc, hooks).
// The harness below (through planFor) is a LABELLED VERBATIM COPY of test/db/e7-reconcile-r1.test.mjs lines 1–569 @ 9050b617 (itself a labelled copy of
// the native execute suite); everything after "RECONCILE CLI TESTS" is new. FAKE: provider exchanges + synthetic attestations only. Nothing live.
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

// =================================================================================================================================
// RECONCILE CLI TESTS (new)
import { cpSync, mkdirSync, existsSync, symlinkSync, renameSync, statSync } from "node:fs";
import * as RC from "../../scripts/e7-connected/reconcile-cli-main.mjs";
import { journalFileNameR1, headFileNameR1 } from "../../scripts/e7-connected/run-journal-file-v2.mjs";
let RC_DIGEST = null;
before(async () => { const e = await RC.readReconcileClosure(ROOT, FS_CONSTANTS); assert.ok(e, "reconcile closure readable"); RC_DIGEST = await RC.reconcileClosureDigest(e); });
const mk700 = (p) => { mkdirSync(p, { mode: 0o700 }); chmodSync(p, 0o700); return p; };
const newPrivate = () => mk700(join(ownerDir("rc-ns-"), ".maravilla-private"));
const sha = (b) => createHash("sha256").update(b).digest("hex");
const treeHash = (dir) => { const out = {}; const walk = (d) => { for (const n of readdirSync(d).sort()) { const p = join(d, n); const st = statSync(p);
  if (st.isDirectory()) walk(p); else out[p.slice(dir.length)] = sha(readFileSync(p)); } }; walk(dir); return JSON.stringify(out); };
const advisory = async () => Number((await one("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'")).n);

/** a REAL stopped native run (N2 shape) whose package / journal / head live in the owner namespace <P>/runs/<runId>/{package,journal,head} */
async function nsStoppedRun() {
  const w = world(); w.mode.create = "noEcho";
  const realRetrieve = w.exec.R.retrieveReservation;
  const S = await launch({ w, afterBooking: (w0) => { w0.exec.R.retrieveReservation = async () => ({ httpStatus: 503, json: { status: "fail" } }); } });   // LABELLED TEST FAULT
  S.priv = newPrivate(); mk700(join(S.priv, "runs"));
  S.nid = S.pk.plan.runId; S.ndir = mk700(join(S.priv, "runs", S.nid));
  const pkg = mk700(join(S.ndir, "package")); S.jd = mk700(join(S.ndir, "journal")); S.hd = mk700(join(S.ndir, "head"));
  S.packagePath = put(pkg, "package.json", Buffer.from(S.pk.input.packageBytes)); S.planPath = put(pkg, "plan.json", Buffer.from(S.pk.input.planBytes));
  const set = (k, v) => { S.flags[S.flags.indexOf(k) + 1] = v; };
  set("--package", S.packagePath); set("--plan", S.planPath); set("--journal-dir", S.jd); set("--head-dir", S.hd);
  S.proc.argv = ["node", "cli", ...S.flags];
  const line = await S.run();
  const r = line.result.run;
  assert.deepEqual([r.outcome, r.stopCode, r.ownerCleanupRequired], ["STOPPED", "READ_FAILED", "reservedNotConfirmed"], JSON.stringify(r));
  w.exec.R.retrieveReservation = realRetrieve;
  S.native = r; S.nativeLine = S.out[0];                        // the CAPTURED native stdout line: the ONLY trusted-head source
  return S;
}
/** a byte copy of the native run dir into a fresh namespace (for destructive provenance cases); the original stays untouched */
function copyNs(S) { const priv = newPrivate(); mk700(join(priv, "runs")); const nd = join(priv, "runs", S.nid); cpSync(S.ndir, nd, { recursive: true });
  const fix = (d) => { chmodSync(d, 0o700); for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) fix(p); else chmodSync(p, 0o600); } }; fix(nd);
  return { priv, ndir: nd }; }
let rcN = 0;
/** run the reconcile CLI main(proc, hooks) in-process */
async function reconcile(S, o = {}) {
  rcN += 1;
  const plan = o.plan ?? await planFor(S, { runId: `rc-test-${String(rcN).padStart(4, "0")}`, ...(o.over ?? {}) });
  const bytes = Buffer.from(canonicalJson(plan));
  const priv = o.priv ?? S.priv; const ndir = o.ndir ?? S.ndir;
  const rdir = o.rdir ?? join(priv, "runs", plan.runId);
  const th = o.head ?? `${S.native.trustedHead.seq}:${S.native.trustedHead.hash}`;
  const f = { "--native-run-dir": ndir, "--reconcile-run-dir": rdir, "--recovery-plan-b64": bytes.toString("base64"),
    "--expect-recovery-plan-sha256": o.planSha ?? sha(bytes), "--expect-native-package-hash": o.pkgHash ?? S.pk.built.packageHash,
    "--expect-executor-digest": S.pk.input.expected.executorDigest, "--expect-trusted-head": th, "--expect-reconcile-digest": o.digest ?? RC_DIGEST,
    "--intent": o.intent ?? S.bk.id, "--provider-credentials": o.provider ?? S.provider, "--db-app": o.app ?? S.app, "--db-report": o.report ?? S.report, "--db-ca": o.ca ?? "none" };
  const X = { out: [], code: null, sig: {}, plan, rdir };
  X.proc = { argv: ["node", "cli", "reconcile", ...Object.entries(f).flat()], platform: process.platform, versions: process.versions, execArgv: [], env: o.env ?? {},
    getuid: () => process.getuid(), fsConstants: FS_CONSTANTS, onSignal: (n, fn) => { X.sig[n] = fn; }, monotonic: () => performance.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (id) => clearTimeout(id),
    stdout: { once: () => {}, write: (s, cb) => { X.out.push(s); cb(); return true; } }, exit: (c) => { if (X.code === null) X.code = c; }, setExitCode: () => {},
    now: o.now ?? (() => S.clock()) };
  const hooks = { ...RC.defaultHooks(), launch: { exchanges: { hostaway: o.wrapExchange ? o.wrapExchange(X, S.t.x.hostaway) : S.t.x.hostaway }, loopbackEndpointsForTests: o.loopback ?? true,
    ...(o.beforeStage ? { beforeStage: (st) => o.beforeStage(st, X) } : {}), ...(o.core ? { core: o.core } : {}) } };
  await RC.main(X.proc, hooks);
  X.line = X.out.length === 1 ? JSON.parse(X.out[0]) : null;
  assert.equal(scrub(X.out.join("")), null, "no secret / login text in the output");
  return X;
}
const nativeFiles = (S) => treeHash(S.ndir);

test("RC1 happy (and STALE package): the stopped native package is stale NOW, accepted only as HISTORICAL evidence at its pinned clock → RECONCILED (exit 0); native package / journal / head byte-identical; ONE new reconcile journal agreeing with the result; GET-only, zero Stripe, zero provider writes; cleanup NOT handed off", async () => {
  const S = await nsStoppedRun();
  S.jump = 3 * 3600_000;                                             // business clock +3 h: the 30-min quote cap has long passed
  assert.equal(bindRunPackageR1Journal(S.pk.input, S.clock()).ok, false, "at NOW the accepted binder refuses the package (no execution authority)");
  const before = nativeFiles(S); const stripe0 = stripeCalls(S); const hw0 = hostawayWrites(S); const gets0 = S.t.x.log.length;
  const X = await reconcile(S);
  assert.deepEqual([X.line.outcome, X.code, X.line.result.run.outcome, X.line.result.run.cleanup], ["RECONCILED", 0, "RECONCILED_CONFIRMED", "REQUIRES_OWN_PLAN_AND_FRESH_PROOFS"], JSON.stringify(X.line));
  assert.equal(nativeFiles(S), before, "old package / journal / head byte-identical");
  assert.deepEqual([stripeCalls(S) - stripe0, hostawayWrites(S) - hw0], [0, 0]);
  const calls = S.t.x.log.slice(gets0); assert.ok(calls.every((c) => c.method === "GET") && calls.length <= 20, JSON.stringify(calls.map((c) => c.method)));
  assert.deepEqual(X.line.result.provenance.trustedHead, S.native.trustedHead);
  assert.equal(X.line.result.provenance.historicalClock, X.plan.nativeExecClock);
  const j = await readReconcileJournalR1(join(X.rdir, "journal", journalName(X.plan.runId))); assert.equal(j.ok, true);
  assert.deepEqual([j.records.at(-1).type, j.records.at(-1).data.outcome], ["TEARDOWN", "RECONCILED_CONFIRMED"]);
  assert.deepEqual(X.line.result.teardown.pools, { app: "ended", report: "ended" }); assert.equal(await advisory(), 0);
  assert.equal(await state(S.bk.id), "reservation_confirmed");
  const q = await opsAll(S.bk.id); assert.ok(q.filter((x) => x.op_type === "stripe.capture_payment_intent").every((x) => x.state === "pending" && x.attempts === 0), "capture fence: queued, never dispatched");
});

test("RC2 refusals BEFORE any secret / DB / new dir: plan hash / runId / intent / package hash / PI mismatch; namespace (wrong basename, existing reconcile dir, group-readable dir, symlinked journal dir)", async () => {
  const S = await nsStoppedRun(); const snap = await dbSnap(S.bk.id); const nf = nativeFiles(S);
  const noSecret = join(S.priv, "no-such-provider.json");          // the provider path does not even exist: no stage reached it
  const cases = [
    [{ planSha: "0".repeat(64) }, "plan", "RECOVERY_PLAN_HASH_MISMATCH"],
    [{ over: { runId: "rc-other-0001" }, rdir: join(S.priv, "runs", "rc-mismatch-0001") }, "plan", "PLAN_RUN_ID_MISMATCH"],
    [{ intent: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" }, "plan", "PLAN_INTENT_MISMATCH"],
    [{ pkgHash: "1".repeat(64) }, "plan", "PLAN_PACKAGE_MISMATCH"],
    [{ over: { paymentIntentId: "pi_otherOTHER123" } }, "package", "PACKAGE_PI_MISMATCH"]];
  for (const [o, st, code] of cases) {
    const X = await reconcile(S, { provider: noSecret, ...o });
    assert.deepEqual([X.line.outcome, X.line.stage, X.line.code, X.code], ["REFUSED", st, code, 4], JSON.stringify(X.line)); assert.equal(existsSync(X.rdir), false, code);
  }
  { const bad = join(dirname(S.priv), "notprivate"); mk700(bad); mk700(join(bad, "runs")); const nd = join(bad, "runs", S.nid); cpSync(S.ndir, nd, { recursive: true });
    const X = await reconcile(S, { provider: noSecret, ndir: nd, rdir: join(bad, "runs", "rc-ns-bad-0001"), over: { runId: "rc-ns-bad-0001" } });
    assert.deepEqual([X.line.stage, X.line.code], ["namespace", "RUN_DIR_NAMESPACE_INVALID"]); }
  { const rid = "rc-exists-0001"; mk700(join(S.priv, "runs", rid));
    const X = await reconcile(S, { provider: noSecret, over: { runId: rid } }); assert.deepEqual([X.line.stage, X.line.code], ["namespace", "RECONCILE_RUN_DIR_EXISTS"]); }
  { const c = copyNs(S); chmodSync(join(c.ndir, "journal"), 0o750);
    const X = await reconcile(S, { provider: noSecret, priv: c.priv, ndir: c.ndir }); assert.deepEqual([X.line.stage, X.line.code], ["namespace", "RUN_DIR_UNSAFE"]); }
  { const c = copyNs(S); const real = join(c.priv, "elsewhere"); renameSync(join(c.ndir, "journal"), real); symlinkSync(real, join(c.ndir, "journal"));
    const X = await reconcile(S, { provider: noSecret, priv: c.priv, ndir: c.ndir }); assert.equal(X.line.stage, "namespace");
    assert.ok(["RUN_DIR_UNSAFE", "RUN_DIR_NOT_CANONICAL"].includes(X.line.code), X.line.code); }            // PR63 N1: the canonical check now fires first
  assert.equal(await dbSnap(S.bk.id), snap, "zero DB writes"); assert.equal(nativeFiles(S), nf, "native files untouched");
});

test("RC3 provenance (D2/D6): wrong / behind trusted head, altered record, torn tail, missing journal → REFUSED at provenance; missing head file → the frozen core's accepted reader refuses; historical clock before package / after RUN_STARTED / journal in the future → REFUSED", async () => {
  const S = await nsStoppedRun(); const snap = await dbSnap(S.bk.id);
  const H0 = S.native.trustedHead; const jf = (nd) => join(nd, "journal", journalFileNameR1(S.nid));
  const pv = async (o, code, st = "provenance") => { const X = await reconcile(S, o); assert.deepEqual([X.line.outcome, X.line.stage, X.line.code], ["REFUSED", st, code], JSON.stringify(X.line)); return X; };
  await pv({ head: `${H0.seq}:${"f".repeat(64)}` }, "TRUSTED_HEAD_MISMATCH");
  await pv({ head: `${H0.seq - 1}:${H0.hash}` }, "TRUSTED_HEAD_MISMATCH");
  { const c = copyNs(S); const t = readFileSync(jf(c.ndir), "utf8").split("\n"); const r = JSON.parse(t[1]); r.at += 1; t[1] = JSON.stringify(r); writeFileSync(jf(c.ndir), t.join("\n"));
    const X = await reconcile(S, { priv: c.priv, ndir: c.ndir }); assert.equal(X.line.stage, "provenance"); assert.ok(["NATIVE_JOURNAL_INVALID", "TRUSTED_HEAD_MISMATCH"].includes(X.line.code), X.line.code); }
  { const c = copyNs(S); const b = readFileSync(jf(c.ndir)); writeFileSync(jf(c.ndir), b.subarray(0, b.length - 5)); await pv({ priv: c.priv, ndir: c.ndir }, "NATIVE_JOURNAL_TORN"); }
  { const c = copyNs(S); rmSync(jf(c.ndir)); await pv({ priv: c.priv, ndir: c.ndir }, "NATIVE_JOURNAL_UNREADABLE"); }
  { const c = copyNs(S); rmSync(join(c.ndir, "head", headFileNameR1(S.nid)));
    const X = await reconcile(S, { priv: c.priv, ndir: c.ndir });
    assert.deepEqual([X.line.outcome, X.line.stage, X.line.result.run.code], ["REFUSED", "run", "NATIVE_RUN_NOT_PROVEN_STOPPED"], JSON.stringify(X.line)); }
  const first = JSON.parse(readFileSync(jf(S.ndir), "utf8").split("\n")[0]);
  const ev = S.pk.built.package.evaluatedAt ?? null;
  await pv({ over: { nativeExecClock: first.at + 1 } }, "NATIVE_CLOCK_AFTER_RUN_START");
  { const X = await reconcile(S, { over: { nativeExecClock: S.bk.base + 5 * SEC - 1 } }); assert.equal(X.line.outcome, "REFUSED"); assert.ok(["package", "provenance"].includes(X.line.stage), X.line.stage);
    assert.ok(/CLOCK_BEFORE_PACKAGE/.test(X.line.code), `${X.line.code} (evaluatedAt ${ev})`); }
  await pv({ now: () => first.at - 1 }, "NATIVE_JOURNAL_FUTURE");
  assert.equal(await dbSnap(S.bk.id), snap, "zero DB writes");
});

test("RC4 DB identity (D4 narrow reuse): non-DEV endpoint (no loopback seam) → ENDPOINT_MODE_REFUSED; unreadable CA → CA_READ_FAILED; app slot logged in as the REPORT role → refused (reader or accepted checkSameDatabase); report slot on ANOTHER database → refused; pools ended, zero writes", async () => {
  const S = await nsStoppedRun(); const snap = await dbSnap(S.bk.id);
  { const X = await reconcile(S, { loopback: false }); assert.deepEqual([X.line.stage, X.line.code], ["db-endpoint", "ENDPOINT_MODE_REFUSED"]); }
  { const X = await reconcile(S, { ca: join(S.priv, "no-ca.pem") }); assert.deepEqual([X.line.stage, X.line.code], ["db-ca", "CA_READ_FAILED"]); }
  { const files = ownerDir("rc-files-"); const app = loginFile(files, "app.json", "mv_booking_app", "test_report");
    const X = await reconcile(S, { app }); assert.equal(X.line.outcome, "REFUSED"); assert.ok(["db-identity", "db-login-app", "db-login-pair"].includes(X.line.stage), X.line.stage);
    if (X.line.stage === "db-identity") { assert.equal(X.line.code, "ROLE_NOT_APP"); assert.deepEqual(X.line.result.teardown.pools, { app: "ended", report: "ended" }); } }
  { await db.owner.query("DROP DATABASE IF EXISTS rc_otherdb"); await db.owner.query("CREATE DATABASE rc_otherdb");
    const files = ownerDir("rc-files-"); const report = put(files, "report.json", JSON.stringify({ schema: "e7-db-login-v1", role: "mv_booking_report",
      connectionString: `postgresql://test_report:${CANARY}@127.0.0.1:${portOf()}/rc_otherdb` }));
    const X = await reconcile(S, { report }); assert.equal(X.line.outcome, "REFUSED");
    // the accepted login reader already refuses a pair whose targets differ (DB_TARGET_TEXT_MISMATCH); identity SQL is the second fence
    assert.ok(["db-login-pair", "db-identity", "db-endpoint"].includes(X.line.stage) && ["DB_TARGET_TEXT_MISMATCH", "DB_IDENTITY_UNREADABLE", "POOLS_MISMATCH", "MARKER_INVALID", "ENDPOINT_MODE_REFUSED"].includes(X.line.code), JSON.stringify([X.line.stage, X.line.code]));
    await db.owner.query("DROP DATABASE IF EXISTS rc_otherdb WITH (FORCE)"); }
  assert.equal(await dbSnap(S.bk.id), snap); assert.equal(await advisory(), 0);
});

test("RC5 signals + bounded teardown: first SIGINT before the core → REFUSED INTERRUPTED at the next stage (pools ended, no reconcile dir); second signal → terminal exit 130; core STOPPED via the CLI (by-id 503 at the precheck) → exit 6, pools ended, no lock left, zero DB writes", async () => {
  const S = await nsStoppedRun(); const snap = await dbSnap(S.bk.id);
  { const X = await reconcile(S, { beforeStage: (st, X0) => { if (st === "db-identity") X0.sig.SIGINT(); } });
    assert.deepEqual([X.line.outcome, X.line.stage, X.line.code], ["REFUSED", "db-identity", "INTERRUPTED"]); assert.deepEqual(X.line.result.teardown.pools, { app: "ended", report: "ended" });
    assert.equal(existsSync(X.rdir), false); }
  { const X = await reconcile(S, { beforeStage: (st, X0) => { if (st === "plan") { X0.sig.SIGINT(); X0.sig.SIGTERM(); } } });
    assert.equal(X.code, 130, "second signal: terminal exit"); assert.equal(X.out.length, 0, "no result line after the terminal exit"); }
  { const real = S.w.exec.R.retrieveReservation; S.w.exec.R.retrieveReservation = async () => ({ httpStatus: 503, json: { status: "fail" } });
    const X = await reconcile(S); S.w.exec.R.retrieveReservation = real;
    assert.deepEqual([X.line.outcome, X.code, X.line.result.run.outcome, X.line.result.run.steps], ["STOPPED", 6, "STOPPED", 0], JSON.stringify(X.line));
    assert.deepEqual(X.line.result.teardown.pools, { app: "ended", report: "ended" }); }
  assert.equal(await dbSnap(S.bk.id), snap); assert.equal(await advisory(), 0);
});

// =================================================================================================================================
// ROOT PR63 review (3f019898): P1 package scope, N1 canonical namespace, S1 signal inside the core
test("RC6 P1 package scope: a ONE-field change of any shared original scope field (ref / listing / currency / refFieldId / stay / guests / amount / rate) is REFUSED before secrets / DB / new dir", async () => {
  const S = await nsStoppedRun(); const snap = await dbSnap(S.bk.id); const nf = nativeFiles(S);
  const noSecret = join(S.priv, "no-such-provider.json");
  const i = await loadIntent(db.app, S.bk.id);
  const muts = { ref: `${i.ref.slice(0, -1)}${i.ref.endsWith("A") ? "B" : "A"}`, listingId: 606999, currency: "MXN", refFieldId: REF_FIELD + 1, from: addDays(i.from, 1),
    to: addDays(i.to, 1), guests: i.guests + 1, totalMinor: i.price.finalTotalMinor + 1, rateBps: S.bk.price.rateBps + 1 };
  for (const [k, v] of Object.entries(muts)) {
    const X = await reconcile(S, { provider: noSecret, over: { [k]: v } });
    assert.equal(X.line.outcome, "REFUSED", k); assert.ok(["plan", "package"].includes(X.line.stage), `${k}: ${X.line.stage}/${X.line.code}`);
    if (X.line.stage === "package") assert.deepEqual([X.line.code, X.line.result.field], ["PACKAGE_SCOPE_MISMATCH", k], k);
    assert.equal(existsSync(X.rdir), false, k);
  }
  { const X = await reconcile(S, { provider: noSecret, over: { totalMinor: S.bk.price.finalTotalMinor + 1 } });          // ROOT's exact repro
    assert.deepEqual([X.line.stage, X.line.code, X.line.result.field], ["package", "PACKAGE_SCOPE_MISMATCH", "totalMinor"]); }
  assert.equal(await dbSnap(S.bk.id), snap); assert.equal(nativeFiles(S), nf);
});

test("RC7 N1 canonical namespace: a symlinked ANCESTOR of the namespace (ROOT's repro) / a symlinked .maravilla-private / a symlinked native run dir → REFUSED at namespace before secrets / DB / new dir; real tree unchanged", async () => {
  const S = await nsStoppedRun(); const snap = await dbSnap(S.bk.id); const nf = nativeFiles(S);
  const noSecret = join(S.priv, "no-such-provider.json");
  const cases = [];
  { const link = join(ownerDir("rc-link-"), "link"); symlinkSync(dirname(S.priv), link); cases.push(["ancestor", join(link, ".maravilla-private")]); }
  { const holder = ownerDir("rc-link2-"); const lp = join(holder, ".maravilla-private"); symlinkSync(S.priv, lp); cases.push(["private", lp]); }
  for (const [label, priv] of cases) {
    const runsBefore = readdirSync(join(S.priv, "runs")).sort().join();
    const X = await reconcile(S, { provider: noSecret, priv, ndir: join(priv, "runs", S.nid) });
    assert.deepEqual([X.line.outcome, X.line.stage, X.line.code], ["REFUSED", "namespace", "RUN_DIR_NOT_CANONICAL"], `${label}: ${JSON.stringify(X.line)}`);
    assert.equal(readdirSync(join(S.priv, "runs")).sort().join(), runsBefore, `${label}: no new dir in the real tree`);
  }
  { const c = copyNs(S); const real = join(c.priv, "real-run"); renameSync(c.ndir, real); symlinkSync(real, c.ndir);
    const X = await reconcile(S, { provider: noSecret, priv: c.priv, ndir: c.ndir }); assert.deepEqual([X.line.stage, X.line.code], ["namespace", "RUN_DIR_NOT_CANONICAL"]); }
  assert.equal(await dbSnap(S.bk.id), snap); assert.equal(nativeFiles(S), nf);
});

/** count Hostaway exchanges; fire the FIRST signal on exchange k (then return the normal reply) */
const sigAt = (k, box) => (X, base) => async (req) => { box.n += 1; if (box.n === k) X.sig.SIGINT(); return base(req); };
const evid = async (id) => all(`SELECT e.status, o.op_type FROM booking.provider_evidence e JOIN booking.external_operations o ON o.id = e.read_operation_id WHERE o.intent_id = $1 ORDER BY e.id`, [id]);
test("RC8 S1 signal INSIDE the core: at the first GET / at the first worker read / at the final read → STOPPED INTERRUPTED (exit 6), no GET after it, the late reply dropped (no evidence from it), already-applied state reported, journal agrees, teardown settled; second signal → 130", async () => {
  // (a) ROOT's repro: first exchange
  { const S = await nsStoppedRun(); const snap = await dbSnap(S.bk.id); const box = { n: 0 };
    const X = await reconcile(S, { wrapExchange: sigAt(1, box) });
    assert.deepEqual([X.line.outcome, X.code, X.line.result.run.outcome, X.line.result.run.code, box.n, X.line.interrupted], ["STOPPED", 6, "STOPPED", "INTERRUPTED", 1, true], JSON.stringify(X.line));
    assert.equal(await dbSnap(S.bk.id), snap, "zero DB writes");
    const j = await readReconcileJournalR1(join(X.rdir, "journal", journalName(X.plan.runId)));
    assert.deepEqual([j.records.at(-1).type, j.records.at(-1).data.outcome, j.records.at(-1).data.code, X.line.result.run.audit], ["TEARDOWN", "STOPPED", "INTERRUPTED", "complete"]);
    assert.deepEqual(X.line.result.teardown.pools, { app: "ended", report: "ended" }); assert.equal(await advisory(), 0); }
  // (b) first WORKER read (precheck = lookup + by-id = 2 exchanges)
  { const S = await nsStoppedRun(); const e0 = await evid(S.bk.id); const box = { n: 0 };
    const X = await reconcile(S, { wrapExchange: sigAt(3, box) });
    assert.deepEqual([X.line.outcome, X.line.result.run.code, box.n], ["STOPPED", "INTERRUPTED", 3], JSON.stringify(X.line));
    assert.ok(X.line.result.run.steps <= 1, "no step after the signal");
    assert.equal(await state(S.bk.id), "reservation_pending", "the dropped reply never confirmed the reservation");
    const e1 = await evid(S.bk.id);
    assert.equal(e1.filter((x) => x.status === "found_active").length, e0.filter((x) => x.status === "found_active").length, "no found evidence from the dropped reply");
    assert.equal(await advisory(), 0); }
  // (c) the FINAL read (normal run: 2 precheck + 3 worker + 2 final) → the reservation was ALREADY confirmed: reported, never rolled back, never success
  { const S = await nsStoppedRun(); const box = { n: 0 };
    const X = await reconcile(S, { wrapExchange: sigAt(6, box) });
    assert.deepEqual([X.line.outcome, X.line.result.run.code, X.line.result.run.dbState, X.line.result.run.cleanup, box.n], ["STOPPED", "INTERRUPTED", "reservation_confirmed", "NOT_HANDED_OFF", 6], JSON.stringify(X.line));
    assert.equal(await state(S.bk.id), "reservation_confirmed"); assert.equal(await advisory(), 0); }
  // (d) second signal inside the core → terminal 130 (tail uncertain)
  { const S = await nsStoppedRun(); const box = { n: 0 };
    const X = await reconcile(S, { wrapExchange: (X0, base) => async (req) => { box.n += 1; if (box.n === 1) { X0.sig.SIGINT(); X0.sig.SIGTERM(); } return base(req); } });
    assert.equal(X.code, 130); }
});

test("RC9 S1 at the core boundary (direct runReconcileR1 with a signal): aborted after the final DB work / when the terminal record returns → STOPPED INTERRUPTED with result / journal agreement; a pre-aborted signal → REFUSED INTERRUPTED before any GET / lock", async () => {
  const run = async (S, o) => { const plan = await planFor(S, { runId: `rc-core-${String(++rcN).padStart(4, "0")}` }); const jdir = ownerDir("rc-cj-");
    const r = await runReconcileR1({ plan, pools: { app: db.app, report: reportPool }, hostawaySend: S.t.hostaway.send, clock: () => S.clock(), journalDir: jdir, uid: process.getuid(),
      native: { packageInput: S.pk.input, journalDir: S.jd, headDir: S.hd, trustedHead: S.native.trustedHead }, signal: o.signal, hooks: o.hooks ?? {}, ...(o.journalOpen ? { journalOpen: o.journalOpen } : {}) });
    const j = await readReconcileJournalR1(join(jdir, journalName(plan.runId)));
    const last = j.ok ? [...j.records].reverse().find((x) => x.type === "TEARDOWN" || x.type === "DOWNGRADED") : null;
    if (!j.ok) assert.equal(r.journalHead, null, "no journal was opened (refused before it)");
    else assert.ok(r.audit !== "complete" || (last && last.data.outcome === r.outcome && last.data.code === r.code), `agreement ${r.audit} ${JSON.stringify(last && last.data)}`);
    return r; };
  { const S = await nsStoppedRun(); const ac = new AbortController(); ac.abort(); const g0 = S.t.x.log.length;
    const r = await run(S, { signal: ac.signal }); assert.deepEqual([r.outcome, r.code, r.lock, S.t.x.log.length - g0], ["REFUSED", "INTERRUPTED", "not_acquired", 0]); }
  { const S = await nsStoppedRun(); const ac = new AbortController();
    const r = await run(S, { signal: ac.signal, hooks: { afterFinalDb: () => ac.abort() } });
    assert.deepEqual([r.outcome, r.code, r.dbState, r.cleanup, r.lock], ["STOPPED", "INTERRUPTED", "reservation_confirmed", "NOT_HANDED_OFF", "released"]); }
  { const S = await nsStoppedRun(); const ac = new AbortController();
    const journalOpen = async (o) => { const jo = await openReconcileJournalR1(o); if (!jo.ok) return jo; const j = jo.journal;
      return { ok: true, journal: { file: j.file, head: j.head, close: j.close, async append(t, at, d) { const x = await j.append(t, at, d); if (t === "ENDED") ac.abort(); return x; } } }; };
    const r = await run(S, { signal: ac.signal, journalOpen });
    assert.deepEqual([r.outcome, r.code, r.audit], ["STOPPED", "INTERRUPTED", "complete"]); }
  { const ac = new AbortController(); const r = await runReconcileR1({ plan: { x: 1 }, signal: ac.signal }); assert.equal(r.outcome, "REFUSED"); }
});

// ROOT PR63 rev2 review (3b2c08ec) S2 — worker ADMISSION: an interruption during the awaited lock proof / beforeStep admits NO worker step
test("RC10 S2 admission: abort inside beforeStep (ROOT's repro) / WHILE the real own-lock proof query completes → STOPPED INTERRUPTED, ZERO admitted steps, tracked facts unchanged, journal agreement, lock released", async () => {
  const run = async (S, o) => { const plan = await planFor(S, { runId: `rc-s2-${String(++rcN).padStart(4, "0")}` }); const jdir = ownerDir("rc-s2j-");
    const r = await runReconcileR1({ plan, pools: { app: db.app, report: o.report ?? reportPool }, hostawaySend: S.t.hostaway.send, clock: () => S.clock(), journalDir: jdir,
      uid: process.getuid(), native: { packageInput: S.pk.input, journalDir: S.jd, headDir: S.hd, trustedHead: S.native.trustedHead }, signal: o.signal, hooks: o.hooks ?? {} });
    const j = await readReconcileJournalR1(join(jdir, journalName(plan.runId))); assert.equal(j.ok, true);
    const last = [...j.records].reverse().find((x) => x.type === "TEARDOWN" || x.type === "DOWNGRADED");
    assert.deepEqual([r.audit, last.data.outcome, last.data.code], ["complete", r.outcome, r.code], "journal agrees");
    assert.equal(j.records.filter((x) => x.type === "STEP").length, 0, "no STEP journalled");
    return r; };
  { const S = await nsStoppedRun(); const ac = new AbortController(); let snap = null;
    const r = await run(S, { signal: ac.signal, hooks: { beforeStep: async () => { snap = await dbSnap(S.bk.id); ac.abort(); } } });
    assert.deepEqual([r.outcome, r.code, r.steps.length, r.lock], ["STOPPED", "INTERRUPTED", 0, "released"], JSON.stringify(r));
    assert.equal(await dbSnap(S.bk.id), snap, "tracked facts unchanged after the interruption"); assert.equal(await advisory(), 0); }
  { const S = await nsStoppedRun(); const ac = new AbortController(); let armed = false; let snap = null; let fired = 0;
    const report = { connect: async () => { const c = await reportPool.connect(); const q = c.query.bind(c);
      c.query = async (sql, p) => { const res = await q(sql, p); if (armed && sql === OWN_LOCK_SQL && fired === 0) { fired += 1; snap = await dbSnap(S.bk.id); ac.abort(); } return res; }; return c; } };
    const r = await run(S, { signal: ac.signal, report, hooks: { afterPrecheck: () => { armed = true; } } });
    assert.equal(fired, 1, "aborted while the real own-lock proof completed");
    assert.deepEqual([r.outcome, r.code, r.steps.length, r.lock], ["STOPPED", "INTERRUPTED", 0, "released"], JSON.stringify(r));
    assert.equal(await dbSnap(S.bk.id), snap, "tracked facts unchanged"); assert.equal(await advisory(), 0); }
});
