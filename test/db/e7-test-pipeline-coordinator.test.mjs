// E7 C83 — TEST-ONLY pipeline coordinator over the ACCEPTED workers (reservation E7.2, capture E7.3b, recording E7.4b) on a disposable
// PostgreSQL, with REAL repo / operations / state machine / workers and FAKE provider executors only (no network, no credentials).
// Every booking is on the fixed TEST listing 606998 (disjoint stay windows). Mock provider world shape follows e7-offline-lifecycle.
// Clocks: reservation + capture take an injected clock that starts 20 min BEFORE real time and only advances (never past real time);
// the recording worker uses the real clock (W-5 skew check) — as in the accepted lifecycle rehearsal.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startMigratedDatabase } from "./harness.mjs";
import * as F from "./fixtures.mjs";
import { applyEvent, loadIntent, createIntentRecord, collectGuestDetails, beginPayStep, recordCheckoutSession } from "../../lib/booking-db/repo.js";
import { claimNextOperation, completeOperation } from "../../lib/booking-db/operations.js";
import { priceStay } from "../../lib/checkout/server-pricer.js";
import { readDirectPolicyFromEnv } from "../../lib/direct-policy.js";
import { todayInTimeZone } from "../../lib/public-api.js";
import { validateAdapterConfig } from "../../lib/hostaway-reservations.js";
import { runTestPipelineCoordinator, TEST_LISTING_ID, CoordinatorBudgetError, refundObservationRefusal, _internal as CI } from "../../lib/booking-db/test-pipeline-coordinator.js";
import { adminRecordEvidence } from "../../db/lib/admin.js";

let netAttempts = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { netAttempts += 1; throw new Error("network refused (coordinator suite)"); };

let db;
before(async () => { db = await startMigratedDatabase(); });
after(async () => { globalThis.fetch = realFetch; await db.close(); });

const SEC = 1000; const MIN = 60 * SEC; const DAY = 24 * 60 * MIN;
const ENV = Object.freeze({ VERCEL_ENV: "development", MV_E7_RESERVATION_WORKER: "enabled", MV_E7_CAPTURE_WORKER: "enabled", MV_E7_RECORDING_WORKER: "enabled",
  MV_E7_TEST_PIPELINE_COORDINATOR: "enabled" });
const POLICY = readDirectPolicyFromEnv(ENV).policy;
const ACCT = "acct_1CoordinatorRehearsal";
const LABEL = Object.freeze({ accountRef: "acct-test-1", clientSnapshotId: "client-CO" });
const REF_FIELD = 777009;
const L_ID = TEST_LISTING_ID;
const WRITE_KEYS = ["createReservation", "capturePaymentIntent", "createOfflineCharge"];
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const httpError = (statusCode) => Object.assign(new Error(`provider ${statusCode} (mock)`), { statusCode });

