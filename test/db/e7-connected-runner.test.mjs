// E7 connected-test runner SLICE E — run-core (runConnectedTest) on a DISPOSABLE local PG (no network, no provider, no credentials).
//
// LABELS
//   * PG ENFORCEMENT: pools.report is a real mv_booking_report login (test_report), pools.app the harness's real mv_booking_app login
//     (test_app). The runner, C, and the four REAL imported accepted workers run unchanged against them. No trigger disabling, no raw
//     lifecycle writes, no worker injection (no hooks / timeouts / monotonic passed to workers), no copied implementation.
//   * SYNTHETIC: the provider world, transports and payment_authorized booking setup below are COPIED VERBATIM from the accepted adapter
//     rehearsal (test/db/e7-connected-adapter-rehearsal.test.mjs:41–226; same labels: SYNTHETIC / DOC-DERIVED / LIVE-UNVERIFIED). The
//     authorization is labelled mocked fixture setup. Fakes prove mapping / integration only, never provider support.
//   * TEST-ONLY FAULTS: FaultPool / FaultClient are test-local wrappers (prototype connect / query / release / on / removeListener) that
//     forward to real pg clients and reject / hang / delay a statement selected by EXACT SQL text (run-core SQL.*, C SQL.*, or the worker's
//     own releaseWork text), or the next operation after a labelled point. Provider hangs are test-controlled gates in the fake world.
//   * EXTERNAL ACTOR (labelled): CAPTURE_FAILED is applied through the accepted applyEvent (as e74a-compensation-worker.test.mjs:157)
//     inside the AIRBNB_BLOCKED attestation — the accepted capture worker never emits it (capture-worker.js:10).
//   * TIME: scaled real timers (monotonic = real elapsed × K; arm(ms) → setTimeout(ms / K)) plus a test-only advance(); the business clock
//     is either the real clock (recording scenarios) or a clock that starts 20 min behind real time, follows virtual time and is capped
//     5 s behind real time (recovery / cleanup scenarios) — the accepted rehearsal's "never past real time" rule.
//   * Guest values and provider bodies are compared, never printed. Protected ids appear only as negative checks.
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { readFileSync } from "node:fs";
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
import { validateRunManifest, CHECKPOINTS } from "../../scripts/e7-connected/run-manifest.mjs";
import { createMemoryJournal, validateJournal, validateRecord, recordHash, GENESIS_HASH } from "../../scripts/e7-connected/run-journal-memory.mjs";
import { SQL as FACTS_SQL } from "../../scripts/e7-connected/run-facts.mjs";
import { runConnectedTest, checkSameDatabase, SQL, LOCK_KEY, PHASE_LIMITS } from "../../scripts/e7-connected/run-core.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
let netAttempts = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { netAttempts += 1; throw new Error("network refused in the offline runner suite"); };

let db; let reportPool;
before(async () => { db = await startMigratedDatabase(); reportPool = new pg.Pool({ connectionString: db.reportUrl(), max: 8 }); });
after(async () => { globalThis.fetch = realFetch; await reportPool.end().catch(() => {}); await db.close(); assert.equal(netAttempts, 0); });

// ===== SYNTHETIC world + booking setup + fake transports: COPIED VERBATIM from the accepted adapter rehearsal (lines 41–226) =====
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

// ---------------------------------------------------------------------------------------------------------------------------------
// runner-suite harness (TEST-ONLY)
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
  on(e, h) { this.events.push(`on:${e}`); this.c.on(e, h); return this; }
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

let runN = 0;
/** TEST-SETUP SAFETY (not a runner behaviour): after every test, any client a scenario still holds (e.g. after a failed assertion) is
 *  destroyed locally so that a leaked lock session can never cascade into later tests as RUN_LOCK_HELD. */
const LIVE = [];
afterEach(async () => { for (const S of LIVE.splice(0)) await S.cleanup(); });
async function manifestFor(bk, { phases = { capture: true, recording: true }, over = {} } = {}) {
  const i = await one("SELECT rate_bps FROM booking.intents WHERE id = $1", [bk.id]);
  runN += 1;
  return { version: "e7-run-manifest-v1", runId: `synthetic-run-${String(runN).padStart(4, "0")}`, intentId: bk.id, baselineCommit: BASE_COMMIT, synthetic: true,
    providerMode: { hostaway: "fake", stripe: "mock" }, listing: { id: bk.listingId, currency: "USD", refFieldId: REF_FIELD, timeZone: TZ }, expectedRef: bk.ref,
    stay: { arrival: bk.stay.from, departure: bk.stay.to, guests: bk.stay.guests }, amountMinor: bk.total, pricing: { rateBps: Number(i.rate_bps) },
    stripeAccountId: ACCT, hostawayAccountLabel: { ...LABEL }, phases, paymentMethod: phases.recording ? "credit_card" : null,
    cleanup: { reservedNotConfirmed: "synthetic/cleanup-reserved", captured: "synthetic/cleanup-captured", confirmed: "synthetic/cleanup-confirmed" },
    automationsReviewed: "synthetic/automations", checkpoints: [...CHECKPOINTS], ...over };
}

