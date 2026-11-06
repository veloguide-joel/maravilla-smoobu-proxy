// E7 M2-D — runAbortRehearsalV2 (v2 reservation → intentional TEST abort → cleanup) on a DISPOSABLE local PG (migrations 0001–0017 incl. the
// 0017 LOCAL candidate; never a shared DB). No network, no provider, no credentials.
//
// LABELS
//   * PG ENFORCEMENT: pools.report = a real mv_booking_report login, pools.app = the harness's real mv_booking_app login. The core, C, the REAL
//     accepted reservation + compensation workers, the accepted operator core / helper and the accepted M2-C bridge run UNCHANGED against them.
//   * SYNTHETIC: the provider world, booking setup, fake transports, timeDriver, FaultPool / FaultClient and terminate() are a LABELLED COPY of
//     test/db/e7-connected-runner.test.mjs:49–235 and :240–344 (itself the accepted adapter rehearsal's copy). TWO changes: (1) bookings use the
//     accepted TEST-abort listing 606998 (lib/booking-db/test-abort.js TEST_ABORT_LISTINGS) with distinct stays; (2) the synthetic PaymentIntent /
//     Checkout Session ids match the accepted helper's formats (PI_RE / CS_RE; the copied `pi_test_car1` / `cs_test_car1` do not).
//   * EXTERNAL ACTORS (labelled): an abort applied OUTSIDE the run (the accepted executeOperatorAbort), a planted work lease (owner), DECOY
//     intents with eligible maintenance work. Synthetic attestations name the manifest mode's checkpoints; never Airbnb / calendar proof.
//   * TIME: scaled real timers (timeDriver K=10); the business clock is the v1 rehearsal's default behind-real-time clock.
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
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
import { CHECKPOINTS_BY_CONNECTION } from "../../scripts/e7-connected/run-manifest-v2.mjs";
import { createMemoryJournalV2, validateJournalV2 } from "../../scripts/e7-connected/run-journal-memory-v2.mjs";
import { SQL as FACTS_SQL } from "../../scripts/e7-connected/run-facts.mjs";
import { SQL } from "../../scripts/e7-connected/run-core.mjs";
import { runAbortRehearsalV2, SQL_CLAIM_HELD } from "../../scripts/e7-connected/run-core-abort-v2.mjs";
import { executeOperatorAbort, buildAbortExpectation } from "../../scripts/e7-operator/test-abort.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ABORT_LISTING = 606998;
let netAttempts = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { netAttempts += 1; throw new Error("network refused in the offline M2-D suite"); };
let db; let reportPool;
before(async () => { db = await startMigratedDatabase(); reportPool = new pg.Pool({ connectionString: db.reportUrl(), max: 8 }); });
after(async () => { globalThis.fetch = realFetch; await reportPool.end().catch(() => {}); await db.close(); assert.equal(netAttempts, 0); });
void FACTS_SQL; void SQL;

// ===== LABELLED COPY of test/db/e7-connected-runner.test.mjs:49–235 (world, booking, transports) — TWO changes, see header =====
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

// ---------------------------------------------------------------------------------------------
// FAKE injected transports over the world: the adapters' documented envelopes (hostaway.send / stripe.send); every invocation counted.
const pj = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));   // adapters hand frozen null-prototype copies
function transports(w) {
  const t = { h: [], s: [] };
  const priced = (r) => ({ httpStatus: r.status, json: r.json });
  t.hostaway = { send: async (req, x) => {
    assert.ok(x.signal instanceof AbortSignal && !x.signal.aborted, "the worker's live signal reaches the transport");
    const m = req.method; const p = req.path; const q = pj(req.query); const b = pj(req.body);
    assert.ok(/^\/v1\/(?!v1\/)/.test(p), "exactly one /v1 prefix");
    t.h.push(`${m} ${p}`);
    if (m === "GET" && /^\/v1\/listings\/\d+$/.test(p)) return priced(await w.pricing.get(p.slice(3)));
    if (m === "GET" && /^\/v1\/listings\/\d+\/calendar$/.test(p)) return priced(await w.pricing.get(p.slice(3), { query: q }));
    if (m === "POST" && /^\/v1\/listings\/\d+\/calendar\/priceDetails$/.test(p)) return priced(await w.pricing.post(p.slice(3), b));
    if (m === "GET" && p === "/v1/reservations") return w.exec.R.lookupPage({ method: m, path: p, query: q });
    if (m === "GET" && /^\/v1\/reservations\/\d+$/.test(p)) return w.exec.R.retrieveReservation({ method: m, path: p, query: q });
    if (m === "POST" && p === "/v1/reservations") return w.exec.R.createReservation({ method: m, path: p, query: q, body: b });
    if (m === "PUT" && /^\/v1\/reservations\/\d+\/statuses\/cancelled$/.test(p)) return w.exec.K.cancelReservation({ method: m, path: p, query: q, body: b });
    if (m === "GET" && p === "/v1/guestPayments/charges") return w.exec.W.listOfflineCharges({ method: m, path: p, query: q });
    if (m === "POST" && /^\/v1\/guestPayments\/charges\/\d+$/.test(p)) return w.exec.W.createOfflineCharge({ method: m, path: p, query: q, body: b });
    throw new Error("unmapped fake route");
  } };
  t.stripe = { send: async (call, x) => {
    assert.ok(x.signal instanceof AbortSignal && !x.signal.aborted);
    t.s.push(call.op);
    const c = pj(call);
    if (c.op === "accounts.retrieve") return w.exec.C.retrieveAccount();
    if (c.op === "paymentIntents.retrieve") return w.exec.C.retrievePaymentIntent(c.id, c.params);
    if (c.op === "paymentIntents.capture") { assert.equal(typeof c.idempotencyKey, "string"); return w.exec.C.capturePaymentIntent(c.id, c.params); }
    if (c.op === "paymentIntents.cancel") { assert.equal(typeof c.idempotencyKey, "string"); return w.exec.K.cancelPaymentIntent(c.id); }
    throw new Error("unmapped fake stripe op");
  } };
  t.count = (re) => t.h.filter((x) => re.test(x)).length + t.s.filter((x) => re.test(x)).length;
  return t;
}
// ===== end of the verbatim copy =====