let block = 6100000;
function world({ nightly = 250, echoRef = true } = {}) {
  block += 1000;
  const w = { calls: [], writes: Object.fromEntries(WRITE_KEYS.map((k) => [k, 0])), res: new Map(), pis: new Map(), charges: [],
    nextRes: block, nextCharge: block * 10, mode: { capture: "ok", record: "ok" } };
  const days = (from, to) => { const out = []; for (let d = from; d <= to; d = addDays(d, 1)) out.push({ date: d, status: "available", isAvailable: 1, minimumStay: 1, maximumStay: 90, closedOnArrival: 0, closedOnDeparture: 0 }); return out; };
  const full = (r, withRef = true) => ({ id: r.id, listingMapId: r.listingMapId, channelId: 2000, arrivalDate: r.arrivalDate, departureDate: r.departureDate, totalPrice: r.totalPrice,
    currency: r.currency, status: r.status, ...(withRef ? { customFieldValues: [{ customFieldId: REF_FIELD, value: r.ref }] } : {}) });
  const ridOf = (path) => Number(/\/reservations\/(\d+)/.exec(path)[1]);
  w.piObj = (p) => {
    const cap = p.status === "succeeded";
    return { object: "payment_intent", id: p.id, livemode: false, status: p.status, capture_method: "manual", amount: p.amount,
      amount_received: cap ? p.received : 0, amount_capturable: p.status === "requires_capture" ? p.amount : 0, currency: "usd",
      metadata: { mv_intent_id: p.intentId, mv_payment_attempt_id: p.attemptId },
      latest_charge: { object: "charge", id: p.chargeId, payment_intent: p.id, status: "succeeded", paid: true, captured: cap, amount: p.amount,
        amount_captured: cap ? p.received : 0, amount_refunded: 0, currency: "usd", livemode: false, payment_method_details: { card: { capture_before: p.captureBeforeSec } } } };
  };
  w.pricing = {
    get: async (path, opts = {}) => {
      w.calls.push("pricing.get");
      const m = /^\/listings\/(\d+)(\/calendar)?$/.exec(path); const id = Number(m[1]);
      if (!m[2]) return { status: 200, json: { result: { id, currencyCode: "USD", personCapacity: 4, minNights: 1, maxNights: 90 } } };
      return { status: 200, json: { result: days(opts.query.startDate, opts.query.endDate) } };
    },
    post: async (path, body) => {
      w.calls.push("pricing.post");
      const nights = Math.round((Date.parse(body.endingDate) - Date.parse(body.startingDate)) / DAY);
      const comps = [{ id: 1, type: "accommodation", name: "baseRate", title: "Base rate", quantity: 1, value: nightly, total: nightly * nights, isIncludedInTotalPrice: 1,
        isMandatory: 1, isOverriddenByUser: 0, isDeleted: 0, units: nights }];
      return { status: 200, json: { status: "success", result: { totalPrice: comps[0].total, components: comps } } };
    }
  };
  const h = {
    lookupPage: async (req) => {
      w.calls.push("lookupPage");
      if (req.query.afterId) return { httpStatus: 200, json: { status: "success", result: [] } };
      const items = [...w.res.values()].filter((r) => r.listingMapId === req.query.listingId && r.arrivalDate === req.query.arrivalStartDate).map((r) => full(r));
      return { httpStatus: 200, json: { status: "success", result: items } };
    },
    retrieveReservation: async (req) => {
      w.calls.push("retrieveReservation");
      const r = w.res.get(ridOf(req.path));
      return r ? { httpStatus: 200, json: { status: "success", result: full(r) } } : { httpStatus: 404, json: { status: "fail" } };
    },
    createReservation: async (req) => {
      w.calls.push("createReservation"); w.writes.createReservation += 1;
      const r = { id: w.nextRes++, listingMapId: req.body.listingMapId, arrivalDate: req.body.arrivalDate, departureDate: req.body.departureDate,
        totalPrice: req.body.totalPrice, currency: req.body.currency, status: "new", ref: req.body.customFieldValues[0].value };
      w.res.set(r.id, r);
      return { httpStatus: 201, json: { status: "success", result: full(r, echoRef) } };
    },
    listOfflineCharges: async (req) => {
      w.calls.push("listOfflineCharges");
      const rows = w.charges.filter((c) => String(c.reservationId) === String(req.query.reservationId)).map((c) => ({ ...c }));
      return { httpStatus: 200, json: { status: "success", result: rows, count: rows.length, offset: null } };
    },
    createOfflineCharge: async (req) => {
      w.calls.push("createOfflineCharge"); w.writes.createOfflineCharge += 1;
      const rid = Number(/^\/v1\/guestPayments\/charges\/(\d+)$/.exec(req.path)[1]);
      const ch = { id: w.nextCharge++, listingMapId: w.res.get(rid).listingMapId, reservationId: rid, type: "charge", title: req.body.title, currency: "USD",
        paymentMethod: req.body.paymentMethod, amount: req.body.amount, status: "paid", paymentProvider: "offline" };
      w.charges.push(ch);
      if (w.mode.record === "appliedThen503") return { httpStatus: 503, json: { status: "fail", result: "upstream unavailable (mock)" } };
      return { httpStatus: 201, json: { status: "success", result: { ...ch } } };
    }
  };
  const s = {
    retrieveAccount: async () => { w.calls.push("retrieveAccount"); return { object: "account", id: ACCT }; },
    retrievePaymentIntent: async (id) => { w.calls.push("retrievePaymentIntent"); return w.piObj(w.pis.get(id)); },
    capturePaymentIntent: async (id, params) => {
      w.calls.push("capturePaymentIntent"); w.writes.capturePaymentIntent += 1;
      const p = w.pis.get(id);
      p.status = "succeeded"; p.received = params.amount_to_capture;
      if (w.mode.capture === "500Captured") throw httpError(500);              // APPLIED, reply lost
      return w.piObj(p);
    }
  };
  w.exec = {
    R: { pricing: w.pricing, lookupPage: h.lookupPage, retrieveReservation: h.retrieveReservation, createReservation: h.createReservation },
    C: { retrieveAccount: s.retrieveAccount, retrievePaymentIntent: s.retrievePaymentIntent, capturePaymentIntent: s.capturePaymentIntent,
      retrieveReservation: h.retrieveReservation, lookupPage: h.lookupPage },
    W: { label: LABEL, retrieveReservation: h.retrieveReservation, listOfflineCharges: h.listOfflineCharges, createOfflineCharge: h.createOfflineCharge }
  };
  return w;
}

let lane = 0;
async function authorizedBooking(w, { listingId = L_ID } = {}) {
  lane += 1;
  const stay = { from: addDays("2027-02-01", 6 * lane), to: addDays("2027-02-01", 6 * lane + 3), guests: 2 };
  const base = Date.now() - 20 * MIN;
  const priced = await priceStay({ request: { listingId, ...stay }, listingConfig: { currency: "USD" }, client: w.pricing, policy: POLICY,
    today: todayInTimeZone(undefined, new Date(base)), now: base });
  assert.ok(priced.ok, priced.error);
  w.calls.length = 0;
  const intent = await createIntentRecord(db.app, { ref: F.nextRef(), accessTokenHash: F.tokenHash(), environment: "test", now: base, listingId, ...stay });
  F.ok(await applyEvent(db.app, intent.id, { type: "PRICE_CONFIRMED", price: priced.price }, { now: base, actor: "guest" }));
  F.ok(await collectGuestDetails(db.app, intent.id, F.GUEST, { now: base + SEC, termsVersion: "terms-2026-10" }));
  const b = F.ok(await beginPayStep(db.app, intent.id, { now: base + 2 * SEC }));
  const op = await claimNextOperation(db.app, { workerId: "w-pay", now: base + 2 * SEC, intentId: intent.id, opTypes: ["stripe.create_checkout_session"] });
  const sessionId = `cs_test_co${lane}`;
  F.ok(await completeOperation(db.app, op.id, { workerId: "w-pay", now: base + 2 * SEC, outcome: { status: "succeeded", resultRef: sessionId } }));
  F.ok(await recordCheckoutSession(db.app, intent.id, b.attempt.id, { sessionId, expiresAt: base + 30 * MIN, now: base + 2 * SEC }));
  const piId = `pi_test_co${lane}`;
  const captureBefore = Math.floor((base + 7 * DAY) / 1000) * 1000;
  F.ok(await applyEvent(db.app, intent.id, { type: "PAYMENT_AUTHORIZED", id: `evt_auth_${piId}`, paymentIntentId: piId, sessionId, amountMinor: priced.price.finalTotalMinor,
    currency: "usd", livemode: false, authorizationCreatedAt: base + 3 * SEC, captureBefore }, { now: base + 4 * SEC, actor: "webhook" }));
  const pa = (await db.app.query("SELECT id FROM booking.payment_attempts WHERE intent_id = $1 AND status = 'completed'", [intent.id])).rows[0].id;
  w.pis.set(piId, { id: piId, intentId: intent.id, attemptId: pa, status: "requires_capture", amount: priced.price.finalTotalMinor, received: 0,
    chargeId: `ch_test_co${lane}`, captureBeforeSec: captureBefore / 1000 });
  return { id: intent.id, ref: intent.ref, listingId, stay, piId, total: priced.price.finalTotalMinor, base };
}

