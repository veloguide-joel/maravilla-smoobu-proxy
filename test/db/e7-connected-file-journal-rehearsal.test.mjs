// E7 FILE-JOURNAL INTEGRATION REHEARSAL (TESTS + REPORT ONLY): the ACCEPTED runConnectedTest (run-core.mjs, dfdbc32c) driven through
// the ACCEPTED owner-run file journal (run-journal-file.mjs, 94c29abf) on a DISPOSABLE local PG. Report: claude/e7-connected-file-journal-rehearsal.md.
//
// LABELS
//   * REAL: disposable local PG with the real test_app / test_report logins; the accepted core, guard, facts, journal validators, adapters and
//     the four real imported workers, unchanged; the real file journal on real local files in fresh owner-only temp directories.
//   * SYNTHETIC: the provider world, transports and payment_authorized booking setup below are COPIED VERBATIM from the accepted adapter
//     rehearsal (test/db/e7-connected-adapter-rehearsal.test.mjs:41–226; SYNTHETIC / DOC-DERIVED / LIVE-UNVERIFIED). Mocked authorization.
//   * INJECTED (labelled): G3 / G4 pass a test-local fsAdapter that wraps the module's OWN default adapter (createNodeFsAdapter) and changes
//     exactly ONE file operation (a sync error / a gated write). The accepted module itself is unchanged.
//   * TIME: scaled real timers (monotonic = real elapsed × K, arm(ms) → setTimeout(ms / K)); business clock = real clock (recording) or
//     20 min behind real time following virtual time, capped 5 s behind real time (recovery scenario) — the accepted rehearsal's rule.
//   * No worker injection, no trigger bypass, no raw lifecycle writes, no real network / credentials. Guest values never printed.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { startMigratedDatabase } from "./harness.mjs";
import * as F from "./fixtures.mjs";
import { applyEvent, createIntentRecord, collectGuestDetails, beginPayStep, recordCheckoutSession } from "../../lib/booking-db/repo.js";
import { claimNextOperation, completeOperation } from "../../lib/booking-db/operations.js";
import { PROTECTED_HOSTAWAY_RESERVATION_IDS } from "../../lib/booking-db/reservation-worker.js";
import { priceStay } from "../../lib/checkout/server-pricer.js";
import { readDirectPolicyFromEnv } from "../../lib/direct-policy.js";
import { todayInTimeZone } from "../../lib/public-api.js";
import { validateRunManifest, CHECKPOINTS } from "../../scripts/e7-connected/run-manifest.mjs";
import { validateJournal, evaluateStart, recordHash, GENESIS_HASH } from "../../scripts/e7-connected/run-journal-memory.mjs";
import { runConnectedTest } from "../../scripts/e7-connected/run-core.mjs";
import { openFileJournal, createNodeFsAdapter, encodeRecordLine, journalFileName } from "../../scripts/e7-connected/run-journal-file.mjs";