/** one runner scenario: fresh world / booking / journal / wrappers / time; nothing shared but the disposable DB */
async function scenario(o = {}) {
  const w = o.w ?? world(o.world);
  if (o.mode) Object.assign(w.mode, o.mode);
  const bk = o.bk ?? await authorizedBooking(w);
  if (o.afterBooking) o.afterBooking(w, bk);
  const T = timeDriver(o.K ?? 10);
  const manifest = o.manifest ?? await manifestFor(bk, o);
  const mv = validateRunManifest(manifest);
  const identity = mv.ok ? { runId: manifest.runId, intentId: manifest.intentId, manifestHash: mv.hash, baselineCommit: manifest.baselineCommit } : null;
  const jm = o.jm ?? (identity ? createMemoryJournal({ identity, ...(o.preload ? { preload: o.preload } : {}), ...(o.journalFaults ? { faults: o.journalFaults } : {}) }) : null);
  const tl = [];
  const S = { w, bk, T, manifest, identity, jm, tl, attestCalls: [], hooks: o.hooks ?? {} };
  S.app = new FaultPool(o.appPool ?? db.app, "app", tl);
  S.report = new FaultPool(o.reportPool ?? reportPool, "report", tl);
  S.t = transports(w);
  S.ac = new AbortController();
  S.clock = o.clock === "real" ? () => Date.now() : () => Math.floor(Math.min(bk.base + 10 * SEC + T.now(), Date.now() - 5 * SEC));
  const attest = (cp, request, x) => {
    S.attestCalls.push({ cp, request: { ...request }, signalIsRun: x.signal === S.ac.signal }); tl.push(`A:${cp}`);
    const f = o.attest && o.attest[cp];
    return f ? f(S, request) : Promise.resolve({ ok: true, evidenceRef: `synthetic/${cp.toLowerCase()}` });
  };
  const j = jm ? jm.journal : null;
  S.journal = j && {
    append: (rec) => {
      tl.push(`J:${rec.event}${rec.phase ? `:${rec.phase}` : ""}${rec.attestation ? `:${rec.attestation.checkpoint}` : ""}`);
      const h = S.hooks[rec.event];
      return h ? (async () => { await h(S, rec); return j.append(rec); })() : j.append(rec);
    },
    read: () => (S.hooks.read ? (async () => { await S.hooks.read(S); return j.read(); })() : j.read())
  };
  S.opts = { manifest, intentId: bk.id, pools: { app: S.app, report: S.report }, transports: { hostaway: S.t.hostaway, stripe: S.t.stripe }, journal: S.journal,
    trustedHead: null, attest, clock: S.clock, monotonic: T.deps.monotonic, timers: T.deps.timers, signal: S.ac.signal };
  if (o.optsOver) Object.assign(S.opts, o.optsOver);
  S.run = async () => { S.result = await runConnectedTest(S.opts); return S.result; };
  S.records = async () => (await jm.journal.read()).records;
  S.events = async () => (await S.records()).map((r) => `${r.event}${r.phase ? `:${r.phase}` : ""}${r.attestation ? `:${r.attestation.checkpoint}` : ""}${r.state ? `:${r.state}` : ""}`);
  S.cleanup = async () => { await S.app.cleanup(); await S.report.cleanup(); };
  LIVE.push(S);
  return S;
}
const settledWithin = (p, ms) => Promise.race([p.then((v) => ({ settled: true, v })), sleep(ms).then(() => ({ settled: false }))]);
const runnerSql = (S) => S.report.sqlLog();
const journalValid = async (S) => { const v = validateJournal(await S.records(), S.identity); assert.equal(v.ok, true, `journal valid under D: ${v.code}`); return v; };
const noGuestInJournal = async (S) => {
  const g = await one("SELECT first_name, last_name, email FROM booking.intent_guests WHERE intent_id = $1", [S.bk.id]);
  const txt = JSON.stringify(await S.records());
  assert.ok(![g.first_name, g.last_name, g.email].some((v) => v && txt.includes(v)), "no guest value in any journal record");
};
const noProtectedTraffic = (S) => assert.ok(S.t.h.every((p) => !PROTECTED.some((id) => p.includes(id))) && S.w.paths.every((p) => !PROTECTED.some((id) => p.includes(id))));
const RESULT_KEYS = ["anchored", "countsAsOf", "effectsKnown", "exclusion", "finalize", "journalSeq", "journalTerminal", "manifestHash", "ok", "outcome", "outstanding",
  "outstandingPhase", "ownerCleanupRequired", "phase", "stopCode", "tailObservable", "writes"];
const assertResultShape = (r) => { assert.ok(Object.isFrozen(r)); assert.deepEqual(Object.keys(r).sort(), RESULT_KEYS); assert.equal(r.finalize(), r.finalize(), "finalize = B's SAME memoized promise"); };
const plainResult = (r) => JSON.parse(JSON.stringify({ ...r, finalize: undefined }));

// =================================================================================================================================
test("E1. invalid options / manifest / intentId mismatch → refusal with ZERO DB / transport / journal / attest / timer calls", async () => {
  const S = await scenario();
  const cases = [
    ["missing key", (() => { const x = { ...S.opts }; delete x.signal; return x; })(), "OPTIONS_INVALID"],
    ["extra key", { ...S.opts, extra: 1 }, "OPTIONS_INVALID"],
    ["accessor option (never run)", Object.defineProperty({ ...S.opts }, "clock", { enumerable: true, get() { throw new Error("getter ran"); } }), "OPTIONS_INVALID"],
    ["proxy options", new Proxy({ ...S.opts }, {}), "OPTIONS_INVALID"],
    ["not an AbortSignal", { ...S.opts, signal: { aborted: false } }, "OPTIONS_INVALID"],
    ["pool without connect", { ...S.opts, pools: { app: {}, report: S.report } }, "OPTIONS_INVALID"],
    ["transport without send", { ...S.opts, transports: { hostaway: {}, stripe: S.t.stripe } }, "OPTIONS_INVALID"],
    ["guard deps invalid", { ...S.opts, timers: { arm: S.T.deps.timers.arm, x: 1 } }, "OPTIONS_INVALID"],
    ["manifest invalid", { ...S.opts, manifest: { ...S.manifest, synthetic: false } }, "REAL_RUN_NOT_IN_THIS_SLICE"],
    ["intentId mismatch", { ...S.opts, intentId: "00000000-0000-4000-8000-0000000000e1" }, "INTENT_MISMATCH"]
  ];
  for (const [label, opts, code] of cases) {
    const r = await runConnectedTest(opts);
    assert.deepEqual([r.ok, r.outcome, r.stopCode], [false, "REFUSED", code], label);
  }
  assert.deepEqual([S.app.connects, S.report.connects, S.app.log.length, S.report.log.length], [0, 0, 0, 0], "zero DB");
  assert.deepEqual([S.t.h.length, S.t.s.length, S.jm.controls.appendCalls(), S.jm.controls.readCalls(), S.attestCalls.length, S.T.counts().arms], [0, 0, 0, 0, 0, 0]);
});