// ===== LABELLED COPY of test/db/e7-connected-runner.test.mjs:240–344 (harness helpers) =====
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


// ===== end of the labelled copy; M2-D harness below =====
let runN = 0;
const LIVE = [];
afterEach(async () => { for (const S of LIVE.splice(0)) await S.cleanup(); });
async function manifestFor(bk, connection = "disconnected", over = {}) {
  const i = await one("SELECT rate_bps FROM booking.intents WHERE id = $1", [bk.id]);
  runN += 1;
  return { version: "e7-run-manifest-v2", runId: `synthetic-m2d-${String(runN).padStart(4, "0")}`, intentId: bk.id, baselineCommit: BASE_COMMIT, synthetic: true,
    providerMode: { hostaway: "fake", stripe: "mock" }, listing: { id: bk.listingId, currency: "USD", refFieldId: REF_FIELD, timeZone: TZ, connection }, expectedRef: bk.ref,
    stay: { arrival: bk.stay.from, departure: bk.stay.to, guests: bk.stay.guests }, amountMinor: bk.total, pricing: { rateBps: Number(i.rate_bps) },
    stripeAccountId: ACCT, hostawayAccountLabel: { ...LABEL }, phases: { capture: false, recording: false, testAbortAfterReservation: true }, paymentMethod: null,
    cleanup: { reservedNotConfirmed: "synthetic/cleanup-reserved", captured: "synthetic/cleanup-captured", confirmed: "synthetic/cleanup-confirmed" },
    automationsReviewed: "synthetic/automations", checkpoints: [...CHECKPOINTS_BY_CONNECTION[connection]], ...over };
}
/** one M2-D scenario: fresh world / booking / v2 journal / wrappers / time; nothing shared but the disposable DB */
async function scenario(o = {}) {
  const w = o.w ?? world(o.world);
  if (o.mode) Object.assign(w.mode, o.mode);
  const bk = o.bk ?? await authorizedBooking(w);
  if (o.afterBooking) o.afterBooking(w, bk);
  const T = timeDriver(o.K ?? 10);
  const connection = o.connection ?? "disconnected";
  const manifest = o.manifest ?? await manifestFor(bk, connection, o.manifestOver);
  const jm = createMemoryJournalV2({ manifest, ...(o.journalFaults ? { faults: o.journalFaults } : {}) });
  const tl = [];
  const S = { w, bk, T, manifest, jm, tl, connection, K: CHECKPOINTS_BY_CONNECTION[connection], attestCalls: [], overrideCalls: {}, hooks: o.hooks ?? {} };
  S.app = new FaultPool(o.appPool ?? db.app, "app", tl);
  S.report = new FaultPool(o.reportPool ?? reportPool, "report", tl);
  S.t = transports(w);
  S.ac = new AbortController();
  // the v1 rehearsal's default business clock (20 min behind real time, following virtual time, capped 5 s behind real time)
  S.clock = () => Math.floor(Math.min(bk.base + 10 * SEC + T.now(), Date.now() - 5 * SEC));
  const attest = (cp, request, x) => {
    S.attestCalls.push({ cp, request: { ...request }, signalIsRun: x.signal === S.ac.signal }); tl.push(`A:${cp}`);
    const f = o.attest && o.attest[cp];
    return f ? f(S, request) : Promise.resolve({ ok: true, evidenceRef: `synthetic/${cp.toLowerCase()}` });
  };
  const j = jm.ok ? jm.journal : null;
  S.journal = j && {
    append: (rec) => {
      S.overrideCalls[rec.event] = (S.overrideCalls[rec.event] ?? 0) + 1;
      tl.push(`J:${rec.event}${rec.phase ? `:${rec.phase}` : ""}${rec.attestation ? `:${rec.attestation.checkpoint}` : ""}`);
      if (o.override && o.override[rec.event]) return o.override[rec.event](S, rec, () => j.append(rec));        // TEST-ONLY ACK override
      const h = S.hooks[rec.event];
      return h ? (async () => { await h(S, rec); return j.append(rec); })() : j.append(rec);
    },
    read: () => (S.hooks.read ? (async () => { await S.hooks.read(S); return j.read(); })() : j.read())
  };
  S.opts = { manifest, intentId: bk.id, pools: { app: S.app, report: S.report }, transports: { hostaway: S.t.hostaway, stripe: S.t.stripe }, journal: S.journal,
    trustedHead: null, attest, clock: S.clock, monotonic: T.deps.monotonic, timers: T.deps.timers, signal: S.ac.signal };
  if (o.optsOver) Object.assign(S.opts, o.optsOver);
  S.run = async () => { S.result = await runAbortRehearsalV2(S.opts); return S.result; };
  S.records = async () => (await jm.journal.read()).records;
  S.events = async () => (await S.records()).map((r) => `${r.event}${r.phase ? `:${r.phase}` : ""}${r.attestation ? `:${r.attestation.checkpoint}` : ""}${r.state ? `:${r.state}` : ""}`);
  S.cleanup = async () => { await S.app.cleanup(); await S.report.cleanup(); };
  LIVE.push(S);
  return S;
}
const plainResult = (r) => JSON.parse(JSON.stringify({ ...r, finalize: undefined }));
const state = async (id) => (await loadIntent(db.app, id)).status;
const capRow = async (id) => one("SELECT state, attempts, dispatched_at, lease_worker_id, lease_until FROM booking.external_operations WHERE intent_id = $1 AND op_type = 'stripe.capture_payment_intent'", [id]);
const claimsHeld = async (id) => Number((await one("SELECT count(*)::int AS n FROM booking.inventory_claims WHERE intent_id = $1 AND released_at IS NULL", [id])).n);
const appliedAborts = async (id) => Number((await one("SELECT count(*)::int AS n FROM booking.intent_applied_events WHERE intent_id = $1 AND event_type = 'TEST_ABORT_REQUESTED'", [id])).n);
/** notification-class operations (owner alert / guest notify): queued only — never claimed, attempted or dispatched */
const notifyOps = (id) => all(`SELECT op_type, state, attempts, dispatched_at FROM booking.external_operations WHERE intent_id = $1
  AND (op_type LIKE 'alert.%' OR op_type LIKE 'guest.%' OR op_type LIKE '%notif%') ORDER BY op_type, created_at`, [id]);