function coord(w, bk, extra = {}) {
  const clk = { t: bk.base + 10 * SEC };
  const adapterConfig = validateAdapterConfig({ allowedListingIds: [L_ID], refFieldId: REF_FIELD, channelId: 2000, currency: "USD" });
  const recCfg = { accountRef: LABEL.accountRef, channelId: 2000, currency: "USD", listingId: L_ID, paymentMethod: "credit_card", refFieldId: REF_FIELD };
  const opts = (o = {}) => ({ workerId: "c83-test", env: ENV, binding: { intentId: bk.id, ref: bk.ref }, clock: () => clk.t, recordingClock: Date.now,
    phases: {
      reservation: { adapterConfig, listings: new Map([[L_ID, { currency: "USD" }]]), executors: w.exec.R },
      capture: { adapterConfig, listings: new Map([[L_ID, { currency: "USD" }]]), executors: w.exec.C, stripeAccountId: ACCT },
      recording: { listings: new Map([[L_ID, recCfg]]), executors: w.exec.W }
    }, maxSteps: 8, ...extra, ...o });
  return { clk, run: (o = {}, pool = db.app) => runTestPipelineCoordinator(pool, opts(o)), opts };
}

const one = async (sql, p = []) => (await db.owner.query(sql, p)).rows[0];
const all = async (sql, p = []) => (await db.owner.query(sql, p)).rows;
const num = async (sql, p = []) => Number((await db.owner.query(sql, p)).rows[0].n);
const opsOf = (id, t) => all("SELECT state, attempts, dispatched_at, idempotency_key FROM booking.external_operations WHERE intent_id = $1 AND op_type = $2 ORDER BY created_at, id", [id, t]);
const dispatched = async (id) => Object.fromEntries(await Promise.all(["hostaway.create_reservation", "stripe.capture_payment_intent", "hostaway.record_offline_charge",
  "stripe.void_payment_intent", "hostaway.cancel_reservation"].map(async (t) => [t, await num("SELECT count(*) AS n FROM booking.external_operations WHERE intent_id = $1 AND op_type = $2 AND dispatched_at IS NOT NULL", [id, t])])));
const postAuthEvents = async (id) => (await all(`SELECT event_type FROM booking.intent_transitions WHERE intent_id = $1 AND version_after >
  (SELECT min(version_after) FROM booking.intent_transitions WHERE intent_id = $1 AND to_state = 'payment_authorized') ORDER BY version_after`, [id])).map((r) => r.event_type);
const notifyRows = (id) => all("SELECT state, dispatched_at, attempts FROM booking.external_operations WHERE intent_id = $1 AND op_type = 'guest.notify'", [id]);
const inboxRows = (id) => all("SELECT attempts, processed_at FROM booking.recording_conflict_inbox WHERE intent_id = $1", [id]);
const claimRow = (id) => one("SELECT kind, released_at FROM booking.inventory_claims WHERE intent_id = $1 ORDER BY id DESC LIMIT 1", [id]);
const openCases = (id) => num("SELECT count(*) AS n FROM booking.reconciliation_cases WHERE intent_id = $1 AND status = 'open'", [id]);
/** fingerprint of every booking.* row of one intent (foreign-intent nonaction proof) */
async function fingerprint(id) {
  const tables = (await all(`SELECT table_name FROM information_schema.columns WHERE table_schema = 'booking' AND column_name = 'intent_id' ORDER BY table_name`)).map((r) => r.table_name);
  const out = {};
  for (const t of tables) out[t] = (await all(`SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h, count(*) AS n FROM booking."${t}" x WHERE intent_id = $1`, [id]))[0];
  return out;
}

// ---------------------------------------------------------------------------------------------
test("C1 happy path (ref echoed): ONE coordinator call drives authorized → confirmed through the accepted workers; exactly 1 create / 1 capture / 1 record; one queued notify never dispatched; foreign intent untouched", async () => {
  const w = world(); const bk = await authorizedBooking(w);
  const wf = world(); const foreign = await authorizedBooking(wf);              // a second authorized TEST booking (same listing, other window)
  const fp0 = await fingerprint(foreign.id);
  const c = coord(w, bk);
  const r = await c.run();
  assert.equal(r.outcome, "CONFIRMED", JSON.stringify(r));
  assert.deepEqual(r.writes, { create: 1, capture: 1, record: 1 });
  assert.deepEqual(r.steps.map((s) => [s.phase, s.stateBefore, s.stateAfter]), [
    ["reservation", "payment_authorized", "reservation_pending"], ["reservation", "reservation_pending", "reservation_confirmed"],
    ["capture", "reservation_confirmed", "payment_captured"], ["recording", "payment_captured", "confirmed"]]);
  assert.deepEqual(w.writes, { createReservation: 1, capturePaymentIntent: 1, createOfflineCharge: 1 });
  assert.deepEqual(await dispatched(bk.id), { "hostaway.create_reservation": 1, "stripe.capture_payment_intent": 1, "hostaway.record_offline_charge": 1,
    "stripe.void_payment_intent": 0, "hostaway.cancel_reservation": 0 });
  assert.deepEqual(await postAuthEvents(bk.id), ["RESERVATION_STARTED", "RESERVATION_DISPATCHED", "RESERVATION_SUCCEEDED", "CAPTURE_SUCCEEDED", "OFFLINE_CHARGE_RECORDED"]);
  assert.deepEqual((await opsOf(bk.id, "hostaway.record_offline_charge")).map((o) => [o.state, o.attempts, o.idempotency_key]), [["succeeded", 1, `och:${bk.id}:1`]]);
  assert.deepEqual((await notifyRows(bk.id)).map((n) => [n.state, n.dispatched_at, n.attempts]), [["pending", null, 0]], "ONE guest.notify queued pristine, never executed");
  const inbox = await inboxRows(bk.id);
  assert.ok(inbox.length === 2 && inbox.every((x) => x.attempts === 0 && x.processed_at === null), "conflict-inbox rows enqueued by 0011, never drained");
  const cl = await claimRow(bk.id);
  assert.deepEqual([cl.kind, cl.released_at], ["reserved", null], "inventory claim HELD (reserved, never released; no cleanup)");
  assert.equal(await openCases(bk.id), 0);
  const fin = await one("SELECT state, hostaway_reservation_id, offline_charge_id, listing_id FROM booking.intents WHERE id = $1", [bk.id]);
  assert.deepEqual([fin.state, fin.listing_id, fin.offline_charge_id], ["confirmed", L_ID, String(w.charges[0].id)]);
  // the foreign intent: zero provider calls, every row byte-identical
  assert.deepEqual(wf.calls, []);
  assert.deepEqual(await fingerprint(foreign.id), fp0);
  // a repeat call on the confirmed intent: DONE, zero provider calls, zero writes
  const n0 = w.calls.length;
  const r2 = await c.run();
  assert.deepEqual([r2.outcome, r2.steps.length, r2.writes, w.calls.length], ["CONFIRMED", 0, { create: 0, capture: 0, record: 0 }, n0]);
  assert.equal(netAttempts, 0);
});

