// Stage E7 guest notification — STAGE 2 OFFLINE / INJECTED-MOCK notification step against DISPOSABLE local PostgreSQL clusters.
// Contract: claude/e7-guest-notification-contract.md revision 3 as amended by §15.9; Stage 1 fence 0016 accepted at 35097c56.
// Repository code and the notification worker run as the runtime login test_app (∈ mv_booking_app); owner evidence through test_admin;
// the schema owner (postgres) only for digests, lock observation and explicitly labelled TEST SETUP (fixtures.ownerManagedHistory).
//
// TRUST / SHAPE LABELS
//   * Every provider object is a SYNTHETIC, DOC-DERIVED, LIVE-UNVERIFIED mock (the accepted lifecycle-rehearsal world, copied test-locally
//     from test/db/e7-guest-notification-fence.test.mjs). The ONLY "send" is the injected in-memory sink below: it records frozen synthetic
//     requests in memory and never prints them. `mock-` ids / `.invalid` addresses are restrictions / correlation, not proof of a mock.
//   * Guest rows use synthetic `.invalid` addresses (out-of-scope rows use a synthetic `.example` address that is never sent). Assertions on
//     request content compare booleans so a failure never prints a recipient, name, subject or body. USD only.
//   * Positive chains are built ONLY with the accepted workers / repo functions. TEST SETUP with triggers bypassed is used ONLY to shorten a
//     lease for the lease-room cases (labelled at the call).
//   * Protected ids 70636076 / 71045356 / 71072615 / 71081885 appear only as fixture references; the worker must give them zero writes.
//   * The accepted lifecycle rehearsal (test/db/e7-offline-lifecycle.test.mjs) is NOT touched: its notify rows stay queued.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { startMigratedDatabase } from "./harness.mjs";
import * as F from "./fixtures.mjs";
import { applyEvent, loadIntent, createIntentRecord, collectGuestDetails, beginPayStep, recordCheckoutSession, purgeGuestData } from "../../lib/booking-db/repo.js";
import { claimNextOperation, completeOperation, requestRead, recordProviderEvidence } from "../../lib/booking-db/operations.js";
import { runOrchestratorStep } from "../../lib/booking-db/reservation-worker.js";
import { runCaptureStep } from "../../lib/booking-db/capture-worker.js";
import { runRecordingStep } from "../../lib/booking-db/recording-worker.js";
import { runCleanupStep } from "../../lib/booking-db/compensation-worker.js";
import { runNotificationStep, NOTIFICATION_LIMITS } from "../../lib/booking-db/notification-worker.js";
import { contentHash, recipientHash } from "../../lib/checkout/guest-notification.js";
import { priceStay } from "../../lib/checkout/server-pricer.js";
import { readDirectPolicyFromEnv } from "../../lib/direct-policy.js";
import { todayInTimeZone } from "../../lib/public-api.js";
import { validateAdapterConfig } from "../../lib/hostaway-reservations.js";

let netAttempts = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { netAttempts += 1; throw new Error("network refused (offline Stage 2 suite)"); };

let db;
before(async () => { db = await startMigratedDatabase(); });
after(async () => { globalThis.fetch = realFetch; await db.close(); });

const SEC = 1000; const MIN = 60 * SEC; const DAY = 24 * 60 * MIN;
const ENV_R = Object.freeze({ VERCEL_ENV: "development", MV_E7_RESERVATION_WORKER: "enabled" });
const ENV_C = Object.freeze({ VERCEL_ENV: "development", MV_E7_CAPTURE_WORKER: "enabled" });
const ENV_W = Object.freeze({ VERCEL_ENV: "development", MV_E7_RECORDING_WORKER: "enabled" });
const ENV_K = Object.freeze({ VERCEL_ENV: "development", MV_E7_COMPENSATION_WORKER: "enabled" });
const ENV_N = Object.freeze({ VERCEL_ENV: "development", MV_E7_NOTIFICATION_WORKER: "enabled" });
const POLICY = readDirectPolicyFromEnv(ENV_R).policy;
const ACCT = "acct_1GuestNotifyWorker";
const LABEL = Object.freeze({ accountRef: "acct-test-1", clientSnapshotId: "client-GNW" });
const REF_FIELD = 777016;
const TZ = "America/Mazatlan";
const PROTECTED = ["70636076", "71045356", "71072615", "71081885"];
const SENDER = Object.freeze({ fromAddress: "bookings@sender.mv-test.invalid", fromName: "maraVilla Test" });   // explicit synthetic sender
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------
// accepted-worker chain helpers: copied test-locally from test/db/e7-guest-notification-fence.test.mjs (world / authorizedBooking / lane)
let block = 6100000;
function world({ nightly = 250 } = {}) {
  block += 1000;
  const w = { nightly, calls: [], paths: [], writes: { createReservation: 0, capturePaymentIntent: 0, createOfflineCharge: 0, cancelPaymentIntent: 0, cancelReservation: 0 },
    res: new Map(), pis: new Map(), charges: [], nextRes: block, nextCharge: block * 10 };
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
  w.pricing = {
    get: async (path, opts = {}) => {
      const m = /^\/listings\/(\d+)(\/calendar)?$/.exec(path); const id = Number(m[1]);
      if (!m[2]) return { status: 200, json: { result: { id, currencyCode: "USD", personCapacity: 4, minNights: 1, maxNights: 90 } } };
      return { status: 200, json: { result: days(opts.query.startDate, opts.query.endDate) } };
    },
    post: async (path, body) => {
      const nights = Math.round((Date.parse(body.endingDate) - Date.parse(body.startingDate)) / DAY);
      const comps = [{ id: 1, type: "accommodation", name: "baseRate", title: "Base rate", quantity: 1, value: w.nightly, total: w.nightly * nights, isIncludedInTotalPrice: 1,
        isMandatory: 1, isOverriddenByUser: 0, isDeleted: 0, units: nights }];
      return { status: 200, json: { status: "success", result: { totalPrice: comps[0].total, components: comps } } };
    }
  };
  const hostaway = {
    lookupPage: async (req) => {
      if (req.query.afterId) return { httpStatus: 200, json: { status: "success", result: [] } };
      const items = [...w.res.values()].filter((r) => r.listingMapId === req.query.listingId && r.arrivalDate === req.query.arrivalStartDate).map(full);
      return { httpStatus: 200, json: { status: "success", result: items } };
    },
    retrieveReservation: async (req) => {
      const r = w.res.get(ridOf(req.path));
      return r ? { httpStatus: 200, json: { status: "success", result: full(r) } } : { httpStatus: 404, json: { status: "fail" } };
    },
    createReservation: async (req) => {
      w.writes.createReservation += 1;
      const r = { id: w.nextRes++, listingMapId: req.body.listingMapId, arrivalDate: req.body.arrivalDate, departureDate: req.body.departureDate,
        totalPrice: req.body.totalPrice, currency: req.body.currency, status: "new", ref: req.body.customFieldValues[0].value };
      w.res.set(r.id, r);
      return { httpStatus: 201, json: { status: "success", result: full(r) } };
    },
    cancelReservation: async (req) => {
      w.writes.cancelReservation += 1;
      const r = w.res.get(ridOf(req.path)); r.status = "cancelled";
      return { httpStatus: 200, json: { status: "success", result: full(r) } };
    },
    listOfflineCharges: async (req) => {
      const rows = w.charges.filter((c) => String(c.reservationId) === String(req.query.reservationId)).map((c) => ({ ...c }));
      return { httpStatus: 200, json: { status: "success", result: rows, count: rows.length, offset: null } };
    },
    createOfflineCharge: async (req) => {
      w.writes.createOfflineCharge += 1;
      const rid = Number(/^\/v1\/guestPayments\/charges\/(\d+)$/.exec(req.path)[1]);
      const ch = { id: w.nextCharge++, listingMapId: w.res.get(rid).listingMapId, reservationId: rid, type: "charge", title: req.body.title, currency: "USD",
        paymentMethod: req.body.paymentMethod, amount: req.body.amount, status: "paid", paymentProvider: "offline" };
      w.charges.push(ch);
      return { httpStatus: 201, json: { status: "success", result: { ...ch } } };
    }
  };
  const stripe = {
    retrieveAccount: async () => ({ object: "account", id: ACCT }),
    retrievePaymentIntent: async (id) => w.piObj(w.pis.get(id)),
    capturePaymentIntent: async (id, params) => { w.writes.capturePaymentIntent += 1; const p = w.pis.get(id); p.status = "succeeded"; p.received = params.amount_to_capture; return w.piObj(p); },
    cancelPaymentIntent: async (id) => { w.writes.cancelPaymentIntent += 1; const p = w.pis.get(id); p.status = "canceled"; return w.piObj(p); }
  };
  w.exec = {
    R: { pricing: w.pricing, lookupPage: hostaway.lookupPage, retrieveReservation: hostaway.retrieveReservation, createReservation: hostaway.createReservation },
    C: { retrieveAccount: stripe.retrieveAccount, retrievePaymentIntent: stripe.retrievePaymentIntent, capturePaymentIntent: stripe.capturePaymentIntent,
      retrieveReservation: hostaway.retrieveReservation, lookupPage: hostaway.lookupPage },
    W: { label: LABEL, retrieveReservation: hostaway.retrieveReservation, listOfflineCharges: hostaway.listOfflineCharges, createOfflineCharge: hostaway.createOfflineCharge },
    K: { retrieveAccount: stripe.retrieveAccount, retrievePaymentIntent: stripe.retrievePaymentIntent, cancelPaymentIntent: stripe.cancelPaymentIntent,
      retrieveReservation: hostaway.retrieveReservation, lookupPage: hostaway.lookupPage, cancelReservation: hostaway.cancelReservation }
  };
  return w;
}

