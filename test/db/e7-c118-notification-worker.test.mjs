// C118 / N1 F2 — migration 0027 (DRAFT, LOCAL ONLY) against the REAL accepted notification worker (gn-v2 + the Resend executor over a FAKE
// exchange). Disposable PostgreSQL only; synthetic `.invalid` guests; the "provider" is an in-memory fake exchange; nothing is delivered.
//   * the helper prelude below (lifecycle world / lanes / fake exchange) is copied test-locally, VERBATIM, from
//     test/db/e7-gn-v2-resend-integration.test.mjs lines 9–336 (itself copied from the accepted worker suites); only this header differs.
//   * the manual cancellation is recorded through the admin login exactly as an operator would (owner-attested evidence + the 0027 function).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import pg from "pg";
import { startMigratedDatabase, startPostgres } from "./harness.mjs";
import * as F from "./fixtures.mjs";
import { applyEvent, loadIntent, createIntentRecord, collectGuestDetails, beginPayStep, recordCheckoutSession } from "../../lib/booking-db/repo.js";
import { claimNextOperation, completeOperation, requestRead, recordProviderEvidence } from "../../lib/booking-db/operations.js";
import { runOrchestratorStep } from "../../lib/booking-db/reservation-worker.js";
import { runCaptureStep } from "../../lib/booking-db/capture-worker.js";
import { runRecordingStep } from "../../lib/booking-db/recording-worker.js";
import { runCleanupStep } from "../../lib/booking-db/compensation-worker.js";
import { runNotificationStep, NOTIFICATION_V2_OPTION_KEY, NOTIFICATION_PROVIDER_OPTION_KEY, V2_SNAPSHOT_FACT_KEYS } from "../../lib/booking-db/notification-worker.js";
import { createResendNotificationExecutor, RESEND_USER_AGENT } from "../../lib/notify/resend-notification-executor.js";
import { APPROVED_REAL_SENDER } from "../../lib/notify/sender-identity.js";
import { buildBookingConfirmationRequest, REQUEST_KEYS_V2 } from "../../lib/checkout/booking-confirmation-request.js";
import { contentHash as contentHashV1 } from "../../lib/checkout/guest-notification.js";
import { priceStay } from "../../lib/checkout/server-pricer.js";
import { readDirectPolicyFromEnv } from "../../lib/direct-policy.js";
import { todayInTimeZone } from "../../lib/public-api.js";
import { validateAdapterConfig } from "../../lib/hostaway-reservations.js";
import { migrateDown, migrateUp, migrationStatus, loadMigrations } from "../../db/lib/migrate.js";
import { intentStatus } from "../../lib/checkout/intent-api-core.js";

let netAttempts = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { netAttempts += 1; throw new Error("network refused (offline gn-v2 Resend integration suite)"); };
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
https.request = () => { netAttempts += 1; throw new Error("https.request refused (offline suite)"); };
https.Agent = class { constructor() { netAttempts += 1; throw new Error("https.Agent refused (offline suite)"); } };
syncBuiltinESMExports();

let db;
before(async () => { db = await startMigratedDatabase(); });
after(async () => { globalThis.fetch = realFetch; await db.close(); });

const TOP = loadMigrations().at(-1).version;
const range = (from, to) => (from <= to ? Array.from({ length: to - from + 1 }, (_, i) => from + i) : Array.from({ length: from - to + 1 }, (_, i) => from - i));

