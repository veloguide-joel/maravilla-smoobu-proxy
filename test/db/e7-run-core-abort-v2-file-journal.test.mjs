// E7 M2-E — the accepted M2-D core (runAbortRehearsalV2) over the v2 FILE journal + separately persisted head, on a DISPOSABLE local PG
// (migrations 0001–0017 incl. the 0017 LOCAL candidate; never a shared DB). REAL Node fs in fresh temp dirs; fake providers; no network.
//
// LABELS
//   * The harness (provider world, booking setup, fake transports, timeDriver, FaultPool, terminate, manifestFor) is a LABELLED COPY of
//     test/db/e7-run-core-abort-v2.test.mjs (accepted at 6f4a8a8; itself a labelled copy of the v1 runner harness) up to manifestFor;
//     the only change is the runId prefix. The M2-D core, bridge, helper and workers run UNCHANGED.
//   * FAULTS: a labelled wrapper around the accepted createNodeFsAdapter refuses the HEAD-file write / sync of ONE chosen record (by event),
//     after the real journal line + fsync — i.e. the record is durable in the journal but never receives the combined ACK (K3 / K6).
//     This proves ORDER and refusal logic over a real fs, not power-loss durability.
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
import { validateJournalV2 } from "../../scripts/e7-connected/run-journal-memory-v2.mjs";
import { openFileJournalV2, readJournalForRecoveryV2, journalFileNameV2, headFileNameV2, NO_PERMISSION } from "../../scripts/e7-connected/run-journal-file-v2.mjs";
import { createNodeFsAdapter, parseJournalBytes } from "../../scripts/e7-connected/run-journal-file.mjs";
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
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
  return { version: "e7-run-manifest-v2", runId: `synthetic-m2e-${String(runN).padStart(4, "0")}`, intentId: bk.id, baselineCommit: BASE_COMMIT, synthetic: true,
    providerMode: { hostaway: "fake", stripe: "mock" }, listing: { id: bk.listingId, currency: "USD", refFieldId: REF_FIELD, timeZone: TZ, connection }, expectedRef: bk.ref,
    stay: { arrival: bk.stay.from, departure: bk.stay.to, guests: bk.stay.guests }, amountMinor: bk.total, pricing: { rateBps: Number(i.rate_bps) },
    stripeAccountId: ACCT, hostawayAccountLabel: { ...LABEL }, phases: { capture: false, recording: false, testAbortAfterReservation: true }, paymentMethod: null,
    cleanup: { reservedNotConfirmed: "synthetic/cleanup-reserved", captured: "synthetic/cleanup-captured", confirmed: "synthetic/cleanup-confirmed" },
    automationsReviewed: "synthetic/automations", checkpoints: [...CHECKPOINTS_BY_CONNECTION[connection]], ...over };
}
// ===== end of the labelled copy; M2-E harness below =====
const FBASE = mkdtempSync(join(tmpdir(), "e7-m2e-pg-"));
after(() => { rmSync(FBASE, { recursive: true, force: true }); });
let fdirN = 0;
const fdirs = () => { fdirN += 1; const j = join(FBASE, `j${fdirN}`); const h = join(FBASE, `h${fdirN}`); mkdirSync(j, { mode: 0o700 }); mkdirSync(h, { mode: 0o700 }); return { j, h }; };
/** LABELLED fault wrapper: real node fs; refuses the HEAD write ("write") or rejects AFTER a real head fsync ("after") for the record whose
 *  journal line carries event `target` (the journal line + fsync have already happened for that record). */