let laneN = 0;
async function authorizedBooking(w, { guestDomain = "mv-test.invalid", listingId: fixedListing = null } = {}) {
  laneN += 1;
  const listingId = fixedListing ?? 891000 + laneN;
  const stay = { from: addDays("2026-12-01", 3 * laneN), to: addDays("2026-12-01", 3 * laneN + 2), guests: 2 };
  const base = Date.now() - 20 * MIN;
  const priced = await priceStay({ request: { listingId, ...stay }, listingConfig: { currency: "USD" }, client: w.pricing, policy: POLICY,
    today: todayInTimeZone(undefined, new Date(base)), now: base });
  assert.ok(priced.ok, priced.error);
  const intent = await createIntentRecord(db.app, { ref: F.nextRef(), accessTokenHash: F.tokenHash(), environment: "test", now: base, listingId, ...stay });
  F.ok(await applyEvent(db.app, intent.id, { type: "PRICE_CONFIRMED", price: priced.price }, { now: base, actor: "guest" }));
  const guest = { firstName: "Synthia", lastName: "Fixture", email: `guest.n${laneN}@${guestDomain}` };   // SYNTHETIC; never logged
  F.ok(await collectGuestDetails(db.app, intent.id, guest, { now: base + SEC, termsVersion: "terms-2026-10" }));
  const b = F.ok(await beginPayStep(db.app, intent.id, { now: base + 2 * SEC }));
  const op = await claimNextOperation(db.app, { workerId: "w-pay", now: base + 2 * SEC, intentId: intent.id, opTypes: ["stripe.create_checkout_session"] });
  const sessionId = `cs_test_gn${laneN}`;
  F.ok(await completeOperation(db.app, op.id, { workerId: "w-pay", now: base + 2 * SEC, outcome: { status: "succeeded", resultRef: sessionId } }));
  F.ok(await recordCheckoutSession(db.app, intent.id, b.attempt.id, { sessionId, expiresAt: base + 30 * MIN, now: base + 2 * SEC }));
  const piId = `pi_test_gn${laneN}`;
  const captureBefore = Math.floor((base + 7 * DAY) / 1000) * 1000;
  F.ok(await applyEvent(db.app, intent.id, { type: "PAYMENT_AUTHORIZED", id: `evt_auth_${piId}`, paymentIntentId: piId, sessionId, amountMinor: priced.price.finalTotalMinor,
    currency: "usd", livemode: false, authorizationCreatedAt: base + 3 * SEC, captureBefore }, { now: base + 4 * SEC, actor: "webhook" }));
  const pa = (await db.app.query("SELECT id FROM booking.payment_attempts WHERE intent_id = $1 AND status = 'completed'", [intent.id])).rows[0].id;
  w.pis.set(piId, { id: piId, intentId: intent.id, attemptId: pa, status: "requires_capture", amount: priced.price.finalTotalMinor, received: 0,
    chargeId: `ch_test_gn${laneN}`, captureBeforeSec: captureBefore / 1000 });
  return { id: intent.id, ref: intent.ref, listingId, stay, piId, total: priced.price.finalTotalMinor, base };
}