test("C2 ref NOT echoed (the observed live case): create once → PENDING until reads are due (no sleep); early calls make ZERO provider calls; the due call reads only (create 0) and completes capture + record", async () => {
  const w = world({ echoRef: false }); const bk = await authorizedBooking(w); const c = coord(w, bk);
  const r1 = await c.run();
  assert.deepEqual([r1.outcome, r1.code, r1.writes], ["PENDING", "NOT_DUE", { create: 1, capture: 0, record: 0 }], JSON.stringify(r1));
  assert.ok(r1.steps.at(-1).actions.includes("CREATE_REF_NOT_ECHOED:READS_REQUIRED"), JSON.stringify(r1.steps));
  assert.ok(r1.nextActionAt >= c.clk.t + 2 * MIN - SEC, "the accepted freshness window (dispatch + 2 min) is reported, not slept");
  assert.deepEqual((await opsOf(bk.id, "hostaway.create_reservation")).map((o) => [o.state, o.attempts]), [["succeeded", 1]]);
  const n0 = w.calls.length;
  const early = await c.run();
  assert.deepEqual([early.outcome, early.code, early.steps.length, w.calls.length], ["PENDING", "NOT_DUE", 0, n0], "not due: no worker step, no provider call");
  c.clk.t = Math.min(r1.nextActionAt + SEC, Date.now() - 5 * SEC);
  const r2 = await c.run();
  assert.equal(r2.outcome, "CONFIRMED", JSON.stringify(r2));
  assert.equal(r2.writes.create, 0, "the continuation never re-creates");
  assert.deepEqual(w.writes, { createReservation: 1, capturePaymentIntent: 1, createOfflineCharge: 1 });
  assert.deepEqual(await dispatched(bk.id), { "hostaway.create_reservation": 1, "stripe.capture_payment_intent": 1, "hostaway.record_offline_charge": 1,
    "stripe.void_payment_intent": 0, "hostaway.cancel_reservation": 0 });
  assert.deepEqual((await notifyRows(bk.id)).map((n) => [n.state, n.dispatched_at]), [["pending", null]]);
});

test("C3 capture ambiguity (applied, reply lost): STOP on capture_unknown after exactly ONE capture; a second call STOPs before any provider call — never a recapture, never a record", async () => {
  const w = world(); w.mode.capture = "500Captured";
  const bk = await authorizedBooking(w); const c = coord(w, bk);
  const r1 = await c.run();
  assert.equal(r1.outcome, "STOP", JSON.stringify(r1));
  assert.deepEqual(r1.writes, { create: 1, capture: 1, record: 0 });
  assert.equal((await loadIntent(db.app, bk.id)).status, "capture_unknown");
  const n0 = w.calls.length;
  const r2 = await c.run();
  assert.deepEqual([r2.outcome, r2.code, r2.steps.length, w.calls.length], ["STOP", "CAPTURE_UNKNOWN", 0, n0]);
  assert.deepEqual(w.writes, { createReservation: 1, capturePaymentIntent: 1, createOfflineCharge: 0 });
  assert.equal((await opsOf(bk.id, "hostaway.record_offline_charge")).length, 0);
  console.log(`# C3 stop codes: ${r1.code} then ${r2.code}`);
});

test("C4 recording ambiguity (applied, 503 reply): STOP after exactly ONE record write; a second call STOPs before any provider call (no second och row, no repair)", async () => {
  const w = world(); w.mode.record = "appliedThen503";
  const bk = await authorizedBooking(w); const c = coord(w, bk);
  const r1 = await c.run();
  assert.equal(r1.outcome, "STOP", JSON.stringify(r1));
  assert.deepEqual(r1.writes, { create: 1, capture: 1, record: 1 });
  assert.notEqual((await loadIntent(db.app, bk.id)).status, "confirmed");
  const n0 = w.calls.length;
  const r2 = await c.run();
  assert.equal(r2.outcome, "STOP", JSON.stringify(r2));
  assert.deepEqual([r2.steps.length, w.calls.length], [0, n0], "no worker step, no provider call");
  assert.deepEqual(w.writes, { createReservation: 1, capturePaymentIntent: 1, createOfflineCharge: 1 });
  assert.equal((await opsOf(bk.id, "hostaway.record_offline_charge")).length, 1, "never a second recording row");
  console.log(`# C4 stop codes: ${r1.code} then ${r2.code}; state ${(await loadIntent(db.app, bk.id)).status}`);
});