const assertNotifyUnsent = async (id, label) => { for (const n of await notifyOps(id)) assert.deepEqual([n.state, n.attempts, n.dispatched_at], ["pending", 0, null], `${label}: ${n.op_type} unsent`); };
const cleanupSteps = async (S) => (await S.records()).filter((x) => x.event === "STEP_STARTED" && x.phase === "cleanup").length;
const providerSettle = (S) => [S.t.count(/^PUT \/v1\/reservations\/\d+\/statuses\/cancelled$/), S.t.count(/^paymentIntents\.cancel$/)];
const noProtectedTraffic = (S) => assert.ok(S.t.h.every((p) => !PROTECTED.some((id) => p.includes(id))) && S.w.paths.every((p) => !PROTECTED.some((id) => p.includes(id))));
/** DECOYS (labelled): eligible maintenance work OUTSIDE the run's one intent — same listing (606998) and another listing */
async function decoys() {
  const w = world();
  const d1 = await authorizedBooking(w);                                     // same allowlisted listing, payment_authorized, work due
  const d2 = await authorizedBooking(w);                                     // same listing, a FOREIGN expired work lease (owner-planted, labelled)
  await db.owner.query("UPDATE booking.intent_work SET work_worker_id = 'decoy-ghost', work_lease_until = now() - interval '1 hour', next_action_at = now() - interval '1 hour' WHERE intent_id = $1", [d2.id]);
  const d3 = await authorizedBooking(w, { listingId: 871777 });             // another listing
  const ids = [d1.id, d2.id, d3.id];
  const snap = async () => JSON.stringify(await all(`SELECT i.id, i.state, i.version, w.work_worker_id, w.work_lease_until, w.next_action_at,
      (SELECT count(*) FROM booking.external_operations o WHERE o.intent_id = i.id) AS ops,
      (SELECT json_agg(json_build_array(o.op_type, o.state, o.attempts, o.lease_worker_id) ORDER BY o.created_at, o.id) FROM booking.external_operations o WHERE o.intent_id = i.id) AS opstate
    FROM booking.intents i LEFT JOIN booking.intent_work w ON w.intent_id = i.id WHERE i.id = ANY($1::uuid[]) ORDER BY i.id`, [ids]));
  return { ids, before: await snap(), snap };
}