let netAttempts = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { netAttempts += 1; throw new Error("network refused in the offline file-journal rehearsal"); };
let db; let reportPool;
const DIRS = [];
before(async () => { db = await startMigratedDatabase(); reportPool = new pg.Pool({ connectionString: db.reportUrl(), max: 8 }); });
after(async () => { globalThis.fetch = realFetch; await reportPool.end().catch(() => {}); await db.close(); for (const d of DIRS) rmSync(d, { recursive: true, force: true }); assert.equal(netAttempts, 0); });

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
// rehearsal harness (TEST-ONLY)
const BASE_COMMIT = "94c29abf66dfcfd5b580471f847e670a14a2871c";
const one = async (sql, p = []) => (await db.owner.query(sql, p)).rows[0];
const all = async (sql, p = []) => (await db.owner.query(sql, p)).rows;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settledWithin = (p, ms) => Promise.race([p.then((v) => ({ settled: true, v })), sleep(ms).then(() => ({ settled: false }))]);
const W0 = Object.freeze({ cancel: 0, capture: 0, create: 0, record: 0, void: 0 });
const PROVIDER_WRITE_OPS = ["hostaway.create_reservation", "stripe.capture_payment_intent", "hostaway.record_offline_charge", "stripe.void_payment_intent", "hostaway.cancel_reservation"];
/** independent DB facts (owner, read-only): dispatched writes per type, total ops, transitions, open cases, notify rows */
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
  return { version: "e7-run-manifest-v1", runId: `synthetic-fjr-${String(runN).padStart(4, "0")}`, intentId: bk.id, baselineCommit: BASE_COMMIT, synthetic: true,
    providerMode: { hostaway: "fake", stripe: "mock" }, listing: { id: bk.listingId, currency: "USD", refFieldId: REF_FIELD, timeZone: TZ }, expectedRef: bk.ref,
    stay: { arrival: bk.stay.from, departure: bk.stay.to, guests: bk.stay.guests }, amountMinor: bk.total, pricing: { rateBps: Number(i.rate_bps) },
    stripeAccountId: ACCT, hostawayAccountLabel: { ...LABEL }, phases, paymentMethod: phases.recording ? "credit_card" : null,
    cleanup: { reservedNotConfirmed: "synthetic/cleanup-reserved", captured: "synthetic/cleanup-captured", confirmed: "synthetic/cleanup-confirmed" },
    automationsReviewed: "synthetic/automations", checkpoints: [...CHECKPOINTS] };
}
/** a labelled fs fault: wraps the module's own default adapter; changes ONE journal-file operation (counters cover journal handles only) */
function fsFault(plan) {
  const base = createNodeFsAdapter();
  const log = { writes: 0, syncs: 0 };
  const wrap = (h, kind) => (!kind.startsWith("journal") ? h : Object.freeze({
    ...h,
    write: async (buf, off, len) => { log.writes += 1; if (plan.write) await plan.write(log.writes); return h.write(buf, off, len); },
    sync: async () => { log.syncs += 1; if (plan.sync) await plan.sync(log.syncs); return h.sync(); }
  }));
  return { log, a: Object.freeze({ ...base, open: async (p, kind) => wrap(await base.open(p, kind), kind) }) };
}

/** one rehearsal lane: booking + manifest + owner-only temp journal directory + transports + time + attest */
async function lane({ w = world(), bk, phases = { capture: true, recording: true }, clock = "real", K = 10, attest = {}, afterBooking } = {}) {
  const b = bk ?? await authorizedBooking(w);
  if (afterBooking) afterBooking(w, b);
  const manifest = await manifestFor(b, phases);
  const mv = validateRunManifest(manifest);
  assert.equal(mv.ok, true, mv.code);
  const dir = mkdtempSync(join(tmpdir(), "e7fjr-")); DIRS.push(dir);
  const L = { w, bk: b, manifest, dir, identity: { runId: manifest.runId, intentId: b.id, manifestHash: mv.hash, baselineCommit: BASE_COMMIT }, t: transports(w), attestCalls: [] };
  L.file = join(dir, journalFileName(manifest.runId));
  L.openJournal = async (fsAdapter) => { const j = await openFileJournal({ dir, identity: L.identity, ...(fsAdapter ? { fsAdapter } : {}) }); assert.equal(j.ok, true, j.code); return j; };
  L.run = async (fj, over = {}) => {
    const T = timeDriver(K);
    const clk = clock === "real" ? () => Date.now() : () => Math.floor(Math.min(b.base + 10 * SEC + T.now(), Date.now() - 5 * SEC));
    const ac = new AbortController();
    const att = (cp, request) => { L.attestCalls.push(cp); return attest[cp] ? attest[cp](request) : Promise.resolve({ ok: true, evidenceRef: `synthetic/${cp.toLowerCase()}` }); };
    return runConnectedTest({ manifest, intentId: b.id, pools: { app: db.app, report: reportPool }, transports: { hostaway: L.t.hostaway, stripe: L.t.stripe }, journal: fj.journal,
      trustedHead: null, attest: att, clock: clk, monotonic: T.monotonic, timers: T.timers, signal: ac.signal, ...over });
  };
  /** independent verification of the stored bytes with D's validators: canonical lines, chain, hashes → { records, verdict } */
  L.verifyFile = async () => {
    const j = await L.openJournal();
    try {
      const rr = await j.journal.read();
      const bytes = readFileSync(L.file);
      assert.deepEqual(bytes, Buffer.concat(rr.records.map(encodeRecordLine)), "stored bytes = canonical lines of exactly these records");
      let prev = GENESIS_HASH;
      for (const [i, r] of rr.records.entries()) { assert.equal(r.seq, i + 1); assert.equal(r.prevHash, prev, `chain at seq ${r.seq}`); prev = recordHash(r); }
      assert.deepEqual(j.status().head, rr.records.length ? { seq: rr.records.length, hash: prev } : null, "the handle's head = D.recordHash of the last stored record");
      return { records: rr.records, tail: rr.tail, verdict: evaluateStart(rr, L.identity), validated: validateJournal(rr.records, L.identity) };
    } finally { const c = await j.close(); assert.deepEqual({ ...c }, { fileClose: "closed", lock: "released" }); }
  };
  L.events = (recs) => recs.map((r) => `${r.event}${r.phase ? `:${r.phase}` : ""}${r.attestation ? `:${r.attestation.checkpoint}` : ""}${r.state ? `:${r.state}` : ""}`);
  L.transportCount = () => L.t.h.length + L.t.s.length;
  return L;
}
/** re-invoke the core with a FRESH file handle on the same journal → must refuse with `code`, zero transport / DB effect */
async function reinvoke(L, code) {
  const before = { t: L.transportCount(), w: { ...L.w.writes }, db: await dbFacts(L.bk.id) };
  const j = await L.openJournal();
  const r = await L.run(j);
  assert.deepEqual([r.ok, r.outcome, r.stopCode, r.journalSeq], [false, "REFUSED", code, 0], `re-invoke: ${code}`);
  assert.equal((await r.finalize()).lockRelease, "unlocked");
  assert.deepEqual({ ...(await j.close()) }, { fileClose: "closed", lock: "released" });
  assert.deepEqual([L.transportCount(), { ...L.w.writes }, await dbFacts(L.bk.id)], [before.t, before.w, before.db], "zero additional transport / provider / DB effect");
}
const plain = (r) => JSON.stringify({ ...r, finalize: undefined });