test("C5 interruption between phases (abort after the reservation is confirmed): STOP ABORTED with no capture; a later call resumes on persisted facts — totals stay 1 / 1 / 1", async () => {
  const w = world(); const bk = await authorizedBooking(w); const c = coord(w, bk);
  const signal = { aborted: false };
  const r1 = await c.run({ signal, hooks: { afterStep: async (s) => { if (s.stateAfter === "reservation_confirmed") signal.aborted = true; } } });
  assert.deepEqual([r1.outcome, r1.code, r1.writes], ["STOP", "ABORTED", { create: 1, capture: 0, record: 0 }], JSON.stringify(r1));
  assert.equal((await loadIntent(db.app, bk.id)).status, "reservation_confirmed");
  const r2 = await c.run();
  assert.equal(r2.outcome, "CONFIRMED", JSON.stringify(r2));
  assert.deepEqual(r2.writes, { create: 0, capture: 1, record: 1 });
  assert.deepEqual(w.writes, { createReservation: 1, capturePaymentIntent: 1, createOfflineCharge: 1 });
});

test("C6 thrown fault after a step (DB / COMMIT uncertainty stand-in): STOP STEP_THREW and NO further query; a later call resumes on persisted facts without a repeated write", async () => {
  const w = world(); const bk = await authorizedBooking(w); const c = coord(w, bk);
  let queriesAfterThrow = 0; let thrown = false;
  const pool = { query: async (...a) => { if (thrown) queriesAfterThrow += 1; return db.app.query(...a); }, connect: (...a) => db.app.connect(...a) };
  const r1 = await c.run({ hooks: { afterStep: async (s) => { if (s.phase === "capture") { thrown = true; throw Object.assign(new Error("fault"), { code: "TEST_FAULT" }); } } } }, pool);
  assert.deepEqual([r1.outcome, r1.code, r1.readback], ["STOP", "STEP_THREW_TEST_FAULT", null], JSON.stringify(r1));
  assert.equal(queriesAfterThrow, 0, "nothing queried after the fault");
  const r2 = await c.run();
  assert.equal(r2.outcome, "CONFIRMED", JSON.stringify(r2));
  assert.deepEqual(w.writes, { createReservation: 1, capturePaymentIntent: 1, createOfflineCharge: 1 });
});

test("C7 foreign lease / open case / pristineness: a work lease held by another worker → STOP WORK_LEASED; zero provider calls", async () => {
  const w = world(); const bk = await authorizedBooking(w); const c = coord(w, bk);
  await db.owner.query("UPDATE booking.intent_work SET work_worker_id = 'someone-else', work_lease_until = now() + interval '10 minutes', next_action_at = now() - interval '1 minute' WHERE intent_id = $1", [bk.id]);
  const r = await c.run();
  assert.deepEqual([r.outcome, r.code, r.steps.length, w.calls.length], ["STOP", "WORK_LEASED", 0, 0]);
  assert.deepEqual(await dispatched(bk.id), { "hostaway.create_reservation": 0, "stripe.capture_payment_intent": 0, "hostaway.record_offline_charge": 0,
    "stripe.void_payment_intent": 0, "hostaway.cancel_reservation": 0 });
});

test("C8 refusals before any I/O-bearing step: production / not enabled / non-TEST listing map / wrong binding ref / intent on another listing", async () => {
  const w = world(); const bk = await authorizedBooking(w); const c = coord(w, bk);
  assert.equal((await c.run({ env: { ...ENV, VERCEL_ENV: "production" } })).code, "PRODUCTION_REFUSED");
  assert.equal((await c.run({ env: { ...ENV, MV_E7_TEST_PIPELINE_COORDINATOR: "off" } })).code, "NOT_ENABLED");
  const o = c.opts();
  assert.equal((await runTestPipelineCoordinator(db.app, { ...o, phases: { ...o.phases, capture: { ...o.phases.capture, listings: new Map([[603566, { currency: "USD" }]]) } } })).code, "LISTING_NOT_TEST_FIXED");
  assert.equal((await c.run({ binding: { intentId: bk.id, ref: "MV-NOTTHIS1" } })).code, "BINDING_REF_MISMATCH");
  const wo = world(); const other = await authorizedBooking(wo, { listingId: 871999 });
  assert.equal((await coord(wo, other).run()).code, "LISTING_NOT_TEST_FIXED");
  assert.equal((await c.run({ maxSteps: 99 })).code, "MAX_STEPS_INVALID");
  assert.deepEqual([w.calls.length, wo.calls.length], [0, 0], "no provider call on any refusal");
  assert.equal((await loadIntent(db.app, bk.id)).status, "payment_authorized");
});

test("C9 unit: the in-invocation write guard refuses a second write BEFORE the provider; continuability rules", async () => {
  let calls = 0; const counter = { createReservation: 0 };
  const ex = CI.guardExecutors({ createReservation: async () => { calls += 1; return "ok"; } }, "createReservation", counter);
  assert.equal(await ex.createReservation(), "ok");
  await assert.rejects(ex.createReservation(), (e) => e instanceof CoordinatorBudgetError);
  assert.equal(calls, 1);
  const f = (o) => ({ create: [], capture: [], record: [], ...o });
  const pend = { state: "pending", attempts: 0, dispatched_at: null };
  assert.equal(CI.continuable("reservation", { status: "payment_authorized" }, f({ create: [pend] })), "CREATE_ALREADY_RECORDED");
  assert.equal(CI.continuable("reservation", { status: "reservation_pending" }, f({ create: [{ state: "succeeded", attempts: 1, dispatched_at: new Date() }] })), null);
  assert.equal(CI.continuable("reservation", { status: "reservation_pending" }, f({ create: [{ state: "outcome_unknown", attempts: 1, dispatched_at: new Date() }] })), "CREATE_NOT_CONTINUABLE_OUTCOME_UNKNOWN");
  assert.equal(CI.continuable("capture", { status: "reservation_confirmed" }, f({ capture: [{ state: "succeeded", attempts: 1, dispatched_at: new Date() }] })), "CAPTURE_NOT_PRISTINE");
  assert.equal(CI.continuable("recording", { id: "x", status: "payment_captured" }, f({ record: [{ ...pend, idempotency_key: "och:x:2" }] })), "RECORDING_NOT_PRISTINE");
});