// =================================================================================================================================
test("M1 the whole synthetic lifecycle in BOTH modes, with decoys: reserved → mode BLOCKED → bridge ONCE → ACKed receipt → gate → cleanup (both legs) → claim released (LOCAL 0017) → mode REOPENED → ENDED_RELEASED", async () => {
  const dz = await decoys();
  for (const connection of ["disconnected", "airbnb"]) {
    let cap0 = null; let evidAtBlocked = null;
    const S = await scenario({ connection, attest: { [CHECKPOINTS_BY_CONNECTION[connection][1]]: async (S0, req) => {   // the capture row exists once reserved
      cap0 = await capRow(S0.bk.id);
      evidAtBlocked = await all("SELECT kind, source, external_ref, status, observed, observed_at, read_operation_id FROM booking.provider_evidence WHERE intent_id = $1 AND kind = 'hostaway_reservation' ORDER BY created_at, id", [S0.bk.id]);
      return { ok: true, evidenceRef: `synthetic/${req.checkpoint.toLowerCase()}` }; } } });
    const r = await S.run();
    const ev = await S.events();
    console.log(`# M1 ${connection} journal: ${JSON.stringify(ev)}`);
    assert.deepEqual([r.ok, r.outcome, r.stopCode, r.ownerCleanupRequired, r.effectsKnown, r.journalTerminal, r.journalTail, r.bridgeCalls, r.connection],
      [true, "ENDED_RELEASED", null, null, true, "acknowledged", "KNOWN", 1, connection], JSON.stringify(plainResult(r)));
    assert.deepEqual({ ...r.writes }, { ...W0, create: 1, cancel: 1, void: 1 });
    assert.deepEqual([S.t.count(/^POST \/v1\/reservations$/), ...providerSettle(S), S.t.count(/^paymentIntents\.capture$/), S.t.count(/^POST \/v1\/guestPayments\/charges/)],
      [1, 1, 1, 0, 0], "1 create / 1 host-cancel / 1 authorization-void; capture / record 0");
    assert.equal(S.t.count(/refund/i), 0);
    const K = S.K;
    assert.deepEqual(S.attestCalls.map((a) => a.cp), [K[0], K[1], K[2]], "the mode's own checkpoints, in order");
    assert.ok(S.attestCalls.every((a) => a.signalIsRun && a.request.connection === connection));
    const iB = ev.indexOf(`ATTESTED:${K[1]}`);
    assert.deepEqual(ev.slice(iB - 1, iB + 3), ["PHASE_ENDED:reservation:reservation_confirmed", `ATTESTED:${K[1]}`, "ABORT_REQUEST_STARTED", "ABORT_ACCEPTED"]);
    assert.ok(ev.indexOf("STEP_STARTED:cleanup") > ev.indexOf("ABORT_ACCEPTED"), "cleanup only after the ACKed receipt");
    assert.deepEqual(ev.slice(-3), ["PHASE_ENDED:cleanup:cancelled", `ATTESTED:${K[2]}`, "RUN_ENDED"]);
    // the bridge's receipt became the run's head; the final journal validates anchored to the run's last ACKed head
    const recs = await S.records();
    const fin = validateJournalV2(recs, S.manifest, { trustedHead: { ...r.trustedHead } });
    assert.deepEqual([fin.ok, fin.status, fin.anchored, r.trustedHead.seq], [true, "ENDED", true, recs.length]);
    assert.deepEqual([r.bridge.outcome, r.bridge.receiptLanding, r.bridge.operatorCoreInvocations, r.bridge.requestHelperInvocations, r.bridge.dbAbortApplied],
      ["ABORT_ACCEPTED_JOURNALED", "ACKED", 1, 1, true]);
    // DB: both legs proved, claim released (LOCAL 0017), capture row pristine + untouched, notifications queued only
    assert.deepEqual({ ...r.release }, { state: "cancelled", reason: "TEST_ABORT_REQUESTED", legs: "true/true", claimsHeld: 0 });
    assert.equal(await state(S.bk.id), "cancelled"); assert.equal(await claimsHeld(S.bk.id), 0); assert.equal(await appliedAborts(S.bk.id), 1);
    assert.deepEqual(await capRow(S.bk.id), cap0, "capture row byte-identical"); assert.deepEqual([cap0.state, cap0.attempts, cap0.dispatched_at, cap0.lease_worker_id], ["pending", 0, null, null]);
    await assertNotifyUnsent(S.bk.id, connection);
    // root b43935f0: the REAL reservation worker's pre-create by-ref absence row is history the abort tolerated: present, unchanged, never rewritten
    const evid = await all("SELECT kind, source, external_ref, status, observed, observed_at, read_operation_id FROM booking.provider_evidence WHERE intent_id = $1 AND kind = 'hostaway_reservation' ORDER BY created_at, id", [S.bk.id]);
    assert.deepEqual(evidAtBlocked.map((x) => [x.source, x.external_ref, x.status, x.observed]), [["hostaway_api", S.bk.ref, "not_found", { bookingRef: S.bk.ref, matchCount: 0 }]],
      "at the abort, the ONLY reservation evidence is the real worker's pre-create absence row");
    assert.deepEqual(evid.slice(0, evidAtBlocked.length), evidAtBlocked, "append-only: that row is unchanged at the end");
    assert.ok(evid.slice(evidAtBlocked.length).every((x) => x.source === "hostaway_api" && typeof x.read_operation_id === "string"),
      "later rows are the compensation worker's own API reads after the abort");
    console.log(`# M1 ${connection} reservation evidence: ${JSON.stringify(evid.map((x) => [x.external_ref, x.status]))}`);
    assert.ok((await notifyOps(S.bk.id)).length >= 1, "an owner alert / guest notification is queued (and unsent)");
    noProtectedTraffic(S);
    assert.equal(S.app.sqlLog().filter((x) => x === SQL_CLAIM_HELD).length, 1, "ONE release-proof claim read");
    assert.equal((await r.finalize()).lockRelease, "unlocked");
  }
  assert.equal(await dz.snap(), dz.before, "decoys (same listing / foreign lease / other listing) untouched: every worker call was scoped to the ONE intent + listing");
});