test("E2. checkSameDatabase: a second cluster behind pools.app / wrong role on either pool → REFUSED, zero workers, lock unlocked (not DB family)", async () => {
  const db2 = await startMigratedDatabase();
  try {
    const S = await scenario({ appPool: db2.app });
    const r = await S.run();
    assert.deepEqual([r.ok, r.outcome, r.stopCode, r.journalSeq], [false, "REFUSED", "POOLS_MISMATCH", 0]);
    assertResultShape(r);
    assert.deepEqual(runnerSql(S), [SQL.LOCK, SQL.SAME_DB, SQL.UNLOCK].slice(0, 2), "S1 on the lock client; S2 on the app client; nothing else before finalize");
    assert.deepEqual(S.app.sqlLog(), [SQL.SAME_DB]);
    const d = await r.finalize();
    assert.equal(d.lockRelease, "unlocked");
    assert.equal(S.report.sqlLog().at(-1), SQL.UNLOCK);
    assert.deepEqual([S.t.h.length, S.t.s.length, S.jm.controls.readCalls(), S.attestCalls.length], [0, 0, 0, 0], "zero workers / journal / attest");
    const appCli = S.app.clients[0];
    assert.deepEqual(appCli.events.slice(-3), ["off:error", "off:end", "release()"], "healthy app client: tracker.dispose then release()");
    await S.cleanup();
  } finally { await db2.close(); }
  const S2 = await scenario({ reportPool: db.app });
  const r2 = await S2.run();
  assert.deepEqual([r2.outcome, r2.stopCode, S2.app.connects], ["REFUSED", "ROLE_NOT_REPORT", 0], "an app login behind pools.report: refused at S1, no app client");
  assert.equal((await r2.finalize()).lockRelease, "unlocked");
  const S3 = await scenario({ appPool: reportPool });
  const r3 = await S3.run();
  assert.deepEqual([r3.outcome, r3.stopCode], ["REFUSED", "ROLE_NOT_APP"]);
  assert.equal((await r3.finalize()).lockRelease, "unlocked");
  // pure comparison (synthetic rows)
  const row = { environment: "test", created_at: "2026-11-04 00:00:00.123456+00", db: "postgres", started: "x", port: 5432, is_report: true, is_app: false, privileged: false };
  const app = { ...row, is_report: false, is_app: true };
  assert.equal(checkSameDatabase([row], [app]).ok, true);
  assert.equal(checkSameDatabase([row], [{ ...app, created_at: "2026-11-04 00:00:00.123457+00" }]).code, "POOLS_MISMATCH", "microseconds kept");
  assert.equal(checkSameDatabase([row], [{ ...app, port: 5433 }]).code, "POOLS_MISMATCH");
  assert.equal(checkSameDatabase([{ ...row, port: null }], [{ ...app, port: null }]).ok, true, "socket connection: null port on both");
  assert.equal(checkSameDatabase([{ ...row, environment: "production" }], [app]).code, "DATABASE_NOT_TEST");
  assert.equal(checkSameDatabase([{ ...row, privileged: true }], [app]).code, "ROLE_NOT_REPORT");
  assert.equal(checkSameDatabase([row, row], [app]).code, "MARKER_INVALID");
});

/** a synthetic valid journal history for E3 (D's own record validation + hash) */
function history(identity, events) {
  let prev = GENESIS_HASH; const out = [];
  events.forEach((body, i) => {
    const v = validateRecord({ v: 1, seq: i + 1, prevHash: prev, ...identity, at: 1, ...body });
    assert.equal(v.ok, true, v.code);
    out.push(v.record); prev = recordHash(v.record);
  });
  return out;
}
test("E3. journal not empty (RUN_STARTED only / terminal / foreign / torn) → no resume; zero workers", async () => {
  const w = world(); const bk = await authorizedBooking(w);
  const manifest = await manifestFor(bk);
  const mv = validateRunManifest(manifest);
  const id = { runId: manifest.runId, intentId: bk.id, manifestHash: mv.hash, baselineCommit: BASE_COMMIT };
  const stopped = { event: "RUN_STOPPED", code: "OWNER_DECLINED", outstanding: "NONE", effectsKnown: true, exclusion: "held", ownerCleanupRequired: null, writes: { ...W0 } };
  const foreign = { ...id, manifestHash: "f".repeat(64) };
  for (const [label, preload, faults, code] of [
    ["RUN_STARTED only", history(id, [{ event: "RUN_STARTED" }]), undefined, "RESTART_AMBIGUOUS"],
    ["terminal", history(id, [{ event: "RUN_STARTED" }, stopped]), undefined, "RUN_ENDED"],
    ["foreign manifest", history(foreign, [{ event: "RUN_STARTED" }]), undefined, "MANIFEST_MISMATCH"],
    ["torn read", undefined, { read: { 1: "torn" } }, "JOURNAL_PARTIAL"]
  ]) {
    const S = await scenario({ w, bk, manifest, preload, journalFaults: faults });
    const r = await S.run();
    assert.deepEqual([r.ok, r.outcome, r.stopCode, r.journalSeq], [false, "REFUSED", code, 0], label);
    assert.deepEqual([S.t.h.length, S.t.s.length, S.jm.controls.appendCalls(), S.attestCalls.length], [0, 0, 0, 0], `${label}: zero workers / appends / attest`);
    assert.ok(!S.report.sqlLog().includes(FACTS_SQL.BEGIN), `${label}: refused before any eligibility snapshot`);
    assert.equal((await r.finalize()).lockRelease, "unlocked");
    await S.cleanup();
  }
});

test("E4. eligibility mismatch (ref / stay / amount / rateBps) or a pre-existing write op / open case → P0 refusal before RUN_STARTED", async () => {
  const w = world(); const bk = await authorizedBooking(w);
  const base = await manifestFor(bk);
  for (const [label, over, code] of [
    ["ref", { expectedRef: "MV-ZZZZZZ" }, "INTENT_IDENTITY_MISMATCH"],
    ["stay guests", { stay: { ...base.stay, guests: base.stay.guests + 1 } }, "INTENT_IDENTITY_MISMATCH"],
    ["stay dates", { stay: { ...base.stay, departure: addDays(base.stay.departure, 1) } }, "INTENT_IDENTITY_MISMATCH"],
    ["amount", { amountMinor: base.amountMinor + 1 }, "INTENT_IDENTITY_MISMATCH"],
    ["rateBps", { pricing: { rateBps: base.pricing.rateBps === 0 ? 100 : 0 } }, "INTENT_IDENTITY_MISMATCH"],
    ["unknown intent", { intentId: "00000000-0000-4000-8000-0000000000e4" }, "INTENT_NOT_FOUND"]
  ]) {
    const manifest = { ...base, ...over };
    const S = await scenario({ w, bk, manifest, optsOver: { intentId: manifest.intentId } });
    const r = await S.run();
    assert.deepEqual([r.outcome, r.stopCode, S.jm.controls.appendCalls(), S.t.h.length + S.t.s.length], ["REFUSED", code, 0, 0], label);
    assert.equal((await r.finalize()).lockRelease, "unlocked");
    await S.cleanup();
  }
  // a booking whose ambiguous create left a write op + an open case (produced by a real run below in E8) is never eligible
  E4_LATER.push(async (bk8, w8) => {
    const S = await scenario({ w: w8, bk: bk8 });
    const r = await S.run();
    const d = await r.finalize();
    assert.deepEqual([r.outcome, r.stopCode, S.jm.controls.appendCalls(), S.t.h.length + S.t.s.length], ["REFUSED", "INTENT_NOT_ELIGIBLE", 0, 0]);
    assert.equal(d.lockRelease, "unlocked");
  });
});
const E4_LATER = [];