function headFaultFs(target, how) {
  const real = createNodeFsAdapter(); const S = { armed: false, fired: 0 };
  const wrap = (p, h) => {
    const isJ = p.includes("e7-journal-v2") && !p.endsWith(".lock"); const isH = p.includes("e7-head-v2") && !p.endsWith(".lock");
    return Object.freeze({
      write: async (buf, off, len) => {
        if (isJ && target) { try { const ev = JSON.parse(buf.subarray(off, off + len).toString("utf8")).event; S.armed = ev === target; } catch { S.armed = false; } }
        if (isH && S.armed && how === "write") { S.armed = false; S.fired += 1; throw Object.assign(new Error("EIO"), { code: "EIO" }); }
        return h.write(buf, off, len);
      },
      sync: async () => { await h.sync(); if (isH && S.armed && how === "after") { S.armed = false; S.fired += 1; throw Object.assign(new Error("EIO"), { code: "EIO" }); } },
      read: (...a) => h.read(...a), stat: () => h.stat(), close: () => h.close() });
  };
  return { S, adapter: Object.freeze({ platform: real.platform, uid: real.uid, realpath: real.realpath, lstat: real.lstat, unlink: real.unlink, openDir: real.openDir,
    open: async (p, kind) => wrap(p, await real.open(p, kind)) }) };
}
/** one scenario over the FILE journal (fresh dirs); the core gets the file journal object directly (no memory journal anywhere) */
async function fscenario(o = {}) {
  const w = world(); const bk = await authorizedBooking(w);
  const T = timeDriver(10);
  const connection = o.connection ?? "disconnected";
  const manifest = await manifestFor(bk, connection);
  const d = fdirs(); const ff = o.fault ? headFaultFs(o.fault.event, o.fault.how) : null;
  const fj = await openFileJournalV2({ journalDir: d.j, headDir: d.h, manifest, ...(ff ? { fsAdapter: ff.adapter } : {}) });
  assert.equal(fj.ok, true, JSON.stringify(fj));
  const tl = [];
  const S = { w, bk, T, manifest, d, fj, ff, connection, K: CHECKPOINTS_BY_CONNECTION[connection] };
  S.app = new FaultPool(db.app, "app", tl); S.report = new FaultPool(reportPool, "report", tl);
  S.t = transports(w); S.ac = new AbortController();
  S.clock = () => Math.floor(Math.min(bk.base + 10 * SEC + T.now(), Date.now() - 5 * SEC));
  S.opts = { manifest, intentId: bk.id, pools: { app: S.app, report: S.report }, transports: { hostaway: S.t.hostaway, stripe: S.t.stripe }, journal: fj.journal,
    trustedHead: null, attest: (cp) => Promise.resolve({ ok: true, evidenceRef: `synthetic/${cp.toLowerCase()}` }), clock: S.clock, monotonic: T.deps.monotonic,
    timers: T.deps.timers, signal: S.ac.signal };
  S.run = async () => { S.result = await runAbortRehearsalV2(S.opts); return S.result; };
  // durable bytes straight from disk (test-only read; the poisoned handle refuses reads by design)
  S.disk = () => { const p = parseJournalBytes(readFileSync(join(d.j, journalFileNameV2(manifest.runId)))); assert.equal(p.ok, true); return p.records; };
  S.headLines = () => readFileSync(join(d.h, headFileNameV2(manifest.runId)), "utf8").split("\n").filter(Boolean).length;
  S.recover = (th) => readJournalForRecoveryV2({ journalDir: d.j, headDir: d.h, manifest, ...(th ? { trustedHead: th } : {}) });
  S.cleanup = async () => { await S.app.cleanup(); await S.report.cleanup(); };
  LIVE.push(S);
  return S;
}
const plainResult = (r) => JSON.parse(JSON.stringify({ ...r, finalize: undefined }));
const state = async (id) => (await loadIntent(db.app, id)).status;
const claimsHeld = async (id) => Number((await one("SELECT count(*)::int AS n FROM booking.inventory_claims WHERE intent_id = $1 AND released_at IS NULL", [id])).n);
const appliedAborts = async (id) => Number((await one("SELECT count(*)::int AS n FROM booking.intent_applied_events WHERE intent_id = $1 AND event_type = 'TEST_ABORT_REQUESTED'", [id])).n);
const providerSettle = (S) => [S.t.count(/^PUT \/v1\/reservations\/\d+\/statuses\/cancelled$/), S.t.count(/^paymentIntents\.cancel$/)];
const cleanupStepsOnDisk = (S) => S.disk().filter((x) => x.event === "STEP_STARTED" && x.phase === "cleanup").length;

test("F1 the accepted M2-D real-worker lifecycle over the REAL-fs v2 file journal + separate head, BOTH modes: ENDED_RELEASED; journal = head = the run's last ACKed head; recovery diagnoses (no permission)", async () => {
  for (const connection of ["disconnected", "airbnb"]) {
    const S = await fscenario({ connection });
    const r = await S.run();
    assert.deepEqual([r.ok, r.outcome, r.journalTerminal, r.journalTail, r.bridgeCalls], [true, "ENDED_RELEASED", "acknowledged", "KNOWN", 1], JSON.stringify(plainResult(r)));
    assert.deepEqual({ ...r.writes }, { cancel: 1, capture: 0, create: 1, record: 0, void: 1 });
    assert.deepEqual([S.t.count(/^POST \/v1\/reservations$/), ...providerSettle(S)], [1, 1, 1]);
    assert.deepEqual([await state(S.bk.id), await claimsHeld(S.bk.id), await appliedAborts(S.bk.id)], ["cancelled", 0, 1]);
    assert.equal((await r.finalize()).lockRelease, "unlocked");
    const cl = await S.fj.close();
    assert.deepEqual({ ...cl }, { fileClose: "closed", headLock: "released", journalLock: "released" });
    const recs = S.disk();
    assert.deepEqual([recs.length, S.headLines(), r.trustedHead.seq], [recs.length, recs.length, recs.length]);
    assert.equal(validateJournalV2(recs, S.manifest, { trustedHead: { ...r.trustedHead } }).ok, true);
    const ev = recs.map((x) => x.event);
    assert.ok(ev.indexOf("ABORT_ACCEPTED") === ev.indexOf("ABORT_REQUEST_STARTED") + 1 && ev.indexOf("ABORT_ACCEPTED") < ev.lastIndexOf("STEP_STARTED"));
    const rec = await S.recover({ ...r.trustedHead });
    assert.deepEqual([rec.relation, rec.suppliedHead, rec.chain.status, rec.effects], ["AT_ESCROW_HEAD", "MATCH_TIP", "ENDED", "UNKNOWN_FROM_DISK"], JSON.stringify(rec));
    assert.deepEqual({ ...rec.permission }, { ...NO_PERMISSION });
    assert.ok(rec.unresolved.includes("TERMINAL_RECORDED") && rec.unresolved.includes("LAST_RECORD_ACK_DELIVERY_UNKNOWN"));
    assert.equal((await openFileJournalV2({ journalDir: S.d.j, headDir: S.d.h, manifest: S.manifest })).code, "JOURNAL_EXISTS", "never reopened for a new run");
  }
});