test("M2 refusals BEFORE any DB / journal / transport / attest / timer work: unsupported phase plans, non-synthetic / real providers, intent mismatch, foreign identity", async () => {
  const w = world(); const bk = await authorizedBooking(w);
  const base = await manifestFor(bk);
  for (const [label, man, intentId, want] of [
    ["capture plan", { ...base, phases: { capture: true, recording: false, testAbortAfterReservation: false } }, bk.id, "PHASE_PLAN_UNSUPPORTED"],
    ["abort flag off", { ...base, phases: { capture: false, recording: false, testAbortAfterReservation: false } }, bk.id, "PHASE_PLAN_UNSUPPORTED"],
    ["intent mismatch", base, "00000000-0000-4000-8000-0000000000ee", "INTENT_MISMATCH"],
    ["v1 manifest", { ...base, version: "e7-run-manifest-v1" }, bk.id, null]
  ]) {
    const S = await scenario({ w, bk, manifest: man });
    S.opts.intentId = intentId;
    const reads0 = S.T.counts().reads;
    const r = await S.run();
    assert.equal(r.outcome, "REFUSED", label);
    if (want) assert.equal(r.stopCode, want, label); else assert.ok(typeof r.stopCode === "string", label);
    assert.deepEqual([S.app.connects, S.report.connects, S.t.h.length, S.t.s.length, S.attestCalls.length, S.T.counts().reads - reads0], [0, 0, 0, 0, 0, 0], label);
    if (S.jm.ok) assert.equal(S.jm.controls.readCalls(), 0, label);
  }
  // a foreign intent's identity under this manifest (expected-intent binding): refused at P0, before RUN_STARTED
  const other = await authorizedBooking(w);
  const S = await scenario({ w, bk, manifest: { ...base, expectedRef: other.ref } });
  const r = await S.run();
  assert.deepEqual([r.outcome, r.stopCode, (await S.records()).length, S.t.h.length], ["REFUSED", "INTENT_IDENTITY_MISMATCH", 0, 0]);
  assert.equal((await r.finalize()).lockRelease, "unlocked");
});

test("M3 reservation_failed (price change) → the accepted void-only route → ENDED_RELEASED; no blocked / reopened, bridge NEVER called; unknown create → reads / stop, never a second create, bridge never called", async () => {
  const S = await scenario({ afterBooking: (w) => { w.nightly += 25; } });
  const r = await S.run();
  console.log(`# M3a journal: ${JSON.stringify(await S.events())}`);
  assert.deepEqual([r.ok, r.outcome, r.ownerCleanupRequired, r.bridgeCalls, { ...r.writes }], [true, "ENDED_RELEASED", null, 0, { ...W0, void: 1 }], JSON.stringify(plainResult(r)));
  assert.deepEqual([S.t.count(/^POST \/v1\/reservations$/), ...providerSettle(S)], [0, 0, 1]);
  assert.deepEqual(S.attestCalls.map((a) => a.cp), [S.K[0]]);
  assert.ok(!(await S.events()).some((e) => e.startsWith("ABORT_")));
  assert.equal(validateJournalV2(await S.records(), S.manifest, { trustedHead: { ...r.trustedHead } }).ok, true);
  assert.equal((await r.finalize()).lockRelease, "unlocked");
  // ambiguous create (the mock APPLIED it, replied 503) → the worker's reads / case; the strict post-blocked gate stops BEFORE the bridge
  const U = await scenario({ connection: "airbnb", mode: { create: "appliedThen503" } });
  const ru = await U.run();
  console.log(`# M3b journal: ${JSON.stringify(await U.events())}`);
  assert.equal(ru.outcome, "STOPPED"); assert.ok(["OPEN_CASE", "UNKNOWN_WRITE"].includes(ru.stopCode), ru.stopCode);
  assert.deepEqual([U.w.writes.createReservation, ru.bridgeCalls, await appliedAborts(U.bk.id), ...providerSettle(U)], [1, 0, 0, 0, 0], "ONE create, no abort, no settlement");
  assert.equal(ru.ownerCleanupRequired, "reservedNotConfirmed");
  assert.equal((await U.events()).at(-1), "RUN_STOPPED");
  assert.equal((await ru.finalize()).lockRelease, "unlocked");
});