test("E5. happy path, real-time clock → ENDED_CONFIRMED, key confirmed; one write per type; exact D records; finalize → unlocked", async () => {
  const S = await scenario({ clock: "real" });
  const r = await S.run();
  assert.deepEqual([r.ok, r.outcome, r.stopCode, r.ownerCleanupRequired, r.effectsKnown, r.outstanding, r.exclusion, r.journalTerminal, r.anchored],
    [true, "ENDED_CONFIRMED", null, "confirmed", true, "NONE", "held", "acknowledged", false], JSON.stringify(plainResult(r)));
  assertResultShape(r);
  assert.deepEqual({ ...r.writes }, { ...W0, create: 1, capture: 1, record: 1 });
  assert.deepEqual([S.t.count(/^POST \/v1\/reservations$/), S.t.count(/^paymentIntents\.capture$/), S.t.count(/^POST \/v1\/guestPayments\/charges\/\d+$/),
    S.t.count(/^paymentIntents\.cancel$/), S.t.count(/^PUT /)], [1, 1, 1, 0, 0], "transport-level writes");
  const ev = await S.events();
  console.log(`# E5 journal: ${JSON.stringify(ev)}`);
  assert.equal(ev[0], "RUN_STARTED"); assert.equal(ev[1], "ATTESTED:CALENDAR_BASELINE");
  const iBlocked = ev.indexOf("ATTESTED:AIRBNB_BLOCKED");
  assert.ok(ev.indexOf("PHASE_ENDED:reservation:reservation_confirmed") === iBlocked - 1);
  assert.ok(ev.includes("PHASE_ENDED:capture:payment_captured") && ev.includes("PHASE_ENDED:recording:confirmed"));
  assert.equal(ev.at(-1), "RUN_ENDED");
  const recs = await S.records();
  const v = await journalValid(S);
  assert.equal(v.status, "ENDED");
  assert.equal(r.journalSeq, recs.length);
  const steps = recs.filter((x) => x.event === "STEP_STARTED");
  assert.deepEqual(steps.map((x) => x.factory.phase), steps.map((x) => x.phase), "one fresh factory per step; no recovery binding on the happy path");
  const ended = recs.at(-1);
  assert.deepEqual([ended.outcome, ended.ownerCleanupRequired, ended.effectsKnown, ended.outstanding, ended.exclusion, { ...ended.writes }],
    ["ENDED_CONFIRMED", "confirmed", true, "NONE", "held", { ...W0, create: 1, capture: 1, record: 1 }]);
  await noGuestInJournal(S);
  assert.deepEqual(S.attestCalls.map((a) => a.cp), ["CALENDAR_BASELINE", "AIRBNB_BLOCKED"]);
  assert.ok(S.attestCalls.every((a) => a.signalIsRun && Object.keys(a.request).sort().join() === "checkpoint,intentId,manifestHash,runId"), "attest request: no guest / provider data");
  // a fresh C snapshot after every attestation and before the next step (clarification 2)
  const after = S.tl.slice(S.tl.indexOf("J:ATTESTED:AIRBNB_BLOCKED"));
  assert.ok(after.indexOf("report:BEGIN") > 0 && after.indexOf("report:BEGIN") < after.indexOf("J:STEP_STARTED:capture"), "fresh snapshot after AIRBNB_BLOCKED, before capture");
  const before = plainResult(r);
  const d = await r.finalize();
  assert.deepEqual([d.quiescence, d.lockRelease, d.exclusionLost], ["observed", "unlocked", false]);
  assert.deepEqual(plainResult(r), before, "finalize never mutates the returned result");
  assert.equal(S.report.sqlLog().filter((s) => s === SQL.UNLOCK).length, 1);
  for (const c of S.report.clients.slice(1)) assert.deepEqual(c.events.slice(-3), ["off:error", "off:end", "release()"], "every snapshot client: dispose then release()");
  noProtectedTraffic(S);
  console.log(`# E5 transport: ${JSON.stringify([...S.t.h, ...S.t.s])}`);
});

test("E6. capture:false → ENDED_RESERVED_NOT_CAPTURED (AIRBNB_BLOCKED attested, zero capture calls); recording:false → ENDED_CAPTURED_NOT_RECORDED", async () => {
  const A = await scenario({ clock: "real", phases: { capture: false, recording: false } });
  const ra = await A.run();
  assert.deepEqual([ra.ok, ra.outcome, ra.ownerCleanupRequired, { ...ra.writes }], [true, "ENDED_RESERVED_NOT_CAPTURED", "reservedNotConfirmed", { ...W0, create: 1 }]);
  assert.deepEqual([A.t.count(/^paymentIntents\.capture$/), A.attestCalls.map((a) => a.cp).join()], [0, "CALENDAR_BASELINE,AIRBNB_BLOCKED"]);
  assert.equal((await A.events()).at(-2), "ATTESTED:AIRBNB_BLOCKED");
  await journalValid(A);
  assert.equal((await ra.finalize()).lockRelease, "unlocked");
  const B = await scenario({ clock: "real", phases: { capture: true, recording: false } });
  const rb = await B.run();
  assert.deepEqual([rb.ok, rb.outcome, rb.ownerCleanupRequired, { ...rb.writes }], [true, "ENDED_CAPTURED_NOT_RECORDED", "captured", { ...W0, create: 1, capture: 1 }]);
  assert.equal(B.t.count(/^POST \/v1\/guestPayments\/charges\/\d+$/), 0);
  await journalValid(B);
  assert.equal((await rb.finalize()).lockRelease, "unlocked");
});

test("E7. no-echo create, same-run recovery (behind clock, capture:false) → reservation-recovery factory bound to C's candidate; ONE create; ends reserved", async () => {
  const S = await scenario({ mode: { create: "noEcho" }, phases: { capture: false, recording: false } });
  const r = await S.run();
  const recs = await S.records();
  console.log(`# E7 journal: ${JSON.stringify(await S.events())}`);
  console.log(`# E7 factories: ${JSON.stringify(recs.filter((x) => x.event === "STEP_STARTED").map((x) => x.factory))}`);
  assert.deepEqual([r.ok, r.outcome, r.ownerCleanupRequired], [true, "ENDED_RESERVED_NOT_CAPTURED", "reservedNotConfirmed"], JSON.stringify(plainResult(r)));
  const rid = String([...S.w.res.keys()][0]);
  const fac = recs.filter((x) => x.event === "STEP_STARTED").map((x) => x.factory);
  assert.ok(fac.some((f) => f.phase === "reservation-recovery" && f.reservationId === rid), "a recovery factory bound to the candidate");
  assert.ok(fac.every((f) => f.phase === "reservation" ? f.reservationId === null : f.reservationId === rid), "no other id ever bound");
  assert.deepEqual([S.w.writes.createReservation, S.t.count(/^POST \/v1\/reservations$/)], [1, 1], "no second create");
  await journalValid(S);
  assert.equal((await r.finalize()).lockRelease, "unlocked");
});