// =================================================================================================================================
test("G1. real file journal end to end: reservation → capture → recording → confirmed; one write per type; notify pending; D chain + terminal; re-invoke → RUN_ENDED", async () => {
  const L = await lane({ clock: "real" });
  const fj = await L.openJournal();
  assert.deepEqual([fj.status().created, fj.status().records], [true, 0]);
  const r = await L.run(fj);
  assert.deepEqual([r.ok, r.outcome, r.stopCode, r.ownerCleanupRequired, r.journalTerminal, r.effectsKnown], [true, "ENDED_CONFIRMED", null, "confirmed", "acknowledged", true], plain(r));
  assert.deepEqual({ ...r.writes }, { ...W0, create: 1, capture: 1, record: 1 });
  assert.deepEqual([fj.status().head.seq, fj.status().state], [r.journalSeq, "open"], "core seq = file head");
  const d = await r.finalize();
  assert.equal(d.lockRelease, "unlocked", "runner finalize observed (quiescent)");
  assert.deepEqual({ ...(await fj.close()) }, { fileClose: "closed", lock: "released" });
  assert.deepEqual([L.w.writes.createReservation, L.w.writes.capturePaymentIntent, L.w.writes.createOfflineCharge, L.w.writes.cancelPaymentIntent, L.w.writes.cancelReservation], [1, 1, 1, 0, 0]);
  assert.deepEqual([L.t.count(/^POST \/v1\/reservations$/), L.t.count(/^paymentIntents\.capture$/), L.t.count(/^POST \/v1\/guestPayments\/charges\/\d+$/), L.t.count(/^paymentIntents\.cancel$/), L.t.count(/^PUT /)], [1, 1, 1, 0, 0]);
  const f = await dbFacts(L.bk.id);
  assert.deepEqual([f.state, f.writes["hostaway.create_reservation"], f.writes["stripe.capture_payment_intent"], f.writes["hostaway.record_offline_charge"], f.writes["stripe.void_payment_intent"], f.writes["hostaway.cancel_reservation"], f.cases],
    ["confirmed", 1, 1, 1, 0, 0, []]);
  assert.deepEqual(f.notify, [["pending", null, 0]], "guest.notify queued, never invoked");
  const v = await L.verifyFile();
  console.log(`# G1 journal: ${JSON.stringify(L.events(v.records))}`);
  assert.deepEqual([v.tail, v.validated.status, v.verdict.code, v.records.length, v.records.at(-1).event, v.records.at(-1).outcome], ["complete", "ENDED", "RUN_ENDED", r.journalSeq, "RUN_ENDED", "ENDED_CONFIRMED"]);
  const g = await one("SELECT first_name, last_name, email FROM booking.intent_guests WHERE intent_id = $1", [L.bk.id]);
  const txt = readFileSync(L.file, "utf8");
  assert.ok(![g.first_name, g.last_name, g.email].some((x) => x && txt.includes(x)), "no guest value in the journal file");
  assert.ok(!txt.includes(L.dir), "no path in the journal file");
  await reinvoke(L, "RUN_ENDED");
  assert.ok(L.t.h.every((p) => !PROTECTED.some((id) => p.includes(id))));
});