// ---------------------------------------------------------------------------------------------
// accepted-worker chain helpers: copied test-locally, verbatim, from test/db/e7-guest-notification-worker.test.mjs
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
async function authorizedBooking(w, { guestDomain = "mv-test.invalid", listingId: fixedListing = null, guestEmail = null } = {}) {
  laneN += 1;
  const listingId = fixedListing ?? 891000 + laneN;
  const stay = { from: addDays("2026-12-01", 3 * laneN), to: addDays("2026-12-01", 3 * laneN + 2), guests: 2 };
  const base = Date.now() - 20 * MIN;
  const priced = await priceStay({ request: { listingId, ...stay }, listingConfig: { currency: "USD" }, client: w.pricing, policy: POLICY,
    today: todayInTimeZone(undefined, new Date(base)), now: base });
  assert.ok(priced.ok, priced.error);
  const intent = await createIntentRecord(db.app, { ref: F.nextRef(), accessTokenHash: F.tokenHash(), environment: "test", now: base, listingId, ...stay });
  F.ok(await applyEvent(db.app, intent.id, { type: "PRICE_CONFIRMED", price: priced.price }, { now: base, actor: "guest" }));
  const guest = { firstName: "Synthia", lastName: "Fixture", email: guestEmail ?? `guest.n${laneN}@${guestDomain}` };   // SYNTHETIC (C116: or the exact sink); never logged
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
// notification step harness (sink / pool wrapper copied from the worker suite; the statement-kind regex also admits digits: `_v2`)

function sink(reply = (n) => ({ accepted: true, providerMessageId: `mock-gn2-${n}` })) {
  const s = { invocations: 0, requests: [], events: [] };
  s.sendMessage = (req, ctx) => { s.invocations += 1; s.requests.push(req); s.events.push(s.lastEvent?.()); return reply(s.invocations, ctx, req); };
  return s;
}
function wrapPool(base, fault = {}) {
  const log = [];
  const kindOf = (sql) => (/FROM booking\.instance/.test(sql) ? "marker" : /clock_timestamp\(\) AS t/.test(sql) ? "clock"
    : (/booking\.([a-z0-9_]+)\(/.exec(sql)?.[1] ?? sql.split(" ")[0]));
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
const gnOpts = (bk, snk, over = {}) => ({ env: ENV_N, workerId: "gn2-1", listingIds: [bk.listingId], intentId: bk.id, sender: { ...SENDER },
  executors: { sendMessage: snk.sendMessage, label: "mock-sink" }, clock: Date.now, ...over });
const step = (bk, snk, over = {}, pool = db.app) => runNotificationStep(pool, gnOpts(bk, snk, over));
const v2 = (locale) => ({ [NOTIFICATION_V2_OPTION_KEY]: locale });
const PII_FREE = (r) => { const j = JSON.stringify(r); assert.ok(!/@|Synthia|Hello|maraVilla booking|reservaci|Payment received|Pago recibido/.test(j), "result carries no contact / content"); return r; };
const renderOf = (opId) => one("SELECT * FROM booking.notification_renders WHERE operation_id = $1", [opId]);
const latchOf = (opId) => one("SELECT * FROM booking.notification_latches WHERE operation_id = $1", [opId]);
const casesOf = (intentId) => num("SELECT count(*) AS n FROM booking.reconciliation_cases WHERE intent_id = $1 AND kind = 'NOTIFICATION_OUTCOME_UNKNOWN'", [intentId]);
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");
/** the frozen gn-v2 request the bound DB rows must produce (independent of the worker: intent + guest rows → seven facts → accepted builder) */
async function expectedV2(bk, locale, sender = SENDER) {
  const i = await one("SELECT ref, from_date::text AS a, to_date::text AS b, (to_date - from_date) AS n, guests, final_total_minor AS t, currency FROM booking.intents WHERE id = $1", [bk.id]);
  const g = await one("SELECT email, first_name FROM booking.intent_guests WHERE intent_id = $1", [bk.id]);
  return buildBookingConfirmationRequest({ template: "booking_confirmed", locale, opId: bk.op.id, sender: { ...sender }, guest: { email: g.email, firstName: g.first_name },
    facts: { ref: i.ref, checkIn: i.a, checkOut: i.b, nights: Number(i.n), guests: i.guests, totalMinor: Number(i.t), currency: i.currency } });
}
/** observe the SQL pre-send exactly as the worker does (fresh connection, RR READ ONLY, one SELECT, COMMIT) */
async function presendRaw(opId, worker) {
  const c = await db.app.connect();
  try { await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); const r = (await c.query("SELECT booking.guest_notification_presend($1, $2) AS r", [opId, worker])).rows[0].r; await c.query("COMMIT"); return r; }
  finally { c.release(); }
}
const pgErr = async (fn) => { try { await fn(); } catch (e) { return e; } assert.fail("expected a database error"); };
const AUDIT16 = "operation_id, intent_id, template, template_version, intent_version, facts, facts_hash, recipient_hash, content_hash, message_ref, worker, claimed_at";
const PRESEND16_KEYS = ["code", "contentHash", "dbNow", "messageRef", "ok", "opLeaseUntil", "templateVersion", "workLeaseUntil"];


// ---------------------------------------------------------------------------------------------
// provider harness: a FAKE exchange (Resend-shaped replies) + the REAL executor; options without mock executors

const KEY = "re_SENTINELkey0123456789";
let uuidSeq = 0;
const nextUuid = () => { uuidSeq += 1; return `5f0c1a2b-3c4d-4e5f-8a6b-${String(uuidSeq).padStart(12, "0")}`; };
const H200 = (o = {}) => ({ contentType: "application/json", contentEncoding: null, idempotentReplayed: null, ...o });
function fakeExchange(reply = (id) => ({ status: 200, headers: H200(), body: Buffer.from(`{"id":"${id}"}`) })) {
  const s = { calls: 0, reqs: [], ids: [], events: [] };
  s.exchange = (req) => { s.calls += 1; s.reqs.push(req); s.events.push(s.lastEvent?.()); const id = nextUuid(); s.ids.push(id); return reply(id, s.calls, req); };
  return s;
}
const mkPE = (fx, sender = SENDER) => { const r = createResendNotificationExecutor({ exchange: fx.exchange, credential: () => KEY, sender: { ...sender } }); assert.equal(r.ok, true); return r.executor; };
const provOpts = (bk, pe, locale, over = {}) => ({ env: ENV_N, workerId: "gn2-1", listingIds: [bk.listingId], intentId: bk.id, sender: { ...SENDER }, clock: Date.now,
  [NOTIFICATION_V2_OPTION_KEY]: locale, [NOTIFICATION_PROVIDER_OPTION_KEY]: pe, ...over });
const pstep = (bk, fx, locale, over = {}, pool = db.app) => runNotificationStep(pool, provOpts(bk, mkPE(fx), locale, over));
const receiptOf = (opId) => one("SELECT * FROM booking.notification_provider_receipts WHERE operation_id = $1", [opId]);
const CLEAN = (r) => { const j = JSON.stringify(r); assert.ok(!j.includes(KEY) && !/@|Bearer|SENTINEL|Synthia|maraVilla booking|reservaci|Payment received|Pago recibido/.test(j), "result carries no key / contact / content"); return r; };
const expectedWire = (exp) => `{"from":"${SENDER.fromName} <${SENDER.fromAddress}>","to":[${JSON.stringify(exp.request.to)}],"subject":${JSON.stringify(exp.request.subject)},"text":${JSON.stringify(exp.request.text)}}`;

// =============================================================================================


// =============================================================================================
// C118 helpers
const RECORD = "booking.admin_record_external_cancellation($1,$2,$3::uuid[],$4,$5,$6,$7,$8,$9,$10,$11)";
let c118Key = 0;
const ridOf = async (bk) => (await one("SELECT hostaway_reservation_id AS r FROM booking.intents WHERE id = $1", [bk.id])).r;
const verOf = async (bk) => (await one("SELECT version AS v FROM booking.intents WHERE id = $1", [bk.id])).v;
/** the operator's manual-cancellation record: owner-attested Hostaway evidence (observed now) + the admin function, both through the admin login */
async function recordCancellation(bk, { client = db.reconciler, refundStatus = "pending", refundedMinor = null } = {}) {
  const ev = (await client.query("SELECT booking.admin_record_evidence($1, 'hostaway_reservation', $2, 'cancelled', '{}'::jsonb, $3, 'owner', 'gn-fixture-check') AS id",
    [bk.id, String(await ridOf(bk)), new Date()])).rows[0].id;     // same client: inside the caller's transaction when one is open
  const r = await client.query(`SELECT ${RECORD} AS r`, [bk.id, await verOf(bk), [ev], ev, refundStatus, refundedMinor, null, "owner", "hostaway-dashboard-check",
    "OWNER_CANCELLED_IN_HOSTAWAY", `c118-worker-key-${++c118Key}`]);
  return r.rows[0].r;
}
const activeClaims = (bk) => num("SELECT count(*) AS n FROM booking.inventory_claims WHERE intent_id = $1 AND released_at IS NULL", [bk.id]);
/** everything the record must leave byte-identical for a booking whose confirmation was ALREADY SENT */
const sentHistory = async (bk) => (await one(`SELECT md5(
     coalesce((SELECT string_agg(row_to_json(o)::text, '|' ORDER BY o.id) FROM booking.external_operations o WHERE o.intent_id = $1), '')
  || coalesce((SELECT string_agg(row_to_json(r)::text, '|' ORDER BY r.operation_id) FROM booking.notification_renders r WHERE r.intent_id = $1), '')
  || coalesce((SELECT string_agg(row_to_json(p)::text, '|' ORDER BY p.operation_id) FROM booking.notification_provider_receipts p WHERE p.intent_id = $1), '')
  || coalesce((SELECT string_agg(row_to_json(l)::text, '|' ORDER BY l.id) FROM booking.payment_ledger l WHERE l.intent_id = $1), '')
  || coalesce((SELECT string_agg(row_to_json(t)::text, '|' ORDER BY t.version_after) FROM booking.intent_transitions t WHERE t.intent_id = $1), '')
  || coalesce((SELECT row_to_json(i)::text FROM booking.intents i WHERE i.id = $1), '')) AS d`, [bk.id])).d;

const latchCount = (bk) => num("SELECT count(*) AS n FROM booking.notification_latches WHERE intent_id = $1", [bk.id]);
const workLease = async (bk) => (await one("SELECT work_worker_id AS w FROM booking.intent_work WHERE intent_id = $1", [bk.id]))?.w ?? null;
const guestView = async (bk) => (await intentStatus({ pool: db.app }, bk.id)).body;
const assertNoAdminData = (body) => assert.doesNotMatch(JSON.stringify(body),
  /owner|hostaway-dashboard|OWNER_CANCELLED|attest|evidence|reference|reservation|offline|pi_|resend|[0-9a-f]{8}-[0-9a-f]{4}-/i, "no admin / evidence / provider data in the guest reply");

test("F2-a: confirmation ALREADY SENT through the real gn-v2 worker + Resend executor (fake exchange) → manual cancellation: operation, render, typed receipt, ledger, transitions, intent and captured total byte-identical; guest status turns to cancelled", async () => {
  const bk = await confirmedBooking(); const fx = fakeExchange();
  const r = await pstep(bk, fx, "en");
  assert.deepEqual([r.outcome, r.sends, fx.calls], ["accepted", 1, 1]);
  const op = await notifyOf(bk.id);
  assert.deepEqual([op.state, op.attempts], ["succeeded", 1]);
  const rd = await renderOf(op.id); const rc = await receiptOf(op.id);
  assert.equal(rd.template_version, "gn-v2"); assert.equal(rc.provider, "resend"); assert.equal(rc.content_hash, rd.content_hash);
  const g0 = await guestView(bk);
  assert.deepEqual([g0.status, g0.bookingProgress.stage], ["confirmed", "complete"]);
  const before = await sentHistory(bk);
  const captured = (await one("SELECT captured_minor AS c FROM booking.intents WHERE id = $1", [bk.id])).c;
  const x = await recordCancellation(bk);
  assert.deepEqual(x.notify.map((n) => n.disposition), ["sent_preserved"]);
  assert.equal(await sentHistory(bk), before, "operation / render / receipt / ledger / transitions / intent unchanged");
  assert.equal((await one("SELECT captured_minor AS c FROM booking.intents WHERE id = $1", [bk.id])).c, captured);
  assert.equal(await latchCount(bk), 0, "a SENT confirmation is never latched or touched");
  assert.equal(await activeClaims(bk), 0, "claim released");
  const g1 = await guestView(bk);
  assert.deepEqual([g1.status, g1.bookingProgress.stage, g1.bookingProgress.refundStatus], ["booking_cancelled", "cancelled", "pending"]);
  assertNoAdminData(g1);
  for (let k = 0; k < 2; k++) { const fk = fakeExchange(); assert.equal((await pstep(bk, fk, "en", { workerId: `gn2-post${k}` })).outcome, "idle"); assert.equal(fk.calls, 0); }
  assert.equal(fx.calls, 1, "never a second send"); assert.equal(netAttempts, 0);
});

test("F2-b: QUEUED confirmation (pristine) → manual cancellation latches it EXTERNALLY_CANCELLED → the real worker: zero sends, no claim attempt, no lease / render / case, no retry loop — also after a later contradicting observation", async () => {
  const bk = await confirmedBooking(); const fx = fakeExchange();
  assert.deepEqual([bk.op.state, bk.op.attempts], ["pending", 0]);
  const x = await recordCancellation(bk);
  assert.deepEqual(x.notify.map((n) => n.disposition), ["latched_unsent"]);
  const l = await latchOf(bk.op.id);
  assert.deepEqual([l.code, l.worker], ["EXTERNALLY_CANCELLED", "admin-external-cancellation"]);
  const d0 = await digest(bk);
  for (let k = 0; k < 3; k++) {
    const r = await pstep(bk, fx, "en", { workerId: `gn2-q${k}` });
    assert.deepEqual([r.ok, r.outcome, r.sends], [true, "idle", 0], `step ${k}`);
    assert.equal((await step(bk, sink(), { workerId: `gn2-v1q${k}` })).outcome, "idle", "the default (gn-v1) path does not take it either");
  }
  const i = await one("SELECT listing_id, from_date::text f, to_date::text t, final_total_minor m FROM booking.intents WHERE id = $1", [bk.id]);
  await dashboard(bk.id, "hostaway_reservation", await ridOf(bk), "found_active", { listingId: i.listing_id, from: i.f, to: i.t, totalMinor: Number(i.m) }, Date.now() + 1000);
  for (let k = 0; k < 2; k++) assert.equal((await pstep(bk, fx, "en", { workerId: `gn2-c${k}` })).outcome, "idle", "a later contradicting observation does not revive the send");
  const op = await notifyOf(bk.id);
  assert.deepEqual([op.state, op.attempts, op.lease_worker_id, op.dispatched_at], ["pending", 0, null, null]);
  assert.equal(await renderOf(bk.op.id), undefined); assert.equal(await casesOf(bk.id), 0); assert.equal(await latchCount(bk), 1);
  assert.equal(await workLease(bk), null, "no stranded work lease");
  assert.deepEqual(await recover([bk.listingId], null, 10), { processed: 0, skippedLocked: 0, skippedProtected: 0 });
  assert.equal(await digest(bk), d0, "repeated steps write nothing");
  assert.equal(fx.calls, 0); assert.equal(netAttempts, 0);
  const g = await guestView(bk); assert.equal(g.status, "booking_cancelled"); assertNoAdminData(g);
});

test("F2-c race: the worker holds the send in flight when the operator records → refused (nothing written); the send completes once; the record afterwards preserves it", async () => {
  const bk = await confirmedBooking(); const fx = fakeExchange();
  let during = null;
  const pool = wrapPool(db.app, { complete_guest_notification_resend: async ({ exec }) => {
    during = await recordCancellation(bk).then(() => "RECORDED", (e) => e.message);
    return exec(); } });
  const r = await pstep(bk, fx, "en", {}, pool);
  assert.match(during, /WORK_LEASE_PRESENT|OPERATION_LEASED|OPERATION_UNSETTLED/);
  assert.deepEqual([r.outcome, fx.calls], ["accepted", 1]);
  assert.equal(await num("SELECT count(*) AS n FROM booking.external_cancellations WHERE intent_id = $1", [bk.id]), 0, "the refused record wrote nothing");
  assert.equal(await activeClaims(bk), 1);
  assert.equal(await workLease(bk), null, "the worker released its lease");
  const x = await recordCancellation(bk);
  assert.deepEqual(x.notify.map((n) => n.disposition), ["sent_preserved"]);
  assert.equal(fx.calls, 1);
});

test("F2-d race: the operator's record transaction is open (rows locked) while the worker runs → the worker skips without sending; after COMMIT every step is idle; zero sends, no lease", async () => {
  const bk = await confirmedBooking(); const fx = fakeExchange();
  const c = await db.reconciler.connect();
  try {
    await c.query("BEGIN");
    const x = await recordCancellation(bk, { client: c });
    assert.deepEqual(x.notify.map((n) => n.disposition), ["latched_unsent"]);
    const r = await pstep(bk, fx, "en", { workerId: "gn2-race" });
    assert.deepEqual([r.outcome, r.sends], ["idle", 0], "locked rows are skipped, never waited on into a send");
    await c.query("COMMIT");
  } finally { c.release(); }
  for (let k = 0; k < 3; k++) assert.equal((await pstep(bk, fx, "en", { workerId: `gn2-after${k}` })).outcome, "idle");
  const op = await notifyOf(bk.id);
  assert.deepEqual([op.state, op.attempts, op.lease_worker_id], ["pending", 0, null]);
  assert.equal(await workLease(bk), null); assert.equal(await renderOf(bk.op.id), undefined); assert.equal(fx.calls, 0);
  // ROLLBACK variant: nothing recorded, the confirmation is still sendable exactly once
  const b2 = await confirmedBooking(); const fx2 = fakeExchange();
  const c2 = await db.reconciler.connect();
  try { await c2.query("BEGIN"); await recordCancellation(b2, { client: c2 }); await c2.query("ROLLBACK"); } finally { c2.release(); }
  assert.equal(await latchCount(b2), 0);
  assert.equal((await pstep(b2, fx2, "en")).outcome, "accepted"); assert.equal(fx2.calls, 1);
});
