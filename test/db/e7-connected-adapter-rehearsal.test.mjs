// E7 connected-test ADAPTER / WORKER INTEGRATION REHEARSAL (tests + report only). The ACCEPTED workers run with executors produced by the
// accepted executor-adapter factories (scripts/e7-connected/executor-adapters.mjs, accepted at b757d6b7); every provider request crosses the
// adapter into an INJECTED FAKE transport over one coherent synthetic world. Report: claude/e7-connected-adapter-rehearsal.md.
//
// LABELS
//   * SYNTHETIC / DOC-DERIVED / LIVE-UNVERIFIED: every Hostaway / Stripe object is the accepted lifecycle rehearsal's mock world, copied
//     test-locally (test/db/e7-offline-lifecycle.test.mjs; this file adds two create reply modes). Fakes prove request MAPPING and worker
//     integration only — never provider support. Global fetch guard: zero network.
//   * TEST-LOCAL HARNESS (not a runner): before each bounded step it builds a FRESH immutable factory from persisted DB facts. The facts the
//     accepted runtime API does not expose (operation rows, provider evidence, the guest row) are read with labelled TEST-ONLY SELECTs as the
//     schema owner. The manifest §9.2a recovery-candidate checks are implemented HERE (recoveryCandidate); the adapter module does NOT enforce
//     DB provenance.
//   * Initial booking up to payment_authorized follows the accepted lifecycle rehearsal (synthetic; repo functions + mocked authorization).
//     After that, every transition is written by an accepted worker. No trigger disabling, no raw operation INSERT / UPDATE, no manual
//     completion, no due() helper. Injected clock (20 min behind, only advanced, never past real time) for reservation / capture / cleanup;
//     real clock for recording (its skew gate). Notification / owner-alert execution, inbox drain and global maintenance are never called.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startMigratedDatabase } from "./harness.mjs";
import * as F from "./fixtures.mjs";
import { applyEvent, loadIntent, createIntentRecord, collectGuestDetails, beginPayStep, recordCheckoutSession } from "../../lib/booking-db/repo.js";
import { claimNextOperation, completeOperation } from "../../lib/booking-db/operations.js";
import { runOrchestratorStep, PROTECTED_HOSTAWAY_RESERVATION_IDS } from "../../lib/booking-db/reservation-worker.js";
import { runCaptureStep } from "../../lib/booking-db/capture-worker.js";
import { runRecordingStep } from "../../lib/booking-db/recording-worker.js";
import { runCleanupStep } from "../../lib/booking-db/compensation-worker.js";
import { priceStay } from "../../lib/checkout/server-pricer.js";
import { readDirectPolicyFromEnv } from "../../lib/direct-policy.js";
import { todayInTimeZone } from "../../lib/public-api.js";
import { validateAdapterConfig } from "../../lib/hostaway-reservations.js";
import { createPhaseExecutors } from "../../scripts/e7-connected/executor-adapters.mjs";

let netAttempts = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { netAttempts += 1; throw new Error("network refused in the offline adapter rehearsal"); };

let db;
before(async () => { db = await startMigratedDatabase(); });
after(async () => { globalThis.fetch = realFetch; await db.close(); });

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

// ---------------------------------------------------------------------------------------------
// TEST-ONLY persisted-fact reads (schema owner). No accepted runtime API exposes these rows read-only; nothing here writes.
const one = async (sql, p = []) => (await db.owner.query(sql, p)).rows[0];
const all = async (sql, p = []) => (await db.owner.query(sql, p)).rows;
const num = async (sql, p = []) => Number((await db.owner.query(sql, p)).rows[0].n);
const state = async (id) => (await loadIntent(db.app, id)).status;
const opsOf = (id, t) => all("SELECT * FROM booking.external_operations WHERE intent_id = $1 AND op_type = $2 ORDER BY created_at, id", [id, t]);
const guestOf = (id) => one("SELECT first_name, last_name, email FROM booking.intent_guests WHERE intent_id = $1", [id]);
const resEvidence = (id) => all(`SELECT e.*, o.op_type AS read_type FROM booking.provider_evidence e LEFT JOIN booking.external_operations o ON o.id = e.read_operation_id
  WHERE e.intent_id = $1 AND e.kind = 'hostaway_reservation' ORDER BY e.observed_at, e.created_at, e.id`, [id]);
