// C118 — the ONE C116 external-cancellation reconciliation template (claude/e7-c118-c116-record-v1.sql + readback) on DISPOSABLE PostgreSQL ONLY.
// A REALISTIC sent-confirmation fixture: the accepted lifecycle (R → C → W) to a confirmed USD booking, then the REAL gn-v2 worker + Resend executor over
// a FAKE exchange (ONE synthetic send, typed receipt). The template's <<TOKENS>> are bound here to that synthetic booking exactly as ROOT will bind the
// private C116 values; nothing here touches a shared database, a provider or the network.
//   * the helper prelude below (lifecycle world / lanes / fake exchange) is copied test-locally, VERBATIM, from test/db/e7-c118-notification-worker.test.mjs
//     lines 6–332 (itself a verbatim copy of the accepted gn-v2 Resend integration prelude); only this header differs.
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
// C118 C116-record template harness
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const ROOTDIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const rdf = (p) => readFileSync(join(ROOTDIR, p), "utf8");
const shaf = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const TEMPLATE = rdf("claude/e7-c118-c116-record-v1.sql"); const RB = rdf("claude/e7-c118-c116-record-readback-v1.sql");
const TOKENS = ["C116_INTENT_ID", "EXPECTED_VERSION", "C116_RESERVATION_ID", "EXPECTED_LISTING_ID", "EXPECTED_CAPTURED_MINOR", "HOSTAWAY_CANCELLED_AT", "OBSERVED_AT", "REQUEST_KEY", "SHORT_REF"];
const bindText = (text, b) => { let t = text; for (const k of TOKENS) if (k in b) t = t.split(`<<${k}>>`).join(String(b[k])); return t; };
/** the bindings for a synthetic booking, as ROOT will bind the private C116 values (fresh read-only facts) */
async function bindingsFor(bk, over = {}) {
  await sleep(20);                                     // the fresh observation is strictly later than any evidence the fixture just wrote
  const i = await one("SELECT version, hostaway_reservation_id AS r, listing_id AS l, captured_minor AS c FROM booking.intents WHERE id = $1", [bk.id]);
  return { C116_INTENT_ID: bk.id, EXPECTED_VERSION: i.version, C116_RESERVATION_ID: i.r, EXPECTED_LISTING_ID: i.l, EXPECTED_CAPTURED_MINOR: Number(i.c),
    HOSTAWAY_CANCELLED_AT: new Date(Date.now() - 5 * MIN).toISOString(), OBSERVED_AT: new Date().toISOString(),
    REQUEST_KEY: `c116-record-${bk.id.slice(0, 8)}`, SHORT_REF: "hostaway-dash-recheck", ...over };
}
async function issue(b, text = TEMPLATE, conn = db.adminUrl) {
  const c = new pg.Client({ connectionString: conn }); await c.connect();
  const notices = []; c.on("notice", (n) => notices.push(n.message));
  try { const res = await c.query(bindText(text, b)); return { notices, status: res[res.length - 1].rows[0].e7_c116_status }; } finally { await c.end(); }
}
const refuse = async (b, re, text, conn) => { let msg = null; try { await issue(b, text, conn); } catch (e) { msg = e.message; } assert.ok(msg && re.test(msg), `expected ${re}, got ${msg}`); };
const rb = async (b) => (await db.owner.query(bindText(RB, b))).rows[0].e7_c116_readback;
const evidenceCount = () => num("SELECT count(*) AS n FROM booking.provider_evidence");
async function zeroMutation(b, before, evBefore) {
  assert.deepEqual(await rb(b), before, "readback identical: nothing written");
  assert.equal(await evidenceCount(), evBefore, "no evidence row written");
  assert.equal(await num("SELECT count(*) AS n FROM booking.external_cancellations"), 0);
}
/** a confirmed booking whose confirmation was SENT through the real worker (fake exchange) */
async function sentBooking() {
  const bk = await confirmedBooking(); const fx = fakeExchange();
  const r = await pstep(bk, fx, "en"); assert.deepEqual([r.outcome, fx.calls], ["accepted", 1]);
  return { ...bk, fx };
}

let SENT, OTHER_QUEUED, OTHER_SENT;
test("setup: realistic schema-27 data — the target with a SENT confirmation, another SENT booking and a QUEUED booking (accepted workers, fake exchange)", async () => {
  assert.equal((await one("SELECT max(version) AS m FROM booking_migrations.applied")).m, 27);
  SENT = await sentBooking(); OTHER_SENT = await sentBooking(); OTHER_QUEUED = await confirmedBooking();
  assert.equal((await notifyOf(OTHER_QUEUED.id)).state, "pending");
});