function lane(w, bk) {
  const clk = { t: bk.base + 10 * SEC };
  const adapterConfig = validateAdapterConfig({ allowedListingIds: [bk.listingId], refFieldId: REF_FIELD, channelId: 2000, currency: "USD" });
  const recCfg = { accountRef: LABEL.accountRef, channelId: 2000, currency: "USD", listingId: bk.listingId, paymentMethod: "credit_card", refFieldId: REF_FIELD };
  const L = {
    clk,
    R: () => runOrchestratorStep(db.app, { workerId: "gn-res", env: ENV_R, adapterConfig, listings: new Map([[bk.listingId, { currency: "USD" }]]),
      executors: w.exec.R, clock: () => clk.t, intentId: bk.id }),
    C: () => runCaptureStep(db.app, { workerId: "gn-cap", env: ENV_C, adapterConfig, listings: new Map([[bk.listingId, { currency: "USD" }]]),
      executors: w.exec.C, clock: () => clk.t, stripeAccountId: ACCT, intentId: bk.id }),
    W: () => runRecordingStep(db.app, { workerId: "gn-rec", env: ENV_W, listings: new Map([[bk.listingId, recCfg]]), executors: w.exec.W, clock: Date.now, intentId: bk.id }),
    K: () => runCleanupStep(db.app, { workerId: "gn-cln", env: ENV_K, adapterConfig, listings: new Map([[bk.listingId, { currency: "USD", timeZone: TZ }]]),
      executors: w.exec.K, clock: () => clk.t, stripeAccountId: ACCT, intentId: bk.id }),
    until: async (k, pred, { max = 10, adv = MIN } = {}) => {
      for (let n = 0; n < max; n++) {
        if (pred(await state(bk.id))) return;
        const r = await L[k]();
        if (r && r.late) await Promise.race([r.late, sleep(200)]);
        clk.t = Math.min(clk.t + adv, Date.now() - 5 * SEC);
      }
      assert.fail(`${k}: not reached (${await state(bk.id)})`);
    }
  };
  return L;
}

const state = async (id) => (await loadIntent(db.app, id)).status;
const one = async (sql, p = []) => (await db.owner.query(sql, p)).rows[0];
const all = async (sql, p = []) => (await db.owner.query(sql, p)).rows;
const num = async (sql, p = []) => Number((await db.owner.query(sql, p)).rows[0].n);
const notifyOf = async (intentId) => one("SELECT * FROM booking.external_operations WHERE intent_id = $1 AND op_type = 'guest.notify'", [intentId]);
const app1 = async (sql, p = []) => (await db.app.query(sql, p)).rows[0];

/** confirmed via R → C → W (accepted workers). */
async function confirmedBooking(opts) {
  const w = world(); const bk = await authorizedBooking(w, opts); const L = lane(w, bk);
  await L.until("R", (s) => s === "reservation_confirmed");
  await L.until("C", (s) => s === "payment_captured");
  await L.W();
  assert.equal(await state(bk.id), "confirmed");
  return { ...bk, w, L, op: await notifyOf(bk.id) };
}
/** authorization_released via a definite pre-capture failure (price changed) → void (accepted workers). */
async function releasedBooking(opts) {
  const w = world(); const bk = await authorizedBooking(w, opts); const L = lane(w, bk);
  w.nightly += 25;
  await L.R();
  assert.equal(await state(bk.id), "reservation_failed");
  await L.until("K", (s) => s === "authorization_released");
  return { ...bk, w, L, op: await notifyOf(bk.id) };
}
/** cancelled from capture_failed (definite, capture never dispatched — "P" history) → void + host-cancel (accepted workers). */
async function cancelledBooking(opts) {
  const w = world(); const bk = await authorizedBooking(w, opts); const L = lane(w, bk);
  await L.until("R", (s) => s === "reservation_confirmed");
  F.ok(await applyEvent(db.app, bk.id, { type: "CAPTURE_FAILED", definite: true, code: "CARD_DECLINED" }, { now: L.clk.t, actor: "worker" }));
  assert.equal(await state(bk.id), "capture_failed");
  await L.until("K", (s) => s === "cancelled");
  return { ...bk, w, L, op: await notifyOf(bk.id) };
}


// 0016 API reads as the runtime role / schema owner (copied test-locally)
const recover = (listingIds, intentId, limit = 10) => app1("SELECT booking.recover_expired_notifications($1, $2, $3) AS r", [listingIds, intentId, limit]).then((x) => x.r);
const klass = (op) => one("SELECT booking.guest_notification_class($1) AS r", [op]).then((x) => x.r);
/** owner-side digests: notification rows / audit unchanged */
const digest = async (bk) => (await one(`SELECT md5(coalesce((SELECT row_to_json(o)::text FROM booking.external_operations o WHERE o.id = $1), '')
   || coalesce((SELECT row_to_json(r)::text FROM booking.notification_renders r WHERE r.operation_id = $1), '')
   || coalesce((SELECT row_to_json(l)::text FROM booking.notification_latches l WHERE l.operation_id = $1), '')
   || coalesce((SELECT string_agg(row_to_json(c)::text, '|' ORDER BY c.id) FROM booking.reconciliation_cases c WHERE c.intent_id = $2), '')
   || coalesce((SELECT row_to_json(w)::text FROM booking.intent_work w WHERE w.intent_id = $2), '')) AS d`, [bk.op.id, bk.id])).d;
/** dashboard (owner-attested) evidence through the admin login */
const dashboard = (intentId, kind, ref, status, observed, observedAtMs) => db.reconciler.query(
  "SELECT booking.admin_record_evidence($1, $2, $3, $4, $5, $6, 'owner', 'gn-fixture-check') AS id", [intentId, kind, String(ref), status, observed, new Date(observedAtMs)])
  .then((r) => r.rows[0].id);
/** API evidence through an executed read (accepted repo path) */
async function apiEvidence(intentId, kind, ref, status, observed, nowMs) {
  const opType = { payment_intent: "stripe.retrieve_payment_intent", hostaway_reservation: "hostaway.retrieve_reservation" }[kind];
  await requestRead(db.app, intentId, opType, String(ref), { now: nowMs });
  const op = await claimNextOperation(db.app, { workerId: "gn-read", now: nowMs, intentId, opTypes: [opType] });
  F.ok(await completeOperation(db.app, op.id, { workerId: "gn-read", now: nowMs, outcome: { status: "succeeded", resultRef: String(ref) } }));
  return F.ok(await recordProviderEvidence(db.app, { readOpId: op.id, kind, externalRef: String(ref), status, observed, providerRequestId: `req_${op.id.slice(0, 8)}` })).id;
}

// ---------------------------------------------------------------------------------------------
// notification step harness: in-memory sink (never printed), counted / fault-injectable pool wrapper, digests