test("G2. no resume: a stop BEFORE any provider write (baseline declined) and a stop AFTER a genuinely applied ambiguous create (OPEN_CASE); fresh handle refuses", async () => {
  {   // (a) CALENDAR_BASELINE declined → RUN_STOPPED OWNER_DECLINED, nothing dispatched
    const L = await lane({ attest: { CALENDAR_BASELINE: async () => ({ ok: false }) } });
    const fj = await L.openJournal();
    const r = await L.run(fj);
    assert.deepEqual([r.outcome, r.stopCode, r.ownerCleanupRequired, r.effectsKnown, r.journalTerminal], ["STOPPED", "OWNER_DECLINED", null, true, "acknowledged"], plain(r));
    assert.equal(L.transportCount(), 0, "no provider call");
    assert.equal((await r.finalize()).lockRelease, "unlocked");
    await fj.close();
    const v = await L.verifyFile();
    assert.deepEqual([L.events(v.records), v.verdict.code], [["RUN_STARTED", "RUN_STOPPED"], "RUN_ENDED"]);
    assert.deepEqual([v.records.at(-1).code, v.records.at(-1).ownerCleanupRequired], ["OWNER_DECLINED", null]);
    const f = await dbFacts(L.bk.id);
    assert.deepEqual([f.state, Object.values(f.writes).reduce((a, b) => a + b, 0)], ["payment_authorized", 0], "the intent is untouched");
    await reinvoke(L, "RUN_ENDED");
  }
  {   // (b) ambiguous create (the fake APPLIES it, then 503): the accepted recovery confirms it; the strict gate after AIRBNB_BLOCKED stops OPEN_CASE
    const L = await lane({ clock: "behind", phases: { capture: true, recording: false } });
    L.w.mode.create = "appliedThen503";
    const fj = await L.openJournal();
    const r = await L.run(fj);
    assert.deepEqual([r.outcome, r.stopCode, r.ownerCleanupRequired], ["STOPPED", "OPEN_CASE", "reservedNotConfirmed"], plain(r));
    assert.deepEqual([L.w.writes.createReservation, L.t.count(/^paymentIntents\./)], [1, 0], "one applied create; zero capture-phase calls");
    assert.equal((await r.finalize()).lockRelease, "unlocked");
    await fj.close();
    const v = await L.verifyFile();
    console.log(`# G2b journal: ${JSON.stringify(L.events(v.records))}`);
    assert.deepEqual([v.records.at(-1).event, v.records.at(-1).code, v.records.at(-1).ownerCleanupRequired, v.verdict.code], ["RUN_STOPPED", "OPEN_CASE", "reservedNotConfirmed", "RUN_ENDED"]);
    const f = await dbFacts(L.bk.id);
    assert.deepEqual([f.writes["hostaway.create_reservation"], f.cases], [1, ["HOSTAWAY_CREATE_OUTCOME_UNKNOWN"]], "the case stays OPEN (never reconciled for convenience)");
    const createOps = await all("SELECT idempotency_key, state FROM booking.external_operations WHERE intent_id = $1 AND op_type = 'hostaway.create_reservation'", [L.bk.id]);
    assert.deepEqual(createOps.map((o) => o.state), ["outcome_unknown"], "one create row, a durable unknown");
    await reinvoke(L, "RUN_ENDED");
    assert.deepEqual((await all("SELECT idempotency_key FROM booking.external_operations WHERE intent_id = $1 AND op_type = 'hostaway.create_reservation'", [L.bk.id])).map((o) => o.idempotency_key),
      createOps.map((o) => o.idempotency_key), "no second create / key");
  }
});