const notifyRows = (id) => all("SELECT state, dispatched_at, attempts FROM booking.external_operations WHERE intent_id = $1 AND op_type = 'guest.notify'", [id]);
const openCases = (id) => all("SELECT kind FROM booking.reconciliation_cases WHERE intent_id = $1 AND status = 'open' ORDER BY kind", [id]);
const eventsOf = async (id) => (await all("SELECT event_type, to_state FROM booking.intent_transitions WHERE intent_id = $1 ORDER BY version_after", [id])).map((r) => `${r.event_type}->${r.to_state}`);
const pathOf = async (id) => (await all("SELECT to_state FROM booking.intent_transitions WHERE intent_id = $1 ORDER BY version_after", [id])).map((r) => r.to_state);
const PROVIDER_WRITE_OPS = ["hostaway.create_reservation", "stripe.capture_payment_intent", "hostaway.record_offline_charge", "stripe.void_payment_intent", "hostaway.cancel_reservation"];
const dispatchedWrites = async (id) => Object.fromEntries(await Promise.all(PROVIDER_WRITE_OPS.map(async (t) =>
  [t, await num("SELECT count(*) AS n FROM booking.external_operations WHERE intent_id = $1 AND op_type = $2 AND dispatched_at IS NOT NULL", [id, t])])));
const W0 = Object.freeze(Object.fromEntries(WRITE_KEYS.map((k) => [k, 0])));

/** persisted facts for the §9.2a check (TEST-ONLY reads) */
async function recoveryFacts(id) {
  const intent = await one("SELECT state, ref, listing_id, hostaway_reservation_id FROM booking.intents WHERE id = $1", [id]);
  return { intent, creates: await opsOf(id, "hostaway.create_reservation"), evidence: await resEvidence(id),
    byIdReads: (await opsOf(id, "hostaway.retrieve_reservation")).filter((o) => ["pending", "in_flight"].includes(o.state)) };
}
/**
 * Manifest §9.2a, implemented TEST-LOCALLY (the adapter module does not do this): the ONE candidate reservation id a reservation-recovery
 * factory may be bound to, from persisted facts only — (a) a SUCCEEDED create's result_ref (the ref-not-echoed path), (b) by-REF lookup
 * evidence found_active with bookingRef = intent ref and matchCount 1, (c) the adopted intent id. More than one distinct candidate, a
 * protected candidate, or an open by-id read naming another id → refusal (no factory, no provider call). Never a raw reply.
 */
function recoveryCandidate(f) {
  if (!["payment_authorized", "reservation_pending", "reservation_unknown"].includes(f.intent.state)) return { ok: false, code: "NOT_RESERVATION_PHASE" };
  const src = [];
  for (const c of f.creates) if (c.state === "succeeded" && typeof c.result_ref === "string" && c.result_ref) src.push(["a", c.result_ref]);
  for (const e of f.evidence) {
    if (e.read_type === "hostaway.lookup_reservation" && e.status === "found_active" && e.observed?.bookingRef === f.intent.ref && e.observed?.matchCount === 1) {
      src.push(["b", String(e.externalRef ?? e.external_ref)]);
    }
  }
  if (f.intent.hostaway_reservation_id) src.push(["c", String(f.intent.hostaway_reservation_id)]);
  const ids = [...new Set(src.map((x) => x[1]))];
  if (ids.length === 0) return { ok: false, code: "NO_CANDIDATE" };
  if (ids.length > 1) return { ok: false, code: "CANDIDATE_CONFLICT" };
  if (PROTECTED.includes(ids[0])) return { ok: false, code: "PROTECTED_CANDIDATE" };
  if (f.byIdReads.some((o) => String(o.payload.reservationId) !== ids[0])) return { ok: false, code: "OPEN_READ_CONFLICT" };
  return { ok: true, id: ids[0], sources: [...new Set(src.map((x) => x[0]))].sort(), adopted: f.intent.hostaway_reservation_id ?? null };
}