test("E8. ambiguous create (appliedThen503) → STOPPED OPEN_CASE after AIRBNB_BLOCKED, before ANY capture call; key reservedNotConfirmed", async () => {
  const S = await scenario({ mode: { create: "appliedThen503" } });
  const r = await S.run();
  console.log(`# E8 journal: ${JSON.stringify(await S.events())}`);
  assert.deepEqual([r.ok, r.outcome, r.stopCode, r.ownerCleanupRequired], [false, "STOPPED", "OPEN_CASE", "reservedNotConfirmed"], JSON.stringify(plainResult(r)));
  assert.deepEqual([S.t.count(/^paymentIntents\./), S.t.count(/^accounts\./)], [0, 0], "zero capture-phase transport calls");
  assert.deepEqual((await openCases(S.bk.id)).map((c) => c.kind), ["HOSTAWAY_CREATE_OUTCOME_UNKNOWN"]);
  const ev = await S.events();
  assert.ok(!ev.some((e) => e.startsWith("STEP_STARTED:capture")), "no capture step started");
  assert.equal(ev.at(-1), "RUN_STOPPED");
  const last = (await S.records()).at(-1);
  assert.deepEqual([last.code, last.ownerCleanupRequired, last.outstanding], ["OPEN_CASE", "reservedNotConfirmed", "NONE"]);
  await journalValid(S);
  assert.equal(S.w.writes.createReservation, 1);
  assert.equal((await r.finalize()).lockRelease, "unlocked");
  for (const f of E4_LATER) await f(S.bk, S.w);                      // E4 (pre-existing write op + open case) on this booking
});

test("E9. reservation_failed (price change) → void only → ENDED_RELEASED key null; no AIRBNB_REOPENED; zero Hostaway cancel / create", async () => {
  const S = await scenario({ afterBooking: (w) => { w.nightly += 25; } });
  const r = await S.run();
  console.log(`# E9 journal: ${JSON.stringify(await S.events())}`);
  assert.deepEqual([r.ok, r.outcome, r.ownerCleanupRequired, { ...r.writes }], [true, "ENDED_RELEASED", null, { ...W0, void: 1 }], JSON.stringify(plainResult(r)));
  assert.deepEqual([S.t.count(/^paymentIntents\.cancel$/), S.t.count(/^PUT /), S.t.count(/^POST \/v1\/reservations$/)], [1, 0, 0]);
  assert.deepEqual(S.attestCalls.map((a) => a.cp), ["CALENDAR_BASELINE"], "no AIRBNB_BLOCKED / AIRBNB_REOPENED: no reservation ever existed");
  const fac = (await S.records()).filter((x) => x.event === "STEP_STARTED" && x.phase === "cleanup").map((x) => x.factory);
  assert.ok(fac.length >= 1 && fac.every((f) => f.reservationId === null));
  await journalValid(S);
  assert.equal((await r.finalize()).lockRelease, "unlocked");
});

test("E10. LABELLED EXTERNAL ACTOR: CAPTURE_FAILED during AIRBNB_BLOCKED → fresh snapshot → capture phase ends capture_failed → cleanup cancelled → AIRBNB_REOPENED → ENDED_RELEASED", async () => {
  const S = await scenario({ attest: { AIRBNB_BLOCKED: async (S0) => {
    // EXTERNAL ACTOR (labelled; accepted applyEvent, as e74a-compensation-worker.test.mjs:157) — not the runner, not a worker
    F.ok(await applyEvent(db.app, S0.bk.id, { type: "CAPTURE_FAILED", definite: true, code: "CARD_DECLINED" }, { now: S0.clock() }));
    return { ok: true, evidenceRef: "synthetic/airbnb_blocked" };
  } } });
  const r = await S.run();
  const ev = await S.events();
  console.log(`# E10 journal: ${JSON.stringify(ev)}`);
  assert.deepEqual([r.ok, r.outcome, r.ownerCleanupRequired, r.stopCode], [true, "ENDED_RELEASED", null, null], JSON.stringify(plainResult(r)));
  assert.ok(ev.includes("PHASE_ENDED:capture:capture_failed") && ev.includes("PHASE_ENDED:cleanup:cancelled"));
  assert.deepEqual(S.attestCalls.map((a) => a.cp), ["CALENDAR_BASELINE", "AIRBNB_BLOCKED", "AIRBNB_REOPENED"]);
  assert.equal(S.t.count(/^paymentIntents\.capture$/), 0, "the external failure was seen by a FRESH snapshot: no capture call");
  assert.deepEqual([S.t.count(/^PUT \/v1\/reservations\/\d+\/statuses\/cancelled$/), S.t.count(/^paymentIntents\.cancel$/)], [1, 1]);
  const after = S.tl.slice(S.tl.indexOf("A:AIRBNB_BLOCKED"));
  assert.ok(after.indexOf("report:BEGIN") > 0 && after.indexOf("report:BEGIN") < after.indexOf("J:STEP_STARTED:capture"));
  await journalValid(S);
  assert.equal((await r.finalize()).lockRelease, "unlocked");
});

test("E11. snapshot statement rejected / COMMIT rejected / COMMIT hangs → DB family: client destroyed, ZERO further runner SQL (unlock included), finalize destroyed, stale", async () => {
  for (const [label, fault, code] of [
    ["INTENT statement rejected", { kind: "query", sql: FACTS_SQL.INTENT, nth: 2, mode: "reject" }, "DB_FAILURE"],
    ["COMMIT rejected", { kind: "query", sql: FACTS_SQL.COMMIT, nth: 2, mode: "reject" }, "DB_FAILURE"],
    ["COMMIT hangs", { kind: "query", sql: FACTS_SQL.COMMIT, nth: 2, mode: "hang" }, "TIMEOUT_DB_READ"]
  ]) {
    const S = await scenario();
    S.report.addFault(fault);                                    // nth 2 = the first per-step snapshot (nth 1 = P0 eligibility)
    const r = await S.run();
    assert.deepEqual([r.outcome, r.stopCode, r.countsAsOf.stale, r.effectsKnown, r.ownerCleanupRequired], ["STOPPED", code, true, false, "reservedNotConfirmed"], label);
    const f = S.report.faults[0];
    assert.equal(S.report.log.length, f.at, `${label}: no further runner SQL after the fault`);
    const victim = S.report.clients.at(-1);
    assert.equal(victim.events.at(-1), "release(true)", `${label}: that client destroyed locally`);
    assert.deepEqual([S.t.h.length + S.t.s.length], [0], `${label}: no worker started`);
    const d = await r.finalize();
    assert.equal(d.lockRelease, "destroyed", `${label}: destroy-only disposal`);
    assert.ok(!S.report.sqlLog().includes(SQL.UNLOCK), `${label}: never an unlock`);
    assert.equal(S.report.clients[0].events.at(-1), "release(true)");
    assert.equal((await S.events()).at(-1), "RUN_STOPPED");
    await journalValid(S);
    await S.cleanup();
  }
});