test("P0 template: every token bound exactly once; regeneration byte-identical; no concrete identifier committed; operator manifest exact", async () => {
  for (const k of TOKENS) assert.equal(TEMPLATE.split(`<<${k}>>`).length, 3, k);
  const out = execFileSync("python3", [join(ROOTDIR, "claude/gen-c118-c116-record.py"), ROOTDIR], { encoding: "utf8" });
  assert.ok(out.includes(`record-v1.sql sha256: ${shaf(TEMPLATE)}`) && out.includes(`record-readback-v1.sql sha256: ${shaf(RB)}`), out);
  assert.doesNotMatch(TEMPLATE.split("00000000-0000-0000-0000-000000000000").join(""), /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\bcs_test_|\bpi_[A-Za-z0-9]{6}/);
  const calls = [...TEMPLATE.matchAll(/(?::=|PERFORM)\s*booking\.([a-z_]+)\(/g)].map((m) => m[1]);
  assert.deepEqual(calls, ["admin_record_evidence", "admin_record_external_cancellation"], "exactly two calls, both reviewed admin functions");
  assert.ok(!/(refund_payment_intent|DELETE FROM|TRUNCATE|UPDATE booking\.|INSERT INTO booking\.)/.test(TEMPLATE),
    "the template writes only through the two reviewed admin functions");
  const doc = rdf("claude/e7-c118-c116-record-operator-sequence.md");
  const manifest = [...doc.matchAll(/^\| `([^`]+)` \| `([0-9a-f]{64})` \|$/gm)].map((x) => [x[1], x[2]]);
  assert.equal(manifest.length, 6);
  for (const [p, h] of manifest) if (p !== "test/db/e7-c118-c116-record.test.mjs") assert.equal(shaf(rdf(p)), h, p);
  assert.doesNotMatch(doc, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\b7\d{7}\b|cs_test_|pi_[A-Za-z0-9]/, "no private identifier in the operator document");
});

test("P1 refusals write NOTHING (readback identical, no evidence row, no record): unbound / malformed tokens; wrong role (admin, app); not TEST; schema drift; run lock; work / operation leases; wrong intent / version / reservation / listing / amount; QUEUED (not sent) confirmation; stale / future / pre-cancellation observation", async () => {
  const b = await bindingsFor(SENT); const before = await rb(b); const ev0 = await evidenceCount();
  assert.deepEqual([before.target.state, before.target.own_claim_held, before.records_total, before.target.projection], ["confirmed", 1, 0, null]);
  assert.deepEqual(before.target.notify.map((n) => [n.state, n.attempts, n.renders, n.receipts, n.latches]), [["succeeded", 1, 1, 1, 0]]);
  await refuse({}, /E7_C116_PLACEHOLDER_NOT_BOUND/); await zeroMutation(b, before, ev0);
  const { OBSERVED_AT, ...partial } = b; await refuse(partial, /E7_C116_PLACEHOLDER_NOT_BOUND/); await zeroMutation(b, before, ev0);
  for (const o of [{ C116_INTENT_ID: "not-a-uuid" }, { EXPECTED_VERSION: "0" }, { REQUEST_KEY: "k".repeat(117) }, { OBSERVED_AT: "2026-11-17 23:00:00" }, { SHORT_REF: "has space" },
    { C116_RESERVATION_ID: "12ab" }, { EXPECTED_CAPTURED_MINOR: "-1" }]) {
    await refuse({ ...b, ...o }, /E7_C116_BINDING_MALFORMED/); await zeroMutation(b, before, ev0);
  }
  await refuse(b, /E7_C116_NOT_SCHEMA_OWNER|permission denied/, TEMPLATE, db.adminUrl2()); await zeroMutation(b, before, ev0);
  await refuse(b, /E7_C116_NOT_SCHEMA_OWNER|permission denied/, TEMPLATE, db.appUrl()); await zeroMutation(b, before, ev0);
  await db.owner.query("UPDATE booking.instance SET environment = 'live'"); await refuse(b, /E7_C116_NOT_TEST/); await db.owner.query("UPDATE booking.instance SET environment = 'test'"); await zeroMutation(b, before, ev0);
  await db.owner.query("CREATE FUNCTION booking._e7_extra() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$"); await refuse(b, /E7_C116_SCHEMA_IDENTITY_DRIFT:.*functions/);
  await db.owner.query("DROP FUNCTION booking._e7_extra()"); await zeroMutation(b, before, ev0);
  const holder = new pg.Client({ connectionString: db.adminUrl }); await holder.connect();
  try {
    await holder.query("SELECT pg_advisory_lock(pg_catalog.hashtext('e7-connected-runner'), 0)"); await refuse(b, /E7_C116_ACTIVE_RUN_LOCK_HELD/);
    await holder.query("SELECT pg_advisory_unlock(pg_catalog.hashtext('e7-connected-runner'), 0)");
  } finally { await holder.end(); }
  await zeroMutation(b, before, ev0);
  await F.ownerManagedHistory(db.owner, "UPDATE booking.intent_work SET work_worker_id = 'w-x', work_lease_until = now() + interval '1 minute' WHERE intent_id = $1", [OTHER_QUEUED.id]);
  await refuse(b, /E7_C116_ACTIVE_WORK_LEASE/);
  await F.ownerManagedHistory(db.owner, "UPDATE booking.intent_work SET work_worker_id = NULL, work_lease_until = NULL WHERE intent_id = $1", [OTHER_QUEUED.id]); await zeroMutation(b, before, ev0);
  await F.ownerManagedHistory(db.owner, "UPDATE booking.external_operations SET lease_worker_id = 'w-x', lease_until = now() + interval '1 minute' WHERE id = $1", [OTHER_QUEUED.op.id]);
  await refuse(b, /E7_C116_OPERATION_LEASED_OR_IN_FLIGHT/);
  await F.ownerManagedHistory(db.owner, "UPDATE booking.external_operations SET lease_worker_id = NULL, lease_until = NULL WHERE id = $1", [OTHER_QUEUED.op.id]); await zeroMutation(b, before, ev0);
  for (const [o, re] of [[{ C116_INTENT_ID: "00000000-0000-4000-8000-000000000001" }, /E7_C116_INTENT_NOT_FOUND/], [{ EXPECTED_VERSION: b.EXPECTED_VERSION - 1 }, /E7_C116_STALE_VERSION/],
    [{ EXPECTED_VERSION: b.EXPECTED_VERSION + 1 }, /E7_C116_STALE_VERSION/], [{ C116_RESERVATION_ID: Number(b.C116_RESERVATION_ID) + 1 }, /E7_C116_RESERVATION_BINDING_MISMATCH/],
    [{ EXPECTED_LISTING_ID: b.EXPECTED_LISTING_ID + 1 }, /E7_C116_RESERVATION_BINDING_MISMATCH/], [{ EXPECTED_CAPTURED_MINOR: b.EXPECTED_CAPTURED_MINOR + 1 }, /E7_C116_AMOUNT_BINDING_MISMATCH/],
    [{ OBSERVED_AT: new Date(Date.now() + 10 * MIN).toISOString() }, /E7_C116_OBSERVATION_NOT_FRESH_LATEST/],
    [{ OBSERVED_AT: new Date(Date.now() - 2 * DAY).toISOString(), HOSTAWAY_CANCELLED_AT: new Date(Date.now() - 3 * DAY).toISOString() }, /E7_C116_OBSERVATION_NOT_FRESH_LATEST/],
    [{ OBSERVED_AT: new Date(Date.now() - 10 * MIN).toISOString() }, /E7_C116_OBSERVATION_NOT_FRESH_LATEST/],          // before the cancellation time
    [{ OBSERVED_AT: new Date(SENT.base).toISOString(), HOSTAWAY_CANCELLED_AT: new Date(SENT.base - MIN).toISOString() }, /E7_C116_OBSERVATION_NOT_FRESH_LATEST/]]) {   // older than existing evidence
    await refuse({ ...b, ...o }, re); await zeroMutation(b, before, ev0);
  }
  const q = await bindingsFor(OTHER_QUEUED); const qBefore = await rb(q);
  await refuse(q, /E7_C116_NOTIFY_NOT_SENT/); assert.deepEqual(await rb(q), qBefore); await zeroMutation(b, before, ev0);
});

test("P2 atomic rollback: a refusal raised by the reviewed function itself (open case on the bound booking) and an injected failure AFTER the record both leave NO evidence row, NO record and the claim held", async () => {
  // a separate sent booking with an owner-opened case (TEST SETUP ONLY): the wrapper's own checks pass, admin_record_external_cancellation refuses OPEN_CASE
  const x = await sentBooking();
  await db.owner.query("INSERT INTO booking.reconciliation_cases (id, intent_id, kind, status, opened_at, opened_by) VALUES (gen_random_uuid(), $1, 'MANUAL_REVIEW', 'open', now(), 'test-setup')", [x.id]);
  const bx = await bindingsFor(x); const bBefore = await rb(await bindingsFor(SENT)); const ev0 = await evidenceCount();
  const xBefore = await rb(bx);
  await refuse(bx, /OPEN_CASE/); assert.deepEqual(await rb(bx), xBefore); assert.equal(await evidenceCount(), ev0, "the evidence written before the refusal rolled back too");
  const b = await bindingsFor(SENT);
  const inject = TEMPLATE.replace("RAISE NOTICE 'E7_C116_RECORDED';", "RAISE EXCEPTION 'E7_C116_INJECTED_AFTER_RECORD';"); assert.notEqual(inject, TEMPLATE);
  await refuse(b, /E7_C116_INJECTED_AFTER_RECORD/, inject); await zeroMutation(b, bBefore, ev0);
  assert.equal((await rb(b)).target.own_claim_held, 1);
});

test("P3 the ONE record on the realistic SENT booking: E7_C116_RECORDED; result sent_preserved; only its OWN claim released; payment / render / receipt / ledger / transitions / intent row and every other booking unchanged; one pending refund; no latch; projection; no new send", async () => {
  const b = await bindingsFor(SENT); const before = await rb(b); const ev0 = await evidenceCount();
  const r = await issue(b);
  assert.deepEqual(r.notices, ["E7_C116_RECORDED"]);
  assert.deepEqual(r.status, { external_cancellations: 1, external_refund_attestations: 1, refund_statuses: ["pending"], externally_cancelled_latches: 0 });
  const after = await rb(b);
  assert.deepEqual([after.target.intent_row_md5, after.target.version, after.target.state], [before.target.intent_row_md5, before.target.version, "confirmed"]);
  assert.deepEqual(after.target.history_md5, before.target.history_md5, "operations / renders / receipts / ledger / transitions identical");
  assert.deepEqual(after.target.notify, before.target.notify, "the SENT confirmation is untouched");
  assert.deepEqual([after.target.own_claim_held, after.target.own_claim_release_reasons], [0, ["EXTERNAL_CANCELLATION_ATTESTED"]]);
  assert.deepEqual(after.target.record, { key_matches: true, notify_dispositions: ["sent_preserved"], released_claim_present: true });
  assert.deepEqual(after.target.refund_statuses, ["pending"]);
  assert.deepEqual([after.target.latest_reservation_evidence.status, after.target.latest_reservation_evidence.source], ["cancelled", "hostaway_dashboard"]);
  assert.deepEqual(after.target.projection, { cancelled: true, refundStatus: "pending" });
  assert.deepEqual([after.records_total, after.externally_cancelled_latches], [1, 0]);
  assert.deepEqual(after.others_fingerprint, before.others_fingerprint, "every other claim, every other intent and every other booking table identical");
  assert.equal(await evidenceCount(), ev0 + 1, "exactly one new evidence row");
  assert.equal(SENT.fx.calls, 1, "no further send");
  for (let k = 0; k < 2; k++) { const fk = fakeExchange(); assert.equal((await pstep(SENT, fk, "en", { workerId: `gn2-after${k}` })).outcome, "idle"); assert.equal(fk.calls, 0); }
  assert.equal(netAttempts, 0);
});

test("P4 replay and conflict: the same bound text is a provable NO-OP; a different key / observation / any other booking → EXISTING_RECORD_STOP; nothing written", async () => {
  const b = await bindingsFor(SENT, { EXPECTED_VERSION: (await one("SELECT version FROM booking.intents WHERE id = $1", [SENT.id])).version });
  // the replay must use the ISSUED observation time and key: read them back from the record
  const x = await one(`SELECT x.request_key AS k, e.observed_at AS o FROM booking.external_cancellations x JOIN booking.provider_evidence e ON e.id = x.cancellation_evidence_id WHERE x.intent_id = $1`, [SENT.id]);
  const issued = { ...b, REQUEST_KEY: x.k, OBSERVED_AT: new Date(x.o).toISOString() };
  const before = await rb(issued); const ev0 = await evidenceCount();
  const r = await issue(issued); assert.deepEqual(r.notices, ["E7_C116_ALREADY_RECORDED_NOOP"]);
  assert.deepEqual(await rb(issued), before); assert.equal(await evidenceCount(), ev0);
  await refuse({ ...issued, REQUEST_KEY: `${x.k}-other` }, /E7_C116_EXISTING_RECORD_STOP/);
  await refuse({ ...issued, OBSERVED_AT: new Date().toISOString() }, /E7_C116_EXISTING_RECORD_STOP/);
  await refuse(await bindingsFor(OTHER_SENT), /E7_C116_EXISTING_RECORD_STOP/);
  assert.deepEqual(await rb(issued), before); assert.equal(await evidenceCount(), ev0);
});