test("G3. INJECTED file sync failure on the STEP_ENDED after a genuinely applied create → JOURNAL_FAILURE; no further provider call / append; close after settle; reopen → D's verdict", async () => {
  const L = await lane({ clock: "real", phases: { capture: true, recording: false } });
  // journal syncs: #1 file creation, then one per append; append #6 = the STEP_ENDED of the create step (2nd reservation step) → sync #7
  const fault = fsFault({ sync: async (n) => { if (n === 7) throw Object.assign(new Error("synthetic EIO"), { code: "EIO" }); } });
  const fj = await L.openJournal(fault.a);
  const r = await L.run(fj);
  assert.deepEqual([r.ok, r.outcome, r.stopCode, r.journalTerminal, r.effectsKnown, r.ownerCleanupRequired], [false, "STOPPED", "JOURNAL_FAILURE", "not_attempted", false, "reservedNotConfirmed"], plain(r));
  assert.deepEqual([fault.log.syncs, fault.log.writes], [7, 6], "no append after the failed one (no RUN_STOPPED, no retry)");
  assert.deepEqual([L.w.writes.createReservation, L.t.count(/^paymentIntents\./), L.transportCount() > 0], [1, 0, true], "the create was applied; no further provider call");
  assert.equal(fj.status().state, "failed", "the file handle is poisoned");
  assert.equal((await r.finalize()).lockRelease, "unlocked", "runner finalize: quiescent, healthy unlock (journal failure is not a DB failure)");
  assert.deepEqual({ ...(await fj.close()) }, { fileClose: "closed", lock: "released" }, "file close after every started file op settled");
  const v = await L.verifyFile();
  console.log(`# G3 journal on disk: ${JSON.stringify(L.events(v.records))}`);
  assert.deepEqual([v.records.length, v.records.at(-1).event, v.records.at(-1).state], [6, "STEP_ENDED", "reservation_confirmed"], "the unacknowledged line IS on disk (write completed, sync failed): a timeout / failure never proves absence");
  assert.deepEqual([v.verdict.ok, v.verdict.code, v.verdict.interruptedStep], [false, "RESTART_AMBIGUOUS", false], "D's actual no-resume verdict");
  const f = await dbFacts(L.bk.id);
  assert.deepEqual([f.state, f.writes["hostaway.create_reservation"], f.writes["stripe.capture_payment_intent"]], ["reservation_confirmed", 1, 0]);
  await reinvoke(L, "RESTART_AMBIGUOUS");
});

test("G4. terminal append TIMEOUT with a test-controlled late file completion: one terminal attempt, failed run; file close waits for the write; reopen → RUN_ENDED", async () => {
  const L = await lane({ clock: "real", phases: { capture: false, recording: false } });
  let release; const gate = new Promise((r) => { release = r; });
  // journal writes: one per append (no short writes); append #9 = RUN_ENDED on the planned ENDED_RESERVED_NOT_CAPTURED path
  const fault = fsFault({ write: async (n) => { if (n === 9) await gate; } });
  const fj = await L.openJournal(fault.a);
  const r = await L.run(fj);
  assert.deepEqual([r.ok, r.outcome, r.stopCode, r.journalTerminal, r.ownerCleanupRequired], [false, "STOPPED", "TIMEOUT_JOURNAL", "unknown", "reservedNotConfirmed"], plain(r));
  assert.equal(fault.log.writes, 9, "exactly one terminal attempt (no RUN_STOPPED replacement)");
  assert.deepEqual([L.w.writes.createReservation, L.t.count(/^paymentIntents\./)], [1, 0]);
  const transportsAtStop = L.transportCount();
  assert.equal((await r.finalize()).lockRelease, "unlocked", "runner finalize waits worker / DB ownership only — quiescent here");
  const cp = fj.close();
  assert.equal((await settledWithin(cp, 300)).settled, false, "file close waits for the started terminal write (no abandon / force close)");
  assert.ok(existsSync(`${L.file}.lock`), "the journal lock is still held while the write is pending");
  assert.equal(fj.status().records, 8, "not yet acknowledged");
  release();
  assert.deepEqual({ ...(await cp) }, { fileClose: "closed", lock: "released" });
  const v = await L.verifyFile();
  assert.deepEqual([v.records.length, v.records.at(-1).event, v.records.at(-1).outcome, v.verdict.code], [9, "RUN_ENDED", "ENDED_RESERVED_NOT_CAPTURED", "RUN_ENDED"], "the late terminal landed exactly once");
  assert.equal(L.transportCount(), transportsAtStop, "no worker / provider call after the stop");
  await reinvoke(L, "RUN_ENDED");
});