test("E12. a worker DB fault rejects the step BEFORE any executor start → RUN_STOPPED outstanding NONE, no STEP_ENDED; destroyed", async () => {
  // nth 2: the worker's FIRST maintenance statement (its 1st, the marker check, is caught by the worker itself and becomes a refusal)
  const S = await scenario({ hooks: { STEP_STARTED: async (S0) => { S0.app.addFault({ kind: "any", nth: 2, mode: "reject" }); } } });
  const r = await S.run();
  assert.deepEqual([r.outcome, r.stopCode, r.outstanding, r.effectsKnown, r.ownerCleanupRequired], ["STOPPED", "DB_FAILURE", "NONE", false, "reservedNotConfirmed"], JSON.stringify(plainResult(r)));
  assert.deepEqual([S.t.h.length, S.t.s.length], [0, 0], "no executor started");
  const ev = await S.events();
  assert.deepEqual(ev.slice(-2), ["STEP_STARTED:reservation", "RUN_STOPPED"], "no STEP_ENDED for the open step");
  const last = (await S.records()).at(-1);
  assert.deepEqual([last.outstanding, last.effectsKnown], ["NONE", false]);
  await journalValid(S);
  assert.equal((await r.finalize()).lockRelease, "destroyed");
  await S.cleanup();
});

test("E13. the step rejects AFTER an executor started (worker releaseWork UPDATE rejected) → TAIL unobservable; finalize pending; healthy lock never unlocked", async () => {
  const S = await scenario({ hooks: { STEP_STARTED: async (S0) => { S0.app.addFault({ kind: "query", sql: RELEASE_WORK_SQL, mode: "reject" }); } } });
  const r = await S.run();
  assert.deepEqual([r.outcome, r.stopCode, r.outstanding, r.tailObservable, r.effectsKnown, r.ownerCleanupRequired], ["STOPPED", "DB_FAILURE", "TAIL", false, false, "reservedNotConfirmed"],
    JSON.stringify(plainResult(r)));
  assert.ok(S.t.h.length > 0, "an executor started inside the step");
  const last = (await S.records()).at(-1);
  assert.deepEqual([last.event, last.outstanding, last.effectsKnown], ["RUN_STOPPED", "TAIL", false]);
  await journalValid(S);
  S.T.advance(10 * 60_000); await sleep(300);
  assert.equal((await settledWithin(r.finalize(), 500)).settled, false, "finalize stays pending (unobservable tail), even after virtual time passes");
  assert.ok(!S.report.sqlLog().includes(SQL.UNLOCK), "the healthy lock session is never unlocked while work may be outstanding");
  assert.equal(S.report.clients[0].released, false, "the lock client is retained (honest ownership)");
  await S.cleanup();
});

test("E14. STEP timeout → late fulfilment → tail settles → quiescence → unlocked (waits up to the worker's own real pricing timeout)", async () => {
  const w = world(); const bk = await authorizedBooking(w);
  const g = gate(w.pricing, "post");                           // the step's pricing POST hangs (test-controlled)
  const S = await scenario({ w, bk });
  const r = await S.run();
  assert.deepEqual([r.outcome, r.stopCode, r.outstanding, r.outstandingPhase, r.effectsKnown, r.ownerCleanupRequired], ["STOPPED", "TIMEOUT_STEP", "STEP", "reservation", false, "reservedNotConfirmed"],
    JSON.stringify(plainResult(r)));
  const last = (await S.records()).at(-1);
  assert.deepEqual([last.event, last.outstanding, last.effectsKnown, last.code], ["RUN_STOPPED", "STEP", false, "TIMEOUT_STEP"]);
  assert.ok(!(await S.events()).includes("STEP_ENDED:reservation"), "never a STEP_ENDED for the timed-out step");
  const frozenBefore = plainResult(r);
  assert.equal((await settledWithin(r.finalize(), 200)).settled, false, "pending while the step runs");
  g.release();                                                 // the hung raw call settles; the worker already returned (its own 8 s timer)
  const d = await settledWithin(r.finalize(), 20_000);
  assert.equal(d.settled, true, "quiescence observed");
  assert.equal(d.v.lockRelease, "unlocked");
  assert.deepEqual(plainResult(r), frozenBefore, "late callbacks never mutate the returned result");
  assert.equal((await S.records()).at(-1).event, "RUN_STOPPED", "late callbacks never append");
  await S.cleanup();
});

test("E15. post-result tail never settles in the bound → LATE_TAIL_OUTSTANDING after a logged STEP_ENDED; TAIL; finalize pending, then settles", async () => {
  const w = world(); const bk = await authorizedBooking(w);
  const S = await scenario({ w, bk, K: 3 });                   // K=3: the runner's 75 s step bound (25 s real) outlasts the worker's own 20 s create timer
  let g = null;
  S.hooks.STEP_STARTED = async (S0, rec) => { if (rec.step === 2) g = gate(S0.w.exec.R, "createReservation"); };
  const r = await S.run();
  assert.deepEqual([r.outcome, r.stopCode, r.outstanding, r.tailObservable, r.effectsKnown, r.ownerCleanupRequired], ["STOPPED", "LATE_TAIL_OUTSTANDING", "TAIL", true, false, "reservedNotConfirmed"],
    JSON.stringify(plainResult(r)));
  const ev = await S.events();
  assert.deepEqual(ev.slice(-2).map((e) => e.split(":").slice(0, 2).join(":")), ["STEP_ENDED:reservation", "RUN_STOPPED"], "STEP_ENDED logged, then the stop");
  const recs = await S.records();
  assert.deepEqual([recs.at(-2).state, recs.at(-1).outstanding], [null, "TAIL"], "STEP_ENDED state null (no post-step snapshot), stop with TAIL");
  await journalValid(S);
  assert.equal((await settledWithin(r.finalize(), 200)).settled, false);
  g.release();
  const d = await settledWithin(r.finalize(), 20_000);
  assert.deepEqual([d.settled, d.v && d.v.lockRelease], [true, "unlocked"], "the late create evidence settles the tail; then one bounded unlock");
  await S.cleanup();
});