test("F2 K3 at the START record: its journal line is durable but the head write fails → no combined ACK → the bridge stops (STOPPED_START_UNACKED) with 0 operator-core calls, 0 helper writes; no RUN_STOPPED over the unknown tail; recovery = JOURNAL_AHEAD_1 / ABORT_STARTED_UNRECEIPTED, no permission", async () => {
  const S = await fscenario({ fault: { event: "ABORT_REQUEST_STARTED", how: "write" } });
  const r = await S.run();
  assert.equal(S.ff.S.fired, 1);
  assert.deepEqual([r.outcome, r.stopCode, r.journalTail, r.bridge.outcome, r.bridge.operatorCoreInvocations, r.bridge.startAck],
    ["STOPPED", "ABORT_START_UNACKED", "UNKNOWN", "STOPPED_START_UNACKED", 0, null], JSON.stringify(plainResult(r)));
  assert.deepEqual([await appliedAborts(S.bk.id), await state(S.bk.id), ...providerSettle(S)], [0, "reservation_confirmed", 0, 0]);
  const recs = S.disk();
  assert.deepEqual([recs.at(-1).event, recs.length - S.headLines()], ["ABORT_REQUEST_STARTED", 1], "durable in the journal, never escrowed");
  assert.equal(recs.some((x) => x.event === "RUN_STOPPED"), false);
  await r.finalize().catch(() => {}); await S.fj.close();
  const rec = await S.recover();
  assert.deepEqual([rec.relation, rec.chain.anchoredPrefix.seq], ["JOURNAL_AHEAD_1", recs.length - 1], JSON.stringify(rec));
  for (const u of ["UNESCROWED_LAST_RECORD", "ABORT_STARTED_UNRECEIPTED", "LAST_RECORD_ACK_DELIVERY_UNKNOWN"]) assert.ok(rec.unresolved.includes(u), u);
  assert.deepEqual({ ...rec.permission }, { ...NO_PERMISSION });
});

test("F3 RECEIPT failure, both variants (head write refused → journal-ahead; head synced then ACK lost → escrow-equal): STOPPED_RECEIPT_UNACKED, 0 cleanup, the accepted DB outcome (capture_failed, claim held) preserved; recovery withholds cleanup authority either way", async () => {
  for (const how of ["write", "after"]) {
    const S = await fscenario({ connection: how === "write" ? "airbnb" : "disconnected", fault: { event: "ABORT_ACCEPTED", how } });
    const r = await S.run();
    assert.equal(S.ff.S.fired, 1, how);
    assert.deepEqual([r.outcome, r.stopCode, r.journalTail, r.bridge.outcome, r.bridge.receiptLanding, r.bridge.dbAbortApplied],
      ["STOPPED", "ABORT_RECEIPT_UNACKED", "UNKNOWN", "STOPPED_RECEIPT_UNACKED", "UNACKED_MAY_HAVE_LANDED", true], `${how}: ${JSON.stringify(plainResult(r))}`);
    assert.deepEqual([cleanupStepsOnDisk(S), ...providerSettle(S), await state(S.bk.id), await claimsHeld(S.bk.id), await appliedAborts(S.bk.id)], [0, 0, 0, "capture_failed", 1, 1], how);
    assert.deepEqual(r.trustedHead, r.bridge.startAck, `${how}: the last ACKed head = the start record`);
    const recs = S.disk();
    assert.deepEqual([recs.at(-1).event, recs.length - S.headLines()], ["ABORT_ACCEPTED", how === "write" ? 1 : 0], how);
    await r.finalize().catch(() => {}); await S.fj.close();
    const rec = await S.recover({ ...r.trustedHead });
    assert.deepEqual([rec.relation, rec.suppliedHead, rec.permission.cleanup], [how === "write" ? "JOURNAL_AHEAD_1" : "AT_ESCROW_HEAD", "IN_CHAIN_BEHIND_TIP", false], `${how}: ${JSON.stringify(rec)}`);
    assert.ok(rec.unresolved.includes("ABORT_RECEIPT_ACK_UNKNOWN"), how);
    assert.equal(rec.chain.factsAre, "EVIDENCE_NOT_PERMISSION");
  }
});