/** The workers for one booking; each step gets a FRESH factory built from the persisted facts at that moment (no mutable binding). */
function lane(w, bk, { method = "credit_card" } = {}) {
  const t = transports(w);
  const clk = { t: bk.base + 10 * SEC };
  const adapterConfig = validateAdapterConfig({ allowedListingIds: [bk.listingId], refFieldId: REF_FIELD, channelId: 2000, currency: "USD" });
  const recCfg = { accountRef: LABEL.accountRef, channelId: 2000, currency: "USD", listingId: bk.listingId, paymentMethod: method, refFieldId: REF_FIELD };
  const log = []; const factories = [];
  const rec = (worker, r) => { log.push({ worker, status: r.status, actions: r.actions }); return r; };
  const build = (phase, binding, stripe) => {
    const r = createPhaseExecutors({ phase, binding, hostaway: t.hostaway, ...(stripe ? { stripe: t.stripe } : {}) });
    assert.equal(r.ok, true, `${phase}: ${r.code}`);
    factories.push({ phase, reservationId: binding.reservationId ?? null });
    return r.executors;
  };
  const common = (i) => ({ listingId: i.listingId, arrivalDate: i.from, departureDate: i.to, ref: i.ref });
  const L = {
    clk, log, t, factories, method,
    /** reservation step: creation factory, unless §9.2a yields ONE candidate → reservation-recovery factory bound to it */
    R: async () => {
      const i = await loadIntent(db.app, bk.id); const g = await guestOf(bk.id);
      const cand = recoveryCandidate(await recoveryFacts(bk.id));
      if (!cand.ok && cand.code !== "NO_CANDIDATE" && cand.code !== "NOT_RESERVATION_PHASE") throw new Error(`HARNESS_STOP:${cand.code}`);
      const binding = { ...common(i), guests: i.guests, totalMinor: i.price.finalTotalMinor, currency: i.price.currency, refFieldId: REF_FIELD,
        guest: { firstName: g.first_name, lastName: g.last_name, email: g.email }, reservationId: cand.ok ? cand.id : null };
      L.lastCandidate = cand;
      const executors = build(cand.ok ? "reservation-recovery" : "reservation", binding);
      return rec("reservation", await runOrchestratorStep(db.app, { workerId: "car-res", env: ENV_R, adapterConfig, listings: new Map([[bk.listingId, { currency: "USD" }]]),
        executors, clock: () => clk.t, intentId: bk.id }));
    },
    C: async () => {
      const i = await loadIntent(db.app, bk.id);
      const cap = (await opsOf(bk.id, "stripe.capture_payment_intent")).find((o) => o.state === "pending" || o.state === "in_flight") || (await opsOf(bk.id, "stripe.capture_payment_intent")).at(-1);
      if (!i.reservation || !cap) return rec("capture", { status: "harness-skip", actions: [] });
      const executors = build("capture", { ...common(i), reservationId: String(i.reservation.reservationId), accountId: ACCT, paymentIntentId: i.payment.paymentIntentId,
        amountMinor: i.price.finalTotalMinor, captureIdempotencyKey: cap.payload.providerIdempotencyKey }, true);
      return rec("capture", await runCaptureStep(db.app, { workerId: "car-cap", env: ENV_C, adapterConfig, listings: new Map([[bk.listingId, { currency: "USD" }]]),
        executors, clock: () => clk.t, stripeAccountId: ACCT, intentId: bk.id }));
    },
    W: async () => {
      const i = await loadIntent(db.app, bk.id);
      if (!i.reservation || !i.payment || !(i.payment.capturedMinor > 0)) return rec("recording", { status: "harness-skip", actions: [] });
      const executors = build("recording", { listingId: i.listingId, reservationId: String(i.reservation.reservationId), intentId: i.id, amountMinor: i.payment.capturedMinor,
        paymentMethod: method, accountRef: LABEL.accountRef, clientSnapshotId: LABEL.clientSnapshotId });
      return rec("recording", await runRecordingStep(db.app, { workerId: "car-rec", env: ENV_W, listings: new Map([[bk.listingId, recCfg]]), executors, clock: Date.now, intentId: bk.id }));
    },
    K: async () => {
      const i = await loadIntent(db.app, bk.id);
      const v = (await opsOf(bk.id, "stripe.void_payment_intent")).at(-1);
      if (!v) return rec("compensation", { status: "harness-skip", actions: [] });
      const executors = build("cleanup", { ...common(i), reservationId: i.reservation ? String(i.reservation.reservationId) : null, accountId: ACCT,
        paymentIntentId: i.payment.paymentIntentId, voidIdempotencyKey: v.payload.providerIdempotencyKey }, true);
      return rec("compensation", await runCleanupStep(db.app, { workerId: "car-cln", env: ENV_K, adapterConfig, listings: new Map([[bk.listingId, { currency: "USD", timeZone: TZ }]]),
        executors, clock: () => clk.t, stripeAccountId: ACCT, intentId: bk.id }));
    },
    until: async (k, pred, { max = 10, adv = MIN } = {}) => {
      for (let n = 0; n < max; n++) {
        if (pred(await state(bk.id))) return n;
        await L[k]();
        clk.t = Math.min(clk.t + adv, Date.now() - 5 * SEC);
      }
      assert.fail(`${k}: not reached after ${max} steps (${await state(bk.id)}; ${JSON.stringify(log.slice(-3))})`);
    }
  };
  return L;
}
const writesOf = (w) => ({ ...w.writes });
const noProtected = (w, t) => assert.ok(w.paths.every((p) => !PROTECTED.some((id) => p.includes(id))) && t.h.every((p) => !PROTECTED.some((id) => p.includes(id)))
  && [...w.res.keys()].every((id) => !PROTECTED.includes(String(id))), "no fake request or mock reservation names a protected id");