// ---------------------------------------------------------------------------------------------
// C86 (ROOT #128 review 5912316868) — F1 stored refund veto, F2 attempted-write accounting, F3 per-write abort / deadline guards.
const refundObs = async (bk, observed) => { const r = await adminRecordEvidence(db.reconciler, { intentId: bk.id, kind: "payment_intent", externalRef: bk.piId, status: "succeeded",
  observed: { amountMinor: bk.total, currency: "USD", amountReceivedMinor: bk.total, amountCapturableMinor: 0, captured: true, ...observed },
  observedAt: new Date(), attestedBy: "owner", reference: "ROOT synthetic dashboard refund observation" }); return F.ok(r); };

test("F1a (ROOT repro) a stored refund observation after capture → STOP PAYMENT_REFUND_OBSERVED before the recording worker: record 0", async () => {
  const w = world(); const bk = await authorizedBooking(w); const c = coord(w, bk);
  const r = await c.run({ hooks: { afterStep: async (s) => { if (s.phase === "capture") await refundObs(bk, { refunded: true, amountRefundedMinor: bk.total }); } } });
  assert.deepEqual([r.outcome, r.code, r.writes], ["STOP", "PAYMENT_REFUND_OBSERVED", { create: 1, capture: 1, record: 0 }], JSON.stringify(r));
  assert.equal(w.writes.createOfflineCharge, 0);
  assert.equal(r.steps.filter((s) => s.phase === "recording").length, 0, "the recording worker never ran (no lock / claim / provider)");
  assert.deepEqual((await opsOf(bk.id, "hostaway.record_offline_charge")).map((o) => [o.state, o.dispatched_at]), [["pending", null]]);
  const n0 = w.calls.length; const r2 = await c.run();
  assert.deepEqual([r2.outcome, r2.code, w.calls.length], ["STOP", "PAYMENT_REFUND_OBSERVED", n0], "monotonic: a rerun refuses again with zero calls");
});

test("F1b veto semantics: newer zero cannot erase a positive; malformed present → INVALID; absent → unknown (no veto); other PIs ignored", async () => {
  const pi = "pi_x"; const row = (o, ref = pi) => ({ kind: "payment_intent", external_ref: ref, observed: o });
  assert.equal(refundObservationRefusal([row({ amountRefundedMinor: 500 }), row({ amountRefundedMinor: 0, refunded: false })], pi), "PAYMENT_REFUND_OBSERVED");
  assert.equal(refundObservationRefusal([row({ refunded: "yes" })], pi), "PAYMENT_REFUND_EVIDENCE_INVALID");
  for (const bad of [null, "10", -1, 1.5, Number.NaN]) assert.equal(refundObservationRefusal([row({ amountRefundedMinor: bad })], pi), "PAYMENT_REFUND_EVIDENCE_INVALID", String(bad));
  assert.equal(refundObservationRefusal([row({ amountRefundedMinor: 0, refunded: false }), row({ captured: true })], pi), null);
  assert.equal(refundObservationRefusal([row({ refunded: true }, "pi_other"), { kind: "hostaway_reservation", external_ref: pi, observed: { refunded: true } }], pi), null);
  assert.equal(refundObservationRefusal([row({ refunded: "x" }), row({ amountRefundedMinor: 1 })], pi), "PAYMENT_REFUND_OBSERVED", "positive wins over malformed");
  // DB: a malformed stored observation before capture refuses the capture stage
  const w = world(); const bk = await authorizedBooking(w); const c = coord(w, bk);
  const r = await c.run({ hooks: { afterStep: async (s) => { if (s.stateAfter === "reservation_confirmed") await refundObs(bk, { amountRefundedMinor: "0" }); } } });
  assert.deepEqual([r.outcome, r.code, r.writes], ["STOP", "PAYMENT_REFUND_EVIDENCE_INVALID", { create: 1, capture: 0, record: 0 }]);
});

test("F1c an observation stored BETWEEN recording admission and the record send refuses the send (re-read at the write)", async () => {
  const w = world(); const bk = await authorizedBooking(w);
  const list = w.exec.W.listOfflineCharges; let injected = false;
  w.exec.W.listOfflineCharges = async (req) => { const r = await list(req); if (!injected) { injected = true; await refundObs(bk, { amountRefundedMinor: 1 }); } return r; };
  const r = await coord(w, bk).run();
  assert.deepEqual([r.outcome, r.code, r.writes.record, w.writes.createOfflineCharge], ["STOP", "PAYMENT_REFUND_OBSERVED", 0, 0], JSON.stringify(r));
  assert.notEqual((await loadIntent(db.app, bk.id)).status, "confirmed");
});

/** pool wrapper: every query (pool + checked-out clients) throws ROOT_DB_FAULT once `fault.on` is set; release forwarded */
function faultPool(fault) {
  const boom = () => Object.assign(new Error("synthetic"), { code: "ROOT_DB_FAULT" });
  return {
    query: async (...a) => { if (fault.on) { fault.after += 1; throw boom(); } return db.app.query(...a); },
    connect: async () => {
      const cl = await db.app.connect();
      return { query: async (...a) => { if (fault.on) { fault.after += 1; throw boom(); } return cl.query(...a); }, release: (...a) => cl.release(...a) };
    }
  };
}
for (const [label, phase, key, wkey] of [["create", "R", "createReservation", "create"], ["capture", "C", "capturePaymentIntent", "capture"], ["record", "W", "createOfflineCharge", "record"]]) {
  test(`F2 ${label}: provider APPLIED then every DB / COMMIT statement fails → STOP STEP_THREW_ROOT_DB_FAULT reports ${wkey}=1 (zero never implies unsent)`, async () => {
    const w = world(); const bk = await authorizedBooking(w);
    const fault = { on: false, after: 0 };
    const orig = w.exec[phase][key];
    w.exec[phase][key] = async (...a) => { const r = await orig(...a); fault.on = true; return r; };
    const r = await coord(w, bk).run({}, faultPool(fault));
    assert.equal(r.code, "STEP_THREW_ROOT_DB_FAULT", JSON.stringify(r));
    assert.equal(r.writes[wkey], 1);
    assert.equal(w.writes[key], 1);
    assert.equal(r.readback, null, "no readback after the fault");
  });
}