test("M4 bridge stops are honoured: refusal (labelled planted work lease) / abort applied OUTSIDE the run / injected clock fault before the operator — cleanup invocations 0, no resend, RUN_STOPPED only over a KNOWN tail", async () => {
  // (a) refusal: a foreign work lease planted (owner, labelled) during the blocked attestation → the accepted helper refuses
  {
    const S = await scenario({ attest: { CALENDAR_BLOCKED: async (S0) => {
      await db.owner.query("UPDATE booking.intent_work SET work_worker_id = 'planted-lease', work_lease_until = now() + interval '1 hour' WHERE intent_id = $1", [S0.bk.id]);
      return { ok: true, evidenceRef: "synthetic/calendar_blocked" }; } } });
    const r = await S.run();
    const ev = await S.events();
    console.log(`# M4a ${JSON.stringify([r.stopCode, r.bridge && r.bridge.outcome, r.bridge && r.bridge.operatorOutcome, r.bridge && r.bridge.code, ev.slice(-3)])}`);
    assert.deepEqual([r.outcome, r.bridgeCalls, r.journalTail, r.bridge.outcome, r.bridge.dbAbortApplied], ["STOPPED", 1, "KNOWN", "ABORT_REFUSED", false], JSON.stringify(plainResult(r)));
    assert.equal(r.stopCode, "ABORT_REFUSED");
    assert.deepEqual(ev.slice(-2), ["ABORT_REQUEST_STARTED", "RUN_STOPPED"], "RUN_STOPPED over the KNOWN start-ACK tail");
    assert.deepEqual([await cleanupSteps(S), ...providerSettle(S), await appliedAborts(S.bk.id), await state(S.bk.id)], [0, 0, 0, 0, "reservation_confirmed"]);
    assert.equal(r.ownerCleanupRequired, "reservedNotConfirmed");
    assert.equal(validateJournalV2(await S.records(), S.manifest, { trustedHead: { ...r.trustedHead } }).ok, true);
    assert.equal((await r.finalize()).lockRelease, "unlocked");
  }
  // (b) an abort applied OUTSIDE this run, just before the bridge's start record lands (labelled external actor: the accepted operator core)
  {
    const S = await scenario({ connection: "airbnb", hooks: { ABORT_REQUEST_STARTED: async (S0, rec) => {
      if (S0.outside) return; S0.outside = true;
      const e = buildAbortExpectation({ intentId: S0.bk.id, expectedVersion: rec.abort.expectedVersion, listingId: ABORT_LISTING, from: S0.bk.stay.from, to: S0.bk.stay.to,
        guests: S0.bk.stay.guests, currency: "USD", finalTotalMinor: S0.bk.total, authorizedMinor: S0.bk.total, paymentIntentId: rec.abort.paymentIntentId,
        sessionId: (await loadIntent(db.app, S0.bk.id)).checkout.sessionId, attemptId: S0.bk.paymentAttemptId,
        reservationId: rec.abort.reservationId, approvalRef: "outside-actor" });
      S0.outsideResult = await executeOperatorAbort(db.app, e, { now: Date.now(), env: { VERCEL_ENV: "development", MV_E7_TEST_ABORT: "enabled" } });
    } } });
    const r = await S.run();
    console.log(`# M4b ${JSON.stringify([r.stopCode, S.outsideResult && S.outsideResult.outcome, r.bridge && r.bridge.outcome, r.bridge && r.bridge.code])}`);
    assert.equal(S.outsideResult.outcome, "REQUESTED", "the outside actor applied the abort");
    assert.deepEqual([r.outcome, r.stopCode, r.bridge.outcome, r.bridge.code, r.bridge.requestHelperInvocations, r.bridge.dbAbortApplied, r.bridgeCalls],
      ["STOPPED", "ABORT_NOT_THIS_RUN", "ABORT_NOT_THIS_RUN", "ALREADY_REQUESTED_OUTSIDE_HANDSHAKE", 0, true, 1], JSON.stringify(plainResult(r)));
    assert.deepEqual([await cleanupSteps(S), ...providerSettle(S), await appliedAborts(S.bk.id), await state(S.bk.id)], [0, 0, 0, 1, "capture_failed"], "never adopted: no cleanup");
    assert.deepEqual((await S.events()).slice(-2), ["ABORT_REQUEST_STARTED", "RUN_STOPPED"]);
    assert.equal((await r.finalize()).lockRelease, "unlocked");
  }
  // (c) injected clock fault right after the start ACK (monotonic turns non-finite) → the bridge stops BEFORE the operator core; 0 core calls
  {
    let poisoned = false;
    const S = await scenario({ override: { ABORT_REQUEST_STARTED: async (S0, rec, real) => { const ack = await real(); poisoned = true; return ack; } } });
    const mono = S.opts.monotonic; S.opts.monotonic = () => (poisoned ? NaN : mono());
    const r = await S.run();
    console.log(`# M4c ${JSON.stringify([r.stopCode, r.bridge && r.bridge.outcome, r.bridge && r.bridge.code, r.journalTerminal, r.journalTail])}`);
    assert.deepEqual([r.outcome, r.stopCode, r.bridge.outcome, r.bridge.operatorCoreInvocations, r.bridge.requestHelperInvocations, r.bridgeCalls],
      ["STOPPED", "STOPPED_BEFORE_OPERATOR", "STOPPED_BEFORE_OPERATOR", 0, null, 1], JSON.stringify(plainResult(r)));
    assert.deepEqual([await cleanupSteps(S), ...providerSettle(S), await appliedAborts(S.bk.id), await state(S.bk.id)], [0, 0, 0, 0, "reservation_confirmed"]);
    assert.deepEqual(r.trustedHead, r.bridge.startAck, "the stopped result carries the last ACKed head (the start record)");
    assert.equal((await S.events()).at(-1), "ABORT_REQUEST_STARTED", "no terminal ACK can be formed without a clock: none is manufactured");
    await r.finalize().catch(() => {});
  }
});