const idleRound = async (L, w, label) => {
  const n0 = L.t.h.length + L.t.s.length;
  for (const k of ["R", "C", "W", "K"]) { const r = await L[k](); assert.ok(["idle", "harness-skip"].includes(r.status), `${label}: ${k} ${r.status} ${JSON.stringify(r.actions)}`); }
  assert.equal(L.t.h.length + L.t.s.length, n0, `${label}: zero provider requests`);
};

// =============================================================================================

test("A. fresh USD booking: reservation → capture → recording, ALL provider traffic through createPhaseExecutors → fake transports; one write each; notify queued, never executed", async () => {
  const w = world(); const bk = await authorizedBooking(w); const L = lane(w, bk);
  assert.equal(await state(bk.id), "payment_authorized");
  const r1 = await L.R(); assert.ok(r1.actions.includes("RESERVATION_STARTED->reservation_pending"), JSON.stringify(r1.actions));
  assert.ok(L.t.count(/^GET \/v1\/listings\//) >= 2 && L.t.count(/priceDetails/) === 1, "the real pricing wrapper (priceStay via bounded pricing) went through the adapter");
  const r2 = await L.R();
  assert.ok(r2.actions.includes("RESERVATION_SUCCEEDED->reservation_confirmed"), JSON.stringify(r2.actions));
  const rid = String([...w.res.keys()][0]);
  const c1 = await L.C(); assert.ok(c1.actions.includes("CAPTURE_SUCCEEDED->payment_captured"), JSON.stringify(c1.actions));
  const w1 = await L.W(); assert.ok(w1.actions.includes("RECORDED->confirmed"), JSON.stringify(w1.actions));
  // final persisted binding across every handoff
  const fin = await one("SELECT state, offline_charge_id, hostaway_reservation_id, final_total_minor, currency FROM booking.intents WHERE id = $1", [bk.id]);
  assert.deepEqual([fin.state, fin.hostaway_reservation_id, fin.offline_charge_id, Number(fin.final_total_minor), fin.currency], ["confirmed", rid, String(w.charges[0].id), bk.total, "USD"]);
  const cap = (await opsOf(bk.id, "stripe.capture_payment_intent"))[0];
  assert.deepEqual([cap.state, cap.attempts, cap.result_ref, cap.payload.paymentIntentId, cap.payload.amountMinor], ["succeeded", 1, w.pis.get(bk.piId).chargeId, bk.piId, bk.total]);
  const och = (await opsOf(bk.id, "hostaway.record_offline_charge"))[0];
  const ev = await one("SELECT * FROM booking.provider_evidence WHERE id = $1", [och.settled_evidence_id]);
  assert.deepEqual([och.state, och.attempts, och.idempotency_key, ev.observed.reservationId, ev.observed.amountMinor, ev.observed.paymentMethod, ev.observed.executorAccountRef],
    ["succeeded", 1, `och:${bk.id}:1`, rid, bk.total, "credit_card", LABEL.accountRef]);
  const [a] = await all("SELECT * FROM booking.recording_assessments WHERE operation_id = $1 ORDER BY seq", [och.id]);
  const audit = await one("SELECT * FROM booking.recording_claim_assessments WHERE operation_id = $1", [och.id]);
  assert.deepEqual([a.outcome, a.account_ref, a.client_label, audit.assessment_id], ["eligible", LABEL.accountRef, LABEL.clientSnapshotId, a.id], "assessment → claim audit binding");
  // provider writes: world invocations, transport requests and DB dispatches all agree
  assert.deepEqual(writesOf(w), { ...W0, createReservation: 1, capturePaymentIntent: 1, createOfflineCharge: 1 });
  assert.deepEqual([L.t.count(/^POST \/v1\/reservations$/), L.t.count(/^paymentIntents\.capture$/), L.t.count(/^POST \/v1\/guestPayments\/charges\/\d+$/),
    L.t.count(/^paymentIntents\.cancel$/), L.t.count(/^PUT /)], [1, 1, 1, 0, 0], "transport-level write requests");
  assert.deepEqual(await dispatchedWrites(bk.id), { "hostaway.create_reservation": 1, "stripe.capture_payment_intent": 1, "hostaway.record_offline_charge": 1,
    "stripe.void_payment_intent": 0, "hostaway.cancel_reservation": 0 });
  assert.deepEqual((await notifyRows(bk.id)).map((n) => [n.state, n.dispatched_at, n.attempts]), [["pending", null, 0]], "guest.notify queued, never executed");
  assert.deepEqual(L.factories.map((f) => f.phase), ["reservation", "reservation", "capture", "recording"], "one fresh factory per bounded step");
  for (let k = 0; k < 2; k++) await idleRound(L, w, `A/confirmed#${k}`);
  assert.deepEqual(writesOf(w), { ...W0, createReservation: 1, capturePaymentIntent: 1, createOfflineCharge: 1 }, "repeated bounded steps: no second write");
  assert.deepEqual(await openCases(bk.id), []);
  noProtected(w, L.t); assert.equal(netAttempts, 0);
  console.log(`# A ledger: ${(await pathOf(bk.id)).join(" > ")}`);
  console.log(`# A transport requests: ${JSON.stringify([...L.t.h, ...L.t.s])}`);
});

test("B. missing ref echo: create returns the qualifying no-echo shape → accepted worker records result_ref + recovery reads → §9.2a candidate (intent id still NULL) → reservation-recovery factory → by-id read → reservation_confirmed; no second create", async () => {
  const w = world(); w.mode.create = "noEcho"; const bk = await authorizedBooking(w); const L = lane(w, bk);
  await L.R();                                                                   // RESERVATION_STARTED
  const r2 = await L.R();
  assert.ok(r2.actions.includes("CREATE_REF_NOT_ECHOED:READS_REQUIRED"), JSON.stringify(r2.actions));
  const create = (await opsOf(bk.id, "hostaway.create_reservation"))[0];
  const rid = String([...w.res.keys()][0]);
  assert.deepEqual([create.state, create.result_ref, create.attempts], ["succeeded", rid, 1], "the accepted worker persisted the provider id as result_ref");
  const f0 = await recoveryFacts(bk.id);
  assert.equal(f0.intent.state, "reservation_pending"); assert.equal(f0.intent.hostaway_reservation_id, null, "intent id still NULL (candidate, not adopted)");
  const c0 = recoveryCandidate(f0);
  assert.deepEqual([c0.ok, c0.id, c0.sources, c0.adopted], [true, rid, ["a"], null], "§9.2a (a): candidate from the succeeded create's result_ref");
  // negative provenance checks on the SAME persisted facts (test-local validator; the factory is never built → zero provider invocations)
  const n0 = L.t.h.length + L.t.s.length;
  const conflicting = { ...f0, evidence: [...f0.evidence, { read_type: "hostaway.lookup_reservation", status: "found_active", observed: { bookingRef: bk.ref, matchCount: 1 }, externalRef: String(Number(rid) + 1) }] };
  assert.deepEqual({ ...recoveryCandidate(conflicting) }, { ok: false, code: "CANDIDATE_CONFLICT" });
  assert.deepEqual({ ...recoveryCandidate({ ...f0, creates: [{ ...create, result_ref: PROTECTED[0] }] }) }, { ok: false, code: "PROTECTED_CANDIDATE" });
  assert.deepEqual({ ...recoveryCandidate({ ...f0, byIdReads: [{ state: "pending", payload: { reservationId: String(Number(rid) + 1) } }] }) }, { ok: false, code: "OPEN_READ_CONFLICT" });
  assert.equal(createPhaseExecutors({ phase: "reservation-recovery", binding: { listingId: bk.listingId, arrivalDate: bk.stay.from, departureDate: bk.stay.to, ref: bk.ref, guests: 2,
    totalMinor: bk.total, currency: "USD", refFieldId: REF_FIELD, guest: { firstName: "A", lastName: "B", email: "a@b.test" }, reservationId: PROTECTED[1] }, hostaway: L.t.hostaway }).code, "BINDING_INVALID");
  assert.equal(L.t.h.length + L.t.s.length, n0, "negative provenance: zero fake provider invocations");
  // bounded recovery: accepted recovery pass queues lookup then by-id reads; each step gets a fresh recovery factory bound to the candidate
  await L.until("R", (s) => s === "reservation_confirmed", { max: 12 });
  const i = await loadIntent(db.app, bk.id);
  assert.deepEqual([i.status, String(i.reservation.reservationId)], ["reservation_confirmed", rid]);
  const byId = (await opsOf(bk.id, "hostaway.retrieve_reservation"));
  assert.ok(byId.length >= 1 && byId.every((o) => String(o.payload.reservationId) === rid), "every by-id read named the bound candidate");
  assert.ok(byId.some((o) => o.state === "succeeded"), "the by-id read was executed by the accepted worker");
  const evs = await resEvidence(bk.id);
  assert.ok(evs.some((e) => e.read_type === "hostaway.lookup_reservation" && e.status === "found_active" && e.observed.bookingRef === bk.ref), "lookup evidence (by ref)");
  assert.ok(evs.some((e) => e.read_type === "hostaway.retrieve_reservation" && e.status === "found_active" && String(e.externalRef ?? e.external_ref) === rid), "by-id evidence");
  assert.ok(L.factories.some((f) => f.phase === "reservation-recovery" && f.reservationId === rid), "recovery factory used");
  assert.ok(L.factories.every((f) => f.phase === "reservation" ? f.reservationId === null : f.reservationId === rid), "no other id ever bound");
  assert.ok(L.t.count(new RegExp(`^GET /v1/reservations/${rid}$`)) >= 1);
  assert.equal(writesOf(w).createReservation, 1, "no second create"); assert.equal(L.t.count(/^POST \/v1\/reservations$/), 1);
  assert.equal(L.log.flatMap((x) => x.actions).filter((a) => /RECOVERY_MODE_NO_CREATE|RESERVATION_DISPATCHED/.test(a)).length, 1, "only the original dispatch");
  const tail = (await eventsOf(bk.id)).slice(5);
  assert.deepEqual(tail, ["RESERVATION_STARTED->reservation_pending", "RESERVATION_DISPATCHED->reservation_pending", "RECOVER_INTERRUPTED->reservation_unknown",
    "RECONCILED_RESERVATION_FOUND->reservation_confirmed"], "exact accepted transitions: interrupted-reservation recovery, then reconciled by fresh by-ref + by-id proof");
  assert.deepEqual(byId.map((o) => [o.state, o.attempts]), [["succeeded", 1]], "exactly ONE by-id read, executed once");
  assert.deepEqual(await openCases(bk.id), [], "no owner case on the ref-not-echoed path");
  console.log(`# B ledger: ${(await pathOf(bk.id)).join(" > ")}`);
  console.log(`# B events: ${JSON.stringify(await eventsOf(bk.id))}`);
  console.log(`# B reads: ${JSON.stringify((await all("SELECT op_type, state, attempts, idempotency_key FROM booking.external_operations WHERE intent_id = $1 AND retry_class = 'read' ORDER BY created_at, id", [bk.id])))}`);
  console.log(`# B steps: ${JSON.stringify(L.log.map((x) => `${x.worker}:${x.status}:${x.actions.join("|")}`))}`);
  console.log(`# B factories: ${JSON.stringify(L.factories)}; open cases: ${JSON.stringify(await openCases(bk.id))}`);
  noProtected(w, L.t);
});

test("C. ambiguous reservation create (fake APPLIES it, then 503): reservation_unknown, accepted bounded read recovery through rebuilt factories, never a second create", async () => {
  const w = world(); w.mode.create = "appliedThen503"; const bk = await authorizedBooking(w); const L = lane(w, bk);
  await L.R();
  const r2 = await L.R();
  assert.equal(await state(bk.id), "reservation_unknown", JSON.stringify(r2.actions));
  const create = (await opsOf(bk.id, "hostaway.create_reservation"))[0];
  assert.deepEqual([create.state, create.attempts, create.result_ref], ["outcome_unknown", 1, null], "a durable unknown, never a definite failure");
  assert.equal((await recoveryFacts(bk.id)).intent.hostaway_reservation_id, null);
  const cases0 = await openCases(bk.id);
  await L.until("R", (s) => s !== "reservation_unknown", { max: 14 });
  const fin = await state(bk.id);
  const rid = String([...w.res.keys()][0]);
  assert.equal(writesOf(w).createReservation, 1, "the fake applied exactly ONE create"); assert.equal(L.t.count(/^POST \/v1\/reservations$/), 1, "never a second create request");
  assert.equal((await opsOf(bk.id, "hostaway.create_reservation")).length, 1, "no new create row / key");
  const cand = L.factories.filter((f) => f.phase === "reservation-recovery").map((f) => f.reservationId);
  assert.ok(cand.every((x) => x === rid), "recovery factories bound only to the lookup-evidence candidate");
  console.log(`# C final: ${fin}; cases before ${JSON.stringify(cases0)} after ${JSON.stringify(await openCases(bk.id))}`);
  console.log(`# C steps: ${JSON.stringify(L.log.map((x) => `${x.worker}:${x.status}:${x.actions.join("|")}`))}`);
  console.log(`# C ledger: ${(await pathOf(bk.id)).join(" > ")}`);
  console.log(`# C events: ${JSON.stringify(await eventsOf(bk.id))}`);
  console.log(`# C factories: ${JSON.stringify(L.factories)}; candidate: ${JSON.stringify(L.lastCandidate)}`);
  assert.equal(fin, "reservation_confirmed");
  assert.deepEqual((await eventsOf(bk.id)).slice(5), ["RESERVATION_STARTED->reservation_pending", "RESERVATION_DISPATCHED->reservation_pending",
    "RESERVATION_OUTCOME_UNKNOWN->reservation_unknown", "RECONCILED_RESERVATION_FOUND->reservation_confirmed"]);
  assert.deepEqual([(await opsOf(bk.id, "hostaway.create_reservation"))[0].state], ["outcome_unknown"], "the create row stays a durable unknown");
  assert.deepEqual(cases0.map((c) => c.kind), ["HOSTAWAY_CREATE_OUTCOME_UNKNOWN"]);
  assert.deepEqual((await openCases(bk.id)).map((c) => c.kind), ["HOSTAWAY_CREATE_OUTCOME_UNKNOWN"], "the owner case stays OPEN after reconciliation (accepted behaviour)");
  assert.ok(L.lastCandidate.ok && L.lastCandidate.id === rid && L.lastCandidate.sources.includes("b"), "the candidate came from by-ref lookup evidence (the create gave no id)");
  const firstRecovery = L.factories.findIndex((f) => f.phase === "reservation-recovery");
  assert.ok(firstRecovery > 0 && L.factories.slice(0, firstRecovery).every((f) => f.phase === "reservation" && f.reservationId === null), "unbound until lookup evidence named ONE candidate (source b)");
  for (let k = 0; k < 2; k++) { const n0 = writesOf(w).createReservation; await L.R(); L.clk.t = Math.min(L.clk.t + MIN, Date.now() - 5 * SEC); assert.equal(writesOf(w).createReservation, n0); }
  noProtected(w, L.t);
});

test("D. state-specific failure cleanup: reservation_failed (fresh price recheck) → authorization void ONLY → authorization_released; no Hostaway cancel / create", async () => {
  const w = world(); const bk = await authorizedBooking(w); const L = lane(w, bk);
  w.nightly += 25;                                                                 // the fresh recheck sees a changed price
  const r1 = await L.R();
  assert.equal(await state(bk.id), "reservation_failed", JSON.stringify(r1.actions));
  await L.until("K", (s) => s === "authorization_released", { max: 8 });
  assert.deepEqual(writesOf(w), { ...W0, cancelPaymentIntent: 1 }, "void only");
  assert.deepEqual([L.t.count(/^paymentIntents\.cancel$/), L.t.count(/^PUT /), L.t.count(/^POST \/v1\/reservations$/)], [1, 0, 0]);
  assert.ok(L.factories.filter((f) => f.phase === "cleanup").every((f) => f.reservationId === null), "void-only cleanup factory: no reservation bound");
  assert.equal((await opsOf(bk.id, "stripe.void_payment_intent")).filter((o) => o.state === "succeeded").length, 1);
  assert.deepEqual((await notifyRows(bk.id)).map((n) => [n.state, n.dispatched_at]), [["pending", null]], "not-charged notify queued, never executed");
  await idleRound(L, w, "D/released");
  assert.deepEqual(writesOf(w), { ...W0, cancelPaymentIntent: 1 });
  noProtected(w, L.t);
  console.log(`# D ledger: ${(await pathOf(bk.id)).join(" > ")}`);
});

test("whole suite: zero network attempts; the adapter refused nothing the accepted workers legitimately asked for", () => {
  assert.equal(netAttempts, 0);
});