/** F3 harness: trigger (abort | deadline) inside the READ that precedes each write; the guard must refuse that write */
const PRE_WRITE_READ = { R: "lookupPage", C: "retrievePaymentIntent", W: "listOfflineCharges" };
for (const mode of ["abort", "deadline"]) {
  for (const [label, phase, key, wkey] of [["create", "R", "createReservation", "create"], ["capture", "C", "capturePaymentIntent", "capture"], ["record", "W", "createOfflineCharge", "record"]]) {
    test(`F3 ${mode} triggered during the read before the ${label}: the ${label} is NEVER sent, STOP, no next financial stage`, async () => {
      const w = world(); const bk = await authorizedBooking(w);
      const signal = { aborted: false }; const skew = { ms: 0 };
      const now = () => Date.now() + skew.ms; const deadlineAt = Date.now() + 10 * MIN;
      const rk = PRE_WRITE_READ[phase]; const read = w.exec[phase][rk];
      let armed = true;
      w.exec[phase][rk] = async (...a) => { const r = await read(...a); if (armed) { armed = false; if (mode === "abort") signal.aborted = true; else skew.ms = 20 * MIN; } return r; };
      const r = await coord(w, bk).run(mode === "abort" ? { signal } : { deadlineAt, now });
      // the recording worker also receives the signal and has its own pre-send stop: either guard refusing the write is correct
      const codes = mode === "abort" ? (phase === "W" ? ["ABORTED_AT_WRITE", "WORKER_STOP_SIGNAL"] : ["ABORTED_AT_WRITE"]) : ["DEADLINE_AT_WRITE"];
      assert.equal(r.outcome, "STOP", JSON.stringify(r)); assert.ok(codes.includes(r.code), JSON.stringify(r));
      assert.equal(r.writes[wkey], 0); assert.equal(w.writes[key], 0, "the provider write never happened");
      const later = { create: ["capturePaymentIntent", "createOfflineCharge"], capture: ["createOfflineCharge"], record: [] }[label];
      for (const k of later) assert.equal(w.writes[k], 0, `no ${k} after the guard`);
    });
  }
}

// ---------------------------------------------------------------------------------------------
// C88 (ROOT review 5912351880): abort / deadline / budget re-checked AFTER the awaited veto re-read, immediately before the send.
/** pool wrapper: after the SECOND provider_evidence veto read (the capture's at-write re-read) returns its rows, run `flip()` */
function vetoFlipPool(flip) {
  let n = 0;
  return { query: async (sql, ...a) => {
    const r = await db.app.query(sql, ...a);
    if (typeof sql === "string" && sql.startsWith("SELECT kind, external_ref, observed FROM booking.provider_evidence") && ++n === 2) flip();
    return r;
  }, connect: (...a) => db.app.connect(...a) };
}
test("C88a (ROOT repro) abort flipped while the at-write veto re-read is in flight → the capture is NEVER sent", async () => {
  const w = world(); const bk = await authorizedBooking(w); const signal = { aborted: false };
  const r = await coord(w, bk).run({ signal }, vetoFlipPool(() => { signal.aborted = true; }));
  assert.deepEqual([r.outcome, r.code, r.writes.capture, w.writes.capturePaymentIntent], ["STOP", "ABORTED_AT_WRITE", 0, 0], JSON.stringify(r));
  assert.equal(w.writes.createOfflineCharge, 0);
});
test("C88b (ROOT repro) the deadline reached while the at-write veto re-read is in flight → the capture is NEVER sent", async () => {
  const w = world(); const bk = await authorizedBooking(w);
  const deadlineAt = Date.now() + 10 * MIN; const t = { skew: 0 }; const now = () => Date.now() + t.skew;
  const r = await coord(w, bk).run({ deadlineAt, now }, vetoFlipPool(() => { t.skew = deadlineAt - Date.now(); }));
  assert.deepEqual([r.outcome, r.code, r.writes.capture, w.writes.capturePaymentIntent], ["STOP", "DEADLINE_AT_WRITE", 0, 0], JSON.stringify(r));
});
test("C88c unit: TWO simultaneous guarded capture calls with an async veto → the provider is called exactly ONCE", async () => {
  let calls = 0; const counter = { capturePaymentIntent: 0 };
  const ex = CI.guardExecutors({ capturePaymentIntent: async () => { calls += 1; return "ok"; } }, "capturePaymentIntent", counter, { veto: async () => null });
  const rs = await Promise.allSettled([ex.capturePaymentIntent(), ex.capturePaymentIntent()]);
  assert.deepEqual([calls, counter.capturePaymentIntent, rs.filter((x) => x.status === "fulfilled").length], [1, 1, 1]);
  assert.ok(rs.some((x) => x.status === "rejected" && x.reason instanceof CoordinatorBudgetError));
});

// ---------------------------------------------------------------------------------------------
// C139: coordinator-level scope fence — every phase config fixed to 606998 / USD (incl. the adapter allowlists and the recording config's
// listing) and the persisted scope (exactly one 'test' marker row, intent environment 'test', price currency USD) checked BEFORE any worker
// step. Each mismatch is REFUSED with zero provider calls and every intent row byte-identical; the supported TEST path is unchanged.
function poolRewritingC139(base, rewrite) {
  const wrapQ = (q) => async (sql, p) => { const r = await q(sql, p); return rewrite(String(sql), r) || r; };
  return { query: wrapQ((s, p) => base.query(s, p)), connect: async () => {
    const c = await base.connect();
    return new Proxy(c, { get(t, k) { if (k === "query") return wrapQ((s, p) => t.query(s, p)); const v = t[k]; return typeof v === "function" ? v.bind(t) : v; } });
  } };
}