test("M5 start-record and receipt ACK faults (reject / hang / late / landed_hang / malformed ACK / lost ACK): cleanup invocations 0, no resend, tail UNKNOWN → no RUN_STOPPED; the stopped result keeps the last ACKed head + the bridge's uncertainty", async () => {
  const modes = ["reject", "hang", "late", "landed_hang", "badack", "lostack"];
  const fault = (mode) => async (S0, rec, real) => {
    if (mode === "reject") throw new Error("synthetic journal fault");
    if (mode === "hang") { setTimeout(() => S0.T.advance(6_000), 50); return new Promise(() => {}); }
    if (mode === "late") { setTimeout(() => S0.T.advance(6_000), 50); await sleep(400); return real(); }    // lands AFTER the bridge's bound
    if (mode === "landed_hang") { await real(); setTimeout(() => S0.T.advance(6_000), 50); return new Promise(() => {}); }
    const ack = await real();
    return mode === "badack" ? { seq: ack.seq, hash: "0".repeat(64) } : undefined;
  };
  for (const [event, wantStop] of [["ABORT_REQUEST_STARTED", "ABORT_START_UNACKED"], ["ABORT_ACCEPTED", "ABORT_RECEIPT_UNACKED"]]) {
    for (const mode of modes) {
      const label = `${event}/${mode}`;
      const S = await scenario({ connection: mode.length % 2 ? "airbnb" : "disconnected", override: { [event]: fault(mode) } });
      const r = await S.run();
      if (mode === "late") await sleep(600);
      const recs = await S.records(); const ev = recs.map((x) => x.event);
      assert.deepEqual([r.outcome, r.stopCode, r.journalTail, r.bridgeCalls], ["STOPPED", wantStop, "UNKNOWN", 1], `${label}: ${JSON.stringify(plainResult(r))}`);
      assert.equal(ev.includes("RUN_STOPPED"), false, `${label}: no terminal over an unknown tail`);
      assert.equal(S.overrideCalls[event], 1, `${label}: never resent`);
      assert.deepEqual([await cleanupSteps(S), ...providerSettle(S)], [0, 0, 0], `${label}: cleanup invocations 0`);
      const landed = ev.at(-1) === event;
      assert.equal(landed, ["late", "landed_hang", "badack", "lostack"].includes(mode), `${label}: observed journal reality`);
      if (event === "ABORT_REQUEST_STARTED") {
        assert.deepEqual([r.bridge.outcome, r.bridge.operatorCoreInvocations, await appliedAborts(S.bk.id), await state(S.bk.id)], ["STOPPED_START_UNACKED", 0, 0, "reservation_confirmed"], label);
        assert.equal(r.trustedHead.seq, recs.findIndex((x) => x.event === "ATTESTED" && x.attestation.checkpoint === S.K[1]) + 1, `${label}: the last ACKed head = the blocked attestation`);
      } else {
        assert.deepEqual([r.bridge.outcome, r.bridge.receiptLanding, r.bridge.requestHelperInvocations, r.bridge.dbAbortApplied, await appliedAborts(S.bk.id), await state(S.bk.id)],
          ["STOPPED_RECEIPT_UNACKED", "UNACKED_MAY_HAVE_LANDED", 1, true, 1, "capture_failed"], label);
        assert.deepEqual(r.trustedHead, r.bridge.startAck, `${label}: the last ACKed head = the start record`);
        assert.equal(r.bridge.postcheck.intentState, "capture_failed", `${label}: observed DB facts carried`);
      }
      const anchoredV = validateJournalV2(recs, S.manifest, { trustedHead: { ...r.trustedHead } });
      assert.equal(anchoredV.ok, !landed, `${label}: a landed unACKed record is an extra tail the trusted head refuses`);
      if (landed) assert.equal(anchoredV.code, "TRUSTED_HEAD_MISMATCH", label);
      await assertNotifyUnsent(S.bk.id, label);
      await r.finalize().catch(() => {});
    }
  }
});

test("M6 mode ordering + lock loss: blocked declined → no bridge; lock lost during the blocked attestation → no bridge; lock lost right after the ACKed receipt → no cleanup, RUN_STOPPED (exclusion lost) over the KNOWN receipt head", async () => {
  {
    const S = await scenario({ connection: "airbnb", attest: { AIRBNB_BLOCKED: async () => ({ ok: false }) } });
    const r = await S.run();
    assert.deepEqual([r.outcome, r.stopCode, r.bridgeCalls, r.ownerCleanupRequired, await state(S.bk.id)], ["STOPPED", "OWNER_DECLINED", 0, "reservedNotConfirmed", "reservation_confirmed"]);
    assert.equal((await r.finalize()).lockRelease, "unlocked");
  }
  {
    const S = await scenario({ attest: { CALENDAR_BLOCKED: async (S0) => { await terminate(S0.report.clients[0]); return { ok: true, evidenceRef: "synthetic/calendar_blocked" }; } } });
    const r = await S.run();
    assert.deepEqual([r.outcome, r.stopCode, r.exclusion, r.bridgeCalls, await appliedAborts(S.bk.id)], ["STOPPED", "LOCK_LOST", "lost", 0, 0], JSON.stringify(plainResult(r)));
    assert.equal((await r.finalize()).lockRelease, "lost");
  }
  {
    const S = await scenario({ override: { ABORT_ACCEPTED: async (S0, rec, real) => { const ack = await real(); await terminate(S0.report.clients[0]); return ack; } } });
    const r = await S.run();
    const ev = await S.events();
    assert.deepEqual([r.outcome, r.stopCode, r.exclusion, r.journalTail, r.bridge.outcome], ["STOPPED", "LOCK_LOST", "lost", "KNOWN", "ABORT_ACCEPTED_JOURNALED"], JSON.stringify(plainResult(r)));
    assert.deepEqual(ev.slice(-3), ["ABORT_REQUEST_STARTED", "ABORT_ACCEPTED", "RUN_STOPPED"]);
    const last = (await S.records()).at(-1);
    assert.deepEqual([last.exclusion, last.ownerCleanupRequired, last.effectsKnown], ["lost", "reservedNotConfirmed", false]);
    assert.deepEqual([await cleanupSteps(S), ...providerSettle(S), await state(S.bk.id)], [0, 0, 0, "capture_failed"], "no cleanup after the loss");
    assert.equal(validateJournalV2(await S.records(), S.manifest, { trustedHead: { ...r.trustedHead } }).ok, true);
    assert.equal((await r.finalize()).lockRelease, "lost");
  }
});