test("E16. lock held by another session / lost before attach / lost during P0 setup / lost between steps / lost with an outstanding STEP", async () => {
  // held
  const holder = await db.owner.connect();
  try {
    await holder.query("SELECT pg_advisory_lock(hashtext($1), 0)", [LOCK_KEY]);
    const S = await scenario();
    const r = await S.run();
    assert.deepEqual([r.outcome, r.stopCode, r.exclusion], ["REFUSED", "RUN_LOCK_HELD", "not_acquired"]);
    assert.deepEqual(S.report.sqlLog(), [SQL.LOCK], "no further SQL");
    assert.equal(S.report.clients[0].events.at(-1), "release(true)");
    assert.equal((await r.finalize()).lockRelease, "not_acquired");
  } finally { await holder.query("SELECT pg_advisory_unlock(hashtext($1), 0)", [LOCK_KEY]); holder.release(); }
  // lost BEFORE attachLock: the lock statement succeeded, then the session ended before the runner attached it (clarification 5)
  {
    const S = await scenario();
    S.report.addFault({ kind: "query", sql: SQL.LOCK, mode: "after", fn: async (c) => { await terminate(c); } });
    const r = await S.run();
    assert.deepEqual([r.outcome, r.stopCode, r.exclusion], ["REFUSED", "LOCK_LOST", "not_acquired"]);
    assert.deepEqual(S.report.sqlLog(), [SQL.LOCK], "no query of any kind after the pre-attach loss");
    assert.equal(S.app.connects, 0);
    assert.equal(S.report.clients[0].events.filter((e) => e === "release(true)").length, 1, "destroyed exactly once");
    assert.equal((await r.finalize()).lockRelease, "not_acquired");
  }
  // lost AFTER attach, during P0 setup (journal read)
  {
    const S = await scenario({ hooks: { read: async (S0) => { await terminate(S0.report.clients[0]); } } });
    const r = await S.run();
    assert.deepEqual([r.outcome, r.stopCode, r.exclusion], ["REFUSED", "LOCK_LOST", "lost"]);
    assert.ok(!S.report.sqlLog().includes(FACTS_SQL.BEGIN), "no eligibility snapshot after the loss");
    assert.equal((await r.finalize()).lockRelease, "lost");
    assert.ok(!S.report.sqlLog().includes(SQL.UNLOCK), "never an unlock on a lost session");
  }
  // lost BETWEEN steps (after the first STEP_ENDED)
  {
    const S = await scenario({ hooks: { STEP_ENDED: async (S0) => { if (!S0.killed) { S0.killed = true; await terminate(S0.report.clients[0]); } } } });
    const r = await S.run();
    assert.deepEqual([r.outcome, r.stopCode, r.exclusion, r.outstanding], ["STOPPED", "LOCK_LOST", "lost", "NONE"], JSON.stringify(plainResult(r)));
    const recs = await S.records();
    assert.deepEqual([recs.at(-1).event, recs.at(-1).exclusion], ["RUN_STOPPED", "lost"]);
    assert.equal(recs.filter((x) => x.event === "STEP_STARTED").length, 1, "no step after the loss");
    await journalValid(S);
    const d = await r.finalize();
    assert.deepEqual([d.lockRelease, d.exclusionLost], ["lost", true]);
  }
  // lost WITH an outstanding STEP: observed to its end; stop at the next boundary
  {
    const w = world(); const bk = await authorizedBooking(w);
    const S = await scenario({ w, bk });
    const orig = w.pricing.get; let killed = false;
    w.pricing.get = async (...a) => { if (!killed) { killed = true; await terminate(S.report.clients[0]); } return orig(...a); };
    const r = await S.run();
    assert.deepEqual([r.outcome, r.stopCode, r.exclusion], ["STOPPED", "LOCK_LOST", "lost"], JSON.stringify(plainResult(r)));
    const ev = await S.events();
    assert.ok(ev.some((e) => e.startsWith("STEP_ENDED:reservation")), "the running step was observed to its end");
    assert.equal((await r.finalize()).lockRelease, "lost");
    await S.cleanup();
  }
});

test("E17. late lock-connect client destroyed, never queried; try-lock timeout; unlock timeout", async () => {
  {
    const S = await scenario();
    S.report.addFault({ kind: "connect", mode: "late", ms: 1500 });          // > CONNECT_MS / K (500 ms real)
    const r = await S.run();
    assert.deepEqual([r.outcome, r.stopCode], ["REFUSED", "TIMEOUT_DB_CONNECT"]);
    await sleep(1600);
    const late = S.report.clients[0];
    assert.deepEqual(late.events, ["release(true)"], "the late client: destroyed by B exactly once, never queried, never tracked");
    assert.equal(S.report.log.length, 0);
    assert.equal((await r.finalize()).lateClientsDestroyed, 1);
  }
  {
    const S = await scenario();
    S.report.addFault({ kind: "query", sql: SQL.LOCK, mode: "hang" });
    const r = await S.run();
    assert.deepEqual([r.outcome, r.stopCode], ["REFUSED", "TIMEOUT_DB_LOCK"]);
    assert.deepEqual(S.report.sqlLog(), [SQL.LOCK]);
    assert.equal(S.report.clients[0].events.at(-1), "release(true)", "the server releases any granted lock with the destroyed session");
    assert.equal((await r.finalize()).lockRelease, "not_acquired");
  }
  {
    const S = await scenario({ attest: { CALENDAR_BASELINE: async () => ({ ok: false }) } });
    S.report.addFault({ kind: "query", sql: SQL.UNLOCK, mode: "hang" });
    const r = await S.run();
    assert.deepEqual([r.outcome, r.stopCode], ["STOPPED", "OWNER_DECLINED"]);
    const d = await settledWithin(r.finalize(), 5000);
    assert.equal(d.v.lockRelease, "destroyed_after_unlock_timeout");
    assert.equal(S.report.clients[0].events.at(-1), "release(true)");
  }
});