test("C139a config scope: listing currency / recording listing / adapter allowlist or currency not 606998 / USD -> REFUSED, zero provider calls, rows unchanged", async () => {
  const w = world(); const bk = await authorizedBooking(w); const c = coord(w, bk);
  const fp0 = await fingerprint(bk.id);
  const o = c.opts();
  const withPhase = (p, patch) => ({ ...o, phases: { ...o.phases, [p]: { ...o.phases[p], ...patch } } });
  const mxn = (p) => new Map([[L_ID, { ...o.phases[p].listings.get(L_ID), currency: "MXN" }]]);
  const ac = o.phases.reservation.adapterConfig;
  for (const [label, opts, code] of [
    ["reservation listing MXN", withPhase("reservation", { listings: mxn("reservation") }), "CURRENCY_NOT_TEST_FIXED"],
    ["capture listing MXN", withPhase("capture", { listings: mxn("capture") }), "CURRENCY_NOT_TEST_FIXED"],
    ["recording listing MXN", withPhase("recording", { listings: mxn("recording") }), "CURRENCY_NOT_TEST_FIXED"],
    ["recording config listingId other", withPhase("recording", { listings: new Map([[L_ID, { ...o.phases.recording.listings.get(L_ID), listingId: 603566 }]]) }), "LISTING_NOT_TEST_FIXED"],
    ["reservation adapter wider allowlist", withPhase("reservation", { adapterConfig: { ...ac, allowedListingIds: [L_ID, 603566] } }), "ADAPTER_CONFIG_NOT_TEST_FIXED"],
    ["capture adapter other listing", withPhase("capture", { adapterConfig: { ...ac, allowedListingIds: [603566] } }), "ADAPTER_CONFIG_NOT_TEST_FIXED"],
    ["capture adapter MXN", withPhase("capture", { adapterConfig: { ...ac, currency: "MXN" } }), "ADAPTER_CONFIG_NOT_TEST_FIXED"],
    ["reservation adapter missing", withPhase("reservation", { adapterConfig: undefined }), "ADAPTER_CONFIG_NOT_TEST_FIXED"]
  ]) {
    const r = await runTestPipelineCoordinator(db.app, opts);
    assert.deepEqual([r.outcome, r.code], ["REFUSED", code], label);
  }
  assert.equal(w.calls.length, 0, "no provider call on any refusal");
  assert.deepEqual(await fingerprint(bk.id), fp0, "every intent row byte-identical");
  assert.equal((await loadIntent(db.app, bk.id)).status, "payment_authorized");
});

test("C139b persisted scope: live / missing / duplicated marker, intent environment live, intent currency MXN -> REFUSED before any worker step; then the ordinary TEST run once, idempotent", async () => {
  const w = world(); const bk = await authorizedBooking(w); const c = coord(w, bk);
  const fp0 = await fingerprint(bk.id);
  const INST = "SELECT environment FROM booking.instance";
  const live = (r) => ({ ...r, rows: r.rows.map((x) => ({ ...x, environment: "live" })) });
  for (const [label, rw, code] of [
    ["marker live", (sql, r) => (sql === INST ? live(r) : null), "DATABASE_NOT_TEST"],
    ["marker missing", (sql, r) => (sql === INST ? { ...r, rows: [] } : null), "DATABASE_NOT_TEST"],
    ["marker duplicated", (sql, r) => (sql === INST ? { ...r, rows: [...r.rows, ...r.rows] } : null), "DATABASE_NOT_TEST"],
    ["intent environment live", (sql, r) => (sql === "SELECT environment FROM booking.intents WHERE id = $1" ? live(r) : null), "INTENT_ENVIRONMENT_NOT_TEST"],
    ["intent currency MXN", (sql, r) => (/^SELECT \*, from_date::text AS from_date_s/.test(sql) ? { ...r, rows: r.rows.map((x) => ({ ...x, price_snapshot: { ...x.price_snapshot, currency: "MXN" } })) } : null), "CURRENCY_NOT_TEST_FIXED"]
  ]) {
    const r = await c.run({}, poolRewritingC139(db.app, rw));
    assert.deepEqual([r.outcome, r.code, r.steps?.length ?? 0], ["REFUSED", code, 0], label);
    assert.deepEqual(r.writes, { create: 0, capture: 0, record: 0 }, label);
  }
  // a REAL marker change (owner), restored
  try {
    await db.owner.query("UPDATE booking.instance SET environment = 'live'");
    assert.equal((await c.run()).code, "DATABASE_NOT_TEST");
  } finally { await db.owner.query("UPDATE booking.instance SET environment = 'test'"); }
  assert.equal((await db.owner.query(INST)).rows.map((x) => x.environment).join(), "test", "marker restored");
  assert.equal(w.calls.length, 0, "no provider call on any refusal");
  assert.deepEqual(await fingerprint(bk.id), fp0, "every intent row byte-identical");
  // the supported 606998 / USD TEST path: unchanged, exactly 1 / 1 / 1, then idempotent
  const ok = await c.run();
  assert.equal(ok.outcome, "CONFIRMED", JSON.stringify(ok));
  assert.deepEqual([ok.writes, w.writes], [{ create: 1, capture: 1, record: 1 }, { createReservation: 1, capturePaymentIntent: 1, createOfflineCharge: 1 }]);
  const n0 = w.calls.length;
  const again = await c.run();
  assert.deepEqual([again.outcome, again.steps.length, again.writes, w.calls.length], ["CONFIRMED", 0, { create: 0, capture: 0, record: 0 }, n0]);
});