/** the injected executor: records the frozen synthetic request IN MEMORY; replies per `reply` */
function sink(reply = (n) => ({ accepted: true, providerMessageId: `mock-gnw-${n}` })) {
  const s = { invocations: 0, requests: [], events: [] };
  s.sendMessage = (req, ctx) => { s.invocations += 1; s.requests.push(req); s.events.push(s.lastEvent?.()); return reply(s.invocations, ctx, req); };
  return s;
}
/** wraps the runtime pool: ordered statement-kind log (no values) + optional fault per statement kind */
function wrapPool(base, fault = {}) {
  const log = [];
  const kindOf = (sql) => (/FROM booking\.instance/.test(sql) ? "marker" : /clock_timestamp\(\) AS t/.test(sql) ? "clock"
    : (/booking\.([a-z_]+)\(/.exec(sql)?.[1] ?? sql.split(" ")[0]));
  const run = async (via, sql, params, exec) => {
    const k = kindOf(sql); log.push(`${via}:${k}`);
    const f = fault[k];
    if (f) return f({ exec, n: log.filter((x) => x.endsWith(`:${k}`)).length, params });
    return exec();
  };
  return {
    log,
    query: (sql, params) => run("pool", sql, params, () => base.query(sql, params)),
    connect: async () => {
      const c = await base.connect(); log.push("connect");
      return { query: (sql, params) => run("tx", sql, params, () => c.query(sql, params)), release: (d) => { log.push(d ? "dispose" : "release"); c.release(d); } };
    }
  };
}
const gnOpts = (bk, snk, over = {}) => ({ env: ENV_N, workerId: "gnw-1", listingIds: [bk.listingId], intentId: bk.id, sender: { ...SENDER },
  executors: { sendMessage: snk.sendMessage, label: "mock-sink" }, clock: Date.now, ...over });
const step = (bk, snk, over = {}, pool = db.app) => runNotificationStep(pool, gnOpts(bk, snk, over));
const PII_FREE = (r, bk) => { const j = JSON.stringify(r); assert.ok(!/@|Synthia|Bea|Hello|maraVilla booking/.test(j), "result carries no contact / content"); return r; };
const renderOf = (opId) => one("SELECT * FROM booking.notification_renders WHERE operation_id = $1", [opId]);
const casesOf = (intentId) => num("SELECT count(*) AS n FROM booking.reconciliation_cases WHERE intent_id = $1 AND kind = 'NOTIFICATION_OUTCOME_UNKNOWN'", [intentId]);
const webhookWaiting = (bk) => db.app.query(`INSERT INTO booking.stripe_webhook_events (event_id, event_type, livemode, stripe_created_at, intent_id, received_at, status)
                      VALUES ($1, 'charge.updated', false, now(), $2, now(), 'received')`, [`evt_gnw_${bk.id.replace(/-/g, "")}`, bk.id]);
const openCase = (bk) => db.app.query("INSERT INTO booking.reconciliation_cases (id, intent_id, kind, status, opened_at, opened_by) VALUES (gen_random_uuid(), $1, 'SOME_OWNER_CASE', 'open', now(), 'test')", [bk.id]);
/** the bound guest row's request matches it exactly (booleans only — never prints values) */
async function requestBound(bk, req) {
  const g = await one("SELECT email, first_name FROM booking.intent_guests WHERE intent_id = $1", [bk.id]);
  return req.to === g.email && req.text.startsWith(`Hello ${g.first_name},`) && req.from === SENDER.fromAddress && req.messageRef === `gn1-${bk.op.id}`;
}
const pending = [];          // rows left claimed / leased for the single real-expiry test at the end

// =============================================================================================

test("accepted-worker chains, ALL 3 templates: one step → mock-accepted; render hash = the invoked request; repeated steps / maintenance never resend", async () => {
  for (const [mk, tpl] of [[confirmedBooking, "booking_confirmed"], [releasedBooking, "not_charged_authorization_may_show"], [cancelledBooking, "not_completed_not_charged"]]) {
    const bk = await mk(); const snk = sink();
    assert.equal(await klass(bk.op.id), "ELIGIBLE");
    const r = PII_FREE(await step(bk, snk));
    assert.deepEqual([r.ok, r.outcome, r.sends, r.template, r.release], [true, "accepted", 1, tpl, "RELEASED"], tpl);
    assert.equal(snk.invocations, 1, `${tpl}: actual invocation count`);
    const req = snk.requests[0];
    assert.ok(Object.isFrozen(req) && req.template === tpl && req.templateVersion === "gn-v1", `${tpl}: request shape`);
    assert.ok(await requestBound(bk, req), `${tpl}: bound guest recipient / sender / messageRef`);
    if (tpl === "booking_confirmed") assert.ok(req.text.includes(`$${(bk.total / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })} USD`), "USD amount");
    else assert.ok(req.text.includes("not charged") && !req.text.includes("$"), "not-charged copy");
    const rd = await renderOf(bk.op.id);
    assert.equal(rd.content_hash, contentHash(req), `${tpl}: the claimed content hash is exactly the invoked request's`);
    assert.equal(r.contentHashPrefix, rd.content_hash.slice(0, 8));
    const op = await notifyOf(bk.id);
    assert.deepEqual([op.state, op.attempts, op.result_ref, op.lease_worker_id, op.error_code], ["succeeded", 1, "mock-gnw-1", null, null]);
    assert.equal((await one("SELECT work_worker_id FROM booking.intent_work WHERE intent_id = $1", [bk.id])).work_worker_id, null, "work released");
    const d = await digest(bk);
    for (let k = 0; k < 3; k++) assert.equal((await step(bk, snk, { workerId: `gnw-r${k}` })).outcome, "idle");
    assert.deepEqual(await recover([bk.listingId], null, 10), { processed: 0, skippedLocked: 0, skippedProtected: 0 });
    assert.equal(snk.invocations, 1, `${tpl}: sends 1 total`);
    assert.equal(await num("SELECT count(*) AS n FROM booking.notification_renders WHERE operation_id = $1", [bk.op.id]), 1, "one claim / audit");
    assert.equal(await digest(bk), d, "repeated steps: no write");
  }
  assert.equal(netAttempts, 0);
});

test("pre-send no-await boundary + observation wrapper on the real database: fresh connection, RR READ ONLY, ONE SELECT, COMMIT; send right after", async () => {
  const bk = await confirmedBooking(); const snk = sink();
  const pool = wrapPool(db.app);
  snk.lastEvent = () => pool.log.at(-1);
  const r = await step(bk, snk, {}, pool);
  assert.equal(r.outcome, "accepted");
  assert.deepEqual(pool.log, ["pool:marker", "pool:clock", "pool:recover_expired_notifications", "pool:claim_notification_work",
    "connect", "tx:BEGIN", "tx:guest_notification_snapshot", "tx:COMMIT", "release", "pool:claim_guest_notification",
    "connect", "tx:BEGIN", "tx:guest_notification_presend", "tx:COMMIT", "release", "pool:complete_guest_notification", "pool:release_notification_work"]);
  assert.deepEqual(snk.events, ["release"], "nothing between the pre-send COMMIT / connection release and the one invocation");
});

test("drift between the initial observation and the claim: open case latches (SQL code), purge / reinsert is SNAPSHOT_STALE then sends ONCE to the new row, protection → zero writes", async () => {
  // open case → the dedicated claim latches with the exact SQL code; later steps never touch it
  const a = await confirmedBooking(); const sa = sink();
  const ra = await step(a, sa, { hooks: { afterInitialObservation: async () => { await openCase(a); } } });
  assert.deepEqual([ra.outcome, ra.code, ra.sends], ["latched", "OPEN_CASE", 0]);
  const da = await digest(a);
  for (let k = 0; k < 2; k++) assert.equal((await step(a, sa)).outcome, "idle");
  assert.equal(await digest(a), da); assert.equal(sa.invocations, 0);
  // purge / reinsert of the guest row between snapshot and claim → SNAPSHOT_STALE (never a claim for a stale recipient)
  const b = await releasedBooking(); await F.ageIntent(db.owner, b.id, 400); const sb = sink();
  const rb = await step(b, sb, { hooks: { afterInitialObservation: async () => {
    await purgeGuestData(db.app, { retention: { failedAttemptDays: 30, postCheckoutDays: 30 } });
    await db.app.query(`INSERT INTO booking.intent_guests (intent_id, first_name, last_name, email, terms_version, terms_accepted_at, created_at)
                        VALUES ($1, 'Bea', 'Fixture', $2, 'terms-2026-10', now(), now())`, [b.id, `guest.reinsert.w${laneN}@mv-test.invalid`]);
  } } });
  assert.deepEqual([rb.outcome, rb.code, rb.sends, rb.release], ["not_claimable", "SNAPSHOT_STALE", 0, "RELEASED"]);
  assert.equal(await renderOf(b.op.id), undefined);
  const rb2 = await step(b, sb);
  assert.equal(rb2.outcome, "accepted"); assert.equal(sb.invocations, 1);
  assert.ok(await requestBound(b, sb.requests[0]), "sent once, to the CURRENT bound guest row");
  // protection committed between snapshot and claim → claim 'protected': zero writes, work lease left to expire
  const c = await confirmedBooking(); const sc = sink();
  let dc = null;
  const rc = await step(c, sc, { hooks: { afterInitialObservation: async () => { await dashboard(c.id, "hostaway_reservation", PROTECTED[0], "not_found", {}, Date.now()); dc = await digest(c); } } });
  assert.deepEqual([rc.outcome, rc.sends], ["protected", 0]);
  assert.equal(await digest(c), dc, "protected: no claim, latch, render or release");
});

test("drift between the claim and the pre-send: API / historical evidence contradiction, open case, state → PRESEND_ABORTED_NOT_INVOKED (zero sends); protection → zero writes", async () => {
  const lateAuth = (bk) => applyEvent(db.app, bk.id, { type: "PAYMENT_AUTHORIZED", id: `evt_gnw_late_${bk.id}`, paymentIntentId: `pi_test_late_${bk.id.slice(0, 8)}`,
    sessionId: "cs_test_gnw_late", amountMinor: bk.total, currency: "usd", livemode: false, authorizationCreatedAt: Date.now(), captureBefore: Date.now() + DAY },
  { now: Date.now(), actor: "webhook" });
  const cases = [
    ["api evidence", releasedBooking, (bk) => apiEvidence(bk.id, "payment_intent", bk.piId, "succeeded", { proofVersion: "pi-proof-v3", amountReceivedMinor: bk.total, currency: "USD" }, Date.now())],
    ["historical dashboard evidence", releasedBooking, (bk) => dashboard(bk.id, "payment_intent", bk.piId, "succeeded", {}, bk.base)],
    ["confirmed: api evidence", confirmedBooking, (bk) => apiEvidence(bk.id, "payment_intent", bk.piId, "succeeded", { proofVersion: "pi-proof-v3", amountReceivedMinor: bk.total + 1, currency: "USD" }, Date.now())],
    ["open case", cancelledBooking, (bk) => openCase(bk)],
    ["state", releasedBooking, (bk) => lateAuth(bk)]];
  for (const [kind, mk, drift] of cases) {
    const bk = await mk(); const snk = sink();
    const r = PII_FREE(await step(bk, snk, { hooks: { afterClaim: async () => { await drift(bk); } } }));
    assert.deepEqual([r.outcome, r.code, r.sends, snk.invocations], ["unknown", "PRESEND_ABORTED_NOT_INVOKED", 0, 0], `${kind} (${r.abort})`);
    const op = await notifyOf(bk.id);
    assert.deepEqual([op.state, op.error_code, op.attempts], ["outcome_unknown", "PRESEND_ABORTED_NOT_INVOKED", 1], kind);
    assert.equal(await casesOf(bk.id), 1);
    assert.equal((await step(bk, snk)).outcome, "idle", `${kind}: never re-claimed`); assert.equal(snk.invocations, 0);
  }
  // protection after the claim → pre-send PROTECTED → zero additional writes / release; leases expire (counted at the end)
  const p = await confirmedBooking(); const sp = sink(); let dp = null;
  const rp = await step(p, sp, { hooks: { afterClaim: async () => { await apiEvidence(p.id, "hostaway_reservation", PROTECTED[1], "not_found", {}, Date.now()); dp = await digest(p); } } });
  assert.deepEqual([rp.outcome, rp.sends, sp.invocations], ["protected", 0, 0]);
  assert.equal(await digest(p), dp, "row digests unchanged");
  pending.push({ bk: p, snk: sp, dp, kind: "protected-after-claim" });
});

test("protection after the invocation, before completion: settlement PROTECTED → zero further writes; release not attempted", async () => {
  const bk = await releasedBooking(); const snk = sink(); let d = null;
  const pool = wrapPool(db.app);
  const r = await step(bk, snk, { hooks: { afterSend: async () => { await dashboard(bk.id, "hostaway_reservation", PROTECTED[2], "not_found", {}, Date.now()); d = await digest(bk); } } }, pool);
  assert.deepEqual([r.outcome, r.sends, snk.invocations], ["protected", 1, 1]);
  assert.equal(pool.log.at(-1), "pool:complete_guest_notification", "no release after a protected settlement");
  assert.equal(await digest(bk), d);
  pending.push({ bk, snk, dp: d, kind: "protected-after-send" });
});

test("SQL permanent latches, WAITING, out-of-scope and protected rows: zero action, never starve an available row in the same scope", async () => {
  const LST = 899700; const scope = { listingIds: [LST], intentId: null };
  const latched = await releasedBooking({ listingId: LST }); await dashboard(latched.id, "payment_intent", latched.piId, "succeeded", {}, latched.base);  // historical contradiction
  const waiting = await releasedBooking({ listingId: LST }); await webhookWaiting(waiting);
  const out = await releasedBooking({ listingId: LST, guestDomain: "mv-test.example" });                                                  // synthetic, never sent
  const prot = await releasedBooking({ listingId: LST }); await dashboard(prot.id, "hostaway_reservation", PROTECTED[3], "not_found", {}, Date.now());
  const free = await releasedBooking({ listingId: LST });
  assert.deepEqual(await Promise.all([latched, waiting, out, prot, free].map((x) => klass(x.op.id))), ["ELIGIBLE", "WAITING", "OUT_OF_V1_SCOPE", "PROTECTED", "ELIGIBLE"]);
  const snk = sink();
  // step 1: the oldest ELIGIBLE row (latched-to-be) → SQL latch RELEASE_NOT_PROVEN; step 2: the free row is sent
  const r1 = await step(latched, snk, scope);
  assert.deepEqual([r1.outcome, r1.code, r1.opId], ["latched", "RELEASE_NOT_PROVEN", latched.op.id]);
  const ds = await Promise.all([latched, waiting, out, prot].map((x) => digest(x)));
  const r2 = await step(free, snk, scope);
  assert.deepEqual([r2.outcome, r2.opId, snk.invocations], ["accepted", free.op.id, 1]);
  for (let k = 0; k < 3; k++) assert.equal((await step(free, snk, scope)).outcome, "idle");
  assert.deepEqual(await Promise.all([latched, waiting, out, prot].map((x) => digest(x))), ds, "latched / waiting / out-of-scope / protected byte-unchanged");
  assert.equal(snk.invocations, 1);
  // the waiting row becomes eligible once its webhook is processed (non-latching) and is then sent once
  await db.app.query("UPDATE booking.stripe_webhook_events SET status = 'processed', processed_at = now() WHERE intent_id = $1", [waiting.id]);
  assert.equal((await step(waiting, snk, scope)).outcome, "accepted");
  assert.equal(snk.invocations, 2);
  assert.ok(!snk.requests.some((q) => q.to.endsWith(".example")), "the out-of-scope recipient is never sent");
});

test("overlapping scopes / workers in parallel: each eligible row is invoked exactly once", async () => {
  const L1 = 899801; const L2 = 899802;
  const rows = [await confirmedBooking({ listingId: L1 }), await releasedBooking({ listingId: L2 }), await releasedBooking({ listingId: L1 }), await cancelledBooking({ listingId: L2 })];
  const snk = sink();
  const W = (id, ids) => runNotificationStep(db.app, { env: ENV_N, workerId: id, listingIds: ids, sender: { ...SENDER }, executors: { sendMessage: snk.sendMessage, label: "mock-sink" }, clock: Date.now });
  const outcomes = [];
  for (let round = 0; round < 4; round++) {
    const rs = await Promise.all([W("gnw-a", [L1, L2]), W("gnw-b", [L2, L1]), W("gnw-c", [L2]), W("gnw-d", [L1])]);
    outcomes.push(...rs.map((r) => r.outcome));
  }
  assert.equal(snk.invocations, 4, `4 rows → 4 invocations (${outcomes.join(",")})`);
  assert.equal(new Set(snk.requests.map((q) => q.messageRef)).size, 4, "each row once");
  for (const x of rows) assert.equal((await notifyOf(x.id)).state, "succeeded");
  assert.ok(outcomes.every((o) => ["accepted", "idle", "not_claimable"].includes(o)), outcomes.join(","));
});

test("insufficient / expired leases and slow observation / COMMIT / clock regression → abort before invocation (zero sends)", async () => {
  const run = async (mk, over, pool) => {
    const bk = await mk(); const snk = sink();
    const r = await step(bk, snk, over, pool);
    assert.equal(snk.invocations, 0); assert.equal(r.sends, 0);
    return { r, bk };
  };
  // TEST SETUP (triggers bypassed): the work lease shortened to 12 s right after the claim → LEASE_ROOM
  let x = await run(confirmedBooking, { hooks: { afterClaim: async (op) => {
    await F.ownerManagedHistory(db.owner, "UPDATE booking.intent_work w SET work_lease_until = clock_timestamp() + interval '12 seconds' FROM booking.external_operations o WHERE o.id = $1 AND w.intent_id = o.intent_id", [op]);
  } } });
  assert.deepEqual([x.r.outcome, x.r.abort, (await notifyOf(x.bk.id)).error_code], ["unknown", "LEASE_ROOM", "PRESEND_ABORTED_NOT_INVOKED"]);
  // TEST SETUP: the op lease shortened to 12 s → LEASE_ROOM
  x = await run(releasedBooking, { hooks: { afterClaim: async (op) => {
    await F.ownerManagedHistory(db.owner, "UPDATE booking.external_operations SET lease_until = clock_timestamp() + interval '12 seconds' WHERE id = $1", [op]);
  } } });
  assert.deepEqual([x.r.outcome, x.r.abort], ["unknown", "LEASE_ROOM"]);
  // TEST SETUP: the work lease already expired → the SQL pre-send says LEASE_NOT_HELD → safe unknown, not invoked
  x = await run(cancelledBooking, { hooks: { afterClaim: async (op) => {
    await F.ownerManagedHistory(db.owner, "UPDATE booking.intent_work w SET work_lease_until = clock_timestamp() - interval '1 second' FROM booking.external_operations o WHERE o.id = $1 AND w.intent_id = o.intent_id", [op]);
  } } });
  assert.deepEqual([x.r.outcome, x.r.abort, x.r.code], ["unknown", "LEASE_NOT_HELD", "PRESEND_ABORTED_NOT_INVOKED"]);
  // slow RR observation (inside the read-only transaction) → OBSERVATION_SLOW even though the DB's dbNow is late
  x = await run(confirmedBooking, { hooks: { inObservation: async (k) => { if (k === "presend") await sleep(NOTIFICATION_LIMITS.observationBudgetMs + 200); } } });
  assert.deepEqual([x.r.outcome, x.r.abort], ["unknown", "OBSERVATION_SLOW"]);
  // slow COMMIT of the pre-send observation → OBSERVATION_SLOW
  const slow = wrapPool(db.app, { COMMIT: async ({ exec, n }) => { const v = await exec(); if (n === 2) await sleep(NOTIFICATION_LIMITS.observationBudgetMs + 200); return v; } });
  x = await run(releasedBooking, {}, slow);
  assert.deepEqual([x.r.outcome, x.r.abort], ["unknown", "OBSERVATION_SLOW"]);
  // injected wall clock regresses 3 s after the skew probe → CLOCK_SKEW at the final check
  let calls = 0;
  x = await run(confirmedBooking, { clock: () => { calls += 1; return calls <= 2 ? Date.now() : Date.now() - 3000; } });
  assert.deepEqual([x.r.outcome, x.r.abort], ["unknown", "CLOCK_SKEW"]);
  // a skewed clock from the start refuses before any notification query
  const bk = await confirmedBooking(); const snk = sink(); const p = wrapPool(db.app);
  assert.equal((await step(bk, snk, { clock: () => Date.now() + 5000 }, p)).code, "CLOCK_SKEW");
  assert.deepEqual(p.log, ["pool:marker", "pool:clock"]);
  assert.equal((await notifyOf(bk.id)).state, "pending");
});

test("executor faults: applied-but-reply-lost (throw / reject), non-exact reply, timeout with late reply → code-only unknown, ONE invocation, never resent", async () => {
  const faults = [["throw", () => { throw new Error("synthetic executor failure"); }, "SEND_THREW"],
    ["applied then rejected", (n, ctx, req) => Promise.reject(new Error("reply lost after apply")), "SEND_THREW"],
    ["non-exact accepted", () => ({ accepted: true, providerMessageId: "mock-x", status: "delivered" }), "REPLY_SHAPE"],
    ["non-mock id", () => ({ accepted: true, providerMessageId: "msg_live_1" }), "REPLY_SHAPE"]];
  for (const [kind, reply, code] of faults) {
    const bk = await releasedBooking(); const snk = sink(reply);
    const r = PII_FREE(await step(bk, snk));
    assert.deepEqual([r.outcome, r.code, r.sends, snk.invocations], ["unknown", code, 1, 1], kind);
    const op = await notifyOf(bk.id);
    assert.deepEqual([op.state, op.error_code, op.result_ref], ["outcome_unknown", code, null], kind);
    assert.equal(await casesOf(bk.id), 1);
    for (let k = 0; k < 2; k++) assert.equal((await step(bk, snk)).outcome, "idle");
    assert.equal(snk.invocations, 1, `${kind}: no resend`);
    const ev = await one("SELECT evidence FROM booking.reconciliation_cases WHERE intent_id = $1 AND kind = 'NOTIFICATION_OUTCOME_UNKNOWN'", [bk.id]);
    assert.deepEqual(Object.keys(ev.evidence).sort(), ["errorCode", "opType", "operationId"], "persisted diagnostics are codes / ids only");
  }
  // timeout: ONE bounded call, aborted at the fixed send timeout; the late accepted reply is in-memory only (no DB write)
  const bk = await confirmedBooking(); let sig = null;
  const snk = sink((n, ctx) => { sig = ctx.signal; return new Promise((res) => setTimeout(() => res({ accepted: true, providerMessageId: "mock-late" }), NOTIFICATION_LIMITS.sendTimeoutMs + 300)); });
  const t0 = performance.now();
  const r = await step(bk, snk);
  const el = performance.now() - t0;
  assert.deepEqual([r.outcome, r.code, r.sends], ["unknown", "SEND_TIMEOUT", 1]);
  assert.ok(el >= NOTIFICATION_LIMITS.sendTimeoutMs && el < NOTIFICATION_LIMITS.sendTimeoutMs + 5000, `bounded call (${Math.round(el)} ms)`);
  assert.equal(sig.aborted, true);
  const d = await digest(bk);
  assert.deepEqual({ ...(await r.late) }, { kind: "late_reply", classified: "accepted" });
  assert.equal(await digest(bk), d, "late reply: no DB mutation");
  assert.equal((await notifyOf(bk.id)).error_code, "SEND_TIMEOUT");
  assert.equal((await step(bk, snk)).outcome, "idle"); assert.equal(snk.invocations, 1);
});

test("outer DB faults: marker / observation / COMMIT errors propagate as the SAME object with no follow-up; settlement COMMIT loss (committed AND uncommitted); release failure after success", async () => {
  const boom = () => Object.assign(new Error("synthetic connection loss"), { code: "08006" });
  // marker read error
  { const bk = await confirmedBooking(); const snk = sink(); const e = boom();
    const p = wrapPool(db.app, { marker: () => { throw e; } });
    await assert.rejects(step(bk, snk, {}, p), (x) => x === e); assert.deepEqual(p.log, ["pool:marker"]);
    assert.equal((await notifyOf(bk.id)).state, "pending"); }
  // initial observation COMMIT loss → zero sends, no claim; the work lease is left to expire (no release after an outer failure)
  { const bk = await confirmedBooking(); const snk = sink(); const e = boom();
    const p = wrapPool(db.app, { COMMIT: async ({ exec, n }) => { if (n === 1) { await exec(); throw e; } return exec(); } });
    await assert.rejects(step(bk, snk, {}, p), (x) => x === e);
    assert.deepEqual(p.log.slice(-2), ["tx:ROLLBACK", "dispose"]);
    assert.equal(snk.invocations, 0); assert.equal(await renderOf(bk.op.id), undefined);
    assert.equal((await step(bk, snk, { workerId: "gnw-other" })).outcome, "idle", "the leased row is not taken by anyone until its work lease expires"); }
  // pre-send read error → same object, zero sends, row in_flight (maintenance later)
  { const bk = await releasedBooking(); const snk = sink(); const e = boom();
    const p = wrapPool(db.app, { guest_notification_presend: () => { throw e; } });
    await assert.rejects(step(bk, snk, {}, p), (x) => x === e);
    assert.deepEqual(p.log.slice(-2), ["tx:ROLLBACK", "dispose"]); assert.equal(snk.invocations, 0);
    assert.equal((await notifyOf(bk.id)).state, "in_flight");
    pending.push({ bk, snk, kind: "presend-read-error", sends: 0 }); }
  // pre-send COMMIT loss → zero sends
  { const bk = await cancelledBooking(); const snk = sink(); const e = boom();
    const p = wrapPool(db.app, { COMMIT: async ({ exec, n }) => { if (n === 2) { await exec(); throw e; } return exec(); } });
    await assert.rejects(step(bk, snk, {}, p), (x) => x === e);
    assert.equal(snk.invocations, 0); assert.equal((await notifyOf(bk.id)).state, "in_flight");
    pending.push({ bk, snk, kind: "presend-commit-loss", sends: 0 }); }
  // accepted reply, then the completion COMMIT acknowledgement is lost — COMMITTED outcome: durable success, nothing after, never resent
  { const bk = await confirmedBooking(); const snk = sink(); const e = boom();
    const p = wrapPool(db.app, { complete_guest_notification: async ({ exec }) => { await exec(); throw e; } });
    await assert.rejects(step(bk, snk, {}, p), (x) => x === e);
    assert.equal(p.log.at(-1), "pool:complete_guest_notification", "no query after the outer failure");
    assert.equal(snk.invocations, 1);
    const op = await notifyOf(bk.id); assert.deepEqual([op.state, op.result_ref], ["succeeded", "mock-gnw-1"]);
    assert.equal((await one("SELECT work_worker_id FROM booking.intent_work WHERE intent_id = $1", [bk.id])).work_worker_id, "gnw-1", "no release after an outer failure");
    for (let k = 0; k < 2; k++) assert.equal((await step(bk, snk, { workerId: `gnw-z${k}` })).outcome, "idle");
    assert.equal(snk.invocations, 1); }
  // — UNCOMMITTED outcome: in_flight persists; never resent; maintenance turns it unknown after the op lease (end of file)
  { const bk = await releasedBooking(); const snk = sink(); const e = boom();
    const p = wrapPool(db.app, { complete_guest_notification: () => { throw e; } });
    await assert.rejects(step(bk, snk, {}, p), (x) => x === e);
    assert.equal(p.log.at(-1), "pool:complete_guest_notification"); assert.equal(snk.invocations, 1);
    assert.equal((await notifyOf(bk.id)).state, "in_flight");
    assert.equal((await step(bk, snk)).outcome, "idle"); assert.equal(snk.invocations, 1);
    pending.push({ bk, snk, kind: "completion-uncommitted", sends: 1 }); }
  // release failure after an acknowledged success: the error propagates, the success stays durable (never reclassified)
  { const bk = await cancelledBooking(); const snk = sink(); const e = boom();
    const p = wrapPool(db.app, { release_notification_work: () => { throw e; } });
    await assert.rejects(step(bk, snk, {}, p), (x) => x === e);
    assert.equal(snk.invocations, 1); assert.equal((await notifyOf(bk.id)).state, "succeeded");
    assert.equal(await casesOf(bk.id), 0, "no unknown case for a durable success");
    assert.equal((await step(bk, snk, { workerId: "gnw-y" })).outcome, "idle"); assert.equal(snk.invocations, 1); }
  // crash before the claim (hook throws after the observation): no claim, no render; crash after the claim: in_flight, no send
  { const bk = await confirmedBooking(); const snk = sink(); const e = new Error("synthetic crash");
    await assert.rejects(step(bk, snk, { hooks: { afterInitialObservation: async () => { throw e; } } }), (x) => x === e);
    assert.equal((await notifyOf(bk.id)).state, "pending"); assert.equal(await renderOf(bk.op.id), undefined); assert.equal(snk.invocations, 0); }
  { const bk = await releasedBooking(); const snk = sink(); const e = new Error("synthetic crash");
    await assert.rejects(step(bk, snk, { hooks: { afterClaim: async () => { throw e; } } }), (x) => x === e);
    assert.equal((await notifyOf(bk.id)).state, "in_flight"); assert.equal(snk.invocations, 0);
    assert.equal((await step(bk, snk)).outcome, "idle");
    pending.push({ bk, snk, kind: "crash-after-claim", sends: 0 }); }
});

test("render failure on the real database → the authorized RENDER_FAILED latch; no claim; other rows still served", async () => {
  // a sender that is valid for the gate but a facts object the renderer refuses cannot be produced by accepted chains, so the render
  // failure is driven by the only renderer input the worker does not take from SQL: the recipient cross-check (snapshot hash vs row)
  const bk = await confirmedBooking(); const snk = sink();
  const p = wrapPool(db.app, { guest_notification_snapshot: async ({ exec }) => { const r = await exec(); r.rows[0].r.recipientHash = "0".repeat(64); return r; } });
  const r = await step(bk, snk, {}, p);
  assert.deepEqual([r.outcome, r.code, r.renderCode, r.sends], ["latched", "RENDER_FAILED", "RECIPIENT_INVALID", 0]);
  assert.ok(!p.log.includes("pool:claim_guest_notification"));
  assert.equal((await one("SELECT code FROM booking.notification_latches WHERE operation_id = $1", [bk.op.id])).code, "RENDER_FAILED");
  assert.equal(await klass(bk.op.id), "LATCHED");
  assert.equal((await step(bk, snk)).outcome, "idle"); assert.equal(snk.invocations, 0);
});

test("real op-lease expiry (one wait): crashed / lost rows become unknown by scoped maintenance inside a step; protected rows untouched; sends never increase", async () => {
  const claimedAt = await Promise.all(pending.map(async (x) => (await notifyOf(x.bk.id)).dispatched_at?.getTime() ?? 0));
  const leaseUntil = Math.max(...claimedAt) + 60 * SEC;
  await sleep(Math.max(0, leaseUntil + 1500 - Date.now()));
  for (const x of pending) {
    const before = x.snk.invocations;
    const r = await step(x.bk, x.snk, { workerId: "gnw-maint" });
    if (x.kind.startsWith("protected")) {
      assert.equal(await digest(x.bk), x.dp, `${x.kind}: zero writes by maintenance / steps`);
      assert.equal(r.outcome, "idle");
    } else {
      const op = await notifyOf(x.bk.id);
      assert.deepEqual([op.state, op.error_code], ["outcome_unknown", "LEASE_EXPIRED"], x.kind);
      assert.equal(await casesOf(x.bk.id), 1);
      assert.equal(r.outcome, "idle");
      assert.equal(x.snk.invocations, x.sends, `${x.kind}: actual invocations`);
    }
    assert.equal(x.snk.invocations, before, `${x.kind}: no resend`);
  }
  assert.equal(netAttempts, 0, "no network attempt in the whole suite");
});