test("M7 source pins: exact imports; no timers / env / fs / fetch / Date of its own; SQL limited to the imported v1 statements + ONE claim read; v1 / bridge / workers / migrations bytes unchanged", () => {
  const src = readFileSync(join(ROOT, "scripts/e7-connected/run-core-abort-v2.mjs"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  assert.deepEqual([...code.matchAll(/^import\s[\s\S]*?from\s+"([^"]+)";/gm)].map((x) => x[1]), ["node:util", "./run-journal-memory-v2.mjs", "./run-journal-memory.mjs", "./run-guard.mjs",
    "./run-facts.mjs", "./executor-adapters.mjs", "./run-core.mjs", "./run-test-abort.mjs", "../e7-operator/test-abort.mjs", "../../lib/booking-db/repo.js",
    "../../lib/booking-db/reservation-worker.js", "../../lib/booking-db/compensation-worker.js"]);
  const stripped = code.replace(/"[^"]*"|`[^`]*`/g, "");
  for (const bad of ["process.", "fetch(", "setTimeout", "setInterval", "Date.", "new Date", "import(", "require(", "applyEvent", "runCaptureStep", "runRecordingStep", "operatorDeps"]) {
    assert.equal(stripped.includes(bad), false, bad);
  }
  assert.deepEqual([...src.matchAll(/\b(SELECT|UPDATE|INSERT|DELETE)\b/g)].map((x) => x[1]), ["SELECT"], "the ONE claim read is the only SQL text");
  const sha = (p) => createHashHex(readFileSync(join(ROOT, p)));
  assert.deepEqual(Object.fromEntries(Object.keys(PINS).map((p) => [p, sha(p)])), PINS);
});
const createHashHex = (b) => createHash("sha256").update(b).digest("hex");
// lib/booking-db/test-abort.js pin: a00952ca... -> 91724d9d... (root ruling b43935f0: the scoped hostaway_reservation evidence classification).
const PINS = {"scripts/e7-connected/run-core.mjs":"ad1dcbb29e7cb1ce0aac71ac178d903076d4e5cc293dd17f972c04b4beaa5afe","scripts/e7-connected/run-test-abort.mjs":"d0b8465b992367999f261968f986f456d25ad6a5845b07028ad95c2cc22143a3","scripts/e7-connected/run-journal-memory-v2.mjs":"0a9ad263ac6a4f505d62e21634b0161134f5263dc4caa8dcf3d2834308df4c7a","scripts/e7-connected/run-journal-memory.mjs":"2712f01b0509d343d162b5fe7055878ade40f69d668915671441b81cbf87c700","scripts/e7-connected/run-journal-file.mjs":"265af8195dccbaae34817a9a16e2f09f4498b85638fae4abb779d5b0bd9cc4b1","scripts/e7-connected/run-manifest.mjs":"c47f72eb2b9e898bdaca2ca20ffe7cea0befab006079953133810ce5651f6a56","scripts/e7-connected/run-manifest-v2.mjs":"c19ab009b00b8c3877da53f20e436c1c6d4ac29d051ab1f21705d38fcf3cc7fd","scripts/e7-connected/run-guard.mjs":"5d92cbf8a3dfb345ac876e1140ee6a2d6a27885f8bf6dcb506a5f346024e16a9","scripts/e7-connected/run-facts.mjs":"1be04496eb6617f41f8738617682eb282f2f987cb4d3fe65039892b9eddd6887","scripts/e7-connected/executor-adapters.mjs":"2ac9460fee917305c9e8b81115f1f2f006bd434e3ab8b39835bff9ffa245608e","scripts/e7-operator/test-abort.mjs":"8abcb82ba49ed4b239d2c7a0f5251bb07d24fd95fece1c6580a4cad14532bff3","lib/booking-db/test-abort.js":"91724d9dcd6c3c514eef70b5d3f4a4458b7298106b0286a797506bd99b48f852","lib/booking-db/reservation-worker.js":"601f48f67052f5dac40b83354b9cf10d5f81950ff9fe9cbd587288d19ed05e88","lib/booking-db/compensation-worker.js":"200f954a275411f96ad98b9ee577c8a7572ff073e1ce2fd74be7a2db1c242fb5","lib/booking-db/capture-worker.js":"d94d973985ca22eed0bfc54975f1c20159c9452dd3d841f2c7114736b4f37bc2","lib/booking-db/recording-worker.js":"c924e0bd96390c8df8d7b59ac656c1bc3d62d99e84e6657f69936de50d33c5bb","lib/booking-db/notification-worker.js":"e9fe70d0e79754b2dad2ce91e3b58dc41a3c9e9751e60aa1f3d6e1b3f49dfb8e","lib/checkout/intent-state.js":"16d1af5a7ea408b1a2e62f857a0027e71d8a1aa7b69c6d4f4bf7290823115615","db/migrations/0017_cancelled_pristine_capture_release.up.sql":"880f203b11cb4d2a9fe2317d6cb9fc8e00853b8c8ba41f44026d07aae9fd510e"};