test("E18. journal append fails mid-run (RUN_STARTED / STEP_STARTED / STEP_ENDED; reject and hang) → no later append, not_attempted, no further step", async () => {
  for (const [label, n, mode, code, steps] of [
    ["RUN_STARTED reject", 1, "reject", "JOURNAL_FAILURE", 0], ["RUN_STARTED hang", 1, "hang", "TIMEOUT_JOURNAL", 0],
    ["STEP_STARTED reject", 3, "reject", "JOURNAL_FAILURE", 0], ["STEP_STARTED hang", 3, "hang", "TIMEOUT_JOURNAL", 0],
    ["STEP_ENDED reject", 4, "reject", "JOURNAL_FAILURE", 1], ["STEP_ENDED hang", 4, "hang", "TIMEOUT_JOURNAL", 1]
  ]) {
    const S = await scenario({ journalFaults: { append: { [n]: mode } } });
    const r = await S.run();
    assert.deepEqual([r.ok, r.stopCode, r.journalTerminal, r.journalSeq], [false, code, "not_attempted", n - 1], label);
    assert.equal(S.jm.controls.appendCalls(), n, `${label}: no later append (terminal included)`);
    assert.equal(S.tl.filter((x) => x === "J:STEP_STARTED:reservation").length, n >= 3 ? 1 : 0, `${label}: at most the one logged step`);
    const creates = S.t.count(/^GET \/v1\/listings\//);
    assert.ok(steps === 0 ? creates === 0 : creates > 0, `${label}: ${steps === 0 ? "no worker step" : "exactly the logged step ran"}`);
    if (n === 4) assert.ok(!S.tl.slice(S.tl.indexOf("J:STEP_ENDED:reservation") + 1).some((x) => x.startsWith("J:")), `${label}: no further step / append`);
    await settledWithin(r.finalize(), 3000);
    await S.cleanup();
  }
});

test("E19. terminal append late / landed_hang → journalTerminal unknown; the next invocation → RUN_ENDED (landed) / RESTART_AMBIGUOUS (not landed); zero workers", async () => {
  for (const [mode, nextCode] of [["landed_hang", "RUN_ENDED"], ["late", "RESTART_AMBIGUOUS"]]) {
    const w = world(); const bk = await authorizedBooking(w);
    const S = await scenario({ w, bk, journalFaults: { append: { 2: mode } }, attest: { CALENDAR_BASELINE: async () => ({ ok: false }) } });
    const r = await S.run();
    assert.deepEqual([r.ok, r.outcome, r.stopCode, r.journalTerminal], [false, "STOPPED", "OWNER_DECLINED", "unknown"], mode);
    assert.equal(S.jm.controls.appendCalls(), 2, `${mode}: exactly ONE terminal attempt, never repaired by an extra terminal`);
    assert.equal((await r.finalize()).lockRelease, "unlocked");
    const S2 = await scenario({ w, bk, manifest: S.manifest, jm: S.jm });
    const r2 = await S2.run();
    assert.deepEqual([r2.outcome, r2.stopCode], ["REFUSED", nextCode], mode);
    assert.deepEqual([S.t.h.length + S.t.s.length, S2.t.h.length + S2.t.s.length], [0, 0]);
    assert.equal((await r2.finalize()).lockRelease, "unlocked");
  }
});

test("E20. attest declined / rejected / hangs (CALENDAR_BASELINE: no create) and declined (AIRBNB_BLOCKED: no capture)", async () => {
  for (const [label, fn, code] of [
    ["declined", async () => ({ ok: false }), "OWNER_DECLINED"],
    ["rejected", async () => { throw new Error("synthetic attest failure"); }, "ATTESTATION_FAILED"],
    ["malformed", async () => ({ ok: true }), "ATTESTATION_FAILED"],
    ["hangs", (S0) => { setTimeout(() => S0.T.advance(31 * 60_000), 50); return new Promise(() => {}); }, "TIMEOUT_ATTEST"]
  ]) {
    const S = await scenario({ attest: { CALENDAR_BASELINE: fn } });
    const r = await S.run();
    assert.deepEqual([r.outcome, r.stopCode, r.ownerCleanupRequired, r.effectsKnown], ["STOPPED", code, null, true], label);
    assert.deepEqual([S.t.h.length, S.t.s.length], [0, 0], `${label}: no worker, no create`);
    assert.deepEqual(await S.events(), ["RUN_STARTED", "RUN_STOPPED"]);
    await journalValid(S);
    assert.equal((await r.finalize()).lockRelease, "unlocked");
  }
  const S = await scenario({ clock: "real", attest: { AIRBNB_BLOCKED: async () => ({ ok: false }) } });
  const r = await S.run();
  assert.deepEqual([r.outcome, r.stopCode, r.ownerCleanupRequired], ["STOPPED", "OWNER_DECLINED", "reservedNotConfirmed"]);
  assert.equal(S.t.count(/^paymentIntents\.capture$/), 0);
  await journalValid(S);
  assert.equal((await r.finalize()).lockRelease, "unlocked");
});

test("E21. signal aborted during a step → the step is observed to its end (worker never interrupted), then CANCELLED", async () => {
  const w = world(); const bk = await authorizedBooking(w);
  const S = await scenario({ w, bk });
  const orig = w.pricing.get; let done = false;
  w.pricing.get = async (...a) => { if (!done) { done = true; S.ac.abort(); } return orig(...a); };
  const r = await S.run();
  assert.deepEqual([r.outcome, r.stopCode, r.outstanding], ["STOPPED", "CANCELLED", "NONE"], JSON.stringify(plainResult(r)));
  const ev = await S.events();
  assert.ok(ev[ev.length - 2].startsWith("STEP_ENDED:reservation"), "the aborted step ran to its end and was logged");
  assert.equal(ev.filter((e) => e.startsWith("STEP_STARTED")).length, 1, "no step after the abort");
  await journalValid(S);
  assert.equal((await r.finalize()).lockRelease, "unlocked");
});

test("E22. the phase budget cannot cover the next step deadline → BUDGET_EXHAUSTED; the step is not started", async () => {
  const S = await scenario({ hooks: { STEP_ENDED: async (S0) => { S0.T.jump(PHASE_LIMITS.reservation.budgetMs - 60_000); } } });
  const r = await S.run();
  assert.deepEqual([r.outcome, r.stopCode], ["STOPPED", "BUDGET_EXHAUSTED"], JSON.stringify(plainResult(r)));
  assert.equal((await S.events()).filter((e) => e.startsWith("STEP_STARTED")).length, 1, "the next step never started");
  await journalValid(S);
  assert.equal((await r.finalize()).lockRelease, "unlocked");
});

test("E23. source pins: exact imports; no runner timers / env / fs / fetch / Date; no pinned identifiers; SQL limited to the three statements", () => {
  const src = readFileSync(join(ROOT, "scripts/e7-connected/run-core.mjs"), "utf8");
  const imports = [...src.matchAll(/^import\s.*?from\s+"([^"]+)";$/gm)].map((m) => m[1]).sort();
  assert.deepEqual(imports, ["../../lib/booking-db/capture-worker.js", "../../lib/booking-db/compensation-worker.js", "../../lib/booking-db/recording-worker.js",
    "../../lib/booking-db/reservation-worker.js", "./executor-adapters.mjs", "./run-facts.mjs", "./run-guard.mjs", "./run-journal-memory.mjs", "./run-manifest.mjs", "node:util"]);
  const code = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const re of [/setTimeout|setInterval|setImmediate/, /process\./, /node:fs|node:child_process|node:net|node:https?/, /\bfetch\s*\(/, /Date\.now|new Date\b/,
    /hostaway-reservations/, /connectedTestAdapterConfig/, /allowRequest:/, /console\./, /\bhooks\s*:/, /\btimeouts\s*:/]) {
    assert.doesNotMatch(code, re, String(re));
  }
  assert.equal((code.match(/\bSELECT\b/g) || []).length, 4, "SAME_DB (2 SELECTs incl. the pg_roles subquery), LOCK, UNLOCK — nothing else");
  assert.equal(netAttempts, 0);
});
